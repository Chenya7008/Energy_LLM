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
        ["num_groups","cells_per_group","cooling_type","coolant_channels","coolant_size"].includes(k) &&
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

function updateStatePanel(data) {
  const { state, missing_slots, conflicts, derived, template_matches } = data;

  // ── Parameters ──────────────────────────────────────────────────
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
