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

- `reg-runtime-environment-catalog` — The validated and cached execution-environment objects built from shell snapshots, local probing, and remote environment inputs.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved startup and runtime feature enablement set that gates experimental and product capabilities.
- `reg-provider-catalog` — The resolved catalog of model providers, backend adapters, and related provider metadata available to the runtime.
- `reg-model-catalog` — The merged local/cached/remote model inventory and presets used for model selection, picker UX, and turn execution.
- `reg-plugin-catalog` — The active plugin/marketplace catalog and locally synced plugin snapshot available for startup, prompt contributions, and tooling.
- `reg-skills-catalog` — The loaded and enabled skills catalog, including bundled and external skill metadata and prompt resources.
- `reg-permission-profiles` — The compiled permission-profile identities and concrete permission overlays resolved from config and preserved for round-tripping.
- `reg-sandbox-policy` — The enforceable filesystem, network, and sandbox-mode policy derived from configuration and translated into execution-specific settings.
- `reg-connectors-workspace-state` — The normalized connector/app directory plus workspace enablement/visibility state that controls integration availability.
- `reg-live-session-objects` — The long-lived session objects that own turn submission, event delivery, persistence hooks, approvals, and runtime configuration.
- `reg-session-state` — The mutable session-wide state container holding conversation history, token accounting, sticky grants, prewarm data, and connector selections.
- `reg-turn-context-snapshot` — The immutable per-turn context snapshot freezing session settings, environment, permissions, model metadata, and runtime services for execution.
- `reg-prompt-context-assembly` — The assembled prompt/history/context-fragment state produced for a turn from session data, contributors, instructions, memories, and integrations.
- `reg-extension-state-store` — The typed host-seeded and extension-owned attachment store that lets extensions keep shared runtime state across callbacks and stages.
- `reg-token-budget-state` — The live token-budget/accounting state that tracks remaining context budget and window-specific token limits used during prompt assembly, compaction decisions, and UI display.
- `reg-goals-store` — The durable and live per-thread goals state, including stored goals and related budgeting metadata that survive resume and feed prompt/context assembly.
- `reg-memories-state` — The persisted and runtime memory subsystem state covering memory records/artifacts, processing mode, startup guards, and memory-backed prompt contributions.
- `reg-realtime-session-state` — The active realtime conversation/session state, including start/append/stop lifecycle and associated thread-scoped transport/runtime coordination.
- `reg-model-discovery-state` — The live local-provider discovery state for OSS/Ollama/LM Studio model enumeration and readiness, including cached discovered inventories reused after startup.
- `reg-approved-command-prefixes` — The persisted and runtime set of saved approved command prefixes reused to bypass repeat approval prompts and injected back into context.
- `reg-thread-environment-selection` — The per-thread selected execution environment binding that survives session orchestration and is consumed by turn-context construction and tool execution.
