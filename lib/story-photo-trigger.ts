// lib/story-photo-trigger.ts
// 剧情 App 里角色「主动拍照」：她在正文里输出隐藏标记，
// 我们再负责出图、把照片作为一条消息放进对话，并让下一轮剧情/聊天室知道照片内容。

import { generateImageFromConfiguredApi } from "./image-generation-service";
import { loadStoryMessages, pushStoryMessage, replaceStoryMessages, type StoryMessage } from "./story-storage";

/** 放进剧情提示词里的指令；只在生图已配置时注入。 */
export const STORY_PHOTO_DIRECTIVE = [
    "<story_photo_command>",
    "## 主动拍照（可选动作）",
    "当剧情里你自然想记录这一刻、想自拍或想和对方合影时，可以主动拍一张照片。",
    "只有真的发生“拍照”这个动作时才输出；不要每轮都拍，不要为了凑功能而拍。",
    "在正文最后单独一行输出：",
    "【拍照】一句话画面描述：地点、画面里有谁（只有你 / 只有用户 / 两个人合照）、穿着、动作、表情、光线【/拍照】",
    "不要解释这个标记，也不要把它写进对白。",
    "</story_photo_command>",
].join("\n");

const PHOTO_MARKER = /【拍照】([\s\S]{1,600}?)【\/拍照】/;

export type StoryPhotoTrigger = {
    /** 去掉拍照标记后的正文 */
    text: string;
    /** 画面描述；没有拍照标记时为空串 */
    description: string;
};

export function extractStoryPhotoRequest(text: string): StoryPhotoTrigger {
    const source = String(text || "");
    const match = PHOTO_MARKER.exec(source);
    if (!match) return { text: source, description: "" };
    const description = match[1].replace(/\s+/g, " ").trim();
    return { text: source.replace(PHOTO_MARKER, "").trim(), description };
}

export type StoryPhotoSubject = "character" | "user" | "couple" | "scenery";

/**
 * 从画面描述判断主角是谁。
 * 关键词有优先级：合照 > 用户 > 她自己 > 默认角色。
 * 注意不能把「她」直接当成自拍——剧情叙述里「她举起手机拍你」很常见。
 */
export function detectStoryPhotoSubject(description: string): StoryPhotoSubject {
    const text = description.replace(/\s+/g, "");
    if (/(风景|空镜|景色|没有人|只有景|拍风景|只拍景)/.test(text) && !/(你|她|我们|合照)/.test(text)) {
        return "scenery";
    }
    if (/(合照|合影|两个人|双人|同框|我俩|我们俩|我们两个|你和我|我和你|你我|一起拍|一起照|拉着你|拉上你|和你拍)/.test(text)) {
        return "couple";
    }
    if (/(给你(拍|照)|拍下?了?你|拍你|你的照片|只拍你|只有你|抓拍你|偷拍你|给我拍|拍的我|我的照片|只拍用户|只有用户|用户一个人|对方)/.test(text)) {
        return "user";
    }
    if (/(自拍|拍自己|拍她自己|她的单人|只拍她|她自己|她的照片|拍她|只有她|她一个人|她单人|只有我|我一个人)/.test(text)) {
        return "character";
    }
    return "character";
}

/** 根据主角补充硬性画面约束，避免「给用户拍的照片」画成角色本人。 */
function photoSubjectInstruction(subject: StoryPhotoSubject): string {
    if (subject === "couple") {
        return "【画面主体】这张是合照：画面中必须同时出现她和用户两个人，两个不同人物，双人正脸清晰、比例正常，不要只画一个人，也不要混脸。";
    }
    if (subject === "user") {
        return "【画面主体】这张是她给用户拍的照片：画面中只出现用户一个人，她本人不在画面里。请严格按用户参考图还原用户的五官与性别，不要画成角色的样子。";
    }
    if (subject === "scenery") {
        return "【画面主体】这张只拍场景本身：不要出现任何人物，不要画她，也不要画用户。";
    }
    return "【画面主体】这张是她的照片：画面中只出现她一个人，按角色参考图保持五官一致。";
}

/** 根据描述判断要不要带角色/用户参考图锁脸。 */
export function resolveStoryPhotoReferences(description: string): {
    subject: StoryPhotoSubject;
    useReferenceImage: boolean;
    includeUserReferenceImage: boolean;
} {
    const subject = detectStoryPhotoSubject(description);
    return {
        subject,
        useReferenceImage: subject === "character" || subject === "couple",
        includeUserReferenceImage: subject === "user" || subject === "couple",
    };
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * 只负责出图：返回 dataUrl，便于手动拍照/长按重生成复用。
 * 生图未配置或失败时返回 null。
 */
export async function generateStoryPhotoData(params: {
    characterId: string;
    description: string;
    /** 手动拍照时由页签直接指定主角，避免上下文里出现「她/你」导致判断反转。 */
    subject?: StoryPhotoSubject;
    signal?: AbortSignal;
}): Promise<{ dataUrl: string; description: string } | null> {
    const description = params.description.trim();
    if (!description) return null;
    const subject = params.subject ?? detectStoryPhotoSubject(description);
    const references = {
        useReferenceImage: subject === "character" || subject === "couple",
        includeUserReferenceImage: subject === "user" || subject === "couple",
    };
    // 内存里仍保存原始描述；只把主体约束附加给生图模型。
    const imageDescription = `${description}\n\n${photoSubjectInstruction(subject)}`;
    const generated = await generateImageFromConfiguredApi({
        description: imageDescription,
        characterId: params.characterId,
        appId: "story",
        useReferenceImage: references.useReferenceImage,
        includeUserReferenceImage: references.includeUserReferenceImage,
        signal: params.signal,
    });
    if (!generated) return null;
    return { dataUrl: generated.dataUrl, description };
}

/** 照片卡片 HTML：只在界面展示，不进提示词。 */
export function buildStoryPhotoHtml(description: string, dataUrl: string): string {
    return [
        '<figure class="story-photo-card">',
        `<img src="${dataUrl}" alt="${escapeHtml(description.slice(0, 80))}" loading="lazy" />`,
        `<figcaption>${escapeHtml("她拍了张照片")} · ${escapeHtml(description.slice(0, 120))}</figcaption>`,
        "</figure>",
    ].join("");
}

/** 照片消息的短正文：会进入后续剧情提示词，让她记得照片内容。 */
export function storyPhotoMemoryText(description: string): string {
    return `（她拍了张照片：${description}）`;
}

/**
 * 生成一张剧情照片并作为系统样式消息插入当前剧情会话。
 * - rawContent 很短（“她拍了张照片：描述”），会进入后续剧情提示词；
 * - renderedContent 是图片卡片，只在界面上展示，不进提示词。
 */
export async function pushStoryPhotoMessage(params: {
    sessionId: string;
    characterId: string;
    description: string;
    signal?: AbortSignal;
}): Promise<StoryMessage | null> {
    const generated = await generateStoryPhotoData({
        characterId: params.characterId,
        description: params.description,
        signal: params.signal,
    });
    if (!generated) return null;
    return pushStoryMessage({
        sessionId: params.sessionId,
        role: "system",
        contextRole: "assistant",
        rawContent: storyPhotoMemoryText(generated.description),
        renderedContent: buildStoryPhotoHtml(generated.description, generated.dataUrl),
    });
}

/** 长按重生成：替换已有照片消息的图片与描述。 */
export function replaceStoryPhotoMessage(params: {
    sessionId: string;
    messageId: string;
    description: string;
    dataUrl: string;
}): boolean {
    const messages = loadStoryMessages(params.sessionId);
    let changed = false;
    const next = messages.map(message => {
        if (message.id !== params.messageId) return message;
        changed = true;
        return {
            ...message,
            rawContent: storyPhotoMemoryText(params.description),
            renderedContent: buildStoryPhotoHtml(params.description, params.dataUrl),
        };
    });
    if (changed) replaceStoryMessages(params.sessionId, next);
    return changed;
}
