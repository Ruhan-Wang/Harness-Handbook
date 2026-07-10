# Core end-to-end session, transport, tool, and feature suites  `stage-23.2.4`

This stage is the big end-to-end proving ground for the system’s main work during a live session. It checks the full user-visible journey: starting a conversation, sending requests out, receiving streamed replies, using tools, asking for approval, saving progress, and continuing later. If earlier stages test individual parts, this one tests the whole machine while it is running.

The transport and provider suites check the “roads” between the app and external AI services: request headers, compression, streaming, WebSocket or WebRTC live channels, retries, and fallback when something goes wrong. The session history and persistence suites test memory over time, making sure saved sessions, trimmed history, resumes, forks, and durable storage still preserve the conversation’s meaning.

The request-shaping and model-selection suites verify what is packed into each model request and which model is chosen. The multi-agent and remote-environment suites test teamwork: parent and child agents, job routing, and isolated remote workspaces. The approvals, hooks, and review suites act like gatekeepers, checking permissions, pauses for user input, and review flows. Finally, the tool and plugin suites confirm that commands, apps, plugins, and outputs run safely and are reported back in the right form.

## Sub-stages

- [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files
- [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files
- [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files
- [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files
- [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files
- [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files
