/**
 * Shared types for Maple's Log (/maple), the family newborn tracker.
 *
 * Isomorphic: imported by the client app, the REST routes, and the MCP tools,
 * so keep this file free of node or browser APIs.
 *
 * Storage is metric (grams, cm, °C, ml); the UI converts to lb/oz, inches,
 * °F and fl oz by default.
 */

export type Side = "L" | "R";

export const ENTRY_KINDS = [
  "feed",
  "pump",
  "diaper",
  "sleep",
  "growth",
  "temp",
  "vitals",
  "med",
  "tummy",
  "bath",
  "moment",
  "note",
] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

/** Kinds that can run as a live timer (active = true, ended_at = null). */
export const TIMER_KINDS = ["feed", "sleep", "tummy", "pump"] as const;
export type TimerKind = (typeof TIMER_KINDS)[number];

export type Segment = { side: Side; start: string; end: string | null };

export type FeedData = {
  method: "breast" | "bottle";
  /** Breast timers record each stretch on a side; manual entries may skip these. */
  segments?: Segment[];
  left_sec?: number;
  right_sec?: number;
  first_side?: Side;
  last_side?: Side;
  /** Bottle volume. */
  amount_ml?: number;
  milk?: "breastmilk" | "formula" | "mixed";
};

export type PumpData = { left_ml?: number; right_ml?: number; total_ml?: number };

export const STOOL_COLORS = [
  "black",
  "green",
  "yellow",
  "mustard",
  "brown",
  "orange",
  "pale_yellow",
  "gray",
  "white",
  "red",
] as const;
export type StoolColor = (typeof STOOL_COLORS)[number];

export const STOOL_TEXTURES = ["seedy", "runny", "pasty", "sticky", "mucousy", "hard"] as const;
export type StoolTexture = (typeof STOOL_TEXTURES)[number];

export const DIAPER_SIZES = ["small", "medium", "big", "blowout"] as const;
export type DiaperSize = (typeof DIAPER_SIZES)[number];

export type DiaperData = {
  pee: boolean;
  poop: boolean;
  color?: StoolColor;
  texture?: StoolTexture;
  size?: DiaperSize;
  rash?: boolean;
};

export const SLEEP_PLACES = ["bassinet", "crib", "arms", "carrier", "stroller", "car", "bed"] as const;
export type SleepPlace = (typeof SLEEP_PLACES)[number];
export type SleepData = { place?: SleepPlace };

export type GrowthData = {
  weight_g?: number;
  length_cm?: number;
  head_cm?: number;
  at?: "home" | "doctor";
};

export const TEMP_METHODS = ["rectal", "armpit", "forehead", "ear"] as const;
export type TempMethod = (typeof TEMP_METHODS)[number];
export type TempData = { temp_c: number; method?: TempMethod };

/** How far yellow (jaundice) has spread, from a daylight skin check. */
export const JAUNDICE_LEVELS = ["none", "face", "eyes", "chest", "legs", "deep"] as const;
export type JaundiceLevel = (typeof JAUNDICE_LEVELS)[number];

export type VitalsData = { heart_bpm?: number; resp_rate?: number; spo2?: number; jaundice?: JaundiceLevel };

export type MedData = { name: string; dose?: string };

/**
 * A photo on a moment. The blob keys stay on the server: API responses omit
 * `key`/`thumb_key`, and clients load images by position through
 * /api/maple/photo?entry=<id>&i=<index>&size=thumb|full.
 */
export type PhotoRef = {
  key?: string;
  thumb_key?: string;
  w?: number;
  h?: number;
  access?: "public" | "private";
};
export type MomentData = { title?: string; milestone?: string; photos?: PhotoRef[] };

export const NOTE_TAGS = ["spitup", "hiccups", "fussy", "gas", "nails", "cord", "other"] as const;
export type NoteTag = (typeof NOTE_TAGS)[number];

/** Everyday notes (spit-up, hiccups…) and questions for the doctor (for_doctor). */
export type NoteData = {
  tag?: NoteTag;
  amount?: "little" | "some" | "lots";
  for_doctor?: boolean;
  /** A doctor question that's been asked/answered. */
  done?: boolean;
  answer?: string;
};

export type EmptyData = Record<string, never>;

export type EntryDataByKind = {
  feed: FeedData;
  pump: PumpData;
  diaper: DiaperData;
  sleep: SleepData;
  growth: GrowthData;
  temp: TempData;
  vitals: VitalsData;
  med: MedData;
  tummy: EmptyData;
  bath: EmptyData;
  moment: MomentData;
  note: NoteData;
};

export type Source = "web" | "claude" | "chatgpt" | "mcp" | "shortcut";

type EntryBase<K extends EntryKind> = {
  id: number;
  kind: K;
  /** ISO timestamp (UTC). */
  started_at: string;
  ended_at: string | null;
  /** A timer that is still running. */
  active: boolean;
  data: EntryDataByKind[K];
  note: string | null;
  created_by: string | null;
  /** Who last edited, deleted or restored it (null if never). */
  updated_by: string | null;
  source: Source;
  created_at: string;
  updated_at: string;
};

export type Entry = { [K in EntryKind]: EntryBase<K> }[EntryKind];
export type EntryOf<K extends EntryKind> = EntryBase<K>;

export type Baby = {
  id: number;
  name: string;
  nickname: string | null;
  sex: "female" | "male" | null;
  /** 'YYYY-MM-DD' */
  due_date: string | null;
  /** ISO timestamp, null until she's born. */
  born_at: string | null;
  birth_weight_g: number | null;
  birth_length_cm: number | null;
  birth_head_cm: number | null;
  timezone: string;
  settings: Record<string, unknown>;
};

/** owner: everything incl. invites; member: can log; viewer: read-only (for relatives who just want to peek). */
export type Role = "owner" | "member" | "viewer";

export type Member = {
  email: string;
  role: Role;
  display_name: string | null;
  emoji: string | null;
  color: string | null;
};

export type Me = Member;

/** GET /api/maple/state */
export type MapleState = {
  /** Server time, ISO. Clients use it to correct clock skew for timers. */
  now: string;
  baby: Baby;
  me: Me;
  members: Member[];
  /** Last ~72h of entries plus any running timers, newest first. */
  entries: Entry[];
  /** Every growth entry, oldest first (small, and charts need them all). */
  growth: Entry[];
  /** Lifetime counts, for celebrations ("Diaper #100!"). */
  lifetime: { diapers: number; feeds: number };
  /** Opaque change token; pass back as ?rev= to get { unchanged: true }. */
  rev: string;
  /**
   * When this member was last here before this visit (ISO), for the "While
   * you slept" recap. Only meaningful on the first poll of a visit.
   */
  seen_at: string | null;
};

export type MapleStateUnchanged = { unchanged: true; now: string; rev: string };

/** POST /api/maple/entries */
export type CreateEntryInput = {
  kind: EntryKind;
  /** Client-generated id (UUID) so retries from a flaky connection never double-log. */
  client_id?: string;
  started_at?: string;
  ended_at?: string | null;
  data?: Record<string, unknown>;
  note?: string | null;
};

/** PATCH /api/maple/entries?id= */
export type UpdateEntryInput = {
  started_at?: string;
  ended_at?: string | null;
  data?: Record<string, unknown>;
  note?: string | null;
};

/** reopen: undo a stop (the timer runs again as if never stopped). */
export type TimerAction = "start" | "switch" | "pause" | "resume" | "stop" | "discard" | "adjust" | "reopen";

/** POST /api/maple/timer */
export type TimerInput = {
  action: TimerAction;
  /** start: which timer. */
  kind?: TimerKind;
  /** start/switch/resume for breastfeeding. */
  side?: Side;
  /** switch/pause/resume/stop/discard/adjust: which running entry. */
  id?: number;
  /**
   * stop: when it actually ended (ISO, default now; for "ended earlier…").
   * adjust: the corrected start time (forgot to tap at latch).
   */
  at?: string;
  /** start: client-generated id for idempotency. */
  client_id?: string;
};

export type UnitSystem = "us" | "metric";
