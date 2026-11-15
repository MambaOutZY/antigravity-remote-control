'use strict';

/**
 * agy-remote-control 自动化冒烟测试（零外部依赖，基于 Node.js 内置 node:test）
 * 覆盖：
 *   1. 临时双源（CLI + Desktop）transcript 构造与密码鉴权 Cookie 流程
 *   2. /api/bootstrap 初始化契约校验
 *   3. /api/conversations/:id 完整消息、5 维 groups 与 latest 上下文数据校验
 *   4. /api/meter/history (source=all / source=cli) 52 周热力图、API 账单与测速统计
 *   5. /api/upload 上传 1×1 PNG 图片与 /api/uploads/:file 回读一致性校验
 *   6. /api/chat/stream (mock: true) SSE 事件流校验
 *   7. 静态资源 (/、/styles.css、/app.js) 与零外部 CDN 校验
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { createAppServer } = require('../server');
const switchBridge = require('../lib/switch-bridge');
const agyRunner = require('../lib/agy-runner');

// 合法的 1×1 像素透明 PNG (67 字节)
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const TEST_PASSWORD = 'agy-smoke-test-password-2026';

/**
 * 解析 SSE 文本流为结构化事件列表
 */
function parseSseFrames(rawText) {
  const frames = [];
  const blocks = String(rawText || '').split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const lines = trimmed.split(/\r?\n/);
    // 忽略纯心跳注释行（例如 `: ping`）
    if (lines.every((l) => l.startsWith(':'))) continue;

    let eventName = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const rawData = dataLines.join('\n');
    let parsedData = rawData;
    try {
      parsedData = JSON.parse(rawData);
    } catch {
      // 保留原始文本
    }
    frames.push({ event: eventName, data: parsedData });
  }
  return frames;
}

describe('agy-remote-control 全链路冒烟测试', () => {
  let tmpRoot = '';
  let agDir = '';
  let agCliDir = '';
  let workspaceDir = '';
  let server = null;
  let baseUrl = '';
  let authCookie = '';
  let authToken = '';

  const cliConvId = 'smoke-cli-conv-001';
  const deskConvId = 'smoke-desk-conv-002';

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-smoke-'));
    agDir = path.join(tmpRoot, '.gemini', 'antigravity');
    agCliDir = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    workspaceDir = path.join(tmpRoot, 'demo-workspace');

    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'README.txt'), 'demo workspace\n', 'utf8');

    const nowMs = Date.now();
    const ts1 = new Date(nowMs - 10_000).toISOString();
    const ts2 = new Date(nowMs - 8_000).toISOString();
    const ts3 = new Date(nowMs - 6_000).toISOString();
    const ts4 = new Date(nowMs - 4_000).toISOString();
    const tsDesk1 = new Date(nowMs - 20_000).toISOString();
    const tsDesk2 = new Date(nowMs - 18_000).toISOString();

    // 1. 构造模拟 CLI transcript.jsonl
    const cliLogDir = path.join(agCliDir, 'brain', cliConvId, '.system_generated', 'logs');
    fs.mkdirSync(cliLogDir, { recursive: true });
    const cliTranscript = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: ts1,
        workspace: workspaceDir,
        userInput: {
          userResponse: '请帮我审计当前仓库架构并给出重构建议'
        }
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: ts2,
        status: 'DONE',
        chatModel: {
          model: 'gemini-3.8-flash',
          modelDisplayName: 'Gemini 3.8 Flash',
          timeToFirstToken: '0.45s',
          streamingDuration: '1.55s',
          usage: {
            inputTokens: 1200,
            cacheReadTokens: 300,
            outputTokens: 400,
            thinkingTokens: 120
          },
          chatStartMetadata: {
            contextWindowMetadata: {
              estimatedTokensUsed: 1900,
              maxContextTokens: 256000
            }
          }
        },
        plannerResponse: {
          thinking: '先梳理模块边界和依赖方向，确保零外部依赖。',
          response: '已完成仓库审计：建议保持引擎、CLI 调度与 HTTP 服务职责分离。',
          toolCalls: [
            { name: 'read_file', args: { path: 'server.js' } }
          ]
        }
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        created_at: ts3,
        content: 'const http = require("http"); // 工具读取输出样本'
      }),
      JSON.stringify({
        step_index: 3,
        type: 'CHECKPOINT',
        created_at: ts4,
        content: '阶段摘要：已完成核心模块边界审计。'
      })
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(cliLogDir, 'transcript.jsonl'), cliTranscript, 'utf8');

    // 2. 构造模拟 Desktop transcript.jsonl
    const deskLogDir = path.join(agDir, 'brain', deskConvId, '.system_generated', 'logs');
    fs.mkdirSync(deskLogDir, { recursive: true });
    const deskTranscript = [
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: tsDesk1,
        workspace: workspaceDir,
        userInput: {
          userResponse: '检查桌面端会话列表与页面布局问题'
        }
      }),
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: tsDesk2,
        status: 'DONE',
        chatModel: {
          model: 'gemini-4-argon',
          modelDisplayName: 'Gemini 4 Argon',
          timeToFirstToken: '0.60s',
          streamingDuration: '1.40s',
          usage: {
            inputTokens: 2000,
            cacheReadTokens: 500,
            outputTokens: 600,
            thinkingTokens: 200
          }
        },
        plannerResponse: {
          thinking: '检查桌面端三栏布局比例和胶囊统计渲染。',
          response: '桌面端布局已检查完成，响应正常。'
        }
      })
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(deskLogDir, 'transcript.jsonl'), deskTranscript, 'utf8');

    // 3. 启动隔离配置的应用服务（动态分配端口）
    server = createAppServer({
      authPassword: TEST_PASSWORD,
      agDir,
      agCliDir,
      defaultWorkspace: workspaceDir,
      fallbackUploadDir: tmpRoot,
      agyBin: path.join(tmpRoot, 'nonexistent-agy-bin')
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('1. 密码鉴权：未登录访问 /api/conversations 返回 401，登录后携 Cookie 返回 200', async () => {
    const unauthRes = await fetch(`${baseUrl}/api/conversations`);
    assert.equal(unauthRes.status, 401);
    const unauthJson = await unauthRes.json();
    assert.equal(unauthJson.ok, false);

    // 错误密码拒绝登录
    const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong-password' })
    });
    assert.equal(badLoginRes.status, 401);

    // 正确密码登录并提取 HttpOnly Cookie
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: TEST_PASSWORD })
    });
    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.equal(loginJson.ok, true);
    assert.equal(loginJson.authenticated, true);

    const setCookies = typeof loginRes.headers.getSetCookie === 'function'
      ? loginRes.headers.getSetCookie()
      : [loginRes.headers.get('set-cookie')].filter(Boolean);
    assert.ok(setCookies.length > 0, '登录响应应包含 Set-Cookie');
    const sessionPair = setCookies[0].split(';')[0];
    assert.ok(sessionPair.startsWith('agy_session='), `Cookie 名称应为 agy_session，实际为 ${sessionPair}`);
    authCookie = sessionPair;
    authToken = loginJson.token || '';

    // 携带 Cookie 后访问 /api/conversations 应返回 200 及双源会话
    const authedRes = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(authedRes.status, 200);
    const authedJson = await authedRes.json();
    assert.ok(Array.isArray(authedJson.conversations));
    const ids = authedJson.conversations.map((c) => c.id);
    assert.ok(ids.includes(cliConvId), '应扫描到 CLI 会话');
    assert.ok(ids.includes(deskConvId), '应扫描到 Desktop 会话');
  });

  it('2. GET /api/bootstrap 返回 models、efforts、modes、conversations', async () => {
    assert.ok(authCookie, '前置登录 Cookie 必须就绪');
    const res = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.authenticated, true);
    assert.ok(Array.isArray(data.models) && data.models.length > 0, 'models 应为非空数组');
    assert.deepEqual(data.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(data.modes, ['auto', 'accept-edits', 'plan']);
    assert.ok(Array.isArray(data.conversations) && data.conversations.length >= 2, '应返回至少 2 条历史会话');
    assert.ok(data.tokenSummary && typeof data.tokenSummary.grandTotalTokens === 'number');
  });

  it('3. GET /api/conversations/:id 返回完整消息、5 维 groups 统计与 latest 上下文数据', async () => {
    const res = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(cliConvId)}`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    const conv = body.conversation;
    assert.ok(conv, '响应应包含 conversation 对象');
    assert.equal(conv.id, cliConvId);
    assert.equal(conv.source, 'cli');

    // 验证完整消息结构
    assert.ok(Array.isArray(conv.messages) && conv.messages.length >= 3);
    const userMsg = conv.messages.find((m) => m.role === 'user');
    const assistantMsg = conv.messages.find((m) => m.role === 'assistant');
    assert.ok(userMsg && userMsg.text.includes('审计当前仓库架构'));
    assert.ok(assistantMsg && assistantMsg.text.includes('已完成仓库审计'));
    assert.ok(assistantMsg.thinking.includes('零外部依赖'));
    assert.ok(Array.isArray(assistantMsg.toolCalls) && assistantMsg.toolCalls.length === 1);
    assert.equal(assistantMsg.toolCalls[0].name, 'read_file');

    // 验证 5 维 groups 统计
    assert.ok(conv.groups, '应包含 groups 对象');
    for (const dim of ['user', 'assistant', 'thinking', 'tools', 'summaries']) {
      assert.ok(conv.groups[dim], `groups 应包含维度 ${dim}`);
      assert.equal(typeof conv.groups[dim].estimate, 'number');
      assert.ok(conv.groups[dim].estimate > 0, `维度 ${dim} 估算 token 应大于 0`);
    }

    // 验证 latest 上下文数据
    assert.ok(conv.latest, '应包含 latest 上下文快照');
    assert.equal(conv.latest.actual, 1900);
    assert.equal(conv.latest.used, 1900);
    assert.equal(conv.latest.budget, 256000);
    assert.equal(conv.latest.status, 'reported');
    assert.ok(conv.latest.speed && conv.latest.speed.tps > 0);
    assert.equal(conv.latest.errorClassification?.kind, 'none');

    // 不存在的会话应返回 404
    const notFoundRes = await fetch(`${baseUrl}/api/conversations/nonexistent-conv-xyz`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(notFoundRes.status, 404);
  });

  it('4. GET /api/meter/history?source=all 与 source=cli 返回 52 周热力图、costSummary、modelSpeedStats', async () => {
    const [allRes, cliRes] = await Promise.all([
      fetch(`${baseUrl}/api/meter/history?source=all`, { headers: { Cookie: authCookie } }),
      fetch(`${baseUrl}/api/meter/history?source=cli`, { headers: { Cookie: authCookie } })
    ]);
    assert.equal(allRes.status, 200);
    assert.equal(cliRes.status, 200);

    const allData = await allRes.json();
    const cliData = await cliRes.json();

    assert.equal(allData.sourceFilter, 'all');
    assert.equal(cliData.sourceFilter, 'cli');

    // 52 周热力图结构校验
    for (const payload of [allData, cliData]) {
      assert.ok(Array.isArray(payload.heatmapWeeks), 'heatmapWeeks 必须为数组');
      assert.equal(payload.heatmapWeeks.length, 52, 'heatmapWeeks 必须固定为 52 周');
      for (const week of payload.heatmapWeeks) {
        assert.ok(Array.isArray(week.days) && week.days.length === 7, '每周应包含 7 天');
      }
      assert.ok(Array.isArray(payload.last7Days) && payload.last7Days.length === 7);

      // costSummary 结构校验
      assert.ok(payload.costSummary, '应返回 costSummary');
      assert.equal(typeof payload.costSummary.totalCostUSD, 'number');
      assert.equal(typeof payload.costSummary.totalCostCNY, 'number');
      assert.ok(payload.costSummary.totalCostUSD > 0, '应计算出大于 0 的 API 等值费用');
      assert.equal(payload.costSummary.exchangeRate, 7.25);
      assert.equal(payload.costSummary.proMonthlyUSD, 20);
      assert.ok(payload.costSummary.byModel && typeof payload.costSummary.byModel === 'object');

      // modelSpeedStats 结构校验
      assert.ok(Array.isArray(payload.modelSpeedStats) && payload.modelSpeedStats.length > 0);
      assert.ok(payload.modelSpeedStats.every((m) => typeof m.medianTps === 'number' && m.medianTps > 0));
    }

    assert.ok(
      allData.summary.grandTotalTokens > cliData.summary.grandTotalTokens,
      'source=all 总 Token 应大于仅 source=cli'
    );
  });

  it('5. POST /api/upload 上传 1×1 PNG 验证尺寸 1×1 并通过返回 url 下载一致内容', async () => {
    const originalBuf = Buffer.from(PNG_1X1_BASE64, 'base64');
    const uploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: 'POST',
      headers: {
        Cookie: authCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'pixel-check.png',
        mime: 'image/png',
        dataBase64: `data:image/png;base64,${PNG_1X1_BASE64}`,
        workspace: workspaceDir
      })
    });
    assert.equal(uploadRes.status, 200);
    const uploadJson = await uploadRes.json();
    assert.equal(uploadJson.ok, true);
    assert.ok(uploadJson.file, '返回体应包含 file 对象');
    assert.equal(uploadJson.file.width, 1);
    assert.equal(uploadJson.file.height, 1);
    assert.equal(uploadJson.file.dimensions, '1×1');
    assert.equal(uploadJson.file.bytes, originalBuf.length);
    assert.ok(uploadJson.file.url && uploadJson.file.url.startsWith('/api/uploads/'));

    // 请求返回的 url 验证图片可下载且内容逐字节一致
    const downloadRes = await fetch(`${baseUrl}${uploadJson.file.url}`, {
      headers: { Cookie: authCookie }
    });
    assert.equal(downloadRes.status, 200);
    assert.ok((downloadRes.headers.get('content-type') || '').startsWith('image/png'));
    const downloadedBuf = Buffer.from(await downloadRes.arrayBuffer());
    assert.deepEqual(downloadedBuf, originalBuf, '下载的图片二进制内容必须与上传内容完全一致');

    // 5.1 验证通过 /api/local-image?path=... 安全只读本地落盘图片（支持 token 查询参数）
    const localImgRes = await fetch(`${baseUrl}/api/local-image?path=${encodeURIComponent(uploadJson.file.path)}&token=${encodeURIComponent(authToken)}`);
    assert.equal(localImgRes.status, 200, '/api/local-image 应能正常读取授权白名单目录内的图片');
    assert.ok((localImgRes.headers.get('content-type') || '').startsWith('image/png'));
    const localImgBuf = Buffer.from(await localImgRes.arrayBuffer());
    assert.deepEqual(localImgBuf, originalBuf, '/api/local-image 返回内容应与本地文件一致');
  });

  it('6. POST /api/chat/stream (mock: true) 验证 SSE 返回 event: text 与 event: done', async () => {
    const res = await fetch(`${baseUrl}/api/chat/stream`, {
      method: 'POST',
      headers: {
        Cookie: authCookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        prompt: '请输出一行测试响应',
        model: 'gemini-4-argon',
        effort: 'high',
        mode: 'auto',
        workspace: workspaceDir,
        mock: true
      })
    });

    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
    assert.equal(res.headers.get('x-accel-buffering'), 'no');
    assert.ok((res.headers.get('cache-control') || '').includes('no-cache'));

    const rawSse = await res.text();
    const frames = parseSseFrames(rawSse);

    const textEvents = frames.filter((f) => f.event === 'text');
    const doneEvents = frames.filter((f) => f.event === 'done');

    assert.ok(textEvents.length > 0, 'SSE 流应包含至少一个 event: text');
    assert.ok(
      textEvents.some((f) => typeof f.data?.delta === 'string' && f.data.delta.length > 0),
      'event: text 应携带非空 delta'
    );
    assert.equal(doneEvents.length, 1, 'SSE 流应以单个 event: done 结束');
    assert.equal(doneEvents[0].data?.ok, true);
    assert.equal(doneEvents[0].data?.mock, true);
  });

  it('7. 静态资源 /、/styles.css、/app.js 返回 200 且 index.html 不含外部 CDN URL', async () => {
    const [htmlRes, cssRes, jsRes] = await Promise.all([
      fetch(`${baseUrl}/`),
      fetch(`${baseUrl}/styles.css`),
      fetch(`${baseUrl}/app.js`)
    ]);

    assert.equal(htmlRes.status, 200);
    assert.equal(cssRes.status, 200);
    assert.equal(jsRes.status, 200);

    assert.ok((htmlRes.headers.get('content-type') || '').includes('text/html'));
    assert.ok((cssRes.headers.get('content-type') || '').includes('text/css'));
    assert.ok((jsRes.headers.get('content-type') || '').includes('javascript'));

    const htmlText = await htmlRes.text();
    const cssText = await cssRes.text();
    const jsText = await jsRes.text();

    assert.ok(htmlText.length > 100 && cssText.length > 100 && jsText.length > 100);
    assert.doesNotThrow(() => {
      // 语法合法性校验，避免前端脚本因语法错误导致全站点击失效
      new Function(jsText);
    }, 'app.js 脚本存在语法错误');
    assert.ok(!/https?:\/\//i.test(htmlText), 'index.html 不得包含任何 http:// 或 https:// 外部链接');
    assert.ok(!/<(?:script|link)\b[^>]+(?:src|href)\s*=\s*["']https?:\/\//i.test(htmlText));
  });
});

describe('扩展能力：项目分组、目录浏览、账号切换与代理桥接测试', () => {
  let tmpRoot = '';
  let agDir = '';
  let agCliDir = '';
  let geminiConfigDir = '';
  let projectsStore = '';
  let modelCtxFile = '';
  let switchDir = '';
  let accountsDir = '';
  let switchPyPath = '';
  let cliTokenFile = '';
  let fallbackTokenFile = '';
  let wrapperPath = '';
  let runtimeProxyFile = '';
  let projAlphaDir = '';
  let projBetaDir = '';
  let customProjDir = '';
  let hiddenDotDir = '';

  let oauthServer = null;
  let oauthPort = 0;
  let lastOAuthBody = '';

  let proxyServer = null;
  let proxyPort = 0;
  let proxyConnectCount = 0;
  let proxyForwardCount = 0;
  let closedPort = 0;

  let appServer = null;
  let baseUrl = '';
  let switchOpts = {};

  const cliConvId = 'ext-cli-conv-001';
  const deskConvId = 'ext-desk-conv-002';
  const unassignedConvId = 'ext-cli-unassigned-003';

  before(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-remote-ext-'));
    agDir = path.join(tmpRoot, '.gemini', 'antigravity');
    agCliDir = path.join(tmpRoot, '.gemini', 'antigravity-cli');
    geminiConfigDir = path.join(tmpRoot, '.gemini', 'config');
    projectsStore = path.join(tmpRoot, 'agy-remote', 'projects.json');
    modelCtxFile = path.join(tmpRoot, 'agy-remote', 'model-ctx.json');
    switchDir = path.join(tmpRoot, 'antigravity-switch');
    accountsDir = path.join(switchDir, 'account');
    switchPyPath = path.join(switchDir, 'switch-agy.py');
    cliTokenFile = path.join(agCliDir, 'antigravity-oauth-token');
    fallbackTokenFile = path.join(tmpRoot, '.gemini', 'jetski-standalone-oauth-token');
    wrapperPath = path.join(tmpRoot, '.local', 'bin', 'agy');
    runtimeProxyFile = path.join(tmpRoot, 'agy-remote', 'proxy-config.json');

    projAlphaDir = path.join(tmpRoot, 'workspaces', 'proj-alpha');
    projBetaDir = path.join(tmpRoot, 'workspaces', 'proj-beta');
    customProjDir = path.join(tmpRoot, 'workspaces', 'custom-proj');
    hiddenDotDir = path.join(tmpRoot, '.custom-hidden');

    for (const d of [
      accountsDir,
      path.dirname(cliTokenFile),
      path.dirname(fallbackTokenFile),
      path.dirname(wrapperPath),
      path.join(geminiConfigDir, 'projects'),
      projAlphaDir,
      projBetaDir,
      customProjDir,
      hiddenDotDir
    ]) {
      fs.mkdirSync(d, { recursive: true });
    }
    fs.writeFileSync(path.join(tmpRoot, 'plain-file.txt'), 'not a dir\n', 'utf8');

    // 1. 构造 ~/.gemini/config/projects/default-cli-project.json
    fs.writeFileSync(
      path.join(geminiConfigDir, 'projects', 'default-cli-project.json'),
      JSON.stringify({ id: 'default-cli-project', name: 'CLI Project' }, null, 2),
      'utf8'
    );

    // 2. 构造带 conversation_metadata.json 与测速字段的双源会话 + 未分组会话
    const nowMs = Date.now();
    const iso1 = new Date(nowMs - 3600_000).toISOString();
    const iso2 = new Date(nowMs - 1800_000).toISOString();
    const iso3 = new Date(nowMs - 900_000).toISOString();

    const cliConvDir = path.join(agCliDir, 'brain', cliConvId);
    fs.mkdirSync(path.join(cliConvDir, '.system_generated', 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(cliConvDir, 'conversation_metadata.json'),
      JSON.stringify({
        ProjectID: 'default-cli-project',
        WorkspaceURIs: [pathToFileURL(projAlphaDir).href]
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(cliConvDir, '.system_generated', 'logs', 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: iso1,
          content: '请帮我分析项目路由与性能指标'
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: iso2,
          model: 'gemini-3.8-flash',
          effort: 'high',
          thinking: '梳理项目统计数据。',
          content: '已分析完成，各项指标正常。',
          tps: 88.5,
          ttft: '0.45s',
          duration: '2.00s',
          input_tokens: 1500,
          cache_read_tokens: 500,
          output_tokens: 200
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const deskConvDir = path.join(agDir, 'brain', deskConvId);
    fs.mkdirSync(path.join(deskConvDir, '.system_generated', 'logs'), { recursive: true });
    fs.writeFileSync(
      path.join(deskConvDir, 'conversation_metadata.json'),
      JSON.stringify({ WorkspaceURIs: [pathToFileURL(projBetaDir).href] }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(deskConvDir, '.system_generated', 'logs', 'transcript.jsonl'),
      [
        JSON.stringify({
          step_index: 0,
          type: 'USER_INPUT',
          created_at: iso2,
          content: 'Desktop 项目测试消息'
        }),
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          created_at: iso3,
          model: 'gemini-3.1-pro-preview',
          content: '收到，已完成桌面工作区校验。',
          tps: 55.2,
          ttft: '0.80s',
          duration: '3.00s',
          input_tokens: 1200,
          cache_read_tokens: 200,
          output_tokens: 180
        })
      ].join('\n') + '\n',
      'utf8'
    );

    const unassignedLogDir = path.join(agCliDir, 'brain', unassignedConvId, '.system_generated', 'logs');
    fs.mkdirSync(unassignedLogDir, { recursive: true });
    fs.writeFileSync(
      path.join(unassignedLogDir, 'transcript.jsonl'),
      JSON.stringify({
        step_index: 0,
        type: 'USER_INPUT',
        created_at: iso3,
        content: '这是一条无工作区归属的临时会话'
      }) + '\n',
      'utf8'
    );

    // 3. 构造模拟账号切换目录、OAuth Token 文件、wrapper 脚本与 switch-agy.py
    fs.writeFileSync(
      path.join(accountsDir, 'antigravity-alpha@gmail.com.json'),
      JSON.stringify({
        email: 'antigravity-alpha@gmail.com',
        project_id: 'proj-alpha-id',
        refresh_token: 'SECRET_REFRESH_ALPHA_DO_NOT_LEAK'
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(accountsDir, 'antigravity-beta@gmail.com.json'),
      JSON.stringify({
        email: 'antigravity-beta@gmail.com',
        project_id: 'proj-beta-id',
        token: { refresh_token: 'SECRET_REFRESH_BETA_DO_NOT_LEAK' }
      }),
      'utf8'
    );
    // 含 UTF-8 BOM (\uFEFF) 且文件名带空格与 (1) 后缀的账号 JSON，复现 Ubuntu 真实环境
    fs.writeFileSync(
      path.join(accountsDir, 'antigravity-bom@gmail.com (1).json'),
      '\uFEFF' + JSON.stringify({
        project_id: 'proj-bom-id',
        refresh_token: 'SECRET_REFRESH_BOM_DO_NOT_LEAK'
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(accountsDir, 'ignore-me.txt'), 'not json\n', 'utf8');

    const initialExpiry = new Date(Date.now() + 1800 * 1000).toISOString();
    fs.writeFileSync(
      cliTokenFile,
      JSON.stringify({
        token: {
          access_token: 'SECRET_ACCESS_ALPHA_DO_NOT_LEAK',
          token_type: 'Bearer',
          refresh_token: 'SECRET_REFRESH_ALPHA_DO_NOT_LEAK',
          expiry: initialExpiry,
          expires_in: 1800
        },
        auth_method: 'consumer',
        id_token_email: 'antigravity-alpha@gmail.com',
        id_token: ''
      }),
      'utf8'
    );

    fs.writeFileSync(
      wrapperPath,
      [
        '#!/bin/bash',
        'export HTTP_PROXY="http://zhangyu:zy580234%3f%21@192.168.1.20:7890"',
        'export HTTPS_PROXY="http://zhangyu:zy580234%3f%21@192.168.1.20:7890"',
        'export http_proxy="http://zhangyu:zy580234%3f%21@192.168.1.20:7890"',
        'export https_proxy="http://zhangyu:zy580234%3f%21@192.168.1.20:7890"',
        'export ALL_PROXY="http://zhangyu:zy580234%3f%21@192.168.1.20:7890"',
        'export all_proxy="http://zhangyu:zy580234%3f%21@192.168.1.20:7890"',
        'exec /home/zhangyu/.local/bin/agy-real "$@"'
      ].join('\n') + '\n',
      'utf8'
    );
    fs.writeFileSync(
      switchPyPath,
      '#!/usr/bin/env python3\nPROXY_URL = "http://old:123@127.0.0.1:7890" # proxy\nprint("ok")\n',
      'utf8'
    );

    // 4. 启动本地 Mock OAuth Token 服务器
    oauthServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        lastOAuthBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          access_token: 'SECRET_FRESH_ACCESS_TOKEN_BETA',
          expires_in: 3600,
          token_type: 'Bearer'
        }));
      });
    });
    await new Promise((resolve) => oauthServer.listen(0, '127.0.0.1', resolve));
    oauthPort = oauthServer.address().port;

    // 5. 启动本地 Mock HTTP 代理服务器（支持 CONNECT 隧道测试与 HTTP POST 转发）
    proxyServer = http.createServer((req, res) => {
      proxyForwardCount += 1;
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        const upstreamUrl = new URL(req.url);
        const upReq = http.request(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port,
            path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
            method: req.method,
            headers: {
              'Content-Type': req.headers['content-type'] || 'application/x-www-form-urlencoded',
              'Content-Length': bodyBuf.length
            }
          },
          (upRes) => {
            const respChunks = [];
            upRes.on('data', (d) => respChunks.push(d));
            upRes.on('end', () => {
              res.writeHead(upRes.statusCode || 200, { 'Content-Type': 'application/json' });
              res.end(Buffer.concat(respChunks));
            });
          }
        );
        upReq.write(bodyBuf);
        upReq.end();
      });
    });
    proxyServer.on('connect', (req, clientSocket) => {
      proxyConnectCount += 1;
      const auth = String(req.headers['proxy-authorization'] || '');
      const expected = 'Basic ' + Buffer.from('testu:testp', 'utf8').toString('base64');
      if (auth !== expected) {
        clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
        clientSocket.destroy();
        return;
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      clientSocket.end();
    });
    await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve));
    proxyPort = proxyServer.address().port;

    // 探测一个确定关闭的本地端口，供代理不可达测试使用
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    closedPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const tokenEndpoint = `http://127.0.0.1:${oauthPort}/token`;
    switchOpts = {
      switchDir,
      accountsDir,
      switchPyPath,
      cliTokenFile,
      fallbackTokenFile,
      wrapperPath,
      runtimeProxyFile,
      tokenEndpoint
    };

    // 6. 启动测试隔离的应用服务器（无密码，聚焦扩展端点）
    appServer = createAppServer({
      agDir,
      agCliDir,
      geminiConfigDir,
      projectsStore,
      modelCtxFile,
      defaultWorkspace: projAlphaDir,
      fallbackUploadDir: tmpRoot,
      agyBin: path.join(tmpRoot, 'nonexistent-agy-bin'),
      ...switchOpts
    });
    await new Promise((resolve) => appServer.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${appServer.address().port}`;
      resolve();
    }));
  });

  after(async () => {
    for (const s of [appServer, proxyServer, oauthServer]) {
      if (s) {
        if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
        await new Promise((resolve) => s.close(() => resolve()));
      }
    }
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('8. GET/POST /api/projects 与 /api/conversations 项目归属及过滤校验', async () => {
    const res = await fetch(`${baseUrl}/api/projects`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(Array.isArray(data.projects));
    assert.equal(data.unassignedCount, 1);

    const cliProj = data.projects.find((p) => p.id === 'default-cli-project');
    assert.ok(cliProj, '应识别出 default-cli-project');
    assert.equal(cliProj.name, 'CLI Project');
    assert.equal(cliProj.conversationCount, 1);

    // 验证 /api/conversations 携带项目字段及按 projectId 过滤
    const convAllRes = await fetch(`${baseUrl}/api/conversations`);
    assert.equal(convAllRes.status, 200);
    const convAll = await convAllRes.json();
    const targetCliConv = convAll.conversations.find((c) => c.id === cliConvId);
    assert.ok(targetCliConv);
    assert.equal(targetCliConv.projectId, 'default-cli-project');
    assert.equal(targetCliConv.projectName, 'CLI Project');
    assert.ok(targetCliConv.workspacePath);

    const filteredRes = await fetch(`${baseUrl}/api/conversations?projectId=default-cli-project`);
    assert.equal(filteredRes.status, 200);
    const filteredJson = await filteredRes.json();
    assert.equal(filteredJson.conversations.length, 1);
    assert.equal(filteredJson.conversations[0].id, cliConvId);

    // 创建自定义项目（成功 + 非法路径拦截）
    const badProjRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '不存在目录', path: path.join(tmpRoot, 'does-not-exist') })
    });
    assert.equal(badProjRes.status, 400);

    const createProjRes = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '我的自定义项目', path: customProjDir })
    });
    assert.equal(createProjRes.status, 200);
    const createdJson = await createProjRes.json();
    assert.equal(createdJson.ok, true);
    assert.equal(createdJson.project.name, '我的自定义项目');
    assert.equal(createdJson.project.custom, true);
    assert.ok(createdJson.projects.some((p) => p.id === createdJson.project.id));
  });

  it('9. GET /api/fs/dirs 返回子目录（含隐藏目录）且拦截非法路径', async () => {
    const res = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(tmpRoot)}`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.currentPath, path.resolve(tmpRoot));
    assert.ok(data.parentPath);

    const names = data.dirs.map((d) => d.name);
    assert.ok(names.includes('.gemini'), '应包含隐藏目录 .gemini');
    assert.ok(names.includes('.custom-hidden'), '应包含隐藏目录 .custom-hidden');
    assert.ok(names.includes('workspaces'), '应包含普通目录 workspaces');
    assert.ok(!names.includes('plain-file.txt'), '不应将普通文件作为目录返回');

    // 不存在的路径返回 404
    const notFoundRes = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(path.join(tmpRoot, 'missing-dir'))}`);
    assert.equal(notFoundRes.status, 404);

    // 普通文件路径返回 400
    const fileRes = await fetch(`${baseUrl}/api/fs/dirs?path=${encodeURIComponent(path.join(tmpRoot, 'plain-file.txt'))}`);
    assert.equal(fileRes.status, 400);
  });

  it('10. 账号列表脱敏、路径穿越拦截与代理 OAuth 刷新切换账号', async () => {
    // 1. 列出账号，绝不能泄露任何 token 明文
    const listRes = await fetch(`${baseUrl}/api/settings/accounts`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    const rawStr = JSON.stringify(listJson);
    assert.ok(!rawStr.includes('SECRET_REFRESH_'), '响应严禁包含 refresh_token');
    assert.ok(!rawStr.includes('SECRET_ACCESS_'), '响应严禁包含 access_token');
    assert.equal(listJson.activeEmail, 'antigravity-alpha@gmail.com');
    assert.equal(listJson.accounts.length, 3, '应完整识别普通与带 UTF-8 BOM 的全部 3 个账号文件');
    const bomAcc = listJson.accounts.find((a) => a.fileName === 'antigravity-bom@gmail.com (1).json');
    assert.ok(bomAcc, '应解析带 UTF-8 BOM 及 (1) 后缀的账号 JSON');
    assert.equal(bomAcc.email, 'bom@gmail.com');
    assert.equal(bomAcc.hasRefreshToken, true);

    // 2. 路径穿越拦截
    for (const evilName of ['../escape.json', 'sub/evil.json', '..\\win.json', 'not-json.txt']) {
      const badRes = await fetch(`${baseUrl}/api/settings/accounts/switch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: evilName })
      });
      assert.equal(badRes.status, 400, `非法文件名 ${evilName} 应返回 400`);
    }

    // 3. 配置当前激活代理为本地 Mock 代理，验证切换账号走代理并写入 CLI + Fallback Token
    const saveProxyRes = await fetch(`${baseUrl}/api/settings/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        proxyUrl: `http://127.0.0.1:${proxyPort}`,
        syncSwitchPy: true
      })
    });
    assert.equal(saveProxyRes.status, 200);

    const beforeForward = proxyForwardCount;
    const switchRes = await fetch(`${baseUrl}/api/settings/accounts/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'antigravity-beta@gmail.com.json' })
    });
    assert.equal(switchRes.status, 200);
    const switchJson = await switchRes.json();
    assert.equal(switchJson.ok, true);
    assert.equal(switchJson.email, 'antigravity-beta@gmail.com');
    assert.ok(!JSON.stringify(switchJson).includes('SECRET_'), '切换响应也不应返回 token 密钥');
    assert.ok(proxyForwardCount > beforeForward, '配置代理后 OAuth 刷新应经过代理转发');
    assert.ok(lastOAuthBody.includes('SECRET_REFRESH_BETA_DO_NOT_LEAK'));

    const cliTokenObj = JSON.parse(fs.readFileSync(cliTokenFile, 'utf8'));
    const fbTokenObj = JSON.parse(fs.readFileSync(fallbackTokenFile, 'utf8'));
    assert.equal(cliTokenObj.id_token_email, 'antigravity-beta@gmail.com');
    assert.equal(cliTokenObj.token.access_token, 'SECRET_FRESH_ACCESS_TOKEN_BETA');
    assert.equal(fbTokenObj.token.access_token, 'SECRET_FRESH_ACCESS_TOKEN_BETA');

    const afterListRes = await fetch(`${baseUrl}/api/settings/accounts`);
    const afterList = await afterListRes.json();
    assert.equal(afterList.activeEmail, 'antigravity-beta@gmail.com');

    // 4. 验证切换到带 UTF-8 BOM 与 (1) 文件名的账号同样成功
    const switchBomRes = await fetch(`${baseUrl}/api/settings/accounts/switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: 'antigravity-bom@gmail.com (1).json' })
    });
    assert.equal(switchBomRes.status, 200);
    const switchBomJson = await switchBomRes.json();
    assert.equal(switchBomJson.ok, true);
    assert.equal(switchBomJson.email, 'bom@gmail.com');
    assert.ok(lastOAuthBody.includes('SECRET_REFRESH_BOM_DO_NOT_LEAK'));
    const bomCliTokenObj = JSON.parse(fs.readFileSync(cliTokenFile, 'utf8'));
    assert.equal(bomCliTokenObj.id_token_email, 'bom@gmail.com');
  });

  it('11. 代理脚本解析/保存/注入拦截、switch-agy.py 只读容错与连通性测试', async () => {
    // 1. 注入拦截测试
    const badPayloads = [
      'http://127.0.0.1:7890";id;#',
      'http://127.0.0.1:7890$(whoami)',
      'http://127.0.0.1:7890`id`',
      'http://127.0.0.1:7890\nexport X=1',
      'ftp://127.0.0.1:21'
    ];
    for (const evilUrl of badPayloads) {
      const saveBad = await fetch(`${baseUrl}/api/settings/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: true, proxyUrl: evilUrl })
      });
      assert.equal(saveBad.status, 400, `恶意代理串 ${evilUrl} 应被保存接口拒绝`);

      const testBad = await fetch(`${baseUrl}/api/settings/proxy/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyUrl: evilUrl })
      });
      assert.equal(testBad.status, 400, `恶意代理串 ${evilUrl} 应被测试接口拒绝`);
    }

    // 2. 合法保存并检查包装脚本 shebang / exec 行与 switch-agy.py 同步
    const validProxy = `http://testu:testp@127.0.0.1:${proxyPort}`;
    const saveRes = await fetch(`${baseUrl}/api/settings/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, proxyUrl: validProxy, syncSwitchPy: true })
    });
    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.ok, true);
    assert.equal(saveJson.enabled, true);
    assert.equal(saveJson.wrapperSynced, true);
    assert.equal(saveJson.switchPySynced, true);

    const wrapperText = fs.readFileSync(wrapperPath, 'utf8');
    assert.ok(wrapperText.startsWith('#!/bin/bash'));
    assert.ok(wrapperText.includes('exec /home/zhangyu/.local/bin/agy-real "$@"'));
    assert.ok(wrapperText.includes(`export HTTPS_PROXY="${validProxy}"`));

    const pyText = fs.readFileSync(switchPyPath, 'utf8');
    assert.ok(pyText.includes(`PROXY_URL = "${validProxy}"`));

    // 验证 agy-runner.buildChildEnv 注入了 6 个代理变量
    const enabledEnv = agyRunner.buildChildEnv({}, switchOpts);
    assert.equal(enabledEnv.HTTP_PROXY, validProxy);
    assert.equal(enabledEnv.ALL_PROXY, validProxy);

    // 3. 连通性测试：合法 CONNECT 成功、密码错误返回 407、未监听端口返回 reachable: false
    const okTestRes = await fetch(`${baseUrl}/api/settings/proxy/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: validProxy })
    });
    assert.equal(okTestRes.status, 200);
    const okTestJson = await okTestRes.json();
    assert.equal(okTestJson.ok, true);
    assert.equal(okTestJson.reachable, true);
    assert.equal(okTestJson.statusCode, 200);
    assert.ok(proxyConnectCount >= 1);

    const authFailRes = await fetch(`${baseUrl}/api/settings/proxy/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: `http://wrong:pass@127.0.0.1:${proxyPort}` })
    });
    assert.equal(authFailRes.status, 200);
    const authFailJson = await authFailRes.json();
    assert.equal(authFailJson.ok, false);
    assert.equal(authFailJson.reachable, true);
    assert.equal(authFailJson.statusCode, 407);

    const closedRes = await fetch(`${baseUrl}/api/settings/proxy/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyUrl: `http://127.0.0.1:${closedPort}` })
    });
    assert.equal(closedRes.status, 200);
    const closedJson = await closedRes.json();
    assert.equal(closedJson.ok, false);
    assert.equal(closedJson.reachable, false);

    // 4. 关闭代理时验证 wrapper unset 与 buildChildEnv 从进程环境中剥离代理变量
    const disableRes = await fetch(`${baseUrl}/api/settings/proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, proxyUrl: validProxy, syncSwitchPy: true })
    });
    assert.equal(disableRes.status, 200);
    const disabledWrapper = fs.readFileSync(wrapperPath, 'utf8');
    assert.ok(disabledWrapper.includes('unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy ALL_PROXY all_proxy'));

    const strippedEnv = agyRunner.buildChildEnv({ HTTP_PROXY: 'http://stale:1', https_proxy: 'http://stale:2' }, switchOpts);
    assert.equal(strippedEnv.HTTP_PROXY, undefined);
    assert.equal(strippedEnv.https_proxy, undefined);

    // 5. switch-agy.py 无写入权限时不崩溃且返回 switchPySynced: false
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
      fs.chmodSync(switchPyPath, 0o444);
      try {
        const roRes = switchBridge.saveProxyConfig({ enabled: true, proxyUrl: validProxy, syncSwitchPy: true }, switchOpts);
        assert.equal(roRes.ok, true);
        assert.equal(roRes.switchPySynced, false);
      } finally {
        fs.chmodSync(switchPyPath, 0o644);
      }
    }
  });

  it('12. 扩展统计字段 (speedSamples / 周月累计 / billingComparison) 与 model-ctx 覆盖配置', async () => {
    const histRes = await fetch(`${baseUrl}/api/meter/history?source=all`);
    assert.equal(histRes.status, 200);
    const hist = await histRes.json();

    // 速度样本数组按时间升序排列且结构完整
    assert.ok(Array.isArray(hist.speedSamples) && hist.speedSamples.length >= 2);
    for (let i = 1; i < hist.speedSamples.length; i++) {
      assert.ok(hist.speedSamples[i].ts >= hist.speedSamples[i - 1].ts, 'speedSamples 应按 ts 升序排列');
    }
    const sample = hist.speedSamples[0];
    assert.equal(typeof sample.outputTps, 'number');
    assert.equal(typeof sample.ttftMs, 'number');
    assert.equal(typeof sample.durationMs, 'number');
    assert.equal(typeof sample.outputTokens, 'number');
    assert.equal(typeof sample.costUsd, 'number');
    assert.ok(sample.source === 'chat' || sample.source === 'background');

    assert.ok(hist.speedSummaryByRange && Array.isArray(hist.speedSummaryByRange['7d']));
    assert.ok(Array.isArray(hist.speedSummaryByRange['30d']));
    assert.ok(Array.isArray(hist.speedSummaryByRange.all));

    // 周 / 月 / 累计序列与账单对比
    assert.ok(Array.isArray(hist.weeklySeries) && hist.weeklySeries.length === 12);
    assert.ok(Array.isArray(hist.monthlySeries) && hist.monthlySeries.length >= 1);
    assert.ok(Array.isArray(hist.cumulativeSeries) && hist.cumulativeSeries.length >= 1);
    assert.ok(hist.billingComparison && typeof hist.billingComparison.totalCostUSD === 'number');
    assert.ok(Array.isArray(hist.billingComparison.models) && hist.billingComparison.models.length >= 1);

    // model-ctx 读写与会话上下文 budget 生效
    const getCtxRes = await fetch(`${baseUrl}/api/settings/model-ctx`);
    assert.equal(getCtxRes.status, 200);
    const getCtxJson = await getCtxRes.json();
    assert.equal(getCtxJson.ok, true);
    assert.deepEqual(getCtxJson.overrides, {});

    const badCtxRes = await fetch(`${baseUrl}/api/settings/model-ctx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { 'gemini-3.8-flash': 100 } })
    });
    assert.equal(badCtxRes.status, 400);

    const saveCtxRes = await fetch(`${baseUrl}/api/settings/model-ctx`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: { 'gemini-3.8-flash': 524288 } })
    });
    assert.equal(saveCtxRes.status, 200);
    const saveCtxJson = await saveCtxRes.json();
    assert.equal(saveCtxJson.overrides['gemini-3.8-flash'], 524288);

    const convDetailRes = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(cliConvId)}`);
    assert.equal(convDetailRes.status, 200);
    const convDetailJson = await convDetailRes.json();
    assert.equal(convDetailJson.conversation.latest.budget, 524288);
  });

  it('13. 对话管理：重命名、置顶排序、标记未读、归档与软删除校验', async () => {
    // 对较旧的 cliConvId 进行重命名 + 置顶 + 未读 + 归档
    const patchRes = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(cliConvId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: '已重命名并置顶的会话',
        pinned: true,
        unread: true,
        archived: true
      })
    });
    assert.equal(patchRes.status, 200);
    const patchJson = await patchRes.json();
    assert.equal(patchJson.ok, true);
    assert.equal(patchJson.prefs.customTitle, '已重命名并置顶的会话');
    assert.equal(patchJson.prefs.pinned, true);
    assert.equal(patchJson.prefs.unread, true);
    assert.equal(patchJson.prefs.archived, true);

    // 验证列表置顶排在第一位且字段同步
    const listRes = await fetch(`${baseUrl}/api/conversations`);
    assert.equal(listRes.status, 200);
    const listJson = await listRes.json();
    assert.equal(listJson.conversations[0].id, cliConvId);
    assert.equal(listJson.conversations[0].title, '已重命名并置顶的会话');
    assert.equal(listJson.conversations[0].pinned, true);
    assert.equal(listJson.conversations[0].unread, true);
    assert.equal(listJson.conversations[0].archived, true);

    // 验证软删除第二条会话后，列表不再包含且详情返回 404
    const targetDelId = listJson.conversations[1].id;
    const delRes = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(targetDelId)}`, {
      method: 'DELETE'
    });
    assert.equal(delRes.status, 200);
    const listAfterDel = await (await fetch(`${baseUrl}/api/conversations`)).json();
    assert.ok(!listAfterDel.conversations.some((c) => c.id === targetDelId));
    const detailAfterDel = await fetch(`${baseUrl}/api/conversations/${encodeURIComponent(targetDelId)}`);
    assert.equal(detailAfterDel.status, 404);
  });
});
