# Prompt, context, and extension assembly  `stage-12`

This stage is the assembly line that prepares exactly what the model will see before it answers. It sits right in front of the main work loop: after the system knows the current situation, but before it sends the next request to the model.

One part provides the standard pieces and containers. It stores built-in instruction text, defines what a “context fragment” is—a small named piece of prompt text—and gives both core code and extensions a clean way to add those pieces. Another part supplies the actual fragments and prompt assets: reusable notes about permissions, environment details, skills, saved rules, shell results, interruptions, realtime session start and end, and compatibility with older saved conversations.

A third part gathers higher-level contributors. It pulls in user and project instructions, skills, plugins, apps/connectors, memories, goals, and review-specific guidance. A final part assembles the current turn itself. It snapshots settings and permissions, cleans and trims conversation history, adds only changed context, tracks token budget warnings, and builds special prompts for realtime or debugging. Together, these parts create one complete, model-ready briefing packet.

## Sub-stages

- [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files
- [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files
- [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files
- [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

## 📊 State Registers Touched

- `reg-effective-config` — The merged live settings the app actually runs with after combining user, project, managed, thread, and command-line inputs.
- `reg-feature-flags` — The current set of experimental and on/off feature switches that change behavior across the app.
- `reg-startup-policy` — The resolved startup rules for permissions, service tier, keymaps, project-root behavior, and related runtime policy choices.
- `reg-local-environment-snapshots` — Cached facts about the local machine and shells, like exported environment settings, aliases, OS details, and available tools.
- `reg-model-catalog` — The current list of models and provider capabilities the app can offer for use.
- `reg-plugin-catalog-and-snapshot` — The installed and refreshable plugin inventory the app uses to decide what extensions are available.
- `reg-skills-catalog` — The loaded list of available skills and their metadata that can be selected and injected into prompts.
- `reg-connectors-and-apps` — The merged list of external apps and connectors, plus workspace rules that affect whether they can be used.
- `reg-thread-history-and-metadata` — The saved and reconstructed conversation history, thread metadata, and fork/rollback lineage for each thread.
- `reg-session-state` — The long-lived per-session state that survives across turns, including history, sticky permissions, connector choices, and prewarm data.
- `reg-context-fragment-store` — The accumulated reusable prompt pieces that core code and extensions contribute before a model request is assembled.
- `reg-user-and-project-instructions` — The loaded user, project, and AGENTS-style instructions that are reused across turns to guide the model.
- `reg-memory-state` — The app's saved long-term memory data and memory-processing state used to add relevant past information into new turns.
- `reg-goals-state` — The stored goals and related progress metadata attached to threads and shown across the session lifecycle.
- `reg-turn-context-snapshot` — The immutable per-turn snapshot of settings, permissions, environment, models, and services that the current turn runs against.
- `reg-auto-compaction-state` — The running state that tracks when long conversation history should be compacted and how token growth is measured across windows.
- `reg-tool-catalog` — The current set of tools the model can call, including built-ins, plugins, MCP tools, web/image/memory helpers, and schemas.
- `reg-sandbox-and-exec-policy` — The active sandbox and command-execution rules that decide what commands, files, and network actions are allowed.
- `reg-extension-runtime-state` — The typed shared attachment storage where extensions keep host-seeded values and extension-owned runtime data.
- `reg-ollama-lmstudio-probe-state` — Cached reachability, model-availability, and in-progress load/download state for local model servers such as Ollama and LM Studio.
- `reg-token-budget-state` — The current prompt/context token budget accounting and warning thresholds used while assembling turns and deciding what can fit.
- `reg-realtime-session-state` — The active per-thread realtime conversation session state, including start/append/stop lifecycle and buffered media/input flow.
- `reg-approved-command-prefixes` — The saved approved command prefixes that persist across turns and are reused to avoid re-asking for equivalent command approvals.
- `reg-context-delta-state` — The remembered prompt-assembly diff state that tracks which context fragments or instructions have already been sent so only changed context is re-injected on later turns.
