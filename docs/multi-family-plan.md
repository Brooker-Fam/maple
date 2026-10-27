# Maple for other families: the multi-family plan

Research and design only. No repo file was changed. Read against `Brooker-Fam/maple` main at `8455bb8`, then re-checked at `caf1cf0` (GitHub main, 2026-10-26): `src/lib/maple/` is unchanged between them; `caf1cf0` adds the marketing site, `/terms`, `/privacy`, a `maple_waitlist` table, and the bundle id `app.maplebaby`. Moku: `moku-coach/tri-coach2` main at `679f081`.

**The constraint that shapes every step:** the Brooker family logs Maple Jane on this database every day, from the app, Siri, Claude and (until removed) brooker-wedding's own copy of Maple. Nothing in this plan may lose, hide or mix up one of their entries, and no step may need real family data in a test.

---

## 0. Findings that change the order of work

1. **The database is brooker-wedding's.** The same Neon database holds wedding RSVPs, mailing lists, birth plans, the family calendar, game scores and a table already named `households` (36 `CREATE TABLE`s in brooker-wedding's `migrate.ts`). Another family's health data must not live there. Maple moves to its own Neon project before any other family signs up (section 2.6).
2. **brooker-wedding no longer carries Maple (checked 2026-10-27).** Its main branch (`ded342f`) dropped `src/lib/maple/` and every `maple_*` statement from its `migrate.ts` in `d6c767c` ("Move Maple's Log out"); only `upload_rate_limit` is still shared. Its newest production deployment was created 6 seconds after `ded342f` was committed (`vercel inspect` doesn't print the commit, so moderate confidence that production runs it). It still shares the database until the Neon move. Schema changes stay additive anyway, because a Vercel instant rollback of Maple puts older code back on the migrated schema. The sign-up switch also checks for it in code (`olderCopyActive`): an older copy claims notices and wakes without a family, so sign-up stays off while any such claim is under 7 days old.
3. **Photos are one guess away from leaking across families.** `GET /api/maple/photo` loads the entry with `getEntry(entryId)` (`store.ts:241`, `WHERE id = $1`), and entry ids are a global `BIGSERIAL`. With a second family, any signed-in member could walk ids and fetch the Brookers' photos. The same by-id pattern is in 24 `getEntry` calls and most update/delete paths.
4. **Secrets are shared with brooker-wedding on purpose.** Session cookies and native tickets are AES-GCM keyed by `sha256(GOOGLE_CLIENT_SECRET)` (`src/lib/secret-box.ts:7`), MCP tokens are HMAC'd with `MCP_SECRET`, else `brooker-mcp:${ADMIN_PASS}`, and the Google OAuth client is brooker-wedding's. Anyone holding brooker-wedding's secrets can mint a Maple session. Fine for one family; not for a product. Worse: with neither `MCP_SECRET` nor `ADMIN_PASS` set, MCP tokens are signed with the string `brooker-mcp-dev-secret-change-me` (`mcp/auth.ts:15`), which is public in this repo, so anyone could forge `sub: maple:<email>`. Removing the admin login (Phase 4) without fixing this would open every family.
5. **Zero data retention needs a paid Vercel plan.** Vercel's AI Gateway pricing page lists per-request ZDR as "Pro and Enterprise" only. Maple's chat sends `zeroDataRetention: true` on every call, so the project must stay on a Pro (or Enterprise) team. Hobby is also non-commercial.
6. **Most of the copy assumes a girl named Maple whose mom is Brittany.** The baby's pronoun is "she/her" across 480 non-comment lines in 104 files (shared with mom's pronouns), growth uses WHO **girls** tables only, and about 257 string literals say "Maple" as the baby's name. This de-hardcoding is the largest single piece of work, larger than the tenancy plumbing.
7. **Migrations run inside every build, against live code.** `build` is `pnpm run migrate && next build`, and `migrate.ts` runs against whatever `DATABASE_URL` the build has, Preview builds included (there is no `VERCEL_ENV` guard). A schema change therefore lands while the previous deployment is still serving, and stays if `next build` then fails. And 10 `ON CONFLICT` statements name the exact unique keys this plan changes (1.2). So every key change goes expand, switch, contract (section 3), and nothing non-additive ever runs from `migrate.ts`.

---

## 1. Inventory: everything that assumes one family

Counts are from scripts over `src/` and `scripts/` (comments excluded where noted). Script copies are in `scratchpad/mf-tools/` (`sql_sites.py`, `sql_scope.py`).

### 1.1 Tables (18 created in `src/lib/migrate.ts`)

| Table | One-family assumption | Fix |
|---|---|---|
| `maple_babies` | Seeded with `'Maple Jane', 'female', 2026-10-20` when empty (migrate.ts:50). Read as `ORDER BY id LIMIT 1` by `getBaby()` (store.ts:122) and `babyTz()` (push-wake.ts:285). Holds family-wide settings (`show_alerts`, `feeds_bottle`, `track_pump`, `admin_as`, acks, her doctor). | `family_id`; family-wide settings move to `maple_families.settings`; unique `(family_id, id)` in Phase 1, for the composite FK from entries. The seed is deleted in Phase 0. |
| `maple_members` | `email` is the PRIMARY KEY: a person can be in one log only. First Google sign-in claims owner. Five inserts say `ON CONFLICT (email)`. | `family_id`; unique `(family_id, email)` added beside the PK in Phase 1, the PK moves onto it in Phase 3. |
| `maple_entries` | Already has `baby_id` (good). By-id reads/writes (`getEntry`, `updateEntry`, `softDeleteEntry`, restore, join) ignore it. `client_id` is unique globally (`uniq_maple_entries_client`), looked up unscoped (store.ts:323, mcp-tools.ts:1095), and named by `ON CONFLICT (client_id) WHERE client_id IS NOT NULL` (store.ts:306). | `family_id` + composite FK `(family_id, baby_id)`; every by-id statement adds `AND family_id = $n`; unique `(family_id, client_id)` beside the global one until Phase 3. |
| `maple_removed` | `email` PK, global; `ON CONFLICT (email) DO UPDATE` (store.ts:1137). | unique `(family_id, email)`, then the PK moves onto it. |
| `maple_invites` | No family. `listInvites` returns every unused invite. | `family_id`. |
| `maple_tokens` (Siri) | `member` only. | `family_id`. |
| `maple_care_people` | A single-row unique index `uniq_maple_care_people_one ON ((TRUE))`; PK `member` is the **name** "Brittany", not a member id; `getCarePerson()` is `LIMIT 1` and creates her on first read. Every non-viewer member reads and writes the whole page, check-ins included (`careAccess`, care.ts:93-99); `shared_with` is stored but ignored (care-store.ts:937). | `family_id UNIQUE`; opt-in per family (no auto-create); tied to a member id; `shared_with` enforced (5.3). |
| `maple_care_meds`, `maple_care_entries`, `maple_care_mood` | `person` FK to that name. Random 8-digit ids are global (90M space). Global `client_id` unique indexes; `ON CONFLICT (client_id) …` at care-store.ts:896. | `family_id` on each; scope by family, not by name; unique `(family_id, client_id)` beside the global ones until Phase 3. |
| `maple_push_subs` | `member` only; the tick loads every phone for "the" family. `endpoint` is UNIQUE across the table and upserted `ON CONFLICT (endpoint)` (push.ts:201, 229), so a grandparent's phone (one endpoint per origin) subscribing in family B silently leaves family A. | `family_id`; unique `(family_id, endpoint)`, one row per family the phone follows; the tick sends per family. |
| `maple_push_sent` | Global keys (`tick`, `tick:%`, `net:%`, `wake:<second>`, `floor:v2`, `gap:`, `miss:`). | Exempt from the `DEFAULT 1` and from `NOT NULL`: a nullable `family_id`, set only on per-family rows. The family goes into the key too: `wake:<fam>:<sec>`, `tick:<fam>` (the poll gate), `miss:<fam>:…`. Only the safety net's keys (`net:%`, `floor:v2`, the `tick:<via>` health rows) stay global. |
| `maple_chat_threads`, `maple_chat_messages`, `maple_chat_daily` | `member` only; `maple_chat_daily` PK `(member, day)`, named by `ON CONFLICT (member, day)` (chat/store.ts:109). | `family_id`; unique `(family_id, member, day)` beside the PK, then the PK moves onto it. |
| `maple_ai_usage` | `usageSince` sums **all** rows for the "family" budget (chat/store.ts:95). | `family_id`, no default; budgets per family. Exempt from `NOT NULL`: a deleted family's rows keep their cost with `family_id` set to null (5.8). |
| `upload_rate_limit` | Per IP, global. brooker-wedding creates the same table (its `migrate.ts:376`) and its guest gallery uses it (`/api/photos/report`). | Keep global (abuse control). Not part of the Neon move or the old-table drop: Maple's `migrate.ts` makes its own empty one. |
| `maple_waitlist` (new in `caf1cf0`) | Sign-up interest from the marketing site, not family data. | Keep global. |

### 1.2 Query sites

- **156 SQL statements** in 10 files outside `migrate.ts` (183 table references in 11 files counting scripts). These counts are approximate: `sql_scope.py` matches backtick literals with a regex, so it mis-splits nested templates such as care-store.ts:1058-1062 (`${visibleSql(2)}` and an inner template) and spliced fragments such as `getEntry`'s `${opts.includeDeleted ? … }` (store.ts:241). The real check has to be built on the TypeScript AST (2.4).
- **11** filter by `baby_id` (8 in `store.ts`, 3 in `mcp-tools.ts`). **145 have no family scope.**
- Per file: `store.ts` 42, `care-store.ts` 36, `push.ts` 32, `chat/store.ts` 13, `push-wake.ts` 9, `auth.ts` 8, `mcp-tools.ts` 7, `notify.ts` 7, `upload/route.ts` 1, `rate-limit.ts` 1.
- Singleton helpers: `getBaby()` 17 calls in 13 files; `getCarePerson()` 5 calls in 5 files; `listMembers()` (all members, unscoped) 18 calls in 11 files; `memberFor()` 12 calls; `getEntry()` 24 calls in 3 files.
- **10 `ON CONFLICT` statements name a unique key this plan changes:** `(client_id) WHERE client_id IS NOT NULL` ×2 (store.ts:306, care-store.ts:896), `(email)` ×5 (store.ts:1117, 1137, 1322; auth.ts:236, 258), `(member, day)` ×1 (chat/store.ts:109), `(endpoint)` ×2 (push.ts:201, 229). Postgres rejects a target with no matching unique index (error 42P10), so replacing any of those keys in place breaks that insert at once.
- `rev()` (the 10-second poll's change token, store.ts:1381) counts **all** `maple_members`. Another family adding a member would force every family's phones to refetch full state, and leaks when other families change.
- `upload` DELETE checks "is this blob still used" across every family's entries (fine for safety, but should be scoped).
- `export` exports `getBaby()`'s entries only; no care data, no photos.

### 1.3 Routes and auth surfaces

- 38 route files (31 under `/api/maple`), 22 resolving a member through `withMember` / `withCare` / `sessionMember` / `memberForPersonalToken`. None carries a family.
- **Session cookie** `{ id, iat, pf? }` with `id` an email, `"admin"` or `"invite:<n>"` (auth.ts:99). No family.
- **Admin login** (`ADMIN_USER`/`ADMIN_PASS`) signs in as owner pseudo-member `admin` of the only log; `admin_as` (25 references in 10 files) lets it act as an owner. With a second family it would be an owner of whichever log a query happened to hit.
- **Google sign-in** (`joinWithGoogle`): an existing member signs in; otherwise `MAPLE_ALLOWED_EMAILS` (2 files) or "first sign-in claims owner". No path creates a family.
- **Native ticket** (`native-auth.ts`) names the member only.
- **MCP**: `/oauth/*` mints `sub: "maple:<email>"` (authorize/route.ts:153); `context()` (mcp-tools.ts:293) resolves `getBaby()` + `listMembers()`; the transport route checks `memberFor` only. Tokens carry no family.
- **MCP tool text is fixed at server start** (every POST builds a fresh stateless server and registration must stay DB-free): 36 tools (29 for the baby, 7 for mom), titles like "How's Maple right now?", "Maple's moments", "She's here! Record the birth"; mom tools titled with `MOM` = `DEFAULT_CARE_PERSON`. `MAPLE_INSTRUCTIONS` opens "Maple's Log is the Brooker family's private newborn tracker for Maple Jane (timezone America/New_York …)", and two schema descriptions say "Local time in America/New_York" (mcp-tools.ts:1332, care-mcp.ts:457). The chat reuses all of this as its cached prefix (`chat/prompt.ts`, `chat/tools.ts` caches the registrations at module level).
- **Siri** (`/api/maple/quick`): token → member → `getBaby()`; spoken copy names "Maple" (12 lines in the route).

### 1.4 Push and QStash

- `tick` (push.ts:543 on) loads every subscribed phone, then one baby, one care person (`collectMoments`) and one timezone, and sends her reminders to every member with access. With two families, family B's phones would get family A's medicine reminders.
- `scheduleWakeups` reads one timezone (`babyTz()`), publishes `wake:<second>` rows shared by everyone, and one safety-net schedule `maple-tick-net`.
- `notify.ts` ("Logged" and the nursing notice) reads `maple_care_entries`/`maple_entries` by id without scope.
- VAPID keys are global (fine).

### 1.5 Copy and medical content

- "Brittany": 62 lines in 34 files; **11 user-facing**: 7 copies of "Ask Matt or Brittany…" (api.ts:37, sheets/parts.tsx:173, FixTimesSheet.tsx:782, join/page.tsx:86 and 139, auth/join/route.ts:22, SignIn.tsx:18), two invite lines in SignIn.tsx (183, 184), "Invite Brittany, grandparents…" (FamilyTab.tsx:410) and `DEFAULT_CARE_PERSON = "Brittany"` (care-store.ts:198).
- "Matt": 40 lines in 23 files; 13 user-facing (adds "ask Matt" in `SignIn.tsx`, the "Matt's iPhone" placeholder, an example in `MAPLE_INSTRUCTIONS`).
- "Maple Jane": 3 in `src/` (layout description, the seed, `MAPLE_INSTRUCTIONS`), plus `public/maple.webmanifest:4` ("…for Maple Jane"). The first scan covered only `src/` and `scripts/`; `public/`, `ios/` and `android/` were scanned at `caf1cf0`: the manifest line is the only family name there (the native READMEs and one iOS test mention `brooker.family` as an old origin).
- "Brooker": 3 user-facing (the calendar-connector card on `/maple/connect` and in Family, and `MAPLE_INSTRUCTIONS`).
- Baby name "Maple" in copy: about 257 string literals; heaviest in `mcp-tools.ts` (45 lines), `guidelines.ts` (26), `care-mcp.ts` (26), `quick/route.ts` (12), 123 lines across 48 component files. Components mostly fall back to `baby.name` with `"Maple"` as the default; the server strings are hard-coded.
- Pronouns: 480 non-comment lines with she/her in 104 files; `guidelines.ts` alone has 82. Many are about mom (correct for her), many about the baby (wrong for a boy).
- Growth: `growth.ts` imports `WHO_GIRLS` only (`who-girls.ts`, 409 lines). A boy needs the WHO boys LMS tables.
- Timezone: `DEFAULT_TZ = "America/New_York"` (time.ts:8) appears 97 times in 36 files, almost all as a fallback after `baby.timezone`; 31 literal `America/New_York` lines in 17 files: 8 component fallbacks, 3 server fallbacks (store.ts:104 and 1198, push-wake.ts:286), the column default, and 3 model-facing texts.
- US-only content: help lines (`MOM_HELP`: 911, 988, 1-833-852-6262), US units by default, AAP/CDC thresholds tuned "for a healthy full-term baby".
- Hard-coded people in empty states and errors: `api.ts:37`, `sheets/parts.tsx:173`, `FixTimesSheet.tsx:782`, `join/page.tsx:86,139`, `auth/join/route.ts:22`, `SignIn.tsx:18,25,132,183,184`, `FamilyTab.tsx:410`.

### 1.6 Environment and identity

- Env singletons: `ADMIN_USER`, `ADMIN_PASS`, `MAPLE_ALLOWED_EMAILS`, `MAPLE_CHAT_DAILY_BUDGET_MICRO`, `MAPLE_CHAT_MONTHLY_BUDGET_MICRO` (one family's budget), `LEGACY_ORIGIN = https://brooker.family` (origin.ts).
- Client storage: 30 `maple-*` localStorage keys, none family-scoped. The offline outbox (`maple-outbox-v1`) is the dangerous one: after a family switch, a queued item could post to the wrong family.
- Native apps: bundle id / applicationId is now `app.maplebaby` (changed in `4715ad3`; no `family.brooker.maple` left in the repo). A bundle id can't change after the first App Store release.
- Session, MCP and VAPID secrets derived from brooker-wedding's (finding 4). The session key also seals the native ticket; VAPID derives from `MCP_SECRET || GOOGLE_CLIENT_SECRET` unless `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set (push.ts:137), so changing either secret can break every phone's notifications.

---

## 2. Data model

### 2.1 Families

New table **`maple_families`** (not `households`: brooker-wedding already has a table by that name in the shared database).

- `id BIGSERIAL PRIMARY KEY`. The Brooker family is inserted as `id = 1` (then `setval`), so every backfill is a constant.
- `name` ("The Brooker family", shown only to its members), `timezone` (IANA, required), `country` (`'US'` at launch), `units` (`'us' | 'metric'`), `status` (`'onboarding' | 'active' | 'deleting'`), `plan` (`'beta' | 'free' | 'plus'`), `settings JSONB` (the family-wide switches moved off `maple_babies.settings`: `show_alerts`, `feeds_bottle`, `track_pump`, `admin_as` while it exists), `onboarding JSONB` (progress only, section 4), `created_by`, `created_at`, `updated_at`, `delete_requested_at`.
- Timezone moves from the baby to the family (one household clock). `maple_babies.timezone` stays as a read fallback until Phase 4.

### 2.2 Babies: twins and siblings

**Decision (recommended): the schema allows several babies per family from the start; the app shows exactly one active baby at launch.**

- Why the schema: it is nearly free. `maple_entries.baby_id` and the per-baby unique index for running timers (`uniq_maple_entries_running ON (baby_id, kind)`) already exist. A sibling born two years later becomes a second `maple_babies` row in the same family, and the first one's history stays.
- Why not twins in the UI yet: the dock, the Lantern, Today's hero, the dial, Siri's phrases ("Maple pee") and every MCP tool assume one baby. Twins need a baby picker on every log action, tandem nursing (one feed, two babies) and per-baby notifications. That's a large phase of its own. Twins are roughly 3% of US births.
- Rule until twin mode ships: onboarding creates one baby; a family with an active baby can't add a second (server check, not a constraint). `maple_babies` gets `archived_at` for "older sibling".

### 2.3 Members

- `maple_members` gets `family_id`; its PK becomes `(family_id, email)` in Phase 3. One person can then belong to several families (a grandparent of two grandchildren, a nanny).
- Member ids stay what they are (lowercased email, `invite:<n>`, `admin`), scoped by family. `created_by`/`updated_by` keep storing them.
- The session carries an **active family** (2.5). A switcher appears only for someone in two or more families.
- `maple_removed` and `maple_invites` get `family_id`; an invite joins the family it was made in.
- **Adding someone by email becomes an invite they accept.** Today an owner's `POST /api/maple/members {email}` inserts a full member row at once (`addMember`, store.ts:1113), with no say from the person added. With other families, any owner could add a Brooker's address, which fills that person's family switcher and changes what "their family" means. So an email add creates a pending `maple_invites` row tied to that address; the person joins only after signing in with that Google account and tapping Accept. A pending invite grants nothing.
- **Admin login:** pinned to family 1 (`MAPLE_ADMIN_FAMILY_ID`, default 1). It can never see or create another family. Plan to remove it once brooker-wedding's calendar connector no longer carries Maple tools; Matt signs in with Google like everyone else.

### 2.4 `family_id` on every `maple_*` table, and how each query is scoped

Every one of the 16 `maple_*` family tables gets `family_id BIGINT REFERENCES maple_families(id)` (nullable in Phase 1, `NOT NULL` in Phase 3, except `maple_push_sent` and `maple_ai_usage`, which stay nullable: 1.1). `upload_rate_limit` and `maple_waitlist` stay global. Leading-`family_id` indexes replace the current ones (`(family_id, baby_id, started_at DESC)`, `(family_id, member, updated_at DESC)` …).

Scoping rule, enforced three ways:

1. **One request context.** `withMember`, `withCare`, the MCP `context()`, the Siri route, the chat POST, the native ticket exchange and the push tick each resolve a `FamilyCtx { familyId, babyId, member, role, tz }` once. Every store function takes it (or `familyId`) as its first argument. No store function reads "the" baby or "the" person again; `getBaby()` becomes `getBaby(familyId)`.
2. **Every statement filters `family_id`.** List queries: `WHERE family_id = $1 …`. By-id queries: `WHERE id = $1 AND family_id = $2` (a miss is `NotFound`, the same answer as "doesn't exist"). Inserts always pass `family_id`. Idempotency lookups by `client_id` add the family.
3. **A build-failing check.** `pnpm check:maple-tenancy` walks the TypeScript AST (the compiler API, not a regex like `mf-tools/sql_scope.py`), follows helpers that return SQL fragments (`visibleSql`, `getEntry`'s spliced condition), and fails when a statement touches a family table without `family_id`, unless the line is on a short reviewed allowlist (global push keys, `upload_rate_limit`, `maple_waitlist`, migrations). It also fails on SQL it can't analyse, and on any `ON CONFLICT` target that doesn't lead with `family_id` once Phase 2 starts. Today it would report about 145 statements.

**Row-level security** is not the first line. The app uses Neon's HTTP driver, where each query is its own request, so a per-request `SET app.family_id` needs every request wrapped in a transaction batch. Worth adding later as defense in depth; the static check plus two-family tests (Phase 2) come first. (moderate)

Ids:
- Entry ids stay a global `BIGSERIAL`. Scoping removes the photo leak; the remaining leak (an MCP reply "Saved #48213" hints at total volume across families) is minor. Accept it for now.
- Care ids stay random 8-digit numbers (the `CHECK` can't change additively). At a few thousand families the retry loop in `care-store.ts` absorbs collisions.

### 2.5 How auth, sessions and tokens carry the family

| Carrier | Today | Multi-family |
|---|---|---|
| Session cookie | `{ id, iat, pf? }` | `{ id, fam, iat, pf? }`. Membership `(fam, id)` is read fresh on every request, as roles are today. A cookie without `fam` was issued before multi-family existed, so it resolves to family 1, explicitly, never to "the person's only or first family" (which another family's owner could change by adding that address). |
| Session key | `sha256(GOOGLE_CLIENT_SECRET)`, shared with brooker-wedding | A Maple-only `MAPLE_SESSION_SECRET`. The current `GOOGLE_CLIENT_SECRET` value is copied into `MAPLE_SESSION_SECRET_PREV` first, because switching to Maple's own Google client replaces `GOOGLE_CLIENT_SECRET`. Open with the new key, fall back to `_PREV` for 180 days (the cookie lifetime), always seal with the new one. No one is signed out. |
| Pending sign-up (new) | none: a session `id` must be a member (`sessionMember` → `memberFor`), a stranger gets `not_invited`, and the native callback sends `maple://auth?error=…` | A sealed, short-lived `pending` session `{ email, name, iat }` (about 30 minutes) from a verified Google sign-in with no membership, when sign-up is open. Only the terms and onboarding routes accept it; every other route treats it as signed out. The native callback mints a pending ticket on the same terms, so the apps can create a family too (Apple 5.1.1(v) then also needs in-app account deletion). |
| Google sign-in | `joinWithGoogle`: member, allowlist, or first sign-in claims owner | Existing membership signs in; a pending email invite shows Accept; otherwise a pending session and "Start a family" (onboarding) when sign-up is open, else the waitlist page. `MAPLE_ALLOWED_EMAILS` and the first-owner rule are deleted (Phase 4; until then the allowlist stays set, see 2.6). |
| Google OAuth client | brooker-wedding's | Maple's own, consent screen "Maple", homepage and privacy policy on maplebaby.app, published to production (a client left in Testing caps at 100 test users). Register both callbacks, `https://maplebaby.app/api/maple/auth/callback` and `https://brooker.family/api/maple/auth/callback`, while brooker.family still forwards sign-ins. Switch only after the session and MCP fallbacks are live (Phase 0 order). |
| Native ticket | member id, 2 minutes, sealed with the session key | adds `fam`; a pending variant for sign-up (above). Opens with `MAPLE_SESSION_SECRET` or `_PREV`, like the cookie. |
| MCP access/refresh tokens and codes | `sub: "maple:<email>"` | Add `fam`. The consent page asks "Which family?" when there are several. A token without `fam` (the Brookers' existing Claude/ChatGPT connectors) resolves to family 1, explicitly, and keeps working. Refresh re-checks `(fam, email)` membership and hands out a token with `fam`. |
| MCP secret | `MCP_SECRET`, else `brooker-mcp:${ADMIN_PASS}`, else a public hard-coded string | `MCP_SECRET` required and Maple-only; the hard-coded fallback is deleted and the server fails closed (a boot check) without it. Refresh tokens live 365 days and carry no key id, so verification tries the new secret, then the old one (`MCP_SECRET_PREV`, holding whatever signs today: the old `MCP_SECRET` or `brooker-mcp:${ADMIN_PASS}`) for 365 days; minting always uses the new one. Without that fallback every existing connector disconnects. Pin VAPID keys first (docs/maple.md step 5) because they may derive from it. |
| MCP text | names the Brookers | Family-neutral titles and instructions ("How's the baby right now?"). The baby's and her mom's names, the timezone and units come from `maple_status`'s result and the chat's `[App] Now:` line. One cached prefix then serves every family. |
| Siri token | `maple_tokens.member` | `maple_tokens.family_id`; the token resolves to `(family, member)`. Existing tokens backfill to family 1. |
| Offline outbox | `maple-outbox-v1` | Each item carries `family_id`; the server rejects a mismatch with the session (409 `family_mismatch`); a family switch first flushes or asks. The client needs a change for this: `isTransient` (useMaple.tsx:304) treats every 4xx except 408 and 429 as permanent and drops the item with a toast, so the outbox must keep `family_mismatch` items and replay them after switching back. |

### 2.6 Its own Neon project: yes, now

**Recommendation: move Maple's tables to a Maple-only Neon project before the first other family, and before the multi-family schema work.** (high on the need, moderate on the cost estimate)

Why now:
- The current database is a wedding site's (finding 1). A leaked brooker-wedding credential or a bug in its code would expose other families' health data.
- It's cheapest while there is one family and the data is small.
- Each Neon project gets its own Free allowance, so splitting doubles the free compute for both apps.

Cost (Neon pricing page, fetched 2026-10-26):
- Free: 100 CU-hours per project per month, 1 GB storage per project (20 GB across projects), 100 projects, 10 branches per project, scale to zero after 5 minutes (can't be turned off), 6 hours of restore history, autoscaling to 2 CU.
- Launch: $0.106 per CU-hour, $0.35 per GB-month, no monthly minimum, up to 7 days of restore history (instant restore $0.20 per GB-month).
- Maple's load: the app polls every 10 seconds while open (`POLL_MS`), and QStash ticks the safety net at :04 and :34. One family fits Free easily. With families awake at different hours the compute rarely sleeps: always-on at the 0.25 CU minimum is about 182 CU-hours a month, which is over Free and about $19 a month on Launch ($39 at 0.5 CU). Storage is cents.
- So: Free for the move and the beta; **switch to Launch before opening sign-up**, mainly for the 7-day restore window. Set a Neon spend alert.

Zero-downtime move (the owner runs it; agents never connect to production):
1. **Preconditions:** the family is fully on maplebaby.app; brooker-wedding's Maple code is gone (no migrations touching `maple_*`, no Maple tools on its calendar connector, `brooker.family/maple` only forwards). Otherwise its writes would keep landing in the old database. The `migrate.ts` seed is deleted (Phase 0), so an empty database never gets a "Maple Jane" row, and `getBaby()` then answers `NotFound` instead of a made-up baby. `MAPLE_ALLOWED_EMAILS` is set to the family's addresses for the whole move, because `joinWithGoogle` lets the first Google sign-in on an empty database claim owner (auth.ts:216-226), and maplebaby.app is public.
2. **Build the read-only switch first** (Chunk A work; `MAPLE_READ_ONLY` doesn't exist yet). It must cover every write path: the app's API routes and uploads, MCP tools, Siri (`/api/maple/quick`), the chat (no model call either), sign-in (no member inserts), invites, and the push tick (its `maple_push_sent` claims are writes: the tick answers 503 so QStash retries). Writes answer 503 "offline", which the outbox treats as transient (useMaple.tsx:304) and replays with its `client_id`, so nothing duplicates. Test it on the synthetic branch: every channel gets 503 and nothing changes.
3. Create the Neon project in the same region as the Vercel functions, same Postgres major version.
4. **Rehearse with no real data:** `pg_dump --schema-only` of the `maple_*` tables (not `upload_rate_limit`) into an empty branch of the new project, run Maple's migrations against it twice (idempotency), seed synthetic data (the seed creates its own care person, so `getCarePerson()` never auto-creates "Brittany" there), run the app locally against it. Then rehearse step 5's restore into a second empty branch.
5. **Cut over at a quiet hour with no timer running** (the offline outbox queues new entries, doses and check-ins, but not timer taps or edits): deploy with `MAPLE_READ_ONLY` on; `pg_dump` the Maple tables (schema, data and sequences; `upload_rate_limit` stays behind) and `pg_restore` into the new project while it is still **empty**: no build or deployment may point at it before the restore finishes, because a build runs `migrate.ts`, which would create the tables and the one-row care index first and make the data restore collide (duplicate `maple_babies` id 1, `uniq_maple_care_people_one`). Compare row counts and `MAX(updated_at)` per table (numbers only); point `DATABASE_URL`/`DATABASE_URL_UNPOOLED` at the new project; redeploy with the switch off. Siri and Claude writes during that short window fail with "offline" and can be repeated. QStash retries a tick that fails.
6. **Freeze the old tables for real.** Right after the cutover, revoke writes on the old `maple_*` tables (`REVOKE INSERT, UPDATE, DELETE` from the app's role, or rename them). Vercel deployments keep the environment variables they were built with, so an instant rollback to any deployment from before the move would otherwise write to the old database without any error, splitting the family's log in two.
7. **Verify:** log one diaper from each phone and see it on the other; one Siri status; one Claude `maple_status`; one push test; QStash log shows a 2xx tick; one write attempt from a pre-move deployment URL fails.
8. **Rollback:** deliberately restore the old tables' grants, point the env vars back and redeploy; any writes made on the new database in between are copied back by `client_id`. Drop the old `maple_*` tables only after 14 quiet days; never drop `upload_rate_limit`, which brooker-wedding's guest gallery still uses.

Logical replication (Neon supports it both ways) would avoid even the short write freeze, but needs sequence fixes and a publication on the shared database. With this little data the dump-and-restore window is simpler and safer.

Related infrastructure:
- **Vercel team.** The `maple` project sits on `guava-tri`, Moku's business team; everyone on it can read Maple's environment, including the database URL. Keep the project on a Pro team (ZDR needs Pro), but either give Maple its own Pro team or keep guava-tri's membership to people who may see family health data. Whether guava-tri is Pro today is unknown.
- **Blob.** New uploads go under `maple/f<familyId>/…` so a family's photos can be listed and deleted by prefix; `MAPLE_UPLOAD_PATH_RE` (blob.ts:28) only accepts `maple/(moments|thumbs)/…` today and changes with it. Existing Brooker photos keep their paths. Without `MAPLE_BLOB_READ_WRITE_TOKEN`, uploads fall back to the public store shared with brooker-wedding's `/photos` guest gallery (blob.ts:4-12, 37-41). Before any other family joins: a private, Maple-owned Blob store, and the public fallback deleted (uploads fail closed without the private token).

---

## 3. Phased migration (the live family safe at every step)

Ground rules for every phase:
- **Test data is synthetic.** All tenancy work runs on a **schema-only** Neon branch (`neonctl branches create --schema-only`, or a branch of an empty parent) seeded by a script with two made-up families, for example "Family Alpha" (baby "Juniper Test", girl, America/Chicago, care page on) and "Family Beta" (baby "Rowan Test", boy, America/Los_Angeles, care page off). A branch copied from production copies the Brookers' data and must never be used, and nothing from it may reach a model.
- **Production checks are counts, never content** (`COUNT(*) WHERE family_id IS NULL`, row counts per table), run by the owner.
- **On the synthetic branch, the final schema comes early.** Right after Phase 1's migrations, the branch also gets Phase 3's `NOT NULL` and `DROP DEFAULT` (and its key swaps), so a statement that forgets `family_id` fails loudly there (23502) instead of being filed under family 1. Phase 2 code must then pass on both shapes: production's (old and new keys side by side) and the branch's (new keys only).
- **Build-time migrations stay additive and safe for the code already running** (finding 7). `migrate.ts` only creates, adds and backfills. Anything that drops, swaps or tightens (Phase 3) runs out of band, from a reviewed script over the unpooled URL, after the deployment that needs it has served cleanly. Before Phase 1 lands on any branch, confirm Preview's `DATABASE_URL` is not production (unknown today); if it is, Preview builds would run Phase 1 against the family's database from an unreviewed branch.
- **DDL hygiene in `migrate.ts`.** `ADD CONSTRAINT` has no `IF NOT EXISTS`, so each one is guarded by a `pg_constraint` lookup. `CREATE INDEX CONCURRENTLY` can't run in a transaction and, if it fails, leaves an INVALID index that `IF NOT EXISTS` then skips forever, so each is followed by a `pg_index.indisvalid` check that drops and rebuilds an invalid one. Every `ALTER TABLE` runs with `SET LOCAL lock_timeout = '3s'` in the same Neon transaction batch (`sql.transaction([...])`, since each plain HTTP query is its own session) and is retried on timeout, so a queued lock never stalls the family's requests.
- **Every phase is a normal deploy**, and every phase but 3 can be undone with Vercel's instant rollback. Each phase's checks: `pnpm typecheck`, `pnpm lint`, `pnpm check:maple-feed`, `pnpm check:maple-care`, `pnpm check:maple-chat`, the new `pnpm check:maple-tenancy`, and `DATABASE_URL= pnpm build`.

### Phase 0: preconditions (no multi-family code yet)

Ships:
- The family's cutover to maplebaby.app; Maple removed from brooker-wedding (done on its main, `d6c767c`; confirm the Maple tools are gone from its calendar connector); `scripts/sync-from-brooker-wedding.sh` and `.brooker-wedding-sync` deleted (done).
- Maple-only secrets, in this order (each step deployed and checked before the next):
  1. Pin `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` to the keys in use today (docs/maple.md step 5), so no later secret change touches notifications.
  2. Copy the current `GOOGLE_CLIENT_SECRET` value into `MAPLE_SESSION_SECRET_PREV`, add a new `MAPLE_SESSION_SECRET`, and ship the open-with-either, seal-with-new code (2.5). Keep `_PREV` for 180 days. The code is in (`secret-box.ts`): what only `_PREV` opens may open family 1 only, and a sign-up intent never.
  3. Copy whatever signs MCP tokens today (the current `MCP_SECRET`, or `brooker-mcp:${ADMIN_PASS}`; which one is unknown) into `MCP_SECRET_PREV`, set a new Maple-only `MCP_SECRET`, and ship verify-with-either for 365 days. The code is in (`mcp/auth.ts`): the hard-coded fallback is gone (no key, no token), and a token only `MCP_SECRET_PREV` verifies opens family 1 only. `effectiveSignupMode` stays off until both Maple-only secrets are set (`secretBlockers`).
  4. Only then switch to Maple's own Google OAuth client, with both callbacks registered (2.5).
- The `migrate.ts` seed ("Maple Jane", female, 2026-10-20) deleted: production already has its baby row, and the seed would otherwise put the family's name, sex and due date into every empty branch, including the synthetic ones. `public/maple.webmanifest` made family-neutral.
- `MAPLE_READ_ONLY` across every write path (2.6 step 2).
- The Neon move (2.6).
- The synthetic two-family seed script and the schema-only branch.
- `check:maple-tenancy` in report-only mode (prints the roughly 145 statements and the 10 key-bound `ON CONFLICT` targets).

Verify: the cutover checklist in 2.6 step 7; after step 2, each phone opens the app without signing in again (the session fallback works); after step 3, an existing Claude connector still answers and refreshes (the MCP fallback works); Siri still answers; a test notification arrives after every step.

Rollback: env vars back to the old database and old secrets; the `_PREV` values keep every cookie and token opening either way.

### Phase 1: additive columns and backfill to the Brooker family

Ships (all in `migrate.ts`, idempotent, additive):
- `CREATE TABLE IF NOT EXISTS maple_families`; insert the Brooker family as id 1 when missing (timezone from the current `maple_babies` row).
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS family_id BIGINT DEFAULT 1` on 14 of the 16 `maple_*` family tables; `maple_push_sent` and `maple_ai_usage` get a nullable `family_id` with no default (1.1), so global push keys aren't filed under family 1. A nullable column with a constant default is a catalog-only change in Postgres 11+, so existing rows read as 1 at once and nothing is rewritten. The foreign key to `maple_families` is added separately as `NOT VALID`, then `VALIDATE CONSTRAINT`, so no table is locked while it's checked.
- `UPDATE … SET family_id = 1 WHERE family_id IS NULL` as a belt-and-braces backfill (on `maple_ai_usage` too; on `maple_push_sent` only for `miss:`/`gap:` rows).
- New leading-`family_id` indexes (`CREATE INDEX CONCURRENTLY IF NOT EXISTS`, each its own statement, checked for `indisvalid`); old indexes stay.
- **The expand half of every key change**, as new unique indexes next to the old keys: `(family_id, client_id) WHERE client_id IS NOT NULL` on `maple_entries` and the three care tables; `(family_id, email)` on `maple_members` and `maple_removed`; `(family_id, member, day)` on `maple_chat_daily`; `(family_id, endpoint)` on `maple_push_subs`; `(family_id, id)` on `maple_babies` (the composite FK needs it). With every row in family 1 they hold exactly when the old keys do, so they build cleanly and change nothing.
- Code: every insert passes `family_id` from a context that always says 1 in this phase.

**Why `DEFAULT 1` is safe here and only here:** while family 1 is the only family, a code path that forgets `family_id` still files the row correctly. The same default would be dangerous once a second family exists (a forgotten value would file another family's row under the Brookers), so Phase 3 removes it before sign-up can open, and Phase 4 refuses to open sign-up while any `family_id` column still has a default, or allows null outside the two exempt tables (a boot check reading `information_schema.columns`).

Verify: migrations twice on the schema-only branch; on production, per-table `COUNT(*) WHERE family_id IS NULL` is 0 and row counts unchanged; the app behaves exactly as before.

Rollback: nothing to undo. Old code ignores the new columns and table.

### Phase 2: scoped reads and writes, behind checks

Ships:
- `FamilyCtx` resolution in every entry point (2.4), every store function scoped, by-id statements with `AND family_id = $n`, `rev()` counting this family's members only, the push tick grouped by family (one family's baby, person, timezone and phones at a time), chat budgets and daily counts per family, export per family.
- **The switch half of every key change:** each of the 10 `ON CONFLICT` statements (1.2) names the new `family_id`-led index from Phase 1. That works against production (old and new keys both present; with one family they conflict on the same rows) and against the synthetic branch (new keys only).
- **Wakes per family.** `scheduleWake` claims `wake:${sec}` and publishes with `Upstash-Deduplication-Id: maple-wake-${sec}` (push-wake.ts:180-199), so two families' doses due in the same second (8:00 plus the slack, in one timezone) collide and the second family's wake is never published. Both become per family (`wake:<fam>:<sec>`, `maple-wake-<fam>-<sec>`), the wake is published with `?family=<id>` and ticks only that family. `scheduleWakeups` reads the caller's family's subscriptions, moments and timezone, not every phone and `babyTz()`. The poll-driven tick (`pushTickQuietly`) runs for the polling member's family only, with its 20-second gate keyed `tick:<fam>` (push.ts:506) and its in-memory gate per family. Only the 30-minute safety-net sweep stays global and walks every family.
- Session `fam`, MCP `fam`, Siri tokens by family, outbox items with `family_id`, all with the fallbacks in 2.5 so existing Brooker cookies, connectors and Shortcuts keep working untouched.
- A runtime guard: a row fetched by id whose `family_id` differs from the context answers `NotFound` and reports `new Error("cross_family")` with `{ route }` only.
- A shadow switch, `MAPLE_TENANCY=shadow|enforce`. In `shadow`, the hot reads (`listEntries`, `getEntry`, care lists, push subs, chat threads) also run unscoped and report a mismatch code (never content). This checks that `FamilyCtx` resolves correctly in production (a wrong family id over-filters and shows up as a mismatch). It can't catch a missed scope: while every row is family 1, a statement that forgot `family_id` returns exactly the unscoped rows and always matches. Missed scopes are caught by the AST check and by the two-family tests on the branch, where there is no default and a forgotten insert fails. After a clean period, `enforce`.
- `check:maple-tenancy` flips to failing the build.
- De-hardcoded copy can start in parallel here (section 6, chunk C): names from data, MCP text family-neutral, pronouns from `baby.sex`, WHO boys tables.

Verify on the schema-only branch with the two synthetic families:
- A family B member asking for family A's entry, photo, dose, invite, token, chat thread or export gets 404 (photo, entries, care, timer, push, chat, invites, tokens, export routes).
- MCP and the chat with a family B token can't list, log into, undo or delete family A's rows; `undo_last` never crosses families.
- A tick sends family A's reminders only to family A's phones, at family A's local times.
- Family A's chat spend doesn't count against family B's budget.
- Every insert path succeeds on the branch's final schema (no default, `NOT NULL`, new keys only), and fails with 23502 if `family_id` is removed from it (proves the test bites).
- Two families' doses due in the same second both get a wake, and each wake ticks only its own family.
- Then on production: shadow mismatches stay at 0 (`FamilyCtx` resolves to family 1 everywhere).

Rollback: `MAPLE_TENANCY=shadow` (or off) puts the unscoped reads back; Vercel rollback also works, because the schema is unchanged.

### Phase 3: `NOT NULL` and the contract half of the key changes

Ships (the first non-additive phase; brooker-wedding must already be gone, and Phase 2's deployment must have run cleanly in production, `enforce` included). **Not in `migrate.ts`:** a separate reviewed script, run by the owner over the unpooled URL, after the Phase 2 deployment is live, so no build ever applies it while older code is serving. The script refuses to run while `olderCopyActive()` (family.ts) is true: a `maple_push_sent` claim (`s…|…` or `wake:…`) without a family in the last 7 days means older code is still sending, and `maple_push_sent` stays nullable after this phase, so nothing else would stop it.
- For each table except `maple_push_sent` and `maple_ai_usage` (1.1): `ADD CONSTRAINT … CHECK (family_id IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT`, then `ALTER COLUMN family_id SET NOT NULL` (Postgres uses the validated check and skips the table scan), then drop the check. Then `DROP DEFAULT`.
- Drop the old keys that Phase 1's new indexes already shadow: the `maple_members` and `maple_removed` PKs move onto `(family_id, email)` (`ADD PRIMARY KEY USING INDEX`, after `NOT NULL`); `maple_chat_daily`'s onto `(family_id, member, day)`; `uniq_maple_entries_client` and the three care `client_id` indexes dropped; `maple_push_subs.endpoint`'s global `UNIQUE` dropped; `uniq_maple_care_people_one` replaced by `UNIQUE (family_id)`, and the care tables' FK on the person's name replaced by a FK on `family_id`; composite FK `maple_entries (family_id, baby_id) → maple_babies (family_id, id)` added `NOT VALID`, then validated.
- One transaction (Postgres DDL is transactional), with `lock_timeout` set.

Verify: the full script, then its reverse script, on the schema-only branch with synthetic data; `check:maple-tenancy` reports no `ON CONFLICT` target without `family_id` before the script runs; on production, the same counts as Phase 1 plus a write from each channel (app, Siri, Claude, chat).

Rollback: the tested reverse script (recreate the old keys, `DROP NOT NULL`, restore the default). **Deployments from before Phase 2 must not be rolled back to after this phase** (their `ON CONFLICT` targets name dropped keys, which Postgres rejects with 42P10, and their inserts lack `family_id`); write the cutoff deployment into `docs/maple.md` and the checklist.

### Phase 4: remove single-family code, open sign-up behind a switch

Ships:
- Deleted: `getBaby()`'s `ORDER BY id LIMIT 1`, `babyTz()`, `getCarePerson()`'s auto-create and `DEFAULT_CARE_PERSON`, the first-owner rule, `MAPLE_ALLOWED_EMAILS`, the unscoped code path and the shadow switch, `LEGACY_ORIGIN` once brooker.family no longer forwards sign-ins, the public Blob fallback, and (if agreed, and only after Phase 0's fail-closed `MCP_SECRET`) the admin login and `admin_as`.
- `MAPLE_SIGNUP=closed|invite|open` (default `closed`), the boot check from Phase 1, onboarding (section 4), `/terms` and `/privacy` (live since `caf1cf0`, written for one family) extended for other families, the consumer health data policy (section 5), per-family deletion and export, the support inbox.

Verify: a full synthetic sign-up, onboarding, invite, two phones, Siri, MCP connect, export and delete on the branch; the Brookers' daily use unchanged; `check:maple-tenancy` clean with an empty allowlist apart from global push keys.

Rollback: `MAPLE_SIGNUP=closed`. Families already created keep working.

---

## 4. Onboarding, modeled on Moku Coach

### 4.1 How Moku's chat onboarding works (tri-coach2 main, `679f081`)

Files read: `knowledge/features/onboarding.md`, `lib/ai/coach/onboarding-state.ts`, `lib/ai/coach/prepare/onboarding.ts`, `lib/ai/coach/prepare/prompts/static-onboarding.ts` and `dynamic-onboarding.ts`, `lib/ai/coach/tools/onboarding-widgets.ts`, `save-onboarding-data.ts`, `complete-onboarding.ts`, `lib/ai/coach/tools/index.ts`, `app/api/j/user/needs-onboarding/route.ts`, `lib/cron/jobs/onboarding-completion.ts`, `lib/api/notifications-email/onboarding-reminder.ts`, and the chat handler (`app/api/j/stream/chat/v2/handler.ts`).

- **One chat, two modes.** The chat's prepare step picks `mode: 'onboarding' | 'coaching'`. `needs_onboarding` is true exactly when the user has no `training_plan_context` row (the `users.onboarding_complete` flag is deliberately not consulted). The same streaming route, thread and UI serve both.
- **Prompt.** A fixed identity plus `ONBOARDING_INSTRUCTIONS` (static, cacheable): the 18+ age gate, tool usage rules ("write the acknowledgment before the tool call, never after"), the categories to cover, the order (integrations early, referral source last), "confirm a summary before completing", then how to build the first plan. A dynamic section is appended each turn: integration status, any synced training history, and "Collected Information (DO NOT RE-SAVE THIS DATA)" listing what's already saved. The welcome message is canned and already on screen, so the model never re-introduces itself.
- **Tools only in onboarding mode:** `ask_onboarding_question` (2 to 6 tap options, `allow_custom`, a `question_key`, a small `context` line saying why it's asked), `ask_numeric_input` (a bounded number box for a fixed set of keys; the prompt forbids bucketed ranges), `save_onboarding_data`, `prompt_strava_connection` / `prompt_integrations` (connect cards), `read_web_page` and web search (looks up a named race's date), then `createActivity`, `createPhase` and `complete_onboarding`.
- **How answers become data.** `save_onboarding_data(data_key, data_value)` takes any descriptive key and a string, infers integers and booleans, and upserts `onboarding_responses (user_id, key)`. It returns `items_collected` against a target of 16 for the progress bar. The age key is special: under 18 returns `ineligible_minor`, and the prompt tells the model to check for a typo, then stop warmly. `complete_onboarding` turns every saved key into a markdown "Athlete Profile" (the coach's memory), marks the user complete, turns on weekly plans and starts the 14-day trial in one transaction, and saves the first week's theme.
- **UI.** Each tool result renders as its own message type (question chips, number box, "saved" chip, connect cards, a completion card; `components/chat/message-list/message-types/onboarding-*.tsx`, 11 files with tests) with a progress bar.
- **Safety nets.** A cron completes users who answered at least 4 questions and have at least 3 planned workouts but never reached `complete_onboarding`; an email reminder can be scheduled for people who stop; an admin funnel report shows where people drop off.
- **What to copy and what not.** Copy the single chat, the tap-first widgets with a typed fallback, the "why we ask" line, the dynamic "already collected" block, the summary confirmation and the funnel. Don't copy the free-form key/value store: Moku can tolerate a loose `race_date` string; Maple can't, because the birth time drives every age-based rule, sex picks the growth chart, and the timezone decides what "today" is.

### 4.2 Maple's onboarding design

**Shape: a scripted spine with a chat voice.** The server owns the order and the required fields (a small state machine over `maple_families.onboarding`); every answer goes through a typed validator into real columns. The model only writes the friendly line before each question and turns free text into a field ("she came Tuesday around 3am"), and the parse is always shown back as a chip to confirm. If the model is unavailable (no Gateway credit, over budget, a provider error), the same screens run with fixed wording, so sign-up never depends on AI.

**Entry.** maplebaby.app → "Start your family's log" → Google sign-in (the native apps use the existing system-sheet flow), which for someone with no family yields the short-lived pending session or pending native ticket (2.5), not a member session → a short terms screen (tracker, not medical advice; 18+; US only; what the chat sends to an AI provider with zero retention) → the onboarding chat. A family row is created in `status: 'onboarding'` at the first saved answer.

**Where it shows (built).** Until "Start logging", the family's app is one page: the Chat page, in the Chat tab's frame (`chat/page.ts`: it fills what the phone can see, the composer sits at the bottom or on the keyboard, and the page stays pinned to the newest). The conversation comes first and the question's card (or the summary) last, as the newest thing on the page; the chat's composer goes into the page's bottom slot (`onboarding/SetupPage.tsx`). "Just the questions", or the chat being unavailable, leaves the same page with the card alone. Anyone but the owner who started it sees "Almost ready" instead.

Questions, in order:

| # | Question | Widget | Stored as | Required? |
|---|---|---|---|---|
| 1 | Your first name, and what the baby calls you | text (prefilled from Google) + chips (Mom, Dad, Mama, Papa, Other) | `maple_members.display_name`, `maple_members.role_word` (a new nullable column) | name required |
| 2 | Is the baby here yet? | chips: Born / Still waiting | branch | yes |
| 3 | Baby's name (or "We haven't picked yet") | text | `maple_babies.name`, `nickname` | no: "Baby" until set |
| 4 | Birth date and time, or due date | date + time pickers (never typed dates); "about" toggle for the time | `born_at` or `due_date` | one of them required |
| 5 | Sex, for the WHO growth chart | chips: Girl / Boy / Skip | `maple_babies.sex` (`female`/`male`/null) | no: no percentiles until set; pronouns default to the name |
| 6 | Born early? | chips: Full term / Early (weeks) | `settings.gestation_weeks` | no; earlier than 37 weeks shows "Maple's guidance is written for full-term babies; follow your pediatrician's plan" |
| 7 | Birth weight (optional) | number box in lb/oz or kg | `birth_weight_g` | no |
| 8 | How is feeding going? | multi-select chips: Nursing / Pumping / Formula / Mixed | `settings.feeds_bottle`, `track_pump`, nursing on Today | no: all on |
| 9 | Your timezone, and units | timezone prefilled from the browser's `Intl` zone, one-tap confirm, searchable list; units as chips (US: lb, oz, °F / Metric: kg, °C), prefilled from the locale | `maple_families.timezone`, `maple_families.units` (the per-device `maple-units` localStorage key becomes a device override of the family default) | timezone yes; units default `us` |
| 10 | Who else should join? | invite cards: email (Google) or a one-time link; role chips (can log / view only) | `maple_invites` | no |
| 11 | A page for the birth parent's recovery? | explainer card, then Yes / Not now; on Yes, whose page (a member, or a name) and that person's own consent screen (section 5.3) | `maple_care_people` row created only on Yes | no: off |
| 12 | Pediatrician | name + phone (+ after-hours number) | existing `settings` doctor fields | no |
| 13 | Notifications | the existing Notifications sheet (on the web, Home Screen steps first on iPhone) | `maple_push_subs` | no |
| 14 | How did you hear about Maple? | chips | `maple_families.settings.referral` | no, asked last (Moku's rule) |
| 15 | Summary | one card listing every answer with Edit links, then "Start logging" | `status: 'active'` | confirm required |

Structured vs free text:
- Structured, with validators: everything in the table except two fields. Dates and times only from pickers; numbers only from bounded boxes; enums only from chips.
- Free text: names, and the pediatrician's name. Never stored as free text: sex, dates, timezone, feeding.
- The model's free-text parses become a proposed value shown as a confirm chip; nothing is saved from model output without a tap.

If they skip:
- Only #1, #2, #4 and #9 block "Start logging" (without a birth or due date the app can't count days, and without a timezone it can't say "today").
- Everything else can be skipped and lives on as a quiet "Finish setting up" row in Family (Moku's "connect later in Settings"), never as a Today banner.
- Someone who leaves mid-way resumes at the next unanswered question (state in `maple_families.onboarding`). An abandoned family in `status: 'onboarding'` with no entries is deleted after 30 days, with a reminder email at day 2 if they opted in. That email, invites by email, deletion confirmations and breach notices all need a transactional email processor, which the repo doesn't have (no provider in `package.json`); choosing one is Chunk F work, and it joins the processor list (5.5).
- Invited members never see onboarding: an invite lands straight in the family's Today with a two-screen welcome (your name, notifications).

Tools (onboarding mode of the existing chat route, `src/lib/maple/chat/`):
- `ask_choice`, `ask_date_time`, `ask_number`, `invite_people`, `propose_value(field, value)` (renders the confirm chip), `finish_onboarding` (only after the summary is confirmed). `field` is a fixed enum matching the table, never a free key.
- The Maple logging tools aren't offered during onboarding. The crisis check, ZDR/no-training options and the micro-dollar usage rows apply unchanged.

**Cost per onboarding** (`zai/glm-5.3-flash` per the brief: $0.15 per million input tokens, $0.50 output, $0.03 cached input):
- About 15 turns, 1 to 2 steps each, a 4K-token onboarding prefix (the onboarding tools only, not the 36 logging tools) growing to about 10K by the summary, about 150 output tokens per step.
- Uncached: about 15 × 1.5 × (8K × $0.15/M + 150 × $0.50/M) ≈ $0.03. With the prefix cached, about $0.01.
- Under 3 cents a family (moderate: the onboarding prefix is unmeasured; the logging-tools prefix measured 20.6K tokens, so the onboarding one should be well under it). On Haiku 5.5 prices the figure is about the same.
- Cap: one onboarding per account, 40 model steps per onboarding, then the scripted path takes over.

---

## 5. Product, legal and cost

Not legal advice. This is a solo developer's action list; have a lawyer read `/privacy` and `/terms` once before opening sign-up. Confidence is marked where it matters.

### 5.1 Per-family AI caps; are paid plans needed?

- Move today's env budgets into per-family columns (`maple_families.ai_daily_micro`, `ai_monthly_micro`, BigInt micro-dollars) with plan defaults. Decided 2026-10-27: $0.50 a day and $5 a month per family (`FAMILY_DAILY_BUDGET_DEFAULT` / `FAMILY_MONTHLY_BUDGET_DEFAULT`), the same as the Brookers' $0.50 / $5, and above the engaged-family estimate below, so a family using the chat every day doesn't hit the cap mid-month. Twenty-five beta families at the cap would be $125 a month; the $25 global ceiling below bounds it.
- Keep a **global** ceiling too (`MAPLE_CHAT_GLOBAL_MONTHLY_MICRO`) plus the Gateway's own project budget in the dashboard, so a bug can't spend past it.
- Expected spend on `zai/glm-5.3-flash`, now partly measured: a synthetic smoke test (scratchpad `smoke-glm.log`, made-up data, ZDR options on) sent a 20.6K-token prefix; a cold step cost $0.0031, a step reading the cache about $0.0008, so a 2-step message is about $0.0039 cold and $0.0015 warm. Chat messages minutes apart will often miss the provider's short-lived cache. An engaged family at 10 messages a day is about $0.45 (all warm) to $1.20 (all cold) a month at 2 steps a message, and up to about $3.30 with 3 steps and long threads (moderate: two turns measured, no real usage yet). Infrastructure per family is cents (2.6).
- **Paid plans aren't needed for the beta.** Logging, Siri, notifications and MCP cost almost nothing per family; the chat is the only real variable cost and the caps bound it. Decide on a paid "Plus" (the chat beyond the free cap, more members, photo storage) after measuring real cost per family for a while. If charging, Vercel Pro is already required, the payment provider needs a business, and App Store rules apply to in-app purchases of digital features (Apple takes a cut; pricing the web plan separately is allowed in the US after the 2025 court rulings, moderate).
- **Gateway credit.** On the free tier every model answered 403. The Move checklist marks "Add AI Gateway credit to the guava-tri team" done on 2026-10-26, and the smoke test above got priced answers, so the 403 is gone. To add more (Vercel docs, AI Gateway pricing, updated 2026-09-08, checked 2026-10-26): Vercel dashboard, team **guava-tri** → AI Gateway → the button showing the credit balance (top right) → pick an amount → **Continue to Payment** → choose the payment method → **Confirm and Pay**. Auto top-up is in the same dialog (**Change** → threshold and amount → **Save**); it is off by default, and leaving it off keeps a bug from refilling itself.
  - **What buying did to the team:** guava-tri is Moku's business team, so the purchase moved the whole team, Moku included, to the paid tier, and the monthly free credit no longer applies to either app. Maple's spend and any future Moku Gateway spend draw from one prepaid balance (Moku makes no Gateway calls today, moderate). Purchased credits expire one year after purchase (Vercel AI Gateway FAQ, updated 2026-09-13).
  - **Right after any top-up, set a budget:** AI Gateway → Budgets → the `maple` project, $10 monthly, alerts at 50, 75 and 100% (the checklist's "Set a $10/month AI Gateway budget" row, still open). The installed Vercel CLI has no budgets command, so this is a dashboard step. A Maple-only Vercel team (decision 1) would also separate Maple's balance and budget from Moku's.

### 5.2 Abuse and spam

- Sign-up switch `MAPLE_SIGNUP=closed|invite|open`; beta through invite codes (one code makes one family).
- Google accounts only for owners (verified email), one family created per Google account per day, and a cap on open onboarding families per IP (reuse `upload_rate_limit`'s hashed-IP counter in a new table).
- Invites: at most 10 open invites per family, links expire (they do: `expires_at`), email invites only to addresses the inviter typed, and an email invite is pending until that person signs in with that address and accepts (2.3); nothing about a family shows in anyone's switcher before that.
- Uploads: the existing per-IP token cap, plus a per-family photo count and byte quota (Blob is billed per GB).
- MCP dynamic client registration (`/oauth/register`) is stateless today; rate-limit it per IP.
- The chat already fails closed on caps; add a per-family "chat paused" switch for the operator.
- No public pages show family content, so spam has nowhere to land except invites and names.

### 5.3 Mom's care page for other families

- Off by default; offered once in onboarding and in Family.
- The care person turns it on themselves, signed in as themselves (or, for someone without an account, an owner with a consent screen they read together), and that consent is stored (`maple_care_people.settings.consent = { at, by, version }`). This matches the brief's rule that her medicines and temperatures reach the chat only after she consents.
- **Who in the family sees her page is her choice.** Today every non-viewer member reads and writes all of it, check-ins included (`careAccess`, care.ts:93-99), and `shared_with` is ignored; that is the Brookers' own decision and stays for family 1 unless Brittany changes it. For other families: the care person is tied to a member id (not a name, so "signed in as themselves" has something to attach to), `shared_with` is enforced, and the default is her plus the owners she picks. A grandparent or nanny added as "can log" sees nothing of it unless she adds them.
- **Recommended: leave the PHQ-9 / GAD-7 check-ins out for other families at launch.** They are the most sensitive data the app holds (mental health status), the crisis sheet implies a duty of care Maple can't staff, and they add little to "is her Tylenol OK yet?". Medicines, temperature, OB questions and the help lines stay.

### 5.4 Support inbox

- One address, `hello@maplebaby.app` (already the contact on the live `/terms`, `/privacy` and waitlist; per the checklist nothing receives its mail yet), on an inbox only Matt reads, linked from Family → Help and the privacy pages. It's the published contact for privacy requests and breach notices.
- The operator never browses a family's data. A support case gets a time-boxed "let support see my log" grant the owner turns on in Family, logged, ending on its own after 72 hours. Without it, support sees only counts (members, entries, last activity).

### 5.5 FTC Health Breach Notification Rule

- **Is Maple covered?** Very likely (moderate-to-high). Maple is not under HIPAA (no doctor or insurer is involved), and the FTC's 2024 amendments make clear that a health app that takes user input and can draw information from more than one source counts as a vendor of personal health records. Maple takes entries from several people, from photos, Siri, Claude and ChatGPT. Treat it as covered.
- **What a "breach" is:** any unauthorized acquisition of identifiable health information, including Maple itself sharing it without the user's authorization (an analytics or ad SDK with health events would count). Encrypted data that stays encrypted generally doesn't count.
- **What to do if one happens:** notify each affected person without unreasonable delay and within 60 days of discovery, by email plus an in-app banner or message (first-class mail must be offered); notify the FTC on its online form at the same time if 500 or more people are affected, otherwise within 60 days after the year ends; notify prominent media if 500 or more residents of one state are affected. Penalty: up to $53,088 per violation (FTC business guidance).
- **What to do now:** keep the no-analytics, no-replay rule (already in CLAUDE.md) and add a written list of every processor that touches family data (Vercel, Neon, Vercel Blob, Upstash QStash, the AI Gateway and its ZDR providers, Google sign-in, PostHog error reports with no content, the push services, and the transactional email processor once chosen); a one-page incident runbook (who decides, the notice template, the FTC form link); an "access log" of operator grants (5.4).

### 5.6 State health-privacy laws (Washington's My Health My Data Act and its cousins)

- **Washington MHMDA (RCW 19.373).** No revenue threshold; it covers anyone offering a service to Washington consumers that collects "consumer health data" (any physical or mental health status, medicine use included). Maple's baby and mom data both qualify. Enforced by the Attorney General and through private lawsuits under the Consumer Protection Act. Nevada (SB 370) and Connecticut (consumer health data amendments) have similar rules.
- What a solo developer can do (moderate on statutory details; check the Act's sections 4 to 9):
  - A separate **Consumer Health Data Privacy Policy** page, linked prominently from the homepage on its own (not just inside `/privacy`): what's collected, why, where it comes from, who it's shared with, and how to exercise rights.
  - **Consent to collect**, separate from the terms, for anything beyond what's needed to run the tracker the user asked for; and separate consent for sharing. The AI chat is the case to think about: sending data to the AI provider is sharing with a processor, so the chat stays off until each member accepts its own short consent (the brief already requires accepted terms before the chat).
  - Never sell data; no ads; no geofencing (Maple has none).
  - **Rights**: access (including the list of processors), deletion (including backups: Neon's restore history ages out in 6 hours on Free or 7 days on Launch, which helps), withdrawal of consent. Answer within 45 days. Build them as buttons (5.8), not email threads.
- Under-18 users: require 18+ in the terms and onboarding, as Moku does. COPPA is about collecting from children under 13; parents logging about their own baby is very likely outside it (moderate).

### 5.7 App Store and Google Play

- **Demo account (Apple 2.1).** Review needs a working sign-in. Make a "Review family" with synthetic data and a password login that opens only that family (a per-family demo credential, never the Brooker admin login). Put it in App Review notes and expire it after review.
- **Sign in with Apple (4.8).** An app that offers Google sign-in must also offer an equally private option; Sign in with Apple is the usual answer. Plan it with the native sign-in work (moderate on whether Apple applies it to a web-view app, but expect it).
- **Minimum functionality (4.2).** A thin web-view wrapper is a common rejection. Native push, the Live Activity and App Intents/Siri (already planned in docs/mobile.md) are what make the case.
- **Account deletion (5.1.1(v)).** Required in the app when the app lets people create accounts.
- **Highly regulated fields (5.1.1(ix)).** Apple asks that apps in healthcare be submitted by a legal entity rather than an individual. A baby tracker may or may not be read that way (low-to-moderate); an LLC with a D-U-N-S number removes the question and also limits personal liability.
- **Bundle id.** Already `app.maplebaby` (commit `4715ad3`), which stands apart from the family and is permanent once released.
- **Google Play.** New personal developer accounts must run a closed test with at least 12 testers for 14 days before production (organization accounts are exempt); the Health apps declaration and Data safety form are required; account deletion needs a web link as well as the in-app path.

### 5.8 Deletion and export

- **Export (owner, any time):** one ZIP with the log as CSV and JSON (every entry, including deleted ones still in Recently removed), the care page as its own file only when the reader can see it, the members list, and the photos. Generated on demand and streamed, never stored. Today's `/api/maple/export` covers the entries CSV only.
- **Leave a family (member):** removes their membership, sessions, tokens, push subscriptions and chat threads in that family. Their past entries stay, credited as "a former member".
- **Delete a family (owner):** a typed confirmation, then `status: 'deleting'` (everyone signed out, nothing visible) for 7 days so a mistake can be undone, then a hard delete of every `maple_*` row with that `family_id`, the `maple/f<id>/` blobs, QStash wakes (they find nothing), and usage rows kept for cost tracking with `family_id` set to null (why `maple_ai_usage` is exempt from `NOT NULL`). Send a confirmation email. Restore history ages out on its own.
- **Delete my account:** leave every family; a family with no owner left either gets a new owner (another member) or is deleted with the same 7-day wait.

---

## 6. Effort, dependencies and decisions

### 6.1 Work chunks (relative size, in dependency order)

| Chunk | What | Size | Depends on | Notes |
|---|---|---|---|---|
| A | Phase 0: cutover finished, Maple out of brooker-wedding, Maple-only secrets in order (VAPID pinned, session and MCP fallbacks, fail-closed `MCP_SECRET`, then the Google client), seed and manifest de-named, `MAPLE_READ_ONLY` on every write path, own Neon project, synthetic two-family seed, report-only AST tenancy check | Medium | the family's cutover | Mostly owner steps and glue; the Neon move is the risky step and gets a rehearsal. |
| B1 | Phase 1: `maple_families`, `family_id` with `DEFAULT 1` (not on push_sent or ai_usage), backfill, indexes, the new unique keys beside the old | Small | A, Preview's `DATABASE_URL` confirmed | Additive only; guarded constraints, `indisvalid`, `lock_timeout`. |
| B2 | Phase 2: `FamilyCtx`, about 145 statements scoped, the 10 `ON CONFLICT` targets switched, by-id guards, `rev()`, push tick, wake keys and QStash dedup ids per family, chat budgets per family, session/MCP/Siri/outbox carriers, shadow switch, enforcing check, cross-family tests | Large | B1 | The heart of the work. Mechanical per statement, but touches every route; the push tick and MCP auth need the most care. |
| B3 | Phase 3: `NOT NULL`, old keys dropped, per-family FKs, reverse script | Small | B2 clean in production | First non-additive step; an out-of-band script, never `migrate.ts`. |
| C | De-hardcoded copy: names from data, family-neutral MCP and chat prompts (one shared cache), pronouns from `baby.sex` across about 480 lines, WHO boys tables in `growth.ts`, US-only framing, premature-baby note | Large (larger than B2) | A (no database needed), can run beside B | Split by surface: guidelines.ts, MCP and Siri text, components. Medical wording changes need the same source checks guidelines.ts already has. |
| D | Phase 4: remove single-family code, sign-up switch, boot check | Small | B3, C | |
| E | Onboarding: state machine, typed tools, chat-mode switch, scripted fallback, invites, summary, abandoned-family cleanup, funnel counts | Medium | B2, C (names and pronouns) | Reuses the chat route, sheet and caps. |
| F | Legal and trust: terms, privacy, consumer health data policy, consent records (chat, care page), care-page sharing enforced, pending email invites, a transactional email processor, export ZIP, leave/delete flows, support inbox and access grants, processor list, incident runbook | Medium | B2 | Lawyer review before opening sign-up. |
| G | Store readiness: LLC and developer accounts, bundle id, Sign in with Apple, review family and demo login, native push, Play closed test | Large | F, decision 5 | Native push is planned in docs/mobile.md already. |
| H | Twin mode (baby picker on every log, tandem feeds, per-baby notices) | Large | E shipped | After launch, if families ask. |

Shippable order: A → B1 → (B2 and C side by side) → B3 → D + E + F → invite-only beta → G → open sign-up. The family's daily use never waits on any of it.

### 6.2 The five decisions the family must make

1. **Give Maple its own infrastructure before anyone else joins?**
   - The choice: its own Neon project (now), its own Google OAuth client and secrets, and either its own Vercel Pro team or a guava-tri team limited to people allowed to see family health data.
   - Tradeoff: setup work and, at open sign-up, about $19 to $39 a month for Neon Launch (plus $20 a month for a separate Vercel Pro seat if you split teams), against other families' data living in a wedding site's database that Moku's team can read.
   - **Recommendation: yes, all of it, in Phase 0.** Neon Free covers the beta; switch to Launch at open sign-up.
2. **Who can sign up, and when?**
   - Options: invite-only beta of friend families → open; or open from day one.
   - Tradeoff: an invite-only beta finds the cross-family bugs with people who will forgive them, and keeps support and AI spend small; open gets growth sooner.
   - **Recommendation: invite-only, US only, 18 and over, with 10 to 25 families, then open.** US only because the help lines (911, 988, the maternal hotline), units and AAP/CDC guidance are American.
3. **Does mom's page come with Maple for other families?**
   - Options: not at all; opt-in without the mental-health check-ins; opt-in with everything.
   - Tradeoff: it's Maple's most distinctive feature, and its most sensitive data (prescription medicines, PHQ-9/GAD-7, crisis flows) under the FTC rule and Washington's law.
   - **Recommendation: opt-in, consented by the care person herself; medicines, temperature, OB questions and help lines; PHQ-9/GAD-7 check-ins left out for other families at launch.**
4. **One baby, or twins and siblings, at launch?**
   - Tradeoff: twins are about 3% of births and need a large UI phase; one baby ships far sooner.
   - **Recommendation: schema ready for several babies now; one active baby per family at launch; twin mode after launch if families ask.**
5. **Free, or paid, and under whose name?**
   - Options: free beta with per-family AI caps; a paid Plus plan for the chat; and whether to form an LLC.
   - Tradeoff: charging needs a business, payments and App Store rules; staying free means Matt pays the AI and hosting bill (small with caps). An LLC costs a filing fee and paperwork, but Apple may expect a legal entity for a health app, Google exempts organizations from the 12-tester closed test, and it separates personal liability from a health-data product.
   - **Recommendation: free invite-only beta with caps ($4 a month of AI per family), no ads ever, form an LLC before the App Store submission, and decide on a paid plan after measuring real cost per family.**

### 6.3 Open questions

- Decided 2026-10-27 (Matt): anyone can sign up (MAPLE_SIGNUP=open on the web once the Phase 0 gates are done; iPhone sign-up waits for Sign in with Apple). Free beta to gather feedback, no billing yet. Chat cap $5 a month and $0.50 a day per family, $25 a month across every family but the Brookers.
- Decided 2026-10-27: "Maple" is the public brand. Copy says each family's own baby's name; the app name stays.
- Whether `guava-tri` is on Vercel Pro today (needed for ZDR), and who is on that team. (unknown)
- This month's compute hours for the shared database. Per the checklist, it is the Neon store named brooker-wedding in Matt's personal Vercel account, on Neon Free (not re-checked here). (unknown)
- Whether Preview deployments' `DATABASE_URL` is the production database; every Preview build runs `migrate.ts`. (unknown; blocks Phase 1)
- Whether `MCP_SECRET` is set in production today, which decides what goes into `MCP_SECRET_PREV` (Phase 0 step 3). (unknown)
- Decided 2026-10-27: Resend (Vercel Marketplace) sends transactional email from maplebaby.app. `hello@maplebaby.app` already forwards through Forward Email.
- Real cost per family: a synthetic smoke test measured a 20.6K-token prefix and $0.0015 to $0.0039 per 2-step message (5.1); real usage over a few weeks is still needed. (moderate)
- Whether `zai/glm-5.3-flash` routes to a ZDR provider for every request (the listing says "some"); if a ZDR request fails rather than falls back, the chat says it's unavailable, which is the safe outcome but needs one live check. The synthetic smoke test with ZDR on succeeded twice; that shows a ZDR provider exists, not that every request finds one. (moderate)
- Sign in with Apple (likely required by guideline 4.8 once the iOS app lets people create an account with Google) is deferred until before sign-up opens on iPhone (decided 2026-10-27). Still open: will Apple read a baby tracker as "healthcare" under 5.1.1(ix)? (low-to-moderate)

### 6.4 How these numbers were checked

- Maple: local checkout `/Users/matthewbrooker/dev/maple` at `8455bb8`, equal to GitHub main (checked with `gh api`); the review fixes were checked against GitHub main `caf1cf0` (fetched and fast-forwarded, no local changes). Line numbers in `src/lib/maple/` are the same at both.
- SQL inventory: `scratchpad/mf-tools/sql_sites.py` (table references: 183 in 11 files) and `sql_scope.py` (156 statements outside migrations; 11 scoped by `baby_id`; 145 unscoped). Copy counts from `grep` with comment lines excluded.
- brooker-wedding: GitHub main (`ded342f`, after `d6c767c` "Move Maple's Log out"): no `src/lib/maple`, no `maple_` statements in `migrate.ts` (only `upload_rate_limit`). Production's newest deployment was created 6 seconds after `ded342f` (2026-10-27 03:10 EDT).
- Moku: tri-coach2 main (`679f081`) via `gh api` contents; copies in `scratchpad/mf-tools/moku-src/`.
- Prices and limits fetched 2026-10-26: Neon pricing page; Vercel AI Gateway pricing docs (updated 2026-09-08); Upstash QStash pricing (Free: 1,000 messages a day, 7-day max delay, 10 schedules; then $1 per 100K messages; Maple's wakes fit Free for dozens of families); FTC "Complying with FTC's Health Breach Notification Rule"; Washington AG's MHMDA page.
- AI Gateway top-up steps: Vercel docs "AI Gateway Pricing" (updated 2026-09-08) and "AI Gateway FAQ" (updated 2026-09-13), fetched 2026-10-26. Chat cost: `scratchpad/smoke-glm.log` (a synthetic run by another agent, made-up data, ZDR options from `chatProviderOptions()`).
- No database was connected to, no model was called while writing this plan, and no real family data was read or sent anywhere.
