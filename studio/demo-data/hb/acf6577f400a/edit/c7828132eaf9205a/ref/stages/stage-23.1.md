# App-server test suites and protocol verification  `stage-23.1`

This stage is the app server’s full safety net. It sits behind the scenes and checks that the server’s message format, internal rules, real-world behavior, and support tools all keep working as the code changes.

One part verifies the protocol, meaning the exact JSON messages sent between pieces of the system. These tests make sure data is turned into JSON and back correctly, and that published schema files still match what the code really sends.

Another part tests the daemon and transport layers. The daemon is the long-running helper process in the background. The transport layer is the path messages travel through, such as sockets or standard input/output. These tests check updating, connection routing, broadcasts, pairing, and the special test client used to drive realistic scenarios.

A third part covers app-server unit tests and shared fixtures. Unit tests check small rules in isolation. Fixtures are reusable fake servers, files, accounts, and histories that create controlled test setups.

Finally, the integration suites run the whole server like a real client would, checking login, settings, conversations, tools, live connections, and shutdown. Together, these parts test the server from the smallest wire detail to full end-to-end use.

## Sub-stages

- [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files
- [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files
- [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files
- [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files
