import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as externalFetch } from "undici";
import { isPublicImageAddress } from "./server-image-download";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** Read an already generated video. Never accepts credentials or generates videos. */
export async function downloadGeneratedVideo(rawUrl: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; mimeType: string }> {
    let url = new URL(rawUrl);
    for (let redirects = 0; redirects <= 4; redirects++) {
        if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("视频地址必须是公开的 HTTP/HTTPS 地址");
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
        if (!addresses.length || addresses.some(item => !isPublicImageAddress(item.address))) throw new Error("不允许读取本机或内网视频地址");
        const selected = addresses.find(item => item.family === 4) || addresses[0];
        const dispatcher = new Agent({ connect: { lookup(_host, options, callback) {
            if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
            else callback(null, selected.address, selected.family);
        } } });
        try {
            const response = await externalFetch(url, { method: "GET", redirect: "manual", signal, dispatcher });
            if ([301, 302, 303, 307, 308].includes(response.status)) {
                const location = response.headers.get("location");
                await response.body?.cancel();
                if (!location) throw new Error("视频重定向地址缺失");
                url = new URL(location, url);
                continue;
            }
            if (!response.ok) {
                await response.body?.cancel();
                throw new Error(`视频下载 HTTP ${response.status}`);
            }
            const mimeType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            const isVideo = mimeType.startsWith("video/") || mimeType === "application/octet-stream";
            if (!isVideo) {
                await response.body?.cancel();
                throw new Error("视频地址没有返回视频内容");
            }
            const reader = response.body?.getReader();
            if (!reader) throw new Error("视频内容为空");
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.length;
                    if (size > MAX_VIDEO_BYTES) throw new Error("视频超过 200MB 下载限制");
                    chunks.push(value);
                }
            } finally { await reader.cancel().catch(() => {}); }
            if (!size) throw new Error("视频内容为空");
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            return { bytes, mimeType: mimeType === "application/octet-stream" ? "video/mp4" : mimeType };
        } finally { await dispatcher.close(); }
    }
    throw new Error("视频地址重定向次数过多");
}
