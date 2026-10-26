"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithApprovalResponses } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import { CHAT_MAX_CHARS, type ChatMessage, type ChatRefusal, type ChatThread } from "@/lib/maple/chat/types";
import { useMaple } from "../useMaple";

/** A thread touched within this long reopens with the sheet; after it, a new one starts. */
const REOPEN_MS = 6 * 60 * 60_000;

const newThreadId = () => crypto.randomUUID();

/** A refused POST arrives as the response body's text (DefaultChatTransport); an error mid-answer is plain text. */
function refusalOf(message: string): ChatRefusal | null {
  try {
    const b = JSON.parse(message) as Partial<ChatRefusal>;
    return typeof b?.error === "string" ? (b as ChatRefusal) : null;
  } catch {
    return null;
  }
}

const textOf = (m: ChatMessage) => m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");

const transport = new DefaultChatTransport<ChatMessage>({
  api: "/api/maple/chat",
  // Only the newest message goes up: the server keeps the thread and never takes history from the phone.
  prepareSendMessagesRequest: ({ id, messages }) => ({ body: { threadId: id, message: messages[messages.length - 1] } }),
});

export function useChatThread(open: boolean) {
  const { api, refresh, online } = useMaple();
  const [thread, setThread] = useState<{ id: string; initial: ChatMessage[] } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const usedAt = useRef(0);
  const lastSent = useRef<string | null>(null);
  const carry = useRef<string | null>(null);

  const chat = useChat<ChatMessage>({
    id: thread?.id,
    messages: thread?.initial,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onFinish: () => {
      usedAt.current = Date.now();
      void refresh();
    },
    onError: (err) => {
      const refusal = refusalOf(err.message);
      if (refusal?.code === "new_chat") {
        carry.current = lastSent.current;
        setThread({ id: newThreadId(), initial: [] });
        return;
      }
      setProblem(refusal?.error ?? (err.message || "Something went wrong. Check Today before trying again."));
      if (!refusal) return;
      // Turned away before it was saved: the message comes back to the box to send again later.
      chat.setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (last?.role !== "user") return ms;
        setDraft(textOf(last));
        return ms.slice(0, -1);
      });
    },
  });

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

  const busy = chat.status === "submitted" || chat.status === "streaming";

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text || busy || !thread) return;
      if (!online) {
        setProblem("Needs a connection. Logging still works from the buttons.");
        return;
      }
      if (text.length > CHAT_MAX_CHARS) {
        setProblem(`That's over ${CHAT_MAX_CHARS.toLocaleString("en-US")} characters. Try a shorter message.`);
        return;
      }
      setProblem(null);
      setDraft("");
      usedAt.current = Date.now();
      lastSent.current = text;
      void chat.sendMessage({ text });
    },
    [busy, chat, online, thread]
  );

  // A thread that filled up hands the message that didn't fit to the new one.
  useEffect(() => {
    const text = carry.current;
    if (!text || !thread || thread.initial.length) return;
    carry.current = null;
    setProblem(null);
    void chat.sendMessage({ text });
  }, [thread, chat]);

  const newChat = useCallback(() => {
    if (busy) return;
    setProblem(null);
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
    setThread({ id: newThreadId(), initial: [] });
  }, [api, busy, thread]);

  return {
    ready: !!thread,
    messages: chat.messages,
    status: chat.status,
    busy,
    problem,
    clearProblem: () => setProblem(null),
    draft,
    setDraft,
    send,
    newChat,
    remove,
    approve: (id: string, approved: boolean) => void chat.addToolApprovalResponse({ id, approved }),
  };
}
