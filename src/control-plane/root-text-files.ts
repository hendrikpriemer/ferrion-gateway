/**
 * The two files at the repo root that the UI is allowed to read: the licence
 * this software is granted under, and the third-party notices the image
 * redistributes alongside it.
 *
 * Served from their real location rather than copied into `public/`, so the
 * Licence page can never show a stale copy of the terms actually being
 * granted.
 *
 * A fixed lookup and not a path join: the static handler next to it already
 * guards against escaping `public/`, and this route would otherwise be a
 * second, separate way to read arbitrary files from the repo root. Two
 * names in, two files out, nothing composed from the request.
 *
 * A `Map` rather than an object literal, which is not a style preference: a
 * plain object answers `"constructor"` and `"__proto__"` with inherited
 * members, so the lookup would return something truthy for a path nobody
 * allowed, and the caller would join it onto the repo root. Found by the
 * test below, not by reading.
 */
const ROOT_TEXT_FILES = new Map<string, string>([
  ["/LICENSE", "LICENSE"],
  ["/NOTICE", "NOTICE"],
]);

/** The file name to serve for this request path, or null if it is not one of them. */
export function resolveRootTextFile(pathname: string): string | null {
  return ROOT_TEXT_FILES.get(pathname) ?? null;
}
