/* ══════════════════════════════════════════════════════════════════
   Energy LLM — Battery Configurator Frontend
   ══════════════════════════════════════════════════════════════════ */

const API = "/api";

const COOLING_LABELS = {
  0: "S-type",
  1: "C-type",
  2: "SS-type (Double S)",
  3: "E-type",
};

const CELL_TYPE_LABELS = {
  cylindrical: "Cylindrical",
  prismatic:   "Prismatic",
  pouch:       "Pouch",
};

// Subtypes per main type  { value, label }
const CELL_SUBTYPES = {
  cylindrical: [
    { value: "18650", label: "18650  (18×65 mm)" },
    { value: "21700", label: "21700  (21×70 mm)" },
    { value: "4680",  label: "4680   (46×80 mm)" },
    { value: "26650", label: "26650  (26×65 mm)" },
    { value: "14500", label: "14500  (14×50 mm)" },
  ],
  prismatic: [
    { value: "lfp_prismatic", label: "LFP Prismatic" },
    { value: "nmc_prismatic", label: "NMC Prismatic" },
    { value: "nca_prismatic", label: "NCA Prismatic" },
  ],
  pouch: [
    { value: "lfp_pouch", label: "LFP Pouch" },
    { value: "nmc_pouch", label: "NMC Pouch" },
    { value: "nca_pouch", label: "NCA Pouch" },
  ],
};

let _lastHeaderContent = "";
let _lastTemplateMatches = [];   // retain last template list so it persists after selection

function clearTemplates() {
  _lastTemplateMatches = [];
  document.getElementById("templateSection").classList.add("hidden");
  document.getElementById("templateCards").innerHTML = "";
}

// ── Boot ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  loadLastUsedKey();       // restore last-used key into form
  renderSavedKeysList();   // populate saved-keys dropdown
  fetchState();
});

// Close key manager when clicking outside
document.addEventListener("click", (e) => {
  const panel = document.getElementById("keyManagerPanel");
  const btn   = document.querySelector(".btn-saved-keys");
  if (!panel.classList.contains("hidden") &&
      !panel.contains(e.target) && e.target !== btn) {
    panel.classList.add("hidden");
  }
});

// ── Default models per provider ──────────────────────────────────────
const PROVIDER_MODELS = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
  openai:    ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-3.5-turbo"],
  deepseek:  ["deepseek-chat", "deepseek-reasoner"],
  gemini:    ["gemini-3.1-pro-preview", "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro"],
  custom:    [],
};

function onProviderChange() {
  const provider = document.getElementById("providerSelect").value;
  const modelEl  = document.getElementById("modelInput");
  const urlEl    = document.getElementById("baseUrlInput");

  // auto-fill default model for the selected provider
  const defaults = PROVIDER_MODELS[provider];
  if (defaults && defaults.length > 0) modelEl.value = defaults[0];
  else modelEl.value = "";

  // show Base URL input only for custom provider
  urlEl.classList.toggle("hidden", provider !== "custom");
}

// ══════════════════════════════════════════════════════════════════════
//  KEY MANAGEMENT (localStorage)
// ══════════════════════════════════════════════════════════════════════
const LS_KEYS  = "energyllm_saved_keys";
const LS_LAST  = "energyllm_last_key";

function getSavedKeys() {
  try { return JSON.parse(localStorage.getItem(LS_KEYS) || "[]"); }
  catch { return []; }
}

function saveKeyEntry(entry) {
  const keys = getSavedKeys().filter(k => k.name !== entry.name);
  keys.unshift(entry);          // newest first
  localStorage.setItem(LS_KEYS, JSON.stringify(keys));
}

function deleteKeyEntry(name) {
  const keys = getSavedKeys().filter(k => k.name !== name);
  localStorage.setItem(LS_KEYS, JSON.stringify(keys));
}

function loadLastUsedKey() {
  try {
    const last = JSON.parse(localStorage.getItem(LS_LAST) || "null");
    if (!last) return;
    applyKeyEntry(last, false);   // populate form without connecting
  } catch {}
}

function applyKeyEntry(entry, connect = true) {
  document.getElementById("providerSelect").value = entry.provider || "anthropic";
  document.getElementById("modelInput").value     = entry.model    || "";
  document.getElementById("tokenInput").value     = entry.token    || "";
  document.getElementById("saveNameInput").value  = entry.name     || "";
  const urlEl = document.getElementById("baseUrlInput");
  urlEl.value = entry.base_url || "";
  urlEl.classList.toggle("hidden", entry.provider !== "custom");
  if (connect) setToken();
}

function renderSavedKeysList() {
  const list = document.getElementById("savedKeysList");
  const keys = getSavedKeys();
  if (!keys.length) {
    list.innerHTML = `<div class="saved-keys-empty">No saved keys</div>`;
    return;
  }
  list.innerHTML = keys.map((k, i) => `
    <div class="saved-key-item" data-key-index="${i}">
      <div class="saved-key-info">
        <div class="saved-key-name">${escHtml(k.name)}</div>
        <div class="saved-key-meta">${escHtml(k.provider)} / ${escHtml(k.model)}</div>
      </div>
      <button class="saved-key-delete" data-key-name="${escHtml(k.name)}" title="Delete">✕</button>
    </div>
  `).join("");

  // event delegation to avoid inline handler injection
  list.querySelectorAll(".saved-key-item").forEach((el, i) => {
    el.addEventListener("click", () => applyKeyEntry(keys[i]));
  });
  list.querySelectorAll(".saved-key-delete").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteSavedKey(btn.dataset.keyName);
    });
  });
}

function deleteSavedKey(name) {
  deleteKeyEntry(name);
  renderSavedKeysList();
}

function toggleKeyManager() {
  const panel = document.getElementById("keyManagerPanel");
  renderSavedKeysList();
  panel.classList.toggle("hidden");
}

// ── Token / Connect ───────────────────────────────────────────────────
async function setToken() {
  const token    = document.getElementById("tokenInput").value.trim();
  const provider = document.getElementById("providerSelect").value;
  const model    = document.getElementById("modelInput").value.trim();
  const base_url = document.getElementById("baseUrlInput").value.trim();
  const saveName = document.getElementById("saveNameInput").value.trim();
  const statusEl = document.getElementById("tokenStatus");

  if (!token) {
    statusEl.textContent = "⚠ API key is empty";
    statusEl.className = "token-status fail";
    return;
  }

  try {
    const res = await post("/set-token", { token, provider, model, base_url });
    if (res.success) {
      statusEl.textContent = `✓ ${res.provider} / ${res.model}`;
      statusEl.className = "token-status ok";
      document.getElementById("tokenBtn").textContent = "Reconnect";

      // persist to localStorage
      const entry = { name: saveName || provider, provider, model, token, base_url };
      if (saveName) saveKeyEntry(entry);                         // named entry → persist
      localStorage.setItem(LS_LAST, JSON.stringify(entry));     // always remember last used
      renderSavedKeysList();
    }
  } catch (e) {
    statusEl.textContent = "✗ Connection failed";
    statusEl.className = "token-status fail";
  }
}

// ── Chat ──────────────────────────────────────────────────────────────
function handleKey(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

async function sendMessage() {
  const input = document.getElementById("chatInput");
  const msg = input.value.trim();
  if (!msg) return;

  input.value = "";
  appendMsg("user", msg);

  const thinkingEl = appendThinking();
  setLoading(true);

  try {
    const res = await post("/chat", { message: msg });
    thinkingEl.remove();

    if (res.error) {
      appendMsg("system", `❌ ${res.error}`);
    } else {
      appendMsg("ai", res.chat_reply);
      updateStatePanel(res);
    }
  } catch (e) {
    thinkingEl.remove();
    // distinguish real network failure from backend API errors
    const isNetworkDown = e instanceof TypeError && e.message.includes("fetch");
    const msg = isNetworkDown
      ? `❌ Cannot reach backend — make sure start.sh is running.`
      : `❌ ${e.message}`;
    appendMsg("system", msg);
  } finally {
    setLoading(false);
  }
}

// ── State fetch ───────────────────────────────────────────────────────
async function fetchState() {
  try {
    const res = await get("/state");
    updateStatePanel({
      state: res.state,
      missing_slots: res.missing_slots,
      conflicts: [],
      derived: [],
      template_matches: [],
    });
    if (res.has_token) {
      document.getElementById("tokenStatus").textContent = "✓ connected";
      document.getElementById("tokenStatus").className = "token-status ok";
    }
  } catch (_) {
    // backend not yet running — ignore
  }
}

// ── Reset ─────────────────────────────────────────────────────────────
async function resetSession() {
  if (!confirm("Reset configuration and conversation history?")) return;
  try {
    const res = await post("/reset");
    updateStatePanel({
      state: res.state,
      missing_slots: Object.keys(res.state).filter(k =>
        ["cell_type","num_groups","cells_per_group","cooling_type","coolant_channels","coolant_size"].includes(k) &&
        (res.state[k] === null || (Array.isArray(res.state[k]) && res.state[k].length === 0))
      ),
      conflicts: [],
      derived: [],
      template_matches: [],
    });
    document.getElementById("chatMessages").innerHTML = `
      <div class="msg msg-system">
        <div class="msg-bubble">Session reset. Describe a new battery configuration.</div>
      </div>`;
    hideBanner("conflictBanner");
    hideBanner("derivedBanner");
  } catch (e) {
    appendMsg("system", `❌ Reset failed: ${e.message}`);
  }
}

// ── Manual slot update (from UI controls) ────────────────────────────
async function manualUpdateSlot(slot, value) {
  // Parse coolant_size as array of ints
  let payload = value;
  if (slot === "coolant_size") {
    payload = value.split(",").map(v => v.trim()).filter(v => v !== "");
  }

  try {
    const res = await post("/update-slot", { slot, value: payload });
    updateStatePanel({
      state: res.state,
      missing_slots: res.missing_slots,
      conflicts: res.conflicts,
      derived: res.derived,
      template_matches: [],
    });
    if (res.derived && res.derived.length > 0) {
      appendMsg("ai", "**Auto-derived**: " + res.derived.join("; "));
    }
  } catch (e) {
    appendMsg("system", `❌ Slot update failed: ${e.message}`);
  }
}

// ── Apply template (clicked from card) ───────────────────────────────
async function applyTemplate(name) {
  try {
    const res = await post("/apply-template", { name });
    // keep last template list so user can keep switching
    updateStatePanel({
      state: res.state,
      missing_slots: res.missing_slots,
      conflicts: res.conflicts,
      derived: res.derived,
      template_matches: _lastTemplateMatches,
    });
    // highlight the selected card
    document.querySelectorAll(".template-card").forEach(card => {
      card.classList.toggle("selected", card.dataset.tplName === name);
    });
    appendMsg("ai", `✅ Template applied: **${name}**\n\n` +
      (res.derived.length ? "**Derived**: " + res.derived.join("; ") : "")
    );
  } catch (e) {
    appendMsg("system", `❌ ${e.message}`);
  }
}

// ── Generate header ───────────────────────────────────────────────────
async function generateHeader() {
  try {
    const res = await post("/generate-header");
    if (res.error) {
      appendMsg("system", `❌ ${res.error}`);
      return;
    }
    _lastHeaderContent = res.content;
    document.getElementById("headerContent").textContent = res.content;
    document.getElementById("headerModal").classList.remove("hidden");
  } catch (e) {
    appendMsg("system", `❌ ${e.message}`);
  }
}

function closeHeaderModal() {
  document.getElementById("headerModal").classList.add("hidden");
}

function closeModal(event) {
  if (event.target === document.getElementById("headerModal")) {
    closeHeaderModal();
  }
}

function copyHeader() {
  navigator.clipboard.writeText(_lastHeaderContent).then(() => {
    const btn = document.querySelector(".modal-actions button");
    const orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(() => { btn.textContent = orig; }, 1500);
  });
}

function downloadHeader() {
  const blob = new Blob([_lastHeaderContent], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "constants.h";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ══════════════════════════════════════════════════════════════════════
//  STATE PANEL RENDERING
// ══════════════════════════════════════════════════════════════════════

function _subtypeLabel(subtype) {
  for (const opts of Object.values(CELL_SUBTYPES)) {
    const found = opts.find(o => o.value === subtype);
    if (found) return found.label;
  }
  return subtype;
}

function updateStatePanel(data) {
  const { state, missing_slots, conflicts, derived, template_matches } = data;

  // Keep canvas colour coding and target count in sync
  if (state.cells_per_group) _schemeCpg = state.cells_per_group;
  if (state.num_groups && state.cells_per_group) {
    _schemeTarget    = state.num_groups * state.cells_per_group;
    _schemeNumGroups = state.num_groups;
  }

  // ── Parameters ──────────────────────────────────────────────────
  renderParam("cell_type",
    state.cell_type ? CELL_TYPE_LABELS[state.cell_type] || state.cell_type : null,
    true);
  renderParam("cell_subtype",
    state.cell_subtype ? _subtypeLabel(state.cell_subtype) : null,
    false);

  renderParam("total_cells",     state.total_cells,    false);
  renderParam("num_groups",      state.num_groups,     true);
  renderParam("cells_per_group", state.cells_per_group,true);
  renderParam("cooling_type",
    state.cooling_type !== null ? `${state.cooling_type} — ${COOLING_LABELS[state.cooling_type]}` : null,
    true);
  renderParam("coolant_channels", state.coolant_channels, true);

  // coolant_size is an array
  const sizeVal = state.coolant_size && state.coolant_size.length > 0
    ? "[" + state.coolant_size.join(", ") + "]"
    : null;
  renderParam("coolant_size", sizeVal, true);

  // Layout
  const lf = state.layout_features || {};
  let layoutText = lf.pattern || "standard";
  if (lf.pattern === "corner_cut") layoutText += ` (corner=${lf.corner_size || 1})`;
  if (lf.pattern === "with_gaps")  layoutText += ` ${state.num_groups || "?"}×${state.cells_per_group || "?"}`;
  if (lf.details) layoutText += ` / ${lf.details}`;
  setParamValue("val-layout", layoutText);
  // also sync the corner_size display value
  const csizeVal = document.getElementById("val-corner_size");
  if (csizeVal) csizeVal.textContent = lf.corner_size || 1;

  // Constraints
  const c = state.constraints || {};
  const parts = [];
  if (c.max_temp !== undefined) parts.push(`T < ${c.max_temp}°C`);
  if (c.current  !== undefined) parts.push(`I = ${c.current} A`);
  if (c.power    !== undefined) parts.push(`P = ${c.power} W`);
  setParamValue("val-constraints", parts.length ? parts.join(", ") : null);

  // Sync input controls with current state values
  syncInputs(state);

  // ── Conflicts ────────────────────────────────────────────────────
  const conflictEl = document.getElementById("conflictBanner");
  if (conflicts && conflicts.length > 0) {
    conflictEl.innerHTML = conflicts.map(c => `⚠️ ${c}`).join("<br/>");
    conflictEl.classList.remove("hidden");
  } else {
    conflictEl.classList.add("hidden");
  }

  // ── Derived ──────────────────────────────────────────────────────
  const derivedEl = document.getElementById("derivedBanner");
  if (derived && derived.length > 0) {
    derivedEl.innerHTML = derived.map(d => `ℹ️ ${d}`).join("<br/>");
    derivedEl.classList.remove("hidden");
  } else {
    derivedEl.classList.add("hidden");
  }

  // ── Completion badge + generate button ───────────────────────────
  const badge = document.getElementById("completionBadge");
  const genBtn = document.getElementById("generateBtn");
  const genHint = document.getElementById("generateHint");
  const complete = !missing_slots || missing_slots.length === 0;

  if (complete) {
    badge.textContent = "Ready";
    badge.className = "badge badge-ok";
    genBtn.disabled = false;
    genHint.textContent = "All required parameters set";
  } else {
    const n = missing_slots.length;
    badge.textContent = `${n} missing`;
    badge.className = "badge badge-missing";
    genBtn.disabled = true;
    genHint.textContent = `Fill required fields: ${missing_slots.join(", ")}`;
  }

  // ── Template suggestions ─────────────────────────────────────────
  const tplSection = document.getElementById("templateSection");
  const tplCards   = document.getElementById("templateCards");

  if (template_matches && template_matches.length > 0) {
    _lastTemplateMatches = template_matches;   // cache latest list
    tplCards.innerHTML = template_matches.map(t => `
      <div class="template-card" data-tpl-name="${escHtml(t.name)}">
        <div class="template-card-name">${escHtml(t.name)}</div>
        <div class="template-card-desc">${escHtml(t.description || "")}</div>
      </div>
    `).join("");
    tplCards.querySelectorAll(".template-card").forEach(card => {
      card.addEventListener("click", () => applyTemplate(card.dataset.tplName));
    });
    tplSection.classList.remove("hidden");
  }
  // when template_matches is empty, keep previous list visible
}

function renderParam(slot, value, required) {
  const iconEl = document.getElementById(`icon-${slot}`);
  const valEl  = document.getElementById(`val-${slot}`);
  const rowEl  = document.getElementById(`row-${slot}`);

  if (!iconEl || !valEl) return;

  if (value !== null && value !== undefined) {
    valEl.textContent = value;
    valEl.classList.remove("placeholder");
    iconEl.textContent = "✓";
    iconEl.className = "param-icon ok";
    rowEl.classList.remove("is-missing");
    rowEl.classList.add("is-ok");
  } else {
    valEl.textContent = required ? "needed" : "—";
    valEl.classList.toggle("placeholder", true);
    iconEl.textContent = required ? "●" : "◎";
    iconEl.className = required ? "param-icon missing" : "param-icon opt";
    rowEl.classList.remove("is-ok");
    if (required) rowEl.classList.add("is-missing");
  }
}

function setParamValue(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  if (value) {
    el.textContent = value;
    el.classList.remove("placeholder");
  } else {
    el.textContent = "—";
    el.classList.add("placeholder");
  }
}

function syncInputs(state) {
  // Cell type / subtype
  const ctEl = document.getElementById("input-cell_type");
  if (ctEl) {
    ctEl.value = state.cell_type || "";
    // rebuild subtype options if needed
    const subtypeRow = document.getElementById("row-cell_subtype");
    const subtypeSel = document.getElementById("input-cell_subtype");
    if (state.cell_type && CELL_SUBTYPES[state.cell_type]) {
      // only rebuild if options don't match
      const currentOpts = Array.from(subtypeSel.options).map(o => o.value);
      const expected    = CELL_SUBTYPES[state.cell_type].map(o => o.value);
      if (JSON.stringify(currentOpts.slice(1)) !== JSON.stringify(expected)) {
        subtypeSel.innerHTML = '<option value="">Select format…</option>';
        CELL_SUBTYPES[state.cell_type].forEach(opt => {
          const el = document.createElement("option");
          el.value = opt.value; el.textContent = opt.label;
          subtypeSel.appendChild(el);
        });
      }
      subtypeRow.style.display = "";
      subtypeSel.value = state.cell_subtype || "";
    } else {
      subtypeRow.style.display = "none";
    }
  }

  // keep input controls in sync with actual state values
  const numFields = ["total_cells","num_groups","cells_per_group","coolant_channels"];
  for (const f of numFields) {
    const el = document.getElementById(`input-${f}`);
    if (el) el.value = state[f] !== null ? state[f] : "";
  }
  const ct = document.getElementById("input-cooling_type");
  if (ct) ct.value = state.cooling_type !== null ? state.cooling_type : "";
  const cs = document.getElementById("input-coolant_size");
  if (cs) cs.value = state.coolant_size && state.coolant_size.length > 0
    ? state.coolant_size.join(", ") : "";

  // Layout pattern selector
  const lf = state.layout_features || {};
  const pattern = lf.pattern || "standard";
  const patternSel = document.getElementById("input-layout_pattern");
  if (patternSel) {
    // with_gaps presets: map state back to select option values
    if (pattern === "with_gaps") {
      const g = state.num_groups, c = state.cells_per_group;
      patternSel.value = (g === 6 && c === 74) ? "with_gaps_6x74"
                       : (g === 6 && c === 86) ? "with_gaps_6x86"
                       : "standard";
    } else {
      patternSel.value = pattern;
    }
    _syncCornerSizeRow(pattern);
  }
  const csizeEl = document.getElementById("input-corner_size");
  if (csizeEl && lf.corner_size != null) csizeEl.value = lf.corner_size;
}

// ── Cell type / subtype controls ─────────────────────────────────────

async function onCellTypeChange() {
  const typeVal  = document.getElementById("input-cell_type").value;
  const subtypeRow = document.getElementById("row-cell_subtype");
  const subtypeSel = document.getElementById("input-cell_subtype");

  // Rebuild subtype options
  subtypeSel.innerHTML = '<option value="">Select format…</option>';
  if (typeVal && CELL_SUBTYPES[typeVal]) {
    CELL_SUBTYPES[typeVal].forEach(opt => {
      const el = document.createElement("option");
      el.value = opt.value;
      el.textContent = opt.label;
      subtypeSel.appendChild(el);
    });
    subtypeRow.style.display = "";
  } else {
    subtypeRow.style.display = "none";
  }

  // Clear subtype in state when type changes
  await post("/update-slot", { slot: "cell_subtype", value: "" });
  // Save the new type
  if (typeVal) {
    const res = await post("/update-slot", { slot: "cell_type", value: typeVal });
    updateStatePanel({
      state: res.state, missing_slots: res.missing_slots,
      conflicts: res.conflicts, derived: res.derived, template_matches: [],
    });
  }
}

// ── Layout pattern controls ───────────────────────────────────────────

function _syncCornerSizeRow(pattern) {
  const row = document.getElementById("row-corner_size");
  if (row) row.style.display = (pattern === "corner_cut") ? "" : "none";
}

async function onLayoutPatternChange() {
  const sel = document.getElementById("input-layout_pattern");
  const raw = sel.value;
  _syncCornerSizeRow(raw === "corner_cut" ? "corner_cut" : "other");

  // Map option value → API pattern + preset handling
  let pattern = raw;
  if (raw === "with_gaps_6x74") pattern = "with_gaps";
  if (raw === "with_gaps_6x86") pattern = "with_gaps";

  const cornerSize = parseInt(document.getElementById("input-corner_size")?.value || "1");

  // For with_gaps presets we also need to set num_groups / cells_per_group
  if (raw === "with_gaps_6x74") {
    await post("/update-slot", { slot: "total_cells",     value: 444 });
    await post("/update-slot", { slot: "num_groups",      value: 6   });
    await post("/update-slot", { slot: "cells_per_group", value: 74  });
  } else if (raw === "with_gaps_6x86") {
    await post("/update-slot", { slot: "total_cells",     value: 516 });
    await post("/update-slot", { slot: "num_groups",      value: 6   });
    await post("/update-slot", { slot: "cells_per_group", value: 86  });
  }

  const data = await post("/update-layout", { pattern, corner_size: cornerSize });
  if (data && data.error) {
    appendMsg("system", `❌ Layout update failed: ${data.error}`);
  } else if (data) {
    updateStatePanel(data);
  }
}

async function onCornerSizeChange(val) {
  const cornerSize = Math.max(1, parseInt(val) || 1);
  const data = await post("/update-layout", { pattern: "corner_cut", corner_size: cornerSize });
  if (data && !data.error) updateStatePanel(data);
}

// ══════════════════════════════════════════════════════════════════════
//  CHAT HELPERS
// ══════════════════════════════════════════════════════════════════════

function appendMsg(type, htmlContent) {
  const container = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = `msg msg-${type}`;
  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";

  if (type === "ai") {
    bubble.innerHTML = renderMarkdown(htmlContent);
  } else if (type === "system") {
    bubble.innerHTML = htmlContent;
  } else {
    // user — plain text
    bubble.textContent = htmlContent;
  }

  div.appendChild(bubble);
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

function appendThinking() {
  const container = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = "msg msg-ai msg-thinking";
  div.innerHTML = `<div class="msg-bubble">
    <span class="thinking-dot">●</span>
    <span class="thinking-dot" style="animation-delay:.2s">●</span>
    <span class="thinking-dot" style="animation-delay:.4s">●</span>
  </div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Animate dots
  const style = document.createElement("style");
  style.textContent = `
    .thinking-dot {
      display: inline-block;
      animation: pulse 1s ease-in-out infinite;
      margin: 0 2px;
      color: #4f8ef7;
    }
    @keyframes pulse {
      0%,100% { opacity: .2; }
      50%      { opacity: 1; }
    }`;
  document.head.appendChild(style);

  return div;
}

function setLoading(on) {
  document.getElementById("sendBtn").disabled = on;
  document.getElementById("chatInput").disabled = on;
}

// Very lightweight markdown renderer (bold, inline code, line breaks)
function renderMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // **bold**
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    // `code`
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // *italic*
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    // double newline → paragraph break
    .replace(/\n\n/g, "<br/><br/>")
    // single newline → <br>
    .replace(/\n/g, "<br/>");
}

function escHtml(s) {
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function hideBanner(id) {
  document.getElementById(id).classList.add("hidden");
}

// ══════════════════════════════════════════════════════════════════════
//  SCHEME / LAYOUT EDITOR
// ══════════════════════════════════════════════════════════════════════

const GROUP_PALETTE = [
  "#4f86f7","#ff6b6b","#51cf66","#ffd43b","#cc5de8",
  "#ff922b","#20c997","#f06595","#74c0fc","#a9e34b",
  "#e67700","#087f5b","#862e9c","#c92a2a","#1864ab",
];

let _scheme         = null;   // 2D int array
let _schemeRows     = 0;
let _schemeCols     = 0;
let _schemeCpg      = 1;      // cells_per_group for colour coding
let _schemeOpen     = false;
let _hoverCell      = null;
let _cellSize       = 16;
let _schemeZoomStep = 16;     // current cell size in px (zoom proxy)
let _schemeTarget   = 0;      // num_groups × cells_per_group
let _schemeNumGroups = 0;

// ── Zoom ─────────────────────────────────────────────────────────────

function schemeZoom(dir) {
  if (dir === 0) {
    // Fit: choose largest cell size that fits the canvas wrap
    const wrap = document.getElementById("schemeCanvasWrap");
    if (!wrap || !_schemeRows || !_schemeCols) return;
    const maxW = wrap.clientWidth  - 4;
    const maxH = wrap.clientHeight || 420;
    const cw = Math.floor(maxW / _schemeCols);
    const ch = Math.floor(maxH / _schemeRows);
    _schemeZoomStep = Math.max(5, Math.min(48, Math.min(cw, ch)));
  } else {
    const steps = [5, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48];
    const idx = steps.indexOf(_schemeZoomStep);
    if (dir > 0) _schemeZoomStep = steps[Math.min(steps.length - 1, idx + 1)];
    else         _schemeZoomStep = steps[Math.max(0, idx < 0 ? 4 : idx - 1)];
  }
  renderSchemeCanvas();
}

// ── Toggle visibility ────────────────────────────────────────────────

function toggleSchemeEditor() {
  _schemeOpen = !_schemeOpen;
  const panel = document.getElementById("schemeEditorPanel");
  const btn   = document.getElementById("toggleSchemeEditorBtn");
  if (_schemeOpen) {
    panel.classList.remove("hidden");
    btn.textContent = "▲ Close Editor";
    loadScheme();
  } else {
    panel.classList.add("hidden");
    btn.textContent = "▼ Edit Layout";
  }
}

// ── Load scheme from backend ─────────────────────────────────────────

async function loadScheme() {
  const res = await get("/scheme");
  if (!res.scheme) {
    document.getElementById("schemeValidationBar").textContent =
      "⚠ Set num_groups and cells_per_group first.";
    document.getElementById("schemeCellCount").textContent = "—";
    return;
  }
  _applySchemeResult(res.scheme);
}

function _applySchemeResult(s) {
  _scheme     = s.data;
  _schemeRows = s.rows;
  _schemeCols = s.cols;
  schemeZoom(0);   // auto-fit on first load / template change
  _validateSchemeUI();
  _buildLegend();
}

// ── Apply a named initial template ───────────────────────────────────

async function applySchemeTemplate() {
  const template = document.getElementById("schemeTemplateSelect").value;
  if (!template) return;

  const params = {
    corner_size: parseInt(document.getElementById("sp-corner_size").value) || 1,
    cut_rows:    parseInt(document.getElementById("sp-cut_rows").value)    || 2,
    cut_cols:    parseInt(document.getElementById("sp-cut_cols").value)    || 2,
    inner_rows:  parseInt(document.getElementById("sp-inner_rows").value)  || 2,
    inner_cols:  parseInt(document.getElementById("sp-inner_cols").value)  || 4,
    top_left:  _parsePair(document.getElementById("sp-top_left").value,  [1,1]),
    top_right: _parsePair(document.getElementById("sp-top_right").value, [1,1]),
    bot_left:  _parsePair(document.getElementById("sp-bot_left").value,  [1,1]),
    bot_right: _parsePair(document.getElementById("sp-bot_right").value, [1,1]),
  };

  const res = await post("/generate-scheme", { template, params });
  if (res.error) {
    document.getElementById("schemeValidationBar").textContent = `❌ ${res.error}`;
    return;
  }
  _applySchemeResult(res.scheme);
}

function _parsePair(str, fallback) {
  const parts = str.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  return parts.length === 2 ? parts : fallback;
}

// ── Canvas rendering ─────────────────────────────────────────────────

function renderSchemeCanvas() {
  if (!_scheme || !_scheme.length) return;

  const wrap   = document.getElementById("schemeCanvasWrap");
  const canvas = document.getElementById("schemeCanvas");
  if (!wrap || !canvas) return;

  _cellSize = _schemeZoomStep;

  // Update zoom label
  const lbl = document.getElementById("schemeZoomLabel");
  if (lbl) lbl.textContent = `${_cellSize}px`;

  canvas.width  = _cellSize * _schemeCols;
  canvas.height = _cellSize * _schemeRows;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const showNum = _cellSize >= 15;
  const cpg = _schemeCpg || 1;

  for (let r = 0; r < _schemeRows; r++) {
    for (let c = 0; c < _schemeCols; c++) {
      const v   = _scheme[r][c];
      const x   = c * _cellSize;
      const y   = r * _cellSize;
      const grp = v > 0 ? Math.floor((v - 1) / cpg) % GROUP_PALETTE.length : -1;
      const isHover = _hoverCell && _hoverCell[0] === r && _hoverCell[1] === c;

      // Cell fill
      if (v === 0) {
        ctx.fillStyle = isHover ? "#c8c8c8" : "#e4e4e4";
      } else {
        const base = GROUP_PALETTE[grp];
        ctx.fillStyle = isHover ? base + "ff" : base + "cc";
      }
      ctx.fillRect(x, y, _cellSize - 1, _cellSize - 1);

      // Number label
      if (showNum && v > 0) {
        ctx.fillStyle = "#222";
        ctx.font = `${Math.max(7, _cellSize - 7)}px monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(v), x + _cellSize / 2, y + _cellSize / 2);
      }
    }
  }
}

// ── Canvas interaction ───────────────────────────────────────────────

function _canvasCoords(e) {
  const canvas = document.getElementById("schemeCanvas");
  const rect   = canvas.getBoundingClientRect();
  return [
    Math.floor((e.clientY - rect.top)  / _cellSize),
    Math.floor((e.clientX - rect.left) / _cellSize),
  ];
}

function _onSchemeClick(e) {
  if (!_scheme) return;
  const [r, c] = _canvasCoords(e);
  if (r < 0 || r >= _schemeRows || c < 0 || c >= _schemeCols) return;

  // Toggle: 0 → placeholder (-1), non-zero → 0
  _scheme[r][c] = _scheme[r][c] === 0 ? -1 : 0;
  _renumberInPlace("row");
  renderSchemeCanvas();
  _validateSchemeUI();
  _saveSchemeDebounced();
}

function _onSchemeMouseMove(e) {
  if (!_scheme) return;
  const [r, c] = _canvasCoords(e);
  if (r < 0 || r >= _schemeRows || c < 0 || c >= _schemeCols) {
    _hoverCell = null;
  } else {
    _hoverCell = [r, c];
    const v   = _scheme[r][c];
    const cpg = _schemeCpg || 1;
    const grp = v > 0 ? Math.floor((v - 1) / cpg) + 1 : null;
    document.getElementById("schemeHoverInfo").textContent =
      v === 0
        ? `(row ${r}, col ${c}) — empty`
        : `(row ${r}, col ${c}) — cell #${v}${grp ? `, group ${grp}` : ""}`;
  }
  renderSchemeCanvas();
}

// ── Renumber ─────────────────────────────────────────────────────────

function _renumberInPlace(order) {
  let id = 1;
  if (order === "row") {
    for (let r = 0; r < _schemeRows; r++)
      for (let c = 0; c < _schemeCols; c++)
        if (_scheme[r][c] !== 0) _scheme[r][c] = id++;
  } else {
    for (let c = 0; c < _schemeCols; c++)
      for (let r = 0; r < _schemeRows; r++)
        if (_scheme[r][c] !== 0) _scheme[r][c] = id++;
  }
}

function renumberScheme(order = "row") {
  if (!_scheme) return;
  _renumberInPlace(order);
  renderSchemeCanvas();
  _validateSchemeUI();
  _saveSchemeDebounced();
}

// ── Fill empty slots to reach target count ───────────────────────────

function fillSchemeToTarget() {
  if (!_scheme || !_schemeTarget) return;
  const active  = _scheme.flat().filter(v => v !== 0).length;
  const missing = _schemeTarget - active;
  if (missing <= 0) { _validateSchemeUI(); return; }

  let filled = 0;
  for (let r = 0; r < _schemeRows && filled < missing; r++)
    for (let c = 0; c < _schemeCols && filled < missing; c++)
      if (_scheme[r][c] === 0) { _scheme[r][c] = -1; filled++; }

  _renumberInPlace("row");
  renderSchemeCanvas();
  _validateSchemeUI();
  _buildLegend();
  _saveSchemeDebounced();
}

// ── Sync parameters to match actual canvas cell count ────────────────

async function syncParamsToCanvas() {
  if (!_scheme) return;
  const active = _scheme.flat().filter(v => v !== 0).length;
  if (active === 0) return;

  // Update total_cells unconditionally
  await post("/update-slot", { slot: "total_cells", value: active });

  // If active is divisible by current num_groups, update cells_per_group
  if (_schemeNumGroups && active % _schemeNumGroups === 0) {
    const res = await post("/update-slot",
      { slot: "cells_per_group", value: active / _schemeNumGroups });
    updateStatePanel({
      state: res.state, missing_slots: res.missing_slots,
      conflicts: res.conflicts, derived: res.derived, template_matches: [],
    });
  } else {
    // Otherwise ask user to adjust num_groups manually — just refresh state
    const res = await post("/update-slot", { slot: "total_cells", value: active });
    updateStatePanel({
      state: res.state, missing_slots: res.missing_slots,
      conflicts: res.conflicts, derived: res.derived, template_matches: [],
    });
    appendMsg("ai",
      `**Canvas has ${active} active cells.** \`total_cells\` updated to ${active}.\n\n` +
      `${active} ÷ ${_schemeNumGroups || "?"} is not a whole number — ` +
      `please adjust \`Num Groups\` or \`Cells/Group\` in the panel above.`);
  }
  _validateSchemeUI();
}

// ── Validate + show status ────────────────────────────────────────────

async function _validateSchemeUI() {
  if (!_scheme) return;
  const res     = await post("/validate-scheme", { scheme: _scheme });
  const bar     = document.getElementById("schemeValidationBar");
  const countEl = document.getElementById("schemeCellCount");

  countEl.textContent = `Active cells: ${res.active_cells}`;

  if (res.valid) {
    bar.innerHTML = "✅ Valid — all cell IDs correct";
    bar.className = "scheme-validation-bar valid";
  } else {
    const active  = res.active_cells;
    const target  = _schemeTarget;
    const diff    = target - active;

    let html = "⚠ " + res.errors.join("  |  ");

    // Offer quick-fix buttons when only the count is wrong
    const onlyCountWrong = res.errors.length === 1 &&
      res.errors[0].startsWith("Active cells");
    if (onlyCountWrong && diff > 0) {
      html += `&nbsp;&nbsp;<button class="scheme-fix-btn" onclick="fillSchemeToTarget()">
                 ＋ Fill ${diff} empty cell${diff > 1 ? "s" : ""}</button>`;
    }
    if (onlyCountWrong) {
      html += `&nbsp;<button class="scheme-fix-btn" onclick="syncParamsToCanvas()">
                 ↕ Sync params to ${active}</button>`;
    }

    bar.innerHTML = html;
    bar.className = "scheme-validation-bar error";
  }
}

// ── Legend ────────────────────────────────────────────────────────────

function _buildLegend() {
  const cpg = _schemeCpg || 1;
  const maxId = _scheme ? Math.max(0, ...(_scheme.flat())) : 0;
  const numGroups = maxId > 0 ? Math.ceil(maxId / cpg) : 0;
  const el = document.getElementById("schemeLegend");
  if (!el) return;
  el.innerHTML = "";
  for (let g = 0; g < Math.min(numGroups, GROUP_PALETTE.length); g++) {
    const first = g * cpg + 1;
    const last  = Math.min((g + 1) * cpg, maxId);
    el.innerHTML += `
      <div class="legend-row">
        <span class="legend-swatch" style="background:${GROUP_PALETTE[g % GROUP_PALETTE.length]}"></span>
        <span>Group ${g + 1} (${first}–${last})</span>
      </div>`;
  }
}

// ── Reset to auto-generated ───────────────────────────────────────────

async function resetToAutoScheme() {
  if (!confirm("Discard all edits and regenerate layout from parameters?")) return;
  const res = await post("/reset-scheme");
  if (res.scheme) _applySchemeResult(res.scheme);
}

// ── Debounced save ────────────────────────────────────────────────────

let _saveSchemeTid = null;
function _saveSchemeDebounced() {
  clearTimeout(_saveSchemeTid);
  _saveSchemeTid = setTimeout(async () => {
    if (_scheme) await post("/update-scheme", { scheme: _scheme });
  }, 600);
}

// ── Wire canvas events ────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const canvas = document.getElementById("schemeCanvas");
  if (!canvas) return;
  canvas.addEventListener("click",     _onSchemeClick);
  canvas.addEventListener("mousemove", _onSchemeMouseMove);
  canvas.addEventListener("mouseleave", () => {
    _hoverCell = null;
    renderSchemeCanvas();
    const el = document.getElementById("schemeHoverInfo");
    if (el) el.textContent = "";
  });
});

// ── HTTP helpers ──────────────────────────────────────────────────────
async function post(path, body = {}) {
  let r;
  try {
    r = await fetch(API + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { error: `Network error: cannot reach backend (${e.message})` };
  }
  let data;
  try {
    data = await r.json();
  } catch (e) {
    return { error: `Server returned a non-JSON response (HTTP ${r.status}) — make sure start.sh is running` };
  }
  // normalise HTTP errors into {error:...} instead of throwing
  if (!r.ok && !data.error) data.error = `HTTP ${r.status}`;
  return data;
}

async function get(path) {
  const r = await fetch(API + path);
  const data = await r.json();
  if (!r.ok && data.error) throw new Error(data.error);
  return data;
}
