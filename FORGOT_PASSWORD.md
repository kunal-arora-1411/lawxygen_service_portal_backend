# Client Forgot Password — Frontend Integration

Base URL: `/api/client/auth`

Flow: **email → OTP → new password**, across 3 calls.

---

## 1. Request OTP

`POST /api/client/auth/forgot-password`

**Body**
```json
{ "email": "user@example.com" }
```

**Success — 200**
```json
{
  "statusCode": 200,
  "data": null,
  "message": "OTP sent to your email",
  "success": true
}
```

**Errors**
| Status | Message |
|---|---|
| 400 | Email is required |
| 404 | No account found with this email |

OTP is 6 digits, valid for **10 minutes**, sent via email.

---

## 2. Verify OTP

`POST /api/client/auth/verify-reset-otp`

Call this after the user enters the OTP, before showing the "set new password" screen. It does **not** consume the OTP — the OTP is still required again in step 3.

**Body**
```json
{ "email": "user@example.com", "otp": "123456" }
```

**Success — 200**
```json
{
  "statusCode": 200,
  "data": null,
  "message": "OTP verified successfully",
  "success": true
}
```

**Errors**
| Status | Message |
|---|---|
| 400 | Email and OTP are required |
| 400 | OTP not requested |
| 400 | OTP has expired |
| 400 | Invalid OTP |
| 404 | No account found with this email |

---

## 3. Reset Password

`POST /api/client/auth/reset-password`

**Body**
```json
{
  "email": "user@example.com",
  "otp": "123456",
  "newPassword": "NewStrongPassword123"
}
```

**Success — 200**
```json
{
  "statusCode": 200,
  "data": null,
  "message": "Password reset successfully. Please log in with your new password.",
  "success": true
}
```

**Errors**
| Status | Message |
|---|---|
| 400 | Email, OTP and new password are required |
| 400 | Password must be at least 8 characters long |
| 400 | OTP not requested |
| 400 | OTP has expired |
| 400 | Invalid OTP |
| 404 | No account found with this email |

On success, the user's existing session is invalidated server-side (refresh token cleared) — redirect to the login page, don't try to keep them signed in.

---

## Notes for frontend

- Keep `email` and `otp` in memory/state across steps 2 → 3 (the OTP is re-verified server-side in step 3, so both are required again).
- All error responses share this shape:
  ```json
  { "statusCode": 400, "data": null, "message": "...", "success": false, "errors": [] }
  ```
  Render `message` directly; no need to branch on `errors`.
- No auth cookies/headers are needed for any of these 3 calls — they're public, unauthenticated endpoints (that's how a locked-out user can use them).
- This flow works for any account with an email on file, including ones that originally signed up via Google/Facebook — completing it sets/replaces that account's password and enables email+password login going forward.
