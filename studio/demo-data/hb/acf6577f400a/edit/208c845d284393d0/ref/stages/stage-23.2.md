# Core runtime and session test harnesses  `stage-23.2`

This stage is the project’s big test umbrella for the core runtime: the code that keeps a live session moving. It is mostly behind-the-scenes verification, not product startup or shutdown. Its job is to prove that sessions, tools, rules, and communication still work correctly when all the pieces are exercised together.

One part tests the core runtime’s internal rules: creating and restoring sessions, shaping prompts, keeping history and visible transcripts aligned, and enforcing safety and approval policies. Another part focuses on tools and command execution. It checks the published tool formats, the code that routes and runs them, and the guardrails around risky actions like shell commands or network access.

A shared integration harness acts like a reusable test workshop. It builds isolated fake environments, helper processes, mock servers, and logging so realistic tests can run repeatably. On top of that, the end-to-end suites perform full dress rehearsals: they send requests, stream responses, resume saved state, use tools, trigger approvals, and cover plugins, realtime features, rollout behavior, and remote or multi-agent work. Together, these layers catch both small mistakes and whole-system failures.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
