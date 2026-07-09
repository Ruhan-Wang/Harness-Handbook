# CLI, exec, login, and MCP server developer verification  `stage-23.3`

This stage is a broad reality check for developer-facing command-line tools. It lives in the testing side of the system and covers the moments when someone runs a command, signs in, applies a patch, or connects tools together. In simple terms, it asks: if a developer uses these programs for real, do they behave correctly from the outside?

The top-level CLI tests check the main codex command at the front door: command selection, options, warnings, plugin and marketplace actions, MCP server management, and a few live end-to-end smoke tests. The codex-exec tests focus on the separate exec program, making sure it reads prompts and flags correctly, turns server events into human or machine-readable output, and handles sessions, approvals, hooks, and failures.

The login tests follow full sign-in and sign-out journeys, including browser login, device-code login, token storage, refresh, and cleanup. The apply-patch tests run the real patch tool against sample files and confirm the final files match expectations. Execpolicy tests verify the allow-or-block decision system, both current and legacy rules. Finally, the MCP server harness starts the real server process and talks to it like a client would, checking approvals and instruction passing end to end.

## Sub-stages

- [apply-patch executable integration tests](stage-23.3.1.md) `stage-23.3.1` — 5 files
- [top-level codex CLI command verification](stage-23.3.2.md) `stage-23.3.2` — 14 files
- [codex-exec binary verification](stage-23.3.3.md) `stage-23.3.3` — 22 files
- [legacy and current execpolicy executable tests](stage-23.3.4.md) `stage-23.3.4` — 13 files
- [login workflow integration tests](stage-23.3.5.md) `stage-23.3.5` — 12 files
- [MCP server executable integration tests](stage-23.3.6.md) `stage-23.3.6` — 7 files
