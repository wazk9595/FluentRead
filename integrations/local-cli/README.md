# FluentRead 本机 CLI 桥接（Claude Code / Codex CLI）

让 FluentRead 直接使用**本机已登录**的 [Claude Code CLI](https://claude.com/product/claude-code) 和 [Codex CLI](https://developers.openai.com/codex/cli) 做翻译：不需要 API Key，走的是 CLI 自己的登录与订阅额度。

浏览器扩展不能启动本机程序，所以需要这个桥接：它在 `127.0.0.1:18765` 上提供 OpenAI 兼容的 Chat Completions 接口，每次请求启动一次 `claude -p` 或 `codex exec`，把结果返回给扩展。

```
FluentRead 扩展 ──HTTP──▶ 本机桥接 (127.0.0.1:18765) ──子进程──▶ claude -p / codex exec
```

## 快速开始

1. 安装 Node.js 20 或更高版本，并确认要用的 CLI 已安装、已登录（在终端里 `claude` 或 `codex` 能正常对话）。只用其中一个也可以。
2. 启动桥接（零依赖，不需要 `npm install`）：

   ```sh
   node integrations/local-cli/cli.mjs
   ```

   用 Release 里的独立压缩包时：Windows 双击 `start.cmd`，macOS / Linux 运行 `./start.sh`。保持这个终端窗口运行。
3. 在 FluentRead 设置 → 翻译服务里选择 **Claude Code（本机）** 或 **Codex CLI（本机）**，点“检查连接”。地址留空即使用默认端口。

终端会显示检测到的 CLI 版本和服务地址：

| 服务 | 默认地址 | 模型 |
| --- | --- | --- |
| Claude Code（本机） | `http://127.0.0.1:18765/claude/v1/chat/completions` | `haiku`（默认）、`sonnet`、`opus`、`default`，或任意 `claude --model` 接受的名称 |
| Codex CLI（本机） | `http://127.0.0.1:18765/codex/v1/chat/completions` | `default`，或任意 `codex -m` 接受的名称 |

`default` 表示不指定模型，交给 CLI 自己决定。

## 选项

```sh
node integrations/local-cli/cli.mjs --help
```

| 选项 | 说明 |
| --- | --- |
| `--port <端口>` | 监听端口，默认 `18765`。改了端口要同步修改扩展里的“本机桥接地址” |
| `--token <令牌>` | 要求请求携带 `Authorization: Bearer <令牌>`；在扩展该服务的 API Key 里填同一个值 |
| `--claude-bin` / `--codex-bin <路径>` | CLI 可执行文件路径，默认从 `PATH` 查找 |
| `--claude-model` / `--codex-model <模型>` | 请求模型为 `default` 时实际使用的模型 |
| `--claude-effort` / `--codex-effort <强度>` | 推理强度。Codex 默认 `low`（翻译不需要深度推理，速度快很多），传 `none` 表示不指定 |
| `--codex-user-config <on\|off>` | 是否加载 `~/.codex/config.toml`，默认 `off`，见下方“安全边界” |
| `--concurrency <数量>` | 同时运行的 CLI 进程数，默认 `claude=3,codex=2`；可写 `4` 或 `claude=4,codex=1` |
| `--timeout <秒>` | 单次请求超时，默认 `300` |
| `--allow-origin <来源>` | 额外允许的浏览器 Origin，可重复。`*` 表示全部，务必同时设置 `--token` |

端口和令牌也可以用环境变量 `FLUENTREAD_LOCAL_CLI_PORT`、`FLUENTREAD_LOCAL_CLI_TOKEN` 设置。

## 速度与额度

每次请求都要启动一个 CLI 进程，比直接调 API 慢：实测 Claude Code（`haiku`）单次约 4–7 秒，Codex 约 12–16 秒。建议：

- 翻译整页时，在 FluentRead 的“请求限制”里把该服务的并发调到和桥接的 `--concurrency` 一致（默认 Claude 3、Codex 2），超出的请求会在桥接里排队。
- 划词翻译、输入框翻译这类单次请求体验最好；长网页整页翻译会明显消耗订阅额度，Codex 每次请求还会带上约一万 token 的固定系统提示词。
- 额度用尽或登录失效时，扩展只会提示“服务暂时不可用（HTTP 502）”；具体原因看桥接终端里的错误代码，或直接在终端运行一次 `claude` / `codex` 确认。

## 安全边界

- **只监听 `127.0.0.1`**，校验 `Host` 头并拒绝代理转发头，阻断 DNS rebinding。
- **只接受浏览器扩展的跨源请求**（`chrome-extension://`、`moz-extension://`、`safari-web-extension://`）；普通网页的请求因 `Origin` 不在白名单被拒绝。没有 `Origin` 的本机客户端（如 `curl`）可以直接访问——这台电脑上的其他程序和其他扩展同样能调用，需要进一步限制时使用 `--token`。
- **网页文本只作为待处理文本**。Claude Code 以 `--safe-mode --tools ""` 运行：不加载 `CLAUDE.md`、插件、钩子和 MCP，没有任何可调用的工具。Codex 无法移除全部工具，桥接以只读沙箱运行它，关闭 shell、代码执行宿主、联网搜索、插件与应用，并默认**不加载** `~/.codex/config.toml`（其中登记的 MCP 服务和插件会重新带来本机操作能力）；登录凭据不受影响。只有当自定义供应商或代理写在该文件里时才需要 `--codex-user-config on`，此时文件里的 MCP 服务也会随之生效。
- CLI 在一个空的临时目录里运行，使用 `--no-session-persistence` / `--ephemeral`，不写入会话历史。
- 桥接不读取、不保存任何凭据；终端日志只有后端、模型、字符数和耗时，不含正文。

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /health` | 桥接与两个 CLI 的状态，不含用户数据，无需令牌 |
| `GET /claude/v1/models`、`GET /codex/v1/models` | 建议的模型名 |
| `POST /claude/v1/chat/completions`、`POST /codex/v1/chat/completions` | OpenAI 兼容补全；支持 `stream: true`（CLI 只在结束时给出全文，桥接先保活、完成后一次性下发） |
| `POST /v1/chat/completions` | 通用入口，按模型名（`haiku`/`sonnet`/`opus`/`claude-*` → Claude，`gpt-*`/`codex*` → Codex）选择后端 |

只支持纯文本消息；图片输入、工具调用会被拒绝。`temperature` 等采样参数 CLI 无法表达，会被忽略。任何兼容 OpenAI 接口的客户端都可以使用这些地址：

```sh
curl http://127.0.0.1:18765/claude/v1/chat/completions -H "Content-Type: application/json" -d '{"model":"haiku","messages":[{"role":"user","content":"把 hello 翻译成中文"}]}'
```

## 常见问题

- **扩展提示连接失败**：确认桥接终端还在运行，`http://127.0.0.1:18765/health` 能打开；端口被占用时换 `--port` 并同步修改扩展里的地址。
- **终端显示“未检测到可用的 CLI”**：CLI 不在 `PATH` 里，用 `--claude-bin` / `--codex-bin` 指定完整路径。安装并登录后无需重启桥接。
- **Windows 上 CLI 是 npm 安装的 `.cmd`**：可以直接使用；此时系统提示词会并入正文传给 CLI（`.cmd` 无法安全传递任意文本参数），效果与原生可执行文件基本一致。
- **Codex 很慢或报 `Reconnecting`**：是 Codex 连接 ChatGPT 服务的网络问题，与桥接无关；先在终端里确认 `codex exec "hi"` 本身是否顺畅。

## 测试

```sh
node --test tests/localCliBridge.test.mjs
```

离线测试用假 CLI 验证请求校验、参数构造、来源与令牌边界、流式响应、错误映射、超时、取消和并发排队，不消耗真实额度。
