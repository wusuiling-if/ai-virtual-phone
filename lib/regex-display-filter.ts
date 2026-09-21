import type { BindingConfig, BindingSlot, RegexRule } from "./settings-types";

export function isPotentiallyUnsafeDisplayPattern(source: string): boolean {
    if (/\([^)]*[+*][^)]*\)[+*{]/.test(source)) return true;
    for (const match of source.matchAll(/\\+[1-9]/g)) {
        if (match[0].length % 2 === 0) return true; // odd number of slashes before the digit
    }
    return false;
}

/** Build display-only rules; literal mode never interprets a user's words as regex. */
function compileDisplayFilterPattern(input: string, mode: "words" | "regex"): RegExp {
    let pattern: RegExp;
    if (mode === "words") {
        const words = [...new Set(input.split(/\r?\n/).map(word => word.trim()).filter(Boolean))];
        if (!words.length) throw new Error("请先填写要隐藏的字词，每行一个。");
        // Prefer the longest phrase when one entry is a prefix of another.
        words.sort((a, b) => b.length - a.length);
        pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    } else {
        const source = input.trim();
        if (!source) throw new Error("请先填写正则表达式。");
        if (source.length > 300) throw new Error("正则表达式过长，请控制在 300 字符以内。");
        const wrapped = source.match(/^\/([\s\S]*)\/([a-z]*)$/i);
        const body = wrapped ? wrapped[1] : source;
        // Nested quantifiers and backreferences are the common route to catastrophic backtracking.
        if (isPotentiallyUnsafeDisplayPattern(body)) {
            throw new Error("此表达式可能让聊天页面卡住，请避免嵌套重复或反向引用。");
        }
        try {
            pattern = wrapped ? new RegExp(body, wrapped[2]) : new RegExp(body, "g");
        } catch {
            throw new Error("正则表达式无效，请检查括号、转义和 flags。");
        }
    }
    return pattern;
}

export function previewDisplayFilter(input: string, mode: "words" | "regex", sample: string): string {
    return sample.replace(compileDisplayFilterPattern(input, mode), "");
}

export function createDisplayFilterRules(input: string, mode: "words" | "regex", id: string): RegexRule[] {
    const pattern = compileDisplayFilterPattern(input, mode);
    const scopes = [
        { name: "单聊", tags: ["chat", "text"] },
        { name: "群聊", tags: ["group_chat", "text"] },
        { name: "单聊线下", tags: ["chat", "offline"] },
        { name: "群聊线下", tags: ["group_chat", "offline"] },
    ];
    return scopes.map((scope, index) => ({
        id: `${id}-${index}`,
        scriptName: `隐藏 AI 正文（${scope.name}）`,
        findRegex: pattern.toString(),
        replaceString: "",
        disabled: false,
        placement: [2],
        tags: scope.tags,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
    }));
}

/** Add to existing overrides as well, so an explicit character binding doesn't mask the filter. */
export function bindDisplayFilterToAllChats(config: BindingConfig, groupId: string): BindingConfig {
    const append = (slot: BindingSlot): BindingSlot => ({
        ...slot, regexIds: [...new Set([...(slot.regexIds || []), groupId])],
    });
    const override = (slot: BindingSlot): BindingSlot => slot.regexIds?.length ? append(slot) : slot;
    const overrides = (slots: Partial<Record<string, BindingSlot>>) => Object.fromEntries(
        Object.entries(slots).map(([app, slot]) => [app, slot ? override(slot) : slot]),
    );
    return {
        ...config,
        globalDefaults: append(config.globalDefaults),
        appDefaults: config.appDefaults ? overrides(config.appDefaults) : undefined,
        characterBindings: config.characterBindings.map(binding => ({
            ...binding,
            defaults: override(binding.defaults),
            appOverrides: overrides(binding.appOverrides),
        })),
    };
}
