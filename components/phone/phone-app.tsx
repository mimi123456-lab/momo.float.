"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    ChevronLeft,
    Delete,
    Phone,
    PhoneCall,
    PhoneIncoming,
    PhoneMissed,
    PhoneOutgoing,
    Search,
    Star,
    UserRound,
    Voicemail,
} from "lucide-react";
import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { Avatar } from "@/components/ui/primitives";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    addPhoneCallLog,
    clearPhoneCallLogs,
    loadPhoneCallLogs,
    resolvePhoneNumber,
    type PhoneCallLog,
} from "@/lib/phone-call-storage";
import { createOrGetSession, pushChatMessage } from "@/lib/chat-storage";

type PhoneTab = "favorites" | "recents" | "contacts" | "keypad" | "voicemail";

type CallState = {
    character: Character;
    direction: "outgoing" | "incoming";
    phase: "incoming" | "calling" | "active";
    seconds: number;
};

const TABS: Array<{ id: PhoneTab; label: string; icon: React.ReactNode }> = [
    { id: "favorites", label: "个人收藏", icon: <Star size={22} strokeWidth={1.6} /> },
    { id: "recents", label: "最近通话", icon: <PhoneCall size={22} strokeWidth={1.6} /> },
    { id: "contacts", label: "通讯录", icon: <UserRound size={22} strokeWidth={1.6} /> },
    { id: "keypad", label: "拨号键盘", icon: <Phone size={22} strokeWidth={1.6} /> },
    { id: "voicemail", label: "语音留言", icon: <Voicemail size={22} strokeWidth={1.6} /> },
];

function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
}

function formatWhen(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (sameDay) return `今天 ${hm}`;
    return `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

function characterAvatar(character: Character): string | undefined {
    return (character.chatAvatarEnabled !== false ? character.chatAvatar : character.avatar) || character.avatar || undefined;
}

export function PhoneApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [tab, setTab] = useState<PhoneTab>("recents");
    const [characters, setCharacters] = useState<Character[]>(() => (typeof window === "undefined" ? [] : loadCharacters()));
    const [logs, setLogs] = useState<PhoneCallLog[]>(() => (typeof window === "undefined" ? [] : loadPhoneCallLogs()));
    const [dialed, setDialed] = useState("");
    const [search, setSearch] = useState("");
    const [call, setCall] = useState<CallState | null>(null);
    const [favorites, setFavorites] = useState<string[]>(() => {
        try { return JSON.parse(localStorage.getItem("phone-favorite-contacts") || "[]"); } catch { return []; }
    });

    useEffect(() => {
        const timers = [400, 1500].map(ms => window.setTimeout(() => {
            setCharacters(loadCharacters());
            setLogs(loadPhoneCallLogs());
        }, ms));
        return () => timers.forEach(t => window.clearTimeout(t));
    }, []);

    // 聊天卡片点击「接听」时，由 chat-room 广播来电
    useEffect(() => {
        const onIncoming = (event: Event) => {
            const detail = (event as CustomEvent<{ characterId?: string }>).detail;
            const character = loadCharacters().find(item => item.id === detail?.characterId);
            if (!character) return;
            setCall({ character, direction: "incoming", phase: "incoming", seconds: 0 });
        };
        window.addEventListener("phone-incoming-call", onIncoming);
        return () => window.removeEventListener("phone-incoming-call", onIncoming);
    }, []);

    // 通话计时
    const callRef = useRef<CallState | null>(null);
    callRef.current = call;
    useEffect(() => {
        if (!call || call.phase === "incoming") return;
        if (call.phase === "calling") {
            const timer = window.setTimeout(() => {
                setCall(prev => prev && prev.phase === "calling" ? { ...prev, phase: "active" } : prev);
            }, 2200);
            return () => window.clearTimeout(timer);
        }
        const timer = window.setInterval(() => {
            setCall(prev => prev && prev.phase === "active" ? { ...prev, seconds: prev.seconds + 1 } : prev);
        }, 1000);
        return () => window.clearInterval(timer);
    }, [call?.phase, call?.character.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const numberFor = useCallback((character: Character) => resolvePhoneNumber(character.id, character.wechatID), []);

    const syncCallToChat = useCallback((state: CallState, hangup: boolean) => {
        try {
            const session = createOrGetSession(state.character.id);
            const text = hangup
                ? `〔手机通话已结束〕和${state.character.name}通话 ${formatDuration(state.seconds)}`
                : `〔手机来电〕${state.character.name}正在给你打电话`;
            pushChatMessage({ sessionId: session.id, role: "system", content: text, mediaType: "tool_notice" });
            if (hangup) {
                window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
            }
        } catch { /* 会话不可用时不阻塞通话 */ }
    }, []);

    const startCall = useCallback((character: Character) => {
        setCall({ character, direction: "outgoing", phase: "calling", seconds: 0 });
        setTab("recents");
    }, []);

    const hangUp = useCallback(() => {
        const state = callRef.current;
        if (!state) return;
        const answered = state.phase === "active";
        addPhoneCallLog({
            characterId: state.character.id,
            characterName: state.character.name,
            number: numberFor(state.character),
            type: answered ? "outgoing" : "missed",
            durationSec: state.seconds,
        });
        setLogs(loadPhoneCallLogs());
        if (answered) syncCallToChat(state, true);
        setCall(null);
    }, [numberFor, syncCallToChat]);

    const answerCall = useCallback(() => {
        setCall(prev => prev ? { ...prev, phase: "active" } : prev);
    }, []);

    const declineCall = useCallback(() => {
        const state = callRef.current;
        if (!state) return;
        addPhoneCallLog({
            characterId: state.character.id,
            characterName: state.character.name,
            number: numberFor(state.character),
            type: "missed",
            durationSec: 0,
        });
        setLogs(loadPhoneCallLogs());
        try {
            const session = createOrGetSession(state.character.id);
            pushChatMessage({ sessionId: session.id, role: "user", content: "（拒接了手机来电）", status: "sent" });
            window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
        } catch { /* ignore */ }
        setCall(null);
    }, [numberFor]);

    const toggleFavorite = (characterId: string) => {
        setFavorites(prev => {
            const next = prev.includes(characterId) ? prev.filter(id => id !== characterId) : [...prev, characterId];
            try { localStorage.setItem("phone-favorite-contacts", JSON.stringify(next)); } catch { /* ignore */ }
            return next;
        });
    };

    const filteredCharacters = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return characters;
        return characters.filter(item => item.name.toLowerCase().includes(query) || numberFor(item).includes(query));
    }, [characters, numberFor, search]);

    const matchedByNumber = useMemo(() => {
        const digits = dialed.replace(/\D/g, "");
        if (digits.length < 3) return null;
        return characters.find(item => numberFor(item).replace(/\D/g, "").endsWith(digits)) || null;
    }, [characters, dialed, numberFor]);

    const missedLogs = logs.filter(item => item.type === "missed");

    const renderContent = () => {
        if (tab === "favorites") {
            const favoriteCharacters = characters.filter(item => favorites.includes(item.id));
            return (
                <div style={{ padding: "8px 16px 110px" }}>
                    {favoriteCharacters.length === 0 ? (
                        <EmptyHint text="还没有个人收藏。在通讯录里点星标，把在意的人放这里。" />
                    ) : favoriteCharacters.map(character => (
                        <ContactRow key={character.id} character={character} number={numberFor(character)} onCall={() => startCall(character)} onFavorite={() => toggleFavorite(character.id)} favorite />
                    ))}
                </div>
            );
        }
        if (tab === "recents") {
            return (
                <div style={{ padding: "8px 16px 110px" }}>
                    {logs.length === 0 ? <EmptyHint text="还没有通话记录。" /> : logs.map(log => (
                        <div key={log.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "0.5px solid var(--c-border, rgba(0,0,0,0.08))" }}>
                            <span style={{ color: "var(--c-text-secondary, #8a8a8a)", width: 16 }}>
                                {log.type === "missed" ? <PhoneMissed size={15} color="#d9534f" /> : log.type === "incoming" ? <PhoneIncoming size={15} /> : <PhoneOutgoing size={15} />}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 16, color: log.type === "missed" ? "#d9534f" : "var(--c-text)" }}>{log.characterName}</div>
                                <div style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)", marginTop: 2 }}>
                                    {log.type === "missed" ? "未接来电" : log.durationSec > 0 ? `通话 ${formatDuration(log.durationSec)}` : "已呼出"} · {formatWhen(log.startedAt)}
                                </div>
                            </div>
                            <button type="button" aria-label="回拨" onClick={() => { const character = characters.find(item => item.id === log.characterId); if (character) startCall(character); }} style={iconButtonStyle}>
                                <Phone size={18} />
                            </button>
                        </div>
                    ))}
                    {logs.length > 0 && (
                        <button type="button" className="ui-btn ui-btn-outline" style={{ marginTop: 16, width: "100%" }} onClick={() => { clearPhoneCallLogs(); setLogs([]); onNotice?.("已清空通话记录"); }}>清空通话记录</button>
                    )}
                </div>
            );
        }
        if (tab === "contacts") {
            return (
                <div style={{ padding: "8px 16px 110px" }}>
                    <SearchBox value={search} onChange={setSearch} placeholder="搜索通讯录" />
                    {filteredCharacters.length === 0 ? <EmptyHint text="没有匹配的联系人。" /> : filteredCharacters.map(character => (
                        <ContactRow
                            key={character.id}
                            character={character}
                            number={numberFor(character)}
                            favorite={favorites.includes(character.id)}
                            onCall={() => startCall(character)}
                            onFavorite={() => toggleFavorite(character.id)}
                        />
                    ))}
                </div>
            );
        }
        if (tab === "keypad") {
            return (
                <div style={{ padding: "16px 24px 110px", display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
                    <div style={{ minHeight: 52, fontSize: 34, letterSpacing: 2, fontWeight: 300, color: "var(--c-text)" }}>{dialed || "\u00A0"}</div>
                    <div style={{ height: 18, fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)", marginBottom: 12 }}>
                        {matchedByNumber ? matchedByNumber.name : dialed ? "没有匹配的联系人" : ""}
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 76px)", gap: 14, marginTop: "auto" }}>
                        {["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"].map(key => (
                            <button
                                key={key}
                                type="button"
                                onClick={() => setDialed(prev => (prev.length < 16 ? prev + key : prev))}
                                style={{
                                    width: 76, height: 76, borderRadius: "50%", border: "none", cursor: "pointer",
                                    background: "var(--c-card-bg, rgba(255,255,255,0.72))",
                                    color: "var(--c-text)", fontSize: 28, fontWeight: 300,
                                }}
                            >{key}</button>
                        ))}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 22, width: "100%", justifyContent: "center" }}>
                        <span style={{ width: 40 }} />
                        <button
                            type="button"
                            disabled={!matchedByNumber}
                            onClick={() => matchedByNumber && startCall(matchedByNumber)}
                            style={{
                                width: 76, height: 76, borderRadius: "50%", border: "none",
                                cursor: matchedByNumber ? "pointer" : "not-allowed",
                                background: matchedByNumber ? "#4cd964" : "rgba(120,120,120,0.25)",
                                color: "#fff", display: "flex", alignItems: "center", justifyContent: "center",
                            }}
                            aria-label="拨打"
                        ><Phone size={30} /></button>
                        <button type="button" onClick={() => setDialed(prev => prev.slice(0, -1))} style={{ ...iconButtonStyle, width: 40 }} aria-label="删除">
                            <Delete size={22} />
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <div style={{ padding: "8px 16px 110px" }}>
                <div style={{ fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)", margin: "6px 0 10px" }}>未接来电可以在通话结束后查看并留言。</div>
                {missedLogs.length === 0 ? <EmptyHint text="没有未接来电。" /> : missedLogs.map(log => {
                    const character = characters.find(item => item.id === log.characterId);
                    return (
                        <div key={log.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: "0.5px solid var(--c-border, rgba(0,0,0,0.08))" }}>
                            <PhoneMissed size={16} color="#d9534f" />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 16 }}>{log.characterName}</div>
                                <div style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>{formatWhen(log.startedAt)}</div>
                            </div>
                            {character && (
                                <button type="button" className="ui-btn ui-btn-outline" style={{ padding: "4px 12px", fontSize: 13 }} onClick={() => startCall(character)}>回拨</button>
                            )}
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div data-app-css="phone" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--c-page-body-bg, #f7f7f9)", overflow: "hidden" }}>
            <AppCustomCSS appId="phone" />
            <header style={{ padding: "calc(env(safe-area-inset-top, 0px) + 46px) 16px 6px", display: "flex", alignItems: "center", gap: 10 }}>
                <button type="button" onClick={onClose} style={{ ...iconButtonStyle, marginLeft: -6 }} aria-label="返回"><ChevronLeft size={24} /></button>
                <span style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5 }}>
                    {tab === "favorites" ? "个人收藏" : tab === "recents" ? "最近通话" : tab === "contacts" ? "通讯录" : tab === "keypad" ? "拨号键盘" : "语音留言"}
                </span>
            </header>
            <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>{renderContent()}</div>

            <nav style={{
                position: "absolute", left: 0, right: 0, bottom: 0,
                display: "flex", justifyContent: "space-around", alignItems: "center",
                padding: "8px 4px calc(env(safe-area-inset-bottom, 0px) + 6px)",
                background: "color-mix(in srgb, var(--c-card-bg, #ffffff) 86%, transparent)",
                backdropFilter: "blur(18px)", borderTop: "0.5px solid var(--c-border, rgba(0,0,0,0.1))",
            }}>
                {TABS.map(item => {
                    const active = tab === item.id;
                    return (
                        <button
                            key={item.id}
                            type="button"
                            onClick={() => setTab(item.id)}
                            style={{
                                flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                                background: "none", border: "none", cursor: "pointer",
                                color: active ? "var(--c-primary, #0a84ff)" : "var(--c-text-secondary, #8a8a8a)", fontSize: 10,
                                position: "relative",
                            }}
                        >
                            {item.icon}
                            <span>{item.label}</span>
                            {item.id === "voicemail" && missedLogs.length > 0 && (
                                <span style={{ position: "absolute", top: -2, right: "24%", minWidth: 16, height: 16, borderRadius: 8, background: "#ff3b30", color: "#fff", fontSize: 10, lineHeight: "16px", textAlign: "center", padding: "0 4px" }}>{missedLogs.length}</span>
                            )}
                        </button>
                    );
                })}
            </nav>

            {call && <CallOverlay state={call} onHangup={hangUp} onAnswer={answerCall} onDecline={declineCall} />}
        </div>
    );
}

function CallOverlay({ state, onHangup, onAnswer, onDecline }: { state: CallState; onHangup: () => void; onAnswer: () => void; onDecline: () => void }) {
    const status = state.phase === "incoming" ? "手机来电" : state.phase === "calling" ? "正在呼叫…" : formatDuration(state.seconds);
    return (
        <div style={{ position: "absolute", inset: 0, zIndex: 20, background: "linear-gradient(180deg, #1c1c1e 0%, #2c2c2e 60%, #1c1c1e 100%)", color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", paddingTop: "calc(env(safe-area-inset-top, 0px) + 80px)" }}>
            <div style={{ fontSize: 13, opacity: 0.7, letterSpacing: 1 }}>{state.phase === "incoming" ? "手机来电 · 未接听" : "系统电话"}</div>
            <div style={{ marginTop: 18, borderRadius: "50%", overflow: "hidden", width: 104, height: 104, background: "rgba(255,255,255,0.12)" }}>
                <Avatar src={characterAvatar(state.character)} name={state.character.name} size="lg" />
            </div>
            <div style={{ fontSize: 28, fontWeight: 500, marginTop: 16 }}>{state.character.name}</div>
            <div style={{ opacity: 0.75, marginTop: 8, fontSize: 15 }}>{status}</div>
            <div style={{ marginTop: "auto", marginBottom: "calc(env(safe-area-inset-bottom, 0px) + 64px)", display: "flex", gap: 60 }}>
                {state.phase === "incoming" ? (
                    <>
                        <RoundButton color="#ff3b30" label="拒绝" onClick={onDecline}><Phone size={26} /></RoundButton>
                        <RoundButton color="#4cd964" label="接听" onClick={onAnswer}><Phone size={26} /></RoundButton>
                    </>
                ) : (
                    <RoundButton color="#ff3b30" label="挂断" onClick={onHangup}><Phone size={26} style={{ transform: "rotate(135deg)" }} /></RoundButton>
                )}
            </div>
        </div>
    );
}

function RoundButton({ color, label, onClick, children }: { color: string; label: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <button type="button" onClick={onClick} style={{ width: 72, height: 72, borderRadius: "50%", border: "none", background: color, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }}>{children}</button>
            <span style={{ fontSize: 12, opacity: 0.8 }}>{label}</span>
        </div>
    );
}

function ContactRow({ character, number, favorite, onCall, onFavorite }: { character: Character; number: string; favorite: boolean; onCall: () => void; onFavorite: () => void }) {
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "0.5px solid var(--c-border, rgba(0,0,0,0.08))" }}>
            <Avatar src={characterAvatar(character)} name={character.name} />
            <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16 }}>{character.name}</div>
                <div style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>{number}</div>
            </div>
            <button type="button" aria-label="收藏" onClick={onFavorite} style={{ ...iconButtonStyle, color: favorite ? "#ffb400" : "var(--c-text-secondary, #8a8a8a)" }}><Star size={18} fill={favorite ? "#ffb400" : "none"} /></button>
            <button type="button" aria-label="拨打" onClick={onCall} style={{ ...iconButtonStyle, color: "#34c759" }}><Phone size={18} /></button>
        </div>
    );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
    return (
        <label style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(118,118,128,0.12)", borderRadius: 10, padding: "8px 10px", marginBottom: 8 }}>
            <Search size={16} color="var(--c-text-secondary, #8a8a8a)" />
            <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{ flex: 1, background: "none", border: "none", outline: "none", fontSize: 15, color: "var(--c-text)" }} />
        </label>
    );
}

function EmptyHint({ text }: { text: string }) {
    return <div style={{ padding: "48px 16px", textAlign: "center", fontSize: 14, color: "var(--c-text-secondary, #8a8a8a)" }}>{text}</div>;
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
