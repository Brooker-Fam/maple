---
title: Logging hands-free with Siri
description: How Maple's Siri shortcuts are set up, the actions they send, and what Siri reads back.
date: 2026-10-26
author: Matt Brooker
draft: false
---

Maple's Log works with the Shortcuts app on iPhone. Each shortcut sends one action to the log, such as `pee` or `nurse_left`, and Siri reads out the sentence the log sends back. Saying "Hey Siri, Maple pee" logs a wet diaper with nothing to tap.

To set it up, open Family → Shortcuts & assistants → Claude, ChatGPT and Siri in the app. The sheet that opens has a section called Hands-free with Siri.

## Each person makes a key

Each adult makes their own key, so what their shortcuts log carries their name. Type a name for the key, or leave the field blank for "iPhone Shortcuts", and tap Make a key. The key appears once, under "Your new key · shown once", with a Copy key button. Anyone who has it can log as you, so keep it private.

Each key in the list shows when it was last used, with a Revoke button beside it. With a revoked key, Siri says "That shortcut isn't connected to Maple's log anymore." Removing someone from the family's log in Family ends their keys at the same time.

## Building the first shortcut

Under the keys, Set up the shortcut opens these steps for the Shortcuts app.

1. Tap +, and name the shortcut Maple pee.
2. Add the action Get Contents of URL, and set its URL to this address.

   ```
   https://maplebaby.app/api/maple/quick
   ```

3. Tap › to show more, and set Method to POST.
4. Under Headers, add `Authorization` with the value `Bearer` followed by a space and your key.
5. Set Request Body to JSON and add a Text field with the key `action` and the value `pee`.
6. Add Get Dictionary Value to get the value for `speak` in Contents of URL.
7. Add Speak Text with that Dictionary Value.

Try "Hey Siri, Maple pee." For one press with the phone locked, choose it under Settings → Action Button → Shortcut, add it as a Lock Screen control, or set it under Settings → Accessibility → Touch → Back Tap.

## The actions and what Siri says

Duplicate the first shortcut for each action, changing its name and the `action` value. The times below are examples.

| Shortcut | `action` | Siri says |
| --- | --- | --- |
| Maple pee | `pee` | Logged a wet diaper at 3:10 AM. |
| Maple poop | `poop` | Logged a dirty diaper at 3:10 AM. |
| Maple both | `both` | Logged a wet and dirty diaper at 3:10 AM. |
| Maple left | `nurse_left` | Nursing timer running on the left. |
| Maple right | `nurse_right` | Nursing timer running on the right. |
| Maple switch | `switch` | Switched to the right. |
| Maple back and forth | `back_and_forth` | Going back and forth from 3:14 AM, so there's nothing to switch. |
| Maple stop | `stop` | "Stopped." and a line about the timer it ended |
| Maple sleep | `sleep` | Sleep timer started. Sweet dreams, Maple. |
| Maple awake | `wake` | "Stopped." and a line about the nap |
| Maple status | `status` | Last fed, the next side and the last 24 hours of diapers |

`vitamin_d` answers "Vitamin D logged at 3:10 AM." `bottle`, with a Number field named `amount_oz`, answers "Logged a 2 ounce bottle at 3:10 AM."

## When a timer is already running

Maple left or Maple right during a feed moves it to that side. Starting a feed stops a running sleep timer, and Maple sleep stops a running feed first ("Feed stopped and sleep timer started. Sweet dreams, Maple."). Maple stop ends the running feed, or whichever other timer is running when no feed is.

A feed nobody has tapped for an hour is treated as forgotten, and Siri says "A feed from 2:10 AM is still running. Stop that one first, then start the new feed."

Back and forth needs a feed on a side first, since the next side alternates from the side she started on. With nothing running, Siri says "Start the feed on a side first." While she's going back and forth, Maple switch answers "She's going back and forth, so there's nothing to switch." Maple left or right then tracks sides again, and Siri says "Tracking sides again: she's on the left."

There's no pause action. A stop and a new feed within 10 minutes count as one feed anyway, as [How Maple counts a feed](/blog/how-maple-counts-a-feed) explains.

## Maple status

Status reads back the same Last fed and next side that Today shows, for example "Maple last ate 45 minutes ago, starting on the left, so start on the right next. 6 wet and 3 dirty diapers in the last 24 hours." During a feed it says which side she's on and how many minutes in. After a cluster it names the cluster first.

With Warnings & reminders on (Family → On Today), status also names anything urgent and who to call. They're off by default.

View-only guests can use status and nothing else. Any other action answers "You have view-only access to Maple's log."

People who can log mom's medicines also see a separate Mom meds shortcut in the same sheet. It's set up the same way.

## What Maple and Apple receive

The shortcut sends its action word and your key to Maple, which stores each key as a hash. What you say to Siri is handled by Apple under Apple's terms. The [privacy page](/privacy) has the rest.
