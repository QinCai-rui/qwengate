# Qwen Gate API Reference

Complete API documentation for Qwen Gate's OpenAI-compatible endpoints.

## Table of Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Rate Limits](#rate-limits)
- [Endpoints](#endpoints)
  - [Chat Completions](#post-v1chatcompletions)
  - [Models](#get-v1models)
- [Error Handling](#error-handling)
- [SDKs and Clients](#sdks-and-clients)

## Base URL

```
http://localhost:26405/v1
```

In production, replace `localhost:26405` with your server address.

## Authentication

All API requests require an API key (if configured):

```bash
Authorization: Bearer YOUR_API_KEY
```

Set your API key in `.env` or `config.json`:

```bash
API_KEY=your_secret_key_here
```

Leave `API_KEY` empty to disable authentication.

## Rate Limits

Qwen Gate implements rate limiting to protect Qwen accounts:

- **Default cooldown**: 2 minutes per account after rate limit
- **Configurable**: Set `RATE_LIMIT_COOLDOWN_MS` in config
- **Automatic retry**: Failed requests are retried with exponential backoff

## Endpoints

### POST /v1/chat/completions

Create a chat completion. Supports both streaming and non-streaming responses.

#### Request Headers

```http
Content-Type: application/json
Authorization: Bearer YOUR_API_KEY
```

#### Request Body

| Parameter     | Type          | Required | Default | Description                   |
| ------------- | ------------- | -------- | ------- | ----------------------------- |
| `model`       | string        | Yes      | -       | Model name (e.g., `qwen-max`) |
| `messages`    | array         | Yes      | -       | Array of message objects      |
| `stream`      | boolean       | No       | `true`  | Enable streaming response     |
| `temperature` | number        | No       | `0.7`   | Sampling temperature (0-2)    |
| `max_tokens`  | number        | No       | `1000`  | Maximum tokens to generate    |
| `top_p`       | number        | No       | `0.9`   | Nucleus sampling parameter    |
| `tools`       | array         | No       | -       | Array of tool definitions     |
| `tool_choice` | string/object | No       | `auto`  | Tool selection strategy       |

#### Message Object

```json
{
  "role": "user|assistant|system|tool",
  "content": "string",
  "name": "string (optional)",
  "tool_calls": [],
  "tool_call_id": "string (for tool messages)"
}
```

#### Basic Example

**Request:**

```bash
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello!"}
    ],
    "stream": true
  }'
```

**Response (streaming):**

```
data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","choices":[{"index":0,"delta":{"content":"! How can I help you today?"},"finish_reason":null}]}

data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"qwen-max","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

**Response (non-streaming):**

```json
{
  "id": "chatcmpl-123",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "qwen-max",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  }
}
```

#### Tool Calling Example

**Request:**

```json
{
  "model": "qwen-max",
  "messages": [{ "role": "user", "content": "What's the weather in Tokyo?" }],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "parameters": {
          "type": "object",
          "properties": {
            "location": {
              "type": "string",
              "description": "City name"
            }
          },
          "required": ["location"]
        }
      }
    }
  ],
  "tool_choice": "auto"
}
```

**Response:**

```json
{
  "id": "chatcmpl-456",
  "object": "chat.completion",
  "created": 1234567890,
  "model": "qwen-max",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "get_weather",
              "arguments": "{\"location\": \"Tokyo\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

**Follow-up with tool result:**

```json
{
  "model": "qwen-max",
  "messages": [
    { "role": "user", "content": "What's the weather in Tokyo?" },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        {
          "id": "call_abc123",
          "type": "function",
          "function": {
            "name": "get_weather",
            "arguments": "{\"location\": \"Tokyo\"}"
          }
        }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "call_abc123",
      "content": "{\"temperature\": 22, \"condition\": \"sunny\"}"
    }
  ]
}
```

#### Tool Definition

```json
{
  "type": "function",
  "function": {
    "name": "function_name",
    "description": "Description of what the function does",
    "parameters": {
      "type": "object",
      "properties": {
        "param1": {
          "type": "string",
          "description": "Parameter description"
        },
        "param2": {
          "type": "number",
          "description": "Another parameter"
        }
      },
      "required": ["param1"]
    }
  }
}
```

### GET /v1/models

List available models.

#### Request

```bash
curl http://localhost:26405/v1/models \
  -H "Authorization: Bearer YOUR_API_KEY"
```

#### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "qwen-max",
      "object": "model",
      "created": 1234567890,
      "owned_by": "qwen",
      "permission": []
    },
    {
      "id": "qwen-plus",
      "object": "model",
      "created": 1234567890,
      "owned_by": "qwen",
      "permission": []
    }
  ]
}
```

## Error Handling

### Error Response Format

```json
{
  "error": {
    "message": "Error description",
    "type": "error_type",
    "code": "error_code"
  }
}
```

### Common Errors

#### 400 Bad Request

```json
{
  "error": {
    "message": "Invalid request format",
    "type": "invalid_request_error",
    "code": "invalid_request"
  }
}
```

**Causes:**

- Missing required fields
- Invalid message format
- Malformed JSON

#### 401 Unauthorized

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

**Causes:**

- Missing API key
- Invalid API key

#### 429 Too Many Requests

```json
{
  "error": {
    "message": "Rate limit exceeded",
    "type": "rate_limit_error",
    "code": "rate_limit"
  }
}
```

**Causes:**

- Too many requests in short time
- Account cooldown active

**Solution:**

- Wait for cooldown period
- Implement exponential backoff

#### 500 Internal Server Error

```json
{
  "error": {
    "message": "Internal server error",
    "type": "server_error",
    "code": "internal_error"
  }
}
```

**Causes:**

- Browser automation failure
- Qwen API error
- Session pool exhausted

## SDKs and Clients

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="http://localhost:26405/v1"
)

response = client.chat.completions.create(
    model="qwen-max",
    messages=[
        {"role": "user", "content": "Hello!"}
    ],
    stream=True
)

for chunk in response:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### JavaScript/Node.js (OpenAI SDK)

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: "YOUR_API_KEY",
  baseURL: "http://localhost:26405/v1",
});

const stream = await client.chat.completions.create({
  model: "qwen-max",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

### TypeScript

```typescript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.QWEN_GATE_API_KEY,
  baseURL: "http://localhost:26405/v1",
});

async function chat(prompt: string): Promise<string> {
  const response = await client.chat.completions.create({
    model: "qwen-max",
    messages: [{ role: "user", content: prompt }],
  });

  return response.choices[0].message.content || "";
}
```

### curl

```bash
# Streaming
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# Non-streaming
curl http://localhost:26405/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "model": "qwen-max",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

## Advanced Features

### Echo Detection

Qwen Gate automatically detects and prevents AI models from echoing tool results verbatim. This is handled transparently and requires no special configuration.

### RTK Compression

Tool results are automatically compressed using RTK-style compression to reduce token usage by 20-40%. This is transparent to the API consumer.

### Session Pooling

Sessions are automatically managed and pooled for optimal performance. No configuration required.

## Support

For questions or issues:

- **Documentation**: [README.md](../README.md)
- **Issues**: [GitHub Issues](https://github.com/yourusername/qwen-gate/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/qwen-gate/discussions)
