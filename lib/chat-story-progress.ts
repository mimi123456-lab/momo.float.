// lib/chat-story-progress.ts
// 剧情进度 / 当前场景：会话级手动校准。
//
// 线下剧情由模型自动总结，但地点、穿着、关系阶段这些事实让模型猜容易漂。
// 这里提供一份用户手写的「事实层」：
//   - 线上聊天静默注入（不发消息），与自动摘要冲突时以手动为准；
//   - 线下生成只注入「当前场景」，避免模型把进度文案当台词复述；
//   - 剧情拍照把它作为画面描述的最高优先上下文。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type ChatStoryProgress = {
    progress: string;
    scene: string;
    updatedAt: string;
};

const STORAGE_KEY = "ai_phone_chat_story_progress_v1";
registerKvMigration(STORAGE_KEY);

const EMPTY_PROGRESS: ChatStoryProgress = { progress: "", scene: "", updatedAt: "" };

function loadAll(): Record<string, ChatStoryProgress> {
    try {
        const raw = kvGet(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) as unknown : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const result: Record<string, ChatStoryProgress> = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!value || typeof value !== "object") continue;
            const item = value as Partial<ChatStoryProgress>;
            result[key] = {
                progress: typeof item.progress === "string" ? item.progress : "",
                scene: typeof item.scene === "string" ? item.scene : "",
                updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
            };
        }
        return result;
    } catch {
        return {};
    }
}

export function getChatStoryProgress(sessionId: string): ChatStoryProgress {
    return loadAll()[sessionId] ?? { ...EMPTY_PROGRESS };
}

export function saveChatStoryProgress(
    sessionId: string,
    patch: Partial<Pick<ChatStoryProgress, "progress" | "scene">>,
): ChatStoryProgress {
    const all = loadAll();
    const previous = all[sessionId] ?? EMPTY_PROGRESS;
    const next: ChatStoryProgress = {
        progress: (patch.progress ?? previous.progress).trim(),
        scene: (patch.scene ?? previous.scene).trim(),
        updatedAt: new Date().toISOString(),
    };
    if (!next.progress && !next.scene) {
        delete all[sessionId];
        kvSet(STORAGE_KEY, JSON.stringify(all));
        return { ...EMPTY_PROGRESS };
    }
    all[sessionId] = next;
    kvSet(STORAGE_KEY, JSON.stringify(all));
    return next;
}

export function clearChatStoryProgress(sessionId: string): void {
    const all = loadAll();
    if (!all[sessionId]) return;
    delete all[sessionId];
    kvSet(STORAGE_KEY, JSON.stringify(all));
}

/** 当前场景（拍照/线下生成共用）；空串表示用户没标注。 */
export function getStoryScene(sessionId: string): string {
    return getChatStoryProgress(sessionId).scene;
}

/** 线上聊天用：手动校准的剧情 + 场景，整体作为优先级最高的事实块。 */
export function buildStoryProgressPrompt(sessionId: string): string {
    const value = getChatStoryProgress(sessionId);
    const lines: string[] = [];
    if (value.progress) lines.push(`【剧情进度】${value.progress}`);
    if (value.scene) lines.push(`【当前场景】${value.scene}`);
    if (lines.length === 0) return "";
    return [
        "<manual_story_state>",
        "## 用户手动校准的剧情（优先级最高，与自动摘要冲突时以此为准）",
        ...lines,
        "</manual_story_state>",
    ].join("\n");
}

/** 线下生成用：只给场景事实，不给进度结论，避免模型把进度当台词复述。 */
export function buildStoryScenePrompt(sessionId: string): string {
    const scene = getStoryScene(sessionId);
    if (!scene) return "";
    return [
        "<manual_story_scene>",
        "## 当前场景（用户手动标注，按事实使用，不要复述这条说明）",
        scene,
        "</manual_story_scene>",
    ].join("\n");
}
