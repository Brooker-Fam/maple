# Sleep plan browser checks

`node scripts/sleep-ui-check/run.mjs` runs the real Today page (Right now with
the try and turn cards, the Sleep plan row, the morning's Last night card, the dock
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
roster): the empty Goals tab and its ways in (the chat, seeded with words
that load its sleep tools, the form, and Plan for going back to work: five
questions one at a time, one read-back with a roster and three steps from the
day back, saved only on Save the goal, at 390px and 320px), the form's inline
checks (a plan Maple won't make only on Save, with a wording to try, and nothing
sent), a window's feeds, a second window's defaults and the goal it sends, the
goal card's counts with what each is out of (on the morning after a week ends,
"Week 2 (ended last night)", never "this week" or "so far"), a step and its Undo, Today's Last night card (the check-in, worded
by the adult's own window and never "hold", with one tap, Undo, Not now and a
note; then the night's other questions, one tap each on that check-in), an edit
that sends only what changed with the revision, a 409 that scrolls into view,
repeats by Save, marks what the other phone changed and keeps the person's
change on top, closing and opening again, the four tabs on one row at 320px, and
a view-only guest who sees no check-in and nothing that writes. With `?sparse`,
Wed night is a sparse log: a sleep timer left running (Woke at the next thing
logged), three stretches with nothing logged (only "She slept through" saves),
the safe-sleep line for Somewhere else, Tell Maple, and the card's essentials
above the dock at 320 × 568. With `?nursing`, a nursing feed is running: at night
its card says wake someone to sit with you, or the bassinet (clear of the dock at
320 × 568), and by day, or for a view-only guest, it doesn't.

Round 2 (the re-test's fixes): the plan says what to do tonight after setup
(and in the morning why the morning nap is the backup); How did it go? is the
strip's strong button while she's down, and Put down goes quiet after "1 of 1";
the crying line is whole at 320px. Asleep in arms (`?holding`) is one card, the
turn's, with Edit sleep, and the holder's strip says Put her down (it fits at
320px) while I'm getting sleepy moves to the card; `?holding&armsfeed` adds a
feed after it began, so that card asks Woke at (Still asleep holds on the
phone). The morning: Last night sits straight after Right now, its check-in
clearing the dock at 390 × 844 as Today opens; the strip carries its first
question from 5 AM (Answer brings the card into view at 320 × 568); a timer
left running asks Woke at on its own card and on the strip; only the two
longest stretches are asked, named by whose window they were in, Not sure
first, with Skip the rest; answers show their receipt and Undo in the card,
never a toast over the next question; the place question is prefilled from the
log when every sleep has a place; the night strip wears the night look's
amber; and Log an earlier try folds its times after a chip so How it went is
in view. The next handoff and the roster (`?holding&roster`, and with
`?phones`): the start and Hand off sheets preselect the end of the next
holder's protected window (a time inside it says so), and the holder's Alex has
her and Alex's I've got her plan it there, the toast and the catch-up saying
why.

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
