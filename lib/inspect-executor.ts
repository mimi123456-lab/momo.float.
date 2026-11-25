// lib/inspect-executor.ts
// 把「查岗意图」落到真实数据上：真的读微信/朋友圈/订单/短信/通话，
// 真的改备注、真的发朋友圈、真的下单。产出的 snapshot 用于实时画面回放。

import {
    loadChatContacts,
    loadChatMessages,
    loadChatSessions,
    saveChatSessions,
    type ChatSession,
} from "@/lib/chat-storage";
import { loadCharacters } from "@/lib/character-storage";
import { addMomentPost, getAllPosts } from "@/lib/moments-storage";
import { loadShoppingState, saveShoppingState } from "@/lib/shopping-storage";
import type { ShoppingCartItem, ShoppingOrder } from "@/lib/shopping-types";
import { loadSmsThreads } from "@/lib/sms-storage";
import { loadPhoneCallLogs } from "@/lib/phone-call-storage";
import { loadCoupleSpace } from "@/lib/couple-space-storage";
import type { InspectPlanAction } from "@/lib/inspect-engine";
import {
    INSPECT_APP_LABELS,
    type InspectLog,
    type InspectSnapshot,
    type InspectSnapshotRow,
} from "@/lib/inspect-storage";

export type ExecutedInspectLog = Omit<InspectLog, "id" | "createdAt">;

function pad(n: number): string {
    return String(n).padStart(2, "0");
}

function clockLabel(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const now = new Date();
    const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    if (date.toDateString() === now.toDateString()) return hm;
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hm}`;
}

function characterNameOf(contactId: string): string {
    return loadCharacters().find(item => item.id === contactId)?.name || "联系人";
}

function sessionDisplayName(session: ChatSession): string {
    if (session.isGroup) return session.groupName?.trim() || "群聊";
    return session.alias?.trim() || characterNameOf(session.contactId);
}

function activeSessions(): ChatSession[] {
    return loadChatSessions()
        .filter(session => !session.isBlacklisted)
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

function avatarTextOf(name: string): string {
    return (name.trim()[0] || "?").toUpperCase();
}

function findSessionByHint(hint?: string, fallbackCharacterId?: string): ChatSession | undefined {
    const sessions = activeSessions();
    const keyword = hint?.trim();
    if (keyword) {
        const hit = sessions.find(session => sessionDisplayName(session).includes(keyword))
            || sessions.find(session => keyword.includes(sessionDisplayName(session)));
        if (hit) return hit;
    }
    if (fallbackCharacterId) {
        const own = sessions.find(session => session.contactId === fallbackCharacterId);
        if (own) return own;
    }
    return sessions[0];
}

// ── 真实画面快照 ──────────────────────────────

function buildChatListSnapshot(focusId?: string, callout?: string): InspectSnapshot {
    const sessions = activeSessions().slice(0, 9);
    const rows: InspectSnapshotRow[] = sessions.map(session => ({
        id: session.id,
        title: sessionDisplayName(session),
        subtitle: session.lastMessagePreview?.slice(0, 26) || "还没有新消息",
        trailing: clockLabel(session.updatedAt),
        focus: session.id === focusId,
        avatarText: avatarTextOf(sessionDisplayName(session)),
    }));
    return {
        screen: "chat-list",
        title: "微信",
        subtitle: sessions.length > 0 ? `${sessions.length} 个会话` : undefined,
        rows,
        fingerRowId: focusId,
        callout,
        emptyHint: "微信里还没有会话",
    };
}

function buildChatThreadSnapshot(sessionId: string, callout?: string): InspectSnapshot {
    const session = loadChatSessions().find(item => item.id === sessionId);
    const messages = loadChatMessages(sessionId)
        .filter(message => message.role === "user" || message.role === "assistant")
        .slice(-8)
        .map(message => ({
            from: message.role === "user" ? "user" as const : "character" as const,
            text: message.content.replace(/\s+/g, " ").slice(0, 90),
        }));
    return {
        screen: "chat-thread",
        title: session ? sessionDisplayName(session) : "聊天",
        subtitle: session?.isGroup ? "群聊" : "微信聊天",
        messages,
        callout,
        emptyHint: "这里还没有聊过",
    };
}

function momentAuthorName(authorType: string, authorId: string, userName: string): string {
    if (authorType === "user") return userName;
    return characterNameOf(authorId);
}

function buildMomentsSnapshot(focusPostId: string | undefined, userName: string, callout?: string): InspectSnapshot {
    const posts = getAllPosts().slice(0, 8);
    const rows: InspectSnapshotRow[] = posts.map(post => ({
        id: post.id,
        title: momentAuthorName(post.authorType, post.authorId, userName),
        subtitle: post.content.replace(/\s+/g, " ").slice(0, 44),
        trailing: clockLabel(post.createdAt),
        focus: post.id === focusPostId,
        changed: post.id === focusPostId,
        avatarText: avatarTextOf(momentAuthorName(post.authorType, post.authorId, userName)),
    }));
    return {
        screen: "moments",
        title: "朋友圈",
        subtitle: "刚刚更新",
        rows,
        fingerRowId: focusPostId,
        callout,
        emptyHint: "朋友圈还是空的",
    };
}

function buildShoppingSnapshot(focusOrderId: string | undefined, callout?: string): InspectSnapshot {
    const orders = loadShoppingState().orders.slice(0, 8);
    const rows: InspectSnapshotRow[] = orders.map(order => ({
        id: order.id,
        title: order.summary || order.merchantLabel,
        subtitle: `${order.merchantLabel} · ${order.statusLabel}`,
        trailing: order.totalLabel,
        focus: order.id === focusOrderId,
        changed: order.id === focusOrderId,
        avatarText: "🛍",
    }));
    return {
        screen: "shopping",
        title: "我的订单",
        subtitle: orders.length > 0 ? `共 ${orders.length} 笔` : undefined,
        rows,
        fingerRowId: focusOrderId,
        callout,
        emptyHint: "还没有订单",
    };
}

function buildSmsSnapshot(focusThreadId: string | undefined, callout?: string): InspectSnapshot {
    const threads = loadSmsThreads().slice(0, 8);
    const rows: InspectSnapshotRow[] = threads.map(thread => {
        const last = thread.messages[thread.messages.length - 1];
        return {
            id: thread.characterId,
            title: thread.characterName,
            subtitle: last?.body?.slice(0, 28) || "还没有短信",
            trailing: clockLabel(thread.updatedAt),
            focus: thread.characterId === focusThreadId,
            avatarText: avatarTextOf(thread.characterName),
        };
    });
    return {
        screen: "sms",
        title: "信息",
        subtitle: threads.length > 0 ? `${threads.length} 个联系人` : undefined,
        rows,
        fingerRowId: focusThreadId,
        callout,
        emptyHint: "还没有短信",
    };
}

function buildCallsSnapshot(callout?: string): InspectSnapshot {
    const logs = loadPhoneCallLogs().slice(0, 8);
    const rows: InspectSnapshotRow[] = logs.map(log => ({
        id: log.id,
        title: log.characterName,
        subtitle: log.type === "missed" ? "未接来电" : log.type === "incoming" ? "来电" : "拨出",
        trailing: clockLabel(log.startedAt),
        avatarText: avatarTextOf(log.characterName),
    }));
    return {
        screen: "calls",
        title: "最近通话",
        rows,
        callout,
        emptyHint: "还没有通话记录",
    };
}

function buildPhotosSnapshot(characterId: string, callout?: string): InspectSnapshot {
    const photos = loadCoupleSpace(characterId)?.photos.slice(0, 8) || [];
    const rows: InspectSnapshotRow[] = photos.map(photo => ({
        id: photo.id,
        title: photo.caption || (photo.kind === "sneaky" ? "偷拍" : "合照"),
        subtitle: photo.uploader === "character" ? "TA 放的" : "你放的",
        trailing: clockLabel(photo.createdAt),
        avatarText: "📷",
    }));
    return {
        screen: "photos",
        title: "相册",
        rows,
        callout,
        emptyHint: "相册里还没有照片",
    };
}

// ── 真实改动 ──────────────────────────────────

function applyRemarkChange(input: {
    hint?: string;
    text?: string;
    characterId: string;
}): { session: ChatSession | undefined; remark: string } {
    const target = findSessionByHint(input.hint, input.characterId);
    const remark = (input.text || "").replace(/[\r\n]/g, " ").trim().slice(0, 16) || "小猪";
    if (!target) return { session: undefined, remark };
    const sessions = loadChatSessions().map(session => (
        session.id === target.id
            ? { ...session, alias: remark }
            : session
    ));
    saveChatSessions(sessions);
    return { session: { ...target, alias: remark }, remark };
}

function applyMomentPost(input: {
    text?: string;
    characterId: string;
    characterName: string;
}): { postId?: string; content: string } {
    const content = (input.text || "").replace(/\s+/g, " ").trim().slice(0, 120) || "今天有点想你。";
    const visibility = loadChatContacts().map(contact => contact.characterId);
    const post = addMomentPost({
        authorType: "character",
        authorId: input.characterId,
        content,
        visibility,
    });
    return { postId: post?.id, content };
}

function priceFor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 9973;
    return `¥${(hash % 260) + 19}`;
}

function applyOrder(input: {
    hint?: string;
    characterId: string;
    characterName: string;
}): { orderId?: string; title: string; totalLabel: string } {
    const state = loadShoppingState();
    const keyword = (input.hint || "").trim();
    const pool = [...state.catalog.recommendations, ...state.savedItems, ...state.cartItems];
    const picked = keyword
        ? pool.find(item => item.title.includes(keyword) || keyword.includes(item.title.slice(0, 2)))
        : undefined;
    const base = picked || pool[0];
    const title = base?.title || keyword || "随手买的小东西";
    const item: ShoppingCartItem = {
        id: base?.id || `inspect_item_${Date.now()}`,
        title,
        merchantLabel: base?.merchantLabel || "TA 顺手挑的店",
        priceLabel: base?.priceLabel || priceFor(title),
        tagLabel: "订单",
        subtitle: base?.subtitle || "查岗时顺手下的单",
        detail: base?.detail || "TA 用你的账号下的单",
        previewIcon: base?.previewIcon || "🎁",
        tone: base?.tone || "blush",
        quantityLabel: "x 1",
    };
    const now = new Date();
    const timeLabel = `${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const order: ShoppingOrder = {
        id: `inspect_order_${Date.now()}`,
        statusLabel: "待发货",
        timeLabel,
        totalLabel: item.priceLabel,
        merchantLabel: item.merchantLabel,
        summary: `${item.title} × 1`,
        note: `${input.characterName} 用你的账号下的单`,
        items: [item],
        shippingTimeline: [{
            status: "ordered",
            label: "已下单，等待商家发货",
            timeLabel,
            timestamp: now.toISOString(),
        }],
        paidAt: now.toISOString(),
        paymentStatus: "paid_by_character",
        payerCharacterId: input.characterId,
        payerCharacterName: input.characterName,
        characterPaidAt: now.toISOString(),
    };
    saveShoppingState({ ...state, orders: [order, ...state.orders].slice(0, 80) });
    return { orderId: order.id, title, totalLabel: item.priceLabel };
}

// ── 主入口 ────────────────────────────────────

export function executeInspectAction(input: {
    action: InspectPlanAction;
    characterId: string;
    characterName: string;
    userName?: string;
}): ExecutedInspectLog {
    const { action, characterId, characterName } = input;
    const userName = input.userName?.trim() || "你";
    const appLabel = INSPECT_APP_LABELS[action.appId];
    const base = {
        characterId,
        characterName,
        appId: action.appId,
        appLabel,
        kind: action.kind,
        emotion: action.emotion || "curious",
    } as const;

    // 改备注：真的改会话备注，画面停在会话列表那一行。找不到会话就不假装改过。
    if (action.appId === "chat" && (action.action === "change-remark" || (action.kind === "change" && action.text))) {
        const { session, remark } = applyRemarkChange({
            hint: action.target,
            text: action.text,
            characterId,
        });
        if (session) {
            const snapshot = buildChatListSnapshot(session.id, `备注 → “${remark}”`);
            return {
                ...base,
                kind: "change",
                action: "change-remark",
                targetId: session.id,
                summary: action.summary || `我把${sessionDisplayName(session)}的备注改成了“${remark}”`,
                detail: action.detail,
                snapshot,
            };
        }
    }

    // 发朋友圈：真的写进朋友圈。
    if (action.appId === "moments" && (action.action === "post-moment" || action.kind === "change")) {
        const { postId, content } = applyMomentPost({ text: action.text, characterId, characterName });
        const snapshot = buildMomentsSnapshot(postId, userName, "刚刚发布");
        return {
            ...base,
            kind: "change",
            action: "post-moment",
            targetId: postId,
            summary: action.summary || `我发了条朋友圈：“${content.slice(0, 24)}”`,
            detail: action.detail,
            snapshot,
        };
    }

    // 下单：真的写进购物订单。
    if (action.appId === "shopping" && (action.action === "place-order" || action.kind === "change")) {
        const { orderId, title, totalLabel } = applyOrder({
            hint: action.target || action.text,
            characterId,
            characterName,
        });
        const snapshot = buildShoppingSnapshot(orderId, `已下单 · ${totalLabel}`);
        return {
            ...base,
            kind: "change",
            action: "place-order",
            targetId: orderId,
            summary: action.summary || `我用你的账号下了单：${title}`,
            detail: action.detail,
            snapshot,
        };
    }

    // 以下是查看：全部读真实数据。
    if (action.appId === "chat") {
        const wantsThread = action.action === "open-chat" || Boolean(action.target);
        if (wantsThread) {
            const session = findSessionByHint(action.target, characterId);
            if (session) {
                return {
                    ...base,
                    action: "open-chat",
                    targetId: session.id,
                    summary: action.summary || `我点开了你和${sessionDisplayName(session)}的聊天`,
                    detail: action.detail,
                    snapshot: buildChatThreadSnapshot(session.id),
                };
            }
        }
        const session = findSessionByHint(undefined, characterId);
        return {
            ...base,
            action: "view",
            targetId: session?.id,
            summary: action.summary || "我翻了翻你的微信会话",
            detail: action.detail,
            snapshot: buildChatListSnapshot(session?.id),
        };
    }

    if (action.appId === "moments") {
        return {
            ...base,
            action: "view",
            summary: action.summary || "我翻了翻你的朋友圈",
            detail: action.detail,
            snapshot: buildMomentsSnapshot(undefined, userName),
        };
    }

    if (action.appId === "shopping") {
        return {
            ...base,
            action: "view",
            summary: action.summary || "我翻了你的购物订单",
            detail: action.detail,
            snapshot: buildShoppingSnapshot(undefined),
        };
    }

    if (action.appId === "sms") {
        const thread = loadSmsThreads().find(item => action.target && item.characterName.includes(action.target));
        return {
            ...base,
            action: "view",
            targetId: thread?.characterId,
            summary: action.summary || "我翻了你的短信",
            detail: action.detail,
            snapshot: buildSmsSnapshot(thread?.characterId),
        };
    }

    if (action.appId === "phone") {
        return {
            ...base,
            action: "view",
            summary: action.summary || "我看了你的通话记录",
            detail: action.detail,
            snapshot: buildCallsSnapshot(),
        };
    }

    if (action.appId === "photos") {
        return {
            ...base,
            action: "view",
            summary: action.summary || "我翻了你的相册",
            detail: action.detail,
            snapshot: buildPhotosSnapshot(characterId),
        };
    }

    // 其余 App：给一张空白页，保证画面真实（不是编的进度条）。
    return {
        ...base,
        action: "view",
        summary: action.summary || `我翻了翻你的${appLabel}`,
        detail: action.detail,
        snapshot: {
            screen: "home",
            title: appLabel,
            emptyHint: "这里暂时没有可以翻的内容",
        },
    };
}
