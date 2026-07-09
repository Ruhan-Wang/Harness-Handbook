# Core runtime and session test harnesses  `stage-23.2`

This stage is the project’s full proving ground for the core runtime. It sits mostly behind the scenes around the system’s main work loop: keeping a session alive, deciding what the model and tools can do, and checking that all of it still works together from small units up to full end-to-end runs.

One part tests the runtime’s inner rules: sessions, saved state, prompt building, approvals, and safety policy. These tests replay conversations, resumes, rollbacks, and shutdowns to make sure the system keeps a consistent memory and follows the right restrictions. Another part focuses on tools and command execution, checking the “contracts” for each tool, how tools are found, and how commands are prepared, isolated, timed, and traced.

A shared integration harness provides the workshop for these tests. It builds fake servers, helper processes, logging, and repeatable test environments so many scenarios can be exercised the same way every time. On top of that, the end-to-end suites run full realistic flows: network transport, streaming replies, compaction of old history, remote workspaces, plugins, approvals, and feature rollouts. Together, these layers act like a dress rehearsal for the whole core system.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
