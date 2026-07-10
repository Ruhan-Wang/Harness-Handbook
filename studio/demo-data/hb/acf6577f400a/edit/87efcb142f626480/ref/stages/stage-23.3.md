# CLI, exec, login, and MCP server developer verification  `stage-23.3`

This stage is the big outside-in check for developer-facing programs. It sits around startup and real user workflows, and asks: if someone runs these tools from the command line, logs in, applies a patch, or connects an MCP server, does the finished executable behave as promised?

Each sub-stage checks one doorway into the system. The top-level CLI tests make sure typed commands are understood correctly, the right feature starts, and mistakes produce useful errors. The codex-exec tests do the same for the separate execution program, including input rules, streamed output, saved sessions, authentication headers, and failure cases. The login tests walk through signing in, storing credentials, refreshing them when they expire, and logging out cleanly. The apply-patch tests launch the real patch tool and confirm it changes files on disk correctly, even in awkward edge cases. The execpolicy tests verify the rule engine that decides whether commands are allowed. Finally, the MCP server tests start the real server process and talk to it like a client would, using fake backend services to check approvals, instructions, and tool behavior end to end.

## Sub-stages

- [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files
- [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files
- [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files
- [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files
- [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files
- [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files
