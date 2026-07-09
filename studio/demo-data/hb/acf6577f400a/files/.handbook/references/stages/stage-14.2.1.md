# Execution-facing app-server and core command orchestration  `stage-14.2.1`

This stage is the system’s command-running control room. It sits in the main work loop, where user or assistant requests become real programs running on the computer, but with checks and safety rules in between.

On the app-server side, command_exec_processor.rs, command_exec.rs, and process_exec_processor.rs translate client messages into process actions: start a command, send input, resize a terminal, stop it, watch its output, and clean up afterward. The TUI helpers, fs.rs and workspace_command.rs, let the text interface ask the app server to read or write files and run small workspace commands, whether the workspace is local or remote.

In core, exec.rs is the actual child-process runner, while sandboxing/mod.rs packages commands for restricted execution. user_shell.rs runs explicit user shell commands and records their progress. The shell handlers and runtimes check permissions, prepare environments, emit progress, support cancellation and hooks, and then launch commands safely. unified_exec.rs and exec_command.rs provide a newer single front door for execution requests. zsh_fork_backend.rs adds a special supported zsh path when needed.

## Files in this stage

### App-server execution entrypoints
These files expose app-server-facing command and process execution APIs and manage long-lived execution sessions for client connections.

### `app-server/src/request_processors/command_exec_processor.rs`

`orchestration` · `request handling`

This processor is the bridge between a client request and the lower-level command-running machinery. Without it, the server might receive a request to run a shell command, but it would not know how to check that request, apply the project’s permissions, set up the environment, and start the process safely.

The main struct, `CommandExecRequestProcessor`, holds the pieces it needs: configuration, paths to sandbox helper programs, a sender for messages back to the client, an environment checker, and a `CommandExecManager` that actually keeps track of running commands. Think of it like a front desk for command execution: it checks the form, fills in missing defaults, rejects unsafe or contradictory choices, then hands the prepared job to the workshop.

For a new command, it first requires that a local environment is available. It then validates basics such as “the command cannot be empty,” “terminal size only makes sense when a terminal is requested,” and “you cannot set both a timeout and disable timeouts.” It builds the working directory, environment variables, output limits, timeout behavior, sandbox permissions, and optional managed network proxy. Finally, it builds an execution request and asks `CommandExecManager` to start it.

For an already-running command, this file is simpler: write, resize, terminate, and connection-close requests are passed to the manager that owns the live process state.

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

**Purpose**: Creates a command execution request processor with all the shared services it needs. It also creates a fresh `CommandExecManager`, which is the component that tracks live command sessions.

**Data flow**: It receives dispatch paths, configuration, an outgoing message sender, a configuration manager, and an environment manager. It stores those values in a new processor and initializes the command execution manager with its default empty state. The result is a ready-to-use processor object.

**Call relations**: This is called during the larger server setup when request processors are assembled. After construction, client request handling code can call this processor’s methods whenever command execution-related messages arrive.

*Call graph*: calls 1 internal fn (default); called by 1 (new).


##### `CommandExecRequestProcessor::one_off_command_exec`  (lines 31–40)

```
async fn one_off_command_exec(
        &self,
        request_id: &ConnectionRequestId,
        params: CommandExecParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Starts a new one-off command on behalf of a client request. It first makes sure the server has a local environment available, because running a local process only makes sense if there is a local place to run it.

**Data flow**: It takes a request id and command parameters from the client. It checks for a configured local environment, then passes the request to the command setup path. If the command is successfully started, it returns no immediate response payload; future output is sent separately.

**Call relations**: The initialized client request handler calls this when it receives a command execution request. This method calls `require_local_environment` as a gatekeeper, then calls `exec_one_off_command` to do the real preparation and launch work.

*Call graph*: calls 2 internal fn (exec_one_off_command, require_local_environment); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::command_exec_write`  (lines 42–51)

```
async fn command_exec_write(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecWriteParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Sends input text or bytes to an already-running command. This is used for interactive commands where the client needs to type into the process, much like typing into a terminal window.

**Data flow**: It receives the request id and write parameters from the client. It forwards them to the command execution manager, which finds the matching running process and writes the data. The manager’s response is converted into a client response payload and returned.

**Call relations**: The initialized client request handler calls this when a write request arrives. This processor does not write to the process directly; it hands the job to `CommandExecManager::write`, which owns the live process state.

*Call graph*: calls 1 internal fn (write); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::command_exec_resize`  (lines 53–62)

```
async fn command_exec_resize(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecResizeParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Changes the terminal size for an already-running command. This matters for programs that draw terminal interfaces or wrap output based on the current width and height.

**Data flow**: It receives a request id and resize parameters. It passes them to the command execution manager, which applies the new size to the matching command session. The resulting acknowledgment is converted into a client response payload.

**Call relations**: The initialized client request handler calls this when the client reports a terminal resize. This processor simply routes the request to `CommandExecManager::resize`, because the manager knows which process belongs to the request.

*Call graph*: calls 1 internal fn (resize); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::command_exec_terminate`  (lines 64–73)

```
async fn command_exec_terminate(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecTerminateParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Asks the system to stop an already-running command. This is used when the client cancels or intentionally ends a command session.

**Data flow**: It receives a request id and termination parameters. It forwards them to the command execution manager, which locates the process and terminates it according to those parameters. The manager’s response is wrapped as a client response payload.

**Call relations**: The initialized client request handler calls this for terminate requests. The processor acts as the routing layer, while `CommandExecManager::terminate` performs the actual process shutdown work.

*Call graph*: calls 1 internal fn (terminate); called by 1 (handle_initialized_client_request).


##### `CommandExecRequestProcessor::connection_closed`  (lines 75–79)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Cleans up command execution state when a client connection goes away. This prevents abandoned commands or bookkeeping from lingering after the client that started them has disconnected.

**Data flow**: It receives the id of the closed connection. It passes that id to the command execution manager, which can find command sessions tied to that connection and clean them up. It does not return a response because the connection is already closed.

**Call relations**: The server’s connection-close flow calls this method. This processor then delegates to `CommandExecManager::connection_closed`, which owns the details of cleaning up live command sessions.

*Call graph*: calls 1 internal fn (connection_closed); called by 1 (connection_closed).


##### `CommandExecRequestProcessor::require_local_environment`  (lines 81–87)

```
fn require_local_environment(&self) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Checks whether a local execution environment is configured before trying to run a command. If there is nowhere local to run processes, it turns that problem into a clear request error.

**Data flow**: It reads from the environment manager and asks whether a local environment is available. If one exists, it returns success. If not, it returns an internal error saying the local environment is not configured.

**Call relations**: `one_off_command_exec` calls this before doing any command setup. It is the early safety check that stops command execution from continuing under impossible conditions.

*Call graph*: called by 1 (one_off_command_exec).


##### `CommandExecRequestProcessor::exec_one_off_command`  (lines 89–96)

```
async fn exec_one_off_command(
        &self,
        request_id: &ConnectionRequestId,
        params: CommandExecParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts the internal command launch path while preserving the caller’s request id. It is a small wrapper that prepares ownership of the request id for the deeper asynchronous work.

**Data flow**: It receives a borrowed request id and command parameters. It clones the request id so the inner launch function can own it while running asynchronously. It returns whatever success or error comes back from the inner function.

**Call relations**: `one_off_command_exec` calls this after the local-environment check passes. This method immediately hands off to `exec_one_off_command_inner`, where validation, permission setup, sandbox setup, and process launch preparation happen.

*Call graph*: calls 1 internal fn (exec_one_off_command_inner); called by 1 (one_off_command_exec); 1 external calls (clone).


##### `CommandExecRequestProcessor::exec_one_off_command_inner`  (lines 98–344)

```
async fn exec_one_off_command_inner(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Validates a command request, turns client-friendly options into concrete execution settings, and starts the command through the command execution manager. This is the main preparation pipeline for launching a process safely and consistently.

**Data flow**: It receives an owned request id and all command parameters. It rejects invalid combinations, such as an empty command, a terminal size without terminal mode, both timeout and disabled-timeout settings, or conflicting permission systems. It then chooses the working directory, builds environment variables, converts timeout and output-limit options, resolves sandbox and permission settings, optionally starts a managed network proxy, builds a low-level execution request, converts terminal size if needed, and finally asks the command execution manager to start the command. On success, the process is launched and connected to outgoing client messages; on failure, a clear JSON-RPC error is returned.

**Call relations**: `exec_one_off_command` calls this as the real launch path. Inside, it may ask the configuration manager to load permissions for a requested working directory, translate legacy sandbox policy into the newer permission profile model, start a managed network proxy if required, and call `build_exec_request` to create the final process-launch description. At the end it hands everything to `CommandExecManager::start`, which takes over the live command session.

*Call graph*: calls 7 internal fn (start, load_for_cwd, build_exec_request, from_runtime_permissions_with_enforcement, from_legacy_sandbox_policy, from_legacy_sandbox_policy_for_cwd, from); called by 1 (exec_one_off_command); 9 external calls (new, default, clone, Cancellation, format!, default, from_config, debug!, try_from).


### `app-server/src/command_exec.rs`

`orchestration` · `request handling and command lifetime`

A client can ask the app server to run a command, much like opening a terminal tab remotely. This file keeps track of those running commands per connection, so later messages such as “write these bytes to stdin,” “make the terminal bigger,” or “terminate it” go to the right process. Without this file, command execution would be fire-and-forget: the server could not safely connect later client requests to the correct running process, stream output back, or clean up when a client disconnects.

The main piece is CommandExecManager. It stores active sessions in a shared map protected by a mutex, which is a lock that stops two async tasks changing the map at the same time. When a command starts, the manager checks the requested mode, chooses or records a process id, spawns the process using either a pseudo-terminal, pipes, or a Windows sandbox path, then launches a background task to watch it. That watcher listens for three kinds of events at once: client control messages, timeout or cancellation, and process exit.

Output is read in separate background tasks for stdout and stderr. It can either be buffered until the final response or streamed as base64 chunks. The file also contains tests for important edge cases, especially Windows sandbox limits, cancellation behavior, and what happens when a control request reaches a process that has already gone away.

#### Function details

##### `CommandExecManager::default`  (lines 54–59)

```
fn default() -> Self
```

**Purpose**: Creates a fresh command execution manager with no running sessions and a counter ready to make server-generated process ids. This is the normal starting state for the command execution subsystem.

**Data flow**: It receives no input. It builds an empty session table and an atomic counter, which is a number that can be safely updated from multiple tasks. It returns a CommandExecManager ready to accept start, write, resize, terminate, and cleanup requests.

**Call relations**: The server constructs this manager during setup, and the tests also create it directly. Later request handlers use the same manager to coordinate command execution across many client messages.

*Call graph*: called by 8 (cancellation_expiration_keeps_process_alive_until_terminated, dropped_control_request_is_reported_as_not_running, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_non_streaming_exec_uses_execution_path, windows_sandbox_process_ids_reject_terminate_requests, windows_sandbox_process_ids_reject_write_requests, windows_sandbox_streaming_exec_is_rejected, new); 4 external calls (new, new, new, new).


##### `InternalProcessId::error_repr`  (lines 134–139)

```
fn error_repr(&self) -> String
```

**Purpose**: Turns an internal process id into a clear piece of text for error messages. Client-supplied ids are formatted like JSON strings so quotes and special characters are shown safely.

**Data flow**: It reads an InternalProcessId. If the id was generated by the server, it becomes a plain number string; if it came from the client, it becomes a JSON-style string when possible. The output is only used for human-readable error text.

**Call relations**: The manager calls this when it needs to explain duplicate ids, missing processes, or processes that are no longer running. It keeps those errors understandable without exposing the enum details.

*Call graph*: 1 external calls (to_string).


##### `CommandExecManager::start`  (lines 143–306)

```
async fn start(
        &self,
        params: StartCommandExecParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts a requested command and records enough information to control it later. It also decides whether output will be streamed live or returned only once the command finishes.

**Data flow**: It receives the outgoing-message sender, request id, optional process id, execution request, streaming flags, terminal size, and output cap. It validates the request, registers the process under the current connection, spawns the command, and launches a background runner. It returns success once the command has been accepted, or a JSON-RPC error if the request is invalid or the process cannot be spawned.

**Call relations**: The higher-level one-off command executor calls this when a client asks for command/exec. For normal commands it hands the live process to run_command; for unsupported Windows streaming cases it rejects the request, and for non-streaming Windows sandbox commands it uses the core sandbox execution path and sends the final response itself.

*Call graph*: calls 4 internal fn (run_command, internal_error, invalid_request, execute_env); called by 1 (exec_one_off_command_inner); 8 external calls (clone, spawn_pipe_process, spawn_pipe_process_no_stdin, spawn_pty_process, format!, matches!, channel, spawn).


##### `CommandExecManager::write`  (lines 308–340)

```
async fn write(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecWriteParams,
    ) -> Result<CommandExecWriteResponse, JSONRPCErrorError>
```

**Purpose**: Sends client-provided input to a running command’s standard input. This is how an interactive command receives keystrokes or pasted text.

**Data flow**: It receives the request id and write parameters, including a client process id, optional base64 text, and a flag to close stdin. It checks that there is something to do, decodes the base64 bytes, and sends a write control message to the session. It returns an empty success response or an error if the input is invalid or the process cannot accept it.

**Call relations**: The command_exec_write request handler calls this. This function does not touch the process directly; it passes the work through send_control so the command’s own background runner can perform the write safely.

*Call graph*: calls 2 internal fn (send_control, invalid_params); called by 1 (command_exec_write); 2 external calls (new, Client).


##### `CommandExecManager::terminate`  (lines 342–354)

```
async fn terminate(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecTerminateParams,
    ) -> Result<CommandExecTerminateResponse, JSONRPCErrorError>
```

**Purpose**: Asks a running command to stop. This gives clients a direct way to cancel an interactive or long-running process.

**Data flow**: It receives the connection-scoped request id and terminate parameters containing the client process id. It looks up that process for the same connection and sends a terminate control message. It returns an empty success response if the request was accepted, or an error if there is no controllable process.

**Call relations**: The command_exec_terminate request handler calls this. It delegates to send_control, and the background run_command loop turns the control message into a real termination request on the process handle.

*Call graph*: calls 1 internal fn (send_control); called by 1 (command_exec_terminate); 1 external calls (Client).


##### `CommandExecManager::resize`  (lines 356–373)

```
async fn resize(
        &self,
        request_id: ConnectionRequestId,
        params: CommandExecResizeParams,
    ) -> Result<CommandExecResizeResponse, JSONRPCErrorError>
```

**Purpose**: Changes the size of an interactive terminal process. This matters for full-screen or layout-sensitive terminal programs that need to know the window rows and columns.

**Data flow**: It receives a process id and a requested terminal size from the protocol. It first converts and validates the size, then sends a resize control message to the running session. It returns an empty success response or an error if the size is invalid or the process cannot be resized.

**Call relations**: The command_exec_resize request handler calls this. It uses terminal_size_from_protocol for validation and then sends the resize through send_control to the command runner.

*Call graph*: calls 2 internal fn (send_control, terminal_size_from_protocol); called by 1 (command_exec_resize); 1 external calls (Client).


##### `CommandExecManager::connection_closed`  (lines 375–402)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Stops commands that belong to a client connection after that connection goes away. This prevents orphaned processes from continuing to run after their owner disappears.

**Data flow**: It receives a connection id. It removes every session tied to that connection from the session table, then sends terminate messages to the active ones. It does not return data; its effect is cleanup.

**Call relations**: The app server calls this from its connection cleanup path. It acts like closing all open terminal tabs when a browser window disconnects.

*Call graph*: called by 1 (connection_closed); 1 external calls (with_capacity).


##### `CommandExecManager::send_control`  (lines 404–439)

```
async fn send_control(
        &self,
        process_id: ConnectionProcessId,
        control: CommandControl,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Delivers one control instruction to a specific running command and waits to learn whether it succeeded. It centralizes the common lookup and error handling for write, terminate, and resize.

**Data flow**: It receives a connection/process key and a control command. It locks the session table, finds the session, rejects Windows sandbox placeholder sessions, sends the control through a channel, then waits on a one-time reply channel. It returns success or a JSON-RPC error that explains what went wrong.

**Call relations**: write, terminate, and resize all go through this helper. The receiving side is the run_command loop, which performs the requested action against the real process and sends the result back.

*Call graph*: calls 1 internal fn (invalid_request); called by 3 (resize, terminate, write); 1 external calls (channel).


##### `run_command`  (lines 442–554)

```
async fn run_command(params: RunCommandParams)
```

**Purpose**: Watches one spawned command from start to finish. It is the command’s background supervisor: it accepts controls, enforces expiration, collects output, and sends the final response.

**Data flow**: It receives the spawned process, output settings, expiration policy, request id, and outgoing sender. It starts stdout and stderr readers, then waits for control messages, timeout or cancellation, or process exit. After the process ends, it briefly lets remaining output drain, gathers stdout and stderr text, and sends a CommandExecResponse with the exit code and captured output.

**Call relations**: CommandExecManager::start launches this in the background for normal non-Windows-sandbox commands. It hands stdout and stderr reading to spawn_process_output and uses the process handle to apply write, resize, and terminate controls.

*Call graph*: calls 1 internal fn (spawn_process_output); called by 1 (start); 7 external calls (clone, from_millis, pin!, select!, spawn, sleep, channel).


##### `spawn_process_output`  (lines 556–618)

```
fn spawn_process_output(params: SpawnProcessOutputParams) -> tokio::task::JoinHandle<String>
```

**Purpose**: Reads one output stream from a running command, either stdout or stderr. It can stream chunks live to the client, or save them for the final command response.

**Data flow**: It receives an output byte channel, stream name, connection and process ids, output cap, and outgoing-message sender. It reads chunks, combines small chunks into larger messages, applies the byte cap, optionally sends base64 output notifications, and finally returns buffered text. If streaming is enabled, it usually returns an empty buffer because the bytes were already sent live.

**Call relations**: run_command starts one copy for stdout and one for stderr. These tasks run alongside the process supervisor, then hand their final buffered text back when the command is ending.

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

**Purpose**: Applies a write request to a process’s standard input. It also supports closing stdin, which tells the process there will be no more input.

**Data flow**: It receives the process handle, a flag saying whether stdin streaming is allowed, bytes to write, and a close flag. It rejects writes if stdin streaming was not enabled, sends any non-empty bytes to the process writer, and closes stdin if requested. It returns success or a protocol error.

**Call relations**: The command-running loop uses this when it receives a Write control request. It keeps stdin rules in one place so the manager cannot accidentally feed input into a non-interactive command.

*Call graph*: calls 1 internal fn (invalid_request); 2 external calls (close_stdin, writer_sender).


##### `handle_process_resize`  (lines 644–651)

```
fn handle_process_resize(
    session: &ProcessHandle,
    size: TerminalSize,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Applies a terminal size change to a running process. It wraps lower-level resize errors in a client-friendly protocol error.

**Data flow**: It receives a process handle and a terminal size. It asks the process handle to resize the pseudo-terminal, then returns success or an error message if the resize fails.

**Call relations**: The command-running loop uses this when it receives a Resize control request. The public resize path validates the size first, then this helper performs the actual process operation.

*Call graph*: 1 external calls (resize).


##### `terminal_size_from_protocol`  (lines 653–665)

```
fn terminal_size_from_protocol(
    size: CommandExecTerminalSize,
) -> Result<TerminalSize, JSONRPCErrorError>
```

**Purpose**: Converts the terminal size sent over the app-server protocol into the internal terminal-size type. It rejects impossible sizes such as zero rows or zero columns.

**Data flow**: It receives a protocol terminal size with row and column counts. If either value is zero, it returns an invalid-parameters error; otherwise it returns a TerminalSize with the same numbers.

**Call relations**: CommandExecManager::resize calls this before sending a resize control message. This keeps bad client input from reaching the lower-level terminal code.

*Call graph*: calls 1 internal fn (invalid_params); called by 1 (resize).


##### `command_no_longer_running_error`  (lines 667–672)

```
fn command_no_longer_running_error(process_id: &InternalProcessId) -> JSONRPCErrorError
```

**Purpose**: Builds a consistent error for control requests sent to a command that has already stopped. This avoids several different confusing failure messages for the same situation.

**Data flow**: It receives an internal process id. It formats the id for display and returns a JSON-RPC invalid-request error saying the command is no longer running.

**Call relations**: send_control uses this when the control channel is closed or the response from the runner disappears. It translates channel failure into a message that makes sense to a client.

*Call graph*: calls 1 internal fn (invalid_request); 1 external calls (format!).


##### `tests::windows_sandbox_exec_request`  (lines 696–712)

```
fn windows_sandbox_exec_request() -> ExecRequest
```

**Purpose**: Creates a standard Windows-sandbox execution request for the tests. It saves each test from repeating the same setup details.

**Data flow**: It reads the current directory, builds a simple command request for cmd, fills in sandbox and permission settings, and returns an ExecRequest.

**Call relations**: The Windows sandbox tests call this helper before exercising CommandExecManager::start. It is test scaffolding, not production behavior.

*Call graph*: calls 3 internal fn (new, read_only, current_dir); 2 external calls (new, vec!).


##### `tests::windows_sandbox_streaming_exec_is_rejected`  (lines 715–745)

```
async fn windows_sandbox_streaming_exec_is_rejected()
```

**Purpose**: Checks that streaming output is refused for Windows restricted-token sandbox execution. This protects a known unsupported mode from being accepted silently.

**Data flow**: It creates a manager, outgoing channel, request id, and Windows sandbox command request with streaming enabled. It calls start and expects an invalid-request error with the exact supported message.

**Call relations**: This test drives CommandExecManager::start through the Windows sandbox branch. It confirms the public behavior clients will see when they ask for unsupported streaming.

*Call graph*: calls 3 internal fn (disabled, default, new); 6 external calls (new, Integer, new, windows_sandbox_exec_request, assert_eq!, channel).


##### `tests::windows_sandbox_non_streaming_exec_uses_execution_path`  (lines 749–794)

```
async fn windows_sandbox_non_streaming_exec_uses_execution_path()
```

**Purpose**: Checks that a non-streaming Windows-sandbox request is accepted and routed through the sandbox execution path. On non-Windows test hosts, that path is expected to fail and report an execution error.

**Data flow**: It starts a Windows sandbox command without streaming and waits for an outgoing message. It verifies that the response is sent to the same connection and that the result is an execution error rather than an immediate validation rejection.

**Call relations**: This test calls CommandExecManager::start and observes messages from OutgoingMessageSender. It proves the special Windows sandbox branch runs asynchronously and reports back through the normal response channel.

*Call graph*: calls 3 internal fn (disabled, default, new); 10 external calls (new, from_secs, Integer, new, windows_sandbox_exec_request, assert!, assert_eq!, channel, panic!, timeout).


##### `tests::cancellation_expiration_keeps_process_alive_until_terminated`  (lines 798–879)

```
async fn cancellation_expiration_keeps_process_alive_until_terminated()
```

**Purpose**: Checks that a command using cancellation-only expiration does not stop by itself. It should stay alive until the client explicitly terminates it.

**Data flow**: It starts a long sleep command with a cancellation-style expiration, waits briefly to make sure no response arrives, then calls terminate. It then reads the final response and verifies the process ended with a nonzero exit code and no stdout.

**Call relations**: This test exercises CommandExecManager::start and CommandExecManager::terminate together. It protects the behavior of run_command when expiration is based on an external cancellation token rather than a fixed timeout.

*Call graph*: calls 6 internal fn (disabled, default, new, new, read_only, current_dir); 15 external calls (new, new, from_secs, new, Integer, new, assert!, assert_eq!, assert_ne!, Cancellation (+5 more)).


##### `tests::timeout_or_cancellation_reports_cancellation_without_timeout_exit_code`  (lines 883–951)

```
async fn timeout_or_cancellation_reports_cancellation_without_timeout_exit_code()
```

**Purpose**: Checks that when a combined timeout-or-cancellation command is cancelled, it is not reported as a timeout. This matters because timeout has a special exit code.

**Data flow**: It starts a long sleep command with both a timeout and cancellation token, immediately cancels the token, and waits for the response. It verifies that the exit code is not the timeout-specific value.

**Call relations**: This test drives the expiration handling inside run_command through CommandExecManager::start. It guards the distinction between “timed out” and “cancelled.”

*Call graph*: calls 6 internal fn (disabled, default, new, new, read_only, current_dir); 13 external calls (new, new, from_secs, new, Integer, new, assert_eq!, assert_ne!, channel, panic! (+3 more)).


##### `tests::windows_sandbox_process_ids_reject_write_requests`  (lines 954–987)

```
async fn windows_sandbox_process_ids_reject_write_requests()
```

**Purpose**: Checks that write requests are rejected for process ids registered as unsupported Windows sandbox sessions. Those sessions cannot accept interactive stdin.

**Data flow**: It manually places an UnsupportedWindowsSandbox session into the manager’s session table, then calls write with base64 input. It expects the shared unsupported-operation error.

**Call relations**: This test calls CommandExecManager::write, which goes through send_control. It verifies that send_control stops write requests before they reach any process-control channel.

*Call graph*: calls 1 internal fn (default); 4 external calls (Integer, new, Client, assert_eq!).


##### `tests::windows_sandbox_process_ids_reject_terminate_requests`  (lines 990–1021)

```
async fn windows_sandbox_process_ids_reject_terminate_requests()
```

**Purpose**: Checks that terminate requests are rejected for unsupported Windows sandbox session placeholders. This keeps the public API honest about which process modes can be controlled.

**Data flow**: It inserts an UnsupportedWindowsSandbox session into the manager, then calls terminate for that process id. It expects the same unsupported-operation invalid-request error.

**Call relations**: This test calls CommandExecManager::terminate and therefore send_control. It confirms that all control operations share the same Windows sandbox limitation.

*Call graph*: calls 1 internal fn (default); 4 external calls (Integer, new, Client, assert_eq!).


##### `tests::dropped_control_request_is_reported_as_not_running`  (lines 1024–1059)

```
async fn dropped_control_request_is_reported_as_not_running()
```

**Purpose**: Checks that if a control request is accepted into a channel but its reply disappears, the client gets a clear “no longer running” error. This covers a race where the process stops while a control request is in flight.

**Data flow**: It creates a fake active session with a control channel, spawns a task that receives and drops the request without replying, then calls terminate. It verifies that the returned error says the named process is no longer running.

**Call relations**: This test exercises CommandExecManager::terminate and send_control without starting a real process. It focuses on the error path where the background command task vanishes or drops the response.

*Call graph*: calls 1 internal fn (default); 6 external calls (Integer, new, Client, assert_eq!, channel, spawn).


### `app-server/src/request_processors/process_exec_processor.rs`

`domain_logic` · `request handling and process lifetime`

This file solves the problem of safely running shell-like commands for a client while keeping each client’s processes separate. Without it, the server could not support features like launching a command, streaming its output, sending text to its input, resizing an interactive terminal, or killing it when the client disconnects.

The top-level `ProcessExecRequestProcessor` receives client requests such as “spawn this process” or “write these bytes to stdin.” Before starting anything, it checks that a local execution environment exists, validates the request, builds the environment variables, chooses a timeout style, and converts terminal sizes into the server’s internal form.

The `ProcessExecManager` is the session registry. Think of it like a hotel front desk: each connection plus process handle gets one active “room key.” It prevents duplicate handles, remembers how to send control messages to each running process, and removes sessions when they end.

Once a process starts, `run_process` becomes its caretaker. It listens at the same time for three things: client control messages, timeout/cancellation, and process exit. Separate output collector tasks read stdout and stderr. They can either stream chunks to the client as base64 data or save capped output for the final exit notification. When the process ends, the server sends one final message with the exit code and captured output.

#### Function details

##### `ProcessExecRequestProcessor::new`  (lines 57–66)

```
fn new(
        outgoing: Arc<OutgoingMessageSender>,
        environment_manager: Arc<EnvironmentManager>,
    ) -> Self
```

**Purpose**: Creates a request processor for process execution requests. It stores the object used to send messages back to clients, the environment checker, and a fresh process session registry.

**Data flow**: It receives shared access to the outgoing message sender and the environment manager. It builds a new `ProcessExecRequestProcessor` around them and creates a default, empty `ProcessExecManager` for future processes.

**Call relations**: This is used when the larger server creates its request processors. Later, client request handling calls the methods on the processor created here.

*Call graph*: called by 1 (new); 1 external calls (default).


##### `ProcessExecRequestProcessor::process_spawn`  (lines 68–143)

```
async fn process_spawn(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessSpawnParams,
    ) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Starts a new process for a client after checking that the request is valid and that local execution is available. This is the entry point for the client’s `process/spawn` request.

**Data flow**: It receives a request id and spawn parameters, including the command, working directory, process handle, terminal mode, environment changes, timeout, and output limits. It rejects empty commands or handles, rejects terminal sizes when no terminal is requested, merges environment overrides into the current environment, converts timeout and terminal-size settings, then passes a prepared start request to `ProcessExecManager::start`. If all goes well, it returns no direct payload because the spawn response is sent by the manager.

**Call relations**: The initialized client request handler calls this when a client asks to spawn a process. This method first calls `require_local_environment`, then hands the actual process setup to `ProcessExecManager::start`.

*Call graph*: calls 4 internal fn (invalid_params, invalid_request, start, require_local_environment); called by 1 (handle_initialized_client_request); 6 external calls (new, Cancellation, format!, vars, debug!, try_from).


##### `ProcessExecRequestProcessor::process_write_stdin`  (lines 145–154)

```
async fn process_write_stdin(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessWriteStdinParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Accepts a client request to send bytes into a running process’s standard input, commonly called stdin. This is how an interactive command receives typed input from the client.

**Data flow**: It receives the client request id and stdin-write parameters, then forwards them to the process manager. The manager validates and sends the data to the right running process. The returned protocol response is wrapped as a client response payload.

**Call relations**: The initialized client request handler calls this for stdin-write requests. It delegates all real work to `ProcessExecManager::write_stdin`.

*Call graph*: calls 1 internal fn (write_stdin); called by 1 (handle_initialized_client_request).


##### `ProcessExecRequestProcessor::process_resize_pty`  (lines 156–165)

```
async fn process_resize_pty(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessResizePtyParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Accepts a client request to resize an interactive terminal process. This matters for full-screen or layout-sensitive terminal programs that need to know the visible rows and columns.

**Data flow**: It receives the request id and the requested terminal size. It forwards them to the manager, which checks the size and sends a resize command to the process. The resulting resize response is wrapped as a client response payload.

**Call relations**: The initialized client request handler calls this when a client sends a terminal resize request. It passes the work to `ProcessExecManager::resize_pty`.

*Call graph*: calls 1 internal fn (resize_pty); called by 1 (handle_initialized_client_request).


##### `ProcessExecRequestProcessor::process_kill`  (lines 167–176)

```
async fn process_kill(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessKillParams,
    ) -> Result<Option<ClientResponsePayload>, JSONRPCErrorError>
```

**Purpose**: Accepts a client request to stop a running process. This gives the client a clean way to terminate a command it previously started.

**Data flow**: It receives the request id and the process handle to kill. It asks the manager to send a kill control message to that process, then wraps the successful kill response for the client.

**Call relations**: The initialized client request handler calls this for kill requests. It delegates to `ProcessExecManager::kill`, which finds the session and contacts the running process task.

*Call graph*: calls 1 internal fn (kill); called by 1 (handle_initialized_client_request).


##### `ProcessExecRequestProcessor::connection_closed`  (lines 178–182)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Cleans up processes when a client connection goes away. This prevents abandoned commands from continuing to run after their owner has disconnected.

**Data flow**: It receives a connection id. It forwards that id to the process manager, which finds all processes owned by that connection and asks them to terminate.

**Call relations**: The server’s connection cleanup path calls this when a connection closes. It passes the event to `ProcessExecManager::connection_closed`.

*Call graph*: calls 1 internal fn (connection_closed); called by 1 (connection_closed).


##### `ProcessExecRequestProcessor::require_local_environment`  (lines 184–190)

```
fn require_local_environment(&self) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Checks that the server is configured to run commands in a local environment. It stops process spawning early if local execution is not available.

**Data flow**: It reads the environment manager and asks whether a local environment exists. If it does, it returns success. If not, it returns an internal JSON-RPC error saying local execution is not configured.

**Call relations**: `process_spawn` calls this before doing any spawn setup. That keeps later process-launch code from running when the server cannot actually execute local commands.

*Call graph*: called by 1 (process_spawn).


##### `ProcessExecManager::start`  (lines 265–353)

```
async fn start(&self, params: StartProcessParams) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Registers and launches a new process session, then starts a background task to supervise it. It also prevents one client connection from reusing the same active process handle twice.

**Data flow**: It receives fully prepared start parameters: command, working directory, environment, timeout, terminal settings, stream options, and output cap. It splits the command into program plus arguments, creates a control channel, stores the session under the connection-and-handle key, spawns either a terminal process or a piped process, sends the spawn response to the client, and launches `run_process` in the background. If spawning fails, it removes the session entry and returns an error.

**Call relations**: `process_spawn` calls this after validating the client request. Once the operating-system process is created, this function hands ongoing supervision to `run_process`, and that background task removes the session when it finishes.

*Call graph*: calls 3 internal fn (internal_error, invalid_request, run_process); called by 1 (process_spawn); 7 external calls (clone, spawn_pipe_process, spawn_pipe_process_no_stdin, spawn_pty_process, format!, channel, spawn).


##### `ProcessExecManager::write_stdin`  (lines 355–384)

```
async fn write_stdin(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessWriteStdinParams,
    ) -> Result<ProcessWriteStdinResponse, JSONRPCErrorError>
```

**Purpose**: Validates and forwards client input to a running process’s stdin. It supports both sending bytes and closing stdin.

**Data flow**: It receives the request id and stdin-write parameters. It rejects a request that neither sends data nor closes stdin. If data is present, it decodes the base64 text into raw bytes. It then sends a `Write` control request to the matching process session and returns an empty success response.

**Call relations**: `ProcessExecRequestProcessor::process_write_stdin` calls this for client stdin requests. It uses `send_control` to contact the background `run_process` task for the target process.

*Call graph*: calls 2 internal fn (invalid_params, send_control); called by 1 (process_write_stdin); 1 external calls (new).


##### `ProcessExecManager::kill`  (lines 386–398)

```
async fn kill(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessKillParams,
    ) -> Result<ProcessKillResponse, JSONRPCErrorError>
```

**Purpose**: Asks a running process to terminate. It is the manager-level implementation behind the client’s kill request.

**Data flow**: It receives the request id and kill parameters, including the process handle. It sends a `Kill` control request to the matching process session. If the control message succeeds, it returns an empty kill response.

**Call relations**: `ProcessExecRequestProcessor::process_kill` calls this. It uses `send_control`, which delivers the request to the `run_process` loop supervising that process.

*Call graph*: calls 1 internal fn (send_control); called by 1 (process_kill).


##### `ProcessExecManager::resize_pty`  (lines 400–414)

```
async fn resize_pty(
        &self,
        request_id: ConnectionRequestId,
        params: ProcessResizePtyParams,
    ) -> Result<ProcessResizePtyResponse, JSONRPCErrorError>
```

**Purpose**: Changes the row and column size of an interactive terminal process. It is only meaningful for processes started with a pseudo-terminal, which is a software terminal window.

**Data flow**: It receives the request id and resize parameters. It converts the protocol size into the internal terminal-size type, rejecting zero rows or columns, then sends a `Resize` control request to the matching process. On success, it returns an empty resize response.

**Call relations**: `ProcessExecRequestProcessor::process_resize_pty` calls this for terminal resize requests. It calls `terminal_size_from_protocol` for validation, then uses `send_control` to reach the process supervisor.

*Call graph*: calls 2 internal fn (send_control, terminal_size_from_protocol); called by 1 (process_resize_pty).


##### `ProcessExecManager::connection_closed`  (lines 416–442)

```
async fn connection_closed(&self, connection_id: ConnectionId)
```

**Purpose**: Finds and terminates all running processes that belong to a disconnected client. This is cleanup that protects the server from orphaned work.

**Data flow**: It receives a connection id. It locks the session table, gathers every process key for that connection, removes those sessions from the table, and then sends each one a `Kill` control request without waiting for a client-facing response.

**Call relations**: `ProcessExecRequestProcessor::connection_closed` calls this during connection cleanup. The kill messages go to the background process tasks, which then request termination from their process handles.

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

**Purpose**: Sends a control command, such as write, resize, or kill, to one active process and waits for the result. This is the shared path used by the manager’s process-control methods.

**Data flow**: It receives a connection id, a process handle, and the control action to perform. It looks up the active session, creates a one-time response channel, sends the control request to the process’s control queue, then waits for the process task to report success or failure. If the process cannot be found or has stopped receiving commands, it returns a clear request error.

**Call relations**: `write_stdin`, `resize_pty`, and `kill` all call this. The message it sends is received inside `run_process`, which performs the requested action and replies through the one-time channel.

*Call graph*: called by 3 (kill, resize_pty, write_stdin); 1 external calls (channel).


##### `run_process`  (lines 476–597)

```
async fn run_process(params: RunProcessParams)
```

**Purpose**: Supervises one running process from start to finish. It watches for client commands, timeout or cancellation, process exit, and output collection.

**Data flow**: It receives the process handle, output streams, control receiver, timeout rules, stream settings, and message sender. It starts separate collectors for stdout and stderr. Then it waits in a loop for control messages, expiration, or process exit. Writes, resizes, and kills are applied to the process session. If the timeout fires, it asks the process to terminate and reports the special timeout exit code. After exit, it gives output readers a short grace period to drain remaining data, gathers captured output, and sends a final `ProcessExited` notification to the client.

**Call relations**: `ProcessExecManager::start` launches this as a background task after spawning the operating-system process. It calls `collect_spawn_process_output` for stdout and stderr, and uses `handle_process_write` and `handle_process_resize` when control messages arrive.

*Call graph*: calls 1 internal fn (collect_spawn_process_output); called by 1 (start); 8 external calls (clone, from_millis, ProcessExited, pin!, select!, spawn, sleep, channel).


##### `collect_spawn_process_output`  (lines 599–664)

```
fn collect_spawn_process_output(
    params: SpawnProcessOutputParams,
) -> tokio::task::JoinHandle<ProcessOutputCapture>
```

**Purpose**: Reads one output stream from a process, either stdout or stderr. It can stream chunks live to the client or collect capped text for the final exit message.

**Data flow**: It receives the connection id, process handle, output receiver, timeout signal, outgoing message sender, stream name, streaming flag, and byte cap. It starts a background task that reads byte chunks, combines nearby chunks up to a helpful size, applies the output byte limit, and either sends base64-encoded output-delta notifications or stores the bytes locally. It stops when the stream ends, the drain timeout fires, or the cap is reached, then returns captured text and whether the cap was reached.

**Call relations**: `run_process` calls this twice, once for stdout and once for stderr. The returned task handles are awaited after the process exits so `run_process` can include the captured output in the final notification.

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

**Purpose**: Applies a stdin write request to the actual process session. It also closes stdin when the client asks to send end-of-input.

**Data flow**: It receives the process session, whether stdin streaming is enabled, raw bytes to write, and a close flag. If stdin streaming was not enabled for this process, it returns an error. Otherwise it sends any non-empty byte data to the process writer. If requested, it closes stdin after the accepted bytes have been queued.

**Call relations**: `run_process` calls this when it receives a `Write` control request from `send_control`. Its success or error is sent back to the original client request through the control response channel.

*Call graph*: calls 1 internal fn (invalid_request); 2 external calls (close_stdin, writer_sender).


##### `handle_process_resize`  (lines 692–699)

```
fn handle_process_resize(
    session: &ProcessHandle,
    size: TerminalSize,
) -> Result<(), JSONRPCErrorError>
```

**Purpose**: Applies a terminal resize request to the actual process session. This lets terminal-aware programs adapt to a changed window size.

**Data flow**: It receives the process session and the new terminal size. It asks the process handle to resize. If the lower-level resize fails, it converts that failure into a client-readable invalid-request error.

**Call relations**: `run_process` calls this when it receives a `Resize` control request. The result is returned through the same control-response path used for writes and kills.

*Call graph*: 1 external calls (resize).


##### `terminal_size_from_protocol`  (lines 701–713)

```
fn terminal_size_from_protocol(
    size: ProcessTerminalSize,
) -> Result<TerminalSize, JSONRPCErrorError>
```

**Purpose**: Converts a terminal size sent by the client into the internal terminal-size type. It also enforces that both rows and columns are positive numbers.

**Data flow**: It receives a protocol terminal size with rows and columns. If either value is zero, it returns an invalid-parameters error. Otherwise it builds and returns the internal `TerminalSize` value.

**Call relations**: `process_spawn` uses this when an initial terminal size is included, and `ProcessExecManager::resize_pty` uses it for resize requests.

*Call graph*: calls 1 internal fn (invalid_params); called by 1 (resize_pty).


##### `no_active_process_error`  (lines 715–719)

```
fn no_active_process_error(process_handle: &str) -> JSONRPCErrorError
```

**Purpose**: Builds a clear error for the case where a client refers to a process handle that is not currently active.

**Data flow**: It receives a process-handle string and formats it into an invalid-request error message. The output is a JSON-RPC error object suitable for returning to the client.

**Call relations**: `ProcessExecManager::send_control` uses this when the session table has no matching active process.

*Call graph*: calls 1 internal fn (invalid_request); 1 external calls (format!).


##### `process_no_longer_running_error`  (lines 721–723)

```
fn process_no_longer_running_error(process_handle: &str) -> JSONRPCErrorError
```

**Purpose**: Builds a clear error for the case where a process existed but stopped before a control command could complete.

**Data flow**: It receives a process-handle string and formats it into an invalid-request error message. The output is a JSON-RPC error explaining that the process is no longer running.

**Call relations**: `ProcessExecManager::send_control` uses this when sending a control message fails or when the process supervisor disappears before replying.

*Call graph*: calls 1 internal fn (invalid_request); 1 external calls (format!).


### TUI command forwarding
These files provide the TUI-side helpers that package workspace command requests and route them to the app-server.

### `tui/src/app_server_session/fs.rs`

`io_transport` · `request handling`

The TUI sometimes needs to work with files that belong to the app server’s world, not just files it can directly touch itself. This file is the adapter for those file operations. Think of it like a front desk: the TUI says “please read this file” or “please create this folder,” and the front desk sends the request to the right place in the right format.

The important wrinkle is that there are two ways to talk to the app server. If the server is remote, the code sends a JSON-RPC request. JSON-RPC is a simple message format where each request has a method name, an id, and some JSON parameters. If the server is running in the same process, the code builds a typed Rust request and sends it directly to the local client. The caller does not need to care which route is used.

Raw file bytes are converted to base64, a text-safe encoding, when they must travel through JSON. Reading does the reverse: it receives base64 text and turns it back into bytes. The shared helper, `request_fs_path`, keeps all the routing, path checking, response parsing, and error wrapping in one place so the individual file actions stay small and clear.

#### Function details

##### `AppServerSession::fs_create_directory_all_path`  (lines 24–42)

```
async fn fs_create_directory_all_path(
        &mut self,
        path: &AppServerPath,
    ) -> Result<()>
```

**Purpose**: Creates a directory at an app-server path, including any missing parent directories. Someone would use this before writing files into a folder that may not exist yet.

**Data flow**: It receives an app-server path. It builds a create-directory request with `recursive` set to true, meaning “make the whole folder chain if needed,” and also prepares the same information as JSON for the remote case. It sends the request through the session and returns success with no value, or an error if the server could not create the directory.

**Call relations**: This is one of the small, user-facing file helpers on `AppServerSession`. When higher-level TUI code needs a folder to exist, it calls this method; this method turns that intention into the app server’s filesystem request format and relies on the shared request path machinery to deliver it.

*Call graph*: 1 external calls (json!).


##### `AppServerSession::fs_write_file_path`  (lines 44–64)

```
async fn fs_write_file_path(
        &mut self,
        path: &AppServerPath,
        bytes: Vec<u8>,
    ) -> Result<()>
```

**Purpose**: Writes a set of bytes to a file path owned by the app server. It is used when the TUI has file content in memory and needs the app server side to store it.

**Data flow**: It receives an app-server path and raw bytes. Because JSON messages cannot safely carry arbitrary raw bytes, it first turns the bytes into base64 text. It then builds a write-file request containing the path and encoded data, sends it through the session, and returns either success with no value or an error from the app server.

**Call relations**: This method sits between higher-level TUI actions and the app server’s file-writing API. The caller only provides a path and bytes; this method takes care of the encoding and hands the request into the same filesystem request route used by the other operations.

*Call graph*: 1 external calls (json!).


##### `AppServerSession::fs_read_file_path`  (lines 66–81)

```
async fn fs_read_file_path(&mut self, path: &AppServerPath) -> Result<Vec<u8>>
```

**Purpose**: Reads a file from an app-server path and returns its contents as raw bytes. It also checks that the server’s response really contains valid base64 data.

**Data flow**: It receives an app-server path. It asks the app server to read that file and expects a response containing the file content as base64 text. It decodes that text back into bytes and returns them; if the response is not valid base64, it returns a clear error saying the read result was invalid.

**Call relations**: When the TUI needs file contents, this method starts the read request and delegates the actual local-versus-remote routing to `AppServerSession::request_fs_path`. After that helper returns the structured read response, this method performs the final decoding step so callers get ordinary bytes instead of transport-friendly text.

*Call graph*: calls 1 internal fn (request_fs_path); 1 external calls (json!).


##### `AppServerSession::fs_remove_path`  (lines 83–99)

```
async fn fs_remove_path(&mut self, path: &AppServerPath) -> Result<()>
```

**Purpose**: Asks the app server to remove a file-system path. It does not explicitly request recursive deletion or force deletion, so the app server’s normal remove behavior applies.

**Data flow**: It receives an app-server path. It builds a remove request using that path, leaves the optional recursive and force flags unset, sends the request through the session, and returns success with no value or an error if removal failed.

**Call relations**: This is the TUI’s simple delete operation for app-server files. Higher-level code calls it when something should be removed, and this method translates that into the app server protocol before handing it to the common request-routing helper.

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

**Purpose**: Sends one filesystem request to the app server and returns the typed response. Its main job is to hide the difference between a remote app server reached through JSON-RPC and an in-process app server reached through direct typed calls.

**Data flow**: It receives a method name, an app-server path, a way to build the local typed request, and JSON parameters for the remote request. It creates a new request id, checks what kind of app-server connection this session has, and then chooses a route. For a remote server, it sends a JSON-RPC message and converts the JSON response into the expected response type. For an in-process server, it first verifies that the path is an absolute local path, builds the typed request, and sends it through the local client. In either route, it returns the decoded response or an error with context about which filesystem method failed.

**Call relations**: This is the common bridge underneath the file helpers. `AppServerSession::fs_read_file_path` calls it when reading a file, and the surrounding filesystem methods use the same pattern so their callers do not need to know how the app server is connected. It hands off to JSON-RPC response parsing in the remote case and to the local typed client in the in-process case.

*Call graph*: calls 2 internal fn (as_str, from_absolute_path_checked); called by 1 (fs_read_file_path); 1 external calls (from_value).


### `tui/src/workspace_command.rs`

`io_transport` · `background command execution during TUI request handling and status refreshes`

The TUI sometimes needs to ask the project workspace simple questions in the background, such as running a Git or GitHub command to refresh status information. This file is the bridge for that. Instead of letting each TUI feature decide how to run a process, it gives them one shared shape: a program name, arguments, an optional working directory, optional environment changes, a timeout, and a limit on how much output can be captured.

The important idea is that commands are described as argument lists, not shell strings. That means callers do not have to worry about quoting file names or user-provided text, which avoids a common source of bugs and security problems. The command is then sent to the app-server as a `command/exec` request. The app-server is the part of the system that knows where the active workspace really lives and what execution rules apply.

Most commands are capped and timed out so a background refresh cannot accidentally become a long-running or memory-hungry process. If a feature truly needs full output, such as a visible diff, it can explicitly turn the cap off. A normal command failure, like Git returning a non-zero exit code, comes back as command output. Only communication or protocol failures become `WorkspaceCommandError`.

#### Function details

##### `WorkspaceCommand::new`  (lines 54–63)

```
fn new(argv: impl IntoIterator<Item = impl Into<String>>) -> Self
```

**Purpose**: Creates a new workspace command from a program and its arguments, with safe default limits. It is the usual starting point for callers that want to run a small, non-interactive workspace probe.

**Data flow**: It receives an iterable list of command parts, such as `git`, `status`, and flags. It turns each part into a string, stores them as the command argument list, and fills in defaults: no custom working directory, no environment overrides, a 5-second timeout, a 64 KiB output cap, and output capping turned on. The result is a ready-to-customize `WorkspaceCommand` value.

**Call relations**: Higher-level helpers such as `run_gh_command`, `run_git_command`, and `run_probe` call this when they need a command object to send through the workspace runner. After creation, callers may add details like a working directory or timeout before handing the command to a runner.

*Call graph*: called by 4 (run_gh_command, run_git_command, run_probe, run_git_command); 3 external calls (from_secs, new, into_iter).


##### `WorkspaceCommand::cwd`  (lines 66–69)

```
fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self
```

**Purpose**: Sets the working directory for the command. A caller uses this when the command should run somewhere other than the app-server session’s default directory.

**Data flow**: It takes an existing `WorkspaceCommand` and a path-like value. It converts the value into a `PathBuf`, stores it as the command’s `cwd`, and returns the updated command so the caller can keep chaining setup steps.

**Call relations**: This is part of the builder-style setup for `WorkspaceCommand`. It is used before the command reaches `AppServerWorkspaceCommandRunner::run`, which passes the chosen directory along to the app-server.

*Call graph*: 1 external calls (into).


##### `WorkspaceCommand::env`  (lines 72–75)

```
fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self
```

**Purpose**: Adds or replaces one environment variable override for the command. This lets a caller change the command’s environment without changing the whole TUI process environment.

**Data flow**: It receives a command, an environment variable name, and a value. It converts both to strings and stores the value as an override in the command’s environment map. The updated command is returned for further setup or execution.

**Call relations**: This is another builder-style customization step. When `AppServerWorkspaceCommandRunner::run` later sends the command, it includes these overrides only if at least one was set.

*Call graph*: 1 external calls (into).


##### `WorkspaceCommand::timeout`  (lines 78–81)

```
fn timeout(mut self, timeout: Duration) -> Self
```

**Purpose**: Changes how long the command is allowed to run before the app-server cancels it. Callers use this when the default 5-second limit is too short or too long for a particular background task.

**Data flow**: It takes an existing command and a duration. It replaces the command’s timeout field with that duration and returns the updated command.

**Call relations**: This setup happens before execution. `AppServerWorkspaceCommandRunner::run` later converts the duration into milliseconds and sends it to the app-server as part of the command request.


##### `WorkspaceCommand::disable_output_cap`  (lines 84–87)

```
fn disable_output_cap(mut self) -> Self
```

**Purpose**: Requests full stdout and stderr capture instead of the normal size limit. This is for features that intentionally need complete command output rather than just a small metadata result.

**Data flow**: It takes an existing command, flips the `disable_output_cap` flag to true, and returns the updated command. The original numeric output cap remains stored, but the later request tells the app-server not to apply it.

**Call relations**: Callers use this during command setup when bounded output would be wrong. `AppServerWorkspaceCommandRunner::run` reads this flag and sends both the disabled-cap flag and the appropriate cap setting to the app-server.


##### `WorkspaceCommandOutput::success`  (lines 103–105)

```
fn success(&self) -> bool
```

**Purpose**: Answers whether the command exited successfully. It gives callers a simple way to treat exit code zero as success and any other exit code as a normal command-level failure.

**Data flow**: It reads the `exit_code` stored in a `WorkspaceCommandOutput`. If the code is `0`, it returns `true`; otherwise it returns `false`. It does not change anything.

**Call relations**: Callers use this after `AppServerWorkspaceCommandRunner::run` returns command output. This keeps ordinary process failures separate from `WorkspaceCommandError`, which means the app-server request itself failed before a command result was available.


##### `WorkspaceCommandError::new`  (lines 118–122)

```
fn new(message: impl Into<String>) -> Self
```

**Purpose**: Builds a workspace command error from a message. It is used when the command could not be completed because of an app-server or transport problem, not because the command returned a non-zero exit code.

**Data flow**: It receives something that can become a string, converts it into the stored error message, and returns a `WorkspaceCommandError` containing that message.

**Call relations**: The runner uses this inside `AppServerWorkspaceCommandRunner::run` when the app-server request fails. It wraps the lower-level error text in the file’s own error type so callers see one consistent kind of infrastructure failure.

*Call graph*: 1 external calls (into).


##### `WorkspaceCommandError::fmt`  (lines 126–128)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Controls how a `WorkspaceCommandError` is shown as text. This lets logs, user-facing messages, or other error displays print the stored message cleanly.

**Data flow**: It receives the error and a formatter, then writes the error’s message string into that formatter. The visible result is just the message text.

**Call relations**: This is used automatically by Rust’s standard formatting and error-reporting paths when code displays a `WorkspaceCommandError`. It supports the error value created by `WorkspaceCommandError::new`.

*Call graph*: 1 external calls (write_str).


##### `AppServerWorkspaceCommandRunner::new`  (lines 159–161)

```
fn new(request_handle: AppServerRequestHandle) -> Self
```

**Purpose**: Creates a command runner tied to the current app-server request handle. The handle is the connection point used to ask the app-server to run commands.

**Data flow**: It receives an `AppServerRequestHandle`, stores it inside a new `AppServerWorkspaceCommandRunner`, and returns that runner. No request is sent yet.

**Call relations**: The TUI setup flow calls this from `run` when it has an app-server session available. Later, TUI background features use the returned runner through the `WorkspaceCommandExecutor` trait to execute workspace commands.

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

**Purpose**: Sends one workspace command to the app-server and returns the captured exit code, stdout, and stderr. This is the main bridge between TUI background command requests and the app-server’s actual command execution.

**Data flow**: It receives a `WorkspaceCommand`. It converts the timeout to milliseconds, omits the environment map if it is empty, creates a unique request id, and builds a `command/exec` request with no terminal, no input stream, no output streaming, the requested working directory, environment, timeout, and output cap settings. It sends that request through the stored app-server handle. If the request succeeds, it turns the app-server response into `WorkspaceCommandOutput`; if the request itself fails, it turns the failure into `WorkspaceCommandError`.

**Call relations**: This implements the `WorkspaceCommandExecutor` trait, so callers can depend on the trait instead of this concrete app-server runner. It hands the real work to `request_typed`, which speaks to the app-server, and then translates the response back into the small output type used by TUI code.

*Call graph*: calls 1 internal fn (request_typed); 4 external calls (pin, String, format!, try_from).


### Core execution foundation
These files define the shared execution request bridge and the core engine that actually launches and manages command execution.

### `core/src/exec.rs`

`orchestration` · `request handling`

This file is the execution engine for commands. A caller gives it an `ExecParams` value, which is like a job ticket: command words, working folder, environment variables, timeout or cancellation rules, network proxy settings, and sandbox choices. The file first converts that portable request into a concrete `ExecRequest`, choosing the right sandbox for the operating system and permission profile. A sandbox is a restricted area for a process, like putting a messy experiment inside a sealed lab box so it cannot touch the rest of the machine.

After setup, the file starts the command, reads both stdout and stderr, optionally streams live output events, and keeps a capped copy so a runaway command cannot fill memory. It also watches for timeouts, cancellation, and Ctrl-C. If the command must stop, it tries to stop the whole process group, not just the first process, because shells often start children of their own.

The file also contains Windows-specific safety checks. Windows has more than one sandbox backend, and this code decides when extra filesystem rules are needed or when a request must be refused rather than run with weaker protection. Finally, it normalizes raw process results into `ExecToolCallOutput`, including special errors for timeout and likely sandbox denial.

#### Function details

##### `windows_sandbox_uses_elevated_backend`  (lines 117–125)

```
fn windows_sandbox_uses_elevated_backend(
    sandbox_level: WindowsSandboxLevel,
    proxy_enforced: bool,
) -> bool
```

**Purpose**: Decides whether a Windows command must use the elevated sandbox backend. This matters because network proxy enforcement on Windows depends on sandbox identities that only that backend provides.

**Data flow**: It receives the configured Windows sandbox level and a yes/no flag saying whether a managed proxy is being enforced. It returns true if the proxy is enforced or the level is explicitly elevated; otherwise it returns false.

**Call relations**: The request-building path calls this before choosing Windows filesystem overrides, and the Windows execution path calls it again before launching the command so both setup and launch agree on the backend.

*Call graph*: called by 2 (build_exec_request, exec_windows_sandbox); 1 external calls (matches!).


##### `select_process_exec_tool_sandbox_type`  (lines 137–150)

```
fn select_process_exec_tool_sandbox_type(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    network_sandbox_policy: NetworkSandboxPolicy,
    windows_sandbox_level: codex_protocol::config_
```

**Purpose**: Chooses the initial sandbox style for an exec command based on filesystem permissions, network permissions, Windows settings, and whether managed network enforcement is active.

**Data flow**: It takes the runtime permission policies and asks `SandboxManager` to pick the best sandbox automatically. The result is a `SandboxType`, such as no sandbox, a Linux sandbox, or a Windows restricted-token sandbox.

**Call relations**: It is used by `build_exec_request` while turning user-facing command settings into the concrete request that later execution code can run.

*Call graph*: calls 1 internal fn (new); called by 1 (build_exec_request).


##### `ExecExpiration::from`  (lines 182–184)

```
fn from(timeout_ms: u64) -> Self
```

**Purpose**: Converts a timeout value in milliseconds into an `ExecExpiration`, which is the file’s common way to say when a command should stop early.

**Data flow**: It receives a millisecond value, wraps it as a `Duration`, and returns a timeout-based expiration rule.

**Call relations**: This conversion is used wherever callers want to pass a simple number but the execution engine needs the richer `ExecExpiration` type.

*Call graph*: 2 external calls (from_millis, Timeout).


##### `ExecExpiration::wait_with_outcome`  (lines 189–214)

```
async fn wait_with_outcome(self) -> ExecExpirationOutcome
```

**Purpose**: Waits until an expiration condition happens and says whether it was a timeout or a cancellation. This lets the process-stopping code choose the right shutdown behavior.

**Data flow**: It consumes an expiration rule. For a timeout, it sleeps until the duration passes; for cancellation, it waits for the cancellation token; for both, it waits for whichever happens first. It returns `TimedOut` or `Cancelled`.

**Call relations**: `consume_output` calls this while the child process is running, racing it against the child’s natural exit.

*Call graph*: called by 1 (consume_output); 3 external calls (from_millis, select!, sleep).


##### `ExecExpiration::timeout_ms`  (lines 217–226)

```
fn timeout_ms(&self) -> Option<u64>
```

**Purpose**: Extracts the timeout part of an expiration rule as milliseconds, if there is one. This is useful for code that needs to pass timeouts to lower-level sandbox APIs.

**Data flow**: It reads the expiration variant. Timeout variants become a number of milliseconds, default timeout becomes the configured default, and pure cancellation returns nothing.

**Call relations**: The Windows sandbox path uses this style of information when it needs to pass timeout and cancellation separately to the Windows sandbox implementation.


##### `ExecExpiration::cancellation_token`  (lines 229–237)

```
fn cancellation_token(&self) -> Option<CancellationToken>
```

**Purpose**: Extracts the cancellation token from an expiration rule, if cancellation is part of it. A cancellation token is a shared signal that tells async work to stop.

**Data flow**: It reads the expiration variant. If the variant includes a token, it clones and returns it; if it is timeout-only, it returns nothing.

**Call relations**: The Windows sandbox execution path uses this to convert Codex cancellation into the Windows sandbox’s cancellation callback form.


##### `ExecExpiration::with_cancellation`  (lines 239–260)

```
fn with_cancellation(self, cancellation: CancellationToken) -> Self
```

**Purpose**: Adds a new cancellation signal to an existing expiration rule. This lets higher-level code layer a fresh stop signal on top of an existing timeout or cancellation.

**Data flow**: It takes the current expiration and another cancellation token. Timeout-only rules become timeout-or-cancellation rules; cancellation rules are combined so either token can stop the command.

**Call relations**: It calls `cancel_when_either` when two cancellation tokens need to be merged into one shared signal.

*Call graph*: calls 1 internal fn (cancel_when_either); 2 external calls (from_millis, Cancellation).


##### `cancel_when_either`  (lines 263–277)

```
fn cancel_when_either(
    first: CancellationToken,
    second: CancellationToken,
) -> CancellationToken
```

**Purpose**: Creates one cancellation token that fires when either of two input tokens fires. It is like wiring two doorbells to the same light.

**Data flow**: It receives two cancellation tokens, creates a new token, and starts a background async task. That task waits for either input token to be cancelled, then cancels the new combined token.

**Call relations**: `ExecExpiration::with_cancellation` uses this to merge cancellation sources. The graph also shows `try_run_zsh_fork` using it for the same “stop if either signal happens” pattern.

*Call graph*: called by 2 (with_cancellation, try_run_zsh_fork); 3 external calls (new, select!, spawn).


##### `ExecCapturePolicy::retained_bytes_cap`  (lines 280–285)

```
fn retained_bytes_cap(self) -> Option<usize>
```

**Purpose**: Decides how much command output should be kept in memory. Shell-style commands are capped; trusted internal helpers may keep all output.

**Data flow**: It reads the capture policy. `ShellTool` returns the standard byte cap, while `FullBuffer` returns no cap.

**Call relations**: `consume_output` uses this before reading stdout and stderr, and the Windows sandbox path applies the same policy to captured text.

*Call graph*: called by 1 (consume_output).


##### `ExecCapturePolicy::io_drain_timeout`  (lines 287–289)

```
fn io_drain_timeout(self) -> Duration
```

**Purpose**: Gives the maximum time to wait for stdout and stderr reader tasks to finish after the child process exits. This prevents hangs when grandchildren keep pipes open.

**Data flow**: It returns a fixed duration based on `IO_DRAIN_TIMEOUT_MS`.

**Call relations**: `consume_output` uses this when waiting for the output-reading tasks after the process has stopped.

*Call graph*: called by 1 (consume_output); 1 external calls (from_millis).


##### `ExecCapturePolicy::uses_expiration`  (lines 291–296)

```
fn uses_expiration(self) -> bool
```

**Purpose**: Says whether this capture policy should obey timeout and cancellation rules. Normal shell commands do; full-buffer internal helpers do not.

**Data flow**: It reads the capture policy and returns true for `ShellTool`, false for `FullBuffer`.

**Call relations**: `consume_output` uses this to decide whether to race the child process against expiration. The Windows sandbox path uses the same idea before passing timeout and cancellation into Windows sandbox code.

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

**Purpose**: Main high-level entry for running an exec tool call. It prepares the sandboxed request and sends it through the unified sandbox execution path.

**Data flow**: It receives command parameters, permission profile, sandbox working directory, platform-specific sandbox details, and optional live-output streaming. It builds an `ExecRequest`, then passes that request to `execute_env`, which returns final command output or an error.

**Call relations**: Tests and command-running helpers call this when they want the same behavior as the real exec tool. It delegates setup to `build_exec_request` and actual execution to the sandboxing module.

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

**Purpose**: Turns a portable command request into the exact sandbox-aware execution request the rest of the system can run. This is where permissions, sandbox type, environment, network proxy, and Windows filesystem rules come together.

**Data flow**: It takes `ExecParams` plus permission and platform context. It applies network proxy variables, splits the command into program and arguments, converts paths into URI form, asks the sandbox manager to transform the command, adds execution options, and resolves Windows-specific filesystem overrides. It returns an `ExecRequest` or an error.

**Call relations**: `process_exec_tool_call` and one-off command execution call this before running anything. It calls sandbox selection, permission conversion, Windows backend choice, and the Windows override resolvers so `execute_exec_request` receives a ready-to-run request.

*Call graph*: calls 7 internal fn (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides, select_process_exec_tool_sandbox_type, windows_sandbox_uses_elevated_backend, to_runtime_permissions, new, from_abs_path); called by 2 (exec_one_off_command_inner, process_exec_tool_call); 1 external calls (debug!).


##### `execute_exec_request`  (lines 440–494)

```
async fn execute_exec_request(
    exec_request: ExecRequest,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
) -> Result<ExecToolCallOutput>
```

**Purpose**: Runs an already-built execution request and converts the raw process result into the public output type. It is the bridge between prepared sandbox instructions and final user-visible results.

**Data flow**: It unpacks the `ExecRequest`, rebuilds the lower-level `ExecParams`, records the start time, collects raw output, measures duration, and finalizes the result. It returns `ExecToolCallOutput` or a structured error.

**Call relations**: The sandboxing layer and shell-command paths call this after request construction. It calls `get_raw_output_result` to actually run the process, then `finalize_exec_result` to interpret what happened.

*Call graph*: calls 2 internal fn (finalize_exec_result, get_raw_output_result); called by 3 (execute_env, execute_exec_request_with_after_spawn, execute_user_shell_command); 1 external calls (now).


##### `get_raw_output_result`  (lines 497–524)

```
async fn get_raw_output_result(
    params: ExecParams,
    network_sandbox_policy: NetworkSandboxPolicy,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
```

**Purpose**: Chooses the concrete execution route for a request: Windows sandbox capture when needed, or the general process-spawning path otherwise.

**Data flow**: It receives execution parameters, network policy, streaming hooks, sandbox type, permission profile, and Windows sandbox context. On Windows restricted-token sandbox requests it calls the Windows sandbox runner; otherwise it calls the normal `exec` function. It returns raw stdout, stderr, exit status, and timeout information.

**Call relations**: `execute_exec_request` calls this after preparing timing. It hands off either to `exec_windows_sandbox` on Windows sandbox cases or to `exec` for the regular async child-process path.

*Call graph*: calls 2 internal fn (exec, exec_windows_sandbox); called by 1 (execute_exec_request).


##### `extract_create_process_as_user_error_code`  (lines 527–537)

```
fn extract_create_process_as_user_error_code(err: &str) -> Option<String>
```

**Purpose**: Pulls a Windows `CreateProcessAsUserW` numeric error code out of an error message string. This supports cleaner metrics for sandbox launch failures.

**Data flow**: It scans the text for a known marker, then reads the following digits. If the marker or digits are missing, it returns nothing; otherwise it returns the code as text.

**Call relations**: `record_windows_sandbox_spawn_failure` calls this before emitting telemetry about Windows sandbox process-creation failures.

*Call graph*: called by 1 (record_windows_sandbox_spawn_failure).


##### `windowsapps_path_kind`  (lines 540–552)

```
fn windowsapps_path_kind(path: &str) -> &'static str
```

**Purpose**: Classifies a Windows executable path related to WindowsApps. This helps telemetry distinguish packaged apps, app aliases, and other paths.

**Data flow**: It lowercases the path string and checks for known WindowsApps folder patterns. It returns a short category name.

**Call relations**: `record_windows_sandbox_spawn_failure` uses this category as one of the labels on the failure metric.

*Call graph*: called by 1 (record_windows_sandbox_spawn_failure).


##### `record_windows_sandbox_spawn_failure`  (lines 555–590)

```
fn record_windows_sandbox_spawn_failure(
    command_path: Option<&str>,
    windows_sandbox_level: codex_protocol::config_types::WindowsSandboxLevel,
    err: &str,
)
```

**Purpose**: Records telemetry when the Windows sandbox fails to start a command through `CreateProcessAsUserW`. This helps maintainers see which errors and command locations are causing sandbox launch trouble.

**Data flow**: It receives the command path, sandbox level, and error text. It extracts the Windows error code, derives the executable name and path kind, labels the sandbox level, and increments a metrics counter if telemetry is available.

**Call relations**: `exec_windows_sandbox` calls this only when sandbox launch returns an error, before converting that failure into an I/O error for the caller.

*Call graph*: calls 2 internal fn (extract_create_process_as_user_error_code, windowsapps_path_kind); called by 1 (exec_windows_sandbox); 3 external calls (new, global, matches!).


##### `exec_windows_sandbox`  (lines 593–747)

```
async fn exec_windows_sandbox(
    params: ExecParams,
    permission_profile: &PermissionProfile,
    windows_sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_workspace_roots: &[AbsolutePath
```

**Purpose**: Runs a command through the Windows sandbox implementation and captures its output. It covers both elevated and restricted-token Windows sandbox backends.

**Data flow**: It receives command parameters, permission profile, Windows workspace roots, and optional filesystem overrides. It applies network environment changes, converts expiration into timeout and cancellation pieces, finds Codex home, chooses the Windows backend, runs the blocking Windows sandbox call on a blocking thread, trims output if needed, aggregates stdout and stderr, and returns raw output.

**Call relations**: `get_raw_output_result` calls this for Windows restricted-token sandbox execution. It calls `windows_sandbox_uses_elevated_backend` to choose the backend, records launch failures through `record_windows_sandbox_spawn_failure`, and uses `aggregate_output` and `synthetic_exit_status` to shape the raw result.

*Call graph*: calls 4 internal fn (aggregate_output, record_windows_sandbox_spawn_failure, synthetic_exit_status, windows_sandbox_uses_elevated_backend); called by 1 (get_raw_output_result); 8 external calls (other, format!, Io, clone, spawn_blocking, is_empty, to_vec, vec!).


##### `finalize_exec_result`  (lines 749–807)

```
fn finalize_exec_result(
    raw_output_result: std::result::Result<RawExecToolCallOutput, CodexErr>,
    sandbox_type: SandboxType,
    duration: Duration,
) -> Result<ExecToolCallOutput>
```

**Purpose**: Turns raw process data into the final exec-tool output or a structured sandbox error. This is where timeouts, signals, and likely sandbox denials become meaningful to callers.

**Data flow**: It receives raw output, sandbox type, and elapsed time. It checks for timeout signals, maps timeout exit codes, converts captured bytes to text, builds `ExecToolCallOutput`, and returns either success, timeout error with output, sandbox-denied error with output, or the original execution error.

**Call relations**: `execute_exec_request` calls this after raw execution finishes. It calls `is_likely_sandbox_denied` to decide whether a nonzero exit should be reported as a sandbox denial.

*Call graph*: calls 1 internal fn (is_likely_sandbox_denied); called by 1 (execute_exec_request); 4 external calls (new, Sandbox, Signal, error!).


##### `is_likely_sandbox_denied`  (lines 814–869)

```
fn is_likely_sandbox_denied(
    sandbox_type: SandboxType,
    exec_output: &ExecToolCallOutput,
) -> bool
```

**Purpose**: Guesses whether a failed command was blocked by the sandbox rather than failing for an ordinary reason. The file cannot know perfectly, so it uses conservative clues.

**Data flow**: It receives the sandbox type and final command output. It ignores unsandboxed or successful commands, searches output text for common denial phrases, rejects common shell error codes, and on Unix recognizes a Linux seccomp signal pattern. It returns true only when the evidence points to sandbox denial.

**Call relations**: `finalize_exec_result` uses this to convert some failures into `SandboxErr::Denied`. Other mapping and checking code also calls it when interpreting exec results.

*Call graph*: called by 4 (finalize_exec_result, run, map_exec_result, check_for_sandbox_denial_with_text).


##### `append_capped`  (lines 881–888)

```
fn append_capped(dst: &mut Vec<u8>, src: &[u8], max_bytes: usize)
```

**Purpose**: Adds bytes to a buffer without letting the buffer grow past a maximum size. This is a small safety helper against huge command output.

**Data flow**: It receives a destination byte vector, a source byte slice, and a byte limit. If the destination is already full it does nothing; otherwise it copies only as many source bytes as still fit.

**Call relations**: `read_output` calls this while reading stdout or stderr whenever the capture policy has a memory cap.

*Call graph*: called by 1 (read_output).


##### `aggregate_output`  (lines 890–932)

```
fn aggregate_output(
    stdout: &StreamOutput<Vec<u8>>,
    stderr: &StreamOutput<Vec<u8>>,
    max_bytes: Option<usize>,
) -> StreamOutput<Vec<u8>>
```

**Purpose**: Builds one combined output stream from stdout and stderr. This gives callers a single “what did the command say?” view while still preserving separate streams elsewhere.

**Data flow**: It receives captured stdout, captured stderr, and an optional byte cap. Without a cap, it concatenates all stdout then stderr. With a cap, it keeps within the limit and, under pressure, reserves more space for stderr while letting unused space go back to stdout.

**Call relations**: `consume_output` calls this after both pipes are read. `exec_windows_sandbox` calls it after receiving captured text from the Windows sandbox backend.

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

**Purpose**: Starts a command as an async child process and prepares to capture its output. This function does not decide sandbox rules; it assumes the command already includes any needed sandbox wrapper.

**Data flow**: It receives execution parameters, network sandbox policy, optional output streaming, and an optional callback to run after spawn. It applies network environment variables, splits program and arguments, calls `spawn_child_async`, invokes the callback if present, and passes the child process to `consume_output`.

**Call relations**: `get_raw_output_result` calls this for the regular non-Windows-sandbox route. It hands off process creation to `spawn_child_async` and output collection to `consume_output`.

*Call graph*: calls 2 internal fn (consume_output, spawn_child_async); called by 1 (get_raw_output_result); 1 external calls (from).


##### `permission_profile_supports_windows_restricted_token_sandbox`  (lines 1001–1010)

```
fn permission_profile_supports_windows_restricted_token_sandbox(
    permission_profile: &PermissionProfile,
) -> bool
```

**Purpose**: Checks whether a permission profile can be enforced by the unelevated Windows restricted-token sandbox. Some profiles are too broad or external to enforce safely there.

**Data flow**: It reads the permission profile. Managed profiles are allowed only if their filesystem policy does not grant full disk write access; disabled and external profiles return false.

**Call relations**: Both Windows filesystem override resolvers call this before deciding whether the Windows sandbox can safely run the request.

*Call graph*: called by 2 (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `unsupported_windows_restricted_token_sandbox_reason`  (lines 1013–1036)

```
fn unsupported_windows_restricted_token_sandbox_reason(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_level: Windo
```

**Purpose**: Provides a human-readable reason why a Windows sandbox setup is not supported. It is a diagnostic wrapper around the same checks used during real request building.

**Data flow**: It receives the sandbox type, permission profile, policy working directory, and Windows sandbox level. It runs the elevated or restricted-token override resolver as appropriate and returns the resolver’s error message, if any.

**Call relations**: It delegates all real checking to `resolve_windows_elevated_filesystem_overrides` or `resolve_windows_restricted_token_filesystem_overrides`, matching the choice that `build_exec_request` makes.

*Call graph*: calls 2 internal fn (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `resolve_windows_restricted_token_filesystem_overrides`  (lines 1038–1172)

```
fn resolve_windows_restricted_token_filesystem_overrides(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    windows_sandbox_level: Win
```

**Purpose**: Works out extra filesystem restrictions for the unelevated Windows restricted-token sandbox, or refuses requests that this backend cannot enforce safely.

**Data flow**: It receives the sandbox type, permission profile, policy working directory, and Windows sandbox level. If the request is not for this backend, it returns no overrides. Otherwise it compares modern split filesystem rules with the older compatible projection, checks for unsupported read restrictions or writable-root shapes, gathers extra deny-write paths, and returns overrides or an explanatory error.

**Call relations**: `build_exec_request` calls this when the elevated backend is not being used. `unsupported_windows_restricted_token_sandbox_reason` calls it for diagnostics. It uses helpers for profile support, root read access, display names, and path normalization.

*Call graph*: calls 6 internal fn (normalize_windows_override_path, permission_profile_display_name, permission_profile_supports_windows_restricted_token_sandbox, windows_policy_has_root_read_access, to_runtime_permissions, as_path); called by 2 (build_exec_request, unsupported_windows_restricted_token_sandbox_reason); 4 external calls (new, compatibility_sandbox_policy_for_permission_profile, resolve_windows_deny_read_paths, format!).


##### `normalize_windows_override_path`  (lines 1174–1178)

```
fn normalize_windows_override_path(path: &Path) -> std::result::Result<PathBuf, String>
```

**Purpose**: Cleans up and validates a Windows override path as an absolute path. This makes path comparisons more reliable.

**Data flow**: It receives a path, simplifies it, converts it into the project’s absolute-path type, and then returns the underlying `PathBuf`. If the path is not absolute or valid, it returns an error string.

**Call relations**: `resolve_windows_restricted_token_filesystem_overrides` calls this while comparing and collecting writable and read-only paths.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (resolve_windows_restricted_token_filesystem_overrides); 1 external calls (simplified).


##### `windows_policy_has_root_read_access`  (lines 1180–1188)

```
fn windows_policy_has_root_read_access(
    file_system_sandbox_policy: &FileSystemSandboxPolicy,
    cwd: &AbsolutePathBuf,
) -> bool
```

**Purpose**: Checks whether a filesystem sandbox policy can read from the filesystem root when interpreted from the sandbox working directory. This affects what Windows read-root overrides are needed.

**Data flow**: It finds the topmost ancestor of the working directory path, then asks the filesystem policy whether that root can be read. It returns false if no root can be found or the policy denies it.

**Call relations**: Both Windows override resolvers use this to decide whether read restrictions require special handling or are unsupported for a backend.

*Call graph*: calls 2 internal fn (can_read_path_with_cwd, as_path); called by 2 (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `resolve_windows_elevated_filesystem_overrides`  (lines 1190–1317)

```
fn resolve_windows_elevated_filesystem_overrides(
    sandbox: SandboxType,
    permission_profile: &PermissionProfile,
    sandbox_policy_cwd: &AbsolutePathBuf,
    use_windows_elevated_backend: bool
```

**Purpose**: Works out filesystem overrides for the elevated Windows sandbox backend. This backend can enforce more split read and write rules, but still refuses shapes it cannot safely represent.

**Data flow**: It receives sandbox type, permission profile, policy working directory, and a flag saying whether the elevated backend is in use. If not relevant, it returns no overrides. Otherwise it checks profile support, computes deny-read paths, detects unsupported reopened writable descendants, compares readable and writable roots against legacy projections, gathers extra deny-write paths, and returns the needed override bundle or an error.

**Call relations**: `build_exec_request` calls this when elevated Windows sandboxing is selected. `unsupported_windows_restricted_token_sandbox_reason` also calls it for diagnostics. It relies on helper checks such as `has_reopened_writable_descendant`, `windows_policy_has_root_read_access`, and `permission_profile_supports_windows_restricted_token_sandbox`.

*Call graph*: calls 6 internal fn (has_reopened_writable_descendant, permission_profile_display_name, permission_profile_supports_windows_restricted_token_sandbox, windows_policy_has_root_read_access, to_runtime_permissions, as_path); called by 2 (build_exec_request, unsupported_windows_restricted_token_sandbox_reason); 5 external calls (new, new, compatibility_sandbox_policy_for_permission_profile, resolve_windows_deny_read_paths, format!).


##### `permission_profile_display_name`  (lines 1319–1325)

```
fn permission_profile_display_name(permission_profile: &PermissionProfile) -> &'static str
```

**Purpose**: Returns a short stable name for a permission profile. It is used in error messages so users and logs can identify which profile could not be enforced.

**Data flow**: It reads the permission profile variant and returns `Managed`, `Disabled`, or `External`.

**Call relations**: Both Windows filesystem override resolvers call this when building refusal messages.

*Call graph*: called by 2 (resolve_windows_elevated_filesystem_overrides, resolve_windows_restricted_token_filesystem_overrides).


##### `has_reopened_writable_descendant`  (lines 1327–1344)

```
fn has_reopened_writable_descendant(
    writable_roots: &[codex_protocol::protocol::WritableRoot],
) -> bool
```

**Purpose**: Detects a filesystem rule pattern where a path is marked read-only but a child path underneath it is made writable again. The Windows elevated sandbox cannot enforce that directly here.

**Data flow**: It receives writable-root rules. For each read-only subpath, it checks whether another writable root sits inside that subpath. It returns true if such a reopened descendant exists.

**Call relations**: `resolve_windows_elevated_filesystem_overrides` calls this and refuses the request if the pattern is present.

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

**Purpose**: Watches a running child process, reads its stdout and stderr, streams live chunks if requested, and stops the process when needed. This is the heart of process lifetime control.

**Data flow**: It receives a spawned child process, expiration rule, capture policy, and optional stream target. It takes the child’s stdout and stderr pipes, starts reader tasks, races process exit against timeout, cancellation, or Ctrl-C, kills or terminates process groups when necessary, waits briefly for output readers, aggregates output, and returns raw process output.

**Call relations**: `exec` calls this after spawning the child. It calls `read_output` for both pipes, uses `ExecExpiration::wait_with_outcome` for timeout or cancellation, asks the capture policy for caps and drain timeout, and calls `aggregate_output` at the end.

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

**Purpose**: Continuously reads one output pipe, keeps a capped copy, and optionally sends live output events. It is used separately for stdout and stderr.

**Data flow**: It receives an async reader, optional stream information, a flag saying whether this is stderr, and an optional byte cap. It reads chunks until end-of-file, sends up to a fixed number of delta events, appends bytes to the retained buffer with or without a cap, and returns the captured bytes.

**Call relations**: `consume_output` starts this twice, once for stdout and once for stderr. It calls `append_capped` when output retention has a size limit.

*Call graph*: calls 1 internal fn (append_capped); called by 1 (consume_output); 3 external calls (read, with_capacity, ExecCommandOutputDelta).


##### `synthetic_exit_status`  (lines 1556–1561)

```
fn synthetic_exit_status(code: i32) -> ExitStatus
```

**Purpose**: Creates an `ExitStatus` value from a raw numeric code when no real process status is available. This lets timeout and sandbox-capture paths look like normal process exits to later code.

**Data flow**: It receives an integer code and converts it into the platform’s raw `ExitStatus` representation.

**Call relations**: `exec_windows_sandbox` uses it for captured Windows sandbox exit codes. `synthetic_exit_status_for_code` also uses it on Windows.

*Call graph*: called by 2 (exec_windows_sandbox, synthetic_exit_status_for_code); 1 external calls (from_raw).


##### `synthetic_exit_status_for_code`  (lines 1564–1566)

```
fn synthetic_exit_status_for_code(code: i32) -> ExitStatus
```

**Purpose**: Creates an `ExitStatus` that represents a normal exit code rather than a signal-style raw status. This is used for cancellation-style exits.

**Data flow**: It receives an integer exit code and turns it into an `ExitStatus` in the platform-correct way.

**Call relations**: `consume_output` uses this when cancellation stops a command but the result should be treated as a regular nonzero exit rather than a timeout signal.

*Call graph*: calls 1 internal fn (synthetic_exit_status); 1 external calls (from_raw).


### `core/src/sandboxing/mod.rs`

`orchestration` · `request handling`

When Codex runs a shell command, it may need to limit what that command can see or do. For example, it might block network access, restrict file access, or use a Windows or macOS sandbox. Other parts of the system decide the sandbox policy and may rewrite the command to fit that policy. This file turns that prepared sandbox command back into the form the core executor understands.

The main type is `ExecRequest`, which is like a job ticket for running a command. It includes the command itself, the working folder, environment variables, timeout rules, output-capture rules, network proxy information, sandbox type, Windows sandbox settings, and permission policies. Without this shared ticket, the executor would not have one clear place to read all the safety and runtime instructions it needs.

There are two ways to build the ticket. `ExecRequest::new` builds one directly from caller-provided values. `ExecRequest::from_sandbox_exec_request` builds one after the sandboxing crate has already transformed the command. That second path also adds small environment flags that tell child processes about sandbox state, such as disabled network access or macOS Seatbelt sandboxing.

Finally, this file exposes simple async wrapper functions that hand the completed request to `execute_exec_request`, the real command-running machinery.

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

**Purpose**: Builds a fresh `ExecRequest`, which is the complete set of instructions needed to run one command safely. Callers use it when they already know the command, folder, environment, timeout, output rules, sandbox choice, and permission profile.

**Data flow**: It takes the command details, current directory, environment variables, network option, expiration rule, output-capture rule, sandbox settings, Windows sandbox settings, permission profile, and optional replacement program name. It copies the current directory for the Windows sandbox policy folder, asks the permission profile to turn itself into runtime file-system and network rules, then stores everything in a single `ExecRequest`. The result is a ready-to-run request with no exec-server environment config and no Windows filesystem overrides yet.

**Call relations**: This constructor is used mainly by tests such as `cancellation_expiration_keeps_process_alive_until_terminated`, `timeout_or_cancellation_reports_cancellation_without_timeout_exit_code`, `windows_sandbox_exec_request`, and `test_exec_request`. In those flows, the tests create a realistic execution ticket and then check that later command-running or sandbox behavior works as expected.

*Call graph*: calls 1 internal fn (to_runtime_permissions); called by 4 (cancellation_expiration_keeps_process_alive_until_terminated, timeout_or_cancellation_reports_cancellation_without_timeout_exit_code, windows_sandbox_exec_request, test_exec_request); 1 external calls (clone).


##### `ExecRequest::from_sandbox_exec_request`  (lines 103–155)

```
fn from_sandbox_exec_request(
        request: SandboxExecRequest,
        options: ExecOptions,
        windows_sandbox_workspace_roots: Vec<AbsolutePathBuf>,
    ) -> Self
```

**Purpose**: Converts a sandbox-prepared request into the core executor's `ExecRequest` format. This is used after sandbox policy code has already decided how the command should be run.

**Data flow**: It receives a `SandboxExecRequest`, extra execution options such as timeout and output-capture policy, and the Windows workspace roots. It unpacks the sandbox request, adds environment markers when needed, combines those values with the execution options, and returns a full `ExecRequest`. If network access is not enabled, it adds an environment variable saying the sandbox network is disabled. On macOS, if the sandbox type is Seatbelt, it adds an environment variable saying the command is running under that sandbox.

**Call relations**: This function is called by `prepare_sandboxed_exec` when a command has gone through sandbox preparation and must be handed back to the core executor. It is also called by `env_for`, which needs to build or inspect the environment that a sandboxed execution would receive.

*Call graph*: called by 2 (prepare_sandboxed_exec, env_for).


##### `execute_env`  (lines 158–163)

```
async fn execute_env(
    exec_request: ExecRequest,
    stdout_stream: Option<StdoutStream>,
) -> codex_protocol::error::Result<ExecToolCallOutput>
```

**Purpose**: Runs an `ExecRequest` and optionally streams its standard output. This is the simple path for callers that do not need a special callback immediately after the process starts.

**Data flow**: It receives a completed execution request and an optional `StdoutStream`, which is a way to forward output as the command runs. It passes both to `execute_exec_request` with no after-spawn callback, waits for the command to finish, and returns the command output or an error.

**Call relations**: Higher-level flows such as `start`, `process_exec_tool_call`, and `run` call this when they are ready to execute a prepared command. This function then hands the work to `execute_exec_request`, which performs the actual process launch and collection of results.

*Call graph*: calls 1 internal fn (execute_exec_request); called by 3 (start, process_exec_tool_call, run).


##### `execute_exec_request_with_after_spawn`  (lines 165–171)

```
async fn execute_exec_request_with_after_spawn(
    exec_request: ExecRequest,
    stdout_stream: Option<StdoutStream>,
    after_spawn: Option<Box<dyn FnOnce() + Send>>,
) -> codex_protocol::error::R
```

**Purpose**: Runs an `ExecRequest` while also allowing the caller to provide a one-time action that runs just after the child process starts. This is useful when code needs a precise hook after launch but before waiting for completion.

**Data flow**: It takes a completed execution request, an optional output stream, and an optional boxed callback function. It passes all three to `execute_exec_request`, waits for execution to finish, and returns the final tool-call output or an error. The request itself is consumed by the executor.

**Call relations**: `run` calls this variant when it needs the extra after-spawn hook. This wrapper does not execute the command itself; it forwards the request, output stream, and callback to `execute_exec_request`, which owns the real launch and result-gathering work.

*Call graph*: calls 1 internal fn (execute_exec_request); called by 1 (run).


### Shell task and shared shell orchestration
These files cover the direct user shell task plus the common handler and runtime path used to turn shell-like tool requests into approved executions.

### `core/src/tasks/user_shell.rs`

`orchestration` · `request handling`

This file is the bridge between a user typing a shell command and Codex actually running it on the host machine. Without it, a user could not use the explicit full-access shell escape hatch, and the rest of the system would not get the normal events that say “this command started,” “this output was produced,” and “this command finished.”

The main task stores the raw command text, then, when run, hands it to `execute_user_shell_command`. That function first announces a new turn when the shell command is being run as its own turn. It then finds the session’s local shell and working directory. If either is missing or cannot be represented on the Codex host, it sends a clear error event instead of trying to run anything.

Before launching the process, it builds the environment variables for the command. It deliberately removes Codex’s managed proxy setting, because `/shell` is meant to be full access and should not inherit the session’s proxy. It also prepares the command so shell features like pipes and redirects work, and, on Unix systems, preserves runtime-added PATH entries when replaying a shell snapshot.

During execution it streams output to the session. At the end, whether the command succeeds, fails, is cancelled, or cannot be started, it sends a final event and records the output in the conversation history in the right way for either a standalone shell turn or an auxiliary command inside an already-active turn.

#### Function details

##### `UserShellCommandTask::new`  (lines 65–67)

```
fn new(command: String) -> Self
```

**Purpose**: Creates a shell-command task from the command text the user supplied. This gives the session task system a small object it can schedule and run later.

**Data flow**: It receives a command string → stores that string inside a new `UserShellCommandTask` → returns the task ready to be queued.

**Call relations**: The higher-level shell command entry flow calls this when it needs to turn a user command into a session task. The returned task later participates in the normal task lifecycle, where its `run` method performs the actual execution.

*Call graph*: called by 1 (run_user_shell_command).


##### `UserShellCommandTask::kind`  (lines 71–73)

```
fn kind(&self) -> TaskKind
```

**Purpose**: Labels this as a regular session task. The task scheduler can use that label to treat it like normal work rather than a special background or control task.

**Data flow**: It reads no outside data → returns the fixed task kind `Regular` → does not change anything.

**Call relations**: This is called by the session task machinery when it needs to classify the task. It does not call other project logic; it simply supplies the scheduler with this task’s category.


##### `UserShellCommandTask::span_name`  (lines 75–77)

```
fn span_name(&self) -> &'static str
```

**Purpose**: Provides the tracing name used when observing this task. A tracing name is a label that helps logs and performance tools show what kind of work is currently happening.

**Data flow**: It reads no outside data → returns the fixed text label `session_task.user_shell` → does not change any state.

**Call relations**: The task framework can ask for this name while setting up tracing around the task. The label helps connect logs and timing information back to user shell execution.


##### `UserShellCommandTask::run`  (lines 79–95)

```
async fn run(
        self: Arc<Self>,
        session: Arc<SessionTaskContext>,
        turn_context: Arc<TurnContext>,
        _input: Vec<TurnInput>,
        cancellation_token: CancellationToken,
```

**Purpose**: Runs the stored shell command as a standalone session turn. It is the task-system entry point that hands the real work to the shared shell execution function.

**Data flow**: It receives the session task context, turn context, unused turn input, and a cancellation token → extracts the real session object and clones the saved command → calls the shell execution routine in standalone-turn mode → returns no follow-up text.

**Call relations**: The session task framework calls this when the queued shell task is ready to run. It delegates to `execute_user_shell_command`, which does the environment setup, process launch, event reporting, and persistence.

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

**Purpose**: Runs a user shell command from start to finish and tells the rest of the system what happened. It is responsible for setup, safety choices, live output streaming, final status reporting, cancellation behavior, and saving the result.

**Data flow**: It receives a session, turn context, raw command text, cancellation token, and mode → records telemetry, optionally sends a turn-start event, finds the shell and working directory, builds the command environment, removes managed proxy settings, prepares the actual command line, sends a command-start event, and launches the process → on completion, cancellation, or launch failure, it sends a command-end event and persists a record of the command output.

**Call relations**: This is called by `UserShellCommandTask::run` for standalone shell tasks. Inside the flow it calls `create_env` to build environment variables, `prepare_user_shell_exec_command` to shape the command for the chosen shell, `execute_exec_request` to actually run the process, `format_exec_output_str` to make readable final output, `send_user_shell_error` for early setup failures, and `persist_user_shell_output` after every completed or failed execution path.

*Call graph*: calls 10 internal fn (execute_exec_request, create_env, persist_user_shell_output, prepare_user_shell_exec_command, send_user_shell_error, format_exec_output_str, strip_managed_proxy_env, now_unix_timestamp_ms, new, parse_command); called by 1 (run); 7 external calls (new, new_v4, error!, format!, ExecCommandBegin, ExecCommandEnd, TurnStarted).


##### `send_user_shell_error`  (lines 360–370)

```
async fn send_user_shell_error(session: &Session, turn_context: &TurnContext, message: &str)
```

**Purpose**: Sends a user-visible error event when the shell command cannot even be started. This is used for setup problems, such as no shell being available.

**Data flow**: It receives the session, turn context, and an error message → wraps the message in an error event → sends that event through the session to the client.

**Call relations**: `execute_user_shell_command` calls this when it detects a problem before process execution begins. It hands the message to the session event channel so the user or client sees a clear failure instead of silence.

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

**Purpose**: Builds the final command line that should be passed to the process runner. It accounts for the current shell, possible shell snapshots, explicit environment settings, and platform-specific PATH behavior.

**Data flow**: It receives the display command, shell description, optional shell snapshot path, explicit environment variables, and the mutable execution environment → on Unix, it adds runtime-owned PATH entries through a helper before possible snapshot wrapping; on non-Unix systems, it directly applies snapshot wrapping logic → returns the command arguments that should be executed.

**Call relations**: `execute_user_shell_command` calls this after creating the base environment and before launching the process. On Unix it delegates to `prepare_user_shell_exec_command_with_path_prepend`; on other platforms it calls `maybe_wrap_shell_lc_with_snapshot` directly because PATH preparation has already happened elsewhere.

*Call graph*: calls 2 internal fn (prepare_user_shell_exec_command_with_path_prepend, maybe_wrap_shell_lc_with_snapshot); called by 1 (execute_user_shell_command); 1 external calls (default).


##### `prepare_user_shell_exec_command_with_path_prepend`  (lines 413–432)

```
fn prepare_user_shell_exec_command_with_path_prepend(
    display_command: &[String],
    shell: &Shell,
    shell_snapshot: Option<&AbsolutePathBuf>,
    shell_environment_set: &HashMap<String, Strin
```

**Purpose**: On Unix systems, preserves Codex runtime PATH additions while still allowing a user shell snapshot to restore the user’s own shell environment. This prevents tools bundled or prepared by the runtime from disappearing when a snapshot is replayed.

**Data flow**: It receives the command, shell, optional snapshot, explicit environment settings, mutable environment map, and a callback that prepends runtime PATH entries → clones explicit environment overrides, creates a record of runtime PATH additions, lets the callback update the live environment and record what it added → passes all of that into snapshot-wrapping logic and returns the final command arguments.

**Call relations**: `prepare_user_shell_exec_command` calls this on Unix. It then hands off to `maybe_wrap_shell_lc_with_snapshot`, giving that lower-level helper enough information to replay a shell snapshot without losing runtime-provided PATH entries.

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

**Purpose**: Saves the shell command result into the conversation state in the right form. This matters because later context, UI history, and rollout persistence need a durable record of what the user ran and what came back.

**Data flow**: It receives the session, turn context, raw command, command output, and execution mode → converts the command and output into a conversation record item → if this was a standalone shell turn, records the item and ensures rollout persistence exists; if it was auxiliary work inside an active turn, injects the item without creating a new turn.

**Call relations**: `execute_user_shell_command` calls this after cancellation, successful execution, or execution failure. It uses `user_shell_command_record_item` to create the saved item, then either records it through the normal conversation path or injects it into the current turn depending on the mode.

*Call graph*: calls 1 internal fn (user_shell_command_record_item); called by 1 (execute_user_shell_command); 5 external calls (ensure_rollout_materialized, inject_no_new_turn, record_conversation_items, from_ref, vec!).


### `core/src/tools/handlers/shell.rs`

`orchestration` · `request handling`

This file exists so the assistant can run shell commands without simply handing raw text to the operating system unchecked. A shell command can read files, change files, use the network, or ask for stronger permissions, so this code acts like a careful front desk: it verifies what is being asked, checks what the current session allows, routes special cases, and records what happened.

The small helper `shell_command_payload_command` pulls the command string out of a tool payload when the payload is a function-style request. The larger `run_exec_like` function does the real coordination. It first makes sure the current turn has a usable environment, then gathers filesystem and environment settings. It applies any already-granted permissions for this turn, checks whether extra permissions are allowed, and rejects unsafe escalation requests when the approval policy does not permit them.

Before running a normal shell command, it checks for `apply_patch`, a special command used to edit files. If found, that path is handled directly so file changes can be tracked properly. Otherwise it creates shell start/finish events, asks the execution policy what approval is required, builds a `ShellRequest`, and runs it through a `ToolOrchestrator` with a `ShellRuntime`. The final output is formatted both for the user-facing transcript and for the model’s follow-up context.

#### Function details

##### `shell_command_payload_command`  (lines 35–43)

```
fn shell_command_payload_command(payload: &ToolPayload) -> Option<String>
```

**Purpose**: This function tries to extract the actual shell command text from a tool payload. It is useful when other code needs to quickly inspect what command was requested without running it.

**Data flow**: It receives a `ToolPayload`. If the payload is not a function call with arguments, it returns nothing. If it is a function call, it parses the arguments as shell command parameters and, when that succeeds, returns the command string.

**Call relations**: This is a small local helper for the shell tool path. It depends on the shared argument parser so command extraction follows the same shape as normal shell command requests, instead of manually picking through raw JSON.


##### `run_exec_like`  (lines 60–238)

```
async fn run_exec_like(args: RunExecLikeArgs) -> Result<FunctionToolOutput, FunctionCallError>
```

**Purpose**: This function coordinates the full life of running a shell-like command: checking whether it is allowed, preparing its environment, running it, and packaging the result. It is the safety and routing layer between a model-requested command and the lower-level shell runtime.

**Data flow**: It receives a bundle of inputs: the command and working directory, cancellation token, session and turn context, requested permissions, shell settings, and runtime backend. It first checks that a primary execution environment exists. It then combines requested permissions with permissions already granted for this turn, validates whether extra access is allowed, and rejects inappropriate escalation requests. If the command is really an `apply_patch` operation, it sends it to the patch interceptor and returns that result. Otherwise it creates event tracking, asks the execution policy whether approval is needed, builds a `ShellRequest`, runs it through the shell runtime, formats the output, emits the finish event, and returns a `FunctionToolOutput` for the rest of the system.

**Call relations**: This function sits in the middle of the shell command flow. It calls permission helpers such as `apply_granted_turn_permissions`, `implicit_granted_permissions`, and permission normalization before execution. It calls `intercept_apply_patch` to divert patch-editing commands into the safer patch path. For ordinary commands, it creates a shell event emitter with `ToolEmitter::shell`, constructs a `ToolOrchestrator` with `new`, creates a shell runtime with `ShellRuntime::for_shell_command`, runs the request, then formats and emits the final result.

*Call graph*: calls 7 internal fn (shell, new, apply_granted_turn_permissions, intercept_apply_patch, implicit_granted_permissions, new, for_shell_command); 4 external calls (format!, matches!, RespondToModel, vec!).


### `core/src/tools/runtimes/shell.rs`

`orchestration` · `request handling`

This file is the main runtime for the shell tool: the part of the system that actually turns a requested command into a real process. Without it, the project could not safely run commands like build steps, tests, or file inspections on behalf of a user.

The central type is `ShellRuntime`. It receives a `ShellRequest`, which contains the command, working folder, environment variables, timeout, sandbox permissions, network settings, and any user-provided justification. Before running anything, the runtime can describe what approval is needed. It builds a stable approval key from the command and permissions, so the same approved action can be remembered instead of asking again.

When execution starts, the runtime chooses the right shell, prepares environment variables, preserves denied file reads from the current sandbox policy, and decides whether managed network access is available. On Unix it may also add helper paths, including support for a zsh-fork backend. It can wrap the command with a saved shell snapshot, adjust PowerShell behavior on Windows, and add UTF-8 setup for PowerShell scripts.

Finally it builds the sandbox command, combines timeout and cancellation signals, asks the current sandbox attempt to create an executable environment, and streams the command output back to the session. Think of it like an airport gate: it checks permission, routes the passenger through the right security lane, and only then lets the command board the plane.

#### Function details

##### `ShellRuntime::for_shell_command`  (lines 103–105)

```
fn for_shell_command(backend: ShellRuntimeBackend) -> Self
```

**Purpose**: Creates a `ShellRuntime` for the shell-command tool, using the selected backend. The backend choice controls whether the runtime uses the classic path or tries the zsh-fork path on supported systems.

**Data flow**: It receives a backend choice → stores that choice inside a new `ShellRuntime` → returns the ready-to-use runtime.

**Call relations**: The higher-level execution flow calls this when it needs a runtime for an exec-like shell command. The returned runtime is then used for approval checks and for the eventual command run.

*Call graph*: called by 1 (run_exec_like).


##### `ShellRuntime::stdout_stream`  (lines 107–113)

```
fn stdout_stream(ctx: &ToolCtx) -> Option<crate::exec::StdoutStream>
```

**Purpose**: Builds the information needed to stream live command output back to the current session. This lets users see stdout, meaning the normal text output from a running command, while the command is still executing.

**Data flow**: It reads the tool context, including the turn id, call id, and event sender → packages those into a stdout stream object → returns that stream wrapped as an optional value.

**Call relations**: The run path uses this just before executing the sandboxed command. It hands the stream to the lower-level execution function so output can be sent back through the session event channel.


##### `ShellRuntime::sandbox_preference`  (lines 117–119)

```
fn sandbox_preference(&self) -> SandboxablePreference
```

**Purpose**: Says that shell commands should use automatic sandboxing. In plain terms, the runtime lets the system choose the best available safety boundary instead of forcing one fixed mode.

**Data flow**: It takes no request-specific information → returns the `Auto` sandbox preference.

**Call relations**: The broader sandboxing framework asks this before running the tool. Its answer helps decide how the command should be isolated from the host system.


##### `ShellRuntime::escalate_on_failure`  (lines 120–122)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Tells the sandboxing framework that a failed sandboxed shell command may be retried with broader permissions if approval allows it. This is useful when a command fails only because the sandbox was too restrictive.

**Data flow**: It reads no external data → returns `true`, meaning escalation after failure is allowed.

**Call relations**: The surrounding tool execution machinery uses this policy when a sandbox attempt fails. It can then start an approval or retry flow instead of treating the first failure as final.


##### `ShellRuntime::approval_keys`  (lines 128–135)

```
fn approval_keys(&self, req: &ShellRequest) -> Vec<Self::ApprovalKey>
```

**Purpose**: Creates the cache key used to recognize whether this exact kind of shell action has already been approved. It uses a cleaned-up version of the command plus the folder and permission settings, so approval is tied to what actually matters.

**Data flow**: It receives a shell request → canonicalizes the command, meaning it rewrites it into a stable comparison form → combines that command with the working directory, sandbox permissions, and extra permissions → returns the key in a list.

**Call relations**: The approval flow calls this before asking for human or guardian review. `start_approval_async` then gives these keys to the cached-approval helper, so repeated equivalent requests can reuse an earlier decision.

*Call graph*: called by 1 (start_approval_async); 1 external calls (vec!).


##### `ShellRuntime::start_approval_async`  (lines 137–190)

```
fn start_approval_async(
        &'a mut self,
        req: &'a ShellRequest,
        ctx: ApprovalCtx<'a>,
    ) -> BoxFuture<'a, ReviewDecision>
```

**Purpose**: Starts the permission check for a shell command. It either sends the request to the guardian review system or asks the session to request command approval, while reusing cached approvals when possible.

**Data flow**: It receives the shell request and approval context → gathers the command, folder, reason, session, turn, call id, and approval keys → if there is a guardian review id, it submits a guardian shell approval request → otherwise it checks the approval cache and, if needed, asks the session to request approval → returns the review decision asynchronously.

**Call relations**: This is called by the tool approval framework before a command runs. It relies on `approval_keys` to describe what is being approved, may call `review_approval_request` for guardian-controlled review, and otherwise delegates through `with_cached_approval` to avoid asking the same question repeatedly.

*Call graph*: calls 2 internal fn (approval_keys, with_cached_approval); 2 external calls (pin, review_approval_request).


##### `ShellRuntime::exec_approval_requirement`  (lines 192–194)

```
fn exec_approval_requirement(&self, req: &ShellRequest) -> Option<ExecApprovalRequirement>
```

**Purpose**: Reports the execution approval rule attached to this shell request. This tells the approval framework whether the command needs approval and under what policy.

**Data flow**: It reads the request’s stored approval requirement → clones it → returns it as an optional value.

**Call relations**: The broader sandboxing and approval code asks this when deciding whether to run immediately, ask first, or propose a policy change. It does not call other helpers; it simply exposes the request’s rule.


##### `ShellRuntime::permission_request_payload`  (lines 196–201)

```
fn permission_request_payload(&self, req: &ShellRequest) -> Option<PermissionRequestPayload>
```

**Purpose**: Builds the human-facing permission request payload for a shell command. It packages the command text and any justification so an approval prompt can explain what is being requested.

**Data flow**: It reads the hook command and justification from the request → formats them as a bash-style permission request payload → returns that payload.

**Call relations**: The approval system calls this when it needs to show or record a permission request. It uses the payload builder for bash-like shell commands so the request is presented in the expected shape.

*Call graph*: calls 1 internal fn (bash).


##### `ShellRuntime::sandbox_permissions`  (lines 203–205)

```
fn sandbox_permissions(&self, req: &ShellRequest) -> SandboxPermissions
```

**Purpose**: Returns the sandbox permissions requested for this shell command. These permissions describe what the command should be allowed to read, write, or otherwise access.

**Data flow**: It reads the `sandbox_permissions` field from the request → returns that permission value unchanged.

**Call relations**: The sandboxing framework calls this while preparing an attempt. The returned permissions feed into later steps that create the actual restricted execution environment.


##### `ShellRuntime::network_approval_spec`  (lines 209–236)

```
fn network_approval_spec(
        &self,
        req: &ShellRequest,
        ctx: &ToolCtx,
    ) -> Option<NetworkApprovalSpec>
```

**Purpose**: Describes how network access should be approved for this shell command, if managed network access is relevant. It creates a trigger that explains which command wants network access and why.

**Data flow**: It reads the request and tool context → combines requested sandbox permissions with the current file-system sandbox policy, preserving denied reads → checks whether a managed network proxy applies → if it does, builds a network approval specification containing the command, folder, tool name, permissions, and justification → returns that specification; if no managed network applies, returns nothing.

**Call relations**: The tool runtime framework calls this before or during execution setup when network approval may be needed. It uses helpers to flatten the tool name, preserve sandbox restrictions, and translate sandbox permissions into managed network access.

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

**Purpose**: Runs the shell command inside the current sandbox attempt. It prepares the shell, environment, command wrapping, timeout, cancellation, network settings, and output streaming before handing the process to the low-level executor.

**Data flow**: It receives a shell request, the current sandbox attempt, and tool context → chooses the shell and optional shell snapshot → adjusts sandbox permissions to preserve denied reads → prepares environment variables and optional runtime path additions → wraps or modifies the command for shell snapshots, Windows PowerShell sandbox rules, and PowerShell UTF-8 behavior → optionally tries the zsh-fork backend → otherwise builds the sandbox command → combines timeout and cancellation tokens → asks the sandbox attempt to create the final execution environment → runs it and streams stdout → returns the command output or a tool error.

**Call relations**: This is the main execution path after approval and sandbox setup. It calls many preparation helpers, may hand off to the zsh-fork backend and return early if that backend succeeds, and otherwise delegates the final launch to the sandbox execution layer through `env_for` and `execute_env`.

*Call graph*: calls 11 internal fn (execute_env, apply_package_path_prepend, apply_zsh_fork_path_prepend, build_sandbox_command, disable_powershell_profile_for_elevated_windows_sandbox, exec_env_for_sandbox_permissions, maybe_wrap_shell_lc_with_snapshot, env_for, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads (+1 more)); 5 external calls (stdout_stream, default, matches!, warn!, maybe_run_shell_command).


### `core/src/tools/runtimes/shell/zsh_fork_backend.rs`

`orchestration` · `command preparation and process spawn`

Most shell commands can run through the normal shell runtime. Some commands, though, need a more careful launch path: they are wrapped as `zsh -c` or `zsh -lc`, and they may need executable-level escalation, meaning the program being started gets special permission treatment rather than the shell runner doing everything itself. This file is the gatekeeper for that path.

The public functions first ask: “Is this the kind of request and platform that zsh-fork can handle?” On Unix systems, the answer is delegated to the Unix escalation code. If that code says yes, this file either runs the command directly through zsh-fork or prepares a unified execution request that will be spawned later. If the answer is no, it returns `None`, which tells the caller to use the ordinary execution route.

The important extra piece is the spawn lifecycle. Think of it like a stagehand holding a door open while an actor walks on stage. The escalation session exposes a socket file descriptor, a low-level operating-system handle for communication, so the child process can inherit it. Once the process has started, this file closes the parent-side client socket so resources are not left hanging.

On non-Unix platforms, the same functions simply return `None`. That keeps callers simple: they can always ask this file whether zsh-fork applies, and the file quietly steps aside when it cannot.

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

**Purpose**: This is the top-level check for whether a shell command should be run through the zsh-fork backend. Callers use it before falling back to the normal shell-command path.

**Data flow**: It receives the shell request, the current sandbox attempt, shared tool context, and the command words. It passes those unchanged to the platform-specific implementation. The result is either a completed command output wrapped in `Some`, meaning zsh-fork handled it, or `None`, meaning the normal shell runner should take over; errors are passed back unchanged.

**Call relations**: This function is the stable doorway used by the rest of the shell runtime. It immediately hands the decision to `imp::maybe_run_shell_command`, so the platform-specific details stay hidden behind one simple call.

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

**Purpose**: This is the top-level check for whether a unified execution request should be launched through zsh-fork. It prepares both the changed execution request and the cleanup behavior needed after spawning.

**Data flow**: It receives the higher-level unified execution request, sandbox attempt, tool context, an already-built execution request, and zsh-fork configuration paths. It forwards all of that to the platform-specific implementation. It returns either a prepared spawn package, `None` if zsh-fork does not apply, or an error if preparation failed.

**Call relations**: The unified execution path calls this before using its normal spawn logic. This wrapper delegates to `imp::maybe_prepare_unified_exec`, which either builds a `PreparedUnifiedExecSpawn` or tells the caller to continue normally.

*Call graph*: 1 external calls (maybe_prepare_unified_exec).


##### `imp::ZshForkSpawnLifecycle::inherited_fds`  (lines 60–67)

```
fn inherited_fds(&self) -> Vec<i32>
```

**Purpose**: This tells the process spawner which file descriptors, meaning low-level operating-system handles, must be passed into the child process. For zsh-fork, the important handle is the escalation socket.

**Data flow**: It reads the escalation session’s environment values and looks for the special environment variable that names the socket file descriptor. If the value is present and can be parsed as a number, it returns that number in a list. If not, it returns an empty list.

**Call relations**: The unified process spawner asks this lifecycle object what handles the child must inherit before the command starts. This function gets that information from the escalation session’s `env` data so the child can communicate with the escalation helper.

*Call graph*: calls 1 internal fn (env).


##### `imp::ZshForkSpawnLifecycle::after_spawn`  (lines 69–71)

```
fn after_spawn(&mut self)
```

**Purpose**: This cleans up the parent side of the escalation connection after the child process has been started. It prevents the client socket from staying open longer than needed.

**Data flow**: It uses the stored escalation session and tells it to close its client socket. It does not produce a value; its effect is cleanup after a successful spawn step.

**Call relations**: The process spawner calls this lifecycle hook after it has launched the child process. At that point the child has inherited what it needs, so this function hands off to `close_client_socket` to release the parent’s copy.

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

**Purpose**: This is the platform-specific worker that tries to run a shell command through zsh-fork. On supported Unix builds, it asks the Unix escalation layer to do the real check and run; on unsupported builds, it declines by returning `None`.

**Data flow**: It receives the same request, sandbox attempt, context, and command words passed in by the top-level wrapper. On Unix, it sends them to the zsh-fork escalation routine, which may execute the command and return output. The output, fallback decision, or error is passed back to the caller.

**Call relations**: The public `maybe_run_shell_command` wrapper calls this function whenever a shell command is being considered for zsh-fork. In the Unix path, it delegates the actual execution decision to `try_run_zsh_fork`; in the non-Unix path, it simply tells the caller to use the normal shell flow.

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

**Purpose**: This prepares a unified execution spawn to use the zsh-fork backend when the request matches the supported zsh wrapper shape. It also creates the lifecycle object that keeps the escalation session available until the child process is safely started.

**Data flow**: It receives the unified request, sandbox attempt, context, current execution request, and zsh-fork configuration. On Unix, it passes the request plus the configured zsh path and wrapper executable path to the Unix escalation preparation code. If preparation succeeds, it returns a new execution request together with a boxed spawn lifecycle; if zsh-fork does not apply, it returns `None`.

**Call relations**: The public `maybe_prepare_unified_exec` wrapper calls this before the unified execution system spawns a process. This function asks `prepare_unified_exec_zsh_fork` to transform the launch plan, then wraps the returned escalation session in `ZshForkSpawnLifecycle` so later spawn code knows what file descriptor to inherit and what to clean up afterward.

*Call graph*: calls 1 internal fn (prepare_unified_exec_zsh_fork); 1 external calls (new).


### Unified exec tool flow
These files define the shared unified-exec argument model, concrete tool handlers, and the PTY-oriented runtime that launches unified execution sessions.

### `core/src/tools/handlers/unified_exec.rs`

`orchestration` · `request handling`

This file helps the system turn a model-requested command into something the machine can actually run. A user or model may ask to run text like `ls -la`, but the program still has to decide which shell should interpret it, whether login-shell behavior is allowed, whether the command is local or remote, and what metadata should be sent to later tool-use hooks. Without this file, command execution would be less predictable: defaults could differ, unsupported shell choices might slip through, and post-command hooks would not receive a consistent record of what happened.

The main input type, `ExecCommandArgs`, describes what can be requested: the command text, optional shell path, whether to use a login shell, terminal behavior, output limits, sandbox permissions, extra permission requests, and related justification. Small default functions provide ordinary values when the caller leaves fields out.

The key decision point is `get_command`. It converts the requested command into a `ResolvedCommand`, which is the actual list of program arguments to run plus the kind of shell being used. It supports two modes: direct shell execution, or a local special `zsh-fork` mode. Remote environments always fall back to direct mode, because the local zsh-fork setup only makes sense on the local machine.

The file also builds a `PostToolUsePayload`, which is like a receipt passed to hook code after the tool finishes.

#### Function details

##### `default_exec_yield_time_ms`  (lines 60–62)

```
fn default_exec_yield_time_ms() -> u64
```

**Purpose**: Provides the default waiting time for command execution before the system yields control back to the caller. This keeps long-running commands from making the system feel stuck too quickly.

**Data flow**: No input is needed. The function simply returns the fixed number `10000`, meaning 10,000 milliseconds, or 10 seconds. It does not read or change any outside state.

**Call relations**: This function is used as the default value for `yield_time_ms` in `ExecCommandArgs` when the caller does not provide one. It sits at the edge of command setup, before the actual execution handler uses the parsed arguments.


##### `default_write_stdin_yield_time_ms`  (lines 64–66)

```
fn default_write_stdin_yield_time_ms() -> u64
```

**Purpose**: Provides the default waiting time after writing input to a running command. It gives the command a short moment to react before the system checks back in.

**Data flow**: No input is needed. The function returns the fixed number `250`, meaning 250 milliseconds. It does not change anything else.

**Call relations**: This default supports the write-stdin side of unified execution, where text is sent into an already-running process. It is defined here so related execution defaults live together, even though the write-stdin handler itself is in the `write_stdin` submodule.


##### `default_tty`  (lines 68–70)

```
fn default_tty() -> bool
```

**Purpose**: Sets the default terminal mode for command execution to off. In plain terms, commands do not get a pretend interactive terminal unless the caller asks for one.

**Data flow**: No input is needed. The function returns `false`, which becomes the default value for the `tty` field. It does not read or modify outside data.

**Call relations**: This function is used while deserializing `ExecCommandArgs`, so missing `tty` input turns into a clear default. Later execution code can rely on the field always having a concrete true-or-false value.


##### `post_unified_exec_tool_use_payload`  (lines 78–95)

```
fn post_unified_exec_tool_use_payload(
    invocation: &ToolInvocation,
    result: &dyn ToolOutput,
) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the information sent to post-tool-use hooks after a unified exec command finishes. A hook is follow-up code that can inspect or react to a tool run, like a logbook entry after a task is completed.

**Data flow**: It receives the original `ToolInvocation` and the command result as a `ToolOutput`. First it checks that the invocation was a function-style tool call; if not, it returns nothing. Then it asks the result object for the hook input, creates or retrieves the tool-use id, builds the hook response, and returns a `PostToolUsePayload` labeled as the bash-style tool. If any needed piece cannot be produced, it returns nothing.

**Call relations**: This function is called after a command has produced a result and the system needs to notify hook machinery. It calls `post_tool_use_input`, `post_tool_use_id`, and `post_tool_use_response` on the output object to let the specific result format describe itself, and it uses `bash` to name the hook consistently.

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

**Purpose**: Turns the user's requested command settings into the exact command-line argument list the system should run. It also rejects shell choices that are not allowed in the current execution mode.

**Data flow**: It receives parsed command arguments, the session's normal shell, the selected unified-exec shell mode, and a flag saying whether login shells are allowed. It first decides whether a login shell should be used, returning an error if the caller asked for one but configuration forbids it. In direct mode, it uses the caller-provided shell path if present, otherwise the session shell, and asks that shell to produce the final execution arguments. In local zsh-fork mode, it rejects custom shell paths, then builds a zsh command using either `-lc` for login behavior or `-c` for ordinary behavior. The output is either a `ResolvedCommand` or a plain error message.

**Call relations**: This function is the central command-resolution step before actual process execution. The execution handler calls on it when it needs a safe, concrete command to launch. It hands back a `ResolvedCommand`, which later code can pass to the process runner without re-deciding shell rules.

*Call graph*: 1 external calls (vec!).


##### `shell_mode_for_environment`  (lines 144–153)

```
fn shell_mode_for_environment(
    turn_shell_mode: &UnifiedExecShellMode,
    environment: &Environment,
) -> UnifiedExecShellMode
```

**Purpose**: Chooses which shell mode should be used for a specific environment. It keeps the special local zsh-fork mode from being used on remote machines where it does not apply.

**Data flow**: It receives the shell mode chosen for the current turn and an `Environment`. If the environment reports that it is remote, the function returns direct execution mode. Otherwise, it returns a clone of the chosen turn mode. It does not modify the environment or the original mode.

**Call relations**: This function is used during command setup when the system knows which environment will run the command. It asks the environment whether it is remote through `is_remote`; if not remote, it preserves the caller's mode by using `clone` so later command-building code can continue with the right strategy.

*Call graph*: calls 1 internal fn (is_remote); 1 external calls (clone).


### `core/src/tools/handlers/unified_exec/exec_command.rs`

`orchestration` · `request handling`

This file is the front desk for running commands. When the model asks to use `exec_command`, this handler checks that the request is shaped correctly, finds the right environment, decides the working directory, applies permission rules, and then asks the unified execution process manager to actually run the command. Without this file, the tool would not know how to turn a JSON tool call into a real shell process, and important safety checks around sandboxing and approvals would be skipped.

The flow is deliberately cautious. First it reads the command arguments and selects the target environment. Then it resolves paths so the command runs from the intended folder. It works out which shell style to use, such as a normal shell or a login shell, and prepares the command string that will be executed. Before running anything, it checks sandbox permissions and any extra permissions the command asks for. If the current approval policy does not allow those requests, it stops early and returns a clear error.

There is also one special shortcut: if the command is really an `apply_patch` operation, it can be intercepted and handled by the patch system instead of launching a shell process. For normal commands, the handler records a telemetry counter, sends the request to the process manager, and returns either command output, sandbox-denial output, or an error message. It also supports hook integration, so other parts of the system can inspect or rewrite the command before and after use.

#### Function details

##### `ExecCommandHandler::default`  (lines 56–65)

```
fn default() -> Self
```

**Purpose**: Creates a standard `exec_command` handler with conservative default settings. By default it does not allow login shells, does not enable extra permission approvals, does not include an environment id field, and does include the shell parameter.

**Data flow**: No outside input is needed. It fills in an `ExecCommandHandlerOptions` value with the default choices and stores it inside a new `ExecCommandHandler`. The result is a ready-to-use handler for the common setup.

**Call relations**: This default setup is used heavily by tests that check permission behavior and hook payload behavior. Those callers need a normal handler without going through the full tool-registration path.

*Call graph*: called by 6 (guardian_allows_unified_exec_additional_permissions_requests_past_policy_validation, unified_exec_rejects_escalated_permissions_when_policy_not_on_request, exec_command_post_tool_use_payload_skips_running_sessions, exec_command_post_tool_use_payload_uses_output_for_interactive_completion, exec_command_post_tool_use_payload_uses_output_for_noninteractive_one_shot_commands, exec_command_pre_tool_use_payload_uses_raw_command).


##### `ExecCommandHandler::new`  (lines 69–71)

```
fn new(options: ExecCommandHandlerOptions) -> Self
```

**Purpose**: Builds an `exec_command` handler with caller-chosen options. This is used when the surrounding tool setup wants to decide which command features are exposed.

**Data flow**: It receives an `ExecCommandHandlerOptions` value, stores it unchanged, and returns a new `ExecCommandHandler`. Nothing else is read or changed.

**Call relations**: The shell tool registration code calls this when adding shell tools. That lets the registry create a handler whose public tool shape matches the features enabled for that session or build.

*Call graph*: called by 1 (add_shell_tools).


##### `ExecCommandHandler::tool_name`  (lines 75–77)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Tells the tool system that this handler responds to the tool named `exec_command`. This is how incoming tool calls are routed to the right handler.

**Data flow**: It takes the handler itself as context, creates a plain tool name from the text `exec_command`, and returns that name. It does not inspect or change handler state.

**Call relations**: The tool registry asks each executor for its name. This function supplies the label that connects model requests for `exec_command` to this handler.

*Call graph*: calls 1 internal fn (plain).


##### `ExecCommandHandler::spec`  (lines 79–88)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Describes the shape and options of the `exec_command` tool for the model and tool system. This includes whether login shells, permission approval options, environment ids, and shell parameters should appear.

**Data flow**: It reads the handler’s stored options, converts them into command tool options, and asks the shell-spec builder to create the final `ToolSpec`. The output is the formal description of what arguments the tool accepts.

**Call relations**: When tools are advertised or registered, the runtime asks this handler for its specification. This function delegates the detailed schema building to `create_exec_command_tool_with_environment_id` so the same shell-tool description logic can be reused.

*Call graph*: calls 1 internal fn (create_exec_command_tool_with_environment_id).


##### `ExecCommandHandler::supports_parallel_tool_calls`  (lines 90–92)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares that multiple `exec_command` calls may run at the same time. This matters because command execution can be long-running, and the system needs to know whether parallel tool scheduling is allowed.

**Data flow**: It receives no meaningful input beyond the handler reference and always returns `true`. It does not read or change any state.

**Call relations**: The tool runtime uses this answer when deciding whether it may dispatch this tool alongside other calls. For command execution, the handler says yes because the process manager is designed to track separate processes.


##### `ExecCommandHandler::handle`  (lines 94–96)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling one incoming tool invocation. It wraps the real asynchronous work so it fits the common tool-executor interface.

**Data flow**: It receives a `ToolInvocation`, passes it to `handle_call`, and returns a pinned future, which is a Rust way of saying “this async job can now be awaited safely.” The actual command work happens later when that future runs.

**Call relations**: The tool runtime calls this method when the model invokes `exec_command`. This method immediately hands the request to `handle_call`, which performs parsing, permission checks, execution, and output conversion.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ExecCommandHandler::handle_call`  (lines 100–327)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: Performs the full `exec_command` request flow: read arguments, choose the environment, check permissions, possibly intercept patches, run the command, and convert the result into tool output. This is the main command-running pipeline in the file.

**Data flow**: It starts with a `ToolInvocation`, which contains the session, current turn, call id, tracker, and JSON arguments. It rejects non-function payloads, parses the command and environment fields, resolves the working directory, selects the shell, prepares the command, applies already granted permissions, validates any extra permission request, and may stop early with a model-facing error. If the command is an intercepted patch operation, it returns patch output without starting a process. Otherwise it sends an `ExecCommandRequest` to the unified execution manager. The result becomes boxed tool output; sandbox denial is turned into terminal command output, while other execution failures become an error message.

**Call relations**: This function is called by `handle`, so it is the real worker behind the public tool interface. Along the way it calls helpers for argument parsing, environment lookup, permission application, patch interception, telemetry, and output boxing. At the end it hands the prepared request to the unified execution process manager, which is responsible for the actual process run.

*Call graph*: calls 11 internal fn (boxed_tool_output, apply_granted_turn_permissions, intercept_apply_patch, implicit_granted_permissions, parse_arguments, parse_arguments_with_base_path, resolve_tool_environment, emit_unified_exec_tty_metric, new, generate_chunk_id (+1 more)); called by 1 (handle); 9 external calls (clone, new, approx_token_count, maybe_emit_implicit_skill_invocation, format!, matches!, get_command, shell_mode_for_environment, RespondToModel).


##### `ExecCommandHandler::matches_kind`  (lines 331–333)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Checks whether a payload is the kind this handler can work with. `exec_command` expects a function-style payload containing arguments.

**Data flow**: It receives a tool payload and returns `true` only if that payload is a function call. It does not parse the arguments yet and does not modify anything.

**Call relations**: The core tool runtime can use this quick check before asking for hook payloads or execution behavior. It keeps this handler from trying to process unsupported payload shapes.

*Call graph*: 1 external calls (matches!).


##### `ExecCommandHandler::pre_tool_use_payload`  (lines 335–346)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the information sent to pre-tool hooks before the command runs. A hook is an extension point where another part of the system can inspect or alter tool use.

**Data flow**: It receives a tool invocation, extracts the function arguments, and tries to parse them as `ExecCommandArgs`. If parsing works, it returns a payload that presents the command as a bash-style hook input. If the payload is not a function call or parsing fails, it returns nothing.

**Call relations**: Before running a tool, the runtime may ask this handler what hook data should be shown to hook logic. This function provides the raw command so policy or customization hooks can review it.


##### `ExecCommandHandler::with_updated_hook_input`  (lines 348–367)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: serde_json::Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies a hook’s rewritten command back into the original tool invocation. This lets a pre-tool hook change what command will actually run.

**Data flow**: It receives the original invocation and a JSON value from the hook. It rejects unsupported payloads, extracts the updated command text, rewrites the `cmd` field inside the original function arguments, and returns the updated invocation. If the hook input is invalid, it returns a model-facing error.

**Call relations**: After pre-tool hook logic updates the command, the runtime calls this method to fold that change into the pending `exec_command` call. It relies on `updated_hook_command` to read the new command and `rewrite_function_string_argument` to replace the `cmd` argument safely.

*Call graph*: calls 2 internal fn (rewrite_function_string_argument, updated_hook_command); 1 external calls (RespondToModel).


##### `ExecCommandHandler::post_tool_use_payload`  (lines 369–375)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the information sent to post-tool hooks after command execution. This gives hook logic a summary of what happened.

**Data flow**: It receives the original invocation and the produced tool output. It passes both to the shared unified-exec post-hook helper and returns whatever post-use payload that helper can build.

**Call relations**: After `exec_command` finishes, the core runtime can ask this handler for post-tool hook data. This method delegates to `post_unified_exec_tool_use_payload`, keeping the result formatting consistent with the rest of unified execution.

*Call graph*: 1 external calls (post_unified_exec_tool_use_payload).


##### `emit_unified_exec_tty_metric`  (lines 378–384)

```
fn emit_unified_exec_tty_metric(session_telemetry: &SessionTelemetry, tty: bool)
```

**Purpose**: Records a telemetry count for an `exec_command` call and notes whether it requested a TTY. A TTY is a terminal-like interface, useful for interactive programs.

**Data flow**: It receives the session telemetry object and a boolean saying whether TTY mode was requested. It increments the unified exec tool-call counter by one and attaches a `tty=true` or `tty=false` label. It returns no value.

**Call relations**: The main `handle_call` flow invokes this just before asking the process manager to run the command. That means command usage is counted at the point where a normal command execution is about to start.

*Call graph*: calls 1 internal fn (counter); called by 1 (handle_call).


### `core/src/tools/handlers/shell/shell_command.rs`

`orchestration` · `request handling`

The shell command tool is the bridge between a requested command, like `ls` or `cargo test`, and actually running it on the user's machine. Without this file, the system might know that the model asked to run a command, but it would not know how to choose the right shell, set the working directory, apply sandbox permissions, build the environment, call hooks, or return the output in the expected tool format.

The main type, `ShellCommandHandler`, is like a dispatcher at a train station. It receives a tool invocation, checks that it is the right kind of ticket, reads the command and options, decides which shell backend to use, and hands the prepared job to the shared execution path. It supports two backends: a classic shell-command path and a zsh-fork path. The rest of the system does not need to care which one is chosen; this handler hides that choice.

A key safety rule here is login-shell control. A login shell reads extra startup files and can behave differently from a plain shell, so this file refuses that mode when configuration says it is not allowed.

The file also participates in pre- and post-tool hooks. Hooks are extension points that can inspect or rewrite a command before it runs, and observe the command plus its response after it finishes.

#### Function details

##### `ShellCommandHandler::new`  (lines 53–59)

```
fn new(options: ShellCommandHandlerOptions) -> Self
```

**Purpose**: Creates a shell command handler using the configured backend and behavior options. This is used when the system registers shell tools and needs a ready executor for future command requests.

**Data flow**: It receives `ShellCommandHandlerOptions`, including which backend is configured and whether login shells or permission approvals are allowed. It translates the public backend setting into this file's internal backend choice, then returns a `ShellCommandHandler` containing both the chosen backend and the original options.

**Call relations**: During tool setup, `add_shell_tools` calls this to create the handler that will later process shell command invocations.

*Call graph*: called by 1 (add_shell_tools).


##### `ShellCommandHandler::shell_runtime_backend`  (lines 61–66)

```
fn shell_runtime_backend(&self) -> ShellRuntimeBackend
```

**Purpose**: Converts the handler's internal backend choice into the backend label expected by the shared shell runtime. This lets the rest of the execution pipeline know which shell-running implementation should be used.

**Data flow**: It reads `self.backend`, maps `Classic` to the classic shell-command runtime and `ZshFork` to the zsh-fork runtime, then returns that runtime backend value.

**Call relations**: `handle_call` uses this right before handing the prepared command to `run_exec_like`, so the execution layer receives the correct runtime choice.

*Call graph*: called by 1 (handle_call).


##### `ShellCommandHandler::resolve_use_login_shell`  (lines 68–79)

```
fn resolve_use_login_shell(
        login: Option<bool>,
        allow_login_shell: bool,
    ) -> Result<bool, FunctionCallError>
```

**Purpose**: Decides whether the command should run in a login shell, while enforcing the configuration rule that may forbid login shells. A login shell is a shell that reads login startup files, which can change the environment and behavior.

**Data flow**: It receives the user's optional `login` setting and a configuration flag saying whether login shells are allowed. If the user explicitly asks for a login shell when it is disabled, it returns an error message for the model. Otherwise it returns the explicit setting, or falls back to the configured default.

**Call relations**: This decision is part of building execution parameters. Tests call it directly to check that disallowed login-shell requests are rejected.

*Call graph*: called by 1 (shell_command_handler_rejects_login_when_disallowed); 1 external calls (RespondToModel).


##### `ShellCommandHandler::base_command`  (lines 81–83)

```
fn base_command(shell: &Shell, command: &str, use_login_shell: bool) -> Vec<String>
```

**Purpose**: Builds the actual command argument list that should be given to the operating system. It asks the selected user shell how to wrap the text command correctly.

**Data flow**: It receives a `Shell`, the command text, and whether to use login-shell mode. It passes those to the shell's `derive_exec_args` method, which returns a list of command-line arguments ready for process execution.

**Call relations**: This is normally used while creating execution parameters. Tests call it directly to confirm that the explicit login flag affects the produced shell arguments.

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

**Purpose**: Turns parsed shell tool arguments into `ExecParams`, the shared package of information needed to launch a process safely and consistently. This is where the command, folder, timeout, environment, network setting, sandbox permissions, and justification are gathered into one object.

**Data flow**: It reads the requested command parameters, the session's user shell, the current turn context, the thread id, and the login-shell policy. It resolves whether login-shell mode is allowed, builds the shell command arguments, resolves the working directory, creates the environment variables, copies network and sandbox settings, and returns an `ExecParams` value. If the login-shell request violates policy, it returns an error instead.

**Call relations**: `handle_call` uses this before running a command. Several tests call it directly to verify defaults, shell selection, and use of turn-context settings.

*Call graph*: calls 2 internal fn (create_env, resolve_path); called by 2 (shell_command_handler_defaults_to_non_login_when_disallowed, shell_command_handler_to_exec_params_uses_session_shell_and_turn_context); 3 external calls (base_command, resolve_use_login_shell, user_shell).


##### `ShellCommandHandler::from`  (lines 118–124)

```
fn from(backend_config: ShellCommandBackendConfig) -> Self
```

**Purpose**: Provides a shortcut for creating a handler from only a backend configuration. It uses safe default options: login shells are not allowed, and execution permission approvals are not enabled.

**Data flow**: It receives a `ShellCommandBackendConfig`, wraps it in `ShellCommandHandlerOptions` with the default booleans set to `false`, then calls `new` to build the handler.

**Call relations**: Tests and setup paths use this conversion when they only need to specify the backend. It feeds into `new`, so construction stays consistent.

*Call graph*: called by 6 (guardian_allows_shell_command_additional_permissions_requests_past_policy_validation, shell_command_allows_sticky_turn_permissions_without_inline_request_permissions_feature, strict_auto_review_turn_grant_forces_guardian_for_shell_command_policy_skip, rejects_escalated_permissions_when_policy_not_on_request, build_post_tool_use_payload_uses_tool_output_wire_value, shell_command_pre_tool_use_payload_uses_raw_command); 1 external calls (new).


##### `ShellCommandHandler::tool_name`  (lines 128–130)

```
fn tool_name(&self) -> ToolName
```

**Purpose**: Returns the public tool name for this handler: `shell_command`. The registry and execution flow use this name to identify which tool is being described or run.

**Data flow**: It creates and returns a plain tool name value containing the text `shell_command`.

**Call relations**: `handle_call` uses this name when reporting unsupported payloads and when passing the tool identity into the shared execution path.

*Call graph*: calls 1 internal fn (plain); called by 1 (handle_call).


##### `ShellCommandHandler::spec`  (lines 132–137)

```
fn spec(&self) -> ToolSpec
```

**Purpose**: Builds the tool specification that tells the model what the shell command tool can accept. This includes whether login shells and execution permission approvals should appear as available options.

**Data flow**: It reads the handler's options, creates `CommandToolOptions` from them, and passes those options to `create_shell_command_tool`. The result is a `ToolSpec`, which is the advertised shape of the tool.

**Call relations**: The tool registry calls this trait method when it needs to expose the shell command tool's schema to the model.

*Call graph*: calls 1 internal fn (create_shell_command_tool).


##### `ShellCommandHandler::supports_parallel_tool_calls`  (lines 139–141)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: States that multiple shell command tool calls can be run in parallel. This tells the surrounding tool system it does not have to serialize every shell command through this handler.

**Data flow**: It takes no extra input beyond the handler and always returns `true`.

**Call relations**: The tool execution framework reads this trait method when deciding whether this tool may run alongside other tool calls.


##### `ShellCommandHandler::handle`  (lines 143–145)

```
fn handle(&self, invocation: ToolInvocation) -> codex_tools::ToolExecutorFuture<'_>
```

**Purpose**: Starts handling a shell command invocation and returns it as an asynchronous task. Asynchronous means the work can wait for a long-running process without blocking the whole program.

**Data flow**: It receives a `ToolInvocation`, calls `handle_call` with it, wraps the future in a pinned box so it can be stored and driven by the executor, and returns that future.

**Call relations**: The tool framework calls this trait method when a `shell_command` invocation arrives. It immediately hands the real work to `handle_call`.

*Call graph*: calls 1 internal fn (handle_call); 1 external calls (pin).


##### `ShellCommandHandler::handle_call`  (lines 149–207)

```
async fn handle_call(
        &self,
        invocation: ToolInvocation,
    ) -> Result<Box<dyn crate::tools::context::ToolOutput>, FunctionCallError>
```

**Purpose**: This is the main path for one shell command request. It validates the incoming payload, parses the command arguments, prepares execution settings, emits any implicit skill signal, and then delegates the actual running to the shared execution helper.

**Data flow**: It receives a full `ToolInvocation`, including the session, turn context, cancellation token, tracker, call id, and payload. It requires the payload to be function-style arguments; otherwise it returns an error for the model. It resolves the base working directory, parses the JSON-like arguments into shell command parameters, resolves the final work directory, optionally emits an implicit skill invocation, builds `ExecParams`, chooses the shell runtime backend, and calls `run_exec_like`. The successful result is boxed as standard tool output.

**Call relations**: `handle` calls this for each shell command request. Inside, it calls helpers from this file such as `tool_name`, `to_exec_params`, and `shell_runtime_backend`, and hands the prepared job to `run_exec_like`, which performs the common execution flow.

*Call graph*: calls 4 internal fn (parse_arguments_with_base_path, resolve_workdir_base_path, shell_runtime_backend, tool_name); called by 1 (handle); 5 external calls (to_exec_params, maybe_emit_implicit_skill_invocation, format!, run_exec_like, RespondToModel).


##### `ShellCommandHandler::matches_kind`  (lines 211–213)

```
fn matches_kind(&self, payload: &ToolPayload) -> bool
```

**Purpose**: Checks whether a tool payload is the kind this runtime understands. For this handler, only function-style payloads are accepted.

**Data flow**: It receives a `ToolPayload` reference, checks whether it is `ToolPayload::Function`, and returns `true` or `false`.

**Call relations**: The core tool runtime uses this before sending a payload through shell-command-specific behavior.

*Call graph*: 1 external calls (matches!).


##### `ShellCommandHandler::waits_for_runtime_cancellation`  (lines 215–217)

```
fn waits_for_runtime_cancellation(&self) -> bool
```

**Purpose**: Tells the tool system that this handler waits for the runtime cancellation process. That matters because shell commands may create real operating-system processes that need orderly cancellation.

**Data flow**: It takes no extra input and always returns `true`.

**Call relations**: The core runtime reads this setting when deciding how cancellation should behave for a running shell command.


##### `ShellCommandHandler::pre_tool_use_payload`  (lines 219–224)

```
fn pre_tool_use_payload(&self, invocation: &ToolInvocation) -> Option<PreToolUsePayload>
```

**Purpose**: Builds the data sent to a pre-tool hook before a shell command runs. A hook is a configurable checkpoint that can inspect, block, or modify tool use.

**Data flow**: It receives the pending invocation, extracts the raw command text from its payload, and, if successful, returns a `PreToolUsePayload` marked as a bash-style hook input with JSON containing the command. If it cannot find a command, it returns `None`.

**Call relations**: The runtime calls this before executing the tool. It uses `shell_command_payload_command` to extract the command that the hook should see.

*Call graph*: 1 external calls (shell_command_payload_command).


##### `ShellCommandHandler::with_updated_hook_input`  (lines 226–245)

```
fn with_updated_hook_input(
        &self,
        mut invocation: ToolInvocation,
        updated_input: serde_json::Value,
    ) -> Result<ToolInvocation, FunctionCallError>
```

**Purpose**: Applies a command rewrite produced by a pre-tool hook. This lets a hook change the command text while keeping the rest of the invocation intact.

**Data flow**: It receives the original invocation and the hook's updated JSON input. It requires the invocation payload to be function-style arguments; otherwise it returns an error for the model. It extracts the updated command from the hook input, rewrites the `command` argument inside the original shell command arguments, stores the rewritten payload back into the invocation, and returns the updated invocation.

**Call relations**: After a pre-tool hook modifies its input, the runtime calls this to convert that hook result back into a normal shell command invocation. It relies on `updated_hook_command` to read the new command and `rewrite_function_string_argument` to update the argument string safely.

*Call graph*: calls 2 internal fn (rewrite_function_string_argument, updated_hook_command); 1 external calls (RespondToModel).


##### `ShellCommandHandler::post_tool_use_payload`  (lines 247–261)

```
fn post_tool_use_payload(
        &self,
        invocation: &ToolInvocation,
        result: &dyn crate::tools::context::ToolOutput,
    ) -> Option<PostToolUsePayload>
```

**Purpose**: Builds the data sent to a post-tool hook after a shell command finishes. This lets hooks observe both what command ran and what response the tool produced.

**Data flow**: It receives the original invocation and the tool output. It asks the output to produce its hook-facing response, extracts the command from the invocation payload, and returns a `PostToolUsePayload` containing the bash hook name, the tool use id, the command input, and the response. If either the response or command cannot be produced, it returns `None`.

**Call relations**: The runtime calls this after command execution. It combines the command extracted by `shell_command_payload_command` with the output's `post_tool_use_response` so post-use hooks get a complete before-and-after record.

*Call graph*: calls 2 internal fn (bash, post_tool_use_response); 2 external calls (json!, shell_command_payload_command).


### `core/src/tools/runtimes/unified_exec.rs`

`orchestration` · `request handling`

A unified exec request is more than just “run this command.” The system must decide whether the command needs human or policy approval, what files it may touch, whether it may use the network, which working directory is safe, and how to launch it inside the right shell environment. This file gathers those decisions into one runtime adapter, `UnifiedExecRuntime`.

Think of it like an airport gate for shell commands. The command arrives with its ticket, destination, luggage, and requested privileges. This runtime checks whether it needs approval, records approval keys so repeated equivalent commands can reuse a decision, prepares a network-approval trigger if network use is controlled, and builds the final launch environment. Only after that does it hand the prepared execution request to `UnifiedExecProcessManager`, which actually starts the process.

The file also supports a special Unix-oriented “zsh fork” mode, which can start commands through a prepared zsh-based backend when conditions allow. If that path is not usable, it falls back to direct execution. It has careful behavior around PowerShell, shell snapshots, remote environments, sandbox-denied errors, and network-denial cancellation so that commands fail in understandable and policy-respecting ways.

#### Function details

##### `unified_exec_options`  (lines 100–111)

```
fn unified_exec_options(
    network_denial_cancellation_token: Option<CancellationToken>,
) -> ExecOptions
```

**Purpose**: Builds the standard execution options for a unified exec command. It sets the normal command timeout and, when provided, also lets network-denial cancellation stop the command early.

**Data flow**: It receives an optional cancellation token. It starts with the default timeout, combines that timeout with the cancellation token if one exists, and returns an `ExecOptions` value that also says output should be captured like shell-tool output.

**Call relations**: The main run path calls this right before asking the sandbox attempt to build the final execution environment. A test calls it directly to prove that timeout and cancellation are combined correctly.

*Call graph*: called by 2 (run, unified_exec_options_combines_default_timeout_with_network_denial_cancellation).


##### `UnifiedExecRuntime::new`  (lines 115–120)

```
fn new(manager: &'a UnifiedExecProcessManager, shell_mode: UnifiedExecShellMode) -> Self
```

**Purpose**: Creates a runtime tied to the shared process manager and the chosen shell-launch mode. This is the small setup step that lets later code use the same approval and sandbox flow for a particular command style.

**Data flow**: It receives a reference to the process manager and a shell mode. It stores both in a new `UnifiedExecRuntime`, which is then ready to approve and launch requests.

**Call relations**: Higher-level code creates this runtime before opening a unified exec session. Tests also create it to check sandbox-directory and zsh-fork policy behavior.

*Call graph*: called by 5 (unified_exec_uses_the_trusted_sandbox_cwd, zsh_fork_execpolicy_allow_preserves_parent_sandbox_override, zsh_fork_first_attempt_preserves_additional_permissions_request, zsh_fork_first_attempt_preserves_parent_sandbox_override, open_session_with_sandbox).


##### `UnifiedExecRuntime::sandbox_preference`  (lines 124–126)

```
fn sandbox_preference(&self) -> SandboxablePreference
```

**Purpose**: Says that this runtime prefers automatic sandbox selection. In plain terms, it lets the broader sandbox system decide the safest suitable sandbox rather than forcing one fixed choice here.

**Data flow**: It reads no request-specific data. It simply returns the `Auto` sandbox preference.

**Call relations**: The sandboxing framework asks this when deciding how to attempt a command. This runtime supplies the preference and leaves the actual sandbox choice to the shared sandbox orchestration code.


##### `UnifiedExecRuntime::escalate_on_failure`  (lines 128–130)

```
fn escalate_on_failure(&self) -> bool
```

**Purpose**: Tells the sandboxing system that, if a sandboxed attempt fails because of restrictions, it may try a higher-permission path when policy allows. This helps commands that genuinely need more access ask for it instead of just failing silently.

**Data flow**: It takes no extra information and returns `true`. That value becomes a signal to the sandbox orchestration layer.

**Call relations**: The sandboxing framework consults this while planning retries after a sandbox failure. This file does not perform the retry itself; it only states that escalation is allowed.


##### `UnifiedExecRuntime::approval_keys`  (lines 136–144)

```
fn approval_keys(&self, req: &UnifiedExecRequest) -> Vec<Self::ApprovalKey>
```

**Purpose**: Creates the reusable identity for an approval decision. Two launches with the same meaningful command, directory, terminal setting, and permissions can share an approval instead of asking again.

**Data flow**: It reads the request’s command, working directory, terminal flag, sandbox permissions, and extra permissions. It canonicalizes the command, meaning it normalizes it for fair comparison, then returns a list containing one approval key.

**Call relations**: The approval flow calls this before asking for approval. Its result is passed into cached approval logic so repeated equivalent unified exec launches can reuse earlier decisions.

*Call graph*: called by 1 (start_approval_async); 1 external calls (vec!).


##### `UnifiedExecRuntime::start_approval_async`  (lines 146–200)

```
fn start_approval_async(
        &'b mut self,
        req: &'b UnifiedExecRequest,
        ctx: ApprovalCtx<'b>,
    ) -> BoxFuture<'b, ReviewDecision>
```

**Purpose**: Starts the approval process for a command that may need permission before running. It either routes the request through a guardian review or asks the session to request command approval, using cached approvals when possible.

**Data flow**: It receives the command request and an approval context containing session, turn, call id, retry reason, and possible guardian review information. It builds approval keys, gathers command details and reasons, then returns a future that eventually produces a review decision such as allow or deny.

**Call relations**: The sandboxing and tool framework calls this when a unified exec request needs approval. It first uses `approval_keys`; then it either hands off to guardian review when a review id exists, or to cached approval wrapping around the session’s command-approval request.

*Call graph*: calls 2 internal fn (approval_keys, with_cached_approval); 2 external calls (pin, review_approval_request).


##### `UnifiedExecRuntime::exec_approval_requirement`  (lines 202–207)

```
fn exec_approval_requirement(
        &self,
        req: &UnifiedExecRequest,
    ) -> Option<ExecApprovalRequirement>
```

**Purpose**: Reports the approval rule already attached to the request. This lets the shared tool framework know whether the command can skip approval, must ask, or has special policy details.

**Data flow**: It reads the request’s `exec_approval_requirement`, clones it, and returns it wrapped as present information.

**Call relations**: The surrounding approval flow asks this runtime what approval requirement applies. The runtime does not reinterpret it; it preserves the decision carried by the request.


##### `UnifiedExecRuntime::permission_request_payload`  (lines 209–217)

```
fn permission_request_payload(
        &self,
        req: &UnifiedExecRequest,
    ) -> Option<PermissionRequestPayload>
```

**Purpose**: Builds the human-readable permission request payload for this command. It packages the shell hook command and justification so an approval prompt can explain what is being requested.

**Data flow**: It reads the request’s hook command and optional justification. It turns them into a bash-style permission request payload and returns it.

**Call relations**: The permission system calls this when it needs text to show or record for a unified exec permission request. It hands off to the payload builder that formats the command as a bash command.

*Call graph*: calls 1 internal fn (bash).


##### `UnifiedExecRuntime::sandbox_permissions`  (lines 219–221)

```
fn sandbox_permissions(&self, req: &UnifiedExecRequest) -> SandboxPermissions
```

**Purpose**: Returns the sandbox permission level requested for this command. This preserves the parent request’s intent, including escalated or additional-permission modes.

**Data flow**: It reads the request’s sandbox permission setting and returns it unchanged.

**Call relations**: The sandboxing framework calls this while deciding how to run the command. Several tests check that both direct and zsh-fork modes preserve the original sandbox permission request.


##### `UnifiedExecRuntime::sandbox_cwd`  (lines 225–227)

```
fn sandbox_cwd(&self, req: &'b UnifiedExecRequest) -> Option<&'b AbsolutePathBuf>
```

**Purpose**: Supplies the trusted working directory to use inside the sandbox. This matters because the user-visible current directory and the sandbox-safe current directory may differ.

**Data flow**: It reads `sandbox_cwd` from the request and returns a reference to it. It does not modify the request.

**Call relations**: The tool runtime framework asks for this before running the command in a sandbox. A test confirms that it returns the sandbox-specific directory, not merely the ordinary command directory.


##### `UnifiedExecRuntime::network_approval_spec`  (lines 229–256)

```
fn network_approval_spec(
        &self,
        req: &UnifiedExecRequest,
        ctx: &ToolCtx,
    ) -> Option<NetworkApprovalSpec>
```

**Purpose**: Prepares the information needed to request network approval later if the command tries to use the network. It describes what command is running, where, under which permissions, and how network access should be mediated.

**Data flow**: It reads the request and current tool context, including file-system sandbox policy, command, working directory, permissions, and network proxy. It preserves denied-read rules, checks whether managed network control applies, and returns a deferred network approval specification when appropriate.

**Call relations**: The tool framework calls this before execution when network access may be controlled. It uses shared helpers to flatten the tool name, preserve sandbox read-denial behavior, and choose the managed network setup.

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

**Purpose**: Turns an approved unified exec request into a launched process. It prepares the shell command, environment variables, sandbox command, network settings, and optional zsh-fork path, then asks the process manager to open the session.

**Data flow**: It receives the request, the current sandbox attempt, and the tool context. It chooses the shell, computes sandbox-aware permissions, builds the environment, applies network settings if present, adjusts paths and shell snapshots for local runs, applies PowerShell-specific fixes when needed, builds the sandbox command, creates execution options, and finally returns a `UnifiedExecProcess` or a clear tool error.

**Call relations**: This is the central execution path called by the tool runtime framework after approval and sandbox setup. It relies on many helper functions to prepare command and environment details, may try the zsh-fork backend first, and ultimately hands the prepared execution environment to `UnifiedExecProcessManager`; sandbox-denied manager errors are translated into sandbox errors the rest of the system understands.

*Call graph*: calls 11 internal fn (apply_package_path_prepend, apply_zsh_fork_path_prepend, build_sandbox_command, disable_powershell_profile_for_elevated_windows_sandbox, exec_env_for_sandbox_permissions, maybe_wrap_shell_lc_with_snapshot, unified_exec_options, env_for, managed_network_for_sandbox_permissions, sandbox_permissions_preserving_denied_reads (+1 more)); 7 external calls (new, default, Rejected, open_session_with_exec_env, matches!, warn!, maybe_prepare_unified_exec).


##### `tests::test_turn_environment`  (lines 435–442)

```
fn test_turn_environment(cwd: AbsolutePathBuf) -> TurnEnvironment
```

**Purpose**: Creates a simple test turn environment rooted at a given directory. Tests use it so they do not need to repeat the setup needed for a realistic command environment.

**Data flow**: It receives an absolute working directory. It builds a default test environment, converts the directory into a path URI, and returns a `TurnEnvironment` with no custom shell override.

**Call relations**: Several tests and helper builders call this when constructing unified exec requests. It hides setup details so each test can focus on the behavior being checked.

*Call graph*: calls 3 internal fn (new, default_for_tests, from_abs_path); 1 external calls (new).


##### `tests::unified_exec_options_combines_default_timeout_with_network_denial_cancellation`  (lines 445–464)

```
fn unified_exec_options_combines_default_timeout_with_network_denial_cancellation()
```

**Purpose**: Checks that execution options keep the normal timeout while also honoring cancellation caused by network denial. This protects against commands running forever after network access has been refused.

**Data flow**: It creates a cancellation token, passes it into `unified_exec_options`, and inspects the returned options. It verifies the capture policy, the default timeout, and that cancelling the original token cancels the stored token too.

**Call relations**: This test directly exercises `unified_exec_options`, the helper used by the real run path before process launch.

*Call graph*: calls 1 internal fn (unified_exec_options); 4 external calls (new, assert!, assert_eq!, panic!).


##### `tests::unified_exec_uses_the_trusted_sandbox_cwd`  (lines 467–501)

```
async fn unified_exec_uses_the_trusted_sandbox_cwd()
```

**Purpose**: Checks that the runtime reports the sandbox working directory, not just the process working directory. This matters because sandbox safety depends on using the trusted directory chosen for the sandbox.

**Data flow**: It creates two temporary directories, one for the normal command directory and one for the sandbox directory. It builds a request containing both, asks the runtime for `sandbox_cwd`, and verifies the returned directory is the sandbox one.

**Call relations**: This test constructs a runtime with `UnifiedExecRuntime::new` and calls the runtime’s sandbox-directory method. It guards the behavior used by the sandbox framework before command execution.

*Call graph*: calls 3 internal fn (new, default, try_from); 5 external calls (new, assert_eq!, test_turn_environment, tempdir, vec!).


##### `tests::zsh_fork_first_attempt_preserves_parent_sandbox_override`  (lines 504–526)

```
async fn zsh_fork_first_attempt_preserves_parent_sandbox_override()
```

**Purpose**: Checks that zsh-fork mode does not weaken a parent request for escalated sandbox permissions. The same permission request should be visible whether the runtime is direct or zsh-fork.

**Data flow**: It creates a request asking for escalated permissions and approval. It builds both direct and zsh-fork runtimes, asks each for the request’s sandbox permissions, and verifies both return the escalated setting unchanged.

**Call relations**: This test uses the runtime constructor, the shared request helper, and the zsh-fork mode helper. It protects the simple `sandbox_permissions` behavior that the broader sandbox flow relies on.

*Call graph*: calls 2 internal fn (new, default); 3 external calls (assert_eq!, test_request, zsh_fork_mode).


##### `tests::zsh_fork_first_attempt_preserves_additional_permissions_request`  (lines 529–545)

```
async fn zsh_fork_first_attempt_preserves_additional_permissions_request()
```

**Purpose**: Checks that zsh-fork mode keeps bounded additional-permission requests sandboxed rather than changing their meaning. This prevents a special launch backend from accidentally broadening or dropping requested permissions.

**Data flow**: It builds a request with `WithAdditionalPermissions`, creates a zsh-fork runtime, asks for sandbox permissions, and verifies the same permission mode comes back.

**Call relations**: This test calls the common request builder and zsh-fork mode builder, then checks the runtime method used by sandbox orchestration.

*Call graph*: calls 2 internal fn (new, default); 3 external calls (assert_eq!, test_request, zsh_fork_mode).


##### `tests::zsh_fork_execpolicy_allow_preserves_parent_sandbox_override`  (lines 548–567)

```
async fn zsh_fork_execpolicy_allow_preserves_parent_sandbox_override()
```

**Purpose**: Checks that zsh-fork mode preserves an exec-policy decision that says approval can be skipped and the sandbox may be bypassed. This makes sure an earlier policy decision is not lost when using the zsh-fork backend.

**Data flow**: It creates a request whose approval requirement is `Skip` with sandbox bypass enabled. It builds a zsh-fork runtime, asks for the approval requirement, and verifies the same skip-and-bypass decision is returned.

**Call relations**: This test exercises `UnifiedExecRuntime::exec_approval_requirement`, using helpers to build the request and zsh-fork runtime configuration.

*Call graph*: calls 2 internal fn (new, default); 3 external calls (assert_eq!, test_request, zsh_fork_mode).


##### `tests::test_request`  (lines 569–595)

```
fn test_request(
        sandbox_permissions: SandboxPermissions,
        exec_approval_requirement: ExecApprovalRequirement,
    ) -> UnifiedExecRequest
```

**Purpose**: Builds a reusable unified exec request for tests. It lets tests vary only sandbox permissions and approval requirements while keeping the rest of the request realistic and consistent.

**Data flow**: It receives sandbox permissions and an approval requirement. It reads the current directory, uses it as both normal and sandbox working directory, fills in a simple zsh command and empty environment fields, and returns a complete `UnifiedExecRequest`.

**Call relations**: The zsh-fork policy tests call this helper so each test can focus on one permission or approval behavior instead of rebuilding the whole request by hand.

*Call graph*: calls 1 internal fn (try_from); 4 external calls (new, test_turn_environment, current_dir, vec!).


##### `tests::zsh_fork_mode`  (lines 597–604)

```
fn zsh_fork_mode() -> UnifiedExecShellMode
```

**Purpose**: Builds a test-only zsh-fork shell mode with placeholder executable paths. It gives tests a valid-looking zsh-fork configuration without needing real zsh-fork execution.

**Data flow**: It reads the current directory and appends fake `zsh` and `execve-wrapper` filenames to make absolute paths. It returns a `UnifiedExecShellMode::ZshFork` containing those paths.

**Call relations**: The zsh-fork tests call this helper when constructing a runtime in zsh-fork mode. It supports policy-focused tests that do not actually launch a process.

*Call graph*: calls 1 internal fn (try_from); 2 external calls (current_dir, ZshFork).
