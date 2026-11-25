"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, MessageSquarePlus, Send } from "lucide-react";
import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { Avatar } from "@/components/ui/primitives";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { appendSmsMessage, deleteSmsThread, loadSmsThreads, type SmsThread } from "@/lib/sms-storage";
import { generateSmsReply } from "@/lib/sms-engine";

function characterAvatar(character: Character): string | undefined {
    return (character.chatAvatarEnabled !== false ? character.chatAvatar : character.avatar) || character.avatar || undefined;
}

function formatWhen(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (date.toDateString() === now.toDateString()) return hm;
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function SmsApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [characters, setCharacters] = useState<Character[]>(() => (typeof window === "undefined" ? [] : loadCharacters()));
    const [threads, setThreads] = useState<SmsThread[]>(() => (typeof window === "undefined" ? [] : loadSmsThreads()));
    const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    const refresh = useCallback(() => {
        setCharacters(loadCharacters());
        setThreads(loadSmsThreads());
    }, []);

    useEffect(() => {
        const timers = [400, 1500].map(ms => window.setTimeout(refresh, ms));
        return () => timers.forEach(t => window.clearTimeout(t));
    }, [refresh]);

    useEffect(() => {
        const onOpen = (event: Event) => {
            const detail = (event as CustomEvent<{ characterId?: string }>).detail;
            if (detail?.characterId) {
                setActiveCharacterId(detail.characterId);
                refresh();
            }
        };
        window.addEventListener("sms-open-thread", onOpen);
        return () => window.removeEventListener("sms-open-thread", onOpen);
    }, [refresh]);

    const activeCharacter = useMemo(() => characters.find(item => item.id === activeCharacterId) || null, [characters, activeCharacterId]);
    const activeThread = useMemo(() => threads.find(item => item.characterId === activeCharacterId) || null, [threads, activeCharacterId]);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [activeThread?.messages.length, activeCharacterId]);

    const openThread = (characterId: string) => {
        setActiveCharacterId(characterId);
        setPickerOpen(false);
        setDraft("");
    };

    const send = async () => {
        const text = draft.trim();
        if (!text || !activeCharacter || sending) return;
        setDraft("");
        appendSmsMessage(activeCharacter.id, activeCharacter.name, "user", text);
        setThreads(loadSmsThreads());
        setSending(true);
        try {
            const history = (loadSmsThreads().find(item => item.characterId === activeCharacter.id)?.messages || []).slice(0, -1);
            const replies = await generateSmsReply({
                characterId: activeCharacter.id,
                characterName: activeCharacter.name,
                persona: activeCharacter.persona || "",
                history,
                text,
            });
            if (replies.length === 0) {
                appendSmsMessage(activeCharacter.id, activeCharacter.name, "character", "嗯。");
            } else {
                replies.forEach(reply => appendSmsMessage(activeCharacter.id, activeCharacter.name, "character", reply));
            }
        } catch (error) {
            appendSmsMessage(activeCharacter.id, activeCharacter.name, "character", error instanceof Error ? `（发送失败：${error.message}）` : "（短信发送失败）");
            onNotice?.(error instanceof Error ? error.message : "短信发送失败");
        } finally {
            setSending(false);
            setThreads(loadSmsThreads());
        }
    };

    const renderList = () => (
        <div style={{ flex: 1, overflowY: "auto", padding: "0 0 24px" }}>
            {threads.length === 0 ? (
                <div style={{ padding: "60px 24px", textAlign: "center", fontSize: 14, color: "var(--c-text-secondary, #8a8a8a)" }}>
                    还没有短信会话。点右上角新建，选一个联系人发第一条短信。
                </div>
            ) : threads.map(thread => (
                <button
                    key={thread.characterId}
                    type="button"
                    onClick={() => openThread(thread.characterId)}
                    style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                        background: "none", border: "none", borderBottom: "0.5px solid var(--c-border, rgba(0,0,0,0.08))",
                        cursor: "pointer", textAlign: "left",
                    }}
                >
                    <Avatar src={characterAvatar(characters.find(c => c.id === thread.characterId) || ({ avatar: null, name: thread.characterName } as Character))} name={thread.characterName} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--c-text)" }}>{thread.characterName}</span>
                            <span style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>{formatWhen(thread.updatedAt)}</span>
                        </div>
                        <div style={{ fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)", marginTop: 3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {thread.messages[thread.messages.length - 1]?.body || "暂无消息"}
                        </div>
                    </div>
                </button>
            ))}
        </div>
    );

    const renderThread = () => {
        if (!activeCharacter) return null;
        const messages = activeThread?.messages || [];
        return (
            <>
                <header style={{ padding: "calc(env(safe-area-inset-top, 0px) + 44px) 12px 8px", display: "flex", alignItems: "center", gap: 8, borderBottom: "0.5px solid var(--c-border, rgba(0,0,0,0.08))" }}>
                    <button type="button" onClick={() => setActiveCharacterId(null)} style={iconButtonStyle} aria-label="返回"><ChevronLeft size={24} /></button>
                    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <Avatar src={characterAvatar(activeCharacter)} name={activeCharacter.name} size="sm" />
                        <span style={{ fontSize: 12, marginTop: 2, color: "var(--c-text)" }}>{activeCharacter.name}</span>
                    </div>
                    <button type="button" onClick={() => { if (activeCharacter && window.confirm(`删除和${activeCharacter.name}的短信？`)) { deleteSmsThread(activeCharacter.id); setThreads(loadSmsThreads()); setActiveCharacterId(null); } }} style={{ ...iconButtonStyle, fontSize: 13, width: 44 }}>删除</button>
                </header>
                <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 14px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
                    {messages.length === 0 && <div style={{ textAlign: "center", fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)", marginTop: 24 }}>发一条短信给 {activeCharacter.name}</div>}
                    {messages.map(message => (
                        <div key={message.id} style={{ display: "flex", justifyContent: message.role === "user" ? "flex-end" : "flex-start" }}>
                            <div style={{
                                maxWidth: "76%", padding: "8px 12px", fontSize: 15, lineHeight: 1.45,
                                borderRadius: message.role === "user" ? "18px 18px 4px 18px" : "18px 18px 18px 4px",
                                background: message.role === "user" ? "#34c759" : "var(--c-card-bg, #e9e9eb)",
                                color: message.role === "user" ? "#fff" : "var(--c-text)",
                                whiteSpace: "pre-wrap", wordBreak: "break-word",
                            }}>{message.body}</div>
                        </div>
                    ))}
                    {sending && <div style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>{activeCharacter.name} 正在输入…</div>}
                </div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 8, padding: "8px 12px calc(env(safe-area-inset-bottom, 0px) + 10px)", borderTop: "0.5px solid var(--c-border, rgba(0,0,0,0.08))" }}>
                    <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        placeholder="短信"
                        rows={1}
                        style={{ flex: 1, resize: "none", border: "1px solid var(--c-border, rgba(0,0,0,0.15))", borderRadius: 18, padding: "8px 12px", fontSize: 15, outline: "none", background: "var(--c-card-bg, #fff)", color: "var(--c-text)", maxHeight: 96 }}
                    />
                    <button type="button" onClick={() => void send()} disabled={!draft.trim() || sending} style={{ ...iconButtonStyle, color: draft.trim() ? "#34c759" : "var(--c-text-secondary, #8a8a8a)" }} aria-label="发送"><Send size={22} /></button>
                </div>
            </>
        );
    };

    return (
        <div data-app-css="sms" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--c-page-body-bg, #f7f7f9)", overflow: "hidden" }}>
            <AppCustomCSS appId="sms" />
            {activeCharacter ? renderThread() : (
                <>
                    <header style={{ padding: "calc(env(safe-area-inset-top, 0px) + 46px) 16px 10px", display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" onClick={onClose} style={{ ...iconButtonStyle, marginLeft: -6 }} aria-label="返回"><ChevronLeft size={24} /></button>
                        <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5, flex: 1 }}>短信</span>
                        <button type="button" onClick={() => setPickerOpen(true)} style={iconButtonStyle} aria-label="新建短信"><MessageSquarePlus size={22} /></button>
                    </header>
                    {renderList()}
                </>
            )}

            {pickerOpen && (
                <div style={{ position: "absolute", inset: 0, zIndex: 10, background: "var(--c-page-body-bg, #f7f7f9)", display: "flex", flexDirection: "column" }}>
                    <header style={{ padding: "calc(env(safe-area-inset-top, 0px) + 46px) 16px 10px", display: "flex", alignItems: "center", gap: 10 }}>
                        <button type="button" onClick={() => setPickerOpen(false)} style={{ ...iconButtonStyle, marginLeft: -6 }} aria-label="返回"><ChevronLeft size={24} /></button>
                        <span style={{ fontSize: 20, fontWeight: 600 }}>新建短信</span>
                    </header>
                    <div style={{ flex: 1, overflowY: "auto", padding: "0 16px 24px" }}>
                        {characters.length === 0 ? (
                            <div style={{ padding: 40, textAlign: "center", fontSize: 14, color: "var(--c-text-secondary, #8a8a8a)" }}>还没有角色，先去「角色」里创建。</div>
                        ) : characters.map(character => (
                            <button key={character.id} type="button" onClick={() => openThread(character.id)} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 0", background: "none", border: "none", borderBottom: "0.5px solid var(--c-border, rgba(0,0,0,0.08))", cursor: "pointer", textAlign: "left" }}>
                                <Avatar src={characterAvatar(character)} name={character.name} />
                                <span style={{ flex: 1, fontSize: 16 }}>{character.name}</span>
                                <ChevronRight size={16} color="var(--c-text-secondary, #8a8a8a)" />
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

const iconButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    padding: 6,
    cursor: "pointer",
    color: "var(--c-text)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
};
