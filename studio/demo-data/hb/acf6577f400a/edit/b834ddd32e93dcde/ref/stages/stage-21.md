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

- `reg-codex-home-and-install-context` — The discovered home folder, install layout, bundled asset locations, and helper binary paths used across the app.
- `reg-config-manager-and-lockfile` — The shared service that serves the latest config and records the exact config snapshot a session used.
- `reg-model-provider-and-catalog` — The shared list of model providers, available models, and ready-to-pick model presets.
- `reg-plugin-catalog-and-snapshot` — The known plugins, hooks, marketplaces, and synced plugin snapshot available to the runtime.
- `reg-connector-and-app-catalog` — The merged list of external apps and connectors the system can use.
- `reg-skill-catalog-and-cache` — The loaded skills, their metadata, and cached skill data used for prompting and tool behavior.
- `reg-secret-store` — The protected local storage for sensitive credentials and other secrets.
- `reg-state-runtime` — The shared runtime object holding opened local databases and services for state, logs, goals, and memories.
- `reg-sqlite-datastores` — The app’s on-disk SQLite databases that keep runtime metadata, queues, goals, logs, and related records.
- `reg-thread-store-and-rollout-history` — The durable record of threads, conversation items, and rollout history that lets sessions be resumed and replayed.
- `reg-thread-metadata-index` — The searchable metadata index for threads, including names, archive state, links, and sync status.
- `reg-cloud-config-cache` — The fetched and cached server-controlled settings package that can refresh in the background.
- `reg-update-cache` — The cached information about available app updates and installed version status.
- `reg-agent-jobs-and-background-work` — The queued and running background workflows, helper-agent jobs, and startup maintenance work.
- `reg-memory-store-and-pipeline` — The stored memories and background memory-processing pipeline that extract and reuse important facts.
- `reg-rollout-trace-log` — The detailed saved raw event log that can later be replayed into a readable timeline.
- `reg-feedback-capture-store` — The saved bug-report packages, logs, diagnostics, and attachments collected for troubleshooting.
- `reg-cache-stores` — The shared on-disk caches for downloaded config, model lists, plugin data, updates, and small UI choices.
- `reg-import-tracking-store` — The record of outside session files that were already imported and how they map into the app’s format.
- `reg-goals-store-and-state` — The persisted and live per-thread goal data, including goal records shown in UI and reused across session resume and later turns.
- `reg-agent-graph-state` — The persisted and queryable parent/child graph linking threads spawned by agents, used to recover and manage thread families across runtime and shutdown.
- `reg-config-profile-selection` — The currently selected named configuration profile and its persisted profile-scoped UI/runtime choices reused across startup, config editing, and session creation.
- `reg-response-cache-and-request-dedup` — Shared cached/in-flight remote fetch state used to reuse or coalesce background refresh results such as model, cloud-config, connector, and update lookups across startup and later requests.
- `reg-session-resume-and-continue-state` — The remembered session/thread continuation choice and resume metadata used to restore prior conversations, onboarding handoff, and exec/session restart flows across startup and live session orchestration.
- `reg-feedback-upload-queue` — The queued and in-progress feedback/report submissions, including attachments prepared locally and later uploaded through shared backend/network infrastructure.
