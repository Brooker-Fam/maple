/**
 * Em and en dashes out of the chat's text, since the prompt alone doesn't
 * keep GLM from writing them: "Got it — she's on the left" reads "Got it,
 * she's on the left", "3:10–3:40" reads "3:10 to 3:40", and a dash opening
 * a line becomes "- ".
 */

const DASH = /[–—]/;
const RUN = /\s*[–—][\s–—]*/g;
const TAIL = /[\s–—]*$/;

function swap(run: string, left: string, right: string): string {
  const dash = run.search(DASH);
  const lineStart = run.lastIndexOf("\n", dash);
  if (lineStart >= 0) return `${run.slice(0, lineStart + 1)}- `;
  const lineEnd = run.indexOf("\n", dash);
  if (lineEnd >= 0) return run.slice(lineEnd).replace(/[–—]/g, "");
  if (!left) return "";
  if (/\d/.test(left) && /\d/.test(right)) return " to ";
  return /[,.;:!?]/.test(left) ? " " : ", ";
}

/**
 * One text part's deltas, rewritten as they stream. A run of spaces and
 * dashes at the end of a delta waits for the next one (or the end), so a
 * dash split across deltas is still seen whole.
 */
export function dashFilter() {
  let held = "";
  let prev = "";
  return {
    push(delta: string): string {
      const text = held + delta;
      const tail = TAIL.exec(text)?.[0] ?? "";
      const head = text.slice(0, text.length - tail.length);
      held = tail;
      if (!head) return "";
      const out = head.replace(RUN, (run: string, at: number) => swap(run, at > 0 ? head[at - 1] : prev, head[at + run.length] ?? ""));
      prev = out[out.length - 1] ?? prev;
      return out;
    },
    end(): string {
      const rest = held;
      held = "";
      const dash = rest.search(DASH);
      return dash < 0 ? rest : rest.slice(0, dash).replace(/[^\S\n]+$/, "");
    },
  };
}

export function withoutDashes(text: string): string {
  const f = dashFilter();
  return f.push(text) + f.end();
}
