# Process entrypoints and binary dispatch  `stage-1`

This stage is the process-start boundary for every native executable in the codebase. It sits at startup, before any long-running loop or service logic begins, and turns raw process state—argv, argv[0], environment, and top-level config overrides—into a specific runtime mode. Its job is to decide which binary personality is being invoked, parse the corresponding command surface, and hand control to the appropriate library or server entrypoint.

The primary user-facing launch surfaces cover the main `codex` CLI, standalone TUI startup, cloud-tasks, desktop opening, remote-control and sandbox utilities, doctor checks, MCP management, and other focused top-level commands. They share typed command definitions and common config/backend setup so different launch paths behave consistently. The auxiliary binaries and developer tools provide separate executables for schema generation, protocol export, patching and search utilities, logging and diagnostics, alternate servers and bridges, sample clients, and platform-specific sandbox or policy wrappers.

`exec/src/main.rs` is the dedicated `codex-exec` binary entrypoint within this layer. It parses root config overrides, supports argv[0]-based alternate behavior, and forwards standard exec invocations into the exec runtime, complementing the broader dispatch machinery used by the other binaries.

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

- `reg-process-environment` — The process-wide environment and argv/arg0-derived execution context that shapes binary dispatch, bootstrap aliases, and inherited subprocess state.
- `reg-effective-config` — The merged, validated effective configuration assembled from managed, cloud, user, project, thread, and CLI layers with provenance.
