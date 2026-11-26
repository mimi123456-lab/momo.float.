"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, LoaderCircle, LogOut, Plug, QrCode, RefreshCw, Search } from "lucide-react";

import { useMusicControls } from "@/lib/music-context";
import {
  QqBackendError,
  backendPlaylistSongs,
  backendPlaylists,
  backendSearch,
  backendSongToTrack,
  backendSongUrl,
  checkBackendQqLogin,
  clearQqBackendConfig,
  loadQqBackendConfig,
  saveQqBackendConfig,
  startBackendQqLogin,
  testQqBackend,
  type BackendPlaylist,
  type BackendSong,
  type QqBackendConfig,
} from "@/lib/music-qq-backend";

type Props = {
  onToast: (text: string) => void;
};

function errText(error: unknown): string {
  if (error instanceof QqBackendError) return error.message;
  return error instanceof Error ? error.message : "操作失败";
}

export function QqBackendPanel({ onToast }: Props) {
  const player = useMusicControls();
  const [config, setConfig] = useState<QqBackendConfig | null>(() => loadQqBackendConfig());
  const [draftBase, setDraftBase] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [checking, setChecking] = useState(false);
  const [qrUrl, setQrUrl] = useState("");
  const [qrLoading, setQrLoading] = useState(false);
  const [loginState, setLoginState] = useState("");

  const [playlists, setPlaylists] = useState<BackendPlaylist[]>([]);
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const [activeList, setActiveList] = useState<{ id: string; title: string } | null>(null);
  const [songs, setSongs] = useState<BackendSong[]>([]);
  const [songLoading, setSongLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchSongs, setSearchSongs] = useState<BackendSong[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  const refreshStatus = useCallback(async (cfg: QqBackendConfig) => {
    setChecking(true);
    try {
      const ok = await testQqBackend(cfg);
      setConnected(ok);
      if (ok) {
        setQrUrl("");
        setPlaylistLoading(true);
        const list = await backendPlaylists(cfg);
        setPlaylists(list);
        setPlaylistLoading(false);
      }
    } catch (error) {
      setConnected(false);
      onToast(errText(error));
    } finally {
      setChecking(false);
    }
  }, [onToast]);

  useEffect(() => {
    if (!config) return;
    void refreshStatus(config);
  }, [config, refreshStatus]);

  // 扫码登录轮询
  useEffect(() => {
    if (!config || !qrUrl) return;
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const status = await checkBackendQqLogin(config);
        if (status.connected) {
          setConnected(true);
          setQrUrl("");
          setLoginState("");
          onToast("QQ 音乐已连接");
          const list = await backendPlaylists(config);
          setPlaylists(list);
        } else if (status.state === "error") {
          setLoginState("登录失败，请重新扫码");
        }
      } catch {
        // 轮询失败保持安静，等用户手动刷新
      }
    }, 2500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [config, qrUrl, onToast]);

  const handleConnect = useCallback(async () => {
    const baseUrl = draftBase.trim();
    const accessKey = draftKey.trim();
    if (!baseUrl || !accessKey) {
      setFormError("后端地址和访问密钥都要填");
      return;
    }
    if (!/^https:\/\//i.test(baseUrl)) {
      setFormError("地址必须是 https:// 开头（浏览器会拦截 http）");
      return;
    }
    setFormError(null);
    setConnecting(true);
    const cfg = { baseUrl: baseUrl.replace(/\/+$/, ""), accessKey };
    try {
      const ok = await testQqBackend(cfg);
      if (!ok) {
        setFormError("后端能连上，但还没有登录 QQ 音乐，下面扫码即可");
      }
      saveQqBackendConfig(cfg);
      setConfig(cfg);
      setConnected(ok);
      setDraftKey("");
      if (!ok) void beginQrLogin(cfg);
    } catch (error) {
      setFormError(errText(error));
    } finally {
      setConnecting(false);
    }
  }, [draftBase, draftKey]);

  const beginQrLogin = useCallback(async (cfg: QqBackendConfig) => {
    setQrLoading(true);
    setLoginState("正在向后端索取二维码…");
    try {
      const url = await startBackendQqLogin(cfg);
      setQrUrl(url);
      setLoginState("用手机 QQ 音乐扫码并确认");
    } catch (error) {
      setLoginState(errText(error));
    } finally {
      setQrLoading(false);
    }
  }, []);

  const openPlaylist = useCallback(async (playlist: BackendPlaylist) => {
    if (!config) return;
    setActiveList({ id: playlist.id, title: playlist.title });
    setSongLoading(true);
    setPage(1);
    try {
      const data = await backendPlaylistSongs(config, playlist.id, 1);
      setSongs(data.songs);
      setHasMore(data.hasMore);
    } catch (error) {
      onToast(errText(error));
      setSongs([]);
      setHasMore(false);
    } finally {
      setSongLoading(false);
    }
  }, [config, onToast]);

  const loadMore = useCallback(async () => {
    if (!config || !activeList || songLoading) return;
    const next = page + 1;
    setSongLoading(true);
    try {
      const data = await backendPlaylistSongs(config, activeList.id, next);
      setSongs(prev => [...prev, ...data.songs]);
      setHasMore(data.hasMore);
      setPage(next);
    } catch (error) {
      onToast(errText(error));
    } finally {
      setSongLoading(false);
    }
  }, [activeList, config, onToast, page, songLoading]);

  const handleSearch = useCallback(async () => {
    if (!config) return;
    const keyword = query.trim();
    if (!keyword || searching) return;
    setSearching(true);
    try {
      const result = await backendSearch(config, keyword, 25);
      setSearchSongs(result);
      if (result.length === 0) onToast("后端没搜到这首歌");
    } catch (error) {
      onToast(errText(error));
    } finally {
      setSearching(false);
    }
  }, [config, onToast, query, searching]);

  const playSong = useCallback(async (song: BackendSong) => {
    if (!config || playingId) return;
    setPlayingId(song.mid);
    try {
      const { url } = await backendSongUrl(config, song);
      player.playUrl(url, backendSongToTrack(song));
    } catch (error) {
      onToast(errText(error));
    } finally {
      setPlayingId(null);
    }
  }, [config, onToast, player, playingId]);

  const handleDisconnect = useCallback(() => {
    clearQqBackendConfig();
    setConfig(null);
    setConnected(false);
    setPlaylists([]);
    setSongs([]);
    setSearchSongs([]);
    setQrUrl("");
    setActiveList(null);
    onToast("已断开 QQ 后端");
  }, [onToast]);

  const renderList = (list: BackendSong[], emptyHint: string) => {
    if (list.length === 0) return <div className="msh-empty">{emptyHint}</div>;
    return (
      <div className="msh-songs">
        {list.map((song, index) => (
          <button key={`${song.mid}-${index}`} type="button" className="msh-song" onClick={() => void playSong(song)}>
            <span className="msh-song-index">
              {playingId === song.mid ? <LoaderCircle className="msh-spin" size={14} /> : index + 1}
            </span>
            <span className="msh-song-main">
              <strong>{song.title}{song.vip ? <em className="qb-vip">VIP</em> : null}</strong>
              <small>{song.artist}{song.album ? ` · ${song.album}` : ""}</small>
            </span>
            <span className="msh-song-play">▶</span>
          </button>
        ))}
      </div>
    );
  };

  // 还没配置：引导部署
  if (!config) {
    return (
      <div className="msh-body">
        <div className="qb-setup">
          <div className="qb-setup-head">
            <Plug size={18} />
            <div>
              <strong>连接你自己的 QQ 音乐后端</strong>
              <small>连接后搜索、歌单、播放全部走后端，能播就是真播放</small>
            </div>
          </div>
          <p className="qb-setup-desc">
            需要你先把 QQ 音乐后端部署在一台带 HTTPS 域名的常驻服务器上
            （Python 3.10+，`ACCESS_KEY` 就是下面要填的访问密钥）。
            部署完成后，打开 <code>/api/music/health</code> 看到 <code>{`{"ok":true}`}</code> 即可。
          </p>
          <label className="qb-field">
            <span>后端地址</span>
            <input
              value={draftBase}
              onChange={event => setDraftBase(event.target.value)}
              placeholder="https://music.example.com"
              inputMode="url"
            />
          </label>
          <label className="qb-field">
            <span>访问密钥（ACCESS_KEY）</span>
            <input
              value={draftKey}
              onChange={event => setDraftKey(event.target.value)}
              placeholder="后端环境变量里的那串密钥"
              type="password"
            />
          </label>
          {formError ? <p className="qb-error">{formError}</p> : null}
          <button type="button" className="qb-primary" disabled={connecting} onClick={() => void handleConnect()}>
            {connecting ? <><LoaderCircle size={14} className="msh-spin" /> 正在连接…</> : "保存并连接"}
          </button>
          <p className="msh-note">密钥只存在本机，不会上传到任何第三方；拿到地址和密钥的人可以用你的账号，注意不要外传。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="msh-body">
      <div className="qb-status">
        <span className="qb-status-dot" data-on={connected ? "1" : "0"} />
        <div className="qb-status-main">
          <strong>{connected ? "QQ 音乐已连接" : "后端已连接 · 未登录 QQ"}</strong>
          <small>{config.baseUrl.replace(/^https:\/\//, "")}</small>
        </div>
        <button type="button" className="qb-mini" disabled={checking} onClick={() => void refreshStatus(config)}>
          {checking ? <LoaderCircle size={13} className="msh-spin" /> : <RefreshCw size={13} />}
        </button>
        <button type="button" className="qb-mini" onClick={handleDisconnect} title="断开">
          <LogOut size={13} />
        </button>
      </div>

      {!connected ? (
        <div className="qb-login">
          {qrUrl ? (
            <img src={qrUrl} alt="QQ 音乐登录二维码" className="qb-qr" />
          ) : (
            <div className="qb-qr qb-qr--empty">
              {qrLoading ? <LoaderCircle className="msh-spin" size={22} /> : <QrCode size={26} />}
            </div>
          )}
          <div className="qb-login-copy">
            <strong>扫码登录 QQ 音乐</strong>
            <p>{loginState || "登录后歌单和 VIP 歌曲会使用你账号的权限"}</p>
            <button type="button" className="qb-primary qb-primary--sm" disabled={qrLoading} onClick={() => void beginQrLogin(config)}>
              刷新二维码
            </button>
          </div>
        </div>
      ) : null}

      <form className="msh-search" onSubmit={event => { event.preventDefault(); void handleSearch(); }}>
        <Search size={15} />
        <input
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="通过后端搜索歌曲、歌手"
          aria-label="通过后端搜索"
        />
        <button type="submit" disabled={!query.trim() || searching}>{searching ? "…" : "搜索"}</button>
      </form>

      {searchSongs.length > 0 ? (
        <>
          <div className="msh-section-title">搜索结果</div>
          {renderList(searchSongs, "没有搜到歌")}
        </>
      ) : null}

      {playlists.length > 0 ? (
        <>
          <div className="msh-section-title">我的歌单（来自你的 QQ 账号）</div>
          <div className="qb-playlists">
            {playlists.map(playlist => (
              <button
                key={playlist.id}
                type="button"
                className="qb-playlist"
                data-active={activeList?.id === playlist.id ? "1" : undefined}
                onClick={() => void openPlaylist(playlist)}
              >
                <span className="qb-playlist-cover" style={playlist.cover ? { backgroundImage: `url(${playlist.cover})` } : undefined} />
                <span className="qb-playlist-copy">
                  <strong>{playlist.title}</strong>
                  <small>{playlist.songnum ? `${playlist.songnum} 首` : "歌单"}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        </>
      ) : playlistLoading ? (
        <div className="msh-empty"><LoaderCircle className="msh-spin" size={20} /> 正在读取你的歌单…</div>
      ) : null}

      {activeList ? (
        <>
          <div className="msh-section-title">{activeList.title}</div>
          {songLoading && songs.length === 0
            ? <div className="msh-empty"><LoaderCircle className="msh-spin" size={20} /> 正在加载…</div>
            : renderList(songs, "这个歌单暂时没有歌")}
          {hasMore ? (
            <button type="button" className="qb-more" disabled={songLoading} onClick={() => void loadMore()}>
              {songLoading ? "加载中…" : "加载更多"}
            </button>
          ) : null}
        </>
      ) : null}

      <p className="msh-note">播放地址由你的后端签名生成，前端不再经过任何第三方解析；如果某首歌仍然播不了，通常是版权或 VIP 权限问题。</p>
    </div>
  );
}

export default QqBackendPanel;
