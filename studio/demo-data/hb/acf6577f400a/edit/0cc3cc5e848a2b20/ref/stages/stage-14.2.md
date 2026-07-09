# Execution backends and sandboxed command runtimes  `stage-14.2`

This stage is the system’s execution substrate: after a tool request has been interpreted and approved, but before the main loop can observe output or file changes, it turns that request into a real process, sandboxed helper, or patch application and keeps it running safely across platforms. It is cross-cutting infrastructure used by shell, unified-exec, code-mode, apply_patch, and related command-like tools.

The execution-facing app-server and orchestration layer receives RPC and TUI command requests, forms concrete exec requests, manages per-session lifecycle, and exposes stdin/resize/terminate controls. Beneath it, the unified-exec session backends supply the actual PTY/pipe and process abstractions for local and remote jobs, normalizing streaming output, cancellation, and exit handling. The patch engine handles model-emitted patch text, validates and parses it, decides whether to translate it into direct edits or runtime execution, and applies changes with structured progress and failure reporting.

Sandbox selection and Unix launchers choose Linux/macOS/Unix confinement strategies and shell-escalation behavior, while exec-server filesystem sandbox services provide the file-access backends those executions depend on. On Windows, dedicated sandbox provisioning and launch internals create restricted identities, enforce ACL/network policy, and start processes through pipes or ConPTY. The directly assigned sleep tool fits alongside these runtimes as a command-like primitive that pauses execution while still participating in turn events and waking on new input.

## Sub-stages

- [Execution-facing app-server and core command orchestration](stage-14.2.1.md) `stage-14.2.1` — 15 files
- [Unified-exec sessions and PTY/process backends](stage-14.2.2.md) `stage-14.2.2` — 17 files
- [Patch application engine and patch-execution adapters](stage-14.2.3.md) `stage-14.2.3` — 9 files
- [Sandbox selection and Unix platform launchers](stage-14.2.4.md) `stage-14.2.4` — 16 files
- [Exec-server filesystem sandbox services](stage-14.2.5.md) `stage-14.2.5` — 6 files
- [Windows sandbox provisioning and process-launch internals](stage-14.2.6.md) `stage-14.2.6` — 27 files

## Files in this stage

### Execution backends and sandboxed command runtimes
### `core/src/tools/handlers/sleep.rs`

`domain_logic` · `tool execution during request handling`

This file contains both the `sleep` tool specification and its runtime executor. The schema is simple: a single required `duration_ms` number with a hard upper bound of one hour (`MAX_SLEEP_DURATION_MS`). The runtime side is more nuanced. `SleepHandler::handle` accepts only function payloads, parses them into the private `SleepArgs` struct with `deny_unknown_fields`, and rejects durations outside `1..=3_600_000` with a model-facing error.

On success, the handler records `Instant::now()`, emits a `TurnItem::Sleep` started event carrying the call ID and requested duration, and then subscribes to activity on the current turn via the session’s input queue. If activity is already pending, the sleep is considered immediately interrupted. Otherwise it races a `tokio::time::sleep` future against `activity_rx.changed()` using `tokio::select!`. A successful activity notification interrupts the sleep; a closed activity channel falls back to awaiting the timer to completion. After either path, it emits the completed turn item and returns a text `FunctionToolOutput` reporting elapsed wall-clock seconds to four decimals plus either `Sleep interrupted by new input.` or `Sleep completed.`. The design makes sleep observable in turn history and responsive to user interaction rather than blindly blocking for the full duration.

#### Function details

##### `create_sleep_tool`  (lines 31–52)

```
fn create_sleep_tool() -> ToolSpec
```

**Purpose**: Builds the `sleep` tool specification exposed to the model. The schema advertises a single bounded duration parameter and explains that sleep may end early on new input.

**Data flow**: It creates a one-entry `BTreeMap` for `duration_ms`, formatting the maximum allowed value into the field description, then wraps that map in a `ResponsesApiTool` named `sleep`. The returned `ToolSpec` requires `duration_ms`, forbids additional properties, and has no explicit output schema.

**Call relations**: This helper is called by `SleepHandler::spec` so the runtime executor and published schema stay colocated.

*Call graph*: calls 2 internal fn (number, object); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `SleepHandler::tool_name`  (lines 55–57)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name used to register and dispatch the sleep handler. It keeps the runtime name aligned with the schema builder’s constant.

**Data flow**: It reads the `SLEEP_TOOL_NAME` constant and converts it into a `ToolName` via `ToolName::plain`, returning that value.

**Call relations**: The tool registry calls this method when wiring handlers by name; it pairs with `SleepHandler::spec` and `SleepHandler::handle` as part of the `ToolExecutor` implementation.

*Call graph*: calls 1 internal fn (plain).


##### `SleepHandler::spec`  (lines 59–61)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Supplies the published tool specification for this handler. It is a thin adapter from the executor trait to the local schema-construction helper.

**Data flow**: It takes `&self`, calls `create_sleep_tool()`, and returns the resulting `ToolSpec` unchanged.

**Call relations**: The registry invokes this method during tool registration or schema enumeration; all actual schema assembly is delegated to `create_sleep_tool`.

*Call graph*: calls 1 internal fn (create_sleep_tool).


##### `SleepHandler::handle`  (lines 63–128)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Executes a sleep request, interrupting early if the active turn receives new input, and returns a textual summary of elapsed time. It also emits turn-item lifecycle events so the sleep appears in session history.

**Data flow**: It consumes a `ToolInvocation`, destructures out `session`, `turn`, `call_id`, and `payload`, rejects non-function payloads, and parses JSON arguments into `SleepArgs` with `parse_arguments`. After validating `duration_ms`, it records the start time, constructs a `TurnItem::Sleep`, emits a started event, obtains turn state and an activity subscription from `session.input_queue`, and determines interruption either from existing pending activity or by racing a timer against `activity_rx.changed()`. It then emits the completed event, computes elapsed seconds from `Instant`, formats a status message, wraps it in `FunctionToolOutput::from_text`, boxes it with `boxed_tool_output`, and returns it.

**Call relations**: This is the main execution path invoked by the tool runtime when the `sleep` tool is called. It delegates argument parsing to `parse_arguments` and output boxing to `boxed_tool_output`, but owns the control flow around event emission and interruption handling.

*Call graph*: calls 3 internal fn (from_text, boxed_tool_output, parse_arguments); 9 external calls (pin, from_millis, now, Sleep, format!, pin!, select!, sleep, RespondToModel).
