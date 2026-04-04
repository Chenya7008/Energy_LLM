"""
Flask backend for the Energy LLM Battery Configurator.

Endpoints:
  POST /api/set-token        — save Claude API key for this session
  GET  /api/state            — current battery state + token status
  POST /api/chat             — send user message → LLM → BatteryManager
  POST /api/update-slot      — user fills a slot directly via UI
  POST /api/apply-template   — user picks a template card
  GET  /api/templates        — list all available templates
  POST /api/generate-header  — produce constants.h text
  POST /api/reset            — clear state and conversation history
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import anthropic
import json
import re
import traceback

from battery_manager import BatteryManager

app = Flask(__name__)
CORS(app)

# ── Session globals (single-user local tool) ──────────────────────────
_api_token: str = ""
_model: str = "claude-sonnet-4-6"
_battery: BatteryManager = BatteryManager()
_history: list = []          # Claude conversation history

# ── System prompt (from EMIOT.pdf) ───────────────────────────────────
SYSTEM_PROMPT = """# ROLE
You are a highly precise Data Extraction Assistant for a Battery Thermal Simulation System. Your ONLY job is to convert natural language descriptions of battery pack configurations into a strictly formatted JSON object. You are a strict parser: do not calculate, do not infer, and do not guess.

# CRITICAL RULES (Strictly Enforced)
1. NO MATH & NO CALCULATION: Extract ONLY explicitly stated numbers. If the user says "100 cells divided into 10 groups", output `"total_cells": 100` and `"num_groups": 10`. You MUST NOT calculate or fill in `"cells_per_group"`. Leave unstated parameters as `null`.
2. NO GUESSING: If the user mentions "water cooling" but does not explicitly state the shape, set `"cooling_type": null` and log the raw mention in `"assumptions_made"`.
3. STRICT MAPPING for cooling_type:
   - "S" shape or S-type  → 0
   - "C" shape or C-type  → 1
   - "SS" / Double S      → 2
   - "E" shape or E-type  → 3
4. CATEGORY PURITY:
   - `layout_features.details`: ONLY physical geometric descriptions ("8x8 grid", "L-shaped", "circular array"). Nothing else.
   - `llm_reasoning.assumptions_made`: ALL non-geometric info goes here — performance goals ("45°C max"), fluids ("water-glycol"), verbal nuances.
5. LAYOUT PATTERN:
   - `"fully_filled"` ONLY if user explicitly says the space must be completely occupied.
   - Default: `"standard"`.
   - THE CONTRADICTION RULE: If user says "10 cells, fully fill 4×4 grid", output both values as-is. Python will detect the conflict.

# INTENT HANDLING
- `"custom"`: New configuration from scratch. List ALL empty simulation_parameters keys in `missing_info`.
- `"template"`: User references a named model (e.g., "Tesla Model S"). Put the name in `search_keyword`. `missing_info` stays `[]`.
- `"update"`: User modifies a previous parameter. `missing_info` stays `[]`.

# OUTPUT FORMAT
Output ONLY a valid JSON object. No markdown fences, no explanation, no extra text.

{
  "intent": {
    "type": "<'custom' | 'template' | 'update'>",
    "search_keyword": "<string or 'none'>"
  },
  "simulation_parameters": {
    "total_cells": <integer or null>,
    "num_groups": <integer or null>,
    "cells_per_group": <integer or null>,
    "cooling_type": <0|1|2|3 or null>,
    "coolant_channels": <integer or null>,
    "coolant_size": [<integers>]
  },
  "layout_features": {
    "pattern": "<'standard' | 'with_gaps' | 'fully_filled'>",
    "details": "<string or null>"
  },
  "llm_reasoning": {
    "missing_info": ["<array of missing parameter names>"],
    "assumptions_made": "<string or null>"
  }
}"""


# ── Helpers ───────────────────────────────────────────────────────────

def _extract_json(text: str) -> dict:
    """Parse JSON from LLM output, tolerating markdown code fences."""
    text = text.strip()
    # Strip ```json ... ``` fences if present
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return json.loads(text)


def _format_chat_reply(result: dict, llm_json: dict) -> str:
    """Build a human-readable assistant reply from BatteryManager result."""
    parts = []

    intent = llm_json.get("intent", {}).get("type", "custom")
    params = llm_json.get("simulation_parameters", {})

    # What was extracted
    extracted = {
        k: v for k, v in params.items()
        if v is not None and k != "coolant_size"
    }
    if params.get("coolant_size"):
        extracted["coolant_size"] = params["coolant_size"]

    if extracted:
        names = list(extracted.keys())
        parts.append("**Extracted**: " + ", ".join(
            f"`{k}={v}`" for k, v in extracted.items()
        ))
    else:
        if intent == "template":
            kw = llm_json.get("intent", {}).get("search_keyword", "")
            parts.append(f"**Template search**: `{kw}`")
        elif intent == "update":
            parts.append("**Update intent** detected — no new parameters extracted.")
        else:
            parts.append("No explicit parameters found in your input.")

    # Derived values
    for d in result.get("derived", []):
        parts.append(f"**Derived**: {d}")

    # Constraints
    c = result.get("constraints", {})
    if c:
        hints = []
        if "max_temp" in c:
            hints.append(f"max temp {c['max_temp']}°C")
        if "current" in c:
            hints.append(f"discharge {c['current']} A")
        if "power" in c:
            hints.append(f"power {c['power']} W")
        parts.append("**Performance constraint**: " + ", ".join(hints))

    # Conflicts
    for conf in result.get("conflicts", []):
        parts.append(f"⚠️ **Conflict**: {conf}")

    # Still missing
    missing = result.get("missing_slots", [])
    if missing:
        parts.append(
            "**Still needed**: " +
            ", ".join(f"`{m}`" for m in missing) +
            " — fill them in the panel on the right."
        )
    else:
        parts.append("✅ **All required parameters are set.** You can generate the header file.")

    # Template suggestions
    tpls = result.get("template_matches", [])
    if tpls:
        names_list = ", ".join(t["name"] for t in tpls[:4])
        parts.append(
            f"💡 **Template suggestions**: {names_list} — click one on the right to apply."
        )

    return "\n\n".join(parts)


# ── API routes ────────────────────────────────────────────────────────

@app.route("/api/set-token", methods=["POST"])
def set_token():
    global _api_token, _model
    data = request.json or {}
    token = data.get("token", "").strip()
    model = data.get("model", "").strip()
    if not token:
        return jsonify({"error": "Token cannot be empty"}), 400
    _api_token = token
    if model:
        _model = model
    return jsonify({"success": True, "model": _model})


@app.route("/api/state", methods=["GET"])
def get_state():
    return jsonify({
        "state": _battery.state,
        "missing_slots": _battery.get_missing_slots(),
        "has_token": bool(_api_token),
        "model": _model,
    })


@app.route("/api/templates", methods=["GET"])
def get_templates():
    return jsonify({"templates": _battery.get_all_templates()})


@app.route("/api/chat", methods=["POST"])
def chat():
    global _history

    if not _api_token:
        return jsonify({"error": "API token not set. Please enter your token first."}), 401

    data = request.json or {}
    user_message = data.get("message", "").strip()
    if not user_message:
        return jsonify({"error": "Message is empty"}), 400

    try:
        client = anthropic.Anthropic(api_key=_api_token)

        _history.append({"role": "user", "content": user_message})

        response = client.messages.create(
            model=_model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=_history,
        )
        raw = response.content[0].text
        _history.append({"role": "assistant", "content": raw})

        try:
            llm_json = _extract_json(raw)
        except (json.JSONDecodeError, ValueError) as e:
            return jsonify({
                "error": f"LLM returned non-JSON output: {e}",
                "raw": raw,
            }), 500

        result = _battery.process_llm_json(llm_json)
        chat_reply = _format_chat_reply(result, llm_json)

        return jsonify({
            "success": True,
            "chat_reply": chat_reply,
            "llm_json": llm_json,
            "state": _battery.state,
            "missing_slots": result["missing_slots"],
            "conflicts": result["conflicts"],
            "derived": result["derived"],
            "template_matches": result.get("template_matches", []),
            "messages": result.get("messages", []),
        })

    except anthropic.AuthenticationError:
        return jsonify({"error": "Invalid API token. Please check your key."}), 401
    except anthropic.RateLimitError:
        return jsonify({"error": "Rate limit reached. Please wait and try again."}), 429
    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


@app.route("/api/update-slot", methods=["POST"])
def update_slot():
    data = request.json or {}
    slot = data.get("slot")
    value = data.get("value")

    if slot not in ["total_cells", "num_groups", "cells_per_group",
                    "cooling_type", "coolant_channels", "coolant_size"]:
        return jsonify({"error": f"Unknown slot: {slot}"}), 400

    result = _battery.update_slot(slot, value)
    return jsonify({
        "success": True,
        "state": _battery.state,
        "missing_slots": _battery.get_missing_slots(),
        "conflicts": result["conflicts"],
        "derived": result["derived"],
    })


@app.route("/api/apply-template", methods=["POST"])
def apply_template():
    data = request.json or {}
    name = data.get("name", "")
    result = _battery.apply_template_by_name(name)
    if "error" in result:
        return jsonify(result), 404
    return jsonify({
        "success": True,
        "state": _battery.state,
        "missing_slots": result["missing_slots"],
        "conflicts": result["conflicts"],
        "derived": result["derived"],
        "messages": result["messages"],
    })


@app.route("/api/generate-header", methods=["POST"])
def generate_header():
    try:
        content = _battery.generate_header()
        return jsonify({"success": True, "content": content})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/reset", methods=["POST"])
def reset():
    global _history
    _battery.reset()
    _history = []
    return jsonify({"success": True, "state": _battery.state})


if __name__ == "__main__":
    print("=" * 55)
    print("  Energy LLM Battery Configurator — Backend")
    print("  http://127.0.0.1:5000")
    print("  Open frontend/index.html in your browser")
    print("=" * 55)
    app.run(debug=True, port=5000)
