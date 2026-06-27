# Z.ai (GLM) Login Flow

> Last updated: 2026-06-27 (live-captured via chrome-devtools)

## Auth Mechanism

Z.ai uses **ES256 JWT tokens** (NOT opaque). The token is set as an HttpOnly `token` cookie AND sent in the `authorization: Bearer` header. The JWT payload is minimal: `{id, email}`. No expiry (`expires_at: null`).

```
Header:  {"alg":"ES256","typ":"JWT"}
Payload: {"id":"a227b44e-2f5d-462b-8cbe-5447cc8950db","email":"youssefbue@gmail.com"}
```

## Flow

1. Navigate to `https://chat.z.ai/`
2. Click **"Sign in"** in header
3. On auth page, click **"Continue with Email"**
4. **Email field**: Textbox "Enter Your Email"
5. **Password field**: Textbox "Enter Your Password"
6. **Aliyun CAPTCHA** auto-solves (puzzle image)
7. Click **"Sign in"** — completes login

> Guest mode: Click **"Skip for now"** to continue without login (limited features).

## API: Login

### `POST /api/v1/auths/signin`

**Request Body:**
```json
{
  "email": "youssefbue@gmail.com",
  "password": "mos3adadel@123",
  "captcha_verify_param": "eyJjZXJ0aWZ5SWQiOiJKNTRYYnhhazA3Iiwic2NlbmVJZCI6IjM2cWdzNnhiIiwiaXNTaWduIjp0cnVlLCJzZWN1cml0eVRva2VuIjoiNm9PbzdlNzJuQTYxdVZMaVpWS2lMWXFGMW05ck9ubzN2RUlQSkthTDdLTHhDSnFiMVVCd1JwbDRwN0VjRlRnZGpTeEE4cnVpTVU0OHp5RW4vSjJJR0MwSUhtZ3RtZ2FGVzEwK20rTnZTSmY1Nk5HWnh0WVZucEdQUVUrT1RtSXYifQ=="
}
```

**Headers:**
- `content-type: application/json`
- `x-region: overseas`

**Response (200):**
```json
{
  "id": "a227b44e-2f5d-462b-8cbe-5447cc8950db",
  "email": "youssefbue@gmail.com",
  "name": "youssef bue",
  "role": "user",
  "profile_image_url": "data:image/png;base64,...",
  "token": "eyJhbGciOiJFUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImEyMjdiNDRlLTJmNWQtNDYyYi04Y2JlLTU0NDdjYzg5NTBkYiIsImVtYWlsIjoieW91c3NlZmJ1ZUBnbWFpbC5jb20ifQ.UubXEHytKp9arvstEZt0bovgbVPu6XUBtQnc9r5nbQrcHtoL0oY8fW0haz7yJSC4wsEgsTKi4niTyTzYALUCew",
  "token_type": "Bearer",
  "expires_at": null,
  "permissions": { ... }
}
```

**Response sets cookie:**
```
set-cookie: token=<JWT>; HttpOnly; Path=/; SameSite=lax; Secure
```

## API: Chat Session Create

### `POST /api/v1/chats/new`

**Request Body:**
```json
{
  "chat": {
    "id": "",
    "title": "New Chat",
    "models": ["GLM-5.1"],
    "params": {},
    "history": {
      "messages": {
        "4f062cf3-1326-4ee9-b815-c2d31001094a": {
          "id": "4f062cf3-1326-4ee9-b815-c2d31001094a",
          "parentId": null,
          "childrenIds": [],
          "role": "user",
          "content": "What is 2+2?",
          "timestamp": 1782537182,
          "models": ["GLM-5.1"]
        }
      },
      "currentId": "4f062cf3-1326-4ee9-b815-c2d31001094a"
    },
    "tags": [],
    "flags": [],
    "features": [{"server": "tool_selector_h", "status": "hidden", "type": "tool_selector"}],
    "mcp_servers": [],
    "enable_thinking": true,
    "reasoning_effort": "max",
    "auto_web_search": false,
    "message_version": 1,
    "extra": {},
    "timestamp": 1782537182464,
    "type": "default"
  }
}
```

**Headers:**
- `authorization: Bearer <JWT>`
- `x-region: overseas`

**Response:** Returns the created chat with a new UUID `id` (e.g., `cbdbfac9-a423-46d1-97ea-29d4accd09eb`).

## API: Chat Completion (the actual LLM call)

### `POST /api/v2/chat/completions?timestamp=...&requestId=...&user_id=...&version=0.0.1&platform=web&token=<JWT>&...`

The JWT token is sent in **BOTH** the query string AND the `authorization: Bearer` header. The query string also includes extensive client fingerprinting data.

**Query String Parameters (all required):**
- `timestamp` — Unix ms timestamp
- `requestId` — UUID
- `user_id` — User UUID from JWT
- `version` — `0.0.1`
- `platform` — `web`
- `token` — Full JWT
- `user_agent` — URL-encoded browser UA
- `language` — `en-US`
- `languages` — `en-US,en`
- `timezone` — `Africa/Cairo`
- `cookie_enabled` — `true`
- `screen_width`, `screen_height`, `screen_resolution` — `2560x1440`
- `viewport_height`, `viewport_width`, `viewport_size` — `1600x1063`
- `color_depth` — `24`
- `pixel_ratio` — `1`
- `current_url`, `pathname`, `host`, `hostname`, `protocol` — page context
- `title` — page title
- `timezone_offset` — `-180`
- `local_time`, `utc_time` — ISO timestamps
- `is_mobile`, `is_touch`, `max_touch_points` — `false`, `false`, `0`
- `browser_name`, `os_name` — `Chrome`, `Linux`
- `signature_timestamp` — same as `timestamp`

**Required Headers:**
| Header | Value |
|--------|-------|
| `authorization` | `Bearer <JWT>` |
| `x-signature` | HMAC hex: `089c59485f158b277286cd04d5594b3d202d87da31c899315ebfa64471e1655e` |
| `x-fe-version` | `prod-fe-1.1.67` |
| `x-region` | `overseas` |
| `content-type` | `application/json` |
| `accept` | `*/*` |

**Request Body:**
```json
{
  "stream": true,
  "model": "GLM-5.1",
  "messages": [{"role": "user", "content": "What is 2+2?"}],
  "signature_prompt": "What is 2+2?",
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
    "{{CURRENT_DATETIME}}": "2026-06-27 08:13:03",
    "{{CURRENT_DATE}}": "2026-06-27",
    "{{CURRENT_TIME}}": "08:13:03",
    "{{CURRENT_WEEKDAY}}": "Saturday",
    "{{CURRENT_TIMEZONE}}": "Africa/Cairo",
    "{{USER_LANGUAGE}}": "en-US"
  },
  "chat_id": "cbdbfac9-a423-46d1-97ea-29d4accd09eb",
  "id": "bdab6f13-4884-45f2-b665-e240c3689b43",
  "current_user_message_id": "4f062cf3-1326-4ee9-b815-c2d31001094a",
  "current_user_message_parent_id": null,
  "background_tasks": {
    "title_generation": true,
    "tags_generation": true
  },
  "captcha_verify_param": "eyJ..."
}
```

**Response: SSE stream (`text/event-stream`)**

Custom protocol with `phase` field to distinguish content types:

1. **`phase: "thinking"`** — Reasoning tokens (streamed as model thinks)
   ```
   data: {"type":"chat:completion","data":{"delta_content":"1.  Identify the","phase":"thinking"}}
   ```

2. **`phase: "answer"`** — Final answer tokens
   ```
   data: {"type":"chat:completion","data":{"delta_content":"2 + 2 = 4","phase":"answer"}}
   ```

3. **`phase: "other"`** — Usage stats
   ```
   data: {"type":"chat:completion","data":{"phase":"other","usage":{"prompt_tokens":19,"completion_tokens":78,"total_tokens":97,"prompt_tokens_details":{}}}}
   ```

4. **`phase: "done"`** — Completion signal
   ```
   data: {"type":"chat:completion","data":{"phase":"done","done":true}}
   ```

## Captcha Flow

When "Sign in" is pressed:
1. **Device fingerprinting**: `POST cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com`
2. **Challenge request**: `POST no8xfe.captcha-open-southeast.aliyuncs.com`
3. **Puzzle assets**: `GET static-captcha-sgp.aliyuncs.com` (shadow.png, back.png)
4. **Verification upload**: `POST upload.captcha-open-southeast.aliyuncs.com`
5. On success, the `captcha_verify_param` token is generated and the sign-in request proceeds.

The captcha is required for both `/auths/signin` AND `/api/v2/chat/completions` (every chat call needs a fresh `captcha_verify_param`).

## Session Persistence

After successful sign-in, the `token` cookie (HttpOnly JWT) is set and persists in the browser profile. Cookies:
- `token` — HttpOnly JWT (the auth token)
- `acw_tc`, `cdn_sec_tc` — Aliyun WAF tokens
- `ssxmod_itna`, `ssxmod_itna2` — Fingerprint cookies
- `_ga`, `_ga_Z8QTHYBHP3` — Google Analytics
- `_c_WBKFRo` — Custom

## Production Notes

- **Token is JWT (ES256)** — opaque to us, but we can decode the payload to get `{id, email}`.
- **Token never expires** (`expires_at: null`) — only invalidated by re-login or password change.
- **`x-signature` header** — HMAC of the request. Purpose unclear, but required. May be a server-side anti-tamper check.
- **JWT in query string** — unusual but required. The token is also in the `authorization` header, so either alone should authenticate.
- **Captcha required for every chat call** — the `captcha_verify_param` in the chat completions body is validated server-side. No caching across requests.
- **Extensive client fingerprinting** — the query string includes 20+ fields about the browser/device. This is likely used for bot detection.
- **Three-phase SSE** — `thinking` → `answer` → `other` (usage) → `done`. Parsers must accumulate `delta_content` separately per phase.
- **Cookie auth is sufficient** — the `token` cookie (HttpOnly) is automatically sent with every request to `chat.z.ai`. No need to manually attach the JWT.
- **Telemetry**: Google Analytics (`G-Z8QTHYBHP3`) + Aliyun RUM (`j2c03hoppk-default-cn.rum.aliyuncs.com`).
- **Hosting**: Alibaba Cloud ESA (Edge Security Acceleration) with `eagleid` response header.
