// 线下模式专用文风：仅在线下生成时注入，不影响线上聊天与剧情。
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STYLE_KEY = "ai_phone_chat_offline_style_v1";
registerKvMigration(STYLE_KEY);

export function loadOfflineStylePrompt(): string {
    if (typeof window === "undefined") return "";
    try {
        return kvGet(STYLE_KEY) || "";
    } catch {
        return "";
    }
}

export function saveOfflineStylePrompt(text: string): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(STYLE_KEY, text.slice(0, 4000));
    } catch {
        /* ignore */
    }
}
