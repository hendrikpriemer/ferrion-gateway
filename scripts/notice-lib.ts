/**
 * The pure half of NOTICE generation - everything that can be decided from
 * data rather than from the filesystem, so it can be tested without one.
 *
 * Why a NOTICE file exists at all: this image ships its production
 * `node_modules` (see the Dockerfile's `npm ci --omit=dev`), which makes it
 * a redistribution of every package in there. MIT and BSD require the
 * copyright notice and permission text to travel with the copy, and
 * Apache-2.0 §4(d) additionally requires passing on any NOTICE file a
 * dependency carries. An SBOM does not satisfy this: it records licence
 * *identifiers*, not the texts.
 */

/** One production dependency, as read off disk. */
export type NoticePackage = {
  name: string;
  version: string;
  /** SPDX identifier as declared by the package, or null when it declares none. */
  licenseId: string | null;
  /** Verbatim licence text bundled with the package, or null when it ships none. */
  licenseText: string | null;
  /** A NOTICE file the package carries, which Apache-2.0 §4(d) says to pass on. */
  noticeText: string | null;
};

export type NoticeGroup = {
  text: string;
  packages: { name: string; version: string; licenseId: string | null }[];
};

// The separator class matters: dual-licensed packages name their files
// LICENSE-MIT and LICENSE-APACHE, and a pattern ending at "." or the word
// boundary silently skips both. Kept narrow enough that "licensing-faq.md"
// and "LICENSES-OF-OTHERS.txt" still do not match.
const LICENSE_FILE = /^(licen[cs]e|copying)([.\-_]|$)/i;
const NOTICE_FILE = /^notice(\.|$)/i;

/**
 * Every licence file in a package directory, not just the first.
 *
 * Dual-licensed packages ship more than one (`LICENSE-MIT` alongside
 * `LICENSE-APACHE`), and picking one would drop half of the terms the
 * recipient is being granted.
 */
export function pickLicenseFileNames(entries: string[]): string[] {
  return entries.filter((entry) => LICENSE_FILE.test(entry)).sort();
}

export function pickNoticeFileNames(entries: string[]): string[] {
  return entries.filter((entry) => NOTICE_FILE.test(entry)).sort();
}

/**
 * The declared SPDX identifier, across the shapes npm has used over the
 * years: a plain string, the old `{ type }` object, and the older
 * `licenses: [...]` array. Returns null rather than "UNKNOWN" so that
 * "declares nothing" stays distinguishable from "declares the string
 * UNKNOWN" - the first needs a human to go and look, the second does not.
 */
export function normalizeLicenseId(pkg: {
  license?: unknown;
  licenses?: unknown;
}): string | null {
  const { license, licenses } = pkg;
  if (typeof license === "string" && license.trim() !== "") {
    return license.trim();
  }
  if (license && typeof license === "object" && "type" in license) {
    const type = (license as { type?: unknown }).type;
    if (typeof type === "string" && type.trim() !== "") {
      return type.trim();
    }
  }
  if (Array.isArray(licenses)) {
    const types = (licenses as unknown[])
      .map((entry) =>
        entry && typeof entry === "object" && "type" in entry
          ? (entry as { type?: unknown }).type
          : entry
      )
      .filter((type): type is string => typeof type === "string" && type.trim() !== "");
    if (types.length > 0) {
      return types.join(" OR ");
    }
  }
  return null;
}

/**
 * Packages sharing byte-identical licence text are listed together.
 *
 * This is not merely tidying: most of these are MIT, whose text differs
 * only in the copyright line, so grouping collapses only the genuinely
 * identical ones and keeps every distinct copyright holder named - which is
 * the part MIT actually requires.
 */
export function groupByLicenseText(packages: NoticePackage[]): NoticeGroup[] {
  const groups = new Map<string, NoticeGroup>();
  for (const pkg of packages) {
    if (pkg.licenseText === null) {
      continue;
    }
    const existing = groups.get(pkg.licenseText);
    const entry = { name: pkg.name, version: pkg.version, licenseId: pkg.licenseId };
    if (existing) {
      existing.packages.push(entry);
    } else {
      groups.set(pkg.licenseText, { text: pkg.licenseText, packages: [entry] });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      packages: [...group.packages].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.packages[0]!.name.localeCompare(b.packages[0]!.name));
}

/** Packages that ship no licence text, which have to be named rather than dropped. */
export function packagesWithoutText(packages: NoticePackage[]): NoticePackage[] {
  return packages
    .filter((pkg) => pkg.licenseText === null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function renderNotice({
  product,
  copyright,
  packages,
  platform,
}: {
  product: string;
  copyright: string;
  packages: NoticePackage[];
  /** The platform this was generated on - see the caveat it prints. */
  platform: string;
}): string {
  const groups = groupByLicenseText(packages);
  const missing = packagesWithoutText(packages);
  const notices = packages
    .filter((pkg) => pkg.noticeText !== null)
    .sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [
    product,
    copyright,
    "",
    "This product is licensed under the Apache License, Version 2.0. See LICENSE.",
    "",
    "It bundles the third-party packages listed below and redistributes them",
    "unchanged. Their own licence terms follow, reproduced in full as those",
    "terms require.",
    "",
    `Generated from the installed production dependency tree on ${platform}.`,
    "Regenerate with `npm run notice` whenever dependencies change.",
    "",
    // Stated rather than quietly accepted: a reader comparing this file
    // against the image's actual node_modules will otherwise find a
    // discrepancy and not know whether it is a mistake.
    "Note on platform-specific packages: some dependencies ship one binary",
    "package per operating system and architecture. Only the variant for the",
    "platform above is installed here, so a NOTICE generated elsewhere names",
    "a different one. All such variants carry the same licence as their",
    "parent package.",
    "",
    `Packages: ${packages.length}`,
    "",
    "=".repeat(72),
    "",
  ];

  for (const group of groups) {
    for (const pkg of group.packages) {
      lines.push(`${pkg.name}@${pkg.version}${pkg.licenseId ? ` (${pkg.licenseId})` : ""}`);
    }
    lines.push("", group.text.trimEnd(), "", "-".repeat(72), "");
  }

  if (missing.length > 0) {
    lines.push(
      "",
      "The following packages ship no licence file of their own. Their declared",
      "identifier is given where they declare one; a package declaring none is",
      "marked so it can be looked up by hand rather than silently passed over.",
      ""
    );
    for (const pkg of missing) {
      lines.push(
        `  ${pkg.name}@${pkg.version} - ${pkg.licenseId ?? "no licence declared - needs checking"}`
      );
    }
    lines.push("");
  }

  if (notices.length > 0) {
    lines.push(
      "",
      "=".repeat(72),
      "",
      "NOTICE files carried by dependencies, passed on as Apache-2.0 §4(d)",
      "requires:",
      ""
    );
    for (const pkg of notices) {
      lines.push(`${pkg.name}@${pkg.version}`, "", pkg.noticeText!.trimEnd(), "", "-".repeat(72), "");
    }
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

/**
 * The compact list behind the control plane's "Open source licences" table.
 *
 * Emitted by the same collector as the NOTICE on purpose. They were
 * separate before - the table from `package.json`'s direct dependencies on
 * every commit, the notices from the full installed tree - and two lists
 * built from two sources cannot agree: the table showed 9 of 248, and in
 * the image it kept whichever platform variant the committing machine had.
 *
 * A browser-loadable ES module because `public/` ships unbundled straight
 * to the browser. Values go through JSON.stringify rather than string
 * interpolation: a package name or version containing a quote would
 * otherwise produce a file that does not parse.
 */
export function renderLicenseModule(packages: NoticePackage[]): string {
  const entries = [...packages]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (pkg) =>
        `  { name: ${JSON.stringify(pkg.name)}, version: ${JSON.stringify(pkg.version)}, ` +
        `license: ${JSON.stringify(pkg.licenseId ?? "not declared")} },`
    )
    .join("\n");
  return (
    "/**\n" +
    " * Every package shipped in this image's production node_modules, with the\n" +
    " * licence each declares. Generated by scripts/generate-notice.ts alongside\n" +
    " * NOTICE, which carries the full texts - do not edit by hand.\n" +
    " */\n" +
    "export const OPEN_SOURCE_LICENSES = [\n" +
    entries +
    "\n];\n"
  );
}
