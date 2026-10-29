"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, EntryOf } from "@/lib/maple/types";
import { useMaple } from "./useMaple";

type Moment = EntryOf<"moment">;
type Cursor = { started_at: string; id: number };
type Page = { entries: Entry[]; next_cursor: Cursor | null };
const PAGE_SIZE = 100;
const isMoment = (entry: Entry): entry is Moment => entry.kind === "moment";
const sorted = (entries: Moment[]) => entries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || b.id - a.id);

function pageUrl(cursor: Cursor | null) {
  const query = new URLSearchParams({ kind: "moment", limit: String(PAGE_SIZE) });
  if (cursor) {
    query.set("before", cursor.started_at);
    query.set("before_id", String(cursor.id));
  }
  return `/api/maple/entries?${query}`;
}

function merge(entries: Moment[] | null, recent: Moment[], snapshot: string | undefined): Moment[] | null {
  if (!entries) return null;
  const cutoff = snapshot ? Date.parse(snapshot) - 71 * 3600_000 : Infinity;
  const known = new Set(recent.map((entry) => entry.id));
  const byId = new Map(entries.filter((entry) => Date.parse(entry.started_at) <= cutoff || known.has(entry.id)).map((entry) => [entry.id, entry]));
  for (const entry of recent) {
    const previous = byId.get(entry.id);
    if (!previous || Date.parse(entry.updated_at) >= Date.parse(previous.updated_at)) byId.set(entry.id, entry);
  }
  return sorted([...byId.values()]);
}

export function useMoments() {
  const { state, api } = useMaple();
  const [fetched, setFetched] = useState<Moment[] | null>(null);
  const [highlightEntries, setHighlightEntries] = useState<Moment[] | null>(null);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const [error, setError] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pages = useRef(1);
  const sequence = useRef(0);
  const paging = useRef(false);
  const rev = state?.rev;

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true);
    paging.current = false;
    setLoadingMore(false);
    try {
      const [loaded, highlights] = await Promise.all([
        (async () => {
          const entries: Moment[] = [];
          let next: Cursor | null = null;
          for (let page = 0; page < pages.current; page++) {
            const result: Page = await api<Page>(pageUrl(next));
            entries.push(...result.entries.filter(isMoment));
            next = result.next_cursor;
            if (!next) break;
          }
          return { entries, next };
        })(),
        api<{ entries: Entry[] }>("/api/maple/entries?kind=moment&highlights=1"),
      ]);
      if (request !== sequence.current) return;
      setFetched(loaded.entries);
      setHighlightEntries(highlights.entries.filter(isMoment));
      setCursor(loaded.next);
      setError(false);
      setMoreError(false);
    } catch {
      if (request === sequence.current) setError(true);
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }, [api]);

  const invalidate = useCallback(() => { sequence.current++; }, []);

  useEffect(() => {
    void load();
    return invalidate;
  }, [invalidate, load, rev]);

  const loadMore = useCallback(async () => {
    if (!cursor || paging.current || loading) return;
    const request = sequence.current;
    paging.current = true;
    setLoadingMore(true);
    try {
      const result = await api<Page>(pageUrl(cursor));
      if (request !== sequence.current) return;
      setFetched((previous) => [...(previous ?? []), ...result.entries.filter(isMoment)]);
      setCursor(result.next_cursor);
      pages.current++;
      setMoreError(false);
    } catch {
      if (request === sequence.current) setMoreError(true);
    } finally {
      if (request === sequence.current) {
        paging.current = false;
        setLoadingMore(false);
      }
    }
  }, [api, cursor, loading]);

  const recent = useMemo(() => (state?.entries ?? []).filter(isMoment), [state?.entries]);
  const recentSnapshot = state?.me.role === "photos" ? undefined : state?.now;
  const moments = useMemo(() => merge(fetched, recent, recentSnapshot), [fetched, recent, recentSnapshot]);
  const highlights = useMemo(() => merge(highlightEntries, recent, recentSnapshot), [highlightEntries, recent, recentSnapshot]);
  const all = useMemo(() => sorted([...new Map([...(highlights ?? []), ...(moments ?? [])].map((entry) => [entry.id, entry])).values()]), [moments, highlights]);
  return { moments, highlights, all, error, moreError, loading, loadingMore, hasMore: !!cursor, load, loadMore };
}
