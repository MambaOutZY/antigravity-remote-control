'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const meterEngine = require('./meter-engine');

// 常用内置模型预设列表（仅在 agy models 未返回结果时兜底，对齐 Google 官方全系模型）
const BUILTIN_MODELS = [
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'gemini-4-argon',
  'gemini-4-carbon',
  'gemini-4-hydrogen',
  'gemini-4',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium'
];

// 模型列表缓存时间（60 秒）与 git diff 上限（64 KB）
const MODELS_CACHE_TTL_MS = 60 * 1000;
const MAX_GIT_DIFF_BYTES = 64 * 1024;
const MAX_TOP_LEVEL_FILES = 100;
const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules']);

let modelsCacheEpoch = 0;
let modelsCache = {
  key: '',
  expiresAt: 0,
  models: null,
  inFlight: null
};

/**
 * 清理模型列表内存缓存（切换账号或变更代理后调用）
 */
function clearModelsCache() {
  modelsCacheEpoch += 1;
  modelsCache = {
    key: '',
    expiresAt: 0,
    models: null,
    inFlight: null
  };
}

/**
 * 构造 agy 子进程环境变量：注入最新运行时代理配置；若显式关闭代理则剥离代理变量
 */
function buildChildEnv(extraEnv = {}, proxyOpts) {
  let env = { ...process.env, ...extraEnv };
  try {
    const switchBridge = require('./switch-bridge');
    if (typeof switchBridge.applyRuntimeProxyEnv === 'function') {
      env = switchBridge.applyRuntimeProxyEnv(env, proxyOpts);
    }
  } catch {
    // 代理桥接加载异常时保留当前环境
  }
  return env;
}

/**
 * 去除字符串中的 ANSI 转义序列，避免终端颜色符干扰解析
 */
function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * 扩展跨平台可执行文件名后缀
 */
function expandBinaryNames(baseName) {
  if (process.platform === 'win32') {
    return [`${baseName}.exe`, `${baseName}.cmd`, `${baseName}.bat`];
  }
  return [baseName];
}

/**
 * 从 Windows .cmd/.bat 包装脚本中尽量提取真实 .exe 路径，避免 Node 20+ spawn .cmd 触发 EINVAL
 */
function resolveWindowsShimTarget(shimPath) {
  const lower = shimPath.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return shimPath;
  try {
    const content = fs.readFileSync(shimPath, 'utf8');
    const match = content.match(/"([^"]*agy(?:-real)?\.exe)"/i);
    if (match && match[1]) {
      const candidate = match[1].replace(/%~dp0/gi, path.dirname(shimPath) + path.sep);
      const resolved = path.resolve(candidate);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
        return resolved;
      }
    }
    const siblingExe = path.join(path.dirname(shimPath), 'agy.exe');
    if (fs.existsSync(siblingExe) && fs.statSync(siblingExe).isFile()) {
      return siblingExe;
    }
  } catch {
    // 忽略解析异常，保留原 shim 路径
  }
  return shimPath;
}

/**
 * 检查二进制魔数或脚本头部，防止把普通文本、目录或无关文件误判为 agy 可执行文件
 */
function hasValidExecutableHeader(filePath) {
  const lower = filePath.toLowerCase();
  if (process.platform === 'win32' && (lower.endsWith('.cmd') || lower.endsWith('.bat'))) {
    return true;
  }
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    if (bytesRead < 2) return false;

    // 1. PE 可执行文件 (MZ)
    if (header[0] === 0x4d && header[1] === 0x5a) return true;
    // 2. ELF 可执行文件 (\x7fELF)
    if (bytesRead >= 4 && header.subarray(0, 4).toString('ascii') === '\x7fELF') return true;
    // 3. Mach-O / Universal 二进制魔数
    if (bytesRead >= 4) {
      const magicLE = header.readUInt32LE(0);
      if (
        magicLE === 0xfeedface ||
        magicLE === 0xcefaedfe ||
        magicLE === 0xfeedfacf ||
        magicLE === 0xcffaedfe ||
        magicLE === 0xcafebabe ||
        magicLE === 0xbebafeca
      ) {
        return true;
      }
    }
    // 4. 脚本包装器 (#! shebang)
    if (header[0] === 0x23 && header[1] === 0x21) return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

/**
 * 验证候选路径是否为可执行的 agy / agy-real 程序（排除目录、空文件、本项目自身文件及无权限文件）
 */
function validateAgyCandidate(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') return null;
  const trimmed = candidatePath.trim();
  if (!trimmed) return null;

  const resolved = path.resolve(trimmed);
  const projectRoot = path.resolve(__dirname, '..');
  if (resolved.startsWith(projectRoot + path.sep)) return null;
  if (resolved.includes(`${path.sep}node_modules${path.sep}`) || resolved.includes(`${path.sep}.git${path.sep}`)) {
    return null;
  }

  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size <= 0) return null;

    if (process.platform !== 'win32') {
      fs.accessSync(resolved, fs.constants.X_OK);
    } else {
      const ext = path.extname(resolved).toLowerCase();
      if (!['.exe', '.cmd', '.bat', '.com'].includes(ext)) return null;
    }

    if (!hasValidExecutableHeader(resolved)) return null;

    const finalBin = process.platform === 'win32'
      ? resolveWindowsShimTarget(resolved)
      : resolved;
    return {
      binPath: finalBin,
      launcherPath: resolved
    };
  } catch {
    return null;
  }
}

/**
 * 按约定优先级探测本机 Antigravity CLI (agy / agy-real) 可执行路径
 * @param {string|object} [customOption]
 * @returns {{ found: boolean, binPath: string|null, launcherPath?: string|null, source: string|null }}
 */
function resolveAgyBinary(customOption) {
  const explicitPath = typeof customOption === 'string'
    ? customOption
    : customOption?.binPath;

  if (explicitPath && String(explicitPath).trim()) {
    const hit = validateAgyCandidate(explicitPath);
    if (hit) {
      return { found: true, binPath: hit.binPath, launcherPath: hit.launcherPath, source: 'explicit' };
    }
    return { found: false, binPath: null, launcherPath: null, source: null };
  }

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  const candidates = [];

  // 1. 环境变量 AGY_BIN
  if (process.env.AGY_BIN && process.env.AGY_BIN.trim()) {
    candidates.push({ file: process.env.AGY_BIN.trim(), source: 'env:AGY_BIN' });
  }

  // 2. ~/.gemini/antigravity/bin/agy
  for (const name of [...expandBinaryNames('agy'), ...expandBinaryNames('agy-real')]) {
    candidates.push({
      file: path.join(home, '.gemini', 'antigravity', 'bin', name),
      source: 'gemini_bin'
    });
  }

  // 3. ~/.local/bin/agy
  for (const name of [...expandBinaryNames('agy'), ...expandBinaryNames('agy-real')]) {
    candidates.push({
      file: path.join(home, '.local', 'bin', name),
      source: 'local_bin'
    });
  }

  // 4. /usr/local/bin/agy（Unix 常见安装位置）
  if (process.platform !== 'win32') {
    candidates.push({ file: '/usr/local/bin/agy', source: 'usr_local_bin' });
    candidates.push({ file: '/usr/local/bin/agy-real', source: 'usr_local_bin' });
  }

  // 5. PATH 中的 agy / agy-real
  const pathDirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const baseName of ['agy', 'agy-real']) {
    for (const dir of pathDirs) {
      for (const fileName of expandBinaryNames(baseName)) {
        candidates.push({
          file: path.join(dir, fileName),
          source: `path:${baseName}`
        });
      }
    }
  }

  for (const item of candidates) {
    const hit = validateAgyCandidate(item.file);
    if (hit) {
      return {
        found: true,
        binPath: hit.binPath,
        launcherPath: hit.launcherPath,
        source: item.source
      };
    }
  }

  return { found: false, binPath: null, launcherPath: null, source: null };
}

/**
 * 解析 `agy models` 输出文本或 JSON，提取可用模型标识
 */
function parseModelsOutput(rawOutput) {
  const cleaned = stripAnsi(rawOutput).trim();
  if (!cleaned) return [];

  const stopWords = new Set([
    'model', 'models', 'id', 'name', 'provider', 'context', 'window',
    'status', 'available', 'default', 'alias', 'description', 'tier', 'true', 'false'
  ]);

  // 优先尝试 JSON 格式
  if (cleaned.startsWith('[') || cleaned.startsWith('{')) {
    try {
      const parsed = JSON.parse(cleaned);
      const list = Array.isArray(parsed) ? parsed : (parsed.models || parsed.data || []);
      if (Array.isArray(list)) {
        const ids = list
          .map(item => (typeof item === 'string' ? item : (item?.id || item?.model || item?.name || '')))
          .map(s => String(s).trim())
          .filter(s => /^[a-z0-9][a-z0-9._:-]{2,64}$/i.test(s) && !stopWords.has(s.toLowerCase()));
        if (ids.length > 0) return Array.from(new Set(ids));
      }
    } catch {
      // 回退到按行文本解析
    }
  }

  const found = [];
  for (const line of cleaned.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^[-=│|+]+$/.test(trimmed) || trimmed.startsWith('#')) continue;
    const withoutBullet = trimmed.replace(/^[-*•>\d.)\s]+/, '').trim();
    const firstToken = withoutBullet.split(/[\s|,;]+/)[0];
    if (!firstToken || !/^[a-z0-9][a-z0-9._:-]{2,64}$/i.test(firstToken)) continue;
    if (stopWords.has(firstToken.toLowerCase())) continue;
    if (!firstToken.includes('-') && !firstToken.includes('.')) continue;
    found.push(firstToken);
  }
  return Array.from(new Set(found));
}

/**
 * 以非阻塞方式执行一次短时 agy 子命令（兼容 Windows .cmd 并继承最新代理环境）
 */
function execAgyShort(binPath, args, timeoutMs = 3000, proxyOpts) {
  return new Promise((resolve) => {
    const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binPath);
    const cmd = isWinCmd ? (process.env.ComSpec || 'cmd.exe') : binPath;
    const cmdArgs = isWinCmd ? ['/d', '/c', binPath, ...args] : args;

    execFile(cmd, cmdArgs, {
      timeout: timeoutMs,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      env: buildChildEnv({}, proxyOpts)
    }, (err, stdout) => {
      if (err) return resolve('');
      resolve(String(stdout || ''));
    });
  });
}

/**
 * 获取可用模型列表（若存在 agy 则异步执行 `agy models`，60s 缓存并与内置预设去重合并）
 * @param {object} [options]
 * @returns {Promise<string[]>}
 */
async function getAvailableModels(options = {}) {
  const binInfo = resolveAgyBinary(options.binPath);
  const cacheKey = binInfo.found ? binInfo.binPath : 'none';
  const now = Date.now();

  if (modelsCache.models && modelsCache.key === cacheKey && now < modelsCache.expiresAt) {
    return [...modelsCache.models];
  }

  if (modelsCache.inFlight && modelsCache.key === cacheKey) {
    return modelsCache.inFlight;
  }

  const startEpoch = modelsCacheEpoch;
  const loadPromise = (async () => {
    let discovered = [];
    if (binInfo.found) {
      // agy models 需联网拉取，超时放宽到 8s 避免误回退到兜底列表
      const out = await execAgyShort(binInfo.binPath, ['models'], 8000, options.proxyOpts);
      discovered = parseModelsOutput(out);
    }
    // 真实检测到可用模型时仅返回真实列表，避免混入当前账号不可用的兜底模型
    const merged = discovered.length > 0 ? Array.from(new Set(discovered)) : [...BUILTIN_MODELS];
    if (modelsCacheEpoch === startEpoch) {
      modelsCache = {
        key: cacheKey,
        expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
        models: merged,
        inFlight: null
      };
    }
    return [...merged];
  })();

  modelsCache.key = cacheKey;
  modelsCache.inFlight = loadPromise;
  try {
    return await loadPromise;
  } catch {
    modelsCache.inFlight = null;
    return [...BUILTIN_MODELS];
  }
}

/**
 * 清理命令行参数中的控制字符与换行，防止参数注入异常
 */
function sanitizeArgValue(value) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\0\r\n]/g, '').trim();
}

/**
 * 根据请求参数组装 `agy` CLI 参数数组与拼接附件提示词
 */
function buildAgyArgs(options = {}) {
  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const prefixLines = [];
  const addDirSet = new Set();

  for (const att of attachments) {
    if (!att || !att.path) continue;
    const resolvedPath = path.resolve(String(att.path));
    const dimText = (att.width && att.height)
      ? `${att.width}×${att.height}`
      : (att.dimensions ? String(att.dimensions) : '');
    const dimPart = dimText ? ` (${dimText})` : '';
    prefixLines.push(`[附件图片: ${resolvedPath}${dimPart} - 请调用 read_file 查看该文件]`);
    addDirSet.add(path.dirname(resolvedPath));
  }

  const rawPrompt = String(options.prompt || '');
  const finalPrompt = prefixLines.length > 0
    ? `${prefixLines.join('\n')}\n\n${rawPrompt}`
    : rawPrompt;

  const args = ['-p', finalPrompt, '--output-format', 'stream-json'];

  const conversationId = sanitizeArgValue(options.conversationId);
  if (conversationId) {
    args.push('--conversation', conversationId);
  } else if (options.continueLast === true) {
    args.push('-c');
  }

  const project = sanitizeArgValue(options.project);
  if (project) args.push('--project', project);

  const model = sanitizeArgValue(options.model);
  if (model) args.push('--model', model);

  const effort = sanitizeArgValue(options.effort);
  if (effort) args.push('--effort', effort);

  const mode = sanitizeArgValue(options.mode);
  if (mode) args.push('--mode', mode);

  if (options.skipPermissions === true) {
    args.push('--dangerously-skip-permissions');
  }

  const addDirs = Array.from(addDirSet);
  for (const dir of addDirs) {
    args.push('--add-dir', dir);
  }

  return { args, finalPrompt, addDirs };
}

/**
 * 归一化单条 usage 对象为标准结构
 */
function normalizeUsagePayload(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const inputTokens = Number(rawUsage.inputTokens ?? rawUsage.input_tokens ?? rawUsage.prompt_tokens ?? rawUsage.input ?? 0) || 0;
  const cacheReadTokens = Number(
    rawUsage.cacheReadTokens ?? rawUsage.cache_read_tokens ?? rawUsage.cache_read_input_tokens ?? rawUsage.cached_tokens ?? rawUsage.cached ?? 0
  ) || 0;
  const outputTokens = Number(rawUsage.outputTokens ?? rawUsage.output_tokens ?? rawUsage.completion_tokens ?? rawUsage.output ?? 0) || 0;
  const thinkingTokens = Number(rawUsage.thinkingTokens ?? rawUsage.thinking_output_tokens ?? rawUsage.reasoning_tokens ?? 0) || 0;
  const totalTokens = Number(rawUsage.totalTokens ?? rawUsage.total_tokens ?? (inputTokens + cacheReadTokens + outputTokens)) || 0;

  return {
    inputTokens,
    cacheReadTokens,
    outputTokens,
    thinkingTokens,
    totalTokens
  };
}

/**
 * 从多种 stream-json 格式中提取文本片段
 */
function extractTextFromEvent(obj) {
  if (typeof obj.delta === 'string') return obj.delta;
  if (obj.delta && typeof obj.delta.text === 'string') return obj.delta.text;
  if (obj.delta && typeof obj.delta.content === 'string') return obj.delta.content;
  if (typeof obj.text === 'string') return obj.text;
  if (typeof obj.content === 'string') return obj.content;
  if (obj.content_block && typeof obj.content_block.text === 'string') return obj.content_block.text;
  return '';
}

/**
 * 将单条 stream-json 对象映射为统一的事件数组
 */
function parseStreamJsonEvents(obj, state, currentModel) {
  if (!obj || typeof obj !== 'object') return [];
  const events = [];

  const convId = obj.conversation_id || obj.conversationId || obj.session_id || obj.sessionId || obj.cascadeId ||
    obj.step_update?.conversation_id || obj.result?.conversation_id || null;
  if (convId && !state.conversationId) {
    state.conversationId = String(convId);
  }

  // real agy CLI 使用 obj.event（如 init / step_update / result），兼容部分格式使用 obj.type
  const rawType = String(obj.type || obj.event || '').toLowerCase();

  // 1. 状态与初始化事件
  if (['init', 'system', 'status', 'session', 'start'].includes(rawType)) {
    events.push({
      type: 'status',
      status: obj.status || obj.subtype || rawType,
      message: obj.message || '',
      conversationId: state.conversationId,
      model: obj.model || obj.init?.model || currentModel || null
    });
  }

  // 1.5 real agy CLI 的 step_update 流式事件
  if (rawType === 'step_update' && obj.step_update && typeof obj.step_update === 'object') {
    const su = obj.step_update;
    const stepType = String(su.step_type || '').toLowerCase();
    const thinkDelta = typeof su.thinking_delta === 'string'
      ? su.thinking_delta
      : (typeof su.thought_delta === 'string'
        ? su.thought_delta
        : ((stepType.includes('think') || stepType.includes('thought') || stepType.includes('reason'))
          ? (su.text_delta || su.delta || '')
          : ''));
    if (thinkDelta) {
      events.push({ type: 'thinking', delta: thinkDelta, content: thinkDelta });
    } else if (typeof su.text_delta === 'string' && su.text_delta.length > 0) {
      events.push({ type: 'text', delta: su.text_delta, content: su.text_delta });
    }

    if (su.tool_call || su.tool_name || stepType.includes('tool')) {
      const tc = su.tool_call || su;
      events.push({
        type: 'tool_call',
        id: tc.id || tc.tool_use_id || (su.step_index !== undefined ? `step-${su.step_index}` : null),
        name: tc.name || tc.tool_name || su.step_type || 'tool',
        status: String(su.state || '').toUpperCase() === 'DONE' ? 'completed' : 'running',
        input: tc.input ?? tc.args ?? tc.arguments ?? null,
        output: tc.output ?? tc.result ?? null,
        isError: Boolean(tc.is_error || su.is_error)
      });
    }

    const suUsage = normalizeUsagePayload(su.usage);
    if (suUsage && (suUsage.totalTokens > 0 || suUsage.outputTokens > 0 || suUsage.inputTokens > 0)) {
      events.push({ type: 'usage', usage: suUsage, model: su.model || currentModel || null });
    }
  }

  // 2. 错误事件（交给 meter-engine 进行 8 类诊断归因）
  const resultErr = (rawType === 'result' && obj.result && typeof obj.result === 'object' &&
    (obj.result.status === 'ERROR' || obj.result.error))
    ? (obj.result.error || 'CLI 返回错误')
    : null;
  if (rawType === 'error' || obj.error || obj.is_error === true || resultErr) {
    const errRaw = resultErr || (typeof obj.error === 'string'
      ? obj.error
      : (obj.error?.message || obj.message || (typeof obj.result === 'string' ? obj.result : 'CLI 返回未知错误')));
    const classification = typeof meterEngine.classifyError === 'function'
      ? meterEngine.classifyError(errRaw, currentModel)
      : { kind: 'unknown', title: '错误', badgeText: '错误', detail: errRaw, diagnostic: errRaw };
    events.push({
      type: 'error',
      message: errRaw,
      error: errRaw,
      classification
    });
  }

  // 3. 思考过程事件
  if (
    ['thinking', 'thought', 'reasoning', 'thinking_delta'].includes(rawType) ||
    obj.delta?.type === 'thinking_delta' ||
    (typeof obj.thinking === 'string' && obj.thinking.length > 0)
  ) {
    const thinkDelta = typeof obj.thinking === 'string'
      ? obj.thinking
      : (typeof obj.delta?.thinking === 'string' ? obj.delta.thinking : extractTextFromEvent(obj));
    if (thinkDelta) {
      events.push({ type: 'thinking', delta: thinkDelta, content: thinkDelta });
    }
  }

  // 4. 工具调用与工具结果事件
  if (
    ['tool_call', 'tool_use', 'tool_result', 'function_call', 'function_response'].includes(rawType) ||
    obj.tool_call ||
    obj.toolCall ||
    (rawType === 'content_block_start' && obj.content_block?.type === 'tool_use')
  ) {
    const tc = obj.tool_call || obj.toolCall || obj.content_block || obj;
    events.push({
      type: 'tool_call',
      id: tc.id || tc.tool_use_id || obj.id || null,
      name: tc.name || tc.tool || obj.name || 'tool',
      status: tc.status || (rawType === 'tool_result' || rawType === 'function_response' ? 'completed' : 'running'),
      input: tc.input ?? tc.args ?? tc.arguments ?? null,
      output: tc.output ?? tc.result ?? (rawType === 'tool_result' ? obj.content : null),
      isError: Boolean(tc.is_error || obj.is_error)
    });
  }

  // 5. 复合 assistant/user 消息数组（如 content: [{type:'thinking'|'tool_use'|'text'}]）
  if ((rawType === 'assistant' || rawType === 'user') && Array.isArray(obj.message?.content)) {
    for (const block of obj.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' && block.thinking) {
        events.push({ type: 'thinking', delta: block.thinking, content: block.thinking });
      } else if (block.type === 'tool_use') {
        events.push({
          type: 'tool_call',
          id: block.id || null,
          name: block.name || 'tool',
          status: 'running',
          input: block.input ?? null,
          output: null,
          isError: false
        });
      } else if (block.type === 'tool_result') {
        events.push({
          type: 'tool_call',
          id: block.tool_use_id || null,
          name: block.name || 'tool_result',
          status: 'completed',
          input: null,
          output: block.content ?? null,
          isError: Boolean(block.is_error)
        });
      } else if (block.type === 'text' && block.text) {
        events.push({ type: 'text', delta: block.text, content: block.text });
      }
    }
  }

  // 6. 普通文本增量事件
  const isTextType = ['text', 'delta', 'text_delta', 'content', 'message', 'assistant_delta'].includes(rawType) ||
    (rawType === 'content_block_delta' && obj.delta?.type === 'text_delta') ||
    (!rawType && (typeof obj.delta === 'string' || typeof obj.content === 'string'));
  if (isTextType) {
    const delta = extractTextFromEvent(obj);
    if (delta) {
      events.push({ type: 'text', delta, content: delta });
    }
  }

  // 7. 最终 result 事件仅在尚未收到增量正文时补充正文
  if (rawType === 'result' && !state.hasStreamedText) {
    const finalText = typeof obj.result === 'string'
      ? obj.result
      : (typeof obj.result?.response === 'string' ? obj.result.response : extractTextFromEvent(obj));
    if (finalText) {
      events.push({ type: 'text', delta: finalText, content: finalText });
    }
  }

  // 8. Token 用量统计
  const usageRaw = obj.usage || obj.message?.usage || obj.result?.usage || obj.stats || (rawType === 'usage' ? obj : null);
  const normUsage = normalizeUsagePayload(usageRaw);
  if (normUsage && (normUsage.totalTokens > 0 || normUsage.outputTokens > 0 || normUsage.inputTokens > 0)) {
    events.push({ type: 'usage', usage: normUsage, model: obj.model || currentModel || null });
  }

  return events;
}

/**
 * 计算本次生成的 TTFT、TPS、总耗时及估算/实测 Token 汇总
 */
function buildFinalMetrics(state, promptText) {
  const durationSec = Math.max(0.01, (Date.now() - state.startMs) / 1000);
  const ttft = state.firstTokenMs !== null
    ? Number(Math.max(0, (state.firstTokenMs - state.startMs) / 1000).toFixed(2))
    : null;

  let usage = state.usage ? { ...state.usage } : null;
  let estimated = false;
  if (!usage || (usage.outputTokens === 0 && (state.textText.length > 0 || state.thinkingText.length > 0))) {
    const measureFn = typeof meterEngine.measureText === 'function'
      ? meterEngine.measureText
      : (t) => ({ estimate: Math.ceil(String(t || '').length / 3) });
    const inEst = measureFn(promptText).estimate || 0;
    const outEst = measureFn(state.textText + state.thinkingText).estimate || 0;
    const thinkEst = measureFn(state.thinkingText).estimate || 0;
    usage = {
      inputTokens: usage?.inputTokens || inEst,
      cacheReadTokens: usage?.cacheReadTokens || 0,
      outputTokens: usage?.outputTokens || outEst,
      thinkingTokens: usage?.thinkingTokens || thinkEst,
      totalTokens: (usage?.inputTokens || inEst) + (usage?.cacheReadTokens || 0) + (usage?.outputTokens || outEst)
    };
    estimated = true;
  }

  const tps = usage.outputTokens > 0 && durationSec > 0
    ? Number((usage.outputTokens / durationSec).toFixed(1))
    : null;

  return {
    duration: Number(durationSec.toFixed(2)),
    ttft,
    tps,
    estimated,
    usage
  };
}

/**
 * 本地演示/测试模式：无 agy 可执行文件或开启 mock 时模拟真实流式事件
 */
function runMockAgyStream(options, finalPrompt, cliArgs, onEvent) {
  const startMs = Date.now();
  const state = {
    startMs,
    firstTokenMs: null,
    textText: '',
    thinkingText: '',
    usage: null,
    conversationId: sanitizeArgValue(options.conversationId) || `demo-${Date.now().toString(36)}`,
    hasStreamedText: false,
    errorEmitted: false,
    aborted: false,
    doneEmitted: false
  };

  const timers = [];
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });

  const safeEmit = (evt) => {
    if (state.aborted && evt.type !== 'done') return;
    if ((evt.type === 'thinking' || evt.type === 'text' || evt.type === 'tool_call') && state.firstTokenMs === null) {
      state.firstTokenMs = Date.now();
    }
    if (evt.type === 'thinking') state.thinkingText += evt.delta || '';
    if (evt.type === 'text') {
      state.textText += evt.delta || '';
      state.hasStreamedText = true;
    }
    onEvent(evt);
  };

  const finish = () => {
    if (state.doneEmitted) return;
    state.doneEmitted = true;
    for (const t of timers) clearTimeout(t);
    const metrics = buildFinalMetrics(state, finalPrompt);
    safeEmit({
      type: 'usage',
      usage: metrics.usage,
      ttft: metrics.ttft,
      tps: metrics.tps,
      duration: metrics.duration,
      outputTokens: metrics.usage?.outputTokens ?? null,
      estimated: true,
      mock: true
    });
    onEvent({
      type: 'done',
      ok: !state.aborted,
      aborted: state.aborted,
      exitCode: state.aborted ? 130 : 0,
      mock: true,
      conversationId: state.conversationId,
      model: options.model || 'gemini-4-argon',
      ttft: metrics.ttft,
      tps: metrics.tps,
      duration: metrics.duration,
      outputTokens: metrics.usage?.outputTokens ?? null,
      usage: metrics.usage
    });
    resolveDone({ ok: !state.aborted, mock: true, conversationId: state.conversationId, ...metrics });
  };

  const attachments = Array.isArray(options.attachments) ? options.attachments : [];
  const attLine = attachments.length > 0
    ? `\n- 已挂载图片附件 ${attachments.length} 个（将通过 \`--add-dir\` 授权给 CLI 读取）：${attachments.map(a => `${a.name} (${a.width || '?'}×${a.height || '?'})`).join('，')}`
    : '';

  const steps = [
    {
      delay: 20,
      evt: {
        type: 'status',
        mode: 'mock',
        status: 'demo',
        message: '当前处于本地演示/测试模式（Ubuntu 服务器安装 agy 后将自动切换真实 CLI 并复用原账号配额）',
        conversationId: state.conversationId,
        args: cliArgs
      }
    },
    {
      delay: 60,
      evt: {
        type: 'thinking',
        delta: `[演示模式思考] 正在解析指令与工作区上下文（model=${options.model || 'gemini-4-argon'}, effort=${options.effort || 'high'}, mode=${options.mode || 'auto'}）...`,
        content: `[演示模式思考] 正在解析指令与工作区上下文（model=${options.model || 'gemini-4-argon'}, effort=${options.effort || 'high'}, mode=${options.mode || 'auto'}）...`
      }
    },
    {
      delay: 110,
      evt: {
        type: 'tool_call',
        id: 'mock-tool-1',
        name: attachments.length > 0 ? 'read_file' : 'inspect_workspace',
        status: 'running',
        input: attachments.length > 0 ? { path: attachments[0].path } : { cwd: options.workspace || process.cwd() }
      }
    },
    {
      delay: 155,
      evt: {
        type: 'tool_call',
        id: 'mock-tool-1',
        name: attachments.length > 0 ? 'read_file' : 'inspect_workspace',
        status: 'completed',
        output: attachments.length > 0 ? `已读取附件元信息: ${attachments[0].path}` : '工作区检查完成'
      }
    },
    {
      delay: 200,
      evt: {
        type: 'text',
        delta: '**[本地演示 / 测试模式]** 当前环境未检测到真实的 `agy` 可执行文件（或请求指定了 `mock: true`），以下为模拟流式响应。\n\n'
      }
    },
    {
      delay: 245,
      evt: {
        type: 'text',
        delta: `已收到指令：\n> ${String(options.prompt || '').slice(0, 240)}\n\n运行配置：\n- 模型：\`${options.model || 'gemini-4-argon'}\` ｜ 推理档位：\`${options.effort || 'high'}\` ｜ 权限模式：\`${options.mode || 'auto'}\`${attLine}\n`
      }
    },
    {
      delay: 290,
      evt: {
        type: 'text',
        delta: '\n部署至 Ubuntu 生产环境且检测到 `agy` 后，系统将自动以无交互模式调用真实 `agy` 子进程并 100% 复用本机登录账号配额。'
      }
    }
  ];

  for (const step of steps) {
    timers.push(setTimeout(() => safeEmit(step.evt), step.delay));
  }
  timers.push(setTimeout(finish, 330));

  return {
    kill: () => {
      state.aborted = true;
      finish();
    },
    done
  };
}

/**
 * 流式执行一轮 agy 对话（支持真实 CLI 子进程与无 CLI 优雅降级演示）
 * @param {object} options
 * @param {(event: object) => void} onEvent
 * @returns {{ kill: () => void, done: Promise<object> }}
 */
function streamAgyTurn(options = {}, onEvent = () => {}) {
  const { args, finalPrompt } = buildAgyArgs(options);
  const binInfo = resolveAgyBinary(options.binPath);

  if (options.mock === true || !binInfo.found) {
    return runMockAgyStream(options, finalPrompt, args, onEvent);
  }

  const cwd = (options.workspace && fs.existsSync(options.workspace) && fs.statSync(options.workspace).isDirectory())
    ? path.resolve(options.workspace)
    : process.cwd();

  const isWinCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binInfo.binPath);
  const spawnCmd = isWinCmd ? (process.env.ComSpec || 'cmd.exe') : binInfo.binPath;
  const spawnArgs = isWinCmd ? ['/d', '/c', binInfo.binPath, ...args] : args;

  const child = spawn(spawnCmd, spawnArgs, {
    cwd,
    env: buildChildEnv({ NO_COLOR: '1' }, options.proxyOpts),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const state = {
    startMs: Date.now(),
    firstTokenMs: null,
    textText: '',
    thinkingText: '',
    usage: null,
    conversationId: sanitizeArgValue(options.conversationId) || null,
    hasStreamedText: false,
    hasJsonEvents: false,
    errorEmitted: false,
    aborted: false,
    doneEmitted: false,
    stderrTail: ''
  };

  let stdoutBuffer = '';
  let killTimer = null;
  let resolveDone;
  const done = new Promise((res) => { resolveDone = res; });

  const emit = (evt) => {
    if ((evt.type === 'thinking' || evt.type === 'text' || evt.type === 'tool_call') && state.firstTokenMs === null) {
      state.firstTokenMs = Date.now();
    }
    if (evt.type === 'thinking') state.thinkingText += evt.delta || '';
    if (evt.type === 'text') {
      state.textText += evt.delta || '';
      state.hasStreamedText = true;
    }
    if (evt.type === 'usage' && evt.usage) state.usage = evt.usage;
    if (evt.type === 'error') state.errorEmitted = true;
    onEvent(evt);
  };

  const processLine = (rawLine) => {
    const line = String(rawLine || '').replace(/\r$/, '').trim();
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      state.hasJsonEvents = true;
      const mapped = parseStreamJsonEvents(obj, state, options.model);
      for (const evt of mapped) emit(evt);
    } catch {
      // 兼容少数非 JSON 行（如日志提示或纯文本回退）
      if (!state.hasJsonEvents && !/^\[(INFO|DEBUG|WARN)\]/i.test(line)) {
        emit({ type: 'text', delta: `${line}\n`, content: `${line}\n` });
      }
    }
  };

  const finalize = (code, signal) => {
    if (state.doneEmitted) return;
    state.doneEmitted = true;
    if (killTimer) clearTimeout(killTimer);

    if (!state.aborted && code !== 0 && !state.errorEmitted) {
      // 优先提取 stderr 中的 error: 行，避免前面的 warning: 提示掩盖真实错误
      const stderrLines = state.stderrTail.trim().split(/\r?\n/).filter(Boolean);
      const errorLines = stderrLines.filter((l) => /^error:/i.test(l.trim()));
      const errMsg = (errorLines.length > 0 ? errorLines.join('\n') : stderrLines.join('\n')) ||
        `agy 进程退出异常 (code=${code ?? 'null'}, signal=${signal || 'none'})`;
      const classification = typeof meterEngine.classifyError === 'function'
        ? meterEngine.classifyError(errMsg, options.model)
        : { kind: 'unknown', title: '执行失败', badgeText: '失败', detail: errMsg, diagnostic: errMsg };
      emit({ type: 'error', message: errMsg, error: errMsg, classification });
    }

    const metrics = buildFinalMetrics(state, finalPrompt);
    emit({
      type: 'usage',
      usage: metrics.usage,
      ttft: metrics.ttft,
      tps: metrics.tps,
      duration: metrics.duration,
      outputTokens: metrics.usage?.outputTokens ?? null,
      estimated: metrics.estimated,
      mock: false
    });

    onEvent({
      type: 'done',
      ok: !state.aborted && code === 0 && !state.errorEmitted,
      aborted: state.aborted,
      exitCode: code,
      mock: false,
      conversationId: state.conversationId,
      model: options.model || null,
      ttft: metrics.ttft,
      tps: metrics.tps,
      duration: metrics.duration,
      outputTokens: metrics.usage?.outputTokens ?? null,
      usage: metrics.usage
    });

    resolveDone({
      ok: !state.aborted && code === 0 && !state.errorEmitted,
      mock: false,
      conversationId: state.conversationId,
      ...metrics
    });
  };

  emit({
    type: 'status',
    mode: 'cli',
    status: 'running',
    message: `已启动真实 agy CLI (${binInfo.binPath})`,
    conversationId: state.conversationId
  });

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString('utf8');
    let nlIdx = stdoutBuffer.indexOf('\n');
    while (nlIdx >= 0) {
      const line = stdoutBuffer.slice(0, nlIdx);
      stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
      processLine(line);
      nlIdx = stdoutBuffer.indexOf('\n');
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8');
    state.stderrTail = (state.stderrTail + text).slice(-8192);
  });

  child.on('error', (err) => {
    const errMsg = `启动 agy 子进程失败: ${err.message}`;
    const classification = typeof meterEngine.classifyError === 'function'
      ? meterEngine.classifyError(errMsg, options.model)
      : { kind: 'unknown', title: '启动失败', badgeText: '失败', detail: errMsg, diagnostic: errMsg };
    emit({ type: 'error', message: errMsg, error: errMsg, classification });
    finalize(1, null);
  });

  child.on('close', (code, signal) => {
    if (stdoutBuffer.trim()) processLine(stdoutBuffer);
    stdoutBuffer = '';
    finalize(code, signal);
  });

  return {
    kill: () => {
      state.aborted = true;
      try { child.kill('SIGTERM'); } catch {}
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 1500);
      if (killTimer.unref) killTimer.unref();
    },
    done
  };
}

/**
 * 以流方式安全执行 Git 命令，严格限制最大输出字节以防超大 diff 卡死
 */
function runGitCommandLimited(cwd, args, maxBytes = MAX_GIT_DIFF_BYTES, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    const chunks = [];
    let collected = 0;
    let truncated = false;
    let settled = false;

    const timer = setTimeout(() => {
      truncated = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (chunk) => {
      if (collected >= maxBytes) {
        truncated = true;
        try { child.kill('SIGTERM'); } catch {}
        return;
      }
      const remain = maxBytes - collected;
      if (chunk.length > remain) {
        chunks.push(chunk.subarray(0, remain));
        collected += remain;
        truncated = true;
        try { child.kill('SIGTERM'); } catch {}
      } else {
        chunks.push(chunk);
        collected += chunk.length;
      }
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 || truncated,
        stdout: Buffer.concat(chunks).toString('utf8'),
        truncated
      });
    };

    child.on('error', () => finish(1));
    child.on('close', (code) => finish(code));
  });
}

/**
 * 扫描工作区顶层文件与目录（最多 100 项，自动跳过 .git 与 node_modules）
 */
async function listWorkspaceTopLevel(targetDir) {
  const entries = await fs.promises.readdir(targetDir, { withFileTypes: true });
  const visible = entries.filter(e => !IGNORED_DIR_NAMES.has(e.name));
  visible.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    return a.name.localeCompare(b.name);
  });

  const sliced = visible.slice(0, MAX_TOP_LEVEL_FILES);
  const files = await Promise.all(sliced.map(async (entry) => {
    let size = null;
    if (entry.isFile()) {
      try {
        const st = await fs.promises.stat(path.join(targetDir, entry.name));
        size = st.size;
      } catch {
        size = null;
      }
    }
    return {
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      size
    };
  }));

  return {
    files,
    totalCount: visible.length,
    filesTruncated: visible.length > MAX_TOP_LEVEL_FILES
  };
}

/**
 * 检查工作区目录存在性、Git 分支/状态/Diff（最大 64KB）及顶层文件列表
 * @param {string} workspaceDir
 */
async function inspectWorkspaceGit(workspaceDir) {
  const targetDir = path.resolve(String(workspaceDir || process.cwd()));
  try {
    const st = await fs.promises.stat(targetDir);
    if (!st.isDirectory()) {
      return {
        exists: false,
        path: targetDir,
        isGit: false,
        isGitRepo: false,
        branch: null,
        status: [],
        changes: [],
        statusRaw: '',
        statusText: '',
        porcelain: '',
        diff: '',
        diffTruncated: false,
        files: [],
        filesTruncated: false,
        error: '指定路径不是有效目录'
      };
    }
  } catch {
    return {
      exists: false,
      path: targetDir,
      isGit: false,
      isGitRepo: false,
      branch: null,
      status: [],
      changes: [],
      statusRaw: '',
      statusText: '',
      porcelain: '',
      diff: '',
      diffTruncated: false,
      files: [],
      filesTruncated: false,
      error: '工作区目录不存在或无法访问'
    };
  }

  const [{ files, totalCount, filesTruncated }, branchRes] = await Promise.all([
    listWorkspaceTopLevel(targetDir),
    runGitCommandLimited(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD'], 1024, 3000)
  ]);

  const branch = branchRes.ok ? branchRes.stdout.trim() : '';
  if (!branch) {
    return {
      exists: true,
      path: targetDir,
      isGit: false,
      isGitRepo: false,
      branch: null,
      status: [],
      changes: [],
      statusRaw: '',
      statusText: '',
      porcelain: '',
      diff: '',
      diffTruncated: false,
      files,
      totalFiles: totalCount,
      filesTruncated
    };
  }

  const [statusRes, diffRes] = await Promise.all([
    runGitCommandLimited(targetDir, ['status', '--porcelain'], MAX_GIT_DIFF_BYTES, 4000),
    runGitCommandLimited(targetDir, ['diff'], MAX_GIT_DIFF_BYTES, 4000)
  ]);

  const statusRaw = statusRes.stdout || '';
  const status = statusRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const code = line.slice(0, 2).trim() || line.slice(0, 2);
      const filePath = line.slice(3).trim();
      return { code, status: code, path: filePath };
    });

  const diff = diffRes.truncated
    ? `${diffRes.stdout}\n... [diff 已超过 64KB 限制，后续内容已截断]`
    : diffRes.stdout;

  return {
    exists: true,
    path: targetDir,
    isGit: true,
    isGitRepo: true,
    branch,
    status,
    changes: status,
    statusRaw,
    statusText: statusRaw,
    porcelain: statusRaw,
    diff,
    diffTruncated: diffRes.truncated,
    files,
    totalFiles: totalCount,
    filesTruncated
  };
}

module.exports = {
  BUILTIN_MODELS,
  resolveAgyBinary,
  getAvailableModels,
  listAvailableModels: getAvailableModels, // 导出兼容别名，防止调用处方法名不一致
  clearModelsCache,
  buildChildEnv,
  buildAgyArgs,
  streamAgyTurn,
  inspectWorkspaceGit
};
