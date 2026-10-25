import { readFileSync } from "node:fs";
import type { ZodType } from "zod";

// Read, parse, validate - the shell both config loaders wrapped around
// their schema, twice (review 2026-09, N-18). `label` is the human name of
// the config kind ("instance", "fleet") for the error texts.
export function loadJsonConfig<T>(filePath: string, schema: ZodType<T>, label: string): T {
  const capitalised = label.charAt(0).toUpperCase() + label.slice(1);
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (cause) {
    // Attach the cause, not just its text: ENOENT and EACCES differ in
    // `code`, not in the message, and the original's stack is the only
    // thing that leads back to the caller when someone goes looking.
    // Flagged by ESLint 10's `preserve-caught-error`, which is how it was
    // noticed at all.
    throw new Error(`Could not read ${label} config file "${filePath}": ${(cause as Error).message}`, { cause });
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${capitalised} config file "${filePath}" is not valid JSON: ${(cause as Error).message}`, {
      cause,
    });
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    throw new Error(`${capitalised} config file "${filePath}" is invalid:\n${result.error.message}`);
  }
  return result.data;
}
