"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, Heart, ImagePlus, Lock, PenLine, Plus, Sparkles, Trash2 } from "lucide-react";
import { AppCustomCSS } from "@/components/ui/app-custom-css";
import { Avatar } from "@/components/ui/primitives";
import { loadCharacters } from "@/lib/character-storage";
import type { Character } from "@/lib/character-types";
import { resolveUserIdentity } from "@/lib/settings-storage";
import {
    addCouplePhoto,
    addCoupleWish,
    addLoveLetter,
    coupleDaysTogether,
    createCoupleInvite,
    createCoupleSpace,
    loadCoupleInvite,
    loadCoupleSpace,
    removeCouplePhoto,
    removeCoupleWish,
    saveCoupleRemarks,
    toggleCoupleWish,
    type CoupleSpaceState,
} from "@/lib/couple-space-storage";
import { generateCoupleWish, generateLoveLetter } from "@/lib/couple-space-engine";
import { createOrGetSession, pushChatMessage } from "@/lib/chat-storage";

type Tab = "album" | "letters" | "wishes" | "notes";

function characterAvatar(character: Character): string | undefined {
    return (character.chatAvatarEnabled !== false ? character.chatAvatar : character.avatar) || character.avatar || undefined;
}

function todayKey(): string {
    return new Date().toISOString().slice(0, 10);
}

function resizeImage(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const image = new Image();
            image.onload = () => {
                const max = 900;
                const scale = Math.min(1, max / Math.max(image.width, image.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.round(image.width * scale);
                canvas.height = Math.round(image.height * scale);
                const ctx = canvas.getContext("2d");
                if (!ctx) { resolve(String(reader.result)); return; }
                ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", 0.82));
            };
            image.onerror = () => reject(new Error("图片读取失败"));
            image.src = String(reader.result);
        };
        reader.onerror = () => reject(new Error("图片读取失败"));
        reader.readAsDataURL(file);
    });
}

export function CoupleSpaceApp({ onClose, onNotice }: { onClose: () => void; onNotice?: (msg: string) => void }) {
    const [characters, setCharacters] = useState<Character[]>(() => (typeof window === "undefined" ? [] : loadCharacters()));
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [space, setSpace] = useState<CoupleSpaceState | null>(null);
    const [tab, setTab] = useState<Tab>("album");
    const [inviteRefresh, setInviteRefresh] = useState(0);
    const [letterDraft, setLetterDraft] = useState("");
    const [wishDraft, setWishDraft] = useState("");
    const [wishMood, setWishMood] = useState<"正经" | "不正经">("正经");
    const [busy, setBusy] = useState<"letter" | "wish" | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const user = useMemo(() => resolveUserIdentity(), []);

    const selected = useMemo(() => characters.find(item => item.id === selectedId) || null, [characters, selectedId]);

    const refresh = useCallback(() => {
        setCharacters(loadCharacters());
        setSpace(selectedId ? loadCoupleSpace(selectedId) : null);
        setInviteRefresh(value => value + 1);
    }, [selectedId]);

    useEffect(() => {
        const timers = [400, 1500].map(ms => window.setTimeout(() => {
            setCharacters(loadCharacters());
        }, ms));
        return () => timers.forEach(t => window.clearTimeout(t));
    }, []);

    useEffect(() => {
        setSpace(selectedId ? loadCoupleSpace(selectedId) : null);
    }, [selectedId]);

    const activeInvite = selected ? loadCoupleInvite(selected.id) : null; // eslint-disable-line react-hooks/exhaustive-deps

    const requestInviteFromChat = () => {
        if (!selected) return;
        try {
            createCoupleInvite(selected.id, selected.name);
            const session = createOrGetSession(selected.id);
            pushChatMessage({
                sessionId: session.id,
                role: "user",
                content: `（把情侣空间的事提起来，想等 TA 主动邀请我。）`,
                status: "sent",
            });
            window.dispatchEvent(new CustomEvent("ai-chat-request-reply", { detail: { sessionId: session.id } }));
            setInviteRefresh(value => value + 1);
            onNotice?.("已在微信里提起情侣空间，等 TA 邀请你");
            window.dispatchEvent(new CustomEvent("open-app", { detail: { appId: "chat" } }));
        } catch {
            onNotice?.("暂时无法发起，请检查聊天会话");
        }
    };

    const pairNow = () => {
        if (!selected) return;
        const next = loadCoupleSpace(selected.id) || createCoupleSpace(selected.id, selected.name);
        setSpace(next);
        onNotice?.("情侣空间已开启");
    };

    const uploadPhoto = async (file: File) => {
        if (!selected || !space) return;
        try {
            const url = await resizeImage(file);
            addCouplePhoto(selected.id, { uploader: "user", url, kind: "shared", caption: "" });
            refresh();
        } catch {
            onNotice?.("图片处理失败");
        }
    };

    const addSneakyPhoto = () => {
        if (!selected || !space) return;
        const prompt = encodeURIComponent("candid phone snapshot of a person in everyday life, warm natural light, slightly soft focus, film grain, intimate mood, no text");
        const url = `https://trae-api-cn.mchost.guru/api/ide/v1/text_to_image?prompt=${prompt}&image_size=portrait_4_3`;
        addCouplePhoto(selected.id, { uploader: "character", url, kind: "sneaky", caption: `偷拍的你 · ${new Date().toLocaleDateString("zh-CN")}` });
        refresh();
        onNotice?.(`${selected.name} 往相册里放了一张偷拍`);
    };

    const writeLetter = () => {
        if (!selected || !space || !letterDraft.trim()) return;
        addLoveLetter(selected.id, "user", letterDraft);
        setLetterDraft("");
        refresh();
    };

    const askLetterFromCharacter = async () => {
        if (!selected || !space) return;
        setBusy("letter");
        try {
            const body = await generateLoveLetter({
                characterName: selected.name,
                persona: selected.persona || "",
                userName: user?.name,
                daysTogether: coupleDaysTogether(space.pairedAt),
                recentLetters: space.letters.filter(item => item.author === "character").map(item => item.body),
            });
            if (body) addLoveLetter(selected.id, "character", body);
            refresh();
        } catch (error) {
            onNotice?.(error instanceof Error ? error.message : "情书生成失败");
        } finally {
            setBusy(null);
        }
    };

    const addWish = () => {
        if (!selected || !space || !wishDraft.trim()) return;
        addCoupleWish(selected.id, { author: "user", body: wishDraft, mood: wishMood });
        setWishDraft("");
        refresh();
    };

    const askWishFromCharacter = async () => {
        if (!selected || !space) return;
        setBusy("wish");
        try {
            const body = await generateCoupleWish({
                characterName: selected.name,
                persona: selected.persona || "",
                userName: user?.name,
                mood: wishMood,
                existing: space.wishes.map(item => item.body),
            });
            if (body) addCoupleWish(selected.id, { author: "character", body, mood: wishMood });
            refresh();
        } catch (error) {
            onNotice?.(error instanceof Error ? error.message : "愿望生成失败");
        } finally {
            setBusy(null);
        }
    };

    const todayLetterWrittenByUser = Boolean(space?.letters.some(item => item.author === "user" && item.createdAt.slice(0, 10) === todayKey()));

    const renderUnpaired = () => (
        <div style={{ padding: "20px 22px 120px" }}>
            <div style={{ borderRadius: 22, padding: "28px 20px", background: "linear-gradient(160deg, #fde8ee 0%, #f6e7f7 60%, #eef1fb 100%)", textAlign: "center" }}>
                <div style={{ width: 64, height: 64, margin: "0 auto 14px", borderRadius: "50%", background: "rgba(255,255,255,0.7)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Heart size={30} color="#e06a86" />
                </div>
                <div style={{ fontSize: 18, fontWeight: 600, color: "#5a3b47" }}>还没有属于你们的空间</div>
                <div style={{ fontSize: 13, lineHeight: 1.7, color: "#8a6b75", marginTop: 10 }}>
                    情侣空间由 TA 主动邀请你。邀请会出现在微信聊天里，24 小时内有效；拒绝或过期后，TA 还可以再申请。
                </div>
            </div>
            {selected && (
                <div style={{ marginTop: 18, padding: "14px 16px", borderRadius: 16, background: "var(--c-card-bg, #fff)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <Avatar src={characterAvatar(selected)} name={selected.name} />
                        <div style={{ flex: 1 }}>
                            <div style={{ fontSize: 15 }}>{selected.name}</div>
                            <div style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>
                                {activeInvite?.status === "pending" ? `已经邀请你了 · ${new Date(activeInvite.expiresAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 前有效` : "还没有有效邀请"}
                            </div>
                        </div>
                    </div>
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                        <button type="button" className="ui-btn ui-btn-outline" style={{ flex: 1 }} onClick={requestInviteFromChat}>让 TA 邀请我</button>
                        {activeInvite?.status === "pending" && (
                            <button type="button" className="ui-btn ui-btn-soft-action" style={{ flex: 1 }} onClick={pairNow}>直接同意</button>
                        )}
                    </div>
                </div>
            )}
        </div>
    );

    const renderPaired = () => {
        if (!space || !selected) return null;
        const days = coupleDaysTogether(space.pairedAt);
        const nextMilestone = Math.ceil(days / 100) * 100;
        const doneWishes = space.wishes.filter(item => item.done).length;
        return (
            <div style={{ paddingBottom: 40 }}>
                <div style={{ padding: "0 20px 16px", background: "linear-gradient(180deg, #fde8ee 0%, transparent 100%)" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: -12, paddingTop: 10 }}>
                        <div style={{ borderRadius: "50%", overflow: "hidden", width: 66, height: 66, border: "2px solid #fff", marginRight: -14, background: "#fff" }}>
                            <Avatar name={user?.name || "我"} size="lg" />
                        </div>
                        <div style={{ width: 30, height: 30, borderRadius: "50%", background: "#e06a86", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1 }}>
                            <Heart size={16} color="#fff" fill="#fff" />
                        </div>
                        <div style={{ borderRadius: "50%", overflow: "hidden", width: 66, height: 66, border: "2px solid #fff", marginLeft: -14, background: "#fff" }}>
                            <Avatar src={characterAvatar(selected)} name={selected.name} size="lg" />
                        </div>
                    </div>
                    <div style={{ textAlign: "center", marginTop: 10, fontSize: 15, fontWeight: 600, color: "#5a3b47" }}>
                        {user?.name?.trim() || "我"} & {selected.name}
                    </div>
                    <div style={{ textAlign: "center", marginTop: 4, fontSize: 24, fontWeight: 700, color: "#e06a86", letterSpacing: 0.5 }}>
                        在一起 {days} 天
                    </div>
                    <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                        <StatCard label="下个纪念日" value={`${nextMilestone} 天`} />
                        <StatCard label="共同愿望" value={`${doneWishes}/${space.wishes.length}`} />
                        <StatCard label="相册" value={`${space.photos.length} 张`} />
                    </div>
                </div>

                <div style={{ display: "flex", gap: 6, padding: "4px 20px 14px" }}>
                    {([["album", "相册"], ["letters", "情书"], ["wishes", "愿望板"], ["notes", "备注"]] as Array<[Tab, string]>).map(([id, label]) => (
                        <button
                            key={id}
                            type="button"
                            onClick={() => setTab(id)}
                            style={{
                                flex: 1, padding: "8px 0", borderRadius: 12, border: "none", cursor: "pointer", fontSize: 13,
                                background: tab === id ? "#e06a86" : "rgba(120,120,128,0.1)",
                                color: tab === id ? "#fff" : "var(--c-text-secondary, #8a8a8a)",
                            }}
                        >{label}</button>
                    ))}
                </div>

                {tab === "album" && (
                    <div style={{ padding: "0 20px" }}>
                        <div style={{ display: "flex", gap: 10 }}>
                            <button type="button" className="ui-btn ui-btn-soft-action" style={{ flex: 1 }} onClick={() => fileRef.current?.click()}>
                                <ImagePlus size={15} style={{ marginRight: 4 }} /> 上传照片
                            </button>
                            <button type="button" className="ui-btn ui-btn-outline" style={{ flex: 1 }} onClick={addSneakyPhoto}>让 TA 放一张</button>
                        </div>
                        <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={e => { const file = e.target.files?.[0]; if (file) void uploadPhoto(file); e.target.value = ""; }} />
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 10, marginTop: 14 }}>
                            {space.photos.length === 0 && <div style={{ gridColumn: "1 / -1", textAlign: "center", padding: 30, fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)" }}>相册还是空的。传一张共同照片，或者等 TA 偷拍你。</div>}
                            {space.photos.map(photo => (
                                <div key={photo.id} style={{ position: "relative", borderRadius: 14, overflow: "hidden", background: "#000" }}>
                                    <img src={photo.url} alt={photo.caption || "照片"} style={{ width: "100%", height: 150, objectFit: "cover", display: "block" }} />
                                    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "16px 8px 6px", background: "linear-gradient(180deg, transparent, rgba(0,0,0,0.6))", color: "#fff", fontSize: 11 }}>
                                        <div>{photo.uploader === "character" ? selected.name : "我"}{photo.kind === "sneaky" ? " · 偷拍" : ""}</div>
                                        {photo.caption && <div style={{ opacity: 0.85 }}>{photo.caption}</div>}
                                    </div>
                                    <button type="button" onClick={() => { removeCouplePhoto(selected.id, photo.id); refresh(); }} style={{ position: "absolute", top: 6, right: 6, width: 24, height: 24, borderRadius: "50%", border: "none", background: "rgba(0,0,0,0.45)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" }} aria-label="删除照片">
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {tab === "letters" && (
                    <div style={{ padding: "0 20px" }}>
                        <div style={{ padding: 14, borderRadius: 16, background: "var(--c-card-bg, #fff)" }}>
                            <div style={{ fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)", marginBottom: 8 }}>
                                今天写给 TA 的真心话{todayLetterWrittenByUser ? " · 今天已经写过一封了" : ""}
                            </div>
                            <textarea
                                value={letterDraft}
                                onChange={e => setLetterDraft(e.target.value)}
                                placeholder="只给 TA 看的话…"
                                style={{ width: "100%", minHeight: 74, resize: "none", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12, padding: 10, fontSize: 14, lineHeight: 1.6, outline: "none", background: "transparent", color: "var(--c-text)" }}
                            />
                            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                                <button type="button" className="ui-btn ui-btn-outline" style={{ flex: 1 }} disabled={busy === "letter"} onClick={() => void askLetterFromCharacter()}>
                                    <Sparkles size={14} style={{ marginRight: 4 }} />{busy === "letter" ? "TA 正在写…" : "让 TA 写今天的"}
                                </button>
                                <button type="button" className="ui-btn ui-btn-soft-action" style={{ flex: 1 }} onClick={writeLetter}>放进情书</button>
                            </div>
                        </div>
                        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                            {space.letters.length === 0 && <div style={{ textAlign: "center", padding: 24, fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)" }}>还没有情书。写下第一封吧。</div>}
                            {space.letters.map(letter => (
                                <div key={letter.id} style={{ padding: 14, borderRadius: 16, background: letter.author === "character" ? "linear-gradient(150deg,#fde8ee,#fff)" : "var(--c-card-bg, #fff)", border: "1px solid rgba(224,106,134,0.12)" }}>
                                    <div style={{ fontSize: 12, color: "#b06a80", marginBottom: 6 }}>{letter.author === "character" ? selected.name : "我"} · {new Date(letter.createdAt).toLocaleDateString("zh-CN")}</div>
                                    <div style={{ fontSize: 14, lineHeight: 1.8, whiteSpace: "pre-wrap", color: "var(--c-text)" }}>{letter.body}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {tab === "wishes" && (
                    <div style={{ padding: "0 20px" }}>
                        <div style={{ padding: 14, borderRadius: 16, background: "var(--c-card-bg, #fff)" }}>
                            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                {(["正经", "不正经"] as const).map(mood => (
                                    <button key={mood} type="button" onClick={() => setWishMood(mood)} style={{ padding: "4px 12px", borderRadius: 999, border: "none", cursor: "pointer", fontSize: 12, background: wishMood === mood ? "#e06a86" : "rgba(120,120,128,0.1)", color: wishMood === mood ? "#fff" : "var(--c-text-secondary, #8a8a8a)" }}>{mood}</button>
                                ))}
                            </div>
                            <textarea
                                value={wishDraft}
                                onChange={e => setWishDraft(e.target.value)}
                                placeholder={wishMood === "正经" ? "想和 TA 一起完成的事…" : "不太正经、只写给 TA 看的愿望…"}
                                style={{ width: "100%", minHeight: 60, resize: "none", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 12, padding: 10, fontSize: 14, lineHeight: 1.6, outline: "none", background: "transparent", color: "var(--c-text)" }}
                            />
                            <div style={{ display: "flex", gap: 10, marginTop: 8 }}>
                                <button type="button" className="ui-btn ui-btn-outline" style={{ flex: 1 }} disabled={busy === "wish"} onClick={() => void askWishFromCharacter()}>
                                    <Sparkles size={14} style={{ marginRight: 4 }} />{busy === "wish" ? "TA 正在想…" : "让 TA 也许一个"}
                                </button>
                                <button type="button" className="ui-btn ui-btn-soft-action" style={{ flex: 1 }} onClick={addWish}><Plus size={14} style={{ marginRight: 4 }} />加进愿望板</button>
                            </div>
                        </div>
                        <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
                            {space.wishes.length === 0 && <div style={{ textAlign: "center", padding: 24, fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)" }}>愿望板还是空的。</div>}
                            {space.wishes.map(wish => (
                                <div key={wish.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 14, background: "var(--c-card-bg, #fff)", opacity: wish.done ? 0.55 : 1 }}>
                                    <button type="button" onClick={() => { toggleCoupleWish(selected.id, wish.id); refresh(); }} style={{ width: 22, height: 22, borderRadius: "50%", border: wish.done ? "none" : "1.5px solid rgba(224,106,134,0.5)", background: wish.done ? "#e06a86" : "transparent", color: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12 }}>{wish.done ? "✓" : ""}</button>
                                    <div style={{ flex: 1 }}>
                                        <div style={{ fontSize: 14, lineHeight: 1.5, textDecoration: wish.done ? "line-through" : "none", color: "var(--c-text)" }}>{wish.body}</div>
                                        <div style={{ fontSize: 11, color: "var(--c-text-secondary, #8a8a8a)", marginTop: 2 }}>{wish.author === "character" ? selected.name : "我"} · {wish.mood}</div>
                                    </div>
                                    <button type="button" onClick={() => { removeCoupleWish(selected.id, wish.id); refresh(); }} style={{ background: "none", border: "none", color: "var(--c-text-secondary, #8a8a8a)", cursor: "pointer" }} aria-label="删除愿望"><Trash2 size={14} /></button>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {tab === "notes" && (
                    <div style={{ padding: "0 20px" }}>
                        <div style={{ padding: 14, borderRadius: 16, background: "var(--c-card-bg, #fff)" }}>
                            <NoteField label={`我给 ${selected.name} 的备注`} value={space.remarks.userToCharacter} onChange={value => { const next = { ...space.remarks, userToCharacter: value }; saveCoupleRemarks(selected.id, next); setSpace({ ...space, remarks: next }); }} />
                            <div style={{ height: 14 }} />
                            <NoteField label={`${selected.name} 给我的备注`} value={space.remarks.characterToUser} onChange={value => { const next = { ...space.remarks, characterToUser: value }; saveCoupleRemarks(selected.id, next); setSpace({ ...space, remarks: next }); }} />
                            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>
                                <Lock size={13} /> 备注只有你们两个人看得到。
                            </div>
                        </div>
                    </div>
                )}
            </div>
        );
    };

    return (
        <div data-app-css="couplespace" style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", background: "var(--c-page-body-bg, #faf6f7)", overflow: "hidden" }}>
            <AppCustomCSS appId="couplespace" />
            <header style={{ padding: "calc(env(safe-area-inset-top, 0px) + 44px) 16px 8px", display: "flex", alignItems: "center", gap: 10 }}>
                <button type="button" onClick={() => { if (selectedId) setSelectedId(null); else onClose(); }} style={iconButtonStyle} aria-label="返回"><ChevronLeft size={24} /></button>
                <span style={{ fontSize: 22, fontWeight: 600, flex: 1 }}>{space ? "情侣空间" : "情侣空间"}</span>
                {!selectedId && characters.length > 0 && <span style={{ fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)" }}>选择一位角色</span>}
            </header>

            {!selectedId ? (
                <div style={{ flex: 1, overflowY: "auto", padding: "6px 20px 30px" }}>
                    {characters.length === 0 ? (
                        <div style={{ textAlign: "center", padding: 50, fontSize: 13, color: "var(--c-text-secondary, #8a8a8a)" }}>还没有角色，先去创建一位吧。</div>
                    ) : characters.map(character => {
                        const paired = Boolean(loadCoupleSpace(character.id));
                        return (
                            <button key={character.id} type="button" onClick={() => { setSelectedId(character.id); setTab("album"); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "13px 0", background: "none", border: "none", borderBottom: "0.5px solid rgba(0,0,0,0.08)", cursor: "pointer", textAlign: "left" }}>
                                <Avatar src={characterAvatar(character)} name={character.name} />
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 16, color: "var(--c-text)" }}>{character.name}</div>
                                    <div style={{ fontSize: 12, color: paired ? "#e06a86" : "var(--c-text-secondary, #8a8a8a)" }}>{paired ? "情侣空间已开启" : "尚未开启情侣空间"}</div>
                                </div>
                                <ChevronLeft size={16} style={{ transform: "rotate(180deg)", color: "var(--c-text-secondary, #8a8a8a)" }} />
                            </button>
                        );
                    })}
                </div>
            ) : (
                <div style={{ flex: 1, overflowY: "auto" }} key={inviteRefresh}>
                    {space ? renderPaired() : renderUnpaired()}
                </div>
            )}
        </div>
    );
}

function StatCard({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ flex: 1, background: "rgba(255,255,255,0.65)", borderRadius: 12, padding: "8px 6px", textAlign: "center" }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#5a3b47" }}>{value}</div>
            <div style={{ fontSize: 10, color: "#a0878f", marginTop: 2 }}>{label}</div>
        </div>
    );
}

function NoteField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
    return (
        <div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--c-text-secondary, #8a8a8a)", marginBottom: 6 }}>
                <PenLine size={13} /> {label}
            </div>
            <input value={value} onChange={e => onChange(e.target.value)} placeholder="写一个只有你们懂的称呼" style={{ width: "100%", border: "1px solid rgba(0,0,0,0.1)", borderRadius: 10, padding: "9px 10px", fontSize: 14, outline: "none", background: "transparent", color: "var(--c-text)" }} />
        </div>
    );
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
