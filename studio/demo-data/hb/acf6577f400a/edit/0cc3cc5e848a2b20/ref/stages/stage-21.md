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

- `reg-plugin-catalog` — The resolved plugin and marketplace catalog, including local editable config and refreshed curated plugin snapshots.
- `reg-token-store` — The persisted credential payloads and parsed token/account metadata used to restore, refresh, and revoke authentication.
- `reg-state-runtime` — The shared SQLite-backed local state runtime that owns database handles, migrations, paths, integrity checks, and orderly shutdown.
- `reg-thread-metadata-store` — The durable thread metadata and reconciliation state that bridges rollout history into resumable thread records.
- `reg-cloud-config-cache` — The cached and refreshable backend-delivered cloud configuration bundle used during startup and later policy reads.
- `reg-connector-catalog` — The normalized remote connector and app directory, including workspace enablement and visibility decisions.
- `reg-core-skills-catalog` — The loaded and invalidatable skill catalog and associated enablement state used for prompt injection and runtime selection.
- `reg-update-state` — The cached release and update availability state used by TUI, doctor flows, and daemon-managed updater behavior.
- `reg-remote-control-state` — The persisted and live remote-control enrollment, pairing, desired-state, and reconnecting session state.
- `reg-agent-registry` — The in-memory registry of active agents and spawn reservations, including concurrency limits, nicknames, residency, and per-thread agent metadata.
- `reg-background-jobs` — The durable and live background-work coordination state for memory jobs, agent-job batches, backfill leases, and other asynchronous pipelines.
- `reg-rollout-history` — The durable transcript and rollout record stream that captures session events, tool output, and resumable conversation history.
- `reg-runtime-log-store` — The durable runtime log and feedback artifact store used for diagnostics, support capture, and postmortem inspection.
- `reg-goals-and-memory-state` — The persisted and live thread-scoped goals, memory mode, and memory artifact state that feed prompt assembly, background memory processing, and user-visible thread settings.
- `reg-external-session-import-state` — The durable import tracking state for previously seen external session sources and normalized imported records used during ingestion and resume-related workflows.
- `reg-message-history-log` — The separate global append-only message history file/store that preserves cross-session message history outside per-thread rollout transcripts.
- `reg-secrets-store` — The local encrypted secrets persistence used to retain sensitive non-token credentials and integration secrets across startup and runtime.
- `reg-plugin-installation-store` — The persisted local plugin content and shared-plugin path mapping state that tracks installed plugin files and their reusable filesystem locations.
- `reg-resume-and-fork-lineage` — The persisted and live thread/turn lineage state used to resolve resumes, forks, spawn edges, and related ancestry across session startup, orchestration, and teardown.
- `reg-skills-watcher-state` — The long-lived file-watch and invalidation state that monitors skill sources and triggers cached skill catalog refreshes across startup and background runtime.
- `reg-connector-plugin-workspace-settings` — The persisted and live workspace-scoped enablement/visibility settings that decide which connectors and plugins are exposed in a given workspace.
- `reg-config-migration-state` — The persistent config-migration/import bookkeeping that tracks applied migrations and safe updates across startup config loading and later writes.
- `reg-approved-command-prefixes` — The persisted and session-visible set of saved approved command prefixes that survives approval events and is reinjected into later prompt context.
