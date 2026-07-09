# Core runtime and session test harnesses  `stage-23.2`

This stage is the core runtime’s full verification envelope: it spans source-level unit tests, shared integration infrastructure, and end-to-end suites that exercise startup, live session execution, recovery paths, and policy enforcement. Its job is to prove that sessions, prompts, tools, transport, approvals, plugins, realtime flows, and persisted state behave correctly both in isolation and when combined.

The source-runtime test sub-stage checks the internals of session lifecycle, context assembly, compaction, rollout reconstruction, agent orchestration, guardian and exec-policy decisions, shell/environment integration, and realtime formatting. The tools and unified-exec sub-stage focuses on the execution substrate beneath those sessions, validating tool schemas, routing, registry behavior, sandbox and approval semantics, process management, streaming, cancellation, and failure handling. The integration harness sub-stage supplies the reusable machinery that makes realistic tests possible: the shared test binary, fixtures, fake servers, tracing, process helpers, environment detection, and hermetic Codex/codex-exec wrappers. Built on that harness, the end-to-end suites drive complete conversations through transport, model selection, tool use, approvals, multi-agent work, plugins, persistence, compaction, resume, and replay, confirming the whole runtime cooperates correctly.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
