# Transport and server runtime initialization  `stage-8`

This stage is the runtime bring-up layer that sits after basic process startup but before the main request loop. Its job is to make the server reachable: it creates the JSON-RPC transports, listener sockets, relay channels, and connection registries that all later requests and notifications depend on.

The app-server and daemon transport bring-up sub-stage covers the primary server path. The daemon discovers or launches detached app-server processes, tracks them with PID files, probes readiness over its control socket, and supports remote-control enable/disable flows. On the server side, the app-server initializes configuration and state, opens stdio, Unix-socket, and WebSocket transports, routes outgoing messages per connection, enforces initialization before full protocol use, and also offers an in-process transport for embedded callers. Its remote-control pieces persist desired state, pair and enroll clients, and maintain reconnecting remote sessions. Client wrappers then expose these transports as usable async APIs for CLI and TUI code.

The execution and integration sidecar servers sub-stage brings up adjacent long-lived services: exec-server listeners and clients, Noise-authenticated relay streams, MCP runtimes and server loops, plus stdio↔UDS, HTTP responses, and SOCKS/HTTP proxy bridges. Together, these components establish every supported channel through which the system communicates.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-process-environment` — The process-wide environment and argv/arg0-derived launch context that is sanitized, augmented, and then reused by later startup and runtime code.
- `reg-codex-home-install-context` — The discovered installation layout, CODEX_HOME location, bundled assets, helper binaries, and machine-local installation facts shared across startup and maintenance flows.
- `reg-helper-binaries-materialization` — The versioned shared helper-binary materialization state under codex_home that later execution and sandbox paths rely on.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved experimental-feature and startup feature-enablement state that gates runtime behavior and can be surfaced or updated through server APIs.
- `reg-permission-policy` — The compiled permission profiles, sandbox mode, filesystem/network ACLs, and related enforcement policy shared by sessions, tools, and transports.
- `reg-mcp-server-catalog` — The materialized MCP declarations, runtime server metadata, and contribution overlays used for connection setup, routing, and prompt/tool exposure.
- `reg-auth-state` — The active authentication mode and loaded credential state selected from storage or environment, including refresh and mode restrictions.
- `reg-state-runtime` — The shared SQLite-backed runtime handle and opened databases that provide durable local state services to higher layers.
- `reg-app-server-connections` — The live app-server transport/listener/connection registry and per-connection routing state that all RPC handling depends on.
- `reg-remote-control-state` — The persisted and live remote-control desired state, pairing/enrollment records, and reconnecting remote-session state.
- `reg-exec-server-runtime` — The exec-server listener, client, process-control, and environment-discovery runtime state shared across request processing and execution.
- `reg-mcp-runtime-connections` — The live MCP runtime sessions and transport connections maintained for tool routing and integration access.
- `reg-network-transport-policy` — The shared outbound networking/proxy/TLS/cookie and local-IPC policy state that governs how clients and transports may connect.
- `reg-observability-context` — The global tracing/logging/metrics context and stable session-turn-auth-model-tool tags attached to emitted telemetry throughout runtime.
- `reg-daemon-process-registry` — The persisted and live daemon/app-server process-discovery state, including PID files, readiness probes, and launched detached server instances reused across client attach and restart flows.
- `reg-connection-pending-initialization` — Per-connection initialization/handshake state that gates which RPC methods are allowed before a transport session is fully initialized.
- `reg-listener-subscriptions` — The per-thread and per-connection listener/subscription registry that tracks who is watching which thread or process streams for ordered notifications.
