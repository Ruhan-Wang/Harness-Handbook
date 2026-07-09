# System Handbook

## 🗺️ System Overview

This codebase is a multi-surface Rust application centered on a shared conversational/runtime core, exposed through a CLI, an interactive TUI, an app-server/daemon, and several helper binaries and sidecar services. At process start, binary dispatch interprets argv, argv[0], and environment to select the right personality—main CLI, TUI, exec, doctor, remote-control, MCP utilities, or other focused tools. Before any real work begins, early bootstrap hardens the process, locks in global TLS behavior, sets up argv[0]-based helper aliases, and initializes the Tokio runtime.

Startup then establishes the local operating context: it discovers CODEX_HOME and installation layout, materializes bundled helper binaries, snapshots shell/environment state, and probes host and platform facts. On top of that, configuration assembly merges managed, cloud, user, project, thread, and CLI inputs into one resolved runtime policy covering features, assets, permissions, sandboxing, tools, and UI settings. Authentication turns stored or environment-provided credentials into a concrete account/identity state, after which the system opens and migrates its SQLite-backed state stores and rollout metadata.

With config, auth, and persistence ready, startup constructs backend clients, refreshes remote catalogs such as models, connectors, plugins, and cloud config, and then brings up transports: app-server listeners, daemon control paths, exec-server channels, MCP runtimes, relay links, and local IPC. Frontend startup converts those services into either an interactive TUI session—with onboarding, terminal ownership, and resume decisions—or a one-shot exec request.

Steady-state execution is driven by a main event loop that routes UI events, JSON-RPC requests, and internal messages into thread/session orchestration. Each turn assembles prompt and context from history, config, memories, tools, extensions, and environment, invokes models, executes approved tools and guarded side effects, may spawn sub-agents or background workflows, and then persists and projects results back to clients, transcripts, and UI state. Shutdown gates new work, drains in-flight handlers, closes agent trees, cleans up connections, and supports controlled daemon restart or re-exec. Cross-cutting contract schemas, transport/client layers, persistence abstractions, observability, analytics, and utility libraries support every step of that lifecycle.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
