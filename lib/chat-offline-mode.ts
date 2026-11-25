// 线下模式状态（按会话持久化）。
// 线上/线下是同一个会话的两种视图：线下模式开启期间，后台主动/追发消息应暂停，
// 但不要清掉已有预约——退出线下后应能继续按原节奏触发。

import { kvGet, kvSet } from "./kv-db";

export const CHAT_OFFLINE_MODE_PREFIX = "chat-offline-mode:";

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
    } catch {
        /* 存不下不影响当前视图切换 */
    }
}
