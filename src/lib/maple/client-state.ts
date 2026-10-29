import type { Entry, MapleState } from "./types";

type ClientOwner = { family?: { id: number }; me: { email: string; role?: string } };
type QueuedOwner = { client_id: string; family?: number; member?: string };

export function stampOutbox<T extends QueuedOwner>(items: T[], previous: readonly QueuedOwner[], owner: ClientOwner | null): T[] {
  const existing = new Set(previous.map((item) => item.client_id));
  return items.map((item) => {
    if (item.family != null) return item;
    if (existing.has(item.client_id) || !owner) return { ...item, family: 1 };
    return { ...item, family: owner.family?.id ?? 1, member: owner.me.email };
  });
}

export function keepConfirmed<T extends ClientOwner & Pick<MapleState, "entries">>(
  next: T,
  prev: T | null,
  confirmed: Map<number, { updatedAt: string; at: number }>,
  sentAt: number
): T {
  if (!prev || (prev.family?.id ?? 1) !== (next.family?.id ?? 1) || prev.me.email !== next.me.email || prev.me.role !== next.me.role) {
    confirmed.clear();
    return next;
  }
  if (!confirmed.size) return next;
  let changed = false;
  const entries: Entry[] = next.entries.map((e) => {
    const c = confirmed.get(e.id);
    if (!c) return e;
    if (Date.parse(e.updated_at) >= Date.parse(c.updatedAt)) {
      confirmed.delete(e.id);
      return e;
    }
    const mine = prev.entries.find((x) => x.id === e.id);
    if (!mine) return e;
    changed = true;
    return mine;
  });
  for (const [id, c] of confirmed) {
    if (entries.some((e) => e.id === id)) continue;
    const mine = prev.entries.find((x) => x.id === id);
    if (mine && sentAt < c.at) {
      entries.push(mine);
      changed = true;
    } else confirmed.delete(id);
  }
  if (!changed) return next;
  return { ...next, entries: entries.sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)) };
}
