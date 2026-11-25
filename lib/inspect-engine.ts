// lib/inspect-engine.ts
// 让角色生成一次「查岗」行动计划：翻了哪些 App、改了什么。

import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import { INSPECT_APP_LABELS, type InspectAppId } from "@/lib/inspect-storage";

export { INSPECT_APP_LABELS };

export type InspectPlanAction = {
    appId: InspectAppId;
    kind: "view" | "change";
    summary: string;
    detail?: string;
};

export type GenerateInspectionPlanInput = {
    characterId: string;
    characterName: string;
    persona: string;
    allowedAppIds: InspectAppId[];
    userName?: string;
    recentChat?: string;
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

    return [
        `你是${input.characterName}。以下是你的人设全文：`,
        input.persona?.trim() || "（未填写人设，请按普通恋人的口吻行动）",
        "",
        `你现在在偷偷翻看${userName}的手机。按你吃醋、担心或好奇的程度，从允许的 App 里挑 2-4 个动作。`,
        "只能做合理的小动作：看聊天、看朋友圈、改微信备注、发一条朋友圈或论坛、拿手机下单买东西、翻相册、看短信或通话记录、看歌单。",
        "每个动作要么是查看（view），要么是改动（change）。summary 用一句话说清翻了什么或改了什么，detail 写更细的过程（可多行）。",
        "",
        "允许的 App：",
        allowedList,
        recentChat,
        "",
        "只输出一个 JSON 数组，不要 markdown 代码围栏，不要任何解释。元素格式：",
        '{"appId":"chat","kind":"view","summary":"翻了用户和闺蜜的聊天","detail":"..."}',
        "appId 必须取自允许列表；kind 只能是 view 或 change。",
    ].join("\n");
}

function isInspectAppId(value: unknown): value is InspectAppId {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(INSPECT_APP_LABELS, value);
}

function normalizeAction(value: unknown, allowedAppIds: InspectAppId[]): InspectPlanAction | null {
    if (!value || typeof value !== "object") return null;
    const raw = value as Record<string, unknown>;
    if (!isInspectAppId(raw.appId)) return null;
    if (!allowedAppIds.includes(raw.appId)) return null;
    if (raw.kind !== "view" && raw.kind !== "change") return null;
    if (typeof raw.summary !== "string" || !raw.summary.trim()) return null;
    return {
        appId: raw.appId,
        kind: raw.kind,
        summary: raw.summary.trim(),
        detail: typeof raw.detail === "string" && raw.detail.trim() ? raw.detail.trim() : undefined,
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
    return allowedAppIds.slice(0, 2).map(appId => ({
        appId,
        kind: "view" as const,
        summary: `翻了你的${INSPECT_APP_LABELS[appId]}`,
    }));
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
