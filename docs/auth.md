# Sign-in setup

Maple supports Google, one-time email codes and Sign in with Apple. Each provider is shown only when its server configuration is present. Configuration detection is not a delivery or provider-health check: finish the checks below before calling a method ready for production.

The web deployment, Apple Developer account and installed native apps are separate release steps. This change adds the implementation; it does not provision Apple identifiers, install native builds or establish that production credentials are configured.

## Accounts and family access

All methods resolve to the existing member key before checking `maple_members`. The additive `maple_auth_identities` table stores a provider (`email` or `apple`), verified email/Apple subject, member key and display label. It grants no role or family access on its own. Existing Google members can use an email code for the same verified address. Apple's stable subject identifies a returning Apple account even when its token no longer includes an email address.

For a different email address or Apple's Hide My Email, sign in with the original method and open **Family → Sign-in methods**. Verify the new email or choose **Connect Apple** there. A sign-in method already tied to another account cannot be moved to this one. Independent accounts and logs are not merged automatically. Changing methods does not change membership, removals, log attribution or family boundaries.

New-family sign-up still follows `MAPLE_SIGNUP`, invite-code checks, terms acceptance, daily limits and onboarding. An addressed family invitation still requires its link and the invited identity. One-time invite links and the site-admin fallback remain available.

## Required deployment configuration

Set variables in **Vercel → guava-tri → maple → Settings → Environment Variables**, for each intended environment. Do not commit `.env` files or paste private values into tickets, screenshots or logs. Redeploy after changes; running deployments keep their previous configuration.

| Method | Variables |
| --- | --- |
| Existing Google | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Email | `RESEND_API_KEY`, `RESEND_EMAIL_DOMAIN=maplebaby.app`, and `MAPLE_SESSION_SECRET` (legacy fallback: `GOOGLE_CLIENT_SECRET`) |
| Apple | `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` |
| Shared app | Maple's existing database, session and MCP configuration; `NEXT_PUBLIC_MAPLE_ORIGIN=https://maplebaby.app` in production |

Use Maple's existing session key; do not rotate it as part of adding a provider. Preserve the pinned VAPID keys and existing previous-key configuration. New-family sign-up has its own independent-key requirements described in [maple.md](maple.md#opening-family-sign-up).

The build runs additive migrations, including `maple_auth_identities` and short-lived authentication challenges. As with every schema change, confirm the deployment points to Maple's own Neon database before building against it.

## Email codes

Use the existing verified Resend sending domain. The sender is `Maple <hello@maplebaby.app>` and replies reach `hello@maplebaby.app`. Keep open/click tracking off. Existing invite and welcome emails continue using the same transport.

Codes have six digits, expire after ten minutes and work once. The browser keeps a random challenge token in an HttpOnly cookie; it is not in the URL or email. The database stores a hash of that token, an HMAC of the code, and encrypted email/flow context. The code is never stored in plaintext. Verification charges attempts atomically and permits at most five guesses per challenge. Expired challenge rows are removed during later issuance requests.

Sends are limited to one per address per 60 seconds, five per address per hour, 20 per connection per hour, and a global daily ceiling. `MAPLE_EMAIL_AUTH_DAILY_MAX` defaults to `1000`; `0` pauses new code emails. The counters use keyed hashes, not plaintext addresses or IPs. A failed or timed-out send cannot establish a session.

The email is a requested transactional message, containing only the code and instructions. Request responses do not reveal whether an address already has a family. Use the screen where the code was requested, including inside the native app; the code is bound to that browser's challenge.

## Apple Developer configuration

An Apple Developer team with access to Certificates, Identifiers & Profiles must configure these resources. See Apple's [web setup](https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web/) and [private email relay setup](https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service/).

1. Enable **Sign in with Apple** on Maple's primary App ID. Use the app's existing identifier; do not create a second app registration just for the web button.
2. Create or select a **Services ID**, enable Sign in with Apple, and associate it with that primary App ID. The Services ID identifier is `APPLE_CLIENT_ID`; it is the web OAuth client, not the iOS bundle identifier.
3. In the Services ID's website configuration, register the domain `maplebaby.app` and the exact return URL **`https://maplebaby.app/api/maple/auth/apple/callback`**. Complete any ownership verification Apple requests. Additional domains need their own explicitly registered HTTPS return URLs. A random preview hostname or `localhost` is not a usable Apple return URL; use an approved stable HTTPS staging hostname for end-to-end tests.
4. Create a key with **Sign in with Apple** enabled and associated with the same primary App ID. Download its `.p8` private key and store it securely. The key's ten-character ID is `APPLE_KEY_ID`; the team's ten-character ID is `APPLE_TEAM_ID`.
5. Add the four `APPLE_*` values to Vercel. `APPLE_PRIVATE_KEY` is the entire P-256 PEM, including its BEGIN/END lines; real line breaks or literal `\n` separators are accepted. Never put it in a public variable. Maple signs a short-lived ES256 client secret on the server; there is no manually maintained `APPLE_CLIENT_SECRET` value.
6. Under **Sign in with Apple → Email Communication / Private Email Relay**, register `hello@maplebaby.app` (or its sending domain, using Apple's accepted domain configuration) as an email source. Verify that Resend's DKIM/SPF setup satisfies Apple's relay checks. This is required for code, invite and welcome email delivery to `@privaterelay.appleid.com` addresses. Do not change the root MX records used by the contact inbox.
7. Redeploy Maple, then test both **Share My Email** and **Hide My Email** with a controlled account, including a subsequent sign-in and relay email delivery.

Apple returns a cross-site `form_post` to its callback. The implementation validates the browser-bound state, nonce and ID-token signature before resolving the member. Apple tokens are checked against its published keys for issuer, audience, expiry, issued-at, nonce and subject. A supplied email must be verified. The callback's unsigned `user` JSON is not an identity source, and access/refresh tokens are not retained.

For key rotation, deploy a valid replacement key before revoking the old key. Keep the Services ID and primary App ID association stable: changing the Apple identity namespace can prevent existing subjects from resolving. Do not copy client IDs or private keys between unrelated apps.

## Native apps

Email codes work inside the existing web view. Google keeps its current system-browser flow.

Apple support in `ios/` and `android/` requires building and installing the updated wrappers, which advertise `Maple-Native-App/1.1` or later. The web UI does not offer native Apple sign-in to older wrappers. The updated bridge opens the system sign-in session and uses the same verifier-bound `maple://auth` ticket handoff as Google. Publishing the website does not update native binaries.

Connecting Apple to an already signed-in account is browser-only. Open Maple in the browser, sign in with the existing method, and use **Family → Sign-in methods → Connect Apple**. After that, Apple sign-in in the updated native app opens the existing account. Connecting another email works within the app too.

## Verification

Local checks use generated keys, fake addresses and an in-memory database; they do not require production secrets or send real email:

```sh
pnpm check:apple-auth
pnpm check:email-auth
pnpm check:signin
pnpm check:email
pnpm check:maple-native
pnpm check:maple-tenancy
pnpm typecheck
pnpm lint
```

After deployment, check provider visibility, Google regression, email delivery/code entry, expired and reused codes, signup, addressed invites and sign-out/re-entry. Verify that connecting an email or Apple method preserves the same member and log, that a method belonging to another account is refused, and that a removed member cannot regain access using a connected method. Test new native binaries on their devices. A local mock passing does not verify Apple account setup, Resend deliverability or the deployed environment.

## Retention and support

Sign-in identities are account-wide, not owned by one family. When handling a deletion request, remove the family's data as usual and remove its members' sign-in identity rows only when no remaining family membership needs them. A request to delete an account's sign-in methods needs the corresponding identity records removed as part of that support action. Preserve removal records as required to prevent access from returning unexpectedly. Expired code challenges are cleaned up on later code requests; invalidate outstanding challenges when responding to an account compromise.

Privacy and terms describe the added identity records, Apple relay addresses and sign-in emails (legal version 1.5, October 28, 2026). No codes, tokens, addresses or provider response bodies belong in analytics or error logs.
