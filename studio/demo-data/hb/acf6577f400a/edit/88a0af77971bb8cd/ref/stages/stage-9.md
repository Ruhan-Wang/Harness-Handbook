# Frontend session startup and user-facing initialization  `stage-9`

This stage is where initialized backend services become an actual frontend session. It sits after core/runtime startup and before either the long-running interactive main loop or the one-shot scripted execution path, translating prepared services into a user-visible interface with the right session context, terminal state, and startup decisions.

The TUI startup, onboarding, and terminal ownership sub-stage is the interactive entry path. It loads frontend configuration, connects to or creates the app-server session, initializes terminal integration and logging, and decides whether startup must pause for onboarding or other prompts such as provider selection, trust review, updates, migration, resume choice, or working-directory confirmation. It then claims terminal ownership, enables the needed keyboard/input modes, configures notifications and suspend/resume behavior, and constructs the initial visible chat state before handing control to the steady-state TUI loop.

The exec-mode and scripted session startup sub-stage serves non-interactive use. It builds a single request from CLI inputs, starts the supporting app-server/runtime pieces, resolves resume or fork metadata when needed, runs the session to completion, and emits structured or final output. Together, these paths provide the ready user-facing surface for both interactive and scripted frontends.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-shell-snapshot` — The captured shell/local-machine session snapshot used to construct local execution environments and later cleaned up.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved startup and runtime feature enablement set that gates experimental and product capabilities.
- `reg-model-catalog` — The merged local/cached/remote model inventory and presets used for model selection, picker UX, and turn execution.
- `reg-auth-state` — The central authentication mode, persisted credentials, token-refresh state, and active identity selection for the current runtime.
- `reg-thread-metadata-store` — The durable thread metadata and rollout-backed indexing layer used for listing, lookup, reconciliation, resume, and repair.
- `reg-remote-catalog-caches` — The persistent caches for fetched model, connector, plugin, and update catalogs used to avoid unnecessary network refreshes.
- `reg-frontend-session-state` — The user-facing startup/session state for TUI and exec frontends, including onboarding/resume/startup decisions and visible chat initialization.
- `reg-telemetry-context` — The process/session/turn-scoped observability context used to stamp logs, traces, metrics, and analytics with stable runtime identity.
- `reg-runtime-log-store` — The durable runtime log and feedback artifact store used for diagnostics, support capture, and later investigation.
- `reg-update-check-state` — The cached release/update metadata and probe state used by TUI, doctor, and daemon updater flows to decide whether and how upgrade UX or re-exec should occur.
- `reg-prewarmed-session-state` — The live prewarm/warm-start state for a session that is created at startup and then reused by later turns to avoid rebuilding model/session execution scaffolding.
- `reg-terminal-ownership-state` — The process/session-level terminal mode and ownership state for claimed TTY input modes, suspend/resume handling, and later restoration.
- `reg-session-resume-selection-state` — The persisted and live resume/fork selection state that records which prior thread/turn/session lineage should be reopened or continued across startup and scripted execution.
