/**
 * @file tests/localCliBridge.test.mjs
 * 独立 Node HTTP 集成测试：用一个假 CLI 脚本代替 claude/codex，离线验证本机 CLI 桥接的边界。
 * 覆盖请求校验、CLI 参数构造与输出解析、Host/Origin/令牌、流式与非流式响应、错误映射、超时、取消、并发排队与垫片定位。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_PORT, buildClaudeInvocation, buildCodexInvocation, createLocalCliBridge, normalizeChatRequest,
  parseClaudeOutput, parseCodexOutput, resolveCommand,
} from '../integrations/local-cli/bridge.mjs';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
/** 假 CLI：回显收到的参数与标准输入，并按输入中的标记模拟失败、崩溃与长时间运行。 */
const FAKE_CLI = `
const mode = process.argv[2]; const args = process.argv.slice(3);
if (args.includes('--version')) { console.log('fake-' + mode + ' 1.2.3'); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  if (input.includes('SLEEP')) await new Promise((resolve) => setTimeout(resolve, 30000));
  if (input.includes('PAUSE')) await new Promise((resolve) => setTimeout(resolve, 400));
  if (input.includes('CRASH')) { console.error('fatal: not logged in'); process.exit(3); }
  const echo = JSON.stringify({ args, input, cwd: process.cwd() });
  if (mode === 'claude') {
    console.log(JSON.stringify(input.includes('FAIL')
      ? { type: 'result', is_error: true, result: 'Usage limit reached' }
      : { type: 'result', is_error: false, result: echo, usage: { input_tokens: 2, cache_creation_input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 7 } }));
  } else {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 't' }));
    console.log(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5' }));
    if (input.includes('FAIL')) console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }));
    else {
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'thinking aloud' } }));
      console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: echo } }));
      console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 4 } }));
    }
  }
});
`;

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fluentread-local-cli-test-'));
  const script = join(directory, 'fake-cli.mjs');
  await writeFile(script, FAKE_CLI);
  const logs = [];
  const bridge = await createLocalCliBridge({
    port: 0, log: (entry) => logs.push(entry),
    backends: { claude: { command: process.execPath, prefixArgs: [script, 'claude'] }, codex: { command: process.execPath, prefixArgs: [script, 'codex'] } },
    ...options,
  });
  t.after(async () => { await bridge.close(); await rm(directory, { recursive: true, force: true }); });
  /** 用原生 http 发请求，才能自由设置 Host/Origin 等 fetch 禁止改写的请求头。 */
  function call(path, { method = 'GET', body, headers = {}, signal } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
      const request = httpRequest({ host: '127.0.0.1', port: bridge.port, path, method, signal,
        headers: { ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }), ...headers } }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data; try { data = JSON.parse(text); } catch { data = undefined; }
          resolve({ status: response.statusCode, headers: response.headers, text, data });
        });
      });
      request.on('error', reject);
      request.end(payload);
    });
  }
  const chat = (backend, content, extra = {}, init = {}) => call(`/${backend}/v1/chat/completions`, { method: 'POST', body: { model: 'default', messages: [{ role: 'user', content }], ...extra }, ...init });
  const echoOf = (response) => JSON.parse(response.data.choices[0].message.content);
  return { bridge, call, chat, echoOf, logs };
}

test('请求校验：拆分系统提示词与对话，拒绝图片、工具与缺少用户消息的请求', () => {
  const request = normalizeChatRequest({ model: ' haiku ', stream: true, temperature: 0.2, messages: [
    { role: 'system', content: 'A' }, { role: 'developer', content: [{ type: 'text', text: 'B' }] }, { role: 'user', content: 'hello' }] });
  assert.deepEqual(request, { model: 'haiku', system: 'A\n\nB', prompt: 'hello', stream: true });
  assert.equal(normalizeChatRequest({ messages: [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' }] }).prompt,
    '[user]\nq1\n\n[assistant]\na1\n\n[user]\nq2');
  for (const body of [null, [], {}, { messages: [] }, { messages: [{ role: 'system', content: 'only' }] }, { messages: [{ role: 'tool', content: 'x' }] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] }] }, { messages: [{ role: 'user', content: 5 }] },
    { model: 3, messages: [{ role: 'user', content: 'x' }] }, { tools: [{ type: 'function' }], messages: [{ role: 'user', content: 'x' }] },
    { messages: [{ role: 'user', content: 'a\u0000b' }] }]) assert.throws(() => normalizeChatRequest(body), { name: 'Error' });
});

test('CLI 参数：Claude 禁用工具并隔离用户定制，Codex 只读且默认不加载用户配置', () => {
  const claude = buildClaudeInvocation({ model: 'sonnet', system: 'Translate "this" & that', prompt: 'text', effort: 'low' });
  for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands']) assert.ok(claude.args.includes(flag), flag);
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.equal(claude.args[claude.args.indexOf('--permission-prompts') + 1], 'none');
  assert.ok(claude.args.includes('--model=sonnet') && claude.args.includes('--effort=low'));
  assert.ok(claude.args.includes('--system-prompt=Translate "this" & that'));
  assert.equal(claude.input, 'text');
  // cmd 垫片与超长系统提示词都不能进入命令行，必须折叠进标准输入。
  for (const folded of [buildClaudeInvocation({ system: 'Translate "this"', prompt: 'text', shim: true }), buildClaudeInvocation({ system: 'x'.repeat(12_001), prompt: 'text' })]) {
    assert.ok(folded.args.every((argument) => !/["%!^&|<>\r\n]/.test(argument)));
    assert.match(folded.input, /^<system_instructions>\n[\s\S]+\n<\/system_instructions>\n\ntext$/);
  }
  assert.ok(!buildClaudeInvocation({ system: '', prompt: 'text' }).args.some((argument) => argument.startsWith('--model')));

  const codex = buildCodexInvocation({ model: 'gpt-x', system: 'S', prompt: 'P', effort: 'low', workdir: '/tmp/w' });
  assert.deepEqual(codex.args.slice(0, 5), ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only']);
  assert.ok(codex.args.includes('--ignore-user-config') && codex.args.includes('--ignore-rules'));
  for (const feature of ['shell_tool', 'code_mode_host', 'plugins']) assert.equal(codex.args[codex.args.indexOf(feature) - 1], '--disable');
  assert.ok(codex.args.includes('web_search=disabled') && codex.args.includes('model_reasoning_effort=low'));
  assert.equal(codex.args[codex.args.indexOf('-m') + 1], 'gpt-x');
  assert.deepEqual(codex.args.slice(-3), ['-C', '/tmp/w', '-']);
  assert.match(codex.input, /<system_instructions>\nS\n<\/system_instructions>\n\nP$/);
  assert.ok(!buildCodexInvocation({ prompt: 'P', workdir: '/w', userConfig: true }).args.includes('--ignore-user-config'));
});

test('输出解析：读取 Claude 结果对象与 Codex JSONL，失败时给出 CLI 的原因', () => {
  assert.deepEqual(parseClaudeOutput('{"type":"result","is_error":false,"result":"你好","usage":{"input_tokens":1,"cache_read_input_tokens":4,"output_tokens":2}}\n'),
    { text: '你好', usage: { prompt_tokens: 5, completion_tokens: 2 } });
  assert.equal(parseClaudeOutput('[{"type":"system"},{"type":"result","result":"ok"}]').text, 'ok');
  assert.throws(() => parseClaudeOutput('{"is_error":true,"result":"Usage limit reached"}'), /Usage limit reached/);
  assert.throws(() => parseClaudeOutput('not json'), (failure) => failure.code === 'invalid_cli_output');
  const lines = ['banner', '{"type":"error","message":"Reconnecting... 2/5"}', '{broken', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"error","message":"fallback"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"最终"}}',
    '{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":3}}'];
  assert.deepEqual(parseCodexOutput(lines.join('\r\n')), { text: '最终', usage: { prompt_tokens: 9, completion_tokens: 3 } });
  assert.throws(() => parseCodexOutput('{"type":"turn.failed","error":{"message":"quota exceeded"}}'), /quota exceeded/);
  assert.throws(() => parseCodexOutput('{"type":"error","message":"stream disconnected"}'), /stream disconnected/);
});

test('Windows 垫片定位：优先原生可执行文件，.cmd 标记为垫片，非 Windows 交给系统 PATH', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'fluentread-local-cli-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'onlyshim.cmd'), ''); await writeFile(join(directory, 'both.cmd'), ''); await writeFile(join(directory, 'both.exe'), '');
  const environment = { PATH: directory };
  assert.deepEqual(resolveCommand('onlyshim', environment, 'win32'), { file: join(directory, 'onlyshim.cmd'), shim: true });
  assert.deepEqual(resolveCommand('both', environment, 'win32'), { file: join(directory, 'both.exe'), shim: false });
  assert.deepEqual(resolveCommand('missing', environment, 'win32'), { file: 'missing', shim: false });
  assert.deepEqual(resolveCommand('C:\\tools\\codex.cmd', environment, 'win32'), { file: 'C:\\tools\\codex.cmd', shim: true });
  assert.deepEqual(resolveCommand('claude', environment, 'linux'), { file: 'claude', shim: false });
});

test('健康检查与模型目录：探测 CLI 版本，按后端列出模型', async (t) => {
  const { bridge, call } = await fixture(t);
  assert.equal(BRIDGE_PORT, 18765);
  assert.equal(bridge.endpoints.claude, `${bridge.url}/claude/v1/chat/completions`);
  assert.deepEqual((await bridge.detect()).map(({ id, available, version }) => ({ id, available, version })),
    [{ id: 'claude', available: true, version: 'fake-claude 1.2.3' }, { id: 'codex', available: true, version: 'fake-codex 1.2.3' }]);
  const health = await call('/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.name, 'fluentread-local-cli');
  assert.equal(health.data.tokenRequired, false);
  assert.deepEqual(health.data.backends.codex, { label: 'Codex CLI', available: true, version: 'fake-codex 1.2.3', active: 0, queued: 0, concurrency: 2 });
  assert.deepEqual((await call('/claude/v1/models')).data.data.map((model) => model.id), ['haiku', 'sonnet', 'opus', 'default']);
  assert.deepEqual((await call('/v1/models')).data.data.map((model) => model.id), ['haiku', 'sonnet', 'opus', 'default', 'default']);
  assert.equal((await call('/claude/v1/models', { method: 'POST', body: {} })).status, 405);
  assert.equal((await call('/unknown')).status, 404);
});

test('来源边界：拒绝网页 Origin、伪造 Host 与转发头，放行扩展与白名单来源', async (t) => {
  const { bridge, call } = await fixture(t, { allowOrigins: ['http://localhost:5173'] });
  assert.equal((await call('/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/health', { headers: { Origin: 'null' } })).status, 403);
  assert.equal((await call('/health', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await call('/health', { headers: { Host: `127.0.0.1:${bridge.port}`, 'X-Forwarded-Host': 'evil.example' } })).status, 403);
  assert.equal((await call('/health', { headers: { Host: `localhost:${bridge.port}` } })).status, 200);
  for (const origin of [ORIGIN, 'moz-extension://01234567-89ab-cdef-0123-456789abcdef', 'http://localhost:5173']) {
    const allowed = await call('/health', { headers: { Origin: origin } });
    assert.equal(allowed.status, 200); assert.equal(allowed.headers['access-control-allow-origin'], origin);
  }
  const preflight = await call('/claude/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type, bad header!' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-headers'], 'authorization, content-type');
  assert.equal(preflight.headers['access-control-allow-private-network'], 'true');
  assert.equal((await call('/claude/v1/chat/completions', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })).status, 403);
});

test('访问令牌：启用后模型与补全接口都要求匹配的 Bearer，健康检查保持公开', async (t) => {
  const { call, chat } = await fixture(t, { token: 'local-secret' });
  assert.equal((await call('/health')).data.tokenRequired, true);
  assert.equal((await call('/claude/v1/models')).status, 401);
  assert.equal((await chat('claude', 'hi', {}, { headers: { Authorization: 'Bearer wrong' } })).data.error.code, 'invalid_token');
  assert.equal((await chat('claude', 'hi', {}, { headers: { Authorization: 'Bearer local-secret' } })).status, 200);
});

test('Claude 补全：系统提示词走参数、正文走标准输入，在空的临时目录运行并返回 OpenAI 形状', async (t) => {
  const { bridge, call, echoOf, logs } = await fixture(t, { defaultModels: { claude: 'haiku' }, efforts: { claude: 'low' } });
  const response = await call('/claude/v1/chat/completions', { method: 'POST', headers: { Origin: ORIGIN },
    body: { model: 'default', temperature: 0, messages: [{ role: 'system', content: '翻译成"中文"\n只输出译文' }, { role: 'user', content: 'Hello <b>world</b> & 100%' }] } });
  assert.equal(response.status, 200);
  assert.equal(response.data.object, 'chat.completion');
  assert.equal(response.data.model, 'haiku');
  assert.equal(response.data.choices[0].finish_reason, 'stop');
  assert.deepEqual(response.data.usage, { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 });
  const echo = echoOf(response);
  assert.equal(echo.input, 'Hello <b>world</b> & 100%');
  assert.ok(echo.args.includes('--system-prompt=翻译成"中文"\n只输出译文') && echo.args.includes('--model=haiku') && echo.args.includes('--effort=low'));
  assert.equal(echo.cwd.toLowerCase(), bridge.workdir.toLowerCase());
  // 日志只含元数据，不含正文。
  assert.deepEqual(Object.keys(logs[0]).sort(), ['backend', 'inputChars', 'model', 'ms', 'outputChars', 'status']);
  assert.ok(!JSON.stringify(logs).includes('world'));
  assert.equal((await call('/claude/v1/chat/completions', { method: 'POST', body: { model: 'bad model', messages: [{ role: 'user', content: 'x' }] } })).data.error.code, 'invalid_model');
  assert.equal((await call('/claude/v1/chat/completions', { method: 'POST', body: '{broken' })).data.error.code, 'invalid_json');
  assert.equal((await call('/claude/v1/chat/completions')).status, 405);
});

test('Codex 补全：取最后一条助手消息，通用路由按模型名选择后端', async (t) => {
  const { call, chat, echoOf } = await fixture(t);
  const response = await chat('codex', '待翻译', { messages: [{ role: 'system', content: 'S' }, { role: 'user', content: '待翻译' }] });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.usage, { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 });
  const echo = echoOf(response);
  assert.match(echo.input, /<system_instructions>\nS\n<\/system_instructions>\n\n待翻译$/);
  assert.ok(echo.args.includes('--ignore-user-config') && echo.args.includes('model_reasoning_effort=low') && !echo.args.includes('-m'));
  const generic = (model) => call('/v1/chat/completions', { method: 'POST', body: { model, messages: [{ role: 'user', content: 'x' }] } });
  assert.equal((await generic('sonnet')).data.system_fingerprint, 'fluentread-local-cli-claude');
  assert.equal((await generic('gpt-x-codex')).data.system_fingerprint, 'fluentread-local-cli-codex');
  assert.equal((await generic('mystery')).data.error.code, 'backend_required');
});

test('流式响应：以 SSE 一次性下发内容并以 [DONE] 结束', async (t) => {
  const { chat } = await fixture(t);
  const response = await chat('codex', 'stream me', { stream: true });
  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  const events = response.text.split('\n\n').filter((frame) => frame.startsWith('data: ')).map((frame) => frame.slice(6));
  assert.equal(events.at(-1), '[DONE]');
  const [content, final] = events.slice(0, -1).map((event) => JSON.parse(event));
  assert.equal(content.object, 'chat.completion.chunk');
  assert.equal(JSON.parse(content.choices[0].delta.content).input.endsWith('stream me'), true);
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.equal(final.usage.total_tokens, 15);
});

test('错误映射：CLI 报错、崩溃、缺失与超时分别给出可读原因', async (t) => {
  const { chat, logs } = await fixture(t, { timeoutMs: 1_000 });
  const limited = await chat('claude', 'FAIL');
  assert.equal(limited.status, 502); assert.match(limited.data.error.message, /Usage limit reached/);
  assert.match((await chat('codex', 'FAIL')).data.error.message, /quota exceeded/);
  const crashed = await chat('claude', 'CRASH');
  assert.equal(crashed.data.error.code, 'cli_failed'); assert.match(crashed.data.error.message, /退出码 3.*not logged in/);
  const streamed = await chat('codex', 'CRASH', { stream: true });
  assert.equal(streamed.status, 200); assert.match(streamed.text, /"code":"cli_failed"/);
  const timedOut = await chat('claude', 'SLEEP');
  assert.equal(timedOut.status, 504); assert.equal(timedOut.data.error.code, 'cli_timeout');
  assert.equal(logs.at(-1).code, 'cli_timeout');

  const missing = await fixture(t, { backends: { claude: { command: join(tmpdir(), 'fluentread-no-such-cli-binary') } } });
  assert.deepEqual((await missing.bridge.detect()).find((status) => status.id === 'claude'), { id: 'claude', label: 'Claude Code', available: false, version: null });
  const unavailable = await missing.chat('claude', 'x');
  assert.equal(unavailable.status, 503); assert.equal(unavailable.data.error.code, 'cli_unavailable');
});

test('并发与取消：超出并发的请求排队，队列满时拒绝，客户端断开后终止 CLI 并释放名额', async (t) => {
  const { call, chat } = await fixture(t, { concurrency: { claude: 1, codex: 1 }, maxQueue: 1 });
  const started = Date.now();
  const results = await Promise.all([chat('claude', 'PAUSE 1'), chat('claude', 'PAUSE 2'), chat('claude', 'PAUSE 3')]);
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 200, 429]);
  assert.equal(results.find((response) => response.status === 429).data.error.code, 'queue_full');
  assert.ok(Date.now() - started >= 700, '两个放行的请求必须串行执行');

  const controller = new AbortController();
  const aborted = chat('codex', 'SLEEP', {}, { signal: controller.signal }).catch((failure) => failure);
  for (let attempt = 0; attempt < 50 && (await call('/health')).data.backends.codex.active !== 1; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  assert.equal((await aborted).name, 'AbortError');
  let active = 1;
  for (let attempt = 0; attempt < 100 && active !== 0; attempt++) { await new Promise((resolve) => setTimeout(resolve, 50)); active = (await call('/health')).data.backends.codex.active; }
  assert.equal(active, 0, '取消后必须在超时之前释放并发名额');
  assert.equal((await chat('codex', 'after cancel')).status, 200);
});

test('Windows cmd 垫片：经 cmd.exe 转交固定参数，任意文本只走标准输入', async (t) => {
  // 只有 Windows 存在 .cmd 垫片（npm 全局安装的 CLI）；其他平台由前面的参数构造用例覆盖折叠逻辑。
  if (process.platform !== 'win32') return;
  const directory = await mkdtemp(join(tmpdir(), 'fluentread-local-cli-shim-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, 'fake-cli.mjs');
  await writeFile(script, FAKE_CLI);
  const shims = {};
  for (const mode of ['claude', 'codex']) {
    shims[mode] = { command: join(directory, `fake${mode}.cmd`) };
    await writeFile(shims[mode].command, `@echo off\r\n"${process.execPath}" "${script}" ${mode} %*\r\n`);
  }
  const bridge = await createLocalCliBridge({ port: 0, backends: shims });
  t.after(() => bridge.close());
  assert.deepEqual((await bridge.detect()).map((status) => status.version), ['fake-claude 1.2.3', 'fake-codex 1.2.3']);
  const post = async (backend) => {
    const response = await fetch(bridge.endpoints[backend], { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'default', messages: [{ role: 'system', content: '保留 "引号" & %PATH% ^ | <b>' }, { role: 'user', content: '正文 "quoted" & %PATH%' }] }) });
    assert.equal(response.status, 200);
    return JSON.parse((await response.json()).choices[0].message.content);
  };
  const claude = await post('claude');
  assert.equal(claude.input, '<system_instructions>\n保留 "引号" & %PATH% ^ | <b>\n</system_instructions>\n\n正文 "quoted" & %PATH%');
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.some((argument) => /^--system-prompt=You are a text processing engine/.test(argument)));
  const codex = await post('codex');
  assert.ok(codex.input.endsWith('正文 "quoted" & %PATH%'));
  assert.deepEqual(codex.args.slice(-3), ['-C', bridge.workdir, '-']);
});

test('启动参数：拒绝无效端口、超时、并发与推理强度', async () => {
  for (const options of [{ port: -1 }, { port: 70_000 }, { timeoutMs: 10 }, { concurrency: { claude: 0 } }, { concurrency: { codex: 1.5 } }, { efforts: { codex: 'low; rm' } }]) {
    await assert.rejects(() => createLocalCliBridge(options), /^Error: INVALID_/);
  }
});
