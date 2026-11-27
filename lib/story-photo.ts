// lib/story-photo.ts
// 剧情拍照：从「手动场景 + 最近线下剧情 + 最近聊天」拼出画面上下文，
// 再生成三种照片提示词（她的单人照 / 我的单人照 / 两人的合照）。
//
// 这里刻意不调用大模型：默认零延迟、零额外费用。需要更细的画面时，
// 由弹窗里的「AI 润色」按钮再走一次角色对话模型。

import { loadChatMessages } from "./chat-storage";
import { loadChatOfflineTurns } from "./chat-offline-storage";
import { getStoryScene } from "./chat-story-progress";

export type StoryPhotoKind = "character" | "user" | "couple";

function clip(text: string, limit: number): string {
    const value = text.replace(/\s+/g, " ").trim();
    return value.length > limit ? value.slice(0, limit) + "…" : value;
}

/**
 * 画面上下文：手动场景优先，其次最近 3 轮线下剧情，最后最近 6 条聊天。
 * 只保留文本，避免把图片 data URL 塞进提示词。
 */
export function buildStoryPhotoContext(sessionId: string): string {
    const parts: string[] = [];
    const manualScene = getStoryScene(sessionId).trim();
    if (manualScene) parts.push("当前场景（用户手动标注，优先）：" + manualScene);

    const turns = loadChatOfflineTurns(sessionId).slice(-3);
    turns.forEach((turn, index) => {
        const text = clip([turn.userContent, turn.assistantContent].filter(Boolean).join(" "), 260);
        if (text) parts.push(`最近线下剧情 ${index + 1}：${text}`);
    });

    const messages = loadChatMessages(sessionId)
        .slice(-6)
        .filter(message => !message.isRetracted && message.status !== "failed")
        .map(message => {
            if (message.role !== "user" && message.role !== "assistant") return "";
            const text = clip(message.content || message.mediaData?.label || "", 160);
            if (!text) return "";
            return `${message.role === "user" ? "用户" : "角色"}：${text}`;
        })
        .filter(Boolean);
    if (messages.length > 0) parts.push("最近聊天：" + messages.join("；"));

    return parts.join("\n");
}

/** 三种照片的提示词：真实生活照 + 锁脸说明 + 当前场景。 */
export function buildStoryPhotoPrompt(kind: StoryPhotoKind, context: string, extra?: string): string {
    const kindLine = kind === "character"
        ? "画面中只有她一个人：按当前场景穿着、动作与表情，正脸清晰，像刚被抓拍的日常瞬间。"
        : kind === "user"
            ? "画面中只有用户一个人：按当前场景穿着、动作与表情，正脸清晰，像被对方随手拍下的日常瞬间（使用用户参考图锁脸）。"
            : "画面中有两个人：她与用户，自然亲密地同框合照，双人正脸清晰、人物比例正确，处在同一地点、同一时刻，穿着与场景一致。";
    return [
        "真实生活照，手机随手抓拍，自然光，画面干净；不出现文字、水印、边框、拼图或多视图。",
        "人物面部特征与参考图保持一致，不要换脸、不要过度美颜。",
        kindLine,
        context.trim() ? "当前场景与正在发生的事：\n" + context.trim() : "当前场景：按最近聊天自然延续。",
        extra?.trim() || "",
    ].filter(Boolean).join("\n");
}

/** 拍照事件文案：既作为聊天里的照片说明，也作为线下剧情事件让角色记住。 */
export function storyPhotoCaption(kind: StoryPhotoKind, characterName: string): string {
    const name = characterName.trim() || "她";
    if (kind === "character") return `（${name}给你发了张刚拍的自拍）`;
    if (kind === "user") return `（${name}抓拍了一张你的照片）`;
    return `（${name}拉着你拍了张合照）`;
}
