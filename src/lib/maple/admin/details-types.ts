import type { FeedbackRating, FeedbackTopic, FeedbackVia } from "../feedback/types";
import type { Role } from "../types";
import type { AdminFamilyUsage, AdminPersonUsage } from "./usage";

export type AdminDetailsView = "families" | "people" | "feedback" | "waitlist";
export type AdminDetailsFilter = "all" | "7d" | "30d" | "onboarding" | "setup_complete" | "deleting" | "active7d" | "active30d" | "logged7d" | "chat30d";

export type AdminFamilyRow = {
  kind: "family";
  id: number;
  createdAt: string;
  status: "onboarding" | "active" | "deleting";
  members: number;
  emailMasked: string | null;
  ref: string | null;
  usage: AdminFamilyUsage;
};

export type AdminPersonRow = {
  kind: "person";
  ref: string;
  emailMasked: string;
  familyIds: number[];
  joinedAt: string | null;
  lastSeenAt: string | null;
  usage: AdminPersonUsage;
};

/** One message someone sent (feedback/store.ts): the words in full, the sender masked until revealed. */
export type AdminFeedbackRow = {
  kind: "feedback";
  id: number;
  familyId: number;
  createdAt: string;
  role: Role;
  via: FeedbackVia;
  topic: FeedbackTopic | null;
  rating: FeedbackRating | null;
  message: string | null;
  emailed: boolean;
  emailMasked: string | null;
  ref: string | null;
};

export type AdminWaitlistRow = {
  kind: "waitlist";
  id: number;
  ref: string;
  emailMasked: string;
  createdAt: string;
};

export type AdminDetailsRow = AdminFamilyRow | AdminPersonRow | AdminFeedbackRow | AdminWaitlistRow;
export type AdminDetails = {
  view: AdminDetailsView;
  page: number;
  pageSize: 25;
  total: number;
  rows: AdminDetailsRow[];
};

export type AdminDetailsOptions = { view: AdminDetailsView; filter: AdminDetailsFilter; page: number };
