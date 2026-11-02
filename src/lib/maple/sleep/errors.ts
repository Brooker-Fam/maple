/**
 * The sleep plan's input error, on its own so the pure rules (goals.ts) can
 * throw the same class the store, the route (400) and the tools already
 * handle. store.ts re-exports it.
 */

/** A write that couldn't be made, in words a person can act on (400). */
export class SleepInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SleepInputError";
  }
}
