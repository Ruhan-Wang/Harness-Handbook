# App-server test suites and protocol verification  `stage-23.1`

This stage is the app server’s full verification envelope: a cross-cutting test layer that sits outside runtime startup and the main request loop, but continuously proves that the server, its protocol boundary, and its supporting daemon/update machinery behave correctly end to end.

The protocol schema and wire-format verification sub-stage acts as the executable contract for JSON-RPC, remote-control, and generated schema artifacts, catching serde regressions and compatibility breaks before they reach clients. The app-server unit tests and shared integration fixtures sub-stage locks down internal behaviors such as config migration, request processing, remote-control validation, and thread/session state, while also supplying reusable harnesses, fake services, and fixture builders for larger suites. The app-server integration suites then run the real server through startup, live RPC handling, transport lifecycles, plugin and MCP flows, realtime features, and persisted conversation reload paths to confirm public API behavior as a whole. Finally, the daemon, transport, and test-client support tests verify PID/update semantics, Unix-socket and stdio/websocket transport rules, remote-control HTTP endpoints, and the dedicated test client used to drive realistic scenarios across the rest of the stage.

## Sub-stages

- [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files
- [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files
- [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files
- [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files
