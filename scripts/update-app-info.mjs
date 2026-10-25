#!/usr/bin/env node
// Run automatically by the pre-commit git hook (scripts/git-hooks/pre-commit):
// bumps the patch version in package.json, which the About page shows.
//
// It used to generate public/open-source-licenses.js as well, from
// package.json's direct dependencies. That moved to
// scripts/generate-notice.ts, which collects the *full* installed
// production tree for the NOTICE anyway: two lists built from two sources
// cannot agree, and this one showed 9 packages where 248 ship. Keeping it
// here would also have meant regenerating it on every commit, overwriting
// the complete list with the short one.

import { readFileSync, writeFileSync } from "node:fs";

const rootUrl = new URL("../", import.meta.url);
const pkgPath = new URL("package.json", rootUrl);

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

const [major, minor, patch] = pkg.version.split(".").map(Number);
pkg.version = `${major}.${minor}.${patch + 1}`;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

console.log(`[update-app-info] Bumped version to ${pkg.version}.`);
