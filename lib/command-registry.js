/**
 * Antigravity CLI Remote Control 官方指令与上下文提及注册表 (lib/command-registry.js)
 * 聚合系统级 Slash Commands、MCP 扩展工具与 @ Context Mentions
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 1. 官方核心 Slash Commands（与 Antigravity 原生 CLI 规范 100% 对齐）
const SYSTEM_SLASH_COMMANDS = [
  {
    name: 'goal',
    prefix: '/',
    kind: 'command',
    icon: 'goal',
    description: 'Run until the specified goal is completely finished.'
  },
  {
    name: 'compact',
    prefix: '/',
    kind: 'command',
    icon: 'compact',
    description: 'Compact the conversation now (summarize history to free up the context window).'
  },
  {
    name: 'plan',
    prefix: '/',
    kind: 'command',
    icon: 'plan',
    description: 'Enter step-by-step planning mode before execution.'
  },
  {
    name: 'grill-me',
    prefix: '/',
    kind: 'command',
    icon: 'chat',
    description: 'Interactive interview before coding to resolve design decisions.'
  },
  {
    name: 'browser',
    prefix: '/',
    kind: 'command',
    icon: 'browser',
    description: 'Operate live web pages via built-in browser agent.'
  },
  {
    name: 'schedule',
    prefix: '/',
    kind: 'command',
    icon: 'clock',
    description: 'Schedule recurring cron or one-shot automation task.'
  },
  {
    name: 'teamwork',
    prefix: '/',
    kind: 'command',
    icon: 'team',
    description: 'Autonomous multi-agent teamwork.'
  },
  {
    name: 'learn',
    prefix: '/',
    kind: 'command',
    icon: 'book',
    description: 'Persist behavior or setup for future tasks.'
  },
  {
    name: 'boost',
    prefix: '/',
    kind: 'command',
    icon: 'zap',
    description: 'Deep thinking, strategic planning, multiple perspectives.'
  },
  {
    name: 'status',
    prefix: '/',
    kind: 'command',
    icon: 'info',
    description: 'Show current CLI status and context statistics.'
  },
  {
    name: 'clear',
    prefix: '/',
    kind: 'command',
    icon: 'trash',
    description: 'Clear messages from display.'
  }
];

// 2. 官方核心 Context Mentions（@ 上下文引用）
const SYSTEM_MENTIONS = [
  {
    name: 'file',
    prefix: '@',
    kind: 'mention',
    icon: 'file',
    description: 'Reference a file in the workspace'
  },
  {
    name: 'folder',
    prefix: '@',
    kind: 'mention',
    icon: 'folder',
    description: 'Reference a directory tree'
  },
  {
    name: 'git',
    prefix: '@',
    kind: 'mention',
    icon: 'git',
    description: 'Include current Git status, diff, or recent commits'
  },
  {
    name: 'terminal',
    prefix: '@',
    kind: 'mention',
    icon: 'terminal',
    description: 'Reference recent terminal command output'
  },
  {
    name: 'problems',
    prefix: '@',
    kind: 'mention',
    icon: 'alert',
    description: 'Include code diagnostics & compiler errors'
  },
  {
    name: 'docs',
    prefix: '@',
    kind: 'mention',
    icon: 'book',
    description: 'Reference project documentation & README'
  },
  {
    name: 'browser',
    prefix: '@',
    kind: 'mention',
    icon: 'browser',
    description: 'Delegate task to browser agent'
  },
  {
    name: 'research',
    prefix: '@',
    kind: 'mention',
    icon: 'search',
    description: 'Delegate to read-only research agent'
  },
  {
    name: 'workspace',
    prefix: '@',
    kind: 'mention',
    icon: 'box',
    description: 'Overview of active workspace'
  }
];

// 常见 REA (Reverse Engineering) 原生 MCP 工具列表与描述（与官方 Remote Control 截图精确一致）
const REA_DEFAULT_TOOLS = [
  {
    name: 'mcpx:dsh-openclaw-ecosystem_rea:investigate_feature',
    prefix: '/',
    kind: 'tool',
    icon: 'tool',
    description: 'Trace a feature through relevant artifact, symbol, and function evidence.'
  },
  {
    name: 'mcpx:dsh-openclaw-ecosystem_rea:compare_application_versions',
    prefix: '/',
    kind: 'tool',
    icon: 'tool',
    description: 'Compare two shipped application artifacts through complete analysis.'
  },
  {
    name: 'mcpx:dsh-openclaw-ecosystem_rea:verify_reconstruction',
    prefix: '/',
    kind: 'tool',
    icon: 'tool',
    description: 'Evaluate a finite reconstruction specification against retained evidence.'
  },
  {
    name: 'mcpx:dsh-openclaw-ecosystem_rea:trace_crash',
    prefix: '/',
    kind: 'tool',
    icon: 'tool',
    description: 'Correlate a crash symptom with static call and reference evidence plus optional stack.'
  },
  {
    name: 'mcpx:dsh-openclaw-ecosystem_rea:audit_residual_unknowns',
    prefix: '/',
    kind: 'tool',
    icon: 'tool',
    description: 'Review current residual-unknown heads against retained evidence.'
  },
  {
    name: 'mcpx:dsh-openclaw-ecosystem_rea:prepare_bounded_process_capture',
    prefix: '/',
    kind: 'tool',
    icon: 'tool',
    description: 'Choose a command, inputs, observations, and stopping condition for dynamic trace.'
  }
];

/**
 * 扫描当前宿主机配置目录（~/.gemini/），动态发现已安装的 MCP Servers、Plugins 与 Skills
 */
function scanMcpAndSkills(opts = {}) {
  const home = opts.homeDir || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configDir = path.join(home, '.gemini', 'config');
  const mcpConfigFile = path.join(configDir, 'mcp_config.json');
  const results = [];

  // 1. 尝试从 mcp_config.json 提取
  if (fs.existsSync(mcpConfigFile)) {
    try {
      const raw = fs.readFileSync(mcpConfigFile, 'utf8');
      const cfg = JSON.parse(raw);
      const servers = cfg.mcpServers || {};
      for (const sName of Object.keys(servers)) {
        if (sName === 'rea') {
          results.push(...REA_DEFAULT_TOOLS);
        } else {
          results.push({
            name: `mcp:${sName}`,
            prefix: '/',
            kind: 'tool',
            icon: 'tool',
            description: `MCP Server: ${sName}`
          });
        }
      }
    } catch {
      // 容错降级
    }
  }

  // 2. 尝试从 skills.json 或 plugins/ 提取技能
  const skillsJsonFile = path.join(configDir, 'skills.json');
  if (fs.existsSync(skillsJsonFile)) {
    try {
      const raw = fs.readFileSync(skillsJsonFile, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data.entries)) {
        for (const entry of data.entries) {
          const sPath = entry.path;
          if (sPath && fs.existsSync(sPath)) {
            const skillDirs = fs.readdirSync(sPath, { withFileTypes: true });
            for (const d of skillDirs) {
              if (d.name.startsWith('.')) continue;
              const skillName = d.name;
              results.push({
                name: `skill:${skillName}`,
                prefix: '/',
                kind: 'skill',
                icon: 'zap',
                description: `Antigravity Skill: ${skillName}`
              });
            }
          }
        }
      }
    } catch {
      // 容错降级
    }
  }

  // 若环境扫描未命中 REA，仍保证默认提供常用 REA 工具供补全演示
  if (!results.some((it) => it.name.includes('investigate_feature'))) {
    results.unshift(...REA_DEFAULT_TOOLS);
  }

  return results;
}

/**
 * 获取全量指令与提及项（已去重并按官方推荐序排列）
 */
function getRegisteredCommands(opts = {}) {
  const mcpAndSkills = scanMcpAndSkills(opts);

  // 官方截图排序：先排常用 MCP 工具（如 REA），紧接着是 goal、compact 等系统级指令
  const slashCommands = [...mcpAndSkills, ...SYSTEM_SLASH_COMMANDS];
  const mentions = [...SYSTEM_MENTIONS];

  return {
    slashCommands,
    mentions
  };
}

module.exports = {
  SYSTEM_SLASH_COMMANDS,
  SYSTEM_MENTIONS,
  getRegisteredCommands
};
