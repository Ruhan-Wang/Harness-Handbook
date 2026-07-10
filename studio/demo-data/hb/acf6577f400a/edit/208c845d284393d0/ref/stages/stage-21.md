# Cross-cutting persistence abstractions and data stores  `stage-21` (cross-cutting infrastructure)

This stage is the system’s shared storage layer: the shelves, filing cabinets, and indexes that many other parts use while the app is running. It is not just startup or shutdown code. Instead, it keeps important information safe, findable, and reusable across the whole life of the app.

One part stores conversations. Rollout files keep the raw transcript, while the thread store sits on top as a common front desk for writing, reopening, listing, searching, and deleting threads. Another part uses SQLite, a database stored in one local file, to remember runtime facts such as thread relationships, goals, jobs, memories, repair progress, and import history. The agent graph store gives a simpler view of thread spawn links by building on that same database.

Several small caches save downloaded lookup data like cloud settings, plugin catalogs, connector directories, model lists, shared plugin paths, and update UI state so the app can avoid repeated network work. Other stores manage local plugin files, encrypted secrets, and memory workspaces. Finally, external session import persistence remembers which outside session files were already seen and translates them into the system’s own message format.

## Sub-stages

- [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files
- [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files
- [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files
- [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files
- [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

## 📊 State Registers Touched

- `reg-codex-home-and-paths` — The canonical set of important local directories and file paths, such as the Codex home folder and related storage locations.
- `reg-plugin-and-connector-catalog` — The current merged list of plugins, connectors, marketplaces, and related metadata that the app can expose and use.
- `reg-credentials-and-secret-store` — The saved secrets and tokens, plus the secure local storage used to load and persist them.
- `reg-state-runtime` — The shared local database runtime that opens SQLite stores, runs migrations, and provides common persistence services.
- `reg-rollout-db-state` — The rollout and thread-state database layer used to find, reconcile, repair, and persist thread information over time.
- `reg-cloud-config-cache` — The cached server-delivered settings snapshot that startup loads, validates, refreshes, and reuses later.
- `reg-model-catalog-cache` — The saved copy of fetched model inventories so the app does not need to ask providers every time.
- `reg-plugin-sync-cache` — The locally refreshed snapshot of curated plugin and connector data used to avoid repeated startup fetches.
- `reg-update-state` — The known update and managed-version state used to inform startup, UI, and daemon replacement behavior.
- `reg-thread-history-store` — The persisted conversation history and thread metadata used when threads are reopened, forked, listed, or trimmed.
- `reg-agent-registry` — The live registry of active child agents, their names, limits, paths, and parent-child relationships within a session.
- `reg-background-job-state` — The tracked state of background workflows and delegated jobs that continue outside the foreground turn.
- `reg-thread-item-and-rollout-log` — The official saved record of thread items, rollout events, summaries, imports, archive state, and other durable conversation results.
- `reg-runtime-log-store` — The persistent local storage for runtime logs and related diagnostic records that can be reviewed later.
- `reg-caches-and-local-stores` — The family of shared local caches and stores for downloaded catalogs, plugin files, memory workspaces, and import-tracking data.
- `reg-memory-backend-state` — The live backing-store state for memory operations, including the selected memory backend/workspace used by memory tools and prompt contributors across turns.
- `reg-background-task-details-cache` — The cached task-detail records fetched from backend/cloud task services so apply flows, task views, and related startup checks can reuse them without refetching immediately.
- `reg-skills-watcher-state` — The file-watch and change-notification state for skills directories that powers background reload alerts and updated skill availability.
- `reg-migration-tolerance-state` — The database schema-version and forward-compatibility tolerance state that lets startup detect newer-applied migrations and continue safely.
- `reg-agent-graph-store` — The persisted store of parent-child thread spawn edges and lifecycle state used to reconstruct, query, and save the agent thread tree.
- `reg-memory-extraction-pipeline-state` — The queued and in-progress state for background memory-extraction/summarization workflows that derive memories from conversations over time.
- `reg-imported-external-session-dedupe-state` — The remembered set of already-seen external session imports and their translation bookkeeping so repeated imports do not create duplicates.
