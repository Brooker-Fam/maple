"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { CHAT_MAX_CHARS, type ChatMessage } from "@/lib/maple/chat/types";
import type { StreamItem } from "@/lib/maple/chat/window";
import { deviceHeaders } from "@/lib/maple/device";
import { shownFamilyHeaders } from "../shownFamily";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import { DROPPED, needsHelpCard, problemFor, refusalOf, textOf, unanswered } from "./stopped";

/** After an answer stops early, the server's copy is looked for this often, for about as long as a turn can hold the thread. */
const RESYNC_MS = 5_000;
const RESYNC_TRIES = 16;
/** Coming back to the tab after this long reads the chat again, so a reply from this person's other phone shows. */
const STALE_MS = 60_000;

type Stream = { current: { id: string; busy: boolean } | null; items: StreamItem[]; more: boolean };

const newThreadId = () => crypto.randomUUID();

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/maple/chat",
  // This install's id, so her "Logged" notice skips the phone the chat ran on; and the family this tab shows.
  headers: () => ({ ...deviceHeaders(), ...shownFamilyHeaders() }),
  // Only the newest message goes up: the server keeps the thread and never takes history from the phone.
  prepareSendMessagesRequest: ({ id, messages }) => ({ body: { threadId: id, message: messages[messages.length - 1] } }),
});

/** Where the current thread's messages start: the newest run of items from it. */
function splitAt(items: StreamItem[], id: string): number {
  let i = items.length;
  while (i > 0 && items[i - 1].thread === id) i--;
  return i;
}

/**
 * This member's one chat: `earlier` is everything above the thread new
 * messages go to (older pages, and threads before her page closed to the
 * chat), read-only; `messages` is that thread, live.
 */
export function useChatThread(active: boolean) {
  const { api, refresh, online, state } = useMaple();
  const { termsNeeded } = useChatNav();
  const babyName = state?.baby.name;
  const babyNickname = state?.baby.nickname;
  const names = useMemo(() => [babyName, babyNickname], [babyName, babyNickname]);
  const [thread, setThread] = useState<{ id: string; initial: ChatMessage[] } | null>(null);
  const [earlier, setEarlier] = useState<StreamItem[]>([]);
  const [more, setMore] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const helpArrived = useRef(false);
  const [draft, setDraft] = useState("");
  const readAt = useRef(0);
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
      // An answer that stopped early refreshes once the server has saved it (resync).
      if (!isError) void refresh();
    },
    onError: (err) => {
      const refusal = refusalOf(err.message);
      if (refusal?.code === "new_chat" && thread) {
        // Her page closed to the chat: this thread stays on screen above, and the message that was turned away goes to a new one.
        const ms = chat.messages;
        const turnedAway = ms[ms.length - 1]?.role === "user";
        carry.current = turnedAway ? lastSent.current : null;
        const kept = turnedAway ? ms.slice(0, -1) : ms;
        setEarlier((e) => [...e, ...kept.map((message) => ({ thread: thread.id, message }))]);
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

  /** The newest page as the server has it: the current thread live, the rest above it. */
  const apply = useCallback(
    (s: Stream) => {
      const id = s.current?.id ?? newThreadId();
      const at = splitAt(s.items, id);
      const mine = s.items.slice(at).map((i) => i.message);
      setEarlier(s.items.slice(0, at));
      setMore(s.more);
      readAt.current = Date.now();
      if (shown.current.id === id) chat.setMessages(mine);
      else setThread({ id, initial: mine });
      return s.current?.busy ? id : null;
    },
    [chat]
  );

  /** After an answer stopped early: the chat as the server saved it, once its turn is over, unless the phone has moved on. */
  const resync = useCallback(
    async (id: string) => {
      const moved = () => shown.current.id !== id || shown.current.busy;
      for (let i = 0; i < RESYNC_TRIES; i++) {
        await new Promise((r) => setTimeout(r, i ? RESYNC_MS : 1_000));
        if (moved()) return;
        let s: Stream;
        try {
          s = await api<Stream>("/api/maple/chat");
        } catch {
          // Offline, or the log is down: what's on screen stays.
          return;
        }
        if (s.current?.id === id && s.current.busy) continue;
        if (moved()) return;
        apply(s);
        setProblem((p) => (p === DROPPED ? null : p));
        setHelp(needsHelpCard(s.items.map((x) => x.message), lastSent.current, names));
        void refresh();
        return;
      }
    },
    [api, apply, refresh, names]
  );

  // Showing the tab: the chat as the server has it, first time and after a while away. A turn still running there is waited for.
  useEffect(() => {
    if (!active || busy || (thread && Date.now() - readAt.current < STALE_MS)) return;
    let live = true;
    api<Stream>("/api/maple/chat")
      .then((s) => {
        if (!live || shown.current.busy) return;
        const running = apply(s);
        if (running) void resync(running);
      })
      .catch(() => {
        // Offline, or the log is down: a new thread if there's none yet, and sending says what's wrong.
        if (live && !thread) setThread({ id: newThreadId(), initial: [] });
      });
    return () => {
      live = false;
    };
    // `thread` and `busy` only decide whether to look; reading changes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, api]);

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
      lastSent.current = text;
      void chat.sendMessage({ text });
    },
    [busy, chat, online, thread, names]
  );

  // A new thread (her page closed to the chat) takes the message the old one turned away.
  useEffect(() => {
    const text = carry.current;
    if (!text || !thread || thread.initial.length) return;
    carry.current = null;
    setProblem(null);
    helpArrived.current = false;
    void chat.sendMessage({ text });
  }, [thread, chat]);

  const loadEarlier = useCallback(async () => {
    const oldest = earlier[0]?.message.id ?? chat.messages[0]?.id;
    if (!oldest || loadingEarlier) return;
    setLoadingEarlier(true);
    try {
      const s = await api<Stream>(`/api/maple/chat?before=${encodeURIComponent(oldest)}`);
      setEarlier((e) => [...s.items, ...e]);
      setMore(s.more);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load earlier messages.");
    } finally {
      setLoadingEarlier(false);
    }
  }, [api, chat.messages, earlier, loadingEarlier]);

  const remove = useCallback(async () => {
    if (busy) return;
    try {
      await api("/api/maple/chat", { method: "DELETE" });
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't delete the chat.");
      return;
    }
    setProblem(null);
    setHelp(false);
    setEarlier([]);
    setMore(false);
    setThread({ id: newThreadId(), initial: [] });
  }, [api, busy]);

  return {
    ready: !!thread,
    threadId: thread?.id ?? null,
    earlier,
    more,
    loadingEarlier,
    loadEarlier,
    messages: chat.messages,
    status: chat.status,
    busy,
    problem,
    help,
    clearProblem: () => setProblem(null),
    draft,
    setDraft,
    send,
    remove,
    approve: (id: string, approved: boolean) => void chat.addToolApprovalResponse({ id, approved }),
  };
}
