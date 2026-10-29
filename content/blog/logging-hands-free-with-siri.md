---
title: Logging hands-free with Siri
description: How Maple's Siri shortcuts are set up, the actions they send, and what Siri reads back.
date: 2026-10-26
author: Matt Brooker
draft: false
---

Maple's Log works with the Shortcuts app on iPhone. Each shortcut sends one action to the log, such as `pee` or `nurse_left`, and Siri reads out the sentence the log sends back. Saying "Hey Siri, Maple pee" logs a wet diaper with nothing to tap.

To set it up, tap your avatar in the app, then Settings → Siri & assistants. Maple provides ready-made shortcuts, so you don't need to build the actions yourself.

## Each person makes a key

Each adult makes their own key, so what their shortcuts log carries their name. Tap Set up Siri, then Copy key. Maple shows this key only during setup. Anyone who has it can access your family's log as you, so keep it private.

Your Siri keys lists when each key was last used. Remove a key there to disconnect every shortcut using it. Removing someone in Settings → People & permissions ends their keys at the same time.

## Add the first shortcut

Start with Maple status. It reads the latest update without adding an entry.

1. Tap Set up Siri and copy your key.
2. Tap Download Maple status. Open the downloaded file in Apple Shortcuts, paste your key when asked, and tap Add Shortcut.
3. Run Maple status once while your phone is unlocked and allow access to Maple. Then say "Hey Siri, Maple status."

The shortcut needs an internet connection. Siri may ask you to unlock your phone. You can also assign a shortcut to the Action Button or add it to your Home Screen.

The download contains the actions and Maple's address, with a blank field for your key. Your personal key is added on your device. Advanced setup remains available for building a shortcut manually.

## The actions and what Siri says

Open More Siri commands to download the commands you need, and paste the same key into each. If you return later, you can find the key in the Text action of an installed shortcut. The times below are examples.

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

With Warnings & reminders on (Settings → On Today), status also names anything urgent and who to call. They're off by default.

Creating a Siri key requires permission to log. If an existing key's owner becomes a viewer, only status remains available.

People who can log mom's medicines can build a Mom meds shortcut using the instructions under Advanced setup.

## What Maple and Apple receive

The shortcut sends its action word and your key to Maple, which stores each key as a hash. What you say to Siri is handled by Apple under Apple's terms. The [privacy page](/privacy) has the rest.
