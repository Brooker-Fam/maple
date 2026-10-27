---
title: Diaper colors in Maple
description: What the diaper sheet shows for each stool color, and which colors bring up a card to call the pediatrician today.
date: 2026-10-26
author: Matt Brooker
draft: false
---

In the diaper sheet, choosing Poop or Both shows the color swatches. There are ten, in four groups (Usual, First days, Pale and Red), laid out like a hospital stool card. They keep their real shades in the night look, only dimmed, so you can still match a diaper to them. Picking one shows a line about what that color usually means.

Every line quoted below is the app's own wording, from [`guidelines.ts`](https://github.com/Brooker-Fam/maple/blob/main/src/lib/maple/guidelines.ts) in Maple's public code. It's general guidance for a healthy full-term baby, checked against the American Academy of Pediatrics, the CDC and children's hospital triage guides. The app's note says, "Maple's Log isn't medical advice. When in doubt, call your pediatrician."

## The usual colors

| Swatch | What the app shows |
| --- | --- |
| {swatch:mustard}Mustard & seedy | Textbook breastfed poop by days 4–5. |
| {swatch:yellow}Yellow | The classic breastfed poop. |
| {swatch:green}Green | Common in the transition days and normal now and then. |
| {swatch:brown}Tan / brown | Normal, especially with formula. |
| {swatch:orange}Orange-ish | Normal variation. |

The line under the swatches reads, "Black and sticky (Days 1–2) → greenish-brown (Days 3–4) → mustard yellow and seedy (by Days 4–5). Green, tan and orange-ish shades are normal too."

## Black in the first days

{swatch:black}Black / tarry sits in its own group, First days, with the note "Meconium: expected in the first 2–3 days."

From Day 5, black brings up a card headed "Still black poop after Day 4", marked Call your pediatrician today. It reads, "Her poop should have turned yellow by now, which is a sign milk is flowing. Very dark green can look black: smear a little on a white wipe in bright light. If it's truly black or tarry, please check in with your pediatrician today."

## Colors that mean calling today

Four swatches bring up a card marked Call your pediatrician today as soon as one is picked.

{swatch:pale_yellow}**Pale yellow**, {swatch:gray}**Gray / clay** and {swatch:white}**Chalky white** show the card headed "Pale poop: call your pediatrician today", which reads

> Very pale, chalky-white, gray or clay-colored poop can be a sign of a liver problem that's very treatable when it's caught early. Please call your pediatrician today (don't wait for the next checkup) and show them a photo of the diaper.

{swatch:red}**Red / blood** shows the card headed "Red in the diaper: call your pediatrician today", which reads

> Often it's something small, like a tiny tear or swallowed blood from a cracked nipple, but blood in poop should always be checked. Call now instead if there's a lot of blood or mucus, or blood with fever, vomiting, a swollen belly or poor feeding.

These cards show in the diaper sheet whether or not Warnings & reminders is on in Family → On Today. Warnings built on counts, such as too few dirty diapers, stay off until that switch is on, since they only mean something when every diaper gets logged. A color is checked the moment it's entered.

Claude, ChatGPT and the chat in the app get the same check. Log "dirty diaper, gray" there and the reply carries the same words.

## When to call 911

The stool cards say when to call the pediatrician. The signs that mean calling 911 are in Help and doctor numbers, at the foot of Today, with your pediatrician's numbers. If you think your baby needs help now, call 911.
