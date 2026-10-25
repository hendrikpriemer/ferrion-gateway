import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

// The VM's pull-and-verify step for the gateway (R01), run for real with stand-ins for
// docker and cosign on the PATH: what matters is what it changes, and that
// it changes nothing unless the signature checks out.
const SCRIPT = path.join(__dirname, "vm-release-pull.sh");
const DIGEST = `sha256:${"a".repeat(64)}`;
const REFERENCE = `ghcr.io/hendrikpriemer/ferrion-gateway@${DIGEST}`;

function stub(dir: string, name: string, body: string) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env bash\necho "$0 $*" >> "${dir}/calls.log"\n${body}\n`);
  chmodSync(file, 0o755);
}

function setup({ verify = 0, attest = 0, digests = REFERENCE, cosign = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vm-release-pull-"));
  const bin = path.join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  stub(bin, "docker", `if [ "$1" = inspect ]; then printf '%s\\n' "${digests}"; fi; exit 0`);
  if (cosign) {
    stub(bin, "cosign", `case "$1" in verify) exit ${verify} ;; verify-attestation) exit ${attest} ;; esac`);
  }
  writeFileSync(path.join(dir, ".env"), "FG_LOG_LEVEL=info\nGATEWAY_IMAGE=ghcr.io/hendrikpriemer/ferrion-gateway@sha256:old\nFG_DISCOVERY_ALLOWED_CIDRS=10.20.30.0/24\n");
  const run = (...args: string[]) =>
    spawnSync("bash", [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, NODE_ENV: "test" },
    });
  const env = () => readFileSync(path.join(dir, ".env"), "utf8");
  const calls = () => (existsSync(path.join(bin, "calls.log")) ? readFileSync(path.join(bin, "calls.log"), "utf8") : "");
  const backups = () => readdirSync(dir).filter((name) => name.startsWith(".env.bak-"));
  return { dir, run, env, calls, backups };
}

describe("vm-release-pull.sh", () => {
  it("pins a verified image by digest in .env, keeping the rest of the file and a backup", () => {
    const vm = setup();
    const result = vm.run("v0.1.1120");

    expect(result.status).toBe(0);
    expect(vm.env()).toBe(`FG_LOG_LEVEL=info\nGATEWAY_IMAGE=${REFERENCE}\nFG_DISCOVERY_ALLOWED_CIDRS=10.20.30.0/24\n`);
    expect(vm.backups()).toHaveLength(1);
    expect(result.stdout).toContain("next: docker compose up -d");
  });

  it("verifies signature and SBOM against the release workflow's identity only", () => {
    const vm = setup();
    vm.run("v0.1.1120");

    const calls = vm.calls();
    expect(calls).toContain("docker pull --quiet ghcr.io/hendrikpriemer/ferrion-gateway:v0.1.1120");
    for (const command of ["cosign verify ", "cosign verify-attestation --type cyclonedx "]) {
      const line = calls.split("\n").find((entry) => entry.includes(command)) ?? "";
      expect(line).toContain(
        "--certificate-identity-regexp ^https://github\\.com/hendrikpriemer/ferrion-gateway/\\.github/workflows/release\\.yml@refs/(tags/v[0-9][^ ]*|heads/main)$",
      );
      expect(line).toContain("--certificate-oidc-issuer https://token.actions.githubusercontent.com");
      // The digest, never the tag: a tag can be moved after the check.
      expect(line).toMatch(new RegExp(`${REFERENCE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
    }
  });

  it("adds GATEWAY_IMAGE when .env has none yet", () => {
    const vm = setup();
    writeFileSync(path.join(vm.dir, ".env"), "FG_LOG_LEVEL=info\n");
    vm.run("v0.1.1120");
    expect(vm.env()).toBe(`FG_LOG_LEVEL=info\nGATEWAY_IMAGE=${REFERENCE}\n`);
  });

  it("only checks with --check, changing nothing", () => {
    const vm = setup();
    const before = vm.env();
    const result = vm.run("v0.1.1120", "--check");

    expect(result.status).toBe(0);
    expect(vm.env()).toBe(before);
    expect(vm.backups()).toEqual([]);
  });

  it.each([
    ["an invalid signature", { verify: 1 }, "SIGNATURE INVALID"],
    ["an invalid SBOM attestation", { attest: 1 }, "SBOM ATTESTATION INVALID"],
    ["an image without a registry digest", { digests: "other.registry/image@sha256:1" }, "no digest"],
  ])("leaves .env untouched for %s", (_name, options, message) => {
    const vm = setup(options);
    const before = vm.env();
    const result = vm.run("v0.1.1120");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(vm.env()).toBe(before);
    expect(vm.backups()).toEqual([]);
  });

  it("refuses to run without cosign", () => {
    const vm = setup({ cosign: false });
    const result = vm.run("v0.1.1120");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("cosign is not installed");
  });

  it("needs a tag", () => {
    expect(setup().run().status).not.toBe(0);
  });
});
