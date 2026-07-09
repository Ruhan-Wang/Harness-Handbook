# Transport and server runtime initialization  `stage-8`

This stage is part of startup for any mode that acts like a server. Its job is to open the “roads” that messages will travel on, so requests and notifications can move between the app and other programs. In this system, many of those messages use JSON-RPC, which is a simple format for sending commands and getting replies.

One part brings up the main app server and its daemon, a background helper process. It can start the server, reconnect to one that is already running, and expose ways to talk to it over standard input/output, local machine sockets, or WebSockets. It also sets up remote-control features, keeps track of connected clients, and makes sure replies go back to the right place.

The other part starts sidecar servers and bridges. These are helper services that let outside tools connect through child processes, local sockets, HTTP, SOCKS, WebSocket, or MCP. Together, these pieces act like adapters on a power strip: different plug shapes on the outside, but all feeding into the same running server and message flow.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-runtime-executor` — The shared async runtime and task execution base that long-lived services, background jobs, and request handlers run on.
- `reg-config-manager` — The shared live config service that lets different parts of the system ask for the latest final settings.
- `reg-feature-flags` — The on/off switches for experimental or optional behavior that are resolved once and then checked throughout the app.
- `reg-mcp-server-catalog` — The resolved set of MCP servers and their runtime metadata used for routing, diagnostics, and policy decisions.
- `reg-auth-session` — The saved sign-in state for the current user or install, including which auth mode is active and whether it is still valid.
- `reg-server-runtime-and-client-registry` — The live server-side state for connected clients, active transports, and reply routing for daemon and app-server modes.
- `reg-remote-control-state` — The enablement, pairing, and connection state for remote-control features shared across server components.
- `reg-client-notification-state` — The current outgoing user-visible notifications, thread-item updates, live statuses, and replay data prepared for clients.
- `reg-network-client-stack` — The shared HTTP and transport client setup, including retries, certificates, streaming behavior, and common error handling.
- `reg-telemetry-context` — The shared trace, metric, and analytics context that follows work across requests, tools, streams, and shutdown.
- `reg-model-context-protocol-cache` — The cached Model Context Protocol client/server connection state and transport handles reused across MCP calls instead of reconnecting each time.
- `reg-active-command-exec-sessions` — The live registry of standalone command-execution and PTY sessions, including buffered output and control channels, shared across process RPC requests.
