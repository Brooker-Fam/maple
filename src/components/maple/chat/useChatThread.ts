"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { CHAT_MAX_CHARS, type ChatMessage, type ChatThread } from "@/lib/maple/chat/types";
import { deviceHeaders } from "@/lib/maple/device";
import { shownFamilyHeaders } from "../shownFamily";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import { DROPPED, needsHelpCard, problemFor, refusalOf, textOf, unanswered } from "./stopped";

/** A thread touched within this long reopens with the sheet; after it, a new one starts. */
const REOPEN_MS = 6 * 60 * 60_000;

/** After an answer stops early, the server's copy is looked for this often, for about as long as a turn can hold the thread. */
const RESYNC_MS = 5_000;
const RESYNC_TRIES = 16;

const newThreadId = () => crypto.randomUUID();

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/maple/chat",
  // This install's id, so her "Logged" notice skips the phone the chat ran on; and the family this tab shows.
  headers: () => ({ ...deviceHeaders(), ...shownFamilyHeaders() }),
  // Only the newest message goes up: the server keeps the thread and never takes history from the phone.
  prepareSendMessagesRequest: ({ id, messages }) => ({ body: { threadId: id, message: messages[messages.length - 1] } }),
});

export function useChatThread(open: boolean) {
  const { api, refresh, online, state } = useMaple();
  const { termsNeeded } = useChatNav();
  const babyName = state?.baby.name;
  const babyNickname = state?.baby.nickname;
  const names = useMemo(() => [babyName, babyNickname], [babyName, babyNickname]);
  const [thread, setThread] = useState<{ id: string; initial: ChatMessage[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const helpArrived = useRef(false);
  const [draft, setDraft] = useState("");
  const usedAt = useRef(0);
  const lastSent = useRef<string | null>(null);
  const carry = useRef<string | null>(null);
  const shown = useRef<{ id: string | null; busy: boolean }>({ id: null, busy: false });

  const chat = useChat<ChatMessage>({
    id: thread?.id,
    messages: thread?.initial,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onData: (part) => {
      if (part.type === "data-help") helpArrived.current = true;
    },
    onFinish: ({ isError }) => {
      usedAt.current = Date.now();
      // An answer that stopped early refreshes once the server has saved it (resync).
      if (!isError) void refresh();
    },
    onError: (err) => {
      const refusal = refusalOf(err.message);
      if (refusal?.code === "new_chat") {
        carry.current = lastSent.current;
        setThread({ id: newThreadId(), initial: [] });
        return;
      }
      if (refusal?.code === "terms") termsNeeded();
      setProblem(problemFor(err.message));
      // No answer, or one cut off before its card: the help card shows here instead.
      if (!helpArrived.current && (refusal?.help === "crisis" || (lastSent.current != null && mentionsCrisis(lastSent.current, names)))) setHelp(true);
      if (thread) void resync(thread.id);
      if (!refusal) return;
      chat.setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (last?.role === "assistant") return [...ms.slice(0, -1), unanswered(last)];
        if (last?.role !== "user") return ms;
        // Turned away before it was saved: the message comes back to the box to send again later.
        setDraft(textOf(last));
        return ms.slice(0, -1);
      });
    },
  });

  const busy = chat.status === "submitted" || chat.status === "streaming";
  useEffect(() => {
    shown.current = { id: thread?.id ?? null, busy };
  }, [thread, busy]);

  /** After an answer stopped early: the thread as the server saved it, once its turn is over, unless the phone has moved on. */
  const resync = useCallback(
    async (id: string) => {
      const moved = () => shown.current.id !== id || shown.current.busy;
      for (let i = 0; i < RESYNC_TRIES; i++) {
        await new Promise((r) => setTimeout(r, i ? RESYNC_MS : 1_000));
        if (moved()) return;
        let saved: { thread: ChatThread; messages: ChatMessage[] };
        try {
          saved = await api<{ thread: ChatThread; messages: ChatMessage[] }>(`/api/maple/chat?thread=${encodeURIComponent(id)}`);
        } catch {
          // Never saved (404), or offline: what's on screen stays.
          return;
        }
        if (saved.thread.busy) continue;
        if (moved()) return;
        chat.setMessages(saved.messages);
        setProblem((p) => (p === DROPPED ? null : p));
        setHelp(needsHelpCard(saved.messages, lastSent.current, names));
        void refresh();
        return;
      }
    },
    [api, chat, refresh, names]
  );

  // Opening: the thread from the last six hours, else a new one.
  useEffect(() => {
    if (!open) return;
    if (thread && Date.now() - usedAt.current < REOPEN_MS) return;
    let live = true;
    (async () => {
      try {
        const { threads } = await api<{ threads: ChatThread[] }>("/api/maple/chat");
        const latest = threads[0];
        if (latest && Date.now() - Date.parse(latest.updated_at) < REOPEN_MS) {
          const { messages } = await api<{ messages: ChatMessage[] }>(`/api/maple/chat?thread=${encodeURIComponent(latest.id)}`);
          if (live) setThread({ id: latest.id, initial: messages });
          usedAt.current = Date.parse(latest.updated_at);
          return;
        }
      } catch {
        // No list (offline, or the log is down): a new thread, and sending will say what's wrong.
      }
      if (live) setThread({ id: newThreadId(), initial: [] });
      usedAt.current = Date.now();
    })();
    return () => {
      live = false;
    };
    // `thread` only decides whether to look; it changes because of this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, api]);

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || busy || !thread) return;
      const crisis = mentionsCrisis(text, names);
      if (!online) {
        setProblem("Needs a connection. Logging still works from the buttons.");
        setHelp(crisis);
        return;
      }
      if (text.length > CHAT_MAX_CHARS) {
        setProblem(`That's over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters. Try a shorter message.`);
        setHelp(crisis);
        return;
      }
      setProblem(null);
      setHelp(false);
      helpArrived.current = false;
      setDraft("");
      usedAt.current = Date.now();
      lastSent.current = text;
      void chat.sendMessage({ text });
    },
    [busy, chat, online, thread, names]
  );

  // A thread that filled up hands the message that didn't fit to the new one.
  useEffect(() => {
    const text = carry.current;
    if (!text || !thread || thread.initial.length) return;
    carry.current = null;
    setProblem(null);
    helpArrived.current = false;
    void chat.sendMessage({ text });
  }, [thread, chat]);

  const newChat = useCallback(() => {
    if (busy) return;
    setProblem(null);
    setHelp(false);
    usedAt.current = Date.now();
    setThread({ id: newThreadId(), initial: [] });
  }, [busy]);

  const remove = useCallback(async () => {
    if (!thread || busy) return;
    try {
      await api(`/api/maple/chat?thread=${encodeURIComponent(thread.id)}`, { method: "DELETE" });
    } catch (e) {
      // Never saved (nothing was sent yet), or already gone: either way it's off this phone too.
      if (!(e instanceof Error && /not found/i.test(e.message))) {
        setProblem(e instanceof Error ? e.message : "Couldn't delete that chat.");
        return;
      }
    }
    setProblem(null);
    setHelp(false);
    setThread({ id: newThreadId(), initial: [] });
  }, [api, busy, thread]);

  return {
    ready: !!thread,
    messages: chat.messages,
    status: chat.status,
    busy,
    problem,
    help,
    clearProblem: () => setProblem(null),
    draft,
    setDraft,
    send,
    newChat,
    remove,
    approve: (id: string, approved: boolean) => void chat.addToolApprovalResponse({ id, approved }),
  };
}
