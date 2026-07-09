# Core end-to-end session, transport, tool, and feature suites  `stage-23.2.4`

This stage is a large end-to-end test area for Codex’s live user sessions. It checks the main work loop and the shared support around it: sending requests to AI models, receiving streamed replies, remembering conversation state, choosing models, using tools, asking for approvals, and working with helper agents or remote machines.

The transport suites test the “wires” to model providers, including HTTP, WebSocket, realtime, retries, headers, quotas, and streamed responses. The history and persistence suites test Codex’s memory: saving sessions, compacting long chats, resuming, forking, and restoring tool logs. The prompt and model-selection suites check that each model request is packed with the right instructions, context, tools, and limits. The multi-agent suites test child agents, delegation, shared limits, job queues, and remote environments. The approvals and hooks suites test safety gates that pause, block, review, or modify actions. The tool and runtime item suites test shell commands, patches, plugins, external app tools, images, searches, and the user-visible event stream. Together, these tests prove the whole session behaves safely and predictably.

## Sub-stages

- [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files
- [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files
- [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files
- [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files
- [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files
- [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files
