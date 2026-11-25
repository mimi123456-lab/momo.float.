"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { Toggle } from "@/components/ui/form";
import { PageShell } from "@/components/ui/page-shell";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { createOrGetSession, pushChatMessage } from "@/lib/chat-storage";
import { generateInspectionPlan } from "@/lib/inspect-engine";
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
} from "@/lib/inspect-storage";

const ACCENT = "#5f7f76";
const ACCENT_DEEP = "#436158";
const MIST = "#5a7285";
const TEXT_MAIN = "#33474a";
const TEXT_SUB = "#7c8a86";
const TEXT_FAINT = "#95a29e";
const CARD_BG = "rgba(255, 255, 255, 0.74)";
const CARD_BORDER = "rgba(95, 127, 118, 0.18)";
const DIVIDER = "rgba(95, 127, 118, 0.12)";

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
    const action = log.kind === "view" ? "翻了你的" : "动了你的";
    const detail = log.detail ? `\n${log.detail}` : "";
    return `〔查岗实录〕TA ${action}${log.appLabel}：${log.summary}${detail}`;
}

function syncInspectToChat(characterId: string, text: string) {
    const session = createOrGetSession(characterId);
    pushChatMessage({ sessionId: session.id, role: "system", content: text, mediaType: "tool_notice" });
    return session;
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

    useEffect(() => {
        const chars = loadCharacters();
        setCharacters(chars);
        setSelectedCharacterId(prev => prev || chars[0]?.id || "");
        setLogs(loadInspectLogs());
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

    const handleGenerate = async () => {
        const character = characters.find(item => item.id === selectedCharacterId);
        if (!character) {
            setError("请先选择一个角色");
            return;
        }
        if (!settings.enabled) {
            setError("查岗已关闭，请先打开总开关");
            return;
        }
        if (settings.allowedAppIds.length === 0) {
            setError("请至少允许一个 App");
            return;
        }
        setGenerating(true);
        setError("");
        try {
            const plan = await generateInspectionPlan({
                characterId: character.id,
                characterName: character.name,
                persona: character.persona || character.personality || "",
                allowedAppIds: settings.allowedAppIds,
            });
            if (plan.logs.length === 0) {
                setError("TA 这次没有翻到什么");
                return;
            }
            const created = plan.logs.map(action => addInspectLog({
                characterId: character.id,
                characterName: character.name,
                appId: action.appId,
                appLabel: INSPECT_APP_LABELS[action.appId],
                kind: action.kind,
                summary: action.summary,
                detail: action.detail,
            }));
            setLogs(loadInspectLogs());
            syncInspectToChat(character.id, created.map(formatInspectRecord).join("\n\n"));
            onNotice?.(`${character.name} 查岗了 ${created.length} 条记录`);
        } catch (err) {
            setError(err instanceof Error ? err.message : "查岗失败，请稍后再试");
        } finally {
            setGenerating(false);
        }
    };

    const handleConfront = (log: InspectLog) => {
        setInspectLogReaction(log.id, "confront");
        setLogs(loadInspectLogs());
        const action = log.kind === "view" ? `翻了你的${log.appLabel}` : `动了你的${log.appLabel}`;
        const text = `〔我当面问 TA〕我看到了你刚才翻我手机，${action}：${log.summary}。我可以当面问你吗？`;
        const session = syncInspectToChat(log.characterId, text);
        if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
        }
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
                            TA 会像翻你手机一样查看你允许的 App；每次查看或改动都会以录屏记录同步到聊天。
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
                        <SectionLabel>现在查岗</SectionLabel>
                        <div style={cardStyle()}>
                            <div style={{ fontSize: 11.5, color: TEXT_SUB, marginBottom: 8 }}>选择以谁的身份翻看</div>
                            <select
                                className="ui-select"
                                value={selectedCharacterId}
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
                                onClick={handleGenerate}
                                disabled={generating || characters.length === 0}
                                style={{
                                    width: "100%",
                                    marginTop: 12,
                                    background: ACCENT,
                                    color: "#fff",
                                    boxShadow: "0 4px 14px rgba(95, 127, 118, 0.28)",
                                }}
                            >
                                {generating ? "正在翻看…" : "让 TA 现在查岗"}
                            </button>
                            {error ? (
                                <div style={{ marginTop: 8, fontSize: 11.5, color: "#b4544d", lineHeight: 1.5 }}>{error}</div>
                            ) : null}
                        </div>
                    </div>

                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <SectionLabel>查岗记录</SectionLabel>
                        {sortedLogs.length === 0 ? (
                            <div style={cardStyle({ textAlign: "center", padding: "28px 16px" })}>
                                <div style={{ fontSize: 13, fontWeight: 600, color: "#5f716c" }}>还没有查岗记录</div>
                                <div style={{ marginTop: 6, fontSize: 11.5, lineHeight: 1.6, color: TEXT_FAINT }}>
                                    选一个角色，让 TA 翻翻你的手机。
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
        </div>
    );
}
