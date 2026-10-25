const translations = {
  de: {
    subtitle:
      'Lokale Gateway-Instanzen anlegen, starten/stoppen und ihre Verbindungsdaten zum Abschreiben in ferrions „Datenquelle hinzufügen“-Dialog einsehen.',
    settingsTitle: "ferrion-Verbindung",
    settingsHint:
      "Einmal einrichten - alle Instanzen nutzen dieselbe Verbindung. Den API-Key gibt's in ferrion unter Settings → Gateways.",
    connectedAsGateway: (name) => `Verbunden als „${name}“`,
    baseUrlLabel: "ferrion Base-URL",
    apiKeyLabel: "ferrion API-Key",
    apiKeyConfiguredPlaceholder: "•••• (leer lassen, um den gespeicherten Key zu behalten)",
    allowSelfSignedLabel: "Selbstsigniertes Zertifikat akzeptieren (nur für lokale Entwicklung, nicht für den Produktivbetrieb)",
    save: "Speichern",
    saved: "✓ Gespeichert",
    addInstanceTitle: "Simulator-Instanz hinzufügen",
    editInstanceTitle: "Simulator-Instanz bearbeiten",
    nameLabel: "Name",
    kindLabel: "Instanztyp",
    kindBridge: "Bridge (physische Sensoren)",
    trackedSensorsHeading: "Gebridgte Sensoren",
    trackedSensorsNameColumn: "Name",
    trackedSensorsIpColumn: "IP-Adresse",
    trackedSensorsPortColumn: "Port",
    trackedSensorsProtocolColumn: "Protokoll",
    trackedSensorsStatusColumn: "Status",
    trackedSensorStatusLive: "Live",
    trackedSensorStatusStale: "Keine aktuellen Daten",
    trackedSensorStatusError: "Fehler",
    trackedSensorStatusNodeUnknown: "Datenpunkt am Gerät unbekannt",
    trackedSensorMetricNever: "noch kein Wert",
    trackedSensorMetricAgeSeconds: (n) => `vor ${n} s`,
    trackedSensorMetricAgeMinutes: (n) => `vor ${n} min`,
    trackedSensorMetricAgeHours: (n) => `vor ${n} h`,
    templateLabel: "Gerätevorlage",
    serialLabel: "Seriennummer",
    serialHint: "(optional, nur OPC UA)",
    advancedTitle: "Erweitert",
    advancedHint:
      "Leer lassen für die Standardwerte. Schnellere Lese-Intervalle (bis in den ms-Bereich) werden aggregiert weitergegeben, nicht 1:1 an ferrion gepusht.",
    readingIntervalLabel: "Lese-Intervall (ms)",
    pushIntervalLabel: "Push-Intervall (ms)",
    aggregationLabel: "Aggregation",
    aggregationLast: "Letzter Wert",
    aggregationAvg: "Durchschnitt",
    aggregationMin: "Minimum",
    aggregationMax: "Maximum",
    bridgeSettingsTitle: "Bridge-Einstellungen",
    bridgeSettingsHint:
      "Gilt für die Bridge-Instanz (echte OT-Hardware). Leer lassen für die Standardwerte. Speichern startet die Bridge kurz neu, damit die neuen Werte wirksam werden - keine Netzwerk-Unterbrechung, nur ein lokaler Prozessneustart.",
    commandsIntervalLabel: "Befehls-Intervall (ms)",
    dataSourcesIntervalLabel: "Datenquellen-Erkennungs-Intervall (ms)",
    httpRequestTimeoutLabel: "HTTP-Timeout (ms)",
    readingBufferMaxSizeLabel: "Max. Puffergröße (Einträge)",
    create: "Anlegen",
    cancel: "Abbrechen",
    ok: "OK",
    loading: "Lade Instanzen…",
    empty: "Noch keine Instanzen angelegt.",
    statusStopped: "Gestoppt",
    statusStarting: "Startet…",
    statusRunning: "Läuft",
    statusRunningDegraded: "Läuft (Verbindung zu ferrion unterbrochen)",
    statusError: "Fehler",
    device: "Gerät",
    connection: "Verbindung",
    serialNumberLabel: "Seriennummer",
    start: "Starten",
    stop: "Stoppen",
    edit: "Bearbeiten",
    delete: "Löschen",
    deleteConfirm: (name) => `Instanz "${name}" wirklich löschen?`,
    deleteConnectionConfirm: "ferrion-Verbindung wirklich löschen? Bereits laufende Instanzen sind davon nicht betroffen.",
    connectionStatusUnconfigured: "Nicht eingerichtet",
    connectionStatusChecking: "Prüfe…",
    connectionStatusConnected: "Verbunden",
    connectionStatusUnauthorized: "API-Key ungültig",
    connectionStatusUnreachable: "Nicht erreichbar",
    errorSettingsNotConfigured: "ferrion-Verbindung noch nicht eingerichtet - zuerst den API-Key konfigurieren",
    errorApiKeyRequired: "API-Key erforderlich",
    errorInstanceNotFound: "Instanz nicht gefunden",
    errorStopBeforeEdit: "Zum Bearbeiten muss die Instanz erst gestoppt werden",
    errorInvalidRequest: "Ungültige Eingabe",
    errorBridgeCannotBeEdited: "Die Bridge-Instanz wird automatisch verwaltet und kann nicht bearbeitet werden",
    errorBridgeCannotBeDeleted: "Die Bridge-Instanz wird automatisch verwaltet und kann nicht gelöscht werden",
    errorBridgeCannotBeStopped: "Die Bridge-Instanz wird automatisch verwaltet und kann nicht gestoppt werden",
    errorNotBridgeInstance: "Dieser Endpunkt gilt nur für die Bridge-Instanz",
    backToOverview: "Zurück zur Übersicht",
    aboutTab: "Info",
    licenseTab: "Lizenz",
    licensesTab: "Open-Source-Lizenzen",
    footerNavAriaLabel: "Info-Seiten",
    aboutAppNameLabel: "Anwendungsname",
    aboutDescriptionLabel: "Beschreibung",
    aboutVersionLabel: "Version",
    aboutContactLabel: "Kontakt",
    licenseHeading: "Lizenz",
    licenseIntro:
      "ferrion Gateway steht unter der Apache License, Version 2.0. Der vollständige Lizenztext folgt unten — er ist zugleich die Nutzungsvereinbarung, eine gesonderte gibt es nicht.",
    licenseLoading: "Lizenztext wird geladen …",
    licenseUnavailable: "Der Lizenztext konnte nicht geladen werden. Er liegt als Datei LICENSE bei.",
    licenseNoticeLink: "Lizenztexte der mitgelieferten Fremdkomponenten (NOTICE)",
    licensesHeading: "Open-Source-Lizenzen",
    licensesIntro:
      "ferrion Gateway wird mithilfe der Open-Source-Community gebaut. Die Tabelle listet die direkten Abhängigkeiten. Die vollständigen Lizenztexte aller mitgelieferten Komponenten stehen in der Datei NOTICE, verlinkt auf der Lizenz-Seite.",
    licensesNameColumn: "Name",
    licensesVersionColumn: "Version",
    licensesLicenseColumn: "Lizenz",
  },
  en: {
    subtitle:
      'Create, start/stop local gateway instances, and view their connection info to copy into ferrion\'s own "Add data source" dialog.',
    settingsTitle: "ferrion connection",
    settingsHint: "Set up once - every instance shares this connection. Find the API key in ferrion under Settings → Gateways.",
    connectedAsGateway: (name) => `Connected as "${name}"`,
    baseUrlLabel: "ferrion base URL",
    apiKeyLabel: "ferrion API key",
    apiKeyConfiguredPlaceholder: "•••• (leave blank to keep the saved key)",
    allowSelfSignedLabel: "Accept a self-signed certificate (local development only, not for production)",
    save: "Save",
    saved: "✓ Saved",
    addInstanceTitle: "Add simulator instance",
    editInstanceTitle: "Edit simulator instance",
    nameLabel: "Name",
    kindLabel: "Instance type",
    kindBridge: "Bridge (physical sensors)",
    trackedSensorsHeading: "Bridged sensors",
    trackedSensorsNameColumn: "Name",
    trackedSensorsIpColumn: "IP address",
    trackedSensorsPortColumn: "Port",
    trackedSensorsProtocolColumn: "Protocol",
    trackedSensorsStatusColumn: "Status",
    trackedSensorStatusLive: "Live",
    trackedSensorStatusStale: "No recent data",
    trackedSensorStatusError: "Error",
    trackedSensorStatusNodeUnknown: "Data point unknown on the device",
    trackedSensorMetricNever: "no value yet",
    trackedSensorMetricAgeSeconds: (n) => `${n} s ago`,
    trackedSensorMetricAgeMinutes: (n) => `${n} min ago`,
    trackedSensorMetricAgeHours: (n) => `${n} h ago`,
    templateLabel: "Device template",
    serialLabel: "Serial number",
    serialHint: "(optional, OPC UA only)",
    advancedTitle: "Advanced",
    advancedHint:
      "Leave blank for the defaults. Faster read intervals (down to the ms range) are aggregated before being pushed to ferrion, not sent 1:1.",
    readingIntervalLabel: "Read interval (ms)",
    pushIntervalLabel: "Push interval (ms)",
    aggregationLabel: "Aggregation",
    aggregationLast: "Last value",
    aggregationAvg: "Average",
    aggregationMin: "Minimum",
    aggregationMax: "Maximum",
    bridgeSettingsTitle: "Bridge settings",
    bridgeSettingsHint:
      "Applies to the bridge instance (real OT hardware). Leave blank for the defaults. Saving briefly restarts the bridge for the new values to take effect - no network interruption, just a local process restart.",
    commandsIntervalLabel: "Command interval (ms)",
    dataSourcesIntervalLabel: "Data source discovery interval (ms)",
    httpRequestTimeoutLabel: "HTTP timeout (ms)",
    readingBufferMaxSizeLabel: "Max buffer size (entries)",
    create: "Create",
    cancel: "Cancel",
    ok: "OK",
    loading: "Loading instances…",
    empty: "No instances yet.",
    statusStopped: "Stopped",
    statusStarting: "Starting…",
    statusRunning: "Running",
    statusRunningDegraded: "Running (connection to ferrion lost)",
    statusError: "Error",
    device: "Device",
    connection: "Connection",
    serialNumberLabel: "Serial number",
    start: "Start",
    stop: "Stop",
    edit: "Edit",
    delete: "Delete",
    deleteConfirm: (name) => `Really delete instance "${name}"?`,
    deleteConnectionConfirm: "Really delete the ferrion connection? Already-running instances are not affected.",
    connectionStatusUnconfigured: "Not configured",
    connectionStatusChecking: "Checking…",
    connectionStatusConnected: "Connected",
    connectionStatusUnauthorized: "Invalid API key",
    connectionStatusUnreachable: "Unreachable",
    errorSettingsNotConfigured: "ferrion connection not configured yet - set the API key first",
    errorApiKeyRequired: "API key is required",
    errorInstanceNotFound: "Instance not found",
    errorStopBeforeEdit: "Stop the instance before editing it",
    errorInvalidRequest: "Invalid input",
    errorBridgeCannotBeEdited: "The bridge instance is managed automatically and cannot be edited",
    errorBridgeCannotBeDeleted: "The bridge instance is managed automatically and cannot be deleted",
    errorBridgeCannotBeStopped: "The bridge instance is managed automatically and cannot be stopped",
    errorNotBridgeInstance: "This endpoint only applies to the bridge instance",
    backToOverview: "Back to overview",
    aboutTab: "About",
    licenseTab: "License",
    licensesTab: "Open Source Licenses",
    footerNavAriaLabel: "Info pages",
    aboutAppNameLabel: "Application name",
    aboutDescriptionLabel: "Description",
    aboutVersionLabel: "Version",
    aboutContactLabel: "Contact",
    licenseHeading: "License",
    licenseIntro:
      "ferrion Gateway is licensed under the Apache License, Version 2.0. The full text follows below \u2014 it is also the terms of use; there is no separate agreement.",
    licenseLoading: "Loading licence text \u2026",
    licenseUnavailable: "The licence text could not be loaded. It ships as the file LICENSE.",
    licenseNoticeLink: "Licence texts of the bundled third-party components (NOTICE)",
    licensesHeading: "Open source licenses",
    licensesIntro:
      "ferrion Gateway is built with the help of the open source community. The table lists the direct dependencies. Full licence texts for every bundled component are in the NOTICE file, linked from the License page.",
    licensesNameColumn: "Name",
    licensesVersionColumn: "Version",
    licensesLicenseColumn: "License",
  },
};

// The API itself returns fixed English message strings, not error codes
// (see routes.ts) - this maps the handful of known ones to a translation,
// falling back to showing the raw message for anything unrecognized.
const SERVER_ERROR_KEYS = {
  "ferrion settings not configured yet - set the API key first": "errorSettingsNotConfigured",
  "API key is required": "errorApiKeyRequired",
  "Instance not found": "errorInstanceNotFound",
  "Stop the instance before editing it": "errorStopBeforeEdit",
  "Invalid request": "errorInvalidRequest",
  "The bridge instance is managed automatically and cannot be edited": "errorBridgeCannotBeEdited",
  "The bridge instance is managed automatically and cannot be deleted": "errorBridgeCannotBeDeleted",
  "The bridge instance is managed automatically and cannot be stopped": "errorBridgeCannotBeStopped",
  "This endpoint only applies to the bridge instance": "errorNotBridgeInstance",
};

const STORAGE_KEY = "ferrion-gateway-locale";

export function getLocale() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "de" || stored === "en") return stored;
  return navigator.language.toLowerCase().startsWith("de") ? "de" : "en";
}

export function setLocale(locale) {
  localStorage.setItem(STORAGE_KEY, locale);
}

export function t(key, ...args) {
  const value = translations[getLocale()][key] ?? translations.en[key] ?? key;
  return typeof value === "function" ? value(...args) : value;
}

export function translateServerError(message) {
  const key = SERVER_ERROR_KEYS[message];
  return key ? t(key) : message;
}

// Generic [data-i18n] textContent replacement + lang-switch button active
// state, for the simpler about/license/licenses pages - app.js keeps its own
// richer applyStaticTranslations() (which also updates form headings and
// connection status) unchanged rather than being generalized to cover
// this, since index.html is the one already-working page here and
// shouldn't be refactored just to share a few lines with three new ones.
export function applyI18n(langSwitchEl) {
  document.documentElement.lang = getLocale();
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  if (langSwitchEl) {
    for (const button of langSwitchEl.querySelectorAll("button")) {
      const isActive = button.dataset.locale === getLocale();
      button.setAttribute("aria-pressed", String(isActive));
      button.className = isActive ? "primary" : "";
    }
  }
}

export function wireLangSwitch(langSwitchEl, onChange) {
  langSwitchEl.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-locale]");
    if (!button) return;
    setLocale(button.dataset.locale);
    onChange();
  });
}
