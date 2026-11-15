#!/usr/bin/env bash
# ==============================================================================
# agy-remote-control Ubuntu 一键部署脚本
# 适用系统：Ubuntu 20.04 / 22.04 / 24.04 (兼容常见 Debian 系发行版)
# 功能：
#   1. 检测 Node.js >= 20 与 agy / agy-real 二进制路径
#   2. 检查 ~/.gemini/ 登录态与配额目录并给出保活建议
#   3. 交互或通过环境变量配置 PORT / AGY_AUTH_PASSWORD / DEFAULT_WORKSPACE
#   4. 生成并启用用户级 systemd --user 服务（推荐，无需 root 且直接继承原账号配额），
#      或在无 user systemd 环境时输出系统级 unit 与手动启动指引
# ==============================================================================

set -euo pipefail

# 颜色输出辅助函数（仅在终端支持时启用颜色）
if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_BLUE='\033[1;34m'
  C_GREEN='\033[1;32m'
  C_YELLOW='\033[1;33m'
  C_RED='\033[1;31m'
  C_CYAN='\033[0;36m'
else
  C_RESET=''
  C_BLUE=''
  C_GREEN=''
  C_YELLOW=''
  C_RED=''
  C_CYAN=''
fi

log_info()  { echo -e "${C_BLUE}[信息]${C_RESET} $*"; }
log_ok()    { echo -e "${C_GREEN}[成功]${C_RESET} $*"; }
log_warn()  { echo -e "${C_YELLOW}[警告]${C_RESET} $*"; }
log_err()   { echo -e "${C_RED}[错误]${C_RESET} $*" >&2; }

# 定位脚本所在项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# 若脚本以 root 运行，发出强烈提醒（用户级 systemd 与 ~/.gemini 凭证应归属普通登录用户）
if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  log_warn "检测到当前以 root 身份运行。除非你的 agy 账号就是登录在 /root/.gemini 下，"
  log_warn "否则强烈建议使用持有 ~/.gemini/ 凭证的普通用户执行本脚本，以继承原有订阅配额！"
fi

echo -e "${C_CYAN}================================================================${C_RESET}"
echo -e "${C_CYAN}       AGY Remote Control - Ubuntu 一键部署向导${C_RESET}"
echo -e "${C_CYAN}================================================================${C_RESET}"
echo "项目路径: ${APP_DIR}"
echo ""

# ------------------------------------------------------------------------------
# 1. 检测操作系统
# ------------------------------------------------------------------------------
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  source /etc/os-release
  log_info "当前系统: ${PRETTY_NAME:-Unknown}"
  if [[ "${ID:-}" != "ubuntu" ]]; then
    log_warn "检测到非 Ubuntu 系统 (${ID:-unknown})，脚本仍会继续尝试按 systemd 标准流程部署。"
  elif [[ "${VERSION_ID:-}" != "20.04" && "${VERSION_ID:-}" != "22.04" && "${VERSION_ID:-}" != "24.04" ]]; then
    log_warn "检测到 Ubuntu ${VERSION_ID:-unknown}（推荐 20.04 / 22.04 / 24.04），将按兼容模式继续。"
  fi
else
  log_warn "未找到 /etc/os-release，跳过发行版版本校验。"
fi

# ------------------------------------------------------------------------------
# 2. 检测 Node.js >= 20（自动兼容 nvm / fnm / volta 等常见安装方式）
# ------------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  # 尝试加载常见的用户级 Node 版本管理器
  if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
    # shellcheck disable=SC1091
    source "${HOME}/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
  if [[ -d "${HOME}/.local/share/fnm" ]]; then
    export PATH="${HOME}/.local/share/fnm:${PATH}"
  fi
  if [[ -d "${HOME}/.volta/bin" ]]; then
    export PATH="${HOME}/.volta/bin:${PATH}"
  fi
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
  log_err "未检测到 Node.js！本项目要求 Node.js >= 20.0.0（零外部 npm 依赖）。"
  echo "请先执行以下命令在 Ubuntu 上安装 Node.js 20 LTS："
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi

NODE_VERSION_RAW="$("${NODE_BIN}" -v)"
NODE_MAJOR="${NODE_VERSION_RAW#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"

if ! [[ "${NODE_MAJOR}" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 20 )); then
  log_err "当前 Node.js 版本为 ${NODE_VERSION_RAW} (${NODE_BIN})，低于最低要求 v20.0.0。"
  echo "请升级到 Node.js 20+ 后重新运行本脚本，例如："
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi
log_ok "Node.js 检测通过: ${NODE_VERSION_RAW} (${NODE_BIN})"

# 校验核心入口文件是否存在
if [[ ! -f "${APP_DIR}/server.js" ]]; then
  log_err "未在 ${APP_DIR} 中找到 server.js，请确认在完整的项目目录中执行。"
  exit 1
fi

# ------------------------------------------------------------------------------
# 3. 探测 agy / agy-real 二进制路径并检查登录态
# ------------------------------------------------------------------------------
detect_agy_binary() {
  local candidates=()
  if [[ -n "${AGY_BIN:-}" ]]; then
    candidates+=("${AGY_BIN}")
  fi
  candidates+=(
    "${HOME}/.gemini/antigravity/bin/agy"
    "${HOME}/.local/bin/agy"
    "/usr/local/bin/agy"
  )

  for p in "${candidates[@]}"; do
    if [[ -n "${p}" && -x "${p}" && ! -d "${p}" ]]; then
      echo "${p}"
      return 0
    fi
  done

  local from_path=""
  from_path="$(command -v agy 2>/dev/null || true)"
  if [[ -n "${from_path}" && -x "${from_path}" ]]; then
    echo "${from_path}"
    return 0
  fi

  from_path="$(command -v agy-real 2>/dev/null || true)"
  if [[ -n "${from_path}" && -x "${from_path}" ]]; then
    echo "${from_path}"
    return 0
  fi

  return 1
}

DETECTED_AGY_BIN="$(detect_agy_binary || true)"
if [[ -n "${DETECTED_AGY_BIN}" ]]; then
  log_ok "已探测到 agy 可执行文件: ${DETECTED_AGY_BIN}"
  # 简单校验输出，提示避免与其他同名命令冲突
  if "${DETECTED_AGY_BIN}" --help >/dev/null 2>&1; then
    log_info "agy --help 执行正常，已就绪。"
  else
    log_warn "执行 ${DETECTED_AGY_BIN} --help 返回非零状态，请确认其为 Antigravity CLI。"
  fi
else
  log_warn "未自动检测到 agy 或 agy-real 可执行文件。"
  log_warn "服务仍可启动（将处于演示/离线审计模式），但真实 AI 对话需要宿主机安装并登录 agy CLI。"
  echo "  安装完成后可通过环境变量 AGY_BIN=/你的/agy/路径 指定，或软链到 ~/.local/bin/agy。"
fi

# 检查 ~/.gemini 登录态目录与保活提示
AG_DIR_DEFAULT="${AG_DIR:-${HOME}/.gemini/antigravity}"
AG_CLI_DIR_DEFAULT="${AG_CLI_DIR:-${HOME}/.gemini/antigravity-cli}"

echo ""
log_info "检查 Antigravity 登录态与历史会话目录..."
if [[ -d "${HOME}/.gemini" ]]; then
  log_ok "发现凭证根目录: ${HOME}/.gemini"
  [[ -d "${AG_DIR_DEFAULT}" ]] && log_info "  - 桌面端目录: ${AG_DIR_DEFAULT}"
  [[ -d "${AG_CLI_DIR_DEFAULT}" ]] && log_info "  - CLI 目录:   ${AG_CLI_DIR_DEFAULT}"
else
  log_warn "尚未发现 ${HOME}/.gemini 目录！"
fi
echo -e "${C_YELLOW}  [保持登录态与配额提示]${C_RESET}"
echo "  1. 本项目 100% 复用宿主机当前用户 ~/.gemini/ 下的原账号凭证与订阅配额；"
echo "  2. 如尚未登录或凭证过期，请先在当前用户终端执行一次 \`agy\` 或 \`agy auth login\` 完成登录；"
echo "  3. 使用下方推荐的【用户级 systemd --user】并以当前用户运行，即可稳定保持登录态与配额；"
echo "  4. 请务必执行 \`sudo loginctl enable-linger ${USER:-$(id -un)}\`，防止退出 SSH 后后台服务被系统回收。"
echo ""

# ------------------------------------------------------------------------------
# 4. 读取或交互配置服务参数
# ------------------------------------------------------------------------------
IS_TTY=0
if [[ -t 0 ]]; then
  IS_TTY=1
fi

DEFAULT_HOST="${HOST:-0.0.0.0}"
DEFAULT_PORT="${PORT:-8787}"
DEFAULT_WS="${DEFAULT_WORKSPACE:-${HOME}}"
CFG_PASSWORD="${AGY_AUTH_PASSWORD:-}"
SERVICE_MODE="${SERVICE_MODE:-}"

if (( IS_TTY == 1 )); then
  read -r -p "监听地址 HOST [默认 ${DEFAULT_HOST}，局域网穿透保持 0.0.0.0]: " INPUT_HOST
  HOST="${INPUT_HOST:-${DEFAULT_HOST}}"

  while true; do
    read -r -p "监听端口 PORT [默认 ${DEFAULT_PORT}]: " INPUT_PORT
    PORT="${INPUT_PORT:-${DEFAULT_PORT}}"
    if [[ "${PORT}" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )); then
      break
    fi
    log_warn "端口号无效，请输入 1 ~ 65535 之间的整数。"
  done

  if [[ -z "${CFG_PASSWORD}" ]]; then
    echo ""
    log_warn "安全提示：穿透到公网或公司访问时，强烈建议设置 AGY_AUTH_PASSWORD 访问密码！"
    read -r -s -p "设置 Web 访问密码 AGY_AUTH_PASSWORD (输入时隐藏；直接回车可随机生成或留空): " INPUT_PASS
    echo ""
    if [[ -n "${INPUT_PASS}" ]]; then
      CFG_PASSWORD="${INPUT_PASS}"
    else
      read -r -p "是否自动生成 24 位高强度随机密码? [Y/n]: " GEN_RAND
      if [[ -z "${GEN_RAND}" || "${GEN_RAND}" =~ ^[Yy]$ ]]; then
        if command -v openssl >/dev/null 2>&1; then
          CFG_PASSWORD="$(openssl rand -base64 18 | tr -d '/+=' | head -c 24)"
        else
          CFG_PASSWORD="$("${NODE_BIN}" -e "console.log(require('crypto').randomBytes(18).toString('base64url').slice(0,24))")"
        fi
        log_ok "已为您生成随机访问密码（请务必妥善保存）: ${C_GREEN}${CFG_PASSWORD}${C_RESET}"
      else
        log_warn "已选择不设置 AGY_AUTH_PASSWORD！请务必在前置网关（如 Cloudflare Access 或 Lucky BasicAuth）启用认证。"
      fi
    fi
  else
    log_info "将使用环境变量传入的 AGY_AUTH_PASSWORD。"
  fi

  read -r -p "默认工作区路径 DEFAULT_WORKSPACE [默认 ${DEFAULT_WS}]: " INPUT_WS
  DEFAULT_WORKSPACE="${INPUT_WS:-${DEFAULT_WS}}"

  if [[ -z "${SERVICE_MODE}" ]]; then
    echo ""
    echo "请选择部署方式："
    echo "  [1] 生成并启用用户级 systemd --user 服务（推荐：无需 root，直接继承 ~/.gemini 配额）"
    echo "  [2] 仅生成环境配置文件，并输出系统级 (/etc/systemd/system) 安装命令提示"
    echo "  [3] 仅生成环境配置文件，稍后手动启动"
    read -r -p "请输入选项 [1/2/3，默认 1]: " CHOICE_MODE
    case "${CHOICE_MODE:-1}" in
      1) SERVICE_MODE="user" ;;
      2) SERVICE_MODE="system-hint" ;;
      3) SERVICE_MODE="skip" ;;
      *) SERVICE_MODE="user" ;;
    esac
  fi
else
  HOST="${DEFAULT_HOST}"
  PORT="${DEFAULT_PORT}"
  DEFAULT_WORKSPACE="${DEFAULT_WS}"
  SERVICE_MODE="${SERVICE_MODE:-user}"
  if ! [[ "${PORT}" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
    log_err "环境变量 PORT=${PORT} 无效，必须为 1 ~ 65535 整数。"
    exit 1
  fi
  if [[ -z "${CFG_PASSWORD}" ]]; then
    log_warn "未设置 AGY_AUTH_PASSWORD（非交互模式），如暴露公网请确保网关层已配置鉴权。"
  fi
fi

# 规范化默认工作区路径（若不存在给出提醒或创建）
if [[ ! -d "${DEFAULT_WORKSPACE}" ]]; then
  if (( IS_TTY == 1 )); then
    read -r -p "目录 ${DEFAULT_WORKSPACE} 不存在，是否自动创建? [y/N]: " MK_WS
    if [[ "${MK_WS}" =~ ^[Yy]$ ]]; then
      mkdir -p "${DEFAULT_WORKSPACE}"
      log_ok "已创建工作区目录: ${DEFAULT_WORKSPACE}"
    else
      log_warn "将保留路径 ${DEFAULT_WORKSPACE}（可在网页左侧随时切换其他工作区）。"
    fi
  else
    log_warn "工作区目录 ${DEFAULT_WORKSPACE} 当前不存在，将在配置中保留该路径。"
  fi
fi

# ------------------------------------------------------------------------------
# 5. 写入环境变量配置文件 (~/.config/agy-remote/env，权限 600)
# ------------------------------------------------------------------------------
CONFIG_DIR="${HOME}/.config/agy-remote"
ENV_FILE="${CONFIG_DIR}/env"
mkdir -p "${CONFIG_DIR}"

# 构造服务运行所需 PATH，确保涵盖 Node 所在目录、~/.gemini/antigravity/bin 与 ~/.local/bin
NODE_DIR="$(dirname "${NODE_BIN}")"
RUNTIME_PATH="${HOME}/.gemini/antigravity/bin:${HOME}/.local/bin:${NODE_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# 校验值中不含换行符以防注入
sanitize_env_val() {
  printf '%s' "$1" | tr -d '\r\n'
}

HOST_CLEAN="$(sanitize_env_val "${HOST}")"
PORT_CLEAN="$(sanitize_env_val "${PORT}")"
PASS_CLEAN="$(sanitize_env_val "${CFG_PASSWORD}")"
WS_CLEAN="$(sanitize_env_val "${DEFAULT_WORKSPACE}")"
AGY_CLEAN="$(sanitize_env_val "${DETECTED_AGY_BIN}")"

umask 077
{
  echo "# agy-remote-control 运行环境变量（由 install-ubuntu.sh 自动生成）"
  echo "NODE_ENV=production"
  echo "HOST=${HOST_CLEAN}"
  echo "PORT=${PORT_CLEAN}"
  echo "DEFAULT_WORKSPACE=${WS_CLEAN}"
  if [[ -n "${PASS_CLEAN}" ]]; then
    if [[ "${PASS_CLEAN}" != *"'"* && "${PASS_CLEAN}" != *"\\"* ]]; then
      echo "AGY_AUTH_PASSWORD='${PASS_CLEAN}'"
    else
      # 含单引号或反斜杠时直接按字面量写入，适配 systemd EnvironmentFile 解析
      echo "AGY_AUTH_PASSWORD=${PASS_CLEAN}"
    fi
  else
    echo "# AGY_AUTH_PASSWORD="
  fi
  if [[ -n "${AGY_CLEAN}" ]]; then
    echo "AGY_BIN=${AGY_CLEAN}"
  fi
  echo "PATH=${RUNTIME_PATH}"
} > "${ENV_FILE}"
chmod 600 "${ENV_FILE}"
log_ok "已生成私密环境配置: ${ENV_FILE} (权限 600)"

# ------------------------------------------------------------------------------
# 6. 输出系统级 unit 提示函数
# ------------------------------------------------------------------------------
print_system_unit_guide() {
  local current_user="${USER:-$(id -un)}"
  local current_group
  current_group="$(id -gn)"
  echo ""
  echo -e "${C_CYAN}---------------- 系统级 systemd (/etc/systemd/system) 安装指南 ----------------${C_RESET}"
  echo "如果你更倾向于系统级服务，请执行以下命令（注意通过 User=${current_user} 保留 ~/.gemini 配额）："
  cat <<EOF

sudo tee /etc/systemd/system/agy-remote.service >/dev/null <<'UNIT'
[Unit]
Description=AGY Remote Control 私有控制台
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${current_user}
Group=${current_group}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now agy-remote.service
sudo systemctl status agy-remote.service --no-pager

EOF
  echo -e "${C_CYAN}-------------------------------------------------------------------------------${C_RESET}"
}

# ------------------------------------------------------------------------------
# 7. 部署并启动用户级 systemd --user 服务
# ------------------------------------------------------------------------------
SERVICE_STARTED=0

if [[ "${SERVICE_MODE}" == "user" ]]; then
  USER_SYSTEMD_DIR="${HOME}/.config/systemd/user"
  USER_UNIT_FILE="${USER_SYSTEMD_DIR}/agy-remote.service"
  mkdir -p "${USER_SYSTEMD_DIR}"

  cat > "${USER_UNIT_FILE}" <<EOF
[Unit]
Description=AGY Remote Control 私有控制台与上下文看板 (User Service)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
Restart=always
RestartSec=3
StartLimitIntervalSec=60
StartLimitBurst=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
EOF

  log_ok "已写入用户级服务单元: ${USER_UNIT_FILE}"

  # 自动补全 XDG_RUNTIME_DIR（SSH 或 su 切换用户时可能缺失）
  if [[ -z "${XDG_RUNTIME_DIR:-}" ]]; then
    RUNTIME_CANDIDATE="/run/user/$(id -u)"
    if [[ -d "${RUNTIME_CANDIDATE}" ]]; then
      export XDG_RUNTIME_DIR="${RUNTIME_CANDIDATE}"
    fi
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1; then
    if systemctl --user enable --now agy-remote.service; then
      SERVICE_STARTED=1
      log_ok "用户级服务 agy-remote.service 已启用并启动！"

      # 尝试开启 linger 保证无桌面会话或断开 SSH 后持续保活
      if command -v loginctl >/dev/null 2>&1; then
        CURRENT_USER_NAME="${USER:-$(id -un)}"
        if loginctl show-user "${CURRENT_USER_NAME}" -p Linger 2>/dev/null | grep -q "Linger=yes"; then
          log_ok "loginctl linger 已开启，服务将在退出 SSH / 重启后自动常驻。"
        elif loginctl enable-linger "${CURRENT_USER_NAME}" >/dev/null 2>&1; then
          log_ok "已自动为 ${CURRENT_USER_NAME} 开启 loginctl enable-linger。"
        else
          log_warn "未能无密码自动开启 linger，请手动执行一次以防退出 SSH 后服务停止："
          echo "  sudo loginctl enable-linger ${CURRENT_USER_NAME}"
        fi
      fi
    else
      log_warn "systemctl --user enable --now 失败，请检查用户级 systemd 会话。"
      print_system_unit_guide
    fi
  else
    log_warn "当前环境未能连接到用户级 systemd 总线（常见于容器、未开启 systemd 的 WSL 或未配置 DBUS 的 SSH 会话）。"
    echo "若在标准 Ubuntu 主机上启用 user systemd，请先执行："
    echo "  sudo loginctl enable-linger ${USER:-$(id -un)}"
    echo "  export XDG_RUNTIME_DIR=\"/run/user/\$(id -u)\""
    echo "  systemctl --user daemon-reload && systemctl --user enable --now agy-remote.service"
    print_system_unit_guide
  fi
elif [[ "${SERVICE_MODE}" == "system-hint" ]]; then
  print_system_unit_guide
else
  log_info "已跳过 systemd 服务注册，你可随时手动启动。"
fi

# ------------------------------------------------------------------------------
# 8. 输出部署摘要与常用运维命令
# ------------------------------------------------------------------------------
echo ""
echo -e "${C_GREEN}==================== 部署配置完成 ====================${C_RESET}"
echo "监听地址:   http://${HOST_CLEAN}:${PORT_CLEAN}"
echo "默认工作区: ${WS_CLEAN}"
echo "配置文件:   ${ENV_FILE}"
if [[ -n "${PASS_CLEAN}" ]]; then
  echo "访问鉴权:   已启用 AGY_AUTH_PASSWORD"
else
  echo "访问鉴权:   未设置密码（务必做好内网/网关层隔离）"
fi
echo ""

if (( SERVICE_STARTED == 1 )); then
  echo "常用管理命令："
  echo "  查看状态:   systemctl --user status agy-remote.service"
  echo "  实时日志:   journalctl --user -u agy-remote.service -f"
  echo "  重启服务:   systemctl --user restart agy-remote.service"
  echo "  健康检查:   curl -s http://127.0.0.1:${PORT_CLEAN}/api/health"
else
  echo "手动启动命令（加载刚刚生成的环境变量）："
  echo "  cd \"${APP_DIR}\" && set -a && source \"${ENV_FILE}\" && set +a && \"${NODE_BIN}\" server.js"
  echo ""
  echo "健康检查："
  echo "  curl -s http://127.0.0.1:${PORT_CLEAN}/api/health"
fi
echo -e "${C_GREEN}======================================================${C_RESET}"
