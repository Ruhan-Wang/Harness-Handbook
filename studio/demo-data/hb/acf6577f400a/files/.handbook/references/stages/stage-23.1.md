# App-server test suites and protocol verification  `stage-23.1`

This stage is the app server’s safety workshop. It is not part of normal startup, daily work, or shutdown. Instead, it runs during development and continuous testing to prove that the server still speaks the right language, starts correctly, connects to clients, and supports real workflows.

The protocol tests act like a ruler for messages. They check that JSON-RPC and remote-control data keep the exact shapes clients expect, and that generated schemas have not changed by accident. The daemon and transport tests check the background server process, update decisions, socket connections, client routing, and the special test client used to exercise the system safely.

The unit tests look inside the app server’s smaller parts, such as configuration import, command-line overrides, tracing, error reporting, and conversation state. Shared fixtures build a pretend world with fake accounts, models, saved sessions, and AI responses, so tests do not need real services.

Finally, the integration suites put everything together. They start the server like a real client would, send requests, run conversations, use tools and plugins, and verify the visible behavior from end to end.

## Sub-stages

- [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files
- [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files
- [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files
- [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files
