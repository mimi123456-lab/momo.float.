"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { ChatPageHeader } from "@/components/chat/chat-page-header";
import { ConfirmDialog } from "@/components/ui";
import { getChatImageFromIndexedDB } from "@/lib/chat-asset-storage";
import {
  ALBUM_UPDATED_EVENT,
  addAlbumPhotoFromFile,
  deleteAlbumPhotos,
  loadAlbumPhotos,
  type AlbumPhoto,
} from "@/lib/album-storage";

type AlbumAppProps = {
  onClose: () => void;
};

function formatDayKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "更早";
  const now = new Date();
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays < 7) return `${diffDays} 天前`;
  const sameYear = date.getFullYear() === now.getFullYear();
  return sameYear
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月`;
}

function formatExactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AlbumApp({ onClose }: AlbumAppProps) {
  const [photos, setPhotos] = useState<AlbumPhoto[]>([]);
  const [sources, setSources] = useState<Record<string, string>>({});
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AlbumPhoto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => setNotice(null), 2200);
  }, []);

  useEffect(() => () => {
    if (noticeTimerRef.current) window.clearTimeout(noticeTimerRef.current);
  }, []);

  const refresh = useCallback(() => {
    setPhotos(loadAlbumPhotos());
  }, []);

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener(ALBUM_UPDATED_EVENT, handler);
    return () => window.removeEventListener(ALBUM_UPDATED_EVENT, handler);
  }, [refresh]);

  // 资产图按需取出来，已经取过的直接跳过，避免重复读 IndexedDB。
  useEffect(() => {
    let cancelled = false;
    const missing = photos.filter(photo => !sources[photo.assetId]);
    if (missing.length === 0) return () => { cancelled = true; };
    void Promise.all(
      missing.map(async photo => {
        const url = await getChatImageFromIndexedDB(photo.assetId);
        return url ? ([photo.assetId, url] as const) : null;
      })
    ).then(entries => {
      if (cancelled) return;
      const valid = entries.filter((entry): entry is readonly [string, string] => Boolean(entry));
      if (valid.length === 0) return;
      setSources(prev => {
        const next = { ...prev };
        for (const [assetId, url] of valid) next[assetId] = url;
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [photos, sources]);

  const groups = useMemo(() => {
    const map = new Map<string, AlbumPhoto[]>();
    for (const photo of photos) {
      const key = formatDayKey(photo.createdAt);
      const list = map.get(key) ?? [];
      list.push(photo);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [photos]);

  const handlePickFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter(file => file.type.startsWith("image/"));
    if (images.length === 0) {
      showNotice("只能上传图片");
      return;
    }
    setImporting(true);
    let ok = 0;
    let failed = 0;
    for (const file of images) {
      try {
        await addAlbumPhotoFromFile(file);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setImporting(false);
    refresh();
    showNotice(failed > 0 ? `已添加 ${ok} 张，${failed} 张失败` : `已添加 ${ok} 张照片`);
  }, [refresh, showNotice]);

  const viewerPhoto = viewerIndex != null ? photos[viewerIndex] : null;

  const goPrev = useCallback(() => {
    setViewerIndex(prev => (prev == null ? prev : Math.max(0, prev - 1)));
  }, []);
  const goNext = useCallback(() => {
    setViewerIndex(prev => (prev == null ? prev : Math.min(photos.length - 1, prev + 1)));
  }, [photos.length]);

  const handleDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    const next = await deleteAlbumPhotos([target.id]);
    setPhotos(next);
    setViewerIndex(null);
    showNotice("已删除照片");
  }, [pendingDelete, showNotice]);

  const latest = photos[0];

  return (
    <section className="album-app">
      <ChatPageHeader
        title="相册"
        left={<button className="page-header-btn" type="button" onClick={onClose} aria-label="返回"><ChevronLeft size={23} /></button>}
        right={
          <button
            className="page-header-btn album-add-btn"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            aria-label="添加照片"
          >
            {importing ? <LoaderCircle size={20} className="album-spin" /> : <Plus size={22} />}
          </button>
        }
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={event => {
          void handlePickFiles(event.target.files);
          event.target.value = "";
        }}
      />

      <main className="album-main">
        {latest && (
          <div className="album-hero">
            <div className="album-hero-cover">
              {sources[latest.assetId]
                ? <img src={sources[latest.assetId]} alt="最近的一张照片" />
                : <span className="album-hero-skeleton" />}
              <span className="album-hero-badge"><Sparkles size={11} /> 最近</span>
            </div>
            <div className="album-hero-copy">
              <strong>{photos.length} 张照片</strong>
              <small>{latest.caption || "今天的记忆已收好"}</small>
              <small className="album-hero-time">{formatExactTime(latest.createdAt)}</small>
            </div>
          </div>
        )}

        {photos.length === 0 ? (
          <button type="button" className="album-empty" onClick={() => fileInputRef.current?.click()}>
            <ImagePlus size={40} />
            <strong>相册还是空的</strong>
            <span>点一下，把喜欢的照片放进来</span>
            <em>{importing ? "正在添加…" : "支持一次选择多张"}</em>
          </button>
        ) : (
          groups.map(([day, list]) => (
            <section className="album-day" key={day}>
              <header className="album-day-head">
                <span>{day}</span>
                <small>{list.length} 张</small>
              </header>
              <div className="album-grid">
                {list.map(photo => {
                  const index = photos.findIndex(item => item.id === photo.id);
                  return (
                    <button
                      key={photo.id}
                      type="button"
                      className="album-thumb"
                      onClick={() => setViewerIndex(index)}
                    >
                      {sources[photo.assetId]
                        ? <img src={sources[photo.assetId]} alt={photo.caption || "照片"} loading="lazy" />
                        : <span className="album-thumb-skeleton" />}
                      {photo.caption && <span className="album-thumb-caption">{photo.caption}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </main>

      {viewerPhoto && (
        <div className="album-viewer" role="dialog" aria-label="查看照片">
          <div className="album-viewer-top">
            <button type="button" onClick={() => setViewerIndex(null)} aria-label="关闭"><X size={22} /></button>
            <span>{formatExactTime(viewerPhoto.createdAt)}</span>
            <button type="button" onClick={() => setPendingDelete(viewerPhoto)} aria-label="删除照片"><Trash2 size={20} /></button>
          </div>
          <div className="album-viewer-stage">
            {sources[viewerPhoto.assetId]
              ? <img src={sources[viewerPhoto.assetId]} alt={viewerPhoto.caption || "照片"} />
              : <LoaderCircle className="album-spin" size={28} />}
            {viewerIndex != null && viewerIndex > 0 && (
              <button className="album-viewer-nav is-prev" type="button" onClick={goPrev} aria-label="上一张">
                <ChevronLeft size={24} />
              </button>
            )}
            {viewerIndex != null && viewerIndex < photos.length - 1 && (
              <button className="album-viewer-nav is-next" type="button" onClick={goNext} aria-label="下一张">
                <ChevronRight size={24} />
              </button>
            )}
          </div>
          <div className="album-viewer-bottom">
            <span>{viewerIndex != null ? `${viewerIndex + 1} / ${photos.length}` : ""}</span>
            {viewerPhoto.caption && <p>{viewerPhoto.caption}</p>}
          </div>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="删除这张照片？"
          message="删除后无法恢复。"
          confirmLabel="删除"
          cancelLabel="再想想"
          variant="danger"
          onConfirm={() => void handleDelete()}
          onCancel={() => setPendingDelete(null)}
        />
      )}

      {notice && <div className="album-notice">{notice}</div>}
      {importing && photos.length > 0 && (
        <div className="album-importing">
          <LoaderCircle size={15} className="album-spin" /> 正在导入照片…
        </div>
      )}
    </section>
  );
}

export default AlbumApp;
