# Unified-exec sessions and PTY/process backends  `stage-14.2.2`

This stage is the low-level machinery that lets the system run interactive commands, keep them alive, talk to them, and stop them safely. It sits behind the main tool loop: when a command is approved, these pieces turn that request into a real process and stream its output back.

The unified_exec front door defines the shared request shapes, limits, and helpers, while its errors file gives the whole area one clear failure language. process and process_manager are the control room: they start commands, reuse sessions, collect output, send later input, track exits, cancel work, and clean up. The write_stdin handler is the small inlet that sends more text into an already-running command.

On the exec-server side, process defines the common process contract. local_process runs commands on the server machine, and remote_process makes a remote command look local. spawn is the safe doorway for launching programs with the right folder, environment, network, and input/output setup.

The pty utilities provide the actual plumbing: pipes for simple programs, PTYs, or “fake terminals,” for interactive ones, process groups for cleanup, and Windows ConPTY bridges for terminal behavior on Windows.

## Files in this stage

### Unified-exec orchestration
These files define the unified-exec module surface, error model, per-process wrapper, manager, and stdin-writing tool that drive interactive session lifecycle from the core layer.

### `core/src/unified_exec/mod.rs`

`orchestration` · `request handling`

When the system needs to run a command for a user, it cannot simply start a shell and hope for the best. It has to ask for approval when needed, choose a sandbox (a restricted place where commands can run more safely), stream output back without flooding the model, and keep long-running processes available for later input. This file gathers the main building blocks for that job.

It declares the module’s public surface: errors, process types, lifecycle hooks, and the process manager. It also defines important limits, such as how long the system should wait before returning output and how much output can be kept. These limits are like guardrails: without them, a command could hang too long or produce too much text.

The central data shapes are `UnifiedExecContext`, which ties a command to the current session and turn, and request structs for starting a command or writing to an existing process. `ProcessStore` is the in-memory registry of running or reserved processes. `UnifiedExecProcessManager` owns that store behind a mutex, which is a lock that prevents two async tasks from changing the process list at the same time.

The file also includes small helpers for clamping wait times, choosing output token limits, and making short chunk identifiers used when returning streamed output.

#### Function details

##### `set_deterministic_process_ids_for_tests`  (lines 53–55)

```
fn set_deterministic_process_ids_for_tests(enabled: bool)
```

**Purpose**: This turns predictable process IDs on or off for tests. Predictable IDs make tests easier to write because the expected result does not change randomly each run.

**Data flow**: It receives a true-or-false setting. It passes that setting into the process manager’s test hook. Nothing is returned; the effect is that later test-created processes can use deterministic IDs instead of normal generated ones.

**Call relations**: Test setup code calls this when it needs stable process IDs. This function does not implement the ID behavior itself; it forwards the request to the process manager layer, where process creation actually happens.

*Call graph*: calls 1 internal fn (set_deterministic_process_ids_for_tests); called by 1 (set_deterministic_process_ids).


##### `UnifiedExecContext::new`  (lines 82–88)

```
fn new(session: Arc<Session>, turn: Arc<TurnContext>, call_id: String) -> Self
```

**Purpose**: This creates a small bundle of information that says which session, which conversation turn, and which tool call a command belongs to. It gives later code one object to carry that identity around.

**Data flow**: It takes a shared session, a shared turn context, and a call ID string. It stores them together in a new `UnifiedExecContext`. The result is returned to the caller and can then travel with an exec request.

**Call relations**: Higher-level tool handling code builds this context before asking unified exec to run something. Later execution code uses the stored session and turn information for policy decisions, environment setup, and linking output back to the right call.

*Call graph*: called by 3 (handle_call, exec_command_with_tty, failed_initial_end_for_unstored_process_uses_fallback_output).


##### `ProcessStore::remove`  (lines 128–131)

```
fn remove(&mut self, process_id: i32) -> Option<ProcessEntry>
```

**Purpose**: This removes a process from the in-memory process registry. It also clears any reservation for that same process ID, so the ID is no longer treated as occupied.

**Data flow**: It receives a process ID. First it removes that ID from the reserved-ID set. Then it removes the matching process entry from the process map. It returns the removed process entry if one existed, or nothing if the ID was not present.

**Call relations**: Cleanup code calls this while pruning old or excess processes. By removing both the reservation and the process entry together, it keeps the store from believing a process ID is still taken after the process has been discarded.

*Call graph*: called by 1 (prune_processes_if_needed).


##### `UnifiedExecProcessManager::new`  (lines 140–146)

```
fn new(max_write_stdin_yield_time_ms: u64) -> Self
```

**Purpose**: This builds a new manager for interactive exec processes. The manager owns the process registry and decides the maximum wait time allowed when writing input to an existing process.

**Data flow**: It receives a requested maximum yield time for `write_stdin`, meaning how long the system may wait for more output after sending input. It creates an empty `ProcessStore` inside a mutex lock and stores the maximum, but never lets it go below the minimum required for empty input. It returns a ready-to-use process manager.

**Call relations**: Session and test setup code call this when they need a fresh unified exec manager. The manager created here is later used by command execution and stdin-writing paths to coordinate access to running processes.

*Call graph*: called by 3 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 2 external calls (new, default).


##### `UnifiedExecProcessManager::default`  (lines 150–152)

```
fn default() -> Self
```

**Purpose**: This creates a process manager using the standard timeout for background terminal work. It is the convenient choice when callers do not need a custom timeout.

**Data flow**: It takes no input. It calls the manager constructor with the default maximum background terminal timeout. It returns a new `UnifiedExecProcessManager` with an empty process store and standard timing behavior.

**Call relations**: Tests and setup code use this when the normal behavior is enough. It funnels creation through `UnifiedExecProcessManager::new`, so the same minimum-time safeguards are applied.

*Call graph*: called by 7 (unified_exec_uses_the_trusted_sandbox_cwd, zsh_fork_execpolicy_allow_preserves_parent_sandbox_override, zsh_fork_first_attempt_preserves_additional_permissions_request, zsh_fork_first_attempt_preserves_parent_sandbox_override, completed_pipe_commands_preserve_exit_code, remote_exec_server_rejects_inherited_fd_launches, unified_exec_uses_remote_exec_server_when_configured); 1 external calls (new).


##### `clamp_yield_time`  (lines 168–175)

```
fn clamp_yield_time(yield_time_ms: u64) -> u64
```

**Purpose**: This keeps a requested wait time inside safe bounds. It prevents callers from asking for a wait that is too short to be useful or too long to be acceptable.

**Data flow**: It receives a wait time in milliseconds. On Windows, it first raises very small initial waits to a higher floor because starting terminal commands there can need more time. Then it clamps the value between the module’s minimum and maximum limits. The adjusted number is returned.

**Call relations**: Command execution calls this before deciding how long to wait for initial output. It protects the rest of the exec flow from unreasonable timing values supplied by a caller.

*Call graph*: called by 1 (exec_command); 1 external calls (cfg!).


##### `resolve_max_tokens`  (lines 177–179)

```
fn resolve_max_tokens(max_tokens: Option<usize>) -> usize
```

**Purpose**: This chooses the output token limit to use when a caller may or may not have supplied one. A token is a small chunk of text as counted for model input and output limits.

**Data flow**: It receives an optional maximum token count. If the caller supplied a value, it returns that value. If not, it returns the module’s default output limit.

**Call relations**: Output truncation paths call this when they need a concrete limit before shortening command output for the model. It keeps default behavior consistent wherever unified exec output is sized.

*Call graph*: called by 2 (truncate_code_mode_result, model_output_max_tokens).


##### `generate_chunk_id`  (lines 181–186)

```
fn generate_chunk_id() -> String
```

**Purpose**: This creates a short random identifier for an output chunk. The identifier helps label pieces of streamed command output without needing a long or meaningful name.

**Data flow**: It takes no input. It asks the random number generator for six hexadecimal digits, each chosen from 0 through f. It joins those digits into a string and returns it.

**Call relations**: Tool-call handling, command execution, and stdin-writing paths call this when they need to name a returned chunk of output. It is a small utility that supports the larger streaming flow.

*Call graph*: called by 3 (handle_call, exec_command, write_stdin); 1 external calls (rng).


### `core/src/unified_exec/errors.rs`

`data_model` · `request handling`

When the system runs a command for the user, several things can go wrong: the process may fail to start, a running process may crash, the system may not recognize the process ID, standard input may already be closed, or a sandbox security rule may block the command. This file names those situations in one place through the `UnifiedExecError` enum. An enum is a type that can be one of several named choices, like a form with exactly one checked box.

The file also controls how these failures are shown as readable error text. It uses `thiserror`, a Rust helper library that turns each error case into a normal error message. One important detail is that a sandbox denial carries both a human-readable message and the command output collected so far, so callers can explain the denial without losing useful context.

Without this file, the execution code would have to pass around loose strings or unrelated error types. That would make it easier to lose important details, harder to show consistent messages, and harder for callers to react differently to different failures.

#### Function details

##### `UnifiedExecError::create_process`  (lines 29–31)

```
fn create_process(message: String) -> Self
```

**Purpose**: This is a small convenience function for making the specific error used when the system cannot start a unified execution process. It keeps callers from having to know the exact enum shape.

**Data flow**: A text message explaining what went wrong goes in. The function wraps that message in the `CreateProcess` error form. The result is a `UnifiedExecError` value that can be returned to higher-level code and eventually shown or logged.

**Call relations**: When `open_session_with_exec_env` tries to open a new execution session and process creation fails, it calls this helper to turn the low-level failure text into the standard unified-exec error type.

*Call graph*: called by 1 (open_session_with_exec_env).


##### `UnifiedExecError::process_failed`  (lines 33–35)

```
fn process_failed(message: String) -> Self
```

**Purpose**: This creates the general error used when a unified execution process has failed after being started or while being interacted with. It gives several parts of the execution flow a shared way to report process failure.

**Data flow**: A failure explanation goes in as a string. The function places it inside the `ProcessFailed` error form. The output is a `UnifiedExecError` that carries the explanation in a structured, consistent way.

**Call relations**: Code paths that run commands, write to a process, write to standard input, or explicitly mark a process as failed use this helper when they need to report that the process did not complete normally.

*Call graph*: called by 4 (write, exec_command, write_stdin, fail_process_with_message).


##### `UnifiedExecError::sandbox_denied`  (lines 37–39)

```
fn sandbox_denied(message: String, output: ExecToolCallOutput) -> Self
```

**Purpose**: This creates the error used when the sandbox blocks a command. A sandbox is a safety boundary that prevents commands from doing things they are not allowed to do.

**Data flow**: A denial message and an `ExecToolCallOutput` value go in. The output value is the command-output record the execution tool uses. The function bundles both into the `SandboxDenied` error form, so the caller keeps both the reason for the block and any relevant output details.

**Call relations**: When `check_for_sandbox_denial_with_text` detects text showing that the sandbox denied the command, it calls this helper to produce the standard error that can travel back through the execution system.

*Call graph*: called by 1 (check_for_sandbox_denial_with_text).


### `core/src/unified_exec/process.rs`

`orchestration` · `during an exec command, from process start through output streaming, exit, and cleanup`

Running a command is messy because there are two back ends here: a local pseudo-terminal, or PTY, which behaves like a real terminal, and a remote exec server process. This file hides that difference behind `UnifiedExecProcess`, so higher-level code can write input, read output, interrupt, terminate, and check exit state without caring where the process actually lives.

Think of it like a universal remote control. The TV models are different, but the buttons should still mean the same thing. Internally, the file stores a transport-specific process handle, a rolling output buffer, notification objects for tasks waiting on new output, a cancellation token, and a watched `ProcessState` that records whether the process exited or failed.

When a process starts, this file launches a background task to collect output. For local PTY processes, it receives combined stdout and stderr chunks. For exec-server processes, it repeatedly asks the server for new chunks and listens for wake-up signals. Each chunk is saved for later snapshots and also broadcast to live listeners.

It also performs an important early check: if a sandboxed command exits almost immediately, the captured output is inspected to see whether the sandbox blocked the command. Without this file, callers would need separate, error-prone logic for local versus remote processes, and process cleanup could easily leak running commands or leave listeners waiting forever.

#### Function details

##### `SpawnLifecycle::inherited_fds`  (lines 42–44)

```
fn inherited_fds(&self) -> Vec<i32>
```

**Purpose**: This hook lets a spawn helper say which file descriptors must stay open while a child process is being created. A file descriptor is a small operating-system number that points to an open file, pipe, or similar resource.

**Data flow**: It receives the lifecycle object itself and, by default, reads no extra data. It returns an empty list, meaning there are no special open resources to preserve unless another implementation overrides it.

**Call relations**: This is part of the `SpawnLifecycle` contract used around local process startup. The default behavior is deliberately safe and does nothing; specialized lifecycle objects can provide descriptors before spawning, then clean up after spawning.

*Call graph*: 1 external calls (new).


##### `SpawnLifecycle::after_spawn`  (lines 46–46)

```
fn after_spawn(&mut self)
```

**Purpose**: This hook runs after a child process has been spawned, giving custom launch code a chance to release or finalize any temporary setup. The default version intentionally does nothing.

**Data flow**: It receives mutable access to the lifecycle object. It produces no return value and changes nothing unless a custom implementation overrides it.

**Call relations**: It pairs with `SpawnLifecycle::inherited_fds`: first resources can be kept open for the child, then `after_spawn` marks the point where the parent may safely stop holding them.


##### `UnifiedExecProcess::fmt`  (lines 92–98)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This creates a short debug description of a `UnifiedExecProcess`. It is meant for logs and developer diagnostics, not for user-facing output.

**Data flow**: It reads whether the process has exited, the current exit code if any, and the sandbox type. It writes those facts into Rust's debug formatter and returns the formatting result.

**Call relations**: When Rust debug-printing is requested for `UnifiedExecProcess`, this method calls `has_exited` and `exit_code` so the printed view reflects the current process state without exposing every internal field.

*Call graph*: calls 2 internal fn (exit_code, has_exited); 1 external calls (debug_struct).


##### `UnifiedExecProcess::new`  (lines 102–131)

```
fn new(
        process_handle: ProcessHandle,
        sandbox_type: SandboxType,
        spawn_lifecycle: Option<SpawnLifecycleHandle>,
    ) -> Self
```

**Purpose**: This builds the shared bookkeeping around an already-created process handle. It sets up output storage, notifications, cancellation, broadcast channels, and state tracking.

**Data flow**: It takes a local or exec-server process handle, the sandbox type, and optional spawn-lifecycle object. It creates fresh shared buffers, notification objects, a cancellation token, a broadcast channel for output chunks, and a watch channel for process state, then returns a ready `UnifiedExecProcess` with no output task yet.

**Call relations**: `from_spawned` and `from_exec_server_started` use this as the common constructor. After it creates the shared shell, those functions attach the correct background output task for the transport being used.

*Call graph*: calls 1 internal fn (default); 8 external calls (new, new, new, new, new, channel, default, channel).


##### `UnifiedExecProcess::write`  (lines 133–156)

```
async fn write(&self, data: &[u8]) -> Result<(), UnifiedExecError>
```

**Purpose**: This sends bytes to the running process as standard input. Callers use it when they need to type into the command, for example to answer a prompt.

**Data flow**: It receives a byte slice. For a local PTY, it sends those bytes to the PTY writer channel. For an exec-server process, it asks the server to write the bytes and checks whether the server accepted them. If the process is gone or stdin is closed, it marks the process as exited, cancels waiting work, and returns a write error.

**Call relations**: This method is the input side of the unified process wrapper. It hides the difference between local channel-based writing and remote server writing, and it updates shared state when a write reveals that the process can no longer receive input.

*Call graph*: calls 1 internal fn (process_failed); 3 external calls (cancel, send_replace, borrow).


##### `UnifiedExecProcess::output_handles`  (lines 158–166)

```
fn output_handles(&self) -> OutputHandles
```

**Purpose**: This packages the shared output-related objects so another task can read and update process output safely. It is a small handoff bundle for background output collectors.

**Data flow**: It reads the process's shared output buffer, notification objects, closed flag, and cancellation token. It clones the shared pointers and returns them inside an `OutputHandles` struct.

**Call relations**: `from_exec_server_started` uses this before starting the exec-server output task. That task receives the handles so it can append chunks, wake listeners, mark output as closed, and cancel waiters.

*Call graph*: 2 external calls (clone, clone).


##### `UnifiedExecProcess::output_receiver`  (lines 168–170)

```
fn output_receiver(&self) -> tokio::sync::broadcast::Receiver<Vec<u8>>
```

**Purpose**: This gives a caller a live subscription to future output chunks from the process. It is for streaming output as it arrives.

**Data flow**: It reads the internal broadcast sender and creates a new receiver subscribed to that stream. The caller gets future byte chunks, but not necessarily old chunks already sent.

**Call relations**: `start_streaming_output` calls this when it wants to stream command output to another part of the system. The background output tasks feed the broadcast channel that this receiver listens to.

*Call graph*: called by 1 (start_streaming_output); 1 external calls (subscribe).


##### `UnifiedExecProcess::cancellation_token`  (lines 172–174)

```
fn cancellation_token(&self) -> CancellationToken
```

**Purpose**: This returns a clone of the process cancellation token. A cancellation token is a shared stop signal that async tasks can watch.

**Data flow**: It reads the internal token and returns a clone that points to the same cancellation state. Cancelling any linked token tells all watchers that the process is done or should stop.

**Call relations**: `start_streaming_output` calls this so its streaming loop can stop promptly when the process exits, fails, or is terminated.

*Call graph*: called by 1 (start_streaming_output); 1 external calls (clone).


##### `UnifiedExecProcess::output_drained_notify`  (lines 176–178)

```
fn output_drained_notify(&self) -> Arc<Notify>
```

**Purpose**: This returns a notification object used to signal that output has been fully consumed. It lets cooperating tasks wait until no more buffered output needs to be sent.

**Data flow**: It reads the shared `output_drained` notifier and returns another shared reference to it. The function itself does not wait or notify.

**Call relations**: `start_streaming_output` calls this when coordinating output streaming and shutdown, so the streamer and the process wrapper can agree when output has been drained.

*Call graph*: called by 1 (start_streaming_output); 1 external calls (clone).


##### `UnifiedExecProcess::has_exited`  (lines 180–186)

```
fn has_exited(&self) -> bool
```

**Purpose**: This answers whether the process is known to have exited. It checks the shared process state, and for local processes also asks the PTY session directly.

**Data flow**: It reads the watched `ProcessState`. If the process is local, it combines that state with the PTY handle's own exit flag. It returns true if either source says the process has exited; for exec-server processes, it trusts the shared state.

**Call relations**: `fmt` uses this for debug output, and `check_for_sandbox_denial_with_text` uses it to avoid judging sandbox errors before a process has actually finished.

*Call graph*: called by 2 (check_for_sandbox_denial_with_text, fmt); 1 external calls (borrow).


##### `UnifiedExecProcess::exit_code`  (lines 188–196)

```
fn exit_code(&self) -> Option<i32>
```

**Purpose**: This returns the process exit code if one is known. An exit code is the number a program reports when it finishes, usually with zero meaning success.

**Data flow**: It reads the watched state. For local processes, if the state has no exit code yet, it also asks the PTY session. For exec-server processes, it returns the state value directly.

**Call relations**: `fmt` includes this in debug output, `terminate_confirmed` records it when forcing shutdown, and `check_for_sandbox_denial_with_text` uses it when building an error report.

*Call graph*: called by 3 (check_for_sandbox_denial_with_text, fmt, terminate_confirmed); 1 external calls (borrow).


##### `UnifiedExecProcess::finish_termination`  (lines 198–205)

```
fn finish_termination(&self)
```

**Purpose**: This performs the common local cleanup after a process is being stopped. It marks output as closed, wakes waiters, cancels linked tasks, and aborts the output collection task if one exists.

**Data flow**: It reads no external input. It changes internal shared flags and notifications: output becomes closed, waiters are woken, the cancellation token is cancelled, and the background output task is aborted.

**Call relations**: Both `terminate` and `terminate_confirmed` call this after sending the actual stop request. It centralizes the cleanup so all termination paths leave listeners in the same finished state.

*Call graph*: called by 2 (terminate, terminate_confirmed); 1 external calls (cancel).


##### `UnifiedExecProcess::terminate`  (lines 207–218)

```
fn terminate(&self)
```

**Purpose**: This asks the process to stop and immediately performs local cleanup. It is the fast, best-effort termination path.

**Data flow**: It checks whether the process is local or exec-server backed. For a local process it calls the PTY terminate method. For an exec-server process it spawns an async task to request termination from the server. Then it calls `finish_termination` to close output and cancel waiters.

**Call relations**: `drop` calls this automatically when the wrapper is destroyed, and `fail_and_terminate` uses it after recording a failure. The call graph also shows it used by `fail_process_with_message`, so explicit failure paths can stop the process promptly.

*Call graph*: calls 1 internal fn (finish_termination); called by 3 (drop, fail_and_terminate, fail_process_with_message); 2 external calls (clone, spawn).


##### `UnifiedExecProcess::terminate_confirmed`  (lines 220–233)

```
async fn terminate_confirmed(&self) -> Result<(), UnifiedExecError>
```

**Purpose**: This asks the process to stop and waits for remote termination errors to be reported. It is useful when the caller needs confirmation instead of fire-and-forget cleanup.

**Data flow**: It sends a terminate request to the local process or awaits the exec-server terminate request. If the server reports an error, it returns a process failure error. Otherwise it records the current exit code through `signal_exit`, runs `finish_termination`, and returns success.

**Call relations**: This is the stricter sibling of `terminate`. It calls `exit_code`, `signal_exit`, and `finish_termination` so the shared state and waiting tasks are updated after a confirmed stop.

*Call graph*: calls 3 internal fn (exit_code, finish_termination, signal_exit).


##### `UnifiedExecProcess::interrupt`  (lines 235–245)

```
async fn interrupt(&self) -> Result<(), UnifiedExecError>
```

**Purpose**: This sends an interrupt signal to the process, similar to pressing Ctrl-C in a terminal. It gives the program a chance to stop itself cleanly.

**Data flow**: It checks the transport. For a local PTY, it sends the PTY interrupt signal. For an exec-server process, it awaits the server's interrupt request. It returns success if the signal was sent, or a process failure error if sending failed.

**Call relations**: Callers use this when they want to interrupt rather than forcibly terminate. The method translates the single unified idea of interrupting into the signal type required by each backend.


##### `UnifiedExecProcess::fail_and_terminate`  (lines 247–253)

```
fn fail_and_terminate(&self, message: String)
```

**Purpose**: This records a failure message for the process, if one has not already been recorded, and then stops the process. It is used when something outside normal process exit has gone wrong.

**Data flow**: It receives a failure message string. It reads the current state, stores the message only if there is not already a failure message, and then calls `terminate` to stop the process and clean up.

**Call relations**: `fail_process_with_message` calls this in failure paths. This method connects state reporting with process shutdown, so users see a reason instead of only seeing that the process disappeared.

*Call graph*: calls 1 internal fn (terminate); called by 1 (fail_process_with_message); 2 external calls (send_replace, borrow).


##### `UnifiedExecProcess::snapshot_output`  (lines 255–258)

```
async fn snapshot_output(&self) -> Vec<Vec<u8>>
```

**Purpose**: This takes a safe snapshot of the output collected so far. It is used when code needs to inspect accumulated output rather than stream future chunks.

**Data flow**: It locks the shared output buffer, copies out its stored chunks, and returns them as byte vectors. The original buffer stays in place for other readers and writers.

**Call relations**: `check_for_sandbox_denial` calls this after giving the process a brief chance to produce output, so sandbox detection can examine what the command printed before or while exiting.

*Call graph*: called by 1 (check_for_sandbox_denial); 1 external calls (lock).


##### `UnifiedExecProcess::sandbox_type`  (lines 260–262)

```
fn sandbox_type(&self) -> SandboxType
```

**Purpose**: This returns which sandbox, if any, was used for the process. A sandbox is a restriction layer that limits what the command can access.

**Data flow**: It reads the stored sandbox type and returns it. It does not change any state.

**Call relations**: `check_for_sandbox_denial_with_text` calls this to decide whether sandbox-specific denial detection should run at all.

*Call graph*: called by 1 (check_for_sandbox_denial_with_text).


##### `UnifiedExecProcess::failure_message`  (lines 264–266)

```
fn failure_message(&self) -> Option<String>
```

**Purpose**: This returns the recorded process failure message, if there is one. It lets higher-level code explain why the process failed beyond just an exit code.

**Data flow**: It reads the current watched process state and clones the optional failure message. The process state itself is not changed.

**Call relations**: The call graph shows `fail_process_with_message` using this. That lets external failure handling check what has already been recorded before deciding what to report or overwrite.

*Call graph*: called by 1 (fail_process_with_message); 1 external calls (borrow).


##### `UnifiedExecProcess::check_for_sandbox_denial`  (lines 268–282)

```
async fn check_for_sandbox_denial(&self) -> Result<(), UnifiedExecError>
```

**Purpose**: This checks whether a just-finished sandboxed process probably failed because the sandbox blocked it. It gathers the output first, because denial clues often appear in stderr text.

**Data flow**: It briefly waits for output notification, snapshots collected output chunks, joins them into one byte buffer, converts the bytes to text, and passes that text to `check_for_sandbox_denial_with_text`. It returns success if no denial is detected, or a sandbox-denied error if one is detected.

**Call relations**: `from_spawned` and `from_exec_server_started` use this during early-exit handling. It depends on `snapshot_output` for the captured text and delegates the actual judgment to `check_for_sandbox_denial_with_text`.

*Call graph*: calls 2 internal fn (check_for_sandbox_denial_with_text, snapshot_output); 4 external calls (from_millis, from_utf8_lossy, new, timeout).


##### `UnifiedExecProcess::check_for_sandbox_denial_with_text`  (lines 284–313)

```
async fn check_for_sandbox_denial_with_text(
        &self,
        text: &str,
    ) -> Result<(), UnifiedExecError>
```

**Purpose**: This decides whether finished process output looks like a sandbox access denial and, if so, turns that into a clear error. It avoids treating ordinary failures as sandbox failures.

**Data flow**: It receives output text. It first checks the sandbox type and whether the process has exited; if there is no sandbox or the process is still running, it returns success. Otherwise it builds an execution-output summary with the exit code and text, asks the sandbox-denial detector, and if denied returns an error with a shortened readable snippet.

**Call relations**: `check_for_sandbox_denial` calls this after collecting output. It calls `sandbox_type`, `has_exited`, and `exit_code` to gather context, then relies on `is_likely_sandbox_denied` and text truncation to produce a useful final error.

*Call graph*: calls 6 internal fn (is_likely_sandbox_denied, sandbox_denied, exit_code, has_exited, sandbox_type, new); called by 1 (check_for_sandbox_denial); 4 external calls (default, formatted_truncate_text, format!, Tokens).


##### `UnifiedExecProcess::from_spawned`  (lines 315–373)

```
async fn from_spawned(
        spawned: SpawnedPty,
        sandbox_type: SandboxType,
        spawn_lifecycle: SpawnLifecycleHandle,
    ) -> Result<Self, UnifiedExecError>
```

**Purpose**: This turns a newly spawned local PTY process into a `UnifiedExecProcess`. It starts local output collection and handles the special case where the process exits almost immediately.

**Data flow**: It receives a `SpawnedPty`, sandbox type, and spawn-lifecycle object. It combines stdout and stderr into one output stream, creates the unified wrapper, starts the local output task, then checks the exit receiver immediately and again for a short grace period. If the process already exited, it records the exit and checks for sandbox denial; otherwise it spawns a watcher task that will record exit later.

**Call relations**: `open_session_with_exec_env` calls this after launching a local command. Inside, it uses `new` to build the wrapper and `spawn_local_output_task` to begin moving output into the shared buffer and broadcast stream.

*Call graph*: called by 1 (open_session_with_exec_env); 8 external calls (clone, new, new, spawn_local_output_task, combine_output_receivers, Local, spawn, timeout).


##### `UnifiedExecProcess::from_exec_server_started`  (lines 375–408)

```
async fn from_exec_server_started(
        started: StartedExecProcess,
        sandbox_type: SandboxType,
    ) -> Result<Self, UnifiedExecError>
```

**Purpose**: This turns a process that was started through the exec server into a `UnifiedExecProcess`. It starts the remote output polling task and checks for very fast failures.

**Data flow**: It receives a `StartedExecProcess` and sandbox type. It wraps the server process handle, creates shared output handles, launches the exec-server output task, then watches the process state for a short grace period. If the process exits or fails quickly, it checks for sandbox denial before returning the wrapper.

**Call relations**: This is called by `open_session_with_exec_env`, `blocking_terminate_unified_process`, `remote_process`, and `remote_process_waits_for_early_exit_event`. It uses `new`, `output_handles`, and `spawn_exec_server_output_task` to make a remote process look like the same kind of object as a local one.

*Call graph*: called by 4 (blocking_terminate_unified_process, open_session_with_exec_env, remote_process, remote_process_waits_for_early_exit_event); 5 external calls (clone, new, spawn_exec_server_output_task, ExecServer, timeout).


##### `UnifiedExecProcess::spawn_exec_server_output_task`  (lines 410–497)

```
fn spawn_exec_server_output_task(
        started: StartedExecProcess,
        output_handles: OutputHandles,
        output_tx: broadcast::Sender<Vec<u8>>,
        state_tx: watch::Sender<ProcessStat
```

**Purpose**: This starts the background task that collects output and state updates from an exec-server process. It is the bridge between the remote server protocol and the local shared buffers.

**Data flow**: It receives the started server process, shared output handles, the output broadcast sender, and the process-state sender. The spawned task repeatedly reads new chunks from the server, appends them to the buffer, broadcasts them, wakes listeners, records failures or exits, marks output closed when the server says it is closed, and waits for server wake signals before reading again.

**Call relations**: `from_exec_server_started` calls this during remote process setup. The task feeds the same output buffer and broadcast channel that streaming callers use, so remote output follows the same path as local output after collection.

*Call graph*: 4 external calls (borrow, send, send_replace, spawn).


##### `UnifiedExecProcess::spawn_local_output_task`  (lines 499–526)

```
fn spawn_local_output_task(
        mut receiver: tokio::sync::broadcast::Receiver<Vec<u8>>,
        buffer: OutputBuffer,
        output_notify: Arc<Notify>,
        output_closed: Arc<AtomicBool>,
```

**Purpose**: This starts the background task that collects output from a local PTY process. It copies each output chunk into shared storage and sends it to live subscribers.

**Data flow**: It receives a broadcast receiver for local output, the shared buffer, notification objects, a closed flag, and an output broadcaster. The spawned task waits for chunks, stores each chunk in the buffer, rebroadcasts it, and wakes listeners. If it falls behind, it skips missed chunks and keeps going; if the source closes, it marks output closed and wakes waiters.

**Call relations**: `from_spawned` calls this after combining stdout and stderr. The task makes local PTY output available through the same buffer and streaming channel used by the rest of the unified execution system.

*Call graph*: calls 1 internal fn (recv); 3 external calls (lock, send, spawn).


##### `UnifiedExecProcess::signal_exit`  (lines 528–532)

```
fn signal_exit(&self, exit_code: Option<i32>)
```

**Purpose**: This records that the process has exited and cancels tasks waiting on it. It is a small internal helper for updating shared exit state consistently.

**Data flow**: It receives an optional exit code. It reads the current state, replaces it with an exited version containing that code, sends the new state to watchers, and cancels the cancellation token.

**Call relations**: `terminate_confirmed` calls this after a confirmed termination. Other exit paths update state directly, but this helper provides a compact way to pair exit-state recording with cancellation.

*Call graph*: called by 1 (terminate_confirmed); 3 external calls (cancel, send_replace, borrow).


##### `UnifiedExecProcess::drop`  (lines 536–538)

```
fn drop(&mut self)
```

**Purpose**: This is the automatic cleanup that runs when a `UnifiedExecProcess` is destroyed. It prevents a wrapped process from being left running accidentally.

**Data flow**: It receives mutable access to the process wrapper during destruction. It calls `terminate`, which sends the stop request and closes/cancels local output machinery.

**Call relations**: Rust calls this automatically when the wrapper goes out of scope. By delegating to `terminate`, it reuses the same cleanup path as explicit termination and reduces the risk of leaked child processes.

*Call graph*: calls 1 internal fn (terminate).


### `core/src/unified_exec/process_manager.rs`

`orchestration` · `request handling and background process lifecycle`

When Codex runs a command, it may finish quickly, or it may become a live background terminal that the user can keep polling or type into later. This file makes that possible. It gives each process an ID, builds the right environment variables, asks the sandbox and approval systems whether the command is allowed, starts the process locally or through a remote exec server, then gathers output until a time limit is reached. If the process is still alive, it stores the process so later calls can find it again.

The file also deals with the awkward edges of real processes. It watches for network permission denial, turns that into a clear error, and terminates the process if needed. It emits start and end events so the rest of the system can show what happened. It protects a newly started background process from being dropped too early, like putting a name tag on a suitcase before it goes onto the carousel. It also prunes old stored processes when there are too many, preferring not to remove the most recently used ones.

Without this file, command execution would be much less reliable: long-running commands could disappear, output could be missed, network-denial errors could be confusing, and process IDs could leak or collide.

#### Function details

##### `set_deterministic_process_ids_for_tests`  (lines 85–87)

```
fn set_deterministic_process_ids_for_tests(enabled: bool)
```

**Purpose**: Turns predictable process IDs on or off for tests. This makes test results repeatable instead of depending on random numbers.

**Data flow**: It receives a true-or-false value, stores that value in a shared atomic flag, and returns nothing. Afterward, process ID allocation can read the flag and choose deterministic IDs.

**Call relations**: This is a test support switch. The call graph records it as being called in its own test-facing path, and the real effect is later seen when should_use_deterministic_process_ids checks the flag before allocate_process_id chooses an ID.

*Call graph*: called by 1 (set_deterministic_process_ids_for_tests).


##### `deterministic_process_ids_forced_for_tests`  (lines 89–91)

```
fn deterministic_process_ids_forced_for_tests() -> bool
```

**Purpose**: Reads whether tests have forced deterministic process IDs. It is a tiny helper that hides the shared flag access.

**Data flow**: It reads the atomic test flag and returns true if deterministic IDs are currently forced, otherwise false. It does not change any state.

**Call relations**: should_use_deterministic_process_ids calls this when deciding whether allocation should use predictable IDs. That keeps the allocation code from touching the flag directly.

*Call graph*: called by 1 (should_use_deterministic_process_ids).


##### `should_use_deterministic_process_ids`  (lines 93–95)

```
fn should_use_deterministic_process_ids() -> bool
```

**Purpose**: Decides whether process IDs should be predictable instead of random. This is useful in tests, where stable IDs make assertions easier.

**Data flow**: It checks whether the code is running in test mode and also reads the test override flag. It returns one true-or-false answer for the ID allocator.

**Call relations**: allocate_process_id calls this before choosing an ID. It combines the built-in test check with deterministic_process_ids_forced_for_tests so the allocator has one simple decision to follow.

*Call graph*: calls 1 internal fn (deterministic_process_ids_forced_for_tests); called by 1 (allocate_process_id); 1 external calls (cfg!).


##### `apply_unified_exec_env`  (lines 97–102)

```
fn apply_unified_exec_env(mut env: HashMap<String, String>) -> HashMap<String, String>
```

**Purpose**: Adds a standard set of environment variables for commands run through unified exec. These variables make command output plainer and more predictable, such as disabling colors and pagers.

**Data flow**: It receives an environment map, inserts fixed key-value pairs like NO_COLOR and PAGER, and returns the updated map. Existing values for those keys are overwritten.

**Call relations**: open_session_with_sandbox calls this while preparing a command request. It happens before the command is handed to the tool orchestration layer, so every unified exec command gets the same baseline behavior.

*Call graph*: called by 1 (open_session_with_sandbox).


##### `exec_env_policy_from_shell_policy`  (lines 104–122)

```
fn exec_env_policy_from_shell_policy(
    policy: &ShellEnvironmentPolicy,
) -> codex_exec_server::ExecEnvPolicy
```

**Purpose**: Converts Codex's shell environment policy into the format expected by the exec server. An environment policy is the rulebook for which environment variables are inherited, excluded, or explicitly set.

**Data flow**: It receives a ShellEnvironmentPolicy, copies its inheritance and include/exclude rules into an ExecEnvPolicy, and returns that converted policy. It does not modify the original policy.

**Call relations**: open_session_with_sandbox calls this when building the exec-server environment configuration. That converted policy can later travel through exec_server_params_for_request when a remote backend starts the process.

*Call graph*: called by 1 (open_session_with_sandbox).


##### `env_overlay_for_exec_server`  (lines 124–133)

```
fn env_overlay_for_exec_server(
    request_env: &HashMap<String, String>,
    local_policy_env: &HashMap<String, String>,
) -> HashMap<String, String>
```

**Purpose**: Finds only the environment variables that differ from the locally computed policy environment. This avoids sending redundant values to the exec server.

**Data flow**: It compares the request environment with the local policy environment. For each variable whose value is new or different, it copies that pair into a smaller map and returns it.

**Call relations**: exec_server_env_for_request calls this when an exec-server environment configuration is present. It prepares the compact overlay that exec_server_params_for_request will include in the remote start request.

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

**Purpose**: Builds the environment information that should be sent to an exec server. It separates the policy rulebook from the explicit environment overrides.

**Data flow**: It receives an ExecRequest. If the request contains exec-server environment configuration, it returns that policy plus the smaller overlay; otherwise it returns no policy and a clone of the full request environment.

**Call relations**: exec_server_params_for_request calls this while assembling the complete remote execution parameters. It delegates the comparison work to env_overlay_for_exec_server when needed.

*Call graph*: calls 1 internal fn (env_overlay_for_exec_server); called by 1 (exec_server_params_for_request).


##### `exec_server_params_for_request`  (lines 151–167)

```
fn exec_server_params_for_request(
    process_id: i32,
    request: &ExecRequest,
    tty: bool,
) -> codex_exec_server::ExecParams
```

**Purpose**: Packages a command request into the exact parameter object a remote exec server expects. This is the bridge between Codex's internal request shape and the server protocol.

**Data flow**: It receives a process ID, an ExecRequest, and whether the command should use a terminal. It converts the process ID to the server form, converts the working directory to a URI, attaches command arguments and environment data, and returns ExecParams.

**Call relations**: open_session_with_exec_env calls this only when the selected environment is remote. It relies on exec_server_env_for_request for environment data and exec_server_process_id for the ID string.

*Call graph*: calls 3 internal fn (exec_server_env_for_request, exec_server_process_id, from_abs_path); called by 1 (open_session_with_exec_env).


##### `InitialExecCommandGuard::drop`  (lines 191–193)

```
fn drop(&mut self)
```

**Purpose**: Marks the initial command-start call as no longer active when its guard goes out of scope. This prevents cleanup code from removing a process while its first response is still being prepared.

**Data flow**: It has no explicit input beyond the guard object. When the guard is dropped, it writes false into a shared atomic flag and returns nothing.

**Call relations**: exec_command creates this guard after storing a still-running process. Later, terminate_process checks the same flag and avoids removing a process that is still in its initial startup window.


##### `exec_server_process_id`  (lines 196–198)

```
fn exec_server_process_id(process_id: i32) -> String
```

**Purpose**: Converts an internal numeric process ID into the string form used by the exec server. It is deliberately simple so both sides use the same visible ID.

**Data flow**: It receives an integer process ID and returns the same value as a string. It does not read or change shared state.

**Call relations**: exec_server_params_for_request calls this while building remote execution parameters. The resulting string becomes the process_id field sent to the exec backend.

*Call graph*: called by 1 (exec_server_params_for_request).


##### `unregister_network_approval_for_entry`  (lines 200–210)

```
async fn unregister_network_approval_for_entry(entry: &ProcessEntry)
```

**Purpose**: Removes a stored network-approval registration for a process entry. This avoids leaving stale permission requests behind after a process is gone.

**Data flow**: It receives a ProcessEntry, checks whether it has a deferred network approval and whether its session is still alive, then asks the session's network approval service to unregister that call. It returns nothing.

**Call relations**: release_process_id, store_process, terminate_all_processes, and terminate_process call this during cleanup. It is always used after a process entry is being removed or discarded.

*Call graph*: called by 4 (release_process_id, store_process, terminate_all_processes, terminate_process).


##### `finish_network_approval_after_process_exit_for_entry`  (lines 212–221)

```
async fn finish_network_approval_after_process_exit_for_entry(
    entry: &ProcessEntry,
) -> Result<(), String>
```

**Purpose**: Finishes any deferred network approval connected to a process that has exited. This turns a pending network decision into either success or a readable error.

**Data flow**: It receives a ProcessEntry, upgrades its weak session reference if possible, forwards the session and deferred approval to the session-based helper, and returns either success or an error message string.

**Call relations**: write_stdin calls this after polling shows that a stored process has exited. It hands the real work to finish_deferred_network_approval_after_process_exit_for_session.

*Call graph*: calls 1 internal fn (finish_deferred_network_approval_after_process_exit_for_session); called by 1 (write_stdin).


##### `finish_deferred_network_approval_for_session`  (lines 223–233)

```
async fn finish_deferred_network_approval_for_session(
    session: Option<&Arc<crate::session::session::Session>>,
    deferred: Option<DeferredNetworkApproval>,
) -> Result<(), String>
```

**Purpose**: Completes a deferred network approval for a session, if there is still a session to report to. Deferred means the command was started while the network decision could still arrive later.

**Data flow**: It receives an optional session and optional deferred approval. If there is no session, it succeeds immediately; otherwise it calls the network approval finisher and converts any ToolError into a plain string.

**Call relations**: exec_command and write_stdin use this when a process fails or needs final network approval cleanup. finish_deferred_network_approval_after_process_exit_for_session also calls it after waiting briefly for late denial.

*Call graph*: calls 1 internal fn (finish_deferred_network_approval); called by 3 (exec_command, write_stdin, finish_deferred_network_approval_after_process_exit_for_session).


##### `network_approval_error_message`  (lines 235–240)

```
fn network_approval_error_message(err: ToolError) -> String
```

**Purpose**: Turns a network approval error into text that can be shown to a user. It preserves a rejection message when one exists.

**Data flow**: It receives a ToolError. If the user or policy rejected the request, it returns that message; if it is a Codex error, it converts the error to a string.

**Call relations**: network_denial_message_for_session calls this when finishing deferred network approval fails. That message can then be used to fail and terminate the process.

*Call graph*: called by 1 (network_denial_message_for_session); 1 external calls (to_string).


##### `network_denial_message_for_session`  (lines 242–253)

```
async fn network_denial_message_for_session(
    session: Option<&Arc<crate::session::session::Session>>,
    deferred: Option<DeferredNetworkApproval>,
) -> String
```

**Purpose**: Creates the final message to use when network access is denied. It prefers a specific approval-service error, but falls back to a standard denial sentence.

**Data flow**: It receives an optional session and optional deferred network approval. With no session it returns the default denial message; with a session it finishes the approval and returns either the default success-denial wording or the specific error text.

**Call relations**: exec_command, write_stdin, and terminate_process_on_network_denial call this when network cancellation is observed. It uses finish_deferred_network_approval and network_approval_error_message to produce user-facing text.

*Call graph*: calls 2 internal fn (finish_deferred_network_approval, network_approval_error_message); called by 3 (exec_command, write_stdin, terminate_process_on_network_denial).


##### `wait_for_late_network_denial`  (lines 255–267)

```
async fn wait_for_late_network_denial(network_cancelled: Option<CancellationToken>) -> bool
```

**Purpose**: Waits a very short time after process exit to see whether a network denial arrives. This prevents a race where the process exits and the denial signal follows milliseconds later.

**Data flow**: It receives an optional cancellation token. If there is no token it returns false; if the token is already cancelled or becomes cancelled during the grace period, it returns true; otherwise it returns false.

**Call relations**: finish_deferred_network_approval_after_process_exit_for_session calls this before completing network approval. That gives the approval path a chance to notice a late denial before declaring cleanup done.

*Call graph*: called by 1 (finish_deferred_network_approval_after_process_exit_for_session); 1 external calls (select!).


##### `finish_deferred_network_approval_after_process_exit_for_session`  (lines 269–280)

```
async fn finish_deferred_network_approval_after_process_exit_for_session(
    session: Option<&Arc<crate::session::session::Session>>,
    deferred: Option<DeferredNetworkApproval>,
) -> Result<(), St
```

**Purpose**: Completes network approval cleanup after a process exits, while accounting for late denial signals. It is the safer post-exit version of the normal finisher.

**Data flow**: It receives an optional session and optional deferred approval. It first waits briefly for possible network cancellation, then finishes the deferred approval for the session and returns success or an error message.

**Call relations**: exec_command calls this for processes that exit during the initial command call. finish_network_approval_after_process_exit_for_entry also calls it when write_stdin discovers a stored process has exited.

*Call graph*: calls 2 internal fn (finish_deferred_network_approval_for_session, wait_for_late_network_denial); called by 2 (exec_command, finish_network_approval_after_process_exit_for_entry).


##### `fail_process_with_message`  (lines 282–290)

```
fn fail_process_with_message(process: &UnifiedExecProcess, message: String) -> UnifiedExecError
```

**Purpose**: Marks a process as failed, terminates it, and returns a UnifiedExecError describing the failure. It also respects an existing failure message if one was already recorded.

**Data flow**: It receives a process and a message. If the process already has a failure message, it terminates and returns that existing error; otherwise it records the new message, terminates, and returns an error using the stored message.

**Call relations**: exec_command and write_stdin call this when network approval or another process-level failure must be surfaced. It calls the process methods that record failure and stop the running command.

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

**Purpose**: Emits a failed end event for an initial command only if the process was never stored as a background process. This keeps event reporting complete without duplicating the watcher’s work.

**Data flow**: It receives the startup state, execution context, request details, output transcript, fallback output, error message, and elapsed time. If the process had already been stored alive, it does nothing; otherwise it emits a failed exec-end event.

**Call relations**: exec_command calls this on failure paths during the initial command call. Stored processes are left to the background watcher, while short-lived or failed-before-store processes get their end event here.

*Call graph*: calls 1 internal fn (emit_failed_exec_end_for_unified_exec); called by 1 (exec_command); 1 external calls (clone).


##### `terminate_process_on_network_denial`  (lines 322–343)

```
fn terminate_process_on_network_denial(
    process: Arc<UnifiedExecProcess>,
    session: std::sync::Weak<crate::session::session::Session>,
    deferred: DeferredNetworkApproval,
)
```

**Purpose**: Starts a background task that kills a process if its deferred network approval is denied. This lets a running command be stopped as soon as the sandbox network proxy says no.

**Data flow**: It receives the process, a weak reference to the session, and the deferred network approval. The spawned task waits for either network cancellation or process exit plus a short grace period; if denial happened, it builds a message and fails the process.

**Call relations**: exec_command calls this right after a process starts with deferred network approval. The task uses network_denial_message_for_session and the process cancellation token to coordinate network and process lifetime.

*Call graph*: calls 2 internal fn (cancellation_token, network_denial_message_for_session); called by 1 (exec_command); 4 external calls (as_ref, upgrade, select!, spawn).


##### `UnifiedExecProcessManager::allocate_process_id`  (lines 346–371)

```
async fn allocate_process_id(&self) -> i32
```

**Purpose**: Reserves a unique process ID for a new command. In production it uses random IDs; in tests it can use predictable IDs.

**Data flow**: It locks the process store, chooses an ID, checks whether it is already reserved, and repeats until it finds a free one. It records the reserved ID and returns it.

**Call relations**: This is used before starting commands so later calls can refer to the process. It calls should_use_deterministic_process_ids to decide between test-friendly IDs and random production IDs.

*Call graph*: calls 1 internal fn (should_use_deterministic_process_ids); 1 external calls (rng).


##### `UnifiedExecProcessManager::release_process_id`  (lines 373–381)

```
async fn release_process_id(&self, process_id: i32)
```

**Purpose**: Removes a process ID and its stored process entry from the manager. It also cleans up any network approval registration tied to that entry.

**Data flow**: It receives a process ID, locks the store, removes that ID if present, then unregisters network approval for the removed entry. It returns nothing.

**Call relations**: exec_command and write_stdin call this when a process fails, exits, or should no longer be tracked. It delegates network approval cleanup to unregister_network_approval_for_entry.

*Call graph*: calls 1 internal fn (unregister_network_approval_for_entry); called by 2 (exec_command, write_stdin).


##### `UnifiedExecProcessManager::exec_command`  (lines 383–614)

```
async fn exec_command(
        &self,
        request: ExecCommandRequest,
        context: &UnifiedExecContext,
    ) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

**Purpose**: Starts a new command and returns the first chunk of its output. If the command keeps running, it stores the process so later calls can poll it or write input.

**Data flow**: It receives an ExecCommandRequest and execution context. It opens the command through sandbox and approval machinery, emits a begin event, starts output streaming, waits up to the requested yield time, checks for failure or network denial, records or releases the process as needed, and returns an ExecCommandToolOutput containing output, timing, process ID, and exit code.

**Call relations**: This is the main new-command path. It calls open_session_with_sandbox to start the process, store_process for long-running commands, collect_output_until_deadline to gather output, refresh_process_state to see if the process is alive, and the event/network helpers to report success or failure.

*Call graph*: calls 18 internal fn (unified_exec, new, emit_exec_end_for_unified_exec, start_streaming_output, clamp_yield_time, process_failed, generate_chunk_id, default, open_session_with_sandbox, refresh_process_state (+8 more)); 10 external calls (clone, downgrade, new, new, from_millis, now, collect_output_until_deadline, from_utf8_lossy, approx_token_count, new).


##### `UnifiedExecProcessManager::write_stdin`  (lines 616–769)

```
async fn write_stdin(
        &self,
        request: WriteStdinRequest<'_>,
    ) -> Result<ExecCommandToolOutput, UnifiedExecError>
```

**Purpose**: Sends input to an existing background terminal or polls it for more output. This is how an interactive command can continue after the first exec_command response.

**Data flow**: It receives a WriteStdinRequest with a process ID, input text, timing, and output limits. It looks up the stored process, writes input when allowed, waits for output until a deadline, checks network and failure state, refreshes whether the process is alive or exited, and returns an ExecCommandToolOutput.

**Call relations**: This is the follow-up path after exec_command has stored a live process. It calls prepare_process_handles to borrow the needed process data, collect_output_until_deadline to gather output, refresh_process_state to update lifecycle state, and cleanup helpers when the process fails or exits.

*Call graph*: calls 9 internal fn (process_failed, generate_chunk_id, prepare_process_handles, refresh_process_state, release_process_id, fail_process_with_message, finish_deferred_network_approval_for_session, finish_network_approval_after_process_exit_for_entry, network_denial_message_for_session); 7 external calls (from_millis, now, collect_output_until_deadline, from_utf8_lossy, approx_token_count, matches!, sleep).


##### `UnifiedExecProcessManager::refresh_process_state`  (lines 771–795)

```
async fn refresh_process_state(&self, process_id: i32) -> ProcessStatus
```

**Purpose**: Checks whether a stored process is still running, has exited, or is unknown. If it has exited, it removes the entry from the store.

**Data flow**: It receives a process ID, locks the process store, finds the entry, reads its exit code and exited flag, and returns Alive, Exited with the removed entry, or Unknown.

**Call relations**: exec_command uses this after the first output wait for a newly stored process. write_stdin uses it after writing or polling to decide whether the returned output should still include a process ID.

*Call graph*: called by 2 (exec_command, write_stdin); 1 external calls (new).


##### `UnifiedExecProcessManager::prepare_process_handles`  (lines 797–835)

```
async fn prepare_process_handles(
        &self,
        process_id: i32,
    ) -> Result<PreparedProcessHandles, UnifiedExecError>
```

**Purpose**: Collects all the pieces needed to poll or write to a stored process. It updates the process’s last-used time so pruning knows it is active.

**Data flow**: It receives a process ID, locks the store, finds the entry, updates last_used, clones the process and output handles, upgrades the session reference if possible, and returns a PreparedProcessHandles bundle.

**Call relations**: write_stdin calls this at the start of every follow-up interaction. The returned handles let write_stdin work without keeping the store lock while waiting on output or writing input.

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

**Purpose**: Saves a still-running process in the manager so it can be used later. It also starts a watcher that will emit the final end event when the process exits.

**Data flow**: It receives the process, context, command metadata, working directory, start time, process ID, terminal mode, network approval, transcript, and startup-active flag. It creates a ProcessEntry, prunes one old process if the store is full, inserts the new entry, terminates any pruned process, and starts the exit watcher.

**Call relations**: exec_command calls this when the initial command is still alive. It uses prune_processes_if_needed to make room, unregister_network_approval_for_entry if something was pruned, and spawn_exit_watcher so completion is reported later.

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

**Purpose**: Actually starts a process in the selected execution environment. Depending on the platform and environment, that may mean a Windows sandbox, a remote exec server, a local terminal, or a local pipe-based process.

**Data flow**: It receives a process ID, ExecRequest, terminal flag, spawn lifecycle handle, and environment. It gathers inherited file descriptors, chooses the right backend, starts the process, marks the spawn lifecycle as completed, and wraps the result as a UnifiedExecProcess.

**Call relations**: The unified exec runtime uses this when the orchestrator has approved and prepared a command. It calls exec_server_params_for_request for remote execution, platform sandbox helpers on Windows, or local spawn helpers otherwise.

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

**Purpose**: Prepares a command for sandboxing, approval, environment setup, and eventual process startup. This is the policy-heavy doorway before a command is allowed to run.

**Data flow**: It receives the high-level exec command request, working directory, and context. It builds environment variables, creates exec approval requirements, packages a UnifiedExecToolRequest, runs the tool orchestrator, and returns the started process plus any deferred network approval; sandbox denials are converted into unified exec errors.

**Call relations**: exec_command calls this before any process exists. It uses create_env, apply_unified_exec_env, exec_env_policy_from_shell_policy, ToolOrchestrator, and UnifiedExecRuntime to connect policy decisions to actual process creation.

*Call graph*: calls 6 internal fn (create_env, new, new, apply_unified_exec_env, exec_env_policy_from_shell_policy, plain); called by 1 (exec_command).


##### `UnifiedExecProcessManager::collect_output_until_deadline`  (lines 1116–1203)

```
async fn collect_output_until_deadline(
        output_buffer: &OutputBuffer,
        output_notify: &Arc<Notify>,
        output_closed: &Arc<AtomicBool>,
        output_closed_notify: &Arc<Notify>,
```

**Purpose**: Collects process output until either new output stops, the process closes, or the time limit expires. It is careful not to count user-facing pause time against the deadline.

**Data flow**: It receives the shared output buffer, notification objects, close flags, process cancellation token, optional pause-state receiver, and deadline. It repeatedly drains available chunks, waits for more output or process exit, extends deadlines while paused, and returns all collected bytes.

**Call relations**: exec_command uses this to build the first tool response, and write_stdin uses it for later polls or input responses. It calls extend_deadlines_while_paused and wait_for_pause_change to cooperate with out-of-band pauses.

*Call graph*: 10 external calls (cancelled, is_cancelled, from_millis, now, saturating_duration_since, lock, extend_deadlines_while_paused, with_capacity, pin!, select!).


##### `UnifiedExecProcessManager::extend_deadlines_while_paused`  (lines 1205–1229)

```
async fn extend_deadlines_while_paused(
        pause_state: &mut Option<watch::Receiver<bool>>,
        deadline: &mut Instant,
        post_exit_deadline: &mut Option<Instant>,
    )
```

**Purpose**: Moves output collection deadlines forward while the session is paused. This prevents a pause in the conversation from unfairly consuming the command’s output wait time.

**Data flow**: It receives an optional pause-state receiver, the main deadline, and an optional post-exit deadline. If paused, it waits until the pause ends, measures how long it lasted, and adds that duration to the deadlines.

**Call relations**: collect_output_until_deadline calls this at the top of each loop. It keeps the output collector’s timing fair when the session has temporarily paused for another interaction.

*Call graph*: 1 external calls (now).


##### `UnifiedExecProcessManager::wait_for_pause_change`  (lines 1231–1239)

```
async fn wait_for_pause_change(pause_state: Option<&watch::Receiver<bool>>)
```

**Purpose**: Waits until the pause state changes, or waits forever if there is no pause state to watch. It is used as one branch in output-waiting races.

**Data flow**: It receives an optional pause-state receiver. With a receiver, it waits for a change notification; without one, it returns a pending future that never completes on its own.

**Call relations**: collect_output_until_deadline includes this while waiting for output, exit, or timeout. That lets the collector wake up promptly when a pause begins or ends.


##### `UnifiedExecProcessManager::prune_processes_if_needed`  (lines 1241–1257)

```
fn prune_processes_if_needed(store: &mut ProcessStore) -> Option<ProcessEntry>
```

**Purpose**: Makes room in the process store when too many background processes are tracked. It removes at most one entry.

**Data flow**: It receives the mutable process store. If the store is below the maximum size, it returns nothing; otherwise it builds simple metadata, asks which process ID should be pruned, removes that entry, and returns it.

**Call relations**: store_process calls this before inserting a new long-running process. The caller then performs async cleanup and termination outside the store lock.

*Call graph*: calls 1 internal fn (remove); 1 external calls (process_id_to_prune_from_meta).


##### `UnifiedExecProcessManager::process_id_to_prune_from_meta`  (lines 1260–1286)

```
fn process_id_to_prune_from_meta(meta: &[(i32, Instant, bool)]) -> Option<i32>
```

**Purpose**: Chooses which process should be removed when the store is full. It protects the most recently used processes and prefers removing an already exited one.

**Data flow**: It receives a list of process IDs with last-used times and exited flags. It sorts by recency, protects the newest eight, then returns the oldest unprotected exited process if possible, otherwise the oldest unprotected process.

**Call relations**: prune_processes_if_needed calls this with a lightweight snapshot of the store. Keeping this policy separate makes the pruning rule easy to understand and change.

*Call graph*: 2 external calls (is_empty, to_vec).


##### `UnifiedExecProcessManager::terminate_all_processes`  (lines 1288–1304)

```
async fn terminate_all_processes(&self)
```

**Purpose**: Stops and forgets every stored background process. This is used for broad cleanup, such as shutting down a session or manager.

**Data flow**: It locks the store, drains all process entries, clears reserved IDs, then for each entry unregisters network approval and terminates the process. It returns nothing.

**Call relations**: This is a manager-level teardown path. It uses unregister_network_approval_for_entry for each removed entry before telling the process to terminate.

*Call graph*: calls 1 internal fn (unregister_network_approval_for_entry).


##### `UnifiedExecProcessManager::list_processes`  (lines 1306–1323)

```
async fn list_processes(&self) -> Vec<BackgroundTerminalInfo>
```

**Purpose**: Returns a user-facing list of live background terminals. This lets other parts of the system show which commands are still running.

**Data flow**: It locks the process store, filters out exited processes, sorts the remaining entries by process ID, and converts each into BackgroundTerminalInfo with item ID, process ID, command, and working directory.

**Call relations**: This is a read-only view over the process store. It does not call other project helpers; it simply translates stored process entries into the shape used by the background-terminal listing.


##### `UnifiedExecProcessManager::terminate_process`  (lines 1325–1357)

```
async fn terminate_process(&self, process_id: i32) -> bool
```

**Purpose**: Stops one specific stored process and removes it from tracking when it is safe to do so. It avoids racing with a process that is still in its initial exec_command response.

**Data flow**: It receives a process ID, finds and clones the process, asks it to terminate if needed, then rechecks the store to ensure the same process is still there. If the initial command is still active it leaves the entry in place; otherwise it removes the entry, unregisters network approval, and returns true for success.

**Call relations**: This is the targeted cleanup path for one process. It uses pointer equality to avoid removing a different process that reused state, and calls unregister_network_approval_for_entry after removal.

*Call graph*: calls 1 internal fn (unregister_network_approval_for_entry); 2 external calls (clone, ptr_eq).


### `core/src/tools/handlers/unified_exec/write_stdin.rs`

`io_transport` · `request handling during an existing terminal execution session`

Some commands do not finish after one request. They may ask for input, keep printing output, or run in the background. This file is the bridge that lets the tool system talk to one of those existing command sessions. In everyday terms, if an earlier tool call opened a terminal, this file is the part that lets the model type more keys into it.

The handler accepts a function-style tool call named `write_stdin`. It reads the requested process identifier, the characters to send, how long to wait for new output, and any output-size limit. It then asks the shared `unified_exec_manager` to write those characters to the running process and collect the response.

There is one important distinction: sending an empty string is treated as a background poll, not as a visible user action. A poll just asks, “has the command produced anything new yet?” Because of that, the file only sends a terminal interaction event to the user interface when real input was typed, or when the process is still alive and the UI may need to keep waiting. Finally, it wraps the execution response so the rest of the tool framework can return it to the model. It also deliberately skips the usual “before tool use” hook because this is a continuation of an earlier command, not a brand-new command.

#### Function details

##### `WriteStdinHandler::tool_name`  (lines 35–37)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public name of this tool: `write_stdin`. The tool registry uses this name to match an incoming tool call to this handler.

**Data flow**: It takes the handler itself as input, does not read any request data, and creates a plain tool name value containing `write_stdin`. The result is handed back to the tool framework.

**Call relations**: When the tool system is cataloging or dispatching tools, it asks this handler for its name. This function relies on the shared `plain` constructor to make the name in the standard format used by the rest of the registry.

*Call graph*: calls 1 internal fn (plain).


##### `WriteStdinHandler::spec`  (lines 39–41)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Provides the formal description of the `write_stdin` tool, such as what arguments it accepts. This is what tells the model and tool framework how the tool should be called.

**Data flow**: It receives no request-specific data. It calls the helper that builds the write-stdin tool specification, then returns that specification to the registry.

**Call relations**: During tool setup or advertisement, the framework asks this handler for its spec. This function delegates the actual spec-building to `create_write_stdin_tool`, keeping this handler focused on runtime behavior.

*Call graph*: calls 1 internal fn (create_write_stdin_tool).


##### `WriteStdinHandler::handle`  (lines 43–45)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts processing one incoming `write_stdin` invocation. It turns the real async work into the future shape expected by the tool framework.

**Data flow**: It receives a `ToolInvocation`, which contains the session, current turn, and raw tool payload. It passes that invocation into `handle_call`, boxes and pins the resulting asynchronous task, and returns it so the framework can await it later.

**Call relations**: The tool framework calls this when a `write_stdin` request arrives. This function is a small adapter: it hands the actual work to `WriteStdinHandler::handle_call` and uses `pin` so the async operation can be stored and driven by the generic executor.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `WriteStdinHandler::handle_call`  (lines 49–102)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Does the real work of a `write_stdin` call: validates the request, writes input to the running process, optionally reports the terminal interaction to the UI, and returns the process output.

**Data flow**: It starts with a tool invocation containing the current session, turn settings, and payload. It first checks that the payload is a function-call payload; if not, it returns an error message for the model. It parses the JSON-like arguments into `WriteStdinArgs`, then sends the process id, input characters, wait time, output limit, and truncation policy to the unified execution manager. If that manager reports an error, the error is converted into a model-facing failure. If the write or poll succeeds, the function may emit a terminal interaction event: real typed input is shown, while empty polling is shown only if there is still a live process to wait on. Finally, it wraps the execution response as standard tool output.

**Call relations**: This is called by `WriteStdinHandler::handle` whenever the framework dispatches this tool. It uses `parse_arguments` to turn raw tool arguments into typed values, calls into the session’s `unified_exec_manager` to interact with the process, builds a `TerminalInteractionEvent` when the UI should know about the interaction, and uses `boxed_tool_output` so the response fits the common tool-output interface. If the payload is unsupported or the write fails, it creates a `RespondToModel` error so the model gets a clear explanation.

*Call graph*: calls 2 internal fn (boxed_tool_output, parse_arguments); called by 1 (handle); 2 external calls (TerminalInteraction, RespondToModel).


##### `WriteStdinHandler::matches_kind`  (lines 106–108)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Answers whether this handler can accept the given kind of tool payload. For this handler, only function-call payloads are valid.

**Data flow**: It receives a payload description, checks whether it is the `Function` variant, and returns true or false. It does not change anything.

**Call relations**: The runtime can call this before dispatching a tool request. This function uses a simple pattern check so `write_stdin` is only used for normal function-style tool calls, matching what `handle_call` expects to parse.

*Call graph*: 1 external calls (matches!).


##### `WriteStdinHandler::pre_tool_use_payload`  (lines 110–115)

```
fn pre_tool_use_payload(&self, _invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Deliberately returns no “before tool use” notification for `write_stdin`. This avoids treating continued input to an existing command as if it were a brand-new shell command.

**Data flow**: It receives the invocation but does not inspect it. It always returns `None`, meaning there is no pre-tool-use payload to emit.

**Call relations**: The core runtime asks handlers whether they want to emit a pre-use hook before execution. Here the answer is always no because the original command already produced the relevant pre-use event, and empty writes may only be background polls.


##### `WriteStdinHandler::post_tool_use_payload`  (lines 117–125)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Creates an after-tool-use notification when a `write_stdin` call observes that the original command has completed. This lets the system close out the earlier command properly, even if completion is noticed during a later poll or input write.

**Data flow**: It receives the original invocation and the produced tool output. It passes both to the shared helper for unified execution post-use payloads, then returns whatever post-use payload that helper decides is appropriate.

**Call relations**: After the tool finishes, the runtime calls this hook. This function delegates to `post_unified_exec_tool_use_payload`, because the logic for matching a `write_stdin` result back to the original command is shared with the rest of the unified execution tooling.

*Call graph*: 1 external calls (post_unified_exec_tool_use_payload).


### Exec-server process backends
These files establish the exec-server process contract and then provide local and remote implementations that satisfy it.

### `exec-server/src/process.rs`

`domain_logic` · `process lifetime`

This file is the “process handle” layer of the exec server. It says what every runnable process must be able to do: tell callers its id, accept input, produce output, receive signals, terminate, and let callers follow events as they happen. Without this shared contract, each backend would need custom code for reading output or stopping a process.

A key part is `ExecProcessEvent`, which represents things that happen during a process run: bytes are printed, the process exits, output streams close, or the session fails. The file supports two ways to observe a process. One is polling retained output with `read`, like asking “what happened after this point?” The other is subscribing to pushed events, like listening to a live radio feed.

`ExecProcessEventLog` makes that live feed safer. It keeps a small replay history, so a new listener can catch up on recent events before receiving live ones. The history is bounded both by event count and by stored byte size, so huge output cannot grow memory forever. If a listener falls too far behind the live channel, the comments explain that it should recover by using `read` from the last known sequence number.

The file also defines `ExecBackend`, the trait for anything that can start a process from `ExecParams` and return a `StartedExecProcess`.

#### Function details

##### `ExecProcessEvent::seq`  (lines 67–73)

```
fn seq(&self) -> Option<u64>
```

**Purpose**: This returns the ordering number for events that came from the process itself. Callers use it to know where an event sits in the process output timeline.

**Data flow**: It receives one process event. If the event is output, exit, or close, it reads the event’s stored sequence number and returns it. If the event is a failure made by the client side rather than the process, it returns no number.

**Call relations**: When ordered process events are published, the publishing path asks this function for the event’s sequence number. That lets the caller treat real process events as ordered, while leaving transport or session failures outside that sequence.

*Call graph*: called by 1 (publish_ordered_event).


##### `ExecProcessEvent::retained_len`  (lines 75–81)

```
fn retained_len(&self) -> usize
```

**Purpose**: This estimates how much stored space an event uses in the replay history. It exists so the event log can limit memory use when retaining recent events.

**Data flow**: It receives one event. For output, it counts the number of bytes in the output chunk. For a failure message, it counts the message length. Exit and close events count as zero because they carry no output bytes. It returns that size as a number.

**Call relations**: The event log calls this whenever it publishes an event. The returned size is added to, or subtracted from, the replay buffer’s byte total so old events can be evicted when the buffer grows too large.

*Call graph*: called by 1 (publish).


##### `ExecProcessEventLog::new`  (lines 85–95)

```
fn new(event_capacity: usize, byte_capacity: usize) -> Self
```

**Purpose**: This creates a fresh event log for one process. It sets up both the remembered event history and the live broadcast path for new events.

**Data flow**: It takes two limits: the maximum number of remembered events and the maximum number of retained bytes. It creates an empty history, opens a broadcast channel for live subscribers, stores the limits, and returns a shareable event log.

**Call relations**: Process setup code calls this when a new process or test process is created. The returned log is then used by later publishing code to record events and by subscription code to give listeners replay plus live updates.

*Call graph*: called by 4 (new, start_process, spawn_test_process, event_history_replay_is_bounded_by_retained_bytes); 4 external calls (new, new, channel, default).


##### `ExecProcessEventLog::publish`  (lines 97–117)

```
fn publish(&self, event: ExecProcessEvent)
```

**Purpose**: This records a new process event and sends it to anyone currently listening. It also trims the replay history so it stays within its configured limits.

**Data flow**: It receives an event. First it locks the shared history, measures the event’s retained size, stores a copy at the back of the history, and then removes oldest events until both the event-count limit and byte limit are respected. After updating history, it sends the event through the live broadcast channel. It does not return a value.

**Call relations**: The ordered publishing path calls this after it has an event ready to announce. This function is the bridge between the durable short replay buffer and the live stream that subscribers receive immediately.

*Call graph*: calls 1 internal fn (retained_len); called by 1 (publish_ordered_event); 1 external calls (clone).


##### `ExecProcessEventLog::subscribe`  (lines 119–129)

```
fn subscribe(&self) -> ExecProcessEventReceiver
```

**Purpose**: This creates a receiver for someone who wants to follow process events. The receiver starts with recent remembered events, then continues with live events.

**Data flow**: It reads the current replay history while holding the history lock, subscribes to the live broadcast channel, copies the saved events into a private queue for the new receiver, and returns that receiver.

**Call relations**: Implementations of process subscription call this when a client asks to receive events. It hands back an `ExecProcessEventReceiver`, which later delivers the copied replay first and then waits on the live channel.

*Call graph*: called by 2 (subscribe_events, subscribe_events).


##### `ExecProcessEventReceiver::empty`  (lines 138–144)

```
fn empty() -> Self
```

**Purpose**: This creates a receiver that has no replayed events and no real event source. It is useful as a harmless placeholder when there is nothing to subscribe to.

**Data flow**: It creates a tiny broadcast channel, keeps only the receiving side, and pairs it with an empty replay queue. The returned receiver will not immediately produce any saved events.

**Call relations**: Some `subscribe_events` implementations use this when they cannot provide a real stream. It lets callers still receive the expected receiver type without special-case setup.

*Call graph*: called by 2 (subscribe_events, subscribe_events); 2 external calls (new, channel).


##### `ExecProcessEventReceiver::recv`  (lines 151–157)

```
async fn recv(&mut self) -> Result<ExecProcessEvent, broadcast::error::RecvError>
```

**Purpose**: This waits for the next event for a subscriber. It always delivers saved replay events before waiting for new live events.

**Data flow**: It first checks the receiver’s private replay queue. If an event is there, it removes and returns it. If replay is empty, it waits asynchronously on the live broadcast channel and returns the next live event or a receive error, such as falling behind the channel.

**Call relations**: The message-receiving flow calls this when it needs the next process event to send onward. This function hides the two-stage behavior, so callers do not need to know whether an event came from history or from the live stream.

*Call graph*: calls 1 internal fn (recv); called by 1 (receive_message); 1 external calls (pop_front).


##### `tests::event_history_replay_is_bounded_by_retained_bytes`  (lines 209–245)

```
async fn event_history_replay_is_bounded_by_retained_bytes()
```

**Purpose**: This test proves that the replay history respects the byte limit, not just the event-count limit. It checks that a large output event can be dropped while smaller lifecycle events remain available.

**Data flow**: The test creates an event log with room for several events but only three retained bytes. It publishes a large output chunk, then an exit event and a closed event. When it subscribes afterward, it reads the replayed events and verifies that only the exit and closed events are replayed.

**Call relations**: This test exercises `ExecProcessEventLog::new`, `publish`, `subscribe`, and receiver reads as a user would experience them. It protects the replay-buffer behavior that keeps process output from consuming unbounded memory.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert_eq!, Output, vec!).


### `exec-server/src/local_process.rs`

`orchestration` · `request handling and process lifetime`

This file solves the practical problem of turning a remote request like “run this command in this folder” into a real operating-system process. Without it, the exec server could accept requests but would have no local engine for launching programs, collecting their output, or cleaning them up afterward.

The main type, LocalProcess, owns a shared table of processes. Each process starts in a short “Starting” state, then becomes a RunningProcess with its session, recent output, exit status, event log, and wake-up tools for readers waiting on new data. Think of it like a small train station board: each train has an ID, a current state, a stream of announcements, and a cleanup time after it has finished.

When a process starts, the file builds the child environment, chooses whether to run it with a terminal-like interface or simple pipes, then spawns background tasks. Two tasks read stdout and stderr output. Another waits for the exit code. Output is numbered with sequence numbers so clients can ask, “give me everything after item 12.” Only a bounded amount of output is retained to avoid unbounded memory growth. When both output streams close and the exit code is known, the process is marked closed, a notification is sent, and the record is removed after a short retention period.

#### Function details

##### `LocalProcess::default`  (lines 107–112)

```
fn default() -> Self
```

**Purpose**: Creates a usable local process backend when no notification channel is provided. It installs a dummy notification receiver so the rest of the code can still send notifications safely.

**Data flow**: It starts with no inputs, creates an internal message channel, spawns a background task that simply drains messages from that channel, then returns a LocalProcess built with that sender.

**Call relations**: Test setup and other default construction paths call this when they need a ready backend without wiring a real client. It hands the sender to LocalProcess::new, which builds the shared process table.

*Call graph*: calls 1 internal fn (new); called by 5 (default_for_tests, local, closed_process_is_evicted_after_retention, exited_process_retains_late_output_past_retention, start_process_rejects_non_native_cwd_before_launch); 2 external calls (new, spawn).


##### `LocalProcess::new`  (lines 116–123)

```
fn new(notifications: RpcNotificationSender) -> Self
```

**Purpose**: Builds a LocalProcess around a notification sender. This is used when the server wants process events, such as output or exit, to be pushed to a client.

**Data flow**: It receives a notification sender, stores it inside a shared lock, creates an empty process map protected by an asynchronous lock, and returns the new backend.

**Call relations**: LocalProcess::default calls this with a dummy sender, while normal setup can call it with a real sender. Later functions use the stored sender through notification_sender.

*Call graph*: called by 1 (new); 4 external calls (new, new, new, new).


##### `LocalProcess::shutdown`  (lines 125–139)

```
async fn shutdown(&self)
```

**Purpose**: Stops all currently running local processes owned by this backend. This is the cleanup path for server shutdown or test teardown.

**Data flow**: It locks the process table, removes every entry, keeps only entries that are already running, then asks each process session to terminate. The process table is left empty.

**Call relations**: Higher-level shutdown code calls this when the backend is no longer needed. It does not wait for normal output handling; it directly asks remaining sessions to stop.

*Call graph*: called by 1 (shutdown).


##### `LocalProcess::set_notification_sender`  (lines 141–148)

```
fn set_notification_sender(&self, notifications: Option<RpcNotificationSender>)
```

**Purpose**: Changes where live process notifications are sent, or disables them. This is useful when the server connection changes or notifications should be muted.

**Data flow**: It receives an optional notification sender, takes the write lock around the stored sender, and replaces the old value with the new one.

**Call relations**: External backend plumbing calls this to rewire outbound notifications. Later stream and lifecycle tasks read this value through notification_sender before sending updates.

*Call graph*: called by 1 (set_notification_sender).


##### `LocalProcess::start_process`  (lines 150–274)

```
async fn start_process(
        &self,
        params: ExecParams,
    ) -> Result<(ExecResponse, watch::Sender<u64>, ExecProcessEventLog), JSONRPCErrorError>
```

**Purpose**: Starts a new operating-system process and records everything needed to interact with it later. It validates the request, launches the command, and starts background watchers for output and exit.

**Data flow**: It receives execution parameters, checks that the command and working folder are valid, reserves the requested process ID, builds the child environment, launches the process with either a terminal or pipes, stores the running record, then returns the process ID plus internal wake and event tools. If launch fails, it removes the temporary starting record and returns an error.

**Call relations**: LocalProcess::exec uses this for JSON-RPC style requests, and LocalProcess::start uses it for the ExecBackend interface. After launch it hands output channels to stream_output and the exit channel to watch_exit so the process can be monitored in the background.

*Call graph*: calls 7 internal fn (child_env, stream_output, watch_exit, new, internal_error, invalid_request, default); called by 2 (exec, start); 13 external calls (clone, new, new, new, new, spawn_pipe_process, spawn_pipe_process_no_stdin, spawn_pty_process, Running, format! (+3 more)).


##### `LocalProcess::exec`  (lines 276–280)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, JSONRPCErrorError>
```

**Purpose**: Public request-style wrapper for starting a process. It returns only the response a client needs, not the internal wake-up and event objects.

**Data flow**: It receives execution parameters, calls start_process, discards the internal helper values, and returns the ExecResponse or the launch error.

**Call relations**: The JSON-RPC exec handler path calls this. It delegates all real work to start_process.

*Call graph*: calls 1 internal fn (start_process); called by 1 (exec).


##### `LocalProcess::exec_read`  (lines 282–358)

```
async fn exec_read(
        &self,
        params: ReadParams,
    ) -> Result<ReadResponse, JSONRPCErrorError>
```

**Purpose**: Reads retained output and status for a process, optionally waiting briefly for new data. This lets clients poll without missing chunks.

**Data flow**: It receives a process ID, an optional sequence number to read after, an optional byte limit, and an optional wait time. It looks up the process, copies matching retained output chunks into a response, includes exit and closed status, and either returns immediately or waits until new output/status arrives or the deadline passes.

**Call relations**: LocalProcess::read and test helpers call this to get process output. It relies on stream_output, watch_exit, and maybe_emit_closed to add chunks, mark exits, and wake waiting readers.

*Call graph*: calls 1 internal fn (invalid_request); called by 3 (read, read_process_until_change, exec_read); 6 external calls (clone, from_millis, new, format!, now, timeout).


##### `LocalProcess::exec_write`  (lines 360–393)

```
async fn exec_write(
        &self,
        params: WriteParams,
    ) -> Result<WriteResponse, JSONRPCErrorError>
```

**Purpose**: Writes bytes to a running process’s standard input, when that process was started with an input channel. It reports clear statuses instead of treating every case as a hard error.

**Data flow**: It receives a process ID and byte chunk, looks up the process, checks whether it is running and has writable input, then sends the bytes to the process writer. It returns Accepted, Starting, UnknownProcess, or StdinClosed depending on what happened.

**Call relations**: LocalProcess::write calls this for the ExecProcess interface, and request handlers can call it directly. It uses the process session’s writer channel as the final handoff to the child process.

*Call graph*: called by 2 (write, exec_write).


##### `LocalProcess::signal_process`  (lines 395–416)

```
async fn signal_process(
        &self,
        params: SignalParams,
    ) -> Result<SignalResponse, JSONRPCErrorError>
```

**Purpose**: Sends a control signal, currently an interrupt, to a running process. This is how a client can ask a command to stop what it is doing without necessarily killing the whole backend.

**Data flow**: It receives a process ID and signal, looks up the process, ignores missing or still-starting processes, skips already-exited processes, converts the protocol signal into the lower-level process signal, and sends it through the session.

**Call relations**: LocalProcess::signal calls this for the ExecProcess interface. It uses pty_process_signal to translate from the server protocol’s signal type to the process-launching library’s signal type.

*Call graph*: calls 1 internal fn (pty_process_signal); called by 2 (signal, signal).


##### `LocalProcess::terminate_process`  (lines 418–437)

```
async fn terminate_process(
        &self,
        params: TerminateParams,
    ) -> Result<TerminateResponse, JSONRPCErrorError>
```

**Purpose**: Asks a running process to terminate. Unlike a soft interrupt, this is the backend’s direct stop request.

**Data flow**: It receives a process ID, looks up the process, and if it is running and has not exited, calls terminate on its session. It returns whether there was a live process to stop.

**Call relations**: LocalProcess::terminate calls this for the ExecProcess interface. The shutdown path uses similar session termination logic for all processes at once.

*Call graph*: called by 2 (terminate, terminate).


##### `child_env`  (lines 440–449)

```
fn child_env(params: &ExecParams) -> HashMap<String, String>
```

**Purpose**: Builds the environment variables that the child process will see. Environment variables are name-value settings like PATH that programs read from their surroundings.

**Data flow**: It receives execution parameters. If there is no environment policy, it returns the exact environment map from the request. If a policy exists, it creates a base environment from that policy and then overlays the request’s explicit variables so request values win.

**Call relations**: start_process calls this just before launching a command. It calls shell_environment_policy to convert the request’s policy shape into the shared shell-environment helper’s policy shape.

*Call graph*: calls 2 internal fn (shell_environment_policy, create_env); called by 1 (start_process).


##### `shell_environment_policy`  (lines 451–468)

```
fn shell_environment_policy(env_policy: &ExecEnvPolicy) -> ShellEnvironmentPolicy
```

**Purpose**: Converts the exec protocol’s environment policy into the format expected by the shared environment-building code. This keeps process launching and protocol data loosely connected.

**Data flow**: It receives an ExecEnvPolicy, copies over inheritance and explicit set rules, turns text patterns into case-insensitive environment-variable patterns, disables profile loading, and returns a ShellEnvironmentPolicy.

**Call relations**: child_env calls this when a request includes an environment policy. The returned policy is then passed to the shell environment helper that creates the actual variable map.

*Call graph*: called by 1 (child_env).


##### `LocalProcess::start`  (lines 488–490)

```
fn start(&self, params: ExecParams) -> ExecBackendFuture<'_>
```

**Purpose**: Starts a process through the generic ExecBackend interface. This wraps the local process implementation in the common object shape used by the rest of the server.

**Data flow**: It receives execution parameters, calls start_process, converts any protocol-style error into an ExecServerError, then returns a StartedExecProcess containing a LocalExecProcess object.

**Call relations**: The ExecBackend trait method delegates to this async helper. It creates the LocalExecProcess that later forwards reads, writes, signals, and termination back to this LocalProcess backend.

*Call graph*: calls 1 internal fn (start_process); 2 external calls (new, pin).


##### `LocalExecProcess::process_id`  (lines 519–521)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Returns the ID assigned to this process. Callers use this ID to identify the process in logs, responses, and later requests.

**Data flow**: It reads the stored process_id field and returns a reference to it without changing anything.

**Call relations**: This is part of the ExecProcess interface. Higher-level code can ask any process object for its ID without knowing that it is backed by LocalProcess.


##### `LocalExecProcess::subscribe_wake`  (lines 523–525)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Lets callers subscribe to a lightweight wake-up signal that changes when new process activity happens. This is useful for code that wants to wait efficiently instead of constantly polling.

**Data flow**: It reads the process’s watch sender and creates a new receiver subscribed to future sequence-number updates.

**Call relations**: This is part of the ExecProcess interface. stream_output, watch_exit, and maybe_emit_closed send updates on the same channel when output, exit, or close events occur.

*Call graph*: 1 external calls (subscribe).


##### `LocalExecProcess::subscribe_events`  (lines 527–529)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Lets callers subscribe to the process event log. The event log carries structured events such as output, exit, and closed.

**Data flow**: It asks the stored ExecProcessEventLog for a new receiver and returns it. The process object itself is not changed.

**Call relations**: This is part of the ExecProcess interface. stream_output, watch_exit, and maybe_emit_closed publish the events that subscribers receive.

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

**Purpose**: Reads output and status for this specific process through the local backend. It is a convenience method that already knows the process ID.

**Data flow**: It receives read options, passes this process’s ID plus those options to the backend read method, and returns the resulting ReadResponse or error.

**Call relations**: The ExecProcess trait method wraps this in a boxed future. The actual read logic lives in LocalProcess::read and then LocalProcess::exec_read.

*Call graph*: calls 1 internal fn (read); 1 external calls (pin).


##### `LocalExecProcess::write`  (lines 540–542)

```
fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Writes bytes to this specific process through the local backend. It saves callers from manually passing the process ID.

**Data flow**: It receives a byte vector, passes it with this process’s ID to the backend write method, and returns the write status or error.

**Call relations**: The ExecProcess trait method wraps this in a boxed future. The actual input delivery happens through LocalProcess::write and LocalProcess::exec_write.

*Call graph*: calls 1 internal fn (write); 1 external calls (pin).


##### `LocalExecProcess::signal`  (lines 544–546)

```
fn signal(&self, signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Sends a control signal to this specific process through the local backend. It is used for actions such as interrupting a running command.

**Data flow**: It receives a protocol signal, passes it with this process’s ID to the backend signal method, and returns success or an error.

**Call relations**: The ExecProcess trait method wraps this in a boxed future. LocalProcess::signal then calls signal_process to perform the session-level signal.

*Call graph*: calls 1 internal fn (signal); 1 external calls (pin).


##### `LocalExecProcess::terminate`  (lines 548–550)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Requests termination of this specific process through the local backend. It is the process-object version of the stop command.

**Data flow**: It uses its stored process ID, calls the backend terminate method, and returns success or an error.

**Call relations**: The ExecProcess trait method wraps this in a boxed future. LocalProcess::terminate then calls terminate_process for the real stop request.

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

**Purpose**: Adapts the backend’s read operation to the shared ExecProcess error type. It is the internal bridge between object-style process use and request-style read handling.

**Data flow**: It receives a process ID and read options, builds ReadParams, calls exec_read, and converts any JSON-RPC-style error into ExecServerError.

**Call relations**: LocalExecProcess::read calls this. It hands the work to exec_read, which performs the process lookup, output copying, and optional waiting.

*Call graph*: calls 1 internal fn (exec_read); called by 1 (read); 1 external calls (clone).


##### `LocalProcess::write`  (lines 571–582)

```
async fn write(
        &self,
        process_id: &ProcessId,
        chunk: Vec<u8>,
    ) -> Result<WriteResponse, ExecServerError>
```

**Purpose**: Adapts the backend’s write operation to the shared ExecProcess error type. It packages raw bytes into the protocol request shape.

**Data flow**: It receives a process ID and bytes, builds WriteParams, calls exec_write, and converts errors into ExecServerError.

**Call relations**: LocalExecProcess::write calls this. exec_write then checks process state and sends the bytes to the child process input channel.

*Call graph*: calls 1 internal fn (exec_write); called by 1 (write); 1 external calls (clone).


##### `LocalProcess::signal`  (lines 584–596)

```
async fn signal(
        &self,
        process_id: &ProcessId,
        signal: ProcessSignal,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adapts process signaling to the shared ExecProcess error type. It hides the protocol request wrapping from callers.

**Data flow**: It receives a process ID and signal, builds SignalParams, calls signal_process, converts any error, and returns an empty success result.

**Call relations**: LocalExecProcess::signal calls this. signal_process performs the lookup and sends the lower-level signal.

*Call graph*: calls 1 internal fn (signal_process); called by 1 (signal); 1 external calls (clone).


##### `LocalProcess::terminate`  (lines 598–605)

```
async fn terminate(&self, process_id: &ProcessId) -> Result<(), ExecServerError>
```

**Purpose**: Adapts process termination to the shared ExecProcess error type. It lets process objects stop themselves through the backend.

**Data flow**: It receives a process ID, builds TerminateParams, calls terminate_process, converts any error, and returns success.

**Call relations**: LocalExecProcess::terminate calls this. terminate_process checks whether the process is still live and asks its session to terminate.

*Call graph*: calls 1 internal fn (terminate_process); called by 1 (terminate); 1 external calls (clone).


##### `pty_process_signal`  (lines 608–612)

```
fn pty_process_signal(signal: ProcessSignal) -> PtyProcessSignal
```

**Purpose**: Translates the exec protocol’s signal name into the signal type used by the process-running library. This keeps the public protocol separate from the lower-level implementation.

**Data flow**: It receives a ProcessSignal and returns the matching PtyProcessSignal. At present, Interrupt maps to Interrupt.

**Call relations**: signal_process calls this just before sending a signal to the running session.

*Call graph*: called by 1 (signal_process).


##### `map_handler_error`  (lines 614–619)

```
fn map_handler_error(error: JSONRPCErrorError) -> ExecServerError
```

**Purpose**: Converts JSON-RPC-style errors into the server’s common execution error type. This lets different calling paths report failures in a consistent shape.

**Data flow**: It receives an error with a code and message, copies those fields into an ExecServerError::Server value, and returns it.

**Call relations**: The backend adapter methods use this when turning request-style functions into ExecBackend and ExecProcess results.


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

**Purpose**: Continuously records output from one process stream and sends live output notifications. A stream is one source of bytes, such as stdout or stderr.

**Data flow**: It receives a process ID, stream label, byte receiver, shared process state, and wake notifier. For each chunk, it assigns a sequence number, stores the chunk in the retained buffer, trims old retained data if needed, wakes readers, publishes an event, and sends a notification. When the input channel ends, it marks that stream finished.

**Call relations**: start_process starts one task for stdout and one for stderr, and tests start the same tasks for fake processes. When the stream ends, this calls finish_output_stream, which may lead to the process being marked closed.

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

**Purpose**: Waits for a process to exit and records its exit code. The exit code is the number a program returns to say whether it succeeded or failed.

**Data flow**: It receives a process ID, a one-time exit-code receiver, shared process state, and wake notifier. When the exit code arrives, it stores it, assigns a sequence number, wakes readers, publishes an exit event, and sends an exit notification. If the exit channel fails, it uses -1.

**Call relations**: start_process and test setup spawn this beside the output streaming tasks. After recording the exit, it calls maybe_emit_closed because the process may be fully done if both output streams have also ended.

*Call graph*: calls 2 internal fn (maybe_emit_closed, notification_sender); called by 2 (start_process, spawn_test_process); 2 external calls (clone, clone).


##### `finish_output_stream`  (lines 717–730)

```
async fn finish_output_stream(process_id: ProcessId, inner: Arc<Inner>)
```

**Purpose**: Records that one output stream has ended. A process is not fully closed until all output streams are done and the exit code is known.

**Data flow**: It receives a process ID and shared state, finds the running process, decreases its open-stream count if possible, then checks whether the whole process can now be closed.

**Call relations**: stream_output calls this after its receiver ends. It then hands off to maybe_emit_closed to decide whether the final closed event should be emitted.

*Call graph*: calls 1 internal fn (maybe_emit_closed); called by 1 (stream_output).


##### `maybe_emit_closed`  (lines 732–778)

```
async fn maybe_emit_closed(process_id: ProcessId, inner: Arc<Inner>)
```

**Purpose**: Marks a process as fully closed when it has exited and both output streams are finished. It also schedules removal of the closed process after a retention delay.

**Data flow**: It receives a process ID and shared state, checks the running process, and does nothing unless it is not already closed, has zero open streams, and has an exit code. If ready, it sets closed, assigns a sequence number, wakes readers, publishes a closed event, sends a closed notification, and starts a delayed cleanup task that removes the process if it is still closed.

**Call relations**: watch_exit calls this after an exit, and finish_output_stream calls it after each stream ends. This is the final gate that turns separate exit and stream-end facts into one clear “closed” state.

*Call graph*: calls 1 internal fn (notification_sender); called by 2 (finish_output_stream, watch_exit); 5 external calls (clone, clone, matches!, spawn, sleep).


##### `notification_sender`  (lines 780–786)

```
fn notification_sender(inner: &Inner) -> Option<RpcNotificationSender>
```

**Purpose**: Gets the current notification sender, if notifications are enabled. It centralizes safe access to the shared sender.

**Data flow**: It receives the shared Inner state, takes a read lock around the optional sender, clones the sender if present, and returns it.

**Call relations**: stream_output, watch_exit, and maybe_emit_closed call this before sending output, exit, and closed notifications. set_notification_sender changes the value this function later reads.

*Call graph*: called by 3 (maybe_emit_closed, stream_output, watch_exit).


##### `tests::test_exec_params`  (lines 798–809)

```
fn test_exec_params(env: HashMap<String, String>) -> ExecParams
```

**Purpose**: Builds a small, valid ExecParams value for tests. It avoids repeating setup details in each test.

**Data flow**: It receives an environment map, fills in a process ID, a simple true command, the current folder as the working directory, default terminal/input flags, and returns the parameters.

**Call relations**: The environment and working-directory tests call this, then adjust only the fields they are testing.

*Call graph*: calls 2 internal fn (from, from_path); 2 external calls (current_dir, vec!).


##### `tests::start_process_rejects_non_native_cwd_before_launch`  (lines 812–833)

```
async fn start_process_rejects_non_native_cwd_before_launch()
```

**Purpose**: Checks that a process is not launched when its working directory URI cannot be represented as a local path on this machine. This protects the local backend from trying to run commands in impossible locations.

**Data flow**: It builds parameters with a deliberately non-native file URI, computes the expected invalid-parameter error, calls start_process, and asserts that the same error is returned.

**Call relations**: This test uses LocalProcess::default and tests::test_exec_params. It specifically exercises the validation path inside start_process before any spawn attempt.

*Call graph*: calls 3 internal fn (default, invalid_params, parse); 5 external calls (new, assert_eq!, test_exec_params, format!, panic!).


##### `tests::child_env_defaults_to_exact_env`  (lines 836–843)

```
fn child_env_defaults_to_exact_env()
```

**Purpose**: Verifies that, without an environment policy, the child environment is exactly the explicit map from the request. This confirms there is no accidental inheritance.

**Data flow**: It builds parameters containing one environment variable, calls child_env, and compares the result to the same one-variable map.

**Call relations**: This test calls tests::test_exec_params and directly checks child_env’s no-policy branch.

*Call graph*: 3 external calls (from, assert_eq!, test_exec_params).


##### `tests::child_env_applies_policy_then_overlay`  (lines 846–868)

```
fn child_env_applies_policy_then_overlay()
```

**Purpose**: Verifies that environment policy values are applied first and explicit request variables override them. This matters because a caller’s direct environment settings should win.

**Data flow**: It builds parameters with a policy-set variable and explicit variables, calls child_env, adjusts the expected result for Windows default PATHEXT behavior, and asserts equality.

**Call relations**: This test calls tests::test_exec_params and exercises child_env together with shell_environment_policy and the shared environment creation helper.

*Call graph*: 5 external calls (from, new, assert_eq!, cfg!, test_exec_params).


##### `tests::exited_process_retains_late_output_past_retention`  (lines 871–919)

```
async fn exited_process_retains_late_output_past_retention()
```

**Purpose**: Checks an important edge case: a process that has exited is not removed just because the retention time has passed if its output streams are still open. Late output should still be readable.

**Data flow**: It creates a fake process, sends an exit code, reads the exit event, waits beyond the retention delay, sends output afterward, reads again to confirm that late output is present, then closes the streams and waits for final closure.

**Call relations**: This test uses spawn_test_process, read_process_until_change, read_process_until_closed, and LocalProcess::shutdown. It exercises watch_exit, stream_output, and maybe_emit_closed working together.

*Call graph*: calls 1 internal fn (default); 9 external calls (from_millis, from_secs, assert!, assert_eq!, read_process_until_change, read_process_until_closed, spawn_test_process, sleep, timeout).


##### `tests::closed_process_is_evicted_after_retention`  (lines 922–953)

```
async fn closed_process_is_evicted_after_retention()
```

**Purpose**: Checks that a fully closed process is eventually removed from the backend’s process table. This prevents finished processes from accumulating forever.

**Data flow**: It creates a fake process, exits it, closes both output streams, waits until the read response says closed, then repeatedly checks the process map until the process ID disappears.

**Call relations**: This test uses spawn_test_process and read_process_until_closed. It verifies the delayed cleanup task created by maybe_emit_closed.

*Call graph*: calls 1 internal fn (default); 7 external calls (from_millis, from_secs, assert!, read_process_until_closed, spawn_test_process, sleep, timeout).


##### `tests::TestProcess::exit`  (lines 963–969)

```
fn exit(&mut self, exit_code: i32)
```

**Purpose**: Makes a fake test process report an exit code. It gives tests a simple way to trigger the same exit path a real process would use.

**Data flow**: It takes the stored one-time exit sender, sends the provided exit code through it, and removes the sender so exit cannot be sent twice.

**Call relations**: The process-lifecycle tests call this after spawn_test_process. The watch_exit task receives the value and updates backend state.


##### `tests::spawn_test_process`  (lines 972–1032)

```
async fn spawn_test_process(backend: &LocalProcess, process_id: &str) -> TestProcess
```

**Purpose**: Creates a fake running process inside LocalProcess without launching a real operating-system command. This lets tests drive output and exit timing precisely.

**Data flow**: It receives a backend and process ID string, creates channels for stdout, stderr, and exit, inserts a RunningProcess with a dummy session into the backend map, spawns stream_output and watch_exit tasks, and returns a TestProcess with senders the test can control.

**Call relations**: The lifecycle tests call this instead of start_process. It reuses the same stream_output and watch_exit functions as real processes, so the tests cover the real bookkeeping logic.

*Call graph*: calls 4 internal fn (stream_output, watch_exit, new, from); 12 external calls (clone, new, new, new, new, assert!, Running, dummy_session, channel, channel (+2 more)).


##### `tests::dummy_session`  (lines 1034–1050)

```
fn dummy_session() -> ExecCommandSession
```

**Purpose**: Builds a minimal process session for fake test processes. It exists only so the RunningProcess record has a session value without starting a real command.

**Data flow**: It creates placeholder writer, output, and exit channels, wraps them in a ProcessDriver, passes that to the process utility library, and returns the resulting session.

**Call relations**: spawn_test_process calls this while inserting a fake RunningProcess. The returned session is not the focus of the tests; the controlled channels are.

*Call graph*: 4 external calls (spawn_from_driver, channel, channel, channel).


##### `tests::read_process_until_change`  (lines 1052–1069)

```
async fn read_process_until_change(
        backend: &LocalProcess,
        process_id: &ProcessId,
        after_seq: Option<u64>,
    ) -> ReadResponse
```

**Purpose**: Reads from a process in tests and waits for a change, with a timeout so tests do not hang forever. It is a small polling helper.

**Data flow**: It receives a backend, process ID, and optional sequence number, calls exec_read with a wait time, wraps that in a one-second timeout, and returns the successful ReadResponse.

**Call relations**: The lifecycle tests call this to observe exit and late output. It exercises the same exec_read path clients use.

*Call graph*: calls 1 internal fn (exec_read); 3 external calls (from_secs, clone, timeout).


##### `tests::read_process_until_closed`  (lines 1071–1086)

```
async fn read_process_until_closed(
        backend: &LocalProcess,
        process_id: &ProcessId,
    ) -> ReadResponse
```

**Purpose**: Keeps reading a test process until the backend reports it as closed. This hides the loop needed to consume events in order.

**Data flow**: It starts with no sequence position, repeatedly calls read_process_until_change, updates the sequence marker from returned chunks or next_seq, and returns once the response has closed set to true.

**Call relations**: The lifecycle tests call this after triggering exit and stream closure. It depends on read_process_until_change, which in turn uses exec_read.

*Call graph*: 1 external calls (read_process_until_change).


### `exec-server/src/remote_process.rs`

`io_transport` · `request handling and process lifetime`

This file is an adapter. The rest of the system wants to start and talk to an execution process through common traits, without caring whether the process is local or remote. `RemoteProcess` fills that gap by using a lazy remote client, which means the network client is only obtained when it is actually needed.

When a remote process is started, the code first gets the client, registers a session for the requested process ID, and asks the remote server to run the command. The session is like a ticket number at a service desk: every later read, write, signal, or shutdown request uses that ticket so the remote server knows which process is being discussed. If starting the process fails after the session was registered, the file immediately unregisters that session so it does not leave stale state behind.

Once started, the returned `RemoteExecProcess` exposes the standard `ExecProcess` interface. Reads ask the session for output, writes send bytes to the process input, signals forward actions such as interrupt or terminate, and subscriptions let callers be notified when new output or events are available. The important cleanup behavior is in `Drop`: when the process object is discarded, it spawns a background task to unregister the remote session.

#### Function details

##### `RemoteProcess::new`  (lines 29–32)

```
fn new(client: LazyRemoteExecServerClient) -> Self
```

**Purpose**: Creates a `RemoteProcess` wrapper around a lazy remote exec server client. Use this when the system is being set up to run commands through a remote server instead of directly on the same machine.

**Data flow**: It receives a lazy client object, records a trace log for debugging, and stores that client inside a new `RemoteProcess`. The result is a small backend object ready to start remote processes later.

**Call relations**: This is called by `remote_with_transport` while building the remote execution setup. After that setup step, the returned `RemoteProcess` is used through the execution backend interface when someone asks to start a process.

*Call graph*: called by 1 (remote_with_transport); 1 external calls (trace!).


##### `RemoteProcess::start`  (lines 53–55)

```
fn start(&self, params: ExecParams) -> ExecBackendFuture<'_>
```

**Purpose**: Starts a remote process through the backend interface and returns a standard started-process object. This is what lets the rest of the code ask for a process without knowing the process will actually run on another server.

**Data flow**: It receives execution parameters, including the process ID and command details. It prepares an asynchronous operation that gets the remote client, creates or uses a remote session, asks the server to execute the command, and finally returns a `StartedExecProcess` that wraps the remote session. If the remote start fails after session registration, the session is unregistered before the error is returned.

**Call relations**: This function is the bridge from the generic `ExecBackend` trait into the remote implementation. Callers use the backend trait; this method boxes the asynchronous start work so it fits that trait, and the resulting process object later hands reads, writes, signals, and cleanup to the session.

*Call graph*: calls 1 internal fn (get); 2 external calls (new, pin).


##### `RemoteExecProcess::process_id`  (lines 85–87)

```
fn process_id(&self) -> &crate::ProcessId
```

**Purpose**: Returns the identifier for the remote process. Callers use this when they need to label, track, or compare the running process.

**Data flow**: It reads the process ID stored in the remote session and returns a reference to it. Nothing is changed.

**Call relations**: This is part of the common `ExecProcess` interface. When outside code asks a process for its ID, this remote version simply delegates to the session, because the session is the object that knows which remote process it represents.

*Call graph*: 1 external calls (process_id).


##### `RemoteExecProcess::subscribe_wake`  (lines 89–91)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Lets callers subscribe to wake-up notifications from the remote process session. A wake-up notification is a lightweight signal that something may have changed, such as new output being available.

**Data flow**: It asks the session for a watch receiver, which is a subscription channel that can receive updated sequence information. It returns that receiver to the caller and does not otherwise change the process.

**Call relations**: This belongs to the `ExecProcess` interface. Higher-level code can call it when it wants to wait efficiently instead of repeatedly checking for output; the actual notification source is supplied by the session.

*Call graph*: 1 external calls (subscribe_wake).


##### `RemoteExecProcess::subscribe_events`  (lines 93–95)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Lets callers listen for process events, such as lifecycle or status changes reported by the remote session. This gives the rest of the system a standard way to observe what happens to the remote process.

**Data flow**: It asks the session for an event receiver and returns it. The process object itself is not modified.

**Call relations**: This is another standard `ExecProcess` operation. Code that monitors process state calls this method, and the method passes through to the session because the session receives the actual remote event stream.

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

**Purpose**: Reads output from the remote process. Callers use it to fetch bytes produced by the process, with options for where to start reading, how much to read, and how long to wait.

**Data flow**: It receives an optional sequence number to read after, an optional maximum byte count, and an optional wait time in milliseconds. It wraps an asynchronous session read operation, sends those limits to the session, and eventually produces a `ReadResponse` or an error.

**Call relations**: This is the `ExecProcess` read method for remote processes. Higher-level process consumers call it through the common interface, and it hands the actual work to the session, which communicates with the remote server.

*Call graph*: 2 external calls (pin, read).


##### `RemoteExecProcess::write`  (lines 106–108)

```
fn write(&self, chunk: Vec<u8>) -> ExecProcessFuture<'_, WriteResponse>
```

**Purpose**: Sends input bytes to the remote process. This is how callers type into or feed data to a remote command.

**Data flow**: It receives a byte chunk, records a trace log for debugging, wraps an asynchronous session write operation, and passes the bytes to the remote session. The result is a `WriteResponse` confirming what the remote side accepted, or an error.

**Call relations**: This is called through the common `ExecProcess` interface when someone writes to the process input. The method does not send data itself; it delegates to the session, which is responsible for reaching the remote server.

*Call graph*: 3 external calls (pin, write, trace!).


##### `RemoteExecProcess::signal`  (lines 110–112)

```
fn signal(&self, signal: ProcessSignal) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Sends a control signal to the remote process, such as a request to interrupt or stop it. This lets local callers control a process that is actually running elsewhere.

**Data flow**: It receives a `ProcessSignal`, records a trace log, wraps an asynchronous session signal operation, and forwards the signal to the remote session. It returns success if the remote side accepts the signal, or an error if not.

**Call relations**: This is the remote implementation of the standard process signal operation. Callers use the `ExecProcess` trait, and this method passes the request to the session so the remote server can apply it to the correct process.

*Call graph*: 3 external calls (pin, signal, trace!).


##### `RemoteExecProcess::terminate`  (lines 114–116)

```
fn terminate(&self) -> ExecProcessFuture<'_, ()>
```

**Purpose**: Requests that the remote process be terminated. This is the direct shutdown path for a still-running remote process.

**Data flow**: It records a trace log, wraps an asynchronous session termination operation, and asks the session to terminate the remote process. The result is either success or an execution server error.

**Call relations**: This is called through the `ExecProcess` interface when higher-level code wants to stop the process. The method forwards the request to the session, which knows how to tell the remote server which process to terminate.

*Call graph*: 3 external calls (pin, terminate, trace!).


##### `RemoteExecProcess::drop`  (lines 120–125)

```
fn drop(&mut self)
```

**Purpose**: Cleans up the remote session when the local process object is discarded. This helps prevent the remote server from keeping an unused session around after the client is done with it.

**Data flow**: When the `RemoteExecProcess` is being destroyed, it clones the session handle and starts a background asynchronous task. That task unregisters the session on the remote side. The drop operation itself does not wait for the cleanup to finish.

**Call relations**: This runs automatically when the last owner of the remote process object goes away. It is the safety net after normal process use: reads, writes, signals, and termination happen while the object is alive, and unregistering is kicked off when the object leaves scope.

*Call graph*: 2 external calls (clone, spawn).


### Shared spawning and backend selection
These files expose the common OS process spawn boundary and the top-level unified-exec backend families available to the system.

### `core/src/spawn.rs`

`io_transport` · `shell tool execution / child process startup`

When Codex runs an outside command, it cannot simply start it with the machine’s default settings. The command may need to run in a specific folder, with a carefully chosen set of environment variables, and sometimes with network access limited or routed through a proxy. This file gathers those choices into one request and turns them into a real child process.

The main data bundle is `SpawnChildRequest`, which says what program to run, what arguments to pass, where to run it, what environment variables to use, whether network sandboxing applies, and how standard input/output should behave. `StdioPolicy` chooses between two modes: one for shell-tool calls where Codex captures output and prevents the command from waiting for keyboard input, and one where the child simply shares the parent process’s terminal streams.

There are also two environment variable names used to tell the child process it is running under Codex sandbox rules. One marks that network access is disabled. Another is reserved for identifying the sandbox system more generally.

On Unix systems, the file adds extra safety: shell-tool children can be detached from the terminal, and on Linux they can be told to die if the parent Codex process dies. This helps avoid abandoned background processes, like making sure a hired helper leaves when the supervisor leaves.

#### Function details

##### `spawn_child_async`  (lines 51–126)

```
async fn spawn_child_async(request: SpawnChildRequest<'_>) -> std::io::Result<Child>
```

**Purpose**: Starts a child process using the exact program, arguments, folder, environment, network rules, and input/output policy requested by Codex. It is used when Codex needs to run an external command while preserving sandbox and cleanup rules.

**Data flow**: It receives a `SpawnChildRequest` containing the program path, command-line arguments, optional display name for argument zero, working directory, network sandbox policy, optional network proxy, standard input/output policy, and environment variables. It builds a Tokio `Command`, clears any default environment, applies the supplied environment and optional network proxy changes, adds a marker if network access is disabled, configures Unix process behavior where supported, chooses whether to capture or inherit input/output streams, and then spawns the process. The result is either a running child process object or an operating-system error explaining why it could not be started.

**Call relations**: Higher-level execution paths call this when they are ready to actually launch a command: ordinary command execution uses it through `exec`, and Linux sandboxed execution uses it through `spawn_command_under_linux_sandbox`. Inside, it hands off low-level work to the operating-system process builder, standard-stream helpers, tracing, and Unix/Linux process setup calls so the caller does not have to repeat those details.

*Call graph*: called by 2 (exec, spawn_command_under_linux_sandbox); 7 external calls (inherit, null, piped, new, getpid, matches!, trace!).


### `windows-sandbox-rs/src/unified_exec/backends/mod.rs`

`orchestration` · `compile-time module wiring`

This file does not contain executable logic itself. Instead, it acts like a small table of contents for the backend part of the unified execution feature. A backend is a concrete way to run something: for example, running with elevated permissions, using an older legacy path, or using shared Windows-specific helper code. By declaring the `elevated`, `legacy`, and `windows_common` modules here, this file makes those pieces visible to the surrounding crate while keeping their code split into separate files. Without this file, other parts of the unified execution system would not have a single, organized place to reach these backend implementations. It is like the signboard at the entrance to a workshop: it does not build anything itself, but it points to the rooms where the actual work happens.


### Portable PTY and pipe interfaces
These files present the public PTY crate surface and its cross-platform process-group, pipe, and PTY-backed session implementations.

### `utils/pty/src/lib.rs`

`other` · `cross-cutting public API`

This file does not contain the process-running logic itself. Instead, it gathers the important pieces from the crate’s internal modules and presents them as one clean public interface. Think of it like the reception desk in a workshop: the actual tools are stored in different rooms, but visitors come here to find the right one.

The crate supports two main ways to run a child process. One uses regular pipes for standard input, output, and error, which is useful for non-interactive commands. The other uses a PTY, short for “pseudo-terminal,” which makes the child process believe it is connected to a real terminal. That matters for interactive programs, colored output, terminal resizing, and command-line tools that behave differently when attached to a terminal.

The file also re-exports shared process types, such as handles for controlling a spawned process, signals that can be sent to it, terminal size information, and helpers for combining output streams. It defines a default output buffer cap of one megabyte, which gives the rest of the crate a common safety limit for collected output. On Windows, it conditionally exposes ConPTY-related types, which are Windows’ built-in pseudo-terminal support.


### `utils/pty/src/process_group.rs`

`util` · `process spawn and cleanup`

When this project starts an external command, that command may start more commands of its own. If the project later stops only the first process, its children can keep running in the background. This file prevents that by using process groups: an operating-system feature that treats related processes like a single family. Then the project can send one signal to the whole family.

On Unix-like systems, the helpers here can put a new child process into its own process group, detach it from the parent terminal, and send signals such as SIGTERM, SIGINT, or SIGKILL. In plain terms: SIGTERM asks a process to stop, SIGINT is like pressing Ctrl-C, and SIGKILL forces it to stop immediately. On Linux, there is also a safety feature that tells the child to receive SIGTERM if its parent process dies, reducing the chance of orphaned work.

The file is careful about races and already-exited processes. If a process group is gone, the cleanup functions usually treat that as success, because there is nothing left to kill. On non-Unix platforms, these functions are harmless no-ops, so the rest of the code can call them without needing separate platform-specific branches.

#### Function details

##### `set_parent_death_signal`  (lines 43–45)

```
fn set_parent_death_signal(_parent_pid: i32) -> io::Result<()>
```

**Purpose**: On Linux, this asks the operating system to send SIGTERM to the child if the original parent process dies. This is a cleanup safety net, so a launched command is less likely to be left running after the launcher disappears.

**Data flow**: It receives the parent process ID captured before spawning the child. It tells the OS to set a parent-death signal, then checks the current parent ID again; if the parent has already changed, it raises SIGTERM in the child immediately. It returns success if the setup worked, or an I/O error if the OS call failed. On non-Linux systems, it simply returns success without changing anything.

**Call relations**: This is meant to be run during child setup before the new program fully starts. It talks directly to operating-system calls such as prctl, getppid, and raise; no other listed function in this file calls it.

*Call graph*: 4 external calls (last_os_error, getppid, prctl, raise).


##### `detach_from_tty`  (lines 63–65)

```
fn detach_from_tty() -> io::Result<()>
```

**Purpose**: This detaches a child process from the controlling terminal by starting a new session. That matters for non-interactive commands, so they do not accidentally inherit terminal behavior from the parent.

**Data flow**: It takes no input. On Unix, it asks the OS to start a new session; if that fails because the process is already in a position where a new session is not allowed, it falls back to putting the process in its own process group. It returns success or an I/O error. On non-Unix systems, it does nothing and returns success.

**Call relations**: This is used during child-process setup. If the direct session-detach step fails with the expected permission-style case, it calls set_process_group as a fallback so the child is still separated from the parent’s group.

*Call graph*: calls 1 internal fn (set_process_group); 2 external calls (last_os_error, setsid).


##### `set_process_group`  (lines 82–84)

```
fn set_process_group() -> io::Result<()>
```

**Purpose**: This puts the current process into its own process group. The goal is to make a spawned command the leader of a group that can later be signaled or killed as one unit.

**Data flow**: It takes no input. On Unix, it calls the OS to set the process group ID of the current process to itself. It returns success if the OS accepts the change, or an I/O error if not. On non-Unix systems, it does nothing and returns success.

**Call relations**: This is intended for child setup before the child program starts running. detach_from_tty calls it as a fallback when starting a new session is not allowed.

*Call graph*: called by 1 (detach_from_tty); 2 external calls (last_os_error, setpgid).


##### `kill_process_group_by_pid`  (lines 116–118)

```
fn kill_process_group_by_pid(_pid: u32) -> io::Result<()>
```

**Purpose**: This force-kills the process group that contains a given process ID. It is useful when the code knows the child process ID but not the process group ID.

**Data flow**: It receives a process ID as a number. On Unix, it asks the OS which process group that process belongs to, then sends SIGKILL to the whole group. If the process or group is already gone, it treats that as okay; otherwise, real OS errors are returned. On non-Unix systems, it does nothing and returns success.

**Call relations**: kill_child_process_group uses this when it has a Tokio child process and can read its process ID. Internally, this function talks directly to the OS through getpgid and killpg.

*Call graph*: called by 1 (kill_child_process_group); 3 external calls (last_os_error, getpgid, killpg).


##### `signal_process_group_id`  (lines 121–134)

```
fn signal_process_group_id(pgid: libc::pid_t, signal: libc::c_int) -> io::Result<bool>
```

**Purpose**: This is the shared Unix helper for sending a chosen signal to a known process group ID. It avoids repeating the same error handling in the terminate, interrupt, and kill functions.

**Data flow**: It receives a process group ID and a signal number. It sends that signal to the whole group. If the group exists, it returns true; if the group is already gone, it returns false; if another OS error happens, it returns that error.

**Call relations**: This is the private worker used by terminate_process_group, interrupt_process_group, and kill_process_group. Those public functions choose the signal, while this helper performs the common send-and-check behavior.

*Call graph*: called by 3 (interrupt_process_group, kill_process_group, terminate_process_group); 2 external calls (last_os_error, killpg).


##### `terminate_process_group`  (lines 147–149)

```
fn terminate_process_group(_process_group_id: u32) -> io::Result<bool>
```

**Purpose**: This asks a specific process group to stop by sending SIGTERM. SIGTERM is the polite shutdown signal: it gives programs a chance to clean up before exiting.

**Data flow**: It receives a process group ID. On Unix, it passes that ID and the SIGTERM signal to signal_process_group_id, then returns whether the group was found and signaled. On non-Unix systems, it returns false because no signal was sent.

**Call relations**: Higher-level cleanup flows such as terminate_process_tree and terminate call this when they want a graceful stop for a whole process group. It delegates the actual OS signaling and missing-group handling to signal_process_group_id.

*Call graph*: calls 1 internal fn (signal_process_group_id); called by 2 (terminate_process_tree, terminate).


##### `interrupt_process_group`  (lines 159–161)

```
fn interrupt_process_group(_process_group_id: u32) -> io::Result<()>
```

**Purpose**: This sends SIGINT to a specific process group, which is similar to a user pressing Ctrl-C in a terminal. It is used when the project wants to interrupt a running command rather than immediately force-kill it.

**Data flow**: It receives a process group ID. On Unix, it sends SIGINT through signal_process_group_id and ignores the true-or-false detail about whether the group still existed, returning only success or error. On non-Unix systems, it does nothing and returns success.

**Call relations**: Several signal-related callers use this when they need to pass an interrupt through to a child command group. It relies on signal_process_group_id for the actual group signal behavior.

*Call graph*: calls 1 internal fn (signal_process_group_id); called by 3 (signal, signal, signal).


##### `kill_process_group`  (lines 171–173)

```
fn kill_process_group(_process_group_id: u32) -> io::Result<()>
```

**Purpose**: This force-kills a specific process group with SIGKILL. It is the hard-stop option for when a command and its descendants must be ended immediately.

**Data flow**: It receives a process group ID. On Unix, it sends SIGKILL through signal_process_group_id and returns success unless the OS reports a real error. If the group is already gone, that is treated as fine. On non-Unix systems, it does nothing and returns success.

**Call relations**: This is used by stronger cleanup paths such as drop, kill_process_tree, and kill when polite shutdown is not enough or when resources are being torn down. It hands the actual signal delivery to signal_process_group_id.

*Call graph*: calls 1 internal fn (signal_process_group_id); called by 5 (drop, kill_process_tree, kill, kill, kill).


##### `kill_child_process_group`  (lines 187–189)

```
fn kill_child_process_group(_child: &mut Child) -> io::Result<()>
```

**Purpose**: This force-kills the process group belonging to a Tokio child process. It is a convenience wrapper for code that has a child handle rather than a raw process ID.

**Data flow**: It receives a mutable child-process handle. It asks the handle for its process ID; if there is one, it calls kill_process_group_by_pid to kill the whole group. If there is no ID, it returns success because there is no known process to target. On non-Unix systems, it does nothing and returns success.

**Call relations**: Callers use this during cleanup of an async child process. It bridges from Tokio’s child handle to the lower-level process-group cleanup function, kill_process_group_by_pid.

*Call graph*: calls 1 internal fn (kill_process_group_by_pid); 1 external calls (id).


### `utils/pty/src/pipe.rs`

`io_transport` · `process spawn and child process lifetime`

Some programs need to be run in the background while this project feeds them input and watches their output. This file does that using regular pipes: one pipe for stdin, one for stdout, and one for stderr. A pipe is like a one-way tube between this program and the child program.

The main worker is `spawn_process_with_stdin_mode`. It builds a command, sets its working folder and environment, chooses whether stdin should be writable or closed, and starts the child. It then creates small background tasks: one task writes bytes sent by the rest of the project into the child’s stdin, and other tasks continuously read stdout and stderr and forward those bytes through channels. A channel is an in-program queue used to pass messages safely between asynchronous tasks.

The file also creates a `ProcessHandle`, which is the project’s control panel for the child process. It can send input, track whether the process has exited, store the exit code, and terminate the child. On Unix-like systems it stops the whole process group, not just the first process, so child programs that spawn their own children do not get left behind. On Windows it uses the operating system API to terminate the process directly.

#### Function details

##### `PipeChildTerminator::signal`  (lines 37–51)

```
fn signal(&mut self, signal: ProcessSignal) -> io::Result<()>
```

**Purpose**: Sends a softer control signal to the child process when supported. In practice this is used for an interrupt request, like pressing Ctrl-C in a terminal.

**Data flow**: It receives a requested `ProcessSignal`. If the signal is `Interrupt` and the platform is Unix-like, it passes the interrupt to the child’s process group. On non-Unix platforms it reports that this signal is not supported. The result is either success or an operating-system error.

**Call relations**: This method is used through the `ChildTerminator` interface stored inside the `ProcessHandle`. When higher-level code asks the handle to interrupt the process, this method either hands the request to `interrupt_process_group` on Unix or to `unsupported_signal` elsewhere.

*Call graph*: calls 2 internal fn (unsupported_signal, interrupt_process_group).


##### `PipeChildTerminator::kill`  (lines 53–68)

```
fn kill(&mut self) -> io::Result<()>
```

**Purpose**: Forcefully stops the child process. On Unix-like systems it kills the whole process group so related subprocesses are stopped too; on Windows it kills the process by its process ID.

**Data flow**: It reads the stored process identity: a process group ID on Unix-like systems, or a process ID on Windows. It sends a forceful termination request to the operating system. It returns success if the request was made successfully, or an I/O error if the operating system refused or failed it.

**Call relations**: This method is also used through the `ChildTerminator` inside `ProcessHandle`. When the rest of the system decides a spawned process must be stopped, this method delegates to `kill_process_group` on Unix-like systems or to `kill_process` on Windows.

*Call graph*: calls 2 internal fn (kill_process, kill_process_group).


##### `kill_process`  (lines 72–87)

```
fn kill_process(pid: u32) -> io::Result<()>
```

**Purpose**: Windows-only helper that forcefully terminates one process by its process ID. It exists because Windows process termination uses a different system API than Unix-like systems.

**Data flow**: It takes a Windows process ID. It asks Windows for a handle with permission to terminate that process, calls the Windows termination function, closes the handle afterward, and returns either success or the last operating-system error.

**Call relations**: It is called by `PipeChildTerminator::kill` on Windows. That keeps the public termination behavior the same for callers while hiding the Windows-specific steps in this small helper.

*Call graph*: called by 1 (kill); 4 external calls (last_os_error, CloseHandle, OpenProcess, TerminateProcess).


##### `read_output_stream`  (lines 89–104)

```
async fn read_output_stream(mut reader: R, output_tx: mpsc::Sender<Vec<u8>>)
```

**Purpose**: Continuously reads bytes from one output stream, such as stdout or stderr, and forwards each chunk to a channel. This lets other parts of the program receive child output as it arrives.

**Data flow**: It receives an asynchronous reader and a sending side of a channel. It repeatedly reads up to 8 KB at a time. Each successful chunk is copied into a fresh byte vector and sent through the channel. If the stream reaches end-of-file, it stops. If a read is interrupted temporarily, it tries again; for other read errors, it stops.

**Call relations**: `spawn_process_with_stdin_mode` starts background tasks that call this helper for stdout and stderr. Those tasks turn raw pipe reads into channel messages that the returned `SpawnedProcess` exposes to the caller.

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

**Purpose**: Starts a child program using regular pipes and builds all the machinery needed to talk to it, read its output, wait for it, and stop it. This is the central implementation used by the simpler public spawn functions.

**Data flow**: It receives the program name, arguments, working directory, environment variables, optional custom argv0 name, a choice of whether stdin is piped or closed, and a list of Unix file descriptors to preserve. It validates that a program was provided, configures a Tokio command, sets up platform-specific process behavior, starts the child, takes its stdin/stdout/stderr pipes, and creates channels plus background tasks for writing input, reading output, and waiting for exit. It returns a `SpawnedProcess` containing the control handle, output receivers, and exit notification receiver.

**Call relations**: `spawn_process` calls it when stdin should stay open. `spawn_process_no_stdin_with_inherited_fds` calls it when stdin should be closed and selected Unix file descriptors should be preserved. Internally it calls `exit_code_from_status` after the child finishes so callers get a simple numeric exit code instead of a raw operating-system status.

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

**Purpose**: Public convenience function for starting a child process with writable stdin. Use this when the caller may need to send input to the program after it starts.

**Data flow**: It receives the program setup: executable name, arguments, working directory, environment, and optional argv0. It adds the choice that stdin should be piped, passes everything to `spawn_process_with_stdin_mode`, and returns the resulting `SpawnedProcess`.

**Call relations**: This is the simple entry point for pipe-based spawning when input is needed. It delegates all real setup work to `spawn_process_with_stdin_mode` so the complicated pipe and task setup lives in one place.

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

**Purpose**: Public convenience function for starting a child process with stdin closed immediately. Use this when the child should not wait for input from this program.

**Data flow**: It receives the same basic process setup as `spawn_process`. It supplies an empty list of inherited file descriptors and passes the request to `spawn_process_no_stdin_with_inherited_fds`. The returned value is still a `SpawnedProcess`, but its stdin is connected to null rather than to a writable pipe.

**Call relations**: This wrapper is for the common no-stdin case. It hands off to `spawn_process_no_stdin_with_inherited_fds`, which then uses the shared spawning implementation.

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

**Purpose**: Starts a child process with stdin closed, while optionally preserving selected Unix file descriptors. This is useful when a child needs access to specific already-open resources but should not receive normal stdin.

**Data flow**: It receives the program setup plus a list of file descriptor numbers to keep open across the Unix `exec` step, which is the moment the child process becomes the requested program. It asks `spawn_process_with_stdin_mode` to use null stdin and to preserve those descriptors. It returns the completed `SpawnedProcess` setup.

**Call relations**: It is called by `spawn_process_no_stdin` for the simple closed-stdin case, by higher-level session-opening code such as `open_session_with_exec_env`, and by tests that check inherited file descriptors. It delegates the actual command building, pipe setup, and waiting logic to `spawn_process_with_stdin_mode`.

*Call graph*: calls 1 internal fn (spawn_process_with_stdin_mode); called by 3 (open_session_with_exec_env, spawn_process_no_stdin, pipe_spawn_no_stdin_can_preserve_inherited_fds).


### `utils/pty/src/pty.rs`

`io_transport` · `session startup and process runtime`

Many command-line programs change their behavior depending on whether they are connected to a real terminal. Shells, Python REPLs, text editors, and prompts often need a PTY, which is like a software version of a terminal window. This file is the bridge between the rest of the project and that terminal-like environment.

The main job here is to launch a child process, connect it to a PTY, and turn the low-level terminal pipes into easier async channels. Bytes sent by the rest of the program go into a writer channel and are written to the PTY. Bytes produced by the child are read from the PTY and sent out through a stdout channel. A separate waiting task watches for the child to exit and reports its exit code.

On normal paths, the file uses the portable-pty library so the same idea works across operating systems. On Unix, there is a special path for preserving selected file descriptors, which are numbered operating-system handles for open files, sockets, or pipes. That special path manually opens the PTY and carefully prepares the child process before it starts.

The file also pays attention to cleanup. For interactive programs, killing only the top process can leave child processes behind. On Unix it therefore targets the whole process group, which is like dismissing an entire tour group instead of only the guide.

#### Function details

##### `conpty_supported`  (lines 49–51)

```
fn conpty_supported() -> bool
```

**Purpose**: This answers whether Windows has ConPTY, Microsoft's modern pseudo-terminal support. On non-Windows systems it simply says yes, because this project uses the native PTY support available there.

**Data flow**: It takes no input. On Windows it asks the Windows-specific support code whether ConPTY is available; elsewhere it returns true. The output is a simple true-or-false value used before trying to create terminal sessions.

**Call relations**: When other code needs to know if PTY sessions can work on the current machine, it calls this function. On Windows, the question is handed off to the platform-specific ConPTY checker.

*Call graph*: 1 external calls (conpty_supported).


##### `PtyChildTerminator::signal`  (lines 60–71)

```
fn signal(&mut self, signal: ProcessSignal) -> std::io::Result<()>
```

**Purpose**: This sends a gentle control signal, currently an interrupt, to a process that was started through the portable PTY path. An interrupt is the programmatic version of pressing Ctrl-C in a terminal.

**Data flow**: It receives a requested process signal. If the signal is Interrupt and this Unix process has a known process group, it sends the interrupt to that whole group. If it cannot do that, it returns an error saying the signal is not supported.

**Call relations**: The process handle calls this when higher-level code wants to interrupt a PTY-backed child. On Unix it delegates to the process-group helper so shells and their child commands receive the interrupt together.

*Call graph*: calls 2 internal fn (unsupported_signal, interrupt_process_group).


##### `PtyChildTerminator::kill`  (lines 73–90)

```
fn kill(&mut self) -> std::io::Result<()>
```

**Purpose**: This forcefully stops a process started through the portable PTY path. On Unix, it tries to stop the whole process group so background children from shells or REPLs do not survive.

**Data flow**: It reads the stored child-killer object and, on Unix, the stored process group id if one exists. With a group id, it asks the operating system to kill the group and also tries the direct child killer. Without a group id, it only uses the direct child killer. It returns success or an operating-system error.

**Call relations**: The process handle uses this during shutdown or forced termination. It hands the hard-kill work to the process-group helper where possible, while still using portable-pty's own child killer as a fallback.

*Call graph*: calls 1 internal fn (kill_process_group).


##### `RawPidTerminator::signal`  (lines 100–106)

```
fn signal(&mut self, signal: ProcessSignal) -> std::io::Result<()>
```

**Purpose**: This sends an interrupt to a Unix process that was started through the manual PTY path. It targets the whole process group rather than only the first child process.

**Data flow**: It receives a signal request and uses the stored process group id. For an Interrupt request, it sends the interrupt to that group and returns the result from the operating system.

**Call relations**: The manually spawned Unix PTY process uses this terminator inside its process handle. When higher-level code asks for Ctrl-C behavior, this function passes that request to the process-group interrupt helper.

*Call graph*: calls 1 internal fn (interrupt_process_group).


##### `RawPidTerminator::kill`  (lines 108–110)

```
fn kill(&mut self) -> std::io::Result<()>
```

**Purpose**: This forcefully kills a Unix process group created by the manual PTY spawning path. It exists so cleanup reaches child processes launched by an interactive shell or REPL.

**Data flow**: It reads the stored process group id, asks the operating system to kill that group, and returns success or the error that came back.

**Call relations**: The process handle calls this when the manual Unix PTY session must be torn down. It delegates the actual kill operation to the shared process-group helper.

*Call graph*: calls 1 internal fn (kill_process_group).


##### `platform_native_pty_system`  (lines 113–123)

```
fn platform_native_pty_system() -> Box<dyn portable_pty::PtySystem + Send>
```

**Purpose**: This chooses the PTY implementation for the current operating system. Windows gets the project’s ConPTY wrapper, while other systems use the native portable-pty backend.

**Data flow**: It takes no input. It checks the compile-time operating system target and creates a boxed PTY system object for that platform. The result is returned to the spawning code as the thing that can open a new pseudo-terminal.

**Call relations**: The portable spawn path calls this before opening a PTY. It hides the platform choice so the rest of the spawning code can proceed in the same shape on Windows, macOS, Linux, and similar systems.

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

**Purpose**: This is the simple public way to start a program inside a PTY. It is used when no extra inherited file descriptors need to be kept open for the child.

**Data flow**: It receives the program name, arguments, working directory, environment variables, optional display name for argv[0], and terminal size. It forwards all of that to the fuller spawning function with an empty list of inherited file descriptors. It returns a spawned-process bundle with input, output, exit, and control handles.

**Call relations**: Callers use this when they just want an interactive terminal process. It immediately hands the real work to spawn_process_with_inherited_fds so there is one central decision point for all PTY launches.

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

**Purpose**: This is the main entry for starting a PTY process, with an optional Unix-only feature for preserving selected open file descriptors across program startup. It also rejects empty program names early, before any terminal setup begins.

**Data flow**: It receives the command setup, terminal size, and a list of file descriptors to preserve. If the program name is empty, it returns an error. On Unix, if preserved descriptors are requested, it chooses the manual Unix spawning path. Otherwise, it chooses the portable PTY spawning path. The output is either a ready-to-use SpawnedProcess or an error.

**Call relations**: Higher-level session code and tests call this when launching PTY-backed commands. It acts like a fork in the road: ordinary launches go to spawn_process_portable, while Unix launches that must keep selected descriptors open go to spawn_process_preserving_fds.

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

**Purpose**: This starts a process in a PTY using the cross-platform portable-pty library. It turns the raw terminal connection into async-friendly channels and a process handle for the rest of the system.

**Data flow**: It receives the command details and terminal size. It opens a PTY, builds the child command with the requested directory, arguments, and environment, then starts the child on the PTY slave side. It creates background tasks: one reads terminal output into a stdout channel, one writes incoming input bytes to the terminal, and one waits for the child to exit. It returns a SpawnedProcess containing these channels and control handles.

**Call relations**: spawn_process_with_inherited_fds calls this for the normal path. It first asks platform_native_pty_system for the right PTY backend, then packages the reader, writer, waiter, terminator, and PTY handles into a ProcessHandle for higher-level code to use.

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

**Purpose**: This is the Unix-specific spawning path used when the child must inherit selected file descriptors. It manually builds the PTY setup so it can control exactly which descriptors stay open when the new program starts.

**Data flow**: It receives the command setup, terminal size, and the descriptor numbers to preserve. It opens a Unix PTY, wires the slave side to the child’s stdin, stdout, and stderr, resets signal behavior before exec, creates a new terminal session, keeps only the requested extra descriptors open, and starts the child. Then it creates the same kind of reader, writer, exit-waiter, terminator, and process bundle as the portable path.

**Call relations**: spawn_process_with_inherited_fds calls this only on Unix when descriptor preservation is requested. It relies on open_unix_pty to create the terminal and uses close_inherited_fds_except inside the child setup step so only intended file descriptors survive into the executed program.

*Call graph*: calls 1 internal fn (open_unix_pty); called by 1 (spawn_process_with_inherited_fds); 13 external calls (clone, new, new, new, to_vec, new, new, from, new, new (+3 more)).


##### `open_unix_pty`  (lines 435–463)

```
fn open_unix_pty(size: TerminalSize) -> Result<(File, File)>
```

**Purpose**: This opens a Unix pseudo-terminal pair: a master side controlled by this program and a slave side seen by the child as its terminal. It also applies the requested terminal size.

**Data flow**: It receives a TerminalSize with rows and columns. It calls the operating system’s openpty function to create master and slave file descriptors, marks both as close-on-exec, and wraps them as File objects so Rust will close them safely later. It returns the pair or an error if the operating system could not create the PTY.

**Call relations**: The manual Unix spawning path calls this before launching the child. It hands back the two ends needed for spawn_process_preserving_fds to connect the child to a terminal and keep the parent side for reading and writing.

*Call graph*: calls 1 internal fn (set_cloexec); called by 1 (spawn_process_preserving_fds); 5 external calls (from_raw_fd, bail!, openpty, addr_of_mut!, null_mut).


##### `set_cloexec`  (lines 466–476)

```
fn set_cloexec(fd: RawFd) -> std::io::Result<()>
```

**Purpose**: This marks a Unix file descriptor as close-on-exec, meaning it will automatically close when a new program is executed unless deliberately preserved. This helps prevent accidental leaking of open files or pipes into child processes.

**Data flow**: It receives a file descriptor number. It reads the descriptor’s current flags, adds the close-on-exec flag, writes the flags back, and returns success or the operating-system error that occurred.

**Call relations**: open_unix_pty calls this for both ends of a newly opened PTY. That makes the PTY safer by default before the later spawning code intentionally chooses which handles the child should receive.

*Call graph*: called by 1 (open_unix_pty); 2 external calls (last_os_error, fcntl).


##### `close_inherited_fds_except`  (lines 479–507)

```
fn close_inherited_fds_except(preserved_fds: &[RawFd])
```

**Purpose**: This closes unwanted Unix file descriptors in the child setup step, while leaving standard input/output/error and explicitly preserved descriptors alone. It is a cleanup sweep that prevents the new program from inheriting unrelated open resources.

**Data flow**: It receives a list of descriptor numbers that should be preserved. It scans /dev/fd, which lists open descriptors for the process, skips descriptors 0, 1, and 2, skips preserved ones, and also skips descriptors already marked close-on-exec. It closes the remaining descriptors and returns nothing.

**Call relations**: The manual Unix spawn path uses this inside the pre-exec setup just before the child becomes the requested program. It supports spawn_process_preserving_fds by enforcing the promise that only selected extra descriptors remain open.

*Call graph*: 5 external calls (contains, new, close, fcntl, read_dir).


### Windows ConPTY implementation
These files provide the Windows-specific pseudoconsole, child-process wrapper, and ConPTY system integration used by the PTY layer.

### `utils/pty/src/win/mod.rs`

`io_transport` · `while a Windows PTY child process is running`

A pseudo-terminal, or PTY, is a way for a program to pretend it is talking to a real terminal window. This file provides the Windows side of that support. Most of the project can use the general `portable_pty` interfaces, while this file hides the awkward Windows details such as process handles, exit codes, and waiting for a process to finish.

The main type is `WinChild`, which represents a running child process. It keeps the Windows process handle inside a mutex, which is a lock that stops two pieces of code from using the same handle in an unsafe way at the same time. Through standard traits, `WinChild` can be asked: “Are you done yet?”, “Wait until you finish,” “What is your process ID?”, or “Please stop now.”

There is also `WinChildKiller`, a smaller object whose only job is to kill the same process from somewhere else. This is useful when one part of the program owns the child process, but another part needs a safe emergency stop button.

One important detail is the kill path. Windows reports success from `TerminateProcess` with a nonzero value and failure with `0`. This file intentionally fixes a bug from the copied upstream code where that meaning was reversed.

#### Function details

##### `WinChild::is_complete`  (lines 61–74)

```
fn is_complete(&mut self) -> IoResult<Option<ExitStatus>>
```

**Purpose**: Checks whether the Windows child process has finished. If it has ended, it turns the Windows exit code into the project’s portable exit-status type; if it is still running, it says so without blocking.

**Data flow**: It reads the stored process handle, asks Windows for that process’s exit code, and looks at the answer. A special Windows value means “still active,” so the function returns no status yet; any real exit code is wrapped as an `ExitStatus` and returned.

**Call relations**: This is the quick status checker used by both `WinChild::try_wait` and the asynchronous `WinChild::poll`. Those callers rely on it to avoid blocking when they only want to know whether the process is already done.

*Call graph*: called by 2 (poll, try_wait); 1 external calls (with_exit_code).


##### `WinChild::do_kill`  (lines 76–85)

```
fn do_kill(&mut self) -> IoResult<()>
```

**Purpose**: Actually asks Windows to terminate the child process. This is the low-level kill operation used by `WinChild::kill`.

**Data flow**: It clones the stored process handle, passes that handle to Windows with an exit code of `1`, and checks Windows’s success flag. If Windows returns `0`, it converts the operating-system error into an I/O error; otherwise it reports success.

**Call relations**: This function sits underneath `WinChild::kill`. It contains the important Windows-specific rule that `TerminateProcess` returns nonzero on success, so the higher-level kill call does not need to know that detail.

*Call graph*: called by 1 (kill); 1 external calls (last_os_error).


##### `WinChild::kill`  (lines 89–92)

```
fn kill(&mut self) -> IoResult<()>
```

**Purpose**: Provides the standard child-process kill operation for `WinChild`. It tries to stop the process, but deliberately returns success even if the lower-level kill reports an error.

**Data flow**: It receives a mutable `WinChild`, calls `WinChild::do_kill`, discards that result, and then returns `Ok(())`. The process may be terminated as a side effect if Windows accepts the request.

**Call relations**: This is the method the broader `portable_pty` child-killing interface calls when the owner of a `WinChild` wants it stopped. It delegates the real operating-system work to `WinChild::do_kill`.

*Call graph*: calls 1 internal fn (do_kill).


##### `WinChild::clone_killer`  (lines 94–97)

```
fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>
```

**Purpose**: Creates a separate kill handle for the same running process. This lets another part of the program stop the child without taking ownership of the full `WinChild` object.

**Data flow**: It locks and clones the underlying Windows process handle, wraps that cloned handle in a new `WinChildKiller`, and returns it as a boxed child-killer object.

**Call relations**: This supports the `ChildKiller` interface. When outside code needs a standalone stop button, this method hands back a `WinChildKiller` that can later call its own `kill` method.

*Call graph*: 1 external calls (new).


##### `WinChildKiller::kill`  (lines 106–114)

```
fn kill(&mut self) -> IoResult<()>
```

**Purpose**: Stops the process referred to by a standalone `WinChildKiller`. It is useful when code has only been given permission to kill the child, not to wait on it or inspect it fully.

**Data flow**: It takes the stored Windows process handle, passes it to Windows’s terminate function with exit code `1`, and checks the result. A `0` result becomes the latest operating-system error; any nonzero result means the kill request succeeded.

**Call relations**: This is called through the generic `ChildKiller` interface after `WinChild::clone_killer` or `WinChildKiller::clone_killer` has produced a killer object. It performs the same Windows termination action as `WinChild::do_kill`, but from the smaller killer-only type.

*Call graph*: 2 external calls (last_os_error, as_raw_handle).


##### `WinChildKiller::clone_killer`  (lines 116–119)

```
fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>
```

**Purpose**: Makes another standalone killer for the same process. This allows multiple parts of the program to each hold their own safe way to request termination.

**Data flow**: It clones the stored Windows process handle, puts the clone into a new `WinChildKiller`, and returns it as a boxed child-killer object.

**Call relations**: This keeps the `ChildKiller` interface cloneable in practice. If code already has a `WinChildKiller` and needs to pass a copy elsewhere, this method creates that copy without involving the original `WinChild`.

*Call graph*: 2 external calls (new, try_clone).


##### `WinChild::try_wait`  (lines 123–125)

```
fn try_wait(&mut self) -> IoResult<Option<ExitStatus>>
```

**Purpose**: Checks whether the child process has finished, without waiting around. It is the non-blocking way to ask for the process’s exit status.

**Data flow**: It takes the current `WinChild`, calls `WinChild::is_complete`, and returns either an exit status, no status yet, or an I/O error from the status check.

**Call relations**: This is part of the standard `Child` interface. `WinChild::wait` calls it first so that, if the process is already finished, it can return immediately instead of asking Windows to block.

*Call graph*: calls 1 internal fn (is_complete); called by 1 (wait).


##### `WinChild::wait`  (lines 127–142)

```
fn wait(&mut self) -> IoResult<ExitStatus>
```

**Purpose**: Waits until the child process has exited and then returns its exit status. This is the blocking version of checking a child process.

**Data flow**: It first asks `WinChild::try_wait` whether the process is already done. If not, it clones the process handle and tells Windows to wait forever until that process exits. After the wait completes, it asks Windows for the final exit code and returns it as an `ExitStatus`, or returns the last operating-system error if that lookup fails.

**Call relations**: This is the standard synchronous wait operation for `WinChild`. It uses `try_wait` for the fast path, then hands off to Windows’s `WaitForSingleObject` when it must pause until the process is finished.

*Call graph*: calls 1 internal fn (try_wait); 3 external calls (with_exit_code, last_os_error, WaitForSingleObject).


##### `WinChild::process_id`  (lines 144–147)

```
fn process_id(&self) -> Option<u32>
```

**Purpose**: Returns the Windows process ID for the child, if Windows can provide one. A process ID is the number the operating system uses to identify a running process.

**Data flow**: It reads the stored process handle, asks Windows for the corresponding process ID, and returns `None` if Windows gives back `0`. Otherwise it returns the ID as a normal unsigned number.

**Call relations**: This is exposed through the standard `Child` interface for callers that need to display, log, or otherwise refer to the operating-system process.


##### `WinChild::as_raw_handle`  (lines 149–152)

```
fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle>
```

**Purpose**: Gives access to the underlying Windows process handle. This is for code that must call Windows-specific APIs directly.

**Data flow**: It locks the stored process handle and returns the raw handle value inside an option. It does not create a new process or change the child; it simply exposes the existing handle.

**Call relations**: This is part of the `Child` interface’s escape hatch for platform-specific work. Callers that understand Windows handles can use this value when the portable interface is not enough.


##### `WinChild::poll`  (lines 158–174)

```
fn poll(mut self: Pin<&mut Self>, cx: &mut Context) -> Poll<anyhow::Result<ExitStatus>>
```

**Purpose**: Lets `WinChild` be used as an asynchronous future, meaning other work can continue while the program waits for the child process to exit. It reports ready when the process has finished.

**Data flow**: It first calls `WinChild::is_complete`. If an exit status is available, it returns it immediately; if an error occurs, it returns that error with extra context. If the process is still running, it clones the process handle, copies the task’s waker, starts a helper thread that waits for the process to exit, and returns `Pending`; when the helper thread sees the process finish, it wakes the async task so it can be checked again.

**Call relations**: This connects Windows process waiting to Rust’s async system. It uses `is_complete` for the quick check, then relies on a spawned waiting thread and the async waker to resume the larger workflow when the child process exits.

*Call graph*: calls 1 internal fn (is_complete); 3 external calls (waker, Ready, spawn).


### `utils/pty/src/win/psuedocon.rs`

`io_transport` · `terminal session creation, command launch, resize, and teardown`

A pseudoterminal lets a program talk to a shell or command-line tool as if it were a real terminal window, even when no visible console exists. On Windows, that feature is called ConPTY, and it is only available on newer Windows 10 builds and later. This file hides the low-level Windows details behind a small Rust type called `PsuedoCon`.

The file first checks whether the running Windows version is new enough. It then loads the needed Windows functions from system libraries at runtime. That matters because older Windows versions may not have those functions at all; loading them only when needed avoids assuming too much about the machine.

`PsuedoCon` owns the Windows pseudoconsole handle and the input/output pipe handles that the console borrows. Think of it like renting a room and keeping the keys alive until everyone has left: the pipes must stay open for as long as the pseudoconsole exists. The type can create the console, resize it, expose its raw Windows handle for other setup code, and spawn a command inside it.

Starting a command is the most careful part. Windows process creation expects command lines, environment variables, and working directories in a particular UTF-16 format, so helper functions build those pieces correctly. The file also quotes arguments in the special way Windows requires, so spaces and quotation marks do not accidentally change what program receives.

#### Function details

##### `load_conpty`  (lines 87–97)

```
fn load_conpty() -> ConPtyFuncs
```

**Purpose**: Loads the Windows functions needed to create and control a pseudoconsole. It prefers a separate `conpty.dll` if present, but falls back to `kernel32.dll`, where these functions normally live on supported Windows versions.

**Data flow**: It starts with the names of Windows libraries on disk. It opens `kernel32.dll` and, if available, `conpty.dll`; the result is a table of callable Windows ConPTY functions. If the required system support is missing, it stops with an error message explaining that a newer Windows version is needed.

**Call relations**: This is used when the global ConPTY function table is first created. Later functions such as `PsuedoCon::new`, `PsuedoCon::resize`, and `PsuedoCon::drop` use that loaded table to call Windows.

*Call graph*: 2 external calls (open, new).


##### `conpty_supported`  (lines 103–105)

```
fn conpty_supported() -> bool
```

**Purpose**: Answers the simple question: is this Windows system new enough to support ConPTY?

**Data flow**: It asks `windows_build_number` for the operating system build number. If a number is found and it is at least the minimum known ConPTY build, it returns `true`; otherwise it returns `false`.

**Call relations**: Higher-level setup code can call this before trying to create a pseudoconsole. It relies on `windows_build_number` to get the actual Windows version information.

*Call graph*: calls 1 internal fn (windows_build_number).


##### `windows_build_number`  (lines 107–117)

```
fn windows_build_number() -> Option<u32>
```

**Purpose**: Reads the Windows build number directly from the operating system. This is used to decide whether ConPTY should be available.

**Data flow**: It opens `ntdll.dll`, prepares an empty Windows version-information structure, and asks Windows to fill it in. If Windows reports success, it returns the build number; if anything fails, it returns no value.

**Call relations**: `conpty_supported` calls this during feature detection. The test `tests::windows_build_number_returns_value` also calls it to make sure the version lookup works on Windows test machines.

*Call graph*: called by 2 (conpty_supported, windows_build_number_returns_value); 3 external calls (open, new, zeroed).


##### `PsuedoCon::drop`  (lines 131–133)

```
fn drop(&mut self)
```

**Purpose**: Closes the Windows pseudoconsole when the Rust `PsuedoCon` object is no longer used. This prevents the underlying Windows resource from leaking.

**Data flow**: It receives the existing `PsuedoCon` during cleanup, takes its stored Windows console handle, and passes it to Windows' close function. Nothing is returned; the important change is that the operating system resource is released.

**Call relations**: Rust calls this automatically when a `PsuedoCon` value is dropped. It is the final cleanup step after creation, command execution, and any resizing are finished.


##### `PsuedoCon::raw_handle`  (lines 137–139)

```
fn raw_handle(&self) -> HPCON
```

**Purpose**: Returns the underlying Windows pseudoconsole handle. Other Windows setup code needs this handle when attaching a child process to the pseudoconsole.

**Data flow**: It reads the stored handle from the `PsuedoCon` object and returns it unchanged. It does not create, close, or modify anything.

**Call relations**: The wider Windows PTY code calls this through `pseudoconsole_handle` when it needs to pass the pseudoconsole into lower-level Windows process setup.

*Call graph*: called by 1 (pseudoconsole_handle).


##### `PsuedoCon::new`  (lines 141–161)

```
fn new(size: COORD, input: FileDescriptor, output: FileDescriptor) -> Result<Self, Error>
```

**Purpose**: Creates a new Windows pseudoconsole with a requested size and connected input/output pipes. This is the point where the fake terminal room is actually opened.

**Data flow**: It receives a terminal size plus two file descriptors, one for input and one for output. It passes their raw Windows handles to `CreatePseudoConsole`, checks that Windows returned success, and then stores the console handle together with the pipe objects so they stay alive. On success it returns a new `PsuedoCon`; on failure it returns an error.

**Call relations**: Higher-level PTY creation code calls this from `create_conpty_handles`. Once created, the returned `PsuedoCon` can be used by `spawn_command` to start a program, by `resize` to change its dimensions, and by `drop` to close it later.

*Call graph*: called by 1 (create_conpty_handles); 2 external calls (ensure!, as_raw_handle).


##### `PsuedoCon::resize`  (lines 163–173)

```
fn resize(&self, size: COORD) -> Result<(), Error>
```

**Purpose**: Changes the size of the pseudoconsole, such as when a terminal window is resized. This lets programs inside the terminal know the new row and column count.

**Data flow**: It receives a new width-and-height value, sends that size to Windows for the stored pseudoconsole handle, and checks whether Windows accepted it. It returns success if the resize worked, or an error that includes the requested size if it did not.

**Call relations**: The surrounding PTY layer calls this from its resize path. It hands the resize request directly to Windows through the ConPTY function table.

*Call graph*: called by 1 (resize); 1 external calls (ensure!).


##### `PsuedoCon::spawn_command`  (lines 175–227)

```
fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<WinChild>
```

**Purpose**: Starts a child process inside this pseudoconsole. In everyday terms, this is what launches `cmd.exe`, PowerShell, or another terminal program so it talks through the PTY pipes.

**Data flow**: It takes a `CommandBuilder`, which describes the program, arguments, environment variables, and working directory. It prepares Windows startup information, attaches the pseudoconsole handle, builds the executable path and command line, builds the environment block, resolves the working directory, and calls Windows `CreateProcessW`. If process creation succeeds, it wraps the process handle in a `WinChild`; if it fails, it reports the Windows error with the attempted command and directory.

**Call relations**: This is the main launch step after a `PsuedoCon` has been created. It calls `build_cmdline`, `build_environment_block`, and `resolve_current_directory` to translate friendly command settings into the exact shapes Windows expects, then hands everything to `CreateProcessW`.

*Call graph*: calls 4 internal fn (with_capacity, build_cmdline, build_environment_block, resolve_current_directory); 10 external calls (new, from_wide, last_os_error, bail!, format!, error!, zeroed, null, null_mut, from_raw_handle).


##### `resolve_current_directory`  (lines 230–251)

```
fn resolve_current_directory(cmd: &CommandBuilder) -> Option<Vec<u16>>
```

**Purpose**: Chooses and formats the working directory for the child process. It prefers the command's explicit current directory, falls back to `USERPROFILE`, and ignores paths that are not real directories.

**Data flow**: It reads the command's requested current directory and `USERPROFILE` environment value. It picks the first usable directory, turns relative paths into paths based on the current process directory when possible, encodes the result as Windows UTF-16 text, and adds the required final zero marker. It returns that encoded directory or no value if there is nothing valid to use.

**Call relations**: `PsuedoCon::spawn_command` calls this just before creating the process. Its output becomes the working-directory argument passed to Windows.

*Call graph*: called by 1 (spawn_command); 5 external calls (get_cwd, get_env, new, new, current_dir).


##### `build_environment_block`  (lines 253–263)

```
fn build_environment_block(cmd: &CommandBuilder) -> Vec<u16>
```

**Purpose**: Builds the environment-variable block that Windows expects when starting a process. This block is how variables like `PATH` and `USERPROFILE` are passed to the child.

**Data flow**: It reads all environment key-value pairs from the `CommandBuilder`. For each pair, it writes `key=value` as UTF-16 text followed by a zero marker, then adds one extra zero marker at the end to show the whole list is finished. The result is a vector of UTF-16 numbers ready for Windows.

**Call relations**: `PsuedoCon::spawn_command` calls this while preparing `CreateProcessW`. The produced block is passed directly into Windows process creation.

*Call graph*: called by 1 (spawn_command); 3 external calls (iter_full_env_as_str, new, new).


##### `build_cmdline`  (lines 265–294)

```
fn build_cmdline(cmd: &CommandBuilder) -> anyhow::Result<(Vec<u16>, Vec<u16>)>
```

**Purpose**: Creates both the executable path and the full Windows command line for the child process. This is necessary because Windows process creation uses a single command-line string, not a clean list of arguments.

**Data flow**: It receives a `CommandBuilder`. If the command uses the default program, it chooses `ComSpec` or `cmd.exe`; otherwise it takes the first argument as the program name and searches `PATH` for it. It then quotes the executable and each later argument safely, encodes the executable and command line as UTF-16, adds final zero markers, and returns both pieces. If no program name exists, it returns an error.

**Call relations**: `PsuedoCon::spawn_command` calls this before `CreateProcessW`. It delegates program lookup to `search_path` and safe argument quoting to `append_quoted`.

*Call graph*: calls 2 internal fn (append_quoted, search_path); called by 1 (spawn_command); 7 external calls (get_argv, get_env, is_default_prog, new, new, bail!, ensure!).


##### `search_path`  (lines 296–318)

```
fn search_path(cmd: &CommandBuilder, exe: &OsStr) -> OsString
```

**Purpose**: Finds the actual executable file for a command name using Windows-style `PATH` and `PATHEXT` rules. This lets a command like `python` resolve to something like `python.exe` in a directory from `PATH`.

**Data flow**: It receives the command settings and a program name. If `PATH` is set, it checks each directory for the exact name, then checks the same name with extensions from `PATHEXT` such as `.EXE`. If it finds an existing file, it returns that full path; otherwise it returns the original name unchanged.

**Call relations**: `build_cmdline` calls this when the command is not the default shell. Its result becomes the executable path used in the command line and passed to Windows.

*Call graph*: called by 1 (build_cmdline); 4 external calls (get_env, new, to_os_string, split_paths).


##### `append_quoted`  (lines 320–363)

```
fn append_quoted(arg: &OsStr, cmdline: &mut Vec<u16>)
```

**Purpose**: Adds one command-line argument to a Windows command string with the right quoting rules. This protects spaces, quotes, and backslashes from being misunderstood by the child program.

**Data flow**: It receives one argument and the command-line buffer being built. If the argument has no characters that require quoting, it appends it directly. Otherwise it surrounds the argument with quotes and carefully doubles or escapes backslashes before quotes and at the end, following Windows command-line parsing rules. It changes the buffer in place and returns nothing.

**Call relations**: `build_cmdline` calls this for the executable name and each argument. Its output is part of the final command-line string passed by `PsuedoCon::spawn_command` to `CreateProcessW`.

*Call graph*: called by 1 (build_cmdline); 3 external calls (encode_wide, is_empty, len).


##### `tests::windows_build_number_returns_value`  (lines 371–376)

```
fn windows_build_number_returns_value()
```

**Purpose**: Checks that the Windows build-number lookup works on the test machine. It does not try to pin an exact Windows version, only that the value exists and is new enough for ConPTY.

**Data flow**: It calls `windows_build_number`, unwraps the returned value, and asserts that it is greater than the minimum ConPTY build. If the lookup fails or the build is too old, the test fails.

**Call relations**: This test exercises `windows_build_number` directly. It helps catch problems with the low-level version-reading code that `conpty_supported` depends on.

*Call graph*: calls 1 internal fn (windows_build_number); 1 external calls (assert!).


### `utils/pty/src/win/conpty.rs`

`io_transport` · `Windows PTY creation, command launch, terminal I/O, and resize handling`

A terminal program needs two-way conversation with the process it runs: it sends keystrokes in, and it reads screen output back. On Windows, that conversation goes through ConPTY, a “pseudo terminal” API provided by the operating system. This file wraps that Windows-specific machinery so the rest of the project can use the common portable_pty interface instead of talking to Windows handles directly.

The main helper, create_conpty_handles, builds two pipes. One pipe carries input toward the console program, and the other carries output back. It then creates a PsuedoCon object, which represents the Windows pseudo console, using the terminal size requested by the caller.

ConPtySystem is the normal entry point for code that wants a full terminal pair. It returns a master side and a slave side, like two ends of a phone line. The master side is used by the terminal UI to read output, write input, resize the terminal, and ask for the current size. The slave side is used to start the child command inside that pseudo console.

The shared Inner struct keeps the actual Windows console, pipe handles, and current size behind a mutex, which is a lock that stops two tasks changing the same state at once. RawConPty is a lower-level escape hatch for callers that need the raw Windows pseudo-console handle and separate ownership of the underlying handles.

#### Function details

##### `create_conpty_handles`  (lines 42–58)

```
fn create_conpty_handles(
    size: PtySize,
) -> anyhow::Result<(PsuedoCon, FileDescriptor, FileDescriptor)>
```

**Purpose**: Creates the basic Windows pseudo-terminal plumbing: the Windows pseudo console plus one writable input handle and one readable output handle. Callers use it when they need a fresh ConPTY connection at a given terminal size.

**Data flow**: It receives a PtySize with row and column counts. It creates two operating-system pipes, gives the read end of the input pipe and the write end of the output pipe to the Windows pseudo console, and keeps the opposite ends for the project to use. It returns the new PsuedoCon, a handle for writing input into it, and a handle for reading output from it.

**Call relations**: This is the shared setup step used by ConPtySystem::openpty for the normal portable_pty path and by RawConPty::new for lower-level callers. It relies on pipe creation and pseudo-console creation underneath, then hands the finished pieces back to whichever path requested them.

*Call graph*: calls 1 internal fn (new); called by 2 (openpty, new); 1 external calls (new).


##### `RawConPty::new`  (lines 67–79)

```
fn new(cols: i16, rows: i16) -> anyhow::Result<Self>
```

**Purpose**: Builds a low-level RawConPty object for callers that need direct access to Windows ConPTY pieces instead of the higher-level master/slave interface. This is useful when another part of the Windows process-launch code wants to attach a process using the raw pseudo-console handle.

**Data flow**: It receives column and row counts as signed numbers. It converts them into a PtySize, asks create_conpty_handles to make the console and pipes, and stores those pieces in a RawConPty. The result is a ready-to-use object containing the pseudo console, input writer, and output reader.

**Call relations**: Outside this file, create_conpty and spawn_conpty_process_as_user call this when they need a raw Windows ConPTY setup. Internally, it delegates all actual pipe and pseudo-console creation to create_conpty_handles.

*Call graph*: calls 1 internal fn (create_conpty_handles); called by 2 (create_conpty, spawn_conpty_process_as_user).


##### `RawConPty::pseudoconsole_handle`  (lines 81–83)

```
fn pseudoconsole_handle(&self) -> RawHandle
```

**Purpose**: Returns the raw Windows handle for the pseudo console. This lets lower-level Windows process-startup code attach a child process to the ConPTY object.

**Data flow**: It reads the PsuedoCon stored inside the RawConPty and asks it for its raw operating-system handle. It returns that handle without changing the RawConPty.

**Call relations**: This is used after RawConPty::new has created the console and before or during Windows-specific process setup. It simply exposes the handle held by PsuedoCon so another layer can pass it to Windows APIs.

*Call graph*: calls 1 internal fn (raw_handle).


##### `RawConPty::into_handles`  (lines 85–94)

```
fn into_handles(self) -> (PsuedoCon, FileDescriptor, FileDescriptor)
```

**Purpose**: Takes a RawConPty apart and gives ownership of its three internal pieces to the caller. This is for code that wants to keep using the pseudo console and pipe handles separately.

**Data flow**: It receives the RawConPty by value, meaning the caller gives it up. It carefully prevents Rust from automatically closing or dropping the internal handles, reads the PsuedoCon, input writer, and output reader out of the object, and returns them as separate values. After this, the RawConPty wrapper itself is no longer used.

**Call relations**: This fits the lower-level RawConPty path. After RawConPty::new builds the bundled object, a caller can use this function when it needs to hand the individual handles to other Windows setup code.

*Call graph*: 2 external calls (new, read).


##### `ConPtySystem::openpty`  (lines 98–118)

```
fn openpty(&self, size: PtySize) -> anyhow::Result<PtyPair>
```

**Purpose**: Creates a complete portable_pty terminal pair backed by Windows ConPTY. This is the main high-level way the rest of the project asks Windows for a new pseudo terminal.

**Data flow**: It receives the requested terminal size. It creates the Windows pseudo console and its pipes, stores them with the current size inside shared locked state, then builds a master side and a slave side that both point to that same state. It returns a PtyPair containing those two boxed interface objects.

**Call relations**: Code using the portable_pty abstraction calls this to open a new terminal. It calls create_conpty_handles for the Windows-specific setup, then wraps the result as ConPtyMasterPty and ConPtySlavePty so later code can read, write, resize, and spawn a command through standard trait methods.

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

**Purpose**: Changes the size of the underlying Windows pseudo console and remembers the new size locally. This keeps the operating system and the project’s stored terminal size in sync.

**Data flow**: It receives the new row count, column count, and pixel dimensions. It sends the row and column size to the Windows pseudo console, then updates the stored PtySize with both character-cell and pixel values. It returns success or an error if Windows rejects the resize.

**Call relations**: ConPtyMasterPty::resize uses this when the terminal window changes size. The function hands the actual resize request to PsuedoCon, then updates the shared Inner state so ConPtyMasterPty::get_size can report the latest size later.

*Call graph*: calls 1 internal fn (resize).


##### `ConPtyMasterPty::resize`  (lines 160–163)

```
fn resize(&self, size: PtySize) -> anyhow::Result<()>
```

**Purpose**: Lets the master side resize the pseudo terminal. A terminal UI would call this when the user changes the window size.

**Data flow**: It receives a PtySize. It locks the shared Inner state so no other thread can change it at the same time, then asks Inner::resize to apply the new size to Windows and store it. It returns either success or the resize error.

**Call relations**: This is part of the MasterPty interface used by higher-level terminal code. It sits above Inner::resize: callers talk to the master object, and the master object forwards the resize to the shared Windows-backed state.


##### `ConPtyMasterPty::get_size`  (lines 165–168)

```
fn get_size(&self) -> Result<PtySize, Error>
```

**Purpose**: Reports the current size that this pseudo terminal believes it has. This is used when code needs to know the terminal’s rows, columns, and pixel dimensions.

**Data flow**: It locks the shared Inner state, reads the stored PtySize, and returns that size. It does not talk to Windows or change anything.

**Call relations**: This is another MasterPty interface method. It complements ConPtyMasterPty::resize: resize updates the stored size, and get_size later reads it back for higher-level code.


##### `ConPtyMasterPty::try_clone_reader`  (lines 170–172)

```
fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>>
```

**Purpose**: Provides a reader for the output coming back from the pseudo terminal. The reader is how the project receives text and control sequences printed by the child process.

**Data flow**: It locks the shared Inner state, clones the readable output handle, wraps that clone as a standard Read object, and returns it. The original readable handle remains stored in Inner.

**Call relations**: Higher-level code calls this through the MasterPty interface when it wants to start reading terminal output. It works on the output pipe that create_conpty_handles originally connected to the Windows pseudo console.

*Call graph*: 1 external calls (new).


##### `ConPtyMasterPty::take_writer`  (lines 174–183)

```
fn take_writer(&self) -> anyhow::Result<Box<dyn std::io::Write + Send>>
```

**Purpose**: Gives the caller the one writer used to send input into the pseudo terminal. It can only be taken once, which prevents two independent writers from accidentally competing to feed the same terminal input stream.

**Data flow**: It locks the shared Inner state and removes the stored writable input handle from its Option. If the writer is still present, it wraps it as a standard Write object and returns it. If someone already took it, it returns an error saying the writer was already taken.

**Call relations**: Higher-level code calls this through the MasterPty interface when it is ready to send keyboard input or other bytes into the child process. The single-use behavior protects the input pipe created by create_conpty_handles from being handed out repeatedly.

*Call graph*: 1 external calls (new).


##### `ConPtySlavePty::spawn_command`  (lines 187–191)

```
fn spawn_command(&self, cmd: CommandBuilder) -> anyhow::Result<Box<dyn Child + Send + Sync>>
```

**Purpose**: Starts a command inside the Windows pseudo console. This is the step that actually connects a child program, such as a shell, to the terminal-like environment.

**Data flow**: It receives a CommandBuilder describing what program to run and with what settings. It locks the shared Inner state, asks the PsuedoCon to spawn that command attached to the pseudo console, wraps the resulting child process object, and returns it.

**Call relations**: This is the key SlavePty interface method. After ConPtySystem::openpty creates the master and slave pair, higher-level code uses the slave side to launch the command, while the master side is used to read output, write input, and resize the terminal.

*Call graph*: 1 external calls (new).
