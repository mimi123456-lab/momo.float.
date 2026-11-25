// lib/inspect-storage.ts
// 「查岗」App 的设置与记录存储。

import { kvGet, kvSet } from "@/lib/kv-db";

export type InspectAppId =
    | "chat"
    | "moments"
    | "forum"
    | "shopping"
    | "photos"
    | "sms"
    | "phone"
    | "music"
    | "notes";

export type InspectLog = {
    id: string;
    characterId: string;
    characterName: string;
    createdAt: string;
    appId: InspectAppId;
    appLabel: string;
    kind: "view" | "change";   // 查看 / 改动
    summary: string;           // 一句话：翻了什么 / 改了什么
    detail?: string;           // 更细的过程，可多行
    reaction?: "confront" | "ignore"; // 用户处理方式
};

export type InspectSettings = {
    enabled: boolean;
    allowedAppIds: InspectAppId[];
};

export const INSPECT_APP_LABELS: Record<InspectAppId, string> = {
    chat: "聊天",
    moments: "朋友圈",
    forum: "论坛",
    shopping: "购物",
    photos: "相册",
    sms: "短信",
    phone: "通话记录",
    music: "音乐",
    notes: "便签",
};

export const INSPECT_APP_IDS: InspectAppId[] = [
    "chat",
    "moments",
    "forum",
    "shopping",
    "photos",
    "sms",
    "phone",
    "music",
    "notes",
];

const SETTINGS_KEY = "ai_phone_inspect_settings_v1";
const LOGS_KEY = "ai_phone_inspect_logs_v1";
const MAX_LOGS = 200;

const DEFAULT_ALLOWED_APP_IDS: InspectAppId[] = [
    "chat",
    "moments",
    "forum",
    "shopping",
    "photos",
    "sms",
    "phone",
    "music",
];

function isInspectAppId(value: unknown): value is InspectAppId {
    return typeof value === "string" && (INSPECT_APP_IDS as string[]).includes(value);
}

export function getDefaultInspectSettings(): InspectSettings {
    return { enabled: true, allowedAppIds: [...DEFAULT_ALLOWED_APP_IDS] };
}

export function loadInspectSettings(): InspectSettings {
    if (typeof window === "undefined") return getDefaultInspectSettings();
    try {
        const raw = kvGet(SETTINGS_KEY);
        if (!raw) return getDefaultInspectSettings();
        const parsed = JSON.parse(raw) as Partial<InspectSettings> | null;
        if (!parsed || typeof parsed !== "object") return getDefaultInspectSettings();
        const allowed = Array.isArray(parsed.allowedAppIds)
            ? Array.from(new Set(parsed.allowedAppIds.filter(isInspectAppId)))
            : [...DEFAULT_ALLOWED_APP_IDS];
        return {
            enabled: parsed.enabled !== false,
            allowedAppIds: allowed,
        };
    } catch {
        return getDefaultInspectSettings();
    }
}

export function saveInspectSettings(settings: InspectSettings): void {
    if (typeof window === "undefined") return;
    const allowed = Array.isArray(settings.allowedAppIds)
        ? Array.from(new Set(settings.allowedAppIds.filter(isInspectAppId)))
        : [];
    kvSet(SETTINGS_KEY, JSON.stringify({ enabled: settings.enabled !== false, allowedAppIds: allowed }));
}

function normalizeLog(value: unknown): InspectLog | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Partial<InspectLog>;
    if (!isInspectAppId(raw.appId)) return null;
    if (typeof raw.id !== "string" || !raw.id) return null;
    if (typeof raw.characterId !== "string" || !raw.characterId) return null;
    if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;
    const kind = raw.kind === "change" ? "change" : "view";
    const reaction = raw.reaction === "confront" || raw.reaction === "ignore" ? raw.reaction : undefined;
    return {
        id: raw.id,
        characterId: raw.characterId,
        characterName: typeof raw.characterName === "string" && raw.characterName ? raw.characterName : "TA",
        createdAt: typeof raw.createdAt === "string" && raw.createdAt ? raw.createdAt : new Date().toISOString(),
        appId: raw.appId,
        appLabel: typeof raw.appLabel === "string" && raw.appLabel ? raw.appLabel : INSPECT_APP_LABELS[raw.appId],
        kind,
        summary: raw.summary,
        detail: typeof raw.detail === "string" && raw.detail.trim() ? raw.detail : undefined,
        reaction,
    };
}

export function loadInspectLogs(): InspectLog[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = kvGet(LOGS_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeLog)
            .filter((log): log is InspectLog => log !== null)
            .slice(0, MAX_LOGS);
    } catch {
        return [];
    }
}

export function saveInspectLogs(list: InspectLog[]): void {
    if (typeof window === "undefined") return;
    const normalized = (Array.isArray(list) ? list : [])
        .map(normalizeLog)
        .filter((log): log is InspectLog => log !== null)
        .slice(0, MAX_LOGS);
    kvSet(LOGS_KEY, JSON.stringify(normalized));
}

export type AddInspectLogInput = Omit<InspectLog, "id" | "createdAt"> & {
    id?: string;
    createdAt?: string;
};

export function addInspectLog(input: AddInspectLogInput): InspectLog {
    const log: InspectLog = {
        ...input,
        id: input.id || `inspect_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        createdAt: input.createdAt || new Date().toISOString(),
        appLabel: input.appLabel || INSPECT_APP_LABELS[input.appId],
    };
    const next = [log, ...loadInspectLogs()].slice(0, MAX_LOGS);
    saveInspectLogs(next);
    return log;
}

export function setInspectLogReaction(id: string, reaction: "confront" | "ignore"): void {
    const logs = loadInspectLogs();
    const index = logs.findIndex(log => log.id === id);
    if (index < 0) return;
    logs[index] = { ...logs[index], reaction };
    saveInspectLogs(logs);
}

export function clearInspectLogs(): void {
    saveInspectLogs([]);
}
