"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardPaste, ExternalLink, Link2, LoaderCircle, Send, X } from "lucide-react";

import {
  clearLinkParserBaseUrl,
  loadLinkParserBaseUrl,
  parseSharedLink,
  saveLinkParserBaseUrl,
  type LinkParseResult,
} from "@/lib/link-parser";
import { loadCharacters } from "@/lib/character-storage";
import { CHAT_REQUEST_REPLY_EVENT, createOrGetSession, pushChatMessage } from "@/lib/chat-storage";

type Props = {
  open: boolean;
  onClose: () => void;
  onNotice?: (text: string) => void;
};

const PLATFORM_LABEL: Record<LinkParseResult["platform"], string> = {
  xiaohongshu: "小红书",
  douyin: "抖音",
  bilibili: "哔哩哔哩",
  unknown: "网页",
};

const LINK_PLATFORM: Record<LinkParseResult["platform"], "xiaohongshu" | "douyin" | "bilibili" | "web"> = {
  xiaohongshu: "xiaohongshu",
  douyin: "douyin",
  bilibili: "bilibili",
  unknown: "web",
};

export function LinkParseSheet({ open, onClose, onNotice }: Props) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LinkParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [savedBase, setSavedBase] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const sendToCharacter = useCallback((characterId: string, characterName: string) => {
    if (!result) return;
    const label = PLATFORM_LABEL[result.platform];
    const session = createOrGetSession(characterId);
    const desc = [result.desc, result.author ? `作者：${result.author}` : ""].filter(Boolean).join("\n").slice(0, 800);
    pushChatMessage({
      sessionId: session.id,
      role: "user",
      content: `[分享了一条${label}内容:${result.title || "无标题"}] ${desc}`.trim(),
      mediaType: "link_share",
      mediaData: {
        linkPlatform: LINK_PLATFORM[result.platform],
        linkTitle: result.title || `${label}内容`,
        linkDesc: desc,
        linkCover: result.images[0] || result.video || "",
        linkUrl: result.sourceUrl,
      },
    });
    window.dispatchEvent(new CustomEvent("chat-messages-updated", { detail: { sessionId: session.id } }));
    window.dispatchEvent(new CustomEvent(CHAT_REQUEST_REPLY_EVENT, { detail: { sessionId: session.id } }));
    onNotice?.(`已分享给${characterName}`);
    setPickerOpen(false);
    onClose();
  }, [onClose, onNotice, result]);

  useEffect(() => {
    if (!open) return;
    const value = loadLinkParserBaseUrl();
    setBaseUrl(value);
    setSavedBase(value);
  }, [open]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) setUrl(text.trim());
      else onNotice?.("剪贴板里没有文字");
    } catch {
      onNotice?.("浏览器不允许读取剪贴板，请手动长按粘贴");
    }
  }, [onNotice]);

  const handleParse = useCallback(async () => {
    if (!url.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const parsed = await parseSharedLink(url);
      setResult(parsed);
      onNotice?.(`已解析 ${PLATFORM_LABEL[parsed.platform]} 内容`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "解析失败");
    } finally {
      setLoading(false);
    }
  }, [loading, onNotice, url]);

  const saveBase = useCallback(() => {
    saveLinkParserBaseUrl(baseUrl);
    setSavedBase(baseUrl.trim().replace(/\/+$/, ""));
    onNotice?.(baseUrl.trim() ? "已保存解析服务地址" : "已改回内置解析");
  }, [baseUrl, onNotice]);

  const copyText = useCallback(async () => {
    if (!result) return;
    const text = [result.title, result.desc].filter(Boolean).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      onNotice?.("文案已复制");
    } catch {
      onNotice?.("复制失败，请手动选择文字");
    }
  }, [onNotice, result]);

  if (!open) return null;

  return (
    <div className="lps-mask" role="dialog" aria-label="链接解析">
      <section className="lps-sheet">
        <header className="lps-head">
          <div className="lps-title">
            <Link2 size={16} />
            <strong>链接解析</strong>
            <small>小红书 / 抖音 / 网页</small>
          </div>
          <button type="button" className="lps-close" onClick={onClose} aria-label="关闭"><X size={18} /></button>
        </header>

        <div className="lps-body">
          <div className="lps-input-row">
            <textarea
              value={url}
              onChange={event => setUrl(event.target.value)}
              placeholder="粘贴分享链接，例如 https://www.xiaohongshu.com/explore/..."
              rows={2}
            />
          </div>
          <div className="lps-actions">
            <button type="button" className="lps-btn lps-btn--ghost" onClick={() => void handlePaste()}>
              <ClipboardPaste size={14} /> 粘贴
            </button>
            <button type="button" className="lps-btn lps-btn--primary" disabled={!url.trim() || loading} onClick={() => void handleParse()}>
              {loading ? <><LoaderCircle size={14} className="lps-spin" /> 解析中…</> : "解析"}
            </button>
          </div>

          {error ? (
            <div className="lps-error">
              {error}
              {/解析服务|拦截|登录/.test(error) ? (
                <button type="button" className="lps-linkbtn" onClick={() => setShowSettings(true)}>去填写解析服务</button>
              ) : null}
            </div>
          ) : null}

          {result ? (
            <article className="lps-result">
              <div className="lps-result-meta">
                <span className="lps-badge">{PLATFORM_LABEL[result.platform]}</span>
                {result.author ? <span className="lps-author">{result.author}</span> : null}
                <span className="lps-via">{result.via === "custom" ? "自定义解析" : "内置解析"}</span>
              </div>
              {result.title ? <h3>{result.title}</h3> : null}
              {result.desc ? <p className="lps-desc">{result.desc}</p> : null}
              {result.images.length > 0 ? (
                <div className={`lps-images lps-images--${Math.min(result.images.length, 3)}`}>
                  {result.images.map((image, index) => (
                    <img key={`${image}-${index}`} src={image} alt={`配图 ${index + 1}`} loading="lazy" />
                  ))}
                </div>
              ) : null}
              {result.video ? <video className="lps-video" src={result.video} controls playsInline preload="metadata" /> : null}
              <div className="lps-result-actions">
                <button type="button" className="lps-btn lps-btn--primary" onClick={() => setPickerOpen(true)}>
                  <Send size={13} /> 发给角色
                </button>
                <button type="button" className="lps-btn lps-btn--ghost" onClick={() => void copyText()}>复制文案</button>
                <a className="lps-btn lps-btn--ghost" href={result.sourceUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={13} /> 打开原链接
                </a>
              </div>
            </article>
          ) : null}

          <div className="lps-settings">
            <button type="button" className="lps-settings-toggle" onClick={() => setShowSettings(value => !value)}>
              解析服务设置{savedBase ? " · 已自定义" : " · 内置"}
              <span>{showSettings ? "收起" : "展开"}</span>
            </button>
            {showSettings ? (
              <div className="lps-settings-body">
                <input
                  value={baseUrl}
                  onChange={event => setBaseUrl(event.target.value)}
                  placeholder="https://your-parser.example.com（留空用内置解析）"
                  inputMode="url"
                />
                <div className="lps-settings-actions">
                  <button type="button" className="lps-btn lps-btn--primary" onClick={saveBase}>保存</button>
                  <button
                    type="button"
                    className="lps-btn lps-btn--ghost"
                    onClick={() => { clearLinkParserBaseUrl(); setBaseUrl(""); setSavedBase(""); onNotice?.("已改回内置解析"); }}
                  >
                    恢复内置
                  </button>
                </div>
                <p className="lps-hint">
                  内置解析是服务端直读分享页；小红书/抖音风控严时可能只返回登录页。
                  自建解析服务需支持 <code>GET ?url=</code>，返回 <code>{`{title, desc, images[], video}`}</code>。
                </p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      {pickerOpen ? (
        <div className="lps-picker-mask" role="dialog" aria-label="选择角色" onClick={() => setPickerOpen(false)}>
          <section className="lps-picker" onClick={event => event.stopPropagation()}>
            <header>
              <strong>发给谁看</strong>
              <button type="button" onClick={() => setPickerOpen(false)} aria-label="关闭"><X size={16} /></button>
            </header>
            <div className="lps-picker-list">
              {loadCharacters().length === 0 ? (
                <p className="lps-hint">还没有角色，先去创建一个角色。</p>
              ) : loadCharacters().map(character => (
                <button
                  key={character.id}
                  type="button"
                  className="lps-picker-item"
                  onClick={() => sendToCharacter(character.id, character.name)}
                >
                  <span className="lps-picker-avatar">{(character.name || "?").slice(0, 1)}</span>
                  <span>{character.name}</span>
                </button>
              ))}
            </div>
            <p className="lps-hint">角色会看到平台、标题、正文和封面，并按内容回应你。</p>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default LinkParseSheet;
