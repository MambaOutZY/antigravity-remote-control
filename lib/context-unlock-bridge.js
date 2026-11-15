'use strict';

/**
 * CLI / Go 二进制上下文窗口门禁分析与解锁桥接模块 (零外部依赖，兼容 Windows / Ubuntu Linux / macOS)
 * -----------------------------------------------------------------------------------------------
 * 本模块从参考实现提炼并重整了针对 Go 编译产物（`agy` / `agy-real` / `language_server`）的
 * 只读诊断、备份管理、原子补丁写入与完整还原能力：
 *   - 容器解析：ELF64 (Linux x86-64/arm64)、Mach-O 64 (macOS)、PE64 (Windows)
 *   - 符号定位：Go `.gopclntab` (`0xFFFFFFF1` / `0xFFFFFFF0`)
 *   - 四道门禁：
 *     1. Gate 1 (`model.SelectorModel.offersContextWindow`)：放开模型上下文窗口选择器
 *     2. Gate 3A (`utils.GetCheckpointConfig`)：解除/改写 256K 硬钳位并调整默认阈值
 *     3. Gate 3B (`config.applyFeatureProviderCheckpointOverrideConfig`)：跳过实验特性覆盖回落判断
 *     4. Serializer (可选)：二进制序列化器内嵌 256K 上限常量的同步提升
 *
 * 严格约束：
 *   - 零外部 npm 依赖，仅使用 Node.js 内置模块
 *   - 无硬编码 Windows 盘符路径，全面使用 `os.homedir()` / `PATH` / 环境变量
 *   - 宿主机不存在目标二进制时，一律优雅返回 `{ available: false, reason }`，绝不抛出未捕获异常
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// ================================
// 1. 工程阈值与模式常量
// ================================

const DEFAULT_CHECKPOINT_TOKENS = 256000;
const MIN_ENGINEERING_LIMIT = 16384;
const MAX_ENGINEERING_LIMIT = 2097152;
const KNOWN_LIMIT_PRESETS = Object.freeze([256000, 512000, 524288, 900000, 983040, 1000000]);

// Go .gopclntab 魔数（小端字节序：Go 1.20+ 0xFFFFFFF1，Go 1.18~1.19 0xFFFFFFF0）
const PCLNTAB_MAGIC_V120 = Buffer.from([0xf1, 0xff, 0xff, 0xff, 0x00, 0x00]);
const PCLNTAB_MAGIC_V118 = Buffer.from([0xf0, 0xff, 0xff, 0xff, 0x00, 0x00]);

// Gate 1: 直接返回 true (x64: mov eax, 1; ret | arm64: mov w0, #1; ret)
const RET_TRUE_X64 = Buffer.from([0xb8, 0x01, 0x00, 0x00, 0x00, 0xc3]);
const RET_TRUE_ARM64 = Buffer.from([0x20, 0x00, 0x80, 0x52, 0xc0, 0x03, 0x5f, 0xd6]);

// Gate 3A (x64): cmp edx, 256000; mov esi, 256000; cmovb esi, edx (14 字节)
const CLAMP_256K_X64 = Buffer.from('81fa00e80300be00e803000f42f2', 'hex');
// Gate 3A (x64 动态放开): mov esi, edx; nop x 12 (14 字节)
const PATCH_256K_DYNAMIC_X64 = Buffer.concat([Buffer.from([0x89, 0xd6]), Buffer.alloc(12, 0x90)]);
// Gate 3A 默认值赋值前缀: mov dword ptr [rax+0xc], imm32 (3 字节前缀 + 4 字节小端常量)
const DEF_PREFIX_X64 = Buffer.from('c7400c', 'hex');
const DEF_ORIG_X64 = Buffer.from('c7400c00e80300', 'hex');

// Gate 3A (arm64): 256K 钳位指令序列 (24 字节) -> 动态放开为 6 条 NOP (1f 20 03 d5)
const CLAMP_256K_ARM64 = Buffer.from('04009dd26400a0f27f00046b04009dd26400a0f26330849a', 'hex');
const ARM64_NOP = Buffer.from([0x1f, 0x20, 0x03, 0xd5]);
const PATCH_256K_DYNAMIC_ARM64 = Buffer.concat([
  ARM64_NOP, ARM64_NOP, ARM64_NOP, ARM64_NOP, ARM64_NOP, ARM64_NOP,
]);

// Serializer (x64 可选门禁): 20 字节序列化器上下文上限检查特征
const SERIALIZER_STOCK_X64 = Buffer.from('4889442470488b8c24a80100008908b830000000', 'hex');

/**
 * 构造 x64 固定钳位机器码: mov esi, limitTokens; nop x 9 (14 字节)
 */
function buildClampConstX64(limitTokens) {
  const buf = Buffer.alloc(14, 0x90);
  buf[0] = 0xbe; // mov esi, imm32
  buf.writeUInt32LE(limitTokens >>> 0, 1);
  return buf;
}

/**
 * 构造 x64 默认阈值机器码: mov dword ptr [rax+0xc], limitTokens (7 字节)
 */
function buildDefConstX64(limitTokens) {
  const buf = Buffer.alloc(7);
  DEF_PREFIX_X64.copy(buf, 0);
  buf.writeUInt32LE(limitTokens >>> 0, 3);
  return buf;
}

/**
 * 构造 x64 序列化器补丁机器码 (20 字节)
 */
function buildSerializerConstX64(limitTokens) {
  const buf = Buffer.alloc(20);
  Buffer.from('4889442470c700', 'hex').copy(buf, 0); // mov [rsp+0x70], rax; mov dword ptr [rax], imm32
  buf.writeUInt32LE(limitTokens >>> 0, 7);
  Buffer.from('90909090b830000000', 'hex').copy(buf, 11);
  return buf;
}

// ================================
// 2. 路径、校验与通用工具函数
// ================================

function isExistingFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 校验用户输入的上下文限制数值是否处于安全工程区间 [16384, 2097152]
 */
function validateContextLimit(limitTokens) {
  const n = Number(limitTokens);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { valid: false, reason: `无效的上下文限制值: ${limitTokens}（必须为整数）` };
  }
  if (n < MIN_ENGINEERING_LIMIT || n > MAX_ENGINEERING_LIMIT) {
    return {
      valid: false,
      reason: `上下文限制值 ${n} 超出工程允许范围 [${MIN_ENGINEERING_LIMIT}, ${MAX_ENGINEERING_LIMIT}]`,
    };
  }
  return { valid: true, value: n };
}

/**
 * 若候选路径为包装脚本（例如 Ubuntu 下常见 `agy` shell/Node 包装器调用同目录或目标路径 `agy-real`），
 * 自动提取真正承载 Go 运行时的 `agy-real` 二进制路径。
 */
function resolveWrapperTarget(candidatePath) {
  try {
    const stat = fs.statSync(candidatePath);
    if (!stat.isFile()) return null;
    // 真实 Go 二进制通常在数 MB 到数十 MB；超过 256KB 直接视为二进制本体
    if (stat.size > 262144) return candidatePath;

    const head = fs.readFileSync(candidatePath);
    // 直接判断 ELF / Mach-O / PE 魔数
    const isElf = head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46;
    const isMachO = head.length >= 4 && head.readUInt32LE(0) === 0xfeedfacf;
    const isPe = head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a;
    if (isElf || isMachO || isPe) return candidatePath;

    // 文本包装脚本：优先解析文本中引用的 agy-real 路径，其次同目录 agy-real
    const text = head.toString('utf8');
    const dir = path.dirname(candidatePath);
    const execMatch =
      text.match(/exec\s+["']([^"']*agy-real(?:\.exe)?)["']/i) ||
      text.match(/([^\s"']+agy-real(?:\.exe)?)/i);
    if (execMatch && execMatch[1]) {
      const rawTarget = execMatch[1]
        .replace(/\$HOME|\$\{HOME\}/g, os.homedir())
        .replace(/^\$(?:0|\{0\})/, candidatePath);
      const resolved = path.isAbsolute(rawTarget) ? rawTarget : path.resolve(dir, rawTarget);
      if (isExistingFile(resolved)) return resolved;
    }

    for (const sibling of ['agy-real', 'agy-real.exe']) {
      const siblingPath = path.join(dir, sibling);
      if (isExistingFile(siblingPath)) return siblingPath;
    }
    return candidatePath;
  } catch {
    return null;
  }
}

/**
 * 跨平台探测目标 CLI 二进制（严格避免任何硬编码 Windows 绝对盘符路径）：
 *   1. 优先使用显式传入的 customBinaryPath 或环境变量 AGY_BIN / AGY_CLI_BIN
 *   2. 扫描 PATH 与标准用户安装目录，优先匹配 `agy-real` / `agy`
 */
function findCliBinary(customBinaryPath, opts = {}) {
  const homeDir = opts.homeDir || os.homedir();
  const explicit = customBinaryPath || process.env.AGY_BIN || process.env.AGY_CLI_BIN || null;
  const checkedPaths = [];

  if (explicit) {
    const resolvedExplicit = path.resolve(String(explicit));
    checkedPaths.push(resolvedExplicit);
    if (!isExistingFile(resolvedExplicit)) {
      return {
        found: false,
        binaryPath: null,
        checkedPaths,
        reason: `指定的 CLI 二进制路径不存在: ${resolvedExplicit}`,
      };
    }
    const target = resolveWrapperTarget(resolvedExplicit) || resolvedExplicit;
    return { found: true, binaryPath: target, wrapperPath: target !== resolvedExplicit ? resolvedExplicit : null, checkedPaths };
  }

  const exeNames = process.platform === 'win32'
    ? ['agy-real.exe', 'agy-real', 'agy.exe', 'agy']
    : ['agy-real', 'agy'];

  const searchDirs = [];
  const pushDir = (d) => {
    if (d && !searchDirs.includes(d)) searchDirs.push(d);
  };

  // 先查 PATH，再查常见的无特权用户与 Linux 全局安装路径
  const pathEnv = process.env.PATH || '';
  for (const entry of pathEnv.split(path.delimiter)) {
    if (entry && entry.trim()) pushDir(entry.trim());
  }
  pushDir(path.join(homeDir, '.local', 'bin'));
  pushDir(path.join(homeDir, 'bin'));
  pushDir(path.join(homeDir, '.antigravity', 'bin'));
  pushDir(path.join(homeDir, '.gemini', 'antigravity', 'bin'));
  pushDir(path.join(homeDir, '.npm-global', 'bin'));
  if (process.platform !== 'win32') {
    pushDir('/usr/local/bin');
    pushDir('/usr/bin');
    pushDir('/opt/agy/bin');
    pushDir('/opt/agy');
  }

  for (const dir of searchDirs) {
    for (const name of exeNames) {
      const candidate = path.join(dir, name);
      checkedPaths.push(candidate);
      if (!isExistingFile(candidate)) continue;
      const target = resolveWrapperTarget(candidate);
      if (target) {
        return {
          found: true,
          binaryPath: target,
          wrapperPath: target !== candidate ? candidate : null,
          checkedPaths,
        };
      }
    }
  }

  return {
    found: false,
    binaryPath: null,
    checkedPaths,
    reason: '当前宿主机未检测到 agy / agy-real CLI 二进制文件（可在设置中指定路径或安装 CLI）',
  };
}

// ================================
// 3. ELF / Mach-O / PE 容器与 Go .gopclntab 解析
// ================================

function readAsciiZ(buf, offset, maxLen = 256) {
  if (offset < 0 || offset >= buf.length) return '';
  let end = offset;
  const limit = Math.min(buf.length, offset + maxLen);
  while (end < limit && buf[end] !== 0) end++;
  return buf.slice(offset, end).toString('utf8');
}

/**
 * 解析二进制容器的指令集架构与代码段 (.text / __text) 映射关系
 */
function parseContainer(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 64) {
    return { ok: false, reason: '文件过小或非有效的可执行缓冲区' };
  }

  // 1) Mach-O 64-bit Little Endian (macOS arm64 / x64)
  if (buf.readUInt32LE(0) === 0xfeedfacf) {
    const cputype = buf.readUInt32LE(4);
    const arch = cputype === 0x0100000c ? 'arm64' : cputype === 0x01000007 ? 'x64' : null;
    if (!arch) return { ok: false, reason: `不支持的 Mach-O CPU 类型: 0x${cputype.toString(16)}` };
    const ncmds = buf.readUInt32LE(16);
    let pos = 32;
    for (let i = 0; i < ncmds; i++) {
      if (pos + 8 > buf.length) break;
      const cmd = buf.readUInt32LE(pos);
      const cmdsize = buf.readUInt32LE(pos + 4);
      if (cmdsize < 8) break;
      if (cmd === 0x19 && pos + 72 <= buf.length) {
        const nsects = buf.readUInt32LE(pos + 64);
        for (let s = 0; s < nsects; s++) {
          const secOff = pos + 72 + s * 80;
          if (secOff + 80 > buf.length) break;
          const sectname = readAsciiZ(buf, secOff, 16);
          const segname = readAsciiZ(buf, secOff + 16, 16);
          if (sectname === '__text' && segname === '__TEXT') {
            return {
              ok: true,
              format: 'macho',
              arch,
              textSection: {
                va: buf.readBigUInt64LE(secOff + 32),
                size: Number(buf.readBigUInt64LE(secOff + 40)),
                fileOff: buf.readUInt32LE(secOff + 48),
              },
            };
          }
        }
      }
      pos += cmdsize;
    }
    return { ok: false, reason: 'Mach-O 中未找到 __TEXT,__text 代码段' };
  }

  // 2) ELF64 Little Endian (Ubuntu / Linux x86-64 / arm64)
  if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
    if (buf[4] !== 2 || buf[5] !== 1) {
      return { ok: false, reason: '仅支持 64 位小端序 ELF 可执行文件' };
    }
    const machine = buf.readUInt16LE(18);
    const arch = machine === 0xb7 ? 'arm64' : machine === 0x3e ? 'x64' : null;
    if (!arch) return { ok: false, reason: `不支持的 ELF 架构 machine=0x${machine.toString(16)}` };

    const shoff = Number(buf.readBigUInt64LE(40));
    const shentsize = buf.readUInt16LE(58);
    const shnum = buf.readUInt16LE(60);
    const shstrndx = buf.readUInt16LE(62);
    if (!shoff || !shentsize || shstrndx >= shnum) {
      return { ok: false, reason: 'ELF 缺少有效的节区头表 (可能被极端裁剪)' };
    }
    const strtabHdr = shoff + shstrndx * shentsize;
    if (strtabHdr + 32 > buf.length) return { ok: false, reason: 'ELF 节区字符串表越界' };
    const strtabOff = Number(buf.readBigUInt64LE(strtabHdr + 24));

    for (let i = 0; i < shnum; i++) {
      const sh = shoff + i * shentsize;
      if (sh + 40 > buf.length) break;
      const nameIdx = buf.readUInt32LE(sh);
      const name = readAsciiZ(buf, strtabOff + nameIdx, 64);
      if (name === '.text') {
        return {
          ok: true,
          format: 'elf',
          arch,
          textSection: {
            va: buf.readBigUInt64LE(sh + 16),
            fileOff: Number(buf.readBigUInt64LE(sh + 24)),
            size: Number(buf.readBigUInt64LE(sh + 32)),
          },
        };
      }
    }
    return { ok: false, reason: 'ELF 中未找到 .text 代码段' };
  }

  // 3) PE64 (Windows x64 / arm64)
  if (buf[0] === 0x4d && buf[1] === 0x5a) {
    const peOff = buf.readUInt32LE(0x3c);
    if (peOff + 24 > buf.length || buf.slice(peOff, peOff + 4).toString('latin1') !== 'PE\x00\x00') {
      return { ok: false, reason: '无效的 PE 头结构' };
    }
    const machine = buf.readUInt16LE(peOff + 4);
    const arch = machine === 0x8664 ? 'x64' : machine === 0xaa64 ? 'arm64' : null;
    if (!arch) return { ok: false, reason: `不支持的 PE 架构 machine=0x${machine.toString(16)}` };

    const nsec = buf.readUInt16LE(peOff + 6);
    const optSize = buf.readUInt16LE(peOff + 20);
    const opt = peOff + 24;
    if (opt + 60 > buf.length || buf.readUInt16LE(opt) !== 0x20b) {
      return { ok: false, reason: '仅支持 PE32+ (64 位) Windows 可执行文件' };
    }
    const imageBase = buf.readBigUInt64LE(opt + 24);
    const secTable = opt + optSize;
    for (let i = 0; i < nsec; i++) {
      const sec = secTable + i * 40;
      if (sec + 40 > buf.length) break;
      const name = readAsciiZ(buf, sec, 8);
      if (name === '.text') {
        const vsize = buf.readUInt32LE(sec + 8);
        const vaddr = buf.readUInt32LE(sec + 12);
        const rawsize = buf.readUInt32LE(sec + 16);
        const rawptr = buf.readUInt32LE(sec + 20);
        return {
          ok: true,
          format: 'pe',
          arch,
          peTimeDateStamp: buf.readUInt32LE(peOff + 8),
          peSizeOfImage: buf.readUInt32LE(opt + 56),
          textSection: {
            va: imageBase + BigInt(vaddr),
            fileOff: rawptr,
            size: Math.min(rawsize || vsize, vsize || rawsize),
          },
        };
      }
    }
    return { ok: false, reason: 'PE 中未找到 .text 代码段' };
  }

  return { ok: false, reason: '未识别的可执行文件格式（既非 ELF64，也非 Mach-O 64 或 PE64）' };
}

/**
 * 在二进制中扫描并校验 Go `.gopclntab` 元数据表（兼容 PIE / Windows PE 重定位后的符号表）
 */
function findPclntab(buf, textSec = null) {
  for (const magic of [PCLNTAB_MAGIC_V120, PCLNTAB_MAGIC_V118]) {
    let pos = 0;
    while (pos < buf.length - 72) {
      const idx = buf.indexOf(magic, pos);
      if (idx < 0) break;
      pos = idx + 1;
      if (idx + 72 > buf.length) continue;

      const minLC = buf[idx + 6];
      const ptrSize = buf[idx + 7];
      if (![1, 2, 4].includes(minLC) || ptrSize !== 8) continue;

      const nfunc = Number(buf.readBigUInt64LE(idx + 8));
      if (!Number.isFinite(nfunc) || nfunc < 50 || nfunc > 5000000) continue;

      const fnOff = Number(buf.readBigUInt64LE(idx + 32));
      const pclnOff = Number(buf.readBigUInt64LE(idx + 64));
      const fnstart = idx + fnOff;
      const pcln = idx + pclnOff;
      if (fnOff <= 0 || fnstart < 0 || fnstart + 16 >= buf.length) continue;
      if (pclnOff < 64 || pcln < 0 || pcln + (nfunc + 1) * 8 > buf.length) continue;

      // 校验 funcname 表头部（允许索引 0 处保留前导 \0，其余应为可读 ASCII）
      const head = buf.subarray(fnstart, fnstart + 16);
      let validChars = true;
      let hasPrintable = false;
      for (const b of head) {
        if (b >= 0x20 && b < 0x7f) {
          hasPrintable = true;
        } else if (b !== 0) {
          validChars = false;
          break;
        }
      }
      if (!validChars || !hasPrintable) continue;

      // 结合代码段大小做额外合法性校验，避免巧合命中伪表
      if (textSec && textSec.size > 0) {
        const firstEntry = buf.readUInt32LE(pcln);
        if (firstEntry >= textSec.size) continue;
      }

      return { base: idx, nfunc, fnstart, pcln };
    }
  }
  return null;
}

/**
 * 构建 Go 函数表:
 * Go 1.18+ ftab 中的 entryoff 是相对于代码段 (.text) 起始处的偏移，
 * 直接叠加 textSec.fileOff / textSec.va，避免 PIE/PE 重定位导致 pclntab.textStart 失配。
 */
function buildFunctions(buf, pclntab, textSec) {
  const { nfunc, fnstart, pcln } = pclntab;
  const funcs = [];

  for (let i = 0; i < nfunc; i++) {
    const off = pcln + i * 8;
    if (off + 12 > buf.length) break;

    const entryOff = buf.readUInt32LE(off);
    const funcMetaOff = buf.readUInt32LE(off + 4);
    const nextEntryOff = buf.readUInt32LE(off + 8);

    const metaAbs = pcln + funcMetaOff;
    if (metaAbs + 8 > buf.length) continue;
    const nameOff = buf.readInt32LE(metaAbs + 4);
    const nameAbs = fnstart + nameOff;
    if (nameAbs < 0 || nameAbs >= buf.length) continue;

    const name = readAsciiZ(buf, nameAbs, 512);
    if (!name) continue;

    const fileOff = textSec.fileOff + entryOff;
    const va = textSec.va + BigInt(entryOff);
    const endVa = textSec.va + BigInt(nextEntryOff);
    const size = nextEntryOff > entryOff ? nextEntryOff - entryOff : 0;
    if (fileOff < textSec.fileOff || fileOff >= buf.length || size <= 0) continue;

    funcs.push({ name, shortName: name.split('/').pop(), va, endVa, fileOff, size });
  }
  return funcs;
}

/**
 * 按符号后缀精准匹配 Go 函数（兼容带完整 Go module 前缀的符号名）
 */
function findGoSymbol(funcs, suffixCandidates) {
  for (const target of suffixCandidates) {
    const exact = funcs.find((f) => f.shortName === target || f.name === target);
    if (exact) return exact;
  }
  for (const target of suffixCandidates) {
    const suffix = funcs.find(
      (f) => f.name.endsWith('/' + target) || f.name.endsWith('.' + target) || f.name.endsWith(target)
    );
    if (suffix) return suffix;
  }
  return null;
}

// ================================
// 4. 四道门禁检查与补丁规划逻辑
// ================================

function findAllOccurrences(haystack, needle, baseOffset = 0) {
  const hits = [];
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    hits.push(baseOffset + idx);
    pos = idx + 1;
  }
  return hits;
}

/**
 * Gate 1: model.SelectorModel.offersContextWindow
 */
function checkGate1(buf, funcs, arch) {
  const sym = findGoSymbol(funcs, [
    'model.SelectorModel.offersContextWindow',
    'model.(*SelectorModel).offersContextWindow',
  ]);
  if (!sym) return { applicable: false, state: 'absent', reason: '未包含 offersContextWindow 符号' };

  const expected = arch === 'arm64' ? RET_TRUE_ARM64 : RET_TRUE_X64;
  if (sym.fileOff + expected.length > buf.length) {
    return { applicable: false, state: 'invalid', reason: 'Gate 1 函数区间越界' };
  }
  const head = buf.slice(sym.fileOff, sym.fileOff + expected.length);
  const patched = head.equals(expected);
  return {
    applicable: true,
    symbol: sym.name,
    fileOff: sym.fileOff,
    patchLen: expected.length,
    patchedBytesHex: expected.toString('hex'),
    currentBytesHex: head.toString('hex'),
    state: patched ? 'patched' : 'stock',
    patched,
  };
}

/**
 * Gate 3A: utils.GetCheckpointConfig 256K 钳位 + 默认阈值位置识别与消歧
 */
function checkGate3A(buf, funcs, arch) {
  const sym = findGoSymbol(funcs, ['utils.GetCheckpointConfig']);
  if (!sym) return { applicable: false, state: 'absent', reason: '未包含 utils.GetCheckpointConfig 符号' };

  const endOff = Math.min(buf.length, sym.fileOff + sym.size);
  const fnSlice = buf.slice(sym.fileOff, endOff);

  if (arch === 'arm64') {
    const stockHits = findAllOccurrences(fnSlice, CLAMP_256K_ARM64, sym.fileOff);
    const dynHits = findAllOccurrences(fnSlice, PATCH_256K_DYNAMIC_ARM64, sym.fileOff);
    if (stockHits.length === 1 && dynHits.length === 0) {
      return {
        applicable: true,
        symbol: sym.name,
        arch,
        clampFileOff: stockHits[0],
        clampLen: CLAMP_256K_ARM64.length,
        clampState: 'stock',
        defaultFileOff: null,
        defaultLimit: DEFAULT_CHECKPOINT_TOKENS,
        state: 'stock',
        mode: 'default',
      };
    }
    if (dynHits.length === 1 && stockHits.length === 0) {
      return {
        applicable: true,
        symbol: sym.name,
        arch,
        clampFileOff: dynHits[0],
        clampLen: CLAMP_256K_ARM64.length,
        clampState: 'dynamic',
        defaultFileOff: null,
        defaultLimit: null,
        state: 'dynamic',
        mode: 'dynamic',
      };
    }
    return {
      applicable: false,
      symbol: sym.name,
      state: 'ambiguous',
      reason: `ARM64 Gate 3A 特征命中异常 (stock=${stockHits.length}, dyn=${dynHits.length})`,
    };
  }

  // x86-64: 先识别钳位点（原厂 / 动态放开 / 已知预设常量）
  let clampFileOff = -1;
  let clampState = 'unknown';
  let clampLimit = null;

  const stockClamp = findAllOccurrences(fnSlice, CLAMP_256K_X64, sym.fileOff);
  const dynClamp = findAllOccurrences(fnSlice, PATCH_256K_DYNAMIC_X64, sym.fileOff);

  if (stockClamp.length === 1) {
    clampFileOff = stockClamp[0];
    clampState = 'stock';
    clampLimit = DEFAULT_CHECKPOINT_TOKENS;
  } else if (dynClamp.length === 1) {
    clampFileOff = dynClamp[0];
    clampState = 'dynamic';
  } else {
    // 识别可能已经写入的 0xbe <imm32> + 9x nop 固定钳位
    for (let i = 0; i <= fnSlice.length - 14; i++) {
      if (fnSlice[i] !== 0xbe) continue;
      let allNop = true;
      for (let k = 5; k < 14; k++) {
        if (fnSlice[i + k] !== 0x90) {
          allNop = false;
          break;
        }
      }
      if (!allNop) continue;
      const val = fnSlice.readUInt32LE(i + 1);
      if (val >= MIN_ENGINEERING_LIMIT && val <= MAX_ENGINEERING_LIMIT) {
        clampFileOff = sym.fileOff + i;
        clampState = 'fixed';
        clampLimit = val;
        break;
      }
    }
  }

  if (clampFileOff < 0) {
    return { applicable: false, symbol: sym.name, state: 'unmatched', reason: '未在 GetCheckpointConfig 中定位到 x64 钳位指令' };
  }

  // 再定位默认值赋值点: c7 40 0c <imm32> (并通过前序 cmp/jcc 守卫指令消歧)
  const defCandidates = [];
  for (let i = 0; i <= fnSlice.length - 7; i++) {
    if (fnSlice[i] === 0xc7 && fnSlice[i + 1] === 0x40 && fnSlice[i + 2] === 0x0c) {
      const val = fnSlice.readUInt32LE(i + 3);
      if (val >= MIN_ENGINEERING_LIMIT && val <= MAX_ENGINEERING_LIMIT) {
        defCandidates.push({ fileOff: sym.fileOff + i, rel: i, value: val });
      }
    }
  }

  let chosenDef = null;
  if (defCandidates.length === 1) {
    chosenDef = defCandidates[0];
  } else if (defCandidates.length > 1) {
    // 1) 优先精确匹配守卫序列 83 7a 14 00 7f 07
    const strictGuard = Buffer.from([0x83, 0x7a, 0x14, 0x00, 0x7f, 0x07]);
    const guardMatches = defCandidates.filter(
      (c) => c.rel >= 6 && fnSlice.slice(c.rel - 6, c.rel).equals(strictGuard)
    );
    if (guardMatches.length === 1) {
      chosenDef = guardMatches[0];
    } else {
      // 2) 回落匹配短跳转 0x70..0x7f 0x07
      const shortJccMatches = defCandidates.filter(
        (c) => c.rel >= 2 && fnSlice[c.rel - 2] >= 0x70 && fnSlice[c.rel - 2] <= 0x7f && fnSlice[c.rel - 1] === 0x07
      );
      if (shortJccMatches.length === 1) {
        chosenDef = shortJccMatches[0];
      } else {
        // 3) 再回落 ±8192 字节窗口内距钳位点最近者
        const nearby = defCandidates
          .filter((c) => Math.abs(c.fileOff - clampFileOff) <= 8192)
          .sort((a, b) => Math.abs(a.fileOff - clampFileOff) - Math.abs(b.fileOff - clampFileOff));
        if (nearby.length > 0) chosenDef = nearby[0];
      }
    }
  }

  let mode = 'default';
  if (clampState === 'dynamic') mode = 'dynamic';
  else if (clampState === 'fixed') mode = 'fixed';
  else if (chosenDef && chosenDef.value !== DEFAULT_CHECKPOINT_TOKENS) mode = 'fixed';

  return {
    applicable: true,
    symbol: sym.name,
    arch,
    clampFileOff,
    clampLen: 14,
    clampState,
    clampLimit,
    defaultFileOff: chosenDef ? chosenDef.fileOff : null,
    defaultLen: 7,
    defaultLimit: chosenDef ? chosenDef.value : null,
    state: clampState,
    mode,
  };
}

/**
 * Gate 3B (x64): config.applyFeatureProviderCheckpointOverrideConfig -> call selectCheckpointExperimentKey -> test al, al -> jcc
 */
function checkGate3B(buf, funcs, arch, textSec, savedSidecar) {
  if (arch !== 'x64') {
    return { applicable: false, state: 'unsupported_arch', reason: `Gate 3B 当前仅检查 x64 指令 (${arch})` };
  }
  const symExp = findGoSymbol(funcs, ['config.applyFeatureProviderCheckpointOverrideConfig']);
  const symSel = findGoSymbol(funcs, ['config.selectCheckpointExperimentKey']);
  if (!symExp || !symSel) {
    return { applicable: false, state: 'absent', reason: '未包含 Gate 3B 对应符号' };
  }

  const start = symExp.fileOff;
  const end = Math.min(buf.length, start + symExp.size);
  const hits = [];

  for (let off = start; off <= end - 8; off++) {
    if (buf[off] !== 0xe8) continue;
    const rel = buf.readInt32LE(off + 1);
    const callVA = textSec.va + BigInt(off - textSec.fileOff);
    const targetVA = callVA + 5n + BigInt(rel);
    if (targetVA !== symSel.va) continue;

    // 在 call 返回后最多 105 字节内搜索 test al, al (84 c0)
    const searchEnd = Math.min(end - 2, off + 5 + 105);
    for (let t = off + 5; t <= searchEnd; t++) {
      if (buf[t] !== 0x84 || buf[t + 1] !== 0xc0) continue;
      const jOff = t + 2;
      if (jOff + 2 > buf.length) break;

      if (buf[jOff] === 0x75) {
        hits.push({ fileOff: jOff, len: 2, state: 'stock', origBytesHex: buf.slice(jOff, jOff + 2).toString('hex') });
      } else if (jOff + 6 <= buf.length && buf[jOff] === 0x0f && buf[jOff + 1] === 0x85) {
        hits.push({ fileOff: jOff, len: 6, state: 'stock', origBytesHex: buf.slice(jOff, jOff + 6).toString('hex') });
      } else if (buf[jOff] === 0x90 && buf[jOff + 1] === 0x90) {
        const sixNops = jOff + 6 <= buf.length && buf.slice(jOff, jOff + 6).every((b) => b === 0x90);
        const sidecarLen = savedSidecar && savedSidecar.fileOff === jOff ? savedSidecar.len : (sixNops ? 6 : 2);
        hits.push({
          fileOff: jOff,
          len: sidecarLen,
          state: 'patched',
          origBytesHex: savedSidecar && savedSidecar.fileOff === jOff ? savedSidecar.origBytesHex : null,
        });
      }
      break;
    }
  }

  if (hits.length !== 1) {
    return {
      applicable: false,
      symbol: symExp.name,
      state: 'ambiguous',
      reason: `Gate 3B 调用点命中数量不为 1 (hits=${hits.length})`,
    };
  }

  const hit = hits[0];
  return {
    applicable: true,
    symbol: symExp.name,
    callee: symSel.name,
    fileOff: hit.fileOff,
    len: hit.len,
    state: hit.state,
    patched: hit.state === 'patched',
    origBytesHex: hit.origBytesHex,
  };
}

/**
 * Serializer Gate (x64 可选): 检查序列化器内嵌 256K 上限特征
 */
function checkSerializerGate(buf, arch, savedSidecar) {
  if (arch !== 'x64') return { applicable: false, state: 'unsupported_arch' };
  const stockHits = findAllOccurrences(buf, SERIALIZER_STOCK_X64, 0);
  if (stockHits.length === 1) {
    return {
      applicable: true,
      fileOff: stockHits[0],
      len: 20,
      state: 'stock',
      limitTokens: DEFAULT_CHECKPOINT_TOKENS,
    };
  }
  if (savedSidecar && Number.isInteger(savedSidecar.fileOff)) {
    const slice = buf.slice(savedSidecar.fileOff, savedSidecar.fileOff + 20);
    if (slice.length === 20 && slice.slice(0, 7).equals(Buffer.from('4889442470c700', 'hex'))) {
      return {
        applicable: true,
        fileOff: savedSidecar.fileOff,
        len: 20,
        state: 'patched',
        limitTokens: slice.readUInt32LE(7),
      };
    }
  }
  return { applicable: false, state: 'absent' };
}

// ================================
// 5. 备份管理、原子写入与外部配置同步
// ================================

function getBackupDir(opts = {}) {
  if (opts.backupDir) return path.resolve(opts.backupDir);
  if (process.env.AGY_UNLOCK_DIR) return path.resolve(process.env.AGY_UNLOCK_DIR);
  const homeDir = opts.homeDir || os.homedir();
  return path.join(homeDir, '.gemini', 'antigravity', 'backups', 'cli-context-unlock');
}

function getBackupPaths(binaryPath, opts = {}) {
  const backupDir = getBackupDir(opts);
  const slug = crypto.createHash('sha1').update(path.resolve(binaryPath)).digest('hex').slice(0, 12);
  const baseName = path.basename(binaryPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = path.join(backupDir, `${baseName}-${slug}`);
  return {
    dir,
    manifestFile: path.join(dir, 'manifest.json'),
    origFile: path.join(dir, `${baseName}.orig`),
  };
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * 原子覆盖目标二进制，保留 POSIX 可执行权限并在 macOS 上重新 ad-hoc 签名
 */
function atomicWriteBinary(targetPath, newBuffer) {
  const stat = fs.statSync(targetPath);
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}`);

  fs.writeFileSync(tmpPath, newBuffer);
  if (process.platform !== 'win32') {
    fs.chmodSync(tmpPath, stat.mode & 0o7777);
  }

  try {
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Windows 下正在占用或权限重命名冲突时，先将旧文件挪为 .old_ 再写入
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EEXIST')) {
      const oldPath = `${targetPath}.old_${process.pid}_${Date.now()}`;
      try {
        fs.renameSync(targetPath, oldPath);
        fs.renameSync(tmpPath, targetPath);
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // Windows 若旧进程仍持句柄，允许 .old_ 文件延后清理
        }
      } catch (innerErr) {
        try { fs.unlinkSync(tmpPath); } catch {}
        throw innerErr;
      }
    } else {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw err;
    }
  }

  // macOS 下篡改二进制后必须补签 ad-hoc 签名，否则内核 AMFI 会杀进程
  if (process.platform === 'darwin') {
    try {
      execFileSync('codesign', ['--force', '--sign', '-', targetPath], { stdio: 'ignore' });
    } catch {
      // codesign 不可用时忽略，交由状态报告提示
    }
  }
}

/**
 * 在真实用户配置场景下按需同步 CLI settings.json 的 contextWindow 字段（隔离测试不主动污染宿主目录）
 */
function syncExternalContextConfigs(mode, limitTokens, opts = {}) {
  const shouldSync = opts.syncConfigs === true || (!opts.backupDir && !opts.customPathExplicit);
  if (!shouldSync) return { synced: false, skipped: true };

  const homeDir = opts.homeDir || os.homedir();
  const candidates = [
    path.join(homeDir, '.gemini', 'antigravity', 'settings.json'),
    path.join(homeDir, '.gemini', 'settings.json'),
  ];
  const updatedFiles = [];

  for (const cfgPath of candidates) {
    if (!isExistingFile(cfgPath)) continue;
    const parsed = readJsonSafe(cfgPath);
    if (!parsed || typeof parsed !== 'object') continue;

    if (mode === 'default') {
      if (!Object.prototype.hasOwnProperty.call(parsed, 'contextWindow')) continue;
      delete parsed.contextWindow;
    } else if (Number.isInteger(limitTokens) && limitTokens > 0) {
      parsed.contextWindow = limitTokens;
    } else {
      continue;
    }

    try {
      writeJsonAtomic(cfgPath, parsed);
      updatedFiles.push(cfgPath);
    } catch {
      // 只读配置跳过，不阻断主流程
    }
  }

  return { synced: true, updatedFiles };
}

// ================================
// 6. 内部诊断引擎（串联容器 -> 符号 -> 四道门禁）
// ================================

function analyzeBinaryFile(binaryPath, opts = {}) {
  const buf = fs.readFileSync(binaryPath);
  const sha256 = sha256Buffer(buf);
  const container = parseContainer(buf);
  if (!container.ok) {
    return { ok: false, available: false, reason: container.reason, binaryPath, sha256 };
  }

  const pclntab = findPclntab(buf, container.textSection);
  if (!pclntab) {
    return {
      ok: false,
      available: false,
      reason: '未在二进制中定位到 Go .gopclntab 符号表（目标可能不是 Go 编译产物）',
      binaryPath,
      format: container.format,
      arch: container.arch,
      sha256,
    };
  }

  const funcs = buildFunctions(buf, pclntab, container.textSection);
  const backupPaths = getBackupPaths(binaryPath, opts);
  const manifest = readJsonSafe(backupPaths.manifestFile);

  const gate1 = checkGate1(buf, funcs, container.arch);
  const gate3A = checkGate3A(buf, funcs, container.arch);
  const gate3B = checkGate3B(buf, funcs, container.arch, container.textSection, manifest && manifest.gate3b);
  const serializer = checkSerializerGate(buf, container.arch, manifest && manifest.serializer);

  const hasAnyGate = gate1.applicable || gate3A.applicable || gate3B.applicable;
  if (!hasAnyGate) {
    return {
      ok: false,
      available: false,
      reason: 'Go 符号表中未找到任何 256K 上下文门禁相关函数（版本可能暂不匹配）',
      binaryPath,
      format: container.format,
      arch: container.arch,
      sha256,
      gates: { gate1, gate3A, gate3B, serializer },
    };
  }

  // 综合推导当前解锁状态与生效上限
  let mode = 'default';
  if (gate3A.applicable) {
    mode = gate3A.mode;
  } else if ((gate1.applicable && gate1.patched) || (gate3B.applicable && gate3B.patched)) {
    mode = 'dynamic';
  }

  const unlocked =
    (gate3A.applicable ? gate3A.mode !== 'default' : false) ||
    (gate1.applicable ? gate1.patched : false) ||
    (gate3B.applicable ? gate3B.patched : false);

  const effectiveLimit =
    gate3A.applicable && gate3A.mode === 'fixed'
      ? (gate3A.clampLimit || gate3A.defaultLimit)
      : gate3A.applicable && gate3A.mode === 'dynamic'
        ? (gate3A.defaultLimit && gate3A.defaultLimit !== DEFAULT_CHECKPOINT_TOKENS ? gate3A.defaultLimit : null)
        : DEFAULT_CHECKPOINT_TOKENS;

  return {
    ok: true,
    available: true,
    binaryPath,
    format: container.format,
    arch: container.arch,
    sizeBytes: buf.length,
    sha256,
    unlocked,
    patched: unlocked,
    mode,
    limitTokens: effectiveLimit,
    hasBackup: isExistingFile(backupPaths.origFile) || Boolean(manifest),
    backupManifest: manifest || null,
    gates: { gate1, gate3A, gate3B, serializer },
    _buf: buf,
    _backupPaths: backupPaths,
  };
}

function buildPublicStatus(analysis, discovery) {
  const { _buf, _backupPaths, ...clean } = analysis;
  return {
    ...clean,
    wrapperPath: discovery.wrapperPath || null,
    defaultCheckpointTokens: DEFAULT_CHECKPOINT_TOKENS,
    minEngineeringLimit: MIN_ENGINEERING_LIMIT,
    maxEngineeringLimit: MAX_ENGINEERING_LIMIT,
    knownPresets: KNOWN_LIMIT_PRESETS,
  };
}

// ================================
// 7. 公开导出 API
// ================================

/**
 * 查询当前宿主机 CLI (agy / agy-real) 上下文窗口解锁状态
 * 当二进制缺失或解析失败时，优雅返回 { available: false, reason }，绝不抛出未捕获异常
 */
function getCliUnlockStatus(customBinaryPath = null, opts = {}) {
  try {
    let binaryArg = customBinaryPath;
    let mergedOpts = opts;
    if (customBinaryPath && typeof customBinaryPath === 'object' && !Array.isArray(customBinaryPath)) {
      mergedOpts = customBinaryPath;
      binaryArg = mergedOpts.binaryPath || null;
    }

    const discovery = findCliBinary(binaryArg, mergedOpts);
    if (!discovery.found) {
      return {
        ok: false,
        available: false,
        unlocked: false,
        patched: false,
        mode: 'unavailable',
        binaryPath: null,
        reason: discovery.reason,
        checkedPaths: discovery.checkedPaths,
      };
    }

    const analysis = analyzeBinaryFile(discovery.binaryPath, mergedOpts);
    if (!analysis.ok) {
      return {
        ...analysis,
        available: false,
        unlocked: false,
        patched: false,
        mode: 'unavailable',
        wrapperPath: discovery.wrapperPath || null,
      };
    }

    return buildPublicStatus(analysis, discovery);
  } catch (err) {
    return {
      ok: false,
      available: false,
      unlocked: false,
      patched: false,
      mode: 'error',
      binaryPath: null,
      reason: `检查 CLI 上下文状态失败: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/**
 * 对目标二进制应用上下文解锁补丁：
 *   - mode: 'dynamic' | 'fixed' | 'default' (也兼容 'unlock' / 'restore' / 'stock')
 *   - limitTokens: 在 'fixed' 模式下必填，'dynamic' 模式下可选指定默认回退阈值
 */
function applyCliContextUnlock({ mode = 'dynamic', limitTokens = null, binaryPath = null, ...opts } = {}) {
  try {
    const normalizedMode = String(mode || 'dynamic').toLowerCase();
    if (normalizedMode === 'default' || normalizedMode === 'restore' || normalizedMode === 'stock') {
      return restoreCliContextUnlock({ binaryPath, ...opts });
    }
    const targetMode = normalizedMode === 'unlock' ? 'dynamic' : normalizedMode;
    if (targetMode !== 'dynamic' && targetMode !== 'fixed') {
      return { ok: false, available: true, reason: `不支持的解锁模式: ${mode}（仅支持 dynamic / fixed / default）` };
    }

    let validatedLimit = null;
    if (targetMode === 'fixed' || (limitTokens !== null && limitTokens !== undefined && limitTokens !== '')) {
      const check = validateContextLimit(limitTokens);
      if (!check.valid) return { ok: false, available: true, reason: check.reason };
      validatedLimit = check.value;
    }

    const discovery = findCliBinary(binaryPath, opts);
    if (!discovery.found) {
      return {
        ok: false,
        available: false,
        unlocked: false,
        patched: false,
        binaryPath: null,
        reason: discovery.reason,
      };
    }

    const analysis = analyzeBinaryFile(discovery.binaryPath, opts);
    if (!analysis.ok) {
      return { ...analysis, ok: false, available: false, unlocked: false, patched: false };
    }

    if (targetMode === 'fixed' && analysis.arch === 'arm64' && analysis.gates.gate3A.applicable) {
      return {
        ok: false,
        available: true,
        binaryPath: analysis.binaryPath,
        reason: 'ARM64 架构下暂仅支持 dynamic 动态放开模式（避免改写 64 位寄存器双指令常量产生副作用）',
      };
    }

    const { _buf: origBuf, _backupPaths: backupPaths, gates } = analysis;
    const patchedBuf = Buffer.from(origBuf);

    // 首次打补丁前创建原始二进制备份与可逆元数据清单
    let manifest = analysis.backupManifest || readJsonSafe(backupPaths.manifestFile);
    if (!isExistingFile(backupPaths.origFile) || !manifest) {
      fs.mkdirSync(backupPaths.dir, { recursive: true });
      fs.writeFileSync(backupPaths.origFile, origBuf);
      manifest = {
        binaryPath: analysis.binaryPath,
        format: analysis.format,
        arch: analysis.arch,
        sha256Orig: analysis.sha256,
        createdAt: new Date().toISOString(),
        backupFile: backupPaths.origFile,
      };
    }

    const appliedActions = [];

    // 1) Gate 1: offersContextWindow -> ret true
    if (gates.gate1.applicable) {
      if (!manifest.gate1) {
        manifest.gate1 = {
          fileOff: gates.gate1.fileOff,
          len: gates.gate1.patchLen,
          origBytesHex: gates.gate1.currentBytesHex,
        };
      }
      Buffer.from(gates.gate1.patchedBytesHex, 'hex').copy(patchedBuf, gates.gate1.fileOff);
      appliedActions.push('gate1:offersContextWindow->true');
    }

    // 2) Gate 3A: clamp 与默认值改写
    if (gates.gate3A.applicable) {
      const g3a = gates.gate3A;
      if (analysis.arch === 'arm64') {
        PATCH_256K_DYNAMIC_ARM64.copy(patchedBuf, g3a.clampFileOff);
        appliedActions.push('gate3A:arm64_clamp->dynamic');
      } else {
        if (targetMode === 'dynamic') {
          PATCH_256K_DYNAMIC_X64.copy(patchedBuf, g3a.clampFileOff);
          appliedActions.push('gate3A:x64_clamp->dynamic');
        } else {
          buildClampConstX64(validatedLimit).copy(patchedBuf, g3a.clampFileOff);
          appliedActions.push(`gate3A:x64_clamp->fixed(${validatedLimit})`);
        }
        if (g3a.defaultFileOff !== null && g3a.defaultFileOff >= 0) {
          const defVal = validatedLimit || DEFAULT_CHECKPOINT_TOKENS;
          buildDefConstX64(defVal).copy(patchedBuf, g3a.defaultFileOff);
          appliedActions.push(`gate3A:x64_default->${defVal}`);
        }
      }
    }

    // 3) Gate 3B: experiment check jcc -> NOP
    if (gates.gate3B.applicable) {
      const g3b = gates.gate3B;
      if (!manifest.gate3b && g3b.origBytesHex) {
        manifest.gate3b = {
          fileOff: g3b.fileOff,
          len: g3b.len,
          origBytesHex: g3b.origBytesHex,
        };
      }
      Buffer.alloc(g3b.len, 0x90).copy(patchedBuf, g3b.fileOff);
      appliedActions.push('gate3B:override_jcc->nop');
    }

    // 4) Serializer 可选门禁 (仅 fixed 或显式 limitTokens 时提升上限)
    if (gates.serializer.applicable && validatedLimit) {
      if (!manifest.serializer) {
        manifest.serializer = {
          fileOff: gates.serializer.fileOff,
          len: 20,
          origBytesHex: SERIALIZER_STOCK_X64.toString('hex'),
        };
      }
      buildSerializerConstX64(validatedLimit).copy(patchedBuf, gates.serializer.fileOff);
      appliedActions.push(`serializer->${validatedLimit}`);
    }

    manifest.lastAppliedAt = new Date().toISOString();
    manifest.lastMode = targetMode;
    manifest.lastLimitTokens = validatedLimit;
    writeJsonAtomic(backupPaths.manifestFile, manifest);

    atomicWriteBinary(analysis.binaryPath, patchedBuf);
    const configSync = syncExternalContextConfigs(targetMode, validatedLimit, {
      ...opts,
      customPathExplicit: Boolean(binaryPath),
    });

    const refreshed = analyzeBinaryFile(analysis.binaryPath, opts);
    return {
      ...buildPublicStatus(refreshed.ok ? refreshed : analysis, discovery),
      ok: true,
      appliedActions,
      configSync,
    };
  } catch (err) {
    return {
      ok: false,
      available: true,
      reason: `应用 CLI 上下文解锁失败: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

/**
 * 从备份完整还原（若 .orig 丢失，则降级按 manifest 中记录的原厂字节精确回滚）
 */
function restoreCliContextUnlock({ binaryPath = null, ...opts } = {}) {
  try {
    const discovery = findCliBinary(binaryPath, opts);
    if (!discovery.found) {
      return {
        ok: false,
        available: false,
        unlocked: false,
        patched: false,
        binaryPath: null,
        reason: discovery.reason,
      };
    }

    const targetPath = discovery.binaryPath;
    const backupPaths = getBackupPaths(targetPath, opts);
    const manifest = readJsonSafe(backupPaths.manifestFile);

    if (isExistingFile(backupPaths.origFile)) {
      const origBuf = fs.readFileSync(backupPaths.origFile);
      atomicWriteBinary(targetPath, origBuf);
    } else {
      // 无完整 .orig 时，根据当前分析与 manifest 原厂片段回滚
      const analysis = analyzeBinaryFile(targetPath, opts);
      if (!analysis.ok) return { ...analysis, ok: false, available: false };
      const restoreBuf = Buffer.from(analysis._buf);
      const { gates } = analysis;

      if (gates.gate1.applicable && manifest && manifest.gate1 && manifest.gate1.origBytesHex) {
        Buffer.from(manifest.gate1.origBytesHex, 'hex').copy(restoreBuf, manifest.gate1.fileOff);
      }
      if (gates.gate3A.applicable) {
        if (analysis.arch === 'arm64') {
          CLAMP_256K_ARM64.copy(restoreBuf, gates.gate3A.clampFileOff);
        } else {
          CLAMP_256K_X64.copy(restoreBuf, gates.gate3A.clampFileOff);
          if (gates.gate3A.defaultFileOff !== null) {
            DEF_ORIG_X64.copy(restoreBuf, gates.gate3A.defaultFileOff);
          }
        }
      }
      if (gates.gate3B.applicable && manifest && manifest.gate3b && manifest.gate3b.origBytesHex) {
        Buffer.from(manifest.gate3b.origBytesHex, 'hex').copy(restoreBuf, manifest.gate3b.fileOff);
      }
      if (manifest && manifest.serializer && manifest.serializer.origBytesHex) {
        Buffer.from(manifest.serializer.origBytesHex, 'hex').copy(restoreBuf, manifest.serializer.fileOff);
      }
      atomicWriteBinary(targetPath, restoreBuf);
    }

    const configSync = syncExternalContextConfigs('default', DEFAULT_CHECKPOINT_TOKENS, {
      ...opts,
      customPathExplicit: Boolean(binaryPath),
    });

    const refreshed = analyzeBinaryFile(targetPath, opts);
    if (!refreshed.ok) {
      return { ok: true, available: true, unlocked: false, patched: false, mode: 'default', binaryPath: targetPath, configSync };
    }
    return {
      ...buildPublicStatus(refreshed, discovery),
      ok: true,
      restored: true,
      configSync,
    };
  } catch (err) {
    return {
      ok: false,
      available: true,
      reason: `还原 CLI 二进制失败: ${err && err.message ? err.message : String(err)}`,
    };
  }
}

module.exports = {
  DEFAULT_CHECKPOINT_TOKENS,
  MIN_ENGINEERING_LIMIT,
  MAX_ENGINEERING_LIMIT,
  KNOWN_LIMIT_PRESETS,
  validateContextLimit,
  findCliBinary,
  getCliUnlockStatus,
  applyCliContextUnlock,
  restoreCliContextUnlock,
};
