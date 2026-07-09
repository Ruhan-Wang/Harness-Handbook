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

- `reg-host-platform-facts` — Normalized host identity and platform probe results such as hostname, shell, locale, editor, pager, and cloud-environment facts reused by diagnostics and runtime decisions.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-permission-policy` — The compiled permission profiles, sandbox mode, filesystem/network ACLs, and related enforcement policy shared by sessions, tools, and transports.
- `reg-tool-catalog` — The runtime-visible catalog of executable tools and their normalized schemas, exposure rules, and metadata used for dispatch and prompt assembly.
- `reg-plugin-and-skill-catalog` — The resolved plugin, marketplace, hook, and skill configuration plus loaded skill/plugin metadata shared across startup, prompt assembly, and execution.
- `reg-model-catalog` — The merged bundled, cached, local-provider, and remotely fetched model inventory and presets used for picker, routing, and turn execution.
- `reg-connector-catalog` — The refreshed connector/app directory and workspace enablement state that determines which integrations are visible and usable.
- `reg-live-session-object` — The long-lived session object and shared services that own turn submission, event delivery, approvals, persistence, and runtime configuration.
- `reg-session-state` — The mutable session-wide state that survives across turns, including conversation history, token/rate-limit accounting, connector selections, and sticky grants.
- `reg-turn-state` — The mutable active-turn coordination state including pending approvals, waiters, mailbox-delivery phase, and per-turn permission/review flags.
- `reg-turn-context-snapshot` — The immutable per-turn context snapshot derived from session settings, environments, permissions, model metadata, and runtime services before model calls.
- `reg-prompt-context-assembly` — The assembled prompt fragments, injected context, normalized history, and final prompt state produced for the current turn.
- `reg-memory-pipeline-state` — The durable and runtime state for memory extraction/consolidation jobs and filesystem-backed memory artifacts.
- `reg-extension-runtime-state` — The host-seeded and extension-owned typed attachment stores that let extensions keep shared runtime state across lifecycle callbacks.
- `reg-token-budget-state` — The live token-budget and remaining-context-window accounting used to shape prompt assembly, compaction decisions, and user-visible budget indicators across turns.
- `reg-extension-contribution-cache` — The cached resolved outputs of extension contributors—such as prompt fragments, MCP overlays, tool/thread lifecycle contributions, and user instructions—reused across thread and turn assembly.
- `reg-shell-command-cache` — The session-visible cache of user-run shell command records and approved command-prefix memory that is reused for prompt context and later turns.
- `reg-connector-selection-state` — The mutable per-session or per-thread selection/enablement state for which connectors/apps are currently chosen for use and prompt injection.
- `reg-memories-startup-guard` — The startup and runtime guard state that tracks whether memories functionality is currently allowed, blocked, or degraded based on prerequisite checks.
