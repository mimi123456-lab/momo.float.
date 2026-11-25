import { kvGet, kvSet } from "@/lib/kv-db";

export type CouplePhoto = {
    id: string;
    uploader: "user" | "character";
    url: string;
    caption?: string;
    kind: "shared" | "sneaky";
    createdAt: string;
};

export type LoveLetter = {
    id: string;
    author: "user" | "character";
    body: string;
    createdAt: string;
};

export type CoupleWish = {
    id: string;
    author: "user" | "character";
    body: string;
    mood: "正经" | "不正经";
    done: boolean;
    createdAt: string;
};

export type CoupleSpaceState = {
    characterId: string;
    characterName: string;
    pairedAt: string;
    photos: CouplePhoto[];
    letters: LoveLetter[];
    wishes: CoupleWish[];
    remarks: { userToCharacter: string; characterToUser: string };
};

export type CoupleInvite = {
    characterId: string;
    characterName: string;
    createdAt: string;
    expiresAt: string;
    status: "pending" | "accepted" | "declined";
};

const SPACE_KEY = "ai_phone_couple_space_v1";
const INVITE_KEY = "ai_phone_couple_invites_v1";
export const COUPLE_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

function readMap<T>(): Record<string, T> {
    try {
        const parsed = JSON.parse(kvGet(SPACE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

export function loadCoupleSpace(characterId: string): CoupleSpaceState | null {
    return readMap<CoupleSpaceState>()[characterId] || null;
}

export function saveCoupleSpace(state: CoupleSpaceState): void {
    const map = readMap<CoupleSpaceState>();
    map[state.characterId] = state;
    kvSet(SPACE_KEY, JSON.stringify(map));
}

export function createCoupleSpace(characterId: string, characterName: string): CoupleSpaceState {
    const state: CoupleSpaceState = {
        characterId,
        characterName,
        pairedAt: new Date().toISOString(),
        photos: [],
        letters: [],
        wishes: [],
        remarks: { userToCharacter: "", characterToUser: "" },
    };
    saveCoupleSpace(state);
    return state;
}

export function updateCoupleSpace(characterId: string, patch: Partial<CoupleSpaceState>): CoupleSpaceState | null {
    const current = loadCoupleSpace(characterId);
    if (!current) return null;
    const next = { ...current, ...patch };
    saveCoupleSpace(next);
    return next;
}

export function addCouplePhoto(characterId: string, photo: Omit<CouplePhoto, "id" | "createdAt">): CouplePhoto | null {
    const current = loadCoupleSpace(characterId);
    if (!current) return null;
    const item: CouplePhoto = {
        ...photo,
        id: `photo_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        createdAt: new Date().toISOString(),
    };
    saveCoupleSpace({ ...current, photos: [item, ...current.photos] });
    return item;
}

export function removeCouplePhoto(characterId: string, photoId: string): void {
    const current = loadCoupleSpace(characterId);
    if (!current) return;
    saveCoupleSpace({ ...current, photos: current.photos.filter(item => item.id !== photoId) });
}

export function addLoveLetter(characterId: string, author: "user" | "character", body: string): LoveLetter | null {
    const current = loadCoupleSpace(characterId);
    if (!current || !body.trim()) return null;
    const item: LoveLetter = {
        id: `letter_${Date.now()}`,
        author,
        body: body.trim(),
        createdAt: new Date().toISOString(),
    };
    saveCoupleSpace({ ...current, letters: [item, ...current.letters] });
    return item;
}

export function addCoupleWish(characterId: string, wish: Omit<CoupleWish, "id" | "createdAt" | "done">): CoupleWish | null {
    const current = loadCoupleSpace(characterId);
    if (!current || !wish.body.trim()) return null;
    const item: CoupleWish = {
        ...wish,
        body: wish.body.trim(),
        id: `wish_${Date.now()}`,
        done: false,
        createdAt: new Date().toISOString(),
    };
    saveCoupleSpace({ ...current, wishes: [item, ...current.wishes] });
    return item;
}

export function toggleCoupleWish(characterId: string, wishId: string): void {
    const current = loadCoupleSpace(characterId);
    if (!current) return;
    saveCoupleSpace({
        ...current,
        wishes: current.wishes.map(item => item.id === wishId ? { ...item, done: !item.done } : item),
    });
}

export function removeCoupleWish(characterId: string, wishId: string): void {
    const current = loadCoupleSpace(characterId);
    if (!current) return;
    saveCoupleSpace({ ...current, wishes: current.wishes.filter(item => item.id !== wishId) });
}

export function saveCoupleRemarks(characterId: string, remarks: { userToCharacter: string; characterToUser: string }): void {
    const current = loadCoupleSpace(characterId);
    if (!current) return;
    saveCoupleSpace({ ...current, remarks });
}

// ── 邀请（角色主动发起，24 小时有效，可多次申请）────────────────

function readInvites(): Record<string, CoupleInvite> {
    try {
        const parsed = JSON.parse(kvGet(INVITE_KEY) || "{}");
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function writeInvites(map: Record<string, CoupleInvite>): void {
    kvSet(INVITE_KEY, JSON.stringify(map));
}

export function loadCoupleInvite(characterId: string): CoupleInvite | null {
    const invite = readInvites()[characterId];
    if (!invite) return null;
    if (invite.status === "pending" && Date.parse(invite.expiresAt) <= Date.now()) {
        return { ...invite, status: "declined" };
    }
    return invite;
}

export function createCoupleInvite(characterId: string, characterName: string): CoupleInvite {
    const now = new Date();
    const invite: CoupleInvite = {
        characterId,
        characterName,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + COUPLE_INVITE_TTL_MS).toISOString(),
        status: "pending",
    };
    const map = readInvites();
    map[characterId] = invite;
    writeInvites(map);
    return invite;
}

export function resolveCoupleInvite(characterId: string, status: "accepted" | "declined"): CoupleInvite | null {
    const map = readInvites();
    const invite = map[characterId];
    if (!invite) return null;
    map[characterId] = { ...invite, status };
    writeInvites(map);
    return map[characterId];
}

export function isCouplePaired(characterId: string): boolean {
    return Boolean(loadCoupleSpace(characterId));
}

/** 在一起天数（按自然日计算）。 */
export function coupleDaysTogether(pairedAt: string): number {
    const start = new Date(pairedAt).setHours(0, 0, 0, 0);
    const now = new Date().setHours(0, 0, 0, 0);
    return Math.max(1, Math.floor((now - start) / 86400000) + 1);
}
