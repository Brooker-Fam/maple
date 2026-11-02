# Sleep plan browser checks

`node scripts/sleep-ui-check/run.mjs` runs the real Today page (Right now with
the try and turn cards, the Sleep plan row, the morning check-in card, the dock
with the sleep strip, More, and the toasts) under the real sleep provider and
every sleep sheet (How did it go?, Getting sleepy?, holding and handoffs, the
catch-up, a try's edit, an earlier try, the plan with its Goals, Guidance and
Progress, a goal's form, How did last night go?) against synthetic app state and
an in-memory stand-in for `/api/maple/sleep`, whose goal and check-in actions
and `?view=goals` use the real rules in `src/lib/maple/sleep/goals.ts`. Only
the app store, the clock, the dock's timer actions and the navigation, care and
chat openers are synthetic (`mocks.jsx`). Every request stays on
`sleep.example.test`; no account, database, chat or API is used (the chat's
opener only records the seeded message), and the family, baby and people are
made up.

Checks cover setting up the plan from More, one-tap Put down (a double tap is
one; the "fed" tag after a recent feed, earlier-time chips), one card for one
sleep, the outcomes clear of the dock at 320x568, outcomes with Undo, a try
whose sleep was stopped elsewhere (Woke up) with the outcomes first and the
details folded, the crying lines (soothe and Try again, then pause), the
two-choice "I'm getting sleepy" sheet for the holder only, Wake Alex as an ask
(Waking Alex…, Undo, ten minutes on the two choices again, Alex has her), Take
over for everyone else, asleep in arms and the try that sits on it, logging an
earlier try (More's row, last night's sleeps as one-tap times, a later clock
read as last night, errors in words, the duplicate question by its buttons),
the plan editor through another phone's change and a 409, guidance sources
(44px) and the emergency call link, progress with sample sizes, the morning's
"since last night", a view-only guest through the Sleep plan row and the cards'
headers, 44px targets, named notes and chip groups, and 320px layouts without
horizontal scroll.

Sleep goals (`?goals&morning` seeds one, the morning after a night on its
roster): the empty Goals tab and its two ways in (the chat, seeded with words
that load its sleep tools, and the form), the form's inline checks, a second
window's defaults and the goal it sends, the goal card's counts with what each
is out of, a step and its Undo, Today's check-in with one tap, Undo, Not now
and a note, an edit that sends only what changed with the revision, a 409 that
scrolls into view, repeats by Save, marks what the other phone changed and keeps
the person's change on top, closing and opening again, the four tabs on one row
at 320px, and a view-only guest who sees no check-in and nothing that writes.

Two phones (`?phones`): Sam's phone and Alex's side by side in frames that share
one stand-in route and one clock (each polls for the other's writes): Sam's
Wake Alex asks, Alex's phone says "Sam asked you to take over" with I've got
her, accepting shows the catch-up (last feed and next side, last diaper, what's
running, the next handoff) with its Undo, Sam's sheet says Taken over, and the
partner is never the person holding her.

Words stay neutral (no scores, streaks, grades or "failed"), and nothing says
"keep holding". Runs with reduced motion enabled; `REVIEW_BROWSER=webkit` runs
it in WebKit when Playwright WebKit is installed. Screenshots go to
`test-results/maple-sleep-ui/` (ignored by git).
