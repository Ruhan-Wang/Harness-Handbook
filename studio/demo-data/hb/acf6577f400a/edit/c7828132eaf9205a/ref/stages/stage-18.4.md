# API, extension, hook, MCP, and trace schemas  `stage-18.4`

This stage is the system’s shared rulebook for many important boundaries outside the core protocol crates. It is mostly behind-the-scenes support. When the system talks to outside clients, extensions, helper processes, or trace storage, these schemas define the exact shape of the data so each side can trust what it receives.

One part defines code-mode protocol types: the standard requests, replies, session IDs, and content formats used when code is run and results are returned. Another part covers the public API surface: request and response bodies, streaming events, WebSocket messages, image and search payloads, and a common error format.

The extension and hook contracts describe how plugins and hook handlers are called, what events they can see, what capabilities they may use, and what their replies must look like. The tool and protocol schemas do the same for tool calls, tool specifications, plan and permission messages, and related shared payloads.

The MCP, exec, and sandbox wire models define cross-process messages for remote execution, event streams, and privilege or sandbox control. Finally, the rollout trace models describe how a run is recorded afterward, including sessions, runtime activity, and references to large stored payloads.

## Sub-stages

- [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files
- [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files
- [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files
- [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files
- [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files
- [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files
