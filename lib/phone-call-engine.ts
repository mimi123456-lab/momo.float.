import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";

function resolveConfig() {
    const configs = loadApiConfigs();
    const binding = loadBindingConfig();
    const config = configs.find(item => item.id === binding.globalDefaults?.apiConfigId) || configs[0];
    if (!config) throw new Error("请先在 设置 → API 接入 里配置模型接口");
    return config;
}

/**
 * 让角色“真的通过一次电话”：生成通话里 TA 说过的关键台词。
 * 生成结果会写回通话记录，并同步到微信聊天上下文，角色因此知道电话内容。
 */
export async function generateCallLines(input: {
    characterName: string;
    persona: string;
    durationSec: number;
    direction: "outgoing" | "incoming";
    userName?: string;
}): Promise<string[]> {
    const config = resolveConfig();
    const seconds = Math.max(1, input.durationSec);
    const messages: LLMMessage[] = [
        {
            role: "system",
            content: [
                `你就是角色「${input.characterName}」，刚刚和${input.userName || "对方"}通了一次手机电话。`,
                `角色人设：${input.persona || "（未填写）"}`,
                `这是${input.direction === "incoming" ? "你打给对方的" : "对方接起的你的"}电话，通话时长约 ${seconds} 秒。`,
                "写出电话里你说过的 1-3 句关键台词，每行一句，口语化、短句，符合人设和你们的关系。",
                "不要旁白、不要引号、不要编号、不要解释，只输出台词本身。",
            ].join("\n"),
        },
        { role: "user", content: "把电话里你说的话写下来。" },
    ];
    const result = await sendLLMRequest(config, null, messages, [], { characterName: input.characterName }, { skipOutputRegex: true, appId: "phone" });
    return String(result || "")
        .split(/\r?\n/)
        .map(line => line.replace(/^[「"'\-\d.、\s]+|[」"']+$/g, "").trim())
        .filter(Boolean)
        .slice(0, 3);
}
