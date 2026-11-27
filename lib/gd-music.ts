// 免 Cookie 公开音源：GD 音乐台（music-api.gdstudio.xyz）。
// 这是第三方公开试听接口，不需要登录也不需要自建后端；对方限制了请求频率，
// 所以这里做了内存缓存和最小间隔节流，失败时一律返回空，由上层决定兜底。

const GD_BASE = "https://music-api.gdstudio.xyz/api.php";
const GD_PIC_BASE = "https://music-api.gdstudio.xyz/api.php";
const MIN_INTERVAL_MS = 400;

export type GdSong = {
  id: string;
  name: string;
  singer: string;
  album: string;
  picId: string;
  urlId: string;
  lyricId: string;
};

const memoryCache = new Map<string, unknown>();
let lastRequestAt = 0;

function buildQuery(params: Record<string, string | number>): string {
  return Object.entries(params)
    .filter(([, value]) => value !== "" && value !== undefined && value !== null)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function gdRequest<T>(params: Record<string, string | number>): Promise<T | null> {
  const qs = buildQuery(params);
  if (memoryCache.has(qs)) return memoryCache.get(qs) as T;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastRequestAt));
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  try {
    const res = await fetch(`${GD_BASE}?${qs}`, { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json() as T;
    memoryCache.set(qs, data);
    return data;
  } catch {
    return null;
  }
}

type GdSearchItem = {
  id?: string | number;
  name?: string;
  artist?: string[];
  album?: string;
  pic_id?: string | number;
  url_id?: string | number;
  lyric_id?: string | number;
};

function toGdSong(item: GdSearchItem): GdSong {
  const id = String(item.id ?? item.url_id ?? "");
  return {
    id,
    name: item.name || "未知歌曲",
    singer: (item.artist ?? []).filter(Boolean).join("/") || "未知歌手",
    album: item.album || "",
    picId: String(item.pic_id ?? ""),
    urlId: String(item.url_id ?? id),
    lyricId: String(item.lyric_id ?? id),
  };
}

export async function searchGdSongs(keywords: string, count = 20): Promise<GdSong[]> {
  const keyword = keywords.trim();
  if (!keyword) return [];
  const data = await gdRequest<GdSearchItem[] | { error?: string }>({
    types: "search",
    source: "netease",
    name: keyword,
    count,
    pages: 1,
  });
  if (!Array.isArray(data)) return [];
  return data.map(toGdSong).filter(song => song.urlId);
}

export async function gdSongUrl(songId: string, br = 320): Promise<string> {
  if (!songId) return "";
  const data = await gdRequest<{ url?: string } | { error?: string }>({
    types: "url",
    source: "netease",
    id: songId,
    br,
  });
  const url = (data as { url?: string } | null)?.url;
  return typeof url === "string" ? url.replace(/^http:\/\//, "https://") : "";
}

export function gdPicUrl(picId: string, size = 300): string {
  if (!picId) return "";
  return `${GD_PIC_BASE}?types=pic&source=netease&id=${encodeURIComponent(picId)}&size=${size}`;
}

export async function gdLyric(songId: string): Promise<string> {
  const data = await gdRequest<{ lyric?: string }>({ types: "lyric", source: "netease", id: songId });
  return typeof data?.lyric === "string" ? data.lyric : "";
}

type GdPlaylistTrack = {
  id?: string | number;
  name?: string;
  ar?: Array<{ name?: string }>;
  al?: { name?: string; pic_str?: string };
};

/** 网易云公开歌单（热歌榜 3778678、新歌榜 3779629、飙升榜 19723756 等）。 */
export async function loadGdPlaylist(playlistId: string): Promise<GdSong[]> {
  const data = await gdRequest<{ playlist?: { tracks?: GdPlaylistTrack[] } }>({
    types: "playlist",
    source: "netease",
    id: playlistId,
  });
  const tracks = data?.playlist?.tracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.map(track => ({
    id: String(track.id ?? ""),
    name: track.name || "未知歌曲",
    singer: (track.ar ?? []).map(item => item.name).filter(Boolean).join("/") || "未知歌手",
    album: track.al?.name || "",
    picId: String(track.al?.pic_str ?? ""),
    urlId: String(track.id ?? ""),
    lyricId: String(track.id ?? ""),
  })).filter(song => song.urlId);
}

/** 按歌名+歌手在免 Cookie 音源里找可播放地址，供 QQ/汽水列表兜底。 */
export async function resolveGdPlaySource(
  name: string,
  singer: string,
): Promise<{ url: string; title: string; singer: string; cover?: string } | null> {
  const hits = await searchGdSongs(`${name} ${singer}`.trim(), 5);
  for (const hit of hits.slice(0, 3)) {
    const url = await gdSongUrl(hit.urlId);
    if (url) {
      return { url, title: hit.name, singer: hit.singer, cover: gdPicUrl(hit.picId) || undefined };
    }
  }
  return null;
}
