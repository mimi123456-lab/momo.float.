"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { BookOpen, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { PageShell } from "@/components/ui/page-shell";
import { CHARACTERS_UPDATED_EVENT, loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { generateTheaterEpisode } from "@/lib/theater-engine";
import {
  addTheaterEpisode,
  deleteTheaterEpisode,
  hydrateTheaterStorage,
  loadTheaterEpisodes,
  toggleTheaterFavorite,
  updateTheaterEpisodeTitle,
  type TheaterEpisode,
} from "@/lib/theater-storage";

const SCENE_HINTS = ["雨夜便利店", "深夜天台", "旧书店", "出差酒店", "校门口"];

const TONE_HINTS = ["暧昧", "克制", "久别重逢", "争吵后的和好", "甜到发腻"];

const INK = "#3f3428";
const SUB = "#8a7a63";
const ACCENT = "#b08a4b";
const PAPER = "rgba(255, 252, 246, 0.9)";
const LINE = "rgba(160, 130, 90, 0.22)";

type TheaterView =
  | { name: "list" }
  | { name: "create" }
  | { name: "read"; id: string };

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={event => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={event => event.stopPropagation()}
      style={{
        width: 30,
        height: 30,
        display: "grid",
        placeItems: "center",
        border: "none",
        background: "transparent",
        borderRadius: 9,
        color: SUB,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function QuickChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "6px 12px",
        borderRadius: 999,
        border: `1px solid ${active ? "rgba(176, 138, 75, 0.6)" : LINE}`,
        background: active ? "rgba(214, 170, 90, 0.18)" : "rgba(255, 252, 247, 0.75)",
        color: active ? "#7a5a2c" : SUB,
        fontSize: 12,
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

const labelStyle: CSSProperties = {
  margin: "0 0 8px",
  fontSize: 12.5,
  fontWeight: 600,
  color: SUB,
  letterSpacing: "0.02em",
};

export function TheaterApp({ onClose }: { onClose: () => void }) {
  const [episodes, setEpisodes] = useState<TheaterEpisode[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [view, setView] = useState<TheaterView>({ name: "list" });

  const [characterId, setCharacterId] = useState("");
  const [scene, setScene] = useState("");
  const [tone, setTone] = useState("");
  const [hint, setHint] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  const refreshEpisodes = useCallback(() => {
    setEpisodes(loadTheaterEpisodes());
  }, []);

  useEffect(() => {
    refreshEpisodes();
    setCharacters(loadCharacters());
    const syncCharacters = () => setCharacters(loadCharacters());
    window.addEventListener(CHARACTERS_UPDATED_EVENT, syncCharacters);
    return () => {
      window.removeEventListener(CHARACTERS_UPDATED_EVENT, syncCharacters);
      abortRef.current?.abort();
    };
  }, [refreshEpisodes]);

  useEffect(() => {
    let cancelled = false;
    void hydrateTheaterStorage().then(() => {
      if (!cancelled) refreshEpisodes();
    });
    return () => {
      cancelled = true;
    };
  }, [refreshEpisodes]);

  const groups = useMemo(() => {
    const map = new Map<string, { characterId: string; characterName: string; items: TheaterEpisode[] }>();
    for (const episode of episodes) {
      const group = map.get(episode.characterId);
      if (group) {
        group.items.push(episode);
      } else {
        map.set(episode.characterId, {
          characterId: episode.characterId,
          characterName: episode.characterName,
          items: [episode],
        });
      }
    }
    return Array.from(map.values());
  }, [episodes]);

  const activeEpisode = view.name === "read"
    ? episodes.find(episode => episode.id === view.id) ?? null
    : null;

  const goList = useCallback(() => {
    setRenaming(false);
    setConfirmingDelete(false);
    setView({ name: "list" });
  }, []);

  const openCreate = useCallback((prefillCharacterId?: string) => {
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    setError(null);
    setScene("");
    setTone("");
    setHint("");
    setRenaming(false);
    setConfirmingDelete(false);
    setCharacterId(prefillCharacterId || characterId || characters[0]?.id || "");
    setView({ name: "create" });
  }, [characterId, characters]);

  const handleBack = useCallback(() => {
    if (view.name === "list") {
      onClose();
      return;
    }
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
    goList();
  }, [view.name, onClose, goList]);

  const openRead = useCallback((id: string) => {
    setRenaming(false);
    setConfirmingDelete(false);
    setView({ name: "read", id });
  }, []);

  const handleGenerate = useCallback(async () => {
    const character = characters.find(item => item.id === characterId);
    if (!character) {
      setError("请先选择一个角色");
      return;
    }
    if (!scene.trim() && !tone.trim()) {
      setError("至少填写场景或基调");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError(null);
    try {
      const content = await generateTheaterEpisode({
        characterId: character.id,
        characterName: character.name,
        persona: character.persona ?? "",
        scene: scene.trim(),
        tone: tone.trim(),
        userHint: hint.trim() || undefined,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!content.trim()) throw new Error("生成结果为空，请重试");

      const episode = addTheaterEpisode({
        characterId: character.id,
        characterName: character.name,
        title: scene.trim() || tone.trim() || `${character.name}的番外`,
        scene: scene.trim(),
        tone: tone.trim(),
        content: content.trim(),
      });
      refreshEpisodes();
      setView({ name: "read", id: episode.id });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : "生成失败，请重试");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  }, [characters, characterId, scene, tone, hint, refreshEpisodes]);

  const handleCancelGenerate = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setGenerating(false);
  }, []);

  const handleToggleFavorite = useCallback((id: string) => {
    toggleTheaterFavorite(id);
    refreshEpisodes();
  }, [refreshEpisodes]);

  const handleDelete = useCallback((id: string) => {
    deleteTheaterEpisode(id);
    refreshEpisodes();
    setRenaming(false);
    setConfirmingDelete(false);
    setView({ name: "list" });
  }, [refreshEpisodes]);

  const handleRenameSave = useCallback(() => {
    if (!activeEpisode) return;
    if (!titleDraft.trim()) return;
    updateTheaterEpisodeTitle(activeEpisode.id, titleDraft);
    refreshEpisodes();
    setRenaming(false);
  }, [activeEpisode, titleDraft, refreshEpisodes]);

  const headerRight = activeEpisode ? (
    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
      <IconButton label="收藏" onClick={() => handleToggleFavorite(activeEpisode.id)}>
        <Star
          size={16}
          strokeWidth={1.6}
          color={activeEpisode.favorite ? "#d9a441" : SUB}
          fill={activeEpisode.favorite ? "#d9a441" : "none"}
        />
      </IconButton>
      <IconButton
        label="重命名"
        onClick={() => {
          setTitleDraft(activeEpisode.title);
          setConfirmingDelete(false);
          setRenaming(true);
        }}
      >
        <Pencil size={16} strokeWidth={1.6} />
      </IconButton>
      <IconButton
        label="删除"
        onClick={() => {
          setRenaming(false);
          setConfirmingDelete(true);
        }}
      >
        <Trash2 size={16} strokeWidth={1.6} />
      </IconButton>
    </div>
  ) : undefined;

  const listBody = (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "16px 16px 30px" }}>
      <div
        style={{
          borderRadius: 16,
          padding: "14px 16px",
          background: "rgba(214, 170, 90, 0.12)",
          border: "1px solid rgba(190, 150, 80, 0.24)",
          color: "#8a6a3b",
          fontSize: 12.5,
          lineHeight: 1.75,
        }}
      >
        番外不会写入记忆，也不会影响主线关系。这里的故事只是平行时间线里的一次小小出走。
      </div>

      {episodes.length > 0 && (
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          style={{ borderRadius: 16, height: 46 }}
          onClick={() => openCreate()}
        >
          <Plus size={16} strokeWidth={2} />
          新建番外
        </button>
      )}

      {episodes.length === 0 ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 12,
            padding: "48px 24px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: 20,
              background: "rgba(214, 170, 90, 0.14)",
              display: "grid",
              placeItems: "center",
              color: ACCENT,
            }}
          >
            <BookOpen size={26} strokeWidth={1.5} />
          </div>
          <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>还没有番外</div>
          <p style={{ margin: 0, maxWidth: 270, fontSize: 13, lineHeight: 1.8, color: SUB }}>
            选一个角色，给 TA 安排一段与主线无关的小故事。这里发生的一切都不会被记住。
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            style={{ borderRadius: 16, height: 44, marginTop: 4 }}
            onClick={() => openCreate()}
          >
            <Plus size={16} strokeWidth={2} />
            新建番外
          </button>
        </div>
      ) : (
        groups.map(group => (
          <section key={group.characterId} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: SUB, letterSpacing: "0.04em" }}>
              {group.characterName}
            </p>
            {group.items.map(episode => (
              <div
                key={episode.id}
                className="app-card"
                role="button"
                tabIndex={0}
                onClick={() => openRead(episode.id)}
                onKeyDown={event => {
                  if (event.key === "Enter" || event.key === " ") openRead(episode.id);
                }}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "14px 16px",
                  borderRadius: 18,
                  background: PAPER,
                  border: `1px solid ${LINE}`,
                  boxShadow: "0 6px 18px rgba(120, 90, 40, 0.05)",
                  cursor: "pointer",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 15,
                      fontWeight: 600,
                      color: INK,
                    }}
                  >
                    {episode.title}
                  </span>
                  <IconButton
                    label={episode.favorite ? "取消收藏" : "收藏"}
                    onClick={() => handleToggleFavorite(episode.id)}
                  >
                    <Star
                      size={15}
                      strokeWidth={1.6}
                      color={episode.favorite ? "#d9a441" : SUB}
                      fill={episode.favorite ? "#d9a441" : "none"}
                    />
                  </IconButton>
                  <IconButton label="删除" onClick={() => handleDelete(episode.id)}>
                    <Trash2 size={15} strokeWidth={1.6} />
                  </IconButton>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, fontSize: 12, color: SUB }}>
                  <span>{episode.characterName}</span>
                  {episode.scene && <span>· {episode.scene}</span>}
                  <span>· {formatTime(episode.createdAt)}</span>
                </div>
              </div>
            ))}
          </section>
        ))
      )}
    </div>
  );

  const createBody = (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, padding: "16px 16px 34px" }}>
      <section>
        <p style={labelStyle}>选择角色</p>
        {characters.length === 0 ? (
          <div
            style={{
              padding: "16px 18px",
              borderRadius: 16,
              background: PAPER,
              border: `1px solid ${LINE}`,
              fontSize: 13,
              lineHeight: 1.8,
              color: SUB,
            }}
          >
            还没有角色。先去创建一个角色，再回来写番外。
          </div>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {characters.map(character => {
              const selected = character.id === characterId;
              return (
                <button
                  key={character.id}
                  type="button"
                  onClick={() => setCharacterId(character.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 12px 6px 6px",
                    borderRadius: 999,
                    border: `1px solid ${selected ? "rgba(176, 138, 75, 0.65)" : LINE}`,
                    background: selected ? "rgba(214, 170, 90, 0.2)" : "rgba(255, 252, 247, 0.8)",
                    color: selected ? "#7a5a2c" : "#5c5040",
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: "50%",
                      overflow: "hidden",
                      background: "#e8ddc9",
                      display: "grid",
                      placeItems: "center",
                      fontSize: 11,
                      color: SUB,
                      flexShrink: 0,
                    }}
                  >
                    {character.avatar ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={character.avatar}
                        alt=""
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    ) : (
                      character.name.slice(0, 1)
                    )}
                  </span>
                  {character.name}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section>
        <p style={labelStyle}>场景 / 地点</p>
        <input
          className="ui-input"
          style={{ borderRadius: 14 }}
          value={scene}
          onChange={event => setScene(event.target.value)}
          placeholder="比如：雨夜便利店"
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {SCENE_HINTS.map(item => (
            <QuickChip key={item} active={scene === item} onClick={() => setScene(item)}>
              {item}
            </QuickChip>
          ))}
        </div>
      </section>

      <section>
        <p style={labelStyle}>关系 / 基调</p>
        <input
          className="ui-input"
          style={{ borderRadius: 14 }}
          value={tone}
          onChange={event => setTone(event.target.value)}
          placeholder="比如：暧昧"
        />
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
          {TONE_HINTS.map(item => (
            <QuickChip key={item} active={tone === item} onClick={() => setTone(item)}>
              {item}
            </QuickChip>
          ))}
        </div>
      </section>

      <section>
        <p style={labelStyle}>额外要求（可选）</p>
        <textarea
          className="ui-textarea"
          style={{ borderRadius: 14, minHeight: 88 }}
          value={hint}
          onChange={event => setHint(event.target.value)}
          placeholder="想看到的细节、台词或情节走向，可以写在这里"
        />
      </section>

      {generating && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 14px",
            borderRadius: 14,
            background: "rgba(214, 170, 90, 0.12)",
            color: "#7a5a2c",
            fontSize: 13,
          }}
        >
          <span>正在写番外…</span>
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            style={{ padding: "4px 10px", fontSize: 12 }}
            onClick={handleCancelGenerate}
          >
            取消
          </button>
        </div>
      )}

      {error && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "12px 14px",
            borderRadius: 14,
            background: "rgba(180, 70, 60, 0.08)",
            border: "1px solid rgba(180, 70, 60, 0.18)",
            color: "#8d4a42",
            fontSize: 13,
            lineHeight: 1.7,
          }}
        >
          <span>{error}</span>
          {!generating && (
            <button
              type="button"
              className="ui-btn ui-btn-soft-danger"
              style={{ alignSelf: "flex-start", padding: "6px 14px", borderRadius: 10 }}
              onClick={handleGenerate}
            >
              重试
            </button>
          )}
        </div>
      )}

      <button
        type="button"
        className="ui-btn ui-btn-primary"
        style={{ borderRadius: 16, height: 46 }}
        disabled={generating || characters.length === 0}
        onClick={handleGenerate}
      >
        {generating ? "正在写番外…" : "生成番外"}
      </button>
    </div>
  );

  const readBody = activeEpisode ? (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 16px 34px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, fontSize: 12, color: SUB }}>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            background: "rgba(214, 170, 90, 0.16)",
            color: "#8a6a3b",
          }}
        >
          番外 · 不计入记忆
        </span>
        <span>{activeEpisode.characterName}</span>
      </div>

      {renaming ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            className="ui-input"
            style={{ flex: 1, borderRadius: 12 }}
            value={titleDraft}
            onChange={event => setTitleDraft(event.target.value)}
            placeholder="番外标题"
          />
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            style={{ padding: "9px 14px", borderRadius: 12 }}
            onClick={handleRenameSave}
          >
            保存
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-ghost"
            style={{ padding: "9px 10px", borderRadius: 12 }}
            onClick={() => setRenaming(false)}
          >
            取消
          </button>
        </div>
      ) : (
        <h2 style={{ margin: 0, fontSize: 19, lineHeight: 1.45, color: INK, letterSpacing: "0.02em" }}>
          {activeEpisode.title}
        </h2>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, color: SUB }}>
        {activeEpisode.scene && <span>场景：{activeEpisode.scene}</span>}
        {activeEpisode.tone && <span>基调：{activeEpisode.tone}</span>}
        <span>{formatTime(activeEpisode.createdAt)}</span>
      </div>

      {confirmingDelete && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            padding: "12px 14px",
            borderRadius: 14,
            background: "rgba(180, 70, 60, 0.08)",
            border: "1px solid rgba(180, 70, 60, 0.18)",
          }}
        >
          <span style={{ fontSize: 13, color: "#8d4a42" }}>确定删除这篇番外吗？删除后无法恢复。</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="button"
              className="ui-btn ui-btn-danger"
              style={{ padding: "8px 16px", borderRadius: 12 }}
              onClick={() => handleDelete(activeEpisode.id)}
            >
              删除
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-outline"
              style={{ padding: "8px 16px", borderRadius: 12 }}
              onClick={() => setConfirmingDelete(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      <article
        className="app-card"
        style={{
          padding: "20px 18px",
          borderRadius: 20,
          background: PAPER,
          border: `1px solid ${LINE}`,
          boxShadow: "0 8px 24px rgba(120, 90, 40, 0.06)",
          fontSize: 15,
          lineHeight: 1.8,
          color: INK,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {activeEpisode.content}
      </article>

      <button
        type="button"
        className="ui-btn ui-btn-primary"
        style={{ borderRadius: 16, height: 46 }}
        onClick={() => openCreate(activeEpisode.characterId)}
      >
        再写一篇
      </button>
    </div>
  ) : (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12, padding: "64px 24px" }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: INK }}>这篇番外不存在</div>
      <button
        type="button"
        className="ui-btn ui-btn-primary"
        style={{ borderRadius: 14, height: 42 }}
        onClick={goList}
      >
        返回列表
      </button>
    </div>
  );

  return (
    <div
      data-app-css="theater"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--c-page-body-bg, #f7f4ef)",
      }}
    >
      <AppCustomCSS appId="theater" />
      <PageShell title="小剧场" onBack={handleBack} rightAction={headerRight}>
        {view.name === "list" ? listBody : view.name === "create" ? createBody : readBody}
      </PageShell>
    </div>
  );
}
