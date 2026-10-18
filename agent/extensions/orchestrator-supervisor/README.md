# Standalone Gentle Shell supervisor

The supervisor rotates the parent session and selects its model automatically. `/supervisor` has two **state and configuration tabs**: **Orchestrator** preserves the existing parent controls; **Subagents** saves independent model preferences and assigns them to Gentle Agents RPC children. It has no action buttons or pause/resume controls. It uses the existing Pi registry, Engram tools and session APIs without modifying host settings, credentials, providers or subagent profiles.

## Configure it

1. Load the extension with `/reload` after current work has settled.
2. Open `/supervisor` in a trusted interactive parent session.
3. In **Orchestrator**, set **Enabled**, **Auto rotation** and **Auto model switch** independently.
4. Set the model count from **2 to 10**; the default is **5**. Assign the ordered model slots from Pi's chat-model catalogue using a two-stage selection: selecting a model opens a second effort menu displaying **Default** along with the model's host-proven supported reasoning efforts (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Confirming an effort persists the model ID and effort override atomically in a single write. Escape in the effort menu returns to the model picker without saving; Escape in the model picker closes it. Selecting an already assigned model allows adjusting its effort. Choosing **Default** removes only that model's override.
5. Adjust rotation/quota thresholds, retry limit, cooldown and polling interval. Changes save immediately and reach the running supervisor without another reload.
6. In either tab, highlight **Configuration source**: press ← for **Project**, → for **Global**, or Enter/click to switch. Each tab remembers its own choice for this project and shows its effective file path. Opening the panel does not change the source.

**Reasoning efforts and capability discovery:** Reasoning efforts are persisted per model ID in the selected configuration file (`modelEfforts` map in `supervisor.json` and `subagents.json`). There is no automatic migration: older files without `modelEfforts` remain valid and absent maps remain absent until an explicit effort is saved. Absent overrides preserve existing default runtime behavior (Orchestrator uses `high`, Subagents preserves host defaults), labeled as `Default`. The UI never calls providers or guesses capabilities from model names; unknown capabilities expose `Default` only. Clearing a slot (or pressing `d` in Subagents) immediately clears that slot position while preserving per-model overrides.

**Project** stores preferences in `<project-root>/.pi/orchestrator-supervisor/`; **Global** uses `<active-Pi-agent-dir>/orchestrator-supervisor/`, resolved by Pi's public `getAgentDir()` API and respecting `PI_CODING_AGENT_DIR`. There is no hardcoded global home path. Orchestrator can use Project while Subagents uses Global, or vice versa. Global edits affect other projects that explicitly select Global for that tab; unrelated projects retain their own source.

Until you choose a source, **Existing (unchanged)** preserves the previous runtime-backed preferences and defaults. Selecting a source loads that destination's complete settings, or defaults if absent: it does not copy, merge, delete or overwrite another source. Switching back restores that source's saved model list, including hidden slots. Source selection alone never acknowledges uncertain effects or clears a safety fault. Invalid destinations refuse selection without changing the current choice.

Project preferences resolve from the nearest Git root, including worktrees; without Git, the nearest existing `.pi` directory is used, otherwise the working directory. Runtime/session identities still use the original working directory. Source choices are local runtime metadata, not versioned preferences: another machine must explicitly select Project to use a checked-in preference file. Repositories must be trusted before the panel or child assignment consumes project settings. Read-only destinations report write errors rather than silently saving elsewhere.

Use Tab or Shift+Tab to switch tabs, or click a tab. Use ↑↓ and Page Up/Page Down to navigate, ←→ or the displayed `[-]`/`[+]` controls to adjust values, Enter to edit a slot or flip a switch, and Escape to close. Slot pickers support filtering and keyboard navigation. Opening or switching tabs does not write settings, select a model or start a chat turn.

### Subagents: saved preferences and automatic child assignment

1. Switch to **Subagents**.
2. Set **Enabled** to assign selected models automatically inside Gentle Agents children. A fresh project starts disabled.
3. Set **Model count** between **2 and 20** (default **5**).
4. Assign a different Pi chat model to each slot. Each successful edit saves immediately to the actual per-project `subagents.json`; closing and reopening the panel restores it.
5. Highlight a Subagents slot and press **d** to clear only that position, without moving the other models. The empty position is saved and can be reassigned later. Pressing d on an empty slot or a non-slot row does nothing; inside the picker it remains filter text. Orchestrator has no d shortcut.

The picker uses Pi's registry directly, so multiple models from the same account remain selectable. Identity is the full `provider/modelId`: different account routes are distinct models, and the same model cannot occupy two subagent slots, including hidden saved entries. Orchestrator may independently use the same model. When editing a subagent slot, the picker hides models assigned to any other subagent slot, including hidden saved entries; the current slot's model remains visible. Clearing or replacing a selection makes the released model available again. Decreasing the count hides entries without deleting the full saved list; increasing it restores them. Empty slots are not filled automatically.

**Assignment is extension-owned, not a core modification.** When enabled, a marked Gentle Agents RPC child uses public `pi.setModel` before its first request. It selects the available configured model with the fewest active leases; ties rotate, and busy models may be shared without waiting. Only the first `modelCount` slots participate, with empty positions skipped. It never changes the parent model, host profiles, retry policy or quotas.

If `subagents.json` is invalid, Subagents reports the error and refuses edits instead of overwriting it. Orchestrator remains accessible and its configuration is untouched.

### Stored models versus active models

`priorityCandidateIds` is the full saved ordered model list. `modelCount` controls how many entries participate: **only the first N saved models**, in their saved order.

| Saved list | Count | Automatic selection |
| --- | --- | --- |
| Ten models | 2 | First two |
| Same ten models | Change to 4 | First four; the other six remain stored |
| Same ten models | Change back to 2 | First two; the full list remains stored |
| Two models | 4 | Only the two saved models; nothing is added automatically |
| Empty | Any valid count | No automatic model selection until you assign models |

Changing the count never truncates or reorders the saved list. Hidden entries remain stored when you edit a visible slot. A model cannot occupy two slots, including hidden ones. An unavailable saved model is not replaced with an unselected model.

Models come from Pi's live chat registry (`getAvailable()`, falling back to `getAll()`). CLIProxyAPI account metadata enriches registered routes with supported quota checks; it does not add models absent from Pi. There is no separate enabled-model list or routing-preferences file controlling selection.

## Automatic behavior

| Setting or condition | Behavior |
| --- | --- |
| Enabled off | Stops supervisor automation for this project; settings and saved models remain intact. Ordinary user tools are unaffected, except genuine uncertain-effect safety fences. |
| Auto rotation on | At the configured measured context threshold, asks the agent to checkpoint and rotate. Estimated or unavailable usage does not trigger it. |
| Auto rotation off | Disables the threshold trigger, not the context safety ceiling or an explicitly requested rotation through the agent. |
| Auto model switch on | Selects an eligible active-slot model on fresh startup/new sessions, including rotation, before the continuity turn. Handles provider failures and recovery within those selected models. |
| Auto model switch off | Does not change the model automatically; an interrupted provider-recovery obligation remains pending until re-enabled. |
| Normal prompt, reload or inventory poll | Does not replace the current model just because a preferred slot becomes available. A manual mid-session model outside the selection stays protected from automatic failover. |
| No eligible selected model | Reports that selection is unavailable; never chooses a model outside the active saved prefix. |
| Escape / agent interruption | Cancels the interrupted response's retries, recovery obligation and pending handover without creating a persistent user pause. It does not restart cancelled work on restored quota. |

User order decides between eligible slots. A model without a supported quota protocol yields to an eligible verified slot below it and is otherwise a fallback. Codex requires both quota windows below the configured threshold; Gemini requires positive remaining quota. Cooldowns, rejected credentials, missing quota proof and exclusions remain safety constraints, not permission to choose an unselected model.

Transient provider failures retry the current selected model. The configured consecutive-failure limit starts its cooldown and selects another eligible model. If none is available, polling can resume **only** the response actually interrupted by a provider error. Completed work, new user input, manual model selection, disabling the supervisor and agent interruption do not create background prompts.

The table above applies only to **Orchestrator**. Subagent assignment is separate:

| Condition | Child behavior |
| --- | --- |
| Marked Gentle Agents child (`GENTLE_PI_AGENTS_CHILD=1`) in RPC mode | Reads Subagents settings for its own working directory and reserves a selected available chat model before its first request. The extension must be loaded in that child. |
| Parent or ordinary RPC session | No subagent assignment hooks or model changes. |
| Disabled or empty active list | Keeps the existing host model without writing pool state. |
| Selected models missing from the child's startup catalogue | Awaits the public registry refresh for the selected providers, bounded to 15 seconds, then rechecks authenticated chat-model availability. Uses the host's network/offline policy; never forces network access or falls back to unverified models. |
| Active turn, including automatic continuations after `agent_end` | Holds its lease; no mid-request switching or quota failover. |
| `agent_settled` or session shutdown | Releases the lease. A later turn allocates again using the latest settings. |
| Invalid config, unavailable selected models, catalogue refresh failure/timeout, pool lock/storage error or rejected model | Reports a diagnostic and retains the existing host model; never substitutes an unselected model. Catalogue errors/timeouts report `Subagent model assignment skipped: the selected provider catalogue could not be refreshed`. Settle/shutdown aborts pending readiness without applying a late assignment. |

Leases are per project and process/session, not exclusive capacity or provider quota. Crashed processes are pruned only when the OS proves they no longer exist; uncertain liveness remains counted. Lock failures are bounded and reported, never force-recovered. The parent launch profile and initial metrics may still show the host's configured launch model; the child's RPC `get_state` reports the effective selected model. No provider request is needed to verify startup assignment.

## Ask the agent to rotate

There is no rotate button in the panel. Ask the agent to rotate when needed, or let the configured context threshold request it automatically.

The model-callable `supervisor_rotate` tool takes a concise 150–250-word `summary`, or an existing positive `memory_id` for an Engram `session_summary`. Optional `continue_task` defaults to false. Include the exact authorized goal and limits, completed and pending work/checks, task-file pointers, environment state, and the next authorized step; do not copy whole task files or transcripts. Maximum summary/readback length is 12,000 characters.

The tool:

1. Checks that subagents/jobs are settled and their completion notices are delivered.
2. Saves the checkpoint through existing `mem_save`, verifies the exact `mem_get_observation` readback, and checks the work fences again.
3. Dispatches the private token-bound handover immediately. Pi opens a fresh session and invalidates the outgoing context.
4. Starts exactly one continuity turn. With `continue_task: true`, it resumes unfinished already-authorized work; with false, it reports the pending/blocked state and waits.

At the rotation boundary, call the tool once and make no further tool calls in the outgoing turn. The checkpoint is historical context, never new consent for publishing, destructive operations, review grants or unrelated work. Active jobs are not killed to force rotation. Missing/unsupported work-status responses defer rotation rather than guessing.

`/supervisor` is the only user-facing command. `/supervisor-rotate <token>` exists solely as the private verified tool handover; do not invoke it manually.

## Safety and recovery

Interrupted mutations remain journalled and block new writes and rotation until their effects are inspected. Read-only inspection stays available. Switching off, reload, or opening the panel never acknowledges uncertain effects. If enabling the supervisor requires acknowledgement, inspect the reported effects first and explicitly confirm enabling; this is not an action row in the panel.

Background deliveries retire only when matching structured completion evidence is present on the current session branch. A terminal work status or empty work list alone is insufficient. A cancelled subagent can be retired from the host's exact matching status because no completion notice can arrive; unverifiable obligations remain pending. Strict fences can defer rotation indefinitely for active servers or missing completion notices.

Legacy pause/cancel flags and separate model-routing preferences no longer control the supervisor. Existing production files are not deleted or rewritten merely to remove those controls. Journal corruption, failed handover validation, rejected credentials and uncertain effects are still reported honestly; removing a pause feature does not bypass safety faults.

## Configuration and storage

Preferences have three storage locations; only Project/Global are selectable new destinations:

| Source | Preference directory |
| --- | --- |
| Existing (unchanged) | Original `.runtime/<cwd identity>/` (or `GENTLE_SUPERVISOR_RUNTIME_DIR`), until the first explicit selection. |
| Project | `<project-root>/.pi/orchestrator-supervisor/` (using Pi's project directory name). |
| Global | `<active-Pi-agent-dir>/orchestrator-supervisor/`, never relative to the extension installation. |

Each directory may contain independent `supervisor.json` and `subagents.json` files. The selected file is authoritative; fields are never merged across sources. Preferences use locked atomic private writes. Runtime documents remain under `.runtime/<identity>/` (or `GENTLE_SUPERVISOR_RUNTIME_DIR`):

| File | Contents |
| --- | --- |
| `supervisor.json` | Orchestrator preferences at the selected location (legacy runtime location until explicit selection): `enabled`, `autoRotate`, `autoSwitchModel`, `modelCount`, full `priorityCandidateIds`, optional per-model `modelEfforts`, thresholds, retries, cooldown and polling. |
| `subagents.json` | Version 1, `enabled`, `modelCount` (2–20), ordered `priorityCandidateIds` with unique nonempty model IDs, optional per-model `modelEfforts`. Empty strings preserve vacant slot positions. Defaults: disabled, count 5, empty list. |
| `subagent-pool.json` | Version 1 runtime leases (opaque token, model, PID, session, timestamp) and tie-rotation counters. Always runtime-backed, even when preferences are global/project-local. Not user preferences; invalid state is reported without overwriting. |
| `supervisor-scope.json`, `subagents-scope.json` | Independent version-1 source choices (`project` or `global`) keyed by project root in runtime storage. Invalid metadata fails closed for the affected tab and is never silently replaced. |

Session locks, mutation journals and session state are not relocated. Project configuration writes may briefly create `.lock` and private `.tmp` files beside preferences; successful writes clean them up. The extension does not modify `.gitignore`.

This runtime `subagents.json` is **not** `agent/subagents.json`: the latter is the host's existing per-agent model profile configuration and is not modified. Panel saves use locked atomic writes with private permissions; rejected edits leave saved configuration unchanged.

A missing file uses documented defaults: enabled, both capabilities on, count 5, rotation threshold 90%, Codex quota threshold 95%, three consecutive failures, 15-minute cooldown and 60-second polling. A missing `modelCount` in an older valid file defaults to 5 without trimming its model list. Invalid configuration fails closed and is reported, never silently reset or overwritten. Writes use private atomic files and locks.

| Environment variable | Purpose |
| --- | --- |
| `GENTLE_SUPERVISOR_DISABLED=1` | Disable runtime initialization. |
| `GENTLE_SUPERVISOR_RUNTIME_DIR` | Override runtime storage, legacy preferences and per-project source-choice metadata; does not relocate explicitly selected Project/Global preferences. |
| `PI_CODING_AGENT_DIR` | Pi's active agent directory override, honored for Global preferences through the host resolver. Without the host API, only an explicit override is accepted; no global default is guessed. |
| `CLIPROXYAPI_BASE_URL` | Existing management endpoint; default `http://127.0.0.1:8317`, normalizing a trailing `/v1`. |
| `CLIPROXYAPI_MANAGEMENT_KEY` | Existing management credential inherited from the environment. |
| `CLIPROXYAPI_API_KEY` | Existing fallback credential inherited from the environment. |
| `PI_NTFY_URL` | Optional notification endpoint. Failure never affects safety or authority. |

The extension does not read `.env` or credential files. Session state, mutation journal and lock stay in the extension runtime. Supervisor configuration is scoped by canonical project identity. Corrupt journal/state is never silently erased.

## Verification

```sh
cd ~/.gentle-shell/agent/extensions/orchestrator-supervisor
npm test
```

Tests exercise current functionality through configuration APIs, real panel components with injected TUI primitives, the extension's public hooks/tool, isolated temporary state and mock quota servers. Child assignment coverage includes concurrent pool coordination, lease ownership/cleanup, mocked lifecycle races and actual offline Pi RPC startup with a registry-only provider (no model requests). The RPC test needs `pi` on PATH, or an explicit `SUPERVISOR_TEST_PI_CLI` executable. Coverage includes both tabs, real subagent JSON assignment and reopen, unique saved model validation, count boundaries, independent Orchestrator state, saved-list preservation, ordered selected-model routing, capability switches, provider recovery, immediate handover with one continuity turn, incoming-session validation, mutation fences and completion delivery. Tests of removed pause/action/routing-toggle functionality are not retained as compatibility behavior.

Mock tests do not prove live provider quotas, notification delivery, terminal appearance or a production TUI handover. Those limits must be reported separately from suite results. Earlier cleanup evidence is tracked in `odd/tasks/configuration-only-panel.md`; the separate Subagents configuration work is tracked in `odd/tasks/subagent-configuration-panel.md`, and extension-owned assignment in `odd/tasks/subagent-model-assignment.md`.
