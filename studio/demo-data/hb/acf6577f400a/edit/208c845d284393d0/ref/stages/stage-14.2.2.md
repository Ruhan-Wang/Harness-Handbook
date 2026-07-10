# Unified-exec sessions and PTY/process backends  `stage-14.2.2`

This stage is the engine room for interactive command sessions. It sits in the system’s main work path whenever the app starts a command, talks to it while it runs, and shuts it down cleanly. Its job is to make many kinds of processes look the same to the rest of the code, whether they run locally, through a remote exec server, in a normal pipe connection, or in a PTY, a pseudo terminal that behaves like a real terminal window.

At the center, the unified-exec module defines the shared request, state, and error types. The process wrapper tracks one running command: its output, exit status, cancellation, and failures. Above that, the process manager is the traffic controller. It assigns IDs, launches commands through the shared spawn routine, stores live processes, forwards input, polls output, and cleans up.

The write_stdin tool is the doorway for sending keystrokes or input into an interactive session. On the exec-server side, common process traits define the contract, while local and remote backends either run the command directly or control it over RPC, a remote procedure call. The PTY library supplies the actual Unix and Windows terminal or pipe implementations, plus process-group helpers so whole process trees can be stopped reliably.

## Files in this stage

### Unified-exec orchestration
These files define the unified-exec module surface, error model, per-process wrapper, manager, and stdin-writing tool that drive interactive session lifecycle from the core layer.

### `core/src/unified_exec/mod.rs`

`orchestration` · `cross-cutting setup and shared unified-exec definitions`

This module is the root of the unified exec subsystem. Beyond the high-level design comments, it declares the internal submodules (`async_watcher`, `errors`, `head_tail_buffer`, `process`, `process_manager`, `process_state`) and re-exports the key types that other parts of the crate use, including `UnifiedExecError`, `UnifiedExecProcess`, and spawn lifecycle abstractions. It also defines the subsystem-wide constants that shape behavior: yield-time bounds, Windows-specific minimum startup yield, default background timeout, output token defaults, transcript byte cap, and maximum number of tracked processes.

The file introduces several core data structures. `UnifiedExecContext` bundles the `Arc<Session>`, `Arc<TurnContext>`, and tool `call_id` needed by async watchers and event emitters. `ExecCommandRequest` and `WriteStdinRequest` capture the full parameter sets for starting a command and writing to an existing process, including cwd, shell mode, sandbox permissions, network settings, truncation policy, and optional permission metadata. `ProcessStore` is the in-memory registry of active processes plus reserved ids, and `UnifiedExecProcessManager` wraps that store in a Tokio `Mutex` while enforcing a minimum write-stdin yield timeout.

The remaining helpers are small but important: `clamp_yield_time` normalizes requested wait times into platform-aware bounds, `resolve_max_tokens` applies the default output-token limit, and `generate_chunk_id` creates a six-hex-digit identifier for output chunks. This file itself contains little orchestration logic, but it defines the shared types and invariants that the process manager and watchers build on.

#### Function details

##### `set_deterministic_process_ids_for_tests`  (lines 53–55)

```
fn set_deterministic_process_ids_for_tests(enabled: bool)
```

**Purpose**: Forwards a test-only toggle into the process-manager implementation so process id allocation becomes deterministic. It exists to make integration tests stable and reproducible.

**Data flow**: Accepts a boolean `enabled` flag and passes it directly to `process_manager::set_deterministic_process_ids_for_tests`, returning `()` and mutating only the allocator behavior maintained in that submodule.

**Call relations**: It is called by higher-level test setup via `set_deterministic_process_ids`. This wrapper keeps the module root as the public entry point while delegating the actual implementation to `process_manager`.

*Call graph*: calls 1 internal fn (set_deterministic_process_ids_for_tests); called by 1 (set_deterministic_process_ids).


##### `UnifiedExecContext::new`  (lines 82–88)

```
fn new(session: Arc<Session>, turn: Arc<TurnContext>, call_id: String) -> Self
```

**Purpose**: Constructs the lightweight context object shared by unified-exec eventing code. It packages the session, turn, and call id needed to emit process-related events.

**Data flow**: Consumes `Arc<Session>`, `Arc<TurnContext>`, and a `String` call id, then returns `UnifiedExecContext { session, turn, call_id }` with no side effects.

**Call relations**: It is used by call-handling and exec startup paths such as `handle_call`, `exec_command_with_tty`, and a fallback-output test helper. Downstream async watcher code reads these fields when sending output and terminal events.

*Call graph*: called by 3 (handle_call, exec_command_with_tty, failed_initial_end_for_unstored_process_uses_fallback_output).


##### `ProcessStore::remove`  (lines 128–131)

```
fn remove(&mut self, process_id: i32) -> Option<ProcessEntry>
```

**Purpose**: Removes a process entry and clears its reservation in one operation. It keeps the active-process map and reserved-id set in sync.

**Data flow**: Takes `&mut self` and a numeric `process_id`, removes that id from `reserved_process_ids`, removes and returns any matching `ProcessEntry` from `processes`, and leaves the store mutated accordingly.

**Call relations**: It is called by `prune_processes_if_needed` when old or excess processes are being evicted. The method encapsulates the invariant that deleting a process also frees its reserved id.

*Call graph*: called by 1 (prune_processes_if_needed).


##### `UnifiedExecProcessManager::new`  (lines 140–146)

```
fn new(max_write_stdin_yield_time_ms: u64) -> Self
```

**Purpose**: Creates a process manager with an empty store and a normalized maximum stdin-yield timeout. It enforces that write-stdin polling never uses a timeout below the subsystem’s empty-input minimum.

**Data flow**: Accepts `max_write_stdin_yield_time_ms`, initializes `process_store` with `ProcessStore::default()`, computes `max_write_stdin_yield_time_ms.max(MIN_EMPTY_YIELD_TIME_MS)`, and returns the populated manager.

**Call relations**: It is called by the manager’s `Default` impl and by session/test setup helpers. The constructor establishes the manager-wide timeout bound that later write-stdin operations rely on.

*Call graph*: called by 3 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 2 external calls (new, default).


##### `UnifiedExecProcessManager::default`  (lines 150–152)

```
fn default() -> Self
```

**Purpose**: Builds a process manager using the standard background terminal timeout constant. It is the normal constructor for production and many tests.

**Data flow**: Takes no arguments and returns `Self::new(DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS)`.

**Call relations**: It is used by multiple tests and runtime setup paths that do not need a custom stdin-yield cap. The implementation simply delegates to `new`.

*Call graph*: called by 7 (unified_exec_uses_the_trusted_sandbox_cwd, zsh_fork_execpolicy_allow_preserves_parent_sandbox_override, zsh_fork_first_attempt_preserves_additional_permissions_request, zsh_fork_first_attempt_preserves_parent_sandbox_override, completed_pipe_commands_preserve_exit_code, remote_exec_server_rejects_inherited_fd_launches, unified_exec_uses_remote_exec_server_when_configured); 1 external calls (new).


##### `clamp_yield_time`  (lines 168–175)

```
fn clamp_yield_time(yield_time_ms: u64) -> u64
```

**Purpose**: Normalizes an initial exec yield timeout into platform-aware minimum and maximum bounds. On Windows it applies an additional startup floor before clamping.

**Data flow**: Accepts `yield_time_ms`, conditionally raises it to at least `WINDOWS_INITIAL_EXEC_YIELD_TIME_FLOOR_MS` when `cfg!(windows)` is true, then clamps the result into `[MIN_YIELD_TIME_MS, MAX_YIELD_TIME_MS]` and returns the bounded `u64`.

**Call relations**: It is called by `exec_command` before waiting for initial process output. This helper centralizes timeout policy so callers do not duplicate platform-specific rules.

*Call graph*: called by 1 (exec_command); 1 external calls (cfg!).


##### `resolve_max_tokens`  (lines 177–179)

```
fn resolve_max_tokens(max_tokens: Option<usize>) -> usize
```

**Purpose**: Applies the default output-token limit when a caller does not specify one. It keeps token-budget handling consistent across exec paths.

**Data flow**: Takes `Option<usize>` and returns the contained value or `DEFAULT_MAX_OUTPUT_TOKENS` if `None`.

**Call relations**: It is used by output truncation logic such as `truncate_code_mode_result` and `model_output_max_tokens`. The helper isolates the defaulting rule from those consumers.

*Call graph*: called by 2 (truncate_code_mode_result, model_output_max_tokens).


##### `generate_chunk_id`  (lines 181–186)

```
fn generate_chunk_id() -> String
```

**Purpose**: Generates a short random hexadecimal identifier for an output chunk or exec response. The id is six hex digits long.

**Data flow**: Creates a thread-local RNG with `rng()`, iterates six times, formats each random nibble from `0..16` as lowercase hex, collects the pieces into a `String`, and returns it.

**Call relations**: It is called by `handle_call`, `exec_command`, and `write_stdin` when constructing tool outputs or chunk metadata. The helper provides lightweight unique-ish ids without involving external state.

*Call graph*: called by 3 (handle_call, exec_command, write_stdin); 1 external calls (rng).


### `core/src/unified_exec/errors.rs`

`data_model` · `cross-cutting error propagation`

This file is the central error model for the unified exec subsystem. `UnifiedExecError` is a `thiserror::Error` enum with human-readable messages tailored to the API surface exposed by interactive process execution. Several variants carry structured data: `CreateProcess { message }` and `ProcessFailed { message }` preserve backend failure text; `UnknownProcessId { process_id }` reports stale or invalid process references using the externally visible numeric id; and `SandboxDenied { message, output }` bundles both the denial explanation and a full `ExecToolCallOutput` snapshot so callers can surface the blocked command’s output context. Other variants represent fixed conditions such as failed stdin writes, closed stdin on non-TTY sessions, and missing command lines.

The impl block adds small constructor helpers for the variants most frequently synthesized by orchestration code. These helpers do not add logic beyond wrapping arguments into the corresponding enum variant, but they standardize call sites and make intent explicit where process startup, runtime execution, or sandbox checks fail. The file is intentionally minimal: it defines the error vocabulary used across process creation, command execution, stdin writes, and sandbox policy enforcement, while leaving all control flow to higher-level modules.

#### Function details

##### `UnifiedExecError::create_process`  (lines 29–31)

```
fn create_process(message: String) -> Self
```

**Purpose**: Constructs the `CreateProcess` variant from a backend error message. It is the canonical wrapper for failures that occur before a unified exec session is successfully started.

**Data flow**: Takes an owned `String` message and returns `Self::CreateProcess { message }` without side effects or mutation.

**Call relations**: It is called by `open_session_with_exec_env` when process startup fails. The helper keeps startup-error construction concise and consistent at that orchestration boundary.

*Call graph*: called by 1 (open_session_with_exec_env).


##### `UnifiedExecError::process_failed`  (lines 33–35)

```
fn process_failed(message: String) -> Self
```

**Purpose**: Constructs the `ProcessFailed` variant for runtime execution failures after a process exists or during command interaction. It distinguishes operational failure from startup failure.

**Data flow**: Consumes an owned `String` message and returns `Self::ProcessFailed { message }`, producing no external output.

**Call relations**: It is used by `write`, `exec_command`, `write_stdin`, and `fail_process_with_message` when an existing process reports failure or command interaction cannot complete normally. Those callers use it to propagate a uniform runtime-failure category upward.

*Call graph*: called by 4 (write, exec_command, write_stdin, fail_process_with_message).


##### `UnifiedExecError::sandbox_denied`  (lines 37–39)

```
fn sandbox_denied(message: String, output: ExecToolCallOutput) -> Self
```

**Purpose**: Constructs the `SandboxDenied` variant with both a denial message and captured exec output. It preserves enough context for callers to report why sandboxed execution was blocked.

**Data flow**: Accepts a denial `message: String` and an `ExecToolCallOutput`, then returns `Self::SandboxDenied { message, output }`.

**Call relations**: It is called by `check_for_sandbox_denial_with_text` after sandbox-denial heuristics identify a blocked command. The helper packages the denial details into the subsystem’s shared error type.

*Call graph*: called by 1 (check_for_sandbox_denial_with_text).


### `core/src/unified_exec/process.rs`

`domain_logic` · `process lifetime: spawn, output streaming/polling, exit detection, termination`

This file is the per-process core of unified exec. Its main abstraction, `UnifiedExecProcess`, wraps either a local `ExecCommandSession` or a remote `Arc<dyn ExecProcess>` inside `ProcessHandle`, then layers shared state on top: a `HeadTailBuffer` guarded by `tokio::sync::Mutex` for accumulated output, a `broadcast::Sender<Vec<u8>>` for live subscribers, `Notify` objects for output arrival and closure, a `CancellationToken` used as the process-exit signal, and a `watch` channel carrying `ProcessState` (`has_exited`, `exit_code`, optional failure message). The optional `_spawn_lifecycle` keeps launch-time resources alive until after spawn.

Construction differs by transport. `from_spawned` wires local stdout/stderr receivers into a background task, checks for immediate or very early exit via `exit_rx`, and otherwise spawns a waiter that updates state when the child exits. `from_exec_server_started` starts a polling task that repeatedly calls `ExecProcess::read`, appends chunks into the shared buffer, broadcasts them, records remote failures/exits, and waits on the exec-server wake channel between polls. Both constructors apply an early-exit grace period so callers can observe short-lived failures synchronously.

Operational methods expose stdin writes, interrupt/terminate behavior, output handles for polling/streaming, and sandbox-denial detection. Sandbox denial is only checked once the process has exited and sandboxing is enabled; it reconstructs an `ExecToolCallOutput` from aggregated text and uses `is_likely_sandbox_denied`, truncating the surfaced message with `formatted_truncate_text`. Termination always closes output state, cancels waiters, and aborts the output task. `Drop` defensively terminates the process so leaked handles do not leave background children running.

#### Function details

##### `SpawnLifecycle::inherited_fds`  (lines 42–44)

```
fn inherited_fds(&self) -> Vec<i32>
```

**Purpose**: Provides the list of raw file descriptors that must remain open across child `exec()` during process launch. The default implementation returns no descriptors.

**Data flow**: Reads no state and takes only `&self` → constructs an empty `Vec<i32>` by default → returns that vector to the spawn path.

**Call relations**: Called by process-launch orchestration before spawning a local process so launch code can pass inherited descriptors into PTY/pipe spawn helpers. Implementors override it when a specific launch sequence needs parent-owned FDs preserved until `after_spawn()`.

*Call graph*: 1 external calls (new).


##### `SpawnLifecycle::after_spawn`  (lines 46–46)

```
fn after_spawn(&mut self)
```

**Purpose**: Runs post-spawn cleanup or release logic once the child process has been created. The default implementation is a no-op.

**Data flow**: Takes `&mut self`, reads no external state, performs no transformation by default, and returns unit.

**Call relations**: Invoked by the process manager immediately after successful local or remote spawn so custom lifecycle implementations can release temporary resources that had to survive until the child existed.


##### `UnifiedExecProcess::fmt`  (lines 92–98)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats a debug view of the process that reports whether it has exited, its exit code, and the sandbox type without exposing all internal synchronization fields.

**Data flow**: Reads derived state through `has_exited()` and `exit_code()` plus the stored `sandbox_type` → builds a `DebugStruct` named `UnifiedExecProcess` → writes formatted output into the provided formatter.

**Call relations**: Used by Rust debug formatting; it delegates to the process-state accessors so the debug output reflects live state rather than raw internal fields.

*Call graph*: calls 2 internal fn (exit_code, has_exited); 1 external calls (debug_struct).


##### `UnifiedExecProcess::new`  (lines 102–131)

```
fn new(
        process_handle: ProcessHandle,
        sandbox_type: SandboxType,
        spawn_lifecycle: Option<SpawnLifecycleHandle>,
    ) -> Self
```

**Purpose**: Initializes a fresh unified process wrapper around an already-created transport-specific process handle. It allocates all shared output, notification, cancellation, and state-tracking primitives in their default empty state.

**Data flow**: Consumes a `ProcessHandle`, `SandboxType`, and optional `SpawnLifecycleHandle` → creates a default `HeadTailBuffer`, `Notify` instances, `AtomicBool(false)` for output closure, a new `CancellationToken`, a broadcast channel for output chunks, and a watch channel seeded with `ProcessState::default()` → returns a `UnifiedExecProcess` with no output task yet attached.

**Call relations**: Used internally by both `from_spawned` and `from_exec_server_started` as the common constructor before those paths attach transport-specific output tasks and exit watchers.

*Call graph*: calls 1 internal fn (default); 8 external calls (new, new, new, new, new, channel, default, channel).


##### `UnifiedExecProcess::write`  (lines 133–156)

```
async fn write(&self, data: &[u8]) -> Result<(), UnifiedExecError>
```

**Purpose**: Writes bytes to the process stdin using the appropriate transport and normalizes transport-specific write failures into unified-exec errors and state transitions.

**Data flow**: Takes a byte slice. For `Local`, clones the bytes into a `Vec<u8>` and sends them through `writer_sender()`, mapping send failure to `UnifiedExecError::WriteToStdin`. For `ExecServer`, awaits `process_handle.write`; `Accepted` returns `Ok(())`, `UnknownProcess` or `StdinClosed` mark the watched `ProcessState` exited, cancel the token, and return `WriteToStdin`, `Starting` also returns `WriteToStdin`, and transport errors become `UnifiedExecError::process_failed(err.to_string())`.

**Call relations**: Called from `write_stdin` when interactive input is sent to a TTY-backed process. On remote write statuses that imply the process is gone or stdin is unavailable, it proactively updates local state so later polling sees the process as exited.

*Call graph*: calls 1 internal fn (process_failed); 3 external calls (cancel, send_replace, borrow).


##### `UnifiedExecProcess::output_handles`  (lines 158–166)

```
fn output_handles(&self) -> OutputHandles
```

**Purpose**: Packages the shared output buffer and synchronization primitives into a lightweight struct for polling consumers.

**Data flow**: Reads the process’s `Arc`-wrapped output fields and cancellation token → clones the shared handles → returns an `OutputHandles` struct containing them.

**Call relations**: Used by higher-level polling and startup code that needs coordinated access to buffered output, output notifications, closure notifications, and the exit cancellation token without exposing the whole process object.

*Call graph*: 2 external calls (clone, clone).


##### `UnifiedExecProcess::output_receiver`  (lines 168–170)

```
fn output_receiver(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>>
```

**Purpose**: Creates a new broadcast subscription for live output chunks emitted by the process.

**Data flow**: Reads `self.output_tx` → calls `subscribe()` → returns a `broadcast::Receiver<Vec<u8>>` positioned for future chunks.

**Call relations**: Called by `start_streaming_output` to attach event-streaming consumers that should receive output incrementally as the background output task forwards chunks.

*Call graph*: called by 1 (start_streaming_output); 1 external calls (subscribe).


##### `UnifiedExecProcess::cancellation_token`  (lines 172–174)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: Exposes a clone of the process cancellation token used to signal exit or forced termination.

**Data flow**: Reads `self.cancellation_token` → clones it → returns the clone.

**Call relations**: Used by `start_streaming_output` and other waiters that need a transport-independent signal that the process has exited or been terminated.

*Call graph*: called by 1 (start_streaming_output); 1 external calls (clone).


##### `UnifiedExecProcess::output_drained_notify`  (lines 176–178)

```
fn output_drained_notify(&self) -> Arc<Notify>
```

**Purpose**: Returns the notification object used by external streaming logic to observe when output has been drained.

**Data flow**: Reads `self.output_drained` → clones the `Arc<Notify>` → returns it.

**Call relations**: Consumed by `start_streaming_output`, which coordinates event emission with output-drain signaling outside this file.

*Call graph*: called by 1 (start_streaming_output); 1 external calls (clone).


##### `UnifiedExecProcess::has_exited`  (lines 180–186)

```
fn has_exited(&self) -> bool
```

**Purpose**: Reports whether the process should be considered exited, combining watched state with direct local-session inspection when available.

**Data flow**: Reads the current `ProcessState` from `state_rx`. For `Local`, returns `state.has_exited || process_handle.has_exited()`. For `ExecServer`, returns only `state.has_exited` because remote liveness is tracked through the watch state.

**Call relations**: Queried by sandbox-denial checks, debug formatting, and higher-level process management to decide whether a process is still live. The local branch intentionally trusts either source so direct PTY exit observation is not missed.

*Call graph*: called by 2 (check_for_sandbox_denial_with_text, fmt); 1 external calls (borrow).


##### `UnifiedExecProcess::exit_code`  (lines 188–196)

```
fn exit_code(&self) -> Option<i32>
```

**Purpose**: Returns the best-known exit code for the process, preferring watched state but falling back to direct local-session inspection when necessary.

**Data flow**: Reads the current `ProcessState` from `state_rx`. For `Local`, returns `state.exit_code.or_else(|| process_handle.exit_code())`. For `ExecServer`, returns `state.exit_code`.

**Call relations**: Used by sandbox-denial detection, debug formatting, and confirmed termination to surface the final exit status consistently across transports.

*Call graph*: called by 3 (check_for_sandbox_denial_with_text, fmt, terminate_confirmed); 1 external calls (borrow).


##### `UnifiedExecProcess::finish_termination`  (lines 198–205)

```
fn finish_termination(&self)
```

**Purpose**: Performs the common local cleanup after any termination path by marking output closed, waking waiters, cancelling the process token, and aborting the output task.

**Data flow**: Writes `true` into `output_closed`, notifies `output_closed_notify`, cancels `cancellation_token`, and if `output_task` exists aborts that task. It returns unit.

**Call relations**: Shared by both `terminate` and `terminate_confirmed` so all termination paths leave output consumers and pollers in a consistent closed state.

*Call graph*: called by 2 (terminate, terminate_confirmed); 1 external calls (cancel).


##### `UnifiedExecProcess::terminate`  (lines 207–218)

```
fn terminate(&self)
```

**Purpose**: Initiates best-effort process termination without waiting for remote confirmation, then immediately tears down local output state.

**Data flow**: For `Local`, calls `process_handle.terminate()`. For `ExecServer`, clones the remote handle and spawns an async task that awaits `terminate()` but ignores its result. Then calls `finish_termination()` to close output and cancel waiters.

**Call relations**: Used from `Drop`, `fail_and_terminate`, and manager-level failure handling when the system wants prompt shutdown even if remote termination acknowledgement is unavailable.

*Call graph*: calls 1 internal fn (finish_termination); called by 3 (drop, fail_and_terminate, fail_process_with_message); 2 external calls (clone, spawn).


##### `UnifiedExecProcess::terminate_confirmed`  (lines 220–233)

```
async fn terminate_confirmed(&self) -> Result<(), UnifiedExecError>
```

**Purpose**: Terminates the process and only updates local exit state if the underlying termination request succeeds.

**Data flow**: For `Local`, invokes `terminate()`. For `ExecServer`, awaits `terminate()` and maps transport errors into `UnifiedExecError::process_failed`. On success, calls `signal_exit(self.exit_code())`, then `finish_termination()`, and returns `Ok(())`.

**Call relations**: Used by manager-level explicit termination requests that need a reliable success/failure result. Unlike `terminate`, it does not mark the process exited if remote termination itself fails.

*Call graph*: calls 3 internal fn (exit_code, finish_termination, signal_exit).


##### `UnifiedExecProcess::interrupt`  (lines 235–245)

```
async fn interrupt(&self) -> Result<(), UnifiedExecError>
```

**Purpose**: Sends an interrupt signal to the running process using the transport-specific signal type.

**Data flow**: Reads `process_handle`; for local PTY sessions sends `PtyProcessSignal::Interrupt`, for exec-server processes awaits `ExecServerProcessSignal::Interrupt`. Any signaling error is converted into `UnifiedExecError::process_failed(err.to_string())`.

**Call relations**: Called from `write_stdin` when a non-TTY process receives the special interrupt control character instead of ordinary stdin bytes.


##### `UnifiedExecProcess::fail_and_terminate`  (lines 247–253)

```
fn fail_and_terminate(&self, message: String)
```

**Purpose**: Records a failure message exactly once and then terminates the process.

**Data flow**: Reads current `ProcessState` from `state_rx`; if `failure_message` is absent, writes a new failed state via `state.failed(message)`. Then calls `terminate()` regardless. Returns unit.

**Call relations**: Used by manager-side failure paths such as network denial handling. The one-time write preserves the first failure cause even if later code attempts to fail the process again.

*Call graph*: calls 1 internal fn (terminate); called by 1 (fail_process_with_message); 2 external calls (send_replace, borrow).


##### `UnifiedExecProcess::snapshot_output`  (lines 255–258)

```
async fn snapshot_output(&self) -> Vec<Vec<u8>>
```

**Purpose**: Captures the current buffered output chunks without draining them.

**Data flow**: Locks `output_buffer`, reads its chunk snapshot via `snapshot_chunks()`, and returns `Vec<Vec<u8>>` containing the buffered chunks.

**Call relations**: Used by `check_for_sandbox_denial` to inspect all accumulated output text while leaving the buffer intact for other consumers.

*Call graph*: called by 1 (check_for_sandbox_denial); 1 external calls (lock).


##### `UnifiedExecProcess::sandbox_type`  (lines 260–262)

```
fn sandbox_type(&self) -> SandboxType
```

**Purpose**: Returns the sandbox mode associated with this process.

**Data flow**: Reads the stored `sandbox_type` field and returns it by value.

**Call relations**: Used by sandbox-denial detection to skip checks for unsandboxed processes and to pass the correct sandbox type into denial heuristics.

*Call graph*: called by 1 (check_for_sandbox_denial_with_text).


##### `UnifiedExecProcess::failure_message`  (lines 264–266)

```
fn failure_message(&self) -> Option<String>
```

**Purpose**: Returns the currently recorded process failure message, if any.

**Data flow**: Reads the current `ProcessState` from `state_rx`, clones `failure_message`, and returns `Option<String>`.

**Call relations**: Queried by manager-level error handling to distinguish transport/process failures from ordinary exits and to preserve the original failure text.

*Call graph*: called by 1 (fail_process_with_message); 1 external calls (borrow).


##### `UnifiedExecProcess::check_for_sandbox_denial`  (lines 268–282)

```
async fn check_for_sandbox_denial(&self) -> Result<(), UnifiedExecError>
```

**Purpose**: Builds a text snapshot from buffered output and runs sandbox-denial detection against it, waiting briefly for initial output if necessary.

**Data flow**: Waits up to 20 ms for `output_notify`, then calls `snapshot_output()`, concatenates all chunk bytes into one `Vec<u8>`, converts it with `String::from_utf8_lossy`, and delegates to `check_for_sandbox_denial_with_text`. Returns `Ok(())` or a sandbox-denied `UnifiedExecError`.

**Call relations**: Called by both constructors after early exit detection so short-lived sandbox failures can be surfaced immediately to callers before the process is handed off.

*Call graph*: calls 2 internal fn (check_for_sandbox_denial_with_text, snapshot_output); 4 external calls (from_millis, from_utf8_lossy, new, timeout).


##### `UnifiedExecProcess::check_for_sandbox_denial_with_text`  (lines 284–313)

```
async fn check_for_sandbox_denial_with_text(
        &self,
        text: &str,
    ) -> Result<(), UnifiedExecError>
```

**Purpose**: Determines whether an exited sandboxed process likely failed because the sandbox denied an operation, and if so returns a structured sandbox-denied error.

**Data flow**: Takes output text, reads `sandbox_type()`, `has_exited()`, and `exit_code()`. If sandboxing is disabled or the process is still running, returns `Ok(())`. Otherwise constructs an `ExecToolCallOutput` with the text in both `stderr` and `aggregated_output`, calls `is_likely_sandbox_denied`, and on a positive match truncates the text with `formatted_truncate_text(…, TruncationPolicy::Tokens(UNIFIED_EXEC_OUTPUT_MAX_TOKENS))`. It returns `Err(UnifiedExecError::sandbox_denied(message, exec_output))` using either the truncated snippet or a fallback `Process exited with code ...` message.

**Call relations**: Invoked by `check_for_sandbox_denial` and by manager code that already has collected output text. It is the final gate that converts ordinary exited-process state into a sandbox-specific failure classification.

*Call graph*: calls 6 internal fn (is_likely_sandbox_denied, sandbox_denied, exit_code, has_exited, sandbox_type, new); called by 1 (check_for_sandbox_denial); 4 external calls (default, formatted_truncate_text, format!, Tokens).


##### `UnifiedExecProcess::from_spawned`  (lines 315–373)

```
async fn from_spawned(
        spawned: SpawnedPty,
        sandbox_type: SandboxType,
        spawn_lifecycle: SpawnLifecycleHandle,
    ) -> Result<Self, UnifiedExecError>
```

**Purpose**: Constructs a unified process from a locally spawned PTY/pipe session, starts output forwarding, and handles immediate or very early exit before returning.

**Data flow**: Consumes `SpawnedPty` plus sandbox metadata and a spawn lifecycle handle. It extracts the local session, stdout/stderr receivers, and exit receiver; combines stdout/stderr into one receiver; builds `Self::new(ProcessHandle::Local(...))`; starts `spawn_local_output_task`; then probes `exit_rx` with `try_recv()`, followed by a timeout over `EARLY_EXIT_GRACE_PERIOD`. If an exit is observed, it records exit state and runs sandbox-denial detection before returning. Otherwise it spawns a background task awaiting `exit_rx` that updates watched state and cancels the token later.

**Call relations**: Called by `open_session_with_exec_env` for local process launches. Its early-exit logic ensures callers can synchronously observe commands that fail almost immediately instead of storing them as long-lived sessions.

*Call graph*: called by 1 (open_session_with_exec_env); 8 external calls (clone, new, new, spawn_local_output_task, combine_output_receivers, Local, spawn, timeout).


##### `UnifiedExecProcess::from_exec_server_started`  (lines 375–408)

```
async fn from_exec_server_started(
        started: StartedExecProcess,
        sandbox_type: SandboxType,
    ) -> Result<Self, UnifiedExecError>
```

**Purpose**: Constructs a unified process from an already-started exec-server process, starts remote output polling, and waits briefly for an early exit or failure signal.

**Data flow**: Consumes `StartedExecProcess` and `SandboxType` → wraps the remote process in `ProcessHandle::ExecServer`, builds `Self::new`, derives `OutputHandles`, starts `spawn_exec_server_output_task`, then clones `state_rx` and waits up to `EARLY_EXIT_GRACE_PERIOD` for `has_exited` or `failure_message` to appear. If that happens in time, it runs sandbox-denial detection before returning the process.

**Call relations**: Used by `open_session_with_exec_env` for remote exec-server launches and by tests. It relies on the spawned output task to populate state, so the early wait loops on the watch receiver rather than a direct exit channel.

*Call graph*: called by 4 (blocking_terminate_unified_process, open_session_with_exec_env, remote_process, remote_process_waits_for_early_exit_event); 5 external calls (clone, new, spawn_exec_server_output_task, ExecServer, timeout).


##### `UnifiedExecProcess::spawn_exec_server_output_task`  (lines 410–497)

```
fn spawn_exec_server_output_task(
        started: StartedExecProcess,
        output_handles: OutputHandles,
        output_tx: broadcast::Sender<Vec<u8>>,
        state_tx: watch::Sender<ProcessStat
```

**Purpose**: Starts the background task that polls a remote exec-server process for output, exit, closure, and failure updates, then mirrors those into local shared state.

**Data flow**: Takes `StartedExecProcess`, `OutputHandles`, an output broadcast sender, and a state watch sender. Inside the spawned loop it calls `process.read(after_seq, None, Some(0)).await`, appends each returned chunk into `output_buffer`, broadcasts the bytes, and notifies output waiters. If `failure` is present it writes a failed `ProcessState`, marks output closed, notifies closure, cancels the token, and exits. If `exited` is true it writes an exited state; if `closed` is true it marks output closed and cancels. It advances `after_seq` to `next_seq.checked_sub(1)` and waits on `wake_rx.changed()` before polling again. Read errors or wake-channel closure are converted into failed state plus output closure.

**Call relations**: Spawned only by `from_exec_server_started`. It is the remote transport bridge that turns exec-server polling and wake notifications into the same buffer/notify/state model used by local processes.

*Call graph*: 4 external calls (borrow, send, send_replace, spawn).


##### `UnifiedExecProcess::spawn_local_output_task`  (lines 499–526)

```
fn spawn_local_output_task(
        mut receiver: tokio::sync::broadcast::Receiver<Vec<u8>>,
        buffer: OutputBuffer,
        output_notify: Arc<Notify>,
        output_closed: Arc<AtomicBool>,
```

**Purpose**: Starts the background task that consumes merged local stdout/stderr chunks, stores them in the shared buffer, and rebroadcasts them to live subscribers.

**Data flow**: Takes a broadcast receiver of output chunks plus shared buffer/notify/closed state and an output sender. In a spawned loop it awaits `receiver.recv()`: on `Ok(chunk)` it locks the buffer, pushes the chunk, broadcasts it, and notifies output waiters; on `Lagged(_)` it skips missed chunks and continues; on `Closed` it marks output closed, notifies closure waiters, and exits.

**Call relations**: Spawned by `from_spawned` for local PTY/pipe sessions. It normalizes local output delivery into the same shared structures used by remote output polling.

*Call graph*: calls 1 internal fn (recv); 3 external calls (lock, send, spawn).


##### `UnifiedExecProcess::signal_exit`  (lines 528–532)

```
fn signal_exit(&self, exit_code: Option<i32>)
```

**Purpose**: Marks the process as exited with the supplied exit code and triggers the cancellation token.

**Data flow**: Reads current `ProcessState` from `state_rx`, writes `state.exited(exit_code)` into `state_tx`, cancels `cancellation_token`, and returns unit.

**Call relations**: Used by `terminate_confirmed` and the local early-exit path to publish a final exit state in one place.

*Call graph*: called by 1 (terminate_confirmed); 3 external calls (cancel, send_replace, borrow).


##### `UnifiedExecProcess::drop`  (lines 536–538)

```
fn drop(&mut self)
```

**Purpose**: Ensures the underlying process is terminated when the wrapper is dropped.

**Data flow**: On mutable drop of `self`, calls `terminate()` and returns unit.

**Call relations**: Acts as the final safety net if higher-level code forgets to explicitly terminate or release a process handle.

*Call graph*: calls 1 internal fn (terminate).


### `core/src/unified_exec/process_manager.rs`

`orchestration` · `request handling and background process management`

This file is the control plane for unified exec. It defines helper constants and environment shaping (`UNIFIED_EXEC_ENV`, network-denial messages, deterministic test IDs), then implements `UnifiedExecProcessManager` methods that span process creation, persistence, polling, pruning, and termination. The manager’s central state lives in a `ProcessStore` lock elsewhere; this file decides when entries are inserted, removed, or pruned.

Launch flow starts in `exec_command`: it opens a sandboxed session through `open_session_with_sandbox`, optionally installs a background task that kills the process on deferred network denial, emits begin events, starts streaming output, stores long-lived processes before the initial yield window, then collects buffered output until a deadline using `collect_output_until_deadline`. That collector drains `HeadTailBuffer` chunks, waits on `Notify`, respects process exit via `CancellationToken`, and extends deadlines while the session is paused. After collection, `exec_command` resolves network approval, process failure, sandbox denial, and whether the process remains alive; short-lived commands emit end events immediately, while long-lived ones stay in the store for later `write_stdin` polling.

`write_stdin` rehydrates the stored process plus output handles, supports interrupt-only writes for non-TTY sessions, performs bounded polling after writes, and removes exited processes after final network-approval cleanup. `open_session_with_exec_env` chooses among Windows sandbox launchers, remote exec-server startup, and local PTY/pipe spawning, including inherited-FD lifecycle hooks. The file also contains pruning policy: keep the 8 most recently used processes protected, prefer pruning exited entries outside that set, otherwise prune least-recently-used. Cleanup paths consistently unregister deferred network approvals before dropping entries.

#### Function details

##### `set_deterministic_process_ids_for_tests`  (lines 85–87)

```
fn set_deterministic_process_ids_for_tests(enabled: bool)
```

**Purpose**: Enables or disables the test-only global override that forces deterministic unified-exec process ID allocation.

**Data flow**: Takes a `bool` and stores it into the static `FORCE_DETERMINISTIC_PROCESS_IDS` with relaxed ordering; returns unit.

**Call relations**: Used by tests or test helpers to make `allocate_process_id` predictable without relying on random-number generation.

*Call graph*: called by 1 (set_deterministic_process_ids_for_tests).


##### `deterministic_process_ids_forced_for_tests`  (lines 89–91)

```
fn deterministic_process_ids_forced_for_tests() -> bool
```

**Purpose**: Reads the test override flag controlling deterministic process ID allocation.

**Data flow**: Loads the `FORCE_DETERMINISTIC_PROCESS_IDS` atomic with relaxed ordering and returns the resulting `bool`.

**Call relations**: Called only by `should_use_deterministic_process_ids` as part of the process-ID allocation policy.

*Call graph*: called by 1 (should_use_deterministic_process_ids).


##### `should_use_deterministic_process_ids`  (lines 93–95)

```
fn should_use_deterministic_process_ids() -> bool
```

**Purpose**: Decides whether process IDs should be deterministic instead of random.

**Data flow**: Evaluates `cfg!(test)` and the runtime override from `deterministic_process_ids_forced_for_tests()` → returns `true` if either condition is true.

**Call relations**: Queried by `allocate_process_id` to switch between monotonic test IDs and random production IDs.

*Call graph*: calls 1 internal fn (deterministic_process_ids_forced_for_tests); called by 1 (allocate_process_id); 1 external calls (cfg!).


##### `apply_unified_exec_env`  (lines 97–102)

```
fn apply_unified_exec_env(mut env: HashMap<String, String>) -> HashMap<String, String>
```

**Purpose**: Injects the fixed unified-exec environment defaults into an environment map, overriding any existing values for those keys.

**Data flow**: Consumes a `HashMap<String, String>`, iterates over `UNIFIED_EXEC_ENV`, inserts each key/value pair into the map, and returns the modified map.

**Call relations**: Used during sandbox/session setup in `open_session_with_sandbox` so every unified-exec command runs with normalized locale, pager, and terminal-related variables.

*Call graph*: called by 1 (open_session_with_sandbox).


##### `exec_env_policy_from_shell_policy`  (lines 104–122)

```
fn exec_env_policy_from_shell_policy(
    policy: &ShellEnvironmentPolicy,
) -> codex_exec_server::ExecEnvPolicy
```

**Purpose**: Converts the turn’s shell environment policy into the exec-server environment policy type.

**Data flow**: Reads fields from `ShellEnvironmentPolicy` (`inherit`, `ignore_default_excludes`, `exclude`, `r#set`, `include_only`) → clones/maps them into a `codex_exec_server::ExecEnvPolicy` → returns that policy.

**Call relations**: Called by `open_session_with_sandbox` when preparing `ExecServerEnvConfig` for requests that may run through an exec server.

*Call graph*: called by 1 (open_session_with_sandbox).


##### `env_overlay_for_exec_server`  (lines 124–133)

```
fn env_overlay_for_exec_server(
    request_env: &HashMap<String, String>,
    local_policy_env: &HashMap<String, String>,
) -> HashMap<String, String>
```

**Purpose**: Computes the minimal environment overlay that must be sent to the exec server by removing variables whose values already match the locally applied policy environment.

**Data flow**: Reads `request_env` and `local_policy_env`, filters request entries where `local_policy_env.get(key) != Some(value)`, clones those differing pairs into a new `HashMap`, and returns it.

**Call relations**: Used by `exec_server_env_for_request` so remote execution receives only runtime changes beyond the baseline local policy environment.

*Call graph*: called by 1 (exec_server_env_for_request).


##### `exec_server_env_for_request`  (lines 135–149)

```
fn exec_server_env_for_request(
    request: &ExecRequest,
) -> (
    Option<codex_exec_server::ExecEnvPolicy>,
    HashMap<String, String>,
)
```

**Purpose**: Determines the environment policy and environment payload to send for an exec-server request.

**Data flow**: Reads `request.exec_server_env_config`. If present, returns `(Some(policy.clone()), env_overlay_for_exec_server(&request.env, &local_policy_env))`; otherwise returns `(None, request.env.clone())`.

**Call relations**: Called by `exec_server_params_for_request` to build the final remote execution parameters.

*Call graph*: calls 1 internal fn (env_overlay_for_exec_server); called by 1 (exec_server_params_for_request).


##### `exec_server_params_for_request`  (lines 151–167)

```
fn exec_server_params_for_request(
    process_id: i32,
    request: &ExecRequest,
    tty: bool,
) -> codex_exec_server::ExecParams
```

**Purpose**: Builds the `codex_exec_server::ExecParams` structure for launching a process through the exec server.

**Data flow**: Takes a unified-exec `process_id`, `ExecRequest`, and `tty` flag; derives `(env_policy, env)` via `exec_server_env_for_request`, converts the numeric process ID with `exec_server_process_id`, converts `cwd` with `PathUri::from_abs_path`, copies argv/arg0, sets `pipe_stdin` to `false`, and returns the assembled `ExecParams`.

**Call relations**: Used by `open_session_with_exec_env` in the remote-exec path before calling `start` on the exec backend.

*Call graph*: calls 3 internal fn (exec_server_env_for_request, exec_server_process_id, from_abs_path); called by 1 (open_session_with_exec_env).


##### `InitialExecCommandGuard::drop`  (lines 191–193)

```
fn drop(&mut self)
```

**Purpose**: Marks the initial exec-command phase as inactive when the guard goes out of scope.

**Data flow**: On drop, stores `false` into the guard’s shared `active: Arc<AtomicBool>` with release ordering.

**Call relations**: Created in `exec_command` only for processes that were stored as live background sessions; later termination logic checks this flag to avoid removing a process while the initial command call is still active.


##### `exec_server_process_id`  (lines 196–198)

```
fn exec_server_process_id(process_id: i32) -> String
```

**Purpose**: Converts the manager’s numeric process ID into the string form expected by the exec server.

**Data flow**: Takes `i32`, calls `to_string()`, and returns the resulting `String`.

**Call relations**: Used by `exec_server_params_for_request` so local and remote process IDs stay aligned.

*Call graph*: called by 1 (exec_server_params_for_request).


##### `unregister_network_approval_for_entry`  (lines 200–210)

```
async fn unregister_network_approval_for_entry(entry: &ProcessEntry)
```

**Purpose**: Removes any deferred network-approval registration associated with a stored process entry.

**Data flow**: Reads `entry.network_approval` and upgrades `entry.session` from `Weak` to `Arc`; if both exist, awaits `session.services.network_approval.unregister_call(registration_id)` and otherwise does nothing.

**Call relations**: Called whenever a process entry is removed or pruned—during `release_process_id`, `store_process` pruning cleanup, `terminate_all_processes`, and `terminate_process`—to avoid leaving stale approval registrations behind.

*Call graph*: called by 4 (release_process_id, store_process, terminate_all_processes, terminate_process).


##### `finish_network_approval_after_process_exit_for_entry`  (lines 212–221)

```
async fn finish_network_approval_after_process_exit_for_entry(
    entry: &ProcessEntry,
) -> Result<(), String>
```

**Purpose**: Completes deferred network approval for a stored process entry after it has exited, including the late-denial grace period.

**Data flow**: Upgrades the entry’s weak session reference, clones the entry’s deferred approval, and delegates to `finish_deferred_network_approval_after_process_exit_for_session`, returning `Result<(), String>`.

**Call relations**: Used by `write_stdin` when a stored process has exited and been removed from the store, so final approval resolution happens before the response is returned.

*Call graph*: calls 1 internal fn (finish_deferred_network_approval_after_process_exit_for_session); called by 1 (write_stdin).


##### `finish_deferred_network_approval_for_session`  (lines 223–233)

```
async fn finish_deferred_network_approval_for_session(
    session: Option<&Arc<crate::session::session::Session>>,
    deferred: Option<DeferredNetworkApproval>,
) -> Result<(), String>
```

**Purpose**: Finalizes deferred network approval against a concrete session and converts tool-layer errors into plain strings.

**Data flow**: Takes an optional session reference and optional `DeferredNetworkApproval`. If no session exists, returns `Ok(())`. Otherwise awaits `finish_deferred_network_approval(session, deferred)` and maps any `ToolError` through `network_approval_error_message`.

**Call relations**: Used by both `exec_command` and `write_stdin`, and by the post-exit helper, whenever a process outcome must be reconciled with deferred network approval.

*Call graph*: calls 1 internal fn (finish_deferred_network_approval); called by 3 (exec_command, write_stdin, finish_deferred_network_approval_after_process_exit_for_session).


##### `network_approval_error_message`  (lines 235–240)

```
fn network_approval_error_message(err: ToolError) -> String
```

**Purpose**: Normalizes a `ToolError` from deferred network approval into the user-facing message string that should be attached to process failure.

**Data flow**: Matches on `ToolError`: returns the embedded rejection message for `Rejected`, or `err.to_string()` for `Codex` errors.

**Call relations**: Used by network-approval completion helpers to preserve meaningful denial text instead of exposing raw enum structure.

*Call graph*: called by 1 (network_denial_message_for_session); 1 external calls (to_string).


##### `network_denial_message_for_session`  (lines 242–253)

```
async fn network_denial_message_for_session(
    session: Option<&Arc<crate::session::session::Session>>,
    deferred: Option<DeferredNetworkApproval>,
) -> String
```

**Purpose**: Produces the final message to use when network access is denied, either the fixed fallback string or a more specific message from deferred approval completion.

**Data flow**: If no session is available, returns `NETWORK_ACCESS_DENIED_MESSAGE`. Otherwise awaits `finish_deferred_network_approval(session, deferred)`; on success returns the fallback denial string, on error converts the error with `network_approval_error_message`.

**Call relations**: Used in `exec_command`, `write_stdin`, and `terminate_process_on_network_denial` when a process must be failed because network access was denied.

*Call graph*: calls 2 internal fn (finish_deferred_network_approval, network_approval_error_message); called by 3 (exec_command, write_stdin, terminate_process_on_network_denial).


##### `wait_for_late_network_denial`  (lines 255–267)

```
async fn wait_for_late_network_denial(network_cancelled: Option<CancellationToken>) -> bool
```

**Purpose**: Waits briefly after process exit to see whether a deferred network denial arrives slightly late.

**Data flow**: Takes `Option<CancellationToken>`. If absent, returns `false`. If already cancelled, returns `true`. Otherwise races `network_cancelled.cancelled()` against `tokio::time::sleep(LATE_NETWORK_DENIAL_GRACE_PERIOD)` and returns whether cancellation won.

**Call relations**: Called by post-exit network-approval completion so the manager does not miss denials that are signaled just after the process itself exits.

*Call graph*: called by 1 (finish_deferred_network_approval_after_process_exit_for_session); 1 external calls (select!).


##### `finish_deferred_network_approval_after_process_exit_for_session`  (lines 269–280)

```
async fn finish_deferred_network_approval_after_process_exit_for_session(
    session: Option<&Arc<crate::session::session::Session>>,
    deferred: Option<DeferredNetworkApproval>,
) -> Result<(), St
```

**Purpose**: Completes deferred network approval after first allowing a short grace period for late network-denial cancellation.

**Data flow**: Extracts the deferred approval’s cancellation token if present, awaits `wait_for_late_network_denial`, then delegates to `finish_deferred_network_approval_for_session` and returns its `Result<(), String>`.

**Call relations**: Used by `exec_command` and the entry-based wrapper to reconcile network approval for processes that have already exited.

*Call graph*: calls 2 internal fn (finish_deferred_network_approval_for_session, wait_for_late_network_denial); called by 2 (exec_command, finish_network_approval_after_process_exit_for_entry).


##### `fail_process_with_message`  (lines 282–290)

```
fn fail_process_with_message(process: &UnifiedExecProcess, message: String) -> UnifiedExecError
```

**Purpose**: Ensures a process is marked failed and terminated, then returns a `UnifiedExecError::ProcessFailed` carrying the preserved failure message.

**Data flow**: Reads `process.failure_message()`. If one already exists, terminates the process and returns `UnifiedExecError::process_failed(existing_message)`. Otherwise calls `process.fail_and_terminate(message.clone())` and returns `process_failed` using the stored failure message or the original fallback.

**Call relations**: Used by `exec_command` and `write_stdin` in error paths where the manager needs both side effects on the process and a unified error value for the caller.

*Call graph*: calls 4 internal fn (process_failed, fail_and_terminate, failure_message, terminate); called by 2 (exec_command, write_stdin).


##### `emit_failed_initial_exec_end_if_unstored`  (lines 293–320)

```
async fn emit_failed_initial_exec_end_if_unstored(
    process_started_alive: bool,
    context: &UnifiedExecContext,
    request: &ExecCommandRequest,
    cwd: AbsolutePathBuf,
    transcript: Arc<to
```

**Purpose**: Emits a failed `ExecCommandEnd` event for commands that died before being stored as background processes.

**Data flow**: Takes a `process_started_alive` flag plus context, request metadata, cwd, transcript buffer, fallback output text, failure message, and wall time. If `process_started_alive` is true it returns immediately; otherwise it awaits `emit_failed_exec_end_for_unified_exec(...)` with the provided transcript and fallback output.

**Call relations**: Called from `exec_command` only on startup-time failure paths so short-lived commands still produce the same end event shape as background watcher completion.

*Call graph*: calls 1 internal fn (emit_failed_exec_end_for_unified_exec); called by 1 (exec_command); 1 external calls (clone).


##### `terminate_process_on_network_denial`  (lines 322–343)

```
fn terminate_process_on_network_denial(
    process: Arc<UnifiedExecProcess>,
    session: std::sync::Weak<crate::session::session::Session>,
    deferred: DeferredNetworkApproval,
)
```

**Purpose**: Spawns a watcher that terminates a running process if its deferred network approval is later cancelled.

**Data flow**: Clones the deferred approval’s cancellation token and the process cancellation token, then spawns a task. That task waits either for network cancellation directly or for process exit followed by `wait_for_late_network_denial`; if denial is confirmed, it upgrades the weak session, computes a denial message with `network_denial_message_for_session`, and calls `process.fail_and_terminate(message)`.

**Call relations**: Installed by `exec_command` whenever launch returns a deferred network approval. It decouples asynchronous network-policy enforcement from the main request/response path.

*Call graph*: calls 2 internal fn (cancellation_token, network_denial_message_for_session); called by 1 (exec_command); 4 external calls (as_ref, upgrade, select!, spawn).


##### `UnifiedExecProcessManager::allocate_process_id`  (lines 346–371)

```
async fn allocate_process_id(&self) -> i32
```

**Purpose**: Reserves and returns a unique unified-exec process ID.

**Data flow**: Loops while holding `self.process_store.lock()`. If deterministic IDs are enabled, computes the next ID as one greater than the current max reserved ID, with a floor of 1000; otherwise generates a random ID in `1_000..100_000`. If the candidate is already reserved it retries; otherwise inserts it into `reserved_process_ids` and returns it.

**Call relations**: Called before process launch to reserve an ID that remains unavailable until `release_process_id` or store removal frees it.

*Call graph*: calls 1 internal fn (should_use_deterministic_process_ids); 1 external calls (rng).


##### `UnifiedExecProcessManager::release_process_id`  (lines 373–381)

```
async fn release_process_id(&self, process_id: i32)
```

**Purpose**: Removes a process entry and frees its reserved process ID, including deferred network-approval cleanup if an entry existed.

**Data flow**: Locks `process_store`, removes the process by ID via `store.remove(process_id)`, drops the lock, and if an entry was removed awaits `unregister_network_approval_for_entry(&entry)`.

**Call relations**: Used by `exec_command` and `write_stdin` on failure or final completion paths to ensure both the ID reservation and any approval registration are cleaned up.

*Call graph*: calls 1 internal fn (unregister_network_approval_for_entry); called by 2 (exec_command, write_stdin).


##### `UnifiedExecProcessManager::exec_command`  (lines 383–614)

```
async fn exec_command(
        &self,
        request: ExecCommandRequest,
        context: &UnifiedExecContext,
    ) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

**Purpose**: Launches a command under unified exec, emits startup events, optionally stores it as a background process, collects initial output until the requested yield deadline, and returns the first tool response or an error.

**Data flow**: Consumes an `ExecCommandRequest` and `UnifiedExecContext`. It calls `open_session_with_sandbox`; on success wraps the process in `Arc`, optionally installs `terminate_process_on_network_denial`, creates a transcript buffer, emits a begin event, and starts live output streaming. If the process appears still alive, it stores a `ProcessEntry` plus an `InitialExecCommandGuard`. It then computes a bounded yield time, obtains `OutputHandles`, and calls `collect_output_until_deadline` to drain buffered output until deadline/exit/closure. The collected bytes are converted to text, token-counted, and packaged into `ExecCommandToolOutput`. Before returning, it checks deferred network denial, process failure, refreshed process status, post-exit network approval completion, sandbox denial, and whether to emit an immediate end event for short-lived commands. It may release the process ID and return errors on any of those branches.

**Call relations**: This is the main unified-exec startup path. It orchestrates launch (`open_session_with_sandbox`), event emission (`start_streaming_output`, begin/end helpers), process persistence (`store_process`), output polling (`collect_output_until_deadline`), and cleanup/error conversion (`release_process_id`, network-approval finishers, sandbox checks).

*Call graph*: calls 18 internal fn (unified_exec, new, emit_exec_end_for_unified_exec, start_streaming_output, clamp_yield_time, process_failed, generate_chunk_id, default, open_session_with_sandbox, refresh_process_state (+8 more)); 10 external calls (clone, downgrade, new, new, from_millis, now, collect_output_until_deadline, from_utf8_lossy, approx_token_count, new).


##### `UnifiedExecProcessManager::write_stdin`  (lines 616–769)

```
async fn write_stdin(
        &self,
        request: WriteStdinRequest<'_>,
    ) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

**Purpose**: Handles follow-up interaction with a stored process: optional stdin write or interrupt, bounded output polling, exit-state refresh, and final response construction.

**Data flow**: Takes `WriteStdinRequest`, loads `PreparedProcessHandles` via `prepare_process_handles`, and optionally writes input. For non-TTY processes only the interrupt control character is accepted; other input yields `StdinClosed`. For TTY writes it awaits `process.write`, sleeping briefly after success to capture responsive output, and on write failure may refresh state or terminate/release the process depending on the error. It then computes a polling deadline based on empty-vs-nonempty input rules, calls `collect_output_until_deadline`, converts bytes to text, token-counts, checks network denial and process failure, refreshes process status, finishes network approval for exited entries, and returns `ExecCommandToolOutput` with the appropriate `process_id`, `exit_code`, and `event_call_id`.

**Call relations**: Invoked for subsequent polls and interactive writes after `exec_command` has stored a live process. It depends on `prepare_process_handles` and `refresh_process_state` to bridge from stored entries back to the per-process runtime.

*Call graph*: calls 9 internal fn (process_failed, generate_chunk_id, prepare_process_handles, refresh_process_state, release_process_id, fail_process_with_message, finish_deferred_network_approval_for_session, finish_network_approval_after_process_exit_for_entry, network_denial_message_for_session); 7 external calls (from_millis, now, collect_output_until_deadline, from_utf8_lossy, approx_token_count, matches!, sleep).


##### `UnifiedExecProcessManager::refresh_process_state`  (lines 771–795)

```
async fn refresh_process_state(&self, process_id: i32) -> ProcessStatus
```

**Purpose**: Reconciles a stored process entry with its current runtime state and removes it from the store if it has exited.

**Data flow**: Locks `process_store`, looks up the entry by ID, reads `entry.process.exit_code()` and `entry.process.has_exited()`. If absent, returns `ProcessStatus::Unknown`. If exited, removes the entry from the store and returns `ProcessStatus::Exited { exit_code, entry }`; otherwise returns `ProcessStatus::Alive { exit_code, call_id, process_id }`.

**Call relations**: Used by both `exec_command` and `write_stdin` after polling or write attempts to decide whether the process remains interactive or has transitioned into final cleanup.

*Call graph*: called by 2 (exec_command, write_stdin); 1 external calls (new).


##### `UnifiedExecProcessManager::prepare_process_handles`  (lines 797–835)

```
async fn prepare_process_handles(
        &self,
        process_id: i32,
    ) -> Result<PreparedProcessHandles, UnifiedExecError>
```

**Purpose**: Extracts the live process and all shared polling-related handles from a stored process entry while updating its last-used timestamp.

**Data flow**: Locks `process_store`, finds the mutable `ProcessEntry` by ID or returns `UnknownProcessId`, sets `entry.last_used = Instant::now()`, obtains `OutputHandles` from `entry.process`, upgrades the weak session reference, subscribes to pause state if a session exists, clones the process and metadata fields, and returns a `PreparedProcessHandles` struct.

**Call relations**: Called by `write_stdin` before any interaction so polling can proceed without holding the store lock and pruning recency reflects active use.

*Call graph*: called by 1 (write_stdin); 2 external calls (clone, now).


##### `UnifiedExecProcessManager::store_process`  (lines 838–888)

```
async fn store_process(
        &self,
        process: Arc<UnifiedExecProcess>,
        context: &UnifiedExecContext,
        command: &[String],
        hook_command: String,
        cwd: AbsolutePa
```

**Purpose**: Persists a newly started live process in the manager store, prunes an older entry if capacity is exceeded, and starts the background exit watcher for event emission.

**Data flow**: Builds a `ProcessEntry` from the supplied process, context metadata, cwd, timestamps, TTY flag, deferred network approval, weak session reference, and initial-command-active flag. While holding `process_store`, it calls `prune_processes_if_needed`, inserts the new entry, and captures any pruned entry. After releasing the lock, it unregisters network approval and terminates the pruned process if one existed, then calls `spawn_exit_watcher` with the new process and transcript.

**Call relations**: Called only from `exec_command` for processes that survive the initial startup window. It is the handoff point from startup orchestration to background lifecycle management.

*Call graph*: calls 2 internal fn (spawn_exit_watcher, unregister_network_approval_for_entry); called by 1 (exec_command); 4 external calls (clone, downgrade, prune_processes_if_needed, clone).


##### `UnifiedExecProcessManager::open_session_with_exec_env`  (lines 890–1024)

```
async fn open_session_with_exec_env(
        &self,
        process_id: i32,
        request: &ExecRequest,
        tty: bool,
        mut spawn_lifecycle: SpawnLifecycleHandle,
        environment: &
```

**Purpose**: Launches a process using the already-prepared execution environment, selecting the correct backend for Windows sandboxing, remote exec-server execution, or local PTY/pipe spawning.

**Data flow**: Takes a process ID, `ExecRequest`, TTY flag, mutable `SpawnLifecycleHandle`, and exec `Environment`. It first reads inherited FDs from the lifecycle. On Windows restricted-token sandbox builds, it resolves `codex_home`, derives filesystem override settings, calls the appropriate Windows sandbox spawn helper based on `windows_sandbox_level`, runs `after_spawn()`, and wraps the result with `UnifiedExecProcess::from_spawned`. If the environment is remote, it rejects inherited FDs, starts the exec backend with `exec_server_params_for_request`, runs `after_spawn()`, and returns `from_exec_server_started`. Otherwise it splits `request.command` into program/args, spawns either a PTY process or a no-stdin pipe process with inherited FDs, runs `after_spawn()`, and returns `from_spawned`. Spawn/setup failures are mapped into `UnifiedExecError::create_process`.

**Call relations**: Called by the unified-exec runtime during sandbox/orchestrator execution. It is the backend-selection layer that bridges high-level exec requests to concrete process creation.

*Call graph*: calls 10 internal fn (find_codex_home, create_process, from_exec_server_started, from_spawned, exec_server_params_for_request, get_exec_backend, is_remote, spawn_process_no_stdin_with_inherited_fds, default, spawn_process_with_inherited_fds); 4 external calls (after_spawn, inherited_fds, spawn_windows_sandbox_session_elevated_for_permission_profile, spawn_windows_sandbox_session_legacy).


##### `UnifiedExecProcessManager::open_session_with_sandbox`  (lines 1026–1114)

```
async fn open_session_with_sandbox(
        &self,
        request: &ExecCommandRequest,
        cwd: AbsolutePathBuf,
        context: &UnifiedExecContext,
    ) -> Result<(UnifiedExecProcess, Option
```

**Purpose**: Builds the full sandboxed unified-exec tool request, runs it through the tool orchestrator/runtime, and converts the result into a started process plus optional deferred network approval.

**Data flow**: Reads turn shell-environment policy to create `local_policy_env` via `create_env`, injects `CODEX_THREAD_ID_ENV_VAR`, applies unified-exec defaults, builds `ExecServerEnvConfig`, constructs a `ToolOrchestrator`, `UnifiedExecRuntime`, and exec approval requirement from session policy services, then assembles `UnifiedExecToolRequest` with command, cwd, env, sandbox/network/permission settings, and justification. It wraps session/turn/call metadata in `ToolCtx`, awaits `orchestrator.run(...)`, and on success returns `(result.output, result.deferred_network_approval)`. Tool errors are mapped either to `UnifiedExecError::sandbox_denied` when the orchestrator reports sandbox denial with output, or to `UnifiedExecError::create_process` otherwise.

**Call relations**: Called at the start of `exec_command`. It delegates actual policy enforcement and sandbox/runtime setup to the tool orchestration subsystem, then normalizes the outcome for unified-exec management.

*Call graph*: calls 6 internal fn (create_env, new, new, apply_unified_exec_env, exec_env_policy_from_shell_policy, plain); called by 1 (exec_command).


##### `UnifiedExecProcessManager::collect_output_until_deadline`  (lines 1116–1203)

```
async fn collect_output_until_deadline(
        output_buffer: &OutputBuffer,
        output_notify: &Arc<Notify>,
        output_closed: &Arc<AtomicBool>,
        output_closed_notify: &Arc<Notify>,
```

**Purpose**: Drains buffered process output until a deadline, process exit/closure, or pause-aware timeout, returning the collected bytes in order.

**Data flow**: Takes shared output buffer/notifiers, output-closed flags, a cancellation token, optional pause-state receiver, and a deadline. It repeatedly extends deadlines while paused, drains chunks from `HeadTailBuffer`, and appends them into a `Vec<u8>`. If no chunks are available, it waits on output arrival, process cancellation, output closure, timeout, or pause-state change. After exit is observed, it allows a short additional wait—capped by `POST_EXIT_CLOSE_WAIT_CAP`—for trailing output or closure before breaking. It returns the accumulated bytes.

**Call relations**: Used by both `exec_command` and `write_stdin` as the common polling primitive. It relies on `extend_deadlines_while_paused` and `wait_for_pause_change` to avoid charging paused time against the caller’s yield window.

*Call graph*: 10 external calls (cancelled, is_cancelled, from_millis, now, saturating_duration_since, lock, extend_deadlines_while_paused, with_capacity, pin!, select!).


##### `UnifiedExecProcessManager::extend_deadlines_while_paused`  (lines 1205–1229)

```
async fn extend_deadlines_while_paused(
        pause_state: &mut Option<watch::Receiver<bool>>,
        deadline: &mut Instant,
        post_exit_deadline: &mut Option<Instant>,
    )
```

**Purpose**: Suspends deadline accounting while the session’s out-of-band elicitation pause flag remains true.

**Data flow**: Takes mutable references to an optional pause-state receiver, the main deadline, and optional post-exit deadline. If no receiver exists or the current value is false, it returns immediately. Otherwise it records `paused_at = Instant::now()`, waits until the receiver changes to false or closes, computes `paused_for = paused_at.elapsed()`, and adds that duration to both deadlines.

**Call relations**: Called inside `collect_output_until_deadline` before each polling iteration so pauses do not prematurely end output collection.

*Call graph*: 1 external calls (now).


##### `UnifiedExecProcessManager::wait_for_pause_change`  (lines 1231–1239)

```
async fn wait_for_pause_change(pause_state: Option<&watch::Receiver<bool>>)
```

**Purpose**: Provides a future that resolves when pause state changes, or never resolves if no pause receiver exists.

**Data flow**: If given `Some(&watch::Receiver<bool>)`, clones it and awaits `changed()`. If `None`, awaits `std::future::pending::<()>()` forever.

**Call relations**: Used in `collect_output_until_deadline` select loops so pause transitions can wake the collector and trigger deadline extension.


##### `UnifiedExecProcessManager::prune_processes_if_needed`  (lines 1241–1257)

```
fn prune_processes_if_needed(store: &mut ProcessStore) -> Option<ProcessEntry>
```

**Purpose**: Enforces the maximum number of stored unified-exec processes by selecting and removing one entry when capacity is reached.

**Data flow**: Reads `store.processes.len()`. If below `MAX_UNIFIED_EXEC_PROCESSES`, returns `None`. Otherwise it builds metadata tuples `(process_id, last_used, has_exited)` for all entries, asks `process_id_to_prune_from_meta` for a candidate, removes that process from the store if one is chosen, and returns the removed `ProcessEntry`.

**Call relations**: Called from `store_process` while holding the process-store lock, before inserting a new live process.

*Call graph*: calls 1 internal fn (remove); 1 external calls (process_id_to_prune_from_meta).


##### `UnifiedExecProcessManager::process_id_to_prune_from_meta`  (lines 1260–1286)

```
fn process_id_to_prune_from_meta(meta: &[(i32, Instant, bool)]) -> Option<i32>
```

**Purpose**: Implements the pruning policy: protect the 8 most recently used processes, prefer exited processes outside that protected set, otherwise fall back to least-recently-used outside the protected set.

**Data flow**: Takes a slice of `(i32, Instant, bool)` metadata. If empty, returns `None`. Otherwise it clones and sorts one copy by reverse recency to build a `HashSet` of the 8 protected process IDs, clones and sorts another copy by ascending recency, then first searches for the oldest exited unprotected process and returns its ID if found; failing that, returns the oldest unprotected process ID.

**Call relations**: Used only by `prune_processes_if_needed`, but isolated so tests can validate pruning behavior directly.

*Call graph*: 2 external calls (is_empty, to_vec).


##### `UnifiedExecProcessManager::terminate_all_processes`  (lines 1288–1304)

```
async fn terminate_all_processes(&self)
```

**Purpose**: Stops every stored unified-exec process and clears all process IDs from the manager.

**Data flow**: Locks `process_store`, drains all `ProcessEntry` values from `processes`, clears `reserved_process_ids`, drops the lock, then for each entry awaits `unregister_network_approval_for_entry(&entry)` and calls `entry.process.terminate()`.

**Call relations**: Used during broader shutdown or reset flows to tear down all background unified-exec sessions.

*Call graph*: calls 1 internal fn (unregister_network_approval_for_entry).


##### `UnifiedExecProcessManager::list_processes`  (lines 1306–1323)

```
async fn list_processes(&self) -> Vec<BackgroundTerminalInfo>
```

**Purpose**: Returns metadata for currently live background terminal processes.

**Data flow**: Locks `process_store`, filters entries whose `process.has_exited()` is false, sorts them by `process_id`, maps each to `BackgroundTerminalInfo { item_id, process_id, command, cwd }`, and returns the resulting vector.

**Call relations**: Provides read-only inspection of active background sessions for UI or API surfaces that need to enumerate them.


##### `UnifiedExecProcessManager::terminate_process`  (lines 1325–1357)

```
async fn terminate_process(&self, process_id: i32) -> bool
```

**Purpose**: Terminates one stored process by ID, then removes it from the store if it is still the same process and not protected by an active initial exec-command call.

**Data flow**: First locks the store to fetch and clone the target `Arc<UnifiedExecProcess>` plus whether it already exited; if absent returns `false`. If still running, awaits `process.terminate_confirmed()` and returns `false` on failure. It then re-locks the store, re-fetches the entry, returns success if the entry disappeared or points to a different `Arc`, skips removal if `initial_exec_command_active` is still true, otherwise removes the entry. After unlocking, it unregisters network approval for the removed entry and returns `true`.

**Call relations**: Used for explicit user-initiated termination of a background process. The double-check with `Arc::ptr_eq` and the initial-command-active guard prevents races with process replacement or startup bookkeeping.

*Call graph*: calls 1 internal fn (unregister_network_approval_for_entry); 2 external calls (clone, ptr_eq).


### `core/src/tools/handlers/unified_exec/write_stdin.rs`

`io_transport` · `interactive command continuation / polling`

This file defines the lightweight transport side of unified exec after a process has already been started. `WriteStdinArgs` deserializes the model-facing request shape: `session_id` (the process id, intentionally named for model familiarity), optional `chars`, optional `max_output_tokens`, and a `yield_time_ms` default supplied by the shared unified-exec module.

`WriteStdinHandler` implements `ToolExecutor<ToolInvocation>` with the fixed tool name `write_stdin`, a schema from `create_write_stdin_tool`, and an async `handle_call` wrapper. The execution path is intentionally narrow: it rejects non-function payloads, parses `WriteStdinArgs`, and forwards them to `session.services.unified_exec_manager.write_stdin` as a `WriteStdinRequest` carrying the process id, stdin bytes, polling interval, output cap, and the turn's truncation policy.

A subtle but important branch controls UI event emission. Empty `chars` means a background poll rather than a real keystroke submission, so the handler only emits `EventMsg::TerminalInteraction` if the response still reports a live `process_id`; otherwise the poll completed the process and should stay invisible. Non-empty stdin always emits an interaction event, even if the write causes the process to exit before the response returns. For completed sessions, post-hook generation is delegated to the same helper used by `exec_command`, allowing a final `write_stdin` poll to produce the Bash post-hook for the original command.

#### Function details

##### `WriteStdinHandler::tool_name`  (lines 35–37)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the registered tool name for stdin continuation requests.

**Data flow**: It takes no inputs and returns `ToolName::plain("write_stdin")`.

**Call relations**: The tool registry uses this identifier when exposing and dispatching the handler. It is the stable external name paired with the schema from `spec()`.

*Call graph*: calls 1 internal fn (plain).


##### `WriteStdinHandler::spec`  (lines 39–41)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Returns the model-facing schema for the `write_stdin` tool.

**Data flow**: It reads no handler state and simply returns the `ToolSpec` produced by `create_write_stdin_tool()`.

**Call relations**: Called during tool registration. The schema helper encapsulates the JSON parameter definition so this handler stays focused on runtime behavior.

*Call graph*: calls 1 internal fn (create_write_stdin_tool).


##### `WriteStdinHandler::handle`  (lines 43–45)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Boxes the async stdin-write implementation into the trait-required future type.

**Data flow**: It consumes a `ToolInvocation`, calls `self.handle_call(invocation)`, pins the future, and returns it.

**Call relations**: The tool framework invokes this trait method at runtime. It is a thin adapter around `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `WriteStdinHandler::handle_call`  (lines 49–102)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Processes a `write_stdin` request by parsing arguments, forwarding them to the unified exec manager, optionally emitting a terminal interaction event, and returning the resulting exec output.

**Data flow**: It consumes a `ToolInvocation`, extracting `session`, `turn`, and `payload`. Non-function payloads become `FunctionCallError::RespondToModel`. For function payloads it parses `WriteStdinArgs`, then calls `session.services.unified_exec_manager.write_stdin` with `WriteStdinRequest { process_id: args.session_id, input: &args.chars, yield_time_ms, max_output_tokens, truncation_policy: turn.truncation_policy }`. Manager errors are mapped into model-facing strings. After a successful response, it conditionally emits `EventMsg::TerminalInteraction` using either the returned live `process_id` or the original `session_id`, then boxes and returns the response as tool output.

**Call relations**: This is called only by `handle`. It delegates actual process interaction to the unified exec manager and event publication to `session.send_event`; the conditional event branch distinguishes visible user input from invisible background polling.

*Call graph*: calls 2 internal fn (boxed_tool_output, parse_arguments); called by 1 (handle); 2 external calls (TerminalInteraction, RespondToModel).


##### `WriteStdinHandler::matches_kind`  (lines 106–108)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Declares that this runtime only applies to function-call payloads.

**Data flow**: It inspects a `&ToolPayload` and returns `true` only for `ToolPayload::Function { .. }`.

**Call relations**: The core runtime uses this to gate hook-related behavior. It matches the payload assumption enforced in `handle_call`.

*Call graph*: 1 external calls (matches!).


##### `WriteStdinHandler::pre_tool_use_payload`  (lines 110–115)

```
fn pre_tool_use_payload(&self, _invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Suppresses pre-hook emission for stdin writes and polls.

**Data flow**: It ignores the `ToolInvocation` and always returns `None`.

**Call relations**: The hook runtime calls this before tool execution, but `write_stdin` intentionally emits no pre-hook because it is transport for an already-started Bash command. The inline comments explain that empty writes are polls and non-empty writes continue a command that already emitted its pre-hook.


##### `WriteStdinHandler::post_tool_use_payload`  (lines 117–125)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Emits a Bash post-hook payload when a `write_stdin` call observes final completion of the underlying exec session.

**Data flow**: It takes the original `ToolInvocation` and resulting `ToolOutput`, passes them to `post_unified_exec_tool_use_payload`, and returns the helper's optional payload.

**Call relations**: The hook runtime invokes this after each stdin write or poll. By delegating to the shared helper, it can reuse the original exec call id and command metadata embedded in the output when a poll discovers that the process has finished.

*Call graph*: 1 external calls (post_unified_exec_tool_use_payload).


### Exec-server process backends
These files establish the exec-server process contract and then provide local and remote implementations that satisfy it.

### `exec-server/src/process.rs`

`domain_logic` · `cross-cutting`

This file models executor-managed processes and the two ways clients observe them: retained reads and pushed events. `ExecProcessEvent` is the event enum for streamed output and lifecycle changes, with `Output(ProcessOutputChunk)`, sequenced `Exited` and `Closed` markers, and unsequenced `Failed(String)` for client-synthesized session failures. The helper methods on the enum expose the event sequence number when one exists and compute how many bytes the event contributes to replay retention.

`ExecProcessEventLog` is the concrete replay/live fan-out mechanism. Internally it stores a mutex-protected `VecDeque<ExecProcessEvent>` plus a retained-byte counter, and a Tokio `broadcast::Sender` for live subscribers. `publish` clones the event into history, increments retained bytes, and evicts oldest events until both the configured event-count and byte-count capacities are satisfied; output chunks and failure strings count toward bytes, while exit/close markers do not. It then broadcasts the event live, intentionally ignoring send errors when no receivers are present. `subscribe` snapshots the current history into a replay queue and pairs it with a fresh broadcast receiver.

`ExecProcessEventReceiver` first drains replayed events, then awaits live ones; if the bounded broadcast channel lagged, callers are expected to recover via `ExecProcess::read`. The file also defines the `ExecProcess` trait itself—process identity, wake subscription, event subscription, retained-output reads, stdin writes, signaling, and termination—and the `ExecBackend` trait for starting processes. The associated future type aliases standardize async return signatures across implementations.

#### Function details

##### `ExecProcessEvent::seq`  (lines 67–73)

```
fn seq(&self) -> Option<u64>
```

**Purpose**: Returns the ordering sequence number for process-owned events and `None` for synthetic failures. It distinguishes transport/session failures from events emitted by the process stream itself.

**Data flow**: It takes `&self` and pattern-matches the enum. For `Output`, it returns `Some(chunk.seq)`; for `Exited` and `Closed`, it returns the stored `seq`; for `Failed`, it returns `None`.

**Call relations**: Ordering logic such as `publish_ordered_event` calls this to decide how to sequence or compare events. The method is purely interpretive and delegates nowhere.

*Call graph*: called by 1 (publish_ordered_event).


##### `ExecProcessEvent::retained_len`  (lines 75–81)

```
fn retained_len(&self) -> usize
```

**Purpose**: Computes how many bytes an event should count against replay retention limits. This lets the event log bound history by both event count and payload size.

**Data flow**: It takes `&self` and returns the output chunk length for `Output`, the message string length for `Failed`, and zero for `Exited` and `Closed`. It reads only the event’s in-memory fields and produces a `usize`.

**Call relations**: `ExecProcessEventLog::publish` calls this when updating `retained_bytes` and when subtracting evicted events. The method encapsulates the retention accounting policy for each event variant.

*Call graph*: called by 1 (publish).


##### `ExecProcessEventLog::new`  (lines 85–95)

```
fn new(event_capacity: usize, byte_capacity: usize) -> Self
```

**Purpose**: Constructs a new bounded event log with replay history and a live broadcast channel sized to the requested event capacity. It packages the shared state into an `Arc` so logs can be cloned cheaply.

**Data flow**: It takes `event_capacity` and `byte_capacity`, creates a Tokio broadcast channel with `event_capacity`, initializes an empty default `ExecProcessEventHistory`, stores capacities and sender in `ExecProcessEventLogInner`, wraps that in `Arc`, and returns `ExecProcessEventLog`.

**Call relations**: This constructor is used by process/session setup paths such as `new`, `start_process`, and `spawn_test_process`, and by the local unit test. It delegates channel creation to Tokio and establishes the shared state later used by `publish` and `subscribe`.

*Call graph*: called by 4 (new, start_process, spawn_test_process, event_history_replay_is_bounded_by_retained_bytes); 4 external calls (new, new, channel, default).


##### `ExecProcessEventLog::publish`  (lines 97–117)

```
fn publish(&self, event: ExecProcessEvent)
```

**Purpose**: Appends an event to replay history, evicts old history until both configured bounds are satisfied, and broadcasts the event to live subscribers. It is the single write path into the event stream.

**Data flow**: It takes `&self` and an owned `ExecProcessEvent`. It locks the history mutex, adds `event.retained_len()` to `retained_bytes`, pushes a clone of the event onto the back of the deque, and repeatedly pops from the front while either the event count exceeds `event_capacity` or retained bytes exceed `byte_capacity`, subtracting each evicted event’s retained length with `saturating_sub`. After updating history, it sends the original event on `live_tx`, discarding any send error.

**Call relations**: Ordered process-event publication code such as `publish_ordered_event` invokes this after deciding an event is ready to expose. It depends on `ExecProcessEvent::retained_len` for accounting and on Tokio broadcast for live fan-out.

*Call graph*: calls 1 internal fn (retained_len); called by 1 (publish_ordered_event); 1 external calls (clone).


##### `ExecProcessEventLog::subscribe`  (lines 119–129)

```
fn subscribe(&self) -> ExecProcessEventReceiver
```

**Purpose**: Creates a receiver that first replays the currently retained event history and then continues with live broadcast events. It gives new subscribers a consistent catch-up point without blocking publishers.

**Data flow**: It takes `&self`, locks the history mutex, creates a new broadcast receiver from `live_tx.subscribe()`, clones the current deque contents into a new `VecDeque`, and returns `ExecProcessEventReceiver { replay, live_rx }`.

**Call relations**: Process implementations call this from their `subscribe_events` methods to expose event streams to clients. It bridges the stored history maintained by `publish` into the consumer-facing receiver type.

*Call graph*: called by 2 (subscribe_events, subscribe_events).


##### `ExecProcessEventReceiver::empty`  (lines 138–144)

```
fn empty() -> Self
```

**Purpose**: Builds a receiver with no replayed events and a dummy live channel. It is a convenience for process implementations that currently have nothing to stream.

**Data flow**: It takes no arguments, creates a one-slot broadcast channel solely to obtain a receiver, initializes an empty `VecDeque` replay buffer, and returns `ExecProcessEventReceiver` containing both.

**Call relations**: Fallback `subscribe_events` implementations call this when they cannot provide a real event log. It avoids special-casing `Option` receivers elsewhere in the call flow.

*Call graph*: called by 2 (subscribe_events, subscribe_events); 2 external calls (new, channel).


##### `ExecProcessEventReceiver::recv`  (lines 151–157)

```
async fn recv(&mut self) -> Result<ExecProcessEvent, broadcast::error::RecvError>
```

**Purpose**: Returns the next available process event, preferring replay history before switching to the live broadcast stream. It is the consumer-facing async pull API for pushed events.

**Data flow**: It takes `&mut self`. If `self.replay.pop_front()` yields an event, it returns that immediately; otherwise it awaits `self.live_rx.recv()` and returns either the next live `ExecProcessEvent` or Tokio’s `RecvError` such as `Lagged` or `Closed`.

**Call relations**: Higher-level message delivery code such as `receive_message` awaits this when forwarding process events to clients. It sits at the boundary between the replay snapshot created by `subscribe` and the ongoing live channel.

*Call graph*: calls 1 internal fn (recv); called by 1 (receive_message); 1 external calls (pop_front).


##### `tests::event_history_replay_is_bounded_by_retained_bytes`  (lines 209–245)

```
async fn event_history_replay_is_bounded_by_retained_bytes()
```

**Purpose**: Verifies that replay history eviction honors the retained-byte budget, even when event-count capacity would otherwise allow more events to remain. It specifically shows that a large output event can be dropped while later zero-byte lifecycle events are retained.

**Data flow**: The test creates an `ExecProcessEventLog` with `event_capacity` 8 and `byte_capacity` 3, publishes an `Output` event containing `b"large"`, then `Exited` and `Closed` events. It subscribes, receives two replayed events via `timeout(..., events.recv())`, collects them into a vector, and asserts that only the `Exited` and `Closed` events remain in replay history.

**Call relations**: This test drives `ExecProcessEventLog::new`, `publish`, `subscribe`, and `ExecProcessEventReceiver::recv` together. It documents the eviction policy that production publishers and subscribers rely on.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, Output, vec!).


### `exec-server/src/local_process.rs`

`domain_logic` · `request handling`

This file manages child processes launched through `codex_utils_pty`, tracks them in a `HashMap<ProcessId, ProcessEntry>`, and exposes both RPC-style methods (`exec`, `exec_read`, `exec_write`, `signal_process`, `terminate_process`) and trait-based APIs (`ExecBackend`, `ExecProcess`). A process begins as `ProcessEntry::Starting` to reserve its ID before spawn completes; on success it becomes `Running(Box<RunningProcess>)`, which stores the `ExecCommandSession`, TTY/stdin mode flags, retained output in a `VecDeque<RetainedOutputChunk>`, sequence counters, exit state, wake/event broadcasters, and closure bookkeeping.

`start_process` validates `argv` and converts `cwd` from `PathUri` to a native path before launch, so non-native cwd URIs fail before any subprocess is created. Environment construction is explicit: `child_env` either uses `params.env` exactly or builds a shell-derived environment from `ExecEnvPolicy` and overlays explicit variables on top. After spawn, three tasks are launched: two `stream_output` tasks for stdout/stderr (or PTY output) and one `watch_exit` task. Output chunks are sequenced, retained up to `RETAINED_OUTPUT_BYTES_PER_PROCESS`, published to `ExecProcessEventLog`, and optionally forwarded as JSON-RPC notifications. `exec_read` supports long-polling with `wait_ms`, returning buffered chunks after `after_seq`, plus terminal state (`exited`, `closed`, `exit_code`) even when no new bytes arrive. Closure is emitted only after both output streams have ended and an exit code is known; then `maybe_emit_closed` schedules delayed eviction so late output after exit can still be observed until the stream truly closes. Tests cover cwd validation, environment policy overlay, late output retention, and post-close eviction.

#### Function details

##### `LocalProcess::default`  (lines 107–112)

```
fn default() -> Self
```

**Purpose**: Creates a `LocalProcess` with a dummy notification sink that simply drains outbound messages. This gives tests and local callers a usable backend without wiring a real RPC transport.

**Data flow**: It creates an `mpsc` channel for `RpcServerOutboundMessage`, spawns a task that repeatedly receives and discards messages, wraps the sender in `RpcNotificationSender::new`, and returns `Self::new(...)`.

**Call relations**: Used by tests and default local setups. It delegates actual state initialization to `LocalProcess::new` after installing a no-op notification consumer.

*Call graph*: calls 1 internal fn (new); called by 5 (default_for_tests, local, closed_process_is_evicted_after_retention, exited_process_retains_late_output_past_retention, start_process_rejects_non_native_cwd_before_launch); 2 external calls (new, spawn).


##### `LocalProcess::new`  (lines 116–123)

```
fn new(notifications: RpcNotificationSender) -> Self
```

**Purpose**: Constructs the process backend around a supplied notification sender. It initializes the shared process table and notification slot.

**Data flow**: It stores `Some(notifications)` inside an `RwLock`, creates an empty `HashMap<ProcessId, ProcessEntry>` inside a `tokio::sync::Mutex`, wraps both in `Inner`, then in `Arc`, and returns `LocalProcess { inner }`.

**Call relations**: Called by `default` and external setup code. All later process operations share this `inner` state.

*Call graph*: called by 1 (new); 4 external calls (new, new, new, new).


##### `LocalProcess::shutdown`  (lines 125–139)

```
async fn shutdown(&self)
```

**Purpose**: Terminates all currently running processes and clears the process table. It is the backend’s coarse-grained teardown path.

**Data flow**: It locks `inner.processes`, drains the map, filters out `Starting` entries, collects running processes, releases the lock, then iterates those processes and calls `process.session.terminate()` on each.

**Call relations**: Invoked during backend shutdown. It intentionally performs termination after releasing the mutex so process teardown does not hold the shared map lock.

*Call graph*: called by 1 (shutdown).


##### `LocalProcess::set_notification_sender`  (lines 141–148)

```
fn set_notification_sender(&self, notifications: Option<RpcNotificationSender>)
```

**Purpose**: Replaces or clears the outbound RPC notification sender used for process events. It allows the backend to detach from or reattach to a notification transport.

**Data flow**: It acquires the `RwLock` guarding `inner.notifications`, recovering from poisoning if necessary, and overwrites the stored `Option<RpcNotificationSender>` with the provided value.

**Call relations**: Higher-level orchestration calls this when connection state changes. Event-producing tasks later read the current sender through `notification_sender`.

*Call graph*: called by 1 (set_notification_sender).


##### `LocalProcess::start_process`  (lines 150–274)

```
async fn start_process(
        &self,
        params: ExecParams,
    ) -> Result<(ExecResponse, watch::Sender<u64>, ExecProcessEventLog), JSONRPCErrorError>
```

**Purpose**: Validates execution parameters, reserves the process ID, spawns the child process, installs runtime state, and launches background tasks for output and exit tracking. It is the core process-creation routine in this file.

**Data flow**: It extracts `program` and `args` from `params.argv`, errors if empty, converts `params.cwd` to a native path or returns `invalid_params`, reserves `process_id` in the process map as `Starting`, builds the child environment with `child_env`, chooses `spawn_pty_process`, `spawn_pipe_process`, or `spawn_pipe_process_no_stdin` based on `tty` and `pipe_stdin`, removes the placeholder on spawn failure, then creates `Notify`, `watch::channel`, and `ExecProcessEventLog`. It replaces the map entry with `Running(Box<RunningProcess { ... }>)`, initializes output retention state and `open_streams = 2`, spawns two `stream_output` tasks and one `watch_exit` task, and returns `(ExecResponse { process_id }, wake_tx, events)`.

**Call relations**: Both `exec` and trait-based `start` call this. It delegates environment construction to `child_env`, output ingestion to `stream_output`, and exit handling to `watch_exit`; it also uses RPC error helpers to distinguish invalid parameters, duplicate IDs, and internal spawn failures.

*Call graph*: calls 7 internal fn (child_env, stream_output, watch_exit, new, internal_error, invalid_request, default); called by 2 (exec, start); 13 external calls (clone, new, new, new, new, spawn_pipe_process, spawn_pipe_process_no_stdin, spawn_pty_process, Running, format! (+3 more)).


##### `LocalProcess::exec`  (lines 276–280)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, JSONRPCErrorError>
```

**Purpose**: Starts a process and returns only the RPC response payload. It is the JSON-RPC-facing convenience wrapper around `start_process`.

**Data flow**: It forwards `params` to `start_process`, awaits the result, discards the returned wake sender and event log, and returns the `ExecResponse` or the original `JSONRPCErrorError`.

**Call relations**: RPC handlers call this when they only need the process ID response, not an `ExecProcess` object.

*Call graph*: calls 1 internal fn (start_process); called by 1 (exec).


##### `LocalProcess::exec_read`  (lines 282–358)

```
async fn exec_read(
        &self,
        params: ReadParams,
    ) -> Result<ReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads retained output and terminal state for a process, optionally long-polling until new data or a deadline. It is the main read-side API for process output consumption.

**Data flow**: It derives `after_seq`, `max_bytes`, and a deadline from `ReadParams`. In a loop, it locks the process map, validates the process exists and is `Running`, scans retained output chunks with `seq > after_seq`, accumulates up to `max_bytes` into `ProcessOutputChunk`s, computes `next_seq`, and builds `ReadResponse { chunks, next_seq, exited, exit_code, closed, failure: None }` plus a clone of `output_notify`. If there are chunks, the process is closed, a terminal event became newly visible, or the deadline has passed, it returns the response. Otherwise it waits on `output_notify.notified()` with `tokio::time::timeout` for the remaining duration and loops.

**Call relations**: Called directly by RPC handlers and indirectly by `LocalProcess::read` and tests. It depends on `stream_output`, `watch_exit`, and `maybe_emit_closed` to populate retained chunks and terminal flags.

*Call graph*: calls 1 internal fn (invalid_request); called by 3 (read, read_process_until_change, exec_read); 6 external calls (clone, from_millis, new, format!, now, timeout).


##### `LocalProcess::exec_write`  (lines 360–393)

```
async fn exec_write(
        &self,
        params: WriteParams,
    ) -> Result<WriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes input bytes to a running process’s stdin when that process was started with a writable input channel. It reports status rather than failing for common non-running cases.

**Data flow**: It inspects `params.chunk` length for metrics, locks the process map, returns `UnknownProcess` if absent, `Starting` if not yet running, or `StdinClosed` if neither `tty` nor `pipe_stdin` is enabled. Otherwise it obtains `process.session.writer_sender()`, sends the owned bytes asynchronously, maps send failure to `internal_error`, and returns `WriteResponse { status: Accepted }`.

**Call relations**: Used by RPC handlers and by `LocalProcess::write`. It relies on the session object created in `start_process` to expose the stdin writer channel.

*Call graph*: called by 2 (write, exec_write).


##### `LocalProcess::signal_process`  (lines 395–416)

```
async fn signal_process(
        &self,
        params: SignalParams,
    ) -> Result<SignalResponse, JSONRPCErrorError>
```

**Purpose**: Sends a signal to a running process if it has not already exited. Missing or still-starting processes are treated as no-ops.

**Data flow**: It locks the process map, matches the target entry, returns success immediately if the process is already exited, otherwise converts the protocol `ProcessSignal` with `pty_process_signal` and calls `process.session.signal(...)`, mapping any failure to `internal_error`. It always returns `SignalResponse {}`.

**Call relations**: Called by RPC handlers and by `LocalProcess::signal`. The only currently supported signal mapping is handled by `pty_process_signal`.

*Call graph*: calls 1 internal fn (pty_process_signal); called by 2 (signal, signal).


##### `LocalProcess::terminate_process`  (lines 418–437)

```
async fn terminate_process(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, JSONRPCErrorError>
```

**Purpose**: Requests termination of a running process and reports whether it was still running at the time of the request. It is the explicit kill/terminate API.

**Data flow**: It locks the process map, checks the target entry, returns `running: false` for missing, starting, or already-exited processes, otherwise calls `process.session.terminate()` and returns `TerminateResponse { running: true }`.

**Call relations**: Used by RPC handlers and by `LocalProcess::terminate`. Actual exit observation still happens asynchronously through `watch_exit`.

*Call graph*: called by 2 (terminate, terminate).


##### `child_env`  (lines 440–449)

```
fn child_env(params: &ExecParams) -> HashMap<String, String>
```

**Purpose**: Builds the environment map for a child process, either using the explicit environment exactly or applying a shell-environment policy first and then overlaying explicit variables. It defines the backend’s environment-merging semantics.

**Data flow**: If `params.env_policy` is `None`, it clones and returns `params.env`. Otherwise it converts the policy with `shell_environment_policy`, calls `shell_environment::create_env(&policy, None)`, extends that map with `params.env.clone()`, and returns the merged `HashMap<String, String>`.

**Call relations**: Only `start_process` calls this before spawning. Tests verify both the exact-env path and the policy-then-overlay behavior.

*Call graph*: calls 2 internal fn (shell_environment_policy, create_env); called by 1 (start_process).


##### `shell_environment_policy`  (lines 451–468)

```
fn shell_environment_policy(env_policy: &ExecEnvPolicy) -> ShellEnvironmentPolicy
```

**Purpose**: Converts the RPC-facing `ExecEnvPolicy` into the lower-level `ShellEnvironmentPolicy` expected by `codex_protocol::shell_environment`. It also normalizes pattern matching to case-insensitive environment-variable patterns.

**Data flow**: It copies `inherit`, `ignore_default_excludes`, and `r#set`, maps each `exclude` and `include_only` string into `EnvironmentVariablePattern::new_case_insensitive`, sets `use_profile` to `false`, and returns the assembled `ShellEnvironmentPolicy`.

**Call relations**: Called only by `child_env` when an environment policy is present.

*Call graph*: called by 1 (child_env).


##### `LocalProcess::start`  (lines 488–490)

```
fn start(&self, params: ExecParams) -> ExecBackendFuture<'_>
```

**Purpose**: Starts a process and wraps it as a trait object implementing `ExecProcess`. This is the `ExecBackend`-facing constructor path.

**Data flow**: It awaits `start_process(params)`, maps any `JSONRPCErrorError` through `map_handler_error`, constructs `LocalExecProcess { process_id, backend: self.clone(), wake_tx, events }`, wraps it in `Arc`, and returns `StartedExecProcess { process }`.

**Call relations**: The `ExecBackend` trait implementation boxes this method. It bridges the RPC-style startup routine into the trait-based process abstraction.

*Call graph*: calls 1 internal fn (start_process); 2 external calls (new, pin).


##### `LocalExecProcess::process_id`  (lines 519–521)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Returns the stable process identifier for this started process handle. It exposes the ID without any async work.

**Data flow**: It reads `self.process_id` and returns a shared reference.

**Call relations**: This satisfies the `ExecProcess` trait and is used by callers that need to correlate the handle with backend state.


##### `LocalExecProcess::subscribe_wake`  (lines 523–525)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Creates a watch receiver that is notified whenever the process advances its sequence number. It supports efficient wakeups for consumers polling for changes.

**Data flow**: It calls `self.wake_tx.subscribe()` and returns the new `watch::Receiver<u64>`.

**Call relations**: Part of the `ExecProcess` trait implementation. Sequence updates are sent by `stream_output`, `watch_exit`, and `maybe_emit_closed`.

*Call graph*: 1 external calls (subscribe).


##### `LocalExecProcess::subscribe_events`  (lines 527–529)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Subscribes to the retained process event log. It gives consumers a stream of structured output/exited/closed events.

**Data flow**: It calls `self.events.subscribe()` and returns an `ExecProcessEventReceiver`.

**Call relations**: This is the event-stream half of the `ExecProcess` trait. Events are published by `stream_output`, `watch_exit`, and `maybe_emit_closed`.

*Call graph*: calls 1 internal fn (subscribe).


##### `LocalExecProcess::read`  (lines 531–538)

```
fn read(
        &self,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> ExecProcessFuture<'_, ReadResponse>
```

**Purpose**: Reads output and terminal state for this specific process handle. It is the trait-facing wrapper around backend reads.

**Data flow**: It forwards `after_seq`, `max_bytes`, and `wait_ms` plus `self.process_id` to `self.backend.read(...)`, awaits the result, and returns `ReadResponse` or `ExecServerError`.

**Call relations**: The `ExecProcess` trait boxes this method. It delegates all actual read logic to `LocalProcess::read` and ultimately `exec_read`.

*Call graph*: calls 1 internal fn (read); 1 external calls (pin).


##### `LocalExecProcess::write`  (lines 540–542)

```
fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Writes bytes to this process’s stdin through the backend. It is the trait-facing wrapper for input delivery.

**Data flow**: It forwards `self.process_id` and the owned `chunk` to `self.backend.write(...)`, awaits the result, and returns `WriteResponse` or `ExecServerError`.

**Call relations**: Boxed by the `ExecProcess` trait implementation and delegated to `LocalProcess::write`.

*Call graph*: calls 1 internal fn (write); 1 external calls (pin).


##### `LocalExecProcess::signal`  (lines 544–546)

```
fn signal(&self, signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Sends a protocol signal to this process through the backend. It exposes signaling on the started-process handle.

**Data flow**: It forwards `self.process_id` and `signal` to `self.backend.signal(...)`, awaits completion, and returns `()` or `ExecServerError`.

**Call relations**: Boxed by the `ExecProcess` trait implementation and delegated to `LocalProcess::signal`.

*Call graph*: calls 1 internal fn (signal); 1 external calls (pin).


##### `LocalExecProcess::terminate`  (lines 548–550)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Requests termination of this process through the backend. It is the trait-facing kill path.

**Data flow**: It forwards `self.process_id` to `self.backend.terminate(...)`, awaits completion, and returns `()` or `ExecServerError`.

**Call relations**: Boxed by the `ExecProcess` trait implementation and delegated to `LocalProcess::terminate`.

*Call graph*: calls 1 internal fn (terminate); 1 external calls (pin).


##### `LocalProcess::read`  (lines 554–569)

```
async fn read(
        &self,
        process_id: &ProcessId,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> Result<ReadResponse, ExecServerEr
```

**Purpose**: Backend-internal convenience wrapper that reads by `ProcessId` and maps RPC-style errors into `ExecServerError`. It adapts the RPC parameter struct to the trait-oriented API.

**Data flow**: It constructs `ReadParams { process_id: process_id.clone(), after_seq, max_bytes, wait_ms }`, awaits `self.exec_read(...)`, maps any `JSONRPCErrorError` with `map_handler_error`, and returns `ReadResponse`.

**Call relations**: Called by `LocalExecProcess::read`. It exists to reuse `exec_read` rather than duplicating read logic.

*Call graph*: calls 1 internal fn (exec_read); called by 1 (read); 1 external calls (clone).


##### `LocalProcess::write`  (lines 571–582)

```
async fn write(
        &self,
        process_id: &ProcessId,
        chunk: Vec<u8>,
    ) -> Result<WriteResponse, ExecServerError>
```

**Purpose**: Backend-internal convenience wrapper that writes to a process by ID and maps handler errors into `ExecServerError`. It adapts the trait API to the RPC-style implementation.

**Data flow**: It constructs `WriteParams { process_id: process_id.clone(), chunk: chunk.into() }`, awaits `self.exec_write(...)`, maps errors with `map_handler_error`, and returns `WriteResponse`.

**Call relations**: Called by `LocalExecProcess::write`, reusing the main `exec_write` implementation.

*Call graph*: calls 1 internal fn (exec_write); called by 1 (write); 1 external calls (clone).


##### `LocalProcess::signal`  (lines 584–596)

```
async fn signal(
        &self,
        process_id: &ProcessId,
        signal: ProcessSignal,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Backend-internal convenience wrapper that signals a process by ID and maps handler errors into `ExecServerError`. It hides the RPC parameter struct from trait consumers.

**Data flow**: It constructs `SignalParams { process_id: process_id.clone(), signal }`, awaits `self.signal_process(...)`, maps errors with `map_handler_error`, discards the empty response, and returns `Ok(())`.

**Call relations**: Called by `LocalExecProcess::signal`, reusing the main signaling implementation.

*Call graph*: calls 1 internal fn (signal_process); called by 1 (signal); 1 external calls (clone).


##### `LocalProcess::terminate`  (lines 598–605)

```
async fn terminate(&self, process_id: &ProcessId) -> Result<(), ExecServerError>
```

**Purpose**: Backend-internal convenience wrapper that terminates a process by ID and maps handler errors into `ExecServerError`. It adapts the trait API to the RPC-style implementation.

**Data flow**: It constructs `TerminateParams { process_id: process_id.clone() }`, awaits `self.terminate_process(...)`, maps errors with `map_handler_error`, discards the `running` flag, and returns `Ok(())`.

**Call relations**: Called by `LocalExecProcess::terminate`, reusing the main termination implementation.

*Call graph*: calls 1 internal fn (terminate_process); called by 1 (terminate); 1 external calls (clone).


##### `pty_process_signal`  (lines 608–612)

```
fn pty_process_signal(signal: ProcessSignal) -> PtyProcessSignal
```

**Purpose**: Maps protocol-level process signals to the PTY library’s signal enum. It is the translation layer between exec-server protocol types and `codex_utils_pty`.

**Data flow**: It matches on `ProcessSignal` and returns the corresponding `PtyProcessSignal`; currently `Interrupt` maps directly to `PtyProcessSignal::Interrupt`.

**Call relations**: Only `signal_process` calls this before invoking `session.signal(...)`.

*Call graph*: called by 1 (signal_process).


##### `map_handler_error`  (lines 614–619)

```
fn map_handler_error(error: JSONRPCErrorError) -> ExecServerError
```

**Purpose**: Converts a JSON-RPC handler error into the backend’s `ExecServerError::Server` form. It preserves the numeric code and message.

**Data flow**: It reads `error.code` and `error.message` from `JSONRPCErrorError` and returns `ExecServerError::Server { code, message }`.

**Call relations**: Used by trait-oriented wrappers like `start`, `read`, `write`, `signal`, and `terminate` to reuse RPC-style implementations without exposing JSON-RPC error types.


##### `stream_output`  (lines 621–677)

```
async fn stream_output(
    process_id: ProcessId,
    stream: ExecOutputStream,
    mut receiver: tokio::sync::mpsc::Receiver<Vec<u8>>,
    inner: Arc<Inner>,
    output_notify: Arc<Notify>,
)
```

**Purpose**: Consumes one child output stream, sequences and retains chunks, publishes events and notifications, and wakes blocked readers. It is the core ingestion loop for stdout/stderr or PTY output.

**Data flow**: It repeatedly awaits `receiver.recv()`. For each chunk, it locks the process map, finds the running process, assigns `seq = next_seq`, increments `next_seq`, adds the chunk length to `retained_bytes`, pushes `RetainedOutputChunk { seq, stream, chunk: chunk.clone() }` into `output`, evicts oldest chunks until under `RETAINED_OUTPUT_BYTES_PER_PROCESS`, sends the new seq on `wake_tx`, publishes `ExecProcessEvent::Output`, and builds `ExecOutputDeltaNotification`. After releasing the lock it notifies `output_notify` waiters and, if a notification sender exists, asynchronously emits the JSON-RPC notification. When the receiver ends, it calls `finish_output_stream(process_id, inner).await`.

**Call relations**: Spawned twice by `start_process` and by test helpers. It feeds the state later observed by `exec_read`, and hands stream-completion bookkeeping to `finish_output_stream`.

*Call graph*: calls 3 internal fn (finish_output_stream, notification_sender, recv); called by 2 (start_process, spawn_test_process); 2 external calls (Output, clone).


##### `watch_exit`  (lines 679–715)

```
async fn watch_exit(
    process_id: ProcessId,
    exit_rx: tokio::sync::oneshot::Receiver<i32>,
    inner: Arc<Inner>,
    output_notify: Arc<Notify>,
)
```

**Purpose**: Waits for the child process exit code, records the exit event, notifies readers, emits an exit notification, and then checks whether the process can be marked closed. It is the exit-side counterpart to `stream_output`.

**Data flow**: It awaits the oneshot `exit_rx`, defaulting to `-1` if the sender is dropped. It locks the process map, and if the process is still running, assigns a new sequence number, stores `exit_code`, sends the seq on `wake_tx`, publishes `ExecProcessEvent::Exited { seq, exit_code }`, and builds `ExecExitedNotification`. It then notifies `output_notify`, optionally sends the exit notification through `notification_sender`, and finally awaits `maybe_emit_closed(process_id, inner)`.

**Call relations**: Spawned by `start_process` and test helpers. It depends on `maybe_emit_closed` to emit the final closed event only after output streams have also ended.

*Call graph*: calls 2 internal fn (maybe_emit_closed, notification_sender); called by 2 (start_process, spawn_test_process); 2 external calls (clone, clone).


##### `finish_output_stream`  (lines 717–730)

```
async fn finish_output_stream(process_id: ProcessId, inner: Arc<Inner>)
```

**Purpose**: Marks one output stream as finished and then checks whether the process can now transition to closed. It tracks the countdown of remaining open output streams.

**Data flow**: It locks the process map, finds the running process, decrements `open_streams` if it is greater than zero, releases the lock, and then awaits `maybe_emit_closed(process_id, inner)`.

**Call relations**: Called at the end of each `stream_output` task. Closure is deferred to `maybe_emit_closed` because exit and both stream completions must all be observed.

*Call graph*: calls 1 internal fn (maybe_emit_closed); called by 1 (stream_output).


##### `maybe_emit_closed`  (lines 732–778)

```
async fn maybe_emit_closed(process_id: ProcessId, inner: Arc<Inner>)
```

**Purpose**: Transitions a process into the final closed state once it has exited and all output streams are finished, emits the closed event/notification, and schedules delayed eviction from the process table. It is the final lifecycle gate for process retention.

**Data flow**: It locks the process map, returns early unless the process exists, is running, is not already closed, has `open_streams == 0`, and has `exit_code.is_some()`. It then sets `closed = true`, assigns a new sequence number, sends it on `wake_tx`, publishes `ExecProcessEvent::Closed { seq }`, clones `output_notify`, and builds `ExecClosedNotification`. After releasing the lock it notifies waiters, spawns a cleanup task that sleeps `EXITED_PROCESS_RETENTION` and removes the process entry only if it is still present and still closed, and optionally sends the closed notification through `notification_sender`.

**Call relations**: Called from both `watch_exit` and `finish_output_stream`, so either side can trigger the final close once the other prerequisites are already satisfied. The delayed cleanup behavior is what allows tests to observe retention and eventual eviction.

*Call graph*: calls 1 internal fn (notification_sender); called by 2 (finish_output_stream, watch_exit); 5 external calls (clone, clone, matches!, spawn, sleep).


##### `notification_sender`  (lines 780–786)

```
fn notification_sender(inner: &Inner) -> Option<RpcNotificationSender>
```

**Purpose**: Reads the current optional RPC notification sender from shared backend state. It centralizes poisoned-lock recovery for notification access.

**Data flow**: It acquires a read lock on `inner.notifications`, recovering from poisoning if necessary, clones the stored `Option<RpcNotificationSender>`, and returns it.

**Call relations**: Used by `stream_output`, `watch_exit`, and `maybe_emit_closed` whenever they need to emit outbound notifications without holding the process-map mutex.

*Call graph*: called by 3 (maybe_emit_closed, stream_output, watch_exit).


##### `tests::test_exec_params`  (lines 798–809)

```
fn test_exec_params(env: HashMap<String, String>) -> ExecParams
```

**Purpose**: Builds a minimal valid `ExecParams` fixture for tests, with a real current working directory and configurable environment map. It reduces duplication across process tests.

**Data flow**: It constructs `ExecParams` with a fixed `process_id`, `argv = ["true"]`, `cwd` from `PathUri::from_path(current_dir())`, `env_policy = None`, the provided `env`, and `tty/pipe_stdin/arg0` defaults.

**Call relations**: Used by multiple tests that need a baseline parameter set before mutating one field under test.

*Call graph*: calls 2 internal fn (from, from_path); 2 external calls (current_dir, vec!).


##### `tests::start_process_rejects_non_native_cwd_before_launch`  (lines 812–833)

```
async fn start_process_rejects_non_native_cwd_before_launch()
```

**Purpose**: Verifies that `start_process` rejects a non-native cwd URI before attempting to spawn a child. It protects the early validation path for `params.cwd`.

**Data flow**: It constructs a platform-opposite `file:` URI, parses it into `PathUri`, confirms `to_abs_path()` fails, builds the expected `invalid_params` error string, inserts that cwd into `test_exec_params`, calls `LocalProcess::default().start_process(params).await`, and asserts the returned error equals the expected one.

**Call relations**: This test exercises the cwd conversion branch inside `start_process`, ensuring invalid host paths are reported as parameter errors rather than internal spawn failures.

*Call graph*: calls 3 internal fn (default, invalid_params, parse); 5 external calls (new, assert_eq!, test_exec_params, format!, panic!).


##### `tests::child_env_defaults_to_exact_env`  (lines 836–843)

```
fn child_env_defaults_to_exact_env()
```

**Purpose**: Checks that `child_env` returns the explicit environment unchanged when no policy is supplied. It documents the no-policy semantics.

**Data flow**: It builds test params with a one-variable environment, calls `child_env(&params)`, and asserts the returned `HashMap` exactly matches the input map.

**Call relations**: This test covers the early-return branch in `child_env` where `env_policy` is `None`.

*Call graph*: 3 external calls (from, assert_eq!, test_exec_params).


##### `tests::child_env_applies_policy_then_overlay`  (lines 846–868)

```
fn child_env_applies_policy_then_overlay()
```

**Purpose**: Verifies that policy-derived environment variables are created first and then overridden by explicit `params.env` entries. It captures the intended precedence rules.

**Data flow**: It builds params with overlay variables, installs an `ExecEnvPolicy` that sets `POLICY_SET`, computes the expected merged map (including Windows `PATHEXT` when applicable), calls `child_env(&params)`, and asserts equality.

**Call relations**: This test exercises both `shell_environment_policy` and `child_env`, specifically the `env.extend(params.env.clone())` overlay behavior.

*Call graph*: 5 external calls (from, new, assert_eq!, cfg!, test_exec_params).


##### `tests::exited_process_retains_late_output_past_retention`  (lines 871–919)

```
async fn exited_process_retains_late_output_past_retention()
```

**Purpose**: Verifies that a process which has exited but whose output streams remain open can still deliver late output even after the retention delay. It protects the distinction between `exited` and `closed`.

**Data flow**: It creates a backend and synthetic running process via `spawn_test_process`, sends an exit code, reads until the exit event is visible, sleeps past `EXITED_PROCESS_RETENTION`, sends a late stdout chunk, reads again after seq 1, asserts the late chunk appears with seq 2 and `closed == false`, then drops both output senders, waits until a closed response arrives, and shuts down the backend.

**Call relations**: This test drives `watch_exit`, `stream_output`, and `maybe_emit_closed` together, proving cleanup is not triggered merely by elapsed retention time after exit.

*Call graph*: calls 1 internal fn (default); 9 external calls (from_millis, from_secs, assert!, assert_eq!, read_process_until_change, read_process_until_closed, spawn_test_process, sleep, timeout).


##### `tests::closed_process_is_evicted_after_retention`  (lines 922–953)

```
async fn closed_process_is_evicted_after_retention()
```

**Purpose**: Verifies that once a process is both exited and closed, it is eventually removed from the process table after the configured retention period. It protects the delayed-eviction cleanup path.

**Data flow**: It creates a backend and synthetic process, sends an exit code, drops both output senders so closure can occur, waits for a closed response, then repeatedly checks `backend.inner.processes` until the process ID disappears or a timeout expires, and finally shuts down the backend.

**Call relations**: This test specifically exercises the cleanup task spawned by `maybe_emit_closed`.

*Call graph*: calls 1 internal fn (default); 7 external calls (from_millis, from_secs, assert!, read_process_until_closed, spawn_test_process, sleep, timeout).


##### `tests::TestProcess::exit`  (lines 963–969)

```
fn exit(&mut self, exit_code: i32)
```

**Purpose**: Sends the synthetic process’s exit code exactly once in tests. It models child-process termination for the background `watch_exit` task.

**Data flow**: It takes the stored `oneshot::Sender<i32>` from `self.exit_tx`, panics if it was already used, sends the provided `exit_code`, and panics if the send fails.

**Call relations**: Used by tests that simulate process exit after installing a fake running process with `spawn_test_process`.


##### `tests::spawn_test_process`  (lines 972–1032)

```
async fn spawn_test_process(backend: &LocalProcess, process_id: &str) -> TestProcess
```

**Purpose**: Installs a synthetic running process directly into the backend and launches the same output/exit watcher tasks used for real processes. It provides deterministic control over stdout, stderr, and exit timing in tests.

**Data flow**: It creates channels for stdout, stderr, and exit; creates `Notify`, `watch::channel`, and `ExecProcessEventLog`; inserts a `ProcessEntry::Running(Box<RunningProcess { ... dummy_session(), tty: false, pipe_stdin: false, ... open_streams: 2, closed: false }>)` into `backend.inner.processes`; spawns two `stream_output` tasks and one `watch_exit` task; and returns `TestProcess { process_id, stdout_tx, stderr_tx, exit_tx: Some(exit_tx) }`.

**Call relations**: Used by retention/eviction tests to exercise the real background lifecycle logic without spawning OS processes.

*Call graph*: calls 4 internal fn (stream_output, watch_exit, new, from); 12 external calls (clone, new, new, new, new, assert!, Running, dummy_session, channel, channel (+2 more)).


##### `tests::dummy_session`  (lines 1034–1050)

```
fn dummy_session() -> ExecCommandSession
```

**Purpose**: Creates a minimal `ExecCommandSession` suitable for tests that never actually write to or signal a real child process. It satisfies the `RunningProcess` shape expected by the backend.

**Data flow**: It creates placeholder writer, stdout, stderr, and exit channels, packages them into `ProcessDriver`, calls `codex_utils_pty::spawn_from_driver(...)`, and returns the resulting `.session`.

**Call relations**: Only `spawn_test_process` uses this helper to populate the synthetic `RunningProcess`.

*Call graph*: 4 external calls (spawn_from_driver, channel, channel, channel).


##### `tests::read_process_until_change`  (lines 1052–1069)

```
async fn read_process_until_change(
        backend: &LocalProcess,
        process_id: &ProcessId,
        after_seq: Option<u64>,
    ) -> ReadResponse
```

**Purpose**: Convenience helper that performs a blocking `exec_read` with a one-second timeout and returns the response. It simplifies tests that wait for the next observable process change.

**Data flow**: It calls `backend.exec_read(ReadParams { process_id: process_id.clone(), after_seq, max_bytes: None, wait_ms: Some(1000) })` inside `tokio::time::timeout(Duration::from_secs(1), ...)`, unwraps both timeout and read success, and returns the `ReadResponse`.

**Call relations**: Used by tests that need to observe exit, output, or close transitions without duplicating timeout boilerplate.

*Call graph*: calls 1 internal fn (exec_read); 3 external calls (from_secs, clone, timeout).


##### `tests::read_process_until_closed`  (lines 1071–1086)

```
async fn read_process_until_closed(
        backend: &LocalProcess,
        process_id: &ProcessId,
    ) -> ReadResponse
```

**Purpose**: Repeatedly reads process state until the backend reports `closed = true`. It abstracts the sequence bookkeeping needed to follow a process through multiple changes.

**Data flow**: It loops calling `read_process_until_change`, returns immediately when `response.closed` is true, otherwise advances `after_seq` to the highest observed chunk seq or `response.next_seq - 1`, and repeats.

**Call relations**: Used by tests that need to wait for the final closed transition after exit and stream completion.

*Call graph*: 1 external calls (read_process_until_change).


### `exec-server/src/remote_process.rs`

`io_transport` · `request handling and remote process lifetime`

This file defines two small wrappers with distinct lifetimes: `RemoteProcess`, which is the backend used to start a remote process, and `RemoteExecProcess`, which is the live process handle returned after startup. `RemoteProcess::start` is the key transition point: it clones the `process_id` from `ExecParams`, acquires the underlying remote client from `LazyRemoteExecServerClient`, registers a `Session` for that process id, and only then sends the remote `exec` request. That ordering ensures reads/events can be associated with the process immediately; if the `exec` RPC fails, it explicitly unregisters the session before returning the error.

Once started, `RemoteExecProcess` is almost entirely a thin delegation layer over `Session`. It exposes the process id, wake subscription, event subscription, and async read/write/signal/terminate operations required by `ExecProcess`, boxing each async method into the trait’s future type. The concrete I/O semantics live in `Session`; this file preserves them while adding trace logging for mutating operations.

A notable lifecycle detail is cleanup on drop: `RemoteExecProcess` clones its `Session` and spawns a detached Tokio task that calls `unregister()`. That means session teardown is best-effort and asynchronous, avoiding blocking drop while still cleaning up abandoned remote registrations when callers forget to terminate explicitly.

#### Function details

##### `RemoteProcess::new`  (lines 29–32)

```
fn new(client: LazyRemoteExecServerClient) -> Self
```

**Purpose**: Constructs a `RemoteProcess` backend around a `LazyRemoteExecServerClient` and emits a trace message for backend creation.

**Data flow**: Takes ownership of a lazily initialized remote client wrapper, stores it in the `client` field unchanged, and returns a new `RemoteProcess` value. Its only side effect is a tracing event.

**Call relations**: This constructor is used when higher-level setup chooses the remote execution transport path. After construction, callers use the resulting backend through the `ExecBackend` trait, which routes startup into `RemoteProcess::start`.

*Call graph*: called by 1 (remote_with_transport); 1 external calls (trace!).


##### `RemoteProcess::start`  (lines 53–55)

```
fn start(&self, params: ExecParams) -> ExecBackendFuture<'_>
```

**Purpose**: Starts a remote process by registering a session for the requested process id and then issuing the remote exec request, returning a trait object-backed started process handle on success.

**Data flow**: Consumes `ExecParams` by value, clones `params.process_id` for session registration, awaits `self.client.get()` to obtain the concrete client, then awaits `register_session(&process_id)` to create a `Session`. It next sends `client.exec(params)`. On failure it asynchronously unregisters the session and returns the original error; on success it wraps `RemoteExecProcess { session }` in an `Arc` inside `StartedExecProcess`.

**Call relations**: This async implementation is invoked by the `ExecBackend` trait adapter for remote backends. It depends on the lazy client acquisition and session registration path before delegating execution to the remote client; its cleanup branch exists specifically because registration happens before the exec RPC.

*Call graph*: calls 1 internal fn (get); 2 external calls (new, pin).


##### `RemoteExecProcess::process_id`  (lines 85–87)

```
fn process_id(&self) -> &crate::ProcessId
```

**Purpose**: Returns the process identifier associated with the remote session-backed process handle.

**Data flow**: Reads `self.session` and forwards to `session.process_id()`, returning a borrowed `ProcessId` reference without modifying any state.

**Call relations**: Called by code using the `ExecProcess` trait when it needs stable identity for the running process. It is a pure accessor over the underlying session object.

*Call graph*: 1 external calls (process_id).


##### `RemoteExecProcess::subscribe_wake`  (lines 89–91)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Provides a watch receiver that signals output/progress wakeups for the remote process stream.

**Data flow**: Reads `self.session` and returns the `watch::Receiver<u64>` produced by `session.subscribe_wake()`. No local transformation or mutation occurs.

**Call relations**: Used by consumers of the `ExecProcess` trait that long-poll or reactively wait for new remote output. This method simply exposes the session’s wake-notification mechanism.

*Call graph*: 1 external calls (subscribe_wake).


##### `RemoteExecProcess::subscribe_events`  (lines 93–95)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Returns the event receiver for process lifecycle/events emitted by the remote session.

**Data flow**: Delegates directly to `self.session.subscribe_events()` and returns the resulting `ExecProcessEventReceiver` unchanged.

**Call relations**: Called by higher-level process monitoring code through the `ExecProcess` trait. It participates in the event flow by exposing the session’s existing event channel rather than creating a new one.

*Call graph*: 1 external calls (subscribe_events).


##### `RemoteExecProcess::read`  (lines 97–104)

```
fn read(
        &self,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> ExecProcessFuture<'_, ReadResponse>
```

**Purpose**: Reads process output from the remote session, optionally after a sequence number, with byte and wait limits.

**Data flow**: Accepts `after_seq`, `max_bytes`, and `wait_ms`, forwards them unchanged to `self.session.read(...)`, awaits the remote/session result, and returns a `ReadResponse` or `ExecServerError`.

**Call relations**: This boxed future implementation is reached through the `ExecProcess` trait’s `read` method. It delegates all sequencing and blocking semantics to the session layer, which is why this file contains no additional buffering logic.

*Call graph*: 2 external calls (pin, read).


##### `RemoteExecProcess::write`  (lines 106–108)

```
fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Sends a chunk of stdin/input bytes to the remote process and traces the write operation.

**Data flow**: Consumes a `Vec<u8>` chunk, emits a trace log, forwards the bytes to `self.session.write(chunk)`, awaits completion, and returns the resulting `WriteResponse` or error.

**Call relations**: Invoked via the `ExecProcess` trait when callers write to the running process. It is a thin transport adapter over session I/O with added observability.

*Call graph*: 3 external calls (pin, write, trace!).


##### `RemoteExecProcess::signal`  (lines 110–112)

```
fn signal(&self, signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Forwards a process signal request to the remote session and traces that control action.

**Data flow**: Takes a `ProcessSignal`, logs the action, awaits `self.session.signal(signal)`, and returns `()` on success or an `ExecServerError` on failure.

**Call relations**: Reached through the `ExecProcess` trait’s signal path when callers need to interrupt or otherwise control the remote process. It delegates actual signal delivery to the session implementation.

*Call graph*: 3 external calls (pin, signal, trace!).


##### `RemoteExecProcess::terminate`  (lines 114–116)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Requests termination of the remote process through the session and traces the request.

**Data flow**: Reads `self.session`, emits a trace event, awaits `session.terminate()`, and returns success/failure without additional transformation.

**Call relations**: Called through the `ExecProcess` trait when the process should be shut down explicitly. It is the explicit counterpart to the implicit unregister cleanup performed in `Drop`.

*Call graph*: 3 external calls (pin, terminate, trace!).


##### `RemoteExecProcess::drop`  (lines 120–125)

```
fn drop(&mut self)
```

**Purpose**: Performs asynchronous best-effort session cleanup when the remote process handle is dropped.

**Data flow**: Clones `self.session` into a new owned value, then spawns a Tokio task that awaits `session.unregister()`. It returns no value and cannot report unregister failures.

**Call relations**: This runs automatically when the last `RemoteExecProcess` handle is dropped. It is not part of normal call-based control flow, but it closes the lifecycle loop for sessions created by `RemoteProcess::start`.

*Call graph*: 2 external calls (clone, spawn).


### Shared spawning and backend selection
These files expose the common OS process spawn boundary and the top-level unified-exec backend families available to the system.

### `core/src/spawn.rs`

`io_transport` · `subprocess launch during tool and shell command execution`

This file defines the data needed to spawn a child process in a controlled way and implements the async launcher. `SpawnChildRequest` bundles the executable path, argument vector, optional Unix `arg0` override, absolute working directory, network sandbox policy, optional `NetworkProxy`, stdio policy, and a complete environment map. Two environment variable constants document the sandbox contract exposed to child processes: `CODEX_SANDBOX_NETWORK_DISABLED` is set when network sandboxing is not enabled for the tool call, and `CODEX_SANDBOX` is reserved for broader sandbox identification.

`spawn_child_async` destructures the request, logs the full launch configuration at trace level, and builds a `tokio::process::Command`. On Unix it sets `arg0`, allowing the visible argv[0] to differ from the executable path. It applies the working directory, optionally mutates the environment through the network proxy, clears inherited environment variables, and then installs only the provided environment map. If network sandboxing is disabled, it explicitly marks that in the child environment. On Unix, `pre_exec` optionally detaches the child from the controlling TTY for shell-tool calls and, on Linux, requests a parent-death signal so orphaned children terminate when Codex dies. Finally, stdio is configured either for captured shell-tool execution (`stdin` null, `stdout`/`stderr` piped) or full inheritance, and `kill_on_drop(true)` ensures abandoned child handles terminate the process.

#### Function details

##### `spawn_child_async`  (lines 51–126)

```
async fn spawn_child_async(request: SpawnChildRequest<'_>) -> std::io::Result<Child>
```

**Purpose**: Builds and spawns a child process from a fully specified request, applying environment isolation, proxy settings, sandbox markers, Unix pre-exec hooks, and the requested stdio behavior.

**Data flow**: Consumes `SpawnChildRequest`; reads `program`, `args`, optional `arg0`, `cwd`, `network_sandbox_policy`, optional `network`, `stdio_policy`, and mutable `env`; constructs `tokio::process::Command`, sets args/current dir, optionally mutates env via `network.apply_to_env`, clears inherited env and installs the provided map, conditionally sets `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR`, installs Unix `pre_exec` hooks for TTY detachment and Linux parent-death signaling, configures stdio as null+piped or inherited, enables `kill_on_drop(true)`, and returns `std::io::Result<Child>` from `spawn()`.

**Call relations**: Called by higher-level execution paths such as generic exec and Linux sandbox spawning. It is the single subprocess-construction point those flows delegate to.

*Call graph*: called by 2 (exec, spawn_command_under_linux_sandbox); 7 external calls (inherit, null, piped, new, getpid, matches!, trace!).


### `windows-sandbox-rs/src/unified_exec/backends/mod.rs`

`orchestration` · `startup`

This file is the backend namespace hub for the `unified_exec` subsystem. It declares three crate-visible backend modules: `elevated`, `legacy`, and `windows_common`. The arrangement suggests that unified execution can dispatch between at least two concrete backend strategies—an elevated path and a legacy path—while sharing lower-level Windows-specific helpers through `windows_common`. The file itself contains no branching or runtime behavior; its significance is architectural. By collecting backend implementations under a single `backends` module, the crate can keep backend selection logic elsewhere while preserving a clean internal module tree. The `pub(crate)` visibility indicates these backends are intended for internal composition rather than direct public API use. This also gives maintainers freedom to evolve backend internals without breaking external callers. In practice, this file is active whenever the crate is compiled and whenever code in the unified execution layer resolves backend-specific types or functions, but it deliberately avoids embedding policy or execution logic here.


### Portable PTY and pipe interfaces
These files present the public PTY crate surface and its cross-platform process-group, pipe, and PTY-backed session implementations.

### `utils/pty/src/lib.rs`

`io_transport` · `process spawn / interactive session handling`

This library root organizes the PTY/process subsystem into several modules: `pipe` for regular stdin/stdout/stderr transport, `process` for the common handle and driver abstractions, `process_group` for grouped process control, `pty` for pseudo-terminal spawning, and Windows-specific support under `win`. It also conditionally includes internal tests. The crate-level constant `DEFAULT_OUTPUT_BYTES_CAP` establishes a default one-megabyte cap for captured output, signaling that spawned-process output is intentionally bounded.

Most of the file is public re-export wiring. It exposes spawn helpers for pipe-based and PTY-based execution, common process interaction types such as `ProcessHandle`, `SpawnedProcess`, `ProcessSignal`, and `TerminalSize`, and adapter utilities like `combine_output_receivers` and `spawn_from_driver` for integrations that already own the transport layer. Two type aliases, `ExecCommandSession` and `SpawnedPty`, preserve backwards compatibility with older naming. On Windows, it additionally re-exports ConPTY-related types and a capability probe via `conpty_supported`. The design centers on presenting one coherent process-execution API regardless of transport, while hiding the internal module split and platform-specific implementation details from callers.


### `utils/pty/src/process_group.rs`

`util` · `spawn setup and termination`

This module centralizes the low-level OS calls that make process cleanup semantics consistent across the pipe and PTY backends. On Unix, it can detach a child from the parent's controlling terminal with `setsid`, fall back to `setpgid(0, 0)` when `setsid` fails with `EPERM`, and send signals to whole process groups rather than single PIDs. That distinction matters because shells, REPLs, and background jobs often spawn grandchildren that would otherwise survive if only the direct child were killed.

The Linux-only `set_parent_death_signal` helper is designed for use inside `pre_exec`: it installs `PR_SET_PDEATHSIG` with `SIGTERM`, then immediately re-checks `getppid()` against the captured parent PID to close the fork/exec race where the parent dies before the setting takes effect. Group-kill helpers are intentionally best-effort: `kill_process_group_by_pid` first resolves a PGID with `getpgid`, and both it and the lower-level `signal_process_group_id` suppress `NotFound`/`ESRCH` so callers can treat already-exited groups as success.

The public API exposes three signal flavors by process-group ID—terminate (`SIGTERM`), interrupt (`SIGINT`), and kill (`SIGKILL`)—plus a convenience helper that derives the group from a `tokio::process::Child`. Non-Unix implementations return success or `false` as appropriate so higher-level code can compile unchanged.

#### Function details

##### `set_parent_death_signal`  (lines 43–45)

```
fn set_parent_death_signal(_parent_pid: i32) -> io::Result<()>
```

**Purpose**: On Linux, arranges for the child to receive `SIGTERM` if its original parent dies and closes the race between fork and exec. On other platforms the alternate definition is a no-op.

**Data flow**: Takes the captured `parent_pid`, calls `prctl(PR_SET_PDEATHSIG, SIGTERM)`, then compares `getppid()` to the captured value. If the parent changed, it raises `SIGTERM` in the child; otherwise it returns `Ok(())`, and any syscall failure becomes `last_os_error()`.

**Call relations**: This helper is invoked from the pipe backend's Unix `pre_exec` closure. It exists specifically to make orphaned detached children self-terminate when the spawning process disappears.

*Call graph*: 4 external calls (last_os_error, getppid, prctl, raise).


##### `detach_from_tty`  (lines 63–65)

```
fn detach_from_tty() -> io::Result<()>
```

**Purpose**: Detaches the calling child from the controlling terminal by creating a new session. If `setsid` is not permitted because the process is already a group leader, it falls back to creating a fresh process group.

**Data flow**: Calls `libc::setsid()` and inspects the result. On success it returns `Ok(())`; on failure it reads `last_os_error()`, invokes `set_process_group()` only for `EPERM`, and otherwise returns the original error.

**Call relations**: This function is used in the pipe backend's `pre_exec` hook before exec. It delegates to `set_process_group` only in the specific fallback case where a full session detach cannot be performed.

*Call graph*: calls 1 internal fn (set_process_group); 2 external calls (last_os_error, setsid).


##### `set_process_group`  (lines 82–84)

```
fn set_process_group() -> io::Result<()>
```

**Purpose**: Places the calling process into its own process group using `setpgid(0, 0)`. It is the lighter-weight fallback when a new session cannot be created.

**Data flow**: Calls `libc::setpgid(0, 0)` and returns `Ok(())` on success or `Err(last_os_error())` on failure.

**Call relations**: This helper is called by `detach_from_tty` when `setsid` fails with `EPERM`. It gives the child a distinct process group so later group-directed signals still work.

*Call graph*: called by 1 (detach_from_tty); 2 external calls (last_os_error, setpgid).


##### `kill_process_group_by_pid`  (lines 116–118)

```
fn kill_process_group_by_pid(_pid: u32) -> io::Result<()>
```

**Purpose**: Finds the process group associated with a PID and sends `SIGKILL` to that entire group. Missing processes or groups are treated as benign.

**Data flow**: Converts the input `u32` PID to `libc::pid_t`, calls `getpgid(pid)`, and if successful calls `killpg(pgid, SIGKILL)`. It suppresses `NotFound`/`ESRCH` from either lookup or kill, returning `Ok(())` in those cases, and propagates other OS errors.

**Call relations**: This helper is used by `kill_child_process_group` when only a `tokio::process::Child` is available. It encapsulates the two-step PID-to-PGID resolution plus best-effort semantics.

*Call graph*: called by 1 (kill_child_process_group); 3 external calls (last_os_error, getpgid, killpg).


##### `signal_process_group_id`  (lines 121–134)

```
fn signal_process_group_id(pgid: libc::pid_t, signal: libc::c_int) -> io::Result<bool>
```

**Purpose**: Internal Unix helper that sends an arbitrary signal to a known process-group ID and reports whether the group existed. It is the common implementation behind terminate, interrupt, and kill.

**Data flow**: Takes a `libc::pid_t` PGID and a signal number, calls `killpg`, and returns `Ok(true)` on success. If `killpg` reports `NotFound` or `ESRCH`, it returns `Ok(false)`; any other failure becomes `Err(last_os_error())`.

**Call relations**: This private helper is called by `terminate_process_group`, `interrupt_process_group`, and `kill_process_group`. It centralizes the shared error handling and existence reporting.

*Call graph*: called by 3 (interrupt_process_group, kill_process_group, terminate_process_group); 2 external calls (last_os_error, killpg).


##### `terminate_process_group`  (lines 147–149)

```
fn terminate_process_group(_process_group_id: u32) -> io::Result<bool>
```

**Purpose**: Sends `SIGTERM` to a specific process group and tells the caller whether that group still existed. It is the soft-termination counterpart to hard kill.

**Data flow**: Converts the `u32` process-group ID to `libc::pid_t`, forwards it with `SIGTERM` to `signal_process_group_id`, and returns the resulting `io::Result<bool>`.

**Call relations**: Higher-level termination code uses this when it wants a graceful process-tree shutdown before escalating. It is a thin public wrapper over the shared signaling helper.

*Call graph*: calls 1 internal fn (signal_process_group_id); called by 2 (terminate_process_tree, terminate).


##### `interrupt_process_group`  (lines 159–161)

```
fn interrupt_process_group(_process_group_id: u32) -> io::Result<()>
```

**Purpose**: Sends `SIGINT` to a specific process group as a best-effort interrupt. It discards the existence boolean because callers only care whether the operation errored.

**Data flow**: Converts the `u32` process-group ID to `libc::pid_t`, calls `signal_process_group_id(..., SIGINT)`, maps the `bool` success indicator to `()`, and returns `io::Result<()>`.

**Call relations**: This function is used by multiple backend-specific `signal` implementations when handling `ProcessSignal::Interrupt`. It provides Ctrl-C-like semantics to the whole process group.

*Call graph*: calls 1 internal fn (signal_process_group_id); called by 3 (signal, signal, signal).


##### `kill_process_group`  (lines 171–173)

```
fn kill_process_group(_process_group_id: u32) -> io::Result<()>
```

**Purpose**: Sends `SIGKILL` to a specific process group as a best-effort hard kill. Like interrupt, it ignores whether the group already vanished.

**Data flow**: Converts the `u32` process-group ID to `libc::pid_t`, calls `signal_process_group_id(..., SIGKILL)`, maps the boolean to `()`, and returns `io::Result<()>`.

**Call relations**: This helper is the hard-stop primitive used by both pipe and PTY terminators and by other process-tree cleanup paths. It relies on `signal_process_group_id` for ESRCH suppression.

*Call graph*: calls 1 internal fn (signal_process_group_id); called by 5 (drop, kill_process_tree, kill, kill, kill).


##### `kill_child_process_group`  (lines 187–189)

```
fn kill_child_process_group(_child: &mut Child) -> io::Result<()>
```

**Purpose**: Kills the process group associated with a `tokio::process::Child` if that child still has a PID. It is a convenience wrapper for callers that have not cached the PGID separately.

**Data flow**: Reads `child.id()`, and if it yields `Some(pid)` forwards that PID to `kill_process_group_by_pid`; otherwise it returns `Ok(())`.

**Call relations**: This helper is used by code paths that manage a Tokio child directly rather than through the crate's cached process-group IDs.

*Call graph*: calls 1 internal fn (kill_process_group_by_pid); 1 external calls (id).


### `utils/pty/src/pipe.rs`

`io_transport` · `process spawn and runtime I/O forwarding`

This file is the pipe-mode spawn path for commands that should not run under a terminal emulator. Its core routine constructs a `tokio::process::Command`, clears and repopulates the environment from a provided `HashMap<String, String>`, sets the working directory, optionally overrides `argv[0]` on Unix, and configures stdin either as `Stdio::piped()` or `Stdio::null()` via the internal `PipeStdinMode` enum. On Unix, the `pre_exec` hook detaches the child from the controlling TTY, optionally installs Linux parent-death signaling, and closes inherited file descriptors except an explicit allowlist.

After spawning, the file splits child I/O into channels: one `mpsc::Sender<Vec<u8>>` for stdin writes, separate `mpsc::Receiver<Vec<u8>>` streams for stdout and stderr, and a `oneshot::Receiver<i32>` for exit status. Dedicated Tokio tasks forward stdin bytes into the child and read stdout/stderr in 8 KiB chunks using `BufReader`, tolerating `Interrupted` reads and treating EOF or other errors as stream termination. A wait task converts `ExitStatus` into the shared integer convention using `exit_code_from_status`, updates shared `AtomicBool`/`Mutex<Option<i32>>` state, and fulfills the exit oneshot.

Termination is process-group aware on Unix: `PipeChildTerminator` stores the spawned PID as a process-group ID and sends `SIGINT`/`SIGKILL` to the whole group so descendants do not survive shutdown. On Windows it falls back to direct process termination by PID.

#### Function details

##### `PipeChildTerminator::signal`  (lines 37–51)

```
fn signal(&mut self, signal: ProcessSignal) -> io::Result<()>
```

**Purpose**: Delivers an interactive-style signal to a pipe-backed child terminator. In practice it only supports `ProcessSignal::Interrupt`, mapping that to a Unix process-group interrupt and rejecting it on unsupported platforms.

**Data flow**: Reads the requested `ProcessSignal` plus the terminator's stored `process_group_id` on Unix. It matches the signal enum, transforms `Interrupt` into either `crate::process_group::interrupt_process_group(...)` or an `Unsupported` `io::Error`, and returns that result without mutating other shared state.

**Call relations**: This method is invoked through `ProcessHandle::signal` when callers want a soft interrupt instead of a hard kill. It delegates to the process-group helper so the signal reaches the whole spawned group rather than only the immediate child.

*Call graph*: calls 2 internal fn (unsupported_signal, interrupt_process_group).


##### `PipeChildTerminator::kill`  (lines 53–68)

```
fn kill(&mut self) -> io::Result<()>
```

**Purpose**: Performs the hard-stop path for a pipe-backed process. It targets the entire Unix process group when available, uses a Windows PID kill helper on Windows, and otherwise becomes a no-op on unsupported targets.

**Data flow**: Consumes mutable access to the terminator and reads either `process_group_id` or `pid` depending on platform. It converts that stored identifier into a backend-specific kill operation and returns the resulting `io::Result<()>`.

**Call relations**: This is reached from `ProcessHandle::request_terminate`, which is itself used by `ProcessHandle::terminate` and drop cleanup. It delegates to `kill_process_group` or `kill_process` so shutdown semantics match the backend's platform capabilities.

*Call graph*: calls 2 internal fn (kill_process, kill_process_group).


##### `kill_process`  (lines 72–87)

```
fn kill_process(pid: u32) -> io::Result<()>
```

**Purpose**: Implements Windows-only direct process termination by PID using Win32 APIs. It opens the process with terminate rights, calls `TerminateProcess`, and closes the handle regardless of success.

**Data flow**: Takes a `u32` PID, passes it to `OpenProcess(PROCESS_TERMINATE, ...)`, then feeds the returned handle to `TerminateProcess`. It captures `last_os_error()` before closing the handle, returns `Err` if opening or termination failed, and otherwise returns `Ok(())`.

**Call relations**: This helper is only used by `PipeChildTerminator::kill` on Windows. It isolates the unsafe Win32 sequence so the higher-level terminator can keep a platform-neutral interface.

*Call graph*: called by 1 (kill); 4 external calls (last_os_error, CloseHandle, OpenProcess, TerminateProcess).


##### `read_output_stream`  (lines 89–104)

```
async fn read_output_stream(mut reader: R, output_tx: mpsc::Sender<Vec<u8>>)
```

**Purpose**: Continuously drains one async output stream from the child and forwards each chunk into an `mpsc` channel. It stops on EOF or non-interruption errors.

**Data flow**: Accepts an `AsyncRead + Unpin` reader and an `mpsc::Sender<Vec<u8>>`. It repeatedly reads into a reusable 8,192-byte buffer, clones the read slice into a fresh `Vec<u8>` for each successful read, sends that vector to the channel, retries on `ErrorKind::Interrupted`, and returns `()` when the stream closes or errors.

**Call relations**: This function is spawned separately for stdout and stderr inside `spawn_process_with_stdin_mode`. It is the low-level bridge between OS pipe reads and the channel-based output API exposed by `SpawnedProcess`.

*Call graph*: 3 external calls (read, send, vec!).


##### `spawn_process_with_stdin_mode`  (lines 112–264)

```
async fn spawn_process_with_stdin_mode(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    stdin_mode: PipeStdinMode,
    inherit
```

**Purpose**: Creates a fully wired pipe-backed `SpawnedProcess`, including child process creation, stdin writer task, stdout/stderr reader tasks, exit tracking, and a `ProcessHandle` with termination support. It is the shared implementation behind both normal pipe spawn and no-stdin variants.

**Data flow**: Consumes the executable path, argument slice, cwd, environment map, optional `arg0`, a `PipeStdinMode`, and an inherited-FD allowlist. It validates that `program` is non-empty, builds and configures a `tokio::process::Command`, spawns the child, extracts stdio handles, creates `mpsc` channels for stdin/stdout/stderr plus a `oneshot` for exit, launches async tasks to write stdin and read stdout/stderr, launches a wait task that computes an integer exit code and stores it in shared `Arc<AtomicBool>` and `Arc<StdMutex<Option<i32>>>`, then packages everything into `ProcessHandle::new` and returns `SpawnedProcess { session, stdout_rx, stderr_rx, exit_rx }`.

**Call relations**: This is the central constructor called by `spawn_process` and `spawn_process_no_stdin_with_inherited_fds`. Internally it delegates Unix setup to `detach_from_tty`, Linux parent cleanup to `set_parent_death_signal`, inherited-FD pruning to `close_inherited_fds_except`, stream draining to `read_output_stream`, and exit normalization to `exit_code_from_status`.

*Call graph*: calls 1 internal fn (exit_code_from_status); called by 2 (spawn_process, spawn_process_no_stdin_with_inherited_fds); 13 external calls (clone, new, new, new, new, null, piped, new, bail!, new (+3 more)).


##### `spawn_process`  (lines 267–275)

```
async fn spawn_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
) -> Result<SpawnedProcess>
```

**Purpose**: Public convenience wrapper for spawning a pipe-backed process with a writable stdin pipe. It selects the `Piped` stdin mode and no inherited file descriptors.

**Data flow**: Passes `program`, `args`, `cwd`, `env`, and `arg0` through unchanged, adds `PipeStdinMode::Piped` and an empty inherited-FD slice, and returns the `Result<SpawnedProcess>` from the shared implementation.

**Call relations**: This is the standard pipe entry used by higher-level callers that expect to write to child stdin. It exists only to choose the appropriate mode before delegating to `spawn_process_with_stdin_mode`.

*Call graph*: calls 1 internal fn (spawn_process_with_stdin_mode).


##### `spawn_process_no_stdin`  (lines 278–286)

```
async fn spawn_process_no_stdin(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
) -> Result<SpawnedProcess>
```

**Purpose**: Public convenience wrapper for spawning a pipe-backed process with stdin closed immediately. It is the simple no-stdin variant when no inherited descriptors need preserving.

**Data flow**: Forwards the executable, args, cwd, env, and optional `arg0`, appends an empty inherited-FD list, and returns the result from `spawn_process_no_stdin_with_inherited_fds`.

**Call relations**: This wrapper is used when callers want split stdout/stderr but no stdin channel. It delegates to the inherited-FD-aware variant so there is only one implementation of the null-stdin path.

*Call graph*: calls 1 internal fn (spawn_process_no_stdin_with_inherited_fds).


##### `spawn_process_no_stdin_with_inherited_fds`  (lines 290–308)

```
async fn spawn_process_no_stdin_with_inherited_fds(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    inherited_fds: &[i32],
) -
```

**Purpose**: Spawns a pipe-backed process with stdin connected to `/dev/null` or platform equivalent while preserving a selected set of inherited Unix file descriptors across exec. This is the specialized path used by tests and session startup code that need descriptor inheritance without a PTY.

**Data flow**: Accepts the same spawn parameters as the normal pipe path plus `inherited_fds: &[i32]`. It forwards all inputs to `spawn_process_with_stdin_mode` with `PipeStdinMode::Null`, preserving the allowlist for the Unix `pre_exec` closure, and returns the resulting `SpawnedProcess`.

**Call relations**: This function is called by `spawn_process_no_stdin`, by session-opening code that needs inherited descriptors, and by tests that verify descriptor preservation. Its only job is selecting the null-stdin mode before handing off to the shared constructor.

*Call graph*: calls 1 internal fn (spawn_process_with_stdin_mode); called by 3 (open_session_with_exec_env, spawn_process_no_stdin, pipe_spawn_no_stdin_can_preserve_inherited_fds).


### `utils/pty/src/pty.rs`

`io_transport` · `process spawn, PTY I/O, terminal control`

This file is the terminal-backed spawn implementation. It supports two PTY strategies: a portable path using `portable_pty` for normal operation, and a Unix-specific raw `openpty`/`std::process::Command` path when selected inherited file descriptors must survive exec. Both paths return a `SpawnedProcess` with a `ProcessHandle`, stdout channel, dummy stderr channel (PTY output is merged), and exit oneshot.

The portable path opens a PTY pair from a platform-native PTY system (`ConPtySystem` on Windows, `native_pty_system()` elsewhere), builds a `portable_pty::CommandBuilder`, clears and repopulates the environment, spawns the child on the slave side, and then creates a blocking reader thread over the PTY master plus an async writer task guarded by `tokio::sync::Mutex`. On Unix it caches `child.process_id()` as the process-group ID because portable-pty makes the child a session leader, allowing group-wide interrupt/kill semantics.

The inherited-FD path bypasses portable-pty on Unix. It manually opens a PTY with `libc::openpty`, marks both ends `FD_CLOEXEC`, clones the slave fd three times for stdin/stdout/stderr, and in `pre_exec` resets several signal dispositions to defaults, clears the signal mask, creates a new session with `setsid`, makes fd 0 the controlling terminal via `TIOCSCTTY`, and closes all inherited descriptors except an allowlist while preserving CLOEXEC descriptors needed for exec-error reporting. It stores the master as `PtyMasterHandle::Opaque`, enabling later resize through raw `ioctl(TIOCSWINSZ)`.

Termination is careful about descendants: `PtyChildTerminator` prefers killing the Unix process group and also invokes the direct child killer in case the cached PGID is stale, while `RawPidTerminator` always targets the process group directly.

#### Function details

##### `conpty_supported`  (lines 49–51)

```
fn conpty_supported() -> bool
```

**Purpose**: Reports whether Windows ConPTY support is available. On non-Windows builds the alternate definition simply returns `true` so PTY support is treated as present.

**Data flow**: Takes no input and either forwards to `crate::win::conpty_supported()` on Windows or returns a constant boolean on other platforms.

**Call relations**: This helper is used by higher-level code that needs to know whether the Windows PTY backend can be used.

*Call graph*: 1 external calls (conpty_supported).


##### `PtyChildTerminator::signal`  (lines 60–71)

```
fn signal(&mut self, signal: ProcessSignal) -> std::io::Result<()>
```

**Purpose**: Implements soft signaling for portable-PTY children. It supports `Interrupt` only when a Unix process-group ID was captured; otherwise it reports the signal as unsupported.

**Data flow**: Reads the requested `ProcessSignal` and, on Unix, the optional `process_group_id`. For `Interrupt`, it either calls `interrupt_process_group(process_group_id)` or returns `unsupported_signal(signal)`.

**Call relations**: This method is invoked through `ProcessHandle::signal` for PTY-backed sessions created by the portable path. It delegates to process-group signaling so shells and descendants receive the interrupt together.

*Call graph*: calls 2 internal fn (unsupported_signal, interrupt_process_group).


##### `PtyChildTerminator::kill`  (lines 73–90)

```
fn kill(&mut self) -> std::io::Result<()>
```

**Purpose**: Hard-kills a portable-PTY child, preferring Unix process-group semantics so descendant processes do not survive. It also invokes the direct child killer to cover stale or missing PGID cases.

**Data flow**: On Unix, if `process_group_id` is present, it first records the result of `kill_process_group(process_group_id)`, then calls `self.killer.kill()`, and combines the two results so `NotFound` from the direct child can still succeed if the group kill worked. Without a PGID, it simply returns `self.killer.kill()`.

**Call relations**: This is the PTY backend's hard-stop implementation used by `ProcessHandle::request_terminate`. Its dual kill strategy is a deliberate design choice to match the pipe backend's descendant cleanup while still handling stale cached PGIDs.

*Call graph*: calls 1 internal fn (kill_process_group).


##### `RawPidTerminator::signal`  (lines 100–106)

```
fn signal(&mut self, signal: ProcessSignal) -> std::io::Result<()>
```

**Purpose**: Implements `Interrupt` for the Unix raw-PTY path by signaling the cached process group directly. Unlike the portable terminator, this path always has a concrete PGID.

**Data flow**: Takes a `ProcessSignal`, matches `Interrupt`, forwards the stored `process_group_id` to `interrupt_process_group`, and returns that `io::Result<()>`.

**Call relations**: This terminator is installed by `spawn_process_preserving_fds`, where the child was created manually and the process group ID is known from `child.id()`.

*Call graph*: calls 1 internal fn (interrupt_process_group).


##### `RawPidTerminator::kill`  (lines 108–110)

```
fn kill(&mut self) -> std::io::Result<()>
```

**Purpose**: Hard-kills the Unix raw-PTY child's process group. It is the simplest terminator because the raw path tracks only the PGID, not a portable child killer object.

**Data flow**: Reads `self.process_group_id`, passes it to `kill_process_group`, and returns the resulting `io::Result<()>`.

**Call relations**: This method is used by `ProcessHandle::request_terminate` for sessions spawned through the inherited-FD PTY path.

*Call graph*: calls 1 internal fn (kill_process_group).


##### `platform_native_pty_system`  (lines 113–123)

```
fn platform_native_pty_system() -> Box<dyn portable_pty::PtySystem + Send>
```

**Purpose**: Selects the concrete PTY system implementation for the current platform. It uses the custom `ConPtySystem` on Windows and `portable_pty::native_pty_system()` elsewhere.

**Data flow**: Takes no input and returns a boxed `dyn portable_pty::PtySystem + Send`, constructed from either `ConPtySystem::default()` or `native_pty_system()`.

**Call relations**: This helper is called only by `spawn_process_portable` so that the rest of the portable PTY logic can remain platform-neutral.

*Call graph*: called by 1 (spawn_process_portable); 3 external calls (new, native_pty_system, default).


##### `spawn_process`  (lines 126–135)

```
async fn spawn_process(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    size: TerminalSize,
) -> Result<SpawnedProcess>
```

**Purpose**: Public convenience wrapper for PTY spawning without inherited file descriptors. It forwards to the more general inherited-FD-aware entry point with an empty allowlist.

**Data flow**: Passes through `program`, `args`, `cwd`, `env`, `arg0`, and `size`, adds `&[]` for inherited fds, and returns the resulting `Result<SpawnedProcess>`.

**Call relations**: This is the standard PTY entry used by most callers. It exists to keep the common API simple while sharing implementation with the inherited-FD variant.

*Call graph*: calls 1 internal fn (spawn_process_with_inherited_fds).


##### `spawn_process_with_inherited_fds`  (lines 139–162)

```
async fn spawn_process_with_inherited_fds(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    size: TerminalSize,
    inherited_f
```

**Purpose**: Chooses the appropriate PTY spawn strategy based on platform and whether inherited file descriptors must be preserved. It rejects empty program names before dispatching.

**Data flow**: Consumes the executable path, args, cwd, env, optional `arg0`, terminal size, and inherited-FD slice. It first errors if `program` is empty, ignores `inherited_fds` on non-Unix, routes to `spawn_process_preserving_fds(...)` on Unix when the allowlist is non-empty, and otherwise calls `spawn_process_portable(...)`.

**Call relations**: This is the main PTY constructor called by the simple wrapper, session-opening code, and several tests. Its key role is selecting between the portable backend and the Unix raw-PTY backend.

*Call graph*: calls 2 internal fn (spawn_process_portable, spawn_process_preserving_fds); called by 6 (open_session_with_exec_env, spawn_process, pty_preserving_inherited_fds_keeps_python_repl_running, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_reports_exec_failures, pty_spawn_with_inherited_fds_supports_resize); 1 external calls (bail!).


##### `spawn_process_portable`  (lines 164–278)

```
async fn spawn_process_portable(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    size: TerminalSize,
) -> Result<SpawnedProces
```

**Purpose**: Spawns a PTY-backed process using the `portable_pty` abstraction and wires it into the crate's channel-based session interface. It is the default PTY path when inherited descriptors are not needed.

**Data flow**: Takes spawn parameters plus `TerminalSize`, opens a PTY pair from `platform_native_pty_system()`, builds a `CommandBuilder` using `arg0` or `program`, clears and repopulates env, appends args, and spawns the child on the slave. It creates stdin/stdout/stderr channels, a blocking reader task that reads 8 KiB chunks from a cloned PTY master and forwards them to stdout, an async writer task that serializes writes through a mutex-protected PTY writer, and a blocking wait task that waits for child exit, stores exit state/code in shared Arcs, and sends the code over a oneshot. It then retains PTY handles in `PtyHandles`, constructs a `ProcessHandle`, and returns `SpawnedProcess`.

**Call relations**: This function is called by `spawn_process_with_inherited_fds` for the normal PTY case. It delegates PTY-system selection to `platform_native_pty_system` and uses `ProcessHandle::new` to expose the resulting session uniformly.

*Call graph*: calls 1 internal fn (platform_native_pty_system); called by 1 (spawn_process_with_inherited_fds); 14 external calls (clone, new, new, new, new, new, new, cfg!, new, spawn (+4 more)).


##### `spawn_process_preserving_fds`  (lines 281–432)

```
async fn spawn_process_preserving_fds(
    program: &str,
    args: &[String],
    cwd: &Path,
    env: &HashMap<String, String>,
    arg0: &Option<String>,
    size: TerminalSize,
    inherited_fds:
```

**Purpose**: Implements the Unix-only PTY spawn path that preserves selected inherited file descriptors across exec. It manually creates and configures the PTY and child process so descriptor inheritance and controlling-terminal setup are under explicit control.

**Data flow**: Accepts the executable, args, cwd, env, optional `arg0`, terminal size, and preserved `RawFd` slice. It opens a PTY with `open_unix_pty`, builds a `StdCommand`, clones the slave fd for stdin/stdout/stderr, and installs a `pre_exec` closure that resets several signal handlers to `SIG_DFL`, clears the signal mask, calls `setsid`, makes fd 0 the controlling terminal with `TIOCSCTTY`, and invokes `close_inherited_fds_except(&inherited_fds)`. After spawning it drops the parent slave handle, creates stdin/stdout channels, launches a blocking reader over the PTY master and an async writer over a cloned master, launches a blocking wait task that uses `exit_code_from_status`, stores the master as `PtyMasterHandle::Opaque { raw_fd, _handle }`, wraps a `RawPidTerminator` into `ProcessHandle`, and returns `SpawnedProcess`.

**Call relations**: This path is selected by `spawn_process_with_inherited_fds` only on Unix when the caller requests preserved descriptors. It depends on `open_unix_pty`, `close_inherited_fds_except`, and `exit_code_from_status` to provide behavior the portable backend cannot guarantee.

*Call graph*: calls 1 internal fn (open_unix_pty); called by 1 (spawn_process_with_inherited_fds); 13 external calls (clone, new, new, new, to_vec, new, new, from, new, new (+3 more)).


##### `open_unix_pty`  (lines 435–463)

```
fn open_unix_pty(size: TerminalSize) -> Result<(File, File)>
```

**Purpose**: Allocates a Unix PTY master/slave pair with an initial terminal size and marks both ends close-on-exec. It returns owned `File` handles for both descriptors.

**Data flow**: Takes a `TerminalSize`, converts it into `libc::winsize`, passes mutable master/slave fd pointers to `libc::openpty`, errors with `anyhow::bail!` if allocation fails, calls `set_cloexec` on both fds, and finally wraps them with `File::from_raw_fd` before returning `(File, File)`.

**Call relations**: This helper is used exclusively by `spawn_process_preserving_fds`. It isolates the unsafe PTY allocation details from the larger spawn routine.

*Call graph*: calls 1 internal fn (set_cloexec); called by 1 (spawn_process_preserving_fds); 5 external calls (from_raw_fd, bail!, openpty, addr_of_mut!, null_mut).


##### `set_cloexec`  (lines 466–476)

```
fn set_cloexec(fd: RawFd) -> std::io::Result<()>
```

**Purpose**: Sets the `FD_CLOEXEC` flag on a Unix file descriptor. This prevents accidental inheritance across exec unless the code explicitly preserves the descriptor.

**Data flow**: Reads the current descriptor flags with `fcntl(F_GETFD)`, ORs in `FD_CLOEXEC`, writes them back with `fcntl(F_SETFD, ...)`, and returns `Ok(())` or `Err(last_os_error())` if either syscall fails.

**Call relations**: This helper is called by `open_unix_pty` for both master and slave descriptors immediately after allocation.

*Call graph*: called by 1 (open_unix_pty); 2 external calls (last_os_error, fcntl).


##### `close_inherited_fds_except`  (lines 479–507)

```
fn close_inherited_fds_except(preserved_fds: &[RawFd])
```

**Purpose**: Closes inherited Unix file descriptors other than stdio and an explicit preserve list, while intentionally leaving CLOEXEC descriptors alone so Rust's internal exec-error pipe still works. It is a best-effort cleanup pass over `/dev/fd`.

**Data flow**: Takes a slice of preserved `RawFd`s, reads `/dev/fd`, parses each directory entry name into an fd number, skips fds `<= 2` and any preserved fd, checks each remaining fd's flags with `fcntl(F_GETFD)`, skips descriptors that are already `FD_CLOEXEC`, collects the rest, and finally closes each collected fd with `libc::close`.

**Call relations**: This helper is used in both the pipe backend's Unix `pre_exec` closure and the raw-PTY inherited-FD path. Its CLOEXEC exception is a subtle but important design choice to preserve spawn error reporting.

*Call graph*: 5 external calls (contains, new, close, fcntl, read_dir).


### Windows ConPTY implementation
These files provide the Windows-specific pseudoconsole, child-process wrapper, and ConPTY system integration used by the PTY layer.

### `utils/pty/src/win/mod.rs`

`generated` · `Windows PTY child lifetime and termination`

This vendored Windows module bridges raw Win32 process handles into the interfaces expected by `portable_pty`. The main type, `WinChild`, stores an `OwnedHandle` inside a `Mutex` so methods can clone the underlying process handle safely across waits, kill operations, and future polling. `WinChildKiller` is a lighter cloneable killer object that owns its own duplicated handle.

The implementation is careful about Win32 semantics. `is_complete` calls `GetExitCodeProcess` and interprets `STILL_ACTIVE` as "not exited yet"; otherwise it wraps the numeric status in `portable_pty::ExitStatus`. `do_kill` and `WinChildKiller::kill` both call `TerminateProcess`, but unlike upstream WezTerm they correctly treat a zero return value as failure and nonzero as success. `WinChild::kill` intentionally swallows `do_kill` errors and returns `Ok(())`, matching the trait's best-effort expectations.

As a `Child`, `WinChild` supports nonblocking `try_wait`, blocking `wait` via `WaitForSingleObject(INFINITE)` followed by `GetExitCodeProcess`, process ID lookup with `GetProcessId`, and raw-handle exposure. It also implements `Future`: `poll` first checks `is_complete`, and if the process is still running it clones the handle, spawns a thread that blocks in `WaitForSingleObject`, and wakes the task when the process exits. This gives async callers a way to await process completion without integrating directly with Tokio process primitives.

#### Function details

##### `WinChild::is_complete`  (lines 61–74)

```
fn is_complete(&mut self) -> IoResult<Option<ExitStatus>>
```

**Purpose**: Checks whether the Windows child process has exited and, if so, returns its exit status. It treats `STILL_ACTIVE` as a running process and any failed status query as "no result" rather than an error.

**Data flow**: Locks and clones the owned process handle, calls `GetExitCodeProcess`, inspects the returned `DWORD`, and returns `Ok(None)` if the process is still active or the API call failed, otherwise `Ok(Some(ExitStatus::with_exit_code(status)))`.

**Call relations**: This helper is used by both `WinChild::try_wait` and the async `Future` implementation's `poll` method to share the same completion check logic.

*Call graph*: called by 2 (poll, try_wait); 1 external calls (with_exit_code).


##### `WinChild::do_kill`  (lines 76–85)

```
fn do_kill(&mut self) -> IoResult<()>
```

**Purpose**: Performs the actual Win32 termination call for `WinChild`. It applies the corrected success check where `TerminateProcess` returning `0` means failure.

**Data flow**: Locks and clones the process handle, calls `TerminateProcess(handle, 1)`, and returns `Err(IoError::last_os_error())` only when the Win32 return value is `0`; otherwise it returns `Ok(())`.

**Call relations**: This internal helper is called by `WinChild::kill`. Separating it keeps the trait method small while preserving the corrected kill semantics.

*Call graph*: called by 1 (kill); 1 external calls (last_os_error).


##### `WinChild::kill`  (lines 89–92)

```
fn kill(&mut self) -> IoResult<()>
```

**Purpose**: Implements best-effort child termination for the `ChildKiller` trait. It invokes `do_kill` but intentionally ignores any error and always reports success.

**Data flow**: Mutably borrows `self`, calls `self.do_kill().ok()`, discards the result, and returns `Ok(())`.

**Call relations**: This trait method is used by PTY termination paths that hold a `WinChild` directly. It delegates the actual Win32 call to `do_kill`.

*Call graph*: calls 1 internal fn (do_kill).


##### `WinChild::clone_killer`  (lines 94–97)

```
fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>
```

**Purpose**: Creates an independent killer object that can terminate the same process later. It duplicates the underlying process handle and wraps it in `WinChildKiller`.

**Data flow**: Locks `self.proc`, clones the `OwnedHandle`, constructs `WinChildKiller { proc }`, boxes it as `Box<dyn ChildKiller + Send + Sync>`, and returns it.

**Call relations**: The PTY backend uses this when it needs a standalone killer separate from the child object itself.

*Call graph*: 1 external calls (new).


##### `WinChildKiller::kill`  (lines 106–114)

```
fn kill(&mut self) -> IoResult<()>
```

**Purpose**: Terminates the process represented by the duplicated handle owned by `WinChildKiller`. It uses the same corrected Win32 success interpretation as `WinChild::do_kill`.

**Data flow**: Calls `TerminateProcess(self.proc.as_raw_handle() as _, 1)` and returns `Err(IoError::last_os_error())` if the result is `0`, otherwise `Ok(())`.

**Call relations**: This method is invoked by higher-level PTY termination code after `clone_killer` has produced a detached killer object.

*Call graph*: 2 external calls (last_os_error, as_raw_handle).


##### `WinChildKiller::clone_killer`  (lines 116–119)

```
fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>
```

**Purpose**: Duplicates the killer by cloning its owned process handle. This allows multiple independent killer objects to exist for the same process.

**Data flow**: Calls `self.proc.try_clone().unwrap()`, wraps the cloned handle in a new `WinChildKiller`, boxes it, and returns it.

**Call relations**: This satisfies the `ChildKiller` trait's cloning requirement for the detached killer type.

*Call graph*: 2 external calls (new, try_clone).


##### `WinChild::try_wait`  (lines 123–125)

```
fn try_wait(&mut self) -> IoResult<Option<ExitStatus>>
```

**Purpose**: Implements nonblocking wait for the `Child` trait by reusing `is_complete`. It returns immediately with either `Some(status)` or `None`.

**Data flow**: Mutably borrows `self`, calls `self.is_complete()`, and returns that `IoResult<Option<ExitStatus>>` unchanged.

**Call relations**: This trait method is used by `WinChild::wait` as a fast path before blocking and may also be called by external code through the `portable_pty::Child` interface.

*Call graph*: calls 1 internal fn (is_complete); called by 1 (wait).


##### `WinChild::wait`  (lines 127–142)

```
fn wait(&mut self) -> IoResult<ExitStatus>
```

**Purpose**: Blocks until the Windows child exits and then returns its exit status. It first checks for an already-completed process to avoid unnecessary waiting.

**Data flow**: Calls `try_wait()` and returns immediately if it yields `Some(status)`. Otherwise it clones the process handle, blocks in `WaitForSingleObject(..., INFINITE)`, then calls `GetExitCodeProcess` and returns `ExitStatus::with_exit_code(status)` on success or `IoError::last_os_error()` on failure.

**Call relations**: This is the blocking completion path required by the `Child` trait. It builds on `try_wait` and uses raw Win32 waiting only when needed.

*Call graph*: calls 1 internal fn (try_wait); 3 external calls (with_exit_code, last_os_error, WaitForSingleObject).


##### `WinChild::process_id`  (lines 144–147)

```
fn process_id(&self) -> Option<u32>
```

**Purpose**: Returns the Windows process ID for the wrapped child if it can be retrieved. A zero result from `GetProcessId` is treated as absence.

**Data flow**: Locks `self.proc`, passes its raw handle to `GetProcessId`, and returns `Some(res)` when nonzero or `None` when zero.

**Call relations**: The PTY backend uses this trait method to cache a process identifier when available.


##### `WinChild::as_raw_handle`  (lines 149–152)

```
fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle>
```

**Purpose**: Exposes the underlying raw Windows process handle through the `Child` trait. It always returns `Some(...)` for this implementation.

**Data flow**: Locks `self.proc`, reads `proc.as_raw_handle()`, wraps it in `Some`, and returns it.

**Call relations**: This method supports lower-level integrations that need direct access to the process handle from a `portable_pty::Child` object.


##### `WinChild::poll`  (lines 158–174)

```
fn poll(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<anyhow::Result<ExitStatus>>
```

**Purpose**: Implements `Future` for `WinChild`, allowing async waiting on process completion. If the process is still running, it spawns a helper thread that blocks on the process handle and wakes the task when done.

**Data flow**: Mutably pins `self`, calls `is_complete()`, and returns `Poll::Ready(Ok(status))` if exited or `Poll::Ready(Err(...))` if status retrieval failed. When still running, it clones the process handle and current waker, spawns a thread that calls `WaitForSingleObject(INFINITE)` and then `waker.wake()`, and returns `Poll::Pending`.

**Call relations**: Async code awaiting a `WinChild` reaches this method. It reuses `is_complete` for the fast path and falls back to a thread-based wakeup strategy because Win32 process handles are not integrated directly with Rust async executors here.

*Call graph*: calls 1 internal fn (is_complete); 3 external calls (waker, Ready, spawn).


### `utils/pty/src/win/psuedocon.rs`

`io_transport` · `process spawning and PTY session management on Windows`

This file is the Windows PTY integration layer around the ConPTY API. It dynamically loads `CreatePseudoConsole`, `ResizePseudoConsole`, and `ClosePseudoConsole` from either `conpty.dll` or `kernel32.dll`, and probes OS support by calling `RtlGetVersion` from `ntdll.dll` and comparing the build number against `MIN_CONPTY_BUILD` (17763). The central type is `PsuedoCon`, which owns the `HPCON` handle plus the input/output pipe `FileDescriptor`s that ConPTY only borrows; keeping those descriptors alive for the pseudoconsole lifetime is an explicit invariant.

`PsuedoCon::new` creates the pseudoconsole with `PSEUDOCONSOLE_RESIZE_QUIRK`, and `Drop` always closes it. `spawn_command` builds a `STARTUPINFOEXW` with a `ProcThreadAttributeList` containing the pseudoconsole handle, disables inherited stdio by setting them to `INVALID_HANDLE_VALUE`, then calls `CreateProcessW` with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT`. Before launch it resolves the executable path, quotes arguments according to Windows command-line escaping rules, constructs a double-NUL-terminated UTF-16 environment block, and chooses a current directory from explicit cwd or `USERPROFILE`, rejecting nonexistent directories. On process creation failure it logs and returns a detailed error including the rendered command line and cwd. The helper functions here are careful about UTF-16 encoding, PATH/PATHEXT lookup, relative cwd expansion, and preserving Windows quoting semantics for spaces, quotes, and trailing backslashes.

#### Function details

##### `load_conpty`  (lines 87–97)

```
fn load_conpty() -> ConPtyFuncs
```

**Purpose**: Loads the ConPTY function table from the host system. It prefers a side-loaded `conpty.dll` when present, otherwise falls back to `kernel32.dll` exports.

**Data flow**: It takes no arguments, opens `kernel32.dll` as a required baseline source of `ConPtyFuncs`, then attempts to open `conpty.dll`. If the side-loaded DLL opens successfully it returns that function table; otherwise it returns the kernel32-backed table.

**Call relations**: This function is used to initialize the global lazy `CONPTY` binding. It sits at the bottom of the startup path for all later pseudoconsole operations, because `PsuedoCon::new`, `resize`, and `drop` all invoke function pointers stored in that singleton.

*Call graph*: 2 external calls (open, new).


##### `conpty_supported`  (lines 103–105)

```
fn conpty_supported() -> bool
```

**Purpose**: Reports whether the current Windows build is new enough to support ConPTY. The check is purely based on the OS build number threshold.

**Data flow**: It reads the optional build number from `windows_build_number`, compares it against `MIN_CONPTY_BUILD`, and returns `true` only when a build number exists and is at least 17763.

**Call relations**: This is the public capability probe for callers deciding whether to use ConPTY at all. It delegates the actual version query to `windows_build_number`.

*Call graph*: calls 1 internal fn (windows_build_number).


##### `windows_build_number`  (lines 107–117)

```
fn windows_build_number() -> Option<u32>
```

**Purpose**: Queries the real Windows build number using `RtlGetVersion`. It avoids relying on manifest-sensitive version APIs.

**Data flow**: It opens `ntdll.dll`, zero-initializes an `OSVERSIONINFOW`, fills in `dwOSVersionInfoSize`, and calls `RtlGetVersion`. On `STATUS_SUCCESS` it returns `Some(info.dwBuildNumber)`; otherwise, or if `ntdll.dll` cannot be opened, it returns `None`.

**Call relations**: This function underpins `conpty_supported` and is also exercised directly by the unit test that verifies a build number can be obtained on the test host.

*Call graph*: called by 2 (conpty_supported, windows_build_number_returns_value); 3 external calls (open, new, zeroed).


##### `PsuedoCon::drop`  (lines 131–133)

```
fn drop(&mut self)
```

**Purpose**: Closes the underlying pseudoconsole handle when the wrapper is dropped. This is the cleanup point that ends the ConPTY lifetime.

**Data flow**: It reads `self.con` and passes it to `CONPTY.ClosePseudoConsole`. It does not return a value and relies on the struct fields `_input` and `_output` being dropped afterward to release the borrowed pipe handles.

**Call relations**: This runs automatically during teardown of a `PsuedoCon`. It complements `PsuedoCon::new`, which creates the handle, and enforces the ownership model documented on the struct.


##### `PsuedoCon::raw_handle`  (lines 137–139)

```
fn raw_handle(&self) -> HPCON
```

**Purpose**: Exposes the raw `HPCON` handle stored inside the wrapper. It is a thin accessor for integration with lower-level Windows setup code.

**Data flow**: It reads `self.con` and returns that `HPCON` unchanged. No state is mutated.

**Call relations**: This accessor is used by external code that needs to pass the pseudoconsole handle onward, specifically the caller identified in the graph as `pseudoconsole_handle`.

*Call graph*: called by 1 (pseudoconsole_handle).


##### `PsuedoCon::new`  (lines 141–161)

```
fn new(size: COORD, input: FileDescriptor, output: FileDescriptor) -> Result<Self, Error>
```

**Purpose**: Creates a new Windows pseudoconsole bound to the supplied input and output pipe handles. It validates the HRESULT and retains ownership of the descriptors for the console lifetime.

**Data flow**: It takes a `COORD` size and two `FileDescriptor`s, initializes an `HPCON` to `INVALID_HANDLE_VALUE`, and calls `CONPTY.CreatePseudoConsole` with the descriptors' raw handles and `PSEUDOCONSOLE_RESIZE_QUIRK`. If the HRESULT is not `S_OK` it returns an error via `ensure!`; otherwise it returns a `PsuedoCon` containing the created handle and the original descriptors in `_input` and `_output`.

**Call relations**: This is the constructor used by the higher-level PTY setup path, specifically `create_conpty_handles`. Its successful result is later consumed by `resize`, `spawn_command`, and `drop`.

*Call graph*: called by 1 (create_conpty_handles); 2 external calls (ensure!, as_raw_handle).


##### `PsuedoCon::resize`  (lines 163–173)

```
fn resize(&self, size: COORD) -> Result<(), Error>
```

**Purpose**: Resizes an existing pseudoconsole to a new terminal geometry. It converts the ConPTY HRESULT into an `anyhow::Error` on failure.

**Data flow**: It takes a `COORD`, calls `CONPTY.ResizePseudoConsole(self.con, size)`, checks for `S_OK`, and returns `Ok(())` on success. On failure it formats an error message including the requested width and height.

**Call relations**: This method is invoked by the higher-level `resize` caller in the PTY subsystem whenever terminal dimensions change.

*Call graph*: called by 1 (resize); 1 external calls (ensure!).


##### `PsuedoCon::spawn_command`  (lines 175–227)

```
fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<WinChild>
```

**Purpose**: Launches a child process attached to this pseudoconsole using `CreateProcessW` with extended startup attributes. It prepares Windows-native command line, environment, cwd, and process/thread handles.

**Data flow**: It takes a `CommandBuilder`, zero-initializes `STARTUPINFOEXW` and `PROCESS_INFORMATION`, marks stdio handles invalid, allocates a `ProcThreadAttributeList` with one slot, and stores the pseudoconsole handle into that attribute list. It then derives `(exe, cmdline)` from `build_cmdline`, converts the UTF-16 command line back to an `OsString` for diagnostics, computes an optional UTF-16 cwd via `resolve_current_directory`, and builds a UTF-16 double-NUL environment block via `build_environment_block`. Those buffers are passed to `CreateProcessW`; on failure it reads `last_os_error`, logs a message, and returns an error with `bail!`. On success it wraps `pi.hThread` and `pi.hProcess` in `OwnedHandle`, drops the thread handle immediately after binding it, and returns a `WinChild` containing the process handle inside a `Mutex`.

**Call relations**: This is the main process-launch path after a pseudoconsole exists. It orchestrates the helper functions in this file—`build_cmdline`, `resolve_current_directory`, and `build_environment_block`—and depends on `ProcThreadAttributeList::with_capacity` and `set_pty` so the child starts inside the ConPTY session.

*Call graph*: calls 4 internal fn (with_capacity, build_cmdline, build_environment_block, resolve_current_directory); 10 external calls (new, from_wide, last_os_error, bail!, format!, error!, zeroed, null, null_mut, from_raw_handle).


##### `resolve_current_directory`  (lines 230–251)

```
fn resolve_current_directory(cmd: &CommandBuilder) -> Option<Vec<u16>>
```

**Purpose**: Chooses and encodes the working directory passed to `CreateProcessW`. It only returns directories that currently exist.

**Data flow**: It reads `USERPROFILE` and explicit cwd from the `CommandBuilder`, filters each through `Path::is_dir`, and prefers explicit cwd over home. If the chosen path is relative, it tries to join it against `env::current_dir`; otherwise it uses the path as-is. The selected path is encoded as a NUL-terminated UTF-16 `Vec<u16>` and returned as `Some`, or `None` if neither candidate exists.

**Call relations**: This helper is called only from `PsuedoCon::spawn_command` to supply the `lpCurrentDirectory` argument to `CreateProcessW`.

*Call graph*: called by 1 (spawn_command); 5 external calls (get_cwd, get_env, new, new, current_dir).


##### `build_environment_block`  (lines 253–263)

```
fn build_environment_block(cmd: &CommandBuilder) -> Vec<u16>
```

**Purpose**: Constructs the Windows environment block for the child process in UTF-16 form. The result matches the `CREATE_UNICODE_ENVIRONMENT` expectation of `CreateProcessW`.

**Data flow**: It iterates `cmd.iter_full_env_as_str()`, appending each key, an `=` separator, each value, and a terminating NUL to a `Vec<u16>`. After all entries it appends a final extra NUL, producing the required double-NUL-terminated block.

**Call relations**: This helper is used exclusively by `PsuedoCon::spawn_command` when preparing the environment pointer passed into `CreateProcessW`.

*Call graph*: called by 1 (spawn_command); 3 external calls (iter_full_env_as_str, new, new).


##### `build_cmdline`  (lines 265–294)

```
fn build_cmdline(cmd: &CommandBuilder) -> anyhow::Result<(Vec<u16>, Vec<u16>)>
```

**Purpose**: Resolves the executable path and assembles a correctly quoted Windows command line from a `CommandBuilder`. It also rejects malformed inputs such as a missing program name or embedded NULs in arguments.

**Data flow**: It inspects the `CommandBuilder`: if `is_default_prog()` is true, it uses `ComSpec` or falls back to `cmd.exe`; otherwise it reads `get_argv()`, errors if the argv list is empty, and resolves the first element through `search_path`. It then appends the executable and remaining arguments into a UTF-16 command-line buffer using `append_quoted`, checking each non-program argument for embedded NUL code units. Finally it NUL-terminates both the executable path buffer and the command-line buffer and returns them as `(Vec<u16>, Vec<u16>)`.

**Call relations**: This helper is called by `PsuedoCon::spawn_command` before process creation. It delegates executable lookup to `search_path` and Windows escaping rules to `append_quoted`.

*Call graph*: calls 2 internal fn (append_quoted, search_path); called by 1 (spawn_command); 7 external calls (get_argv, get_env, is_default_prog, new, new, bail!, ensure!).


##### `search_path`  (lines 296–318)

```
fn search_path(cmd: &CommandBuilder, exe: &OsStr) -> OsString
```

**Purpose**: Searches the command's PATH and PATHEXT environment variables to resolve an executable name to an existing filesystem path. If no match is found, it leaves the original executable string unchanged.

**Data flow**: It takes the `CommandBuilder` and an executable `OsStr`, reads `PATH` and `PATHEXT`, iterates each PATH directory, first checking the bare candidate `path.join(exe)`, then trying each extension from PATHEXT by replacing or adding the extension. The first existing path is returned as an `OsString`; if PATH is absent or no candidate exists, it returns `exe.to_os_string()`.

**Call relations**: This function is only used by `build_cmdline` when the command is not the default shell program and the executable may need PATH-based resolution.

*Call graph*: called by 1 (build_cmdline); 4 external calls (get_env, new, to_os_string, split_paths).


##### `append_quoted`  (lines 320–363)

```
fn append_quoted(arg: &OsStr, cmdline: &mut Vec<u16>)
```

**Purpose**: Appends one argument to a UTF-16 Windows command-line buffer using Windows-compatible quoting and backslash escaping rules. It preserves arguments without special characters unquoted for simplicity.

**Data flow**: It takes an `OsStr` argument and a mutable `Vec<u16>` buffer. If the argument is non-empty and contains no whitespace or quotes, it writes the UTF-16 code units directly. Otherwise it surrounds the argument with quotes and walks the encoded code units, doubling backslashes before a closing quote or at end-of-string, escaping literal quotes, and copying ordinary characters through. It mutates `cmdline` in place and returns no value.

**Call relations**: This helper is called repeatedly by `build_cmdline` for the executable and each subsequent argument so that `CreateProcessW` receives a command line that the child process parses correctly.

*Call graph*: called by 1 (build_cmdline); 3 external calls (encode_wide, is_empty, len).


##### `tests::windows_build_number_returns_value`  (lines 371–376)

```
fn windows_build_number_returns_value()
```

**Purpose**: Verifies that the Windows version probe returns a build number on the test machine and that it exceeds the minimum ConPTY build threshold. It is a smoke test for the `RtlGetVersion` path.

**Data flow**: It calls `windows_build_number().unwrap()` to obtain a concrete build number and asserts that the value is greater than `MIN_CONPTY_BUILD`.

**Call relations**: This test directly exercises `windows_build_number` rather than the higher-level `conpty_supported` helper, ensuring the low-level version query itself works.

*Call graph*: calls 1 internal fn (windows_build_number); 1 external calls (assert!).


### `utils/pty/src/win/conpty.rs`

`generated` · `Windows PTY setup and PTY I/O lifetime`

This vendored file is the Windows-specific PTY transport layer. It creates a pseudoconsole (`PsuedoCon`) backed by two anonymous pipes: one pipe feeds input into the console, and the other carries console output back to the parent. `create_conpty_handles` is the primitive that allocates those pipes and constructs the pseudoconsole with a `COORD` derived from `PtySize`.

`RawConPty` is a lower-level wrapper that owns the pseudoconsole plus its input/output file descriptors and can either expose the raw pseudoconsole handle or be decomposed into its owned parts using `ManuallyDrop` and `ptr::read` to avoid double-drop. The higher-level `ConPtySystem` implements `portable_pty::PtySystem::openpty` by creating shared `Inner` state inside `Arc<Mutex<_>>`, then returning a `PtyPair` whose master and slave both reference that shared state.

`Inner` stores the live `PsuedoCon`, the readable output descriptor, an optional writable input descriptor, and the current `PtySize`. Its `resize` method updates both the underlying pseudoconsole and the cached size. `ConPtyMasterPty` exposes resize, size query, reader cloning, and one-time writer extraction; `take_writer` consumes the optional writer and errors if called twice. `ConPtySlavePty` delegates command spawning to the pseudoconsole itself. The overall design mirrors a Unix PTY pair while fitting Windows ConPTY's handle-based API.

#### Function details

##### `create_conpty_handles`  (lines 42–58)

```
fn create_conpty_handles(
    size: PtySize,
) -> anyhow::Result<(PsuedoCon, FileDescriptor, FileDescriptor)>
```

**Purpose**: Allocates the pipe endpoints and pseudoconsole needed for a Windows ConPTY session. It returns the pseudoconsole plus the parent-side writable stdin handle and readable stdout handle.

**Data flow**: Takes a `PtySize`, creates two `Pipe`s, converts rows and columns into a Win32 `COORD`, constructs `PsuedoCon::new(...)` with the read end of the stdin pipe and write end of the stdout pipe, and returns `(con, stdin.write, stdout.read)`.

**Call relations**: This helper is used by both `RawConPty::new` and `ConPtySystem::openpty`. It centralizes the exact pipe wiring required by ConPTY.

*Call graph*: calls 1 internal fn (new); called by 2 (openpty, new); 1 external calls (new).


##### `RawConPty::new`  (lines 67–79)

```
fn new(cols: i16, rows: i16) -> anyhow::Result<Self>
```

**Purpose**: Constructs a low-level owned ConPTY wrapper from column and row counts. It is a convenience constructor around `create_conpty_handles`.

**Data flow**: Accepts `cols: i16` and `rows: i16`, builds a `PtySize` with zero pixel dimensions, calls `create_conpty_handles`, and returns `RawConPty { con, input_write, output_read }`.

**Call relations**: This constructor is used by other Windows-specific code that needs direct access to the pseudoconsole and its file descriptors rather than the `portable_pty` trait wrappers.

*Call graph*: calls 1 internal fn (create_conpty_handles); called by 2 (create_conpty, spawn_conpty_process_as_user).


##### `RawConPty::pseudoconsole_handle`  (lines 81–83)

```
fn pseudoconsole_handle(&self) -> RawHandle
```

**Purpose**: Exposes the raw Windows pseudoconsole handle from a `RawConPty`. This is useful for APIs that need to pass the handle into process-creation attributes.

**Data flow**: Reads `self.con` and returns `self.con.raw_handle()` as a `RawHandle`.

**Call relations**: This method supports lower-level Windows process-spawn code that integrates ConPTY with custom startup attributes.

*Call graph*: calls 1 internal fn (raw_handle).


##### `RawConPty::into_handles`  (lines 85–94)

```
fn into_handles(self) -> (PsuedoCon, FileDescriptor, FileDescriptor)
```

**Purpose**: Consumes `RawConPty` and returns its owned pseudoconsole and file descriptors without running their destructors twice. It uses `ManuallyDrop` plus raw pointer reads to move fields out safely.

**Data flow**: Takes ownership of `self`, wraps it in `ManuallyDrop`, uses `ptr::read` to extract `con`, `input_write`, and `output_read`, and returns that tuple.

**Call relations**: This method is used by Windows-specific code paths that need to transfer ownership of the underlying handles out of the wrapper.

*Call graph*: 2 external calls (new, read).


##### `ConPtySystem::openpty`  (lines 98–118)

```
fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair>
```

**Purpose**: Implements the `portable_pty` PTY-system interface for Windows ConPTY. It creates shared state and returns a master/slave pair backed by the same pseudoconsole.

**Data flow**: Takes a `PtySize`, calls `create_conpty_handles`, builds `Inner { con, readable, writable: Some(writable), size }` inside `Arc<Mutex<_>>`, constructs `ConPtyMasterPty` and `ConPtySlavePty` sharing that Arc, boxes them, and returns `PtyPair { master, slave }`.

**Call relations**: This is the entry point used by the PTY backend's `platform_native_pty_system` on Windows. It delegates actual handle creation to `create_conpty_handles`.

*Call graph*: calls 1 internal fn (create_conpty_handles); 3 external calls (new, new, new).


##### `Inner::resize`  (lines 129–147)

```
fn resize(
        &mut self,
        num_rows: u16,
        num_cols: u16,
        pixel_width: u16,
        pixel_height: u16,
    ) -> Result<(), Error>
```

**Purpose**: Resizes the underlying pseudoconsole and updates the cached PTY size. It is the mutable core operation behind the master PTY's resize API.

**Data flow**: Accepts new row/column/pixel dimensions, calls `self.con.resize(COORD { X, Y })`, overwrites `self.size` with the new `PtySize`, and returns `Ok(())` or the propagated error.

**Call relations**: This method is called by `ConPtyMasterPty::resize` after locking the shared `Inner` state.

*Call graph*: calls 1 internal fn (resize).


##### `ConPtyMasterPty::resize`  (lines 160–163)

```
fn resize(&self, size: PtySize) -> anyhow::Result<()>
```

**Purpose**: Implements `MasterPty::resize` for ConPTY by locking shared state and forwarding to `Inner::resize`. It is the public resize surface seen by the rest of the crate.

**Data flow**: Takes a `PtySize`, locks `self.inner`, passes the size fields to `inner.resize(...)`, and returns the resulting `anyhow::Result<()>`.

**Call relations**: The PTY backend calls this through the `MasterPty` trait when resizing a Windows PTY session.


##### `ConPtyMasterPty::get_size`  (lines 165–168)

```
fn get_size(&self) -> Result<PtySize, Error>
```

**Purpose**: Returns the cached current PTY size for a ConPTY master. It does not query the OS; it reads the size stored in shared state.

**Data flow**: Locks `self.inner`, copies `inner.size`, and returns it as `Result<PtySize, Error>`.

**Call relations**: This satisfies the `MasterPty` trait and complements `resize` for callers that need to inspect current dimensions.


##### `ConPtyMasterPty::try_clone_reader`  (lines 170–172)

```
fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>>
```

**Purpose**: Provides a clone of the readable output side of the ConPTY master. Each clone can independently read console output.

**Data flow**: Locks `self.inner`, calls `readable.try_clone()?`, boxes the cloned reader as `Box<dyn std::io::Read + Send>`, and returns it.

**Call relations**: The PTY backend uses this trait method to create the reader object consumed by its blocking output-forwarding task.

*Call graph*: 1 external calls (new).


##### `ConPtyMasterPty::take_writer`  (lines 174–183)

```
fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>>
```

**Purpose**: Transfers ownership of the writable input side of the ConPTY master exactly once. Subsequent attempts fail with an explicit error.

**Data flow**: Locks `self.inner`, takes `writable` out of its `Option<FileDescriptor>`, converts `None` into an `anyhow!("writer already taken")` error, boxes the descriptor as `Box<dyn std::io::Write + Send>`, and returns it.

**Call relations**: The PTY backend calls this when creating the stdin writer task. The one-time take enforces exclusive ownership of the write handle.

*Call graph*: 1 external calls (new).


##### `ConPtySlavePty::spawn_command`  (lines 187–191)

```
fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>>
```

**Purpose**: Spawns a child process attached to the pseudoconsole represented by the shared `Inner`. It is the slave-side implementation required by `portable_pty`.

**Data flow**: Locks `self.inner`, calls `inner.con.spawn_command(cmd)?`, boxes the returned child as `Box<dyn Child + Send + Sync>`, and returns it.

**Call relations**: This method is invoked by the PTY backend's portable spawn path after it has built a `CommandBuilder` for the child process.

*Call graph*: 1 external calls (new).
