// lib/chat-status-region.ts
// 自定义状态栏（状态区）：会话级配置 + 默认预设宏解析。
//
// 机制：默认预设的「内心想法」章节改为宏 {{statusRegionSection}}（主动消息示例行
// 对应 {{statusRegionExampleLine}}），按本模块的会话配置解析：
//   native（默认）→ 原章节文本，字节级等于历史版本，所有存量用户无感；
//   off           → 空，整节从提示词消失，AI 自然不再输出 [内心]；
//   custom        → 「## 状态栏」+ 契约整段正文（契约自带【逻辑】【格式】与包裹要求）。
// 只有包含宏的预设（默认预设天生包含；社区预设作者可自愿声明）支持自定义——
// 不含宏的预设完全不受本机制影响，聊天信息页的入口会置灰。
//
// 渲染侧配套：custom 模式下生成的消息盖 statusRegionMode 戳，折叠区不再画
// 便利贴容器，改由用户的渲染代码（沙盒 iframe，AI 壳内原文经 window.STATUS_RAW
// 与 {{RAW}} 注入）接管。原生时期的消息永远按原生渲染，切换可逆。

import { kvGet, kvSet, registerKvMigration } from "./kv-db";

export type StatusRegionMode = "native" | "off" | "custom";

/** 解析变体：单聊与群聊的 native 原文不同，自定义挡群聊还要补"每人各出一份"的规则 */
export type StatusRegionVariant = "single" | "group";

export type StatusRegionConfig = {
    mode: StatusRegionMode;
    /** 输出契约：告诉 AI [状态栏] 壳内输出什么（custom 模式生效） */
    contract: string;
    /** 输出渲染：完整 HTML（可含 JS），沙盒 iframe 执行，接管折叠区绘制 */
    renderHtml: string;
    /** 预览用示例数据（[状态栏] 壳内原文的样例）。只用于编辑弹窗里的实时预览，
     *  不参与提示词，也不影响渲染。小卷写入契约时一并给出，否则预览会拿默认样例
     *  去套新契约的字段，显示成空白或错乱。缺省为空表示用内置样例。 */
    previewRaw?: string;
};

const STORAGE_KEY = "ai_phone_chat_status_region_v1";
/** 全局私聊状态栏使用的保留键，不会与真实会话 id 冲突。 */
export const GLOBAL_CHAT_STATUS_REGION_ID = "__global_private_chat__";

/** 配置被外部改写（小卷工具）后广播，已打开的聊天信息页据此刷新，
 *  否则面板的状态只在挂载时初始化一次，会停在旧值——写了但前台看不见。 */
export const STATUS_REGION_UPDATED_EVENT = "chat-status-region-updated";
registerKvMigration(STORAGE_KEY);

/** 状态栏方案库在 css-scheme-storage 里的 target 键（负载=契约+渲染+示例数据 JSON） */
export const STATUS_REGION_SCHEME_TARGET = "chat_status_region";

export const STATUS_REGION_SECTION_MACRO = "{{statusRegionSection}}";
export const STATUS_REGION_EXAMPLE_MACRO = "{{statusRegionExampleLine}}";
export const STATUS_REGION_COMPOSITION_MACRO = "{{statusRegionComposition}}";
export const STATUS_REGION_FULL_EXAMPLE_MACRO = "{{statusRegionFullExample}}";

/** 原「## 状态数值」+「## 内心想法」章节原文——native 挡解析值，必须与历史版本逐字一致。
 *  状态数值也归入状态区：关闭原生后 [好感度:X] 等标签一并从提示词移除（好感度等会话状态随之停更）。 */
export const NATIVE_STATUS_REGION_SECTION = [
    "## 状态数值",
    "【逻辑】基于当前状态 {{state}}，根据本轮对话的情绪起伏进行实时增减（范围 0-100）。",
    "【格式】[好感度:X][占有欲:X][焦虑值:X]",
    "【示例】[好感度:85][占有欲:60][焦虑值:45]",
    "",
    "## 内心想法",
    "【逻辑】反映角色在回复前的真实心理活动、潜台词或情绪波动。",
    "【格式】[内心]在此处填写内心的潜台词[/内心]",
].join("\n");

/** 群聊「### 状态值与内心」章节原文——群聊 native 挡的解析值，必须与历史版本逐字一致。
 *  与单聊那份不同：群聊要求每个发言角色在自己的 [角色名]: 块内各输出一份，且互不混用。 */
export const NATIVE_STATUS_REGION_SECTION_GROUP = [
    "### 状态值与内心",
    "【格式】",
    "每个本轮发言角色都必须先输出自己的状态值和内心想法，且必须放在该角色的同一个 [角色名]: 块内。",
    "同一个角色块只写一次 [角色名]: 前缀；不要把状态值/内心单独拆成一个角色块，也不要在正文前重复 [角色名]:。",
    "[角色名]: [好感度:X][占有欲:X][焦虑值:X]",
    "[内心]该角色此刻没有说出口的真实想法[/内心]",
    "消息正文",
    "【规则】",
    "- 状态值继承该角色 <member> 内的 current_state，并根据本轮群聊互动更新。",
    "- 不同角色的状态值互不混用；谁发言，就只输出谁自己的状态值和内心。",
    "- 不发言的角色不要输出状态值或内心。",
    "- 同一个角色在同一轮里只需要输出一次状态值和一次内心，后续多条消息用空行拆分即可。",
].join("\n");

/** 主动消息类条目里的静默输出格式原文（静默行+状态值行+内心行整块归宏） */
export const NATIVE_STATUS_REGION_EXAMPLE_LINE = [
    "如果决定静默，按照以下格式输出：",
    "[好感度:X][占有欲:X][焦虑值:X]",
    "[内心]你的所有内心想法写在这里。[/内心]",
].join("\n");

/** 文字聊天模式开头的【输出构成】行原文 */
export const NATIVE_STATUS_REGION_COMPOSITION =
    "【输出构成】输出格式由四个部分组成：状态数值、内心想法、聊天消息、富媒体动作（可选）。";

/** 「## 完整示例」里的状态值+内心两行原文 */
export const NATIVE_STATUS_REGION_FULL_EXAMPLE = [
    "[好感度:72][占有欲:25][焦虑值:15]",
    "[内心]等了{{user}}一整晚，回复这么冷淡，心里有点堵得慌。[/内心]",
].join("\n");

export const DEFAULT_STATUS_REGION_CONFIG: StatusRegionConfig = {
    mode: "native",
    contract: "",
    renderHtml: "",
    previewRaw: "",
};

/**
 * 全局私聊状态栏的默认值——starter 微博模板（contract + renderHtml + preview）。
 * 线上已配好这套，线下新用户/新环境自动 fallback 到这里，
 * 避免每个会话都是原生 [好感度:X] 那套。
 */
export const DEFAULT_GLOBAL_STATUS_REGION_CONFIG: StatusRegionConfig = {
    mode: "custom",
    contract: [
        "【逻辑】你在维护自己的微博主页。每行一个字段，用=分隔，除格式列出的字段外不要输出其他内容；帖子与评论要符合当前剧情与你的心境，网友评论可玩梗。按生成的内容整块用 [状态栏]...[/状态栏] 包裹输出。",
        "【格式】",
        "[状态栏]",
        "名字=<微博昵称>",
        "认证=<一句认证/身份标签>",
        "简介=<一句个性签名，随剧情心境更新>",
        "关注=<数字>",
        "粉丝=<数字，可带万>",
        "帖子=<时间，如 5分钟前>|<微博正文，可带 #话题#>|<0~4个emoji当配图，没有留空>|<转发数>|<评论数>|<点赞数>",
        "评论=<网友昵称>|<评论内容>|<点赞数>",
        "评论=<网友昵称>|<评论内容>|<点赞数>",
        "评论=<网友昵称>|<评论内容>|<点赞数>",
        "[/状态栏]",
    ].join("\n"),
    previewRaw: "名字=林晚\n认证=美食探店博主 · 深夜觅食团成员\n简介=白天写方案，晚上寻宵夜｜私信不回工作请走邮箱\n关注=132\n粉丝=8.7万\n帖子=23分钟前|谁懂啊，加班到十点，楼下面馆居然还给我留了最后一碗牛肉面🥹 #深夜食堂# 老板说看我常来……突然就不想跳槽了|🍜🌃✨|56|203|1.2万\n评论=小奶糖|这就是深夜的意义吧|赞 231\n评论=风住了|老板收留我当洗碗工吧，只求管饭|赞 89\n评论=momo不吃香菜|蹲一个面馆定位！|赞 156",
    renderHtml: `<style>
  :root{--bg:#fff;--text:#333;--sub:#93999f;--accent:#ff8200;--soft:#f6f7f9;--line:#f0f1f3}
  @media (prefers-color-scheme:dark){:root{--bg:#1c1c1e;--text:#e8e8ea;--sub:#8e8e93;--soft:#2a2a2c;--line:#333}}
  body{margin:0;font:12.5px/1.6 -apple-system,system-ui,sans-serif;color:var(--text);background:transparent}
  .wb{background:var(--bg);border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  .cover{height:44px;background:linear-gradient(120deg,#ffb46b,#ff7d52 55%,#f65e7c)}
  .head{padding:0 14px 10px}
  .ava{width:52px;height:52px;border-radius:50%;margin-top:-24px;border:3px solid var(--bg);
       display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff}
  .nrow{display:flex;align-items:center;gap:5px;margin-top:6px}
  .name{font-size:15px;font-weight:700}
  .vip{width:15px;height:15px;border-radius:50%;background:#ffa100;color:#fff;font-size:10px;font-weight:800;
       display:inline-flex;align-items:center;justify-content:center}
  .verify{color:var(--accent);font-size:11px;margin-top:2px}
  .bio{color:var(--sub);font-size:11.5px;margin-top:3px}
  .stats{display:flex;gap:16px;margin-top:8px;font-size:11px;color:var(--sub)}
  .stats b{color:var(--text);font-size:12.5px;margin-right:3px}
  .post{margin:0 10px;padding:10px 4px 8px;border-top:1px solid var(--line)}
  .ptime{font-size:10.5px;color:var(--sub)}
  .ptxt{margin-top:4px;white-space:pre-wrap;word-break:break-word}
  .topic{color:#ff8200}
  .pics{display:flex;gap:5px;margin-top:8px}
  .pic{flex:0 0 30%;aspect-ratio:1;border-radius:8px;background:var(--soft);
       display:flex;align-items:center;justify-content:center;font-size:30px}
  .bar{display:flex;margin-top:8px;color:var(--sub);font-size:11px}
  .bar span{flex:1;text-align:center}
  .cmts{margin:0 10px 10px;background:var(--soft);border-radius:10px;padding:8px 10px}
  .cmt{display:flex;gap:7px;padding:5px 0}
  .cmt+.cmt{border-top:1px solid var(--line)}
  .cava{width:22px;height:22px;border-radius:50%;flex:none;
        display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff}
  .cbody{flex:1;min-width:0}
  .cname{color:#eb7340;font-size:11px}
  .ctxt{font-size:11.5px;word-break:break-word}
  .clike{font-size:10px;color:var(--sub);flex:none;padding-top:2px}
</style>
<div id="app"></div>
<script>
(function(){
  var G=[["#f89b6c","#f65e7c"],["#6cb6f8","#5e7cf6"],["#8ce08a","#3cb98f"],["#c99bf5","#8a6cf6"],["#f8d06c","#f6975e"]];
  function grad(s){var n=0;for(var i=0;i<s.length;i++)n+=s.charCodeAt(i);var g=G[n%G.length];
    return "linear-gradient(135deg,"+g[0]+","+g[1]+")";}
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;
    if(txt!=null)e.textContent=txt;return e;}
  var d={},cmts=[];
  (window.STATUS_RAW||"").split(/\\r?\\n/).forEach(function(line){
    var i=line.indexOf("=");if(i<1)return;
    var k=line.slice(0,i).trim(),v=line.slice(i+1).trim();
    if(k==="评论")cmts.push(v);else d[k]=v;
  });
  var name=d["名字"]||"微博用户";
  var app=document.getElementById("app"),wb=el("div","wb");
  wb.appendChild(el("div","cover"));
  var head=el("div","head");
  var ava=el("div","ava",name.slice(0,1));ava.style.background=grad(name);head.appendChild(ava);
  var nrow=el("div","nrow");nrow.appendChild(el("span","name",name));
  nrow.appendChild(el("span","vip","V"));head.appendChild(nrow);
  if(d["认证"])head.appendChild(el("div","verify","\\\\u5fae\\\\u535a\\\\u8ba4\\\\u8bc1\\\\uff1a"+d["认证"]));
  if(d["简介"])head.appendChild(el("div","bio",d["简介"]));
  var st=el("div","stats"),s1=el("span"),s2=el("span");
  s1.appendChild(el("b",null,d["关注"]||"0"));s1.appendChild(document.createTextNode("关注"));
  s2.appendChild(el("b",null,d["粉丝"]||"0"));s2.appendChild(document.createTextNode("粉丝"));
  st.appendChild(s1);st.appendChild(s2);head.appendChild(st);wb.appendChild(head);
  if(d["帖子"]){
    var f=d["帖子"].split("|"),post=el("div","post");
    post.appendChild(el("div","ptime",(f[0]||"刚刚")+" \\\\u00b7 来自微博手机版"));
    var ptxt=el("div","ptxt");
    (f[1]||"").split(/(#[^#]{1,20}#)/).forEach(function(seg){
      if(!seg)return;
      ptxt.appendChild(seg.charAt(0)==="#"&&seg.charAt(seg.length-1)==="#"?el("span","topic",seg):document.createTextNode(seg));
    });
    post.appendChild(ptxt);
    var emo=Array.from(f[2]||"").filter(function(c){return c.trim()&&!/[\\\\ufe0f\\\\u200d]/.test(c)});
    if(emo.length){var pics=el("div","pics");
      emo.slice(0,3).forEach(function(c){pics.appendChild(el("div","pic",c));});
      post.appendChild(pics);}
    var bar=el("div","bar");
    bar.appendChild(el("span",null,"\\\\u21bb "+(f[3]||"0")));
    bar.appendChild(el("span",null,"\\\\ud83d\\\\udcac "+(f[4]||"0")));
    bar.appendChild(el("span",null,"\\\\u2661 "+(f[5]||"0")));
    post.appendChild(bar);wb.appendChild(post);
  }
  if(cmts.length){
    var box=el("div","cmts");
    cmts.forEach(function(line){
      var p=line.split("|"),c=el("div","cmt");
      var ca=el("div","cava",(p[0]||"?").slice(0,1));ca.style.background=grad(p[0]||"?");
      var body=el("div","cbody");
      body.appendChild(el("div","cname",p[0]||"网友"));
      body.appendChild(el("div","ctxt",p[1]||""));
      c.appendChild(ca);c.appendChild(body);
      c.appendChild(el("div","clike","\\\\u2661 "+String(p[2]||"").replace(/[^0-9.\\\\u4e07\\\\u4ebf]/g,"")));
      box.appendChild(c);
    });
    wb.appendChild(box);
  }
  app.appendChild(wb);
})();
</script>`,
};

function loadAll(): Record<string, StatusRegionConfig> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(kvGet(STORAGE_KEY) || "{}") as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, StatusRegionConfig>
            : {};
    } catch {
        return {};
    }
}

function normalizeConfig(raw: StatusRegionConfig | undefined): StatusRegionConfig {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_STATUS_REGION_CONFIG };
    const mode = raw.mode === "off" || raw.mode === "custom" ? raw.mode : "native";
    return {
        mode,
        contract: typeof raw.contract === "string" ? raw.contract : "",
        renderHtml: typeof raw.renderHtml === "string" ? raw.renderHtml : "",
        previewRaw: typeof raw.previewRaw === "string" ? raw.previewRaw : "",
    };
}

/**
 * 读取状态栏配置。私聊默认按“单独会话 > 全局聊天信息 > 原生”回退；
 * 群聊调用方应传 inheritGlobal=false，避免继承私聊设置。
 */
export function getStatusRegionConfig(sessionId: string, inheritGlobal = true): StatusRegionConfig {
    const all = loadAll();
    const own = all[sessionId];
    if (own) return normalizeConfig(own);
    if (inheritGlobal && sessionId !== GLOBAL_CHAT_STATUS_REGION_ID) {
        const globalCfg = all[GLOBAL_CHAT_STATUS_REGION_ID];
        if (globalCfg) return normalizeConfig(globalCfg);
        // 全局也没配过——fallback 到 starter 微博模板
        // 写入 kv，让后续刷新都直接拿到（用户手动改过的会覆盖这里）
        if (typeof window !== "undefined") {
            const next = { ...all, [GLOBAL_CHAT_STATUS_REGION_ID]: DEFAULT_GLOBAL_STATUS_REGION_CONFIG };
            kvSet(STORAGE_KEY, JSON.stringify(next));
        }
        return { ...DEFAULT_GLOBAL_STATUS_REGION_CONFIG };
    }
    if (sessionId === GLOBAL_CHAT_STATUS_REGION_ID) {
        // 直接读取全局 id，没配过就返回 starter
        return { ...DEFAULT_GLOBAL_STATUS_REGION_CONFIG };
    }
    return { ...DEFAULT_STATUS_REGION_CONFIG };
}

export function hasOwnStatusRegionConfig(sessionId: string): boolean {
    return !!loadAll()[sessionId];
}

export function clearStatusRegionConfig(sessionId: string): void {
    if (typeof window === "undefined") return;
    const all = loadAll();
    delete all[sessionId];
    kvSet(STORAGE_KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent(STATUS_REGION_UPDATED_EVENT, { detail: { sessionId } }));
}

export function saveStatusRegionConfig(sessionId: string, config: StatusRegionConfig): void {
    if (typeof window === "undefined") return;
    const all = loadAll();
    if (config.mode === "native" && !config.contract.trim() && !config.renderHtml.trim()) {
        delete all[sessionId];
    } else {
        all[sessionId] = config;
    }
    kvSet(STORAGE_KEY, JSON.stringify(all));
    window.dispatchEvent(new CustomEvent(STATUS_REGION_UPDATED_EVENT, { detail: { sessionId } }));
}

/** custom 是否真正生效（契约与渲染都要有内容，缺一回退 native 行为） */
export function isCustomStatusRegionActive(config: StatusRegionConfig): boolean {
    return config.mode === "custom" && !!config.contract.trim() && !!config.renderHtml.trim();
}

/** {{statusRegionSection}} 的解析值。
 *  variant=group 时用群聊那份 native 原文；custom 挡额外补一条"每个发言角色各出一份"的群规则，
 *  否则模型会只在整轮输出里给一个状态栏。 */
export function resolveStatusRegionSection(
    config: StatusRegionConfig,
    variant: StatusRegionVariant = "single",
): string {
    if (config.mode === "off") return "";
    if (isCustomStatusRegionActive(config)) {
        // 契约即「## 状态栏」章节的整个正文（含【逻辑】【格式】与 [状态栏] 包裹要求），不再套固定信封
        const body = "## 状态栏\n" + config.contract.trim();
        if (variant !== "group") return body;
        return [
            body,
            "",
            "【群聊补充】每个本轮发言的角色都要在自己的 [角色名]: 块内、正文之前，按上面的契约各输出一份",
            "[状态栏]...[/状态栏]；不同角色的数据互不混用，不发言的角色不输出。",
            "下方若有【完整示例】，其中每个角色的 [好感度:X][占有欲:X][焦虑值:X] 与 [内心]...[/内心] 两行",
            "一律以本契约的 [状态栏]...[/状态栏] 取代。",
        ].join("\n");
    }
    return variant === "group" ? NATIVE_STATUS_REGION_SECTION_GROUP : NATIVE_STATUS_REGION_SECTION;
}

/** {{statusRegionExampleLine}} 的解析值（主动消息类条目的静默输出格式块） */
export function resolveStatusRegionExampleLine(config: StatusRegionConfig): string {
    if (config.mode === "off") return "如果决定静默，不输出任何内容。";
    if (isCustomStatusRegionActive(config)) {
        return "如果决定静默，按照以下格式输出：\n[状态栏]（按状态栏契约输出）[/状态栏]";
    }
    return NATIVE_STATUS_REGION_EXAMPLE_LINE;
}

/** {{statusRegionComposition}} 的解析值（文字聊天模式的【输出构成】行） */
export function resolveStatusRegionComposition(config: StatusRegionConfig): string {
    if (config.mode === "off") return "【输出构成】输出格式由两个部分组成：聊天消息、富媒体动作（可选）。";
    if (isCustomStatusRegionActive(config)) {
        return "【输出构成】输出格式由三个部分组成：状态栏、聊天消息、富媒体动作（可选）。";
    }
    return NATIVE_STATUS_REGION_COMPOSITION;
}

/** {{statusRegionFullExample}} 的解析值（「## 完整示例」里的状态值+内心行） */
export function resolveStatusRegionFullExample(config: StatusRegionConfig): string {
    if (config.mode === "off") return "";
    if (isCustomStatusRegionActive(config)) return "[状态栏]（按状态栏契约输出）[/状态栏]";
    return NATIVE_STATUS_REGION_FULL_EXAMPLE;
}

/** 预设是否声明了状态区宏（聊天信息页自定义入口的可用性判定） */
export function presetSupportsStatusRegion(presetPromptTexts: string[]): boolean {
    return presetPromptTexts.some(text => text.includes(STATUS_REGION_SECTION_MACRO));
}
