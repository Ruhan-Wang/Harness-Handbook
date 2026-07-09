# Frontend session startup and user-facing initialization  `stage-9`

This stage is where initialized backend services become an actual frontend session. It sits after core/runtime startup and before either the long-running interactive main loop or the one-shot scripted execution path, translating prepared services into a user-visible interface with the right session context, terminal state, and startup decisions.

The TUI startup, onboarding, and terminal ownership sub-stage is the interactive entry path. It loads frontend configuration, connects to or creates the app-server session, initializes terminal integration and logging, and decides whether startup must pause for onboarding or other prompts such as provider selection, trust review, updates, migration, resume choice, or working-directory confirmation. It then claims terminal ownership, enables the needed keyboard/input modes, configures notifications and suspend/resume behavior, and constructs the initial visible chat state before handing control to the steady-state TUI loop.

The exec-mode and scripted session startup sub-stage serves non-interactive use. It builds a single request from CLI inputs, starts the supporting app-server/runtime pieces, resolves resume or fork metadata when needed, runs the session to completion, and emits structured or final output. Together, these paths provide the ready user-facing surface for both interactive and scripted frontends.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-installation-context` — The discovered installation and host context, including CODEX_HOME, bundled assets, helper binary locations, host identity, and local machine/shell facts.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved startup and runtime feature enablement state used to gate behavior, APIs, and experimental surfaces.
- `reg-model-catalog` — The merged model/provider catalog and preset metadata built from bundled, cached, local, and remote sources.
- `reg-thread-metadata-store` — The durable thread metadata and reconciliation state that bridges rollout history into resumable thread records.
- `reg-update-state` — The cached release and update availability state used by TUI, doctor flows, and daemon-managed updater behavior.
- `reg-frontend-session-state` — The user-facing frontend session state, including startup decisions, terminal ownership, visible chat state, and interactive UI context.
- `reg-live-session-object` — The long-lived session runtime object that owns turn submission, event delivery, approvals, context construction, and runtime services for a thread.
- `reg-runtime-log-store` — The durable runtime log and feedback artifact store used for diagnostics, support capture, and postmortem inspection.
- `reg-prewarmed-session-state` — The startup prewarm/warmup state cached on sessions so early initialization work can be reused by the first and subsequent turns instead of recomputing it.
- `reg-resume-and-fork-lineage` — The persisted and live thread/turn lineage state used to resolve resumes, forks, spawn edges, and related ancestry across session startup, orchestration, and teardown.
- `reg-config-migration-state` — The persistent config-migration/import bookkeeping that tracks applied migrations and safe updates across startup config loading and later writes.
