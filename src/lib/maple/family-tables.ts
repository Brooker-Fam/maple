/** Tables whose every row belongs to one family. */
export const FAMILY_TABLES = [
  "maple_babies",
  "maple_members",
  "maple_entries",
  "maple_removed",
  "maple_invites",
  "maple_tokens",
  "maple_care_people",
  "maple_care_meds",
  "maple_care_entries",
  "maple_care_mood",
  "maple_push_subs",
  "maple_chat_threads",
  "maple_chat_messages",
  "maple_chat_daily",
  "maple_consents",
] as const;

// The safety net's push claims are shared by every family, and a deleted family's cost rows outlive it, so a
// missing family_id here must stay missing rather than be filed under family 1.
export const FAMILY_OPTIONAL_TABLES = ["maple_push_sent", "maple_ai_usage"] as const;

/** Made with family_id NOT NULL from the start (a cascade from maple_families), so nothing old writes them. */
export const FAMILY_KEYED_TABLES = ["maple_upload_counts", "maple_chat_deliveries", "maple_chat_member_locks"] as const;

/** Not family data: abuse counters, the site's waitlist and its invitation status. */
export const GLOBAL_TABLES = ["upload_rate_limit", "maple_waitlist", "maple_waitlist_outreach"] as const;

export type FamilyTable = (typeof FAMILY_TABLES)[number] | (typeof FAMILY_OPTIONAL_TABLES)[number];
