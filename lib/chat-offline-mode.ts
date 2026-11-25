// 线下模式状态（按会话持久化）。
// 线上/线下是同一个会话的两种视图：线下模式开启期间，后台主动/追发消息应暂停，
// 但不要清掉已有预约——退出线下后应能继续按原节奏触发。

import { kvGet, kvSet } from "./kv-db";

export const CHAT_OFFLINE_MODE_PREFIX = "chat-offline-mode:";
const CHAT_OFFLINE_ENTERED_PREFIX = "chat-offline-entered:";
const CHAT_OFFLINE_LAST_PING_PREFIX = "chat-offline-last-ping:";

export function isSessionOfflineMode(sessionId: string): boolean {
    if (typeof window === "undefined") return false;
    try {
        return kvGet(CHAT_OFFLINE_MODE_PREFIX + sessionId) === "1";
    } catch {
        return false;
    }
}

export function setSessionOfflineMode(sessionId: string, offline: boolean): void {
    if (typeof window === "undefined") return;
    try {
        kvSet(CHAT_OFFLINE_MODE_PREFIX + sessionId, offline ? "1" : "0");
        // 记录进入线下的时刻，用于「久无动静」计时；退出时清空。
        kvSet(CHAT_OFFLINE_ENTERED_PREFIX + sessionId, offline ? String(Date.now()) : "");
        if (!offline) kvSet(CHAT_OFFLINE_LAST_PING_PREFIX + sessionId, "");
    } catch {
        /* 存不下不影响当前视图切换 */
    }
}

export function getSessionOfflineEnteredAt(sessionId: string): number {
    if (typeof window === "undefined") return 0;
    const raw = Number(kvGet(CHAT_OFFLINE_ENTERED_PREFIX + sessionId));
    return Number.isFinite(raw) ? raw : 0;
}

export function getSessionOfflineLastPingAt(sessionId: string): number {
    if (typeof window === "undefined") return 0;
    const raw = Number(kvGet(CHAT_OFFLINE_LAST_PING_PREFIX + sessionId));
    return Number.isFinite(raw) ? raw : 0;
}

export function markSessionOfflinePing(sessionId: string, at: number = Date.now()): void {
    if (typeof window === "undefined") return;
    try { kvSet(CHAT_OFFLINE_LAST_PING_PREFIX + sessionId, String(at)); } catch { /* ignore */ }
}
