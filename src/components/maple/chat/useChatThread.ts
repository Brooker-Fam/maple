"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { CHAT_MAX_CHARS, type ChatMessage } from "@/lib/maple/chat/types";
import type { StreamItem } from "@/lib/maple/chat/window";
import { deviceHeaders } from "@/lib/maple/device";
import { shownFamilyHeaders } from "../shownFamily";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import { DROPPED, needsHelpCard, problemFor, refusalOf, textOf, unanswered } from "./stopped";
import { hasQuestionAnswer, type QuestionAnswer } from "./progress";

/** After an answer stops early, the server's copy is looked for this often, for about as long as a turn can hold the thread. */
const RESYNC_MS = 5_000;
const RESYNC_TRIES = 16;
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
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyProblem, setHistoryProblem] = useState<string | null>(null);
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [recoveryPaused, setRecoveryPaused] = useState(false);
  const [retryVersion, setRetryVersion] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const helpArrived = useRef(false);
  const [draft, setDraft] = useState("");
  const lastSent = useRef<string | null>(null);
  const carry = useRef<string | null>(null);
  const shown = useRef<{ id: string | null; busy: boolean }>({ id: null, busy: false });
  const recoveryRun = useRef(0);
  const questionSent = useRef<{ message: ChatMessage; toolCallId: string } | null>(null);
  const approvalQueued = useRef(false);

  const chat = useChat<ChatMessage>({
    id: thread?.id,
    messages: thread?.initial,
    transport,
    sendAutomaticallyWhen: (opts) => {
      // A tap can be persisted while another question or approval still waits.
      if (approvalQueued.current) {
        approvalQueued.current = false;
        return true;
      }
      return lastAssistantMessageIsCompleteWithApprovalResponses(opts) || hasQuestionAnswer(opts);
    },
    onData: (part) => {
      if (part.type === "data-help") helpArrived.current = true;
    },
    onFinish: ({ isError }) => {
      // An answer that stopped early refreshes once the server has saved it (resync).
      if (!isError) {
        questionSent.current = null;
        void refresh();
      }
    },
    onError: (err) => {
      const refusal = refusalOf(err.message);
      if (refusal?.code === "new_chat" && thread) {
        // Her page closed to the chat: this thread stays on screen above, and the message that was turned away goes to a new one.
        const ms = chat.messages;
        const turnedAway = ms[ms.length - 1]?.role === "user";
        carry.current = turnedAway ? lastSent.current : null;
        questionSent.current = null;
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
        if (last?.role === "assistant") {
          const question = questionSent.current;
          questionSent.current = null;
          return [...ms.slice(0, -1), unanswered(question?.message.id === last.id ? question.message : last)];
        }
        if (last?.role !== "user") return ms;
        // Turned away before it was saved: the message comes back to the box to send again later.
        setDraft((current) => current || textOf(last));
        return ms.slice(0, -1);
      });
    },
  });

  const streaming = chat.status === "submitted" || chat.status === "streaming";
  const busy = streaming || recoveryId != null || loadingHistory;
  useEffect(() => {
    shown.current = { id: thread?.id ?? null, busy: streaming };
  }, [thread, streaming]);
  useEffect(() => () => { recoveryRun.current++; }, []);

  /** The newest page as the server has it: the current thread live, the rest above it. */
  const apply = useCallback(
    (s: Stream) => {
      const id = s.current?.id ?? newThreadId();
      const at = splitAt(s.items, id);
      const mine = s.items.slice(at).map((i) => i.message);
      const same = s.current?.id === shown.current.id;
      const cutoff = mine[0] ? chat.messages.findIndex((m) => m.id === mine[0].id) : -1;
      const olderLive = cutoff > 0 ? chat.messages.slice(0, cutoff).map((message) => ({ thread: id, message })) : [];
      setEarlier((previous) => {
        const freshIds = new Set(s.items.map((i) => i.message.id));
        const kept = same ? [...previous, ...olderLive].filter((i) => !freshIds.has(i.message.id)) : [];
        return [...new Map([...kept, ...s.items.slice(0, at)].map((i) => [i.message.id, i])).values()];
      });
      setMore(s.more);
      setHistoryProblem(null);
      setRecoveryPaused(false);
      setRecoveryId(s.current?.busy ? id : null);
      if (!s.current?.busy) {
        questionSent.current = null;
        setProblem((p) => (p === DROPPED ? null : p));
      }
      if (shown.current.id === id) chat.setMessages(mine);
      else {
        shown.current = { id, busy: false };
        setThread({ id, initial: mine });
      }
      return s.current?.busy ? id : null;
    },
    [chat]
  );

  /** After an answer stopped early: the chat as the server saved it, once its turn is over, unless the phone has moved on. */
  const resync = useCallback(
    async (id: string) => {
      const run = ++recoveryRun.current;
      setRecoveryId(id);
      setRecoveryPaused(false);
      const moved = () => recoveryRun.current !== run || shown.current.id !== id || shown.current.busy;
      for (let i = 0; i < RESYNC_TRIES; i++) {
        await new Promise((r) => setTimeout(r, i ? RESYNC_MS : 1_000));
        if (moved()) return;
        let s: Stream;
        try {
          s = await api<Stream>("/api/maple/chat");
        } catch {
          // An uncertain write stays blocked until a read confirms the outcome.
          if (!moved()) {
            setRecoveryPaused(true);
            setHistoryProblem("Couldn't check the last reply. Reconnect or try checking again.");
          }
          return;
        }
        if (s.current?.id === id && s.current.busy) continue;
        if (moved()) return;
        apply(s);
        questionSent.current = null;
        setProblem((p) => (p === DROPPED ? null : p));
        setHelp(needsHelpCard(s.items.map((x) => x.message), lastSent.current, names));
        void refresh();
        return;
      }
      if (!moved()) {
        setRecoveryPaused(true);
        setHistoryProblem("Your previous reply is taking longer than expected. Check again before sending another message.");
      }
    },
    [api, apply, refresh, names]
  );

  // Opening, reconnecting or explicitly retrying reads only; it never repeats a write.
  useEffect(() => {
    if (!active || streaming) return;
    if (!online) {
      setLoadingHistory(false);
      if (!thread) setHistoryProblem("Connect to load your conversation. Your draft stays here.");
      return;
    }
    let live = true;
    recoveryRun.current++;
    setLoadingHistory(true);
    setHistoryProblem(null);
    api<Stream>("/api/maple/chat")
      .then((s) => {
        if (!live || shown.current.busy) return;
        const running = apply(s);
        if (running) void resync(running);
      })
      .catch(() => {
        if (live) {
          setHistoryProblem("Couldn't load your conversation. Your draft stays here.");
          if (recoveryId) setRecoveryPaused(true);
        }
      })
      .finally(() => {
        if (live) setLoadingHistory(false);
      });
    return () => {
      live = false;
    };
    // Thread and request state only decide whether to look; reading changes them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, api, online, retryVersion]);

  useEffect(() => {
    if (!active) return;
    const check = () => {
      if (document.visibilityState === "visible" && !shown.current.busy) setRetryVersion((n) => n + 1);
    };
    document.addEventListener("visibilitychange", check);
    return () => document.removeEventListener("visibilitychange", check);
  }, [active]);

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
      questionSent.current = null;
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
    if (!oldest || loadingEarlier) return false;
    setLoadingEarlier(true);
    try {
      const s = await api<Stream>(`/api/maple/chat?before=${encodeURIComponent(oldest)}`);
      setEarlier((e) => [...s.items, ...e]);
      setMore(s.more);
      return true;
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "Couldn't load earlier messages.");
      return false;
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

  const answerQuestion = useCallback(async (toolCallId: string, answer: QuestionAnswer): Promise<boolean> => {
    if (busy || !thread || questionSent.current) return false;
    const answerText = "text" in answer ? answer.text : null;
    const crisis = answerText != null && mentionsCrisis(answerText, names);
    if (!online) {
      setProblem("Needs a connection. Your answer hasn't been sent.");
      setHelp(crisis);
      return false;
    }
    const last = chat.messages.at(-1);
    if (last?.role !== "assistant" || !last.parts.some((p) => isToolUIPart(p) && getToolName(p) === "ask_user" && p.toolCallId === toolCallId && p.state === "input-available")) return false;
    questionSent.current = { message: last, toolCallId };
    lastSent.current = answerText;
    helpArrived.current = false;
    setProblem(null);
    setHelp(false);
    try {
      await chat.addToolOutput({ tool: "ask_user", toolCallId, output: answer });
      return true;
    } catch {
      questionSent.current = null;
      setProblem("Couldn't send your answer. Please try again.");
      setHelp(crisis);
      return false;
    }
  }, [busy, thread, online, chat, names]);

  return {
    ready: !!thread,
    threadId: thread?.id ?? null,
    earlier,
    more,
    loadingEarlier,
    loadingHistory,
    historyProblem,
    recovering: recoveryId != null,
    recoveryPaused,
    retryHistory: () => setRetryVersion((n) => n + 1),
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
    answerQuestion,
    approve: (id: string, approved: boolean) => {
      if (busy || approvalQueued.current) return;
      approvalQueued.current = true;
      void chat.addToolApprovalResponse({ id, approved });
    },
  };
}
