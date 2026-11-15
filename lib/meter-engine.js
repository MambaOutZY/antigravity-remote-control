'use strict';

/**
 * Antigravity 上下文与 Token 计量核心引擎（零外部 npm 依赖）
 * 兼容 Windows 与 Ubuntu Linux，提供文本/图像 Token 估算、请求异常分类、
 * 双源（CLI + Desktop）会话审计以及 52 周热力图与 API 账单统计。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath } = require('url');

// ============================================================================
// 常量与官方公开费率表
// ============================================================================

const DEFAULT_CHECKPOINT_TOKENS = 256000;
const USD_TO_CNY_RATE = 7.25;
const PRO_MONTHLY_USD = 20;
const MAX_SPEED_SAMPLES_PER_MODEL = 200;

// 扫描 transcript 时跳过的重型目录，防止遍历附件/临时文件拖慢性能
const TRANSCRIPT_SKIP_DIRS = new Set([
  'steps',
  'scratch',
  'media',
  'artifacts',
  'node_modules',
  '.git',
  '__pycache__',
  '.user_uploaded',
  '.agy_uploads'
]);

// 官方 Developer API Standard 公开费率表 (USD / 百万 Token)
const GEMINI_PRICING_TABLE = {
  'gemini-3.8-flash': [
    {
      effectiveTo: '2026-12-31',
      inputPerMillion: 0.75,
      outputPerMillion: 3.75,
      cacheReadPerMillion: 0.075
    },
    {
      effectiveFrom: '2027-01-01',
      inputPerMillion: 1.50,
      outputPerMillion: 7.50,
      cacheReadPerMillion: 0.15
    }
  ],
  'gemini-4-argon': [
    {
      effectiveTo: '2026-11-30',
      inputPerMillion: 2.00,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.10
    },
    {
      effectiveFrom: '2026-12-01',
      inputPerMillion: 4.00,
      outputPerMillion: 20.00,
      cacheReadPerMillion: 0.20
    }
  ],
  'gemini-3.1-pro-preview': [
    {
      maxPromptTokens: 200000,
      inputPerMillion: 2.00,
      outputPerMillion: 12.00,
      cacheReadPerMillion: 0.20
    },
    {
      minPromptTokens: 200001,
      inputPerMillion: 4.00,
      outputPerMillion: 18.00,
      cacheReadPerMillion: 0.40
    }
  ],
  'gemini-3.5-flash-lite': [
    {
      inputPerMillion: 0.30,
      outputPerMillion: 2.50,
      cacheReadPerMillion: 0.03
    }
  ],
  'gemini-2.5-pro': [
    {
      maxPromptTokens: 200000,
      inputPerMillion: 1.25,
      outputPerMillion: 10.00,
      cacheReadPerMillion: 0.125
    },
    {
      minPromptTokens: 200001,
      inputPerMillion: 2.50,
      outputPerMillion: 15.00,
      cacheReadPerMillion: 0.25
    }
  ]
};

const MODEL_DISPLAY_MAP = {
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-2.5-pro': 'Gemini 2.5 Pro'
};

const EFFORT_WHITELIST = ['Extra High', 'XHigh', 'Low', 'Medium', 'High', 'Extra', 'Minimal', 'Max'];

// 单文件 transcript 增量缓存：key 为真实文件路径，按 size + mtimeMs + 标注 mtimeMs 失效
const transcriptParseCache = new Map();

// ============================================================================
// 基础数值、日期与模型识别工具
// ============================================================================

function toNonNegNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseDurationSec(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
  if (!match) return null;
  const num = parseFloat(match[1]);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseIsoTimestampMs(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function formatTokensK(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const num = Number(v);
  if (num >= 1e6) return `${parseFloat((num / 1e6).toFixed(2))}M`;
  if (num >= 1000) return `${parseFloat((num / 1000).toFixed(1))}K`;
  return Math.round(num).toLocaleString('en-US');
}

/**
 * 将模型原始名映射为标准计费模型键；无法匹配官方费率表时返回 null
 */
function normalizeModelId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const str = raw.trim().toLowerCase();
  if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
  if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon')) return 'gemini-4-argon';
  if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
  if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) return 'gemini-3.5-flash-lite';
  if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
  return null;
}

function getModelPoolKey(raw) {
  if (!raw) return 'unknown';
  const s = String(raw).toLowerCase();
  if (s.includes('argon') || s.includes('gemini-4-argon')) return 'gemini-4-argon';
  if (s.includes('flash') || s.includes('gemini-3.8-flash')) return 'gemini-3.8-flash';
  if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
  if (s.includes('sonnet') || s.includes('claude-sonnet')) return 'claude-sonnet-5-5';
  if (s.includes('gpt-oss')) return 'gpt-oss-120b';
  return s.replace(/[^a-z0-9_-]/g, '');
}

function normalizeEffortValue(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
  if (!s) return null;
  if (s === 'x high' || s === 'xhigh') return 'XHigh';
  for (const item of EFFORT_WHITELIST) {
    if (item.toLowerCase() === s) return item;
  }
  return null;
}

function detectModelVendor(productLabel, modelId) {
  const candidates = [productLabel, modelId]
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim().toLowerCase());
  for (const c of candidates) {
    if (/^(?:models\/)?(?:gemini|google|gemma|imagen|veo)\b/.test(c)) return 'Google';
    if (/^(?:models\/)?(?:claude|anthropic)\b/.test(c)) return 'Anthropic';
    if (/^(?:models\/)?(?:gpt|openai|o1|o3|o4|chatgpt|codex)\b/.test(c)) return 'OpenAI';
  }
  return '其他';
}

function groupModelProduct(config) {
  const obj = config && typeof config === 'object' ? config : { label: String(config || '') };
  const rawId = String(obj.modelId || obj.modelRaw || '').trim();
  const rawLabel = String(obj.label || obj.modelDisplayName || obj.model || '').trim();
  const explicitEffort = normalizeEffortValue(obj.effort || '');

  let effort = explicitEffort;
  let productLabel = rawLabel;
  const effParts = EFFORT_WHITELIST.map((e) => e.replace(/\s+/g, '\\s+')).join('|');
  const parenRe = new RegExp(`^(.+?)\\s*[\\(（](${effParts})[\\)）]\\s*$`, 'i');
  const suffixRe = new RegExp(`^(.+?)\\s+(${effParts})\\s*$`, 'i');

  if (productLabel) {
    const mParen = productLabel.match(parenRe);
    if (mParen) {
      productLabel = mParen[1].trim();
      if (!effort) effort = normalizeEffortValue(mParen[2]);
    } else {
      const mSuffix = productLabel.match(suffixRe);
      if (mSuffix) {
        productLabel = mSuffix[1].trim();
        if (!effort) effort = normalizeEffortValue(mSuffix[2]);
      }
    }
  }

  if (!productLabel && rawId) {
    const mId = rawId.match(/^(.+?)[-_](extra[-_]?high|x[-_]?high|low|medium|high|extra|minimal|max)$/i);
    if (mId) {
      productLabel = mId[1].trim();
      if (!effort) effort = normalizeEffortValue(mId[2]);
    } else {
      productLabel = rawId;
    }
  }

  if (!productLabel) productLabel = 'Unknown';
  const vendor = detectModelVendor(productLabel, rawId);
  const vendorSlugMap = { Google: 'google', Anthropic: 'anthropic', OpenAI: 'openai', 其他: 'other' };
  const slug = productLabel
    .toLowerCase()
    .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const productKey = `product:${vendorSlugMap[vendor] || 'other'}:${slug || rawId.toLowerCase() || 'unknown'}`;

  return { productKey, productLabel, vendor, effort: effort || null };
}

// ============================================================================
// 1. 文本与图像 Token 估算
// ============================================================================

function emptyMeasure() {
  return { chars: 0, bytes: 0, low: 0, high: 0, estimate: 0 };
}

function addMeasure(target, delta) {
  for (const k of ['chars', 'bytes', 'low', 'high', 'estimate']) {
    target[k] += delta[k] || 0;
  }
  return target;
}

/**
 * CJK 感知的文本 Token 估算
 * 中文/日文/韩文字符按 ~1.2 tokens/字估算，ASCII/英文按 ~0.25 tokens/字符估算
 */
function measureText(text) {
  const str = String(text || '');
  let chars = 0;
  let bytes = 0;
  let cjk = 0;

  for (const ch of str) {
    const c = ch.codePointAt(0);
    chars++;
    bytes += c <= 127 ? 1 : c <= 2047 ? 2 : c <= 65535 ? 3 : 4;
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) {
      cjk++;
    }
  }

  const middle = (chars - cjk) / 4 + cjk * 1.2;
  const low = Math.ceil(middle * 0.7);
  const high = Math.ceil(Math.max(middle * 1.6, bytes / 2));
  const estimate = chars === 0 ? 0 : Math.ceil(middle);
  return { chars, bytes, low, high, estimate };
}

/**
 * 解析 PNG / JPEG / GIF / BMP / WebP 图片头获取像素宽高
 */
function parseImageDimensions(buf) {
  try {
    if (!buf || buf.length < 10) return { width: null, height: null };

    // PNG: 8 字节魔数 + IHDR (16..24)
    if (
      buf.length >= 24 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
    ) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    // GIF87a / GIF89a
    if (buf.length >= 10) {
      const gifSig = buf.toString('ascii', 0, 6);
      if (gifSig === 'GIF87a' || gifSig === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
    }

    // BMP: 'BM'
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4d) {
      const dibSize = buf.readUInt32LE(14);
      if (dibSize === 12 && buf.length >= 22) {
        return { width: buf.readUInt16LE(18), height: buf.readUInt16LE(20) };
      }
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }

    // WebP: RIFF....WEBP
    if (
      buf.length >= 30 &&
      buf.toString('ascii', 0, 4) === 'RIFF' &&
      buf.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8 ' && buf.length >= 30) {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L' && buf.length >= 25) {
        const bits = buf.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X' && buf.length >= 30) {
        return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
      }
    }

    // JPEG: FF D8 开头，遍历段标记直到 SOF0..SOF15
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2;
      while (offset + 1 < buf.length) {
        if (buf[offset] !== 0xff) {
          offset++;
          continue;
        }
        while (offset < buf.length && buf[offset] === 0xff) offset++;
        if (offset >= buf.length) break;

        const marker = buf[offset];
        offset++;
        // 无长度字段的独立标记（SOI/EOI/RST/TEM）
        if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
          if (marker === 0xd9) break;
          continue;
        }
        if (marker === 0xda) break; // SOS 图像扫描数据开始
        if (offset + 2 > buf.length) break;

        const segLen = buf.readUInt16BE(offset);
        if (segLen < 2) break;

        // 常见帧起始标记 SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
        if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
          if (offset + 7 <= buf.length) {
            return { height: buf.readUInt16BE(offset + 3), width: buf.readUInt16BE(offset + 5) };
          }
          break;
        }
        offset += segLen;
      }
    }
  } catch {
    // 忽略损坏头部的解析异常，降级为未知尺寸
  }
  return { width: null, height: null };
}

/**
 * 解析图像二进制尺寸并按 Gemini 768x768 tile 规则计算图像 Token
 */
function inspectImageBuffer(input) {
  let buf = null;
  if (Buffer.isBuffer(input)) {
    buf = input;
  } else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    buf = Buffer.from(input);
  } else if (typeof input === 'string') {
    const cleaned = input.replace(/^data:[^;]+;base64,/i, '');
    buf = Buffer.from(cleaned, 'base64');
  }

  const { width, height } = parseImageDimensions(buf);
  if (!width || !height) {
    return {
      width: null,
      height: null,
      dimensions: null,
      low: 258,
      high: 1120,
      estimate: 689
    };
  }

  let low;
  let high;
  let estimate;
  if (width <= 384 && height <= 384) {
    low = 258;
    high = 258;
    estimate = 258;
  } else {
    const tiles = Math.ceil(width / 768) * Math.ceil(height / 768);
    const tok = tiles * 258;
    low = tok;
    high = Math.max(tok, 1120);
    estimate = tok;
  }

  return {
    width,
    height,
    dimensions: `${width}×${height}`,
    low,
    high,
    estimate
  };
}

// ============================================================================
// 2. 错误分类与配额池识别（9 类全覆盖）
// ============================================================================

function formatResetTimeZh(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (Number.isNaN(d.getTime())) return String(isoStr);
    const m = d.getMonth() + 1;
    const day = d.getDate();
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${m}月${day}日 ${h}:${min}`;
  } catch {
    return String(isoStr);
  }
}

function resolveModelQuota(modelIdOrName, cascadeModelConfigs) {
  if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
    return null;
  }
  const poolKey = getModelPoolKey(modelIdOrName);
  const targetStr = String(modelIdOrName).toLowerCase();

  let matched = cascadeModelConfigs.find((c) => {
    const mId = String(c?.modelId || '').toLowerCase();
    const lbl = String(c?.label || '').toLowerCase();
    return mId === targetStr || lbl === targetStr;
  });

  if (!matched && poolKey !== 'unknown') {
    matched = cascadeModelConfigs.find((c) => getModelPoolKey(c?.modelId || c?.label) === poolKey);
  }

  if (!matched) return null;
  const qi = matched.quotaInfo || {};
  const poolNames = {
    'gemini-4-argon': 'Gemini 4 Argon 配额池（周限额）',
    'gemini-3.8-flash': 'Gemini 3.8 Flash 配额池',
    'claude-opus-5-5': 'Claude Opus 5.5 配额池',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5 配额池',
    'gpt-oss-120b': 'GPT-OSS 120B 配额池'
  };

  return {
    modelId: matched.modelId || '',
    label: matched.label || modelIdOrName,
    poolKey,
    poolName: poolNames[poolKey] || (matched.label ? `${matched.label} 配额池` : '专属模型配额池'),
    remainingFraction: typeof qi.remainingFraction === 'number' ? qi.remainingFraction : null,
    resetTime: qi.resetTime || null
  };
}

/**
 * 将底层 API/CLI 错误信息分类为结构化诊断对象
 * 覆盖：none, context_overflow, quota_exhausted, rate_limited, auth_error,
 *       service_unavailable, network_error, canceled, unknown
 */
function classifyError(errorStr, currentModel = '', cascadeModelConfigs = []) {
  let modelName = currentModel;
  let configs = cascadeModelConfigs;
  if (currentModel && typeof currentModel === 'object' && !Array.isArray(currentModel)) {
    modelName = currentModel.currentModel || '';
    configs = currentModel.cascadeModelConfigs || [];
  }

  const error = typeof errorStr === 'string'
    ? errorStr.trim()
    : String(errorStr?.error || errorStr?.message || '').trim();
  const modelQuota = resolveModelQuota(modelName, configs);

  if (!error) {
    return {
      kind: 'none',
      title: '正常',
      badgeText: '正常',
      detail: '',
      diagnostic: '',
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: modelQuota?.poolName || modelName || null
    };
  }

  // 脱敏清洗诊断摘要，去掉冗长 URL
  let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
  if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

  // 1. 上下文容量超限（显式排除 Go context.DeadlineExceeded 超时；兼容 Claude "prompt is too long"）
  const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
  const overflowMatch = !isDeadlineTimeout && error.match(
    /input token count exceeds|prompt is too long|prompt.{0,24}(?:too long|exceed)|(?:context|token)\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|max_tokens exceeded|\btokens?\s*>\s*[\d,]+\s*maximum/i
  );
  if (overflowMatch) {
    const rawLimit =
      error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1] ||
      error.match(/>\s*([\d,]+)\s*maximum/i)?.[1];
    const serviceLimit = rawLimit ? toNonNegNumber(rawLimit.replaceAll(',', '')) : null;
    return {
      kind: 'context_overflow',
      title: '超限告警',
      badgeText: '超限',
      detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit} tokens）` : ''}，请精简上下文或新建会话`,
      diagnostic,
      serviceLimit,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: modelName || null
    };
  }

  // 2. 模型或额度池耗尽（兼容 OpenAI/Gemini "exceeded ... quota" 及独立 RESOURCE_EXHAUSTED）
  const isRateHint = /(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError)/i.test(error);
  const explicitQuotaMatch =
    /(?:quota\s*(?:exceeded|reached|limit|exhausted)|exceeded.{0,24}quota|insufficient_quota|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error) ||
    (!isRateHint && /\bRESOURCE_EXHAUSTED\b/i.test(error));
  const quotaZeroEvidence = Boolean(modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001);
  if (explicitQuotaMatch || quotaZeroEvidence) {
    const resetTimeZh = modelQuota?.resetTime ? formatResetTimeZh(modelQuota.resetTime) : null;
    const poolName = modelQuota?.poolName || (modelName ? `${modelName} 专属配额` : '模型配额');
    return {
      kind: 'quota_exhausted',
      title: '额度耗尽',
      badgeText: '额度耗尽',
      detail: `${poolName}额度已用尽${resetTimeZh ? `，预计 ${resetTimeZh} 重置` : ''}。可手动切换其他可用模型`,
      diagnostic,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: modelQuota?.resetTime || null,
      modelOrPool: poolName
    };
  }

  // 3. 请求频率限制 (429)
  if (/(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error)) {
    const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
    const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
    return {
      kind: 'rate_limited',
      title: '请求限流',
      badgeText: '限流',
      detail: `请求过于频繁，触发服务端频率限制（429）${retryAfterSec ? `，建议等待 ${retryAfterSec} 秒后重试` : '，请稍候重试'}`,
      diagnostic,
      serviceLimit: null,
      retryAfterSec,
      resetTime: null,
      modelOrPool: modelName || null
    };
  }

  // 4. 用户或系统主动取消（兼容 gRPC context canceled / cancelled / canceled by user）
  if (/(?:context canceled|cancell?ed\s+by\s+user|user\s+cancell?ed|request\s+(?:was\s+)?(?:aborted|cancell?ed)|operation\s+(?:was\s+)?(?:aborted|cancell?ed)|AbortError|SIGTERM|killed\s+by\s+user)/i.test(error)) {
    return {
      kind: 'canceled',
      title: '已取消',
      badgeText: '已取消',
      detail: '本次生成请求已由用户或系统主动取消',
      diagnostic,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: modelName || null
    };
  }

  // 5. 身份认证与权限异常 (401/403)
  if (/(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied|not logged in|login required)/i.test(error)) {
    return {
      kind: 'auth_error',
      title: '认证异常',
      badgeText: '认证',
      detail: '身份认证失败或缺少访问权限，请检查账号登录状态或订阅权限',
      diagnostic,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: modelName || null
    };
  }

  // 6. 服务暂不可用 (502/503/504)
  if (/(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error)) {
    return {
      kind: 'service_unavailable',
      title: '服务受限',
      badgeText: '服务异常',
      detail: '模型服务暂时过载或不可用，请稍后重试',
      diagnostic,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: modelName || null
    };
  }

  // 7. 网络连接或超时故障
  if (/(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error)) {
    let cleanNet = '连接失败或超时';
    if (/deadline exceeded|timeout/i.test(error)) cleanNet = '连接或读取超时';
    else if (/ECONNRESET|socket hang up/i.test(error)) cleanNet = '连接被对端重置';
    else if (/ECONNREFUSED/i.test(error)) cleanNet = '连接被拒绝';
    else if (/ENOTFOUND|EAI_AGAIN/i.test(error)) cleanNet = 'DNS 域名解析失败';
    else if (/\bEOF\b/i.test(error)) cleanNet = '服务端过早关闭连接 (EOF)';

    return {
      kind: 'network_error',
      title: '网络故障',
      badgeText: '网络',
      detail: `网络连接异常（${cleanNet}），请检查网络代理及本地连接`,
      diagnostic,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: modelName || null
    };
  }

  // 8. 兜底未知异常
  return {
    kind: 'unknown',
    title: '原因待确认',
    badgeText: '待确认',
    detail: `请求失败，当前无法确认具体原因（${diagnostic}）`,
    diagnostic,
    serviceLimit: null,
    retryAfterSec: null,
    resetTime: null,
    modelOrPool: modelName || null
  };
}

// ============================================================================
// 3. 目录解析、日志扫描与单文件缓存
// ============================================================================

function resolveDataDirs(opts = {}) {
  const home = os.homedir();
  const agDir = opts.agDir || process.env.AG_DIR || path.join(home, '.gemini', 'antigravity');
  const agCliDir = opts.agCliDir || process.env.AG_CLI_DIR || path.join(home, '.gemini', 'antigravity-cli');
  return { agDir: path.resolve(agDir), agCliDir: path.resolve(agCliDir) };
}

/**
 * 解析 ~/.gemini/config 目录（支持环境变量 AGY_GEMINI_CONFIG_DIR 与测试隔离）
 */
function resolveGeminiConfigDir(opts = {}) {
  if (opts.geminiConfigDir) return path.resolve(opts.geminiConfigDir);
  if (process.env.AGY_GEMINI_CONFIG_DIR) return path.resolve(process.env.AGY_GEMINI_CONFIG_DIR);
  const rawAgDir = opts.agDir || process.env.AG_DIR;
  if (rawAgDir) {
    return path.join(path.dirname(path.resolve(rawAgDir)), 'config');
  }
  return path.join(os.homedir(), '.gemini', 'config');
}

/**
 * 解析 agy-remote 持久化配置目录（测试环境传自定义 AG_DIR 时自动隔离）
 */
function resolveRemoteConfigDir(opts = {}) {
  const homeGemini = path.resolve(os.homedir(), '.gemini');
  const rawAgDir = opts.agDir || process.env.AG_DIR;
  if (rawAgDir && path.dirname(path.resolve(rawAgDir)) !== homeGemini) {
    return path.join(path.dirname(path.resolve(rawAgDir)), 'agy-remote');
  }
  return path.join(os.homedir(), '.config', 'agy-remote');
}

function resolveProjectsStorePath(opts = {}) {
  if (opts.projectsStore) return path.resolve(opts.projectsStore);
  if (process.env.AGY_PROJECTS_STORE) return path.resolve(process.env.AGY_PROJECTS_STORE);
  return path.join(resolveRemoteConfigDir(opts), 'projects.json');
}

function resolveModelCtxPath(opts = {}) {
  if (opts.modelCtxFile) return path.resolve(opts.modelCtxFile);
  if (process.env.AGY_MODEL_CTX_FILE) return path.resolve(process.env.AGY_MODEL_CTX_FILE);
  return path.join(resolveRemoteConfigDir(opts), 'model-ctx.json');
}

function resolveConversationPrefsPath(opts = {}) {
  if (opts.conversationPrefsStore) return path.resolve(opts.conversationPrefsStore);
  if (process.env.AGY_CONV_PREFS_STORE) return path.resolve(process.env.AGY_CONV_PREFS_STORE);
  return path.join(resolveRemoteConfigDir(opts), 'conversation-prefs.json');
}

/**
 * 读取会话管理偏好配置（重命名 / 置顶 / 未读 / 归档 / 删除）
 */
function readConversationPrefsMap(opts = {}) {
  const filePath = resolveConversationPrefsPath(opts);
  const raw = safeReadJson(filePath);
  const items = (raw && typeof raw.items === 'object' && !Array.isArray(raw.items)) ? raw.items : {};
  return items;
}

/**
 * 更新单条会话的管理状态并原子落盘
 */
function updateConversationPrefs(convId, patch = {}, opts = {}) {
  if (!convId || typeof convId !== 'string' || /[/\\]|\.\.|\0/.test(convId)) {
    throw new Error('非法的会话 ID');
  }
  const filePath = resolveConversationPrefsPath(opts);
  const items = { ...readConversationPrefsMap(opts) };
  const prev = (items[convId] && typeof items[convId] === 'object') ? items[convId] : {};
  const next = { ...prev };

  const titleInput = patch.customTitle !== undefined ? patch.customTitle : patch.title;
  if (titleInput !== undefined) {
    const cleaned = String(titleInput || '').trim().slice(0, 200);
    if (cleaned) {
      next.customTitle = cleaned;
    } else {
      delete next.customTitle;
    }
  }
  if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned;
  if (typeof patch.unread === 'boolean') next.unread = patch.unread;
  if (typeof patch.archived === 'boolean') next.archived = patch.archived;
  if (typeof patch.deleted === 'boolean') {
    next.deleted = patch.deleted;
    if (patch.deleted) {
      next.pinned = false;
      next.unread = false;
      next.archived = false;
    }
  }
  next.updatedAt = new Date().toISOString();

  items[convId] = next;
  atomicWriteJson(filePath, {
    version: 1,
    updatedAt: next.updatedAt,
    items
  });

  return {
    id: convId,
    customTitle: next.customTitle || '',
    pinned: Boolean(next.pinned),
    unread: Boolean(next.unread),
    archived: Boolean(next.archived),
    deleted: Boolean(next.deleted)
  };
}

function deleteConversationPref(convId, opts = {}) {
  return updateConversationPrefs(convId, { deleted: true }, opts);
}

function atomicWriteJson(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // 忽略清理异常
    }
    throw err;
  }
}

/**
 * 读取模型上下文上限覆盖配置 (~/.config/agy-remote/model-ctx.json)
 */
function getModelCtxOverrides(opts = {}) {
  const filePath = resolveModelCtxPath(opts);
  const raw = safeReadJson(filePath);
  const srcOverrides = (raw && typeof raw.overrides === 'object' && !Array.isArray(raw.overrides))
    ? raw.overrides
    : (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.overrides ? raw : {});

  const overrides = {};
  for (const [k, v] of Object.entries(srcOverrides)) {
    if (k === 'updatedAt') continue;
    const num = Number(v);
    if (k.trim() && Number.isInteger(num) && num >= 4096 && num <= 4194304) {
      overrides[k.trim()] = num;
    }
  }
  return {
    ok: true,
    filePath,
    overrides,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null
  };
}

/**
 * 校验并保存模型上下文上限覆盖配置
 */
function saveModelCtxOverrides(input = {}, opts = {}) {
  const filePath = resolveModelCtxPath(opts);
  const current = getModelCtxOverrides(opts).overrides;
  const next = { ...current };

  let updates = {};
  if (input && typeof input.modelId === 'string') {
    updates[input.modelId] = input.limitTokens ?? input.limit ?? null;
  } else if (input && typeof input.overrides === 'object' && !Array.isArray(input.overrides)) {
    updates = input.overrides;
  } else if (input && typeof input === 'object' && !Array.isArray(input)) {
    updates = input;
  } else {
    const err = new Error('无效的 model-ctx 请求体');
    err.statusCode = 400;
    throw err;
  }

  for (const [rawKey, rawVal] of Object.entries(updates)) {
    const key = String(rawKey || '').trim();
    if (!key || key.length > 128 || /[\0\r\n]/.test(key)) {
      const err = new Error(`非法的模型标识: ${rawKey}`);
      err.statusCode = 400;
      throw err;
    }
    if (rawVal === null || rawVal === undefined || rawVal === '' || rawVal === 0) {
      delete next[key];
      continue;
    }
    const num = Number(rawVal);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < 8192 || num > 4194304) {
      const err = new Error(`模型 ${key} 的上下文上限必须为 8,192 ~ 4,194,304 之间的整数`);
      err.statusCode = 400;
      throw err;
    }
    next[key] = num;
  }

  const updatedAt = new Date().toISOString();
  atomicWriteJson(filePath, { overrides: next, updatedAt });
  return { ok: true, filePath, overrides: next, updatedAt };
}

function lookupModelCtxOverride(modelName, overrides = {}) {
  if (!modelName || !overrides || typeof overrides !== 'object') return null;
  if (Number.isInteger(overrides[modelName])) return overrides[modelName];
  const lower = String(modelName).trim().toLowerCase();
  for (const [k, v] of Object.entries(overrides)) {
    if (k.toLowerCase() === lower && Number.isInteger(v)) return v;
  }
  const norm = normalizeModelId(modelName);
  if (norm && Number.isInteger(overrides[norm])) return overrides[norm];
  return null;
}

function safeReadJson(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 读取本地上下文窗口偏好配置（用于无显式 budget 字段时的默认分母参考）
 */
function readContextBudgetHint(agDir, agCliDir) {
  const candidates = [
    path.join(agDir, 'context-mode.json'),
    path.join(os.homedir(), '.local', 'state', 'AntigravityContextMeter', 'context-mode.json')
  ];
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.unshift(path.join(process.env.LOCALAPPDATA, 'AntigravityContextMeter', 'context-mode.json'));
  }

  for (const p of candidates) {
    const data = safeReadJson(p);
    if (!data || typeof data !== 'object') continue;
    const eff = data.effectiveMode || data.mode;
    if ((eff === 'fixed' || eff === '512k') && Number(data.limitTokens || data.limit) > 0) {
      return Number(data.limitTokens || data.limit);
    }
    if (eff === 'dynamic' || eff === '983k') {
      return 983040;
    }
  }

  const cliSettings = safeReadJson(path.join(agCliDir, 'settings.json'));
  if (cliSettings && typeof cliSettings.contextWindow === 'string') {
    const m = cliSettings.contextWindow.trim().toUpperCase().match(/^(\d+)K$/);
    if (m) return Number(m[1]) * 1000;
  }
  return null;
}

/**
 * 解析 .pbtxt 标注文件中的会话标题，兼容转义引号与八进制 UTF-8 序列
 */
function readAnnotationTitle(baseDir, convId) {
  const annPath = path.join(baseDir, 'annotations', `${convId}.pbtxt`);
  try {
    if (!fs.existsSync(annPath)) return { title: null, mtimeMs: 0 };
    const st = fs.statSync(annPath);
    const content = fs.readFileSync(annPath, 'utf8');
    const m = content.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return { title: null, mtimeMs: st.mtimeMs };

    const raw = m[1];
    // 先把八进制转义（如 \344\270\255）还原为字节后按 UTF-8 解码，再处理常规转义符
    const byteArr = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        if (/^[0-7]{3}$/.test(raw.slice(i + 1, i + 4))) {
          byteArr.push(parseInt(raw.slice(i + 1, i + 4), 8));
          i += 3;
          continue;
        }
        const esc = raw[i + 1];
        const escMap = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };
        const rep = escMap[esc] || esc;
        for (const b of Buffer.from(rep, 'utf8')) byteArr.push(b);
        i += 1;
        continue;
      }
      const ch = raw.codePointAt(i);
      const sCh = String.fromCodePoint(ch);
      for (const b of Buffer.from(sCh, 'utf8')) byteArr.push(b);
      if (ch > 0xffff) i++;
    }
    const decoded = Buffer.from(byteArr).toString('utf8').trim();
    return { title: decoded || null, mtimeMs: st.mtimeMs };
  } catch {
    return { title: null, mtimeMs: 0 };
  }
}

/**
 * 递归发现 brain/<id>/.system_generated/logs/transcript.jsonl 或直属 transcript.jsonl
 */
function discoverTranscriptFiles(brainDir, sourceName) {
  const jobs = [];
  const visitedRealDirs = new Set();

  function walk(dir, depth, currentConvId) {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const realDir = fs.realpathSync(dir);
      if (visitedRealDirs.has(realDir)) return;
      visitedRealDirs.add(realDir);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(fullPath);
            const st = fs.statSync(realTarget);
            if (st.isDirectory()) {
              walk(realTarget, depth + 1, depth === 0 ? entry.name : currentConvId);
            } else if (entry.name === 'transcript.jsonl') {
              jobs.push({ path: realTarget, source: sourceName, convId: currentConvId || path.basename(dir) });
            }
          } catch {
            // 忽略失效软链接
          }
          continue;
        }

        if (entry.isDirectory()) {
          const nextId = depth === 0 ? entry.name : currentConvId;
          if (depth === 0) {
            const stdLogPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLogPath = path.join(fullPath, 'transcript.jsonl');
            let matched = false;
            if (fs.existsSync(stdLogPath)) {
              jobs.push({ path: stdLogPath, source: sourceName, convId: nextId });
              matched = true;
            }
            if (fs.existsSync(directLogPath)) {
              jobs.push({ path: directLogPath, source: sourceName, convId: nextId });
              matched = true;
            }
            if (matched) continue;
          }
          walk(fullPath, depth + 1, nextId);
        } else if (entry.name === 'transcript.jsonl') {
          jobs.push({ path: fullPath, source: sourceName, convId: currentConvId || path.basename(dir) });
        }
      }
    } catch {
      // 权限不足或并发删除目录时安全跳过
    }
  }

  walk(brainDir, 0, null);
  return jobs;
}

/**
 * 统计 conversations 目录中的 .pb / .db 会话文件数量与最早时间
 */
function scanSessionDbDir(dir) {
  let count = 0;
  let earliestDate = null;
  try {
    if (!fs.existsSync(dir)) return { count: 0, earliestDate: null };
    for (const name of fs.readdirSync(dir)) {
      const lower = name.toLowerCase();
      if (lower.endsWith('-wal') || lower.endsWith('-shm') || lower.endsWith('-journal') || lower.endsWith('.tmp') || lower.endsWith('.lock') || lower.endsWith('.bak')) {
        continue;
      }
      if (!lower.endsWith('.pb') && !lower.endsWith('.db')) continue;
      try {
        const st = fs.statSync(path.join(dir, name));
        if (st.isFile()) {
          count++;
          const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
          if (ts > 946684800000) {
            const dk = formatLocalDateKey(new Date(ts));
            if (!earliestDate || dk < earliestDate) earliestDate = dk;
          }
        }
      } catch {
        // 忽略瞬时读写冲突
      }
    }
  } catch {
    // 目录不可访问时返回 0
  }
  return { count, earliestDate };
}

// ============================================================================
// 4. Transcript 事件解析、工作区与媒体提取
// ============================================================================

function cleanUserPromptText(rawText) {
  if (!rawText) return '';
  let text = String(rawText);
  const reqMatch = text.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (reqMatch) {
    text = reqMatch[1];
  } else {
    text = text
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  }
  return text.trim();
}

function extractModelFromUserSettings(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const m = rawText.match(/changed setting\s+`?Model Selection`?\s+from\s+.+?\s+to\s+([^.\r\n<]+(?:\([^)]+\))?)/i);
  return m && m[1] ? m[1].trim() : null;
}

function unquoteArgString(val) {
  if (typeof val !== 'string') return '';
  let s = val.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed;
    } catch {
      s = s.slice(1, -1);
    }
  }
  return s.trim();
}

function normalizeWorkspaceDisplay(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  let s = rawPath.trim();
  if (!s) return null;
  if (/^file:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      let p = decodeURIComponent(u.pathname || '');
      // Windows file:///C:/... 去掉前导 '/'，而 file:///home/... 保留 POSIX 绝对路径
      if (/^\/[a-zA-Z]:/.test(p)) {
        p = p.slice(1).replace(/\//g, '\\');
      }
      s = p;
    } catch {
      try {
        s = fileURLToPath(s);
      } catch {
        return null;
      }
    }
  }
  if (s.length > 1 && !/^[a-zA-Z]:[\\/]?$/.test(s)) {
    s = s.replace(/[\\/]+$/, '');
  }
  return s || null;
}

function workspaceCompareKey(rawPath) {
  const disp = normalizeWorkspaceDisplay(rawPath);
  if (!disp) return '';
  const unified = disp.replace(/\\/g, '/');
  return /^[a-zA-Z]:/.test(unified) ? unified.toLowerCase() : unified;
}

function extractPathBaseName(rawPath) {
  const disp = normalizeWorkspaceDisplay(rawPath);
  if (!disp) return '';
  const parts = disp.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : disp;
}

function extractWorkspaceFromUri(uriStr) {
  if (!uriStr || typeof uriStr !== 'string') return null;
  const trimmed = uriStr.trim();
  if (trimmed.startsWith('file://')) return normalizeWorkspaceDisplay(trimmed);
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/')) {
    return normalizeWorkspaceDisplay(trimmed);
  }
  return null;
}

function normalizeCandidateWorkspace(rawPath) {
  const s = unquoteArgString(rawPath);
  if (!s || s.length < 2) return null;
  if (/^file:\/\//i.test(s)) return extractWorkspaceFromUri(s);
  if (path.isAbsolute(s) || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('/')) {
    return normalizeWorkspaceDisplay(s);
  }
  return null;
}

function extractWorkspaceFromEvent(ev) {
  const direct = ev.workspace || ev.workspacePath || ev.cwd || ev.metadata?.workspace;
  if (typeof direct === 'string' && direct.trim()) {
    return normalizeCandidateWorkspace(direct);
  }

  const wsList = ev.metadata?.workspaces;
  if (Array.isArray(wsList)) {
    for (const w of wsList) {
      const u = w?.workspaceFolderAbsoluteUri || w?.gitRootAbsoluteUri;
      const resolved = extractWorkspaceFromUri(u);
      if (resolved) return resolved;
    }
  }

  const textBlob = [ev.content, ev.userInput?.userResponse, ev.plannerResponse?.response].filter(Boolean).join('\n');
  if (textBlob) {
    const m1 = textBlob.match(/Command Working Directory:\s*([^\r\n"]+)/i);
    if (m1?.[1]) return normalizeCandidateWorkspace(m1[1]);
    const m2 = textBlob.match(/Active Workspaces:\s*(?:\r?\n|\\n)\s*-\s*([^\r\n"]+)/i);
    if (m2?.[1]) return normalizeCandidateWorkspace(m2[1]);
  }

  // 从工具调用参数中识别工作区目录（跳过 .gemini/antigravity 内部日志路径）
  const calls = Array.isArray(ev.tool_calls) ? ev.tool_calls : (Array.isArray(ev.plannerResponse?.toolCalls) ? ev.plannerResponse.toolCalls : []);
  for (const tc of calls) {
    const args = tc?.args || tc?.arguments || {};
    if (!args || typeof args !== 'object') continue;
    const dirCand = args.Cwd || args.cwd || args.WorkingDirectory || args.DirectoryPath || args.SearchPath || args.TargetDir;
    if (dirCand) {
      const norm = normalizeCandidateWorkspace(String(dirCand));
      if (norm && !norm.includes('.gemini')) return norm;
    }
    const fileCand = args.Path || args.TargetFile || args.AbsolutePath || args.file;
    if (fileCand) {
      const norm = normalizeCandidateWorkspace(String(fileCand));
      if (norm && !norm.includes('.gemini')) {
        return path.dirname(norm);
      }
    }
  }
  return null;
}

function serializeGenericContent(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (!value) return '';
  if (Array.isArray(value)) return value.map(serializeGenericContent).join('\n');
  const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);
  return Object.entries(value)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => `${k}: ${serializeGenericContent(v)}`)
    .join('\n');
}

function extractMediaFromEvent(ev, source, mediaMap) {
  const candidates = [];
  if (Array.isArray(ev.media)) candidates.push(...ev.media);
  if (Array.isArray(ev.plannerResponse?.media)) candidates.push(...ev.plannerResponse.media);
  if (Array.isArray(ev.userInput?.media)) candidates.push(...ev.userInput.media);
  if (Array.isArray(ev.userInput?.items)) {
    for (const item of ev.userInput.items) {
      if (item && (item.uri || item.inlineData)) candidates.push(item);
    }
  }
  if (Array.isArray(ev.attachments)) candidates.push(...ev.attachments);
  if (Array.isArray(ev.plannerResponse?.attachments)) candidates.push(...ev.plannerResponse.attachments);

  // 从正文中自动探测图片路径（例如 [附件图片: /home/.../xxx.jpg] 或 存储路径: /home/.../xxx.png）
  const textBody = String(
    ev.content || ev.text || ev.plannerResponse?.response || ev.plannerResponse?.modifiedResponse || ev.userInput?.userResponse || ''
  );
  if (textBody) {
    const pathRegex = /(?:\[附件图片:\s*|(?:存储|落盘|生成|输出)?路径[:：]\s*|!\[.*?\]\()([^\s\r\n)\]'"]+?\.(?:png|jpe?g|gif|webp|bmp|svg))/gi;
    let pMatch;
    while ((pMatch = pathRegex.exec(textBody)) !== null) {
      const rawP = pMatch[1].trim();
      if (rawP.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(rawP) || rawP.startsWith('file://')) {
        candidates.push({
          uri: rawP,
          path: rawP.startsWith('file://') ? normalizeWorkspaceDisplay(rawP) : rawP,
          name: rawP.split(/[\\/]/).pop() || '图片'
        });
      }
    }
  }

  const stepMedia = [];
  for (const m of candidates) {
    if (!m || typeof m !== 'object') continue;
    const mime = String(m.mime_type || m.mimeType || m.mime || '').trim();
    const uri = m.uri || m.path || (m.inlineData ? `inline:${mediaMap.size}` : null);
    if (!uri) continue;

    const key = String(uri);
    const name = String(m.name || m.description || key.split(/[\\/]/).pop() || '附件');
    let entry = mediaMap.get(key);
    if (!entry) {
      entry = {
        uri: key,
        path: key.startsWith('file://') ? extractWorkspaceFromUri(key) : (path.isAbsolute(key) ? key : null),
        name,
        mime,
        inlineData: typeof m.inlineData === 'string' ? m.inlineData : (m.inlineData?.data || null),
        width: toNonNegNumber(m.width),
        height: toNonNegNumber(m.height),
        dimensions: m.dimensions || null,
        bytes: toNonNegNumber(m.bytes),
        low: toNonNegNumber(m.low),
        high: toNonNegNumber(m.high),
        estimate: toNonNegNumber(m.estimate ?? m.tokens),
        references: 1,
        source
      };
      mediaMap.set(key, entry);
    } else {
      entry.references += 1;
    }
    stepMedia.push(entry);
  }
  return stepMedia;
}

/**
 * 对单条媒体项执行本机文件/内嵌数据审计（尺寸、字节数与 Token 估算）
 */
function auditMediaEntry(item) {
  const out = {
    name: item.name,
    uri: item.uri,
    path: item.path,
    mime: item.mime || '',
    width: item.width ?? null,
    height: item.height ?? null,
    dimensions: item.dimensions || (item.width && item.height ? `${item.width}×${item.height}` : null),
    bytes: item.bytes ?? null,
    low: item.low ?? 0,
    high: item.high ?? 0,
    estimate: item.estimate ?? 0,
    references: item.references || 1,
    source: item.source || 'user',
    status: 'parsed'
  };

  try {
    let buf = null;
    if (item.inlineData) {
      buf = Buffer.from(item.inlineData, 'base64');
    } else if (item.path && fs.existsSync(item.path)) {
      const st = fs.statSync(item.path);
      if (st.isFile()) {
        out.bytes = st.size;
        if (st.size <= 25 * 1024 * 1024) {
          buf = fs.readFileSync(item.path);
        }
      }
    }

    if (buf) {
      out.bytes = buf.length;
      const lowerMime = out.mime.toLowerCase();
      const lowerName = (out.name || '').toLowerCase();
      const isImage = lowerMime.startsWith('image/') || /\.(png|jpe?g|gif|bmp|webp)$/i.test(lowerName);
      if (isImage) {
        const imgInfo = inspectImageBuffer(buf);
        out.width = imgInfo.width;
        out.height = imgInfo.height;
        out.dimensions = imgInfo.dimensions;
        out.low = imgInfo.low;
        out.high = imgInfo.high;
        out.estimate = imgInfo.estimate;
      } else if (lowerMime.startsWith('text/') || /\.(txt|md|json|js|ts|py|csv|log|yml|yaml|sh)$/i.test(lowerName)) {
        const tm = measureText(buf.toString('utf8'));
        out.low = tm.low;
        out.high = tm.high;
        out.estimate = tm.estimate;
      } else {
        const est = Math.ceil(buf.length / 4);
        out.low = Math.ceil(est * 0.7);
        out.high = Math.ceil(est * 1.4);
        out.estimate = est;
      }
    } else if (!out.estimate && !out.bytes) {
      out.status = 'missing';
    }
  } catch {
    out.status = 'unknown';
  }
  return out;
}

/**
 * 解析单份 transcript.jsonl 并缓存结果，输出消息序列、5 维分组、媒体审计与最新上下文快照
 */
function parseTranscriptFile(fileInfo, opts = {}) {
  const { path: filePath, source, convId } = fileInfo;
  const baseDir = source === 'cli' ? opts.agCliDir : opts.agDir;
  const st = fs.statSync(filePath);
  const ann = baseDir ? readAnnotationTitle(baseDir, convId) : { title: null, mtimeMs: 0 };

  const cached = transcriptParseCache.get(filePath);
  if (!opts.force && cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs && cached.annMtimeMs === ann.mtimeMs) {
    return cached.data;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split(/\r?\n/);

  const groups = {
    user: emptyMeasure(),
    assistant: emptyMeasure(),
    thinking: emptyMeasure(),
    tools: emptyMeasure(),
    summaries: emptyMeasure()
  };
  const mediaMap = new Map();
  const messages = [];
  const tokenEvents = [];

  let explicitTitle = null;
  let firstUserPrompt = null;
  let firstSystemBrief = null;
  let firstAssistantText = null;
  let workspace = null;
  let currentModel = '';
  let earliestMs = null;
  let latestMs = null;
  let stepCount = 0;

  // 上下文与速度跟踪变量
  let lastValidUsage = null;
  let lastExplicitEstimate = null;
  let lastExplicitBudget = null;
  let lastSpeed = null;
  let lastUserAt = -1;
  let lastUserTsMs = 0;
  let lastAssistantAt = -1;
  let latestStepError = null;
  let lastAssistantHasError = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== 'object') continue;
    stepCount++;

    const tsMs = parseIsoTimestampMs(ev.created_at || ev.createdAt || ev.timestamp);
    if (tsMs) {
      if (!earliestMs || tsMs < earliestMs) earliestMs = tsMs;
      if (!latestMs || tsMs > latestMs) latestMs = tsMs;
    }

    if (!explicitTitle && typeof (ev.title || ev.sessionTitle) === 'string' && (ev.title || ev.sessionTitle).trim()) {
      explicitTitle = (ev.title || ev.sessionTitle).trim();
    }

    // 模型名称探测
    const cm = ev.chatModel || {};
    const stepModel = cm.modelDisplayName || cm.responseModel || cm.model || ev.modelDisplayName || ev.responseModel || ev.model || ev.modelId || '';
    if (stepModel && typeof stepModel === 'string') {
      currentModel = stepModel.trim();
    }
    if (typeof ev.content === 'string') {
      const fromSettings = extractModelFromUserSettings(ev.content);
      if (fromSettings) currentModel = fromSettings;
    }

    if (!workspace) {
      const ws = extractWorkspaceFromEvent(ev);
      if (ws) workspace = ws;
    }

    const stepMedia = extractMediaFromEvent(ev, source, mediaMap);
    const createdAtIso = tsMs ? new Date(tsMs).toISOString() : null;
    const dateKey = tsMs ? formatLocalDateKey(new Date(tsMs)) : formatLocalDateKey(st.mtime);

    // 区分步骤类型（兼容 Antigravity 原生格式、Trajectory 格式与通用 role 格式）
    const isUser = ev.type === 'USER_INPUT' || Boolean(ev.userInput) || ev.role === 'user';
    const isAssistant = ev.type === 'PLANNER_RESPONSE' || Boolean(ev.plannerResponse) || ev.role === 'assistant';
    const isError = ev.type === 'ERROR_MESSAGE' || Boolean(ev.errorMessage);
    const isCheckpoint = ev.type === 'CHECKPOINT' || Boolean(ev.checkpoint);
    const isSystem = ev.type === 'SYSTEM_MESSAGE' || ev.role === 'system';

    if (isUser) {
      lastUserAt = i;
      if (tsMs) lastUserTsMs = tsMs;
      const rawUserText = ev.userInput
        ? (ev.userInput.userResponse || (ev.userInput.items || []).map((it) => it.text || '').join('\n'))
        : (ev.content || ev.text || '');
      const cleaned = cleanUserPromptText(rawUserText);
      if (!firstUserPrompt && cleaned) firstUserPrompt = cleaned;
      addMeasure(groups.user, measureText(cleaned));
      messages.push({
        index: ev.step_index ?? i,
        role: 'user',
        type: 'USER_INPUT',
        text: cleaned,
        content: cleaned,
        media: stepMedia.map((m) => ({ name: m.name, uri: m.uri, path: m.path, mime: m.mime })),
        timestamp: tsMs,
        createdAt: createdAtIso
      });
      continue;
    }

    if (isAssistant) {
      lastAssistantAt = i;
      const pr = ev.plannerResponse || {};
      const assistantText = String(pr.modifiedResponse || pr.response || ev.content || ev.text || '');
      const thinkingText = String(pr.thinking || ev.thinking || '');
      const rawToolCalls = Array.isArray(ev.tool_calls) ? ev.tool_calls : (Array.isArray(pr.toolCalls) ? pr.toolCalls : []);
      const toolCalls = rawToolCalls.map((tc) => ({
        name: String(tc?.name || tc?.tool || 'tool'),
        args: tc?.args ?? tc?.arguments ?? {}
      }));

      if (!firstAssistantText && assistantText.trim()) firstAssistantText = assistantText.trim();
      addMeasure(groups.assistant, measureText(assistantText));
      addMeasure(groups.thinking, measureText(thinkingText));
      if (toolCalls.length > 0) {
        addMeasure(groups.tools, measureText(JSON.stringify(toolCalls)));
      }

      // 提取 Token 用量（兼容多种 Antigravity / Gemini / OpenAI 字段格式）
      const u = cm.usage || ev.usage || {};
      const inputTokens = toNonNegNumber(
        ev.input_tokens ?? u.inputTokens ?? u.input_tokens ?? ev.inputTokens ?? u.promptTokens ?? u.prompt_tokens ?? u.promptTokenCount
      ) ?? 0;
      const cacheReadTokens = toNonNegNumber(
        ev.cache_read_tokens ?? u.cacheReadTokens ?? u.cache_read_tokens ?? ev.cacheTokens ?? u.cachedTokens ?? u.cached_content_token_count
      ) ?? 0;
      const outputTokens = toNonNegNumber(
        ev.output_tokens ?? u.outputTokens ?? u.output_tokens ?? ev.outputTokens ?? u.completionTokens ?? u.completion_tokens ?? u.candidatesTokenCount
      ) ?? 0;
      const thinkingTokens = toNonNegNumber(
        ev.thinking_output_tokens ?? u.thinkingOutputTokens ?? u.thinking_output_tokens ?? ev.thinkingTokens ?? u.thoughtsTokenCount
      ) ?? 0;

      const lastRetry = Array.isArray(cm.retryInfos) ? cm.retryInfos.at(-1) : null;
      const stepErr = String(lastRetry?.error || cm.error || ev.error || '').trim();
      if (stepErr) {
        lastAssistantHasError = { index: i, text: stepErr };
      } else {
        lastAssistantHasError = null;
      }

      // 提取显式上下文窗口预算与估算
      const cwMeta = cm.chatStartMetadata?.contextWindowMetadata || ev.contextWindowMetadata || {};
      const estUsed = toNonNegNumber(cwMeta.estimatedTokensUsed ?? ev.estimatedTokensUsed);
      const maxCtx = toNonNegNumber(cwMeta.maxContextTokens ?? ev.maxContextTokens ?? ev.budget);
      if (estUsed !== null) lastExplicitEstimate = estUsed;
      if (maxCtx !== null && maxCtx > 0) lastExplicitBudget = maxCtx;

      // 提取速度指标（支持相邻步时间差作为耗时兜底）
      const ttft = parseDurationSec(cm.timeToFirstToken ?? ev.ttftSec ?? ev.ttft);
      const streamingSec = parseDurationSec(cm.streamingDuration ?? ev.streamingSec);
      let duration = toNonNegNumber(ev.durationSec ?? ev.duration);
      if (duration === null && (ttft !== null || streamingSec !== null)) {
        duration = (ttft !== null && streamingSec !== null) ? ttft + streamingSec : (ttft ?? streamingSec);
      }
      if (duration === null && typeof lastUserTsMs === 'number' && lastUserTsMs > 0 && tsMs && tsMs > lastUserTsMs) {
        const diffSec = (tsMs - lastUserTsMs) / 1000;
        if (diffSec >= 0.05 && diffSec <= 3600) {
          duration = Number(diffSec.toFixed(2));
        }
      }
      let tps = toNonNegNumber(ev.tps);
      if (tps === null && outputTokens > 0 && duration && duration > 0) {
        tps = Number((outputTokens / duration).toFixed(1));
      }
      if (duration === null && outputTokens > 0 && tps && tps > 0) {
        duration = Number((outputTokens / tps).toFixed(2));
      }
      const streamingTps = (outputTokens > 0 && streamingSec && streamingSec > 0.05)
        ? Number((outputTokens / streamingSec).toFixed(1))
        : null;

      const stepSpeed = (tps !== null || duration !== null || ttft !== null)
        ? {
            tps,
            streamingTps,
            duration: duration !== null ? Number(duration.toFixed(2)) : null,
            ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
            streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
            outputTokens,
            thinkingTokens,
            responseTokens: Math.max(0, outputTokens - thinkingTokens)
          }
        : null;
      if (stepSpeed) lastSpeed = stepSpeed;

      const hasInput = inputTokens + cacheReadTokens > 0;
      if (hasInput && !stepErr) {
        lastValidUsage = {
          input: inputTokens + cacheReadTokens,
          cached: cacheReadTokens,
          output: outputTokens,
          actual: inputTokens + cacheReadTokens + outputTokens
        };
      }

      const tot = inputTokens + cacheReadTokens + outputTokens;
      if (tot > 0) {
        const callId = String(
          ev.callId || ev.responseId || u.responseId || u.messageId || `${filePath}#${ev.step_index ?? i}`
        );
        tokenEvents.push({
          callId,
          source,
          cascadeId: ev.cascadeId || convId,
          model: stepModel || currentModel || '',
          effort: cm.effort || ev.effort || null,
          channel: 'chat',
          inputTokens,
          cacheReadTokens,
          cacheTokens: cacheReadTokens,
          outputTokens,
          thinkingTokens,
          totalTokens: tot,
          date: dateKey,
          created_at: createdAtIso,
          timestamp: tsMs || st.mtimeMs,
          ttftSec: stepSpeed?.ttft ?? null,
          streamingSec: stepSpeed?.streamingSec ?? null,
          durationSec: stepSpeed?.duration ?? null,
          tps: stepSpeed?.tps ?? null,
          status: stepErr ? 'error' : 'final',
          isEstimated: false
        });
      }

      messages.push({
        index: ev.step_index ?? i,
        role: 'assistant',
        type: 'PLANNER_RESPONSE',
        text: assistantText,
        content: assistantText,
        thinking: thinkingText,
        toolCalls,
        media: stepMedia.map((m) => ({ name: m.name, uri: m.uri, path: m.path, mime: m.mime })),
        usage: tot > 0 ? { inputTokens, cacheReadTokens, outputTokens, thinkingTokens, totalTokens: tot } : null,
        speed: stepSpeed,
        model: stepModel || currentModel || null,
        status: ev.status || 'DONE',
        error: stepErr || null,
        timestamp: tsMs,
        createdAt: createdAtIso
      });
      continue;
    }

    if (isError) {
      const eObj = ev.errorMessage?.error || {};
      const errText = String(ev.error || eObj.modelErrorMessage || eObj.shortError || eObj.fullError || ev.content || '').trim();
      latestStepError = { index: i, text: errText };
      messages.push({
        index: ev.step_index ?? i,
        role: 'error',
        type: 'ERROR_MESSAGE',
        text: errText,
        error: errText,
        timestamp: tsMs,
        createdAt: createdAtIso
      });
      continue;
    }

    if (isCheckpoint) {
      const summaryText = String(ev.content || ev.checkpoint?.sessionSummary || '');
      addMeasure(groups.summaries, measureText(summaryText));
      const inp = toNonNegNumber(ev.input_tokens) ?? 0;
      const cap = toNonNegNumber(ev.cache_read_tokens) ?? 0;
      const outp = toNonNegNumber(ev.output_tokens) ?? 0;
      const tot = inp + cap + outp;
      if (tot > 0) {
        tokenEvents.push({
          callId: String(ev.callId || `${filePath}#${ev.step_index ?? i}`),
          source,
          cascadeId: ev.cascadeId || convId,
          model: currentModel || '',
          channel: 'checkpoint',
          inputTokens: inp,
          cacheReadTokens: cap,
          cacheTokens: cap,
          outputTokens: outp,
          thinkingTokens: 0,
          totalTokens: tot,
          date: dateKey,
          created_at: createdAtIso,
          timestamp: tsMs || st.mtimeMs,
          status: 'final',
          isEstimated: false
        });
      }
      messages.push({
        index: ev.step_index ?? i,
        role: 'system',
        type: 'CHECKPOINT',
        text: summaryText,
        content: summaryText,
        usage: tot > 0 ? { inputTokens: inp, cacheReadTokens: cap, outputTokens: outp, totalTokens: tot } : null,
        timestamp: tsMs,
        createdAt: createdAtIso
      });
      continue;
    }

    // GENERIC 工具执行回显或 SYSTEM_MESSAGE
    const rawStr = typeof ev.content === 'string' ? ev.content : serializeGenericContent(ev);
    addMeasure(groups.tools, measureText(rawStr));

    if (isSystem && !firstSystemBrief) {
      const mAssign = rawStr.match(/You have just started\.[\s\S]*?:\s*\n+([^\n]+)/i);
      firstSystemBrief = (mAssign ? mAssign[1] : rawStr).trim();
    } else if (!isSystem && rawStr && messages.length > 0) {
      // 将 GENERIC 工具输出关联到紧邻的上一条助手 toolCalls，避免长输出刷屏
      const prev = messages[messages.length - 1];
      if (prev && prev.role === 'assistant' && Array.isArray(prev.toolCalls) && prev.toolCalls.length > 0) {
        const targetTc = prev.toolCalls.find((tc) => tc.result === undefined);
        if (targetTc) {
          targetTc.result = rawStr.length > 1500 ? `${rawStr.slice(0, 1497)}...` : rawStr;
        }
      }
    }
  }

  // 审计媒体附件并汇总总估算 Token
  const auditedMedia = [...mediaMap.values()].map(auditMediaEntry);
  const mediaEstimateTotal = emptyMeasure();
  for (const m of auditedMedia) {
    const n = m.references || 1;
    mediaEstimateTotal.bytes += (m.bytes || 0) * n;
    mediaEstimateTotal.low += (m.low || 0) * n;
    mediaEstimateTotal.high += (m.high || 0) * n;
    mediaEstimateTotal.estimate += (m.estimate || 0) * n;
  }

  const total = emptyMeasure();
  for (const g of Object.values(groups)) addMeasure(total, g);
  addMeasure(total, mediaEstimateTotal);

  const createdAt = new Date(earliestMs || st.birthtimeMs || st.mtimeMs).toISOString();
  const updatedAt = new Date(latestMs || st.mtimeMs).toISOString();
  const rawTitle = ann.title || explicitTitle || firstUserPrompt || firstSystemBrief || firstAssistantText || `会话 ${convId.slice(0, 8)}`;
  // 清洗标题中的冗长附件前缀，如将 [附件图片: ... - 请调用 read_file 查看该文件] 净化为 [图片]
  const cleanedTitle = String(rawTitle)
    .replace(/\[附件图片:[^\]]+\]\s*/gi, '[图片] ')
    .replace(/\s+/g, ' ')
    .trim();
  const compactTitle = cleanedTitle || `会话 ${convId.slice(0, 8)}`;
  const title = compactTitle.length > 80 ? `${compactTitle.slice(0, 77)}...` : compactTitle;

  const activeError = (latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt))
    ? latestStepError
    : lastAssistantHasError;

  const parsed = {
    id: convId,
    source,
    filePath,
    title,
    workspace: workspace || null,
    createdAt,
    updatedAt,
    updatedAtMs: latestMs || st.mtimeMs,
    model: currentModel || null,
    stepCount,
    messages,
    groups,
    total,
    media: auditedMedia,
    tokenEvents,
    contextSignals: {
      lastValidUsage,
      lastExplicitEstimate,
      lastExplicitBudget,
      lastSpeed,
      activeErrorText: activeError?.text || ''
    }
  };

  if (transcriptParseCache.size >= 1000) {
    const oldestKey = transcriptParseCache.keys().next().value;
    if (oldestKey) transcriptParseCache.delete(oldestKey);
  }
  transcriptParseCache.set(filePath, {
    size: st.size,
    mtimeMs: st.mtimeMs,
    annMtimeMs: ann.mtimeMs,
    data: parsed
  });

  return parsed;
}

// ============================================================================
// 5. 账本读取与会话最新上下文合成
// ============================================================================

function loadPricingLedgerSafe(dir) {
  const p = path.join(dir, 'pricing_ledger_v1.json');
  const data = safeReadJson(p);
  if (!data || typeof data !== 'object' || !data.calls || typeof data.calls !== 'object') {
    return [];
  }
  return Object.values(data.calls).filter((c) => c && typeof c === 'object');
}

function isLedgerCallSynthetic(call) {
  const sId = String(call?.callId || '').toLowerCase();
  const cId = String(call?.cascadeId || '').toLowerCase();
  return (
    sId.startsWith('test_') ||
    sId.startsWith('fixture_') ||
    sId.startsWith('synthetic_') ||
    sId.includes('desktop_response_001') ||
    cId.includes('verify') ||
    cId.includes('mock')
  );
}

/**
 * 合成会话的 latestContext 状态（融合 transcript 实测/估算与账本中的模型/速度记录）
 */
function buildLatestContext(parsed, ledgerCallsForConv, budgetHint, cascadeConfigs = [], modelCtxOverrides = {}) {
  const sig = parsed.contextSignals || {};
  const ledgerLatest = ledgerCallsForConv?.length
    ? ledgerCallsForConv.reduce((best, cur) => ((cur.timestamp || 0) >= (best.timestamp || 0) ? cur : best), ledgerCallsForConv[0])
    : null;

  const model = parsed.model || ledgerLatest?.modelLabel || ledgerLatest?.model || null;
  const errorClassification = classifyError(sig.activeErrorText, model || '', cascadeConfigs);

  const actual = sig.lastValidUsage ? sig.lastValidUsage.actual : null;
  const estimate = sig.lastExplicitEstimate ?? (parsed.total?.estimate || 0);
  const used = actual !== null ? actual : (estimate > 0 ? estimate : 0);

  const overrideBudget = lookupModelCtxOverride(model, modelCtxOverrides);
  let budget = sig.lastExplicitBudget || errorClassification.serviceLimit || overrideBudget || budgetHint || DEFAULT_CHECKPOINT_TOKENS;
  // 若实际上下文已突破默认 256K，说明宿主机已解锁，按模型物理上限或实测值兜底分母
  if (!sig.lastExplicitBudget && !overrideBudget && actual !== null && actual > budget) {
    budget = actual <= 983040 ? 983040 : Math.max(1000000, actual);
  }

  let speed = sig.lastSpeed;
  if (!speed && ledgerLatest && (ledgerLatest.tps || ledgerLatest.durationSec)) {
    speed = {
      tps: ledgerLatest.tps ?? null,
      streamingTps: null,
      duration: ledgerLatest.durationSec ?? null,
      ttft: ledgerLatest.ttftSec ?? null,
      streamingSec: ledgerLatest.streamingSec ?? null,
      outputTokens: ledgerLatest.outputTokens ?? 0,
      thinkingTokens: ledgerLatest.thinkingTokens ?? 0,
      responseTokens: ledgerLatest.responseTokens ?? 0
    };
  }

  let status = 'estimated';
  if (errorClassification.kind !== 'none') {
    status = errorClassification.kind === 'context_overflow' ? 'exceeded' : errorClassification.kind;
  } else if (actual !== null) {
    status = 'reported';
  }

  const percent = (used !== null && budget > 0)
    ? Number(Math.min(999, (used / budget) * 100).toFixed(1))
    : null;

  return {
    used,
    actual,
    estimate,
    budget,
    percent,
    model,
    status,
    speed: speed || null,
    errorClassification,
    input: sig.lastValidUsage?.input ?? null,
    cached: sig.lastValidUsage?.cached ?? 0,
    output: sig.lastValidUsage?.output ?? null
  };
}

// ============================================================================
// 6. 公开接口：会话列表、会话详情与 Token 历史看板
// ============================================================================

function collectAllTranscriptJobs(agDir, agCliDir) {
  const jobs = [];
  const deskBrain = path.join(agDir, 'brain');
  const cliBrain = path.join(agCliDir, 'brain');
  if (fs.existsSync(deskBrain)) jobs.push(...discoverTranscriptFiles(deskBrain, 'desktop'));
  if (fs.existsSync(cliBrain)) jobs.push(...discoverTranscriptFiles(cliBrain, 'cli'));
  return jobs;
}

/**
 * 从单个 metadata 对象提取项目 ID、工作区路径与标题
 */
function parseMetadataSummaryObj(meta) {
  if (!meta || typeof meta !== 'object') {
    return { projectId: null, workspacePath: null, title: null };
  }
  const rawProjectId = meta.ProjectID || meta.projectId || meta.project_id || '';
  const projectId = typeof rawProjectId === 'string' && rawProjectId.trim() ? rawProjectId.trim() : null;

  let workspacePath = null;
  const uriList = meta.WorkspaceURIs || meta.workspaceUris || meta.workspaceURIs;
  if (Array.isArray(uriList)) {
    for (const u of uriList) {
      const resolved = extractWorkspaceFromUri(String(u || ''));
      if (resolved) {
        workspacePath = resolved;
        break;
      }
    }
  }
  if (!workspacePath) {
    const directWs = meta.workspacePath || meta.workspace || meta.cwd;
    if (typeof directWs === 'string' && directWs.trim()) {
      workspacePath = normalizeCandidateWorkspace(directWs);
    }
  }

  return {
    projectId,
    workspacePath,
    title: typeof (meta.Title || meta.title) === 'string' && (meta.Title || meta.title).trim()
      ? (meta.Title || meta.title).trim()
      : null
  };
}

/**
 * 读取全局 cache/conversation_metadata.json（Antigravity CLI 实际存储 ProjectID 与 WorkspaceURIs 的位置）
 */
function loadCachedConversationMetadataMap(agDir, agCliDir) {
  const map = new Map();
  for (const dir of [agCliDir, agDir]) {
    if (!dir) continue;
    const cacheFile = path.join(dir, 'cache', 'conversation_metadata.json');
    const data = safeReadJson(cacheFile);
    const convs = data && typeof data.conversations === 'object' ? data.conversations : null;
    if (!convs) continue;
    for (const [convId, entry] of Object.entries(convs)) {
      if (!entry || typeof entry !== 'object') continue;
      const summary = (entry.summary && typeof entry.summary === 'object') ? entry.summary : entry;
      const parsed = parseMetadataSummaryObj(summary);
      if (!parsed.projectId && !parsed.workspacePath && !parsed.title) continue;
      const prev = map.get(convId);
      if (!prev) {
        map.set(convId, parsed);
      } else {
        map.set(convId, {
          projectId: prev.projectId || parsed.projectId,
          workspacePath: prev.workspacePath || parsed.workspacePath,
          title: prev.title || parsed.title
        });
      }
    }
  }
  return map;
}

/**
 * 读取单条会话 metadata（优先会话内文件，并用全局 cache/conversation_metadata.json 补全）
 */
function readConversationMetadata(baseDir, convId, cacheMap = null) {
  const candidates = [
    path.join(baseDir, 'brain', convId, 'conversation_metadata.json'),
    path.join(baseDir, 'brain', convId, '.system_generated', 'conversation_metadata.json')
  ];
  let localMeta = null;
  for (const p of candidates) {
    const raw = safeReadJson(p);
    if (!raw || typeof raw !== 'object') continue;
    localMeta = parseMetadataSummaryObj(raw);
    break;
  }
  const cached = cacheMap && cacheMap.get(convId) ? cacheMap.get(convId) : null;
  if (!localMeta && !cached) return { projectId: null, workspacePath: null, title: null };
  return {
    projectId: localMeta?.projectId || cached?.projectId || null,
    workspacePath: localMeta?.workspacePath || cached?.workspacePath || null,
    title: localMeta?.title || cached?.title || null
  };
}

/**
 * 扫描 ~/.gemini/config/projects/*.json
 */
function readConfigProjects(opts = {}) {
  const configDir = resolveGeminiConfigDir(opts);
  const projectsDir = path.join(configDir, 'projects');
  const list = [];
  if (!fs.existsSync(projectsDir)) return list;

  let entries = [];
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return list;
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.json')) continue;
    const fullPath = path.join(projectsDir, entry.name);
    const data = safeReadJson(fullPath);
    if (!data) continue;
    const id = String(data.id || data.projectId || entry.name.replace(/\.json$/i, '')).trim();
    if (!id) continue;
    const name = String(data.name || data.displayName || id).trim();
    const rawWs = data.workspacePath || data.path || data.workspace || data.rootPath ||
      (Array.isArray(data.workspaces) ? data.workspaces[0] : null);
    const workspacePath = rawWs ? normalizeCandidateWorkspace(String(rawWs)) : null;

    let updatedAt = null;
    try {
      updatedAt = new Date(fs.statSync(fullPath).mtimeMs).toISOString();
    } catch {
      updatedAt = null;
    }

    list.push({
      id,
      name,
      workspacePath,
      updatedAt,
      custom: false,
      source: 'gemini-config'
    });
  }
  return list;
}

/**
 * 读取自定义项目存储 (~/.config/agy-remote/projects.json)
 */
function readCustomProjects(opts = {}) {
  const storePath = resolveProjectsStorePath(opts);
  const raw = safeReadJson(storePath);
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.projects) ? raw.projects : []);
  const list = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const ws = normalizeWorkspaceDisplay(item.workspacePath || item.path);
    if (!ws) continue;
    const id = String(item.id || '').trim() || `custom-${crypto.createHash('sha1').update(workspaceCompareKey(ws)).digest('hex').slice(0, 10)}`;
    const name = String(item.name || '').trim() || extractPathBaseName(ws) || ws;
    list.push({
      id,
      name,
      workspacePath: ws,
      updatedAt: item.updatedAt || item.createdAt || null,
      custom: true,
      source: 'custom'
    });
  }
  return list;
}

/**
 * 保存自定义项目（校验路径存在且为有效目录后原子写入）
 */
function addCustomProject(input = {}, opts = {}) {
  const rawPath = typeof input.path === 'string' ? input.path.trim() : '';
  if (!rawPath) {
    const err = new Error('项目目录路径不能为空');
    err.statusCode = 400;
    throw err;
  }

  const resolvedPath = path.resolve(rawPath);
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    const err = new Error(`目录不存在: ${resolvedPath}`);
    err.statusCode = 400;
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`指定路径不是有效目录: ${resolvedPath}`);
    err.statusCode = 400;
    throw err;
  }

  const name = (typeof input.name === 'string' && input.name.trim())
    ? input.name.trim()
    : (extractPathBaseName(resolvedPath) || resolvedPath);
  const storePath = resolveProjectsStorePath(opts);
  const existing = readCustomProjects(opts);
  const targetKey = workspaceCompareKey(resolvedPath);
  const nowIso = new Date().toISOString();

  let savedItem = existing.find((p) => workspaceCompareKey(p.workspacePath) === targetKey);
  if (savedItem) {
    savedItem.name = name;
    savedItem.workspacePath = resolvedPath;
    savedItem.updatedAt = nowIso;
  } else {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'project';
    const hash = crypto.createHash('sha1').update(targetKey).digest('hex').slice(0, 8);
    savedItem = {
      id: `custom-${slug}-${hash}`,
      name,
      workspacePath: resolvedPath,
      createdAt: nowIso,
      updatedAt: nowIso,
      custom: true
    };
    existing.push(savedItem);
  }

  atomicWriteJson(storePath, {
    projects: existing.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.workspacePath,
      workspacePath: p.workspacePath,
      createdAt: p.createdAt || p.updatedAt || nowIso,
      updatedAt: p.updatedAt || nowIso
    })),
    updatedAt: nowIso
  });

  return {
    id: savedItem.id,
    name: savedItem.name,
    workspacePath: savedItem.workspacePath,
    conversationCount: 0,
    updatedAt: savedItem.updatedAt,
    custom: true
  };
}

/**
 * 构建项目索引映射表，用于将每条会话精准归类到项目
 */
function buildProjectLookups(opts = {}) {
  const configProjects = readConfigProjects(opts);
  const customProjects = readCustomProjects(opts);
  const configById = new Map();
  const configByWsKey = new Map();
  const customByWsKey = new Map();

  for (const cp of configProjects) {
    configById.set(cp.id, cp);
    const k = workspaceCompareKey(cp.workspacePath);
    if (k) configByWsKey.set(k, cp);
  }
  for (const cust of customProjects) {
    const k = workspaceCompareKey(cust.workspacePath);
    if (k) customByWsKey.set(k, cust);
  }

  return { configProjects, customProjects, configById, configByWsKey, customByWsKey };
}

/**
 * 判断路径是否属于隐藏目录或内部临时目录（避免自动推导为独立项目）
 */
function isInternalWorkspacePath(workspacePath) {
  if (!workspacePath) return false;
  const parts = String(workspacePath).split(/[\\/]+/).filter(Boolean);
  return parts.some((seg) => seg.startsWith('.') || seg === 'agents_shared');
}

function resolveProjectForConversation(rawWorkspace, meta, lookups) {
  const workspacePath = normalizeWorkspaceDisplay(meta?.workspacePath || rawWorkspace) || null;
  const wsKey = workspaceCompareKey(workspacePath);

  if (wsKey && lookups.customByWsKey.has(wsKey)) {
    const cust = lookups.customByWsKey.get(wsKey);
    return { projectId: cust.id, projectName: cust.name, workspacePath, custom: true };
  }
  if (meta?.projectId) {
    const cfg = lookups.configById.get(meta.projectId);
    return {
      projectId: meta.projectId,
      projectName: cfg?.name || meta.projectId,
      workspacePath,
      custom: false
    };
  }
  if (wsKey && lookups.configByWsKey.has(wsKey)) {
    const cfg = lookups.configByWsKey.get(wsKey);
    return { projectId: cfg.id, projectName: cfg.name, workspacePath, custom: false };
  }
  if (wsKey && !isInternalWorkspacePath(workspacePath)) {
    const hash = crypto.createHash('sha1').update(wsKey).digest('hex').slice(0, 10);
    return {
      projectId: `ws-${hash}`,
      projectName: extractPathBaseName(workspacePath) || workspacePath,
      workspacePath,
      custom: false
    };
  }
  return { projectId: null, projectName: null, workspacePath, custom: false };
}

/**
 * 扫描 CLI 与 Desktop 双源会话目录，提取摘要与最新上下文，补充项目信息并支持按 projectId / workspace 过滤
 */
function listConversationsAndAudit(opts = {}) {
  const { agDir, agCliDir } = resolveDataDirs(opts);
  const budgetHint = readContextBudgetHint(agDir, agCliDir);
  const cascadeConfigs = Array.isArray(opts.cascadeModelConfigs) ? opts.cascadeModelConfigs : [];
  const modelCtxOverrides = getModelCtxOverrides(opts).overrides;
  const lookups = buildProjectLookups(opts);
  const cacheMap = loadCachedConversationMetadataMap(agDir, agCliDir);
  const prefsMap = readConversationPrefsMap(opts);

  const ledgerByCascade = new Map();
  for (const dir of [agDir, agCliDir]) {
    for (const call of loadPricingLedgerSafe(dir)) {
      if (!call.cascadeId) continue;
      if (!opts.agDir && isLedgerCallSynthetic(call)) continue;
      if (!ledgerByCascade.has(call.cascadeId)) ledgerByCascade.set(call.cascadeId, []);
      ledgerByCascade.get(call.cascadeId).push(call);
    }
  }

  const jobs = collectAllTranscriptJobs(agDir, agCliDir);
  const byId = new Map();

  for (const job of jobs) {
    try {
      const parsed = parseTranscriptFile(job, { agDir, agCliDir, force: opts.force });
      const pref = prefsMap[parsed.id] || null;
      if (pref && pref.deleted) continue;

      const baseDir = job.source === 'cli' ? agCliDir : agDir;
      const meta = readConversationMetadata(baseDir, parsed.id, cacheMap);
      const proj = resolveProjectForConversation(parsed.workspace, meta, lookups);
      const ledgerCalls = ledgerByCascade.get(parsed.id) || [];
      const latestContext = buildLatestContext(parsed, ledgerCalls, budgetHint, cascadeConfigs, modelCtxOverrides);

      const summaryItem = {
        id: parsed.id,
        source: parsed.source,
        title: (pref && pref.customTitle) ? pref.customTitle : parsed.title,
        rawTitle: parsed.title,
        pinned: Boolean(pref && pref.pinned),
        unread: Boolean(pref && pref.unread),
        archived: Boolean(pref && pref.archived),
        workspace: proj.workspacePath || parsed.workspace,
        workspacePath: proj.workspacePath,
        projectId: proj.projectId,
        projectName: proj.projectName,
        createdAt: parsed.createdAt,
        updatedAt: parsed.updatedAt,
        model: latestContext.model,
        stepCount: parsed.stepCount,
        latestContext
      };

      const existing = byId.get(parsed.id);
      if (!existing || Date.parse(summaryItem.updatedAt) >= Date.parse(existing.updatedAt)) {
        byId.set(parsed.id, summaryItem);
      }
    } catch {
      // 单份坏损日志不影响整体列表扫描
    }
  }

  let conversations = [...byId.values()].sort((a, b) => {
    // 置顶会话始终排在前面，同组按更新时间倒序
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
  });

  // 可选过滤：sourceFilter / archivedFilter / projectId / workspace
  if (opts.archivedFilter === 'only') {
    conversations = conversations.filter((c) => c.archived);
  } else if (opts.archivedFilter === 'exclude') {
    conversations = conversations.filter((c) => !c.archived);
  }
  if (opts.sourceFilter && opts.sourceFilter !== 'all') {
    conversations = conversations.filter((c) => c.source === opts.sourceFilter);
  }
  if (opts.projectId) {
    const pid = String(opts.projectId).trim();
    if (pid === 'unassigned' || pid === '__ungrouped__') {
      conversations = conversations.filter((c) => !c.projectId);
    } else {
      conversations = conversations.filter((c) => c.projectId === pid);
    }
  }
  if (opts.workspace) {
    const wsKey = workspaceCompareKey(String(opts.workspace));
    if (wsKey) {
      conversations = conversations.filter((c) => workspaceCompareKey(c.workspacePath || c.workspace) === wsKey);
    }
  }

  return {
    conversations,
    scannedAt: new Date().toISOString()
  };
}

const collectConversations = listConversationsAndAudit;

/**
 * 汇总项目列表（融合 ~/.gemini/config/projects/*.json、自定义项目与会话工作区推导）
 */
function collectProjects(opts = {}) {
  const lookups = buildProjectLookups(opts);
  const { conversations } = listConversationsAndAudit({
    ...opts,
    sourceFilter: 'all',
    projectId: undefined,
    workspace: undefined
  });

  const projectMap = new Map();
  const upsertProject = (proj) => {
    if (!proj || !proj.id) return;
    const prev = projectMap.get(proj.id);
    if (!prev) {
      projectMap.set(proj.id, {
        id: proj.id,
        name: proj.name || proj.id,
        workspacePath: proj.workspacePath || null,
        conversationCount: 0,
        updatedAt: proj.updatedAt || null,
        custom: Boolean(proj.custom)
      });
    } else {
      if (proj.custom) {
        prev.custom = true;
        prev.name = proj.name || prev.name;
      }
      if (!prev.workspacePath && proj.workspacePath) prev.workspacePath = proj.workspacePath;
      if (proj.updatedAt && (!prev.updatedAt || Date.parse(proj.updatedAt) > Date.parse(prev.updatedAt))) {
        prev.updatedAt = proj.updatedAt;
      }
    }
  };

  for (const p of lookups.configProjects) upsertProject(p);
  for (const p of lookups.customProjects) upsertProject(p);

  let unassignedCount = 0;
  for (const conv of conversations) {
    if (!conv.projectId) {
      unassignedCount += 1;
      continue;
    }
    upsertProject({
      id: conv.projectId,
      name: conv.projectName || conv.projectId,
      workspacePath: conv.workspacePath || null,
      updatedAt: conv.updatedAt,
      custom: false
    });
    const entry = projectMap.get(conv.projectId);
    entry.conversationCount += 1;
    if (!entry.workspacePath && conv.workspacePath) entry.workspacePath = conv.workspacePath;
    if (conv.updatedAt && (!entry.updatedAt || Date.parse(conv.updatedAt) > Date.parse(entry.updatedAt))) {
      entry.updatedAt = conv.updatedAt;
    }
  }

  const projects = [...projectMap.values()].sort((a, b) => {
    const ta = a.updatedAt ? Date.parse(a.updatedAt) || 0 : 0;
    const tb = b.updatedAt ? Date.parse(b.updatedAt) || 0 : 0;
    if (tb !== ta) return tb - ta;
    if (b.conversationCount !== a.conversationCount) return b.conversationCount - a.conversationCount;
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    projects,
    unassignedCount,
    totalConversations: conversations.length
  };
}

/**
 * 格式化产物/任务的时间显示（例如 "Today 8:19 PM" 或 "Yesterday 10:12 AM"）
 */
function formatPanelRelativeTime(mtimeMs) {
  if (!mtimeMs) return '';
  const d = new Date(mtimeMs);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();

  const hours = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 || 12;
  const timeStr = `${displayHours}:${mins} ${ampm}`;

  if (isToday) return `Today ${timeStr}`;
  if (isYesterday) return `Yesterday ${timeStr}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${timeStr}`;
}

/**
 * 美化产物文件名（例如 "great_wall_golden_hour_1794745188146.jpg" -> "Great Wall Golden Hour"）
 */
function beautifyArtifactTitle(fileName) {
  if (!fileName) return 'Artifact';
  const ext = path.extname(fileName);
  let base = path.basename(fileName, ext);
  // 去除末尾的时间戳如 _1794745188146
  base = base.replace(/_\d{10,}$/, '');
  // 下划线或中划线替换为空格
  const words = base.split(/[_-]+/).filter(Boolean);
  if (!words.length) return fileName;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * 解析会话目录下的官方 Side Panel 结构（Subagents、Artifacts、Uploads、Files Changed、Background Tasks）
 */
function readConversationSidePanelData(baseDir, convId, parsed) {
  const result = {
    subagents: [],
    artifacts: [],
    uploads: [],
    filesChanged: [],
    backgroundTasks: []
  };

  if (!baseDir || !convId) return result;
  const brainConvDir = path.join(baseDir, 'brain', convId);
  if (!fs.existsSync(brainConvDir)) return result;

  // 1. 解析 Subagents（读取 .system_generated/subagents/*.json）
  const subagentDir = path.join(brainConvDir, '.system_generated', 'subagents');
  if (fs.existsSync(subagentDir)) {
    try {
      const files = fs.readdirSync(subagentDir);
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const fPath = path.join(subagentDir, f);
        try {
          const raw = fs.readFileSync(fPath, 'utf8');
          const data = JSON.parse(raw);
          const desc = data.subagentDescriptor || {};
          const role = desc.role || desc.typeName || 'Subagent';
          const st = fs.statSync(fPath);
          result.subagents.push({
            id: data.conversationId || f.replace('.json', ''),
            role,
            typeName: desc.typeName || 'subagent',
            durationText: 'Worked for 1m',
            completed: true,
            updatedAt: st.mtimeMs
          });
        } catch {}
      }
    } catch {}
  }

  // 若物理目录未扫描到，从消息历史的 invoke_subagent 工具调用中提取
  if (!result.subagents.length && Array.isArray(parsed?.messages)) {
    for (const msg of parsed.messages) {
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if (tc.name === 'invoke_subagent' && tc.args) {
            const role = tc.args.Role || tc.args.TypeName || 'Subagent';
            result.subagents.push({
              id: `subagent-${result.subagents.length + 1}`,
              role,
              typeName: tc.args.TypeName || 'subagent',
              durationText: 'Worked for 1m',
              completed: true,
              updatedAt: msg.timestamp || Date.now()
            });
          }
        }
      }
    }
  }

  // 2. 解析 Artifacts（产物图片与文件）
  try {
    const entries = fs.readdirSync(brainConvDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fName = entry.name;
      // 忽略隐藏文件或系统日志
      if (fName.startsWith('.') || fName.endsWith('.jsonl') || fName.endsWith('.log')) continue;
      const fullPath = path.join(brainConvDir, fName);
      try {
        const st = fs.statSync(fullPath);
        const ext = path.extname(fName).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.svg'].includes(ext);
        const timeText = formatPanelRelativeTime(st.mtimeMs);
        const rawTitle = beautifyArtifactTitle(fName);
        const titleWithTime = timeText ? `${rawTitle} (${timeText})` : rawTitle;

        result.artifacts.push({
          name: fName,
          title: titleWithTime,
          rawTitle,
          path: fullPath,
          url: `/api/local-image?path=${encodeURIComponent(fullPath)}`,
          type: isImage ? 'image' : 'file',
          size: st.size,
          mtimeMs: st.mtimeMs
        });
      } catch {}
    }
  } catch {}

  // 按修改时间倒序排列（最新的在最上面）
  result.artifacts.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 3. 解析 Uploads（上传素材）
  const uploadsDir = path.join(brainConvDir, '.user_uploaded');
  if (fs.existsSync(uploadsDir)) {
    try {
      const files = fs.readdirSync(uploadsDir);
      for (const f of files) {
        if (f.startsWith('.')) continue;
        const fPath = path.join(uploadsDir, f);
        try {
          const st = fs.statSync(fPath);
          result.uploads.push({
            name: f,
            path: fPath,
            url: `/api/local-image?path=${encodeURIComponent(fPath)}`,
            size: st.size,
            mtimeMs: st.mtimeMs
          });
        } catch {}
      }
    } catch {}
  }

  // 4. 解析 Background Tasks
  const tasksDir = path.join(brainConvDir, '.system_generated', 'tasks');
  if (fs.existsSync(tasksDir)) {
    try {
      const files = fs.readdirSync(tasksDir);
      for (const f of files) {
        if (f.startsWith('.')) continue;
        const fPath = path.join(tasksDir, f);
        try {
          const st = fs.statSync(fPath);
          result.backgroundTasks.push({
            name: f.replace('.log', ''),
            file: f,
            mtimeMs: st.mtimeMs
          });
        } catch {}
      }
    } catch {}
  }

  // 5. 解析 Files Changed（提取 write_file / edit_file 变动的文件）
  if (Array.isArray(parsed?.messages)) {
    const fileSet = new Set();
    for (const msg of parsed.messages) {
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          if ((tc.name === 'write_file' || tc.name === 'edit_file') && tc.args && tc.args.Path) {
            fileSet.add(tc.args.Path);
          }
        }
      }
    }
    result.filesChanged = Array.from(fileSet).map((p) => ({
      path: p,
      name: path.basename(p)
    }));
  }

  return result;
}

/**
 * 读取指定会话详情，返回结构化消息、5 维占用分组、媒体审计与最新上下文状态
 */
function getConversationDetail(convId, opts = {}) {
  if (!convId || typeof convId !== 'string' || /[/\\]|\.\./.test(convId)) {
    return null;
  }
  const prefsMap = readConversationPrefsMap(opts);
  const pref = prefsMap[convId] || null;
  if (pref && pref.deleted) {
    return null;
  }

  const { agDir, agCliDir } = resolveDataDirs(opts);
  const candidates = [];
  const searchDirs = opts.source === 'desktop'
    ? [{ dir: agDir, source: 'desktop' }, { dir: agCliDir, source: 'cli' }]
    : [{ dir: agCliDir, source: 'cli' }, { dir: agDir, source: 'desktop' }];

  for (const item of searchDirs) {
    const pStd = path.join(item.dir, 'brain', convId, '.system_generated', 'logs', 'transcript.jsonl');
    const pDirect = path.join(item.dir, 'brain', convId, 'transcript.jsonl');
    const foundPath = fs.existsSync(pStd) ? pStd : (fs.existsSync(pDirect) ? pDirect : null);
    if (foundPath) {
      candidates.push({ path: foundPath, source: item.source, convId });
    }
  }

  if (!candidates.length) return null;

  // 若 CLI 与 Desktop 均存在同名会话，选择最近更新的日志
  let chosen = candidates[0];
  if (candidates.length > 1) {
    try {
      const m0 = fs.statSync(candidates[0].path).mtimeMs;
      const m1 = fs.statSync(candidates[1].path).mtimeMs;
      if (m1 > m0) chosen = candidates[1];
    } catch {
      // 保持首选
    }
  }

  let parsed;
  try {
    parsed = parseTranscriptFile(chosen, { agDir, agCliDir, force: opts.force });
  } catch (err) {
    if (process.env.DEBUG_METER) console.error('parseTranscriptFile error:', err);
    return null;
  }

  const budgetHint = readContextBudgetHint(agDir, agCliDir);
  const cascadeConfigs = Array.isArray(opts.cascadeModelConfigs) ? opts.cascadeModelConfigs : [];
  const modelCtxOverrides = getModelCtxOverrides(opts).overrides;
  const lookups = buildProjectLookups(opts);
  const baseDir = chosen.source === 'cli' ? agCliDir : agDir;
  const cacheMap = loadCachedConversationMetadataMap(agDir, agCliDir);
  const meta = readConversationMetadata(baseDir, parsed.id, cacheMap);
  const proj = resolveProjectForConversation(parsed.workspace, meta, lookups);

  const ledgerCalls = [
    ...loadPricingLedgerSafe(agDir),
    ...loadPricingLedgerSafe(agCliDir)
  ].filter((c) => c.cascadeId === parsed.id && (opts.agDir || !isLedgerCallSynthetic(c)));

  const latest = buildLatestContext(parsed, ledgerCalls, budgetHint, cascadeConfigs, modelCtxOverrides);

  return {
    id: parsed.id,
    source: parsed.source,
    title: (pref && pref.customTitle) ? pref.customTitle : parsed.title,
    rawTitle: parsed.title,
    pinned: Boolean(pref && pref.pinned),
    unread: Boolean(pref && pref.unread),
    archived: Boolean(pref && pref.archived),
    workspace: proj.workspacePath || parsed.workspace,
    workspacePath: proj.workspacePath,
    projectId: proj.projectId,
    projectName: proj.projectName,
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
    model: latest.model,
    messages: parsed.messages,
    groups: parsed.groups,
    total: parsed.total,
    media: parsed.media,
    sidePanel: readConversationSidePanelData(baseDir, parsed.id, parsed),
    latest
  };
}

// ============================================================================
// 7. Token 历史、52 周热力图、模型测速对比与 API 账单估算
// ============================================================================

function getLvlForRange(value, kind = 'day', maxInWindow = 0) {
  const v = Number(value) || 0;
  if (v <= 0) return 0;
  if (kind === 'day') {
    if (v < 3e6) return 1;
    if (v < 15e6) return 2;
    if (v < 60e6) return 3;
    return 4;
  }
  const max = Number(maxInWindow) || 0;
  if (max <= 0) return 1;
  const ratio = v / max;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.50) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function calculateRequestApiCost(req) {
  if (!req) return { costUSD: null, isPriced: false, reason: '缺失请求数据' };
  const rawModel = String(req.model || req.modelDisplayName || req.responseModel || req.modelId || '');
  const modelKey = normalizeModelId(rawModel);
  if (!modelKey || !GEMINI_PRICING_TABLE[modelKey]) {
    return { costUSD: null, isPriced: false, modelKey: null, rawModel };
  }

  const input = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
  const cache = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
  const output = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
  const thinking = Number(req.thinkingTokens ?? req.thinking_output_tokens ?? req.thinking ?? 0);
  const totalPrompt = input + cache;

  const reqDate = req.date ? String(req.date).slice(0, 10) : (req.created_at ? String(req.created_at).slice(0, 10) : '2026-11-08');
  const tierRules = GEMINI_PRICING_TABLE[modelKey];
  let matchedTier = null;
  for (const rule of tierRules) {
    if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
    if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
    if (rule.maxPromptTokens && totalPrompt > rule.maxPromptTokens) continue;
    if (rule.minPromptTokens && totalPrompt < rule.minPromptTokens) continue;
    matchedTier = rule;
    break;
  }
  if (!matchedTier) matchedTier = tierRules[0];

  // 拆分输入/缓存/输出三项费用明细，便于前端账单对比展示
  const inputCostUSD = (input * matchedTier.inputPerMillion) / 1e6;
  const cacheCostUSD = (cache * matchedTier.cacheReadPerMillion) / 1e6;
  const outputCostUSD = (output * matchedTier.outputPerMillion) / 1e6;
  const totalCost = inputCostUSD + cacheCostUSD + outputCostUSD;

  return {
    costUSD: Number(totalCost.toFixed(6)),
    inputCostUSD: Number(inputCostUSD.toFixed(6)),
    cacheCostUSD: Number(cacheCostUSD.toFixed(6)),
    outputCostUSD: Number(outputCostUSD.toFixed(6)),
    isPriced: true,
    modelKey,
    inputTokens: input,
    cacheTokens: cache,
    outputTokens: output,
    thinkingTokens: thinking,
    totalTokens: input + cache + output
  };
}

function computeMedian(values) {
  const clean = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function summarizeSpeedByModel(calls) {
  const groups = new Map();

  for (const c of (Array.isArray(calls) ? calls : [])) {
    if (!c || c.status === 'error' || c.isEstimated === true) continue;
    const out = Number(c.outputTokens) || 0;
    const tpsRaw = Number(c.tps);
    let dur = Number(c.durationSec);
    if ((!Number.isFinite(dur) || dur <= 0) && Number.isFinite(tpsRaw) && tpsRaw > 0 && out > 0) {
      dur = Number((out / tpsRaw).toFixed(2));
    }
    const hasTps = Number.isFinite(tpsRaw) && tpsRaw > 0;
    const hasOutAndDur = out > 0 && Number.isFinite(dur) && dur > 0;
    if (!hasTps && !hasOutAndDur) continue;

    const exactId = String(c.modelExactId || c.modelKey || c.model || '').trim().toLowerCase();
    if (!exactId) continue;

    const ts = Number(c.timestamp) || parseIsoTimestampMs(c.created_at) || parseIsoTimestampMs(c.date) || 0;
    const rawLabel = String(c.modelLabel || c.model || exactId).trim();
    const prod = groupModelProduct({ modelId: exactId, label: rawLabel, effort: c.effort });
    const tpsVal = Number.isFinite(Number(c.tps)) && Number(c.tps) > 0
      ? Number(c.tps)
      : Number((out / dur).toFixed(1));
    const ttftVal = toNonNegNumber(c.ttftSec);

    if (!groups.has(exactId)) {
      groups.set(exactId, {
        modelExactId: exactId,
        modelLabel: rawLabel,
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        effort: c.effort || prod.effort || null,
        records: []
      });
    }
    groups.get(exactId).records.push({
      callId: c.callId || null,
      ts,
      tps: tpsVal,
      ttftSec: ttftVal,
      durationSec: dur,
      outputTokens: out
    });
  }

  const result = [];
  for (const g of groups.values()) {
    g.records.sort((a, b) => b.ts - a.ts);
    const recent = g.records.slice(0, MAX_SPEED_SAMPLES_PER_MODEL);
    if (!recent.length) continue;

    const medTps = computeMedian(recent.map((r) => r.tps));
    const ttfts = recent.map((r) => r.ttftSec).filter((v) => v !== null);
    const medTtft = ttfts.length ? computeMedian(ttfts) : null;
    const medDur = computeMedian(recent.map((r) => r.durationSec));
    const medOut = computeMedian(recent.map((r) => r.outputTokens));

    result.push({
      modelExactId: g.modelExactId,
      modelLabel: g.modelLabel,
      productKey: g.productKey,
      productLabel: g.productLabel,
      vendor: g.vendor,
      effort: g.effort,
      count: recent.length,
      lowSample: recent.length < 3,
      medianTps: medTps !== null ? Number(medTps.toFixed(1)) : null,
      medianTtft: medTtft !== null ? Number(medTtft.toFixed(2)) : null,
      medianDuration: medDur !== null ? Number(medDur.toFixed(2)) : null,
      medianOutputTokens: medOut !== null ? Math.round(medOut) : null
    });
  }

  result.sort((a, b) => (b.medianTps ?? -1) - (a.medianTps ?? -1));
  return result;
}

/**
 * 提取按时间升序排列的速度样本，供前端筛选（7天/30天/全部、全部来源/日常对话）及单模型 SVG 趋势图使用
 */
function buildSpeedSamples(calls, maxSamples = 500) {
  const samples = [];
  for (const c of (Array.isArray(calls) ? calls : [])) {
    if (!c || c.status === 'error' || c.isEstimated === true) continue;
    const out = Number(c.outputTokens) || 0;
    const tpsRaw = Number(c.tps);
    let dur = Number(c.durationSec);
    if ((!Number.isFinite(dur) || dur <= 0) && Number.isFinite(tpsRaw) && tpsRaw > 0 && out > 0) {
      dur = Number((out / tpsRaw).toFixed(2));
    }
    const hasTps = Number.isFinite(tpsRaw) && tpsRaw > 0;
    const hasOutAndDur = out > 0 && Number.isFinite(dur) && dur > 0;
    if (!hasTps && !hasOutAndDur) continue;

    const exactId = String(c.modelExactId || c.modelKey || c.model || '').trim().toLowerCase();
    if (!exactId) continue;

    const ts = Number(c.timestamp) || parseIsoTimestampMs(c.created_at) || parseIsoTimestampMs(c.date) || 0;
    const rawLabel = String(c.modelLabel || c.model || exactId).trim();
    const prod = groupModelProduct({ modelId: exactId, label: rawLabel, effort: c.effort });
    const tpsVal = Number.isFinite(Number(c.tps)) && Number(c.tps) > 0
      ? Number(c.tps)
      : Number((out / dur).toFixed(1));
    const ttftVal = toNonNegNumber(c.ttftSec);
    const calc = calculateRequestApiCost(c);
    // 区分日常对话(chat)与后台压缩检查点(background)，同时保留原始来源 cli/desktop
    const isBg = c.channel === 'checkpoint' || c.isBackground === true;

    samples.push({
      ts,
      date: ts > 0 ? formatLocalDateKey(new Date(ts)) : (c.date ? String(c.date).slice(0, 10) : null),
      callId: c.callId || null,
      model: rawLabel || exactId,
      modelKey: calc.modelKey || normalizeModelId(exactId) || exactId,
      modelExactId: exactId,
      modelLabel: rawLabel,
      productKey: prod.productKey,
      productLabel: prod.productLabel,
      effort: c.effort || prod.effort || null,
      source: isBg ? 'background' : 'chat',
      originSource: c.source === 'cli' ? 'cli' : 'desktop',
      channel: c.channel || 'chat',
      outputTps: Number(tpsVal.toFixed(1)),
      ttftMs: ttftVal !== null ? Math.round(ttftVal * 1000) : null,
      durationMs: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 1000) : null,
      outputTokens: Math.round(out),
      costUsd: calc.isPriced ? Number(calc.costUSD.toFixed(6)) : 0
    });
  }

  samples.sort((a, b) => a.ts - b.ts);
  return samples.length > maxSamples ? samples.slice(samples.length - maxSamples) : samples;
}

/**
 * 按时间窗口（近7天/近30天/全部）汇总模型速度排行
 */
function buildSpeedSummaryByRange(calls, allSummary) {
  const nowMs = Date.now();
  const cutoff7d = nowMs - 7 * 86400 * 1000;
  const cutoff30d = nowMs - 30 * 86400 * 1000;
  const list7d = [];
  const list30d = [];

  for (const c of (Array.isArray(calls) ? calls : [])) {
    const ts = Number(c?.timestamp) || parseIsoTimestampMs(c?.created_at) || parseIsoTimestampMs(c?.date) || 0;
    if (ts >= cutoff30d) list30d.push(c);
    if (ts >= cutoff7d) list7d.push(c);
  }

  return {
    '7d': summarizeSpeedByModel(list7d),
    '30d': summarizeSpeedByModel(list30d),
    all: allSummary || summarizeSpeedByModel(calls)
  };
}

/**
 * 生成近 12 周柱状/折线、月度汇总及累计 Token/费用曲线序列
 */
function buildWeeklyMonthlyCumulativeSeries(dailyMap, heatmapWeeks, requests) {
  const dailyCostMap = {};
  for (const req of (Array.isArray(requests) ? requests : [])) {
    const calc = calculateRequestApiCost(req);
    if (!calc.isPriced) continue;
    const ts = Number(req.timestamp) || parseIsoTimestampMs(req.created_at) || 0;
    const dateKey = (req.date && /^\d{4}-\d{2}-\d{2}$/.test(String(req.date).slice(0, 10)))
      ? String(req.date).slice(0, 10)
      : (ts > 0 ? formatLocalDateKey(new Date(ts)) : null);
    if (!dateKey) continue;
    dailyCostMap[dateKey] = (dailyCostMap[dateKey] || 0) + calc.costUSD;
  }

  // 1. 近 12 周序列
  const recentWeeks = (Array.isArray(heatmapWeeks) ? heatmapWeeks : []).slice(-12);
  const weeklySeries = recentWeeks.map((w) => {
    let inputTokens = 0;
    let cacheTokens = 0;
    let outputTokens = 0;
    let turns = 0;
    let costUSD = 0;
    for (const d of (w.days || [])) {
      inputTokens += Number(d.input) || 0;
      cacheTokens += Number(d.cache) || 0;
      outputTokens += Number(d.output) || 0;
      turns += Number(d.steps) || 0;
      costUSD += dailyCostMap[d.date] || 0;
    }
    const roundedUSD = Number(costUSD.toFixed(4));
    return {
      weekIndex: w.weekIndex,
      weekStart: w.startDate,
      weekEnd: w.endDate,
      label: String(w.startDate || '').slice(5),
      tokens: Number(w.totalTokens) || 0,
      inputTokens,
      cacheTokens,
      outputTokens,
      turns,
      costUSD: roundedUSD,
      costCNY: Number((roundedUSD * USD_TO_CNY_RATE).toFixed(2))
    };
  });

  // 2. 月度汇总与累计曲线共用升序日期列表
  const sortedDates = Object.keys(dailyMap || {})
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();

  const monthlyMap = {};
  const cumulativeRaw = [];
  let cumTokens = 0;
  let cumCostUSD = 0;
  let cumTurns = 0;

  for (const dateKey of sortedDates) {
    const rec = dailyMap[dateKey] || {};
    const tok = Number(rec.total) || 0;
    const inp = Number(rec.input) || 0;
    const cap = Number(rec.cache) || 0;
    const out = Number(rec.output) || 0;
    const stp = Number(rec.steps) || 0;
    const dayCost = dailyCostMap[dateKey] || 0;

    const monthKey = dateKey.slice(0, 7);
    if (!monthlyMap[monthKey]) {
      monthlyMap[monthKey] = {
        month: monthKey,
        label: monthKey,
        tokens: 0,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        turns: 0,
        costUSD: 0
      };
    }
    const m = monthlyMap[monthKey];
    m.tokens += tok;
    m.inputTokens += inp;
    m.cacheTokens += cap;
    m.outputTokens += out;
    m.turns += stp;
    m.costUSD += dayCost;

    cumTokens += tok;
    cumCostUSD += dayCost;
    cumTurns += stp;

    if (tok > 0 || dayCost > 0 || stp > 0) {
      const rDayCost = Number(dayCost.toFixed(4));
      const rCumCost = Number(cumCostUSD.toFixed(4));
      cumulativeRaw.push({
        date: dateKey,
        label: dateKey.slice(5),
        dailyTokens: tok,
        cumulativeTokens: cumTokens,
        dailyCostUSD: rDayCost,
        cumulativeCostUSD: rCumCost,
        cumulativeCostCNY: Number((rCumCost * USD_TO_CNY_RATE).toFixed(2)),
        dailyTurns: stp,
        cumulativeTurns: cumTurns
      });
    }
  }

  const monthlySeries = Object.values(monthlyMap)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => {
      const roundedUSD = Number(m.costUSD.toFixed(4));
      return {
        ...m,
        costUSD: roundedUSD,
        costCNY: Number((roundedUSD * USD_TO_CNY_RATE).toFixed(2))
      };
    });

  // 累计曲线最多保留 365 个有效日期点，确保渲染与传输轻量化
  const cumulativeSeries = cumulativeRaw.length > 365
    ? cumulativeRaw.slice(cumulativeRaw.length - 365)
    : cumulativeRaw;

  return { weeklySeries, monthlySeries, cumulativeSeries };
}

/**
 * 构建 52 周交互式日历热力图与近 7 天柱状图数据
 */
function buildCalendarSeries(dailyMap) {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = formatLocalDateKey(todayMidnight);
  // 与前端 52 周矩阵一致：以周一为每周第一天（0=周一 .. 6=周日）
  const dow = (todayMidnight.getDay() + 6) % 7;

  const thisWeekStart = new Date(todayMidnight);
  thisWeekStart.setDate(thisWeekStart.getDate() - dow);

  const gridStart = new Date(thisWeekStart);
  gridStart.setDate(gridStart.getDate() - 51 * 7);

  const heatmapWeeks = [];
  for (let w = 0; w < 52; w++) {
    const days = [];
    let weekTotal = 0;
    for (let d = 0; d < 7; d++) {
      const cur = new Date(gridStart);
      cur.setDate(gridStart.getDate() + w * 7 + d);
      const dateKey = formatLocalDateKey(cur);
      const rec = dailyMap[dateKey] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
      const total = Number(rec.total) || 0;
      weekTotal += total;
      days.push({
        date: dateKey,
        weekday: d,
        total,
        input: Number(rec.input) || 0,
        cache: Number(rec.cache) || 0,
        output: Number(rec.output) || 0,
        steps: Number(rec.steps) || 0,
        level: getLvlForRange(total, 'day'),
        isFuture: dateKey > todayKey,
        isToday: dateKey === todayKey
      });
    }
    heatmapWeeks.push({
      weekIndex: w,
      startDate: days[0].date,
      endDate: days[6].date,
      totalTokens: weekTotal,
      days
    });
  }

  const last7Days = [];
  for (let offset = 6; offset >= 0; offset--) {
    const cur = new Date(todayMidnight);
    cur.setDate(todayMidnight.getDate() - offset);
    const dateKey = formatLocalDateKey(cur);
    const rec = dailyMap[dateKey] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    last7Days.push({
      date: dateKey,
      label: dateKey.slice(5),
      total: Number(rec.total) || 0,
      input: Number(rec.input) || 0,
      cache: Number(rec.cache) || 0,
      output: Number(rec.output) || 0,
      steps: Number(rec.steps) || 0
    });
  }

  return { heatmapWeeks, last7Days };
}

/**
 * 聚合按模型的 API 等值费用与未计价明细
 */
function buildCostAndUnpricedSummary(requests, extraUnpriced = { count: 0, tokens: 0, input: 0, cache: 0, output: 0 }) {
  let totalCostUSD = 0;
  let totalInputCostUSD = 0;
  let totalCacheCostUSD = 0;
  let totalOutputCostUSD = 0;
  let pricedTokens = 0;
  let pricedInputTokens = 0;
  let pricedCacheTokens = 0;
  let pricedOutputTokens = 0;
  let pricedThinkingTokens = 0;
  let pricedRequestsCount = 0;

  let unpricedTokens = extraUnpriced.tokens || 0;
  let unpricedInput = extraUnpriced.input || 0;
  let unpricedCache = extraUnpriced.cache || 0;
  let unpricedOutput = extraUnpriced.output || 0;
  let unpricedRequestsCount = extraUnpriced.count || 0;
  const unpricedReasons = {
    missingModel: extraUnpriced.count || 0,
    unsupportedModel: 0,
    missingUsage: 0
  };
  const byModel = {};

  for (const req of requests) {
    const calc = calculateRequestApiCost(req);
    if (calc.isPriced) {
      totalCostUSD += calc.costUSD;
      totalInputCostUSD += calc.inputCostUSD || 0;
      totalCacheCostUSD += calc.cacheCostUSD || 0;
      totalOutputCostUSD += calc.outputCostUSD || 0;
      pricedTokens += calc.totalTokens;
      pricedInputTokens += calc.inputTokens;
      pricedCacheTokens += calc.cacheTokens;
      pricedOutputTokens += calc.outputTokens;
      pricedThinkingTokens += calc.thinkingTokens;
      pricedRequestsCount += 1;

      if (!byModel[calc.modelKey]) {
        byModel[calc.modelKey] = {
          modelKey: calc.modelKey,
          displayName: MODEL_DISPLAY_MAP[calc.modelKey] || calc.modelKey,
          requests: 0,
          costUSD: 0,
          costCNY: 0,
          inputCostUSD: 0,
          cacheCostUSD: 0,
          outputCostUSD: 0,
          tokens: 0,
          inputTokens: 0,
          cacheTokens: 0,
          outputTokens: 0
        };
      }
      const m = byModel[calc.modelKey];
      m.requests += 1;
      m.costUSD = Number((m.costUSD + calc.costUSD).toFixed(6));
      m.costCNY = Number((m.costUSD * USD_TO_CNY_RATE).toFixed(2));
      m.inputCostUSD = Number((m.inputCostUSD + (calc.inputCostUSD || 0)).toFixed(6));
      m.cacheCostUSD = Number((m.cacheCostUSD + (calc.cacheCostUSD || 0)).toFixed(6));
      m.outputCostUSD = Number((m.outputCostUSD + (calc.outputCostUSD || 0)).toFixed(6));
      m.tokens += calc.totalTokens;
      m.inputTokens += calc.inputTokens;
      m.cacheTokens += calc.cacheTokens;
      m.outputTokens += calc.outputTokens;
    } else {
      unpricedRequestsCount += 1;
      const inp = Number(req.inputTokens ?? req.input_tokens ?? 0);
      const cap = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? 0);
      const outp = Number(req.outputTokens ?? req.output_tokens ?? 0);
      const tot = inp + cap + outp;
      unpricedTokens += tot;
      unpricedInput += inp;
      unpricedCache += cap;
      unpricedOutput += outp;

      const rawM = String(req.model || req.modelDisplayName || req.modelId || '').trim();
      if (!rawM) unpricedReasons.missingModel += 1;
      else if (tot === 0) unpricedReasons.missingUsage += 1;
      else unpricedReasons.unsupportedModel += 1;
    }
  }

  const totalRequests = pricedRequestsCount + unpricedRequestsCount;
  const totalTok = pricedTokens + unpricedTokens;
  let coveragePercent = null;
  let requestCoveragePercent = null;
  let tokenCoveragePercent = null;
  let isPartialCoverage = false;

  if (totalRequests > 0) {
    requestCoveragePercent = Number(((pricedRequestsCount / totalRequests) * 100).toFixed(1));
    if (totalTok > 0) tokenCoveragePercent = Number(((pricedTokens / totalTok) * 100).toFixed(1));
    if (pricedRequestsCount === 0) {
      coveragePercent = 0;
    } else if (unpricedRequestsCount > 0) {
      isPartialCoverage = true;
      coveragePercent = Math.min(tokenCoveragePercent ?? requestCoveragePercent, requestCoveragePercent);
      if (coveragePercent >= 100) coveragePercent = 99.9;
    } else {
      coveragePercent = 100;
    }
  }

  const roundedUSD = Number(totalCostUSD.toFixed(4));
  const roundedCNY = Number((roundedUSD * USD_TO_CNY_RATE).toFixed(2));
  const vsProRatio = Number((roundedUSD / PRO_MONTHLY_USD).toFixed(2));

  // 为未计价部分提供按 Gemini 3.8 Flash 参考价的补充参考估算
  const flashRule = GEMINI_PRICING_TABLE['gemini-3.8-flash'][0];
  const refEstUSD = Number((
    (unpricedInput * flashRule.inputPerMillion +
      unpricedCache * flashRule.cacheReadPerMillion +
      unpricedOutput * flashRule.outputPerMillion) / 1e6
  ).toFixed(4));

  // 构建按模型费用降序排列的 API 账单对比明细
  const billingModels = Object.values(byModel)
    .map((m) => ({
      ...m,
      sharePercent: totalCostUSD > 0 ? Number(((m.costUSD / totalCostUSD) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.costUSD - a.costUSD);

  return {
    costSummary: {
      totalCostUSD: roundedUSD,
      totalCostCNY: roundedCNY,
      exchangeRate: USD_TO_CNY_RATE,
      byModel,
      proMonthlyUSD: PRO_MONTHLY_USD,
      vsProRatio,
      pricedRequestsCount,
      pricedTokens,
      coveragePercent,
      tokenCoveragePercent,
      requestCoveragePercent,
      isPartialCoverage,
      byCategory: {
        inputTokens: pricedInputTokens,
        cacheTokens: pricedCacheTokens,
        outputTokens: pricedOutputTokens,
        thinkingTokens: pricedThinkingTokens,
        inputCostUSD: Number(totalInputCostUSD.toFixed(4)),
        cacheCostUSD: Number(totalCacheCostUSD.toFixed(4)),
        outputCostUSD: Number(totalOutputCostUSD.toFixed(4))
      }
    },
    unpricedSummary: {
      unpricedRequestsCount,
      unpricedTokens,
      unpricedReasons,
      coveragePercent,
      isPartialCoverage,
      referenceEstimateUSD: refEstUSD,
      referenceEstimateCNY: Number((refEstUSD * USD_TO_CNY_RATE).toFixed(2))
    },
    billingComparison: {
      totalCostUSD: roundedUSD,
      totalCostCNY: roundedCNY,
      exchangeRate: USD_TO_CNY_RATE,
      proMonthlyUSD: PRO_MONTHLY_USD,
      vsProRatio,
      coveragePercent,
      isPartialCoverage,
      pricedRequestsCount,
      unpricedRequestsCount,
      inputCostUSD: Number(totalInputCostUSD.toFixed(4)),
      cacheCostUSD: Number(totalCacheCostUSD.toFixed(4)),
      outputCostUSD: Number(totalOutputCostUSD.toFixed(4)),
      models: billingModels
    }
  };
}

/**
 * 汇总 Token 历史、52 周热力图、近 7 天柱状图、模型速度对比与 API 等值账单
 */
function getTokenHistoryDashboard(opts = {}) {
  const rawFilter = String(opts.sourceFilter || opts.source || 'all').trim().toLowerCase();
  const sourceFilter = (rawFilter === 'cli' || rawFilter === 'desktop') ? rawFilter : 'all';
  const { agDir, agCliDir } = resolveDataDirs(opts);

  // 1. 读取旧归档（若存在），确保仅在当前 agDir 范围内合并
  const archiveV1 = safeReadJson(path.join(agDir, 'token_usage_archive_v1.json')) || {};
  const archiveV2 = safeReadJson(path.join(agDir, 'token_usage_archive_v2.json')) || {};

  // 2. 扫描 .pb / .db 与双源 transcript.jsonl
  const deskConvScan = scanSessionDbDir(path.join(agDir, 'conversations'));
  const cliConvScan = scanSessionDbDir(path.join(agCliDir, 'conversations'));
  const jobs = collectAllTranscriptJobs(agDir, agCliDir);

  const scannedBySource = { desktop: {}, cli: {} };
  const transcriptEvents = [];
  const seenEvents = new Set();
  let deskTranscriptCount = 0;
  let cliTranscriptCount = 0;

  for (const job of jobs) {
    if (job.source === 'cli') cliTranscriptCount++;
    else deskTranscriptCount++;

    try {
      const parsed = parseTranscriptFile(job, { agDir, agCliDir, force: opts.force });
      for (const ev of parsed.tokenEvents) {
        if (!ev.totalTokens || seenEvents.has(ev.callId)) continue;
        seenEvents.add(ev.callId);

        const srcMap = scannedBySource[job.source] || scannedBySource.desktop;
        if (!srcMap[ev.date]) {
          srcMap[ev.date] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        srcMap[ev.date].total += ev.totalTokens;
        srcMap[ev.date].input += ev.inputTokens;
        srcMap[ev.date].output += ev.outputTokens;
        srcMap[ev.date].cache += ev.cacheReadTokens;
        srcMap[ev.date].steps += 1;

        transcriptEvents.push(ev);
      }
    } catch {
      // 忽略损坏单文件
    }
  }

  // 3. 合并历史归档与本次扫描的每日用量（区分 desktop / cli / legacyUnallocated）
  const mergedDesktop = { ...(archiveV2.dailyMapBySource?.desktop || {}), ...scannedBySource.desktop };
  const mergedCli = { ...(archiveV2.dailyMapBySource?.cli || {}), ...scannedBySource.cli };
  const legacyDaily = archiveV1.dailyMap || archiveV2.dailyMapBySource?.legacyUnallocated || {};
  const mergedLegacyUnallocated = {};
  const dailyMapAll = {};

  const allDates = new Set([
    ...Object.keys(legacyDaily),
    ...Object.keys(mergedDesktop),
    ...Object.keys(mergedCli)
  ]);

  for (const k of [...allDates].sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    const dRec = mergedDesktop[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const cRec = mergedCli[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const lRec = legacyDaily[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };

    const scannedSum = (dRec.total || 0) + (cRec.total || 0);
    const diff = Math.max(0, (lRec.total || 0) - scannedSum);
    if (diff > 0) {
      mergedLegacyUnallocated[k] = {
        total: diff,
        input: Math.max(0, (lRec.input || 0) - (dRec.input || 0) - (cRec.input || 0)),
        output: Math.max(0, (lRec.output || 0) - (dRec.output || 0) - (cRec.output || 0)),
        cache: Math.max(0, (lRec.cache || 0) - (dRec.cache || 0) - (cRec.cache || 0)),
        steps: Math.max(0, (lRec.steps || 0) - (dRec.steps || 0) - (cRec.steps || 0))
      };
    }

    const uRec = mergedLegacyUnallocated[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    dailyMapAll[k] = {
      total: (dRec.total || 0) + (cRec.total || 0) + (uRec.total || 0),
      input: (dRec.input || 0) + (cRec.input || 0) + (uRec.input || 0),
      output: (dRec.output || 0) + (cRec.output || 0) + (uRec.output || 0),
      cache: (dRec.cache || 0) + (cRec.cache || 0) + (uRec.cache || 0),
      steps: (dRec.steps || 0) + (cRec.steps || 0) + (uRec.steps || 0)
    };
  }

  const dailyMap = sourceFilter === 'cli'
    ? mergedCli
    : (sourceFilter === 'desktop' ? mergedDesktop : dailyMapAll);

  // 4. 计算汇总指标
  const todayKey = formatLocalDateKey(new Date());
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  let todayTokens = 0;
  let monthTokens = 0;
  let yearTokens = 0;
  let grandTotalTokens = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheTokens = 0;
  let totalSteps = 0;
  let earliestDate = null;
  let activeDaysCount = 0;

  for (const [k, rec] of Object.entries(dailyMap)) {
    if (!rec || !/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    if ((rec.total || 0) > 0) {
      activeDaysCount++;
      if (!earliestDate || k < earliestDate) earliestDate = k;
    }
    grandTotalTokens += rec.total || 0;
    totalInputTokens += rec.input || 0;
    totalOutputTokens += rec.output || 0;
    totalCacheTokens += rec.cache || 0;
    totalSteps += rec.steps || 0;
    if (k === todayKey) todayTokens += rec.total || 0;
    if (k.startsWith(monthPrefix)) monthTokens += rec.total || 0;
    if (k.startsWith(yearPrefix)) yearTokens += rec.total || 0;
  }

  if (sourceFilter === 'all') {
    for (const dCand of [archiveV2.firstUseDate, archiveV1.firstUseDate, deskConvScan.earliestDate, cliConvScan.earliestDate]) {
      if (dCand && /^\d{4}-\d{2}-\d{2}$/.test(dCand) && (!earliestDate || dCand < earliestDate)) {
        earliestDate = dCand;
      }
    }
  } else if (sourceFilter === 'cli' && cliConvScan.earliestDate) {
    if (!earliestDate || cliConvScan.earliestDate < earliestDate) earliestDate = cliConvScan.earliestDate;
  } else if (sourceFilter === 'desktop' && deskConvScan.earliestDate) {
    if (!earliestDate || deskConvScan.earliestDate < earliestDate) earliestDate = deskConvScan.earliestDate;
  }

  const desktopConvs = Math.max(deskConvScan.count, deskTranscriptCount);
  const cliConvs = Math.max(cliConvScan.count, cliTranscriptCount);
  const totalConversations = sourceFilter === 'cli'
    ? cliConvs
    : (sourceFilter === 'desktop'
      ? desktopConvs
      : Math.max(archiveV1.maxConversations || 0, archiveV2.maxConversations || 0, desktopConvs + cliConvs));

  // 5. 构建热力图与近 7 天数据
  const { heatmapWeeks, last7Days } = buildCalendarSeries(dailyMap);

  // 6. 结合持久化账本与扫描请求，计算速度对比与 API 账单（防止同一 cascade 重复计入）
  const ledgerCalls = [
    ...loadPricingLedgerSafe(agDir),
    ...loadPricingLedgerSafe(agCliDir)
  ].filter((c) => opts.agDir || !isLedgerCallSynthetic(c));

  const ledgerById = new Map();
  const ledgerCascadeMaxTs = new Map();
  for (const c of ledgerCalls) {
    if (!c.callId) continue;
    const cSrc = c.source === 'cli' ? 'cli' : 'desktop';
    if (sourceFilter !== 'all' && cSrc !== sourceFilter) continue;
    ledgerById.set(c.callId, c);
    if (c.cascadeId) {
      const ts = Number(c.timestamp) || parseIsoTimestampMs(c.created_at) || 0;
      const prev = ledgerCascadeMaxTs.get(c.cascadeId) || 0;
      if (ts > prev) ledgerCascadeMaxTs.set(c.cascadeId, ts);
    }
  }

  const mergedRequests = [...ledgerById.values()];
  for (const ev of transcriptEvents) {
    if (sourceFilter !== 'all' && ev.source !== sourceFilter) continue;
    if (ledgerById.has(ev.callId)) continue;
    // 若该会话已有账本接管且事件时间不晚于账本最后一条记录，则跳过以避免与账本 responseId 重复计算
    const maxLedgerTs = ledgerCascadeMaxTs.get(ev.cascadeId);
    if (maxLedgerTs !== undefined && (ev.timestamp || 0) <= maxLedgerTs) continue;
    mergedRequests.push(ev);
  }

  const extraUnpriced = { count: 0, tokens: 0, input: 0, cache: 0, output: 0 };
  if (sourceFilter === 'all') {
    for (const u of Object.values(mergedLegacyUnallocated)) {
      extraUnpriced.count += u.steps || 0;
      extraUnpriced.tokens += u.total || 0;
      extraUnpriced.input += u.input || 0;
      extraUnpriced.cache += u.cache || 0;
      extraUnpriced.output += u.output || 0;
    }
  }

  const modelSpeedStats = summarizeSpeedByModel(mergedRequests);
  // 若账本记录中缺少测速字段，补充 transcriptEvents 中携带有效测速的样本，避免速度对比为空
  const speedExtraTranscripts = transcriptEvents.filter((ev) => {
    if (sourceFilter !== 'all' && ev.source !== sourceFilter) return false;
    if (!(ev.tps > 0 || (ev.outputTokens > 0 && ev.durationSec > 0))) return false;
    return !mergedRequests.some((m) => m.callId === ev.callId);
  });
  const speedInputCalls = speedExtraTranscripts.length
    ? [...mergedRequests, ...speedExtraTranscripts]
    : mergedRequests;
  const speedSamples = buildSpeedSamples(speedInputCalls);
  const speedSummaryByRange = buildSpeedSummaryByRange(speedInputCalls, summarizeSpeedByModel(speedInputCalls));
  const { weeklySeries, monthlySeries, cumulativeSeries } = buildWeeklyMonthlyCumulativeSeries(
    dailyMap,
    heatmapWeeks,
    mergedRequests
  );
  const { costSummary, unpricedSummary, billingComparison } = buildCostAndUnpricedSummary(mergedRequests, extraUnpriced);

  return {
    sourceFilter,
    summary: {
      todayTokens,
      monthTokens,
      yearTokens,
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      totalSteps,
      totalConversations,
      earliestDate,
      activeDaysCount
    },
    dailyMap,
    heatmapWeeks,
    last7Days,
    weeklySeries,
    monthlySeries,
    cumulativeSeries,
    modelSpeedStats,
    speedSamples,
    speedSummaryByRange,
    costSummary,
    unpricedSummary,
    billingComparison,
    sources: {
      desktop: { conversationsCount: deskConvScan.count, transcriptsCount: deskTranscriptCount },
      cli: { dirExists: fs.existsSync(agCliDir), conversationsCount: cliConvScan.count, transcriptsCount: cliTranscriptCount }
    },
    scannedAt: new Date().toISOString()
  };
}

module.exports = {
  measureText,
  inspectImageBuffer,
  classifyError,
  listConversationsAndAudit,
  collectConversations,
  collectProjects,
  addCustomProject,
  getConversationDetail,
  updateConversationPrefs,
  deleteConversationPref,
  getTokenHistoryDashboard,
  getModelCtxOverrides,
  saveModelCtxOverrides,
  // 附带导出纯计算工具供 agy-runner 复用
  calculateRequestApiCost,
  normalizeModelId,
  formatTokensK,
  GEMINI_PRICING_TABLE,
  DEFAULT_CHECKPOINT_TOKENS
};
