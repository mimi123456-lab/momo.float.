"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Camera, LoaderCircle, Sparkles, Wand2, X } from "lucide-react";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { appendChatOfflineTurn } from "@/lib/chat-offline-storage";
import { loadChatMessages, pushChatMessage, updateChatMessage, type ChatMessage, type ChatSession } from "@/lib/chat-storage";
import { generatedImageFilename, generateImageFromConfiguredApi } from "@/lib/image-generation-service";
import { buildStoryPhotoContext, buildStoryPhotoPrompt, storyPhotoCaption, type StoryPhotoKind } from "@/lib/story-photo";

type Props = {
    session: ChatSession;
    characterId: string;
    characterName: string;
    onClose: () => void;
    onGenerated: () => void;
};

type GeneratedPhoto = {
    kind: StoryPhotoKind;
    prompt: string;
    dataUrl: string;
    messageId: string;
};

const KIND_LABELS: Record<StoryPhotoKind, string> = {
    character: "她的单人照",
    user: "我的单人照",
    couple: "两人的合照",
};

function dispatchMessagesUpdated(sessionId: string, message: ChatMessage): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId, message } }));
}

export function StoryPhotoDialog({ session, characterId, characterName, onClose, onGenerated }: Props) {
    const [kind, setKind] = useState<StoryPhotoKind>("couple");
    const [context, setContext] = useState(() => buildStoryPhotoContext(session.id));
    const [prompt, setPrompt] = useState(() => buildStoryPhotoPrompt("couple", buildStoryPhotoContext(session.id)));
    const promptTouchedRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [polishing, setPolishing] = useState(false);
    const [error, setError] = useState("");
    const [photos, setPhotos] = useState<GeneratedPhoto[]>([]);
    const [editing, setEditing] = useState<{ index: number; prompt: string } | null>(null);
    const [regenerating, setRegenerating] = useState(false);
    const longPressRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const useReferenceImage = kind !== "user";
    const useUserReferenceImage = kind !== "character";

    const switchKind = (next: StoryPhotoKind) => {
        setKind(next);
        if (!promptTouchedRef.current) setPrompt(buildStoryPhotoPrompt(next, context));
    };

    const refreshContext = () => {
        const next = buildStoryPhotoContext(session.id);
        setContext(next);
        promptTouchedRef.current = false;
        setPrompt(buildStoryPhotoPrompt(kind, next));
    };

    const polishPrompt = useCallback(async () => {
        if (polishing) return;
        setPolishing(true);
        setError("");
        try {
            const history = loadChatMessages(session.id)
                .slice(-10)
                .filter(message => !message.isRetracted && message.status !== "failed");
            const ask: ChatMessage = {
                id: `photo_${Date.now()}`,
                sessionId: session.id,
                role: "user",
                status: "sent",
                createdAt: new Date().toISOString(),
                content: [
                    "根据我们最近的剧情，把下面这张照片的画面描述润色成适合生图的提示词。",
                    "只输出一段中文画面描述，不要解释、不要引号、不要 Markdown。",
                    `照片类型：${KIND_LABELS[kind]}`,
                    `当前提示词：${prompt}`,
                    context ? `最近剧情：${context}` : "",
                ].filter(Boolean).join("\n"),
            };
            const result = await generateChatCompletion(session, [...history, ask], {
                appId: "chat",
                appTags: ["chat"],
                toolsAllowed: false,
            });
            const refined = flattenCompletionResult(result).trim().replace(/^["“]|["”]$/g, "");
            if (refined) {
                setPrompt(refined);
                promptTouchedRef.current = true;
            }
        } catch (err) {
            setError("AI 润色失败：" + (err instanceof Error ? err.message : String(err)));
        } finally {
            setPolishing(false);
        }
    }, [context, kind, polishing, prompt, session]);

    const generateOne = async (description: string): Promise<{ dataUrl: string; messageId: string; prompt: string }> => {
        const generated = await generateImageFromConfiguredApi({
            description,
            characterId,
            appId: "chat",
            useReferenceImage,
            includeUserReferenceImage: useUserReferenceImage,
        });
        if (!generated) throw new Error("生图配置未启用或不完整");
        const fileName = generatedImageFilename(description, generated.mimeType);
        const message = pushChatMessage({
            sessionId: session.id,
            role: "assistant",
            content: fileName,
            mediaType: "media_file",
            mediaUrl: generated.dataUrl,
            mediaData: {
                label: description,
                fileType: "image",
                fileName,
                useReferenceImage,
                useUserReferenceImage,
                imageGenerationMediaRef: generated.mediaRef,
                imageGenerationPrompt: generated.prompt,
                imageGenerationUsedReference: generated.usedReferenceImage,
                imageGenerationStatus: "generated",
            },
        });
        return { dataUrl: generated.dataUrl, messageId: message.id, prompt: generated.prompt };
    };

    const handleGenerate = async () => {
        const description = prompt.trim();
        if (!description || busy) return;
        setBusy(true);
        setError("");
        try {
            const generated = await generateOne(description);
            setPhotos(previous => [...previous, { kind, prompt: description, dataUrl: generated.dataUrl, messageId: generated.messageId }]);
            appendChatOfflineTurn({
                sessionId: session.id,
                userContent: "",
                assistantContent: storyPhotoCaption(kind, characterName),
                summary: `拍照：${description.slice(0, 120)}`,
                summaryTag: "summary",
            });
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
            const generated = await generateOne(description);
            const updated = updateChatMessage(generated.messageId, {
                content: generatedImageFilename(description, "image/png"),
                mediaUrl: generated.dataUrl,
                mediaData: {
                    label: description,
                    fileType: "image",
                    fileName: generatedImageFilename(description, "image/png"),
                    useReferenceImage,
                    useUserReferenceImage,
                    imageGenerationPrompt: generated.prompt,
                    imageGenerationStatus: "generated",
                },
            });
            if (updated) dispatchMessagesUpdated(session.id, updated);
            setPhotos(previous => previous.map((photo, index) => index === editing.index ? { ...photo, prompt: description, dataUrl: generated.dataUrl } : photo));
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
            setEditing({ index, prompt: photos[index]?.prompt || "" });
        }, 600);
    };
    const cancelLongPress = () => {
        if (longPressRef.current) {
            clearTimeout(longPressRef.current);
            longPressRef.current = null;
        }
    };

    const contextPreview = useMemo(() => context.length > 420 ? context.slice(0, 420) + "…" : context, [context]);

    return (
        <div className="modal-overlay" data-ui="modal" onPointerDown={event => event.stopPropagation()}>
            <div className="modal-dialog chat-story-photo-dialog" data-ui="modal-dialog" onClick={event => event.stopPropagation()}>
                <div className="modal-header" data-ui="modal-header">
                    <h3 className="modal-title"><Camera size={18} /> 剧情拍照</h3>
                    <button type="button" className="modal-header-btn modal-header-btn-muted" aria-label="关闭" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>
                <div className="modal-body" data-ui="modal-body">
                    <div className="chat-story-photo-tabs" role="tablist">
                        {(Object.keys(KIND_LABELS) as StoryPhotoKind[]).map(item => (
                            <button
                                key={item}
                                type="button"
                                role="tab"
                                aria-selected={kind === item}
                                className="chat-story-photo-tab"
                                data-active={kind === item ? "" : undefined}
                                onClick={() => switchKind(item)}
                            >
                                {KIND_LABELS[item]}
                            </button>
                        ))}
                    </div>

                    {contextPreview ? (
                        <div className="chat-story-photo-context" title={context}>
                            <strong>当前画面上下文</strong>
                            <span>{contextPreview}</span>
                        </div>
                    ) : (
                        <div className="chat-story-photo-context">
                            <span>还没有可用的剧情记录；可以直接写提示词，或先在线下聊几句。</span>
                        </div>
                    )}

                    <textarea
                        className="ui-textarea chat-story-photo-prompt"
                        rows={5}
                        value={prompt}
                        onChange={event => { setPrompt(event.target.value); promptTouchedRef.current = true; }}
                        placeholder="描述这张照片的画面：地点、天气、穿着、动作、表情、镜头"
                    />

                    <div className="chat-story-photo-actions">
                        <button type="button" className="ui-btn ui-btn-ghost" onClick={refreshContext} disabled={busy}>
                            <Sparkles size={14} /> 重新推断场景
                        </button>
                        <button type="button" className="ui-btn ui-btn-ghost" onClick={polishPrompt} disabled={busy || polishing}>
                            {polishing ? <LoaderCircle size={14} className="spin" /> : <Wand2 size={14} />} AI 润色
                        </button>
                    </div>

                    {error && <div className="chat-generated-image-retry-error">{error}</div>}

                    {photos.length > 0 && (
                        <div className="chat-story-photo-grid">
                            {photos.map((photo, index) => (
                                <button
                                    key={photo.messageId}
                                    type="button"
                                    className="chat-story-photo-item"
                                    onPointerDown={() => startLongPress(index)}
                                    onPointerUp={cancelLongPress}
                                    onPointerLeave={cancelLongPress}
                                    onPointerCancel={cancelLongPress}
                                    onContextMenu={event => { event.preventDefault(); setEditing({ index, prompt: photo.prompt }); }}
                                    aria-label="长按重新生成这张照片"
                                    title="长按照片可改提示词重新生成"
                                >
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={photo.dataUrl} alt={KIND_LABELS[photo.kind]} />
                                    <span>{KIND_LABELS[photo.kind]}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {photos.length > 0 && <div className="menu-desc">长按照片可改提示词重新生成。</div>}
                </div>
                <div className="modal-footer" data-ui="modal-footer">
                    <button type="button" className="ui-btn ui-btn-ghost" onClick={onClose}>关闭</button>
                    <button
                        type="button"
                        className="ui-btn ui-btn-action"
                        disabled={busy || !prompt.trim()}
                        onClick={handleGenerate}
                    >
                        {busy ? <><LoaderCircle size={16} className="spin" /> 生成中…</> : "生成这张"}
                    </button>
                </div>
            </div>

            {editing && (
                <div className="modal-overlay" data-ui="modal" onClick={() => setEditing(null)}>
                    <div className="modal-dialog" data-ui="modal-dialog" onClick={event => event.stopPropagation()}>
                        <div className="modal-header" data-ui="modal-header">
                            <h3 className="modal-title">重新生成这张照片</h3>
                        </div>
                        <div className="modal-body" data-ui="modal-body">
                            <textarea
                                className="ui-textarea"
                                rows={5}
                                value={editing.prompt}
                                onChange={event => setEditing(current => current ? { ...current, prompt: event.target.value } : current)}
                                disabled={regenerating}
                            />
                            {error && <div className="chat-generated-image-retry-error">{error}</div>}
                        </div>
                        <div className="modal-footer" data-ui="modal-footer">
                            <button type="button" className="ui-btn ui-btn-ghost" onClick={() => setEditing(null)} disabled={regenerating}>取消</button>
                            <button type="button" className="ui-btn ui-btn-action" onClick={handleRegenerate} disabled={regenerating || !editing.prompt.trim()}>
                                {regenerating ? "生成中…" : "重新生成"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
