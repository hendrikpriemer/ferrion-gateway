import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FONT_PATHS, resolveFontFile } from "./font-files.js";

const publicDir = path.join(process.cwd(), "public");

describe("resolveFontFile", () => {
  it.each(FONT_PATHS)("serves %s as a real woff2 from its package", (fontPath) => {
    const file = resolveFontFile(fontPath);
    expect(file).not.toBeNull();
    // wOF2 magic number.
    expect(readFileSync(file!).subarray(0, 4).toString("latin1")).toBe("wOF2");
  });

  it("serves the four fonts fonts.css asks for, and nothing else", () => {
    const css = readFileSync(path.join(publicDir, "fonts.css"), "utf8");
    const referenced = [...css.matchAll(/url\("([^"]+)"\)/g)].map((match) => `/${match[1]}`);
    expect(referenced.sort()).toEqual([...FONT_PATHS].sort());
    for (const other of ["/fonts/", "/fonts/../package.json", "/fonts/roboto-latin-300.woff2", "/index.html"]) {
      expect(resolveFontFile(other)).toBeNull();
    }
  });
});

describe("no font from Google", () => {
  it("names no Google font host anywhere under public/", () => {
    // Every page view used to send the browser's address to Google.
    const offenders = readdirSync(publicDir).filter((entry) =>
      /fonts\.(?:googleapis|gstatic)\.com/.test(readFileSync(path.join(publicDir, entry), "latin1"))
    );
    expect(offenders).toEqual([]);
  });

  it("links fonts.css on every page", () => {
    const pages = readdirSync(publicDir).filter((entry) => entry.endsWith(".html"));
    expect(pages.length).toBeGreaterThanOrEqual(4);
    for (const page of pages) {
      expect(readFileSync(path.join(publicDir, page), "utf8"), page).toContain('<link rel="stylesheet" href="fonts.css" />');
    }
  });
});
