// 线下「久无动静」→ 线上主动提醒。
// 线下模式默认静默线上主动消息；但如果线下已经很久没有任何新动静，
// 允许角色回线上发一条消息找人（每个「久无动静」周期只发一次）。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";
import { loadChatOfflineTurns } from "./chat-offline-storage";
import {
    getSessionOfflineEnteredAt,
    getSessionOfflineLastPingAt,
    isSessionOfflineMode,
    markSessionOfflinePing,
} from "./chat-offline-mode";

const SETTINGS_KEY = "ai_phone_chat_offline_ping_v1";
registerKvMigration(SETTINGS_KEY);

export type OfflinePingConfig = {
    enabled: boolean;
    /** 线下安静多久后允许线上提醒（分钟） */
    minutes: number;
};

const DEFAULT_CONFIG: OfflinePingConfig = { enabled: true, minutes: 60 };

export function loadOfflinePingConfig(): OfflinePingConfig {
    if (typeof window === "undefined") return { ...DEFAULT_CONFIG };
    try {
        const parsed = JSON.parse(kvGet(SETTINGS_KEY) || "{}") as Partial<OfflinePingConfig>;
        const minutes = Number(parsed.minutes);
        return {
            enabled: parsed.enabled !== false,
            minutes: Number.isFinite(minutes) ? Math.min(1440, Math.max(1, Math.round(minutes))) : DEFAULT_CONFIG.minutes,
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

export function saveOfflinePingConfig(config: OfflinePingConfig): void {
    if (typeof window === "undefined") return;
    try {
        const minutes = Math.min(1440, Math.max(1, Math.round(Number(config.minutes) || DEFAULT_CONFIG.minutes)));
        kvSet(SETTINGS_KEY, JSON.stringify({ enabled: config.enabled !== false, minutes }));
    } catch {
        /* ignore */
    }
}

function lastOfflineActivityAt(sessionId: string): number {
    const turns = loadChatOfflineTurns(sessionId);
    for (let index = turns.length - 1; index >= 0; index -= 1) {
        const time = new Date(turns[index].createdAt).getTime();
        if (Number.isFinite(time)) return time;
    }
    return 0;
}

/**
 * 线下期间是否应该放行一条线上主动消息。
 * 返回 true 时会记下本次放行时刻，保证一个沉寂周期只提醒一次。
 */
export function shouldAllowOfflineOnlinePing(sessionId: string): boolean {
    if (!isSessionOfflineMode(sessionId)) return true;
    const config = loadOfflinePingConfig();
    if (!config.enabled) return false;
    const anchor = Math.max(
        lastOfflineActivityAt(sessionId),
        getSessionOfflineEnteredAt(sessionId),
        getSessionOfflineLastPingAt(sessionId),
    );
    if (!anchor) return false;
    if (Date.now() - anchor < config.minutes * 60 * 1000) return false;
    markSessionOfflinePing(sessionId);
    return true;
}
