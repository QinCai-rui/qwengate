# DeepSeek Security Analysis

> Reverse-engineered from browser DevTools. Last updated: 2026-06-25.

## Authentication

- **Bearer token**: Opaque string (not JWT). Example: `Ju+mf5Ql8umauUCRl8H1V2Hn8zuIzkuR4vBbybYhaoUwOzn0E0un7GS+Mubm3zdp`
- **Delivery**: `Authorization: Bearer <token>` header on every request.
- **User identity**: Stored in user profile response. Email is partially masked (`you*****ue@gmail.com`).
- **Session**: `ds_session_id` cookie tracks browser session.

## Proof of Work (PoW) Anti-DoS

**Every API call requires solving a hashcash-style challenge first.**

### Flow

1. **Challenge request**: `POST /api/v0/chat/create_pow_challenge` with `{"target_path":"/api/v0/chat/completion"}`
2. **Server responds** with algorithm (`DeepSeekHashV1`), challenge string, salt, signature, and difficulty target.
3. **Browser solves** by finding an integer `answer` such that a SHA3-based hash meets the difficulty target. Computation runs in WASM (`sha3_wasm_bg.wasm`).
4. **Solution submitted** as `x-ds-pow-response` HTTP header on the actual API call (base64-encoded JSON containing algorithm, challenge, salt, answer, signature, target_path).

### Parameters

| Parameter | Value | Notes |
|-----------|-------|-------|
| `algorithm` | `DeepSeekHashV1` | Custom hash algorithm using SHA3 |
| `difficulty` | 144000 | Target difficulty (adjusted dynamically) |
| `expire_after` | 300000 ms (5 min) | Challenge is valid for 5 minutes |
| WASM payload | `sha3_wasm_bg.7b9ca65ddd.wasm` | ~700KB WebAssembly binary |

### Implications

- Each chat completion requires computing a hash with ~144k operations on average.
- Prevents scripted/spam API access.
- PoW is path-scoped: separate challenge for `/api/v0/chat/completion` vs `/api/v0/file/upload_file`.
- Automating DeepSeek API requires embedding a PoW solver (SHA3 WASM or native implementation).

## Infrastructure

- **Hosting**: AWS via CloudFront CDN (`via: CloudFront`, `x-amz-cf-id`, `x-amz-cf-pop: CAI50-P2`)
- **Backend servers**: Elastic Load Balancer (`server: elb`)
- **WAF**: AWS WAF — `aws-waf-token` cookie present on all requests.
- **Edge**: CloudFront edge in Canada (`CAI50-P2` = Montreal, Canada).
- **Origin**: Unknown (behind CloudFront).

## Cookies

| Cookie | Description |
|--------|-------------|
| `ds_session_id` | Session tracking UUID |
| `aws-waf-token` | AWS WAF CAPTCHA/bot mitigation token |
| `smidV2` | Device fingerprint (potentially S sensors) |
| `.thumbcache_*` | Cache fingerprint/hash |

## Client Identification Headers

Every API request includes extensive client metadata:
- `x-client-platform: web`
- `x-client-version: 2.0.0`
- `x-app-version: 2.0.0`
- `x-client-locale: en_US`
- `x-client-bundle-id: com.deepseek.chat`
- `x-client-timezone-offset: 10800` (+3h, Africa/Cairo)
- `x-settings-token` (encrypted JWE, only for settings endpoints)

## A/B Testing

- `hif-leim.deepseek.com` — experiment assignment server.
- `x-hif-leim` header on chat completion requests carries experiment assignment.
- Experiment assignment is a token like `sO3F7zMEtsMOrrQRpmRF6sGqfSj1b+Kqg+2z233PmQoK5Cafbetmbog=.TAmFgbz0AGvlP5ak`.

## Threat Model Notes

1. **PoW is the primary anti-abuse mechanism** — no CAPTCHA visible during normal use. The PoW difficulty (144k hashes) is low enough for instant browser computation but prevents trivial script flooding.
2. **No CORS restriction observed** — response headers don't lock CORS tightly.
3. **Settings endpoints use JWE** (`x-settings-token`), suggesting encrypted configuration delivery.
4. **CloudFront + AWS WAF** provide edge-layer DDoS and bot protection via `aws-waf-token` cookie.
5. **ByteDance Volces APM** (`gator.volces.com`, `apmplus.volces.com`) tracks performance and user behavior — privacy consideration.
6. **No JWT tokens** — opaque bearer tokens simplify auth but make revocation harder (no embedded expiry).
