// lib/story-photo-trigger.ts
// 剧情 App 里角色「主动拍照」：她在正文里输出隐藏标记，
// 我们再负责出图、把照片作为一条消息放进对话，并让下一轮剧情/聊天室知道照片内容。

import { generateImageFromConfiguredApi } from "./image-generation-service";
import { pushStoryMessage, type StoryMessage } from "./story-storage";

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

/** 根据描述判断要不要带角色/用户参考图锁脸。 */
export function resolveStoryPhotoReferences(description: string): {
    useReferenceImage: boolean;
    includeUserReferenceImage: boolean;
} {
    const couple = /(合照|合影|两个人|双人|同框|我们|一起)/.test(description);
    const userOnly = /(你|用户|对方)/.test(description);
    const self = /(她|自己|自拍)/.test(description);
    return {
        useReferenceImage: couple || self,
        includeUserReferenceImage: couple || userOnly,
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
 * 生成一张剧情照片并作为系统样式消息插入当前剧情会话。
 * - rawContent 很短（“她拍了张照片：描述”），会进入后续剧情提示词；
 * - renderedContent 是图片卡片，只在界面上展示，不进提示词。
 */
export async function generateStoryPhotoMessage(params: {
    sessionId: string;
    characterId: string;
    description: string;
    signal?: AbortSignal;
}): Promise<StoryMessage | null> {
    const description = params.description.trim();
    if (!description) return null;
    const references = resolveStoryPhotoReferences(description);
    const generated = await generateImageFromConfiguredApi({
        description,
        characterId: params.characterId,
        appId: "story",
        useReferenceImage: references.useReferenceImage,
        includeUserReferenceImage: references.includeUserReferenceImage,
        signal: params.signal,
    });
    if (!generated) return null;

    const caption = "她拍了张照片";
    const html = [
        '<figure class="story-photo-card">',
        `<img src="${generated.dataUrl}" alt="${escapeHtml(description.slice(0, 80))}" loading="lazy" />`,
        `<figcaption>${escapeHtml(caption)} · ${escapeHtml(description.slice(0, 120))}</figcaption>`,
        "</figure>",
    ].join("");
    return pushStoryMessage({
        sessionId: params.sessionId,
        role: "system",
        rawContent: `（她拍了张照片：${description}）`,
        renderedContent: html,
    });
}
