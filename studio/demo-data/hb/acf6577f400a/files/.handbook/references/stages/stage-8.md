# Transport and server runtime initialization  `stage-8`

This stage sets up the communication roads used by server-style runs of the system. It happens during startup and then stays active during the main work loop, carrying requests, replies, and notifications between clients, servers, and helper processes. Most of these messages use JSON-RPC, a simple pattern where one side sends a named request in JSON and the other side sends back a matching response.

One part brings up the main app server and its daemon, which is a background process that can be started, stopped, checked, and reused. It opens transports such as standard input/output, Unix sockets, and WebSockets, then routes messages through the server and remote-control connections.

The other part starts sidecar servers: small helper services that sit beside the main process. Exec servers run commands through shared channels, encrypted relays connect remote clients safely, MCP servers expose tools, and proxy bridges connect local programs or network traffic under controlled rules. Together, these pieces form the switchboard that lets the rest of the system talk reliably.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-tls-crypto-provider` — The one process-wide cryptography provider chosen early so HTTPS and other TLS connections use the same security engine.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-realtime-stream-state` — Active realtime conversation state, including audio/text stream sessions, WebSocket transport state, buffers, and stop/cancel lifecycle data.
- `reg-filesystem-watch-subscriptions` — Active file and directory watch subscriptions, invalidation signals, and watcher-to-client mappings used for skills, plugin/config refreshes, and app-server file APIs.
- `reg-windows-sandbox-readiness` — Prepared Windows sandbox accounts, helper readiness, setup status, and client-visible sandbox availability separate from the policy rules themselves.
- `reg-attestation-state` — Client or host attestation provider state and generated proof metadata used to attach optional attestation headers to upstream requests.
- `reg-process-hardening-state` — Process-wide hardening status and OS security settings applied at bootstrap, such as dump/inspection/tamper restrictions that affect the rest of the run.
- `reg-ide-integration-state` — Active IDE-link state such as connected IDE clients, workspace metadata, open file or selection context, and IDE details injected into prompts or server notifications.
- `reg-outgoing-transport-buffers` — Queued outbound protocol messages, write buffers, and backpressure state for app-server, daemon, exec-server, and remote transports.
