import { NextRequest, NextResponse } from "next/server";
import { ProxyAgent, type Dispatcher } from "undici";

export const runtime = "nodejs";
export const maxDuration = 120;

type VideoRequest = {
    action?: "submit" | "poll";
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    prompt?: string;
    /** 角色参考图（首帧），data URL 或 http(s) 地址。 */
    image?: string;
    imageField?: string;
    /** 用户参考图。 */
    extraReferenceImage?: string;
    extraReferenceField?: string;
    /** 动作参考视频，data URL 或 http(s) 地址。 */
    motionReference?: string;
    motionReferenceField?: string;
    duration?: number;
    ratio?: string;
    resolution?: string;
    endpointMode?: "auto" | "generations" | "sora";
    taskId?: string;
};

type TaskState = {
    status: "pending" | "succeeded" | "failed";
    videoUrl?: string;
    error?: string;
};

function getProxyDispatcher(): Dispatcher | undefined {
    const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY
        || process.env.http_proxy || process.env.HTTP_PROXY;
    return proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

function normalizeBaseUrl(baseUrl: string): string {
    return baseUrl
        .trim()
        .replace(/\/+$/, "")
        .replace(/\/videos\/generations$/i, "")
        .replace(/\/video\/generations$/i, "")
        .replace(/\/videos$/i, "");
}

function buildSubmitUrls(baseUrl: string, mode: string): string[] {
    const base = normalizeBaseUrl(baseUrl);
    if (mode === "generations") return [`${base}/videos/generations`, `${base}/video/generations`];
    if (mode === "sora") return [`${base}/videos`];
    return [`${base}/videos/generations`, `${base}/video/generations`, `${base}/videos`];
}

function buildPollUrls(baseUrl: string, taskId: string): string[] {
    const base = normalizeBaseUrl(baseUrl);
    const id = encodeURIComponent(taskId);
    return [
        `${base}/videos/generations/${id}`,
        `${base}/videos/${id}`,
        `${base}/video/generations/${id}`,
        `${base}/tasks/${id}`,
    ];
}

async function postJson(url: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<Response> {
    const dispatcher = getProxyDispatcher();
    const init: RequestInit = {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
    };
    return dispatcher
        ? fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher })
        : fetch(url, init);
}

async function getJson(url: string, apiKey: string, signal: AbortSignal): Promise<Response> {
    const dispatcher = getProxyDispatcher();
    const init: RequestInit = {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}` },
        signal,
    };
    return dispatcher
        ? fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher })
        : fetch(url, init);
}

function readErrorMessage(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (error && typeof error === "object") {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    return undefined;
}

function extractVideoUrl(data: unknown, depth = 0): string | undefined {
    if (!data || typeof data !== "object" || depth > 6) return undefined;
    const record = data as Record<string, unknown>;
    for (const key of ["video_url", "url", "video", "output_url", "download_url"]) {
        const value = record[key];
        if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
        if (typeof value === "string" && value.startsWith("data:video/")) return value.trim();
    }
    for (const key of ["data", "result", "output", "content", "videos", "video"]) {
        const value = record[key];
        if (Array.isArray(value)) {
            for (const item of value) {
                const nested = extractVideoUrl(item, depth + 1);
                if (nested) return nested;
            }
        } else if (value && typeof value === "object") {
            const nested = extractVideoUrl(value, depth + 1);
            if (nested) return nested;
        }
    }
    return undefined;
}

function extractTaskId(data: unknown, depth = 0): string | undefined {
    if (!data || typeof data !== "object" || depth > 4) return undefined;
    const record = data as Record<string, unknown>;
    for (const key of ["task_id", "taskId", "job_id", "jobId", "request_id", "requestId", "id"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim();
        if (typeof value === "number") return String(value);
    }
    for (const key of ["data", "result", "output"]) {
        const value = record[key];
        if (value && typeof value === "object") {
            const nested = extractTaskId(value, depth + 1);
            if (nested) return nested;
        }
    }
    return undefined;
}

function extractStatus(data: unknown): string {
    if (!data || typeof data !== "object") return "";
    const record = data as Record<string, unknown>;
    for (const key of ["status", "state", "task_status", "phase"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim()) return value.trim().toLowerCase();
    }
    for (const key of ["data", "result", "output"]) {
        const value = record[key];
        if (value && typeof value === "object") {
            const nested = extractStatus(value);
            if (nested) return nested;
        }
    }
    return "";
}

function normalizeStatus(raw: string): TaskState["status"] {
    if (/succeed|success|complete|done|finished/i.test(raw)) return "succeeded";
    if (/fail|error|cancel|reject/i.test(raw)) return "failed";
    return "pending";
}

function buildSubmitBody(input: VideoRequest, style: "generations" | "sora"): Record<string, unknown> {
    const imageField = (input.imageField || "image").trim() || "image";
    const body: Record<string, unknown> = {
        model: input.model,
        prompt: input.prompt,
        resolution: input.resolution || "720p",
    };
    if (input.image) body[imageField] = input.image;
    const extraField = (input.extraReferenceField || "").trim();
    if (extraField && input.extraReferenceImage) {
        body[extraField] = extraField.endsWith("images") ? [input.extraReferenceImage] : input.extraReferenceImage;
    }
    const motionField = (input.motionReferenceField || "video_url").trim() || "video_url";
    if (input.motionReference) body[motionField] = input.motionReference;

    if (style === "sora") {
        body.seconds = String(input.duration ?? 8);
        body.size = input.ratio || "16:9";
    } else {
        body.duration = input.duration ?? 8;
        body.ratio = input.ratio || "16:9";
        body.response_format = "url";
    }
    return body;
}

export async function POST(request: NextRequest) {
    const input = await request.json().catch(() => null) as VideoRequest | null;
    if (!input || typeof input !== "object") {
        return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
    }
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
    if (!apiKey || !baseUrl) {
        return NextResponse.json({ error: "缺少视频 API 地址或 Key" }, { status: 400 });
    }
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(110_000)]);

    if (input.action === "poll") {
        const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
        if (!taskId) return NextResponse.json({ error: "缺少任务 ID" }, { status: 400 });
        const urls = buildPollUrls(baseUrl, taskId);
        let lastError = "查询任务失败";
        for (const url of urls) {
            try {
                const response = await getJson(url, apiKey, signal);
                const payload = await response.json().catch(() => null);
                if (!response.ok) {
                    lastError = readErrorMessage(payload) || `查询任务 HTTP ${response.status}`;
                    if (response.status === 404 || response.status === 405) continue;
                    return NextResponse.json({ error: lastError }, { status: 502 });
                }
                const state = normalizeStatus(extractStatus(payload));
                const videoUrl = extractVideoUrl(payload);
                if (state === "succeeded" && videoUrl) {
                    return NextResponse.json({ status: "succeeded", videoUrl });
                }
                if (state === "failed") {
                    return NextResponse.json({
                        status: "failed",
                        error: readErrorMessage(payload) || "视频生成失败",
                    });
                }
                return NextResponse.json({ status: "pending" });
            } catch (error) {
                lastError = error instanceof Error ? error.message : "查询任务失败";
            }
        }
        return NextResponse.json({ error: lastError }, { status: 502 });
    }

    // submit
    const styles: Array<"generations" | "sora"> = input.endpointMode === "generations"
        ? ["generations"]
        : input.endpointMode === "sora"
            ? ["sora"]
            : ["generations", "sora"];
    let lastError = "视频生成提交失败";
    for (const style of styles) {
        const urls = buildSubmitUrls(baseUrl, style);
        for (const url of urls) {
            try {
                const body = buildSubmitBody(input, style);
                const response = await postJson(url, apiKey, body, signal);
                const payload = await response.json().catch(() => null);
                if (!response.ok) {
                    lastError = readErrorMessage(payload) || `提交失败 HTTP ${response.status}`;
                    if ([404, 405, 415].includes(response.status)) continue;
                    return NextResponse.json({ error: lastError }, { status: 502 });
                }
                const directUrl = extractVideoUrl(payload);
                if (directUrl) {
                    return NextResponse.json({ status: "succeeded", videoUrl: directUrl });
                }
                const taskId = extractTaskId(payload);
                if (taskId) {
                    return NextResponse.json({ status: "pending", taskId });
                }
                lastError = "接口响应里没有任务 ID 或视频地址，请检查中转站是否兼容视频接口";
            } catch (error) {
                lastError = error instanceof Error ? error.message : "视频生成提交失败";
            }
        }
    }
    return NextResponse.json({ error: lastError }, { status: 502 });
}
