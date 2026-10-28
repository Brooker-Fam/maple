/**
 * Internal entry references stay in the conversation and tool results for
 * follow-up edits and Undo. Only the words shown in the chat are cleaned up,
 * including older replies and the accumulated text of a reply still streaming.
 */
const ENTRY_ID = String.raw`(?:#\d+\b|\bc\d+\b)`;
const ENTRY_WORD = String.raw`(?:[Tt]imer|[Ee]ntry)`;

export function chatDisplayText(text: string): string {
  return text
    // An aside containing only an ID has nothing useful left to show.
    .replace(new RegExp(String.raw`[ \t]*\((?:${ENTRY_WORD}[ \t]+)?${ENTRY_ID}[ \t]*\)`, "g"), "")
    .replace(new RegExp(String.raw`[ \t]*\[(?:${ENTRY_WORD}[ \t]+)?${ENTRY_ID}[ \t]*\]`, "g"), "")
    // Keep the useful details when an ID shares an aside with a time or side.
    .replace(new RegExp(String.raw`\((?:${ENTRY_WORD}[ \t]+)?${ENTRY_ID}[ \t]*[,;][ \t]*`, "g"), "(")
    .replace(new RegExp(String.raw`[,;][ \t]*(?:${ENTRY_WORD}[ \t]+)?${ENTRY_ID}(?=[ \t]*\))`, "g"), "")
    .replace(new RegExp(String.raw`\b([Ss]aved|[Uu]pdated|[Dd]eleted|[Rr]estored|[Rr]emoved|[Bb]rought back)[ \t]+${ENTRY_ID}`, "g"), "$1")
    .replace(new RegExp(String.raw`\b(${ENTRY_WORD}|[Ff]eed)[ \t]+${ENTRY_ID}`, "g"), "$1")
    .replace(new RegExp(String.raw`\b([Tt]his|[Tt]hat|[Tt]he)[ \t]+${ENTRY_ID}`, "g"), "$1 entry")
    // Some tool explanations spell the reference as "id 123" instead.
    .replace(new RegExp(String.raw`\b[Ii][Dd][ \t]+(?:${ENTRY_ID}|\d+\b)`, "g"), "this entry")
    .replace(new RegExp(ENTRY_ID, "g"), (_id, at: number, whole: string) =>
      /(?:^|[.!?\n])[ \t]*$/.test(whole.slice(0, at)) ? "This entry" : "this entry"
    );
}

/** The app already supplies the attribution and Undo next to each receipt. */
export function receiptText(line: string): string {
  return chatDisplayText(line)
    .replace(/ \((logged|stopped|started) by [^)]*\)\.?$/, "")
    .replace(/\.$/, "");
}
