# DeepSeek Reverse Engineering

Reverse-engineered API, security, and flow documentation for [chat.deepseek.com](https://chat.deepseek.com).

## Files

| File | Description |
|------|-------------|
| [API.md](./API.md) | Endpoint reference — auth, settings, PoW, chat completions, sessions, files. |
| [SECURITY.md](./SECURITY.md) | Auth, PoW anti-DoS, AWS infrastructure, cookies, client fingerprinting analysis. |
| [AUTH.md](./AUTH.md) | Login flow — email/password auto-fill, API, session persistence. |

## Key Takeaway

DeepSeek runs on **AWS CloudFront** with a custom **Proof of Work** anti-DoS system (`DeepSeekHashV1` in SHA3 WASM) required before every chat completion. No CAPTCHA needed — PoW replaces it. Uses opaque bearer tokens (not JWT). Telemetry via ByteDance Volces APM. Backend models include Instant, Expert, and Vision modes with DeepThink (R1 reasoning) and web search toggles.

## API Surface

```
POST /api/v0/chat/completion          # Core LLM. Needs PoW solved.
POST /api/v0/chat/create_pow_challenge # Get PoW challenge.
POST /api/v0/chat_session/create      # New session.
GET  /api/v0/chat_session/fetch_page  # List sessions.
GET  /api/v0/users/current            # User profile.
GET  /api/v0/client/settings          # Config (main, model, web_upgrade, banner).
POST /api/v0/file/upload_file         # File upload. Needs PoW.
```

## Differences from z.ai

| Aspect | z.ai | DeepSeek |
|--------|------|----------|
| Anti-abuse | Aliyun CAPTCHA puzzle | Proof of Work (SHA3 hash) |
| Auth | ES256 JWT (3 delivery channels) | Opaque Bearer token |
| Hosting | Alibaba Cloud ESA | AWS CloudFront + ELB |
| Streaming | SSE | SSE (custom protocol) |
| Model | GLM-5.2 / GLM-4.7 | DeepSeek (Instant/Expert/Vision) |
| Telemetry | Google Analytics | ByteDance Volces APM |
| Endpoint URL | `/api/v2/chat/completions` | `/api/v0/chat/completion` |
