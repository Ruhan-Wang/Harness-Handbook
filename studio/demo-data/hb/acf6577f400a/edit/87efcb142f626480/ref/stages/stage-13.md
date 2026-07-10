# Turn execution and model interaction  `stage-13`

This stage is the heart of one chat “turn” — one cycle where the system takes new input, decides what extra prep is needed, asks the model for help, reacts to the streamed answer, and then wraps everything up. In the system’s story, this is the main work loop.

core/src/tasks/regular.rs starts a normal turn and keeps running the engine until there is no more pending input. The main conductor is core/src/session/turn.rs. It checks whether old conversation history should be compacted, runs hooks and tool setup, sends the request through the model transport layer, handles streamed replies, retries when needed, and records the finished result.

Compaction is the “pack the suitcase” step so long histories stay manageable. core/src/tasks/compact.rs chooses which compaction path to use. core/src/compact.rs does compaction locally inside the app, while core/src/compact_remote.rs asks the model provider to do it remotely. core/src/turn_metadata.rs adds extra per-turn facts, like session lineage and workspace details, to outgoing requests.

This stage also includes the code-mode JavaScript runtime. The runtime files create a small isolated JavaScript engine, load the user module, support simple timers, and turn tool-call results back into JavaScript promises. Together, these parts let one turn move smoothly from input to final saved outcome.

## Sub-stages

- [Model transport execution](stage-13.1.md) `stage-13.1` — 28 files
- [Streaming reduction and UI projection](stage-13.2.md) `stage-13.2` — 51 files

## Files in this stage

### Code-mode runtime
These files introduce the embedded JavaScript runtime, then explain how modules are loaded and how timer callbacks are driven inside the runtime loop.

### `code-mode/src/runtime/mod.rs`

`orchestration` · `runtime startup and main execution loop`

This module is the core runtime driver. It defines the command and event enums exchanged between the runtime thread and the async service layer: `RuntimeCommand` for inbound host actions such as tool responses, timeout firings, and termination; `RuntimeEvent` for outbound lifecycle, output, tool-call, notification, and completion messages; and `PendingRuntimeMode`/`RuntimeControlCommand` for the special pause-until-resumed execution mode. `RuntimeState`, stored in the V8 scope slot, carries all mutable per-runtime state: pending tool promises, pending timeout callbacks, stored values and writes, enabled tool metadata, id counters, the parent tool call id, a sender back into the runtime command queue, and the `exit_requested` flag.

`spawn_runtime` performs one-time V8 initialization, creates stdlib channels, derives `EnabledToolMetadata` from the request, packages a `RuntimeConfig`, and launches `run_runtime` on a dedicated OS thread. `run_runtime` creates the isolate and context, installs globals, emits `Started`, evaluates the main module, and then loops on `next_runtime_command`. Each command either resolves a pending tool promise, invokes a timeout callback, or terminates execution. After every command it runs a microtask checkpoint and asks `module_loader::completion_state` whether the top-level promise has completed. Completion sends a single `RuntimeEvent::Result`, including any accumulated `stored_value_writes`. Error paths use `capture_scope_send_error` so partial store writes are preserved even when execution fails.

#### Function details

##### `spawn_runtime`  (lines 65–112)

```
fn spawn_runtime(
    stored_values: HashMap<String, JsonValue>,
    request: ExecuteRequest,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    pending_mode: PendingRuntimeMode,
) -> Result<
```

**Purpose**: Initializes shared V8 state if needed, creates the runtime/control channels, packages request data into a runtime config, and starts a dedicated runtime thread.

**Data flow**: Accepts initial `stored_values`, an `ExecuteRequest`, an unbounded Tokio event sender, and a `PendingRuntimeMode`. Calls `initialize_v8`, creates std `channel()` pairs for runtime commands and control commands plus a sync channel for the isolate handle, maps `request.enabled_tools` through `enabled_tool_metadata`, and builds a `RuntimeConfig` containing tool call id, enabled tools, source, and stored values. Spawns a thread running `run_runtime(...)`, waits synchronously for the isolate handle from the sync channel, and returns `(command_tx, control_tx, isolate_handle)` or an initialization error.

**Call relations**: Called by the service layer when starting a cell and by runtime tests. It is the entry into this module’s orchestration, handing off all actual execution to `run_runtime` on the spawned thread.

*Call graph*: calls 1 internal fn (initialize_v8); called by 4 (pending_mode_freezes_runtime_commands_until_resume, terminate_execution_stops_cpu_bound_module, start_cell, terminate_waits_for_runtime_shutdown_before_responding); 3 external calls (channel, sync_channel, spawn).


##### `initialize_v8`  (lines 144–158)

```
fn initialize_v8() -> Result<(), String>
```

**Purpose**: Performs one-time global V8 and ICU initialization for the process, caching either success or the initialization error.

**Data flow**: Uses a `OnceLock<Result<v8::SharedRef<v8::Platform>, String>>` to ensure initialization runs once. On first call it loads ICU data via `v8::icu::set_common_data_77`, creates the default V8 platform, initializes the platform and V8 itself, and stores `Ok(platform)`; later calls clone and return the cached success or error string.

**Call relations**: Called only by `spawn_runtime` before any isolate is created. Its once-only design ensures multiple cells and sessions share the same process-wide V8 initialization without races.

*Call graph*: called by 1 (spawn_runtime); 1 external calls (new).


##### `run_runtime`  (lines 160–269)

```
fn run_runtime(
    config: RuntimeConfig,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: std_mpsc::Receiver<RuntimeCommand>,
    control_rx: std_mpsc::Receiver<RuntimeControlComma
```

**Purpose**: Creates the isolate and context, installs runtime state and globals, evaluates the main module, then drives the runtime until completion or termination by processing host commands and microtasks.

**Data flow**: Consumes `RuntimeConfig`, event/control receivers, pending mode, a sync sender for the isolate handle, and a runtime command sender. It creates a new isolate, sends its thread-safe handle back to the caller, installs the dynamic import callback, enters V8 scopes, creates a context, and stores a freshly initialized `RuntimeState` in the scope slot. It then calls `globals::install_globals`; on failure sends an immediate result with empty writes. After emitting `RuntimeEvent::Started`, it evaluates the source via `module_loader::evaluate_main_module`. If evaluation errors, it captures current stored writes and sends a result. If the module is already complete, it sends the final result immediately; otherwise it loops on `next_runtime_command`, handling `Terminate`, `ToolResponse`, `ToolError`, and `TimeoutFired` by delegating to `module_loader::resolve_tool_response` or `timers::invoke_timeout_callback`. After each command it performs a microtask checkpoint, checks `module_loader::completion_state`, and sends `RuntimeEvent::Result` once the top-level promise settles.

**Call relations**: Spawned on a dedicated thread by `spawn_runtime`. It orchestrates startup through `globals::install_globals` and `module_loader::evaluate_main_module`, then repeatedly consults `next_runtime_command` and delegates command-specific work to `module_loader` and `timers` until a final `send_result` or termination.

*Call graph*: calls 8 internal fn (capture_scope_send_error, install_globals, completion_state, evaluate_main_module, resolve_tool_response, next_runtime_command, send_result, invoke_timeout_callback); 11 external calls (default, new, send, clone, send, new, new, default, new, new (+1 more)).


##### `next_runtime_command`  (lines 271–293)

```
fn next_runtime_command(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: &std_mpsc::Receiver<RuntimeCommand>,
    control_rx: &std_mpsc::Receiver<RuntimeControlCommand>,
    pendin
```

**Purpose**: Waits for the next actionable runtime command, emitting `Pending` notifications and optionally pausing command processing until an explicit resume signal arrives.

**Data flow**: Reads from `command_rx` with `try_recv` in a loop. If a command is immediately available, returns it; if the command channel is disconnected, returns `None`. When no command is ready, sends `RuntimeEvent::Pending` on `event_tx` and then either blocks on `command_rx.recv()` in `Continue` mode or blocks on `control_rx.recv()` in `PauseUntilResumed` mode, returning `Terminate` when the control command requests termination and otherwise looping again after `Resume`.

**Call relations**: Called only by `run_runtime` inside its main loop. It is the mechanism that exposes quiescent frontiers to the service layer and enforces the pause/resume semantics used by execute-to-pending flows.

*Call graph*: calls 1 internal fn (recv); called by 1 (run_runtime); 2 external calls (send, try_recv).


##### `capture_scope_send_error`  (lines 295–306)

```
fn capture_scope_send_error(
    scope: &mut v8::PinScope<'_, '_>,
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    error_text: Option<String>,
)
```

**Purpose**: Collects any stored-value writes accumulated so far from the V8 scope and sends them together with an error result.

**Data flow**: Reads `RuntimeState.stored_value_writes` from the scope slot, cloning the map or defaulting to empty if state is unavailable. Passes that map plus the provided `error_text` to `send_result`.

**Call relations**: Used by `run_runtime` on error paths after module evaluation, tool response resolution, or timeout callback invocation. It preserves partial store mutations that occurred before the failure.

*Call graph*: calls 1 internal fn (send_result); called by 1 (run_runtime).


##### `send_result`  (lines 308–317)

```
fn send_result(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    stored_value_writes: HashMap<String, JsonValue>,
    error_text: Option<String>,
)
```

**Purpose**: Emits the terminal `RuntimeEvent::Result` message for a runtime.

**Data flow**: Takes the event sender, a `HashMap<String, JsonValue>` of `stored_value_writes`, and an optional error string, then sends `RuntimeEvent::Result { stored_value_writes, error_text }` on the unbounded channel, ignoring send failure.

**Call relations**: Called directly by `run_runtime` on normal completion and by `capture_scope_send_error` on failure. It is the single terminal event emission path from the runtime thread.

*Call graph*: called by 2 (capture_scope_send_error, run_runtime); 1 external calls (send).


##### `tests::execute_request`  (lines 335–343)

```
fn execute_request(source: &str) -> ExecuteRequest
```

**Purpose**: Builds a minimal `ExecuteRequest` fixture for runtime tests with a fixed tool call id and default short yield time.

**Data flow**: Accepts a source string and returns an `ExecuteRequest` populated with `tool_call_id = "call_1"`, empty `enabled_tools`, the provided source, `yield_time_ms = Some(1)`, and `max_output_tokens = None`.

**Call relations**: Used by the tests in this module to reduce boilerplate when spawning runtimes under different source programs.

*Call graph*: 1 external calls (new).


##### `tests::terminate_execution_stops_cpu_bound_module`  (lines 346–379)

```
async fn terminate_execution_stops_cpu_bound_module()
```

**Purpose**: Verifies that a CPU-bound infinite loop can be interrupted through the isolate termination handle and that the runtime then emits a terminal result and closes.

**Data flow**: Creates an event channel, spawns a runtime executing `while (true) {}`, waits for a `RuntimeEvent::Started`, calls `terminate_execution()` on the returned isolate handle, then waits for a `RuntimeEvent::Result` whose `error_text` is present. Finally asserts that the event stream closes afterward.

**Call relations**: Invoked by the test harness. It exercises `spawn_runtime` and the isolate-handle path exposed by that function, validating the termination behavior implemented inside `run_runtime` and V8.

*Call graph*: calls 1 internal fn (spawn_runtime); 7 external calls (from_secs, new, assert!, execute_request, unbounded_channel, panic!, timeout).


##### `tests::pending_mode_freezes_runtime_commands_until_resume`  (lines 382–447)

```
async fn pending_mode_freezes_runtime_commands_until_resume()
```

**Purpose**: Checks that in pause-until-resumed mode the runtime reports `Pending`, ignores queued runtime commands until resumed, then processes them and can be terminated via control commands.

**Data flow**: Spawns a runtime whose source awaits a timeout, emits `text("after")`, then awaits forever, using `PendingRuntimeMode::PauseUntilResumed`. It asserts receipt of `Started` then `Pending`, sends `RuntimeCommand::TimeoutFired { id: 1 }`, confirms no event arrives before resume, sends `RuntimeControlCommand::Resume`, then expects a text content event with `"after"` followed by another `Pending`. It ends by sending `RuntimeControlCommand::Terminate`.

**Call relations**: Invoked by the test harness to validate the interaction between `run_runtime` and `next_runtime_command` in paused mode. It specifically demonstrates that queued runtime commands are held until the control channel delivers `Resume`.

*Call graph*: calls 1 internal fn (spawn_runtime); 8 external calls (from_secs, new, assert!, assert_eq!, execute_request, unbounded_channel, panic!, timeout).


### `code-mode/src/runtime/module_loader.rs`

`domain_logic` · `module compilation/evaluation and async promise settlement`

This file encapsulates the V8 module-loading and promise-settlement logic for code-mode execution. `evaluate_main_module` wraps compilation, instantiation, and evaluation of the provided source text in a `TryCatch`, using a synthetic script origin of `exec_main.mjs`. It converts V8 exceptions into readable strings with `value_to_error_text`, but treats the special `EXIT_SENTINEL` exception as a clean early exit when `RuntimeState.exit_requested` is set. If evaluation returns a promise, the function stores it as a `v8::Global<v8::Promise>` so the runtime loop can poll its state later.

`resolve_tool_response` is the inverse path for `tool_callback`: it removes the matching `PromiseResolver` from `RuntimeState.pending_tool_calls`, then either resolves it with `json_to_v8(result)` or rejects it with a V8 string error. Any exception thrown while settling the promise is surfaced as a Rust error. `completion_state` inspects the top-level promise, returning `Pending` or `Completed { stored_value_writes, error_text }`; rejected promises again suppress the sentinel exit error.

Import support is intentionally disabled. Both static resolution (`resolve_module_callback`) and dynamic import handling (`dynamic_import_callback`) delegate to `resolve_module`, which throws `Unsupported import in exec: <specifier>` and returns `None`. The dynamic path wraps that failure in a rejected promise so JS `import()` behaves asynchronously but still fails deterministically.

#### Function details

##### `evaluate_main_module`  (lines 9–52)

```
fn evaluate_main_module(
    scope: &mut v8::PinScope<'_, '_>,
    source_text: &str,
) -> Result<Option<v8::Global<v8::Promise>>, String>
```

**Purpose**: Compiles, instantiates, and evaluates the provided source as an ES module, returning an optional global handle to the top-level promise when execution is asynchronous.

**Data flow**: Creates a `v8::TryCatch`, allocates the source string, builds a script origin via `script_origin`, compiles the module, instantiates it with `resolve_module_callback`, and evaluates it. Compilation/instantiation/evaluation failures are converted to strings using `value_to_error_text`; if evaluation fails with the exit sentinel recognized by `is_exit_exception`, it returns `Ok(None)` instead of an error. After a microtask checkpoint, if the evaluation result is a promise it converts it to `v8::Promise`, wraps it in `v8::Global`, and returns `Ok(Some(...))`; otherwise returns `Ok(None)`.

**Call relations**: Called by `run_runtime` immediately after globals are installed. It delegates script-origin creation to `script_origin`, import resolution to `resolve_module_callback`, and sentinel-exit detection to `is_exit_exception`.

*Call graph*: calls 3 internal fn (is_exit_exception, script_origin, value_to_error_text); called by 1 (run_runtime); 6 external calls (new, pin!, new, try_from, new, compile_module).


##### `is_exit_exception`  (lines 54–64)

```
fn is_exit_exception(
    scope: &mut v8::PinScope<'_, '_>,
    exception: v8::Local<'_, v8::Value>,
) -> bool
```

**Purpose**: Recognizes the special sentinel exception thrown by the `exit()` helper only when the runtime has explicitly marked exit as requested.

**Data flow**: Reads `RuntimeState.exit_requested` from the scope slot, checks that the exception value is a string, converts it to Rust text, and returns `true` only when both the flag is set and the string equals `EXIT_SENTINEL`.

**Call relations**: Used by both `evaluate_main_module` and `completion_state` to suppress user-visible errors for intentional exits triggered by `callbacks::exit_callback`.

*Call graph*: called by 2 (completion_state, evaluate_main_module); 2 external calls (is_string, to_rust_string_lossy).


##### `resolve_tool_response`  (lines 66–101)

```
fn resolve_tool_response(
    scope: &mut v8::PinScope<'_, '_>,
    id: &str,
    response: Result<JsonValue, String>,
) -> Result<(), String>
```

**Purpose**: Settles a pending JS promise created for a tool call by resolving it with JSON data or rejecting it with an error string.

**Data flow**: Mutably reads `RuntimeState.pending_tool_calls`, removes the resolver for the given `id`, and errors if the runtime state is missing or the id is unknown. Inside a `TryCatch`, converts the stored global resolver back to a local handle. For `Ok(result)`, serializes the `JsonValue` with `json_to_v8` and calls `resolver.resolve`; for `Err(error_text)`, allocates a V8 string and calls `resolver.reject`. If settling the promise causes a JS exception, converts that exception to text and returns it as `Err(String)`; otherwise returns `Ok(())`.

**Call relations**: Called by `run_runtime` when it receives `RuntimeCommand::ToolResponse` or `ToolError`. It completes the promise originally created by `callbacks::tool_callback`.

*Call graph*: calls 1 internal fn (json_to_v8); called by 1 (run_runtime); 3 external calls (pin!, new, new).


##### `completion_state`  (lines 103–139)

```
fn completion_state(
    scope: &mut v8::PinScope<'_, '_>,
    pending_promise: Option<&v8::Global<v8::Promise>>,
) -> CompletionState
```

**Purpose**: Determines whether the top-level module execution is still pending or has completed, and packages any stored-value writes plus an optional error string.

**Data flow**: Clones `RuntimeState.stored_value_writes` from the scope slot. If `pending_promise` is `None`, returns `CompletionState::Completed` with no error. Otherwise converts the global promise to a local handle and branches on `promise.state()`: `Pending` returns `CompletionState::Pending`; `Fulfilled` returns completed with no error; `Rejected` reads `promise.result(scope)` and returns completed with `None` if `is_exit_exception` matches, else with `Some(value_to_error_text(scope, result))`.

**Call relations**: Called by `run_runtime` both immediately after initial evaluation and after each processed command/microtask checkpoint. It is the runtime loop’s authoritative completion check.

*Call graph*: calls 2 internal fn (is_exit_exception, value_to_error_text); called by 1 (run_runtime); 1 external calls (new).


##### `script_origin`  (lines 141–162)

```
fn script_origin(
    scope: &mut v8::PinScope<'s, '_>,
    resource_name_: &str,
) -> Result<v8::ScriptOrigin<'s>, String>
```

**Purpose**: Constructs a synthetic `v8::ScriptOrigin` used when compiling the main module so errors and source maps have a stable resource name.

**Data flow**: Allocates V8 strings for `resource_name_` twice—once as the resource name and once as the source map URL—and passes them into `v8::ScriptOrigin::new` with fixed line/column and module-related flags. Returns the constructed origin or an allocation error string.

**Call relations**: Called only by `evaluate_main_module` before compilation. It centralizes the chosen filename-like identity (`exec_main.mjs`) for the evaluated source.

*Call graph*: called by 1 (evaluate_main_module); 2 external calls (new, new).


##### `resolve_module_callback`  (lines 164–173)

```
fn resolve_module_callback(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
    _referrer: v8::Local<'s, v8::M
```

**Purpose**: Implements V8’s static module-resolution callback by converting the specifier to Rust text and delegating to the runtime’s import policy.

**Data flow**: Creates a callback scope from the provided context, converts the `specifier` string to a Rust `String`, and passes it to `resolve_module`, returning whatever module handle or `None` that function yields.

**Call relations**: Passed into module instantiation by `evaluate_main_module`. It is the static-import counterpart to `dynamic_import_callback`, and both ultimately enforce the same no-import policy.

*Call graph*: calls 1 internal fn (resolve_module); 2 external calls (to_rust_string_lossy, callback_scope!).


##### `dynamic_import_callback`  (lines 175–221)

```
fn dynamic_import_callback(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    _resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::Str
```

**Purpose**: Handles JS `import()` by attempting the same restricted module resolution and returning a promise that resolves to the module namespace or rejects with an error.

**Data flow**: Converts the specifier to Rust text and allocates a `PromiseResolver`. Calls `resolve_module`; when a module is returned, it instantiates and evaluates it if needed, rejecting the promise with fallback string/`undefined` errors if either step fails, otherwise resolving with the module namespace. When resolution returns `None`, it rejects the promise with `"unsupported import in exec"` (or `undefined` if allocation fails) and returns the promise.

**Call relations**: Registered by `run_runtime` as the isolate’s host dynamic import callback. It shares the same underlying `resolve_module` policy as `resolve_module_callback`, but wraps failures in a promise because dynamic import is asynchronous.

*Call graph*: calls 1 internal fn (resolve_module); 4 external calls (to_rust_string_lossy, matches!, new, new).


##### `resolve_module`  (lines 223–235)

```
fn resolve_module(
    scope: &mut v8::PinScope<'s, '_>,
    specifier: &str,
) -> Option<v8::Local<'s, v8::Module>>
```

**Purpose**: Rejects all imports by throwing a V8 exception that names the unsupported specifier and returning no module.

**Data flow**: Formats `Unsupported import in exec: {specifier}`, tries to allocate it as a V8 string, throws that string as an exception when possible, otherwise throws `undefined`, and returns `None`.

**Call relations**: Called by both `resolve_module_callback` and `dynamic_import_callback`. It is the single enforcement point for the runtime’s deliberate prohibition on imports.

*Call graph*: called by 2 (dynamic_import_callback, resolve_module_callback); 4 external calls (throw_exception, format!, new, undefined).


### `code-mode/src/runtime/timers.rs`

`domain_logic` · `during JS timer scheduling and timeout delivery`

This file provides a deliberately small timer subsystem. `ScheduledTimeout` stores only a `v8::Global<v8::Function>` callback; there is no interval support, argument passing, or timer wheel. `schedule_timeout` validates that the first JS argument is a function, reads the second argument as a numeric delay, normalizes invalid, negative, non-finite, or fractional values into a bounded `u64` millisecond count, then stores the callback in `RuntimeState.pending_timeouts` under the next timeout id. It also clones `runtime_command_tx` and spawns a plain OS thread that sleeps for the computed duration and sends `RuntimeCommand::TimeoutFired { id }` back to the runtime.

`clear_timeout` parses the timeout id using `timeout_id_from_args`; null, undefined, missing, non-positive, and non-finite ids are treated as no-ops rather than errors, while non-numeric values produce a descriptive error. If a valid id is present, it simply removes that entry from `pending_timeouts`. `invoke_timeout_callback` is called on the runtime thread when a timeout command arrives: it removes the callback from the map, returns success if it was already cleared, and otherwise invokes the function inside a `TryCatch` with `undefined` as the receiver and no arguments. Any thrown JS exception is converted to text with `value_to_error_text` and propagated upward so the runtime can terminate with an error.

#### Function details

##### `schedule_timeout`  (lines 12–45)

```
fn schedule_timeout(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<u64, String>
```

**Purpose**: Registers a one-shot timeout callback in runtime state, spawns a sleeping thread, and returns the assigned timeout id.

**Data flow**: Reads `args.get(0)` and requires it to be a function, converting it to `v8::Function` or returning `Err("setTimeout expects a function callback")`. Reads `args.get(1).number_value(scope)`, normalizes it with `normalize_delay_ms`, wraps the callback in `v8::Global`, mutably accesses `RuntimeState` to fetch and increment `next_timeout_id`, clones `runtime_command_tx`, inserts `ScheduledTimeout { callback }` into `pending_timeouts`, and spawns a thread that sleeps `Duration::from_millis(delay_ms)` before sending `RuntimeCommand::TimeoutFired { id: timeout_id }`. Returns the `u64` timeout id.

**Call relations**: Called by `callbacks::set_timeout_callback` when JS invokes `setTimeout`. The command it sends later is consumed by `run_runtime`, which delegates back to `invoke_timeout_callback`.

*Call graph*: called by 1 (set_timeout_callback); 4 external calls (get, spawn, new, try_from).


##### `clear_timeout`  (lines 47–60)

```
fn clear_timeout(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<(), String>
```

**Purpose**: Removes a pending timeout from runtime state when given a valid timeout id, treating absent or ignorable ids as a no-op.

**Data flow**: Calls `timeout_id_from_args(scope, args)` to parse the first argument. If parsing yields `Ok(None)`, returns success immediately. Otherwise mutably reads `RuntimeState`, removes the timeout id from `pending_timeouts`, and returns `Ok(())`; missing runtime state becomes an error string.

**Call relations**: Called by `callbacks::clear_timeout_callback`. It delegates all argument interpretation to `timeout_id_from_args` and performs only the state mutation.

*Call graph*: calls 1 internal fn (timeout_id_from_args); called by 1 (clear_timeout_callback).


##### `invoke_timeout_callback`  (lines 62–89)

```
fn invoke_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    timeout_id: u64,
) -> Result<(), String>
```

**Purpose**: Executes a previously scheduled timeout callback on the runtime thread and reports any thrown JS exception as a Rust error.

**Data flow**: Mutably reads `RuntimeState.pending_timeouts` and removes the entry for `timeout_id`; if none exists, returns `Ok(())` because the timeout was cleared or already consumed. Otherwise enters a `TryCatch`, converts the stored global callback to a local function, calls it with `undefined` receiver and no arguments, and if V8 caught an exception converts that exception to text with `value_to_error_text` and returns `Err(String)`. Successful invocation returns `Ok(())`.

**Call relations**: Called by `run_runtime` when it processes `RuntimeCommand::TimeoutFired`. It is the execution half of the timer subsystem paired with `schedule_timeout`.

*Call graph*: called by 1 (run_runtime); 3 external calls (pin!, new, undefined).


##### `timeout_id_from_args`  (lines 90–106)

```
fn timeout_id_from_args(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<Option<u64>, String>
```

**Purpose**: Parses the first `clearTimeout` argument into an optional normalized timeout id.

**Data flow**: Checks `args.length()` and `args.get(0)`; missing, `null`, or `undefined` returns `Ok(None)`. Otherwise attempts `number_value(scope)`; failure returns `Err("clearTimeout expects a numeric timeout id")`. Non-finite or non-positive numbers return `Ok(None)`, while valid numbers are truncated, clamped to `u64::MAX`, cast to `u64`, and returned as `Ok(Some(id))`.

**Call relations**: Used only by `clear_timeout` to keep its control flow simple and to encode the runtime’s permissive no-op semantics for many invalid-ish timeout ids.

*Call graph*: called by 1 (clear_timeout); 2 external calls (get, length).


##### `normalize_delay_ms`  (lines 108–114)

```
fn normalize_delay_ms(delay_ms: f64) -> u64
```

**Purpose**: Converts a floating-point JS delay into a non-negative bounded millisecond count suitable for `Duration::from_millis`.

**Data flow**: Accepts an `f64`; returns `0` for non-finite or non-positive values, otherwise truncates fractional milliseconds, clamps to `u64::MAX as f64`, and casts to `u64`.

**Call relations**: Called by `schedule_timeout` after reading the JS delay argument. It isolates the numeric normalization policy for timer delays.


### Compaction paths
These files cover the manual compaction task and the two underlying implementations for local and provider-backed transcript compaction.

### `core/src/tasks/compact.rs`

`domain_logic` · `manual compaction turn execution`

This file defines `CompactTask`, a zero-sized task type implementing the `SessionTask` trait for manual compaction requests. Its metadata methods are simple: `kind()` identifies the task as `TaskKind::Compact`, and `span_name()` supplies the tracing span label `session_task.compact`. The substantive logic is in `run()`, which clones the underlying session from `SessionTaskContext` and then chooses one of three compaction implementations.

The branch point is `crate::compact::should_use_remote_compact_task(ctx.provider.info())`. If the provider supports remote compaction, the task checks the `RemoteCompactionV2` feature flag: when enabled it emits a `remote_v2` compact metric and awaits `crate::compact_remote_v2::run_remote_compact_task`; otherwise it emits `remote` and uses the older `crate::compact_remote::run_remote_compact_task`. If remote compaction is not appropriate, it emits `local`, synthesizes a single `UserInput::Text` containing `ctx.compact_prompt()` with empty `text_elements` because the prompt is generated rather than user-selected, and runs `crate::compact::run_compact_task`. The result of the chosen compaction routine is intentionally ignored, and the task always returns `None`, indicating no direct follow-up assistant message string is produced by the task wrapper itself.

#### Function details

##### `CompactTask::kind`  (lines 16–18)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Reports that this session task is the compact-task variant. This lets task orchestration classify and track it distinctly from regular or review turns.

**Data flow**: It takes `&self` and returns the constant `TaskKind::Compact` without reading or mutating any other state.

**Call relations**: Called by generic task orchestration through the `SessionTask` trait when it needs to label the running task. It has no downstream delegation.


##### `CompactTask::span_name`  (lines 20–22)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides the tracing span name used when running this task. The fixed string identifies compact-task execution in telemetry and logs.

**Data flow**: It takes `&self` and returns the static string slice `"session_task.compact"`. No state is read or written.

**Call relations**: Used by task orchestration infrastructure via the `SessionTask` trait to create spans around task execution. It is a pure metadata accessor.


##### `CompactTask::run`  (lines 24–65)

```
async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        _cancellation_token: CancellationToken,
    ) ->
```

**Purpose**: Executes manual compaction by selecting the appropriate local or remote implementation, emitting a metric for the chosen path, and invoking the compaction routine. It abstracts provider capability and feature-flag differences behind one task entry point.

**Data flow**: It takes `Arc<Self>`, `Arc<SessionTaskContext>`, `Arc<TurnContext>`, ignored turn inputs, and an ignored cancellation token. The method clones the session from the task context, checks `should_use_remote_compact_task(ctx.provider.info())`, and then either: (a) if remote is supported and `RemoteCompactionV2` is enabled, emits a `remote_v2` metric and awaits `compact_remote_v2::run_remote_compact_task`; (b) if remote is supported but V2 is disabled, emits `remote` and awaits `compact_remote::run_remote_compact_task`; or (c) otherwise emits `local`, builds a one-element `Vec<UserInput>` containing the synthesized compact prompt with empty `text_elements`, and awaits `compact::run_compact_task`. The chosen routine's result is bound to `_` and discarded, and the function returns `None`.

**Call relations**: This is invoked by the session task runner when a compact task starts. It delegates the actual compaction work to one of the local or remote compaction modules and emits telemetry before each branch so the runtime can distinguish which implementation path was taken.

*Call graph*: calls 4 internal fn (run_compact_task, should_use_remote_compact_task, run_remote_compact_task, run_remote_compact_task); 2 external calls (emit_compact_metric, vec!).


### `core/src/compact_remote.rs`

`domain_logic` · `turn compaction`

This file is the remote counterpart to local compaction. `run_inline_remote_auto_compact_task` and `run_remote_compact_task` are the automatic and manual entry points; both route through `run_remote_compact_task_inner`, which mirrors the local wrapper structure by creating compaction metadata, collecting analytics, running pre/post compact hooks, and converting failures into emitted error events.

`run_remote_compact_task_inner_impl` performs the remote-specific work. It creates a `ContextCompactionItem`, derives a rollout trace context keyed by the UI compaction item ID, clones current history, and calls `trim_function_call_history_to_fit_context_window` before sending anything remotely. That trimming step rewrites oversized `FunctionCallOutput`, `CustomToolCallOutput`, and `ToolSearchOutput` items into compact placeholders so the compact endpoint itself fits within the provider context window; analytics are adjusted to avoid overstating active-context tokens after local deletions. The function then builds a prompt from history plus model-visible tools, calls `model_client.compact_conversation_history`, post-processes the returned transcript with `process_compacted_history`, records an installed-history checkpoint in rollout tracing, replaces session history, and recomputes token usage.

The helper layer is important: `process_compacted_history` drops stale developer messages and non-user wrapper content from remote output, optionally rebuilds canonical initial context, and reinserts it before the last real user message or summary. `should_keep_compacted_history_item` encodes exactly which `ResponseItem` variants survive. The file also defines how oversized tool outputs are rewritten, using a fixed truncation message for text payloads and empty tool lists for search outputs.

#### Function details

##### `run_inline_remote_auto_compact_task`  (lines 44–63)

```
async fn run_inline_remote_auto_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    turn_state: Arc<OnceLock<String>>,
    initial_context_injection: InitialContextInjection,
```

**Purpose**: Runs automatic remote compaction inline for an active turn. It is the auto-compaction entry point for the original remote compact endpoint.

**Data flow**: Takes shared `Session`, `TurnContext`, optional shared `OnceLock<String>` turn state, injection mode, reason, and phase → forwards them to `run_remote_compact_task_inner` with `CompactionTrigger::Auto` → returns `Ok(())` on success.

**Call relations**: Called by auto-compaction orchestration when the provider supports the remote compact endpoint and the original remote implementation is selected.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run_auto_compact).


##### `run_remote_compact_task`  (lines 65–89)

```
async fn run_remote_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()>
```

**Purpose**: Runs a manual standalone remote compaction turn and emits a `TurnStarted` event first. It is the user-requested entry point for the original remote compact endpoint.

**Data flow**: Accepts shared `Session` and `TurnContext` → constructs and sends `EventMsg::TurnStarted` from turn metadata → calls `run_remote_compact_task_inner` with no turn state, `InitialContextInjection::DoNotInject`, `CompactionTrigger::Manual`, `CompactionReason::UserRequested`, and `CompactionPhase::StandaloneTurn` → returns `Ok(())` or error.

**Call relations**: Called by the general run path when manual compaction uses the original remote endpoint.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run); 1 external calls (TurnStarted).


##### `run_remote_compact_task_inner`  (lines 91–167)

```
async fn run_remote_compact_task_inner(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    turn_state: Option<Arc<OnceLock<String>>>,
    initial_context_injection: InitialContextInject
```

**Purpose**: Wraps remote compaction execution with analytics, hook handling, and error-event emission. It is the common control shell for both manual and automatic remote compaction.

**Data flow**: Takes session/context references, optional turn state, injection mode, trigger, reason, and phase → builds `CompactionTurnMetadata` for `ResponsesCompact`, seeds `CompactionAnalyticsDetails` with current token usage, starts `CompactionAnalyticsAttempt`, runs pre-compact hooks and aborts with tracked `TurnAborted` if stopped → awaits `run_remote_compact_task_inner_impl` → computes final status with `compaction_status_from_result` → on success, runs post-compact hooks and may convert to `TurnAborted` → tracks analytics → if the inner result is `Err`, records the turn error, emits `EventMsg::Error` with a remote-compaction prefix, and returns the error; otherwise returns `Ok(())`.

**Call relations**: Called by both remote entry points so analytics and hook semantics match the local compaction wrapper.

*Call graph*: calls 6 internal fn (begin, compaction_status_from_result, run_remote_compact_task_inner_impl, run_post_compact_hooks, run_pre_compact_hooks, new); called by 2 (run_inline_remote_auto_compact_task, run_remote_compact_task); 2 external calls (default, Error).


##### `run_remote_compact_task_inner_impl`  (lines 169–294)

```
async fn run_remote_compact_task_inner_impl(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    turn_state: Option<Arc<OnceLock<String>>>,
    initial_context_injection: InitialContextI
```

**Purpose**: Performs the actual remote compact-endpoint request, transcript post-processing, rollout tracing, and history installation. This is the core algorithm for the original remote compaction implementation.

**Data flow**: Accepts session/context refs, optional turn state, injection mode, compaction metadata, and mutable analytics details → creates a `ContextCompactionItem` and compaction trace context → emits started turn item → clones history and base instructions → rewrites oversized function/tool outputs with `trim_function_call_history_to_fit_context_window`, logging and adjusting analytics token counts when rewriting occurs → snapshots rewritten input history for tracing → builds prompt input and model-visible tools via `built_tools` → computes responses metadata → calls `model_client.compact_conversation_history(...)` with prompt, model info, optional turn state, request settings, telemetry, trace, and metadata → advances window ID → sanitizes and context-reinjects returned history with `process_compacted_history` → chooses reference context item based on injection mode → records installed checkpoint trace, replaces compacted history in session, recomputes token usage, emits completed turn item, and returns `Ok(())`.

**Call relations**: Called only by `run_remote_compact_task_inner`; it delegates transcript filtering to `process_compacted_history` and preflight shrinking to `trim_function_call_history_to_fit_context_window`.

*Call graph*: calls 4 internal fn (process_compacted_history, trim_function_call_history_to_fit_context_window, built_tools, new); called by 1 (run_remote_compact_task_inner); 5 external calls (new, new, ContextCompaction, Compaction, info!).


##### `process_compacted_history`  (lines 296–316)

```
async fn process_compacted_history(
    sess: &Session,
    turn_context: &TurnContext,
    mut compacted_history: Vec<ResponseItem>,
    initial_context_injection: InitialContextInjection,
) -> Vec<R
```

**Purpose**: Sanitizes remote compacted history and optionally reinjects canonical initial context. It ensures the installed transcript shape matches local expectations rather than trusting remote output verbatim.

**Data flow**: Takes `&Session`, `&TurnContext`, mutable `Vec<ResponseItem>`, and injection mode → if injection mode is `BeforeLastUserMessage`, builds fresh initial context from the current session; otherwise uses an empty vector → retains only items for which `should_keep_compacted_history_item` returns true → calls `insert_initial_context_before_last_real_user_or_summary` with the filtered history and initial context → returns the resulting history.

**Call relations**: Used after remote compaction output is received, and also directly by tests that validate transcript sanitation and context reinjection behavior.

*Call graph*: calls 1 internal fn (insert_initial_context_before_last_real_user_or_summary); called by 4 (run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl, process_compacted_history_with_test_session, process_compacted_history_preserves_separate_guardian_developer_message); 3 external calls (new, build_initial_context, matches!).


##### `should_keep_compacted_history_item`  (lines 334–360)

```
fn should_keep_compacted_history_item(item: &ResponseItem) -> bool
```

**Purpose**: Decides which items from remote compaction output are safe to preserve. It drops stale developer/context wrapper content while keeping real user messages, hook prompts, assistant messages, agent messages, and compaction markers.

**Data flow**: Matches on `&ResponseItem` → returns `false` for developer messages, `CompactionTrigger`, and most tool/reasoning/call/output variants → for user messages, parses the item and keeps only `TurnItem::UserMessage` or `TurnItem::HookPrompt` → returns `true` for assistant messages, `AgentMessage`, `Compaction`, and `ContextCompaction`.

**Call relations**: Called by `process_compacted_history` to filter remote output before canonical context is reinserted.

*Call graph*: 1 external calls (matches!).


##### `trim_function_call_history_to_fit_context_window`  (lines 362–402)

```
fn trim_function_call_history_to_fit_context_window(
    history: &mut ContextManager,
    turn_context: &TurnContext,
    base_instructions: &BaseInstructions,
) -> (usize, i64)
```

**Purpose**: Rewrites oversized tool-output history items until the prompt estimate fits the model context window. It is a preflight shrinking pass used before sending history to the remote compact endpoint.

**Data flow**: Takes mutable `ContextManager`, `&TurnContext`, and `&BaseInstructions` → reads model context window; if absent returns `(0, 0)` → walks history indices from newest to oldest, repeatedly estimating token count with base instructions → while estimate exceeds the window, tries to rewrite the current item with `rewritten_output_for_context_window`; if rewriting succeeds, replaces that item in the history, recomputes estimated tokens, increments rewritten count, and accumulates deleted-token estimate → stops when history fits, no estimate is available, or the current item is not rewritable → returns `(rewritten_outputs, estimated_deleted_tokens)`.

**Call relations**: Used before remote compaction requests so large tool outputs do not prevent the compact endpoint from accepting the transcript.

*Call graph*: calls 4 internal fn (estimate_token_count_with_base_instructions, raw_items, replace, model_context_window); called by 2 (run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl).


##### `rewritten_output_for_context_window`  (lines 404–441)

```
fn rewritten_output_for_context_window(item: &ResponseItem) -> Option<ResponseItem>
```

**Purpose**: Produces a compact placeholder version of a rewritable output item. It only rewrites output-bearing tool result variants and leaves all other items untouched by returning `None`.

**Data flow**: Matches a `&ResponseItem` → for `FunctionCallOutput` and `CustomToolCallOutput`, clones identifying fields and replaces `output` with `truncated_output_payload(output)` → for `ToolSearchOutput`, clones identifiers/status/execution, replaces `tools` with an empty vector, and preserves metadata → returns `Some(rewritten_item)` or `None` for unsupported variants.

**Call relations**: Called by `trim_function_call_history_to_fit_context_window` when searching for history items that can be shrunk safely.

*Call graph*: calls 1 internal fn (truncated_output_payload); 1 external calls (new).


##### `truncated_output_payload`  (lines 443–448)

```
fn truncated_output_payload(output: &FunctionCallOutputPayload) -> FunctionCallOutputPayload
```

**Purpose**: Builds a placeholder `FunctionCallOutputPayload` indicating that original output was truncated to fit context. It preserves the original success flag while replacing the body text.

**Data flow**: Takes `&FunctionCallOutputPayload` → constructs a new payload with `body = FunctionCallOutputBody::Text(CONTEXT_WINDOW_TRUNCATED_OUTPUT_MESSAGE.to_string())` and `success = output.success` → returns it.

**Call relations**: Used by `rewritten_output_for_context_window` for output variants that carry a `FunctionCallOutputPayload`.

*Call graph*: called by 1 (rewritten_output_for_context_window); 1 external calls (Text).


### `core/src/compact.rs`

`domain_logic` · `turn compaction`

This file contains the local compaction engine. It defines `InitialContextInjection`, which controls whether canonical initial context is omitted entirely from replacement history or reinserted just before the last real user message for mid-turn compaction. `run_inline_auto_compact_task` and `run_compact_task` are the public entry points for automatic and manual compaction; both funnel into `run_compact_task_inner`, which wraps the actual work with analytics, pre/post compact hooks, and status classification.

The heavy lifting happens in `run_compact_task_inner_impl`. It emits a `ContextCompaction` turn item, clones current history, records the synthesized compaction prompt as input, and repeatedly streams a model response through `drain_to_completed`. Retry behavior is provider-driven; transient stream failures back off and retry, while `ContextWindowExceeded` causes oldest-history trimming when possible. Once a summary is produced, the code extracts the last assistant message as the summary body, prefixes it with `SUMMARY_PREFIX`, collects surviving real user messages from the original history, and rebuilds replacement history with `build_compacted_history`. Depending on `InitialContextInjection`, it may splice fresh canonical initial context back in before the last real user message or summary. The session then installs the compacted history, recomputes token usage, emits completion, and sends a warning about long-thread accuracy degradation.

The file also centralizes analytics (`CompactionAnalyticsAttempt`), summary detection, user-message extraction that filters synthetic/session-prefix content, and token-budgeted rebuilding of retained user messages with truncation markers.

#### Function details

##### `should_use_remote_compact_task`  (lines 69–71)

```
fn should_use_remote_compact_task(provider: &ModelProviderInfo) -> bool
```

**Purpose**: Determines whether a provider should use remote compaction instead of the local inline path. It is a thin policy wrapper over provider capabilities.

**Data flow**: Takes `&ModelProviderInfo` → calls `supports_remote_compaction()` → returns `bool`.

**Call relations**: Used by compaction orchestration to choose between local and remote implementations before a compaction turn starts.

*Call graph*: calls 1 internal fn (supports_remote_compaction); called by 2 (run_auto_compact, run).


##### `run_inline_auto_compact_task`  (lines 73–98)

```
async fn run_inline_auto_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    initial_context_injection: InitialContextInjection,
    reason: CompactionReason,
    phase: Comp
```

**Purpose**: Starts an automatic local compaction turn using a synthesized prompt from the current turn context. It is the auto-compaction entry point for the inline implementation.

**Data flow**: Takes shared `Session`, `TurnContext`, `InitialContextInjection`, `CompactionReason`, and `CompactionPhase` → builds a single `UserInput::Text` from `turn_context.compact_prompt()` with empty `text_elements` → calls `run_compact_task_inner` with `CompactionTrigger::Auto` → returns `Ok(())` on success.

**Call relations**: Called by auto-compaction orchestration when the provider does not use a remote compaction endpoint.

*Call graph*: calls 1 internal fn (run_compact_task_inner); called by 1 (run_auto_compact); 1 external calls (vec!).


##### `run_compact_task`  (lines 100–124)

```
async fn run_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
) -> CodexResult<()>
```

**Purpose**: Runs a manual standalone local compaction turn and emits the usual `TurnStarted` event first. It is the user-requested entry point for inline compaction.

**Data flow**: Accepts shared `Session`, `TurnContext`, and explicit `Vec<UserInput>` → constructs and sends `EventMsg::TurnStarted` using turn ID, trace ID, start time, context window, and collaboration mode → calls `run_compact_task_inner` with `InitialContextInjection::DoNotInject`, `CompactionTrigger::Manual`, `CompactionReason::UserRequested`, and `CompactionPhase::StandaloneTurn` → returns `Ok(())` or error.

**Call relations**: Called by the general run path when a user explicitly requests compaction and the local implementation is selected.

*Call graph*: calls 1 internal fn (run_compact_task_inner); called by 1 (run); 1 external calls (TurnStarted).


##### `run_compact_task_inner`  (lines 126–195)

```
async fn run_compact_task_inner(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
    initial_context_injection: InitialContextInjection,
    trigger: CompactionT
```

**Purpose**: Wraps local compaction execution with analytics and pre/post compact hooks. It is the common control-flow shell around the actual compaction implementation.

**Data flow**: Takes session/context, input, injection mode, trigger, reason, and phase → builds `CompactionTurnMetadata` and starts `CompactionAnalyticsAttempt` → runs pre-compact hooks and aborts with tracked `TurnAborted` if they stop execution → awaits `run_compact_task_inner_impl` → derives `CompactionStatus` from the result → if successful, runs post-compact hooks and may convert success into `TurnAborted` → tracks analytics with status/error/details → returns `Ok(())` or propagated `CodexErr`.

**Call relations**: Called by both manual and automatic local compaction entry points so hook handling and analytics remain identical across triggers.

*Call graph*: calls 6 internal fn (begin, compaction_status_from_result, run_compact_task_inner_impl, run_post_compact_hooks, run_pre_compact_hooks, new); called by 2 (run_compact_task, run_inline_auto_compact_task); 2 external calls (clone, default).


##### `run_compact_task_inner_impl`  (lines 197–331)

```
async fn run_compact_task_inner_impl(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
    initial_context_injection: InitialContextInjection,
    compaction_meta
```

**Purpose**: Performs the actual local compaction request, retry loop, summary extraction, replacement-history construction, and session history installation. This is the core algorithm for inline compaction.

**Data flow**: Accepts session/context, user input, injection mode, and compaction metadata → emits a started `ContextCompaction` item → clones history and records the compaction input into it → creates one reusable `ModelClientSession`, computes responses metadata, and loops: build prompt from current history plus base instructions/personality, call `drain_to_completed`, retry transient failures with `backoff`, trim oldest history on `ContextWindowExceeded`, or emit tracked errors on terminal failure → after success, clones session history, extracts the last assistant message as summary suffix, prefixes it with `SUMMARY_PREFIX`, collects real user messages via `collect_user_messages`, builds replacement history with `build_compacted_history`, optionally injects fresh initial context with `insert_initial_context_before_last_real_user_or_summary`, computes reference context item based on injection mode, installs `CompactedItem` via `replace_compacted_history`, recomputes token usage, emits completion, sends a warning event, and returns the raw summary suffix string.

**Call relations**: Called only by `run_compact_task_inner`; it delegates streaming to `drain_to_completed` and history shaping to the helper functions in this file.

*Call graph*: calls 8 internal fn (build_compacted_history, collect_user_messages, drain_to_completed, insert_initial_context_before_last_real_user_or_summary, get_last_assistant_message_from_turn, backoff, new, from); called by 1 (run_compact_task_inner); 10 external calls (default, new, ContextCompaction, Compaction, error!, format!, matches!, Error, Warning, sleep).


##### `CompactionAnalyticsAttempt::begin`  (lines 354–374)

```
async fn begin(
        sess: &Session,
        turn_context: &TurnContext,
        trigger: CompactionTrigger,
        reason: CompactionReason,
        implementation: CompactionImplementation,
```

**Purpose**: Captures the starting analytics snapshot for a compaction attempt. It records thread/turn identity, trigger metadata, current token usage, and timing baselines.

**Data flow**: Reads `Session` thread ID and total token usage plus `TurnContext` turn ID → stores trigger/reason/implementation/phase, `started_at` from `now_unix_seconds()`, and `start_instant` from `Instant::now()` → returns a populated `CompactionAnalyticsAttempt`.

**Call relations**: Called at the start of both local and remote compaction wrappers so later tracking can compute before/after token counts and duration.

*Call graph*: called by 3 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner); 3 external calls (now, now_unix_seconds, get_total_token_usage).


##### `CompactionAnalyticsAttempt::track`  (lines 376–417)

```
async fn track(
        self,
        sess: &Session,
        status: CompactionStatus,
        codex_error: Option<&CodexErr>,
        details: CompactionAnalyticsDetails,
    )
```

**Purpose**: Emits the final analytics event for a compaction attempt. It combines captured start state, optional detail overrides, current token usage, error classification, and elapsed time.

**Data flow**: Consumes `self`, takes `&Session`, final `CompactionStatus`, optional `&CodexErr`, and `CompactionAnalyticsDetails` → resolves detail overrides or falls back to stored `active_context_tokens_before` → reads current total token usage as `active_context_tokens_after` → constructs `CodexCompactionEvent` with strategy `Memento`, optional error kind/http status, retained image count, summary/cached token counts, timestamps, and elapsed milliseconds converted to `u64` → sends it through `sess.services.analytics_events_client.track_compaction(...)`.

**Call relations**: Called by compaction wrappers after success, interruption, or failure so every attempt produces one analytics record.

*Call graph*: 4 external calls (elapsed, now_unix_seconds, get_total_token_usage, try_from).


##### `compaction_status_from_result`  (lines 420–426)

```
fn compaction_status_from_result(result: &CodexResult<T>) -> CompactionStatus
```

**Purpose**: Maps a `CodexResult` from compaction execution into analytics status categories. It distinguishes completed, interrupted, and failed outcomes.

**Data flow**: Reads a `&CodexResult<T>` → returns `CompactionStatus::Completed` for `Ok`, `Interrupted` for `CodexErr::Interrupted` or `TurnAborted`, and `Failed` for all other errors.

**Call relations**: Used by both local and remote compaction wrappers before analytics tracking.

*Call graph*: called by 3 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner).


##### `content_items_to_text`  (lines 428–445)

```
fn content_items_to_text(content: &[ContentItem]) -> Option<String>
```

**Purpose**: Extracts and joins textual content from a `ContentItem` slice, ignoring images and empty text segments. It is a utility for tests and transcript-building code.

**Data flow**: Iterates `&[ContentItem]` → collects non-empty `InputText` and `OutputText` strings into a vector → returns `None` if no text was found, otherwise joins pieces with `\n` and returns `Some(String)`.

**Call relations**: Used outside compaction proper by transcript/reporting code and by tests that need to inspect message text content.

*Call graph*: called by 2 (collect_guardian_transcript_entries, build_current_thread_section); 1 external calls (new).


##### `collect_user_messages`  (lines 453–473)

```
fn collect_user_messages(items: &[ResponseItem]) -> Vec<CompactedUserMessage>
```

**Purpose**: Extracts real user messages from response history for retention in compacted history. It filters out summary messages and any items that do not parse as `TurnItem::UserMessage`.

**Data flow**: Takes `&[ResponseItem]` → iterates items and parses each with `crate::event_mapping::parse_turn_item` → keeps only `TurnItem::UserMessage` values whose text is not recognized by `is_summary_message` → for each kept item, builds `CompactedUserMessage { message, metadata }`, preserving `ResponseItem::Message.metadata` when present → returns `Vec<CompactedUserMessage>`.

**Call relations**: Used during local compaction history rebuilding and rollout reconstruction to retain only meaningful user-authored content.

*Call graph*: called by 2 (run_compact_task_inner_impl, reconstruct_history_from_rollout); 1 external calls (iter).


##### `is_summary_message`  (lines 475–477)

```
fn is_summary_message(message: &str) -> bool
```

**Purpose**: Recognizes whether a user-role message is actually a compaction summary. It relies on the canonical `SUMMARY_PREFIX` marker.

**Data flow**: Takes `&str` → formats `"{SUMMARY_PREFIX}\n"` and checks `starts_with` → returns `bool`.

**Call relations**: Used when filtering retained user messages and when deciding where to reinsert initial context relative to summary items.

*Call graph*: called by 1 (insert_initial_context_before_last_real_user_or_summary); 1 external calls (format!).


##### `insert_initial_context_before_last_real_user_or_summary`  (lines 489–534)

```
fn insert_initial_context_before_last_real_user_or_summary(
    mut compacted_history: Vec<ResponseItem>,
    initial_context: Vec<ResponseItem>,
) -> Vec<ResponseItem>
```

**Purpose**: Splices canonical initial context into compacted replacement history at the model-expected boundary. It preserves the final summary or compaction item as the last history element whenever possible.

**Data flow**: Takes mutable `Vec<ResponseItem>` compacted history and `Vec<ResponseItem>` initial context → scans history in reverse, using `parse_turn_item` to find the last real user message and fallback last user-or-summary item, and separately finds the last compaction item index → chooses insertion point in priority order: last real user, else last user/summary, else last compaction → inserts initial context at that index with `splice`, or appends if no insertion point exists → returns the modified history.

**Call relations**: Used by both local and remote compaction processing whenever mid-turn compaction requires canonical context reinjection without moving the summary/compaction terminator.

*Call graph*: calls 2 internal fn (is_summary_message, parse_turn_item); called by 2 (run_compact_task_inner_impl, process_compacted_history).


##### `build_compacted_history`  (lines 536–547)

```
fn build_compacted_history(
    initial_context: Vec<ResponseItem>,
    user_messages: &[CompactedUserMessage],
    summary_text: &str,
) -> Vec<ResponseItem>
```

**Purpose**: Builds compacted replacement history using the default retained-user token budget. It is the public helper over the token-limited implementation.

**Data flow**: Takes initial context, retained `CompactedUserMessage` slice, and summary text → calls `build_compacted_history_with_limit(..., COMPACT_USER_MESSAGE_MAX_TOKENS)` → returns the resulting `Vec<ResponseItem>`.

**Call relations**: Used by local compaction and rollout reconstruction when the standard retained-user budget should apply.

*Call graph*: calls 1 internal fn (build_compacted_history_with_limit); called by 3 (run_compact_task_inner_impl, reconstruct_history_from_rollout, sample_rollout).


##### `build_compacted_history_with_limit`  (lines 549–606)

```
fn build_compacted_history_with_limit(
    mut history: Vec<ResponseItem>,
    user_messages: &[CompactedUserMessage],
    summary_text: &str,
    max_tokens: usize,
) -> Vec<ResponseItem>
```

**Purpose**: Constructs replacement history from initial context, a suffix of retained user messages, and a final summary message while enforcing a token budget. It truncates the oldest retained portion first by walking messages from newest to oldest.

**Data flow**: Takes mutable initial `Vec<ResponseItem>`, retained user messages, summary text, and `max_tokens` → iterates user messages in reverse, estimating tokens with `approx_token_count`; keeps whole messages while budget remains, or truncates one over-budget message with `truncate_text(TruncationPolicy::Tokens(...))` and stops → reverses selected messages back to chronological order → appends each as a `ResponseItem::Message` with role `user`, preserving metadata → normalizes empty summary text to `"(no summary available)"` → appends the summary as the final user message → returns the built history.

**Call relations**: Called by `build_compacted_history`; tests target it directly to validate truncation behavior.

*Call graph*: called by 1 (build_compacted_history); 6 external calls (new, approx_token_count, truncate_text, iter, Tokens, vec!).


##### `drain_to_completed`  (lines 608–657)

```
async fn drain_to_completed(
    sess: &Session,
    turn_context: &TurnContext,
    client_session: &mut ModelClientSession,
    responses_metadata: &CodexResponsesMetadata,
    prompt: &Prompt,
) ->
```

**Purpose**: Consumes a model response stream for local compaction until `response.completed`, recording relevant side effects into the session. It treats premature stream closure as an error.

**Data flow**: Takes `&Session`, `&TurnContext`, mutable `ModelClientSession`, responses metadata, and prompt → starts `client_session.stream(...)` with disabled inference tracing → loops over stream events: records `OutputItemDone` items into conversation history, updates server reasoning inclusion and rate limits on corresponding events, updates token usage and returns `Ok(())` on `Completed`, ignores unrelated events, and returns any stream/model error immediately → if the stream ends before `Completed`, returns `CodexErr::Stream`.

**Call relations**: Used only by `run_compact_task_inner_impl` as the low-level streaming primitive for local compaction requests.

*Call graph*: calls 2 internal fn (stream, disabled); called by 1 (run_compact_task_inner_impl); 6 external calls (record_conversation_items, set_server_reasoning_included, update_rate_limits, update_token_usage_info, Stream, from_ref).


### Turn execution
These files describe how a normal turn is launched, enriched with metadata, and then executed through the central turn engine until completion.

### `core/src/tasks/regular.rs`

`domain_logic` · `main turn execution`

This file defines `RegularTask`, the default `SessionTask` used for ordinary turns. The type itself is empty and `Default`, because all per-turn state lives in `TurnContext`, the input vector, and session-managed queues. Its `kind` reports `TaskKind::Regular`, and its tracing span name is fixed to `session_task.turn`.

The main logic is in `run`. It first clones the underlying `Session` and turn extension data from `SessionTaskContext`, then creates a `trace_span!("run_turn")` reused across loop iterations. Before invoking the core turn engine, it emits `EventMsg::TurnStarted` directly from this task rather than waiting on startup prewarm resolution; that design ensures clients see turn start promptly even on the first turn. In the same preparation block it sets server reasoning inclusion to false and asks the session to consume any startup prewarm, passing the cancellation token so prewarm waiting can be interrupted.

The prewarm result is normalized into `Option<...>`: cancellation exits the task immediately with `None`, unavailable prewarm becomes `None`, and ready prewarm unwraps the boxed client session. The task then enters a loop calling `run_turn` with the current input, the optional prewarmed client session only on the first iteration, and a child cancellation token. After each run it checks `sess.input_queue.has_pending_input(&sess.active_turn)`. If no pending input remains, it returns the last agent message from `run_turn`; otherwise it clears `next_input` to an empty vector and loops so queued follow-up input is processed within the same active turn.

#### Function details

##### `RegularTask::new`  (lines 22–24)

```
fn new() -> Self
```

**Purpose**: Constructs the empty regular-turn task value.

**Data flow**: Takes no arguments and returns `RegularTask` by value.

**Call relations**: Session startup paths and tests instantiate this before passing it into task spawning. It carries no configuration itself.

*Call graph*: called by 5 (user_input_or_turn_inner, try_start_turn_if_idle, interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm, maybe_start_turn_for_pending_work_with_sub_id).


##### `RegularTask::kind`  (lines 28–30)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Identifies this task as a regular conversational turn.

**Data flow**: Reads `self` and returns `TaskKind::Regular`.

**Call relations**: The session task framework queries this through the task trait to label running work and telemetry.


##### `RegularTask::span_name`  (lines 32–34)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Supplies the tracing span name used for the outer spawned task span.

**Data flow**: Reads `self` and returns the static string `"session_task.turn"`.

**Call relations**: Task startup uses this when creating the `info_span!` around the spawned regular turn.


##### `RegularTask::run`  (lines 36–88)

```
async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        ctx: Arc<TurnContext>,
        input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
    ) -> O
```

**Purpose**: Runs a standard turn by emitting `TurnStarted`, optionally consuming startup prewarm, and repeatedly invoking `run_turn` until the active turn has no pending input left.

**Data flow**: Consumes the task `Arc`, `SessionTaskContext`, `TurnContext`, initial `Vec<TurnInput>`, and a `CancellationToken`. It clones the session and turn extension data, sends a `TurnStartedEvent`, disables server reasoning inclusion, awaits startup prewarm resolution, converts that resolution into an optional prewarmed client session, then loops calling `run_turn` with the current input, optional prewarm on the first pass, and a child cancellation token. It returns the final `Option<String>` agent message from the last `run_turn`, or `None` if prewarm waiting was cancelled.

**Call relations**: The generic task runner in `Session::start_task` invokes this as the concrete workflow for ordinary turns. It delegates the actual model/tool turn execution to `crate::session::turn::run_turn` and uses the session input queue to decide whether to iterate again.

*Call graph*: calls 1 internal fn (run_turn); 5 external calls (clone, child_token, new, TurnStarted, trace_span!).


### `core/src/turn_metadata.rs`

`domain_logic` · `turn setup and outbound request construction; optional background Git enrichment during a turn`

This module owns the mutable state behind turn metadata headers. `TurnMetadataState` captures stable identifiers such as session id, thread id, turn id, current working directory, optional fork/parent thread lineage, subagent header/kind, and a sandbox tag derived from the permission profile and Windows sandbox settings. It also holds mutable shared state behind locks: asynchronously enriched workspace metadata, turn start time, filtered client-supplied metadata, a flag indicating whether user input was requested during the turn, and an optional spawned Git-enrichment task.

Metadata generation is split by audience. `responses_metadata_template` builds the common `CodexResponsesMetadata` base used for Responses requests and headers, merging reserved fields from state with filtered client metadata while preserving reserved-field precedence. `current_meta_value_for_mcp_request` starts from that template's JSON object and overlays MCP-specific fields: current model, optional reasoning effort, and `user_input_requested_during_turn` only when the atomic flag is set. `to_responses_metadata` then adds installation id, window id, and request kind for outbound Responses requests.

Workspace enrichment is intentionally asynchronous. `spawn_git_enrichment_task` exits early when no repo root exists or a task is already running; otherwise it clones state into a Tokio task that concurrently fetches HEAD commit hash, remote URLs, and dirty-state via `tokio::join!`. Empty Git metadata is discarded, but non-empty results are stored under the repo root in `enriched_workspaces`. `cancel_git_enrichment_task` aborts any in-flight task. The standalone `detached_memory_responses_metadata` and `memory_workspaces` helpers build a reduced metadata payload for memory requests, omitting turn identity while still including subagent and workspace Git context when available.

#### Function details

##### `WorkspaceGitMetadata::is_empty`  (lines 48–52)

```
fn is_empty(&self) -> bool
```

**Purpose**: Reports whether no Git-derived workspace fields were populated.

**Data flow**: Checks whether `associated_remote_urls`, `latest_git_commit_hash`, and `has_changes` are all `None`, and returns that boolean.

**Call relations**: Used to suppress empty workspace entries after Git enrichment and in detached memory metadata generation.


##### `TurnMetadataWorkspace::from`  (lines 56–62)

```
fn from(value: WorkspaceGitMetadata) -> Self
```

**Purpose**: Converts internal Git metadata into the public `TurnMetadataWorkspace` shape used in serialized responses metadata.

**Data flow**: Consumes a `WorkspaceGitMetadata` and moves its `associated_remote_urls`, `latest_git_commit_hash`, and `has_changes` fields into a new `TurnMetadataWorkspace`.

**Call relations**: Used when storing enriched workspace metadata and when building detached memory workspace maps.


##### `detached_memory_responses_metadata`  (lines 66–82)

```
async fn detached_memory_responses_metadata(
    installation_id: String,
    session_id: String,
    thread_id: String,
    window_id: String,
    session_source: &SessionSource,
    cwd: &AbsolutePa
```

**Purpose**: Builds a `CodexResponsesMetadata` payload for detached memory requests, intentionally omitting turn/session identity while preserving request kind, subagent header, sandbox, and workspace context.

**Data flow**: Accepts installation/session/thread/window ids, session source, cwd, and optional sandbox string. It computes `subagent_header` from the session source, asynchronously gathers workspace metadata via `memory_workspaces(cwd)`, and returns a `CodexResponsesMetadata` initialized with `request_kind = Memory` and the supplied identifiers.

**Call relations**: Used for memory-specific outbound requests rather than normal turn requests.

*Call graph*: calls 3 internal fn (new, subagent_header_value, memory_workspaces).


##### `TurnMetadataState::new`  (lines 105–143)

```
fn new(
        session_id: String,
        thread_id: String,
        forked_from_thread_id: Option<ThreadId>,
        parent_thread_id: Option<ThreadId>,
        session_source: &SessionSource,
```

**Purpose**: Constructs the per-turn metadata state from session lineage, cwd, and sandbox configuration, initializing mutable enrichment and client-metadata storage.

**Data flow**: Computes `repo_root` from `cwd`, derives a sandbox tag with `permission_profile_sandbox_tag`, derives `subagent_header` and `subagent_kind` from `session_source`, stores all provided identifiers, and initializes `enriched_workspaces`, `turn_started_at_unix_ms`, `responsesapi_client_metadata`, `user_input_requested_during_turn`, and `enrichment_task` with empty synchronized containers.

**Call relations**: Created during turn-context setup and exercised heavily by metadata tests.

*Call graph*: calls 3 internal fn (subagent_header_value, subagent_metadata_kind, permission_profile_sandbox_tag); called by 14 (spawn_review_thread, make_turn_context, turn_metadata_state_ignores_client_reserved_metadata_before_start, turn_metadata_state_includes_forked_thread_spawn_subagent_lineage, turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork, turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta, turn_metadata_state_includes_root_fork_lineage, turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork, turn_metadata_state_includes_turn_started_at_unix_ms_after_start, turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta (+4 more)); 6 external calls (new, new, new, new, new, get_git_repo_root).


##### `TurnMetadataState::current_meta_value_for_mcp_request`  (lines 145–181)

```
fn current_meta_value_for_mcp_request(
        &self,
        context: McpTurnMetadataContext<'_>,
    ) -> Option<serde_json::Value>
```

**Purpose**: Produces the current turn metadata JSON object for an MCP request, overlaying model-specific fields and the user-input-requested flag onto the common metadata template.

**Data flow**: Calls `responses_metadata_template().turn_metadata_value()?`, requires it to be a JSON object, inserts `model`, inserts or removes `reasoning_effort` depending on the provided `McpTurnMetadataContext`, inserts or removes `user_input_requested_during_turn` based on the atomic flag, and returns the resulting `serde_json::Value::Object`.

**Call relations**: Used when constructing MCP request metadata; unlike Responses headers, it intentionally includes model and reasoning-effort fields.

*Call graph*: calls 1 internal fn (responses_metadata_template); 3 external calls (Bool, Object, String).


##### `TurnMetadataState::to_responses_metadata`  (lines 183–195)

```
fn to_responses_metadata(
        &self,
        installation_id: String,
        window_id: String,
        request_kind: CodexResponsesRequestKind,
    ) -> CodexResponsesMetadata
```

**Purpose**: Builds a full `CodexResponsesMetadata` for an outbound Responses request by combining the common template with request-scoped identifiers.

**Data flow**: Takes installation id, window id, and `CodexResponsesRequestKind`, then returns a `CodexResponsesMetadata` whose `installation_id`, `window_id`, and `request_kind` are set while all other fields come from `responses_metadata_template()`.

**Call relations**: Used by tests and production request-building code for turn and compaction requests.

*Call graph*: calls 1 internal fn (responses_metadata_template); called by 1 (test_responses_metadata_json).


##### `TurnMetadataState::mark_user_input_requested_during_turn`  (lines 197–200)

```
fn mark_user_input_requested_during_turn(&self)
```

**Purpose**: Marks that the turn requested user input so future MCP metadata can include that fact.

**Data flow**: Stores `true` into the `user_input_requested_during_turn` atomic using relaxed ordering.

**Call relations**: Affects only `current_meta_value_for_mcp_request`; tests verify it does not alter normal header metadata.


##### `TurnMetadataState::set_responsesapi_client_metadata`  (lines 202–211)

```
fn set_responsesapi_client_metadata(
        &self,
        responsesapi_client_metadata: HashMap<String, String>,
    )
```

**Purpose**: Stores filtered client-supplied metadata for later merging into serialized turn metadata, excluding reserved keys.

**Data flow**: Accepts a `HashMap<String, String>`, passes it through `filter_extra_metadata`, acquires the write lock on `responsesapi_client_metadata`, and replaces the stored map with the filtered result.

**Call relations**: Used when client metadata arrives before request serialization; tests verify reserved fields cannot override state-owned fields.

*Call graph*: calls 1 internal fn (filter_extra_metadata).


##### `TurnMetadataState::workspace_kind`  (lines 213–219)

```
fn workspace_kind(&self) -> Option<String>
```

**Purpose**: Returns the client-supplied `workspace_kind` metadata value if present after filtering.

**Data flow**: Reads the `responsesapi_client_metadata` lock, looks up `WORKSPACE_KIND_KEY`, clones the string if found, and returns it as `Option<String>`.

**Call relations**: Provides a typed accessor for one specific extra metadata field.


##### `TurnMetadataState::responses_metadata_template`  (lines 221–243)

```
fn responses_metadata_template(&self) -> CodexResponsesMetadata
```

**Purpose**: Builds the common `CodexResponsesMetadata` base shared by headers and outbound Responses requests, merging state-owned reserved fields with current workspace and client metadata.

**Data flow**: Reads turn id, lineage ids, subagent fields, sandbox, current workspaces, current turn-start timestamp, and a clone of filtered client metadata, then constructs `CodexResponsesMetadata::new("", session_id, thread_id, "")` and overlays those fields onto it.

**Call relations**: Called by both `current_meta_value_for_mcp_request` and `to_responses_metadata`, and directly by tests that inspect raw header JSON.

*Call graph*: calls 3 internal fn (new, current_turn_started_at_unix_ms, current_workspaces); called by 3 (current_meta_value_for_mcp_request, to_responses_metadata, test_turn_metadata_header); 1 external calls (new).


##### `TurnMetadataState::current_workspaces`  (lines 245–251)

```
fn current_workspaces(&self) -> BTreeMap<String, TurnMetadataWorkspace>
```

**Purpose**: Returns the currently enriched workspace metadata map, defaulting to empty when enrichment has not populated anything yet.

**Data flow**: Reads the `enriched_workspaces` lock, clones the optional `BTreeMap`, unwraps it to an empty map if `None`, and returns the map.

**Call relations**: Used only by `responses_metadata_template`.

*Call graph*: called by 1 (responses_metadata_template).


##### `TurnMetadataState::current_turn_started_at_unix_ms`  (lines 253–258)

```
fn current_turn_started_at_unix_ms(&self) -> Option<i64>
```

**Purpose**: Returns the stored turn-start timestamp in Unix milliseconds, if one has been recorded.

**Data flow**: Reads the `turn_started_at_unix_ms` lock and returns the copied `Option<i64>` value.

**Call relations**: Used by `responses_metadata_template` when serializing headers and request metadata.

*Call graph*: called by 1 (responses_metadata_template).


##### `TurnMetadataState::set_turn_started_at_unix_ms`  (lines 260–265)

```
fn set_turn_started_at_unix_ms(&self, turn_started_at_unix_ms: i64)
```

**Purpose**: Stores the turn-start timestamp for later inclusion in serialized metadata.

**Data flow**: Acquires the write lock on `turn_started_at_unix_ms` and replaces its value with `Some(turn_started_at_unix_ms)`.

**Call relations**: Called when a turn begins; tests verify the field appears afterward.


##### `TurnMetadataState::spawn_git_enrichment_task`  (lines 267–298)

```
fn spawn_git_enrichment_task(&self)
```

**Purpose**: Starts at most one background task that fetches Git metadata for the current workspace and stores it into `enriched_workspaces` if non-empty.

**Data flow**: Returns immediately if `repo_root` is `None`. Otherwise it locks `enrichment_task`, returns if a task already exists, clones `self`, and stores a spawned Tokio task. That task awaits `fetch_workspace_git_metadata()`, rechecks `repo_root`, skips empty metadata, builds a one-entry `BTreeMap` keyed by repo root, and writes it into `enriched_workspaces`.

**Call relations**: Used during turn execution to enrich metadata asynchronously without blocking request startup.

*Call graph*: 2 external calls (new, spawn).


##### `TurnMetadataState::cancel_git_enrichment_task`  (lines 300–308)

```
fn cancel_git_enrichment_task(&self)
```

**Purpose**: Aborts any in-flight Git enrichment task and clears the stored task handle.

**Data flow**: Locks `enrichment_task`, takes the optional `JoinHandle`, and if present calls `abort()` on it.

**Call relations**: Used during teardown or cancellation to stop background enrichment work.


##### `TurnMetadataState::fetch_workspace_git_metadata`  (lines 310–323)

```
async fn fetch_workspace_git_metadata(&self) -> WorkspaceGitMetadata
```

**Purpose**: Fetches Git metadata for the current cwd concurrently: HEAD commit hash, remote URLs, and dirty-state.

**Data flow**: Runs `get_head_commit_hash(&self.cwd)`, `get_git_remote_urls_assume_git_repo(&self.cwd)`, and `get_has_changes(&self.cwd)` in `tokio::join!`, converts the head hash into an owned string if present, and returns a `WorkspaceGitMetadata` struct containing the three results.

**Call relations**: Called only inside the spawned enrichment task.

*Call graph*: 1 external calls (join!).


##### `memory_workspaces`  (lines 326–345)

```
async fn memory_workspaces(cwd: &AbsolutePathBuf) -> BTreeMap<String, TurnMetadataWorkspace>
```

**Purpose**: Builds the workspace metadata map for detached memory requests by probing Git state synchronously with respect to the request flow.

**Data flow**: Computes `repo_root` from `cwd`, concurrently fetches head hash, remote URLs, and dirty-state, assembles a `WorkspaceGitMetadata`, and if both a repo root exists and the metadata is non-empty inserts one `TurnMetadataWorkspace` entry into a `BTreeMap` keyed by repo root. It returns the map, possibly empty.

**Call relations**: Used by `detached_memory_responses_metadata` to include workspace context without requiring a `TurnMetadataState`.

*Call graph*: called by 1 (detached_memory_responses_metadata); 3 external calls (new, get_git_repo_root, join!).


### `core/src/session/turn.rs`

`orchestration` · `request handling / main turn loop`

This file is the session turn engine. Its top-level `run_turn` function orchestrates a loop that repeatedly builds prompt input from session history, streams a model response, executes requested tools, records outputs, and decides whether another sampling pass is needed. Before the loop it may compact history, records context updates, injects skill/plugin/extension guidance, runs session-start and input hooks, merges connector selections, and emits analytics about the resolved turn configuration.

A large portion of the file is dedicated to token-budget and compaction policy. `auto_compact_token_status`, `run_pre_sampling_compact`, `maybe_run_previous_model_inline_compact`, and `run_auto_compact` compute whether the active context or scoped body exceeds configured limits, including special handling for model downshifts and compaction-compatibility hash changes. The turn loop also records token-budget threshold crossings and can start a new context window or compact mid-turn before continuing.

The streaming path is split between `run_sampling_request` and `try_run_sampling_request`. These build a `Prompt`, construct a `ToolRouter`, stream `ResponseEvent`s from the model client, maintain active item state, emit protocol deltas, queue tool futures, drain them in order, and persist finalized response items. Plan mode adds extra transient state: assistant text is parsed into normal text versus proposed-plan segments, agent-message starts are deferred until non-plan text appears, and a synthetic `TurnItem::Plan` is streamed and completed from the finalized assistant message. The file also includes helper logic for extracting explicit app IDs from skill injections, mirroring text to realtime consumers, and recovering the last assistant message from a completed response list.

#### Function details

##### `run_turn`  (lines 137–411)

```
async fn run_turn(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    turn_extension_data: Arc<codex_extension_api::ExtensionData>,
    input: Vec<TurnInput>,
    prewarmed_client_session
```

**Purpose**: Runs one complete turn from initial inputs through zero or more model sampling passes until the turn finishes, aborts, or errors. It coordinates compaction, hooks, skill/plugin injection, sampling, token accounting, stop hooks, and error reporting.

**Data flow**: Inputs are the shared `Session`, `TurnContext`, extension data, initial `Vec<TurnInput>`, an optional prewarmed `ModelClientSession`, and a cancellation token. It reads and mutates session state extensively: may compact history, records context updates and injected items, drains pending input, clones history into prompt input, computes token usage before and after sampling, updates previous-turn settings and connector selection, may start a new context window, may compact mid-turn, and emits warnings/errors/events. It returns `Option<String>` containing the last assistant message when one was finalized, otherwise `None`.

**Call relations**: This is called by the higher-level session `run` path for each user turn. It delegates setup to `run_pre_sampling_compact`, `build_skills_and_plugins`, `run_hooks_and_record_inputs`, and analytics helpers; delegates each model pass to `run_sampling_request`; invokes `maybe_record_token_budget_remaining_context` after sampling; and invokes stop/after-agent hooks only when the model no longer needs follow-up.

*Call graph*: calls 15 internal fn (run_legacy_after_agent_hook, run_pending_session_start_hooks, run_turn_stop_hooks, maybe_record_token_budget_remaining_context, auto_compact_token_status, build_skills_and_plugins, run_auto_compact, run_hooks_and_record_inputs, run_pre_sampling_compact, run_sampling_request (+5 more)); called by 1 (run); 12 external calls (clone, new, child_token, new, error!, info!, Error, Warning, from_ref, new (+2 more)).


##### `turn_diff_display_roots`  (lines 414–430)

```
async fn turn_diff_display_roots(turn_context: &TurnContext) -> Vec<(String, PathBuf)>
```

**Purpose**: Builds the per-environment filesystem roots used to render turn diffs in a user-friendly way. For each selected turn environment it prefers the git repository root and falls back to the environment cwd.

**Data flow**: It takes `&TurnContext`, iterates `turn_context.environments.turn_environments`, converts each environment cwd to an absolute host path when possible, queries `get_git_repo_root_with_fs` against that environment's filesystem, and collects `(environment_id, PathBuf)` pairs. Environments whose cwd cannot be converted are skipped. It returns the assembled vector.

**Call relations**: Called once near the start of `run_turn` to initialize `TurnDiffTracker` with display roots. It delegates repository-root discovery to `get_git_repo_root_with_fs` so later diff emission can present paths relative to meaningful roots.

*Call graph*: called by 1 (run_turn); 2 external calls (new, get_git_repo_root_with_fs).


##### `run_hooks_and_record_inputs`  (lines 433–459)

```
async fn run_hooks_and_record_inputs(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    input: &[TurnInput],
) -> bool
```

**Purpose**: Processes a batch of pending turn inputs through input-inspection hooks and records either the accepted input or any additional context produced by blocked inputs. Its boolean result tells the caller whether the turn should stop because all user input was blocked.

**Data flow**: Inputs are the session, turn context, and a slice of `TurnInput`. For each item it calls `inspect_pending_input`; if the hook says stop, it marks `blocked_input` and records only `additional_contexts`; otherwise it detects whether a non-empty `TurnInput::UserInput` was accepted and records the input plus additional contexts via `record_pending_input`. It returns `true` only when some input was blocked and no accepted user input remained.

**Call relations**: Used by `run_turn` both for the initial submitted inputs and for later pending-input drains. It sits between hook inspection and history recording, delegating blocked-context persistence to `record_additional_contexts` and accepted-input persistence to `record_pending_input`.

*Call graph*: calls 3 internal fn (inspect_pending_input, record_additional_contexts, record_pending_input); called by 1 (run_turn); 1 external calls (matches!).


##### `build_skills_and_plugins`  (lines 462–622)

```
async fn build_skills_and_plugins(
    sess: &Arc<Session>,
    turn_context: &TurnContext,
    input: &[TurnInput],
    cancellation_token: &CancellationToken,
) -> Option<(Vec<ResponseItem>, HashSet
```

**Purpose**: Computes turn-scoped instruction injections and explicit connector enablement from user input, loaded skills, plugins, MCP tools, and extension contributors. It also emits analytics and warnings associated with those inferred injections.

**Data flow**: It consumes the session, turn context, raw turn inputs, and a cancellation token. It extracts only user-authored `UserInput` content, loads configured plugins, optionally loads MCP tools, derives accessible connectors, computes connector and skill mention counts, asks extension contributors for extra turn-input fragments, detects explicit skill/plugin/app mentions, may prompt for MCP dependency installation, builds skill injections and plugin injections, filters out host-injected skills already present, and returns `(Vec<ResponseItem>, HashSet<String>)` containing injection items and explicitly enabled connector IDs. Along the way it sends warning events and analytics for app/plugin mentions.

**Call relations**: Called once by `run_turn` before sampling begins. It delegates extension-specific fragments to `build_extension_turn_input_items`, skill prompt generation to `build_skill_injections`, plugin prompt generation to `build_plugin_injections`, dependency prompting to `maybe_prompt_and_install_mcp_dependencies`, and app-ID extraction from generated skill messages to `collect_explicit_app_ids_from_skill_items`.

*Call graph*: calls 10 internal fn (merge_plugin_connectors_with_accessible, accessible_connectors_from_mcp_tools, with_app_enabled_state, maybe_prompt_and_install_mcp_dependencies, build_connector_slug_counts, collect_explicit_app_ids, collect_explicit_plugin_mentions, build_extension_turn_input_items, collect_explicit_app_ids_from_skill_items, apps_enabled); called by 1 (run_turn); 10 external calls (new, new, build_track_events_context, iter, build_skill_injections, collect_explicit_skill_mentions, is_guardian_reviewer_source, build_skill_name_counts, build_plugin_injections, Warning).


##### `build_extension_turn_input_items`  (lines 624–677)

```
async fn build_extension_turn_input_items(
    sess: &Arc<Session>,
    turn_context: &TurnContext,
    user_input: &[UserInput],
    cancellation_token: &CancellationToken,
) -> Option<Vec<ResponseIt
```

**Purpose**: Invokes registered extension turn-input contributors and converts their returned contextual fragments into response items to inject into the turn. It packages user input and selected environments into the extension API shape expected by contributors.

**Data flow**: Inputs are the session, turn context, flattened user input slice, and cancellation token. It reads the extension registry's turn-input contributors, builds a `TurnInputContext` containing turn ID, copied user input, and a list of `TurnInputEnvironment` values derived from selected environments with absolute cwd paths, then calls each contributor's `contribute` method. Returned fragments are converted with `ContextualUserFragment::into_boxed_response_item` and appended into a single vector. If any contributor call is cancelled or fails, it returns `None`; otherwise `Some(Vec<ResponseItem>)`.

**Call relations**: This helper is used only from `build_skills_and_plugins` as one source of injected context. It delegates the actual content generation to extension contributors and acts as the adapter between internal turn state and the extension API.

*Call graph*: called by 1 (build_skills_and_plugins); 2 external calls (new, to_vec).


##### `track_turn_resolved_config_analytics`  (lines 679–731)

```
async fn track_turn_resolved_config_analytics(
    sess: &Session,
    turn_context: &TurnContext,
    input: &[TurnInput],
)
```

**Purpose**: Captures the effective configuration facts for the current turn and sends them to analytics. The payload includes model, permissions, sandboxing, workspace metadata, and whether this is the first turn.

**Data flow**: It takes `&Session`, `&TurnContext`, and the original turn inputs. It locks session state to snapshot thread configuration and consume the `next_turn_is_first` flag, counts image inputs from `TurnInput::UserInput` content, reads many fields from `turn_context` such as model slug, provider, permission profile, reasoning settings, service tier, approval policy, sandbox network access, collaboration mode, personality, and workspace kind, then submits a `TurnResolvedConfigFact` to the analytics client. It returns nothing.

**Call relations**: Called by `run_turn` after injections are recorded and before sampling starts. It does not drive control flow; it is a side-effecting analytics sink that reads session and turn state but delegates no further turn logic.

*Call graph*: calls 2 internal fn (network_sandbox_policy, permission_profile); called by 1 (run_turn); 1 external calls (iter).


##### `auto_compact_token_status`  (lines 746–793)

```
async fn auto_compact_token_status(
    sess: &Session,
    turn_context: &TurnContext,
) -> AutoCompactTokenStatus
```

**Purpose**: Computes whether the current conversation has exceeded the configured auto-compaction budget, taking into account the configured scope and the full model context window. It centralizes the token-limit math used before and after sampling.

**Data flow**: Inputs are `&Session` and `&TurnContext`. It reads total active-context tokens from the session, optionally reads the auto-compact window snapshot for `BodyAfterPrefix` scope, derives `auto_compact_scope_tokens`, `auto_compact_scope_limit`, optional full context window limit, and whether either scoped or full-window limits have been reached. It returns an `AutoCompactTokenStatus` struct containing both raw counts and booleans.

**Call relations**: Used by `run_pre_sampling_compact` before the first sample and by `run_turn` after each sample to decide whether to compact or continue. It depends on `TurnContext::model_context_window` and session token counters but does not itself mutate state.

*Call graph*: calls 1 internal fn (model_context_window); called by 2 (run_pre_sampling_compact, run_turn); 2 external calls (auto_compact_window_snapshot, get_total_token_usage).


##### `run_pre_sampling_compact`  (lines 796–816)

```
async fn run_pre_sampling_compact(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
) -> CodexResult<()>
```

**Purpose**: Performs any compaction that must happen before the first sampling request of a turn. It first considers compatibility/model-switch compaction against the previous model, then checks current token limits for ordinary pre-turn compaction.

**Data flow**: It receives the session, turn context, and mutable model client session. It calls `maybe_run_previous_model_inline_compact`, computes current `AutoCompactTokenStatus`, and if the token limit is already reached invokes `run_auto_compact` with `InitialContextInjection::DoNotInject`, `CompactionReason::ContextLimit`, and `CompactionPhase::PreTurn`. It returns `CodexResult<()>` indicating whether attempted compaction succeeded.

**Call relations**: Called at the very start of `run_turn`. It delegates special-case previous-model handling to `maybe_run_previous_model_inline_compact` and actual compaction execution to `run_auto_compact`.

*Call graph*: calls 3 internal fn (auto_compact_token_status, maybe_run_previous_model_inline_compact, run_auto_compact); called by 1 (run_turn).


##### `comp_hash_changed`  (lines 820–824)

```
fn comp_hash_changed(previous: Option<&str>, current: Option<&str>) -> bool
```

**Purpose**: Determines whether two optional compaction-compatibility hashes are both present and unequal. Missing hashes are treated as insufficient evidence to force compaction.

**Data flow**: It takes `Option<&str>` for previous and current hashes, zips them only when both are `Some`, compares the strings, and returns a boolean. It reads no external state and writes none.

**Call relations**: Used only by `maybe_run_previous_model_inline_compact` as one of the pre-turn compaction triggers when switching turn contexts.

*Call graph*: called by 1 (maybe_run_previous_model_inline_compact).


##### `maybe_run_previous_model_inline_compact`  (lines 830–897)

```
async fn maybe_run_previous_model_inline_compact(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
) -> CodexResult<()>
```

**Purpose**: Decides whether to compact history using the previous turn's model before sampling with the current model. It handles two cases: compaction-hash incompatibility and switching to a smaller context-window model while already near limits.

**Data flow**: Inputs are the session, current turn context, and mutable client session. It reads previous turn settings from the session; if absent it returns success immediately. Otherwise it computes whether the compaction hash changed, constructs a previous-model `TurnContext` via `with_model`, optionally runs compaction for hash changes, otherwise compares old/new context windows and active token usage under the configured auto-compact scope to decide whether a model-downshift compaction is needed. It returns `CodexResult<()>`.

**Call relations**: Called only from `run_pre_sampling_compact`. It delegates hash comparison to `comp_hash_changed`, previous-model context construction to `TurnContext::with_model`, and actual compaction to `run_auto_compact` when one of its trigger conditions is met.

*Call graph*: calls 2 internal fn (comp_hash_changed, run_auto_compact); called by 1 (run_pre_sampling_compact); 1 external calls (new).


##### `run_auto_compact`  (lines 904–960)

```
async fn run_auto_compact(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    initial_context_injection: InitialContextInjection,
    reason
```

**Purpose**: Dispatches auto-compaction to the appropriate local or remote implementation and records a telemetry metric describing which path was used. It hides the provider-specific branching from callers.

**Data flow**: Inputs are the session, turn context, mutable client session, initial-context injection mode, compaction reason, and phase. It reads provider capabilities and feature flags to choose between local compaction, remote compaction v1, or remote compaction v2; emits a compact metric with labels `local`, `remote`, or `remote_v2`; then awaits the selected inline compaction task. It returns `CodexResult<()>`.

**Call relations**: Invoked from `run_pre_sampling_compact`, `maybe_run_previous_model_inline_compact`, and mid-turn logic in `run_turn`. It delegates to `should_use_remote_compact_task`, `run_inline_remote_auto_compact_task`, `run_inline_remote_auto_compact_task_v2`, or `run_inline_auto_compact_task` depending on provider and feature state.

*Call graph*: calls 6 internal fn (turn_state, run_inline_auto_compact_task, should_use_remote_compact_task, run_inline_remote_auto_compact_task, run_inline_remote_auto_compact_task, emit_compact_metric); called by 3 (maybe_run_previous_model_inline_compact, run_pre_sampling_compact, run_turn); 1 external calls (clone).


##### `collect_explicit_app_ids_from_skill_items`  (lines 962–1011)

```
fn collect_explicit_app_ids_from_skill_items(
    skill_items: &[ResponseItem],
    connectors: &[connectors::AppInfo],
    skill_name_counts_lower: &HashMap<String, usize>,
) -> HashSet<String>
```

**Purpose**: Scans generated skill instruction messages for tool/app mentions and converts those mentions into connector IDs that should count as explicitly enabled for the turn. It supports both path-based mentions and unique slug matches.

**Data flow**: It takes generated `skill_items`, available connector metadata, and lowercase skill-name counts. It extracts input-text strings from `ResponseItem::Message` items, parses tool mentions from those messages, collects app IDs from explicit app paths, computes connector mention slugs and their multiplicities, and adds connector IDs for unique slug mentions that are not ambiguous with skill names. It returns a `HashSet<String>` of connector IDs.

**Call relations**: Used inside `build_skills_and_plugins` after skill injections are generated. It bridges generated skill text back into connector-selection state by delegating mention parsing to `collect_tool_mentions_from_messages` and slug counting to `build_connector_slug_counts`.

*Call graph*: calls 3 internal fn (connector_mention_slug, build_connector_slug_counts, collect_tool_mentions_from_messages); called by 1 (build_skills_and_plugins); 4 external calls (new, is_empty, is_empty, iter).


##### `build_prompt`  (lines 1014–1031)

```
fn build_prompt(
    input: Vec<ResponseItem>,
    router: &ToolRouter,
    turn_context: &TurnContext,
    base_instructions: BaseInstructions,
) -> Prompt
```

**Purpose**: Assembles the model request `Prompt` from response-history input, visible tool specs, and turn-level instruction settings. It also decides whether output-schema enforcement should be strict.

**Data flow**: Inputs are prompt `input`, a `ToolRouter`, the `TurnContext`, and `BaseInstructions`. It reads model-visible tool specs from the router, parallel-tool-call support, personality, final output schema, and whether the session source is a guardian reviewer. It returns a `Prompt` struct containing those fields plus the provided input and base instructions.

**Call relations**: Called by `run_sampling_request`, startup prewarm code, and prompt-building helpers elsewhere. It is a pure assembler that packages already-computed turn state for the model client.

*Call graph*: calls 1 internal fn (model_visible_specs); called by 3 (build_prompt_input_from_session, run_sampling_request, schedule_startup_prewarm_inner); 1 external calls (is_guardian_reviewer_source).


##### `run_sampling_request`  (lines 1043–1137)

```
async fn run_sampling_request(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    turn_store: Arc<codex_extension_api::ExtensionData>,
    turn_diff_tracker: SharedTurnDiffTracker,
    cl
```

**Purpose**: Runs one sampling request with retry handling around the lower-level streaming implementation. It rebuilds prompt input from history on retries while preserving the original input returned to callers.

**Data flow**: Inputs are the session, turn context, turn extension store, shared diff tracker, mutable client session, responses metadata, initial prompt input, and cancellation token. It builds tools, fetches base instructions, creates a `ToolCallRuntime`, starts a code-mode worker, then loops: build a `Prompt`, call `try_run_sampling_request`, and on retryable errors invoke retry handling and retry with fresh history. It returns either `(SamplingRequestResult, Vec<ResponseItem>)` where the vector is the original prompt input used for after-agent hooks, or a `CodexErr`.

**Call relations**: Called from the main `run_turn` loop for each model pass. It delegates prompt assembly to `build_prompt`, tool construction to `built_tools`, actual streaming to `try_run_sampling_request`, and retry policy to `handle_retryable_response_stream_error`.

*Call graph*: calls 5 internal fn (handle_retryable_response_stream_error, build_prompt, built_tools, try_run_sampling_request, new); called by 1 (run_turn); 3 external calls (clone, child_token, UsageLimitReached).


##### `built_tools`  (lines 1147–1246)

```
async fn built_tools(
    sess: &Session,
    turn_context: &TurnContext,
    cancellation_token: &CancellationToken,
) -> CodexResult<Arc<ToolRouter>>
```

**Purpose**: Constructs the `ToolRouter` visible to the model for this turn, combining MCP tools, plugin-backed connectors, discoverable suggestions, extension executors, and dynamic tools. It also respects auth state and feature gates around app/tool exposure.

**Data flow**: Inputs are `&Session`, `&TurnContext`, and a cancellation token. It loads MCP tool inventory, plugin configuration, auth state, accessible connectors, discoverable tool suggestions, and MCP exposure policy; merges plugin and accessible connectors when apps are enabled; filters discoverable tools for the requesting client; and finally builds a `ToolRouter` from `ToolRouterParams`. It returns `CodexResult<Arc<ToolRouter>>`.

**Call relations**: Used by `run_sampling_request`, startup prewarm, prompt-building helpers, and remote compaction paths. It delegates connector merging and discoverable-tool lookup to connector/plugin helpers, then delegates final router construction to `ToolRouter::from_turn_context`.

*Call graph*: calls 9 internal fn (merge_plugin_connectors_with_accessible, list_tool_suggest_discoverable_tools_with_auth, with_app_enabled_state, build_mcp_tool_exposure, apps_enabled, from_turn_context, extension_tool_executors, search_tool_enabled, tool_suggest_enabled); called by 5 (run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl, build_prompt_input_from_session, run_sampling_request, schedule_startup_prewarm_inner); 3 external calls (new, trace_span!, warn!).


##### `PlanModeStreamState::new`  (lines 1279–1286)

```
fn new(turn_id: &str) -> Self
```

**Purpose**: Initializes the transient bookkeeping needed while streaming a plan-mode response. It starts with empty deferred-agent-message maps and a fresh synthetic plan item state tied to the turn ID.

**Data flow**: It takes a `turn_id`, creates empty `HashMap`/`HashSet` collections for pending and started agent messages and leading whitespace, constructs `ProposedPlanItemState::new(turn_id)`, and returns the populated `PlanModeStreamState`.

**Call relations**: Constructed by `try_run_sampling_request` when the turn's collaboration mode is `ModeKind::Plan`, and also directly in tests. It provides the mutable state consumed by plan-mode streaming helpers.

*Call graph*: calls 1 internal fn (new); called by 1 (plan_mode_uses_contributed_turn_item_for_last_agent_message); 2 external calls (new, new).


##### `AssistantMessageStreamParsers::new`  (lines 1298–1303)

```
fn new(plan_mode: bool) -> Self
```

**Purpose**: Creates the per-item assistant text parser registry used to split streamed assistant text into visible text, citations, and plan segments. The parser behavior is parameterized by whether the turn is in plan mode.

**Data flow**: It takes a `plan_mode` boolean, stores it, initializes an empty `HashMap<String, AssistantTextStreamParser>`, and returns the parser manager.

**Call relations**: Created by `try_run_sampling_request` for every sampling request and by parser-focused tests. Its methods are then used as output items are added, deltas arrive, and items complete.

*Call graph*: called by 4 (assistant_message_stream_parsers_can_be_seeded_from_output_item_added_text, assistant_message_stream_parsers_seed_buffered_prefix_stays_out_of_finish_tail, assistant_message_stream_parsers_seed_plan_parser_across_added_and_delta_boundaries, try_run_sampling_request); 1 external calls (new).


##### `AssistantMessageStreamParsers::parser_mut`  (lines 1305–1310)

```
fn parser_mut(&mut self, item_id: &str) -> &mut AssistantTextStreamParser
```

**Purpose**: Returns the parser instance for a specific response item, creating one on first use with the manager's plan-mode setting. This ensures all deltas for an item are parsed incrementally by the same parser.

**Data flow**: It takes `&mut self` and an `item_id`, looks up `parsers_by_item`, inserts a new `AssistantTextStreamParser::new(plan_mode)` if absent, and returns a mutable reference to the parser.

**Call relations**: Internal helper used by `seed_item_text` and `parse_delta` so both initial seeded text and later deltas share the same parser state.

*Call graph*: called by 2 (parse_delta, seed_item_text).


##### `AssistantMessageStreamParsers::seed_item_text`  (lines 1312–1317)

```
fn seed_item_text(&mut self, item_id: &str, text: &str) -> ParsedAssistantTextDelta
```

**Purpose**: Seeds a parser with assistant text already present in an `OutputItemAdded` event before later deltas arrive. This lets streaming state start from the item's initial text payload.

**Data flow**: It takes an item ID and initial text. If the text is empty it returns a default empty parsed chunk; otherwise it obtains the parser via `parser_mut`, pushes the text into it, and returns the resulting `ParsedAssistantTextDelta`.

**Call relations**: Used by `try_run_sampling_request` when a newly added assistant message item already contains output text. It prepares parser state before subsequent `OutputTextDelta` events are processed.

*Call graph*: calls 1 internal fn (parser_mut); 1 external calls (default).


##### `AssistantMessageStreamParsers::parse_delta`  (lines 1319–1321)

```
fn parse_delta(&mut self, item_id: &str, delta: &str) -> ParsedAssistantTextDelta
```

**Purpose**: Feeds a streamed text delta into the parser for a specific assistant item and returns any parsed visible text or plan segments now ready to emit.

**Data flow**: It takes an item ID and delta string, retrieves or creates the parser with `parser_mut`, pushes the delta into it, and returns the parsed chunk.

**Call relations**: Called by `try_run_sampling_request` on each `ResponseEvent::OutputTextDelta` for active assistant messages.

*Call graph*: calls 1 internal fn (parser_mut).


##### `AssistantMessageStreamParsers::finish_item`  (lines 1323–1328)

```
fn finish_item(&mut self, item_id: &str) -> ParsedAssistantTextDelta
```

**Purpose**: Finalizes parsing for one assistant item and returns any buffered text or segments that were waiting for end-of-item context. Missing parsers produce an empty parsed chunk.

**Data flow**: It takes an item ID, removes the parser from `parsers_by_item`, calls `finish()` if present, and otherwise returns `ParsedAssistantTextDelta::default()`.

**Call relations**: Used by `flush_assistant_text_segments_for_item` when an assistant message item completes.

*Call graph*: called by 1 (flush_assistant_text_segments_for_item); 1 external calls (default).


##### `AssistantMessageStreamParsers::drain_finished`  (lines 1330–1336)

```
fn drain_finished(&mut self) -> Vec<(String, ParsedAssistantTextDelta)>
```

**Purpose**: Finalizes and drains all remaining per-item parsers, typically at response completion or cleanup. It ensures no buffered assistant text is lost.

**Data flow**: It takes ownership of the internal parser map with `std::mem::take`, calls `finish()` on each parser, and returns a vector of `(item_id, ParsedAssistantTextDelta)` pairs.

**Call relations**: Used by `flush_assistant_text_segments_all` during response completion and final cleanup in `try_run_sampling_request`.

*Call graph*: called by 1 (flush_assistant_text_segments_all); 1 external calls (take).


##### `ProposedPlanItemState::new`  (lines 1340–1346)

```
fn new(turn_id: &str) -> Self
```

**Purpose**: Creates the synthetic plan item identity and lifecycle flags for a turn's proposed plan stream. The item ID is derived deterministically from the turn ID.

**Data flow**: It formats `"{turn_id}-plan"`, sets `started` and `completed` to `false`, and returns the new state object.

**Call relations**: Constructed by `PlanModeStreamState::new` and then mutated by plan-stream helpers as plan output appears.

*Call graph*: called by 1 (new); 1 external calls (format!).


##### `ProposedPlanItemState::start`  (lines 1348–1358)

```
async fn start(&mut self, sess: &Session, turn_context: &TurnContext)
```

**Purpose**: Emits the start event for the synthetic plan item exactly once. It refuses to start if the plan item has already started or completed.

**Data flow**: It takes mutable state plus session and turn context references. If not already started/completed, it flips `started` to `true`, constructs `TurnItem::Plan(PlanItem { id, text: "" })`, and emits `emit_turn_item_started`. It returns no value.

**Call relations**: Called from `handle_plan_segments` and `maybe_complete_plan_item_from_message` whenever plan output first becomes visible or completion needs to synthesize a missing start.

*Call graph*: 3 external calls (new, Plan, emit_turn_item_started).


##### `ProposedPlanItemState::push_delta`  (lines 1360–1375)

```
async fn push_delta(&mut self, sess: &Session, turn_context: &TurnContext, delta: &str)
```

**Purpose**: Streams a chunk of proposed-plan text to clients as a `PlanDelta` event while the synthetic plan item is active. Empty deltas and already-completed plans are ignored.

**Data flow**: It takes mutable state, session, turn context, and a delta string. If the plan is active and the delta is non-empty, it builds a `PlanDeltaEvent` with thread ID, turn ID, synthetic item ID, and delta, then sends it via `sess.send_event`. It returns no value.

**Call relations**: Called by `handle_plan_segments` for each parsed `ProposedPlanDelta` segment.

*Call graph*: 2 external calls (send_event, PlanDelta).


##### `ProposedPlanItemState::complete_with_text`  (lines 1377–1392)

```
async fn complete_with_text(
        &mut self,
        sess: &Session,
        turn_context: &TurnContext,
        text: String,
    )
```

**Purpose**: Emits the final completed synthetic plan item with its full text, but only if the plan item was started and not already completed. This closes the plan lifecycle for clients.

**Data flow**: It takes mutable state, session, turn context, and the finalized plan text. If eligible, it marks `completed = true`, constructs `TurnItem::Plan(PlanItem { id, text })`, and emits `emit_turn_item_completed`. It returns no value.

**Call relations**: Called by `maybe_complete_plan_item_from_message` after extracting the final plan text from the completed assistant message.

*Call graph*: 2 external calls (Plan, emit_turn_item_completed).


##### `maybe_emit_pending_agent_message_start`  (lines 1398–1413)

```
async fn maybe_emit_pending_agent_message_start(
    sess: &Session,
    turn_context: &TurnContext,
    state: &mut PlanModeStreamState,
    item_id: &str,
)
```

**Purpose**: In plan mode, emits a deferred agent-message start event once the parser has confirmed that non-plan text should actually be shown. This prevents plan-only outputs from appearing as empty assistant messages.

**Data flow**: It takes the session, turn context, mutable `PlanModeStreamState`, and an item ID. If the item has not already started and exists in `pending_agent_message_items`, it removes that stored `TurnItem`, emits `emit_turn_item_started`, and records the item ID in `started_agent_message_items`.

**Call relations**: Used by both `handle_plan_segments` and `emit_agent_message_in_plan_mode` to lazily materialize assistant-message starts only when needed.

*Call graph*: called by 2 (emit_agent_message_in_plan_mode, handle_plan_segments); 1 external calls (emit_turn_item_started).


##### `agent_message_text`  (lines 1416–1423)

```
fn agent_message_text(item: &codex_protocol::items::AgentMessageItem) -> String
```

**Purpose**: Concatenates all text fragments from an `AgentMessageItem` into a single string. Agent messages are currently text-only, so this is a straightforward flattening helper.

**Data flow**: It takes a borrowed `AgentMessageItem`, iterates its `content`, extracts each `Text { text }` payload, concatenates them, and returns the resulting `String`.

**Call relations**: Used by `emit_agent_message_in_plan_mode` to decide whether a finalized agent message is empty and by `realtime_text_for_event` to mirror completed agent-message text.

*Call graph*: called by 2 (emit_agent_message_in_plan_mode, realtime_text_for_event).


##### `realtime_text_for_event`  (lines 1425–1507)

```
fn realtime_text_for_event(msg: &EventMsg) -> Option<String>
```

**Purpose**: Extracts plain text suitable for realtime mirroring from selected protocol events. Only direct agent-message events and completed agent-message items produce text; all other event variants return `None`.

**Data flow**: It takes an `&EventMsg`, pattern matches over all variants, returns `Some(message.clone())` for `EventMsg::AgentMessage`, returns concatenated text via `agent_message_text` for completed `TurnItem::AgentMessage`, and returns `None` for every other event type.

**Call relations**: Called by realtime mirroring code elsewhere to decide whether an emitted event should also produce realtime text output. It delegates completed-item extraction to `agent_message_text`.

*Call graph*: calls 1 internal fn (agent_message_text); called by 1 (maybe_mirror_event_text_to_realtime).


##### `handle_plan_segments`  (lines 1512–1573)

```
async fn handle_plan_segments(
    sess: &Session,
    turn_context: &TurnContext,
    state: &mut PlanModeStreamState,
    item_id: &str,
    segments: Vec<ProposedPlanSegment>,
)
```

**Purpose**: Consumes parsed plan-mode assistant segments and emits either normal assistant text deltas or synthetic plan lifecycle events. It also buffers leading whitespace so plan-only outputs do not create visible empty assistant messages.

**Data flow**: Inputs are the session, turn context, mutable plan-mode state, item ID, and parsed `Vec<ProposedPlanSegment>`. For `Normal` segments it may buffer whitespace, prepend buffered whitespace to the first visible text, ensure the deferred agent-message start is emitted, and send `AgentMessageContentDeltaEvent`. For `ProposedPlanStart` and `ProposedPlanDelta` it starts the synthetic plan item if needed and emits `PlanDelta`; `ProposedPlanEnd` is ignored because completion is derived from the finalized message. It returns no value.

**Call relations**: Called by `emit_streamed_assistant_text_delta` whenever parsed assistant text in plan mode contains plan segments. It delegates deferred-start logic to `maybe_emit_pending_agent_message_start` and plan-item lifecycle updates to `ProposedPlanItemState` methods.

*Call graph*: calls 1 internal fn (maybe_emit_pending_agent_message_start); called by 1 (emit_streamed_assistant_text_delta); 3 external calls (send_event, format!, AgentMessageContentDelta).


##### `emit_streamed_assistant_text_delta`  (lines 1575–1607)

```
async fn emit_streamed_assistant_text_delta(
    sess: &Session,
    turn_context: &TurnContext,
    plan_mode_state: Option<&mut PlanModeStreamState>,
    item_id: &str,
    parsed: ParsedAssistantTe
```

**Purpose**: Turns parsed assistant text chunks into client-visible delta events, with special handling for plan mode and citation stripping. In non-plan mode it emits visible assistant text directly; in plan mode it routes parsed segments through the plan-segment handler.

**Data flow**: It takes the session, turn context, optional mutable plan-mode state, item ID, and a `ParsedAssistantTextDelta`. Empty parsed chunks are ignored. Citations are discarded locally after extraction. If plan-mode state is present, non-empty `plan_segments` are passed to `handle_plan_segments`; otherwise, non-empty `visible_text` is wrapped in `AgentMessageContentDeltaEvent` and sent to the client.

**Call relations**: Used by `try_run_sampling_request` for live deltas and by both flush helpers for buffered parser output. It is the final adapter from parser output to protocol events.

*Call graph*: calls 1 internal fn (handle_plan_segments); called by 3 (flush_assistant_text_segments_all, flush_assistant_text_segments_for_item, try_run_sampling_request); 3 external calls (is_empty, send_event, AgentMessageContentDelta).


##### `flush_assistant_text_segments_for_item`  (lines 1610–1619)

```
async fn flush_assistant_text_segments_for_item(
    sess: &Session,
    turn_context: &TurnContext,
    plan_mode_state: Option<&mut PlanModeStreamState>,
    parsers: &mut AssistantMessageStreamPars
```

**Purpose**: Flushes any buffered parser state for one assistant item when that item ends. This ensures trailing text or deferred plan parsing is emitted before item completion handling proceeds.

**Data flow**: It takes the session, turn context, optional plan-mode state, mutable parser registry, and item ID. It finalizes the parser for that item with `finish_item` and forwards the parsed result to `emit_streamed_assistant_text_delta`.

**Call relations**: Called by `try_run_sampling_request` when an active streamed assistant item receives `OutputItemDone`.

*Call graph*: calls 2 internal fn (finish_item, emit_streamed_assistant_text_delta); called by 1 (try_run_sampling_request).


##### `flush_assistant_text_segments_all`  (lines 1622–1638)

```
async fn flush_assistant_text_segments_all(
    sess: &Session,
    turn_context: &TurnContext,
    mut plan_mode_state: Option<&mut PlanModeStreamState>,
    parsers: &mut AssistantMessageStreamParse
```

**Purpose**: Flushes all remaining buffered assistant parser state at response completion or cleanup. It is the bulk counterpart to per-item flushing.

**Data flow**: It takes the session, turn context, optional mutable plan-mode state, and mutable parser registry. It drains all finished parser outputs with `drain_finished` and emits each parsed chunk through `emit_streamed_assistant_text_delta`.

**Call relations**: Called by `try_run_sampling_request` both on `ResponseEvent::Completed` and again during final cleanup after the streaming loop exits.

*Call graph*: calls 2 internal fn (drain_finished, emit_streamed_assistant_text_delta); called by 1 (try_run_sampling_request).


##### `maybe_complete_plan_item_from_message`  (lines 1641–1667)

```
async fn maybe_complete_plan_item_from_message(
    sess: &Session,
    turn_context: &TurnContext,
    state: &mut PlanModeStreamState,
    item: &ResponseItem,
)
```

**Purpose**: Parses the finalized assistant message text to extract the complete proposed plan and emits the synthetic plan item completion if one exists. This is where the final plan text is sourced, rather than from incremental deltas alone.

**Data flow**: It takes the session, turn context, mutable plan-mode state, and a completed `ResponseItem`. If the item is an assistant `ResponseItem::Message`, it concatenates all `ContentItem::OutputText` chunks, extracts proposed-plan text with `extract_proposed_plan_text`, strips citations, starts the synthetic plan item if necessary, and completes it with the cleaned plan text. It returns no value.

**Call relations**: Called by `handle_assistant_item_done_in_plan_mode` before finalizing the assistant item. It delegates plan extraction/parsing to `extract_proposed_plan_text` and `strip_citations`.

*Call graph*: called by 1 (handle_assistant_item_done_in_plan_mode); 3 external calls (new, extract_proposed_plan_text, strip_citations).


##### `emit_agent_message_in_plan_mode`  (lines 1670–1710)

```
async fn emit_agent_message_in_plan_mode(
    sess: &Session,
    turn_context: &TurnContext,
    agent_message: codex_protocol::items::AgentMessageItem,
    state: &mut PlanModeStreamState,
)
```

**Purpose**: Completes an agent-message turn item in plan mode while respecting deferred starts and suppressing empty messages. It guarantees a started/completed lifecycle even when the start was postponed until non-plan text appeared.

**Data flow**: It takes the session, turn context, a finalized `AgentMessageItem`, and mutable plan-mode state. It concatenates the message text, drops bookkeeping for whitespace-only messages, otherwise ensures the start event has been emitted (creating an empty placeholder start item if necessary), emits `emit_turn_item_completed`, and removes the item from `started_agent_message_items`.

**Call relations**: Called by `emit_turn_item_in_plan_mode` for finalized `TurnItem::AgentMessage` values. It relies on `agent_message_text` and `maybe_emit_pending_agent_message_start` to decide whether and how to emit the start.

*Call graph*: calls 2 internal fn (agent_message_text, maybe_emit_pending_agent_message_start); called by 1 (emit_turn_item_in_plan_mode); 3 external calls (AgentMessage, emit_turn_item_completed, emit_turn_item_started).


##### `emit_turn_item_in_plan_mode`  (lines 1713–1731)

```
async fn emit_turn_item_in_plan_mode(
    sess: &Session,
    turn_context: &TurnContext,
    turn_item: TurnItem,
    previously_active_item: Option<&TurnItem>,
    state: &mut PlanModeStreamState,
)
```

**Purpose**: Emits completion for a finalized turn item under plan-mode rules, treating agent messages specially and all other items with ordinary start/completion semantics. It preserves the previously active item's lifecycle when needed.

**Data flow**: It takes the session, turn context, finalized `TurnItem`, optional previously active item, and mutable plan-mode state. Agent messages are delegated to `emit_agent_message_in_plan_mode`; non-agent items emit a start if there was no previously active item and then emit completion. It returns no value.

**Call relations**: Used by `handle_assistant_item_done_in_plan_mode` after contributor finalization has produced a `TurnItem` to emit.

*Call graph*: calls 1 internal fn (emit_agent_message_in_plan_mode); called by 1 (handle_assistant_item_done_in_plan_mode); 2 external calls (emit_turn_item_completed, emit_turn_item_started).


##### `handle_assistant_item_done_in_plan_mode`  (lines 1734–1785)

```
async fn handle_assistant_item_done_in_plan_mode(
    sess: &Session,
    turn_context: &TurnContext,
    turn_store: &codex_extension_api::ExtensionData,
    item: &ResponseItem,
    state: &mut Plan
```

**Purpose**: Handles completion of an assistant response item when the turn is in plan mode, including synthetic plan completion, contributor finalization, item emission, history recording, and last-agent-message extraction. It returns whether the item was recognized and fully handled by this specialized path.

**Data flow**: Inputs are the session, turn context, turn extension store, completed `ResponseItem`, mutable plan-mode state, optional previously active item, and mutable `last_agent_message`. For assistant messages it completes any synthetic plan item, finalizes the response item with contributors via `finalize_non_tool_response_item`, emits the resulting turn item through `emit_turn_item_in_plan_mode`, records the completed response item plus finalized facts, and updates `last_agent_message` from those facts. It returns `true` for handled assistant messages and `false` otherwise.

**Call relations**: Called from `try_run_sampling_request` before generic output-item completion handling. It delegates plan extraction to `maybe_complete_plan_item_from_message`, contributor-aware finalization to `finalize_non_tool_response_item`, emission to `emit_turn_item_in_plan_mode`, and persistence to `record_completed_response_item_with_finalized_facts`.

*Call graph*: calls 4 internal fn (emit_turn_item_in_plan_mode, maybe_complete_plan_item_from_message, finalize_non_tool_response_item, record_completed_response_item_with_finalized_facts); called by 1 (try_run_sampling_request); 1 external calls (Run).


##### `drain_in_flight`  (lines 1788–1812)

```
async fn drain_in_flight(
    in_flight: &mut FuturesOrdered<BoxFuture<'static, CodexResult<ResponseInputItem>>>,
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()>
```

**Purpose**: Waits for all queued tool futures to finish and records their outputs into conversation history in completion order. It also marks thread memory mode as polluted when tool outputs introduce external context.

**Data flow**: It takes a mutable `FuturesOrdered` of boxed futures producing `ResponseInputItem`, plus cloned session and turn context. It repeatedly awaits `next()`, converts each successful `ResponseInputItem` into a response item, records it with `record_conversation_items`, and calls `mark_thread_memory_mode_polluted_if_external_context`. Failed tool futures are treated as internal errors via `error_or_panic`. It returns `CodexResult<()>`.

**Call relations**: Called near the end of `try_run_sampling_request` after the response stream finishes or exits. It drains tool side effects before token-count and diff events are emitted so the turn's persisted history is complete.

*Call graph*: calls 2 internal fn (mark_thread_memory_mode_polluted_if_external_context, error_or_panic); called by 1 (try_run_sampling_request); 3 external calls (next, format!, from_ref).


##### `try_run_sampling_request`  (lines 1822–2302)

```
async fn try_run_sampling_request(
    tool_runtime: ToolCallRuntime,
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    turn_store: Arc<codex_extension_api::ExtensionData>,
    client_se
```

**Purpose**: Streams one model response end-to-end, translating low-level `ResponseEvent`s into session history updates, client protocol events, tool executions, plan-mode state transitions, token accounting, and final turn-diff emission. This is the core event loop for a single sampling pass.

**Data flow**: Inputs are a `ToolCallRuntime`, session, turn context, turn extension store, mutable client session, responses metadata, shared diff tracker, built `Prompt`, and cancellation token. It starts the model stream, tracks active output items and tool-argument diff consumers, parses assistant text incrementally, queues tool futures, handles every `ResponseEvent` variant, records token usage and rate limits, flushes parser buffers, drains in-flight tool outputs, optionally emits token-count and turn-diff events, and returns `SamplingRequestResult { needs_follow_up, last_agent_message }` or a `CodexErr` such as `TurnAborted`. It mutates session state heavily through event emission and history recording.

**Call relations**: Called only by `run_sampling_request`, which wraps it with retry logic. Inside, it delegates non-tool item shaping to `handle_non_tool_response_item`, generic completion handling to `handle_output_item_done`, plan-mode assistant completion to `handle_assistant_item_done_in_plan_mode`, parser flushing to the flush helpers, and tool-output persistence to `drain_in_flight`.

*Call graph*: calls 14 internal fn (stream, new, drain_in_flight, emit_streamed_assistant_text_delta, flush_assistant_text_segments_all, flush_assistant_text_segments_for_item, handle_assistant_item_done_in_plan_mode, handle_non_tool_response_item, handle_output_item_done, raw_assistant_output_text_from_item (+4 more)); called by 1 (run_sampling_request); 16 external calls (clone, child_token, is_cancelled, new, lock, clone, feedback_tags!, matches!, Stream, AgentMessageContentDelta (+6 more)).


##### `get_last_assistant_message_from_turn`  (lines 2304–2311)

```
fn get_last_assistant_message_from_turn(responses: &[ResponseItem]) -> Option<String>
```

**Purpose**: Finds the most recent assistant message text in a completed list of response items. It scans from the end so the latest assistant output wins.

**Data flow**: It takes a slice of `ResponseItem`, iterates it in reverse order, asks `last_assistant_message_from_item` for each item's assistant text in non-plan mode, and returns the first `Some(String)` found or `None` if no assistant message exists.

**Call relations**: Used by compaction code outside this file when it needs the final assistant message from a stored turn. It is a small extraction helper over response-item lists.

*Call graph*: calls 1 internal fn (last_assistant_message_from_item); called by 1 (run_compact_task_inner_impl); 1 external calls (iter).

## 📊 State Registers Touched

- `reg-effective-config` — The merged live settings the app actually runs with after combining user, project, managed, thread, and command-line inputs.
- `reg-model-catalog` — The current list of models and provider capabilities the app can offer for use.
- `reg-provider-rate-limit-state` — The current view of backend usage and rate-limit status that affects what the app allows or postpones.
- `reg-thread-history-and-metadata` — The saved and reconstructed conversation history, thread metadata, and fork/rollback lineage for each thread.
- `reg-session-state` — The long-lived per-session state that survives across turns, including history, sticky permissions, connector choices, and prewarm data.
- `reg-input-queues` — The shared pending-input buffers that hold user steering input and inter-agent mailbox messages until a turn consumes them.
- `reg-environment-selection` — The chosen execution environment for a thread or session, including local or remote environment registration details.
- `reg-turn-context-snapshot` — The immutable per-turn snapshot of settings, permissions, environment, models, and services that the current turn runs against.
- `reg-auto-compaction-state` — The running state that tracks when long conversation history should be compacted and how token growth is measured across windows.
- `reg-turn-state` — The mutable coordination state for the currently running turn, including approval waiters, mailbox phase, and strict review flags.
- `reg-model-response-stream` — The live streamed model reply and retry state for the active turn while output is still arriving.
- `reg-code-mode-runtime` — The isolated JavaScript code-mode runtime state that survives long enough to manage timers, tool promises, and module execution.
- `reg-approval-and-review-state` — The outstanding approvals, safety-review decisions, and hook-mediated allow/block results for actions that may affect the real world.
- `reg-network-client-infrastructure` — The shared HTTP/TLS/retry/cookie client plumbing used whenever the app talks to web services or relays.
- `reg-telemetry-context` — The shared tracing and session-telemetry context that stamps logs, traces, and metrics with the right runtime identity.
- `reg-rollout-trace-log` — The richer event recording stream that keeps a replayable story of important runtime activity.
- `reg-token-budget-state` — The current prompt/context token budget accounting and warning thresholds used while assembling turns and deciding what can fit.
- `reg-tool-result-to-code-future-bridge` — The in-flight mapping between external tool-call completions and waiting code-mode promises/futures so async code-mode execution can resume correctly.
- `reg-turn-metadata` — The per-turn metadata attached to outgoing requests and saved results, such as session lineage, workspace details, and other turn facts not captured in the main prompt body.
- `reg-hook-runtime-state` — The configured hook execution state and recent hook run results used to invoke lifecycle hooks and surface their outcomes during turns and tool actions.
- `reg-compaction-artifacts` — The saved compacted-history artifacts and compaction bookkeeping that let long threads replace older context with summarized history across future turns.
- `reg-thread-input-waiters` — The pending wait/notification state for sessions or agents blocked on new mailbox or user input so turn scheduling can resume when input arrives.
- `reg-context-delta-state` — The remembered prompt-assembly diff state that tracks which context fragments or instructions have already been sent so only changed context is re-injected on later turns.
- `reg-turn-abort-and-interrupt-state` — The shared interrupted/aborted-turn state that records cancellation intent and partial-work guidance across dispatch, execution, and later prompt assembly.
