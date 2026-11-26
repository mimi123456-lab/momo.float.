import { NextResponse } from "next/server";

// QQ 音乐 / 汽水音乐（非官方）用到的公开接口代理。
// 说明：QQ 音乐没有公开开放平台，这里代理的是 y.qq.com 网页端自己用的接口，
// 仅用于个人使用；接口随时可能变动，前端全部做了失败兜底。
export const runtime = "nodejs";
export const maxDuration = 20;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const QQ_REFERER = "https://y.qq.com/";

function cors(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function fail(message: string, status = 502) {
  return NextResponse.json({ ok: false, error: message }, { status, headers: cors() });
}

/** QQ 有些接口会带 JSONP 包裹，这里统一裁出 JSON 主体。 */
function extractJson(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function qqGet(url: string, extraHeaders: Record<string, string> = {}) {
  return fetch(url, {
    headers: {
      "User-Agent": UA,
      Referer: QQ_REFERER,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9",
      ...extraHeaders,
    },
    cache: "no-store",
  });
}

function normalizeSong(raw: Record<string, unknown>) {
  const singerRaw = raw.singer;
  const singers = Array.isArray(singerRaw)
    ? singerRaw.map(item => String((item as Record<string, unknown>)?.name ?? "")).filter(Boolean).join("、")
    : String(raw.singername ?? "");
  const albumRaw = raw.album as Record<string, unknown> | undefined;
  const fileRaw = raw.file as Record<string, unknown> | undefined;
  return {
    songmid: String(raw.songmid ?? raw.mid ?? ""),
    name: String(raw.songname ?? raw.name ?? raw.title ?? ""),
    singer: singers || "未知歌手",
    album: String(raw.albumname ?? albumRaw?.name ?? ""),
    albumMid: String(raw.albummid ?? albumRaw?.mid ?? ""),
    mediaMid: String(fileRaw?.media_mid ?? raw.strMediaMid ?? raw.songmid ?? raw.mid ?? ""),
    interval: Number(raw.interval ?? 0) || 0,
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  // /api/music/qq/<...path>
  const route = segments.slice(3).join("/") || "search";

  try {
    if (route === "search") {
      const keywords = (searchParams.get("keywords") || "").trim();
      if (!keywords) return fail("缺少 keywords", 400);
      const limit = Math.min(30, Math.max(1, Number(searchParams.get("limit")) || 12));
      const url =
        `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?format=json&new_json=1&cr=1&p=1&n=${limit}` +
        `&w=${encodeURIComponent(keywords)}`;
      const res = await qqGet(url);
      const data = extractJson(await res.text()) as { data?: { song?: { list?: Record<string, unknown>[] } } } | null;
      const list = data?.data?.song?.list ?? [];
      return NextResponse.json({ ok: true, songs: list.map(normalizeSong).filter(item => item.songmid) }, { headers: cors() });
    }

    if (route === "playlists") {
      const url =
        "https://c.y.qq.com/splcloud/fcgi-bin/fcg_get_diss_by_tag.fcg?picmid=1&rnd=0.5&g_tk=5381&loginUin=0&hostUin=0" +
        "&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0" +
        "&categoryId=10000000&sortId=5&sin=0&ein=29";
      const res = await qqGet(url);
      const data = extractJson(await res.text()) as { data?: { list?: Record<string, unknown>[] } } | null;
      const list = data?.data?.list ?? [];
      return NextResponse.json({
        ok: true,
        playlists: list.map(item => ({
          id: String(item.dissid ?? ""),
          name: String(item.dissname ?? ""),
          cover: String(item.imgurl ?? item.logo ?? ""),
          playCount: Number(item.listennum ?? 0) || 0,
          creator: String((item.creator as Record<string, unknown>)?.name ?? ""),
        })).filter(item => item.id),
      }, { headers: cors() });
    }

    if (route === "playlist") {
      const id = (searchParams.get("id") || "").trim();
      if (!id) return fail("缺少 id", 400);
      const url =
        `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0` +
        `&disstid=${encodeURIComponent(id)}&format=json&g_tk=5381&loginUin=0&hostUin=0` +
        `&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
      const res = await qqGet(url);
      const data = extractJson(await res.text()) as { cdlist?: Array<Record<string, unknown>> } | null;
      const detail = data?.cdlist?.[0];
      const songlist = (detail?.songlist as Record<string, unknown>[] | undefined) ?? [];
      return NextResponse.json({
        ok: true,
        name: String(detail?.dissname ?? ""),
        cover: String(detail?.logo ?? ""),
        desc: String(detail?.desc ?? ""),
        songs: songlist.map(normalizeSong).filter(item => item.songmid),
      }, { headers: cors() });
    }

    if (route === "toplist") {
      const topid = (searchParams.get("id") || "26").trim();
      const url =
        `https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?topid=${encodeURIComponent(topid)}&format=json` +
        `&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0&tpl=3&page=detail&type=top` +
        `&song_begin=0&song_num=30`;
      const res = await qqGet(url);
      const data = extractJson(await res.text()) as {
        topinfo?: Record<string, unknown>;
        songlist?: Array<{ data?: Record<string, unknown> }>;
      } | null;
      const songs = (data?.songlist ?? []).map(entry => normalizeSong(entry.data ?? {})).filter(item => item.songmid);
      return NextResponse.json({
        ok: true,
        name: String(data?.topinfo?.ListName ?? ""),
        songs,
      }, { headers: cors() });
    }

    if (route === "lyrics") {
      const songmid = (searchParams.get("songmid") || "").trim();
      if (!songmid) return fail("缺少 songmid", 400);
      const url =
        `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}` +
        `&format=json&g_tk=5381&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0`;
      const res = await qqGet(url);
      const data = extractJson(await res.text()) as { lyric?: string } | null;
      const lyric = data?.lyric ? Buffer.from(data.lyric, "base64").toString("utf8") : "";
      return NextResponse.json({ ok: true, lyric }, { headers: cors() });
    }

    if (route === "url") {
      // QQ 侧 vkey 需要登录态 + 签名，公开环境大概率失败；失败时前端会走网易云 / iTunes 兜底。
      const mid = (searchParams.get("mid") || "").trim();
      const mediaMid = (searchParams.get("mediaMid") || mid).trim();
      if (!mid) return fail("缺少 mid", 400);
      const payload = {
        req_0: {
          module: "vkey.GetVkeyServer",
          method: "CgiGetVkey",
          param: {
            guid: "10000",
            songmid: [mid],
            songtype: [0],
            uin: "0",
            loginflag: 1,
            platform: "20",
          },
        },
        comm: { uin: 0, format: "json", ct: 24, cv: 0 },
      };
      const res = await qqGet(
        `https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=${encodeURIComponent(JSON.stringify(payload))}`,
      );
      const data = extractJson(await res.text()) as {
        req_0?: { data?: { sip?: string[]; midurlinfo?: Array<{ purl?: string }> } };
      } | null;
      const info = data?.req_0?.data;
      const purl = info?.midurlinfo?.[0]?.purl || "";
      if (!purl) return NextResponse.json({ ok: false, error: "qq_vkey_unavailable" }, { headers: cors() });
      const sip = info?.sip?.[0] || "https://dl.stream.qqmusic.qq.com/";
      return NextResponse.json({ ok: true, url: `${sip}${purl}`, mediaMid }, { headers: cors() });
    }

    if (route === "qr/create") {
      const t = Date.now();
      const res = await fetch(
        `https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=${t}&daid=383&pt_3rd_aid=100497308`,
        { headers: { "User-Agent": UA, Referer: "https://xui.ptlogin2.qq.com/" }, cache: "no-store" },
      );
      const buffer = Buffer.from(await res.arrayBuffer());
      const setCookie = res.headers.get("set-cookie") || "";
      const qrsig = /qrsig=([^;]+)/.exec(setCookie)?.[1] || "";
      if (!buffer.length || !qrsig) return fail("二维码生成失败");
      return NextResponse.json({
        ok: true,
        qrsig,
        image: `data:image/png;base64,${buffer.toString("base64")}`,
      }, { headers: cors() });
    }

    if (route === "qr/check") {
      const qrsig = (searchParams.get("qrsig") || "").trim();
      if (!qrsig) return fail("缺少 qrsig", 400);
      let hash = 0;
      for (let i = 0; i < qrsig.length; i += 1) {
        hash += (hash << 5) + qrsig.charCodeAt(i);
      }
      const ptqrtoken = String(hash & 0x7fffffff);
      const url =
        `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent("https://y.qq.com/")}` +
        `&ptqrtoken=${ptqrtoken}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052` +
        `&action=0-0-${Date.now()}&js_ver=20102616&js_type=1&login_sig=&pt_uistyle=40` +
        `&aid=716027609&daid=383&pt_3rd_aid=100497308&has_onekey=1`;
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Referer: "https://xui.ptlogin2.qq.com/",
          Cookie: `qrsig=${qrsig}`,
        },
        cache: "no-store",
      });
      const text = await res.text();
      const code = /ptuiCB\('(\d+)'/.exec(text)?.[1] ?? "";
      const setCookie = (res.headers.get("set-cookie") || "")
        .split(/,(?=\s*[A-Za-z_]+=)/)
        .map(item => item.split(";")[0].trim())
        .filter(Boolean);
      return NextResponse.json({
        ok: true,
        code, // 66=未扫描 65=已扫描待确认 67=已失效 0=登录成功
        message: (/ptuiCB\('\d+','\d+','[^']*','\d+','([^']*)'/.exec(text)?.[1]) ?? "",
        cookies: setCookie,
      }, { headers: cors() });
    }

    if (route === "itunes") {
      const term = (searchParams.get("term") || "").trim();
      if (!term) return fail("缺少 term", 400);
      const res = await fetch(
        `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&limit=1&country=CN`,
        { headers: { "User-Agent": UA }, cache: "no-store" },
      );
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> } | null;
      const hit = data?.results?.[0];
      return NextResponse.json({
        ok: Boolean(hit?.previewUrl),
        url: String(hit?.previewUrl ?? ""),
        trackName: String(hit?.trackName ?? ""),
        artistName: String(hit?.artistName ?? ""),
      }, { headers: cors() });
    }

    return fail(`未知接口：${route}`, 404);
  } catch (error) {
    return fail(error instanceof Error ? error.message : "代理请求失败");
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: cors() });
}
