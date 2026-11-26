// lib/use-weixin-bridge.ts
// React hook：管理所有 WeChat Bot 的轮询生命周期 + 后台保活。

import { useEffect, useRef, useState, useCallback } from "react";
import { loadWeixinBots, loadKeepAlive, type WeixinBotConfig } from "./weixin-storage";
import { runBotLoop } from "./weixin-bridge";

export type BotRunStatus = {
    status: "running" | "stopped" | "error";
    message?: string;
};

// ⏸ 临时总开关：暂停微信 Bot 的 getupdates 长轮询，止血 Netlify compute
//（长轮询会全程占用函数时长）。仅停轮询，不影响后台保活（保活是通用功能）。
// 恢复功能：改回 false 重新部署。长期方案=用户电脑本地助手接管轮询。
const WEIXIN_BRIDGE_PAUSED: boolean = true;

// 模块级状态：让设置页面也能读到
const _statusMap = new Map<string, BotRunStatus>();

export function getWeixinBotStatus(id: string): BotRunStatus {
    return _statusMap.get(id) ?? { status: "stopped" };
}

function broadcastStatus() {
    window.dispatchEvent(new CustomEvent("weixin-status-changed"));
}

// ── 保活：Wake Lock + 静音音频 ───────────────────────────────
// 设计目标：只要用户没关开关，就一直挂在后台；掉了能自己回来。
// 因此这里是一个模块级常驻服务（不随组件卸载停止），配合
// 1) 12s 看门狗：音频被系统掐了就重新拉起来；Wake Lock 掉了就重申请
// 2) 全局恢复钩子：回到前台 / 页面恢复 / 任意点击都尝试恢复
export const KEEP_ALIVE_STATUS_EVENT = "keep-alive-status-changed";

export type KeepAliveRuntimeStatus = {
    wanted: boolean;
    audioPlaying: boolean;
    wakeLockHeld: boolean;
    waitingGesture: boolean;
};

let _wakeLock: WakeLockSentinel | null = null;
let _keepAliveAudio: HTMLAudioElement | null = null;
let _watchdog: number | null = null;
let _wakeLockPending = false;
let _globalHooksInstalled = false;

let _keepAliveWanted = false; // 标记：想要保活但还没获得用户手势
let _suspendedForCall = false; // 标记：因语音/视频通话临时暂停了保活
let _runtimeStatus: KeepAliveRuntimeStatus = {
    wanted: false,
    audioPlaying: false,
    wakeLockHeld: false,
    waitingGesture: false,
};

export function getKeepAliveStatus(): KeepAliveRuntimeStatus {
    return { ..._runtimeStatus };
}

function emitKeepAliveStatus() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(KEEP_ALIVE_STATUS_EVENT, { detail: getKeepAliveStatus() }));
}

function updateRuntimeStatus(patch: Partial<KeepAliveRuntimeStatus>) {
    _runtimeStatus = { ..._runtimeStatus, ...patch };
    emitKeepAliveStatus();
}

function ensureAudioCreated() {
    if (_keepAliveAudio) return;
    _keepAliveAudio = new Audio();
    // 生成 1 秒静音 WAV。采样率必须是 48kHz：iOS 的系统音频会话采样率跟着正在
    // 播放的媒体走，之前用 8kHz 会把整个会话拖到 8kHz，随后播放的 TTS 语音被压到
    // 4kHz 以下，听感发闷。48kHz 是手机硬件的原生采样率。单声道即可，双声道下
    // 交错写入的 ±1 会退化成左右声道各自的直流，反而失去"有能量"的意义。
    const sampleRate = 48000;
    const samples = sampleRate;
    const buf = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples * 2, true);
    // ±1 LSB 微噪声（约 -90dB，不可闻）：纯零波形会被 Chrome 判为"无声页面"，
    // 安卓后台 5 分钟后定时器被强节流（轮询延迟拉到分钟级）；有能量的音频
    // 可获得 "playing audio" 豁免。
    for (let i = 0; i < samples; i++) {
        view.setInt16(44 + i * 2, i % 2 === 0 ? 1 : -1, true);
    }
    const blob = new Blob([buf], { type: "audio/wav" });
    _keepAliveAudio.src = URL.createObjectURL(blob);
    _keepAliveAudio.loop = true;
    _keepAliveAudio.volume = 0.01;
    _keepAliveAudio.preload = "auto";

    _keepAliveAudio.addEventListener("playing", () => {
        updateRuntimeStatus({ audioPlaying: true, waitingGesture: false });
    });
    _keepAliveAudio.addEventListener("pause", () => {
        updateRuntimeStatus({ audioPlaying: false });
        // 系统把我们掐停时，自己排一次重试（通话暂停期间不抢音频）
        if (_keepAliveWanted && !_suspendedForCall) {
            window.setTimeout(() => tryPlayKeepAliveAudio("after-pause"), 800);
        }
    });
    _keepAliveAudio.addEventListener("ended", () => {
        if (_keepAliveWanted && !_suspendedForCall) tryPlayKeepAliveAudio("after-ended");
    });
    _keepAliveAudio.addEventListener("error", () => {
        // 资源被系统回收：重建音频对象再拉起来
        _keepAliveAudio = null;
        if (_keepAliveWanted && !_suspendedForCall) {
            window.setTimeout(() => {
                ensureAudioCreated();
                tryPlayKeepAliveAudio("after-error");
            }, 1200);
        }
    });
}

function tryPlayKeepAliveAudio(reason: string) {
    if (!_keepAliveWanted || _suspendedForCall) return;
    ensureAudioCreated();
    const audio = _keepAliveAudio;
    if (!audio) return;
    if (!audio.paused) return;
    let playResult: Promise<void> | undefined;
    try {
        playResult = audio.play();
    } catch {
        playResult = undefined;
    }
    if (!playResult) {
        updateRuntimeStatus({ waitingGesture: false });
        return;
    }
    playResult.then(() => {
        updateRuntimeStatus({ audioPlaying: true, waitingGesture: false });
    }).catch(() => {
        // 没有用户手势时浏览器会拒绝自动播放：标记为"等待一次点击"
        updateRuntimeStatus({ audioPlaying: false, waitingGesture: true });
        if (reason === "watchdog") return;
    });
}

async function acquireWakeLock() {
    if (!_keepAliveWanted || _suspendedForCall) return;
    if (!("wakeLock" in navigator)) return;
    if (_wakeLock || _wakeLockPending) return;
    // 页面不可见时申请会被拒，等回到前台再申请
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    _wakeLockPending = true;
    try {
        const sentinel = await navigator.wakeLock.request("screen");
        _wakeLock = sentinel;
        updateRuntimeStatus({ wakeLockHeld: true });
        sentinel.addEventListener("release", () => {
            _wakeLock = null;
            updateRuntimeStatus({ wakeLockHeld: false });
            // 切后台/锁屏会让系统释放 Wake Lock，回前台后自动补回来
            if (_keepAliveWanted && !_suspendedForCall) {
                window.setTimeout(() => { void acquireWakeLock(); }, 1500);
            }
        });
    } catch {
        // 忽略：看门狗会继续尝试
    } finally {
        _wakeLockPending = false;
    }
}

function ensureWatchdog() {
    if (_watchdog !== null) return;
    _watchdog = window.setInterval(() => {
        if (!_keepAliveWanted || _suspendedForCall) return;
        if (_keepAliveAudio && _keepAliveAudio.paused) {
            tryPlayKeepAliveAudio("watchdog");
        }
        if (!_wakeLock) {
            void acquireWakeLock();
        }
    }, 12000);
}

function stopWatchdog() {
    if (_watchdog === null) return;
    window.clearInterval(_watchdog);
    _watchdog = null;
}

/** 全局恢复钩子：装一次就够，任何"回到可见/重新获得焦点/用户触碰"都尝试恢复。 */
function installGlobalResumeHooks() {
    if (_globalHooksInstalled) return;
    _globalHooksInstalled = true;

    const resume = () => {
        if (!_keepAliveWanted) return;
        tryPlayKeepAliveAudio("resume");
        void acquireWakeLock();
    };

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") resume();
    });
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    // 任何一次点击/触摸都可以解锁浏览器的自动播放限制
    document.addEventListener("pointerdown", resume, { capture: true, passive: true });
    document.addEventListener("touchstart", resume, { capture: true, passive: true });
    document.addEventListener("keydown", resume, { capture: true });
}

function startKeepAlive() {
    _keepAliveWanted = true;
    _suspendedForCall = false;
    updateRuntimeStatus({ wanted: true });
    ensureAudioCreated();
    installGlobalResumeHooks();
    ensureWatchdog();
    tryPlayKeepAliveAudio("start");
    void acquireWakeLock();
}

function stopKeepAlive() {
    _keepAliveWanted = false;
    _suspendedForCall = false;
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    stopWatchdog();
    if (_keepAliveAudio) {
        try {
            _keepAliveAudio.pause();
            _keepAliveAudio.currentTime = 0;
        } catch {}
    }
    updateRuntimeStatus({
        wanted: false,
        audioPlaying: false,
        wakeLockHeld: false,
        waitingGesture: false,
    });
}

/**
 * Pause keep-alive for the duration of a voice/video call. Starting STT grabs
 * the mic and the OS audio focus, which would otherwise interrupt the looping
 * silent audio and leave it dead after the call. The call holds the mic + audio
 * session itself, so keep-alive is redundant meanwhile. No-op if keep-alive is off.
 */
export function suspendKeepAliveForCall() {
    if (!_keepAliveWanted) return;
    _suspendedForCall = true;
    _wakeLock?.release().catch(() => {});
    _wakeLock = null;
    updateRuntimeStatus({ wakeLockHeld: false });
    if (_keepAliveAudio) {
        try { _keepAliveAudio.pause(); } catch {}
    }
}

/** Re-arm keep-alive after a call ends, unless the user turned it off meanwhile. */
export function resumeKeepAliveAfterCall() {
    if (!_suspendedForCall) return;
    _suspendedForCall = false;
    if (!_keepAliveWanted) return; // keep-alive was switched off during the call
    void acquireWakeLock();
    tryPlayKeepAliveAudio("after-call");
}

export function useWeixinBridge() {
    const [bots, setBots] = useState<WeixinBotConfig[]>([]);
    const abortMap = useRef(new Map<string, AbortController>());

    // 初始加载 + 监听配置变更
    useEffect(() => {
        setBots(loadWeixinBots());
        const handler = () => setBots(loadWeixinBots());
        window.addEventListener("weixin-config-changed", handler);
        return () => window.removeEventListener("weixin-config-changed", handler);
    }, []);

    // 启动 bot（可复用：首次 + 回前台恢复）
    const startBot = useCallback((bot: WeixinBotConfig) => {
        if (WEIXIN_BRIDGE_PAUSED) {
            _statusMap.set(bot.id, { status: "stopped", message: "已暂停（为节省额度临时关闭，稍后恢复）" });
            broadcastStatus();
            return;
        }
        if (abortMap.current.has(bot.id)) return;

        const ctrl = new AbortController();
        abortMap.current.set(bot.id, ctrl);

        _statusMap.set(bot.id, { status: "running" });
        broadcastStatus();

        runBotLoop(
            bot,
            ctrl.signal,
            (status, message) => {
                _statusMap.set(bot.id, { status, message });
                broadcastStatus();
            },
        ).finally(() => {
            abortMap.current.delete(bot.id);
            if (!_statusMap.get(bot.id)?.message) {
                _statusMap.set(bot.id, { status: "stopped" });
                broadcastStatus();
            }
        });
    }, []);

    // 同步轮询 loop
    useEffect(() => {
        const activeBots = bots.filter(b => b.enabled && b.botToken.trim());

        for (const bot of activeBots) startBot(bot);

        // 停止已禁用或已删除的 bot
        for (const [id, ctrl] of abortMap.current) {
            if (!activeBots.find(b => b.id === id)) {
                ctrl.abort();
                _statusMap.set(id, { status: "stopped" });
            }
        }
        broadcastStatus();
    }, [bots, startBot]);

    // 保活管理：只要用户开启保活就启动，不依赖 Bot 是否启用。
    useEffect(() => {
        const shouldKeepAlive = loadKeepAlive();
        if (shouldKeepAlive) {
            startKeepAlive();
        } else {
            stopKeepAlive();
        }

        // 监听保活设置变更
        const onCfg = () => {
            const on = loadKeepAlive();
            if (on) startKeepAlive(); else stopKeepAlive();
        };
        window.addEventListener("weixin-config-changed", onCfg);
        return () => {
            window.removeEventListener("weixin-config-changed", onCfg);
            // 注意：这里不能 stopKeepAlive。保活是模块级常驻服务，
            // 设置页开关/组件重挂载都不应该把它掐断；只有用户主动关开关才停。
        };
    }, []);

    // 回到前台：恢复被挂起的轮询 + 重新获取 Wake Lock
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState !== "visible") return;

            // 重启所有已停止（非错误）的 bot
            const activeBots = loadWeixinBots().filter(b => b.enabled && b.botToken.trim());
            for (const bot of activeBots) {
                if (!abortMap.current.has(bot.id)) {
                    startBot(bot);
                }
            }

            // Wake Lock 在 visibilitychange 时会自动释放，需重新获取
            if (loadKeepAlive()) {
                startKeepAlive();
            }
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, [startBot]);

    // 卸载时全部停止
    useEffect(() => {
        return () => {
            for (const ctrl of abortMap.current.values()) ctrl.abort();
        };
    }, []);
}
