# Core runtime and session test harnesses  `stage-23.2`

This stage is the core runtime’s full verification umbrella: it spans source-level unit tests, shared integration infrastructure, and end-to-end suites that exercise the system from startup through active session turns, transport/tool execution, policy gates, persistence, resume, and recovery. Its job is to prove that the runtime’s central contracts stay correct as sessions move through real execution paths.

The source-level runtime, session, policy, and state tests check the internal mechanics of turn processing, prompt/context assembly, approvals and guardian policy, agent orchestration, rollout reconstruction, compaction, transcript shaping, shell/environment integration, realtime startup, and persisted session semantics. The tools and unified-exec tests focus on the model-visible tool surface and the underlying command runner, freezing tool schemas, dispatch behavior, approval and sandbox rules, and process execution details.

Beneath both, the core integration harness supplies the reusable test binary, fixtures, fake servers, shell/process helpers, tracing, and hermetic Codex executables needed to run realistic scenarios deterministically. On top, the end-to-end suites drive complete conversations across transport, provider protocols, tools, plugins, approvals, multi-agent work, and state replay, using that harness to validate the whole runtime as one cooperating system.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
