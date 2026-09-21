"use client";

import { useEffect, useState } from "react";
import { BottomSheet } from "@/components/ui/modal";
import { createDisplayFilterRules } from "@/lib/regex-display-filter";
import type { RegexRule } from "@/lib/settings-types";

export function DisplayFilterCreator({ onClose, onCreate }: {
    onClose: () => void;
    onCreate: (name: string, rules: RegexRule[]) => void;
}) {
    const [mode, setMode] = useState<"words" | "regex">("words");
    const [input, setInput] = useState("");
    const [name, setName] = useState("AI 正文隐藏");
    const [sample, setSample] = useState("");
    const [result, setResult] = useState({ output: "", error: "", pending: false });
    useEffect(() => {
        if (!input.trim()) { setResult({ output: sample, error: "", pending: false }); return; }
        setResult(current => ({ ...current, pending: true, error: "" }));
        let worker: Worker | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const debounce = setTimeout(() => {
            if (typeof Worker === "undefined") {
                setResult({ output: sample, error: "当前浏览器无法安全预览正则。", pending: false });
                return;
            }
            try {
                worker = new Worker(new URL("./display-filter-preview.worker.ts", import.meta.url));
            } catch {
                setResult({ output: sample, error: "无法启动安全预览，请检查浏览器设置。", pending: false });
                return;
            }
            worker.onmessage = (event: MessageEvent<{ output: string; error: string }>) => {
                if (deadline) clearTimeout(deadline);
                setResult({ ...event.data, pending: false });
                worker?.terminate();
            };
            worker.onerror = () => {
                if (deadline) clearTimeout(deadline);
                setResult({ output: sample, error: "预览运行失败，请检查表达式。", pending: false });
                worker?.terminate();
            };
            worker.postMessage({ input, mode, sample: sample.slice(0, 10_000) });
            deadline = setTimeout(() => {
                worker?.terminate();
                setResult({ output: sample, error: "表达式执行过慢，已停止预览；请简化后再保存。", pending: false });
            }, 2000);
        }, 150);
        return () => { clearTimeout(debounce); if (deadline) clearTimeout(deadline); worker?.terminate(); };
    }, [input, mode, sample]);

    return (
        <BottomSheet title="隐藏 AI 回复字词" onClose={onClose}>
            <div className="flex flex-col gap-3">
                <p className="menu-desc !mt-0">对所有角色的单聊、群聊和线下正文生效。只隐藏显示，原消息和发送给 AI 的上下文不变；关闭规则即可恢复显示。</p>
                <label className="flex flex-col gap-1 menu-desc">
                    规则组名称
                    <input className="ui-input" value={name} onChange={e => setName(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 menu-desc">
                    匹配方式
                    <select className="ui-input" value={mode} onChange={e => { setMode(e.target.value as typeof mode); setInput(""); }}>
                        <option value="words">普通字词（每行一个）</option>
                        <option value="regex">正则表达式（高级）</option>
                    </select>
                </label>
                <label className="flex flex-col gap-1 menu-desc">
                    {mode === "words" ? "要隐藏的字词" : "匹配表达式"}
                    <textarea className="ui-textarea" rows={3} value={input} onChange={e => setInput(e.target.value)}
                        placeholder={mode === "words" ? "例如：\n某个词\n不想看到的句子" : "例如：/某个词|另一个词/g"} />
                </label>
                <p className="menu-desc !mt-0">{mode === "words" ? "按原样匹配所有出现位置，英文区分大小写，标点不需要转义。" : "匹配内容会被隐藏；支持 /表达式/flags，不写斜杠时默认全局匹配 g。"}</p>
                {input.trim() && result.error && <p role="alert" className="text-red-600 ts-13">{result.error}</p>}
                <label className="flex flex-col gap-1 menu-desc">
                    预览原文
                    <textarea className="ui-textarea" rows={3} value={sample} onChange={e => setSample(e.target.value)} placeholder="粘贴一段 AI 回复，看看隐藏后的效果" />
                </label>
                {sample && !result.error && (
                    <div className="flex flex-col gap-1">
                        <span className="menu-desc">隐藏后</span>
                        <div className="ui-code-block whitespace-pre-wrap" aria-label="隐藏后的预览">{result.output || "（正文已全部隐藏）"}</div>
                    </div>
                )}
                <button type="button" className="ui-btn ui-btn-primary w-full" disabled={!input.trim() || result.pending || !!result.error}
                    onClick={() => { if (!result.error && !result.pending) onCreate(name.trim() || "AI 正文隐藏", createDisplayFilterRules(input, mode, "display-filter")); }}>
                    保存并对所有角色启用
                </button>
            </div>
        </BottomSheet>
    );
}
