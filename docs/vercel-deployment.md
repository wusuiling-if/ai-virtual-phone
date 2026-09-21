# Vercel 部署

当前生产站点：https://ai-virtual-phone-ivory-xi.vercel.app/

项目：wusuilings-projects/ai-virtual-phone。2026-09-18 实际核实为 Hobby 免费档，Fluid compute 已开启，Node.js 24.x。模型请求仍使用访问者自行配置的凭据，Vertex 费用单独计算。

## 构建和发布

`npm run build` 会先检查 CSS 引用的本地字体是否存在；缺失时停止构建，避免发布后字体全部 404。稀疏检出时，发布前至少执行 `git sparse-checkout add public/fonts`；其他页面图片和模型等资源也应按所需功能完整检出。

`vercel.json` 使用 Next.js 框架和完整的 `npm run build` 命令，包含微信助手、个人推送分发包与 CSS 修复步骤。

在 Vercel 的 Production 和 Preview 环境中设置 `NEXT_PUBLIC_SELF_HOSTED_MODE=true`。首次部署已设置；该开关仅控制应用自身的登录门禁，不包含模型密钥。

模型接口 `app/api/vertex/route.ts` 与 `app/api/model-request/route.ts` 已声明 `maxDuration = 300`。保持 `VERTEX_RESPONSE_TUNNEL` 未设置，默认使用原生 JSON/SSE。

本机发布命令（先安装 Node.js）：

```sh
npx vercel login
npx vercel link --project ai-virtual-phone --scope wusuilings-projects
npm run deploy:vercel -- --scope wusuilings-projects
```

当前通过 CLI 上传本地工作区发布，未绑定 GitHub 自动部署。站内同步 GitHub 不会触发本站发布；上面的命令会记录构建提交号供版本检查使用。若改为 Git 自动部署，应连接 `wusuiling-if/ai-virtual-phone` 并将 Production 分支设为 `main`；之后推送 `main` 会自动发布。已有的 Netlify 部署未删除。

## 访问和数据

分享上面的生产域名。带团队名的部署别名可能受 Vercel 登录保护，不应作为普通用户入口。

浏览器数据按网站来源隔离：本地站点、Netlify 和 Vercel 不会自动共享角色、聊天记录或模型配置。需要在旧站导出应用备份，再在新站导入。代码部署本身不会上传这些个人数据。

`.vercelignore` 排除了环境文件、本地凭据、依赖和构建缓存。不要将密钥、服务账号 JSON、聊天备份放入 `public/` 或 Git 仓库。
