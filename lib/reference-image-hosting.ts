/**
 * 参考图公网化。
 *
 * 火山方舟 / Seedance 官转等上游只接受公网 http(s) URL 的参考图，
 * base64 data URL 会被直接拒绝（InvalidParameter：参考图片只能传公网 URL）。
 * 配置了图床（ImgBB）时，这里把本地参考图上传换取公网链接；未配置则保持 base64，
 * 由具体服务商决定是否接受。
 */

import type { ImageHostingSettings } from "./settings-types";

export function canHostReferenceImages(hosting: ImageHostingSettings | undefined): boolean {
    return hosting?.provider === "imgbb" && Boolean(hosting.imgbbApiKey?.trim());
}

function dataUrlToBlob(dataUrl: string): { blob: Blob; extension: string } | null {
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl.trim());
    if (!match) return null;
    const mime = match[1].toLowerCase();
    const binary = atob(match[2]);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    const extension = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    return { blob: new Blob([bytes], { type: mime }), extension };
}

/** 把参考图换成公网 URL；已是 URL 或无法解析时原样返回。 */
export async function toPublicImageUrl(
    image: string,
    name: string,
    hosting: ImageHostingSettings,
): Promise<string> {
    const value = image.trim();
    if (!value || /^https?:\/\//i.test(value)) return value;
    const parsed = dataUrlToBlob(value);
    if (!parsed) return value;

    const form = new FormData();
    form.set("file", new File([parsed.blob], `${name}.${parsed.extension}`, { type: parsed.blob.type }));
    form.set("apiKey", hosting.imgbbApiKey.trim());
    if (hosting.defaultExpirationSeconds > 0) form.set("expiration", String(hosting.defaultExpirationSeconds));

    const response = await fetch("/api/image-hosting/imgbb", { method: "POST", body: form });
    const data = await response.json().catch(() => ({})) as { url?: string; error?: string };
    if (!response.ok || !data.url) {
        throw new Error(data.error || `参考图上传图床失败（HTTP ${response.status}）`);
    }
    return data.url;
}
