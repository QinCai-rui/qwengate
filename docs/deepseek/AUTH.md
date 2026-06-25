# DeepSeek Login Flow

## Auto-Login Setup

The tool auto-fills email + password on the sign-in page. No CAPTCHA or bot detection.

## Flow

1. Navigate to `https://chat.deepseek.com/` → auto-redirects to `/sign_in`
2. **Email field**: `{{EMAIL}}`
3. **Password field**: `{{PASSWORD}}`
4. Press **"Log in"** button

## API

### `POST /api/v0/users/login`

**Request:**
```json
{
  "email": "{{EMAIL}}",
  "mobile": "",
  "password": "{{PASSWORD}}",
  "area_code": "",
  "device_id": "BHgTjSu7uQabgKUkgojCBBLpcmP0FvPnI0628vNRbb7vaV7hcAlJLv9laS65AV/SCi5zIKMdVI/fubVKJTFYFmA==",
  "os": "web"
}
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
      "user": {
        "id": "6ccdc439-aaed-4d78-a9fe-4bd0b0c32d16",
        "token": "sIZSlxOJGGv1VlTs7YpfZlz/3V4AhPfzFSsQaFPItR12caixYAbMQ2KQ0CHo9aCA",
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
}
```

## Headers (login request)

| Header | Value |
|--------|-------|
| `authorization` | `Bearer <token>` |
| `x-client-platform` | `web` |
| `x-app-version` | `2.0.0` |
| `x-client-version` | `2.0.0` |
| `x-client-locale` | `en_US` |
| `x-client-bundle-id` | `com.deepseek.chat` |
| `x-client-timezone-offset` | `10800` |

## UI Elements

| UID (snapshot) | Element | Selector hint |
|----------------|---------|--------------|
| `11_1` | Email input | Textbox "Phone number / email address" |
| `11_2` | Password input | Textbox "Password" |
| `11_13` | Log in button | Button "Log in" |

## Session Persistence

After login, the following cookies are set in the browser profile:
- `ds_session_id` — session UUID
- `aws-waf-token` — AWS WAF challenge token
- `smidV2` — device fingerprint
- `.thumbcache_*` — cache fingerprint

These cookies persist across browser sessions in the profile. No re-login needed until they expire.
