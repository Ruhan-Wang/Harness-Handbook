# Core end-to-end session, transport, tool, and feature suites  `stage-23.2.4`

This stage is the big end-to-end check for the system’s main “live session” experience. It sits in the heart of the story: once a conversation is running, these tests make sure requests go out correctly, replies stream back, tools run safely, and the session can keep its place over time.

One part tests transport and provider protocols, which means the rules for talking to outside model services over the network. It checks request shape, streaming, retries, and fallback when connections fail. Another part tests session history and saved state, making sure old conversation can be shortened, stored, resumed, or replayed without losing important context.

The request-shaping and model-selection suites make sure the system packs the right instructions and picks the right model before asking for help. The multi-agent and remote-environment suites cover teamwork: parent and child agents, shared limits, message passing, and work done in a separate remote workspace.

The approval, permission, hook, and review tests act like gatekeepers, checking what must be allowed, blocked, or reviewed. Finally, the tool and plugin suites verify that commands, file edits, integrations, and progress updates all work end to end and are reported back clearly.

## Sub-stages

- [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files
- [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files
- [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files
- [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files
- [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files
- [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files
