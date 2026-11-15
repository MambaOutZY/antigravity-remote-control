# 项目开发与维护规范 (AGENTS.md)

## 1. 项目定位与架构原则
- **项目名称**：`agy-remote-control`（位于 `D:\workspace\antigravity-remote-controll`）。
- **核心目标**：为运行在家中 Ubuntu 主机上的 `agy` CLI 提供私有化、零代理直连的仿原生 Remote Control Web 控制台与 Context Viewer 上下文看板，100% 复用本机已登录账号配额。
- **先读记忆**：接手本工作区任务时，请先阅读 [MEMORY.md](./MEMORY.md) 与 [README.md](./README.md) 了解完整背景与接口契约。

## 2. 硬性工程约束
1. **零外部依赖**：
   - 后端仅使用 Node.js >= 20 内置模块（`http`、`fs`、`path`、`os`、`crypto`、`child_process`、`url`），禁止引入需要 `npm install` 的第三方包。
   - 前端（`public/`）严禁引用任何外部 CDN 资源（如 Google Fonts、cdn.jsdelivr.net、unpkg 等），确保无代理内网环境下纯离线可用。
2. **代码规范**：
   - 关键逻辑、非显而易见的设计决策与接口导出需编写简洁清晰的中文注释。
   - 同时兼容 Windows 本地预览测试与 Ubuntu Linux 生产环境（注意路径处理、行尾符；`deploy/` 下的 `.sh` 与 `.service` 文件必须保持纯 LF 换行符）。
3. **安全与鉴权边界**：
   - 不得破坏 `server.js` 中 `AGY_AUTH_PASSWORD` 登录保护、`/api/uploads/:file` 防目录穿越校验以及图片 15MB 上传限制。
   - 不得修改或丢失 `lib/context-unlock-bridge.js` 中的原二进制 `.bak` 自动备份逻辑。
4. **复用 `agy` 配额原则**：
   - 保持通过 `lib/agy-runner.js` 调用宿主机 `agy` / `agy-real` 子进程（继承 `~/.gemini/` 凭证），不要替换为需要独立 API Key 的 SDK 路径。

## 3. 测试与验收命令
每次修改代码后，在项目根目录运行以下命令验证：
```bash
node --test test/smoke.test.js
```
若调整了 `public/index.html` 或 `public/app.js`，需同步检查 DOM ID 匹配与零外部 URL 扫描，确保 0 遗漏、0 外链。
