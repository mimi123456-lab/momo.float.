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

async function requestText(system: string, user: string, characterName: string): Promise<string> {
    const config = resolveConfig();
    const messages: LLMMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
    ];
    const result = await sendLLMRequest(config, null, messages, [], { characterName }, { skipOutputRegex: true, appId: "couplespace" });
    return String(result || "").trim();
}

/** 生成角色今天写给用户的情书。 */
export async function generateLoveLetter(input: {
    characterName: string;
    persona: string;
    userName?: string;
    daysTogether: number;
    recentLetters: string[];
}): Promise<string> {
    return requestText(
        [
            `你就是角色「${input.characterName}」，正在写给${input.userName || "对方"}的情书。`,
            `角色人设：${input.persona || "（未填写）"}`,
            "这是情侣空间里的每日情书，只给对方一个人看。",
            "写 120-200 字，第一人称，真诚、具体、有生活细节，不要套话，不要用 emoji，不要写标题，不要解释。",
            input.recentLetters.length > 0 ? `不要重复最近写过的内容：${input.recentLetters.slice(0, 3).join(" / ")}` : "",
        ].join("\n"),
        `我们今天已经在一起 ${input.daysTogether} 天了。写今天的真心话。`,
        input.characterName,
    );
}

/** 生成角色在愿望板上写的一个愿望。 */
export async function generateCoupleWish(input: {
    characterName: string;
    persona: string;
    userName?: string;
    mood: "正经" | "不正经";
    existing: string[];
}): Promise<string> {
    return requestText(
        [
            `你就是角色「${input.characterName}」。`,
            `角色人设：${input.persona || "（未填写）"}`,
            "你在情侣空间的愿望板上写一个想和对方一起做的事。",
            input.mood === "正经" ? "这次写一个正经的、可以真的去完成的愿望。" : "这次写一个不太正经、亲密暧昧一点的愿望，但不要露骨。",
            "只输出一句愿望，20-40 字，不要编号、不要引号、不要解释。",
            input.existing.length > 0 ? `不要和这些重复：${input.existing.slice(0, 6).join(" / ")}` : "",
        ].join("\n"),
        `给${input.userName || "对方"}写一个愿望。`,
        input.characterName,
    );
}
