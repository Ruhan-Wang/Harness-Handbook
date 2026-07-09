# Core runtime and session test harnesses  `stage-23.2`

This stage is the main safety-check area for the core system. It is not part of what users directly see. Instead, it proves that the conversation engine can start, run, use tools, save its place, recover later, and stop safely. One group of tests watches the runtime itself: sessions, history, state, permissions, compaction, agents, realtime behavior, and other internal records. Another group focuses on tools, such as running shell commands, editing files, calling outside services, asking for approval, and shutting down long-running work. A shared integration harness acts like a test workshop. It builds fake folders, fake model servers, fake app services, and controlled streams so tests can run without touching real user data. The end-to-end suites then put everything together, checking full sessions from model request to streamed reply, tool use, approvals, saved history, plugins, remote work, and helper agents. Together, these parts make sure the core behaves reliably before real users depend on it.

## Sub-stages

- [Core src runtime, session, policy, and state tests](stage-23.2.1.md) `stage-23.2.1` — 40 files
- [Core src tools and unified-exec tests](stage-23.2.2.md) `stage-23.2.2` — 39 files
- [Core integration harness and common test support](stage-23.2.3.md) `stage-23.2.3` — 15 files
- [Core end-to-end session, transport, tool, and feature suites](stage-23.2.4.md) `stage-23.2.4` — 85 files
