# TODO

Consolidated list of outstanding work. Each item links back to the inline marker in the source.

## Blockers — must resolve before production

- [ ] **Wire up email delivery.** Verification and reset links are currently `console.log`'d server-side as a placeholder. Cloudflare logs are not a safe delivery channel — these leak tokens.
  - `src/users.ts:79` — registration verification link.
  - `functions/api/db/password/request.ts:62` — password-reset link.
  - `functions/api/db/auth/email/resend.ts:99` — resend verification link.
  - The two `// SECURITY: remove before production` log sites must be removed once delivery exists.
- [ ] **Document production deployment.** `ARCHITECTURE.md:43` ("for Production Deployment") is a bare `TODO` stub.

## Security

- [ ] **2FA setup QR generation.** Consider a more secure method for generating QR codes — `functions/api/db/auth/2fa/setup/start.ts:132`.

## Features

- [ ] **2FA bypass flow.** Replace the password-reset fallback with a dedicated email-based flow to bypass 2FA — `public/2fa.html:56`.

## Code quality

- [ ] **Reuse `readToken` in resend.** `email/resend.ts` imports `readToken` to check whether a token already exists before issuing a new one, but does not yet use it — `functions/api/db/auth/email/resend.ts:1`.
- [ ] **Verify password-requirements assertions.** Confirm the `hasNumber` regex behaves as the commented assertions claim, then remove the stale comment — `src/passwords.ts:308`.
