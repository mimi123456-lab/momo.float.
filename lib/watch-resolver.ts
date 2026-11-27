import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * 一起看 · 内置视频解析缓存（服务端专用）。
 *
 * 自部署时无需 Termux / Python：小红书等分享链接直接在站内 API 里
 * 「展开短链 → 提取直链 → 下载到本地缓存 → 原生播放器播放」。
 * 缓存按「最终 URL 的 sha1」做主键：同一视频第二次播放直接命中缓存秒开，
 * 文件持久保留（重启不丢），只在超过总容量上限时按最久未访问清理。
 */

const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// 部署到 Vercel 等 serverless 平台时项目目录只读，必须落到可写的临时目录。
export const WATCH_CACHE_DIR = process.env.WATCH_CACHE_DIR
  ? path.resolve(process.env.WATCH_CACHE_DIR)
  : process.env.VERCEL
    ? path.join("/tmp", "watch-cache")
    : path.join(process.cwd(), ".watch-cache");
const INDEX_FILE = path.join(WATCH_CACHE_DIR, "index.json");
const MAX_FILE_MB = Math.max(50, Number(process.env.WATCH_CACHE_MAX_FILE_MB) || 2048);
const MAX_TOTAL_MB = Math.max(100, Number(process.env.WATCH_CACHE_MAX_TOTAL_MB) || 4096);

export type WatchCacheEntry = {
  id: string;
  url: string;
  platform: string;
  title: string;
  file: string;
  size: number;
  createdAt: number;
  lastAccess: number;
};

type WatchCacheIndex = Record<string, WatchCacheEntry>;

export function cacheKeyFor(url: string): string {
  return createHash("sha1").update(url.trim()).digest("hex").slice(0, 20);
}

async function readIndex(): Promise<WatchCacheIndex> {
  try {
    const raw = await readFile(INDEX_FILE, "utf8");
    const parsed = JSON.parse(raw) as WatchCacheIndex;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

async function writeIndex(index: WatchCacheIndex): Promise<void> {
  await mkdir(WATCH_CACHE_DIR, { recursive: true });
  await writeFile(INDEX_FILE, JSON.stringify(index, null, 1), "utf8");
}

export async function getCacheEntry(id: string): Promise<WatchCacheEntry | null> {
  const index = await readIndex();
  const entry = index[id];
  if (!entry) return null;
  try {
    const info = await stat(path.join(WATCH_CACHE_DIR, entry.file));
    if (!info.isFile() || info.size < 1024) return null;
  } catch { return null; }
  // 命中即续期，LRU 才有依据
  entry.lastAccess = Date.now();
  await writeIndex(index);
  return entry;
}

export async function deleteCacheEntry(id: string): Promise<boolean> {
  const index = await readIndex();
  const entry = index[id];
  if (!entry) return false;
  delete index[id];
  await writeIndex(index);
  try { await unlink(path.join(WATCH_CACHE_DIR, entry.file)); } catch { /* already gone */ }
  return true;
}

/** 总容量超限时按最久未访问清理（永不清理本次刚写入的）。 */
async function evictIfNeeded(index: WatchCacheIndex, keepId: string | null): Promise<void> {
  const entries = Object.values(index).filter(entry => entry.id !== keepId);
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= MAX_TOTAL_MB * 1024 * 1024) return;
  entries.sort((a, b) => a.lastAccess - b.lastAccess);
  for (const entry of entries) {
    if (total <= MAX_TOTAL_MB * 1024 * 1024) break;
    try { await unlink(path.join(WATCH_CACHE_DIR, entry.file)); } catch { /* ignore */ }
    total -= entry.size;
    delete index[entry.id];
  }
}

/** 展开短链（xhslink / v.douyin.com 等）；非短链原样返回。手动逐跳跟随，结果只允许还是同一批站点。 */
export async function expandShortLink(url: string): Promise<string> {
  const shortHosts = new Set(["xhslink.cn", "xhslink.com", "v.douyin.com", "iesdouyin.com"]);
  let host = "";
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return url; }
  if (!shortHosts.has(host)) return url;
  let current = url;
  for (let hop = 0; hop < 5; hop += 1) {
    const res = await fetch(current, {
      method: "GET", redirect: "manual",
      headers: { "User-Agent": MOBILE_UA },
      signal: AbortSignal.timeout(15000),
    });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }
  const finalHost = new URL(current).hostname.toLowerCase().replace(/^www\./, "");
  if (finalHost.endsWith("xiaohongshu.com") || finalHost.endsWith("douyin.com") || finalHost.endsWith("iesdouyin.com")) return current;
  return url;
}

/** 小红书笔记页里直接正则提取 masterUrl（直链在 HTML 的 stream.h264[0] 上）。 */
export function extractXiaohongshuVideo(html: string): { directUrl: string; title: string } | null {
  const match = /"masterUrl"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  if (!match) return null;
  let directUrl = "";
  try { directUrl = JSON.parse('"' + match[1] + '"') as string; } catch { return null; }
  if (!/^https?:\/\//.test(directUrl)) return null;
  const titleMatch = /<meta\s+name="og:title"\s+content="([^"]*)"/.exec(html)
    || /<title[^>]*>([^<]*)</.exec(html);
  const title = (titleMatch?.[1] || "").replace(/_小红书.*$/, "").trim() || "小红书视频";
  return { directUrl, title };
}

function assertSafeDownloadHost(rawUrl: string): void {
  const host = new URL(rawUrl).hostname.toLowerCase();
  const allowed = [
    "xhscdn.com", "sns-img-qc.xhscdn.com",
    "douyinvod.com", "bytecdn.com", "douyinpic.com", "byteimg.com", "amemv.com",
  ];
  if (!allowed.some(suffix => host === suffix || host.endsWith("." + suffix))) {
    throw new Error("直链下载目标不在允许的 CDN 内");
  }
}

function extractPageTitle(html: string): string {
  const titleMatch = /<meta\s+name="og:title"\s+content="([^"]*)"/.exec(html)
    || /<title[^>]*>([^<]*)</.exec(html);
  return (titleMatch?.[1] || "").trim();
}

function collectDouyinPlayUrls(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > 14 || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of ["play_addr", "playAddr"]) {
    const address = record[key];
    if (!address || typeof address !== "object") continue;
    const value = address as Record<string, unknown>;
    for (const listKey of ["url_list", "urlList"]) {
      const list = value[listKey];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === "string" && /^https?:\/\//.test(item) && !out.includes(item)) out.push(item);
      }
    }
    if (typeof value.src === "string" && /^https?:\/\//.test(value.src) && !out.includes(value.src)) out.push(value.src);
  }
  for (const value of Object.values(record)) {
    if (value && typeof value === "object") collectDouyinPlayUrls(value, out, depth + 1);
  }
}

/** 抖音分享页：优先解 RENDER_DATA / _ROUTER_DATA，再回退正则；拿不到返回 null。 */
export function extractDouyinVideo(html: string): { directUrl: string; title: string } | null {
  const title = extractPageTitle(html).replace(/_抖音.*$/, "").trim() || "抖音视频";
  const candidates: string[] = [];
  const scriptPattern = /<script[^>]+id="(?:RENDER_DATA|_ROUTER_DATA)"[^>]*>([\s\S]*?)<\/script>/gi;
  for (;;) {
    const match = scriptPattern.exec(html);
    if (!match) break;
    try {
      const jsonText = decodeURIComponent(match[1]);
      collectDouyinPlayUrls(JSON.parse(jsonText), candidates);
    } catch { /* 某个 script 解不开就继续试下一个 */ }
  }
  if (candidates.length === 0) {
    const fallback = /"play_addr"[\s\S]{0,400}?"url_list"\s*:\s*\["([^"]+)"/.exec(html);
    if (fallback?.[1]) candidates.push(fallback[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/"));
  }
  const directUrl = candidates.find(url => /douyinvod|bytecdn|amemv/i.test(url)) || candidates[0];
  if (!directUrl || !/^https?:\/\//.test(directUrl)) return null;
  return { directUrl, title };
}

export type BuiltInResolveResult = {
  id: string;
  cacheHit: boolean;
  title: string;
  size: number;
  downloadUrl: string;
};

/**
 * 解析并缓存一个视频。缓存命中时只更新 lastAccess 并立即返回（秒开）。
 * 抛错时给出可读的中文原因。
 */
export async function resolveAndCache(videoUrl: string): Promise<BuiltInResolveResult> {
  // 先展开短链（xhslink.cn → xiaohongshu.com、v.douyin.com → douyin.com），再做平台判断——顺序反了短链会被直接拒绝。
  const finalUrl = await expandShortLink(videoUrl);
  const parsed = new URL(finalUrl);
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const isXhs = host === "xiaohongshu.com" || host.endsWith(".xiaohongshu.com");
  const isDouyin = host === "douyin.com" || host.endsWith(".douyin.com") || host === "iesdouyin.com" || host.endsWith(".iesdouyin.com");
  if (!isXhs && !isDouyin) throw new Error("内置解析器目前支持小红书和抖音；快手等平台需要平台签名，无法直接解析，请先保存视频再用本地视频播放");

  const id = cacheKeyFor(finalUrl);
  const index = await readIndex();
  const existing = index[id];
  if (existing) {
    try {
      const info = await stat(path.join(WATCH_CACHE_DIR, existing.file));
      if (info.isFile() && info.size > 1024) {
        existing.lastAccess = Date.now();
        await writeIndex(index);
        return { id, cacheHit: true, title: existing.title, size: existing.size, downloadUrl: `/api/watch-resolver/video/${id}` };
      }
    } catch { /* 缓存文件没了，重新解析 */ }
  }

  const pageRes = await fetch(finalUrl, {
    headers: { "User-Agent": MOBILE_UA, Referer: isXhs ? "https://www.xiaohongshu.com/" : "https://www.douyin.com/" },
    signal: AbortSignal.timeout(25000),
  });
  if (!pageRes.ok) throw new Error(`${isXhs ? "小红书" : "抖音"}页面请求失败（HTTP ${pageRes.status}）`);
  const html = await pageRes.text();
  const extracted = isXhs ? extractXiaohongshuVideo(html) : extractDouyinVideo(html);
  if (!extracted) {
    throw new Error(isXhs
      ? "未能从小红书页面提取到视频直链（笔记可能已被删除或需要登录）"
      : "抖音解析失败：分享页可能要求登录或被风控，请改用 APK 原生解析或本地视频");
  }
  assertSafeDownloadHost(extracted.directUrl);

  await mkdir(WATCH_CACHE_DIR, { recursive: true });
  const fileName = `${id}.mp4`;
  const filePath = path.join(WATCH_CACHE_DIR, fileName);
  const download = await fetch(extracted.directUrl, {
    headers: { "User-Agent": MOBILE_UA, Referer: isXhs ? "https://www.xiaohongshu.com/" : "https://www.douyin.com/" },
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!download.ok || !download.body) throw new Error(`视频下载失败（HTTP ${download.status}）`);
  const maxBytes = MAX_FILE_MB * 1024 * 1024;
  let written = 0;
  const reader = download.body.getReader();
  const out = createWriteStream(filePath);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) throw new Error(`视频超过单文件缓存上限（${MAX_FILE_MB} MB）`);
      if (!out.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          out.once("drain", resolve);
          out.once("error", reject);
        });
      }
    }
    out.end();
    await new Promise<void>((resolve, reject) => out.once("finish", resolve).once("error", reject));
  } catch (error) {
    out.destroy();
    try { await unlink(filePath); } catch { /* ignore */ }
    throw error instanceof Error ? error : new Error(String(error));
  }
  if (written < 1024) {
    try { await unlink(filePath); } catch { /* ignore */ }
    throw new Error("下载内容异常（过小），已放弃");
  }

  index[id] = { id, url: finalUrl, platform: isXhs ? "xiaohongshu" : "douyin", title: extracted.title, file: fileName, size: written, createdAt: Date.now(), lastAccess: Date.now() };
  await evictIfNeeded(index, id);
  await writeIndex(index);
  return { id, cacheHit: false, title: extracted.title, size: written, downloadUrl: `/api/watch-resolver/video/${id}` };
}

/** 带断点续传（Range）的视频流响应；找不到或已清理时返回 null。 */
export async function streamCacheEntry(id: string, rangeHeader: string | null): Promise<Response | null> {
  const entry = await getCacheEntry(id);
  if (!entry) return null;
  const filePath = path.join(WATCH_CACHE_DIR, entry.file);
  const info = await stat(filePath);
  const headersBase: Record<string, string> = {
    "Accept-Ranges": "bytes",
    "Content-Type": "video/mp4",
    "Cache-Control": "private, max-age=3600",
  };
  const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= info.size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    }
    const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: { ...headersBase, "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": String(end - start + 1) },
    });
  }
  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, { status: 200, headers: { ...headersBase, "Content-Length": String(info.size) } });
}

/** 列出缓存（设置页/清理入口用）。 */
export async function listCacheEntries(): Promise<WatchCacheEntry[]> {
  const index = await readIndex();
  return Object.values(index).sort((a, b) => b.lastAccess - a.lastAccess);
}

export { pipeline };
