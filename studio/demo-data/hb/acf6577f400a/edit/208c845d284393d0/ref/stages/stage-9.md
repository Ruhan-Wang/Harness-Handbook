# Frontend session startup and user-facing initialization  `stage-9`

This stage is where the program stops being just a prepared backend and becomes something the user can actually use. It is the last step of startup for the frontend: either a live text interface opens, or a one-shot command runs and exits.

One part starts the TUI, the text-based screen interface. It loads settings, connects to the already started background services, and finds or resumes the right session. Before the main screen appears, onboarding can ask first-run questions like sign-in, folder trust, or approval choices. At the same time, terminal setup pieces test what the terminal can do, switch it into the right modes, manage keyboard behavior, protect the display from stray output, handle resize and suspend/resume, and choose titles and notifications. Extra startup pieces fill in the first screen so it feels complete, with chat state, history, status hints, and similar visible details.

The other part covers exec mode, the non-interactive path. It builds a session from command-line options, can resume saved work, runs the job to completion, and sends results to normal output or structured JSONL logs for scripts.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-cli-launch-context` — The shared record of how this process was started, including command-line options, chosen mode, argv[0] behavior, and startup environment tweaks.
- `reg-effective-config` — The final merged settings built from all config layers, giving the rest of the app one resolved playbook to follow.
- `reg-config-layer-stack` — The ordered stack of raw config sources and layer identities that can be read, explained, edited, and saved later.
- `reg-feature-flags` — The set of optional or experimental features that are currently enabled for this run.
- `reg-auth-state` — The live signed-in state, including which auth mode is active and whether credentials are ready, expired, or refreshed.
- `reg-server-process-state` — The shared runtime state of the app server or daemon, including whether it is running, reachable, and how clients find it.
- `reg-frontend-session-selection` — The choice of which saved or new session/thread the UI or exec path should open, resume, or create.
- `reg-terminal-ui-state` — The live text-interface state for terminal capabilities, screen mode, visible panels, notifications, and startup/onboarding progress.
- `reg-exec-run-state` — The runtime state for one-shot exec jobs, including session setup, streaming outputs, and structured JSONL event emission.
- `reg-user-visible-thread-projection` — The computed user-facing thread view, including transcript history, status lines, tool activity, goals, agent views, and exec output.
- `reg-startup-guard-state` — The startup safety gate state that records whether prerequisite checks passed and whether risky startup actions should proceed, defer, or abort.
