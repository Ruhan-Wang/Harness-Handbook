# App-server test suites and protocol verification  `stage-23.1`

This stage is the app server’s full safety net. It lives mostly behind the scenes, but it checks nearly every part of the server’s story: how messages are shaped, how the server behaves in small pieces, how whole features work end to end, and whether support systems like updating and background processes stay safe.

One part verifies the protocol, meaning the message format used on the wire. It makes sure data is turned into JSON-RPC messages correctly and that saved schema files still match what the code generates, so outside clients do not break by surprise.

Another part covers unit tests and shared fixtures. Unit tests check small rules in isolation, while fixtures provide fake services, saved data, and a harness that starts a real server for realistic tests.

The integration suites are the dress rehearsal. They drive login, settings, conversations, plugins, realtime connections, and tool use the way a real client would.

The remaining tests check transport, the path messages travel through sockets and routing rules, plus daemon updating and process tracking. A dedicated test client ties these larger checks together by connecting to the server and sending real requests.

## Sub-stages

- [Protocol schema and wire-format verification](stage-23.1.1.md) `stage-23.1.1` — 4 files
- [Daemon, transport, and test-client support tests](stage-23.1.2.md) `stage-23.1.2` — 13 files
- [App-server unit tests and shared integration fixtures](stage-23.1.3.md) `stage-23.1.3` — 20 files
- [App-server integration suites](stage-23.1.4.md) `stage-23.1.4` — 78 files
