# App-server integration suites  `stage-23.1.4`

This stage is the system’s full dress rehearsal for the app server. Instead of checking tiny pieces in isolation, it talks to the server the way a real client would and verifies that the whole thing works from startup checks through everyday use. It is mostly about the server’s main working life, with some startup validation and shared support around it.

One part checks the basics: signing in and out, token refresh, account limits, startup config validation, and the server’s catalog-style APIs for settings, models, features, and permission profiles. It also tests practical actions such as file access, running programs, sandbox setup, and remote-control pairing.

Another part focuses on live connections. It tests WebSocket and WebRTC links, reconnect behavior, clean shutdown signals, trust tokens during the initial handshake, and rules for hidden experimental features.

A third part covers extension points: plugins, marketplaces, hooks, skills, MCP tool servers, shell commands, file search, image generation, and web search.

The last part follows conversation life cycles end to end: creating threads, resuming and branching them, running turns, interrupting or steering them, saving state, reviewing results, and keeping clients updated consistently.

## Sub-stages

- [App-server integration suites — auth, config, discovery, and core RPC surfaces](stage-23.1.4.1.md) `stage-23.1.4.1` — 16 files
- [App-server integration suites — transport, protocol contracts, and client connection behavior](stage-23.1.4.2.md) `stage-23.1.4.2` — 5 files
- [App-server integration suites — plugins, marketplace, MCP, and tool/executor integrations](stage-23.1.4.3.md) `stage-23.1.4.3` — 24 files
- [App-server integration suites — thread, turn, review, and session-state lifecycle](stage-23.1.4.4.md) `stage-23.1.4.4` — 33 files
