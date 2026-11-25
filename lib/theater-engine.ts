import { loadApiConfigs, loadBindingConfig } from "@/lib/settings-storage";
import { sendLLMRequest } from "@/lib/chat-engine";
import type { LLMMessage } from "@/lib/llm-prompt-assembler";

export async function generateTheaterEpisode(input: {
  characterId: string;
  characterName: string;
  persona: string;
  scene: string;
  tone: string;
  userHint?: string;
  signal?: AbortSignal;
}): Promise<string> {
  // 绑定配置里取全局默认 API；没有绑定就退回第一个配置。
  const configs = loadApiConfigs();
  const binding = loadBindingConfig();
  const config = configs.find(c => c.id === binding.globalDefaults?.apiConfigId) || configs[0];
  if (!config) throw new Error("请先在设置里配置 API");

  // 预设传 null：番外不继承主线的记忆 / 世界书 / 输出格式约束。
  const persona = input.persona.trim();
  const systemPrompt = [
    "你是「番外小剧场」的编剧，负责为角色写一段独立于主线之外的短篇番外。",
    "",
    "【角色人设】",
    persona || `（角色名：${input.characterName}）`,
    "",
    "写作要求：",
    "1. 完全贴合以上人设：性格、说话方式、称呼习惯都必须忠于设定，不得 OOC。",
    "2. 这是脱离主线的时间线，是一段独立发生的番外；不计入任何记忆，也不会影响主线关系。",
    "3. 直接写出一段 600-1000 字的沉浸式番外，包含场景、动作与对白。",
    "4. 只输出番外正文，不要解释、不要写标题、不要出现「作为 AI」之类的元话语。",
  ].join("\n");

  const userPrompt = [
    `角色：${input.characterName}`,
    `场景 / 地点：${input.scene.trim() || "未指定"}`,
    `关系 / 基调：${input.tone.trim() || "未指定"}`,
    input.userHint?.trim() ? `额外要求：${input.userHint.trim()}` : "",
    "",
    "请开始写这篇番外。",
  ].filter(Boolean).join("\n");

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const text = await sendLLMRequest(
    config,
    null,
    messages,
    [],
    { characterName: input.characterName },
    { skipOutputRegex: true, appId: "theater", signal: input.signal },
  );
  return text.trim();
}
