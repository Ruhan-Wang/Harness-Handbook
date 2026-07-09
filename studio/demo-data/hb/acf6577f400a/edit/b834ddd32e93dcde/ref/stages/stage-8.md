# Transport and server runtime initialization  `stage-8`

This stage is part of startup for any mode that acts like a server. Its job is to open the “roads” that messages will travel on, so requests and notifications can move between the app and other programs. In this system, many of those messages use JSON-RPC, which is a simple format for sending commands and getting replies.

One part brings up the main app server and its daemon, a background helper process. It can start the server, reconnect to one that is already running, and expose ways to talk to it over standard input/output, local machine sockets, or WebSockets. It also sets up remote-control features, keeps track of connected clients, and makes sure replies go back to the right place.

The other part starts sidecar servers and bridges. These are helper services that let outside tools connect through child processes, local sockets, HTTP, SOCKS, WebSocket, or MCP. Together, these pieces act like adapters on a power strip: different plug shapes on the outside, but all feeding into the same running server and message flow.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-runtime-bootstrap` — The shared async runtime and early process setup that later code depends on to run tasks safely.
- `reg-effective-config` — The final merged settings from defaults, managed config, user files, project files, thread overrides, and command-line flags.
- `reg-mcp-server-catalog` — The current set of configured MCP servers and their runtime launch details for routing tool calls.
- `reg-server-runtime` — The live server and daemon runtime that accepts clients, routes messages, and keeps shared server services running.
- `reg-transport-endpoints` — The active communication endpoints like stdio, local sockets, websockets, HTTP bridges, and sidecar links.
- `reg-connection-registry` — The shared record of connected clients, connection ids, subscriptions, and where replies should be sent.
- `reg-remote-control-state` — The enablement, pairing, and client-management state for remote-control access.
- `reg-shutdown-gate-and-cleanup` — The shared shutdown state that stops new work, tracks active handlers, and waits for cleanup to finish.
- `reg-network-client-stack` — The shared HTTP and transport client infrastructure used for requests, retries, cookies, streams, and relays.
- `reg-observability-pipeline` — The shared traces, logs, and metrics pipeline that records what the system is doing across its lifetime.
- `reg-connection-pool-and-session-cache` — The shared pool/cache of long-lived outbound service connections and session handles, especially for MCP and related transports, reused and refreshed across requests and threads.
