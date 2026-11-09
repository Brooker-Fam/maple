import { useId } from "react";
import { PART_LABEL, PART_LEVEL_LABEL, partChoices, partLevelOf, PARTS, roleCareLevel, type CareLevel, type Part, type PartLevel, type Parts } from "@/lib/maple/access";
import type { Role } from "@/lib/maple/types";
import { cx, Segmented } from "../ui";

export type InviteRole = Exclude<Role, "owner">;

export const SHARING_ROLES: Record<InviteRole, { label: string; description: string }> = {
  photos: {
    label: "Photos only",
    description: "See shared moments, photos and captions. Save or share photos. No baby log, recovery page or chat.",
  },
  viewer: {
    label: "View baby log",
    description: "See moments and the baby's daily log. Read through chat. No recovery page or changes.",
  },
  member: {
    label: "Can log",
    description: "Add and edit the baby log and moments. Also see and add to the recovery page, including medicines, food and check-ins.",
  },
};

/** With her page's own choice beside it (CarePagePicker), a role's description leaves her page out. */
const WITH_PAGE: Record<InviteRole, string> = {
  photos: SHARING_ROLES.photos.description,
  viewer: "See moments and the baby's daily log. Read through chat. No changes.",
  member: "Add and edit the baby log and moments.",
};

export const roleDescription = (role: InviteRole, page: string | null) => (page ? WITH_PAGE[role] : SHARING_ROLES[role].description);

/** `page`: her page's name ("Dana's page") when CarePagePicker sits below, which then says what they get there. */
export default function SharingRolePicker({ value, onChange, disabled = false, page = null }: {
  value: InviteRole;
  onChange: (value: InviteRole) => void;
  disabled?: boolean;
  page?: string | null;
}) {
  const name = useId();
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="mb-2 text-[13px] font-semibold text-mp-ink-2">What they can access</legend>
      {(Object.entries(SHARING_ROLES) as [InviteRole, typeof SHARING_ROLES[InviteRole]][]).map(([role, details]) => (
        <label key={role} className={cx("flex min-h-[52px] cursor-pointer items-start gap-3 rounded-xl border p-3", value === role ? "border-mp-accent bg-mp-accent/5" : "border-mp-line", disabled && "opacity-50")}>
          <input type="radio" name={name} value={role} checked={value === role} onChange={() => onChange(role)} className="mt-1 h-4 w-4 shrink-0 accent-mp-accent" />
          <span>
            <span className="block text-[15px] font-semibold text-mp-ink">{details.label}</span>
            <span className="mt-1 block text-[13px] leading-relaxed text-mp-ink-2">{roleDescription(role, page)}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

const PAGE_CHOICE: Record<CareLevel, string> = { none: "Hidden", view: "Can view", log: "Can add" };

const PAGE_NOTE: Record<CareLevel, string> = {
  none: "They don't see it, and the chat and their assistants leave it out.",
  view: "Her medicines, food and drinks, temperatures and questions for her OB, read only. Not her check-ins.",
  log: "Everything on it, and they can add to it.",
};

/** The level a role starts at on her page, for a new invite or after the role changes (access.ts). */
export const defaultPageLevel = (role: InviteRole): CareLevel => roleCareLevel(role);

/**
 * Her page for one person (access.ts): hidden, read only, or everything.
 * Nothing for photos-only guests, who never see it; view-only guests can at
 * most read it.
 */
export function CarePagePicker({ role, page, value, onChange, disabled = false }: {
  role: InviteRole;
  page: string;
  value: CareLevel;
  onChange: (value: CareLevel) => void;
  disabled?: boolean;
}) {
  if (role === "photos") return null;
  const levels: CareLevel[] = role === "member" ? ["none", "view", "log"] : ["none", "view"];
  return (
    <fieldset disabled={disabled} className={cx("space-y-2", disabled && "opacity-50")}>
      <legend className="mb-2 text-[13px] font-semibold text-mp-ink-2">{page}</legend>
      <Segmented aria-label={page} options={levels.map((level) => ({ value: level, label: PAGE_CHOICE[level] }))} value={value} onChange={onChange} />
      <p className="text-[13px] leading-relaxed text-mp-ink-2">{PAGE_NOTE[value]}</p>
    </fieldset>
  );
}

/** What each part's level gives, under its choice. */
const PART_NOTE: Record<Part, Record<PartLevel, string>> = {
  doctor: {
    none: "They don't see the questions for the doctor or their answers, and the chat and their assistants leave them out.",
    view: "They see the questions and answers, read only.",
    log: "They see the questions and can add, answer and tick them off.",
  },
  moments: {
    none: "No Moments tab, and the chat and their assistants leave moments out.",
    view: "They see moments and photos, read only.",
    log: "They see moments and can add photos and moments.",
  },
  chat: {
    none: "No Chat tab for them.",
    view: "The chat answers their questions but never logs or changes anything.",
    log: "The chat can log for them, as far as the rest of their access goes.",
  },
};

/** The parts a role leaves a choice on (access.ts partChoices): none for owners and photos-only guests. */
export const pickableParts = (role: InviteRole): Part[] => PARTS.filter((part) => partChoices(role, part).length > 1);

/**
 * The parts an owner can turn down for one person below their role
 * (access.ts): the questions for the doctor, moments, the chat. Each offers
 * only the levels the role allows; nothing for photos-only guests.
 * `value`: the levels as stored (a part left out is the role's own).
 */
export function PartsPicker({ role, value, onChange, disabled = false }: {
  role: InviteRole;
  value: Parts | null | undefined;
  onChange: (part: Part, level: PartLevel) => void;
  disabled?: boolean;
}) {
  const parts = pickableParts(role);
  if (!parts.length) return null;
  return (
    <fieldset disabled={disabled} className={cx("space-y-4", disabled && "opacity-50")}>
      <legend className="mb-2 text-[13px] font-semibold text-mp-ink-2">What else they can see and do</legend>
      {parts.map((part) => {
        const level = partLevelOf({ role, parts: value }, part);
        return (
          <div key={part} className="space-y-2">
            <p className="text-[14px] font-medium text-mp-ink">{PART_LABEL[part]}</p>
            <Segmented aria-label={PART_LABEL[part]} options={partChoices(role, part).map((l) => ({ value: l, label: PART_LEVEL_LABEL[part][l] }))} value={level} onChange={(l) => onChange(part, l)} />
            <p className="text-[13px] leading-relaxed text-mp-ink-2">{PART_NOTE[part][level]}</p>
          </div>
        );
      })}
    </fieldset>
  );
}
