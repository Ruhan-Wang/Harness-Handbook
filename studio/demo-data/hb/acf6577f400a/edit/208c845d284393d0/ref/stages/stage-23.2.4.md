# Core end-to-end session, transport, tool, and feature suites  `stage-23.2.4`

This stage is the big “real-world behavior” check for the core of the system. It sits in the main work of a live session and follows what happens as a conversation sends requests, streams replies, chooses tools, asks for approval, saves its place, and sometimes branches into helper agents or remote workspaces. In other words, it tests the whole journey a user can actually experience.

Its parts fit together like a full dress rehearsal. The transport and provider suites check the roads in and out: building requests correctly, streaming replies, and recovering from failures. The session history and persisted state suites make sure the system remembers where it was, can shrink old history into a shorter summary, and can resume after interruption. The model-shaping suites decide what the AI model sees and which model is used. The multi-agent and remote-environment suites cover teamwork and off-machine execution. The approvals, permissions, hooks, and review suites act as gatekeepers. Finally, the tool, shell, plugin, and runtime-item suites verify that available tools run safely and that the resulting event log tells an accurate story.

## Sub-stages

- [Transport, streaming, and provider protocol suites](stage-23.2.4.1.md) `stage-23.2.4.1` — 16 files
- [Session history, compaction, resume, and persisted state suites](stage-23.2.4.2.md) `stage-23.2.4.2` — 13 files
- [Model request shaping, prompt assembly, and runtime model-selection suites](stage-23.2.4.3.md) `stage-23.2.4.3` — 17 files
- [Multi-agent, collaboration, and remote-environment suites](stage-23.2.4.4.md) `stage-23.2.4.4` — 6 files
- [Approvals, permissions, hooks, and review-mediation suites](stage-23.2.4.5.md) `stage-23.2.4.5` — 13 files
- [Tool, shell/exec, MCP/app, plugin, and runtime item suites](stage-23.2.4.6.md) `stage-23.2.4.6` — 20 files
