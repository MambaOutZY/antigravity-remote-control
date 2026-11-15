'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const meterEngine = require('./lib/meter-engine');
const unlockBridge = require('./lib/context-unlock-bridge');
const switchBridge = require('./lib/switch-bridge');
const {
  resolveAgyBinary,
  getAvailableModels,
  clearModelsCache,
  streamAgyTurn,
  inspectWorkspaceGit
} = require('./lib/agy-runner');
const { getRegisteredCommands } = require('./lib/command-registry');

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '0.0.0.0';
const SESSION_COOKIE_NAME = 'agy_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天有效期
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024; // 普通 API 最大请求体 2MB
const MAX_UPLOAD_JSON_BYTES = 22 * 1024 * 1024; // 15MB 二进制的 Base64 约 20MB
const MAX_UPLOAD_FILE_BYTES = 15 * 1024 * 1024; // 最大上传图片 15MB
const MAX_UPLOAD_REGISTRY = 2000;

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['auto', 'accept-edits', 'plan'];

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
};

/**
 * 发送标准 JSON 响应
 */
function sendJson(res, statusCode, data, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(body);
}

/**
 * 读取并解析 JSON 请求体（带字节上限保护）
 */
function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    const fail = (statusCode, message) => {
      if (settled) return;
      settled = true;
      const err = new Error(message);
      err.statusCode = statusCode;
      reject(err);
    };

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        fail(413, `请求体超过最大限制 (${Math.round(maxBytes / 1024 / 1024)}MB)`);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        const err = new Error('无效的 JSON 请求体');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => fail(400, err.message || '读取请求失败'));
  });
}

/**
 * 解析 Cookie 请求头
 */
function parseCookies(cookieHeader) {
  const map = Object.create(null);
  if (!cookieHeader || typeof cookieHeader !== 'string') return map;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      map[key] = decodeURIComponent(val);
    } catch {
      map[key] = val;
    }
  }
  return map;
}

/**
 * 使用 SHA-256 + timingSafeEqual 安全比对密码，防止时序侧信道攻击
 */
function verifyPasswordConstantTime(inputPwd, expectedPwd) {
  const h1 = crypto.createHash('sha256').update(String(inputPwd || '')).digest();
  const h2 = crypto.createHash('sha256').update(String(expectedPwd || '')).digest();
  return crypto.timingSafeEqual(h1, h2);
}

/**
 * 创建与校验 HMAC-SHA256 会话令牌
 */
function createSessionManager(instanceSecret) {
  const deriveKey = (password) =>
    crypto.createHmac('sha256', instanceSecret).update(String(password)).digest();

  const signToken = (password) => {
    const now = Date.now();
    const payloadB64 = Buffer.from(JSON.stringify({ v: 1, iat: now, exp: now + SESSION_TTL_MS })).toString('base64url');
    const sigHex = crypto.createHmac('sha256', deriveKey(password)).update(payloadB64).digest('hex');
    return `${payloadB64}.${sigHex}`;
  };

  const verifyToken = (token, password) => {
    if (!token || typeof token !== 'string' || !password) return false;
    const dotIdx = token.indexOf('.');
    if (dotIdx <= 0) return false;
    const payloadB64 = token.slice(0, dotIdx);
    const sigHex = token.slice(dotIdx + 1);
    if (!payloadB64 || !sigHex) return false;

    const expectedHex = crypto.createHmac('sha256', deriveKey(password)).update(payloadB64).digest('hex');
    const b1 = Buffer.from(sigHex, 'utf8');
    const b2 = Buffer.from(expectedHex, 'utf8');
    if (b1.length !== b2.length || !crypto.timingSafeEqual(b1, b2)) return false;

    try {
      const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      return Boolean(payload && typeof payload.exp === 'number' && payload.exp > Date.now());
    } catch {
      return false;
    }
  };

  return { signToken, verifyToken };
}

/**
 * 检测当前请求是否经由 HTTPS 或 HTTPS 反向代理（决定 Cookie 是否附加 Secure）
 */
function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  const proto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  return proto === 'https';
}

/**
 * 根据 MIME 或文件名推断安全的文件扩展名与 MIME 类型
 */
function resolveImageExtension(fileName, mime) {
  const mimeMap = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp'
  };
  const extFromName = path.extname(String(fileName || '')).toLowerCase();
  const allowedExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
  const ext = allowedExts.has(extFromName) ? extFromName : (mimeMap[String(mime || '').toLowerCase()] || '.png');
  const finalMime = MIME_TYPES[ext] || 'image/png';
  return { ext, mime: finalMime };
}

/**
 * 安全托管 public/ 目录下静态资源（防止目录穿越）
 */
async function serveStaticAsset(req, res, pathname, publicDir) {
  if (pathname === '/favicon.ico') {
    const iconPath = path.join(publicDir, 'favicon.ico');
    if (!fs.existsSync(iconPath)) {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  const relativeReq = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolvedPublic = path.resolve(publicDir);
  const targetPath = path.resolve(resolvedPublic, relativeReq);

  if (targetPath !== resolvedPublic && !targetPath.startsWith(resolvedPublic + path.sep)) {
    sendJson(res, 403, { error: '禁止越权访问静态路径' });
    return;
  }

  try {
    const stat = await fs.promises.stat(targetPath);
    if (!stat.isFile()) {
      sendJson(res, 404, { error: '静态文件不存在' });
      return;
    }
    const ext = path.extname(targetPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const data = await fs.promises.readFile(targetPath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: '静态文件不存在' });
  }
}

/**
 * 安全列出指定路径下的子目录列表（含隐藏目录如 .gemini / .config），供前端目录选择器使用
 * @param {string} rawPath
 * @param {string} fallbackPath
 */
function listDirectoriesSafe(rawPath, fallbackPath) {
  const home = os.homedir();
  const requested = typeof rawPath === 'string' ? rawPath.trim() : '';
  let candidate = requested;
  if (!candidate) {
    candidate = (fallbackPath && fs.existsSync(fallbackPath)) ? fallbackPath : home;
  } else if (candidate === '~') {
    candidate = home;
  } else if (candidate.startsWith('~/') || candidate.startsWith('~\\')) {
    candidate = path.join(home, candidate.slice(2));
  }

  const targetPath = path.resolve(candidate);
  let st;
  try {
    st = fs.statSync(targetPath);
  } catch (err) {
    const httpErr = new Error(
      err?.code === 'ENOENT' ? `目录不存在: ${targetPath}` : `无法访问目录: ${targetPath}`
    );
    httpErr.statusCode = err?.code === 'ENOENT' ? 404 : (err?.code === 'EACCES' ? 403 : 400);
    throw httpErr;
  }

  if (!st.isDirectory()) {
    const httpErr = new Error(`指定路径不是目录: ${targetPath}`);
    httpErr.statusCode = 400;
    throw httpErr;
  }

  let entries;
  try {
    entries = fs.readdirSync(targetPath, { withFileTypes: true });
  } catch (err) {
    const httpErr = new Error(`读取目录失败: ${err?.message || targetPath}`);
    httpErr.statusCode = err?.code === 'EACCES' ? 403 : 400;
    throw httpErr;
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry || entry.name === '.' || entry.name === '..') continue;
    const fullPath = path.join(targetPath, entry.name);
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (isDir) {
      dirs.push({ name: entry.name, path: fullPath });
    }
  }

  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(targetPath);
  const parentPath = (parent && parent !== targetPath) ? parent : null;

  return {
    ok: true,
    currentPath: targetPath,
    parentPath,
    dirs
  };
}

/**
 * 创建 HTTP 应用服务器（支持传入测试配置覆盖环境变量）
 * @param {object} [options]
 * @returns {http.Server}
 */
function createAppServer(options = {}) {
  const publicDir = path.resolve(options.publicDir || path.join(__dirname, 'public'));
  const fallbackUploadBase = path.resolve(options.fallbackUploadDir || options.uploadDir || __dirname);
  const instanceSecret = options.sessionSecret || crypto.randomBytes(32);
  const sessionMgr = createSessionManager(instanceSecret);

  // 维护正在运行的 SSE 流任务与已上传文件索引
  const activeRuns = new Map();
  const activeSseResponses = new Set();
  const uploadedFileRegistry = new Map();

  const getAuthPassword = () => (
    options.authPassword !== undefined
      ? String(options.authPassword)
      : String(process.env.AGY_AUTH_PASSWORD || '')
  );

  const getAgyBinOption = () => options.agyBin ?? undefined;

  const getMeterOpts = () => ({
    agDir: options.agDir !== undefined ? options.agDir : (process.env.AG_DIR || undefined),
    agCliDir: options.agCliDir !== undefined ? options.agCliDir : (process.env.AG_CLI_DIR || undefined),
    geminiConfigDir: options.geminiConfigDir !== undefined ? options.geminiConfigDir : undefined,
    projectsStore: options.projectsStore !== undefined ? options.projectsStore : undefined,
    modelCtxFile: options.modelCtxFile !== undefined ? options.modelCtxFile : undefined,
    conversationPrefsStore: options.conversationPrefsStore !== undefined ? options.conversationPrefsStore : undefined
  });

  // 透传 switch-bridge 路径与测试 Mock 配置（未传时内部自动回退环境变量与默认路径）
  const getSwitchOpts = () => ({
    switchDir: options.switchDir !== undefined ? options.switchDir : undefined,
    accountsDir: options.accountsDir !== undefined ? options.accountsDir : undefined,
    switchPyPath: options.switchPyPath !== undefined ? options.switchPyPath : undefined,
    cliTokenFile: options.cliTokenFile !== undefined ? options.cliTokenFile : undefined,
    fallbackTokenFile: options.fallbackTokenFile !== undefined ? options.fallbackTokenFile : undefined,
    wrapperPath: options.wrapperPath !== undefined ? options.wrapperPath : undefined,
    runtimeProxyFile: options.runtimeProxyFile !== undefined ? options.runtimeProxyFile : undefined,
    tokenEndpoint: options.tokenEndpoint !== undefined ? options.tokenEndpoint : undefined
  });

  const getDefaultWorkspace = () => {
    const candidate = options.defaultWorkspace || process.env.DEFAULT_WORKSPACE || process.cwd();
    return path.resolve(candidate);
  };

  const isRequestAuthenticated = (req, reqUrl) => {
    const password = getAuthPassword();
    if (!password) return true;
    const headerToken = req.headers['x-agy-token'];
    if (typeof headerToken === 'string' && sessionMgr.verifyToken(headerToken.trim(), password)) {
      return true;
    }
    const urlToken = reqUrl?.searchParams?.get('token');
    if (typeof urlToken === 'string' && sessionMgr.verifyToken(urlToken.trim(), password)) {
      return true;
    }
    const cookies = parseCookies(req.headers.cookie);
    const cookieToken = cookies[SESSION_COOKIE_NAME];
    return Boolean(cookieToken && sessionMgr.verifyToken(cookieToken, password));
  };

  const registerUploadedFile = (storedName, fullPath) => {
    if (uploadedFileRegistry.size >= MAX_UPLOAD_REGISTRY) {
      const oldestKey = uploadedFileRegistry.keys().next().value;
      if (oldestKey) uploadedFileRegistry.delete(oldestKey);
    }
    uploadedFileRegistry.set(storedName, fullPath);
  };

  const server = http.createServer(async (req, res) => {
    const method = (req.method || 'GET').toUpperCase();
    let reqUrl;
    try {
      reqUrl = new URL(req.url || '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: '无效的请求 URL' });
      return;
    }

    const pathname = reqUrl.pathname;

    // 非 API 请求直接交由静态文件服务处理
    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { error: 'Method Not Allowed' });
        return;
      }
      await serveStaticAsset(req, res, pathname, publicDir);
      return;
    }

    const authPassword = getAuthPassword();
    const authRequired = Boolean(authPassword);
    const authenticated = isRequestAuthenticated(req, reqUrl);

    // 鉴权豁免接口：health、auth 系列与 bootstrap（bootstrap 在未登录时返回脱敏状态触发登录弹窗）
    const authExemptRoutes = new Set([
      '/api/health',
      '/api/auth/check',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/bootstrap'
    ]);

    if (authRequired && !authenticated && !authExemptRoutes.has(pathname)) {
      sendJson(res, 401, { ok: false, error: '未登录或会话已过期', code: 'UNAUTHORIZED' });
      return;
    }

    try {
      // 1. 健康检查
      if (method === 'GET' && pathname === '/api/health') {
        const agyStatus = resolveAgyBinary(getAgyBinOption());
        sendJson(res, 200, {
          ok: true,
          agyFound: agyStatus.found,
          agyStatus,
          uptime: Math.floor(process.uptime())
        });
        return;
      }

      // 2. 登录状态检查
      if (method === 'GET' && pathname === '/api/auth/check') {
        sendJson(res, 200, { ok: true, authRequired, authenticated });
        return;
      }

      // 3. 登录签发 HMAC-SHA256 HttpOnly Cookie
      if (method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJsonBody(req);
        if (!authRequired) {
          sendJson(res, 200, { ok: true, authRequired: false, authenticated: true });
          return;
        }
        const inputPassword = String(body.password || '');
        if (!inputPassword || !verifyPasswordConstantTime(inputPassword, authPassword)) {
          sendJson(res, 401, { ok: false, error: '访问密码不正确' });
          return;
        }
        const token = sessionMgr.signToken(authPassword);
        const secureFlag = isSecureRequest(req) ? '; Secure' : '';
        const cookieStr = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secureFlag}`;
        sendJson(
          res,
          200,
          { ok: true, authRequired: true, authenticated: true, token },
          { 'Set-Cookie': cookieStr }
        );
        return;
      }

      // 4. 退出登录
      if (method === 'POST' && pathname === '/api/auth/logout') {
        sendJson(
          res,
          200,
          { ok: true, authenticated: false },
          { 'Set-Cookie': `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0` }
        );
        return;
      }

      // 5. 初始化启动数据（未登录时仅返回鉴权标记，避免泄露会话或工作区）
      if (method === 'GET' && pathname === '/api/bootstrap') {
        if (authRequired && !authenticated) {
          sendJson(res, 200, {
            authRequired: true,
            authenticated: false,
            agyStatus: { found: false, binPath: null, source: null },
            models: [],
            efforts: EFFORT_LEVELS,
            modes: PERMISSION_MODES,
            defaultWorkspace: null,
            conversations: [],
            tokenSummary: null
          });
          return;
        }

        const agyStatus = resolveAgyBinary(getAgyBinOption());
        const meterOpts = getMeterOpts();
        const switchOpts = getSwitchOpts();
        const [models, convAudit, historyData, projectData, usageLimits] = await Promise.all([
          getAvailableModels({ binPath: getAgyBinOption(), proxyOpts: switchOpts }),
          Promise.resolve(meterEngine.listConversationsAndAudit(meterOpts)),
          Promise.resolve(meterEngine.getTokenHistoryDashboard({ ...meterOpts, sourceFilter: 'all' })),
          Promise.resolve(meterEngine.collectProjects(meterOpts)),
          Promise.resolve(meterEngine.getUsageLimits(meterOpts))
        ]);

        sendJson(res, 200, {
          authRequired,
          authenticated: true,
          agyStatus,
          models,
          efforts: EFFORT_LEVELS,
          modes: PERMISSION_MODES,
          defaultWorkspace: getDefaultWorkspace(),
          projects: projectData?.projects || [],
          conversations: convAudit?.conversations || [],
          commands: getRegisteredCommands({ homeDir: os.homedir() }),
          usageLimits: usageLimits || null,
          tokenSummary: historyData?.summary
            ? { ...historyData.summary, costSummary: historyData.costSummary || null }
            : null
        });
        return;
      }

      // 5.5 官方指令与提及列表（供 / 与 @ 呼出补全）
      if (method === 'GET' && pathname === '/api/commands') {
        const cmdData = getRegisteredCommands({ homeDir: os.homedir() });
        sendJson(res, 200, { ok: true, commands: cmdData, ...cmdData });
        return;
      }

      // 6. 会话列表（附带 projectId/projectName/workspacePath，并支持按 source/projectId/workspace 过滤）
      if (method === 'GET' && pathname === '/api/conversations') {
        const sourceFilter = reqUrl.searchParams.get('source') || 'all';
        const projectId = reqUrl.searchParams.get('projectId') || '';
        const workspace = reqUrl.searchParams.get('workspace') || '';
        const audit = meterEngine.listConversationsAndAudit({
          ...getMeterOpts(),
          sourceFilter,
          projectId,
          workspace
        });
        const list = Array.isArray(audit?.conversations) ? audit.conversations : [];
        sendJson(res, 200, {
          conversations: list,
          scannedAt: audit?.scannedAt || new Date().toISOString()
        });
        return;
      }

      // 7. 会话详情与会话管理（GET / PATCH 重命名置顶未读归档 / DELETE 删除）
      if ((method === 'GET' || method === 'PATCH' || method === 'DELETE') && pathname.startsWith('/api/conversations/')) {
        const rawId = pathname.slice('/api/conversations/'.length);
        let convId = '';
        try {
          convId = decodeURIComponent(rawId);
        } catch {
          sendJson(res, 400, { error: '无效的会话 ID' });
          return;
        }
        if (!convId || /[\\/\0]/.test(convId) || convId.includes('..')) {
          sendJson(res, 400, { error: '非法的会话 ID 格式' });
          return;
        }

        if (method === 'GET') {
          const detail = meterEngine.getConversationDetail(convId, getMeterOpts());
          if (!detail) {
            sendJson(res, 404, { error: '未找到指定会话记录' });
            return;
          }
          sendJson(res, 200, { conversation: detail });
          return;
        }

        if (method === 'PATCH') {
          const body = await readJsonBody(req);
          const prefs = meterEngine.updateConversationPrefs(convId, body, getMeterOpts());
          sendJson(res, 200, { ok: true, id: convId, prefs });
          return;
        }

        if (method === 'DELETE') {
          meterEngine.deleteConversationPref(convId, getMeterOpts());
          sendJson(res, 200, { ok: true, id: convId });
          return;
        }
      }

      // 8. 流式对话 (SSE，禁用缓冲以兼容 Lucky/Nginx 反代)
      if (method === 'POST' && pathname === '/api/chat/stream') {
        const body = await readJsonBody(req);
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        const attachments = Array.isArray(body.attachments) ? body.attachments : [];
        if (!prompt && attachments.length === 0) {
          sendJson(res, 400, { error: '请输入提示词或至少附加一张图片' });
          return;
        }

        const runId = (typeof body.runId === 'string' && /^[a-zA-Z0-9_-]{4,64}$/.test(body.runId))
          ? body.runId
          : crypto.randomUUID();

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });

        activeSseResponses.add(res);
        let streamEnded = false;

        const writeSseEvent = (type, payload) => {
          if (streamEnded || res.writableEnded) return;
          const safeType = String(type || 'message').replace(/[\r\n]/g, '');
          res.write(`event: ${safeType}\ndata: ${JSON.stringify({ ...payload, runId })}\n\n`);
        };

        // 立即下发初始化事件与 runId，防止反代首包超时
        writeSseEvent('status', {
          type: 'status',
          status: 'starting',
          message: '正在建立流式会话通道...',
          runId
        });

        // 15 秒心跳注释，避免反代空闲断流
        const keepAliveTimer = setInterval(() => {
          if (!streamEnded && !res.writableEnded) {
            res.write(': ping\n\n');
          }
        }, 15000);
        if (keepAliveTimer.unref) keepAliveTimer.unref();

        const runner = streamAgyTurn(
          {
            prompt,
            attachments,
            conversationId: body.conversationId,
            continueLast: Boolean(body.continueLast),
            project: body.project,
            workspace: body.workspace || getDefaultWorkspace(),
            model: body.model,
            effort: body.effort,
            mode: body.mode,
            skipPermissions: Boolean(body.skipPermissions),
            mock: body.mock === true,
            binPath: getAgyBinOption(),
            proxyOpts: getSwitchOpts()
          },
          (evt) => writeSseEvent(evt.type, evt)
        );

        activeRuns.set(runId, runner);

        res.on('close', () => {
          clearInterval(keepAliveTimer);
          activeSseResponses.delete(res);
          if (!streamEnded) {
            streamEnded = true;
            runner.kill();
            activeRuns.delete(runId);
          }
        });

        try {
          await runner.done;
        } finally {
          clearInterval(keepAliveTimer);
          activeRuns.delete(runId);
          activeSseResponses.delete(res);
          streamEnded = true;
          if (!res.writableEnded) res.end();
        }
        return;
      }

      // 9. 中止正在执行的对话生成
      if (method === 'POST' && pathname === '/api/chat/stop') {
        const body = await readJsonBody(req);
        const runId = typeof body.runId === 'string' ? body.runId.trim() : '';
        if (runId && activeRuns.has(runId)) {
          const runner = activeRuns.get(runId);
          activeRuns.delete(runId);
          runner.kill();
          sendJson(res, 200, { ok: true, stopped: true, runId });
          return;
        }
        sendJson(res, 200, { ok: true, stopped: false, runId: runId || null });
        return;
      }

      // 10. 图片附件上传落盘与像素/Token 审计
      if (method === 'POST' && pathname === '/api/upload') {
        const body = await readJsonBody(req, MAX_UPLOAD_JSON_BYTES);
        const rawB64 = typeof body.dataBase64 === 'string' ? body.dataBase64.trim() : '';
        if (!rawB64) {
          sendJson(res, 400, { ok: false, error: '缺少图片 Base64 数据 (dataBase64)' });
          return;
        }

        const cleanedB64 = rawB64.replace(/^data:[^;]+;base64,/i, '');
        const fileBuf = Buffer.from(cleanedB64, 'base64');
        if (fileBuf.length === 0) {
          sendJson(res, 400, { ok: false, error: '上传文件内容为空或 Base64 格式无效' });
          return;
        }
        if (fileBuf.length > MAX_UPLOAD_FILE_BYTES) {
          sendJson(res, 413, { ok: false, error: '单张图片大小超过 15MB 上限' });
          return;
        }

        const originalName = path.basename(String(body.name || 'image.png')).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
        const { ext, mime } = resolveImageExtension(originalName, body.mime);
        const baseName = path.basename(originalName, path.extname(originalName)).replace(/[^\w-]/g, '_') || 'upload';
        const shortId = crypto.randomBytes(6).toString('hex');
        const storedName = `${Date.now()}-${shortId}-${baseName.slice(0, 32)}${ext}`;

        let targetUploadDir = path.join(fallbackUploadBase, '.agy_uploads');
        if (body.workspace && typeof body.workspace === 'string') {
          const resolvedWs = path.resolve(body.workspace.trim());
          try {
            if (fs.existsSync(resolvedWs) && fs.statSync(resolvedWs).isDirectory()) {
              targetUploadDir = path.join(resolvedWs, '.agy_uploads');
            }
          } catch {
            // 工作区不可用时回退至默认上传目录
          }
        }

        await fs.promises.mkdir(targetUploadDir, { recursive: true });
        const fullPath = path.join(targetUploadDir, storedName);
        await fs.promises.writeFile(fullPath, fileBuf);
        registerUploadedFile(storedName, fullPath);

        const imgMeta = meterEngine.inspectImageBuffer(fileBuf);

        sendJson(res, 200, {
          ok: true,
          file: {
            id: shortId,
            name: originalName,
            storedName,
            path: fullPath,
            url: `/api/uploads/${encodeURIComponent(storedName)}`,
            mime,
            width: imgMeta.width ?? null,
            height: imgMeta.height ?? null,
            dimensions: imgMeta.dimensions ?? (imgMeta.width && imgMeta.height ? `${imgMeta.width}×${imgMeta.height}` : null),
            bytes: fileBuf.length,
            tokens: imgMeta.estimate ?? 0
          }
        });
        return;
      }

      // 10.5 安全只读本地生成的图片（支持 file://、绝对路径以及 convId+file 相对路径，严格白名单目录与扩展名）
      if (method === 'GET' && pathname === '/api/local-image') {
        const rawPath = String(reqUrl.searchParams.get('path') || '').trim();
        const convId = String(reqUrl.searchParams.get('convId') || '').trim();
        const fileParam = String(reqUrl.searchParams.get('file') || '').trim();

        let targetPath = '';

        // 支持通过会话 ID + 文件名安全读取会话 brain 目录下的产物图片
        if (convId && fileParam) {
          if (/[\\/\0]/.test(convId) || convId.includes('..') || /[\\/\0]/.test(fileParam) || fileParam.includes('..')) {
            sendJson(res, 400, { error: '非法的会话 ID 或文件名' });
            return;
          }
          const candidateRoots = [
            options.agCliDir ? path.resolve(options.agCliDir, 'brain', convId) : null,
            options.agDir ? path.resolve(options.agDir, 'brain', convId) : null,
            path.resolve(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId),
            path.resolve(os.homedir(), '.gemini', 'antigravity', 'brain', convId)
          ].filter(Boolean);
          for (const cRoot of candidateRoots) {
            const candidate = path.join(cRoot, fileParam);
            if (fs.existsSync(candidate)) {
              targetPath = candidate;
              break;
            }
          }
        }

        if (!targetPath && rawPath) {
          if (rawPath.includes('\0')) {
            sendJson(res, 400, { error: '无效的图片路径' });
            return;
          }
          let parsedCandidate = rawPath;
          if (parsedCandidate.startsWith('file://')) {
            try {
              parsedCandidate = url.fileURLToPath(parsedCandidate);
            } catch {
              sendJson(res, 400, { error: '无效的 file:// URL' });
              return;
            }
          }

          // 若直接传入相对文件名且提供了 convId，尝试在会话 brain 目录下查找
          if (convId && !path.isAbsolute(parsedCandidate) && !/[\\/]/.test(parsedCandidate)) {
            const candidateRoots = [
              options.agCliDir ? path.resolve(options.agCliDir, 'brain', convId) : null,
              options.agDir ? path.resolve(options.agDir, 'brain', convId) : null,
              path.resolve(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId),
              path.resolve(os.homedir(), '.gemini', 'antigravity', 'brain', convId)
            ].filter(Boolean);
            for (const cRoot of candidateRoots) {
              const candidate = path.join(cRoot, parsedCandidate);
              if (fs.existsSync(candidate)) {
                parsedCandidate = candidate;
                break;
              }
            }
          }

          targetPath = parsedCandidate;
        }

        if (!targetPath) {
          sendJson(res, 400, { error: '缺少图片路径 (path) 或会话参数 (convId + file)' });
          return;
        }

        const resolved = path.resolve(targetPath);
        const ext = path.extname(resolved).toLowerCase();
        const MIME_BY_EXT = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.bmp': 'image/bmp',
          '.svg': 'image/svg+xml'
        };
        const mime = MIME_BY_EXT[ext];
        if (!mime) {
          sendJson(res, 403, { error: '仅允许读取常见图片格式' });
          return;
        }
        const allowedRoots = [
          path.resolve(os.homedir(), '.gemini'),
          path.resolve(os.homedir(), '.config', 'agy-remote'),
          path.resolve(os.tmpdir()),
          path.resolve(getDefaultWorkspace()),
          path.resolve(fallbackUploadBase)
        ];
        if (options.agDir) allowedRoots.push(path.resolve(options.agDir));
        if (options.agCliDir) allowedRoots.push(path.resolve(options.agCliDir));
        if (process.env.AG_DIR) allowedRoots.push(path.resolve(process.env.AG_DIR));
        if (process.env.AG_CLI_DIR) allowedRoots.push(path.resolve(process.env.AG_CLI_DIR));
        const isAllowed = allowedRoots.some((root) => {
          const rel = path.relative(root, resolved);
          return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
        });
        if (!isAllowed) {
          sendJson(res, 403, { error: '禁止访问授权目录之外的文件' });
          return;
        }
        try {
          const st = await fs.promises.stat(resolved);
          if (!st.isFile() || st.size > MAX_UPLOAD_FILE_BYTES) {
            sendJson(res, 404, { error: '图片文件不存在或超出大小限制' });
            return;
          }
          const buf = await fs.promises.readFile(resolved);
          res.writeHead(200, {
            'Content-Type': mime,
            'Content-Length': buf.length,
            'Cache-Control': 'private, max-age=3600',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(buf);
        } catch {
          sendJson(res, 404, { error: '图片文件不存在或无法读取' });
        }
        return;
      }

      // 11. 安全读取已上传图片（严格防路径穿越）
      if (method === 'GET' && pathname.startsWith('/api/uploads/')) {
        const rawFile = pathname.slice('/api/uploads/'.length);
        let fileName = '';
        try {
          fileName = decodeURIComponent(rawFile);
        } catch {
          sendJson(res, 400, { error: '无效的文件名编码' });
          return;
        }

        if (!fileName || !/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName.includes('..')) {
          sendJson(res, 400, { error: '非法文件名（禁止路径穿越字符）' });
          return;
        }

        let resolvedFilePath = null;
        const registeredPath = uploadedFileRegistry.get(fileName);
        if (registeredPath && fs.existsSync(registeredPath)) {
          resolvedFilePath = registeredPath;
        } else {
          const searchRoots = [
            reqUrl.searchParams.get('workspace') ? path.resolve(reqUrl.searchParams.get('workspace')) : null,
            getDefaultWorkspace(),
            fallbackUploadBase
          ].filter(Boolean);

          for (const rootDir of searchRoots) {
            const uploadDir = path.resolve(rootDir, '.agy_uploads');
            const candidate = path.resolve(uploadDir, fileName);
            if (!candidate.startsWith(uploadDir + path.sep)) continue;
            try {
              if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                resolvedFilePath = candidate;
                break;
              }
            } catch {}
          }
        }

        if (!resolvedFilePath) {
          sendJson(res, 404, { error: '上传文件不存在' });
          return;
        }

        const ext = path.extname(resolvedFilePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        const data = await fs.promises.readFile(resolvedFilePath);
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': data.length,
          'Cache-Control': 'private, max-age=3600',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(data);
        return;
      }

      // 12. Token 历史热力图与 API 账单看板
      if (method === 'GET' && pathname === '/api/meter/history') {
        const rawSource = reqUrl.searchParams.get('source') || 'all';
        const sourceFilter = ['all', 'cli', 'desktop'].includes(rawSource) ? rawSource : 'all';
        const dashboard = meterEngine.getTokenHistoryDashboard({
          ...getMeterOpts(),
          sourceFilter
        });
        sendJson(res, 200, dashboard);
        return;
      }

      // 12.5 模型调用额度与使用限制（5h 滑动窗口与周额度）
      if (method === 'GET' && pathname === '/api/meter/usage-limits') {
        const limits = meterEngine.getUsageLimits(getMeterOpts());
        sendJson(res, 200, limits);
        return;
      }

      // 13. 查询 CLI 256K 上下文窗口解锁状态
      if (method === 'GET' && pathname === '/api/meter/unlock-status') {
        const queryBin = reqUrl.searchParams.get('binaryPath');
        const targetBin = queryBin || resolveAgyBinary(getAgyBinOption()).binPath || undefined;
        const status = await Promise.resolve(unlockBridge.getCliUnlockStatus(targetBin));
        sendJson(res, 200, status);
        return;
      }

      // 14. 应用或还原 CLI 上下文窗口解锁补丁
      if (method === 'POST' && pathname === '/api/meter/unlock') {
        const body = await readJsonBody(req);
        const targetBin = body.binaryPath || resolveAgyBinary(getAgyBinOption()).binPath || undefined;
        let result;
        if (body.action === 'restore' || body.mode === 'restore') {
          result = await Promise.resolve(unlockBridge.restoreCliContextUnlock({ binaryPath: targetBin }));
        } else {
          result = await Promise.resolve(
            unlockBridge.applyCliContextUnlock({
              mode: body.mode,
              limitTokens: body.limitTokens,
              binaryPath: targetBin
            })
          );
        }
        const statusCode = (result && result.ok === false && result.available !== false) ? 400 : 200;
        sendJson(res, statusCode, result);
        return;
      }

      // 15. 工作区 Git 状态与顶层目录文件概览
      if (method === 'GET' && pathname === '/api/workspace/overview') {
        const targetPath = reqUrl.searchParams.get('path') || getDefaultWorkspace();
        const overview = await inspectWorkspaceGit(targetPath);
        sendJson(res, 200, overview);
        return;
      }

      // 16. 项目分组列表与未分组统计
      if (method === 'GET' && pathname === '/api/projects') {
        const data = meterEngine.collectProjects(getMeterOpts());
        sendJson(res, 200, data);
        return;
      }

      // 17. 创建/绑定自定义项目（校验目录存在且非空路径）
      if (method === 'POST' && pathname === '/api/projects') {
        const body = await readJsonBody(req);
        const meterOpts = getMeterOpts();
        const project = meterEngine.addCustomProject(
          {
            name: body.name,
            path: body.path || body.workspacePath
          },
          meterOpts
        );
        const data = meterEngine.collectProjects(meterOpts);
        sendJson(res, 200, {
          ok: true,
          project,
          projects: data.projects,
          unassignedCount: data.unassignedCount,
          totalConversations: data.totalConversations
        });
        return;
      }

      // 18. 服务端目录浏览（含隐藏目录如 .gemini / .config）
      if (method === 'GET' && pathname === '/api/fs/dirs') {
        const queryPath = reqUrl.searchParams.get('path') || '';
        const listing = listDirectoriesSafe(queryPath, getDefaultWorkspace());
        sendJson(res, 200, listing);
        return;
      }

      // 19. 查询可切换账号列表与当前激活状态（禁止返回任何 token 密钥）
      if (method === 'GET' && pathname === '/api/settings/accounts') {
        const result = switchBridge.listAccounts(getSwitchOpts());
        sendJson(res, 200, result);
        return;
      }

      // 20. 切换 CLI 账号（OAuth 刷新并原子写入 CLI + Fallback token 文件）
      if (method === 'POST' && pathname === '/api/settings/accounts/switch') {
        const body = await readJsonBody(req);
        const fileName = body.fileName || body.file || '';
        const result = await switchBridge.switchAccount(fileName, getSwitchOpts());
        sendJson(res, 200, result);
        return;
      }

      // 21. 读取当前 CLI 代理设置
      if (method === 'GET' && pathname === '/api/settings/proxy') {
        const result = switchBridge.getProxyConfig(getSwitchOpts());
        sendJson(res, 200, result);
        return;
      }

      // 22. 保存代理设置（安全更新 ~/.local/bin/agy 包装脚本与可选 switch-agy.py，并清理模型缓存）
      if (method === 'POST' && pathname === '/api/settings/proxy') {
        const body = await readJsonBody(req);
        const result = switchBridge.saveProxyConfig(
          {
            enabled: body.enabled,
            proxyUrl: body.proxyUrl,
            syncSwitchPy: body.syncSwitchPy
          },
          getSwitchOpts()
        );
        clearModelsCache();
        sendJson(res, 200, result);
        return;
      }

      // 23. 测试代理端口可达性与 CONNECT 连通性（格式非法返回 400，网络不可达返回 200 + ok:false）
      if (method === 'POST' && pathname === '/api/settings/proxy/test') {
        const body = await readJsonBody(req);
        const result = await switchBridge.testProxyConnection(body.proxyUrl, getSwitchOpts());
        if (result && result.validationError) {
          sendJson(res, 400, result);
          return;
        }
        sendJson(res, 200, result);
        return;
      }

      // 24. 读取模型上下文窗口覆盖配置
      if (method === 'GET' && pathname === '/api/settings/model-ctx') {
        const result = meterEngine.getModelCtxOverrides(getMeterOpts());
        sendJson(res, 200, result);
        return;
      }

      // 25. 保存模型上下文窗口覆盖配置
      if (method === 'POST' && pathname === '/api/settings/model-ctx') {
        const body = await readJsonBody(req);
        const result = meterEngine.saveModelCtxOverrides(body, getMeterOpts());
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: `未知接口路由: ${method} ${pathname}` });
    } catch (err) {
      const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
      sendJson(res, status, { ok: false, error: err?.message || '服务器内部错误' });
    }
  });

  // 服务器关闭时自动清理残留子进程与长连接 SSE 流
  server.on('close', () => {
    for (const runner of activeRuns.values()) {
      try { runner.kill(); } catch {}
    }
    activeRuns.clear();
    for (const sseRes of activeSseResponses) {
      try {
        if (!sseRes.writableEnded) sseRes.end();
      } catch {}
    }
    activeSseResponses.clear();
  });

  return server;
}

/**
 * 启动 HTTP 服务监听
 * @param {object} [options]
 * @returns {Promise<{ server: http.Server, host: string, port: number, url: string }>}
 */
function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? DEFAULT_PORT);
  const host = String(options.host ?? process.env.HOST ?? DEFAULT_HOST);
  const server = createAppServer(options);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
      const url = `http://${displayHost}:${actualPort}`;
      const agyStatus = resolveAgyBinary(options.agyBin);
      const authMode = (options.authPassword || process.env.AGY_AUTH_PASSWORD) ? '已开启密码鉴权' : '未设置访问密码';
      console.log(`[agy-remote-control] 服务已启动: http://${host}:${actualPort}`);
      console.log(`[agy-remote-control] agy CLI 状态: ${agyStatus.found ? `${agyStatus.binPath} (${agyStatus.source})` : '未检测到 agy（将使用演示模式）'}`);
      console.log(`[agy-remote-control] 安全状态: ${authMode}`);
      resolve({ server, host, port: actualPort, url });
    });
  });
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[agy-remote-control] 启动失败:', err);
    process.exitCode = 1;
  });
}

module.exports = {
  createAppServer,
  startServer
};
