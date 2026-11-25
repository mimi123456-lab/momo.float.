"use client";

import type { CSSProperties } from "react";
import type { InspectSnapshot, InspectSnapshotRow } from "@/lib/inspect-storage";

type InspectLiveScreenProps = {
    snapshot: InspectSnapshot;
    characterName: string;
    step: number;
    total: number;
    finished: boolean;
    hasChatHint: boolean;
    onClose: () => void;
    onInterrupt: () => void;
    onGoChat: () => void;
};

function clockNow(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

function ScreenRow({ row }: { row: InspectSnapshotRow }) {
    return (
        <div className={`inspect-phone-row${row.focus ? " is-focus" : ""}${row.changed ? " is-changed" : ""}`}>
            <div className="inspect-phone-avatar">
                {row.avatarUrl ? (
                    <img src={row.avatarUrl} alt="" />
                ) : (
                    <span>{row.avatarText || "?"}</span>
                )}
            </div>
            <div className="inspect-phone-row-main">
                <div className="inspect-phone-row-title">
                    <span className="inspect-phone-row-title-text">{row.title}</span>
                    {row.changed ? <span className="inspect-phone-changed">刚刚改过</span> : null}
                </div>
                {row.subtitle ? <div className="inspect-phone-row-sub">{row.subtitle}</div> : null}
            </div>
            {row.trailing ? <div className="inspect-phone-row-tail">{row.trailing}</div> : null}
            {row.focus ? <div className="inspect-phone-finger" aria-hidden /> : null}
        </div>
    );
}

function ScreenBody({ snapshot }: { snapshot: InspectSnapshot }) {
    if (snapshot.screen === "chat-thread") {
        const messages = snapshot.messages || [];
        return (
            <div className="inspect-phone-thread">
                {messages.length === 0 ? (
                    <div className="inspect-phone-empty">{snapshot.emptyHint || "还没有消息"}</div>
                ) : messages.map((message, index) => (
                    <div key={index} className={`inspect-phone-bubble ${message.from === "user" ? "is-me" : "is-them"}${message.focus ? " is-focus" : ""}`}>
                        {message.text}
                    </div>
                ))}
            </div>
        );
    }

    if (snapshot.screen === "moments") {
        const rows = snapshot.rows || [];
        return (
            <div className="inspect-phone-feed">
                {rows.length === 0 ? (
                    <div className="inspect-phone-empty">{snapshot.emptyHint || "朋友圈还是空的"}</div>
                ) : rows.map(row => (
                    <div key={row.id} className={`inspect-phone-moment${row.focus ? " is-focus" : ""}${row.changed ? " is-changed" : ""}`}>
                        <div className="inspect-phone-moment-head">
                            <div className="inspect-phone-avatar is-small">
                                <span>{row.avatarText || "?"}</span>
                            </div>
                            <span className="inspect-phone-moment-name">{row.title}</span>
                            {row.changed ? <span className="inspect-phone-changed">刚刚发布</span> : null}
                            {row.trailing ? <span className="inspect-phone-moment-time">{row.trailing}</span> : null}
                        </div>
                        <div className="inspect-phone-moment-body">{row.subtitle}</div>
                        {row.focus ? <div className="inspect-phone-finger" aria-hidden /> : null}
                    </div>
                ))}
            </div>
        );
    }

    const rows = snapshot.rows || [];
    return (
        <div className="inspect-phone-list">
            {rows.length === 0 ? (
                <div className="inspect-phone-empty">{snapshot.emptyHint || "这里暂时没有内容"}</div>
            ) : rows.map(row => <ScreenRow key={row.id} row={row} />)}
        </div>
    );
}

export function InspectLiveScreen({
    snapshot,
    characterName,
    step,
    total,
    finished,
    hasChatHint,
    onClose,
    onInterrupt,
    onGoChat,
}: InspectLiveScreenProps) {
    const progress = total > 0 ? Math.min(100, Math.round((step / total) * 100)) : 0;

    return (
        <div className="inspect-live-overlay">
            <style>{`
                .inspect-live-overlay {
                    position: absolute;
                    inset: 0;
                    z-index: 40;
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    gap: 14px;
                    padding: 18px 14px calc(env(safe-area-inset-bottom, 0px) + 18px);
                    background: radial-gradient(120% 90% at 50% 0%, rgba(40, 52, 49, 0.82), rgba(16, 22, 21, 0.94));
                    backdrop-filter: blur(6px);
                }
                .inspect-live-topbar {
                    width: min(92vw, 340px);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    color: rgba(255,255,255,0.9);
                }
                .inspect-live-dot {
                    width: 7px; height: 7px; border-radius: 50%;
                    background: #ff5f57;
                    box-shadow: 0 0 0 0 rgba(255,95,87,0.7);
                    animation: inspect-rec 1.6s infinite;
                }
                @keyframes inspect-rec {
                    0% { box-shadow: 0 0 0 0 rgba(255,95,87,0.55); }
                    70% { box-shadow: 0 0 0 7px rgba(255,95,87,0); }
                    100% { box-shadow: 0 0 0 0 rgba(255,95,87,0); }
                }
                .inspect-live-title {
                    font-size: 12.5px;
                    letter-spacing: 0.4px;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .inspect-live-step {
                    margin-left: auto;
                    font-size: 11px;
                    color: rgba(255,255,255,0.6);
                }
                .inspect-phone-frame {
                    position: relative;
                    width: min(92vw, 340px);
                    height: min(70vh, 600px);
                    border-radius: 42px;
                    padding: 9px;
                    background: linear-gradient(160deg, #3a3f3d, #141716);
                    box-shadow:
                        0 24px 60px rgba(0,0,0,0.5),
                        inset 0 0 0 1.5px rgba(255,255,255,0.08);
                    box-sizing: border-box;
                    overflow: hidden;
                }
                .inspect-phone-notch {
                    position: absolute;
                    top: 9px; left: 50%;
                    transform: translateX(-50%);
                    width: 92px; height: 22px;
                    border-radius: 0 0 14px 14px;
                    background: #0b0d0c;
                    z-index: 3;
                }
                .inspect-phone-screen {
                    position: relative;
                    width: 100%; height: 100%;
                    border-radius: 34px;
                    background: #f7f7f8;
                    overflow: hidden;
                    display: flex;
                    flex-direction: column;
                }
                .inspect-phone-statusbar {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    padding: 10px 20px 4px;
                    font-size: 11px;
                    font-weight: 600;
                    color: #1a1a1a;
                    flex: none;
                }
                .inspect-phone-navbar {
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 6px 16px 10px;
                    border-bottom: 0.5px solid rgba(0,0,0,0.08);
                    flex: none;
                }
                .inspect-phone-back {
                    width: 8px; height: 8px;
                    border-left: 2px solid #2b6cf6;
                    border-bottom: 2px solid #2b6cf6;
                    transform: rotate(45deg);
                }
                .inspect-phone-navtitle {
                    flex: 1;
                    text-align: center;
                    font-size: 14px;
                    font-weight: 600;
                    color: #111;
                }
                .inspect-phone-navsub {
                    font-size: 10.5px;
                    color: #8a8f94;
                }
                .inspect-phone-content {
                    flex: 1;
                    overflow-y: auto;
                    -webkit-overflow-scrolling: touch;
                    padding-bottom: 12px;
                }
                .inspect-phone-list { padding: 4px 0; }
                .inspect-phone-row {
                    position: relative;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    padding: 10px 14px;
                    transition: background 0.25s ease;
                }
                .inspect-phone-row.is-focus {
                    background: rgba(43,108,246,0.09);
                }
                .inspect-phone-row.is-changed {
                    background: rgba(224,106,134,0.12);
                }
                .inspect-phone-avatar {
                    flex: none;
                    width: 38px; height: 38px;
                    border-radius: 9px;
                    background: linear-gradient(150deg, #dfe5ea, #c6cfd6);
                    display: flex; align-items: center; justify-content: center;
                    font-size: 15px; font-weight: 600; color: #55606a;
                    overflow: hidden;
                }
                .inspect-phone-avatar.is-small {
                    width: 30px; height: 30px; border-radius: 50%;
                    font-size: 12px;
                }
                .inspect-phone-avatar img { width: 100%; height: 100%; object-fit: cover; }
                .inspect-phone-row-main { flex: 1; min-width: 0; }
                .inspect-phone-row-title {
                    display: flex; align-items: center; gap: 6px;
                    font-size: 13.5px; font-weight: 600; color: #16181a;
                }
                .inspect-phone-row-title-text {
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }
                .inspect-phone-row-sub {
                    margin-top: 2px;
                    font-size: 11.5px; color: #8b9298;
                    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
                }
                .inspect-phone-row-tail {
                    flex: none; font-size: 10.5px; color: #a2a8ae;
                }
                .inspect-phone-changed {
                    flex: none;
                    font-size: 9.5px; font-weight: 600;
                    padding: 1px 6px; border-radius: 999px;
                    background: rgba(224,106,134,0.16); color: #c8506b;
                }
                .inspect-phone-finger {
                    position: absolute;
                    right: 22px; top: 50%;
                    width: 26px; height: 26px;
                    margin-top: 6px;
                    border-radius: 50%;
                    background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.95), rgba(255,255,255,0.45) 55%, rgba(255,255,255,0.1) 72%);
                    box-shadow: 0 0 0 1px rgba(0,0,0,0.08), 0 4px 10px rgba(0,0,0,0.18);
                    z-index: 4;
                    animation: inspect-tap 1.8s ease-in-out infinite;
                }
                .inspect-phone-finger::after {
                    content: "";
                    position: absolute;
                    inset: 8px;
                    border-radius: 50%;
                    background: rgba(43,108,246,0.5);
                }
                @keyframes inspect-tap {
                    0%, 100% { transform: translateY(0) scale(1); }
                    46% { transform: translateY(0) scale(0.92); }
                    52% { transform: translateY(0) scale(0.82); }
                    60% { transform: translateY(0) scale(1); }
                }
                .inspect-phone-thread {
                    display: flex; flex-direction: column; gap: 8px;
                    padding: 14px 12px;
                }
                .inspect-phone-bubble {
                    max-width: 78%;
                    padding: 8px 11px;
                    border-radius: 14px;
                    font-size: 12.5px;
                    line-height: 1.5;
                    word-break: break-word;
                }
                .inspect-phone-bubble.is-them {
                    align-self: flex-start;
                    background: #fff;
                    color: #1a1c1e;
                    border: 0.5px solid rgba(0,0,0,0.06);
                    border-top-left-radius: 4px;
                }
                .inspect-phone-bubble.is-me {
                    align-self: flex-end;
                    background: #95ec69;
                    color: #10130f;
                    border-top-right-radius: 4px;
                }
                .inspect-phone-bubble.is-focus {
                    box-shadow: 0 0 0 2px rgba(224,106,134,0.4);
                }
                .inspect-phone-feed { padding: 8px 12px; display: flex; flex-direction: column; gap: 12px; }
                .inspect-phone-moment {
                    position: relative;
                    padding: 10px 12px;
                    border-radius: 12px;
                    background: #fff;
                    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
                }
                .inspect-phone-moment.is-focus {
                    box-shadow: 0 0 0 1.5px rgba(224,106,134,0.45);
                }
                .inspect-phone-moment-head {
                    display: flex; align-items: center; gap: 7px;
                }
                .inspect-phone-moment-name { font-size: 12.5px; font-weight: 600; color: #2b6cf6; }
                .inspect-phone-moment-time { margin-left: auto; font-size: 10px; color: #a2a8ae; }
                .inspect-phone-moment-body {
                    margin-top: 7px;
                    font-size: 12.5px; line-height: 1.6; color: #23262a;
                }
                .inspect-phone-empty {
                    padding: 40px 24px;
                    text-align: center;
                    font-size: 12.5px;
                    color: #9aa1a7;
                }
                .inspect-phone-homebar {
                    flex: none;
                    height: 18px;
                    display: flex; align-items: center; justify-content: center;
                }
                .inspect-phone-homebar::after {
                    content: "";
                    width: 110px; height: 4px; border-radius: 2px;
                    background: rgba(0,0,0,0.22);
                }
                .inspect-live-callout {
                    width: min(92vw, 340px);
                    min-height: 22px;
                    text-align: center;
                    font-size: 12px;
                    line-height: 1.5;
                    color: #ffd9e2;
                    white-space: pre-wrap;
                }
                .inspect-live-actions {
                    width: min(92vw, 340px);
                    display: flex;
                    gap: 10px;
                }
                .inspect-live-btn {
                    flex: 1;
                    border: none;
                    border-radius: 13px;
                    padding: 11px 12px;
                    font-size: 12.5px;
                    font-weight: 600;
                    cursor: pointer;
                }
                .inspect-live-btn.danger {
                    background: rgba(255,255,255,0.14);
                    color: #ffb4ad;
                }
                .inspect-live-btn.ghost {
                    background: rgba(255,255,255,0.12);
                    color: rgba(255,255,255,0.85);
                }
                .inspect-live-btn.primary {
                    background: #5f7f76;
                    color: #fff;
                }
                .inspect-live-progress {
                    width: min(92vw, 340px);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    font-size: 10.5px;
                    color: rgba(255,255,255,0.55);
                }
                .inspect-live-progress-bar {
                    flex: 1;
                    height: 3px;
                    border-radius: 2px;
                    background: rgba(255,255,255,0.16);
                    overflow: hidden;
                }
                .inspect-live-progress-fill {
                    height: 100%;
                    background: linear-gradient(90deg, #8fc7b6, #5f7f76);
                    transition: width 0.5s ease;
                }
            `}</style>

            <div className="inspect-live-topbar">
                <span className="inspect-live-dot" />
                <span className="inspect-live-title">
                    {finished ? `${characterName} 看完了，把手机放回原处` : `${characterName} 正在翻你的手机`}
                </span>
                <span className="inspect-live-step">{Math.min(step, total)}/{total}</span>
            </div>

            <div className="inspect-phone-frame">
                <div className="inspect-phone-notch" />
                <div className="inspect-phone-screen">
                    <div className="inspect-phone-statusbar">
                        <span>{clockNow()}</span>
                        <span style={statusIconsStyle}>●●● ▮</span>
                    </div>
                    <div className="inspect-phone-navbar">
                        <span className="inspect-phone-back" />
                        <span className="inspect-phone-navtitle">{snapshot.title}</span>
                        {snapshot.subtitle ? <span className="inspect-phone-navsub">{snapshot.subtitle}</span> : null}
                    </div>
                    <div className="inspect-phone-content">
                        <ScreenBody snapshot={snapshot} />
                    </div>
                    <div className="inspect-phone-homebar" />
                </div>
            </div>

            <div className="inspect-live-callout">
                {snapshot.callout || (finished ? "" : "　")}
            </div>

            <div className="inspect-live-progress">
                <div className="inspect-live-progress-bar">
                    <div className="inspect-live-progress-fill" style={{ width: `${progress}%` }} />
                </div>
                <span>{finished ? "已结束" : `${progress}%`}</span>
            </div>

            <div className="inspect-live-actions">
                {finished ? (
                    <>
                        <button type="button" className="inspect-live-btn ghost" onClick={onClose}>收回手机</button>
                        <button
                            type="button"
                            className="inspect-live-btn primary"
                            onClick={onGoChat}
                            disabled={!hasChatHint}
                        >
                            {hasChatHint ? "TA 在微信里说话" : "TA 没说话"}
                        </button>
                    </>
                ) : (
                    <button type="button" className="inspect-live-btn danger" onClick={onInterrupt}>打断 TA</button>
                )}
            </div>
        </div>
    );
}

const statusIconsStyle: CSSProperties = {
    letterSpacing: 1,
    fontSize: 9,
    color: "#1a1a1a",
};
