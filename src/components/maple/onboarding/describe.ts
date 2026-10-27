import type { Answer, OnboardingView, StepId } from "@/lib/maple/onboarding/steps";

/**
 * Onboarding's answers as one line each, for the chat's confirm chips and
 * the summary. No React here.
 */

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });

export function birthFields(view: OnboardingView): { date: string; time: string; unknownTime: boolean } {
  const baby = view.values.baby;
  if (!baby?.born_at) return { date: "", time: "", unknownTime: false };
  const at = new Date(baby.born_at);
  const zone = { timeZone: view.values.timezone.timezone };
  const date = new Intl.DateTimeFormat("en-CA", { ...zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const time = baby.birth_time_known ? new Intl.DateTimeFormat("en-GB", { ...zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at) : "";
  return { date, time, unknownTime: !baby.birth_time_known };
}

export function dayLabel(key: string): string {
  return DAY.format(new Date(`${key}T12:00:00Z`));
}

export function clockLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

const ROLE = { member: "can log", viewer: "view only" } as const;

export function answerLine(step: StepId, value: unknown): string {
  switch (step) {
    case "welcome":
      return "Terms accepted";
    case "you": {
      const v = value as Answer["you"];
      return v.role_word ? `${v.name}, called ${v.role_word}` : v.name;
    }
    case "timezone": {
      const v = value as Answer["timezone"];
      return `${v.timezone.replace(/_/g, " ")} · ${v.units === "metric" ? "kg, °C" : "lb, oz, °F"}`;
    }
    case "baby_name": {
      const v = value as Answer["baby_name"];
      return v.name ? `${v.name}${v.nickname ? ` (${v.nickname})` : ""}` : "No name picked yet";
    }
    case "birth": {
      const v = value as Answer["birth"];
      if (!v.born) return `Due ${dayLabel(v.due)}`;
      return `Born ${dayLabel(v.date)}${v.time ? ` at ${clockLabel(v.time)}` : ", time not known"}`;
    }
    case "sex": {
      const v = value as Answer["sex"];
      return v.sex === "female" ? "Girl" : v.sex === "male" ? "Boy" : "Prefer not to say";
    }
    case "feeding": {
      const v = value as Answer["feeding"];
      const on = [v.nursing && "Nursing", v.pumping && "Pumping", v.formula && "Formula"].filter(Boolean);
      return on.length ? on.join(", ") : "Not sure yet";
    }
    case "invites": {
      const v = value as Answer["invites"];
      return v.people.map((p) => `${p.name} (${ROLE[p.role]})`).join(", ");
    }
    case "care": {
      const v = value as { choice: string };
      return v.choice === "me" ? "A recovery page for you" : v.choice === "later" ? "For someone else, once they join" : "Not now";
    }
    case "pediatrician": {
      const v = value as Answer["pediatrician"];
      return [v.name, v.phone, v.after_hours && `after hours ${v.after_hours}`].filter(Boolean).join(" · ");
    }
    case "notifications":
      return (value as Answer["notifications"]).on ? "Set up after starting" : "Not now";
  }
}

export function savedLine(view: OnboardingView, step: StepId): string | null {
  if (view.done[step] === "skipped") return "Skipped for now";
  if (view.done[step] !== "answered") return null;
  const v = view.values;
  const tz = v.timezone.timezone;
  switch (step) {
    case "you":
      return answerLine("you", { name: v.you.name ?? "", role_word: v.you.role_word });
    case "timezone":
      return answerLine("timezone", v.timezone);
    case "baby_name":
      return answerLine("baby_name", { name: v.baby?.name ?? null, nickname: v.baby?.nickname ?? null });
    case "birth": {
      if (v.baby?.born_at) {
        const at = new Date(v.baby.born_at);
        const date = new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", year: "numeric" }).format(at);
        const time = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(at);
        return v.baby.birth_time_known ? `Born ${date} at ${time}` : `Born ${date}, time not known`;
      }
      return v.baby?.due_date ? `Due ${dayLabel(v.baby.due_date)}` : null;
    }
    case "sex":
      return answerLine("sex", { sex: v.baby?.sex ?? null });
    case "feeding":
      return v.feeding ? answerLine("feeding", v.feeding) : null;
    case "invites":
      return `${v.invites} invite link${v.invites === 1 ? "" : "s"} made`;
    case "care":
      return v.care ? answerLine("care", { choice: v.care }) : null;
    case "pediatrician":
      return v.pediatrician ? answerLine("pediatrician", v.pediatrician) : null;
    case "notifications":
      return v.notifications ? "Set up after starting" : "Not now";
    default:
      return "Done";
  }
}
