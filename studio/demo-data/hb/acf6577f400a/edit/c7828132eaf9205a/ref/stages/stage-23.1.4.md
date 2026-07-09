# App-server integration suites  `stage-23.1.4`

This stage is the big “prove the whole server works from the outside” test area. It sits mostly in the system’s main working path, but it also checks startup mistakes and clean shutdown. Think of it as a full dress rehearsal: a client connects, signs in, changes settings, starts conversations, uses tools, and the tests confirm the server keeps its promises all the way through.

One part checks the basics of identity, settings, discovery, and core remote calls. “Remote calls” here means requests a client sends to the server over the API. These tests cover login, limits, configuration files, feature flags, file and process actions, and remote control.

Another part focuses on the live connection itself, especially WebSocket, a network link that stays open for two-way messages. It checks handshakes, reconnects, protocol rules, and shutdown behavior.

A third part tests extensions and tools: plugins, marketplaces, MCP tool servers, command runners, and built-in helpers like search.

The last part follows conversation threads over time: creating them, running turns, interrupting or steering work, saving state, resuming later, reviewing results, and cleaning up. Together, these suites show whether the app server behaves correctly in real use.

## Sub-stages

- [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files
- [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files
- [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files
- [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files
