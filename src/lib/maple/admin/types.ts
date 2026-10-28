/** Aggregate-only response. Family 1 is excluded from every family/member/activity metric. */
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
};
