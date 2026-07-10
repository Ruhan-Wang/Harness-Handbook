# API, extension, hook, MCP, and trace schemas  `stage-18.4`

This stage is a shared “dictionary of forms” for parts of the system that talk across boundaries. It is not one step in startup or shutdown. Instead, it supports the main work by making sure outside services, plugins, tools, and tracing all agree on the exact shape of messages.

One part defines code-mode protocol types: the common request and response shapes for running code, waiting for results, returning text or images, and tracking long-lived code sessions. Another part defines the public API schemas used when this system talks to the Codex service, including normal requests, streaming updates, websocket messages, image and search payloads, and a standard error format.

The extension and hook contracts are the rules plugin authors code against. They describe what callbacks exist, what data extensions receive, what the host can offer them, and how hook messages are shaped. Tool and protocol schemas do the same for tool calls, permissions, user questions, planning, shell actions, and MCP-related tool data. Finally, wire models define cross-process message formats for exec servers and sandboxing, while rollout trace models store a compact history of what happened during a run.

## Sub-stages

- [Code-mode protocol contract types](stage-18.4.1.md) `stage-18.4.1` — 5 files
- [Public API request and transport schemas](stage-18.4.2.md) `stage-18.4.2` — 6 files
- [Extension and hook interface contracts](stage-18.4.3.md) `stage-18.4.3` — 22 files
- [Tool and protocol contract schemas](stage-18.4.4.md) `stage-18.4.4` — 18 files
- [MCP, exec, and sandbox wire models](stage-18.4.5.md) `stage-18.4.5` — 6 files
- [Shared extension backends and rollout trace models](stage-18.4.6.md) `stage-18.4.6` — 3 files
