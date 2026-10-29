export const SIRI_SHORTCUTS = [
  { name: "Maple status", action: "status", description: "Hear the latest update", file: "maple-status.shortcut" },
  { name: "Maple pee", action: "pee", description: "Log a wet diaper", file: "maple-pee.shortcut" },
  { name: "Maple poop", action: "poop", description: "Log a dirty diaper", file: "maple-poop.shortcut" },
  { name: "Maple both", action: "both", description: "Log a wet and dirty diaper", file: "maple-both.shortcut" },
  { name: "Maple left", action: "nurse_left", description: "Nurse on the left", file: "maple-left.shortcut" },
  { name: "Maple right", action: "nurse_right", description: "Nurse on the right", file: "maple-right.shortcut" },
  { name: "Maple switch", action: "switch", description: "Switch nursing sides", file: "maple-switch.shortcut" },
  { name: "Maple back and forth", action: "back_and_forth", description: "Nurse without tracking sides", file: "maple-back-and-forth.shortcut" },
  { name: "Maple stop", action: "stop", description: "Stop the active timer", file: "maple-stop.shortcut" },
  { name: "Maple sleep", action: "sleep", description: "Start a nap", file: "maple-sleep.shortcut" },
  { name: "Maple awake", action: "wake", description: "End a nap", file: "maple-awake.shortcut" },
] as const;
