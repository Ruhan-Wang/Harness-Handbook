# Frontend session startup and user-facing initialization  `stage-9`

This stage is where the system stops being just “initialized in the background” and becomes something a person or script can actually use. It sits right after backend setup and just before the real work begins.

One path is the interactive text interface, or TUI. Its startup code loads settings, connects to the right service, starts logging, and decides whether to open a new session, resume an old one, or make a copy of one. If needed, it pauses for important first-run or safety questions, such as sign-in, folder trust, provider choice, or config import. In parallel, the terminal-integration pieces take control of the terminal window: they check what the terminal supports, switch it into the right modes, protect the screen, and make sure it can be restored cleanly after suspend or exit. Other helpers prepare shortcuts, notifications, chat widgets, titles, and replay of earlier session state.

The other path is exec mode for scripts and automation. It builds one session from command-line input, runs the event loop until done, and sends results out in readable machine-friendly logs. Session resume support lets either path continue or branch from saved work safely.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-effective-config` — The merged live settings the app actually runs with after combining user, project, managed, thread, and command-line inputs.
- `reg-feature-flags` — The current set of experimental and on/off feature switches that change behavior across the app.
- `reg-startup-policy` — The resolved startup rules for permissions, service tier, keymaps, project-root behavior, and related runtime policy choices.
- `reg-local-environment-snapshots` — Cached facts about the local machine and shells, like exported environment settings, aliases, OS details, and available tools.
- `reg-auth-state` — The current login mode and live credentials the app uses to prove who the user is to outside services.
- `reg-account-readiness` — The app's current picture of whether the signed-in account is usable, including token type, account details, and login status.
- `reg-model-catalog` — The current list of models and provider capabilities the app can offer for use.
- `reg-server-runtime` — The live app-server and daemon runtime state that tracks running server processes and how to reach them.
- `reg-frontend-session-bootstrap` — The startup-time user-facing session choice, such as whether to open, resume, branch, or copy a session.
- `reg-tui-ui-state` — The live terminal interface state for screens, widgets, notifications, titles, and replayed session display data.
- `reg-terminal-mode-state` — The terminal control state that tracks modes, screen protection, suspend handling, and clean restoration on exit.
- `reg-live-thread-registry` — The in-memory list of loaded conversation threads and their attached client/session runtime objects.
- `reg-environment-selection` — The chosen execution environment for a thread or session, including local or remote environment registration details.
- `reg-thread-projection-state` — The rebuilt client-facing picture of each thread, including visible items, notifications, status, summaries, and previews.
- `reg-exec-output-state` — The machine-readable exec-mode output stream state used to emit JSONL results and status updates for automation.
- `reg-telemetry-context` — The shared tracing and session-telemetry context that stamps logs, traces, and metrics with the right runtime identity.
- `reg-local-log-store` — The persisted local logs and tracing database used for diagnostics, replay, trimming, and bug-report capture.
- `reg-thread-store` — The long-term storage and index for creating, reading, listing, archiving, importing, and deleting conversation threads.
- `reg-onboarding-and-startup-prompts` — The pending first-run and safety-gating prompts shown during session startup, such as sign-in, folder trust, provider choice, or config import decisions.
- `reg-session-resume-and-branch-state` — The runtime state for resuming, cloning, or branching prior sessions, including the selected source session and replay/resume bookkeeping.
- `reg-user-config-edit-state` — The runtime state used to safely edit, migrate, import, and write user configuration while preserving layer integrity and reporting pending changes.
