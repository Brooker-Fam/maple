# Maple's Log (`/maple`)

A private, collaborative newborn tracker for Maple Jane: nursing (left/right timers), bottles, pumping, diapers with stool colors, sleep, tummy time, baths, temperature, vitals and skin checks, growth with WHO percentiles, notes and questions for the doctor, photos and milestones. Matt and Brittany (and anyone they invite) log from their phones, from Claude or ChatGPT (MCP), or hands-free with Siri. A separate area "for mom" keeps her own medicines, temperature, questions for her OB and check-ins, with warning signs and help lines (see [For mom](#for-mom)).

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

Actions: `pee`, `poop`, `both`, `nurse_left`, `nurse_right`, `switch`, `stop`, `sleep`, `wake`, `vitamin_d`, `bottle` (with `amount_oz`), `status`, and mom's `mom_status` and `mom_dose` (see [For mom](#for-mom)).

`nurse_left` / `nurse_right` during a running feed switch to (or resume on) that side, unless the feed looks forgotten (`staleFeed` in `feed.ts`, the same rule as MCP `start_timer`): nothing tapped on it for an hour, or (with a start time given, on a break) a time over 30 minutes after she came off. It's judged by the newest stretch start/end or tap, not the feed start, so a long cluster feed tapped a minute ago still resumes, and so does one she dozed off for half an hour. A stale one is refused out loud ("Stop that one first, then start the new feed").

## How it works

- **Data** lives in `maple_entries`: one row per event, with `kind` plus JSONB `data` in metric units (g, cm, °C, ml). The UI shows lb/oz, in, °F and fl oz by default.
  - Running timers are rows with `active = TRUE`. A unique index allows one running timer per kind.
  - `client_id` makes retries idempotent.
  - Deletes are soft deletes, so they can be undone.
- **Shared logic** in `src/lib/maple/` is pure TypeScript, used by the browser, the REST routes and the MCP tools alike:
  - `types.ts` holds the shapes.
  - `time.ts` holds time-zone and DST-safe helpers, plus `parseWhen` for times like "3:10am", "20 min ago" and "yesterday 11pm".
  - `feed.ts` is the nursing engine, shared by the server, the app's optimistic updates and previews, and the MCP tools (checked by `npm run check:maple-feed`). A feed is a list of stretches (`{side, start, end}`); the gaps between them are breaks. `feedParts` turns that into what the card and sheets list (Left, Break, Right…), and every fix moves exactly one **moment**: the feed start, a switch, when she came off, when she went back on, or the end (`moveEdge`, with `edgeBounds` for the limits). `setSide` fixes which side a part was, `undoLastTap` takes back a mistaken switch/pause/resume, and `addPart` adds a side to a finished feed. Nothing moves a neighbouring side as a side effect, and a fix never eats past a break.
  - A Switch tapped within 15 s of a tapped resume (one that made its own part) changes the side she went back on instead of adding a second-long part (`resided`; the break stays, and undo still goes back to paused): "Back on the Left, not the Right". A resume given an earlier time is a real part, so a Switch after it is a switch. Switching back within 15 s of a switch still undoes that switch (`reverted`).
  - Words: after a break it's "back on the Right" only when she came off the Right; otherwise "On the Right" / "When did she go on the Right?" (`momentQuestion(moment, side, prev)`).
  - Also: the next-side rule (offer the opposite of the side the last feed started on).
- **The nursing screen:** the timer card only shows what happened, as labelled rows ("Left 4:00–4:10 · 10 min", "Break · 15 min", "Right side · since 4:25"), with the time on the current side as the big number and "Total nursing · break not counted" beside it. The dock is the only place with timer actions (Switch / Pause / Done / More, one meaning per column). Paused, column 1 is the other side ("Next side", where Switch was) and column 2 the side she came off ("Resume", where Pause was), so Pause and Resume toggle in one spot and a second Pause tap merges back with no break. The night Lantern holds the same actions in the same order (Switch, Pause, Done; paused: Next side, Resume, Done). Timer toasts wait while any sheet is open, and other toasts draw inside the sheet above its footer, so nothing covers a sheet's buttons.
  - "Total nursing" is whole clock minutes, the rows' rule (each side row's minutes plus the live side's), so it never jumps at a Switch or Pause and equals the Done toast; the big number is the current side's own m:ss.
  - Forgot to stop: once a side is past its "Still nursing?" check, the dock's Done says "when?" and opens "When did she finish?" ("Now" first) instead of ending it now; the Lantern asks the same. Snoozes ("Still going") are kept per part (a side or a break), so muting one never mutes the next.
  - After this phone's own tap, column 1 stays off for 2.5 s (column 2, 1.2 s), so a late double tap can't land on the tile that replaced it; a Switch within 15 s of the same person's resume fixes that resume's side instead (`resided`). Discard asks first once a timer has run 2 minutes.
  - A paused feed nobody came back to for over an hour is stale (Siri's rule, judged by its newest tap that wasn't taken back): the dock's and the Lantern's side buttons say "New feed", ending it at its pause and starting a new one in one toast (Undo brings the old one back paused), and the card's "Still on a break?" leads with "She's done" ("Same feed, back on…" second).
  - "Same feed as 8:30" (the start toast, and Fix times on a one-side feed started within 30 min of a timed feed ending) is one request, `join`: the new feed is set aside (`joined_into`, so Recently removed doesn't offer it back) and the old one carried on from its start; a Done tapped within a minute of the new start leaves no break. A Continue's resume is marked `carried`, so Fix times doesn't offer an undo_tap that would leave it paused (its toast's Undo restores the Done).
  - Done past "Still nursing?" opens Fix times as "Done" (`fixPreset("current", "done")`): "Now" first, hours for a side left on for hours, "likely" exactly 15 min on the side; if the other phone ends or switches the feed meanwhile, it asks about the side she's on now, or says it ended.
  - Done records `stopped_at` (when it was tapped), so a Done that set an earlier end isn't read as an edit; the sheet says "edited" only for a later fix, "ended by Brittany" when someone else's last write was their Done.
  - A breast feed with no minutes can't be logged by hand ("Add how long she nursed"). After every tap a toast offers "2 / 5 min earlier" for that tap alone, and **Fix times** (the card button, or any row) opens `sheets/FixTimesSheet.tsx`, which starts on the right question ("Was she on the Right before you tapped?").
  - Timer writes go through `mutateTimer` in `store.ts`: read, apply the intent with the engine, write only if the row is unchanged, retry up to 3 times. Two phones' changes merge instead of overwriting.
  - REST: `POST /api/maple/timer` with `action: "retime"` and an `edit` (`move`, `set_side`, `undo_tap`, `add_part`, `restore`); switch/resume/pause/stop take an optional `at`. Every fix response carries `before` (with `paused_at_stop` when the feed had ended at its pause), which the toast's "Back to …" restores exactly.
  - **Carrying a finished feed on is one write.** `reopen` takes an optional `side` (+ `at`) and `expect_updated_at` (`reopenTimerDetailed` in `store.ts`): ended at its pause, she goes back on that side at `at` (default now), a resume after the break with the resume's rules; ended while running, with no `at` (the dock's stale Switch), the side she was on runs to the Done and she switches there (the same side just runs on); with an `at` after the Done ("Same feed as 8:30", from the new feed's start), she came off at the Done and goes back on at `at`, so the gap is a break. Changed since this phone looked: 409 `changed`, nothing written. The answer carries `before` (the finished feed). The client's `continueFeed(e, side, at?)` uses it for the dock's "Continue that feed on Right", Fix times' "Continue it on Right" and the start toast's "Same feed as 8:30"; the toast says where she is and that "the 8:10 feed goes on", and its Undo is one checked `restore` back to the finished feed.
  - `restore` with a non-null `ended_at` on a feed that's running again finishes it there (keeping `paused_at_stop: true`), so undoing a Continue puts back the other phone's Done exactly.
  - `add_part` (`{ side, start, end, expect_updated_at }`) adds a side to a finished feed (`addPart`): `ended_at` moves to its end and `paused_at_stop` clears; changed or reopened since, 409 `changed`.
  - Errors: a fix that doesn't fit the feed is 400 `{ error, code }`; losing to the other phone is 409 `{ reason: "changed" | "stopped" | "clash", entry }`; a timer or entry someone discarded is 404 `{ reason: "discarded", deleted_by }` (timer actions and `PATCH` / `DELETE /api/maple/entries`), so the app can say who ("Brittany discarded this feed, so your note wasn't saved.") and drop it from the screen.
  - `data.last_tap` records the newest switch/pause/resume, so `undo_tap` takes back exactly that tap and nothing older. `undoableTap` tells the sheet whether to offer "Tapped Switch by mistake?" / "Didn't mean to pause?" (only for a tap made in the last 10 minutes that undo would really take back).
  - A resume is asked of a feed seen paused. If the other phone resumed it meanwhile on the other side, it's 409 `changed`, with or without `at`, never a silent switch over their resume; the dock's toast then says where she is ("Brittany already put her back on the Left at 5:46") with a "Switch to Right" button. On that same side it's a noop, or with an earlier `at` it moves when she went back on (`moved: true`; "Back to 4:17" puts it back).
  - The start toast's "2 / 5 min earlier" chips stop at the previous feed's end (`previousFeedEnd`), as Fix times' do; the last one becomes "Since the last feed".
  - Done on a paused feed: the toast's "She went back on…" opens Fix times on the *finished* feed with the Done tap time (`fixPreset("current", "backOn", doneAt)`); nothing is reopened to ask, so a phone locked mid-question leaves the Done as it was. The answer is one write (`backOnAfterDone(e, side, from, until)`): a side until the Done tap is `add_part` ("Right 5:54 – 6:04 · ended 6:04"); "She's still on" (`until` null) is `reopen` with that side from `from` ("Back on the Right since 5:54 · still going"). Either Undo puts back the feed as Done left it, ended at its pause.
  - A feed started within 10 minutes of the last one ending (a Done by mistake, or the other phone's Done) offers "Same feed as 8:30" on its start toast: the new feed is discarded (only as it was started) and the old one carried on from the new start on that side; if that fails, the new one comes back.
  - `discard`, `stop` and `PATCH /api/maple/entries` take `expect_updated_at`: changed since, 409 and nothing is thrown away (the start toast's Undo can't discard a feed the other phone has added to).
  - **Done while paused ends the feed when you paused** (flag `paused_at_stop`; Undo brings it back paused).
  - A same-side resume within a minute of the pause merges with no break, and its toast says why ("Back on the Left · paused under a minute, so no break").
  - MCP: `reopen_timer` takes an optional `side` (+ `at` / `minutes_ago`), the same one write as the app's Continue, and replies with an undo token; `switch_side`, `pause_nursing` and `stop_timer` take `minutes_ago` / `at`; `fix_nursing_time` moves one moment, fixes a side or undoes the latest tap, and replies with a signed undo token. `start_timer` during a running feed acts as `switch_side`, unless the feed is stale (Siri's rule above), when it says to stop that one first and shows where it stands.
  - `insights.ts` builds the Today summary, alerts, targets and celebrations. Her firsts ("Her first poop", her first bath and first tummy time) come from the server's lifetime firsts (`lifetimeCounts` in `store.ts`, sent as `state.lifetime.firsts`), never from the earliest entry loaded, since the app only loads the last 72 hours; a first poop is only celebrated in her first 4 days (meconium). A celebration carries the `entryId` that made it, so its card can quote the family's note on that entry. The diaper brigade's "this week" is seven days: the server counts the days before the loaded 72 hours (`state.lifetime.week`) and the loaded entries count the rest, so a change just logged shows at once.
  - `guidelines.ts` holds every pediatric threshold and every line of alert wording.
  - `growth.ts` + `who-girls.ts` hold the WHO girls LMS tables (daily, 0–730 days) and the percentile math. Only load these lazily on the client.
  - `describe.ts` gives a one-line wording of any entry.
- **Server:**
  - `auth.ts` handles Google sign-in, the session cookie, membership and roles (owner, member, viewer).
  - `store.ts` handles the SQL.
  - `api.ts` has the route helpers.
  - `mcp-tools.ts` has the MCP tools, and `care-mcp.ts` mom's (registered by `registerMapleTools`).
- **Client** in `src/components/maple/`:
  - `useMaple.tsx` handles polling every 10s, optimistic writes, the offline outbox, and undo toasts.
  - `ui.tsx` holds the small UI kit, and `icons.tsx` the line icons (Lucide paths plus custom bottle, diaper, drop, soft-pile and tummy glyphs).
  - `sheets/` holds the log and edit forms.
  - There's one component per tab.
- **Look:** calm and native-feeling. Colors are semantic `mp-*` tokens (`bg-mp-surface`, `text-mp-ink-2`, `border-mp-line`, `bg-mp-accent`…), registered in `globals.css` and given values in `src/app/maple/maple.css` for day, dark mode and the night look, so components need no `dark:` variants. Kind colors (`palette.ts`) mark what an entry is; anything colored by kind carries `mp-kind`, `mp-kind-ink` or `mp-kind-fill` so it folds into the amber at night. No emoji in the app's chrome: line icons (a drop for wet, a soft pile for dirty), or words instead. Members' own avatar emoji and anything the family types are the exceptions; new members start with their initial, and an emoji is theirs to pick in Family. The system font for the UI, with the display serif only for page titles and her name.
- **Medical guidance** in `guidelines.ts` was checked against AAP/HealthyChildren, CDC, NIH, WHO, ABM and children's hospital triage guides. It's tuned for a healthy full-term baby.
  - **Warnings and reminders are off by default** (`settings.show_alerts`, Family → On Today → Warnings & reminders). Feed gaps, diaper counts, weight trends, vitamin D and checkup notes only mean something when every feed and diaper gets logged, and the family doesn't log that consistently. With them off, Today, Siri and Claude/ChatGPT show none. A reading is still checked as it's entered (temperature, oxygen/heart/breathing, poop color, medicine for her age), in the sheet and in the assistant's reply.
  - Alerts always say who to call: 911, the pediatrician now, today, or mention it at the next visit.
  - The app never suggests a medicine dose.
  - If Maple's pediatrician gives different targets (feed interval, preterm plan), set them under Family → Her doctor.

## For mom

Her own area: medicines on the schedule her clinician gave, her temperature, questions for her OB, a private daily check-in (with an optional PHQ-9 and GAD-7), warning signs after the birth, help lines and a page for partners. It's a full-height sheet, not a tab: Today's medicine row, the More tile, and Family → After the birth open it. Support and warning signs open for everyone signed in, viewers included, even before it's set up.

**The rules it's built on.**
- **Her data lives only in `maple_care_*`.** No Maple path reads it: not the Timeline, Patterns, Moments, the dial, celebrations, While you slept, Recently removed, the CSV export, `AlertStack`, or Maple's MCP `list_entries`, `daily_summary`, `undo_last`, `update_entry` and `delete_entry`. Nothing about her goes in `maple_babies.settings`.
- **Every read goes through `careAccess()`** (`src/lib/maple/care.ts`), with roles read fresh on each request, so a demoted or removed member loses access at once.
- **No dose numbers anywhere by default.** Every number on a plan (how often, the 24-hour limit, how many each time, course length) is typed by the family from her label, discharge papers or clinician; fields start blank and no placeholder or hint has a digit (`npm run check:maple-care` fails on one). The app only does arithmetic on her numbers: "OK after", "OK since", "by your schedule", never "take", "due" or "time for".
- **Limits are in the label's own unit** (tablets, caplets, capsules, doses or mL), and the 24-hour count adds up each dose's units, not the taps.
- **Nothing early, recent or over her limit saves silently.** "Took it" saves at once only when nothing needs asking; otherwise it opens the Dose sheet with the reason on top (early, someone already logged it, at the limit, how many this time, already logged today). Nothing is ever blocked.
- **Medical copy** (warning signs, crisis card, notes, help lines, screener text) lives only in `guidelines.ts`, word for word, with its sources. Alerts say who to call (`MOM_TIER_LABEL`, or the alert's own label such as "Call Poison Help now"); readers who aren't her see "For {Name}: " before the title.

**Tables** (`src/lib/migrate.ts`):
- `maple_care_people`: the one care person per log (a single-row unique index), `shared_with`, and `settings` (care team numbers, nursing yes/no, next OB visit, note acks; the therapist's number, check-in suggestions and the sharing banner are hers only).
- `maple_care_meds`: her plans. `schedule` is as needed (optional gap), every N hours, N times a day, or set clock times; `max_24h` needs `limit_unit`; `units_per_dose` is her own text ("2", "1 or 2"); `private` is Only me; `reviewed_at` clears when an assistant adds or changes one ("Check this against the label").
- `maple_care_entries`: doses (taken or skipped, with `units` and the plan's unit at the time), temperatures and questions. Soft deletes with Undo.
- `maple_care_mood`: check-ins and fuller check-ins, hers only, hard-deleted, its own sequence.
- Plan and entry ids are random 8-digit numbers (`care-store.ts`), so a gap never shows that a private row exists. The MCP prints them as `p12345678` (plans) and `c12345678` (entries).

**Who sees what** (`careAccess`):

| Who | Medicines, temperature, questions | Only me items | Check-ins | Therapist's number | Sharing, deleting the area |
|---|---|---|---|---|---|
| Her (Google or invite session) | read, write | read, write | read, write | yes | yes |
| Her Siri token | read, write | read, write | never | never | no |
| Her MCP token (Claude, ChatGPT) | read, write | never | never | never | no |
| An owner or member she shares with | read, write | never | never | never | no |
| An owner or member she doesn't | none | none | none | none | no |
| A viewer | none (Support and warning signs only) | none | none | none | no |
| The admin login with `admin_as` = a member | that member's access, minus her own | never | never | never | no |
| The admin login with `admin_as` unset | none | none | none | none | no |

Sharing starts with every other owner; she changes it in Who sees this. Each reader's rev token includes only the care rows they can read, so her Only me and check-in writes never change anyone else's. Errors on care routes, `care-mcp.ts` and the Siri mom actions are reported as `new Error(code)` with `{ route }` only, since Postgres messages can hold row data.

**App** (`src/components/maple/care/`): `useCare()` is the reader's view (null without access), and `CareNav.tsx` (mounted in `MapleApp`) holds the full-height sheets: her screen, Support, warning signs, setup, the plan picker and the Dose sheet, opened with `useCareNav()`. `CareLine.tsx` has Today's row (inside `StatusCard`, under the Since tiles: her first Show on Today plan, "+n", and "Took it", at most 48px so it clears the dock at 375×667 with a feed running) and the Lantern's dim, read-only line (never an Only me plan). Outbox items carry `target: "entries" | "care" | "mood"`; an old item without one still goes to `/api/maple/entries`.

**API** (`/api/maple/care/*`, wrapped by `withCare`): `person` (POST set up, PATCH sharing and settings, DELETE), `meds` (POST, PATCH `?id=` with `expect_updated_at`, `reviewed`, `stopped`; DELETE), `entries` (GET by local days, POST, PATCH, DELETE) and `entries/restore`, `mood` (her session only; everyone else gets 404), and `move` (a Maple medicine entry to her dose, in one statement, with an undo). A dose POST returns `created: false` with `possible_duplicate` when anyone logged that plan within its gap (or 30 minutes), unless `allow_duplicate`.

Examples here use a made-up medicine, Examplex: the repo is public, so docs never name anything she takes.

**MCP tools** (`care-mcp.ts`, on both the Maple connector and the calendar connector): `mom_status`, `log_mom_medicine`, `set_mom_medicine`, `log_mom_temperature`, `add_mom_question` and `fix_mom_entry`. There are no mood tools, and assistants never see Only me items or the therapist's number, even on her own token.
- `MAPLE_INSTRUCTIONS` ends with a paragraph for her medicines and the crisis numbers: call 911 if anyone is in immediate danger, otherwise call or text 988; the maternal hotline isn't a crisis line.
- `log_mom_medicine` (strict, like Siri) answers `created: false` with `reason` (`early`, `recent`, `at_limit`, `units`) and saves only when called again with `allow_duplicate: true`. `set_mom_medicine` saves only what the user read from the label and leaves the rest empty; a mood or zuranolone medicine she adds is saved as Only me and the result says so.
- Access errors (no area yet, not shared, the admin login acting as nobody, a viewer) end with `HELP_NOW_LINE` and carry `help_now: MOM_HELP.now`.
- Maple's `log_medicine` refuses a name that exactly matches (after `normName`) an active, non-private plan or Also called name on her list, and says to use `log_mom_medicine` or call again with `for_maple: true`. Vitamin D never trips it. In `log_many` that item comes back "Not saved (item N, medicine): …" and the others save.
- `maple_status` adds one line, "{Name}: Examplex OK after 9:10 AM", for callers she shares her medicines with.

**Siri** (`POST /api/maple/quick`, a personal token, `careAccess` on the Siri channel; viewers get 403):
- `mom_status` → `speak` (up to three plans: "Examplex: OK since 4:10 AM. …") and `plans: [{ id, label }]` for Choose from List.
- `mom_dose` with `{ med, minutes_ago?, skipped?, units?, confirm?, client_id?, name_in_reminder? }` (`med` is a name, Also called, or a `p…` id). Asks come back `ok: false` with `needs_units` or `needs_confirm` (and `reason`) and a question to speak; nothing is saved until `units` or `confirm: true` comes back. A save answers "Got it, Examplex at 3:02. Next one's OK after 9:02.", plus `next_ok_at` and `reminder_title` ("Medicine").
- Family → Hands-free shows the one "Mom meds" shortcut for her plans: mom_status, Choose from List, mom_dose, the two asks, Speak Text, and an optional Apple Reminder at `next_ok_at`. Not a calendar: family calendars show on the kitchen display.

**Pill reminders** (Web Push): Her screen → Medicines → **Reminders on this phone** turns on notifications for that phone. Each phone opts in for itself, and its settings ride with its subscription on the server (`maple_push_subs.prefs`): her medicines on/off, doses someone else logs (off by default), hide medicine names on the lock screen, and per-medicine mutes.

- **What's sent** (`src/lib/maple/push.ts`): "OK again" when an as-needed or every-few-hours medicine's next-OK time arrives (her own gap and 24-hour limit, from `planStatus`), and each set time of an "At set times" medicine unless a dose was logged within the hour around it. Never a dose and never "take it now". Phones only get what their member may see: a viewer, or anyone she doesn't share with, gets nothing, and Only me plans reach her phones only.
- **No queue:** each tick works out what's due from the plans and doses as they are, so a dose logged, moved or deleted never leaves a stale reminder. `maple_push_sent` keys each reminder per member so it's sent once; older than 45 minutes and it's dropped.
- **Ticks:** `POST /api/maple/push/tick` (open, rate-limited to one run per 20 s, answers only a count). `.github/workflows/maple-reminders.yml` calls it every 5 minutes (GitHub can run a few minutes late), and every state poll from an open app runs one after answering (`after()`), throttled per server instance. Vercel's Hobby cron only runs daily, so it can't drive this. For tighter timing, point cron-job.org (or any 1-minute cron) at the same URL.
- **Keys:** VAPID keys come from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` when set, else they're derived from `MCP_SECRET` (or `GOOGLE_CLIENT_SECRET`). Changing that secret changes the keys, so every phone has to turn reminders off and on again.
- **iPhone:** Web Push only works in the Home Screen app (iOS 16.4+). In a Safari tab the sheet shows the Add to Home Screen steps instead of the switch. Notifications don't ring through Silent or a Focus, so an overnight dose that matters still wants a real alarm.
- **Service worker:** `/maple/sw.js` (a route, served with `Service-Worker-Allowed: /maple`), registered with scope `/maple` only when a phone turns reminders on. It shows notifications and opens `/maple?care=1` on tap; it has no fetch handler and caches nothing.
- **Routes:** `GET/POST/PATCH/DELETE /api/maple/push` (this phone's key, subscribe, prefs, unsubscribe; per member), `POST /api/maple/push/test` (sends "Reminders are on").

**Help lines** are one constant, `MOM_HELP` in `guidelines.ts`, verified on `HELP_VERIFIED_ON` (2026-10-24) against each line's own page; `npm run check:maple-care` fails once that's more than 183 days old, so recheck every number and its hours before then. Don't copy numbers from secondary pages: some official pages still show retired or mistyped ones (NIMH's "1-833-9-TLC-MAMA", CDC's retired "1-833-9-HELP4MOMS", and 1-800-273-8255).

**Sources** are next to each constant in `guidelines.ts`. The main ones: AWHONN's POST-BIRTH warning signs (paraphrased, never reproduced), CDC Hear Her, NIMH on perinatal depression and postpartum psychosis, ACOG Clinical Practice Guideline 4 and FAQ091, ACOG Committee Opinion 736 (the postpartum visit), Postpartum Support International, 988lifeline.org, HRSA's National Maternal Mental Health Hotline, Poison Help (poisonhelp.org), MotherToBaby, the InfantRisk Center, NLM LactMed, the FDA labels quoted for codeine, tramadol and the opioid note, and the PHQ-9 and GAD-7 developers' official forms (word for word; the EPDS isn't used, for licensing).

