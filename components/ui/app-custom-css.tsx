"use client";

import { useEffect, useState } from "react";
import { SessionCustomCSS } from "@/components/ui/session-custom-css";
import { APP_CSS_UPDATED_EVENT, loadAppCustomCSS, type AppCssTargetId } from "@/lib/app-custom-css";

/**
 * 注入某个 App 的自定义 CSS。宿主容器需要带 data-app-css="<appId>"，
 * CSS 会被作用域限定在该容器内，不影响手机其它界面。
 */
export function AppCustomCSS({ appId }: { appId: AppCssTargetId }) {
    const [css, setCss] = useState(() => (typeof window === "undefined" ? "" : loadAppCustomCSS(appId)));

    useEffect(() => {
        const sync = () => setCss(loadAppCustomCSS(appId));
        sync();
        // kv 存储异步水合，首次读取可能落空，补几次重读。
        const timers = [400, 1500, 3500].map(ms => window.setTimeout(sync, ms));
        window.addEventListener(APP_CSS_UPDATED_EVENT, sync);
        return () => {
            timers.forEach(t => window.clearTimeout(t));
            window.removeEventListener(APP_CSS_UPDATED_EVENT, sync);
        };
    }, [appId]);

    if (!css.trim()) return null;
    return <SessionCustomCSS css={css} scope={`[data-app-css="${appId}"]`} />;
}
