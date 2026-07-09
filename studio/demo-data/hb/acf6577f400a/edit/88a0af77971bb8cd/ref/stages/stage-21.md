# Cross-cutting persistence abstractions and data stores  `stage-21` (cross-cutting infrastructure)

This stage is the system’s shared persistence substrate: it sits underneath startup checks, the interactive conversation loop, background workers, import flows, and maintenance tasks, providing the durable stores and cache layers that let state survive restarts and be reused safely.

Its rollout and thread-store layer records live sessions as transcript files, reconstructs them on resume, and supports listing, searching, archiving, and deletion; the separate message-history file preserves a global append-only log. SQLite runtime state complements those files with structured metadata and coordination state: thread metadata and spawn edges, goals and budgets, memory-processing jobs, agent-job batches, backfill leases, import outcomes, logs, and remote-control enrollment. The agent-graph store exposes those persisted thread relationships through a storage-agnostic graph API.

Alongside core state, cache stores persist fetched cloud config, connector/model catalogs, remote plugin catalogs, shared-plugin path mappings, and TUI update state so higher layers can avoid unnecessary network work. Plugin, secrets, and memory file stores manage installed plugin contents, encrypted local secrets, and filesystem-backed memory artifacts. Finally, external-session import persistence tracks previously imported source files and parses external JSONL sessions into normalized records ready for ingestion.

## Sub-stages

- [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files
- [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files
- [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files
- [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files
- [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

## 📊 State Registers Touched

- `reg-installation-context` — The discovered installation layout, bundled assets, helper binary locations, and release/managed-install identity for this Codex install.
- `reg-codex-home` — The validated writable CODEX_HOME filesystem root used for shared local state, helper materialization, caches, logs, and databases.
- `reg-plugin-catalog` — The active plugin/marketplace catalog and locally synced plugin snapshot available for startup, prompt contributions, and tooling.
- `reg-secrets-store` — The persisted local secret and credential store used for auth restoration, protected execution credentials, and plugin/integration secrets.
- `reg-state-runtime` — The shared SQLite-backed state runtime handle that opens, migrates, checks, and shuts down the application's durable databases.
- `reg-thread-metadata-store` — The durable thread metadata and rollout-backed indexing layer used for listing, lookup, reconciliation, resume, and repair.
- `reg-cloud-config-cache` — The cached cloud-delivered configuration bundle and refresh state used during startup and background policy refresh.
- `reg-remote-catalog-caches` — The persistent caches for fetched model, connector, plugin, and update catalogs used to avoid unnecessary network refreshes.
- `reg-daemon-remote-control-state` — The persisted and live daemon/app-server remote-control enablement, pairing, enrollment, and reconnect session state.
- `reg-background-jobs` — The durable and live coordination state for longer-lived background workflows such as memory jobs, agent-job batches, backfills, and watchers.
- `reg-rollout-history-store` — The durable transcript/rollout store that records session events, reconstructs history on resume, and backs import/export operations.
- `reg-runtime-log-store` — The durable runtime log and feedback artifact store used for diagnostics, support capture, and later investigation.
- `reg-goals-store` — The durable and live per-thread goals state, including stored goals and related budgeting metadata that survive resume and feed prompt/context assembly.
- `reg-memories-state` — The persisted and runtime memory subsystem state covering memory records/artifacts, processing mode, startup guards, and memory-backed prompt contributions.
- `reg-message-history-log` — The global append-only message history file/store that preserves cross-session message history separately from per-thread rollout records.
- `reg-external-session-import-state` — The durable import tracking state for external sessions, including previously imported source files, parse results, and normalized ingestion outcomes.
- `reg-shared-plugin-path-mappings` — The persistent shared-plugin path mapping cache that remembers resolved local plugin content locations for reuse across startup and runtime.
- `reg-update-check-state` — The cached release/update metadata and probe state used by TUI, doctor, and daemon updater flows to decide whether and how upgrade UX or re-exec should occur.
- `reg-thread-store-archive-state` — The durable archive/unarchive and deleted/visible thread-state flags that determine which persisted threads appear in listings, resumes, and projections.
- `reg-agent-graph-store` — The durable spawn-edge graph and lifecycle state linking parent/child agent threads across runtime operation, resume, and shutdown.
