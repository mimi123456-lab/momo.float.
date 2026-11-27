// lib/voice-tone-profile.ts
// 语音语气档案：按角色保存「说话方式」，两处生效：
//   1. 聊天提示词：让文字台词本来就带口吻（自称、称谓、口头禅、句尾）；
//   2. TTS：根据文本情绪映射 MiniMax emotion，并按档案语速覆盖。
//
// 这是语气约束，不替代角色卡/世界书的人设。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type VoiceTonePace = "slow" | "normal" | "fast";

export type VoiceToneProfile = {
    /** 自称：我 / 人家 / 本小姐 */
    selfRef: string;
    /** 称呼对方：你 / 宝贝 / 笨蛋 */
    addressUser: string;
    /** 口头禅，逗号分隔 */
    catchphrases: string;
    /** 句尾习惯：啊 / 呢 / 嘛 / …… */
    endings: string;
    pace: VoiceTonePace;
    /** 情绪表达：生气时压低声音、开心时语速变快 */
    emotionStyle: string;
};

const STORAGE_KEY = "ai_phone_voice_tone_profile_v1";
registerKvMigration(STORAGE_KEY);

export const DEFAULT_VOICE_TONE_PROFILE: VoiceToneProfile = {
    selfRef: "",
    addressUser: "",
    catchphrases: "",
    endings: "",
    pace: "normal",
    emotionStyle: "",
};

const PACE_LABEL: Record<VoiceTonePace, string> = {
    slow: "偏慢",
    normal: "正常",
    fast: "偏快",
};

function normalizePace(value: unknown): VoiceTonePace {
    return value === "slow" || value === "fast" ? value : "normal";
}

function normalizeProfile(raw: unknown): VoiceToneProfile {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_VOICE_TONE_PROFILE };
    const value = raw as Partial<VoiceToneProfile>;
    return {
        selfRef: typeof value.selfRef === "string" ? value.selfRef : "",
        addressUser: typeof value.addressUser === "string" ? value.addressUser : "",
        catchphrases: typeof value.catchphrases === "string" ? value.catchphrases : "",
        endings: typeof value.endings === "string" ? value.endings : "",
        pace: normalizePace(value.pace),
        emotionStyle: typeof value.emotionStyle === "string" ? value.emotionStyle : "",
    };
}

function loadAll(): Record<string, VoiceToneProfile> {
    try {
        const raw = kvGet(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const result: Record<string, VoiceToneProfile> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            result[key] = normalizeProfile(value);
        }
        return result;
    } catch {
        return {};
    }
}

function isEmptyProfile(profile: VoiceToneProfile): boolean {
    return !profile.selfRef.trim()
        && !profile.addressUser.trim()
        && !profile.catchphrases.trim()
        && !profile.endings.trim()
        && !profile.emotionStyle.trim()
        && profile.pace === "normal";
}

export function loadVoiceToneProfile(characterId: string): VoiceToneProfile {
    return loadAll()[characterId] ?? { ...DEFAULT_VOICE_TONE_PROFILE };
}

export function saveVoiceToneProfile(characterId: string, patch: Partial<VoiceToneProfile>): VoiceToneProfile {
    const all = loadAll();
    const previous = all[characterId] ?? DEFAULT_VOICE_TONE_PROFILE;
    const next: VoiceToneProfile = {
        selfRef: (patch.selfRef ?? previous.selfRef).trim(),
        addressUser: (patch.addressUser ?? previous.addressUser).trim(),
        catchphrases: (patch.catchphrases ?? previous.catchphrases).trim(),
        endings: (patch.endings ?? previous.endings).trim(),
        pace: normalizePace(patch.pace ?? previous.pace),
        emotionStyle: (patch.emotionStyle ?? previous.emotionStyle).trim(),
    };
    if (isEmptyProfile(next)) {
        delete all[characterId];
        kvSet(STORAGE_KEY, JSON.stringify(all));
        return { ...DEFAULT_VOICE_TONE_PROFILE };
    }
    all[characterId] = next;
    kvSet(STORAGE_KEY, JSON.stringify(all));
    return next;
}

export function clearVoiceToneProfile(characterId: string): void {
    const all = loadAll();
    if (!all[characterId]) return;
    delete all[characterId];
    kvSet(STORAGE_KEY, JSON.stringify(all));
}

/** 提示词片段：全空返回 ""，避免给每个角色都塞无意义段落。 */
export function buildVoiceTonePrompt(characterId: string): string {
    const profile = loadVoiceToneProfile(characterId);
    if (isEmptyProfile(profile)) return "";
    const lines = [
        profile.selfRef ? `自称：${profile.selfRef}` : "",
        profile.addressUser ? `称呼对方：${profile.addressUser}` : "",
        profile.catchphrases ? `口头禅：${profile.catchphrases}` : "",
        profile.endings ? `句尾习惯：${profile.endings}` : "",
        `语速：${PACE_LABEL[profile.pace]}`,
        profile.emotionStyle ? `情绪表达：${profile.emotionStyle}` : "",
    ].filter(Boolean);
    return [
        "<voice_tone_profile>",
        "## 语音语气档案（说话方式，不是人设）",
        ...lines,
        "说话必须符合以上口吻；这是语气约束，不要解释这份档案，也不要生硬堆砌口头禅。",
        "</voice_tone_profile>",
    ].join("\n");
}

/** 文本情绪 → MiniMax emotion；语速来自角色档案（slow 0.9 / fast 1.12）。 */
export function detectSpeechEmotion(text: string, characterId?: string): { emotion?: string; speed?: number } {
    const value = text || "";
    let emotion: string | undefined;
    if (/(哭|呜+|泪|难过|委屈|想哭|好想哭|酸了)/.test(value)) emotion = "sad";
    else if (/(生气|气死|滚|讨厌|烦死|混蛋|过分)/.test(value)) emotion = "angry";
    else if (/(害怕|好怕|不敢|吓死|恐怖)/.test(value)) emotion = "fearful";
    else if (/(居然|竟然|真的假的|惊讶|天啊|不是吧)/.test(value)) emotion = "surprised";
    else if (/(哈哈|嘿嘿|开心|高兴|太好了|嘻嘻|笑死)/.test(value)) emotion = "happy";
    else if (/(算了|没事|平静|慢慢来|……)/.test(value)) emotion = "calm";

    const pace = characterId ? loadVoiceToneProfile(characterId).pace : "normal";
    const speed = pace === "slow" ? 0.9 : pace === "fast" ? 1.12 : undefined;
    return { emotion, speed };
}
