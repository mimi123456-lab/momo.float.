"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { Toggle } from "@/components/ui/form";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { createOrGetSession, loadChatSessions, pushChatMessage } from "@/lib/chat-storage";
import { resolveUserIdentity } from "@/lib/settings-storage";
import { generateInspectionPlan } from "@/lib/inspect-engine";
import { executeInspectAction } from "@/lib/inspect-executor";
import { renderInspectScreenshot } from "@/lib/inspect-screenshot";
import {
    INSPECT_APP_IDS,
    INSPECT_APP_LABELS,
    addInspectLog,
    clearInspectLogs,
    loadInspectLogs,
    loadInspectSettings,
    saveInspectSettings,
    setInspectLogReaction,
    type InspectAppId,
    type InspectLog,
    type InspectSettings,
    type InspectSnapshot,
} from "@/lib/inspect-storage";
import { InspectLiveScreen } from "./inspect-live-screen";

const ACCENT = "#5f7f76";
const ACCENT_DEEP = "#436158";
const MIST = "#5a7285";
const TEXT_MAIN = "#33474a";
const TEXT_SUB = "#7c8a86";
const TEXT_FAINT = "#95a29e";
const CARD_BG = "rgba(255, 255, 255, 0.74)";
const CARD_BORDER = "rgba(95, 127, 118, 0.18)";
const DIVIDER = "rgba(95, 127, 118, 0.12)";

const FIRST_AUTO_DELAY_MS = 6000;
const AUTO_REPEAT_MS = 120000;

type WatchingState = {
    characterId: string;
    characterName: string;
    logs: InspectLog[];
    index: number;
    finished: boolean;
    silent?: boolean;
};

function cardStyle(extra?: CSSProperties): CSSProperties {
    return {
        background: CARD_BG,
        border: `1px solid ${CARD_BORDER}`,
        borderRadius: 16,
        padding: "14px 16px",
        boxSizing: "border-box",
        ...extra,
    };
}

function softButtonStyle(color: string, background: string): CSSProperties {
    return {
        flex: 1,
        padding: "9px 10px",
        borderRadius: 10,
        border: "none",
        background,
        color,
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
    };
}

function formatLogTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const now = new Date();
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.toDateString() === now.toDateString()) return time;
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
}

function formatInspectRecord(log: InspectLog): string {
    const detail = log.detail ? `\n${log.detail}` : "";
    let shot = "";
    if (log.snapshot?.screen === "chat-thread" && log.snapshot.messages?.length) {
        shot = "\n" + log.snapshot.messages.slice(-4)
            .map(message => `${message.from === "user" ? "你" : log.snapshot?.title || "TA"}：${message.text}`)
            .join("\n");
    } else if (log.snapshot?.rows?.length) {
        shot = "\n" + log.snapshot.rows.slice(0, 3)
            .map(row => `· ${row.title}${row.subtitle ? `：${row.subtitle}` : ""}`)
            .join("\n");
    }
    return `〔查岗实录〕${log.appLabel} · ${log.summary}${detail}${shot}`;
}

function syncInspectToChat(characterId: string, text: string) {
    const session = createOrGetSession(characterId);
    pushChatMessage({ sessionId: session.id, role: "system", content: text, mediaType: "tool_notice" });
    return session;
}

function pickDefaultCharacterId(characters: Character[]): string {
    if (characters.length === 0) return "";
    const sessions = loadChatSessions()
        .filter(session => !session.isGroup)
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const session of sessions) {
        const hit = characters.find(character => character.id === session.contactId);
        if (hit) return hit.id;
    }
    return characters[0].id;
}

function idleSnapshot(characterName: string): InspectSnapshot {
    return {
        screen: "home",
        title: "手机",
        emptyHint: `${characterName} 正握着你的手机`,
    };
}

function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <div style={{
            padding: "0 4px",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: 1.6,
            color: ACCENT,
            textTransform: "uppercase",
        }}>
            {children}
        </div>
    );
}

export function InspectApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [settings, setSettings] = useState<InspectSettings>(() => loadInspectSettings());
    const [logs, setLogs] = useState<InspectLog[]>(() => loadInspectLogs());
    const [characters, setCharacters] = useState<Character[]>(() => loadCharacters());
    const [selectedCharacterId, setSelectedCharacterId] = useState("");
    const [generating, setGenerating] = useState(false);
    const [error, setError] = useState("");
    const [forceMode, setForceMode] = useState(() => loadInspectSettings().forceMode === true);
    const [watching, setWatching] = useState<WatchingState | null>(null);
    const [chatHintSessionId, setChatHintSessionId] = useState<string | null>(null);

    const syncedRef = useRef(false);
    const autoDelayRef = useRef(FIRST_AUTO_DELAY_MS);
    const userNameRef = useRef("你");

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        setSelectedCharacterId(prev => (prev && chars.some(item => item.id === prev) ? prev : pickDefaultCharacterId(chars)));
        setLogs(loadInspectLogs());
        userNameRef.current = resolveUserIdentity()?.name || "你";
        const timers = [500, 1600].map(ms => window.setTimeout(() => {
            const next = loadCharacters();
            setCharacters(next);
            setSelectedCharacterId(prev => (prev && next.some(item => item.id === prev) ? prev : pickDefaultCharacterId(next)));
        }, ms));
        return () => timers.forEach(timer => window.clearTimeout(timer));
    }, []);

    const persistSettings = (next: InspectSettings) => {
        setSettings(next);
        saveInspectSettings(next);
    };

    const toggleEnabled = (enabled: boolean) => {
        persistSettings({ ...settings, enabled });
    };

    const toggleApp = (appId: InspectAppId, allowed: boolean) => {
        const allowedAppIds = INSPECT_APP_IDS.filter(id => (
            id === appId ? allowed : settings.allowedAppIds.includes(id)
        ));
        persistSettings({ ...settings, allowedAppIds });
    };

    const toggleForceMode = (next: boolean) => {
        setForceMode(next);
        persistSettings({ ...settings, forceMode: next });
        autoDelayRef.current = FIRST_AUTO_DELAY_MS;
    };

    const selectedCharacter = characters.find(item => item.id === selectedCharacterId)
        || characters[0]
        || null;

    const runInspection = useCallback(async (options?: { handedOver?: boolean; auto?: boolean }) => {
        const character = characters.find(item => item.id === selectedCharacterId) || characters[0];
        if (!character) {
            setError("还没有角色，先去创建一个吧");
            return;
        }
        if (!options?.handedOver && !options?.auto) {
            if (!forceMode) {
                if (!settings.enabled) {
                    setError("查岗已关闭，请先打开总开关");
                    return;
                }
                if (settings.allowedAppIds.length === 0) {
                    setError("请至少允许一个 App");
                    return;
                }
            }
        }
        setGenerating(true);
        setError("");
        try {
            const recentChatSession = loadChatSessions()
                .filter(session => session.contactId === character.id && !session.isGroup)[0];
            const recentChat = recentChatSession?.lastMessagePreview || undefined;
            const plan = await generateInspectionPlan({
                characterId: character.id,
                characterName: character.name,
                persona: character.persona || character.personality || "",
                allowedAppIds: forceMode ? [...INSPECT_APP_IDS] : settings.allowedAppIds,
                userName: userNameRef.current,
                recentChat,
                handedOver: options?.handedOver === true,
            });
            if (plan.logs.length === 0) {
                if (!options?.auto) setError("TA 这次没翻到什么");
                return;
            }
            const created = plan.logs.map(action => addInspectLog(executeInspectAction({
                action,
                characterId: character.id,
                characterName: character.name,
                userName: userNameRef.current,
            })));
            setLogs(loadInspectLogs());
            syncedRef.current = false;
            setChatHintSessionId(null);
            setWatching({
                characterId: character.id,
                characterName: character.name,
                logs: created,
                index: 0,
                finished: false,
            });
            autoDelayRef.current = AUTO_REPEAT_MS;
        } catch (err) {
            if (!options?.auto) setError(err instanceof Error ? err.message : "查岗失败，请稍后再试");
        } finally {
            setGenerating(false);
        }
    }, [characters, selectedCharacterId, forceMode, settings]);

    // 实时回放：一条一条翻，画面同步
    useEffect(() => {
        if (!watching || watching.finished) return;
        const delay = watching.index === 0 ? 1100 : 2300;
        const timer = window.setTimeout(() => {
            const nextIndex = watching.index + 1;
            if (nextIndex >= watching.logs.length) {
                if (!watching.silent && !syncedRef.current) {
                    syncedRef.current = true;
                    const bothered = watching.logs.some(log => log.emotion === "jealous" || log.emotion === "angry" || log.emotion === "sad");
                    const head = bothered
                        ? `〔查岗实录〕${watching.characterName}翻完你的手机，脸色不太对。\n`
                        : `〔查岗实录〕${watching.characterName}翻完了你的手机。\n`;
                    const session = syncInspectToChat(
                        watching.characterId,
                        head + watching.logs.map(formatInspectRecord).join("\n"),
                    );
                    // TA 顺手截了张图，丢进聊天里
                    const shotLog = [...watching.logs].reverse().find(log => log.snapshot?.screen === "chat-thread" && (log.snapshot.messages?.length ?? 0) > 0)
                        || [...watching.logs].reverse().find(log => log.snapshot);
                    const dataUrl = shotLog?.snapshot ? renderInspectScreenshot(shotLog.snapshot) : null;
                    if (dataUrl) {
                        pushChatMessage({
                            sessionId: session.id,
                            role: "assistant",
                            content: "",
                            mediaType: "image",
                            mediaUrl: dataUrl,
                        });
                    }
                    window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
                    setChatHintSessionId(session.id);
                }
                setWatching({ ...watching, index: nextIndex, finished: true });
                return;
            }
            setWatching({ ...watching, index: nextIndex });
        }, delay);
        return () => window.clearTimeout(timer);
    }, [watching]);

    // 强制查岗：TA 自己会隔一会儿来翻一次（看完这一轮后也会再等下一轮）
    const watchingActive = Boolean(watching && !watching.finished);
    useEffect(() => {
        if (!forceMode || characters.length === 0) return;
        if (watchingActive || generating) return;
        const timer = window.setTimeout(() => {
            void runInspection({ auto: true });
        }, autoDelayRef.current);
        return () => window.clearTimeout(timer);
    }, [forceMode, characters.length, watchingActive, generating, runInspection]);

    const interruptWatch = () => {
        const state = watching;
        if (!state) return;
        const seen = state.logs.slice(0, state.index);
        const text = seen.length > 0
            ? `〔查岗中断〕你突然把手机从${state.characterName}手里抽走，TA 只看了一半：\n${seen.map(formatInspectRecord).join("\n")}`
            : `〔查岗中断〕你突然把手机从${state.characterName}手里抽走，TA 还没看到什么。`;
        const session = syncInspectToChat(state.characterId, text);
        window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
        setChatHintSessionId(session.id);
        setWatching(null);
        onNotice?.("已打断查岗，TA 在微信里说话了");
    };

    const openHintChat = () => {
        if (!chatHintSessionId) return;
        window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat", sessionId: chatHintSessionId } }));
        setChatHintSessionId(null);
        setWatching(null);
    };

    const handleConfront = (log: InspectLog) => {
        setInspectLogReaction(log.id, "confront");
        setLogs(loadInspectLogs());
        const text = `〔我当面问 TA〕我看见你刚才翻我手机了。${log.appLabel}：${log.summary}。你想问什么，直接问我。`;
        const session = syncInspectToChat(log.characterId, text);
        window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
        onNotice?.("已当面质问 TA");
    };

    const handleIgnore = (log: InspectLog) => {
        setInspectLogReaction(log.id, "ignore");
        setLogs(loadInspectLogs());
        onNotice?.("已装作没看见");
    };

    const handleClear = () => {
        clearInspectLogs();
        setLogs([]);
        onNotice?.("已清空查岗记录");
    };

    const sortedLogs = [...logs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const currentSnapshot = watching && watching.index > 0
        ? watching.logs[Math.min(watching.index, watching.logs.length) - 1]?.snapshot
        : undefined;

    return (
        <div
            data-app-css="inspect"
            style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                flexDirection: "column",
                background: "var(--c-page-body-bg, #f7f4ef)",
            }}
        >
            <AppCustomCSS appId="inspect" />
            <PageShell
                title="查岗"
                onBack={onClose}
                rightAction={(
                    <button
                        type="button"
                        onClick={handleClear}
                        disabled={logs.length === 0}
                        style={{
                            border: "none",
                            background: "transparent",
                            padding: "0 8px",
                            fontSize: 12.6,
                            fontWeight: 500,
                            color: logs.length === 0 ? TEXT_FAINT : ACCENT,
                            cursor: logs.length === 0 ? "default" : "pointer",
                        }}
                    >
                        清空
                    </button>
                )}
            >
                <div className="page-menu" style={{ paddingTop: 12, paddingBottom: 48, gap: 18 }}>
                    <div style={cardStyle({
                        background: "linear-gradient(135deg, rgba(124, 147, 168, 0.16), rgba(95, 127, 118, 0.10))",
                    })}>
                        <div style={{ fontSize: 12.6, fontWeight: 600, color: ACCENT_DEEP }}>查岗说明</div>
                        <div style={{ marginTop: 7, fontSize: 12, lineHeight: 1.65, color: TEXT_SUB }}>
                            TA 会拿起你的手机，实时翻给你看——你看到的画面就是 TA 此刻真在看的：真的微信会话、真的朋友圈、真的订单。
                            改备注、发朋友圈、下单都会真的写进你的手机。
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <SectionLabel>现在查岗</SectionLabel>
                        <div style={cardStyle()}>
                            <div style={{ fontSize: 11.5, color: TEXT_SUB, marginBottom: 8 }}>以谁的身份翻看</div>
                            <select
                                className="ui-select"
                                value={selectedCharacter?.id || ""}
                                onChange={(event) => setSelectedCharacterId(event.target.value)}
                                disabled={characters.length === 0}
                            >
                                {characters.length === 0 ? (
                                    <option value="">还没有角色</option>
                                ) : characters.map(character => (
                                    <option key={character.id} value={character.id}>{character.name}</option>
                                ))}
                            </select>

                            <button
                                type="button"
                                className="ui-btn"
                                onClick={() => void runInspection({ handedOver: true })}
                                disabled={generating || characters.length === 0 || Boolean(watching)}
                                style={{
                                    width: "100%",
                                    marginTop: 12,
                                    background: ACCENT,
                                    color: "#fff",
                                    boxShadow: "0 4px 14px rgba(95, 127, 118, 0.28)",
                                }}
                            >
                                {generating ? "TA 正在拿起手机…" : "把手机递给 TA"}
                            </button>

                            <div style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 12,
                                marginTop: 12,
                                paddingTop: 12,
                                borderTop: `1px solid ${DIVIDER}`,
                            }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 12.4, fontWeight: 600, color: TEXT_MAIN }}>强制查岗</div>
                                    <div style={{ marginTop: 3, fontSize: 11, color: TEXT_FAINT }}>
                                        打开后 TA 会自己隔一会儿来翻一次，不用你点
                                    </div>
                                </div>
                                <Toggle checked={forceMode} onChange={toggleForceMode} />
                            </div>
                            {forceMode ? (
                                <div style={{
                                    marginTop: 10,
                                    padding: "8px 10px",
                                    borderRadius: 10,
                                    background: "rgba(95, 127, 118, 0.10)",
                                    fontSize: 11.5,
                                    lineHeight: 1.55,
                                    color: ACCENT_DEEP,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                }}>
                                    <span style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: "50%",
                                        background: ACCENT,
                                        animation: "inspect-breathe 1.8s ease-in-out infinite",
                                    }} />
                                    TA 随时可能自己拿起你的手机…
                                    <style>{`@keyframes inspect-breathe { 0%,100% { opacity: .3; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.15); } }`}</style>
                                </div>
                            ) : null}
                            {error ? (
                                <div style={{ marginTop: 8, fontSize: 11.5, color: "#b4544d", lineHeight: 1.5 }}>{error}</div>
                            ) : null}
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <SectionLabel>查岗权限</SectionLabel>
                        <div style={cardStyle()}>
                            <div style={{
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 12,
                                paddingBottom: 12,
                                borderBottom: `1px solid ${DIVIDER}`,
                            }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 12.6, fontWeight: 600, color: TEXT_MAIN }}>允许查岗</div>
                                    <div style={{ marginTop: 3, fontSize: 11, color: TEXT_FAINT }}>关闭后 TA 不会翻你的手机</div>
                                </div>
                                <Toggle checked={settings.enabled} onChange={toggleEnabled} />
                            </div>
                            {INSPECT_APP_IDS.map((appId, index) => {
                                const checked = settings.allowedAppIds.includes(appId);
                                return (
                                    <div
                                        key={appId}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            justifyContent: "space-between",
                                            gap: 12,
                                            padding: "10px 0",
                                            borderTop: index === 0 ? "none" : `1px solid ${DIVIDER}`,
                                            opacity: settings.enabled ? 1 : 0.5,
                                        }}
                                    >
                                        <span style={{ fontSize: 12.4, color: TEXT_MAIN }}>{INSPECT_APP_LABELS[appId]}</span>
                                        <Toggle
                                            checked={checked}
                                            onChange={(next) => toggleApp(appId, next)}
                                            disabled={!settings.enabled}
                                        />
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <SectionLabel>查岗记录</SectionLabel>
                        {sortedLogs.length === 0 ? (
                            <div style={cardStyle({ textAlign: "center", padding: "28px 16px" })}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#5f716c" }}>还没有查岗记录</div>
                                <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: TEXT_FAINT }}>
                                    把手机递给 TA，或者打开强制查岗。
                                </div>
                            </div>
                        ) : sortedLogs.map(log => (
                            <div key={log.id} style={cardStyle()}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <span style={{ fontSize: 12.6, fontWeight: 600, color: TEXT_MAIN }}>{log.characterName}</span>
                                    <span style={{ fontSize: 11.5, color: TEXT_SUB }}>{log.appLabel}</span>
                                    <span style={{
                                        fontSize: 10.5,
                                        fontWeight: 600,
                                        padding: "2px 8px",
                                        borderRadius: 999,
                                        background: log.kind === "view" ? "rgba(124, 147, 168, 0.16)" : "rgba(95, 127, 118, 0.18)",
                                        color: log.kind === "view" ? MIST : ACCENT_DEEP,
                                    }}>
                                        {log.kind === "view" ? "查看" : "改动"}
                                    </span>
                                    <span style={{ marginLeft: "auto", fontSize: 10.5, color: TEXT_FAINT }}>
                                        {formatLogTime(log.createdAt)}
                                    </span>
                                </div>
                                <div style={{ marginTop: 8, fontSize: 12.6, lineHeight: 1.55, color: "#3d4f4b" }}>{log.summary}</div>
                                {log.detail ? (
                                    <div style={{
                                        marginTop: 6,
                                        padding: "8px 10px",
                                        borderRadius: 10,
                                        background: "rgba(124, 147, 168, 0.08)",
                                        fontSize: 11.5,
                                        lineHeight: 1.6,
                                        color: "#6b7a76",
                                        whiteSpace: "pre-wrap",
                                    }}>
                                        {log.detail}
                                    </div>
                                ) : null}
                                {log.reaction ? (
                                    <div style={{ marginTop: 10, fontSize: 11, color: log.reaction === "confront" ? ACCENT_DEEP : TEXT_FAINT }}>
                                        {log.reaction === "confront" ? "已当面质问" : "装作没看见"}
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                                        <button
                                            type="button"
                                            onClick={() => handleConfront(log)}
                                            style={softButtonStyle(ACCENT_DEEP, "rgba(95, 127, 118, 0.13)")}
                                        >
                                            当面问他
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => handleIgnore(log)}
                                            style={softButtonStyle("#6f8188", "rgba(124, 147, 168, 0.13)")}
                                        >
                                            装作没看见
                                        </button>
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            </PageShell>

            {chatHintSessionId && !watching ? (
                <button
                    type="button"
                    onClick={openHintChat}
                    style={{
                        position: "absolute",
                        left: 16,
                        right: 16,
                        bottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)",
                        border: "none",
                        borderRadius: 14,
                        padding: "12px 14px",
                        background: "rgba(38, 48, 45, 0.94)",
                        color: "#fff",
                        fontSize: 12.6,
                        textAlign: "left",
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        boxShadow: "0 10px 26px rgba(0,0,0,0.25)",
                    }}
                >
                    <span style={{ flex: 1 }}>TA 在微信里发来消息</span>
                    <span style={{ fontSize: 12, color: "#bfe3d4", fontWeight: 600 }}>去聊天</span>
                </button>
            ) : null}

            {watching ? (
                <InspectLiveScreen
                    snapshot={currentSnapshot || idleSnapshot(watching.characterName)}
                    characterName={watching.characterName}
                    step={watching.index}
                    total={watching.logs.length}
                    finished={watching.finished}
                    hasChatHint={Boolean(chatHintSessionId)}
                    onClose={() => setWatching(null)}
                    onInterrupt={interruptWatch}
                    onGoChat={openHintChat}
                />
            ) : null}
        </div>
    );
}
