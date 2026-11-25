import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";
import type { SmsMessage } from "@/lib/sms-storage";

/**
 * 系统短信回复：用角色人设生成 1-3 条短句，像真的手机短信。
 * 与微信完全独立，不写入聊天记录与长期记忆。
 */
export async function generateSmsReply(input: {
    characterId: string;
    characterName: string;
    persona: string;
    userName?: string;
    history: SmsMessage[];
    text: string;
}): Promise<string[]> {
    const configs = loadApiConfigs();
    const binding = loadBindingConfig();
    const config = configs.find(item => item.id === binding.globalDefaults?.apiConfigId) || configs[0];
    if (!config) throw new Error("请先在 设置 → API 接入 里配置模型接口");

    const history = input.history.slice(-16).map(item => ({
        role: (item.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: item.body,
    }));

    const messages: LLMMessage[] = [
        {
            role: "system",
            content: [
                `你正在用手机短信和「${input.userName || "对方"}」聊天。你就是角色本人：${input.characterName}。`,
                `角色人设：${input.persona || "（未填写）"}`,
                "这是独立于微信的手机短信，语气更像真的短信：短、口语、可以直接。",
                "每次回复输出 1-3 条消息，每条单独一行，不要加任何前缀、编号、引号或解释，也不要使用括号动作或微信消息指令。",
                "不知道说什么时也可以只回一条。",
            ].join("\n"),
        },
        ...history,
        { role: "user", content: input.text },
    ];

    const result = await sendLLMRequest(config, null, messages, [], {
        characterName: input.characterName,
        userName: input.userName,
    }, { skipOutputRegex: true, appId: "sms" });

    return String(result || "")
        .split(/\n+/)
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, 3);
}
