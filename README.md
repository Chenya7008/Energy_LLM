# Energy LLM — Battery Pack Configurator

A conversational tool for configuring battery thermal simulation parameters. Describe your battery pack in natural language; the system extracts structured parameters, detects conflicts, derives missing values, and generates a ready-to-use C++ header file.

---

## Quick Start

### Windows

```text
Double-click start.bat
```

### macOS / Linux

```bash
chmod +x start.sh
./start.sh
```

The script automatically installs dependencies and opens `http://127.0.0.1:8080` in your browser.

### Manual Start

```bash
pip install -r backend/requirements.txt
python backend/app.py
# Then open http://127.0.0.1:8080
```

---

## Usage

### 1. Configure an API Key

In the top bar: select a provider → enter the model name → paste your API key → optionally enter a "Save as" label → click **Connect**.

Supported providers:

| Provider | Recommended Model | Get Key |
| --- | --- | --- |
| Anthropic (Claude) | claude-sonnet-4-6 | console.anthropic.com |
| OpenAI (GPT) | gpt-4o | platform.openai.com |
| DeepSeek | deepseek-chat | platform.deepseek.com |
| Google Gemini | gemini-2.0-flash | aistudio.google.com |
| Custom | any | Enter a Base URL (OpenAI-compatible) |

Keys are stored in browser `localStorage` — they never pass through any server and are auto-filled on next visit.

### 2. Describe your battery pack

Use natural language in the left chat panel:

```text
"4 groups, 3 cells each, S-type cooling, 1 channel, coolant length 9"
"Use the Tesla Model S template"
"100 cells in 10 groups, water cooling"
"I want a pack that won't overheat under 100A discharge, keep it below 45°C"
"Change cooling to C-type and use 2 channels"
```

### 3. Fill in missing parameters

The right panel shows all extracted parameters in real time. Missing slots are highlighted in red and can be filled directly without re-prompting the LLM.

### 4. Choose a layout pattern

Use the layout selector in the right panel:

| Pattern | Description |
| --- | --- |
| `standard` | Sequential rectangular grid — default |
| `fully_filled` | Forces the entire bounding box to be occupied |
| `with_gaps` | Non-rectangular layout loaded from `scheme_presets.json` |
| `corner_cut` | Rectangular grid with triangular corners removed (configurable size) |
| `staggered` | Brick / offset-row layout — odd rows shifted right by one cell |

### 5. Generate constants.h

Once all required slots are filled, click the green **Generate constants.h** button to preview, copy, or download the header file for your C++ simulation engine.

---

## Architecture

```text
User natural language
        │
        ▼
   LLM  ("Ears")
   Semantic extraction only — no math, no guessing
   Outputs structured JSON
        │
        ▼
   Python BatteryManager  ("Brain")
   Validate → Derive → Detect conflicts → Manage state
        │
        ▼
   Frontend UI  ("Arbiter")
   Null slots → prompt manual input, never re-ask LLM
        │
        ▼
   constants.h  (handed to the C++ simulation engine)
```

### Core principle: LLM as "Ears", Python as "Brain"

LLMs are probabilistic by nature and unsuitable for precise arithmetic. The system is designed around this principle:

- **LLM does one thing**: map unstructured language to predefined JSON slots. Any number not explicitly stated becomes `null` — no guessing, no calculation.
- **Python handles all logic**: mathematical derivation, conflict detection, state persistence. These operations are deterministic and verifiable.
- **UI handles the fallback**: when a slot cannot be filled by the LLM, the user fills it directly — no repeated LLM queries (saves tokens, avoids hallucination chaining).

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Backend | Python 3 + Flask + flask-cors |
| LLM integration | anthropic SDK / openai SDK / google-genai SDK |
| Frontend | Vanilla HTML + CSS + JavaScript (no build tools) |
| Persistence | Browser `localStorage` (API key management) |
| Deployment | Local single-machine; Flask serves the frontend static files |

---

## JSON Protocol

The LLM output strictly follows this schema (based on the EMIOT.pdf specification):

```json
{
  "intent": {
    "type": "custom | template | update",
    "search_keyword": "Tesla Model S | none"
  },
  "simulation_parameters": {
    "total_cells": 100,
    "num_groups": 10,
    "cells_per_group": null,
    "cooling_type": null,
    "coolant_channels": null,
    "coolant_size": []
  },
  "layout_features": {
    "pattern": "standard | with_gaps | fully_filled | corner_cut | staggered",
    "details": "8x8 grid"
  },
  "llm_reasoning": {
    "missing_info": ["cells_per_group", "cooling_type"],
    "assumptions_made": "User mentioned water cooling. Max_Temp < 45°C."
  }
}
```

**Three intent types:**

- `custom`: New configuration from scratch. LLM lists all empty slots in `missing_info`. Python clears existing state before writing.
- `template`: User references a named model (e.g., "Tesla Model S"). Python performs fuzzy keyword search, then fills all params. LLM-extracted values take precedence as overrides.
- `update`: Only the slots the user mentioned are changed; everything else remains unchanged (incremental update).

---

## Python BatteryManager — Core Logic

### Deterministic derivation

```python
# Known total and groups → derive cells per group
if total and groups and cells_per_group is None:
    if total % groups == 0:
        cells_per_group = total // groups   # only when evenly divisible; remainder raises an error

# Known groups and cells per group → derive total
elif groups and cells_per_group and total is None:
    total = groups * cells_per_group
```

LLM division can be wrong (100 ÷ 3 might return 33). Python uses integer division and raises an explicit error on remainders.

### Conflict detection

```python
if total and groups and cells_per_group:
    if total != groups * cells_per_group:
        # Red warning — no auto-correction; preserve the user's original intent
        conflicts.append(f"total_cells ({total}) ≠ {groups} × {cells_per_group}")
```

Conflicts are never silently fixed — the user decides which number is correct.

### State machine

```text
custom   → clear all slots → write new values → derive → conflict check
template → replace all     → apply overrides  → derive → conflict check
update   → update named slots only            → derive → conflict check
```

Conversation history is maintained by Python. The LLM processes only the current message and does not depend on its own context window for state.

---

## Template Suggestions — How They Work

When the user provides only a performance goal (e.g. "100A discharge, max 45°C") without any physical parameters, the system follows this pipeline:

### Step 1 — LLM extracts constraints, not parameters

The system prompt forbids the LLM from guessing physical values. It only extracts:

```json
"assumptions_made": "Constraint: Max_Temp < 45°C, Discharge = 100A"
```

All `simulation_parameters` remain `null`.

### Step 2 — Python parses the constraints

Regular expressions extract structured values from `assumptions_made`:

```python
def _parse_constraints(self, text):
    constraints = {}
    m = re.search(r"(\d+\.?\d*)\s*°?\s*[Cc]", text)
    if m: constraints["max_temp"] = float(m.group(1))   # → 45.0

    m = re.search(r"(\d+\.?\d*)\s*A\b", text)
    if m: constraints["current"]  = float(m.group(1))   # → 100.0
    return constraints
```

### Step 3 — Ranked template recommendations

Python detects that all numeric slots are `null` and performance constraints exist → performance-driven scenario. Templates are scored across three independent dimensions:

- **max_temp**: template's `max_temp_C` ≤ user's limit → score +2, with thermal headroom bonus
- **current**: template's `max_discharge_A` ≥ required → score +2 + headroom bonus; templates that fall short are excluded
- **power**: `nominal_voltage × max_discharge_A` ≥ required → score +2

Top-ranked templates are shown as suggestion cards on the right.

### Step 4 — User clicks a template → loop closed

Python fills all parameters from the template. Any remaining missing slots are flagged for manual input. No additional LLM tokens consumed.

### Why not let the LLM recommend directly?

- The LLM has no knowledge of what is in the template library — it will hallucinate non-existent configurations.
- Recommendation logic should be deterministic (filter a database by constraints), not probabilistic.
- Python's results are verifiable and traceable.

---

## API Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/api/set-token` | Save API key, provider, and model |
| `GET` | `/api/state` | Get current battery configuration state |
| `POST` | `/api/chat` | Send a message → LLM → BatteryManager |
| `POST` | `/api/update-slot` | Manually fill a slot from the UI |
| `POST` | `/api/update-layout` | Update layout pattern from the UI selector |
| `POST` | `/api/apply-template` | Apply a template by name |
| `GET` | `/api/templates` | List all available templates |
| `POST` | `/api/generate-header` | Generate `constants.h` |
| `POST` | `/api/reset` | Reset state and conversation history |

---

## File Structure

```text
Energy_LLM/
├── backend/
│   ├── app.py                # Flask API (9 endpoints)
│   ├── battery_manager.py    # Core state machine and derivation logic
│   ├── templates_db.json     # Pre-built template library (Tesla / Nissan / BMW / …)
│   ├── scheme_presets.json   # Non-rectangular layout schemes (with_gaps presets)
│   └── requirements.txt
├── frontend/
│   ├── index.html            # Two-column main UI
│   ├── style.css             # Dark theme
│   └── app.js                # Frontend logic + API key management
├── start.bat                 # Windows one-click launcher
├── start.sh                  # macOS / Linux one-click launcher
└── EMIOT.pdf                 # Original architecture specification
```

---

## Extending the Template Library

Edit `backend/templates_db.json` and add an entry in this format:

```json
{
  "name": "My Custom Pack",
  "keywords": ["my pack", "custom"],
  "description": "Brief description shown in the UI",
  "params": {
    "total_cells": 48,
    "num_groups": 12,
    "cells_per_group": 4,
    "cooling_type": 0,
    "coolant_channels": 1,
    "coolant_size": [9]
  },
  "layout_features": {
    "pattern": "standard",
    "details": "12x4 grid"
  },
  "performance": {
    "max_temp_C": 40,
    "max_discharge_A": 120,
    "nominal_voltage_V": 48
  }
}
```

**Cooling type mapping:** `0 = S-type`, `1 = C-type`, `2 = SS-type`, `3 = E-type`

The optional `performance` block enables constraint-based template ranking when users describe goals instead of parameters.
