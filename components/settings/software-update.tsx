"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { checkPhoneUpdate, normalizeUpdateRepository, PHONE_BUILD_REPOSITORY, PHONE_BUILD_SHA, PHONE_DEPLOYMENT_MODE, readDeployedVersion, syncPhoneFork, UPDATE_BRANCH, UPDATE_REPOSITORY, type UpdateCheck } from "@/lib/phone-update";

const PREFS = "phone-update-repository-v1";
const TOKEN = "phone-update-session-token-v1";
const PENDING = "phone-update-pending-v1";
const WAIT_LIMIT = 10 * 60_000;
const short = (sha?: string) => sha ? sha.slice(0, 7) : "未记录";
const stateText = {
    current: "当前已是最新版本",
    available: "发现可更新版本",
    refresh: "本站已部署新版本，可以重新载入",
    custom: "本站包含自定义提交，需手动合并更新",
    unknown: "本站没有记录构建版本，暂不能自动判断更新",
};

export function SoftwareUpdate() {
    const [repository, setRepository] = useState(PHONE_BUILD_REPOSITORY);
    const [token, setToken] = useState("");
    const [remember, setRemember] = useState(false);
    const [check, setCheck] = useState<UpdateCheck | null>(null);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");
    const [pending, setPending] = useState<{ sha: string; started: number } | null>(null);
    const [ready, setReady] = useState(false);
    const [autoReload, setAutoReload] = useState(false);
    const [showConfig, setShowConfig] = useState(false);
    const lifetime = useRef<AbortController | null>(null);

    useEffect(() => {
        lifetime.current = new AbortController();
        try {
            setRepository(localStorage.getItem(PREFS) || PHONE_BUILD_REPOSITORY);
            const saved = sessionStorage.getItem(TOKEN) || "";
            setToken(saved); setRemember(Boolean(saved));
            const job = JSON.parse(sessionStorage.getItem(PENDING) || "null");
            if (job && /^[a-f0-9]{40}$/i.test(job.sha) && typeof job.started === "number") {
                if (job.sha === PHONE_BUILD_SHA) {
                    sessionStorage.removeItem(PENDING); setMessage("已载入更新后的版本");
                } else if (Date.now() - job.started < WAIT_LIMIT) setPending(job);
                else { sessionStorage.removeItem(PENDING); setMessage("上次更新等待已结束，请检查部署平台状态后重新检查更新"); }
            }
        } catch { /* Storage may be disabled; one-time updates still work. */ }
        return () => lifetime.current?.abort();
    }, []);

    useEffect(() => {
        if (!pending) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            if (Date.now() - pending.started >= WAIT_LIMIT) {
                setPending(null);
                try { sessionStorage.removeItem(PENDING); } catch { /* optional */ }
                setMessage("仓库已同步，但 10 分钟内未检测到新版上线。请查看部署日志、生产分支及 Git 自动部署设置，再点检查更新；不必重复同步代码。");
                return;
            }
            try {
                const sha = await readDeployedVersion(controller.signal);
                if (controller.signal.aborted) return;
                if (sha === pending.sha) {
                    setReady(true); setPending(null); setMessage("新版已部署完成。结束正在进行的聊天或编辑后，点击载入新版。");
                    return;
                }
            } catch { /* Deployments may briefly be unavailable. Keep the confirmed sync state. */ }
            if (!controller.signal.aborted) timer = setTimeout(poll, 15_000);
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [pending]);

    const runCheck = async () => {
        setBusy(true); setError(""); setMessage(""); setCheck(null); setReady(false);
        try {
            const result = await checkPhoneUpdate(token.trim(), PHONE_BUILD_SHA, lifetime.current?.signal);
            setCheck(result); setReady(result.state === "refresh");
        } catch (e) { if (!lifetime.current?.signal.aborted) setError(e instanceof Error ? e.message : "检查更新失败，请检查网络"); }
        finally { setBusy(false); }
    };
    const update = async () => {
        if (PHONE_DEPLOYMENT_MODE === "manual") { setError("本站由命令行手动部署。同步 GitHub 不会触发 Vercel 发布，请按下方说明手动部署新版。"); return; }
        if (!token.trim() || !repository.trim()) { setShowConfig(true); setError("请先完成下面的首次更新配置，再点击一键更新"); return; }
        if (!check?.latestSha) return;
        setBusy(true); setError(""); setMessage("");
        try {
            const target = normalizeUpdateRepository(repository);
            const result = await syncPhoneFork(target, token, check.latestSha, lifetime.current?.signal);
            try { localStorage.setItem(PREFS, target); } catch { /* optional */ }
            const job = { sha: result.sha, started: Date.now() };
            try { sessionStorage.setItem(PENDING, JSON.stringify(job)); } catch { /* optional */ }
            setMessage(result.changed ? "仓库已同步，正在等待部署平台发布新版…" : "仓库已经是最新代码，正在等待部署平台发布新版…");
            setAutoReload(true); setPending(job);
        } catch (e) { if (!lifetime.current?.signal.aborted) setError(e instanceof Error ? e.message : "更新失败，请检查网络后重试"); }
        finally { setBusy(false); }
    };
    const reload = useCallback(async () => {
        setBusy(true); setError("");
        try {
            // Refuse to reload into an offline snapshot. Do not delete databases, storage or push registrations.
            const sha = await readDeployedVersion(lifetime.current?.signal);
            if (!sha || sha === PHONE_BUILD_SHA) throw new Error("暂未确认新版可用，请稍后重新检查更新");
            if ("serviceWorker" in navigator) {
                const registration = await navigator.serviceWorker.getRegistration();
                if (registration) void registration.update().catch(() => undefined);
            }
            window.location.reload();
        } catch (e) { setError(e instanceof Error ? e.message : "无法载入新版，请稍后重试"); setBusy(false); }
    }, []);
    useEffect(() => {
        if (!ready || !autoReload) return;
        const timer = setTimeout(() => {
            // Navigating away unmounts this page and cancels the automatic refresh.
            if (document.visibilityState === "visible") void reload();
            setAutoReload(false);
        }, 5000);
        return () => clearTimeout(timer);
    }, [ready, autoReload, reload]);
    return <div className="flex flex-col gap-5 pb-8">
        <div className="ui-list-card flex-col items-stretch gap-3">
            <h2 className="menu-label">小手机软件更新</h2>
            <p className="menu-desc">当前版本：{short(PHONE_BUILD_SHA)}{check?.latestSha ? ` · 最新版本：${short(check.latestSha)}` : ""}</p>
            <p className="menu-desc">{UPDATE_REPOSITORY} · {UPDATE_BRANCH}</p>
            {check && <p role="status">{stateText[check.state]}</p>}
            {PHONE_DEPLOYMENT_MODE === "manual" && <p className="menu-desc">本站使用命令行手动部署。请在部署电脑拉取兼容分支，再运行 <code>npm run deploy:vercel</code> 发布；GitHub 一键同步不会让本站上线新版。</p>}
            {PHONE_DEPLOYMENT_MODE === "unknown" && check?.state === "available" && <p className="menu-desc">未识别到本站的 Git 自动部署信息。使用一键更新前，请确认 Vercel / Netlify 已连接此仓库并将兼容分支设为生产分支；命令行部署请在部署电脑手动发布。</p>}
            {check?.summary && <p className="menu-desc break-words">最近改动：{check.summary}</p>}
            {message && <p role="status" className="menu-desc">{message}</p>}
            {ready && autoReload && <div><p className="menu-desc">5 秒后自动载入新版。</p><button type="button" className="ui-btn ui-btn-outline" onClick={() => setAutoReload(false)}>稍后载入</button></div>}
            {error && <p role="alert" className="menu-desc" style={{ color: "var(--c-danger, #c62828)" }}>{error}</p>}
            <button type="button" className="ui-btn ui-btn-outline" disabled={busy || Boolean(pending)} onClick={() => void runCheck()}>{busy ? "处理中…" : "检查更新"}</button>
            {ready ? <button type="button" className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void reload()}>载入新版</button>
                : check?.state === "available" && PHONE_DEPLOYMENT_MODE !== "manual" && <button type="button" className="ui-btn ui-btn-primary" disabled={busy || Boolean(pending)} onClick={() => void update()}>{pending ? "等待新版上线…" : "一键更新"}</button>}
            {pending && <button type="button" className="ui-btn ui-btn-outline" onClick={() => {
                setAutoReload(false); setPending(null); try { sessionStorage.removeItem(PENDING); } catch { /* optional */ }
                setMessage("已停止等待，已同步的代码不会撤销。可以稍后再次检查更新。");
            }}>停止等待</button>}
            <p className="menu-desc">更新不清除本机数据。建议先导出备份并结束聊天或编辑。一键更新成功后，本页会自动载入新版；离开此页或切到后台则不会自动刷新。</p>
        </div>
        <details open={showConfig} onToggle={e => setShowConfig(e.currentTarget.open)} className="ui-list-card flex-col items-stretch gap-3">
            <summary className="menu-label cursor-pointer">首次配置 / 更新授权</summary>
            <div className="flex flex-col gap-3 mt-3">
                <p className="menu-desc">用于自己部署的小手机：仓库必须是本兼容版的 Fork，且部署平台已连接下面的兼容分支并开启 Git 自动部署。首次配置后即可在这里同步并等待新版上线。</p>
                <label className="menu-desc">你的 GitHub 仓库
                    <input className="ui-input w-full" aria-label="更新目标仓库" value={repository} disabled={busy || Boolean(pending)} placeholder="你的用户名/ai-virtual-phone" onChange={e => {
                        setRepository(e.target.value); try { localStorage.setItem(PREFS, e.target.value); } catch { /* optional */ }
                    }} />
                </label>
                <label className="menu-desc">GitHub 更新令牌
                    <input type="password" autoComplete="off" className="ui-input w-full" aria-label="GitHub 更新令牌" value={token} disabled={busy || Boolean(pending)} placeholder="仅授权上述仓库的 Fine-grained token" onChange={e => {
                        setToken(e.target.value); if (remember) try { sessionStorage.setItem(TOKEN, e.target.value); } catch { /* optional */ }
                    }} />
                </label>
                <label className="menu-desc"><input type="checkbox" checked={remember} onChange={e => {
                    setRemember(e.target.checked);
                    try { if (e.target.checked) sessionStorage.setItem(TOKEN, token); else sessionStorage.removeItem(TOKEN); } catch { /* optional */ }
                }} /> 在当前标签页会话中记住授权</label>
                <p className="menu-desc">令牌由浏览器直接发给 GitHub，不交给本站服务端，也不写入小手机备份。需要目标仓库的 Contents 读写权限；更新包含工作流文件时还需要 Workflows 写权限。关闭标签页或令牌过期后可能需要重新授权。</p>
                <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer" className="menu-desc underline">在 GitHub 创建限定仓库的更新令牌</a>
                <button type="button" className="ui-btn ui-btn-outline" disabled={busy} onClick={() => {
                    setToken(""); setRemember(false); try { sessionStorage.removeItem(TOKEN); } catch { /* optional */ }
                }}>清除本页保存的授权</button>
            </div>
        </details>
        <a className="menu-desc underline" href={`https://github.com/${UPDATE_REPOSITORY}/blob/${UPDATE_BRANCH}/docs/software-update.md`} target="_blank" rel="noreferrer">更新说明与常见问题</a>
    </div>;
}
