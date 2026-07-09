# Prompt, context, and extension assembly  `stage-12`

This stage is the briefing builder that runs right before the model is asked to do work. Its job is to gather everything the model needs to know for the next turn and turn it into the exact input text and message structure the model will see.

One part provides the raw materials and the standard shapes. It stores built-in instruction text, defines what a context “fragment” is—a small piece of information that can be turned into model-ready text—and gives both core code and extensions a safe way to contribute those pieces.

Another part supplies the actual fragments and prompt assets. These include fixed instruction sheets plus live details such as environment facts, token budget (how much prompt space is left), command results, warnings, and compatibility support for older saved sessions.

A third part gathers extra guidance from many sources: user and project instructions, skills, plugins, apps/connectors, memories, goals, review rules, IDE hints, and permission limits.

Finally, turn assembly pulls in conversation history, cleans and trims it, adds what changed since the last turn, and packs everything into one final prompt, including special handling for realtime and debugging views.

## Sub-stages

- [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files
- [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files
- [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files
- [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

## 📊 State Registers Touched

- `reg-execution-environment-snapshot` — The reusable picture of the local or remote shell environment, machine facts, and helper tool availability.
- `reg-host-and-doctor-facts` — The shared facts about this machine and setup, like host name, OS, editor, locale, and cloud environment.
- `reg-effective-config` — The final merged settings from defaults, managed config, user files, project files, thread overrides, and command-line flags.
- `reg-feature-flags` — The set of optional features currently turned on or off for this run.
- `reg-model-provider-and-catalog` — The shared list of model providers, available models, and ready-to-pick model presets.
- `reg-plugin-catalog-and-snapshot` — The known plugins, hooks, marketplaces, and synced plugin snapshot available to the runtime.
- `reg-mcp-server-catalog` — The current set of configured MCP servers and their runtime launch details for routing tool calls.
- `reg-connector-and-app-catalog` — The merged list of external apps and connectors the system can use.
- `reg-skill-catalog-and-cache` — The loaded skills, their metadata, and cached skill data used for prompting and tool behavior.
- `reg-permission-profiles` — The resolved named and built-in permission profiles that say what kinds of actions are allowed.
- `reg-sandbox-and-exec-policy` — The concrete file, network, workspace-root, and command-execution safety rules enforced at runtime.
- `reg-thread-store-and-rollout-history` — The durable record of threads, conversation items, and rollout history that lets sessions be resumed and replayed.
- `reg-rate-limit-status` — The current account usage and rate-limit status that can block or shape work.
- `reg-active-session-object` — The long-lived session object that carries shared services and conversation state across many turns.
- `reg-session-history-and-context` — The session-wide conversation history and restored context that later turns keep reading and updating.
- `reg-session-settings` — The session’s sticky runtime settings such as selected model, environment, connector choices, and memory mode.
- `reg-turn-context-snapshot` — The immutable per-turn snapshot of settings, environment, permissions, model info, and services used during one turn.
- `reg-prompt-fragment-registry` — The shared collection of built-in and extension-provided context fragments that can be inserted into prompts.
- `reg-user-project-instructions` — The user, project, and AGENTS.md-style instructions that are carried into prompts and session startup.
- `reg-token-budget-and-compaction-state` — The running token budget, context-growth tracking, and compaction window state used to keep prompts within limits.
- `reg-tool-runtime-catalog` — The active set of tools, executors, adapters, and visibility rules available for this runtime.
- `reg-memory-store-and-pipeline` — The stored memories and background memory-processing pipeline that extract and reuse important facts.
- `reg-extension-runtime-state` — The typed shared storage where extensions keep host-provided values and their own runtime data.
- `reg-goals-store-and-state` — The persisted and live per-thread goal data, including goal records shown in UI and reused across session resume and later turns.
- `reg-approved-command-prefixes` — The saved set of command prefixes previously approved by the user, reused to shape future prompt context and reduce repeat approval friction.
- `reg-realtime-session-state` — The live per-thread realtime conversation session state, including whether realtime mode is active and the append/stop stream context carried across requests.
- `reg-workspace-trust-state` — The remembered trust/allowance state for the current workspace that influences onboarding, plugin enablement, and action policy across the session.
- `reg-connector-session-selections` — The live per-session selection and enablement state for which connectors/apps are active for a thread or session beyond the static connector catalog.
- `reg-turn-command-result-buffer` — The accumulated recent command/tool result fragments and warnings kept as reusable context material for subsequent prompt assembly within the active session.
