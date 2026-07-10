# Prompt, context, and extension assembly  `stage-12`

This stage is the briefing builder that runs just before the model starts its main work on a turn. Its job is to gather everything the model should know right now and turn it into one exact input packet. You can think of it like packing a suitcase: some items are always available on the shelf, some depend on the trip, and some are last-minute updates.

One part provides the basic pieces and templates: built-in instruction text, standard “context fragments” (small chunks of formatted information), and the public helper modules other code calls. Another part defines many concrete fragment types, such as environment details, permission warnings, skills, shell activity, and saved rules, so different information can all be wrapped in a consistent shape.

Contributor modules then choose which pieces to include for this turn: user and project instructions, AGENTS.md notes, collaboration rules, writing style, IDE information, apps, plugins, skills, memories, goals, and review prompts. Finally, the turn-assembly code snapshots current settings, cleans and trims conversation history, tracks what changed, manages token-budget notices, and builds special compact prompts for realtime and web-search modes.

## Sub-stages

- [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files
- [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files
- [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files
- [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

## 📊 State Registers Touched

- `reg-host-environment-facts` — The shared facts discovered about the machine and local setup, like hostname, OS, locale, editor, pager, Git, and cloud environment.
- `reg-effective-config` — The final merged settings built from all config layers, giving the rest of the app one resolved playbook to follow.
- `reg-provider-and-model-catalog` — The shared catalog of model providers, available models, and ready-to-pick presets used across the app.
- `reg-plugin-and-connector-catalog` — The current merged list of plugins, connectors, marketplaces, and related metadata that the app can expose and use.
- `reg-skills-and-memory-assets` — The shared installed set of built-in and loaded skills and memory-related assets available to sessions and prompts.
- `reg-permission-policy` — The resolved filesystem and network permission rules that decide what the app and its tools are allowed to do.
- `reg-live-session-objects` — The long-lived in-memory session objects that hold queues, services, saved state, and runtime handles for active threads.
- `reg-thread-history-store` — The persisted conversation history and thread metadata used when threads are reopened, forked, listed, or trimmed.
- `reg-thread-environment-selection` — The chosen execution-environment snapshot attached to each thread so later turns and tools run in the right context.
- `reg-session-state` — The mutable session-wide working memory that survives across turns, such as conversation history, connector choices, prewarm state, and sticky grants.
- `reg-turn-state` — The mutable state for the currently running turn, including approval waiters, per-turn permissions, and interruption/abort coordination.
- `reg-turn-context-snapshot` — The immutable snapshot of settings, permissions, environment, and runtime services prepared for one turn before execution starts.
- `reg-prompt-context-assembly` — The assembled set of prompt fragments, instructions, memories, skills, and trimmed history that become the model’s input.
- `reg-auto-compact-window` — The rolling token-window tracking state used to decide when history should be compacted and how context growth is measured.
- `reg-turn-metadata-and-request-metadata` — The shared metadata stamped onto model requests, such as session identity, workspace facts, and request tags.
- `reg-extension-runtime-state` — The host-and-extension shared attachment stores and runtime data that extensions use to keep state across callbacks and turns.
- `reg-token-budget-state` — The live accounting of remaining context-window budget and related notices used during prompt assembly, turn execution, and user-visible token updates.
- `reg-goals-state` — The persisted and live per-thread goal state that extensions and UI surfaces attach to threads and carry across turns.
- `reg-memory-backend-state` — The live backing-store state for memory operations, including the selected memory backend/workspace used by memory tools and prompt contributors across turns.
- `reg-realtime-session-state` — The active thread-scoped realtime conversation state, including start/append/stop lifecycle and special prompt/context handling while realtime mode is open.
- `reg-prompt-contributor-state` — The resolved runtime state of prompt/context contributors and their current thread/session-scoped contributions used during prompt assembly.
- `reg-context-change-tracking` — The per-thread record of what prompt/context inputs changed since prior turns so assembly, compaction, and notifications can react incrementally.
- `reg-approved-command-prefixes` — The saved set of command prefixes that were explicitly approved before and can be reused across later turns as sticky approval context.
