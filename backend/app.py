"""
Flask backend for the Energy LLM Battery Configurator.

支持多平台 LLM：
  - Anthropic (Claude)
  - OpenAI (GPT)
  - DeepSeek (OpenAI-compatible)
  - 任意 OpenAI 兼容接口（自定义 Base URL）

Endpoints:
  POST /api/set-token        — 保存 API Key、平台、模型
  GET  /api/state            — 当前电池配置状态
  POST /api/chat             — 发送消息 → LLM → BatteryManager
  POST /api/update-slot      — 通过 UI 手动填写槽位
  POST /api/apply-template   — 应用模板
  GET  /api/templates        — 获取所有模板
  POST /api/generate-header  — 生成 constants.h
  POST /api/reset            — 重置状态和对话历史
"""

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import os
import json
import re
import traceback

from battery_manager import BatteryManager

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
CORS(app)


@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


# ── Session globals ────────────────────────────────────────────────────
_api_token: str = ""
_provider: str = "anthropic"   # anthropic | openai | deepseek | gemini | custom
_model: str = "claude-sonnet-4-6"
_base_url: str = ""            # 仅 custom 时使用
_battery: BatteryManager = BatteryManager()
_history: list = []

# ── 各平台默认模型 ────────────────────────────────────────────────────
PROVIDER_DEFAULTS = {
    "anthropic": "claude-sonnet-4-6",
    "openai":    "gpt-4o",
    "deepseek":  "deepseek-chat",
    "gemini":    "gemini-3.1-pro-preview",
    "custom":    "gpt-4o",
}

PROVIDER_BASE_URLS = {
    "deepseek": "https://api.deepseek.com",
}

# ── System Prompt ─────────────────────────────────────────────────────
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
4. STRICT MAPPING for cell_type and cell_subtype:
   - Any mention of "18650", "21700", "4680", "26650", "14500" → cell_type: "cylindrical", cell_subtype: the number (e.g. "18650")
   - "cylindrical", "cylinder", "round cell" → cell_type: "cylindrical", cell_subtype: null (unless size is stated)
   - "prismatic", "rectangular", "hard case", "square cell" → cell_type: "prismatic"
   - For prismatic, if chemistry is stated: LFP → cell_subtype: "lfp_prismatic", NMC → "nmc_prismatic", NCA → "nca_prismatic"
   - "pouch", "soft pack", "laminate" → cell_type: "pouch"
   - For pouch, if chemistry is stated: LFP → cell_subtype: "lfp_pouch", NMC → "nmc_pouch", NCA → "nca_pouch"
   - If cell type is not mentioned at all → cell_type: null, cell_subtype: null
5. CATEGORY PURITY:
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
    "cell_type": "<'cylindrical' | 'prismatic' | 'pouch' or null>",
    "cell_subtype": "<'18650'|'21700'|'4680'|'26650'|'14500'|'lfp_prismatic'|'nmc_prismatic'|'nca_prismatic'|'lfp_pouch'|'nmc_pouch'|'nca_pouch' or null>",
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


# ── LLM 调用（多平台统一入口）─────────────────────────────────────────

def _call_llm(user_message: str) -> str:
    """根据当前 _provider 调用对应平台，返回原始文本。"""

    if _provider == "anthropic":
        import anthropic as _anthropic
        client = _anthropic.Anthropic(api_key=_api_token)
        response = client.messages.create(
            model=_model,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            messages=_history,
        )
        return response.content[0].text

    elif _provider == "gemini":
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=_api_token)

        # 把历史对话转成 Gemini Content 格式
        gemini_history = []
        for msg in _history[:-1]:   # 除最后一条 user message
            role = "user" if msg["role"] == "user" else "model"
            gemini_history.append(
                types.Content(role=role, parts=[types.Part(text=msg["content"])])
            )

        # 最新 user message
        latest = _history[-1]["content"]

        response = client.models.generate_content(
            model=_model,
            contents=gemini_history + [
                types.Content(role="user", parts=[types.Part(text=latest)])
            ],
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_PROMPT,
                max_output_tokens=1024,
            ),
        )
        return response.text

    else:
        # OpenAI / DeepSeek / Custom — 全部走 openai 兼容接口
        from openai import OpenAI
        kwargs = {"api_key": _api_token}

        if _provider == "deepseek":
            kwargs["base_url"] = PROVIDER_BASE_URLS["deepseek"]
        elif _provider == "custom" and _base_url:
            kwargs["base_url"] = _base_url

        client = OpenAI(**kwargs)

        # 把 system prompt 拼入 messages（OpenAI 格式）
        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + _history

        response = client.chat.completions.create(
            model=_model,
            max_tokens=1024,
            messages=messages,
        )
        return response.choices[0].message.content


# ── 工具函数 ──────────────────────────────────────────────────────────

def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    # 有时模型会在 JSON 前后加文字，尝试提取 {...}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            return json.loads(m.group())
        raise


def _format_chat_reply(result: dict, llm_json: dict) -> str:
    parts = []
    intent = llm_json.get("intent", {}).get("type", "custom")
    params = llm_json.get("simulation_parameters", {})

    extracted = {k: v for k, v in params.items() if v is not None and k != "coolant_size"}
    if params.get("coolant_size"):
        extracted["coolant_size"] = params["coolant_size"]

    if extracted:
        parts.append("**Extracted**: " + ", ".join(f"`{k}={v}`" for k, v in extracted.items()))
    else:
        if intent == "template":
            kw = llm_json.get("intent", {}).get("search_keyword", "")
            parts.append(f"**Template search**: `{kw}`")
        elif intent == "update":
            parts.append("**Update intent** detected — no new parameters extracted.")
        else:
            parts.append("No explicit parameters found in your input.")

    for d in result.get("derived", []):
        parts.append(f"**Derived**: {d}")

    c = result.get("constraints", {})
    if c:
        hints = []
        if "max_temp" in c: hints.append(f"max temp {c['max_temp']}°C")
        if "current"  in c: hints.append(f"discharge {c['current']} A")
        if "power"    in c: hints.append(f"power {c['power']} W")
        parts.append("**Performance constraint**: " + ", ".join(hints))

    for conf in result.get("conflicts", []):
        parts.append(f"⚠️ **Conflict**: {conf}")

    missing = result.get("missing_slots", [])
    if missing:
        parts.append(
            "**Still needed**: " + ", ".join(f"`{m}`" for m in missing) +
            " — fill them in the panel on the right."
        )
    else:
        parts.append("✅ **All required parameters are set.** You can generate the header file.")

    tpls = result.get("template_matches", [])
    if tpls:
        parts.append(
            "💡 **Template suggestions**: " +
            ", ".join(t["name"] for t in tpls[:4]) +
            " — click one on the right to apply."
        )

    return "\n\n".join(parts)


# ── API 路由 ──────────────────────────────────────────────────────────

@app.route("/api/set-token", methods=["POST"])
def set_token():
    global _api_token, _provider, _model, _base_url
    data = request.json or {}

    token    = data.get("token", "").strip()
    provider = data.get("provider", "anthropic").strip()
    model    = data.get("model", "").strip()
    base_url = data.get("base_url", "").strip()

    if not token:
        return jsonify({"error": "Token cannot be empty"}), 400

    _api_token = token
    _provider  = provider if provider in PROVIDER_DEFAULTS else "anthropic"
    _model     = model if model else PROVIDER_DEFAULTS[_provider]
    _base_url  = base_url

    return jsonify({"success": True, "provider": _provider, "model": _model})


@app.route("/api/state", methods=["GET"])
def get_state():
    return jsonify({
        "state": _battery.state,
        "missing_slots": _battery.get_missing_slots(),
        "has_token": bool(_api_token),
        "provider": _provider,
        "model": _model,
    })


@app.route("/api/templates", methods=["GET"])
def get_templates():
    return jsonify({"templates": _battery.get_all_templates()})


@app.route("/api/chat", methods=["POST"])
def chat():
    global _history

    if not _api_token:
        return jsonify({"error": "请先设置 API Token。"}), 401

    data = request.json or {}
    user_message = data.get("message", "").strip()
    if not user_message:
        return jsonify({"error": "消息不能为空"}), 400

    _history.append({"role": "user", "content": user_message})

    try:
        raw = _call_llm(user_message)
        _history.append({"role": "assistant", "content": raw})
    except Exception as e:
        _history.pop()   # 回滚 user message
        # 打印完整堆栈到控制台，方便调试
        traceback.print_exc()
        # 直接把原始错误返回给前端，不做关键词猜测
        err_type = type(e).__name__
        err_msg  = str(e)
        return jsonify({"error": f"[{_provider}] {err_type}: {err_msg}"}), 500

    try:
        llm_json = _extract_json(raw)
    except (json.JSONDecodeError, ValueError) as e:
        return jsonify({"error": f"LLM 返回了非 JSON 内容: {e}", "raw": raw}), 500

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


@app.route("/api/update-slot", methods=["POST"])
def update_slot():
    data = request.json or {}
    slot  = data.get("slot")
    value = data.get("value")

    if slot not in ["cell_type","cell_subtype",
                    "total_cells","num_groups","cells_per_group",
                    "cooling_type","coolant_channels","coolant_size",
                    "layout_pattern","corner_size"]:
        return jsonify({"error": f"未知槽位: {slot}"}), 400

    result = _battery.update_slot(slot, value)
    return jsonify({
        "success": True,
        "state": _battery.state,
        "missing_slots": _battery.get_missing_slots(),
        "conflicts": result["conflicts"],
        "derived": result["derived"],
    })


@app.route("/api/update-layout", methods=["POST"])
def update_layout():
    data = request.json or {}
    pattern     = data.get("pattern", "standard")
    corner_size = int(data.get("corner_size", 1))
    result = _battery.update_layout(pattern, corner_size)
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
    result = _battery.apply_template_by_name(data.get("name", ""))
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
        return jsonify({"success": True, "content": _battery.generate_header()})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/reset", methods=["POST"])
def reset():
    global _history
    _battery.reset()
    _history = []
    return jsonify({"success": True, "state": _battery.state})


# ── Scheme editor endpoints ───────────────────────────────────────────

@app.route("/api/scheme", methods=["GET"])
def get_scheme():
    scheme = _battery.get_scheme()
    if scheme is None:
        return jsonify({"scheme": None,
                        "hint": "Set num_groups and cells_per_group first"})
    return jsonify({"success": True, "scheme": scheme})


@app.route("/api/generate-scheme", methods=["POST"])
def generate_scheme():
    data = request.json or {}
    template = data.get("template", "standard")
    params   = data.get("params", {})
    result = _battery.generate_scheme_template(template, params)
    if "error" in result:
        return jsonify(result), 400
    return jsonify({"success": True, "scheme": result})


@app.route("/api/update-scheme", methods=["POST"])
def update_scheme():
    data = request.json or {}
    scheme = data.get("scheme")
    if not scheme:
        return jsonify({"error": "No scheme provided"}), 400
    result = _battery.set_user_scheme(scheme)
    return jsonify({"success": True, **result})


@app.route("/api/validate-scheme", methods=["POST"])
def validate_scheme():
    data = request.json or {}
    scheme = data.get("scheme")
    if not scheme:
        return jsonify({"error": "No scheme provided"}), 400
    return jsonify(_battery.validate_scheme(scheme))


@app.route("/api/reset-scheme", methods=["POST"])
def reset_scheme():
    _battery.clear_user_scheme()
    scheme = _battery.get_scheme()
    return jsonify({"success": True, "scheme": scheme})


if __name__ == "__main__":
    print("=" * 55)
    print("  Energy LLM Battery Configurator")
    print("  http://127.0.0.1:8080")
    print("=" * 55)
    app.run(debug=True, port=8080)
