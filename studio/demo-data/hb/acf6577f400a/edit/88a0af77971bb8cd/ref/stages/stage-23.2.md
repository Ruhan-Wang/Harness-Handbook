# Core runtime and session test harnesses  `stage-23.2`

This stage is the core runtime’s full verification umbrella: it spans source-level unit tests, reusable integration infrastructure, and end-to-end suites that exercise the system from startup through active session turns, recovery paths, and persisted teardown/resume behavior. Its job is to prove that sessions, prompts, tools, transport, approvals, plugins, realtime, and state management behave correctly together, not just in isolation.

The source-runtime test stage checks the internals of session execution and policy enforcement: turn lifecycle, context assembly, compaction, history/event shaping, agent orchestration, approvals, shell and sandbox rules, rollout reconstruction, and session-state edge cases. The tools and unified-exec tests focus on the execution substrate beneath those sessions, validating tool registration and dispatch, schemas, routing, approval and sandbox semantics, shell/process behavior, MCP dispatch, and unified-exec race and lifecycle handling. The integration-harness stage provides the shared test binary, fake servers, process helpers, telemetry, and hermetic Codex executables that make realistic tests deterministic. On top, the end-to-end suites drive real conversations through transport, model selection, tool use, collaboration, hooks, permissions, persistence, and resume flows, confirming the whole runtime cooperates correctly under user-visible scenarios.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
