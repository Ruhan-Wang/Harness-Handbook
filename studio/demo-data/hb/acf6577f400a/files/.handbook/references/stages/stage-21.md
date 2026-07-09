# Cross-cutting persistence abstractions and data stores  `stage-21` (cross-cutting infrastructure)

This stage is the system’s long-term memory and filing system. It is shared support used throughout startup, normal work, recovery, and cleanup, rather than one single user-facing flow. Its parts save different kinds of information so the app can resume work, avoid repeats, and keep private data safe.

Rollout files and thread-store persistence keep conversation records: raw session logs, searchable indexes, live writers for active chats, and tools to list, rebuild, archive, or delete threads. SQLite runtime state and agent graph storage keep structured records in a small local database, such as thread summaries, goals, agent jobs, progress checkpoints, audit views, and “which agent started which thread.” Caches and local lookup files store reusable facts like cloud settings, connector lists, plugin catalogs, models, update notices, and local plugin paths, while checking age, account, and version before trusting them. Plugin, secrets, and memory stores manage installed plugins, encrypted secret values, and saved user memories. External session import persistence reads conversation files from other tools and keeps a ledger so the same outside session is not imported twice.

## Sub-stages

- [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files
- [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files
- [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files
- [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files
- [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-cloud-config-cache` — The cached and refreshed cloud-delivered configuration bundles that can alter settings, requirements, and available features.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-memory-store` — The saved long-term user memories and memory search results that can be loaded, updated, and inserted into future conversations.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-agent-registry-graph` — The live and persisted map of parent agents, child agents, thread names, statuses, and which helper agents are still open.
- `reg-background-work-queues` — The shared set of background tasks such as cloud refreshes, cleanup jobs, memory jobs, skill watchers, agent jobs, update checks, and session maintenance.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-goal-state` — The live and persisted user goals, goal progress, and goal-thread associations synchronized into prompts, storage, analytics, and UI indicators.
- `reg-update-check-state` — Cached update notices, downloaded-or-pending update metadata, and daemon restart/update status produced by update checks and consumed by UI or teardown restart logic.
- `reg-external-import-ledger` — The persisted ledger of external-agent sessions already imported, used to avoid duplicate imports and track import provenance.
- `reg-connector-directory-cache` — Cached ChatGPT/app connector directories, workspace connector settings, local connector metadata, and fallback lookup results used when exposing connectors to sessions and prompts.
- `reg-cloud-task-state` — Cloud task lists, task details, submission attempts, selected task environments, and polling/refresh status shared by cloud task commands and clients.
- `reg-project-trust-store` — Persisted and effective trust decisions for workspaces/projects that influence onboarding, permission assembly, sandbox behavior, and session startup.
- `reg-memory-write-safety-state` — Cached or in-flight safety decisions for whether proposed long-term memory writes should be allowed before they update the memory store.
