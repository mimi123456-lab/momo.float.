import { updateChatMessage, type ChatMessage } from "./chat-storage";
import { generateVideoFromConfiguredApi } from "./video-generation-service";

function errorToMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function dispatchChatMessagesUpdated(sessionId: string, message: ChatMessage): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("chat-messages-updated", {
        detail: { sessionId, message },
    }));
}

export function createPendingChatGeneratedVideoData(
    mediaData: ChatMessage["mediaData"] | undefined,
    description?: string,
): ChatMessage["mediaData"] {
    const label = (description || mediaData?.label || "").trim();
    return {
        ...mediaData,
        label,
        fileType: "video",
        videoKind: mediaData?.videoKind === "loop" ? "loop" : "clip",
        videoGenerationStatus: "pending",
        videoGenerationError: undefined,
    };
}

export function isPendingChatGeneratedVideoMessage(message: Pick<ChatMessage, "mediaType" | "mediaData">): boolean {
    return message.mediaType === "media_file"
        && message.mediaData?.fileType === "video"
        && message.mediaData?.videoGenerationStatus === "pending";
}

export function isGeneratedVideoMessage(message: Pick<ChatMessage, "mediaType" | "mediaData">): boolean {
    return message.mediaType === "media_file"
        && message.mediaData?.fileType === "video"
        && message.mediaData?.videoGenerationStatus !== undefined;
}

function generatedVideoFilename(description: string): string {
    const cleaned = description.replace(/[\\/:*?"<>|\n\r]+/g, " ").trim().slice(0, 24) || "视频";
    return `${cleaned}.mp4`;
}

/** 生成成功后把 [动图:描述|台词] 的台词合成配音并挂到消息上；失败不影响视频。 */
async function attachVideoVoiceLine(
    updated: ChatMessage,
    characterId?: string,
): Promise<ChatMessage> {
    const voiceLine = (updated.mediaData?.videoVoiceLine || "").trim();
    if (!voiceLine || !characterId || updated.mediaData?.videoVoiceMediaRef) return updated;
    try {
        const [{ resolveVoiceConfig, synthesizeSpeech }, { storeMediaBlob }] = await Promise.all([
            import("./tts-service"),
            import("./media-cache-storage"),
        ]);
        const voiceConfig = resolveVoiceConfig(characterId, "chat");
        if (!voiceConfig) return updated;
        const blob = await synthesizeSpeech(voiceLine, voiceConfig);
        if (!blob) return updated;
        const ref = await storeMediaBlob(blob, blob.type || "audio/mpeg", "audio");
        const withVoice = updateChatMessage(updated.id, {
            mediaData: {
                ...updated.mediaData,
                videoVoiceMediaRef: ref,
                videoVoiceText: voiceLine,
            },
        });
        if (!withVoice) return updated;
        dispatchChatMessagesUpdated(withVoice.sessionId, withVoice);
        return withVoice;
    } catch {
        return updated;
    }
}

export async function generateAndApplyChatGeneratedVideo(
    message: ChatMessage,
    characterId?: string,
    options?: { signal?: AbortSignal; description?: string; durationSeconds?: number; motionReferenceRef?: string },
): Promise<ChatMessage> {
    const previousDescription = message.mediaData?.label?.trim() || "";
    const description = (options?.description ?? previousDescription).trim();
    if (!description) throw new Error("缺少视频描述，无法生成");

    if (message.mediaData?.videoGenerationStatus !== "pending") {
        const marked = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                videoGenerationStatus: "pending",
                videoGenerationError: undefined,
            },
        });
        if (marked) dispatchChatMessagesUpdated(marked.sessionId, marked);
    }

    try {
        const generated = await generateVideoFromConfiguredApi({
            description,
            characterId,
            appId: "chat",
            durationSeconds: options?.durationSeconds,
            motionReferenceRef: options?.motionReferenceRef,
            signal: options?.signal,
        });
        const fileName = generatedVideoFilename(description);
        const previousData = message.mediaData ?? {};
        const updated = updateChatMessage(message.id, {
            content: fileName,
            mediaType: "media_file",
            mediaUrl: generated.mediaRef,
            mediaData: {
                ...previousData,
                label: description,
                fileType: "video",
                fileName,
                videoGenerationMediaRef: generated.mediaRef,
                videoGenerationPrompt: generated.prompt,
                videoGenerationStatus: "generated",
                videoGenerationError: undefined,
                videoGenerationNote: generated.motionReferenceSkipped
                    ? "动作参考未生效（参考视频需公网链接或体积超限）"
                    : undefined,
                videoDurationSeconds: generated.durationSeconds,
            },
        });
        if (!updated) throw new Error("原消息不存在，无法替换视频");
        dispatchChatMessagesUpdated(updated.sessionId, updated);
        return await attachVideoVoiceLine(updated, characterId);
    } catch (error) {
        const failed = updateChatMessage(message.id, {
            mediaData: {
                ...message.mediaData,
                label: description,
                fileType: "video",
                videoGenerationStatus: "failed",
                videoGenerationError: errorToMessage(error),
            },
        });
        if (failed) {
            dispatchChatMessagesUpdated(failed.sessionId, failed);
            return failed;
        }
        throw error;
    }
}

export async function retryChatGeneratedVideo(
    message: ChatMessage,
    characterId?: string,
    nextDescription?: string,
): Promise<ChatMessage> {
    return generateAndApplyChatGeneratedVideo(message, characterId, {
        description: nextDescription,
    });
}
