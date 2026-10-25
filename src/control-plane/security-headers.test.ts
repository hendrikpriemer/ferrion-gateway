import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./security-headers.js";

const publicDir = path.join(process.cwd(), "public");
const files = (extension: string) => readdirSync(publicDir).filter((entry) => entry.endsWith(extension));

function directive(name: string): string[] {
  const entry = CONTENT_SECURITY_POLICY.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `));
  return entry ? entry.split(/\s+/).slice(1) : [];
}

describe("Content-Security-Policy", () => {
  it("runs only same-origin script files - no inline script, no eval", () => {
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(directive("default-src")).toEqual(["'self'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("frame-ancestors")).toEqual(["'none'"]);
  });

  it("names no foreign host - fonts are self-hosted since #76", () => {
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/https?:|\*/);
  });

  it("is part of the headers every response gets", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toBe(CONTENT_SECURITY_POLICY);
    expect(SECURITY_HEADERS["X-Frame-Options"]).toBe("DENY");
  });
});

describe("the pages fit that policy", () => {
  // A page that breaks the policy does not fail loudly - the browser just
  // skips the script and the page sits there half-built. So check here.
  it("has no inline <script> on any page", () => {
    for (const page of files(".html")) {
      const html = readFileSync(path.join(publicDir, page), "utf8");
      const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((match) => !/\bsrc=/.test(match[1]!));
      expect(inline, page).toEqual([]);
    }
  });

  it("has no on*= handler and no javascript: URL in pages or scripts", () => {
    for (const file of [...files(".html"), ...files(".js")]) {
      const text = readFileSync(path.join(publicDir, file), "utf8");
      expect(text, file).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
      expect(text, file).not.toMatch(/javascript:/i);
    }
  });

  it("loads every page script from public/ itself", () => {
    for (const page of files(".html")) {
      const html = readFileSync(path.join(publicDir, page), "utf8");
      for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) {
        expect(match[1], page).not.toMatch(/^(?:https?:)?\/\//);
        expect(readdirSync(publicDir), page).toContain(match[1]);
      }
    }
  });
});
