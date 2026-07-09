# Transport and server runtime initialization  `stage-8`

This stage is the runtime bring-up layer that sits after basic process startup but before the main request loop. Its job is to make the server reachable: it creates the JSON-RPC transports, listener sockets, relay channels, and connection registries that all later requests and notifications depend on.

The app-server and daemon transport bring-up sub-stage covers the primary server path. The daemon discovers or launches detached app-server processes, tracks them with PID files, probes readiness over its control socket, and supports remote-control enable/disable flows. On the server side, the app-server initializes configuration and state, opens stdio, Unix-socket, and WebSocket transports, routes outgoing messages per connection, enforces initialization before full protocol use, and also offers an in-process transport for embedded callers. Its remote-control pieces persist desired state, pair and enroll clients, and maintain reconnecting remote sessions. Client wrappers then expose these transports as usable async APIs for CLI and TUI code.

The execution and integration sidecar servers sub-stage brings up adjacent long-lived services: exec-server listeners and clients, Noise-authenticated relay streams, MCP runtimes and server loops, plus stdio↔UDS, HTTP responses, and SOCKS/HTTP proxy bridges. Together, these components establish every supported channel through which the system communicates.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-codex-home` — The validated writable CODEX_HOME filesystem root used for shared local state, helper materialization, caches, logs, and databases.
- `reg-runtime-environment-catalog` — The validated and cached execution-environment objects built from shell snapshots, local probing, and remote environment inputs.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved startup and runtime feature enablement set that gates experimental and product capabilities.
- `reg-mcp-server-catalog` — The resolved set of MCP server declarations and runtime metadata used for launch, routing, approvals, and per-session availability.
- `reg-sandbox-policy` — The enforceable filesystem, network, and sandbox-mode policy derived from configuration and translated into execution-specific settings.
- `reg-auth-state` — The central authentication mode, persisted credentials, token-refresh state, and active identity selection for the current runtime.
- `reg-state-runtime` — The shared SQLite-backed state runtime handle that opens, migrates, checks, and shuts down the application's durable databases.
- `reg-backend-clients` — The initialized reusable outbound service clients and adapters for backend, model, cloud-tasks, ChatGPT, and related remote APIs.
- `reg-connection-registry` — The live registry of server transports, connection identities, listeners, and per-connection routing state.
- `reg-daemon-remote-control-state` — The persisted and live daemon/app-server remote-control enablement, pairing, enrollment, and reconnect session state.
- `reg-exec-server-process-registry` — The exec-server's logical process registry and associated per-process control/state used across executor RPCs.
- `reg-telemetry-context` — The process/session/turn-scoped observability context used to stamp logs, traces, metrics, and analytics with stable runtime identity.
- `reg-realtime-session-state` — The active realtime conversation/session state, including start/append/stop lifecycle and associated thread-scoped transport/runtime coordination.
- `reg-mcp-client-sessions` — The live RMCP/MCP transport session state and client handles kept across requests for remote connector/tool access and MCP runtime communication.
- `reg-remote-control-client-attestation-state` — The persisted and runtime client-attestation token/material state used for remote-control pairing and authenticated remote sessions.
- `reg-process-supervision-state` — The daemon/app-server detached-process supervision state such as PID files, readiness probes, and launch ownership used to find, launch, and monitor server processes.
