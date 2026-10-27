---
title: How Maple counts a feed
description: The rules behind the feed count, clusters, Last fed and the next side, with the sources they cite.
date: 2026-10-26
author: Matt Brooker
draft: false
---

Every tap on the nursing timer saves a time in the log. The feed numbers on Today, in History and Patterns, from Siri and from Claude are worked out from those times each time they're shown. No count is stored, so an evening from last week and tonight are counted by the same rules, however each one was tapped.

These are the log's counting rules. For feeding advice, ask your pediatrician or a lactation consultant.

## Under 10 minutes off the breast is the same feed

A feed ends once the baby has been off the breast for 10 minutes or more. A shorter break is part of the same feed, whether someone tapped Pause or Done.

So a feed paused for 12 minutes counts as two feeds, and two feeds logged 5 minutes apart count as one. Two parents with different habits get the same numbers. One taps Pause for a burp, then Resume. The other taps Done, then a few minutes later starts a new feed on the other side. Both read as one feed.

The Siri shortcuts have no pause action for the same reason. A stop and a new start within 10 minutes already count as one feed.

## Three close feeds make a cluster

Three or more feeds, each starting less than 30 minutes after the one before it ended, make a cluster. Today's Last fed then names the cluster, its span, how many feeds it held and how long she nursed in all.

Each feed in a cluster still counts toward the day. A day of 11 feeds with 4 of them in a cluster shows 11 feeds, noted "4 in a cluster". Bottles stay feeds of their own and never join a cluster. The "Lately: about every" line on Today skips the gaps inside a cluster, so one evening of short feeds doesn't pull the usual gap down.

None of the sources behind the app's guidance says how a cluster should count toward a day's feeds, so that rule is the app's own. The Cluster feeding sheet opens with "Cluster feeding, several short feeds close together, is normal for newborns, most often in the late afternoon and evening." That line rests on the Academy of Breastfeeding Medicine's [Clinical Protocol #3](https://www.bfmed.org/assets/DOCUMENTS/PROTOCOLS/3-supplementation-protocol-english.pdf), which calls cluster feeding normal newborn behavior, on the [CDC](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html), and on the [Australian Breastfeeding Association](https://www.breastfeeding.asn.au/resources/feeding-patterns) for the time of day. There's no cluster alert.

## Where Last fed counts from

Last fed counts from when the last feed began, start to start.

When a feed went back and forth between sides, or had three or more parts, and ran longer than 40 minutes, Last fed counts from 40 minutes before it ended. The 40 comes from UNICEF UK Baby Friendly's [breastfeeding assessment tool](https://www.unicef.org.uk/babyfriendly/wp-content/uploads/sites/2/2018/07/breastfeeding_assessment_tool_mat.pdf), which says a baby "will generally feed for between 5 and 40 minutes". Using it to set Last fed is the app's own choice.

A feed with one or two parts, such as one side the whole time or Left then Right, keeps its real start, so a timer nobody stopped still shows the full gap. When the last Left or Right of a long feed ran past 40 minutes by itself, Last fed counts from when she went on that side. If a bottle came after the feed, Last fed counts from when the bottle started.

Last fed's info line says, "Counted from when her last feed began. A long back-and-forth stretch counts from 40 minutes before she finished, or from when she went on her last side if that side alone ran longer."

## The next side depends on when the last feed ended

Within 30 minutes of the last feed ending, the next side is the other one from the side she was last on. It's the side the paused dock marks Next side.

After 30 minutes, or while she's still nursing, the next side is the opposite of the side the last feed started on. That follows the American Academy of Pediatrics' [Settling In](https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/Settling-In-The-First-Few-Weeks-of-Breastfeeding.aspx) guide, which says to "alternate the breast you offer first with each breastfeeding session".

Going back and forth never sets the next side. The side the feed started on still decides it. After a back-and-forth feed the suggestion adds "or the fuller side", from the same AAP page, which says that later on you'll know which breast feels fuller and can start there. The app's line for it is "Start the next feed on the other side from last time, or on the side that feels fuller."

## The same rules in every view

Today, the Timeline, Patterns, Siri's Maple status, Claude and ChatGPT, and the chat in the app all count feeds with the same code, so they give the same answer. The rules are in [`feed.ts`](https://github.com/Brooker-Fam/maple/blob/main/src/lib/maple/feed.ts) in Maple's public source code, and the guidance text with its sources is in [`guidelines.ts`](https://github.com/Brooker-Fam/maple/blob/main/src/lib/maple/guidelines.ts).

## Sources

- Academy of Breastfeeding Medicine, [Clinical Protocol #3](https://www.bfmed.org/assets/DOCUMENTS/PROTOCOLS/3-supplementation-protocol-english.pdf)
- CDC, [How Much and How Often to Breastfeed](https://www.cdc.gov/infant-toddler-nutrition/breastfeeding/how-much-and-how-often.html)
- Australian Breastfeeding Association, [Feeding patterns in the early months](https://www.breastfeeding.asn.au/resources/feeding-patterns)
- UNICEF UK Baby Friendly Initiative, [Breastfeeding assessment tool](https://www.unicef.org.uk/babyfriendly/wp-content/uploads/sites/2/2018/07/breastfeeding_assessment_tool_mat.pdf)
- American Academy of Pediatrics, [Settling In: The First Few Weeks of Breastfeeding](https://www.healthychildren.org/English/ages-stages/baby/breastfeeding/Pages/Settling-In-The-First-Few-Weeks-of-Breastfeeding.aspx)
