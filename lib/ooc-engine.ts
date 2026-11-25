import { sendLLMRequest } from "./chat-engine";
import { loadApiConfigs, loadBindingConfig } from "./settings-storage";
import type { ApiConfig } from "./settings-types";
import type { LLMMessage } from "./llm-prompt-assembler";

export type OocTurn = { role: "user" | "assistant"; content: string };

function resolveOocApiConfig(): ApiConfig | null {
    const configs = loadApiConfigs();
    const binding = loadBindingConfig();
    if (binding.globalDefaults.apiConfigId) {
        return configs.find(config => config.id === binding.globalDefaults.apiConfigId) ?? null;
    }
    return configs[0] ?? null;
}

/**
 * OOC（Out Of Character）纠偏对话：直接和模型讨论角色/设定/剧情，
 * 不写入聊天记录、不写入角色记忆，也不触发角色扮演。
 */
export async function sendOocMessage(params: {
    characterName: string;
    userName?: string;
    recent: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    history: OocTurn[];
    text: string;
    signal?: AbortSignal;
}): Promise<string> {
    const apiConfig = resolveOocApiConfig();
    if (!apiConfig) throw new Error("未找到可用的 API 配置，请先在设置里添加模型");

    const system = [
        `你是「${params.characterName}」这部作品的创作助手，现在进入 OOC（Out Of Character）讨论模式。`,
        "用户不是在和角色对话，而是以作者/上帝视角和你讨论角色的设定、人设、剧情走向，并对不符合预期的表现进行纠偏。",
        "请直接、客观、简洁地回答用户的问题，不要扮演角色，不要用角色口吻，不要输出角色台词或动作描写。",
        "只根据用户提供的信息回答，不要编造用户没提到的设定。",
    ].join("\n");

    const recent = params.recent
        .filter(item => item.content.trim())
        .slice(-12)
        .map(item => ({ role: item.role, content: item.content.slice(0, 2000) }));

    const messages: LLMMessage[] = [
        { role: "system", content: system },
        ...(recent.length
            ? [
                {
                    role: "system" as const,
                    content: `以下是最近的聊天记录，仅供你理解语境（不要续写、不要扮演）：\n${recent.map(item => `${item.role === "user" ? "用户" : item.role === "assistant" ? params.characterName : "系统"}：${item.content}`).join("\n")}`,
                },
            ]
            : []),
        ...params.history.map(item => ({ role: item.role, content: item.content })),
        { role: "user" as const, content: params.text },
    ];

    const output = await sendLLMRequest(
        apiConfig,
        null,
        messages,
        [],
        { characterName: params.characterName, userName: params.userName },
        { skipOutputRegex: true, appId: "chat", signal: params.signal },
    );
    return output.trim();
}
