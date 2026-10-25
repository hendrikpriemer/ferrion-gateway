// The one way an unknown thrown value becomes a log/status string - it
// was spelt out by hand in five places (review 2026-09, N-23).
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
