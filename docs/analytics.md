# Analytics

[Maple acquisition and activation](https://us.posthog.com/project/691349/dashboard/2272587) is the PostHog dashboard. Filter production reports to `schema_version = 2`, `environment = production`, and `is_test = false`.

## Identity and attribution

The browser sends approved public events to `/api/maple/analytics/event`. A signed HttpOnly cookie holds a random visitor id for up to 30 days and a UUIDv7 session id renewed after 30 minutes idle or 24 hours. A separate generation cookie prevents a late response from restoring identity after sign-out. The context is bound to the current authentication cookie and stores only approved attribution values. Request bodies have strict schemas, origin checks, size limits and keyed rate limits.

`maple_analytics_members` assigns each canonical member a random UUID. Two adults in one family have separate person profiles. `maple_analytics_families` assigns a separate UUID for `$groups.family` and the event's `family_id` property; no raw database id reaches PostHog. Person ids survive session-secret rotation. An accepted membership is required to resolve an actor.

Sign-in identifies the member and links the saved anonymous visitor. A database claim prevents the same visitor from being merged into different people on a shared browser. Auth success and logout clear the visitor cookie. Auth flows carry attribution in their sealed state, including email links and native handoffs.

Approved public paths include individual published blog slugs. Current URLs are rebuilt from the canonical origin and approved pathname, without query strings. First-touch attribution accepts only explicit source, medium, campaign and referrer categories in `policy.ts`. Unknown referrer domains become `other`; arbitrary campaign strings are dropped. Add deliberate campaign labels to that schema before using them in a campaign.

## Events

| Event | Meaning |
| --- | --- |
| `$pageview` | An approved public page opened. App pages are excluded. |
| `signup_clicked` | A Get started link clicked; `placement` identifies its location. |
| `signup_started` | A new-family authentication flow accepted. |
| `signup_completed` | A new family created, once. Replaces `signed_up`. |
| `signup_failed` | A signup failure with a bounded reason and provider. |
| `onboarding_started` | An owner opened their setup flow, once per family. |
| `onboarding_step_completed` | A setup step saved or skipped, with an opaque step number. |
| `onboarding_completed` | Setup successfully finished. |
| `invite_created` | An invite link created. |
| `invite_sent` | The email provider accepted an invite email, not proof of inbox delivery. |
| `invite_accepted` | Membership inserted through an invite. |
| `entry_logged` | A new baby-log entry inserted. Replayed saves do not count again. |
| `app_opened` | The signed-in app opened, changed member/family, or returned after 30 minutes hidden. |
| `chat_started` | A model turn started. |
| `chat_completed` | The stream finished and its reply saved. Replaces `chat_used`. |
| `chat_failed` | A started turn failed or its reply could not be saved. |
| `waitlist_joined` | A new waitlist address inserted. Repeated addresses do not count again. |
| `$exception` | A scrubbed server or browser error. |

Use a person funnel from `$pageview` to `signup_completed`, `onboarding_completed`, then `entry_logged`, with a seven-day conversion window. A family's first entry can also be made by an invited member, so a person funnel measures the creator's activation, not every family's activation. Use the separate `family_id` property for family adoption counts. Group analytics does not need to be purchased to count distinct values of that property.

Historical `signed_up` and `signup_completed` events duplicated the same creation. Do not sum them. Legacy anonymous ids and family ids cannot be safely backfilled into the new people, so conversion and retention measurement starts with schema v2.

## Privacy

Analytics never sends names, email addresses, raw member/family ids, entry kind, baby measurements, medicines, notes, chat text, photos, private paths, invite tokens, full query strings, page titles or browser/device details. There is no autocapture or session replay. Geolocation is disabled. First-party ingestion keeps the visitor's IP out of the outbound event payload.

Browser errors send only an approved error class and source category, with duplicate and volume limits. Server errors send approved classes, codes and static context. Raw exception messages and stack traces are discarded because they can contain log data or signed URLs.

Deleting the final membership for an identity removes its local analytics mapping and visitor links. Family deletion cascades its local group mapping. Delivery receipts expire after seven days; visitor claims expire after 31 days. These are local retention rules, separate from PostHog's event retention.

## Delivery and monitoring

Delivery checks HTTP status and retries transient failures with the same event UUID and timestamp. App-open retries preserve their event id and stop after success. Product actions continue if analytics is unavailable.

Failed deliveries emit a static error and an operator email through the existing alert delivery system. The daily usage-alert job also checks for 36 hours without an accepted non-test delivery and runs analytics cleanup. A failed check prevents the job's success heartbeat, which is watched by the existing health monitor. Emails use `MAPLE_ALERT_EMAIL`, falling back to the contact inbox; alerts contain no event contents or account identifiers.

PostHog's capture endpoint can acknowledge an invalid project token with HTTP 200. An accepted local receipt therefore does not prove downstream ingestion. Verify events and person links in the Maple Baby project after configuration changes.

## Verification

`pnpm check:analytics` covers policy, identity, auth/product event hooks, errors, app-open lifecycle and scheduled monitoring. `pnpm check:maple-tenancy` checks family isolation. Tests use generated data in isolated PGlite databases.

`MAPLE_ANALYTICS_SMOKE=1 pnpm smoke:analytics` explicitly sends synthetic events using the configured public PostHog token. It forces an in-memory database, `environment = development` and `is_test = true`; it never reads a production database. It prints only synthetic opaque ids for verifying the linked visit, two separate people and shared family in PostHog. Keep these test events out of product reports.

The October 28 verification confirmed that a synthetic pricing visit, signup, setup and first entry appeared on one PostHog person. A second member had a separate profile with the same family identifier. Web Analytics counted the repaired visit as one visitor, one pageview and one session attributed to Email. The dashboard excludes these test events. Web Analytics requires UUIDv7 session identifiers; an accepted event with a UUIDv4 session can appear in Activity without appearing in session reports.
