---
title: Connect Maple to Claude or ChatGPT
description: The connector URL, how sign-in and approval work, what the assistant can and can't do, and how to disconnect.
date: 2026-10-26
author: Matt Brooker
draft: false
---

Maple's Log runs an MCP server, the kind of connector Claude and ChatGPT use to reach other apps. Once it's connected, you can tell the assistant "wet and dirty diaper, mustard" or ask "which side next?", and the entry lands in the same log as the app, with your name on it.

Paste this connector URL when the steps below ask for it.

```
https://maplebaby.app/api/maple/mcp
```

Only people already invited to a family's log can connect, and for now Maple has one family. The [waitlist](/waitlist) is for hearing when that changes.

## Claude

1. On claude.ai or the Claude desktop app, open Customize → Connectors. In some versions it's Settings → Connectors.
2. Click Add custom connector. Name it Maple's Log and paste the URL.
3. Click Connect, then Continue with Google, then Approve.
4. In a chat, make sure Maple's Log is switched on in the tools menu.

The connector then works in the Claude phone app too, on the same account.

In Claude Code, run this command, then type `/mcp`, pick maple and choose Authenticate.

```
claude mcp add --transport http maple https://maplebaby.app/api/maple/mcp
```

## ChatGPT

ChatGPT's custom connectors are set up on chatgpt.com in a web browser, and your plan decides if you have them. They sit behind developer mode, and the phone app may not show them.

1. On chatgpt.com, open Settings → Apps & Connectors (it may be called Apps or Plugins) → Advanced, and turn on Developer mode.
2. Choose Create, or add a custom MCP server. Name it Maple's Log, paste the URL and set Authentication to OAuth.
3. Connect, then Continue with Google, then Approve.
4. In a chat, pick Maple's Log from the + or tools menu, or type @.

ChatGPT asks before each log. Tap Approve and choose to remember it for that chat.

## Signing in and approving

Sign in with the same Google account you use for Maple's Log. If you're signed in already, the approval card opens straight away. It names the assistant and its address, such as Claude (claude.ai), and your name and email address, then lists what the connection allows.

- Read and add to Maple's log, including feeds, diapers, sleep, growth, temperatures and moments. A view-only guest's card says it can read and can't add anything.
- Anything it logs shows your name and "via Claude" or "via ChatGPT".
- You can disconnect anytime by removing the connector.

Tap Approve to connect, or Cancel.

The sign-in only hands its code to Claude, ChatGPT or an app on your own computer. A request that wants to send you anywhere else is stopped with "Unknown app". The key Claude or ChatGPT gets works only at the connector URL above, so no other server can reuse it. Claude, ChatGPT and local apps also get a renewal key, so the connection doesn't lapse, and every renewal checks that you're still in the family's log.

## What the assistant can do

It can log feeds and run the nursing timer (start, switch sides, pause, stop and fix times), and log diapers, sleep, bottles, pumping, growth, temperatures and other readings, medicines, notes, moments and questions for the doctor. It can correct, delete, restore or undo an entry. For members who can see mom's page, it can log her medicines, her temperature and her questions for her OB too. It also answers from the log: the status right now, recent entries, a daily summary, moments and the doctor questions.

Every save names an entry number, like "Saved #1234: wet diaper at 3:10 AM today." If the reply doesn't say "Saved #", nothing was saved. If someone else already logged the same diaper or feed, it asks before adding a second one.

A temperature, an oxygen reading or a pale poop is checked as you log it, and the result comes through word for word, the same as in the app. Feeding, diaper-count and weight warnings come through only when Warnings & reminders is on, under Family → On Today.

In Claude's tool permissions, the logging tools can be set to Always allow, so a log needs no approval tap. The setup page suggests keeping `update_entry`, `delete_entry` and `undo_last` on Needs approval.

## What it can't do

The assistant has no way to add photos. A moment saved from Claude is text, and photos are added in the app. It can't change Family settings, invite or remove people, or turn notifications on. Mom's daily check-ins aren't available to it at all.

What the assistant reads from your log goes through your own Anthropic or OpenAI account, under their terms and your settings there. Maple doesn't control what they keep. The chat built into the app works differently, and [What Maple's chat sends to an AI model](/blog/what-maple-sends-to-an-ai-model) covers it.

## Disconnecting

Remove the connector in Claude or ChatGPT. Maple doesn't store the keys it hands out, since they're signed, so the app has no list of connections to revoke.

An owner can also remove a person in Family. That ends their connections at once, along with their sign-ins and Siri shortcuts, since every request from the assistant checks that the person is still in the family's log.

Step-by-step setup with copy buttons is in the app at Family → Shortcuts & assistants → Claude, ChatGPT and Siri → Step-by-step setup.
