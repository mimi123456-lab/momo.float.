"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, MessageSquarePlus, Send, X, Camera } from "lucide-react";
import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { Avatar } from "@/components/ui/primitives";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { appendSmsMessage, deleteSmsThread, loadSmsThreads, type SmsThread } from "@/lib/sms-storage";
import { generateSmsReply } from "@/lib/sms-engine";

const AVATAR_KEY = "sms_custom_avatars_v1";

type CustomAvatarMap = Record<string, string | undefined>;

function loadCustomAvatars(): CustomAvatarMap {
    if (typeof window === "undefined") return {};
    try { return JSON.parse(window.localStorage.getItem(AVATAR_KEY) || "{}"); } catch { return {}; }
}

function saveCustomAvatars(map: CustomAvatarMap) {
    try { window.localStorage.setItem(AVATAR_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

function characterAvatar(character: Character, custom?: string): string | undefined {
    if (custom) return custom;
    return (character.chatAvatarEnabled !== false ? character.chatAvatar : character.avatar) || character.avatar || undefined;
}

/** 取中文姓氏，英文取首字母 */
function defaultInitial(name: string): string {
    const trimmed = name.trim();
    if (!trimmed) return "?";
    // 中文姓氏表（常用 50 个）
    const chineseSurnames = new Set([
        "赵","钱","孙","李","周","吴","郑","王","冯","陈","褚","卫","蒋","沈","韩","杨",
        "朱","秦","尤","许","何","吕","施","张","孔","曹","严","华","金","魏","陶","姜",
        "戚","谢","邹","喻","柏","水","窦","章","云","苏","潘","葛","奚","范","彭","郎",
        "鲁","韦","昌","马","苗","凤","花","方","俞","任","袁","柳","鲍","史","唐","费",
        "廉","岑","薛","雷","贺","倪","汤","滕","殷","罗","毕","郝","邬","安","常","乐",
        "于","时","傅","皮","卞","齐","康","伍","余","元","卜","顾","孟","平","黄","和",
        "穆","萧","尹","姚","邵","湛","汪","祁","毛","禹","狄","米","贝","明","臧","计",
        "成","戴","宋","茅","庞","熊","纪","舒","屈","项","祝","董","梁","杜","阮","蓝",
        "闵","席","季","麻","贾","路","娄","危","江","童","颜","郭","梅","盛","林","刁",
        "钟","徐","邱","骆","高","夏","蔡","田","樊","胡","凌","霍","虞","万","支","柯",
        "昝","管","卢","莫","经","房","裘","缪","干","解","应","宗","丁","宣","贲","邓",
        "郁","单","杭","洪","包","诸","左","石","崔","吉","龚","程","嵇","邢","滑","裴",
        "陆","荣","翁","荀","羊","於","惠","甄","曲","家","封","芮","羿","储","靳","汲",
        "邴","糜","松","井","段","富","巫","乌","焦","巴","弓","牧","隗","山","谷","车",
        "侯","宓","蓬","全","郗","班","仰","秋","仲","伊","宫","宁","仇","栾","暴","甘",
        "钭","厉","戎","祖","武","符","刘","景","詹","束","龙","叶","幸","司","韶","郜",
        "黎","蓟","薄","印","宿","白","怀","蒲","邰","从","鄂","索","咸","籍","赖","卓",
        "蔺","屠","蒙","池","乔","阴","鬱","胥","能","苍","双","闻","莘","党","翟","谭",
        "贡","劳","逄","姬","申","扶","堵","冉","宰","郦","雍","璩","桑","桂","濮","牛",
        "寿","通","边","扈","燕","冀","郏","浦","尚","农","温","别","庄","晏","柴","瞿",
        "阎","充","慕","连","茹","习","宦","艾","鱼","容","向","古","易","慎","戈","廖",
        "庾","终","暨","居","衡","步","都","耿","满","弘","匡","国","文","寇","广","禄",
        "阙","东","欧","沃","利","蔚","越","夔","隆","师","巩","厍","聂","晁","勾","敖",
        "融","冷","訾","辛","阚","那","简","饶","空","曾","毋","沙","乜","养","鞠","须",
        "丰","巢","关","蒯","相","查","后","荆","红","游","竺","权","逯","盖","益","桓",
        "公","夏","侯","谭","许","孙","钟","宇文","慕容","上官","司徒","欧阳","太史","端木","皇甫","令狐",
    ]);
    // 双姓优先匹配
    if (trimmed.length >= 2) {
        const two = trimmed.slice(0, 2);
        if (chineseSurnames.has(two)) return two;
    }
    const first = trimmed[0];
    if (chineseSurnames.has(first)) return first;
    // 非中文取首字母大写
    if (/[A-Za-z]/.test(first)) return first.toUpperCase();
    return first || "?";
}

function formatWhen(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    if (date.toDateString() === now.toDateString()) return hm;
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

const iconButtonStyle: React.CSSProperties = {
    background: "none",
    border: "none",
    padding: 6,
    cursor: "pointer",
    color: "var(--c-text)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
};

function AvatarCell({
    character,
    customSrc,
    size = 44,
    onClickUpload,
    onClear,
}: {
    character: Character;
    customSrc?: string;
    size?: number;
    onClickUpload?: (e?: React.MouseEvent) => void;
    onClear?: () => void;
}) {
    const uploaded = characterAvatar(character, customSrc);
    const initial = defaultInitial(character.name);
    return (
        <button
            type="button"
            onClick={onClickUpload}
            className="sms-avatar-cell"
            style={{
                width: size,
                height: size,
                borderRadius: "50%",
                border: "none",
                padding: 0,
                cursor: "pointer",
                position: "relative",
                flexShrink: 0,
                overflow: "visible",
                background: "transparent",
            }}
            aria-label={`${character.name} 头像`}
        >
            <div
                className="sms-avatar"
                data-has-image={uploaded ? "true" : "false"}
                data-initial={initial}
                style={{
                    width: "100%",
                    height: "100%",
                    borderRadius: "50%",
                    overflow: "hidden",
                    backgroundImage: uploaded ? `url(${uploaded})` : "none",
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    backgroundRepeat: "no-repeat",
                    background: uploaded ? "transparent" : undefined,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                }}
            >
                {uploaded ? null : (
                    <span
                        className="sms-avatar-initial"
                        style={{
                            fontSize: size * 0.42,
                            fontWeight: 600,
                        }}
                    >{initial}</span>
                )}
            </div>
            <div className="sms-avatar-edit-badge" aria-hidden>
                <Camera size={10} />
            </div>
            {onClear && customSrc ? (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onClear(); }}
                    className="sms-avatar-clear"
                    aria-label="恢复默认"
                ><X size={10} /></button>
            ) : null}
        </button>
    );
}

export function SmsApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [characters, setCharacters] = useState<Character[]>(() => (typeof window === "undefined" ? [] : loadCharacters()));
    const [threads, setThreads] = useState<SmsThread[]>(() => (typeof window === "undefined" ? [] : loadSmsThreads()));
    const [activeCharacterId, setActiveCharacterId] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const [customAvatars, setCustomAvatars] = useState<CustomAvatarMap>(() => loadCustomAvatars());
    const scrollRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<string | null>(null);

    const refresh = useCallback(() => {
        setCharacters(loadCharacters());
        setThreads(loadSmsThreads());
    }, []);

    useEffect(() => {
        const timers = [400, 1500].map(ms => window.setTimeout(refresh, ms));
        return () => timers.forEach(t => window.clearTimeout(t));
    }, [refresh]);

    useEffect(() => {
        const onOpen = (event: Event) => {
            const detail = (event as CustomEvent<{ characterId?: string }>).detail;
            if (detail?.characterId) {
                setActiveCharacterId(detail.characterId);
                refresh();
            }
        };
        window.addEventListener("sms-open-thread", onOpen);
        return () => window.removeEventListener("sms-open-thread", onOpen);
    }, [refresh]);

    const activeCharacter = useMemo(() => characters.find(item => item.id === activeCharacterId) || null, [characters, activeCharacterId]);
    const activeThread = useMemo(() => threads.find(item => item.characterId === activeCharacterId) || null, [threads, activeCharacterId]);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [activeThread?.messages.length, activeCharacterId]);

    const openThread = (characterId: string) => {
        setActiveCharacterId(characterId);
        setPickerOpen(false);
        setDraft("");
    };

    const pickAvatar = (characterId: string) => {
        uploadTargetRef.current = characterId;
        fileInputRef.current?.click();
    };

    const handleAvatarFile = async (file: File | undefined) => {
        const targetId = uploadTargetRef.current;
        uploadTargetRef.current = null;
        if (!targetId || !file) return;
        if (!file.type.startsWith("image/")) { onNotice?.("请选图片"); return; }
        if (file.size > 2 * 1024 * 1024) { onNotice?.("图片太大，挑小一点的"); return; }
        const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        }).catch(() => null);
        if (!dataUrl) { onNotice?.("上传失败"); return; }
        const next = { ...customAvatars, [targetId]: dataUrl };
        saveCustomAvatars(next);
        setCustomAvatars(next);
    };

    const clearAvatar = (characterId: string) => {
        const next = { ...customAvatars };
        delete next[characterId];
        saveCustomAvatars(next);
        setCustomAvatars(next);
    };

    const send = async () => {
        const text = draft.trim();
        if (!text || !activeCharacter || sending) return;
        setDraft("");
        appendSmsMessage(activeCharacter.id, activeCharacter.name, "user", text);
        setThreads(loadSmsThreads());
        setSending(true);
        try {
            const history = (loadSmsThreads().find(item => item.characterId === activeCharacter.id)?.messages || []).slice(0, -1);
            const replies = await generateSmsReply({
                characterId: activeCharacter.id,
                characterName: activeCharacter.name,
                persona: activeCharacter.persona || "",
                history,
                text,
            });
            if (replies.length === 0) {
                appendSmsMessage(activeCharacter.id, activeCharacter.name, "character", "嗯。");
            } else {
                replies.forEach(reply => appendSmsMessage(activeCharacter.id, activeCharacter.name, "character", reply));
            }
        } catch (error) {
            appendSmsMessage(activeCharacter.id, activeCharacter.name, "character", error instanceof Error ? `（发送失败：${error.message}）` : "（短信发送失败）");
            onNotice?.(error instanceof Error ? error.message : "短信发送失败");
        } finally {
            setSending(false);
            setThreads(loadSmsThreads());
        }
    };

    const renderList = () => (
        <div className="sms-thread-list" style={{ flex: 1, overflowY: "auto", padding: "0 0 24px" }}>
            {threads.length === 0 ? (
                <div style={{ padding: "60px 24px", textAlign: "center", fontSize: 14, color: "rgba(255,255,255,0.55)" }}>
                    还没有短信。点右上角新建，选一个联系人发第一条。
                </div>
            ) : threads.map(thread => {
                const character = characters.find(c => c.id === thread.characterId);
                const avatarCellNode = character
                    ? <AvatarCell
                        character={character}
                        customSrc={customAvatars[character.id]}
                        size={48}
                        onClickUpload={() => pickAvatar(character.id)}
                        onClear={() => clearAvatar(character.id)}
                    />
                    : <Avatar src={undefined} name={thread.characterName} />;
                return (
                    <button
                        key={thread.characterId}
                        type="button"
                        onClick={() => openThread(thread.characterId)}
                        className="sms-thread-row"
                        style={{
                            width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                            background: "none", border: "none", borderBottom: "0.5px solid rgba(255,255,255,0.08)",
                            cursor: "pointer", textAlign: "left",
                        }}
                    >
                        {avatarCellNode}
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                                <span className="sms-thread-name">{thread.characterName}</span>
                                <span className="sms-thread-time">{formatWhen(thread.updatedAt)}</span>
                            </div>
                            <div className="sms-thread-preview">{thread.messages[thread.messages.length - 1]?.body || "暂无消息"}</div>
                        </div>
                    </button>
                );
            })}
        </div>
    );

    const renderThread = () => {
        if (!activeCharacter) return null;
        const messages = activeThread?.messages || [];
        const avatarCellNode = (
            <AvatarCell
                character={activeCharacter}
                customSrc={customAvatars[activeCharacter.id]}
                size={36}
                onClickUpload={() => pickAvatar(activeCharacter.id)}
                onClear={() => clearAvatar(activeCharacter.id)}
            />
        );
        return (
            <>
                <header className="sms-thread-header">
                    <button type="button" onClick={() => setActiveCharacterId(null)} style={iconButtonStyle} aria-label="返回"><ChevronLeft size={24} /></button>
                    <div className="sms-thread-header-title">
                        {avatarCellNode}
                        <span className="sms-thread-header-name">{activeCharacter.name}</span>
                    </div>
                    <button type="button" onClick={() => { if (activeCharacter && window.confirm(`删除和${activeCharacter.name}的短信？`)) { deleteSmsThread(activeCharacter.id); setThreads(loadSmsThreads()); setActiveCharacterId(null); } }} className="sms-header-delete">删除</button>
                </header>
                <div ref={scrollRef} className="sms-thread-body">
                    {messages.length === 0 && <div className="sms-empty-hint">发一条短信给 {activeCharacter.name}</div>}
                    {messages.map((message, index) => {
                        const isUser = message.role === "user";
                        const prevRole = messages[index - 1]?.role;
                        const nextRole = messages[index + 1]?.role;
                        const consecutive = prevRole === message.role;
                        const lastConsecutive = nextRole !== message.role; // 下一条不同或不存在 → 当前是组末尾
                        return (
                            <div key={message.id} className={`sms-bubble-row ${isUser ? "is-user" : "is-char"} ${consecutive ? "is-consecutive" : ""}`}>
                                {!isUser && !consecutive ? (
                                    <div className="sms-bubble-avatar">
                                        {avatarCellNode}
                                    </div>
                                ) : null}
                                <div
                                    className={`sms-bubble sms-bubble-${isUser ? "user" : "char"}`}
                                    data-last-consecutive={lastConsecutive ? "true" : "false"}
                                >
                                    {message.body}
                                </div>
                            </div>
                        );
                    })}
                    {sending && (
                        <div className="sms-typing">
                            <span />
                            <span />
                            <span />
                        </div>
                    )}
                </div>
                <div className="sms-input-bar">
                    <textarea
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
                        }}
                        placeholder="iMessage"
                        rows={1}
                        className="sms-input"
                        style={{
                            flex: 1, resize: "none", border: "none", borderRadius: 18, padding: "9px 14px",
                            fontSize: 16, outline: "none", background: "rgba(30, 32, 38, 0.55)", color: "#fff",
                            maxHeight: 110,
                        }}
                    />
                    <button type="button" onClick={() => void send()} disabled={!draft.trim() || sending} className="sms-send-btn" aria-label="发送">
                        <Send size={18} strokeWidth={2.4} />
                    </button>
                </div>
            </>
        );
    };

    const renderPicker = (): ReactNode => (
        <div className="sms-picker">
            <header className="sms-picker-header">
                <button type="button" onClick={() => setPickerOpen(false)} style={{ ...iconButtonStyle, color: "#fff" }} aria-label="返回"><ChevronLeft size={24} /></button>
                <span className="sms-picker-title">新建短信</span>
            </header>
            <div className="sms-picker-list" style={{ flex: 1, overflowY: "auto", padding: "0 16px 24px" }}>
                {characters.length === 0 ? (
                    <div className="sms-empty-hint">还没有角色，先去创建一位。</div>
                ) : characters.map(character => (
                    <button
                        key={character.id}
                        type="button"
                        onClick={() => openThread(character.id)}
                        className="sms-picker-row"
                    >
                        <AvatarCell
                            character={character}
                            customSrc={customAvatars[character.id]}
                            size={40}
                            onClickUpload={(e) => { e?.stopPropagation(); pickAvatar(character.id); }}
                            onClear={() => clearAvatar(character.id)}
                        />
                        <span className="sms-picker-name">{character.name}</span>
                        <ChevronRight size={16} color="rgba(255,255,255,0.4)" />
                    </button>
                ))}
            </div>
        </div>
    );

    return (
        <div data-app-css="sms" className="sms-app" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <AppCustomCSS appId="sms" />
            {/* 液态玻璃主题样式（默认启用，也可在主题 App 里自定义覆盖） */}
            <style>{SMS_LIQUID_GLASS_CSS}</style>

            <input
                type="file"
                accept="image/*"
                ref={fileInputRef}
                style={{ display: "none" }}
                onChange={(e) => void handleAvatarFile(e.target.files?.[0])}
            />

            {activeCharacter ? renderThread() : (
                <>
                    <header className="sms-root-header">
                        <button type="button" onClick={onClose} style={{ ...iconButtonStyle, marginLeft: -6, color: "#fff" }} aria-label="返回"><ChevronLeft size={24} /></button>
                        <span className="sms-root-title">短信</span>
                        <button type="button" onClick={() => setPickerOpen(true)} className="sms-root-add" aria-label="新建短信"><MessageSquarePlus size={22} /></button>
                    </header>
                    {renderList()}
                </>
            )}

            {pickerOpen && renderPicker()}
        </div>
    );
}

// ── 液态玻璃主题 CSS（作用域限定在 [data-app-css="sms"]） ──

const SMS_LIQUID_GLASS_CSS = `
[data-app-css="sms"] {
  --sms-user-bg: linear-gradient(180deg, rgba(27,138,251,0.88) 0%, rgba(0,112,235,0.96) 100%);
  --sms-char-bg: linear-gradient(145deg, rgba(42,45,55,0.58) 0%, rgba(20,22,28,0.45) 100%);
  --sms-bg-1: #0b1014;
  --sms-bg-2: #141b22;
  --sms-bg-3: #0a1218;
  --sms-text: rgba(255,255,255,0.88);
  --sms-text-sub: rgba(255,255,255,0.55);
  --sms-border: rgba(255,255,255,0.08);
  --tail-svg-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 162.72 125.02'%3E%3Cpath d='M217.52 238.64v47.64a29.74 29.74 0 0 1-5 0c-7.29-1.32-13.65 2.13-19.5 5.07-7.42 3.73-13.81 9.5-20.61 14.43-5.39 3.9-10.79 7.79-16.1 11.79-2.83 2.13-5.35 4.67-8.23 6.72s-6.26 3.91-9.4 5.85c-4.12 2.55-8.16 5.23-12.38 7.61-3.56 2-18.08 10.12-21.63 12.47-.23.15-.39.43-.64.54-4.36 1.84-8.75 3.61-13.09 5.5s-8.53 3.72-12.7 5.79a27.6 27.6 0 0 1-14 .91c-3.73-.71-6.63-2.22-6.94-2.65-4-5.47-2.7-10.41.15-15.16.21-.36 6.54-10.31 10-14.68A42.08 42.08 0 0 0 74.29 316c3.69-13.08 5.65-26.53 4-40.12a33 33 0 0 0-6.67-16c-3.68-4.81-6.91-10-10.44-14.91-.66-.93-1.91-1.42-2.66-2.3a3.59 3.59 0 0 1-1.08-2.48c.13-.68 1.21-1.43 2-1.64a15.38 15.38 0 0 1 3.79-.22H213.83c1.1.26 2.17.41 3.69.52Z' transform='translate(-54.81 -238.38)'/%3E%3C/svg%3E");
}
[data-app-css="sms"] .sms-app {
  background: radial-gradient(120% 90% at 50% -10%, var(--sms-bg-2), var(--sms-bg-1) 60%, var(--sms-bg-3));
  color: var(--sms-text);
}
[data-app-css="sms"] .sms-root-header,
[data-app-css="sms"] .sms-thread-header,
[data-app-css="sms"] .sms-picker-header {
  padding: calc(env(safe-area-inset-top, 0px) + 46px) 14px 10px;
  display: flex; align-items: center; gap: 10px;
  background: rgba(10, 13, 16, 0.55);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
  border-bottom: 0.5px solid var(--sms-border);
}
[data-app-css="sms"] .sms-root-title {
  flex: 1;
  font-size: 30px; font-weight: 700; letter-spacing: -0.6px;
  background: linear-gradient(180deg, #ffffff, rgba(255,255,255,0.72));
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
[data-app-css="sms"] .sms-root-add {
  width: 38px; height: 38px;
  border-radius: 50%;
  border: 0.5px solid rgba(255,255,255,0.18);
  background: rgba(30,32,38,0.7);
  backdrop-filter: blur(16px) saturate(180%);
  -webkit-backdrop-filter: blur(16px) saturate(180%);
  color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0.5px 0.5px 0.5px rgba(255,255,255,0.22), 0 4px 14px rgba(0,0,0,0.28);
  padding: 0;
}
[data-app-css="sms"] .sms-root-add:active { transform: scale(0.92); }

[data-app-css="sms"] .sms-thread-row { color: inherit; }
[data-app-css="sms"] .sms-thread-row:hover { background: rgba(255,255,255,0.04); }
[data-app-css="sms"] .sms-thread-name { font-size: 16px; font-weight: 600; color: #fff; }
[data-app-css="sms"] .sms-thread-time { font-size: 12px; color: var(--sms-text-sub); }
[data-app-css="sms"] .sms-thread-preview {
  font-size: 13px; color: var(--sms-text-sub);
  margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* ── Thread header ── */
[data-app-css="sms"] .sms-thread-header {
  padding: calc(env(safe-area-inset-top, 0px) + 42px) 10px 10px;
  border-bottom: 0.5px solid var(--sms-border);
}
[data-app-css="sms"] .sms-thread-header-title {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 4px;
}
[data-app-css="sms"] .sms-thread-header-name {
  font-size: 13px; font-weight: 600; color: #fff;
}
[data-app-css="sms"] .sms-header-delete {
  font-size: 12px; font-weight: 600;
  border-radius: 10px; padding: 7px 10px;
  border: 0.5px solid rgba(255,255,255,0.14);
  background: rgba(30,32,38,0.55);
  backdrop-filter: blur(12px) saturate(160%);
  -webkit-backdrop-filter: blur(12px) saturate(160%);
  color: #ff7a74; cursor: pointer;
}

/* ── Avatar ── */
[data-app-css="sms"] .sms-avatar {
  border: 0.5px solid rgba(255,255,255,0.22);
  background: linear-gradient(145deg, rgba(255,255,255,0.18), rgba(255,255,255,0.05));
  color: #fff;
  box-shadow: inset 0.5px 0.5px 0.5px rgba(255,255,255,0.25), 0 4px 10px rgba(0,0,0,0.22);
}
[data-app-css="sms"] .sms-avatar[data-has-image="true"] {
  background: transparent;
  border: 0.5px solid rgba(255,255,255,0.18);
}
[data-app-css="sms"] .sms-avatar-initial {
  text-shadow: 0 1px 2px rgba(0,0,0,0.35);
}
[data-app-css="sms"] .sms-avatar-edit-badge {
  position: absolute; right: -2px; bottom: -2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(27,138,251,0.92);
  border: 2px solid var(--sms-bg-1);
  display: flex; align-items: center; justify-content: center;
  color: #fff;
  opacity: 0;
  transform: scale(0.6);
  transition: opacity 0.16s ease, transform 0.16s ease;
}
[data-app-css="sms"] .sms-avatar-cell:hover .sms-avatar-edit-badge,
[data-app-css="sms"] .sms-avatar-cell:active .sms-avatar-edit-badge {
  opacity: 1; transform: scale(1);
}
[data-app-css="sms"] .sms-avatar-clear {
  position: absolute; top: -4px; right: -4px;
  width: 16px; height: 16px; border-radius: 50%;
  background: rgba(255,69,58,0.9);
  border: 2px solid var(--sms-bg-1);
  color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  padding: 0; opacity: 0; transform: scale(0.6);
  transition: opacity 0.16s ease, transform 0.16s ease;
}
[data-app-css="sms"] .sms-avatar-cell:hover .sms-avatar-clear { opacity: 1; transform: scale(1); }

/* ── Thread body ── */
[data-app-css="sms"] .sms-thread-body {
  flex: 1; overflow-y: auto; padding: 16px 14px 22px;
  display: flex; flex-direction: column; gap: 8px;
}
[data-app-css="sms"] .sms-bubble-row {
  display: flex; gap: 8px; align-items: flex-end;
}
[data-app-css="sms"] .sms-bubble-row.is-user { justify-content: flex-end; }
[data-app-css="sms"] .sms-bubble-row.is-char { justify-content: flex-start; }
[data-app-css="sms"] .sms-bubble-row.is-consecutive { gap: 4px; margin-top: -2px; }
[data-app-css="sms"] .sms-bubble-avatar {
  width: 28px; height: 28px; flex-shrink: 0;
}
[data-app-css="sms"] .sms-bubble-avatar .sms-avatar-cell { width: 100%; height: 100%; }
[data-app-css="sms"] .sms-bubble-avatar .sms-avatar-edit-badge,
[data-app-css="sms"] .sms-bubble-avatar .sms-avatar-clear { display: none; }

[data-app-css="sms"] .sms-bubble {
  max-width: 72%;
  padding: 9px 14px; font-size: 15px; line-height: 1.45;
  white-space: pre-wrap; word-break: break-word;
  position: relative;
  overflow: visible;
  border-radius: 20px;
  backdrop-filter: blur(20px) saturate(190%);
  -webkit-backdrop-filter: blur(20px) saturate(190%);
  box-shadow: inset 0.5px 0.5px 0.5px rgba(255,255,255,0.25), 0 4px 14px rgba(0,0,0,0.25);
  border: 0.5px solid rgba(255,255,255,0.18);
}
[data-app-css="sms"] .sms-bubble-user {
  background: var(--sms-user-bg);
  color: #fff;
}
[data-app-css="sms"] .sms-bubble-char {
  background: var(--sms-char-bg);
  color: #fff;
}
/* ── SVG mask 尾巴：默认隐藏，data-last-consecutive="true" 才显示 ── */
[data-app-css="sms"] .sms-bubble::before {
  content: "";
  position: absolute;
  bottom: -8px;
  width: 16px;
  height: 12px;
  -webkit-mask: var(--tail-svg-mask) center/contain no-repeat;
  mask: var(--tail-svg-mask) center/contain no-repeat;
  pointer-events: none;
  display: none;
  z-index: -1;
  -webkit-clip-path: inset(2px 0 0 0);
  clip-path: inset(2px 0 0 0);
  backdrop-filter: blur(8px) saturate(180%);
  -webkit-backdrop-filter: blur(8px) saturate(180%);
}
[data-app-css="sms"] .sms-bubble-user::before {
  right: 7px;
  background: var(--sms-user-bg);
  background-color: transparent;
  transform: scaleX(-1);
  filter: drop-shadow(0.5px 0 0 rgba(255,255,255,0.45))
          drop-shadow(0 0.5px 0 rgba(255,255,255,0.35))
          drop-shadow(0 2px 5px rgba(0,112,235,0.4));
}
[data-app-css="sms"] .sms-bubble-char::before {
  left: 7px;
  background: var(--sms-char-bg);
  background-color: transparent;
  filter: drop-shadow(-0.5px 0 0 rgba(255,255,255,0.35))
          drop-shadow(0 0.5px 0 rgba(255,255,255,0.25))
          drop-shadow(0 1.5px 3px rgba(0,0,0,0.2));
}
/* 只有末尾气泡才显示尾巴 */
[data-app-css="sms"] .sms-bubble[data-last-consecutive="true"]::before {
  display: block;
}

/* ── 输入中：液态玻璃胶囊气泡 + 动态三点 ── */
[data-app-css="sms"] .sms-typing {
  position: relative;
  align-self: flex-start;
  width: 64px;
  min-width: 64px;
  height: 38px;
  min-height: 38px;
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
  color: transparent;
  font-size: 0;
  line-height: 0;
  filter: drop-shadow(0 4px 12px rgba(0,0,0,0.45));
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  overflow: visible;
  isolation: isolate;
  pointer-events: none;
}
[data-app-css="sms"] .sms-typing span {
  display: none !important;
}
[data-app-css="sms"] .sms-typing::before {
  content: "";
  position: absolute;
  top: 0;
  left: -8px;
  right: 0;
  bottom: -8px;
  width: auto;
  height: auto;
  background: linear-gradient(145deg, rgba(42,45,55,0.72) 0%, rgba(20,22,28,0.65) 100%);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 46' preserveAspectRatio='none'%3E%3Cpath fill='white' d='M 24 3 C 34 1 49 1 59 3 C 67 5 71 11 71 19 C 71 28 66 33 58 35 C 47 37 35 37 25 35 C 21 34 18 33 16 31 C 12 35 7 33 7 29 C 7 26 9 24 11 24 C 8 20 8 16 10 12 C 12 7 17 4 24 3 Z' /%3E%3Ccircle cx='5' cy='41' r='2.5' fill='white' /%3E%3C/svg%3E") center / 100% 100% no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 46' preserveAspectRatio='none'%3E%3Cpath fill='white' d='M 24 3 C 34 1 49 1 59 3 C 67 5 71 11 71 19 C 71 28 66 33 58 35 C 47 37 35 37 25 35 C 21 34 18 33 16 31 C 12 35 7 33 7 29 C 7 26 9 24 11 24 C 8 20 8 16 10 12 C 12 7 17 4 24 3 Z' /%3E%3Ccircle cx='5' cy='41' r='2.5' fill='white' /%3E%3C/svg%3E") center / 100% 100% no-repeat;
  pointer-events: none;
  z-index: -1;
}
[data-app-css="sms"] .sms-typing::after {
  content: "";
  position: absolute;
  top: 0;
  left: -8px;
  width: calc(100% + 8px);
  height: calc(100% + 8px);
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='40' viewBox='0 0 72 40'%3E%3Cg transform='translate(26 2) scale(1.1666667)'%3E%3Cpath d='M0 0h24v24H0z' fill='none'/%3E%3Ccircle cx='4' cy='12' r='2.8' fill='white'%3E%3Canimate id='dot1' fill='freeze' attributeName='opacity' begin='0;dot3.end-0.25s' dur='0.75s' values='1;.2'/%3E%3C/circle%3E%3Ccircle cx='12' cy='12' r='2.8' fill='white' opacity='.4'%3E%3Canimate fill='freeze' attributeName='opacity' begin='dot1.begin+0.15s' dur='0.75s' values='1;.2'/%3E%3C/circle%3E%3Ccircle cx='20' cy='12' r='2.8' fill='white' opacity='.3'%3E%3Canimate id='dot3' fill='freeze' attributeName='opacity' begin='dot1.begin+0.3s' dur='0.75s' values='1;.2'/%3E%3C/circle%3E%3C/g%3E%3C/svg%3E") center / 72px 40px no-repeat,
              url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 72 46' preserveAspectRatio='none'%3E%3Cg fill='none' stroke='white' stroke-opacity='.45' stroke-width='.7'%3E%3Cpath d='M 24 3 C 34 1 49 1 59 3 C 67 5 71 11 71 19 C 71 28 66 33 58 35 C 47 37 35 37 25 35 C 21 34 18 33 16 31 C 12 35 7 33 7 29 C 7 26 9 24 11 24 C 8 20 8 16 10 12 C 12 7 17 4 24 3 Z' /%3E%3Ccircle cx='5' cy='41' r='2.5' /%3E%3C/g%3E%3C/svg%3E") center / 100% 100% no-repeat;
  pointer-events: none;
  z-index: 1;
}

/* ── Input bar ── */
[data-app-css="sms"] .sms-input-bar {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 8px 12px calc(env(safe-area-inset-bottom, 0px) + 10px);
  border-top: 0.5px solid var(--sms-border);
  background: rgba(10,13,16,0.6);
  backdrop-filter: blur(22px) saturate(180%);
  -webkit-backdrop-filter: blur(22px) saturate(180%);
}
[data-app-css="sms"] .sms-input {
  border: 0.5px solid rgba(255,255,255,0.16) !important;
  box-shadow: inset 0.5px 0.5px 0.5px rgba(255,255,255,0.16), 0 4px 14px rgba(0,0,0,0.22);
}
[data-app-css="sms"] .sms-send-btn {
  width: 36px; height: 36px; border-radius: 50%;
  border: 0.5px solid rgba(255,255,255,0.2);
  background: var(--sms-user-bg);
  color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  box-shadow: inset 0.5px 0.5px 0.5px rgba(255,255,255,0.35), 0 4px 14px rgba(0,112,235,0.4);
  padding: 0; flex-shrink: 0;
  transition: transform 0.14s ease, opacity 0.14s ease;
}
[data-app-css="sms"] .sms-send-btn[disabled] { opacity: 0.35; cursor: not-allowed; }
[data-app-css="sms"] .sms-send-btn:active { transform: scale(0.92); }

/* ── Picker ── */
[data-app-css="sms"] .sms-picker {
  position: absolute; inset: 0; z-index: 10;
  display: flex; flex-direction: column;
  background: radial-gradient(120% 90% at 50% -10%, var(--sms-bg-2), var(--sms-bg-1) 60%, var(--sms-bg-3));
}
[data-app-css="sms"] .sms-picker-title {
  font-size: 20px; font-weight: 600; color: #fff;
  flex: 1;
}
[data-app-css="sms"] .sms-picker-row {
  width: 100%; display: flex; align-items: center; gap: 12px;
  padding: 12px 0;
  background: none; border: none;
  border-bottom: 0.5px solid var(--sms-border);
  cursor: pointer; text-align: left;
}
[data-app-css="sms"] .sms-picker-name { flex: 1; font-size: 16px; color: #fff; }

[data-app-css="sms"] .sms-empty-hint {
  padding: 40px; text-align: center;
  font-size: 14px; color: rgba(255,255,255,0.55);
}
`;
