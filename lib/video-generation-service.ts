import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import {
    combineReferenceImagesForEdit,
    normalizeReferenceImageForEdit,
    resolveGenerationUserIdentityId,
} from "./image-generation-service";
import { kvGet, kvSet } from "./kv-db";
import { loadMediaBlob, storeMediaBlob } from "./media-cache-storage";
import {
    loadImageGenerationSettings,
    loadVideoGenerationSettings,
    resolveActiveVideoPreset,
} from "./settings-storage";
import type { VideoGenerationSettings, VideoPreset } from "./settings-types";

const DAILY_COUNTER_KEY = "ai_phone_video_generation_daily_v1";
const MAX_MOTION_REFERENCE_BYTES = 8 * 1024 * 1024;
const POLL_INTERVAL_MS = 3000;

export type VideoGenerationFailureCode =
    | "DISABLED"
    | "INCOMPLETE"
    | "NO_CHARACTER_REFERENCE"
    | "NO_USER_REFERENCE"
    | "MOTION_UNSUPPORTED"
    | "MOTION_TOO_LARGE"
    | "DAILY_LIMIT"
    | "TIMEOUT"
    | "FAILED";

export class VideoGenerationFailure extends Error {
    code: VideoGenerationFailureCode;
    constructor(code: VideoGenerationFailureCode, message: string) {
        super(message);
        this.name = "VideoGenerationFailure";
        this.code = code;
    }
}

export type VideoGenerationResult = {
    mediaRef: string;
    mimeType: string;
    prompt: string;
    durationSeconds: number;
    usedCharacterReference: boolean;
    usedUserReference: boolean;
    usedMotionReference: boolean;
};

type VideoApiState =
    | { status: "succeeded"; videoUrl: string }
    | { status: "pending"; taskId?: string }
    | { status: "failed"; error?: string };

type PreparedRequest = {
    settings: VideoGenerationSettings;
    preset: VideoPreset;
    prompt: string;
    characterReferenceDataUrl: string;
    userReferenceDataUrl: string;
    motionReference: string;
    usedUserReference: boolean;
    usedMotionReference: boolean;
};

function todayKey(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function readDailyCount(): number {
    try {
        const raw = kvGet(DAILY_COUNTER_KEY);
        if (!raw) return 0;
        const parsed = JSON.parse(raw) as { date?: string; count?: number };
        return parsed.date === todayKey() && Number.isFinite(parsed.count) ? Number(parsed.count) : 0;
    } catch {
        return 0;
    }
}

function bumpDailyCount(): void {
    try {
        kvSet(DAILY_COUNTER_KEY, JSON.stringify({ date: todayKey(), count: readDailyCount() + 1 }));
    } catch {
        /* ignore quota bookkeeping failure */
    }
}

export function getVideoGenerationDailyUsage(): { used: number; limit: number } {
    const settings = loadVideoGenerationSettings();
    return { used: readDailyCount(), limit: settings.maxDailyGenerations };
}

export function hasVideoGenerationConfigured(): boolean {
    const settings = loadVideoGenerationSettings();
    if (!settings.enabled) return false;
    const preset = resolveActiveVideoPreset(settings);
    return Boolean(preset?.baseUrl.trim() && preset.apiKey.trim() && preset.model.trim());
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取参考视频失败"));
        reader.readAsDataURL(blob);
    });
}

async function resolveMotionReference(settings: VideoGenerationSettings, preset: VideoPreset): Promise<string> {
    if (!preset.supportsMotionReference) {
        if (settings.motionReferenceRef || settings.motionReferenceUrl) {
            throw new VideoGenerationFailure("MOTION_UNSUPPORTED", "当前视频方案未开启「参考视频」，已阻止发起请求");
        }
        return "";
    }
    if (settings.motionReferenceUrl?.trim()) return settings.motionReferenceUrl.trim();
    const ref = settings.motionReferenceRef?.trim();
    if (!ref) return "";
    const loaded = await loadMediaBlob(ref);
    if (!loaded) throw new VideoGenerationFailure("FAILED", "参考视频已失效，请重新上传");
    if (loaded.blob.size > MAX_MOTION_REFERENCE_BYTES) {
        throw new VideoGenerationFailure("MOTION_TOO_LARGE", "参考视频超过 8MB，请压缩后再上传，或改用视频链接");
    }
    return blobToDataUrl(loaded.blob);
}

async function prepareRequest(
    description: string,
    characterId: string | undefined,
    appId: string,
): Promise<PreparedRequest> {
    const settings = loadVideoGenerationSettings();
    if (!settings.enabled) throw new VideoGenerationFailure("DISABLED", "视频生成未启用");
    const preset = resolveActiveVideoPreset(settings);
    if (!preset || !preset.baseUrl.trim() || !preset.apiKey.trim() || !preset.model.trim()) {
        throw new VideoGenerationFailure("INCOMPLETE", "视频生成 API 配置不完整（地址/Key/模型）");
    }
    if (settings.maxDailyGenerations > 0 && readDailyCount() >= settings.maxDailyGenerations) {
        throw new VideoGenerationFailure("DAILY_LIMIT", `今天已生成 ${readDailyCount()} 条视频，达到每日上限`);
    }

    const imageSettings = loadImageGenerationSettings();
    const characterRef = characterId ? imageSettings.characterReferences?.[characterId] : undefined;
    if (settings.faceLockRequired) {
        if (!characterRef?.assetId || characterRef.enabled === false) {
            throw new VideoGenerationFailure(
                "NO_CHARACTER_REFERENCE",
                "该角色还没有角色参考图，无法锁脸。请先到「图像生成 API → 角色参考图」上传",
            );
        }
    }
    const characterRaw = characterRef?.assetId ? await getChatImageFromIndexedDB(characterRef.assetId) : null;
    if (settings.faceLockRequired && !characterRaw) {
        throw new VideoGenerationFailure("NO_CHARACTER_REFERENCE", "角色参考图读取失败，请重新上传后再试");
    }

    const identityId = resolveGenerationUserIdentityId(characterId, appId);
    const userRef = identityId ? imageSettings.userReferences?.[identityId] : undefined;
    let userReferenceDataUrl = "";
    let usedUserReference = false;
    if (settings.includeUserReference) {
        if (!userRef?.assetId || userRef.enabled === false) {
            throw new VideoGenerationFailure(
                "NO_USER_REFERENCE",
                "当前用户身份还没有参考图，无法同时锁用户的脸。请到「图像生成 API → 用户参考图」上传，或在视频生成设置里关闭「同时使用用户参考图」",
            );
        }
        const userRaw = await getChatImageFromIndexedDB(userRef.assetId);
        if (!userRaw) {
            throw new VideoGenerationFailure("NO_USER_REFERENCE", "用户参考图读取失败，请重新上传后再试");
        }
        userReferenceDataUrl = await normalizeReferenceImageForEdit(userRaw, userRef.faceCrop);
        usedUserReference = true;
    }

    const characterReferenceDataUrl = characterRaw
        ? await normalizeReferenceImageForEdit(characterRaw, characterRef?.faceCrop)
        : "";
    const motionReference = await resolveMotionReference(settings, preset);

    const attachUserToFrame = usedUserReference && /合照|同框|一起|两人|我们|咱们/.test(description);
    const firstFrame = attachUserToFrame
        ? await combineReferenceImagesForEdit([
            { dataUrl: characterReferenceDataUrl, label: "角色参考（左）" },
            { dataUrl: userReferenceDataUrl, label: "用户参考（右）" },
        ]) || characterReferenceDataUrl
        : characterReferenceDataUrl;

    const appearance = characterRef?.featurePrompt?.trim() || "";
    const anchors = (characterRef?.anchors || [])
        .filter(anchor => anchor.enabled !== false && anchor.description.trim())
        .map(anchor => `${anchor.name || "特征"}：${anchor.description.trim()}`)
        .join("；");
    const prompt = [
        description,
        appearance ? `【角色固定外观】${appearance}` : "",
        anchors ? `【角色特定锚点】${anchors}` : "",
        "【锁脸要求】画面中角色的脸必须与参考图保持同一个人，五官、脸型、发型、肤色一致，禁止换脸或美颜成另一个人。",
        attachUserToFrame ? "【双人参考】参考图里是分格参考板：左格是角色，右格是用户；两人必须保持各自的脸，不得混脸。" : "",
        settings.motionReferenceRef || settings.motionReferenceUrl
            ? "【动作参考】动作节奏与手势参考提供的视频，但人物长相必须以参考图为准。"
            : "",
        `【画面要求】单镜头、固定机位、人物半身或全身入镜、手部动作清晰，时长约 ${preset.duration} 秒，不要字幕、不要水印、不要多镜头切换。`,
    ].filter(Boolean).join("\n\n");

    return {
        settings,
        preset,
        prompt: preset.extraPrompt.trim() ? `${prompt}\n\n${preset.extraPrompt.trim()}` : prompt,
        characterReferenceDataUrl: firstFrame,
        userReferenceDataUrl: usedUserReference && !attachUserToFrame ? userReferenceDataUrl : "",
        motionReference,
        usedUserReference,
        usedMotionReference: Boolean(motionReference),
    };
}

function videoApiRequestBody(prepared: PreparedRequest) {
    const { preset } = prepared;
    return {
        baseUrl: preset.baseUrl,
        apiKey: preset.apiKey,
        model: preset.model,
        prompt: prepared.prompt,
        image: prepared.characterReferenceDataUrl,
        extraReferenceImage: prepared.userReferenceDataUrl || undefined,
        extraReferenceField: prepared.userReferenceDataUrl
            ? (preset.userReferenceField || "reference_image")
            : undefined,
        motionReference: prepared.motionReference || undefined,
        motionReferenceField: preset.motionReferenceField || "video_url",
        duration: preset.duration,
        ratio: preset.ratio,
        endpointMode: preset.endpointMode,
    };
}

async function requestServer(payload: Record<string, unknown>, signal?: AbortSignal): Promise<VideoApiState> {
    const response = await fetch("/api/video-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
        throw new VideoGenerationFailure("FAILED", typeof data.error === "string" ? data.error : `视频接口 HTTP ${response.status}`);
    }
    const status = data.status === "succeeded" ? "succeeded" : data.status === "failed" ? "failed" : "pending";
    return {
        status,
        ...(typeof data.videoUrl === "string" ? { videoUrl: data.videoUrl } : {}),
        ...(typeof data.taskId === "string" ? { taskId: data.taskId } : {}),
        ...(typeof data.error === "string" ? { error: data.error } : {}),
    } as VideoApiState;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("已取消视频生成", "AbortError"));
            return;
        }
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("已取消视频生成", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

async function downloadVideoBlob(videoUrl: string, signal?: AbortSignal): Promise<Blob> {
    if (videoUrl.startsWith("data:video/")) {
        const response = await fetch(videoUrl, { signal });
        return response.blob();
    }
    try {
        const response = await fetch("/api/video-generation/download", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: videoUrl }),
            signal,
        });
        if (!response.ok) {
            const data = await response.json().catch(() => ({})) as { error?: string };
            throw new Error(data.error || `视频下载 HTTP ${response.status}`);
        }
        return await response.blob();
    } catch (error) {
        // Fallback for same-origin/CORS-friendly URLs.
        const response = await fetch(videoUrl, { signal }).catch(() => null);
        if (response?.ok) return response.blob();
        throw error;
    }
}

export async function generateVideoFromConfiguredApi(params: {
    description: string;
    characterId?: string;
    appId?: string;
    durationSeconds?: number;
    signal?: AbortSignal;
}): Promise<VideoGenerationResult> {
    const description = params.description.trim();
    if (!description) throw new VideoGenerationFailure("FAILED", "缺少视频画面描述");
    const prepared = await prepareRequest(description, params.characterId, params.appId || "chat");
    if (params.durationSeconds && Number.isFinite(params.durationSeconds)) {
        prepared.preset = {
            ...prepared.preset,
            duration: Math.min(13, Math.max(5, Math.round(params.durationSeconds))),
        };
    }

    const submitState = await requestServer(videoApiRequestBody(prepared), params.signal);
    let videoUrl = "";
    if (submitState.status === "succeeded" && submitState.videoUrl) {
        videoUrl = submitState.videoUrl;
    } else if (submitState.status === "failed") {
        throw new VideoGenerationFailure("FAILED", submitState.error || "视频生成失败");
    } else {
        const taskId = "taskId" in submitState ? submitState.taskId : undefined;
        if (!taskId) throw new VideoGenerationFailure("FAILED", "视频接口没有返回任务 ID");
        bumpDailyCount();
        const deadline = Date.now() + prepared.settings.timeoutSeconds * 1000;
        while (Date.now() < deadline) {
            await delay(POLL_INTERVAL_MS, params.signal);
            const state = await requestServer({
                action: "poll",
                baseUrl: prepared.preset.baseUrl,
                apiKey: prepared.preset.apiKey,
                taskId,
            }, params.signal);
            if (state.status === "succeeded" && state.videoUrl) {
                videoUrl = state.videoUrl;
                break;
            }
            if (state.status === "failed") {
                throw new VideoGenerationFailure("FAILED", state.error || "视频生成失败");
            }
        }
        if (!videoUrl) {
            throw new VideoGenerationFailure("TIMEOUT", `视频生成超时（${prepared.settings.timeoutSeconds} 秒）`);
        }
    }

    if (submitState.status === "succeeded") bumpDailyCount();
    const blob = await downloadVideoBlob(videoUrl, params.signal);
    const mimeType = blob.type && blob.type.startsWith("video/") ? blob.type : "video/mp4";
    const mediaRef = await storeMediaBlob(blob, mimeType, "video");
    return {
        mediaRef,
        mimeType,
        prompt: prepared.prompt,
        durationSeconds: prepared.preset.duration,
        usedCharacterReference: Boolean(prepared.characterReferenceDataUrl),
        usedUserReference: prepared.usedUserReference,
        usedMotionReference: prepared.usedMotionReference,
    };
}

export function videoGenerationErrorCode(error: unknown): VideoGenerationFailureCode | undefined {
    return error instanceof VideoGenerationFailure ? error.code : undefined;
}
