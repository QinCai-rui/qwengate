# z.ai Reverse Engineering

Reverse-engineered API, security, and flow documentation for [chat.z.ai](https://chat.z.ai).

## Files

| File | Description |
|------|-------------|
| [API.md](./API.md) | Endpoint reference — auth, models, chat, completions. |
| [SECURITY.md](./SECURITY.md) | Auth, CAPTCHA, JWT, fingerprinting, WAF analysis. |
| [AUTH.md](./AUTH.md) | Login flow — email/password auto-fill, CAPTCHA instructions. |
| [chat-completions-request-body.json](./chat-completions-request-body.json) | Captured chat completion request body. |
| [chat-completions-response-body.json](./chat-completions-response-body.json) | Captured chat completion SSE response. |
| [auth-response.json](./auth-response.json) | Captured auth endpoint response. |
| [models-response.json](./models-response.json) | Captured models list response. |
| [zai-login-form.png](./zai-login-form.png) | Screenshot of auto-filled login form. |

## Key Takeaway

z.ai is an Alibaba Cloud-hosted LLM chat app running on Zhipu GLM-5.2.
Multiple security layers: JWT auth, CAPTCHA, request signing, WAF cookies, browser fingerprinting.
API follows OpenAI-like schema (`/api/v2/chat/completions`) with z.ai-specific additions (CAPTCHA, fingerprint params, feature flags, prompt variables).
