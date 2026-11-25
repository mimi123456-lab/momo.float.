import { kvGet, kvSet } from "@/lib/kv-db";

/** 系统短信（独立于微信）的会话与消息。 */
export type SmsMessage = {
    id: string;
    role: "user" | "character";
    body: string;
    createdAt: string;
};

export type SmsThread = {
    characterId: string;
    characterName: string;
    updatedAt: string;
    messages: SmsMessage[];
};

const SMS_THREADS_KEY = "ai_phone_sms_threads_v1";

export function loadSmsThreads(): SmsThread[] {
    try {
        const parsed = JSON.parse(kvGet(SMS_THREADS_KEY) || "[]");
        return Array.isArray(parsed) ? (parsed as SmsThread[]).filter(t => t && t.characterId) : [];
    } catch {
        return [];
    }
}

function saveSmsThreads(list: SmsThread[]): void {
    kvSet(SMS_THREADS_KEY, JSON.stringify(list));
}

export function getSmsThread(characterId: string): SmsThread | null {
    return loadSmsThreads().find(t => t.characterId === characterId) || null;
}

export function appendSmsMessage(characterId: string, characterName: string, role: "user" | "character", body: string): SmsMessage {
    const now = new Date().toISOString();
    const message: SmsMessage = {
        id: `sms_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        role,
        body,
        createdAt: now,
    };
    const threads = loadSmsThreads();
    const index = threads.findIndex(t => t.characterId === characterId);
    if (index >= 0) {
        threads[index] = {
            ...threads[index],
            characterName,
            updatedAt: now,
            messages: [...threads[index].messages, message],
        };
    } else {
        threads.push({ characterId, characterName, updatedAt: now, messages: [message] });
    }
    saveSmsThreads(threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    return message;
}

export function deleteSmsThread(characterId: string): void {
    saveSmsThreads(loadSmsThreads().filter(t => t.characterId !== characterId));
}
