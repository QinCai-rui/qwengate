# DeepSeek API Reference

> Reverse-engineered from browser DevTools on 2026-06-25.
> Base URL: `https://chat.deepseek.com`

## Authentication

### `GET /api/v0/users/current`

Get current user profile.

**Headers:**
- `authorization: Bearer <token>` (opaque string, not JWT)
- `x-client-platform: web`
- `x-app-version: 2.0.0`
- `x-client-version: 2.0.0`
- `x-client-locale: en_US`
- `x-client-bundle-id: com.deepseek.chat`
- `x-client-timezone-offset: 10800`
- `Cookie: ds_session_id=...; aws-waf-token=...; smidV2=...`

**Response (200):**
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "id": "6ccdc439-aaed-4d78-a9fe-4bd0b0c32d16",
      "token": "Ju+mf5Ql8umauUCRl8H1V2Hn8zuIzkuR4vBbybYhaoUwOzn0E0un7GS+Mubm3zdp",
      "email": "you*****ue@gmail.com",
      "mobile_number": "",
      "area_code": "",
      "status": 0,
      "id_profile": null,
      "id_profiles": [],
      "chat": { "is_muted": 0, "mute_until": null },
      "has_legacy_chat_history": false,
      "need_birthday": false
    }
  }
}
```

**Auth token:** Opaque Bearer token (not JWT). Set in `Authorization` header for all API calls.

---

## Client Settings

### `GET /api/v0/client/settings?did=<device_id>&scope=<scope>`

Loads client configuration. `scope` values:
- `main` — core settings
- `model` — model list and capabilities
- `web_upgrade` — web upgrade prompts
- `banner` — banners/notifications

**Headers:**
- `x-settings-token: <encrypted>` (JWE encrypted settings token)
- `authorization: Bearer <token>`
- `x-client-platform: web`

**Query params:**
| Param | Description |
|-------|-------------|
| `did` | Device UUID |
| `scope` | Config scope (`main`, `model`, `web_upgrade`, `banner`) |

**Response headers:**
- `x-fetch-after-sec: 300` — cache hint (5 min)

---

## Session & Chat Management

### `POST /api/v0/chat_session/create`

Creates a new chat session.

### `GET /api/v0/chat_session/fetch_page?lte_cursor.pinned=false`

Fetch paginated chat sessions.

### `POST /api/v0/chat_session/update`

Update session metadata.

---

## Proof of Work (ANTI-DOS)

**Every chat completion requires a PoW challenge solved first.**

### `POST /api/v0/chat/create_pow_challenge`

Requests a PoW challenge for a specific API path.

**Request:**
```json
{ "target_path": "/api/v0/chat/completion" }
```

**Response (200):**
```json
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "challenge": {
        "algorithm": "DeepSeekHashV1",
        "challenge": "92b9091e647df52b7df291972d230816d51eef56baaa894948f55b1132a47284",
        "salt": "79b153922e8c2caa2b8e",
        "signature": "d9bebcd2658cb69a6c01d3937e5489f0f854f5602e946a7b1d96f0fe22227a22",
        "difficulty": 144000,
        "expire_at": 1782414648421,
        "expire_after": 300000
      },
      "target_path": "/api/v0/chat/completion"
    }
  }
}
```

**Challenge fields:**
| Field | Description |
|-------|-------------|
| `algorithm` | Always `DeepSeekHashV1` |
| `challenge` | Hex string — the challenge to solve |
| `salt` | Hex string — salt for the hash |
| `signature` | Server-signed verification |
| `difficulty` | Target difficulty (higher = harder) |
| `expire_at` | Unix ms — challenge expiry |
| `expire_after` | ms from creation — validity window |

**Solution:** Browser solves the PoW using SHA3 WASM (`sha3_wasm_bg.wasm`), finds a nonce (`answer`) such that `Hash(challenge || salt || answer)` meets the difficulty target. Result sent as `x-ds-pow-response` header.

---

## Chat Completions (CORE)

### `POST /api/v0/chat/completion`

The main LLM inference endpoint. Requires a solved PoW challenge.

**Headers:**
| Header | Value |
|--------|-------|
| `authorization` | `Bearer <token>` |
| `x-client-platform` | `web` |
| `x-app-version` | `2.0.0` |
| `x-client-version` | `2.0.0` |
| `x-client-locale` | `en_US` |
| `x-client-bundle-id` | `com.deepseek.chat` |
| `x-client-timezone-offset` | `10800` |
| `x-ds-pow-response` | Base64 JSON of PoW solution |
| `x-hif-leim` | A/B experiment assignment token |
| `referer` | Chat session URL |
| `Cookie` | `ds_session_id=...; aws-waf-token=...` |

**x-ds-pow-response (base64-decoded):**
```json
{
  "algorithm": "DeepSeekHashV1",
  "challenge": "92b9091e647df52b7df291972d230816d51eef56baaa894948f55b1132a47284",
  "salt": "79b153922e8c2caa2b8e",
  "answer": 51621,
  "signature": "d9bebcd2658cb69a6c01d3937e5489f0f854f5602e946a7b1d96f0fe22227a22",
  "target_path": "/api/v0/chat/completion"
}
```

**Request Body:**
```json
{
  "chat_session_id": "b19a23c0-6e1e-4b21-9496-04760246278a",
  "parent_message_id": null,
  "model_type": "default",
  "prompt": "Hello, what model are you running?",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": true,
  "action": null,
  "preempt": false
}
```

**Fields:**
| Field | Description |
|-------|-------------|
| `chat_session_id` | UUID of the current session |
| `parent_message_id` | `null` for new conversations |
| `model_type` | `"default"`, `"expert"`, `"vision"` (maps to Instant/Expert/Vision UI) |
| `prompt` | The user's message text |
| `ref_file_ids` | Array of uploaded file IDs |
| `thinking_enabled` | Boolean — DeepThink (R1 reasoning) toggle |
| `search_enabled` | Boolean — web search toggle |
| `action` | Custom action override (nullable) |
| `preempt` | Boolean — cancel previous response |

**Response:** SSE (Server-Sent Events) stream. `Content-Type: text/event-stream; charset=utf-8`

**SSE Event Types:**

1. **`ready`**
   ```json
   {"request_message_id":1,"response_message_id":2,"model_type":"default"}
   ```

2. **`update_session`** — session metadata updates (e.g. `updated_at`)

3. **`data` (fragment append)** — token-by-token streaming:
   - Initial fragment: `{"v":{"response":{"message_id":2,...,"fragments":[{"id":2,"type":"RESPONSE","content":"Hello",...}]}}}`
   - Token appends: `{"p":"response/fragments/-1/content","o":"APPEND","v":" I'm"}`
   - Status update: `{"p":"response/status","o":"SET","v":"FINISHED"}`

4. **`title`** — auto-generated chat title
   ```json
   {"content":"2026-06-25,Thursday,Model,Clear"}
   ```

5. **`close`** — stream complete
   ```json
   {"click_behavior":"none","auto_resume":false}
   ```

---

## File Upload

### `POST /api/v0/file/upload_file`

Upload files (images, txt, pdf, ppt, word, excel). Also requires PoW challenge for path `/api/v0/file/upload_file`.

---

## Telemetry

- `POST https://gator.volces.com/list` — ByteDance Volces analytics
- `POST https://gator.volces.com/profile/list` — user profiling
- `GET https://apmplus.volces.com/settings/get/webpro?aid=675113` — APM monitoring

---

## A/B Experiments

- `GET https://hif-leim.deepseek.com/query` — experiment assignment
- `GET https://hif-dliq.deepseek.com/query` — (DNS resolution fails, likely deprecated)

The `x-hif-leim` header carries the experiment assignment token to the API backend.
