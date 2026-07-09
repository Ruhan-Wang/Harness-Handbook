# Cross-cutting persistence abstractions and data stores  `stage-21` (cross-cutting infrastructure)

This stage is the app’s shared storage toolbox. It is not just for startup or shutdown. It supports the system all through normal use by remembering things on disk, in small databases, and in safe local files, so work can continue after a restart.

One part keeps conversation threads and message history. It writes sessions as durable log files, compresses older ones, keeps quick indexes for listing and search, and offers a thread-store interface so the rest of the app can read, write, search, or delete threads without caring about file details. Another part uses SQLite, a small built-in database, to keep runtime state such as thread metadata, goals, job queues, repair tasks, and links between related threads; the agent graph layer then makes those family links easy to query.

Other parts act as caches: they save downloaded configs, model lists, plugin data, and small UI choices so the app does not have to fetch them again every time. Separate stores manage installed plugins, protected secrets, and filesystem-based memory files. Finally, the import persistence pieces track outside session files already seen and read their records into the app’s format.

## Sub-stages

- [Rollout files and thread-store persistence](stage-21.1.md) `stage-21.1` — 19 files
- [SQLite runtime state and agent graph storage](stage-21.2.md) `stage-21.2` — 18 files
- [Caches and local persisted lookup data](stage-21.3.md) `stage-21.3` — 6 files
- [Plugin, secrets, and memory file stores](stage-21.4.md) `stage-21.4` — 9 files
- [External session import persistence](stage-21.5.md) `stage-21.5` — 2 files

## 📊 State Registers Touched

- `reg-codex-home-and-install-context` — The discovered home folder, install layout, bundled asset paths, and helper binary locations that other parts of the app reuse.
- `reg-plugin-and-skill-catalog` — The shared inventory of plugins and skills that are installed, enabled, and available to sessions and prompt building.
- `reg-state-runtime` — The shared local persistence runtime that holds open databases and storage handles used by the running app.
- `reg-thread-metadata-store` — The durable index of thread records, metadata, archive status, and lookup helpers used across session management.
- `reg-conversation-thread-store` — The durable store for conversation history and thread logs that lets sessions resume and transcripts be rebuilt later.
- `reg-remote-cloud-config-cache` — The cached copy of server-controlled configuration that is refreshed from the network and reused locally.
- `reg-plugin-sync-cache` — The locally cached plugin snapshot and installed-plugin records that startup sync and runtime reads share.
- `reg-update-and-version-cache` — The remembered update-check and version information used to warn users and restart daemons when needed.
- `reg-onboarding-and-ui-preferences` — The small remembered choices that affect startup flow, such as welcome steps, selected providers, trust prompts, and resume choices.
- `reg-agent-graph-store` — The durable record of parent-child and related-thread links between agents and conversations.
- `reg-background-job-queues` — The queued and running background work for jobs like memory extraction, CSV fan-out, repair tasks, and other long-running helpers.
- `reg-memory-store` — The stored long-term memories and memory files that can be updated in the background and reused in later turns.
- `reg-goals-store` — The persisted user or thread goals that sessions load, display, and carry into prompt assembly and history updates.
- `reg-rollout-event-log` — The detailed saved stream of raw session and turn events that can be replayed, reconstructed, and traced later.
- `reg-logs-and-debug-captures` — The saved logs, debug bundles, feedback attachments, and searchable local diagnostics kept for troubleshooting.
- `reg-helper-binary-materialization-cache` — The cached result of copying or preparing bundled helper binaries into reusable sandbox/bin locations so later runs can reuse them without rematerializing.
- `reg-skill-cache-and-watch-state` — The cached loaded-skill data plus watcher invalidation state that tracks when skill files change and cached skill rendering must be refreshed.
- `reg-import-dedup-state` — The persistent record of externally imported session files or records already seen so imports are not reprocessed repeatedly.
- `reg-connector-and-plugin-artifact-caches` — The local cached fetched connector/plugin metadata artifacts used to avoid refetching and to merge discovery results across startup and runtime.
- `reg-thread-load-repair-state` — The queued and persisted thread/state repair and reconciliation work used when saved metadata, rollout history, or databases need backfill or fixing.
