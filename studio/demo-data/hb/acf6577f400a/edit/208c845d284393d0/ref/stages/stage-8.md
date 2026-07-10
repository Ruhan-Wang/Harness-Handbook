# Transport and server runtime initialization  `stage-8`

This stage is the “open the communication channels” part of startup for any mode that can act as a server. Before the system can do its real work, it needs working paths for messages such as requests, replies, and notifications. In practice, this stage brings those paths online and makes sure clients can find and use the right server process.

One part, app-server and daemon transport bring-up, starts or locates the main background server, checks that it is alive, and opens the normal ways to talk to it. That includes standard input/output, Unix sockets, and WebSocket connections, plus remote-control features and the rules for the first handshake, the initial “hello” exchange that proves both sides are ready.

The other part, execution and integration sidecar servers, adds extra helper servers around the main app. These adapters let outside tools connect through different channels, including stdio, WebSocket, HTTP, and secure relay links. They also support remote environments, session reconnects, MCP tool servers, and proxy bridges. Together, these pieces build the message roads the rest of the system will drive on.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-shell-environment-snapshot` — The captured shell environment, aliases, options, and derived execution-environment files that later work can reuse.
- `reg-mcp-server-catalog` — The materialized list of MCP servers and their launch metadata used for routing, diagnostics, and approval checks.
- `reg-server-process-state` — The shared runtime state of the app server or daemon, including whether it is running, reachable, and how clients find it.
- `reg-transport-connections` — The active communication channels and connection identities for stdio, sockets, websockets, relay links, and sidecar servers.
- `reg-rpc-handshake-and-protocol-state` — The per-connection protocol readiness and negotiated message rules established during the initial hello exchange.
- `reg-protocol-contracts` — The shared message and schema definitions that keep requests, responses, notifications, and stored data consistent across components.
- `reg-http-client-and-network-policy` — The shared networking client setup for HTTP, retries, certificates, cookies, proxies, and safe outbound connection rules.
- `reg-relay-and-forwarding-state` — The active state for forwarded and relay-based traffic, including chunking, framing, encryption, and direct-vs-forwarded routing.
- `reg-transport-write-queues` — The per-connection outgoing message buffers and ordered write state that carry server responses and notifications across transport tasks.
- `reg-remote-control-state` — The persistent and live state for remote-control enablement, pairing, client management, and status used by the server and external controllers.
- `reg-pending-transport-chunk-assembly` — The in-flight state for splitting, reassembling, and streaming large forwarded or relayed messages and bodies across transport boundaries.
