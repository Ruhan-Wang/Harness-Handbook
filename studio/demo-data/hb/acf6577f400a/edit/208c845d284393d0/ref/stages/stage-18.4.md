# API, extension, hook, MCP, and trace schemas  `stage-18.4`

This stage is shared support code that sits around the edges of the system. It is not the main loop that answers a request. Instead, it defines the agreed data shapes for several important borders: the public API, code execution mode, extensions and hooks, MCP connections, low-level exec messages, and rollout traces. You can think of it as the system’s rulebook and set of official forms.

The code-mode contract types define how code-running requests, results, tool calls, and sessions are described so runtimes and callers stay in sync. The public API schemas do the same at the outside boundary, covering requests, responses, streaming events, websocket messages, and errors.

The extension and hook contracts tell plugins what the host can offer, what events they can observe, and what inputs and outputs a hook must use. The tool and protocol schemas define the exact message formats for tools, permissions, planning, and related protocol features.

The MCP, exec, and sandbox wire models describe the raw messages used between processes. Finally, the rollout trace models record what happened during a run in a compact, linked way. Together, these pieces let many separate parts communicate clearly and consistently.

## Sub-stages

- [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files
- [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files
- [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files
- [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files
- [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files
- [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files
