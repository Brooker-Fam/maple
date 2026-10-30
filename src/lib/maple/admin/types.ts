/** What families use, in groups of entry kinds, plus her page and the chat (admin/usage.ts). */
export const ADMIN_FEATURES = ["feeds", "diapers", "sleep", "pumping", "growth", "health", "moments", "notes", "routines", "recovery", "chat"] as const;
export type AdminFeature = (typeof ADMIN_FEATURES)[number];

/** How entries were added (maple_entries.source, grouped). */
export const ADMIN_SOURCES = ["app", "chat", "siri", "assistant", "import"] as const;
export type AdminSource = (typeof ADMIN_SOURCES)[number];

export type AdminUsageCount<K extends string> = { key: K; families: number; entries: number };

/** Aggregate-only response. Family 1 is excluded from every family/member/activity metric; feedback counts include it. */
export type AdminMetrics = {
  generatedAt: string;
  families: {
    total: number;
    signedUp7d: number;
    signedUp30d: number;
    onboarding: number;
    setupComplete: number;
    deleting: number;
  };
  people: { total: number };
  activity: { families7d: number; families30d: number; entries30d: number };
  waitlist: { total: number };
  dailySignups: Array<{ date: string; count: number }>;
  usage: AdminUsage;
  feedback: { total: number; last7d: number; well: number; okay: number; notWell: number };
};

/**
 * Counts only, over the last 30 days unless named otherwise. `features`:
 * families that saved at least one entry in each group and how many, with
 * "recovery" counting her page's entries and "chat" its messages. `logging`:
 * set-up families by how many of the last seven 24-hour periods they saved an
 * entry in. `turnedOn`: families with each feature on now.
 */
export type AdminUsage = {
  logging: { families7d: number; entries7d: number; mostDays: number; someDays: number; noDays: number };
  features: AdminUsageCount<AdminFeature>[];
  sources: AdminUsageCount<AdminSource>[];
  chat: { families30d: number; people30d: number; messages7d: number; messages30d: number };
  turnedOn: { notifications: number; siri: number; recoveryPage: number; memories: number; shared: number };
};
