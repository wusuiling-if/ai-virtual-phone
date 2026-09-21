import type { ChatMessage, ChatSession } from "./chat-storage";
import { sendLLMRequest } from "./chat-engine";
import { loadCharacters } from "./character-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity } from "./settings-storage";
import { stripStateAndInnerForPrompt } from "./prompt-sanitizer";

const CHOICE_COUNT = 4;

export function parseChatReplyChoices(raw: string): string[] {
    const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    let values: unknown;
    try {
        const parsed: unknown = JSON.parse(cleaned);
        values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && "replies" in parsed
            ? (parsed as { replies: unknown }).replies : null;
    } catch {
        values = cleaned.split(/\n+/).map(line => line.replace(/^\s*(?:[-*]|[1-4][.、)]|[A-D][.、)])\s*/i, "").trim());
    }
    if (!Array.isArray(values)) return [];
    const choices = values.filter((value): value is string => typeof value === "string")
        .map(value => value.trim().replace(/^['"“”]+|['"“”]+$/g, "").trim())
        .filter(value => value.length > 0 && value.length <= 300);
    if (choices.length !== CHOICE_COUNT || new Set(choices).size !== CHOICE_COUNT) return [];
    return choices;
}

export async function generateChatReplyChoices(
    session: ChatSession,
    history: ChatMessage[],
    signal?: AbortSignal,
): Promise<string[]> {
    const binding = resolveBinding(loadBindingConfig(), session.isGroup ? undefined : session.contactId, session.isGroup ? "group_chat" : "chat");
    const config = loadApiConfigs().find(item => item.id === binding.apiConfigId);
    if (!config) throw new Error("请先在设置中为当前聊天绑定 API 配置");

    const identity = resolveUserIdentity(session.isGroup ? undefined : session.contactId, session.isGroup ? "group_chat" : "chat");
    const userName = identity?.name || "我";
    const characterNames = new Map(loadCharacters().map(character => [character.id, character.name]));
    const recent = history.filter(message => message.role === "user" || message.role === "assistant")
        .slice(-14).map(message => {
            const speaker = message.role === "user" ? userName : (message.senderName || characterNames.get(message.senderCharacterId || session.contactId) || "对方");
            return `${speaker}：${stripStateAndInnerForPrompt(message.content.slice(0, 600)).slice(0, 450)}`;
        }).filter(line => !line.endsWith("："));
    if (!recent.length) throw new Error("先聊几句，再生成回复选项");

    const raw = await sendLLMRequest(config, null, [
        { role: "system", content: `你是聊天回复助手。请站在“${userName}”的角度，针对下面的对话生成恰好四条不同的、可以直接发送的回复。四条应有不同语气或推进方向，贴合上下文，简短自然。只输出包含四个字符串的 JSON 数组，不要解释，不要代替其他人说话，也不要输出角色扮演标记。${identity?.customSettings ? `\n${userName}的说话风格：${identity.customSettings.slice(0, 300)}` : ""}` },
        { role: "user", content: `对话记录：\n${recent.join("\n")}\n\n请给出${userName}接下来可说的四句话。` },
    ], [], { userName }, { skipOutputRegex: true, debugSessionId: session.id, signal });

    const choices = parseChatReplyChoices(raw);
    if (choices.length !== CHOICE_COUNT) throw new Error("没有生成四条有效回复，请点击换一组重试");
    return choices;
}
