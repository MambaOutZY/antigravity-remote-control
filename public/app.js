/* ============================================================================
 * AGY Remote 私有控制台前端核心脚本
 * 零外部依赖：内置 Markdown/代码高亮渲染、SSE 流式消费、Context Viewer 双面板、
 * 52 周热力图与 API 等值账单、图片粘贴/拖拽上传与上下文窗口解锁控制
 * ============================================================================ */

(() => {
  'use strict';

  // --------------------------------------------------------------------------
  // 常量与全局状态定义
  // --------------------------------------------------------------------------
  const RING_RADIUS = 7;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const DEFAULT_BUDGET = 256000;

  // 8 类错误诊断标签映射（与后端 meter-engine classifyError 保持对齐）
  const ERROR_KIND_META = {
    none: { label: '正常', title: '运行正常' },
    context_overflow: { label: '超限', title: '上下文容量超限' },
    quota_exhausted: { label: '额度耗尽', title: '模型配额池耗尽' },
    rate_limited: { label: '限流', title: '请求触发限流 (429)' },
    auth_error: { label: '认证', title: '身份认证或权限失败' },
    service_unavailable: { label: '服务异常', title: '上游服务暂不可用' },
    network_error: { label: '网络', title: '网络连接异常或超时' },
    canceled: { label: '已取消', title: '生成任务已主动中止' },
    unknown: { label: '待确认', title: '异常原因待确认' }
  };

  // 全局状态中心
  const state = {
    theme: localStorage.getItem('agy_theme') || 'dark',
    authRequired: false,
    authenticated: true,
    agyStatus: { found: false, binPath: '', source: '' },
    workspace: localStorage.getItem('agy_workspace') || '',
    models: [],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    modes: ['auto', 'accept-edits', 'plan'],
    conversations: [],
    convSearch: '',
    convFilter: 'active',
    renamingConvId: null,
    contextMenuConvId: null,
    activeConversationId: null,
    activeConversationTitle: '新建远程会话',
    activeConversationDetail: null,
    messages: [],
    pendingAttachments: [],
    sessionSentAttachments: [],
    streaming: {
      active: false,
      runId: null,
      abortController: null,
      assistantMsgId: null
    },
    contextMetrics: {
      used: 0,
      actual: null,
      estimate: null,
      budget: DEFAULT_BUDGET,
      percent: 0,
      tps: null,
      ttft: null,
      duration: null,
      outputTokens: null,
      model: '',
      errorClassification: { kind: 'none', badgeText: '正常', title: '正常', detail: '', diagnostic: '' },
      groups: {
        user: { tokens: 0, chars: 0 },
        assistant: { tokens: 0, chars: 0 },
        thinking: { tokens: 0, chars: 0 },
        tools: { tokens: 0, chars: 0 },
        summaries: { tokens: 0, chars: 0 }
      },
      totalChars: 0,
      totalTokens: 0
    },
    unlockStatus: null,
    historyData: null,
    historySource: 'all',
    speedMetricMode: 'tps',
    workspaceOverview: null,
    activeAuxTab: 'git',
    auxCollapsed: localStorage.getItem('agy_aux_collapsed') === '1',
    // 多标签面板、项目分组与目录选择器状态
    projects: [],
    activeProjectId: '',
    collapsedProjects: {},
    expandedProjects: {},
    activeCtxTab: 'current',
    activeHistTab: 'heatmap',
    ctxSpeedRange: '7',
    ctxSpeedSource: 'all',
    ctxSpeedMetric: 'tps',
    ctxSpeedTrendKey: '',
    cumMetric: 'tokens',
    modelCtxOverrides: {},
    accountsData: null,
    proxyConfig: null,
    dirPicker: {
      currentPath: '',
      parentPath: null,
      mode: 'workspace'
    }
  };

  // DOM 缓存（简化后续查询）
  const $ = (id) => document.getElementById(id);

  // --------------------------------------------------------------------------
  // 通用格式化与安全工具函数
  // --------------------------------------------------------------------------

  /** HTML 实体转义，防止 XSS 注入 */
  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 将 Token 数量格式化为紧凑 K / M 字符串 */
  function formatTokensCompact(num) {
    if (num === null || num === undefined || !Number.isFinite(Number(num))) return '--';
    const n = Number(num);
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(Math.round(n));
  }

  /** 将字节数格式化为 KB / MB */
  function formatBytes(bytes) {
    const b = Number(bytes || 0);
    if (!Number.isFinite(b) || b <= 0) return '0 B';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
  }

  /** 格式化相对时间或简短时间 */
  function formatTimeShort(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diffSec < 60 && diffSec >= 0) return '刚刚';
    if (diffSec < 3600 && diffSec >= 0) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400 && diffSec >= 0) return `${Math.floor(diffSec / 3600)} 小时前`;
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}-${day} ${hh}:${mm}`;
  }

  /** 格式化侧边栏紧凑相对时间（如 40m、2h、3d） */
  function formatRelativeCompact(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 60) return '1m';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
    if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d`;
    if (diffSec < 2592000) return `${Math.floor(diffSec / 604800)}w`;
    return `${Math.floor(diffSec / 2592000)}mo`;
  }

  /** 格式化起止时间为 MM-DD HH:mm */
  function formatDateTimeCompact(ts) {
    if (!ts) return '--';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '--';
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${m}-${day} ${hh}:${mm}`;
  }

  /** 计算数值数组的中位数 */
  function computeMedian(values) {
    const valid = (values || []).filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
    if (!valid.length) return 0;
    const mid = Math.floor(valid.length / 2);
    return valid.length % 2 === 0 ? (valid[mid - 1] + valid[mid]) / 2 : valid[mid];
  }

  /** 从路径提取末级目录名 */
  function getPathBasename(dirPath) {
    if (!dirPath) return '';
    const cleaned = String(dirPath).replace(/[\\/]+$/, '');
    if (!cleaned) return String(dirPath);
    const parts = cleaned.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : cleaned;
  }

  /** 弹出轻提示消息 */
  function showToast(message, isErr = false) {
    const box = $('toast-container');
    if (!box) return;
    const item = document.createElement('div');
    item.className = `toast${isErr ? ' is-err' : ''}`;
    item.textContent = message;
    box.appendChild(item);
    setTimeout(() => {
      item.remove();
    }, 3200);
  }

  /** 更新并显示内联反馈条（清除 hidden 并切换 is-ok / is-err 状态类） */
  function showFeedback(elOrId, message, status = '') {
    const el = typeof elOrId === 'string' ? $(elOrId) : elOrId;
    if (!el) return;
    el.hidden = false;
    el.className = status ? `unlock-feedback is-${status}` : 'unlock-feedback';
    el.textContent = message;
  }

  /** 复制文本到剪贴板（兼容内网 HTTP 或非安全上下文回退方案） */
  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // 忽略并走回退方案
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }

  /** 统一 API 请求封装：自动携带 Cookie/Token 并在 401 时唤起登录弹窗 */
  async function apiFetch(url, options = {}) {
    const savedToken = localStorage.getItem('agy_token');
    const fetchOpts = {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(savedToken ? { 'x-agy-token': savedToken } : {}),
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {})
      }
    };
    const res = await fetch(url, fetchOpts);
    if (res.status === 401) {
      localStorage.removeItem('agy_token');
      state.authRequired = true;
      state.authenticated = false;
      openAuthModal();
      throw new Error('需要密码登录验证');
    }
    const contentType = res.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const errMsg = data && typeof data === 'object' ? (data.error || data.message || data.reason || `请求失败 (${res.status})`) : String(data);
      throw new Error(errMsg);
    }
    return data;
  }

  // --------------------------------------------------------------------------
  // 零依赖轻量安全 Markdown + 语法高亮解析器
  // --------------------------------------------------------------------------

  /** 对代码文本执行单遍扫描语法高亮，避免正则重叠破坏 HTML 标签 */
  function highlightCode(rawCode, lang) {
    const code = String(rawCode || '');
    const normalizedLang = String(lang || '').toLowerCase();
    const isMarkup = ['html', 'xml', 'svg'].includes(normalizedLang);

    // 匹配注释、字符串、数字、标识符及 XML 标签的单遍分词正则
    const tokenRe = isMarkup
      ? /(<!--[\s\S]*?-->|<\/?[a-zA-Z][\w:-]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g
      : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[a-zA-Z_]\w*\b)/g;

    const keywords = new Set([
      'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'do',
      'switch', 'case', 'break', 'continue', 'try', 'catch', 'finally', 'throw', 'new',
      'class', 'extends', 'import', 'export', 'from', 'default', 'async', 'await', 'yield',
      'true', 'false', 'null', 'undefined', 'def', 'elif', 'pass', 'with', 'as', 'in',
      'not', 'and', 'or', 'None', 'True', 'False', 'func', 'package', 'struct', 'interface',
      'type', 'go', 'defer', 'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'JOIN'
    ]);

    let result = '';
    let lastIndex = 0;
    let match;

    while ((match = tokenRe.exec(code)) !== null) {
      result += escapeHtml(code.slice(lastIndex, match.index));
      const tok = match[0];
      lastIndex = match.index + tok.length;

      if (tok.startsWith('//') || tok.startsWith('/*') || tok.startsWith('<!--') || (tok.startsWith('#') && normalizedLang !== 'css')) {
        result += `<span class="tok-com">${escapeHtml(tok)}</span>`;
      } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
        result += `<span class="tok-str">${escapeHtml(tok)}</span>`;
      } else if (isMarkup && tok.startsWith('<')) {
        result += `<span class="tok-tag">${escapeHtml(tok)}</span>`;
      } else if (/^\d/.test(tok)) {
        result += `<span class="tok-num">${escapeHtml(tok)}</span>`;
      } else if (keywords.has(tok)) {
        result += `<span class="tok-kw">${escapeHtml(tok)}</span>`;
      } else if (code[lastIndex] === '(') {
        result += `<span class="tok-fn">${escapeHtml(tok)}</span>`;
      } else {
        result += escapeHtml(tok);
      }
    }
    result += escapeHtml(code.slice(lastIndex));
    return result;
  }

  /** 安全校验链接协议，禁止 javascript: 等危险协议 */
  function sanitizeHref(rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '#';
    if (trimmed.startsWith('/') || trimmed.startsWith('#')) return trimmed;
    try {
      const parsed = new URL(trimmed, window.location.origin);
      if (['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
        return parsed.href;
      }
    } catch {
      return '#';
    }
    return '#';
  }

  /** 将 Markdown 图片 URL 归一化为浏览器可加载地址（自动代理 file://、本地绝对路径以及会话 brain 目录相对路径，并附带 Token） */
  function resolveMarkdownImageSrc(rawUrl, optionalConvId = null) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) return '';
    if (/^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,/i.test(trimmed)) return trimmed;
    const token = localStorage.getItem('agy_token');
    const tokenQuery = token ? `&token=${encodeURIComponent(token)}` : '';
    const activeConvId = optionalConvId || state.currentConversationId || '';

    if (trimmed.startsWith('/api/uploads/')) {
      return token ? `${trimmed}${trimmed.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : trimmed;
    }
    if (trimmed.startsWith('/api/local-image')) {
      return token ? `${trimmed}${trimmed.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : trimmed;
    }
    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    // 本地绝对路径与 file:// 协议
    if (trimmed.startsWith('file://') || /^\/(?:home|Users|tmp|var|opt|mnt)\//.test(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
      const extraConv = activeConvId ? `&convId=${encodeURIComponent(activeConvId)}` : '';
      return `/api/local-image?path=${encodeURIComponent(trimmed)}${extraConv}${tokenQuery}`;
    }

    // 相对路径或纯文件名：若属于常见图片扩展名，自动代理至当前会话 brain 目录下
    if (/\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i.test(trimmed)) {
      const cleanFileName = trimmed.replace(/^\.\//, '');
      if (activeConvId) {
        return `/api/local-image?convId=${encodeURIComponent(activeConvId)}&file=${encodeURIComponent(cleanFileName)}${tokenQuery}`;
      }
      return `/api/local-image?path=${encodeURIComponent(trimmed)}${tokenQuery}`;
    }

    if (trimmed.startsWith('/')) return trimmed;
    return '';
  }

  /** 渲染行内 Markdown 语法（行内代码、图片、链接、加粗、斜体、删除线） */
  function renderInlineMarkdown(rawText) {
    let text = String(rawText || '');
    const imgSlots = [];

    // 0. 特殊处理：落盘清单中的 存储路径 / 落盘路径 / 输出路径 / 文件链接: /path/to/img.jpg 或 `xxx.jpg`
    text = text.replace(/(?:存储路径|落盘路径|生成图片|输出图片|文件路径|文件链接)[:：]\s*[`'"]?([^\s\r\n)\]'"]+?\.(?:png|jpe?g|gif|webp|bmp|svg))[`'"]?/gi, (full, imgPath) => {
      const cleanPath = imgPath.replace(/^[`'"]+|[`'"]+$/g, '').trim();
      const src = resolveMarkdownImageSrc(cleanPath);
      const fileName = cleanPath.split(/[\\/]/).pop() || '生成图片';
      if (!src) return full;
      const idx = imgSlots.length;
      imgSlots.push(`
        <div class="md-auto-img-card" data-lightbox-src="${escapeHtml(src)}" data-lightbox-caption="${escapeHtml(fileName)}">
          <div class="md-auto-img-title">🖼️ ${escapeHtml(fileName)} <span class="md-auto-img-path">${escapeHtml(cleanPath)}</span></div>
          <div class="md-auto-img-preview">
            <img class="md-inline-img is-block" src="${escapeHtml(src)}" alt="${escapeHtml(fileName)}" loading="lazy" />
          </div>
        </div>
      `);
      return `\u0000IMG${idx}\u0000`;
    });

    // 0.5 特殊处理：提示词中的 [附件图片: /path/to/img.png ...] 结构化展示
    text = text.replace(/\[附件图片:\s*([^\s\r\n\]]+)(?:[^\r\n\]]*?)\]/gi, (full, imgPath) => {
      const cleanPath = imgPath.replace(/^[`'"]+|[`'"]+$/g, '').trim();
      const src = resolveMarkdownImageSrc(cleanPath);
      const fileName = cleanPath.split(/[\\/]/).pop() || '附件图片';
      if (!src) return `<span class="md-att-tag">📎 附件图片: ${escapeHtml(fileName)}</span>`;
      const idx = imgSlots.length;
      imgSlots.push(`
        <div class="md-auto-img-card" data-lightbox-src="${escapeHtml(src)}" data-lightbox-caption="${escapeHtml(fileName)}">
          <div class="md-auto-img-title"><span class="md-att-tag">📎 附件图片</span><span class="md-auto-img-path">${escapeHtml(fileName)}</span></div>
          <div class="md-auto-img-preview">
            <img class="md-inline-img" src="${escapeHtml(src)}" alt="${escapeHtml(fileName)}" loading="lazy" />
          </div>
        </div>
      `);
      return `\u0000IMG${idx}\u0000`;
    });

    // 1. 显式 Markdown 图片语法：![alt](url) 优先全局消费，绝不留下破损的 !<a>
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (full, alt, url) => {
      const cleanUrl = url.replace(/^[`'"]+|[`'"]+$/g, '').trim();
      const src = resolveMarkdownImageSrc(cleanUrl);
      const label = alt || cleanUrl.split(/[\\/]/).pop() || '生成图片';
      const idx = imgSlots.length;
      if (src) {
        imgSlots.push(`
          <div class="md-auto-img-card" data-lightbox-src="${escapeHtml(src)}" data-lightbox-caption="${escapeHtml(label)}">
            <img class="md-inline-img" src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy" />
          </div>
        `);
      } else {
        imgSlots.push(`<span class="md-img-fallback">🖼️ ${escapeHtml(label)}</span>`);
      }
      return `\u0000IMG${idx}\u0000`;
    });

    // 2. 提取普通行内代码（若行内代码为图片文件名，附带行内预览）
    const codeSlots = [];
    text = text.replace(/`([^`\n]+)`/g, (_, code) => {
      const trimmedCode = code.trim();
      if (/\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(trimmedCode)) {
        const src = resolveMarkdownImageSrc(trimmedCode);
        if (src) {
          const idx = imgSlots.length;
          imgSlots.push(`
            <span class="md-code-img-wrap" data-lightbox-src="${escapeHtml(src)}" data-lightbox-caption="${escapeHtml(trimmedCode)}">
              <code class="inline-code">${escapeHtml(code)}</code>
              <img class="md-inline-img" src="${escapeHtml(src)}" alt="${escapeHtml(trimmedCode)}" loading="lazy" />
            </span>
          `);
          return `\u0000IMG${idx}\u0000`;
        }
      }
      const idx = codeSlots.length;
      codeSlots.push(`<code class="inline-code">${escapeHtml(code)}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });

    let safe = escapeHtml(text);
    // 3. 超链接解析：若链接目标或文字明显是图片文件（如 .jpg / .png），在超链接后附带行内预览图
    safe = safe.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (full, label, url) => {
      const href = escapeHtml(sanitizeHref(url));
      const isImgTarget = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i.test(url) || /\.(?:png|jpe?g|gif|webp|bmp|svg)$/i.test(label);
      if (isImgTarget) {
        const imgSrc = resolveMarkdownImageSrc(url) || resolveMarkdownImageSrc(label);
        if (imgSrc) {
          const idx = imgSlots.length;
          imgSlots.push(`
            <span class="md-link-img-wrap" data-lightbox-src="${escapeHtml(imgSrc)}" data-lightbox-caption="${escapeHtml(label)}">
              <a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>
              <img class="md-inline-img" src="${escapeHtml(imgSrc)}" alt="${escapeHtml(label)}" loading="lazy" />
            </span>
          `);
          return `\u0000IMG${idx}\u0000`;
        }
      }
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    safe = safe.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    safe = safe.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');

    safe = safe.replace(/\u0000IMG(\d+)\u0000/g, (_, i) => imgSlots[Number(i)] || '');
    return safe.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSlots[Number(i)] || '');
  }

  /** 解析单块非代码区间的块级 Markdown 元素 */
  function renderMarkdownBlocks(segment) {
    const lines = segment.split(/\r?\n/);
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      // 分割线
      if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
        out.push('<hr />');
        i++;
        continue;
      }

      // 标题 h1 ~ h6
      const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
        i++;
        continue;
      }

      // 引用块
      if (trimmed.startsWith('>')) {
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith('>')) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push(`<blockquote>${quoteLines.map(renderInlineMarkdown).join('<br />')}</blockquote>`);
        continue;
      }

      // 表格识别（含表头分隔行 | --- |）
      if (trimmed.includes('|') && i + 1 < lines.length && /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[i + 1])) {
        const parseRow = (row) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
        const headers = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim() !== '') {
          rows.push(parseRow(lines[i]));
          i++;
        }
        const thead = `<thead><tr>${headers.map((h) => `<th>${renderInlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
        const tbody = `<tbody>${rows.map((r) => `<tr>${headers.map((_, idx) => `<td>${renderInlineMarkdown(r[idx] || '')}</td>`).join('')}</tr>`).join('')}</tbody>`;
        out.push(`<table>${thead}${tbody}</table>`);
        continue;
      }

      // 无序与有序列表
      if (/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)) {
        const isOrdered = /^\s*\d+\.\s+/.test(line);
        const tag = isOrdered ? 'ol' : 'ul';
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]\s+|\d+\.\s+)/.test(lines[i])) {
          const itemText = lines[i].replace(/^\s*(?:[-*+]\s+|\d+\.\s+)/, '');
          items.push(`<li>${renderInlineMarkdown(itemText)}</li>`);
          i++;
        }
        out.push(`<${tag}>${items.join('')}</${tag}>`);
        continue;
      }

      // 普通段落：连续非空行聚合
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|(?:---|\*\*\*|___)\s*$)/.test(lines[i].trim())
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      out.push(`<p>${paraLines.map(renderInlineMarkdown).join('<br />')}</p>`);
    }

    return out.join('');
  }

  /** 将完整 Markdown 文本转换为带代码高亮和复制按钮的安全 HTML */
  function renderMarkdown(markdownText) {
    const source = String(markdownText || '');
    if (!source) return '';

    const fenceRe = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = fenceRe.exec(source)) !== null) {
      if (match.index > lastIndex) {
        parts.push(renderMarkdownBlocks(source.slice(lastIndex, match.index)));
      }
      const lang = match[1] || 'text';
      const rawCode = match[2].replace(/\n$/, '');
      const highlighted = highlightCode(rawCode, lang);
      parts.push(
        `<div class="code-block-wrap">` +
          `<div class="code-block-header">` +
            `<span>${escapeHtml(lang)}</span>` +
            `<button class="code-copy-btn" type="button" data-copy-code="${escapeHtml(rawCode)}">复制代码</button>` +
          `</div>` +
          `<pre class="code-block-pre"><code>${highlighted}</code></pre>` +
        `</div>`
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < source.length) {
      parts.push(renderMarkdownBlocks(source.slice(lastIndex)));
    }
    return parts.join('');
  }

  // --------------------------------------------------------------------------
  // 主题、布局抽屉与登录弹窗管理
  // --------------------------------------------------------------------------

  function applyTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    state.theme = next;
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('agy_theme', next);
    const sun = $('icon-theme-sun');
    const moon = $('icon-theme-moon');
    if (sun && moon) {
      sun.hidden = next === 'dark';
      moon.hidden = next === 'light';
    }
  }

  function applyAuxCollapsed(collapsed) {
    state.auxCollapsed = Boolean(collapsed);
    document.body.classList.toggle('aux-collapsed', state.auxCollapsed);
    localStorage.setItem('agy_aux_collapsed', state.auxCollapsed ? '1' : '0');
    const btn = $('btn-toggle-aux');
    if (btn) btn.setAttribute('aria-pressed', String(!state.auxCollapsed));
  }

  function closeMobileDrawers() {
    document.body.classList.remove('drawer-left-open', 'drawer-right-open');
    const backdrop = $('mobile-backdrop');
    if (backdrop) backdrop.hidden = true;
  }

  function openMobileDrawer(side) {
    closeMobileDrawers();
    document.body.classList.add(side === 'left' ? 'drawer-left-open' : 'drawer-right-open');
    const backdrop = $('mobile-backdrop');
    if (backdrop) backdrop.hidden = false;
  }

  function openAuthModal() {
    const modal = $('auth-modal');
    if (!modal) return;
    modal.hidden = false;
    setTimeout(() => $('auth-password-input')?.focus(), 50);
  }

  function closeAuthModal() {
    const modal = $('auth-modal');
    if (modal) modal.hidden = true;
    const err = $('auth-error-msg');
    if (err) err.hidden = true;
  }

  // --------------------------------------------------------------------------
  // 顶栏状态与双胶囊渲染（Context Viewer + 历史热力账单）
  // --------------------------------------------------------------------------

  function renderTopbarStatus() {
    const pill = $('agy-status-pill');
    const txt = $('agy-status-text');
    if (pill && txt) {
      const found = Boolean(state.agyStatus?.found);
      pill.classList.toggle('is-connected', found);
      pill.classList.toggle('is-demo', !found);
      txt.textContent = found ? '已连接本机 CLI' : '演示模式';
      pill.title = found
        ? `本机 agy 路径: ${state.agyStatus.binPath || 'PATH'} (${state.agyStatus.source || 'local'})`
        : '当前环境未检测到 agy 二进制，流式对话将使用模拟演示响应';
    }

    const wsText = $('topbar-workspace-path');
    if (wsText) {
      wsText.textContent = state.workspace || '未设置工作区';
    }

    const logoutBtn = $('btn-logout');
    if (logoutBtn) {
      logoutBtn.hidden = !(state.authRequired && state.authenticated);
    }
  }

  /** 将当前上下文指标同步渲染到胶囊 1 按钮与明细面板 */
  function renderContextView() {
    const m = state.contextMetrics;
    const budget = Number(m.budget || DEFAULT_BUDGET);
    const used = Number(m.used ?? m.actual ?? m.estimate ?? 0);
    const pct = Number.isFinite(Number(m.percent))
      ? Math.max(0, Math.min(100, Number(m.percent)))
      : (budget > 0 ? Math.max(0, Math.min(100, (used / budget) * 100)) : 0);

    // 更新胶囊 1 环形进度条
    const ring = $('capsule-ring-fill');
    if (ring) {
      const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
      ring.style.strokeDasharray = RING_CIRCUMFERENCE.toFixed(2);
      ring.style.strokeDashoffset = offset.toFixed(2);
      ring.classList.toggle('is-warn', pct >= 75 && pct < 90);
      ring.classList.toggle('is-danger', pct >= 90);
    }

    const ctxText = $('capsule-ctx-text');
    if (ctxText) {
      ctxText.textContent = `${formatTokensCompact(used)} / ${formatTokensCompact(budget)} (${Math.round(pct)}%)`;
    }

    const speedText = $('capsule-speed-text');
    if (speedText) {
      const tpsPart = m.tps != null ? `${m.tps} tok/s` : '-- tok/s';
      const ttftPart = m.ttft != null ? `${Number(m.ttft).toFixed(2)}s` : '--s';
      speedText.textContent = `${tpsPart} · ${ttftPart}`;
    }

    // 8 类错误诊断徽章
    const errCls = m.errorClassification || { kind: 'none' };
    const kind = errCls.kind || 'none';
    const meta = ERROR_KIND_META[kind] || ERROR_KIND_META.unknown;
    const badge = $('capsule-error-badge');
    if (badge) {
      badge.className = `diag-badge diag-${kind}`;
      badge.textContent = errCls.badgeText || meta.label;
      badge.title = errCls.detail || meta.title;
    }

    // 同步明细面板数据
    const banner = $('ctx-error-banner');
    if (banner) {
      banner.hidden = kind === 'none';
      if (kind !== 'none') {
        $('ctx-error-title').textContent = errCls.title || meta.title;
        const kindBadge = $('ctx-error-kind');
        kindBadge.className = `diag-badge diag-${kind}`;
        kindBadge.textContent = errCls.badgeText || meta.label;
        $('ctx-error-detail').textContent = errCls.detail || '请求异常，请查看诊断信息。';
        const diagEl = $('ctx-error-diagnostic');
        diagEl.hidden = !errCls.diagnostic;
        diagEl.textContent = errCls.diagnostic || '';
      }
    }

    $('ctx-panel-model-pill').textContent = m.model || $('select-model')?.value || '默认模型';
    $('ctx-used-pct-badge').textContent = `${pct.toFixed(1)}%`;

    const mainFill = $('ctx-main-progress-fill');
    if (mainFill) {
      mainFill.style.width = `${Math.min(100, pct)}%`;
      mainFill.classList.toggle('is-warn', pct >= 75 && pct < 90);
      mainFill.classList.toggle('is-danger', pct >= 90);
    }

    $('ctx-actual-val').textContent = m.actual != null ? `${Number(m.actual).toLocaleString('en-US')} tok` : '暂无实测';
    $('ctx-estimate-val').textContent = m.estimate != null ? `${Number(m.estimate).toLocaleString('en-US')} tok` : `${Number(m.totalTokens || 0).toLocaleString('en-US')} tok`;
    $('ctx-budget-val').textContent = `${budget.toLocaleString('en-US')} tok`;
    const remaining = Math.max(0, budget - used);
    $('ctx-remaining-val').textContent = `${remaining.toLocaleString('en-US')} tok`;

    $('ctx-speed-status').textContent = state.streaming.active ? '实时生成中' : (m.tps != null ? '最近一次推理' : '待生成');
    $('ctx-tps-val').textContent = m.tps != null ? `${m.tps} tok/s` : '—';
    $('ctx-ttft-val').textContent = m.ttft != null ? `${Number(m.ttft).toFixed(2)} s` : '—';
    $('ctx-duration-val').textContent = m.duration != null ? `${Number(m.duration).toFixed(2)} s` : '—';
    $('ctx-output-tok-val').textContent = m.outputTokens != null ? `${Number(m.outputTokens).toLocaleString('en-US')} tok` : '—';

    renderFiveDims(m.groups, m.totalChars);
    renderMediaAuditTable();
    renderRecentTurns();
  }

  /** 渲染当前会话最近单轮推理测速指标 */
  function renderRecentTurns() {
    const listEl = $('ctx-recent-turns-list');
    const countEl = $('ctx-recent-turns-count');
    if (!listEl || !countEl) return;

    const turns = (state.messages || [])
      .filter((msg) => msg.role === 'assistant' && msg.metrics && (
        msg.metrics.tps != null ||
        msg.metrics.ttft != null ||
        msg.metrics.duration != null ||
        msg.metrics.outputTokens != null
      ))
      .slice(-6)
      .reverse();

    countEl.textContent = `${turns.length} 轮`;
    if (!turns.length) {
      listEl.innerHTML = '<div class="empty-placeholder">当前会话暂无单轮测速记录</div>';
      return;
    }

    listEl.innerHTML = turns.map((msg, idx) => {
      const mt = msg.metrics || {};
      const tpsTxt = mt.tps != null ? `${Number(mt.tps).toFixed(1)} tok/s` : '—';
      const ttftTxt = mt.ttft != null ? `${Number(mt.ttft).toFixed(2)}s` : '—';
      const durTxt = mt.duration != null ? `${Number(mt.duration).toFixed(2)}s` : '—';
      const outTxt = mt.outputTokens != null ? `${Number(mt.outputTokens).toLocaleString('en-US')} tok` : '—';
      const turnModel = mt.model || state.contextMetrics.model || $('select-model')?.value || '默认模型';
      return `
        <div class="recent-turn-row">
          <div class="recent-turn-left">
            <span class="recent-turn-idx tabular-nums">#${turns.length - idx}</span>
            <span class="recent-turn-model" title="${escapeHtml(turnModel)}">${escapeHtml(turnModel)}</span>
          </div>
          <span class="recent-turn-metrics tabular-nums">${escapeHtml(tpsTxt)} · 首字 ${escapeHtml(ttftTxt)} · ${escapeHtml(durTxt)} · ${escapeHtml(outTxt)}</span>
        </div>
      `;
    }).join('');
  }

  /** 切换当前上下文面板的 4 个子标签页 */
  function switchContextTab(tabName) {
    const valid = ['current', 'models', 'speed', 'config'].includes(tabName) ? tabName : 'current';
    state.activeCtxTab = valid;

    document.querySelectorAll('#ctx-panel-tabs .panel-tab-btn').forEach((btn) => {
      const active = btn.dataset.ctxTab === valid;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    ['current', 'models', 'speed', 'config'].forEach((name) => {
      const pane = $(`ctx-pane-${name}`);
      if (pane) pane.hidden = name !== valid;
    });

    if (valid === 'current') {
      loadUnlockStatus();
      renderContextView();
    } else if (valid === 'models') {
      loadModelCtxSettings();
    } else if (valid === 'speed') {
      if (state.historyData) {
        renderSpeedComparisonTab();
      } else {
        loadTokenHistory(state.historySource).then(() => renderSpeedComparisonTab());
      }
    } else if (valid === 'config') {
      loadAccountsSettings();
      loadProxySettings();
    }
  }

  /** 顶部齿轮快捷按钮：直接打开配置标签页 */
  function openSettingsTab() {
    const ctxPanel = $('panel-context');
    const histPanel = $('panel-history');
    if (histPanel && !histPanel.hidden) {
      histPanel.hidden = true;
      $('capsule-history')?.setAttribute('aria-expanded', 'false');
    }
    if (!ctxPanel) return;

    const alreadyOpenConfig = !ctxPanel.hidden && state.activeCtxTab === 'config';
    if (alreadyOpenConfig) {
      ctxPanel.hidden = true;
      $('capsule-context')?.setAttribute('aria-expanded', 'false');
      $('btn-open-settings')?.setAttribute('aria-expanded', 'false');
      return;
    }

    ctxPanel.hidden = false;
    $('capsule-context')?.setAttribute('aria-expanded', 'true');
    $('btn-open-settings')?.setAttribute('aria-expanded', 'true');
    switchContextTab('config');
  }

  /** 通用纯 SVG 折线与圆点趋势图渲染器（供速度趋势与累计趋势复用） */
  function renderPureSvgTrendChart({
    svgEl,
    emptyEl,
    timeAxisEl,
    startEl,
    endEl,
    points,
    formatY,
    useAccent = false
  }) {
    if (!svgEl || !emptyEl) return;
    const valid = Array.isArray(points) ? points.filter((p) => Number.isFinite(p.value)) : [];
    const hasPoints = valid.length > 0;

    svgEl.hidden = !hasPoints;
    emptyEl.hidden = hasPoints;
    if (timeAxisEl) timeAxisEl.hidden = !hasPoints;
    if (startEl?.parentElement && !timeAxisEl) startEl.parentElement.hidden = !hasPoints;

    if (!hasPoints) {
      svgEl.innerHTML = '';
      if (startEl) startEl.textContent = '--';
      if (endEl) endEl.textContent = '--';
      return;
    }

    const width = 560;
    const height = 185;
    const padLeft = 52;
    const padRight = 14;
    const padTop = 14;
    const padBottom = 16;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    let minVal = Math.min(...valid.map((p) => p.value));
    let maxVal = Math.max(...valid.map((p) => p.value));
    if (minVal === maxVal) {
      minVal = minVal > 0 ? minVal * 0.8 : 0;
      maxVal = maxVal > 0 ? maxVal * 1.2 : 10;
    }
    const midVal = (minVal + maxVal) / 2;
    const range = maxVal - minVal || 1;

    const toY = (v) => padTop + plotH - ((v - minVal) / range) * plotH;
    const toX = (i) => (valid.length === 1
      ? padLeft + plotW / 2
      : padLeft + (i / (valid.length - 1)) * plotW);

    const gridValues = [
      { v: maxVal, y: padTop },
      { v: midVal, y: padTop + plotH / 2 },
      { v: minVal, y: padTop + plotH }
    ];

    const gridSvg = gridValues.map((g) => `
      <line class="svg-grid-line" x1="${padLeft}" y1="${g.y.toFixed(1)}" x2="${width - padRight}" y2="${g.y.toFixed(1)}"></line>
      <text class="svg-axis-label" x="${padLeft - 6}" y="${(g.y + 3).toFixed(1)}" text-anchor="end">${escapeHtml(formatY(g.v))}</text>
    `).join('');

    const coords = valid.map((p, i) => ({
      x: toX(i),
      y: toY(p.value),
      point: p
    }));

    let areaSvg = '';
    let lineSvg = '';
    if (coords.length >= 2) {
      const polyPts = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
      const baseLineY = (padTop + plotH).toFixed(1);
      const areaPts = `${coords[0].x.toFixed(1)},${baseLineY} ${polyPts} ${coords[coords.length - 1].x.toFixed(1)},${baseLineY}`;
      areaSvg = `<polygon class="svg-trend-area" points="${areaPts}"></polygon>`;
      lineSvg = `<polyline class="svg-trend-line${useAccent ? ' svg-trend-line-accent' : ''}" points="${polyPts}"></polyline>`;
    }

    const dotsSvg = coords.map((c) => `
      <circle class="svg-trend-dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="3.5">
        <title>${escapeHtml(c.point.tooltipText)}</title>
      </circle>
    `).join('');

    svgEl.innerHTML = `${gridSvg}${areaSvg}${lineSvg}${dotsSvg}`;
    if (startEl) startEl.textContent = valid[0].timeText || '--';
    if (endEl) endEl.textContent = valid[valid.length - 1].timeText || '--';
  }

  // --------------------------------------------------------------------------
  // Context Tab 2：模型上下文窗口上限设置
  // --------------------------------------------------------------------------

  function getNormalizedModelList() {
    const rawModels = (Array.isArray(state.models) && state.models.length > 0)
      ? state.models
      : [
          'gemini-3.8-flash-high',
          'gemini-3.8-flash-medium',
          'gemini-3.8-flash-low',
          'claude-sonnet-4-6',
          'claude-opus-4-6-thinking',
          'gpt-oss-120b-medium'
        ];
    const map = new Map();

    rawModels.forEach((m) => {
      const id = typeof m === 'string' ? m : (m.id || m.modelId || m.name || '');
      if (!id || map.has(id)) return;
      const info = formatOfficialModel(id);
      const label = info.displayName || id;
      const defBudget = typeof m === 'object'
        ? Number(m.contextWindow || m.maxContextTokens || m.limitTokens || m.budget || (id.includes('gemini-4') ? 1048576 : DEFAULT_BUDGET))
        : (id.includes('gemini-4') ? 1048576 : DEFAULT_BUDGET);
      map.set(id, { id, label, defaultBudget: Number.isFinite(defBudget) && defBudget > 0 ? defBudget : DEFAULT_BUDGET });
    });

    // 若配置文件存在未列在当前模型清单中的覆盖项，一并保留展示
    Object.keys(state.modelCtxOverrides || {}).forEach((id) => {
      if (!map.has(id)) {
        const info = formatOfficialModel(id);
        map.set(id, { id, label: info.displayName || id, defaultBudget: id.includes('gemini-4') ? 1048576 : DEFAULT_BUDGET });
      }
    });

    return Array.from(map.values());
  }

  function syncActiveModelBudget(overrides = state.modelCtxOverrides) {
    const activeModel = state.contextMetrics.model || $('select-model')?.value || '';
    if (!activeModel) return;
    const overrideVal = Number(overrides?.[activeModel]);
    if (Number.isFinite(overrideVal) && overrideVal > 0) {
      state.contextMetrics.budget = overrideVal;
    } else {
      const found = getNormalizedModelList().find((m) => m.id === activeModel);
      state.contextMetrics.budget = found ? found.defaultBudget : DEFAULT_BUDGET;
    }
    const used = Number(state.contextMetrics.used ?? state.contextMetrics.actual ?? state.contextMetrics.estimate ?? 0);
    state.contextMetrics.percent = state.contextMetrics.budget > 0
      ? (used / state.contextMetrics.budget) * 100
      : 0;
    renderContextView();
  }

  async function loadModelCtxSettings() {
    try {
      const data = await apiFetch('/api/settings/model-ctx');
      state.modelCtxOverrides = data.overrides || {};
      renderModelCtxSettings();
    } catch (err) {
      showToast(`加载模型上下文设置失败：${err.message}`, true);
    }
  }

  function renderModelCtxSettings() {
    const listEl = $('model-ctx-list');
    const summaryEl = $('ctx-models-summary');
    if (!listEl) return;

    const models = getNormalizedModelList();
    const overrides = state.modelCtxOverrides || {};
    const overrideCount = Object.keys(overrides).length;
    if (summaryEl) {
      summaryEl.textContent = `共 ${models.length} 个模型 · ${overrideCount} 项自定义覆盖`;
    }

    if (!models.length) {
      listEl.innerHTML = '<div class="empty-placeholder">暂无可用模型列表</div>';
      return;
    }

    const presets = [
      { label: '256K', val: 262144 },
      { label: '512K', val: 524288 },
      { label: '983040', val: 983040 },
      { label: '1M', val: 1048576 }
    ];

    listEl.innerHTML = models.map((m) => {
      const hasOverride = Object.prototype.hasOwnProperty.call(overrides, m.id);
      const currentVal = hasOverride ? Number(overrides[m.id]) : m.defaultBudget;
      const chipsHtml = presets.map((p) => `
        <button class="preset-chip-btn${currentVal === p.val ? ' is-active' : ''}" type="button" data-model-preset-id="${escapeHtml(m.id)}" data-preset-tokens="${p.val}">${p.label}</button>
      `).join('');
      return `
        <div class="model-ctx-row" data-model-row="${escapeHtml(m.id)}">
          <div class="model-ctx-meta">
            <div class="model-ctx-name">
              <span>${escapeHtml(m.label)}</span>
              ${hasOverride ? '<span class="account-badge-active">已自定义</span>' : ''}
            </div>
            <div class="model-ctx-id">${escapeHtml(m.id)}</div>
          </div>
          <div class="model-ctx-controls">
            ${chipsHtml}
            <input class="model-ctx-input tabular-nums" type="number" min="8192" max="4194304" step="1024" value="${currentVal}" data-model-ctx-input="${escapeHtml(m.id)}" aria-label="${escapeHtml(m.label)} 上下文上限" />
            <button class="btn-subtle btn-compact" type="button" data-save-model-ctx="${escapeHtml(m.id)}">保存</button>
            <button class="btn-subtle btn-compact" type="button" data-reset-model-ctx="${escapeHtml(m.id)}" ${hasOverride ? '' : 'disabled'}>恢复</button>
          </div>
        </div>
      `;
    }).join('');
  }

  async function saveModelCtxEntry(modelId, limitTokens) {
    if (limitTokens !== null) {
      if (!Number.isFinite(limitTokens) || limitTokens < 8192 || limitTokens > 4194304) {
        const msg = '模型上下文上限需在 8,192 ~ 4,194,304 之间';
        showFeedback('model-ctx-feedback', msg, 'err');
        showToast(msg, true);
        return;
      }
    }
    showFeedback('model-ctx-feedback', '正在保存模型上下文设置...', '');
    try {
      const data = await apiFetch('/api/settings/model-ctx', {
        method: 'POST',
        body: JSON.stringify({ modelId, limitTokens })
      });
      state.modelCtxOverrides = data.overrides || {};
      renderModelCtxSettings();
      syncActiveModelBudget(state.modelCtxOverrides);
      const msg = limitTokens === null
        ? `已恢复 ${modelId} 默认上下文上限`
        : `已保存 ${modelId} 上限为 ${Number(limitTokens).toLocaleString('en-US')} tok`;
      showFeedback('model-ctx-feedback', msg, 'ok');
      showToast(msg);
    } catch (err) {
      showFeedback('model-ctx-feedback', `保存失败：${err.message}`, 'err');
      showToast(`保存失败：${err.message}`, true);
    }
  }

  async function saveAllModelCtxOverrides() {
    const overrides = {};
    let invalid = false;
    document.querySelectorAll('[data-model-ctx-input]').forEach((input) => {
      const id = input.dataset.modelCtxInput;
      const num = Math.round(Number(input.value));
      if (!Number.isFinite(num) || num < 8192 || num > 4194304) {
        invalid = true;
      } else if (id) {
        overrides[id] = num;
      }
    });
    if (invalid) {
      const msg = '存在超出范围的上下文数值（要求 8,192 ~ 4,194,304）';
      showFeedback('model-ctx-feedback', msg, 'err');
      showToast(msg, true);
      return;
    }
    showFeedback('model-ctx-feedback', '正在批量保存全部模型设置...', '');
    try {
      const data = await apiFetch('/api/settings/model-ctx', {
        method: 'POST',
        body: JSON.stringify({ overrides })
      });
      state.modelCtxOverrides = data.overrides || {};
      renderModelCtxSettings();
      syncActiveModelBudget(state.modelCtxOverrides);
      showFeedback('model-ctx-feedback', `已批量保存 ${Object.keys(state.modelCtxOverrides).length} 项模型配置`, 'ok');
      showToast('已保存全部模型上下文上限');
    } catch (err) {
      showFeedback('model-ctx-feedback', `批量保存失败：${err.message}`, 'err');
      showToast(`批量保存失败：${err.message}`, true);
    }
  }

  // --------------------------------------------------------------------------
  // Context Tab 3：速度对比与纯 SVG 单模型趋势
  // --------------------------------------------------------------------------

  function formatSpeedValue(metric, val) {
    if (!Number.isFinite(val) || val <= 0) return '—';
    if (metric === 'tps') return `${val.toFixed(1)} tok/s`;
    return `${val.toFixed(2)}s`;
  }

  function extractSampleMetric(sample, metric) {
    if (!sample) return null;
    if (metric === 'tps') {
      const v = Number(sample.outputTps ?? sample.tps);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    if (metric === 'ttft') {
      const ms = sample.ttftMs != null ? Number(sample.ttftMs) : (sample.ttft != null ? Number(sample.ttft) * 1000 : NaN);
      return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
    }
    const ms = sample.durationMs != null ? Number(sample.durationMs) : (sample.duration != null ? Number(sample.duration) * 1000 : NaN);
    return Number.isFinite(ms) && ms > 0 ? ms / 1000 : null;
  }

  function renderSpeedComparisonTab() {
    const barsEl = $('ctx-speed-bars');
    const selectEl = $('speed-trend-model-select');
    if (!barsEl) return;

    const range = state.ctxSpeedRange || '7';
    const sourceFilter = state.ctxSpeedSource || 'all';
    const metric = state.ctxSpeedMetric || 'tps';
    const rawSamples = Array.isArray(state.historyData?.speedSamples) ? state.historyData.speedSamples : [];

    const nowMs = Date.now();
    const cutoffMs = range === '7'
      ? nowMs - 7 * 86400 * 1000
      : (range === '30' ? nowMs - 30 * 86400 * 1000 : 0);

    const filteredSamples = rawSamples.filter((s) => {
      const ts = Number(s.ts || new Date(s.date || 0).getTime() || 0);
      if (cutoffMs && ts > 0 && ts < cutoffMs) return false;
      // 日常对话筛选：容错支持 chat / cli 以及未标记后台任务的普通对话样本
      if (sourceFilter === 'chat' && s.source === 'background') return false;
      return true;
    });

    // 按 模型 + 档位 分组聚合
    const groupMap = new Map();
    filteredSamples.forEach((s) => {
      const baseName = s.productLabel || s.modelLabel || s.model || '未知模型';
      const effortText = s.effort ? ` (${s.effort})` : '';
      const key = `${s.modelExactId || s.model || baseName}::${s.effort || ''}`;
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          key,
          label: `${baseName}${effortText}`,
          samples: []
        });
      }
      groupMap.get(key).samples.push(s);
    });

    let groups = Array.from(groupMap.values()).map((g) => {
      const metricVals = g.samples
        .map((s) => extractSampleMetric(s, metric))
        .filter((v) => v != null);
      return {
        ...g,
        count: metricVals.length,
        medianVal: metricVals.length ? computeMedian(metricVals) : 0
      };
    }).filter((g) => g.count > 0);

    // 若当前筛选条件下暂无原始样本，多级智能回退（绝不轻易显示空白）：
    // 1. 若原始样本库有数据但被时间限制过滤，放宽时间范围提取所有可用样本
    if (!groups.length && rawSamples.length > 0) {
      const fallbackMap = new Map();
      rawSamples.forEach((s) => {
        if (sourceFilter === 'chat' && s.source === 'background') return;
        const baseName = s.productLabel || s.modelLabel || s.model || '未知模型';
        const effortText = s.effort ? ` (${s.effort})` : '';
        const key = `${s.modelExactId || s.model || baseName}::${s.effort || ''}`;
        if (!fallbackMap.has(key)) {
          fallbackMap.set(key, { key, label: `${baseName}${effortText}`, samples: [] });
        }
        fallbackMap.get(key).samples.push(s);
      });
      groups = Array.from(fallbackMap.values()).map((g) => {
        const metricVals = g.samples.map((s) => extractSampleMetric(s, metric)).filter((v) => v != null);
        return { ...g, count: metricVals.length, medianVal: metricVals.length ? computeMedian(metricVals) : 0 };
      }).filter((g) => g.count > 0);
    }

    // 2. 若仍无样本，回退使用后端预计算的 speedSummaryByRange 或 modelSpeedStats
    if (!groups.length) {
      const rangeKey = range === '7' ? '7d' : (range === '30' ? '30d' : 'all');
      const fallbackList = state.historyData?.speedSummaryByRange?.[rangeKey]
        || state.historyData?.modelSpeedStats
        || [];
      groups = fallbackList.map((item) => {
        const val = metric === 'tps'
          ? Number(item.medianTps ?? item.tps ?? 0)
          : (metric === 'ttft'
            ? Number(item.medianTtft ?? item.ttft ?? 0)
            : Number(item.medianDuration ?? item.duration ?? 0));
        return {
          key: item.modelExactId || item.model || item.label || 'unknown',
          label: item.modelLabel || item.productLabel || item.label || item.model || '未知模型',
          count: Number(item.count || item.samples || 0),
          medianVal: Number.isFinite(val) ? val : 0,
          samples: []
        };
      }).filter((g) => g.medianVal > 0);
    }

    groups.sort((a, b) => (metric === 'tps' ? b.medianVal - a.medianVal : a.medianVal - b.medianVal));

    if (!groups.length) {
      barsEl.innerHTML = '<div class="empty-placeholder">当前筛选范围内暂无有效测速样本</div>';
    } else {
      const maxVal = Math.max(0.01, ...groups.map((g) => g.medianVal));
      barsEl.innerHTML = groups.map((g) => {
        const pct = g.medianVal > 0 ? Math.max(6, Math.round((g.medianVal / maxVal) * 100)) : 0;
        const lowBadge = g.count < 3 ? '<span class="speed-low-badge">样本少</span>' : '';
        return `
          <div class="speed-row">
            <div class="speed-row-head">
              <span>${escapeHtml(g.label)}<small class="card-sub"> (${g.count}条)</small>${lowBadge}</span>
              <strong class="tabular-nums">${escapeHtml(formatSpeedValue(metric, g.medianVal))}</strong>
            </div>
            <div class="speed-bar-track">
              <div class="speed-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('');
    }

    if (selectEl) {
      const prevKey = state.ctxSpeedTrendKey;
      const selectable = groups.filter((g) => g.samples && g.samples.length > 0);
      if (!selectable.length) {
        selectEl.innerHTML = '<option value="">暂无样本</option>';
        state.ctxSpeedTrendKey = '';
      } else {
        selectEl.innerHTML = selectable.map((g) => (
          `<option value="${escapeHtml(g.key)}">${escapeHtml(g.label)} (${g.samples.length}条)</option>`
        )).join('');
        if (prevKey && selectable.some((g) => g.key === prevKey)) {
          selectEl.value = prevKey;
        } else {
          state.ctxSpeedTrendKey = selectable[0].key;
          selectEl.value = state.ctxSpeedTrendKey;
        }
      }
      renderSpeedTrendSvg(selectable);
    }
  }

  function renderSpeedTrendSvg(selectableGroups = null) {
    const metric = state.ctxSpeedMetric || 'tps';
    const selectedKey = $('speed-trend-model-select')?.value || state.ctxSpeedTrendKey;

    let samples = [];
    if (Array.isArray(selectableGroups)) {
      const found = selectableGroups.find((g) => g.key === selectedKey) || selectableGroups[0];
      samples = found ? found.samples : [];
    } else if (selectedKey) {
      const rawSamples = Array.isArray(state.historyData?.speedSamples) ? state.historyData.speedSamples : [];
      const range = state.ctxSpeedRange || '7';
      const nowMs = Date.now();
      const cutoffMs = range === '7' ? nowMs - 7 * 86400 * 1000 : (range === '30' ? nowMs - 30 * 86400 * 1000 : 0);
      samples = rawSamples.filter((s) => {
        const ts = Number(s.ts || 0);
        if (cutoffMs && ts < cutoffMs) return false;
        if (state.ctxSpeedSource === 'chat' && s.source !== 'chat') return false;
        const baseName = s.productLabel || s.modelLabel || s.model || '未知模型';
        const key = `${s.modelExactId || s.model || baseName}::${s.effort || ''}`;
        return key === selectedKey;
      });
    }

    const sorted = [...samples].sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
    const points = sorted
      .map((s) => {
        const val = extractSampleMetric(s, metric);
        if (val == null) return null;
        const timeText = formatDateTimeCompact(s.ts || s.date);
        const outTok = Number(s.outputTokens || 0).toLocaleString('en-US');
        return {
          value: val,
          timeText,
          tooltipText: `${timeText} · ${formatSpeedValue(metric, val)} · 输出 ${outTok} tok`
        };
      })
      .filter(Boolean);

    renderPureSvgTrendChart({
      svgEl: $('speed-trend-svg'),
      emptyEl: $('speed-trend-empty'),
      timeAxisEl: $('speed-trend-time-axis'),
      startEl: $('speed-trend-start-time'),
      endEl: $('speed-trend-end-time'),
      points,
      formatY: (v) => (metric === 'tps' ? `${v.toFixed(1)}` : `${v.toFixed(2)}s`),
      useAccent: false
    });
  }

  // --------------------------------------------------------------------------
  // Context Tab 4：Antigravity 账号切换与 CLI 网络代理设置
  // --------------------------------------------------------------------------

  async function loadAccountsSettings() {
    try {
      const data = await apiFetch('/api/settings/accounts');
      state.accountsData = data;
      renderAccountsSettings(data);
    } catch (err) {
      const listEl = $('accounts-list');
      if (listEl) listEl.innerHTML = `<div class="empty-placeholder">扫描账号失败：${escapeHtml(err.message)}</div>`;
    }
  }

  function renderAccountsSettings(data) {
    if (!data) return;
    const emailEl = $('account-active-email');
    const tokenEl = $('account-token-status');
    const listEl = $('accounts-list');

    if (emailEl) emailEl.textContent = data.activeEmail || '未检测到激活账号';

    if (tokenEl) {
      tokenEl.classList.remove('diag-none', 'diag-auth', 'diag-unknown');
      if (data.tokenExpired === true) {
        tokenEl.className = 'diag-badge diag-auth';
        tokenEl.textContent = 'Token 已过期';
      } else if (Number.isFinite(data.tokenExpiresInSec)) {
        const mins = Math.max(1, Math.round(data.tokenExpiresInSec / 60));
        const label = mins >= 120 ? `${Math.floor(mins / 60)} 小时后过期` : `${mins} 分钟后过期`;
        tokenEl.className = 'diag-badge diag-none';
        tokenEl.textContent = `Token 有效 · ${label}`;
      } else if (data.tokenExpiry) {
        tokenEl.className = 'diag-badge diag-none';
        tokenEl.textContent = `到期 ${formatTimeShort(data.tokenExpiry)}`;
      } else {
        tokenEl.className = 'diag-badge diag-unknown';
        tokenEl.textContent = 'Token 状态未知';
      }
    }

    if (!listEl) return;
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    if (!accounts.length) {
      const hintDir = data.accountsDir || data.switchDir || '/home/antigravity-switch';
      listEl.innerHTML = `<div class="empty-placeholder">未在 ${escapeHtml(hintDir)} 扫描到账号文件</div>`;
      return;
    }

    listEl.innerHTML = accounts.map((acc) => {
      const activeBadge = acc.active ? '<span class="account-badge-active">当前激活</span>' : '';
      const meta = [
        acc.projectId ? `Project: ${acc.projectId}` : '无 ProjectID',
        acc.fileName,
        acc.hasRefreshToken === false ? '无 RefreshToken' : ''
      ].filter(Boolean).join(' · ');

      return `
        <div class="account-card${acc.active ? ' is-active' : ''}">
          <div class="account-card-info">
            <div class="account-card-email">
              <span>${escapeHtml(acc.email || acc.fileName)}</span>
              ${activeBadge}
            </div>
            <div class="account-card-meta" title="${escapeHtml(meta)}">${escapeHtml(meta)}</div>
          </div>
          <button class="btn-subtle btn-compact" type="button" data-switch-account="${escapeHtml(acc.fileName)}" ${acc.active ? 'disabled' : ''}>
            ${acc.active ? '使用中' : '切换账号'}
          </button>
        </div>
      `;
    }).join('');
  }

  async function switchActiveAccount(fileName) {
    if (!fileName) return;
    showFeedback('account-switch-feedback', '正在切换账号并刷新凭证...', '');
    document.querySelectorAll('[data-switch-account]').forEach((b) => { b.disabled = true; });

    try {
      const res = await apiFetch('/api/settings/accounts/switch', {
        method: 'POST',
        body: JSON.stringify({ fileName })
      });
      const okMsg = `已切换至 ${res.email || fileName}`;
      showFeedback('account-switch-feedback', okMsg, 'ok');
      showToast(okMsg);
      await loadAccountsSettings();

      // 1. 刷新可用模型列表与原生下拉框
      if (Array.isArray(res.models) && res.models.length > 0) {
        state.models = res.models;
        populateControlSelects();
      } else {
        const boot = await apiFetch('/api/bootstrap');
        if (Array.isArray(boot.models)) {
          state.models = boot.models;
          populateControlSelects();
        }
      }

      // 2. 刷新额度看板数据与输入框额度圆环
      if (res.usageLimits) {
        state.usageLimits = res.usageLimits;
        renderUsageLimits(res.usageLimits);
      } else {
        await refreshUsageLimits();
      }

      // 3. 立即刷新输入框左下角模型胶囊、微型额度圆环与快捷模型弹窗
      updateModelPickerQuotaPill();
      renderModelSwitcherList();
      updateCliPreview();

      // 4. 同步刷新顶栏上下文与历史用量统计
      if (typeof refreshContextWindowStatus === 'function') {
        refreshContextWindowStatus();
      }
      if (typeof loadMeterHistory === 'function') {
        loadMeterHistory();
      }
    } catch (err) {
      showFeedback('account-switch-feedback', `切换失败：${err.message}`, 'err');
      showToast(`切换账号失败：${err.message}`, true);
      await loadAccountsSettings();
    }
  }

  async function loadProxySettings() {
    try {
      const data = await apiFetch('/api/settings/proxy');
      state.proxyConfig = data;
      renderProxySettings(data);
    } catch (err) {
      const badge = $('proxy-status-badge');
      if (badge) badge.textContent = '读取失败';
      showToast(`读取代理设置失败：${err.message}`, true);
    }
  }

  function renderProxySettings(data) {
    if (!data) return;
    const chkEnabled = $('chk-proxy-enabled');
    const urlInput = $('proxy-url-input');
    const badge = $('proxy-status-badge');
    const syncChk = $('chk-proxy-sync-py');

    if (chkEnabled) chkEnabled.checked = Boolean(data.enabled);
    if (urlInput && document.activeElement !== urlInput) {
      urlInput.value = data.proxyUrl || '';
    }
    if (badge) {
      badge.classList.remove('diag-none', 'diag-unknown');
      if (data.enabled && data.proxyUrl) {
        badge.className = 'diag-badge diag-none';
        badge.textContent = '代理已启用';
      } else if (data.enabled) {
        badge.className = 'diag-badge diag-unknown';
        badge.textContent = '已开启(未填地址)';
      } else {
        badge.className = 'diag-badge diag-unknown';
        badge.textContent = '直连模式';
      }
    }
    if (syncChk && data.switchPyPath) {
      syncChk.parentElement.title = `同步路径: ${data.switchPyPath}`;
    }
  }

  async function testProxySettings() {
    const btn = $('btn-test-proxy');
    const proxyUrl = ($('proxy-url-input')?.value || '').trim();
    showFeedback('proxy-test-result', '正在测试代理连通性...', '');
    if (btn) btn.disabled = true;

    try {
      const res = await apiFetch('/api/settings/proxy/test', {
        method: 'POST',
        body: JSON.stringify({ proxyUrl })
      });
      if (res.ok) {
        const msg = `✓ 连通成功 · HTTP ${res.statusCode || 200} · 延迟 ${res.latencyMs ?? '--'} ms`;
        showFeedback('proxy-test-result', msg, 'ok');
        showToast(msg);
      } else {
        const reachHint = res.reachable ? '代理端口可达但握手失败：' : '';
        const detail = res.error || `状态码 ${res.statusCode || '--'}`;
        const latencyTxt = res.latencyMs != null ? ` (${res.latencyMs} ms)` : '';
        const msg = `✕ ${reachHint}${detail}${latencyTxt}`;
        showFeedback('proxy-test-result', msg, 'err');
        showToast(msg, true);
      }
    } catch (err) {
      showFeedback('proxy-test-result', `✕ 测试失败：${err.message}`, 'err');
      showToast(`代理测试失败：${err.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function saveProxySettings() {
    const btn = $('btn-save-proxy');
    const enabled = Boolean($('chk-proxy-enabled')?.checked);
    const proxyUrl = ($('proxy-url-input')?.value || '').trim();
    const syncSwitchPy = Boolean($('chk-proxy-sync-py')?.checked);

    if (btn) btn.disabled = true;
    showFeedback('proxy-save-feedback', '正在保存代理配置并同步...', '');

    try {
      const res = await apiFetch('/api/settings/proxy', {
        method: 'POST',
        body: JSON.stringify({ enabled, proxyUrl, syncSwitchPy })
      });
      state.proxyConfig = res;
      renderProxySettings(res);
      const details = [res.wrapperMessage, res.switchPyMessage].filter(Boolean).join('；');
      const okMsg = details || '代理配置已保存并同步';
      showFeedback('proxy-save-feedback', okMsg, 'ok');
      showToast('代理配置已保存并同步');
    } catch (err) {
      showFeedback('proxy-save-feedback', `保存失败：${err.message}`, 'err');
      showToast(`保存代理配置失败：${err.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 渲染 5 维上下文占用进度条 */
  function renderFiveDims(groups = {}, totalChars = 0) {
    const keys = ['user', 'assistant', 'thinking', 'tools', 'summaries'];
    const getTok = (item) => Number(item?.tokens ?? item?.estimate ?? item?.low ?? item ?? 0);
    const sumTokens = keys.reduce((acc, k) => acc + getTok(groups[k]), 0);
    const totalCharCount = totalChars || keys.reduce((acc, k) => acc + Number(groups[k]?.chars || 0), 0);

    $('ctx-total-chars').textContent = `${Number(totalCharCount).toLocaleString('en-US')} 字符 · ${sumTokens.toLocaleString('en-US')} tok`;

    keys.forEach((k) => {
      const tok = getTok(groups[k]);
      const share = sumTokens > 0 ? Math.round((tok / sumTokens) * 100) : 0;
      const valEl = $(`dim-val-${k}`);
      const barEl = $(`dim-bar-${k}`);
      if (valEl) valEl.textContent = `${tok.toLocaleString('en-US')} tok (${share}%)`;
      if (barEl) barEl.style.width = `${share}%`;
    });
  }

  /** 渲染附件审计表（融合归档媒体、当前待发图片与已发图片） */
  function renderMediaAuditTable() {
    const tbody = $('ctx-media-tbody');
    if (!tbody) return;

    const historyMedia = Array.isArray(state.activeConversationDetail?.media) ? state.activeConversationDetail.media : [];
    const rows = [];

    state.pendingAttachments.forEach((f) => {
      rows.push({
        name: f.name || '待发送图片',
        dimensions: f.dimensions || (f.width && f.height ? `${f.width}×${f.height}` : '—'),
        bytes: f.bytes,
        tokens: f.tokens ?? f.estimate ?? '—',
        source: '待发送'
      });
    });

    state.sessionSentAttachments.forEach((f) => {
      rows.push({
        name: f.name || '已发送图片',
        dimensions: f.dimensions || (f.width && f.height ? `${f.width}×${f.height}` : '—'),
        bytes: f.bytes,
        tokens: f.tokens ?? f.estimate ?? '—',
        source: '本次会话'
      });
    });

    historyMedia.forEach((m) => {
      const tokVal = m.tokens?.estimate ?? m.tokens ?? m.estimate ?? (m.low != null ? `${m.low}~${m.high}` : '—');
      rows.push({
        name: m.name || m.filename || m.path || '历史附件',
        dimensions: m.dimensions || (m.width && m.height ? `${m.width}×${m.height}` : '—'),
        bytes: m.bytes ?? m.size ?? 0,
        tokens: tokVal,
        source: '历史归档'
      });
    });

    $('ctx-media-count').textContent = `${rows.length} 项`;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">当前会话暂无附件记录</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>
        <td class="tabular-nums">${escapeHtml(String(r.dimensions || '—'))}</td>
        <td class="tabular-nums">${r.bytes ? formatBytes(r.bytes) : '—'}</td>
        <td class="tabular-nums">${typeof r.tokens === 'number' ? `${r.tokens.toLocaleString('en-US')} tok` : escapeHtml(String(r.tokens))}</td>
        <td><span class="chip-muted">${escapeHtml(r.source)}</span></td>
      </tr>
    `).join('');
  }

  // --------------------------------------------------------------------------
  // 模型上下文窗口解锁控制区
  // --------------------------------------------------------------------------

  async function loadUnlockStatus() {
    const infoEl = $('unlock-binary-info');
    const badgeEl = $('unlock-mode-badge');
    if (infoEl) infoEl.textContent = '正在检测本机 agy 二进制与 256K 门禁状态…';

    try {
      const data = await apiFetch('/api/meter/unlock-status');
      state.unlockStatus = data;
      renderUnlockStatus(data);
    } catch (err) {
      if (badgeEl) badgeEl.textContent = '检测失败';
      if (infoEl) infoEl.textContent = `无法读取解锁状态：${err.message}`;
    }
  }

  function renderUnlockStatus(status) {
    const badgeEl = $('unlock-mode-badge');
    const infoEl = $('unlock-binary-info');
    if (!status) return;

    const available = status.available !== false && status.found !== false;
    const mode = status.mode || (status.unlocked ? 'dynamic' : 'default');
    const limit = Number(status.limitTokens || status.currentLimit || 256000);

    let modeText = '256K 默认';
    if (!available) modeText = '未检测到二进制';
    else if (mode === 'dynamic') modeText = '动态跟随（已解锁）';
    else if (limit >= 1000000) modeText = '固定 1M';
    else if (limit === 983040) modeText = '固定 983,040';
    else if (limit === 900000) modeText = '固定 900K';
    else if (limit === 512000) modeText = '固定 512K';
    else if (limit !== 256000) modeText = `自定义 ${limit.toLocaleString('en-US')}`;

    if (badgeEl) {
      badgeEl.textContent = modeText;
      badgeEl.className = available && mode !== 'default' ? 'chip-accent' : 'chip-muted';
    }

    if (infoEl) {
      if (!available) {
        infoEl.textContent = status.reason || '当前宿主机未探测到 agy / agy-real 可执行文件，解锁操作仅在存在二进制的 Ubuntu/本机环境可用。';
      } else {
        const parts = [
          `目标路径：${status.binaryPath || status.binPath || '已识别'}`,
          `架构：${status.arch || '未知'}`,
          `原版备份：${status.hasBackup || status.backupExists ? '已就绪' : '将在首次修改时自动备份'}`
        ];
        if (status.note) parts.push(status.note);
        infoEl.textContent = parts.join(' ｜ ');
      }
    }

    // 高亮匹配预设按钮
    document.querySelectorAll('.unlock-preset-btn').forEach((btn) => {
      const btnMode = btn.dataset.unlockMode;
      const btnLimit = Number(btn.dataset.unlockLimit || 0);
      const isMatch = available && (
        (btnMode === 'dynamic' && mode === 'dynamic') ||
        (btnMode === 'default' && mode === 'default' && limit === 256000) ||
        (btnMode === 'fixed' && mode === 'fixed' && btnLimit === limit)
      );
      btn.classList.toggle('is-active', isMatch);
    });
  }

  async function applyUnlockSetting(payload) {
    const fb = $('unlock-feedback');
    if (fb) {
      fb.hidden = false;
      fb.className = 'unlock-feedback';
      fb.textContent = '正在执行二进制检查与窗口策略更新…';
    }
    try {
      const res = await apiFetch('/api/meter/unlock', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      const isFail = res && res.ok === false;
      const summary = isFail
        ? (res.reason || res.message || '操作未生效')
        : (res.message || (res.restored
          ? '已还原 CLI 备份并恢复默认窗口策略'
          : (Array.isArray(res.appliedActions) && res.appliedActions.length
            ? `已成功更新上下文窗口策略（${res.appliedActions.join('，')}）`
            : '已成功更新上下文窗口策略')));
      if (fb) {
        fb.className = `unlock-feedback ${isFail ? 'is-err' : 'is-ok'}`;
        fb.textContent = summary;
      }
      await loadUnlockStatus();
      showToast(summary, isFail);
    } catch (err) {
      if (fb) {
        fb.className = 'unlock-feedback is-err';
        fb.textContent = `执行失败：${err.message}`;
      }
      showToast(`解锁操作失败：${err.message}`, true);
    }
  }

  // --------------------------------------------------------------------------
  // Token 历史热力图与 API 等值账单面板
  // --------------------------------------------------------------------------

  async function loadTokenHistory(sourceFilter = state.historySource) {
    state.historySource = sourceFilter;
    try {
      const data = await apiFetch(`/api/meter/history?source=${encodeURIComponent(sourceFilter)}`);
      state.historyData = data;
      renderHistoryDashboard(data);
    } catch (err) {
      showToast(`加载历史账单失败：${err.message}`, true);
    }
  }

  /** 切换历史用量面板的 3 个子视图标签页 */
  function switchHistoryTab(tabName) {
    const valid = ['heatmap', 'trends', 'billing'].includes(tabName) ? tabName : 'heatmap';
    state.activeHistTab = valid;

    document.querySelectorAll('#hist-view-tabs .panel-tab-btn').forEach((btn) => {
      const active = btn.dataset.histTab === valid;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });

    ['heatmap', 'trends', 'billing'].forEach((name) => {
      const pane = $(`hist-pane-${name}`);
      if (pane) pane.hidden = name !== valid;
    });

    if (valid === 'trends' && state.historyData) {
      renderWeeklyBarChart(state.historyData.weeklySeries);
      renderMonthlySummary(state.historyData.monthlySeries);
      renderCumulativeSvgChart(state.historyData.cumulativeSeries);
    } else if (valid === 'billing' && state.historyData) {
      renderBillingComparison(state.historyData.billingComparison, state.historyData.costSummary, state.historyData.unpricedSummary);
    }
  }

  /** 将统计数据渲染至胶囊 2 面板（热力与日趋势、周/月与累计趋势、API 账单与订阅对比） */
  function renderHistoryDashboard(data) {
    if (!data) return;
    const sum = data.summary || {};

    // 更新顶栏胶囊 2 摘要文本
    const capHistText = $('capsule-history-text');
    if (capHistText) {
      const grand = formatTokensCompact(sum.grandTotalTokens ?? 0);
      const usd = Number(data.billingComparison?.totalCostUSD ?? data.costSummary?.totalCostUSD ?? 0).toFixed(2);
      capHistText.textContent = `${grand} · $${usd}`;
    }

    $('hist-earliest-badge').textContent = sum.earliestDate ? `始于 ${sum.earliestDate}` : '本地账本统计';

    // 4 张顶部汇总卡片
    $('sum-today-val').textContent = formatTokensCompact(sum.todayTokens ?? 0);
    $('sum-today-sub').textContent = '今日累计（含缓存读取）';

    $('sum-month-val').textContent = formatTokensCompact(sum.monthTokens ?? 0);
    $('sum-month-sub').textContent = '自然月累计 Token';

    $('sum-year-val').textContent = formatTokensCompact(sum.yearTokens ?? 0);
    $('sum-year-sub').textContent = '本年度累计 Token';

    $('sum-grand-val').textContent = formatTokensCompact(sum.grandTotalTokens ?? 0);
    $('sum-grand-sub').textContent = `${Number(sum.totalSteps || 0).toLocaleString('en-US')} 步骤 · ${Number(sum.totalConversations || 0).toLocaleString('en-US')} 会话`;

    renderHeatmap52Weeks(data.heatmapWeeks, data.dailyMap);
    renderLast7DaysChart(data.last7Days, data.dailyMap);
    renderModelSpeedComparison(data.modelSpeedStats);
    renderWeeklyBarChart(data.weeklySeries);
    renderMonthlySummary(data.monthlySeries);
    renderCumulativeSvgChart(data.cumulativeSeries);
    renderCostSummary(data.costSummary, data.unpricedSummary, data.billingComparison);
    renderBillingComparison(data.billingComparison, data.costSummary, data.unpricedSummary);

    if (state.activeCtxTab === 'speed') {
      renderSpeedComparisonTab();
    }
  }

  /** 渲染 52 周交互式日历热力图（兼容后端 heatmapWeeks 或由 dailyMap 自动补全） */
  function renderHeatmap52Weeks(heatmapWeeks, dailyMap = {}) {
    const grid = $('heatmap-grid');
    const monthsEl = $('heatmap-months');
    if (!grid || !monthsEl) return;

    let weeks = Array.isArray(heatmapWeeks) && heatmapWeeks.length ? heatmapWeeks : buildFallback52Weeks(dailyMap);

    // 统一提取每天数据的字段，防止后端字段命名细微差异
    const allTokens = [];
    weeks.forEach((w) => {
      const days = Array.isArray(w) ? w : (w.days || []);
      days.forEach((d) => {
        if (d && d.date) {
          const total = Number(d.total ?? d.totalTokens ?? ((d.input || 0) + (d.cache || 0) + (d.output || 0)));
          if (total > 0) allTokens.push(total);
        }
      });
    });

    const maxVal = allTokens.length ? Math.max(...allTokens) : 1;
    const calcLevel = (total, existingLevel) => {
      if (existingLevel !== undefined && existingLevel !== null) return Math.max(0, Math.min(4, Number(existingLevel)));
      if (!total || total <= 0) return 0;
      const ratio = total / maxVal;
      if (ratio < 0.2) return 1;
      if (ratio < 0.45) return 2;
      if (ratio < 0.75) return 3;
      return 4;
    };

    const cellsHtml = [];
    const monthMarks = [];
    let lastMonth = '';

    weeks.forEach((w, colIdx) => {
      const days = Array.isArray(w) ? w : (w.days || []);
      for (let row = 0; row < 7; row++) {
        const d = days[row];
        if (!d || !d.date || d.isFuture) {
          cellsHtml.push('<div class="heatmap-day is-empty"></div>');
          continue;
        }
        const mKey = String(d.date).slice(0, 7);
        if (row === 0 && mKey !== lastMonth) {
          lastMonth = mKey;
          const mNum = Number(String(d.date).slice(5, 7));
          monthMarks.push({ colIdx, label: `${mNum}月` });
        }
        const total = Number(d.total ?? d.totalTokens ?? ((d.input || 0) + (d.cache || 0) + (d.output || 0)));
        const input = Number(d.input ?? d.inputTokens ?? 0);
        const cache = Number(d.cache ?? d.cacheTokens ?? 0);
        const output = Number(d.output ?? d.outputTokens ?? 0);
        const steps = Number(d.steps ?? 0);
        const lvl = calcLevel(total, d.level);
        const todayCls = d.isToday ? ' is-today' : '';

        cellsHtml.push(
          `<div class="heatmap-day lvl-${lvl}${todayCls}" ` +
            `data-date="${escapeHtml(d.date)}" ` +
            `data-total="${total}" ` +
            `data-input="${input}" ` +
            `data-cache="${cache}" ` +
            `data-output="${output}" ` +
            `data-steps="${steps}"></div>`
        );
      }
    });

    grid.innerHTML = cellsHtml.join('');
    monthsEl.innerHTML = monthMarks.map((m) =>
      `<span class="heatmap-month-lbl" style="left:${20 + m.colIdx * 14}px">${escapeHtml(m.label)}</span>`
    ).join('');
  }

  /** 若后端未返回完整 heatmapWeeks，则基于 dailyMap 在本地补齐 52 周矩阵 */
  function buildFallback52Weeks(dailyMap = {}) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const dayOfWeek = (today.getDay() + 6) % 7; // 周一=0 .. 周日=6
    const endSunday = new Date(today);
    endSunday.setDate(today.getDate() + (6 - dayOfWeek));
    const startMonday = new Date(endSunday);
    startMonday.setDate(endSunday.getDate() - 52 * 7 + 1);

    const weeks = [];
    const cursor = new Date(startMonday);
    for (let w = 0; w < 52; w++) {
      const days = [];
      for (let d = 0; d < 7; d++) {
        if (cursor > today) {
          days.push(null);
        } else {
          const iso = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
          const entry = dailyMap[iso] || {};
          days.push({
            date: iso,
            total: Number(entry.total ?? entry.totalTokens ?? 0),
            input: Number(entry.input ?? entry.inputTokens ?? 0),
            cache: Number(entry.cache ?? entry.cacheTokens ?? 0),
            output: Number(entry.output ?? entry.outputTokens ?? 0),
            steps: Number(entry.steps ?? 0)
          });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      weeks.push(days);
    }
    return weeks;
  }

  /** 渲染近 7 天柱状图 */
  function renderLast7DaysChart(last7Days, dailyMap = {}) {
    const box = $('last7-chart');
    if (!box) return;

    let list = Array.isArray(last7Days) && last7Days.length ? last7Days : [];
    if (!list.length) {
      const today = new Date();
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        const entry = dailyMap[iso] || {};
        list.push({
          date: iso,
          total: Number(entry.total ?? entry.totalTokens ?? 0),
          input: Number(entry.input ?? entry.inputTokens ?? 0),
          cache: Number(entry.cache ?? entry.cacheTokens ?? 0),
          output: Number(entry.output ?? entry.outputTokens ?? 0),
          steps: Number(entry.steps ?? 0)
        });
      }
    }

    const total7 = list.reduce((acc, item) => acc + Number(item.total ?? item.totalTokens ?? 0), 0);
    const max7 = Math.max(1, ...list.map((item) => Number(item.total ?? item.totalTokens ?? 0)));
    $('last7-total-badge').textContent = `7 日合计 ${formatTokensCompact(total7)}`;

    box.innerHTML = list.map((item) => {
      const val = Number(item.total ?? item.totalTokens ?? 0);
      const pct = Math.max(4, Math.round((val / max7) * 100));
      const label = String(item.date || '').slice(5);
      return `
        <div class="last7-col" data-date="${escapeHtml(item.date || '')}" data-total="${val}" data-input="${item.input ?? 0}" data-cache="${item.cache ?? 0}" data-output="${item.output ?? 0}" data-steps="${item.steps ?? 0}">
          <div class="last7-val tabular-nums">${val > 0 ? formatTokensCompact(val) : '0'}</div>
          <div class="last7-bar-wrap">
            <div class="last7-bar" style="height:${val > 0 ? pct : 3}%"></div>
          </div>
          <div class="last7-day tabular-nums">${escapeHtml(label)}</div>
        </div>
      `;
    }).join('');
  }

  /** 渲染各模型中位数 TPS / TTFT 横向对比条 */
  function renderModelSpeedComparison(speedStats) {
    const container = $('model-speed-bars');
    if (!container) return;

    const list = Array.isArray(speedStats)
      ? speedStats
      : Object.entries(speedStats || {}).map(([model, v]) => ({ model, ...(v || {}) }));

    if (!list.length) {
      container.innerHTML = '<div class="empty-placeholder">暂无有效模型测速样本</div>';
      return;
    }

    const isTtft = state.speedMetricMode === 'ttft';
    const values = list.map((s) => Number(isTtft ? (s.medianTtft ?? s.ttft ?? 0) : (s.medianTps ?? s.tps ?? 0)));
    const maxVal = Math.max(1, ...values);

    container.innerHTML = list.map((s, idx) => {
      const val = values[idx];
      const pct = val > 0 ? Math.max(6, Math.round((val / maxVal) * 100)) : 0;
      const modelName = s.modelLabel || s.productLabel || s.modelExactId || s.model || s.label || '未知模型';
      const cnt = s.count || s.samples || 0;
      const countText = cnt ? ` (${cnt}次${s.lowSample ? '·样本少' : ''})` : '';
      const tpsTxt = s.medianTps != null ? `${Number(s.medianTps).toFixed(1)} tok/s` : '—';
      const ttftTxt = s.medianTtft != null ? `${Number(s.medianTtft).toFixed(2)}s` : '—';
      const valLabel = isTtft ? `${ttftTxt} (${tpsTxt})` : `${tpsTxt} (首字 ${ttftTxt})`;
      return `
        <div class="speed-row">
          <div class="speed-row-head">
            <span>${escapeHtml(modelName)}<small class="card-sub">${escapeHtml(countText)}</small></span>
            <strong class="tabular-nums">${escapeHtml(valLabel)}</strong>
          </div>
          <div class="speed-bar-track">
            <div class="speed-bar-fill" style="width:${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }

  /** 渲染 History Tab 2：每周用量柱状图 */
  function renderWeeklyBarChart(weeklySeries = []) {
    const box = $('weekly-bar-chart');
    const badge = $('weekly-total-badge');
    if (!box) return;

    const list = Array.isArray(weeklySeries) ? weeklySeries.slice(-12) : [];
    if (!list.length) {
      if (badge) badge.textContent = '--';
      box.innerHTML = '<div class="empty-placeholder">暂无周维度用量记录</div>';
      return;
    }

    const totalTok = list.reduce((acc, w) => acc + Number(w.tokens || 0), 0);
    const maxTok = Math.max(1, ...list.map((w) => Number(w.tokens || 0)));
    if (badge) badge.textContent = `近 ${list.length} 周 ${formatTokensCompact(totalTok)}`;

    box.innerHTML = list.map((w) => {
      const val = Number(w.tokens || 0);
      const pct = val > 0 ? Math.max(4, Math.round((val / maxTok) * 100)) : 3;
      const tip = `${w.weekStart || w.label} ~ ${w.weekEnd || ''} · ${val.toLocaleString('en-US')} tok · $${Number(w.costUSD || 0).toFixed(2)}`;
      return `
        <div class="weekly-col" title="${escapeHtml(tip)}">
          <div class="weekly-val tabular-nums">${val > 0 ? formatTokensCompact(val) : '0'}</div>
          <div class="weekly-bar-wrap">
            <div class="weekly-bar" style="height:${pct}%"></div>
          </div>
          <div class="weekly-label tabular-nums">${escapeHtml(w.label || String(w.weekStart || '').slice(5))}</div>
        </div>
      `;
    }).join('');
  }

  /** 渲染 History Tab 2：月度汇总卡片 */
  function renderMonthlySummary(monthlySeries = []) {
    const grid = $('monthly-summary-grid');
    const countEl = $('monthly-summary-count');
    if (!grid) return;

    const list = Array.isArray(monthlySeries) ? monthlySeries.slice(-6).reverse() : [];
    if (countEl) countEl.textContent = `${list.length} 个月`;

    if (!list.length) {
      grid.innerHTML = '<div class="empty-placeholder">暂无月度用量记录</div>';
      return;
    }

    grid.innerHTML = list.map((m) => `
      <div class="monthly-card">
        <div class="monthly-card-head">
          <span>${escapeHtml(m.label || m.month || '--')}</span>
          <span class="tabular-nums">${Number(m.turns || 0)} 轮</span>
        </div>
        <div class="monthly-card-val tabular-nums">${formatTokensCompact(m.tokens ?? 0)}</div>
        <div class="monthly-card-sub tabular-nums">$${Number(m.costUSD || 0).toFixed(2)} · ¥${Number(m.costCNY || 0).toFixed(2)}</div>
      </div>
    `).join('');
  }

  /** 渲染 History Tab 2：纯 SVG 累计 Token / 费用曲线 */
  function renderCumulativeSvgChart(cumulativeSeries = []) {
    const isCost = state.cumMetric === 'cost';
    const list = Array.isArray(cumulativeSeries) ? cumulativeSeries : [];
    const points = list.map((item) => {
      const val = isCost
        ? Number(item.cumulativeCostUSD ?? item.dailyCostUSD ?? 0)
        : Number(item.cumulativeTokens ?? item.dailyTokens ?? 0);
      const dailyTok = formatTokensCompact(item.dailyTokens ?? 0);
      const cumUsd = Number(item.cumulativeCostUSD ?? 0).toFixed(2);
      const cumTok = formatTokensCompact(item.cumulativeTokens ?? 0);
      return {
        value: val,
        timeText: item.label || item.date || '--',
        tooltipText: `${item.date || item.label} · 当日 ${dailyTok} · 累计 ${cumTok} ($${cumUsd})`
      };
    });

    renderPureSvgTrendChart({
      svgEl: $('cumulative-svg'),
      emptyEl: $('cumulative-empty'),
      timeAxisEl: null,
      startEl: $('cumulative-start-date'),
      endEl: $('cumulative-end-date'),
      points,
      formatY: (v) => (isCost ? `$${v.toFixed(v >= 100 ? 0 : 2)}` : formatTokensCompact(v)),
      useAccent: true
    });
  }

  /** 渲染 History Tab 3：订阅对比卡片与输入/缓存/输出分类成本拆分 */
  function renderBillingComparison(billing = {}, costSummary = {}, unpricedSummary) {
    const subWrap = $('billing-sub-compare');
    const catWrap = $('billing-category-breakdown');
    if (!subWrap && !catWrap) return;

    const totalUsd = Number(billing?.totalCostUSD ?? costSummary?.totalCostUSD ?? 0);
    const proMonthly = Number(billing?.proMonthlyUSD ?? costSummary?.proMonthlyUSD ?? 20);
    const maxMonthly = proMonthly * 5;
    const ratio = Number(billing?.vsProRatio ?? costSummary?.vsProRatio ?? (proMonthly > 0 ? totalUsd / proMonthly : 0));
    const coverage = Number(billing?.coveragePercent ?? 100);
    const netDiff = totalUsd - proMonthly;

    if (subWrap) {
      subWrap.innerHTML = `
        <div class="billing-sub-card">
          <span class="card-sub">Pro 月费基准 ($${proMonthly}/月)</span>
          <strong class="tabular-nums">${ratio.toFixed(2)}×</strong>
          <span class="card-sub">已计价覆盖 ${coverage.toFixed(0)}% 调用</span>
        </div>
        <div class="billing-sub-card">
          <span class="card-sub">Ultra / Max ($${maxMonthly}/月)</span>
          <strong class="tabular-nums">${(maxMonthly > 0 ? (totalUsd / maxMonthly) * 100 : 0).toFixed(1)}%</strong>
          <span class="card-sub">累计占高阶档位比例</span>
        </div>
        <div class="billing-sub-card${netDiff >= 0 ? ' is-saving' : ''}">
          <span class="card-sub">${netDiff >= 0 ? '相对按量已回本节省' : '距 Pro 月费回本还差'}</span>
          <strong class="tabular-nums">${netDiff >= 0 ? '+' : ''}$${Math.abs(netDiff).toFixed(2)}</strong>
          <span class="card-sub">${unpricedSummary?.unpricedRequestsCount ? `另有 ${unpricedSummary.unpricedRequestsCount} 步未计价` : '按官方公开费率估算'}</span>
        </div>
      `;
    }

    if (catWrap) {
      const models = Array.isArray(billing?.models) ? billing.models : [];
      const inUsd = billing?.inputCostUSD != null
        ? Number(billing.inputCostUSD)
        : models.reduce((a, m) => a + Number(m.inputCostUSD || 0), 0);
      const caUsd = billing?.cacheCostUSD != null
        ? Number(billing.cacheCostUSD)
        : models.reduce((a, m) => a + Number(m.cacheCostUSD || 0), 0);
      const outUsd = billing?.outputCostUSD != null
        ? Number(billing.outputCostUSD)
        : models.reduce((a, m) => a + Number(m.outputCostUSD || 0), 0);
      const sumSplit = Math.max(0.0001, inUsd + caUsd + outUsd);
      const hasSplit = (inUsd + caUsd + outUsd) > 0;
      const inPct = hasSplit ? (inUsd / sumSplit) * 100 : 33.3;
      const caPct = hasSplit ? (caUsd / sumSplit) * 100 : 33.3;
      const outPct = hasSplit ? Math.max(0, 100 - inPct - caPct) : 33.4;

      catWrap.innerHTML = `
        <div class="billing-cat-bar" title="输入 / 缓存 / 输出费用分布">
          <div class="billing-cat-seg seg-input" style="width:${inPct.toFixed(1)}%"></div>
          <div class="billing-cat-seg seg-cache" style="width:${caPct.toFixed(1)}%"></div>
          <div class="billing-cat-seg seg-output" style="width:${outPct.toFixed(1)}%"></div>
        </div>
        <div class="billing-cat-legend tabular-nums">
          <span>输入 $${inUsd.toFixed(2)} (${hasSplit ? inPct.toFixed(0) : 0}%)</span>
          <span>缓存读取 $${caUsd.toFixed(2)} (${hasSplit ? caPct.toFixed(0) : 0}%)</span>
          <span>输出生成 $${outUsd.toFixed(2)} (${hasSplit ? outPct.toFixed(0) : 0}%)</span>
        </div>
      `;
    }
  }

  /** 渲染 API 等值账单及 $20/月 Pro 订阅性价比对比 */
  function renderCostSummary(costSummary = {}, unpricedSummary, billingComparison = null) {
    const rate = Number(billingComparison?.exchangeRate || costSummary.exchangeRate || 7.25);
    const usd = Number(billingComparison?.totalCostUSD ?? costSummary.totalCostUSD ?? 0);
    const cny = Number(billingComparison?.totalCostCNY ?? costSummary.totalCostCNY ?? usd * rate);
    const proMonthly = Number(billingComparison?.proMonthlyUSD || costSummary.proMonthlyUSD || 20);
    const ratio = Number(billingComparison?.vsProRatio ?? costSummary.vsProRatio ?? (proMonthly > 0 ? usd / proMonthly : 0));

    $('cost-total-usd').textContent = `$${usd.toFixed(2)}`;
    $('cost-total-cny').textContent = `≈ ¥${cny.toFixed(2)} CNY（按汇率 ${rate} 折算）`;
    $('cost-vs-pro-ratio').textContent = `${ratio.toFixed(2)}× Pro 月费 ($${proMonthly})`;

    const fillPct = Math.min(100, Math.round(ratio * 100));
    $('cost-pro-progress-fill').style.width = `${fillPct}%`;
    $('cost-roi-desc').textContent = usd >= proMonthly
      ? `累计 API 零售等值已达 $${proMonthly}/月 Pro 订阅的 ${ratio.toFixed(2)} 倍，订阅性价比极高。`
      : `当前累计 API 零售等值占 $${proMonthly}/月 Pro 订阅的 ${(ratio * 100).toFixed(1)}%。`;

    const byModelRaw = (Array.isArray(billingComparison?.models) && billingComparison.models.length)
      ? billingComparison.models
      : (costSummary.byModel || {});
    const rows = Array.isArray(byModelRaw)
      ? byModelRaw
      : Object.entries(byModelRaw).map(([model, v]) => ({ model, ...(v || {}) }));

    const tbody = $('cost-model-tbody');
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-cell">暂无已计价模型调用记录</td></tr>';
    } else {
      tbody.innerHTML = rows.map((r) => {
        const mUsd = Number(r.costUSD ?? r.usd ?? 0);
        const mCny = Number(r.costCNY ?? mUsd * rate);
        const inTok = formatTokensCompact(r.inputTokens ?? r.input ?? 0);
        const caTok = formatTokensCompact(r.cacheTokens ?? r.cacheReadTokens ?? r.cache ?? 0);
        const outTok = formatTokensCompact(r.outputTokens ?? r.output ?? 0);
        const modelDisplay = r.displayName || r.modelKey || r.model || r.label || '未知模型';
        const stepNum = Number(r.requests ?? r.steps ?? r.count ?? 0);
        return `
          <tr>
            <td>${escapeHtml(modelDisplay)}</td>
            <td class="tabular-nums">${inTok} / ${caTok} / ${outTok}</td>
            <td class="tabular-nums">${stepNum.toLocaleString('en-US')}</td>
            <td class="tabular-nums">$${mUsd.toFixed(3)}</td>
            <td class="tabular-nums">¥${mCny.toFixed(2)}</td>
          </tr>
        `;
      }).join('');
    }

    const unpricedEl = $('cost-unpriced-note');
    if (unpricedEl) {
      const unpricedCount = Number(unpricedSummary?.unpricedRequestsCount ?? billingComparison?.unpricedRequestsCount ?? unpricedSummary?.count ?? unpricedSummary?.totalSteps ?? 0);
      if (unpricedCount > 0) {
        const refUsd = Number(unpricedSummary?.referenceEstimateUSD || 0);
        const refCny = Number(unpricedSummary?.referenceEstimateCNY || 0);
        const refHint = refUsd > 0 ? `（按 Flash 参考费率约 $${refUsd.toFixed(2)} / ¥${refCny.toFixed(2)}）` : '';
        unpricedEl.hidden = false;
        unpricedEl.textContent = `另有 ${unpricedCount} 步调用属于暂未收录官方零售费率或缺少模型标识的记录，未计入主金额${refHint}。`;
      } else {
        unpricedEl.hidden = true;
      }
    }
  }

  // --------------------------------------------------------------------------
  // 左侧边栏：初始化 Bootstrap、工作区切换与历史会话加载
  // --------------------------------------------------------------------------

  async function loadBootstrap() {
    try {
      const data = await apiFetch('/api/bootstrap');
      state.authRequired = Boolean(data.authRequired);
      state.authenticated = data.authenticated !== false;
      state.agyStatus = data.agyStatus || { found: false };
      if (Array.isArray(data.efforts) && data.efforts.length) state.efforts = data.efforts;
      if (Array.isArray(data.modes) && data.modes.length) state.modes = data.modes;
      if (Array.isArray(data.models)) state.models = data.models;
      if (!state.workspace && data.defaultWorkspace) {
        state.workspace = data.defaultWorkspace;
        localStorage.setItem('agy_workspace', state.workspace);
      }

      renderTopbarStatus();
      populateControlSelects();

      if ($('workspace-input')) {
        $('workspace-input').value = state.workspace || '';
      }

      if (state.authRequired && !state.authenticated) {
        openAuthModal();
        return;
      }

      closeAuthModal();
      state.projects = Array.isArray(data.projects) ? data.projects : [];
      state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
      if (!state.activeProjectId && state.workspace) {
        const matchedProj = state.projects.find((p) => p.workspacePath === state.workspace);
        if (matchedProj) state.activeProjectId = matchedProj.id;
      }
      renderConversationList();
      renderChatHeader();

      if (data.commands) {
        if (Array.isArray(data.commands.slashCommands) && data.commands.slashCommands.length) {
          suggestState.allSlashCommands = data.commands.slashCommands;
        }
        if (Array.isArray(data.commands.mentions) && data.commands.mentions.length) {
          suggestState.allMentions = data.commands.mentions;
        }
      }

      if (data.tokenSummary) {
        renderHistoryDashboard({ summary: data.tokenSummary, costSummary: data.tokenSummary.costSummary });
      }
      if (data.usageLimits) {
        renderUsageLimits(data.usageLimits);
      } else {
        refreshUsageLimits();
      }
      // 异步拉取完整历史账单、模型上下文覆写与工作区 Git 状态
      loadTokenHistory(state.historySource);
      loadWorkspaceOverview();
      apiFetch('/api/settings/model-ctx')
        .then((res) => {
          state.modelCtxOverrides = res?.overrides || {};
          syncActiveModelBudget(state.modelCtxOverrides);
        })
        .catch(() => {});
      updateCliPreview();
      renderSidePanel();
    } catch (err) {
      showToast(`初始化失败：${err.message}`, true);
    }
  }

  /**
   * 格式化官方模型显示名称、徽章与可用状态（严格保留原始 rawId，按真实族系与档位生成唯一名称）
   */
  function formatOfficialModel(rawId) {
    const raw = String(rawId || '').trim();
    if (!raw) {
      return { id: '', displayName: '默认模型', badge: '', group: 'gemini', status: 'available' };
    }
    const id = raw.toLowerCase();

    // 1. 判断分组与角标（Claude 与 GPT 模型标记 Notice 徽章）
    const isClaude = id.includes('claude');
    const isGpt = id.includes('gpt') || id.includes('oss');
    const group = (isClaude || isGpt) ? 'claude' : 'gemini';
    const badge = (isClaude || isGpt) ? 'Notice' : '';

    // 2. 提取档位后缀（如 -high, -medium, -low, -xhigh）
    let tierText = '';
    let base = raw;
    const tierMatch = raw.match(/[-_](xhigh|high|medium|low)$/i);
    if (tierMatch) {
      const t = tierMatch[1].toLowerCase();
      tierText = t === 'xhigh' ? 'X-High' : (t.charAt(0).toUpperCase() + t.slice(1));
      base = raw.slice(0, tierMatch.index);
    }

    // 3. 根据核心族系美化基底名称
    let prettyBase = '';
    const baseLower = base.toLowerCase();

    if (baseLower.includes('gemini-4-argon')) {
      prettyBase = 'Gemini 4 Argon';
    } else if (baseLower.includes('gemini-4-hydrogen')) {
      prettyBase = 'Gemini 4 Hydrogen';
    } else if (baseLower.includes('gemini-4-carbon')) {
      prettyBase = 'Gemini 4 Carbon';
    } else if (baseLower === 'gemini-4') {
      prettyBase = 'Gemini 4';
    } else if (baseLower.includes('gemini-3.8-flash')) {
      prettyBase = 'Gemini 3.8 Flash';
    } else if (baseLower.includes('gemini-pro-orchestrator')) {
      prettyBase = 'Gemini Pro Orchestrator G1 Pro';
    } else if (baseLower.includes('claude-opus-5-5') || baseLower.includes('claude-opus-5.5')) {
      prettyBase = 'Claude Opus 5.5';
    } else if (baseLower.includes('claude-sonnet-5-5') || baseLower.includes('claude-sonnet-5.5')) {
      prettyBase = 'Claude Sonnet 5.5';
    } else if (baseLower.includes('claude-opus-4-6') || baseLower === 'claude-opus-4-6-thinking') {
      prettyBase = 'Claude Opus 4.6 (Thinking)';
    } else if (baseLower.includes('claude-sonnet-4-6')) {
      prettyBase = 'Claude Sonnet 4.6 (Thinking)';
    } else if (baseLower.includes('gpt-oss-120b')) {
      prettyBase = 'GPT-OSS 120B';
    } else {
      prettyBase = base.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    }

    // 组装最终展示名称：基底 + 档位（若基底尚未包含对应档位说明）
    let displayName = prettyBase;
    if (tierText && !prettyBase.includes(`(${tierText})`)) {
      displayName = `${prettyBase} (${tierText})`;
    }

    return {
      id: raw, // 关键：严格保留真实模型 ID，供 agy --model 透传调用
      displayName,
      badge,
      group,
      status: 'available'
    };
  }

  /** 全局额度数据状态缓存 */
  let usageLimitsData = null;

  /**
   * 渲染并计算官方 1:1 额度圆环与文本
   */
  function renderUsageLimits(data) {
    if (!data) return;
    usageLimitsData = data;

    const gWeeklyPct = Math.max(0, Math.min(100, Number(data.gemini?.weeklyLimit?.percentLeft ?? 88)));
    const g5hPct = Math.max(0, Math.min(100, Number(data.gemini?.fiveHourLimit?.percentLeft ?? 72)));
    const cWeeklyPct = Math.max(0, Math.min(100, Number(data.claudeAndGpt?.weeklyLimit?.percentLeft ?? 100)));
    const c5hPct = Math.max(0, Math.min(100, Number(data.claudeAndGpt?.fiveHourLimit?.percentLeft ?? 100)));

    // 周限额圆环 (r=9, 周长=56.55)
    const setRing = (circleId, pct) => {
      const el = $(circleId);
      if (!el) return;
      const circumference = 56.55;
      const offset = circumference * (1 - pct / 100);
      el.style.strokeDashoffset = String(offset.toFixed(2));
      el.classList.toggle('is-warn', pct <= 30 && pct > 10);
      el.classList.toggle('is-danger', pct <= 10);
    };

    setRing('usage-gemini-weekly-circle', gWeeklyPct);
    setRing('usage-gemini-5h-circle', g5hPct);
    setRing('usage-claude-weekly-circle', cWeeklyPct);
    setRing('usage-claude-5h-circle', c5hPct);

    if ($('usage-gemini-weekly-text')) $('usage-gemini-weekly-text').textContent = `${gWeeklyPct}% left`;
    if ($('usage-gemini-5h-text')) $('usage-gemini-5h-text').textContent = `${g5hPct}% left`;
    if ($('usage-claude-weekly-text')) $('usage-claude-weekly-text').textContent = `${cWeeklyPct}% left`;
    if ($('usage-claude-5h-text')) $('usage-claude-5h-text').textContent = `${c5hPct}% left`;

    if ($('usage-gemini-weekly-reset')) $('usage-gemini-weekly-reset').textContent = data.gemini?.weeklyLimit?.resetTimeText || 'Resets in 5d 15h';
    if ($('usage-gemini-5h-reset')) $('usage-gemini-5h-reset').textContent = data.gemini?.fiveHourLimit?.resetTimeText || 'Resets in 39m';
    if ($('usage-claude-weekly-reset')) $('usage-claude-weekly-reset').textContent = data.claudeAndGpt?.weeklyLimit?.resetTimeText || 'Resets in 6d 2h';
    if ($('usage-claude-5h-reset')) $('usage-claude-5h-reset').textContent = data.claudeAndGpt?.fiveHourLimit?.resetTimeText || 'Resets in 4h 50m';

    // 同步更新输入框胶囊上的当前模型额度百分比微型圆环 (r=6, 周长=37.7)
    updateModelPickerQuotaPill();
  }

  let isRefreshingUsage = false;
  /**
   * 刷新并拉取最新额度数据
   * @param {boolean} [silent=false] 是否静默更新（不弹 Toast 提示）
   */
  async function refreshUsageLimits(silent = false) {
    if (isRefreshingUsage) return;
    isRefreshingUsage = true;
    const refreshBtn = $('btn-refresh-usage');
    refreshBtn?.classList.add('is-spinning');

    try {
      const data = await apiFetch('/api/meter/usage-limits');
      renderUsageLimits(data);
      if (!silent) {
        showToast('已同步最新模型配额与使用限制');
      }
    } catch {
      // 容错使用当前缓存
    } finally {
      isRefreshingUsage = false;
      refreshBtn?.classList.remove('is-spinning');
    }
  }

  /**
   * 根据当前选中的模型分组更新输入框胶囊上的额度指示环
   */
  function updateModelPickerQuotaPill() {
    const activeModelId = $('select-model')?.value || 'gemini-3.8-flash-high';
    const info = formatOfficialModel(activeModelId);
    const isClaude = info.group === 'claude';

    let activePct = 100;
    if (usageLimitsData) {
      activePct = isClaude
        ? Number(usageLimitsData.claudeAndGpt?.fiveHourLimit?.percentLeft ?? 100)
        : Number(usageLimitsData.gemini?.fiveHourLimit?.percentLeft ?? 72);
    } else {
      activePct = isClaude ? 100 : 72;
    }

    const textEl = $('model-picker-quota-text');
    const circleEl = $('model-picker-quota-circle');
    const badgeEl = $('model-picker-quota');

    if (textEl) textEl.textContent = `${activePct}%`;
    if (circleEl) {
      const circumference = 37.7;
      const offset = circumference * (1 - activePct / 100);
      circleEl.style.strokeDashoffset = String(offset.toFixed(2));
    }
    if (badgeEl) {
      badgeEl.classList.toggle('is-warn', activePct <= 30 && activePct > 10);
      badgeEl.classList.toggle('is-danger', activePct <= 10);
      badgeEl.title = `当前模型组额度剩余 ${activePct}%（5h 限制）`;
    }
  }

  /**
   * 官方标准族系基底模型配置表（完全对齐 Google 官方 Antigravity 沉浸式二级抽屉结构）
   */
  const OFFICIAL_BASE_MODELS = [
    {
      baseId: 'gemini-4-argon',
      displayName: 'Gemini 4 Argon',
      group: 'gemini',
      badge: '',
      matchPrefix: 'gemini-4-argon',
      tierOrder: ['low', 'medium', 'high']
    },
    {
      baseId: 'gemini-4-hydrogen',
      displayName: 'Gemini 4 Hydrogen',
      group: 'gemini',
      badge: '',
      matchPrefix: 'gemini-4-hydrogen',
      tierOrder: ['low', 'medium', 'high', 'xhigh']
    },
    {
      baseId: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      group: 'gemini',
      badge: '',
      matchPrefix: 'gemini-3.8-flash',
      tierOrder: ['low', 'medium', 'high']
    },
    {
      baseId: 'claude-sonnet-5-5',
      displayName: 'Claude Sonnet 5.5',
      group: 'claude',
      badge: 'Notice',
      matchPrefix: 'claude-sonnet-5-5',
      tierOrder: ['low', 'medium', 'high']
    },
    {
      baseId: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      group: 'claude',
      badge: 'Notice',
      matchPrefix: 'claude-opus-5-5',
      tierOrder: ['low', 'medium', 'high']
    },
    {
      baseId: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6 (Thinking)',
      group: 'claude',
      badge: 'Notice',
      matchPrefix: 'claude-sonnet-4-6',
      tierOrder: []
    },
    {
      baseId: 'claude-opus-4-6',
      displayName: 'Claude Opus 4.6 (Thinking)',
      group: 'claude',
      badge: 'Notice',
      matchPrefix: 'claude-opus-4-6',
      tierOrder: []
    },
    {
      baseId: 'gpt-oss-120b',
      displayName: 'GPT-OSS 120B (Medium)',
      group: 'claude',
      badge: 'Notice',
      matchPrefix: 'gpt-oss-120b',
      tierOrder: []
    },
    {
      baseId: 'gemini-pro-orchestrator',
      displayName: 'Gemini Pro Orchestrator G1 Pro',
      group: 'gemini',
      badge: '',
      matchPrefix: 'gemini-pro-orchestrator',
      tierOrder: []
    },
    {
      baseId: 'gemini-4-carbon',
      displayName: 'Gemini 4 Carbon',
      group: 'gemini',
      badge: 'Unavailable',
      status: 'unavailable',
      matchPrefix: 'gemini-4-carbon',
      tierOrder: []
    }
  ];

  /**
   * 将当前账号可用模型归纳为官方族系基底模型与思考档位目录
   */
  function buildGroupedModelCatalog() {
    const sourceModels = (Array.isArray(state.models) && state.models.length > 0)
      ? state.models
      : ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];

    const catalog = [];
    const matchedModelIds = new Set();

    for (const def of OFFICIAL_BASE_MODELS) {
      const tiers = [];
      const prefix = def.matchPrefix.toLowerCase();

      for (const rawId of sourceModels) {
        const mid = (typeof rawId === 'string' ? rawId : (rawId.id || rawId.modelId || rawId.name)).toLowerCase();
        if (mid === prefix || mid.startsWith(`${prefix}-`)) {
          matchedModelIds.add(mid);
          const tierMatch = mid.match(/[-_](xhigh|high|medium|low)$/i);
          const tierKey = tierMatch ? tierMatch[1].toLowerCase() : 'default';
          const tierLabel = tierKey === 'xhigh' ? 'X-High' : (tierKey === 'default' ? 'Default' : (tierKey.charAt(0).toUpperCase() + tierKey.slice(1)));
          tiers.push({
            modelId: typeof rawId === 'string' ? rawId : mid,
            tierKey,
            tierLabel
          });
        }
      }

      // 遵循 Low -> Medium -> High -> X-High 顺序
      const tierRank = { low: 1, medium: 2, high: 3, xhigh: 4, default: 5 };
      tiers.sort((a, b) => (tierRank[a.tierKey] || 99) - (tierRank[b.tierKey] || 99));

      if (tiers.length > 0) {
        catalog.push({
          baseId: def.baseId,
          displayName: def.displayName,
          badge: def.badge,
          group: def.group,
          status: 'available',
          tiers,
          hasTiers: tiers.length > 1
        });
      } else if (def.status === 'unavailable' || def.baseId === 'gemini-4-carbon') {
        catalog.push({
          baseId: def.baseId,
          displayName: def.displayName,
          badge: 'Unavailable',
          group: def.group,
          status: 'unavailable',
          tiers: [],
          hasTiers: false
        });
      }
    }

    // 补全其它未列在官方标准配置中的自定义模型
    for (const rawId of sourceModels) {
      const mid = (typeof rawId === 'string' ? rawId : (rawId.id || rawId.modelId || rawId.name)).toLowerCase();
      if (!matchedModelIds.has(mid)) {
        const info = formatOfficialModel(rawId);
        catalog.push({
          baseId: rawId,
          displayName: info.displayName,
          badge: info.badge,
          group: info.group,
          status: 'available',
          tiers: [{ modelId: rawId, tierKey: 'default', tierLabel: 'Default' }],
          hasTiers: false
        });
      }
    }

    return catalog;
  }

  /**
   * 渲染官方 1:1 模型选择弹窗列表（收敛思考模式为二级抽屉）
   */
  function renderModelSwitcherList() {
    const listEl = $('model-popover-list');
    if (!listEl) return;

    const activeModelId = $('select-model')?.value || localStorage.getItem('agy_model') || '';
    const catalog = buildGroupedModelCatalog();

    listEl.innerHTML = catalog.map((item) => {
      const isUnavailable = item.status === 'unavailable';
      const hasTiers = item.hasTiers && item.tiers.length > 1;

      // 判断当前族系基底模型是否匹配当前激活的模型
      const isBaseSelected = Boolean(item.tiers.some(t => t.modelId === activeModelId));
      const activeTierObj = item.tiers.find(t => t.modelId === activeModelId)
        || item.tiers.find(t => t.tierKey === 'high')
        || item.tiers[item.tiers.length - 1]
        || item.tiers[0];

      const activeTierLabel = activeTierObj ? activeTierObj.tierLabel : '';

      const badgeHtml = item.badge === 'Notice'
        ? `<span class="model-badge-notice">Notice ⓘ</span>`
        : (item.badge === 'Unavailable' ? `<span class="model-badge-unavailable">Unavailable ⓘ</span>` : '');

      if (hasTiers && !isUnavailable) {
        // 官方 1:1 级联抽屉：左侧模型名，右侧当前档位 + > 箭头，悬停/展开时弹出子菜单
        const subItemsHtml = item.tiers.map((t) => {
          const isSubSelected = t.modelId === activeModelId;
          const checkHtml = isSubSelected
            ? `<svg class="model-item-check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M3.5 8.5l3 3 6-6"/></svg>`
            : '';
          return `
            <button class="model-tier-item${isSubSelected ? ' is-selected' : ''}" type="button" data-model-id="${escapeHtml(t.modelId)}">
              <span>${escapeHtml(t.tierLabel)}</span>
              ${checkHtml}
            </button>
          `;
        }).join('');

        return `
          <div class="model-row-wrap" data-base-id="${escapeHtml(item.baseId)}">
            <button class="model-popover-item has-tiers${isBaseSelected ? ' is-selected' : ''}" type="button" data-base-id="${escapeHtml(item.baseId)}" data-default-model-id="${escapeHtml(activeTierObj.modelId)}">
              <div class="model-item-title">
                <span>${escapeHtml(item.displayName)}</span>
                ${badgeHtml}
              </div>
              <div class="model-item-right">
                <span class="model-item-tier">${escapeHtml(activeTierLabel)}</span>
                <svg class="chevron-right-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 4l4 4-4 4"/></svg>
              </div>
            </button>
            <div class="model-tier-submenu" role="menu" aria-label="${escapeHtml(item.displayName)} 思考档位">
              ${subItemsHtml}
            </div>
          </div>
        `;
      }

      // 单档位模型或不可用模型
      const singleModelId = item.tiers[0]?.modelId || item.baseId;
      const checkHtml = (isBaseSelected && !isUnavailable)
        ? `<svg class="model-item-check" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-6"/></svg>`
        : '';

      return `
        <div class="model-row-wrap" data-base-id="${escapeHtml(item.baseId)}">
          <button class="model-popover-item${isBaseSelected ? ' is-selected' : ''}${isUnavailable ? ' is-disabled' : ''}" type="button" data-model-id="${escapeHtml(singleModelId)}" ${isUnavailable ? 'disabled' : ''}>
            <div class="model-item-title">
              <span>${escapeHtml(item.displayName)}</span>
              ${badgeHtml}
            </div>
            ${checkHtml}
          </button>
        </div>
      `;
    }).join('');

    // 点击二级抽屉中具体档位进行切换
    listEl.querySelectorAll('.model-tier-item').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const mid = btn.dataset.modelId;
        if (mid) selectModelQuick(mid);
      });
    });

    // 点击主模型项切换或移动端展开
    listEl.querySelectorAll('.model-popover-item:not(.is-disabled)').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        if (btn.classList.contains('has-tiers')) {
          const wrap = btn.closest('.model-row-wrap');
          if (wrap) {
            wrap.classList.toggle('is-open');
          }
          const targetMid = btn.dataset.defaultModelId;
          if (targetMid) {
            selectModelQuick(targetMid);
          }
        } else {
          const mid = btn.dataset.modelId;
          if (mid) selectModelQuick(mid);
        }
      });
    });
  }

  /**
   * 一键极速切换当前模型
   */
  function selectModelQuick(modelId) {
    const modelSel = $('select-model');
    if (modelSel) {
      // 确保 option 存在
      if (!Array.from(modelSel.options).some((o) => o.value === modelId)) {
        const opt = document.createElement('option');
        opt.value = modelId;
        opt.textContent = formatOfficialModel(modelId).displayName;
        modelSel.appendChild(opt);
      }
      modelSel.value = modelId;
      modelSel.dispatchEvent(new Event('change'));
    }

    localStorage.setItem('agy_model', modelId);
    const info = formatOfficialModel(modelId);

    // 同步更新输入框胶囊文本
    const nameEl = $('model-picker-name');
    if (nameEl) nameEl.textContent = info.displayName;

    // 同步顶栏上下文面板中的模型胶囊
    const ctxModelEl = $('ctx-panel-model-pill');
    if (ctxModelEl) ctxModelEl.textContent = info.displayName;

    // 更新微型额度圆环
    updateModelPickerQuotaPill();

    // 关闭模型浮层并重新渲染列表对勾
    closeModelSwitcherPopover();
    renderModelSwitcherList();

    showToast(`已切换推理模型：${info.displayName}`);
  }

  /**
   * 打开/关闭官方模型选择与额度浮层
   */
  function toggleModelSwitcherPopover() {
    const pop = $('model-switcher-popover');
    const trigger = $('btn-model-picker');
    if (!pop) return;

    const willOpen = pop.hidden;
    pop.hidden = !willOpen;
    if (trigger) {
      trigger.setAttribute('aria-expanded', String(willOpen));
      trigger.classList.toggle('is-active', willOpen);
    }
    if (willOpen) {
      renderModelSwitcherList();
      updateModelPickerQuotaPill();
      // 每次点开模型选择与额度浮层时，自动重新查询并刷新最新额度
      refreshUsageLimits(true);
    }
  }

  function closeModelSwitcherPopover() {
    const pop = $('model-switcher-popover');
    const trigger = $('btn-model-picker');
    if (pop && !pop.hidden) {
      pop.hidden = true;
      if (trigger) {
        trigger.setAttribute('aria-expanded', 'false');
        trigger.classList.remove('is-active');
      }
    }
  }

  /**
   * 切换权限执行模式 (Turbo -> Auto -> Accept-Edits -> Plan 循环)
   */
  function cyclePermissionMode() {
    const modes = [
      { label: 'Turbo', mode: 'auto', skip: true },
      { label: 'Auto', mode: 'auto', skip: false },
      { label: 'Accept-Edits', mode: 'accept-edits', skip: false },
      { label: 'Plan', mode: 'plan', skip: false }
    ];

    const currentMode = $('select-mode')?.value || 'auto';
    const currentSkip = Boolean($('chk-skip-permissions')?.checked);

    let idx = 0;
    if (currentMode === 'auto' && currentSkip) idx = 0;
    else if (currentMode === 'auto' && !currentSkip) idx = 1;
    else if (currentMode === 'accept-edits') idx = 2;
    else if (currentMode === 'plan') idx = 3;

    const next = modes[(idx + 1) % modes.length];

    const modeSel = $('select-mode');
    const chkSkip = $('chk-skip-permissions');
    if (modeSel) {
      modeSel.value = next.mode;
      modeSel.dispatchEvent(new Event('change'));
    }
    if (chkSkip) {
      chkSkip.checked = next.skip;
      chkSkip.dispatchEvent(new Event('change'));
    }

    const labelEl = $('mode-picker-label');
    if (labelEl) labelEl.textContent = next.label;

    updateCliPreview();
    showToast(`执行模式已切换为：${next.label}`);
  }

  /** 填充底部控制栏的模型、Effort、Mode 下拉框 */
  function populateControlSelects() {
    const modelSel = $('select-model');
    if (modelSel) {
      const prev = modelSel.value || localStorage.getItem('agy_model') || '';
      const models = (Array.isArray(state.models) && state.models.length > 0)
        ? state.models
        : ['gemini-3.8-flash-high', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'];

      // 格式化并去重
      const seen = new Set();
      const validOptions = [];
      models.forEach((m) => {
        const val = typeof m === 'string' ? m : (m.id || m.modelId || m.name);
        if (!val || seen.has(val)) return;
        seen.add(val);
        const info = formatOfficialModel(val);
        validOptions.push({ val, displayName: info.displayName });
      });

      modelSel.innerHTML = validOptions.map((o) => {
        return `<option value="${escapeHtml(o.val)}">${escapeHtml(o.displayName)}</option>`;
      }).join('');

      // 选择优先逻辑：若 prev 存在且匹配则保留；若 prev 类似（如前缀匹配）则自动迁移；否则选中第 1 项
      let chosen = '';
      if (prev && seen.has(prev)) {
        chosen = prev;
      } else if (prev) {
        const partial = validOptions.find((o) => o.val.startsWith(prev) || prev.startsWith(o.val));
        if (partial) chosen = partial.val;
      }
      if (!chosen && validOptions.length > 0) {
        chosen = validOptions[0].val;
      }

      if (chosen) {
        modelSel.value = chosen;
        localStorage.setItem('agy_model', chosen);
      }

      // 初始化输入框模型胶囊文字
      const activeInfo = formatOfficialModel(modelSel.value || chosen);
      if ($('model-picker-name')) $('model-picker-name').textContent = activeInfo.displayName;
      if ($('ctx-panel-model-pill')) $('ctx-panel-model-pill').textContent = activeInfo.displayName;
    }

    const effortSel = $('select-effort');
    if (effortSel && state.efforts.length) {
      const prev = effortSel.value ?? '';
      const effortOptions = ['', ...state.efforts.filter((e) => e !== '')];
      effortSel.innerHTML = effortOptions.map((e) => `<option value="${escapeHtml(e)}">${escapeHtml(e || '默认')}</option>`).join('');
      if (effortOptions.includes(prev)) effortSel.value = prev;
    }

    const modeSel = $('select-mode');
    if (modeSel && state.modes.length) {
      const prev = modeSel.value || 'auto';
      modeSel.innerHTML = state.modes.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
      if (state.modes.includes(prev)) modeSel.value = prev;
    }

    renderModelSwitcherList();
    updateModelPickerQuotaPill();
  }

  async function refreshProjects() {
    try {
      const data = await apiFetch('/api/projects');
      if (Array.isArray(data.projects)) state.projects = data.projects;
      renderConversationList();
      renderChatHeader();
    } catch (err) {
      showToast(`刷新项目列表失败：${err.message}`, true);
    }
  }

  async function refreshConversations() {
    try {
      const [convRes, projRes] = await Promise.allSettled([
        apiFetch('/api/conversations'),
        apiFetch('/api/projects')
      ]);
      if (convRes.status === 'fulfilled') {
        state.conversations = Array.isArray(convRes.value.conversations) ? convRes.value.conversations : [];
      } else {
        throw convRes.reason;
      }
      if (projRes.status === 'fulfilled' && Array.isArray(projRes.value.projects)) {
        state.projects = projRes.value.projects;
      }
      renderConversationList();
    } catch (err) {
      showToast(`刷新会话失败：${err.message}`, true);
    }
  }

  /** 按项目分组渲染左侧历史会话列表（支持折叠展开、See all 与相对时间） */
  function renderConversationList() {
    const listEl = $('conversation-list');
    if (!listEl) return;

    const kw = state.convSearch.trim().toLowerCase();
    const groupMap = new Map();

    // 先填入后端返回的已知项目（按路径去重），保证默认项目与自定义项目正常出现
    const seenWsKeys = new Set();
    (state.projects || []).forEach((p) => {
      if (!p || !p.id) return;
      const wsKey = (p.workspacePath || '').trim().toLowerCase();
      if (wsKey && seenWsKeys.has(wsKey)) return;
      if (wsKey) seenWsKeys.add(wsKey);
      groupMap.set(p.id, {
        id: p.id,
        name: p.name || getPathBasename(p.workspacePath) || '未命名项目',
        workspacePath: p.workspacePath || '',
        convs: []
      });
    });

    (state.conversations || []).forEach((c) => {
      if (state.convFilter === 'active' && c.archived) return;
      if (state.convFilter === 'unread' && (!c.unread || c.archived)) return;
      if (state.convFilter === 'archived' && !c.archived) return;
      if (kw) {
        const hay = `${c.title || ''} ${c.model || ''} ${c.id || ''} ${c.projectName || ''}`.toLowerCase();
        if (!hay.includes(kw)) return;
      }
      const ws = c.workspacePath || c.workspace || '';
      // 仅匹配显式允许展示的项目（默认展示 /home/workspace 与手动新建项目，隐藏其它历史临时目录）
      const matchedProj = (state.projects || []).find((p) => {
        if (!p || !p.id) return false;
        if (c.projectId && p.id === c.projectId) return true;
        if (p.workspacePath && ws && (p.workspacePath === ws || p.workspacePath.toLowerCase() === ws.toLowerCase())) return true;
        return false;
      });
      const key = matchedProj ? matchedProj.id : '__unassigned__';
      if (!groupMap.has(key)) {
        groupMap.set(key, {
          id: key,
          name: key === '__unassigned__' ? '未归类会话' : (c.projectName || getPathBasename(ws) || '未归类会话'),
          workspacePath: ws,
          convs: []
        });
      }
      groupMap.get(key).convs.push(c);
    });

    const groups = Array.from(groupMap.values()).filter((g) => {
      if (kw || state.convFilter !== 'active') {
        return g.convs.length > 0 || (kw && g.name.toLowerCase().includes(kw));
      }
      return g.convs.length > 0 || (state.projects || []).some((p) => p.id === g.id);
    });

    // 未归类分组始终排在最末
    groups.sort((a, b) => {
      if (a.id === '__unassigned__' && b.id !== '__unassigned__') return 1;
      if (b.id === '__unassigned__' && a.id !== '__unassigned__') return -1;
      return 0;
    });

    if (!groups.length) {
      listEl.innerHTML = `<div class="empty-placeholder">${kw ? '没有匹配的会话或项目' : '暂无本机项目与历史会话'}</div>`;
      return;
    }

    const DEFAULT_VISIBLE = 5;
    listEl.innerHTML = groups.map((g) => {
      const isActiveProj = state.activeProjectId
        ? state.activeProjectId === g.id
        : Boolean(g.workspacePath && state.workspace && g.workspacePath === state.workspace);
      const isCollapsed = Boolean(state.collapsedProjects[g.id]) && !kw;
      const activeIdx = g.convs.findIndex((c) => c.id === state.activeConversationId);
      const isExpanded = Boolean(state.expandedProjects[g.id]) || Boolean(kw) || activeIdx >= DEFAULT_VISIBLE;
      const visibleConvs = isExpanded ? g.convs : g.convs.slice(0, DEFAULT_VISIBLE);

      let bodyHtml = '';
      if (!isCollapsed) {
        if (!g.convs.length) {
          bodyHtml = '<div class="project-conv-list"><div class="empty-placeholder">暂无会话，点击 + 发起</div></div>';
        } else {
          const itemsHtml = visibleConvs.map((c) => {
            const src = String(c.source || 'cli').toLowerCase() === 'desktop' ? 'desktop' : 'cli';
            const srcLabel = src === 'desktop' ? 'Desktop' : 'CLI';
            const pct = Math.max(0, Math.min(100, Math.round(Number(c.latestContext?.percent ?? 0))));
            const isActive = state.activeConversationId === c.id;
            const hasErr = Boolean(c.latestContext?.errorKind && c.latestContext.errorKind !== 'none');
            const dotCls = isActive ? ' is-active' : (hasErr ? ' is-error' : '');
            const modelLabel = c.model || '默认模型';
            const relTime = formatRelativeCompact(c.updatedAt) || formatTimeShort(c.updatedAt);
            const isMenuOpen = state.contextMenuConvId === c.id;
            const isRenaming = state.renamingConvId === c.id;
            const itemClasses = [
              'conv-item',
              isActive ? 'is-active' : '',
              c.unread ? 'is-unread' : '',
              c.archived ? 'is-archived' : '',
              isMenuOpen ? 'is-menu-open' : ''
            ].filter(Boolean).join(' ');

            const titleNode = isRenaming
              ? `<input class="conv-inline-rename" type="text" data-rename-input="${escapeHtml(c.id)}" value="${escapeHtml(c.title || '')}" maxlength="200" />`
              : `<span class="conv-title" title="${escapeHtml(c.title || c.id)}">${escapeHtml(c.title || '未命名会话')}</span>`;

            const pinIndicator = c.pinned
              ? `<span class="conv-pin-badge" title="已置顶"><svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5.5 2.5h5l-1 4.2 2 1.8v1.2H8.6v3.8L8 14.5l-.6-1V9.7H4.5V8.5l2-1.8-1-4.2z"/></svg></span>`
              : '';

            return `
              <div class="${itemClasses}" data-conv-id="${escapeHtml(c.id)}" role="listitem" tabindex="0">
                <div class="conv-item-top">
                  <div class="conv-title-wrap">
                    <span class="conv-status-dot${dotCls}"></span>
                    ${pinIndicator}
                    ${titleNode}
                  </div>
                  <div class="conv-item-right">
                    <span class="src-badge src-${src}">${srcLabel}</span>
                    <span class="conv-rel-time tabular-nums" title="${escapeHtml(formatTimeShort(c.updatedAt))}">${escapeHtml(relTime)}</span>
                    <div class="conv-quick-actions">
                      <button class="conv-action-btn${c.archived ? ' is-on' : ''}" type="button" data-conv-archive="${escapeHtml(c.id)}" title="${c.archived ? '取消归档' : '归档会话'}" aria-label="${c.archived ? '取消归档' : '归档会话'}">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                          <rect x="2" y="2.5" width="12" height="3" rx="0.8" />
                          <path d="M3 5.5v7.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5M6.5 8.5h3" />
                        </svg>
                      </button>
                      <button class="conv-action-btn${c.pinned ? ' is-on' : ''}" type="button" data-conv-pin="${escapeHtml(c.id)}" title="${c.pinned ? '取消置顶' : '置顶会话'}" aria-label="${c.pinned ? '取消置顶' : '置顶会话'}">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                          <path d="M5.5 2.5h5l-1 4.2 2 1.8v1.2H8.6v3.8L8 14.5l-.6-1V9.7H4.5V8.5l2-1.8-1-4.2z"/>
                        </svg>
                      </button>
                      <button class="conv-action-btn" type="button" data-conv-menu="${escapeHtml(c.id)}" title="更多操作" aria-label="更多操作">
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
                          <circle cx="8" cy="3.5" r="1.2" />
                          <circle cx="8" cy="8" r="1.2" />
                          <circle cx="8" cy="12.5" r="1.2" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
                <div class="conv-item-meta">
                  <span class="conv-model">${escapeHtml(modelLabel)}</span>
                  <span class="tabular-nums">${pct}%</span>
                </div>
                <div class="conv-pct-track">
                  <div class="conv-pct-fill" style="width:${pct}%"></div>
                </div>
              </div>
            `;
          }).join('');

          const seeAllHtml = g.convs.length > DEFAULT_VISIBLE && !kw
            ? `<button class="see-all-btn" type="button" data-project-see-all="${escapeHtml(g.id)}">${isExpanded ? `收起 (${g.convs.length})` : `See all (${g.convs.length})`}</button>`
            : '';

          bodyHtml = `<div class="project-conv-list">${itemsHtml}${seeAllHtml}</div>`;
        }
      }

      return `
        <div class="project-group" data-project-group="${escapeHtml(g.id)}">
          <div class="project-header${isActiveProj ? ' is-active' : ''}">
            <div class="project-header-left" data-project-select="${escapeHtml(g.id)}" title="${escapeHtml(g.workspacePath || g.name)}">
              <button class="project-toggle-btn" type="button" data-project-toggle="${escapeHtml(g.id)}" aria-label="展开或折叠项目">${isCollapsed ? '▸' : '▾'}</button>
              <span>📁</span>
              <span class="project-name">${escapeHtml(g.name)}</span>
            </div>
            <div class="project-header-right">
              <span class="project-count tabular-nums">${g.convs.length}</span>
              <button class="project-new-chat-btn" type="button" data-project-new="${escapeHtml(g.id)}" title="在该项目中新建会话">+</button>
            </div>
          </div>
          ${bodyHtml}
        </div>
      `;
    }).join('');
  }

  /** 点击历史会话：拉取完整历史记录并绑定 --conversation <id> */
  async function selectConversation(convId) {
    if (!convId) return;
    try {
      const data = await apiFetch(`/api/conversations/${encodeURIComponent(convId)}`);
      const conv = data.conversation || data;
      if (!conv) throw new Error('未找到会话内容');

      state.activeConversationId = conv.id || convId;
      state.activeConversationTitle = conv.title || convId;
      state.activeConversationDetail = conv;
      if (conv.unread) {
        patchConversationPref(conv.id || convId, { unread: false }, '', true);
      }
      if (conv.projectId) state.activeProjectId = conv.projectId;
      if (!state.workspace && (conv.workspacePath || conv.workspace)) {
        state.workspace = conv.workspacePath || conv.workspace;
        if ($('workspace-input')) $('workspace-input').value = state.workspace;
      }
      state.sessionSentAttachments = [];

      // 如果会话自带工作区且本地尚未切换，可按需同步模型
      if (conv.model) {
        const modelSel = $('select-model');
        if (modelSel && Array.from(modelSel.options).some((o) => o.value === conv.model)) {
          modelSel.value = conv.model;
        }
      }

      // 将历史消息归一化为前端展示结构
      state.messages = normalizeHistoryMessages(conv.messages || []);
      if (conv.latest?.speed) {
        const lastAi = [...state.messages].reverse().find((m) => m.role === 'assistant');
        if (lastAi && !lastAi.metrics) {
          lastAi.metrics = {
            tps: conv.latest.speed.tps ?? null,
            ttft: conv.latest.speed.ttft ?? null,
            duration: conv.latest.speed.duration ?? null,
            outputTokens: conv.latest.speed.outputTokens ?? null,
            model: conv.latest.model || conv.model || ''
          };
        }
      }
      syncContextMetricsFromConversation(conv);
      renderConversationList();
      renderChatHeader();
      renderMessages();
      renderContextView();
      renderSidePanel();
      updateCliPreview();
      closeMobileDrawers();
    } catch (err) {
      showToast(`加载会话详情失败：${err.message}`, true);
    }
  }

  /** 将后端返回的 transcript 消息归一化为聊天消息列表 */
  function normalizeHistoryMessages(rawMessages) {
    return rawMessages.map((msg, idx) => {
      const rawRole = String(msg.role || 'assistant').toLowerCase();
      const role = ['user', 'error', 'system'].includes(rawRole) ? rawRole : 'assistant';
      const toolCalls = Array.isArray(msg.toolCalls || msg.tool_calls)
        ? (msg.toolCalls || msg.tool_calls).map((tc) => ({
            name: tc.name || tc.toolName || 'tool',
            status: tc.isError ? 'error' : (tc.status || 'done'),
            input: tc.input || tc.args || tc.arguments || '',
            output: tc.output || tc.result || ''
          }))
        : [];
      return {
        id: msg.id || `hist-${idx}`,
        role,
        type: msg.type || '',
        text: msg.text || msg.content || msg.error || '',
        thinking: msg.thinking || '',
        toolCalls,
        attachments: Array.isArray(msg.attachments || msg.media) ? (msg.attachments || msg.media) : [],
        metrics: msg.metrics || msg.speed || null,
        timestamp: msg.timestamp || msg.createdAt || ''
      };
    });
  }

  /** 将历史会话详情中的用量与 5 维统计同步至顶栏胶囊 1 */
  function syncContextMetricsFromConversation(conv) {
    const latest = conv.latest || {};
    const budget = Number(latest.budget || DEFAULT_BUDGET);
    const used = Number(latest.used ?? latest.actual ?? latest.estimate ?? 0);
    const percent = latest.percent ?? (budget > 0 ? (used / budget) * 100 : 0);

    state.contextMetrics = {
      used,
      actual: latest.actual ?? null,
      estimate: latest.estimate ?? conv.total?.estimate ?? null,
      budget,
      percent,
      tps: latest.speed?.tps ?? null,
      ttft: latest.speed?.ttft ?? null,
      duration: latest.speed?.duration ?? null,
      outputTokens: latest.speed?.outputTokens ?? latest.speed?.output ?? null,
      model: latest.model || conv.model || '',
      errorClassification: latest.errorClassification || { kind: 'none', badgeText: '正常', title: '正常', detail: '', diagnostic: '' },
      groups: conv.groups || state.contextMetrics.groups,
      totalChars: conv.total?.chars ?? 0,
      totalTokens: conv.total?.estimate ?? 0
    };
  }

  /** 开启全新会话并解绑 --conversation */
  function startNewConversation() {
    state.activeConversationId = null;
    state.activeConversationTitle = '新建远程会话';
    state.activeConversationDetail = null;
    state.messages = [];
    state.sessionSentAttachments = [];
    state.contextMetrics = {
      ...state.contextMetrics,
      used: 0,
      actual: null,
      estimate: null,
      percent: 0,
      tps: null,
      ttft: null,
      duration: null,
      outputTokens: null,
      errorClassification: { kind: 'none', badgeText: '正常', title: '正常', detail: '', diagnostic: '' },
      groups: {
        user: { tokens: 0, chars: 0 },
        assistant: { tokens: 0, chars: 0 },
        thinking: { tokens: 0, chars: 0 },
        tools: { tokens: 0, chars: 0 },
        summaries: { tokens: 0, chars: 0 }
      },
      totalChars: 0,
      totalTokens: 0
    };
    renderConversationList();
    renderChatHeader();
    renderMessages();
    renderContextView();
    renderSidePanel();
    updateCliPreview();
    closeMobileDrawers();
    $('prompt-input')?.focus();
  }

  /** 切换当前选中的项目（切换工作区并刷新 Git / 文件面板） */
  async function selectProjectById(projId, startNew = false) {
    const proj = (state.projects || []).find((p) => p.id === projId);
    const fallbackConv = (state.conversations || []).find((c) => {
      const ws = c.workspacePath || c.workspace || '';
      return (c.projectId || (ws ? `ws:${ws}` : '__unassigned__')) === projId;
    });
    const nextWs = proj?.workspacePath || fallbackConv?.workspacePath || fallbackConv?.workspace || '';

    state.activeProjectId = projId;
    state.collapsedProjects[projId] = false;

    if (nextWs) {
      state.workspace = nextWs;
      localStorage.setItem('agy_workspace', nextWs);
      if ($('workspace-input')) $('workspace-input').value = nextWs;
      renderTopbarStatus();
      await loadWorkspaceOverview();
    }

    if (startNew) {
      startNewConversation();
      return;
    }

    renderConversationList();
    renderChatHeader();
    updateCliPreview();
  }

  /** 切换工作区目录并同步注册到项目列表与右侧 Git / 文件面板 */
  async function switchWorkspace() {
    const inputVal = ($('workspace-input')?.value || '').trim();
    if (!inputVal) {
      showToast('请输入有效的工作区目录路径', true);
      return;
    }
    try {
      const res = await apiFetch('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path: inputVal })
      });
      if (Array.isArray(res.projects)) state.projects = res.projects;
      if (res.project?.id) state.activeProjectId = res.project.id;
      state.workspace = res.project?.workspacePath || inputVal;
      if ($('workspace-input')) $('workspace-input').value = state.workspace;
    } catch {
      state.workspace = inputVal;
    }
    localStorage.setItem('agy_workspace', state.workspace);
    renderTopbarStatus();
    renderChatHeader();
    renderConversationList();
    updateCliPreview();
    await loadWorkspaceOverview();
    showToast(`已切换工作区：${state.workspace}`);
  }

  /** 打开服务器目录选择器弹窗 */
  function openDirPicker(mode = 'workspace', initialPath = state.workspace) {
    const modal = $('dir-picker-modal');
    if (!modal) return;
    state.dirPicker.mode = mode;
    const titleEl = $('dir-picker-title');
    if (titleEl) {
      titleEl.textContent = mode === 'project' ? '添加 / 切换项目目录' : '选择工作区目录';
    }
    const errEl = $('dir-picker-error');
    if (errEl) {
      errEl.hidden = true;
      errEl.textContent = '';
    }
    modal.hidden = false;
    browseDirPath(initialPath || '');
  }

  function closeDirPicker() {
    const modal = $('dir-picker-modal');
    if (modal) modal.hidden = true;
  }

  /** 浏览指定服务器目录（支持隐藏文件夹） */
  async function browseDirPath(dirPath = '') {
    const errEl = $('dir-picker-error');
    const listEl = $('dir-picker-list');
    const pathInput = $('dir-picker-path-input');
    const upBtn = $('btn-dir-picker-up');
    const parentHint = $('dir-picker-parent-hint');

    if (listEl) listEl.innerHTML = '<div class="empty-placeholder">正在读取目录...</div>';
    try {
      const qs = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
      const data = await apiFetch(`/api/fs/dirs${qs}`);
      state.dirPicker.currentPath = data.currentPath || dirPath;
      state.dirPicker.parentPath = data.parentPath || null;

      if (pathInput) pathInput.value = state.dirPicker.currentPath;
      if (upBtn) upBtn.disabled = !data.parentPath;
      if (parentHint) parentHint.textContent = data.parentPath || '根目录';
      if (errEl) {
        errEl.hidden = true;
        errEl.textContent = '';
      }

      const dirs = Array.isArray(data.dirs) ? data.dirs : [];
      if (!dirs.length) {
        if (listEl) listEl.innerHTML = '<div class="empty-placeholder">当前目录下无子文件夹</div>';
        return;
      }

      if (listEl) {
        listEl.innerHTML = dirs.map((d) => {
          const isHidden = String(d.name || '').startsWith('.');
          return `
            <button class="dir-picker-item${isHidden ? ' is-hidden-dir' : ''}" type="button" data-dir-path="${escapeHtml(d.path)}">
              <span>📁</span>
              <span class="dir-picker-name">${escapeHtml(d.name)}</span>
            </button>
          `;
        }).join('');
      }
    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || '目录读取失败';
      }
      if (listEl) listEl.innerHTML = '<div class="empty-placeholder">无法列出该目录</div>';
    }
  }

  /** 确认选择目录：仅在添加项目模式注册到 PROJECTS，工作区浏览模式只切换当前工作目录 */
  async function confirmDirPicker() {
    const rawPath = ($('dir-picker-path-input')?.value || '').trim() || state.dirPicker.currentPath;
    const errEl = $('dir-picker-error');
    if (!rawPath) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = '请输入或选择一个有效的目录路径';
      }
      return;
    }

    try {
      if (state.dirPicker.mode === 'project') {
        const res = await apiFetch('/api/projects', {
          method: 'POST',
          body: JSON.stringify({ path: rawPath })
        });
        if (Array.isArray(res.projects)) state.projects = res.projects;
        state.activeProjectId = res.project?.id || '';
        state.workspace = res.project?.workspacePath || rawPath;
        showToast(`已添加并切换至项目：${res.project?.name || getPathBasename(state.workspace)}`);
      } else {
        // 验证目录有效后仅切换当前工作区，避免把临时浏览目录自动加进项目列表
        const dirData = await apiFetch(`/api/fs/dirs?path=${encodeURIComponent(rawPath)}`);
        state.workspace = dirData.currentPath || rawPath;
        showToast(`已切换工作区：${state.workspace}`);
      }
      localStorage.setItem('agy_workspace', state.workspace);

      if ($('workspace-input')) $('workspace-input').value = state.workspace;
      closeDirPicker();
      renderTopbarStatus();
      renderChatHeader();
      renderConversationList();
      updateCliPreview();
      await loadWorkspaceOverview();
    } catch (err) {
      if (errEl) {
        errEl.hidden = false;
        errEl.textContent = err.message || '切换目录失败';
      }
    }
  }

  // --------------------------------------------------------------------------
  // 中央对话画布渲染、流式 SSE 消费与停止控制
  // --------------------------------------------------------------------------

  function renderChatHeader() {
    const titleEl = $('active-conv-title');
    if (titleEl) titleEl.textContent = state.activeConversationTitle || '新建远程会话';

    // 同步顶部面包屑的项目名
    const crumbEl = $('active-project-breadcrumb');
    if (crumbEl) {
      let projectName = state.activeConversationDetail?.projectName || '';
      if (!projectName && state.activeConversationId) {
        const matchedConv = (state.conversations || []).find((c) => c.id === state.activeConversationId);
        projectName = matchedConv?.projectName || getPathBasename(matchedConv?.workspacePath || matchedConv?.workspace);
      }
      if (!projectName && state.activeProjectId) {
        const matchedProj = (state.projects || []).find((p) => p.id === state.activeProjectId);
        projectName = matchedProj?.name || '';
      }
      if (!projectName && state.workspace) {
        const matchedByWs = (state.projects || []).find((p) => p.workspacePath === state.workspace);
        projectName = matchedByWs?.name || getPathBasename(state.workspace);
      }
      crumbEl.textContent = projectName || '未选择项目';
      crumbEl.title = state.workspace ? `当前工作区: ${state.workspace}` : (projectName || '点击选择项目目录');
      if ($('composer-project-name')) $('composer-project-name').textContent = projectName || 'antigravity-project';
    }

    if ($('composer-branch-name') && state.workspaceOverview?.branch) {
      $('composer-branch-name').textContent = state.workspaceOverview.branch;
    }

    const badge = $('bound-conv-badge');
    const idCode = $('bound-conv-id');
    if (badge && idCode) {
      badge.hidden = !state.activeConversationId;
      idCode.textContent = state.activeConversationId ? state.activeConversationId.slice(0, 12) : '';
      badge.title = state.activeConversationId ? `续聊绑定 ID: ${state.activeConversationId}` : '';
    }
  }

  /** 全量重绘消息列表（加载历史或新建会话时使用） */
  function renderMessages() {
    const listEl = $('message-list');
    const welcome = $('welcome-view');
    if (!listEl) return;

    // 清除非欢迎页节点
    Array.from(listEl.children).forEach((child) => {
      if (child.id !== 'welcome-view') child.remove();
    });

    if (!state.messages.length) {
      if (welcome) welcome.hidden = false;
      return;
    }

    if (welcome) welcome.hidden = true;
    state.messages.forEach((msg) => {
      listEl.appendChild(createMessageElement(msg));
    });
    scrollMessagesToBottom();
  }

  /** 构建单条消息 DOM 节点 */
  function createMessageElement(msg) {
    const row = document.createElement('div');
    row.className = `msg-row is-${msg.role}`;
    row.dataset.msgId = msg.id;

    const roleNames = {
      user: '你',
      assistant: 'Antigravity',
      error: '请求错误',
      system: '上下文检查点摘要'
    };
    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role-label';
    roleLabel.textContent = roleNames[msg.role] || 'Antigravity';
    if (msg.timestamp) {
      const tsSpan = document.createElement('span');
      tsSpan.textContent = formatTimeShort(msg.timestamp);
      roleLabel.appendChild(tsSpan);
    }

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (msg.role === 'user') {
      const contentDiv = document.createElement('div');
      contentDiv.className = 'md-body';
      contentDiv.innerHTML = renderMarkdown(msg.text || '');
      bubble.appendChild(contentDiv);
      renderMessageAttachmentsDom(bubble, msg);
    } else if (msg.role === 'error') {
      const errDiv = document.createElement('div');
      errDiv.className = 'md-body';
      errDiv.innerHTML = renderMarkdown(msg.text || '请求返回错误');
      bubble.appendChild(errDiv);
    } else if (msg.role === 'system') {
      const sysDetails = document.createElement('details');
      sysDetails.className = 'thinking-card';
      sysDetails.innerHTML = `<summary><span>历史压缩摘要 (Checkpoint)</span><span class="card-sub tabular-nums">${(msg.text || '').length} 字</span></summary><div class="thinking-body">${escapeHtml(msg.text || '')}</div>`;
      bubble.appendChild(sysDetails);
    } else {
      updateAssistantBubbleDom(bubble, msg);
    }

    row.appendChild(roleLabel);
    row.appendChild(bubble);
    return row;
  }

  /** 为气泡渲染媒体附件网格（聚合 msg.attachments 与 msg.media，支持点击大图预览） */
  function renderMessageAttachmentsDom(bubble, msg) {
    const mediaItems = [];
    if (Array.isArray(msg.attachments)) mediaItems.push(...msg.attachments);
    if (Array.isArray(msg.media)) mediaItems.push(...msg.media);
    if (!mediaItems.length) return;

    const attWrap = document.createElement('div');
    attWrap.className = 'msg-attachments';
    mediaItems.forEach((att) => {
      const rawUrl = att.url || att.path || att.uri || '';
      const srcUrl = resolveMarkdownImageSrc(rawUrl);
      const isImg = /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:\?.*)?$/i.test(rawUrl) || /^image\//i.test(att.mime || '');
      const card = document.createElement('div');
      card.className = 'msg-thumb-card';
      if (srcUrl && isImg) {
        card.dataset.lightboxSrc = srcUrl;
        card.dataset.lightboxCaption = `${att.name || '图片'}${att.dimensions ? ' (' + att.dimensions + ')' : ''}`;
      }
      const thumbVisual = (srcUrl && isImg)
        ? `<img src="${escapeHtml(srcUrl)}" alt="${escapeHtml(att.name || '图片')}" loading="lazy" />`
        : `<div class="msg-thumb-placeholder" title="${escapeHtml(rawUrl)}">📎</div>`;
      const dimText = att.dimensions ? ` · ${att.dimensions}` : '';
      card.innerHTML = `${thumbVisual}<div class="msg-thumb-meta">${escapeHtml(att.name || '附件')}${escapeHtml(dimText)}</div>`;
      attWrap.appendChild(card);
    });
    bubble.appendChild(attWrap);
  }

  /** 原地更新助手消息卡片（思考折叠区、工具调用卡片、Markdown 正文、媒体卡片、指标条） */
  function updateAssistantBubbleDom(bubble, msg) {
    bubble.innerHTML = '';

    // 1. 可折叠「思考过程 (Thinking)」卡片
    if (msg.thinking) {
      const details = document.createElement('details');
      details.className = 'thinking-card';
      if (state.streaming.active && state.streaming.assistantMsgId === msg.id && !msg.text) {
        details.open = true;
      }
      const summary = document.createElement('summary');
      summary.innerHTML = `<span>思考过程 (Thinking)</span><span class="card-sub tabular-nums">${msg.thinking.length} 字</span>`;
      const body = document.createElement('div');
      body.className = 'thinking-body';
      body.textContent = msg.thinking;
      details.appendChild(summary);
      details.appendChild(body);
      bubble.appendChild(details);
    }

    // 2. 「工具调用 (Tool Calls)」状态卡片
    if (msg.toolCalls && msg.toolCalls.length) {
      const wrap = document.createElement('div');
      wrap.className = 'tool-calls-wrap';
      msg.toolCalls.forEach((tc) => {
        const card = document.createElement('div');
        card.className = 'tool-card';
        const statusCls = tc.status === 'running' ? 'is-running' : (tc.status === 'error' ? 'is-error' : 'is-done');
        const statusLabel = tc.status === 'running' ? '执行中' : (tc.status === 'error' ? '失败' : '完成');
        const detailStr = [
          tc.input ? `参数: ${typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)}` : '',
          tc.output ? `输出: ${typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output)}` : ''
        ].filter(Boolean).join('\n');

        card.innerHTML = `
          <div class="tool-card-head">
            <span class="tool-name">${escapeHtml(tc.name || 'tool')}</span>
            <span class="tool-status ${statusCls}">${statusLabel}</span>
          </div>
          ${detailStr ? `<div class="tool-detail">${escapeHtml(detailStr)}</div>` : ''}
        `;
        wrap.appendChild(card);
      });
      bubble.appendChild(wrap);
    }

    // 3. Markdown 正文
    const mdDiv = document.createElement('div');
    mdDiv.className = 'md-body';
    if (msg.text) {
      mdDiv.innerHTML = renderMarkdown(msg.text);
    } else if (state.streaming.active && state.streaming.assistantMsgId === msg.id) {
      mdDiv.innerHTML = '<span class="card-sub">正在等待模型响应流…</span>';
    }
    bubble.appendChild(mdDiv);

    // 3.5 助手生成的落盘媒体 / 附件展示
    renderMessageAttachmentsDom(bubble, msg);

    // 4. 底部实时耗时 / TTFT / TPS 指标条
    if (msg.metrics) {
      const m = msg.metrics;
      const parts = [];
      if (m.duration != null) parts.push(`耗时 ${Number(m.duration).toFixed(2)}s`);
      if (m.ttft != null) parts.push(`首字 ${Number(m.ttft).toFixed(2)}s`);
      if (m.tps != null) parts.push(`速度 ${m.tps} tok/s`);
      if (m.outputTokens != null) parts.push(`输出 ${Number(m.outputTokens).toLocaleString('en-US')} tok`);
      if (parts.length) {
        const bar = document.createElement('div');
        bar.className = 'msg-metrics-bar tabular-nums';
        bar.textContent = parts.join(' · ');
        bubble.appendChild(bar);
      }
    }
  }

  function scrollMessagesToBottom() {
    const listEl = $('message-list');
    if (!listEl) return;
    listEl.scrollTop = listEl.scrollHeight;
  }

  function setStreamingUiState(isActive) {
    state.streaming.active = isActive;
    const live = $('chat-live-indicator');
    const stopBtn = $('btn-stop-stream');
    const sendBtn = $('btn-send-prompt');
    if (live) live.hidden = !isActive;
    if (stopBtn) stopBtn.hidden = !isActive;
    if (sendBtn) sendBtn.disabled = isActive;
  }

  /** 发送提示词并启动 SSE 流式消费 */
  async function handleSendPrompt() {
    if (state.streaming.active) return;
    const input = $('prompt-input');
    const promptText = (input?.value || '').trim();
    if (!promptText && !state.pendingAttachments.length) {
      showToast('请输入内容或上传截图后再发送', true);
      return;
    }

    const attachmentsToSend = state.pendingAttachments.slice();
    const model = $('select-model')?.value || '';
    const effort = $('select-effort')?.value ?? '';
    const mode = $('select-mode')?.value || 'auto';
    const skipPermissions = Boolean($('chk-skip-permissions')?.checked);

    localStorage.setItem('agy_model', model);

    // 1. 乐观插入用户消息和助手流式占位卡片
    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: promptText || '（请查看附件图片）',
      attachments: attachmentsToSend,
      timestamp: new Date().toISOString()
    };
    const assistantMsg = {
      id: `a-${Date.now() + 1}`,
      role: 'assistant',
      text: '',
      thinking: '',
      toolCalls: [],
      metrics: null,
      timestamp: new Date().toISOString()
    };

    state.messages.push(userMsg, assistantMsg);
    state.sessionSentAttachments.push(...attachmentsToSend);
    state.pendingAttachments = [];
    renderAttachmentPreviews();

    if (input) {
      input.value = '';
      autoResizeTextarea(input);
    }

    const welcome = $('welcome-view');
    if (welcome) welcome.hidden = true;
    const listEl = $('message-list');
    listEl.appendChild(createMessageElement(userMsg));
    const assistantRow = createMessageElement(assistantMsg);
    listEl.appendChild(assistantRow);
    scrollMessagesToBottom();

    const abortController = new AbortController();
    state.streaming.abortController = abortController;
    state.streaming.assistantMsgId = assistantMsg.id;
    state.streaming.runId = `run-${Date.now()}`;
    setStreamingUiState(true);
    renderContextView();
    renderSidePanel();
    updateCliPreview();

    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: abortController.signal,
        body: JSON.stringify({
          runId: state.streaming.runId,
          prompt: promptText,
          attachments: attachmentsToSend,
          conversationId: state.activeConversationId,
          workspace: state.workspace,
          model,
          effort,
          mode,
          skipPermissions
        })
      });

      if (res.status === 401) {
        state.authRequired = true;
        state.authenticated = false;
        openAuthModal();
        throw new Error('登录状态失效，请重新验证密码');
      }
      if (!res.ok || !res.body) {
        const errBody = await res.text();
        throw new Error(errBody || `流式请求失败 (${res.status})`);
      }

      await consumeSseStream(res.body, assistantMsg, assistantRow.querySelector('.msg-bubble'));
    } catch (err) {
      if (err.name === 'AbortError') {
        assistantMsg.text += (assistantMsg.text ? '\n\n' : '') + '> [已由用户停止生成]';
      } else {
        assistantMsg.text += (assistantMsg.text ? '\n\n' : '') + `> **请求异常**：${err.message}`;
        showToast(err.message, true);
      }
      updateAssistantBubbleDom(assistantRow.querySelector('.msg-bubble'), assistantMsg);
    } finally {
      state.streaming.abortController = null;
      state.streaming.runId = null;
      state.streaming.assistantMsgId = null;
      setStreamingUiState(false);
      renderContextView();
      refreshConversations();
      loadWorkspaceOverview();
    }
  }

  /** 使用 ReadableStream 解析 SSE `event:` 与 `data:` 帧 */
  async function consumeSseStream(readableStream, assistantMsg, bubbleEl) {
    const reader = readableStream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let rafPending = false;

    const scheduleRender = () => {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        updateAssistantBubbleDom(bubbleEl, assistantMsg);
        scrollMessagesToBottom();
      });
    };

    const dispatchFrame = (rawFrame) => {
      if (!rawFrame.trim()) return;
      let eventType = 'message';
      const dataLines = [];

      rawFrame.split(/\r?\n/).forEach((line) => {
        if (line.startsWith('event:')) {
          eventType = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      });

      if (!dataLines.length) return;
      const rawData = dataLines.join('\n');
      let payload;
      try {
        payload = JSON.parse(rawData);
      } catch {
        payload = { text: rawData };
      }
      handleSseEvent(eventType, payload, assistantMsg);
      scheduleRender();
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() || '';
      frames.forEach(dispatchFrame);
    }
    if (buffer.trim()) dispatchFrame(buffer);

    updateAssistantBubbleDom(bubbleEl, assistantMsg);
    scrollMessagesToBottom();
  }

  /** 处理单个 SSE 事件并同步更新消息和顶栏胶囊指标 */
  function handleSseEvent(eventType, payload, assistantMsg) {
    const type = payload.type || eventType;

    if (type === 'status') {
      if (payload.runId) state.streaming.runId = payload.runId;
      if (payload.conversationId) {
        state.activeConversationId = payload.conversationId;
        renderChatHeader();
        updateCliPreview();
      }
      return;
    }

    if (type === 'thinking') {
      const delta = payload.delta ?? payload.text ?? payload.thinking ?? payload.content ?? '';
      assistantMsg.thinking += delta;
      return;
    }

    if (type === 'tool_call') {
      const tc = payload.toolCall || payload.tool_call || payload;
      const name = tc.name || tc.toolName || 'tool';
      const nextStatus = tc.isError ? 'error' : (tc.status || 'running');
      const existing = tc.id ? assistantMsg.toolCalls.find((item) => item.id === tc.id) : null;
      if (existing) {
        existing.status = nextStatus || existing.status;
        if (tc.output || tc.result) existing.output = tc.output || tc.result;
      } else {
        assistantMsg.toolCalls.push({
          id: tc.id || `tc-${assistantMsg.toolCalls.length + 1}`,
          name,
          status: nextStatus,
          input: tc.input || tc.args || '',
          output: tc.output || tc.result || ''
        });
      }
      return;
    }

    if (type === 'text' || type === 'message') {
      const delta = payload.delta ?? payload.text ?? payload.content ?? '';
      assistantMsg.text += delta;
      return;
    }

    if (type === 'usage') {
      const u = payload.usage || payload;
      const tps = payload.tps ?? u.tps ?? state.contextMetrics.tps;
      const ttft = payload.ttft ?? u.ttft ?? state.contextMetrics.ttft;
      const duration = payload.duration ?? u.duration ?? state.contextMetrics.duration;
      const outputTokens = u.outputTokens ?? u.output ?? payload.outputTokens ?? state.contextMetrics.outputTokens;
      const totalUsed = u.totalTokens ?? u.actual ?? ((u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.outputTokens || 0));

      assistantMsg.metrics = { tps, ttft, duration, outputTokens };
      if (tps != null) state.contextMetrics.tps = tps;
      if (ttft != null) state.contextMetrics.ttft = ttft;
      if (duration != null) state.contextMetrics.duration = duration;
      if (outputTokens != null) state.contextMetrics.outputTokens = outputTokens;
      if (totalUsed > 0) {
        state.contextMetrics.actual = totalUsed;
        state.contextMetrics.used = totalUsed;
        state.contextMetrics.percent = (totalUsed / (state.contextMetrics.budget || DEFAULT_BUDGET)) * 100;
      }
      renderContextView();
      return;
    }

    if (type === 'error') {
      const cls = payload.classification || payload.errorClassification || {
        kind: payload.kind || 'unknown',
        badgeText: ERROR_KIND_META[payload.kind]?.label || '异常',
        title: ERROR_KIND_META[payload.kind]?.title || '请求异常',
        detail: payload.message || payload.error || '执行出错',
        diagnostic: payload.diagnostic || ''
      };
      state.contextMetrics.errorClassification = cls;
      assistantMsg.text += (assistantMsg.text ? '\n\n' : '') + `> **错误 (${cls.title || cls.badgeText})**：${cls.detail || payload.message || ''}`;
      renderContextView();
      return;
    }

    if (type === 'done') {
      if (payload.conversationId) {
        state.activeConversationId = payload.conversationId;
        renderChatHeader();
        updateCliPreview();
        apiFetch(`/api/conversations/${encodeURIComponent(payload.conversationId)}`)
          .then((res) => {
            const conv = res?.conversation || res;
            if (conv && state.activeConversationId === (conv.id || payload.conversationId)) {
              syncContextMetricsFromConversation(conv);
              renderContextView();
            }
          })
          .catch(() => {});
      }
      const u = payload.usage || {};
      const outTok = payload.outputTokens ?? u.outputTokens ?? u.output ?? assistantMsg.metrics?.outputTokens ?? state.contextMetrics.outputTokens;
      const totalUsed = u.totalTokens ?? u.actual ?? ((u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.outputTokens || 0));

      assistantMsg.metrics = {
        tps: payload.tps ?? assistantMsg.metrics?.tps ?? state.contextMetrics.tps,
        ttft: payload.ttft ?? assistantMsg.metrics?.ttft ?? state.contextMetrics.ttft,
        duration: payload.duration ?? assistantMsg.metrics?.duration ?? state.contextMetrics.duration,
        outputTokens: outTok
      };
      // 将运行中的工具卡片全部标为完成
      assistantMsg.toolCalls.forEach((tc) => {
        if (tc.status === 'running') tc.status = 'done';
      });
      if (assistantMsg.metrics.tps != null) state.contextMetrics.tps = assistantMsg.metrics.tps;
      if (assistantMsg.metrics.ttft != null) state.contextMetrics.ttft = assistantMsg.metrics.ttft;
      if (assistantMsg.metrics.duration != null) state.contextMetrics.duration = assistantMsg.metrics.duration;
      if (outTok != null) state.contextMetrics.outputTokens = outTok;
      if (totalUsed > 0) {
        state.contextMetrics.actual = totalUsed;
        state.contextMetrics.used = totalUsed;
        state.contextMetrics.percent = (totalUsed / (state.contextMetrics.budget || DEFAULT_BUDGET)) * 100;
      }
      renderContextView();
    }
  }

  /** 主动终止当前 SSE 流及后端子进程 */
  async function stopActiveStream() {
    if (!state.streaming.active) return;
    const runId = state.streaming.runId;
    if (state.streaming.abortController) {
      state.streaming.abortController.abort();
    }
    if (runId) {
      try {
        await apiFetch('/api/chat/stop', {
          method: 'POST',
          body: JSON.stringify({ runId })
        });
      } catch {
        // 停止接口容错
      }
    }
  }

  // --------------------------------------------------------------------------
  // 图片粘贴 / 拖拽 / 选图上传与预览卡片
  // --------------------------------------------------------------------------

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const commaIdx = result.indexOf(',');
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = () => reject(new Error('读取图片文件失败'));
      reader.readAsDataURL(file);
    });
  }

  async function uploadImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      showToast('仅支持上传图片格式文件', true);
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: JSON.stringify({
          name: file.name || `screenshot-${Date.now()}.png`,
          mime: file.type,
          dataBase64,
          workspace: state.workspace
        })
      });
      const uploaded = res.file || res;
      state.pendingAttachments.push(uploaded);
      renderAttachmentPreviews();
      renderMediaAuditTable();
      updateCliPreview();
      showToast(`已上传图片 ${uploaded.name} (${uploaded.dimensions || '未知尺寸'})`);
    } catch (err) {
      showToast(`图片上传失败：${err.message}`, true);
    }
  }

  function renderAttachmentPreviews() {
    const wrap = $('attachment-previews');
    if (!wrap) return;
    if (!state.pendingAttachments.length) {
      wrap.hidden = true;
      wrap.innerHTML = '';
      return;
    }
    wrap.hidden = false;
    wrap.innerHTML = state.pendingAttachments.map((att, idx) => `
      <div class="attach-card">
        <img src="${escapeHtml(att.url || '')}" alt="${escapeHtml(att.name || '图片')}" data-lightbox-src="${escapeHtml(att.url || '')}" data-lightbox-caption="${escapeHtml(`${att.name} (${att.dimensions || ''})`)}"/>
        <div class="attach-info">
          <div class="attach-name" title="${escapeHtml(att.name || '')}">${escapeHtml(att.name || '图片')}</div>
          <div class="attach-sub tabular-nums">${escapeHtml(att.dimensions || '—')} · ≈${att.tokens ?? '?'} tok</div>
        </div>
        <button class="attach-remove" type="button" data-remove-attach="${idx}" title="移除此附件">×</button>
      </div>
    `).join('');
  }

  // --------------------------------------------------------------------------
  // 右侧辅助面板：Git Diff、工作区文件与等效 CLI 预览
  // --------------------------------------------------------------------------

  async function loadWorkspaceOverview() {
    try {
      const qs = state.workspace ? `?path=${encodeURIComponent(state.workspace)}` : '';
      const data = await apiFetch(`/api/workspace/overview${qs}`);
      state.workspaceOverview = data;
      renderGitOverview(data);
      renderWorkspaceFiles(data);
    } catch (err) {
      $('git-status-list').innerHTML = `<div class="empty-placeholder">${escapeHtml(err.message)}</div>`;
    }
  }

  function renderGitOverview(data) {
    if (!data) return;
    const notGit = data.isGit === false || data.isGitRepo === false;
    const branchName = data.branch || (notGit ? '非 Git 仓库' : 'HEAD');
    $('git-branch-name').textContent = branchName;
    if ($('composer-branch-name')) $('composer-branch-name').textContent = branchName;

    const statusList = $('git-status-list');
    let changes = [];
    if (Array.isArray(data.status)) {
      changes = data.status.map((s) => ({ status: s.code || s.status || 'M', path: s.path }));
    } else if (Array.isArray(data.changes)) {
      changes = data.changes;
    } else {
      changes = parseGitPorcelain(data.statusRaw || data.statusText || data.porcelain || '');
    }

    const gitCountEl = $('side-git-count');
    if (gitCountEl) gitCountEl.textContent = changes.length;

    if (!changes.length) {
      const msg = data.exists === false ? (data.error || '工作区目录不存在') : (notGit ? '当前目录未初始化 Git 仓库' : '工作区干净，暂无未提交改动');
      statusList.innerHTML = `<div class="empty-placeholder">${escapeHtml(msg)}</div>`;
    } else {
      statusList.innerHTML = changes.map((c) => `
        <div class="git-file-row">
          <span title="${escapeHtml(c.path)}">${escapeHtml(c.path)}</span>
          <span class="git-flag">${escapeHtml(c.status)}</span>
        </div>
      `).join('');
    }

    const diffEl = $('git-diff-view');
    const diffRaw = data.diff || '';
    if (!diffRaw.trim()) {
      diffEl.innerHTML = '<code>暂无未提交差异</code>';
    } else {
      diffEl.innerHTML = diffRaw.split(/\r?\n/).map((line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-line-add">${escapeHtml(line)}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-line-del">${escapeHtml(line)}</span>`;
        if (line.startsWith('@@') || line.startsWith('diff ')) return `<span class="diff-line-hunk">${escapeHtml(line)}</span>`;
        return escapeHtml(line);
      }).join('\n');
    }
  }

  function parseGitPorcelain(text) {
    return String(text || '')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => ({
        status: line.slice(0, 2).trim() || 'M',
        path: line.slice(3).trim()
      }));
  }

  function renderWorkspaceFiles(data) {
    const listEl = $('workspace-files-list');
    const files = Array.isArray(data?.files) ? data.files : [];
    if (!files.length) {
      listEl.innerHTML = '<div class="empty-placeholder">工作区暂无可展示文件</div>';
      return;
    }

    listEl.innerHTML = files.map((f) => {
      const name = typeof f === 'string' ? f : (f.name || f.path);
      const isDir = typeof f === 'object' && (f.isDir || f.type === 'dir');
      return `
        <button class="ws-file-row" type="button" data-insert-file="${escapeHtml(name)}">
          <span>${isDir ? '📁' : '📄'} ${escapeHtml(name)}</span>
          <span class="card-sub">${isDir ? '目录' : (f.size ? formatBytes(f.size) : '引用')}</span>
        </button>
      `;
    }).join('');
  }

  /**
   * 渲染官方原版风格右侧 Side Panel（Subagents、Files Changed、Artifacts、Uploads、Tasks）
   */
  function renderSidePanel() {
    const conv = state.activeConversationDetail;
    const side = conv?.sidePanel || {
      subagents: [],
      artifacts: [],
      uploads: [],
      filesChanged: [],
      backgroundTasks: []
    };

    // 1. Subagents
    const subagentsCountEl = $('side-subagents-count');
    const subagentsBodyEl = $('side-subagents-body');
    if (subagentsCountEl) subagentsCountEl.textContent = side.subagents.length;
    if (subagentsBodyEl) {
      if (!side.subagents.length) {
        subagentsBodyEl.innerHTML = `<div class="side-sec-empty">当前会话暂无子智能体运行</div>`;
      } else {
        subagentsBodyEl.innerHTML = side.subagents.map((s) => `
          <div class="subagent-item">
            <div class="subagent-info">
              <span class="subagent-role" title="${escapeHtml(s.role)}">${escapeHtml(s.role)}</span>
              <span class="subagent-meta">${escapeHtml(s.durationText || 'Worked for 1m')}</span>
            </div>
            <span class="subagent-check-icon" title="已完成">
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="8" cy="8" r="6.5"/>
                <path d="M5.5 8l2 2 3.5-3.5"/>
              </svg>
            </span>
          </div>
        `).join('');
      }
    }

    // 2. Files Changed
    const filesCountEl = $('side-files-count');
    const filesBodyEl = $('side-files-body');
    if (filesCountEl) filesCountEl.textContent = side.filesChanged.length;
    if (filesBodyEl) {
      if (!side.filesChanged.length) {
        filesBodyEl.innerHTML = `<div class="side-sec-empty">暂无变动文件</div>`;
      } else {
        filesBodyEl.innerHTML = side.filesChanged.map((f) => `
          <div class="side-mini-row" title="${escapeHtml(f.path)}">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M3.5 2h6l3.5 3.5V14H3.5z"/><path d="M9.5 2v4h4"/>
            </svg>
            <span>${escapeHtml(f.name || f.path)}</span>
          </div>
        `).join('');
      }
    }

    // 3. Artifacts（产物图片与文件）
    const artifactsCountEl = $('side-artifacts-count');
    const artifactsBodyEl = $('side-artifacts-body');
    if (artifactsCountEl) artifactsCountEl.textContent = side.artifacts.length;
    if (artifactsBodyEl) {
      if (!side.artifacts.length) {
        artifactsBodyEl.innerHTML = `<div class="side-sec-empty">当前会话暂无生成产物</div>`;
      } else {
        artifactsBodyEl.innerHTML = side.artifacts.map((a) => `
          <a class="artifact-item" href="${a.url}" target="_blank" data-preview-img="${a.url}" data-title="${escapeHtml(a.title)}">
            <span class="artifact-icon">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="12" height="12" rx="2"/>
                <circle cx="5.5" cy="5.5" r="1.2"/>
                <path d="M14 10l-4-3-6 5"/>
              </svg>
            </span>
            <span class="artifact-title" title="${escapeHtml(a.title)}">${escapeHtml(a.title)}</span>
          </a>
        `).join('');
      }
    }

    // 4. Uploads
    const uploadsCountEl = $('side-uploads-count');
    const uploadsBodyEl = $('side-uploads-body');
    if (uploadsCountEl) uploadsCountEl.textContent = side.uploads.length;
    if (uploadsBodyEl) {
      if (!side.uploads.length) {
        uploadsBodyEl.innerHTML = `<div class="side-sec-empty">暂无上传文件</div>`;
      } else {
        uploadsBodyEl.innerHTML = side.uploads.map((u) => `
          <a class="artifact-item" href="${u.url}" target="_blank" data-preview-img="${u.url}">
            <span class="artifact-icon">
              <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M8 2v9M4 6l4-4 4 4M2 13h12"/>
              </svg>
            </span>
            <span class="artifact-title" title="${escapeHtml(u.name)}">${escapeHtml(u.name)}</span>
          </a>
        `).join('');
      }
    }

    // 5. Background Tasks
    const tasksCountEl = $('side-tasks-count');
    const tasksBodyEl = $('side-tasks-body');
    if (tasksCountEl) tasksCountEl.textContent = side.backgroundTasks.length;
    if (tasksBodyEl) {
      if (!side.backgroundTasks.length) {
        tasksBodyEl.innerHTML = `<div class="side-sec-empty">暂无后台任务</div>`;
      } else {
        tasksBodyEl.innerHTML = side.backgroundTasks.map((t) => `
          <div class="side-mini-row">
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>
            </svg>
            <span>${escapeHtml(t.name)}</span>
          </div>
        `).join('');
      }
    }

    // 点击产物直接打开图片灯箱预览
    artifactsBodyEl?.querySelectorAll('[data-preview-img]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.dataset.previewImg;
        const title = el.dataset.title || '产物预览';
        openLightbox(url, title);
      });
    });
    uploadsBodyEl?.querySelectorAll('[data-preview-img]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const url = el.dataset.previewImg;
        openLightbox(url, '上传素材预览');
      });
    });
  }

  /** 提取文件所在父目录（兼容 POSIX 与 Windows 分隔符，匹配后端 path.dirname） */
  function extractParentDir(filePath) {
    const raw = String(filePath || '').trim();
    if (!raw) return '';
    const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
    return idx > 0 ? raw.slice(0, idx) : '';
  }

  /** 实时拼装等效 agy CLI 命令预览（与后端 streamAgyTurn / buildAgyArgs 实际参数一致） */
  function updateCliPreview() {
    const el = $('cli-command-preview');
    if (!el) return;

    const quoteArg = (v) => `'${String(v || '').replace(/'/g, `'\\''`)}'`;
    const promptVal = ($('prompt-input')?.value || '').trim();
    const model = $('select-model')?.value || '';
    const effort = $('select-effort')?.value || '';
    const mode = $('select-mode')?.value || '';
    const skipPerm = Boolean($('chk-skip-permissions')?.checked);

    // 1. 与后端 buildAgyArgs 一致：若有已上传附件，将路径提示前置到 -p 内容并收集 --add-dir
    const prefixLines = [];
    const addDirs = new Set();
    state.pendingAttachments.forEach((att) => {
      if (!att || !att.path) return;
      const dimText = (att.width && att.height)
        ? `${att.width}×${att.height}`
        : (att.dimensions ? String(att.dimensions) : '');
      const dimPart = dimText ? ` (${dimText})` : '';
      prefixLines.push(`[附件图片: ${att.path}${dimPart} - 请调用 read_file 查看该文件]`);
      const parentDir = extractParentDir(att.path);
      if (parentDir) addDirs.add(parentDir);
    });

    const displayPrompt = promptVal || '<你的提示词>';
    const finalPrompt = prefixLines.length
      ? `${prefixLines.join('\n')}\n\n${displayPrompt}`
      : displayPrompt;

    // 2. 后端以 workspace 作为子进程 cwd 执行，不传 --project
    const parts = [state.workspace ? `cd ${quoteArg(state.workspace)} && agy` : 'agy'];
    parts.push(`-p ${quoteArg(finalPrompt)}`);
    parts.push('--output-format stream-json');
    if (state.activeConversationId) {
      parts.push(`--conversation ${quoteArg(state.activeConversationId)}`);
    }
    if (model) parts.push(`--model ${quoteArg(model)}`);
    if (effort) parts.push(`--effort ${quoteArg(effort)}`);
    if (mode) parts.push(`--mode ${quoteArg(mode)}`);
    if (skipPerm) parts.push('--dangerously-skip-permissions');
    addDirs.forEach((dir) => {
      parts.push(`--add-dir ${quoteArg(dir)}`);
    });

    el.innerHTML = `<code>${escapeHtml(parts.join(' \\\n  '))}</code>`;
  }

  // --------------------------------------------------------------------------
  // 浮层与事件绑定初始化
  // --------------------------------------------------------------------------

  function togglePopover(panelId, triggerId) {
    const target = $(panelId);
    const otherId = panelId === 'panel-context' ? 'panel-history' : 'panel-context';
    const otherTriggerId = triggerId === 'capsule-context' ? 'capsule-history' : 'capsule-context';
    const other = $(otherId);

    if (other && !other.hidden) {
      other.hidden = true;
      $(otherTriggerId)?.setAttribute('aria-expanded', 'false');
      if (otherId === 'panel-context') $('btn-open-settings')?.setAttribute('aria-expanded', 'false');
    }

    if (!target) return;
    const willOpen = target.hidden;
    target.hidden = !willOpen;
    $(triggerId)?.setAttribute('aria-expanded', String(willOpen));
    if (panelId === 'panel-context' && !willOpen) {
      $('btn-open-settings')?.setAttribute('aria-expanded', 'false');
    }

    if (willOpen && panelId === 'panel-context') {
      switchContextTab(state.activeCtxTab || 'current');
    } else if (willOpen && panelId === 'panel-history') {
      loadTokenHistory(state.historySource);
      switchHistoryTab(state.activeHistTab || 'heatmap');
    }
  }

  function autoResizeTextarea(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(200, Math.max(44, el.scrollHeight))}px`;
  }

  function bindGlobalEvents() {
    applyTheme(state.theme);
    applyAuxCollapsed(state.auxCollapsed);

    // 主题与面板开关
    $('btn-theme-toggle')?.addEventListener('click', () => {
      applyTheme(state.theme === 'dark' ? 'light' : 'dark');
    });
    $('btn-toggle-aux')?.addEventListener('click', () => {
      applyAuxCollapsed(!state.auxCollapsed);
    });

    // 移动端抽屉控制
    $('btn-toggle-left-drawer')?.addEventListener('click', () => openMobileDrawer('left'));
    $('btn-mobile-right-drawer')?.addEventListener('click', () => openMobileDrawer('right'));
    $('mobile-backdrop')?.addEventListener('click', closeMobileDrawers);

    // 顶栏双胶囊与配置快捷入口
    $('capsule-context')?.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover('panel-context', 'capsule-context');
    });
    $('btn-open-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openSettingsTab();
    });
    $('capsule-history')?.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover('panel-history', 'capsule-history');
    });
    $('btn-close-context-panel')?.addEventListener('click', () => {
      $('panel-context').hidden = true;
      $('capsule-context')?.setAttribute('aria-expanded', 'false');
      $('btn-open-settings')?.setAttribute('aria-expanded', 'false');
    });
    $('btn-close-history-panel')?.addEventListener('click', () => {
      $('panel-history').hidden = true;
      $('capsule-history')?.setAttribute('aria-expanded', 'false');
    });
    $('btn-refresh-context-panel')?.addEventListener('click', () => {
      if (state.activeCtxTab === 'models') {
        loadModelCtxSettings();
      } else if (state.activeCtxTab === 'speed') {
        loadTokenHistory(state.historySource);
      } else if (state.activeCtxTab === 'config') {
        loadAccountsSettings();
        loadProxySettings();
      } else {
        loadUnlockStatus();
        if (state.activeConversationId) selectConversation(state.activeConversationId);
      }
    });
    $('btn-unlock-refresh')?.addEventListener('click', loadUnlockStatus);

    // 上下文面板 4 Tab 切换及子交互
    $('ctx-panel-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ctx-tab]');
      if (btn) switchContextTab(btn.dataset.ctxTab);
    });
    $('btn-refresh-model-ctx')?.addEventListener('click', loadModelCtxSettings);
    $('btn-save-all-model-ctx')?.addEventListener('click', saveAllModelCtxOverrides);
    $('model-ctx-list')?.addEventListener('click', (e) => {
      const presetBtn = e.target.closest('[data-model-preset-id]');
      if (presetBtn) {
        const modelId = presetBtn.dataset.modelPresetId;
        const val = Number(presetBtn.dataset.presetTokens);
        const row = presetBtn.closest('.model-ctx-row');
        const input = row?.querySelector('[data-model-ctx-input]');
        if (input && Number.isFinite(val)) input.value = String(val);
        row?.querySelectorAll('.preset-chip-btn').forEach((b) => {
          b.classList.toggle('is-active', b === presetBtn);
        });
        return;
      }
      const saveBtn = e.target.closest('[data-save-model-ctx]');
      if (saveBtn) {
        const modelId = saveBtn.dataset.saveModelCtx;
        const row = saveBtn.closest('.model-ctx-row');
        const input = row?.querySelector('[data-model-ctx-input]');
        saveModelCtxEntry(modelId, Math.round(Number(input?.value || 0)));
        return;
      }
      const resetBtn = e.target.closest('[data-reset-model-ctx]');
      if (resetBtn) {
        saveModelCtxEntry(resetBtn.dataset.resetModelCtx, null);
      }
    });

    // Context Tab 3：速度对比筛选与趋势切换
    $('speed-range-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-speed-range]');
      if (!btn) return;
      state.ctxSpeedRange = btn.dataset.speedRange;
      document.querySelectorAll('#speed-range-tabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderSpeedComparisonTab();
    });
    $('speed-source-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-speed-source]');
      if (!btn) return;
      state.ctxSpeedSource = btn.dataset.speedSource;
      document.querySelectorAll('#speed-source-tabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderSpeedComparisonTab();
    });
    $('ctx-speed-metric-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-ctx-speed-metric]');
      if (!btn) return;
      state.ctxSpeedMetric = btn.dataset.ctxSpeedMetric;
      document.querySelectorAll('#ctx-speed-metric-tabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderSpeedComparisonTab();
    });
    $('speed-trend-model-select')?.addEventListener('change', (e) => {
      state.ctxSpeedTrendKey = e.target.value;
      renderSpeedTrendSvg();
    });

    // Context Tab 4：账号切换与 CLI 网络代理配置
    $('btn-refresh-accounts')?.addEventListener('click', loadAccountsSettings);
    $('accounts-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-switch-account]');
      if (btn && !btn.disabled) switchActiveAccount(btn.dataset.switchAccount);
    });
    $('btn-toggle-proxy-visibility')?.addEventListener('click', () => {
      const input = $('proxy-url-input');
      const btn = $('btn-toggle-proxy-visibility');
      if (!input || !btn) return;
      const toText = input.type === 'password';
      input.type = toText ? 'text' : 'password';
      btn.textContent = toText ? '隐藏' : '显示';
    });
    $('btn-test-proxy')?.addEventListener('click', testProxySettings);
    $('btn-save-proxy')?.addEventListener('click', saveProxySettings);

    // 历史用量面板 3 Tab 切换及累计曲线切换
    $('hist-view-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-hist-tab]');
      if (btn) switchHistoryTab(btn.dataset.histTab);
    });
    $('cumulative-metric-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cum-metric]');
      if (!btn) return;
      state.cumMetric = btn.dataset.cumMetric;
      document.querySelectorAll('#cumulative-metric-tabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderCumulativeSvgChart(state.historyData?.cumulativeSeries);
    });

    // 点击面板外部收起悬浮双面板
    document.addEventListener('click', (e) => {
      const ctxPanel = $('panel-context');
      const histPanel = $('panel-history');
      if (
        ctxPanel &&
        !ctxPanel.hidden &&
        !ctxPanel.contains(e.target) &&
        !$('capsule-context')?.contains(e.target) &&
        !$('btn-open-settings')?.contains(e.target)
      ) {
        ctxPanel.hidden = true;
        $('capsule-context')?.setAttribute('aria-expanded', 'false');
        $('btn-open-settings')?.setAttribute('aria-expanded', 'false');
      }
      if (histPanel && !histPanel.hidden && !histPanel.contains(e.target) && !$('capsule-history')?.contains(e.target)) {
        histPanel.hidden = true;
        $('capsule-history')?.setAttribute('aria-expanded', 'false');
      }
    });

    // 工作区路径复制
    $('topbar-workspace-badge')?.addEventListener('click', async () => {
      if (await copyText(state.workspace)) showToast('已复制当前工作区路径');
    });

    // 上下文解锁按钮组
    $('unlock-preset-grid')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.unlock-preset-btn');
      if (!btn) return;
      const mode = btn.dataset.unlockMode;
      const limitTokens = btn.dataset.unlockLimit ? Number(btn.dataset.unlockLimit) : undefined;
      applyUnlockSetting({ mode, ...(limitTokens ? { limitTokens } : {}) });
    });
    $('btn-unlock-apply-custom')?.addEventListener('click', () => {
      const val = Number($('unlock-custom-limit')?.value || 0);
      if (!Number.isSafeInteger(val) || val < 16384 || val > 2097152) {
        showToast('请输入 16,384 ~ 2,097,152 之间的整数 Token 上限', true);
        return;
      }
      applyUnlockSetting({ mode: 'fixed', limitTokens: val });
    });
    $('btn-unlock-restore')?.addEventListener('click', () => {
      applyUnlockSetting({ action: 'restore', mode: 'restore' });
    });

    // 历史来源筛选 & 测速指标切换
    $('hist-source-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-history-source]');
      if (!btn) return;
      document.querySelectorAll('#hist-source-tabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      loadTokenHistory(btn.dataset.historySource);
    });
    $('speed-metric-tabs')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-speed-mode]');
      if (!btn) return;
      state.speedMetricMode = btn.dataset.speedMode;
      document.querySelectorAll('#speed-metric-tabs .seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      renderModelSpeedComparison(state.historyData?.modelSpeedStats);
    });

    // 热力图与近 7 天柱状图悬浮 Tooltip
    const tooltip = $('floating-tooltip');
    const handleHoverTip = (e) => {
      const cell = e.target.closest('[data-date]');
      if (!cell || cell.classList.contains('is-empty') || !tooltip) {
        if (tooltip) tooltip.hidden = true;
        return;
      }
      const d = cell.dataset;
      tooltip.hidden = false;
      tooltip.innerHTML = `
        <strong>${escapeHtml(d.date)}</strong><br/>
        总计：<b>${Number(d.total || 0).toLocaleString('en-US')}</b> tok<br/>
        输入：${Number(d.input || 0).toLocaleString('en-US')} · 缓存：${Number(d.cache || 0).toLocaleString('en-US')}<br/>
        输出：${Number(d.output || 0).toLocaleString('en-US')} · 步数：${Number(d.steps || 0)}
      `;
      const x = Math.min(window.innerWidth - 210, e.clientX + 12);
      const y = Math.min(window.innerHeight - 105, e.clientY + 12);
      tooltip.style.left = `${Math.max(8, x)}px`;
      tooltip.style.top = `${Math.max(8, y)}px`;
    };
    $('heatmap-grid')?.addEventListener('mousemove', handleHoverTip);
    $('heatmap-grid')?.addEventListener('mouseleave', () => { if (tooltip) tooltip.hidden = true; });
    $('last7-chart')?.addEventListener('mousemove', handleHoverTip);
    $('last7-chart')?.addEventListener('mouseleave', () => { if (tooltip) tooltip.hidden = true; });

    // 侧边栏、项目分组与目录选择器交互
    $('btn-switch-workspace')?.addEventListener('click', switchWorkspace);
    $('btn-browse-workspace')?.addEventListener('click', () => openDirPicker('workspace', $('workspace-input')?.value || state.workspace));
    $('btn-add-project')?.addEventListener('click', () => openDirPicker('project', state.workspace));
    $('btn-refresh-projects')?.addEventListener('click', refreshProjects);
    $('active-project-breadcrumb')?.addEventListener('click', () => openDirPicker('project', state.workspace));
    $('workspace-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') switchWorkspace();
    });
    $('btn-new-chat')?.addEventListener('click', startNewConversation);
    $('btn-refresh-convs')?.addEventListener('click', refreshConversations);
    $('btn-conv-filter')?.addEventListener('click', cycleConvFilter);
    $('conv-search-input')?.addEventListener('input', (e) => {
      state.convSearch = e.target.value;
      renderConversationList();
    });
    $('conversation-list')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-rename-input]')) return;
      const archiveBtn = e.target.closest('[data-conv-archive]');
      if (archiveBtn) {
        e.stopPropagation();
        const cid = archiveBtn.dataset.convArchive;
        const target = (state.conversations || []).find((c) => c.id === cid);
        if (target) patchConversationPref(cid, { archived: !target.archived }, target.archived ? '已取消归档' : '已归档会话');
        return;
      }
      const pinBtn = e.target.closest('[data-conv-pin]');
      if (pinBtn) {
        e.stopPropagation();
        const cid = pinBtn.dataset.convPin;
        const target = (state.conversations || []).find((c) => c.id === cid);
        if (target) patchConversationPref(cid, { pinned: !target.pinned }, target.pinned ? '已取消置顶' : '已置顶会话');
        return;
      }
      const menuBtn = e.target.closest('[data-conv-menu]');
      if (menuBtn) {
        e.stopPropagation();
        openConvContextMenu(menuBtn.dataset.convMenu, menuBtn);
        return;
      }
      const toggleBtn = e.target.closest('[data-project-toggle]');
      if (toggleBtn) {
        e.stopPropagation();
        const pid = toggleBtn.dataset.projectToggle;
        state.collapsedProjects[pid] = !state.collapsedProjects[pid];
        renderConversationList();
        return;
      }
      const newChatBtn = e.target.closest('[data-project-new]');
      if (newChatBtn) {
        e.stopPropagation();
        selectProjectById(newChatBtn.dataset.projectNew, true);
        return;
      }
      const seeAllBtn = e.target.closest('[data-project-see-all]');
      if (seeAllBtn) {
        const pid = seeAllBtn.dataset.projectSeeAll;
        state.expandedProjects[pid] = !state.expandedProjects[pid];
        renderConversationList();
        return;
      }
      const projSelect = e.target.closest('[data-project-select]');
      if (projSelect) {
        selectProjectById(projSelect.dataset.projectSelect, false);
        return;
      }
      const item = e.target.closest('[data-conv-id]');
      if (item) selectConversation(item.dataset.convId);
    });
    document.addEventListener('click', (e) => {
      if (!state.contextMenuConvId) return;
      if (e.target.closest('#conv-context-menu') || e.target.closest('[data-conv-menu]')) return;
      closeConvContextMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.contextMenuConvId) closeConvContextMenu();
    });
    $('btn-unbind-conv')?.addEventListener('click', () => {
      state.activeConversationId = null;
      renderConversationList();
      renderChatHeader();
      updateCliPreview();
      showToast('已解除续聊绑定，下次发送将创建新会话');
    });

    // 目录选择器弹窗交互
    $('btn-close-dir-picker')?.addEventListener('click', closeDirPicker);
    $('dir-picker-modal')?.addEventListener('click', (e) => {
      if (e.target === $('dir-picker-modal')) closeDirPicker();
    });
    $('btn-dir-picker-ok')?.addEventListener('click', confirmDirPicker);
    $('dir-picker-path-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmDirPicker();
      }
    });
    $('btn-dir-picker-up')?.addEventListener('click', () => {
      if (state.dirPicker.parentPath) {
        browseDirPath(state.dirPicker.parentPath);
      }
    });
    $('dir-picker-list')?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-dir-path]');
      if (item && item.dataset.dirPath) {
        browseDirPath(item.dataset.dirPath);
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const modal = $('dir-picker-modal');
        if (modal && !modal.hidden) closeDirPicker();
      }
    });

    // 中央画布事件委托：代码块复制、灯箱放大、欢迎快捷词
    $('message-list')?.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('.code-copy-btn');
      if (copyBtn) {
        const ok = await copyText(copyBtn.dataset.copyCode || '');
        if (ok) {
          copyBtn.textContent = '已复制 ✓';
          setTimeout(() => { copyBtn.textContent = '复制代码'; }, 1600);
        }
        return;
      }
      const thumb = e.target.closest('[data-lightbox-src]');
      if (thumb && thumb.dataset.lightboxSrc) {
        openLightbox(thumb.dataset.lightboxSrc, thumb.dataset.lightboxCaption);
        return;
      }
      const quick = e.target.closest('[data-prompt]');
      if (quick) {
        const input = $('prompt-input');
        if (input) {
          input.value = quick.dataset.prompt || '';
          autoResizeTextarea(input);
          updateCliPreview();
          input.focus();
        }
      }
    });

    // 消息区滚动控制
    const msgList = $('message-list');
    const scrollBtn = $('btn-scroll-bottom');
    msgList?.addEventListener('scroll', () => {
      if (!scrollBtn) return;
      const dist = msgList.scrollHeight - msgList.scrollTop - msgList.clientHeight;
      scrollBtn.hidden = dist < 120;
    });
    scrollBtn?.addEventListener('click', scrollMessagesToBottom);

    // 输入框粘贴截图 / 拖拽传图 / 选图上传
    const promptInput = $('prompt-input');
    const composer = $('composer');
    const dropOverlay = $('drop-overlay');

    promptInput?.addEventListener('input', () => {
      autoResizeTextarea(promptInput);
      updateCliPreview();
      handlePromptInputSuggest();
    });
    promptInput?.addEventListener('click', () => {
      handlePromptInputSuggest();
    });
    promptInput?.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        handlePromptInputSuggest();
      }
    });
    // Enter 发送、Shift+Enter 换行（若处于补全弹窗则优先进行指令选中补全）
    promptInput?.addEventListener('keydown', (e) => {
      if (suggestState.active) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          moveSuggestSelection(1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          moveSuggestSelection(-1);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          if (!e.isComposing && e.keyCode !== 229) {
            if (suggestState.items.length > 0) {
              e.preventDefault();
              applySuggestion(suggestState.items[suggestState.selectedIndex]);
              return;
            }
          }
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          hideSuggestPopover();
          return;
        }
      }

      if (!e.shiftKey && !e.isComposing && e.keyCode !== 229 && e.key === 'Enter') {
        e.preventDefault();
        handleSendPrompt();
      }
    });

    // 点击页面其他区域自动关闭补全浮层
    document.addEventListener('click', (e) => {
      if (suggestState.active && !e.target.closest('#composer-suggest-popover') && e.target !== promptInput) {
        hideSuggestPopover();
      }
    });
    promptInput?.addEventListener('paste', (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const imgItems = items.filter((it) => it.type.startsWith('image/'));
      if (!imgItems.length) return;
      e.preventDefault();
      imgItems.forEach((it) => {
        const file = it.getAsFile();
        if (file) uploadImageFile(file);
      });
    });

    composer?.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer?.types || []).includes('Files')) {
        e.preventDefault();
        if (dropOverlay) dropOverlay.hidden = false;
      }
    });
    composer?.addEventListener('dragleave', (e) => {
      if (!composer.contains(e.relatedTarget) && dropOverlay) {
        dropOverlay.hidden = true;
      }
    });
    composer?.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dropOverlay) dropOverlay.hidden = true;
      Array.from(e.dataTransfer?.files || []).forEach((f) => {
        if (f.type.startsWith('image/')) uploadImageFile(f);
      });
    });

    $('btn-attach-image')?.addEventListener('click', () => $('file-upload-input')?.click());
    $('file-upload-input')?.addEventListener('change', (e) => {
      Array.from(e.target.files || []).forEach(uploadImageFile);
      e.target.value = '';
    });

    // 输入区图片预览删除与灯箱点击
    $('attachment-previews')?.addEventListener('click', (e) => {
      const rmBtn = e.target.closest('[data-remove-attach]');
      if (rmBtn) {
        const idx = Number(rmBtn.dataset.removeAttach);
        state.pendingAttachments.splice(idx, 1);
        renderAttachmentPreviews();
        renderMediaAuditTable();
        updateCliPreview();
        return;
      }
      const img = e.target.closest('[data-lightbox-src]');
      if (img) openLightbox(img.dataset.lightboxSrc, img.dataset.lightboxCaption);
    });

    // 官方 1:1 模型选择胶囊、模式切换胶囊与额度浮层事件绑定
    $('btn-model-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleModelSwitcherPopover();
    });
    $('btn-mode-picker')?.addEventListener('click', (e) => {
      e.stopPropagation();
      cyclePermissionMode();
    });
    $('btn-toggle-usage-view')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const usageEl = $('model-popover-usage');
      const trigger = $('btn-toggle-usage-view');
      if (usageEl) {
        usageEl.hidden = !usageEl.hidden;
        const willShow = !usageEl.hidden;
        if (trigger) {
          trigger.classList.toggle('is-expanded', willShow);
          trigger.setAttribute('aria-expanded', String(willShow));
        }
        // 每次点开/展开 View Usage 额度面板时，强制向服务端重新查询最新额度
        if (willShow) {
          refreshUsageLimits(true);
        }
      }
    });
    $('btn-refresh-usage')?.addEventListener('click', (e) => {
      e.stopPropagation();
      refreshUsageLimits();
    });
    $('composer-project-pill')?.addEventListener('click', () => {
      openDirPicker('project', state.workspace);
    });

    // 点击页面其他区域关闭模型与额度弹窗
    document.addEventListener('click', (e) => {
      const pop = $('model-switcher-popover');
      const trigger = $('btn-model-picker');
      if (pop && !pop.hidden && !pop.contains(e.target) && !trigger?.contains(e.target)) {
        closeModelSwitcherPopover();
      }
    });

    // 快捷键 Alt+M (或 Option+M) 呼出模型选择菜单
    window.addEventListener('keydown', (e) => {
      if ((e.altKey && e.code === 'KeyM') || (e.ctrlKey && e.shiftKey && e.code === 'KeyM')) {
        e.preventDefault();
        toggleModelSwitcherPopover();
      } else if (e.key === 'Escape') {
        closeModelSwitcherPopover();
      }
    });

    // 模型参数控制联动
    ['select-model', 'select-effort', 'select-mode', 'chk-skip-permissions'].forEach((id) => {
      $(id)?.addEventListener('change', () => {
        if (id === 'select-model') {
          if (!state.activeConversationId) {
            state.contextMetrics.model = $('select-model')?.value || '';
          }
          const activeVal = $('select-model')?.value || '';
          const info = formatOfficialModel(activeVal);
          if ($('model-picker-name')) $('model-picker-name').textContent = info.displayName;
          if ($('ctx-panel-model-pill')) $('ctx-panel-model-pill').textContent = info.displayName;
          updateModelPickerQuotaPill();
          renderModelSwitcherList();
          syncActiveModelBudget(state.modelCtxOverrides);
        }
        updateCliPreview();
      });
    });
    $('btn-send-prompt')?.addEventListener('click', handleSendPrompt);
    $('btn-stop-stream')?.addEventListener('click', stopActiveStream);

    // 官方 Side Panel 手风琴分组展开/收起切换
    document.querySelectorAll('.side-sec-head').forEach((btn) => {
      btn.addEventListener('click', () => {
        const sec = btn.closest('.side-accordion-sec');
        if (!sec) return;
        const isExp = sec.classList.toggle('is-expanded');
        btn.setAttribute('aria-expanded', String(isExp));
        const body = sec.querySelector('.side-sec-body');
        if (body) body.hidden = !isExp;
      });
    });

    // 官方快捷键 Ctrl+Alt+B (或 Cmd+Alt+B) 切换右侧 Side Panel
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.altKey && (e.key === 'b' || e.key === 'B')) {
        e.preventDefault();
        toggleAuxPane();
      }
    });

    $('btn-refresh-workspace')?.addEventListener('click', loadWorkspaceOverview);
    $('btn-refresh-files')?.addEventListener('click', loadWorkspaceOverview);
    $('workspace-files-list')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-insert-file]');
      if (!row) return;
      const input = $('prompt-input');
      if (!input) return;
      const token = `@${row.dataset.insertFile} `;
      input.value = input.value ? `${input.value.trimEnd()} ${token}` : token;
      autoResizeTextarea(input);
      updateCliPreview();
      input.focus();
    });
    $('btn-copy-cli-cmd')?.addEventListener('click', async () => {
      const cmd = $('cli-command-preview')?.textContent || '';
      if (await copyText(cmd)) showToast('已复制等效 CLI 命令');
    });

    // 图片灯箱关闭与对话内图片点击放大
    $('messages-container')?.addEventListener('click', (e) => {
      const img = e.target.closest('.md-inline-img');
      if (img && img.src) {
        openLightbox(img.src, img.alt || '图片预览');
      }
    });
    $('btn-close-lightbox')?.addEventListener('click', closeLightbox);
    $('lightbox-modal')?.addEventListener('click', (e) => {
      if (e.target === $('lightbox-modal')) closeLightbox();
    });

    // 登录表单与登出
    $('auth-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = $('auth-password-input')?.value || '';
      const errEl = $('auth-error-msg');
      try {
        const loginRes = await apiFetch('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ password })
        });
        if (loginRes && loginRes.token) {
          localStorage.setItem('agy_token', loginRes.token);
        }
        closeAuthModal();
        showToast('身份验证成功');
        await loadBootstrap();
      } catch (err) {
        if (errEl) {
          errEl.hidden = false;
          errEl.textContent = err.message || '密码错误，请重试';
        }
      }
    });
    $('btn-logout')?.addEventListener('click', async () => {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
        localStorage.removeItem('agy_token');
        state.authenticated = false;
        openAuthModal();
      } catch (err) {
        showToast(err.message, true);
      }
    });
  }

  function openLightbox(src, caption) {
    const modal = $('lightbox-modal');
    if (!modal || !src) return;
    $('lightbox-img').src = src;
    $('lightbox-caption').textContent = caption || '图片预览';
    modal.hidden = false;
  }

  function closeLightbox() {
    const modal = $('lightbox-modal');
    if (modal) modal.hidden = true;
    const img = $('lightbox-img');
    if (img) img.src = '';
  }

  /**
   * 对话管理辅助函数（重命名 / 置顶 / 未读 / 归档 / 复制 / 删除 / 上下文菜单）
   */
  async function patchConversationPref(convId, patch, toastMsg = '', silent = false) {
    if (!convId) return;
    try {
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(convId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch)
      });
      const prefs = res.prefs || {};
      state.conversations = (state.conversations || []).map((c) => {
        if (c.id !== convId) return c;
        return {
          ...c,
          title: prefs.customTitle || c.rawTitle || c.title,
          pinned: Boolean(prefs.pinned),
          unread: Boolean(prefs.unread),
          archived: Boolean(prefs.archived)
        };
      });
      state.conversations.sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      });
      if (state.activeConversationId === convId && prefs.customTitle) {
        state.activeConversationTitle = prefs.customTitle;
        const headerTitleEl = $('active-conv-title');
        if (headerTitleEl) headerTitleEl.textContent = prefs.customTitle;
      }
      renderConversationList();
      if (toastMsg && !silent) showToast(toastMsg);
    } catch (err) {
      if (!silent) showToast(`操作失败：${err.message}`, true);
    }
  }

  async function deleteConversationItem(convId) {
    if (!convId) return;
    const target = (state.conversations || []).find((c) => c.id === convId);
    const label = target?.title || convId;
    if (!window.confirm(`确认删除会话「${label}」？\n（仅从控制台列表移除，不会破坏本机原始日志文件）`)) {
      return;
    }
    try {
      await apiFetch(`/api/conversations/${encodeURIComponent(convId)}`, { method: 'DELETE' });
      state.conversations = (state.conversations || []).filter((c) => c.id !== convId);
      if (state.activeConversationId === convId) {
        startNewConversation();
      } else {
        renderConversationList();
      }
      showToast('已删除会话');
    } catch (err) {
      showToast(`删除失败：${err.message}`, true);
    }
  }

  function startInlineRename(convId) {
    if (!convId) return;
    state.renamingConvId = convId;
    renderConversationList();
    const input = document.querySelector(`[data-rename-input="${CSS.escape(convId)}"]`);
    if (!input) return;
    input.focus();
    input.select();

    let finished = false;
    const finish = async (commit) => {
      if (finished) return;
      finished = true;
      const nextVal = input.value.trim();
      state.renamingConvId = null;
      if (commit) {
        await patchConversationPref(convId, { title: nextVal }, nextVal ? '已重命名会话' : '已恢复默认标题');
      } else {
        renderConversationList();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function cycleConvFilter() {
    const order = ['active', 'unread', 'archived'];
    const next = order[(order.indexOf(state.convFilter) + 1) % order.length];
    state.convFilter = next;
    const badge = $('conv-filter-badge');
    const btn = $('btn-conv-filter');
    const labelMap = { active: '', unread: '未读', archived: '归档' };
    const titleMap = { active: '筛选会话（当前：常规）', unread: '筛选会话（当前：仅未读）', archived: '筛选会话（当前：已归档）' };
    if (badge) {
      badge.textContent = labelMap[next] || '';
      badge.hidden = !labelMap[next];
    }
    if (btn) btn.title = titleMap[next] || '筛选会话';
    renderConversationList();
  }

  function closeConvContextMenu() {
    const menu = $('conv-context-menu');
    if (menu) {
      menu.hidden = true;
      menu.innerHTML = '';
    }
    if (state.contextMenuConvId) {
      state.contextMenuConvId = null;
      document.querySelectorAll('.conv-item.is-menu-open').forEach((el) => {
        el.classList.remove('is-menu-open');
      });
    }
  }

  function openConvContextMenu(convId, anchorEl) {
    const menu = $('conv-context-menu');
    const conv = (state.conversations || []).find((c) => c.id === convId);
    if (!menu || !conv || !anchorEl) return;

    if (state.contextMenuConvId === convId && !menu.hidden) {
      closeConvContextMenu();
      return;
    }

    // 1. 率先精确获取 anchor 按钮在当前视口中的绝对坐标（避开任何 DOM 重构干扰）
    const rect = anchorEl.getBoundingClientRect();

    state.contextMenuConvId = convId;
    document.querySelectorAll('.conv-item').forEach((el) => {
      el.classList.toggle('is-menu-open', el.dataset.convId === convId);
    });

    menu.innerHTML = `
      <button class="conv-menu-item" type="button" data-menu-action="rename">
        <span>✏️</span><span>Rename</span>
      </button>
      <button class="conv-menu-item" type="button" data-menu-action="pin">
        <span>📌</span><span>${conv.pinned ? 'Unpin' : 'Pin'}</span>
      </button>
      <button class="conv-menu-item" type="button" data-menu-action="unread">
        <span>💬</span><span>${conv.unread ? 'Mark Read' : 'Mark Unread'}</span>
      </button>
      <div class="conv-submenu-wrap">
        <button class="conv-menu-item" type="button" data-menu-action="copy-toggle">
          <span>📋</span><span>Copy</span><span class="conv-menu-arrow">▸</span>
        </button>
        <div class="conv-submenu">
          <button class="conv-menu-item" type="button" data-menu-action="copy-title"><span>Copy Title</span></button>
          <button class="conv-menu-item" type="button" data-menu-action="copy-id"><span>Copy ID</span></button>
          <button class="conv-menu-item" type="button" data-menu-action="copy-link"><span>Copy Link</span></button>
        </div>
      </div>
      <div class="conv-menu-sep"></div>
      <button class="conv-menu-item" type="button" data-menu-action="archive">
        <span>📥</span><span>${conv.archived ? 'Unarchive' : 'Archive'}</span>
      </button>
      <button class="conv-menu-item is-danger" type="button" data-menu-action="delete">
        <span>🗑️</span><span>Delete</span>
      </button>
    `;

    menu.hidden = false;
    const menuRect = menu.getBoundingClientRect();

    // 水平对齐：右边缘对齐三点按钮的右边缘（内缩 2px），并在视口边界内做安全钳位
    let left = rect.right - menuRect.width - 2;
    if (left < 10) left = 10;
    if (left + menuRect.width > window.innerWidth - 10) {
      left = window.innerWidth - menuRect.width - 10;
    }

    // 垂直对齐：默认在按钮正下方弹出；若视口底部空间不足以完整容纳，则自适应向上翻转弹出
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 10) {
      top = Math.max(10, rect.top - menuRect.height - 4);
    }

    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;

    menu.onclick = async (ev) => {
      const btn = ev.target.closest('[data-menu-action]');
      if (!btn) return;
      const action = btn.dataset.menuAction;
      if (action === 'copy-toggle') {
        btn.parentElement?.classList.toggle('is-open');
        return;
      }
      closeConvContextMenu();
      if (action === 'rename') startInlineRename(convId);
      else if (action === 'pin') await patchConversationPref(convId, { pinned: !conv.pinned }, conv.pinned ? '已取消置顶' : '已置顶会话');
      else if (action === 'unread') await patchConversationPref(convId, { unread: !conv.unread }, conv.unread ? '已标记为已读' : '已标记为未读');
      else if (action === 'archive') await patchConversationPref(convId, { archived: !conv.archived }, conv.archived ? '已取消归档' : '已归档会话');
      else if (action === 'delete') await deleteConversationItem(convId);
      else if (action === 'copy-title') {
        if (await copyText(conv.title || conv.id)) showToast('已复制会话标题');
      } else if (action === 'copy-id') {
        if (await copyText(conv.id)) showToast('已复制会话 ID');
      } else if (action === 'copy-link') {
        const deepLink = `${window.location.origin}${window.location.pathname}?conv=${encodeURIComponent(conv.id)}`;
        if (await copyText(deepLink)) showToast('已复制会话直达链接');
      }
    };
  }

  // --------------------------------------------------------------------------
  // / 与 @ 呼出指令与上下文提及补全控制器（完全对标 Antigravity 官方 Remote Control）
  // --------------------------------------------------------------------------

  const DEFAULT_SLASH_COMMANDS = [
    { name: 'mcpx:dsh-openclaw-ecosystem_rea:investigate_feature', prefix: '/', kind: 'tool', icon: 'tool', description: 'Trace a feature through relevant artifact, symbol, and function evidence.' },
    { name: 'mcpx:dsh-openclaw-ecosystem_rea:compare_application_versions', prefix: '/', kind: 'tool', icon: 'tool', description: 'Compare two shipped application artifacts through complete analysis.' },
    { name: 'mcpx:dsh-openclaw-ecosystem_rea:verify_reconstruction', prefix: '/', kind: 'tool', icon: 'tool', description: 'Evaluate a finite reconstruction specification against retained evidence.' },
    { name: 'mcpx:dsh-openclaw-ecosystem_rea:trace_crash', prefix: '/', kind: 'tool', icon: 'tool', description: 'Correlate a crash symptom with static call and reference evidence plus optional stack.' },
    { name: 'mcpx:dsh-openclaw-ecosystem_rea:audit_residual_unknowns', prefix: '/', kind: 'tool', icon: 'tool', description: 'Review current residual-unknown heads against retained evidence.' },
    { name: 'mcpx:dsh-openclaw-ecosystem_rea:prepare_bounded_process_capture', prefix: '/', kind: 'tool', icon: 'tool', description: 'Choose a command, inputs, observations, and stopping condition for dynamic trace.' },
    { name: 'goal', prefix: '/', kind: 'command', icon: 'goal', description: 'Run until the specified goal is completely finished.' },
    { name: 'compact', prefix: '/', kind: 'command', icon: 'compact', description: 'Compact the conversation now (summarize history to free up the context window).' },
    { name: 'plan', prefix: '/', kind: 'command', icon: 'plan', description: 'Enter step-by-step planning mode before execution.' },
    { name: 'grill-me', prefix: '/', kind: 'command', icon: 'chat', description: 'Interactive interview before coding to resolve design decisions.' },
    { name: 'browser', prefix: '/', kind: 'command', icon: 'browser', description: 'Operate live web pages via built-in browser agent.' },
    { name: 'schedule', prefix: '/', kind: 'command', icon: 'clock', description: 'Schedule recurring cron or one-shot automation task.' },
    { name: 'teamwork', prefix: '/', kind: 'command', icon: 'team', description: 'Autonomous multi-agent teamwork.' },
    { name: 'learn', prefix: '/', kind: 'command', icon: 'book', description: 'Persist behavior or setup for future tasks.' },
    { name: 'boost', prefix: '/', kind: 'command', icon: 'zap', description: 'Deep thinking, strategic planning, multiple perspectives.' },
    { name: 'swarm', prefix: '/', kind: 'command', icon: 'team', description: '(Preview & Quota Heavy) Run a swarm: multiple agents working in parallel on one task via shared board.' },
    { name: 'swarm_monitor', prefix: '/', kind: 'command', icon: 'info', description: 'Monitor swarm execution states and unstick blocked workers.' },
    { name: 'automation', prefix: '/', kind: 'command', icon: 'clock', description: 'Interactive guide to design and create a scheduled background automation.' },
    { name: 'plugin', prefix: '/', kind: 'command', icon: 'tool', description: 'Manage and create plugins: skills, agents, rules, MCP servers.' },
    { name: 'context', prefix: '/', kind: 'command', icon: 'box', description: 'Inspect current conversation context token usage and distribution.' },
    { name: 'review', prefix: '/', kind: 'command', icon: 'chat', description: 'Review git changes and workspace code quality.' },
    { name: 'help', prefix: '/', kind: 'command', icon: 'info', description: 'List available commands and keyboard shortcuts.' },
    { name: 'status', prefix: '/', kind: 'command', icon: 'info', description: 'Show current CLI status and context statistics.' },
    { name: 'clear', prefix: '/', kind: 'command', icon: 'trash', description: 'Clear messages from display.' }
  ];

  const DEFAULT_MENTIONS = [
    { name: 'file', prefix: '@', kind: 'mention', icon: 'file', description: 'Reference a file in the workspace' },
    { name: 'folder', prefix: '@', kind: 'mention', icon: 'folder', description: 'Reference a directory tree' },
    { name: 'git', prefix: '@', kind: 'mention', icon: 'git', description: 'Include current Git status, diff, or recent commits' },
    { name: 'terminal', prefix: '@', kind: 'mention', icon: 'terminal', description: 'Reference recent terminal command output' },
    { name: 'problems', prefix: '@', kind: 'mention', icon: 'alert', description: 'Include code diagnostics & compiler errors' },
    { name: 'docs', prefix: '@', kind: 'mention', icon: 'book', description: 'Reference project documentation & README' },
    { name: 'browser', prefix: '@', kind: 'mention', icon: 'browser', description: 'Delegate task to browser agent' },
    { name: 'research', prefix: '@', kind: 'mention', icon: 'search', description: 'Delegate to read-only research agent' },
    { name: 'workspace', prefix: '@', kind: 'mention', icon: 'box', description: 'Overview of active workspace' }
  ];

  const suggestState = {
    active: false,
    trigger: '',
    triggerPos: -1,
    query: '',
    items: [],
    selectedIndex: 0,
    allSlashCommands: [...DEFAULT_SLASH_COMMANDS],
    allMentions: [...DEFAULT_MENTIONS]
  };

  function renderSuggestIconSvg(icon) {
    if (icon === 'tool') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2.5" width="12" height="11" rx="2"/><line x1="2" y1="6" x2="14" y2="6"/></svg>`;
    }
    if (icon === 'goal') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.2"/></svg>`;
    }
    if (icon === 'compact') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 5.5l3.5 2.5-3.5 2.5M12.5 5.5l-3.5 2.5 3.5 2.5"/></svg>`;
    }
    if (icon === 'plan') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="2" width="10" height="12" rx="1.5"/><path d="M6 5h4M6 8h4M6 11h2"/></svg>`;
    }
    if (icon === 'browser') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2a9 9 0 0 1 0 12 9 9 0 0 1 0-12"/></svg>`;
    }
    if (icon === 'file') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2h6l3.5 3.5V14H3.5z"/><path d="M9.5 2v4h4"/></svg>`;
    }
    if (icon === 'folder') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3.5h4l1.5 2h6.5v7H2z"/></svg>`;
    }
    if (icon === 'git') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="4.5" r="2"/><circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="7.5" r="2"/><path d="M4.5 6.5v3M4.5 8c2 0 4.5-.5 7-.5"/></svg>`;
    }
    if (icon === 'terminal') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M5 6.5l2 1.5-2 1.5M8.5 9.5h2.5"/></svg>`;
    }
    if (icon === 'alert') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 5v4M8 11.5h.01"/></svg>`;
    }
    if (icon === 'clock') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/></svg>`;
    }
    if (icon === 'team') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><circle cx="11.5" cy="6.5" r="2"/><path d="M2.5 13.5c0-2.2 2-3.5 4.5-3.5s4.5 1.3 4.5 3.5M10.5 10c1.5.3 3 1.2 3 3.5"/></svg>`;
    }
    if (icon === 'book') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 3.5a2 2 0 0 1 2-2h8.5v12H4.5a2 2 0 0 0-2 2z"/><path d="M2.5 3.5v10"/></svg>`;
    }
    if (icon === 'zap') {
      return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.5L2.5 9h5l-1 5.5 7-8h-5z"/></svg>`;
    }
    return `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/></svg>`;
  }

  function highlightSuggestMatch(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    const before = escapeHtml(text.slice(0, idx));
    const match = escapeHtml(text.slice(idx, idx + query.length));
    const after = escapeHtml(text.slice(idx + query.length));
    return `${before}<span class="suggest-match">${match}</span>${after}`;
  }

  function openSuggestPopover(trigger, query, triggerPos) {
    const pop = $('composer-suggest-popover');
    const titleEl = $('suggest-head-title');
    const badgeEl = $('suggest-head-badge');
    const listEl = $('suggest-list');
    if (!pop || !listEl) return;

    suggestState.active = true;
    suggestState.trigger = trigger;
    suggestState.triggerPos = triggerPos;
    suggestState.query = query;

    const source = trigger === '/' ? suggestState.allSlashCommands : suggestState.allMentions;
    const filtered = source.filter((item) => {
      if (!query) return true;
      const n = (item.name || '').toLowerCase();
      const d = (item.description || '').toLowerCase();
      return n.includes(query) || d.includes(query);
    });

    suggestState.items = filtered;
    suggestState.selectedIndex = 0;

    if (titleEl) titleEl.textContent = trigger === '/' ? '指令与工具' : '上下文提及与引用';
    if (badgeEl) badgeEl.textContent = trigger;

    renderSuggestListDom();
    pop.hidden = false;
  }

  function hideSuggestPopover() {
    const pop = $('composer-suggest-popover');
    if (pop) pop.hidden = true;
    suggestState.active = false;
    suggestState.items = [];
    suggestState.selectedIndex = 0;
  }

  function renderSuggestListDom() {
    const listEl = $('suggest-list');
    if (!listEl) return;
    if (!suggestState.items.length) {
      listEl.innerHTML = `<div class="suggest-empty">未匹配到相关${suggestState.trigger === '/' ? '指令或工具' : '上下文引用'}</div>`;
      return;
    }

    listEl.innerHTML = suggestState.items.map((item, idx) => {
      const isSelected = idx === suggestState.selectedIndex;
      const iconHtml = renderSuggestIconSvg(item.icon || item.kind);
      const highlightedName = highlightSuggestMatch(item.name, suggestState.query);
      return `
        <div class="suggest-item${isSelected ? ' is-selected' : ''}" data-suggest-index="${idx}" role="option" aria-selected="${isSelected}">
          <span class="suggest-icon">${iconHtml}</span>
          <span class="suggest-name">${highlightedName}</span>
          <span class="suggest-desc" title="${escapeHtml(item.description || '')}">${escapeHtml(item.description || '')}</span>
        </div>
      `;
    }).join('');

    listEl.querySelectorAll('.suggest-item').forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const idx = Number(el.dataset.suggestIndex);
        if (!isNaN(idx) && idx !== suggestState.selectedIndex) {
          suggestState.selectedIndex = idx;
          updateSuggestSelectionStyles();
        }
      });
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const idx = Number(el.dataset.suggestIndex);
        if (!isNaN(idx) && suggestState.items[idx]) {
          applySuggestion(suggestState.items[idx]);
        }
      });
    });

    scrollSuggestSelectedIntoView();
  }

  function updateSuggestSelectionStyles() {
    const listEl = $('suggest-list');
    if (!listEl) return;
    const items = listEl.querySelectorAll('.suggest-item');
    items.forEach((it, idx) => {
      const isSel = idx === suggestState.selectedIndex;
      it.classList.toggle('is-selected', isSel);
      it.setAttribute('aria-selected', isSel ? 'true' : 'false');
    });
    scrollSuggestSelectedIntoView();
  }

  function scrollSuggestSelectedIntoView() {
    const listEl = $('suggest-list');
    if (!listEl) return;
    const activeEl = listEl.querySelector('.suggest-item.is-selected');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSuggestSelection(delta) {
    if (!suggestState.items.length) return;
    const count = suggestState.items.length;
    suggestState.selectedIndex = (suggestState.selectedIndex + delta + count) % count;
    updateSuggestSelectionStyles();
  }

  function applySuggestion(item) {
    const input = $('prompt-input');
    if (!input || !item) return;

    const cursorPos = input.selectionStart;
    const text = input.value;
    const start = suggestState.triggerPos;
    const prefix = suggestState.trigger;

    // 格式化补全内容：保留指令前缀并附带一个空格，方便后续打参数
    const nameWithPrefix = item.name.startsWith(prefix) ? item.name : `${prefix}${item.name}`;
    const insertText = `${nameWithPrefix} `;

    const before = text.slice(0, start);
    const after = text.slice(cursorPos);
    input.value = before + insertText + after;

    const nextPos = start + insertText.length;
    input.focus();
    input.setSelectionRange(nextPos, nextPos);

    hideSuggestPopover();
    autoResizeTextarea(input);
    updateCliPreview();
  }

  function handlePromptInputSuggest() {
    const input = $('prompt-input');
    if (!input) return;

    const cursorPos = input.selectionStart;
    const textBefore = input.value.slice(0, cursorPos);

    // 匹配光标紧邻的 token：以 / 或 @ 开头（允许在段首或空白符后）
    const match = textBefore.match(/(?:^|[\s\n])([\/@][^\s\n]*)$/);
    if (!match) {
      hideSuggestPopover();
      return;
    }

    const token = match[1];
    const trigger = token[0]; // '/' 或 '@'
    const query = token.slice(1).trim().toLowerCase();
    const tokenStartPos = cursorPos - token.length;

    openSuggestPopover(trigger, query, tokenStartPos);
  }

  // 启动入口
  document.addEventListener('DOMContentLoaded', async () => {
    bindGlobalEvents();
    await loadBootstrap();
    const urlConv = new URLSearchParams(window.location.search).get('conv');
    if (urlConv) {
      selectConversation(urlConv);
    }
  });
})();
