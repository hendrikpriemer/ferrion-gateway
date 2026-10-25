import { getLocale, setLocale, t, translateServerError } from "./i18n.js";

const instancesEl = document.getElementById("instances");
const form = document.getElementById("create-form");
const templateSelect = form.elements.templateId;
const createErrorEl = document.getElementById("create-error");
const formIcon = document.getElementById("instance-form-icon");
const formTitle = document.getElementById("instance-form-title");
const formSubmitIcon = document.getElementById("instance-form-submit-icon");
const formSubmitLabel = document.getElementById("instance-form-submit-label");
const formCancel = document.getElementById("instance-form-cancel");
const settingsForm = document.getElementById("settings-form");
const settingsErrorEl = document.getElementById("settings-error");
const settingsSavedEl = document.getElementById("settings-saved");
const settingsSaveButton = document.getElementById("settings-save");
const settingsDeleteButton = document.getElementById("settings-delete");
const connectionStatusDot = document.getElementById("connection-status-dot");
const connectionStatusLabel = document.getElementById("connection-status-label");
const connectedGatewayNameEl = document.getElementById("connected-gateway-name");
const langSwitch = document.getElementById("lang-switch");
const confirmDialog = document.getElementById("confirm-dialog");
const confirmDialogMessage = document.getElementById("confirm-dialog-message");
const confirmDialogCancel = document.getElementById("confirm-dialog-cancel");
const confirmDialogConfirm = document.getElementById("confirm-dialog-confirm");
const alertDialog = document.getElementById("alert-dialog");
const alertDialogMessage = document.getElementById("alert-dialog-message");
const alertDialogOk = document.getElementById("alert-dialog-ok");
const bridgeSettingsForm = document.getElementById("bridge-settings-form");
const bridgeSettingsErrorEl = document.getElementById("bridge-settings-error");
const bridgeSettingsSavedEl = document.getElementById("bridge-settings-saved");

let templates = [];
let instances = [];
let editingInstanceId = null;
let lastConnectionStatus = "unconfigured";
let lastGatewayName;
let savedSettingsSnapshot = null;
let bridgeInstanceId = null;

// Our own dialogs instead of the browser's alert()/confirm() - native
// <dialog> gives focus trapping, Escape-to-cancel, and a backdrop for
// free, styled to match ferrion's own ConfirmDialog.tsx/Modal.tsx.
function appConfirm(message, confirmLabel = t("delete")) {
  return new Promise((resolve) => {
    confirmDialogMessage.textContent = message;
    confirmDialogConfirm.textContent = confirmLabel;
    function onCancel() {
      cleanup();
      resolve(false);
    }
    function onConfirm() {
      cleanup();
      resolve(true);
    }
    function cleanup() {
      confirmDialogCancel.removeEventListener("click", onCancel);
      confirmDialogConfirm.removeEventListener("click", onConfirm);
      confirmDialog.removeEventListener("cancel", onCancel);
      confirmDialog.close();
    }
    confirmDialogCancel.addEventListener("click", onCancel);
    confirmDialogConfirm.addEventListener("click", onConfirm);
    confirmDialog.addEventListener("cancel", onCancel);
    confirmDialog.showModal();
  });
}

function appAlert(message) {
  return new Promise((resolve) => {
    alertDialogMessage.textContent = message;
    function onOk() {
      alertDialogOk.removeEventListener("click", onOk);
      alertDialog.removeEventListener("cancel", onOk);
      alertDialog.close();
      resolve();
    }
    alertDialogOk.addEventListener("click", onOk);
    alertDialog.addEventListener("cancel", onOk);
    alertDialog.showModal();
  });
}

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(translateServerError(body.error ?? `Request failed with ${response.status}`));
  }
  return body;
}

// Every value interpolated into innerHTML below goes through this. Asset
// names and hosts come from ferrion (typed by platform users), instance
// names and serial numbers from this form, lastError from the child process
// (which quotes ferrion response bodies) - none of them is ours to trust as
// markup. The info pages use textContent; the cards keep their templates
// and escape instead.
function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const INSTANCE_STATUS_CLASSES = new Set(["stopped", "starting", "running", "error", "degraded"]);

function protocolPort(instance) {
  return instance.ports.opcua ?? instance.ports.modbus ?? instance.ports.mqtt;
}

function connectionInfo(instance) {
  const port = protocolPort(instance);
  const template = templates.find((tpl) => tpl.id === instance.device.templateId);
  const protocol = template?.protocol ?? "";
  if (protocol === "MQTT") {
    return `mqtt://127.0.0.1:${port}`;
  }
  return `127.0.0.1:${port}`;
}

function templateLabel(templateId) {
  const template = templates.find((tpl) => tpl.id === templateId);
  return template ? `${template.manufacturer} ${template.model}` : templateId;
}

function statusLabel(status) {
  return (
    { stopped: t("statusStopped"), starting: t("statusStarting"), running: t("statusRunning"), error: t("statusError") }[
      status
    ] ?? status
  );
}

// A running instance whose last push to ferrion failed (pushDegraded, see
// process-manager.ts) looks identical to a healthy one without this - the
// process is alive, only the connection to ferrion is currently down. Shown
// as its own dot color/label rather than folded into "running" or "error".
function instanceStatusClass(instance) {
  const status = instance.status === "running" && instance.pushDegraded ? "degraded" : instance.status;
  return INSTANCE_STATUS_CLASSES.has(status) ? status : "stopped";
}

function instanceStatusLabel(instance) {
  return instance.status === "running" && instance.pushDegraded ? t("statusRunningDegraded") : statusLabel(instance.status);
}

// Reuses the same status-dot colors as instance cards (gray/yellow/green/
// red) rather than inventing a parallel palette just for this indicator.
const CONNECTION_STATUS_DOT_CLASS = {
  unconfigured: "stopped",
  checking: "starting",
  connected: "running",
  unauthorized: "error",
  unreachable: "error",
};

const CONNECTION_STATUS_LABEL_KEY = {
  unconfigured: "connectionStatusUnconfigured",
  checking: "connectionStatusChecking",
  connected: "connectionStatusConnected",
  unauthorized: "connectionStatusUnauthorized",
  unreachable: "connectionStatusUnreachable",
};

function renderConnectionStatus(status, gatewayName = lastGatewayName) {
  lastConnectionStatus = status;
  lastGatewayName = gatewayName;
  connectionStatusDot.className = `status-dot ${CONNECTION_STATUS_DOT_CLASS[status] ?? "stopped"}`;
  connectionStatusLabel.textContent = t(CONNECTION_STATUS_LABEL_KEY[status] ?? status);
  settingsDeleteButton.hidden = status === "unconfigured";
  // The name ferrion itself assigned this gateway (Settings → Gateways) -
  // only ever known once actually connected, since it comes from that
  // same successful request (see ferrion-connectivity.ts).
  connectedGatewayNameEl.hidden = status !== "connected" || !gatewayName;
  if (gatewayName) connectedGatewayNameEl.textContent = t("connectedAsGateway", gatewayName);
}

// showChecking only flashes the transient "checking…" state for
// user-triggered checks (initial load, right after save/delete) - the
// periodic background poll updates silently so the indicator doesn't
// flicker every 15s.
async function checkConnectionStatus(showChecking = false) {
  if (showChecking) renderConnectionStatus("checking");
  try {
    const result = await api("api/settings/status");
    renderConnectionStatus(result.status, result.gatewayName);
  } catch {
    // The status-check request itself failed (not a ferrion-reachability
    // failure, which the endpoint always reports as 200 with a status
    // field) - leave the indicator as it was rather than guessing.
  }
}

// Disabled ("grayed out") whenever the form matches what's actually
// saved - the only way to tell for sure a save succeeded, rather than a
// transient "✓ Gespeichert" text that's easy to miss. Re-enables the
// moment the user changes anything, since that's real, unsaved state
// again.
function settingsFormMatchesSaved() {
  if (!savedSettingsSnapshot) return false;
  const current = Object.fromEntries(new FormData(settingsForm).entries());
  // apiKey is never known client-side once saved (see routes.ts's
  // redactSettings() - it's a live credential and this page has no
  // authentication of its own) - an empty field means "keep the existing
  // key unchanged", so that counts as matching too, not as a mismatch.
  const allowSelfSignedMatches =
    settingsForm.elements.allowSelfSigned.checked === (savedSettingsSnapshot.rejectUnauthorized === false);
  return current.baseUrl === savedSettingsSnapshot.baseUrl && current.apiKey === "" && allowSelfSignedMatches;
}

function updateSettingsSaveButtonState() {
  settingsSaveButton.disabled = settingsFormMatchesSaved();
}

settingsForm.addEventListener("input", updateSettingsSaveButtonState);

function updateFormHeading() {
  const isEditing = editingInstanceId !== null;
  formIcon.textContent = isEditing ? "edit" : "add";
  formTitle.textContent = isEditing ? t("editInstanceTitle") : t("addInstanceTitle");
  formSubmitIcon.textContent = isEditing ? "save" : "add";
  formSubmitLabel.textContent = isEditing ? t("save") : t("create");
}

const advancedFieldsEl = document.getElementById("advanced-fields");

// The bridge instance is control-plane-managed (see routes.ts's
// ensureBridgeInstance()) and its Edit button never renders (see
// renderInstances() below), so this only ever runs for a simulated
// instance - every field here always applies.
function startEditing(instance) {
  editingInstanceId = instance.id;
  form.elements.instanceName.value = instance.instanceName;
  form.elements.templateId.value = instance.device.templateId;
  form.elements.serialNumber.value = instance.device.serialNumber ?? "";
  const polling = instance.polling ?? {};
  form.elements.readingIntervalMs.value = polling.readingIntervalMs ?? "";
  form.elements.readingsPushIntervalMs.value = polling.readingsPushIntervalMs ?? "";
  form.elements.aggregation.value = polling.aggregation ?? "last";
  // Auto-open so an instance that already has non-default polling doesn't
  // hide it behind a collapsed <details> the user has to know to expand.
  advancedFieldsEl.open = Object.keys(polling).length > 0;
  updateFormHeading();
  formCancel.hidden = false;
  createErrorEl.hidden = true;
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function stopEditing() {
  editingInstanceId = null;
  form.reset();
  advancedFieldsEl.open = false;
  updateFormHeading();
  formCancel.hidden = true;
}

formCancel.addEventListener("click", stopEditing);

// Reuses the same status-dot palette as instance status (green/yellow/
// red) rather than a parallel one just for this - see reading-loop.ts's
// getTrackedSensors() for where live/stale/error actually come from.
// A metric's own freshness, shown under the sensor name so a single dark
// datapoint on an otherwise-live sensor is visible (Befund 2). Computed at
// render from the snapshot's lastValueAt - the card re-renders on every
// poll, so the age stays roughly current without its own ticker.
function metricAgeLabel(metric) {
  if (metric.lastValueAt === null || metric.lastValueAt === undefined) return t("trackedSensorMetricNever");
  const seconds = Math.max(0, Math.round((Date.now() - metric.lastValueAt) / 1000));
  if (seconds < 60) return t("trackedSensorMetricAgeSeconds", seconds);
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("trackedSensorMetricAgeMinutes", minutes);
  return t("trackedSensorMetricAgeHours", Math.round(minutes / 60));
}

const TRACKED_SENSOR_DOT_CLASS = { live: "running", stale: "starting", error: "error", "node-unknown": "error" };
const TRACKED_SENSOR_LABEL_KEY = {
  live: "trackedSensorStatusLive",
  stale: "trackedSensorStatusStale",
  error: "trackedSensorStatusError",
  "node-unknown": "trackedSensorStatusNodeUnknown",
};

function renderInstances() {
  if (instances.length === 0) {
    instancesEl.innerHTML = `<p class="empty md-body-medium">${t("empty")}</p>`;
    return;
  }

  instancesEl.innerHTML = "";
  for (const instance of instances) {
    const isStartable = instance.status === "stopped" || instance.status === "error";
    // The bridge instance (see routes.ts's ensureBridgeInstance()) is
    // control-plane-managed: no Stop/Edit/Delete from here, only Start
    // stays available so a crashed bridge can still be kicked manually
    // instead of only waiting for its own keepAlive auto-restart
    // (process-manager.ts).
    const isBridge = !instance.device;
    const showToggleButton = !isBridge || isStartable;
    const showEditButton = isStartable && !isBridge;
    const showDeleteButton = !isBridge;
    const card = document.createElement("article");
    // The bridge card spans the full grid width (see index.html's
    // .instance-card--wide) instead of sizing like every other, much
    // narrower simulated-instance card - its tracked-sensors table
    // otherwise had to horizontal-scroll even on a large desktop screen,
    // just from being squeezed into a ~280-400px auto-fill column.
    card.className = isBridge ? "card instance-card instance-card--wide" : "card instance-card";
    // A bridge-only instance has no local device/connection info to show
    // at all - what it's actually bridging lives entirely in ferrion's
    // own data-source config, surfaced instead via trackedSensorsHtml
    // below (populated from reading-loop.ts's getTrackedSensors() via
    // process-manager.ts's IPC handling).
    const deviceRows = instance.device
      ? `
      <div class="row md-body-medium"><span class="label">${t("device")}</span><span>${esc(templateLabel(instance.device.templateId))}</span></div>
      <div class="row md-body-medium"><span class="label">${t("connection")}</span><code>${esc(connectionInfo(instance))}</code></div>
      ${instance.device.serialNumber ? `<div class="row md-body-medium"><span class="label">${t("serialNumberLabel")}</span><span>${esc(instance.device.serialNumber)}</span></div>` : ""}
    `
      : `<div class="row md-body-medium"><span class="label">${t("kindLabel")}</span><span>${t("kindBridge")}</span></div>`;
    // One row per physical sensor (not per metric) - see reading-loop.ts's
    // getTrackedSensors() doc comment for why the grouping happens there
    // rather than here. Read-only, same as every other field on this
    // card: changes only ever happen through the ferrion platform itself.
    const trackedSensorsHtml =
      isBridge && instance.trackedSensors?.length
        ? `
      <div class="tracked-sensors">
        <h4 class="md-label-large tracked-sensors-heading">${t("trackedSensorsHeading")}</h4>
        <div class="tracked-sensors-scroll">
          <table class="tracked-sensors-table md-body-small">
            <thead>
              <tr>
                <th>${t("trackedSensorsNameColumn")}</th>
                <th>${t("trackedSensorsIpColumn")}</th>
                <th>${t("trackedSensorsPortColumn")}</th>
                <th>${t("trackedSensorsProtocolColumn")}</th>
                <th>${t("trackedSensorsStatusColumn")}</th>
              </tr>
            </thead>
            <tbody>
              ${instance.trackedSensors
                .map(
                  (sensor) => `
                <tr>
                  <td>
                    ${esc(sensor.assetName)}
                    ${
                      sensor.metrics?.length
                        ? `<ul class="tracked-metrics">${sensor.metrics
                            .map(
                              (metric) => `
                        <li class="tracked-metric">
                          <span class="status-dot ${TRACKED_SENSOR_DOT_CLASS[metric.status] ?? "stopped"}" aria-hidden="true"></span>
                          <span class="tracked-metric-label">${esc(metric.label)}</span>
                          <span class="tracked-metric-age">${esc(metricAgeLabel(metric))}</span>
                        </li>`,
                            )
                            .join("")}</ul>`
                        : ""
                    }
                  </td>
                  <td>${esc(sensor.host ?? "-")}</td>
                  <td>${esc(sensor.port ?? "-")}</td>
                  <td>${esc(sensor.protocol)}</td>
                  <td>
                    <span class="status-indicator">
                      <span class="status-dot ${TRACKED_SENSOR_DOT_CLASS[sensor.status] ?? "stopped"}" aria-hidden="true"></span>
                      ${t(TRACKED_SENSOR_LABEL_KEY[sensor.status] ?? sensor.status)}
                    </span>
                  </td>
                </tr>
              `,
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>
    `
        : "";
    card.innerHTML = `
      <div class="row" style="margin-bottom: 0.75rem">
        <h3 class="md-title-medium">${esc(instance.instanceName)}</h3>
        <span class="status-indicator md-body-small">
          <span class="status-dot ${instanceStatusClass(instance)}" aria-hidden="true"></span>
          ${esc(instanceStatusLabel(instance))}
        </span>
      </div>
      ${deviceRows}
      ${instance.lastError ? `<p class="error-text md-body-small">${esc(instance.lastError)}</p>` : ""}
      <div class="actions">
        ${
          showToggleButton
            ? `<button type="button" data-action="${isStartable ? "start" : "stop"}" class="primary">
                <span class="material-symbols-outlined" aria-hidden="true">${isStartable ? "play_arrow" : "stop"}</span>
                ${isStartable ? t("start") : t("stop")}
              </button>`
            : ""
        }
        ${
          showEditButton
            ? `<button type="button" data-action="edit">
                <span class="material-symbols-outlined" aria-hidden="true">edit</span>
                ${t("edit")}
              </button>`
            : ""
        }
        ${
          showDeleteButton
            ? `<button type="button" data-action="delete" class="danger">
                <span class="material-symbols-outlined" aria-hidden="true">delete</span>
                ${t("delete")}
              </button>`
            : ""
        }
      </div>
      ${trackedSensorsHtml}
    `;

    const toggleButton = card.querySelector('[data-action="start"], [data-action="stop"]');
    toggleButton?.addEventListener("click", async () => {
      const action = toggleButton.dataset.action;
      toggleButton.disabled = true;
      try {
        await api(`api/instances/${instance.id}/${action}`, { method: "POST" });
        await refresh();
      } catch (error) {
        await appAlert(error.message);
      } finally {
        toggleButton.disabled = false;
      }
    });

    const editButton = card.querySelector('[data-action="edit"]');
    editButton?.addEventListener("click", () => startEditing(instance));

    card.querySelector('[data-action="delete"]')?.addEventListener("click", async () => {
      if (!(await appConfirm(t("deleteConfirm", instance.instanceName)))) return;
      if (editingInstanceId === instance.id) stopEditing();
      await api(`api/instances/${instance.id}`, { method: "DELETE" });
      await refresh();
    });

    instancesEl.appendChild(card);
  }
}

async function refresh() {
  ({ instances } = await api("api/instances"));
  renderInstances();
}

async function loadTemplates() {
  templates = await api("api/templates");
  templateSelect.innerHTML = templates
    .map((tpl) => `<option value="${esc(tpl.id)}">${esc(`${tpl.manufacturer} ${tpl.model}`)}</option>`)
    .join("");
}

const DEFAULT_API_KEY_PLACEHOLDER = "gw_…";

async function loadSettings() {
  const settings = await api("api/settings");
  if (settings) {
    settingsForm.elements.baseUrl.value = settings.baseUrl;
    // The real key is never sent back (see routes.ts's redactSettings())
    // - the field stays empty, with a placeholder signaling one's
    // already configured. Typing a new value replaces it on save;
    // leaving it blank keeps the existing key (see the submit handler
    // and settingsFormMatchesSaved() above).
    settingsForm.elements.apiKey.value = "";
    settingsForm.elements.apiKey.placeholder = settings.hasApiKey
      ? t("apiKeyConfiguredPlaceholder")
      : DEFAULT_API_KEY_PLACEHOLDER;
    settingsForm.elements.allowSelfSigned.checked = settings.rejectUnauthorized === false;
    savedSettingsSnapshot = settings;
  }
  updateSettingsSaveButtonState();
}

// Loaded once at startup, not tied to refresh()'s 3s poll cycle - like
// loadSettings(), so a background poll never clobbers an in-progress edit
// in this form. There's always exactly one bridge instance (see
// routes.ts's ensureBridgeInstance()).
async function loadBridgeSettings() {
  const { instances: allInstances } = await api("api/instances");
  const bridge = allInstances.find((instance) => !instance.device);
  if (!bridge) return;
  bridgeInstanceId = bridge.id;
  const polling = bridge.polling ?? {};
  const resilience = bridge.resilience ?? {};
  bridgeSettingsForm.elements.commandsIntervalMs.value = polling.commandsIntervalMs ?? "";
  bridgeSettingsForm.elements.dataSourcesIntervalMs.value = polling.dataSourcesIntervalMs ?? "";
  bridgeSettingsForm.elements.readingIntervalMs.value = polling.readingIntervalMs ?? "";
  bridgeSettingsForm.elements.readingsPushIntervalMs.value = polling.readingsPushIntervalMs ?? "";
  bridgeSettingsForm.elements.aggregation.value = polling.aggregation ?? "last";
  bridgeSettingsForm.elements.httpRequestTimeoutMs.value = resilience.httpRequestTimeoutMs ?? "";
  bridgeSettingsForm.elements.readingBufferMaxSize.value = resilience.readingBufferMaxSize ?? "";
}

// Same "omit blanks, let the server fall back to its own defaults"
// technique as extractPollingOverrides(), just covering all 5 polling +
// both resilience fields for the wider bridge-settings payload.
function extractBridgeSettingsPayload(payload) {
  const polling = {};
  if (payload.commandsIntervalMs) polling.commandsIntervalMs = Number(payload.commandsIntervalMs);
  if (payload.dataSourcesIntervalMs) polling.dataSourcesIntervalMs = Number(payload.dataSourcesIntervalMs);
  if (payload.readingIntervalMs) polling.readingIntervalMs = Number(payload.readingIntervalMs);
  if (payload.readingsPushIntervalMs) polling.readingsPushIntervalMs = Number(payload.readingsPushIntervalMs);
  if (payload.aggregation && payload.aggregation !== "last") polling.aggregation = payload.aggregation;
  const resilience = {};
  if (payload.httpRequestTimeoutMs) resilience.httpRequestTimeoutMs = Number(payload.httpRequestTimeoutMs);
  if (payload.readingBufferMaxSize) resilience.readingBufferMaxSize = Number(payload.readingBufferMaxSize);
  return { polling, resilience };
}

bridgeSettingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  bridgeSettingsErrorEl.hidden = true;
  bridgeSettingsSavedEl.hidden = true;
  const formData = new FormData(bridgeSettingsForm);
  const payload = extractBridgeSettingsPayload(Object.fromEntries(formData.entries()));

  try {
    await api(`api/instances/${bridgeInstanceId}/bridge-settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    bridgeSettingsSavedEl.hidden = false;
    await refresh();
  } catch (error) {
    bridgeSettingsErrorEl.textContent = error.message;
    bridgeSettingsErrorEl.hidden = false;
  }
});

function applyStaticTranslations() {
  document.documentElement.lang = getLocale();
  for (const el of document.querySelectorAll("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const button of langSwitch.querySelectorAll("button")) {
    const isActive = button.dataset.locale === getLocale();
    button.setAttribute("aria-pressed", String(isActive));
    button.className = isActive ? "primary" : "";
  }
  updateFormHeading();
  renderConnectionStatus(lastConnectionStatus);
}

langSwitch.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-locale]");
  if (!button) return;
  setLocale(button.dataset.locale);
  applyStaticTranslations();
  renderInstances();
});

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsErrorEl.hidden = true;
  settingsSavedEl.hidden = true;
  const formData = new FormData(settingsForm);
  const payload = Object.fromEntries(formData.entries());
  // Omitted, not sent as "" - the PUT schema treats a present-but-empty
  // apiKey as invalid input, and only a genuinely absent field means
  // "keep the existing key" (see routes.ts's PUT handler).
  if (!payload.apiKey) delete payload.apiKey;
  // A checkbox is only present in FormData at all when checked - convert
  // it to the boolean the API actually expects (checked = accept a
  // self-signed cert = skip validation), inverted from the checkbox's own
  // "allow" framing.
  payload.rejectUnauthorized = !!payload.allowSelfSigned;
  delete payload.allowSelfSigned;

  try {
    const saved = await api("api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    settingsForm.elements.apiKey.value = "";
    settingsForm.elements.apiKey.placeholder = t("apiKeyConfiguredPlaceholder");
    savedSettingsSnapshot = saved;
    updateSettingsSaveButtonState();
    settingsSavedEl.hidden = false;
    await checkConnectionStatus(true);
  } catch (error) {
    settingsErrorEl.textContent = error.message;
    settingsErrorEl.hidden = false;
  }
});

settingsDeleteButton.addEventListener("click", async () => {
  if (!(await appConfirm(t("deleteConnectionConfirm")))) return;
  await api("api/settings", { method: "DELETE" });
  settingsForm.reset();
  settingsForm.elements.baseUrl.value = "https://localhost:3000";
  settingsForm.elements.apiKey.placeholder = DEFAULT_API_KEY_PLACEHOLDER;
  savedSettingsSnapshot = null;
  updateSettingsSaveButtonState();
  await checkConnectionStatus(true);
});

// Pulls the three flat "Erweitert" fields out of the plain form payload
// into the nested `polling` shape routes.ts's pollingOverridesSchema
// expects - blank/default fields are simply omitted so the server falls
// back to pollingSchema's own defaults, same as an instance that never set
// them at all.
function extractPollingOverrides(payload) {
  const polling = {};
  if (payload.readingIntervalMs) polling.readingIntervalMs = Number(payload.readingIntervalMs);
  if (payload.readingsPushIntervalMs) polling.readingsPushIntervalMs = Number(payload.readingsPushIntervalMs);
  if (payload.aggregation && payload.aggregation !== "last") polling.aggregation = payload.aggregation;
  delete payload.readingIntervalMs;
  delete payload.readingsPushIntervalMs;
  delete payload.aggregation;
  if (Object.keys(polling).length > 0) payload.polling = polling;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  createErrorEl.hidden = true;
  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  if (!payload.serialNumber) delete payload.serialNumber;
  extractPollingOverrides(payload);

  const isEditing = editingInstanceId !== null;
  try {
    await api(isEditing ? `api/instances/${editingInstanceId}` : "api/instances", {
      method: isEditing ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (isEditing) {
      stopEditing();
    } else {
      form.reset();
    }
    await refresh();
  } catch (error) {
    createErrorEl.textContent = error.message;
    createErrorEl.hidden = false;
  }
});

applyStaticTranslations();
await loadTemplates();
await loadSettings();
await refresh();
await loadBridgeSettings();
await checkConnectionStatus(true);
setInterval(refresh, 3000);
setInterval(() => checkConnectionStatus(false), 15000);
