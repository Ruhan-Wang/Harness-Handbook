# Core end-to-end session, transport, tool, and feature suites  `stage-23.2.4`

This stage is the broad end-to-end runtime validation layer for Codex’s live user-facing behavior. It sits across the main execution path, exercising everything that happens once a session is running: request shaping, transport, tool execution, approvals, collaboration, persistence, and recovery. Together, these suites prove that a real conversation can move from prompt assembly to provider I/O, through mediated tool actions and multi-agent work, and back into durable session state without losing correctness.

The transport, streaming, and provider protocol suites verify the wire-level mechanics of HTTP, SSE, WebSocket, realtime, compression, fallback, and error recovery. Model request shaping and runtime model-selection suites ensure the right model is chosen and that prompts, tools, schemas, permissions, and context are assembled correctly before any call leaves the runtime. Tool, shell/exec, MCP/app, plugin, and runtime item suites then validate actual execution and event serialization. Approvals, permissions, hooks, and review-mediation suites check the policy gates around those actions. Multi-agent and remote-environment suites cover delegated work, subagents, jobs, and isolation. Finally, the session history, compaction, resume, and persisted state suites ensure all of that activity can be compacted, resumed, forked, and replayed consistently across turns and restarts.

## Sub-stages

- [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files
- [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files
- [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files
- [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files
- [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files
- [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files
