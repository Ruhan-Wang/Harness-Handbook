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

- `reg-execution-environment-snapshot` — The captured shell and machine environment details that threads and tools use to run commands consistently.
- `reg-host-environment-facts` — The normalized facts about the current machine, OS, editor, locale, cloud status, and helper tools that the system keeps reusing.
- `reg-effective-config` — The final merged configuration built from defaults, managed settings, user and project files, thread settings, and command-line overrides.
- `reg-feature-flags` — The on/off switches for experimental or optional behavior that are resolved once and then checked throughout the app.
- `reg-plugin-and-skill-catalog` — The shared inventory of plugins and skills that are installed, enabled, and available to sessions and prompt building.
- `reg-mcp-server-catalog` — The resolved set of MCP servers and their runtime metadata used for routing, diagnostics, and policy decisions.
- `reg-connector-catalog` — The merged list of external connectors and apps that the product knows are available for use.
- `reg-permission-profiles` — The named and resolved permission profiles that describe what kind of access a session or turn may request.
- `reg-conversation-thread-store` — The durable store for conversation history and thread logs that lets sessions resume and transcripts be rebuilt later.
- `reg-rate-limit-status` — The current backend usage and rate-limit state that can block features, shape turns, and be shown to users.
- `reg-session-state` — The long-lived per-session state that survives across turns, such as conversation history, sticky grants, connector picks, and usage accounting.
- `reg-extension-runtime-state` — The shared attachment store and extension-owned runtime data that plugins and extensions keep across callbacks and turns.
- `reg-context-fragment-pool` — The shared collection of prompt/context fragments contributed by core features, extensions, plugins, skills, and runtime facts before a turn.
- `reg-token-budget-and-compaction-window` — The running token-budget and auto-compaction tracking that decides when history must be shrunk or reset.
- `reg-turn-metadata` — The standard metadata attached to model requests, such as session identity, workspace details, and compatibility fields.
- `reg-tool-catalog` — The normalized list of tools the model can call, including built-ins, MCP tools, plugins, hooks, and integration tools.
- `reg-memory-store` — The stored long-term memories and memory files that can be updated in the background and reused in later turns.
- `reg-goals-store` — The persisted user or thread goals that sessions load, display, and carry into prompt assembly and history updates.
- `reg-thread-environment-selection` — The selected execution environment binding for each thread or session, reused when building turn context and running tools.
- `reg-realtime-session-state` — The live state for experimental realtime conversations, including start/append/stop lifecycle and associated thread-scoped runtime context.
- `reg-connector-selection-state` — The current per-session or per-thread selection of which connectors/apps are actively enabled for use and prompt injection.
- `reg-skill-cache-and-watch-state` — The cached loaded-skill data plus watcher invalidation state that tracks when skill files change and cached skill rendering must be refreshed.
- `reg-approved-command-prefix-store` — The persisted or sticky set of command prefixes previously approved for reuse, carried into later approvals and prompt context.
- `reg-thread-resume-and-compaction-bridge-state` — The saved compatibility and resume bookkeeping that bridges older sessions, changed context windows, and post-compaction history reconstruction into new turns.
- `reg-extension-contributor-lifecycle-state` — The extension callback/lifecycle coordination state that tracks thread, turn, and tool contributor participation across runtime events.
- `reg-resolved-profile-selection-state` — The preserved identity and constrained/trusted snapshot of the currently selected resolved permission profile for a session or thread, carried so config, UI, and runtime can round-trip which profile is active beyond the raw sandbox rules.
- `reg-shell-command-history-context-buffer` — The accumulated recent user-run shell command records and outputs that are kept as reusable prompt/context inputs across turns and surfaced again during later prompt assembly.
