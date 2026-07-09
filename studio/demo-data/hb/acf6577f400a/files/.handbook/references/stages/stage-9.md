# Frontend session startup and user-facing initialization  `stage-9`

This stage is where initialized backend services become an actual frontend session. It sits after core/runtime startup and before either the long-running interactive main loop or the one-shot scripted execution path, translating prepared services into a user-visible interface with the right session context, terminal state, and startup decisions.

The TUI startup, onboarding, and terminal ownership sub-stage is the interactive entry path. It loads frontend configuration, connects to or creates the app-server session, initializes terminal integration and logging, and decides whether startup must pause for onboarding or other prompts such as provider selection, trust review, updates, migration, resume choice, or working-directory confirmation. It then claims terminal ownership, enables the needed keyboard/input modes, configures notifications and suspend/resume behavior, and constructs the initial visible chat state before handing control to the steady-state TUI loop.

The exec-mode and scripted session startup sub-stage serves non-interactive use. It builds a single request from CLI inputs, starts the supporting app-server/runtime pieces, resolves resume or fork metadata when needed, runs the session to completion, and emits structured or final output. Together, these paths provide the ready user-facing surface for both interactive and scripted frontends.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-shell-environment-snapshot` — The captured shell snapshot and validated execution-environment objects used to reproduce local or remote command environments across sessions and executors.
- `reg-host-platform-facts` — Normalized host identity and platform probe results such as hostname, shell, locale, editor, pager, and cloud-environment facts reused by diagnostics and runtime decisions.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-model-catalog` — The merged bundled, cached, local-provider, and remotely fetched model inventory and presets used for picker, routing, and turn execution.
- `reg-auth-state` — The active authentication mode and loaded credential state selected from storage or environment, including refresh and mode restrictions.
- `reg-update-metadata` — The cached release/update availability state used by doctor, TUI startup, and daemon-managed updater flows.
- `reg-frontend-session-ui-state` — The user-facing frontend session state including startup decisions, terminal ownership, visible chat/transcript state, and loaded thread view.
