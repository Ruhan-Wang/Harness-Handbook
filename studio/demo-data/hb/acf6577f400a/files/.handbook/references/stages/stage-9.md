# Frontend session startup and user-facing initialization  `stage-9`

This stage happens after the backend services are ready, but before the user can really start working. It is where Codex turns its prepared engine into something a person or script can use.

For the interactive terminal app, the TUI startup path opens the front door. It loads settings, connects to the app server, guides first-time users through sign-in and trust choices, checks project setup, and builds or resumes the visible chat. It also takes careful control of the terminal window: drawing the interface, reading keys, handling resize and suspend, showing notifications, and restoring the shell when finished.

For non-interactive use, exec mode starts a single scripted session instead of a full screen app. It gathers the prompt, configuration, saved session details, or review request, then runs once and writes predictable output, such as JSON lines for other programs to read. The resume helper makes sure an old conversation restarts with the right folder and model. Together, these parts make Codex ready for either a human at a terminal or an automation script.

## Sub-stages

- [TUI startup, onboarding, and terminal ownership](stage-9.1.md) `stage-9.1` — 39 files
- [Exec-mode and scripted session startup](stage-9.2.md) `stage-9.2` — 2 files

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-install-home-context` — The discovered Codex home folder, install location, bundled resources, and stable local installation identity.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-state-databases` — The opened local SQLite stores and migration state that hold structured runtime data for threads, agents, goals, jobs, and summaries.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-cloud-config-cache` — The cached and refreshed cloud-delivered configuration bundles that can alter settings, requirements, and available features.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-cloud-task-state` — Cloud task lists, task details, submission attempts, selected task environments, and polling/refresh status shared by cloud task commands and clients.
- `reg-terminal-runtime-state` — Live terminal control state such as raw mode, alternate screen ownership, resize/suspend handling, input streams, and restoration obligations.
- `reg-collaboration-mode-catalog` — Built-in and configured collaboration-mode presets/templates that clients can list and apply to choose model, mode, reasoning, and prompt behavior.
- `reg-launch-invocation-context` — The raw launch context, including invoked binary/arg0, selected subcommand or runtime mode, startup flags, and output/interaction mode chosen before dispatch.
- `reg-project-trust-store` — Persisted and effective trust decisions for workspaces/projects that influence onboarding, permission assembly, sandbox behavior, and session startup.
