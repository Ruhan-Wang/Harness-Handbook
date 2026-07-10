# CLI, exec, login, and MCP server developer verification  `stage-23.3`

This stage is the big real-world test bench for developer-facing command-line tools and workflows. It sits after the code is written, as a final “does it actually behave right from the outside?” check. Instead of testing small internal pieces, it runs the actual executables the way a person, script, or editor integration would.

The apply-patch tests focus on the standalone patching tool. They check simple command use, error cases, and full folder-changing scenarios. The top-level codex CLI tests cover the main codex command itself: server-style commands, maintenance commands, plugin and marketplace actions, MCP server management, and a few live smoke tests.

The codex-exec tests do the same for the codex-exec program. They verify command-line parsing, human-readable and machine-readable output, saved sessions, approvals, hooks, patch flows, and failure behavior. The execpolicy tests are the rule checker for command safety. They confirm both the current and older policy systems still make the expected allow-or-block decisions.

The login tests rehearse full sign-in, token refresh, and sign-out journeys. The MCP server tests then drive the real server process with JSON-RPC, a simple request/reply message format, to confirm external tool flows end to end.

## Sub-stages

- [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files
- [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files
- [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files
- [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files
- [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files
- [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files
