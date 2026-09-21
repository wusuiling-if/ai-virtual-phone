/** Public update source; credentials are used only by the browser against api.github.com. */
export const UPDATE_REPOSITORY = "wusuiling-if/ai-virtual-phone";
export const UPDATE_BRANCH = "codex/phone-compatibility";
export const PHONE_BUILD_BRANCH = process.env.NEXT_PUBLIC_PHONE_BUILD_BRANCH || "";
export const PHONE_BUILD_SHA = process.env.NEXT_PUBLIC_PHONE_BUILD_SHA || "";
export const PHONE_BUILD_REPOSITORY = process.env.NEXT_PUBLIC_PHONE_BUILD_REPOSITORY || "";
export const PHONE_DEPLOYMENT_MODE = process.env.NEXT_PUBLIC_PHONE_DEPLOYMENT_MODE || "unknown";
export type UpdateCheck = {
    state: "current" | "available" | "refresh" | "custom" | "unknown";
    deployedSha: string;
    latestSha?: string;
    summary?: string;
};
const validSha = (sha: unknown): sha is string => typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha);
export function normalizeUpdateRepository(value: string): string {
    const repository = value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/\/$/, "").replace(/\.git$/, "");
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9_.-]+$/i.test(repository) || repository.endsWith("/.") || repository.endsWith("/..")) throw new Error("仓库请填写 用户名/仓库名，或完整 GitHub 仓库链接");
    return repository;
}

async function github(path: string, token: string, init: RequestInit = {}, fetcher = fetch) {
    const response = await fetcher(`https://api.github.com${path}`, {
        ...init, cache: "no-store", redirect: "error",
        headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body ? { "Content-Type": "application/json" } : {}) },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
        if (response.status === 401) throw new Error("GitHub 授权已失效，请重新填写更新令牌");
        if (response.status === 403 || response.status === 429) throw new Error("GitHub 拒绝了请求：请检查令牌仓库权限、分支保护，或稍后重试以避开请求限额");
        if (response.status === 404) throw new Error("找不到仓库或分支，或令牌没有访问权限；请检查仓库地址和兼容分支");
        if (response.status === 409 || response.status === 422) throw new Error("无法安全同步：分支可能有自定义修改、已发生变化或受保护。未强制覆盖，请到 GitHub 检查");
        throw new Error(`GitHub 暂时无法完成请求（${response.status}），请稍后重试`);
    }
    return response.json();
}
export async function readDeployedVersion(signal?: AbortSignal, fetcher = fetch): Promise<string> {
    const response = await fetcher(`/api/app-version?t=${Date.now()}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error("无法读取本站版本，请检查网络或稍后重试");
    const data = await response.json();
    return validSha(data.sha) ? data.sha : "";
}
export async function checkPhoneUpdate(token = "", clientSha = PHONE_BUILD_SHA, signal?: AbortSignal, fetcher = fetch): Promise<UpdateCheck> {
    const deployedSha = await readDeployedVersion(signal, fetcher);
    // A newer deployment is already ready: no GitHub credential/network needed for this path.
    if (validSha(clientSha) && deployedSha && deployedSha !== clientSha) return { state: "refresh", deployedSha };
    const latest = await github(`/repos/${UPDATE_REPOSITORY}/commits/${encodeURIComponent(UPDATE_BRANCH)}`, token, { signal }, fetcher);
    if (!validSha(latest.sha)) throw new Error("更新源返回的版本信息无效");
    const result = { deployedSha, latestSha: latest.sha, summary: String(latest.commit?.message || "").split("\n")[0].slice(0, 240) };
    if (!deployedSha) return { ...result, state: "unknown" };
    if (deployedSha === latest.sha) return { ...result, state: "current" };
    try {
        const comparison = await github(`/repos/${UPDATE_REPOSITORY}/compare/${deployedSha}...${latest.sha}`, token, { signal }, fetcher);
        return { ...result, state: comparison.status === "ahead" ? "available" : "custom" };
    } catch (error) {
        // Preserve network/auth failures rather than silently treating them as "up to date".
        throw error;
    }
}

export async function syncPhoneFork(repositoryInput: string, tokenInput: string, expectedSha: string, signal?: AbortSignal, fetcher = fetch, targetBranch = UPDATE_BRANCH): Promise<{ sha: string; changed: boolean }> {
    const repository = normalizeUpdateRepository(repositoryInput);
    if (targetBranch !== UPDATE_BRANCH && targetBranch !== "main") throw new Error("当前部署分支不支持一键更新，请在 GitHub 手动合并");
    const token = tokenInput.trim();
    if (!token) throw new Error("首次更新请在下方配置 GitHub 更新授权");
    if (!validSha(expectedSha)) throw new Error("请先检查更新");
    const options = { signal };
    const latest = await github(`/repos/${UPDATE_REPOSITORY}/commits/${encodeURIComponent(UPDATE_BRANCH)}`, token, options, fetcher);
    if (latest.sha !== expectedSha) throw new Error("更新源已有新的提交，请重新检查更新后再试");
    const metadata = await github(`/repos/${repository}`, token, options, fetcher);
    if (metadata.full_name?.toLowerCase() !== repository.toLowerCase() || metadata.permissions?.push !== true) throw new Error("此令牌没有该仓库的写入权限");
    const isSource = repository.toLowerCase() === UPDATE_REPOSITORY.toLowerCase();
    const source = String(metadata.source?.full_name || metadata.parent?.full_name || "").toLowerCase();
    if (!isSource && (!metadata.fork || source !== UPDATE_REPOSITORY.toLowerCase())) throw new Error("这个仓库不是兼容版的 Fork。请使用从 wusuiling-if/ai-virtual-phone 创建的 Fork；原作者仓库的旧 Fork 不适用");
    const refPath = `/repos/${repository}/git/refs/heads/${encodeURIComponent(targetBranch)}`;
    const current = await github(refPath.replace("/git/refs/", "/git/ref/"), token, options, fetcher);
    const currentSha = current.object?.sha;
    if (!validSha(currentSha)) throw new Error("目标分支信息无效");
    if (currentSha === expectedSha) return { sha: expectedSha, changed: false };
    if (isSource && targetBranch === UPDATE_BRANCH) throw new Error("维护者仓库已发生变化，请重新检查更新");
    const comparison = await github(`/repos/${repository}/compare/${currentSha}...${expectedSha}`, token, options, fetcher);
    if (comparison.status !== "ahead") throw new Error("你的分支包含自定义修改，已停止自动更新。请在 GitHub 手动合并，原代码保持不变");
    // GitHub enforces fast-forward at write time too, protecting against concurrent edits.
    const updated = await github(refPath, token, { ...options, method: "PATCH", body: JSON.stringify({ sha: expectedSha, force: false }) }, fetcher);
    if (updated.object?.sha !== expectedSha) throw new Error("GitHub 返回了未预期的结果，请重新检查分支状态");
    const verified = await github(refPath.replace("/git/refs/", "/git/ref/"), token, options, fetcher);
    if (verified.object?.sha !== expectedSha) throw new Error("同步后分支再次发生变化，请重新检查，不会自动覆盖");
    return { sha: expectedSha, changed: true };
}
