import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Keeping the last five releases in the registry (R01, decision 2026-10-25),
// run for real with a stand-in for gh: which versions it deletes, and that
// a signature or attestation goes exactly with its image.
const SCRIPT = path.join(__dirname, "ghcr-prune.sh");
const digest = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
const sigTag = (n: number, kind: "sig" | "att") => `sha256-${String(n).padStart(64, "0")}.${kind}`;

function run(versions: [number, string, string][], args: string[] = [], keep = "5") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ghcr-prune-"));
  const listing = versions.map(([id, name, tags]) => `${id}\t${name}\t${tags}`).join("\n");
  writeFileSync(path.join(dir, "listing.tsv"), `${listing}\n`);
  writeFileSync(
    path.join(dir, "gh"),
    `#!/usr/bin/env bash
if [ "$2" = "--method" ]; then echo "$*" >> "${dir}/deleted.log"; exit 0; fi
cat "${dir}/listing.tsv"
`,
  );
  chmodSync(path.join(dir, "gh"), 0o755);
  const result = spawnSync("bash", [SCRIPT, "ferrion-gateway", ...args], {
    encoding: "utf8",
    env: { PATH: `${dir}:/usr/bin:/bin`, KEEP: keep, GITHUB_REPOSITORY_OWNER: "hendrikpriemer", NODE_ENV: "test" },
  });
  const log = existsSync(path.join(dir, "deleted.log")) ? readFileSync(path.join(dir, "deleted.log"), "utf8") : "";
  const deleted = log
    ? log
        .trim()
        .split("\n")
        .map((line) => Number(line.split("/").at(-1)))
    : [];
  return { result, deleted, log };
}

// Seven releases, newest first as the API lists them, each with its
// signature and attestation, plus an untagged leftover.
function sevenReleases(): [number, string, string][] {
  const versions: [number, string, string][] = [];
  for (let n = 7; n >= 1; n -= 1) {
    versions.push([n * 10, digest(n), `v0.1.${1100 + n}`]);
    versions.push([n * 10 + 1, digest(100 + n), sigTag(n, "sig")]);
    versions.push([n * 10 + 2, digest(200 + n), sigTag(n, "att")]);
  }
  versions.push([999, digest(999), ""]);
  return versions;
}

describe("ghcr-prune.sh", () => {
  it("keeps the newest five releases with their signatures, deletes the older ones and untagged leftovers", () => {
    const { result, deleted } = run(sevenReleases());

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("keeping 5 released images");
    // Releases 1 and 2 with signature and attestation, and the leftover.
    expect(deleted.sort((a, b) => a - b)).toEqual([10, 11, 12, 20, 21, 22, 999]);
  });

  it("deletes through the user package path", () => {
    const { log } = run(sevenReleases());
    expect(log).toContain("api --method DELETE /users/hendrikpriemer/packages/container/ferrion-gateway/versions/10\n");
  });

  it("deletes nothing with --dry-run, but says what it would", () => {
    const { result, deleted } = run(sevenReleases(), ["--dry-run"]);
    expect(deleted).toEqual([]);
    expect(result.stdout).toContain("delete 10 ");
    expect(result.stdout).toContain("(untagged)");
  });

  it("counts a trial release (-rc) like any other and leaves foreign tags alone", () => {
    const { deleted } = run(
      [
        [1, digest(1), "v0.1.1120-rc.1"],
        [2, digest(2), "latest"],
        [3, digest(3), sigTag(1, "sig")],
      ],
      [],
      "1",
    );
    expect(deleted).toEqual([]);
  });

  it("deletes a signature whose image is gone", () => {
    const { deleted } = run([[1, digest(1), "v0.1.1120"], [2, digest(2), sigTag(9, "sig")]]);
    expect(deleted).toEqual([2]);
  });

  it("keeps everything when there are no more releases than to keep", () => {
    const { result, deleted } = run([[1, digest(1), "v0.1.1120"], [2, digest(2), sigTag(1, "sig")]]);
    expect(result.status).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("needs a package name", () => {
    expect(spawnSync("bash", [SCRIPT], { encoding: "utf8" }).status).not.toBe(0);
  });
});
