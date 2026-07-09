# Process entrypoints and binary dispatch  `stage-1`

This stage is the very first step of startup for the project’s native programs. It is the switchboard that turns “a user started this binary” into “run this specific mode now.” In simple terms, it reads the command-line input, figures out which program behavior was requested, and hands control to the right runtime path.

The primary user-facing launch surfaces are the main front doors. They define the commands and options users can type, check them, and route each request to the right feature: the main CLI, the text interface, desktop app launchers, server modes, maintenance commands, and troubleshooting tools.

The auxiliary binaries and developer tools are the side doors and workshop tools. They start helper programs, generate shared format files, inspect logs, run test servers, search files, and set up sandboxed runs. These are smaller focused binaries that support development, testing, and safe execution.

The direct file here, exec/src/main.rs, is the entrypoint for the codex-exec binary. It reads top-level config overrides, can change behavior based on argv[0] (the program name used to start it), and then forwards ordinary exec runs into the main execution library.

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

- `reg-cli-overrides` — The startup command-line options and argv-derived mode choices that keep influencing later configuration and runtime behavior.
