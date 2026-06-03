# Qwen Gate

> **⚠️ Disclaimer**: This project is for **educational and study purposes only**. It is an OpenAI-compatible API gateway that interfaces with Qwen models via `chat.qwen.ai`. The project is not affiliated with, endorsed by, or sponsored by Alibaba Group, Qwen, or `chat.qwen.ai`. All Qwen models and the `chat.qwen.ai` service are the property of their respective owners. Users are responsible for complying with `chat.qwen.ai`'s terms of service. The author assumes no responsibility for misuse, unauthorized access, or any violations of third-party terms.

OpenAI-compatible API gateway for **Qwen models (chat.qwen.ai)** using Playwright browser automation. Supports tool calling, thinking/reasoning, streaming, session autoscaling, multi-account management, and full OpenAI-compatible response formatting.

## Features

- **OpenAI-compatible API** — `/v1/chat/completions` and `/v1/models` with streaming + non-streaming
- **Tool calling** — full function/tool schema support with validation, spam detection, and correction feedback
- **Thinking / reasoning** — `<think>` block handling and emission
- **Multi-account sessions** — CloakBrowser-backed per-account browser contexts with automatic rotation
- **Session autoscaling** — concurrent sessions spun up under load
- **Streaming SSE** — incremental delta emission, heartbeat keep-alive, and content-filter integrity across stream boundaries
- **Content filter** — strips tool-call artifacts, streaming JSON fragment leaks, and XML leaks while preserving code whitespace
- **Token estimation** — context window validation with accurate token counting
- **Rate limiting** — per-account cooldown tracking with configurable throttle
- **Echo detection** — detects when the model parrots tool results and signals a network-level retry to the OpenAI SDK
- **Live dashboard** — Astro-powered web UI at `/dashboard` with request logs, account status, and session pool stats

## Quick Start

```bash
npm install
npm run setup        # interactive config wizard → writes .env
npm run dev          # starts API + Astro dashboard
```

The wizard walks you through setting the port, API key, and browser engine. Visit `http://localhost:26405/v1` once running.

## Configuration

Configuration uses `config.json` (created via `npm run setup` or the dashboard settings page). Environment variables still work but `config.json` takes precedence for most values.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `26405` | Proxy server port |
| `HOST` | `localhost` | Bind host. Use `0.0.0.0` to expose on all interfaces. |
| `API_KEY` | *(empty)* | Protects `/v1/*` endpoints. Clients send as `Authorization: Bearer <key>`. Leave empty for no auth. |

### Echo Detector

| Variable | Default | Description |
|----------|---------|-------------|
| `ECHO_DETECTOR` | `true` | Enable the streaming echo detector. When enabled, if the model repeats tool output verbatim mid-stream, the connection drops and the SDK retries on a fresh session with a correction prompt. Set `false` to disable. |
| `ECHO_JACCARD_THRESHOLD` | `0.9` | Bidirectional shingle containment threshold (0.0–1.0). Higher = stricter detection. At 0.9, output must share ≥90% of 5-gram shingles with a tool result line in both directions to trigger. |
| `ECHO_MIN_LINE_LENGTH` | `20` | Minimum line length in characters for echo comparison. Shorter lines are skipped (too few shingles for reliable matching). |
| `ECHO_MIN_UNIQUE_SHINGLES` | `8` | Minimum unique 5-gram shingles required for a line to be checked. |

### Browser Engine

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER` | `chromium` | Browser backend: `chromium` (bundled), `firefox`, `chrome`, or `edge` (system installs). |

### Qwen Account Management

Accounts are **not** configured via env vars. They live in persistent storage (`data/accounts.json`) and are managed via the `/accounts` API or the dashboard UI.

| Variable | Default | Description |
|----------|---------|-------------|
| `RATE_LIMIT_COOLDOWN_MS` | `120000` | Cooldown duration (ms) when an account is rate-limited. |
| `QWEN_FETCH_TIMEOUT_MS` | `30000` | Timeout (ms) for Qwen API fetch requests. |
| `AUTH_REFRESH_BEFORE_MS` | `300000` | Refresh the auth token this many ms before it expires (default 5 min). |
| `AUTH_TOKEN_MAX_AGE_MS` | `28800000` | Force a token refresh when the token is older than this (default 8 h). |
| `DELETE_SESSION` | `true` | Delete chat sessions on Qwen's backend when the pool releases them. Set to `false` to keep history for debugging. |

### Output / Pipeline Control

These control how the Qwen response is transformed before being sent back to the client.

| Variable | Default | Description |
|----------|---------|-------------|
| `TOOL_CALLING` | `true` | Parse tool invocations and apply schema validation. Set `false` to pass Qwen's raw output through unchanged. |
| `MAX_TOOL_CALLS_PER_RESPONSE` | `3` | Maximum identical `(tool, args)` calls allowed per response before the spam guard kicks in. |
| `CONTENT_FILTER` | `true` | Strip tool-call artifacts, XML leaks, and thinking block noise. |
| `CLEAN_OUTPUT` | `true` | Strip backticks and collapse whitespace in parser output (only when `TOOL_CALLING=true`). |
| `STREAMING` | *(client)* | Force streaming: `true` = always stream, `false` = never stream. Unset = respect the client's `stream` field. |
| `NON_STREAMING` | *(unset)* | Set to `true` to force non-streaming mode (legacy alias). |

### Dashboard

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD` | `true` | Enable the web dashboard at `/dashboard`. Set `false` to disable. |
| `ASTRO_PORT` | `4321` | Astro dev server port. |

### Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG` | *(unset)* | Enable verbose debug logging — shows raw Qwen chunks vs processed output. |
| `DEBUG_STREAM` | *(unset)* | Debug streaming pipeline only, without full `DEBUG` noise. |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error`. Automatically set to `debug` if `DEBUG=true`. |
| `LOG_FORMAT` | `text` | Set to `json` for JSON-lines output (useful for log aggregators). |
| `LOG_MAX_ENTRIES` | `20` | Max visible entries in the log page / log stream. Controls both in-memory storage and SSE batch size. |

### Upstream Retry

Controls how the gateway retries failed requests to the Qwen API (backoff with jitter).

| Variable | Default | Description |
|----------|---------|-------------|
| `RETRY_ENABLED` | `true` | Master switch for upstream retries. Set `false` to disable. |
| `RETRY_MAX_ATTEMPTS` | `3` | Maximum retry attempts per upstream request. |
| `RETRY_BASE_DELAY_MS` | `1000` | Base delay between retries (ms). |
| `RETRY_MAX_DELAY_MS` | `30000` | Maximum delay between retries (ms). |
| `RETRY_BACKOFF_MULTIPLIER` | `2` | Exponential backoff multiplier. |

### Testing (internal)

| Variable | Description |
|----------|-------------|
| `TEST_MOCK_PLAYWRIGHT` | Set by the test suite to mock Playwright. Do not set in production. |
| `TEST_SESSION_ID` | Mock session ID returned when `TEST_MOCK_PLAYWRIGHT` is set. |

## Usage

### Streaming chat completion

```bash
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-max",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain quicksort"}]
  }'
```

### Tool calling

```bash
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-max",
    "messages": [{"role": "user", "content": "What is the weather in Paris?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "parameters": {
          "type": "object",
          "properties": {
            "city": {"type": "string"}
          },
          "required": ["city"]
        }
      }
    }]
  }'
```

### List models

```bash
curl http://localhost:26405/v1/models
```

## Architecture

```
           ┌──────────────┐
           │  OpenAI      │
           │  Client      │
           └──────┬───────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │  Hono Server (PORT=26405)    │
   │  /v1/chat/completions        │
   │  /v1/models                  │
   │  /accounts                   │
   └──────────────┬───────────────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │  Session Pool                │   CloakBrowser sessions per account
   │  ─ autoscaling               │   auto-created, rotated, recycled
   │  ─ multi-account rotation    │
   └──────────────┬───────────────┘
                  │
                  ▼
   ┌──────────────────────────────┐
   │  Playwright Route Handler    │   intercepts chat.qwen.ai
   │  request rewrite → response  │   rewrites payload in-flight
   └──────────────┬───────────────┘
                  │
                  ▼
   ┌──────────────┐
   │  Pipeline    │   ToolSpamGuard · content filter · echo filter
   │              │   streaming deltas · token estimation
   └──────────────┘
```

### Request Flow

1. Client POSTs to `/v1/chat/completions` with OpenAI-format payload
2. Session pool picks an authenticated Playwright session (rotating across accounts)
3. Outbound browser request is intercepted and rewritten to Qwen's internal format
4. Response streams back through the pipeline:
   - **ToolSpamGuard** — sliding-window dedup rejects repeated `(tool, args)` calls and injects correction feedback on the next turn
   - **Content filter** — strips tool-call artifacts, XML leaks, and streaming JSON fragments while preserving code whitespace
   - **Echo filter** — detects when the model parrots tool results; aborts the upstream writer so the OpenAI SDK retries on a fresh session with a correction prompt injected
   - **Streaming deltas** — incremental emission with snapshot diffing; flush path aligns with streaming state to prevent duplication
5. Final response is formatted as an OpenAI-compatible SSE stream or JSON object

## Dashboard

Visit `http://localhost:<PORT>/dashboard` for the live dashboard:

- Request log with per-entry foldable sections (raw chunks, raw AI response, processed output)
- Account status and cooldown indicators
- Session pool health and autoscaling stats
- Live SSE updates as requests stream in
- System logs panel with level/category filtering
- Color-coded chunk types (tool vs text) and full content inspection

## Testing

```bash
npm test
```

Uses the `node:test` runner. Tests cover content filtering, tool-call parsing, echo detection, and spam guard behavior. The `TEST_MOCK_PLAYWRIGHT` env var is set internally by the test suite to mock the browser layer.

## License

[MIT](./LICENSE)
