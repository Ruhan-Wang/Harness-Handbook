# API, extension, hook, MCP, and trace schemas  `stage-18.4`

This stage is shared behind-the-scenes support. It does not drive startup, the main agent loop, or shutdown by itself. Instead, it defines the public message shapes that many parts of the system must agree on, like standard forms used by different departments.

The code-mode contract types describe how code execution sessions, runtime messages, tool descriptions, and results such as text or images are represented. The public API schemas define requests, responses, errors, streaming events, search payloads, image payloads, and realtime WebSocket messages for outside services. The extension and hook contracts give plugins safe, stable ways to receive events, store state, add context, and declare hook commands. The tool and protocol schemas describe model-visible tool calls, permission requests, plans, human questions, and shared result formats. The MCP, exec, and sandbox wire models define exact messages that cross process boundaries, including command execution, event streams, and permission escalation. Finally, the rollout trace models describe saved histories of agent runs, with sessions, runtime events, and references to large payloads. Together, these schemas keep independent pieces speaking the same language.

## Sub-stages

- [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files
- [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files
- [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files
- [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files
- [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files
- [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files
