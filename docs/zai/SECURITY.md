# Z.ai Security Analysis

> Reverse-engineered from browser DevTools. Last updated: 2026-06-25.

## Authentication

- **Guest auto-provisioning**: Visiting `chat.z.ai` triggers `GET /api/v1/auths/` which auto-creates a guest account with role `"guest"`. No email/password needed.
- **JWT Format**: ES256 (ECDSA P-256) signed token. Payload:
  ```json
  { "id": "<uuid>", "email": "guest-<timestamp>@guest.com" }
  ```
- **JWT Delivery**: Three channels simultaneously:
  - `Authorization: Bearer <jwt>` header
  - `?token=<jwt>` query parameter (in chat completions)
  - `Set-Cookie: token=<jwt>; HttpOnly; Path=/; SameSite=lax; Secure` (in auth response)
- **Expiration**: `expires_at: null` for guest tokens — effectively permanent per session.

## CAPTCHA

- **Provider**: Aliyun CAPTCHA (data-safe, puzzle slider type).
- **Domains**:
  - `cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com` — device fingerprinting
  - `no8xfe.captcha-open-southeast.aliyuncs.com` — CAPTCHA challenge API
  - `static-captcha-sgp.aliyuncs.com` — CAPTCHA assets
- **Storage**: `localStorage` key `captcha_verified: true` after solving.
- **Scope**: Required before:
  1. First chat completion
  2. Email sign-in attempt
- **Verification Token**: Passed in chat completion body as `captcha_verify_param` (base64-encoded JSON with `certifyId`, `sceneId`, `isSign`, `securityToken`).
- **Bypass**: Setting `localStorage.setItem('captcha_verified', 'true')` may skip the CAPTCHA dialog within the same domain session.

## Request Signing

- `x-signature` header: SHA-256 hex digest of request content.
- This means the client (browser) computes a hash of the JSON body and sends it separately.
- **Replay prevention**: The `timestamp` and `requestId` query parameters likely serve as nonce/anti-replay.

## Browser Fingerprinting

The chat completions endpoint receives extensive client fingerprint data as query params:

| Field | Purpose |
|-------|---------|
| `user_agent` | Browser UA |
| `language`, `languages` | Language settings |
| `timezone`, `timezone_offset` | Timezone detection |
| `screen_width/height/resolution` | Screen fingerprint |
| `viewport_height/width/size` | Window dimensions |
| `color_depth` | Display properties |
| `pixel_ratio` | Device pixel ratio |
| `is_mobile/is_touch/max_touch_points` | Touch capabilities |
| `browser_name/os_name` | Client identification |
| `cookie_enabled` | Cookie availability |
| `referrer` | Traffic source |
| `current_url`, `pathname`, `search`, `hash`, `host`, `hostname`, `protocol` | Page context |

## Session Cookies

- `ssxmod_itna` and `ssxmod_itna2`: Very long (>1000 chars each) obfuscated/encrypted cookies. Likely related to ESA WAF (ESA = Edge Security Acceleration, Alibaba Cloud's WAF/CDN product).
- `cdn_sec_tc`, `acw_tc`: Alibaba Cloud CDN/WAF tracking cookies.
- `_gcl_au`, `_ga`, `_ga_Z8QTHYBHP3`: Google Analytics tracking.
- `_c_WBKFRo`, `_nb_ioWEgULi`: Custom app cookies.

## Infrastructure

- **CDN/WAF**: Alibaba Cloud ESA (Edge Security Acceleration) — visible in `server: ESA` and `via: ens-cache*` headers.
- **CORS**: Tightly locked — `Access-Control-Allow-Origin: https://chat.z.ai` with `Access-Control-Allow-Credentials: true`.
- **Response caching**: Dynamic site cache (`x-site-cache-status: DYNAMIC`).
- **Subdomains** (from earlier analysis):
  - `chat.z.ai` — main chat application
  - `z.ai` — landing/auth
  - `ocr.z.ai` — OCR API
  - `image.z.ai` — Image API
  - `audio.z.ai` — Audio API
  - `autoclaw.z.ai` — Unknown (likely a service)

## Threat Model Notes

1. **JWT in query params**: JWT tokens are sent in URL query parameters (`?token=<jwt>`). URLs are logged by proxies, CDNs, and may appear in `Referer` headers. This is a security concern.
2. **Guest auth is stateless**: The guest accounts persist only as long as the session cookies. No explicit logout/revocation.
3. **CAPTCHA is client-side only**: Setting `localStorage.captcha_verified = true` may bypass the UI dialog. The server still validates the `captcha_verify_param` field though.
4. **ESA WAF**: The `ssxmod_itna` cookies suggest anti-bot protection. Automating requests may require cookie handling.
