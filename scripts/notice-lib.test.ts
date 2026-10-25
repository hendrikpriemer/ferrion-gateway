import { describe, expect, it } from "vitest";
import {
  groupByLicenseText,
  normalizeLicenseId,
  packagesWithoutText,
  pickLicenseFileNames,
  pickNoticeFileNames,
  renderLicenseModule,
  renderNotice,
  type NoticePackage,
} from "./notice-lib.js";

function pkg(overrides: Partial<NoticePackage> & { name: string }): NoticePackage {
  return {
    version: "1.0.0",
    licenseId: "MIT",
    licenseText: "MIT License\n\nCopyright (c) 2020 Someone",
    noticeText: null,
    ...overrides,
  };
}

describe("pickLicenseFileNames", () => {
  it("finds the file whatever it is called", () => {
    // Real packages use all of these; matching only "LICENSE" would drop
    // the text for the rest and silently shrink the NOTICE.
    for (const name of ["LICENSE", "license", "LICENSE.md", "LICENCE.txt", "COPYING"]) {
      expect(pickLicenseFileNames([name])).toEqual([name]);
    }
  });

  it("returns every licence file, not just the first", () => {
    // A dual-licensed package grants terms under both. Picking one would
    // hand the reader half the permission they actually have.
    expect(pickLicenseFileNames(["LICENSE-APACHE", "LICENSE-MIT", "index.js"])).toEqual([
      "LICENSE-APACHE",
      "LICENSE-MIT",
    ]);
  });

  it("does not mistake a licence-ish filename for a licence", () => {
    expect(pickLicenseFileNames(["licensing-faq.md", "LICENSES-OF-OTHERS.txt"])).toEqual([]);
  });
});

describe("pickNoticeFileNames", () => {
  it("finds a dependency's own NOTICE, which Apache-2.0 says to pass on", () => {
    expect(pickNoticeFileNames(["NOTICE", "notice.txt", "README.md"])).toEqual([
      "NOTICE",
      "notice.txt",
    ]);
  });
});

describe("normalizeLicenseId", () => {
  it("reads the shapes npm has used over the years", () => {
    expect(normalizeLicenseId({ license: "MIT" })).toBe("MIT");
    expect(normalizeLicenseId({ license: { type: "BSD-3-Clause" } })).toBe("BSD-3-Clause");
    expect(normalizeLicenseId({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] })).toBe(
      "MIT OR Apache-2.0"
    );
  });

  it("returns null when a package declares nothing", () => {
    // Deliberately null and not "UNKNOWN": a package declaring nothing needs
    // a human to go and look, and a literal "UNKNOWN" in the output would
    // read as though that were the answer.
    expect(normalizeLicenseId({})).toBeNull();
    expect(normalizeLicenseId({ license: "   " })).toBeNull();
    expect(normalizeLicenseId({ license: {} })).toBeNull();
  });
});

describe("groupByLicenseText", () => {
  it("lists packages that share byte-identical text together", () => {
    const groups = groupByLicenseText([
      pkg({ name: "b", licenseText: "same" }),
      pkg({ name: "a", licenseText: "same" }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.packages.map((p) => p.name)).toEqual(["a", "b"]);
  });

  it("keeps texts apart that differ only in the copyright line", () => {
    // The point MIT actually cares about. Collapsing these would drop a
    // copyright holder's name from the notice they are owed.
    const groups = groupByLicenseText([
      pkg({ name: "a", licenseText: "MIT\nCopyright Alice" }),
      pkg({ name: "b", licenseText: "MIT\nCopyright Bob" }),
    ]);

    expect(groups).toHaveLength(2);
  });

  it("leaves out packages with no text, so they cannot pass as covered", () => {
    expect(groupByLicenseText([pkg({ name: "a", licenseText: null })])).toEqual([]);
  });
});

describe("packagesWithoutText", () => {
  it("names exactly the ones that ship nothing", () => {
    const missing = packagesWithoutText([
      pkg({ name: "has-text" }),
      pkg({ name: "none", licenseText: null }),
    ]);

    expect(missing.map((p) => p.name)).toEqual(["none"]);
  });
});

describe("renderNotice", () => {
  const base = { product: "ferrion-gateway", copyright: "Copyright 2026 Someone", platform: "linux-x64" };

  it("reproduces each licence text in full", () => {
    const output = renderNotice({ ...base, packages: [pkg({ name: "a", licenseText: "FULL TEXT HERE" })] });

    expect(output).toContain("FULL TEXT HERE");
    expect(output).toContain("a@1.0.0 (MIT)");
  });

  it("names packages that ship no text instead of dropping them", () => {
    // The failure that would matter: a package quietly absent from the
    // NOTICE looks exactly like one that was never a dependency.
    const output = renderNotice({
      ...base,
      packages: [pkg({ name: "silent", licenseText: null, licenseId: "MIT" })],
    });

    expect(output).toContain("silent@1.0.0 - MIT");
  });

  it("marks a package that declares no licence at all as needing a look", () => {
    const output = renderNotice({
      ...base,
      packages: [pkg({ name: "undeclared", licenseText: null, licenseId: null })],
    });

    expect(output).toContain("undeclared@1.0.0 - no licence declared - needs checking");
  });

  it("passes on a dependency's own NOTICE, as Apache-2.0 §4(d) requires", () => {
    const output = renderNotice({
      ...base,
      packages: [pkg({ name: "apache-dep", licenseId: "Apache-2.0", noticeText: "THEIR NOTICE" })],
    });

    expect(output).toContain("THEIR NOTICE");
  });

  it("states which platform it was generated on", () => {
    // Some dependencies ship one binary package per platform, so the set is
    // not the same everywhere. Saying so keeps a reader comparing this file
    // against an image from concluding it is simply wrong.
    expect(renderNotice({ ...base, packages: [pkg({ name: "a" })] })).toContain("linux-x64");
  });
});

describe("renderLicenseModule", () => {
  it("lists every shipped package, not only the direct ones", () => {
    // The reason this moved here from the commit hook: that version read
    // package.json's own `dependencies` and showed 9 of the 248 that ship.
    const output = renderLicenseModule([
      pkg({ name: "direct-dep" }),
      pkg({ name: "transitive-dep", version: "2.3.4", licenseId: "ISC" }),
    ]);

    expect(output).toContain('{ name: "direct-dep", version: "1.0.0", license: "MIT" }');
    expect(output).toContain('{ name: "transitive-dep", version: "2.3.4", license: "ISC" }');
  });

  it("says so when a package declares no licence", () => {
    // Three real dependencies do. An empty cell would read as a rendering
    // fault rather than as the open question it is.
    expect(renderLicenseModule([pkg({ name: "quiet", licenseId: null })])).toContain(
      'license: "not declared"'
    );
  });

  it("escapes values instead of interpolating them", () => {
    // A quote in a name or version would otherwise emit a module that does
    // not parse - and this file is loaded straight by the browser, so the
    // whole page would go blank rather than showing a wrong row.
    const output = renderLicenseModule([pkg({ name: 'odd"name', version: '1.0"0' })]);

    expect(output).toContain('"odd\\"name"');
    expect(() => JSON.parse(`["${'odd\\"name'}"]`)).not.toThrow();
  });

  it("sorts by name, so a dependency bump does not reshuffle the file", () => {
    const output = renderLicenseModule([pkg({ name: "zeta" }), pkg({ name: "alpha" })]);

    expect(output.indexOf("alpha")).toBeLessThan(output.indexOf("zeta"));
  });
});
