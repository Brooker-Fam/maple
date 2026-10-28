"use client";

import { useState } from "react";

export function useDraftChanged(value: unknown): boolean {
  const serialized = JSON.stringify(value);
  const [initial] = useState(serialized);
  return serialized !== initial;
}
