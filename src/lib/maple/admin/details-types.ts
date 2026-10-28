export type AdminDetailsView = "families" | "people" | "waitlist";
export type AdminDetailsFilter = "all" | "7d" | "30d" | "onboarding" | "setup_complete" | "deleting" | "active7d" | "active30d";

export type AdminFamilyRow = {
  kind: "family";
  id: number;
  createdAt: string;
  status: "onboarding" | "active" | "deleting";
  members: number;
  emailMasked: string | null;
  ref: string | null;
};

export type AdminPersonRow = {
  kind: "person";
  ref: string;
  emailMasked: string;
  familyIds: number[];
  joinedAt: string | null;
  lastSeenAt: string | null;
};

export type AdminWaitlistRow = {
  kind: "waitlist";
  id: number;
  ref: string;
  emailMasked: string;
  createdAt: string;
};

export type AdminDetailsRow = AdminFamilyRow | AdminPersonRow | AdminWaitlistRow;
export type AdminDetails = {
  view: AdminDetailsView;
  page: number;
  pageSize: 25;
  total: number;
  rows: AdminDetailsRow[];
};

export type AdminDetailsOptions = { view: AdminDetailsView; filter: AdminDetailsFilter; page: number };
