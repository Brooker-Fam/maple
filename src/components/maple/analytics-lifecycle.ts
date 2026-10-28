export const OPEN_IDLE_MS = 30 * 60_000;

export function appOpenTracker(
  send: (familyId: number, eventId: string) => Promise<boolean>,
  newId: () => string = () => crypto.randomUUID(),
) {
  const states = new Map<string, { sent: boolean; pending: string; flight?: Promise<boolean> }>();

  return {
    open(familyId: number, member: string, newSession = false): Promise<boolean> {
      const key = JSON.stringify([familyId, member]);
      let state = states.get(key);
      if (!state || (newSession && state.sent)) {
        state = { sent: false, pending: newId() };
        states.set(key, state);
      }
      if (state.sent) return Promise.resolve(true);
      if (state.flight) return state.flight;
      const current = state;
      current.flight = send(familyId, current.pending).catch(() => false).then((ok) => {
        current.sent = ok;
        current.flight = undefined;
        return ok;
      });
      return current.flight;
    },
  };
}
