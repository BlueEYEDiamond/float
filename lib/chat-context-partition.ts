import type { ChatMessage, ChatSession } from "./chat-storage";
import type { ChatContextPreparePayload } from "./chat-plugin-types";
import { getChatPluginHookBus, runChatPluginTransform } from "./chat-plugin-hooks";
import { filterTimelineByAllowedSources, loadNativeTimeline } from "./short-term-assembler";
import { loadMemoryConfig } from "./memory-storage";

/** 输入带时间的原始历史，输出已确认缓存的分区；失败阻止本轮发送。 */
export async function prepareChatContextPartition(
    session: ChatSession, history: ChatMessage[], characterIds: string[],
    offline: boolean, excludeOfflineSessionId?: string,
): Promise<ChatContextPreparePayload["partition"]> {
    if (typeof window === "undefined" || !getChatPluginHookBus().hasHandlers("context.prepare")) return;
    const records = new Map<string, ChatContextPreparePayload["records"][number]>();
    const config = loadMemoryConfig();
    for (const characterId of characterIds) {
        const timeline = filterTimelineByAllowedSources(loadNativeTimeline(characterId, {
            excludeOfflineSessionId, timeAware: true,
        }), config.shortTermAllowedSources);
        for (const entry of timeline) {
            if (entry.sourceApp !== "chat" && entry.sourceDetail !== "chat_offline") continue;
            const id = `timeline:${entry.sessionId || entry.groupSessionId || ""}:${entry.id}`;
            records.set(id, { id, timestamp: entry.timestamp, content: entry.content });
        }
    }
    for (const message of history) {
        if (message.isRetracted) continue;
        const id = `history:${session.id}:${message.id}`;
        records.set(id, {
            id, timestamp: message.createdAt,
            content: `${message.senderName || message.role}: ${message.content}`,
        });
    }
    const payload: ChatContextPreparePayload = {
        sessionId: session.id, mode: offline ? "offline" : "online", now: Date.now(),
        records: [...records.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id)),
        query: history.slice(-4).map(message => message.content).join("\n"),
    };
    const result = await runChatPluginTransform("context.prepare", payload);
    const partition = result.partition;
    if (!partition) return;
    if (partition.state !== "ready" || !Number.isFinite(partition.cutoff) || partition.cutoff > payload.now) {
        throw new Error(partition.error || "记忆缓存尚未准备完成，本轮未发送。请稍后重试或在插件设置中停用分区。");
    }
    return partition;
}

/** 工具调用跨越边界时阻止发送，避免发出缺少调用方的工具结果。 */
export function partitionChatHistory(history: ChatMessage[], cutoff?: number): ChatMessage[] {
    if (cutoff === undefined) return history;
    if (history.some(message => !Number.isFinite(Date.parse(message.createdAt)))) {
        throw new Error("存在无法识别时间的聊天记录，请修复记录时间后重试。");
    }
    const recent = history.filter(message => Date.parse(message.createdAt) >= cutoff);
    const calls = new Set(recent.flatMap(message => message.nativeToolCalls?.map(call => call.id) || []));
    if (recent.some(message => message.nativeToolResult && !calls.has(message.nativeToolResult.toolCallId))) {
        throw new Error("时间窗口切断了工具调用，请调大原文保留时长后重试。");
    }
    return recent;
}
