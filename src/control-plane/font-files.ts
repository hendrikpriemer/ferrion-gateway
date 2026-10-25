import { createRequire } from "node:module";

/**
 * The web fonts the control-plane pages use, served straight from their npm
 * packages rather than from fonts.googleapis.com (2026-10-17): every page
 * view used to send the browser's address to Google, and a site network
 * without internet access had no icons. Served from node_modules rather
 * than copied into public/ so the files stay what the lockfile says - and
 * the packages land in NOTICE and the SBOM like every other dependency.
 *
 * A fixed table, not a path lookup: only these four names are ever served.
 */
const require = createRequire(import.meta.url);

const FONT_FILES: Record<string, string> = {
  "/fonts/roboto-latin-400.woff2": "@fontsource/roboto/files/roboto-latin-400-normal.woff2",
  "/fonts/roboto-latin-500.woff2": "@fontsource/roboto/files/roboto-latin-500-normal.woff2",
  "/fonts/roboto-latin-700.woff2": "@fontsource/roboto/files/roboto-latin-700-normal.woff2",
  "/fonts/material-symbols-outlined.woff2": "material-symbols/material-symbols-outlined.woff2",
};

/** The file behind a /fonts/... request path, or null for anything else. */
export function resolveFontFile(pathname: string): string | null {
  const specifier = FONT_FILES[pathname];
  return specifier ? require.resolve(specifier) : null;
}

export const FONT_PATHS = Object.keys(FONT_FILES);
