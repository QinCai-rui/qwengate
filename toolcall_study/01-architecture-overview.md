# Tool Calling Architecture — Current State

## How Tool Calling Works Today

```
┌──────────────────────────────────────────────────────────────────┐
│                     CLIENT (Claude Code, Cursor, etc.)           │
│  Sends: OpenAI-compatible POST /v1/chat/completions              │
│  With: messages[] + tools[] (JSON Schema definitions)            │
└──────────────────────────┬───────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     QWEN GATE (This Proxy)                       │
│                                                                  │
│  1. chatHelpers.buildPromptAndSystem()                           │
│     → Builds systemPrompt (tool instructions + anti-halluc rules)│
│     → CONCATENATES into user message: systemPrompt + "\n" + msg  │
│                                                                  │
│  2. qwen.ts → Sends to chat.qwen.ai via Playwright browser       │
│     → Single user message (system prompt embedded as user text)  │
│     → Stream SSE chunks back                                     │
│                                                                  │
│  3. StreamingToolParser.feed(chunk)                              │
│     → Buffers text, looks for {" or [{ patterns                 │
│     → Extracts JSON objects, checks looksLikeToolCall()          │
│     → Returns: { text, toolCalls, thinking }                     │
│                                                                  │
│  4. Content Filter Pipeline                                      │
│     → xmlStripper: strips <tool_result>, <invoke>, JSON artifacts│
│     → StreamingContentFilter: strips <think> tags                 │
│     → StreamingEchoFilter: detects tool result echoes            │
│                                                                  │
│  5. Response → Converted to OpenAI-compatible format             │
│     → tool_calls[] array in assistant message                    │
│     → text content in content field                              │
└──────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                     QWEN (chat.qwen.ai)                          │
│  Receives: User message with system prompt concatenated in       │
│  Generates: Text response (may contain tool call JSON in text)   │
│  Does NOT use native tool calling API                            │
└──────────────────────────────────────────────────────────────────┘
```

## Key Components

### Parser (`src/tools/parser.ts`)
- `StreamingToolParser`: Stateful parser that processes streaming chunks
- Detects JSON by looking for `{"` or `[{` patterns
- Uses `findJsonEnd()` (balanced brace matcher) to find complete JSON
- Uses `looksLikeToolCall()` to distinguish tool calls from regular JSON
- Supports both single objects and arrays of tool calls
- Has buffer compaction for long streams (MAX_BUFFER_SIZE = 64KB)

### Parser Helpers (`src/tools/parserHelpers.ts`)
- `findJsonEnd()`: Tracks brace depth + string state to find JSON boundaries
- `looksLikeToolCall()`: Checks for `"name"` field + `"arguments"/"function"/"parameters"`
- `parseToolCall()`: Normalizes various formats into `{id, name, arguments}`
- `normalizeJsonNewlines()`: Strips newlines inside JSON strings
- `tryExtractToolCall()`: Alternative extraction for non-streaming content

### Executor (`src/tools/executor.ts`)
- `runExecutionLoop()`: Main agentic loop
- Sends to LLM → Parses tool calls → Validates (guard) → Executes → Feeds results back
- Max 3 guard retries with escalating correction prompts
- Duplicate detection via toolCallWindow (last 20 calls)
- Loop detection when same tools called repeatedly

### Guard (`src/tools/guard.ts`)
- `validateToolCalls()`: Checks name + arguments exist
- `detectToolCallLoop()`: Same tool + same args repeated N times
- `detectParallelToolLoop()`: 3+ identical calls in same response
- `detectProviderToolLeak()`: Model leaking provider-specific XML formats

### Tool Runner (`src/tools/toolRunner.ts`)
- `executeToolCalls()`: Concurrent execution with configurable limits
- `parseToolCallsFromContent()`: Non-streaming extraction
- `normalizeToolCalls()`: Auto-repair broken JSON in tool calls
- `repairJson()`: Fixes trailing commas, unbalanced braces
- `buildToolMessage()`: Formats results as OpenAI tool messages

### Registry (`src/tools/registry.ts`)
- Central tool registry with register/unregister/lookup
- `toOpenAITools()`: Exports OpenAI-compatible tool definitions
- `execute()`: Validates args against schema, then runs handler
- Strict mode enforces `additionalProperties: false`

### Schema Validation (`src/tools/schema.ts`)
- Full JSON Schema validation: allOf, anyOf, oneOf, $ref, if/then/else
- Type coercion and enum validation
- Custom `SchemaValidationError` with path tracking

## Data Flow: A Single Tool Call

```
1. Client sends: { tools: [{name: "bash", params: {...}}], messages: [...] }

2. Gateway builds system prompt with tool instructions
   → Concatenates into user message text

3. Gateway sends to Qwen via Playwright
   → Qwen generates text: "Let me check that...\n{"name":"bash","arguments":{"command":"ls"}}"

4. StreamingToolParser feeds chunks:
   → "Let me check that..." → emitted as text
   → {"name":"bash","arguments":{"command":"ls"}} → detected as tool call

5. Guard validates: name="bash" ✓, arguments={command:"ls"} ✓

6. Executor runs: registry.execute("bash", {command:"ls"}, context)
   → Returns: "file1.ts\nfile2.ts\n..."

7. Result formatted as OpenAI tool message:
   → { role: "tool", tool_call_id: "call_xxx", content: "file1.ts..." }

8. Messages updated, loop continues:
   → [user_msg, assistant_msg_with_tool_calls, tool_result_msg]
   → Sent back to Qwen for next turn

9. Qwen generates final answer based on tool results
   → Content filter strips artifacts, echoes, thinking
   → Clean response sent to client
```

## Current Format Support

| Format | Detected By | Example |
|--------|-------------|---------|
| **JSON object** | `{"` pattern | `{"name":"bash","arguments":{"command":"ls"}}` |
| **JSON array** | `[{` pattern | `[{"name":"bash","arguments":{"command":"ls"}}]` |
| **Nested function** | `parseToolCall()` | `{"function":{"name":"bash","arguments":{}}}` |
| **Flat parameters** | `looksLikeToolCall()` | `{"name":"bash","command":"ls"}` (args as top-level) |
| **XML `<tool_calls>`** | ❌ NOT DETECTED | `<tool_calls><tool><tool_name>bash</tool_name>...` |
| **Hermes `