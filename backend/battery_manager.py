"""
BatteryManager: The Python "logic officer" in the LLM → Python → C++ pipeline.

Responsibilities:
  - Validation:    Detect contradictions (e.g., 100 cells ≠ 10×12)
  - Inference:     Derive missing values (cells_per_group = total / groups)
  - Slot-filling:  Track which slots are still null, expose them to the UI
  - Template DB:   Search and apply pre-built configurations
  - Code gen:      Produce the final constants.h file
"""

import re
import json
import os
from typing import Optional

TEMPLATES_PATH = os.path.join(os.path.dirname(__file__), "templates_db.json")
SCHEME_PRESETS_PATH = os.path.join(os.path.dirname(__file__), "scheme_presets.json")

COOLING_TYPES = {
    0: "S-type (Single S)",
    1: "C-type",
    2: "SS-type (Double S)",
    3: "E-type",
}

CELL_TYPES = {
    "cylindrical": "Cylindrical",
    "prismatic":   "Prismatic",
    "pouch":       "Pouch",
}

CELL_SUBTYPES = {
    # cylindrical
    "18650": "Cylindrical 18650 (18×65 mm)",
    "21700": "Cylindrical 21700 (21×70 mm)",
    "4680":  "Cylindrical 4680  (46×80 mm)",
    "26650": "Cylindrical 26650 (26×65 mm)",
    "14500": "Cylindrical 14500 (14×50 mm)",
    # prismatic
    "lfp_prismatic": "Prismatic LFP",
    "nmc_prismatic": "Prismatic NMC",
    "nca_prismatic": "Prismatic NCA",
    # pouch
    "lfp_pouch": "Pouch LFP",
    "nmc_pouch": "Pouch NMC",
    "nca_pouch": "Pouch NCA",
}

# Slots the user must provide before we can generate a header
REQUIRED_SLOTS = [
    "cell_type",
    "num_groups",
    "cells_per_group",
    "cooling_type",
    "coolant_channels",
    "coolant_size",
]

ALL_NUMERIC_SLOTS = [
    "total_cells",
    "num_groups",
    "cells_per_group",
    "cooling_type",
    "coolant_channels",
]

ALL_STRING_SLOTS = ["cell_type", "cell_subtype"]


class BatteryManager:
    def __init__(self):
        self.state = {
            "cell_type":    None,   # "cylindrical" | "prismatic" | "pouch"
            "cell_subtype": None,   # e.g. "18650", "21700", "lfp_prismatic", …
            "total_cells": None,
            "num_groups": None,
            "cells_per_group": None,
            "cooling_type": None,
            "coolant_channels": None,
            "coolant_size": [],
            "layout_features": {
                "pattern": "standard",   # standard | fully_filled | with_gaps | corner_cut | staggered
                "details": None,
                "corner_size": 1,        # for corner_cut only
            },
            "constraints": {},
            "user_scheme": None,    # user-edited 2D array; overrides auto-generated scheme
        }
        self.templates = self._load_templates()
        self._scheme_presets = self._load_scheme_presets()

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    def process_llm_json(self, llm_json: dict) -> dict:
        intent_type = llm_json.get("intent", {}).get("type", "custom")

        if intent_type == "template":
            return self._handle_template(llm_json)
        elif intent_type == "update":
            return self._handle_update(llm_json)
        else:
            return self._handle_custom(llm_json)

    def update_layout(self, pattern: str, corner_size: int = 1) -> dict:
        """Update layout pattern from UI selector."""
        self.state["layout_features"]["pattern"] = pattern
        if pattern == "corner_cut":
            self.state["layout_features"]["corner_size"] = max(1, int(corner_size))
        conflicts = self._validate_state()
        derived = self._derive_missing()
        return {"conflicts": conflicts, "derived": derived}

    def update_slot(self, slot: str, value) -> dict:
        """Called when user fills a missing slot directly from the UI."""
        if slot in ALL_STRING_SLOTS:
            self.state[slot] = str(value).strip() if value and str(value).strip() else None
        elif slot in ALL_NUMERIC_SLOTS:
            self.state[slot] = int(value) if value is not None and value != "" else None
        elif slot == "coolant_size":
            if isinstance(value, list):
                self.state["coolant_size"] = [int(v) for v in value if v != ""]
            else:
                raw = str(value).strip()
                if raw:
                    self.state["coolant_size"] = [
                        int(x.strip()) for x in raw.split(",") if x.strip()
                    ]
                else:
                    self.state["coolant_size"] = []

        conflicts = self._validate_state()
        derived = self._derive_missing()
        return {"conflicts": conflicts, "derived": derived}

    def get_missing_slots(self) -> list:
        missing = []
        for slot in REQUIRED_SLOTS:
            if slot == "coolant_size":
                if not self.state["coolant_size"]:
                    missing.append(slot)
            else:
                if self.state[slot] is None:
                    missing.append(slot)
        return missing

    # ── Scheme editor public interface ────────────────────────────────

    def get_scheme(self) -> dict | None:
        """Return current scheme: user-edited if set, else auto-generated."""
        if self.state.get("user_scheme") is not None:
            s = self.state["user_scheme"]
            rows = len(s)
            cols = len(s[0]) if s else 0
            return {"source": "user_edited", "rows": rows, "cols": cols,
                    "data": s, "description": "User-edited layout"}
        return self._generate_scheme()

    def set_user_scheme(self, scheme: list) -> dict:
        self.state["user_scheme"] = scheme
        return self.validate_scheme(scheme)

    def clear_user_scheme(self) -> None:
        self.state["user_scheme"] = None

    def validate_scheme(self, scheme: list) -> dict:
        errors = []
        if not scheme or not scheme[0]:
            return {"valid": False, "errors": ["Empty scheme"], "active_cells": 0}

        row_len = len(scheme[0])
        for i, row in enumerate(scheme):
            if len(row) != row_len:
                errors.append(f"Row {i}: length {len(row)} ≠ {row_len}")

        nums = [v for row in scheme for v in row if v != 0]
        active = len(nums)

        if nums:
            n_max = max(nums)
            nums_set = set(nums)
            missing = set(range(1, n_max + 1)) - nums_set
            dupes = sorted({v for v in nums if nums.count(v) > 1})
            if missing:
                shown = sorted(missing)[:10]
                errors.append(f"Missing IDs: {shown}{'…' if len(missing) > 10 else ''}")
            if dupes:
                errors.append(f"Duplicate IDs: {dupes[:5]}")
            g = self.state["num_groups"]
            c = self.state["cells_per_group"]
            if g and c and active != g * c:
                errors.append(f"Active cells ({active}) ≠ {g}×{c}={g*c}")

        return {"valid": len(errors) == 0, "errors": errors, "active_cells": active}

    def generate_scheme_template(self, template: str, params: dict) -> dict:
        """Generate an initial scheme from a named template and save as user_scheme."""
        g = self.state["num_groups"]
        c = self.state["cells_per_group"]
        if not g or not c:
            return {"error": "Set num_groups and cells_per_group first"}

        dispatch = {
            "standard":   lambda: {
                "source": "standard", "rows": g, "cols": c,
                "data": [[i * c + j + 1 for j in range(c)] for i in range(g)],
                "description": "Standard rectangular"},
            "corner_cut": lambda: self._make_corner_cut(
                g, c, int(params.get("corner_size", 1))),
            "staggered":  lambda: self._make_staggered(g, c),
            "l_shape":    lambda: self._make_l_shape(
                g, c,
                int(params.get("cut_rows", max(1, g // 4))),
                int(params.get("cut_cols", max(1, c // 4)))),
            "u_shape":    lambda: self._make_u_shape(
                g, c,
                int(params.get("inner_rows", max(1, g // 3))),
                int(params.get("inner_cols", max(1, c // 2)))),
            "sedan":      lambda: self._make_sedan(
                g, c,
                tuple(params.get("top_left",  [1, 1])),
                tuple(params.get("top_right", [1, 1])),
                tuple(params.get("bot_left",  [1, 1])),
                tuple(params.get("bot_right", [1, 1]))),
        }

        fn = dispatch.get(template)
        if not fn:
            return {"error": f"Unknown template: {template}"}

        result = fn()
        if result and "data" in result:
            self.state["user_scheme"] = result["data"]
        return result

    # ── New shape generators ──────────────────────────────────────────

    def _make_l_shape(self, g: int, c: int, cut_rows: int, cut_cols: int) -> dict:
        """Rectangle with top-right corner removed."""
        cut_rows = max(0, min(cut_rows, g - 1))
        cut_cols = max(0, min(cut_cols, c - 1))
        cell_id = 1
        data = []
        for i in range(g):
            row = []
            for j in range(c):
                if i < cut_rows and j >= c - cut_cols:
                    row.append(0)
                else:
                    row.append(cell_id)
                    cell_id += 1
            data.append(row)
        return {"source": "l_shape", "rows": g, "cols": c, "data": data,
                "description": f"L-shape (cut {cut_rows}×{cut_cols} top-right)"}

    def _make_u_shape(self, g: int, c: int, inner_rows: int, inner_cols: int) -> dict:
        """Rectangle with a rectangular hole cut from the bottom centre."""
        inner_rows = max(1, min(inner_rows, g - 2))
        inner_cols = max(1, min(inner_cols, c - 2))
        col_s = (c - inner_cols) // 2
        col_e = col_s + inner_cols
        row_s = g - inner_rows
        cell_id = 1
        data = []
        for i in range(g):
            row = []
            for j in range(c):
                if i >= row_s and col_s <= j < col_e:
                    row.append(0)
                else:
                    row.append(cell_id)
                    cell_id += 1
            data.append(row)
        return {"source": "u_shape", "rows": g, "cols": c, "data": data,
                "description": f"U-shape (inner {inner_rows}×{inner_cols})"}

    def _make_sedan(self, g: int, c: int,
                    tl: tuple = (1, 1), tr: tuple = (1, 1),
                    bl: tuple = (1, 1), br: tuple = (1, 1)) -> dict:
        """Asymmetric corner notches — typical EV underfloor shape."""
        def _cut(i, j):
            if i < tl[0] and j < tl[1]:            return True
            if i < tr[0] and j >= c - tr[1]:        return True
            if i >= g - bl[0] and j < bl[1]:        return True
            if i >= g - br[0] and j >= c - br[1]:   return True
            return False

        cell_id = 1
        data = []
        for i in range(g):
            row = []
            for j in range(c):
                if _cut(i, j):
                    row.append(0)
                else:
                    row.append(cell_id)
                    cell_id += 1
            data.append(row)
        return {"source": "sedan", "rows": g, "cols": c, "data": data,
                "description": f"Sedan underfloor tl={tl} tr={tr} bl={bl} br={br}"}

    def apply_template_by_name(self, name: str) -> dict:
        """Apply a specific template chosen by the user from UI."""
        template = next(
            (t for t in self.templates if t["name"] == name), None
        )
        if not template:
            return {"error": f"Template '{name}' not found"}

        self._apply_template(template)
        conflicts = self._validate_state()
        derived = self._derive_missing()
        return {
            "missing_slots": self.get_missing_slots(),
            "conflicts": conflicts,
            "messages": [f"Applied template: {template['name']}"],
            "derived": derived,
        }

    def generate_header(self) -> str:
        missing = self.get_missing_slots()
        if missing:
            raise ValueError(
                f"Cannot generate header. Missing: {', '.join(missing)}"
            )

        s = self.state
        g = s["num_groups"]
        c = s["cells_per_group"]
        channels  = s["coolant_channels"]
        sizes     = s["coolant_size"]
        tot_size  = sum(sizes)
        cooling_name = COOLING_TYPES.get(s["cooling_type"], "UNKNOWN")

        cell_type    = s.get("cell_type")    or "unknown"
        cell_subtype = s.get("cell_subtype") or ""
        cell_label   = CELL_SUBTYPES.get(cell_subtype) or CELL_TYPES.get(cell_type, cell_type)

        lines = [
            "// Auto-generated by Energy LLM Battery Configurator",
            "// DO NOT EDIT — regenerate via the web interface",
            "",
            "#ifndef BATTERY_CONFIG_H",
            "#define BATTERY_CONFIG_H",
            "",
            f'// Cell type        : {cell_label}',
            f'#define CELL_TYPE    "{cell_type}"',
        ]
        if cell_subtype:
            lines.append(f'#define CELL_SUBTYPE "{cell_subtype}"')
        lines += [
            "",
            f"#define NUM_GROUPS {g}",
            f"#define CELLS_PER_GROUP {c}",
            f"#define N_BATT (NUM_GROUPS*CELLS_PER_GROUP)",
        ]

        # ── Scheme array ──────────────────────────────────────────────
        scheme_result = self.get_scheme()
        if scheme_result is not None:
            r   = scheme_result["rows"]
            col = scheme_result["cols"]
            rows_str = ", ".join(
                "{" + ", ".join(str(v) for v in row) + "}"
                for row in scheme_result["data"]
            )
            if scheme_result["source"] == "standard":
                lines.append(
                    f"const int scheme[NUM_GROUPS][CELLS_PER_GROUP] = {{{rows_str}}};"
                )
            else:
                lines.append(f"// Layout: {scheme_result['description']}")
                lines.append(f"const int scheme[{r}][{col}] = {{{rows_str}}};")
        else:
            lines.append(f"// scheme: no preset found for {g}×{c} with_gaps layout")
            lines.append("// Define scheme manually based on physical cell arrangement.")

        # ── Cooling system ────────────────────────────────────────────
        lines += [
            "",
            f"#define COOLANT_CHANNELS {channels}",
            f"#define TOT_COOLANT_SIZE {tot_size}",
            f"const int coolant_size[{channels}] = {{{', '.join(map(str, sizes))}}};",
            f"// Cooling types: 0=S-type  1=C-type  2=SS-type  3=E-type",
            f"const int cooling_type = {s['cooling_type']};  // {cooling_name}",
        ]

        # ── Layout notes ──────────────────────────────────────────────
        pattern = s["layout_features"]["pattern"]
        details = s["layout_features"]["details"]
        if pattern != "standard" or details:
            lines.append("")
            lines.append(f"// Layout pattern : {pattern}" +
                         (f" — {details}" if details else ""))

        # ── Performance constraints (reference only) ──────────────────
        if s["constraints"]:
            lines.append("")
            lines.append("// Performance constraints (reference only):")
            if "max_temp" in s["constraints"]:
                lines.append(f"// Max temperature : {s['constraints']['max_temp']} °C")
            if "current" in s["constraints"]:
                lines.append(f"// Discharge current: {s['constraints']['current']} A")
            if "power" in s["constraints"]:
                lines.append(f"// Power            : {s['constraints']['power']} W")

        lines += ["", "#endif // BATTERY_CONFIG_H", ""]
        return "\n".join(lines)

    def _generate_scheme(self) -> Optional[dict]:
        """
        返回 scheme 数组及其元信息，供 generate_header() 使用。

        返回结构：
          {
            "source": "standard" | "preset",
            "rows": int, "cols": int,
            "data": [[int, ...]],
            "description": str   # 仅 preset 有
          }

        三种情况：
          1. standard / fully_filled → 顺序编号矩形，dims = [num_groups][cells_per_group]
          2. with_gaps + 找到预设 → 从 scheme_presets.json 读取
          3. with_gaps + 无预设 → 返回 None，提示用户手动填写
        """
        g = self.state["num_groups"]
        c = self.state["cells_per_group"]
        pattern = self.state["layout_features"]["pattern"]

        if not g or not c:
            return None

        # ── Case 1: standard rectangular layout ──────────────────────
        if pattern in ("standard", "fully_filled"):
            return {
                "source": "standard",
                "rows": g,
                "cols": c,
                "data": [[i * c + j + 1 for j in range(c)] for i in range(g)],
                "description": "",
            }

        # ── Case 2: corner_cut — rectangle with triangular corners ────
        if pattern == "corner_cut":
            cs = self.state["layout_features"].get("corner_size", 1)
            return self._make_corner_cut(g, c, cs)

        # ── Case 3: staggered — brick-offset rows ─────────────────────
        if pattern == "staggered":
            return self._make_staggered(g, c)

        # ── Case 4 & 5: with_gaps — look up preset ───────────────────
        key = f"{g}x{c}"
        preset = self._scheme_presets.get(key)
        if preset:
            return {
                "source": "preset",
                "rows": preset["rows"],
                "cols": preset["cols"],
                "data": preset["scheme"],
                "description": preset["description"],
            }

        # No preset found
        return None

    def _make_corner_cut(self, g: int, c: int, cs: int) -> dict:
        """
        Rectangular grid with triangular corners removed.
        The 4 corners satisfy: i+j < cs  or  i+(c-1-j) < cs
                               (g-1-i)+j < cs  or  (g-1-i)+(c-1-j) < cs
        Cell IDs are assigned left-to-right, top-to-bottom, skipping 0s.
        Matrix dimensions stay [g][c].
        """
        cs = max(0, min(cs, min(g, c) // 2))  # clamp to sensible range
        mask = []
        for i in range(g):
            row = []
            for j in range(c):
                cut = (i + j < cs or
                       i + (c - 1 - j) < cs or
                       (g - 1 - i) + j < cs or
                       (g - 1 - i) + (c - 1 - j) < cs)
                row.append(0 if cut else 1)
            mask.append(row)

        cell_id = 1
        data = []
        for i in range(g):
            row = []
            for j in range(c):
                if mask[i][j]:
                    row.append(cell_id)
                    cell_id += 1
                else:
                    row.append(0)
            data.append(row)

        return {
            "source": "corner_cut",
            "rows": g,
            "cols": c,
            "data": data,
            "description": f"corner_cut (corner_size={cs})",
        }

    def _make_staggered(self, g: int, c: int) -> dict:
        """
        Brick / staggered layout: odd rows are offset right by 1.
        Matrix is [g][c+1]: even rows fill cols 0..c-1, col c = 0;
                             odd rows fill cols 1..c,   col 0 = 0.
        Cell IDs assigned left-to-right, top-to-bottom.
        """
        cols = c + 1
        cell_id = 1
        data = []
        for i in range(g):
            row = [0] * cols
            if i % 2 == 0:          # even row: fill left, trailing 0
                for j in range(c):
                    row[j] = cell_id
                    cell_id += 1
            else:                   # odd row: leading 0, fill right
                for j in range(1, cols):
                    row[j] = cell_id
                    cell_id += 1
            data.append(row)

        return {
            "source": "staggered",
            "rows": g,
            "cols": cols,
            "data": data,
            "description": "staggered (brick offset)",
        }

    def _load_scheme_presets(self) -> dict:
        """Load scheme_presets.json → dict keyed by '{num_groups}x{cells_per_group}'."""
        try:
            with open(SCHEME_PRESETS_PATH, encoding="utf-8") as f:
                raw = json.load(f)
            return {p["key"]: p for p in raw.get("presets", [])}
        except Exception:
            return {}

    def reset(self):
        self.__init__()

    def _clear_slots(self):
        """清空所有参数槽位（保留 constraints），用于 custom 意图开始新配置。"""
        for key in ALL_NUMERIC_SLOTS:
            self.state[key] = None
        for key in ALL_STRING_SLOTS:
            self.state[key] = None
        self.state["coolant_size"] = []
        self.state["user_scheme"] = None
        self.state["layout_features"] = {"pattern": "standard", "details": None}

    def get_all_templates(self) -> list:
        return [
            {"name": t["name"], "description": t.get("description", "")}
            for t in self.templates
        ]

    # ------------------------------------------------------------------
    # Intent handlers
    # ------------------------------------------------------------------

    def _handle_template(self, llm_json: dict) -> dict:
        keyword = llm_json.get("intent", {}).get("search_keyword", "")
        overrides = llm_json.get("simulation_parameters", {})

        matches = self._search_templates(keyword)
        messages = []
        template_matches = []

        if matches:
            self._apply_template(matches[0])
            messages.append(f"Applied template: {matches[0]['name']}")
            template_matches = [
                {"name": m["name"], "description": m.get("description", "")}
                for m in matches
            ]
        else:
            messages.append(
                f"No template found for '{keyword}'. "
                "Please choose one below or describe parameters manually."
            )
            template_matches = [
                {"name": t["name"], "description": t.get("description", "")}
                for t in self.templates
            ]

        # Apply any explicit overrides (e.g., "Tesla but coolant_size=12")
        override_msgs = self._apply_params(overrides, is_override=True)
        messages.extend(override_msgs)

        conflicts = self._validate_state()
        derived = self._derive_missing()

        return {
            "missing_slots": self.get_missing_slots(),
            "conflicts": conflicts,
            "messages": messages,
            "template_matches": template_matches,
            "derived": derived,
            "constraints": self.state["constraints"],
        }

    def _handle_update(self, llm_json: dict) -> dict:
        params = llm_json.get("simulation_parameters", {})
        layout = llm_json.get("layout_features", {})

        msgs = self._apply_params(params, is_override=True)
        if layout.get("pattern"):
            self.state["layout_features"]["pattern"] = layout["pattern"]
        if layout.get("details"):
            self.state["layout_features"]["details"] = layout["details"]

        conflicts = self._validate_state()
        derived = self._derive_missing()

        return {
            "missing_slots": self.get_missing_slots(),
            "conflicts": conflicts,
            "messages": msgs,
            "template_matches": [],
            "derived": derived,
            "constraints": self.state["constraints"],
        }

    def _handle_custom(self, llm_json: dict) -> dict:
        params = llm_json.get("simulation_parameters", {})
        layout = llm_json.get("layout_features", {})
        reasoning = llm_json.get("llm_reasoning", {})

        # custom 意图 = 全新描述，先清空所有槽位，避免旧状态（如模板）干扰
        self._clear_slots()

        # Parse physical constraints out of the "junk drawer"
        assumptions = reasoning.get("assumptions_made") or ""
        constraints = self._parse_constraints(assumptions)
        self.state["constraints"].update(constraints)

        # custom 意图用 override=True，让 LLM 提取的值直接写入
        msgs = self._apply_params(params, is_override=True)

        if layout.get("pattern"):
            self.state["layout_features"]["pattern"] = layout["pattern"]
        if layout.get("details"):
            self.state["layout_features"]["details"] = layout["details"]

        # Handle fully_filled → extract grid dimensions automatically
        if layout.get("pattern") == "fully_filled":
            grid_msgs = self._handle_fully_filled(layout.get("details", ""))
            msgs.extend(grid_msgs)

        conflicts = self._validate_state()
        derived = self._derive_missing()

        # If user gave ONLY performance constraints, suggest templates
        template_matches = []
        numeric_all_null = all(
            self.state[k] is None for k in ALL_NUMERIC_SLOTS
        ) and not self.state["coolant_size"]
        if numeric_all_null and constraints:
            suggestions = self._search_by_constraints(constraints)
            template_matches = [
                {"name": t["name"], "description": t.get("description", "")}
                for t in suggestions
            ]
            if template_matches:
                msgs.append(
                    "No physical parameters found. "
                    "Here are some templates that might fit your goals:"
                )

        return {
            "missing_slots": self.get_missing_slots(),
            "conflicts": conflicts,
            "messages": msgs,
            "template_matches": template_matches,
            "derived": derived,
            "constraints": constraints,
        }

    # ------------------------------------------------------------------
    # Parameter helpers
    # ------------------------------------------------------------------

    def _apply_params(self, params: dict, is_override: bool) -> list:
        msgs = []
        for key in ALL_STRING_SLOTS:
            val = params.get(key)
            if val is not None and str(val).strip():
                if is_override or self.state[key] is None:
                    self.state[key] = str(val).strip()
                    msgs.append(f"Set {key} = {val}")

        for key in ALL_NUMERIC_SLOTS:
            val = params.get(key)
            if val is not None:
                if is_override or self.state[key] is None:
                    self.state[key] = int(val)
                    msgs.append(f"Set {key} = {int(val)}")

        sizes = params.get("coolant_size", [])
        if sizes:
            self.state["coolant_size"] = [int(v) for v in sizes]
            msgs.append(f"Set coolant_size = {self.state['coolant_size']}")

        return msgs

    def _apply_template(self, template: dict):
        p = template["params"]
        for key in ALL_NUMERIC_SLOTS:
            self.state[key] = p.get(key)
        self.state["coolant_size"] = list(p.get("coolant_size", []))
        self.state["cell_type"]    = p.get("cell_type")
        self.state["cell_subtype"] = p.get("cell_subtype")
        lf = template.get("layout_features", {})
        self.state["layout_features"]["pattern"] = lf.get("pattern", "standard")
        self.state["layout_features"]["details"] = lf.get("details")

    def _handle_fully_filled(self, details: str) -> list:
        msgs = []
        if not details:
            return msgs
        m = re.search(r"(\d+)\s*[xX×]\s*(\d+)", details)
        if m:
            rows, cols = int(m.group(1)), int(m.group(2))
            if self.state["num_groups"] is None:
                self.state["num_groups"] = rows
                msgs.append(f"Grid: inferred num_groups = {rows}")
            if self.state["cells_per_group"] is None:
                self.state["cells_per_group"] = cols
                msgs.append(f"Grid: inferred cells_per_group = {cols}")
        return msgs

    def _derive_missing(self) -> list:
        """Deterministic math derivation — never guesses, always exact."""
        derived = []
        t = self.state["total_cells"]
        g = self.state["num_groups"]
        c = self.state["cells_per_group"]

        if t and g and c is None:
            if t % g == 0:
                self.state["cells_per_group"] = t // g
                derived.append(
                    f"Derived cells_per_group = {t} ÷ {g} = {t // g}"
                )
            else:
                derived.append(
                    f"Cannot derive cells_per_group: {t} ÷ {g} = {t/g:.2f} (not integer)"
                )
        elif g and c and t is None:
            self.state["total_cells"] = g * c
            derived.append(f"Derived total_cells = {g} × {c} = {g * c}")
        elif t and c and g is None:
            if t % c == 0:
                self.state["num_groups"] = t // c
                derived.append(
                    f"Derived num_groups = {t} ÷ {c} = {t // c}"
                )

        return derived

    def _validate_state(self) -> list:
        conflicts = []
        t = self.state["total_cells"]
        g = self.state["num_groups"]
        c = self.state["cells_per_group"]

        if t and g and c:
            if t != g * c:
                conflicts.append(
                    f"total_cells ({t}) ≠ num_groups × cells_per_group "
                    f"({g} × {c} = {g * c})"
                )

        channels = self.state["coolant_channels"]
        sizes = self.state["coolant_size"]
        if channels and sizes and len(sizes) != channels:
            conflicts.append(
                f"coolant_channels={channels} but coolant_size has "
                f"{len(sizes)} value(s) — they should match"
            )

        return conflicts

    def _parse_constraints(self, text: str) -> dict:
        c = {}
        if not text:
            return c
        m = re.search(r"(\d+(?:\.\d+)?)\s*°?\s*[Cc](?:elsius)?\b", text)
        if m:
            c["max_temp"] = float(m.group(1))
        m = re.search(r"(\d+(?:\.\d+)?)\s*A\b", text)
        if m:
            c["current"] = float(m.group(1))
        m = re.search(r"(\d+(?:\.\d+)?)\s*[kK][Ww]\b", text)
        if m:
            c["power"] = float(m.group(1)) * 1000
        else:
            m = re.search(r"(\d+(?:\.\d+)?)\s*[Ww]\b", text)
            if m:
                c["power"] = float(m.group(1))
        return c

    # ------------------------------------------------------------------
    # Template search
    # ------------------------------------------------------------------

    def _load_templates(self) -> list:
        try:
            with open(TEMPLATES_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return []

    def _search_templates(self, keyword: str) -> list:
        if not keyword or keyword.lower() == "none":
            return []
        kw = keyword.lower()
        return [
            t for t in self.templates
            if any(tag in kw or kw in tag for tag in t.get("keywords", []))
        ]

    def _search_by_constraints(self, constraints: dict) -> list:
        """Score and rank templates by how well they satisfy performance constraints.

        Scoring (each dimension independent):
          max_temp : template.max_temp_C <= limit  → +2, bonus for thermal margin
          current  : template.max_discharge_A >= required → +2 + headroom bonus;
                     templates that cannot meet current are excluded entirely.
          power    : nominal_voltage × max_discharge_A >= required → +2
        """
        max_temp = constraints.get("max_temp")
        current  = constraints.get("current")
        power    = constraints.get("power")

        scored = []
        for t in self.templates:
            perf = t.get("performance", {})
            score = 0.0
            disqualified = False

            if max_temp is not None:
                t_max = perf.get("max_temp_C")
                if t_max is not None and t_max <= max_temp:
                    score += 2.0 + max(0.0, (max_temp - t_max) / 5.0)

            if current is not None:
                t_curr = perf.get("max_discharge_A")
                if t_curr is not None:
                    if t_curr >= current:
                        score += 2.0 + min(1.0, (t_curr - current) / current)
                    else:
                        disqualified = True

            if power is not None:
                t_volt  = perf.get("nominal_voltage_V", 0)
                t_curr2 = perf.get("max_discharge_A", 0)
                if t_volt * t_curr2 >= power:
                    score += 2.0

            if not disqualified:
                scored.append((score, t))

        scored.sort(key=lambda x: x[0], reverse=True)
        qualified = [(s, t) for s, t in scored if s > 0]
        result = qualified if qualified else scored
        return [t for _, t in result[:4]]
