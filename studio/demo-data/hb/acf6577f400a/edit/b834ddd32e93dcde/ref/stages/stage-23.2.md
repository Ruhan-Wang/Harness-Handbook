# Core runtime and session test harnesses  `stage-23.2`

This stage is the project’s full testing ground for the core runtime, especially the parts that keep a user session going from one turn to the next. It is mostly behind-the-scenes support, but it checks the system at every scale: small unit tests, larger integration tests, and full end-to-end runs that act like real usage.

One part tests the runtime’s memory and rules. It checks sessions, saved state, prompts, approvals, safety policy, and how conversation history is trimmed or summarized so the model sees the right context. Another part focuses on tools and command execution. It verifies the exact shapes of tool calls, the code that runs them, and the safety gates around shell access, network use, and other risky actions.

A shared integration harness provides the test workshop: reusable setup code, fake servers, helper processes, logging, and controlled environments so tests are repeatable. On top of that, the end-to-end suites run the whole machine together, checking transport to model providers, streaming replies, plugins, remote work, multi-agent flows, compaction, and review or approval paths. Together, these layers make sure core behavior stays correct and safe.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
