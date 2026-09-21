import { execFileSync, spawnSync } from "node:child_process";

let sha;
try {
  const changes = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim();
  if (changes) {
    console.error("工作区有未提交文件。请先提交本次版本，避免部署内容与记录的提交号不一致。");
    process.exit(1);
  }
  sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
} catch {
  console.error("无法读取当前 Git 提交，请先在项目仓库中运行。");
  process.exit(1);
}
if (!/^[a-f0-9]{40}$/i.test(sha)) {
  console.error("Git 提交编号无效，部署已停止。");
  process.exit(1);
}

const extra = process.argv.slice(2);
const result = spawnSync("npx", ["vercel", "deploy", "--prod", "--build-env", `PHONE_BUILD_SHA=${sha}`, "--build-env", "PHONE_DEPLOYMENT_MODE=manual", ...extra], { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
