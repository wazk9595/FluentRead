#!/usr/bin/env node
/**
 * @file integrations/local-cli/cli.mjs
 * FluentRead 本机 CLI 桥接的独立 Node 入口：零依赖，解析命令行与环境变量后启动 bridge.mjs。
 * 终端只显示监听地址、CLI 探测结果与每次请求的摘要（后端、模型、字符数、耗时），不打印正文与令牌。
 */
import { createLocalCliBridge, BRIDGE_PORT, BACKEND_IDS } from './bridge.mjs';

const HELP = `用法：node integrations/local-cli/cli.mjs [选项]

把本机已登录的 Claude Code CLI 与 Codex CLI 暴露为 OpenAI 兼容接口，供 FluentRead 调用。
只监听 127.0.0.1，默认端口 ${BRIDGE_PORT}。

选项：
  --port <端口>              监听端口（默认 ${BRIDGE_PORT}，环境变量 FLUENTREAD_LOCAL_CLI_PORT）
  --token <令牌>             要求请求携带 Authorization: Bearer <令牌>
                             （环境变量 FLUENTREAD_LOCAL_CLI_TOKEN；在 FluentRead 的 API Key 中填同一个值）
  --claude-bin <路径>        claude 可执行文件（默认从 PATH 查找）
  --codex-bin <路径>         codex 可执行文件（默认从 PATH 查找）
  --claude-model <模型>      请求模型为 default 时使用的 Claude 模型（默认交给 CLI 决定）
  --codex-model <模型>       请求模型为 default 时使用的 Codex 模型（默认交给 CLI 决定）
  --claude-effort <强度>     Claude 推理强度 low/medium/high…（默认不指定）
  --codex-effort <强度>      Codex 推理强度（默认 low；传 none 表示不指定）
  --codex-user-config <on|off>
                             是否加载 ~/.codex/config.toml（默认 off：不加载其中的 MCP 服务、插件与模型设置，
                             只复用登录；自定义供应商或代理写在该文件里时改为 on）
  --concurrency <数量>       同时运行的 CLI 进程数，可写 3 或 claude=3,codex=2（默认 claude=3,codex=2）
  --timeout <秒>             单次请求超时（默认 300）
  --allow-origin <来源>      额外允许的浏览器 Origin，可重复；* 表示全部（务必同时设置 --token）
  --help                     显示本帮助`;

function exit(message) { console.error(`${message}\n使用 --help 查看用法。`); process.exit(1); }

const options = {
  port: Number(process.env.FLUENTREAD_LOCAL_CLI_PORT || BRIDGE_PORT), token: process.env.FLUENTREAD_LOCAL_CLI_TOKEN || '',
  backends: {}, concurrency: {}, defaultModels: {}, efforts: { codex: 'low' }, allowOrigins: [], timeoutMs: 300_000,
};
const argumentsList = process.argv.slice(2);
if (argumentsList.includes('--help') || argumentsList.includes('-h')) { console.log(HELP); process.exit(0); }
if (Number(process.versions.node.split('.')[0]) < 20) exit('本机 CLI 桥接需要 Node.js 20 或更高版本。');
for (let index = 0; index < argumentsList.length; index++) {
  const option = argumentsList[index];
  const value = argumentsList[++index];
  if (value === undefined) exit(`选项 ${option} 缺少取值。`);
  const backend = /^--(claude|codex)-(bin|model|effort)$/.exec(option);
  if (backend?.[2] === 'bin') options.backends[backend[1]] = { command: value };
  else if (backend?.[2] === 'model') options.defaultModels[backend[1]] = value;
  else if (backend?.[2] === 'effort') options.efforts[backend[1]] = value === 'none' ? '' : value;
  else if (option === '--codex-user-config') {
    if (!['on', 'off'].includes(value)) exit('--codex-user-config 只接受 on 或 off。');
    options.codexUserConfig = value === 'on';
  } else if (option === '--port') options.port = Number(value);
  else if (option === '--token') options.token = value;
  else if (option === '--timeout') options.timeoutMs = Math.round(Number(value) * 1000);
  else if (option === '--allow-origin') options.allowOrigins.push(value);
  else if (option === '--concurrency') {
    for (const part of value.split(',')) {
      const [name, count] = part.includes('=') ? part.split('=') : [null, part];
      if (name && !BACKEND_IDS.includes(name)) exit(`未知的后端：${name}`);
      for (const id of name ? [name] : BACKEND_IDS) options.concurrency[id] = Number(count);
    }
  } else exit(`未知选项：${option}`);
}
if (options.allowOrigins.includes('*') && !options.token) console.warn('警告：--allow-origin * 会让任意网页都能调用本机 CLI，请同时设置 --token。');

let bridge;
try {
  bridge = await createLocalCliBridge({
    ...options,
    log: (entry) => console.log(`[${new Date().toLocaleTimeString()}] ${entry.backend} ${entry.model} ${entry.status}${entry.code ? ` ${entry.code}` : ''} ${entry.ms}ms 输入${entry.inputChars}字 输出${entry.outputChars}字`),
  });
} catch (failure) {
  exit(failure.code === 'EADDRINUSE' ? `端口 ${options.port} 已被占用：请关闭已在运行的桥接，或用 --port 换一个端口（并同步修改 FluentRead 里的服务地址）。`
    : failure.message?.startsWith('INVALID_') ? `启动参数无效（${failure.message}）。` : '本机 CLI 桥接无法启动。');
}
console.log(`FluentRead 本机 CLI 桥接已启动：${bridge.url}${options.token ? '（已启用访问令牌）' : ''}`);
for (const status of await bridge.detect()) {
  console.log(status.available
    ? `  ✔ ${status.label}  ${status.version}\n      服务地址：${bridge.endpoints[status.id]}`
    : `  ✘ ${status.label}  未检测到可用的 CLI（安装并登录后无需重启桥接）`);
}
console.log('在 FluentRead 设置的翻译服务中选择“Claude Code（本机）”或“Codex CLI（本机）”即可使用。Ctrl+C 退出。');

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await bridge.close(); process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
