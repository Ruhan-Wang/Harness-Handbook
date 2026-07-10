# Transport and server runtime initialization  `stage-8`

This stage is the system’s communications setup for server-style running. It happens at startup and early runtime, before the main work can flow. Its job is to open the paths that requests and notifications will travel through, much like setting up doors, phone lines, and switchboards before a busy office opens.

One part brings up the app server and the daemon, the background manager that can start, watch, and stop server processes. It prepares local channels such as standard input/output, Unix sockets, WebSockets, and remote-control links. It also keeps track of running servers, checks when they are ready, and gives other tools a safe way to connect to the right place.

The other part starts integration and helper servers. These are adapters that let outside tools speak to the system using the transport they expect. It includes exec-server links, MCP server loops, secure relay paths, and small bridge programs and proxies that convert one connection style into another.

Together, these pieces establish the live connection network the rest of the system depends on.

## Sub-stages

- [App-server and daemon transport bring-up](stage-8.1.md) `stage-8.1` — 23 files
- [Execution and integration sidecar servers](stage-8.2.md) `stage-8.2` — 17 files

## 📊 State Registers Touched

- `reg-mcp-client-and-connections` — The live client setup and active connections for MCP servers that provide remote tools and integrations.
- `reg-server-runtime` — The live app-server and daemon runtime state that tracks running server processes and how to reach them.
- `reg-transport-channels` — The currently open communication channels like stdio, sockets, websockets, and relays that requests travel through.
- `reg-remote-control-state` — The current remote-control enablement, pairing, and client connection state for controlling the app from elsewhere.
- `reg-sandbox-and-exec-policy` — The active sandbox and command-execution rules that decide what commands, files, and network actions are allowed.
- `reg-proxy-and-network-policy-state` — The current proxy and network-access control setup that decides how external connections are routed or restricted.
- `reg-transport-readiness-state` — The live readiness/health state of server and helper transports, used to know when endpoints are connectable and when watched processes or bridges have become ready or failed.
