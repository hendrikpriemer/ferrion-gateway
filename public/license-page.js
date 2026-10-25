// The script of license.html, out of the page so the Content-Security-Policy
// can say script-src 'self' with no inline exception (see security-headers.ts).
import { applyI18n, wireLangSwitch } from "./i18n.js";

// Plain text into textContent, never innerHTML: the licence is a
// document to display, not markup to run.
fetch("/LICENSE")
  .then((response) => (response.ok ? response.text() : Promise.reject(new Error("unavailable"))))
  .then((text) => {
    const target = document.getElementById("license-text");
    target.removeAttribute("data-i18n");
    target.textContent = text;
  })
  .catch(() => {
    const target = document.getElementById("license-text");
    target.setAttribute("data-i18n", "licenseUnavailable");
  });

const langSwitch = document.getElementById("lang-switch");
wireLangSwitch(langSwitch, () => applyI18n(langSwitch));
applyI18n(langSwitch);
