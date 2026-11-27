// 链接解析：粘贴小红书 / 抖音分享链接，解析出标题、正文、图片、视频。
// 默认走站内 /api/link-parse（服务端抓 OG / 页面内嵌数据）；
// 被平台反爬拦住时，可以填一个自己的解析服务地址。
import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

const PARSER_CONFIG_KEY = "ai_phone_link_parser_v1";
registerKvMigration(PARSER_CONFIG_KEY);

export type LinkParseResult = {
  platform: "xiaohongshu" | "douyin" | "bilibili" | "unknown";
  title: string;
  desc: string;
  author: string;
  images: string[];
  video: string;
  sourceUrl: string;
  via: "builtin" | "custom";
};

export function loadLinkParserBaseUrl(): string {
  if (typeof window === "undefined") return "";
  try { return kvGet(PARSER_CONFIG_KEY) || ""; } catch { return ""; }
}

export function saveLinkParserBaseUrl(baseUrl: string): void {
  const value = baseUrl.trim().replace(/\/+$/, "");
  if (!value) {
    kvRemove(PARSER_CONFIG_KEY);
    return;
  }
  kvSet(PARSER_CONFIG_KEY, value);
}

export function clearLinkParserBaseUrl(): void {
  try { kvRemove(PARSER_CONFIG_KEY); } catch { /* ignore */ }
}

export function detectPlatform(url: string): LinkParseResult["platform"] {
  if (/xiaohongshu\.com|xhslink\.com|xhslink\.cn/i.test(url)) return "xiaohongshu";
  if (/douyin\.com|iesdouyin\.com/i.test(url)) return "douyin";
  if (/bilibili\.com|b23\.tv/i.test(url)) return "bilibili";
  return "unknown";
}

function normalizePayload(raw: unknown, url: string, via: LinkParseResult["via"]): LinkParseResult | null {
  if (!raw || typeof raw !== "object") return null;
  const data = (raw as Record<string, unknown>).data && typeof (raw as Record<string, unknown>).data === "object"
    ? (raw as Record<string, unknown>).data as Record<string, unknown>
    : raw as Record<string, unknown>;
  const pickString = (...keys: string[]) => {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
  };
  const rawImages = data.images ?? data.imageList ?? data.pics ?? [];
  const images = Array.isArray(rawImages)
    ? rawImages
      .map(item => typeof item === "string"
        ? item
        : (item && typeof item === "object"
          ? String((item as Record<string, unknown>).url ?? (item as Record<string, unknown>).urlDefault ?? "")
          : ""))
      .filter(Boolean)
    : [];
  const video = pickString("video", "videoUrl");
  const title = pickString("title", "name");
  const desc = pickString("desc", "content", "text");
  if (!title && !desc && images.length === 0 && !video) return null;
  return {
    platform: detectPlatform(url),
    title,
    desc,
    author: pickString("author", "nickname", "userName"),
    images,
    video,
    sourceUrl: pickString("sourceUrl", "url") || url,
    via,
  };
}

export async function parseSharedLink(rawUrl: string): Promise<LinkParseResult> {
  const url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("请粘贴以 http/https 开头的完整分享链接");
  }
  const customBase = loadLinkParserBaseUrl();

  if (customBase) {
    const endpoint = /\/parse\/?$/i.test(customBase) || customBase.includes("?")
      ? `${customBase}${customBase.includes("?") ? "&" : ""}url=${encodeURIComponent(url)}`
      : `${customBase}?url=${encodeURIComponent(url)}`;
    const res = await fetch(endpoint, { cache: "no-store" });
    if (!res.ok) throw new Error(`解析服务返回 ${res.status}`);
    const parsed = normalizePayload(await res.json(), url, "custom");
    if (!parsed) throw new Error("解析服务没有返回可用的内容");
    return parsed;
  }

  const res = await fetch(`/api/link-parse?url=${encodeURIComponent(url)}`, { cache: "no-store" });
  const payload = await res.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!res.ok || !payload?.ok) {
    const reason = payload?.error || "";
    if (reason === "blocked") {
      throw new Error("平台要求登录或拦截了抓取，请在下方填写你自己的解析服务地址");
    }
    throw new Error(reason || "解析失败，请稍后再试或换用自定义解析服务");
  }
  const parsed = normalizePayload(payload, url, "builtin");
  if (!parsed) throw new Error("没有解析到内容，可能是链接失效");
  return parsed;
}
