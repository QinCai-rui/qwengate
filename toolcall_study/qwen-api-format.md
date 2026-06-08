# Qwen API v2 Request Format

Captured from Qwen Studio Electron app network traffic using agent-browser.

## Endpoint

`POST https://chat.qwen.ai/api/v2/chat/completions?chat_id={chatId}`

## Request Body

```json
{
  "stream": true,
  "version": "2.1",
  "incremental_output": true,
  "chat_id": "uuid",
  "chat_mode": "normal",
  "model": "qwen3.7-max",
  "parent_id": "uuid|null",
  "messages": [
    {
      "role": "user" | "assistant" | "function",
      "content": "string | object",
      "fid": "uuid",
      "parentId": "uuid|null",
      "childrenIds": ["uuid"],
      "user_action": "chat",
      "files": [],
      "timestamp": 1234567890,
      "models": ["qwen3.7-max"],
      "chat_type": "t2t",
      "feature_config": { ... },
      "extra": { "meta": { "subChatType": "t2t" } },
      "sub_chat_type": "t2t",
      "parent_id": "uuid|null"
    }
  ],
  "timestamp": 1234567891,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "...",
        "parameters": { ... }
      }
    }
  ],
  "tool_choice": "auto",
  "parallel_tool_calls": true
}
```

## Message Roles

### `role: "user"`
User message with tool definitions in `feature_config.local_mcp`:

```json
{
  "role": "user",
  "content": "run ls -la in /tmp using bash",
  "feature_config": {
    "thinking_enabled": true,
    "local_mcp": {
      "Qwen Core": {
        "bash": {
          "description": "Execute shell commands...",
          "parameters": {
            "type": "object",
            "properties": {
              "command": { "type": "string", "description": "..." },
              "cwd": { "type": "string", "description": "..." },
              "timeout": { "type": "number", "description": "..." }
            },
            "required": ["command"]
          }
        },
        "read_file": { ... }
      }
    }
  }
}
```

### `role: "assistant"`
Assistant response with optional tool calls in content.

Tool calls appear as XML in the SSE stream content:
```
<function=Qwen Core-bash>
<parameter=command>ls -la /tmp</parameter>
</function>
```

### `role: "function"`
Tool result message. Content is a nested object keyed by MCP server name:

```json
{
  "role": "function",
  "content": {
    "Qwen Core": [
      {
        "bash": "[{\"type\":\"text\",\"text\":\"{\\n  \\\"success\\\": true,\\n  \\\"stdout\\\": \\\"...\\\",\\n  \\\"stderr\\\": \\\"\\\",\\n  \\\"command\\\": \\\"ls -la /tmp\\\"\\n}\"}]"
      }
    ]
  },
  "fid": "uuid",
  "childrenIds": [],
  "model": "qwen3.7-max",
  "modelName": "Qwen3.7-Max",
  "modelIdx": 0,
  "userContext": null,
  "info": {
    "input_tokens": 11795,
    "output_tokens": 51,
    "total_tokens": 11846,
    "output_tokens_details": { "reasoning_tokens": 34 },
    "prompt_tokens_details": { "cached_tokens": 0 },
    "openai": true,
    "usage": { ... }
  }
}
```

## Tool Definitions

Tools are sent in TWO places:

1. **`feature_config.local_mcp`** on each user message — MCP-style nested structure
2. **`tools`** array at the payload root — OpenAI-compatible format

Both appear to be accepted. The `local_mcp` format uses MCP server name as the key:

```
"local_mcp": {
  "Qwen Core": {
    "bash": { "description": "...", "parameters": {...} },
    "read_file": { ... }
  }
}
```

## Tool Result Content Format

The tool result inner string uses Qwen's native format:

```
[{"type":"text","text":"{\"success\":true,\"stdout\":\"...\",\"stderr\":\"\",\"command\":\"...\"}"}]
```

This JSON array wraps the structured result. The inner JSON has:
- `success` (boolean)
- `stdout` (string)
- `stderr` (string)
- `command` (string — the actual command run)

## Current Gateway vs Correct Format

| Aspect | Current Gateway (wrong) | Qwen API (correct) |
|--------|------------------------|-------------------|
| Messages | 1 flat `role: 'user'` string | Multiple messages: `user`, `assistant`, `function` |
| Tool role | Not used | `role: "function"` |
| Tool result content | Embedded in user string as JSON array | `{"MCP_Server": [{"tool": "result"}]}` with JSON array inside |
| Tool definitions | In system prompt text | `feature_config.local_mcp` + `tools` array |
| `role: "function"` fields | N/A | `fid`, `model`, `modelName`, `info` |

## What Needs to Change

1. **`qwen.ts`:**
   - `createQwenStream()`: accept `messages[]` array instead of single `prompt` string
   - `QwenMessage.role`: add `'function'` to union type
   - Support multiple messages in payload

2. **`chatHelpers.ts`:**
   - `buildPromptAndSystem()`: return structured messages array instead of flat string
   - Build proper `role: "user"` messages with `feature_config.local_mcp`
   - Build proper `role: "function"` messages for tool results
   - Build proper `role: "assistant"` messages with XML tool calls

3. **`chat.ts`:**
   - Pass messages array to `createQwenStream()` instead of `finalPrompt` string
   - Remove string concatenation of system prompt + prompt

4. **`chatStreaming.ts` / `chatNonStreaming.ts`:**
   - Pass messages array through instead of `finalPrompt`
