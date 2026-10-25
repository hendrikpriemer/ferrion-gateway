import type { ZodError } from "zod";

// zod 4 renders `error.message` as the whole issue list as indented JSON,
// so its first line is literally "[". Both stores used to put that straight
// into a log line, and the pre-deploy check (scripts/check-data.ts) printed
// its first line as the reason a file was refused - which came out as
// "Grund: [" and told the operator nothing at all.
//
// This picks the part someone can act on: where the problem is and what it
// is. The path is what matters most - "0.ports: Unrecognized key: \"http\""
// names the offending record and field, which is the difference between
// repairing one entry and re-creating every instance by hand.
export function zodReason(error: ZodError): string {
  const [first, ...rest] = error.issues;
  if (first === undefined) return "did not match the expected shape";
  // Path segments are array indices as well as keys, so "0.ports" reads as
  // "the first record's ports" without further explanation.
  const where = first.path.length > 0 ? first.path.join(".") : "(top level)";
  const more = rest.length > 0 ? ` (and ${rest.length} more)` : "";
  return `${where}: ${first.message}${more}`;
}
