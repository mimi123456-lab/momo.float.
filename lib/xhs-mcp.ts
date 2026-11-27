// 小红书 MCP 解析源（可选、可关闭）：
// 第三方/自建 MCP 服务通常比抓分享页更完整，但可能限流或下线，
// 所以这里只做「优先尝试」，失败后由 /api/link-parse 回落到原有抓页解析。
//
// 配置：
//   XHS_MCP_URL      默认 https://xhs-mcp-one.vercel.app/api/xhs-mcp
//   XHS_MCP_TOKEN    可选，Bearer Token
//   XHS_MCP_DISABLE  设为 1 可完全关闭

type McpTool = {
  name?: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type McpRpcResult = {
  result?: unknown;
  error?: { message?: string };
};

const DEFAULT_ENDPOINT = "https://xhs-mcp-one.vercel.app/api/xhs-mcp";
const MCP_TIMEOUT_MS = 7000;

export type XhsNoteViaMcp = {
  title: string;
  desc: string;
  author: string;
  images: string[];
  video: string;
};

function endpoint(): string | null {
  if (process.env.XHS_MCP_DISABLE === "1") return null;
  const value = (process.env.XHS_MCP_URL || DEFAULT_ENDPOINT).trim();
  return /^https?:\/\//i.test(value) ? value : null;
}

function authHeaders(): Record<string, string> {
  const token = (process.env.XHS_MCP_TOKEN || "").trim();
  return token ? { Authorization: /^bearer /i.test(token) ? token : `Bearer ${token}` } : {};
}

/** 解析 MCP 响应：可能是普通 JSON，也可能是 SSE（data: {...}）。 */
async function readRpcResponse(response: Response): Promise<McpRpcResult | null> {
  const text = await response.text();
  if (!text.trim()) return null;
  const contentType = response.headers.get("content-type") || "";
  const payloads: string[] = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean)
    : [text];
  for (const payload of payloads) {
    try {
      const parsed = JSON.parse(payload) as McpRpcResult;
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* 多行 SSE 或保活注释，继续下一条 */ }
  }
  return null;
}

class McpSession {
  private sessionId = "";
  private nextId = 1;

  constructor(private readonly url: string) {}

  private async post(body: Record<string, unknown>, signal: AbortSignal): Promise<McpRpcResult | null> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...authHeaders(),
        ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal,
      cache: "no-store",
    });
    const session = response.headers.get("mcp-session-id");
    if (session) this.sessionId = session;
    if (!response.ok) throw new Error(`MCP HTTP ${response.status}`);
    return readRpcResponse(response);
  }

  async initialize(signal: AbortSignal): Promise<boolean> {
    const result = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "float-phone-link-parse", version: "1.0.0" },
      },
    }, signal);
    if (result?.error) return false;
    // 通知不需要响应，失败也不影响后续 tools/list。
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal).catch(() => null);
    return true;
  }

  async listTools(signal: AbortSignal): Promise<McpTool[]> {
    const result = await this.post({ jsonrpc: "2.0", id: this.nextId++, method: "tools/list", params: {} }, signal);
    const tools = (result?.result as { tools?: McpTool[] } | undefined)?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const result = await this.post({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }, signal);
    if (result?.error) throw new Error(result.error.message || "MCP 工具调用失败");
    return result?.result;
  }
}

function noteIdFromUrl(raw: string): string {
  const match = /\/(?:explore|discovery\/item)\/([0-9a-f]{16,32})/i.exec(raw);
  return match?.[1] || "";
}

/** 按工具的 inputSchema 组参数；缺少必填参数的工具直接跳过。 */
function buildToolArguments(tool: McpTool, raw: string): Record<string, unknown> | null {
  const properties = tool.inputSchema?.properties || {};
  const required = tool.inputSchema?.required || [];
  const args: Record<string, unknown> = {};
  const noteId = noteIdFromUrl(raw);
  let xsecToken = "";
  try {
    const parsed = new URL(raw);
    xsecToken = parsed.searchParams.get("xsec_token") || "";
    const xsecSource = parsed.searchParams.get("xsec_source");
    if (xsecSource && "xsec_source" in properties) args.xsec_source = xsecSource;
  } catch { /* 调用方已校验 URL */ }

  const pick = (...names: string[]) => names.find(name => name in properties);
  const urlKey = pick("url", "note_url", "share_url", "link", "share_text");
  if (urlKey) args[urlKey] = raw;
  if (noteId) {
    const idKey = pick("note_id", "noteId", "id");
    if (idKey) args[idKey] = noteId;
  }
  if (xsecToken) {
    const tokenKey = pick("xsec_token", "xsecToken");
    if (tokenKey) args[tokenKey] = xsecToken;
  }

  for (const key of required) {
    if (!(key in args)) return null;
  }
  return Object.keys(args).length > 0 ? args : null;
}

/** 选最像“读取笔记正文”的工具，避开评论、用户、点赞等。 */
function pickNoteTool(tools: McpTool[]): McpTool | null {
  const scored = tools
    .filter(tool => typeof tool.name === "string")
    .map(tool => {
      const name = (tool.name || "").toLowerCase();
      const text = `${name} ${tool.description || ""}`.toLowerCase();
      let score = 0;
      if (/note|笔记/.test(text)) score += 3;
      if (/detail|content|info|正文|详情/.test(text)) score += 3;
      if (/search|搜索/.test(text)) score += 1;
      if (/comment|评论|user|用户|like|赞|collect|收藏/.test(name)) score -= 4;
      if (/url|link/.test(JSON.stringify(tool.inputSchema || {}))) score += 2;
      return { tool, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score && scored[0].score > 0 ? scored[0].tool : null;
}

function collectText(value: unknown, depth = 0): string {
  if (depth > 4 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(item => collectText(item, depth + 1)).filter(Boolean).join("\n");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    return Object.values(record).map(item => collectText(item, depth + 1)).filter(Boolean).join("\n");
  }
  return "";
}

function findKeyValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 5 || value == null) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKeyValue(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] != null && String(record[key]).trim()) return record[key];
    }
    for (const item of Object.values(record)) {
      const found = findKeyValue(item, keys, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function normalizeNote(payload: unknown): XhsNoteViaMcp | null {
  let data: unknown = payload;
  const textParts: string[] = [];
  const record = payload as { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown } | null;
  if (Array.isArray(record?.content)) {
    for (const item of record.content) {
      if (typeof item?.text === "string") textParts.push(item.text);
    }
  }
  if (record?.structuredContent) data = record.structuredContent;
  const rawText = textParts.join("\n").trim();

  if (data === payload && rawText) {
    try { data = JSON.parse(rawText); } catch { /* 纯文本结果 */ }
  }
  const flat = collectText(data);

  const pick = (pattern: RegExp) => pattern.exec(flat)?.[1]?.trim() || "";
  const titleFromObject = findKeyValue(data, ["title", "noteTitle", "note_title"]);
  const descFromObject = findKeyValue(data, ["desc", "description", "content", "noteContent", "note_content"]);
  const authorFromObject = findKeyValue(data, ["nickname", "author", "userName", "user_name"]);

  const title = (titleFromObject != null ? String(titleFromObject) : "")
    || pick(/"title"\s*:\s*"([^"]{2,120})"/)
    || rawText.split(/\r?\n/)[0]?.replace(/^#+\s*/, "").trim()
    || "";
  const desc = (descFromObject != null ? String(descFromObject) : "")
    || pick(/"desc"\s*:\s*"((?:[^"\\]|\\.){2,4000})"/)
    || pick(/"content"\s*:\s*"((?:[^"\\]|\\.){2,4000})"/)
    || rawText.slice(0, 4000);
  const author = (authorFromObject != null ? String(authorFromObject) : "")
    || pick(/"nickname"\s*:\s*"([^"]{1,40})"/)
    || pick(/"author"\s*:\s*"([^"]{1,40})"/);
  const images = Array.from(new Set(Array.from(flat.matchAll(/https?:\/\/[^\s"'\\)]+\.(?:jpg|jpeg|png|webp)/gi)).map(item => item[0]))).slice(0, 12);
  const video = flat.match(/https?:\/\/[^\s"'\\)]+\.(?:mp4|m3u8)/i)?.[0] || "";

  const clean = (value: string) => value.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\u002F/g, "/").trim();
  const result = { title: clean(title), desc: clean(desc), author: clean(author), images, video };
  if (!result.title && !result.desc && !result.images.length && !result.video) return null;
  return result;
}

/**
 * 尝试通过 MCP 读取小红书笔记。任何失败都返回 null，由调用方回落。
 */
export async function fetchXhsNoteViaMcp(rawUrl: string): Promise<XhsNoteViaMcp | null> {
  const url = endpoint();
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const session = new McpSession(url);
    if (!(await session.initialize(controller.signal))) return null;
    const tools = await session.listTools(controller.signal);
    const tool = pickNoteTool(tools);
    if (!tool?.name) return null;
    const args = buildToolArguments(tool, rawUrl);
    if (!args) return null;
    const result = await session.callTool(tool.name, args, controller.signal);
    return normalizeNote(result);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
