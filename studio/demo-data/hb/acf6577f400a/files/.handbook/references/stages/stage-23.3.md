# CLI, exec, login, and MCP server developer verification  `stage-23.3`

This stage is a broad test bench for the programs developers and users run from the terminal. It is not the normal work loop; it is behind-the-scenes verification that the finished executables behave correctly when used like real tools.

The apply-patch tests feed patch text to the standalone patch program and check that files are created, edited, renamed, deleted, or rejected as expected. The top-level CLI tests exercise Codex’s main command entry point, checking config errors, plugin commands, MCP server settings, JSON output, and special debug commands. The codex-exec tests focus on the program that asks Codex to perform work, making sure flags, prompts, permissions, streamed events, resume behavior, hooks, and server failures are handled predictably. The execpolicy tests verify the rule system that decides whether shell commands are allowed, blocked, or need approval. The login tests rehearse signing in, refreshing credentials, storing secrets, and logging out. The MCP server tests start the server as a real child process and talk to it with JSON messages, using a mock AI server to check tool behavior safely.

## Sub-stages

- [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files
- [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files
- [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files
- [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files
- [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files
- [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files
