import { describe, expect, it } from "vitest";
import { resolveRootTextFile } from "./root-text-files.js";

describe("resolveRootTextFile", () => {
  it("serves the licence and the third-party notices", () => {
    // The Licence page reads /LICENSE rather than embedding a copy, so that
    // what it shows cannot drift from the terms actually being granted.
    expect(resolveRootTextFile("/LICENSE")).toBe("LICENSE");
    expect(resolveRootTextFile("/NOTICE")).toBe("NOTICE");
  });

  it("resolves nothing that was composed from the request", () => {
    // The whole reason this is a fixed map: the handler joins the result
    // onto the repo root, so anything derived from the path would make this
    // a second, unguarded way to read files the static handler carefully
    // keeps inside public/.
    for (const attempt of [
      "/LICENSE/../package.json",
      "/../.env",
      "/LICENSE%00",
      "/license",
      "/NOTICE.md",
      "/",
      "",
    ]) {
      expect(resolveRootTextFile(attempt)).toBeNull();
    }
  });

  it("does not resolve inherited object properties", () => {
    // A plain Record lookup would happily return Object.prototype members
    // for these, which would then be joined onto the repo root.
    expect(resolveRootTextFile("constructor")).toBeNull();
    expect(resolveRootTextFile("__proto__")).toBeNull();
    expect(resolveRootTextFile("toString")).toBeNull();
  });
});
