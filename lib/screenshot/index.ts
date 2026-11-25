/**
 * 截屏桥的最简实现（移植自 doremy.float.phone 的 lib/screenshot）。
 *
 * 目标仓库没有原生截屏桥所需的 device-compatibility / shell-call-overlay 依赖，
 * 这里只保留「一起看」用到的最小能力：探测桥是否可用 + 发起一次截屏。
 * 非安卓壳环境（普通浏览器）下安全降级：hasScreenshotBridge() 返回 false，
 * captureScreenshot() 直接 resolve 失败原因，调用方据此隐藏入口即可。
 */

export type ScreenshotCaptureResult =
  | {
      ok: true;
      width: number;
      height: number;
      bytes: number;
      /** PNG base64（不含 data: 前缀） */
      base64: string;
    }
  | { ok: false; reason: string };

type ScreenshotBridgeLike = {
  captureScreenshot?: () => string;
};

/** 安卓壳通过 window 上的 'shell-call-overlay' CustomEvent 把截屏推回来。 */
const SHELL_OVERLAY_EVENT = "shell-call-overlay";

function bridge(): ScreenshotBridgeLike | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as unknown as { AndroidShell?: ScreenshotBridgeLike }).AndroidShell;
  return candidate && typeof candidate === "object" ? candidate : null;
}

/** 壳是否提供截屏桥（普通浏览器 / 老 APK 都没有）。 */
export function hasScreenshotBridge(): boolean {
  return typeof bridge()?.captureScreenshot === "function";
}

/**
 * 截一张当前屏幕。**永远 resolve，不 reject**：
 * 成功给 { ok:true, base64, width, height, bytes }，失败给 { ok:false, reason }。
 */
export function captureScreenshot(timeoutMs = 8000): Promise<ScreenshotCaptureResult> {
  return new Promise<ScreenshotCaptureResult>((resolve) => {
    const b = bridge();
    if (!b?.captureScreenshot) {
      resolve({ ok: false, reason: "当前 App 版本不支持截屏，需要更新安卓壳" });
      return;
    }

    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener(SHELL_OVERLAY_EVENT, onOverlayEvent as EventListener);
    };
    const finish = (result: ScreenshotCaptureResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    function onOverlayEvent(event: Event) {
      const detail = (event as CustomEvent<{ action?: string; ok?: boolean; reason?: string; base64?: string; width?: number; height?: number; bytes?: number }>).detail;
      if (!detail || detail.action !== "screenshot") return;
      if (detail.ok === false) {
        finish({ ok: false, reason: detail.reason || "截屏失败" });
        return;
      }
      if (typeof detail.base64 === "string" && detail.base64) {
        finish({
          ok: true,
          base64: detail.base64,
          width: typeof detail.width === "number" ? detail.width : 0,
          height: typeof detail.height === "number" ? detail.height : 0,
          bytes: typeof detail.bytes === "number" ? detail.bytes : 0,
        });
      }
    }

    // 先订阅、再发起：原生回调可能很快，反过来会漏事件。
    window.addEventListener(SHELL_OVERLAY_EVENT, onOverlayEvent as EventListener);
    timer = setTimeout(() => {
      finish({ ok: false, reason: "截屏超时了，请确认无障碍服务还开着，然后重试" });
    }, Math.max(1000, timeoutMs));

    let ack: { ok: true } | { ok: false; reason: string };
    try {
      const raw = b.captureScreenshot();
      if (typeof raw !== "string" || !raw) {
        ack = { ok: false, reason: "截屏调用没有返回结果" };
      } else {
        const parsed = JSON.parse(raw) as { ok?: boolean; reason?: string };
        ack = parsed?.ok === true ? { ok: true } : { ok: false, reason: parsed?.reason || "截屏未能发起" };
      }
    } catch {
      ack = { ok: false, reason: "截屏调用失败" };
    }
    if (!ack.ok) finish({ ok: false, reason: ack.reason });
  });
}
