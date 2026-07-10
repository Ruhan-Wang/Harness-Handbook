# App-server test suites and protocol verification  `stage-23.1`

This stage is the app server’s big safety net. It lives behind the scenes and makes sure the server keeps speaking the right language, moving data safely, and behaving correctly from startup through normal use. Think of it as a mix of spell-checker, crash test, and dress rehearsal.

One part verifies the protocol, the message format clients and servers use to talk. It checks JSON encoding and decoding, compatibility rules, and saved schema “blueprints” so accidental message changes are caught early.

Another part tests the plumbing around the server: the daemon that stays running in the background, update logic, local socket connections, transport rules, and a special test client that can connect and act like a real user or tool.

A third part covers focused unit tests and shared fixtures. These fixtures are reusable test supplies such as fake config files, mock services, and a harness that can launch a real test server process.

Finally, the integration suites run full end-to-end scenarios: signing in, connecting live, using plugins and tools, and carrying conversations through their whole life cycle. Together, these layers catch both tiny mistakes and system-wide breakage.

## Sub-stages

- [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files
- [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files
- [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files
- [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files
