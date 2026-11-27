import { NextResponse } from "next/server";

// 链接解析（小红书 / 抖音 / 通用网页）：
// 服务端抓取分享页，优先读页面内嵌数据，其次读 Open Graph。
// 平台风控严格时可能只拿到登录页，此时返回 blocked，前端会提示配置自己的解析服务。
export const runtime = "nodejs";
export const maxDuration = 25;

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";

function ok(data: Record<string, unknown>) {
  return NextResponse.json({ ok: true, ...data }, { headers: { "Cache-Control": "no-store" } });
}

function fail(error: string, status = 200) {
  return NextResponse.json({ ok: false, error }, { status, headers: { "Cache-Control": "no-store" } });
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function readMeta(html: string, key: string): string {
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return "";
}

function readAllMeta(html: string, key: string): string[] {
  const results: string[] = [];
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "gi"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "gi"),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      if (match[1]) results.push(decodeHtml(match[1]));
    }
  }
  return Array.from(new Set(results));
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function parseXiaohongshu(html: string) {
  const title = html.match(/"title"\s*:\s*"((?:[^"\\]|\\.){2,120})"/)?.[1];
  const desc = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.){2,2000})"/)?.[1];
  const images = Array.from(html.matchAll(/"urlDefault"\s*:\s*"(https?:[^"]+)"/g))
    .map(item => item[1].replace(/\\u002F/g, "/"))
    .slice(0, 12);
  const video = html.match(/"masterUrl"\s*:\s*"(https?:[^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") || "";
  const author = html.match(/"nickname"\s*:\s*"((?:[^"\\]|\\.){1,40})"/)?.[1];
  return {
    title: title ? unescapeJsonString(title) : "",
    desc: desc ? unescapeJsonString(desc) : "",
    images: Array.from(new Set(images)),
    video,
    author: author ? unescapeJsonString(author) : "",
  };
}

function parseDouyin(html: string) {
  // 抖音把页面数据放在 <script id="RENDER_DATA"> 里，需要先 URL 解码。
  let decoded = html;
  const renderData = /<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (renderData) {
    try { decoded = decodeURIComponent(renderData); } catch { decoded = renderData; }
  }
  const desc = decoded.match(/"desc"\s*:\s*"((?:[^"\\]|\\.){4,600})"/)?.[1];
  const images = Array.from(decoded.matchAll(/"url_list"\s*:\s*\[\s*"(https?:[^"]+)"/g))
    .map(item => item[1].replace(/\\u002F/g, "/"))
    .slice(0, 12);
  const video = decoded.match(/"play_addr"\s*:\s*\{[^}]*"url_list"\s*:\s*\[\s*"(https?:[^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") || "";
  const author = decoded.match(/"nickname"\s*:\s*"((?:[^"\\]|\\.){1,40})"/)?.[1];
  return {
    title: "",
    desc: desc ? unescapeJsonString(desc) : "",
    images: Array.from(new Set(images)),
    video,
    author: author ? unescapeJsonString(author) : "",
  };
}

export async function GET(request: Request) {
  const url = (new URL(request.url).searchParams.get("url") || "").trim();
  if (!/^https?:\/\//i.test(url)) return fail("链接格式不对", 400);

  let platform: "xiaohongshu" | "douyin" | "bilibili" | "unknown" = "unknown";
  if (/xiaohongshu\.com|xhslink\.com/i.test(url)) platform = "xiaohongshu";
  else if (/douyin\.com|iesdouyin\.com/i.test(url)) platform = "douyin";
  else if (/bilibili\.com|b23\.tv/i.test(url)) platform = "bilibili";

  let html = "";
  let finalUrl = url;
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        "Accept-Language": "zh-CN,zh;q=0.9",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      cache: "no-store",
    });
    finalUrl = res.url || url;
    html = await res.text();
  } catch {
    return fail("抓取失败，请检查链接或换用自定义解析服务");
  }

  const specific = platform === "xiaohongshu"
    ? parseXiaohongshu(html)
    : platform === "douyin"
      ? parseDouyin(html)
      : { title: "", desc: "", images: [] as string[], video: "", author: "" };

  const ogImages = readAllMeta(html, "og:image");
  const ogVideo = readMeta(html, "og:video") || readMeta(html, "og:video:url");
  const title = readMeta(html, "og:title") || readMeta(html, "twitter:title") || specific.title || html.match(/<title[^>]*>([^<]{2,120})<\/title>/i)?.[1]?.trim() || "";
  const desc = readMeta(html, "og:description") || readMeta(html, "description") || specific.desc;
  const author = specific.author || readMeta(html, "og:site_name");
  const images = Array.from(new Set([...specific.images, ...ogImages])).slice(0, 12);
  const video = specific.video || ogVideo;

  if (!title && !desc && images.length === 0 && !video) {
    const blocked = /登录|验证|安全验证|captcha|访问频繁/.test(html.slice(0, 4000));
    return fail(blocked ? "blocked" : "empty");
  }

  return ok({
    platform,
    title: decodeHtml(title),
    desc: decodeHtml(desc),
    author: decodeHtml(author),
    images,
    video,
    sourceUrl: finalUrl,
  });
}
