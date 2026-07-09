# Turn execution and model interaction  `stage-13`

This stage is the heart of the session’s main work loop. It begins when the user sends a turn and ends when the assistant has answered, run needed tools, or prepared another model pass. The regular task starts a normal turn, while session/turn.rs coordinates the whole path: gather input, attach tools and context, call the model, stream updates, run tool calls, and finish bookkeeping. turn_metadata.rs adds useful background to each request, such as workspace and safety settings.

When a conversation grows too large, the compact task, compact.rs, and compact_remote.rs shrink it into a shorter summary, either locally or through the model service, so the session can continue.

Model transport execution is the “phone line” to model services. It builds requests, sends them over HTTP, server-sent events, WebSocket, or realtime audio links, decodes streamed replies, and handles retries or failures.

Streaming reduction and UI projection turn many tiny raw events into readable transcript cards, live text, tool statuses, diffs, and final history.

The code-mode runtime files run user JavaScript inside V8, load the main module, block unsupported imports, and provide timers like setTimeout.

## Sub-stages

- [Model transport execution](stage-13.1.md) `stage-13.1` — 28 files
- [Streaming reduction and UI projection](stage-13.2.md) `stage-13.2` — 51 files

## Files in this stage

### Code-mode runtime
These files introduce the embedded JavaScript runtime, then explain how modules are loaded and how timer callbacks are driven inside the runtime loop.

### `code-mode/src/runtime/mod.rs`

`orchestration` · `code-mode execution`

Code mode needs a safe, controllable place to run JavaScript supplied in an execute request. This file creates that place, feeds it the requested source code, and then keeps it moving as outside events arrive. Without it, code mode could not start JavaScript, pause while waiting for tools or timers, resume after outside input, or report the final result back to the rest of the system.

The main idea is like a small control room. `spawn_runtime` sets up communication lines, starts a new operating-system thread, and gives the caller handles for sending commands, sending control messages, and forcibly stopping V8 if needed. Inside that thread, `run_runtime` creates a V8 isolate, which is an independent JavaScript world. It installs the custom global functions that code mode exposes, loads the user’s module, and watches whether the module is done or still waiting.

The runtime talks outward using `RuntimeEvent` messages, such as “started,” “pending,” “tool call requested,” or “result.” The outside world talks back using `RuntimeCommand` messages, such as a tool response, tool error, timer firing, or termination. A separate control channel can pause command processing until an explicit resume. This is important when the caller wants the runtime to stop at safe waiting points instead of continuing automatically.

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

**Purpose**: Starts a new code-mode JavaScript runtime on its own thread. A caller uses it when it has source code to run and needs channels for sending answers, control signals, and termination requests back into that runtime.

**Data flow**: It receives stored values, an execute request, an event sender, and a choice about whether pending work should continue automatically or wait for resume. It initializes V8, builds channels for runtime commands and control commands, extracts the enabled tool metadata from the request, and starts a new thread with all of that configuration. It returns the command sender, the control sender, and a V8 isolate handle that can interrupt long-running JavaScript.

**Call relations**: This is the doorway into the runtime. Higher-level code such as `start_cell` uses it to begin execution, and the tests use it to verify termination and pause behavior. Before the thread starts meaningful work, it relies on `initialize_v8`; after that, the spawned thread continues in `run_runtime`.

*Call graph*: calls 1 internal fn (initialize_v8); called by 4 (pending_mode_freezes_runtime_commands_until_resume, terminate_execution_stops_cpu_bound_module, start_cell, terminate_waits_for_runtime_shutdown_before_responding); 3 external calls (channel, sync_channel, spawn).


##### `initialize_v8`  (lines 144–158)

```
fn initialize_v8() -> Result<(), String>
```

**Purpose**: Prepares the V8 JavaScript engine once for the whole process. This must happen before any JavaScript isolate can be created.

**Data flow**: It reads a process-wide cached initialization result. If V8 has not been set up yet, it loads ICU data, which is Unicode and international text support, creates the V8 platform, and initializes V8. It returns success if setup is ready, or an error message if setup failed.

**Call relations**: `spawn_runtime` calls this before creating the runtime thread. The one-time cache means many runtimes can be spawned without repeating global V8 setup.

*Call graph*: called by 1 (spawn_runtime); 1 external calls (new).


##### `run_runtime`  (lines 160–269)

```
fn run_runtime(
    config: RuntimeConfig,
    event_tx: mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: std_mpsc::Receiver<RuntimeCommand>,
    control_rx: std_mpsc::Receiver<RuntimeControlComma
```

**Purpose**: Runs the actual JavaScript execution loop. It creates the JavaScript world, installs code-mode features, evaluates the user’s code, waits for outside commands, and sends back the final result.

**Data flow**: It receives the runtime configuration, event channel, command channel, control channel, pending-mode setting, a place to send back the isolate handle, and a command sender for callbacks. It creates a V8 isolate and context, stores runtime state inside the V8 scope, installs global functions, announces that execution has started, and evaluates the main module. If the code finishes immediately, it sends a result. If the code is waiting, it repeatedly receives commands, applies them to the waiting JavaScript promise, runs JavaScript microtasks, checks for completion, and eventually sends a result or exits on termination.

**Call relations**: This is the runtime’s main worker. It is launched by the thread created in `spawn_runtime`. It delegates setup of code-mode globals to `install_globals`, module evaluation and promise checking to the module loader, timer callbacks to the timer code, waiting policy to `next_runtime_command`, and final reporting to `send_result` or `capture_scope_send_error`.

*Call graph*: calls 8 internal fn (capture_scope_send_error, install_globals, completion_state, evaluate_main_module, resolve_tool_response, next_runtime_command, send_result, invoke_timeout_callback); 11 external calls (default, new, send, clone, send, new, new, default, new, new (+1 more)).


##### `next_runtime_command`  (lines 271–293)

```
fn next_runtime_command(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    command_rx: &std_mpsc::Receiver<RuntimeCommand>,
    control_rx: &std_mpsc::Receiver<RuntimeControlCommand>,
    pendin
```

**Purpose**: Decides when the runtime should take its next command. It also sends a “pending” event when the JavaScript side is waiting for something outside itself.

**Data flow**: It receives the event sender, the command receiver, the control receiver, and the pending-mode setting. It first checks whether a runtime command is already waiting. If not, it tells the outside world the runtime is pending. In normal mode, it blocks until the next command arrives. In pause-until-resumed mode, it waits for either a resume control message, after which it checks again for commands, or a terminate control message, which becomes a terminate command.

**Call relations**: `run_runtime` calls this each time JavaScript is waiting. This function is the gatekeeper that makes the difference between automatic continuation and deliberate pausing.

*Call graph*: calls 1 internal fn (recv); called by 1 (run_runtime); 2 external calls (send, try_recv).


##### `capture_scope_send_error`  (lines 295–306)

```
fn capture_scope_send_error(
    scope: &mut v8::PinScope<'_, '_>,
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    error_text: Option<String>,
)
```

**Purpose**: Sends an error result while preserving any stored-value writes the JavaScript code already made. This avoids losing useful state changes when execution fails after doing partial work.

**Data flow**: It receives the current V8 scope, the event sender, and an optional error message. It looks inside the runtime state stored in the scope and copies the accumulated stored-value writes if they exist. It then sends those writes together with the error text as the final result.

**Call relations**: `run_runtime` uses this when a failure happens after the V8 scope exists, such as a module loading problem or a failed tool-response resolution. It hands the actual event sending to `send_result`.

*Call graph*: calls 1 internal fn (send_result); called by 1 (run_runtime).


##### `send_result`  (lines 308–317)

```
fn send_result(
    event_tx: &mpsc::UnboundedSender<RuntimeEvent>,
    stored_value_writes: HashMap<String, JsonValue>,
    error_text: Option<String>,
)
```

**Purpose**: Reports the runtime’s final outcome to the rest of the system. The outcome includes stored-value writes and, if something went wrong, an error message.

**Data flow**: It receives an event sender, a map of stored-value writes, and an optional error string. It wraps them in a `RuntimeEvent::Result` message and sends that message outward. It does not return a meaningful value and ignores the case where the receiver is already gone.

**Call relations**: `run_runtime` calls this when execution finishes normally or fails before detailed state capture is needed. `capture_scope_send_error` also calls it after collecting state from the V8 scope.

*Call graph*: called by 2 (capture_scope_send_error, run_runtime); 1 external calls (send).


##### `tests::execute_request`  (lines 335–343)

```
fn execute_request(source: &str) -> ExecuteRequest
```

**Purpose**: Builds a small execute request for tests. It lets each test focus on the JavaScript source it wants to run instead of repeating the same request setup.

**Data flow**: It receives a source-code string. It creates an `ExecuteRequest` with a fixed tool call id, no enabled tools, that source text, a short yield time, and no output-token limit. It returns the completed request object.

**Call relations**: The runtime tests call this before `spawn_runtime` so they can start a runtime with predictable test settings.

*Call graph*: 1 external calls (new).


##### `tests::terminate_execution_stops_cpu_bound_module`  (lines 346–379)

```
async fn terminate_execution_stops_cpu_bound_module()
```

**Purpose**: Checks that a runaway JavaScript program can be stopped. The test uses an infinite loop to prove that the V8 termination handle can interrupt CPU-bound code that never naturally waits.

**Data flow**: It creates an event channel and starts a runtime with JavaScript that loops forever. It waits for the started event, calls the isolate termination handle, then waits for a result event containing an error. Finally, it checks that the event stream closes afterward.

**Call relations**: This test exercises `spawn_runtime` from the outside, then uses the returned isolate handle to force termination. It confirms that `run_runtime` reports termination as a final runtime result instead of hanging forever.

*Call graph*: calls 1 internal fn (spawn_runtime); 7 external calls (from_secs, new, assert!, execute_request, unbounded_channel, panic!, timeout).


##### `tests::pending_mode_freezes_runtime_commands_until_resume`  (lines 382–447)

```
async fn pending_mode_freezes_runtime_commands_until_resume()
```

**Purpose**: Checks that pause-until-resumed mode really pauses runtime command processing. It proves that a timer event sent to the runtime does not run JavaScript until a resume control message arrives.

**Data flow**: It starts a runtime with JavaScript that waits on a timer, writes text after the timer, and then waits forever. It confirms the runtime starts and becomes pending, sends a timer-fired command, and verifies that no output appears right away. After sending resume, it expects the text output, then another pending event, and finally sends terminate to clean up.

**Call relations**: This test drives the behavior implemented by `next_runtime_command` through the public `spawn_runtime` entry point. It shows how `RuntimeCommand` messages can be held back until `RuntimeControlCommand::Resume` allows `run_runtime` to continue.

*Call graph*: calls 1 internal fn (spawn_runtime); 8 external calls (from_secs, new, assert!, assert_eq!, execute_request, unbounded_channel, panic!, timeout).


### `code-mode/src/runtime/module_loader.rs`

`orchestration` · `runtime execution and async completion checks`

This file lets the project run JavaScript code inside V8, the JavaScript engine used by Chrome. Its main job is to take a string of source code, treat it as a JavaScript module, and evaluate it safely enough that Rust can understand the outcome. If the code finishes right away, Rust records that it is done. If the code returns a promise, meaning “I will finish later,” Rust keeps that promise so the outer runtime can check back later.

It also connects asynchronous tool calls back into JavaScript. When JavaScript asks for some external tool work, the runtime stores a promise resolver. Later, when Rust receives the tool result, this file either resolves the JavaScript promise with JSON data or rejects it with an error message.

A key rule here is that imports are not allowed. Both normal module imports and dynamic imports like import(...) are routed through callbacks that reject them. Think of this runtime as a sealed workbench: the user can run the code placed on the bench, but cannot reach out and pull in extra files.

The file also recognizes a special “exit” signal. That signal is thrown inside JavaScript like an exception, but this file treats it as an intentional stop rather than a crash.

#### Function details

##### `evaluate_main_module`  (lines 9–52)

```
fn evaluate_main_module(
    scope: &mut v8::PinScope<'_, '_>,
    source_text: &str,
) -> Result<Option<v8::Global<v8::Promise>>, String>
```

**Purpose**: This function takes the user’s JavaScript source text and runs it as the main module. It returns a saved JavaScript promise if the code is still doing asynchronous work, or no promise if the code has already finished or intentionally exited.

**Data flow**: It receives a V8 execution scope and the JavaScript source text. It turns the text into a V8 string, gives it a script name for error reporting, compiles it as a module, instantiates it with the project’s import-blocking resolver, and evaluates it. If evaluation throws the special exit signal, it reports a clean stop. If evaluation throws a real error, it turns that JavaScript value into readable error text. If the result is a promise, it stores that promise in a Rust-owned global handle and returns it.

**Call relations**: The outer runtime calls this from run_runtime when it is time to start the user code. During setup it asks script_origin to create the source location information. If evaluation fails, it uses is_exit_exception to tell an intentional exit apart from a real failure, and value_to_error_text to turn JavaScript errors into Rust strings.

*Call graph*: calls 3 internal fn (is_exit_exception, script_origin, value_to_error_text); called by 1 (run_runtime); 6 external calls (new, pin!, new, try_from, new, compile_module).


##### `is_exit_exception`  (lines 54–64)

```
fn is_exit_exception(
    scope: &mut v8::PinScope<'_, '_>,
    exception: v8::Local<'_, v8::Value>,
) -> bool
```

**Purpose**: This function decides whether a thrown JavaScript value is actually the runtime’s planned exit signal. It prevents a normal user-requested stop from being reported as an error.

**Data flow**: It receives the current V8 scope and a JavaScript exception value. It reads RuntimeState from the scope to see whether an exit was requested, checks that the exception is a string, and compares that string to the special EXIT_SENTINEL value. It returns true only when all of those checks match.

**Call relations**: evaluate_main_module uses this when initial module evaluation throws, so an intentional exit can end cleanly. completion_state uses it later when a pending promise rejects, so an asynchronous exit is also treated as a clean completion rather than a crash.

*Call graph*: called by 2 (completion_state, evaluate_main_module); 2 external calls (is_string, to_rust_string_lossy).


##### `resolve_tool_response`  (lines 66–101)

```
fn resolve_tool_response(
    scope: &mut v8::PinScope<'_, '_>,
    id: &str,
    response: Result<JsonValue, String>,
) -> Result<(), String>
```

**Purpose**: This function delivers an external tool result back into JavaScript. It completes the JavaScript promise that was waiting for that tool call, either with returned JSON data or with an error.

**Data flow**: It receives a V8 scope, the tool call id, and either a JSON result or an error string. It looks up and removes the matching pending promise resolver from RuntimeState. If the tool succeeded, it converts the JSON value into a V8 JavaScript value and resolves the promise. If the tool failed, it creates a JavaScript string containing the error and rejects the promise. If JavaScript throws while this happens, it converts that thrown value into readable error text and returns it as a Rust error.

**Call relations**: run_runtime calls this after some outside tool work finishes. This function is the point where Rust hands the answer back to the JavaScript promise that was paused waiting for it. It uses json_to_v8 to translate Rust-side JSON into a JavaScript value.

*Call graph*: calls 1 internal fn (json_to_v8); called by 1 (run_runtime); 3 external calls (pin!, new, new).


##### `completion_state`  (lines 103–139)

```
fn completion_state(
    scope: &mut v8::PinScope<'_, '_>,
    pending_promise: Option<&v8::Global<v8::Promise>>,
) -> CompletionState
```

**Purpose**: This function checks whether the JavaScript run is finished, still waiting, or finished with an error. It is how the outer runtime polls an asynchronous JavaScript promise without guessing.

**Data flow**: It receives the V8 scope and an optional saved promise from the main module. It first reads any stored value writes from RuntimeState so completed work can be reported. If there is no pending promise, it reports completed success. If there is a promise, it checks whether it is still pending, fulfilled, or rejected. A fulfilled promise becomes completed success. A rejected promise becomes completed with error text, unless the rejection is the special exit signal, in which case it becomes a clean completion.

**Call relations**: run_runtime calls this after starting code or after resolving tool work to see what should happen next. It uses is_exit_exception to recognize intentional exits and value_to_error_text to make real JavaScript rejection reasons understandable to Rust.

*Call graph*: calls 2 internal fn (is_exit_exception, value_to_error_text); called by 1 (run_runtime); 1 external calls (new).


##### `script_origin`  (lines 141–162)

```
fn script_origin(
    scope: &mut v8::PinScope<'s, '_>,
    resource_name_: &str,
) -> Result<v8::ScriptOrigin<'s>, String>
```

**Purpose**: This helper creates source-location information for the JavaScript module. That gives V8 a file-like name to use in errors and debugging output.

**Data flow**: It receives a V8 scope and a resource name such as exec_main.mjs. It creates V8 strings for the script name and source map URL, then builds a ScriptOrigin object with module-related settings. It returns that origin object, or an error string if V8 could not allocate the needed strings.

**Call relations**: evaluate_main_module calls this before compiling the user’s code. The origin it creates is attached to the V8 source object so later compile or runtime errors can point back to a meaningful module name.

*Call graph*: called by 1 (evaluate_main_module); 2 external calls (new, new).


##### `resolve_module_callback`  (lines 164–173)

```
fn resolve_module_callback(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _import_attributes: v8::Local<'s, v8::FixedArray>,
    _referrer: v8::Local<'s, v8::M
```

**Purpose**: This is the callback V8 uses when JavaScript code contains a static import statement. In this runtime, it always routes the request to the import-blocking resolver.

**Data flow**: V8 provides the current JavaScript context, the requested import specifier, import attributes, and the module that requested it. The function enters the V8 callback scope, converts the requested specifier into a Rust string, and passes it to resolve_module. The result is always no module, because imports are unsupported here.

**Call relations**: evaluate_main_module passes this callback to V8 during module instantiation. If V8 finds a static import, it calls this function, which then hands the specifier to resolve_module so the runtime can throw a clear unsupported-import exception.

*Call graph*: calls 1 internal fn (resolve_module); 2 external calls (to_rust_string_lossy, callback_scope!).


##### `dynamic_import_callback`  (lines 175–221)

```
fn dynamic_import_callback(
    scope: &mut v8::PinScope<'s, '_>,
    _host_defined_options: v8::Local<'s, v8::Data>,
    _resource_name: v8::Local<'s, v8::Value>,
    specifier: v8::Local<'s, v8::Str
```

**Purpose**: This is the callback for dynamic JavaScript imports, such as import('some-module'). It returns a JavaScript promise that rejects when the requested module is not supported.

**Data flow**: It receives the V8 scope and the requested import specifier. It creates a JavaScript promise resolver, converts the specifier to a Rust string, and asks resolve_module for the module. Since resolve_module rejects unsupported imports, the usual result is a rejected promise with an “unsupported import in exec” message. If a module were ever returned, this function would instantiate and evaluate it as needed, then resolve the promise with the module namespace.

**Call relations**: V8 calls this when running JavaScript uses dynamic import. It delegates the actual module lookup decision to resolve_module. If lookup, instantiation, or evaluation fails, it rejects the promise so JavaScript sees the import failure in the normal promise-based way.

*Call graph*: calls 1 internal fn (resolve_module); 4 external calls (to_rust_string_lossy, matches!, new, new).


##### `resolve_module`  (lines 223–235)

```
fn resolve_module(
    scope: &mut v8::PinScope<'s, '_>,
    specifier: &str,
) -> Option<v8::Local<'s, v8::Module>>
```

**Purpose**: This function is the runtime’s module gatekeeper. It currently rejects every import request and raises a JavaScript exception explaining that imports are unsupported.

**Data flow**: It receives the V8 scope and the requested module specifier as text. It tries to build a JavaScript error message saying that the import is unsupported. If it can create the message, it throws that; otherwise it throws JavaScript undefined as a fallback. It always returns no module.

**Call relations**: resolve_module_callback calls this for static imports, and dynamic_import_callback calls it for import(...). By centralizing the rejection here, both import paths enforce the same sealed-runtime rule.

*Call graph*: called by 2 (dynamic_import_callback, resolve_module_callback); 4 external calls (throw_exception, format!, new, undefined).


### `code-mode/src/runtime/timers.rs`

`domain_logic` · `during runtime execution when JavaScript schedules, cancels, or fires timers`

This file is the small timer desk for the runtime. JavaScript code can say, “run this function after this many milliseconds,” and this Rust code records that request, waits in the background, then tells the main runtime loop when the time is up. Without it, code running inside this runtime could not use familiar delayed callbacks such as `setTimeout`.

The main idea is simple: when a timeout is scheduled, the callback function is stored in the runtime state and given a numeric ID. A separate operating-system thread sleeps for the requested time, then sends a message back to the runtime saying that this ID has fired. The callback is not run directly on the sleeping thread. That matters because the JavaScript engine, V8, must be entered carefully from the runtime’s own execution flow.

`clearTimeout` works by removing the stored callback for an ID. If the sleeping thread later sends its “time is up” message, there is nothing left to run, so the event is ignored.

The file also cleans up messy inputs. Missing, negative, infinite, or invalid delay values become either “run immediately” or “nothing to cancel,” matching the forgiving style people expect from JavaScript timers.

#### Function details

##### `schedule_timeout`  (lines 12–45)

```
fn schedule_timeout(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<u64, String>
```

**Purpose**: This function implements the core of `setTimeout`: it checks that the first JavaScript argument is a function, stores that function for later, starts a waiting thread, and returns a numeric timeout ID. Someone uses it when JavaScript code asks the runtime to run a callback after a delay.

**Data flow**: It receives the current V8 scope, which gives access to the JavaScript engine and runtime state, plus the JavaScript arguments. It reads the callback and delay from those arguments, turns the delay into a safe whole number of milliseconds, stores the callback in the runtime’s pending-timeout table under a new ID, and starts a thread that sleeps for that delay. After sleeping, the thread sends a `TimeoutFired` message containing the ID back to the runtime. The function returns the ID, or an error string if the callback or runtime state is not valid.

**Call relations**: This is reached from `set_timeout_callback`, the binding that JavaScript sees as `setTimeout`. It prepares the timer request and hands off future work to a background thread, which later notifies the main runtime through a runtime command instead of calling JavaScript directly.

*Call graph*: called by 1 (set_timeout_callback); 4 external calls (get, spawn, new, try_from).


##### `clear_timeout`  (lines 47–60)

```
fn clear_timeout(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<(), String>
```

**Purpose**: This function implements the core of `clearTimeout`: it cancels a pending timeout by removing its saved callback. If the ID is missing or not meaningful, it quietly does nothing, which matches normal JavaScript behavior.

**Data flow**: It receives the V8 scope and the JavaScript arguments. It asks `timeout_id_from_args` to turn the first argument into an optional timeout ID. If there is no usable ID, it returns successfully without changing anything. If there is an ID, it reads the runtime state and removes that ID from the pending-timeout table. The result is either success or an error string if the runtime state is unavailable.

**Call relations**: This is called by `clear_timeout_callback`, the JavaScript-facing wrapper for `clearTimeout`. It depends on `timeout_id_from_args` to interpret JavaScript’s loose input rules before it touches the runtime’s stored timers.

*Call graph*: calls 1 internal fn (timeout_id_from_args); called by 1 (clear_timeout_callback).


##### `invoke_timeout_callback`  (lines 62–89)

```
fn invoke_timeout_callback(
    scope: &mut v8::PinScope<'_, '_>,
    timeout_id: u64,
) -> Result<(), String>
```

**Purpose**: This function runs a timeout callback after the main runtime has been told that the timer fired. It also catches JavaScript exceptions so a thrown error becomes a Rust error message instead of escaping unnoticed.

**Data flow**: It receives the V8 scope and the timeout ID that fired. It looks up and removes the saved callback from the runtime state. If the callback was already removed, for example by `clearTimeout`, it returns successfully and does nothing. If the callback exists, it enters V8 with a protected `TryCatch` block, calls the function with no arguments, and then checks whether JavaScript threw an exception. It returns success if the callback finished normally, or an error string containing the exception text if it failed.

**Call relations**: This is called by `run_runtime` when the runtime processes a `TimeoutFired` command. It is the point where the earlier scheduling work finally becomes JavaScript execution, and it uses the runtime’s saved callback rather than trusting the background sleeping thread to run JavaScript itself.

*Call graph*: called by 1 (run_runtime); 3 external calls (pin!, new, undefined).


##### `timeout_id_from_args`  (lines 90–106)

```
fn timeout_id_from_args(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
) -> Result<Option<u64>, String>
```

**Purpose**: This helper reads the timeout ID passed to `clearTimeout` and turns it into a safe Rust number. It treats missing, null, undefined, negative, zero, or infinite values as “no timer to cancel.”

**Data flow**: It receives the V8 scope and JavaScript arguments. It first checks whether an argument exists and whether it is not null or undefined. If there is no meaningful value, it returns `None`. If there is a value, it tries to read it as a number. A non-number gives an error. A valid positive finite number is truncated to a whole number, capped at the largest possible `u64`, and returned as `Some(id)`.

**Call relations**: This is used by `clear_timeout` before it changes the pending-timeout table. Its job is to keep argument interpretation in one place, so the cancellation function can focus on removing the stored callback.

*Call graph*: called by 1 (clear_timeout); 2 external calls (get, length).


##### `normalize_delay_ms`  (lines 108–114)

```
fn normalize_delay_ms(delay_ms: f64) -> u64
```

**Purpose**: This helper turns a JavaScript delay value into a safe millisecond count for Rust to sleep. It makes invalid, negative, zero, or infinite delays become zero, meaning the timer can fire as soon as the runtime gets to it.

**Data flow**: It receives a floating-point delay value from JavaScript. If the value is not finite or is less than or equal to zero, it returns `0`. Otherwise, it drops any fractional part, caps the value at the largest possible `u64`, and returns that whole number as milliseconds.

**Call relations**: This is used by `schedule_timeout` while preparing a new timer. It protects the sleeping thread from strange JavaScript delay values and gives the rest of the timer code a simple, safe integer to work with.


### Compaction paths
These files cover the manual compaction task and the two underlying implementations for local and provider-backed transcript compaction.

### `core/src/tasks/compact.rs`

`orchestration` · `during a session when manual compaction is requested`

Long conversations can grow too large or expensive to keep sending around in full. Compaction is the cleanup step that turns the current conversation context into a shorter form while preserving the important information, like summarizing a long notebook before continuing to use it.

This file provides `CompactTask`, a small task object that plugs into the broader session task system. When the task runs, it first makes a usable clone of the current session. Then it decides where compaction should happen. If the current model provider supports remote compaction, it sends the job to a remote compaction path. There are two remote versions: a newer “RemoteCompactionV2” path used when that feature flag is enabled, and an older remote path used otherwise. A feature flag is a runtime switch that lets the program turn behavior on or off without changing this file.

If remote compaction is not appropriate, the task builds a synthetic user message containing the compaction prompt from the current turn context and runs the local compaction code. In every path it emits a telemetry metric, meaning a small measurement used to understand which compaction route was taken. The task returns `None` because its purpose is to perform the compaction side effect, not to produce a direct text reply.

#### Function details

##### `CompactTask::kind`  (lines 16–18)

```
fn kind(&self) -> TaskKind
```

**Purpose**: This tells the session task system that this task is the compaction task. The system can use that label to track, schedule, or report what kind of work is being done.

**Data flow**: It takes the task object itself, reads no outside data, and returns the fixed task kind `Compact`. Nothing else is changed.

**Call relations**: The wider session task framework calls this when it needs to identify the task. It does not call other project functions; it simply hands back the task's category.


##### `CompactTask::span_name`  (lines 20–22)

```
fn span_name(&self) -> &'static str
```

**Purpose**: This gives the task a stable tracing name: `session_task.compact`. A tracing name is like a label on a stopwatch, helping logs and performance tools show where time was spent.

**Data flow**: It receives the task object, reads no outside state, and returns a fixed text label. It does not change the session or compaction state.

**Call relations**: The session task framework calls this when creating tracing or monitoring records around the task run. It does not hand work off to anything else.


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

**Purpose**: This performs the actual compaction request for a session. It decides whether to use the newer remote service, the older remote service, or the local compaction code, then starts the chosen path.

**Data flow**: It receives the session task context, the current turn context, any turn input, and a cancellation token. The turn input and cancellation token are not used here. It clones the session, checks the provider information and feature flags, records a metric saying which compaction route is being used, and then calls the selected compaction function. For local compaction, it first creates a synthetic text input from the context's compaction prompt. After the chosen compaction work finishes, it returns `None` and relies on the called compaction code to make the real changes.

**Call relations**: The session task runner calls this when it is time to compact the conversation. Inside, it asks `should_use_remote_compact_task` whether remote compaction fits the current provider. If the newer remote feature is enabled, it emits a `remote_v2` metric and hands off to the v2 remote compaction runner. If not, it emits a `remote` metric and hands off to the older remote runner. If remote compaction is not used, it emits a `local` metric, builds the prompt input, and hands off to the local `run_compact_task`.

*Call graph*: calls 4 internal fn (run_compact_task, should_use_remote_compact_task, run_remote_compact_task, run_remote_compact_task); 2 external calls (emit_compact_metric, vec!).


### `core/src/compact_remote.rs`

`orchestration` · `during manual or automatic conversation compaction`

Large language models can only read a limited amount of conversation at once. When a chat gets too long, this file helps turn the old conversation into a shorter version that still preserves the important parts. Think of it like asking someone to rewrite a thick notebook into a concise briefing before the next meeting.

The file supports both user-requested compaction and automatic compaction. It starts by marking the compaction turn, collecting analytics, and running pre-compaction hooks, which are project-defined checks that can stop the operation before it begins. It then prepares the current conversation history for the remote compaction endpoint. If tool outputs are too large to fit, it replaces some bulky outputs with a clear truncation message rather than sending too much text.

Next, it builds a prompt containing the trimmed history, current instructions, and visible tool definitions, then sends it to the model client’s compact-conversation API. The returned replacement history is filtered so stale developer instructions and fake user wrapper messages do not become part of the live session. If needed, fresh initial context is inserted in the right place. Finally, the compacted history is installed into the session, token counts are recalculated, completion events are emitted, hooks run after success, and analytics record whether everything succeeded, failed, or was interrupted.

#### Function details

##### `run_inline_remote_auto_compact_task`  (lines 44–63)

```
async fn run_inline_remote_auto_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    turn_state: Arc<OnceLock<String>>,
    initial_context_injection: InitialContextInjection,
```

**Purpose**: Runs automatic remote compaction inside an existing turn. This is used when the system decides the conversation needs shrinking while work is already in progress.

**Data flow**: It receives the current session, turn context, optional shared turn state, instructions about whether to inject initial context, and analytics labels explaining why compaction is happening. It passes those details into the shared compaction runner with the trigger set to automatic. If the inner work succeeds, it returns success; if not, it passes the error back.

**Call relations**: This function is called by run_auto_compact when automatic shrinking is needed. It does not do the detailed work itself; it hands everything to run_remote_compact_task_inner so automatic and manual compaction share the same core path.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run_auto_compact).


##### `run_remote_compact_task`  (lines 65–89)

```
async fn run_remote_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()>
```

**Purpose**: Starts a user-requested remote compaction as its own visible turn. It tells the rest of the system that a compaction turn has begun, then uses the shared compaction runner.

**Data flow**: It reads turn information such as the turn ID, trace ID, start time, model context size, and collaboration mode. It sends a TurnStarted event to the session, then calls the shared compaction runner with manual/user-requested settings and no initial context injection. The result is either success or the error from the compaction process.

**Call relations**: This function is called by run when the user explicitly asks to compact. It creates the start event first, then delegates the actual compaction flow to run_remote_compact_task_inner.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run); 1 external calls (TurnStarted).


##### `run_remote_compact_task_inner`  (lines 91–167)

```
async fn run_remote_compact_task_inner(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    turn_state: Option<Arc<OnceLock<String>>>,
    initial_context_injection: InitialContextInject
```

**Purpose**: Coordinates the full compaction workflow around the actual remote call. It is responsible for hooks, analytics, error reporting, and deciding whether the inner compaction result counts as success, failure, or interruption.

**Data flow**: It receives the session, turn context, optional turn state, context-injection choice, and labels describing the trigger, reason, and phase. It creates metadata and analytics details, records the starting token count, begins an analytics attempt, and runs pre-compaction hooks. If a hook stops the process, it records an interrupted attempt and returns an abort error. Otherwise it calls the implementation function, runs post-compaction hooks on success, tracks the final status, emits an error event if needed, and returns the final result.

**Call relations**: Both run_inline_remote_auto_compact_task and run_remote_compact_task call this function. It calls run_pre_compact_hooks before the real work, run_remote_compact_task_inner_impl for the main compaction operation, compaction_status_from_result to translate the result into analytics status, and run_post_compact_hooks after a successful compaction.

*Call graph*: calls 6 internal fn (begin, compaction_status_from_result, run_remote_compact_task_inner_impl, run_post_compact_hooks, run_pre_compact_hooks, new); called by 2 (run_inline_remote_auto_compact_task, run_remote_compact_task); 2 external calls (default, Error).


##### `run_remote_compact_task_inner_impl`  (lines 169–294)

```
async fn run_remote_compact_task_inner_impl(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    turn_state: Option<Arc<OnceLock<String>>>,
    initial_context_injection: InitialContextI
```

**Purpose**: Performs the main remote compaction operation: prepare history, call the compact-conversation endpoint, clean up the returned history, and install it into the session. This is where the old live history is actually replaced by the compacted version.

**Data flow**: It creates a context-compaction item so the UI and tracing system can follow the operation. It clones the current history, gets the current base instructions, and shortens oversized tool outputs if the history is too large for the model’s context window. It turns that history into prompt input, builds the visible tool list, prepares request metadata, and calls the model client to compact the conversation. The returned history is filtered and possibly given fresh initial context, then recorded in the trace, installed into the session as the new history, and used to recompute token usage. It also emits started and completed events for the compaction item.

**Call relations**: This function is called only by run_remote_compact_task_inner after hooks and analytics setup. It relies on trim_function_call_history_to_fit_context_window before contacting the model, built_tools to describe available tools to the model, and process_compacted_history after the model returns the replacement transcript.

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

**Purpose**: Cleans the model-produced compacted history before it becomes live session history. It removes items that should not be trusted or preserved and, for mid-turn compaction, inserts fresh initial context in the correct place.

**Data flow**: It receives the session, turn context, compacted history from the remote endpoint, and a choice about initial context injection. If context should be injected before the last user message, it builds that context from the current session; otherwise it uses no extra context. It then removes unwanted history items using should_keep_compacted_history_item and inserts the fresh context before the last real user message or summary. The output is the cleaned replacement history.

**Call relations**: run_remote_compact_task_inner_impl calls this after the remote compaction endpoint returns. Tests also call it directly to check filtering and context placement. It hands the cleaned list back to the installer path that replaces the session history.

*Call graph*: calls 1 internal fn (insert_initial_context_before_last_real_user_or_summary); called by 4 (run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl, process_compacted_history_with_test_session, process_compacted_history_preserves_separate_guardian_developer_message); 3 external calls (new, build_initial_context, matches!).


##### `should_keep_compacted_history_item`  (lines 334–360)

```
fn should_keep_compacted_history_item(item: &ResponseItem) -> bool
```

**Purpose**: Decides whether a single item returned by remote compaction is safe and useful enough to keep. This protects the session from stale instructions, duplicate wrappers, and tool-call leftovers that should not become part of the compacted conversation.

**Data flow**: It receives one response item from the compacted transcript. It checks the item’s kind and role: developer messages are dropped, real user messages and hook prompts are kept, assistant messages and compaction markers are kept, and most tool calls, tool outputs, reasoning items, and unknown items are dropped. It returns true for keep or false for discard.

**Call relations**: This function is used as the filter inside process_compacted_history. It also consults the event-mapping parser to distinguish real user messages from user-role wrapper messages that only existed as session machinery.

*Call graph*: 1 external calls (matches!).


##### `trim_function_call_history_to_fit_context_window`  (lines 362–402)

```
fn trim_function_call_history_to_fit_context_window(
    history: &mut ContextManager,
    turn_context: &TurnContext,
    base_instructions: &BaseInstructions,
) -> (usize, i64)
```

**Purpose**: Makes a copied conversation history small enough to send to the remote compaction endpoint by replacing large tool outputs with short placeholder text. This avoids failing before compaction can even begin because the compaction request itself is too large.

**Data flow**: It receives a mutable history copy, the current turn context, and base instructions. If the model has no known context-window limit, it changes nothing. Otherwise it repeatedly estimates the token count, starting from the newest items and moving backward. While the history is too large, it looks for rewriteable output items, replaces one with a shorter version, and counts how many outputs were rewritten and roughly how many tokens were removed. It returns those two counts.

**Call relations**: run_remote_compact_task_inner_impl calls this before building the remote compaction prompt. It uses rewritten_output_for_context_window to create the smaller replacement item and updates analytics through the counts it returns.

*Call graph*: calls 4 internal fn (estimate_token_count_with_base_instructions, raw_items, replace, model_context_window); called by 2 (run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl).


##### `rewritten_output_for_context_window`  (lines 404–441)

```
fn rewritten_output_for_context_window(item: &ResponseItem) -> Option<ResponseItem>
```

**Purpose**: Creates a smaller version of a tool-output item when that output can be safely shortened for the compaction request. Items that are not suitable for this kind of rewrite are left unchanged by returning nothing.

**Data flow**: It receives one response item. If the item is a function-call output or custom tool-call output, it keeps the call identity and metadata but replaces the body with a standard truncation message. If it is a tool-search output, it keeps the call status and execution details but removes the listed tools. For any other item, it returns no replacement.

**Call relations**: trim_function_call_history_to_fit_context_window calls this while scanning history from newest to oldest. For output items that need their body shortened, this function calls truncated_output_payload to build the replacement payload.

*Call graph*: calls 1 internal fn (truncated_output_payload); 1 external calls (new).


##### `truncated_output_payload`  (lines 443–448)

```
fn truncated_output_payload(output: &FunctionCallOutputPayload) -> FunctionCallOutputPayload
```

**Purpose**: Builds the standard replacement payload used when a tool output is too large to fit. It preserves whether the tool succeeded while replacing the actual text with a clear message saying the output was truncated.

**Data flow**: It receives the original function-call output payload. It copies the success flag and replaces the body with the text “Output exceeded the available model context and was truncated.” The result is a smaller payload that still tells later code the tool call existed and whether it succeeded.

**Call relations**: rewritten_output_for_context_window calls this when rewriting function-call and custom-tool outputs. Its output is placed back into the copied history that trim_function_call_history_to_fit_context_window is shrinking.

*Call graph*: called by 1 (rewritten_output_for_context_window); 1 external calls (Text).


### `core/src/compact.rs`

`domain_logic` · `during manual or automatic conversation compaction`

Large language models can only read a limited amount of text at once. This file provides “compaction”: it takes an overgrown conversation, creates a summary of the important parts, and replaces the old detailed history with a smaller version. Think of it like packing a suitcase: old items are folded down into a summary, while the most useful recent user messages are kept visible.

The main flow starts when compaction is requested manually or triggered automatically. Before doing the work, the file runs optional hooks, which are extension points that can allow or stop compaction. It then starts a special model request using a compaction prompt. As the model streams back its answer, the file records the completed output items and updates token usage, rate-limit information, and other session state.

After the model finishes, the file takes the last assistant response as the summary, collects real user messages from the previous history, and builds a replacement history. It may also reinsert the session’s initial context in a precise place, because some compaction modes need the model to see that context before the next real user message. Finally it swaps the session history, updates token counts, sends a warning that repeated compactions can reduce accuracy, and records analytics about whether compaction succeeded, failed, or was interrupted.

#### Function details

##### `should_use_remote_compact_task`  (lines 69–71)

```
fn should_use_remote_compact_task(provider: &ModelProviderInfo) -> bool
```

**Purpose**: This function decides whether a model provider can use a remote compaction service instead of doing compaction inline in this process. It is a simple capability check.

**Data flow**: It receives information about the model provider. It asks that provider whether remote compaction is supported. It returns true if remote compaction should be used, otherwise false.

**Call relations**: Automatic compaction and the main run path call this when choosing the compaction route. The function hands that decision off to the provider’s own support flag, so the rest of the system does not need to know provider-specific details.

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

**Purpose**: This starts an automatic compaction that is performed inline, using the current session and turn context. It creates the compaction prompt as if it were user input, then sends it through the shared compaction workflow.

**Data flow**: It receives the session, the current turn context, where initial context should be inserted, and analytics labels describing why and when compaction is happening. It turns the turn context’s compaction prompt into a text input. It then calls the inner compaction runner and returns success or the error from that runner.

**Call relations**: The automatic compaction path calls this when remote compaction is not being used. This function is a small adapter: it prepares the synthesized prompt, marks the trigger as automatic, and delegates the real work to run_compact_task_inner.

*Call graph*: calls 1 internal fn (run_compact_task_inner); called by 1 (run_auto_compact); 1 external calls (vec!).


##### `run_compact_task`  (lines 100–124)

```
async fn run_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<UserInput>,
) -> CodexResult<()>
```

**Purpose**: This starts a user-requested compaction turn. It notifies the outside world that a turn has begun, then runs the common compaction workflow as a manual standalone compaction.

**Data flow**: It receives the session, turn context, and the user input that requested compaction. It sends a TurnStarted event containing identifiers, timing, model window size, and collaboration mode. It then calls the inner compaction runner and returns success or failure.

**Call relations**: The main run flow calls this for manual compaction. It sets up the user-visible turn event, then hands control to run_compact_task_inner with settings that say this was manually requested and should not inject initial context into the replacement history immediately.

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

**Purpose**: This is the shared wrapper around compaction. It runs pre- and post-compaction hooks, records analytics, and converts the final result into a clear success, failure, or interruption status.

**Data flow**: It receives the session, turn context, compaction input, insertion policy for initial context, and labels describing the compaction trigger, reason, and phase. It creates metadata and starts an analytics attempt. If a pre-hook stops the turn, it records an interrupted result and returns an abort error. Otherwise it runs the actual implementation, optionally runs post-hooks on success, records the final analytics event, and returns the implementation result.

**Call relations**: Both manual compaction and inline automatic compaction call this. It calls run_compact_task_inner_impl for the actual model-and-history work, and surrounds that work with hooks and analytics so every compaction attempt is consistently observed.

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

**Purpose**: This performs the actual inline compaction. It asks the model for a summary, builds the shortened replacement history, installs it into the session, and sends completion and warning events.

**Data flow**: It receives the session, turn context, compaction input, an initial-context insertion choice, and metadata for the model request. It records the compaction input into a temporary history, streams a model response until completion, and retries recoverable stream errors. If the prompt is too large, it removes the oldest history item and tries again. Once the model finishes, it reads the latest assistant message as the summary, gathers user messages from the previous history, builds a compacted history, optionally inserts initial context, replaces the session history, recomputes token usage, emits completion, and returns the summary text.

**Call relations**: run_compact_task_inner calls this after hooks allow compaction. This function calls drain_to_completed to talk to the model, collect_user_messages and build_compacted_history to create the new history, and insert_initial_context_before_last_real_user_or_summary when mid-turn compaction needs context placed carefully.

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

**Purpose**: This starts a record of one compaction attempt for analytics. It captures enough starting information to later report how long compaction took and how much context was present before it ran.

**Data flow**: It receives the session, turn context, trigger, reason, implementation type, and phase. It reads the current total token usage and records identifiers, timestamps, and labels. It returns a CompactionAnalyticsAttempt value that will be completed later.

**Call relations**: The inline compaction wrapper and remote compaction paths call this before doing their work. The returned attempt is later consumed by CompactionAnalyticsAttempt::track to send the final analytics event.

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

**Purpose**: This finishes and sends the analytics record for one compaction attempt. It reports whether compaction completed, failed, or was interrupted, along with timing and token information.

**Data flow**: It receives the stored attempt, the session, a final status, an optional error, and optional extra details. It fills in missing details from the attempt and current session state, calculates elapsed time, creates a CodexCompactionEvent, and sends it to the analytics client. It does not return a value.

**Call relations**: run_compact_task_inner calls this after pre-hook cancellation, after post-hook cancellation, and after the main compaction result. Remote compaction code also uses the same method, so local and remote compaction produce comparable analytics.

*Call graph*: 4 external calls (elapsed, now_unix_seconds, get_total_token_usage, try_from).


##### `compaction_status_from_result`  (lines 420–426)

```
fn compaction_status_from_result(result: &CodexResult<T>) -> CompactionStatus
```

**Purpose**: This translates a Rust result into a compaction analytics status. It keeps reporting consistent by treating normal success, user interruption, turn abortion, and other errors differently.

**Data flow**: It receives a result from a compaction operation. If the result is successful, it returns Completed. If the error is Interrupted or TurnAborted, it returns Interrupted. Any other error becomes Failed.

**Call relations**: The inline and remote compaction flows call this before sending analytics. It gives CompactionAnalyticsAttempt::track the status label it needs without duplicating the same decision logic in multiple places.

*Call graph*: called by 3 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner).


##### `content_items_to_text`  (lines 428–445)

```
fn content_items_to_text(content: &[ContentItem]) -> Option<String>
```

**Purpose**: This turns a list of message content pieces into plain text. It keeps text parts and ignores images, which is useful when building readable transcript sections.

**Data flow**: It receives content items that may include input text, output text, or images. It collects non-empty text strings, joins them with newlines, and returns the combined text. If there is no text, it returns nothing.

**Call relations**: Transcript-building code calls this when it needs text from model protocol content. This file provides the small conversion so callers such as guardian transcript collection and current-thread section building do not have to repeat the same filtering rules.

*Call graph*: called by 2 (collect_guardian_transcript_entries, build_current_thread_section); 1 external calls (new).


##### `collect_user_messages`  (lines 453–473)

```
fn collect_user_messages(items: &[ResponseItem]) -> Vec<CompactedUserMessage>
```

**Purpose**: This extracts the real user messages from a conversation history for possible reuse after compaction. It deliberately skips previous compaction summaries, because those are stored as user-looking messages but should not be treated as new user requests.

**Data flow**: It receives raw response items from the session history. For each item, it asks the event-mapping code whether the item represents a user message. If it is a real user message, it saves the text and any metadata; if it is a summary message, it skips it. It returns the collected messages in their original order.

**Call relations**: run_compact_task_inner_impl calls this after the new summary has been produced, and rollout reconstruction code also uses it. The returned messages are passed to build_compacted_history so recent user intent can survive alongside the new summary.

*Call graph*: called by 2 (run_compact_task_inner_impl, reconstruct_history_from_rollout); 1 external calls (iter).


##### `is_summary_message`  (lines 475–477)

```
fn is_summary_message(message: &str) -> bool
```

**Purpose**: This checks whether a message is one of this system’s compaction summaries. It does that by looking for the standard summary prefix at the start of the message.

**Data flow**: It receives a message string. It compares the beginning of the string with the configured summary prefix followed by a newline. It returns true for summary messages and false otherwise.

**Call relations**: insert_initial_context_before_last_real_user_or_summary uses this to distinguish real user messages from summary messages. collect_user_messages performs the same kind of filtering through this rule so summaries are not accidentally preserved as ordinary user text.

*Call graph*: called by 1 (insert_initial_context_before_last_real_user_or_summary); 1 external calls (format!).


##### `insert_initial_context_before_last_real_user_or_summary`  (lines 489–534)

```
fn insert_initial_context_before_last_real_user_or_summary(
    mut compacted_history: Vec<ResponseItem>,
    initial_context: Vec<ResponseItem>,
) -> Vec<ResponseItem>
```

**Purpose**: This inserts the session’s initial context into a compacted history at the spot the model expects. It is careful to keep the final summary or compaction item last when there is no real user message to insert before.

**Data flow**: It receives a compacted history and a list of initial-context items. It scans backward for the last real user message, then for a summary-like user message, then for a compaction item. It inserts the initial context before the best matching item, or appends it if there is no suitable anchor. It returns the updated history.

**Call relations**: run_compact_task_inner_impl calls this for mid-turn compaction, where the replacement history must include initial context before the last real user message. Remote compaction processing also calls it when adapting compacted history returned from elsewhere.

*Call graph*: calls 2 internal fn (is_summary_message, parse_turn_item); called by 2 (run_compact_task_inner_impl, process_compacted_history).


##### `build_compacted_history`  (lines 536–547)

```
fn build_compacted_history(
    initial_context: Vec<ResponseItem>,
    user_messages: &[CompactedUserMessage],
    summary_text: &str,
) -> Vec<ResponseItem>
```

**Purpose**: This builds the standard replacement history after compaction. It keeps optional initial context, a bounded set of recent user messages, and the new summary.

**Data flow**: It receives initial context items, collected user messages, and summary text. It forwards them to the limit-aware builder with the file’s normal maximum token budget for retained user messages. It returns the new list of response items.

**Call relations**: run_compact_task_inner_impl uses this to install local compaction results. Rollout reconstruction and rollout sampling also use it so they produce compacted histories with the same shape and limits.

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

**Purpose**: This is the detailed builder for compacted history. It chooses the newest user messages that fit within a token budget, truncates one message if needed, and appends the summary as the final user-style message.

**Data flow**: It receives an existing history list, user messages, summary text, and a maximum token count. It walks backward from the newest user message, counting approximate tokens until the budget is full. If the next message is too large, it cuts that message down to the remaining budget. It then appends the selected messages in normal order and finally appends the summary, using a fallback text if the summary is empty. It returns the completed replacement history.

**Call relations**: build_compacted_history calls this with the default token budget. Keeping this limit logic separate makes the public builder simple while letting tests or nearby code reason about the exact trimming behavior.

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

**Purpose**: This runs the model request for compaction and consumes its stream until the model says it is finished. Along the way it records useful events from the stream into the session.

**Data flow**: It receives the session, turn context, model client session, request metadata, and prompt. It opens a model stream, then reads events one by one. Completed output items are recorded into conversation history, server reasoning and rate-limit updates are saved, and final token usage is stored when completion arrives. It returns success on a completed response, or an error if the stream fails or closes too early.

**Call relations**: run_compact_task_inner_impl calls this inside its retry loop. This function is the bridge between the compaction workflow and the model transport: it turns streamed model events into session updates and tells the caller whether the attempt finished cleanly.

*Call graph*: calls 2 internal fn (stream, disabled); called by 1 (run_compact_task_inner_impl); 6 external calls (record_conversation_items, set_server_reasoning_included, update_rate_limits, update_token_usage_info, Stream, from_ref).


### Turn execution
These files describe how a normal turn is launched, enriched with metadata, and then executed through the central turn engine until completion.

### `core/src/tasks/regular.rs`

`orchestration` · `request handling`

A “regular task” is the path used when the user sends normal input and the system needs to produce the next assistant response. Without this file, the session would not have a clear worker for ordinary turns: no turn-start event would be sent, startup prewarm work would not be connected to the turn, and queued follow-up input might be left waiting.

The main piece is `RegularTask`, a small type that implements the shared `SessionTask` interface. That interface lets the larger session machinery treat different task types in a common way while still asking each task what kind it is, what tracing label to use, and how to actually run.

When a regular task runs, it first clones the session handle it needs, gathers turn-specific extension data, and emits a `TurnStarted` event. This is like ringing a bell at the start of a meeting so observers know which turn began, when it began, and what context it is using. Importantly, this event is sent before waiting for startup prewarm resolution, so the first-turn lifecycle is not blocked by background preparation.

Then it tries to consume a prewarmed client session, if one is ready. “Prewarm” means doing expensive setup early so the real turn can start faster. If startup was cancelled, the task stops. Otherwise it calls `run_turn`, which performs the real assistant turn. After each run, it checks whether more input arrived while the turn was active. If so, it loops and runs again with empty new input, allowing pending queued work to be drained before the task finishes.

#### Function details

##### `RegularTask::new`  (lines 22–24)

```
fn new() -> Self
```

**Purpose**: Creates a new regular session task. Callers use this when they want the standard “handle a normal user turn” worker.

**Data flow**: Nothing goes in. The function builds a fresh `RegularTask` value, which carries no extra stored settings. The new task comes out ready to be given to the session task system.

**Call relations**: This is used by the parts of the session that decide when a normal turn should begin, such as when user input arrives, when the system tries to start queued work, or in tests around startup prewarm behavior. It simply supplies the task object; the actual turn work happens later through `RegularTask::run`.

*Call graph*: called by 5 (user_input_or_turn_inner, try_start_turn_if_idle, interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm, maybe_start_turn_for_pending_work_with_sub_id).


##### `RegularTask::kind`  (lines 28–30)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Tells the session task system that this task is a regular turn. This lets shared scheduling code distinguish it from other kinds of work.

**Data flow**: The function reads no outside data and does not change anything. It returns the fixed task label `Regular`, meaning “ordinary user turn.”

**Call relations**: The broader task framework calls this through the `SessionTask` interface when it needs to classify the task. That classification helps the session track what type of work is currently active.


##### `RegularTask::span_name`  (lines 32–34)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides the name used for tracing this task in logs and diagnostics. A tracing span is a labeled section of work, like a timestamped folder that groups related log messages.

**Data flow**: The function takes no meaningful input and reads no session state. It returns the fixed text label `session_task.turn`.

**Call relations**: The session task runner can ask for this name when setting up observability around the task. The label helps developers follow a regular turn through logs without changing the behavior of the turn itself.


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

**Purpose**: Runs a normal user turn from start to finish, including announcing that the turn began, using any ready startup prewarm session, calling the main turn engine, and looping if more input arrived during the turn.

**Data flow**: It receives the task, the session context, the turn context, the user inputs for this turn, and a cancellation token, which is a shared stop signal. It sends a `TurnStarted` event, resets a session flag about server reasoning, waits for startup prewarm resolution, and then passes the prepared data into `run_turn`. If cancellation happens during prewarm, it returns no message. Otherwise it returns the last assistant message from the final completed turn, or keeps looping until the session input queue has no pending work.

**Call relations**: This is the heart of the regular task once the session machinery has chosen to run it. It prepares the turn locally, then hands off to `run_turn` for the actual assistant response work. It uses tracing spans so the preparation and turn execution can be followed in diagnostics, and it creates child cancellation tokens so each individual turn run can be stopped cleanly without losing the parent cancellation signal.

*Call graph*: calls 1 internal fn (run_turn); 5 external calls (clone, child_token, new, TurnStarted, trace_span!).


### `core/src/turn_metadata.rs`

`domain_logic` · `request handling`

A Codex conversation is made of turns, and each turn may need a small “label sheet” attached to outgoing requests. This file creates and updates that label sheet. It records stable facts like the session ID, thread ID, turn ID, sandbox setting, and whether this turn belongs to a subagent. It also stores changing facts, such as whether the user was asked for more input during the turn, when the turn started, and any extra client-provided metadata that is allowed through a filter.

The file also enriches metadata with workspace information from Git. Git is the version-control tool used to track code changes. The enrichment can include the repository root, remote URLs, latest commit hash, and whether there are uncommitted changes. Because asking Git for this information can take time, the normal turn state can start a background task and later read whatever workspace details have been gathered. This is like sending someone to check the filing cabinet while the main conversation continues.

The main type is `TurnMetadataState`, which is a shared, cloneable holder for turn metadata. It uses locks and an atomic flag so different async tasks can safely read and update the same state. There is also a special path for detached memory requests, which builds similar metadata without a full turn state.

#### Function details

##### `WorkspaceGitMetadata::is_empty`  (lines 48–52)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether any useful Git workspace information was found. This prevents the system from sending an empty workspace record that would look meaningful but contain no facts.

**Data flow**: It reads the three optional fields inside a `WorkspaceGitMetadata`: remote URLs, latest commit hash, and changed-files status. If all three are missing, it returns `true`; otherwise it returns `false`. It does not change anything.

**Call relations**: The background Git enrichment flow uses this before adding workspace metadata to the turn state. The memory metadata flow also uses it before adding a workspace entry, so both paths avoid publishing blank Git data.


##### `TurnMetadataWorkspace::from`  (lines 56–62)

```
fn from(value: WorkspaceGitMetadata) -> Self
```

**Purpose**: Converts the file’s internal Git workspace record into the public metadata shape used by response requests. This keeps Git collection details separate from the format sent onward.

**Data flow**: It takes a `WorkspaceGitMetadata` value as input. It copies over the remote URLs, commit hash, and changed-files flag into a `TurnMetadataWorkspace`. The input is consumed and the converted workspace object comes out.

**Call relations**: The Git enrichment task and the memory workspace builder call this conversion when they are ready to place Git facts into the request metadata map.


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

**Purpose**: Builds metadata for a detached memory request, which is a request related to memory rather than a normal conversation turn. It gives that request the same kind of session, sandbox, subagent, and workspace context as other Codex requests.

**Data flow**: It receives identifiers such as installation, session, thread, and window IDs, plus the session source, current directory, and optional sandbox label. It creates a fresh `CodexResponsesMetadata`, marks it as a memory request, adds the subagent header, copies the sandbox label if present, and awaits Git workspace discovery. The result is a complete metadata object ready to attach to the memory request.

**Call relations**: This function calls `subagent_header_value` to describe where the request came from, `memory_workspaces` to gather Git context, and `CodexResponsesMetadata::new` to fill in the basic metadata shell. It is the standalone path used when there is no existing `TurnMetadataState` to reuse.

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

**Purpose**: Creates the shared metadata state for one conversation turn. Callers use it at the start of a turn so later code can add timing, client metadata, user-input flags, and Git enrichment in one place.

**Data flow**: It receives the current IDs, thread lineage, session source, working directory, permission profile, Windows sandbox level, and managed-network setting. It checks whether the current directory is inside a Git repository, turns the permission settings into a sandbox tag, derives subagent labels from the session source, and initializes shared storage for workspace data, timestamps, extra metadata, a user-input flag, and a possible background task. The output is a `TurnMetadataState` ready to be cloned and shared.

**Call relations**: Higher-level conversation setup code such as `make_turn_context` and review-thread spawning creates this state. Tests also build it to verify lineage, reserved metadata filtering, and model/request metadata behavior. Later methods on the same state use the values initialized here.

*Call graph*: calls 3 internal fn (subagent_header_value, subagent_metadata_kind, permission_profile_sandbox_tag); called by 14 (spawn_review_thread, make_turn_context, turn_metadata_state_ignores_client_reserved_metadata_before_start, turn_metadata_state_includes_forked_thread_spawn_subagent_lineage, turn_metadata_state_includes_known_parent_for_non_thread_spawn_subagents_without_fork, turn_metadata_state_includes_model_and_reasoning_effort_only_in_request_meta, turn_metadata_state_includes_root_fork_lineage, turn_metadata_state_includes_thread_spawn_subagent_parent_without_fork, turn_metadata_state_includes_turn_started_at_unix_ms_after_start, turn_metadata_state_marks_user_input_requested_during_turn_only_for_mcp_request_meta (+4 more)); 6 external calls (new, new, new, new, new, get_git_repo_root).


##### `TurnMetadataState::current_meta_value_for_mcp_request`  (lines 145–181)

```
fn current_meta_value_for_mcp_request(
        &self,
        context: McpTurnMetadataContext<'_>,
    ) -> Option<serde_json::Value>
```

**Purpose**: Builds the metadata JSON value to attach to an MCP request. MCP means Model Context Protocol, a way for Codex to talk to external tools; those tool requests need current turn context too.

**Data flow**: It takes an MCP-specific context containing the model name and optional reasoning effort. It starts from the normal turn metadata template, converts it into a JSON object, inserts the model, adds or removes the reasoning-effort field depending on whether one was provided, and adds or removes the user-input-requested flag based on the current atomic flag. It returns a JSON value if the template can be represented as an object; otherwise it returns nothing.

**Call relations**: This method calls `responses_metadata_template` to get the shared base metadata, then adjusts it for MCP-only fields. It is used when an outgoing MCP request needs the freshest per-turn details rather than the broader `CodexResponsesMetadata` structure.

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

**Purpose**: Turns the current turn state into the metadata object used for a Responses API request. Callers use it when they are about to send a normal request and need the final metadata package.

**Data flow**: It receives the installation ID, window ID, and the kind of request being made. It starts with the current metadata template, fills in the installation and window IDs, and sets the request kind. The result is a `CodexResponsesMetadata` ready for serialization and sending.

**Call relations**: It relies on `responses_metadata_template` for all shared turn fields. The provided call graph shows tests calling it through `test_responses_metadata_json` to confirm that the produced metadata has the expected JSON form.

*Call graph*: calls 1 internal fn (responses_metadata_template); called by 1 (test_responses_metadata_json).


##### `TurnMetadataState::mark_user_input_requested_during_turn`  (lines 197–200)

```
fn mark_user_input_requested_during_turn(&self)
```

**Purpose**: Records that Codex asked the user for more input during this turn. This matters because later metadata can say the turn involved an extra user prompt.

**Data flow**: It takes no extra input beyond the state itself. It changes an atomic boolean from false to true. Future metadata reads can then include `user_input_requested_during_turn: true`.

**Call relations**: This flag is read by `current_meta_value_for_mcp_request` when building MCP metadata. The method is a small event marker: some other part of the turn flow calls it at the moment user input is requested.


##### `TurnMetadataState::set_responsesapi_client_metadata`  (lines 202–211)

```
fn set_responsesapi_client_metadata(
        &self,
        responsesapi_client_metadata: HashMap<String, String>,
    )
```

**Purpose**: Stores extra metadata supplied by the client, after removing keys the client is not allowed to set. This lets clients add useful labels while protecting reserved system-controlled fields.

**Data flow**: It receives a plain key-value map from the client. It passes that map through `filter_extra_metadata`, then replaces the state’s stored extra metadata with the filtered result under a write lock. Nothing is returned, but later metadata templates include the saved extra values.

**Call relations**: This method calls `filter_extra_metadata` before storing anything. `responses_metadata_template` later reads the filtered map and includes it in outgoing metadata.

*Call graph*: calls 1 internal fn (filter_extra_metadata).


##### `TurnMetadataState::workspace_kind`  (lines 213–219)

```
fn workspace_kind(&self) -> Option<String>
```

**Purpose**: Reads the client-provided workspace kind, if one survived metadata filtering. This gives other code a simple way to ask what kind of workspace the client says this turn is using.

**Data flow**: It reads the stored extra metadata map under a read lock, looks for the `workspace_kind` key, clones its string value if present, and returns it. It does not modify the state.

**Call relations**: It depends on `set_responsesapi_client_metadata` having previously stored filtered client metadata. Other turn logic can call this as a focused accessor instead of inspecting the whole extra metadata map.


##### `TurnMetadataState::responses_metadata_template`  (lines 221–243)

```
fn responses_metadata_template(&self) -> CodexResponsesMetadata
```

**Purpose**: Builds the common metadata base shared by different outgoing request types. It gathers the stable and current turn facts in one place so every request does not have to rebuild them separately.

**Data flow**: It reads fields from the state: turn ID, thread lineage, subagent labels, sandbox label, current workspace map, turn-start timestamp, and filtered extra metadata. It combines those with session and thread IDs in a new `CodexResponsesMetadata`, leaving installation and window IDs blank for callers to fill in later. The output is a reusable metadata object.

**Call relations**: `current_meta_value_for_mcp_request` uses this as the starting point for MCP JSON metadata, and `to_responses_metadata` uses it as the base for Responses API metadata. Tests also call through it to check header-related behavior.

*Call graph*: calls 3 internal fn (new, current_turn_started_at_unix_ms, current_workspaces); called by 3 (current_meta_value_for_mcp_request, to_responses_metadata, test_turn_metadata_header); 1 external calls (new).


##### `TurnMetadataState::current_workspaces`  (lines 245–251)

```
fn current_workspaces(&self) -> BTreeMap<String, TurnMetadataWorkspace>
```

**Purpose**: Returns the latest workspace metadata known to the turn state. If Git enrichment has not produced anything yet, it returns an empty map instead of making callers deal with missing storage.

**Data flow**: It reads the optional enriched workspace map under a read lock. If a map exists, it clones and returns it; if not, it returns a new empty map. It does not change the stored workspace data.

**Call relations**: `responses_metadata_template` calls this whenever it builds metadata. The data may have been filled earlier by `spawn_git_enrichment_task` after `fetch_workspace_git_metadata` completes.

*Call graph*: called by 1 (responses_metadata_template).


##### `TurnMetadataState::current_turn_started_at_unix_ms`  (lines 253–258)

```
fn current_turn_started_at_unix_ms(&self) -> Option<i64>
```

**Purpose**: Returns the recorded start time for the turn, if one has been set. The time is stored as Unix milliseconds, meaning milliseconds since the standard Unix epoch.

**Data flow**: It reads the optional timestamp under a read lock and returns the copied value. If no timestamp has been stored, it returns `None`. It does not modify the state.

**Call relations**: `responses_metadata_template` calls this so outgoing metadata can include when the turn began. `set_turn_started_at_unix_ms` is the companion method that writes the value.

*Call graph*: called by 1 (responses_metadata_template).


##### `TurnMetadataState::set_turn_started_at_unix_ms`  (lines 260–265)

```
fn set_turn_started_at_unix_ms(&self, turn_started_at_unix_ms: i64)
```

**Purpose**: Stores the time when the turn started. This lets later outgoing metadata include timing context for the turn.

**Data flow**: It receives a timestamp in Unix milliseconds. It takes a write lock and replaces the stored optional timestamp with that value. It returns nothing, but future metadata templates can read the timestamp.

**Call relations**: This is called by turn-running code when the start time is known. `current_turn_started_at_unix_ms`, through `responses_metadata_template`, later carries that value into request metadata.


##### `TurnMetadataState::spawn_git_enrichment_task`  (lines 267–298)

```
fn spawn_git_enrichment_task(&self)
```

**Purpose**: Starts a background job that gathers Git metadata for the current workspace. It avoids slowing down the main turn flow while still allowing later requests to include repository details if they become available.

**Data flow**: It first checks whether a Git repository root was found; if not, it does nothing. It then locks the task slot and refuses to start a second task if one is already running. Otherwise it clones the state and spawns an async task that fetches Git metadata, checks that a repository root still exists and the metadata is not empty, then writes a workspace map into the shared state.

**Call relations**: The spawned task calls `fetch_workspace_git_metadata` inside its async body and stores the converted workspace data for `current_workspaces` to read later. `cancel_git_enrichment_task` can abort the task if the turn is ending or enrichment is no longer needed.

*Call graph*: 2 external calls (new, spawn).


##### `TurnMetadataState::cancel_git_enrichment_task`  (lines 300–308)

```
fn cancel_git_enrichment_task(&self)
```

**Purpose**: Stops the background Git enrichment task if it is still running. This prevents unnecessary work from continuing after the metadata is no longer useful.

**Data flow**: It locks the stored task slot, removes any saved task handle, and if one existed, calls abort on it. The state no longer remembers a running enrichment task afterward.

**Call relations**: This is the cleanup counterpart to `spawn_git_enrichment_task`. Where spawning sends a worker off to gather Git facts, cancellation pulls the plug on that worker when the larger turn flow decides it should stop.


##### `TurnMetadataState::fetch_workspace_git_metadata`  (lines 310–323)

```
async fn fetch_workspace_git_metadata(&self) -> WorkspaceGitMetadata
```

**Purpose**: Asks Git for the workspace facts used in metadata: the current commit, the configured remotes, and whether there are local changes. It gathers these facts concurrently to save time.

**Data flow**: It reads the state’s current working directory and launches three Git queries at the same time using `tokio::join!`. It converts the commit hash into a plain string if present, then returns a `WorkspaceGitMetadata` containing the remote URLs, latest commit hash, and changed-files flag. It does not write to shared state itself.

**Call relations**: The background task created by `spawn_git_enrichment_task` calls this, then decides whether to store the returned data. This separation keeps Git querying separate from the logic that publishes the result into turn metadata.

*Call graph*: 1 external calls (join!).


##### `memory_workspaces`  (lines 326–345)

```
async fn memory_workspaces(cwd: &AbsolutePathBuf) -> BTreeMap<String, TurnMetadataWorkspace>
```

**Purpose**: Builds workspace metadata for detached memory requests. It is a standalone helper for the memory path, where there may not be a full `TurnMetadataState` or background enrichment task.

**Data flow**: It receives the current directory, looks for the Git repository root, and concurrently asks Git for the head commit, remotes, and local-change status. It builds a `WorkspaceGitMetadata`, then creates a workspace map containing the repository root only if a root exists and at least one useful Git fact was found. The output is that workspace map, possibly empty.

**Call relations**: `detached_memory_responses_metadata` awaits this helper while constructing memory-request metadata. It mirrors the Git data collected by `fetch_workspace_git_metadata`, but returns the final workspace map directly instead of storing it in shared turn state.

*Call graph*: called by 1 (detached_memory_responses_metadata); 3 external calls (new, get_git_repo_root, join!).


### `core/src/session/turn.rs`

`orchestration` · `request handling`

Think of this file as the air-traffic controller for a single exchange with the assistant. Before asking the model anything, it checks whether the conversation is too large and may compact it, meaning it summarizes or trims old context so the model can still fit the conversation in its limited memory. It records new user input, runs hooks, adds skill, plugin, app, and extension guidance, and tracks analytics about the resolved settings for the turn.

Once ready, it builds the prompt: the conversation items, visible tools, instructions, personality, and output rules. It then opens a streaming request to the model. As events arrive, it converts them into client-facing events: assistant text deltas, reasoning deltas, tool-call progress, plan updates, token counts, and final completed items. If the model asks for tools, this file starts those tool calls and later records their outputs so the model can continue. If the model reaches a context limit, pending input arrives, a hook asks for continuation, or the model says the turn is not finished, the loop runs another sampling request.

It also has special handling for “plan mode,” where proposed plans are split away from normal assistant text so users see plans as plan items, not as stray chat text.

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

**Purpose**: Runs the full life of one assistant turn, from fresh user input to final assistant message or early stop. It is the main coordinator for compaction, hooks, skill/plugin injection, model calls, tool follow-ups, errors, and stop hooks.

**Data flow**: It receives the session, turn context, extension data, user inputs, an optional ready-to-use model session, and a cancellation signal. It records or rejects input, adds injected context, repeatedly builds model requests, processes model responses, may compact context, and may loop when tools or pending input require another model call. It returns the last assistant message text when one is available, or nothing if the turn stops or fails before that.

**Call relations**: The higher-level session runner calls this when a turn begins. Inside, it calls helpers such as run_pre_sampling_compact, build_skills_and_plugins, run_hooks_and_record_inputs, run_sampling_request, auto_compact_token_status, and run_auto_compact, then finishes by running stop and after-agent hooks when the model no longer needs follow-up.

*Call graph*: calls 15 internal fn (run_legacy_after_agent_hook, run_pending_session_start_hooks, run_turn_stop_hooks, maybe_record_token_budget_remaining_context, auto_compact_token_status, build_skills_and_plugins, run_auto_compact, run_hooks_and_record_inputs, run_pre_sampling_compact, run_sampling_request (+5 more)); called by 1 (run); 12 external calls (clone, new, child_token, new, error!, info!, Error, Warning, from_ref, new (+2 more)).


##### `turn_diff_display_roots`  (lines 414–430)

```
async fn turn_diff_display_roots(turn_context: &TurnContext) -> Vec<(String, PathBuf)>
```

**Purpose**: Finds the filesystem roots that should be used when showing file changes made during the turn. This makes diffs easier to read by anchoring them at a project or Git repository root instead of an arbitrary folder.

**Data flow**: It reads each turn environment, tries to convert its current working directory into a local path, then asks Git utilities for the repository root. It returns pairs of environment id and display root path, skipping environments whose paths cannot be represented locally.

**Call relations**: run_turn calls this before creating the turn diff tracker. The resulting roots tell the diff tracker how to present changed files during and after the model/tool work.

*Call graph*: called by 1 (run_turn); 2 external calls (new, get_git_repo_root_with_fs).


##### `run_hooks_and_record_inputs`  (lines 433–459)

```
async fn run_hooks_and_record_inputs(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    input: &[TurnInput],
) -> bool
```

**Purpose**: Runs input-inspection hooks before adding user input to the conversation history. Hooks can block input, add extra context, or allow the input to be recorded.

**Data flow**: It receives a batch of turn inputs. For each input, it asks the hook runtime to inspect it; blocked input contributes only additional context, while accepted input is recorded along with any context the hook supplied. It returns true only when input was blocked and no real user text was accepted.

**Call relations**: run_turn uses this for both the initial input and any input that arrived while the model was running. It relies on inspect_pending_input, record_additional_contexts, and record_pending_input to enforce hook decisions.

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

**Purpose**: Builds extra context messages for explicitly requested skills, plugins, apps, and extensions. This lets the model receive the right instructions or capability descriptions only when the user’s input calls for them.

**Data flow**: It reads user input, enabled plugins, available app/connectors, MCP tools, skill metadata, and extension contributors. It detects explicit mentions, may prompt to install missing dependencies, creates response items containing skill/plugin/extension guidance, tracks analytics, and returns those items plus connector ids that should be enabled for this turn.

**Call relations**: run_turn calls it before sampling. It delegates to build_extension_turn_input_items, collect_explicit_app_ids_from_skill_items, plugin and skill injection builders, connector utilities, and dependency installation prompts.

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

**Purpose**: Asks installed extensions whether they want to add extra context for this turn. This gives extensions a controlled way to contribute useful information before the model is called.

**Data flow**: It gathers the turn id, user input, and local environment folders, then passes that context to each turn-input contributor. Each contributor returns contextual fragments, which are converted into model input items. If a contributor is cancelled or fails in this path, the function returns nothing for the whole build.

**Call relations**: build_skills_and_plugins calls this while assembling all injected context. It talks to extension contributors and hands their fragments back as response items to be recorded before sampling.

*Call graph*: called by 1 (build_skills_and_plugins); 2 external calls (new, to_vec).


##### `track_turn_resolved_config_analytics`  (lines 679–731)

```
async fn track_turn_resolved_config_analytics(
    sess: &Session,
    turn_context: &TurnContext,
    input: &[TurnInput],
)
```

**Purpose**: Records what configuration actually applied to this turn for analytics. This helps the project understand which models, permission modes, reasoning settings, sandboxes, and session types are being used.

**Data flow**: It reads the session’s current configuration snapshot, checks whether this is the first turn, counts image inputs, and combines those facts with the turn context. It sends one structured analytics fact and changes the session state by consuming the “next turn is first” flag.

**Call relations**: run_turn calls it after recording injections and settings. It does not affect model behavior; it reports the resolved state to the analytics client.

*Call graph*: calls 2 internal fn (network_sandbox_policy, permission_profile); called by 1 (run_turn); 1 external calls (iter).


##### `auto_compact_token_status`  (lines 746–793)

```
async fn auto_compact_token_status(
    sess: &Session,
    turn_context: &TurnContext,
) -> AutoCompactTokenStatus
```

**Purpose**: Checks whether the conversation has grown too large for the configured auto-compaction limit or the model’s full context window. In plain terms, it decides whether the model’s memory budget is close enough to full that cleanup is needed.

**Data flow**: It reads total token usage, the compaction scope setting, any compaction window baseline, and the model’s context limits. It calculates active tokens, tokens counted against the compaction budget, relevant limits, and boolean flags saying whether a limit was reached. It returns those numbers in an AutoCompactTokenStatus value.

**Call relations**: run_pre_sampling_compact uses it before model sampling, and run_turn uses it after sampling. Its result tells those callers whether to invoke run_auto_compact or continue normally.

*Call graph*: calls 1 internal fn (model_context_window); called by 2 (run_pre_sampling_compact, run_turn); 2 external calls (auto_compact_window_snapshot, get_total_token_usage).


##### `run_pre_sampling_compact`  (lines 796–816)

```
async fn run_pre_sampling_compact(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
) -> CodexResult<()>
```

**Purpose**: Performs any needed context compaction before the model is asked for a new response. This prevents sending a request that is likely to exceed the model’s context limit.

**Data flow**: It receives the session, turn context, and model client session. It first checks whether the previous model should compact the conversation, then checks the current token status. If the limit is reached, it runs automatic compaction; otherwise it leaves the conversation unchanged.

**Call relations**: run_turn calls this at the start of the turn. It uses maybe_run_previous_model_inline_compact, auto_compact_token_status, and run_auto_compact to make the pre-flight cleanup decision.

*Call graph*: calls 3 internal fn (auto_compact_token_status, maybe_run_previous_model_inline_compact, run_auto_compact); called by 1 (run_turn).


##### `comp_hash_changed`  (lines 820–824)

```
fn comp_hash_changed(previous: Option<&str>, current: Option<&str>) -> bool
```

**Purpose**: Compares two compaction compatibility hashes and says whether they both exist and differ. A compatibility hash is a small marker used to know whether old compacted context is still suitable for the current model or instructions.

**Data flow**: It receives an optional previous hash and optional current hash. If both are present, it compares them; if either is missing, it treats that as not enough information to trigger compaction. It returns a true-or-false answer.

**Call relations**: maybe_run_previous_model_inline_compact calls this while deciding whether a model or instruction change requires compaction before the new turn samples.

*Call graph*: called by 1 (maybe_run_previous_model_inline_compact).


##### `maybe_run_previous_model_inline_compact`  (lines 830–897)

```
async fn maybe_run_previous_model_inline_compact(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: &mut ModelClientSession,
) -> CodexResult<()>
```

**Purpose**: Decides whether to compact using the previous model’s settings before switching into the current turn’s model. This protects the conversation when model compatibility changed or when moving to a model with a smaller memory window.

**Data flow**: It reads the last turn’s model and compaction hash, compares them with the current turn, builds a previous-model turn context when needed, and checks token usage against old and new context windows. If a compatibility change or model downshift requires it, it runs auto-compaction. It returns success unless an attempted compaction fails.

**Call relations**: run_pre_sampling_compact calls it before checking the current turn’s token status. It calls comp_hash_changed and run_auto_compact when the conditions show cleanup is needed.

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

**Purpose**: Runs the actual automatic compaction job using the right backend. Compaction is the process of shrinking or summarizing conversation context so the model can keep going.

**Data flow**: It receives the session, turn context, model client session, where to inject initial context afterward, and analytics labels for reason and phase. It checks whether the provider supports remote compaction and whether the newer remote version is enabled, records a metric, then runs the selected local or remote compaction task. It returns an error only if the chosen compaction task fails.

**Call relations**: run_turn, run_pre_sampling_compact, and maybe_run_previous_model_inline_compact call this when token limits, model changes, or compatibility changes require compaction. It hands work off to local, remote, or remote-v2 compaction modules.

*Call graph*: calls 6 internal fn (turn_state, run_inline_auto_compact_task, should_use_remote_compact_task, run_inline_remote_auto_compact_task, run_inline_remote_auto_compact_task, emit_compact_metric); called by 3 (maybe_run_previous_model_inline_compact, run_pre_sampling_compact, run_turn); 1 external calls (clone).


##### `collect_explicit_app_ids_from_skill_items`  (lines 962–1011)

```
fn collect_explicit_app_ids_from_skill_items(
    skill_items: &[ResponseItem],
    connectors: &[connectors::AppInfo],
    skill_name_counts_lower: &HashMap<String, usize>,
) -> HashSet<String>
```

**Purpose**: Looks inside injected skill instructions for app/tool mentions and turns them into connector ids. This allows a skill that explicitly references an app to make that app available for the turn.

**Data flow**: It receives skill instruction response items, available connectors, and counts of skill names. It extracts text from skill messages, finds tool mentions and app paths, resolves unambiguous connector slugs, and returns the set of connector ids mentioned by the skills.

**Call relations**: build_skills_and_plugins calls this after creating skill items. Its output is merged with app ids mentioned directly by the user so the session can enable those connectors for the turn.

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

**Purpose**: Builds the final prompt object sent to the model. The prompt combines conversation input, tool descriptions, base instructions, personality, and any required output format.

**Data flow**: It receives response items, a tool router, the turn context, and base instructions. It asks the router for tools visible to the model, copies relevant model and output settings from the turn context, and returns a Prompt ready for the model client.

**Call relations**: run_sampling_request uses this for live turns, while prewarm and prompt-building paths can also call it. It sits between tool construction and the actual model streaming request.

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

**Purpose**: Runs one model sampling request, with retry support for temporary stream errors. A sampling request is one attempt to ask the model what to say or what tool to call next.

**Data flow**: It receives the session, turn context, extension store, diff tracker, model client session, metadata, input items, and cancellation signal. It builds the tools and prompt, calls try_run_sampling_request, and if a retryable error occurs it refreshes input from history and retries up to the provider’s limit. It returns the sampling result plus the original prompt input used for after-agent hooks.

**Call relations**: run_turn calls this inside its loop. It calls built_tools, build_prompt, try_run_sampling_request, and retry handling; errors or successful results flow back to run_turn’s decision loop.

*Call graph*: calls 5 internal fn (handle_retryable_response_stream_error, build_prompt, built_tools, try_run_sampling_request, new); called by 1 (run_turn); 3 external calls (clone, child_token, UsageLimitReached).


##### `built_tools`  (lines 1147–1246)

```
async fn built_tools(
    sess: &Session,
    turn_context: &TurnContext,
    cancellation_token: &CancellationToken,
) -> CodexResult<Arc<ToolRouter>>
```

**Purpose**: Builds the tool router for this turn, which is the object that decides what tools the model can see and how tool calls should be executed. It combines MCP tools, app connectors, plugin tools, extension tools, dynamic tools, and search/suggestion settings.

**Data flow**: It reads available MCP servers and tools, loaded plugins, app settings, authentication, connector accessibility, discoverable tool suggestions, and turn-specific dynamic tools. It filters and groups these into router parameters, then returns a ToolRouter wrapped for shared use.

**Call relations**: run_sampling_request calls this before making a prompt, and compaction/prewarm prompt paths also use it. It delegates connector merging, tool suggestion loading, MCP exposure decisions, and extension executor collection to other modules.

*Call graph*: calls 9 internal fn (merge_plugin_connectors_with_accessible, list_tool_suggest_discoverable_tools_with_auth, with_app_enabled_state, build_mcp_tool_exposure, apps_enabled, from_turn_context, extension_tool_executors, search_tool_enabled, tool_suggest_enabled); called by 5 (run_remote_compact_task_inner_impl, run_remote_compact_task_inner_impl, build_prompt_input_from_session, run_sampling_request, schedule_startup_prewarm_inner); 3 external calls (new, trace_span!, warn!).


##### `PlanModeStreamState::new`  (lines 1279–1286)

```
fn new(turn_id: &str) -> Self
```

**Purpose**: Creates temporary streaming state for a plan-mode response. Plan mode needs extra bookkeeping so proposed plans appear as plan items while normal assistant text still appears as chat text.

**Data flow**: It receives the turn id, creates empty maps and sets for pending assistant messages and buffered whitespace, and creates a ProposedPlanItemState with a plan item id derived from the turn id. It returns the initialized state.

**Call relations**: try_run_sampling_request creates this when the collaboration mode is Plan. The state is then passed through plan-mode streaming helpers until the response finishes.

*Call graph*: calls 1 internal fn (new); called by 1 (plan_mode_uses_contributed_turn_item_for_last_agent_message); 2 external calls (new, new).


##### `AssistantMessageStreamParsers::new`  (lines 1298–1303)

```
fn new(plan_mode: bool) -> Self
```

**Purpose**: Creates the parser collection used to process streamed assistant text. In plan mode, these parsers can separate plan markup from normal visible text.

**Data flow**: It receives a boolean saying whether plan mode is active. It stores that setting and starts with no per-item parsers. The result is ready to accept text for individual response item ids.

**Call relations**: try_run_sampling_request creates one for each sampling stream. Tests also call it directly to verify parsing behavior across streamed chunks.

*Call graph*: called by 4 (assistant_message_stream_parsers_can_be_seeded_from_output_item_added_text, assistant_message_stream_parsers_seed_buffered_prefix_stays_out_of_finish_tail, assistant_message_stream_parsers_seed_plan_parser_across_added_and_delta_boundaries, try_run_sampling_request); 1 external calls (new).


##### `AssistantMessageStreamParsers::parser_mut`  (lines 1305–1310)

```
fn parser_mut(&mut self, item_id: &str) -> &mut AssistantTextStreamParser
```

**Purpose**: Gets the parser for one assistant message item, creating it if this is the first text seen for that item. This keeps separate streamed messages from mixing their partial text.

**Data flow**: It receives an item id. It looks up that id in the parser map, creates a new AssistantTextStreamParser configured for plan mode if needed, and returns a mutable reference to it.

**Call relations**: seed_item_text and parse_delta call this whenever text arrives for an item. It is an internal helper for keeping parser state per streamed item.

*Call graph*: called by 2 (parse_delta, seed_item_text).


##### `AssistantMessageStreamParsers::seed_item_text`  (lines 1312–1317)

```
fn seed_item_text(&mut self, item_id: &str, text: &str) -> ParsedAssistantTextDelta
```

**Purpose**: Feeds initial text that was already present when an assistant item was announced. This handles models that include some text in the item-added event before later text deltas arrive.

**Data flow**: It receives an item id and text. If the text is empty it returns an empty parsed result; otherwise it pushes the text into that item’s parser and returns whatever visible text or plan segments can already be emitted.

**Call relations**: try_run_sampling_request uses this when OutputItemAdded includes assistant output text. It relies on parser_mut to find or create the item parser.

*Call graph*: calls 1 internal fn (parser_mut); 1 external calls (default).


##### `AssistantMessageStreamParsers::parse_delta`  (lines 1319–1321)

```
fn parse_delta(&mut self, item_id: &str, delta: &str) -> ParsedAssistantTextDelta
```

**Purpose**: Parses a new streamed text chunk for one assistant message item. It turns raw chunks into visible text and, in plan mode, proposed-plan segments.

**Data flow**: It receives an item id and a text delta. It pushes the delta into that item’s parser and returns the parsed result produced by the parser at this point.

**Call relations**: try_run_sampling_request calls this for OutputTextDelta events. It uses parser_mut so each item keeps its own streaming buffer.

*Call graph*: calls 1 internal fn (parser_mut).


##### `AssistantMessageStreamParsers::finish_item`  (lines 1323–1328)

```
fn finish_item(&mut self, item_id: &str) -> ParsedAssistantTextDelta
```

**Purpose**: Finishes parsing for one assistant message item and returns any text or plan data still buffered. This prevents partial line or tag parsing state from being lost when an item ends.

**Data flow**: It receives an item id, removes that item’s parser if it exists, and asks the parser to finish. If no parser exists, it returns an empty parsed result.

**Call relations**: flush_assistant_text_segments_for_item calls this when an assistant item completes. The flushed result is then emitted to the client.

*Call graph*: called by 1 (flush_assistant_text_segments_for_item); 1 external calls (default).


##### `AssistantMessageStreamParsers::drain_finished`  (lines 1330–1336)

```
fn drain_finished(&mut self) -> Vec<(String, ParsedAssistantTextDelta)>
```

**Purpose**: Finishes all remaining assistant text parsers at once. This is a safety flush at response completion or cleanup time.

**Data flow**: It takes the whole parser map, calls finish on every parser, and returns a list of item ids paired with their final parsed chunks. The parser collection is left empty afterward.

**Call relations**: flush_assistant_text_segments_all calls this when the model response completes or when the sampling function is cleaning up after an error or cancellation path.

*Call graph*: called by 1 (flush_assistant_text_segments_all); 1 external calls (take).


##### `ProposedPlanItemState::new`  (lines 1340–1346)

```
fn new(turn_id: &str) -> Self
```

**Purpose**: Creates the state for one proposed plan item in plan mode. The plan item gets a predictable id based on the turn id.

**Data flow**: It receives the turn id and builds an item id like “<turn>-plan”. It starts with flags showing the plan has not started and not completed, then returns the state.

**Call relations**: PlanModeStreamState::new uses this as part of initializing plan-mode streaming state.

*Call graph*: called by 1 (new); 1 external calls (format!).


##### `ProposedPlanItemState::start`  (lines 1348–1358)

```
async fn start(&mut self, sess: &Session, turn_context: &TurnContext)
```

**Purpose**: Emits the start event for the proposed plan item, but only once. This tells the client that a plan item now exists and may receive deltas.

**Data flow**: It reads whether the plan has already started or completed. If not, it marks it started, creates an empty Plan turn item, and sends an item-started event through the session.

**Call relations**: handle_plan_segments and maybe_complete_plan_item_from_message call this when streamed or finalized text reveals that a plan is present.

*Call graph*: 3 external calls (new, Plan, emit_turn_item_started).


##### `ProposedPlanItemState::push_delta`  (lines 1360–1375)

```
async fn push_delta(&mut self, sess: &Session, turn_context: &TurnContext, delta: &str)
```

**Purpose**: Sends a streamed piece of proposed-plan text to the client. This lets the user see the plan appear incrementally.

**Data flow**: It receives a text delta. If the plan is not completed and the delta is not empty, it wraps the delta with thread, turn, and item ids in a PlanDelta event and sends it through the session.

**Call relations**: handle_plan_segments calls this for ProposedPlanDelta segments produced by the assistant text parser.

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

**Purpose**: Finishes the proposed plan item with its final full text. This turns the streamed plan into a completed turn item.

**Data flow**: It receives final plan text. If the plan has started and not already completed, it marks it completed, builds a Plan item with the full text, and emits an item-completed event.

**Call relations**: maybe_complete_plan_item_from_message calls this after extracting the final plan from the completed assistant message.

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

**Purpose**: In plan mode, emits a delayed assistant-message start event when normal non-plan text really appears. This avoids showing empty assistant messages for responses that contained only a proposed plan.

**Data flow**: It receives the plan-mode state and item id. If the item has not already started and a pending start item exists, it removes that pending item, emits its started event, and remembers that it was started.

**Call relations**: handle_plan_segments calls it before sending normal assistant text deltas, and emit_agent_message_in_plan_mode calls it before completing an assistant message.

*Call graph*: called by 2 (emit_agent_message_in_plan_mode, handle_plan_segments); 1 external calls (emit_turn_item_started).


##### `agent_message_text`  (lines 1416–1423)

```
fn agent_message_text(item: &codex_protocol::items::AgentMessageItem) -> String
```

**Purpose**: Extracts the plain text from an agent-message turn item. Agent messages are text-only here, so this concatenates all text entries.

**Data flow**: It receives an AgentMessageItem, reads each text content entry, joins the text in order, and returns the combined string. It does not change the item.

**Call relations**: emit_agent_message_in_plan_mode uses it to decide whether the message is empty, and realtime_text_for_event uses it when mirroring completed assistant messages to realtime output.

*Call graph*: called by 2 (emit_agent_message_in_plan_mode, realtime_text_for_event).


##### `realtime_text_for_event`  (lines 1425–1507)

```
fn realtime_text_for_event(msg: &EventMsg) -> Option<String>
```

**Purpose**: Pulls user-visible assistant text out of events that should be mirrored to realtime audio or realtime display. It ignores events that are not assistant text.

**Data flow**: It receives an EventMsg. If the event is an assistant message delta, it returns the delta text; if it is a completed agent-message item, it returns that message’s text; otherwise it returns nothing.

**Call relations**: maybe_mirror_event_text_to_realtime calls this as a filter. It uses agent_message_text for completed agent-message items.

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

**Purpose**: Routes parsed plan-mode text segments to the correct client events. Normal text becomes assistant-message deltas, while proposed-plan text becomes plan item starts and plan deltas.

**Data flow**: It receives parsed ProposedPlanSegment values for one item. It buffers leading whitespace until real text appears, starts pending assistant messages when needed, sends normal text deltas, starts the plan item, and sends plan deltas. It updates plan-mode state as it goes.

**Call relations**: emit_streamed_assistant_text_delta calls this whenever the parser produces plan segments. It calls maybe_emit_pending_agent_message_start and ProposedPlanItemState methods indirectly through state.

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

**Purpose**: Turns parsed assistant text into client-facing stream events. It is the bridge between raw parser output and what the UI receives.

**Data flow**: It receives parsed text for one item. If there are citations, it strips them from display handling for now; in plan mode it sends plan segments to handle_plan_segments, otherwise it sends visible assistant text as an AgentMessageContentDelta event. Empty parsed output produces no event.

**Call relations**: try_run_sampling_request calls it for seeded and streamed assistant text, and the flush helpers call it when parser buffers need to be emptied.

*Call graph*: calls 1 internal fn (handle_plan_segments); called by 3 (flush_assistant_text_segments_all, flush_assistant_text_segments_for_item, try_run_sampling_request); 3 external calls (is_empty, send_event, AgentMessageContentDelta).


##### `flush_assistant_text_segments_for_item`  (lines 1610–1619)

```
async fn flush_assistant_text_segments_for_item(
    sess: &Session,
    turn_context: &TurnContext,
    plan_mode_state: Option<&mut PlanModeStreamState>,
    parsers: &mut AssistantMessageStreamPars
```

**Purpose**: Flushes any buffered parsed assistant text for one item when that item ends. This ensures no final text fragment is left hidden in the parser.

**Data flow**: It receives parsers, optional plan-mode state, and an item id. It finishes that item’s parser, then emits the resulting parsed text or plan segments. The item’s parser state is removed.

**Call relations**: try_run_sampling_request calls this when an active streamed assistant message item completes. It uses AssistantMessageStreamParsers::finish_item and emit_streamed_assistant_text_delta.

*Call graph*: calls 2 internal fn (finish_item, emit_streamed_assistant_text_delta); called by 1 (try_run_sampling_request).


##### `flush_assistant_text_segments_all`  (lines 1622–1638)

```
async fn flush_assistant_text_segments_all(
    sess: &Session,
    turn_context: &TurnContext,
    mut plan_mode_state: Option<&mut PlanModeStreamState>,
    parsers: &mut AssistantMessageStreamParse
```

**Purpose**: Flushes buffered assistant text for every still-open parsed item. This is used at response completion and cleanup so parser state cannot leak across responses.

**Data flow**: It drains all parsers, then for each item id and parsed chunk emits the remaining visible text or plan segments. Afterward, no parser state remains in the collection.

**Call relations**: try_run_sampling_request calls this when the stream completes and again during cleanup. It uses AssistantMessageStreamParsers::drain_finished and emit_streamed_assistant_text_delta.

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

**Purpose**: Completes the plan item by extracting the final proposed-plan text from the finished assistant message. Streaming deltas show progress, but this records the final authoritative plan text.

**Data flow**: It checks whether the response item is an assistant message, concatenates its final output text, extracts the proposed-plan section, strips citations from that plan text, starts the plan item if needed, and completes it with the final text. If no plan text is found, it does nothing.

**Call relations**: handle_assistant_item_done_in_plan_mode calls this before finalizing the assistant item. It uses parser utilities from the stream parser crate to locate and clean the plan text.

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

**Purpose**: Emits a completed assistant message while respecting plan-mode delayed starts. It avoids showing empty chat messages when the response only contained plan content.

**Data flow**: It receives an AgentMessageItem, extracts its text, and if the text is blank removes pending state and stops. Otherwise it ensures the item has a started event, emits the completed agent-message item, and clears started tracking for that id.

**Call relations**: emit_turn_item_in_plan_mode calls this for agent messages. It uses agent_message_text and maybe_emit_pending_agent_message_start to coordinate with plan-mode streaming state.

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

**Purpose**: Emits a completed turn item in plan mode, with special rules for assistant messages. Non-message items are started if necessary and then completed normally.

**Data flow**: It receives a completed TurnItem plus an optional previously active streamed item. Agent messages are delegated to emit_agent_message_in_plan_mode; other items get a start event if they were not already active, then a completion event.

**Call relations**: handle_assistant_item_done_in_plan_mode calls this after finalizing a response item into a turn item. It keeps plan-mode event ordering correct for the client.

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

**Purpose**: Handles finalization of a completed assistant response item when plan mode is active. It separates final plan completion from final assistant-message completion and records the item in history.

**Data flow**: It receives the completed response item, plan-mode state, prior active item, and a mutable last-message slot. For assistant messages, it completes any plan item, runs normal finalization with contributors, emits the final turn item using plan-mode rules, records completed facts in conversation history, and updates the last assistant message if available. It returns true when it handled the item.

**Call relations**: try_run_sampling_request calls this from the OutputItemDone path when plan mode is active. It uses maybe_complete_plan_item_from_message, finalize_non_tool_response_item, emit_turn_item_in_plan_mode, and record_completed_response_item_with_finalized_facts.

*Call graph*: calls 4 internal fn (emit_turn_item_in_plan_mode, maybe_complete_plan_item_from_message, finalize_non_tool_response_item, record_completed_response_item_with_finalized_facts); called by 1 (try_run_sampling_request); 1 external calls (Run).


##### `drain_in_flight`  (lines 1788–1812)

```
async fn drain_in_flight(
    in_flight: &mut FuturesOrdered<BoxFuture<'static, CodexResult<ResponseInputItem>>>,
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()>
```

**Purpose**: Waits for tool calls that are still running and records their outputs into the conversation. This ensures the next model request can see what the tools returned.

**Data flow**: It receives an ordered queue of tool futures plus the session and turn context. For each completed future, it converts the tool output into a response item, records it in conversation history, and marks memory mode as polluted if the output came from external context. Failed tool futures are treated as internal errors.

**Call relations**: try_run_sampling_request calls this after the model stream ends or exits. It drains tool work started by handle_output_item_done before token counts and turn diffs are emitted.

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

**Purpose**: Processes one live streaming response from the model. It is the detailed event loop that turns model stream events into session history, tool calls, UI events, token updates, and a follow-up decision.

**Data flow**: It receives prepared tool runtime, session, turn context, extension store, model client session, metadata, diff tracker, prompt, and cancellation token. It opens the model stream, reads events one by one, emits text/reasoning/tool/plan events, starts tool futures, records completed items, tracks token usage and timing, drains pending tools, emits token counts and diffs, and returns whether another model request is needed plus the last assistant message.

**Call relations**: run_sampling_request calls this and wraps it with retries. This function calls many lower-level helpers, including drain_in_flight, handle_non_tool_response_item, handle_output_item_done, assistant text flush/emit helpers, and plan-mode item handlers.

*Call graph*: calls 14 internal fn (stream, new, drain_in_flight, emit_streamed_assistant_text_delta, flush_assistant_text_segments_all, flush_assistant_text_segments_for_item, handle_assistant_item_done_in_plan_mode, handle_non_tool_response_item, handle_output_item_done, raw_assistant_output_text_from_item (+4 more)); called by 1 (run_sampling_request); 16 external calls (clone, child_token, is_cancelled, new, lock, clone, feedback_tags!, matches!, Stream, AgentMessageContentDelta (+6 more)).


##### `get_last_assistant_message_from_turn`  (lines 2304–2311)

```
fn get_last_assistant_message_from_turn(responses: &[ResponseItem]) -> Option<String>
```

**Purpose**: Finds the most recent assistant message text in a list of response items. This is useful when another subsystem needs the final assistant wording from an already-recorded turn.

**Data flow**: It receives response items, scans them from newest to oldest, asks each item whether it contains an assistant message, and returns the first message text found. If none exists, it returns nothing.

**Call relations**: The compaction flow calls this when it needs the last assistant message from turn items. It delegates item-specific extraction to last_assistant_message_from_item.

*Call graph*: calls 1 internal fn (last_assistant_message_from_item); called by 1 (run_compact_task_inner_impl); 1 external calls (iter).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-auth-identity` — The signed-in user or service identity, including account facts such as email, plan, workspace, and login mode.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-rate-limit-quota` — The current account limits, credit status, token usage, and reset information used to avoid overusing backend services.
- `reg-rollout-thread-store` — The durable conversation log and searchable thread index used to resume, rebuild, archive, restore, and display sessions.
- `reg-model-provider-catalog` — The combined menu of usable model providers and models from bundled data, cache, live services, local servers, and account access.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-tls-crypto-provider` — The one process-wide cryptography provider chosen early so HTTPS and other TLS connections use the same security engine.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-conversation-history-budget` — The accumulated messages, compacted summaries, token counts, and trimming decisions that determine what conversation context still fits.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-tui-visible-state` — The current terminal user-interface state, including visible transcript cells, inputs, popups, keymaps, headers, status lines, notifications, and restored history.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-code-mode-runtime-state` — The live code-mode execution sessions, V8 isolates, loaded modules, pending calls, timers, and shutdown state for JavaScript/code-cell execution.
- `reg-realtime-stream-state` — Active realtime conversation state, including audio/text stream sessions, WebSocket transport state, buffers, and stop/cancel lifecycle data.
- `reg-attestation-state` — Client or host attestation provider state and generated proof metadata used to attach optional attestation headers to upstream requests.
- `reg-process-hardening-state` — Process-wide hardening status and OS security settings applied at bootstrap, such as dump/inspection/tamper restrictions that affect the rest of the run.
- `reg-local-model-runtime-state` — Live readiness, endpoint, health, and launch/connect status for local model backends such as Ollama, LM Studio, and OSS helpers, separate from the model catalog itself.
