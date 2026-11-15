# AGY Remote Control（私有控制台与上下文看板）

[中文](./README.md) | [English](./README_EN.md)

> 基于原生 Node.js >= 20 零依赖构建的 Antigravity 私有 Web 控制台：在家里的 Ubuntu 主机运行，100% 复用本机 `agy` 原账号登录态与订阅配额，在公司电脑浏览器中直接通过 HTTPS 443 端口远程操控、续聊历史会话、粘贴截图看图并实时审计上下文与 API 等值用量。

---

## 一、核心特性

1. **仿原生 Remote Control 操控体验**
   - 自适应三栏工作台（深色 / 浅色主题切换、移动端抽屉菜单），零外部 CDN 依赖，公司内网无代理环境毫秒级打开。
   - 实时消费 `POST /api/chat/stream` SSE 事件流：支持可折叠 **「思考过程 (Thinking)」** 卡片、**「工具调用 (Tool Calls)」** 状态卡片、安全 Markdown 渲染与代码块一键复制、实时中断生成（Stop）。
   - 支持自由切换 `--model`、`--effort`（`low / medium / high / xhigh / max`）、`--mode`（`auto / accept-edits / plan`）、`--dangerously-skip-permissions` 开关，并在右侧辅助栏实时预览等效 `agy` CLI 命令、工作区文件与 `Git Diff`。

2. **100% 复用 `agy` 原账号配额与历史会话**
   - 直接调用宿主机已登录的 `agy`（或 `agy-real`）CLI，完全继承当前用户 `~/.gemini/` 下的账号凭证与订阅配额，不经过任何第三方中转。
   - 自动扫描 `~/.gemini/antigravity`（桌面端）与 `~/.gemini/antigravity-cli`（CLI）下的 `brain/<id>/.system_generated/logs/transcript.jsonl`，在左侧边栏统一展示历史会话，点击任意历史会话即可加载完整记录并通过 `--conversation <id>` 无缝续聊。
   - 当本机未安装 `agy` 时自动优雅降级为本地演示/审计模式（仍可完整浏览历史会话、统计热力图与测试流式界面）。

3. **融合 Context Viewer 上下文全景看板（顶栏双胶囊）**
   - **胶囊 1（上下文与速度）**：
     - 环形 SVG 进度条实时展示 `已用K / 预算K (百分比%)`、实时 `TTFT`（首字延迟）与 `TPS`（生成速度）。
     - 内置 **8 类错误智能诊断徽章**（正常、上下文超限、额度耗尽、触发限流、认证失效、服务不可用、网络异常、已取消等）。
     - 展开 **「会话上下文明细与附件审计面板」**：对比服务端实测用量与本地 CJK 感知估算、5 维上下文分布（用户提问 / 助手回复 / 思考 / 工具 / 摘要）、图像附件像素与 Tile Token 审计。
     - **上下文窗口 256K 门禁解锁控制**：支持检测 `agy` 二进制门禁状态，备份原文件并一键切换为 256K 默认 / 固定 512K / 900K / 983,040 / 1M / 动态跟随，或随时一键还原备份。
   - **胶囊 2（Token 历史与 API 账单）**：
     - 支持按来源筛选：`全部 / CLI / 桌面端`。
     - 汇总今日 / 本月 / 本年 / 累计总 Token、步骤数与会话数。
     - **52 周交互式日历热力图** + 近 7 天柱状图 + 各模型中位数 TPS/TTFT 速度对比。
     - **API 等值金额与订阅对比**：按官方费率自动折算 USD 与人民币（CNY），直观对比 `$20/月` Pro 订阅性价比。

4. **截图粘贴直接看图**
   - 输入框支持 **`Ctrl+V` 直接粘贴剪贴板截图**、拖拽图片或点击附件按钮选图（支持 PNG / JPEG / GIF / BMP，单张最大 15MB）。
   - 自动将图片落盘至当前工作区的 `.agy_uploads/` 目录，计算像素宽高（如 `1280×720`）与图像 Token，并在发送时自动拼接文件路径提示及 `--add-dir` 参数，引导 `agy` 调用 `read_file` 直接看图分析。

5. **零外部依赖与轻量安全鉴权**
   - 后端仅使用 Node.js >= 20 内置模块（`http`、`fs`、`path`、`os`、`crypto`、`child_process`、`url`），无需 `npm install` 即可直接启动。
   - 设置环境变量 `AGY_AUTH_PASSWORD` 后自动开启全站登录保护（`HttpOnly` Cookie + HMAC-SHA256 签名校验 / `x-agy-token` 请求头）。

---

## 二、目录结构

```text
agy-remote-control/
├── package.json                  # 项目元数据与启动/测试脚本（零外部依赖）
├── server.js                     # HTTP 服务、静态托管、鉴权与 API/SSE 路由
├── lib/
│   ├── meter-engine.js           # CJK/图像 Token 测算、8 类错误分类、52 周热力图与 API 账单引擎
│   ├── context-unlock-bridge.js  # agy 二进制 256K 上下文门禁检测、备份、解锁与还原
│   └── agy-runner.js             # agy CLI 探测、stream-json 流式调用、Git 工作区检查
├── public/                       # 纯静态前端（零外部 CDN，离线/内网直开）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── deploy/
│   ├── install-ubuntu.sh         # Ubuntu 20.04/22.04/24.04 一键部署脚本
│   └── agy-remote.service        # systemd 服务模板
├── test/
│   └── smoke.test.js             # Node.js 内置 node:test 自动化冒烟测试
└── README.md
```

---

## 三、Ubuntu 一键部署与启动方式

### 1. 前置准备（Ubuntu 20.04 / 22.04 / 24.04）

1. **安装 Node.js >= 20**：
   ```bash
   node -v   # 若低于 v20 或未安装，可执行以下命令安装 Node 20 LTS：
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
2. **确认 `agy` 已安装并完成账号登录**：
   ```bash
   which agy || ls -l ~/.gemini/antigravity/bin/agy
   # 若尚未登录，请使用当前普通用户执行一次登录（切勿用 sudo 登录到 root）
   agy auth login   # 或直接运行 agy 按引导完成登录
   ```
   > **保持登录态的关键原则**：`agy` 的 OAuth 登录态、本地会话日志及订阅配额均保存在当前用户的 `~/.gemini/` 目录中。**请务必使用同一个普通 Linux 用户运行本项目服务**，不要随意用 `root` 启动。

### 2. 一键部署（推荐用户级 `systemd --user`）

进入项目根目录执行安装向导：

```bash
cd /path/to/agy-remote-control
chmod +x deploy/install-ubuntu.sh
bash deploy/install-ubuntu.sh
```

脚本会自动完成以下操作：
- 校验系统版本与 `Node.js >= 20`；
- 按 `AGY_BIN`、`~/.gemini/antigravity/bin/agy`、`~/.local/bin/agy`、`/usr/local/bin/agy`、`PATH` 顺序探测 `agy` / `agy-real`；
- 引导设置（或通过环境变量提前传入）：
  - `HOST`：默认 `0.0.0.0`（便于路由器或隧道跨机转发；若反代与本机同机且仅限本机访问可设为 `127.0.0.1`）
  - `PORT`：默认 `8787`
  - `AGY_AUTH_PASSWORD`：**公网穿透强烈建议设置**（支持交互留空时自动生成 24 位高强度随机密码）
  - `DEFAULT_WORKSPACE`：打开控制台时默认的工作区目录（默认 `$HOME`）
- 将私密配置写入 `~/.config/agy-remote/env`（权限 `600`），并自动注册用户级服务 `~/.config/systemd/user/agy-remote.service`；
- 自动尝试开启 `loginctl enable-linger "$USER"`，确保 SSH 断开或系统重启后用户级服务仍可长期后台常驻。

**支持非交互式环境变量一键安装**：
```bash
HOST=0.0.0.0 \
PORT=8787 \
AGY_AUTH_PASSWORD='你的强密码' \
DEFAULT_WORKSPACE="$HOME/workspace" \
SERVICE_MODE=user \
bash deploy/install-ubuntu.sh
```

### 3. 常用服务管理命令

```bash
# 查看服务运行状态
systemctl --user status agy-remote.service

# 实时查看输出日志（排查 agy 调用与鉴权日志）
journalctl --user -u agy-remote.service -f

# 修改 ~/.config/agy-remote/env 后重启生效
systemctl --user restart agy-remote.service

# 验证服务健康状态
curl -s http://127.0.0.1:8787/api/health

# 若安装脚本提示权限不足未能自动开启 linger，请手动执行一次：
sudo loginctl enable-linger "$USER"
```

### 4. 手动启动与系统级 systemd 备选方案

- **临时手动启动（Linux / macOS）**：
  ```bash
  set -a && source ~/.config/agy-remote/env && set +a
  node server.js
  ```
- **Windows 本地开发预览**：
  ```powershell
  $env:PORT="8787"
  $env:AGY_AUTH_PASSWORD="dev-password"
  node server.js
  ```
- **系统级 systemd 部署**：可参考 [deploy/agy-remote.service](./deploy/agy-remote.service) 模板复制到 `/etc/systemd/system/agy-remote.service`，务必取消 `User=` 与 `Group=` 注释并设为持有 `~/.gemini/` 凭证的用户名，将 `%h` 替换为真实家目录路径，并将 `WantedBy=` 改为 `multi-user.target`。

---

## 四、家里 iKuai 路由器内网穿透配置教程（核心）

假设网络环境如下：
- 家里主路由：**iKuai（爱快）**
- 家里主机：**Ubuntu 服务器**，局域网固定 IP 为 `192.168.1.100`（建议在 iKuai「网络设置 -> DHCP 服务端 -> DHCP 静态分配」中将 Ubuntu MAC 与 IP 绑定）
- 本服务运行在 Ubuntu 的 `0.0.0.0:8787`
- 目标：在公司电脑浏览器（受限网络，通常仅开放 `80/443` 端口且无代理）稳定安全访问家里的控制台。

下面提供两种成熟方案，**按家里是否拥有公网 IP 选择其一即可**：

---

### 方案 A：Lucky 反向代理方案（有公网 IP / 公网 IPv6 首选）

> **适用场景**：家里宽带有公网 IPv4（非运营商大内网 CGNAT）或公网 IPv6，已在 iKuai 旁路由 / Docker / iKuai 虚拟机 / Ubuntu 本机部署了 **Lucky**。

#### 第 1 步：DDNS 动态域名 + 自动 HTTPS 证书
1. 在 Lucky 控制台进入 **「动态域名 (DDNS)」**，添加你的域名服务商（如 Cloudflare / 阿里云 / 腾讯云），解析记录指向家里的公网 IP（例如 `agy.example.com`）。
2. 进入 **「安全管理 -> SSL 证书」**，使用 ACME（DNS API 验证方式最佳，不依赖 80 端口）申请 `agy.example.com`（或 `*.example.com`）Let's Encrypt 证书并开启自动续期。

#### 第 2 步：创建 Lucky Web 服务反向代理规则
1. 进入 Lucky **「Web 服务 -> 添加 Web 服务规则」**：
   - **监听类型**：勾选 **TCPv4 / TCPv6**（按需），**开启 TLS（HTTPS）**。
   - **监听端口**：填外网访问 HTTPS 端口（若宽带未封 443 可填 `443`；若家庭宽带封锁 443，可填如 `8443` 或 `10443`，公司仅放行 443 时建议改用下方方案 B Cloudflare Tunnel）。
   - **默认证书**：选择第 1 步申请好的 SSL 证书。
2. 添加子规则：
   - **前端地址（域名）**：`agy.example.com`
   - **服务类型**：`反向代理`
   - **后端地址**：`http://192.168.1.100:8787`（如果 Lucky 与 `agy-remote` 部署在同一台 Ubuntu 上，填 `http://127.0.0.1:8787` 即可）。

#### 第 3 步：关键！禁用缓冲与缓存以保证 SSE 实时流式不卡顿
本项目所有 AI 思考过程、工具调用与文本回复均通过 **SSE (`text/event-stream`)** 逐字流式推送。如果反向代理开启了响应缓冲，会出现“前端一直等待，直到回答全部结束后一次性弹出”的假死现象！

请在 Lucky 该子规则的 **「高级选项 / 扩展设置」** 中确认以下配置：
1. **关闭响应缓冲 / 开启流式立即刷新**：
   - 勾选 **「禁用响应缓冲」**（或关闭缓冲 / 将刷新间隔 `FlushInterval` 设为 `-1` / 立即刷新模式）。
   - 本项目后端已在 `/api/chat/stream` 响应头内置 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`，与反代侧关闭缓冲双保险配合。
2. **开启 WebSocket / 长连接支持**：
   - 勾选 **「支持 WebSocket」**（部分 Lucky 版本可同步优化长连接与流式透传），并确保后端读写超时足够大（建议 >= 300 秒，避免复杂任务长时间思考触发 504 Gateway Timeout）。
3. **禁用页面/静态资源缓存**：
   - 不要对 `/api/*` 启用任何缓存规则，避免会话列表或流式接口被缓存。
   - 若你在 Lucky 前面还串联了 Nginx/OpenResty，请在 `location /` 中补充：
     ```nginx
     proxy_buffering off;
     proxy_cache off;
     proxy_read_timeout 3600s;
     chunked_transfer_encoding on;
     proxy_set_header Connection "";
     proxy_http_version 1.1;
     ```

#### 第 4 步：配置安全鉴权（二选一或双层叠加）
- **方式 1（推荐，开箱即用）**：直接在 Ubuntu 部署时设置高强度 `AGY_AUTH_PASSWORD`，所有接口受 HMAC-SHA256 `HttpOnly` Cookie 保护，只允许登录后访问。
- **方式 2（双层防护）**：在 Lucky 该子规则中同时开启 **「BasicAuth 基本认证」**（设置额外用户名密码），或在 Lucky 安全规则中限制来源地区/IP，外层 BasicAuth + 内层 `AGY_AUTH_PASSWORD` 双重门禁更安心。

#### 第 5 步：iKuai 路由器端口映射（若 Lucky 部署在内网 Ubuntu 上）
- 如果 Lucky 直接跑在 iKuai 本机（插件/虚拟机共享网关），只需在 iKuai 防火墙放行 Lucky 监听端口即可。
- 如果 Lucky 跑在 Ubuntu（`192.168.1.100`）上：
  1. 登录 iKuai 管理后台 -> **「网络设置 -> 端口映射 -> 添加」**。
  2. **协议**：`TCP`
  3. **外网端口**：Lucky 对外 HTTPS 端口（如 `8443` 或 `443`）
  4. **内网地址**：`192.168.1.100`
  5. **内网端口**：Lucky 实际监听的 HTTPS 端口
- **严禁直接把 Ubuntu 的 `8787` 明文 HTTP 端口映射到公网！** 密码和源码内容必须经过 HTTPS 加密传输。

---

### 方案 B：Cloudflare Tunnel 方案（无公网 IP / 公司 443 直连首选）

> **适用场景**：
> - 家里宽带是运营商大内网（无公网 IPv4、无公网 IPv6），iKuai 无法做端口映射；
> - 或者家庭宽带封锁了 80/443 端口，而**公司电脑只允许访问标准 443 HTTPS 端口且禁止装代理**。
>
> **优势**：iKuai 路由器 **零配置、零端口映射**、不暴露家里公网 IP，且自带 Cloudflare 边缘 **Zero Trust 邮箱 OTP 身份认证** + 原生 HTTP/2 443 端口穿透！

#### 第 1 步：准备 Cloudflare 域名
准备一个托管在 Cloudflare DNS 的域名（免费套餐即可），并登录 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com/)。

#### 第 2 步：创建 Tunnel 并在 Ubuntu 安装 `cloudflared`
1. 在 Cloudflare Zero Trust 左侧菜单进入 **「Networks -> Tunnels -> Create a tunnel」**。
2. Connector 类型选择 **Cloudflared**，给隧道命名（如 `home-ubuntu-agy`）。
3. 在 Ubuntu 服务器上安装并绑定隧道（控制台会自动生成带 `<TOKEN>` 的安装命令，大致如下）：
   ```bash
   # 添加 Cloudflare 官方源并安装 cloudflared（Ubuntu 20.04/22.04/24.04 通用）
   sudo mkdir -p --mode=0755 /usr/share/keyrings
   curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
   echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
   sudo apt-get update && sudo apt-get install -y cloudflared

   # 使用 Cloudflare 页面提供的专属 Token 安装为开机自启系统服务
   sudo cloudflared service install <你的_TUNNEL_TOKEN>
   ```
   > 提示：你也可以把 `cloudflared` 跑在 iKuai 旁路由或 Docker 中，只要该容器能访问 `http://Ubuntu内网IP:8787` 即可。

#### 第 3 步：配置 Public Hostname（指向本机 8787）
在刚才创建的 Tunnel 页面点击 **「Public Hostname -> Add a public hostname」**：
- **Subdomain**：`agy`（最终访问地址为 `https://agy.yourdomain.com`）
- **Domain**：选择你的域名 `yourdomain.com`
- **Service Type**：`HTTP`
- **URL**：
  - 若 `cloudflared` 与 `agy-remote` 在同一台 Ubuntu 上：填 `127.0.0.1:8787`
  - 若 `cloudflared` 部署在路由器/其他机器上：填 `192.168.1.100:8787`（即 `Ubuntu内网IP:8787`）
- **Additional application settings -> HTTP Settings**（可选优化）：
  - `Keep-Alive Timeout` 保持默认或调大至 `120s+`，`cloudflared` 原生支持 SSE 流式直通，不会缓冲阻塞。

#### 第 4 步：开启 Cloudflare Zero Trust (Access) 邮箱认证保护（强烈建议！）
千万不要让公网任何人都能直接摸到你的 AI 控制台页面，在 Cloudflare 边缘节点加上邮箱白名单认证：
1. 在 Cloudflare Zero Trust 控制台进入 **「Access -> Applications -> Add an application」**，选择 **Self-hosted**。
2. **Application configuration**：
   - **Application name**：`AGY Remote Control`
   - **Session Duration**：按需选择 `24 hours` 或 `7 days`（公司电脑无需频繁重新收验证码）
   - **Application domain**：填写刚才的子域名 `agy` 和域名 `yourdomain.com`
3. **Identity providers**：确认已启用默认的 **One-time PIN（一次性邮箱验证码）**（无需额外配置第三方 OAuth）。
4. **Policies（访问策略）**：
   - **Policy name**：`Only Me`
   - **Action**：`Allow`
   - **Configure rules -> Include**：选择 **Emails**，填入你自己的私人/常用邮箱地址（如 `myname@gmail.com`）。
5. 保存后生效！所有未通过你个人邮箱验证码的请求会在 Cloudflare 全球边缘节点直接被拦截，甚至根本不会抵达你家里的 iKuai 和 Ubuntu。

#### 第 5 步：公司电脑无缝访问
1. 打开公司电脑任意现代浏览器（Chrome / Edge），直接访问 **`https://agy.yourdomain.com`**（标准 443 端口 HTTPS，无需代理或客户端）。
2. 输入你的邮箱 -> 填写邮件收到的一次性验证码（Zero Trust Access）-> 如设置了 `AGY_AUTH_PASSWORD` 再输入一次本地密码。
3. 即可完整使用历史会话续聊、截图 `Ctrl+V` 粘贴提问、52 周 Token 看板与实时流式输出。

---

## 五、多账号管理与一键切换（Multi-Account Switching）

本项目内置了兼容 `cockpit-tools` 与 `antigravity-switch` 布局的**多账号秒级热切换能力**。无需手动登录登出或修改底层配置，只需将各个账号的 JSON 凭证文件存放到指定目录，即可在 Web 控制台的配置抽屉或顶部快速查看账号列表、当前生效状态并一键切换。

### 1. 账号 JSON 文件存放路径

系统按以下优先级与规则自动扫描账号 JSON 文件（忽略以 `.` 开头的隐藏文件）：

1. **默认目录**：
   ```bash
   /home/antigravity-switch/account/*.json
   ```
2. **自定义路径（通过环境变量配置）**：
   - `AGY_ACCOUNTS_DIR`：直接指定账号 JSON 所在目录（例如 `AGY_ACCOUNTS_DIR=/home/zhangyu/.config/agy-remote/accounts`）。
   - `AGY_SWITCH_DIR`：指定 switch 根目录（默认 `/home/antigravity-switch`），系统会自动扫描其子目录 `$AGY_SWITCH_DIR/account/`。

> **命名建议**：推荐以账号邮箱或易记的别名命名文件名，例如：
> - `main-user@gmail.com.json`
> - `work-enterprise@company.com.json`
> - `backup-account.json`

---

### 2. 账号 JSON 文件格式与字段说明

账号 JSON 文件的核心作用是向 Google OAuth 端点自动刷新获取最新的 `access_token`。系统完全兼容以下两种标准格式：

#### 格式 A：标准扁平格式（推荐）
```json
{
  "email": "your_email@gmail.com",
  "refresh_token": "1//04xxxxxxxxxxxxxxxxxxxxxxx_your_oauth_refresh_token",
  "project_id": "your-gcp-project-id",
  "id_token": "eyJhbGciOiJSUzI1NiIs..."
}
```

#### 格式 B：带 token 嵌套对象格式（兼容官方生成的 token 文件）
```json
{
  "email": "your_email@gmail.com",
  "project_id": "your-gcp-project-id",
  "token": {
    "access_token": "ya29.a0xxxxxxxx...",
    "refresh_token": "1//04xxxxxxxxxxxxxxxxxxxxxxx_your_oauth_refresh_token",
    "token_type": "Bearer",
    "expiry": "2026-11-16T00:00:00.000Z"
  }
}
```

#### 字段含义：
| 字段名 | 是否必需 | 说明 |
| :--- | :---: | :--- |
| `refresh_token` | **必需** | Google OAuth Refresh Token，控制台通过它自动刷新换取有效的 `access_token` |
| `email` | 可选 | 账号邮箱标识（若未提供，系统会自动从 `id_token` 解密提取或根据文件名推导） |
| `project_id` | 可选 | 关联的 Google Cloud 项目 ID（如 Cloud AI Companion / Vertex 绑定的项目） |
| `id_token` | 可选 | Google 签发的身份 JWT，用于安全提取和核验用户邮箱 |

---

### 3. 如何导出并保存已有账号凭据

如果你已经在 Ubuntu 本机上通过 `agy` 登录过某个账号，可以直接将其当前有效的凭证保存为账号库中的一员：

```bash
# 1. 创建账号保存目录
sudo mkdir -p /home/antigravity-switch/account
sudo chown -R $USER:$USER /home/antigravity-switch

# 2. 拷贝当前登录态凭据并重命名为对应邮箱
cp ~/.gemini/antigravity-cli/antigravity-oauth-token /home/antigravity-switch/account/my_account@gmail.com.json

# 3. 登录下一个新账号
agy auth login

# 4. 再次保存为第二个账号
cp ~/.gemini/antigravity-cli/antigravity-oauth-token /home/antigravity-switch/account/second_account@gmail.com.json
```

---

### 4. 账号切换生效机制

在 Web 控制台点击任意账号卡片上的 **「切换」**：
1. **自动刷新**：服务端经配置的本地网络代理向 Google OAuth Token Endpoint 请求最新的 `access_token`；
2. **原子写入**：自动将最新凭据以严格 `0o600` 文件权限原子写入宿主机生效路径：
   - 主路径：`~/.gemini/antigravity-cli/antigravity-oauth-token`
   - 备用兼容路径：`~/.gemini/jetski-standalone-oauth-token`
3. **零重启生效**：服务端自动清空模型列表与子进程凭证缓存，下一次发起对话即刻使用新账号的配额与额度，无需重启后台服务。

---

## 六、环境变量说明

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `HOST` | `0.0.0.0` | HTTP 服务绑定地址 |
| `PORT` | `8787` | HTTP 服务监听端口 |
| `AGY_AUTH_PASSWORD` | 空（不鉴权） | Web 访问密码，设置后开启 Cookie/Token 登录保护 |
| `DEFAULT_WORKSPACE` | 当前工作目录/家目录 | 页面初始默认工作区路径 |
| `AGY_BIN` | 自动探测 | 显式指定 `agy` 或 `agy-real` 可执行文件绝对路径 |
| `AGY_SWITCH_DIR` | `/home/antigravity-switch` | 账号管理与 switch 根目录，账号存放于其 `account/` 子目录下 |
| `AGY_ACCOUNTS_DIR` | `$AGY_SWITCH_DIR/account` | 显式指定账号 JSON 存放目录 |
| `AG_DIR` | `~/.gemini/antigravity` | 桌面端会话日志与配置目录覆盖（测试/多目录场景） |
| `AG_CLI_DIR` | `~/.gemini/antigravity-cli` | CLI 会话日志目录覆盖 |

---

## 七、自动化测试与安全提醒

### 运行内置自动化测试
本项目使用 Node.js 内置 `node:test` 编写全流程冒烟测试（鉴权、会话解析、52 周热力图与账单、1×1 PNG 图片上传与下载回读、SSE 流式接口、静态资源零 CDN 校验）：

```bash
npm test
# 或直接执行
node --test test/smoke.test.js
```

### 安全使用建议
1. **公网暴露必设密码**：任何穿透到公网的部署都务必设置高强度 `AGY_AUTH_PASSWORD`，并优先配合 HTTPS + Zero Trust Access / BasicAuth。
2. **慎用 `--dangerously-skip-permissions`**：该开关允许模型在未人工二次确认的情况下执行工作区命令/修改文件，建议仅在受控隔离项目中使用。
3. **定期检查登录态**：若发现诊断徽章提示认证错误，在 Ubuntu 终端重新执行 `agy auth login`（或在控制台一键切换账号）即可立即恢复配额与调用能力。

---

## 八、鸣谢与致敬

本项目在设计与实现过程中参考了以下优秀开源项目的思路与代码实现，特此诚挚致谢：

- **[antigravity-context-viewer](https://github.com/elviscjn-cjn/antigravity-context-viewer)**：参考了上下文用量监控、Token 测算审计、52 周热力图统计及 256K 上下文门禁解锁等核心思路与实现。
- **[cockpit-tools](https://github.com/jlcodes99/cockpit-tools)**：参考了账号管理、多账号切换与相关工具链集成的思路与代码实现。
