"use client";

import { useRef, useState } from "react";
import { sendOocMessage, type OocTurn } from "@/lib/ooc-engine";

type OocModalProps = {
    characterName: string;
    userName?: string;
    recent: Array<{ role: "user" | "assistant" | "system"; content: string }>;
    onClose: () => void;
};

/** OOC 纠偏面板：直接和模型讨论设定/剧情，不进聊天记录、不进角色记忆。 */
export function OocModal({ characterName, userName, recent, onClose }: OocModalProps) {
    const [turns, setTurns] = useState<OocTurn[]>([]);
    const [text, setText] = useState("");
    const [sending, setSending] = useState(false);
    const [error, setError] = useState("");
    const listRef = useRef<HTMLDivElement>(null);

    const submit = async () => {
        const trimmed = text.trim();
        if (!trimmed || sending) return;
        const nextTurns: OocTurn[] = [...turns, { role: "user", content: trimmed }];
        setTurns(nextTurns);
        setText("");
        setSending(true);
        setError("");
        try {
            const reply = await sendOocMessage({
                characterName,
                userName,
                recent,
                history: turns,
                text: trimmed,
            });
            setTurns(current => [...current, { role: "assistant", content: reply || "（模型没有返回内容）" }]);
        } catch (err) {
            setError(err instanceof Error ? err.message : "请求失败");
            setTurns(current => current.slice(0, -1));
            setText(trimmed);
        } finally {
            setSending(false);
            requestAnimationFrame(() => {
                listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
            });
        }
    };

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog" style={{ display: "flex", flexDirection: "column", maxHeight: "78%" }}>
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">OOC 纠偏</div>
                <p className="ts-12 text-center text-[var(--c-text)] opacity-60">
                    以作者视角直接和模型讨论「{characterName}」的设定与剧情，不写入聊天和记忆
                </p>
                <div ref={listRef} className="w-full flex flex-col gap-2 overflow-y-auto" style={{ minHeight: 140, maxHeight: 260, padding: "4px 0" }}>
                    {turns.length === 0 ? (
                        <p className="ts-12 text-[var(--c-text)] opacity-50" style={{ textAlign: "center", marginTop: 24 }}>
                            例如：他现在的人设是不是太冷淡了？帮我改成更主动一点。
                        </p>
                    ) : turns.map((turn, i) => (
                        <div
                            key={i}
                            className="ts-13 text-[var(--c-text)]"
                            style={{
                                alignSelf: turn.role === "user" ? "flex-end" : "flex-start",
                                maxWidth: "86%",
                                whiteSpace: "pre-wrap",
                                padding: "8px 10px",
                                borderRadius: 10,
                                background: turn.role === "user" ? "rgba(120,120,128,.16)" : "rgba(120,120,128,.08)",
                            }}
                        >
                            {turn.content}
                        </div>
                    ))}
                    {sending ? <p className="ts-12 text-[var(--c-text)] opacity-50">思考中…</p> : null}
                </div>
                {error ? <p className="ts-12" style={{ color: "#c0392b" }}>{error}</p> : null}
                <textarea
                    value={text}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => {
                        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                            e.preventDefault();
                            void submit();
                        }
                    }}
                    placeholder="说说哪里不对、想怎么改…"
                    aria-label="OOC 内容"
                    className="ui-input w-full min-h-[80px]"
                />
                <div className="flex gap-2">
                    <button type="button" className="ui-btn flex-1" onClick={onClose}>关闭</button>
                    <button type="button" className="ui-btn flex-1" disabled={sending || !text.trim()} onClick={() => void submit()}>
                        {sending ? "发送中…" : "发送"}
                    </button>
                </div>
            </div>
        </div>
    );
}
