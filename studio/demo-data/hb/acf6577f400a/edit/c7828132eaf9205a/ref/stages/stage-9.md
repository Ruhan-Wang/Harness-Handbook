# Frontend session startup and user-facing initialization  `stage-9`

This stage is where the prepared backend finally becomes something a person can use. It sits at the handoff between setup and real work. Its job is to open the right kind of session, connect it to the already-started services, and make the user-facing surface ready.

One branch is the interactive terminal app, or TUI (text user interface). That startup path claims control of the terminal window, checks what the terminal can do, switches into the app’s full-screen style, and protects the screen from stray output. It also handles suspend and resume, window titles, alerts, and resizing. Before dropping the user into the main screen, it may run onboarding steps such as welcome, sign-in, provider choice, trust for the current folder, updates, migrations, imports, or choosing a past session to continue. Then it prepares the first visible chat widgets and status views.

The other branch is exec mode, the non-interactive “do one job and exit” path. It builds a session from command-line options, starts the same core services, restores session context if needed, runs the request-processing loop, and prints or saves the final result. Together, these paths turn backend machinery into a ready interface.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-cli-overrides` — The startup command-line options and argv-derived mode choices that keep influencing later configuration and runtime behavior.
- `reg-codex-home-and-install-context` — The discovered home folder, install layout, bundled asset paths, and helper binary locations that other parts of the app reuse.
- `reg-effective-config` — The final merged configuration built from defaults, managed settings, user and project files, thread settings, and command-line overrides.
- `reg-model-provider-and-catalog` — The current set of model providers, available models, and ready-to-pick presets the app can use.
- `reg-auth-session` — The saved sign-in state for the current user or install, including which auth mode is active and whether it is still valid.
- `reg-thread-metadata-store` — The durable index of thread records, metadata, archive status, and lookup helpers used across session management.
- `reg-conversation-thread-store` — The durable store for conversation history and thread logs that lets sessions resume and transcripts be rebuilt later.
- `reg-update-and-version-cache` — The remembered update-check and version information used to warn users and restart daemons when needed.
- `reg-frontend-ui-state` — The live user-interface state for the terminal or other frontends, including screens, widgets, titles, and visible status.
- `reg-onboarding-and-ui-preferences` — The small remembered choices that affect startup flow, such as welcome steps, selected providers, trust prompts, and resume choices.
- `reg-logs-and-debug-captures` — The saved logs, debug bundles, feedback attachments, and searchable local diagnostics kept for troubleshooting.
- `reg-path-alias-and-binary-dispatch-state` — The argv0-based dispatch and temporary PATH aliasing state that lets helper re-execs resolve the intended command behavior across startup and spawned helper runs.
