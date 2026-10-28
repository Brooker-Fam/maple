"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CareEntry, Entry } from "@/lib/maple/types";
import { useMaple } from "../useMaple";

type Lookup<T> = { entry: T; deleted: boolean };

/** Read the exact scoped record, including its deletion state. Absence from the 72h app state proves nothing. */
export function useChatEntry<T extends Entry | CareEntry>(target: "baby" | "care", id: number, allowed = true) {
  const { api, state, online } = useMaple();
  const element = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; data: Lookup<T> | null; failed: boolean; loading: boolean } | null>(null);
  const key = `${state?.family?.id ?? 1}:${state?.me?.email ?? ""}:${target}:${id}`;
  const request = useRef(0);

  useEffect(() => {
    const el = element.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "100px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [allowed]);

  useEffect(() => {
    if (!visible || !allowed || !online) return;
    let live = true;
    const run = ++request.current;
    setResult((old) => ({ key, data: old?.key === key ? old.data : null, failed: false, loading: true }));
    api<Lookup<T>>(`/api/maple/chat/entry?target=${target}&id=${id}`)
      .then((data) => {
        if (!live || run !== request.current) return;
        if (!data?.entry || data.entry.id !== id || typeof data.deleted !== "boolean") throw new Error("Unavailable entry");
        setResult({ key, data, failed: false, loading: false });
      })
      .catch(() => { if (live && run === request.current) setResult({ key, data: null, failed: true, loading: false }); });
    return () => { live = false; };
  }, [api, id, key, target, visible, allowed, online, state?.rev, attempt]);

  const mine = allowed && result?.key === key ? result : null;
  const setDeleted = useCallback((deleted: boolean) => {
    request.current++;
    setResult((old) => old?.key === key && old.data ? { ...old, data: { ...old.data, deleted }, failed: false, loading: false } : old);
  }, [key]);
  return {
    element,
    data: mine?.data ?? null,
    loading: mine?.loading ?? (allowed && online),
    failed: mine?.failed ?? false,
    ready: !!mine?.data && !mine.failed && !mine.loading && online,
    check: () => setAttempt((n) => n + 1),
    setDeleted,
  };
}
