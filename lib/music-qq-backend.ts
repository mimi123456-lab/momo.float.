// QQ 音乐后端连接器（对接 MioWatery 那份 docs/music-backend.md 的接口约定）。
// 只按文档的 HTTP 契约实现，不拷贝对方代码：后端负责签名取播放地址与 QQ 登录态，
// 前端只填「后端地址 + 访问密钥」。
import { kvGet, kvRemove, kvSet, registerKvMigration } from "./kv-db";

export type QqBackendConfig = {
  baseUrl: string;
  accessKey: string;
};

export type BackendSong = {
  mid: string;
  title: string;
  artist: string;
  album: string;
  art: string;
  duration: number;
  mediaMid: string;
  type: number;
  vip: boolean;
};

export type BackendPlaylist = {
  id: string;
  title: string;
  songnum: number;
  cover: string;
};

const QQ_BACKEND_KEY = "ai_phone_qq_backend_v1";
registerKvMigration(QQ_BACKEND_KEY);

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function loadQqBackendConfig(): QqBackendConfig | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = kvGet(QQ_BACKEND_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QqBackendConfig>;
    if (!parsed.baseUrl || !parsed.accessKey) return null;
    return { baseUrl: normalizeBaseUrl(parsed.baseUrl), accessKey: String(parsed.accessKey) };
  } catch {
    return null;
  }
}

export function saveQqBackendConfig(config: QqBackendConfig): void {
  kvSet(QQ_BACKEND_KEY, JSON.stringify({
    baseUrl: normalizeBaseUrl(config.baseUrl),
    accessKey: config.accessKey.trim(),
  }));
}

export function clearQqBackendConfig(): void {
  try { kvRemove(QQ_BACKEND_KEY); } catch { /* ignore */ }
}

export class QqBackendError extends Error {
  detail: string;
  status: number;
  constructor(message: string, status: number, detail = "") {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function backendRequest<T>(
  config: QqBackendConfig,
  path: string,
  options: { method?: "GET" | "POST"; query?: Record<string, string | number>; body?: unknown } = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {})) {
    query.set(key, String(value));
  }
  const qs = query.toString();
  const url = `${config.baseUrl}/api/music/${path}${qs ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "X-Access-Key": config.accessKey,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
    });
  } catch {
    throw new QqBackendError("连不上后端，请检查地址与 HTTPS 证书", 0);
  }
  let payload: unknown = null;
  try { payload = await res.json(); } catch { payload = null; }
  if (!res.ok) {
    const body = (payload ?? {}) as { detail?: unknown; error?: unknown };
    const detail = String(body.detail ?? body.error ?? "");
    if (res.status === 401 && detail === "not_logged_in") {
      throw new QqBackendError("后端还没有登录 QQ 音乐", 401, detail);
    }
    if (res.status === 401) {
      throw new QqBackendError("访问密钥不对，请核对后重填", 401, detail);
    }
    throw new QqBackendError(detail || `后端返回 ${res.status}`, res.status, detail);
  }
  return payload as T;
}

export async function testQqBackend(config: QqBackendConfig): Promise<boolean> {
  const data = await backendRequest<{ connected?: boolean }>(config, "status");
  return Boolean(data?.connected);
}

export async function startBackendQqLogin(config: QqBackendConfig): Promise<string> {
  const data = await backendRequest<{ qr?: string }>(config, "login/start", { method: "POST", body: {} });
  const qr = data?.qr || "";
  if (!qr) throw new QqBackendError("后端没有返回二维码", 502);
  return qr.startsWith("http") ? qr : `${config.baseUrl}${qr.startsWith("/") ? "" : "/"}${qr}`;
}

export async function checkBackendQqLogin(config: QqBackendConfig): Promise<{ connected: boolean; state: string }> {
  const data = await backendRequest<{ state?: string; connected?: boolean }>(config, "login/status");
  return { connected: Boolean(data?.connected) || data?.state === "connected", state: String(data?.state ?? "") };
}

export async function backendSearch(config: QqBackendConfig, keyword: string, num = 25): Promise<BackendSong[]> {
  const data = await backendRequest<{ songs?: BackendSong[] }>(config, "search", { query: { q: keyword, num } });
  return (data?.songs ?? []).filter(song => song.mid);
}

export async function backendPlaylists(config: QqBackendConfig): Promise<BackendPlaylist[]> {
  const data = await backendRequest<{ playlists?: BackendPlaylist[] }>(config, "playlists");
  return (data?.playlists ?? []).filter(item => item.id);
}

export async function backendPlaylistSongs(
  config: QqBackendConfig,
  id: string,
  page = 1,
  num = 30,
): Promise<{ songs: BackendSong[]; hasMore: boolean }> {
  const data = await backendRequest<{ songs?: BackendSong[]; hasMore?: boolean }>(config, "playlist", {
    query: { id, page, num },
  });
  return { songs: (data?.songs ?? []).filter(song => song.mid), hasMore: Boolean(data?.hasMore) };
}

/** 取真实播放地址：优先后端给的 direct 直链，否则拼后端路径。 */
export async function backendSongUrl(
  config: QqBackendConfig,
  song: BackendSong,
): Promise<{ url: string; direct: boolean }> {
  const data = await backendRequest<{ url?: string; direct?: string }>(config, "song", {
    method: "POST",
    body: { mid: song.mid, mediaMid: song.mediaMid, type: song.type },
  });
  const direct = data?.direct || "";
  if (direct) return { url: direct.replace(/^http:\/\//, "https://"), direct: true };
  const relative = data?.url || "";
  if (!relative) throw new QqBackendError("后端没有返回播放地址", 502);
  return {
    url: relative.startsWith("http") ? relative : `${config.baseUrl}${relative.startsWith("/") ? "" : "/"}${relative}`,
    direct: false,
  };
}

export async function backendLyric(
  config: QqBackendConfig,
  mid: string,
): Promise<{ lrc: string; trans: string }> {
  const data = await backendRequest<{ lrc?: string; trans?: string }>(config, "lyric", { query: { mid } });
  return { lrc: String(data?.lrc ?? ""), trans: String(data?.trans ?? "") };
}

export function backendSongToTrack(song: BackendSong) {
  return {
    id: `qqb_${song.mid}`,
    title: song.title,
    artist: song.artist,
    album: song.album,
    duration: song.duration || 0,
    coverUrl: song.art || undefined,
    liked: false,
    addedAt: new Date().toISOString(),
  };
}
