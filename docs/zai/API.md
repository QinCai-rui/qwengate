# Z.ai API Reference

> Reverse-engineered from browser DevTools on 2026-06-25.
> Base URL: `https://chat.z.ai`

## Authentication

### `GET /api/v1/auths/`

Get current auth state. Returns user profile + JWT token if authenticated.

**Headers:**
- `Authorization: Bearer <jwt>`
- `Cookie: token=<jwt>; ...`

**Response (200):**
```json
{
  "id": "8f368c1b-c645-48c7-96b0-2456acc50b79",
  "email": "guest-1782413241147@guest.com",
  "name": "Guest-1782413241147",
  "role": "guest",
  "profile_image_url": "/user.png",
  "idp": "z.ai",
  "phone_num": null,
  "token": "eyJ...JWT...",
  "token_type": "Bearer",
  "expires_at": null,
  "permissions": {
    "workspace": { "models": false, "knowledge": false, "prompts": false, "tools": false },
    "sharing": { "public_models": false, "public_knowledge": false, "public_prompts": false, "public_tools": false },
    "chat": { "temporary": true, "temporary_enforced": true },
    "features": { "direct_tool_servers": false, "web_search": true, "image_generation": true, "code_interpreter": true }
  }
}
```

### `POST /api/v1/auths/signin`

Sign in with email/credentials. Requires prior Aliyun CAPTCHA verification.

---

## Config & Models

### `GET /api/config`

Returns server configuration (API keys, feature flags, etc.)

### `GET /api/models`

Returns available models. Response:

```json
{
  "data": [
    {
      "id": "glm-5.2",
      "name": "GLM-5.2",
      "object": "model",
      "created": 1780672881,
      "owned_by": "openai",
      "info": {
        "params": { "max_tokens": 64064, "temperature": 1, "top_p": 0.95 },
        "meta": {
          "capabilities": {
            "agent_mode": true,
            "file_qa": true,
            "free_think": true,
            "think": true,
            "web_search": true,
            "returnFc": true,
            "returnThink": true,
            "reasoning_effort": true
          },
          "mcpServerIds": [
            "deep-web-search", "ppt-maker", "vibe-coding",
            "image-search", "advanced-search"
          ]
        }
      }
    }
  ]
}
```

Available models seen: `glm-5.2`, `glm-4.7` (also `glm-4.7` was used in chat completion).

---

## User Data

### `GET /api/v1/users/user/settings`

User preferences, UI settings.

### `GET /api/v1/scene-cfg/`

Scene/prompt configuration for the landing page.

---

## Chat Management

### `GET /api/v1/chats/all/tags`
### `GET /api/v1/chats/pinned`
### `GET /api/v1/folders/`
### `GET /api/v1/chats/?page=1&type=default` (paginated)
### `POST /api/v1/chats/new`

Creates a new chat session.

---

## Chat Completions (CORE)

### `POST /api/v2/chat/completions`

The main LLM inference endpoint.

**Query parameters (ALL REQUIRED):**
| Param | Description |
|-------|-------------|
| `timestamp` | Unix ms timestamp |
| `requestId` | UUID v4 |
| `user_id` | User UUID |
| `version` | `0.0.1` |
| `platform` | `web` |
| `token` | JWT (ES256-signed) |
| `user_agent` | Browser UA string |
| `language` | `en-US` |
| `languages` | `en-US,en` |
| `timezone` | `Africa/Cairo` |
| `cookie_enabled` | `true` |
| `screen_width/height` | Viewport dimensions |
| `screen_resolution` | Display resolution |
| `viewport_height/width/size` | Viewport dimensions |
| `color_depth` | `24` |
| `pixel_ratio` | `1` |
| `current_url` | Current chat URL |
| `host/hostname/protocol` | Page info |
| `referrer` | Document referrer |
| `title` | Page title |
| `timezone_offset` | `-180` (minutes) |
| `local_time` | ISO datetime |
| `utc_time` | RFC 1123 |
| `is_mobile/is_touch/max_touch_points` | Device capabilities |
| `browser_name/os_name` | Client info |
| `signature_timestamp` | Same as `timestamp` |

**Headers:**
- `Authorization: Bearer <jwt>` (same JWT as query param `token`)
- `x-fe-version: prod-fe-1.1.67`
- `x-signature: <sha256_hex>` — request signature
- `x-region: overseas`
- `Content-Type: application/json`
- `Cookie: token=<jwt>; ...`

**Request Body:**
```json
{
  "stream": true,
  "model": "glm-4.7",
  "messages": [
    { "role": "user", "content": "Hello, what model are you running?" }
  ],
  "signature_prompt": "Hello, what model are you running?",
  "params": {},
  "extra": {},
  "features": {
    "image_generation": false,
    "web_search": false,
    "auto_web_search": false,
    "preview_mode": true,
    "flags": [],
    "vlm_tools_enable": false,
    "vlm_web_search_enable": false,
    "vlm_website_mode": false,
    "enable_thinking": true
  },
  "variables": {
    "{{USER_NAME}}": "youssef bue",
    "{{USER_LOCATION}}": "Unknown",
    "{{CURRENT_DATETIME}}": "2026-06-25 22:02:44",
    "{{CURRENT_DATE}}": "2026-06-25",
    "{{CURRENT_TIME}}": "22:02:44",
    "{{CURRENT_WEEKDAY}}": "Thursday",
    "{{CURRENT_TIMEZONE}}": "Africa/Cairo",
    "{{USER_LANGUAGE}}": "en-US"
  },
  "chat_id": "42e423d8-54b9-42c0-8f41-7dde9fb56542",
  "id": "0ff3803e-c36e-4bfd-98fe-fa55e0f955b1",
  "current_user_message_id": "74b09689-059a-4708-8f0e-865bed23d5e0",
  "current_user_message_parent_id": null,
  "background_tasks": {
    "title_generation": true,
    "tags_generation": true
  },
  "captcha_verify_param": "eyJjZXJ0aWZ5SWQiOiJhWDFTTmV3VndXIiwic2NlbmVJZCI6ImRpZGszM2UwIiwiaXNTaWduIjp0cnVlLCJzZWN1cml0eVRva2VuIjoiNm9PbzdlNzJuQTYxdVZMaVpWS2lMWXFGMW05ck9ubzN2RUlQSkthTDdLTHhDSnFiMVVCd1JwbDRwN0VjRlRnZHpxSnYrclI2K3dtam9jendyMUg5TXRqUGNxYWZscWJRTFpRZFgycllkLzhiaG5xaElwQzdTblJsSXhHUHNxdlgifQ=="
}
```

**Response:** SSE (Server-Sent Events) stream. `Content-Type: text/event-stream; charset=utf-8`

**Response Headers:**
- `access-control-allow-credentials: true`
- `access-control-allow-origin: https://chat.z.ai`
- `access-control-expose-headers: X-Chat-Id, X-Trace-ID`
- `x-chat-id: <chat_uuid>`
- `x-trace-id: <trace_hex>`

---

## Security Flow

1. **Guest auth**: New visitors automatically get a guest account via `GET /api/v1/auths/` with a guest JWT. Auth cookie `token` is set HttpOnly.
2. **CAPTCHA**: Before the first chat completion or sign-in, an **Aliyun CAPTCHA** (puzzle slider) is triggered. This involves:
   - Device fingerprinting via `cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com`
   - CAPTCHA challenge via `no8xfe.captcha-open-southeast.aliyuncs.com`
   - Image assets loaded from `static-captcha-sgp.aliyuncs.com`
3. **Chat completion**: After CAPTCHA verification, the chat completion request includes a `captcha_verify_param` field containing the CAPTCHA verification token.
4. **JWT**: ES256-signed JWT containing `{id, email}`. Sent in both `Authorization: Bearer` header and as query param `token`, and also as HttpOnly cookie named `token`.
5. **Request signing**: An `x-signature` SHA-256 hex header is included in the chat completion request.
6. **ssxmod_itna cookies**: These look like encrypted/obfuscated session cookies, possibly for WAF (Web Application Firewall) bypass or session tracking.

See [SECURITY.md](./SECURITY.md) for full details on the security mechanisms.
