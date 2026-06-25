# Z.ai Login Flow

> Last updated: 2026-06-25

## Important

z.ai always shows an **Aliyun CAPTCHA puzzle** before signing in. The tool auto-fills email and password, but the user must solve the CAPTCHA puzzle manually and press **"Sign in"**.

## Flow

1. Navigate to `https://chat.z.ai/`
2. Click **"Sign in"** in header (uid `15_13` / `15_7`)
3. On auth page, click **"Continue with Email"** (uid `16_6`)
4. **Email field**: `{{EMAIL}}` (uid `17_1`, textbox "Enter Your Email")
5. **Password field**: `{{PASSWORD}}` (uid `17_3`, textbox "Enter Your Password")
6. **Click "Sign in"** (uid `17_6`) — triggers Aliyun CAPTCHA puzzle overlay
7. **USER ACTION REQUIRED**: Solve the Aliyun puzzle (drag slider / click image match)
8. On CAPTCHA success, the sign-in completes automatically

> **Alternative**: Click **"Skip for now"** (uid `17_7` / `16_8`) to continue as guest.

## API

### `POST /api/v1/auths/signin`

**Headers:**
- `Authorization: Bearer <guest_jwt>`
- `Content-Type: application/json`

**Request body** (tbd — requires solving CAPTCHA to capture).

## Auth Page UI Elements

| UID (snapshot) | Element | Selector hint |
|----------------|---------|--------------|
| `16_4` | Google login | Button "Continue with Google" |
| `16_6` | Email login | Button "Continue with Email" |
| `16_7` | GitHub login | Button "Continue with Github" |
| `17_1` | Email input | Textbox "Enter Your Email" |
| `17_3` | Password input | Textbox "Enter Your Password" |
| `17_6` | Sign in button | Button "Sign in" |
| `17_7` / `16_8` | Skip to guest | Button "Skip for now" |

## CAPTCHA Flow

When "Sign in" is pressed:
1. **Device fingerprinting**: `POST cloudauth-device-dualstack.ap-southeast-1.aliyuncs.com`
2. **Challenge request**: `POST no8xfe.captcha-open-southeast.aliyuncs.com`
3. **Puzzle assets**: `GET static-captcha-sgp.aliyuncs.com` (shadow.png, back.png)
4. **Verification upload**: `POST upload.captcha-open-southeast.aliyuncs.com`
5. On success, the `captcha_verify_param` token is generated and the sign-in request proceeds.

## Session Persistence

After successful sign-in, the `token` cookie (HttpOnly JWT) is set and persists in the browser profile. The guest session cookie is replaced with the authenticated session.
