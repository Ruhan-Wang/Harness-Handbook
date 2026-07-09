# CLI, exec, login, and MCP server developer verification  `stage-23.3`

This stage is the executable-facing verification layer for developer workflows that sit at the system boundary rather than inside the main runtime loop. It validates the commands and helper binaries developers actually invoke: the top-level codex CLI, codex-exec, login/logout flows, apply-patch, execpolicy checks, and the MCP server process.

The top-level CLI tests confirm command parsing, config validation, feature and plugin workflows, MCP management commands, updater behavior, and optional live endpoint smoke coverage. The codex-exec suite goes deeper into automation-oriented execution, checking prompt sourcing, streaming output, auth headers, persistence and resume, approval-policy wiring, hooks, MCP startup failures, and apply_patch integration. Login tests verify both device-code and browser-based authentication, token refresh, storage and migration behavior, and logout cleanup. Apply-patch integration tests exercise the standalone patching executable against real filesystem scenarios, malformed input, overwrite and rename rules, and fixture-driven regressions. Execpolicy tests preserve both current and legacy command-policy behavior, including exact JSON decisions and curated allow/deny corpora. Finally, the MCP server harness launches the real server and drives JSON-RPC exchanges end to end, validating codex-tool requests, approval prompts, and instruction forwarding.

## Sub-stages

- [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files
- [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files
- [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files
- [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files
- [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files
- [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files
