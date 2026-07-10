# Cross-cutting persistence abstractions and data stores  `stage-21` (cross-cutting infrastructure)

This stage is the system’s shared long-term memory. It sits behind the main work and startup steps, and gives many different features a safe place to save things they will need later. Think of it as a mix of filing cabinets, indexes, and caches.

One part stores conversation threads in rollout files and a thread store. The rollout files are the raw session logs on disk, while the thread store gives the rest of the app a simpler way to create, read, search, archive, and delete threads. A separate message history keeps a global running record.

Another part uses SQLite, a small database kept in one file, to store runtime facts such as thread metadata, goals, agent jobs, memory-processing state, repair progress, and spawn relationships between agents.

Other pieces keep local caches so the system does not keep downloading the same cloud config, plugin catalogs, model lists, or update state. There is also storage for installed plugins, encrypted secrets, and memory workspace files.

Finally, import persistence remembers which outside session files were already brought in, and translates foreign session records into the format this system expects.

## Sub-stages

- [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files
- [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files
- [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files
- [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files
- [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

## 📊 State Registers Touched

- `reg-codex-home-and-paths` — The chosen home folder and other shared filesystem locations the app uses for config, caches, helpers, and data files.
- `reg-secret-store` — The saved local secret storage where tokens and other sensitive credentials are kept between runs.
- `reg-state-runtime` — The shared local database runtime that gives the rest of the system access to its SQLite-backed state services.
- `reg-rollout-state-db` — The higher-level thread and rollout state service built on top of local storage for looking up and repairing thread records.
- `reg-cloud-config-cache` — The last fetched signed cloud configuration bundle that is cached locally and refreshed in the background.
- `reg-plugin-catalog-and-snapshot` — The installed and refreshable plugin inventory the app uses to decide what extensions are available.
- `reg-update-state` — The app's remembered information about available updates and daemon/binary replacement status.
- `reg-thread-history-and-metadata` — The saved and reconstructed conversation history, thread metadata, and fork/rollback lineage for each thread.
- `reg-memory-state` — The app's saved long-term memory data and memory-processing state used to add relevant past information into new turns.
- `reg-goals-state` — The stored goals and related progress metadata attached to threads and shown across the session lifecycle.
- `reg-agent-mailboxes-and-background-jobs` — The queued messages and background work items used by multi-agent workflows, CSV fan-out jobs, and similar worker tasks.
- `reg-local-log-store` — The persisted local logs and tracing database used for diagnostics, replay, trimming, and bug-report capture.
- `reg-thread-store` — The long-term storage and index for creating, reading, listing, archiving, importing, and deleting conversation threads.
- `reg-message-history-store` — The global running message history store that keeps past conversation records outside any one live session object.
- `reg-import-dedup-state` — The remembered record of which outside session files have already been imported so work is not duplicated.
- `reg-memories-pipeline-jobs` — The background extraction/consolidation job state and work queue for the long-term memories pipeline across threads.
- `reg-managed-install-fingerprint` — The remembered managed-install version and executable fingerprint used to identify the current binary and drive update/replacement decisions.
- `reg-agent-graph-store` — The persisted graph of parent/child thread spawn relationships and lifecycle edges used to reconstruct multi-agent lineage across runs.
- `reg-plugin-and-skill-install-state` — The local installed-package state for plugins and skills, including materialized resources that survive across runs and feed runtime catalogs.
- `reg-cloud-tasks-state` — The cached task-list/detail/apply state and background refresh flow for cloud task operations exposed in the UI and clients.
- `reg-db-recovery-state` — The detected database-corruption/lock recovery state, including backup-and-rebuild progress and any pending recovery guidance from startup failures.
- `reg-compaction-artifacts` — The saved compacted-history artifacts and compaction bookkeeping that let long threads replace older context with summarized history across future turns.
- `reg-rolling-sandbox-logs` — The rolling daily log state for Windows sandbox command activity, recording starts, outcomes, and optional debug notes across runs.
- `reg-shell-snapshot-cache` — The cached captured shell export/alias/options snapshots reused to avoid re-probing shell environments across startup and session work.
- `reg-thread-truncation-and-rollback-state` — The persisted bookkeeping for effective-history truncation, rollback points, and rebuild decisions used to reconstruct the active thread after forks or rewinds.
