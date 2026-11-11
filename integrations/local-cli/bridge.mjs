/**
 * @file integrations/local-cli/bridge.mjs
 * 文件职责：只绑定 127.0.0.1 的本机 HTTP 桥接，把 OpenAI 兼容的 Chat Completions 请求转交给本机已登录的
 * Claude Code CLI（claude -p）或 Codex CLI（codex exec），让 FluentRead 无需 API Key 即可复用 CLI 的登录与额度。
 * 主要内容：请求校验与 Host/Origin/可选令牌边界、按后端的并发闸门与排队上限、CLI 参数构造、子进程生命周期
 * （超时、取消、整树终止）、CLI 输出解析，以及非流式 JSON 与 SSE 两种 OpenAI 响应形状。
 * 模块边界：本文件不读取、不保存任何 CLI 凭据，也不接触扩展配置；CLI 一律在空的临时目录里以“无工具/只读”方式运行，
 * 网页文本只作为待处理文本传入。日志只记录后端、模型、字符数与耗时，不记录正文。
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { accessSync, constants as fsConstants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';

export const BRIDGE_PORT = 18765;
export const BRIDGE_NAME = 'fluentread-local-cli';
export const BRIDGE_VERSION = 1;
export const BACKEND_IDS = Object.freeze(['claude', 'codex']);

const MAX_BODY = 4_000_000;
const MAX_OUTPUT = 16_000_000;
/** 系统提示词超过此长度时并入标准输入，避免超出 Windows 命令行上限。 */
const MAX_SYSTEM_ARGUMENT = 12_000;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,119}$/;
const EFFORT_PATTERN = /^[a-z]{1,16}$/;
const EXTENSION_ORIGIN = /^(?:chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|safari-web-extension:\/\/[A-Fa-f0-9-]{36})$/;
/** 请求未携带系统消息，或系统消息无法安全放进命令行时使用的固定提示词；只含字母、空格与句点，便于经 cmd 垫片转交。 */
const NEUTRAL_SYSTEM_PROMPT = 'You are a text processing engine behind an API. Follow the instructions in the input exactly and reply with only the requested result. Do not add preambles or explanations.';
const CODEX_PREAMBLE = 'You are acting as a plain text completion API. Do not run commands, do not read or write files, do not browse and do not ask questions. Follow the instructions below and reply with only the final answer.';

const DEFAULT_BACKENDS = Object.freeze({
  claude: Object.freeze({ label: 'Claude Code', command: 'claude', models: ['haiku', 'sonnet', 'opus', 'default'] }),
  codex: Object.freeze({ label: 'Codex CLI', command: 'codex', models: ['default'] }),
});
/**
 * 关闭与文本补全无关、且会带来额外联网或本机操作面的 Codex 功能。Codex 无法像 Claude Code 那样移除全部工具，
 * 因此同时关闭 shell 与代码执行宿主（code_mode_host），使残留的 exec 工具直接失败（fail closed）。
 */
const CODEX_DISABLED_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'code_mode_host', 'apps', 'plugins', 'memories', 'hooks',
  'image_generation', 'view_image', 'browser_use', 'computer_use', 'in_app_browser', 'multi_agent']);

export class BridgeError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const fail = (code, message, status = 400) => new BridgeError(code, message, status);
const digest = (value) => createHash('sha256').update(String(value)).digest();
const clip = (value, limit = 400) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit)}…` : text; };

/** 把 OpenAI 消息的 content 归一为纯文本；图片等非文本片段无法经 CLI 标准输入转交，明确拒绝。 */
function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw fail('invalid_messages', '消息内容必须是字符串或文本片段数组。');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part && (part.type === 'text' || part.type === 'input_text') && typeof part.text === 'string') return part.text;
    throw fail('unsupported_content', '本机 CLI 桥接只支持纯文本消息，不支持图片或文件输入。');
  }).join('');
}

/** 校验 Chat Completions 请求并拆出系统提示词与对话正文；忽略 temperature 等 CLI 无法表达的采样参数。 */
export function normalizeChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('invalid_json', '请求体必须是 JSON 对象。');
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 200) throw fail('invalid_messages', 'messages 必须是非空数组。');
  if (body.model !== undefined && typeof body.model !== 'string') throw fail('invalid_model', 'model 必须是字符串。');
  if (Array.isArray(body.tools) && body.tools.length) throw fail('unsupported_parameter', '本机 CLI 桥接不支持工具调用。');
  const system = []; const turns = [];
  for (const message of body.messages) {
    if (!message || typeof message !== 'object') throw fail('invalid_messages', '消息格式无效。');
    const text = contentText(message.content);
    if (message.role === 'system' || message.role === 'developer') system.push(text);
    else if (message.role === 'user' || message.role === 'assistant') turns.push({ role: message.role, text });
    else throw fail('invalid_messages', '只接受 system、developer、user 与 assistant 消息。');
  }
  if (!turns.some((turn) => turn.role === 'user')) throw fail('invalid_messages', '至少需要一条 user 消息。');
  if ([...system, ...turns.map((turn) => turn.text)].some((text) => text.includes('\u0000'))) throw fail('invalid_messages', '消息包含无效字符。');
  const prompt = turns.length === 1 ? turns[0].text : turns.map((turn) => `[${turn.role}]\n${turn.text}`).join('\n\n');
  return { model: (body.model || '').trim(), system: system.join('\n\n').trim(), prompt, stream: body.stream === true };
}

/** 请求里的 default/空模型交给 CLI 自身的默认模型；其余值必须是不含空白与引号的模型标识。 */
function resolveModel(requested, fallback) {
  const model = !requested || requested === 'default' ? (fallback || '') : requested;
  if (!model || model === 'default') return '';
  if (!MODEL_PATTERN.test(model)) throw fail('invalid_model', '模型名称包含不支持的字符。');
  return model;
}

function withSystem(system, prompt) {
  return system ? `<system_instructions>\n${system}\n</system_instructions>\n\n${prompt}` : prompt;
}

/** Claude Code：安全模式（不加载 CLAUDE.md、插件、钩子、MCP）且禁用全部内置工具，仅做一次无会话的文本生成。 */
export function buildClaudeInvocation({ model, system, prompt, effort, shim = false }) {
  const args = ['-p', '--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
    '--permission-prompts', 'none', '--disable-slash-commands', '--output-format', 'json'];
  if (model) args.push(`--model=${model}`);
  if (effort) args.push(`--effort=${effort}`);
  // cmd 垫片无法安全转交任意文本，系统提示词过长也会超出命令行上限：这两种情况改由标准输入携带。
  const inline = Boolean(system) && !shim && system.length <= MAX_SYSTEM_ARGUMENT;
  args.push(`--system-prompt=${inline ? system : NEUTRAL_SYSTEM_PROMPT}`);
  return { args, input: inline ? prompt : withSystem(system, prompt) };
}

/**
 * Codex：只读沙箱、临时会话、关闭执行类工具与联网搜索；Codex 没有系统提示词参数，统一并入标准输入。
 * 默认不加载 ~/.codex/config.toml（其中登记的 MCP 服务与插件会重新带来本机操作能力），登录凭据不受影响；
 * userConfig 为 true 时沿用用户配置中的模型与供应商设置。
 */
export function buildCodexInvocation({ model, system, prompt, effort, workdir, userConfig = false }) {
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--ignore-rules', '--color', 'never', '--json'];
  if (!userConfig) args.push('--ignore-user-config');
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature);
  args.push('-c', 'web_search=disabled');
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (model) args.push('-m', model);
  args.push('-C', workdir, '-');
  return { args, input: `${CODEX_PREAMBLE}\n\n${withSystem(system, prompt)}` };
}

/** 读取 claude -p --output-format json 的单个结果对象。 */
export function parseClaudeOutput(stdout) {
  let value;
  try { value = JSON.parse(stdout.trim()); } catch { throw fail('invalid_cli_output', 'Claude Code 返回了无法解析的输出。', 502); }
  // 旧版本在 verbose 下可能输出事件数组，取其中的 result 事件。
  if (Array.isArray(value)) value = value.findLast((entry) => entry?.type === 'result');
  if (!value || typeof value !== 'object') throw fail('invalid_cli_output', 'Claude Code 没有返回结果。', 502);
  if (value.is_error || typeof value.result !== 'string') throw fail('cli_failed', `Claude Code 未完成请求：${clip(value.result || value.subtype || '未知错误')}`, 502);
  const usage = value.usage || {};
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  return { text: value.result, usage: { prompt_tokens: input, completion_tokens: usage.output_tokens || 0 } };
}

/** 读取 codex exec --json 的 JSONL 事件：最后一条 agent_message 是答案，重连提示类 error 事件不算失败。 */
export function parseCodexOutput(stdout) {
  let text; let usage = {}; let failure = ''; let lastError = '';
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') text = event.item.text;
    else if (event.type === 'turn.completed') usage = event.usage || {};
    else if (event.type === 'turn.failed') failure = event.error?.message || '请求失败';
    else if (event.type === 'error' && typeof event.message === 'string') lastError = event.message;
  }
  if (failure || text === undefined) throw fail('cli_failed', `Codex CLI 未完成请求：${clip(failure || lastError || '没有返回内容')}`, 502);
  return { text, usage: { prompt_tokens: usage.input_tokens || 0, completion_tokens: usage.output_tokens || 0 } };
}

/**
 * 在 PATH 中定位 CLI。Windows 上 npm 全局安装产生的是 .cmd 垫片，Node 不能直接 spawn，
 * 需要经 cmd.exe 转交并限制参数字符；原生 .exe 则直接启动，参数由 Node 负责转义。
 */
export function resolveCommand(command, environment = process.env, platform = process.platform) {
  if (platform !== 'win32') return { file: command, shim: false };
  const isShim = (file) => ['.cmd', '.bat'].includes(extname(file).toLowerCase());
  if (isAbsolute(command) || /[\\/]/.test(command)) return { file: command, shim: isShim(command) };
  const extensions = extname(command) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  for (const directory of (environment.PATH || environment.Path || '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const file = join(directory, command + extension);
      try { accessSync(file, fsConstants.F_OK); return { file, shim: isShim(file) }; } catch { /* 继续查找下一个候选 */ }
    }
  }
  return { file: command, shim: false };
}

function quoteForCmd(argument) {
  if (/^[A-Za-z0-9_.:=\\/@+-]+$/.test(argument)) return argument;
  if (/["%!^&|<>\r\n]/.test(argument)) throw fail('unsafe_argument', 'CLI 垫片不接受包含特殊字符的参数，请改用原生可执行文件。', 500);
  return `"${argument}"`;
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill()); }
    catch { child.kill(); }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

/** 启动一个 CLI 子进程并收集输出；超时或调用方取消时终止整棵进程树。 */
export function runProcess({ file, shim = false, args, input = '', cwd, timeoutMs, signal, env = process.env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(fail('client_closed', '请求已取消。', 499)); return; }
    let child;
    try {
      child = shim
        ? spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[file, ...args].map(quoteForCmd).join(' ')}"`], { cwd, env, windowsHide: true, windowsVerbatimArguments: true })
        : spawn(file, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32' });
    } catch (failure) { reject(failure instanceof BridgeError ? failure : fail('cli_unavailable', '无法启动本机 CLI。', 503)); return; }
    const stdout = []; const stderr = []; let size = 0; let settled = false; let reason;
    const finish = (callback) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); callback(); };
    const stop = (error) => { reason = error; killTree(child); };
    const onAbort = () => stop(fail('client_closed', '请求已取消。', 499));
    const timer = setTimeout(() => stop(fail('cli_timeout', '本机 CLI 响应超时。', 504)), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) stop(fail('cli_output_too_large', '本机 CLI 输出过大。', 502)); else target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (failure) => finish(() => reject(failure.code === 'ENOENT' ? fail('cli_unavailable', '未找到本机 CLI，请确认已安装并加入 PATH。', 503) : fail('cli_unavailable', '无法启动本机 CLI。', 503))));
    child.on('close', (code) => finish(() => (reason ? reject(reason)
      : resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }))));
    // CLI 提前退出时写入标准输入会触发 EPIPE；真正的失败原因由退出码与输出给出。
    child.stdin.on('error', () => {});
    child.stdin.end(input, 'utf8');
  });
}

function createGate(limit, maxQueue) {
  let active = 0; const waiting = [];
  const release = () => { active--; waiting.shift()?.(); };
  return {
    get active() { return active; }, get queued() { return waiting.length; },
    async acquire(signal) {
      if (active >= limit) {
        if (waiting.length >= maxQueue) throw fail('queue_full', '本机 CLI 排队已满，请稍后重试或调低翻译并发。', 429);
        await new Promise((resolve, reject) => {
          const entry = () => { signal?.removeEventListener('abort', cancel); resolve(); };
          const cancel = () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); reject(fail('client_closed', '请求已取消。', 499)); };
          waiting.push(entry); signal?.addEventListener('abort', cancel, { once: true });
        });
      }
      active++;
      let released = false;
      return () => { if (!released) { released = true; release(); } };
    },
  };
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail('request_too_large', '请求内容过大。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('invalid_json', '请求 JSON 无效。'); }
}

function splitRoute(pathname) {
  const match = /^\/(?:(claude|codex)\/)?(?:v1\/)?(chat\/completions|models)\/?$/.exec(pathname);
  return match ? { backend: match[1], resource: match[2] } : null;
}

/** 未带后端前缀的通用路由按模型名猜测后端；猜不出时要求调用方改用带前缀的地址。 */
function inferBackend(model) {
  const name = model.toLowerCase();
  if (name.startsWith('claude') || ['haiku', 'sonnet', 'opus'].some((family) => name.startsWith(family))) return 'claude';
  if (name.startsWith('codex') || name.startsWith('gpt') || /^o\d/.test(name)) return 'codex';
  throw fail('backend_required', '无法从模型名判断后端，请使用 /claude/v1 或 /codex/v1 地址。');
}

/**
 * 创建本机 CLI 桥接。backends/spawnEnv/workdir 主要供离线测试注入假 CLI；
 * 生产入口（cli.mjs）只开放端口、令牌、可执行文件路径、默认模型、推理强度与并发等选项。
 */
export async function createLocalCliBridge({
  port = BRIDGE_PORT, token = '', backends = {}, concurrency = {}, maxQueue = 200, timeoutMs = 300_000,
  allowOrigins = [], defaultModels = {}, efforts = { codex: 'low' }, codexUserConfig = false, spawnEnv = process.env, log = () => {},
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INVALID_PORT');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new Error('INVALID_TIMEOUT');
  for (const effort of Object.values(efforts)) if (effort && !EFFORT_PATTERN.test(effort)) throw new Error('INVALID_EFFORT');
  const settings = {};
  for (const id of BACKEND_IDS) {
    const merged = { ...DEFAULT_BACKENDS[id], ...backends[id] };
    const limit = concurrency[id] ?? (id === 'claude' ? 3 : 2);
    if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('INVALID_CONCURRENCY');
    settings[id] = { ...merged, ...resolveCommand(merged.command, spawnEnv), prefixArgs: merged.prefixArgs || [], gate: createGate(limit, maxQueue), limit, version: null, available: null };
  }
  const workdir = await mkdtemp(join(tmpdir(), 'fluentread-local-cli-'));
  const tokenDigest = token ? digest(token) : null;
  const live = new Set();
  let closing = false; let boundPort;

  const originAllowed = (origin) => origin === undefined || EXTENSION_ORIGIN.test(origin) || allowOrigins.includes('*') || allowOrigins.includes(origin);
  const hostAllowed = (host) => host === `127.0.0.1:${boundPort}` || host === `localhost:${boundPort}`;

  /** 启动时探测 CLI 版本，仅用于 /health 与终端提示；探测失败不阻止启动，请求时仍会实际尝试。 */
  async function detect(id) {
    const backend = settings[id];
    try {
      const result = await runProcess({ file: backend.file, shim: backend.shim, args: [...backend.prefixArgs, '--version'], cwd: workdir, timeoutMs: 20_000, env: spawnEnv });
      backend.available = result.code === 0; backend.version = result.code === 0 ? clip(result.stdout, 80) : null;
    } catch { backend.available = false; backend.version = null; }
    return { id, label: backend.label, available: backend.available, version: backend.version };
  }

  async function complete(id, request, signal) {
    const backend = settings[id];
    const model = resolveModel(request.model, defaultModels[id]);
    const invocation = id === 'claude'
      ? buildClaudeInvocation({ ...request, model, effort: efforts.claude, shim: backend.shim })
      : buildCodexInvocation({ ...request, model, effort: efforts.codex, workdir, userConfig: codexUserConfig });
    const release = await backend.gate.acquire(signal);
    try {
      const result = await runProcess({ file: backend.file, shim: backend.shim, args: [...backend.prefixArgs, ...invocation.args], input: invocation.input, cwd: workdir, timeoutMs, signal, env: spawnEnv });
      backend.available = true;
      try { return { ...(id === 'claude' ? parseClaudeOutput(result.stdout) : parseCodexOutput(result.stdout)), model: model || 'default' }; }
      catch (failure) {
        // CLI 以非零码退出且没有结构化结果时，标准错误的末尾通常就是登录或额度提示。
        if (failure.code === 'invalid_cli_output' || (result.code !== 0 && !result.stdout.trim())) throw fail('cli_failed', `${backend.label} 退出码 ${result.code}：${clip(result.stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' ') || result.stdout || '没有输出')}`, 502);
        throw failure;
      }
    } finally { release(); }
  }

  const completionBody = (id, result, stream) => {
    const base = { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: result.model, system_fingerprint: `${BRIDGE_NAME}-${id}` };
    const usage = { ...result.usage, total_tokens: result.usage.prompt_tokens + result.usage.completion_tokens };
    return stream
      ? [{ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: result.text }, finish_reason: null }] },
        { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]
      : { ...base, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage };
  };

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    let heartbeat;
    try {
      // 只接受直连本机回环地址的请求：拒绝代理转发头与其他 Host，阻断 DNS rebinding。
      if (closing || !hostAllowed(request.headers.host) || request.headers.forwarded || request.headers['x-forwarded-host']
        || !['127.0.0.1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) throw fail('invalid_host', '拒绝非本机请求。', 403);
      const origin = request.headers.origin;
      // 普通网页的跨源请求一定带 Origin；只放行扩展页面与显式加入白名单的来源，命令行等无 Origin 客户端直接放行。
      if (!originAllowed(origin)) throw fail('invalid_origin', '仅允许浏览器扩展访问本机 CLI 桥接。', 403);
      if (origin !== undefined) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); }
      const url = new URL(request.url, `http://127.0.0.1:${boundPort}`);
      if (request.method === 'OPTIONS') {
        const requested = String(request.headers['access-control-request-headers'] || '').split(',').map((item) => item.trim()).filter((item) => /^[A-Za-z0-9-]{1,64}$/.test(item));
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        response.setHeader('Access-Control-Allow-Headers', requested.length ? requested.join(', ') : 'Authorization, Content-Type');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        response.setHeader('Access-Control-Max-Age', '600');
        response.writeHead(204); response.end(); return;
      }
      if (url.pathname === '/health' && request.method === 'GET') {
        json(response, 200, { name: BRIDGE_NAME, version: BRIDGE_VERSION, tokenRequired: Boolean(tokenDigest),
          backends: Object.fromEntries(BACKEND_IDS.map((id) => [id, { label: settings[id].label, available: settings[id].available, version: settings[id].version, active: settings[id].gate.active, queued: settings[id].gate.queued, concurrency: settings[id].limit }])) });
        return;
      }
      const route = splitRoute(url.pathname);
      if (!route) throw fail('not_found', '本机端点不存在。', 404);
      if (tokenDigest) {
        const bearer = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
        if (!bearer || !timingSafeEqual(digest(bearer), tokenDigest)) throw fail('invalid_token', '访问令牌无效：请在 FluentRead 的 API Key 中填入启动桥接时设置的令牌。', 401);
      }
      if (route.resource === 'models') {
        if (request.method !== 'GET') throw fail('invalid_method', '请求方法不支持。', 405);
        const ids = route.backend ? [route.backend] : BACKEND_IDS;
        json(response, 200, { object: 'list', data: ids.flatMap((id) => settings[id].models.map((model) => ({ id: model, object: 'model', created: 0, owned_by: `${BRIDGE_NAME}-${id}` }))) });
        return;
      }
      if (request.method !== 'POST') throw fail('invalid_method', '请求方法不支持。', 405);
      const chat = normalizeChatRequest(await readJson(request));
      const id = route.backend || inferBackend(chat.model);
      const controller = new AbortController();
      const onClose = () => { if (!response.writableEnded) controller.abort(); };
      response.on('close', onClose); live.add(controller);
      const started = Date.now();
      try {
        if (chat.stream) {
          // CLI 只在结束时给出完整文本：先发响应头并定期发送注释行保活，完成后一次性下发内容。
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
          heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 10_000);
        }
        const result = await complete(id, chat, controller.signal);
        log({ backend: id, model: result.model, status: 200, ms: Date.now() - started, inputChars: chat.system.length + chat.prompt.length, outputChars: result.text.length });
        if (chat.stream) {
          clearInterval(heartbeat);
          for (const chunk of completionBody(id, result, true)) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          response.end('data: [DONE]\n\n');
        } else json(response, 200, completionBody(id, result, false));
      } catch (failure) {
        if (failure?.code !== 'client_closed') log({ backend: id, model: chat.model || 'default', status: failure?.status || 502, ms: Date.now() - started, code: failure?.code || 'request_failed', inputChars: chat.system.length + chat.prompt.length, outputChars: 0 });
        throw failure;
      } finally { live.delete(controller); response.removeListener('close', onClose); }
    } catch (failure) {
      clearInterval(heartbeat);
      if (response.destroyed || response.writableEnded) return;
      const safe = failure instanceof BridgeError ? failure : fail('request_failed', '本机请求未完成，请重试。', 502);
      const body = { error: { message: safe.message, type: 'local_cli_error', code: safe.code } };
      if (response.headersSent) response.end(`data: ${JSON.stringify(body)}\n\n`);
      else json(response, safe.status === 499 ? 400 : safe.status, body);
    }
  });
  server.headersTimeout = 10_000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (failure) { await rm(workdir, { recursive: true, force: true }); throw failure; }
  boundPort = server.address().port;
  const base = `http://127.0.0.1:${boundPort}`;
  return {
    port: boundPort, url: base, workdir,
    endpoints: Object.fromEntries(BACKEND_IDS.map((id) => [id, `${base}/${id}/v1/chat/completions`])),
    detect: () => Promise.all(BACKEND_IDS.map(detect)),
    async close() {
      closing = true;
      for (const controller of live) controller.abort();
      server.closeAllConnections();
      await Promise.race([once(server, 'close'), new Promise((resolve) => { server.close(resolve); })]);
      await rm(workdir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    },
  };
}
