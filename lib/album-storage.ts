// 相册：照片本体存 IndexedDB 资产库（与聊天图片同一套压缩逻辑），
// 这里只在 KV 里记一份轻量索引（id / 资产 id / 时间 / 说明）。
import { deleteThemeAsset } from "./theme-storage";
import { saveChatImageToIndexedDB } from "./chat-asset-storage";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export const ALBUM_STORAGE_KEY = "ai_phone_album_photos_v1";
export const ALBUM_UPDATED_EVENT = "ai-phone-album-updated";

registerKvMigration(ALBUM_STORAGE_KEY);

export type AlbumPhoto = {
  id: string;
  assetId: string;
  createdAt: string;
  caption?: string;
};

function createId(): string {
  const uuid = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `album_${uuid}`;
}

function normalizePhoto(raw: unknown): AlbumPhoto | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || typeof item.assetId !== "string") return null;
  const createdAt = typeof item.createdAt === "string" && !Number.isNaN(Date.parse(item.createdAt))
    ? item.createdAt
    : new Date().toISOString();
  return {
    id: item.id,
    assetId: item.assetId,
    createdAt,
    caption: typeof item.caption === "string" && item.caption.trim() ? item.caption.trim().slice(0, 120) : undefined,
  };
}

export function loadAlbumPhotos(): AlbumPhoto[] {
  const raw = kvGet(ALBUM_STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizePhoto)
      .filter((item): item is AlbumPhoto => Boolean(item))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  } catch {
    return [];
  }
}

function persist(photos: AlbumPhoto[]): AlbumPhoto[] {
  kvSet(ALBUM_STORAGE_KEY, JSON.stringify(photos));
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ALBUM_UPDATED_EVENT));
  }
  return photos;
}

/** 把本地选中的文件压缩后写入相册，返回新增的照片（最新的在前）。 */
export async function addAlbumPhotoFromFile(file: File): Promise<AlbumPhoto> {
  const assetId = await saveChatImageToIndexedDB(file);
  const photo: AlbumPhoto = {
    id: createId(),
    assetId,
    createdAt: new Date().toISOString(),
  };
  persist([photo, ...loadAlbumPhotos()]);
  return photo;
}

export async function updateAlbumPhotoCaption(id: string, caption: string): Promise<AlbumPhoto[]> {
  const next = loadAlbumPhotos().map(photo =>
    photo.id === id
      ? { ...photo, caption: caption.trim() ? caption.trim().slice(0, 120) : undefined }
      : photo
  );
  return persist(next);
}

export async function deleteAlbumPhotos(ids: string[]): Promise<AlbumPhoto[]> {
  const idSet = new Set(ids);
  const all = loadAlbumPhotos();
  const removed = all.filter(photo => idSet.has(photo.id));
  const next = all.filter(photo => !idSet.has(photo.id));
  persist(next);
  for (const photo of removed) {
    try {
      await deleteThemeAsset(photo.assetId);
    } catch {
      // 资产库缺失时忽略，索引已经删掉即可。
    }
  }
  return next;
}
