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

/** 查岗实时画面要渲染的“手机屏幕”。 */
export type InspectScreen =
    | "chat-list"
    | "chat-thread"
    | "moments"
    | "shopping"
    | "sms"
    | "sms-thread"
    | "calls"
    | "photos"
    | "home";

export type InspectSnapshotRow = {
    id: string;
    title: string;
    subtitle?: string;
    trailing?: string;
    /** 被手指指着的那一行 */
    focus?: boolean;
    /** 被改动的痕迹（高亮显示） */
    changed?: boolean;
    avatarUrl?: string;
    avatarText?: string;
};

export type InspectSnapshotMessage = {
    from: "user" | "character";
    text: string;
    focus?: boolean;
};

/** 真实数据快照：查岗时展示的就是用户手机里此刻的真实内容。 */
export type InspectSnapshot = {
    screen: InspectScreen;
    title: string;
    subtitle?: string;
    rows?: InspectSnapshotRow[];
    messages?: InspectSnapshotMessage[];
    /** 角色手指落点（行 id），缺省指向被 focus 的那行 */
    fingerRowId?: string;
    /** 指尖旁的小气泡，如「备注改成“小猪”」 */
    callout?: string;
    emptyHint?: string;
};

/** 角色这次动作的真实载荷（真读、真改）。 */
export type InspectActionType =
    | "view"
    | "open-chat"
    | "change-remark"
    | "post-moment"
    | "place-order";

export type InspectEmotion = "calm" | "curious" | "jealous" | "sad" | "angry";

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
    /** 具体动作类型 */
    action?: InspectActionType;
    /** 真实目标 id（会话 / 动态 / 订单 / 短信线程） */
    targetId?: string;
    /** 这一步在真机上的画面 */
    snapshot?: InspectSnapshot;
    /** TA 看完这一条时的心情 */
    emotion?: InspectEmotion;
};

export type InspectSettings = {
    enabled: boolean;
    allowedAppIds: InspectAppId[];
    /** 强制查岗：TA 会自己隔一会儿来翻一次，无视上面的权限 */
    forceMode?: boolean;
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
            forceMode: parsed.forceMode === true,
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
    kvSet(SETTINGS_KEY, JSON.stringify({
        enabled: settings.enabled !== false,
        allowedAppIds: allowed,
        forceMode: settings.forceMode === true,
    }));
}

const SCREENS: InspectScreen[] = ["chat-list", "chat-thread", "moments", "shopping", "sms", "sms-thread", "calls", "photos", "home"];
const ACTIONS: InspectActionType[] = ["view", "open-chat", "change-remark", "post-moment", "place-order"];
const EMOTIONS: InspectEmotion[] = ["calm", "curious", "jealous", "sad", "angry"];

function normalizeSnapshot(value: unknown): InspectSnapshot | undefined {
    if (!value || typeof value !== "object") return undefined;
    const raw = value as Partial<InspectSnapshot>;
    if (!raw.screen || !SCREENS.includes(raw.screen)) return undefined;
    if (typeof raw.title !== "string") return undefined;
    const rows = Array.isArray(raw.rows)
        ? raw.rows.flatMap((item): InspectSnapshotRow[] => {
            if (!item || typeof item !== "object") return [];
            const row = item as Partial<InspectSnapshotRow>;
            if (typeof row.id !== "string" || typeof row.title !== "string") return [];
            return [{
                id: row.id,
                title: row.title,
                subtitle: typeof row.subtitle === "string" ? row.subtitle : undefined,
                trailing: typeof row.trailing === "string" ? row.trailing : undefined,
                focus: row.focus === true,
                changed: row.changed === true,
                avatarUrl: typeof row.avatarUrl === "string" ? row.avatarUrl : undefined,
                avatarText: typeof row.avatarText === "string" ? row.avatarText : undefined,
            }];
        }).slice(0, 40)
        : undefined;
    const messages = Array.isArray(raw.messages)
        ? raw.messages.flatMap((item): InspectSnapshotMessage[] => {
            if (!item || typeof item !== "object") return [];
            const msg = item as Partial<InspectSnapshotMessage>;
            if (typeof msg.text !== "string") return [];
            return [{ from: msg.from === "character" ? "character" : "user", text: msg.text, focus: msg.focus === true }];
        }).slice(0, 40)
        : undefined;
    return {
        screen: raw.screen,
        title: raw.title,
        subtitle: typeof raw.subtitle === "string" ? raw.subtitle : undefined,
        rows,
        messages,
        fingerRowId: typeof raw.fingerRowId === "string" ? raw.fingerRowId : undefined,
        callout: typeof raw.callout === "string" ? raw.callout : undefined,
        emptyHint: typeof raw.emptyHint === "string" ? raw.emptyHint : undefined,
    };
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
        action: raw.action && ACTIONS.includes(raw.action) ? raw.action : undefined,
        targetId: typeof raw.targetId === "string" ? raw.targetId : undefined,
        snapshot: normalizeSnapshot(raw.snapshot),
        emotion: raw.emotion && EMOTIONS.includes(raw.emotion) ? raw.emotion : undefined,
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
