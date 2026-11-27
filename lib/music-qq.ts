// QQ 音乐 / 汽水（非官方）数据源。
// 说明：QQ 音乐没有公开开放平台，这里通过站内代理访问 y.qq.com 网页端自用接口；
// 播放地址依次尝试 QQ vkey → 网易云同名歌曲 → iTunes 试听，全部失败时如实提示。

import { kvGet, kvSet, kvRemove, registerKvMigration } from "./kv-db";
import { getNeteasePlayInfo, searchNetease } from "./music-service";
import { gdSongUrl, resolveGdPlaySource } from "./gd-music";

export type QqSong = {
  songmid: string;
  name: string;
  singer: string;
  album: string;
  albumMid: string;
  mediaMid: string;
  interval: number;
};

export type QqPlaylist = {
  id: string;
  name: string;
  cover: string;
  playCount: number;
  creator: string;
};

export type QqPlaySource = {
  url: string;
  via: "qq" | "netease" | "gd" | "itunes" | "none";
  note?: string;
};

const QQ_COOKIE_KEY = "ai_phone_qq_music_cookie_v1";
registerKvMigration(QQ_COOKIE_KEY);

export function saveQqCookie(cookie: string): void {
  try { kvSet(QQ_COOKIE_KEY, cookie); } catch { /* ignore */ }
}

export function loadQqCookie(): string {
  if (typeof window === "undefined") return "";
  try { return kvGet(QQ_COOKIE_KEY) || ""; } catch { return ""; }
}

export function clearQqCookie(): void {
  try { kvRemove(QQ_COOKIE_KEY); } catch { /* ignore */ }
}

function buildQs(params: Record<string, string | number>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== "" && value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function qqApi<T>(path: string, params: Record<string, string | number> = {}): Promise<T | null> {
  try {
    const qs = buildQs(params);
    const res = await fetch(`/api/music/qq/${path}${qs ? `?${qs}` : ""}`, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

export async function searchQqSongs(keywords: string, limit = 12): Promise<QqSong[]> {
  const keyword = keywords.trim();
  if (!keyword) return [];
  const data = await qqApi<{ ok: boolean; songs: QqSong[] }>("search", { keywords: keyword, limit });
  return data?.ok ? data.songs : [];
}

export async function loadQqPlaylists(): Promise<QqPlaylist[]> {
  const data = await qqApi<{ ok: boolean; playlists: QqPlaylist[] }>("playlists");
  return data?.ok ? data.playlists.filter(item => item.cover) : [];
}

export async function loadQqPlaylist(id: string): Promise<{ name: string; cover: string; desc: string; songs: QqSong[] } | null> {
  const data = await qqApi<{ ok: boolean; name: string; cover: string; desc: string; songs: QqSong[] }>("playlist", { id });
  return data?.ok ? data : null;
}

export async function loadQqToplist(id: string): Promise<{ name: string; songs: QqSong[] } | null> {
  const data = await qqApi<{ ok: boolean; name: string; songs: QqSong[] }>("toplist", { id });
  return data?.ok ? data : null;
}

export async function loadQqLyrics(songmid: string): Promise<string> {
  const data = await qqApi<{ ok: boolean; lyric: string }>("lyrics", { songmid });
  return data?.ok ? data.lyric : "";
}

/** 四级兜底取播放地址：免 Cookie 直连 → QQ vkey → 网易云同名 → 免 Cookie 同名 → iTunes 试听。 */
export async function resolveQqPlaySource(song: QqSong): Promise<QqPlaySource> {
  // 免 Cookie 音源列表里的歌，songmid 前缀是 gd:，直接用网易云 id 取真实地址
  if (song.songmid.startsWith("gd:")) {
    const url = await gdSongUrl(song.mediaMid || song.songmid.slice(3));
    if (url) return { url, via: "gd" };
  }

  const direct = await qqApi<{ ok: boolean; url: string }>("url", { mid: song.songmid, mediaMid: song.mediaMid });
  if (direct?.ok && direct.url) {
    return { url: direct.url.replace(/^http:\/\//, "https://"), via: "qq" };
  }

  try {
    const results = await searchNetease(`${song.name} ${song.singer}`, 3);
    for (const item of results) {
      const info = await getNeteasePlayInfo(item.id);
      if (info?.url) return { url: info.url, via: "netease" };
    }
  } catch { /* 继续兜底 */ }

  try {
    const gd = await resolveGdPlaySource(song.name, song.singer);
    if (gd?.url) {
      return { url: gd.url, via: "gd", note: "已用免 Cookie 公开音源播放（第三方试听接口）" };
    }
  } catch { /* 继续兜底 */ }

  const itunes = await qqApi<{ ok: boolean; url: string }>("itunes", { term: `${song.name} ${song.singer}` });
  if (itunes?.ok && itunes.url) {
    return { url: itunes.url, via: "itunes", note: "QQ 与网易云均无版权，当前为 iTunes 30 秒试听" };
  }

  return { url: "", via: "none", note: "暂时找不到可播放的音频（版权或接口限制）" };
}

// ── 扫码登录 ─────────────────────────────────────────────

export type QqQrSession = { qrsig: string; image: string; createdAt: number };

export async function createQqQrSession(): Promise<QqQrSession | null> {
  const data = await qqApi<{ ok: boolean; qrsig: string; image: string }>("qr/create");
  if (!data?.ok || !data.qrsig) return null;
  return { qrsig: data.qrsig, image: data.image, createdAt: Date.now() };
}

export type QqQrStatus = {
  code: string; // 66 未扫描 / 65 已扫描待确认 / 67 已失效 / 0 登录成功
  message: string;
  cookies: string[];
};

export async function checkQqQrSession(qrsig: string): Promise<QqQrStatus | null> {
  const data = await qqApi<QqQrStatus & { ok: boolean }>("qr/check", { qrsig });
  if (!data?.ok) return null;
  return { code: data.code, message: data.message, cookies: data.cookies || [] };
}

// ── 汽水音乐（非官方风格主页）──────────────────────────────
// 字节没有公开 API，也无法真正扫码登录；这里只做风格化的随机歌单页，
// 曲目通过"汽水精选"关键词走 QQ 音乐目录检索，并在界面上明确标注非官方。

export type SodaMood = {
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  gradient: string;
};

export const SODA_MOODS: SodaMood[] = [
  {
    id: "late-night",
    title: "深夜放空",
    subtitle: "凌晨一点的房间，只留一盏灯",
    keywords: ["深夜 治愈", "city pop", "慢摇"],
    gradient: "linear-gradient(150deg,#1a1c24,#2a2130 55%,#12141a)",
  },
  {
    id: "commute",
    title: "通勤补给",
    subtitle: "地铁摇晃的时候，耳机里要有点力气",
    keywords: ["通勤 歌单", "轻快 流行", "节奏感"],
    gradient: "linear-gradient(150deg,#22303a,#1a3a44 55%,#101820)",
  },
  {
    id: "rainy",
    title: "下雨天",
    subtitle: "雨点落在窗上，适合把情绪摊开",
    keywords: ["雨天 情歌", "民谣 安静", "雨声 氛围"],
    gradient: "linear-gradient(150deg,#1c2530,#243544 55%,#0f141b)",
  },
  {
    id: "focus",
    title: "专注时刻",
    subtitle: "不打扰的纯音乐，把世界调成静音",
    keywords: ["纯音乐 学习", "钢琴 轻音乐", "lofi"],
    gradient: "linear-gradient(150deg,#1b2320,#22332b 55%,#0e1512)",
  },
  {
    id: "weekend",
    title: "周末醒来",
    subtitle: "窗帘缝里的光，和一点慵懒",
    keywords: ["周末 慵懒", "独立音乐", "chill"],
    gradient: "linear-gradient(150deg,#2a2118,#3a2c1d 55%,#171009)",
  },
  {
    id: "heartbeat",
    title: "心跳加速",
    subtitle: "想把音量调大一点的那种",
    keywords: ["热血 摇滚", "电子 舞曲", "高燃"],
    gradient: "linear-gradient(150deg,#2c1620,#3d1a2a 55%,#160a10)",
  },
];

/** 汽水页的随机歌单：随机抽一个心情，再用它的关键词去 QQ 目录取歌。 */
export async function loadSodaMix(moodId?: string): Promise<{ mood: SodaMood; songs: QqSong[] }> {
  const mood = SODA_MOODS.find(item => item.id === moodId)
    || SODA_MOODS[Math.floor(Math.random() * SODA_MOODS.length)];
  const buckets = await Promise.all(mood.keywords.map(keyword => searchQqSongs(keyword, 6)));
  const merged: QqSong[] = [];
  const seen = new Set<string>();
  for (const bucket of buckets) {
    for (const song of bucket) {
      if (seen.has(song.songmid)) continue;
      seen.add(song.songmid);
      merged.push(song);
    }
  }
  // 打散顺序，让每次进入都有点不一样
  for (let i = merged.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [merged[i], merged[j]] = [merged[j], merged[i]];
  }
  return { mood, songs: merged.slice(0, 24) };
}
