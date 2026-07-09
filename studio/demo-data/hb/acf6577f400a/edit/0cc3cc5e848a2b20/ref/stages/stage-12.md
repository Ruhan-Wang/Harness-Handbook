# Prompt, context, and extension assembly  `stage-12`

This stage is the last cross-cutting assembly step before any model call. It sits between live session state and request execution, turning everything the runtime knows about the current turn into the exact model-visible prompt, history, and injected context that will drive the next unit of work.

Its foundation is the prompt/context facade layer, which defines the shared fragment types, prompt slots, and embedded instruction templates used everywhere else. On top of that, the context-fragment and prompt-asset layer provides the concrete building blocks: typed fragments for environment facts, token budgets, permissions, skills, realtime lifecycle messages, and other session signals, plus the canonical instruction text assets they render from.

The contributor layer then gathers actual content from user instructions, AGENTS.md, collaboration mode, IDE and terminal context, memories, goals, skills, plugins, apps/connectors, sandbox and approval settings, and review-mode prompts, exposing each as fragments or injected items. Finally, turn-context and history assembly freezes the current settings into an immutable snapshot, normalizes and truncates prior conversation, computes context-change updates, adds incremental fragments, and produces the final prompt state for normal, realtime, debug, and extension-backed flows.

## Sub-stages

- [Prompt and context facade modules, fragments, and embedded instruction templates](stage-12.1.md) `stage-12.1` — 8 files
- [Context fragment definitions and prompt assets](stage-12.2.md) `stage-12.2` — 25 files
- [Instruction, skill, plugin, memory, and review prompt contributors](stage-12.3.md) `stage-12.3` — 29 files
- [Turn context, history, and realtime prompt assembly](stage-12.4.md) `stage-12.4` — 12 files

## 📊 State Registers Touched

- `reg-runtime-environment-catalog` — The validated and cached execution-environment objects derived from shell snapshots, local probing, and remote environment registration.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved startup and runtime feature enablement state used to gate behavior, APIs, and experimental surfaces.
- `reg-permission-profiles` — The compiled permission-profile identities and concrete permission overlays that preserve user intent across config, session, and protocol boundaries.
- `reg-sandbox-policy` — The enforceable sandbox, filesystem, network, and capability policy derived from config and rendered for execution backends.
- `reg-plugin-catalog` — The resolved plugin and marketplace catalog, including local editable config and refreshed curated plugin snapshots.
- `reg-mcp-server-set` — The declared and runtime-resolved MCP server inventory and transport metadata used for routing, approvals, and prompt contributions.
- `reg-model-catalog` — The merged model/provider catalog and preset metadata built from bundled, cached, local, and remote sources.
- `reg-connector-catalog` — The normalized remote connector and app directory, including workspace enablement and visibility decisions.
- `reg-core-skills-catalog` — The loaded and invalidatable skill catalog and associated enablement state used for prompt injection and runtime selection.
- `reg-live-session-object` — The long-lived session runtime object that owns turn submission, event delivery, approvals, context construction, and runtime services for a thread.
- `reg-session-state` — The mutable session-wide state that survives across turns, including history, token and rate-limit accounting, connector selections, and sticky grants.
- `reg-turn-state` — The mutable state for the currently running turn, including pending approvals, waiters, mailbox delivery phase, and turn-local permission state.
- `reg-turn-context-snapshots` — The immutable per-turn context snapshots derived from session settings, environments, models, permissions, and runtime services before execution.
- `reg-prompt-assets-and-fragments` — The shared prompt-asset and context-fragment inventory used to assemble model-visible instructions, history decorations, and injected runtime facts.
- `reg-extension-state` — The typed host-seeded and extension-owned attachment store that extensions use to persist runtime data across lifecycle callbacks.
- `reg-token-budget-state` — The session and turn level token-budget accounting and remaining-context-window state used during context assembly, compaction decisions, and model request shaping.
- `reg-goals-and-memory-state` — The persisted and live thread-scoped goals, memory mode, and memory artifact state that feed prompt assembly, background memory processing, and user-visible thread settings.
- `reg-realtime-session-state` — The thread-scoped realtime conversation session state, including whether realtime mode is active and the associated start/append/stop lifecycle context carried into prompts and protocol notifications.
- `reg-memories-startup-guard` — The startup-readiness guard that blocks or gates memory-related functionality until required memory initialization checks have completed.
- `reg-approved-command-prefixes` — The persisted and session-visible set of saved approved command prefixes that survives approval events and is reinjected into later prompt context.
