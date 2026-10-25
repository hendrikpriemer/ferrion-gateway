import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkDataDirectory, formatDataCheck, hasFinding } from "./check-data-lib.js";

// Thin command line over check-data-lib.ts, same split as
// generate-notice.ts / notice-lib.ts: everything worth testing lives in the
// lib, this only resolves the directory, prints and picks an exit code.
//
//   npm run check:data            # the repo's own data/ (in the image: /app/data)
//   npm run check:data -- /pfad   # any other directory, e.g. a restored backup

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Mirrors control-plane/server.ts's own dataDir so the check looks exactly
// where the control plane would.
const DEFAULT_DATA_DIR = path.join(__dirname, "..", "data");

const dataDir = process.argv[2] ?? DEFAULT_DATA_DIR;
const check = checkDataDirectory(path.resolve(dataDir));

console.log(formatDataCheck(check));
// Non-zero on a finding so this can gate a deploy script, not just inform a
// human reading the output.
process.exit(hasFinding(check) ? 1 : 0);
