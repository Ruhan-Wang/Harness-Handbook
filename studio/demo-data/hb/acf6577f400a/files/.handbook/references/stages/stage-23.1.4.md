# App-server integration suites  `stage-23.1.4`

This stage is the top-level end-to-end integration test layer for the app server. It spans startup validation, live request handling, long-lived client connections, and persisted conversation teardown/reload paths, proving that the server’s public API behaves correctly as a whole rather than as isolated components.

One group covers auth, configuration, discovery, and core JSON-RPC operations: startup rejects bad config, clients initialize with the right capabilities, accounts and quotas behave correctly, feature flags persist, and operational RPCs such as filesystem, process execution, sandbox setup, and remote-control pairing expose the expected contracts. A second group exercises transport and protocol boundaries, validating websocket and Unix-socket connection lifecycles, graceful shutdown/restart, attestation headers, experimental API gating, and realtime conversation behavior across WebSocket and WebRTC.

The extensibility suites verify plugins, marketplace flows, MCP servers, commands, and extension-backed tools from installation through invocation and cleanup. Finally, the thread/turn lifecycle suites test the core conversational state machine: creating and mutating threads, executing turns and reviews, persisting and reloading session state, and emitting the correct status, safety, and synchronization notifications.

## Sub-stages

- [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files
- [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files
- [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files
- [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files
