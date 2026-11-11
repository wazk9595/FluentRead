/**
 * @file tests/localCliBridgeProvider.test.ts
 * 文件职责：验证扩展侧的 OpenAI 兼容适配器与本机 CLI 桥接在真实 HTTP 上互通，而不是各自对着假想的协议形状通过测试。
 * 主要内容：启动 integrations/local-cli 的真实桥接（后端换成回显参数与输入的假 CLI），让 Claude Code 与 Codex CLI 两项服务
 * 经两项服务实际使用的 OpenAI 兼容 provider 发出请求，核对默认地址路由、模型与提示词的传递、免密钥请求、访问令牌以及 CLI 失败时扩展看到的 HTTP 502。
 * 模块边界：不启动真实的 claude/codex，不消耗账号额度；CLI 参数与输出解析的细节由 tests/localCliBridge.test.mjs 覆盖。
 */
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

vi.mock('@/src/services/config/store', () => ({config: {}}));

import {defaultModelIds, localCliBridgeServices, services} from '@/src/core/config/catalog';
import {LOCAL_CLI_BRIDGE_ENDPOINTS} from '@/src/core/config/constants';
import {setRuntimeFetch} from '@/src/platform/http/runtime';
import {translateWithOpenAICompatibleAiSdk, type AiSdkTranslationRequest} from '@/src/providers/translation/ai-sdk/openai-compatible';
import {createLocalCliBridge, type LocalCliBridge} from '../integrations/local-cli/bridge.mjs';
import {withProviderSnapshot} from './helpers/providerSnapshot';

/** 假 CLI：把收到的参数与标准输入回显成“译文”，输入含 FAIL 时模拟额度用尽。 */
const FAKE_CLI = `
const mode = process.argv[2]; const args = process.argv.slice(3);
if (args.includes('--version')) { console.log('fake ' + mode); process.exit(0); }
let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const failed = input.includes('FAIL');
  const echo = JSON.stringify({ mode, args, input });
  if (mode === 'claude') console.log(JSON.stringify(failed ? { type: 'result', is_error: true, result: 'Usage limit reached' }
    : { type: 'result', is_error: false, result: echo, usage: { input_tokens: 12, output_tokens: 5 } }));
  else if (failed) console.log(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }));
  else {
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: echo } }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 12, output_tokens: 5 } }));
  }
});
`;
const BACKEND: Record<string, 'claude' | 'codex'> = {[services.claudeCode]: 'claude', [services.codexCli]: 'codex'};
type Echo = {mode: string; args: string[]; input: string};

let directory = '';
const bridges: LocalCliBridge[] = [];

async function startBridge(options: {token?: string} = {}): Promise<LocalCliBridge> {
    const script = join(directory, 'fake-cli.mjs');
    const bridge = await createLocalCliBridge({
        port: 0, ...options,
        backends: {claude: {command: process.execPath, prefixArgs: [script, 'claude']}, codex: {command: process.execPath, prefixArgs: [script, 'codex']}},
    });
    bridges.push(bridge);
    return bridge;
}

/** 经真实 provider 发起翻译；地址通过“本机桥接地址”（proxy）指向测试桥接的随机端口。 */
function translate(service: string, bridge: LocalCliBridge, origin: string, overrides: Record<string, unknown> = {}) {
    const request = withProviderSnapshot({origin} as AiSdkTranslationRequest, {
        service, to: 'zh-Hans', token: {}, requireApiKey: {},
        model: {[service]: defaultModelIds[service as keyof typeof defaultModelIds]},
        proxy: {[service]: bridge.endpoints[BACKEND[service]!]},
        system_role: {[service]: 'You are a translator.'}, user_role: {[service]: 'Translate into {{to}}: {{origin}}'},
        translationMaxRetries: 0, ...overrides,
    });
    return translateWithOpenAICompatibleAiSdk(request);
}

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'fluentread-local-cli-provider-'));
    await writeFile(join(directory, 'fake-cli.mjs'), FAKE_CLI);
});
afterEach(async () => {
    setRuntimeFetch();
    await Promise.all(bridges.splice(0).map(bridge => bridge.close()));
});
afterAll(() => rm(directory, {recursive: true, force: true}));

describe('本机 CLI 服务经真实桥接翻译', () => {
    it('默认地址与桥接的监听端口、后端路径一致', () => {
        expect(LOCAL_CLI_BRIDGE_ENDPOINTS[services.claudeCode]).toBe('http://127.0.0.1:18765/claude/v1/chat/completions');
        expect(LOCAL_CLI_BRIDGE_ENDPOINTS[services.codexCli]).toBe('http://127.0.0.1:18765/codex/v1/chat/completions');
        expect([...localCliBridgeServices]).toEqual([services.claudeCode, services.codexCli]);
    });

    it('Claude Code：免密钥请求把模型和系统提示词交给 CLI 参数，正文走标准输入', async () => {
        const bridge = await startBridge();
        const echo = JSON.parse(String(await translate(services.claudeCode, bridge, 'Hello world'))) as Echo;
        expect(echo.mode).toBe('claude');
        expect(echo.args).toContain('--model=haiku');
        expect(echo.args).toContain('--safe-mode');
        expect(echo.args.find(argument => argument.startsWith('--system-prompt='))).toContain('You are a translator.');
        expect(echo.input).toContain('Hello world');
        expect(echo.input).not.toContain('You are a translator.');
    });

    it('Codex CLI：default 模型不传 -m，系统提示词并入标准输入', async () => {
        const bridge = await startBridge();
        const echo = JSON.parse(String(await translate(services.codexCli, bridge, 'Hello world'))) as Echo;
        expect(echo.mode).toBe('codex');
        expect(echo.args).not.toContain('-m');
        expect(echo.args.slice(0, 5)).toEqual(['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only']);
        expect(echo.input).toContain('<system_instructions>\nYou are a translator.');
        expect(echo.input).toContain('Hello world');
        // 自定义模型名原样交给 codex -m。
        const custom = JSON.parse(String(await translate(services.codexCli, bridge, 'Hello', {model: {[services.codexCli]: 'gpt-x-codex'}}))) as Echo;
        expect(custom.args[custom.args.indexOf('-m') + 1]).toBe('gpt-x-codex');
    });

    it('桥接启用访问令牌时，API Key 中的令牌作为 Bearer 发送；缺少令牌时请求被拒绝', async () => {
        const bridge = await startBridge({token: 'bridge-token-fixture'});
        await expect(translate(services.claudeCode, bridge, 'Hello')).rejects.toThrow();
        const echo = JSON.parse(String(await translate(services.claudeCode, bridge, 'Hello', {token: {[services.claudeCode]: 'bridge-token-fixture'}}))) as Echo;
        expect(echo.input).toContain('Hello');
    });

    it('CLI 报告额度或登录问题时，扩展按上游服务故障（HTTP 502）提示，具体原因留在桥接终端', async () => {
        const bridge = await startBridge();
        await expect(translate(services.claudeCode, bridge, 'FAIL')).rejects.toThrow(/HTTP 502/u);
        await expect(translate(services.codexCli, bridge, 'FAIL')).rejects.toThrow(/HTTP 502/u);
    });
});
