# Qwen Gate Development Guide

A practical guide for developers working on Qwen Gate. Covers the codebase structure, development workflow, and common tasks.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Structure](#code-structure)
  - [Routes (Hono Framework)](#routes-hono-framework)
  - [Services Layer](#services-layer)
  - [Tool System](#tool-system)
  - [Utilities](#utilities)
  - [Session Pool Management](#session-pool-management)
- [Adding Features](#adding-features)
  - [Add a New API Endpoint](#add-a-new-api-endpoint)
  - [Add a Dashboard Page](#add-a-dashboard-page)
  - [Add a New Tool](#add-a-new-tool)
- [Code Style](#code-style)
  - [TypeScript Conventions](#typescript-conventions)
  - [Error Handling Patterns](#error-handling-patterns)
  - [Logging](#logging)
- [Configuration](#configuration)
- [Verification Checklist](#verification-checklist)

---

## Prerequisites

- **Node.js** 18+ (tested with 20+)
- **npm** 9+
- A **Qwen account** at `chat.qwen.ai` (for actual development/testing)

On first setup:

```bash
npm install
npm run setup          # interactive config wizard
```

The wizard creates `config.json` with your settings. You can also copy `.env.example` to `.env` and edit directly.

---

## Project Structure

```
qwen-gate/
├── src/
│   ├── index.tsx              # Server entry point, Hono app setup
│   ├── login.ts               # CLI login helper
│   ├── cli.ts                 # CLI entry point
│   ├── routes/                # HTTP route handlers (Hono)
│   │   ├── chat.ts            # POST /v1/chat/completions handler
│   │   ├── chatStreaming.ts   # Streaming response logic
│   │   ├── chatNonStreaming.ts# Non-streaming response logic
│   │   ├── chatHelpers.ts     # Shared chat request/response utilities
│   │   ├── accounts.ts        # Account CRUD API
│   │   ├── config.ts          # Config management API
│   │   ├── debugNetwork.ts    # Network debug routes
│   │   ├── pipeline/          # Response processing pipeline
│   │   │   ├── StreamingContentFilter.ts
│   │   │   ├── StreamingEchoFilter.ts
│   │   │   ├── StreamingEchoFilter.test.ts
│   │   │   ├── ToolResultEchoFilter.ts
│   │   │   └── ToolResultEchoFilter.test.ts
│   │   └── dashboard/         # Dashboard HTML pages
│   │       ├── overview.ts    # Main overview page
│   │       ├── logs.ts        # Request log viewer
│   │       ├── accounts.ts    # Account management page
│   │       ├── network.ts     # Network inspector
│   │       └── settings.ts    # Configuration editor
│   ├── services/              # Business logic layer
│   │   ├── sessionPool.ts     # Session pool manager
│   │   ├── auth.ts            # Authentication core (export hub)
│   │   ├── accountManager.ts  # Account state tracking
│   │   ├── loginHelpers.ts    # Login implementation helpers
│   │   ├── tokenRefresh.ts    # Token refresh logic
│   │   ├── playwright.ts      # Playwright browser automation
│   │   ├── browserProfiles.ts # Browser profile management
│   │   ├── configService.ts   # Config loading (env > config.json > defaults)
│   │   ├── logStore.ts        # Request log store with SSE push
│   │   ├── qwen.ts            # Qwen API interaction helpers
│   │   ├── qwenModels.ts      # Model listing and metadata
│   │   ├── modelRouter.ts     # Model-to-route mapping
│   │   ├── modelHealth.ts     # Model health tracking
│   │   └── networkDebug.ts    # Network request recording
│   ├── tools/                 # Tool calling system
│   │   ├── registry.ts        # ToolRegistry class (register/lookup)
│   │   ├── executor.ts        # Tool execution runner
│   │   ├── toolRunner.ts      # Tool call parsing and execution
│   │   ├── parser.ts          # Tool call extraction from text
│   │   ├── parserHelpers.ts   # Parser utilities
│   │   ├── guard.ts           # Tool validation and spam guard
│   │   ├── schema.ts          # JSON Schema validation
│   │   ├── schemaValidators.ts# Built-in schema validators
│   │   ├── types.ts           # Tool type re-exports
│   │   └── *.test.ts          # Tool tests
│   ├── utils/                 # Shared utilities
│   │   ├── logger.ts          # Structured logging (createLogger)
│   │   ├── retry.ts           # Retry with backoff + circuit breaker
│   │   ├── contentFilter.ts   # Response content sanitization
│   │   ├── tokenEstimator.ts  # Token count estimation
│   │   ├── json.ts            # JSON parsing utilities
│   │   ├── types.ts           # Re-exported types
│   │   ├── xmlStripper.ts     # XML leak stripping
│   │   ├── thinkTagStripper.ts# <think> block handling
│   │   └── contextSanitizer.ts# Context cleanup
│   ├── middleware/
│   │   └── rateLimit.ts       # Rate limiting middleware
│   ├── types/
│   │   └── openai.ts          # All shared TypeScript types
│   ├── tests/                 # Integration tests
│   │   ├── index.test.ts      # Server integration tests
│   │   ├── largeBuffer.test.ts# Large payload tests
│   │   └── parallel.test.ts   # Concurrent request tests
│   └── components/            # (reserved for future use)
├── config.json                # Runtime configuration
├── tsconfig.json              # TypeScript configuration
├── tsconfig.build.json        # Build-specific TS config
└── package.json
```

### Key Directories at a Glance

| Directory | Purpose |
|-----------|---------|
| `src/routes/` | HTTP route handlers. Each file exports Hono route definitions. |
| `src/routes/dashboard/` | Dashboard HTML pages rendered server-side as template strings. |
| `src/routes/pipeline/` | Streaming response filters applied in real time. |
| `src/services/` | Core business logic: auth, session pool, Playwright, config, logging. |
| `src/tools/` | Tool calling system: registry, parser, guard, schema validation, execution. |
| `src/utils/` | Shared utilities: logger, retry, content filter, token estimator. |
| `src/types/` | Central TypeScript type definitions. |
| `src/tests/` | Server-level integration and concurrency tests. |

---

## Development Workflow

### Start Dev Server

```bash
npm run dev
```

Uses `tsx` to run TypeScript directly with hot module reload. The server starts on `http://localhost:26405` (configurable via `PORT`).

The dev command:
1. Initializes Playwright (chromium by default)
2. Loads accounts from persistent storage
3. Pre-warms Qwen auth headers
4. Starts the Hono HTTP server
5. Opens the dashboard at `/dashboard`

### Build for Production

```bash
npm run build
```

Compiles TypeScript to the `dist/` directory using `tsconfig.build.json`. The build config excludes test files and emits declaration files with source maps.

### Production Start

```bash
npm start
```

Runs the compiled output through `tsx` with grep filtering to suppress noisy env injection messages.

### Other Commands

```bash
npm run setup        # Run the interactive setup wizard
npm run login        # Login to a Qwen account via CLI
npm run qg           # Launch the CLI tool
npm run qg:login     # CLI login shortcut
npm run qg:restart   # CLI restart
```

### Important Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `26405` | Server port |
| `HOST` | `localhost` | Bind address |
| `API_KEY` | (empty) | Bearer token for API auth |
| `BROWSER` | `chromium` | Playwright browser engine |
| `LOG_LEVEL` | `info` | Log verbosity |
| `DEBUG` | (unset) | Enable verbose debug logging |

See `.env.example` for the full list.

---

## Testing

### Test Framework

Qwen Gate uses **Node.js built-in test runner** (`node:test`) with Node's assertion library (`node:assert`). No external test framework is needed.

### Test File Naming

Tests live alongside their source files using the `*.test.ts` convention:

```
src/tools/guard.ts          # source
src/tools/guard.test.ts     # tests
src/tools/parser.ts         # source
src/tools/parser.test.ts    # tests
```

Server-level integration tests live in `src/tests/`:

```
src/tests/index.test.ts     # server integration
src/tests/largeBuffer.test.ts
src/tests/parallel.test.ts
```

### Running Tests

```bash
npm test
```

This runs `tsx --test src/**/*.test.ts`. The `tsx` runner handles TypeScript compilation transparently.

### Running Specific Tests

```bash
npx tsx --test src/tools/guard.test.ts
npx tsx --test src/routes/pipeline/StreamingEchoFilter.test.ts
```

You can also filter by test name:

```bash
npx tsx --test --test-name-pattern="echo" src/**/*.test.ts
```

### TEST_MOCK_PLAYWRIGHT

The test suite sets `process.env.TEST_MOCK_PLAYWRIGHT = 'true'` at the top of the test entry point. When this flag is present:

- `SessionPool.acquire()` returns a mock session immediately
- Playwright initialization becomes a no-op
- `initPlaywright(false)` can be called without a real browser

This lets integration tests run without a real Qwen account or browser. The mock session ID can be customized with `TEST_SESSION_ID`.

```typescript
// Example: setting up mock Playwright in a test
process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = '';

import { app } from '../index.tsx';
import { initPlaywright } from '../services/playwright.ts';

test('health check', async () => {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  assert.strictEqual(res.status, 503);
});
```

### Writing Tests

- Place unit tests next to the source file (e.g. `guard.test.ts` next to `guard.ts`)
- Place integration tests in `src/tests/`
- Mock `globalThis.fetch` for HTTP-level tests
- Use `app.fetch()` from Hono to test endpoints without starting a server
- Use `describe` and `it` / `test` from `node:test`

```typescript
import test from 'node:test';
import assert from 'node:assert';

test('feature works as expected', async () => {
  const result = await someFunction();
  assert.strictEqual(result, expectedValue);
});
```

---

## Code Structure

### Routes (Hono Framework)

The server uses the [Hono](https://hono.dev) web framework. Routes are defined in `src/routes/` and registered in `src/index.tsx`.

**Route Registration Pattern**:

```typescript
// src/index.tsx
import { Hono } from 'hono';
export const app = new Hono();

// Simple inline handler
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// Imported route handler
app.post('/v1/chat/completions', chatCompletions);

// Routers (groups of routes)
import { accountsRouter } from './routes/accounts.ts';
app.route('/api/accounts', accountsRouter);
```

**Router Pattern** (for grouped routes):

```typescript
// src/routes/accounts.ts
import { Hono } from 'hono';
export const accountsRouter = new Hono();

accountsRouter.get('/', (c) => {
  return c.json(getAccounts());
});

accountsRouter.post('/', async (c) => {
  const body = await c.req.json();
  // ...
  return c.json({ success: true }, 201);
});

accountsRouter.delete('/:email', (c) => {
  removeAccount(c.req.param('email'));
  return c.json({ success: true });
});
```

**Middleware**:

Hono middleware is registered with `app.use()`. The server uses:
- `cors()` for cross-origin requests
- `bearerAuth()` for API key auth on `/v1/*`
- Custom body size limiting on `/v1/chat/completions`

### Services Layer

Services in `src/services/` encapsulate all business logic. They are plain TypeScript modules (not classes in most cases) with singleton instances.

**Pattern**: Export a singleton instance + its type.

```typescript
// services/configService.ts
export class ConfigService {
  get<K extends keyof ConfigSchema>(key: K, defaultValue?: string): string { ... }
  set<K extends keyof ConfigSchema>(key: K, value: string): void { ... }
  getAll(): ConfigSchema { ... }
  save(): void { ... }
}
export const config = new ConfigService();
```

**Service responsibilities**:

| Service | Responsibility |
|---------|---------------|
| `sessionPool.ts` | Acquire/release sessions, manage wait queue, autoscaling |
| `auth.ts` | Re-exports from accountManager, loginHelpers, tokenRefresh |
| `accountManager.ts` | Account CRUD, authentication state, rate limit tracking |
| `playwright.ts` | Browser lifecycle, page management, request interception |
| `configService.ts` | Config loading with env > config.json > defaults priority |
| `logStore.ts` | In-memory log storage with SSE push subscriptions |
| `qwen.ts` | Qwen backend API calls (models, headers, settings) |
| `modelRouter.ts` | Map requested model to Qwen's internal model ID |

Dependency flow is strictly one-directional:

```
routes → services → utils
                ↓
           playwright, auth, sessionPool
```

Routes import services; services import utils. Services should not import routes.

### Tool System

The tool system in `src/tools/` handles parsing, validating, and executing tool calls in the OpenAI-compatible format.

**Core Components**:

| File | Role |
|------|------|
| `types.ts` | Re-exports shared tool types from `types/openai.ts` |
| `registry.ts` | `ToolRegistry` class: `register()`, `get()`, `execute()`, `toOpenAITools()` |
| `parser.ts` | Extract tool calls from text content |
| `guard.ts` | Validate tool call structure, spam detection |
| `schema.ts` | JSON Schema validation against registered parameters |
| `schemaValidators.ts` | Built-in validators for common types |
| `toolRunner.ts` | Parse, execute, and format tool results |
| `executor.ts` | High-level execution with timeout and concurrency control |

**Tool Execution Flow**:

1. Qwen response text is parsed for `{"name": "...", "arguments": {...}}` patterns
2. Extracted tool calls are validated by `guard.ts` (structural validation)
3. Each call is looked up in the `registry` and validated against its registered JSON Schema
4. The handler function is invoked via `registry.execute()`
5. Results are serialized and returned as tool messages

**Registering a tool programmatically**:

```typescript
import { registry } from '../tools/registry.ts';

registry.register(
  'get_weather',              // tool name (must match what the LLM emits)
  'Get weather for a city',  // description
  {                          // JSON Schema parameters
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  async (args, context) => {  // handler
    const weather = await fetchWeather(args.city);
    return JSON.stringify(weather);
  }
);
```

Tools are registered at startup. The registry converts them to OpenAI-compatible format via `toOpenAITools()`.

### Utilities

Shared utilities live in `src/utils/`. They are stateless, pure functions or logger factories.

| Utility | Purpose |
|---------|---------|
| `logger.ts` | `createLogger(context)` returns `{ debug, info, warn, error }` |
| `retry.ts` | `withRetry()` with exponential backoff, jitter, circuit breaker |
| `contentFilter.ts` | Strip tool artifacts, XML leaks, streaming fragments |
| `tokenEstimator.ts` | Count tokens, check context window limits |
| `json.ts` | Robust JSON parsing with repair |
| `xmlStripper.ts` | Remove XML tags from output |
| `thinkTagStripper.ts` | Handle `<think>` blocks |
| `contextSanitizer.ts` | Clean context before sending to Qwen |

### Session Pool Management

The session pool (`src/services/sessionPool.ts`) manages Playwright browser sessions across Qwen accounts.

**Key concepts**:

- **PoolEntry**: A chat session bound to an account, identified by `chatId` and `parentId`.
- **Acquire**: Get a session. Routes to a specific email if provided, otherwise picks the best account.
- **Release**: Return a session to the pool or destroy it.
- **Queue**: If all sessions are busy, callers wait in a FIFO queue (max 10, timeout 60s).
- **Autoscaling**: Sessions are created on demand up to a configurable limit.

```typescript
// Acquire a session
const entry = await sessionPool.acquire('user@example.com');
// entry.chatId, entry.parentId, entry.cachedHeaders

// Release when done
await sessionPool.release(entry.chatId);
```

The pool uses `incrementInFlight` / `decrementInFlight` from the account manager to track active usage per account. This prevents routing new requests to saturated accounts.

---

## Adding Features

### Add a New API Endpoint

1. **Create the route handler** in `src/routes/`:

```typescript
// src/routes/hello.ts
import { Hono } from 'hono';

export const helloRouter = new Hono();

helloRouter.get('/', (c) => {
  return c.json({ message: 'Hello from the new endpoint!' });
});

helloRouter.post('/echo', async (c) => {
  const body = await c.req.json();
  return c.json({ echo: body });
});
```

2. **Register it** in `src/index.tsx`:

```typescript
import { helloRouter } from './routes/hello.ts';

// With auth protection
app.use('/api/hello/*', async (c, next) => {
  const apiKey = config.get('API_KEY');
  if (!apiKey) return await next();
  return bearerAuth({ token: apiKey })(c, next);
});
app.route('/api/hello', helloRouter);
```

3. **Add business logic** to a service if the endpoint does meaningful work beyond CRUD.

4. **Add tests**:

```typescript
// src/routes/hello.test.ts
import test from 'node:test';
import assert from 'node:assert';
import { helloRouter } from './hello.ts';

test('GET /api/hello returns greeting', async () => {
  const req = new Request('http://localhost/');
  const res = await helloRouter.fetch(req);
  assert.strictEqual(res.status, 200);
  const body = await res.json();
  assert.strictEqual(body.message, 'Hello from the new endpoint!');
});
```

### Add a Dashboard Page

Dashboard pages are server-rendered HTML. Each page is a `const` string export in `src/routes/dashboard/`.

1. **Create the page template**:

```typescript
// src/routes/dashboard/analytics.ts
export const analyticsHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Qwen Gate — Analytics</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono&family=Montserrat:wght@400;500;600;700&family=Poppins:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    /* Import shared CSS variables from overview.ts or define your own */
    :root {
      --bg-primary: #F5F1EA;
      --bg-card: #E9E2D6;
      --border: #C9BFAE;
      --text-primary: #1a1615;
      --accent: #5E9D5C;
      --font: 'Montserrat', sans-serif;
      --mono: 'JetBrains Mono', monospace;
    }
    /* ... your page styles ... */
  </style>
</head>
<body>
  <div class="dashboard-layout">
    <!-- Sidebar: copy from overview.ts and update active link -->
    <main class="main-content">
      <h1>Analytics</h1>
      <!-- Your content -->
    </main>
  </div>
  <script>
    // Client-side logic
  </script>
</body>
</html>`;
```

2. **Register the route** in `src/index.tsx`:

```typescript
import { analyticsHtml } from './routes/dashboard/analytics.ts';

app.get('/dashboard/analytics', serveHtml(analyticsHtml));
```

3. **Add a nav link** in each dashboard template's sidebar.

### Add a New Tool

1. **Define the tool** using the registry (can be done anywhere that runs at startup):

```typescript
// src/tools/myTool.ts
import { registry } from './registry.ts';

registry.register(
  'my_custom_tool',
  'Description of what this tool does',
  {
    type: 'object',
    properties: {
      input1: { type: 'string', description: 'First input' },
      input2: { type: 'number', description: 'Second input' },
    },
    required: ['input1'],
  },
  async (args, context) => {
    // args.input1, args.input2
    // context has request metadata
    const result = await doSomething(args.input1, args.input2);
    return JSON.stringify(result);
  }
);
```

2. **Import the module** in `src/index.tsx` (or wherever it is needed) so the registration runs:

```typescript
// This import ensures the tool is registered at startup
import './tools/myTool.ts';
```

3. **The tool is now available**. When a request includes `tools` in the body, Qwen can call `my_custom_tool` and the system will:
   - Parse the call from the response
   - Validate arguments against the schema
   - Execute the handler
   - Return the result to the client

4. **Add tests**:

```typescript
// src/tools/myTool.test.ts
import test from 'node:test';
import assert from 'node:assert';
import { registry } from './registry.ts';

test('my_custom_tool does what it should', async () => {
  const result = await registry.execute('my_custom_tool', { input1: 'test' }, {} as any);
  assert.ok(result);
  // ... more assertions
});
```

---

## Code Style

### TypeScript Conventions

- **Module system**: ES modules (`"type": "module"` in package.json). Use `import` / `export`, never `require`.
- **Import extensions**: Use `.ts` extension in imports (Hono + tsx resolve these).
- **Strict mode**: `strict: true` in tsconfig. No `as any` casts (disabled only in rare justified cases). No `// @ts-ignore`.
- **Naming**:
  - `camelCase` for variables, functions, methods
  - `PascalCase` for classes, types, interfaces
  - `UPPER_CASE` for constants
  - Types use `PascalCase` and are defined in `src/types/openai.ts`
- **Exports**: Prefer named exports over default exports.
- **Null checks**: Use `??` for nullish coalescing, `?.` for optional chaining.

```typescript
// Good
const value = config.get('KEY') ?? 'default';
const name = obj?.nested?.name ?? 'unknown';

// Good — use existing types
import type { OpenAIRequest } from '../types/openai.ts';

// Avoid
const value = config.get('KEY') || 'default'; // catches empty string too
```

### Error Handling Patterns

**Route handlers** use try/catch with structured error responses:

```typescript
try {
  const body = await c.req.json();
  // ...
  return c.json({ result }, 200);
} catch (err: any) {
  logStore.addError(logId, err.message);
  const status = err.upstreamStatus || 500;
  return c.json({ error: { message: err.message } }, status);
}
```

**Error types** follow the OpenAI error format:

```typescript
{
  error: {
    message: "Human-readable message",
    type: "invalid_request_error",  // optional
    param: "messages",              // optional
    code: "context_window_exceeded" // optional
  }
}
```

**Custom error classes** are defined for distinct failure modes:

```typescript
export class SessionPoolQueueFullError extends Error { ... }
export class SessionPoolWaitTimeoutError extends Error { ... }
export class SchemaValidationError extends Error { ... }
export class NonRetryableError extends Error { ... }
export class CircuitOpenError extends Error { ... }
```

**Service functions** throw typed errors rather than returning error objects. The route layer catches and translates them to HTTP responses.

**Always handle async errors**. Use `.catch()` on fire-and-forget promises:

```typescript
disableNativeTools().catch(err =>
  console.warn('[Startup] disableNativeTools failed:', err.message)
);
```

**Never swallow errors silently**. If an error is intentionally ignored, leave a comment explaining why:

```typescript
try { controller.close(); } catch {
  // intentional: stream close failure during abort is non-blocking, connection already lost
}
```

### Logging

Use the structured logger from `src/utils/logger.ts`:

```typescript
import { createLogger } from '../utils/logger.ts';

const log = createLogger('my-component');

log.debug('Detailed info for debugging', { extraData: 42 });
log.info('Normal operation message');
log.warn('Something unusual but recoverable');
log.error('Something failed', { error: err.message });
```

The logger writes to stdout (info/debug) or stderr (warn/error) with a consistent format:

```
[HH:MM:SS] [INFO ] [my-component] Message text
[HH:MM:SS] [ERROR] [my-component] Failure { "error": "details" }
```

**Configuration**:

- `LOG_LEVEL`: `debug` | `info` | `warn` | `error`
- `LOG_FORMAT`: set to `json` for JSON-lines output (log aggregators)
- `DEBUG=true` auto-sets log level to debug
- `DEBUG_STREAM=true` enables streaming-specific debug logging

**When to use what**:

- `debug` — development details, raw chunks, internal state
- `info` — lifecycle events, request start/completion, normal operations
- `warn` — recoverable issues, rate limits, retries, degraded states
- `error` — unrecoverable failures, caught exceptions, upstream errors

**Do NOT** use `console.log` / `console.error` directly except in the main entry point. Always use the logger.

---

## Configuration

The configuration system (`src/services/configService.ts`) resolves values in priority order:

1. **Environment variables** (highest)
2. **config.json** file (persistent runtime config)
3. **Default values** (hardcoded in `ConfigService`)

```typescript
// Reading config — env takes precedence, then config.json, then default
const port = config.get('PORT');
const apiKey = config.get('API_KEY', 'fallback');

// Writing config — writes to config.json only
config.set('LOG_LEVEL', 'debug');
config.save();
```

The `ConfigSchema` interface in `configService.ts` defines all known keys. Unknown keys in `config.json` are silently ignored.

---

## Verification Checklist

Before submitting changes, verify:

- [ ] `npm test` passes (all tests green)
- [ ] `npm run build` succeeds (no TypeScript errors)
- [ ] `npx aislop scan` passes with zero errors (if aislop is configured)
- [ ] LSP diagnostics show no errors in changed files
- [ ] New feature has test coverage
- [ ] Error paths are handled (not just the happy path)
- [ ] Logging uses the structured logger, not `console.log`
- [ ] Environment variables are documented in `.env.example` (if new ones added)
- [ ] No `as any` casts or `// @ts-ignore` comments
- [ ] No hardcoded secrets or credentials

---

For architecture overview, see [ARCHITECTURE.md](ARCHITECTURE.md).
For API reference, see [API.md](API.md).
For deployment, see [DEPLOYMENT.md](DEPLOYMENT.md).
