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

- `reg-codex-home-install-context` — The discovered installation layout, CODEX_HOME location, bundled assets, helper binaries, and machine-local installation facts shared across startup and maintenance flows.
- `reg-plugin-and-skill-catalog` — The resolved plugin, marketplace, hook, and skill configuration plus loaded skill/plugin metadata shared across startup, prompt assembly, and execution.
- `reg-model-catalog` — The merged bundled, cached, local-provider, and remotely fetched model inventory and presets used for picker, routing, and turn execution.
- `reg-token-store` — The persisted token payloads, JWT/account metadata, and revocation/restore state backing login and whoami behavior.
- `reg-sandbox-user-credentials` — The Windows sandbox local-account and protected-credential state used to run isolated commands safely.
- `reg-state-runtime` — The shared SQLite-backed runtime handle and opened databases that provide durable local state services to higher layers.
- `reg-rollout-and-thread-store` — The durable rollout transcript and thread-store persistence layer used for resume, reconstruction, metadata sync, archive, and repair.
- `reg-thread-metadata-index` — The structured thread metadata, reconciliation, spawn-edge, and listing state maintained in SQLite for thread ownership and browsing.
- `reg-cloud-config-cache` — The cached and refreshable cloud-configuration bundle state used to hydrate startup policy and remote-backed settings.
- `reg-connector-catalog` — The refreshed connector/app directory and workspace enablement state that determines which integrations are visible and usable.
- `reg-update-metadata` — The cached release/update availability state used by doctor, TUI startup, and daemon-managed updater flows.
- `reg-remote-control-state` — The persisted and live remote-control desired state, pairing/enrollment records, and reconnecting remote-session state.
- `reg-agent-job-pipeline` — The persisted and live background workflow state for agent-job batches, worker progress, and other longer-lived asynchronous pipelines.
- `reg-memory-pipeline-state` — The durable and runtime state for memory extraction/consolidation jobs and filesystem-backed memory artifacts.
- `reg-runtime-log-store` — The durable runtime log and feedback artifact store used for diagnostics, support capture, and later investigation.
- `reg-goals-store` — The persisted and live per-thread goal state, including current goals and related structured goal metadata surfaced in sessions and UI.
- `reg-core-plugin-snapshot-cache` — The locally cached curated core-plugin snapshot and shared-plugin path mapping reused across startup sync, plugin resolution, and offline/runtime reads.
- `reg-remote-catalog-caches` — Persistent local caches for fetched remote catalogs such as connectors, models, and plugin/marketplace metadata that survive restarts and seed startup hydration.
- `reg-backfill-lease-state` — The durable coordination/lease state for one-time or resumable metadata backfills and startup repair work that blocks or gates higher-level initialization.
- `reg-import-tracking-state` — The persistent record of previously imported external-session sources and their normalized ingestion outcomes used to avoid duplicate imports and support resume/inspection.
- `reg-message-history-log` — The separate append-only global message-history file/state that records cross-session message history outside per-thread rollout storage.
- `reg-local-secrets-store` — The encrypted local secrets persistence used to retain sensitive integration or runtime secrets across startup and execution flows.
- `reg-agent-graph-store` — The durable graph of thread spawn relationships and lifecycle edges exposed independently of live thread metadata for agent-tree queries and teardown consistency.
