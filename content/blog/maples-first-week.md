---
title: Maple's first week
description: How Maple began, with an October 29 update on the feeding patterns, doctor visit, and changes that helped our family with breastfeeding.
date: 2026-10-26
author: Matt Brooker
draft: false
---

Maple's Log is a log for my daughter, Maple, that my wife and I can both write to from our phones.

## Update — October 29, 2026: what the log helped us see

At Maple's six-day appointment, her weight was down. Looking back through Maple Baby helped us understand her feeding patterns. We were going too long between certain feeds, and we could see the times when those gaps were happening.

At the doctor's office, we could share direct data about her feeds. We changed our routine and kept tracking the feeds, wet diapers, dirty diapers, and weight. That gave us a way to follow the changes we were making. Maple's weight went up, and she's doing great.

We had wondered whether we might need to supplement with formula. For our family, understanding those patterns and making changes helped breastfeeding work.

That experience shaped what we want Maple to offer: a clearer picture of your baby's patterns, useful records for appointments, and a way to follow changes over time. The timers and quick logging help make that possible. You can read more on the [Our story page](/about).

The original October 26 account of how we built Maple follows.

## A page on the family website

On October 20, 2026, I added Maple's Log to my family's website at brooker.family/maple. Like the other family side projects there, nothing on the site linked to it.

The first version already logged nursing with a timer for each side, diapers with stool colors, sleep and growth on the WHO percentile curves, along with most of what the app tracks now. Today showed the last feed and the next side, with a darker look for 3am feeds. Its alerts for fevers, diapers and stool color were sourced from the AAP, CDC, WHO and hospital triage guides, and none of them suggested a medicine dose. From the first day, Claude and ChatGPT could connect to it and Siri shortcuts could log to it.

## What changed after the first days

On October 23 I turned warnings off by default. My wife and I weren't logging every feed and diaper, so warnings built on counts, such as feed gaps and too few wet or dirty diapers, were false alarms. They stay off unless someone switches them on. A temperature or a poop color is still checked as it's entered. The same day I redesigned every screen without emoji. Line icons took their place, and the Timeline became one line through the day.

On October 24 I redesigned the nursing screen. Switch and Done were on both the card and the dock, there were three unlabelled start times, and adjusting the start moved the whole feed when I needed to fix when the Right started after a break. The card now shows what happened as labelled rows, the timer's actions are in the dock, and one Fix times sheet corrects any moment of a feed. Four more rounds of fixes landed that day, covering a forgotten Done, breaks over an hour, and two phones changing the same feed at once.

On October 25 the log started counting several close feeds as a cluster, and the timer got a way to go back and forth between sides without tapping Switch each time. Family also got switches to hide Bottles and Pumping.

## Its own app

On October 26 Maple moved out of the family website into its own repository, [Brooker-Fam/maple](https://github.com/Brooker-Fam/maple), under the MIT license, at maplebaby.app. That day I also added the code for the first iPhone and Android apps, which wrap the web app and aren't released yet, along with the chat inside the app and this site with its terms, privacy page and waitlist.

## How it was built

Every commit from October 20 to October 25 lists Claude, Anthropic's AI model, as its author or a co-author. [The history](https://github.com/Brooker-Fam/maple/commits/main) is public, so anyone can read what changed and when.

## One family for now

Maple still serves one family, mine. On October 26 a plan for opening it to other families went into the repository. That work is planned, and the [waitlist](/waitlist) is where to hear when it opens.
