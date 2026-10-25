// The script of licenses.html, out of the page so the Content-Security-Policy
// can say script-src 'self' with no inline exception (see security-headers.ts).
import { applyI18n, wireLangSwitch } from "./i18n.js";
import { OPEN_SOURCE_LICENSES } from "./open-source-licenses.js";

const langSwitch = document.getElementById("lang-switch");
wireLangSwitch(langSwitch, () => applyI18n(langSwitch));
applyI18n(langSwitch);

const body = document.getElementById("licenses-body");
for (const entry of OPEN_SOURCE_LICENSES) {
  const row = document.createElement("tr");
  for (const value of [entry.name, entry.version, entry.license]) {
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(cell);
  }
  body.append(row);
}
