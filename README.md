# Gentle Shell Configuration Overlay

This repository provides an agent workspace overlay, extensions, subagent definitions, and configuration profiles for **Pi** and the **Gentle Shell / Gentle AI** ecosystem.

It is designed to be consumed as an overlay for personal or project-level Pi workspaces.

> **Important Architecture Note:**
> This repository is **not** installed inside CPAMC / CLIProxyAPI, and it is **not** a plugin of CLIProxyAPI. CLIProxyAPI is an independent, external HTTP model proxy service. This repository configures the Pi agent environment to optionally communicate with CLIProxyAPI and other providers.

---

## Architecture Overview

- **`agent/settings.json` & `agent/subagents.json`**: Workspace configuration defining active packages, themes, model assignments, and subagent profiles.
- **`agent/extensions/orchestrator-supervisor/`**: A standalone TypeScript extension providing `/supervisor` controls in Pi for context monitoring, safe session rotation via Engram, failover model selection, and automatic subagent lease assignment.
- **`agent/extensions/cliproxyapi-dynamic-provider.ts`**: An extension connecting Pi dynamically to models exposed by a local CLIProxyAPI server.
- **`agent/agents/`**: Specialist subagents for Organic Driven Development (ODD), 4R code reviews (Risk, Reliability, Resilience, Readability), and Judgment Day adversarial reviews.

---

## Prerequisites & Dependencies

### 1. Runtime
- **Node.js**: `>=22.0.0` (tested on Node `22.23.2` LTS).
- **Pi Coding Agent**: `@earendil-works/pi-coding-agent` (or `gentle-pi` package harness).

### 2. External Services
- **CLIProxyAPI (Optional / Supported)**:
  - Default local endpoint: `http://127.0.0.1:8317`
  - Required only if you use `cliproxyapi-dynamic-provider.ts` or CLIProxyAPI quota tracking in the supervisor.
- **Engram Memory (Optional / Supported)**:
  - Required for persistent session summaries and `supervisor_rotate` continuity checkpoints.

### 3. Environment Variables & Placeholders
- **`NAN_API_KEY`**: If using the default configured `nan` provider (`nan/deepseek-v4-flash`), provide your NaN API key.
- **`GENTLE_SUPERVISOR_RUNTIME_DIR`** *(optional)*: Override the directory used by `orchestrator-supervisor` for state, journals, and lock files. Defaults to `.runtime/` within the project.
- **`SUPERVISOR_TEST_PI_CLI`** *(optional)*: Path to the Pi binary for integration tests (defaults to `pi` in `PATH`).

### 4. Supported Platforms
- **Linux (POSIX - Fully Supported):** Full native feature set, atomic file locks with reboot detection via `/proc/sys/kernel/random/boot_id` and PID reuse protection via `/proc/<pid>/stat`.
- **Windows (Win32 - Supported via Platform Adapter):** Uses dedicated `win32Platform` adapter with uptime-derived boot identity, NTFS atomic rename retry loop, and `pi.cmd` CLI resolution.
- **macOS / POSIX (Supported with Limitations):** Locks operate with conservative fail-closed semantics; PID reuse detection is disabled due to the lack of `/proc`. See `agent/extensions/orchestrator-supervisor/README.md` for full contract details.

---

## Safe Selective Installation

**Do not blindly overwrite your existing global `~/.pi/agent/settings.json`.** Overwriting will discard your custom models, tools, and extensions.

Instead, merge components selectively into your target environment:

### Step 1: Extensions
Copy or symlink the extensions you want to use into your Pi extensions directory or register them in your `settings.json`:
- `agent/extensions/orchestrator-supervisor`
- `agent/extensions/cliproxyapi-dynamic-provider.ts`

### Step 2: Packages
Install the required packages declared in `agent/settings.json`:
```bash
npm install -g gentle-engram pi-web-access pi-btw pi-token-speed
```
Or add them to your `packages` array in `settings.json`:
```json
"packages": [
  "npm:gentle-engram",
  "npm:pi-web-access",
  "npm:pi-btw",
  "npm:pi-token-speed"
]
```

### Step 3: Subagents
Copy or link the desired agent definitions from `agent/agents/*.md` to your workspace or global `~/.pi/agent/agents/` folder.

### Step 4: Model Configuration
Adjust provider and model settings to match your accounts. The repository defaults to:
- `defaultProvider`: `"nan"`
- `defaultModel`: `"deepseek-v4-flash"`

If you use OpenAI, Anthropic, or CLIProxyAPI, adjust `settings.json` and `subagents.json` to point to your available model IDs.

---

## Verification

To verify that the extensions and dependencies function properly on your system, run the test suite:

```bash
cd agent/extensions/orchestrator-supervisor
npm test
```

This executes unit tests, concurrency and locking validations, tool bridge assertions, and lifecycle checks.
