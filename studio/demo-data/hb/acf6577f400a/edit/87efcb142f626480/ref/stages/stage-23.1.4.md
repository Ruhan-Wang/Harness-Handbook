# App-server integration suites  `stage-23.1.4`

This stage is the big end-to-end test bed for the app server as a whole. It sits around startup, the normal running loop, and some behind-the-scenes support. Its job is to prove that a real client can talk to the server, sign in, configure it, use its features, and keep working as conversations and tools change over time.

One part checks the core public surface: login, account limits, startup rules, settings, feature flags, discovery of available models and capabilities, file and process access, and remote control. Another part tests the live connection layer, especially WebSocket, which is a long-lived two-way network link. These tests cover connecting, reconnecting, trust checks, version rules, hidden feature gates, and real-time conversation traffic.

A third part exercises extension points: plugins, marketplaces, MCP servers for outside tools and resources, local commands, shells, and add-on tools like search or image generation. The last part follows the life of a conversation from start to finish: creating threads, resuming and branching them, running and interrupting turns, storing summaries, and keeping session state consistent. Together, these suites act like a full dress rehearsal for the server.

## Sub-stages

- [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files
- [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files
- [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files
- [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files
