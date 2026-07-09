# Frontend session startup and user-facing initialization  `stage-9`

This stage is where the prepared backend finally becomes something a person can use. It sits at the handoff between setup and real work. Its job is to open the right kind of session, connect it to the already-started services, and make the user-facing surface ready.

One branch is the interactive terminal app, or TUI (text user interface). That startup path claims control of the terminal window, checks what the terminal can do, switches into the app’s full-screen style, and protects the screen from stray output. It also handles suspend and resume, window titles, alerts, and resizing. Before dropping the user into the main screen, it may run onboarding steps such as welcome, sign-in, provider choice, trust for the current folder, updates, migrations, imports, or choosing a past session to continue. Then it prepares the first visible chat widgets and status views.

The other branch is exec mode, the non-interactive “do one job and exit” path. It builds a session from command-line options, starts the same core services, restores session context if needed, runs the request-processing loop, and prints or saves the final result. Together, these paths turn backend machinery into a ready interface.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-process-argv-dispatch` — The process-wide startup command and launch mode that tells the program which behavior to run.
- `reg-host-and-doctor-facts` — The shared facts about this machine and setup, like host name, OS, editor, locale, and cloud environment.
- `reg-effective-config` — The final merged settings from defaults, managed config, user files, project files, thread overrides, and command-line flags.
- `reg-config-manager-and-lockfile` — The shared service that serves the latest config and records the exact config snapshot a session used.
- `reg-feature-flags` — The set of optional features currently turned on or off for this run.
- `reg-model-provider-and-catalog` — The shared list of model providers, available models, and ready-to-pick model presets.
- `reg-auth-session` — The current signed-in account state and saved login details for this installation.
- `reg-thread-store-and-rollout-history` — The durable record of threads, conversation items, and rollout history that lets sessions be resumed and replayed.
- `reg-local-model-server-state` — The known reachability, model availability, and download/load status of local model servers like Ollama or LM Studio.
- `reg-update-cache` — The cached information about available app updates and installed version status.
- `reg-server-runtime` — The live server and daemon runtime that accepts clients, routes messages, and keeps shared server services running.
- `reg-ui-session-state` — The live user-interface session state for terminal or exec mode, including startup flow, visible widgets, and status views.
- `reg-active-session-object` — The long-lived session object that carries shared services and conversation state across many turns.
- `reg-user-project-instructions` — The user, project, and AGENTS.md-style instructions that are carried into prompts and session startup.
- `reg-thread-projection-state` — The rebuilt user-visible thread state, summaries, status, and transcript items derived from engine events.
- `reg-exec-output-state` — The accumulated machine-readable exec output and final result data for one-shot runs.
- `reg-cache-stores` — The shared on-disk caches for downloaded config, model lists, plugin data, updates, and small UI choices.
- `reg-config-profile-selection` — The currently selected named configuration profile and its persisted profile-scoped UI/runtime choices reused across startup, config editing, and session creation.
- `reg-auth-mode-and-account-readiness` — The resolved authentication mode and current account-readiness/eligibility state that gates features and request paths beyond raw token possession.
- `reg-workspace-trust-state` — The remembered trust/allowance state for the current workspace that influences onboarding, plugin enablement, and action policy across the session.
- `reg-session-resume-and-continue-state` — The remembered session/thread continuation choice and resume metadata used to restore prior conversations, onboarding handoff, and exec/session restart flows across startup and live session orchestration.
- `reg-terminal-ui-capability-and-lifecycle-state` — The claimed terminal runtime state including capabilities, alternate-screen/raw-mode ownership, resize/suspend-resume tracking, and screen-protection coordination shared across TUI startup, event loop, and teardown.
