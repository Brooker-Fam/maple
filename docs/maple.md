# Maple's Log (`/maple`)

A private, collaborative newborn tracker for Maple Jane: nursing (left/right timers), bottles, pumping, diapers with stool colors, sleep, tummy time, baths, temperature, vitals and skin checks, growth with WHO percentiles, notes and questions for the doctor, photos and milestones. Matt and Brittany (and anyone they invite) log from their phones, from Claude or ChatGPT (MCP), or hands-free with Siri.

It's a family side project: unlinked from the public site and `noindex`.

## Setup checklist (production)

1. **Google sign-in: nothing to set up.** Maple reuses the OAuth client the calendar, photos and `/birth` already use, and signs in through `/birth`'s redirect URI (`/api/birth/auth/callback`), which is already registered. That callback hands any sign-in whose `state` starts with `maple.` to `handleMapleGoogleCallback` in `src/lib/maple/google-callback.ts`. The site admin username/password also works on the sign-in screen (you'll appear as "Admin"; rename yourself in Family).
2. **Who can join.** The first Google account to sign in becomes the owner. To be explicit, set `MAPLE_ALLOWED_EMAILS` (comma-separated). If it's unset, `BIRTH_ALLOWED_EMAILS` is used. Owners can also invite by Google email or with a one-time link (no Google needed) from the Family tab.
3. **Private photo storage (recommended).** Vercel → Storage → create a Blob store with **Private** access (e.g. `maple-private`). Copy its read-write token into a new env var `MAPLE_BLOB_READ_WRITE_TOKEN`. Don't connect it with the default `BLOB_*` names, or it will shadow the guest-photo store.
   Without it, photos go to the existing public store under `maple/…` with random names. They're still only ever served through the signed-in proxy (`/api/maple/photo`), but the underlying files aren't access-controlled.
4. **`MCP_SECRET`.** Set it to a long random string. Otherwise MCP tokens are derived from `ADMIN_PASS`, and changing the admin password would disconnect Claude and ChatGPT.

Migrations run on build (`maple_babies` is seeded with Maple Jane, due 2026-10-20).

## Connecting Claude and ChatGPT

Full instructions with copy buttons are at `/maple/connect`. The MCP server URL is `https://brooker.family/api/maple/mcp` (Streamable HTTP; there is no SSE).

- **Claude** (web, desktop, mobile): Settings → Connectors → Add custom connector → paste the URL → Connect → Continue with Google.
- **ChatGPT** (web, developer mode / custom connectors): add a custom MCP server with the same URL and OAuth.
- **Claude Code:** `claude mcp add --transport http maple https://brooker.family/api/maple/mcp`.
- **The existing "Brooker Family Calendar" connector** (`/api/mcp`, admin login) carries Maple's tools too, next to `calendar_exec`, so Matt doesn't need a second connector. Its entries are credited to "Admin" unless an owner signed in with Google turns on Family → Talk to Maple's Log → "Calendar connector logs as me" (`settings.admin_as`, which can only be set to yourself). The Admin row appears in Family after the connector's first Maple call, so an owner can turn it off there. If an owner turns off the admin login for Maple, those tools refuse but the calendar keeps working.

OAuth reuses the site's `/oauth/*` shim. A Maple connection (detected by the RFC 8707 `resource` parameter, or the `maple` scope) signs in with the same Google session as the app, and the token is minted for `maple:<email>`, so entries show "via Claude / via ChatGPT" under the right person.

- **Bound to this server.** Tokens are bound to exactly `https://brooker.family/api/maple/mcp`. Any other resource is refused at consent, so another MCP server can't obtain or replay a parent's token.
- **Calendar and RSVP stay admin-only.** Those MCP servers only accept admin tokens, so a family member's Maple token can't open them.
- **Refresh tokens, for Claude, ChatGPT and local apps only.** A code sent anywhere else (say, a phishing page) gets a 30-day token and no renewal. Each refresh hands out a new refresh token, so connectors in use don't expire. They're stateless, so an old one stays valid until it expires. Admin-login ones last 90 days (the admin login can run code on the calendar and RSVP servers) and die when `ADMIN_PASS` or `MCP_SECRET` changes. Family members' last a year and are re-checked against membership.

## Access and revocation

- **Removing someone** (Family tab) ends everything at once: their sessions, MCP connections (checked on every request and every refresh) and Siri tokens. Removal leaves a tombstone, so an address on `MAPLE_ALLOWED_EMAILS` can't simply sign back in. Inviting them again lifts it.
- **The admin password login** shows up in Family as "Admin". A Google owner can remove it, which turns off the admin password and admin MCP access for Maple only; the calendar and RSVP are unaffected. Delete the `admin` row from `maple_removed` to turn it back on.
- **Changing `ADMIN_PASS`** signs Admin out of Maple, and revokes admin MCP tokens issued since this change.
- **The session cookie** is scoped to `/api/maple` and `/oauth/authorize`, so the `/ingest` analytics proxy never sees it.

## Hands-free (Siri / Shortcuts)

Family → Hands-free creates a personal token. An iOS Shortcut does *Get Contents of URL* (`POST https://brooker.family/api/maple/quick`, header `Authorization: Bearer maple_…`, JSON `{"action":"pee"}`), then *Speak Text* with the response's `speak` field.

Actions: `pee`, `poop`, `both`, `nurse_left`, `nurse_right`, `switch`, `stop`, `sleep`, `wake`, `vitamin_d`, `bottle` (with `amount_oz`), `status`.

## How it works

- **Data** lives in `maple_entries`: one row per event, with `kind` plus JSONB `data` in metric units (g, cm, °C, ml). The UI shows lb/oz, in, °F and fl oz by default.
  - Running timers are rows with `active = TRUE`. A unique index allows one running timer per kind.
  - `client_id` makes retries idempotent.
  - Deletes are soft deletes, so they can be undone.
- **Shared logic** in `src/lib/maple/` is pure TypeScript, used by the browser, the REST routes and the MCP tools alike:
  - `types.ts` holds the shapes.
  - `time.ts` holds time-zone and DST-safe helpers, plus `parseWhen` for times like "3:10am", "20 min ago" and "yesterday 11pm".
  - `feed.ts` does the left/right timer math and the next-side rule (offer the opposite of the side the last feed started on). `retimeBreast` moves a timed session's start or end: the first side grows or shrinks from the start, the last side from the end. The timer card ("since 4:05 ✎", and the "started earlier?" toast after a start), the feed sheet and `update_entry` all use it.
  - `insights.ts` builds the Today summary, alerts, targets and celebrations.
  - `guidelines.ts` holds every pediatric threshold and every line of alert wording.
  - `growth.ts` + `who-girls.ts` hold the WHO girls LMS tables (daily, 0–730 days) and the percentile math. Only load these lazily on the client.
  - `describe.ts` gives a one-line wording of any entry.
- **Server:**
  - `auth.ts` handles Google sign-in, the session cookie, membership and roles (owner, member, viewer).
  - `store.ts` handles the SQL.
  - `api.ts` has the route helpers.
  - `mcp-tools.ts` has the MCP tools.
- **Client** in `src/components/maple/`:
  - `useMaple.tsx` handles polling every 10s, optimistic writes, the offline outbox, and undo toasts.
  - `ui.tsx` holds the small UI kit, and `icons.tsx` the line icons (Lucide paths plus custom bottle, diaper and tummy glyphs).
  - `sheets/` holds the log and edit forms.
  - There's one component per tab.
- **Look:** calm and native-feeling. Colors are semantic `mp-*` tokens (`bg-mp-surface`, `text-mp-ink-2`, `border-mp-line`, `bg-mp-accent`…), registered in `globals.css` and given values in `src/app/maple/maple.css` for day, dark mode and the night look, so components need no `dark:` variants. Kind colors (`palette.ts`) mark what an entry is; anything colored by kind carries `mp-kind`, `mp-kind-ink` or `mp-kind-fill` so it folds into the amber at night. No emoji in the app's chrome: icons, colored dots or words instead. Members' own avatar emoji and anything the family types are the exceptions. The system font for the UI, with the display serif only for page titles and her name.
- **Medical guidance** in `guidelines.ts` was checked against AAP/HealthyChildren, CDC, NIH, WHO, ABM and children's hospital triage guides. It's tuned for a healthy full-term baby.
  - **Warnings and reminders are off by default** (`settings.show_alerts`, Family → On Today → Warnings & reminders). Feed gaps, diaper counts, weight trends, vitamin D and checkup notes only mean something when every feed and diaper gets logged, and the family doesn't log that consistently. With them off, Today, Siri and Claude/ChatGPT show none. A reading is still checked as it's entered (temperature, oxygen/heart/breathing, poop color, medicine for her age), in the sheet and in the assistant's reply.
  - Alerts always say who to call: 911, the pediatrician now, today, or mention it at the next visit.
  - The app never suggests a medicine dose.
  - If Maple's pediatrician gives different targets (feed interval, preterm plan), set them under Family → Her doctor.
