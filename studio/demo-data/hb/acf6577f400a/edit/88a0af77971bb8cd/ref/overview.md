# System Handbook

## 🗺️ System Overview

This codebase is a multi-surface Rust application centered on a shared conversational/runtime core. One process image can present itself as the main `codex` CLI, an interactive TUI, app-server and exec-side services, helper utilities, or focused maintenance tools. At startup, binary dispatch interprets argv, argv[0], and environment to choose that surface, then early bootstrap hardens the process, fixes the global TLS provider, shapes PATH and re-exec behavior, and brings up the Tokio runtime.

From there, startup assembles the operating context the rest of the system depends on: it discovers installation layout and `CODEX_HOME`, materializes bundled helper binaries, probes shell and host environment, merges config layers and feature flags, compiles permission and sandbox policy, restores authentication, and opens the SQLite-backed state runtime with migrations and corruption recovery. Once config and identity are ready, the system builds backend clients, refreshes remote catalogs such as models, plugins, and cloud settings, and initializes transports for the app-server, daemon, exec-server, MCP, relays, sockets, and in-process clients.

Frontend startup then turns those prepared services into either an interactive terminal session or a one-shot scripted request. After that handoff, the steady-state loop accepts UI events, JSON-RPC traffic, and internal messages, routes them to the correct thread/session, assembles prompt and context from history, memories, tools, skills, permissions, and integrations, and executes turns through model transports and streaming reducers. Tool calls, approvals, sandboxed commands, plugins, connectors, and MCP servers provide guarded side effects, while multi-agent workflows can spawn child threads and background jobs when a single turn is not enough. Results are persisted into rollout files and SQLite metadata, then projected back into app-server notifications, exec output, and TUI state.

Shutdown reverses that path by gating new RPC work, draining handlers, persisting final thread and agent state, and coordinating daemon update/re-exec behavior. Supporting all of this are shared schema contracts, transport/client stacks, observability and analytics, persistence abstractions, utility libraries, and extensive test harnesses that exercise the whole lifecycle.

---

## See also

- [State-flow registers](register.md) — global state that flows across stages
- [Stage Index](index.md) — every stage and what it does
