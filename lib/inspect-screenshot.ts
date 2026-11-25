// lib/inspect-screenshot.ts
// 把查岗时看到的真实画面画成一张手机截图，供角色在微信里发给用户。

import type { InspectSnapshot } from "@/lib/inspect-storage";

const FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif';

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
    const value = text.replace(/\s+/g, " ").trim();
    if (ctx.measureText(value).width <= maxWidth) return value;
    let result = value;
    while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) {
        result = result.slice(0, -1);
    }
    return `${result}…`;
}

function clockNow(): string {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function renderInspectScreenshot(snapshot: InspectSnapshot): string | null {
    if (typeof document === "undefined") return null;
    const width = 360;
    const height = 640;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.scale(scale, scale);

    // 屏幕底色
    ctx.fillStyle = "#f7f7f8";
    ctx.fillRect(0, 0, width, height);

    // 状态栏
    ctx.fillStyle = "#1a1a1a";
    ctx.font = `600 11px ${FONT}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(clockNow(), 20, 22);
    ctx.textAlign = "right";
    ctx.fillText("●●● ▮", width - 20, 22);

    // 导航栏
    ctx.textAlign = "center";
    ctx.font = `600 14px ${FONT}`;
    ctx.fillText(fitText(ctx, snapshot.title, 220), width / 2, 54);
    if (snapshot.subtitle) {
        ctx.font = `400 9.5px ${FONT}`;
        ctx.fillStyle = "#8a8f94";
        ctx.fillText(snapshot.subtitle, width / 2, 70);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(16, 84);
    ctx.lineTo(width - 16, 84);
    ctx.stroke();

    // 内容
    if (snapshot.screen === "chat-thread") {
        const messages = (snapshot.messages || []).slice(-9);
        let y = 104;
        ctx.textBaseline = "middle";
        for (const message of messages) {
            const isMe = message.from === "user";
            ctx.font = `400 12px ${FONT}`;
            const maxWidth = 246;
            const text = fitText(ctx, message.text, maxWidth);
            const textWidth = Math.min(maxWidth, ctx.measureText(text).width);
            const boxWidth = textWidth + 22;
            const boxHeight = 34;
            const x = isMe ? width - 16 - boxWidth : 16;
            ctx.fillStyle = isMe ? "#95ec69" : "#ffffff";
            roundRect(ctx, x, y, boxWidth, boxHeight, 12);
            ctx.fill();
            if (!isMe) {
                ctx.strokeStyle = "rgba(0,0,0,0.06)";
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
            ctx.fillStyle = "#17191b";
            ctx.textAlign = "left";
            ctx.fillText(text, x + 11, y + boxHeight / 2 + 0.5);
            y += boxHeight + 10;
            if (y > height - 80) break;
        }
        if (messages.length === 0) {
            drawEmpty(ctx, width, height, snapshot.emptyHint || "这里还没有聊过");
        }
    } else if (snapshot.screen === "moments") {
        let y = 100;
        for (const row of (snapshot.rows || []).slice(0, 5)) {
            ctx.fillStyle = "#ffffff";
            roundRect(ctx, 16, y, width - 32, 82, 12);
            ctx.fill();
            if (row.focus) {
                ctx.strokeStyle = "rgba(224,106,134,0.55)";
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }
            // 头像
            ctx.fillStyle = "#e3e8ec";
            roundRect(ctx, 28, y + 14, 28, 28, 14);
            ctx.fill();
            ctx.fillStyle = "#5c666e";
            ctx.font = `600 12px ${FONT}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(row.avatarText || "?", 42, y + 28);
            // 名字
            ctx.textAlign = "left";
            ctx.fillStyle = "#2b6cf6";
            ctx.font = `600 12px ${FONT}`;
            ctx.fillText(fitText(ctx, row.title, 150), 66, y + 24);
            if (row.trailing) {
                ctx.textAlign = "right";
                ctx.fillStyle = "#a2a8ae";
                ctx.font = `400 9.5px ${FONT}`;
                ctx.fillText(row.trailing, width - 28, y + 24);
            }
            // 正文
            ctx.textAlign = "left";
            ctx.fillStyle = "#23262a";
            ctx.font = `400 11.5px ${FONT}`;
            ctx.fillText(fitText(ctx, row.subtitle || "", width - 90), 66, y + 46);
            y += 92;
            if (y > height - 80) break;
        }
        if ((snapshot.rows || []).length === 0) {
            drawEmpty(ctx, width, height, snapshot.emptyHint || "朋友圈还是空的");
        }
    } else {
        const rows = (snapshot.rows || []).slice(0, 9);
        let y = 96;
        if (rows.length === 0) {
            drawEmpty(ctx, width, height, snapshot.emptyHint || "这里暂时没有内容");
        }
        for (const row of rows) {
            if (row.focus || row.changed) {
                ctx.fillStyle = row.changed ? "rgba(224,106,134,0.10)" : "rgba(43,108,246,0.08)";
                ctx.fillRect(0, y, width, 58);
            }
            // 头像
            ctx.fillStyle = "#dfe5ea";
            roundRect(ctx, 16, y + 10, 38, 38, 9);
            ctx.fill();
            ctx.fillStyle = "#55606a";
            ctx.font = `600 14px ${FONT}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(row.avatarText || "?", 35, y + 29);
            // 标题
            ctx.textAlign = "left";
            ctx.fillStyle = "#16181a";
            ctx.font = `600 13px ${FONT}`;
            ctx.fillText(fitText(ctx, row.title, 190), 64, y + 23);
            // 副标题
            ctx.fillStyle = "#8b9298";
            ctx.font = `400 11px ${FONT}`;
            ctx.fillText(fitText(ctx, row.subtitle || "", 200), 64, y + 40);
            // 尾部
            if (row.trailing) {
                ctx.textAlign = "right";
                ctx.fillStyle = "#a2a8ae";
                ctx.font = `400 10px ${FONT}`;
                ctx.fillText(row.trailing, width - 16, y + 29);
            }
            ctx.strokeStyle = "rgba(0,0,0,0.06)";
            ctx.lineWidth = 0.5;
            ctx.beginPath();
            ctx.moveTo(64, y + 58);
            ctx.lineTo(width, y + 58);
            ctx.stroke();
            y += 58;
            if (y > height - 70) break;
        }
    }

    // 指尖提示
    if (snapshot.callout) {
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `600 11px ${FONT}`;
        const text = snapshot.callout;
        const boxWidth = Math.min(width - 60, ctx.measureText(text).width + 30);
        const boxX = (width - boxWidth) / 2;
        const boxY = height - 78;
        ctx.fillStyle = "rgba(30,38,36,0.88)";
        roundRect(ctx, boxX, boxY, boxWidth, 28, 14);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(fitText(ctx, text, boxWidth - 22), width / 2, boxY + 14);
    }

    // 底部横条
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    roundRect(ctx, width / 2 - 55, height - 18, 110, 4, 2);
    ctx.fill();

    // 右下角“截图时间”水印
    ctx.textAlign = "right";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = "rgba(0,0,0,0.28)";
    ctx.font = `400 8.5px ${FONT}`;
    ctx.fillText(`截于 ${clockNow()}`, width - 16, height - 26);

    return canvas.toDataURL("image/jpeg", 0.86);
}

function drawEmpty(ctx: CanvasRenderingContext2D, width: number, height: number, hint: string): void {
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#9aa1a7";
    ctx.font = `400 12px ${FONT}`;
    ctx.fillText(hint, width / 2, height / 2);
}
