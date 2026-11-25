import { kvGet, kvSet } from "@/lib/kv-db";

const THEATER_STORAGE_KEY = "ai_phone_theater_episodes_v1";

export type TheaterEpisode = {
  id: string;
  characterId: string;
  characterName: string;
  title: string;
  scene: string;      // 场景/地点
  tone: string;       // 关系/基调
  content: string;    // 生成的正文艺内容（纯文本或轻 markdown，展示时按纯文本渲染即可）
  createdAt: string;
  favorite?: boolean;
};

function generateId(): string {
  return `theater_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function isValidEpisode(value: unknown): value is TheaterEpisode {
  if (!value || typeof value !== "object") return false;
  const episode = value as Partial<TheaterEpisode>;
  return typeof episode.id === "string"
    && typeof episode.characterId === "string"
    && typeof episode.characterName === "string"
    && typeof episode.title === "string"
    && typeof episode.scene === "string"
    && typeof episode.tone === "string"
    && typeof episode.content === "string"
    && typeof episode.createdAt === "string";
}

export function loadTheaterEpisodes(): TheaterEpisode[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = kvGet(THEATER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidEpisode)
      .map(episode => ({ ...episode, favorite: episode.favorite === true }))
      .sort((left, right) => (left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0));
  } catch {
    return [];
  }
}

export function saveTheaterEpisodes(list: TheaterEpisode[]): void {
  if (typeof window === "undefined") return;
  kvSet(THEATER_STORAGE_KEY, JSON.stringify(list));
}

export async function hydrateTheaterStorage(): Promise<void> {
  return Promise.resolve();
}

export function addTheaterEpisode(input: {
  characterId: string;
  characterName: string;
  title: string;
  scene: string;
  tone: string;
  content: string;
}): TheaterEpisode {
  const episode: TheaterEpisode = {
    id: generateId(),
    characterId: input.characterId,
    characterName: input.characterName,
    title: input.title.trim() || "无题番外",
    scene: input.scene.trim(),
    tone: input.tone.trim(),
    content: input.content,
    createdAt: new Date().toISOString(),
    favorite: false,
  };
  saveTheaterEpisodes([episode, ...loadTheaterEpisodes()]);
  return episode;
}

export function deleteTheaterEpisode(id: string): void {
  saveTheaterEpisodes(loadTheaterEpisodes().filter(episode => episode.id !== id));
}

export function toggleTheaterFavorite(id: string): void {
  saveTheaterEpisodes(loadTheaterEpisodes().map(episode =>
    episode.id === id ? { ...episode, favorite: episode.favorite !== true } : episode
  ));
}

export function updateTheaterEpisodeTitle(id: string, title: string): void {
  const nextTitle = title.trim();
  if (!nextTitle) return;
  saveTheaterEpisodes(loadTheaterEpisodes().map(episode =>
    episode.id === id ? { ...episode, title: nextTitle } : episode
  ));
}
