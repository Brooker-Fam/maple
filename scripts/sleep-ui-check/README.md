# Sleep plan browser checks

`node scripts/sleep-ui-check/run.mjs` runs the real sleep provider, the plan's
row (Today's Up next card, or her sleep's timer card while she's asleep), the
try (on that timer card, or a card of its own once her sleep stopped) and the
holding card, Today's check-in card and every sleep sheet (How did it go?,
Getting sleepy?, holding, a try's edit, an earlier try, the plan with its Goals,
Guidance and Progress, a goal's form, How did last night go?) against synthetic
app state and an in-memory stand-in for `/api/maple/sleep`, whose goal and
check-in actions and `?view=goals` use the real rules in
`src/lib/maple/sleep/goals.ts`. Every request stays on `sleep.example.test`; no
account, database, chat or API is used (the chat's opener only records the
seeded message), and the family, baby and people are made up.

Checks cover setting up the plan, one-tap Put down (the "fed" tag after a
recent feed, earlier-time chips), each sleep state drawn once (the try on her
sleep's card, the row stepping aside), outcomes with Undo, a try whose sleep was
stopped elsewhere (Woke up), the two-choice "I'm getting sleepy" sheet and the
partner handoff, the transfer steps, logging an earlier try with the duplicate
question, guidance sources and the emergency call link, progress with sample
sizes, a view-only guest, 44px targets, and 320px layouts without horizontal
scroll.

Sleep goals (`?goals&morning` seeds one, the morning after a night on its
roster): the empty Goals tab and its two ways in (the chat, seeded with words
that load its sleep tools, and the form), the form's inline checks and the goal
it sends, the goal card's counts with what each is out of, a step and its Undo,
Today's check-in with one tap, Undo, Not now and a note, an edit that sends only
what changed with the revision, a 409 that keeps the person's change on top of
the other phone's, closing and opening again, the four tabs on one row at
320px, and a view-only guest who sees no check-in and nothing that writes.
Words stay neutral (no scores, streaks, grades or "failed"). Runs with reduced
motion enabled; `REVIEW_BROWSER=webkit` runs it in WebKit when Playwright WebKit
is installed. Screenshots go to `test-results/maple-sleep-ui/` (ignored by git).
