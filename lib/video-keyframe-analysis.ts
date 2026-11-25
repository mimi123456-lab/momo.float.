import { pushApiLog } from "./api-log-store";

export type VideoFrameProgress = (message: string) => void;
type SampledFrame = { seconds: number; dataUrl: string; base64: string };

function apiError(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: { message?: unknown } }).error;
    if (typeof error?.message === "string" && error.message.trim()) return error.message;
  }
  return fallback;
}

function timeLabel(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return (h ? String(h).padStart(2, "0") + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

async function extractFrames(
  file: File,
  requestedCount: number,
  signal?: AbortSignal,
  progress?: VideoFrameProgress,
  mode: "uniform" | "adaptive" = "uniform",
): Promise<{ frames: SampledFrame[]; duration: number }> {
  if (typeof document === "undefined") throw new Error("当前环境不能在本地解码视频。");
  if (signal?.aborted) throw new DOMException("已取消视频分析。", "AbortError");
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;
  const waitFor = (eventName: "loadedmetadata" | "seeked"): Promise<void> => new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener(eventName, done);
      video.removeEventListener("error", failed);
      signal?.removeEventListener("abort", aborted);
    };
    const done = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error("无法解码这个视频文件。请尝试 MP4/H.264，或改用 Gemini/豆包原生视频模式。")); };
    const aborted = () => { cleanup(); reject(new DOMException("已取消视频分析。", "AbortError")); };
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener("error", failed, { once: true });
    signal?.addEventListener("abort", aborted, { once: true });
  });
  try {
    await waitFor("loadedmetadata");
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("读取不到视频时长，无法抽取关键帧。");
    const width = video.videoWidth || 960;
    const height = video.videoHeight || 540;
    // 自适应抓图只需要够拼图用，压到 720 可显著减少解码/编码耗时。
    const maxDimension = mode === "adaptive" ? 720 : 960;
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    // requestedCount 为 0 表示按视频时长自动决定：约每 1.5 秒一帧，4~12 帧。
    const autoCount = Math.min(12, Math.max(4, Math.round(duration / 1.5)));
    const count = Math.min(24, Math.max(4, Math.floor(requestedCount || autoCount)));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法初始化视频关键帧画布。");
    const frames: SampledFrame[] = [];
    const uniformTimes = () => Array.from({ length: count }, (_, i) => (
      Math.min(Math.max(0, duration - 0.08), duration * ((i + 0.5) / count))
    ));
    const seekTo = async (seconds: number) => {
      if (signal?.aborted) throw new DOMException("已取消视频分析。", "AbortError");
      const seeked = waitFor("seeked");
      video.currentTime = seconds;
      await seeked;
    };

    // 自适应模式：单次遍历候选帧，边抓图边算画面差异，选中后直接复用，
    // 避免“先探测再重抓”做两遍 seek（移动端 seek 是主要耗时来源）。
    if (mode === "adaptive") {
      const target = count;
      const candidateCount = Math.min(18, Math.max(6, Math.ceil(duration / 1.2)));
      const probe = document.createElement("canvas");
      probe.width = 40;
      probe.height = 40;
      const probeContext = probe.getContext("2d", { alpha: false });
      if (probeContext) {
        const candidates: { seconds: number; dataUrl: string; diff: number }[] = [];
        let previous: Uint8ClampedArray | null = null;
        for (let i = 0; i < candidateCount; i += 1) {
          const seconds = Math.min(Math.max(0, duration - 0.08), duration * ((i + 0.5) / candidateCount));
          progress?.("正在分析动作变化 " + (i + 1) + "/" + candidateCount + "…");
          await seekTo(seconds);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
          probeContext.drawImage(canvas, 0, 0, probe.width, probe.height);
          const data = probeContext.getImageData(0, 0, probe.width, probe.height).data;
          let diff = 0;
          if (previous) {
            for (let p = 0; p < data.length; p += 4) {
              diff += Math.abs(data[p] - previous[p])
                + Math.abs(data[p + 1] - previous[p + 1])
                + Math.abs(data[p + 2] - previous[p + 2]);
            }
          }
          candidates.push({ seconds, dataUrl, diff });
          previous = data;
        }
        const chosen: number[] = [0];
        const minGap = duration / (target * 1.4);
        const byDiff = candidates.map((_, index) => index).slice(1).sort((a, b) => candidates[b].diff - candidates[a].diff);
        for (const index of byDiff) {
          if (chosen.length >= target) break;
          if (chosen.every(picked => Math.abs(candidates[picked].seconds - candidates[index].seconds) >= minGap)) {
            chosen.push(index);
          }
        }
        // 动作少的视频补均匀帧，保证整段都有覆盖。
        for (let i = 0; i < target && chosen.length < target; i += 1) {
          const seconds = Math.min(Math.max(0, duration - 0.08), duration * ((i + 0.5) / target));
          let nearest = -1;
          let nearestDistance = -1;
          candidates.forEach((candidate, index) => {
            if (chosen.includes(index)) return;
            const distance = Math.abs(candidate.seconds - seconds);
            if (distance > nearestDistance) {
              nearestDistance = distance;
              nearest = index;
            }
          });
          if (nearest >= 0) chosen.push(nearest);
        }
        chosen.sort((a, b) => candidates[a].seconds - candidates[b].seconds);
        for (const index of chosen) {
          const candidate = candidates[index];
          frames.push({
            seconds: candidate.seconds,
            dataUrl: candidate.dataUrl,
            base64: candidate.dataUrl.slice(candidate.dataUrl.indexOf(",") + 1),
          });
        }
        return { frames, duration };
      }
    }

    for (let i = 0; i < count; i++) {
      const seconds = uniformTimes()[i];
      progress?.("正在本地抽取关键帧 " + (i + 1) + "/" + count + "…");
      await seekTo(seconds);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
      frames.push({ seconds, dataUrl, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
    }
    return { frames, duration };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

async function analyzeVideoUsingKeyframesCore(options: {
  file: File;
  apiKey: string;
  model: string;
  prompt: string;
  provider: "openai-compatible" | "anthropic";
  baseUrl?: string;
  frameCount: number;
  signal?: AbortSignal;
  onProgress?: VideoFrameProgress;
}): Promise<string> {
  const provider = options.provider;
  const root = (options.baseUrl || (provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1")).trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(root)) throw new Error("API 地址必须以 http:// 或 https:// 开头。");
  options.onProgress?.("正在从本地视频提取关键帧…");
  const { frames } = await extractFrames(options.file, options.frameCount, options.signal, options.onProgress);
  options.onProgress?.("已抽取 " + frames.length + " 帧，正在发送给视觉模型…");
  let response: Response;
  let payload: Record<string, unknown> | null;
  if (provider === "anthropic") {
    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: options.prompt + "\n\n请根据以下按时间均匀抽取的关键帧分析视频。每张图片前会标注对应时间点。当前模式只发送画面关键帧，不包含原始音轨。"
    }];
    for (const frame of frames) {
      content.push({ type: "text", text: "视频时间点 " + timeLabel(frame.seconds) });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: frame.base64 } });
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    if (options.apiKey.trim()) headers["x-api-key"] = options.apiKey.trim();
    response = await fetch(root + "/v1/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: options.model.trim(), max_tokens: 1800, messages: [{ role: "user", content }] }),
      signal: options.signal
    });
    payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(apiError(payload, "Claude 关键帧视频理解失败（HTTP " + response.status + "）。若提示 CORS，请改用支持跨域的端点或代理。"));
    const parts = Array.isArray(payload?.content) ? payload?.content as Array<{ type?: string; text?: string }> : [];
    const text = parts.filter(part => part.type === "text").map(part => part.text || "").filter(Boolean).join("\n");
    if (!text.trim()) throw new Error("Claude 没有返回文字回应。");
    return text.trim();
  }

  const content: Array<Record<string, unknown>> = [{
    type: "text",
    text: options.prompt + "\n\n以下是从视频中按时间均匀抽取的关键帧，时间点按顺序标注。请依据这些画面分析剪辑和事件，不要推断画面未展示的内容。当前模式只发送画面关键帧，不包含原始音轨。"
  }];
  for (const frame of frames) {
    content.push({ type: "text", text: "视频时间点 " + timeLabel(frame.seconds) });
    content.push({ type: "image_url", image_url: { url: frame.dataUrl, detail: "high" } });
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey.trim()) headers.Authorization = "Bearer " + options.apiKey.trim();
  const endpoint = /\/chat\/completions$/i.test(root) ? root : root + "/chat/completions";
  response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: options.model.trim(), messages: [{ role: "user", content }], max_tokens: 1800, temperature: 0.7 }),
    signal: options.signal
  });
  payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(apiError(payload, "OpenAI 兼容视觉模型关键帧分析失败（HTTP " + response.status + "）。请检查模型是否支持图像输入及 API 地址/CORS。"));
  const choices = Array.isArray(payload?.choices) ? payload?.choices as Array<{ message?: { content?: string | Array<{ text?: string }> } }> : [];
  const raw = choices[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(part => part.text || "").filter(Boolean).join("\n") : "";
  if (!text.trim()) throw new Error("视觉模型没有返回文字回应。");
  return text.trim();
}


async function analyzeCapturedImageCore(options: {
  dataUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  provider: "gemini" | "ark" | "openai-compatible" | "anthropic" | "twelvelabs";
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<string> {
  const provider = options.provider;
  const match = options.dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) throw new Error("截屏图片数据无效。");
  if (!options.model.trim()) throw new Error("请先配置视频分析模型 ID。");
  const root = (options.baseUrl || (provider === "gemini" ? "https://generativelanguage.googleapis.com" : provider === "ark" ? "https://ark.cn-beijing.volces.com/api/v3" : provider === "anthropic" ? "https://api.anthropic.com" : provider === "twelvelabs" ? "https://api.twelvelabs.io/v1.3" : "https://api.openai.com/v1")).trim().replace(/\/+$/, "");
  const local = /^(https?:\/\/)?(localhost|127\.0\.0\.1|10\.0\.2\.2|\[::1\]|192\.168\.)/i.test(root);
  if (!options.apiKey.trim() && !(provider === "openai-compatible" && local)) throw new Error("请先在系统设置 → 视频分析模型填写 API Key。");
  const imageBase64 = match[2];
  const mimeType = match[1];
  let response: Response;
  if (provider === "twelvelabs") {
    const headers = { "x-api-key": options.apiKey.trim() };
    let assetId = "";
    try {
      const binary = atob(imageBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], "global-watch-frame.jpg", { type: mimeType });
      const form = new FormData();
      form.append("method", "direct");
      form.append("file", file, file.name);
      form.append("enable_thumbnail", "false");
      const upload = await fetch(root + "/assets", { method: "POST", headers, body: form, signal: options.signal });
      const created = await upload.json().catch(() => null) as { _id?: string; status?: string; error?: { message?: string } } | null;
      if (!upload.ok || !created?._id) throw new Error(apiError(created, "TwelveLabs 截屏上传失败（HTTP " + upload.status + "）。"));
      assetId = created._id;
      let status = created.status || "processing";
      for (let attempt = 0; status !== "ready"; attempt++) {
        if (status === "failed") throw new Error("TwelveLabs 截屏资产处理失败。");
        if (attempt >= 30) throw new Error("TwelveLabs 截屏处理超时。");
        await new Promise(resolve => setTimeout(resolve, 1500));
        const poll = await fetch(root + "/assets/" + encodeURIComponent(assetId), { headers, signal: options.signal });
        const state = await poll.json().catch(() => null) as { status?: string; error?: { message?: string } } | null;
        if (!poll.ok || !state?.status) throw new Error(apiError(state, "读取 TwelveLabs 截屏状态失败。"));
        status = state.status;
      }
      const response = await fetch(root + "/analyze", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ model_name: options.model.trim() || "pegasus1.6", image: [{ type: "asset", asset_id: assetId }], prompt: options.prompt, stream: false, max_tokens: 1000 }),
        signal: options.signal
      });
      const result = await response.json().catch(() => null) as { data?: string; text?: string; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(apiError(result, "TwelveLabs 屏幕画面理解失败（HTTP " + response.status + "）。"));
      const text = result?.data || result?.text || "";
      if (!text.trim()) throw new Error("TwelveLabs 没有返回屏幕评价。");
      return text.trim();
    } finally {
      if (assetId) void fetch(root + "/assets/" + encodeURIComponent(assetId), { method: "DELETE", headers, keepalive: true }).catch(() => {});
    }
  }
  let payload: Record<string, unknown> | null;
  if (provider === "gemini") {
    response = await fetch(root + "/v1beta/models/" + encodeURIComponent(options.model.trim().replace(/^models\//, "")) + ":generateContent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": options.apiKey.trim() },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ inlineData: { mimeType, data: imageBase64 } }, { text: options.prompt }] }], generationConfig: { temperature: 0.8, maxOutputTokens: 1200 } }),
      signal: options.signal
    });
    payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(apiError(payload, "Gemini 截屏理解失败（HTTP " + response.status + "）。"));
    const candidates = Array.isArray(payload?.candidates) ? payload?.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> : [];
    const text = candidates[0]?.content?.parts?.map(part => part.text || "").filter(Boolean).join("\n") || "";
    if (!text.trim()) throw new Error("Gemini 没有返回截屏评价。");
    return text.trim();
  }
  if (provider === "anthropic") {
    response = await fetch(root + "/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": options.apiKey.trim(), "anthropic-version": "2023-06-01", "anthropic-dangerous-direct-browser-access": "true" },
      body: JSON.stringify({ model: options.model.trim(), max_tokens: 1200, messages: [{ role: "user", content: [{ type: "text", text: options.prompt }, { type: "image", source: { type: "base64", media_type: mimeType, data: imageBase64 } }] }] }),
      signal: options.signal
    });
    payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new Error(apiError(payload, "Claude 截屏理解失败（HTTP " + response.status + "）。"));
    const parts = Array.isArray(payload?.content) ? payload?.content as Array<{ type?: string; text?: string }> : [];
    const text = parts.filter(part => part.type === "text").map(part => part.text || "").filter(Boolean).join("\n");
    if (!text.trim()) throw new Error("Claude 没有返回截屏评价。");
    return text.trim();
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.apiKey.trim()) headers.Authorization = "Bearer " + options.apiKey.trim();
  const endpoint = /\/chat\/completions$/i.test(root) ? root : root + "/chat/completions";
  response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: options.model.trim(), messages: [{ role: "user", content: [{ type: "text", text: options.prompt }, { type: "image_url", image_url: { url: options.dataUrl, detail: "high" } }] }], max_tokens: 1200, temperature: 0.7 }),
    signal: options.signal
  });
  payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(apiError(payload, (provider === "ark" ? "豆包" : "兼容视觉模型") + "截屏理解失败（HTTP " + response.status + "）。"));
  const choices = Array.isArray(payload?.choices) ? payload?.choices as Array<{ message?: { content?: string | Array<{ text?: string }> } }> : [];
  const raw = choices[0]?.message?.content;
  const text = typeof raw === "string" ? raw : Array.isArray(raw) ? raw.map(part => part.text || "").filter(Boolean).join("\n") : "";
  if (!text.trim()) throw new Error("视觉模型没有返回截屏评价。");
  return text.trim();
}


/** 统一记录直接 fetch 的视觉模型调用，供“底层调用大模型日志”查看。 */
export async function analyzeVideoUsingKeyframes(
  options: Parameters<typeof analyzeVideoUsingKeyframesCore>[0],
): Promise<string> {
  try {
    const text = await analyzeVideoUsingKeyframesCore(options);
    pushApiLog({
      characterName: "视频分析",
      source: "background",
      model: options.model,
      messages: [{ role: "user", content: options.prompt + "\n[视频关键帧]" }],
      rawResponse: text,
    });
    return text;
  } catch (error) {
    pushApiLog({
      characterName: "视频分析",
      source: "background",
      model: options.model,
      messages: [{ role: "user", content: options.prompt + "\n[视频关键帧]" }],
      rawResponse: "[错误] " + (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}

/**
 * 把用户上传的视频抽成一张横向关键帧拼图。
 * 聊天里空间有限，拼成一张图后可以直接走现有的单图视觉链路。
 */
export async function buildVideoContactSheet(
  file: File,
  options?: { frameCount?: number; signal?: AbortSignal; onProgress?: VideoFrameProgress },
): Promise<{ dataUrl: string; durationSeconds: number }> {
  if (typeof document === "undefined") throw new Error("当前环境不能处理本地视频");
  // frameCount 不传时按视频时长和动作变化自动抽取（4~12 帧）。
  const { frames, duration } = await extractFrames(file, options?.frameCount ?? 0, options?.signal, options?.onProgress, "adaptive");
  if (frames.length === 0) throw new Error("没有抽取到视频画面");
  options?.onProgress?.("正在拼接关键帧…");
  const images = await Promise.all(frames.map(frame => new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("视频关键帧解码失败"));
    img.src = frame.dataUrl;
  })));
  const cellWidth = 320;
  const aspect = images[0].height && images[0].width ? images[0].height / images[0].width : 9 / 16;
  const cellHeight = Math.max(1, Math.round(cellWidth * aspect));
  const gap = 6;
  const labelHeight = 22;
  // 多帧时排成网格（最多 4 列），单行拼图在 12 帧时会被模型缩放到看不清。
  const columns = Math.min(4, images.length);
  const rows = Math.ceil(images.length / columns);
  const canvas = document.createElement("canvas");
  canvas.width = columns * cellWidth + (columns - 1) * gap;
  canvas.height = rows * (cellHeight + labelHeight) + (rows - 1) * gap;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建视频关键帧画布");
  context.fillStyle = "#101014";
  context.fillRect(0, 0, canvas.width, canvas.height);
  images.forEach((img, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = column * (cellWidth + gap);
    const y = row * (cellHeight + labelHeight + gap);
    context.drawImage(img, x, y, cellWidth, cellHeight);
    context.fillStyle = "rgba(0,0,0,0.55)";
    context.fillRect(x, y + cellHeight, cellWidth, labelHeight);
    context.fillStyle = "#fff";
    context.font = "14px sans-serif";
    context.textAlign = "center";
    context.fillText(`${index + 1}/${images.length}  ${timeLabel(frames[index].seconds)}`, x + cellWidth / 2, y + cellHeight + 16);
  });
  return { dataUrl: canvas.toDataURL("image/jpeg", 0.72), durationSeconds: Math.round(duration) };
}

export async function analyzeCapturedImage(
  options: Parameters<typeof analyzeCapturedImageCore>[0],
): Promise<string> {
  try {
    const text = await analyzeCapturedImageCore(options);
    pushApiLog({
      characterName: "全局陪看",
      source: "background",
      model: options.model,
      messages: [{ role: "user", content: options.prompt + "\n[屏幕截图]" }],
      rawResponse: text,
    });
    return text;
  } catch (error) {
    pushApiLog({
      characterName: "全局陪看",
      source: "background",
      model: options.model,
      messages: [{ role: "user", content: options.prompt + "\n[屏幕截图]" }],
      rawResponse: "[错误] " + (error instanceof Error ? error.message : String(error)),
    });
    throw error;
  }
}
