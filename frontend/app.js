/* ══════════════════════════════════════════════════════════════════
   Energy LLM — Battery Configurator Frontend
   ══════════════════════════════════════════════════════════════════ */

const API = "http://127.0.0.1:5000/api";

const COOLING_LABELS = {
  0: "S-type",
  1: "C-type",
  2: "SS-type (Double S)",
  3: "E-type",
};

let _lastHeaderContent = "";

// ── Boot ─────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  fetchState();            // load initial state (if backend already running)
});

// ── Token ─────────────────────────────────────────────────────────────
async function setToken() {
  const token = document.getElementById("tokenInput").value.trim();
  const model = document.getElementById("modelSelect").value;
  const statusEl = document.getElementById("tokenStatus");

  if (!token) {
    statusEl.textContent = "⚠ empty";
    statusEl.className = "token-status fail";
    return;
  }

  try {
    const res = await post("/set-token", { token, model });
    if (res.success) {
      statusEl.textContent = `✓ ${res.model}`;
      statusEl.className = "token-status ok";
      document.getElementById("tokenBtn").textContent = "Reconnect";
    }
  } catch (e) {
    statusEl.textContent = "✗ error";
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
      appendMsg("ai", renderMarkdown(res.chat_reply));
      updateStatePanel(res);
    }
  } catch (e) {
    thinkingEl.remove();
    appendMsg("system", `❌ Network error — is the backend running? (${e.message})`);
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
    updateStatePanel({
      state: res.state,
      missing_slots: res.missing_slots,
      conflicts: res.conflicts,
      derived: res.derived,
      template_matches: [],
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
  renderParam("total_cells",    state.total_cells,    false, missing_slots);
  renderParam("num_groups",     state.num_groups,     true,  missing_slots);
  renderParam("cells_per_group",state.cells_per_group,true,  missing_slots);
  renderParam("cooling_type",
    state.cooling_type !== null ? `${state.cooling_type} — ${COOLING_LABELS[state.cooling_type]}` : null,
    true, missing_slots, "cooling_type");
  renderParam("coolant_channels", state.coolant_channels, true, missing_slots);

  // coolant_size is an array
  const sizeVal = state.coolant_size && state.coolant_size.length > 0
    ? "[" + state.coolant_size.join(", ") + "]"
    : null;
  renderParam("coolant_size", sizeVal, true, missing_slots);

  // Layout
  const lf = state.layout_features || {};
  const layoutText = lf.details
    ? `${lf.pattern} / ${lf.details}`
    : (lf.pattern || "standard");
  setParamValue("val-layout", layoutText, false);

  // Constraints
  const c = state.constraints || {};
  const parts = [];
  if (c.max_temp !== undefined) parts.push(`T < ${c.max_temp}°C`);
  if (c.current  !== undefined) parts.push(`I = ${c.current} A`);
  if (c.power    !== undefined) parts.push(`P = ${c.power} W`);
  setParamValue("val-constraints", parts.length ? parts.join(", ") : null, false);

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
    tplCards.innerHTML = template_matches.map(t => `
      <div class="template-card" onclick="applyTemplate(${JSON.stringify(t.name)})">
        <div class="template-card-name">${escHtml(t.name)}</div>
        <div class="template-card-desc">${escHtml(t.description || "")}</div>
      </div>
    `).join("");
    tplSection.classList.remove("hidden");
  } else {
    tplSection.classList.add("hidden");
  }
}

function renderParam(slot, value, required, missing_slots, rawSlot) {
  const iconEl = document.getElementById(`icon-${slot}`);
  const valEl  = document.getElementById(`val-${slot}`);
  const rowEl  = document.getElementById(`row-${slot}`);

  if (!iconEl || !valEl) return;

  const isMissing = required && (!value && value !== 0);

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

function setParamValue(id, value, required) {
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
  // Only update input fields that are currently empty (don't override user typing)
  const numFields = ["total_cells","num_groups","cells_per_group","coolant_channels"];
  for (const f of numFields) {
    const el = document.getElementById(`input-${f}`);
    if (el && state[f] !== null && el.value === "") {
      el.value = state[f];
    }
  }
  const ct = document.getElementById("input-cooling_type");
  if (ct && state.cooling_type !== null && ct.value === "") {
    ct.value = state.cooling_type;
  }
  const cs = document.getElementById("input-coolant_size");
  if (cs && state.coolant_size && state.coolant_size.length > 0 && cs.value === "") {
    cs.value = state.coolant_size.join(", ");
  }
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
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok && data.error) throw new Error(data.error);
  return data;
}

async function get(path) {
  const r = await fetch(API + path);
  const data = await r.json();
  if (!r.ok && data.error) throw new Error(data.error);
  return data;
}
