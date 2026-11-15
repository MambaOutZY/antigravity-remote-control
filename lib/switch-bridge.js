'use strict';

/**
 * Antigravity 账号切换与 CLI 代理配置桥接模块（零外部 npm 依赖）
 * 对接：
 *   - /home/antigravity-switch/account/*.json 与 switch-agy.py
 *   - ~/.gemini/antigravity-cli/antigravity-oauth-token
 *   - ~/.gemini/jetski-standalone-oauth-token
 *   - ~/.local/bin/agy 包装脚本
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');

// Google Antigravity OAuth 刷新参数（优先使用环境变量，或从宿主机 switch-agy.py 动态提取）
const CLIENT_ID = process.env.AGY_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.AGY_OAUTH_CLIENT_SECRET || '';
const DEFAULT_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DEFAULT_PROXY_TEST_TARGET = 'oauth2.googleapis.com:443';

const PROXY_ENV_KEYS = Object.freeze([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy'
]);

const ALLOWED_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

// 内存态运行时代理配置（按 wrapperPath 隔离，避免单元测试互相污染）
const runtimeProxyByWrapper = new Map();

/**
 * 创建带 HTTP 状态码的业务错误
 */
function createHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

/**
 * 解析并归一化所有外部路径（全面支持 opts 与环境变量覆盖，方便跨平台测试）
 */
function resolvePaths(opts = {}) {
  const homeDir = opts.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const switchDir = path.resolve(opts.switchDir || process.env.AGY_SWITCH_DIR || '/home/antigravity-switch');
  const accountsDir = path.resolve(opts.accountsDir || path.join(switchDir, 'account'));
  const switchPyPath = path.resolve(opts.switchPyPath || path.join(switchDir, 'switch-agy.py'));
  const cliTokenFile = path.resolve(
    opts.cliTokenFile || process.env.AGY_CLI_TOKEN_FILE || path.join(homeDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')
  );
  const fallbackTokenFile = path.resolve(
    opts.fallbackTokenFile || process.env.AGY_FALLBACK_TOKEN_FILE || path.join(homeDir, '.gemini', 'jetski-standalone-oauth-token')
  );
  const hasWrapperOverride = Boolean(opts.wrapperPath || process.env.AGY_WRAPPER_PATH);
  const wrapperPath = path.resolve(
    opts.wrapperPath || process.env.AGY_WRAPPER_PATH || path.join(homeDir, '.local', 'bin', 'agy')
  );
  // 若测试显式覆盖了 wrapperPath 而未提供 runtimeProxyFile，则不读写宿主默认 ~/.config/agy-remote
  const runtimeProxyFile = (opts.runtimeProxyFile || process.env.AGY_PROXY_CONFIG_FILE)
    ? path.resolve(opts.runtimeProxyFile || process.env.AGY_PROXY_CONFIG_FILE)
    : (hasWrapperOverride ? null : path.resolve(homeDir, '.config', 'agy-remote', 'proxy-config.json'));

  return {
    homeDir,
    switchDir,
    accountsDir,
    switchPyPath,
    cliTokenFile,
    fallbackTokenFile,
    wrapperPath,
    runtimeProxyFile
  };
}

function getTokenEndpoint(opts = {}) {
  return String(opts.tokenEndpoint || process.env.AGY_OAUTH_TOKEN_ENDPOINT || DEFAULT_TOKEN_ENDPOINT).trim();
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    // 兼容 Windows/工具导出的 UTF-8 BOM JSON 文件（剥离前导 \uFEFF）
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw || !raw.trim()) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 原子写入文件内容，并尽量收紧权限（默认 0o600）
 */
function atomicWriteFile(filePath, content, mode = 0o600) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode });
    try {
      fs.chmodSync(tmpPath, mode);
    } catch {
      // Windows 不完全支持 POSIX chmod，忽略即可
    }
    fs.renameSync(tmpPath, filePath);
    try {
      fs.chmodSync(filePath, mode);
    } catch {
      // 忽略平台权限位差异
    }
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 清理临时文件失败忽略
    }
    throw err;
  }
}

/**
 * 仅解析 JWT 载荷（不验签），用于兜底提取 id_token 中的邮箱字段
 */
function decodeJwtPayload(jwtToken) {
  if (!jwtToken || typeof jwtToken !== 'string') return null;
  const parts = jwtToken.split('.');
  if (parts.length < 2) return null;
  try {
    const rawJson = Buffer.from(parts[1], 'base64url').toString('utf8');
    const obj = JSON.parse(rawJson);
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    return null;
  }
}

function extractEmailFromFileName(fileName) {
  const base = String(fileName || '')
    .replace(/\.json$/i, '')
    .replace(/^antigravity-/i, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .trim();
  return base.includes('@') ? base : '';
}

function extractEmailFromAccountData(data, fileName = '') {
  if (!data || typeof data !== 'object') return extractEmailFromFileName(fileName);
  const tokenObj = (data.token && typeof data.token === 'object') ? data.token : {};
  const idToken = data.id_token || tokenObj.id_token || '';
  const jwtPayload = decodeJwtPayload(idToken);
  return String(
    data.email ||
    data.id_token_email ||
    data.user_email ||
    tokenObj.email ||
    jwtPayload?.email ||
    extractEmailFromFileName(fileName) ||
    ''
  ).trim();
}

/**
 * 解析 token 过期时间戳及剩余秒数
 */
function parseExpiryInfo(expiryRaw, expiresInRaw, fallbackBaseMs = null) {
  let expiryMs = null;
  if (typeof expiryRaw === 'number' && Number.isFinite(expiryRaw) && expiryRaw > 0) {
    expiryMs = expiryRaw < 1e12 ? expiryRaw * 1000 : expiryRaw;
  } else if (typeof expiryRaw === 'string' && expiryRaw.trim()) {
    const asNum = Number(expiryRaw.trim());
    if (Number.isFinite(asNum) && asNum > 0) {
      expiryMs = asNum < 1e12 ? asNum * 1000 : asNum;
    } else {
      const parsed = Date.parse(expiryRaw.trim());
      if (Number.isFinite(parsed) && parsed > 0) expiryMs = parsed;
    }
  }

  if (expiryMs === null && fallbackBaseMs && Number.isFinite(Number(expiresInRaw)) && Number(expiresInRaw) > 0) {
    expiryMs = fallbackBaseMs + Number(expiresInRaw) * 1000;
  }

  if (expiryMs === null) {
    return { tokenExpiry: null, tokenExpiresInSec: null, tokenExpired: null };
  }

  const remainingSec = Math.floor((expiryMs - Date.now()) / 1000);
  return {
    tokenExpiry: new Date(expiryMs).toISOString(),
    tokenExpiresInSec: remainingSec,
    tokenExpired: remainingSec <= 0
  };
}

/**
 * 读取当前 CLI token 状态（脱敏，绝不返回 access_token / refresh_token）
 */
function readCurrentCliTokenStatus(cliTokenFile) {
  const raw = safeReadJson(cliTokenFile);
  if (!raw) {
    return {
      exists: false,
      activeEmail: null,
      tokenExpiry: null,
      tokenExpiresInSec: null,
      tokenExpired: null
    };
  }

  let mtimeMs = null;
  try {
    mtimeMs = fs.statSync(cliTokenFile).mtimeMs;
  } catch {
    mtimeMs = null;
  }

  const tokenObj = (raw.token && typeof raw.token === 'object') ? raw.token : raw;
  const activeEmail = extractEmailFromAccountData(raw) || null;
  const exp = parseExpiryInfo(
    tokenObj.expiry ?? raw.expiry,
    tokenObj.expires_in ?? raw.expires_in,
    mtimeMs
  );

  return {
    exists: true,
    activeEmail,
    ...exp
  };
}

/**
 * 扫描 account/*.json（忽略非 json），返回脱敏后的账号列表与当前生效状态
 */
function listAccounts(opts = {}) {
  const paths = resolvePaths(opts);
  const current = readCurrentCliTokenStatus(paths.cliTokenFile);
  const accounts = [];
  const accountsDirExists = fs.existsSync(paths.accountsDir);

  if (accountsDirExists) {
    let entries = [];
    try {
      entries = fs.readdirSync(paths.accountsDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    for (const entry of entries) {
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(paths.accountsDir, entry.name);
      let stat = null;
      try {
        stat = fs.statSync(fullPath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }

      const data = safeReadJson(fullPath);
      if (!data) continue;

      const tokenObj = (data.token && typeof data.token === 'object') ? data.token : data;
      const email = extractEmailFromAccountData(data, entry.name);
      const projectId = String(
        data.project_id || data.projectId || data.cloudaicompanion_project || ''
      ).trim();
      const refreshToken = tokenObj.refresh_token || data.refresh_token || '';
      const hasRefreshToken = Boolean(typeof refreshToken === 'string' && refreshToken.trim());
      const active = Boolean(
        current.activeEmail &&
        email &&
        email.toLowerCase() === current.activeEmail.toLowerCase()
      );

      // 严格只输出安全元信息，绝不泄露 refresh_token / access_token / id_token
      accounts.push({
        fileName: entry.name,
        email,
        projectId,
        hasRefreshToken,
        active,
        updatedAt: new Date(stat.mtimeMs).toISOString()
      });
    }
  }

  accounts.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return (a.email || a.fileName).localeCompare(b.email || b.fileName);
  });

  return {
    ok: true,
    switchDir: paths.switchDir,
    accountsDir: paths.accountsDir,
    accountsDirExists,
    cliTokenFile: paths.cliTokenFile,
    activeEmail: current.activeEmail,
    tokenExpiry: current.tokenExpiry,
    tokenExpiresInSec: current.tokenExpiresInSec,
    tokenExpired: current.tokenExpired,
    accounts
  };
}

/**
 * 严格校验账号文件名，拦截路径穿越（../、/、\、空字节、URL 编码穿越、符号链接逃逸等）
 */
function validateAccountFileName(fileName, accountsDir) {
  if (typeof fileName !== 'string' || !fileName.trim()) {
    throw createHttpError(400, '请提供有效的账号文件名 (fileName)');
  }

  const trimmed = fileName.trim();
  if (
    trimmed.startsWith('.') ||
    trimmed.includes('..') ||
    /[\\/\0]/.test(trimmed) ||
    /%2e|%2f|%5c/i.test(trimmed) ||
    path.basename(trimmed) !== trimmed ||
    !trimmed.toLowerCase().endsWith('.json')
  ) {
    throw createHttpError(400, '非法的账号文件名格式（禁止路径穿越字符）');
  }

  const resolvedDir = path.resolve(accountsDir);
  const resolvedTarget = path.resolve(resolvedDir, trimmed);
  if (resolvedTarget !== path.join(resolvedDir, trimmed) || !resolvedTarget.startsWith(resolvedDir + path.sep)) {
    throw createHttpError(400, '非法的账号文件路径');
  }

  if (!fs.existsSync(resolvedTarget)) {
    throw createHttpError(404, `未找到账号文件: ${trimmed}`);
  }

  const lstat = fs.lstatSync(resolvedTarget);
  if (lstat.isSymbolicLink()) {
    const realDir = fs.realpathSync(resolvedDir);
    const realTarget = fs.realpathSync(resolvedTarget);
    if (!realTarget.startsWith(realDir + path.sep)) {
      throw createHttpError(400, '账号文件符号链接越界，已拒绝访问');
    }
  } else if (!lstat.isFile()) {
    throw createHttpError(400, '目标账号路径不是有效文件');
  }

  return resolvedTarget;
}

// ============================================================================
// 代理配置校验、wrapper 解析/写入与运行时代理状态管理
// ============================================================================

/**
 * 严格校验代理 URL 格式并阻断一切 shell 注入与换行符
 */
function validateProxyUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return { ok: false, error: '代理地址不能为空' };
  }
  const trimmed = rawUrl.trim();
  // 拦截换行、控制字符、空白符及引号/$()/反引号/管道/分号等 shell 元字符
  if (/[\x00-\x1f\x7f\s"'`$\\;|&<>(){}]/.test(trimmed)) {
    return { ok: false, error: '代理地址包含非法控制字符、空白或潜在注入字符' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: '代理地址 URL 格式无效' };
  }

  if (!ALLOWED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: '仅支持 http://、https:// 或 socks5:// 协议的代理地址' };
  }
  if (!parsed.hostname) {
    return { ok: false, error: '代理地址缺少主机名或 IP' };
  }
  if (parsed.port) {
    const portNum = Number(parsed.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, error: '代理端口号必须为 1 ~ 65535 的整数' };
    }
  }
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return { ok: false, error: '代理地址不应包含路径参数、查询串或锚点' };
  }

  return { ok: true, proxyUrl: trimmed, parsed };
}

function getDefaultPortForProtocol(protocol) {
  if (protocol === 'https:') return 443;
  if (protocol === 'socks5:') return 1080;
  return 80;
}

/**
 * 从 ~/.local/bin/agy 包装脚本提取代理环境变量
 */
function parseWrapperScript(content) {
  const lines = String(content || '').split(/\r?\n/);
  const envVars = {};
  let hasUnsetProxy = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (/^unset\s+.*\bHTTP_PROXY\b/.test(trimmed)) {
      hasUnsetProxy = true;
      continue;
    }
    const m = trimmed.match(/^(?:export\s+)?(HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|ALL_PROXY|all_proxy)\s*=\s*(.+)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    envVars[key] = val;
  }

  const primaryUrl =
    envVars.HTTPS_PROXY ||
    envVars.HTTP_PROXY ||
    envVars.https_proxy ||
    envVars.http_proxy ||
    envVars.ALL_PROXY ||
    envVars.all_proxy ||
    '';

  return {
    envVars,
    enabled: Boolean(primaryUrl),
    proxyUrl: primaryUrl,
    hasUnsetProxy
  };
}

/**
 * 从 switch-agy.py 中读取 PROXY_URL 配置值
 */
function parseSwitchPyProxyUrl(switchPyPath) {
  try {
    if (!fs.existsSync(switchPyPath)) return { exists: false, proxyUrl: '' };
    const text = fs.readFileSync(switchPyPath, 'utf8');
    const m = text.match(/^\s*PROXY_URL\s*=\s*(?:["']([^"']*)["']|None)\s*(?:#.*)?$/m);
    return {
      exists: true,
      proxyUrl: m && m[1] ? m[1].trim() : ''
    };
  } catch {
    return { exists: false, proxyUrl: '' };
  }
}

/**
 * 从 switch-agy.py 中动态解析 CLIENT_ID 与 CLIENT_SECRET（多候选路径容错）
 */
function parseSwitchPyCredentials(switchPyPath) {
  const home = process.env.HOME || os.homedir();
  const candidates = [
    switchPyPath,
    '/home/antigravity-switch/switch-agy.py',
    path.join(home, 'antigravity-switch', 'switch-agy.py'),
    path.join(home, 'switch-agy.py')
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      const idMatch = text.match(/^\s*CLIENT_ID\s*=\s*["']([^"']+)["']/m);
      const secretMatch = text.match(/^\s*CLIENT_SECRET\s*=\s*["']([^"']+)["']/m);
      if (idMatch || secretMatch) {
        return {
          clientId: idMatch ? idMatch[1].trim() : '',
          clientSecret: secretMatch ? secretMatch[1].trim() : ''
        };
      }
    } catch {
      // 忽略单个候选路径读取异常
    }
  }
  return null;
}

function loadRuntimeProxyState(paths) {
  const mem = runtimeProxyByWrapper.get(paths.wrapperPath);
  if (mem) return mem;
  if (paths.runtimeProxyFile) {
    const disk = safeReadJson(paths.runtimeProxyFile);
    if (disk && typeof disk.enabled === 'boolean') {
      return {
        managed: true,
        enabled: disk.enabled,
        proxyUrl: String(disk.proxyUrl || ''),
        lastProxyUrl: String(disk.lastProxyUrl || disk.proxyUrl || '')
      };
    }
  }
  return null;
}

/**
 * 获取当前代理配置（优先从 agy wrapper 读取，并结合运行时状态）
 */
function getProxyConfig(opts = {}) {
  const paths = resolvePaths(opts);
  const wrapperExists = fs.existsSync(paths.wrapperPath);
  const pyInfo = parseSwitchPyProxyUrl(paths.switchPyPath);
  const runtimeState = loadRuntimeProxyState(paths);

  let enabled = false;
  let proxyUrl = '';
  let envVars = {};
  let managed = false;

  if (wrapperExists) {
    managed = true;
    try {
      const content = fs.readFileSync(paths.wrapperPath, 'utf8');
      const parsedWrapper = parseWrapperScript(content);
      enabled = parsedWrapper.enabled;
      proxyUrl = parsedWrapper.proxyUrl;
      envVars = parsedWrapper.envVars;
    } catch {
      // 忽略读取异常
    }
  } else if (runtimeState) {
    managed = true;
    enabled = Boolean(runtimeState.enabled);
    proxyUrl = enabled ? (runtimeState.proxyUrl || '') : (runtimeState.lastProxyUrl || '');
  }

  // 若包装脚本中处于关闭状态，优先回填最近一次有效代理地址方便前端显示编辑
  if (!enabled && !proxyUrl) {
    proxyUrl = runtimeState?.lastProxyUrl || pyInfo.proxyUrl || '';
  }

  let parsedInfo = null;
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      parsedInfo = {
        protocol: u.protocol.replace(':', ''),
        host: u.hostname,
        port: u.port ? Number(u.port) : getDefaultPortForProtocol(u.protocol),
        hasAuth: Boolean(u.username || u.password),
        username: u.username ? decodeURIComponent(u.username) : ''
      };
    } catch {
      parsedInfo = null;
    }
  }

  return {
    ok: true,
    enabled,
    proxyUrl,
    managed,
    protocol: parsedInfo?.protocol || null,
    host: parsedInfo?.host || null,
    port: parsedInfo?.port || null,
    hasAuth: parsedInfo?.hasAuth || false,
    username: parsedInfo?.username || '',
    wrapperPath: paths.wrapperPath,
    wrapperExists,
    switchPyPath: paths.switchPyPath,
    switchPyExists: pyInfo.exists,
    switchPyProxyUrl: pyInfo.proxyUrl,
    envVars
  };
}

/**
 * 重建 ~/.local/bin/agy 包装脚本内容，保留 shebang、自定义非代理行与 exec ... agy-real "$@" 行
 */
function buildUpdatedWrapperContent(existingContent, enabled, proxyUrl, wrapperPath) {
  const rawLines = existingContent ? String(existingContent).split(/\r?\n/) : [];
  let shebang = '#!/bin/bash';
  let execLine = '';
  const keptLines = [];

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('#!') && shebang === '#!/bin/bash' && keptLines.length === 0) {
      shebang = trimmed;
      continue;
    }
    // 剥离旧的 6 个代理变量导出及 unset 行
    if (/^(?:export\s+)?(HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|ALL_PROXY|all_proxy)\s*=/.test(trimmed)) {
      continue;
    }
    if (/^unset\s+.*\bHTTP_PROXY\b/.test(trimmed)) {
      continue;
    }
    if (/^exec\s+/.test(trimmed)) {
      execLine = trimmed;
      continue;
    }
    keptLines.push(line);
  }

  if (!execLine) {
    const defaultReal = path.posix.join(path.posix.dirname(wrapperPath.replace(/\\/g, '/')), 'agy-real');
    execLine = `exec ${defaultReal} "$@"`;
  }

  const proxyLines = enabled
    ? PROXY_ENV_KEYS.map((k) => `export ${k}="${proxyUrl}"`)
    : [`unset ${PROXY_ENV_KEYS.join(' ')}`];

  return [shebang, ...keptLines, ...proxyLines, execLine, ''].join('\n');
}

/**
 * 同步更新 switch-agy.py 中的 PROXY_URL，若无写入权限则优雅降级不抛异常
 */
function syncSwitchPyProxy(switchPyPath, enabled, proxyUrl) {
  if (!fs.existsSync(switchPyPath)) {
    return { synced: false, message: '未找到 switch-agy.py，已跳过同步' };
  }

  try {
    const orig = fs.readFileSync(switchPyPath, 'utf8');
    const targetVal = enabled ? proxyUrl : '';
    const replacement = `PROXY_URL = "${targetVal}"`;
    const proxyLineRe = /^([ \t]*PROXY_URL\s*=\s*)(?:["'][^"']*["']|None)([ \t]*(?:#.*)?)$/m;

    let updated;
    if (proxyLineRe.test(orig)) {
      updated = orig.replace(proxyLineRe, (_, _prefix, suffix) => `${replacement}${suffix || ''}`);
    } else {
      updated = `${replacement}\n${orig}`;
    }

    fs.writeFileSync(switchPyPath, updated, 'utf8');
    return { synced: true, message: '已同步更新 switch-agy.py 中的 PROXY_URL' };
  } catch (err) {
    const isPerm = err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS');
    return {
      synced: false,
      message: isPerm
        ? 'switch-agy.py 无写入权限（需 root 或提权修改），已跳过同步'
        : `同步 switch-agy.py 失败: ${err.message}`
    };
  }
}

/**
 * 保存代理配置：严格校验防注入 -> 更新 ~/.local/bin/agy -> 可选同步 switch-agy.py -> 刷新运行时状态
 */
function saveProxyConfig(input = {}, opts = {}) {
  const paths = resolvePaths(opts);
  const enabled = Boolean(input.enabled);
  const rawUrl = typeof input.proxyUrl === 'string' ? input.proxyUrl.trim() : '';
  const syncSwitchPy = input.syncSwitchPy !== false;

  if (enabled) {
    const check = validateProxyUrl(rawUrl);
    if (!check.ok) throw createHttpError(400, check.error);
  } else if (rawUrl) {
    // 关闭状态下若同时提交了地址，仍做安全校验防止持久化恶意字符串
    const check = validateProxyUrl(rawUrl);
    if (!check.ok) throw createHttpError(400, check.error);
  }

  // 1. 更新 wrapper 脚本
  let wrapperSynced = false;
  let wrapperMessage = '';
  try {
    const existingContent = fs.existsSync(paths.wrapperPath)
      ? fs.readFileSync(paths.wrapperPath, 'utf8')
      : '';
    const nextContent = buildUpdatedWrapperContent(existingContent, enabled, rawUrl, paths.wrapperPath);
    let mode = 0o755;
    if (fs.existsSync(paths.wrapperPath)) {
      try {
        mode = fs.statSync(paths.wrapperPath).mode & 0o777 || 0o755;
      } catch {
        mode = 0o755;
      }
    }
    atomicWriteFile(paths.wrapperPath, nextContent, mode);
    wrapperSynced = true;
    wrapperMessage = enabled ? '已写入 CLI 包装脚本代理配置' : '已从 CLI 包装脚本关闭代理';
  } catch (err) {
    const isPerm = err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS');
    if (!isPerm) throw err;
    wrapperMessage = 'CLI 包装脚本无写入权限，仅更新了当前服务运行时代理配置';
  }

  // 2. 同步 switch-agy.py（无权限时不崩溃）
  let switchPySynced = false;
  let switchPyMessage = '已按设置跳过同步 switch-agy.py';
  if (syncSwitchPy) {
    const pyRes = syncSwitchPyProxy(paths.switchPyPath, enabled, rawUrl);
    switchPySynced = pyRes.synced;
    switchPyMessage = pyRes.message;
  }

  // 3. 更新内存及可选磁盘运行时配置，确保 agy 子进程立即生效
  const prevRuntime = loadRuntimeProxyState(paths);
  const lastProxyUrl = rawUrl || prevRuntime?.lastProxyUrl || '';
  const runtimeState = {
    managed: true,
    enabled,
    proxyUrl: enabled ? rawUrl : '',
    lastProxyUrl,
    updatedAt: new Date().toISOString()
  };
  runtimeProxyByWrapper.set(paths.wrapperPath, runtimeState);
  if (paths.runtimeProxyFile) {
    try {
      atomicWriteFile(paths.runtimeProxyFile, JSON.stringify(runtimeState, null, 2) + '\n', 0o600);
    } catch {
      // 运行时持久化非关键失败不阻断流程
    }
  }

  // 4. 清理模型列表缓存，确保下一次刷新模型走最新网络配置
  try {
    const agyRunner = require('./agy-runner');
    if (typeof agyRunner.clearModelsCache === 'function') {
      agyRunner.clearModelsCache();
    }
  } catch {
    // 忽略加载异常
  }

  const currentCfg = getProxyConfig(opts);
  return {
    ...currentCfg,
    ok: true,
    wrapperSynced,
    wrapperMessage,
    switchPySynced,
    switchPyMessage
  };
}

/**
 * 获取当前运行时代理配置，供 agy-runner 子进程继承或剥离环境变量
 */
function getRuntimeProxyEnv(opts = {}) {
  const cfg = getProxyConfig(opts);
  if (!cfg.managed) {
    return { managed: false, enabled: false, proxyUrl: '', env: {} };
  }
  if (!cfg.enabled || !cfg.proxyUrl) {
    return { managed: true, enabled: false, proxyUrl: '', env: {} };
  }
  const env = {};
  for (const k of PROXY_ENV_KEYS) {
    env[k] = cfg.proxyUrl;
  }
  return {
    managed: true,
    enabled: true,
    proxyUrl: cfg.proxyUrl,
    env
  };
}

/**
 * 将运行时代理配置应用到即将启动的子进程环境变量副本中（若显式关闭则剥离 6 个代理变量）
 */
function applyRuntimeProxyEnv(baseEnv, opts = {}) {
  const nextEnv = { ...(baseEnv || process.env) };
  const runtime = getRuntimeProxyEnv(opts);
  if (!runtime.managed) return nextEnv;

  if (runtime.enabled && runtime.proxyUrl) {
    for (const k of PROXY_ENV_KEYS) {
      nextEnv[k] = runtime.proxyUrl;
    }
  } else {
    for (const k of PROXY_ENV_KEYS) {
      delete nextEnv[k];
    }
  }
  return nextEnv;
}

// ============================================================================
// 代理连通性测试与通过代理发起 HTTPS POST 请求（纯 Node 内置 net / tls / http）
// ============================================================================

function buildProxyAuthHeader(parsedUrl) {
  if (!parsedUrl.username && !parsedUrl.password) return null;
  const user = parsedUrl.username ? decodeURIComponent(parsedUrl.username) : '';
  const pass = parsedUrl.password ? decodeURIComponent(parsedUrl.password) : '';
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;
}

/**
 * 在已有字节流 Socket 上读取指定字节数（用于 SOCKS5 协议握手）
 */
function readExactBytes(socket, count, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      clearTimeout(timer);
    };
    const finishErr = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= count) {
        settled = true;
        cleanup();
        const combined = Buffer.concat(chunks);
        if (combined.length > count) {
          socket.unshift(combined.subarray(count));
        }
        resolve(combined.subarray(0, count));
      }
    };
    const onError = (err) => finishErr(err);
    const onEnd = () => finishErr(new Error('SOCKS5 代理提前关闭连接'));
    const timer = setTimeout(() => finishErr(new Error('SOCKS5 握手读取超时')), timeoutMs);

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

/**
 * 通过 SOCKS5 代理建立到 targetHost:targetPort 的隧道连接（支持用户名/密码认证）
 */
async function connectViaSocks5(proxyParsed, targetHost, targetPort, timeoutMs = 5000) {
  const host = proxyParsed.hostname;
  const port = proxyParsed.port ? Number(proxyParsed.port) : 1080;

  const socket = await new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy(new Error('连接 SOCKS5 代理端口超时'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  try {
    const hasAuth = Boolean(proxyParsed.username || proxyParsed.password);
    const methods = hasAuth ? Buffer.from([0x05, 0x02, 0x00, 0x02]) : Buffer.from([0x05, 0x01, 0x00]);
    socket.write(methods);

    const greetingResp = await readExactBytes(socket, 2, timeoutMs);
    if (greetingResp[0] !== 0x05 || greetingResp[1] === 0xff) {
      throw new Error('SOCKS5 代理拒绝支持的认证方式');
    }

    if (greetingResp[1] === 0x02) {
      const userBuf = Buffer.from(proxyParsed.username ? decodeURIComponent(proxyParsed.username) : '', 'utf8');
      const passBuf = Buffer.from(proxyParsed.password ? decodeURIComponent(proxyParsed.password) : '', 'utf8');
      const authReq = Buffer.concat([
        Buffer.from([0x01, userBuf.length]),
        userBuf,
        Buffer.from([passBuf.length]),
        passBuf
      ]);
      socket.write(authReq);
      const authResp = await readExactBytes(socket, 2, timeoutMs);
      if (authResp[1] !== 0x00) {
        const err = new Error('SOCKS5 代理用户名或密码认证失败');
        err.statusCode = 407;
        throw err;
      }
    }

    const hostBuf = Buffer.from(targetHost, 'utf8');
    const portBuf = Buffer.alloc(2);
    portBuf.writeUInt16BE(targetPort, 0);
    const connectReq = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
      hostBuf,
      portBuf
    ]);
    socket.write(connectReq);

    const head = await readExactBytes(socket, 4, timeoutMs);
    if (head[1] !== 0x00) {
      const err = new Error(`SOCKS5 CONNECT 失败 (code=0x${head[1].toString(16)})`);
      err.statusCode = 502;
      throw err;
    }

    const atyp = head[3];
    if (atyp === 0x01) await readExactBytes(socket, 6, timeoutMs);
    else if (atyp === 0x04) await readExactBytes(socket, 18, timeoutMs);
    else if (atyp === 0x03) {
      const lenBuf = await readExactBytes(socket, 1, timeoutMs);
      await readExactBytes(socket, lenBuf[0] + 2, timeoutMs);
    }

    return { socket, statusCode: 200 };
  } catch (err) {
    socket.destroy();
    throw err;
  }
}

/**
 * 通过 HTTP / HTTPS 代理发送 CONNECT 请求并建立隧道（保留代理可达性与响应状态码）
 */
async function connectViaHttpTunnel(proxyParsed, targetHost, targetPort, timeoutMs = 5000) {
  const isHttpsProxy = proxyParsed.protocol === 'https:';
  const proxyHost = proxyParsed.hostname;
  const proxyPort = proxyParsed.port ? Number(proxyParsed.port) : getDefaultPortForProtocol(proxyParsed.protocol);

  const rawSocket = await new Promise((resolve, reject) => {
    const sock = isHttpsProxy
      ? tls.connect({ host: proxyHost, port: proxyPort, servername: proxyHost })
      : net.connect({ host: proxyHost, port: proxyPort });
    const readyEvent = isHttpsProxy ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      sock.destroy(new Error('连接代理端口超时'));
    }, timeoutMs);
    sock.once(readyEvent, () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // TCP/TLS 到代理已通，下面发送 HTTP CONNECT 建立隧道
  const authority = `${targetHost}:${targetPort}`;
  const lines = [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    'Proxy-Connection: keep-alive'
  ];
  const authHeader = buildProxyAuthHeader(proxyParsed);
  if (authHeader) lines.push(`Proxy-Authorization: ${authHeader}`);
  lines.push('', '');

  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      rawSocket.removeListener('data', onData);
      rawSocket.removeListener('error', onError);
      rawSocket.removeListener('end', onEnd);
      clearTimeout(timer);
    };
    const fail = (err, destroySock = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (destroySock) rawSocket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => {
      const err = new Error('代理 CONNECT 响应超时');
      err.reachable = true;
      fail(err);
    }, timeoutMs);

    const onError = (err) => {
      err.reachable = true;
      fail(err);
    };
    const onEnd = () => {
      const err = new Error('代理在 CONNECT 握手期间关闭连接');
      err.reachable = true;
      fail(err);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      const altEnd = headerEnd >= 0 ? headerEnd : buffer.indexOf('\n\n');
      const sepLen = headerEnd >= 0 ? 4 : 2;
      if (altEnd < 0) {
        if (buffer.length > 16384) {
          const err = new Error('代理 CONNECT 响应头过长');
          err.reachable = true;
          fail(err);
        }
        return;
      }

      const headerText = buffer.subarray(0, altEnd).toString('latin1');
      const remainder = buffer.subarray(altEnd + sepLen);
      const statusMatch = headerText.match(/^HTTP\/\d\.\d\s+(\d{3})/i);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 502;

      settled = true;
      cleanup();

      if (statusCode >= 200 && statusCode < 300) {
        if (remainder.length > 0) rawSocket.unshift(remainder);
        resolve({ socket: rawSocket, statusCode });
      } else {
        rawSocket.destroy();
        const err = new Error(
          statusCode === 407 ? '代理认证失败 (407)' : `代理 CONNECT 拒绝连接 (HTTP ${statusCode})`
        );
        err.reachable = true;
        err.statusCode = statusCode;
        reject(err);
      }
    };

    rawSocket.on('data', onData);
    rawSocket.on('error', onError);
    rawSocket.on('end', onEnd);
    rawSocket.write(lines.join('\r\n'));
  });
}

async function openProxyTunnel(proxyParsed, targetHost, targetPort, timeoutMs = 5000) {
  if (proxyParsed.protocol === 'socks5:') {
    return connectViaSocks5(proxyParsed, targetHost, targetPort, timeoutMs);
  }
  return connectViaHttpTunnel(proxyParsed, targetHost, targetPort, timeoutMs);
}

/**
 * 测试代理连通性：先校验格式，再探测 TCP 可达性，最后执行 CONNECT 隧道握手
 */
async function testProxyConnection(proxyUrlInput, opts = {}) {
  const candidate = (typeof proxyUrlInput === 'string' && proxyUrlInput.trim())
    ? proxyUrlInput.trim()
    : getProxyConfig(opts).proxyUrl;

  if (!candidate) {
    return {
      ok: false,
      reachable: false,
      statusCode: null,
      latencyMs: 0,
      error: '未配置代理地址',
      validationError: true
    };
  }

  const check = validateProxyUrl(candidate);
  if (!check.ok) {
    return {
      ok: false,
      reachable: false,
      statusCode: null,
      latencyMs: 0,
      error: check.error,
      validationError: true
    };
  }

  const targetRaw = String(opts.testTarget || process.env.AGY_PROXY_TEST_TARGET || DEFAULT_PROXY_TEST_TARGET);
  const lastColon = targetRaw.lastIndexOf(':');
  const targetHost = lastColon > 0 ? targetRaw.slice(0, lastColon) : targetRaw;
  const targetPort = lastColon > 0 ? (Number(targetRaw.slice(lastColon + 1)) || 443) : 443;
  const timeoutMs = Number(opts.timeoutMs) || 4000;
  const startMs = Date.now();

  try {
    const { socket, statusCode } = await openProxyTunnel(check.parsed, targetHost, targetPort, timeoutMs);
    socket.destroy();
    return {
      ok: true,
      reachable: true,
      statusCode,
      latencyMs: Math.max(1, Date.now() - startMs),
      error: null
    };
  } catch (err) {
    return {
      ok: false,
      reachable: Boolean(err.reachable),
      statusCode: err.statusCode ?? null,
      latencyMs: Math.max(1, Date.now() - startMs),
      error: err.message || '代理连接失败'
    };
  }
}

/**
 * 解码 HTTP/1.1 Transfer-Encoding: chunked 响应体
 */
function decodeChunkedBody(buf) {
  const parts = [];
  let offset = 0;
  while (offset < buf.length) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const sizeHex = buf.subarray(offset, lineEnd).toString('ascii').split(';')[0].trim();
    const chunkSize = parseInt(sizeHex, 16);
    if (!Number.isFinite(chunkSize) || chunkSize < 0) break;
    offset = lineEnd + 2;
    if (chunkSize === 0) break;
    if (offset + chunkSize > buf.length) {
      parts.push(buf.subarray(offset));
      break;
    }
    parts.push(buf.subarray(offset, offset + chunkSize));
    offset += chunkSize + 2;
  }
  return Buffer.concat(parts);
}

/**
 * 直接在已建立的隧道/TLS Socket 上发送 HTTP/1.1 POST 并读取完整响应
 * 避免 Node.js http.request(createConnection: () => connectedSocket) 在已握手 TLSSocket 上挂起的问题
 */
function sendHttp1PostOverSocket(socket, target, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(err);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();

      const raw = Buffer.concat(chunks);
      const headerEndCrlf = raw.indexOf('\r\n\r\n');
      const headerEndLf = headerEndCrlf >= 0 ? headerEndCrlf : raw.indexOf('\n\n');
      const sepLen = headerEndCrlf >= 0 ? 4 : 2;
      if (headerEndLf < 0) {
        reject(new Error('OAuth 响应报文缺少 HTTP 头部'));
        return;
      }

      const headerText = raw.subarray(0, headerEndLf).toString('latin1');
      const rawBody = raw.subarray(headerEndLf + sepLen);
      const lines = headerText.split(/\r?\n/);
      const statusMatch = lines[0].match(/^HTTP\/\d\.\d\s+(\d{3})/i);
      const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

      let isChunked = false;
      for (let i = 1; i < lines.length; i++) {
        const colon = lines[i].indexOf(':');
        if (colon <= 0) continue;
        const name = lines[i].slice(0, colon).trim().toLowerCase();
        const val = lines[i].slice(colon + 1).trim().toLowerCase();
        if (name === 'transfer-encoding' && val.includes('chunked')) {
          isChunked = true;
        }
      }

      const bodyBuf = isChunked ? decodeChunkedBody(rawBody) : rawBody;
      const text = bodyBuf.toString('utf8');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      resolve({ statusCode, text, json });
    };

    const timer = setTimeout(() => fail(new Error('OAuth Token 刷新请求超时')), timeoutMs);
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => finish();
    const onClose = (hadError) => {
      if (!hadError) finish();
    };
    const onError = (err) => fail(err);

    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onClose);
    socket.on('error', onError);

    const reqText =
      `POST ${target.pathname}${target.search} HTTP/1.1\r\n` +
      `Host: ${target.host}\r\n` +
      'Content-Type: application/x-www-form-urlencoded\r\n' +
      `Content-Length: ${Buffer.byteLength(bodyStr)}\r\n` +
      'Accept: application/json\r\n' +
      'Connection: close\r\n\r\n' +
      bodyStr;

    socket.write(reqText, 'utf8');
  });
}

/**
 * 发起 HTTPS/HTTP POST 请求（若当前已启用代理则自动经由代理隧道发起）
 */
async function postFormWithOptionalProxy(targetUrl, formParams, proxyCfg, timeoutMs = 30000) {
  const target = new URL(targetUrl);
  const isHttps = target.protocol === 'https:';
  const targetPort = target.port ? Number(target.port) : (isHttps ? 443 : 80);
  const bodyStr = new URLSearchParams(formParams).toString();
  const baseHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(bodyStr),
    'Accept': 'application/json'
  };

  const hasProxy = Boolean(proxyCfg && proxyCfg.enabled && proxyCfg.proxyUrl);
  let proxyParsed = null;
  if (hasProxy) {
    const check = validateProxyUrl(proxyCfg.proxyUrl);
    if (!check.ok) throw createHttpError(400, `当前代理配置无效: ${check.error}`);
    proxyParsed = check.parsed;
  }

  // 1. HTTPS 目标走代理 CONNECT/SOCKS5 隧道 + TLS 握手 + 原生 HTTP/1.1 报文
  if (hasProxy && isHttps) {
    const { socket: tunnelSock } = await openProxyTunnel(proxyParsed, target.hostname, targetPort, timeoutMs);
    const tlsSock = await new Promise((resolve, reject) => {
      const ts = tls.connect({ socket: tunnelSock, servername: target.hostname });
      const timer = setTimeout(() => {
        ts.destroy();
        tunnelSock.destroy();
        reject(new Error('代理 TLS 握手超时'));
      }, timeoutMs);
      ts.once('secureConnect', () => {
        clearTimeout(timer);
        resolve(ts);
      });
      ts.once('error', (err) => {
        clearTimeout(timer);
        tunnelSock.destroy();
        reject(err);
      });
    });

    return sendHttp1PostOverSocket(tlsSock, target, bodyStr, timeoutMs);
  }

  // 2. 明文 HTTP 目标走 HTTP/HTTPS 代理转发或 SOCKS5 隧道
  if (hasProxy && !isHttps) {
    if (proxyParsed.protocol === 'socks5:') {
      const { socket: tunnelSock } = await openProxyTunnel(proxyParsed, target.hostname, targetPort, timeoutMs);
      return sendHttp1PostOverSocket(tunnelSock, target, bodyStr, timeoutMs);
    }

    const proxyPort = proxyParsed.port ? Number(proxyParsed.port) : getDefaultPortForProtocol(proxyParsed.protocol);
    const authHeader = buildProxyAuthHeader(proxyParsed);
    const proxyHeaders = {
      ...baseHeaders,
      Host: target.host,
      ...(authHeader ? { 'Proxy-Authorization': authHeader } : {})
    };
    const transport = proxyParsed.protocol === 'https:' ? https : http;
    return sendOverRequestFactory(
      () => transport.request({
        hostname: proxyParsed.hostname,
        port: proxyPort,
        path: target.toString(),
        method: 'POST',
        headers: proxyHeaders
      }),
      bodyStr,
      timeoutMs
    );
  }

  // 3. 无代理直连
  const transport = isHttps ? https : http;
  return sendOverRequestFactory(
    () => transport.request({
      hostname: target.hostname,
      port: targetPort,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: baseHeaders
    }),
    bodyStr,
    timeoutMs
  );
}

function sendOverRequestFactory(createReq, bodyStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = createReq();
    const timer = setTimeout(() => {
      req.destroy(new Error('OAuth Token 刷新请求超时'));
    }, timeoutMs);

    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ statusCode: res.statusCode || 0, text, json });
      });
    });

    req.write(bodyStr);
    req.end();
  });
}

// ============================================================================
// 账号切换主流程
// ============================================================================

/**
 * 切换 Antigravity 账号：
 *   1. 严格防路径穿越校验账号文件名
 *   2. 经当前代理（如有）向 OAuth Token Endpoint 刷新 access_token
 *   3. 原子写入 0o600 到 CLI_TOKEN_FILE 与 FALLBACK_TOKEN_FILE
 *   4. 清理 agy-runner 模型缓存
 */
async function switchAccount(fileName, opts = {}) {
  const paths = resolvePaths(opts);
  const accountPath = validateAccountFileName(fileName, paths.accountsDir);
  const accountData = safeReadJson(accountPath);
  if (!accountData) {
    throw createHttpError(400, `账号 JSON 解析失败: ${fileName}`);
  }

  const tokenObj = (accountData.token && typeof accountData.token === 'object') ? accountData.token : accountData;
  const refreshToken = String(tokenObj.refresh_token || accountData.refresh_token || '').trim();
  if (!refreshToken) {
    throw createHttpError(400, `账号 ${fileName} 缺少有效的 refresh_token`);
  }

  const proxyCfg = getProxyConfig(opts);
  const tokenEndpoint = getTokenEndpoint(opts);

  // 确定 OAuth Client 凭证：优先账号文件内配置 -> opts -> switch-agy.py 解析 -> 全局默认/环境变量
  const pyCreds = parseSwitchPyCredentials(paths.switchPyPath);
  const clientId = accountData.client_id || accountData.clientId || tokenObj.client_id || opts.clientId || pyCreds?.clientId || CLIENT_ID;
  const clientSecret = accountData.client_secret || accountData.clientSecret || tokenObj.client_secret || opts.clientSecret || pyCreds?.clientSecret || CLIENT_SECRET;

  let oauthResp;
  try {
    oauthResp = await postFormWithOptionalProxy(
      tokenEndpoint,
      {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      },
      proxyCfg
    );
  } catch (err) {
    throw createHttpError(502, `刷新 OAuth Token 网络失败: ${err.message}`);
  }

  const tokenData = oauthResp.json;
  if (oauthResp.statusCode < 200 || oauthResp.statusCode >= 300 || !tokenData || !tokenData.access_token) {
    const errDesc = tokenData?.error_description || tokenData?.error || oauthResp.text || `HTTP ${oauthResp.statusCode}`;
    throw createHttpError(502, `OAuth Token 刷新失败: ${String(errDesc).slice(0, 200)}`);
  }

  const expiresIn = Number(tokenData.expires_in) || 3600;
  const expiryIso = new Date(Date.now() + expiresIn * 1000).toISOString();
  const idToken = tokenData.id_token || accountData.id_token || tokenObj.id_token || '';
  const email = extractEmailFromAccountData(
    { ...accountData, id_token: idToken },
    path.basename(accountPath)
  );
  const projectId = String(
    accountData.project_id || accountData.projectId || accountData.cloudaicompanion_project || ''
  ).trim();

  // 按 Antigravity CLI 实测结构组装 token 文件内容
  const tokenFilePayload = {
    token: {
      access_token: tokenData.access_token,
      token_type: tokenData.token_type || 'Bearer',
      refresh_token: tokenData.refresh_token || refreshToken,
      expiry: expiryIso,
      expires_in: expiresIn
    },
    auth_method: accountData.auth_method || 'consumer',
    id_token_email: email,
    id_token: idToken
  };

  const serialized = JSON.stringify(tokenFilePayload, null, 2) + '\n';
  atomicWriteFile(paths.cliTokenFile, serialized, 0o600);
  atomicWriteFile(paths.fallbackTokenFile, serialized, 0o600);

  // 同步回写账号源 JSON 缓存（与 switch-agy.py 行为对齐，保持本地凭据最新）
  try {
    const updatedAccount = { ...accountData };
    updatedAccount.access_token = tokenData.access_token;
    if (tokenData.id_token) updatedAccount.id_token = tokenData.id_token;
    if (tokenData.refresh_token) updatedAccount.refresh_token = tokenData.refresh_token;
    updatedAccount.expires_in = expiresIn;
    updatedAccount.expired = expiryIso;
    fs.writeFileSync(accountPath, JSON.stringify(updatedAccount, null, 2) + '\n', 'utf8');
  } catch {
    // 忽略文件写回异常（如只读文件权限）
  }

  // 切换账号后立即清理模型列表缓存
  try {
    const agyRunner = require('./agy-runner');
    if (typeof agyRunner.clearModelsCache === 'function') {
      agyRunner.clearModelsCache();
    }
  } catch {
    // 忽略加载异常
  }

  return {
    ok: true,
    fileName: path.basename(accountPath),
    email,
    projectId,
    tokenExpiry: expiryIso,
    tokenExpiresInSec: expiresIn,
    writtenFiles: [paths.cliTokenFile, paths.fallbackTokenFile]
  };
}

module.exports = {
  CLIENT_ID,
  CLIENT_SECRET,
  parseSwitchPyCredentials,
  PROXY_ENV_KEYS,
  resolvePaths,
  validateAccountFileName,
  validateProxyUrl,
  listAccounts,
  switchAccount,
  getProxyConfig,
  saveProxyConfig,
  testProxyConnection,
  getRuntimeProxyEnv,
  applyRuntimeProxyEnv
};
