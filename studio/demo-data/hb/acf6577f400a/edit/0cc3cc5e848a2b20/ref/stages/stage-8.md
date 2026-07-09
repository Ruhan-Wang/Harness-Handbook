# Transport and server runtime initialization  `stage-8`

This stage is the runtime bring-up layer that sits after basic process startup but before the main request loop. Its job is to make the server reachable: it creates the JSON-RPC transports, listener sockets, relay channels, and connection registries that all later requests and notifications depend on.

The app-server and daemon transport bring-up sub-stage covers the primary server path. The daemon discovers or launches detached app-server processes, tracks them with PID files, probes readiness over its control socket, and supports remote-control enable/disable flows. On the server side, the app-server initializes configuration and state, opens stdio, Unix-socket, and WebSocket transports, routes outgoing messages per connection, enforces initialization before full protocol use, and also offers an in-process transport for embedded callers. Its remote-control pieces persist desired state, pair and enroll clients, and maintain reconnecting remote sessions. Client wrappers then expose these transports as usable async APIs for CLI and TUI code.

The execution and integration sidecar servers sub-stage brings up adjacent long-lived services: exec-server listeners and clients, Noise-authenticated relay streams, MCP runtimes and server loops, plus stdio↔UDS, HTTP responses, and SOCKS/HTTP proxy bridges. Together, these components establish every supported channel through which the system communicates.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-process-env` — The process-wide environment and bootstrap process state, including argv-derived mode, sanitized env vars, PATH aliases, and runtime initialization assumptions.
- `reg-runtime-environment-catalog` — The validated and cached execution-environment objects derived from shell snapshots, local probing, and remote environment registration.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
- `reg-feature-flags` — The resolved startup and runtime feature enablement state used to gate behavior, APIs, and experimental surfaces.
- `reg-sandbox-policy` — The enforceable sandbox, filesystem, network, and capability policy derived from config and rendered for execution backends.
- `reg-mcp-server-set` — The declared and runtime-resolved MCP server inventory and transport metadata used for routing, approvals, and prompt contributions.
- `reg-auth-state` — The active authentication mode and credential state machine, including restored tokens, refresh state, and mode restrictions.
- `reg-transport-registry` — The live registry of listeners, sockets, channels, and connection identifiers for app-server, exec-server, relays, and sidecar transports.
- `reg-remote-control-state` — The persisted and live remote-control enrollment, pairing, desired-state, and reconnecting session state.
- `reg-server-init-state` — The server-side initialization and per-connection readiness state that gates full protocol use and orderly request admission.
- `reg-network-policy-and-proxy` — The shared outbound networking policy, proxying, cookie, CA, and forwarding state applied across HTTP, websocket, relay, and IPC clients.
- `reg-telemetry-context` — The process- and session-scoped observability context, including tracing/logging setup and stable auth, model, tool, session, and turn attribution.
- `reg-connection-subscriptions` — The per-connection and per-thread listener/subscription state that determines which clients receive ordered thread, process, and status notifications.
