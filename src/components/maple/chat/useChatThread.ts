"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, getToolName, isToolUIPart, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CHAT_MAX_IMAGES, isChatImage, type ChatImage } from "@/lib/maple/chat/images";
import { mentionsCrisis } from "@/lib/maple/chat/crisis";
import { CHAT_MAX_CHARS, type ChatMessage } from "@/lib/maple/chat/types";
import type { StreamItem } from "@/lib/maple/chat/window";
import { deviceHeaders } from "@/lib/maple/device";
import { shownFamilyHeaders } from "../shownFamily";
import { useMaple } from "../useMaple";
import { useChatNav } from "./ChatNav";
import { DROPPED, needsHelpCard, problemFor, refusalOf, textOf, unanswered } from "./stopped";
import { hasQuestionAnswer, type QuestionAnswer } from "./progress";
import { CHAT_QUEUE_LIMIT, emptyQueue, queueScope, readChatQueue, replyFailed, waitingForAnswer, writeChatQueue, type ChatQueue, type QueuedMessage } from "./queue";

/** After an answer stops early, the server's copy is looked for this often, for about as long as a turn can hold the thread. */
const RESYNC_MS = 5_000;
const RESYNC_TRIES = 16;
type Delivery = { requestId: string; state: "missing" | "received" | "completed" | "cancelled"; threadId: string | null; busy: boolean };
type Stream = { current: { id: string; busy: boolean } | null; items: StreamItem[]; more: boolean; delivery?: Delivery };

const newThreadId = () => crypto.randomUUID();

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/maple/chat",
  // This install's id, so her "Logged" notice skips the phone the chat ran on; and the family this tab shows.
  headers: () => ({ ...deviceHeaders(), ...shownFamilyHeaders() }),
  // Only the newest message goes up: the server keeps the thread and never takes history from the phone.
  prepareSendMessagesRequest: ({ id, messages, body }) => ({ body: { threadId: id, message: messages[messages.length - 1],
    ...(messages.at(-1)?.role === "user" ? { requestId: body?.requestId, submittedAt: body?.submittedAt } : {}),
  } }),
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
  const scope = queueScope(state?.family?.id ?? 1, state?.me?.email ?? "");
  const [outbox, setOutbox] = useState<ChatQueue>(() => readChatQueue(scope));
  const outboxRef = useRef(outbox);
  const loadedScope = useRef(scope);
  const [storageProblem, setStorageProblem] = useState(false);
  const inflightRequest = useRef<string | null>(outbox.items.find((item) => item.state === "uncertain")?.requestId ?? null);
  const skipQuestion = useRef(false);
  const cancelling = useRef(new Set<string>());
  const updateQueue = useCallback((change: (value: ChatQueue) => ChatQueue) => {
    const changed = change(outboxRef.current);
    const next = changed.items.length ? changed : { ...changed, paused: false };
    outboxRef.current = next;
    setOutbox(next);
    setStorageProblem(!writeChatQueue(scope, next));
  }, [scope]);
  const draft = outbox.draft;
  const setDraft = useCallback((value: string | ((previous: string) => string)) => {
    updateQueue((q) => ({ ...q, draft: typeof value === "function" ? value(q.draft) : value }));
  }, [updateQueue]);
  const addDraftImage = useCallback((image: ChatImage, expectedScope: string) => {
    if (loadedScope.current !== expectedScope || scope !== expectedScope) return;
    updateQueue((q) => ({ ...q, draftImages: [...(q.draftImages ?? []), image].slice(0, CHAT_MAX_IMAGES), imageProblem: undefined }));
  }, [scope, updateQueue]);
  const removeDraftImage = (url: string) => updateQueue((q) => ({ ...q, draftImages: q.draftImages?.filter((image) => image.url !== url) }));
  const lastSent = useRef<string | null>(null);
  const shown = useRef<{ id: string | null; busy: boolean }>({ id: null, busy: false });
  const recoveryRun = useRef(0);
  const questionSent = useRef<{ message: ChatMessage; toolCallId: string } | null>(null);
  const approvalQueued = useRef(false);
  const [responding, setResponding] = useState(false);

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
    onFinish: ({ isError, isAbort, isDisconnect, messages }) => {
      // An answer that stopped early refreshes once the server has saved it (resync).
      if (!isError && !isAbort && !isDisconnect) {
        setResponding(false);
        const requestId = inflightRequest.current;
        inflightRequest.current = null;
        updateQueue((q) => ({ ...q, items: q.items.filter((item) => item.requestId !== requestId), paused: q.paused || replyFailed(messages) }));
        questionSent.current = null;
        void refresh();
      } else if (!isError && thread) {
        updateQueue((q) => ({ ...q, paused: true, items: q.items.map((item) => item.requestId === inflightRequest.current ? { ...item, state: "uncertain" } : item) }));
        void resync(thread.id);
      }
    },
    onError: (err) => {
      const refusal = refusalOf(err.message);
      if (refusal?.code === "new_chat" && thread) {
        setResponding(false);
        // Her page closed to the chat: this thread stays on screen above, and the message that was turned away goes to a new one.
        const ms = chat.messages;
        const turnedAway = ms[ms.length - 1]?.role === "user";
        const requestId = inflightRequest.current;
        inflightRequest.current = null;
        updateQueue((q) => ({ ...q, items: q.items.map((item) => item.requestId === requestId ? { ...item, state: "queued", threadId: undefined } : item) }));
        questionSent.current = null;
        const kept = turnedAway ? ms.slice(0, -1) : ms;
        setEarlier((e) => [...e, ...kept.map((message) => ({ thread: thread.id, message }))]);
        setThread({ id: newThreadId(), initial: [] });
        return;
      }
      if (refusal?.code === "terms") termsNeeded();
      setProblem(problemFor(err.message));
      const queued = outboxRef.current.items.some((item) => item.requestId === inflightRequest.current);
      if (queued) {
        const requestId = inflightRequest.current;
        const refusedBusy = refusal?.code === "busy";
        updateQueue((q) => ({ ...q, paused: q.paused || !refusedBusy, items: q.items.map((item) => item.requestId === requestId ? { ...item, state: refusedBusy ? "queued" : "uncertain", problem: refusedBusy ? "Waiting for the previous reply to finish." : "Checking whether this message was received…" } : item) }));
        if (refusedBusy) inflightRequest.current = null;
      }
      // No answer, or one cut off before its card: the help card shows here instead.
      if (!helpArrived.current && (refusal?.help === "crisis" || (lastSent.current != null && mentionsCrisis(lastSent.current, names)))) setHelp(true);
      if (thread) void resync(thread.id);
      if (!refusal || queued) return;
      chat.setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (last?.role === "assistant") {
          const question = questionSent.current;
          questionSent.current = null;
          return [...ms.slice(0, -1), unanswered(question?.message.id === last.id ? question.message : last)];
        }
        if (last?.role !== "user") return ms;
        // Turned away before it was saved: the message comes back to the box to send again later.
        updateQueue((q) => ({ ...q, draft: q.draft || textOf(last), draftImages: q.draftImages?.length ? q.draftImages : last.parts.filter(isChatImage) }));
        return ms.slice(0, -1);
      });
    },
  });

  const streaming = chat.status === "submitted" || chat.status === "streaming";
  const busy = streaming || responding || recoveryId != null || loadingHistory || outbox.items.some((item) => item.state === "sending" || item.state === "uncertain" || item.state === "cancelling");
  useEffect(() => {
    shown.current = { id: thread?.id ?? null, busy: streaming };
  }, [thread, streaming]);
  useEffect(() => () => { recoveryRun.current++; }, []);
  useEffect(() => {
    if (!online && outboxRef.current.items.length) updateQueue((q) => ({ ...q, paused: true }));
  }, [online, updateQueue]);
  useEffect(() => {
    if (loadedScope.current === scope) return;
    loadedScope.current = scope;
    const next = readChatQueue(scope);
    outboxRef.current = next;
    setOutbox(next);
    inflightRequest.current = next.items.find((item) => item.state === "uncertain")?.requestId ?? null;
    recoveryRun.current++;
    setThread(null);
    setEarlier([]);
    setRetryVersion((n) => n + 1);
  }, [scope]);
  useEffect(() => {
    const clear = () => {
      const next = emptyQueue();
      outboxRef.current = next;
      setOutbox(next);
      inflightRequest.current = null;
    };
    window.addEventListener("maple:chat-drafts-cleared", clear);
    return () => window.removeEventListener("maple:chat-drafts-cleared", clear);
  }, []);

  const historyUrl = () => {
    const uncertain = outboxRef.current.items.find((item) => item.state === "uncertain" || item.state === "sending");
    return uncertain ? `/api/maple/chat?requestId=${encodeURIComponent(uncertain.requestId)}` : "/api/maple/chat";
  };

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
      const pending = outboxRef.current.items.find((item) => item.state === "uncertain" || item.state === "sending");
      if (pending && s.delivery?.requestId === pending.requestId) {
        if (s.delivery.state === "completed") {
          inflightRequest.current = null;
          updateQueue((q) => ({ ...q, paused: true, items: q.items.filter((item) => item.requestId !== pending.requestId) }));
        } else if (s.delivery.state === "cancelled") {
          inflightRequest.current = null;
          updateQueue((q) => ({ ...q, paused: true, items: q.items.map((item) => item.requestId === pending.requestId ? { ...item, state: "cancelled", problem: "Cancelled before it ran. Edit to send a new version." } : item) }));
        } else if (s.delivery.state === "missing" || !s.delivery.busy) {
          inflightRequest.current = null;
          const missing = s.delivery.state === "missing";
          updateQueue((q) => ({ ...q, paused: true, items: q.items.map((item) => item.requestId === pending.requestId ? {
            ...item, state: missing ? "failed" : "received",
            problem: missing ? "No receipt found yet. Retry safely with the same message." : "This message was received, but its reply didn't finish. Check the log before continuing.",
          } : item) }));
        }
      }
      const running = s.delivery?.busy ? s.delivery.threadId : s.current?.busy ? id : null;
      setRecoveryId(running);
      if (!s.current?.busy) {
        setResponding(false);
        questionSent.current = null;
        setProblem((p) => (p === DROPPED ? null : p));
      }
      if (shown.current.id === id) chat.setMessages(mine);
      else {
        shown.current = { id, busy: false };
        setThread({ id, initial: mine });
      }
      return running;
    },
    [chat, updateQueue]
  );

  /** After an answer stopped early: the chat as the server saved it, once its turn is over, unless the phone has moved on. */
  const resync = useCallback(
    async (id: string) => {
      const run = ++recoveryRun.current;
      setRecoveryId(id);
      setRecoveryPaused(false);
      const moved = () => recoveryRun.current !== run || (shown.current.id !== id && !outboxRef.current.items.some((item) => item.threadId === id && item.state === "uncertain")) || shown.current.busy;
      for (let i = 0; i < RESYNC_TRIES; i++) {
        await new Promise((r) => setTimeout(r, i ? RESYNC_MS : 1_000));
        if (moved()) return;
        let s: Stream;
        try {
          s = await api<Stream>(historyUrl());
        } catch {
          // An uncertain write stays blocked until a read confirms the outcome.
          if (!moved()) {
            setRecoveryPaused(true);
            setHistoryProblem("Couldn't check the last reply. Reconnect or try checking again.");
          }
          return;
        }
        if ((s.current?.id === id && s.current.busy) || s.delivery?.busy) continue;
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
    api<Stream>(historyUrl())
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
    (raw: string, options: { clearDraft?: boolean } = {}) => {
      const text = raw.trim();
      const images = options.clearDraft ? outboxRef.current.draftImages ?? [] : [];
      if ((!text && !images.length) || (options.clearDraft && outboxRef.current.imageProblem)) return;
      const crisis = mentionsCrisis(text, names);
      if (text.length > CHAT_MAX_CHARS) {
        setProblem(`That's over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters. Try a shorter message.`);
        setHelp(crisis);
        return;
      }
      if (outboxRef.current.items.length >= CHAT_QUEUE_LIMIT) {
        setProblem(`There are already ${CHAT_QUEUE_LIMIT} messages waiting. Edit or remove one before adding another.`);
        setHelp(crisis);
        return;
      }
      setProblem(null);
      setHelp(crisis);
      const item: QueuedMessage = { requestId: crypto.randomUUID(), text, ...(images.length ? { images } : {}), submittedAt: new Date().toISOString(), state: "queued" };
      updateQueue((q) => ({ ...q, draft: options.clearDraft && q.draft.trim() === text ? "" : q.draft, draftImages: options.clearDraft ? undefined : q.draftImages, items: [...q.items, item], paused: q.paused || !online }));
    },
    [online, names, updateQueue]
  );

  const awaitingAnswer = waitingForAnswer(chat.messages);
  // One request leaves the queue at a time. Paused/reloaded/uncertain work is
  // never retried here; a person must explicitly resume or retry it.
  useEffect(() => {
    const item = outbox.items[0];
    if (!item || item.state !== "queued" || busy || !thread || !online || historyProblem || outbox.paused || inflightRequest.current || (awaitingAnswer && !skipQuestion.current)) return;
    if (item.threadId && item.threadId !== thread.id) {
      updateQueue((q) => ({ ...q, paused: true, items: q.items.map((x) => x.requestId === item.requestId ? { ...x, state: "failed", problem: "The conversation changed. Edit this message before sending it here." } : x) }));
      return;
    }
    skipQuestion.current = false;
    inflightRequest.current = item.requestId;
    updateQueue((q) => ({ ...q, items: q.items.map((x) => x.requestId === item.requestId ? { ...x, state: "sending", threadId: thread.id, problem: undefined } : x) }));
    setProblem(null);
    questionSent.current = null;
    setHelp(false);
    helpArrived.current = false;
    lastSent.current = item.text;
    chat.clearError();
    void chat.sendMessage({ id: item.requestId, role: "user", parts: [...(item.text ? [{ type: "text" as const, text: item.text }] : []), ...(item.images ?? [])] }, { body: { requestId: item.requestId, submittedAt: item.submittedAt } }).catch(() => {
      updateQueue((q) => ({ ...q, paused: true, items: q.items.map((x) => x.requestId === item.requestId ? { ...x, state: "uncertain" } : x) }));
      void resync(thread.id);
    });
  }, [outbox, busy, thread, online, historyProblem, awaitingAnswer, chat, updateQueue, resync]);

  const retryQueued = (requestId: string) => {
    if (busy || !online) return;
    const item = outboxRef.current.items.find((x) => x.requestId === requestId);
    if (!item || item.state !== "failed" || item.imagesMissing || Date.now() - Date.parse(item.submittedAt) > 7 * 24 * 60 * 60 * 1000) return;
    updateQueue((q) => ({ ...q, paused: false, items: q.items.map((x) => x.requestId === requestId ? { ...x, state: "queued", problem: undefined } : x) }));
  };
  // A missing receipt alone is not proof that a slow POST cannot arrive later.
  // Only the server's atomic cancellation permits changing or discarding an attempted instruction.
  const cancelBeforeChange = async (requestId: string): Promise<boolean> => {
    const item = outboxRef.current.items.find((x) => x.requestId === requestId);
    if (!item || cancelling.current.has(requestId)) return false;
    if (item.state === "cancelled" || (!item.threadId && (item.state === "queued" || item.state === "failed"))) return true;
    if (!online || item.state !== "failed") return false;
    cancelling.current.add(requestId);
    updateQueue((q) => ({ ...q, paused: true, items: q.items.map((x) => x.requestId === requestId ? { ...x, state: "cancelling", problem: "Checking that this message can be cancelled…" } : x) }));
    try {
      const result = await api<{ delivery: Delivery }>("/api/maple/chat/delivery", { method: "POST", body: JSON.stringify({ action: "cancel", requestId, submittedAt: item.submittedAt }) });
      if (result.delivery.state === "cancelled") {
        updateQueue((q) => ({ ...q, items: q.items.map((x) => x.requestId === requestId ? { ...x, state: "cancelled" } : x) }));
        return true;
      }
      inflightRequest.current = requestId;
      updateQueue((q) => ({ ...q, items: q.items.map((x) => x.requestId === requestId ? { ...x, state: "uncertain", problem: "This message was already received. Checking its outcome…" } : x) }));
      setRetryVersion((n) => n + 1);
      return false;
    } catch {
      updateQueue((q) => ({ ...q, items: q.items.map((x) => x.requestId === requestId ? { ...x, state: "failed", problem: "Couldn't confirm cancellation. Your original message is still here." } : x) }));
      return false;
    } finally {
      cancelling.current.delete(requestId);
    }
  };
  const discardQueued = async (requestId: string) => {
    const item = outboxRef.current.items.find((x) => x.requestId === requestId);
    if (item?.state === "received" || await cancelBeforeChange(requestId)) updateQueue((q) => ({ ...q, items: q.items.filter((x) => x.requestId !== requestId) }));
  };
  const editQueued = async (requestId: string, raw: string, images?: ChatImage[]) => {
    const text = raw.trim();
    const item = outboxRef.current.items.find((x) => x.requestId === requestId);
    const attachments = images ?? item?.images ?? [];
    if ((!text && !attachments.length) || text.length > CHAT_MAX_CHARS || attachments.length > CHAT_MAX_IMAGES || !attachments.every(isChatImage)) return false;
    if (!await cancelBeforeChange(requestId)) return false;
    updateQueue((q) => ({ ...q, items: q.items.map((x) => x.requestId === requestId ? { requestId: crypto.randomUUID(), text, ...(attachments.length ? { images: attachments } : {}), submittedAt: new Date().toISOString(), state: "queued" } : x) }));
    return true;
  };
  const resumeQueue = (moveOn = false) => {
    if (busy || !online) return;
    skipQuestion.current = moveOn;
    setProblem(null);
    updateQueue((q) => ({ ...q, paused: false }));
  };

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
    if (outboxRef.current.items.length) {
      setProblem("Finish or discard the waiting messages before deleting chat history.");
      return;
    }
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
    updateQueue(() => emptyQueue());
    window.dispatchEvent(new Event("maple:chat-drafts-cleared"));
    setThread({ id: newThreadId(), initial: [] });
  }, [api, busy, updateQueue]);

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
    setResponding(true);
    lastSent.current = answerText;
    helpArrived.current = false;
    setProblem(null);
    setHelp(false);
    try {
      await chat.addToolOutput({ tool: "ask_user", toolCallId, output: answer });
      return true;
    } catch {
      questionSent.current = null;
      setResponding(false);
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
    checkingDelivery: outbox.items.some((item) => item.state === "uncertain"),
    cancellingDelivery: outbox.items.some((item) => item.state === "cancelling"),
    retryHistory: () => setRetryVersion((n) => n + 1),
    loadEarlier,
    messages: chat.messages,
    status: chat.status,
    busy,
    problem,
    help,
    clearProblem: () => setProblem(null),
    scope,
    draft,
    draftImages: outbox.draftImages ?? [],
    imageProblem: outbox.imageProblem,
    clearImageProblem: () => updateQueue((q) => ({ ...q, imageProblem: undefined })),
    addDraftImage,
    removeDraftImage,
    setDraft,
    send,
    queue: outbox.items,
    queuePaused: outbox.paused,
    queueLimit: CHAT_QUEUE_LIMIT,
    storageProblem,
    awaitingAnswer,
    retryQueued,
    discardQueued,
    editQueued,
    resumeQueue,
    pauseQueue: () => updateQueue((q) => ({ ...q, paused: true })),
    remove,
    answerQuestion,
    approve: (id: string, approved: boolean) => {
      if (busy || approvalQueued.current) return;
      approvalQueued.current = true;
      setResponding(true);
      void chat.addToolApprovalResponse({ id, approved });
    },
  };
}
