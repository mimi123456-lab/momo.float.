/**
 * 参考素材公网化。
 *
 * 火山方舟 / Seedance 官转等上游只接受公网 http(s) URL：
 * 参考图必须公网 URL 或 asset://，参考视频同理，base64 会被直接拒绝。
 *
 * 优先级：
 * 1. 腾讯 COS 直传（图片/视频都支持，浏览器先取签名再 PUT，不受部署平台体积限制）
 * 2. ImgBB 图床（仅图片）
 * 3. 都不可用时保持原值，交给具体服务商报错
 */

import type { CosUploadSettings, ImageHostingSettings } from "./settings-types";

const HTTP_URL = /^https?:\/\//i;

export function isHttpUrl(value: string): boolean {
    return HTTP_URL.test(value.trim());
}

export function isCosConfigured(cos: CosUploadSettings | undefined): boolean {
    return Boolean(
        cos?.enabled
        && cos.secretId.trim()
        && cos.secretKey.trim()
        && cos.bucket.trim()
        && cos.region.trim(),
    );
}

export function canHostReferenceImages(hosting: ImageHostingSettings | undefined): boolean {
    return hosting?.provider === "imgbb" && Boolean(hosting.imgbbApiKey?.trim());
}

function dataUrlToBlob(dataUrl: string): Blob | null {
    const match = /^data:([a-zA-Z0-9.+/-]+);base64,(.+)$/.exec(dataUrl.trim());
    if (!match) return null;
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: match[1].toLowerCase() });
}

function extensionFor(mime: string, kind: "image" | "video"): string {
    const normalized = mime.toLowerCase();
    const map: Record<string, string> = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
        "image/gif": "gif",
        "video/mp4": "mp4",
        "video/quicktime": "mov",
        "video/webm": "webm",
    };
    return map[normalized] || (kind === "video" ? "mp4" : "jpg");
}

async function uploadToCos(blob: Blob, kind: "image" | "video", cos: CosUploadSettings): Promise<string> {
    const contentType = blob.type || (kind === "video" ? "video/mp4" : "image/jpeg");
    const prefix = cos.prefix.trim().replace(/^\/+|\/+$/g, "") || "momo";
    const day = new Date().toISOString().slice(0, 10);
    const random = Math.random().toString(36).slice(2, 8);
    const key = `${prefix}/${day}/${Date.now()}-${random}.${extensionFor(contentType, kind)}`;

    const signResponse = await fetch("/api/cos-upload/sign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            secretId: cos.secretId,
            secretKey: cos.secretKey,
            bucket: cos.bucket,
            region: cos.region,
            key,
            contentType,
        }),
    });
    const sign = await signResponse.json().catch(() => ({})) as {
        url?: string;
        publicUrl?: string;
        headers?: Record<string, string>;
        error?: string;
    };
    if (!signResponse.ok || !sign.url || !sign.headers) {
        throw new Error(sign.error || `COS 签名失败（HTTP ${signResponse.status}）`);
    }

    const putResponse = await fetch(sign.url, { method: "PUT", headers: sign.headers, body: blob });
    if (!putResponse.ok) {
        const detail = putResponse.status === 403
            ? "，请检查密钥、桶权限与 CORS 规则"
            : "";
        throw new Error(`COS 上传失败（HTTP ${putResponse.status}${detail}）`);
    }
    return sign.publicUrl || sign.url;
}

async function uploadToImgbb(blob: Blob, hosting: ImageHostingSettings): Promise<string> {
    const form = new FormData();
    form.set("file", new File([blob], `reference.${extensionFor(blob.type, "image")}`, { type: blob.type || "image/jpeg" }));
    form.set("apiKey", hosting.imgbbApiKey.trim());
    if (hosting.defaultExpirationSeconds > 0) form.set("expiration", String(hosting.defaultExpirationSeconds));

    const response = await fetch("/api/image-hosting/imgbb", { method: "POST", body: form });
    const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !data.url) {
        throw new Error(data.error || `图床上传失败（HTTP ${response.status}）`);
    }
    return data.url;
}

export type PublicMediaOptions = {
    kind: "image" | "video";
    cos?: CosUploadSettings;
    imageHosting?: ImageHostingSettings;
};

/** 本地素材 → 公网 URL；无法上传时原样返回（由服务商报错）。 */
export async function toPublicMediaUrl(source: string, options: PublicMediaOptions): Promise<string> {
    const value = source.trim();
    if (!value || isHttpUrl(value)) return value;
    const blob = dataUrlToBlob(value);
    if (!blob) return value;

    if (isCosConfigured(options.cos)) {
        return uploadToCos(blob, options.kind, options.cos as CosUploadSettings);
    }
    if (options.kind === "image" && canHostReferenceImages(options.imageHosting)) {
        return uploadToImgbb(blob, options.imageHosting as ImageHostingSettings);
    }
    return value;
}
