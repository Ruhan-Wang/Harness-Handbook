# Prompt, context, and extension assembly  `stage-12`

This stage is the prompt-building workshop. Just before the system sends a turn to the model, it gathers everything the model is allowed to see and shapes it into one clear input package. Some parts provide the raw shelves and labels: shared prompt templates, context fragment formats, and extension hooks so built-in code and add-ons can add text in predictable places.

Other parts create the actual note cards that go into the prompt. They turn settings and events into model-readable messages: project instructions, permissions, network rules, available skills, memories, goals, IDE details, plugin and app connectors, review requests, and warnings about space limits. They also keep older saved warning formats understandable.

The turn assembly parts then combine these pieces with the conversation history. They trim old messages when the model’s memory space is limited, remove items the chosen model cannot use, and send only changed context when possible. Realtime startup and developer prompt-debugging use the same machinery to build their own opening briefings.

## Sub-stages

- [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files
- [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files
- [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files
- [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-skills-catalog` — The available skills list, including where each skill came from, whether it is enabled, and the instructions it can add to a session.
- `reg-memory-store` — The saved long-term user memories and memory search results that can be loaded, updated, and inserted into future conversations.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-goal-state` — The live and persisted user goals, goal progress, and goal-thread associations synchronized into prompts, storage, analytics, and UI indicators.
- `reg-realtime-stream-state` — Active realtime conversation state, including audio/text stream sessions, WebSocket transport state, buffers, and stop/cancel lifecycle data.
- `reg-connector-directory-cache` — Cached ChatGPT/app connector directories, workspace connector settings, local connector metadata, and fallback lookup results used when exposing connectors to sessions and prompts.
- `reg-collaboration-mode-catalog` — Built-in and configured collaboration-mode presets/templates that clients can list and apply to choose model, mode, reasoning, and prompt behavior.
- `reg-ide-integration-state` — Active IDE-link state such as connected IDE clients, workspace metadata, open file or selection context, and IDE details injected into prompts or server notifications.
- `reg-session-connector-selection` — Per-session selected or enabled app/ChatGPT connectors used to decide which connector context and tools are exposed to the model.
