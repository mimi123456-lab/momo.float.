// lib/inspect-engine.ts
// 让角色生成一次「查岗」行动计划：翻了哪些 App、改了什么。
// 这里只产出「意图」；真正读到的数据、真正落地的改动在 inspect-executor.ts 执行。

import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import {
    INSPECT_APP_LABELS,
    type InspectActionType,
    type InspectAppId,
    type InspectEmotion,
} from "@/lib/inspect-storage";

export { INSPECT_APP_LABELS };

export type InspectPlanAction = {
    appId: InspectAppId;
    kind: "view" | "change";
    /** 具体动作；缺省时按 appId + kind 推断 */
    action?: InspectActionType;
    /** 目标提示：会话名 / 商品名 / 短信联系人，用来在真实数据里定位 */
    target?: string;
    /** 改动内容：新备注 / 朋友圈正文 */
    text?: string;
    summary: string;
    detail?: string;
    emotion?: InspectEmotion;
};

export type GenerateInspectionPlanInput = {
    characterId: string;
    characterName: string;
    persona: string;
    allowedAppIds: InspectAppId[];
    userName?: string;
    recentChat?: string;
    /** 用户主动把手机递给 TA：允许直接翻，不必先找理由 */
    handedOver?: boolean;
};

export type GenerateInspectionPlanResult = {
    logs: InspectPlanAction[];
};

const MAX_ACTIONS = 4;

function buildSystemPrompt(input: GenerateInspectionPlanInput): string {
    const allowedList = input.allowedAppIds
        .map(appId => `- ${appId}：${INSPECT_APP_LABELS[appId]}`)
        .join("\n");
    const userName = input.userName?.trim() || "用户";
    const recentChat = input.recentChat?.trim()
        ? `\n最近和${userName}的聊天片段（可作参考，不要逐字复述）：\n${input.recentChat.trim()}`
        : "";
    const mode = input.handedOver
        ? `${userName}刚把手机塞到你手里，说“喏，你看吧”。你可以放心地翻，不用装作不经意。`
        : `你趁${userName}不注意，偷偷拿起了${userName}的手机。`;

    return [
        `你是${input.characterName}。以下是你的人设全文：`,
        input.persona?.trim() || "（未填写人设，请按普通恋人的口吻行动）",
        "",
        mode,
        `按你此时此刻真实的情绪（好奇、吃醋、不安、想确认），从允许的 App 里挑 2-4 个动作。`,
        "动作要像真人翻手机：先看某个具体的人/内容，再有反应；不要笼统地说“翻了聊天”。",
        "",
        "可选动作：",
        "- action=open-chat：打开某个聊天（target 写聊天对象的名字）",
        "- action=change-remark：给某个联系人改备注（target 写对象名字，text 写新备注，要符合你的占有欲/小情绪）",
        "- action=post-moment：发一条朋友圈（text 写正文，不超过 60 字，像真人随手发的）",
        "- action=place-order：用${userName}的账号下单（target 写想买的东西）",
        "- action=view：只是看看（朋友圈、订单、短信、通话记录、相册）",
        "",
        "允许的 App：",
        allowedList,
        recentChat,
        "",
        "emotion 只能取 calm / curious / jealous / sad / angry，表示你看到这条内容时的心情。",
        "summary 用一句话说清你做了什么（用“我”的口吻）。detail 可写你心里想的（1-2 句，口语，不要括号说明）。",
        "",
        "只输出一个 JSON 数组，不要 markdown 代码围栏，不要任何解释。元素格式：",
        '{"appId":"chat","kind":"view","action":"open-chat","target":"闺蜜","summary":"我点开了你和闺蜜的聊天","detail":"往上翻了几屏…","emotion":"jealous"}',
        "appId 必须取自允许列表；kind 只能是 view 或 change；action 取上面五种之一。",
    ].join("\n");
}

function isInspectAppId(value: unknown): value is InspectAppId {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(INSPECT_APP_LABELS, value);
}

const ACTIONS: InspectActionType[] = ["view", "open-chat", "change-remark", "post-moment", "place-order"];
const EMOTIONS: InspectEmotion[] = ["calm", "curious", "jealous", "sad", "angry"];

function normalizeAction(value: unknown, allowedAppIds: InspectAppId[]): InspectPlanAction | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    if (!isInspectAppId(raw.appId)) return null;
    if (!allowedAppIds.includes(raw.appId)) return null;
    if (raw.kind !== "view" && raw.kind !== "change") return null;
    if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;
    const action = typeof raw.action === "string" && ACTIONS.includes(raw.action as InspectActionType)
        ? raw.action as InspectActionType
        : undefined;
    const emotion = typeof raw.emotion === "string" && EMOTIONS.includes(raw.emotion as InspectEmotion)
        ? raw.emotion as InspectEmotion
        : undefined;
    return {
        appId: raw.appId,
        kind: raw.kind,
        action,
        target: typeof raw.target === "string" && raw.target.trim() ? raw.target.trim() : undefined,
        text: typeof raw.text === "string" && raw.text.trim() ? raw.text.trim() : undefined,
        summary: raw.summary.trim(),
        detail: typeof raw.detail === "string" && raw.detail.trim() ? raw.detail.trim() : undefined,
        emotion,
    };
}

function parsePlan(raw: string, allowedAppIds: InspectAppId[]): InspectPlanAction[] {
    if (!raw) return [];
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    if (start < 0 || end <= start) return [];
    try {
        const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
        if (!Array.isArray(parsed)) return [];
        const actions: InspectPlanAction[] = [];
        for (const item of parsed) {
            const action = normalizeAction(item, allowedAppIds);
            if (action) actions.push(action);
            if (actions.length >= MAX_ACTIONS) break;
        }
        return actions;
    } catch {
        return [];
    }
}

function buildFallbackPlan(allowedAppIds: InspectAppId[]): InspectPlanAction[] {
    const picks = allowedAppIds.slice(0, 2);
    return picks.map((appId, index) => {
        if (appId === "chat") {
            return {
                appId,
                kind: "view" as const,
                action: "open-chat" as const,
                summary: "我点开你的微信，从头往下翻会话",
                detail: index === 0 ? "手指停在最上面那个人的头像上。" : undefined,
                emotion: "curious" as const,
            };
        }
        return {
            appId,
            kind: "view" as const,
            action: "view" as const,
            summary: `我翻了翻你的${INSPECT_APP_LABELS[appId]}`,
            emotion: "curious" as const,
        };
    });
}

export async function generateInspectionPlan(
    input: GenerateInspectionPlanInput,
): Promise<GenerateInspectionPlanResult> {
    const allowedAppIds = Array.from(new Set(input.allowedAppIds.filter(isInspectAppId)));
    if (allowedAppIds.length === 0) return { logs: [] };

    const binding = loadBindingConfig();
    const configs = loadApiConfigs();
    const preferredId = binding.globalDefaults?.apiConfigId;
    const apiConfig = (preferredId ? configs.find(config => config.id === preferredId) : undefined) ?? configs[0];
    if (!apiConfig) throw new Error("请先在设置里配置 API");

    const messages: LLMMessage[] = [
        { role: "system", content: buildSystemPrompt({ ...input, allowedAppIds }) },
        { role: "user", content: "现在开始查岗，只输出 JSON 数组。" },
    ];

    let raw = "";
    try {
        raw = await sendLLMRequest(
            apiConfig,
            null,
            messages,
            [],
            { characterName: input.characterName, userName: input.userName },
            { skipOutputRegex: true, appId: "inspect", appTags: ["inspect"] },
        );
    } catch {
        return { logs: buildFallbackPlan(allowedAppIds) };
    }

    const actions = parsePlan(raw, allowedAppIds);
    if (actions.length === 0) return { logs: buildFallbackPlan(allowedAppIds) };
    return { logs: actions };
}
