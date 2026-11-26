"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, LoaderCircle, LogOut, QrCode, RefreshCw, Search, Sparkles, X } from "lucide-react";

import { useMusicControls } from "@/lib/music-context";
import type { MusicTrack } from "@/lib/music-storage";
import { QqBackendPanel } from "./qq-backend-panel";
import {
  backendSearch,
  backendSongToTrack,
  backendSongUrl,
  loadQqBackendConfig,
} from "@/lib/music-qq-backend";
import {
  SODA_MOODS,
  checkQqQrSession,
  clearQqCookie,
  createQqQrSession,
  loadQqCookie,
  loadQqPlaylist,
  loadQqPlaylists,
  loadQqToplist,
  loadSodaMix,
  resolveQqPlaySource,
  saveQqCookie,
  searchQqSongs,
  type QqPlaylist,
  type QqSong,
} from "@/lib/music-qq";

type HubTab = "qq" | "backend" | "soda";

type Props = {
  onClose: () => void;
  onToast?: (text: string) => void;
};

function coverOf(song: QqSong): string | undefined {
  return song.albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${song.albumMid}.jpg` : undefined;
}

function toTrack(song: QqSong): MusicTrack {
  return {
    id: `qq_${song.songmid}`,
    title: song.name,
    artist: song.singer,
    album: song.album,
    duration: song.interval || 0,
    coverUrl: coverOf(song),
    liked: false,
    addedAt: new Date().toISOString(),
  };
}

function formatCount(value: number): string {
  if (!value) return "";
  if (value >= 100000000) return `${(value / 100000000).toFixed(1)}亿`;
  if (value >= 10000) return `${Math.round(value / 10000)}万`;
  return String(value);
}

export function MusicSourceHub({ onClose, onToast }: Props) {
  const player = useMusicControls();
  const [tab, setTab] = useState<HubTab>("qq");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [qqSongs, setQqSongs] = useState<QqSong[]>([]);
  const [listTitle, setListTitle] = useState("推荐歌单");
  const [playlists, setPlaylists] = useState<QqPlaylist[]>([]);
  const [playlistsLoading, setPlaylistsLoading] = useState(true);
  const [listLoading, setListLoading] = useState(false);
  const [playlistUrl, setPlaylistUrl] = useState("");
  const [importingUrl, setImportingUrl] = useState(false);

  const [sodaMoodId, setSodaMoodId] = useState<string>(SODA_MOODS[0].id);
  const [sodaSongs, setSodaSongs] = useState<QqSong[]>([]);
  const [sodaLoading, setSodaLoading] = useState(true);

  const [loggedIn, setLoggedIn] = useState(() => Boolean(loadQqCookie()));
  const [qrOpen, setQrOpen] = useState(false);
  const [qrImage, setQrImage] = useState("");
  const [qrSig, setQrSig] = useState("");
  const [qrStatus, setQrStatus] = useState("正在生成二维码…");
  const [qrLoading, setQrLoading] = useState(false);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2600);
    onToast?.(text);
  }, [onToast]);

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
  }, []);

  // QQ 歌单（无需登录）
  useEffect(() => {
    let cancelled = false;
    setPlaylistsLoading(true);
    void loadQqPlaylists().then(list => {
      if (cancelled) return;
      setPlaylists(list);
      setPlaylistsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const refreshSoda = useCallback(async (moodId: string) => {
    setSodaLoading(true);
    setSodaMoodId(moodId);
    const mix = await loadSodaMix(moodId);
    setSodaSongs(mix.songs);
    setSodaLoading(false);
  }, []);

  useEffect(() => {
    void refreshSoda(SODA_MOODS[Math.floor(Math.random() * SODA_MOODS.length)].id);
  }, [refreshSoda]);

  const handleSearch = useCallback(async () => {
    const keyword = query.trim();
    if (!keyword || searching) return;
    setSearching(true);
    setListLoading(true);
    const songs = await searchQqSongs(keyword, 20);
    setQqSongs(songs);
    setListTitle(`搜索：${keyword}`);
    setListLoading(false);
    setSearching(false);
    if (songs.length === 0) showNotice("没有搜到结果，换个关键词试试");
  }, [query, searching, showNotice]);

  const openPlaylist = useCallback(async (playlist: QqPlaylist) => {
    setListLoading(true);
    setListTitle(playlist.name || "歌单");
    const detail = await loadQqPlaylist(playlist.id);
    setQqSongs(detail?.songs ?? []);
    setListLoading(false);
  }, []);

  const openToplist = useCallback(async (topid: string, label: string) => {
    setListLoading(true);
    setListTitle(label);
    const detail = await loadQqToplist(topid);
    setQqSongs(detail?.songs ?? []);
    setListLoading(false);
    if (!detail?.songs.length) showNotice("榜单暂时取不到，稍后再试");
  }, [showNotice]);

  const importPlaylistUrl = useCallback(async () => {
    const raw = playlistUrl.trim();
    if (!raw || importingUrl) return;
    // 支持 music.163 无法处理，只解析 QQ 歌单链接里的 disstid / id
    const match = raw.match(/(?:disstid|\/playlist\/)(\d{5,})/) || raw.match(/^(\d{5,})$/);
    const id = match?.[1];
    if (!id) {
      showNotice("没识别到歌单 id，请粘贴 QQ 音乐歌单链接");
      return;
    }
    setImportingUrl(true);
    setListLoading(true);
    const detail = await loadQqPlaylist(id);
    setImportingUrl(false);
    setListLoading(false);
    if (!detail || detail.songs.length === 0) {
      showNotice("这个歌单打不开，可能不是公开歌单");
      return;
    }
    setListTitle(detail.name || "我的歌单");
    setQqSongs(detail.songs);
    setPlaylistUrl("");
    showNotice(`已载入 ${detail.songs.length} 首`);
  }, [importingUrl, playlistUrl, showNotice]);

  const playSong = useCallback(async (song: QqSong) => {
    if (busyId) return;
    setBusyId(song.songmid);
    showNotice(`正在准备播放：${song.name}`);

    // 配了 QQ 后端就优先走真实音源，拿不到再退回三级兜底
    const backend = loadQqBackendConfig();
    if (backend) {
      try {
        const hits = await backendSearch(backend, `${song.name} ${song.singer}`.trim(), 5);
        const hit = hits.find(item => item.title.includes(song.name) || song.name.includes(item.title)) || hits[0];
        if (hit) {
          const { url } = await backendSongUrl(backend, hit);
          player.playUrl(url, backendSongToTrack(hit));
          setBusyId(null);
          return;
        }
      } catch {
        // 后端异常时静默回落到公开接口
      }
    }

    const source = await resolveQqPlaySource(song);
    setBusyId(null);
    if (!source.url) {
      showNotice(source.note || "这首歌暂时播放不了");
      return;
    }
    player.playUrl(source.url, toTrack(song));
    if (source.note) showNotice(source.note);
    else if (source.via === "netease") showNotice("QQ 音源受限，已自动切到网易云同名音频");
  }, [busyId, player, showNotice]);

  const startQrLogin = useCallback(async () => {
    setQrLoading(true);
    setQrStatus("正在生成二维码…");
    const session = await createQqQrSession();
    setQrLoading(false);
    if (!session) {
      setQrStatus("二维码生成失败，请检查网络后重试");
      return;
    }
    setQrImage(session.image);
    setQrSig(session.qrsig);
    setQrStatus("请用 QQ 扫码登录");
  }, []);

  // ── 扫码登录轮询 ──
  useEffect(() => {
    if (!qrOpen || !qrSig) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      const status = await checkQqQrSession(qrSig);
      if (stopped || !status) return;
      if (status.code === "65") setQrStatus("已扫描，请在手机上确认登录");
      else if (status.code === "67") {
        setQrStatus("二维码已失效，正在刷新…");
        void startQrLogin();
      } else if (status.code === "0") {
        const cookie = status.cookies.join("; ");
        if (cookie) saveQqCookie(cookie);
        setLoggedIn(true);
        setQrOpen(false);
        setQrStatus("");
        showNotice(cookie ? "已登录 QQ 音乐" : "登录成功，但没拿到可用登录态");
      }
    }, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [qrOpen, qrSig, startQrLogin, showNotice]);

  const openQr = useCallback(() => {
    setQrOpen(true);
    void startQrLogin();
  }, [startQrLogin]);

  const sodaMood = useMemo(() => SODA_MOODS.find(item => item.id === sodaMoodId) || SODA_MOODS[0], [sodaMoodId]);

  const renderSongList = (songs: QqSong[], emptyHint: string) => {
    if (listLoading && tab === "qq") {
      return <div className="msh-empty"><LoaderCircle className="msh-spin" size={22} /> 正在加载…</div>;
    }
    if (songs.length === 0) return <div className="msh-empty">{emptyHint}</div>;
    return (
      <div className="msh-songs">
        {songs.map((song, index) => (
          <button
            key={`${song.songmid}-${index}`}
            type="button"
            className="msh-song"
            onClick={() => void playSong(song)}
          >
            <span className="msh-song-index">{busyId === song.songmid ? <LoaderCircle className="msh-spin" size={14} /> : index + 1}</span>
            <span className="msh-song-main">
              <strong>{song.name}</strong>
              <small>{song.singer}{song.album ? ` · ${song.album}` : ""}</small>
            </span>
            <span className="msh-song-play">▶</span>
          </button>
        ))}
      </div>
    );
  };

  return (
    <div className="msh-root">
      <header className="msh-header">
        <button type="button" className="msh-icon-btn" onClick={onClose} aria-label="返回">
          <ChevronLeft size={22} />
        </button>
        <div className="msh-title">
          <strong>音源中心</strong>
          <small>QQ音乐 · 汽水风格</small>
        </div>
        {tab === "qq" ? (
          loggedIn ? (
            <button
              type="button"
              className="msh-login-btn"
              onClick={() => { clearQqCookie(); setLoggedIn(false); showNotice("已退出 QQ 音乐登录"); }}
            >
              <LogOut size={13} /> 退出
            </button>
          ) : (
            <button type="button" className="msh-login-btn" onClick={openQr}>
              <QrCode size={14} /> 扫码登录
            </button>
          )
        ) : <span className="msh-header-holder" />}
      </header>

      <div className="msh-tabs">
        <button type="button" data-active={tab === "qq" ? "1" : undefined} onClick={() => setTab("qq")}>QQ音乐</button>
        <button type="button" data-active={tab === "backend" ? "1" : undefined} onClick={() => setTab("backend")}>我的QQ</button>
        <button type="button" data-active={tab === "soda" ? "1" : undefined} onClick={() => setTab("soda")}>汽水音乐</button>
      </div>

      {tab === "backend" ? (
        <QqBackendPanel onToast={showNotice} />
      ) : tab === "qq" ? (
        <div className="msh-body">
          <form
            className="msh-search"
            onSubmit={event => { event.preventDefault(); void handleSearch(); }}
          >
            <Search size={15} />
            <input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="搜索歌曲、歌手"
              aria-label="搜索 QQ 音乐"
            />
            <button type="submit" disabled={!query.trim() || searching}>
              {searching ? "…" : "搜索"}
            </button>
          </form>

          <div className="msh-quick">
            <button type="button" onClick={() => void openToplist("26", "热歌榜")}>热歌榜</button>
            <button type="button" onClick={() => void openToplist("4", "新歌榜")}>新歌榜</button>
            <button type="button" onClick={() => void openToplist("27", "飙升榜")}>飙升榜</button>
          </div>

          <div className="msh-import">
            <input
              value={playlistUrl}
              onChange={event => setPlaylistUrl(event.target.value)}
              placeholder="粘贴 QQ 音乐歌单链接，载入自己的歌单"
            />
            <button type="button" disabled={!playlistUrl.trim() || importingUrl} onClick={() => void importPlaylistUrl()}>
              {importingUrl ? "载入中…" : "载入"}
            </button>
          </div>

          {playlists.length > 0 && qqSongs.length === 0 ? (
            <>
              <div className="msh-section-title">随便逛逛</div>
              <div className="msh-playlists">
                {playlistsLoading
                  ? <div className="msh-empty"><LoaderCircle className="msh-spin" size={20} /></div>
                  : playlists.slice(0, 12).map(playlist => (
                    <button key={playlist.id} type="button" className="msh-playlist" onClick={() => void openPlaylist(playlist)}>
                      <span className="msh-playlist-cover" style={{ backgroundImage: `url(${playlist.cover})` }} />
                      <span className="msh-playlist-name">{playlist.name}</span>
                      <span className="msh-playlist-meta">{formatCount(playlist.playCount)}{playlist.creator ? ` · ${playlist.creator}` : ""}</span>
                    </button>
                  ))}
              </div>
            </>
          ) : null}

          {qqSongs.length > 0 || listLoading ? (
            <>
              <div className="msh-section-title">{listTitle}</div>
              {renderSongList(qqSongs, "这个列表还没有歌")}
            </>
          ) : null}

          <p className="msh-note">曲库来自 QQ 音乐网页端公开接口；在「我的QQ」里配好后端后，这里播放会优先用你账号的真实音源，否则依次尝试 QQ 音源、网易云同名歌曲、iTunes 试听。</p>
        </div>
      ) : (
        <div className="msh-body msh-body--soda">
          <div className="msh-soda-hero" style={{ background: sodaMood.gradient }}>
            <span className="msh-soda-badge"><Sparkles size={11} /> 非官方风格页</span>
            <strong>{sodaMood.title}</strong>
            <p>{sodaMood.subtitle}</p>
            <button type="button" className="msh-soda-shuffle" onClick={() => void refreshSoda(SODA_MOODS[Math.floor(Math.random() * SODA_MOODS.length)].id)}>
              <RefreshCw size={13} className={sodaLoading ? "msh-spin" : ""} /> 换一批
            </button>
          </div>

          <div className="msh-moods">
            {SODA_MOODS.map(mood => (
              <button
                key={mood.id}
                type="button"
                data-active={mood.id === sodaMoodId ? "1" : undefined}
                onClick={() => void refreshSoda(mood.id)}
              >
                {mood.title}
              </button>
            ))}
          </div>

          {sodaLoading
            ? <div className="msh-empty"><LoaderCircle className="msh-spin" size={22} /> 正在为你挑歌…</div>
            : renderSongList(sodaSongs, "这一批没取到歌，换一批试试")}

          <p className="msh-note">字节没有开放汽水音乐的公开接口，也没有可扫码的登录方式；这里是按汽水风格做的随机歌单页，曲目来自 QQ 音乐目录，不是官方客户端。</p>
        </div>
      )}

      {notice ? <div className="msh-toast">{notice}</div> : null}

      {qrOpen ? (
        <div className="msh-qr-mask" role="dialog" aria-label="QQ 扫码登录" onClick={() => setQrOpen(false)}>
          <div className="msh-qr" onClick={event => event.stopPropagation()}>
            <button type="button" className="msh-qr-close" onClick={() => setQrOpen(false)} aria-label="关闭"><X size={18} /></button>
            <strong>QQ 扫码登录</strong>
            <div className="msh-qr-frame">
              {qrLoading || !qrImage
                ? <LoaderCircle className="msh-spin" size={26} />
                : <img src={qrImage} alt="QQ 登录二维码" />}
            </div>
            <p>{qrStatus}</p>
            <button type="button" className="msh-qr-refresh" onClick={() => void startQrLogin()}>
              <RefreshCw size={13} /> 刷新二维码
            </button>
            <small>扫码后登录态只保存在本机；个人歌单可以直接用上面的「粘贴歌单链接」载入。</small>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default MusicSourceHub;
