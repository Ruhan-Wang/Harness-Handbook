# Process entrypoints and binary dispatch  `stage-1`

This stage is the system’s starting line for native programs. When one of the project’s binaries starts, this code reads the command-line arguments and decides what kind of run the user meant. In simple terms, it is the receptionist and switchboard: it looks at the program name, the flags, and the subcommand, then sends control to the right runtime mode.

The main user-facing launch surface covers the big entry programs. It includes the top-level codex command, the text-based full-screen interface, one-shot exec mode, desktop app launchers, remote control, sandbox setup, system health checks, archive commands, code-apply commands, MCP settings, and cloud task commands. These pieces define the available commands and perform the first handoff into real work.

The auxiliary binaries are smaller specialist tools. They generate schemas, rebuild protocol code, apply patches, search files, bridge standard input/output to sockets, inspect Markdown parsing, and provide test or platform-specific helpers.

exec/src/main.rs is the dedicated entrypoint for codex-exec. It parses shared config overrides, can change behavior based on argv[0] (the executable name the process was started with), and then forwards normal exec runs into the exec runtime.

## Sub-stages

- [Primary user-facing launch surfaces](stage-1.1.md) `stage-1.1` — 19 files
- [Auxiliary binaries and developer tools](stage-1.2.md) `stage-1.2` — 45 files

## Files in this stage

### Process entrypoints and binary dispatch
### `exec/src/main.rs`

`entrypoint` · `process startup`

This binary crate is intentionally thin. It declares `TopCli`, a small clap parser that flattens two layers of arguments: root-level `CliConfigOverrides` and the library's `Cli`. That split exists because the binary needs to accept global `--config` overrides before or around subcommands while leaving the downstream library API unchanged. The file-level documentation explains the other major responsibility: arg0 dispatch. If the executable is invoked under a special name such as `codex-linux-sandbox`, the process should run sandbox-specific behavior instead of the normal exec CLI.

The `main` function delegates all of that to `codex_arg0::arg0_dispatch_or_else`. In the normal branch, it parses `TopCli`, moves the root-level overrides into `inner.config_overrides` via `prepend_root_overrides`, and then awaits `codex_exec::run_main`. There is no business logic here beyond wiring: no config loading, no event processing, and no protocol handling. The design keeps the binary-specific concerns—arg0 dispatch and clap shape—separate from the reusable library runtime in `exec/src/lib.rs`.

#### Function details

##### `main`  (lines 28–40)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: Acts as the executable entrypoint, performing arg0 dispatch and normal CLI parsing before handing control to the library runtime. It also merges root-level config overrides into the inner exec CLI struct.

**Data flow**: Takes no explicit arguments, invokes `arg0_dispatch_or_else` with an async closure that receives `Arg0DispatchPaths`, parses `TopCli`, mutates `inner.config_overrides` by prepending root overrides, then awaits `run_main(inner, arg0_paths)` and returns `anyhow::Result<()>`.

**Call relations**: This is the top of the binary call flow. In normal `codex-exec` invocations it delegates entirely to `run_main`; in alternate arg0 cases, `arg0_dispatch_or_else` routes execution elsewhere before the closure runs.

*Call graph*: 1 external calls (arg0_dispatch_or_else).

## 📊 State Registers Touched

- `reg-effective-config` — The merged live settings the app actually runs with after combining user, project, managed, thread, and command-line inputs.
- `reg-remote-control-state` — The current remote-control enablement, pairing, and client connection state for controlling the app from elsewhere.
- `reg-cloud-tasks-state` — The cached task-list/detail/apply state and background refresh flow for cloud task operations exposed in the UI and clients.
