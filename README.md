# Energy LLM — Battery Pack Configurator

A conversational tool for configuring battery thermal simulation parameters. Describe your battery pack in natural language; the system extracts structured parameters, detects conflicts, derives missing values, and generates a ready-to-use C++ header file.

---

## Quick Start

### Windows
```
双击 start.bat
```

### macOS / Linux
```bash
chmod +x start.sh
./start.sh
```

脚本会自动安装依赖并在浏览器打开 `http://127.0.0.1:5000`。

### 手动启动
```bash
pip install -r backend/requirements.txt
python backend/app.py
# 浏览器访问 http://127.0.0.1:5000
```

---

## 使用方式

### 1. 配置 API Key

顶栏选择平台 → 填入模型名 → 粘贴 API Key → 填写「保存为」名称（可选）→ 点击**连接**。

支持的平台：

| 平台 | 推荐模型 | 获取 Key |
|---|---|---|
| Anthropic (Claude) | claude-sonnet-4-6 | console.anthropic.com |
| OpenAI (GPT) | gpt-4o | platform.openai.com |
| DeepSeek | deepseek-chat | platform.deepseek.com |
| Google Gemini | gemini-2.0-flash | aistudio.google.com |
| 自定义 | 任意 | 填入 Base URL 即可（兼容 OpenAI 格式）|

Key 保存在浏览器 `localStorage`，不经过任何服务器，下次打开自动填入。

### 2. 描述你的电池包

在左侧聊天框用自然语言描述，支持多种输入风格：

```
"4 groups, 3 cells each, S-type cooling, 1 channel, coolant length 9"
"Use the Tesla Model S template"
"100 cells in 10 groups, water cooling"
"I want a pack that won't overheat under 100A discharge, keep it below 45°C"
"Change cooling to C-type and use 2 channels"
```

### 3. 补全缺失参数

右侧面板实时显示已提取的参数。缺失项标红，可直接在右侧输入框手动填写，无需再次对话。

### 4. 生成 constants.h

所有必填参数就绪后，点击绿色 **Generate constants.h** 按钮，可预览、复制或下载，直接交给 C++ 仿真引擎使用。

---

## 架构设计

```
用户自然语言
     │
     ▼
  LLM（"耳朵"）
  只做语义提取，严禁计算和猜测
  输出标准 JSON
     │
     ▼
  Python BatteryManager（"大脑"）
  校验 → 推导 → 冲突检测 → 状态管理
     │
     ▼
  前端 UI（"仲裁者"）
  null 槽位 → 弹出手动输入，不回推 LLM
     │
     ▼
  constants.h（交给 C++ 仿真引擎）
```

### 核心原则：LLM 是"耳朵"，Python 是"大脑"

LLM 天生概率性、不稳定，不适合做精确计算。本系统的设计哲学是：

- **LLM 只负责一件事**：把非结构化语言映射到预定义的 JSON 槽位。凡是没有明确说出来的数字，一律填 `null`，绝不猜测、绝不计算。
- **Python 负责所有逻辑**：数学推导、冲突检测、状态持久化。这些操作是确定性的，结果唯一可验证。
- **UI 负责兜底**：当 LLM 填不上的槽位出现，直接让用户点选，不反复追问 LLM（节省 token，避免幻觉叠加）。

---

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Python 3 + Flask + flask-cors |
| LLM 接入 | anthropic SDK / openai SDK / google-genai SDK |
| 前端 | 原生 HTML + CSS + JavaScript（无构建工具） |
| 数据持久化 | 浏览器 localStorage（Key 管理）|
| 部署 | 本地单机，Flask 同时托管前端静态文件 |

---

## JSON 协议

LLM 输出严格遵循以下结构（来自 EMIOT.pdf 规范）：

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
    "pattern": "standard | with_gaps | fully_filled",
    "details": "8x8 grid"
  },
  "llm_reasoning": {
    "missing_info": ["cells_per_group", "cooling_type"],
    "assumptions_made": "User mentioned water cooling. Max_Temp < 45°C."
  }
}
```

**三种 intent：**
- `custom`：全新配置，LLM 列出所有缺失槽位，Python 先清空状态再写入
- `template`：按名称查模板库，Python 匹配后整体填入，LLM 提取的覆盖值优先
- `update`：只改用户提到的槽位，其余保持不变（增量更新）

---

## Python BatteryManager 核心逻辑

### 确定性数学推导

```python
# 已知总数和组数 → 推导每组数量
if total and groups and cells_per_group is None:
    if total % groups == 0:
        cells_per_group = total // groups   # 整除才推导，有余数报错

# 已知组数和每组数 → 推导总数
elif groups and cells_per_group and total is None:
    total = groups * cells_per_group
```

LLM 做除法可能出错（100/3 可能给出 33），Python 用整除运算保证精确，余数情况明确报错。

### 冲突检测

```python
if total and groups and cells_per_group:
    if total != groups * cells_per_group:
        # 触发红色警告，不自动"修正"，保留用户原始意图
        conflicts.append(f"total_cells ({total}) ≠ {groups} × {cells_per_group}")
```

冲突不自动修复——用户说了什么就记录什么，由用户决定哪个数字是对的。

### 状态机管理

```
custom  → 清空所有槽位 → 填入新值 → 推导 → 冲突检测
template → 整体替换 → 覆盖用户指定的值 → 推导 → 冲突检测  
update  → 只更新提到的槽位 → 推导 → 冲突检测
```

会话历史由 Python 维护，LLM 每次只处理当前消息，不依赖其记忆上下文长度。

---

## 模糊输入时 Suggestion 的来源

当用户只给出性能目标而没有具体参数时（如"100A 放电不过热，温度低于 45°C"），系统会进入以下流程：

### Step 1：LLM 提取约束，不填参数

System Prompt 明确禁止 LLM 猜测物理参数，它只提取到：
```json
"assumptions_made": "Constraint: Max_Temp < 45°C, Discharge = 100A"
```
所有 `simulation_parameters` 均为 `null`。

### Step 2：Python 解析约束

用正则从 `assumptions_made` 字符串中提取结构化约束：

```python
def _parse_constraints(self, text):
    constraints = {}
    m = re.search(r"(\d+\.?\d*)\s*°?\s*[Cc]", text)
    if m: constraints["max_temp"] = float(m.group(1))   # → 45.0

    m = re.search(r"(\d+\.?\d*)\s*A\b", text)
    if m: constraints["current"]  = float(m.group(1))   # → 100.0
    return constraints
```

### Step 3：触发模板推荐

Python 检测到：所有数值槽位为 `null` + 存在性能约束 → 判断用户处于"性能导向"场景，推荐模板库中的配置供用户选择：

```python
numeric_all_null = all(self.state[k] is None for k in ALL_NUMERIC_SLOTS)
if numeric_all_null and constraints:
    suggestions = self.templates[:4]   # 当前返回前4个模板
    # 实际工程中可接入仿真数据库，按约束过滤
```

### Step 4：用户点击模板 → 闭环

用户从右侧卡片点击模板，Python 整体填入参数，缺失项继续由 UI 提示手动补全。整个过程**不再消耗额外 LLM token**。

### 为什么不让 LLM 直接推荐？

- LLM 不知道模板库里有什么，容易幻觉出不存在的配置
- 推荐逻辑应该是确定性的（按约束过滤数据库），而非概率性的
- Python 的推荐结果可验证、可追溯

---

## 文件结构

```
Energy_LLM/
├── backend/
│   ├── app.py              # Flask API（9个端点）
│   ├── battery_manager.py  # 核心状态机逻辑
│   ├── templates_db.json   # 预置模板库（Tesla/Nissan/BMW等）
│   └── requirements.txt
├── frontend/
│   ├── index.html          # 双栏主界面
│   ├── style.css           # 深色主题
│   └── app.js              # 前端逻辑 + Key 管理
├── start.bat               # Windows 一键启动
├── start.sh                # macOS / Linux 一键启动
└── EMIOT.pdf               # 原始架构设计文档
```

---

## 扩展模板库

编辑 `backend/templates_db.json`，按以下格式添加：

```json
{
  "name": "My Custom Pack",
  "keywords": ["my pack", "custom"],
  "description": "简要描述",
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
  }
}
```

冷却类型映射：`0=S-type`，`1=C-type`，`2=SS-type`，`3=E-type`
