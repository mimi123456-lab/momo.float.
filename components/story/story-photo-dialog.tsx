"use client";

import { useMemo, useRef, useState } from "react";

import { cleanStorySyncText, recordStorySyncEvent } from "@/lib/story-chat-sync";
import { buildStoryPhotoPrompt, type StoryPhotoKind } from "@/lib/story-photo";
import {
    buildStoryPhotoHtml,
    generateStoryPhotoData,
    replaceStoryPhotoMessage,
    storyPhotoMemoryText,
} from "@/lib/story-photo-trigger";
import { pushStoryMessage, type StoryMessage } from "@/lib/story-storage";

type Props = {
    sessionId: string;
    characterId: string;
    characterName: string;
    messages: StoryMessage[];
    onClose: () => void;
    onGenerated: () => void;
};

type GeneratedStoryPhoto = {
    messageId: string;
    kind: StoryPhotoKind;
    description: string;
    dataUrl: string;
};

const KIND_LABELS: Record<StoryPhotoKind, string> = {
    character: "她的单人照",
    user: "我的单人照",
    couple: "两人的合照",
};

function clip(value: string, limit: number): string {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > limit ? text.slice(0, limit) + "…" : text;
}

function buildContext(messages: StoryMessage[]): string {
    const parts: string[] = [];
    // 状态栏里通常有地点/穿搭/心情，只用于拍照取景，不写入同步记忆。
    const lastAssistant = [...messages].reverse().find(message => message.role === "assistant");
    const statusMatch = /\[状态栏\]([\s\S]*?)\[\/状态栏\]/.exec(lastAssistant?.rawContent || "");
    if (statusMatch) {
        const status = clip(statusMatch[1].replace(/[#*_>`]/g, " "), 180);
        if (status) parts.push("当前状态（地点/穿搭/心情）：" + status);
    }
    const recent = messages
        .slice(-6)
        .filter(message => message.role === "user" || message.role === "assistant")
        .map(message => cleanStorySyncText(message.rawContent))
        .filter(Boolean)
        .map(text => clip(text, 220));
    if (recent.length > 0) parts.push("最近剧情与正在发生的事：\n" + recent.join("\n"));
    return parts.join("\n");
}

export function StoryPhotoDialog({ sessionId, characterId, characterName, messages, onClose, onGenerated }: Props) {
    const initialContextRef = useRef<string>(buildContext(messages));
    const [context, setContext] = useState(initialContextRef.current);
    const [kind, setKind] = useState<StoryPhotoKind>("character");
    const [prompt, setPrompt] = useState(() => buildStoryPhotoPrompt("character", initialContextRef.current));
    const promptTouchedRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [photos, setPhotos] = useState<GeneratedStoryPhoto[]>([]);
    const [editing, setEditing] = useState<{ index: number; prompt: string } | null>(null);
    const [regenerating, setRegenerating] = useState(false);
    const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const switchKind = (next: StoryPhotoKind) => {
        setKind(next);
        if (!promptTouchedRef.current) setPrompt(buildStoryPhotoPrompt(next, context));
    };

    const refreshContext = () => {
        const next = buildContext(messages);
        setContext(next);
        promptTouchedRef.current = false;
        setPrompt(buildStoryPhotoPrompt(kind, next));
    };

    const handleGenerate = async () => {
        const description = prompt.trim();
        if (!description || busy) return;
        setBusy(true);
        setError("");
        try {
            const generated = await generateStoryPhotoData({ characterId, description, subject: kind });
            if (!generated) throw new Error("生图未配置或生成失败");
            const message = pushStoryMessage({
                sessionId,
                role: "system",
                contextRole: "assistant",
                rawContent: storyPhotoMemoryText(description),
                renderedContent: buildStoryPhotoHtml(description, generated.dataUrl),
            });
            recordStorySyncEvent(characterId, "assistant", storyPhotoMemoryText(description));
            setPhotos(previous => [...previous, {
                messageId: message.id,
                kind,
                description,
                dataUrl: generated.dataUrl,
            }]);
            onGenerated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleRegenerate = async () => {
        if (!editing || regenerating) return;
        const description = editing.prompt.trim();
        if (!description) return;
        setRegenerating(true);
        setError("");
        try {
            const target = photos[editing.index];
            const generated = await generateStoryPhotoData({
                characterId,
                description,
                subject: target?.kind ?? kind,
            });
            if (!generated) throw new Error("生图未配置或生成失败");
            if (target) {
                replaceStoryPhotoMessage({
                    sessionId,
                    messageId: target.messageId,
                    description,
                    dataUrl: generated.dataUrl,
                });
                recordStorySyncEvent(characterId, "assistant", storyPhotoMemoryText(description));
                setPhotos(previous => previous.map((photo, index) => index === editing.index
                    ? { ...photo, description, dataUrl: generated.dataUrl }
                    : photo));
            }
            setEditing(null);
            onGenerated();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setRegenerating(false);
        }
    };

    const startLongPress = (index: number) => {
        if (longPressRef.current) clearTimeout(longPressRef.current);
        longPressRef.current = setTimeout(() => {
            setEditing({ index, prompt: photos[index]?.description || "" });
        }, 600);
    };
    const cancelLongPress = () => {
        if (longPressRef.current) {
            clearTimeout(longPressRef.current);
            longPressRef.current = null;
        }
    };

    const contextPreview = useMemo(() => clip(context, 320), [context]);

    return (
        <div className="story-photo-overlay" role="dialog" aria-modal="true" onClick={onClose}>
            <div className="story-photo-dialog" onClick={event => event.stopPropagation()}>
                <header className="story-photo-header">
                    <strong>剧情拍照{characterName.trim() ? ` · ${characterName.trim()}` : ""}</strong>
                    <button type="button" onClick={onClose} aria-label="关闭">×</button>
                </header>
                <div className="story-photo-body">
                    <div className="story-photo-tabs" role="tablist">
                        {(Object.keys(KIND_LABELS) as StoryPhotoKind[]).map(item => (
                            <button
                                key={item}
                                type="button"
                                role="tab"
                                aria-selected={kind === item}
                                data-active={kind === item ? "true" : undefined}
                                onClick={() => switchKind(item)}
                            >
                                {KIND_LABELS[item]}
                            </button>
                        ))}
                    </div>

                    <div className="story-photo-context">
                        {contextPreview || "还没有可用的剧情记录，可以直接写提示词。"}
                    </div>

                    <textarea
                        className="story-photo-prompt"
                        rows={5}
                        value={prompt}
                        onChange={event => { setPrompt(event.target.value); promptTouchedRef.current = true; }}
                        placeholder="描述画面：地点、天气、穿着、动作、表情、镜头"
                    />

                    <button type="button" className="story-photo-refresh" onClick={refreshContext} disabled={busy}>
                        重新按最近剧情推断
                    </button>

                    {error && <div className="story-photo-error">{error}</div>}

                    {photos.length > 0 && (
                        <div className="story-photo-grid">
                            {photos.map((photo, index) => (
                                <button
                                    key={photo.messageId}
                                    type="button"
                                    className="story-photo-item"
                                    onPointerDown={() => startLongPress(index)}
                                    onPointerUp={cancelLongPress}
                                    onPointerLeave={cancelLongPress}
                                    onPointerCancel={cancelLongPress}
                                    onContextMenu={event => { event.preventDefault(); setEditing({ index, prompt: photo.description }); }}
                                    title="长按照片可改提示词重新生成"
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={photo.dataUrl} alt={KIND_LABELS[photo.kind]} />
                                    <span>{KIND_LABELS[photo.kind]}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {photos.length > 0 && <div className="story-photo-hint">长按照片可改提示词重新生成。</div>}
                </div>
                <footer className="story-photo-footer">
                    <button type="button" onClick={onClose}>关闭</button>
                    <button type="button" className="is-primary" onClick={handleGenerate} disabled={busy || !prompt.trim()}>
                        {busy ? "生成中…" : "生成这张"}
                    </button>
                </footer>
            </div>

            {editing && (
                <div className="story-photo-overlay" role="dialog" aria-modal="true" onClick={() => setEditing(null)}>
                    <div className="story-photo-dialog" onClick={event => event.stopPropagation()}>
                        <header className="story-photo-header">
                            <strong>重新生成这张照片</strong>
                            <button type="button" onClick={() => setEditing(null)} aria-label="关闭">×</button>
                        </header>
                        <div className="story-photo-body">
                            <textarea
                                className="story-photo-prompt"
                                rows={5}
                                value={editing.prompt}
                                onChange={event => setEditing(current => current ? { ...current, prompt: event.target.value } : current)}
                                disabled={regenerating}
                            />
                            {error && <div className="story-photo-error">{error}</div>}
                        </div>
                        <footer className="story-photo-footer">
                            <button type="button" onClick={() => setEditing(null)} disabled={regenerating}>取消</button>
                            <button type="button" className="is-primary" onClick={handleRegenerate} disabled={regenerating || !editing.prompt.trim()}>
                                {regenerating ? "生成中…" : "重新生成"}
                            </button>
                        </footer>
                    </div>
                </div>
            )}
        </div>
    );
}
