import { getChatImageFromIndexedDB } from "./chat-asset-storage";
import {
    normalizeReferenceImageForEdit,
    resolveGenerationUserIdentityId,
} from "./image-generation-service";
import { descriptionNeedsUserReference } from "./image-reference-selection";
import { kvGet, kvSet } from "./kv-db";
import { loadMediaBlob, storeMediaBlob } from "./media-cache-storage";
import {
    loadImageGenerationSettings,
    loadUserIdentities,
    loadVideoGenerationSettings,
    resolveActiveVideoPreset,
} from "./settings-storage";
import type { VideoGenerationSettings, VideoPreset } from "./settings-types";
import { pollVideoDirect, submitVideoDirect, type DirectSubmitInput } from "./video-generation-direct";
import { isHttpUrl, toPublicMediaUrl } from "./reference-image-hosting";

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
    /** 动作参考因请求体过大被跳过（已改普通生成）。 */
    motionReferenceSkipped?: boolean;
};

type VideoApiState =
    | { status: "succeeded"; videoUrl: string }
    | { status: "pending"; taskId?: string }
    | { status: "failed"; error?: string };

type PreparedRequest = {
    settings: VideoGenerationSettings;
    preset: VideoPreset;
    prompt: string;
    /** 描述是「角色自拍自己正在做什么」，用于自动切竖屏近景。 */
    isSelfie: boolean;
    /** 视频（带播放条）才要原生音频；动图是静音循环，不请求声音。 */
    nativeAudio: boolean;
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

/** 从中转站的 /v1/models 拉取可选模型；沿用生图的通用模型列表代理。 */
/** 视频生成是否真的可用（启用 + 当前方案配置完整）；提示词注入与失败提示都按这个判断。 */
export function isVideoGenerationConfigured(): boolean {
    const settings = loadVideoGenerationSettings();
    if (!settings.enabled) return false;
    const preset = resolveActiveVideoPreset(settings);
    return Boolean(preset?.model?.trim() && preset?.baseUrl?.trim() && preset?.apiKey?.trim());
}

export async function fetchVideoGenerationModels(preset: Pick<VideoPreset, "apiKey" | "baseUrl">): Promise<string[]> {
    const response = await fetch("/api/image-generation/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: preset.apiKey, baseUrl: preset.baseUrl }),
    });
    const data = await response.json().catch(() => ({})) as { models?: string[]; error?: string };
    if (!response.ok || data.error) {
        throw new Error(data.error || `模型列表请求失败 ${response.status}`);
    }
    return Array.isArray(data.models) ? data.models : [];
}

function blobToDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取参考视频失败"));
        reader.readAsDataURL(blob);
    });
}

async function loadMotionReferenceRef(ref: string): Promise<string> {
    const loaded = await loadMediaBlob(ref);
    if (!loaded) throw new VideoGenerationFailure("FAILED", "参考视频已失效，请重新上传");
    if (loaded.blob.size > MAX_MOTION_REFERENCE_BYTES) {
        throw new VideoGenerationFailure("MOTION_TOO_LARGE", "参考视频超过 8MB，无法作为动作参考，请压缩后再发");
    }
    return blobToDataUrl(loaded.blob);
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
    return loadMotionReferenceRef(ref);
}

async function prepareRequest(
    description: string,
    characterId: string | undefined,
    appId: string,
    motionReferenceOverride?: string,
    videoKind?: "clip" | "loop",
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
    // 视频和生图一样：只有描述里明确要用户本人出镜（合照/同框/两人）才附加用户参考图。
    // 之前无条件带用户照片，是「莫名其妙多出一个人」的主要来源。
    const userName = identityId
        ? loadUserIdentities().find(identity => identity.id === identityId)?.name
        : undefined;
    const needsUserInFrame = descriptionNeedsUserReference(description, userName)
        || /(合照|合影|同框|两人|双人)/.test(description);
    let userReferenceDataUrl = "";
    let usedUserReference = false;
    if (settings.includeUserReference && needsUserInFrame) {
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
    const motionReference = motionReferenceOverride
        ? (preset.supportsMotionReference ? await loadMotionReferenceRef(motionReferenceOverride) : "")
        : await resolveMotionReference(settings, preset);

    // 首帧只放角色参考图。之前会把「角色 + 用户」拼成分格参考板当首帧，
    // 图生视频会把分格板原样拍成多个人（还会带上参考板里的文字标签），所以视频不再拼板。
    const firstFrame = characterReferenceDataUrl;

    const appearance = characterRef?.featurePrompt?.trim() || "";
    const anchors = (characterRef?.anchors || [])
        .filter(anchor => anchor.enabled !== false && anchor.description.trim())
        .map(anchor => `${anchor.name || "特征"}：${anchor.description.trim()}`)
        .join("；");
    // 默认是「角色自拍自己正在做什么」；只有描述里明确出现别人/合照才用第三人称。
    const selfieCue = /(自拍|前置|对着镜头|举着手机|手机镜头|对镜|selfie)/i.test(description);
    const othersCue = /(朋友|同事|路人|家人|男友|女友|我们|一起|合影|合照|同框|其他人|陌生人)/.test(description);
    const personCue = /(他|她|我|自己|角色|脸|手|上身|穿|拿|站|坐|躺|走|笑)/.test(description);
    const isSelfie = selfieCue || (personCue && !othersCue && !usedUserReference);
    const framing = isSelfie
        ? `【画面要求】手机前置自拍视角：手机举在手里、近距离拍摄，脸和上半身占画面主要部分，手臂自然入镜，轻微手持晃动，像真人随手拍的自拍；单镜头，时长约 ${preset.duration} 秒；不要字幕、不要水印、不要台标、不要账号名或贴纸文字。`
        : `【画面要求】单镜头、固定机位、人物半身或全身入镜、手部动作清晰，时长约 ${preset.duration} 秒；不要字幕、不要水印、不要台标、不要账号名或贴纸文字、不要多镜头切换。`;
    const subjectRule = usedUserReference
        ? "【人物数量】画面里只出现角色和用户本人两个人，不要额外增加无关路人或分身。"
        : othersCue
            ? "【人物数量】只出现描述里提到的人，不要额外增加无关路人、分身或克隆。"
            : "【人物数量】画面中只出现角色一人；不要出现路人、朋友、分身或克隆。";
    // 额外提示词（用户填的画风）提到最前面并标成最高优先级，避免被固定模板里的“真人实拍质感”压掉。
    const stylePrompt = preset.extraPrompt.trim();
    const prompt = [
        stylePrompt ? `【画风 / 额外要求（最高优先级，覆盖下面的默认拍摄质感与构图）】${stylePrompt}` : "",
        description,
        // 原生音频：支持声音生成的模型（Seedance 2.x / Veo / Sora 等）会按这段生成现场环境音；
        // 不支持的模型会忽略，不影响画面。动图是静音循环，不写声音要求。
        videoKind !== "loop"
            ? "【环境声】只生成与画面场景一致的真实现场环境音（如街道车流、远处鸣笛、脚步、风声、雨声、室内回声），按当前场景自然出现；不要配乐、不要旁白、不要字幕，画面里没有人开口时不要加说话声。"
            : "",
        appearance ? `【角色固定外观】${appearance}` : "",
        anchors ? `【角色特定锚点】${anchors}` : "",
        "【锁脸要求】画面中角色的脸必须与参考图保持同一个人，五官、脸型、发型、肤色一致，禁止换脸或美颜成另一个人。",
        usedUserReference ? "【双人参考】用户参考图只用于锁住用户的脸；两人必须保持各自的脸，不得混脸。" : "",
        motionReference
            ? "【动作参考】只参考动作节奏与手势；人物数量、长相、构图和场景以本次描述与角色参考图为准，不要照搬参考视频里的人数和画面。"
            : "",
        "【动作方向】严格按描述里的动作方向与顺序拍摄：描述是“走向/进入/推门”就拍进入的过程，不要反向拍成“离开/走出”；时间、地点和正在做的事必须接得上当前剧情，不要跳步。",
        framing,
        subjectRule,
        "【画面纯净】不要出现角色设定图、多视图拼图、分格参考板或文字标签。",
        stylePrompt ? "" : "【拍摄质感】真人手机实拍质感：自然光、真实皮肤与发丝细节。",
        preset.keepBackgroundSharp && !isSelfie
            ? "【背景要求】背景保持清晰、真实、有层次，不要虚化、不要大光圈散景、不要人像景深效果。"
            : "",
    ].filter(Boolean).join("\n\n");

    // 火山/Seedance 官转只收公网 URL 的参考素材，base64 会被上游直接拒绝。
    // 配了 COS（图片/视频都行）或 ImgBB（仅图片）时先换成公网链接；都没有则保持 base64。
    const mediaOptions = { cos: settings.cos, imageHosting: imageSettings.imageHosting };
    let characterReferenceOut = firstFrame;
    let userReferenceOut = usedUserReference ? userReferenceDataUrl : "";
    let motionReferenceOut = motionReference;
    const promote = async (value: string, kind: "image" | "video"): Promise<string> => {
        if (!value || isHttpUrl(value)) return value;
        try {
            return await toPublicMediaUrl(value, { ...mediaOptions, kind });
        } catch (error) {
            console.warn(`[VideoGeneration] 参考${kind === "video" ? "视频" : "图"}上传失败，回退原值：`, error);
            return value;
        }
    };
    characterReferenceOut = await promote(characterReferenceOut, "image");
    userReferenceOut = await promote(userReferenceOut, "image");
    motionReferenceOut = await promote(motionReferenceOut, "video");

    return {
        settings,
        preset,
        prompt,
        isSelfie,
        nativeAudio: videoKind !== "loop",
        characterReferenceDataUrl: characterReferenceOut,
        userReferenceDataUrl: userReferenceOut,
        motionReference: motionReferenceOut,
        usedUserReference,
        usedMotionReference: Boolean(motionReferenceOut),
    };
}

function parseExtraParams(text: string): Record<string, unknown> | undefined {
    const raw = text.trim();
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // 非法 JSON 交给设置页提示，这里忽略，避免阻断生成。
    }
    return undefined;
}

/** 按模型名给出参数默认值，减少手填；未知模型保持通用 New API 风格。 */
export function inferVideoPresetDefaults(model: string): Partial<VideoPreset> {
    const name = model.toLowerCase();
    if (name.includes("sora")) {
        // Sora 走 /videos，首帧字段是 input_reference，只接受一张图，
        // 也不支持动作参考视频，且不接受 resolution（改由 size 表达）。
        return {
            endpointMode: "sora",
            fps: 30,
            imageField: "input_reference",
            resolution: "720p",
            supportsMotionReference: false,
            motionReferenceField: "",
            userReferenceField: "",
        };
    }
    if (name.includes("veo")) {
        return { endpointMode: "generations", fps: 24, imageField: "image" };
    }
    if (name.includes("kling")) {
        return { endpointMode: "generations", fps: 24, imageField: "image" };
    }
    if (/seedance|doubao|jimeng|hailuo|pixverse|runway|vidu|wan|minimax/.test(name)) {
        return { endpointMode: "generations", fps: 24, imageField: "image" };
    }
    return { endpointMode: "auto", fps: 24, imageField: "image" };
}

/** Seedance 2.x（含 Fast / Mini）支持原生音频；1.x 及未知模型不加参数，避免上游报错。 */
function isSeedance2Model(model: string): boolean {
    return /seedance[-_. ]?2/i.test(model);
}

function videoApiRequestBody(prepared: PreparedRequest) {
    const { preset } = prepared;
    const extraBody = parseExtraParams(preset.extraParams) ?? {};
    // 「生成有声视频」参数按火山方舟文档下发字符串 "true"。用户在高级参数里显式配置
    // generate_audio 时以用户为准（填 null 可关掉）。
    if (prepared.nativeAudio && isSeedance2Model(preset.model) && !("generate_audio" in extraBody)) {
        extraBody.generate_audio = "true";
    }
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
        resolution: preset.resolution,
        fps: preset.fps,
        imageField: preset.imageField || "image",
        extraBody: Object.keys(extraBody).length > 0 ? extraBody : undefined,
        endpointMode: preset.endpointMode,
        direct: prepared.settings.directMode !== false,
    };
}

async function requestDirect(payload: Record<string, unknown>, signal?: AbortSignal): Promise<VideoApiState> {
    const input = payload as unknown as DirectSubmitInput & { action?: string; taskId?: string };
    if (input.action === "poll") {
        return pollVideoDirect(input, input.taskId || "", signal);
    }
    return submitVideoDirect(input, signal);
}

async function requestServer(payload: Record<string, unknown>, signal?: AbortSignal): Promise<VideoApiState> {
    // 直连优先：Vercel 等平台对函数请求体有 4.5MB 硬限制，带参考视频时会被 413。
    // 跨域/网络失败只回退到服务端代理，HTTP 业务错误不回退，避免重复提交计费。
    if (payload.direct === true) {
        try {
            return await requestDirect(payload, signal);
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            console.warn("[VideoGeneration] 直连中转站失败，回退服务端代理：", error.message);
        }
    }
    const response = await fetch("/api/video-generation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
    });
    const data = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
        const detail = typeof data.error === "string" ? data.error : "";
        if (response.status === 413) {
            throw new VideoGenerationFailure("FAILED", "视频接口 HTTP 413（请求体过大：参考图/参考视频超出服务端限制）");
        }
        throw new VideoGenerationFailure("FAILED", detail || `视频接口 HTTP ${response.status}`);
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
    /** 聊天里刚发的视频：作为动作参考（media-store 引用）。 */
    motionReferenceRef?: string;
    /** 动图=静音循环，不请求原生音频；视频默认要环境声。 */
    videoKind?: "clip" | "loop";
    signal?: AbortSignal;
}): Promise<VideoGenerationResult> {
    const description = params.description.trim();
    if (!description) throw new VideoGenerationFailure("FAILED", "缺少视频画面描述");
    const prepared = await prepareRequest(
        description,
        params.characterId,
        params.appId || "chat",
        params.motionReferenceRef,
        params.videoKind,
    );
    // 自拍默认竖屏：用户只负责画风提示词，不应该再被默认 16:9 拍成横屏。
    // 明确选了 1:1 等其他比例时尊重用户配置，只把默认的 16:9 改掉。
    if (prepared.isSelfie && prepared.preset.ratio === "16:9") {
        prepared.preset = { ...prepared.preset, ratio: "9:16" };
    }
    if (params.durationSeconds && Number.isFinite(params.durationSeconds)) {
        prepared.preset = {
            ...prepared.preset,
            duration: Math.min(13, Math.max(5, Math.round(params.durationSeconds))),
        };
    }

    let submitState: VideoApiState;
    let motionReferenceSkipped = false;
    try {
        submitState = await requestServer(videoApiRequestBody(prepared), params.signal);
    } catch (error) {
        // 动作参考让请求体超限（413）或被服务商要求公网链接时，去掉参考重试一次，
        // 至少保证能出片；气泡会注明动作参考没有生效。
        const retryable = error instanceof VideoGenerationFailure
            && /413|请求体过大|公网 ?URL|base64|不支持本地文件/i.test(error.message);
        if (!retryable || !prepared.motionReference) throw error;
        console.warn("[VideoGeneration] 参考视频导致请求体过大，改为不带动作参考重试");
        submitState = await requestServer(
            videoApiRequestBody({ ...prepared, motionReference: "", usedMotionReference: false }),
            params.signal,
        );
        motionReferenceSkipped = true;
    }
    // 直连时同样的错误会以 failed 状态返回（不抛错），同样去掉动作参考重试一次。
    if (
        submitState.status === "failed"
        && prepared.motionReference
        && /413|too large|请求体过大|公网 ?URL|base64|不支持本地文件/i.test(submitState.error || "")
    ) {
        console.warn("[VideoGeneration] 动作参考不被接受，改为不带动作参考重试");
        submitState = await requestServer(
            videoApiRequestBody({ ...prepared, motionReference: "", usedMotionReference: false }),
            params.signal,
        );
        motionReferenceSkipped = true;
    }
    if (submitState.status === "failed" && /公网 ?URL|base64|不支持本地文件/i.test(submitState.error || "")) {
        throw new VideoGenerationFailure(
            "FAILED",
            "该服务商的参考图只接受公网 URL：请到「图像生成 API → 图床」配置 ImgBB 后重试",
        );
    }
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
                direct: prepared.settings.directMode !== false,
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
        motionReferenceSkipped,
    };
}
