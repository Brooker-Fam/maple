import { useId } from "react";
import type { Role } from "@/lib/maple/types";
import { cx } from "../ui";

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

export default function SharingRolePicker({ value, onChange, disabled = false }: {
  value: InviteRole;
  onChange: (value: InviteRole) => void;
  disabled?: boolean;
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
            <span className="mt-1 block text-[13px] leading-relaxed text-mp-ink-2">{details.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
