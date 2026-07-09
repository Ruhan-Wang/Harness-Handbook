# App-server integration suites  `stage-23.1.4`

This stage is the broad end-to-end test bench for the app server. It treats the server like a real client would: start it, connect to it, send requests, run conversations, use tools, and check that the answers and side effects are correct. It is mostly about the server’s public behavior, not small internal parts.

One group tests the basic “front desk”: login, accounts, rate limits, configuration, startup handshakes, model discovery, safe file and process access, and remote-control pairing. Another group tests the live connection pipes, such as WebSockets, authentication, reconnects, shutdown behavior, desktop proof tokens, experimental features, and realtime text or audio sessions.

A third group checks extensions: plugins, marketplace installs, connector apps, hooks, skills, MCP tool servers, shell commands, file search, image generation, sleep, and web search. These tests make sure outside tools appear only when allowed and run safely.

The final group follows the conversation lifecycle: creating threads, running turns, interrupting work, asking permissions, saving history, summarizing, reviewing code, reopening sessions, and deleting or archiving old work.

## Sub-stages

- [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files
- [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files
- [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files
- [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files
