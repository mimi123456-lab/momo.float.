import { kvGet, kvSet } from "@/lib/kv-db";

/** App 级自定义 CSS：每个 App 独立一份，注入时用 [data-app-css="<id>"] 作用域限定。 */
export type AppCssTargetId = "music" | "phone" | "sms" | "theater" | "couplespace" | "inspect";

export type AppCssTarget = { id: AppCssTargetId; label: string; desc: string };

export const APP_CSS_TARGETS: AppCssTarget[] = [
    { id: "music", label: "音乐播放器", desc: "播放页、歌词、一起听邀请卡" },
    { id: "phone", label: "电话", desc: "最近通话、拨号键盘、通话页" },
    { id: "sms", label: "短信", desc: "会话列表、气泡、输入栏" },
    { id: "theater", label: "小剧场", desc: "番外剧场界面" },
    { id: "couplespace", label: "情侣空间", desc: "相册、情书、愿望板" },
    { id: "inspect", label: "查岗", desc: "查岗记录与权限页" },
];

export const APP_CSS_UPDATED_EVENT = "app-custom-css-updated";

function appCssKey(id: AppCssTargetId): string {
    return `app-custom-css:${id}`;
}

export function loadAppCustomCSS(id: AppCssTargetId): string {
    return kvGet(appCssKey(id)) || "";
}

export function saveAppCustomCSS(id: AppCssTargetId, css: string): void {
    kvSet(appCssKey(id), css || "");
    if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(APP_CSS_UPDATED_EVENT, { detail: { appId: id } }));
    }
}
