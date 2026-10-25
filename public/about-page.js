// The script of about.html, out of the page so the Content-Security-Policy
// can say script-src 'self' with no inline exception (see security-headers.ts).
import { applyI18n, getLocale, wireLangSwitch } from "./i18n.js";

const langSwitch = document.getElementById("lang-switch");
wireLangSwitch(langSwitch, render);

async function render() {
  applyI18n(langSwitch);
  const response = await fetch("api/about");
  const info = await response.json();
  document.getElementById("about-name").textContent = info.name;
  document.getElementById("about-description").textContent = info.description[getLocale()] ?? info.description.en;
  document.getElementById("about-version").textContent = info.version;
  const contact = document.getElementById("about-contact");
  contact.replaceChildren(
    document.createTextNode(info.contact.name),
    document.createElement("br"),
    document.createTextNode(info.contact.street),
    document.createElement("br"),
    document.createTextNode(`${info.contact.postalCode} ${info.contact.city}`),
    document.createElement("br"),
    document.createTextNode(info.contact.country)
  );
}

render();
