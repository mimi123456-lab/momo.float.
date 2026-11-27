// lib/story-chat-sync.ts
// 剧情 App ⇄ 聊天室 的实时同步层。
//
// 背景：剧情 App 的会话和聊天室的会话是两套存储；线上聊天过去只能等「记忆总结」
// 才知道剧情，滞后甚至根本不触发。这里把剧情 App 每次生成的正文压成一条
// 轻量事件存起来，聊天室在组装提示词时直接读取，做到「下一句线上消息就知道」。
//
// 只存最近 20 条、每条截断，避免把整段剧情塞进提示词。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StorySyncRole = "user" | "assistant";

export type StorySyncEvent = {
    role: StorySyncRole;
    text: string;
    at: string;
};

const STORAGE_KEY = "ai_phone_story_chat_sync_v1";
const MAX_EVENTS = 20;
const MAX_EVENT_CHARS = 320;
const MAX_PROMPT_CHARS = 1600;

registerKvMigration(STORAGE_KEY);

function loadAll(): Record<string, StorySyncEvent[]> {
    try {
        const raw = kvGet(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const result: Record<string, StorySyncEvent[]> = {};
        for (const [characterId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(value)) continue;
            result[characterId] = value.filter((item): item is StorySyncEvent => {
                if (!item || typeof item !== "object") return false;
                const event = item as Partial<StorySyncEvent>;
                return typeof event.text === "string" && typeof event.at === "string";
            }).map(item => ({
                role: item.role === "user" ? "user" : "assistant",
                text: item.text,
                at: item.at,
            }));
        }
        return result;
    } catch {
        return {};
    }
}

function saveAll(all: Record<string, StorySyncEvent[]>): void {
    try {
        kvSet(STORAGE_KEY, JSON.stringify(all));
    } catch { /* 存不下时不影响剧情生成 */ }
}

/** 清掉展示/提示词不需要的标签与空白，只留叙事正文。 */
export function cleanStorySyncText(input: string): string {
    let text = String(input || "");
    text = text.replace(/<script[\s\S]*?<\/script>/gi, " ");
    text = text.replace(/<style[\s\S]*?<\/style>/gi, " ");
    text = text.replace(/```[\s\S]*?```/g, " ");
    // 状态栏是剧情 App 内的展示数据（好感度/穿搭等），不进线上记忆；只同步叙事正文。
    text = text.replace(/\[(?:状态栏|status)\][\s\S]*?\[\/(?:状态栏|status)\]/gi, " ");
    text = text.replace(/\[\/?(?:状态栏|status)\]/gi, " ");
    text = text.replace(/<[^>]+>/g, " ");
    text = text.replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&");
    text = text.replace(/^#{1,6}\s*/gm, " ");
    text = text.replace(/\s+/g, " ").trim();
    return text.length > MAX_EVENT_CHARS ? text.slice(0, MAX_EVENT_CHARS) + "…" : text;
}

/** 记录一条剧情事件（剧情 App 每次生成后调用）。 */
export function recordStorySyncEvent(characterId: string, role: StorySyncRole, content: string): void {
    const text = cleanStorySyncText(content);
    if (!characterId || text.length < 2) return;
    const all = loadAll();
    const events = all[characterId] ?? [];
    const last = events[events.length - 1];
    if (last && last.text === text && last.role === role) return;
    events.push({ role, text, at: new Date().toISOString() });
    all[characterId] = events.slice(-MAX_EVENTS);
    saveAll(all);
}

export function clearStorySyncEvents(characterId: string): void {
    const all = loadAll();
    if (!all[characterId]) return;
    delete all[characterId];
    saveAll(all);
}

type BackfillMessage = {
    role: string;
    rawContent?: string;
    renderedContent?: string;
    createdAt?: string;
};

/**
 * 老剧情没有同步记录时，用最近几条消息回填一次，
 * 这样功能上线后不需要重新聊一段，线上才能立刻接上上下文。
 * 已有 ≥3 条记录就不动，避免每次打开都覆盖实时记录。
 */
export function backfillStorySync(characterId: string, messages: BackfillMessage[]): void {
    if (!characterId) return;
    const all = loadAll();
    if ((all[characterId]?.length ?? 0) >= 3) return;
    const events: StorySyncEvent[] = [];
    for (const message of messages.slice(-8)) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const text = cleanStorySyncText(message.renderedContent || message.rawContent || "");
        if (text.length < 2) continue;
        events.push({
            role: message.role,
            text,
            at: message.createdAt || new Date().toISOString(),
        });
    }
    if (events.length === 0) return;
    all[characterId] = events.slice(-MAX_EVENTS);
    saveAll(all);
}

function formatTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 聊天室提示词用：最近剧情事件。
 * 从最新往前取，总长度控制在 MAX_PROMPT_CHARS，再按时间顺序输出。
 */
export function buildStorySyncPrompt(characterId: string): string {
    const events = loadAll()[characterId] ?? [];
    if (events.length === 0) return "";
    const picked: StorySyncEvent[] = [];
    let total = 0;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        total += event.text.length;
        if (total > MAX_PROMPT_CHARS && picked.length > 0) break;
        picked.unshift(event);
    }
    if (picked.length === 0) return "";
    return [
        "<story_sync>",
        "## 剧情实时进展（与聊天室共用同一份记忆）",
        "以下是你在剧情里刚刚真实经历过的事（按时间顺序）：",
        ...picked.map(event => `- [${formatTime(event.at)}] ${event.role === "user" ? "用户" : "你"}：${event.text}`),
        "线上聊天时你已经知道这些事：不要问“发生了什么/之前怎么样”，也不要机械复述；除非用户主动提起，否则自然接当前话题。",
        "</story_sync>",
    ].join("\n");
}
