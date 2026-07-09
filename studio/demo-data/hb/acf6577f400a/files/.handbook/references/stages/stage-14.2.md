# Execution backends and sandboxed command runtimes  `stage-14.2`

This stage is the system’s safe command-running workshop. It is used in the main work loop when the assistant needs to run a shell command, edit files with apply_patch, start an interactive program, or pause briefly with the built-in sleep tool. It also provides shared support behind the scenes so those actions work locally, remotely, and across operating systems.

The command orchestration pieces act like the front desk: they receive requests, check rules, start commands, stream output, accept input, cancel work, and clean up. The unified-exec and PTY/process backends are the engine room, keeping interactive sessions alive through pipes or terminal-like connections. The patch engine is the file-editing arm: it recognizes patch requests, parses them, applies changes, and reports what happened.

Sandbox selection and platform launchers are the safety cage. On Unix they choose Linux or macOS restrictions and handle permission escalation. On Windows they create restricted users, permissions, firewall rules, and process settings. Exec-server filesystem services let local, sandboxed, or remote commands read and write files safely. The sleep tool simply waits, but can be interrupted when new user input arrives.

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

`domain_logic` · `tool execution during a turn`

This file is the small “pause button” for the tool system. It gives the model a tool named `sleep` that can wait for a number of milliseconds, up to one hour. That is useful when the model needs to delay before continuing, but it must not make the session feel frozen if the user says something new.

The file first describes the tool in a machine-readable way: it has one required input, `duration_ms`, meaning the number of milliseconds to wait. It then implements `SleepHandler`, the object that the larger tool runtime calls when the model asks to use this tool.

When the tool runs, it checks that the request is really a function-style tool call, parses the JSON arguments, and rejects invalid durations. It records the start time, emits a “sleep started” item into the current turn, and subscribes to activity on the input queue. Then it waits for whichever happens first: the requested time passes, or new input appears for the active turn. This is like setting a kitchen timer but also listening for someone at the door; if they knock, you stop waiting.

Finally, it emits a “sleep completed” item and returns text saying how much real wall-clock time passed and whether the sleep finished normally or was interrupted.

#### Function details

##### `create_sleep_tool`  (lines 31–52)

```
fn create_sleep_tool() -> ToolSpec
```

**Purpose**: Builds the public description of the `sleep` tool so the rest of the system, and ultimately the model, know how to call it. It says the tool needs a `duration_ms` number and explains the allowed range.

**Data flow**: It starts with the fixed sleep tool name and maximum allowed duration. It creates a JSON-style schema, meaning a structured description of the expected input, then wraps that in a tool specification. The result is a `ToolSpec` that can be registered and shown as an available tool.

**Call relations**: This helper is used by `SleepHandler::spec` when the tool runtime asks, “What does this tool look like?” It does not run the sleep itself; it only provides the instruction sheet for using the tool.

*Call graph*: calls 2 internal fn (number, object); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `SleepHandler::tool_name`  (lines 55–57)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the official name of this tool: `sleep`. The registry uses this name to match a model’s tool request to this handler.

**Data flow**: It takes no outside data beyond the handler itself. It turns the fixed string `sleep` into the system’s `ToolName` type and returns it.

**Call relations**: The tool registry calls this when it needs to identify or look up the handler. It is the label on the drawer; `SleepHandler::handle` is what runs after that drawer has been opened.

*Call graph*: calls 1 internal fn (plain).


##### `SleepHandler::spec`  (lines 59–61)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the full tool description for `sleep`, including its input shape and human-readable description. This lets the tool runtime advertise the tool correctly.

**Data flow**: It receives the handler object, calls `create_sleep_tool`, and returns the resulting tool specification unchanged.

**Call relations**: The tool runtime calls this during setup or tool discovery. It delegates the actual construction to `create_sleep_tool` so the schema-building details stay in one place.

*Call graph*: calls 1 internal fn (create_sleep_tool).


##### `SleepHandler::handle`  (lines 63–128)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Runs the actual sleep request. It waits for the requested duration unless fresh input arrives first, then reports how long the wait really lasted.

**Data flow**: It receives a `ToolInvocation`, which contains the session, current turn, call id, and payload from the model. It accepts only function-style payloads, parses the JSON arguments into `duration_ms`, checks that the duration is between 1 millisecond and one hour, and records the current time. It then emits a started item, listens for new input, waits either for the timer or for activity, emits a completed item, and returns a text result with elapsed wall-clock time and an interruption message.

**Call relations**: The tool runtime calls this when the model invokes `sleep`. Inside the flow it uses `parse_arguments` to turn raw JSON into typed arguments, asks the session input queue whether new activity has arrived, emits turn items so the rest of the system can observe the sleep’s lifecycle, and wraps the final text with `boxed_tool_output` so it fits the common tool-output format.

*Call graph*: calls 3 internal fn (from_text, boxed_tool_output, parse_arguments); 9 external calls (pin, from_millis, now, Sleep, format!, pin!, select!, sleep, RespondToModel).
