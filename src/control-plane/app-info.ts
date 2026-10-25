import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(__dirname, "..", "..", "package.json");

// Same fixed, non-localized postal address as the ferrion platform's own
// About page (asset-manager's AboutSection.tsx) - one product family, one
// contact.
const CONTACT = {
  name: "Hendrik Priemer",
  street: "Hüttenstraße 5",
  postalCode: "30165",
  city: "Hannover",
  country: "Deutschland",
};

// Version is read live from package.json on every request rather than
// baked into a generated public/ file - there's already a running server
// here (unlike the ferrion platform's static-export-friendly About page),
// so there's nothing to gain from duplicating it into yet another
// generated artifact alongside open-source-licenses.js.
export function getAppInfo() {
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
  return {
    name: "ferrion Gateway",
    description: {
      de: "ferrion Gateway ist der lokale Bridge-Prozess, der OPC-UA-, Modbus-TCP- und MQTT-Sensoren mit der ferrion-Plattform verbindet und Geräteprotokolle in ferrions eigene Datenquellen-API übersetzt.",
      en: "ferrion Gateway is the local bridge process that connects OPC UA, Modbus TCP, and MQTT sensors to the ferrion platform, translating device protocols into ferrion's own data-source API.",
    },
    version: pkg.version,
    contact: CONTACT,
  };
}
