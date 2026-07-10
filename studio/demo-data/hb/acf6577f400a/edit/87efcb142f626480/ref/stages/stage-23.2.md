# Core runtime and session test harnesses  `stage-23.2`

This stage is the project’s full testing safety net for the core runtime: the part that keeps sessions running, lets the system use tools, talks to outside services, and remembers state between turns. It mostly supports the system’s normal work loop, but it also checks startup, pause-and-resume, and shutdown edge cases.

One part focuses on runtime, session, policy, and state tests. It checks conversation flow, prompt building, saved history, approval gates for risky actions, and the rules that decide what commands or tools are allowed. Another part focuses on tools and unified execution, the shared command runner. These tests make sure tool requests have the right shape, are routed correctly, obey safety rules, and produce the expected results.

A shared integration harness under core/tests provides the test workshop. It spins up fake servers, isolated environments, helper processes, and stable snapshots so larger tests can run in a controlled world. On top of that, the end-to-end suites test the whole machine working together: transport, streaming, tools, plugins, approvals, persistence, realtime features, rollout, and recovery.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
