# Execution-facing app-server and core command orchestration  `stage-14.2.1`

This stage is the system’s “run a command” control center. It sits in the main work path: when a user, tool, or UI asks to start a shell command, send more input, resize a terminal view, or stop a running process, this is the layer that turns that request into a real program execution.

On the app-server side, the request processors are the front desk. command_exec_processor.rs and process_exec_processor.rs accept JSON-RPC requests, which are structured messages sent over the app connection. They translate those messages into running processes and route follow-up actions like stdin input, resize, and terminate. command_exec.rs keeps long-lived command/exec sessions alive, tracks them per connection, streams output back, and finishes with a final result. The TUI files provide client helpers: fs.rs smooths over local versus remote server calls, and workspace_command.rs gives the text UI a simple way to run short workspace commands.

In core, exec.rs is the safe process runner. sandboxing/mod.rs shapes approved execution requests. user_shell.rs powers the /shell task. The shell and unified_exec handlers and runtimes decide how to launch commands, apply approval and sandbox rules, support patch interception, pick backends like zsh-fork on Unix, and finally hand everything to the process launcher.

## Files in this stage

### App-server execution entrypoints
These files expose app-server-facing command and process execution APIs and manage long-lived execution sessions for client connections.

### `app-server/src/request_processors/command_exec_processor.rs`

`domain_logic` · `request handling`

This file defines `CommandExecRequestProcessor`, a request-facing wrapper around `CommandExecManager` plus configuration, environment, and path dependencies needed to launch subprocesses safely. The simple methods (`command_exec_write`, `command_exec_resize`, `command_exec_terminate`, `connection_closed`) forward protocol requests to the manager and convert manager responses into `ClientResponsePayload` values.

The main logic lives in `exec_one_off_command_inner`. It validates protocol invariants early: command must be non-empty; `permissionProfile` and `sandboxPolicy` are mutually exclusive; terminal `size` requires `tty`; output-cap and timeout flags cannot be combined with explicit numeric overrides; and `timeoutMs` must convert to a non-negative `u64`. It then resolves the working directory relative to `self.config.cwd`, builds an environment map with `create_env`, and applies per-request env overrides where `Some(value)` inserts and `None` removes keys.

Permission handling is nuanced. If a `permission_profile` is supplied, it reloads config through `ConfigManager::load_for_cwd` with overrides and rejects disallowed profiles by inspecting startup warnings. If only legacy `sandbox_policy` is supplied, it converts that policy into filesystem/network sandbox policies and then into a runtime `PermissionProfile`, validating both legacy and modern forms. Otherwise it uses the current config’s effective permissions. Optional managed network proxy startup happens before exec request construction and failures become internal errors.

Finally, it computes capture policy, timeout expiration, Windows sandbox settings, optional terminal size, and calls `codex_core::exec::build_exec_request`. The resulting request plus streaming flags, output cap, process id, and proxy handle are handed to `CommandExecManager::start`, which owns the actual process lifecycle. A separate `require_local_environment` gate ensures one-off execution only runs when a local environment is configured.

#### Function details

##### `CommandExecRequestProcessor::new`  (lines 14–29)

```
fn new(
        arg0_paths: Arg0DispatchPaths,
        config: Arc<Config>,
        outgoing: Arc<OutgoingMessageSender>,
        config_manager: ConfigManager,
        environment_manager: Arc<Enviro
```

**Purpose**: Constructs a processor with the shared config, outgoing sender, config/environment managers, and a fresh default `CommandExecManager`.

**Data flow**: Takes `Arg0DispatchPaths`, `Arc<Config>`, `Arc<OutgoingMessageSender>`, `ConfigManager`, and `Arc<EnvironmentManager>`; stores them directly into the struct and initializes `command_exec_manager` with its default value; returns a fully configured `CommandExecRequestProcessor`.

**Call relations**: Called by higher-level request-processor setup during server construction. It does not perform I/O itself; it prepares the dependencies later used by request entrypoints and delegates runtime process tracking to the internally created manager.

*Call graph*: calls 1 internal fn (default); called by 1 (new).


##### `CommandExecRequestProcessor::one_off_command_exec`  (lines 31–40)

```
async fn one_off_command_exec(
        &self,
        request_id: &ConnectionRequestId,
        params: CommandExecParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Accepts a one-shot command execution request, verifies that local execution is available, and launches the command without returning an immediate payload body.

**Data flow**: Reads `self.environment_manager` through `require_local_environment`; on success passes the borrowed `request_id` and `CommandExecParams` into `exec_one_off_command`; converts a successful `()` result into `Ok(None)` so the response is delivered asynchronously through execution events rather than inline payload data.

**Call relations**: Invoked from `handle_initialized_client_request` for the command/exec RPC. It first gates execution on local-environment availability, then hands off all substantive validation and launch work to `exec_one_off_command`.

*Call graph*: calls 2 internal fn (exec_one_off_command, require_local_environment); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::command_exec_write`  (lines 42–51)

```
async fn command_exec_write(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecWriteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Forwards stdin or input-write requests for an existing command execution session to the execution manager.

**Data flow**: Consumes a `ConnectionRequestId` and `CommandExecWriteParams`, awaits `self.command_exec_manager.write`, and wraps the manager’s response into `Some(ClientResponsePayload)` via `into()`.

**Call relations**: Called by `handle_initialized_client_request` when the client sends a write request for a running exec session. It is a thin adapter over the manager’s write path.

*Call graph*: calls 1 internal fn (write); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::command_exec_resize`  (lines 53–62)

```
async fn command_exec_resize(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecResizeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Applies a terminal resize request to an existing TTY-backed command execution.

**Data flow**: Consumes a `ConnectionRequestId` and `CommandExecResizeParams`, awaits `self.command_exec_manager.resize`, and converts the returned manager response into `Some(ClientResponsePayload)`.

**Call relations**: Reached from `handle_initialized_client_request` for resize RPCs. It delegates all session lookup and resize semantics to `CommandExecManager`.

*Call graph*: calls 1 internal fn (resize); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::command_exec_terminate`  (lines 64–73)

```
async fn command_exec_terminate(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecTerminateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Requests termination of a running command execution session and returns the manager’s termination response.

**Data flow**: Consumes a `ConnectionRequestId` and `CommandExecTerminateParams`, awaits `self.command_exec_manager.terminate`, and maps the result into `Some(ClientResponsePayload)`.

**Call relations**: Invoked by `handle_initialized_client_request` for terminate RPCs. It is the request-layer wrapper around the manager’s process shutdown logic.

*Call graph*: calls 1 internal fn (terminate); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::connection_closed`  (lines 75–79)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Notifies the execution manager that a client connection has closed so any associated exec sessions can be cleaned up.

**Data flow**: Takes a `ConnectionId`, forwards it to `self.command_exec_manager.connection_closed`, and returns no value.

**Call relations**: Called by the server’s connection teardown path. It delegates cleanup decisions to the manager, which tracks executions by connection.

*Call graph*: calls 1 internal fn (connection_closed); called by 1 (connection_closed).


##### `CommandExecRequestProcessor::require_local_environment`  (lines 81–87)

```
fn require_local_environment(&self) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Rejects command execution unless the environment manager currently exposes a local environment.

**Data flow**: Reads `self.environment_manager.try_local_environment()`, converts `Some(_)` into `Ok(())`, and converts `None` into a JSON-RPC internal error with the fixed message `local environment is not configured`.

**Call relations**: Used only by `one_off_command_exec` as an early guard before any command validation or process launch work begins.

*Call graph*: called by 1 (one_off_command_exec).


##### `CommandExecRequestProcessor::exec_one_off_command`  (lines 89–96)

```
async fn exec_one_off_command(
        &self,
        request_id: &ConnectionRequestId,
        params: CommandExecParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Small async wrapper that clones the request id into an owned value before entering the full execution pipeline.

**Data flow**: Takes `&ConnectionRequestId` plus `CommandExecParams`, clones the request id, forwards both to `exec_one_off_command_inner`, and returns its `Result<(), JSONRPCErrorError>` unchanged.

**Call relations**: Called by `one_off_command_exec` after environment validation. Its only role is ownership adaptation for the inner async workflow.

*Call graph*: calls 1 internal fn (exec_one_off_command_inner); called by 1 (one_off_command_exec); 1 external calls (clone).


##### `CommandExecRequestProcessor::exec_one_off_command_inner`  (lines 98–344)

```
async fn exec_one_off_command_inner(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates command/exec parameters, resolves permissions and network proxy state, builds a core exec request, and starts the execution through `CommandExecManager`.

**Data flow**: Consumes an owned `ConnectionRequestId` and `CommandExecParams`. It logs the params, destructures all fields, performs protocol validation, resolves `cwd` against `self.config.cwd`, creates the base shell environment and applies overrides, normalizes timeout/output-cap settings, computes `ExecExpiration` and `ExecCapturePolicy`, derives Windows sandbox settings, and resolves the effective permission profile from either explicit `permission_profile`, legacy `sandbox_policy`, or current config defaults. If a managed network proxy spec is present, it starts the proxy and keeps the started handle for the exec. It converts optional terminal size from protocol form, builds `ExecParams`, then calls `codex_core::exec::build_exec_request` with sandbox cwd, workspace roots, arg0 sandbox executable path, and the legacy-landlock feature flag. Finally it packages everything into `StartCommandExecParams` and awaits `self.command_exec_manager.start`, returning either the manager’s success or a JSON-RPC error.

**Call relations**: Reached only from `exec_one_off_command`. It is the central launch path: it consults `ConfigManager::load_for_cwd` when permission-profile overrides are requested, delegates request materialization to `build_exec_request`, and hands the finished execution off to `CommandExecManager::start` for actual runtime ownership.

*Call graph*: calls 7 internal fn (start, load_for_cwd, build_exec_request, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 1 (exec_one_off_command); 9 external calls (new, default, clone, Cancellation, format!, default, from_config, debug!, try_from).


### `app-server/src/command_exec.rs`

`domain_logic` · `request handling`

This file owns the lifecycle of interactive and non-interactive command execution sessions. `CommandExecManager` stores active sessions in `Arc<Mutex<HashMap<ConnectionProcessId, CommandExecSession>>>`, keyed by both `ConnectionId` and an internal process ID so different clients can reuse the same string safely. Process IDs are either client-supplied (`InternalProcessId::Client`) or generated from an `AtomicI64` counter when no streaming/TTY features are requested.

`CommandExecManager::start` validates protocol invariants first: streaming or TTY requires a client process ID, duplicate active IDs are rejected, and Windows restricted-token sandbox executions only support the one-shot non-streaming path with the default output cap. That Windows path stores an `UnsupportedWindowsSandbox` sentinel for client IDs, runs `codex_core::sandboxing::execute_env`, replies once with `CommandExecResponse` or an internal error, and removes the session afterward.

For normal PTY/pipe execution, `start` chooses `spawn_pty_process`, `spawn_pipe_process`, or `spawn_pipe_process_no_stdin`, inserts an active session carrying an `mpsc::Sender<CommandControlRequest>`, and spawns `run_command`. `run_command` multiplexes control requests, expiration, and process exit with `tokio::select!`, forwarding writes/resizes/termination to the `ProcessHandle`. It concurrently launches `spawn_process_output` for stdout and stderr; those tasks coalesce small chunks, enforce `output_bytes_cap`, optionally stream base64 deltas as `CommandExecOutputDeltaNotification`s, and otherwise accumulate text for the final response. After exit, `run_command` waits briefly for I/O drain using a watch channel and `IO_DRAIN_TIMEOUT_MS`, then sends the final `CommandExecResponse`.

The remaining helpers convert protocol terminal sizes, map dropped sessions to stable invalid-request errors, and clean up all sessions for a closed connection by sending terminate controls. Tests cover Windows sandbox restrictions, cancellation-vs-timeout semantics, unsupported control operations on Windows sentinel sessions, and dropped control-response channels.

#### Function details

##### `CommandExecManager::default`  (lines 54–59)

```
fn default() -> Self
```

**Purpose**: Creates an empty command-exec manager with no sessions and a generated-process counter starting at 1. It is the standard constructor used in tests and runtime setup.

**Data flow**: Allocates an empty `HashMap` inside `Arc<Mutex<_>>` and an `AtomicI64(1)` inside `Arc` → returns `CommandExecManager` containing both.

**Call relations**: Used wherever a fresh manager is needed, including runtime initialization and many tests.

*Call graph*: called by 8 (cancellation_expiration_keeps_process_alive_until_terminated, dropped_control_request_is_reported_as_not_running, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_non_streaming_exec_uses_execution_path, windows_sandbox_process_ids_reject_terminate_requests, windows_sandbox_process_ids_reject_write_requests, windows_sandbox_streaming_exec_is_rejected, new); 4 external calls (new, new, new, new).


##### `InternalProcessId::error_repr`  (lines 134–139)

```
fn error_repr(&self) -> String
```

**Purpose**: Formats an internal process ID for user-facing error messages. Client IDs are JSON-quoted when possible so string IDs are unambiguous in errors.

**Data flow**: Matches `InternalProcessId` → returns generated IDs as decimal strings or client IDs via `serde_json::to_string`, falling back to debug formatting if serialization somehow fails.

**Call relations**: Used by duplicate-ID and not-running error paths to produce stable messages.

*Call graph*: 1 external calls (to_string).


##### `CommandExecManager::start`  (lines 143–306)

```
async fn start(
        &self,
        params: StartCommandExecParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates a `command/exec` request, reserves a per-connection process ID, spawns the appropriate process execution path, and arranges final cleanup and response delivery. It handles both the normal PTY/pipe path and the special Windows restricted-token fallback path.

**Data flow**: Consumes `StartCommandExecParams` containing outgoing sender, request ID, optional process ID, `ExecRequest`, proxy handle, TTY/streaming flags, output cap, and optional terminal size → validates process-ID and sandbox constraints, derives `InternalProcessId`, checks for duplicates in `sessions`, and either: (a) for `SandboxType::WindowsRestrictedToken`, optionally inserts an `UnsupportedWindowsSandbox` sentinel, spawns `execute_env`, sends a one-shot response/error, and removes the session; or (b) extracts command/cwd/env/expiration, normalizes streaming flags, creates a control channel, inserts an active session, spawns the process via PTY or pipe helpers, and launches `run_command`, removing the session when it finishes. Returns `Ok(())` once the async task is launched or a `JSONRPCErrorError` on validation/spawn failure.

**Call relations**: Called by higher-level request handling for `command/exec`. It delegates long-running execution to `run_command` and uses session-map bookkeeping so later `write`, `resize`, `terminate`, and `connection_closed` calls can find the process.

*Call graph*: calls 4 internal fn (run_command, internal_error, invalid_request, execute_env); called by 1 (exec_one_off_command_inner); 8 external calls (clone, spawn_pipe_process, spawn_pipe_process_no_stdin, spawn_pty_process, format!, matches!, channel, spawn).


##### `CommandExecManager::write`  (lines 308–340)

```
async fn write(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecWriteParams,
    ) -> Result<CommandExecWriteResponse, JSONRPCErrorError>
```

**Purpose**: Decodes a base64 stdin delta or close request from the protocol and forwards it to the targeted active process. It rejects no-op writes that specify neither bytes nor stdin closure.

**Data flow**: Takes the caller’s `ConnectionRequestId` and `CommandExecWriteParams` → validates that `delta_base64` or `close_stdin` is present, base64-decodes the delta if provided, constructs a `ConnectionProcessId` using the caller’s connection and client process ID, sends `CommandControl::Write { delta, close_stdin }` via `send_control`, and returns `CommandExecWriteResponse {}`.

**Call relations**: Invoked by the app-server `command/exec/write` endpoint. It relies on `send_control` for session lookup and request/response synchronization.

*Call graph*: calls 2 internal fn (send_control, invalid_params); called by 1 (command_exec_write); 2 external calls (new, Client).


##### `CommandExecManager::terminate`  (lines 342–354)

```
async fn terminate(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecTerminateParams,
    ) -> Result<CommandExecTerminateResponse, JSONRPCErrorError>
```

**Purpose**: Requests termination of an active command-exec session identified by the caller’s connection and client process ID. It returns once the control request has been accepted by the session loop.

**Data flow**: Takes `ConnectionRequestId` and `CommandExecTerminateParams` → builds `ConnectionProcessId` → forwards `CommandControl::Terminate` through `send_control` → returns `CommandExecTerminateResponse {}`.

**Call relations**: Used by the `command/exec/terminate` endpoint and shares the common control path with `write` and `resize`.

*Call graph*: calls 1 internal fn (send_control); called by 1 (command_exec_terminate); 1 external calls (Client).


##### `CommandExecManager::resize`  (lines 356–373)

```
async fn resize(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecResizeParams,
    ) -> Result<CommandExecResizeResponse, JSONRPCErrorError>
```

**Purpose**: Validates a terminal size from protocol form and forwards a PTY resize request to the active session. It is only meaningful for PTY-backed executions.

**Data flow**: Takes `ConnectionRequestId` and `CommandExecResizeParams` → converts `CommandExecTerminalSize` to `TerminalSize` with `terminal_size_from_protocol`, builds `ConnectionProcessId`, sends `CommandControl::Resize { size }` via `send_control`, and returns `CommandExecResizeResponse {}`.

**Call relations**: Used by the `command/exec/resize` endpoint. Validation is delegated to `terminal_size_from_protocol`; delivery is delegated to `send_control`.

*Call graph*: calls 2 internal fn (send_control, terminal_size_from_protocol); called by 1 (command_exec_resize); 1 external calls (Client).


##### `CommandExecManager::connection_closed`  (lines 375–402)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Cleans up all command-exec sessions owned by a disconnected connection by removing them from the session map and asynchronously sending terminate controls to active ones. This prevents orphaned interactive processes after client disconnect.

**Data flow**: Takes a `ConnectionId` → locks `sessions`, collects and removes all entries whose key matches that connection, then iterates removed sessions and for each `Active` session sends a best-effort `CommandControl::Terminate` with no response channel.

**Call relations**: Called by connection-lifecycle handling when a client disconnects. It bypasses `send_control` because the sessions are being removed eagerly.

*Call graph*: called by 1 (connection_closed); 1 external calls (with_capacity).


##### `CommandExecManager::send_control`  (lines 404–439)

```
async fn send_control(
        &self,
        process_id: ConnectionProcessId,
        control: CommandControl,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Looks up an active session, sends one control request over its channel, and waits for the session loop to acknowledge success or return a protocol error. It also rejects control operations for Windows-sandbox sentinel sessions.

**Data flow**: Takes a `ConnectionProcessId` and `CommandControl` → clones the session entry from `sessions` or returns `invalid_request("no active command/exec...")` → if the session is `UnsupportedWindowsSandbox`, returns a fixed invalid-request error → otherwise creates a oneshot channel, sends `CommandControlRequest { control, response_tx: Some(...) }` over the session’s `mpsc::Sender`, awaits the oneshot reply, and maps send/recv failures to `command_no_longer_running_error`.

**Call relations**: Shared by `write`, `terminate`, and `resize` as the synchronous control-delivery mechanism into `run_command`.

*Call graph*: calls 1 internal fn (invalid_request); called by 3 (resize, terminate, write); 1 external calls (channel).


##### `run_command`  (lines 442–554)

```
async fn run_command(params: RunCommandParams)
```

**Purpose**: Owns the live execution loop for one spawned process: it handles control messages, expiration, process exit, output draining, and final response emission. It is the asynchronous core of command-exec session management.

**Data flow**: Consumes `RunCommandParams` containing outgoing sender, request ID, optional client-visible process ID, `SpawnedProcess`, control receiver, streaming flags, expiration policy, and output cap → starts stdout/stderr collector tasks with `spawn_process_output`, pins expiration and exit futures, then loops with `tokio::select!` over control messages, expiration outcome, and process exit. Control messages call `handle_process_write`, `handle_process_resize`, or `session.request_terminate()`. On expiration it records the outcome and requests termination. On exit it chooses `EXEC_TIMEOUT_EXIT_CODE` only for actual timed-out expirations, otherwise uses the process exit code or `-1`. It then starts a short drain timeout, awaits stdout/stderr collectors, aborts the timeout task, and sends `CommandExecResponse { exit_code, stdout, stderr }`.

**Call relations**: Spawned by `CommandExecManager::start` for normal PTY/pipe executions. It delegates output handling to `spawn_process_output` and per-control semantics to `handle_process_write` and `handle_process_resize`.

*Call graph*: calls 1 internal fn (spawn_process_output); called by 1 (start); 7 external calls (clone, from_millis, pin!, select!, spawn, sleep, channel).


##### `spawn_process_output`  (lines 556–618)

```
fn spawn_process_output(params: SpawnProcessOutputParams) -> tokio::task::JoinHandle<String>
```

**Purpose**: Collects one output stream from a spawned process, optionally streaming base64 deltas to the client and/or buffering text for the final response while enforcing an output byte cap. It also stops when the post-exit stdio drain timeout fires.

**Data flow**: Consumes `SpawnProcessOutputParams` with connection/process IDs, an output receiver, a watch receiver for stdio timeout, outgoing sender, stream kind, streaming flag, and optional byte cap → spawns a task that repeatedly selects between `output_rx.recv()` and `stdio_timeout_rx.wait_for(true)`, coalesces small chunks up to `OUTPUT_CHUNK_SIZE_HINT`, truncates according to `output_bytes_cap`, tracks whether the cap was reached, either sends `ServerNotification::CommandExecOutputDelta` to the specific connection (when streaming and a client process ID exists) or appends bytes to an internal buffer, stops on cap or timeout, and finally converts buffered bytes to text with `bytes_to_string_smart`.

**Call relations**: Created twice by `run_command`, once for stdout and once for stderr. Its streamed notifications are the incremental output surface for interactive clients.

*Call graph*: calls 1 internal fn (bytes_to_string_smart); called by 1 (run_command); 4 external calls (CommandExecOutputDelta, new, select!, spawn).


##### `handle_process_write`  (lines 620–642)

```
async fn handle_process_write(
    session: &ProcessHandle,
    stream_stdin: bool,
    delta: Vec<u8>,
    close_stdin: bool,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Applies a stdin write and/or close request to a running process, enforcing that stdin streaming was enabled for the session. It maps closed stdin to a protocol invalid-request error.

**Data flow**: Takes a `ProcessHandle`, `stream_stdin` flag, byte delta, and `close_stdin` flag → if streaming is disabled returns `invalid_request` → if delta is non-empty sends it through `session.writer_sender()` and maps send failure to `invalid_request("stdin is already closed")` → closes stdin when requested → returns `Result<(), JSONRPCErrorError>`.

**Call relations**: Called only from `run_command` when it receives `CommandControl::Write`.

*Call graph*: calls 1 internal fn (invalid_request); 2 external calls (close_stdin, writer_sender).


##### `handle_process_resize`  (lines 644–651)

```
fn handle_process_resize(
    session: &ProcessHandle,
    size: TerminalSize,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Resizes the PTY backing a running process and maps resize failures into protocol invalid-request errors. It is a thin adapter around the process handle.

**Data flow**: Takes a `ProcessHandle` and `TerminalSize` → calls `session.resize(size)` → returns `Ok(())` or `invalid_request(format!(...))` on failure.

**Call relations**: Called only from `run_command` when it receives `CommandControl::Resize`.

*Call graph*: 1 external calls (resize).


##### `terminal_size_from_protocol`  (lines 653–665)

```
fn terminal_size_from_protocol(
    size: CommandExecTerminalSize,
) -> Result<TerminalSize, JSONRPCErrorError>
```

**Purpose**: Validates protocol terminal dimensions and converts them into the PTY library’s `TerminalSize`. Zero rows or columns are rejected.

**Data flow**: Takes `CommandExecTerminalSize { rows, cols }` → checks both are greater than zero → returns `TerminalSize { rows, cols }` or `invalid_params(...)`.

**Call relations**: Used by `CommandExecManager::resize` before sending a resize control.

*Call graph*: calls 1 internal fn (invalid_params); called by 1 (resize).


##### `command_no_longer_running_error`  (lines 667–672)

```
fn command_no_longer_running_error(process_id: &InternalProcessId) -> JSONRPCErrorError
```

**Purpose**: Builds the standard invalid-request error used when a control request targets a session that has already ended or whose control loop dropped. It keeps error wording consistent across send/recv failures.

**Data flow**: Takes `&InternalProcessId` → formats it with `error_repr()` inside a fixed message → returns `JSONRPCErrorError` via `invalid_request`.

**Call relations**: Used by `CommandExecManager::send_control` when the control channel or response channel is gone.

*Call graph*: calls 1 internal fn (invalid_request); 1 external calls (format!).


##### `tests::windows_sandbox_exec_request`  (lines 696–712)

```
fn windows_sandbox_exec_request() -> ExecRequest
```

**Purpose**: Builds a canonical `ExecRequest` fixture targeting the Windows restricted-token sandbox. It centralizes test setup for sandbox-specific behavior.

**Data flow**: Reads current directory, constructs `ExecRequest::new(...)` with `SandboxType::WindowsRestrictedToken`, default timeout, read-only permissions, and a simple `cmd` command → returns the request.

**Call relations**: Used by Windows-sandbox tests as shared input.

*Call graph*: calls 3 internal fn (new, read_only, current_dir); 2 external calls (new, vec!).


##### `tests::windows_sandbox_streaming_exec_is_rejected`  (lines 715–745)

```
async fn windows_sandbox_streaming_exec_is_rejected()
```

**Purpose**: Verifies that streaming stdout/stderr is rejected for Windows restricted-token sandbox executions. This locks down one of the explicit validation rules in `start`.

**Data flow**: Creates a manager and request parameters with `stream_stdout_stderr: true`, calls `CommandExecManager::start`, expects an error, and asserts the invalid-request code and message.

**Call relations**: Directly exercises the Windows validation branch in `CommandExecManager::start`.

*Call graph*: calls 3 internal fn (disabled, default, new); 6 external calls (new, Integer, new, windows_sandbox_exec_request, assert_eq!, channel).


##### `tests::windows_sandbox_non_streaming_exec_uses_execution_path`  (lines 749–794)

```
async fn windows_sandbox_non_streaming_exec_uses_execution_path()
```

**Purpose**: Verifies that a non-streaming Windows restricted-token sandbox request is accepted and runs through the one-shot execution path, surfacing execution failure as an error response. It checks that the special fallback path is actually used.

**Data flow**: Starts a manager with a Windows sandbox request using default output cap and no streaming, waits for one outgoing message, unwraps the connection-scoped envelope, and asserts it is an error response for the original request ID whose message starts with `exec failed:`.

**Call relations**: Exercises the asynchronous Windows fallback branch in `CommandExecManager::start`.

*Call graph*: calls 3 internal fn (disabled, default, new); 10 external calls (new, from_secs, Integer, new, windows_sandbox_exec_request, assert!, assert_eq!, channel, panic!, timeout).


##### `tests::cancellation_expiration_keeps_process_alive_until_terminated`  (lines 798–879)

```
async fn cancellation_expiration_keeps_process_alive_until_terminated()
```

**Purpose**: Verifies that `ExecExpiration::Cancellation` does not terminate the process on its own and that the command remains active until an explicit terminate request arrives. It checks the distinction between cancellation-based expiration and direct termination.

**Data flow**: Starts a long-running shell command with cancellation-based expiration, asserts no response arrives within 250 ms, sends `terminate`, then waits for the final response and asserts a nonzero exit code and empty stdout.

**Call relations**: Exercises `run_command`’s expiration/select loop and the terminate control path.

*Call graph*: calls 6 internal fn (disabled, default, new, new, read_only, current_dir); 15 external calls (new, new, from_secs, new, Integer, new, assert!, assert_eq!, assert_ne!, Cancellation (+5 more)).


##### `tests::timeout_or_cancellation_reports_cancellation_without_timeout_exit_code`  (lines 883–951)

```
async fn timeout_or_cancellation_reports_cancellation_without_timeout_exit_code()
```

**Purpose**: Verifies that the cancellation arm of `ExecExpiration::TimeoutOrCancellation` does not report the synthetic timeout exit code `124`. Only actual timeouts should do that.

**Data flow**: Starts a long-running command with `TimeoutOrCancellation`, cancels the token, waits for the final response, deserializes `CommandExecResponse`, and asserts `exit_code != EXEC_TIMEOUT_EXIT_CODE`.

**Call relations**: Tests the `expiration_outcome` handling in `run_command`.

*Call graph*: calls 6 internal fn (disabled, default, new, new, read_only, current_dir); 13 external calls (new, new, from_secs, new, Integer, new, assert_eq!, assert_ne!, channel, panic! (+3 more)).


##### `tests::windows_sandbox_process_ids_reject_write_requests`  (lines 954–987)

```
async fn windows_sandbox_process_ids_reject_write_requests()
```

**Purpose**: Verifies that sessions marked `UnsupportedWindowsSandbox` reject `command/exec/write` with the fixed unsupported-operation message. This covers the sentinel-session control path.

**Data flow**: Manually inserts an `UnsupportedWindowsSandbox` session keyed by a client process ID, calls `write`, expects an error, and asserts code and message.

**Call relations**: Directly exercises `CommandExecManager::send_control`’s sentinel-session branch via `write`.

*Call graph*: calls 1 internal fn (default); 4 external calls (Integer, new, Client, assert_eq!).


##### `tests::windows_sandbox_process_ids_reject_terminate_requests`  (lines 990–1021)

```
async fn windows_sandbox_process_ids_reject_terminate_requests()
```

**Purpose**: Verifies that `command/exec/terminate` is also rejected for Windows-sandbox sentinel sessions. It ensures all control operations share the same unsupported behavior.

**Data flow**: Manually inserts an `UnsupportedWindowsSandbox` session, calls `terminate`, expects an error, and asserts code and message.

**Call relations**: Exercises the same sentinel-session branch via `terminate`.

*Call graph*: calls 1 internal fn (default); 4 external calls (Integer, new, Client, assert_eq!).


##### `tests::dropped_control_request_is_reported_as_not_running`  (lines 1024–1059)

```
async fn dropped_control_request_is_reported_as_not_running()
```

**Purpose**: Verifies that if a control request is accepted onto the channel but its response sender is dropped before replying, the caller sees the standard `no longer running` invalid-request error. This covers a subtle race in control delivery.

**Data flow**: Inserts an active session with a test control channel, spawns a task that receives and drops one control request without replying, calls `terminate`, expects an error, and asserts the exact message.

**Call relations**: Directly tests the response-channel failure mapping in `CommandExecManager::send_control`.

*Call graph*: calls 1 internal fn (default); 6 external calls (Integer, new, Client, assert_eq!, channel, spawn).


### `app-server/src/request_processors/process_exec_processor.rs`

`domain_logic` · `request handling / background process lifetime / connection teardown`

This file provides a complete mini-subsystem for interactive and non-interactive process execution. `ProcessExecRequestProcessor` is the RPC-facing layer; it validates spawn parameters, ensures a local execution environment exists, merges environment overrides into the current process environment, translates timeout semantics into `ExecExpiration`, and delegates lifecycle management to `ProcessExecManager`. The manager stores active sessions in `Arc<Mutex<HashMap<ConnectionProcessHandle, ProcessSession>>>`, keyed by both `ConnectionId` and client-supplied `process_handle`, preventing collisions across connections while rejecting duplicate active handles within one connection.

Starting a process inserts a control channel into the session map before spawning either a PTY process, a piped process with stdin, or a piped process without stdin depending on `tty` and `stream_stdin`. Once spawned, the server immediately sends `ProcessSpawnResponse`, then detaches `run_process`, which concurrently watches three event sources with `tokio::select!`: control requests (`Write`, `Resize`, `Kill`), expiration completion, and process exit. Expiration triggers termination and forces the final exit code to `124` when the process timed out.

Stdout and stderr are handled by separate `collect_spawn_process_output` tasks. Each task coalesces small chunks up to `OUTPUT_CHUNK_SIZE_HINT`, enforces an optional byte cap, and either streams base64 deltas as `ProcessOutputDeltaNotification`s or buffers bytes for the final exit notification. After process exit, `run_process` gives the output readers a bounded grace period (`IO_DRAIN_TIMEOUT_MS`) to drain remaining output, then sends a `ProcessExitedNotification` containing exit code, captured stdout/stderr text, and cap-reached flags. Control operations are routed through per-process channels and acknowledged with oneshot responses so callers get immediate JSON-RPC success/failure. Connection teardown removes all sessions for that connection and sends kill requests without waiting for acknowledgements.

#### Function details

##### `ProcessExecRequestProcessor::new`  (lines 57–66)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        environment_manager: Arc<EnvironmentManager>,
    ) -> Self
```

**Purpose**: Constructs the process-exec request processor and initializes an empty in-memory `ProcessExecManager`.

**Data flow**: Takes `Arc<OutgoingMessageSender>` and `Arc<EnvironmentManager>`, stores them, initializes `process_exec_manager` with `ProcessExecManager::default()`, and returns the processor.

**Call relations**: Created during processor setup so process-execution RPCs can share one session manager and outgoing sender.

*Call graph*: called by 1 (new); 1 external calls (default).


##### `ProcessExecRequestProcessor::process_spawn`  (lines 68–143)

```
async fn process_spawn(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessSpawnParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates a spawn request, normalizes environment and timeout settings, and starts a tracked process session.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessSpawnParams`. It checks for a local environment via `require_local_environment`, validates non-empty `command` and `process_handle`, rejects `size` when `tty` is false, clones the current process environment with `std::env::vars()`, applies optional env overrides including deletions, converts `timeout_ms` into `ExecExpiration` (`Duration`, cancellation token, or default timeout), defaults `output_bytes_cap`, converts optional terminal size with `terminal_size_from_protocol`, and awaits `process_exec_manager.start(StartProcessParams { ... })`. It returns `Ok(())` or JSON-RPC validation/internal errors.

**Call relations**: Called by `handle_initialized_client_request` for `process/spawn`; after validation it hands off actual session creation and process spawning to `ProcessExecManager::start`.

*Call graph*: calls 4 internal fn (invalid_params, invalid_request, start, require_local_environment); called by 1 (handle_initialized_client_request); 6 external calls (new, Cancellation, format!, vars, debug!, try_from).


##### `ProcessExecRequestProcessor::process_write_stdin`  (lines 145–154)

```
async fn process_write_stdin(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessWriteStdinParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the stdin-write RPC for an active process and wraps the typed response into a generic payload.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessWriteStdinParams`, awaits `process_exec_manager.write_stdin(...)`, converts `ProcessWriteStdinResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Reached from initialized request dispatch and delegates the actual control-channel send to `ProcessExecManager::write_stdin`.

*Call graph*: calls 1 internal fn (write_stdin); called by 1 (handle_initialized_client_request).


##### `ProcessExecRequestProcessor::process_resize_pty`  (lines 156–165)

```
async fn process_resize_pty(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessResizePtyParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the PTY-resize RPC for an active process and wraps the typed response into a generic payload.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessResizePtyParams`, awaits `process_exec_manager.resize_pty(...)`, converts `ProcessResizePtyResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Called by `handle_initialized_client_request`; it delegates resize validation and control delivery to `ProcessExecManager::resize_pty`.

*Call graph*: calls 1 internal fn (resize_pty); called by 1 (handle_initialized_client_request).


##### `ProcessExecRequestProcessor::process_kill`  (lines 167–176)

```
async fn process_kill(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessKillParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Serves the process-kill RPC for an active process and wraps the typed response into a generic payload.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessKillParams`, awaits `process_exec_manager.kill(...)`, converts `ProcessKillResponse` into `ClientResponsePayload`, and returns `Some(...)`.

**Call relations**: Invoked by initialized request dispatch and delegates the actual kill control send to `ProcessExecManager::kill`.

*Call graph*: calls 1 internal fn (kill); called by 1 (handle_initialized_client_request).


##### `ProcessExecRequestProcessor::connection_closed`  (lines 178–182)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Kills and forgets all active processes associated with a disconnected connection.

**Data flow**: Accepts a `ConnectionId`, forwards it to `self.process_exec_manager.connection_closed(connection_id).await`, and returns no value.

**Call relations**: Called by the server's connection-close handling path so orphaned processes do not survive client disconnects.

*Call graph*: calls 1 internal fn (connection_closed); called by 1 (connection_closed).


##### `ProcessExecRequestProcessor::require_local_environment`  (lines 184–190)

```
fn require_local_environment(&self) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Rejects process execution when no local execution environment is configured.

**Data flow**: Reads `self.environment_manager.try_local_environment()`, returns `Ok(())` when present, otherwise returns `internal_error("local environment is not configured")`.

**Call relations**: Used only by `process_spawn` as an early capability check before any process state is created.

*Call graph*: called by 1 (process_spawn).


##### `ProcessExecManager::start`  (lines 265–353)

```
async fn start(&self, params: StartProcessParams) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Registers a new process session, spawns the requested process variant, sends the spawn response, and launches the detached run loop.

**Data flow**: Consumes `StartProcessParams`, splits `command` into program and args, forces stdin/stdout streaming on when `tty` is true, creates an mpsc control channel, inserts a `ProcessSession { control_tx }` into `self.sessions` under `ConnectionProcessHandle`, rejecting duplicates with `invalid_request`, spawns the process via `spawn_pty_process`, `spawn_pipe_process`, or `spawn_pipe_process_no_stdin`, removes the session and returns `internal_error` on spawn failure, sends `ProcessSpawnResponse` through `outgoing`, then spawns `run_process(...)` and removes the session from the map when that task completes.

**Call relations**: Called only by `ProcessExecRequestProcessor::process_spawn`; it is the bridge from validated request parameters to a live tracked process session.

*Call graph*: calls 3 internal fn (internal_error, invalid_request, run_process); called by 1 (process_spawn); 7 external calls (clone, spawn_pipe_process, spawn_pipe_process_no_stdin, spawn_pty_process, format!, channel, spawn).


##### `ProcessExecManager::write_stdin`  (lines 355–384)

```
async fn write_stdin(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessWriteStdinParams,
    ) -> Result<ProcessWriteStdinResponse, JSONRPCErrorError>
```

**Purpose**: Validates a stdin-write request, decodes the optional base64 payload, and sends a write/close control message to the target process.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessWriteStdinParams`. It rejects requests lacking both `delta_base64` and `close_stdin`, decodes `delta_base64` with `STANDARD.decode` or returns `invalid_params` on malformed base64, builds `ProcessControl::Write { delta, close_stdin }`, sends it via `send_control`, and returns `ProcessWriteStdinResponse {}`.

**Call relations**: Called by `ProcessExecRequestProcessor::process_write_stdin`; it uses `send_control` to route the request to the process run loop and wait for acknowledgement.

*Call graph*: calls 2 internal fn (invalid_params, send_control); called by 1 (process_write_stdin); 1 external calls (new).


##### `ProcessExecManager::kill`  (lines 386–398)

```
async fn kill(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessKillParams,
    ) -> Result<ProcessKillResponse, JSONRPCErrorError>
```

**Purpose**: Sends a kill control message to an active process and returns an empty success response once the control is accepted.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessKillParams`, forwards `ProcessControl::Kill` to `send_control`, awaits the acknowledgement, and returns `ProcessKillResponse {}`.

**Call relations**: Called by `ProcessExecRequestProcessor::process_kill`; it is a thin wrapper over `send_control`.

*Call graph*: calls 1 internal fn (send_control); called by 1 (process_kill).


##### `ProcessExecManager::resize_pty`  (lines 400–414)

```
async fn resize_pty(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessResizePtyParams,
    ) -> Result<ProcessResizePtyResponse, JSONRPCErrorError>
```

**Purpose**: Validates and forwards a PTY resize request to an active process session.

**Data flow**: Consumes `ConnectionRequestId` and `ProcessResizePtyParams`, converts `params.size` with `terminal_size_from_protocol`, wraps it in `ProcessControl::Resize { size }`, sends it via `send_control`, awaits acknowledgement, and returns `ProcessResizePtyResponse {}`.

**Call relations**: Called by `ProcessExecRequestProcessor::process_resize_pty`; it combines protocol-size validation with control-channel delivery.

*Call graph*: calls 2 internal fn (send_control, terminal_size_from_protocol); called by 1 (process_resize_pty).


##### `ProcessExecManager::connection_closed`  (lines 416–442)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Removes all process sessions for a connection from the session map and asynchronously sends each one a kill request without waiting for a reply.

**Data flow**: Accepts a `ConnectionId`, locks `self.sessions`, collects and removes all `ProcessSession`s whose key has the matching connection ID, then iterates those sessions and sends `ProcessControlRequest { control: Kill, response_tx: None }` on each control channel, ignoring send failures.

**Call relations**: Invoked by `ProcessExecRequestProcessor::connection_closed` during disconnect cleanup so process tasks are asked to terminate even after their session entries are removed.

*Call graph*: called by 1 (connection_closed); 1 external calls (with_capacity).


##### `ProcessExecManager::send_control`  (lines 444–473)

```
async fn send_control(
        &self,
        connection_id: ConnectionId,
        process_handle: String,
        control: ProcessControl,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Looks up an active process session, sends a control request over its channel, and waits for the run loop to acknowledge success or failure.

**Data flow**: Takes `connection_id`, `process_handle`, and a `ProcessControl`. It builds a `ConnectionProcessHandle`, locks `self.sessions` to clone the matching `ProcessSession` or returns `no_active_process_error`, creates a oneshot channel, sends `ProcessControlRequest { control, response_tx: Some(response_tx) }` over `control_tx`, maps send failures to `process_no_longer_running_error`, awaits the oneshot response, and returns the contained `Result<(), JSONRPCErrorError>` or a no-longer-running error if the response channel closes.

**Call relations**: Shared by `write_stdin`, `kill`, and `resize_pty` so all synchronous control RPCs use the same lookup, delivery, and acknowledgement path.

*Call graph*: called by 3 (kill, resize_pty, write_stdin); 1 external calls (channel).


##### `run_process`  (lines 476–597)

```
async fn run_process(params: RunProcessParams)
```

**Purpose**: Owns the lifetime of a spawned process: it handles control messages, timeout/cancellation, output collection, and the final exit notification.

**Data flow**: Consumes `RunProcessParams`, pins the expiration future and process exit receiver, creates a watch channel for stdio-drain timeout, starts stdout/stderr collection tasks with `collect_spawn_process_output`, then enters a `tokio::select!` loop over control messages, expiration completion, and process exit. Control messages delegate to `handle_process_write`, `handle_process_resize`, or `session.request_terminate()`, replying over optional oneshot channels. Expiration records the outcome and requests termination. On exit it chooses `EXEC_TIMEOUT_EXIT_CODE` when the expiration outcome was `TimedOut`, otherwise uses the process exit code or `-1`. It then spawns a short sleep task to signal stdio timeout after `IO_DRAIN_TIMEOUT_MS`, awaits both output collectors, aborts the timeout task, and sends `ServerNotification::ProcessExited` with captured stdout/stderr text and cap flags to the originating connection.

**Call relations**: Spawned by `ProcessExecManager::start` after a process is successfully created. It coordinates the helper functions and output collectors until the process fully terminates.

*Call graph*: calls 1 internal fn (collect_spawn_process_output); called by 1 (start); 8 external calls (clone, from_millis, ProcessExited, pin!, select!, spawn, sleep, channel).


##### `collect_spawn_process_output`  (lines 599–664)

```
fn collect_spawn_process_output(
    params: SpawnProcessOutputParams,
) -> tokio::task::JoinHandle<ProcessOutputCapture>
```

**Purpose**: Collects one output stream from a spawned process, optionally streams base64 deltas to the client, enforces an output byte cap, and returns buffered text for the final exit notification.

**Data flow**: Consumes `SpawnProcessOutputParams`, spawns a task that repeatedly waits for either `output_rx.recv()` or `stdio_timeout_rx` becoming true, coalesces additional immediately available chunks up to `OUTPUT_CHUNK_SIZE_HINT`, truncates each chunk according to `output_bytes_cap`, updates `observed_num_bytes` and `cap_reached`, and either sends `ServerNotification::ProcessOutputDelta` with base64-encoded bytes when `stream_output` is true or appends bytes to an internal buffer otherwise. When the stream ends, timeout fires, or the cap is reached, it converts the buffered bytes to text with `bytes_to_string_smart` and returns `ProcessOutputCapture { text, cap_reached }`.

**Call relations**: Called twice by `run_process`, once for stdout and once for stderr, so both streams share the same chunking, capping, and notification behavior.

*Call graph*: calls 1 internal fn (bytes_to_string_smart); called by 1 (run_process); 4 external calls (ProcessOutputDelta, new, select!, spawn).


##### `handle_process_write`  (lines 666–690)

```
async fn handle_process_write(
    session: &ProcessHandle,
    stream_stdin: bool,
    delta: Vec<u8>,
    close_stdin: bool,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Applies a write-to-stdin control request, enforcing that stdin streaming was enabled for the process and optionally closing stdin afterward.

**Data flow**: Takes a `&ProcessHandle`, `stream_stdin` flag, raw `delta` bytes, and `close_stdin`. It returns `invalid_request` if stdin streaming is disabled. Otherwise it sends non-empty `delta` through `session.writer_sender()`, mapping send failure to `invalid_request("stdin is already closed")`, and if `close_stdin` is true calls `session.close_stdin()`. It returns `Ok(())` on success.

**Call relations**: Used only inside `run_process` when a `ProcessControl::Write` request arrives over the control channel.

*Call graph*: calls 1 internal fn (invalid_request); 2 external calls (close_stdin, writer_sender).


##### `handle_process_resize`  (lines 692–699)

```
fn handle_process_resize(
    session: &ProcessHandle,
    size: TerminalSize,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Applies a PTY resize request to the running process session.

**Data flow**: Takes a `&ProcessHandle` and `TerminalSize`, calls `session.resize(size)`, and maps any resize failure to `invalid_request(format!("failed to resize PTY: {err}"))`.

**Call relations**: Called only from `run_process` when a `ProcessControl::Resize` control message is received.

*Call graph*: 1 external calls (resize).


##### `terminal_size_from_protocol`  (lines 701–713)

```
fn terminal_size_from_protocol(
    size: ProcessTerminalSize,
) -> Result<TerminalSize, JSONRPCErrorError>
```

**Purpose**: Validates protocol terminal dimensions and converts them into the PTY library's `TerminalSize` type.

**Data flow**: Consumes `ProcessTerminalSize`, checks that both `rows` and `cols` are greater than zero, returns `invalid_params` if either is zero, otherwise returns `TerminalSize { rows, cols }`.

**Call relations**: Used by spawn and resize paths before PTY-related operations are attempted.

*Call graph*: calls 1 internal fn (invalid_params); called by 1 (resize_pty).


##### `no_active_process_error`  (lines 715–719)

```
fn no_active_process_error(process_handle: &str) -> JSONRPCErrorError
```

**Purpose**: Builds the standard invalid-request error for operations targeting a nonexistent active process handle.

**Data flow**: Accepts `&str process_handle`, formats `no active process for process handle ...`, and returns `invalid_request(...)`.

**Call relations**: Used by `ProcessExecManager::send_control` when the requested process handle is absent from the session map.

*Call graph*: calls 1 internal fn (invalid_request); 1 external calls (format!).


##### `process_no_longer_running_error`  (lines 721–723)

```
fn process_no_longer_running_error(process_handle: &str) -> JSONRPCErrorError
```

**Purpose**: Builds the standard invalid-request error for operations sent to a process whose session disappeared while the control request was in flight.

**Data flow**: Accepts `&str process_handle`, formats `process ... is no longer running`, and returns `invalid_request(...)`.

**Call relations**: Used by `ProcessExecManager::send_control` when the control channel send fails or the acknowledgement oneshot is dropped.

*Call graph*: calls 1 internal fn (invalid_request); 1 external calls (format!).


### TUI command forwarding
These files provide the TUI-side helpers that package workspace command requests and route them to the app-server.

### `tui/src/app_server_session/fs.rs`

`io_transport` · `request handling`

This submodule extends `AppServerSession` with a small set of file-system operations used by the TUI: create directory recursively, write file bytes, read file bytes, and remove a path. The public methods are thin wrappers around a shared internal helper, `request_fs_path`, which is where the important transport split lives.

For remote app servers, `request_fs_path` uses `AppServerRequestHandle::Remote` to send a raw `JSONRPCRequest` with the provided method name and JSON params, then deserializes the returned JSON value into the expected typed response. For in-process servers, it first validates that the `AppServerPath` string is an absolute local path via `AbsolutePathBuf::from_absolute_path_checked`, then constructs the typed `ClientRequest` using the supplied closure and sends it through `self.client.request_typed`. This keeps callers oblivious to whether the app server is local or remote.

The file methods also handle base64 encoding/decoding for file contents because the protocol transports bytes as base64 strings. `fs_write_file_path` encodes outgoing bytes with `STANDARD.encode`, while `fs_read_file_path` decodes `response.data_base64` and wraps invalid base64 as a contextual error. The design choice here is explicit method-name/context strings so failures mention the exact RPC (`fs/readFile`, `fs/writeFile`, etc.) regardless of transport path.

#### Function details

##### `AppServerSession::fs_create_directory_all_path`  (lines 24–42)

```
async fn fs_create_directory_all_path(
        &mut self,
        path: &AppServerPath,
    ) -> Result<()>
```

**Purpose**: Creates a directory path on the app server, requesting recursive parent creation.

**Data flow**: It takes `&AppServerPath`, calls `request_fs_path::<FsCreateDirectoryResponse>` with method `"fs/createDirectory"`, a closure that builds `ClientRequest::FsCreateDirectory { recursive: Some(true) }`, and matching JSON params, then discards the typed response with `map(drop)` and returns `Result<()>`.

**Call relations**: This is a convenience wrapper over `request_fs_path` for directory creation. Callers use it when they need filesystem setup without caring whether the server is remote or in-process.

*Call graph*: 1 external calls (json!).


##### `AppServerSession::fs_write_file_path`  (lines 44–64)

```
async fn fs_write_file_path(
        &mut self,
        path: &AppServerPath,
        bytes: Vec<u8>,
    ) -> Result<()>
```

**Purpose**: Writes raw bytes to a file path on the app server.

**Data flow**: It takes `&AppServerPath` and `Vec<u8>`, base64-encodes the bytes into `data_base64`, calls `request_fs_path::<FsWriteFileResponse>` with method `"fs/writeFile"`, a closure that builds `ClientRequest::FsWriteFile` using the encoded string, and equivalent JSON params, then drops the response and returns `Result<()>`.

**Call relations**: This wrapper packages the protocol's base64 content requirement and delegates transport branching to `request_fs_path`.

*Call graph*: 1 external calls (json!).


##### `AppServerSession::fs_read_file_path`  (lines 66–81)

```
async fn fs_read_file_path(&mut self, path: &AppServerPath) -> Result<Vec<u8>>
```

**Purpose**: Reads a file from the app server and returns its raw bytes.

**Data flow**: It takes `&AppServerPath`, calls `request_fs_path` with method `"fs/readFile"`, a closure that builds `ClientRequest::FsReadFile`, and JSON params containing the path. It receives `FsReadFileResponse`, decodes `response.data_base64` with the standard base64 engine, and returns `Vec<u8>` or a contextual decode error.

**Call relations**: This is the read-side counterpart to `fs_write_file_path`. It is the only public method in this file explicitly shown calling `request_fs_path` in the call graph, and it relies on that helper for remote/local transport selection.

*Call graph*: calls 1 internal fn (request_fs_path); 1 external calls (json!).


##### `AppServerSession::fs_remove_path`  (lines 83–99)

```
async fn fs_remove_path(&mut self, path: &AppServerPath) -> Result<()>
```

**Purpose**: Removes a file-system path on the app server using default non-recursive/non-force semantics.

**Data flow**: It takes `&AppServerPath`, calls `request_fs_path::<FsRemoveResponse>` with method `"fs/remove"`, a closure that builds `ClientRequest::FsRemove { recursive: None, force: None }`, and matching JSON params, then drops the response and returns `Result<()>`.

**Call relations**: Like the other wrappers, this delegates all transport-specific behavior to `request_fs_path` while fixing the method name and parameter shape for path removal.

*Call graph*: 1 external calls (json!).


##### `AppServerSession::request_fs_path`  (lines 101–134)

```
async fn request_fs_path(
        &mut self,
        method: &str,
        path: &AppServerPath,
        local_request: impl FnOnce(RequestId, AbsolutePathBuf) -> ClientRequest,
        remote_params:
```

**Purpose**: Implements the shared filesystem RPC transport logic, choosing raw JSON-RPC for remote servers and typed local requests for in-process servers.

**Data flow**: It takes a method name, `&AppServerPath`, a closure that can build a typed `ClientRequest` from `(RequestId, AbsolutePathBuf)`, and a JSON params value. It allocates a request id via `next_request_id`, then inspects `self.request_handle()`. For `Remote(handle)`, it sends a `JSONRPCRequest { id, method, params, trace: None }`, wraps transport errors with method context, converts JSON-RPC error responses into eyre errors using the server message, deserializes the success value into `T` with `serde_json::from_value`, and returns it. For `InProcess(_)`, it validates the path string as an `AbsolutePathBuf`, builds the typed request with the closure, sends it through `self.client.request_typed`, and returns the typed response.

**Call relations**: All public fs helpers in this file are built on top of this method. It exists to hide the remote-vs-local protocol split and to keep method-specific wrappers small and declarative.

*Call graph*: calls 2 internal fn (as_str, from_absolute_path_checked); called by 1 (fs_read_file_path); 1 external calls (from_value).


### `tui/src/workspace_command.rs`

`orchestration` · `background workspace probes and other non-interactive command execution during UI operation`

This module is the boundary between TUI components that need background workspace probes and the app-server transport that actually executes them. Its core request type is `WorkspaceCommand`, an argv-based command description with optional `cwd: Option<PathBuf>`, environment overrides stored as `HashMap<String, Option<String>>`, a wall-clock `Duration` timeout, and output-capture controls (`output_bytes_cap` plus `disable_output_cap`). The builder-style methods intentionally avoid shell semantics and let callers compose safe requests without quoting repository data.

Results are split into two categories: normal process completion, represented by `WorkspaceCommandOutput { exit_code, stdout, stderr }`, and infrastructure/protocol failure, represented by `WorkspaceCommandError { message }`. That distinction is important because non-zero exit codes are not treated as transport errors.

The object-safe `WorkspaceCommandExecutor` trait returns a boxed future so TUI code can hold an `Arc<dyn WorkspaceCommandExecutor>` regardless of whether the backing app-server is embedded or remote. `AppServerWorkspaceCommandRunner` is the concrete implementation used here: it converts the command into `ClientRequest::OneOffCommandExec`, generates a unique `RequestId` using a UUID, disables TTY and streaming, passes through cwd/env/timeout/output-cap settings, and leaves sandbox and permission-profile selection unset so app-server policy remains authoritative. Timeout conversion saturates to `i64::MAX` on overflow, and empty env maps are sent as `None` rather than an empty object.

#### Function details

##### `WorkspaceCommand::new`  (lines 54–63)

```
fn new(argv: impl IntoIterator<Item = impl Into<String>>) -> Self
```

**Purpose**: Constructs a `WorkspaceCommand` from an argv iterator with conservative defaults intended for short metadata lookups. The defaults are a 5-second timeout, 64 KiB output cap, no cwd override, and no environment overrides.

**Data flow**: Consumes any iterable of items convertible to `String`, collects them into `argv: Vec<String>`, initializes `cwd` to `None`, `env` to an empty `HashMap`, `timeout` to `Duration::from_secs(5)`, `output_bytes_cap` to `64 * 1024`, and `disable_output_cap` to `false`, then returns the populated struct.

**Call relations**: This is the normal entry point used by higher-level probe helpers such as git and gh command wrappers before they optionally refine cwd, env, timeout, or output-cap behavior.

*Call graph*: called by 4 (run_gh_command, run_git_command, run_probe, run_git_command); 3 external calls (from_secs, new, into_iter).


##### `WorkspaceCommand::cwd`  (lines 66–69)

```
fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self
```

**Purpose**: Adds a working-directory override to an existing command builder chain. It lets callers target a subdirectory while still relying on app-server workspace resolution rules.

**Data flow**: Takes ownership of `self` plus a value convertible to `PathBuf`, stores `Some(cwd.into())` into `self.cwd`, and returns the modified command.

**Call relations**: Called by command-building code after `WorkspaceCommand::new` when a probe must run somewhere other than the session default cwd; it does not delegate further.

*Call graph*: 1 external calls (into).


##### `WorkspaceCommand::env`  (lines 72–75)

```
fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self
```

**Purpose**: Adds or replaces a single environment override on the command. The stored representation matches app-server semantics where variables can be overridden or removed.

**Data flow**: Consumes `self`, converts `key` and `value` into owned `String`s, inserts `Some(value)` under the key in `self.env`, and returns the updated command.

**Call relations**: Used during command construction when a caller needs one-off environment customization before handing the command to a `WorkspaceCommandExecutor`.

*Call graph*: 1 external calls (into).


##### `WorkspaceCommand::timeout`  (lines 78–81)

```
fn timeout(mut self, timeout: Duration) -> Self
```

**Purpose**: Overrides the default wall-clock timeout for the command. This is how callers opt into shorter or longer execution windows than the metadata-probe default.

**Data flow**: Takes ownership of `self` and a `Duration`, writes that duration into `self.timeout`, and returns the modified command.

**Call relations**: Participates in the builder chain before execution; the stored timeout is later translated by `AppServerWorkspaceCommandRunner::run` into `timeout_ms` for the protocol request.


##### `WorkspaceCommand::disable_output_cap`  (lines 84–87)

```
fn disable_output_cap(mut self) -> Self
```

**Purpose**: Marks the command as requesting uncapped stdout/stderr capture from app-server. This is reserved for callers that own a full user-visible payload rather than a bounded background probe.

**Data flow**: Consumes `self`, sets `self.disable_output_cap = true`, and returns the updated command without changing the numeric cap field.

**Call relations**: Used by callers that need complete output; `AppServerWorkspaceCommandRunner::run` interprets this flag by omitting `output_bytes_cap` and setting `disable_output_cap` in the outgoing request.


##### `WorkspaceCommandOutput::success`  (lines 103–105)

```
fn success(&self) -> bool
```

**Purpose**: Reports whether the executed process exited with status code 0. It is a convenience predicate for callers that treat non-zero exits as ordinary command failure rather than transport failure.

**Data flow**: Reads `self.exit_code`, compares it to zero, and returns a `bool`.

**Call relations**: Called by consumers of completed command output after `run` succeeds; it has no side effects and delegates nowhere.


##### `WorkspaceCommandError::new`  (lines 118–122)

```
fn new(message: impl Into<String>) -> Self
```

**Purpose**: Creates a transport/protocol error wrapper with an owned message string. It centralizes conversion from lower-level request errors into the TUI-local error type.

**Data flow**: Accepts any value convertible to `String`, stores the converted text in `message`, and returns `WorkspaceCommandError`.

**Call relations**: Used inside `AppServerWorkspaceCommandRunner::run` when `request_typed` fails, turning app-server client errors into the module’s stable error surface.

*Call graph*: 1 external calls (into).


##### `WorkspaceCommandError::fmt`  (lines 126–128)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Implements `Display` by emitting the stored message verbatim. This makes the error printable in logs and user-facing diagnostics.

**Data flow**: Reads `self.message` and writes it into the provided formatter via `write_str`, returning the formatter result.

**Call relations**: Invoked implicitly by Rust formatting and error-reporting paths whenever a `WorkspaceCommandError` is displayed.

*Call graph*: 1 external calls (write_str).


##### `AppServerWorkspaceCommandRunner::new`  (lines 159–161)

```
fn new(request_handle: AppServerRequestHandle) -> Self
```

**Purpose**: Constructs the concrete workspace-command runner from the current session’s `AppServerRequestHandle`. The runner simply retains that handle for later one-off requests.

**Data flow**: Takes an `AppServerRequestHandle`, stores it in `request_handle`, and returns `AppServerWorkspaceCommandRunner`.

**Call relations**: Called by session setup code that wants a `WorkspaceCommandExecutor` implementation bound to the active app-server connection.

*Call graph*: called by 1 (run).


##### `AppServerWorkspaceCommandRunner::run`  (lines 170–214)

```
fn run(
        &self,
        command: WorkspaceCommand,
    ) -> Pin<
        Box<dyn Future<Output = Result<WorkspaceCommandOutput, WorkspaceCommandError>> + Send + '_>,
    >
```

**Purpose**: Executes a `WorkspaceCommand` by translating it into a one-off app-server `command/exec` request and awaiting the typed response. It enforces the module’s non-interactive policy by disabling TTY and all stdin/stdout/stderr streaming.

**Data flow**: Consumes a `WorkspaceCommand`, converts `timeout` to `i64` milliseconds with saturation fallback, converts an empty env map to `None`, builds `ClientRequest::OneOffCommandExec` with a UUID-based `RequestId`, and sends it through `self.request_handle.request_typed`. On request failure it maps the error text into `WorkspaceCommandError`; on success it transforms `CommandExecResponse { exit_code, stdout, stderr, .. }` into `WorkspaceCommandOutput` and returns it from the boxed async future.

**Call relations**: This is the trait implementation reached whenever TUI code invokes the shared runner. It is the terminal step in the local call flow: callers prepare a `WorkspaceCommand`, then `run` delegates to app-server transport and returns either normalized output or a normalized infrastructure error.

*Call graph*: calls 1 internal fn (request_typed); 4 external calls (pin, String, format!, try_from).


### Core execution foundation
These files define the shared execution request bridge and the core engine that actually launches and manages command execution.

### `core/src/exec.rs`

`domain_logic` · `request handling`

This file exists so the rest of the system can run shell commands in one consistent, controlled way. Without it, each caller would need to separately decide how to spawn processes, enforce time limits, stream output, apply sandbox rules, and interpret strange platform-specific failures.

The flow starts with an execution request: command, working folder, environment variables, timeout or cancellation rules, and sandbox permissions. The file first converts that into a concrete sandboxed request, choosing the right sandbox backend for the platform and permission profile. On Windows, that choice is especially important because different sandbox backends can enforce different kinds of filesystem restrictions.

Once the request is ready, the file launches the child process and starts reading both standard output and standard error at the same time. It can also send live output chunks as events, like a live sports ticker, while still keeping a saved copy for the final result. To protect memory, normal shell-style runs cap how much output is kept.

It also watches for expiration: a timeout, a cancellation token, or both. If the command overstays or gets cancelled, it kills the whole process group, not just the direct child, to avoid leaving orphan processes behind. Finally, it packages the result, marks timeouts clearly, and tries to detect when a failure likely came from sandbox denial rather than from the command itself.

#### Function details

##### `windows_sandbox_uses_elevated_backend`  (lines 117–125)

```
fn windows_sandbox_uses_elevated_backend(
    sandbox_level: WindowsSandboxLevel,
    proxy_enforced: bool,
) -> bool
```

**Purpose**: This decides which Windows sandbox style to use: the stronger elevated backend or the lighter restricted-token backend. It matters because some network and filesystem restrictions only work with the elevated path.

**Data flow**: It takes the requested Windows sandbox level and a yes/no flag saying whether network proxy enforcement is required. It checks those values and returns a single yes/no answer: use the elevated backend or not.

**Call relations**: When a command request is being built, this function helps choose the Windows execution path. Later, the Windows-specific runner uses the same rule again so the actual launch matches the earlier planning.

*Call graph*: called by 2 (build_exec_request, exec_windows_sandbox); 1 external calls (matches!).


##### `select_process_exec_tool_sandbox_type`  (lines 137–150)

```
fn select_process_exec_tool_sandbox_type(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    windows_sandbox_level: codex_protocol::config_
```

**Purpose**: This picks the overall sandbox type for a command, such as no sandbox, Linux seccomp, or a Windows sandbox. Someone uses it when they have permission rules and need to know what concrete isolation method should enforce them.

**Data flow**: It receives filesystem policy, network policy, Windows sandbox settings, and whether managed network enforcement is needed. It asks the sandbox manager to choose the best starting sandbox type and returns that choice.

**Call relations**: This is an early decision point inside request building. `build_exec_request` calls it before transforming a portable command description into the exact sandboxed command that will later be executed.

*Call graph*: calls 1 internal fn (new); called by 1 (build_exec_request).


##### `ExecExpiration::from`  (lines 182–184)

```
fn from(timeout_ms: u64) -> Self
```

**Purpose**: This converts an optional timeout value into the file's standard expiration format. It gives callers a simple way to say "use this many milliseconds" or "use the default timeout."

**Data flow**: It takes an optional number of milliseconds. If a value is present, it becomes a timeout duration; if not, it becomes the default-timeout variant.

**Call relations**: This is a small adapter used before the main execution flow starts. It prepares timeout information so later code like `consume_output` can wait on expiration in one uniform way.

*Call graph*: 2 external calls (from_millis, Timeout).


##### `ExecExpiration::wait_with_outcome`  (lines 189–214)

```
async fn wait_with_outcome(self) -> ExecExpirationOutcome
```

**Purpose**: This waits until a command should expire and tells you why: because time ran out or because someone cancelled it. It gives the runner one place to handle several different stop conditions.

**Data flow**: It starts from an `ExecExpiration` value. Depending on the variant, it sleeps until a timeout, waits for a cancellation token, or races both; then it returns either `TimedOut` or `Cancelled`.

**Call relations**: The output-consuming loop relies on this while the child process is running. `consume_output` waits on it alongside the child process itself so it can decide whether to let the process finish naturally or terminate it.

*Call graph*: called by 1 (consume_output); 3 external calls (from_millis, select!, sleep).


##### `ExecExpiration::timeout_ms`  (lines 217–226)

```
fn timeout_ms(&self) -> Option<u64>
```

**Purpose**: This extracts a timeout in milliseconds when one exists. It is useful for code, especially platform-specific code, that wants a plain numeric timeout instead of the richer expiration enum.

**Data flow**: It reads the current expiration setting. If that setting includes a timeout, it returns the timeout in milliseconds; if the setting is cancellation-only, it returns nothing.

**Call relations**: This supports translation work when execution settings must be passed into another layer. For example, the Windows sandbox code uses it because that backend expects timeout and cancellation as separate pieces.


##### `ExecExpiration::cancellation_token`  (lines 229–237)

```
fn cancellation_token(&self) -> Option<CancellationToken>
```

**Purpose**: This pulls out the cancellation token, if the expiration includes one. It lets other code plug cancellation into APIs that understand tokens directly.

**Data flow**: It inspects the expiration mode. If the mode includes cancellation, it returns a clone of that token; otherwise it returns nothing.

**Call relations**: This is another helper for adapting expiration settings to lower-level execution code. The Windows-specific runner uses it when passing cancellation into the Windows sandbox backend.


##### `ExecExpiration::with_cancellation`  (lines 239–260)

```
fn with_cancellation(self, cancellation: CancellationToken) -> Self
```

**Purpose**: This adds cancellation support to an existing expiration setting without losing the original timeout behavior. It is useful when one part of the system already set a timeout and another part wants to layer in a cancel button.

**Data flow**: It takes an existing expiration rule and a new cancellation token. It combines them into a new expiration value, preserving any timeout and merging cancellation tokens when needed.

**Call relations**: This helps build up execution policy before the process starts. When two different cancellation sources must both be honored, it leuses `cancel_when_either` so later waiting code only has to watch one combined signal.

*Call graph*: calls 1 internal fn (cancel_when_either); 2 external calls (from_millis, Cancellation).


##### `cancel_when_either`  (lines 263–277)

```
fn cancel_when_either(
    first: CancellationToken,
    second: CancellationToken,
) -> CancellationToken
```

**Purpose**: This creates a new cancellation token that fires when either of two input tokens fires. Think of it like wiring two emergency stop buttons into one shared stop light.

**Data flow**: It takes two cancellation tokens, creates a fresh combined token, and starts a background task that waits for either original token to be cancelled. When that happens, it cancels the combined token and returns it to the caller.

**Call relations**: This is a helper used when expiration settings are being composed. `ExecExpiration::with_cancellation` uses it so the rest of the execution flow can treat multiple cancellation sources as one.

*Call graph*: called by 2 (with_cancellation, try_run_zsh_fork); 3 external calls (new, select!, spawn).


##### `ExecCapturePolicy::retained_bytes_cap`  (lines 280–285)

```
fn retained_bytes_cap(self) -> Option<usize>
```

**Purpose**: This tells the runner how much output it is allowed to keep in memory. It prevents normal shell commands from flooding memory, while trusted internal helpers can opt into keeping everything.

**Data flow**: It reads the chosen capture policy and returns either a maximum byte count or no limit. Later output-reading code uses that answer to decide whether to trim stored output.

**Call relations**: During execution, `consume_output` asks this policy question before collecting stdout and stderr. That answer then shapes how `read_output` and output aggregation behave.

*Call graph*: called by 1 (consume_output).


##### `ExecCapturePolicy::io_drain_timeout`  (lines 287–289)

```
fn io_drain_timeout(self) -> Duration
```

**Purpose**: This provides the time limit for waiting on output-reader tasks to finish after the child exits. It exists to stop the whole agent from hanging if inherited pipes stay open unexpectedly.

**Data flow**: It takes the capture policy and returns a fixed drain timeout duration. The execution code then uses that duration when waiting for stdout and stderr collection to wrap up.

**Call relations**: After process termination, `consume_output` uses this value to guard the final output-draining step. If output readers do not finish in time, they are aborted instead of blocking forever.

*Call graph*: called by 1 (consume_output); 1 external calls (from_millis).


##### `ExecCapturePolicy::uses_expiration`  (lines 291–296)

```
fn uses_expiration(self) -> bool
```

**Purpose**: This says whether timeouts and cancellations should apply for the current capture mode. Normal shell-style commands use expiration, but full-buffer internal helpers intentionally skip that behavior.

**Data flow**: It examines the capture policy and returns a yes/no answer. The rest of the runner uses that answer to decide whether to wait on expiration at all.

**Call relations**: This affects both generic execution and Windows sandbox execution. `consume_output` uses it to decide whether to race the child against timeout or cancellation, and the Windows path uses the same idea when passing timeout settings to its backend.

*Call graph*: called by 1 (consume_output).


##### `process_exec_tool_call`  (lines 307–327)

```
async fn process_exec_tool_call(
    params: ExecParams,
    permission_profile: &PermissionProfile,
    sandbox_cwd: &AbsolutePathBuf,
    windows_sandbox_workspace_roots: &[AbsolutePathBuf],
    cod
```

**Purpose**: This is the main public path for "run this exec tool request." It converts user-facing parameters into a full execution request and then sends that request through the shared sandboxed execution pipeline.

**Data flow**: It takes execution parameters, permission information, sandbox-related paths and options, and an optional live-output stream. It builds an `ExecRequest`, passes it to the sandboxing module's executor, and returns the final command output or an error.

**Call relations**: Other parts of the system call this when they want a command run under the project's standard safety rules. It stands at the doorway: first `build_exec_request`, then the sandboxing module's unified executor.

*Call graph*: calls 2 internal fn (build_exec_request, execute_env); called by 5 (run_test_cmd, windows_elevated_enforces_deny_read_and_protects_setup_marker, windows_restricted_token_rejects_exact_and_glob_deny_read_policy, assert_network_blocked, run_cmd_result_with_permission_profile_for_cwd).


##### `build_exec_request`  (lines 331–438)

```
fn build_exec_request(
    params: ExecParams,
    permission_profile: &PermissionProfile,
    sandbox_cwd: &AbsolutePathBuf,
    windows_sandbox_workspace_roots: &[AbsolutePathBuf],
    codex_linux_s
```

**Purpose**: This turns a portable, high-level command request into the exact sandboxed request the runtime can execute. It is where permission profiles, network settings, working directories, and platform quirks get translated into concrete execution instructions.

**Data flow**: It starts with `ExecParams`, permission profile information, and sandbox path settings. It picks a sandbox type, applies network-related environment variables, converts paths into URI-style forms for sandbox rules, asks the sandbox manager to transform the command, computes Windows filesystem override details if needed, and returns a complete `ExecRequest`.

**Call relations**: This is the planning stage before any process is launched. `process_exec_tool_call` and other setup code call it first, and the resulting request later flows into `execute_exec_request` or the sandboxing module's execution entry point.

*Call graph*: calls 7 internal fn (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides, select_process_exec_tool_sandbox_type, windows_sandbox_uses_elevated_backend, to_runtime_permissions, new, from_abs_path); called by 2 (exec_one_off_command_inner, process_exec_tool_call); 1 external calls (debug!).


##### `execute_exec_request`  (lines 440–494)

```
async fn execute_exec_request(
    exec_request: ExecRequest,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
) -> Result<ExecToolCallOutput>
```

**Purpose**: This takes a ready-to-run `ExecRequest`, actually runs it, times how long it took, and converts low-level output into the final user-facing result. It is the bridge between setup and completion.

**Data flow**: It receives a fully built execution request, optional live output stream, and an optional callback to run just after spawning. It extracts the needed pieces, calls the lower-level runner to get raw output, measures elapsed time, then passes everything to result finalization and returns the finished `ExecToolCallOutput` or an error.

**Call relations**: This sits in the middle of the execution pipeline. Higher-level orchestration like `execute_env` calls it, it delegates actual process running to `get_raw_output_result`, and then hands the raw result to `finalize_exec_result`.

*Call graph*: calls 2 internal fn (finalize_exec_result, get_raw_output_result); called by 3 (execute_env, execute_exec_request_with_after_spawn, execute_user_shell_command); 1 external calls (now).


##### `get_raw_output_result`  (lines 497–524)

```
async fn get_raw_output_result(
    params: ExecParams,
    network_sandbox_policy: NetworkSandboxPolicy,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
```

**Purpose**: This chooses the actual execution engine for the request: the normal async process runner or the special Windows sandbox runner. It hides that platform split from the rest of the code.

**Data flow**: It takes execution parameters and surrounding sandbox context. On Windows restricted-token sandbox runs, it calls the Windows-specific execution path; otherwise it calls the general `exec` function and returns the raw output result.

**Call relations**: `execute_exec_request` relies on this as the fork in the road between platform-specific and generic execution. The caller does not need to know which branch was used; both return the same raw-output shape.

*Call graph*: calls 2 internal fn (exec, exec_windows_sandbox); called by 1 (execute_exec_request).


##### `extract_create_process_as_user_error_code`  (lines 527–537)

```
fn extract_create_process_as_user_error_code(err: &str) -> Option<String>
```

**Purpose**: This pulls a Windows error code out of a specific spawn-failure message. It is used for diagnostics so failures can be counted and grouped by the underlying OS error.

**Data flow**: It takes an error string, looks for the known `CreateProcessAsUserW failed:` marker, reads the digits that follow it, and returns that code if found.

**Call relations**: This is a small parsing helper for Windows telemetry. When Windows sandbox process creation fails, `record_windows_sandbox_spawn_failure` uses it to add a useful error-code label to metrics.

*Call graph*: called by 1 (record_windows_sandbox_spawn_failure).


##### `windowsapps_path_kind`  (lines 540–552)

```
fn windowsapps_path_kind(path: &str) -> &'static str
```

**Purpose**: This classifies a Windows executable path into broad WindowsApps categories. The goal is to make failure metrics easier to understand by separating packaged apps, aliases, and everything else.

**Data flow**: It takes a path string, lowercases it, checks for known WindowsApps path patterns, and returns a category label such as package, alias, other WindowsApps, or other.

**Call relations**: This supports Windows failure reporting rather than execution itself. `record_windows_sandbox_spawn_failure` calls it to tag metrics with the kind of executable path that failed.

*Call graph*: called by 1 (record_windows_sandbox_spawn_failure).


##### `record_windows_sandbox_spawn_failure`  (lines 555–590)

```
fn record_windows_sandbox_spawn_failure(
    command_path: Option<&str>,
    windows_sandbox_level: codex_protocol::config_types::WindowsSandboxLevel,
    err: &str,
)
```

**Purpose**: This logs structured metrics when Windows sandbox process creation fails. It helps operators see patterns, such as certain error codes or app path types failing more often.

**Data flow**: It takes the command path, the Windows sandbox level, and an error string. It extracts a specific OS error code, derives labels like executable name and path kind, chooses a level label, and sends a counter metric if telemetry is available.

**Call relations**: This is part of the Windows error path. `exec_windows_sandbox` calls it only when spawning the sandboxed process fails, before returning an error up the stack.

*Call graph*: calls 2 internal fn (extract_create_process_as_user_error_code, windowsapps_path_kind); called by 1 (exec_windows_sandbox); 3 external calls (new, global, matches!).


##### `exec_windows_sandbox`  (lines 593–747)

```
async fn exec_windows_sandbox(
    params: ExecParams,
    permission_profile: &PermissionProfile,
    windows_sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_workspace_roots: &[AbsolutePath
```

**Purpose**: This runs a command through the dedicated Windows sandbox implementation and converts that backend's capture result into the same raw output format used elsewhere. It exists because Windows sandboxing needs very different plumbing than ordinary child-process spawning.

**Data flow**: It takes execution parameters, permission profile data, Windows sandbox path information, and optional filesystem overrides. It applies network environment changes, separates timeout and cancellation if needed, chooses elevated or unelevated backend, runs the sandbox capture in a blocking worker thread, turns backend results into exit status plus stdout/stderr text, applies output caps if necessary, aggregates combined output, and returns the raw result.

**Call relations**: This is the Windows-specific execution branch selected by `get_raw_output_result`. If spawning fails, it reports telemetry through `record_windows_sandbox_spawn_failure`; if it succeeds, its output is later interpreted by `finalize_exec_result` just like output from the generic runner.

*Call graph*: calls 4 internal fn (aggregate_output, record_windows_sandbox_spawn_failure, synthetic_exit_status, windows_sandbox_uses_elevated_backend); called by 1 (get_raw_output_result); 8 external calls (other, format!, Io, clone, spawn_blocking, is_empty, to_vec, vec!).


##### `finalize_exec_result`  (lines 749–807)

```
fn finalize_exec_result(
    raw_output_result: std::result::Result<RawExecToolCallOutput, CodexErr>,
    sandbox_type: SandboxType,
    duration: Duration,
) -> Result<ExecToolCallOutput>
```

**Purpose**: This turns low-level execution output into the final result or error the rest of the system sees. It is where raw exit status gets interpreted into clearer meanings like timeout, signal failure, sandbox denial, or success.

**Data flow**: It takes either a raw output record or an execution error, along with the sandbox type and the run duration. If raw output exists, it adjusts timeout state, interprets Unix signals, picks a final exit code, converts bytes to text, builds `ExecToolCallOutput`, and may return special sandbox errors for timeouts or likely denials; otherwise it logs and returns the original error.

**Call relations**: This is the last processing step after actual command execution. `execute_exec_request` feeds it the result from `get_raw_output_result`, and callers above receive its polished success value or categorized error.

*Call graph*: calls 1 internal fn (is_likely_sandbox_denied); called by 1 (execute_exec_request); 4 external calls (new, Sandbox, Signal, error!).


##### `is_likely_sandbox_denied`  (lines 814–869)

```
fn is_likely_sandbox_denied(
    sandbox_type: SandboxType,
    exec_output: &ExecToolCallOutput,
) -> bool
```

**Purpose**: This makes an educated guess about whether a failed command was blocked by sandbox rules. Because the operating system does not always label sandbox failures cleanly, this heuristic fills in that gap.

**Data flow**: It takes the sandbox type and the finished execution output. It quickly rules out obvious non-cases, scans stdout, stderr, and combined output for denial-related phrases, checks a few exit-code exceptions, and on Unix also recognizes a seccomp-related signal-based failure pattern; then it returns true or false.

**Call relations**: This is used during result interpretation rather than process launching. `finalize_exec_result` calls it before deciding whether to return a normal failed command output or a stronger sandbox-denied error.

*Call graph*: called by 4 (finalize_exec_result, run, map_exec_result, check_for_sandbox_denial_with_text).


##### `append_capped`  (lines 881–888)

```
fn append_capped(dst: &mut Vec<u8>, src: &[u8], max_bytes: usize)
```

**Purpose**: This safely appends bytes into a buffer without letting the buffer grow past a configured limit. It is the small guardrail that prevents runaway output from filling memory.

**Data flow**: It takes a destination byte buffer, a source byte slice, and a maximum size. It figures out how many bytes still fit, copies only that portion from the source, and leaves the rest behind.

**Call relations**: This helper is used inside the output-reading loop. `read_output` calls it whenever output retention is capped, while still continuing to read to the end of the stream to avoid blocking the child process.

*Call graph*: called by 1 (read_output).


##### `aggregate_output`  (lines 890–932)

```
fn aggregate_output(
    stdout: &StreamOutput<Vec<u8>>,
    stderr: &StreamOutput<Vec<u8>>,
    max_bytes: Option<usize>,
) -> StreamOutput<Vec<u8>>
```

**Purpose**: This builds the combined output text from stdout and stderr. It gives callers one merged view while still respecting memory caps.

**Data flow**: It takes captured stdout, captured stderr, and an optional maximum byte count. If there is no cap, it concatenates both completely; if there is a cap, it keeps as much as possible while trying to reserve space fairly between stdout and stderr, then returns the merged stream output.

**Call relations**: Both the generic runner and the Windows runner use this after separate stdout and stderr capture is done. The merged output then becomes part of the final exec result returned to higher layers.

*Call graph*: called by 2 (consume_output, exec_windows_sandbox); 1 external calls (with_capacity).


##### `exec`  (lines 946–998)

```
async fn exec(
    params: ExecParams,
    network_sandbox_policy: NetworkSandboxPolicy,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
) -> Result<RawExec
```

**Purpose**: This is the normal cross-platform path for launching a child process and collecting its output, without adding sandbox wrappers itself. It is useful when the command has already been transformed upstream into the right sandboxed or unsandboxed form.

**Data flow**: It takes execution parameters, a network sandbox policy, an optional live-output stream, and an optional callback. It applies network environment changes, validates the command, spawns the child with redirected stdout and stderr, runs the callback after spawning if present, then hands the child to `consume_output` and returns the raw output result.

**Call relations**: This is the generic execution branch chosen by `get_raw_output_result` when the special Windows backend is not required. It launches the process, then delegates all waiting, timeout handling, cancellation, and output collection to `consume_output`.

*Call graph*: calls 2 internal fn (consume_output, spawn_child_async); called by 1 (get_raw_output_result); 1 external calls (from).


##### `permission_profile_supports_windows_restricted_token_sandbox`  (lines 1001–1010)

```
fn permission_profile_supports_windows_restricted_token_sandbox(
    permission_profile: &PermissionProfile,
) -> bool
```

**Purpose**: This checks whether a permission profile can realistically be enforced by the Windows restricted-token sandbox backend. It prevents the system from pretending a weak backend can enforce rules it actually cannot.

**Data flow**: It takes a permission profile and inspects its filesystem settings. It returns true only for managed profiles without full disk write access; disabled or external profiles return false.

**Call relations**: This is a capability check used during Windows sandbox planning. Both Windows override-resolution functions call it before deciding whether the request can safely use that backend or must be rejected.

*Call graph*: called by 2 (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `unsupported_windows_restricted_token_sandbox_reason`  (lines 1013–1036)

```
fn unsupported_windows_restricted_token_sandbox_reason(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_level: Windo
```

**Purpose**: This explains why a requested Windows sandbox setup cannot be safely supported. Instead of silently falling back to weaker behavior, it returns a human-readable reason.

**Data flow**: It takes the sandbox type, permission profile, sandbox working directory, and Windows sandbox level. Depending on whether elevated mode is requested, it runs the corresponding override-resolution logic and returns any error message that logic produces.

**Call relations**: This is mainly a diagnostic wrapper around the deeper Windows-policy checks. Callers use it when they need to surface or test the reason a sandbox configuration would be refused.

*Call graph*: calls 2 internal fn (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `resolve_windows_restricted_token_filesystem_overrides`  (lines 1038–1172)

```
fn resolve_windows_restricted_token_filesystem_overrides(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_level: Win
```

**Purpose**: This figures out whether the Windows restricted-token backend needs extra filesystem deny rules, and whether the requested policy is even enforceable there. Its main job is to stop unsafe silent fallback when the backend cannot truly honor the requested read or write restrictions.

**Data flow**: It takes the chosen sandbox type, permission profile, sandbox working directory, and Windows sandbox level. It first exits early when the restricted-token path does not apply; otherwise it compares the requested policy with what that backend can enforce, checks root read access and deny-read cases, compares legacy and split writable roots, computes any extra deny-write carveouts that must be layered on, and returns either no overrides, concrete override data, or a refusal message.

**Call relations**: This is part of request construction on Windows. `build_exec_request` calls it when using the unelevated backend, and the diagnostic helper `unsupported_windows_restricted_token_sandbox_reason` uses the same logic to explain rejections.

*Call graph*: calls 6 internal fn (normalize_windows_override_path, permission_profile_display_name, permission_profile_supports_windows_restricted_token_sandbox, windows_policy_has_root_read_access, to_runtime_permissions, as_path); called by 2 (build_exec_request, unsupported_windows_restricted_token_sandbox_reason); 4 external calls (new, compatibility_sandbox_policy_for_permission_profile, resolve_windows_deny_read_paths, format!).


##### `normalize_windows_override_path`  (lines 1174–1178)

```
fn normalize_windows_override_path(path: &Path) -> std::result::Result<PathBuf, String>
```

**Purpose**: This cleans up a Windows path into a normalized absolute form suitable for comparing override rules. That avoids mismatches caused by superficial path differences.

**Data flow**: It takes a path, simplifies it, validates that it is absolute, and returns the normalized path buffer or an error string.

**Call relations**: This is a helper used while computing Windows filesystem overrides. The restricted-token override resolver calls it repeatedly so path comparisons are consistent.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (resolve_windows_restricted_token_filesystem_overrides); 1 external calls (simplified).


##### `windows_policy_has_root_read_access`  (lines 1180–1188)

```
fn windows_policy_has_root_read_access(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> bool
```

**Purpose**: This checks whether the filesystem policy allows reading from the drive or filesystem root that contains the current working directory. That matters because some Windows sandbox strategies can only work if root-level read access remains available.

**Data flow**: It takes a filesystem sandbox policy and the current working directory. It finds the topmost ancestor of that directory, asks the policy whether that root can be read, and returns true or false.

**Call relations**: The Windows override resolvers use this as a key capability test. If root read access is missing, the restricted-token backend cannot safely enforce some policies and the elevated path may need explicit read-root overrides.

*Call graph*: calls 2 internal fn (can_read_path_with_cwd, as_path); called by 2 (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `resolve_windows_elevated_filesystem_overrides`  (lines 1190–1317)

```
fn resolve_windows_elevated_filesystem_overrides(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    use_windows_elevated_backend: bool
```

**Purpose**: This computes the extra filesystem rules needed when Windows uses the elevated sandbox backend. It works out explicit readable roots, writable roots, and extra deny paths so the elevated setup matches the requested permission profile as closely as possible.

**Data flow**: It takes the sandbox type, permission profile, sandbox working directory, and a flag saying whether the elevated backend is in use. If the path does not apply it returns none; otherwise it validates backend support, computes deny-read paths, checks for unsupported writable-descendant reopen cases, compares requested read and write roots against the legacy baseline, derives read-root and write-root overrides plus any additional deny-write paths, and returns either no override, concrete override data, or an error message.

**Call relations**: This is the elevated counterpart to the restricted-token override resolver. `build_exec_request` uses it when the elevated backend is selected, and diagnostic code reuses it to explain unsupported configurations.

*Call graph*: calls 6 internal fn (has_reopened_writable_descendant, permission_profile_display_name, permission_profile_supports_windows_restricted_token_sandbox, windows_policy_has_root_read_access, to_runtime_permissions, as_path); called by 2 (build_exec_request, unsupported_windows_restricted_token_sandbox_reason); 5 external calls (new, new, compatibility_sandbox_policy_for_permission_profile, resolve_windows_deny_read_paths, format!).


##### `permission_profile_display_name`  (lines 1319–1325)

```
fn permission_profile_display_name(permission_profile: &PermissionProfile) -> &'static str
```

**Purpose**: This returns a simple display name for a permission profile variant. It exists mainly to make error messages easier for humans to read.

**Data flow**: It takes a permission profile enum and maps it to a short fixed label such as Managed, Disabled, or External.

**Call relations**: The Windows override-resolution functions use this when constructing refusal messages, so unsupported-policy errors include a clearer profile name.

*Call graph*: called by 2 (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `has_reopened_writable_descendant`  (lines 1327–1344)

```
fn has_reopened_writable_descendant(
    writable_roots: &[codex_protocol::protocol::WritableRoot],
) -> bool
```

**Purpose**: This checks for a tricky and unsupported filesystem rule shape: making a subpath read-only and then trying to reopen a deeper path under it as writable. That kind of policy is too complex for the elevated Windows backend to enforce directly.

**Data flow**: It takes the list of writable roots and their read-only carveouts. It searches for any writable root that sits underneath another root's read-only subpath and returns true if it finds one.

**Call relations**: This is a safety check used only during elevated Windows override computation. `resolve_windows_elevated_filesystem_overrides` calls it before accepting the requested policy.

*Call graph*: called by 1 (resolve_windows_elevated_filesystem_overrides); 1 external calls (iter).


##### `consume_output`  (lines 1348–1485)

```
async fn consume_output(
    mut child: Child,
    expiration: ExecExpiration,
    capture_policy: ExecCapturePolicy,
    stdout_stream: Option<StdoutStream>,
) -> Result<RawExecToolCallOutput>
```

**Purpose**: This is the heart of live process supervision. It waits for a child process, reads stdout and stderr in parallel, enforces timeout or cancellation rules, kills lingering process groups when necessary, and returns the captured output.

**Data flow**: It starts with a running child process, expiration settings, capture policy, and optional live-output stream. It takes the child's stdout and stderr pipes, starts background readers for both, races process completion against timeout, cancellation, and Ctrl+C, kills the process group if needed, waits a limited time for output readers to finish, aggregates stdout and stderr, and returns the raw execution result with exit status and timeout flag.

**Call relations**: This runs immediately after `exec` spawns a child. It relies on `read_output` for stream reading, `ExecExpiration::wait_with_outcome` for stop conditions, and `aggregate_output` for the final merged text.

*Call graph*: calls 6 internal fn (io_drain_timeout, retained_bytes_cap, uses_expiration, wait_with_outcome, aggregate_output, read_output); called by 1 (exec); 4 external calls (new, pin!, select!, spawn).


##### `read_output`  (lines 1487–1541)

```
async fn read_output(
    mut reader: R,
    stream: Option<StdoutStream>,
    is_stderr: bool,
    max_bytes: Option<usize>,
) -> io::Result<StreamOutput<Vec<u8>>>
```

**Purpose**: This reads one output stream from a child process until end-of-file, optionally sends live chunks as events, and stores a capped or uncapped copy in memory. It keeps reading even after the memory cap is reached so the child does not get blocked by a full pipe.

**Data flow**: It takes an async reader, an optional event stream target, a flag saying whether this is stderr, and an optional max byte count. In a loop it reads chunks, emits live delta events up to a per-call limit, appends bytes to the retained buffer with or without a cap, continues until the stream closes, and returns the captured stream output.

**Call relations**: `consume_output` spawns this twice: once for stdout and once for stderr. The live chunks it emits feed subscribers in real time, while its final buffer feeds the combined result shown after command completion.

*Call graph*: calls 1 internal fn (append_capped); called by 1 (consume_output); 3 external calls (read, with_capacity, ExecCommandOutputDelta).


##### `synthetic_exit_status`  (lines 1556–1561)

```
fn synthetic_exit_status(code: i32) -> ExitStatus
```

**Purpose**: This creates an `ExitStatus` object from a raw numeric code. It is needed when the runner has to invent a status itself, such as for timeout handling, instead of receiving one from the OS directly.

**Data flow**: It takes an integer code and converts it into an `ExitStatus` using the platform-specific raw representation. The result can then be processed like a normal child-process exit status.

**Call relations**: The Windows sandbox path uses this when its backend reports only a plain exit code. The timeout and synthetic-status helpers also rely on this idea so later result processing can stay uniform.

*Call graph*: called by 2 (exec_windows_sandbox, synthetic_exit_status_for_code); 1 external calls (from_raw).


##### `synthetic_exit_status_for_code`  (lines 1564–1566)

```
fn synthetic_exit_status_for_code(code: i32) -> ExitStatus
```

**Purpose**: This creates a synthetic exit status specifically from a conventional exit code value, taking platform encoding differences into account. It lets cancellation or other forced exits be represented as if a process had returned that code normally.

**Data flow**: It takes an exit code integer, converts it into the right raw form for the current platform, and returns an `ExitStatus` object.

**Call relations**: This is used inside process supervision when the code needs to fabricate a clean non-signal exit, such as on cancellation. It complements `synthetic_exit_status`, which is used for other raw-status cases.

*Call graph*: calls 1 internal fn (synthetic_exit_status); 1 external calls (from_raw).


### `core/src/sandboxing/mod.rs`

`orchestration` · `request handling`

This module is a thin integration layer between the `codex_sandboxing` crate and core execution code. Its central type is `ExecRequest`, a rich struct carrying the command vector, working directory, environment map, optional exec-server environment policy, optional `NetworkProxy`, expiration and capture settings, selected `SandboxType`, Windows sandbox metadata, the original `PermissionProfile`, derived runtime filesystem and network sandbox policies, optional filesystem overrides, and an optional `arg0`. `ExecRequest::new` is the direct constructor used by tests and callers that already know the sandbox type; it clones `cwd` into `windows_sandbox_policy_cwd` and derives `file_system_sandbox_policy` plus `network_sandbox_policy` from `permission_profile.to_runtime_permissions()`, ensuring the profile and runtime policies stay aligned at construction time. `ExecRequest::from_sandbox_exec_request` performs the inverse adaptation from a `SandboxExecRequest` produced by sandbox planning. It destructures the sandbox-layer request, injects `CODEX_SANDBOX_NETWORK_DISABLED_ENV_VAR=1` when network access is not enabled, and on macOS additionally marks seatbelt execution with `CODEX_SANDBOX_ENV_VAR=seatbelt`. The two async free functions are simple wrappers around `execute_exec_request`: `execute_env` always passes no after-spawn hook, while `execute_exec_request_with_after_spawn` exposes that hook for callers that need post-spawn coordination. The design keeps sandbox transformation logic out of core while making execution semantics explicit and testable.

#### Function details

##### `ExecRequest::new`  (lines 65–101)

```
fn new(
        command: Vec<String>,
        cwd: AbsolutePathBuf,
        env: HashMap<String, String>,
        network: Option<NetworkProxy>,
        expiration: ExecExpiration,
        capture_pol
```

**Purpose**: Constructs a fully populated `ExecRequest` from caller-supplied execution metadata and a high-level permission profile.

**Data flow**: Consumes command arguments, cwd, environment variables, optional network proxy, expiration, capture policy, sandbox type, Windows workspace roots and level flags, a `PermissionProfile`, and optional `arg0`. It clones `cwd` into `windows_sandbox_policy_cwd`, derives `(file_system_sandbox_policy, network_sandbox_policy)` via `permission_profile.to_runtime_permissions()`, initializes optional fields like `exec_server_env_config` and `windows_sandbox_filesystem_overrides` to `None`, and returns the assembled `ExecRequest`.

**Call relations**: This constructor is used by tests and Windows sandbox request builders when core code originates an exec directly. It does not delegate to sandbox planning; instead it normalizes the profile into runtime policies up front so downstream execution code can rely on both representations being present.

*Call graph*: calls 1 internal fn (to_runtime_permissions); called by 4 (cancellation_expiration_keeps_process_alive_until_terminated, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_exec_request, test_exec_request); 1 external calls (clone).


##### `ExecRequest::from_sandbox_exec_request`  (lines 103–155)

```
fn from_sandbox_exec_request(
        request: SandboxExecRequest,
        options: ExecOptions,
        windows_sandbox_workspace_roots: Vec<AbsolutePathBuf>,
    ) -> Self
```

**Purpose**: Adapts a `SandboxExecRequest` emitted by sandbox-planning code into the core `ExecRequest` shape used for actual process execution.

**Data flow**: Takes a `SandboxExecRequest`, `ExecOptions`, and Windows workspace roots. It destructures the sandbox request into command, cwd, sandbox-policy cwd, mutable env, network, sandbox type, Windows flags, permission profile, runtime filesystem/network policies, and `arg0`; extracts expiration and capture policy from `ExecOptions`; conditionally inserts the network-disabled environment variable when `network_sandbox_policy.is_enabled()` is false; on macOS conditionally inserts the seatbelt marker env var when the sandbox type is `MacosSeatbelt`; then returns a new `ExecRequest` with optional fields initialized to `None`.

**Call relations**: Called from sandbox preparation paths such as `prepare_sandboxed_exec` and environment-building helpers after the sandbox crate has already transformed the command. Its role is to preserve sandbox decisions while adding core-specific execution options and environment markers needed by spawned processes.

*Call graph*: called by 2 (prepare_sandboxed_exec, env_for).


##### `execute_env`  (lines 158–163)

```
async fn execute_env(
    exec_request: ExecRequest,
    stdout_stream: Option<StdoutStream>,
) -> codex_protocol::error::Result<ExecToolCallOutput>
```

**Purpose**: Runs an `ExecRequest` through the shared execution engine without any post-spawn callback.

**Data flow**: Consumes an `ExecRequest` and optional `StdoutStream`, forwards them to `execute_exec_request` with `after_spawn` set to `None`, awaits the future, and returns the resulting `ExecToolCallOutput` or protocol error.

**Call relations**: This is the common convenience entry used by startup, tool-call processing, and runtime execution flows that just need to execute a prepared request. It delegates all real spawning and capture behavior to `execute_exec_request`.

*Call graph*: calls 1 internal fn (execute_exec_request); called by 3 (start, process_exec_tool_call, run).


##### `execute_exec_request_with_after_spawn`  (lines 165–171)

```
async fn execute_exec_request_with_after_spawn(
    exec_request: ExecRequest,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
) -> codex_protocol::error::R
```

**Purpose**: Runs an `ExecRequest` while allowing the caller to supply a one-shot callback invoked after process spawn.

**Data flow**: Consumes an `ExecRequest`, optional `StdoutStream`, and an optional boxed `FnOnce() + Send` callback; forwards all three to `execute_exec_request`; awaits completion; and returns the resulting `ExecToolCallOutput` or error.

**Call relations**: Used by runtime paths that need extra coordination immediately after spawn, such as notifying another subsystem or unblocking a waiter. It is a thin wrapper over the same execution backend as `execute_env`, differing only in exposing the callback parameter.

*Call graph*: calls 1 internal fn (execute_exec_request); called by 1 (run).


### Shell task and shared shell orchestration
These files cover the direct user shell task plus the common handler and runtime path used to turn shell-like tool requests into approved executions.

### `core/src/tasks/user_shell.rs`

`domain_logic` · `user shell command execution during a turn or standalone shell turn`

This module defines `UserShellCommandTask` plus the shared `execute_user_shell_command` routine used to run shell commands either as a standalone turn or as auxiliary work inside an already active turn. `UserShellCommandMode` controls whether `TurnStarted` should be emitted and whether output is recorded as a new standalone rollout item or injected into the current turn without creating a new turn boundary.

`execute_user_shell_command` begins by incrementing a telemetry counter and, in `StandaloneTurn` mode, sending `TurnStarted` using the current turn timing and collaboration metadata. It then resolves the local environment and shell from `turn_context.environments.local()`. Missing shell support or a non-native working directory are surfaced immediately via `send_user_shell_error`. For valid environments, it derives shell exec args from the raw command using a login shell, computes the shell snapshot path, builds an environment map with `create_env`, strips any managed proxy marker (`PROXY_ACTIVE_ENV_KEY`) so `/shell` acts as an explicit full-access escape hatch, and rewrites the command through `prepare_user_shell_exec_command`. On Unix, that helper preserves runtime-owned PATH prepends even when replaying a shell snapshot by tracking `RuntimePathPrepends` separately.

The function emits `ExecCommandBegin`, constructs an unrestricted `ExecRequest` (`SandboxType::None`, `network: None`, `PermissionProfile::Disabled`, one-hour expiration), and runs it through `execute_exec_request` with a `StdoutStream` so stdout can stream as events. The result is wrapped with `or_cancel(&cancellation_token)`, producing three branches: cancellation synthesizes an aborted `ExecToolCallOutput`; successful execution emits `ExecCommandEnd` with formatted output and completed/failed status based on exit code; execution errors log via `tracing::error`, synthesize a failure output, and still emit `ExecCommandEnd`. All branches persist output through `persist_user_shell_output`, which records a conversation item and materializes rollout for standalone shell turns, or injects the item into the active turn in auxiliary mode.

#### Function details

##### `UserShellCommandTask::new`  (lines 65–67)

```
fn new(command: String) -> Self
```

**Purpose**: Constructs a shell-command task carrying the raw command string to execute.

**Data flow**: Consumes `command: String`, stores it in `UserShellCommandTask { command }`, and returns the task.

**Call relations**: Higher-level shell command dispatch creates this task before spawning it through the session task framework.

*Call graph*: called by 1 (run_user_shell_command).


##### `UserShellCommandTask::kind`  (lines 71–73)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Classifies user shell execution as a regular task kind for session bookkeeping.

**Data flow**: Reads `self` and returns `TaskKind::Regular`.

**Call relations**: The task framework queries this when storing and tracing the running task.


##### `UserShellCommandTask::span_name`  (lines 75–77)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Supplies the tracing span name for spawned shell tasks.

**Data flow**: Reads `self` and returns `"session_task.user_shell"`.

**Call relations**: Task startup uses this to name the outer tracing span.


##### `UserShellCommandTask::run`  (lines 79–95)

```
async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        turn_context: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
```

**Purpose**: Delegates task execution to the shared shell-command runner in standalone-turn mode.

**Data flow**: Consumes the task `Arc`, task context, turn context, ignores the input vector, clones the stored command string, and calls `execute_user_shell_command` with the cloned session, turn context, command, cancellation token, and `UserShellCommandMode::StandaloneTurn`. It returns `None`.

**Call relations**: The generic task runner invokes this when a `/shell` task is spawned. All substantive work is delegated to `execute_user_shell_command`.

*Call graph*: calls 1 internal fn (execute_user_shell_command).


##### `execute_user_shell_command`  (lines 98–358)

```
async fn execute_user_shell_command(
    session: Arc<Session>,
    turn_context: Arc<TurnContext>,
    command: String,
    cancellation_token: CancellationToken,
    mode: UserShellCommandMode,
)
```

**Purpose**: Runs a user shell command end-to-end: validates shell availability, prepares environment and command wrapping, emits execution lifecycle events, executes the process with cancellation support, and persists the output.

**Data flow**: Consumes `Arc<Session>`, `Arc<TurnContext>`, raw `command`, a `CancellationToken`, and execution `mode`. It increments telemetry, optionally sends `TurnStarted`, resolves the local shell environment and cwd, builds `display_command`, shell snapshot path, and mutable env map via `create_env`, strips managed proxy env, rewrites the command with `prepare_user_shell_exec_command`, generates a UUID call id, parses the display command, emits `ExecCommandBegin`, constructs an `ExecRequest` with no sandbox and no managed network, and executes it with `execute_exec_request(...).or_cancel(&cancellation_token)`. On cancellation it synthesizes an aborted `ExecToolCallOutput`, persists it, and emits failed `ExecCommandEnd`; on success it emits `ExecCommandEnd` with captured stdout/stderr/aggregated output, formatted output, duration, and status based on exit code, then persists the real output; on execution error it logs, synthesizes a failure output, emits failed `ExecCommandEnd`, and persists that output. It returns `()`.

**Call relations**: This is called by `UserShellCommandTask::run` and can also support auxiliary shell execution flows. It delegates environment creation, command rewriting, process execution, output formatting, error reporting, and persistence to specialized helpers.

*Call graph*: calls 10 internal fn (execute_exec_request, create_env, persist_user_shell_output, prepare_user_shell_exec_command, send_user_shell_error, format_exec_output_str, strip_managed_proxy_env, now_unix_timestamp_ms, new, parse_command); called by 1 (run); 7 external calls (new, new_v4, error!, format!, ExecCommandBegin, ExecCommandEnd, TurnStarted).


##### `send_user_shell_error`  (lines 360–370)

```
async fn send_user_shell_error(session: &Session, turn_context: &TurnContext, message: &str)
```

**Purpose**: Sends a protocol `Error` event for shell setup failures before any process is launched.

**Data flow**: Consumes a borrowed `Session`, `TurnContext`, and error message string slice. It wraps the message in `EventMsg::Error(ErrorEvent { message, codex_error_info: None })`, sends it through `session.send_event`, and returns `()`.

**Call relations**: `execute_user_shell_command` uses this for early failures such as missing shell support or an unusable working directory. It isolates the exact error-event shape.

*Call graph*: called by 1 (execute_user_shell_command); 2 external calls (send_event, Error).


##### `prepare_user_shell_exec_command`  (lines 372–405)

```
fn prepare_user_shell_exec_command(
    display_command: &[String],
    shell: &Shell,
    shell_snapshot: Option<&AbsolutePathBuf>,
    shell_environment_set: &HashMap<String, String>,
    exec_env_m
```

**Purpose**: Builds the final argv used to execute the shell command, including optional shell-snapshot replay and runtime PATH preservation across platforms.

**Data flow**: Consumes the derived `display_command`, selected `Shell`, optional shell snapshot path, explicit shell environment overrides, and mutable exec env map. On Unix it forwards to `prepare_user_shell_exec_command_with_path_prepend`; on non-Unix it calls `maybe_wrap_shell_lc_with_snapshot` directly with a default `RuntimePathPrepends`. It returns the rewritten `Vec<String>` command argv.

**Call relations**: The main shell execution path calls this after constructing the environment map. It delegates platform-specific PATH-prepend handling to the Unix-only helper or directly to snapshot wrapping.

*Call graph*: calls 2 internal fn (prepare_user_shell_exec_command_with_path_prepend, maybe_wrap_shell_lc_with_snapshot); called by 1 (execute_user_shell_command); 1 external calls (default).


##### `prepare_user_shell_exec_command_with_path_prepend`  (lines 413–432)

```
fn prepare_user_shell_exec_command_with_path_prepend(
    display_command: &[String],
    shell: &Shell,
    shell_snapshot: Option<&AbsolutePathBuf>,
    shell_environment_set: &HashMap<String, Strin
```

**Purpose**: Unix-specific command preparation that preserves runtime-owned PATH prepends even when a shell snapshot restores the user's PATH.

**Data flow**: Consumes the display command, shell, optional snapshot path, explicit shell environment map, mutable exec env map, and a callback that prepends runtime PATH entries while recording them in `RuntimePathPrepends`. It clones explicit env overrides, initializes `RuntimePathPrepends::default()`, invokes the callback to mutate `exec_env_map` and record prepends, then calls `maybe_wrap_shell_lc_with_snapshot` with both the explicit overrides and recorded runtime prepends, returning the final argv vector.

**Call relations**: Only `prepare_user_shell_exec_command` calls this on Unix. Tests target it directly because it contains the subtle PATH-preservation logic around shell snapshots.

*Call graph*: calls 1 internal fn (maybe_wrap_shell_lc_with_snapshot); called by 1 (prepare_user_shell_exec_command); 1 external calls (default).


##### `persist_user_shell_output`  (lines 434–456)

```
async fn persist_user_shell_output(
    session: &Session,
    turn_context: &TurnContext,
    raw_command: &str,
    exec_output: &ExecToolCallOutput,
    mode: UserShellCommandMode,
)
```

**Purpose**: Converts shell execution output into a conversation item and stores it either as standalone rollout history or as injected output within the active turn.

**Data flow**: Consumes a borrowed `Session`, `TurnContext`, raw command string, `ExecToolCallOutput`, and execution mode. It builds `output_item` via `user_shell_command_record_item`. In `StandaloneTurn` mode it records that item with `record_conversation_items`, forces rollout materialization, and returns early. In `ActiveTurnAuxiliary` mode it injects the item with `inject_no_new_turn(vec![output_item], Some(turn_context))`. It returns `()`.

**Call relations**: All result branches in `execute_user_shell_command` call this after producing either real or synthetic output. It centralizes the difference between standalone shell turns and auxiliary shell activity inside another turn.

*Call graph*: calls 1 internal fn (user_shell_command_record_item); called by 1 (execute_user_shell_command); 5 external calls (ensure_rollout_materialized, inject_no_new_turn, record_conversation_items, from_ref, vec!).


### `core/src/tools/handlers/shell.rs`

`orchestration` · `shell tool execution`

This file contains the common execution path behind shell-oriented tools. `shell_command_payload_command` is a small extractor that reads a `ToolPayload::Function`, parses it as `ShellCommandToolCallParams`, and returns just the raw `command` string for hook payloads.

The main logic is `run_exec_like`, which accepts a fully prepared `RunExecLikeArgs` bundle. It first requires a primary turn environment; without one, it returns a model-facing `"shell is unavailable in this session"` error. From the environment it obtains the filesystem handle used later for `apply_patch` interception. It then computes effective permissions in several stages: clone explicit environment overrides, inspect feature flags for exec-permission approvals, apply sticky/granted turn permissions with `apply_granted_turn_permissions`, decide whether additional permissions are allowed, derive implicit grants with `implicit_granted_permissions`, and otherwise normalize/validate requested permissions. A special guard rejects explicit sandbox escalation when the approval policy is not `OnRequest` and the permissions were not already preapproved.

Before launching a runtime, the function checks `intercept_apply_patch`; if the command is an `apply_patch` invocation, it returns the synthetic output immediately. Otherwise it emits shell tool-start events, asks the exec-policy service to compute an `exec_approval_requirement`, builds a `ShellRequest`, and runs it through `ToolOrchestrator` with a `ShellRuntime` selected by backend. After execution it emits finish events, derives an optional `post_tool_use_response` string from successful output, and returns a `FunctionToolOutput` containing the event-emitted content as an `InputText` item and `success: Some(true)`.

#### Function details

##### `shell_command_payload_command`  (lines 35–43)

```
fn shell_command_payload_command(payload: &ToolPayload) -> Option<String>
```

**Purpose**: Extracts the raw shell command string from a function-style tool payload. It is used for hook metadata rather than execution.

**Data flow**: It pattern-matches the input `&ToolPayload`; if the payload is not `ToolPayload::Function { arguments }`, it returns `None`. For function payloads it parses `arguments` as `ShellCommandToolCallParams`, converts parse failure to `None` with `.ok()`, and maps the parsed struct to `params.command`.

**Call relations**: This helper is consumed by shell-command hook integration code to build pre- and post-tool-use payloads. It intentionally performs a best-effort parse and never raises an execution error.


##### `run_exec_like`  (lines 60–238)

```
async fn run_exec_like(args: RunExecLikeArgs) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: Runs a prepared exec-style shell request through environment lookup, permission resolution, approval-policy checks, optional `apply_patch` interception, runtime orchestration, and tool-event emission. It is the shared execution engine behind shell command handlers.

**Data flow**: It takes a `RunExecLikeArgs` struct containing the tool name, `ExecParams`, cancellation token, hook command, shell type, optional additional permissions and prefix rule, session/turn/tracker references, call ID, and runtime backend. It reads the primary turn environment and filesystem, clones shell environment overrides, checks feature flags on `session.features()`, and computes `effective_additional_permissions` via `apply_granted_turn_permissions`. It then either derives implicit permissions with `implicit_granted_permissions` or validates requested permissions with `normalize_and_validate_additional_permissions`, converting validation failures into `FunctionCallError::RespondToModel`. If the effective sandbox permissions request escalation without preapproval and the turn approval policy is not `OnRequest`, it returns a model-facing rejection. Next it calls `intercept_apply_patch`; a returned synthetic output short-circuits the rest of the function. Otherwise it creates a `ToolEmitter`, emits `begin`, asks `session.services.exec_policy` for an approval requirement, builds a `ShellRequest` from the exec params plus computed permissions and approval requirement, constructs `ToolOrchestrator`, `ShellRuntime`, and `ToolCtx`, and awaits `orchestrator.run(...)`. It maps the runtime result to `result.output`, formats a post-tool-use response string for successful outputs, emits `finish`, and returns a `FunctionToolOutput` whose body contains one `FunctionCallOutputContentItem::InputText` with the emitted content, `success: Some(true)`, and the optional post-tool-use response.

**Call relations**: This function is called by `ShellCommandHandler::handle_call` after argument parsing and `ExecParams` construction. It delegates permission-state merging to helper functions, delegates patch-command short-circuiting to `intercept_apply_patch`, delegates approval computation to the exec-policy service, and delegates actual command execution to `ToolOrchestrator` plus `ShellRuntime`.

*Call graph*: calls 7 internal fn (shell, new, apply_granted_turn_permissions, intercept_apply_patch, implicit_granted_permissions, new, for_shell_command); 4 external calls (format!, matches!, RespondToModel, vec!).


### `core/src/tools/runtimes/shell.rs`

`domain_logic` · `tool request handling`

This file defines the request and runtime types for shell-command execution. `ShellRequest` carries the full launch contract: argv, cwd, shell selection, timeout/cancellation, environment maps, optional managed network proxy, sandbox permissions, optional additional permission profile, approval metadata, and Unix-only preapproval state for additional permissions. `ShellRuntimeBackend` selects between the classic shell flow and the Unix zsh-fork escalation path, while `ShellRuntime` stores that backend choice.

The runtime participates in three orchestrator protocols. As `Sandboxable`, it always prefers automatic sandbox selection and allows escalation after sandbox failure. As `Approvable`, it derives a stable `ApprovalKey` from a canonicalized command plus cwd and permission settings, exposes the request’s exec-approval requirement and hook payload, and starts approval either through Guardian review or the normal session approval prompt with session-level approval caching. As `ToolRuntime`, it computes network approval triggers using denied-read-preserving sandbox normalization, then executes the command.

The `run` path is concrete and layered: choose the effective shell from turn/session state, compute shell snapshot wrapping, normalize sandbox permissions so denied reads are not lost, derive execution env and PATH prepends, optionally inject zsh-fork binaries on Unix, wrap shell `-lc` commands with snapshot restore logic, disable PowerShell profiles for elevated Windows sandboxes, and UTF-8-prefix PowerShell scripts. If the backend is zsh-fork, it first attempts the specialized Unix escalation backend and falls back with a warning if prerequisites are missing. Otherwise it builds a `SandboxCommand`, combines timeout and cancellation tokens (including network-denial cancellation), asks the current `SandboxAttempt` to transform it into an `ExecRequest`, and runs it through `execute_env`, optionally streaming stdout events tied to the current tool call.

#### Function details

##### `ShellRuntime::for_shell_command`  (lines 103–105)

```
fn for_shell_command(backend: ShellRuntimeBackend) -> Self
```

**Purpose**: Constructs a `ShellRuntime` configured for the shell-command tool with a specific backend selection. It is the narrow factory used by higher-level orchestration when choosing classic versus zsh-fork behavior.

**Data flow**: Takes a `ShellRuntimeBackend` enum value and stores it in a new `ShellRuntime`. Returns that runtime without touching external state.

**Call relations**: It is created by the exec-like orchestration path when wiring a shell tool invocation, and the chosen backend later controls whether `run` attempts the zsh-fork adapter before normal execution.

*Call graph*: called by 1 (run_exec_like).


##### `ShellRuntime::stdout_stream`  (lines 107–113)

```
fn stdout_stream(ctx: &ToolCtx) -> Option<crate::exec::StdoutStream>
```

**Purpose**: Builds the stdout event-stream descriptor used for live shell output forwarding. It packages the current turn sub-id, tool call id, and session event sender into the executor-facing stream handle.

**Data flow**: Reads `ctx.turn.sub_id`, `ctx.call_id`, and `ctx.session.get_tx_event()` from `ToolCtx`, wraps them in `crate::exec::StdoutStream`, and returns `Some(...)` unconditionally.

**Call relations**: This helper is consumed inside `run` right before `execute_env` so shell executions can emit incremental stdout events associated with the active tool call.


##### `ShellRuntime::sandbox_preference`  (lines 117–119)

```
fn sandbox_preference(&self) -> SandboxablePreference
```

**Purpose**: Declares that shell execution should use automatic sandbox selection rather than forcing a specific sandbox mode. This leaves the concrete sandbox choice to the sandbox manager and current permission profile.

**Data flow**: Consumes no inputs beyond `self` and returns `SandboxablePreference::Auto`.

**Call relations**: The orchestrator queries this through the `Sandboxable` trait when preparing attempts for the shell runtime.


##### `ShellRuntime::escalate_on_failure`  (lines 120–122)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Signals that a failed sandboxed shell attempt may be retried with escalation. This is the runtime-level opt-in for the orchestrator’s fallback behavior.

**Data flow**: Consumes no request data and returns `true`.

**Call relations**: The orchestrator reads this trait method when deciding whether a sandbox denial or similar first-attempt failure should trigger an approval/escalation path.


##### `ShellRuntime::approval_keys`  (lines 128–135)

```
fn approval_keys(&self, req: &ShellRequest) -> Vec<Self::ApprovalKey>
```

**Purpose**: Computes the cache key used to reuse session approvals for equivalent shell requests. The key intentionally normalizes command spelling via canonicalization and includes cwd and permission shape so approvals are not reused across materially different executions.

**Data flow**: Reads `req.command`, `req.cwd`, `req.sandbox_permissions`, and `req.additional_permissions`; canonicalizes the command with `canonicalize_command_for_approval`; clones owned fields into one `ApprovalKey`; returns it in a single-element vector.

**Call relations**: It is called by `ShellRuntime::start_approval_async` before prompting so that `with_cached_approval` can skip repeated approvals when the same shell request was previously approved for the session.

*Call graph*: called by 1 (start_approval_async); 1 external calls (vec!).


##### `ShellRuntime::start_approval_async`  (lines 137–190)

```
fn start_approval_async(
        &'a mut self,
        req: &'a ShellRequest,
        ctx: ApprovalCtx<'a>,
    ) -> BoxFuture<'a, ReviewDecision>
```

**Purpose**: Starts the asynchronous approval flow for a shell request, routing either to Guardian review or to the standard session approval prompt with approval caching. It also threads through retry reasons, justification text, network approval context, and any proposed exec-policy amendment.

**Data flow**: Reads the request’s command, cwd, sandbox permissions, additional permissions, justification, and exec approval requirement plus `ApprovalCtx` fields such as session, turn, call id, retry reason, guardian review id, and network approval context. It first derives approval keys, then returns a boxed future that either calls `review_approval_request` with a `GuardianApprovalRequest::Shell` payload or invokes `with_cached_approval`, whose fetch closure calls `session.request_command_approval`. The future resolves to a `ReviewDecision` and may update the shared approval cache indirectly through `with_cached_approval`.

**Call relations**: This is the runtime’s approval entry used by the orchestrator when a shell call needs review. It depends on `approval_keys` for cache identity, delegates to Guardian when a review lifecycle already exists, and otherwise delegates to the session approval UI wrapped in cache semantics.

*Call graph*: calls 2 internal fn (approval_keys, with_cached_approval); 2 external calls (pin, review_approval_request).


##### `ShellRuntime::exec_approval_requirement`  (lines 192–194)

```
fn exec_approval_requirement(&self, req: &ShellRequest) -> Option<ExecApprovalRequirement>
```

**Purpose**: Exposes the request-specific exec approval requirement chosen earlier in planning or policy evaluation. The runtime does not recompute it here; it simply forwards the embedded requirement.

**Data flow**: Clones `req.exec_approval_requirement` and returns it inside `Some(...)`.

**Call relations**: The orchestrator queries this through `Approvable` to decide whether approval is required, skipped, or forbidden before calling `start_approval_async` or launching execution.


##### `ShellRuntime::permission_request_payload`  (lines 196–201)

```
fn permission_request_payload(&self, req: &ShellRequest) -> Option<PermissionRequestPayload>
```

**Purpose**: Builds the hook payload used by approval-time permission-request hooks for shell commands. The payload is shaped as a bash tool invocation containing the human-readable hook command and optional justification.

**Data flow**: Reads `req.hook_command` and `req.justification`, passes them to `PermissionRequestPayload::bash`, and returns the resulting payload in `Some(...)`.

**Call relations**: The orchestrator can use this trait method before approval to run hook-based policy checks; the payload format matches the shell tool’s approval semantics.

*Call graph*: calls 1 internal fn (bash).


##### `ShellRuntime::sandbox_permissions`  (lines 203–205)

```
fn sandbox_permissions(&self, req: &ShellRequest) -> SandboxPermissions
```

**Purpose**: Returns the shell request’s desired sandbox permission mode for first-attempt sandbox selection. This preserves explicit caller intent such as default sandboxing, escalation, or additional-permission execution.

**Data flow**: Reads and returns `req.sandbox_permissions` by value.

**Call relations**: The orchestrator consults this trait method when constructing the initial `SandboxAttempt` for the shell runtime.


##### `ShellRuntime::network_approval_spec`  (lines 209–236)

```
fn network_approval_spec(
        &self,
        req: &ShellRequest,
        ctx: &ToolCtx,
    ) -> Option<NetworkApprovalSpec>
```

**Purpose**: Describes the shell command’s managed-network approval request when network access is relevant. It preserves denied-read filesystem restrictions while deciding whether managed networking still applies, and packages a Guardian trigger with concrete command metadata.

**Data flow**: Reads turn filesystem sandbox policy from `ctx.turn`, normalizes `req.sandbox_permissions` through `sandbox_permissions_preserving_denied_reads`, and asks `managed_network_for_sandbox_permissions` whether the request still uses managed networking. If not, returns `None`; otherwise returns a `NetworkApprovalSpec` containing the cloned network proxy, `Immediate` mode, a `GuardianNetworkAccessTrigger` built from call id, flattened tool name, command, cwd, original sandbox/additional permissions, justification, and `tty: None`, plus the hook command string.

**Call relations**: The orchestrator calls this before execution when deciding whether network approval must be obtained. It feeds Guardian/network approval infrastructure with shell-specific metadata.

*Call graph*: calls 3 internal fn (flat_tool_name, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads).


##### `ShellRuntime::run`  (lines 238–326)

```
async fn run(
        &mut self,
        req: &ShellRequest,
        attempt: &SandboxAttempt<'_>,
        ctx: &ToolCtx,
    ) -> Result<ExecToolCallOutput, ToolError>
```

**Purpose**: Executes the shell request under the current sandbox attempt, including shell selection, environment shaping, snapshot wrapping, optional zsh-fork delegation, sandbox command construction, timeout/cancellation setup, and final process launch. It is the concrete execution core of the shell runtime.

**Data flow**: Consumes `ShellRequest`, `SandboxAttempt`, and `ToolCtx`. It reads session and turn shell state, computes shell snapshot location, derives runtime filesystem permissions from `attempt.permissions`, normalizes sandbox permissions to preserve denied reads, derives managed network and execution env, clones explicit env overrides, and on Unix mutates env/PATH via package and optional zsh-fork prepends. It transforms the command through snapshot wrapping, Windows PowerShell profile disabling, and optional UTF-8 prefixing. If configured for zsh-fork, it delegates to `zsh_fork_backend::maybe_run_shell_command` and returns early on success. Otherwise it builds a sandbox command, constructs `ExecExpiration` from timeout plus request cancellation and optional network-denial cancellation, creates `ExecOptions`, asks `attempt.env_for` for an `ExecRequest`, executes it with `execute_env`, and returns `ExecToolCallOutput` or maps failures into `ToolError`.

**Call relations**: This method is invoked by the tool orchestrator after approvals and sandbox attempt selection. It delegates to helper functions for shell wrapping and env shaping, optionally to the zsh-fork backend for Unix execve-level escalation, and finally to sandbox transformation plus low-level execution.

*Call graph*: calls 11 internal fn (execute_env, apply_package_path_prepend, apply_zsh_fork_path_prepend, build_sandbox_command, disable_powershell_profile_for_elevated_windows_sandbox, exec_env_for_sandbox_permissions, maybe_wrap_shell_lc_with_snapshot, env_for, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads (+1 more)); 5 external calls (stdout_stream, default, matches!, warn!, maybe_run_shell_command).


### `core/src/tools/runtimes/shell/zsh_fork_backend.rs`

`orchestration` · `tool request handling when zsh-fork backend is attempted`

This file is a small adapter layer around the Unix zsh-fork escalation implementation. It defines `PreparedUnifiedExecSpawn`, which bundles a transformed `ExecRequest` together with a `SpawnLifecycleHandle` used by unified exec to keep the escalation session alive across process spawn. The two public async helpers, `maybe_run_shell_command` and `maybe_prepare_unified_exec`, are intentionally platform-neutral wrappers: callers can invoke them without scattering `cfg(unix)` checks through higher-level runtimes.

The Unix `imp` module contains the real glue. `imp::maybe_run_shell_command` simply forwards shell-command execution to `unix_escalation::try_run_zsh_fork`. `imp::maybe_prepare_unified_exec` forwards to `prepare_unified_exec_zsh_fork`, then wraps the returned `EscalationSession` in `ZshForkSpawnLifecycle`. That lifecycle exposes the escalation socket file descriptor listed in the session environment under `ESCALATE_SOCKET_ENV_VAR`, so the spawned child inherits the socket, and closes the client socket immediately after spawn to complete handoff.

The non-Unix `imp` module preserves the same API shape but always returns `Ok(None)`, making zsh-fork an optional optimization/fallback path rather than a required execution mode. This design keeps shell and unified-exec runtimes simple: they can attempt zsh-fork first and fall back to direct execution when unsupported.

#### Function details

##### `maybe_run_shell_command`  (lines 21–28)

```
async fn maybe_run_shell_command(
    req: &ShellRequest,
    attempt: &SandboxAttempt<'_>,
    ctx: &ToolCtx,
    command: &[String],
) -> Result<Option<ExecToolCallOutput>, ToolError>
```

**Purpose**: Platform-neutral entry point for attempting zsh-fork execution of a shell command. It hides the Unix/non-Unix split from callers.

**Data flow**: Accepts a `ShellRequest`, `SandboxAttempt`, `ToolCtx`, and command vector, then forwards them to the platform-specific `imp::maybe_run_shell_command`. Returns `Result<Option<ExecToolCallOutput>, ToolError>` unchanged.

**Call relations**: The shell runtime’s `run` method calls this when configured for the zsh-fork backend; the returned `Some(output)` short-circuits normal execution, while `None` triggers fallback.

*Call graph*: 1 external calls (maybe_run_shell_command).


##### `maybe_prepare_unified_exec`  (lines 36–44)

```
async fn maybe_prepare_unified_exec(
    req: &UnifiedExecRequest,
    attempt: &SandboxAttempt<'_>,
    ctx: &ToolCtx,
    exec_request: ExecRequest,
    zsh_fork_config: &ZshForkConfig,
) -> Result<
```

**Purpose**: Platform-neutral entry point for attempting zsh-fork preparation of a unified-exec launch. It returns both the transformed exec request and the spawn lifecycle needed to maintain the escalation session.

**Data flow**: Accepts a `UnifiedExecRequest`, `SandboxAttempt`, `ToolCtx`, an `ExecRequest`, and `ZshForkConfig`, then forwards them to the platform-specific `imp::maybe_prepare_unified_exec`. Returns `Result<Option<PreparedUnifiedExecSpawn>, ToolError>` unchanged.

**Call relations**: The unified-exec runtime calls this when its shell mode is `ZshFork`; `Some(prepared)` causes it to spawn through the zsh-fork lifecycle, while `None` falls back to direct unified exec.

*Call graph*: 1 external calls (maybe_prepare_unified_exec).


##### `imp::ZshForkSpawnLifecycle::inherited_fds`  (lines 60–67)

```
fn inherited_fds(&self) -> Vec<i32>
```

**Purpose**: Reports which file descriptors the spawned child must inherit from the escalation session. It extracts the escalation socket fd from the session environment.

**Data flow**: Reads `self.escalation_session.env()`, looks up `ESCALATE_SOCKET_ENV_VAR`, parses it as an `i32`, converts the optional parsed fd into an iterator, collects into `Vec<i32>`, and returns it.

**Call relations**: Unified exec uses this lifecycle callback during spawn so the child process inherits the escalation socket required by the zsh-fork session.

*Call graph*: calls 1 internal fn (env).


##### `imp::ZshForkSpawnLifecycle::after_spawn`  (lines 69–71)

```
fn after_spawn(&mut self)
```

**Purpose**: Performs post-spawn cleanup by closing the client side of the escalation socket in the parent. This finalizes ownership transfer to the spawned process.

**Data flow**: Calls `self.escalation_session.close_client_socket()` and returns unit.

**Call relations**: Unified exec invokes this lifecycle hook immediately after spawning the child process.

*Call graph*: calls 1 internal fn (close_client_socket).


##### `imp::maybe_run_shell_command`  (lines 116–124)

```
async fn maybe_run_shell_command(
        req: &ShellRequest,
        attempt: &SandboxAttempt<'_>,
        ctx: &ToolCtx,
        command: &[String],
    ) -> Result<Option<ExecToolCallOutput>, ToolE
```

**Purpose**: Unix implementation of shell-command zsh-fork dispatch. It simply delegates to the full Unix escalation runner.

**Data flow**: Passes `req`, `attempt`, `ctx`, and `command` through to `unix_escalation::try_run_zsh_fork` and returns its result.

**Call relations**: This is the Unix target of the top-level `maybe_run_shell_command` wrapper.

*Call graph*: calls 1 internal fn (try_run_zsh_fork).


##### `imp::maybe_prepare_unified_exec`  (lines 126–135)

```
async fn maybe_prepare_unified_exec(
        req: &UnifiedExecRequest,
        attempt: &SandboxAttempt<'_>,
        ctx: &ToolCtx,
        exec_request: ExecRequest,
        zsh_fork_config: &ZshFork
```

**Purpose**: Unix implementation of unified-exec zsh-fork preparation. It converts the lower-level prepared session into the spawn-lifecycle wrapper expected by unified exec.

**Data flow**: Calls `unix_escalation::prepare_unified_exec_zsh_fork` with the request, attempt, context, exec request, and configured zsh/wrapper paths. If it returns `None`, this function returns `Ok(None)`. Otherwise it constructs `PreparedUnifiedExecSpawn` with the prepared `exec_request` and a boxed `ZshForkSpawnLifecycle` holding the `escalation_session`, then returns `Ok(Some(...))`.

**Call relations**: This is the Unix target of the top-level `maybe_prepare_unified_exec` wrapper and is used by the unified-exec runtime’s zsh-fork branch.

*Call graph*: calls 1 internal fn (prepare_unified_exec_zsh_fork); 1 external calls (new).


### Unified exec tool flow
These files define the shared unified-exec argument model, concrete tool handlers, and the PTY-oriented runtime that launches unified execution sessions.

### `core/src/tools/handlers/unified_exec.rs`

`domain_logic` · `request handling`

This file is the common substrate for the unified exec tool family. It declares the deserializable request structs used by handlers: `ExecCommandArgs` for command execution and `ExecCommandEnvironmentArgs` for environment selection and deferred workdir resolution. Several fields use serde defaults wired to local helper functions, notably `tty` defaulting to `false`, `yield_time_ms` defaulting to `10_000` for command execution, and `250` for stdin polling/writes.

The core runtime helper is `get_command`, which converts model-supplied execution arguments into a concrete `ResolvedCommand { command: Vec<String>, shell_type: ShellType }`. It enforces the login-shell policy, chooses between the session shell and an explicit model-provided shell path in `UnifiedExecShellMode::Direct`, and rejects explicit `shell` overrides in local `UnifiedExecShellMode::ZshFork` mode. In zsh-fork mode it synthesizes a three-argument command line using the configured zsh path and either `-lc` or `-c`.

The other important helper, `post_unified_exec_tool_use_payload`, translates a completed exec-style `ToolOutput` back into a `PostToolUsePayload` for hook processing, but only for function-style invocations and only when the output can supply matching hook input/response data. `shell_mode_for_environment` is a small but important policy shim: remote environments always force `UnifiedExecShellMode::Direct`, avoiding local zsh-fork assumptions on foreign hosts.

#### Function details

##### `default_exec_yield_time_ms`  (lines 60–62)

```
fn default_exec_yield_time_ms() -> u64
```

**Purpose**: Provides the serde default polling/yield interval for `exec_command` requests.

**Data flow**: It takes no inputs and returns the constant `10_000` as a `u64`. It does not read or mutate any external state.

**Call relations**: Serde uses this function when deserializing `ExecCommandArgs` and the caller omitted `yield_time_ms`. It exists so the default is centralized and named rather than embedded as a literal in the struct attribute.


##### `default_write_stdin_yield_time_ms`  (lines 64–66)

```
fn default_write_stdin_yield_time_ms() -> u64
```

**Purpose**: Provides the serde default polling/yield interval for `write_stdin` requests.

**Data flow**: It takes no inputs and returns the constant `250` as a `u64`. No state is read or written.

**Call relations**: Serde uses it while deserializing `WriteStdinArgs` in the sibling handler module when the model omits `yield_time_ms`. This keeps stdin polling more responsive than initial command execution.


##### `default_tty`  (lines 68–70)

```
fn default_tty() -> bool
```

**Purpose**: Supplies the default `tty` flag for exec requests.

**Data flow**: It takes no arguments and returns `false`. It has no side effects.

**Call relations**: Serde calls it during `ExecCommandArgs` deserialization when `tty` is absent. The rest of the exec pipeline then treats noninteractive execution as the default mode.


##### `post_unified_exec_tool_use_payload`  (lines 78–95)

```
fn post_unified_exec_tool_use_payload(
    invocation: &ToolInvocation,
    result: &dyn ToolOutput,
) -> Option<PostToolUsePayload>
```

**Purpose**: Builds a hook-facing `PostToolUsePayload` for completed unified-exec outputs, using Bash as the canonical hook tool identity.

**Data flow**: It reads a `ToolInvocation` and a `dyn ToolOutput`. If the invocation payload is not `ToolPayload::Function`, it returns `None` immediately. Otherwise it asks the output for `post_tool_use_input`, derives a stable tool-use id via `post_tool_use_id`, asks for `post_tool_use_response`, and packages those pieces into `PostToolUsePayload { tool_name: HookToolName::bash(), tool_use_id, tool_input, tool_response }`.

**Call relations**: Both `ExecCommandHandler` and `WriteStdinHandler` delegate their post-hook generation to this helper so completion semantics stay consistent across initial execs and later stdin polls. It depends on the concrete `ToolOutput` implementation to decide whether a session is complete enough to emit a post-hook payload.

*Call graph*: calls 4 internal fn (bash, post_tool_use_id, post_tool_use_input, post_tool_use_response).


##### `get_command`  (lines 97–142)

```
fn get_command(
    args: &ExecCommandArgs,
    session_shell: Arc<Shell>,
    shell_mode: &UnifiedExecShellMode,
    allow_login_shell: bool,
) -> Result<ResolvedCommand, String>
```

**Purpose**: Resolves exec arguments plus shell-mode policy into the exact argv vector and `ShellType` that unified exec should launch.

**Data flow**: Inputs are parsed `ExecCommandArgs`, the session shell as `Arc<Shell>`, the current `UnifiedExecShellMode`, and a boolean policy flag controlling login shells. It first computes `use_login_shell`, rejecting `login: true` when policy forbids it. In `Direct` mode it optionally maps `args.shell` through `get_shell_by_model_provided_path`, falls back to the session shell if absent or unrecognized, and returns `shell.derive_exec_args(&args.cmd, use_login_shell)` plus that shell's `shell_type`. In `ZshFork` mode it rejects any explicit `shell`, otherwise returns `[configured_zsh_path, "-lc"|"-c", args.cmd]` with `ShellType::Zsh`.

**Call relations**: The main exec handler calls this after selecting an environment and shell mode. It is also exercised heavily by unit tests covering default shell selection, explicit shell overrides, login-shell rejection, and zsh-fork restrictions.

*Call graph*: 1 external calls (vec!).


##### `shell_mode_for_environment`  (lines 144–153)

```
fn shell_mode_for_environment(
    turn_shell_mode: &UnifiedExecShellMode,
    environment: &Environment,
) -> UnifiedExecShellMode
```

**Purpose**: Adjusts the turn-level shell mode to one that is safe for the selected execution environment.

**Data flow**: It takes the turn's configured `UnifiedExecShellMode` and an `Environment`. If `environment.is_remote()` is true, it returns `UnifiedExecShellMode::Direct`; otherwise it clones and returns the original mode unchanged.

**Call relations**: The exec handler calls this before command resolution so remote environments never inherit local zsh-fork behavior. Tests cover the local-pass-through and remote-forced-direct branches.

*Call graph*: calls 1 internal fn (is_remote); 1 external calls (clone).


### `core/src/tools/handlers/unified_exec/exec_command.rs`

`domain_logic` · `request handling`

This file contains the concrete `ExecCommandHandler` plus its runtime and hook-facing behavior. The handler stores `ExecCommandHandlerOptions`, with a `Default` implementation that disables login shells and exec-permission approvals, omits environment IDs, and includes the `shell` parameter. Through `ToolExecutor<ToolInvocation>`, it exposes the tool name `exec_command`, generates its `ToolSpec` via `create_exec_command_tool_with_environment_id`, declares parallel-call support, and forwards execution into the async `handle_call` body.

`handle_call` is the substantive pipeline. It first rejects non-function payloads, parses lightweight environment-selection arguments, resolves the target `TurnEnvironment`, converts its cwd to a native absolute path, and computes the effective working directory by joining any non-empty `workdir` against that environment cwd. It then reparses full `ExecCommandArgs` relative to that base path, emits implicit skill telemetry, allocates a process id, selects shell mode with remote-environment fallback, and resolves the final argv via `get_command`.

Before launching, it applies sticky/granted turn permissions, checks whether escalated sandbox overrides are even askable under the current approval policy, and normalizes additional permissions unless they can be inferred from implicit grants. It also gives `intercept_apply_patch` a chance to short-circuit shell execution entirely for patch-like commands. If execution proceeds, it emits a tty metric and calls `UnifiedExecProcessManager::exec_command`. Sandbox denials are converted into terminal `ExecCommandToolOutput` values with token counts and no resumable `process_id`; other failures become model-facing errors that include the display-joined command.

As `CoreToolRuntime`, the handler also emits Bash-flavored pre/post hook payloads and supports hook-driven command rewriting by replacing the `cmd` string inside the original function arguments JSON.

#### Function details

##### `ExecCommandHandler::default`  (lines 56–65)

```
fn default() -> Self
```

**Purpose**: Creates the standard `exec_command` handler configuration used in tests and default registrations.

**Data flow**: It takes no inputs and returns `ExecCommandHandler { options }` with `allow_login_shell: false`, `exec_permission_approvals_enabled: false`, `include_environment_id: false`, and `include_shell_parameter: true`. No external state is read or modified.

**Call relations**: This constructor is used by tests that exercise hook payload behavior and permission validation defaults. Production wiring can bypass it by calling `ExecCommandHandler::new` with explicit options.

*Call graph*: called by 6 (guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation, unified_exec_rejects_escalated_permissions_when_policy_not_on_request, exec_command_post_tool_use_payload_skips_running_sessions, exec_command_post_tool_use_payload_uses_output_for_interactive_completion, exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands, exec_command_pre_tool_use_payload_uses_raw_command).


##### `ExecCommandHandler::new`  (lines 69–71)

```
fn new(options: ExecCommandHandlerOptions) -> Self
```

**Purpose**: Builds a handler with caller-specified option flags controlling schema and policy behavior.

**Data flow**: It accepts an `ExecCommandHandlerOptions` value and wraps it directly into `Self { options }`. It returns the configured handler without side effects.

**Call relations**: Tool-registration code (`add_shell_tools`) calls this when assembling the runtime tool set. The resulting options influence both `spec()` output and runtime checks in `handle_call`.

*Call graph*: called by 1 (add_shell_tools).


##### `ExecCommandHandler::tool_name`  (lines 75–77)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Reports the registered tool name for this executor.

**Data flow**: It reads no handler state and returns `ToolName::plain("exec_command")`.

**Call relations**: The tool registry queries this when registering or dispatching the handler. It delegates name construction to `ToolName::plain` so the identifier matches the external tool API.

*Call graph*: calls 1 internal fn (plain).


##### `ExecCommandHandler::spec`  (lines 79–88)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Generates the `ToolSpec` advertised to the model for `exec_command`, reflecting the handler's option flags.

**Data flow**: It reads `self.options` and passes `allow_login_shell` and `exec_permission_approvals_enabled` inside `CommandToolOptions`, along with `include_environment_id` and `include_shell_parameter`, into `create_exec_command_tool_with_environment_id`. It returns the resulting `ToolSpec` unchanged.

**Call relations**: The registry calls this during tool exposure. The helper it delegates to is responsible for shaping the JSON schema and descriptive text according to the selected options.

*Call graph*: calls 1 internal fn (create_exec_command_tool_with_environment_id).


##### `ExecCommandHandler::supports_parallel_tool_calls`  (lines 90–92)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that multiple `exec_command` invocations may run concurrently.

**Data flow**: It takes no inputs and returns `true`.

**Call relations**: The tool runtime consults this capability flag when deciding whether concurrent calls are allowed. It aligns with the process-manager design, which allocates distinct process ids per invocation.


##### `ExecCommandHandler::handle`  (lines 94–96)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async command-execution implementation to the boxed future type expected by the tool executor trait.

**Data flow**: It takes ownership of a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes and pins that future, and returns it as `codex_tools::ToolExecutorFuture<'_>`.

**Call relations**: The tool framework invokes this trait method for runtime execution. It is a thin wrapper whose only delegate is `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ExecCommandHandler::handle_call`  (lines 100–327)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Executes an `exec_command` request from parsed JSON arguments through environment resolution, permission checks, optional interception, process launch, and final output conversion.

**Data flow**: It consumes a `ToolInvocation`, destructuring out `session`, `turn`, `tracker`, `call_id`, and `payload`. It rejects non-`ToolPayload::Function` payloads, parses `ExecCommandEnvironmentArgs` from the raw JSON, resolves the selected environment, converts the environment cwd to a native absolute path, and computes the effective `cwd` by joining any non-empty `workdir`. It then parses full `ExecCommandArgs` relative to that base path, clones the command string for hook use, emits implicit skill invocation, allocates a process id, derives shell mode and shell, and resolves the final argv/shell type via `get_command`.

It extracts execution flags (`tty`, `yield_time_ms`, `max_output_tokens`, sandbox and additional permissions, justification, prefix rule), applies granted turn permissions, computes whether additional permissions may be requested, rejects sandbox overrides when approval policy forbids asking, and normalizes additional permissions unless implicit grants already determine them. Before launching, it calls `intercept_apply_patch`; if that returns synthetic output, it releases the process id and returns an `ExecCommandToolOutput` immediately. Otherwise it emits a tty metric and calls `UnifiedExecProcessManager::exec_command` with a fully populated `ExecCommandRequest`. Success returns the manager's output boxed. A `UnifiedExecError::SandboxDenied` is converted into a terminal `ExecCommandToolOutput` with aggregated output bytes, generated chunk id, exit code, token count, and no resumable process id. Any other error becomes `FunctionCallError::RespondToModel` with the display-joined command embedded in the message.

**Call relations**: This is called only by `handle`, and it is the central orchestrator for the exec tool. Along the way it delegates to argument parsers, environment resolution, shell-mode helpers, permission helpers, apply-patch interception, telemetry emission, and finally the unified exec process manager. It also explicitly releases allocated process ids on early-return error/interception paths to avoid leaking manager state.

*Call graph*: calls 11 internal fn (boxed_tool_output, apply_granted_turn_permissions, intercept_apply_patch, implicit_granted_permissions, parse_arguments, parse_arguments_with_base_path, resolve_tool_environment, emit_unified_exec_tty_metric, new, generate_chunk_id (+1 more)); called by 1 (handle); 9 external calls (clone, new, approx_token_count, maybe_emit_implicit_skill_invocation, format!, matches!, get_command, shell_mode_for_environment, RespondToModel).


##### `ExecCommandHandler::matches_kind`  (lines 331–333)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Restricts this runtime to function-call payloads.

**Data flow**: It reads a `&ToolPayload` and returns `true` only when it matches `ToolPayload::Function { .. }`.

**Call relations**: The core tool runtime uses this predicate before invoking hook-related methods on the handler. It mirrors the payload assumption enforced again in `handle_call`.

*Call graph*: 1 external calls (matches!).


##### `ExecCommandHandler::pre_tool_use_payload`  (lines 335–346)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Produces the Bash pre-hook payload for an `exec_command` invocation using the raw command string from the request.

**Data flow**: It inspects `invocation.payload`; non-function payloads return `None`. For function payloads it parses `ExecCommandArgs` from the JSON arguments, and on successful parse returns `PreToolUsePayload { tool_name: HookToolName::bash(), tool_input: json!({ "command": args.cmd }) }`; parse failures also yield `None` rather than an error.

**Call relations**: Hook execution asks for this before the tool runs. Tests verify that it emits the raw command for `exec_command` and that `write_stdin` intentionally does not emit a second pre-hook.


##### `ExecCommandHandler::with_updated_hook_input`  (lines 348–367)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: serde_json::Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Rewrites the invocation's `cmd` argument after a hook modifies the command input.

**Data flow**: It takes a mutable `ToolInvocation` plus `updated_input: serde_json::Value`. If the payload is not `ToolPayload::Function`, it returns `FunctionCallError::RespondToModel`. Otherwise it extracts the replacement command string via `updated_hook_command(&updated_input)`, rewrites the `cmd` field inside the original arguments JSON using `rewrite_function_string_argument`, stores the new `ToolPayload::Function { arguments }` back into the invocation, and returns the updated invocation.

**Call relations**: The hook pipeline calls this when a pre-hook wants to alter the command before execution. It delegates JSON extraction and mutation to shared helpers so the rest of the exec path can continue using normal argument parsing.

*Call graph*: calls 2 internal fn (rewrite_function_string_argument, updated_hook_command); 1 external calls (RespondToModel).


##### `ExecCommandHandler::post_tool_use_payload`  (lines 369–375)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Delegates post-hook payload generation for completed exec sessions to the shared unified-exec helper.

**Data flow**: It reads the original `ToolInvocation` and the resulting `ToolOutput`, passes both to `post_unified_exec_tool_use_payload`, and returns that helper's `Option<PostToolUsePayload>` unchanged.

**Call relations**: The hook runtime calls this after tool completion. Tests cover the important cases: one-shot completion emits a payload, interactive completion emits a payload when the session ends, and still-running sessions return `None`.

*Call graph*: 1 external calls (post_unified_exec_tool_use_payload).


##### `emit_unified_exec_tty_metric`  (lines 378–384)

```
fn emit_unified_exec_tty_metric(session_telemetry: &SessionTelemetry, tty: bool)
```

**Purpose**: Records whether an `exec_command` call was launched with tty enabled.

**Data flow**: It takes a `SessionTelemetry` handle and a `bool tty`, then increments `TOOL_CALL_UNIFIED_EXEC_METRIC` by 1 with a single attribute pair `("tty", "true"|"false")`. It returns no value.

**Call relations**: Only `handle_call` invokes this, immediately before dispatching to the process manager. It isolates the metric name and tag formatting from the larger execution flow.

*Call graph*: calls 1 internal fn (counter); called by 1 (handle_call).


### `core/src/tools/handlers/shell/shell_command.rs`

`domain_logic` · `shell tool invocation / hook integration`

This file defines `ShellCommandHandler`, the concrete `ToolExecutor<ToolInvocation>` for the `shell_command` tool. It wraps two pieces of configuration: a chosen backend (`Classic` or `ZshFork`) and `ShellCommandHandlerOptions`, which carry the backend config, whether login shells are allowed, and whether exec-permission approvals are enabled. `new` maps the external `ShellCommandBackendConfig` enum into the internal backend enum, and `shell_runtime_backend` converts that internal choice into the `ShellRuntimeBackend` consumed by the runtime layer.

The helper methods encode the translation from model arguments to executable process parameters. `resolve_use_login_shell` enforces config by rejecting `login: true` when login shells are disabled; otherwise it defaults missing `login` to the config value. `base_command` delegates to the user's configured `Shell` to derive the actual argv vector. `to_exec_params` combines parsed tool-call params, session shell selection, turn path resolution, thread-scoped environment creation, network and sandbox settings, timeout, and optional justification into a single `ExecParams`.

The handler trait implementation exposes the tool name and schema, declares support for parallel tool calls, and boxes the async `handle_call`. That method accepts only function payloads, resolves the base path for parsing, parses `ShellCommandToolCallParams`, emits any implicit skill invocation signal, converts params to `ExecParams`, chooses the runtime backend, and forwards everything to `run_exec_like`, boxing the resulting `FunctionToolOutput`.

As a `CoreToolRuntime`, the handler also integrates with hook infrastructure: it advertises that it matches function payloads, waits for runtime cancellation, emits pre-tool-use payloads containing the raw command, can rewrite the `command` field in the invocation payload after hook processing, and emits post-tool-use payloads that pair the original command with the tool's wire-format response.

#### Function details

##### `ShellCommandHandler::new`  (lines 53–59)

```
fn new(options: ShellCommandHandlerOptions) -> Self
```

**Purpose**: Constructs a shell-command handler from runtime options and selects the internal backend enum. It is the main initializer used when shell tools are registered.

**Data flow**: It takes `ShellCommandHandlerOptions`, matches `options.backend_config` from `ShellCommandBackendConfig::{Classic,ZshFork}` to the internal `ShellCommandBackend::{Classic,ZshFork}`, and returns `Self { backend, options }`.

**Call relations**: This constructor is called by shell-tool setup code such as `add_shell_tools`. The resulting handler instance is later queried for spec, hook behavior, and execution.

*Call graph*: called by 1 (add_shell_tools).


##### `ShellCommandHandler::shell_runtime_backend`  (lines 61–66)

```
fn shell_runtime_backend(&self) -> ShellRuntimeBackend
```

**Purpose**: Maps the handler's internal backend choice to the runtime-layer backend enum. It isolates backend translation in one place.

**Data flow**: It reads `self.backend` and returns either `ShellRuntimeBackend::ShellCommandClassic` or `ShellRuntimeBackend::ShellCommandZshFork`.

**Call relations**: This helper is called by `handle_call` right before dispatching to `run_exec_like`, ensuring the runtime uses the backend selected at handler construction.

*Call graph*: called by 1 (handle_call).


##### `ShellCommandHandler::resolve_use_login_shell`  (lines 68–79)

```
fn resolve_use_login_shell(
        login: Option<bool>,
        allow_login_shell: bool,
    ) -> Result<bool, FunctionCallError>
```

**Purpose**: Determines whether the command should run in a login shell while enforcing configuration restrictions. It rejects explicit login-shell requests when the feature is disabled.

**Data flow**: It takes the optional `login` flag from tool-call params and the boolean `allow_login_shell`. If login shells are disallowed and `login == Some(true)`, it returns `Err(FunctionCallError::RespondToModel(...))`. Otherwise it returns `Ok(login.unwrap_or(allow_login_shell))`, defaulting omitted input to the config setting.

**Call relations**: This helper is used by `to_exec_params` during argument translation. Tests also call it directly to verify the rejection path when login shells are disabled.

*Call graph*: called by 1 (shell_command_handler_rejects_login_when_disallowed); 1 external calls (RespondToModel).


##### `ShellCommandHandler::base_command`  (lines 81–83)

```
fn base_command(shell: &Shell, command: &str, use_login_shell: bool) -> Vec<String>
```

**Purpose**: Builds the actual argv vector used to execute the shell command. It delegates shell-specific quoting and invocation details to the user's configured shell implementation.

**Data flow**: It takes a `&Shell`, the raw command string, and the resolved login-shell boolean, calls `shell.derive_exec_args(command, use_login_shell)`, and returns the resulting `Vec<String>`.

**Call relations**: This helper is called by `to_exec_params` after login-shell resolution. Tests use it to verify that explicit login behavior affects the derived command line as expected.

*Call graph*: calls 1 internal fn (derive_exec_args); called by 1 (shell_command_handler_respects_explicit_login_flag).


##### `ShellCommandHandler::to_exec_params`  (lines 85–114)

```
fn to_exec_params(
        params: &ShellCommandToolCallParams,
        session: &crate::session::session::Session,
        turn_context: &TurnContext,
        thread_id: ThreadId,
        allow_login
```

**Purpose**: Converts parsed `shell_command` tool-call parameters plus session/turn context into the `ExecParams` structure consumed by the shared execution engine. It is the main argument-normalization step before runtime dispatch.

**Data flow**: It receives parsed `ShellCommandToolCallParams`, a `Session`, a `TurnContext`, the current `ThreadId`, and the login-shell policy flag. It reads the user's shell from `session.user_shell()`, resolves whether to use a login shell via `resolve_use_login_shell`, derives the executable argv with `base_command`, resolves the working directory from `turn_context.resolve_path(params.workdir.clone())`, creates the environment with `create_env(&turn_context.shell_environment_policy, Some(thread_id))`, and assembles an `ExecParams` containing command, cwd, timeout, `ExecCapturePolicy::ShellTool`, env, network, sandbox permissions (defaulting if absent), Windows sandbox settings from the turn config, optional justification, and `arg0: None`.

**Call relations**: This helper is called by `handle_call` after parsing the tool payload. It bridges model-level shell parameters to the lower-level execution subsystem and is also exercised directly by tests covering shell selection and login defaults.

*Call graph*: calls 2 internal fn (create_env, resolve_path); called by 2 (shell_command_handler_defaults_to_non_login_when_disallowed, shell_command_handler_to_exec_params_uses_session_shell_and_turn_context); 3 external calls (base_command, resolve_use_login_shell, user_shell).


##### `ShellCommandHandler::from`  (lines 118–124)

```
fn from(backend_config: ShellCommandBackendConfig) -> Self
```

**Purpose**: Provides a convenience conversion from `ShellCommandBackendConfig` to a handler with default options. It is useful in tests and simple setup paths that do not need custom flags.

**Data flow**: It takes a `ShellCommandBackendConfig`, wraps it in `ShellCommandHandlerOptions` with `allow_login_shell: false` and `exec_permission_approvals_enabled: false`, then returns `Self::new(...)`.

**Call relations**: This conversion is used by multiple tests and setup code that only care about backend selection. It delegates all real initialization to `ShellCommandHandler::new`.

*Call graph*: called by 6 (guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, rejects_escalated_permissions_when_policy_not_on_request, build_post_tool_use_payload_uses_tool_output_wire_value, shell_command_pre_tool_use_payload_uses_raw_command); 1 external calls (new).


##### `ShellCommandHandler::tool_name`  (lines 128–130)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the canonical tool name `shell_command`. This is the identifier used for dispatch and error reporting.

**Data flow**: It calls `ToolName::plain("shell_command")` and returns the resulting `ToolName`.

**Call relations**: The tool registry uses this for registration and dispatch, and `handle_call` uses it to produce consistent unsupported-payload error text and to populate `RunExecLikeArgs`.

*Call graph*: calls 1 internal fn (plain); called by 1 (handle_call).


##### `ShellCommandHandler::spec`  (lines 132–137)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the model-visible schema for the `shell_command` tool using the handler's option flags. It ensures the exposed contract reflects runtime capabilities such as login-shell support and permission approvals.

**Data flow**: It reads `self.options.allow_login_shell` and `self.options.exec_permission_approvals_enabled`, packages them into `CommandToolOptions`, passes that to `create_shell_command_tool`, and returns the resulting `ToolSpec`.

**Call relations**: This method is called during tool registration. It delegates schema generation to the shell spec module while supplying the runtime configuration that should shape the exposed tool contract.

*Call graph*: calls 1 internal fn (create_shell_command_tool).


##### `ShellCommandHandler::supports_parallel_tool_calls`  (lines 139–141)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that `shell_command` may be invoked in parallel with other tools. This informs the orchestrator's scheduling policy.

**Data flow**: It takes no inputs beyond `&self` and returns the constant `true`.

**Call relations**: The tool runtime queries this capability when deciding whether concurrent tool execution is allowed for this handler.


##### `ShellCommandHandler::handle`  (lines 143–145)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Adapts the async shell-command implementation into the boxed future type required by the `ToolExecutor` trait. It is a thin wrapper around `handle_call`.

**Data flow**: It accepts a `ToolInvocation`, calls `self.handle_call(invocation)`, boxes the future with `Box::pin`, and returns it.

**Call relations**: This is the trait entrypoint invoked by the tool runtime. All substantive processing is delegated to `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ShellCommandHandler::handle_call`  (lines 149–207)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Processes a `shell_command` invocation from raw payload to executed command output. It validates payload shape, parses arguments relative to the turn's cwd, emits implicit skill signals, builds `ExecParams`, and dispatches to the shared exec runner.

**Data flow**: It destructures the incoming `ToolInvocation` into session, turn, cancellation token, tracker, call ID, and payload. It computes `tool_name` via `self.tool_name()`, rejects non-function payloads with `FunctionCallError::RespondToModel`, resolves a base cwd using `resolve_workdir_base_path(&arguments, &turn.cwd)`, parses `ShellCommandToolCallParams` with `parse_arguments_with_base_path`, resolves the final workdir with `turn.resolve_path(params.workdir.clone())`, and awaits `maybe_emit_implicit_skill_invocation(session.as_ref(), turn.as_ref(), &params.command, &workdir)`. It clones `params.prefix_rule`, converts params into `ExecParams` via `Self::to_exec_params(...)`, derives `shell_type` from `session.user_shell().shell_type`, then calls `run_exec_like(RunExecLikeArgs { ... })`. On success it wraps the returned `FunctionToolOutput` with `boxed_tool_output` and returns it.

**Call relations**: This function is called only by `handle`. It delegates path-aware parsing to helper functions, delegates shell/environment translation to `to_exec_params`, and delegates actual execution, permission handling, and event emission to `run_exec_like`.

*Call graph*: calls 4 internal fn (parse_arguments_with_base_path, resolve_workdir_base_path, shell_runtime_backend, tool_name); called by 1 (handle); 5 external calls (to_exec_params, maybe_emit_implicit_skill_invocation, format!, run_exec_like, RespondToModel).


##### `ShellCommandHandler::matches_kind`  (lines 211–213)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Reports whether this runtime can handle the given payload kind. For `shell_command`, only function-style payloads are accepted.

**Data flow**: It pattern-matches `payload` with `matches!(payload, ToolPayload::Function { .. })` and returns the resulting boolean.

**Call relations**: The core runtime infrastructure calls this when selecting or validating handlers for incoming tool payloads.

*Call graph*: 1 external calls (matches!).


##### `ShellCommandHandler::waits_for_runtime_cancellation`  (lines 215–217)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Declares that this handler should wait for runtime-level cancellation behavior. This is important for long-running shell commands.

**Data flow**: It returns the constant `true` without reading or mutating additional state.

**Call relations**: The runtime uses this flag to decide how cancellation should be coordinated around shell-command execution.


##### `ShellCommandHandler::pre_tool_use_payload`  (lines 219–224)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the hook payload emitted before running the shell command. It exposes the raw command string under the bash hook tool name.

**Data flow**: It reads `invocation.payload`, extracts the command string with `shell_command_payload_command`, and if successful maps it into `PreToolUsePayload { tool_name: HookToolName::bash(), tool_input: json!({ "command": command }) }`. If extraction fails, it returns `None`.

**Call relations**: The hook system calls this before execution so external hook logic can inspect or transform the command. It depends on the shared payload-command extractor from the parent module.

*Call graph*: 1 external calls (shell_command_payload_command).


##### `ShellCommandHandler::with_updated_hook_input`  (lines 226–245)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: serde_json::Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Rewrites the invocation payload after a hook has modified the shell command input. It updates only the `command` field inside the function-argument JSON.

**Data flow**: It takes ownership of a `ToolInvocation` and a `serde_json::Value` representing updated hook input. If the invocation payload is not `ToolPayload::Function`, it returns `FunctionCallError::RespondToModel`. Otherwise it extracts the new command string with `updated_hook_command(&updated_input)?`, rewrites the original JSON argument string via `rewrite_function_string_argument(&arguments, "shell_command", "command", new_command)?`, stores the rewritten string back into `invocation.payload`, and returns the modified invocation.

**Call relations**: This method is used by the hook pipeline between pre-tool-use inspection and actual execution. It delegates command extraction and JSON rewriting to shared helpers so the shell handler can accept hook-driven command edits safely.

*Call graph*: calls 2 internal fn (rewrite_function_string_argument, updated_hook_command); 1 external calls (RespondToModel).


##### `ShellCommandHandler::post_tool_use_payload`  (lines 247–261)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the hook payload emitted after command execution, pairing the original command with the tool's wire-format response. It enables post-execution hook processing.

**Data flow**: It asks the `result` object for `post_tool_use_response(&invocation.call_id, &invocation.payload)`; if absent, it returns `None`. It also extracts the original command with `shell_command_payload_command(&invocation.payload)`; if that fails, it returns `None`. Otherwise it returns `Some(PostToolUsePayload { tool_name: HookToolName::bash(), tool_use_id: invocation.call_id.clone(), tool_input: json!({ "command": command }), tool_response })`.

**Call relations**: The hook system calls this after execution to provide both input and output context to post-tool-use hooks. It depends on the tool output exposing a wire-format response and on the shared command extractor to recover the original command.

*Call graph*: calls 2 internal fn (bash, post_tool_use_response); 2 external calls (json!, shell_command_payload_command).


### `core/src/tools/runtimes/unified_exec.rs`

`domain_logic` · `tool request handling for PTY/unified exec sessions`

This file defines the request, approval key, runtime, and tests for unified exec. `UnifiedExecRequest` carries the command, shell type, process id, trusted sandbox cwd, turn environment, env maps, optional exec-server env config, tty flag, network proxy, sandbox permissions, optional additional permissions, justification, and exec approval requirement. `UnifiedExecRuntime` stores a reference to the shared `UnifiedExecProcessManager` plus the configured shell mode (`Direct` or `ZshFork`).

Like the shell runtime, it implements `Sandboxable` and `Approvable`: approvals are keyed by canonicalized command, cwd, tty, and permission settings; approval can route through Guardian or the normal session prompt with `with_cached_approval`; and hook payloads are emitted as bash-style permission requests. It also overrides `sandbox_cwd` so the orchestrator uses the trusted sandbox cwd rather than the user-visible cwd.

The `run` method prepares a PTY launch rather than directly executing a process. It chooses the effective shell, computes shell snapshot wrapping unless the environment is remote, preserves denied-read restrictions when normalizing sandbox permissions, applies managed-network env vars only when still sandboxed, and on Unix prepends package/zsh-fork paths as needed. It then applies Windows PowerShell profile suppression and UTF-8 prefixing. In zsh-fork mode, it first builds a sandbox command and `ExecRequest`, asks the zsh-fork backend to prepare a spawn lifecycle, rejects remote environments for that path, and opens the session through the manager with the returned lifecycle. If zsh-fork preparation is unavailable, it falls back to direct unified exec using `NoopSpawnLifecycle`. Both spawn paths map `UnifiedExecError::SandboxDenied` into structured sandbox-denied `ToolError::Codex` values.

#### Function details

##### `unified_exec_options`  (lines 100–111)

```
fn unified_exec_options(
    network_denial_cancellation_token: Option<CancellationToken>,
) -> ExecOptions
```

**Purpose**: Builds the standard `ExecOptions` used for unified-exec sandbox transforms. It combines the default execution timeout with optional cancellation triggered by managed-network denial.

**Data flow**: Takes an optional `CancellationToken`. Starts from `ExecExpiration::DefaultTimeout`, adds the cancellation token with `with_cancellation` when present, and returns `ExecOptions { expiration, capture_policy: ExecCapturePolicy::ShellTool }`.

**Call relations**: Used by `UnifiedExecRuntime::run` in both zsh-fork and direct branches, and covered by a dedicated unit test.

*Call graph*: called by 2 (run, unified_exec_options_combines_default_timeout_with_network_denial_cancellation).


##### `UnifiedExecRuntime::new`  (lines 115–120)

```
fn new(manager: &'a UnifiedExecProcessManager, shell_mode: UnifiedExecShellMode) -> Self
```

**Purpose**: Constructs a unified-exec runtime bound to a shared process manager and a chosen shell mode. This is the main factory used by orchestration and tests.

**Data flow**: Stores the provided `&UnifiedExecProcessManager` and `UnifiedExecShellMode` into a new `UnifiedExecRuntime` and returns it.

**Call relations**: Created by higher-level session-opening orchestration and by tests that verify sandbox cwd and zsh-fork invariants.

*Call graph*: called by 5 (unified_exec_uses_the_trusted_sandbox_cwd, zsh_fork_execpolicy_allow_preserves_parent_sandbox_override, zsh_fork_first_attempt_preserves_additional_permissions_request, zsh_fork_first_attempt_preserves_parent_sandbox_override, open_session_with_sandbox).


##### `UnifiedExecRuntime::sandbox_preference`  (lines 124–126)

```
fn sandbox_preference(&self) -> SandboxablePreference
```

**Purpose**: Declares that unified exec should use automatic sandbox selection. It does not force a specific sandbox implementation.

**Data flow**: Returns `SandboxablePreference::Auto` without reading request state.

**Call relations**: Queried by the orchestrator through the `Sandboxable` trait when preparing unified-exec attempts.


##### `UnifiedExecRuntime::escalate_on_failure`  (lines 128–130)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Signals that unified exec supports escalation after sandbox failure. This enables the orchestrator’s retry path.

**Data flow**: Returns `true` with no side effects.

**Call relations**: Read by orchestration when deciding whether a failed first attempt may be retried with broader permissions.


##### `UnifiedExecRuntime::approval_keys`  (lines 136–144)

```
fn approval_keys(&self, req: &UnifiedExecRequest) -> Vec<Self::ApprovalKey>
```

**Purpose**: Computes the approval-cache key for unified-exec launches. The key includes tty state in addition to command, cwd, and permission settings because interactive and non-interactive launches are treated as distinct approvals.

**Data flow**: Reads `req.command`, `req.cwd`, `req.tty`, `req.sandbox_permissions`, and `req.additional_permissions`; canonicalizes the command; clones owned fields into one `UnifiedExecApprovalKey`; returns it in a single-element vector.

**Call relations**: Called by `UnifiedExecRuntime::start_approval_async` before invoking cached approval logic.

*Call graph*: called by 1 (start_approval_async); 1 external calls (vec!).


##### `UnifiedExecRuntime::start_approval_async`  (lines 146–200)

```
fn start_approval_async(
        &'b mut self,
        req: &'b UnifiedExecRequest,
        ctx: ApprovalCtx<'b>,
    ) -> BoxFuture<'b, ReviewDecision>
```

**Purpose**: Starts the approval flow for a unified-exec request, routing to Guardian review when a review id exists or otherwise to the standard session approval prompt with session caching. It includes tty and permission metadata in the approval payload.

**Data flow**: Reads request command, cwd, tty, sandbox permissions, additional permissions, justification, and exec approval requirement plus `ApprovalCtx` session/turn/call/retry/guardian/network fields. It derives approval keys, then returns a boxed future that either calls `review_approval_request` with `GuardianApprovalRequest::ExecCommand` or wraps `session.request_command_approval` in `with_cached_approval`. The future resolves to a `ReviewDecision` and may update the shared approval cache.

**Call relations**: Invoked by the orchestrator when unified exec requires approval. It mirrors the shell runtime’s approval flow but uses the unified-exec-specific Guardian payload.

*Call graph*: calls 2 internal fn (approval_keys, with_cached_approval); 2 external calls (pin, review_approval_request).


##### `UnifiedExecRuntime::exec_approval_requirement`  (lines 202–207)

```
fn exec_approval_requirement(
        &self,
        req: &UnifiedExecRequest,
    ) -> Option<ExecApprovalRequirement>
```

**Purpose**: Returns the request’s precomputed exec approval requirement. The runtime forwards rather than recalculates this policy result.

**Data flow**: Clones `req.exec_approval_requirement` and returns it inside `Some(...)`.

**Call relations**: The orchestrator consults this before deciding whether to prompt, skip, or reject execution.


##### `UnifiedExecRuntime::permission_request_payload`  (lines 209–217)

```
fn permission_request_payload(
        &self,
        req: &UnifiedExecRequest,
    ) -> Option<PermissionRequestPayload>
```

**Purpose**: Builds the approval-time hook payload for unified exec as a bash-style command plus optional justification. This lets permission-request hooks inspect the same human-readable command shown to users.

**Data flow**: Reads `req.hook_command` and `req.justification`, passes them to `PermissionRequestPayload::bash`, and returns the result in `Some(...)`.

**Call relations**: Used by approval orchestration before Guardian/user prompting when hook-based policy checks are enabled.

*Call graph*: calls 1 internal fn (bash).


##### `UnifiedExecRuntime::sandbox_permissions`  (lines 219–221)

```
fn sandbox_permissions(&self, req: &UnifiedExecRequest) -> SandboxPermissions
```

**Purpose**: Exposes the request’s desired sandbox permission mode for first-attempt sandbox selection. This preserves explicit escalation or additional-permission intent.

**Data flow**: Returns `req.sandbox_permissions` by value.

**Call relations**: Queried by the orchestrator while constructing the initial `SandboxAttempt`.


##### `UnifiedExecRuntime::sandbox_cwd`  (lines 225–227)

```
fn sandbox_cwd(&self, req: &'b UnifiedExecRequest) -> Option<&'b AbsolutePathBuf>
```

**Purpose**: Overrides the default sandbox cwd selection with the trusted `sandbox_cwd` carried in the request. This separates the user-visible cwd from the path used for sandbox policy transforms.

**Data flow**: Returns `Some(&req.sandbox_cwd)`.

**Call relations**: The orchestrator calls this trait method when preparing sandbox transforms for unified exec; a dedicated test verifies this behavior.


##### `UnifiedExecRuntime::network_approval_spec`  (lines 229–256)

```
fn network_approval_spec(
        &self,
        req: &UnifiedExecRequest,
        ctx: &ToolCtx,
    ) -> Option<NetworkApprovalSpec>
```

**Purpose**: Builds the managed-network approval specification for unified exec, including a deferred network approval mode and a Guardian trigger that records tty state. It preserves denied-read restrictions when deciding whether managed networking still applies.

**Data flow**: Reads the turn filesystem sandbox policy, normalizes `req.sandbox_permissions` with `sandbox_permissions_preserving_denied_reads`, and asks `managed_network_for_sandbox_permissions` whether a managed network proxy remains applicable. If not, returns `None`; otherwise returns `NetworkApprovalSpec` with cloned network proxy, `Deferred` mode, a `GuardianNetworkAccessTrigger` containing call id, flattened tool name, command, cwd, original sandbox/additional permissions, justification, and `tty: Some(req.tty)`, plus the hook command.

**Call relations**: Called by orchestration before launch when unified exec may need network approval.

*Call graph*: calls 3 internal fn (flat_tool_name, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads).


##### `UnifiedExecRuntime::run`  (lines 258–419)

```
async fn run(
        &mut self,
        req: &UnifiedExecRequest,
        attempt: &SandboxAttempt<'_>,
        ctx: &ToolCtx,
    ) -> Result<UnifiedExecProcess, ToolError>
```

**Purpose**: Prepares and opens a unified-exec process session under the current sandbox attempt, optionally using the zsh-fork backend on Unix. It is the main execution path for PTY-backed command sessions.

**Data flow**: Consumes `UnifiedExecRequest`, `SandboxAttempt`, and `ToolCtx`. It reads shell and environment state, computes shell snapshot wrapping unless the environment is remote, normalizes sandbox permissions to preserve denied reads, derives managed network and execution env, applies managed-network env vars when present, and on Unix mutates PATH for package and optional zsh-fork binaries. It transforms the command through snapshot wrapping, Windows PowerShell profile suppression, and optional UTF-8 prefixing. In zsh-fork mode it builds a sandbox command, computes `ExecOptions` via `unified_exec_options`, transforms through `attempt.env_for`, copies `exec_server_env_config`, and asks `zsh_fork_backend::maybe_prepare_unified_exec` for a prepared spawn. If available, it rejects remote environments for zsh-fork and opens the session with the returned lifecycle; otherwise it logs a warning and falls back. In the direct path it builds the sandbox command, transforms it, copies `exec_server_env_config`, and calls `manager.open_session_with_exec_env` with `NoopSpawnLifecycle`. It returns `UnifiedExecProcess` or maps manager errors into `ToolError`, preserving sandbox-denied outputs.

**Call relations**: This method is invoked by the tool orchestrator after approvals and sandbox attempt selection. It delegates to shell/env helpers, optionally to the zsh-fork backend, and finally to `UnifiedExecProcessManager` for actual PTY session startup.

*Call graph*: calls 11 internal fn (apply_package_path_prepend, apply_zsh_fork_path_prepend, build_sandbox_command, disable_powershell_profile_for_elevated_windows_sandbox, exec_env_for_sandbox_permissions, maybe_wrap_shell_lc_with_snapshot, unified_exec_options, env_for, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads (+1 more)); 7 external calls (new, default, Rejected, open_session_with_exec_env, matches!, warn!, maybe_prepare_unified_exec).


##### `tests::test_turn_environment`  (lines 435–442)

```
fn test_turn_environment(cwd: AbsolutePathBuf) -> TurnEnvironment
```

**Purpose**: Creates a local `TurnEnvironment` suitable for unified-exec tests. It supplies a default test environment and a cwd-derived `PathUri`.

**Data flow**: Takes an `AbsolutePathBuf` cwd, constructs `Environment::default_for_tests()`, wraps it in `Arc`, converts cwd to `PathUri::from_abs_path`, and returns `TurnEnvironment::new(...)` with no explicit shell override.

**Call relations**: Used by multiple tests to build consistent request fixtures without repeating environment setup.

*Call graph*: calls 3 internal fn (new, default_for_tests, from_abs_path); 1 external calls (new).


##### `tests::unified_exec_options_combines_default_timeout_with_network_denial_cancellation`  (lines 445–464)

```
fn unified_exec_options_combines_default_timeout_with_network_denial_cancellation()
```

**Purpose**: Verifies that `unified_exec_options` preserves the default timeout while also wiring in a network-denial cancellation token. This protects the expected expiration semantics for unified exec.

**Data flow**: Creates a `CancellationToken`, calls `unified_exec_options(Some(token))`, asserts the capture policy is `ShellTool`, pattern-matches the expiration as `TimeoutOrCancellation`, checks the timeout equals the default command timeout, cancels the token, and asserts the embedded cancellation is cancelled.

**Call relations**: This is the direct unit test for the helper used by `UnifiedExecRuntime::run`.

*Call graph*: calls 1 internal fn (unified_exec_options); 4 external calls (new, assert!, assert_eq!, panic!).


##### `tests::unified_exec_uses_the_trusted_sandbox_cwd`  (lines 467–501)

```
async fn unified_exec_uses_the_trusted_sandbox_cwd()
```

**Purpose**: Checks that the runtime reports `sandbox_cwd` rather than the user-visible cwd. This ensures sandbox transforms use the trusted path supplied in the request.

**Data flow**: Creates separate temp dirs for `cwd` and `sandbox_cwd`, builds a `UnifiedExecRuntime` and `UnifiedExecRequest`, calls `runtime.sandbox_cwd(&request)`, and asserts it equals `Some(&sandbox_cwd)`.

**Call relations**: This test targets the `ToolRuntime::sandbox_cwd` override implemented by `UnifiedExecRuntime`.

*Call graph*: calls 3 internal fn (new, default, try_from); 5 external calls (new, assert_eq!, test_turn_environment, tempdir, vec!).


##### `tests::zsh_fork_first_attempt_preserves_parent_sandbox_override`  (lines 504–526)

```
async fn zsh_fork_first_attempt_preserves_parent_sandbox_override()
```

**Purpose**: Verifies that both direct and zsh-fork unified-exec runtimes preserve a parent request’s `RequireEscalated` sandbox permission on the first attempt. The backend choice must not rewrite the caller’s sandbox intent.

**Data flow**: Builds a manager, a request with `SandboxPermissions::RequireEscalated`, constructs both direct and zsh-fork runtimes, calls `sandbox_permissions(&request)` on each, and asserts both return `RequireEscalated`.

**Call relations**: This regression test protects the `Approvable::sandbox_permissions` behavior across shell modes.

*Call graph*: calls 2 internal fn (new, default); 3 external calls (assert_eq!, test_request, zsh_fork_mode).


##### `tests::zsh_fork_first_attempt_preserves_additional_permissions_request`  (lines 529–545)

```
async fn zsh_fork_first_attempt_preserves_additional_permissions_request()
```

**Purpose**: Checks that zsh-fork unified exec preserves `WithAdditionalPermissions` on the first attempt instead of collapsing it to default sandboxing. This keeps bounded additional-permission requests sandboxed.

**Data flow**: Builds a manager, a request with `SandboxPermissions::WithAdditionalPermissions`, constructs a zsh-fork runtime, calls `sandbox_permissions(&request)`, and asserts the result is unchanged.

**Call relations**: This test guards against backend-specific rewriting of request sandbox permissions.

*Call graph*: calls 2 internal fn (new, default); 3 external calls (assert_eq!, test_request, zsh_fork_mode).


##### `tests::zsh_fork_execpolicy_allow_preserves_parent_sandbox_override`  (lines 548–567)

```
async fn zsh_fork_execpolicy_allow_preserves_parent_sandbox_override()
```

**Purpose**: Verifies that zsh-fork unified exec preserves an exec-policy `Skip { bypass_sandbox: true }` requirement. Backend adaptation must not erase policy decisions that intentionally bypass the sandbox.

**Data flow**: Builds a manager, a request with `ExecApprovalRequirement::Skip { bypass_sandbox: true, ... }`, constructs a zsh-fork runtime, calls `exec_approval_requirement(&request)`, and asserts the returned requirement matches exactly.

**Call relations**: This regression test protects the runtime’s forwarding of exec-policy approval requirements.

*Call graph*: calls 2 internal fn (new, default); 3 external calls (assert_eq!, test_request, zsh_fork_mode).


##### `tests::test_request`  (lines 569–595)

```
fn test_request(
        sandbox_permissions: SandboxPermissions,
        exec_approval_requirement: ExecApprovalRequirement,
    ) -> UnifiedExecRequest
```

**Purpose**: Builds a reusable `UnifiedExecRequest` fixture for zsh-fork-related tests. It centralizes the common command, cwd, environment, and approval fields.

**Data flow**: Takes `SandboxPermissions` and `ExecApprovalRequirement`, reads the current directory, converts it to `AbsolutePathBuf`, constructs a `UnifiedExecRequest` for `zsh -c 'echo hi'` with empty env/network and default flags, and returns it.

**Call relations**: Used by the zsh-fork preservation tests to avoid duplicating request construction.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (new, test_turn_environment, current_dir, vec!).


##### `tests::zsh_fork_mode`  (lines 597–604)

```
fn zsh_fork_mode() -> UnifiedExecShellMode
```

**Purpose**: Builds a `UnifiedExecShellMode::ZshFork` fixture with absolute paths for the zsh binary and execve wrapper. It gives tests a concrete shell-mode configuration without depending on real installed binaries.

**Data flow**: Reads the current directory, appends `zsh` and `execve-wrapper`, converts both to `AbsolutePathBuf`, constructs `ZshForkConfig`, wraps it in `UnifiedExecShellMode::ZshFork`, and returns it.

**Call relations**: Used by tests that need to instantiate a zsh-fork runtime.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (current_dir, ZshFork).
