/**
 * 浏览器直连中转站的视频请求。
 *
 * Vercel 的 Serverless 函数请求体上限是 4.5MB，带参考视频（base64 后约 1.33 倍）
 * 很容易超过，整条请求会被平台直接 413。多数 New API 系中转站的 CORS 是开放的，
 * 这里直接由手机发请求，绕开部署平台的体积限制；失败时由调用方回退到服务端代理。
 */

export type DirectVideoState =
    | { status: "succeeded"; videoUrl: string }
    | { status: "pending"; taskId?: string }
    | { status: "failed"; error?: string };

export type DirectSubmitInput = {
    baseUrl: string;
    apiKey: string;
    model?: string;
    prompt?: string;
    image?: string;
    imageField?: string;
    extraReferenceImage?: string;
    extraReferenceField?: string;
    motionReference?: string;
    motionReferenceField?: string;
    duration?: number;
    ratio?: string;
    resolution?: string;
    fps?: number;
    extraBody?: Record<string, unknown>;
    endpointMode?: "auto" | "generations" | "sora";
};

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

function computePixelSize(ratio: string, resolution: string): string {
    const height = /1080/.test(resolution) ? 1080 : /480/.test(resolution) ? 480 : 720;
    const [rw, rh] = ratio.split(":").map(value => Number(value));
    const widthRatio = Number.isFinite(rw) && rw > 0 ? rw : 16;
    const heightRatio = Number.isFinite(rh) && rh > 0 ? rh : 9;
    const width = Math.max(2, Math.round((height * widthRatio) / heightRatio / 2) * 2);
    return `${width}x${height}`;
}

function toSoraSeconds(duration?: number): string {
    const value = Number(duration) || 8;
    if (value <= 6) return "4";
    if (value <= 10) return "8";
    return "12";
}

function buildSubmitBody(input: DirectSubmitInput, style: "generations" | "sora"): Record<string, unknown> {
    const imageField = (input.imageField || "image").trim() || "image";
    const body: Record<string, unknown> = { model: input.model, prompt: input.prompt };
    if (input.image) body[imageField] = input.image;
    const extraField = (input.extraReferenceField || "").trim();
    if (extraField && input.extraReferenceImage) {
        body[extraField] = extraField.endsWith("images") ? [input.extraReferenceImage] : input.extraReferenceImage;
    }
    const motionField = (input.motionReferenceField || "video_url").trim() || "video_url";
    if (input.motionReference) body[motionField] = input.motionReference;

    if (style === "sora") {
        body.seconds = toSoraSeconds(input.duration);
        body.size = computePixelSize(input.ratio || "16:9", input.resolution || "720p");
    } else {
        body.duration = input.duration ?? 8;
        body.ratio = input.ratio || "16:9";
        body.resolution = input.resolution || "720p";
        if (input.fps) body.fps = input.fps;
        body.response_format = "url";
    }

    if (input.extraBody && typeof input.extraBody === "object") {
        Object.assign(body, input.extraBody);
        for (const key of Object.keys(body)) {
            if (body[key] === null) delete body[key];
        }
    }
    if (body.size !== undefined) delete body.resolution;
    return body;
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

export async function submitVideoDirect(input: DirectSubmitInput, signal?: AbortSignal): Promise<DirectVideoState> {
    const styles: Array<"generations" | "sora"> = input.endpointMode === "generations"
        ? ["generations"]
        : input.endpointMode === "sora"
            ? ["sora"]
            : ["generations", "sora"];
    let lastError = "视频生成提交失败";
    for (const style of styles) {
        for (const url of buildSubmitUrls(input.baseUrl, style)) {
            let response: Response;
            try {
                response = await fetch(url, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${input.apiKey}`,
                    },
                    body: JSON.stringify(buildSubmitBody(input, style)),
                    signal,
                });
            } catch {
                // CORS / 网络层失败：交给调用方回退服务端代理。
                throw new TypeError("直连中转站失败（可能是跨域或网络问题）");
            }
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
                lastError = readErrorMessage(payload) || `HTTP ${response.status}`;
                if ([404, 405, 415].includes(response.status)) continue;
                return { status: "failed", error: lastError };
            }
            const videoUrl = extractVideoUrl(payload);
            if (videoUrl) return { status: "succeeded", videoUrl };
            const taskId = extractTaskId(payload);
            if (taskId) return { status: "pending", taskId };
            lastError = "接口响应里没有任务 ID 或视频地址";
        }
    }
    return { status: "failed", error: lastError };
}

export async function pollVideoDirect(
    input: Pick<DirectSubmitInput, "baseUrl" | "apiKey">,
    taskId: string,
    signal?: AbortSignal,
): Promise<DirectVideoState> {
    let lastError = "查询任务失败";
    for (const url of buildPollUrls(input.baseUrl, taskId)) {
        let response: Response;
        try {
            response = await fetch(url, {
                method: "GET",
                headers: { Authorization: `Bearer ${input.apiKey}` },
                signal,
            });
        } catch {
            throw new TypeError("直连中转站失败（可能是跨域或网络问题）");
        }
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
            lastError = readErrorMessage(payload) || `HTTP ${response.status}`;
            if ([404, 405].includes(response.status)) continue;
            return { status: "failed", error: lastError };
        }
        const raw = extractStatus(payload);
        const videoUrl = extractVideoUrl(payload);
        if (/succeed|success|complete|done|finished/i.test(raw) && videoUrl) {
            return { status: "succeeded", videoUrl };
        }
        if (/fail|error|cancel|reject/i.test(raw)) {
            return { status: "failed", error: readErrorMessage(payload) || "视频生成失败" };
        }
        return { status: "pending" };
    }
    return { status: "failed", error: lastError };
}
