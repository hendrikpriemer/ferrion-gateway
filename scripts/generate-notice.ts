/**
 * Writes NOTICE from the installed production dependency tree.
 *
 *   npm run notice           regenerate the file
 *   npm run notice -- --check  fail if it is out of date, without writing
 *
 * `--check` catches a NOTICE that has fallen behind a dependency bump, which
 * is worse than none because it looks maintained.
 *
 * **It is not, however, a CI check** - measured, not assumed. Some
 * dependencies ship one binary package per platform (tsx pulls in esbuild,
 * which does), so the tree differs between a developer's machine and CI's
 * Linux runner. A committed file generated on macOS names
 * `@esbuild/darwin-arm64`; CI would find `@esbuild/linux-x64` and report a
 * difference that is not staleness at all. Run it where the file was
 * generated.
 *
 * The file that legally matters is not this one anyway: the Dockerfile runs
 * this script *inside the image*, against the tree `npm ci` just installed,
 * so the artifact that actually ships carries a NOTICE correct for itself by
 * construction. The committed copy is documentation for anyone reading the
 * repo without building it.
 *
 * The tree comes from npm itself rather than from the lockfile, because the
 * licence *texts* only exist on disk - and npm is also the authority on
 * which packages `--omit=dev --omit=optional` actually leaves in, which is
 * exactly the set the Dockerfile installs.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeLicenseId,
  pickLicenseFileNames,
  pickNoticeFileNames,
  renderLicenseModule,
  renderNotice,
  type NoticePackage,
} from "./notice-lib.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NOTICE_PATH = path.join(ROOT, "NOTICE");
// The same collection, rendered for the control plane's licences table.
// Written here rather than by the pre-commit hook so the two lists cannot
// drift apart - see renderLicenseModule.
const LICENSES_PATH = path.join(ROOT, "public", "open-source-licenses.js");

function productionPackageDirs(): string[] {
  const output = execFileSync(
    "npm",
    ["ls", "--omit=dev", "--omit=optional", "--all", "--parseable"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
  );
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      // The first entry is the project itself, which is not a third party.
      .filter((dir) => path.resolve(dir) !== ROOT)
  );
}

function readTextFiles(dir: string, names: string[]): string | null {
  const texts = names
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    })
    .map((file) => readFileSync(file, "utf8").trim())
    .filter((text) => text !== "");
  return texts.length > 0 ? texts.join("\n\n") : null;
}

function collect(): NoticePackage[] {
  const seen = new Map<string, NoticePackage>();
  for (const dir of productionPackageDirs()) {
    let manifest: { name?: string; version?: string; license?: unknown; licenses?: unknown };
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as typeof manifest;
    } catch {
      // A path npm lists but that is not readable is a real problem, not
      // something to pass over quietly - it would silently shrink the NOTICE.
      throw new Error(`Cannot read package.json in ${dir}`);
    }
    const name = manifest.name ?? path.basename(dir);
    const version = manifest.version ?? "unknown";
    const key = `${name}@${version}`;
    if (seen.has(key)) {
      // The same package can be installed at several depths; one entry is
      // enough, and the licence is identical by definition.
      continue;
    }
    const entries = readdirSync(dir);
    seen.set(key, {
      name,
      version,
      licenseId: normalizeLicenseId(manifest),
      licenseText: readTextFiles(dir, pickLicenseFileNames(entries)),
      noticeText: readTextFiles(dir, pickNoticeFileNames(entries)),
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const packages = collect();
const notice = renderNotice({
  product: "ferrion-gateway",
  // The imprint the product itself already shows (see ferrion's Info page).
  // If the rights sit with a company rather than a person, this is the one
  // line to change.
  copyright: "Copyright 2026 Hendrik Priemer",
  packages,
  platform: `${process.platform}-${process.arch}`,
});

const licenseModule = renderLicenseModule(packages);

if (process.argv.includes("--check")) {
  for (const [label, file, expected] of [
    ["NOTICE", NOTICE_PATH, notice],
    ["public/open-source-licenses.js", LICENSES_PATH, licenseModule],
  ] as const) {
    let current: string;
    try {
      current = readFileSync(file, "utf8");
    } catch {
      console.error(`${label} is missing. Run \`npm run notice\`.`);
      process.exit(1);
    }
    if (current !== expected) {
      console.error(
        `${label} is out of date - dependencies changed since it was generated.\n` +
          "Run `npm run notice` and commit the result."
      );
      process.exit(1);
    }
  }
  console.log(`NOTICE and licence list are up to date (${packages.length} packages).`);
} else {
  writeFileSync(NOTICE_PATH, notice);
  writeFileSync(LICENSES_PATH, licenseModule);
  const withoutText = packages.filter((pkg) => pkg.licenseText === null);
  console.log(`NOTICE and licence list written: ${packages.length} packages.`);
  if (withoutText.length > 0) {
    // Named on every run rather than buried in the file, because these are
    // the ones a human may still have to resolve by hand.
    console.log(
      `  ${withoutText.length} ship no licence text: ` +
        withoutText.map((pkg) => `${pkg.name} (${pkg.licenseId ?? "nothing declared"})`).join(", ")
    );
  }
}
