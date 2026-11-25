import { kvGet, kvSet } from "@/lib/kv-db";

/** 系统电话（独立于微信）的通话记录。 */
export type PhoneCallLog = {
    id: string;
    characterId: string;
    characterName: string;
    number: string;
    type: "outgoing" | "incoming" | "missed";
    startedAt: string;
    durationSec: number;
};

const CALL_LOG_KEY = "ai_phone_call_logs_v1";
const CALL_LOG_LIMIT = 200;

export function loadPhoneCallLogs(): PhoneCallLog[] {
    try {
        const parsed = JSON.parse(kvGet(CALL_LOG_KEY) || "[]");
        return Array.isArray(parsed) ? parsed as PhoneCallLog[] : [];
    } catch {
        return [];
    }
}

export function savePhoneCallLogs(list: PhoneCallLog[]): void {
    kvSet(CALL_LOG_KEY, JSON.stringify(list.slice(0, CALL_LOG_LIMIT)));
}

export function addPhoneCallLog(input: Omit<PhoneCallLog, "id" | "startedAt"> & { startedAt?: string }): PhoneCallLog {
    const log: PhoneCallLog = {
        ...input,
        id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        startedAt: input.startedAt || new Date().toISOString(),
    };
    savePhoneCallLogs([log, ...loadPhoneCallLogs()]);
    return log;
}

export function clearPhoneCallLogs(): void {
    kvSet(CALL_LOG_KEY, "[]");
}

/** 给角色生成一个稳定的“手机号”，优先用角色卡里的微信号（手机号格式）。 */
export function resolvePhoneNumber(characterId: string, wechatID?: string): string {
    if (wechatID && /^[\d\-+\s]{6,20}$/.test(wechatID)) return wechatID;
    let hash = 0;
    for (let i = 0; i < characterId.length; i += 1) hash = (hash * 31 + characterId.charCodeAt(i)) >>> 0;
    const tail = String(hash % 100000000).padStart(8, "0");
    return `1${(hash % 9) + 3}${tail.slice(0, 9)}`;
}
