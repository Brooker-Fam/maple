---
title: What Maple's chat sends to an AI model
description: What goes into each request from the chat inside the app, the privacy settings on every one, the limits, and what stays out.
date: 2026-10-26
author: Matt Brooker
draft: false
---

Maple's Log has a chat built in, called Ask. It opens from the round button beside the baby's name on Today, or from the first row of More, and it logs and answers with the Claude and ChatGPT connector's tools. Over the connector, the conversation runs through your own Anthropic or OpenAI account, under their terms. Ask uses a model Maple's server chooses, and the server sends each request.

## The model and the route

Ask runs on GLM-5.3-Flash, a model from Z.ai, through Vercel AI Gateway. Every request sets two Gateway options, `zeroDataRetention: true` and `disallowPromptTraining: true`, and names the only providers the Gateway may route it to. Each is a provider the Gateway lists as keeping no data, at or under the model's listed price.

What a provider does with a request happens inside Vercel's service and the provider's own, which Maple can't inspect.

## Terms come first

Before anyone's first message, the chat shows a short card headed Before you start. It says Maple is a tracker and the chat's answers come from an AI and can be wrong. It lists 911, 988 and the National Maternal Mental Health Hotline, 1-833-852-6262. It says what you type, and the parts of the log the chat reads to answer, go to an AI model, with zero data retention and no training requested. It ends with an Accept button. Maple's server refuses messages from anyone who hasn't accepted.

## What a request carries

- Your message, as plain text, up to 2,000 characters.
- The earlier messages in the same chat.
- A line the app puts at the top of your message, with the local time, the baby's age and who is signed in.
- Maple's instructions to the model and the list of tools it may use.
- The results of the tools it calls to answer, each cut off at 20,000 characters.

Those tool results are the parts of the log it looks up. A question about last night sends what the summary tool returns for that night.

## Mom's page stays out until she turns it on

Mom's page holds her food and drinks, including recorded amounts, medicines and doses, temperatures and questions for her OB. None of it reaches the chat until she turns on access herself. The switch is on her own terms card, in Family under Ask, and in her page's settings. It starts off, and nobody else can turn it on. The expanded access to food and drinks needs her permission again.

While it's off, her tools aren't offered to the model, and the baby's tools leave her out of their answers. Other members see a line saying her food, drinks, medicines, temperatures and OB questions aren't available to the chat. If she turns it off after using it, a chat that ran while it was on never goes back to the model, since its history can quote her page. The next message starts a new chat.

## What stays out

- Photos. The chat takes text only, and the log's tools report only how many photos a moment has.
- Mom's daily check-ins and questionnaires. No tool reads them, here or over the Claude and ChatGPT connector.
- Changes to mom's medicine list. Those tools are left out of the chat, so adding one of her medicines is always a tap in the app.
- For a view-only guest, Maple's server leaves out every tool except the help card and five tools that read the baby's log.
- Maple's logs and error reports. Nothing about a message goes into either. A failed request is recorded by its kind of error and status code.

Usage is stored as token counts and a cost in millionths of a dollar for each model step, with no words.

## Checks before the model runs

Maple's server reads each message for words about harming oneself or someone else before anything else happens. A match always puts the help card, with 911, 988 and the National Maternal Mental Health Hotline, above the reply, whatever the model says. If the model declines to answer, the chat shows a fixed card with the same lines.

The limits come next. Each one fails closed, so if a count can't be read, the message is turned away and logging carries on.

- 2,000 characters a message.
- 6 model steps per message, 1,500 output tokens per step, and low reasoning.
- 60 messages a day for each owner or member, and 20 for a view-only guest.
- A family budget of $0.50 a day and $5 a month by default.
- A chat rolls over to a new one after 40 of your messages or a 60,000-token prompt.

At the daily limit the chat says "That's the chat's limit for today. Logging works as usual."

## Deleting a chat

Chats are saved in the family's log so you can scroll back. Each one belongs to the person who started it, and nobody else can open it. Delete this chat removes it for good. Its usage counts stay, with no words in them, so deleting a chat doesn't reset the day's limit.

The request settings are in [`caps.ts`](https://github.com/Brooker-Fam/maple/blob/main/src/lib/maple/chat/caps.ts) in Maple's public code, and the [privacy page](/privacy) covers the rest.
