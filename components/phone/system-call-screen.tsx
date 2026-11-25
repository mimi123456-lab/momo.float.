"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Volume2, VolumeX } from "lucide-react";
import type { Character } from "@/lib/character-types";
import type { ChatMessage, ChatSession } from "@/lib/chat-storage";
import { generateChatCompletion, flattenCompletionResult } from "@/lib/chat-engine";
import { parseAIResponse } from "@/lib/rich-message-parser";
import { resolveVoiceConfig, synthesizeSpeech, playAudioBlobViaMediaElement } from "@/lib/tts-service";
import { createSTTSession, type STTSession } from "@/lib/stt-service";

type SystemCallEndPayload = {
    durationSec: number;
    transcript: Array<{ role: "user" | "assistant"; text: string }>;
};

function formatClock(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function SystemCallScreen({
    character,
    session,
    direction,
    onEnd,
}: {
    character: Character;
    session: ChatSession;
    direction: "outgoing" | "incoming";
    onEnd: (payload: SystemCallEndPayload) => void;
}) {
    const [phase, setPhase] = useState<"ringing" | "connected" | "thinking" | "speaking">("ringing");
    const [seconds, setSeconds] = useState(0);
    const [subtitles, setSubtitles] = useState<Array<{ id: string; role: "user" | "assistant"; text: string }>>([]);
    const [draft, setDraft] = useState("");
    const [muted, setMuted] = useState(false);
    const [speaker, setSpeaker] = useState(false);
    const [listening, setListening] = useState(false);
    const [interim, setInterim] = useState("");
    const [errorText, setErrorText] = useState("");

    const messagesRef = useRef<ChatMessage[]>([]);
    const transcriptRef = useRef<Array<{ role: "user" | "assistant"; text: string }>>([]);
    const seqRef = useRef(0);
    const sttRef = useRef<STTSession | null>(null);
    const audioAbortRef = useRef<(() => void) | null>(null);
    const phaseRef = useRef(phase);
    const mutedRef = useRef(muted);
    const endedRef = useRef(false);
    const secondsRef = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);
    const greetedRef = useRef(false);

    useEffect(() => { phaseRef.current = phase; }, [phase]);
    useEffect(() => { mutedRef.current = muted; }, [muted]);
    useEffect(() => { secondsRef.current = seconds; }, [seconds]);

    const appendLocal = useCallback((role: "user" | "assistant", text: string) => {
        const message: ChatMessage = {
            id: `sysphone_${Date.now()}_${seqRef.current++}`,
            sessionId: session.id,
            role,
            content: text,
            status: "sent",
            createdAt: new Date().toISOString(),
        };
        messagesRef.current = [...messagesRef.current, message];
        if (text.trim()) transcriptRef.current.push({ role, text });
        return message;
    }, [session.id]);

    const stopAudio = useCallback(() => {
        if (audioAbortRef.current) {
            audioAbortRef.current();
            audioAbortRef.current = null;
        }
        if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    }, []);

    const stopListening = useCallback(() => {
        if (sttRef.current) {
            sttRef.current.abort();
            sttRef.current = null;
        }
        setListening(false);
        setInterim("");
    }, []);

    const speak = useCallback(async (text: string) => {
        const voiceConfig = resolveVoiceConfig(session.contactId);
        if (!voiceConfig || mutedRef.current || endedRef.current || !text.trim()) return;
        setPhase("speaking");
        try {
            const blob = await synthesizeSpeech(text, voiceConfig);
            if (!blob || endedRef.current || mutedRef.current) {
                if (!endedRef.current) setPhase("connected");
                return;
            }
            const { promise, abort } = playAudioBlobViaMediaElement(blob);
            audioAbortRef.current = abort;
            await promise;
            audioAbortRef.current = null;
        } catch (error) {
            console.warn("[SystemCall] TTS failed:", error);
        } finally {
            if (!endedRef.current) setPhase("connected");
        }
    }, [session.contactId]);

    const runTurn = useCallback(async (userText?: string) => {
        if (endedRef.current) return;
        if (userText) {
            appendLocal("user", userText);
            setSubtitles(prev => [...prev, { id: `u-${Date.now()}`, role: "user", text: userText }]);
        }
        setPhase("thinking");
        setErrorText("");
        try {
            const result = await generateChatCompletion(session, messagesRef.current, { appTags: ["chat", "voice"] });
            if (endedRef.current) return;
            const raw = flattenCompletionResult(result);
            const parsed = parseAIResponse(raw, []);
            const text = parsed.parts
                .filter(part => !part.mediaType && part.content.trim())
                .map(part => part.content.trim())
                .join("\n")
                .trim() || raw.trim();
            if (!text) {
                setPhase("connected");
                return;
            }
            appendLocal("assistant", text);
            setSubtitles(prev => [...prev, { id: `a-${Date.now()}`, role: "assistant", text }]);
            await speak(text);
        } catch (error) {
            console.error("[SystemCall] error:", error);
            setErrorText(error instanceof Error ? error.message : "通话内容生成失败");
            setPhase("connected");
        }
    }, [appendLocal, session, speak]);

    // 接通：来电直接通话，拨出响铃 2 秒
    useEffect(() => {
        const delay = direction === "incoming" ? 300 : 2000;
        const timer = window.setTimeout(() => {
            if (endedRef.current) return;
            setPhase("connected");
            if (!greetedRef.current) {
                greetedRef.current = true;
                void runTurn(direction === "incoming" ? "（我接起了你的电话）" : "（电话接通了）");
            }
        }, delay);
        return () => window.clearTimeout(timer);
    }, [direction, runTurn]);

    useEffect(() => {
        if (phase === "ringing") return;
        const timer = window.setInterval(() => setSeconds(prev => prev + 1), 1000);
        return () => window.clearInterval(timer);
    }, [phase]);

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [subtitles.length, interim]);

    useEffect(() => () => {
        endedRef.current = true;
        stopAudio();
        if (sttRef.current) sttRef.current.abort();
    }, [stopAudio]);

    const hangup = useCallback(() => {
        if (endedRef.current) return;
        endedRef.current = true;
        stopAudio();
        stopListening();
        onEnd({ durationSec: secondsRef.current, transcript: transcriptRef.current });
    }, [onEnd, stopAudio, stopListening]);

    const toggleListen = useCallback(() => {
        if (listening) {
            stopListening();
            return;
        }
        if (endedRef.current) return;
        setListening(true);
        setInterim("");
        const stt = createSTTSession({
            onInterim: text => setInterim(text),
            onFinal: text => {
                sttRef.current = null;
                setListening(false);
                setInterim("");
                if (text.trim()) void runTurn(text.trim());
            },
            onError: () => {
                sttRef.current = null;
                setListening(false);
                setInterim("");
                setErrorText("语音识别不可用，试试直接打字");
            },
            onNoSpeech: () => {
                sttRef.current = null;
                setListening(false);
                setInterim("");
            },
            onEnd: () => {
                sttRef.current = null;
                setListening(false);
            },
        }, "zh-CN");
        sttRef.current = stt;
    }, [listening, runTurn, stopListening]);

    const sendText = () => {
        const text = draft.trim();
        if (!text) return;
        setDraft("");
        stopAudio();
        void runTurn(text);
    };

    const statusLabel = phase === "ringing"
        ? (direction === "incoming" ? "来电" : "正在呼叫…")
        : phase === "speaking"
            ? `通话中 ${formatClock(seconds)} · TA 正在说`
            : formatClock(seconds);

    return (
        <div
            style={{
                position: "absolute", inset: 0, zIndex: 120, display: "flex", flexDirection: "column",
                background: "linear-gradient(180deg,#2b2b30 0%,#141416 55%,#0b0b0d 100%)",
                color: "#fff", overflow: "hidden",
            }}
        >
            <div style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 26px)", textAlign: "center" }}>
                <div style={{ fontSize: 12, letterSpacing: 1.6, opacity: 0.55 }}>系统电话</div>
                <div style={{ marginTop: 22, fontSize: 26, fontWeight: 500, letterSpacing: 0.5 }}>{character.name}</div>
                <div style={{ marginTop: 6, fontSize: 13, opacity: 0.6 }}>{statusLabel}</div>
            </div>

            <div
                ref={scrollRef}
                style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 26px", display: "flex", flexDirection: "column", gap: 10 }}
            >
                {subtitles.slice(-8).map(item => (
                    <div key={item.id} style={{ textAlign: item.role === "user" ? "right" : "left" }}>
                        <span style={{
                            display: "inline-block", maxWidth: "86%", padding: "7px 12px", borderRadius: 14,
                            fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word",
                            background: item.role === "user" ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.07)",
                        }}>{item.text}</span>
                    </div>
                ))}
                {interim && <div style={{ textAlign: "right", fontSize: 13, opacity: 0.55 }}>{interim}</div>}
                {phase === "thinking" && <div style={{ fontSize: 13, opacity: 0.5 }}>{character.name} 正在回应…</div>}
                {errorText && <div style={{ fontSize: 12, color: "#ff9f9f" }}>{errorText}</div>}
            </div>

            <div style={{ padding: "0 18px calc(env(safe-area-inset-bottom, 0px) + 14px)" }}>
                <div style={{ display: "flex", justifyContent: "center", gap: 28, marginBottom: 18 }}>
                    <CallToggle active={muted} label={muted ? "已静音" : "静音"} onClick={() => { setMuted(v => !v); if (!muted) stopAudio(); }}>
                        {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
                    </CallToggle>
                    <CallToggle active={speaker} label="免提" onClick={() => setSpeaker(v => !v)}>
                        <span style={{ fontSize: 15, fontWeight: 600 }}>免提</span>
                    </CallToggle>
                    <CallToggle active={listening} label={listening ? "正在听…" : "说话"} onClick={toggleListen}>
                        {listening ? <Mic size={22} /> : <MicOff size={22} />}
                    </CallToggle>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 18 }}>
                    <input
                        value={draft}
                        onChange={event => setDraft(event.target.value)}
                        onKeyDown={event => { if (event.key === "Enter") sendText(); }}
                        placeholder="直接打字也可以…"
                        style={{ flex: 1, height: 38, borderRadius: 19, border: "none", padding: "0 14px", fontSize: 14, background: "rgba(255,255,255,0.14)", color: "#fff", outline: "none" }}
                    />
                    <button type="button" onClick={sendText} style={{ height: 38, padding: "0 14px", borderRadius: 19, border: "none", background: "rgba(255,255,255,0.22)", color: "#fff", fontSize: 14 }}>发送</button>
                </div>

                <button
                    type="button"
                    onClick={hangup}
                    style={{ width: 64, height: 64, borderRadius: 32, border: "none", background: "#ff3b30", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto" }}
                    aria-label="挂断"
                >
                    <PhoneOff size={26} />
                </button>
            </div>
        </div>
    );
}

function CallToggle({ active, label, onClick, children }: { active: boolean; label: string; onClick: () => void; children: React.ReactNode }) {
    return (
        <button type="button" onClick={onClick} style={{ background: "none", border: "none", color: "#fff", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, cursor: "pointer", opacity: active ? 1 : 0.75 }}>
            <span style={{ width: 52, height: 52, borderRadius: 26, display: "flex", alignItems: "center", justifyContent: "center", background: active ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.14)" }}>{children}</span>
            <span style={{ fontSize: 11 }}>{label}</span>
        </button>
    );
}
