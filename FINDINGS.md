# Full Project Audit — Findings & Fix Plan

Generated: 2026-06-08
Audit teams: full-project-audit (7 members), deep-clean-sweep (8 members)

---

> **Status**: 88/100 aislop score · 0 tsc errors · All critical/high items from round 1 fixed
> **Remaining**: Performance micro-optimizations, dead code cleanup, security hardening

---

## ✅ Fixed in Round 1

| # | Finding | Status |
|---|---------|--------|
| H1 | Triple `filterContent()` calls per chunk | ✅ Fixed |
| H2 | Dual `getQwenHeaders()` call per request | ✅ Fixed |
| H3 | Token refresh errors silently swallowed | ✅ Fixed |
| H4 | Wire rate limiting into routes | ✅ Fixed |
| H5 | Remove unused `dotenv` dep | ✅ Fixed |
| M1 | `streamFilter.feed()` output discarded | ✅ Fixed (call removed) |
| M3 | `deleteSession` can throw unhandled | ✅ Fixed |
| M5 | Remove `logDebug()`/`streamDebugLog()` no-op calls | ✅ Fixed |
| M6 | Replace `uuid` with `crypto.randomUUID()` | ✅ Fixed (7 files, 304KB saved) |
| C1 | Circuit breaker getter mutation | ✅ Fixed |
| L2 | `typedCast` duplication | ✅ Fixed |
| L3 | `streamChunks` 4× duplication | ✅ Fixed |
| L4 | Barrel re-export files | ✅ Fixed (`utils/types.ts`, `tools/types.ts`) |
| — | Console.log in startup banner (intentional) | ✅ Kept |
| — | `as unknown as` double assertions in systemLogger.ts | ✅ Fixed |

---

## Remaining Issues

### 🔴 Performance (hot path)

#### P1. Inline regex compiled per chunk
- **File**: `src/routes/chatStreamingHelpers.ts:212`
- **Issue**: `/^[\n\s]*<\/?(?:think|thinking|thought|tool_call|tool_use|function_call)[\s>]*[\n\s]*$/` is a regex literal inside the per-chunk `processStreamData` function. Compiled every chunk.
- **Fix**: Move to module-level `const` declaration.

#### P2. cleanThinkTags() regex compiled per call
- **File**: `src/routes/chatHelpersCore.ts:102-106`
- **Issue**: Two regex literals inside `cleanThinkTags()` compiled every call. Called per chunk in `processStreamData`.
- **Fix**: Move to module-level `const` declarations.

#### P3. Dual text tracking in processStreamData
- **File**: `src/routes/chatStreamingHelpers.ts:219-253`
- **Issue**: Two parallel `detectCumulativeChunk()` tracking systems: `lastVStrRaw`/`vStr` and `lastRawContent`/`lastFullContent`. Both do overlapping work — detect cumulative behavior, accumulate text.
- **Fix**: Consolidate into single tracking system. The `lastRawContent`/`lastFullContent` tracking subsumes `lastVStrRaw` since `rawText` is already the delta from the first detection.

#### P4. Duplicated assignment in if/else branches
- **File**: `src/routes/streamLoop.ts:146,148`
- **Issue**: `streamState.lastFilteredSnapshot = flushCleaned;` appears in both the `if` and `else` branches of the amplification guard check.
- **Fix**: Lift before the if/else.

---

### 🟠 Dead Code

#### D1. contextSanitizer.ts — completely unused file
- **File**: `src/utils/contextSanitizer.ts`
- **Issue**: Entire file is never imported anywhere. Contains `stripThinkingBlocks()`, `isAutomatedError()`, `isContainerConfusion()`, `isRetryReminder()`, `isToolResultLike()`, `extractMessageText()`, `messageSimilarity()`, `sanitizeConversation()`. Zero call sites.
- **Fix**: Delete the file.

#### D2. tools/parser.ts (StreamingToolParser) — test-only
- **File**: `src/tools/parser.ts`
- **Issue**: `StreamingToolParser`, `ParserResult`, `StreamingToolCall`, `StreamingTextDelta`, etc. Only used in test files (`parser.test.ts`), never in production code. Streaming tool calls now use SSE extraction (`extractLocalMcpToolCalls`).
- **Fix**: Remove from production bundle or conditionally exclude.

#### D3. tools/executor.ts — completely unused
- **File**: `src/tools/executor.ts`
- **Issue**: `runExecutionLoop()`, `ExecutionLoopConfig`, `LLMSendFunction`, `LLMResponse`, `LoopTurnResult`, `SanitizeConfig` — zero imports from any production code or test code.
- **Fix**: Delete the file.

#### D4. Dead code paths in chatStreamingHelpers.ts
- **File**: `src/routes/chatStreamingHelpers.ts:236-237`
- **Issue**: `const toolCalls: ParsedToolCall[] = [];` and `const parserThinking = '';` are always empty. Lines 266-268 (`if (parserThinking)`) and 281-289 (`if (toolCalls.length > 0)`) are unreachable dead code.
- **Fix**: Remove the dead branches.

#### D5. StreamingContentFilter dead object
- **File**: `src/routes/chatStreaming.ts:74`, `src/routes/chatStreamingHelpers.ts:161`, `src/routes/streamLoop.ts:115`
- **Issue**: `StreamingContentFilter` instantiated every streaming request but `feed()` never called. Passed through ctx and args only to be destructured as `_streamFilter` (unused).
- **Fix**: Remove from stream context, remove instantiation, remove import in streamLoop.ts.

#### D6. validateQwenUrl duplicated
- **Files**: `src/services/playwright.ts:30-49` and `src/services/browserProfiles.ts:27-46`
- **Issue**: Identical `validateQwenUrl()` function in two files.
- **Fix**: Extract to shared utils module.

#### D7. Unused type exports
- **File**: `src/types/openai.ts`
- **Issue**: `ToolChoice`, `ToolCallFunction`, `MessageToolCall`, `ToolCallDelta`, `ChoiceDelta`, `Choice`, `ChatCompletionChunk`, `ToolPolicy` — defined but never imported elsewhere.
- **Fix**: Remove unused type exports.

---

### 🔴 Security Hardening

#### S1. Unauthenticated endpoints
- **Files**: `src/routes/dashboard/dashboardRoutes.ts`
- **Endpoints**: `/accounts`, `/pool/stats`, `/log/json`, `/log/stream`, `/debug/network`, `/metrics/uptime`, `/health`
- **Issue**: These expose email addresses, session pool details, full request logs (including prompts), network debug data without any auth.
- **Fix**: Add `checkApiKeyAuth` middleware to sensitive endpoints.

#### S2. CORS wide open
- **File**: `src/index.tsx:80`
- **Issue**: `app.use("*", cors())` with no origin restriction — any website can make requests.
- **Fix**: Restrict to `http://localhost:${PORT}` or configure.

#### S3. Non-constant-time auth comparison
- **File**: `src/routes/dashboard/dashboardRoutes.ts:257,268`
- **Issue**: `authHeader.slice(7) !== apiKey` uses `!==` string comparison, vulnerable to timing attacks.
- **Fix**: Use `safeCompare` from `src/utils/auth.ts`.

---

## Priority Fix Queue

| Priority | ID | Description | Effort | Impact |
|----------|----|-------------|--------|--------|
| 1 | D1 | Delete unused contextSanitizer.ts | 2 min | Cleanup |
| 2 | D3 | Delete unused executor.ts | 2 min | Cleanup |
| 3 | D4 | Remove dead code paths in chatStreamingHelpers.ts | 3 min | Cleanup |
| 4 | D5 | Remove dead StreamingContentFilter from pipeline ctx | 5 min | Cleanup |
| 5 | P1 | Extract inline regex to module-level const | 2 min | Perf |
| 6 | P2 | Extract cleanThinkTags regex to module-level const | 2 min | Perf |
| 7 | P4 | Deduplicate flushCleaned assignment in streamLoop.ts | 1 min | Cleanup |
| 8 | D6 | Deduplicate validateQwenUrl | 5 min | Cleanup |
| 9 | D7 | Remove unused type exports | 5 min | Cleanup |
| 10 | S1 | Add auth to unprotected endpoints | 15 min | Security |
| 11 | S2 | Restrict CORS origin | 5 min | Security |
| 12 | S3 | Use safeCompare in dashboardRoutes | 3 min | Security |
| 13 | P3 | Consolidate dual text tracking in processStreamData | 10 min | Perf |
