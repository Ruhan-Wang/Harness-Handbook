# Process entrypoints and binary dispatch  `stage-1`

This stage is the system’s set of starting doors. It runs at process startup, when the operating system has launched a native binary and passed in the command name and arguments. Its job is to read what was invoked, understand the flags and subcommands, and hand control to the right runtime mode.

The primary user-facing launch surfaces are the main front desk. They route everyday commands into the text interface, one-shot exec mode, cloud tasks, desktop app launch, sandbox tools, remote control, doctor checks, MCP server commands, or session archive tools. They also define the options each mode accepts before the real work begins.

The auxiliary binaries and developer tools are the side workbench. They generate schemas, refresh protocol files, apply patches, search files, inspect logs, start helper services, run test clients, and launch commands inside safer restricted environments.

The directly assigned exec/src/main.rs is a small but important switch. It starts codex-exec, then decides whether to run the normal non-interactive agent or behave like the codex-linux-sandbox helper.

## Sub-stages

- [Primary user-facing launch surfaces](stage-1.1.md) `stage-1.1` — 19 files
- [Auxiliary binaries and developer tools](stage-1.2.md) `stage-1.2` — 45 files

## Files in this stage

### Process entrypoints and binary dispatch
### `exec/src/main.rs`

`entrypoint` · `startup`

This file is like the front desk for the executable. When the operating system starts this program, control begins here. Most of the time, it reads the user’s command-line options and starts the normal `codex-exec` flow, which runs Codex without an interactive user interface. There is one important twist: the same binary can also behave as `codex-linux-sandbox` if it was launched under that name. That lets the project ship one executable that can wear two different “badges,” depending on how it was called.

The file defines a small command-line shape called `TopCli`. It combines general configuration overrides with the real `codex-exec` options. After parsing the command line, `main` moves the top-level configuration overrides into the inner command options. This keeps the deeper execution code simple: downstream code only needs to look in one place for configuration.

The actual decision about the program name is delegated to `arg0_dispatch_or_else`. “arg0” means the name used to invoke the program. If that name matches the sandbox mode, the sandbox path can take over. Otherwise, this file runs the normal Codex entry flow through `run_main`.

#### Function details

##### `main`  (lines 28–40)

```
fn main() -> anyhow::Result<()>
```

**Purpose**: This is the first Rust function run when the `codex-exec` binary starts. It chooses the right startup path, parses command-line options, folds shared configuration into the main CLI settings, and starts the main non-interactive Codex run when appropriate.

**Data flow**: The function begins with the process invocation details, especially the program name and command-line arguments. It asks the arg0 dispatcher to check whether this launch should be treated as a special sandbox command. For the normal path, it parses the command line into `TopCli`, moves root-level configuration overrides into the inner `Cli` value, then passes that prepared CLI data plus dispatch path information into `run_main`. It returns success if startup and execution complete cleanly, or an error if parsing or execution fails.

**Call relations**: The operating system effectively hands control to `main` when the binary starts. `main` immediately hands the program-name decision to `arg0_dispatch_or_else`; inside the normal fallback path, it prepares the CLI data and then hands off to the broader Codex execution logic through `run_main`.

*Call graph*: 1 external calls (arg0_dispatch_or_else).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-app-server-runtime` — The live app-server or daemon state, including open transports, connected clients, request routing, and server lifecycle status.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-cloud-task-state` — Cloud task lists, task details, submission attempts, selected task environments, and polling/refresh status shared by cloud task commands and clients.
- `reg-launch-invocation-context` — The raw launch context, including invoked binary/arg0, selected subcommand or runtime mode, startup flags, and output/interaction mode chosen before dispatch.
