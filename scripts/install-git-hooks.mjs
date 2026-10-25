#!/usr/bin/env node
// Copies scripts/git-hooks/* into .git/hooks/ so they're actually run by git.
// .git/hooks isn't tracked, so this re-installs them on every `npm install`
// (via the "prepare" script in package.json).

import { chmodSync, copyFileSync, existsSync, readdirSync } from "node:fs";

const rootUrl = new URL("../", import.meta.url);
const sourceDir = new URL("scripts/git-hooks/", rootUrl);
const targetDir = new URL(".git/hooks/", rootUrl);

if (!existsSync(targetDir)) {
  console.log("[install-git-hooks] No .git/hooks directory found, skipping.");
  process.exit(0);
}

for (const hookName of readdirSync(sourceDir)) {
  const source = new URL(hookName, sourceDir);
  const target = new URL(hookName, targetDir);
  copyFileSync(source, target);
  chmodSync(target, 0o755);
  console.log(`[install-git-hooks] Installed ${hookName}`);
}
