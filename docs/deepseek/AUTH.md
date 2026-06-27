# DeepSeek Login Flow

## Auto-Login Setup

The tool auto-fills email + password on the sign-in page. No CAPTCHA or bot detection.

## Flow

1. Navigate to `https://chat.deepseek.com/sign_in`
2. **Email field**: Textbox "Phone number / email address"
3. **Password field**: Textbox "Password"
4. Press **"Log in"** button

## Auth Mechanism

DeepSeek uses **opaque Bearer tokens** (NOT JWT). Auth is sent via `authorization: Bearer <token>` header, NOT cookies. The cookies (`smidV2`, `ds_session_id`, `aws-waf-token`) are device fingerprinting + WAF — not auth.

The token comes from `POST /api/v0/users/login` response → `data.biz_data.user.token`. It is also stored in `localStorage` as `userToken` (value field).

## API: Login

### `POST /api/v0/users/login`

**Request Body:**
```json
{
  "email": "youssefbue@gmail.com",
  "mobile": "",
  "password": "mos3adadel@123",
  "area_code": "",
  "device_id": "BqAy2HfbJ04CohsebfV3/V1EK4vasu2i6pcXrxkw7i9OrEd1/zbNkhBz8SUxhXp/+Q9tQvVt4KnaMoj1JJGcEzQ==",
  "os": "web"
}
```

`device_id` = base64 of `.thumbcache_*` cookie value (a cache fingerprint generated on first visit).

**Response (200):**
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "code": 0,
      "msg": "",
      "user": {
        "id": "6ccdc439-aaed-4d78-a9fe-4bd0b0c32d16",
        "token": "dk4E6t9IKWKcB1+cOgeRIi8P6TcC4EBup21cqUbD1tu7v0KwAKakM7V8kmwI0vCs",
        "email": "you*****ue@gmail.com",
        ...
      }
    }
  }
}
```

**The token is at `data.biz_data.user.token` (opaque string, ~50 chars).**

## API: User Profile

### `GET /api/v0/users/current`

Returns the current user. Response includes a **different** `token` than the login — this is the token to use for API calls. The `/users/current` response token is used in the `authorization: Bearer` header for all subsequent API calls (PoW, chat, etc.).

**Response:**
```json
{
  "data": {
    "biz_data": {
      "id": "6ccdc439-aaed-4d78-a9fe-4bd0b0c32d16",
      "token": "sIZSlxOJGGv1VlTs7YpfZlz/3V4AhPfzFSsQaFPItR12caixYAbMQ2KQ0CHo9aCA",
      "email": "you*****ue@gmail.com",
      ...
    }
  }
}
```

## API: PoW Challenge (required before every chat completion)

### `POST /api/v0/chat/create_pow_challenge`

**Request Body:**
```json
{"target_path": "/api/v0/chat/completion"}
```

**Headers (required):**
- `authorization: Bearer <token>` (the token from `/users/current`)
- `x-client-platform: web`
- `x-app-version: 2.0.0`
- `x-client-version: 2.0.0`
- `x-client-locale: en_US`
- `x-client-bundle-id: com.deepseek.chat`
- `x-client-timezone-offset: 10800`
- `cookie: smidV2=...; ds_session_id=...; .thumbcache_*=...; aws-waf-token=...`

**Response (200):**
```json
{
  "data": {
    "biz_data": {
      "challenge": {
        "algorithm": "DeepSeekHashV1",
        "challenge": "1d94201403117cf7c7161f486bf43315944f299d9bd7aa6c9ebc230cdc4ce969",
        "salt": "bfc9cd02e6b4a6d98537",
        "signature": "5bb5cd2445fa9a06cbd74c27df25260bdc676caabfa876cc8ede93ed5118aecf",
        "difficulty": 144000,
        "expire_at": 1782537291376,
        "expire_after": 300000,
        "target_path": "/api/v0/chat/completion"
      }
    }
  }
}
```

The PoW must be solved using `DeepSeekHashV1` (SHA3-based, WASM at `fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`). Difficulty 144000 means finding a hash with 144000 leading zero bits — computationally expensive.

The solution is submitted as a **base64-encoded JSON** in the `x-ds-pow-response` header on the chat completion request.

## API: Chat Session Create

### `POST /api/v0/chat_session/create`

**Request Body:** `{}`

**Response (200):**
```json
{
  "data": {
    "biz_data": {
      "chat_session": {
        "id": "57f2c1e7-f18d-49de-b32d-7de5d01f1afc",
        "seq_id": 204700191,
        "agent": "chat",
        "model_type": "default",
        ...
      },
      "ttl_seconds": 259200
    }
  }
}
```

Session ID is a UUID v4. TTL is 3 days (259200s).

## API: Chat Completion (the actual LLM call)

### `POST /api/v0/chat/completion`

**Request Body:**
```json
{
  "chat_session_id": "9f51005e-a87b-43ad-8a4f-099fbb58d6b0",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "What is 2+2?",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": true,
  "action": null,
  "preempt": false
}
```

**Required Headers:**
| Header | Value |
|--------|-------|
| `authorization` | `Bearer <token from /users/current>` |
| `x-ds-pow-response` | Base64-encoded JSON: `{algorithm, challenge, salt, answer, signature, target_path}` |
| `x-hif-leim` | Cache key from `localStorage.hif_leim_cached` |
| `x-client-platform` | `web` |
| `x-app-version` | `2.0.0` |
| `x-client-version` | `2.0.0` |
| `content-type` | `application/json` |
| `accept` | `text/event-stream` |

**Response: SSE stream (text/event-stream)**

Custom protocol with three message types:

1. **`event: ready`** — session ready
   ```
   data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
   ```

2. **`event: update_session`** — session timestamp update

3. **`data: {"v":...}`** — initial response object with `response.fragments[0].content` (first chunk)

4. **`data: {"p":"path","o":"OP","v":"value"}`** — incremental patches:
   - `{"p":"response/fragments/-1/content","o":"APPEND","v":" +"}` — append to fragment
   - `{"v":" 2"}` — shorthand for APPEND to last fragment
   - `{"p":"response","o":"BATCH","v":[{...},{...}]}` — batch update

5. **`data: {"p":"response/status","o":"SET","v":"FINISHED"}`** — completion signal

6. **`event: title`** — auto-generated title for the chat
   ```
   data: {"content":"2+2"}
   ```

7. **`event: close`** — stream end
   ```
   data: {"click_behavior":"none","auto_resume":false}
   ```

**Response example (full SSE for "What is 2+2?"):**
```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}

event: update_session
data: {"updated_at":1782536992.117987}

data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":false,"ban_edit":false,"ban_regenerate":false,"status":"WIP","incomplete_message":null,"accumulated_token_usage":0,"feedback":null,"inserted_at":1782536992.1072628,"search_enabled":true,"fragments":[{"id":2,"type":"RESPONSE","content":"2","references":[],"stage_id":1}],"conversation_mode":"DEFAULT","has_pending_fragment":false,"auto_continue":false,"search_triggered":false}}}

data: {"p":"response/fragments/-1/content","o":"APPEND","v":" +"}

data: {"v":" "}

data: {"v":"2"}

data: {"v":" ="}

data: {"v":" "}

data: {"v":"4"}

data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":45},{"p":"quasi_status","v":"FINISHED"}]}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

event: update_session
data: {"updated_at":1782536992.4661648}

event: title
data: {"content":"2+2"}

event: close
data: {"click_behavior":"none","auto_resume":false}
```

## Session Persistence

After login, the following cookies are set in the browser profile:
- `smidV2` — device fingerprint (persistent, set BEFORE login)
- `ds_session_id` — session UUID (httpOnly, server-set)
- `aws-waf-token` — AWS WAF challenge token
- `.thumbcache_*` — cache fingerprint (base64 of `device_id`)

And in `localStorage`:
- `userToken` — the Bearer token (opaque string)
- `hif_leim_cached` — the `x-hif-leim` cache key
- `__tea_cache_tokens_*` — telemetry user ID
- `__appKit_*` — UI state and feature flags

These persist across browser sessions in the profile. No re-login needed until they expire.

## UI Elements

| Element | Selector hint |
|---------|--------------|
| Email input | Textbox "Phone number / email address" |
| Password input | Textbox "Password" |
| Log in button | Button "Log in" |
| Message input | Textbox "Message DeepSeek" |

## Production Notes

- **Token refresh**: The token from `/users/current` may differ from the login token. Always fetch a fresh token from `/users/current` before each chat completion to ensure validity.
- **PoW is required for every chat completion** — no caching across requests. Each call needs a fresh challenge + solution.
- **PoW difficulty is 144000** — requires WASM SHA3 solver (not simple SHA256). Use the WASM at `https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm`.
- **`x-hif-leim` header** — cache key from localStorage. Required for chat completion but purpose unclear (possibly human-input-feedback loop). Missing it may cause the request to be rejected.
- **No refresh token visible** — token just expires. No mechanism to refresh without re-login.
- **SSE protocol is custom** — not standard OpenAI SSE. Needs custom parser to extract content from `{"p":"...","o":"APPEND","v":"..."}` patches.
