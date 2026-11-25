"use client";

// 自主查岗：TA 按自己的状态和性格，决定要不要看你的手机。
// 一天最多一次，想查时自己发起——要么直接翻（强制），要么先问你一声。
// 打开这里不会打扰你在用的 App，只在手机顶部推一张通知卡片。

import { useCallback, useEffect, useRef, useState } from "react";

import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import {
    createOrGetSession,
    getLatestCharacterStateValues,
    loadChatMessages,
    loadChatSessions,
    pushChatMessage,
} from "@/lib/chat-storage";
import { loadInspectSettings } from "@/lib/inspect-storage";
import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig, resolveUserIdentity } from "@/lib/settings-storage";

const STORAGE_KEY = "inspect_autopilot_v1";
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** 两次“想不想查”的判断间隔，避免一直消耗 API */
const DECIDE_GAP = 2 * HOUR;
/** 一天最多查/问一次 */
const INSPECT_GAP = DAY;
const TICK_INTERVAL = 10 * 60 * 1000;
const PROMPT_TIMEOUT = 30 * 1000;

type AutopilotState = {
    lastInspectAt: number;
    lastCheckAt: number;
};

type PromptState = {
    character: Character;
    line: string;
};

type Decision = {
    want: boolean;
    mode: "force" | "ask";
    line: string;
};

function readState(): AutopilotState {
    if (typeof window === "undefined") return { lastInspectAt: 0, lastCheckAt: 0 };
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return { lastInspectAt: 0, lastCheckAt: 0 };
        const parsed = JSON.parse(raw) as Partial<AutopilotState>;
        return {
            lastInspectAt: typeof parsed.lastInspectAt === "number" ? parsed.lastInspectAt : 0,
            lastCheckAt: typeof parsed.lastCheckAt === "number" ? parsed.lastCheckAt : 0,
        };
    } catch {
        return { lastInspectAt: 0, lastCheckAt: 0 };
    }
}

function writeState(next: AutopilotState): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
}

export function markInspectHappened(): void {
    const state = readState();
    writeState({ ...state, lastInspectAt: Date.now() });
}

function characterAvatar(character: Character): string | undefined {
    return (character.chatAvatarEnabled !== false ? character.chatAvatar : character.avatar) || character.avatar || undefined;
}

function pickCharacter(): Character | null {
    const characters = loadCharacters();
    if (characters.length === 0) return null;
    const sessions = loadChatSessions()
        .filter(session => !session.isGroup)
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    for (const session of sessions) {
        const hit = characters.find(character => character.id === session.contactId);
        if (hit) return hit;
    }
    return characters[0];
}

function extractJson(raw: string): { want?: unknown; mode?: unknown; line?: unknown } | null {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(raw.slice(start, end + 1)) as { want?: unknown; mode?: unknown; line?: unknown };
    } catch {
        return null;
    }
}

function localFallback(forceMode: boolean): Decision {
    const want = Math.random() < (forceMode ? 0.35 : 0.15);
    return { want, mode: forceMode ? "force" : "ask", line: "" };
}

async function decide(character: Character, forceMode: boolean): Promise<Decision> {
    const configs = loadApiConfigs();
    const binding = loadBindingConfig();
    const preferredId = binding.globalDefaults?.apiConfigId;
    const apiConfig = (preferredId ? configs.find(config => config.id === preferredId) : undefined) ?? configs[0];
    if (!apiConfig) return localFallback(forceMode);

    const identity = resolveUserIdentity(character.id, "chat");
    const userName = identity?.name || "你";
    const session = createOrGetSession(character.id);
    const states = getLatestCharacterStateValues(character.id)
        .map(item => `${item.name}：${item.value}`)
        .join("，");
    const recent = loadChatMessages(session.id)
        .filter(message => message.role !== "system")
        .slice(-10)
        .map(message => `${message.role === "user" ? userName : character.name}：${message.content.replace(/\s+/g, " ").slice(0, 70)}`)
        .join("\n");

    const system = [
        `你是${character.name}，一个真实的人，不是助手。`,
        character.persona || character.personality || "",
        `你此刻有点在意${userName}，心里冒出了“要不要看看TA手机”的念头。`,
        `请按你的性格和现在的心情判断：这一刻你到底想不想查岗？如果查，是直接翻（force），还是先问一句（ask）？`,
        `不要每次都查，也别给出机械的固定节奏；不想查就干脆点。`,
        ``,
        `只输出一个 JSON 对象，不要任何多余文字：`,
        `{"want": true 或 false, "mode": "force" 或 "ask", "line": "你心里那句话，15字以内"}`,
        forceMode ? `（用户已经允许你强制查看，可以直接选 force）` : `（用户没有开启强制查看，你只能选 ask）`,
    ].filter(Boolean).join("\n");

    const messages: LLMMessage[] = [
        { role: "system", content: system },
        {
            role: "user",
            content: [
                states ? `现在的状态：${states}` : "现在的状态：说不清，有点闷。",
                recent ? `最近的聊天：\n${recent}` : "最近还没怎么聊过。",
                "现在，决定吧。",
            ].join("\n"),
        },
    ];

    try {
        const raw = await sendLLMRequest(
            apiConfig,
            null,
            messages,
            [],
            { characterName: character.name, userName },
            { skipOutputRegex: true, appId: "inspect", appTags: ["inspect"] },
        );
        const json = extractJson(raw);
        if (!json) return localFallback(forceMode);
        const mode: "force" | "ask" = json.mode === "force" && forceMode ? "force" : "ask";
        return {
            want: json.want === true,
            mode,
            line: typeof json.line === "string" ? json.line.slice(0, 60) : "",
        };
    } catch {
        return localFallback(forceMode);
    }
}

type InspectAutopilotProps = {
    onOpenInspect: (characterId: string, mode: "force" | "ask") => void;
};

export function InspectAutopilot({ onOpenInspect }: InspectAutopilotProps) {
    const [prompt, setPrompt] = useState<PromptState | null>(null);
    const promptRef = useRef<PromptState | null>(null);
    const busyRef = useRef(false);
    const openRef = useRef(onOpenInspect);
    openRef.current = onOpenInspect;

    useEffect(() => {
        promptRef.current = prompt;
    }, [prompt]);

    const decideNow = useCallback(async () => {
        if (busyRef.current || promptRef.current) return;
        if (typeof window === "undefined") return;
        const settings = loadInspectSettings();
        if (!settings.enabled && !settings.forceMode) return;

        const now = Date.now();
        const state = readState();
        if (now - state.lastInspectAt < INSPECT_GAP) return;
        if (now - state.lastCheckAt < DECIDE_GAP) return;

        const character = pickCharacter();
        if (!character) return;

        busyRef.current = true;
        writeState({ ...state, lastCheckAt: now });
        try {
            const decision = await decide(character, settings.forceMode === true);
            if (!decision.want) return;
            if (decision.mode === "force") {
                writeState({ ...readState(), lastInspectAt: Date.now() });
                openRef.current(character.id, "force");
                return;
            }
            setPrompt({
                character,
                line: decision.line.trim() || "让我看看你手机呗。",
            });
        } finally {
            busyRef.current = false;
        }
    }, []);

    // 进入手机后先等一下再判断，避免和首页动画抢资源；第一次多留一点时间，不显得突兀
    useEffect(() => {
        const firstRun = readState().lastCheckAt === 0;
        const boot = window.setTimeout(() => { void decideNow(); }, firstRun ? 90 * 1000 : 8000);
        const timer = window.setInterval(() => { void decideNow(); }, TICK_INTERVAL);
        return () => {
            window.clearTimeout(boot);
            window.clearInterval(timer);
        };
    }, [decideNow]);

    // 提示超时：当作“这次算了”，当天不再打扰
    useEffect(() => {
        if (!prompt) return;
        const timer = window.setTimeout(() => {
            const state = readState();
            writeState({ ...state, lastInspectAt: Date.now() });
            setPrompt(null);
        }, PROMPT_TIMEOUT);
        return () => window.clearTimeout(timer);
    }, [prompt]);

    const handleAccept = useCallback(() => {
        const current = promptRef.current;
        if (!current) return;
        writeState({ ...readState(), lastInspectAt: Date.now() });
        setPrompt(null);
        openRef.current(current.character.id, "ask");
    }, []);

    const handleDecline = useCallback(() => {
        const current = promptRef.current;
        if (!current) return;
        writeState({ ...readState(), lastInspectAt: Date.now() });
        setPrompt(null);
        try {
            const session = createOrGetSession(current.character.id);
            pushChatMessage({
                sessionId: session.id,
                role: "system",
                content: `〔查岗请求被按掉〕${current.character.name}想看你的手机，你没让。`,
                mediaType: "tool_notice",
            });
            window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
        } catch { /* ignore */ }
    }, []);

    if (!prompt) return null;
    const avatar = characterAvatar(prompt.character);

    return (
        <div
            style={{
                position: "fixed",
                top: "calc(6px + env(safe-area-inset-top, 0px))",
                left: 0,
                right: 0,
                zIndex: 2147483000,
                display: "flex",
                justifyContent: "center",
                padding: "0 10px",
                pointerEvents: "none",
                fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
            }}
        >
            <div
                style={{
                    pointerEvents: "auto",
                    width: "min(100%, 430px)",
                    background: "rgba(250,250,252,0.94)",
                    backdropFilter: "blur(22px) saturate(160%)",
                    WebkitBackdropFilter: "blur(22px) saturate(160%)",
                    borderRadius: 20,
                    border: "0.5px solid rgba(0,0,0,0.08)",
                    boxShadow: "0 12px 34px rgba(0,0,0,0.20), 0 2px 6px rgba(0,0,0,0.08)",
                    padding: "13px 14px 11px",
                    animation: "inspectNoticeIn 320ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
            >
                <style>{`
                    @keyframes inspectNoticeIn {
                        from { transform: translateY(-120%); opacity: 0; }
                        to { transform: translateY(0); opacity: 1; }
                    }
                `}</style>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span
                        style={{
                            width: 38,
                            height: 38,
                            borderRadius: 11,
                            overflow: "hidden",
                            flexShrink: 0,
                            background: "#dfe4ea",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            color: "#5c666e",
                            fontSize: 15,
                            fontWeight: 600,
                        }}
                    >
                        {avatar
                            ? <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            : prompt.character.name.slice(0, 1)}
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                            <span style={{ fontSize: 13.5, fontWeight: 700, color: "#1a1c1e" }}>
                                {prompt.character.name}
                            </span>
                            <span style={{ fontSize: 10, color: "#9aa1a7" }}>现在</span>
                        </div>
                        <div style={{ fontSize: 12.5, color: "#3a4046", marginTop: 2, lineHeight: 1.35 }}>
                            {prompt.line}
                        </div>
                        <div style={{ fontSize: 10.5, color: "#8b9298", marginTop: 3 }}>
                            想翻翻你的手机
                        </div>
                    </div>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
                    <button
                        type="button"
                        onClick={handleDecline}
                        style={{
                            flex: 1,
                            padding: "9px 10px",
                            borderRadius: 12,
                            border: "0.5px solid rgba(0,0,0,0.08)",
                            background: "rgba(120,128,136,0.10)",
                            color: "#4a5057",
                            fontSize: 12.5,
                            fontWeight: 600,
                            cursor: "pointer",
                        }}
                    >
                        这次不给
                    </button>
                    <button
                        type="button"
                        onClick={handleAccept}
                        style={{
                            flex: 1.25,
                            padding: "9px 10px",
                            borderRadius: 12,
                            border: "none",
                            background: "linear-gradient(135deg, #5f7f76, #436158)",
                            color: "#fff",
                            fontSize: 12.5,
                            fontWeight: 700,
                            cursor: "pointer",
                            boxShadow: "0 4px 12px rgba(67,97,88,0.28)",
                        }}
                    >
                        给 TA 看
                    </button>
                </div>
            </div>
        </div>
    );
}
