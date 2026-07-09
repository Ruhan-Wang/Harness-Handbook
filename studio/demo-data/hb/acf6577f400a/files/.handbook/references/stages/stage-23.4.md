# Exec-server, sandbox, and remote transport harnesses  `stage-23.4`

This stage is the test workshop for the system’s execution and remote-connection machinery. It is mostly behind-the-scenes support, but it protects the main work loop where Codex starts commands, reads files, talks to remote servers, and keeps those actions boxed in safely. The shared exec-server test helpers start real or pretend servers, connect over WebSocket or standard input/output, send JSON-RPC messages, and clean everything up. Other tests check the server’s first handshake, health checks, process control, terminal handling, file access, streamed file reads, HTTP requests, and path rules on Unix and Windows.

A second group tests the secure transport pipes: Noise encryption, relay registration, message splitting, ordering, reconnects, and remote-control routing. These make sure messages are private, complete, and delivered to the right place. Another group tests sandboxing on Linux, macOS, and Windows, including filesystem permissions, network blocking, proxy use, command-line wrappers, and signal or input/output forwarding. Wine-based tests bridge into Windows behavior from non-Windows hosts. Finally, RMCP client tests check that remote HTTP-style tool calls and process cleanup still work when routed through the exec-server.

## Files in this stage

### Exec-server harness foundations
These files establish the reusable exec-server test harnesses and then validate the server's basic transport, initialization, health, and core handler behavior.

### `exec-server/tests/common/mod.rs`

`test` · `test startup and test subprocess execution`

The tests in this area need to launch real child processes, not just call Rust functions directly. That creates a practical problem: during tests, the helper programs may not exist as separate installed binaries. This file solves that by teaching the test binary to recognize special command-line arguments and then behave like the needed helper program.

At test startup, a constructor sets up “test binary dispatch.” In plain terms, this is like giving one actor several costumes: depending on the name or first argument used to run it, the same executable can act as the exec server, a filesystem helper, or the Linux sandbox helper. This keeps integration tests realistic without requiring a full installed environment.

The file also includes a small fake program used to test tricky output timing. One mode starts a child and exits immediately. The child waits until a marker path appears, then writes “late output after exit.” This checks that the system still captures output from background streams even after the parent process has ended.

Finally, it can start a real exec-server test instance when invoked as `exec-server --listen <url>`. It builds the runtime paths, creates a Tokio runtime (Tokio is Rust’s async task engine), runs the server, and exits with a success or failure code.

#### Function details

##### `current_test_binary_helper_paths`  (lines 40–51)

```
fn current_test_binary_helper_paths() -> anyhow::Result<(PathBuf, Option<PathBuf>)>
```

**Purpose**: This function tells tests which executable path to use when they need to launch helper programs. On Linux, it also supplies the path for the sandbox helper, because sandboxing is part of the process-launch tests there.

**Data flow**: It reads the path of the currently running test executable. If the operating system is Linux, it looks for a sandbox-helper path prepared by the dispatch setup; if none is available, it falls back to the current test executable. It returns the current executable path plus an optional sandbox executable path.

**Call relations**: Higher-level tests call this when they are about to start processes that need helper binaries. It is used by tests that check delayed output capture and encrypted exec-server routing, so those tests can launch the right helper without knowing how the test binary dispatch was arranged.

*Call graph*: called by 2 (assert_exec_process_retains_output_after_exit_until_streams_close, remote_environment_routes_encrypted_exec_server_rpc); 2 external calls (cfg!, current_exe).


##### `maybe_run_delayed_output_after_exit_from_test_binary`  (lines 53–70)

```
fn maybe_run_delayed_output_after_exit_from_test_binary()
```

**Purpose**: This function checks whether the current test binary was launched in one of the special delayed-output modes. If so, it stops acting like a normal test process and runs the tiny helper behavior needed for that test.

**Data flow**: It reads the command-line arguments. If the first real argument asks for the delayed-output parent mode, it reads a release path and starts the parent helper. If it asks for the child mode, it reads the same kind of path and starts the child helper. If the argument is anything else or missing, it does nothing.

**Call relations**: It is called during the test binary’s early setup, before normal test behavior matters. It hands argument parsing for the release path to `next_release_path_arg`, then hands execution to either `run_delayed_output_after_exit_parent` or `run_delayed_output_after_exit_child` depending on the requested mode.

*Call graph*: calls 3 internal fn (next_release_path_arg, run_delayed_output_after_exit_child, run_delayed_output_after_exit_parent); 1 external calls (args).


##### `next_release_path_arg`  (lines 72–82)

```
fn next_release_path_arg(mut args: impl Iterator<Item = String>) -> PathBuf
```

**Purpose**: This function reads and validates the one path argument required by the delayed-output helper modes. It exists so the parent and child modes both enforce the same simple command-line shape.

**Data flow**: It receives the remaining command-line arguments. It expects exactly one value, turns that string into a filesystem path, and returns it. If the value is missing or there is anything extra, it prints a clear error and exits the process with failure.

**Call relations**: It is used only by `maybe_run_delayed_output_after_exit_from_test_binary` after that function has recognized one of the delayed-output commands. It prepares the release path that is then passed into the parent or child helper.

*Call graph*: called by 1 (maybe_run_delayed_output_after_exit_from_test_binary); 4 external calls (next, from, eprintln!, exit).


##### `run_delayed_output_after_exit_parent`  (lines 84–104)

```
fn run_delayed_output_after_exit_parent(release_path: &Path)
```

**Purpose**: This function starts the delayed-output child process and then exits immediately. It is used to simulate a program whose parent finishes before all output from its process group has arrived.

**Data flow**: It receives a release path. It finds the current test executable, launches that same executable again in child mode with the release path, gives the child no standard input, and then exits successfully. If it cannot find or start the child process, it prints the error and exits with failure.

**Call relations**: It is called by `maybe_run_delayed_output_after_exit_from_test_binary` when the test binary is invoked in delayed-output parent mode. Its job is to create the child process that will later run `run_delayed_output_after_exit_child`, while making the original parent disappear quickly.

*Call graph*: called by 1 (maybe_run_delayed_output_after_exit_from_test_binary); 5 external calls (null, new, current_exe, eprintln!, exit).


##### `run_delayed_output_after_exit_child`  (lines 106–127)

```
fn run_delayed_output_after_exit_child(release_path: &Path)
```

**Purpose**: This function waits for permission to print late output, then writes a test message to standard output. It helps verify that the exec system does not lose output that arrives after the original parent process has exited.

**Data flow**: It receives a release path. It checks for that path repeatedly for up to about ten seconds. Once the path exists, it writes `late output after exit` to standard output, flushes the output so it is really sent, and exits successfully. If writing fails or the path never appears, it prints an error and exits with failure.

**Call relations**: It is reached through `maybe_run_delayed_output_after_exit_from_test_binary` when the current process was launched in child mode. The parent helper creates this child, and an outside test controls when the child is released by creating the watched path.

*Call graph*: called by 1 (maybe_run_delayed_output_after_exit_from_test_binary); 7 external calls (from_millis, exists, eprintln!, stdout, exit, sleep, writeln!).


##### `maybe_run_exec_server_from_test_binary`  (lines 129–192)

```
fn maybe_run_exec_server_from_test_binary(guard: Option<&TestBinaryDispatchGuard>)
```

**Purpose**: This function lets the test executable turn into an exec server process when launched with the right arguments. That allows integration tests to start a real server without needing a separately installed `exec-server` binary.

**Data flow**: It reads the command-line arguments and only continues for `exec-server --listen <url>`. It finds the current executable, builds the runtime paths the server needs, creates a Tokio asynchronous runtime, and runs `codex_exec_server::run_main` using the listen URL. It exits the process with code 0 on success or 1 on failure, printing useful errors along the way.

**Call relations**: It is called during early test binary setup after dispatch has been configured. It uses `linux_sandbox_exe` to decide which sandbox helper path to give the server, then hands off to the real exec-server entry function `codex_exec_server::run_main`.

*Call graph*: calls 2 internal fn (new, linux_sandbox_exe); 6 external calls (run_main, args, current_exe, eprintln!, exit, new_multi_thread).


##### `linux_sandbox_exe`  (lines 194–210)

```
fn linux_sandbox_exe(
    guard: Option<&TestBinaryDispatchGuard>,
    current_exe: &std::path::Path,
) -> Option<PathBuf>
```

**Purpose**: This function chooses the executable path to use for the Linux sandbox helper during tests. On non-Linux systems it returns nothing, because that sandbox helper is not used there.

**Data flow**: It receives the optional test dispatch guard and the current executable path. On Linux, it first tries to use the sandbox path recorded by the guard; if that is not available, it uses the current test executable as the fallback helper. On other operating systems, it ignores both inputs and returns no path.

**Call relations**: It is called by `maybe_run_exec_server_from_test_binary` while preparing runtime paths for a test exec server. Its result is folded into `ExecServerRuntimePaths`, which tells the server where to find the helper programs it may need when executing commands.

*Call graph*: called by 1 (maybe_run_exec_server_from_test_binary).


### `exec-server/tests/common/exec_server.rs`

`test` · `test setup, test message exchange, and teardown`

This file is a small test harness, which means it is like a temporary control panel built only for tests. It starts the Codex helper binary in `exec-server` mode, waits until the server prints the WebSocket address it is listening on, connects to that address, and then lets tests send and receive JSON-RPC messages. JSON-RPC is a simple message format where a client sends named requests or notifications as JSON, and the server answers or emits events.

The harness also creates a temporary `CODEX_HOME` folder so each test gets a clean private workspace. That matters because tests should not depend on a developer’s real settings or leave files behind. The child server process is killed when the harness is dropped, which protects the test suite from orphaned background processes.

A few details make this reliable. Startup is not assumed to be instant, so the code keeps retrying the WebSocket connection for a short time. Incoming events are read with timeouts, so a broken server does not make tests hang forever. The harness can also send deliberately invalid raw text or binary frames, which is useful for testing how the server behaves when clients misbehave.

#### Function details

##### `ExecServerHarness::drop`  (lines 41–43)

```
fn drop(&mut self)
```

**Purpose**: This is the safety cleanup for the test harness. If a test ends without explicitly shutting down the server, it asks the child `exec-server` process to stop so it does not keep running in the background.

**Data flow**: When the harness object is about to be destroyed, it already contains a running child process. The function sends a kill request to that process and ignores any error, because cleanup during drop should not cause a second failure while the test is ending. Nothing is returned.

**Call relations**: This runs automatically when an `ExecServerHarness` goes out of scope. It uses the child process kill operation directly, and it acts as the fallback cleanup path alongside the more explicit `ExecServerHarness::shutdown` method.

*Call graph*: 1 external calls (start_kill).


##### `test_codex_helper_paths`  (lines 51–57)

```
fn test_codex_helper_paths() -> anyhow::Result<TestCodexHelperPaths>
```

**Purpose**: This finds the helper executables that tests need in order to start the real Codex server process. It packages those paths into a small struct so the rest of the harness can use them consistently.

**Data flow**: It asks shared test code for the current test helper binary paths. It then stores the main Codex executable path and, if available, the Linux sandbox helper path in `TestCodexHelperPaths`. The result is either those paths or an error explaining why they could not be found.

**Call relations**: The server startup path calls this from `exec_server_with_env` before spawning the child process. Other test helpers, such as `create_file_system_context`, also use it when they need the same executable locations.

*Call graph*: called by 2 (exec_server_with_env, create_file_system_context); 1 external calls (current_test_binary_helper_paths).


##### `exec_server`  (lines 59–61)

```
async fn exec_server() -> anyhow::Result<ExecServerHarness>
```

**Purpose**: This is the simple default way for tests to start an `exec-server`. It starts the server with no extra environment variables.

**Data flow**: It begins with an empty set of environment overrides. It passes that empty set into `exec_server_with_env`, which does the real startup work. It returns a ready-to-use `ExecServerHarness` or an error if startup or connection fails.

**Call relations**: Many integration tests call this when they need a normal server instance. It is a convenience wrapper over `exec_server_with_env`, so tests only use the more detailed function when they need to customize the server’s environment.

*Call graph*: calls 1 internal fn (exec_server_with_env); called by 24 (create_process_context, completed_streams_release_handle_capacity, file_reads_reject_fifo_without_waiting_for_a_writer, file_reads_reject_named_pipes, open_enforces_the_per_connection_limit_and_close_releases_capacity, open_rejects_handle_ids_longer_than_32_bytes, read_block_supports_non_sequential_offsets_and_lengths, stream_keeps_reading_the_open_file_after_path_replacement, stream_rejects_platform_sandbox, stream_stops_after_an_exact_block_boundary (+14 more)).


##### `exec_server_with_env`  (lines 63–91)

```
async fn exec_server_with_env(env: I) -> anyhow::Result<ExecServerHarness>
```

**Purpose**: This starts a real `exec-server` process for a test, optionally adding custom environment variables. It returns a harness that is already connected to the server over WebSocket.

**Data flow**: It receives environment variable pairs from the caller. It finds the test helper binary, creates a temporary `CODEX_HOME`, builds a child process command for `exec-server --listen ws://127.0.0.1:0`, captures stdout, and starts the process. It reads the actual listening URL from stdout, connects to that WebSocket address, and returns an `ExecServerHarness` containing the temp directory, process, URL, WebSocket connection, and first request id.

**Call relations**: This is the main setup function behind `exec_server`, and specialized tests call it directly when they need custom environment settings. During setup it calls `test_codex_helper_paths`, `read_listen_url_from_stdout`, and `connect_websocket_when_ready` in that order.

*Call graph*: calls 3 internal fn (connect_websocket_when_ready, read_listen_url_from_stdout, test_codex_helper_paths); called by 2 (exec_server, sandboxed_file_system_helper_finds_bwrap_on_preserved_path); 5 external calls (inherit, null, piped, new, new).


##### `ExecServerHarness::websocket_url`  (lines 94–96)

```
fn websocket_url(&self) -> &str
```

**Purpose**: This lets a test inspect the WebSocket address that the server chose. It is useful when a test needs to open another connection or check connection behavior.

**Data flow**: It reads the stored WebSocket URL string from the harness and returns it as borrowed text. It does not change the harness or talk to the server.

**Call relations**: Tests call this as a small accessor after the harness has been created by `exec_server` or `exec_server_with_env`. It does not call other helper functions.


##### `ExecServerHarness::disconnect_websocket`  (lines 98–101)

```
async fn disconnect_websocket(&mut self) -> anyhow::Result<()>
```

**Purpose**: This closes the harness’s current WebSocket connection to the server. Tests use it to check how the server reacts when a client disconnects.

**Data flow**: It starts with the open WebSocket stored in the harness. It sends a normal close frame to the server and returns success if that close request was sent cleanly, or an error if the WebSocket operation failed.

**Call relations**: This is used during tests that need to simulate a dropped or closed client connection. A test can later call `ExecServerHarness::reconnect_websocket` to attach the same harness to the same server again.

*Call graph*: 1 external calls (close).


##### `ExecServerHarness::reconnect_websocket`  (lines 103–107)

```
async fn reconnect_websocket(&mut self) -> anyhow::Result<()>
```

**Purpose**: This opens a new WebSocket connection to the same server URL after the current connection has been closed or replaced. It lets tests continue using the same server process across reconnect scenarios.

**Data flow**: It reads the saved WebSocket URL from the harness. It calls the retrying connection helper, then replaces the harness’s WebSocket field with the newly connected stream. It returns success or a connection error.

**Call relations**: Tests call this after disconnecting or after intentionally disturbing the connection. It relies on `connect_websocket_when_ready`, the same retry helper used during initial server startup.

*Call graph*: calls 1 internal fn (connect_websocket_when_ready).


##### `ExecServerHarness::send_request`  (lines 109–124)

```
async fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<RequestId>
```

**Purpose**: This sends a JSON-RPC request to the server and gives the caller the request id that was used. Tests use that id later to match responses back to the request they sent.

**Data flow**: It receives a method name and JSON parameters. It creates the next integer request id, increments the harness’s counter for future requests, wraps the method and parameters into a JSON-RPC request message, and sends it over the WebSocket. It returns the request id if sending worked.

**Call relations**: Higher-level test setup such as `initialize_exec_server` calls this to ask the server to do something. Internally it delegates the actual JSON encoding and WebSocket send to `ExecServerHarness::send_message`.

*Call graph*: calls 1 internal fn (send_message); called by 1 (initialize_exec_server); 2 external calls (Request, Integer).


##### `ExecServerHarness::send_notification`  (lines 126–136)

```
async fn send_notification(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<()>
```

**Purpose**: This sends a JSON-RPC notification to the server. A notification is like a one-way message: it has a method and parameters, but no request id and no expected direct response.

**Data flow**: It receives a method name and JSON parameters. It wraps them in a JSON-RPC notification message and sends that message through the harness’s WebSocket. The output is just success or an error from sending.

**Call relations**: Test setup code such as `initialize_exec_server` uses this when it needs to inform the server of something without tracking a reply. Like request sending, it passes the final send work to `ExecServerHarness::send_message`.

*Call graph*: calls 1 internal fn (send_message); called by 1 (initialize_exec_server); 1 external calls (Notification).


##### `ExecServerHarness::send_raw_text`  (lines 138–143)

```
async fn send_raw_text(&mut self, text: &str) -> anyhow::Result<()>
```

**Purpose**: This sends an exact text WebSocket frame without wrapping it as JSON-RPC first. Tests use it to check server behavior for malformed or unusual client input.

**Data flow**: It receives a text string from the test. It turns that string into a WebSocket text message and sends it directly over the current connection. It returns success or the WebSocket send error.

**Call relations**: This bypasses the normal `send_message` path on purpose. It is for lower-level protocol tests where the caller wants full control over what bytes the server sees.

*Call graph*: 2 external calls (send, Text).


##### `ExecServerHarness::send_raw_binary`  (lines 145–148)

```
async fn send_raw_binary(&mut self, bytes: Vec<u8>) -> anyhow::Result<()>
```

**Purpose**: This sends an exact binary WebSocket frame to the server. It is useful for tests that need to send non-text or intentionally invalid data.

**Data flow**: It receives a vector of bytes. It turns those bytes into a WebSocket binary message and sends it through the current connection. It returns success or a send error.

**Call relations**: Like `ExecServerHarness::send_raw_text`, this avoids JSON-RPC formatting. It supports tests that focus on protocol robustness rather than normal request and response behavior.

*Call graph*: 2 external calls (send, Binary).


##### `ExecServerHarness::next_event`  (lines 150–152)

```
async fn next_event(&mut self) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: This waits for the next JSON-RPC message from the server using the standard test timeout. It prevents tests from hanging forever if the server never sends anything.

**Data flow**: It reads from the harness’s WebSocket connection. It waits up to the default event timeout, decodes the next text or binary frame as JSON-RPC, and returns that message. If the timeout expires, the connection closes, or the data cannot be decoded, it returns an error.

**Call relations**: Helpers such as `collect_response_body_deltas` call this when they want the next event regardless of its contents. It is a thin wrapper around `ExecServerHarness::next_event_with_timeout` with the usual timeout value.

*Call graph*: calls 1 internal fn (next_event_with_timeout); called by 1 (collect_response_body_deltas).


##### `ExecServerHarness::wait_for_event`  (lines 154–175)

```
async fn wait_for_event(
        &mut self,
        mut predicate: F,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: This keeps reading server messages until one matches a condition chosen by the test. It is useful because servers may send several events, and a test often only cares about one specific response or error.

**Data flow**: It receives a predicate, which is a small yes-or-no test function supplied by the caller. Until the overall timeout expires, it reads the next event with the remaining time and checks it with the predicate. It returns the first matching message, or an error if no matching message arrives in time.

**Call relations**: Higher-level helpers such as `wait_for_response` and `wait_for_error_response` use this to wait for particular server replies. It repeatedly calls `ExecServerHarness::next_event_with_timeout`, shrinking the allowed time on each loop so the total wait remains bounded.

*Call graph*: calls 1 internal fn (next_event_with_timeout); called by 2 (wait_for_error_response, wait_for_response); 2 external calls (now, anyhow!).


##### `ExecServerHarness::shutdown`  (lines 177–183)

```
async fn shutdown(&mut self) -> anyhow::Result<()>
```

**Purpose**: This explicitly stops the child `exec-server` process and waits for it to exit. Tests can call it when they want controlled teardown instead of relying only on automatic cleanup.

**Data flow**: It sends a kill request to the stored child process. Then it waits for the process to finish, but only up to the connection timeout. It returns success when the process exits, or an error if killing or waiting fails or takes too long.

**Call relations**: This is the deliberate teardown counterpart to the automatic `ExecServerHarness::drop` cleanup. It talks directly to the child process and uses a timeout so a stuck server does not stall the whole test run.

*Call graph*: 3 external calls (start_kill, wait, timeout).


##### `ExecServerHarness::send_message`  (lines 185–189)

```
async fn send_message(&mut self, message: JSONRPCMessage) -> anyhow::Result<()>
```

**Purpose**: This is the shared low-level sender for normal JSON-RPC messages. It turns a structured request or notification into JSON text and puts it on the WebSocket.

**Data flow**: It receives a `JSONRPCMessage` value. It serializes that value into a JSON string, wraps the string as a WebSocket text frame, and sends it through the current connection. It returns success or an error from serialization or sending.

**Call relations**: `ExecServerHarness::send_request` and `ExecServerHarness::send_notification` both use this after they build the right kind of JSON-RPC message. Keeping this in one place means both message types are encoded and sent the same way.

*Call graph*: called by 2 (send_notification, send_request); 3 external calls (send, to_string, Text).


##### `ExecServerHarness::next_event_with_timeout`  (lines 191–213)

```
async fn next_event_with_timeout(
        &mut self,
        timeout_duration: Duration,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: This reads the next meaningful server message, with a caller-chosen timeout. It understands basic WebSocket frame types and converts text or binary JSON into a `JSONRPCMessage`.

**Data flow**: It receives a timeout duration and reads frames from the harness’s WebSocket. If it gets text, it parses the text as JSON-RPC; if it gets binary data, it parses the bytes as JSON-RPC. It ignores ping and pong frames, reports an error on close, and reports an error if no usable event arrives before the timeout.

**Call relations**: `ExecServerHarness::next_event` uses this with the standard timeout, while `ExecServerHarness::wait_for_event` uses it with the remaining time in a larger wait. It is the central receive-and-decode function for normal server events.

*Call graph*: called by 2 (next_event, wait_for_event); 5 external calls (next, anyhow!, from_slice, from_str, timeout).


##### `connect_websocket_when_ready`  (lines 216–239)

```
async fn connect_websocket_when_ready(
    websocket_url: &str,
) -> anyhow::Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungst
```

**Purpose**: This connects to the server’s WebSocket address, allowing for the short delay between process startup and the server actually accepting connections. It makes startup tests less flaky.

**Data flow**: It receives a WebSocket URL. It repeatedly tries to connect until it succeeds, the overall connection timeout expires, or it hits an error other than temporary connection refusal. On success it returns the connected WebSocket stream and handshake response; on failure it returns the connection error.

**Call relations**: `exec_server_with_env` calls this after reading the server’s listening URL, and `ExecServerHarness::reconnect_websocket` calls it when a test needs a fresh connection. It hands the ready WebSocket stream back to the harness.

*Call graph*: called by 2 (reconnect_websocket, exec_server_with_env); 4 external calls (now, matches!, sleep, connect_async).


##### `read_listen_url_from_stdout`  (lines 241–266)

```
async fn read_listen_url_from_stdout(child: &mut Child) -> anyhow::Result<String>
```

**Purpose**: This waits for the newly started server to print the WebSocket URL it is listening on. That URL is needed because the server is started with port `0`, which asks the operating system to choose a free port.

**Data flow**: It receives the child process object, takes its captured stdout, and reads lines until the timeout expires. It trims each line and returns the first one that starts with `ws://`. If stdout is missing, closes too early, or never prints a URL in time, it returns an error.

**Call relations**: `exec_server_with_env` calls this immediately after spawning the server process. The returned URL is then passed to `connect_websocket_when_ready` so the harness can open the WebSocket connection.

*Call graph*: called by 1 (exec_server_with_env); 4 external calls (new, now, anyhow!, timeout).


### `exec-server/src/server/transport_tests.rs`

`test` · `test suite`

This is a test file for the server transport layer: the part that decides how the exec server listens for a client and how messages move between them. The server can listen over a WebSocket address, or it can talk over standard input and output, often called stdio. Stdio is the same basic channel a command-line program uses to read text from a user and print text back.

Most tests here are small checks for `parse_listen_url`, which turns a user-facing `--listen` value into an internal transport choice. They verify that the default WebSocket URL, explicit WebSocket URLs, `stdio`, and `stdio://` are accepted, while unsupported or unsafe-looking forms are rejected with clear error messages. This matters because a bad parser could make the server listen in the wrong place or accept a value it cannot actually use.

The larger async test creates an in-memory pair of pipes, like two connected walkie-talkies, so it can run the stdio server without starting a real process. It sends an `initialize` JSON-RPC request, waits for a response containing a session id, then sends the matching `initialized` notification and disconnects. JSON-RPC is a simple request-and-response message format encoded as JSON. This test proves the stdio transport can read one-line JSON messages, answer them, and shut down cleanly when the client goes away.

#### Function details

##### `parse_listen_url_accepts_default_websocket_url`  (lines 27–37)

```
fn parse_listen_url_accepts_default_websocket_url()
```

**Purpose**: This test proves that the built-in default listen URL is valid and becomes the expected WebSocket listening address. It guards against accidentally changing the default into something the server cannot parse.

**Data flow**: It starts with `DEFAULT_LISTEN_URL`, passes that text into `parse_listen_url`, and expects a successful result. The parsed result is then compared with the expected WebSocket transport bound to `127.0.0.1:0`, where port `0` means the operating system may choose an available port.

**Call relations**: This is one of the direct parser checks in the file. It calls `parse_listen_url` and uses an equality assertion to confirm the parser returns the exact transport choice the rest of the server startup code would rely on.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_accepts_stdio`  (lines 40–43)

```
fn parse_listen_url_accepts_stdio()
```

**Purpose**: This test checks that the plain word `stdio` is accepted as a request to communicate through standard input and output. That keeps the command-line spelling simple and stable for users or tools that launch the server this way.

**Data flow**: It gives the text `stdio` to `parse_listen_url`. The expected before-to-after change is from a user-written string to the internal value `ExecServerListenTransport::Stdio`; the test fails if parsing returns an error or a different transport.

**Call relations**: Like the other parser tests, it focuses on one supported input form. It calls `parse_listen_url` directly and then checks the returned transport with an equality assertion.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_accepts_stdio_url`  (lines 46–49)

```
fn parse_listen_url_accepts_stdio_url()
```

**Purpose**: This test checks that `stdio://` is also accepted as a stdio listen setting. It allows stdio to be written in a URL-like style, matching the shape of settings such as `ws://...`.

**Data flow**: It sends the string `stdio://` into `parse_listen_url`. The parser should turn that string into the same internal stdio transport value as the shorter `stdio` spelling.

**Call relations**: This test complements `parse_listen_url_accepts_stdio` by covering the alternate accepted spelling. It calls the parser and uses an assertion to make sure both forms lead to the same server transport choice.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `stdio_listen_transport_serves_initialize`  (lines 52–112)

```
async fn stdio_listen_transport_serves_initialize()
```

**Purpose**: This asynchronous test proves that the stdio transport can perform the server's opening handshake with a client. It checks that the server reads an `initialize` request, sends back a usable session id, accepts the follow-up `initialized` notification, and exits cleanly when the client disconnects.

**Data flow**: The test begins by parsing `stdio` and building two in-memory communication streams: one direction for client-to-server messages and one for server-to-client messages. It starts the stdio server task with test runtime paths, writes a JSON-RPC `initialize` request into the client side, reads one response line back, decodes it, and confirms the response id matches and the returned session id is not empty. It then writes an `initialized` notification, closes the client streams, and waits for the server task to finish without error.

**Call relations**: This is the main end-to-end transport test in the file. It calls `test_runtime_paths` to provide the server with safe paths for the test run, and it calls `write_jsonrpc_line` twice so the fake client sends correctly formatted one-line JSON-RPC messages. It also exercises the real `run_stdio_connection_with_io` path, so failures here point to problems in the stdio connection flow rather than only in URL parsing.

*Call graph*: calls 2 internal fn (test_runtime_paths, write_jsonrpc_line); 16 external calls (new, from_secs, Notification, Request, Integer, assert!, assert_eq!, panic!, from_str, from_value (+6 more)).


##### `parse_listen_url_accepts_websocket_url`  (lines 115–126)

```
fn parse_listen_url_accepts_websocket_url()
```

**Purpose**: This test confirms that a normal WebSocket listen URL with a numeric IP address and port is accepted. It protects the common network-listening form of the server configuration.

**Data flow**: It passes `ws://127.0.0.1:1234` into `parse_listen_url`. The parser should produce a WebSocket transport containing the socket address `127.0.0.1:1234`, and the test compares the actual result to that expected value.

**Call relations**: This test is part of the parser coverage for accepted inputs. It calls `parse_listen_url` directly and verifies the returned WebSocket address is preserved exactly.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_rejects_invalid_websocket_url`  (lines 129–136)

```
fn parse_listen_url_rejects_invalid_websocket_url()
```

**Purpose**: This test makes sure a WebSocket URL using a hostname, such as `localhost`, is rejected when the server expects a concrete IP address. That keeps listen addresses unambiguous and prevents later binding surprises.

**Data flow**: It gives `ws://localhost:1234` to `parse_listen_url` and expects an error instead of a transport. The error text is then compared with the exact message users should see, explaining that the expected format is `ws://IP:PORT`.

**Call relations**: This is a negative parser test: it checks that bad input is not silently accepted. It calls `parse_listen_url`, expects failure, and uses an equality assertion to lock down the human-readable error message.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_rejects_unsupported_url`  (lines 139–146)

```
fn parse_listen_url_rejects_unsupported_url()
```

**Purpose**: This test checks that unsupported URL schemes, such as `http://`, are rejected with a clear explanation. It prevents users from thinking the exec server can listen over transports it does not implement.

**Data flow**: It passes `http://127.0.0.1:1234` into `parse_listen_url` and expects parsing to fail. The resulting error string is compared with the expected message, which tells the user to use either `ws://IP:PORT` or `stdio`.

**Call relations**: This negative test sits alongside the invalid WebSocket test. It calls `parse_listen_url` directly and confirms both the rejection and the wording that would be shown to someone configuring the server.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `write_jsonrpc_line`  (lines 148–158)

```
async fn write_jsonrpc_line(writer: &mut tokio::io::DuplexStream, message: &JSONRPCMessage)
```

**Purpose**: This helper writes one JSON-RPC message to an in-memory stream in the same line-based format the stdio server expects. It keeps the main stdio test focused on the handshake instead of repeating message-writing details.

**Data flow**: It receives a writable duplex stream and a JSON-RPC message value. It turns the message into JSON bytes, writes those bytes to the stream, then writes a newline byte so the server can read the message as one complete line. It does not return a message; its effect is that the fake client has sent data to the fake server.

**Call relations**: It is called by `stdio_listen_transport_serves_initialize` when that test sends the `initialize` request and later the `initialized` notification. Internally it relies on JSON serialization and asynchronous stream writes so the test uses the same basic message shape as a real stdio client.

*Call graph*: called by 1 (stdio_listen_transport_serves_initialize); 2 external calls (write_all, to_vec).


##### `test_runtime_paths`  (lines 160–166)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: This helper builds the runtime path information needed to start the server inside the test. It supplies the current test executable as the main executable path and leaves the optional Linux sandbox executable unset.

**Data flow**: It reads the path of the currently running executable from the environment, passes that path plus `None` for the sandbox executable into `ExecServerRuntimePaths::new`, and returns the validated runtime paths. If the path cannot be read or validated, the test fails immediately.

**Call relations**: It is called by `stdio_listen_transport_serves_initialize` just before starting `run_stdio_connection_with_io`. Its job is to provide enough realistic setup data for the stdio server task to start without making the test depend on an external sandbox binary.

*Call graph*: calls 1 internal fn (new); called by 1 (stdio_listen_transport_serves_initialize); 1 external calls (current_exe).


### `exec-server/tests/initialize.rs`

`test` · `test run`

This is a small integration test for the exec server, focused on the startup handshake between a client and the server. In plain terms, it starts a real test server, sends an `initialize` message, and makes sure the server replies in the shape a client would need before doing anything else.

The test uses JSON-RPC, which is a simple message format where a client sends a named request with an ID, and the server sends a response with the same ID. That matching ID matters because real clients may have several requests in flight and need to know which answer belongs to which question.

The test sends the server an `InitializeParams` object with a client name and no previous session to resume. It then waits for the next server event and insists that the event is a response, not some other kind of message. After that, it checks two important things: first, the response ID matches the original request ID; second, the returned session ID can be parsed as a UUID, which is a standard unique identifier. Finally, it shuts the test server down cleanly. Without a test like this, the most basic client-server handshake could break without being noticed.

#### Function details

##### `exec_server_accepts_initialize`  (lines 14–36)

```
async fn exec_server_accepts_initialize() -> anyhow::Result<()>
```

**Purpose**: This test proves that the exec server accepts an `initialize` request and returns a usable initialization response. It is meant to catch breakage in the first step a client takes when connecting to the server.

**Data flow**: The test starts with no running server, then creates a test exec server. It sends an `initialize` request containing a client name and no session to resume. The server returns an event; the test expects that event to be a JSON-RPC response, checks that its ID matches the request that was sent, converts the response body into an `InitializeResponse`, and verifies that the session ID is a valid UUID. At the end, it shuts the server down and returns success if all checks passed.

**Call relations**: This function is run by the async Rust test runner. During the test, it asks the shared test helper `exec_server` to start a server, uses serialization helpers to turn request data into JSON and response JSON back into typed Rust data, uses an assertion to confirm the response belongs to the request, and uses UUID parsing as a final sanity check on the server-created session ID. If the next message is not a response, the test deliberately fails immediately.

*Call graph*: calls 1 internal fn (exec_server); 5 external calls (parse_str, assert_eq!, panic!, from_value, to_value).


### `exec-server/tests/health.rs`

`test` · `test run`

This is a small test file for the exec server, which is a background service that other code can talk to over a WebSocket connection. A WebSocket is a long-lived network connection, often used when two programs need to keep sending messages back and forth. The tests here make sure the server is not only available for that main WebSocket use, but also exposes a plain HTTP readiness endpoint called `/readyz`.

The first test starts a real test server, converts its WebSocket address into an HTTP address, and asks `/readyz` whether the server is ready. It expects an HTTP OK response. This matters because health checks are often used by tools, scripts, or deployment systems to decide whether a service is alive and safe to use.

The second test checks a higher-level promise: if an `Environment` is created to use the exec server remotely, asking it for information should give the same answer as asking a local test environment. In everyday terms, the remote path should behave like a faithful telephone line to the same facts, not like a different machine with different answers.

Both tests start their own temporary server and shut it down afterward, so they verify real behavior without leaving a server running behind.

#### Function details

##### `exec_server_serves_readyz_alongside_websocket_endpoint`  (lines 10–22)

```
async fn exec_server_serves_readyz_alongside_websocket_endpoint() -> anyhow::Result<()>
```

**Purpose**: This test verifies that the exec server serves a basic HTTP readiness check at `/readyz` while also offering its WebSocket endpoint. Someone would rely on this to know that health checks and WebSocket service can coexist on the same test server.

**Data flow**: It starts a temporary exec server, reads the server's WebSocket URL, and turns that into an HTTP base address by removing the `ws://` prefix. It then sends an HTTP GET request to `/readyz`, checks that the response status is OK, and finally shuts the server down.

**Call relations**: During the test, it calls the shared `exec_server` helper to start the server. It then uses `format!` to build the readiness URL, `reqwest::get` to make the HTTP request, and `assert_eq!` to confirm the server answered with the expected OK status.

*Call graph*: calls 1 internal fn (exec_server); 3 external calls (assert_eq!, format!, get).


##### `remote_environment_fetches_info_from_exec_server`  (lines 25–36)

```
async fn remote_environment_fetches_info_from_exec_server() -> anyhow::Result<()>
```

**Purpose**: This test verifies that a test `Environment` connected to the exec server behaves as a remote environment and returns the same environment information as the local test environment. It protects the contract that remote execution should report consistent basic facts.

**Data flow**: It starts a temporary exec server and builds an `Environment` using the server's WebSocket URL. It checks that this environment identifies itself as remote, asks it for its information, asks a default local test environment for the same information, compares the two results, and then shuts the server down.

**Call relations**: The test begins by calling the shared `exec_server` helper, then uses `Environment::create_for_tests` to make a remote environment connected to that server. It uses `Environment::default_for_tests` as the local comparison point, and relies on assertions to confirm both that the environment is remote and that the remote and local information match.

*Call graph*: calls 3 internal fn (create_for_tests, default_for_tests, exec_server); 2 external calls (assert!, assert_eq!).


### `exec-server/tests/websocket.rs`

`test` · `test run`

These are integration tests, meaning they start a real exec server and talk to it through its WebSocket interface rather than testing one small function in isolation. A WebSocket is a long-lived connection that lets client and server send messages back and forth, like a phone call instead of mailing separate letters.

The tests focus on safety and robustness. First, they send text that is not JSON at all. The server should report a clear JSON-RPC error, where JSON-RPC is a standard way to format requests and responses as JSON, but it must not crash or stop listening. The test proves this by sending a normal initialize request afterward and checking that a valid session id comes back.

Second, the file checks that the same kind of JSON-RPC request works when sent as a binary WebSocket message. Some clients may send JSON bytes rather than text frames, so the server needs to understand both.

Third, it verifies a security rule: a WebSocket handshake that looks like it came from a browser page, shown by an Origin header, is rejected with HTTP 403 Forbidden. Without this, a malicious website might be able to trick a user’s browser into connecting to the local exec server.

#### Function details

##### `exec_server_reports_malformed_websocket_json_and_keeps_running`  (lines 21–68)

```
async fn exec_server_reports_malformed_websocket_json_and_keeps_running() -> anyhow::Result<()>
```

**Purpose**: This test makes sure one bad WebSocket message does not poison the whole connection or crash the server. It sends invalid JSON, expects a proper error response, then sends a normal initialize request to prove the server is still usable.

**Data flow**: The test starts a fresh exec server, then sends the raw text `not-json` into its WebSocket. It waits until the server sends back a JSON-RPC error, checks that the error has the expected id, code, and message prefix, then sends a valid `initialize` request. The server replies with initialize data, and the test parses the returned session id as a UUID to confirm it looks real before shutting the server down.

**Call relations**: This test begins by calling the shared test helper `exec_server` to launch a server instance. It then uses the test server’s WebSocket helper methods to send raw input and wait for protocol messages. After the malformed-message checks, it hands a valid initialize payload through JSON serialization and checks the response by deserializing it back into `InitializeResponse`.

*Call graph*: calls 1 internal fn (exec_server); 6 external calls (parse_str, assert!, assert_eq!, panic!, from_value, to_value).


##### `exec_server_accepts_binary_websocket_json`  (lines 71–104)

```
async fn exec_server_accepts_binary_websocket_json() -> anyhow::Result<()>
```

**Purpose**: This test checks that the exec server accepts JSON-RPC messages sent as binary WebSocket frames, not only as text frames. That matters because different WebSocket clients may choose either form even when the content is still JSON.

**Data flow**: The test starts a server, builds an `initialize` JSON-RPC request with request id `1`, converts that request into JSON bytes, and sends those bytes as a binary WebSocket message. It waits for the matching response, checks that the response id is the same as the request id, converts the response payload into `InitializeResponse`, and verifies the session id is a valid UUID. Finally, it shuts the server down.

**Call relations**: Like the other WebSocket tests, this uses `exec_server` to create a real server under test. It constructs the request using the JSON-RPC protocol types, serializes it to bytes, sends it through the test WebSocket connection, and then relies on the server’s normal initialize path to produce a response.

*Call graph*: calls 1 internal fn (exec_server); 8 external calls (parse_str, Request, Integer, assert_eq!, panic!, from_value, to_value, to_vec).


##### `exec_server_rejects_browser_origin_websocket_handshake`  (lines 107–125)

```
async fn exec_server_rejects_browser_origin_websocket_handshake() -> anyhow::Result<()>
```

**Purpose**: This test verifies that the server refuses WebSocket connections that include a browser `Origin` header. This is a security check to reduce the risk that an untrusted web page can connect to the exec server.

**Data flow**: The test starts a server and builds a WebSocket connection request for that server’s URL. Before connecting, it adds an `Origin` header with the value `https://evil.example`, pretending the request came from a browser page. The connection attempt must fail; the test then checks that the failure is an HTTP response with status `403 Forbidden`. It shuts the server down afterward.

**Call relations**: The test uses `exec_server` to launch the server, then bypasses the usual test connection helper so it can customize the WebSocket handshake request. It calls `connect_async` to attempt the handshake and expects the server’s WebSocket security layer to reject it before any normal JSON-RPC communication begins.

*Call graph*: calls 1 internal fn (exec_server); 4 external calls (from_static, bail!, assert_eq!, connect_async).


### `exec-server/src/server/handler/tests.rs`

`test` · `test suite`

These tests act like a careful user of the exec server. They build a real handler, initialize it like a client connection would, start small shell commands, read their output, and shut everything down afterward. The helper functions make portable command arguments, because sleeping or printing text looks different on Unix and Windows.

The file focuses on situations that are easy to get wrong in a process-running service. One test starts the same process ID twice at the same time and confirms only one wins. Another asks to terminate a short-lived process after it has already finished and expects the server to say it is no longer running. Two tests check session resume rules: an active session cannot be attached by a second connection, but after a connection is shut down, a pending long-poll read must fail clearly because another connection has resumed the session. A “long-poll” read means a read request that waits for output instead of returning immediately.

The last test makes sure output and exit information are still saved even if the notification channel is gone. This matters because notifications are like doorbells: if the doorbell breaks, the package should still be kept so the client can pick it up by reading later.

#### Function details

##### `exec_params`  (lines 22–24)

```
fn exec_params(process_id: &str) -> ExecParams
```

**Purpose**: Builds a standard request for starting a short-lived test process. Tests use it when they only care that some process runs briefly, not about the exact command.

**Data flow**: It takes a process ID string, asks `sleep_argv` for a small platform-appropriate sleep command, and passes both into `exec_params_with_argv`. The result is a complete `ExecParams` value ready to send to the handler.

**Call relations**: This is a convenience wrapper used by tests such as `terminate_reports_false_after_process_exit` and `output_and_exit_are_retained_after_notification_receiver_closes`. It delegates the detailed request-building work to `exec_params_with_argv` so the tests can stay focused on behavior.

*Call graph*: calls 2 internal fn (exec_params_with_argv, sleep_argv); called by 2 (output_and_exit_are_retained_after_notification_receiver_closes, terminate_reports_false_after_process_exit).


##### `exec_params_with_argv`  (lines 26–37)

```
fn exec_params_with_argv(process_id: &str, argv: Vec<String>) -> ExecParams
```

**Purpose**: Builds a full process-start request from a process ID and an exact command line. Tests use it when they need a process to sleep, print output, or stay quiet for a while.

**Data flow**: It receives a process ID and a list of command arguments. It adds the current working directory, a small inherited environment containing `PATH`, and fixed test settings such as no terminal and no piped standard input, then returns an `ExecParams` request.

**Call relations**: This function is called by `exec_params` for the default sleep command and directly by tests that need custom command behavior. It relies on `inherited_path_env` so child commands can still find system programs.

*Call graph*: calls 3 internal fn (from, inherited_path_env, from_path); called by 3 (exec_params, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes); 1 external calls (current_dir).


##### `inherited_path_env`  (lines 39–45)

```
fn inherited_path_env() -> HashMap<String, String>
```

**Purpose**: Creates the small environment map passed to test child processes. It preserves the `PATH` variable so shell commands like `sleep`, `ping`, or `echo` can be found.

**Data flow**: It starts with an empty map, checks whether the current test process has a `PATH` environment variable, and copies it into the map if present. It returns that map for use in process-start parameters.

**Call relations**: It is used by `exec_params_with_argv` while building an `ExecParams` request. This keeps environment setup in one small place instead of repeating it in every test helper.

*Call graph*: called by 1 (exec_params_with_argv); 2 external calls (new, var_os).


##### `sleep_argv`  (lines 47–49)

```
fn sleep_argv() -> Vec<String>
```

**Purpose**: Provides a short sleep command that works on the current operating system. It gives tests a simple process that stays alive briefly and then exits.

**Data flow**: It has no input. It chooses the Unix-style script `sleep 0.1` or the Windows-style `ping` delay by passing both options to `shell_argv`, and returns the resulting command argument list.

**Call relations**: It is called by `exec_params`, which uses it as the default command for short process tests. The operating-system choice is handed off to `shell_argv`.

*Call graph*: calls 1 internal fn (shell_argv); called by 1 (exec_params).


##### `shell_argv`  (lines 51–65)

```
fn shell_argv(unix_script: &str, windows_script: &str) -> Vec<String>
```

**Purpose**: Turns a small shell script into the correct command arguments for Unix or Windows. This lets the same tests run on different operating systems.

**Data flow**: It receives two script strings: one for Unix-like systems and one for Windows. It checks which operating system the test is running on, then returns an argument list using `/bin/sh -c ...` on Unix or the Windows command processor with `/C ...` on Windows.

**Call relations**: Helpers and tests call this when they need a portable command, including `sleep_argv`, `long_poll_read_fails_after_session_resume`, and `output_and_exit_are_retained_after_notification_receiver_closes`. It is the file’s small adapter between test intentions and operating-system-specific command syntax.

*Call graph*: called by 3 (long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, sleep_argv); 2 external calls (cfg!, vec!).


##### `windows_command_processor`  (lines 67–69)

```
fn windows_command_processor() -> String
```

**Purpose**: Finds the Windows command shell to use for running test scripts. If Windows does not provide a `COMSPEC` value, it falls back to `cmd.exe`.

**Data flow**: It reads the `COMSPEC` environment variable. If that variable exists, it returns its value; otherwise it returns the string `cmd.exe`.

**Call relations**: This supports the Windows path for shell command construction. It keeps the fallback rule separate so the command-building code can stay simple.

*Call graph*: 1 external calls (var).


##### `test_runtime_paths`  (lines 71–77)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Builds the runtime path information needed to create an `ExecServerHandler` in tests. This gives the handler the executable path it expects without requiring a full production setup.

**Data flow**: It reads the path of the currently running test executable and passes it into `ExecServerRuntimePaths::new`, with no Linux sandbox executable. It returns the runtime paths object or fails the test if those paths cannot be built.

**Call relations**: Several setup paths call this before creating a handler, including `initialized_handler` and tests that construct handlers directly. It supplies the same runtime-path setup everywhere so tests are consistent.

*Call graph*: calls 1 internal fn (new); called by 4 (active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes); 1 external calls (current_exe).


##### `initialized_handler`  (lines 79–97)

```
async fn initialized_handler() -> Arc<ExecServerHandler>
```

**Purpose**: Creates an exec server handler that has already completed the initialization steps expected from a client connection. Tests use it when they want to start from a ready-to-use server state.

**Data flow**: It creates an outgoing notification channel, a session registry, and a handler with test runtime paths. It sends an initialize request, checks that the returned session ID is a valid UUID, marks the handler as initialized, and returns it wrapped in `Arc`, a shared pointer that lets async tasks hold the same handler safely.

**Call relations**: This setup helper is used by tests that do not need custom session-resume wiring, such as duplicate process ID and termination behavior tests. It calls `test_runtime_paths` as part of building the handler.

*Call graph*: calls 4 internal fn (new, new, test_runtime_paths, new); called by 2 (duplicate_process_ids_allow_only_one_successful_start, terminate_reports_false_after_process_exit); 3 external calls (new, parse_str, channel).


##### `duplicate_process_ids_allow_only_one_successful_start`  (lines 100–125)

```
async fn duplicate_process_ids_allow_only_one_successful_start()
```

**Purpose**: Checks that two simultaneous requests cannot start two processes with the same process ID. This protects the server from confusing one client’s process with another copy that has the same name.

**Data flow**: It creates an initialized handler, clones the shared handler pointer twice, and launches two `exec` calls at the same time using the same process ID. It separates the results into successes and failures, expects exactly one of each, checks the duplicate-process error details, waits for the short process to finish, and shuts down the handler.

**Call relations**: This test relies on `initialized_handler` for setup and `exec_params` for the start requests. It exercises the handler’s concurrent process registration path by making both requests race each other.

*Call graph*: calls 1 internal fn (initialized_handler); 5 external calls (clone, from_millis, assert_eq!, join!, sleep).


##### `terminate_reports_false_after_process_exit`  (lines 128–154)

```
async fn terminate_reports_false_after_process_exit()
```

**Purpose**: Checks that terminating a process that has already finished reports `running: false`. This matters because clients need a truthful answer, not a stale claim that the process is still alive.

**Data flow**: It starts a short test process, then repeatedly sends a terminate request for that process until the response says the process is no longer running. It gives the process up to one second to reach that state, then shuts down the handler.

**Call relations**: The test uses `initialized_handler` for a ready handler and `exec_params` for the short-lived process. It repeatedly calls the handler’s terminate operation to observe the transition from running or recently exited to definitely not running.

*Call graph*: calls 3 internal fn (from, exec_params, initialized_handler); 5 external calls (from_millis, from_secs, assert!, now, sleep).


##### `long_poll_read_fails_after_session_resume`  (lines 157–227)

```
async fn long_poll_read_fails_after_session_resume()
```

**Purpose**: Checks that a waiting read request fails clearly when its session is resumed by another connection. This prevents an old connection from quietly continuing to read after ownership has moved elsewhere.

**Data flow**: It creates a first handler and starts a quiet, long-running process. It then starts an async read request with a wait time, shuts down the first handler, creates a second handler using the same registry, and initializes it with the first session’s ID. Finally it waits for the old read task and checks that it failed with the expected “session resumed” error.

**Call relations**: This test builds handlers directly instead of using `initialized_handler` because it needs to share a `SessionRegistry` across two connections. It uses `exec_params_with_argv` and `shell_argv` to start a process that stays alive without producing output, making sure the read only finishes because the session was resumed.

*Call graph*: calls 7 internal fn (from, new, new, exec_params_with_argv, shell_argv, test_runtime_paths, new); 7 external calls (clone, new, from_millis, assert_eq!, channel, spawn, sleep).


##### `active_session_resume_is_rejected`  (lines 230–270)

```
async fn active_session_resume_is_rejected()
```

**Purpose**: Checks that a second connection cannot resume a session while the first connection is still attached. This protects one live client from being unexpectedly displaced by another.

**Data flow**: It creates a first handler, initializes a new session, then creates a second handler using the same session registry. The second handler tries to initialize with the first session’s ID, and the test checks that the request fails with the expected error message. It then shuts down the first handler.

**Call relations**: This test constructs its own handlers because it needs two connections sharing one registry. It uses `test_runtime_paths` during each handler setup and then exercises the initialization path that enforces exclusive session attachment.

*Call graph*: calls 4 internal fn (new, new, test_runtime_paths, new); 4 external calls (clone, new, assert_eq!, channel).


##### `output_and_exit_are_retained_after_notification_receiver_closes`  (lines 273–314)

```
async fn output_and_exit_are_retained_after_notification_receiver_closes()
```

**Purpose**: Checks that process output and exit status are still saved even if the notification receiver has been dropped. This ensures clients can recover information by polling reads, even when live notifications cannot be delivered.

**Data flow**: It creates and initializes a handler with a notification channel, starts a process that prints two lines and exits, then drops the receiving end of the notification channel. It reads the process until closed, confirms the output and exit code were retained, waits briefly, starts a new process with the same ID to confirm the old finished process no longer blocks reuse, and shuts down.

**Call relations**: This test uses `exec_params_with_argv` and `shell_argv` for the printing command, then calls `read_process_until_closed` to collect saved output through the read API. It later uses `exec_params` to check that the process ID can be reused after retained exit data has been handled.

*Call graph*: calls 9 internal fn (from, new, new, exec_params, exec_params_with_argv, read_process_until_closed, shell_argv, test_runtime_paths, new); 5 external calls (new, from_millis, assert_eq!, channel, sleep).


##### `read_process_until_closed`  (lines 316–352)

```
async fn read_process_until_closed(
    handler: &ExecServerHandler,
    process_id: ProcessId,
) -> (String, Option<i32>)
```

**Purpose**: Reads all available output from a process until the server says the process record is closed. It is a test helper for turning repeated read responses into one final output string and exit code.

**Data flow**: It receives a handler reference and a process ID. It repeatedly sends `exec_read` requests, appends returned byte chunks to a string, tracks the latest sequence number so it does not reread the same chunks, records the exit code once the process has exited, and returns the collected output and exit code when the response says the process is closed.

**Call relations**: This helper is called by `output_and_exit_are_retained_after_notification_receiver_closes`. It drives the handler’s read API in a loop, using long-poll waits so the test can wait for output and closure without busy-spinning.

*Call graph*: calls 1 internal fn (exec_read); called by 1 (output_and_exit_are_retained_after_notification_receiver_closes); 6 external calls (from_secs, from_utf8_lossy, new, assert!, clone, now).


### `exec-server/tests/process.rs`

`test` · `test run`

These are Unix-only integration tests. Instead of testing one small function in isolation, they start a real exec server test fixture and speak to it the way a client would: by sending JSON-RPC messages over a WebSocket. JSON-RPC is a simple request-and-response message format, and a WebSocket is a long-lived connection between client and server.

The file checks three user-visible promises. First, after the normal startup handshake, a client can ask the server to start a process and gets back the same process id it requested. Second, if a client does not explicitly ask for piped standard input, the server treats standard input as closed. That matters because a client should not be able to write to a process unless it asked for that pipe. Third, if the WebSocket connection drops and reconnects with the same session id, already-running detached processes should still be there. This is like hanging up a phone call and calling back with the same ticket number: the job should not disappear just because the line dropped.

Each test follows the same broad rhythm: start the test server, initialize the session, send process-related requests, wait for matching responses, decode those responses into strongly typed Rust structures, assert the expected behavior, and finally shut the server down.

#### Function details

##### `exec_server_starts_process_over_websocket`  (lines 19–79)

```
async fn exec_server_starts_process_over_websocket() -> anyhow::Result<()>
```

**Purpose**: This test proves that a client can start a process through the exec server's WebSocket API. It uses the harmless Unix command `true`, which starts and exits successfully, so the test focuses on the server protocol rather than on process output.

**Data flow**: The test starts a fresh test server, sends an `initialize` request with a client name, waits for the matching response, then sends an `initialized` notification to finish the handshake. It then sends a `process/start` request containing a chosen process id, command arguments, current working directory, environment, and input settings. The server replies with JSON, the test turns that JSON into an `ExecResponse`, and the final check confirms that the response contains the requested process id. The test then shuts the server down.

**Call relations**: This function calls the shared `exec_server` test helper to create a real server connection. It then drives the server using request and notification helpers on that test server object. The external JSON conversion helpers build and decode protocol messages, while assertions verify that the response from the server matches the expected start-process result.

*Call graph*: calls 1 internal fn (exec_server); 5 external calls (assert_eq!, panic!, from_value, json!, to_value).


##### `exec_server_defaults_omitted_pipe_stdin_to_closed_stdin`  (lines 82–172)

```
async fn exec_server_defaults_omitted_pipe_stdin_to_closed_stdin() -> anyhow::Result<()>
```

**Purpose**: This test checks a subtle default: when `pipeStdin` is left out of a `process/start` request, the server should behave as if standard input is closed. That prevents clients from writing to a process unless they explicitly asked for a writable input pipe.

**Data flow**: The test starts and initializes the server, then starts a shell command without including `pipeStdin` in the request. The shell command would read from standard input if input were available. After confirming that the process started, the test sends a `process/write` request with a base64-encoded chunk of text. The server responds with a `WriteResponse`, and the test checks that the status is `StdinClosed`, meaning the write was rejected because there is no open input pipe. Finally, the test shuts the server down.

**Call relations**: Like the other tests, this function relies on `exec_server` to create the test server and uses the server fixture to send JSON-RPC messages. It hands process-start and process-write requests to the running server, then uses JSON decoding and equality assertions to confirm the server chose the safe default behavior for omitted standard-input settings.

*Call graph*: calls 1 internal fn (exec_server); 5 external calls (assert_eq!, panic!, from_value, json!, to_value).


##### `exec_server_resumes_detached_session_without_killing_processes`  (lines 175–307)

```
async fn exec_server_resumes_detached_session_without_killing_processes() -> anyhow::Result<()>
```

**Purpose**: This test proves that reconnecting to an existing session does not kill processes that were already running. It checks that a session can be resumed by id and that a long-running process is still alive after the WebSocket connection is dropped and restored.

**Data flow**: The test starts a server and initializes a new session, saving the returned session id. It then starts a long-running shell command, `sleep 5`, under the process id `proc-resume`. Next it deliberately disconnects the WebSocket and reconnects. It sends another `initialize` request, this time including the saved session id, and checks that the server returns the same session information as before. After sending `initialized` again, it asks to read the process state. The response is decoded into a `ReadResponse`, and the test verifies there is no failure, the process has not exited, and the stream is not closed. It then sends `process/terminate`, checks that the server reports the process was running, and shuts everything down.

**Call relations**: This function uses the shared `exec_server` fixture to exercise the server as a real client would. It first establishes a session, then uses the fixture's disconnect and reconnect operations to simulate a dropped WebSocket. After resuming with the saved session id, it sends read and terminate requests to prove the server kept the process alive across the connection break.

*Call graph*: calls 1 internal fn (exec_server); 6 external calls (assert!, assert_eq!, panic!, from_value, json!, to_value).


### `exec-server/tests/exec_process.rs`

`test` · `test execution`

The exec process system is the part of the project that lets code launch a command, watch its output, write to its input, and learn when it exits. This test file acts like a careful user of that system. It starts small shell commands, waits for their output, and checks that every important event arrives in the right order.

The tests cover two paths: a local backend, where the process is run directly, and a remote backend, where a separate exec-server is started and contacted over a WebSocket connection. That matters because both paths should feel the same to callers. If one path lost output, reported exit too early, or failed to wake readers, higher-level tools would behave unpredictably.

Several helper functions make the tests easier to read. One creates either a local or remote process context. Others collect output by repeatedly calling `read`, or by subscribing to pushed events. The tests then use those helpers to verify normal exits, stdout and stderr streaming, late subscribers, output that arrives after the parent process exits, stdin writing, rejected writes, interrupt signals, Windows unsupported-signal errors, and transport disconnects.

A useful analogy is a theater stage monitor: these tests make sure the control booth can start the actor, hear every line, send cues, notice the final bow, and detect if the audio cable is unplugged.

#### Function details

##### `create_process_context`  (lines 52–67)

```
async fn create_process_context(use_remote: bool) -> Result<ProcessContext>
```

**Purpose**: Builds the test setup for either local process execution or remote execution through a real exec-server. Tests use it so they can run the same checks against both backends.

**Data flow**: It receives a `use_remote` choice. If remote is requested, it starts an exec-server, builds a test environment that points at that server, and returns both the backend and the server harness. If local is requested, it builds a test environment with no server URL and returns only the backend.

**Call relations**: Most assertion helpers begin by calling this function. It hides the setup difference so tests such as the output, stdin, signal, and queued-event checks can focus on process behavior instead of connection setup.

*Call graph*: calls 2 internal fn (create_for_tests, exec_server); called by 12 (assert_exec_process_preserves_queued_events_before_subscribe, assert_exec_process_pushes_events, assert_exec_process_rejects_write_without_pipe_stdin, assert_exec_process_replays_events_after_close, assert_exec_process_retains_output_after_exit_until_streams_close, assert_exec_process_signal_interrupts_process, assert_exec_process_signal_reports_unsupported_on_windows, assert_exec_process_starts_and_exits, assert_exec_process_streams_output, assert_exec_process_write_then_read (+2 more)).


##### `assert_exec_process_starts_and_exits`  (lines 69–92)

```
async fn assert_exec_process_starts_and_exits(use_remote: bool) -> Result<()>
```

**Purpose**: Checks the simplest promise of the process system: it can start a command and report that it exited successfully. It uses the `true` command, which immediately exits with code 0.

**Data flow**: It receives whether to test local or remote execution, creates the matching context, starts a process with ID `proc-1`, subscribes for wake notifications, reads until the process closes, and confirms the exit code is 0.

**Call relations**: The public test `exec_process_starts_and_exits` calls this helper. It relies on `create_process_context` for setup and `collect_process_output_from_reads` to wait through the process lifecycle.

*Call graph*: calls 4 internal fn (from, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_starts_and_exits); 5 external calls (default, assert!, assert_eq!, current_dir, vec!).


##### `read_process_until_change`  (lines 94–111)

```
async fn read_process_until_change(
    session: Arc<dyn ExecProcess>,
    wake_rx: &mut watch::Receiver<u64>,
    after_seq: Option<u64>,
) -> Result<ReadResponse>
```

**Purpose**: Reads from a process, and if nothing has changed yet, waits briefly for a wake-up signal before trying again. This prevents tests from guessing with sleeps while still avoiding hangs.

**Data flow**: It receives a process session, a wake receiver, and an optional sequence number saying where reading should continue. It first does a non-waiting read. If there is no output, no closure, and no failure, it waits up to two seconds for the process to announce a change, then reads again. It returns the latest read response.

**Call relations**: Output-collecting helpers use this as their polling loop. The signal test also uses it while waiting for a readiness message, and the disconnect test uses it to confirm a failed remote connection is visible through reads.

*Call graph*: called by 3 (assert_exec_process_signal_interrupts_process, collect_process_output_from_reads, remote_exec_process_reports_transport_disconnect); 3 external calls (from_secs, changed, timeout).


##### `collect_process_output_from_reads`  (lines 113–140)

```
async fn collect_process_output_from_reads(
    session: Arc<dyn ExecProcess>,
    mut wake_rx: watch::Receiver<u64>,
) -> Result<(String, Option<i32>, bool)>
```

**Purpose**: Collects all output from a process by repeatedly using the process `read` API until the session closes. It is the main helper for tests that care about the final combined output and exit status.

**Data flow**: It receives a process session and its wake receiver. It keeps track of the last sequence number seen, appends every returned output chunk to a string, records the exit code when reported, and stops when the process is closed. It returns the collected output, optional exit code, and a true closed flag.

**Call relations**: Many assertion helpers call this after starting or interacting with a process. Internally it delegates the wait-and-read step to `read_process_until_change`, then hands the final result back to the specific test scenario.

*Call graph*: calls 1 internal fn (read_process_until_change); called by 9 (assert_exec_process_preserves_queued_events_before_subscribe, assert_exec_process_rejects_write_without_pipe_stdin, assert_exec_process_replays_events_after_close, assert_exec_process_retains_output_after_exit_until_streams_close, assert_exec_process_signal_interrupts_process, assert_exec_process_starts_and_exits, assert_exec_process_streams_output, assert_exec_process_write_then_read, assert_exec_process_write_then_read_without_tty); 4 external calls (clone, from_utf8_lossy, new, bail!).


##### `collect_process_output_from_events`  (lines 142–174)

```
async fn collect_process_output_from_events(
    session: Arc<dyn ExecProcess>,
) -> Result<(String, String, Option<i32>, bool)>
```

**Purpose**: Collects stdout, stderr, exit code, and closure by listening to pushed process events instead of polling with reads. This checks the event-subscription side of the API.

**Data flow**: It receives a process session, subscribes to its event stream, and waits for events with a timeout. Output events are split into stdout or stderr strings, exit events record the code, and a closed event ends the loop. If a failure event appears first, the function returns an error.

**Call relations**: The replay-after-close test calls this after the process has already finished through the read path. That verifies late event subscribers can still receive the completed process history.

*Call graph*: called by 1 (assert_exec_process_replays_events_after_close); 5 external calls (from_secs, from_utf8_lossy, new, bail!, timeout).


##### `collect_process_event_snapshots`  (lines 176–203)

```
async fn collect_process_event_snapshots(
    session: Arc<dyn ExecProcess>,
) -> Result<Vec<ProcessEventSnapshot>>
```

**Purpose**: Records the exact sequence of process events in a compact test-friendly form. It is used when the order and sequence numbers matter, not just the final text.

**Data flow**: It receives a process session, subscribes to events, and converts each event into a `ProcessEventSnapshot`. Output bytes become readable text, exit and close events keep their sequence numbers, and the list is returned once a close event is seen.

**Call relations**: The event-order test calls this helper. It turns the live event stream into a plain list that can be compared against the expected stdout, stderr, exit, and close sequence.

*Call graph*: called by 1 (assert_exec_process_pushes_events); 6 external calls (from_secs, from_utf8_lossy, new, bail!, matches!, timeout).


##### `assert_exec_process_streams_output`  (lines 205–234)

```
async fn assert_exec_process_streams_output(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that normal stdout from a running process can be read by clients. It runs a shell command that prints a known line after a short delay.

**Data flow**: It receives the local-or-remote choice, creates a context, starts a shell command, verifies the process ID, then reads until closure. It expects exactly `session output\n`, exit code 0, and a closed session.

**Call relations**: The public test `exec_process_streams_output` calls this helper. It uses `create_process_context` for backend setup and `collect_process_output_from_reads` to gather the process result.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_streams_output); 5 external calls (default, assert!, assert_eq!, current_dir, vec!).


##### `assert_exec_process_pushes_events`  (lines 236–281)

```
async fn assert_exec_process_pushes_events(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that the process event stream reports stdout, stderr, exit, and close in the expected order. This is important for clients that subscribe to live events rather than repeatedly calling read.

**Data flow**: It receives the local-or-remote choice, starts a shell command that writes to stdout, then stderr, then exits with code 7. It collects event snapshots and compares them with the exact expected sequence.

**Call relations**: The public test `exec_process_pushes_events` calls this helper. It depends on `collect_process_event_snapshots` to turn asynchronous events into a comparable list.

*Call graph*: calls 3 internal fn (collect_process_event_snapshots, create_process_context, from_path); called by 1 (exec_process_pushes_events); 4 external calls (default, assert_eq!, current_dir, vec!).


##### `assert_exec_process_replays_events_after_close`  (lines 283–324)

```
async fn assert_exec_process_replays_events_after_close(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that event subscribers can still see output after a process has already finished. This protects clients that attach late from missing the process history.

**Data flow**: It receives the local-or-remote choice, starts a command that prints two lines, and first drains it through the read API. After the process is closed, it subscribes to events and expects the same stdout, no stderr, exit code 0, and closure.

**Call relations**: The public test `exec_process_replays_events_after_close` calls this helper. It combines `collect_process_output_from_reads` and `collect_process_output_from_events` to compare the read history with the replayed event history.

*Call graph*: calls 4 internal fn (collect_process_output_from_events, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_replays_events_after_close); 5 external calls (clone, default, assert_eq!, current_dir, vec!).


##### `assert_exec_process_retains_output_after_exit_until_streams_close`  (lines 326–399)

```
async fn assert_exec_process_retains_output_after_exit_until_streams_close(
    use_remote: bool,
) -> Result<()>
```

**Purpose**: Checks a subtle case where a parent process exits before a child process writes delayed output. The system must not mark the session fully closed until remaining output streams are drained.

**Data flow**: It receives the local-or-remote choice, starts a helper binary that exits its parent first and waits for a release file before writing late output. The function observes the exit code before closure, creates the release file, reads the late output, then drains the session and verifies the late text was preserved.

**Call relations**: The public test `exec_process_retains_output_after_exit_until_streams_close` calls this helper. It uses the shared test helper binary paths, temporary files, direct reads, and finally `collect_process_output_from_reads` to confirm the full lifecycle.

*Call graph*: calls 4 internal fn (current_test_binary_helper_paths, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_retains_output_after_exit_until_streams_close); 11 external calls (default, from_secs, from_utf8_lossy, new, new, assert!, assert_eq!, current_dir, write, timeout (+1 more)).


##### `assert_exec_process_write_then_read`  (lines 401–439)

```
async fn assert_exec_process_write_then_read(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that writing to a process connected through a terminal-style interface works. The process reads one line from input and prints it back with a prefix.

**Data flow**: It receives the local-or-remote choice, starts a shell command with `tty` enabled, waits briefly for it to be ready, writes `hello\n`, and reads all output. It expects the echoed text to contain `from-stdin:hello`, exit code 0, and closure.

**Call relations**: The public test `exec_process_write_then_read` calls this helper. It uses `create_process_context` to start the backend and `collect_process_output_from_reads` to verify the written input became process output.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_write_then_read); 7 external calls (default, from_millis, assert!, assert_eq!, current_dir, sleep, vec!).


##### `assert_exec_process_write_then_read_without_tty`  (lines 441–472)

```
async fn assert_exec_process_write_then_read_without_tty(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that stdin writing also works without a terminal when an explicit stdin pipe is requested. A stdin pipe is a direct input channel to the child process.

**Data flow**: It receives the local-or-remote choice, starts a shell command with `pipe_stdin` enabled and `tty` disabled, writes `hello\n`, verifies the write was accepted, then reads the output and final status.

**Call relations**: The public test `exec_process_write_then_read_without_tty` calls this helper. It demonstrates the non-terminal input path and uses `collect_process_output_from_reads` for the final check.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_write_then_read_without_tty); 6 external calls (default, from_millis, assert_eq!, current_dir, sleep, vec!).


##### `assert_exec_process_rejects_write_without_pipe_stdin`  (lines 474–506)

```
async fn assert_exec_process_rejects_write_without_pipe_stdin(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that the system refuses input when the process was not started with stdin open. This prevents callers from thinking bytes were delivered when there is nowhere to send them.

**Data flow**: It receives the local-or-remote choice, starts a shell command with no terminal and no stdin pipe, then tries to write `ignored\n`. It expects a `StdinClosed` status, then reads the process output and confirms the command saw end-of-file and exited normally.

**Call relations**: The public test `exec_process_rejects_write_without_pipe_stdin` calls this helper. It uses the normal read collector after the rejected write to prove the child process behaved as if stdin was closed.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_rejects_write_without_pipe_stdin); 5 external calls (default, assert!, assert_eq!, current_dir, vec!).


##### `assert_exec_process_signal_interrupts_process`  (lines 508–560)

```
async fn assert_exec_process_signal_interrupts_process(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that sending an interrupt signal can stop a running Unix process and that the process can report its own signal handling output. An interrupt signal is like pressing Ctrl-C.

**Data flow**: It receives the local-or-remote choice, starts a shell loop that prints `ready`, installs an interrupt handler, and then spins forever. The function reads until it sees `ready`, sends an interrupt, drains the remaining output, and expects the signal-handler text plus exit code 7.

**Call relations**: The public test `exec_process_signal_interrupts_process` calls this helper. It uses `read_process_until_change` for the readiness phase and `collect_process_output_from_reads` after sending the signal.

*Call graph*: calls 4 internal fn (collect_process_output_from_reads, create_process_context, read_process_until_change, from_path); called by 1 (exec_process_signal_interrupts_process); 9 external calls (clone, default, from_utf8_lossy, new, bail!, assert!, assert_eq!, current_dir, vec!).


##### `assert_exec_process_signal_reports_unsupported_on_windows`  (lines 562–598)

```
async fn assert_exec_process_signal_reports_unsupported_on_windows(use_remote: bool) -> Result<()>
```

**Purpose**: Checks the Windows-specific behavior for interrupting a non-terminal process. On that platform and backend, this kind of interrupt is expected to be unsupported and should produce a clear error.

**Data flow**: It receives the local-or-remote choice, starts a long-running Windows command, attempts to send an interrupt signal, and expects an error message explaining that process interrupt is not supported. It then terminates the process to clean up.

**Call relations**: The public Windows-only test `exec_process_signal_reports_unsupported_on_windows` calls this helper. It uses `create_process_context` for setup but checks the signal call directly instead of going through output collectors.

*Call graph*: calls 3 internal fn (from, create_process_context, from_path); called by 1 (exec_process_signal_reports_unsupported_on_windows); 5 external calls (default, bail!, assert!, current_dir, vec!).


##### `assert_exec_process_preserves_queued_events_before_subscribe`  (lines 600–631)

```
async fn assert_exec_process_preserves_queued_events_before_subscribe(
    use_remote: bool,
) -> Result<()>
```

**Purpose**: Checks that output produced before a reader subscribes is not lost. This protects slow or late clients from missing early process output.

**Data flow**: It receives the local-or-remote choice, starts a shell command that immediately prints a line, deliberately waits, then subscribes to wake notifications and reads the process. It expects the earlier output, exit code 0, and closure.

**Call relations**: The public test `exec_process_preserves_queued_events_before_subscribe` calls this helper. It relies on `collect_process_output_from_reads` to prove that queued output is still available after the delay.

*Call graph*: calls 4 internal fn (from, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_preserves_queued_events_before_subscribe); 7 external calls (default, from_millis, assert!, assert_eq!, current_dir, sleep, vec!).


##### `remote_exec_process_reports_transport_disconnect`  (lines 637–722)

```
async fn remote_exec_process_reports_transport_disconnect() -> Result<()>
```

**Purpose**: Checks that a remote process session reports a server connection loss clearly and consistently. Without this, callers might wait forever or receive confusing partial results after the exec-server disappears.

**Data flow**: It creates a remote-only context, starts a long-running process, subscribes to events, and also starts a pending read. Then it shuts down the server. It expects a failure event, a failed pending read, a failed later read that also marks the session closed, and a failed write after disconnect.

**Call relations**: This is a standalone test rather than a wrapper around an assertion helper. It still uses `create_process_context` for setup and `read_process_until_change` to check the post-disconnect read path.

*Call graph*: calls 4 internal fn (from, create_process_context, read_process_until_change, from_path); 9 external calls (clone, default, from_secs, bail!, assert!, current_dir, spawn, timeout, vec!).


##### `exec_process_starts_and_exits`  (lines 730–732)

```
async fn exec_process_starts_and_exits(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the start-and-exit check as an actual async test for both local and remote modes. It is the test framework entry point for that scenario.

**Data flow**: The test framework supplies the `use_remote` case. The function passes that value into `assert_exec_process_starts_and_exits` and returns its success or failure.

**Call relations**: This wrapper connects the reusable assertion helper to the test runner. The helper does the real setup, process launch, and verification.

*Call graph*: calls 1 internal fn (assert_exec_process_starts_and_exits).


##### `exec_process_streams_output`  (lines 740–742)

```
async fn exec_process_streams_output(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the stdout streaming check as an actual async test for both local and remote modes. It confirms callers can read normal process output.

**Data flow**: The test framework supplies the local-or-remote parameter. The function forwards it to `assert_exec_process_streams_output` and returns the result.

**Call relations**: This wrapper exists so the same helper can be exercised by the test runner in two modes. The helper contains the process behavior check.

*Call graph*: calls 1 internal fn (assert_exec_process_streams_output).


##### `exec_process_pushes_events`  (lines 750–752)

```
async fn exec_process_pushes_events(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the pushed-event ordering check as an actual async test for both local and remote modes. It focuses on the subscription API rather than polling reads.

**Data flow**: It receives `use_remote` from the parameterized test setup and calls `assert_exec_process_pushes_events`. The result from that helper becomes the test result.

**Call relations**: This is the test-runner-facing shell around the event assertion helper. The helper starts the command and compares the event sequence.

*Call graph*: calls 1 internal fn (assert_exec_process_pushes_events).


##### `exec_process_replays_events_after_close`  (lines 760–762)

```
async fn exec_process_replays_events_after_close(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the late-subscriber replay check as an actual async test for both local and remote modes. It verifies that finished process history remains available.

**Data flow**: It receives the local-or-remote test case value and passes it to `assert_exec_process_replays_events_after_close`. Any mismatch or error is returned to the test runner.

**Call relations**: This wrapper lets the reusable replay assertion run under the test framework. The assertion helper performs both read-based collection and event-based replay collection.

*Call graph*: calls 1 internal fn (assert_exec_process_replays_events_after_close).


##### `exec_process_retains_output_after_exit_until_streams_close`  (lines 770–774)

```
async fn exec_process_retains_output_after_exit_until_streams_close(
    use_remote: bool,
) -> Result<()>
```

**Purpose**: Runs the late-output-after-exit check as an actual async test for both local and remote modes. It protects a tricky lifecycle edge case.

**Data flow**: It receives `use_remote`, calls `assert_exec_process_retains_output_after_exit_until_streams_close`, and returns that helper's result.

**Call relations**: This is the test entry point for the delayed-output scenario. The helper uses a test binary and temporary release file to create the edge case.

*Call graph*: calls 1 internal fn (assert_exec_process_retains_output_after_exit_until_streams_close).


##### `exec_process_write_then_read`  (lines 782–784)

```
async fn exec_process_write_then_read(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the terminal-style stdin write check as an actual async test for both local and remote modes. It verifies that input sent to a process can affect its output.

**Data flow**: The parameterized test framework supplies `use_remote`. The function forwards it to `assert_exec_process_write_then_read` and returns the result.

**Call relations**: This wrapper links the stdin-through-tty scenario to the test runner. The assertion helper starts the process, writes input, and reads the response.

*Call graph*: calls 1 internal fn (assert_exec_process_write_then_read).


##### `exec_process_write_then_read_without_tty`  (lines 792–794)

```
async fn exec_process_write_then_read_without_tty(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the piped-stdin write check as an actual async test for both local and remote modes. It verifies input works even when no terminal is used.

**Data flow**: It receives the local-or-remote choice from the test framework, calls `assert_exec_process_write_then_read_without_tty`, and returns the outcome.

**Call relations**: This wrapper exposes the non-terminal stdin scenario to the test runner. The helper performs the actual write and read verification.

*Call graph*: calls 1 internal fn (assert_exec_process_write_then_read_without_tty).


##### `exec_process_rejects_write_without_pipe_stdin`  (lines 802–804)

```
async fn exec_process_rejects_write_without_pipe_stdin(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the rejected-stdin-write check as an actual async test for both local and remote modes. It confirms callers get a clear status when stdin is closed.

**Data flow**: It receives `use_remote`, passes it to `assert_exec_process_rejects_write_without_pipe_stdin`, and returns success or failure.

**Call relations**: This wrapper connects the closed-stdin assertion helper to the test runner. The helper checks both the write status and the child process output.

*Call graph*: calls 1 internal fn (assert_exec_process_rejects_write_without_pipe_stdin).


##### `exec_process_signal_interrupts_process`  (lines 812–814)

```
async fn exec_process_signal_interrupts_process(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the Unix interrupt-signal check as an actual async test for both local and remote modes. It verifies that a running process can be interrupted.

**Data flow**: It receives the local-or-remote value and calls `assert_exec_process_signal_interrupts_process`. The helper's result becomes the test result.

**Call relations**: This wrapper is enabled for Unix-like systems. The assertion helper waits for process readiness, sends the interrupt, and checks the resulting output and exit code.

*Call graph*: calls 1 internal fn (assert_exec_process_signal_interrupts_process).


##### `exec_process_signal_reports_unsupported_on_windows`  (lines 822–824)

```
async fn exec_process_signal_reports_unsupported_on_windows(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the Windows unsupported-signal check as an actual async test for both local and remote modes. It verifies the backend gives a clear error instead of pretending the signal worked.

**Data flow**: It receives `use_remote`, calls `assert_exec_process_signal_reports_unsupported_on_windows`, and returns the result.

**Call relations**: This wrapper is enabled for Windows. The assertion helper starts the process, tries the unsupported interrupt, checks the message, and cleans up.

*Call graph*: calls 1 internal fn (assert_exec_process_signal_reports_unsupported_on_windows).


##### `exec_process_preserves_queued_events_before_subscribe`  (lines 832–834)

```
async fn exec_process_preserves_queued_events_before_subscribe(use_remote: bool) -> Result<()>
```

**Purpose**: Runs the queued-output preservation check as an actual async test for both local and remote modes. It verifies early output remains readable even if the client subscribes late.

**Data flow**: It receives the local-or-remote parameter and forwards it to `assert_exec_process_preserves_queued_events_before_subscribe`. The helper's result is returned to the test runner.

**Call relations**: This wrapper exposes the late-subscription scenario to the test runner. The assertion helper creates the delay, then proves the queued output is still available.

*Call graph*: calls 1 internal fn (assert_exec_process_preserves_queued_events_before_subscribe).


### `utils/pty/src/tests.rs`

`test` · `test run`

This test file proves that the terminal/process layer behaves like a real, reliable connection to another program. The project can start a child process either through ordinary pipes or through a PTY, which is a pseudo-terminal: a software version of a terminal window. Without these tests, small mistakes could make interactive shells hang, lose final output, mix up standard output and standard error, fail to kill background processes, or break Unix-only features such as inherited file descriptors.

The file uses small real programs, mostly the system shell and Python when available, to exercise the same paths a user would rely on. Helper functions build portable commands for Windows and Unix, collect output until a process exits, wait for recognizable text, and check whether Unix processes still exist. The tests then cover common and tricky cases: Python REPL interaction through a PTY, stdin round-trips through pipes, separate stdout and stderr streams, late output arriving after an exit signal, terminal resizing, process-session detachment, termination of child groups, and preservation of chosen file descriptors.

In effect, this file is like a set of test pilots for the process driver. It does not implement the terminal itself; it repeatedly launches controlled child processes and confirms that the surrounding machinery behaves predictably.

#### Function details

##### `find_python`  (lines 19–30)

```
fn find_python() -> Option<String>
```

**Purpose**: Looks for a usable Python command on the current machine. Tests use this so they can skip Python-based checks cleanly instead of failing on systems without Python.

**Data flow**: It tries the command names `python3` and `python`, asks each for its version, and checks whether the command succeeds. If one works, it returns that command name; if none work, it returns nothing.

**Call relations**: Several tests call this before launching Python. If it returns nothing, those tests print a skip message and stop early; if it returns a command name, they pass it into the process-spawning functions.

*Call graph*: called by 4 (pipe_drains_stderr_without_stdout_activity, pipe_process_round_trips_stdin, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits); 1 external calls (new).


##### `setsid_available`  (lines 32–41)

```
fn setsid_available() -> bool
```

**Purpose**: Checks whether the Unix `setsid` tool is available. `setsid` starts a process in a new session, which is useful for testing detached child behavior.

**Data flow**: It first rules out Windows, where this tool is not expected. On other systems it runs `setsid true`; a successful exit means the feature is available, while errors or failed exits mean it is not.

**Call relations**: The detached-reader termination test calls this before doing Unix-style session work. If `setsid` is missing, the test skips itself rather than producing a misleading failure.

*Call graph*: called by 1 (pipe_terminate_aborts_detached_readers); 2 external calls (cfg!, new).


##### `shell_command`  (lines 43–53)

```
fn shell_command(program: &str) -> (String, Vec<String>)
```

**Purpose**: Wraps a short shell script in the right command for the operating system. This lets the same test idea run through `cmd.exe` on Windows or `/bin/sh` on Unix.

**Data flow**: It receives a script string. On Windows it returns the command interpreter plus `/C` arguments; on Unix it returns `/bin/sh` plus `-c`. The result is a program name and argument list ready to spawn.

**Call relations**: Many tests use this when they need a tiny shell program. It keeps those tests focused on process behavior instead of repeating platform-specific shell setup.

*Call graph*: called by 5 (pipe_and_pty_share_interface, pipe_process_can_expose_split_stdout_and_stderr, pipe_process_detaches_from_parent_session, pipe_terminate_aborts_detached_readers, pty_terminate_kills_background_children_in_same_process_group); 3 external calls (cfg!, var, vec!).


##### `echo_sleep_command`  (lines 55–61)

```
fn echo_sleep_command(marker: &str) -> String
```

**Purpose**: Builds a tiny command that prints a marker and waits briefly. Tests use this to confirm that spawned pipe and PTY processes both produce expected output before exiting.

**Data flow**: It receives marker text and formats a platform-specific shell snippet. The output is a command string that echoes the marker and then pauses for a short time.

**Call relations**: The shared-interface test passes this command through `shell_command`, then runs it once through a pipe process and once through a PTY process.

*Call graph*: called by 1 (pipe_and_pty_share_interface); 2 external calls (cfg!, format!).


##### `split_stdout_stderr_command`  (lines 63–71)

```
fn split_stdout_stderr_command() -> String
```

**Purpose**: Creates a command that writes one known line to standard output and another known line to standard error. This gives tests a simple way to verify that the two streams stay separate.

**Data flow**: It chooses Windows command syntax or Unix shell syntax. The returned script prints `split-out` to stdout and `split-err` to stderr.

**Call relations**: The split-stream pipe test wraps this script with `shell_command`, spawns it without stdin, and then compares the two collected streams to exact expected bytes.

*Call graph*: called by 1 (pipe_process_can_expose_split_stdout_and_stderr); 1 external calls (cfg!).


##### `collect_split_output`  (lines 73–79)

```
async fn collect_split_output(mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>) -> Vec<u8>
```

**Purpose**: Reads every chunk from one output stream until that stream closes. It is used when a test wants the complete stdout or stderr stream by itself.

**Data flow**: It receives an async channel carrying byte chunks. It waits for chunks one by one, appends them to a growing byte buffer, and returns the full collected buffer when the sender is gone.

**Call relations**: Split-output tests run this in background tasks for stdout and stderr. Those tests then wait for the child to exit and compare the buffers this helper returns.

*Call graph*: calls 1 internal fn (recv); called by 3 (driver_backed_process_can_expose_split_stdout_and_stderr, driver_backed_process_drains_output_that_arrives_after_exit_signal, pipe_process_can_expose_split_stdout_and_stderr); 1 external calls (new).


##### `combine_spawned_output`  (lines 81–99)

```
fn combine_spawned_output(
    spawned: SpawnedProcess,
) -> (
    crate::ProcessHandle,
    tokio::sync::broadcast::Receiver<Vec<u8>>,
    tokio::sync::oneshot::Receiver<i32>,
)
```

**Purpose**: Turns a spawned process with separate stdout and stderr receivers into a simpler shape with one combined output receiver. This is useful for tests that only care whether text appeared somewhere.

**Data flow**: It receives a `SpawnedProcess`, takes out its session handle, stdout receiver, stderr receiver, and exit receiver, combines stdout and stderr into one broadcast stream, and returns the session, combined output, and exit signal.

**Call relations**: Most tests call this immediately after spawning a process. It hands them the session for writing or terminating, a unified output stream for assertions, and the exit receiver for completion checks.

*Call graph*: called by 11 (pipe_and_pty_share_interface, pipe_drains_stderr_without_stdout_activity, pipe_process_detaches_from_parent_session, pipe_process_round_trips_stdin, pipe_spawn_no_stdin_can_preserve_inherited_fds, pipe_terminate_aborts_detached_readers, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_supports_resize (+1 more)); 1 external calls (combine_output_receivers).


##### `collect_output_until_exit`  (lines 101–141)

```
async fn collect_output_until_exit(
    mut output_rx: tokio::sync::broadcast::Receiver<Vec<u8>>,
    exit_rx: tokio::sync::oneshot::Receiver<i32>,
    timeout_ms: u64,
) -> (Vec<u8>, i32)
```

**Purpose**: Collects process output while waiting for the process to finish. It also waits briefly after the exit signal so late-arriving terminal bytes are not accidentally missed.

**Data flow**: It receives a broadcast output stream, an exit-code receiver, and a timeout. It gathers bytes until either the process exits or the timeout expires; after exit, it drains any final output for a short quiet window. It returns the bytes collected and the exit code, or `-1` on timeout or missing code.

**Call relations**: Many tests use this as their final collection step after sending input or starting a short-lived command. It bridges process execution and assertions by returning both visible output and completion status.

*Call graph*: called by 8 (pipe_and_pty_share_interface, pipe_drains_stderr_without_stdout_activity, pipe_process_round_trips_stdin, pipe_spawn_no_stdin_can_preserve_inherited_fds, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_supports_resize); 5 external calls (new, pin!, select!, from_millis, now).


##### `wait_for_output_contains`  (lines 144–177)

```
async fn wait_for_output_contains(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    needle: &str,
    timeout_ms: u64,
) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Waits until PTY output contains a particular piece of text. This helps tests synchronize with an interactive process instead of guessing with sleeps.

**Data flow**: It reads output chunks until a deadline. Each chunk is added to a buffer, converted loosely to text, and checked for the requested substring. It returns the bytes seen so far on success or an error explaining what was collected on timeout or closure.

**Call relations**: The PTY resize-with-inherited-file-descriptors test uses this to wait for the child shell to report its initial terminal size before sending a resize.

*Call graph*: calls 1 internal fn (recv); called by 1 (pty_spawn_with_inherited_fds_supports_resize); 6 external calls (from_utf8_lossy, new, bail!, from_millis, now, timeout).


##### `wait_for_python_repl_ready`  (lines 179–212)

```
async fn wait_for_python_repl_ready(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    timeout_ms: u64,
    ready_marker: &str,
) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Waits for a Python interactive session to print a known readiness marker. This avoids sending commands before Python is actually ready to receive them.

**Data flow**: It receives a PTY output stream, a timeout, and marker text. It keeps collecting bytes until the marker appears, then returns the collected bytes; if output closes or time runs out, it returns a detailed error.

**Call relations**: The basic PTY Python REPL test calls this after spawning Python. Once it succeeds, the test sends Python commands through the session writer.

*Call graph*: calls 1 internal fn (recv); called by 1 (pty_python_repl_emits_output_and_exits); 6 external calls (from_utf8_lossy, new, bail!, from_millis, now, timeout).


##### `wait_for_python_repl_ready_via_probe`  (lines 215–264)

```
async fn wait_for_python_repl_ready_via_probe(
    writer: &tokio::sync::mpsc::Sender<Vec<u8>>,
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    timeout_ms: u64,
    newline: &str,
)
```

**Purpose**: Checks that a Python REPL is ready by repeatedly sending a harmless `print` command and waiting to see its marker output. This is useful when startup banners or prompts are not reliable enough.

**Data flow**: It receives a writer, an output stream, a timeout, and the newline style. During the timeout it sends a probe command, watches output for a unique marker, and returns collected bytes when the marker appears. If the marker never appears, it reports what was seen.

**Call relations**: The Unix inherited-file-descriptor Python REPL test uses this before asking Python for its process id. It coordinates writing to the REPL with reading from the PTY.

*Call graph*: calls 1 internal fn (recv); called by 1 (pty_preserving_inherited_fds_keeps_python_repl_running); 10 external calls (send, from_utf8_lossy, new, bail!, cfg!, format!, min, from_millis, now, timeout).


##### `process_exists`  (lines 267–279)

```
fn process_exists(pid: i32) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a Unix process id still refers to a live process. It is a small wrapper around the operating system’s process check.

**Data flow**: It receives a process id and calls `kill(pid, 0)`, which asks the OS about the process without sending a real signal. It returns true if the process exists or permission is denied, false if the OS says there is no such process, and an error for unexpected failures.

**Call relations**: The process-exit waiting helper calls this repeatedly. Tests use that helper to confirm that termination actually kills background children.

*Call graph*: called by 1 (wait_for_process_exit); 2 external calls (last_os_error, kill).


##### `wait_for_marker_pid`  (lines 282–327)

```
async fn wait_for_marker_pid(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    marker: &str,
    timeout_ms: u64,
) -> anyhow::Result<i32>
```

**Purpose**: Reads process output until it finds a marker followed by a numeric process id. Tests use this when a child script prints the id of a process they later need to inspect.

**Data flow**: It receives an output stream, marker text, and a timeout. It collects output, searches for the marker, parses the digits after it as a process id, and returns that id. If the marker or full number never appears, it returns an error with the collected output.

**Call relations**: Tests for PTY termination and preserved-file-descriptor Python sessions call this after the child prints a tagged process id. The returned id is then passed to process-existence checks.

*Call graph*: calls 1 internal fn (recv); called by 2 (pty_preserving_inherited_fds_keeps_python_repl_running, pty_terminate_kills_background_children_in_same_process_group); 6 external calls (from_utf8_lossy, new, bail!, from_millis, now, timeout).


##### `wait_for_process_exit`  (lines 330–341)

```
async fn wait_for_process_exit(pid: i32, timeout_ms: u64) -> anyhow::Result<bool>
```

**Purpose**: Polls a Unix process id until it disappears or a timeout is reached. This turns a process-kill expectation into a clear true-or-false result.

**Data flow**: It receives a process id and timeout. It repeatedly asks `process_exists`, sleeps briefly between checks, and returns true once the process is gone or false if the deadline passes.

**Call relations**: The PTY termination test uses this after calling `terminate`. If it reports that the child is still alive, the test cleans up with a stronger kill signal and then fails.

*Call graph*: calls 1 internal fn (process_exists); called by 1 (pty_terminate_kills_background_children_in_same_process_group); 3 external calls (from_millis, now, sleep).


##### `pty_python_repl_emits_output_and_exits`  (lines 344–390)

```
async fn pty_python_repl_emits_output_and_exits() -> anyhow::Result<()>
```

**Purpose**: Tests that a Python interactive session can run through a PTY, accept input, produce output, and exit cleanly. This covers the core interactive-terminal use case.

**Data flow**: It finds Python, starts it in interactive quiet mode with a readiness print, combines its output, waits for readiness, sends a `print` command and `exit()`, then collects final output and exit code. The test passes only if the expected text appears and the exit code is zero.

**Call relations**: This test relies on the Python finder, the PTY spawner, the output combiner, the REPL readiness waiter, and the final output collector. Together they simulate a user typing into a terminal.

*Call graph*: calls 5 internal fn (default, collect_output_until_exit, combine_spawned_output, find_python, wait_for_python_repl_ready); 10 external calls (new, from_utf8_lossy, assert!, assert_eq!, cfg!, spawn_pty_process, eprintln!, format!, vars, vec!).


##### `pipe_process_round_trips_stdin`  (lines 393–441)

```
async fn pipe_process_round_trips_stdin() -> anyhow::Result<()>
```

**Purpose**: Tests that a pipe-backed process can receive text through stdin and echo it back. This verifies the ordinary non-terminal input path.

**Data flow**: It chooses a small echoing command, spawns it with pipes, sends `roundtrip` plus the platform newline, closes stdin, and gathers output and exit code. It expects the echoed word and a clean exit.

**Call relations**: The test uses `find_python` on Unix-like paths where Python is the echo program, then uses the shared combine-and-collect helpers to observe the spawned process.

*Call graph*: calls 3 internal fn (collect_output_until_exit, combine_spawned_output, find_python); 11 external calls (new, from_utf8_lossy, assert!, assert_eq!, cfg!, spawn_pipe_process, eprintln!, format!, var, vars (+1 more)).


##### `pipe_process_detaches_from_parent_session`  (lines 445–484)

```
async fn pipe_process_detaches_from_parent_session() -> anyhow::Result<()>
```

**Purpose**: Checks that a Unix pipe-spawned process starts in a separate session from the test runner. A separate session matters because process control and termination should not accidentally affect the parent.

**Data flow**: It records the parent session id, starts a shell that prints its own process id, reads that id from output, asks the OS for the child session id, and compares them. The child should be its own session leader and not share the parent session.

**Call relations**: This test uses `shell_command` to build the child script and `combine_spawned_output` to read the printed pid. It then waits for the child exit signal to confirm normal completion.

*Call graph*: calls 2 internal fn (combine_spawned_output, shell_command); 10 external calls (new, from_utf8_lossy, bail!, assert_eq!, assert_ne!, spawn_pipe_process, getsid, vars, from_millis, timeout).


##### `pipe_and_pty_share_interface`  (lines 487–525)

```
async fn pipe_and_pty_share_interface() -> anyhow::Result<()>
```

**Purpose**: Confirms that pipe-spawned and PTY-spawned processes can be used through the same high-level interface. This matters because callers should not need two totally different workflows.

**Data flow**: It builds two short commands, one printing `pipe_ok` and one printing `pty_ok`, starts one through pipes and one through a PTY, then collects output and exit codes from both. Both must exit with zero and include their markers.

**Call relations**: This test ties together `echo_sleep_command`, `shell_command`, both spawn paths, the output combiner, and the exit collector to compare the two process styles side by side.

*Call graph*: calls 5 internal fn (default, collect_output_until_exit, combine_spawned_output, echo_sleep_command, shell_command); 7 external calls (new, assert!, assert_eq!, cfg!, spawn_pipe_process, spawn_pty_process, vars).


##### `pipe_drains_stderr_without_stdout_activity`  (lines 528–546)

```
async fn pipe_drains_stderr_without_stdout_activity() -> anyhow::Result<()>
```

**Purpose**: Tests that a process writing heavily to standard error does not hang just because standard output is quiet. This guards against deadlocks caused by an unread stderr pipe filling up.

**Data flow**: It finds Python, runs a script that writes many large chunks to stderr, combines the output streams, and waits for exit. The test expects a zero exit code and some collected output.

**Call relations**: This test depends on `find_python`, pipe spawning, and `collect_output_until_exit`. It specifically stresses the reader side of the pipe implementation.

*Call graph*: calls 3 internal fn (collect_output_until_exit, combine_spawned_output, find_python); 7 external calls (new, assert!, assert_eq!, spawn_pipe_process, eprintln!, vars, vec!).


##### `pipe_process_can_expose_split_stdout_and_stderr`  (lines 549–592)

```
async fn pipe_process_can_expose_split_stdout_and_stderr() -> anyhow::Result<()>
```

**Purpose**: Verifies that pipe-spawned processes can expose stdout and stderr as separate streams. This is needed when callers must distinguish normal output from error output.

**Data flow**: It starts a no-stdin command that writes known bytes to both streams, launches separate collectors for stdout and stderr, waits for exit, and compares each stream to exact platform-specific expected bytes.

**Call relations**: This test uses `split_stdout_stderr_command` and `shell_command` to create predictable output, then uses `collect_split_output` tasks to drain the two receivers independently.

*Call graph*: calls 3 internal fn (collect_split_output, shell_command, split_stdout_stderr_command); 8 external calls (new, assert_eq!, cfg!, spawn_pipe_process_no_stdin, vars, spawn, from_millis, timeout).


##### `driver_backed_process_can_expose_split_stdout_and_stderr`  (lines 595–643)

```
async fn driver_backed_process_can_expose_split_stdout_and_stderr() -> anyhow::Result<()>
```

**Purpose**: Tests the generic driver-based process wrapper with separate stdout and stderr streams. This proves the wrapper preserves stream separation even when the process is supplied by a custom driver rather than the OS spawner.

**Data flow**: It creates manual channels for input, stdout, stderr, and exit. After wrapping them with `spawn_from_driver`, it sends one stdout chunk, one stderr chunk, closes the senders, sends exit code zero, and checks that the exposed receivers contain the right bytes.

**Call relations**: This test exercises `spawn_from_driver` directly and uses `collect_split_output` to observe what the wrapper exposes to callers.

*Call graph*: calls 1 internal fn (collect_split_output); 5 external calls (assert_eq!, spawn_from_driver, spawn, from_secs, timeout).


##### `driver_backed_process_can_resize_via_resizer_hook`  (lines 646–689)

```
async fn driver_backed_process_can_resize_via_resizer_hook() -> anyhow::Result<()>
```

**Purpose**: Checks that a driver-backed session forwards terminal resize requests to its resizer callback. This matters for custom process backends that need to react when the terminal size changes.

**Data flow**: It builds a driver with a resizer function that sends the requested size through a one-shot channel. The test calls `resize` on the session, waits for the size to arrive, and compares it to the requested rows and columns.

**Call relations**: This test goes straight through `spawn_from_driver`. It confirms that the public session resize method reaches the driver hook.

*Call graph*: 7 external calls (new, assert_eq!, spawn_from_driver, new, new, from_secs, timeout).


##### `driver_backed_process_drains_output_that_arrives_after_exit_signal`  (lines 692–734)

```
async fn driver_backed_process_drains_output_that_arrives_after_exit_signal() -> anyhow::Result<()>
```

**Purpose**: Verifies that output arriving shortly after an exit signal is still delivered. This protects against losing the final tail of a process’s output.

**Data flow**: It creates a driver-backed process, sends exit code zero first, waits briefly, then sends a final stdout chunk and closes the sender. The test waits for the exposed exit and output, expecting to receive both the exit code and the late `tail` bytes.

**Call relations**: This test uses `spawn_from_driver` and `collect_split_output` to check an ordering edge case that can happen with real asynchronous readers.

*Call graph*: calls 1 internal fn (collect_split_output); 7 external calls (assert_eq!, spawn_from_driver, spawn, from_millis, from_secs, sleep, timeout).


##### `pipe_terminate_aborts_detached_readers`  (lines 737–771)

```
async fn pipe_terminate_aborts_detached_readers() -> anyhow::Result<()>
```

**Purpose**: Tests that terminating a pipe-backed session stops reader tasks even when a detached subprocess keeps producing output. This prevents leaked background readers after the main session is terminated.

**Data flow**: It first checks for `setsid`. Then it starts a shell script that launches a detached loop printing `tick`, waits to see initial output, calls `terminate`, and watches for more output. The test passes only if no further chunks arrive or the stream closes.

**Call relations**: This test uses `setsid_available`, `shell_command`, pipe spawning, and the combined output receiver. It focuses on cleanup behavior after session termination.

*Call graph*: calls 3 internal fn (combine_spawned_output, setsid_available, shell_command); 7 external calls (new, bail!, spawn_pipe_process, eprintln!, vars, from_millis, timeout).


##### `pty_terminate_kills_background_children_in_same_process_group`  (lines 775–816)

```
async fn pty_terminate_kills_background_children_in_same_process_group() -> anyhow::Result<()>
```

**Purpose**: Checks that terminating a PTY session kills a background child in the same process group. This is important for avoiding orphaned long-running commands after a terminal session is closed.

**Data flow**: It starts a shell in a PTY that launches `sleep 1000` in the background, prints that child’s pid with a marker, and waits. The test reads the pid, confirms it exists, terminates the session, then waits for the child process to disappear.

**Call relations**: This test uses `shell_command`, PTY spawning, `wait_for_marker_pid`, `process_exists`, and `wait_for_process_exit` to prove that termination reaches the process group, not just the shell.

*Call graph*: calls 5 internal fn (default, combine_spawned_output, shell_command, wait_for_marker_pid, wait_for_process_exit); 6 external calls (new, assert!, spawn_pty_process, format!, kill, vars).


##### `pty_spawn_can_preserve_inherited_fds`  (lines 820–863)

```
async fn pty_spawn_can_preserve_inherited_fds() -> anyhow::Result<()>
```

**Purpose**: Tests that a Unix PTY-spawned process can inherit a selected file descriptor. A file descriptor is a small OS number that points to an open file, pipe, or socket.

**Data flow**: It creates an OS pipe, passes the write end as a preserved descriptor to a shell running under a PTY, and has the shell write a marker into that descriptor. After the child exits, the test reads the pipe’s read end and checks for the marker.

**Call relations**: This test calls the Unix inherited-file-descriptor PTY spawner, then uses the usual output combiner and exit collector to confirm the child finished before checking the side pipe.

*Call graph*: calls 4 internal fn (default, spawn_process_with_inherited_fds, collect_output_until_exit, combine_spawned_output); 7 external calls (new, new, assert_eq!, last_os_error, pipe, vars, from_raw_fd).


##### `pty_preserving_inherited_fds_keeps_python_repl_running`  (lines 867–941)

```
async fn pty_preserving_inherited_fds_keeps_python_repl_running() -> anyhow::Result<()>
```

**Purpose**: Checks that preserving file descriptors does not accidentally break an interactive Python REPL running in a PTY. This guards against subtle spawn setup bugs.

**Data flow**: It finds Python, creates and preserves a pipe file descriptor, starts Python in a PTY, closes local copies, probes until the REPL responds, asks Python to print its pid, confirms that pid is still alive, then sends `exit()` and expects a clean exit.

**Call relations**: This test combines `find_python`, the inherited-fd PTY spawner, `wait_for_python_repl_ready_via_probe`, `wait_for_marker_pid`, and the final output collector. It tests inherited descriptors and interactivity together.

*Call graph*: calls 7 internal fn (default, spawn_process_with_inherited_fds, collect_output_until_exit, combine_spawned_output, find_python, wait_for_marker_pid, wait_for_python_repl_ready_via_probe); 9 external calls (new, assert!, assert_eq!, last_os_error, eprintln!, format!, pipe, vars, from_raw_fd).


##### `pty_spawn_with_inherited_fds_reports_exec_failures`  (lines 945–989)

```
async fn pty_spawn_with_inherited_fds_reports_exec_failures() -> anyhow::Result<()>
```

**Purpose**: Verifies that trying to spawn a missing executable through the inherited-file-descriptor PTY path returns a useful error. This is important so callers are not left with a fake session for a program that never started.

**Data flow**: It creates a pipe, asks the spawner to run a deliberately nonexistent command while preserving one descriptor, then drops the pipe ends. The test expects an error and checks that the message looks like a missing-file or command-not-found error.

**Call relations**: This test calls the inherited-fd PTY spawner directly. If spawning unexpectedly succeeds, it terminates the session and fails the test.

*Call graph*: calls 2 internal fn (default, spawn_process_with_inherited_fds); 7 external calls (new, bail!, assert!, last_os_error, pipe, vars, from_raw_fd).


##### `pty_spawn_with_inherited_fds_supports_resize`  (lines 993–1054)

```
async fn pty_spawn_with_inherited_fds_supports_resize() -> anyhow::Result<()>
```

**Purpose**: Tests that a PTY process spawned with inherited file descriptors still supports terminal resizing. This ensures the special file-descriptor setup does not disable normal PTY controls.

**Data flow**: It starts a shell under a PTY with an initial size, waits until the shell prints that starting size, resizes the session, sends input so the shell continues, and collects final output. The test expects the shell to report the new rows and columns and exit cleanly.

**Call relations**: This test uses `wait_for_output_contains` for synchronization, then calls the session resize method and `collect_output_until_exit` to verify the result.

*Call graph*: calls 4 internal fn (spawn_process_with_inherited_fds, collect_output_until_exit, combine_spawned_output, wait_for_output_contains); 8 external calls (new, from_utf8_lossy, assert!, assert_eq!, last_os_error, pipe, vars, from_raw_fd).


##### `pipe_spawn_no_stdin_can_preserve_inherited_fds`  (lines 1058–1100)

```
async fn pipe_spawn_no_stdin_can_preserve_inherited_fds() -> anyhow::Result<()>
```

**Purpose**: Tests that a Unix pipe-spawned process without stdin can still inherit selected file descriptors. This covers the no-stdin variant of the pipe spawner.

**Data flow**: It creates an OS pipe, tells the child shell about the write-end descriptor through an environment variable, spawns the shell with that descriptor preserved, and has it write a marker into the pipe. After the child exits, the test reads the marker from the read end.

**Call relations**: This test uses the Unix no-stdin inherited-fd pipe spawner, then combines and collects process output only to wait for a clean exit before checking the side-channel pipe data.

*Call graph*: calls 3 internal fn (spawn_process_no_stdin_with_inherited_fds, collect_output_until_exit, combine_spawned_output); 7 external calls (new, new, assert_eq!, last_os_error, pipe, vars, from_raw_fd).


### Filesystem and stream semantics
This group covers shared filesystem test scaffolding, platform-specific path and sandbox behavior, and the file and HTTP streaming APIs layered on top of exec-server transport.

### `exec-server/tests/file_system/support.rs`

`test` · `test setup`

The file-system tests need to run the same checks against different back ends. One back end is a local file-system object. The other talks to an exec server, which is a separate server process used by the project to perform execution and file operations. This support file hides that setup work so each test can focus on the behavior it cares about, like copying files or rejecting unsafe paths.

The central idea is `FileSystemContext`: a small bundle that contains the file-system interface the test will use, plus private fields that keep any helper paths or server process alive for as long as the test needs them. Without those private fields, the remote server or helper binaries could be dropped too early.

The file also defines `FileSystemImplementation`, a tiny choice between `Local` and `Remote`, so tests can run in both modes and print friendly names for each mode.

Finally, it includes helpers for making sandbox contexts. A sandbox is a set of permission rules, like a fenced yard around file access. The helpers turn ordinary absolute paths into the project’s safer absolute-path type, then build permission profiles that allow either read-only access or workspace write access while keeping network access restricted.

#### Function details

##### `FileSystemImplementation::fmt`  (lines 36–41)

```
fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This gives each file-system implementation a simple display name: `local` or `remote`. It is useful when tests print which version they are running against.

**Data flow**: It receives a `FileSystemImplementation` value and a text formatter. It checks whether the value is `Local` or `Remote`, writes the matching word into the formatter, and returns whether that write succeeded.

**Call relations**: This is called automatically by Rust formatting code whenever a test or helper prints a `FileSystemImplementation`. It does not start any file system itself; it only supplies the human-readable label used around the larger test flow.

*Call graph*: 1 external calls (write_str).


##### `create_file_system_context`  (lines 44–71)

```
async fn create_file_system_context(
    implementation: FileSystemImplementation,
) -> Result<FileSystemContext>
```

**Purpose**: This prepares the file-system object that tests will exercise. Depending on the requested implementation, it either builds a local file-system instance or starts/connects to a remote exec server and uses its file-system interface.

**Data flow**: It takes a choice: `Local` or `Remote`. For `Local`, it finds the helper program paths needed by the runtime, builds runtime path settings from them, and creates a local file-system object. For `Remote`, it starts a test exec server, creates a test environment pointing at that server’s WebSocket address, and gets the file-system interface from that environment. It returns a `FileSystemContext` containing the ready-to-use file system and the extra objects needed to keep that setup alive.

**Call relations**: Many file-system tests call this at the start so the same test can run against local and remote implementations. It delegates local setup to helper-path and runtime-path constructors, and remote setup to the test exec-server launcher and test environment builder.

*Call graph*: calls 5 internal fn (create_for_tests, with_runtime_paths, new, exec_server, test_codex_helper_paths); called by 34 (assert_canonicalize_resolves_directory_alias, assert_sandboxed_canonicalize_resolves_directory_alias, file_system_copy_copies_directory_recursively, file_system_copy_copies_file, file_system_copy_rejects_copying_directory_into_descendant, file_system_copy_rejects_directory_without_recursive, file_system_create_directory_creates_nested_directories, file_system_get_metadata_reports_files_and_directories, file_system_read_directory_lists_entries, file_system_read_file_returns_bytes (+15 more)); 1 external calls (new).


##### `absolute_path`  (lines 73–80)

```
fn absolute_path(path: std::path::PathBuf) -> AbsolutePathBuf
```

**Purpose**: This converts a normal path into the project’s `AbsolutePathBuf`, but only after proving the path is absolute. An absolute path starts from the root of the file system, rather than being relative to the current folder.

**Data flow**: It receives a standard path value. It first checks that the path is absolute and stops the test immediately if it is not. Then it converts the path into `AbsolutePathBuf` and returns it. If conversion fails despite the earlier check, the test fails with a clear message.

**Call relations**: Sandbox helpers call this before creating permission rules, because sandbox entries need trustworthy absolute paths. Tests can also call it directly when they need to compare or build permission profiles using the project’s absolute-path type.

*Call graph*: calls 1 internal fn (try_from); called by 3 (sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths, read_only_sandbox, workspace_write_sandbox); 1 external calls (assert!).


##### `read_only_sandbox`  (lines 82–90)

```
fn read_only_sandbox(readable_root: std::path::PathBuf) -> FileSystemSandboxContext
```

**Purpose**: This builds a sandbox context that allows reading from one given root folder but does not grant write access there. Tests use it to check that read operations work while unsafe writes are blocked.

**Data flow**: It receives a path for the readable root. It converts that path into the project’s absolute-path type, wraps it in a sandbox entry marked with read access, and passes that entry into the shared sandbox builder. It returns a complete `FileSystemSandboxContext` ready to use in a test.

**Call relations**: Tests call this when they need a controlled read-only environment, such as checking metadata, reading files, or making sure symbolic-link escape attempts are rejected. It relies on `absolute_path` for path validation and `sandbox_context` to turn the rule into the final permission context.

*Call graph*: calls 2 internal fn (absolute_path, sandbox_context); called by 7 (assert_sandboxed_canonicalize_resolves_directory_alias, file_system_sandboxed_metadata_and_read_allow_readable_root, file_system_sandboxed_write_allows_additional_write_root, file_system_read_directory_rejects_symlink_escape, file_system_sandboxed_read_rejects_symlink_escape, file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape, file_system_sandboxed_write_rejects_unwritable_path); 1 external calls (vec!).


##### `workspace_write_sandbox`  (lines 92–102)

```
fn workspace_write_sandbox(
    writable_root: std::path::PathBuf,
) -> FileSystemSandboxContext
```

**Purpose**: This builds a sandbox context that allows writing inside one given workspace root. Tests use it to check that valid writes are accepted and writes outside the allowed area are rejected.

**Data flow**: It receives a path for the writable root. It verifies and converts that path to an absolute-path value, creates a sandbox entry marked with write access, and sends that entry to the shared sandbox builder. It returns the finished sandbox context.

**Call relations**: Tests call this before file operations that should be allowed to create, copy, or remove items in a workspace. Like `read_only_sandbox`, it uses `absolute_path` for safe path conversion and `sandbox_context` to produce the common permission structure.

*Call graph*: calls 2 internal fn (absolute_path, sandbox_context); called by 11 (sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths, file_system_copy_preserves_symlink_source, file_system_copy_rejects_symlink_escape_destination, file_system_copy_rejects_symlink_escape_source, file_system_create_directory_rejects_symlink_escape, file_system_remove_rejects_symlink_escape, file_system_remove_removes_symlink_not_target, file_system_sandboxed_write_allows_explicit_alias_roots, file_system_sandboxed_write_preserves_existing_hard_link, file_system_sandboxed_write_rejects_symlink_escape (+1 more)); 1 external calls (vec!).


##### `sandbox_context`  (lines 104–109)

```
fn sandbox_context(entries: Vec<FileSystemSandboxEntry>) -> FileSystemSandboxContext
```

**Purpose**: This is the common builder that turns a list of file-system permission entries into a full sandbox context. It also locks down network access, so these file-system tests stay focused on file permissions.

**Data flow**: It receives a list of sandbox entries, where each entry names a path and the kind of access allowed there. It creates a restricted file-system sandbox policy from those entries, combines it with a restricted network policy inside a permission profile, and converts that profile into a `FileSystemSandboxContext`. The returned context is what file-system operations use to decide what is allowed.

**Call relations**: `read_only_sandbox` and `workspace_write_sandbox` both hand their single permission rule to this function. This keeps the policy-building details in one place, so the individual helpers only need to say what kind of file access they want.

*Call graph*: calls 3 internal fn (from_permission_profile, from_runtime_permissions, restricted); called by 2 (read_only_sandbox, workspace_write_sandbox).


### `exec-server/tests/file_system/shared.rs`

`test` · `test suite`

This file acts like a checklist for the project’s file-system layer. The exec server can work with files directly on the machine or through a remote-style implementation, and callers should not have to care which one is underneath. These tests create temporary folders and files, run the same operation through the file-system API, and then inspect the real disk to make sure the result is correct.

The tests cover ordinary actions, such as writing bytes to a file, reading text back, listing a directory, copying files and folders, and removing directories. They also cover edge cases that could easily cause bugs: writing into a missing parent folder, copying a directory without asking for recursive copying, copying a folder into one of its own children, and reading a large file as a stream of bounded chunks.

A major theme is sandboxing. A sandbox is a set of rules that says which paths are readable or writable, like giving someone keys to only certain rooms in a building. These tests make sure readable roots allow reads, extra permissions can add a writable root, and workspace-write sandboxes keep special read-only subpaths such as `.git`. The file also provides helper checks for canonical paths, where aliases such as symlinks or junctions must resolve to the real target path.

#### Function details

##### `sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths`  (lines 28–51)

```
fn sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths() -> Result<()>
```

**Purpose**: This test makes sure that when a workspace-write sandbox is converted into a permission profile and back into policy form, its read-only subpaths are not lost. In particular, it checks that a `.git` directory inside a writable workspace remains protected as read-only.

**Data flow**: It starts with a temporary writable folder containing a `.git` folder. It builds a workspace-write sandbox from that folder, converts the sandbox permissions into a permission profile, asks the resulting file-system policy for writable roots, and then checks that the writable root still lists the canonical `.git` path as read-only. The output is no returned value; the test passes if the assertion holds and fails otherwise.

**Call relations**: The Rust test runner calls this as a standalone unit test. Inside the test, `workspace_write_sandbox` creates the sandbox rules, `absolute_path` normalizes paths for comparison, and standard file-system calls create and canonicalize the temporary directories before the assertion checks the preserved policy.

*Call graph*: calls 2 internal fn (absolute_path, workspace_write_sandbox); 5 external calls (new, assert!, panic!, canonicalize, create_dir_all).


##### `file_system_get_metadata_reports_files_and_directories`  (lines 56–103)

```
async fn file_system_get_metadata_reports_files_and_directories(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test checks that the file-system API reports basic facts correctly for both files and directories. It verifies fields such as whether a path is a file or folder, its size, and that modification times are present.

**Data flow**: It receives a file-system implementation choice, local or remote. It creates a test context, writes one file, creates one directory, asks the API for metadata for each path, and compares the returned `FileMetadata` to the expected values. The test changes only temporary disk contents and succeeds when both metadata responses match reality.

**Call relations**: The parameterized test runner calls this once for each implementation. The test uses `create_file_system_context` to obtain the implementation under test, converts disk paths with `PathUri::from_path`, then calls the API’s `get_metadata` operation and checks the answer with assertions.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 5 external calls (new, assert!, assert_eq!, create_dir, write).


##### `file_system_create_directory_creates_nested_directories`  (lines 108–128)

```
async fn file_system_create_directory_creates_nested_directories(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test confirms that the API can create nested directories when recursive creation is requested. Without this behavior, callers would have to create each parent folder one by one.

**Data flow**: It takes the implementation choice, builds a file-system context, chooses a nested path inside a temporary folder, and calls `create_directory` with `recursive: true`. After the call, it checks the actual disk to confirm that the nested directory exists.

**Call relations**: The test runner invokes this for local and remote modes. It relies on `create_file_system_context` for the file-system object and `PathUri::from_path` to pass the target path into the API in the format the exec server expects.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 2 external calls (new, assert!).


##### `file_system_write_file_writes_bytes`  (lines 133–152)

```
async fn file_system_write_file_writes_bytes(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test checks that writing raw bytes through the file-system API creates a file with exactly those bytes. It protects against implementations that accidentally change, truncate, or fail to write the content.

**Data flow**: It creates a temporary file path, sends the byte sequence `hello from trait` into `write_file`, and then reads the file back directly from disk. The before state is an absent file; the after state is a file containing exactly the requested bytes.

**Call relations**: The parameterized test runner runs this in both implementation modes. The test obtains the file-system API through `create_file_system_context`, converts the path with `PathUri::from_path`, calls `write_file`, and uses a direct disk read as the independent check.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 2 external calls (new, assert_eq!).


##### `path_uri_join_and_parent_preserve_lexical_paths`  (lines 155–175)

```
fn path_uri_join_and_parent_preserve_lexical_paths() -> Result<()>
```

**Purpose**: This test checks the behavior of `PathUri` path joining and parent lookup. It is especially concerned that paths are treated lexically, meaning the text of the path is preserved rather than automatically simplified or resolved on disk.

**Data flow**: It creates a base `PathUri`, joins a nested file path onto it, asks for the parent path, and compares both results to expected `PathUri` values. It also joins `../outside` and confirms that the parent-traversal text is kept as part of the path rather than being resolved away.

**Call relations**: The Rust test runner calls this directly. The test focuses on `PathUri::from_path`, `join`, and `parent`, using assertions to lock down path-string behavior that other file-system tests and API calls depend on.

*Call graph*: calls 1 internal fn (from_path); 2 external calls (new, assert_eq!).


##### `file_system_read_file_returns_bytes`  (lines 180–197)

```
async fn file_system_read_file_returns_bytes(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test confirms that reading a file through the API returns the exact bytes stored on disk. It checks the binary-safe read path, not just text reading.

**Data flow**: It creates a temporary file containing `hello from trait`, converts its path to a `PathUri`, and calls `read_file`. The returned byte vector is compared with the original bytes written to disk.

**Call relations**: The parameterized test runner runs this for both local and remote implementations. The test sets up the context with `create_file_system_context`, prepares the fixture with a normal disk write, then asks the file-system API to read it back.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, write).


##### `file_system_read_file_stream_returns_bounded_chunks`  (lines 202–236)

```
async fn file_system_read_file_stream_returns_bounded_chunks(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test makes sure streamed file reading returns all data while keeping each piece within the configured maximum chunk size. Streaming matters for large files because it avoids needing to move the whole file as one giant block.

**Data flow**: It builds a temporary binary file a little larger than two chunks, reads it through `read_file_stream`, collects all stream pieces, and checks two things: every piece is non-empty and no larger than `FILE_READ_CHUNK_SIZE`, and all pieces joined together equal the original file contents.

**Call relations**: The test runner calls this once per implementation. The test gets the file-system object from `create_file_system_context`, uses `PathUri::from_path` for the file address, and then consumes the returned asynchronous stream with `try_collect` before making assertions.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, assert!, assert_eq!, write).


##### `file_system_read_file_text_returns_string`  (lines 241–258)

```
async fn file_system_read_file_text_returns_string(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test checks the API path for reading a file as text. It verifies that valid text bytes are returned as the expected string.

**Data flow**: It writes a temporary text file, calls `read_file_text` with that file’s `PathUri`, and compares the returned string to `hello from trait`. The file remains on disk until the temporary directory is cleaned up.

**Call relations**: The parameterized test runner invokes this for both local and remote implementations. The test creates the context, prepares the file with a standard write, then uses the API’s text-specific read operation rather than the raw byte reader.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, write).


##### `file_system_copy_copies_file`  (lines 263–284)

```
async fn file_system_copy_copies_file(implementation: FileSystemImplementation) -> Result<()>
```

**Purpose**: This test confirms that the API can copy a regular file from one path to another. It ensures the destination file contains the same text as the source.

**Data flow**: It writes a source file in a temporary folder, calls `copy` with `recursive: false`, and then reads the destination file directly from disk. The result should be a new file whose contents match the source.

**Call relations**: The parameterized test runner runs this in both implementation modes. The test obtains the API from `create_file_system_context`, converts source and destination paths with `PathUri::from_path`, calls `copy`, and verifies the result independently through the standard file system.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, write).


##### `file_system_copy_copies_directory_recursively`  (lines 289–318)

```
async fn file_system_copy_copies_directory_recursively(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test checks that directory copying works when recursive copying is explicitly requested. It proves that nested folders and files are carried over, not just the top-level directory name.

**Data flow**: It creates a source directory with a nested folder and file, calls `copy` with `recursive: true`, and then reads the expected nested file under the copied directory. The successful after state is a copied directory tree containing the same nested text file.

**Call relations**: The parameterized test runner calls this for local and remote implementations. The test uses `create_file_system_context` and `PathUri::from_path` to reach the API, while ordinary disk operations create the source tree and verify the copied tree.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `file_system_read_directory_lists_entries`  (lines 323–356)

```
async fn file_system_read_directory_lists_entries(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test verifies that reading a directory returns its immediate children with correct names and file-versus-folder flags. It makes sure callers can discover what is inside a folder without opening each entry first.

**Data flow**: It creates a temporary directory containing one nested directory and one text file. It calls `read_directory`, sorts the returned entries by name so ordering does not matter, and compares them to the expected `ReadDirectoryEntry` values.

**Call relations**: The parameterized test runner invokes this for both implementations. The test prepares the directory on disk, asks the file-system API to list it, and then uses assertions to confirm that the API’s summary matches the created structure.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `file_system_remove_removes_directory`  (lines 361–385)

```
async fn file_system_remove_removes_directory(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test checks that the API can delete a directory tree when recursive and force options are enabled. It ensures cleanup operations can remove non-empty folders.

**Data flow**: It creates a temporary directory with a nested child directory, calls `remove` with `recursive: true` and `force: true`, and then checks that the original directory path no longer exists. The visible effect is deletion of the temporary directory tree.

**Call relations**: The test runner runs this for local and remote modes. The test uses `create_file_system_context` to get the implementation, turns the target into a `PathUri`, and then calls the API’s remove operation before checking the disk.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert!, create_dir_all).


##### `file_system_write_file_reports_missing_parent`  (lines 390–418)

```
async fn file_system_write_file_reports_missing_parent(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test confirms that writing a file fails clearly when its parent directory does not exist. It protects callers from silent directory creation or misleading success reports.

**Data flow**: It chooses a path inside a missing folder and calls `write_file`. If the write unexpectedly succeeds, the test fails immediately; otherwise it checks that the error kind is `NotFound` and that no file appeared at the requested path.

**Call relations**: The parameterized test runner calls this for both implementations. The test goes through `create_file_system_context` and `PathUri::from_path`, then focuses on the error returned by `write_file` rather than a successful result.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, bail!, assert!, assert_eq!).


##### `file_system_copy_rejects_directory_without_recursive`  (lines 423–449)

```
async fn file_system_copy_rejects_directory_without_recursive(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test makes sure copying a directory without the recursive option is rejected with a specific error. That prevents surprising partial copies or ambiguous behavior.

**Data flow**: It creates an empty source directory, calls `copy` with `recursive: false`, expects an error, and then checks both the error kind and the human-readable message. No destination directory should be successfully copied.

**Call relations**: The parameterized test runner runs this for local and remote implementations. The test sets up the source directory, sends source and destination `PathUri` values into the API, and validates that the copy operation refuses the request in the documented way.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, create_dir_all).


##### `file_system_sandboxed_metadata_and_read_allow_readable_root`  (lines 454–490)

```
async fn file_system_sandboxed_metadata_and_read_allow_readable_root(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test verifies that a read-only sandbox still allows safe read operations inside its allowed root. It checks both metadata lookup and file reading under those permission rules.

**Data flow**: It creates an allowed directory with a file, builds a read-only sandbox for that directory, then calls `get_metadata` and `read_file` with the sandbox attached. The returned metadata and bytes must match the file on disk.

**Call relations**: The parameterized test runner invokes this in both implementation modes. The test uses `read_only_sandbox` to build the permission boundary, then passes that sandbox into file-system API calls to prove that allowed reads are not blocked.

*Call graph*: calls 3 internal fn (create_file_system_context, read_only_sandbox, from_path); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `assert_canonicalize_resolves_directory_alias`  (lines 492–519)

```
async fn assert_canonicalize_resolves_directory_alias(
    implementation: FileSystemImplementation,
    create_directory_alias: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<()>
```

**Purpose**: This shared helper checks that canonicalization resolves a directory alias to the real underlying path. An alias may be a symlink or a platform-specific directory junction, and callers need the true path for reliable permission and identity checks.

**Data flow**: It receives an implementation choice and a callback that creates an alias from one directory path to another. It creates a real source directory with a nested file, asks the callback to create the alias, builds the alias-based requested path and the real expected path, verifies they differ before canonicalization, then calls `canonicalize` and checks that the result equals the real path.

**Call relations**: This helper is called by alias-specific tests such as `file_system_canonicalize_resolves_directory_symlink` and `file_system_canonicalize_resolves_directory_junction`. Those callers provide the alias-creation behavior, while this helper supplies the common setup and assertion flow against the file-system API.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); called by 2 (file_system_canonicalize_resolves_directory_symlink, file_system_canonicalize_resolves_directory_junction); 6 external calls (new, assert_eq!, assert_ne!, canonicalize, create_dir_all, write).


##### `assert_sandboxed_canonicalize_resolves_directory_alias`  (lines 521–549)

```
async fn assert_sandboxed_canonicalize_resolves_directory_alias(
    implementation: FileSystemImplementation,
    create_directory_alias: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<()>
```

**Purpose**: This shared helper checks that canonicalization still resolves aliases correctly when a sandbox is active. It proves that read permission over the surrounding temporary area is enough to resolve an allowed alias path to its real target.

**Data flow**: It receives an implementation choice and an alias-creation callback. It creates a source directory and nested file, creates an alias to the source, builds a read-only sandbox covering the temporary root, compares the alias path with the real canonical path to ensure they are different, then calls `canonicalize` with the sandbox and expects the real path back.

**Call relations**: This helper is used by sandboxed alias tests such as `file_system_sandboxed_canonicalize_resolves_directory_symlink` and `file_system_sandboxed_canonicalize_resolves_directory_junction`. The callers decide what kind of alias to create; this helper checks the common sandboxed behavior.

*Call graph*: calls 3 internal fn (create_file_system_context, read_only_sandbox, from_path); called by 2 (file_system_sandboxed_canonicalize_resolves_directory_symlink, file_system_sandboxed_canonicalize_resolves_directory_junction); 6 external calls (new, assert_eq!, assert_ne!, canonicalize, create_dir_all, write).


##### `file_system_sandboxed_write_allows_additional_write_root`  (lines 555–603)

```
async fn file_system_sandboxed_write_allows_additional_write_root(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test verifies that extra permissions can extend a read-only sandbox with a new writable root. It matters because some operations may need temporary or user-approved write access outside the original read-only area.

**Data flow**: It creates separate readable and writable temporary directories. It starts with a read-only sandbox for the readable directory, builds an additional permission profile that marks the writable directory as writable, combines the original and additional policies, updates the sandbox, and then writes a file into the added writable root. Finally it reads the file from disk to confirm it was created with the expected bytes.

**Call relations**: The parameterized test runner calls this for local and remote implementations. The test uses `read_only_sandbox` for the starting permissions, `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy` to merge in the extra permissions, then calls `write_file` through the file-system API to prove the merged sandbox is honored.

*Call graph*: calls 7 internal fn (create_file_system_context, read_only_sandbox, from_read_write_roots, from_runtime_permissions_with_enforcement, effective_file_system_sandbox_policy, effective_network_sandbox_policy, from_path); 4 external calls (new, assert_eq!, create_dir_all, vec!).


##### `file_system_copy_rejects_copying_directory_into_descendant`  (lines 608–634)

```
async fn file_system_copy_rejects_copying_directory_into_descendant(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: This test ensures the API refuses to copy a directory into one of its own children. Without this guard, a recursive copy could chase itself forever or create an endlessly nested directory tree.

**Data flow**: It creates a source directory with a nested child directory, then tries to copy the source into a path inside that child while using `recursive: true`. The expected output is an `InvalidInput` error with a specific message explaining that a directory cannot be copied to itself or one of its descendants.

**Call relations**: The parameterized test runner runs this for both implementations. The test sets up the risky directory shape on disk, sends the copy request through the file-system API, and validates that the API stops the operation before any runaway recursive copy can happen.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, create_dir_all).


### `exec-server/tests/file_system_unix.rs`

`test` · `test run`

This test file is a safety net for file operations on Unix systems. Unix has features like symbolic links, which are shortcuts that can point somewhere else, hard links, which are two directory entries for the same underlying file, and FIFOs, which are special pipe-like files. These features can easily create security mistakes if a sandbox only checks the path text and not where the path really leads.

The tests create temporary folders, files, links, and special files, then ask the file system layer to read, write, copy, remove, inspect, or create directories. Many tests build an “allowed” folder and an “outside” folder, then place a symlink inside the allowed folder that secretly points outside. The expected result is that sandboxed operations must not escape through that link.

The file also checks positive behavior: metadata should report symlinks correctly, copying should preserve symlinks instead of following them, removing a symlink should remove the shortcut rather than its target, and writing through an existing hard link should keep the hard link relationship. On Linux, it also verifies that the sandbox helper can find the bubblewrap program (`bwrap`, a Linux sandboxing tool) through the preserved `PATH`. Without these tests, subtle Unix path behavior could allow reads or writes outside the intended workspace.

#### Function details

##### `assert_sandbox_denied`  (lines 40–61)

```
fn assert_sandbox_denied(error: &std::io::Error)
```

**Purpose**: Checks that an error looks like a proper sandbox denial. Different Unix systems report blocked access with slightly different error kinds and messages, so this helper accepts the expected safe variations.

**Data flow**: It receives an input/output error from a failed file operation. It inspects the error kind and message, then either accepts it as a valid sandbox rejection or fails the test if the error looks unrelated.

**Call relations**: The symlink-escape and unwritable-path tests call this after an operation is expected to fail. It gives those tests one shared rule for deciding whether the failure really came from sandbox protection.

*Call graph*: called by 8 (file_system_copy_rejects_symlink_escape_destination, file_system_copy_rejects_symlink_escape_source, file_system_create_directory_rejects_symlink_escape, file_system_read_directory_rejects_symlink_escape, file_system_remove_rejects_symlink_escape, file_system_sandboxed_read_rejects_symlink_escape, file_system_sandboxed_write_rejects_symlink_escape, file_system_sandboxed_write_rejects_unwritable_path); 4 external calls (assert!, kind, to_string, panic!).


##### `assert_normalized_path_rejected`  (lines 63–80)

```
fn assert_normalized_path_rejected(error: &std::io::Error)
```

**Purpose**: Checks that a path rejected after `..` cleanup failed in an acceptable way. This is used for a tricky case where path normalization can turn a symlink escape attempt into either a missing-file error or a sandbox denial.

**Data flow**: It takes an error from a failed read. It looks at the kind and text of that error, then accepts only the known safe outcomes: not found, permission denied, or invalid input with a sandbox-like message.

**Call relations**: The parent-dot-dot symlink test calls this because that scenario can fail at slightly different layers. This helper keeps the test focused on the important point: the outside file was not read.

*Call graph*: called by 1 (file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape); 4 external calls (assert!, kind, to_string, panic!).


##### `alias_root_candidate`  (lines 82–89)

```
fn alias_root_candidate() -> Result<Option<PathBuf>>
```

**Purpose**: Finds a temporary directory path that is an alias for another real path, if the current system has one. This lets a test check that explicitly allowed alias roots still work.

**Data flow**: It looks at `/tmp` and the system temporary directory. For each candidate, it checks whether it exists and whether its canonical, fully resolved path differs from the written path; if so, it returns that candidate.

**Call relations**: The alias-root write test calls this first. If no suitable alias exists on the machine, the test exits successfully because there is nothing meaningful to check.

*Call graph*: called by 1 (file_system_sandboxed_write_allows_explicit_alias_roots); 2 external calls (new, temp_dir).


##### `create_directory_symlink`  (lines 91–94)

```
fn create_directory_symlink(target: &Path, alias: &Path) -> Result<()>
```

**Purpose**: Creates a Unix symbolic link from one directory path to another. The shared canonicalization tests use it to build a directory alias.

**Data flow**: It receives a target path and an alias path. It asks the operating system to create a symlink at the alias that points to the target, then returns success or the operating system error.

**Call relations**: This function is passed into shared tests as the Unix-specific way to create a directory alias. Those shared tests then verify that canonicalization resolves the alias correctly.

*Call graph*: 1 external calls (symlink).


##### `write_fake_bwrap`  (lines 97–143)

```
fn write_fake_bwrap(bin_dir: &Path) -> Result<PathBuf>
```

**Purpose**: Creates a fake `bwrap` executable for a Linux test. `bwrap` is bubblewrap, a sandboxing command; the fake version records how it was invoked and then runs the inner command.

**Data flow**: It receives a directory where the fake executable should live. It creates the directory, writes a shell script named `bwrap`, marks it executable, and returns the path to that fake program.

**Call relations**: The Linux sandbox-helper test calls this to prove the file system helper searches the preserved `PATH`. The fake executable writes a log so the test can confirm it was actually used.

*Call graph*: called by 1 (sandboxed_file_system_helper_finds_bwrap_on_preserved_path); 5 external calls (join, create_dir_all, metadata, set_permissions, write).


##### `file_system_canonicalize_resolves_directory_symlink`  (lines 148–153)

```
async fn file_system_canonicalize_resolves_directory_symlink(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that canonicalizing a directory symlink returns the real directory path. Canonicalizing means asking the system for the true path after following links.

**Data flow**: It receives a chosen file system implementation from the test framework. It passes that implementation and the Unix symlink-creation helper to shared test code, which builds the scenario and checks the result.

**Call relations**: This is a thin Unix wrapper around shared file system tests. It runs once for the local implementation and once for the remote implementation.

*Call graph*: calls 1 internal fn (assert_canonicalize_resolves_directory_alias).


##### `file_system_sandboxed_canonicalize_resolves_directory_symlink`  (lines 158–166)

```
async fn file_system_sandboxed_canonicalize_resolves_directory_symlink(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that canonicalization still resolves directory symlinks correctly when a sandbox is involved. This matters because sandbox checks must not break normal path resolution inside allowed areas.

**Data flow**: It receives the local or remote implementation choice. It hands that choice and the symlink-creation helper to shared sandbox-aware canonicalization test code.

**Call relations**: Like the non-sandbox version, this delegates the main work to shared tests. It supplies the Unix-specific link creation step and runs for both supported file system implementations.

*Call graph*: calls 1 internal fn (assert_sandboxed_canonicalize_resolves_directory_alias).


##### `sandboxed_file_system_helper_finds_bwrap_on_preserved_path`  (lines 170–207)

```
async fn sandboxed_file_system_helper_finds_bwrap_on_preserved_path() -> Result<()>
```

**Purpose**: On Linux, verifies that sandboxed file operations can find `bwrap` through the `PATH` environment variable passed to the exec server. This guards against breaking sandbox startup when `bwrap` is not in a hard-coded location.

**Data flow**: It creates a temporary fake `bwrap`, prepends its directory to `PATH`, starts an exec server with that environment, then writes a file through a sandboxed file system call. Afterward it reads the created file and the fake `bwrap` log to confirm the sandbox helper used the fake command with the expected arguments.

**Call relations**: This test calls the fake-`bwrap` setup helper, starts an exec server with a custom environment, creates a test environment from that server, and then uses the file system API. It ties environment setup, sandbox invocation, and a real write operation together.

*Call graph*: calls 5 internal fn (create_for_tests, exec_server_with_env, workspace_write_sandbox, write_fake_bwrap, from_path); 9 external calls (new, assert!, assert_eq!, join_paths, split_paths, var_os, create_dir_all, read_to_string, vec!).


##### `file_system_get_metadata_reports_symlink_targets`  (lines 212–264)

```
async fn file_system_get_metadata_reports_symlink_targets(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that metadata for a symlink reports both that the path is a symlink and what kind of target it points to. For example, a link to a file should look file-like while still being marked as a link.

**Data flow**: It creates a real file and a symlink to it, then asks the file system for metadata and compares the result with expected fields. It repeats the same idea for a directory symlink, checking directory flags, file flags, size, symlink status, and timestamps.

**Call relations**: The test creates a file system context for either local or remote mode, then calls the metadata API. It confirms that both implementations present Unix symlink metadata in the same useful shape.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 6 external calls (new, assert!, assert_eq!, create_dir, write, symlink).


##### `file_system_sandboxed_write_rejects_unwritable_path`  (lines 269–294)

```
async fn file_system_sandboxed_write_rejects_unwritable_path(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that a read-only sandbox refuses a write. This is the basic rule that a sandbox marked read-only must not allow file creation.

**Data flow**: It creates a temporary directory and chooses a file path inside it. It builds a read-only sandbox around that directory, tries to write bytes to the file, expects an error, checks that the error is a sandbox denial, and confirms the file was never created.

**Call relations**: This test uses the shared file system context setup and the sandbox error helper. It is one of the baseline checks that both local and remote file system implementations obey sandbox permissions.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_sandbox_denied, from_path); 3 external calls (new, bail!, assert!).


##### `file_system_sandboxed_write_allows_explicit_alias_roots`  (lines 299–326)

```
async fn file_system_sandboxed_write_allows_explicit_alias_roots(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that a sandbox can allow writes through an explicitly allowed path alias. This prevents over-strict path resolution from rejecting a path the user intentionally allowed.

**Data flow**: It first looks for a temporary root such as `/tmp` whose written path differs from its canonical path. If one exists, it creates a temp directory inside it, builds a writable sandbox rooted at the alias path, writes a file, and confirms the file contains the expected bytes.

**Call relations**: This test depends on `alias_root_candidate` to decide whether the system can exercise the case. It then uses the normal file system write API to prove local and remote implementations respect explicitly configured alias roots.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, alias_root_candidate, from_path); 2 external calls (assert_eq!, new).


##### `file_system_sandboxed_read_rejects_symlink_escape`  (lines 331–357)

```
async fn file_system_sandboxed_read_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that a read-only sandbox cannot be escaped by following a symlink to an outside directory. This protects against reading files that only appear to be inside the allowed area.

**Data flow**: It creates an allowed directory, an outside directory, and a secret file outside. Then it places a symlink inside the allowed directory pointing to the outside directory, tries to read the secret through that symlink path, expects failure, and checks the error as a sandbox denial.

**Call relations**: This test sets up a classic symlink escape attempt and calls the file system read API. It uses `assert_sandbox_denied` to verify the failure is the intended security block.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, create_dir_all, write, symlink).


##### `file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape`  (lines 362–392)

```
async fn file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests a trickier path that combines a symlink with `..`, meaning “go to the parent directory.” The goal is to make sure path cleanup does not accidentally allow a read outside the sandbox.

**Data flow**: It creates allowed and outside folders, writes a secret file, and adds a symlink inside the allowed folder. It then builds a path like `link/../secret.txt`, converts it to a path URI, tries to read it under a read-only sandbox, and expects rejection or a safe not-found result.

**Call relations**: This test calls `assert_normalized_path_rejected` instead of the standard sandbox-denial helper because path normalization may happen before the file system layer sees the original symlink-shaped path.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_normalized_path_rejected, from_path); 5 external calls (new, bail!, create_dir_all, write, symlink).


##### `file_system_sandboxed_write_rejects_symlink_escape`  (lines 397–427)

```
async fn file_system_sandboxed_write_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that a writable sandbox cannot write outside its root by using a symlink inside the allowed directory. A writable sandbox must still be limited to the allowed workspace.

**Data flow**: It creates an allowed directory and an outside directory, then links from inside the allowed directory to the outside one. It tries to write a new file through that link, expects an error, checks the error as sandbox denial, and verifies no outside file was created.

**Call relations**: This test exercises the file system write API with a malicious-looking destination path. It relies on `assert_sandbox_denied` to confirm the write was blocked for the right reason.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, assert!, create_dir_all, symlink).


##### `file_system_sandboxed_write_preserves_existing_hard_link`  (lines 432–476)

```
async fn file_system_sandboxed_write_preserves_existing_hard_link(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that writing through an allowed hard link updates the existing linked file rather than replacing it with a separate new file. A hard link is another name for the same underlying file.

**Data flow**: It creates a file outside the sandbox and a hard link to that same file inside the allowed directory. It writes new content through the inside hard link, then reads both paths and checks they contain the updated content and still share the same device and inode identifiers.

**Call relations**: This test calls the sandboxed write API in a case that is allowed because the path itself is inside the workspace. It verifies the implementation does not break Unix hard link identity while enforcing sandbox rules.

*Call graph*: calls 3 internal fn (create_file_system_context, workspace_write_sandbox, from_path); 6 external calls (new, assert_eq!, create_dir_all, hard_link, metadata, write).


##### `file_system_create_directory_rejects_symlink_escape`  (lines 481–511)

```
async fn file_system_create_directory_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that creating a directory is blocked when the requested path reaches outside the sandbox through a symlink. Directory creation should not be a way to modify outside folders.

**Data flow**: It creates allowed and outside directories, places a symlink from allowed to outside, then asks the file system to create a directory under that linked path. It expects an error, checks it as sandbox denial, and confirms the outside directory was not modified.

**Call relations**: This test exercises the `create_directory` API with sandbox write permissions. It shares the same symlink-escape pattern as the write, copy, read, and remove tests.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, assert!, create_dir_all, symlink).


##### `file_system_read_directory_rejects_symlink_escape`  (lines 516–542)

```
async fn file_system_read_directory_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that listing a directory is blocked when the directory path is actually a symlink to outside the sandbox. Listing can reveal file names, so it must be protected like reading file contents.

**Data flow**: It creates an outside directory with a secret file, adds a symlink to that outside directory inside the allowed directory, and tries to read the directory listing through the symlink. It expects failure and checks that the failure is a sandbox denial.

**Call relations**: This test calls the read-directory API under a read-only sandbox. It uses the shared sandbox-denial helper to keep the expected error rules consistent.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, create_dir_all, write, symlink).


##### `file_system_copy_rejects_symlink_escape_destination`  (lines 547–579)

```
async fn file_system_copy_rejects_symlink_escape_destination(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that copying a file is blocked if the destination path escapes the sandbox through a symlink. Without this, a copy operation could write outside the workspace.

**Data flow**: It creates a source file inside the allowed directory and a symlink from the allowed directory to an outside directory. It tries to copy the source into the outside directory through that symlink, expects an error, checks it as sandbox denial, and confirms no copied file appeared outside.

**Call relations**: This test exercises the copy API with a safe source and unsafe destination. It is part of the group proving every file operation checks the real destination, not just the written path.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 6 external calls (new, bail!, assert!, create_dir_all, write, symlink).


##### `file_system_remove_removes_symlink_not_target`  (lines 584–618)

```
async fn file_system_remove_removes_symlink_not_target(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that removing a symlink removes the shortcut itself, not the file it points to. This is important because deleting a link inside the sandbox should not delete an outside target.

**Data flow**: It creates an outside file and a symlink to it inside the allowed directory. It removes the symlink through the sandboxed file system API, then checks the symlink is gone while the outside file still exists with its original contents.

**Call relations**: This test calls the remove API in a case where the symlink path is inside the allowed workspace. It verifies the implementation treats the symlink itself as the object to remove.

*Call graph*: calls 3 internal fn (create_file_system_context, workspace_write_sandbox, from_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, write, symlink).


##### `file_system_copy_preserves_symlink_source`  (lines 623–656)

```
async fn file_system_copy_preserves_symlink_source(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that copying a symlink copies the symlink itself rather than copying the file it points to. This preserves Unix filesystem structure instead of silently changing meaning.

**Data flow**: It creates an outside file and a symlink to it inside the allowed directory. It copies that symlink to a new path inside the same allowed directory, then checks the new path is also a symlink and points to the same target.

**Call relations**: This test exercises the copy API with a symlink as the source. It complements the remove test by confirming symlink-aware operations act on the link itself when appropriate.

*Call graph*: calls 3 internal fn (create_file_system_context, workspace_write_sandbox, from_path); 7 external calls (new, assert!, assert_eq!, create_dir_all, symlink_metadata, write, symlink).


##### `file_system_remove_rejects_symlink_escape`  (lines 661–696)

```
async fn file_system_remove_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that removing a file is blocked if the requested path escapes the sandbox through a symlinked directory. This prevents deleting outside files by disguising their path.

**Data flow**: It creates an outside file, links an allowed path to the outside directory, then tries to remove the outside file through the link. It expects a sandbox denial and confirms the outside file still contains its original text.

**Call relations**: This test calls the remove API with an unsafe path. It uses `assert_sandbox_denied` and belongs to the broader set of tests ensuring every operation respects sandbox boundaries.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 6 external calls (new, bail!, assert_eq!, create_dir_all, write, symlink).


##### `file_system_copy_rejects_symlink_escape_source`  (lines 701–735)

```
async fn file_system_copy_rejects_symlink_escape_source(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that copying is blocked if the source path escapes the sandbox through a symlink. Even if the destination is inside the workspace, the operation must not read outside data.

**Data flow**: It creates a secret outside file and a symlink from the allowed directory to the outside directory. It tries to copy the outside secret into an allowed destination through that symlink path, expects a sandbox denial, and confirms the destination file was not created.

**Call relations**: This test exercises the copy API with an unsafe source and safe destination. Together with the destination-escape copy test, it proves copy checks both ends of the operation.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 6 external calls (new, bail!, assert!, create_dir_all, write, symlink).


##### `file_system_copy_preserves_symlinks_in_recursive_copy`  (lines 740–772)

```
async fn file_system_copy_preserves_symlinks_in_recursive_copy(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that recursive directory copy preserves symlinks inside the directory tree. Recursive copy means copying a folder and its contents.

**Data flow**: It creates a source directory with a nested directory and a relative symlink pointing to that nested directory. It copies the source directory recursively, then checks that the copied link is still a symlink and still points to the same relative target text.

**Call relations**: This test calls the copy API without a sandbox because it is checking copy semantics, not sandbox enforcement. It verifies both local and remote implementations keep symlinks intact during recursive copies.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_metadata, symlink).


##### `file_system_copy_ignores_unknown_special_files_in_recursive_copy`  (lines 777–816)

```
async fn file_system_copy_ignores_unknown_special_files_in_recursive_copy(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that recursive directory copy skips special files it does not support, such as a FIFO named pipe, while still copying normal files. A FIFO is a special file used for process-to-process communication, not ordinary stored content.

**Data flow**: It creates a source directory with a normal text file and a FIFO made with the `mkfifo` command. It recursively copies the directory, then checks the normal file was copied and the FIFO was not created in the destination.

**Call relations**: This test uses the external `mkfifo` command to create a Unix-only special file, then calls the copy API. It documents the intended behavior for special files encountered inside a recursive copy: ignore them rather than fail the whole copy.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 7 external calls (new, bail!, assert!, assert_eq!, new, create_dir_all, write).


##### `file_system_copy_rejects_standalone_fifo_source`  (lines 821–854)

```
async fn file_system_copy_rejects_standalone_fifo_source(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests that copying a FIFO directly fails with a clear error. Unlike a FIFO found inside a recursive directory copy, a standalone FIFO source is the whole requested operation, so silently skipping it would be misleading.

**Data flow**: It creates a FIFO in a temporary directory, then asks the file system to copy that FIFO to a destination. It expects an error and checks both the error kind and the exact message saying copy only supports regular files, directories, and symlinks.

**Call relations**: This test calls the copy API directly on a special file source. It pairs with the recursive-copy special-file test to define the two intended behaviors: skip unsupported special files inside folders, but reject them when they are the requested source.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, bail!, assert_eq!, new).


### `exec-server/tests/file_system_windows.rs`

`test` · `test run on Windows`

This test file protects an important Windows behavior: when code asks for the “real” path of a directory, it should resolve a directory junction to its actual target. Without this, the system could think two paths are different even though they lead to the same place, which can break sandbox checks, caching, or file access rules.

The file is only compiled and run on Windows. It uses the Windows `mklink /J` command to create a directory junction during the test. Think of the junction as a signpost: the alias path looks like a folder, but it sends you to another folder.

The tests run against two file system implementations: a local one and a remote one. That means the same behavior is expected whether the code is talking directly to the machine’s file system or through the project’s remote file system layer.

Most of the actual test scenario lives in shared test helpers. This file supplies the Windows-specific way to create the alias, then asks the shared tests to verify ordinary canonicalization and sandboxed canonicalization. “Canonicalization” means turning a path into its final, normalized, real path.

#### Function details

##### `create_directory_junction`  (lines 19–33)

```
fn create_directory_junction(target: &Path, alias: &Path) -> Result<()>
```

**Purpose**: Creates a Windows directory junction from an alias path to a target path. The tests use it to build the special Windows folder link they need before checking path resolution.

**Data flow**: It receives two paths: the real target directory and the alias directory to create. It runs the Windows command `cmd /C mklink /J <alias> <target>`. If Windows reports success, it returns success. If the command fails, it turns the command’s output into a clear error message so the test explains what went wrong.

**Call relations**: This is the Windows-specific setup tool passed into the shared file system tests. The shared test code calls it when it needs to create a directory alias, and this function hands back either a ready-to-use junction or a failure that stops the test.

*Call graph*: 2 external calls (bail!, new).


##### `file_system_canonicalize_resolves_directory_junction`  (lines 38–43)

```
async fn file_system_canonicalize_resolves_directory_junction(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that normal path canonicalization follows a Windows directory junction to its real target. It runs the same check for both the local and remote file system implementations.

**Data flow**: It receives the file system implementation being tested. It passes that implementation, along with the junction-creation helper, into the shared test routine. The result is whatever the shared test finds: success if the resolved path is correct, or an error if canonicalization does not follow the junction properly.

**Call relations**: The test framework calls this function once for the local implementation and once for the remote implementation. This function does not build the whole scenario itself; it delegates the common cross-platform logic to the shared assertion helper and supplies the Windows-specific junction creator.

*Call graph*: calls 1 internal fn (assert_canonicalize_resolves_directory_alias).


##### `file_system_sandboxed_canonicalize_resolves_directory_junction`  (lines 48–56)

```
async fn file_system_sandboxed_canonicalize_resolves_directory_junction(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that sandboxed path canonicalization also follows a Windows directory junction correctly. This matters because sandboxing adds safety boundaries, and those boundaries must still understand where a linked directory really points.

**Data flow**: It receives the file system implementation under test. It sends that implementation and the Windows junction-creation helper to the shared sandboxed test routine. The shared routine performs the setup and checks, then returns success or an error describing the failure.

**Call relations**: The test framework runs this for both local and remote file systems. This function is the Windows entry point for the sandbox-specific version of the shared directory-alias test, handing off the real checking work to the shared helper.

*Call graph*: calls 1 internal fn (assert_sandboxed_canonicalize_resolves_directory_alias).


### `exec-server/src/local_file_system_path_uri_tests.rs`

`test` · `test run`

This is a small safety test for `DirectFileSystem`, the part of the system that reads files directly from the machine it is running on. File URIs can mean different things on different operating systems. For example, a Unix machine and a Windows machine do not describe local files in exactly the same way. This test checks that if `DirectFileSystem` is given a URI that parses as a valid file URI but is not “native” to the current platform, it rejects it as bad input instead of trying to read it.

The helper function builds a deliberately non-native URI. On Unix, it uses a Windows-style network share URI. On Windows, it uses a Unix-style absolute path URI. The test then asks `DirectFileSystem` to read that URI and expects the operation to fail. More specifically, it checks that the failure is classified as `InvalidInput`, meaning “the caller gave us something we should not accept,” rather than a lower-level file error like “file not found.”

This matters because path handling is a boundary where mistakes can become confusing or unsafe. The test acts like a guardrail: the file system layer should only accept local paths that make sense for the machine it is actually running on.

#### Function details

##### `direct_file_system_rejects_non_native_uri_as_invalid_input`  (lines 8–15)

```
async fn direct_file_system_rejects_non_native_uri_as_invalid_input()
```

**Purpose**: This asynchronous test proves that `DirectFileSystem` rejects a valid-looking but non-native file URI. It is used to make sure the error is reported as invalid input, not as some accidental file-reading failure.

**Data flow**: It first gets a deliberately non-native `PathUri` from `non_native_uri`. It passes that URI into `DirectFileSystem.read_file` with no sandbox restriction. Instead of expecting file contents back, it expects an error, then checks that the error kind is `InvalidInput`.

**Call relations**: During the test run, this function is the main check. It calls `non_native_uri` to prepare the bad-but-parseable URI, then uses `assert_eq!` to confirm that `DirectFileSystem` reports the exact kind of failure the rest of the system can safely understand.

*Call graph*: calls 1 internal fn (non_native_uri); 1 external calls (assert_eq!).


##### `non_native_uri`  (lines 17–27)

```
fn non_native_uri() -> PathUri
```

**Purpose**: This helper creates a file URI that is valid in URI syntax but inappropriate for the operating system running the test. It gives the main test a reliable example of input that should be rejected.

**Data flow**: It starts with a hard-coded URI string chosen for the current platform: a network-share style URI on Unix, or a Unix-style local path on Windows. It feeds that string into `PathUri::parse`. If parsing succeeds, it returns the parsed `PathUri`; if parsing unexpectedly fails, it stops the test with a panic because the fixture itself is broken.

**Call relations**: The main test calls this helper before trying to read a file. Its job is only to prepare the test input, so the main test can focus on the behavior of `DirectFileSystem` rather than on the details of constructing the URI.

*Call graph*: calls 1 internal fn (parse); called by 1 (direct_file_system_rejects_non_native_uri_as_invalid_input); 1 external calls (panic!).


### `exec-server/src/remote_file_system_path_uri_tests.rs`

`test` · `test run`

This is a focused test for the remote file system client. The real problem it guards against is subtle: a local machine may not understand the path style used by a remote machine. For example, a Unix computer should not rewrite a Windows drive URI like `file:///C:/...`, and a Windows computer should not rewrite a Unix path URI. If that happened, the remote server could receive the wrong file path and read the wrong file, or fail entirely.

The test creates a tiny fake WebSocket server, which is like a temporary phone line between the client and a pretend remote server. The client connects to it, performs the normal JSON-RPC startup conversation, then sends `fs/readFile` requests. JSON-RPC is a simple request-and-response message format encoded as JSON.

The fake server records the read-file parameters it receives and sends back an empty file response. After the client has made its requests, the test compares the recorded parameters with the original path URIs and sandbox working directory. The important check is that the paths and sandbox current working directory are still URI values, unchanged by any local native path conversion.

The helper functions in this file build the fake server, complete the startup handshake, and read or write JSON-RPC messages over WebSocket frames.

#### Function details

##### `remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion`  (lines 35–79)

```
async fn remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion()
```

**Purpose**: This is the main test. It proves that `RemoteFileSystem::read_file` sends path URIs and the sandbox current working directory exactly as URI values, without translating them into the local computer's path style.

**Data flow**: The test starts by asking `record_read_file_params` to create a fake WebSocket server that will record two read-file requests. It builds a remote file system client pointed at that server, creates two non-local-looking file URIs, and builds a sandbox context with a deliberately non-native current working directory. It then reads both files through the remote file system. The fake server returns empty data, and the test finally compares what the server captured with the original paths and sandbox information. The expected result is that the sent parameters match exactly.

**Call relations**: This function drives the whole test scenario. It calls `record_read_file_params` to stand up the pretend server, calls `non_native_cwd` to choose a working-directory URI that should not be native to the test machine, then exercises the real remote file system client. The captured server data is the evidence used to confirm the client behaved correctly.

*Call graph*: calls 8 internal fn (new, websocket_url, new, non_native_cwd, record_read_file_params, from_permission_profile_with_cwd, from_runtime_permissions, restricted); 2 external calls (assert_eq!, vec!).


##### `record_read_file_params`  (lines 81–130)

```
async fn record_read_file_params(
    expected_requests: usize,
) -> (
    String,
    oneshot::Receiver<Vec<FsReadFileParams>>,
    tokio::task::JoinHandle<()>,
)
```

**Purpose**: This helper starts a small local WebSocket server that pretends to be the remote execution server. Its job is to capture the parameters of incoming `fs/readFile` requests so the test can inspect what the client actually sent.

**Data flow**: It receives the number of file-read requests it should expect. It opens a local TCP listener on an available port, turns that address into a WebSocket URL for the client, and creates a one-time channel for sending captured data back to the test. In the background, it accepts the client connection, upgrades it to a WebSocket, completes the initialization exchange, then reads the expected number of JSON-RPC read-file requests. For each request, it deserializes the parameters, stores them, and replies with an empty file result. When done, it sends the collected parameters through the channel.

**Call relations**: The main test calls this before creating the remote file system client. Inside its background server task, it relies on `complete_websocket_initialize` for the startup handshake, `read_jsonrpc_websocket` to receive client messages, and `write_jsonrpc_websocket` to send responses. It hands the test three things: the URL to connect to, a receiver for the captured parameters, and a background task to await.

*Call graph*: calls 3 internal fn (complete_websocket_initialize, read_jsonrpc_websocket, write_jsonrpc_websocket); called by 1 (remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 11 external calls (new, bind, with_capacity, Response, format!, channel, panic!, from_value, to_value, spawn (+1 more)).


##### `non_native_cwd`  (lines 132–139)

```
fn non_native_cwd() -> PathUri
```

**Purpose**: This helper returns a current-working-directory URI that should look foreign to the operating system running the test. That makes it easier to catch unwanted conversion into local path syntax.

**Data flow**: It checks the compilation target. On Unix-like systems it chooses a Windows/network-share style URI, and on Windows it chooses a Unix-style URI. It parses that string into a `PathUri` and returns it. If the URI is invalid, the test fails immediately.

**Call relations**: The main test calls this when building the sandbox context. The returned URI becomes part of the data sent to the fake server, so the final comparison can confirm that even the sandbox working directory was not rewritten.

*Call graph*: calls 1 internal fn (parse); called by 1 (remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion).


##### `complete_websocket_initialize`  (lines 141–163)

```
async fn complete_websocket_initialize(websocket: &mut WebSocketStream<TcpStream>)
```

**Purpose**: This helper performs the expected startup conversation between the remote file system client and the fake server. It makes the fake server act just enough like a real server for the test to continue.

**Data flow**: It reads the next JSON-RPC message from the WebSocket and expects it to be an `initialize` request. It replies with a successful initialization response containing a session ID. Then it reads one more message and expects an `initialized` notification, which tells the server the client considers startup complete. If either message is not what the test expects, it stops with a failure.

**Call relations**: The fake server inside `record_read_file_params` calls this right after accepting the WebSocket connection and before recording file-read requests. It uses `read_jsonrpc_websocket` to receive the startup messages and `write_jsonrpc_websocket` to send the initialization response.

*Call graph*: calls 2 internal fn (read_jsonrpc_websocket, write_jsonrpc_websocket); called by 1 (record_read_file_params); 3 external calls (Response, panic!, to_value).


##### `read_jsonrpc_websocket`  (lines 165–185)

```
async fn read_jsonrpc_websocket(websocket: &mut WebSocketStream<TcpStream>) -> JSONRPCMessage
```

**Purpose**: This helper reads one JSON-RPC message from a WebSocket connection. It hides the details of WebSocket frames so the test code can think in terms of protocol messages.

**Data flow**: It waits up to one second for the next WebSocket frame. If the frame contains text, it parses the text as JSON-RPC. If the frame contains binary data, it parses the bytes as JSON-RPC. If it receives WebSocket ping or pong frames, which are connection keep-alive messages, it ignores them and keeps waiting. If the connection closes, times out, or sends an unexpected frame, the test fails.

**Call relations**: Both `complete_websocket_initialize` and `record_read_file_params` call this whenever the fake server needs to receive a message from the client. It is the receiving half of the test's small WebSocket protocol toolkit, paired with `write_jsonrpc_websocket`.

*Call graph*: called by 2 (complete_websocket_initialize, record_read_file_params); 6 external calls (from_secs, next, panic!, from_slice, from_str, timeout).


##### `write_jsonrpc_websocket`  (lines 187–196)

```
async fn write_jsonrpc_websocket(
    websocket: &mut WebSocketStream<TcpStream>,
    message: JSONRPCMessage,
)
```

**Purpose**: This helper sends one JSON-RPC message over a WebSocket connection. It lets the fake server reply to the client in the same format a real remote execution server would use.

**Data flow**: It takes a JSON-RPC message, converts it into a JSON string, wraps that string in a WebSocket text frame, and sends it through the connection. If serialization or sending fails, the test fails.

**Call relations**: The fake server uses this in `complete_websocket_initialize` to answer the client's initialization request, and in `record_read_file_params` to answer each read-file request. It is the sending half of the test's WebSocket helper pair, complementing `read_jsonrpc_websocket`.

*Call graph*: called by 2 (complete_websocket_initialize, record_read_file_params); 3 external calls (send, to_string, Text).


### `exec-server/src/sandboxed_file_system_path_uri_tests.rs`

`test` · `test run`

This is a small safety test for the exec server’s sandboxed file system. The sandbox is meant to control what files the server may read, so it must be strict about what counts as a valid local file path. A file URI is a text form of a path, such as a web-style address beginning with `file://`. Some file URIs are valid on one operating system but not another. For example, a Windows network-share style URI is not a normal Unix path, while a Unix-style absolute path is not a native Windows URI in this test’s context.

The test builds a real `SandboxedFileSystem`, creates a restricted permission profile, then asks the file system to read a deliberately “non-native” URI. The important expected behavior is not just that reading fails, but that it fails as bad input. In other words, the system should reject the request before trying to interpret it as a path inside the sandbox.

This matters because path parsing is a security boundary. If the code were too forgiving, a strange URI might be normalized or interpreted differently than expected, like a mailroom accepting an envelope with an address format from another country and guessing where it should go. This test makes sure the system says, plainly, “that address format is not valid here.”

#### Function details

##### `sandboxed_file_system_rejects_non_native_uri_as_invalid_input`  (lines 11–31)

```
async fn sandboxed_file_system_rejects_non_native_uri_as_invalid_input()
```

**Purpose**: This asynchronous test checks that `SandboxedFileSystem::read_file` rejects a file URI that is not native to the current operating system. It verifies that the rejection is reported as invalid input, not as some later file access failure.

**Data flow**: It starts by building runtime path information from the current executable, then creates a sandboxed file system from those paths. It builds a restricted permission profile and turns it into a file-system sandbox context. It then passes a deliberately non-native `PathUri` into `read_file`. The expected result is an error, and the test checks that the error kind is `InvalidInput`.

**Call relations**: This is the main test case in the file. It calls `non_native_uri` to get the intentionally wrong kind of URI, uses the permission and sandbox constructors to set up a realistic restricted environment, then calls the file system read operation. Finally, it uses an equality assertion to confirm the error is the exact kind the rest of the system should rely on.

*Call graph*: calls 6 internal fn (new, new, non_native_uri, from_permission_profile, from_runtime_permissions, restricted); 3 external calls (new, assert_eq!, current_exe).


##### `non_native_uri`  (lines 33–43)

```
fn non_native_uri() -> PathUri
```

**Purpose**: This helper creates a validly parsed file URI that is deliberately not native for the operating system running the test. It lets the test focus on the sandbox behavior instead of repeating platform-specific URI text inline.

**Data flow**: It chooses one URI string on Unix and a different URI string on Windows. It then asks `PathUri::parse` to turn that string into a `PathUri`. If parsing succeeds, it returns the parsed URI. If parsing fails, it panics because the test setup itself is wrong: the URI is supposed to be syntactically valid, just not native.

**Call relations**: The main test calls this helper when it needs the bad-but-well-formed input. This helper hands back the `PathUri` that is then passed into `SandboxedFileSystem::read_file`, where the real behavior under test happens.

*Call graph*: calls 1 internal fn (parse); called by 1 (sandboxed_file_system_rejects_non_native_uri_as_invalid_input); 1 external calls (panic!).


### `exec-server/tests/file_stream.rs`

`test` · `test run`

These tests act like a safety checklist for the file streaming part of the exec server. The exec server can expose file contents to a client over a WebSocket connection, either as a whole file or as a stream of blocks. That is useful for large files, because the client can receive manageable pieces instead of loading everything at once. Without these tests, bugs could cause missing data, leaked open file handles, stalled reads on special operating-system objects, or too many files being opened at once.

The file starts a test exec server, connects to its file system interface, creates temporary files, and asks the server to read them. It checks normal behavior, such as splitting a file exactly into two one-megabyte chunks. It also checks edge cases: finishing a stream must free capacity for later streams; sandboxed streaming is deliberately rejected; named pipes and FIFOs are refused quickly because reading them like files can block forever; and on Unix, replacing a path while a stream is open must not change what that stream reads.

Some tests use the higher-level file system interface. Others call lower-level protocol methods directly, such as opening a file handle, reading blocks at chosen offsets, and closing the handle. Together, they verify both the user-facing behavior and the underlying protocol rules.

#### Function details

##### `stream_stops_after_an_exact_block_boundary`  (lines 40–58)

```
async fn stream_stops_after_an_exact_block_boundary() -> Result<()>
```

**Purpose**: This test proves that streaming stops cleanly when a file ends exactly at a chunk boundary. It guards against an easy off-by-one mistake where the server might send an extra empty chunk or wait for more data.

**Data flow**: It starts a test server, connects to its remote file system, creates a temporary file that is exactly two stream blocks long, and asks for a streamed read. The stream returns chunks of bytes, which the test collects and measures. The expected result is exactly two chunks, each one block in size, with nothing extra after them.

**Call relations**: This test uses the shared test server setup and the helper that turns a WebSocket URL into an ExecutorFileSystem. It then relies on the normal streaming API rather than the lower-level protocol, so it checks the behavior a real caller would see.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 4 external calls (new, assert_eq!, write, vec!).


##### `completed_streams_release_handle_capacity`  (lines 61–79)

```
async fn completed_streams_release_handle_capacity() -> Result<()>
```

**Purpose**: This test checks that finishing a streamed read frees the server-side file slot it used. Without this, repeated successful reads could slowly exhaust the per-connection open-file limit.

**Data flow**: It creates one small temporary file, then reads it as a stream more times than the configured open-file limit. Each read is fully consumed before the next begins. The output each time must be the file’s single byte chunk, showing that completed streams do not leave old handles behind.

**Call relations**: Like the other high-level streaming tests, it starts a test server and connects through connect_file_system. It indirectly exercises the server’s open and close behavior through read_file_stream, rather than calling fs_open and fs_close itself.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 3 external calls (new, assert_eq!, write).


##### `stream_rejects_platform_sandbox`  (lines 82–105)

```
async fn stream_rejects_platform_sandbox() -> Result<()>
```

**Purpose**: This test confirms that streamed file reads refuse platform sandboxing. A sandbox is a set of rules limiting what files a task may access; this feature is not supported for streaming here, so accepting it would be misleading or unsafe.

**Data flow**: It creates a temporary file and builds a read-only sandbox that permits that temporary directory. It then tries to stream the file while passing that sandbox. Instead of returning bytes, the call must fail with an 'unsupported' error and a clear message saying platform sandboxing is not supported for streaming file reads.

**Call relations**: The test uses connect_file_system for the client side and read_only_sandbox to build the sandbox context. It focuses on the high-level streaming API’s validation step before any file contents are delivered.

*Call graph*: calls 4 internal fn (exec_server, connect_file_system, read_only_sandbox, from_path); 4 external calls (new, assert_eq!, panic!, write).


##### `file_reads_reject_fifo_without_waiting_for_a_writer`  (lines 109–146)

```
async fn file_reads_reject_fifo_without_waiting_for_a_writer() -> Result<()>
```

**Purpose**: This Unix-only test makes sure the server rejects a FIFO, also called a named pipe, instead of trying to read it like a normal file. This matters because a FIFO can wait forever until another process writes to it.

**Data flow**: It creates a temporary FIFO with the operating system’s mkfifo command, converts its path into the project’s path URI form, and then tries both normal full-file reading and streamed reading. Each attempt is wrapped in a short timeout. The expected result is a quick error saying the path is not a file, not a slow hang.

**Call relations**: The test uses the usual server and file-system connection helper, then exercises both read_file and read_file_stream. It complements the Windows named-pipe test by checking the same safety rule on Unix systems.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 8 external calls (from_secs, new, bail!, assert_eq!, new, format!, panic!, timeout).


##### `file_reads_reject_named_pipes`  (lines 150–194)

```
async fn file_reads_reject_named_pipes() -> Result<()>
```

**Purpose**: This Windows-only test checks that Windows named pipes are refused by both full-file and streamed reads. Named pipes are communication channels, not regular files, and reading them as files can block or behave unpredictably.

**Data flow**: It creates two unique Windows named-pipe paths, one for the full read test and one for the stream test. It asks the remote file system to read each path, with a timeout so the test catches any hang. Both operations must fail quickly with an invalid-input error.

**Call relations**: This test follows the same safety theme as the Unix FIFO test, but uses Windows named-pipe creation. It uses connect_file_system to reach the server and checks both available file-read paths.

*Call graph*: calls 4 internal fn (exec_server, connect_file_system, new, from_path); 6 external calls (from_secs, assert_eq!, format!, panic!, new, timeout).


##### `stream_keeps_reading_the_open_file_after_path_replacement`  (lines 198–223)

```
async fn stream_keeps_reading_the_open_file_after_path_replacement() -> Result<()>
```

**Purpose**: This Unix-only test verifies that a stream continues reading the file it originally opened, even if the file path is later replaced. In everyday terms, once the server has opened a book, swapping the label on the shelf should not change the pages it is already reading.

**Data flow**: It writes a file containing one full block plus one extra byte of the letter 'a', starts a stream, and reads the first block. Then it replaces the path on disk with a different file full of the letter 'b'. The remaining stream output must still be the final 'a' byte from the original file, followed by end of stream.

**Call relations**: This test uses the high-level streaming API through connect_file_system. It checks an important operating-system behavior: the server should stream from the already-open file handle, not reopen the path for every chunk.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 6 external calls (new, assert_eq!, remove_file, rename, write, vec!).


##### `read_block_supports_non_sequential_offsets_and_lengths`  (lines 226–285)

```
async fn read_block_supports_non_sequential_offsets_and_lengths() -> Result<()>
```

**Purpose**: This test checks the lower-level file-stream protocol directly: after opening a file handle, the client can read arbitrary byte ranges, not just the next sequential block. That supports flexible clients that may request pieces in a custom order.

**Data flow**: It starts the server, connects a raw ExecServerClient over WebSocket, writes a ten-byte file, and opens it with a generated handle ID. It then asks for several ranges in a non-sequential order, using different offsets and lengths. The server returns the requested bytes and correctly marks end-of-file when a request reaches past the end. The test finally closes the handle and shuts down the server.

**Call relations**: Unlike the higher-level streaming tests, this one calls fs_open, fs_read_block, and fs_close directly. It tests the protocol layer beneath read_file_stream, proving that the building blocks used by streaming work even for out-of-order reads.

*Call graph*: calls 2 internal fn (exec_server, from_path); 7 external calls (new, new_v4, new, assert_eq!, connect_websocket, new, write).


##### `open_enforces_the_per_connection_limit_and_close_releases_capacity`  (lines 288–345)

```
async fn open_enforces_the_per_connection_limit_and_close_releases_capacity() -> Result<()>
```

**Purpose**: This test proves that one client connection cannot keep opening file reads forever, and that closing one read frees space for another. This protects the server from a client using too many file handles.

**Data flow**: It opens the same temporary file repeatedly until it reaches the configured per-connection limit. The next open request must fail with a server error explaining the limit. Then the test closes one previously opened handle and opens the file again, showing that capacity is returned after close.

**Call relations**: This test talks directly to the protocol through ExecServerClient, because it needs precise control over open handles. It checks the same resource limit that completed_streams_release_handle_capacity exercises indirectly through completed streams.

*Call graph*: calls 2 internal fn (exec_server, from_path); 8 external calls (new, new_v4, with_capacity, bail!, assert_eq!, connect_websocket, new, write).


##### `open_rejects_handle_ids_longer_than_32_bytes`  (lines 348–379)

```
async fn open_rejects_handle_ids_longer_than_32_bytes() -> Result<()>
```

**Purpose**: This test confirms that file-read handle IDs have a maximum length. A handle ID is the client-provided name for an open file read; limiting its size prevents wasteful or abusive requests.

**Data flow**: It starts the server, connects a protocol client, creates a small file, and tries to open it using a handle ID made of 33 characters. The server must reject the request with a clear error saying the handle ID must not exceed 32 bytes.

**Call relations**: This test works at the fs_open protocol level, where handle IDs are introduced. It pairs with the open-limit test by checking another rule that protects the server before a file read is accepted.

*Call graph*: calls 2 internal fn (exec_server, from_path); 6 external calls (new, bail!, assert_eq!, connect_websocket, new, write).


##### `connect_file_system`  (lines 381–384)

```
fn connect_file_system(websocket_url: &str) -> Result<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: This helper creates a test Environment connected to a given exec-server WebSocket URL and returns its file system interface. It keeps the tests short by hiding the repeated setup needed to talk to the server like a normal client.

**Data flow**: It receives a WebSocket URL string. It builds a test environment configured with that URL, asks the environment for its file system object, and returns that object wrapped in a shared pointer so async test code can use it.

**Call relations**: The high-level file reading tests call this helper right after starting a test server. It hands them an ExecutorFileSystem, which they then use for read_file or read_file_stream calls without dealing with connection setup each time.

*Call graph*: calls 1 internal fn (create_for_tests); called by 6 (completed_streams_release_handle_capacity, file_reads_reject_fifo_without_waiting_for_a_writer, file_reads_reject_named_pipes, stream_keeps_reading_the_open_file_after_path_replacement, stream_rejects_platform_sandbox, stream_stops_after_an_exact_block_boundary).


##### `read_only_sandbox`  (lines 386–396)

```
fn read_only_sandbox(path: std::path::PathBuf) -> FileSystemSandboxContext
```

**Purpose**: This helper builds a read-only file-system sandbox for one path. It is used to test that streaming rejects platform sandbox settings, even when the sandbox itself would allow reading the file.

**Data flow**: It receives a filesystem path, verifies and converts it into the project’s absolute-path type, then creates a permission profile that allows read access only to that path and uses restricted network access. The result is a FileSystemSandboxContext ready to pass into file-system calls.

**Call relations**: stream_rejects_platform_sandbox calls this helper to create the sandbox input for its negative test. The helper delegates to the project’s permission and sandbox constructors so the test uses a realistic sandbox object rather than a fake one.

*Call graph*: calls 4 internal fn (from_permission_profile, from_runtime_permissions, restricted, from_absolute_path); called by 1 (stream_rejects_platform_sandbox); 1 external calls (vec!).


### `exec-server/tests/http_client.rs`

`test` · `test execution`

The real exec-server client talks over WebSocket using JSON-RPC, which is a simple request-and-response message format encoded as JSON. These tests build a pretend exec-server so the public client can be tested without starting the full server. Think of it like testing a phone by calling a scripted actor instead of a real call center: the actor says exactly the lines needed to prove the phone behaves correctly.

The file focuses on HTTP requests sent through the exec-server client. Some requests return one complete body at once. Others return headers first, then stream the response body in small “delta” chunks. The tests make sure the client forces the right mode, creates its own safe request IDs, delivers chunks in order, ignores stale chunks from old requests, and reports errors instead of silently pretending a cut-off stream ended normally.

The helper type `ScriptedExecServer` starts a one-client fake WebSocket endpoint. The helper type `JsonRpcPeer` reads and writes JSON-RPC messages for that fake server, including the required initialize handshake. Each test provides a script for the fake server, connects a real `ExecServerClient`, then checks the messages and results from both sides.

#### Function details

##### `http_request_forces_buffered_request_params`  (lines 51–112)

```
async fn http_request_forces_buffered_request_params() -> Result<()>
```

**Purpose**: This test proves that the client’s buffered HTTP helper always sends a buffered request, even if the caller accidentally sets streaming-related fields. It protects callers from getting streaming behavior when they asked for a complete response body.

**Data flow**: The test starts a fake server, then calls `client.http_request` with parameters that include a caller-supplied stream ID and `stream_response: true`. Before sending the request over the wire, the client rewrites those fields so the fake server receives `stream_response: false`. The fake server replies with a complete body, and the test checks that the caller receives that full buffered response.

**Call relations**: This test calls `spawn_scripted_exec_server` to create the fake WebSocket server, then uses the returned server to connect a real client. Inside the server script, the peer reads the HTTP request and writes back a response. The timeout wrappers keep the test from hanging if the client fails to send or receive the expected messages.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 3 external calls (new, assert_eq!, timeout).


##### `http_response_body_stream_uses_generated_ids_and_receives_ordered_deltas`  (lines 118–274)

```
async fn http_response_body_stream_uses_generated_ids_and_receives_ordered_deltas() -> Result<()>
```

**Purpose**: This test checks that streamed HTTP response chunks are matched to the client-generated request ID, not to an unsafe ID supplied by the caller. It also checks that chunks arrive to the caller in the same order the server sent them.

**Data flow**: The caller starts a streaming HTTP request with its own request ID, but the client replaces it with `http-1` before sending it to the fake server. The fake server sends response headers, then three body chunks: `hello `, `world`, and `!`. The test reads from the returned body stream, joins the chunks, and verifies the final body is `hello world!`; then it starts a second stream and confirms the next generated ID is used.

**Call relations**: The test relies on `spawn_scripted_exec_server` for the fake endpoint. The server script uses `JsonRpcPeer::read_http_request`, `write_response`, and `write_body_delta` to act like an exec-server. The public client API under test is `http_request_stream`, which returns headers first and a separate body stream for later chunks.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 4 external calls (new, assert_eq!, timeout, vec!).


##### `http_response_body_stream_drops_queued_terminal_before_next_generated_id`  (lines 279–394)

```
async fn http_response_body_stream_drops_queued_terminal_before_next_generated_id() -> Result<()>
```

**Purpose**: This test checks a subtle cleanup case: the server sends the final end-of-body marker before the caller even receives the stream, and then the caller drops the stream without reading it. The client must still remove the old route so the next stream is not confused with the old one.

**Data flow**: The fake server receives the first streaming request as `http-1`, immediately sends a terminal body notification saying the body is done, and then sends response headers. The test receives the headers but drops the returned body stream without reading the queued terminal message. It then starts another streaming request and verifies the fake server sees a fresh generated ID, `http-2`, and the caller receives the second response normally.

**Call relations**: This test is driven through `spawn_scripted_exec_server`. The scripted peer sends an out-of-order terminal body notification and then waits for the next request. The client’s stream cleanup behavior is tested only through the public API, without directly inspecting its internal routing table.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 3 external calls (new, assert_eq!, timeout).


##### `http_response_body_stream_ignores_late_deltas_after_cancelled_request`  (lines 399–524)

```
async fn http_response_body_stream_ignores_late_deltas_after_cancelled_request() -> Result<()>
```

**Purpose**: This test proves that if a caller cancels a streaming request while it is still waiting for headers, later body chunks for that cancelled request are ignored. This prevents old data from leaking into a later request.

**Data flow**: The test starts a streaming request and waits until the fake server has seen it as `http-1`. The caller task is then aborted before headers are returned. A second streaming request is started, which the client sends as `http-2`. The fake server deliberately sends a stale body chunk for `http-1` and then a real body chunk for `http-2`; the test verifies the caller only receives the fresh `http-2` bytes.

**Call relations**: The test uses a one-shot channel, which is a single-use signal, to coordinate exactly when cancellation happens. It calls `spawn_scripted_exec_server` for the fake server and `tokio::spawn` for the cancellable client task. The fake peer then demonstrates that stale notifications no longer have a live route in the client.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 5 external calls (new, assert_eq!, channel, spawn, timeout).


##### `http_response_body_stream_ignores_late_deltas_after_drop`  (lines 529–676)

```
async fn http_response_body_stream_ignores_late_deltas_after_drop() -> Result<()>
```

**Purpose**: This test checks that dropping a returned body stream removes its route, even if the server later sends more chunks for that old stream. That keeps abandoned response data from reaching a new stream.

**Data flow**: The fake server sends headers for the first request, then waits until the test drops the first body stream. After the drop, it sends a stale body chunk for `http-1`. The test then starts a second streaming request, which uses `http-2`, and verifies the body stream contains only the fresh `http-2` data.

**Call relations**: The test uses one-shot channels to coordinate the moment the body stream is dropped and the stale delta is sent. `spawn_scripted_exec_server` supplies the scripted peer, while the client is exercised through `http_request_stream`. The story proves cleanup happens when the caller drops the stream, not only when an end marker is read.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 4 external calls (new, assert_eq!, channel, timeout).


##### `http_response_body_stream_fails_when_transport_disconnects`  (lines 681–744)

```
async fn http_response_body_stream_fails_when_transport_disconnects() -> Result<()>
```

**Purpose**: This test proves that if the shared WebSocket connection closes before a streamed body reaches its final marker, the body stream wakes up with an error. Without this, callers could wait forever.

**Data flow**: The fake server accepts a streaming request, sends response headers, and then ends its task without sending an end-of-body notification. The client receives the headers and waits for body chunks. When the transport disappears, the body stream returns an error message saying the stream failed because the exec-server transport disconnected.

**Call relations**: The fake server is created by `spawn_scripted_exec_server` and only writes the header response. The client’s body stream is then read through `recv`, and the timeout ensures the test fails quickly if the stream hangs instead of reporting the disconnect.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 3 external calls (new, assert_eq!, timeout).


##### `http_response_body_stream_reports_disconnect_when_queue_is_full`  (lines 749–836)

```
async fn http_response_body_stream_reports_disconnect_when_queue_is_full() -> Result<()>
```

**Purpose**: This test checks that a connection drop is still reported as an error even when the client’s body-chunk queue is already full. It prevents a full queue from hiding the real failure.

**Data flow**: Before returning headers, the fake server sends exactly enough body chunks to fill the client-side queue for `http-1`. It then sends headers and disconnects without a final body marker. The test drains all queued chunks and confirms the next result is a transport-disconnect error, not a clean end of stream.

**Call relations**: The test uses `spawn_scripted_exec_server` to control the exact order: fill queue, send headers, disconnect. It reads from the public body stream until the error appears. The `bail!` checks make the test fail if the client incorrectly reports a clean end.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 4 external calls (new, assert_eq!, bail!, timeout).


##### `http_response_body_stream_reports_backpressure_truncation`  (lines 841–936)

```
async fn http_response_body_stream_reports_backpressure_truncation() -> Result<()>
```

**Purpose**: This test checks that if body chunks arrive faster than the client can queue them, the stream ends with an explicit truncation error. That matters because a caller must not mistake a shortened response body for a complete one.

**Data flow**: The fake server sends more body chunks than the bounded queue can hold before the caller receives the body stream. It then sends headers but keeps the WebSocket connected so the failure is clearly caused by queue overflow, not by disconnection. The test drains whatever chunks made it through and verifies the stream ends with the specific backpressure error.

**Call relations**: The test creates the fake server with `spawn_scripted_exec_server` and uses a one-shot channel to keep the server alive until the assertion is complete. It reads the body stream through the public API and uses `bail!` if overflow is incorrectly presented as a clean end.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 5 external calls (new, assert_eq!, bail!, channel, timeout).


##### `ScriptedExecServer::connect_client`  (lines 950–957)

```
async fn connect_client(&self) -> Result<ExecServerClient>
```

**Purpose**: This helper connects a real `ExecServerClient` to the fake WebSocket server created for a test. It lets each test exercise the same public connection path that production code would use.

**Data flow**: It reads the fake server’s WebSocket URL and the fixed test client name, builds connection arguments, and passes them to `ExecServerClient::connect_websocket`. The result is either a connected client or an error explaining that the test client could not connect.

**Call relations**: Tests call this after `spawn_scripted_exec_server` returns a `ScriptedExecServer`. The helper hands control to the real client connection code, while the fake server task waits to accept that WebSocket connection and complete the initialize handshake.

*Call graph*: 2 external calls (connect_websocket, new).


##### `ScriptedExecServer::finish`  (lines 960–965)

```
async fn finish(self) -> Result<()>
```

**Purpose**: This helper waits for the fake server task to finish and reports any error from it. It is the test cleanup step that makes sure the scripted server did everything it was supposed to do.

**Data flow**: It consumes the `ScriptedExecServer`, waits for its background task to join, then unwraps both possible failure layers: the task itself failing, or the script inside the task returning an error. If all is well, it returns success.

**Call relations**: Tests call this near the end, usually after dropping the client so the WebSocket can close. It connects the test’s main task back to the fake server task and prevents hidden server-side assertion failures from being lost.


##### `spawn_scripted_exec_server`  (lines 969–993)

```
async fn spawn_scripted_exec_server(script: F) -> Result<ScriptedExecServer>
```

**Purpose**: This helper starts a fake exec-server that accepts one WebSocket client and then runs a caller-provided script. It gives tests a controlled server that can check and send exact JSON-RPC messages.

**Data flow**: It binds a local TCP listener on an automatically chosen port, builds a WebSocket URL for it, and spawns a background task. That task accepts one client, upgrades the connection to WebSocket, wraps it in `JsonRpcPeer`, completes the initialize handshake, and then runs the test’s script. The function returns a `ScriptedExecServer` containing the URL and task handle.

**Call relations**: All the test functions call this first. It is the bridge between each test’s scripted expectations and the real `ExecServerClient` connection path. Inside the spawned task it hands off message-level work to `JsonRpcPeer::complete_initialize` and then to the script supplied by the test.

*Call graph*: called by 8 (http_request_forces_buffered_request_params, http_response_body_stream_drops_queued_terminal_before_next_generated_id, http_response_body_stream_fails_when_transport_disconnects, http_response_body_stream_ignores_late_deltas_after_cancelled_request, http_response_body_stream_ignores_late_deltas_after_drop, http_response_body_stream_reports_backpressure_truncation, http_response_body_stream_reports_disconnect_when_queue_is_full, http_response_body_stream_uses_generated_ids_and_receives_ordered_deltas); 5 external calls (bind, format!, spawn, timeout, accept_async).


##### `JsonRpcPeer::complete_initialize`  (lines 1002–1021)

```
async fn complete_initialize(&mut self) -> Result<()>
```

**Purpose**: This helper performs the startup handshake expected by the exec-server protocol. It verifies that the client identifies itself correctly before any HTTP test traffic begins.

**Data flow**: It reads an `initialize` request, decodes its parameters into `InitializeParams`, and checks that the client name and resume session are correct. It sends back an initialize response with a test session ID, then waits for the client’s `initialized` notification. On success, the fake server is ready for the actual test script.

**Call relations**: This is called inside `spawn_scripted_exec_server` before the per-test script runs. It uses `read_request`, `decode_request_params`, `write_response`, and `read_notification` so later tests do not have to repeat protocol setup.

*Call graph*: calls 4 internal fn (read_notification, read_request, write_response, decode_request_params); 1 external calls (assert_eq!).


##### `JsonRpcPeer::read_http_request`  (lines 1024–1028)

```
async fn read_http_request(&mut self) -> Result<(RequestId, HttpRequestParams)>
```

**Purpose**: This helper reads one `http/request` JSON-RPC call from the client and turns its JSON parameters into the typed HTTP request data used by the tests. It lets server scripts assert exactly what the client put on the wire.

**Data flow**: It waits for a JSON-RPC request whose method is `http/request`. It then decodes the request’s `params` field into `HttpRequestParams` and returns both the JSON-RPC request ID and the typed HTTP parameters.

**Call relations**: Test scripts call this whenever they expect the client to start an HTTP request. Internally it delegates message validation to `read_request` and JSON decoding to `decode_request_params`, then hands the request ID back so the script can reply with `write_response`.

*Call graph*: calls 2 internal fn (read_request, decode_request_params).


##### `JsonRpcPeer::read_request`  (lines 1031–1043)

```
async fn read_request(&mut self, expected_method: &str) -> Result<JSONRPCRequest>
```

**Purpose**: This helper reads the next JSON-RPC message and makes sure it is a request with the expected method name. It catches protocol mistakes early with clear test errors.

**Data flow**: It receives one decoded JSON-RPC message from `read_message`. If the message is not a request, or if its method does not match the expected method, it returns an error. Otherwise it returns the request object for further decoding or response.

**Call relations**: `complete_initialize` uses this to read the startup request, and `read_http_request` uses it for HTTP calls. It sits one level above raw WebSocket reading and one level below typed request decoding.

*Call graph*: calls 1 internal fn (read_message); called by 2 (complete_initialize, read_http_request); 1 external calls (bail!).


##### `JsonRpcPeer::read_notification`  (lines 1046–1058)

```
async fn read_notification(&mut self, expected_method: &str) -> Result<JSONRPCNotification>
```

**Purpose**: This helper reads the next JSON-RPC message and makes sure it is a notification with the expected method name. A notification is a one-way message that does not expect a response.

**Data flow**: It receives one decoded message from `read_message`. If the message is not a notification, or if the notification method is not the expected one, it returns an error. If it matches, it returns the notification.

**Call relations**: `complete_initialize` calls this after sending the initialize response, because the client should then send an `initialized` notification. It relies on `read_message` for the actual WebSocket and JSON decoding work.

*Call graph*: calls 1 internal fn (read_message); called by 1 (complete_initialize); 1 external calls (bail!).


##### `JsonRpcPeer::write_response`  (lines 1061–1070)

```
async fn write_response(&mut self, id: RequestId, result: T) -> Result<()>
```

**Purpose**: This helper sends a successful JSON-RPC response to a request. Tests use it to return headers or complete HTTP responses from the fake server.

**Data flow**: It takes a JSON-RPC request ID and a serializable result value. It converts the result into JSON, wraps it in a JSON-RPC response message, and sends it over the WebSocket. The output is success if the message was written, or an error if encoding or writing failed.

**Call relations**: `complete_initialize` uses this to answer the startup request, and test scripts use it to answer `http/request` calls. It hands the final sending step to `write_message`.

*Call graph*: calls 1 internal fn (write_message); called by 1 (complete_initialize); 2 external calls (Response, to_value).


##### `JsonRpcPeer::write_body_delta`  (lines 1073–1079)

```
async fn write_body_delta(&mut self, delta: HttpRequestBodyDeltaNotification) -> Result<()>
```

**Purpose**: This helper sends one streamed HTTP body chunk as a JSON-RPC notification. Tests use it to simulate the exec-server delivering response body data over time.

**Data flow**: It takes a `HttpRequestBodyDeltaNotification`, converts it into JSON, wraps it as an `http/request/bodyDelta` notification, and writes it to the WebSocket. The function returns success or a write/encoding error.

**Call relations**: The streaming tests call this from their fake server scripts to send fresh chunks, stale chunks, terminal end markers, and overflow traffic. It uses `write_message` for the shared JSON-RPC sending behavior.

*Call graph*: calls 1 internal fn (write_message); 2 external calls (Notification, to_value).


##### `JsonRpcPeer::read_message`  (lines 1082–1094)

```
async fn read_message(&mut self) -> Result<JSONRPCMessage>
```

**Purpose**: This helper reads and decodes one JSON-RPC message from the WebSocket. It is the fake server’s low-level inbox.

**Data flow**: It waits up to the test timeout for the next WebSocket frame. If the frame is text or binary data, it parses the bytes as JSON-RPC. If the client closes the socket, sends another frame type, or the wait times out, it returns a descriptive error.

**Call relations**: `read_request` and `read_notification` both call this before checking what kind of JSON-RPC message arrived. This keeps raw WebSocket details in one place while higher helpers speak in protocol-level terms.

*Call graph*: called by 2 (read_notification, read_request); 5 external calls (next, bail!, from_slice, from_str, timeout).


##### `JsonRpcPeer::write_message`  (lines 1097–1106)

```
async fn write_message(&mut self, message: JSONRPCMessage) -> Result<()>
```

**Purpose**: This helper encodes a JSON-RPC message as text and sends it over the WebSocket. It is the fake server’s low-level outbox.

**Data flow**: It takes a `JSONRPCMessage`, serializes it into a JSON string, wraps that string as a WebSocket text message, and sends it with a timeout. It returns success when the message is written or an error if serialization, timeout, or socket writing fails.

**Call relations**: `write_response` and `write_body_delta` both call this after constructing the specific JSON-RPC message they want to send. This keeps the WebSocket writing rules consistent across all fake server replies and notifications.

*Call graph*: called by 2 (write_body_delta, write_response); 4 external calls (send, to_string, timeout, Text).


##### `decode_request_params`  (lines 1110–1119)

```
fn decode_request_params(request: &JSONRPCRequest) -> Result<T>
```

**Purpose**: This helper turns the generic JSON `params` field from a JSON-RPC request into a strongly typed Rust value. Tests use it so they can compare real protocol messages as normal HTTP or initialize structs.

**Data flow**: It reads the request’s `params` value, fails if it is missing, then deserializes that JSON into the requested type. The result is either the typed parameters or an error saying the request parameters were absent or malformed.

**Call relations**: `JsonRpcPeer::complete_initialize` uses it to decode initialize parameters, and `JsonRpcPeer::read_http_request` uses it to decode HTTP request parameters. It is the small conversion step between raw JSON-RPC messages and the test’s typed assertions.

*Call graph*: called by 2 (complete_initialize, read_http_request); 1 external calls (from_value).


### `exec-server/tests/http_request.rs`

`test` · `integration test run`

These are integration tests: they start a real exec-server, talk to it through its normal JSON-RPC interface, and set up a tiny local TCP server to pretend to be the outside HTTP service. JSON-RPC is a simple message format where a client sends named requests and gets responses or notifications back.

The tests cover the main promises of the `http/request` feature. First, if streaming is off, the exec-server should send the HTTP request, wait for the whole HTTP response body, and return status, headers, and body together. Second, if streaming is on, it should return the response headers right away, then send body pieces later as ordered `http/request/bodyDelta` notifications. This is like getting a shipping notice first, then receiving the packages one by one.

The file also tests two edge cases that could cause confusing behavior in real use: streamed request IDs must stay reserved until the stream fully ends, and optional timeouts must behave differently from short explicit timeouts. Helper functions in the file perform the JSON-RPC initialization, wait for matching responses, capture raw HTTP requests, send simple HTTP replies, and collect streamed body notifications. Without tests like these, regressions in networking, ordering, timeout behavior, or stream bookkeeping could slip through unnoticed.

#### Function details

##### `exec_server_http_request_buffers_response_body`  (lines 46–109)

```
async fn exec_server_http_request_buffers_response_body() -> anyhow::Result<()>
```

**Purpose**: This test proves that a normal, non-streaming `http/request` sends the expected HTTP request and returns the complete HTTP response body in one JSON-RPC response.

**Data flow**: It starts an exec-server and initializes it, then starts a local TCP listener acting as the HTTP peer. It sends the exec-server a POST request with a header and body, captures what arrives at the local peer, sends back a fixed HTTP response, and finally checks that the exec-server returns the response status, header, and full body.

**Call relations**: This is one of the top-level test stories. It calls `initialize_exec_server` to complete setup, `accept_http_request` to inspect the outgoing HTTP request, `respond_with_status_and_headers` to provide the fake HTTP response, and `wait_for_response` to read the JSON-RPC result from the exec-server.

*Call graph*: calls 5 internal fn (exec_server, accept_http_request, initialize_exec_server, respond_with_status_and_headers, wait_for_response); 5 external calls (bind, assert_eq!, format!, to_value, vec!).


##### `exec_server_http_request_streams_response_body_notifications`  (lines 115–198)

```
async fn exec_server_http_request_streams_response_body_notifications() -> anyhow::Result<()>
```

**Purpose**: This test proves that when response streaming is requested, the exec-server returns headers first and then sends the response body as ordered notifications.

**Data flow**: It starts and initializes the exec-server, creates a local HTTP peer, and asks for a streamed GET request. The local peer verifies the incoming request and replies using HTTP chunked transfer, meaning the body arrives in pieces. The test then checks that the first JSON-RPC event is the main response with no buffered body, and that later body-delta notifications combine into `hello world` with a final done marker.

**Call relations**: As a top-level test, it uses `initialize_exec_server` for the startup handshake, `accept_http_request` to observe the request, `respond_with_chunked_body` to force the streaming path, and `collect_response_body_deltas` to gather the later notifications.

*Call graph*: calls 5 internal fn (exec_server, accept_http_request, collect_response_body_deltas, initialize_exec_server, respond_with_chunked_body); 7 external calls (bind, bail!, assert_eq!, format!, from_value, to_value, vec!).


##### `exec_server_http_request_rejects_duplicate_stream_request_ids`  (lines 203–275)

```
async fn exec_server_http_request_rejects_duplicate_stream_request_ids() -> anyhow::Result<()>
```

**Purpose**: This test checks that two active streamed HTTP requests cannot use the same application-level request ID. That matters because streamed body notifications need an ID that clearly says which original request they belong to.

**Data flow**: It starts a streamed request with request ID `stream-dup` and keeps its HTTP response open. After the exec-server has accepted that first stream, the test sends a second streamed request with the same ID. It expects a JSON-RPC error saying the ID is already active, then lets the first stream finish and collects its body notifications.

**Call relations**: This top-level test relies on `respond_with_chunked_body_until_finish` to keep the first stream alive while the duplicate is attempted. It also uses `wait_for_response` to confirm the first request started, and `collect_response_body_deltas` after releasing the held-open stream.

*Call graph*: calls 6 internal fn (exec_server, accept_http_request, collect_response_body_deltas, initialize_exec_server, respond_with_chunked_body_until_finish, wait_for_response); 8 external calls (bind, new, bail!, assert_eq!, format!, channel, to_value, spawn).


##### `exec_server_http_request_honors_optional_timeout`  (lines 280–349)

```
async fn exec_server_http_request_honors_optional_timeout() -> anyhow::Result<()>
```

**Purpose**: This test confirms that leaving `timeoutMs` out means the request is allowed to wait, while setting a very short timeout makes the same kind of slow response fail.

**Data flow**: It first sends a request with no timeout to a local peer that waits briefly before responding, and checks that the slow body still comes back successfully. Then it sends another request with a 10 millisecond timeout while the peer delays longer, and checks that the exec-server returns an error. If the local peer sees a broken connection afterward, the test treats that as expected because the client timed out and may have closed the socket.

**Call relations**: This top-level test uses `respond_with_status_and_headers` for both delayed replies, `wait_for_response` for the successful no-timeout case, `wait_for_error_response` for the timed-out case, and `is_expected_peer_disconnect` to distinguish normal timeout fallout from a real test failure.

*Call graph*: calls 7 internal fn (exec_server, accept_http_request, initialize_exec_server, is_expected_peer_disconnect, respond_with_status_and_headers, wait_for_error_response, wait_for_response); 9 external calls (from_millis, bind, new, assert!, assert_eq!, format!, to_value, spawn, sleep).


##### `initialize_exec_server`  (lines 352–367)

```
async fn initialize_exec_server(server: &mut ExecServerHarness) -> anyhow::Result<()>
```

**Purpose**: This helper performs the startup handshake that the exec-server requires before executor methods such as `http/request` can be used.

**Data flow**: It sends an `initialize` JSON-RPC request containing a test client name, waits for the matching response, then sends an `initialized` notification. After this, the server is ready for the HTTP request tests.

**Call relations**: Every top-level test calls this near the beginning. It delegates waiting for the initialize reply to `wait_for_response`, then hands control back to the test once the server has been put into its ready state.

*Call graph*: calls 3 internal fn (send_notification, send_request, wait_for_response); called by 4 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout, exec_server_http_request_rejects_duplicate_stream_request_ids, exec_server_http_request_streams_response_body_notifications); 2 external calls (json!, to_value).


##### `wait_for_response`  (lines 370–389)

```
async fn wait_for_response(
    server: &mut ExecServerHarness,
    request_id: RequestId,
) -> anyhow::Result<T>
```

**Purpose**: This helper waits until the exec-server sends a JSON-RPC success response for one specific request ID, then turns the response data into the Rust type the caller expects.

**Data flow**: It receives a server harness and a request ID. It reads events until it finds a response with that ID, extracts the JSON result field, deserializes it into the requested type, and returns that typed value. If the matching event is not actually a response, it reports a test error.

**Call relations**: The test cases use this whenever they expect success from the exec-server. `initialize_exec_server` also uses it to wait for the initialization reply before sending the final initialized notification.

*Call graph*: calls 1 internal fn (wait_for_event); called by 4 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout, exec_server_http_request_rejects_duplicate_stream_request_ids, initialize_exec_server); 2 external calls (bail!, from_value).


##### `wait_for_error_response`  (lines 392–408)

```
async fn wait_for_error_response(
    server: &mut ExecServerHarness,
    request_id: RequestId,
) -> anyhow::Result<codex_app_server_protocol::JSONRPCErrorError>
```

**Purpose**: This helper waits until the exec-server sends a JSON-RPC error response for one specific request ID.

**Data flow**: It receives a server harness and a request ID. It reads events until it finds an error with that ID, extracts the structured error information, and returns it to the caller for checking.

**Call relations**: It is used by the timeout test, where success would be wrong. The test then inspects the returned error code and message to make sure the failure came through the expected JSON-RPC path.

*Call graph*: calls 1 internal fn (wait_for_event); called by 1 (exec_server_http_request_honors_optional_timeout); 1 external calls (bail!).


##### `accept_http_request`  (lines 411–446)

```
async fn accept_http_request(listener: &TcpListener) -> anyhow::Result<CapturedHttpRequest>
```

**Purpose**: This helper accepts one raw HTTP request from the exec-server and records what was visible on the wire: the request line, headers, and body.

**Data flow**: It waits up to five seconds for the local TCP listener to receive a connection. It reads the first HTTP line, reads headers until the blank line, uses `content-length` to know how many body bytes to read, and returns a `CapturedHttpRequest` containing the socket plus the parsed request details.

**Call relations**: The top-level tests call this after asking the exec-server to make an HTTP request. It lets the tests verify that the exec-server really sent the expected method, path, headers, and body before a helper writes the fake HTTP response back on the same stream.

*Call graph*: called by 4 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout, exec_server_http_request_rejects_duplicate_stream_request_ids, exec_server_http_request_streams_response_body_notifications); 7 external calls (new, new, from_secs, new, accept, timeout, vec!).


##### `respond_with_status_and_headers`  (lines 449–467)

```
async fn respond_with_status_and_headers(
    mut stream: TcpStream,
    status: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> anyhow::Result<()>
```

**Purpose**: This helper writes a simple fixed-length HTTP response to the captured TCP stream.

**Data flow**: It takes the open stream, a status such as `201 Created`, extra headers, and body bytes. It writes an HTTP/1.1 response with `content-length`, the provided headers, the body, and flushes the stream so the exec-server can read it.

**Call relations**: The buffered-response test uses it to send a successful response body. The timeout test uses it from delayed background tasks to simulate a slow HTTP server.

*Call graph*: called by 2 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout); 3 external calls (flush, write_all, format!).


##### `is_expected_peer_disconnect`  (lines 469–480)

```
fn is_expected_peer_disconnect(err: &anyhow::Error) -> bool
```

**Purpose**: This helper decides whether an error from the fake HTTP peer is an expected side effect of the exec-server timing out and closing the connection.

**Data flow**: It receives an error and walks through its chain of underlying causes. If any cause is an input/output error such as broken pipe, connection reset, or unexpected end of file, it returns true; otherwise it returns false.

**Call relations**: Only the timeout test calls this. After the exec-server times out, the delayed fake server may fail when trying to write its late response, and this helper prevents that normal disconnect from being treated as a test failure.

*Call graph*: called by 1 (exec_server_http_request_honors_optional_timeout); 1 external calls (chain).


##### `respond_with_chunked_body`  (lines 483–507)

```
async fn respond_with_chunked_body(
    mut stream: TcpStream,
    headers: &[(&str, &str)],
    chunks: &[&[u8]],
) -> anyhow::Result<()>
```

**Purpose**: This helper writes an HTTP response using chunked transfer encoding, which sends the body in pieces instead of declaring its full length up front.

**Data flow**: It takes a stream, headers, and a list of byte chunks. It writes HTTP response headers saying the response is chunked, then writes each chunk with its size marker, flushes as it goes, and finally writes the zero-length chunk that means the body is complete.

**Call relations**: The streaming-response test uses this to make the exec-server exercise its streamed body path. The resulting chunks are later observed through `collect_response_body_deltas` as JSON-RPC notifications.

*Call graph*: called by 1 (exec_server_http_request_streams_response_body_notifications); 3 external calls (flush, write_all, format!).


##### `respond_with_chunked_body_until_finish`  (lines 510–536)

```
async fn respond_with_chunked_body_until_finish(
    mut stream: TcpStream,
    headers: &[(&str, &str)],
    chunks: &[&[u8]],
    finish_rx: oneshot::Receiver<()>,
) -> anyhow::Result<()>
```

**Purpose**: This helper writes the start of a chunked HTTP response, then deliberately keeps the response open until the test says it may finish.

**Data flow**: It writes chunked response headers and the given chunks, then waits on a one-shot signal. Only after receiving that signal does it write the final zero-length chunk and flush the stream.

**Call relations**: The duplicate-stream-ID test uses this to keep the first streamed request active while it sends a second request with the same ID. This creates the exact situation where the exec-server should reject the duplicate.

*Call graph*: called by 1 (exec_server_http_request_rejects_duplicate_stream_request_ids); 3 external calls (flush, write_all, format!).


##### `collect_response_body_deltas`  (lines 539–560)

```
async fn collect_response_body_deltas(
    server: &mut ExecServerHarness,
    request_id: &str,
) -> anyhow::Result<Vec<HttpRequestBodyDeltaNotification>>
```

**Purpose**: This helper gathers streamed response body notifications for one request until it sees the final notification.

**Data flow**: It repeatedly reads the next JSON-RPC event from the server, checks that it is an `http/request/bodyDelta` notification, converts the JSON parameters into a typed delta object, and verifies the delta belongs to the expected request ID. It stores each delta and returns the full list when a delta says `done`.

**Call relations**: The streaming-response test uses it to check ordering, body contents, and clean completion. The duplicate-ID test uses it after allowing the held-open stream to finish, making sure the original stream still completes properly.

*Call graph*: calls 1 internal fn (next_event); called by 2 (exec_server_http_request_rejects_duplicate_stream_request_ids, exec_server_http_request_streams_response_body_notifications); 4 external calls (new, bail!, assert_eq!, from_value).


##### `response_header`  (lines 563–568)

```
fn response_header(headers: &[HttpHeader], name: &str) -> Option<String>
```

**Purpose**: This small helper finds a response header value without caring about uppercase or lowercase differences in the header name.

**Data flow**: It receives a list of HTTP headers and a name to search for. It scans the list, compares names case-insensitively, and returns a copy of the matching value if one exists.

**Call relations**: The response-checking assertions use this so the tests do not depend on exact header capitalization. That matters because HTTP header names are meant to be case-insensitive.

*Call graph*: 1 external calls (iter).


### Noise relay and remote transport
These tests move from low-level Noise framing and relay mechanics up through remote environment reconnect logic and full relayed exec-server traffic.

### `exec-server/src/noise_channel_tests.rs`

`test` · `test run`

This is a safety net for the code that creates an encrypted channel between two endpoints: an initiator, which starts the conversation, and a responder, which answers it. The channel uses a Noise protocol pattern, which is a standard way for two parties to agree on encryption keys while also proving identities. In plain terms, these tests make sure the two sides perform a secure secret handshake before they trust each other.

The tests build fresh identities, create a shared “prologue” that describes the context of the connection, and send handshake messages back and forth. The prologue acts like the label on a sealed envelope: both sides must agree what connection this is for, or the handshake must fail. After the handshake, the tests confirm that encrypted messages no longer look like the original text and that the other side can decrypt them correctly.

The file also checks important security boundaries. A responder with the wrong private key must not accept a request. A changed prologue must be rejected. Modified ciphertext must fail to decrypt. Reusing the same encrypted message must be caught. Public keys must say which cryptographic suite they belong to, and unknown suites must not be trusted. Finally, handshake payloads that are too large are refused before they can cause trouble.

#### Function details

##### `hybrid_ik_roundtrip_authenticates_both_endpoints`  (lines 13–64)

```
fn hybrid_ik_roundtrip_authenticates_both_endpoints()
```

**Purpose**: This test proves that a normal Noise channel handshake works from start to finish. It checks that both endpoints recognize each other, that the initiator’s authorization data reaches the responder, and that encrypted messages can travel both ways afterward.

**Data flow**: The test starts with two newly generated identities, shared connection context, and an authorization byte string. The initiator creates a handshake request for the responder. The responder reads it, verifies the initiator’s public key and payload, completes the handshake, and sends back a response. The initiator finishes its side, producing two transport objects that can encrypt and decrypt messages. Plain request and response text go in, ciphertext comes out, and the opposite side turns that ciphertext back into the original text.

**Call relations**: This is the main end-to-end story for the channel. It exercises the identity generation, prologue creation, initiator start, responder request reading, responder completion, initiator finish, and then the transport encryption path in both directions. If this test fails, the basic secure conversation between client and server is broken.

*Call graph*: calls 3 internal fn (start, generate, read_request); 3 external calls (assert_eq!, assert_ne!, noise_channel_prologue).


##### `initiator_rejects_wrong_responder_key`  (lines 67–84)

```
fn initiator_rejects_wrong_responder_key()
```

**Purpose**: This test checks that a handshake request made for one responder cannot be accepted by a different responder. That matters because otherwise an attacker or misrouted server could pretend to be the intended endpoint.

**Data flow**: The test creates an initiator, an expected responder, and a separate actual responder. The initiator builds a request using the expected responder’s public key. The actual responder then tries to read that request with its own private identity. The expected result is an error, because the request was not encrypted or addressed for that responder.

**Call relations**: This test focuses on the responder’s first read of the handshake request. It follows the same setup as a real connection start, but deliberately swaps the responder identity at the receiving side to confirm that the handshake code refuses the mismatch.

*Call graph*: calls 2 internal fn (start, generate); 2 external calls (assert!, noise_channel_prologue).


##### `responder_rejects_mismatched_prologue`  (lines 87–103)

```
fn responder_rejects_mismatched_prologue()
```

**Purpose**: This test checks that both sides must agree on the exact connection context before a handshake is accepted. The prologue binds the encrypted channel to a specific environment, registration, and stream, so a message for one stream cannot silently be used for another.

**Data flow**: The test creates an initiator and responder, then builds two similar but different prologues. The initiator starts the handshake using one prologue. The responder tries to read the request using the other prologue. Because the context does not match exactly, reading the request must fail.

**Call relations**: This test exercises the same initiator-start and responder-read path as a normal handshake, but with different setup labels on each side. It protects the bigger flow from accepting messages that belong to a different connection context.

*Call graph*: calls 2 internal fn (start, generate); 2 external calls (assert!, noise_channel_prologue).


##### `prologue_encoding_is_stable_and_unambiguous`  (lines 106–117)

```
fn prologue_encoding_is_stable_and_unambiguous()
```

**Purpose**: This test locks down the exact byte format used for the Noise channel prologue. A stable and unambiguous format matters because both sides must turn the same human-readable connection details into exactly the same bytes.

**Data flow**: The test gives environment, registration, and stream strings to the prologue builder. It receives a byte vector and compares it with a hard-coded expected byte sequence. The expected sequence includes length markers before each part, which prevents two different sets of strings from accidentally producing the same combined bytes.

**Call relations**: This test focuses only on the prologue-building helper. Other handshake tests rely on that helper indirectly, but this one makes the encoding contract explicit so future edits do not accidentally change the bytes used by the cryptographic handshake.

*Call graph*: 2 external calls (assert_eq!, noise_channel_prologue).


##### `transport_rejects_tampered_ciphertext`  (lines 120–146)

```
fn transport_rejects_tampered_ciphertext()
```

**Purpose**: This test checks that encrypted transport messages cannot be changed without being detected. It proves the channel gives integrity, meaning the receiver can tell if ciphertext was modified after it was sent.

**Data flow**: The test first completes a normal handshake and creates encrypted transport objects for both sides. The initiator encrypts a request message. The test then flips one bit in the ciphertext, like someone denting a sealed package in transit. When the responder tries to decrypt it, decryption must return an error instead of fake or corrupted plaintext.

**Call relations**: This test builds on the successful handshake path, then deliberately attacks the transport layer after the secure channel is established. It confirms that the decrypt step refuses modified data rather than passing it upward.

*Call graph*: calls 3 internal fn (start, generate, read_request); 2 external calls (assert!, noise_channel_prologue).


##### `transport_rejects_replayed_ciphertext`  (lines 149–183)

```
fn transport_rejects_replayed_ciphertext()
```

**Purpose**: This test checks that the same encrypted message cannot be accepted twice. That matters because replaying an old valid message can be dangerous, even if the attacker cannot read or change it.

**Data flow**: The test completes a normal handshake, then the initiator encrypts one request. The responder decrypts it once and gets the original request text. The test then sends the exact same ciphertext to the responder again. The second decrypt attempt must fail with a transport error because the channel tracks message order and does not allow reuse.

**Call relations**: This test uses the normal handshake setup and then exercises the transport receiver twice with the same input. It verifies that the secure channel is not just checking message contents, but also enforcing freshness during ongoing communication.

*Call graph*: calls 3 internal fn (start, generate, read_request); 3 external calls (assert!, assert_eq!, noise_channel_prologue).


##### `public_key_validation_rejects_unknown_suite`  (lines 186–198)

```
fn public_key_validation_rejects_unknown_suite()
```

**Purpose**: This test checks that a public key marked with an unknown cryptographic suite is not accepted for a handshake. A suite is the named set of cryptographic choices, and accepting an unknown one could make the system use a key in an unsafe or unsupported way.

**Data flow**: The test generates a valid public key, serializes it to JSON, changes its suite field to the string "unknown", and deserializes it back into a public key value. It then asks an initiator to start a handshake with that altered key. The result must be an error because the key no longer names the expected Noise channel suite.

**Call relations**: This test sits at the boundary between stored or transmitted key data and the handshake starter. It makes sure that even if JSON data can be parsed into a public key shape, the actual handshake still validates that the key belongs to the supported suite.

*Call graph*: calls 1 internal fn (generate); 5 external calls (assert!, Object, from_value, json!, to_value).


##### `public_key_serializes_with_expected_suite`  (lines 201–209)

```
fn public_key_serializes_with_expected_suite()
```

**Purpose**: This test checks that public keys include the expected suite name when converted to JSON. That makes keys self-describing when they are stored, sent over an API, or read by another part of the system.

**Data flow**: The test generates an identity, takes its public key, and serializes that key into JSON. It then reads the JSON suite field and compares it with the expected Noise channel suite constant. The output is not a returned value, but a guarantee that serialized keys carry the right label.

**Call relations**: This test complements the unknown-suite rejection test. One verifies that bad suite labels are refused; this one verifies that normal key serialization writes the correct label in the first place.

*Call graph*: calls 1 internal fn (generate); 2 external calls (assert_eq!, to_value).


##### `initiator_rejects_oversized_handshake_payload`  (lines 212–226)

```
fn initiator_rejects_oversized_handshake_payload()
```

**Purpose**: This test checks that the initiator refuses to put too much extra data into the handshake. This protects the handshake message size limit and prevents unexpectedly large messages from being created.

**Data flow**: The test generates initiator and responder identities, then creates a payload at the maximum message length. It tries to start a handshake using that payload. Instead of producing a request, the start operation must return a specific invalid-message error saying the handshake payload is too large.

**Call relations**: This test exercises the initiator’s handshake-start boundary check before any responder is involved. It confirms that oversized authorization or metadata is rejected early, before it can enter the encrypted handshake flow.

*Call graph*: calls 2 internal fn (start, generate); 2 external calls (assert!, vec!).


### `exec-server/src/noise_relay/message_framing_tests.rs`

`test` · `test suite`

The Noise relay sends JSON-RPC messages through encrypted records. A single JSON-RPC message can be larger than one record, so the production code must break it into chunks and later rebuild the original message. This test file is like a quality-control station for that process: it feeds in large and malformed messages and confirms the framing code behaves safely.

The first test builds a large JSON-RPC notification, turns it into framed bytes, then feeds those bytes into the decoder one record at a time. The decoder should patiently collect the pieces and finally return the exact original message. This proves that large messages do not get lost or corrupted just because they cross record boundaries.

The other tests check defensive behavior. One gives the decoder only a length header claiming the message is bigger than the allowed maximum. The decoder must reject it immediately, without waiting for the giant payload. Another sends a plaintext record that is larger than the maximum Noise record size. That is also rejected. Without these checks, a bad or buggy peer could make the server allocate too much memory or accept data that violates the relay’s rules.

#### Function details

##### `fragments_and_reassembles_large_jsonrpc_message`  (lines 12–29)

```
fn fragments_and_reassembles_large_jsonrpc_message()
```

**Purpose**: This test proves that a large JSON-RPC notification can be split into relay records and then reconstructed exactly. It protects against bugs where big messages are truncated, reordered, or decoded too early.

**Data flow**: It starts with a JSON-RPC notification whose parameters contain a large string. That message is passed into the framing function, producing a byte stream larger than one record. The test then feeds those bytes to a fresh decoder in record-sized chunks. At the end, the decoder should output one message, and that message must be identical to the original.

**Call relations**: This test exercises the framing function first, then the decoder that receives framed bytes. It calls on `frame_jsonrpc_message` to create the outgoing form, then repeatedly uses `JsonRpcMessageDecoder` as though encrypted records were arriving over the relay.

*Call graph*: 7 external calls (new, Notification, assert!, assert_eq!, default, json!, frame_jsonrpc_message).


##### `rejects_declared_message_length_above_limit_without_payload`  (lines 32–41)

```
fn rejects_declared_message_length_above_limit_without_payload()
```

**Purpose**: This test checks that the decoder refuses a message as soon as its declared length is above the allowed limit. The important point is that it rejects the header alone, before any oversized payload is supplied.

**Data flow**: It creates a new decoder and builds a four-byte length value that is one byte over the maximum allowed JSON-RPC message size. It feeds only that length header into the decoder. The expected result is a protocol error saying the Noise relay JSON-RPC message has an invalid length.

**Call relations**: This test goes straight to the decoder because it is checking incoming data validation. It confirms that the decoder does not wait for more bytes when the length claim is already unsafe.

*Call graph*: 2 external calls (assert!, default).


##### `rejects_oversized_plaintext_record`  (lines 44–52)

```
fn rejects_oversized_plaintext_record()
```

**Purpose**: This test checks that the decoder rejects a single plaintext record that is larger than the allowed Noise record size. This keeps the relay’s record boundary rules strict and predictable.

**Data flow**: It creates a new decoder and gives it a vector of zero bytes that is one byte longer than the maximum allowed plaintext record. Instead of trying to parse it, the decoder should return a protocol error saying the plaintext record exceeds the maximum length.

**Call relations**: This test focuses on the decoder’s first line of defense for incoming relay records. It simulates receiving an invalid record and confirms the decoder stops immediately rather than passing oversized data deeper into message parsing.

*Call graph*: 2 external calls (assert!, default).


### `exec-server/src/noise_relay/ordered_ciphertext_tests.rs`

`test` · `test run`

Encrypted relay traffic often arrives with a sequence number, sometimes called a nonce here, that says which message comes next. Network-like systems can receive pieces out of order, so the relay needs a safe waiting room: it should hold later messages until earlier ones arrive, then release everything in order. This test file checks that behavior for `OrderedCiphertextFrames`.

The tests cover three important promises. First, if message 1 arrives before message 0, nothing is released yet; once message 0 arrives, both are released as “first, then second.” Second, if the same sequence number arrives twice, the first stored copy wins. This prevents a later duplicate from silently replacing data that was already buffered. Third, the buffer must not grow without limit. If a message is too far ahead, or if the waiting data is larger than `MAX_PENDING_BYTES`, it is rejected. Without these limits, a bad or broken peer could make the server store endless data and waste memory.

In short, this file is a safety check for ordering, duplicate handling, and memory protection around encrypted relay frames.

#### Function details

##### `releases_ciphertexts_only_in_nonce_order`  (lines 7–18)

```
fn releases_ciphertexts_only_in_nonce_order()
```

**Purpose**: This test proves that encrypted frames are only released when all earlier sequence numbers have arrived. It checks the basic “wait until the missing first piece shows up” behavior.

**Data flow**: It starts with an empty `OrderedCiphertextFrames` buffer. It puts in sequence 1 with the bytes for “second,” and expects no output because sequence 0 is still missing. Then it puts in sequence 0 with the bytes for “first,” and expects the buffer to output both messages in the correct order: first, then second.

**Call relations**: During the test run, the Rust test framework calls this function. The function creates a fresh `OrderedCiphertextFrames` value with `default`, feeds it sample ciphertexts, and uses `assert_eq!` to compare the actual released frames with the expected order.

*Call graph*: 2 external calls (assert_eq!, default).


##### `ignores_duplicate_ciphertexts_without_replacing_buffered_record`  (lines 21–40)

```
fn ignores_duplicate_ciphertexts_without_replacing_buffered_record()
```

**Purpose**: This test checks that duplicate encrypted frames do not overwrite data that was already buffered. That matters because a repeated sequence number should not be allowed to change what the relay later delivers.

**Data flow**: It begins with an empty frame buffer. It stores sequence 1 as “first copy,” then tries to store sequence 1 again as “replacement”; both produce no output because sequence 0 has not arrived yet. When sequence 0 arrives as “zero,” the buffer releases “zero” followed by the original “first copy,” proving the duplicate did not replace it. A later duplicate for sequence 0 also produces no output because that sequence has already been processed.

**Call relations**: The test framework calls this function as part of the test suite. Inside, it relies on `OrderedCiphertextFrames::default` to start from a clean state, then uses repeated pushes and `assert_eq!` checks to tell the story of duplicates before and after release.

*Call graph*: 2 external calls (assert_eq!, default).


##### `rejects_unbounded_reordering`  (lines 43–52)

```
fn rejects_unbounded_reordering()
```

**Purpose**: This test confirms that the ordering buffer refuses inputs that would make it grow too far or hold too much data. It protects against memory exhaustion, where a peer could otherwise force the server to keep storing messages that cannot yet be released.

**Data flow**: It creates an empty `OrderedCiphertextFrames` buffer. First it tries to add a frame with a sequence number far ahead of the current expected one and expects an error. Then it tries to add a frame whose byte payload is larger than `MAX_PENDING_BYTES` and also expects an error. The test does not expect any successful output; it is checking rejection.

**Call relations**: The test framework runs this function with the other tests. The function creates a clean buffer with `default`, sends it deliberately unsafe inputs, and uses `assert!` to verify that `push` reports errors instead of accepting those frames.

*Call graph*: 2 external calls (assert!, default).


### `exec-server/src/noise_relay/executor_stream_tests.rs`

`test` · `test run`

This test builds a small in-memory version of the encrypted relay path used by the executor server. In the real system, messages travel through a Noise channel, which is an encrypted connection with a handshake step so both sides agree on keys before exchanging data. The test creates two identities, performs that handshake, and then starts a virtual stream that represents one logical conversation inside a larger relay connection.

The key behavior being checked is not the message content itself. Instead, the test wants to know what happens when the stream’s internal processor exits. It sends a framed JSON-RPC response through the encrypted channel, as if it came from the other side. JSON-RPC is a simple request-and-response message format often used between tools and servers.

After the stream receives and decrypts that data, the processor is expected to stop. When it does, the stream should send a `ClosedNoiseVirtualStream` notice on a small channel. That notice includes the stream id and instance id, like a coat-check ticket proving exactly which stream ended. The test waits up to one second for this notice. If it does not arrive, or if it names the wrong stream, the test fails.

#### Function details

##### `processor_exit_reports_closed_virtual_stream`  (lines 22–70)

```
async fn processor_exit_reports_closed_virtual_stream() -> Result<()>
```

**Purpose**: This asynchronous test checks that a virtual encrypted stream tells the rest of the relay when it has closed. It is used to catch regressions where a processor exits but no closure notification is sent.

**Data flow**: The test starts with freshly generated identities for the executor side and the test harness side, then uses them to perform a Noise handshake and create matching encrypted transports. It creates channels for outgoing relay traffic and closed-stream notices, starts a virtual stream with a `ConnectionProcessor`, encrypts a framed JSON-RPC response, and feeds that encrypted data into the stream. The expected output is a `ClosedNoiseVirtualStream` message received from the notification channel, carrying stream id `stream-1` and instance id `7`; the test returns success only if that happens within one second.

**Call relations**: The test calls the Noise handshake helpers to set up a realistic encrypted connection, uses `frame_jsonrpc_message` to package a JSON-RPC response the way the relay expects, and constructs the stream through `spawn_noise_virtual_stream`. It then drives the stream by calling `receive_data`; after the processor reacts to that input and exits, the test listens for the closure message that the stream is supposed to send back.

*Call graph*: calls 6 internal fn (start, generate, read_request, frame_jsonrpc_message, new, new); 6 external calls (Response, Integer, assert!, channel, current_exe, spawn_noise_virtual_stream).


### `exec-server/src/relay_noise_tests.rs`

`test` · `test suite`

The relay carries many logical streams over one WebSocket connection, a bit like several phone calls sharing one cable. Before a stream can be trusted, it performs a Noise handshake, which is a cryptographic greeting that proves both sides know the right keys. These tests check what happens when that greeting is slow, duplicated, too large, corrupted, or followed by data too early.

The file builds small in-memory-style WebSocket setups using a local TCP listener. One side plays the harness, which sends relay frames. The other side runs the real multiplexed environment code, so the tests exercise the same path used in normal operation.

A special `BlockingValidator` pretends to validate a harness key but deliberately waits forever until released. This lets the tests create “authorization is still pending” situations on purpose. They then send more handshakes or bad frames and check that the relay still behaves safely.

The important safety rule tested here is a failure budget: a limited number of failed Noise handshakes is tolerated, but repeated failures close the physical WebSocket relay. This prevents a peer from endlessly wasting server work or keeping a broken connection alive.

#### Function details

##### `BlockingValidator::validate_harness_key`  (lines 43–55)

```
fn validate_harness_key(
        &self,
        _harness_public_key: &NoiseChannelPublicKey,
        _authorization: &str,
    ) -> impl std::future::Future<Output = Result<(), ExecServerError>> + Sen
```

**Purpose**: This is a test-only validator that records that validation was requested, then waits until the test explicitly releases it. It is used to simulate a real authorization check that is slow or stuck.

**Data flow**: It receives a harness public key and authorization text, but ignores their contents. It clones shared counters and a notification handle, increments the counter, waits for the notification, and then reports success. The visible output is both the returned success result and the changed call count.

**Call relations**: The multiplexed environment calls this when a Noise handshake reaches the point where the harness key must be authorized. The tests use its shared counter to know when validation has started, and use its notification only when they want blocked validation tasks to finish.

*Call graph*: 1 external calls (clone).


##### `pending_harness_key_validation_does_not_block_new_handshakes`  (lines 59–109)

```
async fn pending_harness_key_validation_does_not_block_new_handshakes() -> Result<()>
```

**Purpose**: This test proves that one stream waiting on harness-key validation does not stop another stream from starting its own handshake. Without this, a single slow authorization check could freeze all new streams on the same relay.

**Data flow**: The test creates a local WebSocket pair, generates identities for the environment and harness, and starts the real multiplexed environment with a blocking validator. It then sends two handshake frames on two different stream IDs. It waits until the validator has been called twice, showing both handshakes were allowed to reach validation even though neither validation completed yet. Finally it closes the WebSocket and waits for the environment task to finish.

**Call relations**: The test drives the same path a harness would use: it starts Noise handshakes, wraps them in relay message frames, encodes those frames, and sends them over the WebSocket. The running environment receives those frames and calls `BlockingValidator::validate_harness_key`; the test watches the validator’s counter to confirm that the second handshake was not blocked behind the first.

*Call graph*: calls 6 internal fn (start, generate, noise_channel_prologue, encode_relay_message_frame, new, new); 16 external calls (clone, new, new, from_secs, new, bind, handshake, format!, current_exe, run_multiplexed_environment (+6 more)).


##### `duplicate_handshakes_exhaust_failure_budget`  (lines 112–206)

```
async fn duplicate_handshakes_exhaust_failure_budget() -> Result<()>
```

**Purpose**: This test checks that repeatedly sending duplicate handshakes for the same stream is treated as repeated failure, and that enough failures close the whole relay. This protects the environment from a peer that keeps retrying an invalid stream setup forever.

**Data flow**: The test opens a local WebSocket pair, starts the environment with a blocking validator, and sends a valid handshake for one stream. Once validation is pending, it sends the same encoded handshake again. For each duplicate before the final limit, it expects a reset frame for that stream, meaning the stream was rejected but the physical connection stayed open. After the configured failure budget is used up, another duplicate causes the environment task to end, meaning the physical relay was closed.

**Call relations**: The test creates Noise handshake bytes with `InitiatorHandshake::start`, turns them into relay frames, and repeatedly sends the same frame. It reads responses from the harness WebSocket, decodes them with `decode_relay_message_frame`, and checks that intermediate failures become stream resets. It relies on `BlockingValidator::validate_harness_key` to keep handshakes pending long enough to make duplicate-handshake behavior observable.

*Call graph*: calls 7 internal fn (start, generate, noise_channel_prologue, decode_relay_message_frame, encode_relay_message_frame, new, new); 18 external calls (clone, new, new, from_secs, new, bind, bail!, assert_eq!, handshake, format! (+8 more)).


##### `oversized_harness_authorization_is_rejected_before_validation`  (lines 209–262)

```
async fn oversized_harness_authorization_is_rejected_before_validation() -> Result<()>
```

**Purpose**: This test makes sure an authorization field that is larger than the allowed maximum is rejected immediately, before the expensive or external validation step runs. This is a basic resource-safety guard: oversized input should not be handed to deeper logic.

**Data flow**: The test creates a WebSocket pair and starts the environment with a blocking validator whose call count starts at zero. It builds a Noise handshake request containing authorization data that is one byte too large, sends it as a relay handshake frame, and waits for a binary reset frame in response. It then decodes the reset and checks that the validator was never called.

**Call relations**: The harness side sends a deliberately oversized handshake frame through the normal relay encoding path. The environment receives it and rejects it before calling `BlockingValidator::validate_harness_key`. The test confirms this by decoding the returned reset frame and checking the validator call counter remains zero.

*Call graph*: calls 7 internal fn (start, generate, noise_channel_prologue, decode_relay_message_frame, encode_relay_message_frame, new, new); 18 external calls (clone, new, new, from_secs, new, bind, bail!, assert_eq!, handshake, format! (+8 more)).


##### `repeated_malformed_handshakes_close_the_physical_relay`  (lines 265–309)

```
async fn repeated_malformed_handshakes_close_the_physical_relay() -> Result<()>
```

**Purpose**: This test checks that repeated corrupted Noise handshake messages eventually close the entire WebSocket relay. A malformed handshake is not just a failed stream setup; repeated malformed input is treated as abusive or broken behavior.

**Data flow**: The test starts a local harness-to-environment WebSocket connection and generates normal Noise handshake requests. For each attempt, it deliberately flips the last byte of the handshake request, making the cryptographic message invalid, then sends it on a fresh stream ID. After enough malformed handshakes to reach the configured failure limit, the environment task finishes, showing the physical relay was closed.

**Call relations**: The test uses the regular handshake builder so each message starts out realistic, then corrupts the bytes before encoding the relay frame. The multiplexed environment tries to process these frames and counts them as failed Noise handshakes. Unlike tests that expect a stream reset and continue, this one waits for `run_multiplexed_environment` to exit after the failure budget is exhausted.

*Call graph*: calls 6 internal fn (start, generate, noise_channel_prologue, encode_relay_message_frame, new, new); 14 external calls (new, new, from_secs, new, bind, handshake, format!, current_exe, run_multiplexed_environment, spawn (+4 more)).


##### `repeated_early_data_during_validation_closes_the_physical_relay`  (lines 312–358)

```
async fn repeated_early_data_during_validation_closes_the_physical_relay() -> Result<()>
```

**Purpose**: This test verifies that sending data on a stream before its handshake has finished is treated as a handshake failure, and repeated early data closes the relay. This prevents a peer from bypassing the required trust check by racing data in too soon.

**Data flow**: The test opens a local WebSocket pair and starts the environment with a validator that never releases validation. For each attempt, it sends a handshake frame for a new stream and immediately sends a data frame on that same stream with sequence number zero and one byte of payload. Because validation is still pending, that data is too early. After this happens enough times, the environment task ends, meaning the physical relay has been closed.

**Call relations**: The test sends frames in the same encoded relay format used by real harness traffic: first `RelayMessageFrame::handshake`, then `RelayMessageFrame::data`. The blocking validator keeps each handshake from completing, making the following data frame invalid at that moment. The environment counts these repeated protocol violations against the Noise handshake failure budget and eventually shuts down the relay.

*Call graph*: calls 6 internal fn (start, generate, noise_channel_prologue, encode_relay_message_frame, new, new); 16 external calls (new, new, from_secs, new, bind, data, handshake, format!, current_exe, run_multiplexed_environment (+6 more)).


### `exec-server/src/remote/noise_tests.rs`

`test` · `test run`

This is a test file for the remote server code that connects an executor to a remote “rendezvous” service using a Noise-secured channel. Noise is a cryptographic handshake protocol; in plain terms, it helps two sides prove who they are and set up an encrypted conversation.

The tests here focus on two safety concerns. First, the executor should not keep asking the environment registry for a new connection URL every time a WebSocket drops. An ordinary disconnect should reuse the existing registration, like trying the same door again after it closes. But if the rendezvous service rejects the WebSocket request with a client error such as HTTP 401, the executor should treat that URL as bad, discard the registration, and register again.

Second, the file tests validation of a “harness key,” which is used to decide whether a connecting harness is trusted. The validator must fail closed: anything other than an explicit positive answer is treated as rejection. The tests also make sure sensitive authorization text is not copied into user-visible error messages. A small fake authentication provider supplies a fixed registry token so the tests can verify that registry requests include the expected header without using real credentials.

#### Function details

##### `StaticRegistryAuthProvider::add_auth_headers`  (lines 30–35)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: This test helper adds a fixed authorization header to outgoing registry requests. It stands in for real authentication so the tests can check that the registry client sends credentials in the expected shape.

**Data flow**: It receives a mutable set of HTTP headers. It inserts an Authorization header with the value `Bearer registry-token`. The same header map then continues on to be used by the HTTP client.

**Call relations**: The registry client calls this through the `AuthProvider` interface whenever it prepares a request. In these tests, that lets the mock registry server match requests that include the expected authorization header.

*Call graph*: 2 external calls (insert, from_static).


##### `static_registry_auth_provider`  (lines 38–40)

```
fn static_registry_auth_provider() -> SharedAuthProvider
```

**Purpose**: This helper creates the shared fake authentication provider used by the tests. It avoids repeating the setup code each time a registry client or remote environment config needs credentials.

**Data flow**: It takes no input. It wraps `StaticRegistryAuthProvider` in a shared pointer so multiple pieces of code can hold and use the same provider. It returns that shared authentication provider.

**Call relations**: The three tests call this when building either a `RemoteEnvironmentConfig` or an `EnvironmentRegistryClient`. Those objects later call into `StaticRegistryAuthProvider::add_auth_headers` when sending registry requests.

*Call graph*: called by 3 (reconnect_reuses_registration_until_url_is_rejected, validate_harness_key_does_not_expose_error_body, validate_harness_key_requires_explicit_valid_response); 1 external calls (new).


##### `reconnect_reuses_registration_until_url_is_rejected`  (lines 43–93)

```
async fn reconnect_reuses_registration_until_url_is_rejected() -> Result<()>
```

**Purpose**: This test proves that the remote environment reuses an existing registry registration after a normal disconnect, but asks the registry again after the rendezvous URL is explicitly rejected. This matters because needless re-registration is wasteful, while continuing to use a rejected URL could leave the executor stuck.

**Data flow**: The test starts a local TCP listener to act like the rendezvous WebSocket server and a mock HTTP registry that expects two registration calls. It starts the remote environment task with that registry URL. The first WebSocket connection is accepted and then closed normally, so the task reconnects to the same URL without registering again. The second connection is answered with HTTP 401 Unauthorized, so the task discards that registration. On the next attempt it registers again, then connects successfully. The test verifies the registry saw exactly the expected two registration requests and then stops the background task.

**Call relations**: This test drives the full remote-environment reconnect loop. It uses `static_registry_auth_provider` to provide registry credentials, the mock registry to answer registration calls, and a local listener to play the rendezvous server. It indirectly exercises the production registration and reconnect behavior in `run_remote_environment`.

*Call graph*: calls 3 internal fn (new, static_registry_auth_provider, new); 13 external calls (from_secs, given, start, new, bind, format!, json!, current_exe, spawn, timeout (+3 more)).


##### `validate_harness_key_requires_explicit_valid_response`  (lines 96–131)

```
async fn validate_harness_key_requires_explicit_valid_response()
```

**Purpose**: This test checks that harness key validation only succeeds when the registry clearly says the key is valid. If the registry responds with `valid: false`, the executor must reject the key rather than guessing or allowing it.

**Data flow**: The test creates a fake Noise identity and takes its public key. It sets up a mock registry endpoint that expects a validation request containing the environment id, registration id, harness public key, harness key authorization value, and the fixed bearer token. The mock replies with a successful HTTP response whose JSON says `valid: false`. The validator sends the request, receives that rejection, and returns a protocol error. The test confirms the error message is the expected safe rejection message.

**Call relations**: This test builds an `EnvironmentRegistryClient` with `static_registry_auth_provider`, then places it inside `RegistryHarnessKeyValidator`. It calls `validate_harness_key` directly to check the validator’s fail-closed behavior when the registry gives a clear negative answer.

*Call graph*: calls 3 internal fn (generate, new, static_registry_auth_provider); 9 external calls (given, start, new, assert!, json!, body_partial_json, header, method, path).


##### `validate_harness_key_does_not_expose_error_body`  (lines 134–163)

```
async fn validate_harness_key_does_not_expose_error_body()
```

**Purpose**: This test makes sure secret harness authorization text is not leaked into error messages when registry validation fails. That matters because error strings often end up in logs, terminals, or monitoring systems.

**Data flow**: The test creates a fake Noise public key and configures a mock registry validation endpoint to return HTTP 500 with the sensitive harness authorization string in the response body. The validator sends the validation request and receives the server error. It returns an environment-registry HTTP error with a generic message. The test turns the error into display text and checks that the sensitive authorization string is absent.

**Call relations**: Like the other validation test, this creates an `EnvironmentRegistryClient` using `static_registry_auth_provider` and calls `RegistryHarnessKeyValidator::validate_harness_key`. Here the focus is the error path: the registry fails, and the validator must hand back a sanitized error instead of exposing the response body.

*Call graph*: calls 3 internal fn (generate, new, static_registry_auth_provider); 6 external calls (given, start, new, assert!, method, path).


### `exec-server/tests/relay.rs`

`test` · `integration test run`

This is an integration test file: it exercises several real parts of the remote execution system together, instead of testing one small function in isolation. The main idea is to pretend to be the cloud relay and registry that sit between a local client and a remote execution environment. The test starts a fake registry HTTP server, a fake WebSocket rendezvous point, and then runs the real remote environment code against them.

The most important test proves that a client can send exec-server remote procedure calls, such as “start this process” and “read this file,” through the relay and get valid replies. At the same time, the test captures the raw relay frames and checks that sensitive words like request names and the client name do not appear in the payload. In plain terms: the relay can pass envelopes back and forth, but it should not be able to read the letters inside.

The file also includes a failure-focused test. It creates a fake connection provider that always fails, then verifies that the environment asks for a fresh connection bundle on each attempt. Without that behavior, a temporary bad relay setup could get stuck forever using stale connection details.

#### Function details

##### `StaticRegistryAuthProvider::add_auth_headers`  (lines 67–72)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: This supplies the fixed authorization header that the fake registry expects. It lets the test prove that the remote environment includes registry credentials when it registers and validates itself.

**Data flow**: It receives a mutable set of HTTP headers. It adds an Authorization header containing the test bearer token. The same header set then travels with the registry request.

**Call relations**: The helper static_registry_auth_provider wraps this provider so remote_environment_routes_encrypted_exec_server_rpc can pass it into the remote environment configuration. When the remote environment contacts the fake registry, this method is the piece that puts the expected credential on those requests.

*Call graph*: 2 external calls (insert, from_static).


##### `FailingNoiseConnectProvider::connect_bundle`  (lines 80–91)

```
fn connect_bundle(
        &self,
        _: NoiseChannelPublicKey,
    ) -> BoxFuture<'_, Result<NoiseRendezvousConnectBundle, ExecServerError>>
```

**Purpose**: This is a deliberately broken Noise connection provider used to test retry behavior. Every time someone asks it for relay connection details, it records the attempt and returns a protocol error.

**Data flow**: It receives the public key for the Noise channel, but ignores it because this provider is only a test double. It increases an atomic counter, which is a thread-safe number, and returns an error saying the registry connection failed. Nothing connects successfully.

**Call relations**: noise_environment_refreshes_bundle_for_each_connection_attempt installs this provider into an environment manager. Each failed backend start calls into this provider, and the test later checks the counter to confirm that two start attempts caused two fresh bundle requests.

*Call graph*: 1 external calls (Protocol).


##### `static_registry_auth_provider`  (lines 94–96)

```
fn static_registry_auth_provider() -> codex_api::SharedAuthProvider
```

**Purpose**: This small helper creates the shared authentication provider used by the registry-related test. It keeps the setup readable by hiding the wrapping needed to share the provider safely.

**Data flow**: It takes no input. It creates a StaticRegistryAuthProvider and places it inside a shared reference-counted pointer so other parts of the test can pass it around. It returns that shared authentication provider.

**Call relations**: remote_environment_routes_encrypted_exec_server_rpc calls this while building the remote environment configuration. The returned provider is later used by the remote environment when it talks to the fake registry.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 1 external calls (new).


##### `noise_environment_refreshes_bundle_for_each_connection_attempt`  (lines 99–135)

```
async fn noise_environment_refreshes_bundle_for_each_connection_attempt() -> Result<()>
```

**Purpose**: This test checks that a Noise-backed environment does not reuse a failed relay connection setup forever. Each new process start attempt should ask for a new connection bundle.

**Data flow**: It starts with a counter at zero and an environment manager with no preloaded environments. It adds a fake Noise environment whose provider always fails, then tries to start two simple processes. Both starts return the expected protocol error, and the counter must end at two.

**Call relations**: This test drives the environment manager and backend start path directly. Its key collaborator is FailingNoiseConnectProvider::connect_bundle, which records every bundle request and returns the controlled failure that the test expects.

*Call graph*: calls 3 internal fn (without_environments, new, from_path); 9 external calls (clone, new, new, new, assert!, assert_eq!, format!, current_dir, vec!).


##### `remote_environment_routes_encrypted_exec_server_rpc`  (lines 138–250)

```
async fn remote_environment_routes_encrypted_exec_server_rpc() -> Result<()>
```

**Purpose**: This is the full end-to-end relay encryption test. It proves that a real remote environment and a real client can connect through a fake relay, run commands, transfer a large file response, and keep relay data encrypted.

**Data flow**: It creates a local TCP listener to act like the WebSocket relay and a mock HTTP registry that returns connection instructions. It starts the remote environment, accepts its WebSocket, extracts the executor public key from the registry request, and starts a client using a generated Noise identity. It then proxies frames between the client and environment, sends an exec request, reads a large file, checks the returned bytes, and finally inspects captured relay frames to make sure plaintext request details are not visible.

**Call relations**: This test is the main story in the file. It calls static_registry_auth_provider during setup, accept_websocket for both sides of the fake relay, registered_executor_public_key to learn what key the environment registered, proxy_relay_frames to shuttle messages between the two WebSockets, and assert_relay_data_is_encrypted after the real RPC calls have crossed the relay.

*Call graph*: calls 11 internal fn (generate, from, new, new, current_test_binary_helper_paths, accept_websocket, assert_relay_data_is_encrypted, proxy_relay_frames, registered_executor_public_key, static_registry_auth_provider (+1 more)); 23 external calls (clone, new, new, given, start, new, new, bind, new, new (+13 more)).


##### `accept_websocket`  (lines 252–263)

```
async fn accept_websocket(
    listener: &TcpListener,
    role: &str,
) -> Result<WebSocketStream<TcpStream>>
```

**Purpose**: This helper waits for one side of the test connection to arrive and upgrades it into a WebSocket. A WebSocket is a long-lived connection that can send messages both ways, like a phone call instead of a single letter.

**Data flow**: It receives the TCP listener for the fake relay and a human-readable role name such as environment or harness. It waits, with a timeout, for a TCP connection, then performs the WebSocket handshake. It returns the ready-to-use WebSocket stream or an error explaining which role failed to connect.

**Call relations**: remote_environment_routes_encrypted_exec_server_rpc calls this twice: first to accept the remote environment side, then to accept the harness client side. The returned streams are handed to proxy_relay_frames so the fake relay can pass messages between them.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 3 external calls (accept, timeout, accept_async).


##### `registered_executor_public_key`  (lines 265–277)

```
async fn registered_executor_public_key(registry: &MockServer) -> Result<NoiseChannelPublicKey>
```

**Purpose**: This helper pulls the executor public key out of the fake registry’s recorded registration request. The client needs this key to set up the encrypted Noise channel with the remote environment.

**Data flow**: It reads all HTTP requests captured by the mock registry, finds the registration request, parses its JSON body, and extracts the executor_public_key field. It returns that key in the strongly typed form expected by the client connection setup.

**Call relations**: remote_environment_routes_encrypted_exec_server_rpc calls this after the remote environment registers itself. The returned key is placed into the Noise rendezvous connection bundle used by the client.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 3 external calls (received_requests, from_slice, from_value).


##### `proxy_relay_frames`  (lines 279–305)

```
async fn proxy_relay_frames(
    mut environment: WebSocketStream<TcpStream>,
    mut harness: WebSocketStream<TcpStream>,
    captured_frames: Arc<Mutex<Vec<Vec<u8>>>>,
) -> Result<()>
```

**Purpose**: This is the fake relay’s message pump. It copies WebSocket messages from the environment to the harness and from the harness to the environment, while saving binary frames so the test can inspect them later.

**Data flow**: It receives two open WebSocket streams and a shared list for captured frame bytes. In a loop, it waits for a message from either side. Each received message is optionally copied into the capture list if it is binary, then forwarded to the opposite side. It finishes when either stream closes or returns an error if forwarding fails.

**Call relations**: remote_environment_routes_encrypted_exec_server_rpc starts this helper as a background task after both WebSocket sides are connected. Inside the loop it calls capture_binary_frame before forwarding, so assert_relay_data_is_encrypted later has raw relay data to examine.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 1 external calls (select!).


##### `capture_binary_frame`  (lines 307–314)

```
fn capture_binary_frame(captured_frames: &Mutex<Vec<Vec<u8>>>, message: &Message)
```

**Purpose**: This helper records the raw bytes of relay messages that are sent as binary WebSocket frames. Text or other WebSocket message types are ignored because the relay protocol data being checked is binary.

**Data flow**: It receives the shared captured-frame list and one WebSocket message. If the message is binary, it locks the list, copies the bytes, and appends them. If the lock was previously poisoned by a panic, it still recovers the inner list so the test can continue collecting evidence.

**Call relations**: proxy_relay_frames calls this for every message traveling in either direction. The bytes it saves are later read by assert_relay_data_is_encrypted to verify that relay payloads do not expose plaintext RPC details.


##### `assert_relay_data_is_encrypted`  (lines 316–337)

```
fn assert_relay_data_is_encrypted(captured_frames: &Mutex<Vec<Vec<u8>>>) -> Result<()>
```

**Purpose**: This helper checks that captured relay data frames do not contain readable request names or client identifiers. It is the test’s final privacy check: the relay may move data, but it should not understand it.

**Data flow**: It locks the shared list of captured binary frames, decodes each one as a relay message frame, and looks only at frames that carry data payloads. For each data payload, it converts the bytes to a lossy string for searching and asserts that words such as initialize, process/start, and noise-relay-test are absent. It also requires that at least several data frames were seen, so the check is meaningful.

**Call relations**: remote_environment_routes_encrypted_exec_server_rpc calls this after successful exec and file-read requests have crossed the fake relay. It relies on proxy_relay_frames and capture_binary_frame having saved the raw frames during the earlier message exchange.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 3 external calls (from_utf8_lossy, assert!, decode).


### `app-server-transport/src/transport/remote_control/segment_tests.rs`

`test` · `test run`

Remote control messages sometimes need to travel through a channel with a size limit. This file checks the safety rules around that: large server messages must be cut into small enough chunks, and chunked client messages must be rebuilt only when all the right pieces arrive. A useful analogy is mailing a large document in several envelopes: each envelope must be labeled, stale envelopes from an old mailing should be ignored, and switching to a new mailing should not let old pieces sneak back in.

The tests create small JSON-RPC messages, turn them into raw bytes, split those bytes, and feed the pieces into `ClientSegmentReassembler`, the component that rebuilds client messages. They verify three possible outcomes: `Pending` means more pieces are needed, `Forward` means a complete message is ready to continue through the system, and `Dropped` means the piece should be ignored. The file also checks server-side splitting with `split_server_envelope_for_transport`, making sure oversized server messages become multiple wire-safe chunks and each chunk stays under the maximum byte limit.

The important behavior here is defensive: incomplete streams can be invalidated, newer message assemblies must not be destroyed by old or bad chunks, and duplicate invalid chunks must not poison the current valid assembly.

#### Function details

##### `reassembles_client_message_chunks`  (lines 20–70)

```
fn reassembles_client_message_chunks()
```

**Purpose**: This test proves that a client message split into two chunks can be put back together into the original JSON-RPC message. It matters because real client messages may be too large for one transport packet, but the rest of the app should still receive one normal message.

**Data flow**: It starts with a JSON-RPC notification and serializes it into bytes. Those bytes are split in half, wrapped into two chunk-style client envelopes, and fed into a fresh reassembler. The first chunk produces a waiting state; the second produces a rebuilt envelope whose client id, stream id, sequence id, cursor, and message contents are checked against the original.

**Call relations**: During the test, it uses `chunk_envelope` to make realistic chunk packets and then asks the reassembler to observe them in order. If the reassembler returns a complete message, the test compares it with the original; if it stays pending or drops the data, the test fails because this is the happy path that must work.

*Call graph*: calls 1 internal fn (chunk_envelope); 8 external calls (Notification, new, new, default, assert!, assert_eq!, panic!, to_vec).


##### `splits_large_server_messages_into_wire_chunks`  (lines 73–105)

```
fn splits_large_server_messages_into_wire_chunks()
```

**Purpose**: This test checks that a server message larger than the transport limit is broken into multiple smaller messages before being sent. Without this, a large notification could exceed the remote-control wire limit and fail in transit.

**Data flow**: It builds a server envelope containing a deliberately large configuration warning. That envelope goes into `split_server_envelope_for_transport`, which returns a list of transport-ready envelopes. The test then confirms there is more than one segment, every segment is marked as a server message chunk, each keeps the original sequence id, and each serialized segment fits within the maximum byte size.

**Call relations**: This test exercises the outgoing side of the segmentation system. It hands a large `ServerEnvelope` to `split_server_envelope_for_transport`, then inspects the returned pieces as the transport layer would see them before sending.

*Call graph*: calls 1 internal fn (split_server_envelope_for_transport); 6 external calls (new, ConfigWarning, AppServerNotification, new, new, assert!).


##### `invalidates_incomplete_stream_assemblies`  (lines 108–144)

```
fn invalidates_incomplete_stream_assemblies()
```

**Purpose**: This test makes sure an unfinished message assembly can be canceled for a specific client stream. This is important when a stream ends or is reset, because leftover chunks from that old stream should not later create a fake complete message.

**Data flow**: It creates a two-part client message and feeds only the first chunk into the reassembler, which leaves the message pending. It then invalidates that client and stream. When the second chunk arrives afterward, the reassembler drops it instead of finishing the old message.

**Call relations**: The test follows the stream-reset path: start an assembly, call the reassembler’s stream invalidation step, then send what would have completed the message. The expected handoff is no handoff at all; the stale chunk is dropped before it can be forwarded.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `resets_incomplete_client_assembly_when_stream_changes`  (lines 147–213)

```
fn resets_incomplete_client_assembly_when_stream_changes()
```

**Purpose**: This test checks what happens when the same client starts assembling a message on one stream, then begins a newer message on another stream. The newer stream should replace the old unfinished work, so the old stream cannot complete later.

**Data flow**: It creates one serialized message and uses the first half to start an assembly on stream 1. Then it starts another assembly for the same client on stream 2 with a newer sequence id. When stream 2’s second chunk arrives, the message rebuilds successfully; when stream 1’s second chunk arrives later, it is dropped.

**Call relations**: The test uses `chunk_envelope` to create chunk packets for two streams and feeds them to the same reassembler. It demonstrates that the reassembler follows the newer stream and forwards only the replacement assembly, while rejecting the older stream’s late completion.

*Call graph*: calls 1 internal fn (chunk_envelope); 8 external calls (Notification, new, new, default, assert!, assert_eq!, panic!, to_vec).


##### `ignores_stale_chunks_without_dropping_newer_assembly`  (lines 216–263)

```
fn ignores_stale_chunks_without_dropping_newer_assembly()
```

**Purpose**: This test proves that an old chunk with a lower sequence id is ignored without damaging a newer message that is already being assembled. This protects users from out-of-order network delivery, where an old packet may arrive after a newer one has started.

**Data flow**: It starts a pending assembly for sequence id 8. Then it sends a chunk for sequence id 7, which is older and should be dropped. Finally, it sends the second chunk for sequence id 8, and the reassembler still completes and forwards the newer message.

**Call relations**: The test puts the reassembler in the middle of a valid newer assembly, then introduces a stale packet. The key relationship is that the stale observation must stop there as `Dropped`; it must not reset or corrupt the pending newer work that later becomes `Forward`.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `ignores_invalid_stale_chunks_without_dropping_newer_assembly`  (lines 266–313)

```
fn ignores_invalid_stale_chunks_without_dropping_newer_assembly()
```

**Purpose**: This test checks a stricter case: even if an old chunk is malformed or empty, it should still be ignored without harming the current newer assembly. Bad old data should not be able to knock a valid message off track.

**Data flow**: It begins assembling sequence id 8 from a valid first chunk. It then feeds an invalid empty chunk for older sequence id 7, which the reassembler drops. After that, the valid second chunk for sequence id 8 still completes the message and is forwarded.

**Call relations**: The test exercises the defensive path for stale and invalid data. The reassembler is expected to reject the old bad chunk immediately and continue holding the newer partial message until the matching final chunk arrives.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `ignores_invalid_duplicate_chunks_without_dropping_current_assembly`  (lines 316–363)

```
fn ignores_invalid_duplicate_chunks_without_dropping_current_assembly()
```

**Purpose**: This test verifies that a bad duplicate of a chunk already seen does not destroy the current assembly. That matters because duplicate packets can happen, and a corrupted repeat should not erase good data already collected.

**Data flow**: It starts assembling sequence id 8 with a valid first chunk. It then sends another chunk with the same sequence id and same segment id, but with empty invalid data, which is dropped. The proper second chunk is then accepted, and the full message is forwarded.

**Call relations**: The test focuses on duplicate handling inside the reassembler. It shows that the reassembler can reject the duplicate bad chunk while keeping the earlier valid chunk, so the next correct piece can still complete the message.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `chunk_envelope`  (lines 365–386)

```
fn chunk_envelope(
    client_id: ClientId,
    stream_id: Option<StreamId>,
    seq_id: u64,
    segment_id: usize,
    segment_count: usize,
    message_size_bytes: usize,
    chunk: &[u8],
) -> Cli
```

**Purpose**: This helper builds a realistic client envelope that contains one base64-encoded message chunk. The tests use it so they can focus on reassembly behavior instead of repeating packet-building code.

**Data flow**: It receives a client id, optional stream id, sequence id, segment number, total segment count, total message size, and raw chunk bytes. It base64-encodes the raw bytes, places the chunk metadata into a `ClientMessageChunk` event, attaches the client and stream information, and returns a `ClientEnvelope` with no cursor.

**Call relations**: The reassembly tests call this helper when they need to simulate chunks arriving from a client. It hands back envelopes shaped like transport input, which are then passed into the reassembler for observation.

*Call graph*: called by 2 (reassembles_client_message_chunks, resets_incomplete_client_assembly_when_stream_changes).


### `app-server-transport/src/transport/remote_control/tests.rs`

`test` · `test run`

Remote control is a sensitive feature because it opens a path for another service to talk to the local app server. This test file acts like a small fake remote-control backend. It listens on a local TCP port, captures HTTP requests, accepts WebSocket connections, sends fake client messages, and checks what the app server sends back.

The tests cover the full life cycle. First, the app may decide whether remote control should be enabled by reading saved preferences. If enabled, it must enroll the local server with the backend, receive a server token, and then connect with the right headers. Once connected, the backend can create “virtual clients” by sending initialize messages. The transport should then report opened connections, route JSON-RPC messages inward, and send app-server responses outward.

The file also checks failure and edge cases: missing auth, missing state storage, disabled-by-policy behavior, stale saved enrollment records, token refresh after unauthorized responses, reconnect after disconnect, and preserving or clearing buffered outgoing messages after acknowledgements. The helper functions are like stage props for the tests: they create fake auth, fake state databases, fake HTTP responses, and tools for reading and writing WebSocket frames.

#### Function details

##### `remote_control_auth_manager`  (lines 76–78)

```
fn remote_control_auth_manager() -> Arc<AuthManager>
```

**Purpose**: Creates a ready-to-use fake ChatGPT authentication manager for tests. Tests use it when they need remote control to behave as if a signed-in user is available.

**Data flow**: It starts with no input, builds dummy ChatGPT credentials, wraps them in an AuthManager, and returns a shared pointer to that manager. Nothing is written to disk.

**Call relations**: Many remote-control tests call this during setup before starting the remote-control transport. It relies on the test-support auth builder and the dummy auth constructor so the tests can focus on remote-control behavior instead of real login.

*Call graph*: calls 2 internal fn (auth_manager_from_auth, create_dummy_chatgpt_auth_for_testing); called by 12 (ephemeral_enable_preserves_durable_preference, explicit_disabled_start_ignores_persisted_enable, managed_disable_overrides_startup_and_persisted_enablement, plain_start_resolves_persisted_remote_control_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_start_allows_remote_control_invalid_url_when_disabled, remote_control_start_reports_missing_state_db_as_disabled_when_enabled, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages (+2 more)).


##### `remote_control_auth_manager_with_home`  (lines 80–85)

```
fn remote_control_auth_manager_with_home(codex_home: &TempDir) -> Arc<AuthManager>
```

**Purpose**: Creates a fake authenticated user tied to a specific temporary Codex home directory. Tests use it when the auth manager must read or cooperate with files stored under that test directory.

**Data flow**: It receives a temporary directory, creates dummy ChatGPT credentials, points the auth manager at that directory path, and returns the shared AuthManager.

**Call relations**: Persistence-heavy tests call this before starting remote control. It hands the temporary home path to the auth test helper so later enrollment and refresh logic can operate in a realistic per-home environment.

*Call graph*: calls 2 internal fn (auth_manager_from_auth_with_home, create_dummy_chatgpt_auth_for_testing); called by 6 (remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting); 1 external calls (path).


##### `remote_control_auth_dot_json`  (lines 87–125)

```
fn remote_control_auth_dot_json(account_id: Option<&str>) -> AuthDotJson
```

**Purpose**: Builds an in-memory auth.json-style record for tests, optionally including an account id. This lets tests simulate a user whose auth is present but whose account id may or may not be known yet.

**Data flow**: It receives an optional account id, creates a fake unsigned JWT-like token payload, parses that token into ChatGPT claims, and returns an AuthDotJson record containing access and refresh tokens plus the optional account id.

**Call relations**: Tests that save and reload auth files use this to switch between accounts or add a missing account id. It feeds saved auth data into AuthManager so remote control can react as if real credentials changed.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); called by 2 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_waits_for_account_id_before_enrolling); 4 external calls (now, format!, json!, to_vec).


##### `remote_control_state_runtime`  (lines 127–131)

```
async fn remote_control_state_runtime(codex_home: &TempDir) -> Arc<StateRuntime>
```

**Purpose**: Creates the test state database used to store remote-control enrollment records and preferences. Without it, tests could not check durable enablement or saved server identity behavior.

**Data flow**: It receives a temporary Codex home directory, initializes a StateRuntime under that path with a test provider name, and returns the initialized shared state runtime.

**Call relations**: Most tests call this before starting remote control or before writing saved enrollment rows. The remote-control code later reads from and writes to this same state runtime.

*Call graph*: calls 1 internal fn (init); called by 19 (ephemeral_enable_preserves_durable_preference, explicit_disabled_start_ignores_persisted_enable, managed_disable_overrides_startup_and_persisted_enablement, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, plain_start_resolves_persisted_remote_control_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404 (+9 more)); 1 external calls (path).


##### `plain_start_resolves_persisted_remote_control_preference`  (lines 134–205)

```
async fn plain_start_resolves_persisted_remote_control_preference()
```

**Purpose**: Checks how startup behaves when the desired remote-control state is unknown. It verifies that saved preferences are interpreted correctly: explicitly enabled stays enabled, while disabled, unset, or missing becomes disabled.

**Data flow**: The test creates several saved enrollment records with different preference values, starts a RemoteControlWebsocket object with an unknown desired state, asks it to resolve that state for each case, and checks the resulting desired-state watch value.

**Call relations**: The async test runner invokes this test. It uses fake auth, a temporary state runtime, URL normalization, and the test server name helper to build the same pieces that production startup would use.

*Call graph*: calls 7 internal fn (new, normalize_remote_control_url, remote_control_auth_manager, remote_control_state_runtime, test_server_name, new, new); 9 external calls (new, new, new, new, assert!, assert_eq!, format!, channel, channel).


##### `explicit_disabled_start_ignores_persisted_enable`  (lines 208–263)

```
async fn explicit_disabled_start_ignores_persisted_enable()
```

**Purpose**: Verifies that an explicit “start disabled for this run” mode wins over a saved enabled preference. This prevents the app from reconnecting just because an old setting said remote control was enabled.

**Data flow**: The test saves an enabled enrollment, starts remote control in DisabledEphemeral mode, checks that the desired state is disabled, and confirms the saved enrollment record was not changed.

**Call relations**: The test runner calls it. It prepares fake state and auth, starts remote control through the public start function, then cancels the shutdown token to stop the background task cleanly.

*Call graph*: calls 3 internal fn (normalize_remote_control_url, remote_control_auth_manager, remote_control_state_runtime); 4 external calls (new, new, assert_eq!, channel).


##### `managed_disable_overrides_startup_and_persisted_enablement`  (lines 266–362)

```
async fn managed_disable_overrides_startup_and_persisted_enablement()
```

**Purpose**: Checks that a managed policy disabling remote control overrides both startup requests and saved enablement. This matters for environments where administrators or requirements forbid the feature.

**Data flow**: The test saves an enabled enrollment, starts remote control with a disabled-by-requirements policy, then checks status, permission errors, unchanged persistence, and that no backend connection is attempted.

**Call relations**: The test runner calls it. It uses the local listener URL helper, fake auth, and state setup, then exercises the RemoteControlHandle methods that users or RPC commands would normally call.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, remote_control_auth_manager, remote_control_state_runtime, remote_control_url_for_listener); 8 external calls (new, from_millis, bind, new, assert!, assert_eq!, channel, timeout).


##### `remote_control_url_for_listener`  (lines 364–369)

```
fn remote_control_url_for_listener(listener: &TcpListener) -> String
```

**Purpose**: Builds a remote-control base URL pointing at a local test TCP listener. Tests use it so the real remote-control code connects to the fake server created inside the test.

**Data flow**: It receives a TcpListener, reads the listener’s local address, formats that address into an HTTP backend-api URL, and returns the URL string.

**Call relations**: Many tests call this immediately after binding a local listener. The returned URL is passed into remote-control startup so later helper functions can accept and inspect the resulting requests.

*Call graph*: called by 17 (managed_disable_overrides_startup_and_persisted_enablement, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_start_allows_missing_auth_when_enabled (+7 more)); 2 external calls (local_addr, format!).


##### `test_server_name`  (lines 371–373)

```
fn test_server_name() -> String
```

**Purpose**: Returns the current machine hostname in the same trimmed string form expected by remote-control status and enrollment code. Tests use it when comparing server-name fields.

**Data flow**: It reads the operating system hostname, converts it to text, trims surrounding whitespace, and returns that string.

**Call relations**: Setup helpers and status assertions call it whenever expected notifications or enrollment objects need the local server name.

*Call graph*: called by 5 (plain_start_resolves_persisted_remote_control_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_handle_with_current_enrollment, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails); 1 external calls (gethostname).


##### `remote_control_handle_with_current_enrollment`  (lines 375–418)

```
fn remote_control_handle_with_current_enrollment(
    remote_control_url: &str,
    auth_manager: Arc<AuthManager>,
) -> RemoteControlHandle
```

**Purpose**: Creates a standalone RemoteControlHandle that already has an active enrollment. This lets tests exercise handle methods without starting a full network task.

**Data flow**: It receives a remote-control URL and auth manager, creates desired-state and status watch channels, normalizes the URL, builds an enrollment with a future expiry and token, and returns a RemoteControlHandle containing those pieces.

**Call relations**: The ephemeral-enable test calls this to get a handle with realistic internal state. It uses URL normalization and the server-name helper, but does not contact a backend.

*Call graph*: calls 3 internal fn (new, normalize_remote_control_url, test_server_name); called by 1 (ephemeral_enable_preserves_durable_preference); 4 external calls (new, from_unix_timestamp, new, channel).


##### `ephemeral_enable_preserves_durable_preference`  (lines 421–456)

```
async fn ephemeral_enable_preserves_durable_preference()
```

**Purpose**: Checks that temporarily enabling remote control does not erase a saved durable preference. It also verifies that ephemeral enable from a disabled state records no durable preference.

**Data flow**: The test builds a handle, attaches a test state database, sets the desired state to durably enabled, calls ephemeral enable, and checks the preference is preserved. Then it resets to disabled, enables ephemerally again, and checks the preference is absent.

**Call relations**: The test runner calls it. It depends on the handle-construction helper, fake auth, and state runtime to focus on the RemoteControlHandle state transition.

*Call graph*: calls 3 internal fn (remote_control_auth_manager, remote_control_handle_with_current_enrollment, remote_control_state_runtime); 2 external calls (new, assert_eq!).


##### `remote_control_server_token_response`  (lines 458–469)

```
fn remote_control_server_token_response(
    server_id: &str,
    environment_id: &str,
    remote_control_token: &str,
) -> serde_json::Value
```

**Purpose**: Creates the JSON body a fake backend returns after enrollment or token refresh. It keeps repeated test responses consistent.

**Data flow**: It receives a server id, environment id, and remote-control token, combines them with a fixed far-future expiry time, and returns a JSON value.

**Call relations**: Enrollment, refresh, reconnect, and routing tests call this before responding to captured HTTP requests. The response is then sent through respond_with_json to drive the production code forward.

*Call graph*: called by 13 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages (+3 more)); 1 external calls (json!).


##### `expect_remote_control_status`  (lines 471–487)

```
async fn expect_remote_control_status(
    status_rx: &mut watch::Receiver<RemoteControlStatusChangedNotification>,
    expected_status: Option<RemoteControlConnectionStatus>,
    expected_environment
```

**Purpose**: Waits for the next remote-control status notification and checks important fields. It helps tests avoid racing ahead before the background task has reported a new state.

**Data flow**: It receives a watch receiver, an optional expected connection status, and an optional expected environment id. It waits up to five seconds for a change, reads the latest notification, and asserts the status, server name, installation id, and environment id.

**Call relations**: Connection and enrollment tests call this after accepting backend requests or WebSocket connections. It watches the status channel published by the remote-control handle.

*Call graph*: called by 9 (remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages, remote_control_transport_reconnects_after_disconnect, remote_control_transport_refreshes_server_token_after_websocket_unauthorized); 5 external calls (from_secs, assert_eq!, borrow, changed, timeout).


##### `expect_remote_control_status_snapshot`  (lines 489–515)

```
async fn expect_remote_control_status_snapshot(
    status_rx: &mut watch::Receiver<RemoteControlStatusChangedNotification>,
    expected_status: RemoteControlStatusChangedNotification,
)
```

**Purpose**: Waits until the status channel exactly matches a given notification. This is useful when several status changes may happen quickly and the test cares about one exact state.

**Data flow**: It receives a watch receiver and an expected notification. If the current value already matches, it returns; otherwise it waits for changes until the exact snapshot appears or the timeout fails.

**Call relations**: Enable/disable and generic-404 tests call this when they need to observe a precise connected, connecting, or disabled notification rather than just the next event.

*Call graph*: called by 2 (remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404); 6 external calls (from_secs, clone, assert!, borrow, changed, timeout).


##### `remote_control_transport_manages_virtual_clients_and_routes_messages`  (lines 518–812)

```
async fn remote_control_transport_manages_virtual_clients_and_routes_messages()
```

**Purpose**: Tests the core WebSocket transport behavior: remote backend clients become app-server connections, incoming JSON-RPC messages are delivered, outgoing server messages are sent back, and clients can close.

**Data flow**: The test starts remote control, accepts enrollment and WebSocket setup, sends ping and client-message envelopes from the fake backend, reads transport events from an internal channel, sends an outgoing notification through the provided writer, and checks the WebSocket JSON events.

**Call relations**: The test runner calls it as a full integration-style scenario. It uses the HTTP/WebSocket accept helpers, client-event sender, server-event reader, fake auth, fake state, and token response helper to simulate the whole backend conversation.

*Call graph*: calls 11 internal fn (new, normalize_remote_control_url, accept_http_request, accept_remote_control_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 15 external calls (new, from_secs, ConfigWarning, bind, new, Notification, Request, Integer, AppServerNotification, new (+5 more)).


##### `remote_control_transport_reconnects_after_disconnect`  (lines 815–914)

```
async fn remote_control_transport_reconnects_after_disconnect()
```

**Purpose**: Verifies that remote control reconnects after the backend WebSocket disconnects. This keeps remote control available through ordinary network drops.

**Data flow**: The test starts remote control, completes enrollment, accepts a first WebSocket and closes it, accepts a second WebSocket, sends an initialize message, and checks that a new connection-open event reaches the transport channel.

**Call relations**: The test runner invokes it. It depends on the backend-connection capture helper to inspect authorization headers across reconnects and on status waiting to confirm the reconnected environment.

*Call graph*: calls 9 internal fn (accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, send_client_event); 11 external calls (new, from_secs, bind, new, Request, Integer, new, assert_eq!, json!, panic! (+1 more)).


##### `remote_control_transport_refreshes_server_token_after_websocket_unauthorized`  (lines 917–1000)

```
async fn remote_control_transport_refreshes_server_token_after_websocket_unauthorized()
```

**Purpose**: Checks that a 401 Unauthorized response during WebSocket connection causes the server token to be refreshed before retrying. This prevents stale server tokens from permanently breaking remote control.

**Data flow**: The test enrolls with an initial token, rejects the first WebSocket HTTP upgrade with 401, captures the refresh request, returns a new token, and verifies the next WebSocket uses the refreshed token.

**Call relations**: The test runner calls it. It uses raw HTTP request capture for the failed upgrade and refresh request, then the WebSocket backend accept helper for the successful retry.

*Call graph*: calls 9 internal fn (accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, respond_with_status); 4 external calls (new, bind, new, assert_eq!).


##### `remote_control_start_allows_remote_control_invalid_url_when_disabled`  (lines 1003–1028)

```
async fn remote_control_start_allows_remote_control_invalid_url_when_disabled()
```

**Purpose**: Checks that startup does not reject an invalid or non-local remote-control URL when remote control remains disabled. This lets the app start even if a configured URL would only matter after enabling.

**Data flow**: The test starts remote control in persisted-resolution mode with no state database and an internal-looking URL, expects startup to succeed, then cancels and waits for the task to stop.

**Call relations**: The test runner calls it. It uses fake auth and the public start function, but intentionally does not create a listener because disabled startup should not make network contact.

*Call graph*: calls 1 internal fn (remote_control_auth_manager); 3 external calls (new, from_secs, timeout).


##### `remote_control_start_allows_missing_auth_when_enabled`  (lines 1031–1073)

```
async fn remote_control_start_allows_missing_auth_when_enabled()
```

**Purpose**: Verifies that remote control can start its background task before ChatGPT auth exists, but waits instead of connecting. This supports signing in after the app has already launched.

**Data flow**: The test creates an AuthManager with no saved credentials, starts remote control in enabled mode, waits briefly to confirm the fake backend receives no connection, then shuts the task down.

**Call relations**: The test runner calls it. It uses a local listener and state runtime but no fake auth helper, because the missing-auth condition is the behavior under test.

*Call graph*: calls 4 internal fn (remote_control_state_runtime, remote_control_url_for_listener, default, shared); 6 external calls (new, from_millis, from_secs, bind, new, timeout).


##### `remote_control_start_reports_missing_state_db_as_disabled_when_enabled`  (lines 1076–1132)

```
async fn remote_control_start_reports_missing_state_db_as_disabled_when_enabled()
```

**Purpose**: Checks that remote control reports itself disabled when enabled startup is requested but no SQLite-backed state database is available. This avoids a half-enabled feature that cannot safely store enrollment.

**Data flow**: The test starts remote control without state storage, checks the initial disabled status notification, confirms no backend connection occurs, tries and fails to enable ephemerally, and checks the status does not change.

**Call relations**: The test runner invokes it. It uses the listener URL helper and fake auth, then exercises both startup status and the handle’s enable path.

*Call graph*: calls 2 internal fn (remote_control_auth_manager, remote_control_url_for_listener); 6 external calls (new, from_millis, from_secs, bind, assert_eq!, timeout).


##### `remote_control_handle_enable_disable_stops_and_restarts_connections`  (lines 1135–1252)

```
async fn remote_control_handle_enable_disable_stops_and_restarts_connections()
```

**Purpose**: Tests that disabling remote control closes the active WebSocket and prevents reconnect, and enabling it again restarts connection attempts. This protects the user’s on/off control.

**Data flow**: The test starts remote control, completes enrollment and WebSocket connection, calls disable through the handle, verifies disabled status and socket closure, then calls enable and verifies a new connection is made.

**Call relations**: The test runner calls it. It combines the public handle methods with fake backend helpers and status watchers to prove state changes affect the live network task.

*Call graph*: calls 10 internal fn (accept_http_request, accept_remote_control_connection, expect_remote_control_status, expect_remote_control_status_snapshot, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, test_server_name); 7 external calls (new, from_millis, from_secs, bind, new, assert_eq!, timeout).


##### `remote_control_transport_clears_outgoing_buffer_when_backend_acks`  (lines 1255–1434)

```
async fn remote_control_transport_clears_outgoing_buffer_when_backend_acks()
```

**Purpose**: Checks that once the backend acknowledges an outgoing message, that message is not replayed after reconnect. This prevents users from receiving stale duplicate server messages.

**Data flow**: The test opens a virtual client, sends a server notification, captures its stream id, sends an acknowledgement from the fake backend, closes the client and WebSocket, reconnects, then verifies only a fresh ping response appears.

**Call relations**: The test runner invokes it. It uses the server-event reader with stream id so it can send the matching Ack envelope back through send_client_event.

*Call graph*: calls 11 internal fn (new, accept_http_request, accept_remote_control_connection, expect_remote_control_status, read_server_event_with_stream_id, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 13 external calls (new, from_secs, ConfigWarning, bind, new, Request, Integer, AppServerNotification, new, assert_eq! (+3 more)).


##### `remote_control_http_mode_enrolls_before_connecting`  (lines 1437–1661)

```
async fn remote_control_http_mode_enrolls_before_connecting()
```

**Purpose**: Tests the normal HTTP-mode startup path: enroll first, then connect the WebSocket using the server token and metadata returned by enrollment.

**Data flow**: The test starts remote control, captures the enrollment POST and verifies headers and JSON body, returns a token response, captures the WebSocket handshake headers, then sends client messages and checks outgoing server messages over the socket.

**Call relations**: The test runner calls it as a complete happy-path scenario. It uses nearly all core helpers: listener URL creation, fake auth and state, HTTP capture, JSON response, backend WebSocket capture, status waiting, client-event sending, and server-event reading.

*Call graph*: calls 10 internal fn (new, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, send_client_event); 15 external calls (new, from_secs, ConfigWarning, bind, new, Request, Integer, AppServerNotification, Response, new (+5 more)).


##### `remote_control_http_mode_refreshes_persisted_enrollment_before_connecting`  (lines 1664–1768)

```
async fn remote_control_http_mode_refreshes_persisted_enrollment_before_connecting()
```

**Purpose**: Verifies that when a saved enrollment already exists, remote control refreshes it instead of enrolling from scratch before connecting. This preserves the server identity across runs.

**Data flow**: The test saves a persisted enrollment, starts remote control, captures a refresh POST containing the saved server id and installation id, returns a refreshed token, then checks the WebSocket uses the same server id and new token.

**Call relations**: The test runner calls it. It uses the enrollment persistence functions to set up and later verify saved state, plus the fake backend helpers to drive refresh and connection.

*Call graph*: calls 9 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json); 4 external calls (new, bind, new, assert_eq!).


##### `remote_control_stdio_mode_waits_for_client_name_before_connecting`  (lines 1771–1848)

```
async fn remote_control_stdio_mode_waits_for_client_name_before_connecting()
```

**Purpose**: Checks that in stdio-style startup, remote control waits for the app-server client name before looking up and refreshing an enrollment. This avoids using the wrong saved record.

**Data flow**: The test saves an enrollment tied to a client name, starts remote control with a one-shot channel for that name, confirms no backend request happens before the name arrives, sends the name, then verifies refresh and WebSocket connection use the saved server id.

**Call relations**: The test runner invokes it. It combines the one-shot client-name channel with persisted enrollment setup and fake backend capture to test the waiting behavior.

*Call graph*: calls 9 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json); 6 external calls (new, from_millis, bind, new, assert_eq!, timeout).


##### `remote_control_waits_for_account_id_before_enrolling`  (lines 1851–1943)

```
async fn remote_control_waits_for_account_id_before_enrolling()
```

**Purpose**: Tests that remote control waits for an account id before enrolling with the backend. Auth without an account id is not enough, because enrollment records are scoped to an account.

**Data flow**: The test saves auth without an account id, starts remote control, confirms no request is made, then saves auth with an account id and reloads the auth manager. It then observes enrollment and WebSocket connection using the expected server id.

**Call relations**: The test runner calls it. It uses remote_control_auth_dot_json to switch auth file contents and relies on AuthManager reload to wake the remote-control task before its normal retry delay.

*Call graph*: calls 10 internal fn (normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_dot_json, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, default, shared); 8 external calls (new, from_millis, bind, new, assert_eq!, save_auth, gethostname, timeout).


##### `persisted_enable_does_not_follow_auth_to_an_account_without_a_preference`  (lines 1946–2064)

```
async fn persisted_enable_does_not_follow_auth_to_an_account_without_a_preference()
```

**Purpose**: Verifies that a saved enable preference for one account does not automatically enable remote control for another account. This keeps per-account privacy choices separate.

**Data flow**: The test saves auth and an enabled enrollment for account A, starts remote control and connects, then switches auth to account B and closes the socket. It waits for desired state to become disabled and checks no account B enrollment was created.

**Call relations**: The test runner invokes it. It uses auth-file generation, persisted enrollment setup, backend refresh/connection helpers, and a desired-state receiver from the remote-control handle.

*Call graph*: calls 11 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_dot_json, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, default (+1 more)); 8 external calls (new, from_millis, from_secs, bind, new, assert_eq!, save_auth, timeout).


##### `remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment`  (lines 2067–2187)

```
async fn remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment()
```

**Purpose**: Checks that if refreshing a saved enrollment returns 404, remote control treats the saved server as stale and enrolls again. This lets recovery happen when the backend no longer knows the old server id.

**Data flow**: The test saves a stale enabled enrollment, starts remote control, observes a refresh request and a status tied to the stale environment, returns 404, then captures a new enroll request, returns a new server id, and verifies connection and saved state are updated.

**Call relations**: The test runner calls it. It uses persistence setup, status waiting, HTTP status responses, token JSON responses, and backend WebSocket capture to prove the fallback path.

*Call graph*: calls 11 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 5 external calls (new, bind, new, assert_eq!, gethostname).


##### `remote_control_http_mode_reenrolls_after_explicit_missing_server_404`  (lines 2190–2334)

```
async fn remote_control_http_mode_reenrolls_after_explicit_missing_server_404()
```

**Purpose**: Tests a second stale-enrollment path: refresh succeeds, but the WebSocket upgrade returns a 404 body saying the remote app server was not found. Remote control should then enroll again.

**Data flow**: The test saves a stale enrollment, refreshes it successfully, rejects the WebSocket request with a specific missing-server 404 response, then expects a new enrollment and a successful WebSocket connection using the refreshed server id.

**Call relations**: The test runner invokes it. It uses raw HTTP capture for the failed WebSocket upgrade and the normal backend WebSocket helper for the final successful connection.

*Call graph*: calls 11 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 6 external calls (new, bind, new, assert_eq!, gethostname, json!).


##### `remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails`  (lines 2337–2437)

```
async fn remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails()
```

**Purpose**: Checks that a stale saved enrollment is not erased if attempted re-enrollment fails. This avoids losing the last known server identity during temporary backend failures.

**Data flow**: The test saves a stale enrollment, makes refresh return 404, makes re-enroll return 500, allows a retry refresh to also fail, then checks both in-memory current enrollment and persisted state still contain the stale record.

**Call relations**: The test runner calls it. It uses status-code response helpers instead of successful WebSocket helpers because the test focuses on failure preservation.

*Call graph*: calls 8 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, remote_control_auth_manager_with_home, remote_control_state_runtime, remote_control_url_for_listener, respond_with_status, test_server_name); 4 external calls (new, bind, new, assert_eq!).


##### `remote_control_http_mode_preserves_enrollment_after_generic_websocket_404`  (lines 2440–2569)

```
async fn remote_control_http_mode_preserves_enrollment_after_generic_websocket_404()
```

**Purpose**: Verifies that not every WebSocket 404 means the saved enrollment is stale. A generic 404 response should preserve the enrollment and allow later retry with the same server id.

**Data flow**: The test saves an enrollment, refreshes it successfully, rejects the first WebSocket upgrade with a generic 404 and extra headers, confirms the persisted enrollment remains, then accepts a later WebSocket connection using the same server id and token.

**Call relations**: The test runner invokes it. It uses the custom status-with-headers responder to simulate an ordinary infrastructure 404, then status snapshot waiting to confirm eventual connection.

*Call graph*: calls 13 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, expect_remote_control_status_snapshot, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener (+3 more)); 4 external calls (new, bind, new, assert_eq!).


##### `accept_remote_control_connection`  (lines 2585–2593)

```
async fn accept_remote_control_connection(listener: &TcpListener) -> WebSocketStream<TcpStream>
```

**Purpose**: Accepts a WebSocket connection from the remote-control code without inspecting the handshake details. Tests use it when they only need an open socket.

**Data flow**: It receives a TCP listener, waits up to five seconds for an incoming TCP connection, performs a WebSocket handshake, and returns the WebSocket stream.

**Call relations**: Routing and enable/disable tests call this after enrollment has completed. It hands them a WebSocket stream they can use with send_client_event and read_server_event helpers.

*Call graph*: called by 3 (remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages); 4 external calls (from_secs, accept, timeout, accept_async).


##### `accept_http_request`  (lines 2595–2640)

```
async fn accept_http_request(listener: &TcpListener) -> CapturedHttpRequest
```

**Purpose**: Accepts and parses a single plain HTTP request from the remote-control code. It lets tests inspect request lines, headers, and bodies without running a full web server.

**Data flow**: It receives a TCP listener, waits for a connection, reads the request line, reads headers into a lowercase map, reads the body based on content-length, and returns a CapturedHttpRequest containing the original stream for responding.

**Call relations**: Most enrollment, refresh, and failed-WebSocket tests call this. They inspect the captured request and then pass its stream to response helpers.

*Call graph*: called by 14 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks (+4 more)); 8 external calls (new, new, from_secs, from_utf8, new, accept, timeout, vec!).


##### `respond_with_json`  (lines 2642–2653)

```
async fn respond_with_json(mut stream: TcpStream, body: serde_json::Value)
```

**Purpose**: Writes a simple successful HTTP JSON response to a captured test connection. It is the fake backend’s normal success reply.

**Data flow**: It receives a TCP stream and JSON body, serializes the JSON to text, builds a 200 OK response with content type and length, writes it to the stream, and flushes it.

**Call relations**: Tests call this after accept_http_request captures enrollment or refresh requests. It supplies the production remote-control code with the server token data it expects.

*Call graph*: called by 13 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages (+3 more)); 4 external calls (flush, write_all, to_string, format!).


##### `respond_with_status`  (lines 2655–2657)

```
async fn respond_with_status(stream: TcpStream, status: &str, body: &str)
```

**Purpose**: Writes an HTTP response with a chosen status and body but no extra headers. Tests use it to simulate backend failures such as 401, 404, or 500.

**Data flow**: It receives a stream, status text, and body text, then delegates to respond_with_status_and_headers with an empty header list.

**Call relations**: Failure-path tests call this when they only care about the status code and body. The actual response formatting is handed off to the more general status-and-headers helper.

*Call graph*: calls 1 internal fn (respond_with_status_and_headers); called by 4 (remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_transport_refreshes_server_token_after_websocket_unauthorized).


##### `respond_with_status_and_headers`  (lines 2659–2678)

```
async fn respond_with_status_and_headers(
    mut stream: TcpStream,
    status: &str,
    headers: &[(&str, &str)],
    body: &str,
)
```

**Purpose**: Writes an HTTP response with a chosen status, optional extra headers, and body. It supports tests that need to mimic more specific backend or proxy responses.

**Data flow**: It receives a stream, status line, extra header pairs, and body text, formats them into a complete HTTP response with content length, writes it, and flushes it.

**Call relations**: respond_with_status uses this for simple failures, and the generic-WebSocket-404 test calls it directly when extra diagnostic headers matter.

*Call graph*: called by 2 (remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, respond_with_status); 3 external calls (flush, write_all, format!).


##### `accept_remote_control_backend_connection`  (lines 2680–2723)

```
async fn accept_remote_control_backend_connection(
    listener: &TcpListener,
) -> (CapturedWebSocketRequest, WebSocketStream<TcpStream>)
```

**Purpose**: Accepts a WebSocket connection and records the request path and headers used during the handshake. Tests use it when they must verify auth tokens, server ids, installation ids, or protocol headers.

**Data flow**: It waits for a TCP connection, performs a WebSocket handshake with a callback that copies the request path and headers, then returns both the captured request data and the WebSocket stream.

**Call relations**: Enrollment, refresh, reconnect, and stale-enrollment tests call this after the fake backend has replied to HTTP setup requests. It gives them both an open socket and evidence that the connection was made correctly.

*Call graph*: called by 10 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_reconnects_after_disconnect, remote_control_transport_refreshes_server_token_after_websocket_unauthorized, remote_control_waits_for_account_id_before_enrolling); 6 external calls (new, from_secs, accept, new, timeout, accept_hdr_async).


##### `send_client_event`  (lines 2725–2734)

```
async fn send_client_event(
    websocket: &mut WebSocketStream<TcpStream>,
    client_envelope: ClientEnvelope,
)
```

**Purpose**: Sends a remote-control client envelope over the fake backend WebSocket. Tests use it to imitate a remote client pinging, initializing, sending JSON-RPC, acknowledging messages, or closing.

**Data flow**: It receives a mutable WebSocket stream and a ClientEnvelope, serializes the envelope to JSON text, sends it as a WebSocket text frame, and produces no returned value.

**Call relations**: Routing, reconnect, buffer-ack, and HTTP-mode tests call this after accepting a WebSocket. The remote-control transport reads these frames as if they came from the real backend.

*Call graph*: called by 4 (remote_control_http_mode_enrolls_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages, remote_control_transport_reconnects_after_disconnect); 3 external calls (send, to_string, Text).


##### `read_server_event`  (lines 2736–2738)

```
async fn read_server_event(websocket: &mut WebSocketStream<TcpStream>) -> serde_json::Value
```

**Purpose**: Reads the next server event from the fake backend WebSocket and returns only its JSON content. It hides the stream id when the test does not need it.

**Data flow**: It receives a WebSocket stream, calls read_server_event_with_stream_id, discards the returned stream id, and returns the JSON event.

**Call relations**: Tests use this for straightforward assertions about pong and server-message events. It delegates all frame reading and ping handling to the stream-id-aware helper.

*Call graph*: calls 1 internal fn (read_server_event_with_stream_id).


##### `read_server_event_with_stream_id`  (lines 2740–2779)

```
async fn read_server_event_with_stream_id(
    websocket: &mut WebSocketStream<TcpStream>,
) -> (serde_json::Value, StreamId)
```

**Purpose**: Reads the next text event sent by the app server over WebSocket and also extracts its stream id. The stream id is needed when tests must send an acknowledgement for that exact outgoing message stream.

**Data flow**: It receives a mutable WebSocket stream, loops until a text frame arrives, replies to WebSocket pings with pongs, ignores pongs, fails on unexpected close or binary frames, parses the text as JSON, removes the stream_id field, and returns the remaining event plus the stream id.

**Call relations**: read_server_event calls this for simpler cases, and the outgoing-buffer acknowledgement test calls it directly so it can acknowledge the exact stream used by the server message.

*Call graph*: called by 2 (read_server_event, remote_control_transport_clears_outgoing_buffer_when_backend_acks); 8 external calls (from_secs, next, send, new, panic!, from_str, timeout, Pong).


### `stdio-to-uds/tests/stdio_to_uds.rs`

`test` · `test run`

This is an end-to-end test for a small bridge program. The bridge is supposed to take data from its own standard input, send that data to a Unix domain socket, then copy the socket’s reply back to its own standard output. A Unix domain socket is a local, file-path-based connection used by programs on the same machine to talk to each other.

The test builds a tiny fake server. It creates a temporary socket path, starts listening there, and waits for the bridge program to connect. It also writes the word `request` into a temporary file, then launches `codex-stdio-to-uds` with that file as the child process’s standard input. The fake server reads exactly those request bytes from the socket, writes back `response`, and records simple progress messages such as “accepted connection” and “wrote response.”

The test is careful about reliability. It avoids waiting for the socket to fully close, because that can be flaky on slower machines. It also watches the child process with a timeout, and if the child hangs, it kills it and reports the server events plus stderr. That makes failures easier to understand. At the end, the test confirms two things: the child printed `response`, and the server received `request`.

#### Function details

##### `pipes_stdin_and_stdout_through_socket`  (lines 18–157)

```
async fn pipes_stdin_and_stdout_through_socket() -> anyhow::Result<()>
```

**Purpose**: This test proves that `codex-stdio-to-uds` works as a two-way pipe between normal process input/output and a local Unix socket. It is used to catch regressions where the command stops sending stdin to the socket, stops returning the socket reply on stdout, exits with an error, or hangs.

**Data flow**: The test starts with a temporary directory, a socket path, and the bytes `request`. It writes `request` to a file so that file can become the child program’s stdin. It then starts a local socket listener and, in the background, waits for a connection, reads the expected request bytes, and writes back `response`. In parallel, it launches the real `codex-stdio-to-uds` binary pointed at that socket. The child receives the file contents as stdin and should print the socket reply to stdout. The test collects the child’s exit status, stdout, stderr, and the fake server’s progress messages. The final result is success only if the child exited cleanly, stdout equals `response`, and the server received exactly `request`.

**Call relations**: This function is the whole test scenario. It sets up the fake socket server, starts the real command-line program under test, waits for both sides to finish, and then checks the results. During setup it asks the socket library to bind to the temporary path, and during verification it uses assertions to compare the observed bytes with the expected bytes. If the child process does not finish in time, the test gathers the server’s progress messages and the child’s stderr so the failure tells a useful story instead of just timing out.

*Call graph*: calls 1 internal fn (bind); 11 external calls (Ok, assert!, assert_eq!, eprintln!, format!, channel, write, new, spawn, spawn_blocking (+1 more)).


### Sandbox policy and Linux execution
This section organizes sandbox policy-generation tests first, then the Linux sandbox helper and end-to-end sandbox execution suites that consume those policies.

### `sandboxing/src/manager_tests.rs`

`test` · `test run`

A sandbox is like a safety room for running a command: it can limit which files the command can touch and whether it can use the network. This test file makes sure the sandbox manager chooses the right kind of room and fills in the right rules before a command is launched.

The tests cover several important promises. If the user asks for full file access and there are no special network requirements, the manager should not add a sandbox unnecessarily. But if network traffic must be controlled, or if the file system is restricted, it should choose the platform’s available sandbox when possible. The file also checks how extra permissions are merged in: for example, a command may ask to enable network access or add a writable folder, but an explicit “deny this path” rule must still stay denied.

There is also a test for a managed MITM CA bundle. In plain terms, this is a certificate file used when the system routes secure network traffic through a controlled proxy. If a restricted command needs that certificate, the sandbox must make the file readable.

Linux-only tests check special behavior for Bubblewrap and seccomp-style sandboxing. They make sure unsupported WSL1 cases are rejected, and that the helper executable name is passed correctly when launching Linux sandbox helpers.

#### Function details

##### `danger_full_access_defaults_to_no_sandbox_without_network_requirements`  (lines 27–37)

```
fn danger_full_access_defaults_to_no_sandbox_without_network_requirements()
```

**Purpose**: This test confirms that when file access is fully open and there are no managed network needs, the sandbox manager does not add a sandbox. That avoids unnecessary wrapping when there is nothing to restrict.

**Data flow**: It creates a new sandbox manager, gives it an unrestricted file policy, enabled network policy, automatic sandbox preference, disabled Windows sandboxing, and says there are no managed network requirements. The manager returns its initial sandbox choice, and the test expects that choice to be no sandbox at all.

**Call relations**: This test directly exercises the manager’s initial sandbox selection path. It uses the unrestricted policy constructor and then compares the manager’s answer with the expected safe default.

*Call graph*: calls 2 internal fn (unrestricted, new); 1 external calls (assert_eq!).


##### `danger_full_access_uses_platform_sandbox_with_network_requirements`  (lines 40–52)

```
fn danger_full_access_uses_platform_sandbox_with_network_requirements()
```

**Purpose**: This test checks that even with full file access, managed network requirements can still force the system to use a sandbox. Network control may need a sandbox even when files are unrestricted.

**Data flow**: It asks the platform helper what sandbox would normally be available, then creates a manager and gives it unrestricted file access plus a flag saying managed network requirements exist. The result should match the platform sandbox if one exists, or no sandbox if the platform has none.

**Call relations**: This test ties the manager’s choice to the lower-level platform sandbox detection. It verifies that network requirements are enough reason for the selection logic to ask for platform protection.

*Call graph*: calls 2 internal fn (unrestricted, new); 2 external calls (assert_eq!, get_platform_sandbox).


##### `restricted_file_system_uses_platform_sandbox_without_managed_network`  (lines 55–72)

```
fn restricted_file_system_uses_platform_sandbox_without_managed_network()
```

**Purpose**: This test confirms that restricted file access causes the manager to choose the platform sandbox, even when there are no managed network requirements. If file rules exist, they need an enforcement mechanism.

**Data flow**: It builds a restricted file policy that allows reading from the filesystem root, asks what platform sandbox is expected, and passes that policy into the manager. The manager’s chosen sandbox is then compared with the expected platform choice.

**Call relations**: This test covers the branch where file restrictions, not network restrictions, drive sandbox selection. It depends on the restricted policy builder and platform sandbox lookup to define the expected result.

*Call graph*: calls 2 internal fn (restricted, new); 3 external calls (assert_eq!, get_platform_sandbox, vec!).


##### `transform_preserves_unrestricted_file_system_policy_for_restricted_network`  (lines 75–114)

```
fn transform_preserves_unrestricted_file_system_policy_for_restricted_network()
```

**Purpose**: This test makes sure that restricting the network does not accidentally restrict the file system. The command should keep its full file access while still carrying the restricted network rule.

**Data flow**: It reads the current working directory, turns it into a path URI, builds permissions from an unrestricted file policy and restricted network policy, and asks the manager to transform a simple command into an execution request. The resulting request should keep the same working directory, the same sandbox-policy directory, unrestricted file access, and restricted network access.

**Call relations**: This test exercises the manager’s transform step, where user-facing permissions become the internal request used to run a command. It proves that file and network rules stay separate rather than one silently changing the other.

*Call graph*: calls 5 internal fn (from_runtime_permissions, unrestricted, new, current_dir, from_abs_path); 3 external calls (new, new, assert_eq!).


##### `transform_additional_permissions_enable_network_for_external_sandbox`  (lines 117–168)

```
fn transform_additional_permissions_enable_network_for_external_sandbox()
```

**Purpose**: This test checks that extra permissions attached to a command can enable network access for an external sandbox profile. It verifies that a per-command request can loosen the network setting in the transformed execution request.

**Data flow**: It creates an external permission profile with restricted network access, prepares a temporary folder as an additional writable filesystem permission, and adds an extra permission request that turns network access on. After transformation, the execution request should show an external profile with network enabled and a runtime network policy that is also enabled.

**Call relations**: This test focuses on how `SandboxManager::transform` merges command-specific additional permissions into a broader external permission profile. It checks the path where the transform step upgrades the network policy before handing off the final request.

*Call graph*: calls 5 internal fn (from_read_write_roots, new, current_dir, from_absolute_path, from_abs_path); 6 external calls (new, new, new, assert_eq!, canonicalize, vec!).


##### `transform_additional_permissions_preserves_denied_entries`  (lines 171–250)

```
fn transform_additional_permissions_preserves_denied_entries()
```

**Purpose**: This test makes sure that extra allowed paths do not erase existing denied paths. A deny rule is a hard boundary, and adding a new writable folder must not weaken it.

**Data flow**: It creates a temporary workspace, defines one path as denied and another as newly allowed, and starts with a restricted policy that allows root reads but denies the denied path. It then transforms a command that asks for write access to the allowed path. The resulting file policy should contain the original read rule, the original deny rule, and the new write rule, while the network policy remains restricted.

**Call relations**: This test exercises the permission-merging part of the transform flow. It ensures that when additional filesystem permissions are appended, the manager preserves earlier safety rules instead of replacing the whole policy.

*Call graph*: calls 7 internal fn (from_read_write_roots, from_runtime_permissions, restricted, new, current_dir, from_absolute_path, from_abs_path); 7 external calls (default, new, new, new, assert_eq!, canonicalize, vec!).


##### `managed_mitm_ca_bundle_becomes_readable_for_restricted_sandbox`  (lines 253–292)

```
fn managed_mitm_ca_bundle_becomes_readable_for_restricted_sandbox()
```

**Purpose**: This test checks that a managed certificate bundle is added as a readable file when a sandbox is restricted. Without this, a sandboxed command might be unable to trust the controlled network proxy it is expected to use.

**Data flow**: It creates temporary directories for a working directory and a managed certificate bundle path, builds a restricted permission profile that can read only the working directory, and passes that profile through the helper that adds certificate access. The resulting file policy should include both the original readable working directory and the readable certificate bundle path.

**Call relations**: This test targets the helper that adjusts permission profiles before execution. It shows how network-related setup feeds back into filesystem permissions by making the required certificate file visible inside the sandbox.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, from_absolute_path); 5 external calls (new, assert_eq!, canonicalize, with_managed_mitm_ca_readable_root, vec!).


##### `transform_linux_seccomp_request`  (lines 295–322)

```
fn transform_linux_seccomp_request(
    codex_linux_sandbox_exe: &std::path::Path,
) -> super::SandboxExecRequest
```

**Purpose**: This Linux-only helper builds a sandbox execution request for the Linux seccomp sandbox path. Seccomp is a Linux feature that limits which system calls a process can make, like blocking certain low-level actions.

**Data flow**: It takes the path to a Linux sandbox helper executable, creates a manager, reads the current directory, wraps that directory as a URI, and builds a basic command with disabled permissions but an explicit Linux seccomp sandbox type. It returns the transformed execution request produced by the manager.

**Call relations**: This is not itself a test assertion; it is shared setup for two Linux-only tests. Those tests call it with different helper paths so they can inspect how the transform step fills in the request’s `arg0` value.

*Call graph*: calls 3 internal fn (new, current_dir, from_abs_path); called by 2 (transform_linux_seccomp_preserves_helper_path_in_arg0_when_available, transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path); 2 external calls (new, new).


##### `wsl1_rejects_linux_bubblewrap_path`  (lines 326–361)

```
fn wsl1_rejects_linux_bubblewrap_path()
```

**Purpose**: This Linux-only test confirms that Bubblewrap-based sandboxing is rejected on WSL1 when the requested setup would need Bubblewrap. WSL1 is the older Windows Subsystem for Linux environment, and it lacks support for some Linux sandbox features.

**Data flow**: It creates a restricted file policy, then calls the Bubblewrap support check in several WSL1 scenarios: restricted filesystem access, proxy-related network allowance, and legacy Landlock mode combined with proxy allowance. Each case should return the specific error saying Bubblewrap is unsupported on WSL1.

**Call relations**: This test directly exercises the Linux support-checking function before command transformation proceeds. It verifies that unsupported WSL1 configurations fail early with the expected error instead of reaching a launcher that cannot work.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert!, vec!).


##### `wsl1_allows_non_bubblewrap_linux_paths`  (lines 365–391)

```
fn wsl1_allows_non_bubblewrap_linux_paths()
```

**Purpose**: This Linux-only test confirms that WSL1 is allowed when the requested setup does not require Bubblewrap. The system should reject only the unsupported sandbox path, not every Linux sandbox-related case.

**Data flow**: It first checks an unrestricted policy with no proxy network allowance and expects success. Then it creates a restricted policy but enables the legacy Landlock path without proxy network allowance, and expects that to succeed too.

**Call relations**: This test complements the WSL1 rejection test. Together they define the boundary: the support check should block Bubblewrap-dependent cases, while letting non-Bubblewrap paths continue.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert!, vec!).


##### `transform_linux_seccomp_preserves_helper_path_in_arg0_when_available`  (lines 395–403)

```
fn transform_linux_seccomp_preserves_helper_path_in_arg0_when_available()
```

**Purpose**: This Linux-only test checks that when the launcher path already points to the `codex-linux-sandbox` helper, the transformed request keeps that full helper path as `arg0`. `arg0` is the name or path a program sees as how it was launched.

**Data flow**: It supplies `/tmp/codex-linux-sandbox` as the helper path, builds a seccomp execution request through the shared helper, and then checks that the request’s `arg0` is the same full path as a string.

**Call relations**: This test calls `transform_linux_seccomp_request` to reuse the common setup for a Linux seccomp transform. It then inspects the output to ensure the transform step preserves a usable helper path when it can.

*Call graph*: calls 1 internal fn (transform_linux_seccomp_request); 2 external calls (assert_eq!, from).


##### `transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path`  (lines 407–412)

```
fn transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path()
```

**Purpose**: This Linux-only test checks the fallback behavior when the launcher path is not itself the Linux sandbox helper. In that case, the transformed request should use the helper’s command name as an alias.

**Data flow**: It supplies `/tmp/codex` as the launcher path, builds a seccomp execution request through the shared helper, and then checks that the request’s `arg0` is `codex-linux-sandbox` rather than the unrelated launcher path.

**Call relations**: This test also calls `transform_linux_seccomp_request`, but with a different input path. Paired with the previous test, it verifies both sides of the `arg0` decision made during Linux seccomp request transformation.

*Call graph*: calls 1 internal fn (transform_linux_seccomp_request); 2 external calls (assert_eq!, from).


### `sandboxing/src/landlock_tests.rs`

`test` · `test suite`

This is a small test file for the sandboxing code. The sandbox launcher builds a list of command-line arguments for a Linux isolation tool, and these tests check that the right safety switches appear in that list. Landlock is a Linux security feature that can restrict what files a process may access. There is also a newer proxy-network mode, which allows network access through a controlled path. These options must not be mixed incorrectly, because the final argument list is what decides how locked down the child process really is.

The tests use a harmless command, `/bin/true`, as a stand-in for any program that might be run inside the sandbox. They then ask the sandbox argument-building functions to produce arguments under different settings and check the result. One test makes sure the older Landlock flag is only included when explicitly requested. Another confirms that proxy-network mode wins over legacy Landlock when both are requested, so the command line does not contain conflicting choices. A third test checks that a permission profile and command working directory are actually written into the argument list. The final test checks a small rule: proxy networking is only allowed when the system is enforcing managed network requirements.

#### Function details

##### `legacy_landlock_flag_is_included_when_requested`  (lines 5–33)

```
fn legacy_landlock_flag_is_included_when_requested()
```

**Purpose**: This test checks that the sandbox argument builder includes the `--use-legacy-landlock` flag only when that option is turned on. It helps ensure the sandbox does not silently use the older Landlock mode unless the caller asked for it.

**Data flow**: It starts with a simple command and two paths: the command's requested working directory and the real current directory. It builds sandbox arguments once with legacy Landlock turned off and verifies the flag is absent, then builds them again with legacy Landlock turned on and verifies the flag is present. Nothing outside the test is changed.

**Call relations**: During the test run, this function exercises the normal Linux sandbox argument builder directly. It uses the produced argument list as evidence that the builder is respecting the caller's Landlock setting.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `proxy_flag_takes_precedence_over_legacy_landlock`  (lines 36–55)

```
fn proxy_flag_takes_precedence_over_legacy_landlock()
```

**Purpose**: This test checks what happens when both legacy Landlock and proxy networking are requested. It confirms that proxy networking takes priority, so the generated command uses the proxy-network flag and leaves out the legacy Landlock flag.

**Data flow**: It creates a read-only permission profile, a simple command, and path inputs. It asks the permission-profile-aware sandbox argument builder to create the command line with both legacy Landlock and proxy networking requested. The resulting list is checked to make sure it contains `--allow-network-for-proxy` and does not contain `--use-legacy-landlock`.

**Call relations**: This function tests the higher-level argument-building path that includes a permission profile. It captures an important ordering rule: when the builder has to choose between these two modes, it hands off the final command line with proxy networking selected.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (new, assert_eq!, vec!).


##### `permission_profile_flag_is_included`  (lines 58–83)

```
fn permission_profile_flag_is_included()
```

**Purpose**: This test makes sure the sandbox command line includes a permission profile and the command's working directory. These values matter because they tell the sandbox what the program may access and where it should start running.

**Data flow**: It creates a read-only permission profile, a sample command, and path inputs. It builds sandbox arguments with legacy Landlock enabled and proxy networking disabled. Then it scans neighboring argument pairs to confirm that `--permission-profile` is followed by some non-empty value, and that `--command-cwd` is followed by `/tmp/link`.

**Call relations**: This function checks the argument builder used when a permission profile is supplied. It verifies that the builder does not forget to pass along two pieces of information the sandbox runner needs later: the access rules and the command working directory.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (new, assert_eq!, vec!).


##### `proxy_network_requires_managed_requirements`  (lines 86–95)

```
fn proxy_network_requires_managed_requirements()
```

**Purpose**: This test checks the rule for whether proxy networking is allowed. In plain terms, proxy networking should only be enabled when managed network enforcement is active.

**Data flow**: It calls the proxy-network decision helper with managed network enforcement turned off and expects `false`. It calls the same helper with enforcement turned on and expects `true`. The test only reads the helper's return values and changes no external state.

**Call relations**: This function tests the small decision point that other sandbox setup code relies on before adding proxy-network behavior. It confirms that the later command-building flow can only enable proxy networking when the required network controls are in place.

*Call graph*: 1 external calls (assert_eq!).


### `sandboxing/src/seatbelt_tests.rs`

`test` · `test run`

macOS Seatbelt is the system sandbox tool used here to run a command with limited access. This test file is the safety checklist for the code that generates those sandbox rules. Without these tests, a small policy mistake could either break normal tools, such as Node.js or TLS certificate checks, or accidentally let a command write to dangerous places like `.git` hooks or `.codex/config.toml`.

The tests build sandbox policies, turn them into Seatbelt command-line arguments, and inspect the generated policy text. Some tests go further and actually run `sandbox-exec` against temporary folders to prove that forbidden writes fail and allowed writes still work. The file covers several important cases: read and write roots with explicit deny carve-outs, unreadable glob patterns, proxy-only networking, local binding, Unix domain sockets, and special protection for repository metadata.

A recurring idea is “allow the room, lock the filing cabinet.” A workspace may be writable, but sensitive subfolders such as `.git`, `.codex`, and `.agents` must remain protected because changing them can affect future trusted runs. Helper functions make the tests easier to read by extracting the generated policy text, creating absolute paths, formatting expected metadata protections, and checking macOS denial errors.

#### Function details

##### `assert_seatbelt_denied`  (lines 40–48)

```
fn assert_seatbelt_denied(stderr: &[u8], path: &Path)
```

**Purpose**: Checks that a failed sandboxed command produced the expected macOS permission-denied message for a path. Tests use it after trying to write somewhere the sandbox should block.

**Data flow**: It receives raw standard error bytes and the path that should have been denied. It turns the bytes into readable text, builds the expected `Operation not permitted` message, and asserts that the output matches that message or the broader Seatbelt apply-denied message. It returns nothing, but fails the test if the error looks wrong.

**Call relations**: The end-to-end metadata protection tests call this after running `sandbox-exec`. It helps `create_seatbelt_args_with_read_only_git_and_codex_subpaths` and `create_seatbelt_args_with_read_only_git_pointer_file` prove that a failed command failed for the sandbox reason they expected.

*Call graph*: called by 2 (create_seatbelt_args_with_read_only_git_and_codex_subpaths, create_seatbelt_args_with_read_only_git_pointer_file); 3 external calls (from_utf8_lossy, assert!, format!).


##### `absolute_path`  (lines 50–52)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Turns a string that should already be an absolute path into the project’s absolute-path type. This keeps test setup short while still using the same path type as production sandbox code.

**Data flow**: It takes a path string, wraps it as a standard path, and asks `AbsolutePathBuf` to accept it only if it is absolute. It returns the absolute-path object, or stops the test if the input was not absolute.

**Call relations**: Tests that build file deny rules or Unix socket allow lists call this when they need a trusted absolute path. It feeds those paths into the sandbox policy constructors being tested.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access, explicit_unreadable_paths_are_excluded_from_readable_roots); 1 external calls (new).


##### `seatbelt_policy_arg`  (lines 54–61)

```
fn seatbelt_policy_arg(args: &[String]) -> &str
```

**Purpose**: Finds the generated Seatbelt policy text inside a list of command-line arguments. Tests use it so they can inspect the actual sandbox rules that would be passed to `sandbox-exec`.

**Data flow**: It receives the full argument list, searches for the `-p` flag used by Seatbelt for inline policy text, and returns the next argument as the policy. If the expected flag or text is missing, the test fails.

**Call relations**: Many tests first call a command-argument builder and then call this helper to examine the policy portion. It connects high-level generated arguments back to string-level policy assertions.

*Call graph*: called by 7 (create_seatbelt_args_allowlists_explicit_unix_socket_paths_without_proxy, create_seatbelt_args_block_first_time_dot_codex_creation_with_metadata_name_regex, create_seatbelt_args_for_cwd_as_git_repo, create_seatbelt_args_preserves_full_network_with_explicit_unix_socket_paths, create_seatbelt_args_with_read_only_git_and_codex_subpaths, explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access, explicit_unreadable_paths_are_excluded_from_readable_roots).


##### `seatbelt_protected_metadata_name_requirements`  (lines 63–81)

```
fn seatbelt_protected_metadata_name_requirements(root: &Path) -> String
```

**Purpose**: Builds the expected Seatbelt rule snippets that block protected metadata names under a root folder. Tests use it to compare generated policies against the required protection for names like `.git` and `.codex`.

**Data flow**: It receives a root path, removes extra trailing slashes, escapes it for regular-expression use, and creates one denial requirement for each protected metadata name. It returns one combined string containing those expected policy clauses.

**Call relations**: Metadata-focused tests use this helper when checking that generated policies protect sensitive folder names even if the folders do not exist yet. It mirrors the expected output of the sandbox policy builder without running the builder itself.

*Call graph*: 5 external calls (ends_with, len, pop, to_string_lossy, escape).


##### `TestConfigReloader::source_label`  (lines 86–88)

```
fn source_label(&self) -> String
```

**Purpose**: Supplies a human-readable label for the fake network proxy configuration source used in tests. It exists because the test proxy needs something that satisfies the same interface as the real config reloader.

**Data flow**: It reads no external state and returns the fixed string `seatbelt test config`. It changes nothing.

**Call relations**: The network proxy test uses `TestConfigReloader` while constructing a proxy state. This method is part of the required `ConfigReloader` interface.


##### `TestConfigReloader::maybe_reload`  (lines 90–92)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Pretends to check whether test network proxy configuration changed, but always says there is no update. This keeps the test proxy stable and predictable.

**Data flow**: It receives the reloader object, creates an async result, and returns `Ok(None)`, meaning no new configuration is available. It changes no configuration.

**Call relations**: The proxy state may call this through the `ConfigReloader` interface. In these tests, it prevents background reload behavior from affecting Seatbelt argument generation.

*Call graph*: 1 external calls (pin).


##### `TestConfigReloader::reload_now`  (lines 94–96)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Rejects forced reloads for the fake test configuration. This makes it clear that the test config is fixed and cannot be refreshed from a real source.

**Data flow**: It receives the reloader object and returns an async error saying the test config cannot reload. It does not produce a new config state.

**Call relations**: This completes the `ConfigReloader` interface for test use. If proxy code asks for an immediate reload during a test, the error makes that unexpected path visible.

*Call graph*: 2 external calls (pin, anyhow!).


##### `base_policy_allows_node_cpu_sysctls`  (lines 100–109)

```
fn base_policy_allows_node_cpu_sysctls()
```

**Purpose**: Verifies that the base macOS sandbox policy allows two system information lookups needed by Node.js CPU detection. This prevents the sandbox from breaking common JavaScript tooling.

**Data flow**: It reads the static base policy string and checks for the CPU brand and hardware model `sysctl` names. It returns nothing, but fails if either allowance is missing.

**Call relations**: This test directly guards `MACOS_SEATBELT_BASE_POLICY`. It does not build a full command; it checks that the shared base policy still includes required macOS system calls.

*Call graph*: 1 external calls (assert!).


##### `base_policy_allows_kmp_registration_shm_read_create_and_unlink`  (lines 112–122)

```
fn base_policy_allows_kmp_registration_shm_read_create_and_unlink()
```

**Purpose**: Verifies that the base policy allows only the shared-memory operations needed by KMP library registration. KMP is used by some parallel computing libraries, and blocking this can break them.

**Data flow**: It builds the exact expected policy snippet and checks that the base policy contains it. The test fails if the shared-memory allowance is missing or too different.

**Call relations**: This directly protects a specific compatibility rule in `MACOS_SEATBELT_BASE_POLICY`. It makes sure the base sandbox remains useful for tools that rely on KMP-style shared memory names.

*Call graph*: 1 external calls (assert!).


##### `create_seatbelt_args_routes_network_through_proxy_ports`  (lines 125–161)

```
fn create_seatbelt_args_routes_network_through_proxy_ports()
```

**Purpose**: Checks that when proxy ports are supplied, the generated network policy allows outbound traffic only to those local proxy ports. This prevents a sandboxed command from bypassing Codex’s network proxy.

**Data flow**: It creates a read-only sandbox policy and proxy inputs with two ports. It calls `dynamic_network_policy`, then checks that those localhost ports are allowed and that blanket outbound, local binding, inbound loopback, and raw DNS are not allowed.

**Call relations**: This test exercises the dynamic network policy builder in the proxy-configured case. It proves that proxy routing narrows access instead of adding broad internet access.

*Call graph*: 5 external calls (new_read_only_policy, assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_allows_tls_without_darwin_user_cache_write`  (lines 164–184)

```
fn dynamic_network_policy_allows_tls_without_darwin_user_cache_write()
```

**Purpose**: Checks that network-enabled sandboxing still allows macOS TLS certificate verification without granting broad writes to the user cache. This balances working HTTPS with file-system safety.

**Data flow**: It builds a workspace-write policy with network access and default proxy inputs. It inspects the generated network policy for access to Apple’s trust service and verifies that `DARWIN_USER_CACHE_DIR` is not broadly allowed.

**Call relations**: This test focuses on `dynamic_network_policy`. It guards a compatibility detail for TLS while making sure the fix does not become an overly broad file-write permission.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access`  (lines 187–257)

```
fn explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access()
```

**Purpose**: Checks that a path explicitly marked unreadable stays blocked even when the root filesystem is otherwise writable. This is the “deny beats allow” rule for full-disk access.

**Data flow**: It builds a file-system policy that allows writing `/` but denies one `/tmp` path. It generates Seatbelt arguments, extracts the policy text, and checks that both read and write rules contain exclusions for the denied path and protected metadata. It also checks the `-D` path parameters passed to Seatbelt.

**Call relations**: This test calls `create_seatbelt_command_args` and uses `seatbelt_policy_arg` plus `absolute_path` to inspect the result. It verifies that high-level deny entries are translated into Seatbelt carve-outs.

*Call graph*: calls 3 internal fn (restricted, absolute_path, seatbelt_policy_arg); 5 external calls (new, assert!, assert_eq!, create_seatbelt_command_args, vec!).


##### `explicit_unreadable_paths_are_excluded_from_readable_roots`  (lines 260–308)

```
fn explicit_unreadable_paths_are_excluded_from_readable_roots()
```

**Purpose**: Checks that an unreadable child path is carved out of an otherwise readable directory. This prevents a broad read rule from leaking a specifically denied subfolder.

**Data flow**: It builds a policy allowing reads under one root and denying a private subpath. It generates Seatbelt arguments, extracts the policy, and confirms that the readable root and its excluded child are both passed as parameters and represented in the policy.

**Call relations**: This test exercises `create_seatbelt_command_args` for read-only carve-outs. It uses the same helper path and policy extraction functions as the broader full-disk deny test.

*Call graph*: calls 3 internal fn (restricted, absolute_path, seatbelt_policy_arg); 4 external calls (new, assert!, create_seatbelt_command_args, vec!).


##### `unreadable_globstar_slash_matches_zero_or_more_directories`  (lines 311–321)

```
fn unreadable_globstar_slash_matches_zero_or_more_directories()
```

**Purpose**: Checks that an unreadable glob pattern using `**/` matches files both directly under a folder and in deeper folders. This mirrors common Git-style glob expectations.

**Data flow**: It passes `/tmp/repo/**/*.env` into the glob-to-regex converter, checks the exact regex text, compiles it, and tests matching and non-matching paths. It produces no value beyond test success or failure.

**Call relations**: This test directly validates `seatbelt_regex_for_unreadable_glob`. It protects the behavior used later when glob deny rules become Seatbelt regular-expression denies.

*Call graph*: 4 external calls (assert!, assert_eq!, new, seatbelt_regex_for_unreadable_glob).


##### `unreadable_globs_use_git_style_component_matching`  (lines 324–337)

```
fn unreadable_globs_use_git_style_component_matching()
```

**Purpose**: Checks that `*`, `?`, and character classes in unreadable glob patterns match within one path segment, not across slashes. This keeps glob behavior predictable and similar to Git patterns.

**Data flow**: It converts a glob pattern to a regex, verifies the regex string, compiles it, and checks that only the intended one-level file path matches. It fails if the regex is too broad or too narrow.

**Call relations**: This is another focused test for `seatbelt_regex_for_unreadable_glob`. It makes sure deny patterns do not accidentally cover nested directories unless the pattern asks for that.

*Call graph*: 4 external calls (assert!, assert_eq!, new, seatbelt_regex_for_unreadable_glob).


##### `unreadable_globs_treat_unclosed_character_classes_as_literals`  (lines 340–349)

```
fn unreadable_globs_treat_unclosed_character_classes_as_literals()
```

**Purpose**: Checks that a malformed glob character class, such as `[`, is treated as a normal character instead of causing strange matching. This makes deny pattern handling safer and more forgiving.

**Data flow**: It converts a glob with an unclosed `[` into a regex, checks the expected escaped regex, compiles it, and tests that paths with a literal `[` match while paths without it do not.

**Call relations**: This directly guards edge-case behavior in `seatbelt_regex_for_unreadable_glob`. It ensures malformed user patterns do not become unexpectedly broad regular expressions.

*Call graph*: 4 external calls (assert!, assert_eq!, new, seatbelt_regex_for_unreadable_glob).


##### `unreadable_glob_policy_includes_canonicalized_static_prefix`  (lines 353–384)

```
fn unreadable_glob_policy_includes_canonicalized_static_prefix()
```

**Purpose**: Checks that unreadable glob policies resolve symlinks in the fixed path prefix before generating Seatbelt rules. This prevents a deny rule from missing the real location of a symlinked directory.

**Data flow**: On Unix, it creates a real directory and a symlink to it, builds a glob through the symlink, and computes the expected regex using the canonical real path. It then builds the Seatbelt unreadable-glob policy and checks that the canonical regex appears.

**Call relations**: This test calls `build_seatbelt_unreadable_glob_policy` and `seatbelt_regex_for_unreadable_glob`. It connects path normalization with glob deny policy generation.

*Call graph*: calls 1 internal fn (default); 6 external calls (new, assert!, format!, create_dir, build_seatbelt_unreadable_glob_policy, seatbelt_regex_for_unreadable_glob).


##### `seatbelt_args_without_extension_profile_keep_legacy_preferences_read_access`  (lines 387–399)

```
fn seatbelt_args_without_extension_profile_keep_legacy_preferences_read_access()
```

**Purpose**: Checks that legacy Seatbelt arguments still allow reading user preferences but not writing them. This preserves compatibility while keeping the sandbox read-only for preferences.

**Data flow**: It builds legacy Seatbelt arguments for a simple command and a read-only policy. It inspects the policy string and checks for `user-preference-read` but not `user-preference-write`.

**Call relations**: This test exercises `create_seatbelt_command_args_for_legacy_policy`. It guards behavior in the older policy-generation path.

*Call graph*: 5 external calls (new_read_only_policy, assert!, temp_dir, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_allows_local_binding_when_explicitly_enabled`  (lines 402–434)

```
fn create_seatbelt_args_allows_local_binding_when_explicitly_enabled()
```

**Purpose**: Checks that local server behavior is allowed only when local binding is explicitly requested. This matters for tools that need to listen on localhost, while keeping the default network policy tighter.

**Data flow**: It builds proxy inputs with one proxy port and `allow_local_binding` set to true. It checks that binding, loopback inbound, loopback outbound, and DNS egress are present, while broad outbound access is still absent.

**Call relations**: This test calls `dynamic_network_policy` in the proxy-plus-local-binding case. It shows that local binding is an explicit add-on, not a side effect of proxy configuration.

*Call graph*: 5 external calls (new_read_only_policy, assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_preserves_restricted_policy_when_proxy_config_without_ports`  (lines 437–470)

```
fn dynamic_network_policy_preserves_restricted_policy_when_proxy_config_without_ports()
```

**Purpose**: Checks that having a proxy configuration but no usable proxy ports does not open the network. The policy should fail closed instead of guessing.

**Data flow**: It builds a network-enabled sandbox with proxy configuration marked present but with an empty port list. It checks that the restricted network profile remains and that no blanket outbound, proxy-port, or DNS allowances appear.

**Call relations**: This test exercises `dynamic_network_policy` for an incomplete proxy setup. It protects against accidentally granting internet access when proxy endpoints are unavailable.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_blocks_dns_when_local_binding_has_no_proxy_ports`  (lines 473–498)

```
fn dynamic_network_policy_blocks_dns_when_local_binding_has_no_proxy_ports()
```

**Purpose**: Checks that DNS traffic is still blocked if local binding is enabled but no proxy ports exist. This prevents DNS from becoming an unintended network escape hatch.

**Data flow**: It builds proxy inputs with local binding enabled and no ports. It verifies that local binding is allowed but DNS egress to port 53 is not.

**Call relations**: This test covers a narrow branch of `dynamic_network_policy`. It confirms that DNS allowance depends on having proxy endpoints, not merely on local binding.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_preserves_restricted_policy_for_managed_network_without_proxy_config`  (lines 501–530)

```
fn dynamic_network_policy_preserves_restricted_policy_for_managed_network_without_proxy_config()
```

**Purpose**: Checks that managed-network mode without proxy endpoints keeps the restricted network profile. This avoids broad access when Codex intends to control networking but has no proxy to route through.

**Data flow**: It builds a network-enabled workspace policy with managed network enforcement turned on and no proxy config. It checks for restricted network markers and confirms that blanket outbound and DNS allowances are absent.

**Call relations**: This test calls `dynamic_network_policy` in the managed-network case. It guards the fail-closed behavior when the managed network cannot provide endpoints.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `create_seatbelt_args_allowlists_unix_socket_paths`  (lines 533–567)

```
fn create_seatbelt_args_allowlists_unix_socket_paths()
```

**Purpose**: Checks that Unix domain sockets can be allowed by specific path instead of opening all socket access. A Unix domain socket is a local machine communication endpoint represented by a filesystem path.

**Data flow**: It builds proxy inputs with a restricted Unix socket allow list. It generates the network policy and checks for AF_UNIX socket creation plus bind and outbound rules tied to a named path parameter, while ensuring older generic subpath socket rules are gone.

**Call relations**: This test exercises `dynamic_network_policy` and the Unix socket policy generation used inside it. It verifies path-specific local socket access for proxy-aware sandboxes.

*Call graph*: 4 external calls (new_read_only_policy, assert!, dynamic_network_policy, vec!).


##### `create_seatbelt_args_allowlists_explicit_unix_socket_paths_without_proxy`  (lines 570–607)

```
fn create_seatbelt_args_allowlists_explicit_unix_socket_paths_without_proxy()
```

**Purpose**: Checks that explicitly requested Unix socket paths are allowed even when there is no network proxy. This supports features that need a local socket without enabling broad networking.

**Data flow**: It creates a temporary working directory, builds a read-only file-system policy, supplies one extra Unix socket path, and generates Seatbelt arguments. It extracts the policy and checks for AF_UNIX outbound permission plus the normalized `UNIX_SOCKET_PATH_0` parameter.

**Call relations**: This test calls `create_seatbelt_command_args`, `normalize_path_for_sandbox`, and `seatbelt_policy_arg`. It proves that extra socket allowances are wired into the full command-argument builder, not only the proxy path.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, seatbelt_policy_arg); 7 external calls (new, new, new_read_only_policy, assert!, create_seatbelt_command_args, normalize_path_for_sandbox, vec!).


##### `create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths`  (lines 610–666)

```
async fn create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths() -> anyhow::Result<()>
```

**Purpose**: Checks that Unix socket paths from network proxy configuration and explicitly requested extra paths are combined. This prevents one source of socket permissions from overwriting the other.

**Data flow**: It builds a test network proxy configured with one socket path and separately supplies another socket path. It generates Seatbelt arguments, normalizes both paths, extracts all `UNIX_SOCKET_PATH_` definitions, and checks that both appear in stable order.

**Call relations**: This async test constructs a `NetworkProxy` using `TestConfigReloader`, then calls `create_seatbelt_command_args`. It verifies the integration between proxy configuration and direct sandbox argument creation.

*Call graph*: calls 3 internal fn (builder, with_reloader, from_legacy_sandbox_policy_for_cwd); 11 external calls (new, new, new, new_read_only_policy, assert_eq!, build_config_state, default, default, create_seatbelt_command_args, normalize_path_for_sandbox (+1 more)).


##### `create_seatbelt_args_preserves_full_network_with_explicit_unix_socket_paths`  (lines 669–701)

```
fn create_seatbelt_args_preserves_full_network_with_explicit_unix_socket_paths()
```

**Purpose**: Checks that adding explicit Unix socket permissions does not downgrade a sandbox that already has full network access. The socket allowance should be added alongside the full network rules.

**Data flow**: It builds Seatbelt arguments with network access enabled and one extra Unix socket path. It extracts the policy and checks that full inbound and outbound network rules remain, while the Unix socket outbound rule is also present.

**Call relations**: This test calls `create_seatbelt_command_args` and `seatbelt_policy_arg`. It protects the combination of full network mode and extra local socket access.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, seatbelt_policy_arg); 5 external calls (new, new_read_only_policy, assert!, create_seatbelt_command_args, vec!).


##### `unix_socket_policy_non_empty_output_is_newline_terminated`  (lines 704–724)

```
fn unix_socket_policy_non_empty_output_is_newline_terminated()
```

**Purpose**: Checks that generated Unix socket policy snippets end with a newline when they are not empty. This keeps generated Seatbelt policy text clean and consistently formatted.

**Data flow**: It builds one restricted socket policy and one allow-all socket policy, then checks that each string ends with `\n`. It returns nothing except test success.

**Call relations**: This test directly calls `unix_socket_policy`. It guards formatting that can matter when snippets are joined into a larger policy.

*Call graph*: 4 external calls (assert!, default, unix_socket_policy, vec!).


##### `unix_socket_dir_params_use_stable_param_names`  (lines 727–752)

```
fn unix_socket_dir_params_use_stable_param_names()
```

**Purpose**: Checks that Unix socket path parameters are deduplicated, sorted, and named predictably. Stable naming makes policies easier to test and avoids needless changes between runs.

**Data flow**: It supplies three allowed socket paths, including a duplicate and out-of-order entries. It calls `unix_socket_dir_params` and checks that the result contains two sorted paths named `UNIX_SOCKET_PATH_0` and `UNIX_SOCKET_PATH_1`.

**Call relations**: This directly validates `unix_socket_dir_params`, which supplies the `-D` parameter names used by generated Seatbelt policies.

*Call graph*: 4 external calls (assert_eq!, default, unix_socket_dir_params, vec!).


##### `normalize_path_for_sandbox_rejects_relative_paths`  (lines 755–757)

```
fn normalize_path_for_sandbox_rejects_relative_paths()
```

**Purpose**: Checks that sandbox path normalization rejects relative paths. Seatbelt rules need clear absolute locations, so accepting relative paths could create confusing or unsafe policies.

**Data flow**: It passes `relative.sock` into `normalize_path_for_sandbox` and expects `None`. No filesystem state is changed.

**Call relations**: This test directly guards `normalize_path_for_sandbox`. Other socket and file-policy tests rely on normalization accepting only safe, absolute paths.

*Call graph*: 1 external calls (assert_eq!).


##### `create_seatbelt_args_allows_all_unix_sockets_when_enabled`  (lines 760–788)

```
fn create_seatbelt_args_allows_all_unix_sockets_when_enabled()
```

**Purpose**: Checks that the explicit allow-all Unix socket mode opens Unix socket bind and connect rules. This is separate from the safer path-specific allow-list mode.

**Data flow**: It builds proxy inputs with Unix socket policy set to allow all. It generates a network policy and checks for AF_UNIX socket creation, unrestricted Unix socket bind, and unrestricted Unix socket outbound rules, while ensuring old generic subpath rules are absent.

**Call relations**: This test exercises `dynamic_network_policy` with `UnixDomainSocketPolicy::AllowAll`. It confirms that the broad mode is intentional and represented by the right Seatbelt rules.

*Call graph*: 4 external calls (new_read_only_policy, assert!, dynamic_network_policy, vec!).


##### `create_seatbelt_args_full_network_with_proxy_is_still_proxy_only`  (lines 791–820)

```
fn create_seatbelt_args_full_network_with_proxy_is_still_proxy_only()
```

**Purpose**: Checks that even if the higher-level sandbox policy says network access is enabled, a configured proxy still restricts traffic to the proxy endpoint. This prevents proxy configuration from being bypassed by “full network” policy wording.

**Data flow**: It builds a network-enabled workspace policy with one proxy port. It checks that the generated policy allows only the localhost proxy endpoint and does not include blanket inbound or outbound network rules.

**Call relations**: This test calls `dynamic_network_policy`. It guards the priority rule that proxy-managed networking narrows access when proxy endpoints are present.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `create_seatbelt_args_with_read_only_git_and_codex_subpaths`  (lines 823–1070)

```
fn create_seatbelt_args_with_read_only_git_and_codex_subpaths()
```

**Purpose**: End-to-end test that writable workspace roots still keep `.git`, `.codex`, and related metadata read-only. This protects users from a sandboxed command planting future hooks or weakening future Codex configuration.

**Data flow**: It creates temporary roots, including one with a Git repository and `.codex/config.toml`. It builds a workspace-write policy, generates Seatbelt arguments, checks the expected protected carve-outs and path parameters, then runs sandboxed shell commands that try to write `.codex` and `.git` files. Those writes must fail, while writing a normal file in the writable root should succeed.

**Call relations**: This test uses `populate_tmpdir` for setup, `seatbelt_policy_arg` for inspection, and `assert_seatbelt_denied` after real sandbox executions. It is one of the strongest integration checks for `create_seatbelt_command_args_for_legacy_policy`.

*Call graph*: calls 3 internal fn (assert_seatbelt_denied, populate_tmpdir, seatbelt_policy_arg); 9 external calls (from_utf8_lossy, new, assert!, assert_eq!, new, format!, create_dir_all, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_block_first_time_dot_codex_creation_with_metadata_name_regex`  (lines 1073–1120)

```
fn create_seatbelt_args_block_first_time_dot_codex_creation_with_metadata_name_regex()
```

**Purpose**: Checks that the sandbox blocks creating a new `.codex` metadata folder in a writable repository, not just modifying one that already exists. This closes a first-time creation loophole.

**Data flow**: It creates a temporary Git repository with no `.codex`, builds a workspace-write policy for it, and generates Seatbelt arguments for a command that would create `.codex/config.toml`. It extracts the policy and checks that regex-based metadata-name protections for the repo root are present.

**Call relations**: This test calls `create_seatbelt_command_args_for_legacy_policy` and `seatbelt_policy_arg`. It focuses on the regex protection produced for protected metadata names, using `seatbelt_protected_metadata_name_requirements` as the expected form.

*Call graph*: calls 1 internal fn (seatbelt_policy_arg); 6 external calls (new, assert!, new, create_dir_all, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_with_read_only_git_pointer_file`  (lines 1123–1217)

```
fn create_seatbelt_args_with_read_only_git_pointer_file()
```

**Purpose**: Checks that Git worktree metadata is protected when `.git` is a pointer file rather than a directory. Some Git checkouts store `gitdir: ...` in `.git`, and both the pointer and the real Git directory must be read-only.

**Data flow**: It creates a temporary worktree root, a separate actual Git directory, and a `.git` file pointing to it. It builds a workspace-write policy, runs sandboxed commands that try to overwrite the pointer file and the real Git config, then confirms the files are unchanged and the commands were denied.

**Call relations**: This integration test calls `create_seatbelt_command_args_for_legacy_policy` and uses `assert_seatbelt_denied` to verify real Seatbelt failures. It extends metadata protection beyond the simple `.git` directory case.

*Call graph*: calls 1 internal fn (assert_seatbelt_denied); 9 external calls (new, assert!, assert_eq!, new, format!, create_dir_all, write, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_for_cwd_as_git_repo`  (lines 1220–1333)

```
fn create_seatbelt_args_for_cwd_as_git_repo()
```

**Purpose**: Checks metadata protection when the current working directory itself is the Git repository and default writable roots are used. This covers the common case where Codex runs inside a repo without explicitly listing writable roots.

**Data flow**: It creates a populated temporary repository, builds a workspace-write policy with default roots, and generates Seatbelt arguments. It checks that the current directory, `/tmp`, and possibly `TMPDIR` get metadata-name protections, and that expected writable-root and excluded-path parameters are present.

**Call relations**: This test uses `populate_tmpdir` for setup and `seatbelt_policy_arg` for policy inspection. It guards how `create_seatbelt_command_args_for_legacy_policy` expands default writable roots and protects metadata inside them.

*Call graph*: calls 2 internal fn (populate_tmpdir, seatbelt_policy_arg); 8 external calls (from, new, assert!, assert_eq!, format!, var, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `populate_tmpdir`  (lines 1355–1395)

```
fn populate_tmpdir(tmp: &Path) -> PopulatedTmp
```

**Purpose**: Creates a temporary test workspace with one root containing protected metadata and one empty root. Tests use it to set up realistic repository-like folders without repeating boilerplate.

**Data flow**: It receives a temporary directory path, creates `vulnerable_root`, initializes it as a Git repository, creates `.codex/config.toml`, creates `empty_root`, canonicalizes the important paths, and returns them in a `PopulatedTmp` struct. It changes the filesystem inside the temporary directory.

**Call relations**: The larger metadata protection tests call this before building sandbox policies. It supplies the real paths used by `create_seatbelt_args_with_read_only_git_and_codex_subpaths` and `create_seatbelt_args_for_cwd_as_git_repo`.

*Call graph*: called by 2 (create_seatbelt_args_for_cwd_as_git_repo, create_seatbelt_args_with_read_only_git_and_codex_subpaths); 4 external calls (join, new, create_dir_all, write).


### `linux-sandbox/src/linux_run_main_tests.rs`

`test` · `test suite`

The Linux sandbox uses bubblewrap, a Linux tool that starts a program inside a restricted mini-environment. This test file makes sure the launcher builds that environment in the intended way. Without these tests, a small change could quietly give a command too much file or network access, fail to start on some systems, delete a real user file during cleanup, or leave child processes running after the parent is told to stop.

The tests cover several important paths. Some check how error text from bubblewrap is recognized, especially failures to mount /proc, a special Linux process-information filesystem. Others check the exact command-line arguments passed to bubblewrap, including network isolation, the inner command name, and proxy setup. Another group checks permission profiles: a permission profile is the user's requested sandbox policy, and the launcher must turn it into concrete file and network restrictions.

The file also tests cleanup rules for synthetic mount targets and protected create targets. These are temporary placeholder files or directories used so bubblewrap can mount things consistently. The cleanup code must act like a careful janitor: remove only placeholders it created, wait if another sandbox is still using them, and preserve real pre-existing files. Finally, there is a process-level test that forks child processes to verify signal forwarding: when the sandbox parent gets a termination signal, the wrapped child should be terminated, but the supervisor test process should survive long enough to report success.

#### Function details

##### `read_only_permission_profile`  (lines 18–20)

```
fn read_only_permission_profile() -> PermissionProfile
```

**Purpose**: Creates a standard read-only permission profile for tests. This gives many tests the same simple baseline: files may be read, but not freely written.

**Data flow**: It takes no input. It asks the permission-profile type for its built-in read-only profile, then returns that profile to the caller.

**Call relations**: Other tests call this when they need a predictable sandbox policy. The helper feeds directly into tests for inner command construction and permission-profile resolution, and it also supports read_only_file_system_policy.

*Call graph*: calls 1 internal fn (read_only); called by 5 (inner_command_includes_permission_profile_flag, managed_proxy_inner_command_includes_route_spec, non_managed_inner_command_omits_route_spec, read_only_file_system_policy, resolve_permission_profile_derives_runtime_policies).


##### `read_only_file_system_policy`  (lines 22–24)

```
fn read_only_file_system_policy() -> FileSystemSandboxPolicy
```

**Purpose**: Turns the standard read-only permission profile into the file-system policy that bubblewrap-building tests need. It avoids repeating the same setup in each test.

**Data flow**: It takes no input. It first creates a read-only permission profile, then asks that profile for its file-system sandbox policy, and returns the policy.

**Call relations**: Tests that build bubblewrap arguments call this helper before checking command-line output. It depends on read_only_permission_profile so all those tests share the same policy source.

*Call graph*: calls 1 internal fn (read_only_permission_profile); called by 4 (inserts_bwrap_argv0_before_command_separator, inserts_unshare_net_when_network_isolation_requested, inserts_unshare_net_when_proxy_only_network_mode_requested, rewrites_inner_command_path_when_bwrap_lacks_argv0).


##### `detects_proc_mount_invalid_argument_failure`  (lines 27–30)

```
fn detects_proc_mount_invalid_argument_failure()
```

**Purpose**: Checks that an “Invalid argument” failure while mounting /proc is recognized as the special /proc mount problem. This matters because the launcher may need to explain or recover from that known failure differently.

**Data flow**: It starts with a sample bubblewrap error message. It passes that text to the /proc mount failure detector and expects the answer to be true.

**Call relations**: This is a focused test of the error-classification helper used by the sandbox startup flow. It does not set up a real sandbox; it only checks the text-matching behavior.

*Call graph*: 1 external calls (assert!).


##### `detects_proc_mount_operation_not_permitted_failure`  (lines 33–36)

```
fn detects_proc_mount_operation_not_permitted_failure()
```

**Purpose**: Checks that an “Operation not permitted” error when mounting /proc is treated as the known /proc mount failure. This covers a common Linux permission-denial wording.

**Data flow**: It supplies one example stderr string from bubblewrap. The detector reads the string and should report that it is a /proc mount failure.

**Call relations**: This test sits beside the other /proc error tests to make sure the same classification works across different kernel or system messages.

*Call graph*: 1 external calls (assert!).


##### `detects_proc_mount_permission_denied_failure`  (lines 39–42)

```
fn detects_proc_mount_permission_denied_failure()
```

**Purpose**: Checks that a “Permission denied” error while mounting /proc is recognized correctly. This protects user-facing error handling from missing another common wording.

**Data flow**: It gives the detector a bubblewrap stderr line about mounting /proc. The expected result is true.

**Call relations**: Together with the neighboring /proc mount tests, this confirms the launcher recognizes several forms of the same startup failure.

*Call graph*: 1 external calls (assert!).


##### `ignores_non_proc_mount_errors`  (lines 45–48)

```
fn ignores_non_proc_mount_errors()
```

**Purpose**: Checks that the /proc mount detector does not mistake unrelated bubblewrap errors for /proc failures. This prevents misleading diagnosis.

**Data flow**: It passes in an error about bind-mounting /dev/null. The detector should read it and return false because the error is not about /proc.

**Call relations**: This is the negative companion to the /proc mount detection tests. It makes sure the classifier is specific, not just matching any permission error.

*Call graph*: 1 external calls (assert!).


##### `inserts_bwrap_argv0_before_command_separator`  (lines 51–92)

```
fn inserts_bwrap_argv0_before_command_separator()
```

**Purpose**: Verifies that, when bubblewrap supports setting argv0, the launcher inserts the requested program name before the separator that introduces the user command. argv0 is the name a process sees as its own command name.

**Data flow**: It builds a basic bubblewrap argument list for running /bin/true with read-only file access and full network access. Then it applies the launcher-name adjustment and compares the whole resulting argument list with the expected one.

**Call relations**: This test exercises the flow from read_only_file_system_policy into bubblewrap argument construction, then into the argv0 adjustment step. It proves the helper option is added to bubblewrap itself, not accidentally to the wrapped command.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert_eq!, vec!).


##### `rewrites_inner_command_path_when_bwrap_lacks_argv0`  (lines 95–121)

```
fn rewrites_inner_command_path_when_bwrap_lacks_argv0()
```

**Purpose**: Verifies the fallback behavior for older bubblewrap versions that cannot set argv0 directly. In that case, the launcher rewrites the command path after the separator to point at a helper path.

**Data flow**: It builds a normal bubblewrap argument list, then applies the argv0 adjustment with support disabled. The resulting list should contain no --argv0 option, and the command after the separator should be replaced with the fallback helper path.

**Call relations**: This complements inserts_bwrap_argv0_before_command_separator. Together they check both modern and older bubblewrap behavior while using the same read-only file-system policy setup.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert!, vec!).


##### `rewrites_bwrap_helper_command_not_nested_user_command_when_current_exe_appears_later`  (lines 124–161)

```
fn rewrites_bwrap_helper_command_not_nested_user_command_when_current_exe_appears_later()
```

**Purpose**: Ensures the fallback rewrite changes only the helper command that bubblewrap launches first, not a later nested command that happens to look like the current executable. This prevents the user's real command from being accidentally rewritten.

**Data flow**: It creates an argument list with two command separators: one for bubblewrap's helper and another inside that helper's own arguments. After applying the fallback rewrite, only the first helper path is changed; the later nested executable path stays the same.

**Call relations**: This test protects a subtle part of argv0 fallback logic. It checks that the launcher edits the correct layer of a nested command line instead of blindly replacing every matching path.

*Call graph*: 3 external calls (assert_eq!, current_exe, vec!).


##### `inserts_unshare_net_when_network_isolation_requested`  (lines 164–180)

```
fn inserts_unshare_net_when_network_isolation_requested()
```

**Purpose**: Checks that isolated network mode asks bubblewrap to create a separate network environment. In bubblewrap terms, --unshare-net means the sandbox should not share the host network namespace.

**Data flow**: It builds bubblewrap arguments using a read-only file policy and isolated network mode. It then checks that the generated argument list contains --unshare-net.

**Call relations**: This test connects the high-level network choice to the low-level bubblewrap flag. It uses read_only_file_system_policy only as the file-access background needed to build the command.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert!, vec!).


##### `inserts_unshare_net_when_proxy_only_network_mode_requested`  (lines 183–199)

```
fn inserts_unshare_net_when_proxy_only_network_mode_requested()
```

**Purpose**: Checks that proxy-only mode also isolates the normal network. Proxy-only means the sandbox should not get open network access, but may communicate through a controlled proxy path.

**Data flow**: It builds bubblewrap arguments with proxy-only network mode. It expects the argument list to include --unshare-net, showing that direct network access is separated from the host.

**Call relations**: This parallels the isolated-network test and confirms that proxy support does not accidentally leave the full host network attached.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert!, vec!).


##### `proxy_only_mode_takes_precedence_over_full_network_policy`  (lines 202–208)

```
fn proxy_only_mode_takes_precedence_over_full_network_policy()
```

**Purpose**: Verifies that when a proxy is allowed, the launcher chooses proxy-only mode even if the broader network policy would otherwise allow full network access. This keeps managed proxy routing in control.

**Data flow**: It gives the network-mode resolver a full-access network policy plus the flag saying proxy networking is allowed. The expected output is the proxy-only bubblewrap network mode.

**Call relations**: This test focuses on the decision step before command construction. Later bubblewrap-building code relies on this decision to add the right network flags.

*Call graph*: 1 external calls (assert_eq!).


##### `split_only_filesystem_policy_requires_direct_runtime_enforcement`  (lines 211–234)

```
fn split_only_filesystem_policy_requires_direct_runtime_enforcement()
```

**Purpose**: Checks that a mixed file policy with writable project roots and a separate read-only path cannot be represented safely by setup alone. It must be enforced directly while the program runs.

**Data flow**: It creates a temporary docs directory and builds a restricted file-system policy with two different access rules. It then asks whether that policy needs direct runtime enforcement and expects yes.

**Call relations**: This test exercises the policy-analysis logic used before choosing the sandbox enforcement strategy. It shows that some combinations are too detailed for older or simpler enforcement modes.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (assert!, create_dir_all, new, vec!).


##### `root_write_read_only_carveout_requires_direct_runtime_enforcement`  (lines 237–258)

```
fn root_write_read_only_carveout_requires_direct_runtime_enforcement()
```

**Purpose**: Checks that allowing writes at the filesystem root while carving out a read-only subpath requires direct runtime enforcement. Otherwise, a broad write rule could overpower the read-only exception.

**Data flow**: It creates a temporary docs directory, builds a policy that writes to root but reads only from that docs path, and asks whether runtime enforcement is needed. The expected answer is true.

**Call relations**: This is another policy-shape test. It protects the logic that detects when exceptions inside broad permissions need a stricter enforcement path.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (assert!, create_dir_all, new, vec!).


##### `managed_proxy_preflight_argv_is_wrapped_for_full_access_policy`  (lines 261–275)

```
fn managed_proxy_preflight_argv_is_wrapped_for_full_access_policy()
```

**Purpose**: Checks that the preflight command for managed proxy mode is still wrapped in bubblewrap, even under an unrestricted file policy. A preflight command is a setup check run before the real command.

**Data flow**: It chooses proxy-only network mode from a full network policy, builds preflight bubblewrap arguments for unrestricted filesystem access, and checks that the command separator is present.

**Call relations**: This links network-mode selection with preflight command construction. It ensures the proxy preflight path still goes through the same wrapper structure as the main sandbox launch.

*Call graph*: calls 1 internal fn (unrestricted); 2 external calls (new, assert!).


##### `cleanup_synthetic_mount_targets_removes_only_empty_mount_targets`  (lines 278–303)

```
fn cleanup_synthetic_mount_targets_removes_only_empty_mount_targets()
```

**Purpose**: Checks that cleanup removes only safe placeholder mount targets: empty files or empty directories that were created for sandbox mounting. It must not delete a real file with content.

**Data flow**: It creates an empty file, an empty directory, a non-empty file, and one missing path in a temporary directory. After registering them as synthetic mount targets and running cleanup, the empty placeholders are gone, the non-empty file still contains its text, and the missing path remains absent.

**Call relations**: This tests the cleanup side of synthetic mount target registration. It protects users from accidental data loss after a sandbox run.

*Call graph*: calls 2 internal fn (missing, missing_empty_directory); 5 external calls (assert!, assert_eq!, create_dir, write, new).


##### `synthetic_mount_registry_root_is_unique_to_effective_user`  (lines 306–314)

```
fn synthetic_mount_registry_root_is_unique_to_effective_user()
```

**Purpose**: Checks that the directory used to track synthetic mount targets includes the effective user ID. This keeps different users on the same machine from sharing the same cleanup registry.

**Data flow**: It reads the current effective user ID from the operating system. It then compares the computed registry root with the expected path inside the system temporary directory.

**Call relations**: This supports the synthetic mount cleanup tests by confirming where registration markers live. The registry path is part of how separate sandbox runs coordinate cleanup safely.

*Call graph*: 2 external calls (assert_eq!, geteuid).


##### `cleanup_synthetic_mount_targets_waits_for_other_active_registrations`  (lines 317–335)

```
fn cleanup_synthetic_mount_targets_waits_for_other_active_registrations()
```

**Purpose**: Checks that cleanup does not remove a synthetic target while another active registration still claims it. This avoids one sandbox deleting a placeholder that another sandbox still needs.

**Data flow**: It creates an empty file target, registers it, and then writes an extra active marker to simulate another owner. The first cleanup leaves the file in place. After the marker is removed and the target is registered again, cleanup removes the file.

**Call relations**: This test models overlapping sandbox runs. It verifies that cleanup uses registry markers as a coordination system rather than acting on the file immediately.

*Call graph*: calls 1 internal fn (missing); 5 external calls (assert!, remove_file, write, from_ref, new).


##### `cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits`  (lines 338–359)

```
fn cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits()
```

**Purpose**: Checks a tricky overlap case where one sandbox creates a temporary empty file and another later sees that file as already existing. The file should still be removed after all synthetic owners are gone.

**Data flow**: It registers a missing target, creates the empty file, marks the first registration as synthetic, then registers a second target based on the now-existing empty file. The first cleanup leaves the file while another marker is active. After that marker is removed, the second cleanup removes the transient file.

**Call relations**: This test protects the cleanup rules for concurrent sandbox launches. It makes sure a placeholder does not become permanent just because a second launcher noticed it while it existed.

*Call graph*: calls 2 internal fn (existing_empty_file, missing); 5 external calls (assert!, remove_file, symlink_metadata, write, new).


##### `cleanup_synthetic_mount_targets_preserves_real_pre_existing_empty_file`  (lines 362–379)

```
fn cleanup_synthetic_mount_targets_preserves_real_pre_existing_empty_file()
```

**Purpose**: Checks that a real empty file that existed before registration is preserved. Empty does not automatically mean disposable.

**Data flow**: It creates an empty file first, records its metadata, and registers it twice as an already-existing empty file. After both cleanups run, the file should still exist.

**Call relations**: This is the counterpart to the transient-file cleanup test. It confirms the registry can distinguish real pre-existing user files from synthetic placeholders.

*Call graph*: calls 1 internal fn (existing_empty_file); 4 external calls (assert!, symlink_metadata, write, new).


##### `cleanup_protected_create_targets_removes_created_path_and_reports_violation`  (lines 382–393)

```
fn cleanup_protected_create_targets_removes_created_path_and_reports_violation()
```

**Purpose**: Checks that if a protected missing path appears during sandbox execution, cleanup removes it and reports that a rule was violated. A protected create target is a path the sandbox is not supposed to create.

**Data flow**: It registers a missing .git path as protected, creates that directory to simulate an unwanted write, then runs cleanup. Cleanup should return true for violation and remove the created path.

**Call relations**: This tests the enforcement-afterward path for protected locations. It ensures the launcher both cleans up the forbidden creation and tells its caller that something went wrong.

*Call graph*: calls 1 internal fn (missing); 3 external calls (assert!, create_dir, new).


##### `cleanup_protected_create_targets_waits_for_other_active_registrations`  (lines 396–416)

```
fn cleanup_protected_create_targets_waits_for_other_active_registrations()
```

**Purpose**: Checks that protected-create cleanup reports the violation right away but waits to delete the path if another registration is still active. This keeps concurrent sandbox runs from racing each other.

**Data flow**: It registers a protected missing path, adds an active marker to simulate another owner, and creates the path. The first cleanup reports a violation but leaves the path. After the marker is removed and cleanup runs again, it still reports the violation and removes the path.

**Call relations**: This mirrors the synthetic mount coordination tests, but for forbidden creations. It proves that violation reporting and safe deletion are handled separately.

*Call graph*: calls 1 internal fn (missing); 5 external calls (assert!, remove_file, write, from_ref, new).


##### `bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive`  (lines 419–430)

```
fn bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive()
```

**Purpose**: Runs a process-level test proving that the signal forwarder sends a termination signal to the bubblewrap child without killing the supervising test process. Signals are operating-system messages such as “please terminate.”

**Data flow**: It forks a supervisor process. The supervisor runs the detailed signal-forwarding scenario, while the parent waits for it and checks that the supervisor exited successfully.

**Call relations**: This is the outer harness for run_bwrap_signal_forwarder_test_supervisor. It uses wait_for_bwrap_child to collect the supervisor's exit status and verify the signal-forwarding behavior from the outside.

*Call graph*: calls 2 internal fn (wait_for_bwrap_child, run_bwrap_signal_forwarder_test_supervisor); 3 external calls (assert!, assert_eq!, fork).


##### `run_bwrap_signal_forwarder_test_supervisor`  (lines 433–460)

```
fn run_bwrap_signal_forwarder_test_supervisor() -> !
```

**Purpose**: Performs the actual signal-forwarding scenario inside a child process. It proves that receiving SIGTERM makes the forwarder terminate the wrapped child, then exits with success only if that happened.

**Data flow**: It forks a child that simply waits forever. The supervisor installs signal forwarders for that child, raises SIGTERM against itself, waits for the child, checks whether the child died from SIGTERM, and exits with code 0 for success or 1 for failure.

**Call relations**: This helper is called only by bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive. It hands off to install_bwrap_signal_forwarders to set up behavior and to wait_for_bwrap_child to observe the child result.

*Call graph*: calls 2 internal fn (install_bwrap_signal_forwarders, wait_for_bwrap_child); called by 1 (bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive); 6 external calls (WIFSIGNALED, WTERMSIG, _exit, fork, pause, raise).


##### `managed_proxy_inner_command_includes_route_spec`  (lines 463–476)

```
fn managed_proxy_inner_command_includes_route_spec()
```

**Purpose**: Checks that when managed proxy networking is enabled, the inner sandbox command includes the proxy route specification. The route specification describes what network routes the proxy should allow.

**Data flow**: It creates a read-only permission profile and builds the inner command with proxy mode enabled and a JSON route spec. The resulting argument list should contain both the route-spec flag and the route-spec value.

**Call relations**: This tests the command line passed to the inner seccomp stage. Seccomp is a Linux filtering feature used to limit system calls, and this test ensures proxy information reaches that inner stage.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 3 external calls (new, assert!, vec!).


##### `inner_command_includes_permission_profile_flag`  (lines 479–495)

```
fn inner_command_includes_permission_profile_flag()
```

**Purpose**: Checks that the inner sandbox command carries the permission profile and the command working directory. The inner stage needs these details to apply the same rules as the outer launcher intended.

**Data flow**: It builds an inner command from a read-only profile, a sandbox policy directory, and a command working directory. It then checks that the arguments contain the permission-profile flag and the command-cwd pair.

**Call relations**: This test focuses on the data passed from the launcher into the inner seccomp command. It uses read_only_permission_profile as the policy source.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 3 external calls (new, assert!, vec!).


##### `non_managed_inner_command_omits_route_spec`  (lines 498–510)

```
fn non_managed_inner_command_omits_route_spec()
```

**Purpose**: Checks that ordinary, non-proxy sandbox runs do not include proxy route arguments. This keeps unrelated command lines simpler and avoids implying proxy behavior when it is disabled.

**Data flow**: It builds an inner command with proxy networking disabled and no route spec. It then checks that the proxy-route-spec flag is absent.

**Call relations**: This is the negative companion to managed_proxy_inner_command_includes_route_spec. Together they prove route specs are included only when managed proxy mode needs them.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 3 external calls (new, assert!, vec!).


##### `managed_proxy_inner_command_requires_route_spec`  (lines 513–526)

```
fn managed_proxy_inner_command_requires_route_spec()
```

**Purpose**: Checks that managed proxy mode refuses to build an inner command if no route specification is provided. This catches a configuration bug early instead of launching a proxy-enabled sandbox with missing routing rules.

**Data flow**: It attempts to build an inner command with proxy mode enabled but with no route spec, inside a panic-catching wrapper. The expected result is that the build panics and the caught result is an error.

**Call relations**: This test protects the precondition used by managed_proxy_inner_command_includes_route_spec. It confirms that proxy mode and route data must travel together.

*Call graph*: 2 external calls (assert!, catch_unwind).


##### `resolve_permission_profile_derives_runtime_policies`  (lines 529–543)

```
fn resolve_permission_profile_derives_runtime_policies()
```

**Purpose**: Checks that resolving a read-only permission profile produces the expected concrete file and network sandbox policies. This is where a user-facing permission setting becomes rules the launcher can enforce.

**Data flow**: It creates a read-only profile, resolves it, and compares the resolved profile, file-system policy, and network policy with the expected values. The network policy should be restricted.

**Call relations**: This test validates the permission-resolution step used before sandbox command construction. It relies on read_only_permission_profile and read_only_file_system_policy for the expected baseline.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 1 external calls (assert_eq!).


##### `resolve_permission_profile_preserves_direct_runtime_profile`  (lines 546–579)

```
fn resolve_permission_profile_preserves_direct_runtime_profile()
```

**Purpose**: Checks that a permission profile created from explicit runtime permissions survives resolution unchanged. This matters for detailed policies that cannot be reduced to a simple preset.

**Data flow**: It creates a temporary docs directory, builds a restricted file policy with root read access and docs write access, then creates a permission profile from that file policy and restricted networking. After resolution, all resolved pieces should match the original profile and policies.

**Call relations**: This test covers the custom-policy path of permission resolution. It complements resolve_permission_profile_derives_runtime_policies, which covers the simpler built-in read-only profile.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, from_absolute_path); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `resolve_permission_profile_rejects_missing_configuration`  (lines 582–587)

```
fn resolve_permission_profile_rejects_missing_configuration()
```

**Purpose**: Checks that permission resolution fails clearly when no permission profile is provided. Starting a sandbox without knowing its permission rules would be unsafe.

**Data flow**: It calls the resolver with no profile. The expected result is a missing-configuration error.

**Call relations**: This guards the entry into the permission-resolution flow. Other tests check valid profiles; this one checks the required input is actually required.

*Call graph*: 1 external calls (assert_eq!).


##### `apply_seccomp_then_exec_with_legacy_landlock_panics`  (lines 590–597)

```
fn apply_seccomp_then_exec_with_legacy_landlock_panics()
```

**Purpose**: Checks that two incompatible inner-stage modes cannot be enabled together: applying seccomp then executing, and using legacy Landlock. Landlock is a Linux feature for limiting file access.

**Data flow**: It calls the mode validator with both incompatible flags set, inside a panic-catching wrapper. The expected result is an error from the caught panic.

**Call relations**: This test protects the mode-selection guardrail before the inner sandbox stage runs. It makes sure invalid combinations fail fast.

*Call graph*: 2 external calls (assert!, catch_unwind).


##### `legacy_landlock_rejects_split_only_filesystem_policies`  (lines 600–628)

```
fn legacy_landlock_rejects_split_only_filesystem_policies()
```

**Purpose**: Checks that legacy Landlock mode rejects file-system policies that need direct runtime enforcement. Legacy enforcement cannot safely express certain split read/write rules.

**Data flow**: It builds a restricted policy with root read access and a writable docs carveout, then calls the legacy-mode policy validator inside a panic-catching wrapper. The expected result is a panic because the policy is unsupported in that mode.

**Call relations**: This ties the policy-analysis tests to the legacy Landlock mode check. It ensures the launcher does not silently choose an enforcement mode that cannot honor the requested policy.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (assert!, create_dir_all, catch_unwind, new, vec!).


##### `valid_inner_stage_modes_do_not_panic`  (lines 631–641)

```
fn valid_inner_stage_modes_do_not_panic()
```

**Purpose**: Checks that the allowed combinations of inner-stage mode flags pass validation. This prevents the validator from being too strict.

**Data flow**: It calls the mode validator three times with valid flag combinations. No value is returned and the important result is that none of the calls panic.

**Call relations**: This is the positive companion to apply_seccomp_then_exec_with_legacy_landlock_panics. Together they define the boundary between valid and invalid inner-stage setup.


### `linux-sandbox/tests/all.rs`

`test` · `test startup`

This file is intentionally tiny, but it plays an important organizing role. In Rust, an integration test file under `tests/` is compiled as its own test program. Here, the project uses one such test program, `all.rs`, and then points it at a larger test tree with `mod suite;`.

Think of it like the cover page of a test binder. The actual test cases are not written on this page; they live in the `tests/suite/` submodules. But without this cover page, the Rust test runner would not know to include that suite as part of this integration test binary.

The top line, `#![allow(clippy::expect_used)]`, relaxes one lint rule for this test program. Clippy is Rust’s extra code checker, and `expect` is a common way for tests to say “this setup must succeed, or the test should stop with this message.” Production code may avoid that style, but tests often use it because failure should be loud and clear.

There are no functions in this file. Its job is wiring: make the test suite visible, compile it as one integration test binary, and allow test-style assertions and setup checks without unnecessary lint noise.


### `linux-sandbox/tests/suite/mod.rs`

`test` · `test discovery and test run startup`

This is a small but important index file for the test suite. In Rust, a `mod` line declares another module, which is a named chunk of code from another file. Here, the file pulls in two test areas: `landlock`, which likely tests Linux Landlock sandbox behavior, and `managed_proxy`, which likely tests proxy behavior used by the sandbox.

Think of this file like the table of contents for a small test book. It does not contain the tests itself. Instead, it points the test runner toward the chapters that do. Without these module declarations, the test files would not be included through this suite entry point, so their checks might not compile or run as part of the expected integration test group.

The comment explains that these modules used to be standalone integration tests. This file now groups them under a shared suite, which can make test organization cleaner and let related tests share setup patterns or naming.


### `linux-sandbox/tests/suite/landlock.rs`

`test` · `test run`

This test file acts like a security checklist for running shell commands inside Codex on Linux. The sandbox is meant to let a command do useful work in a workspace, while stopping it from changing protected files, touching repository metadata such as .git or .codex, or opening network connections when those are not allowed. Without tests like these, a small sandbox regression could silently let a tool overwrite private files or contact the internet.

The file first defines helper functions that build a realistic command environment, find the compiled codex-linux-sandbox helper program, assemble permission profiles, and run commands through Codex's normal execution path. These helpers let each test describe a simple scenario, such as “try to write to this temp file” or “try to run curl,” without repeating all the setup.

Many tests use bubblewrap, a Linux sandboxing tool that creates a restricted view of the filesystem. Because some continuous integration machines do not support bubblewrap, the file includes a probe that detects that situation and skips bubblewrap-specific tests rather than failing for the wrong reason.

The tests cover basic read/write rules, writable workspace roots, special device files like /dev/null, timeouts, network blocking, protected metadata directories, symbolic-link attacks, and explicit allow/deny filesystem policies. In short, it verifies that the sandbox behaves like a locked workroom: the tool can use the bench it was given, but not the locked cabinets or the phone line.

#### Function details

##### `create_env_from_core_vars`  (lines 45–48)

```
fn create_env_from_core_vars() -> HashMap<String, String>
```

**Purpose**: Builds the environment variables that sandboxed test commands should receive. This keeps the tests close to how Codex normally launches shell tools.

**Data flow**: It starts with the default shell environment policy, asks the core environment builder to create a map of variable names to values, and returns that map for later command execution.

**Call relations**: The command-running helpers call this just before launching a sandboxed process, including both the general execution path and the network-blocking helper.

*Call graph*: calls 2 internal fn (create_env, default); called by 2 (assert_network_blocked, run_cmd_result_with_permission_profile_for_cwd).


##### `codex_linux_sandbox_exe`  (lines 50–56)

```
fn codex_linux_sandbox_exe() -> PathBuf
```

**Purpose**: Finds the path to the compiled codex-linux-sandbox test binary. Tests need this path so they can run commands through the same sandbox helper that production code would use.

**Data flow**: It reads Cargo's test-time binary path, turns it into a filesystem path, tries to resolve it to its canonical absolute form, and falls back to the original path if that resolution fails.

**Call relations**: The main sandbox execution helper and several policy-specific tests use this path when they ask Codex to run a command inside the Linux sandbox.

*Call graph*: called by 4 (assert_network_blocked, run_cmd_result_with_permission_profile_for_cwd, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_reenables_writable_subpaths_under_unreadable_parents); 2 external calls (from, env!).


##### `run_cmd`  (lines 59–66)

```
async fn run_cmd(cmd: &[&str], writable_roots: &[PathBuf], timeout_ms: u64)
```

**Purpose**: Runs a command in the sandbox and treats any nonzero exit code as a test failure. It is the simple helper for tests that expect success.

**Data flow**: It receives a command, writable directories, and a timeout. It runs the command, inspects the output, prints stdout and stderr if the command failed, and panics to fail the test.

**Call relations**: Basic tests such as root-read, writable-root, root-write, and timeout tests call this when they only need a pass-or-fail sandboxed command run.

*Call graph*: calls 1 internal fn (run_cmd_output); called by 4 (test_root_read, test_root_write, test_timeout, test_writable_root); 2 external calls (panic!, println!).


##### `run_cmd_output`  (lines 68–82)

```
async fn run_cmd_output(
    cmd: &[&str],
    writable_roots: &[PathBuf],
    timeout_ms: u64,
) -> codex_protocol::exec_output::ExecToolCallOutput
```

**Purpose**: Runs a command in the sandbox and returns its captured output. It is used when a test needs to inspect stdout, stderr, or the exit code itself.

**Data flow**: It takes a command, writable roots, and a timeout, then runs the command with the default modern sandbox settings, no network access, and an ordinary workspace-write permission profile. It returns the captured execution output or fails the test if execution itself unexpectedly errors.

**Call relations**: It sits between the simplest helper, run_cmd, and the lower-level permission-profile helpers. Tests use it when they need to examine command output, such as checking the NoNewPrivs process flag.

*Call graph*: calls 1 internal fn (run_cmd_result_with_writable_roots); called by 2 (run_cmd, test_no_new_privs_is_enabled).


##### `run_cmd_result_with_writable_roots`  (lines 84–111)

```
async fn run_cmd_result_with_writable_roots(
    cmd: &[&str],
    writable_roots: &[PathBuf],
    timeout_ms: u64,
    use_legacy_landlock: bool,
    network_access: bool,
) -> Result<codex_protocol:
```

**Purpose**: Runs a command with a permission profile built from a list of writable directories. It is the common helper for tests that vary what parts of the filesystem should be writable.

**Data flow**: It receives writable paths, converts them to absolute paths, builds a workspace-write permission profile with network either enabled or restricted, excludes temporary directories from automatic write access, and passes everything to the next execution helper. It returns either command output or a sandbox error.

**Call relations**: Many tests call this directly. It prepares the policy, then hands off to run_cmd_result_with_permission_profile so the command can be executed through Codex's normal sandbox path.

*Call graph*: calls 2 internal fn (run_cmd_result_with_permission_profile, workspace_write_with); called by 9 (bwrap_populates_minimal_dev_nodes, bwrap_preserves_writable_dev_shm_bind_mount, run_cmd_output, sandbox_blocks_codex_symlink_replacement_attack, sandbox_blocks_git_and_codex_writes_inside_writable_root, sandbox_ignores_missing_writable_roots_under_bwrap, sandbox_reports_codex_symlink_build_failure_without_panicking, should_skip_bwrap_tests, test_dev_null_write); 1 external calls (iter).


##### `run_cmd_result_with_permission_profile`  (lines 113–128)

```
async fn run_cmd_result_with_permission_profile(
    cmd: &[&str],
    permission_profile: PermissionProfile,
    timeout_ms: u64,
    use_legacy_landlock: bool,
) -> Result<codex_protocol::exec_outpu
```

**Purpose**: Runs a command using a caller-supplied permission profile from the current working directory. This lets tests provide custom sandbox rules without also managing the current directory setup.

**Data flow**: It reads the current directory, treats it as the sandbox working directory, and forwards the command, permission profile, timeout, and legacy-sandbox flag to the more specific helper.

**Call relations**: It is called by the writable-root helper and by tests that build explicit filesystem policies. It hands off to run_cmd_result_with_permission_profile_for_cwd for the actual execution.

*Call graph*: calls 2 internal fn (run_cmd_result_with_permission_profile_for_cwd, current_dir); called by 4 (run_cmd_result_with_writable_roots, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_blocks_root_read_carveouts_under_bwrap, sandbox_reenables_writable_subpaths_under_unreadable_parents).


##### `run_cmd_result_with_cwd_and_writable_roots`  (lines 130–161)

```
async fn run_cmd_result_with_cwd_and_writable_roots(
    cmd: &[&str],
    cwd: &std::path::Path,
    writable_roots: &[PathBuf],
    timeout_ms: u64,
    use_legacy_landlock: bool,
    network_access
```

**Purpose**: Runs a command from a chosen working directory with chosen writable roots. This is useful for tests where the command's location matters, such as testing Git repository discovery from a subdirectory.

**Data flow**: It converts writable roots and the requested working directory into absolute paths, builds a workspace-write permission profile with the requested network setting, and sends the command to the lower-level execution helper. The result is the command output or a sandbox error.

**Call relations**: The repository-metadata test uses this to run commands from inside a child workspace. It prepares both the policy and the current directory before handing off to the common execution path.

*Call graph*: calls 3 internal fn (run_cmd_result_with_permission_profile_for_cwd, workspace_write_with, try_from); called by 1 (sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata); 1 external calls (iter).


##### `run_cmd_result_with_permission_profile_for_cwd`  (lines 163–196)

```
async fn run_cmd_result_with_permission_profile_for_cwd(
    cmd: &[&str],
    cwd: AbsolutePathBuf,
    permission_profile: PermissionProfile,
    timeout_ms: u64,
    use_legacy_landlock: bool,
) ->
```

**Purpose**: Builds the full Codex execution request and actually runs a command through the Linux sandbox. This is the central test helper for launching sandboxed processes.

**Data flow**: It receives a command, working directory, permission profile, timeout, and sandbox-mode flag. It creates execution parameters, fills in the environment, locates the sandbox helper binary, and calls Codex's process execution function. It returns the captured output or a structured error.

**Call relations**: Higher-level helpers funnel into this function. It is the bridge from test setup into process_exec_tool_call, the real Codex execution path under test.

*Call graph*: calls 3 internal fn (process_exec_tool_call, codex_linux_sandbox_exe, create_env_from_core_vars); called by 2 (run_cmd_result_with_cwd_and_writable_roots, run_cmd_result_with_permission_profile); 2 external calls (from_ref, clone).


##### `is_bwrap_unavailable_output`  (lines 198–207)

```
fn is_bwrap_unavailable_output(output: &codex_protocol::exec_output::ExecToolCallOutput) -> bool
```

**Purpose**: Recognizes output that means bubblewrap cannot run in the current environment. This prevents tests from failing just because the host machine cannot support that sandbox layer.

**Data flow**: It reads stderr from a sandboxed command output and checks for known bubblewrap failure messages, including missing bubblewrap or failed /proc mounting. It returns true when those messages are present.

**Call relations**: The bubblewrap skip probe calls this after trying a simple sandboxed command, using it to decide whether bubblewrap-specific tests should be skipped.

*Call graph*: called by 1 (should_skip_bwrap_tests).


##### `should_skip_bwrap_tests`  (lines 209–228)

```
async fn should_skip_bwrap_tests() -> bool
```

**Purpose**: Checks whether bubblewrap-specific tests should be skipped on this machine. It protects the suite from false failures on systems that lack the required sandbox support.

**Data flow**: It tries to run a trivial command with network enabled under the modern sandbox. If the output or denial error looks like bubblewrap is unavailable, or if the probe times out, it returns true. Unexpected errors cause a panic because they may point to a real test problem.

**Call relations**: Most bubblewrap-focused tests call this at the start. It uses run_cmd_result_with_writable_roots for the probe and is_bwrap_unavailable_output to interpret the result.

*Call graph*: calls 2 internal fn (is_bwrap_unavailable_output, run_cmd_result_with_writable_roots); called by 11 (bwrap_populates_minimal_dev_nodes, bwrap_preserves_writable_dev_shm_bind_mount, sandbox_blocks_codex_symlink_replacement_attack, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_blocks_git_and_codex_writes_inside_writable_root, sandbox_blocks_root_read_carveouts_under_bwrap, sandbox_ignores_missing_writable_roots_under_bwrap, sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata, sandbox_reenables_writable_subpaths_under_unreadable_parents, sandbox_reports_codex_symlink_build_failure_without_panicking (+1 more)); 1 external calls (panic!).


##### `expect_denied`  (lines 230–242)

```
fn expect_denied(
    result: Result<codex_protocol::exec_output::ExecToolCallOutput>,
    context: &str,
) -> codex_protocol::exec_output::ExecToolCallOutput
```

**Purpose**: Normalizes the different ways a forbidden command can fail. It lets tests say, in one place, “this action must not succeed.”

**Data flow**: It receives the result of a sandboxed command. If the command returned ordinary output, it asserts the exit code is nonzero. If Codex reported a sandbox denial, it extracts the captured output. Any other error panics. The returned output can then be inspected by the test.

**Call relations**: Tests for protected metadata directories, deny carveouts, and child repository metadata use this helper after attempting an action that should be blocked.

*Call graph*: called by 5 (sandbox_blocks_codex_symlink_replacement_attack, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_blocks_git_and_codex_writes_inside_writable_root, sandbox_blocks_root_read_carveouts_under_bwrap, sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata); 2 external calls (assert_ne!, panic!).


##### `test_root_read`  (lines 245–247)

```
async fn test_root_read()
```

**Purpose**: Confirms that sandboxed commands can still read ordinary system files. A sandbox that blocks all reads would be too strict to run normal tools.

**Data flow**: It asks the sandbox to run ls on /bin with no writable roots. Success means read access to normal system paths is available.

**Call relations**: This is a direct test that uses run_cmd as the simple success-expected execution helper.

*Call graph*: calls 1 internal fn (run_cmd).


##### `test_root_write`  (lines 251–260)

```
async fn test_root_write()
```

**Purpose**: Confirms that sandboxed commands cannot write to arbitrary filesystem locations. This protects files outside the allowed workspace.

**Data flow**: It creates a temporary file path, then tries to overwrite that path from inside the sandbox without granting write access. The test is marked as expected to panic, so success here means the sandboxed write was blocked.

**Call relations**: It uses run_cmd, which panics on command failure. The test harness expects that panic as proof that the forbidden write did not succeed.

*Call graph*: calls 1 internal fn (run_cmd); 2 external calls (new, format!).


##### `test_dev_null_write`  (lines 263–282)

```
async fn test_dev_null_write()
```

**Purpose**: Checks that writing to /dev/null still works inside the bubblewrap sandbox. Many programs write to /dev/null as a harmless output sink, so blocking it would break normal behavior.

**Data flow**: It first skips if bubblewrap is unavailable. Then it runs a shell command that writes text to /dev/null with network enabled for this bubblewrap path, and asserts the command exits successfully.

**Call relations**: It uses the bubblewrap skip probe and then run_cmd_result_with_writable_roots to execute the command under the sandbox.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 2 external calls (assert_eq!, eprintln!).


##### `bwrap_populates_minimal_dev_nodes`  (lines 285–306)

```
async fn bwrap_populates_minimal_dev_nodes()
```

**Purpose**: Verifies that the bubblewrap sandbox creates the small set of device files programs commonly expect. These include things like /dev/null and /dev/urandom.

**Data flow**: After checking that bubblewrap can run, it executes a shell loop that tests whether several /dev entries exist as character devices. It passes only if the loop exits with code zero.

**Call relations**: This test depends on should_skip_bwrap_tests for environment readiness and run_cmd_result_with_writable_roots for sandboxed execution.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 2 external calls (assert_eq!, eprintln!).


##### `bwrap_preserves_writable_dev_shm_bind_mount`  (lines 309–348)

```
async fn bwrap_preserves_writable_dev_shm_bind_mount()
```

**Purpose**: Checks that /dev/shm can be made writable inside the bubblewrap sandbox when explicitly allowed. /dev/shm is a shared-memory area used by some tools for temporary files.

**Data flow**: It skips if bubblewrap or /dev/shm is unavailable, creates a temporary file in /dev/shm, grants /dev/shm as a writable root, writes new content from inside the sandbox, and then reads the host file to confirm the change happened.

**Call relations**: It uses the skip probe, then run_cmd_result_with_writable_roots to exercise the bind-mounted writable /dev/shm path.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 7 external calls (new_in, from, assert_eq!, eprintln!, format!, write, new).


##### `test_writable_root`  (lines 351–366)

```
async fn test_writable_root()
```

**Purpose**: Confirms that a directory explicitly marked writable can be written from inside the sandbox. This is the normal workspace-write use case.

**Data flow**: It creates a temporary directory, chooses a file path inside it, grants that directory as writable, and runs a shell command that writes to the file. The helper fails the test if the write does not work.

**Call relations**: This test calls run_cmd, relying on the helper to build the standard writable-root permission profile.

*Call graph*: calls 1 internal fn (run_cmd); 2 external calls (format!, tempdir).


##### `sandbox_ignores_missing_writable_roots_under_bwrap`  (lines 369–392)

```
async fn sandbox_ignores_missing_writable_roots_under_bwrap()
```

**Purpose**: Checks that a missing writable root does not break the whole bubblewrap sandbox setup. This matters because configured paths may disappear between planning and execution.

**Data flow**: It creates one real directory and names one nonexistent directory, grants both as writable roots, and runs a simple command. It expects the command to succeed and print a known string.

**Call relations**: It first uses should_skip_bwrap_tests, then runs through run_cmd_result_with_writable_roots to confirm missing paths are ignored safely.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 4 external calls (assert_eq!, eprintln!, create_dir, tempdir).


##### `test_no_new_privs_is_enabled`  (lines 395–411)

```
async fn test_no_new_privs_is_enabled()
```

**Purpose**: Verifies that the sandboxed process has Linux's NoNewPrivs protection enabled. NoNewPrivs is a kernel flag that stops a process from gaining extra privileges through later program execution.

**Data flow**: It runs a command that reads /proc/self/status, extracts the NoNewPrivs line, and asserts it is set to 1. The output is inspected rather than only checking command success.

**Call relations**: It uses run_cmd_output because it needs to read the command's stdout and check the exact process status line.

*Call graph*: calls 1 internal fn (run_cmd_output); 1 external calls (assert_eq!).


##### `test_timeout`  (lines 415–417)

```
async fn test_timeout()
```

**Purpose**: Confirms that sandboxed commands are stopped when they run past their deadline. This prevents hung tools from stalling the test suite or the product.

**Data flow**: It runs sleep 2 with a very short timeout. The test is marked as expecting a sandbox timeout panic, so the desired result is that Codex interrupts the command.

**Call relations**: It calls run_cmd, whose panic on timeout is caught by the test harness as the expected behavior.

*Call graph*: calls 1 internal fn (run_cmd).


##### `assert_network_blocked`  (lines 423–477)

```
async fn assert_network_blocked(cmd: &[&str])
```

**Purpose**: Runs a network-related command and asserts that it cannot succeed in a read-only, network-restricted sandbox. It is the shared helper for all network blocking tests.

**Data flow**: It builds execution parameters for the given command, uses a read-only permission profile, runs through the sandbox helper, accepts either captured output or a sandbox-denied error, and panics only if the command exits successfully. Missing command binaries are treated as acceptable nonzero failures.

**Call relations**: The curl, wget, ping, nc, ssh, getent, and /dev/tcp tests call this. It directly uses process_exec_tool_call, along with the environment and sandbox-binary helpers, to test the real execution path.

*Call graph*: calls 5 internal fn (process_exec_tool_call, codex_linux_sandbox_exe, create_env_from_core_vars, read_only, current_dir); called by 7 (sandbox_blocks_curl, sandbox_blocks_dev_tcp_redirection, sandbox_blocks_getent, sandbox_blocks_nc, sandbox_blocks_ping, sandbox_blocks_ssh, sandbox_blocks_wget); 3 external calls (dbg!, panic!, from_ref).


##### `sandbox_blocks_curl`  (lines 480–482)

```
async fn sandbox_blocks_curl()
```

**Purpose**: Checks that curl cannot make an HTTP request when network access is blocked. Curl is a common tool, so it is an important real-world network test.

**Data flow**: It passes a curl command for openai.com into the shared network-blocking helper. The test passes if the command fails rather than reaching the network successfully.

**Call relations**: This is a small scenario wrapper around assert_network_blocked.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_wget`  (lines 485–487)

```
async fn sandbox_blocks_wget()
```

**Purpose**: Checks that wget cannot fetch a web page when network access is blocked. It covers another common download tool besides curl.

**Data flow**: It gives a wget command to the shared network-blocking helper. The helper runs it in the sandbox and ensures the exit code is not successful.

**Call relations**: This test delegates the common setup and assertion to assert_network_blocked.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_ping`  (lines 490–493)

```
async fn sandbox_blocks_ping()
```

**Purpose**: Checks that ping cannot send network packets from the restricted sandbox. Ping uses a lower-level kind of network access, so it exercises a different path than HTTP tools.

**Data flow**: It sends a one-packet ping command to the network-blocking helper. The test expects the command to fail quickly rather than successfully reaching 8.8.8.8.

**Call relations**: It is one of several network scenarios that rely on assert_network_blocked for execution and validation.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_nc`  (lines 496–499)

```
async fn sandbox_blocks_nc()
```

**Purpose**: Checks that netcat cannot open a socket connection when the sandbox blocks networking. This tests a direct TCP connection attempt.

**Data flow**: It asks netcat to probe localhost port 80 and passes that command to the shared helper. Any successful connection would fail the test.

**Call relations**: It uses assert_network_blocked to run and judge the network attempt.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_git_and_codex_writes_inside_writable_root`  (lines 502–550)

```
async fn sandbox_blocks_git_and_codex_writes_inside_writable_root()
```

**Purpose**: Ensures that even inside an allowed writable workspace, protected metadata directories such as .git and .codex cannot be modified. This stops tools from corrupting repository state or Codex's own metadata.

**Data flow**: It creates a temporary workspace containing .git and .codex directories, grants the workspace as writable, then tries to write files inside those protected directories. Both attempts must be denied or exit nonzero.

**Call relations**: The test skips if bubblewrap is unavailable, runs the write attempts with run_cmd_result_with_writable_roots, and uses expect_denied to interpret the expected failures.

*Call graph*: calls 3 internal fn (expect_denied, run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 5 external calls (assert_ne!, eprintln!, format!, create_dir_all, tempdir).


##### `sandbox_blocks_codex_symlink_replacement_attack`  (lines 553–586)

```
async fn sandbox_blocks_codex_symlink_replacement_attack()
```

**Purpose**: Checks that a .codex symbolic link cannot be used to bypass protected metadata rules. A symbolic link is like a shortcut; this test makes sure the sandbox follows the shortcut safely when enforcing restrictions.

**Data flow**: It creates a temp directory, makes .codex a symlink to another directory, grants the parent as writable, and tries to write through .codex/config.toml. The result must be denied or nonzero.

**Call relations**: It uses the bubblewrap skip check, runs the command through run_cmd_result_with_writable_roots, and passes the result through expect_denied.

*Call graph*: calls 3 internal fn (expect_denied, run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 5 external calls (assert_ne!, eprintln!, format!, create_dir_all, tempdir).


##### `sandbox_reports_codex_symlink_build_failure_without_panicking`  (lines 589–639)

```
async fn sandbox_reports_codex_symlink_build_failure_without_panicking()
```

**Purpose**: Verifies that a bad .codex symlink setup is reported as a clean sandbox error, not as a Rust panic. This matters because users should see a controlled error message, not an internal crash.

**Data flow**: It creates a .codex symlink, then tries to run a harmless command with the parent directory writable. It expects sandbox setup to be denied, checks the exit code and error text, and confirms the message does not contain panic output.

**Call relations**: It uses should_skip_bwrap_tests and run_cmd_result_with_writable_roots, but handles the expected denial inline so it can inspect the exact error message.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 6 external calls (assert!, assert_eq!, eprintln!, panic!, create_dir_all, tempdir).


##### `sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata`  (lines 642–762)

```
async fn sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata()
```

**Purpose**: Checks a subtle workspace rule: tools should still discover a parent Git repository, but must not create protected metadata directories inside a writable child folder. This lets normal Git commands work without letting tools create hidden control directories.

**Data flow**: It creates a Git repository with a writable subdirectory, runs commands from the subdirectory to confirm Git can find the parent repo and ordinary files can be written, then attempts git init and .codex creation in the child and expects both to be blocked. It also verifies .agents is not created.

**Call relations**: This test uses should_skip_bwrap_tests, run_cmd_result_with_cwd_and_writable_roots for commands that must run from the child directory, and expect_denied for actions that should fail.

*Call graph*: calls 3 internal fn (expect_denied, run_cmd_result_with_cwd_and_writable_roots, should_skip_bwrap_tests); 9 external calls (assert!, assert_eq!, assert_ne!, new, eprintln!, format!, create_dir_all, from_ref, tempdir).


##### `sandbox_blocks_explicit_split_policy_carveouts_under_bwrap`  (lines 765–829)

```
async fn sandbox_blocks_explicit_split_policy_carveouts_under_bwrap()
```

**Purpose**: Tests an explicit filesystem policy where a broad writable area contains a smaller denied area. The denied area must stay blocked even though its parent is writable.

**Data flow**: It creates a temp directory with a blocked subdirectory, builds a custom restricted policy that allows minimal runtime paths and the temp directory but denies the blocked path, then tries to write inside the blocked path. The write must fail.

**Call relations**: It skips when bubblewrap is unavailable, uses codex_linux_sandbox_exe to keep the helper readable under the custom policy, runs through run_cmd_result_with_permission_profile, and checks the denial with expect_denied.

*Call graph*: calls 6 internal fn (codex_linux_sandbox_exe, expect_denied, run_cmd_result_with_permission_profile, should_skip_bwrap_tests, from_runtime_permissions, restricted); 6 external calls (assert_ne!, eprintln!, format!, create_dir_all, tempdir, vec!).


##### `sandbox_reenables_writable_subpaths_under_unreadable_parents`  (lines 832–906)

```
async fn sandbox_reenables_writable_subpaths_under_unreadable_parents()
```

**Purpose**: Checks that a specific writable subdirectory can still be used even when its parent directory is denied. This tests fine-grained policy layering, like locking a cabinet but leaving one labeled drawer open.

**Data flow**: It creates blocked/allowed directories, builds a policy that writes the temp area, denies the blocked parent, then explicitly allows the nested allowed directory. It writes and reads a file in the allowed directory and expects success.

**Call relations**: It uses the bubblewrap skip probe, finds the sandbox helper path for the custom policy, builds a runtime permission profile, and executes through run_cmd_result_with_permission_profile.

*Call graph*: calls 5 internal fn (codex_linux_sandbox_exe, run_cmd_result_with_permission_profile, should_skip_bwrap_tests, from_runtime_permissions, restricted); 6 external calls (assert_eq!, eprintln!, format!, create_dir_all, tempdir, vec!).


##### `sandbox_blocks_root_read_carveouts_under_bwrap`  (lines 909–955)

```
async fn sandbox_blocks_root_read_carveouts_under_bwrap()
```

**Purpose**: Verifies that a deny rule can carve out a blocked path even from a broad read-all-root policy. This ensures specific denies win over general read permission.

**Data flow**: It creates a file containing secret text, builds a policy that allows reading the root filesystem but denies the file's containing directory, and tries to cat the secret file. The read must fail.

**Call relations**: The test skips if bubblewrap cannot run, builds an explicit permission profile, runs through run_cmd_result_with_permission_profile, and uses expect_denied to verify the blocked read.

*Call graph*: calls 5 internal fn (expect_denied, run_cmd_result_with_permission_profile, should_skip_bwrap_tests, from_runtime_permissions, restricted); 7 external calls (assert_ne!, eprintln!, format!, create_dir_all, write, tempdir, vec!).


##### `sandbox_blocks_ssh`  (lines 958–970)

```
async fn sandbox_blocks_ssh()
```

**Purpose**: Checks that ssh cannot open a network connection from the restricted sandbox. The command is configured to fail quickly and avoid interactive password prompts.

**Data flow**: It passes an ssh command targeting github.com to the shared network-blocking helper. The test passes if ssh cannot connect successfully.

**Call relations**: It delegates sandbox setup and success/failure checking to assert_network_blocked.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_getent`  (lines 973–975)

```
async fn sandbox_blocks_getent()
```

**Purpose**: Checks that getent cannot perform hostname lookup when networking is blocked. This covers DNS-style network activity rather than only direct web requests.

**Data flow**: It sends a getent ahosts lookup for openai.com to the shared helper. A successful lookup would indicate a sandbox leak and fail the test.

**Call relations**: It is a scenario-specific wrapper around assert_network_blocked.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_dev_tcp_redirection`  (lines 978–983)

```
async fn sandbox_blocks_dev_tcp_redirection()
```

**Purpose**: Checks that shell-level /dev/tcp redirection cannot bypass the network sandbox. Some shells expose TCP connections through file-like paths, so this tests that shortcut too.

**Data flow**: It runs a bash command that tries to write to /dev/tcp/127.0.0.1/80 and passes it to the network-blocking helper. The test expects a nonzero exit rather than a successful connection.

**Call relations**: It uses assert_network_blocked, alongside the other network tests, to exercise one more way a command might try to open a socket.

*Call graph*: calls 1 internal fn (assert_network_blocked).


### `linux-sandbox/tests/suite/managed_proxy.rs`

`test` · `test run`

These are Linux-only integration tests for the `codex-linux-sandbox` program. The sandbox uses Linux isolation tools, including bubblewrap, to run a command in a restricted environment. Managed proxy mode is meant to be a safe doorway to the network: the command inside the sandbox may talk to a configured proxy, but it should not freely connect to the outside world.

The file first builds a clean environment for test commands and removes any proxy settings inherited from the developer’s machine. That matters because accidental proxy variables could make tests pass or fail for the wrong reason. It also detects when tests should be skipped, such as when bubblewrap is not installed or the machine does not allow the needed Linux namespace features.

The actual tests check three important promises. First, managed proxy mode must “fail closed”: if no proxy is configured, it refuses to run rather than silently allowing unsafe networking. Second, when a proxy is configured, traffic to that proxy is allowed through a bridge, while direct network access is still blocked. Third, creating normal Unix-domain sockets is denied, but `socketpair`, a local in-process communication tool, still works. Together these tests protect the sandbox’s network boundary, like checking that a building’s single guarded exit works while the side doors remain locked.

#### Function details

##### `create_env_from_core_vars`  (lines 45–48)

```
fn create_env_from_core_vars() -> HashMap<String, String>
```

**Purpose**: Builds the starting set of environment variables that the sandboxed command should receive. It uses the project’s normal shell environment policy so the tests resemble real sandbox launches.

**Data flow**: It starts with the default shell environment policy, asks the core environment builder to create variables from that policy, and returns a map of environment variable names to values. It does not run the sandbox itself; it only prepares the input environment.

**Call relations**: The skip checks and all three managed proxy tests call this before launching sandboxed commands. They then usually pass the result to `strip_proxy_env` so each test controls exactly which proxy settings exist.

*Call graph*: calls 2 internal fn (create_env, default); called by 5 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress, managed_proxy_skip_reason, should_skip_bwrap_tests).


##### `strip_proxy_env`  (lines 50–56)

```
fn strip_proxy_env(env: &mut HashMap<String, String>)
```

**Purpose**: Removes proxy-related environment variables from a test environment. This keeps outside machine settings from changing what the sandbox test is really testing.

**Data flow**: It receives a mutable environment map. For every known proxy variable name, it removes both the uppercase version and the lowercase version. The same map comes out cleaner, with those proxy entries gone.

**Call relations**: Every sandbox-launching helper path uses this after creating an environment. Some tests then add back one deliberate `HTTP_PROXY` value, so the sandbox sees only the proxy setting chosen by the test.

*Call graph*: called by 5 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress, managed_proxy_skip_reason, should_skip_bwrap_tests).


##### `is_bwrap_unavailable_output`  (lines 58–60)

```
fn is_bwrap_unavailable_output(output: &Output) -> bool
```

**Purpose**: Checks whether a sandbox run failed because bubblewrap is missing. Bubblewrap is the Linux tool the sandbox depends on for isolation.

**Data flow**: It receives the completed process output from a sandbox command, reads the error text as UTF-8 text even if some bytes are imperfect, and returns true if it contains the known “bubblewrap is unavailable” message.

**Call relations**: This is used by `should_skip_bwrap_tests` after a simple sandbox probe. It turns raw error output into a clear yes-or-no answer about whether the environment can run these tests at all.

*Call graph*: called by 1 (should_skip_bwrap_tests); 1 external calls (from_utf8_lossy).


##### `should_skip_bwrap_tests`  (lines 62–75)

```
async fn should_skip_bwrap_tests() -> bool
```

**Purpose**: Decides whether sandbox tests should be skipped because the required bubblewrap program is not available. This avoids reporting a product failure when the test machine simply lacks a dependency.

**Data flow**: It creates a clean environment, removes proxy settings, and runs a tiny sandboxed command: `bash -c true`. It then checks the command’s error output for the known bubblewrap-missing message and returns true if that message appears.

**Call relations**: This is the first check inside `managed_proxy_skip_reason`. It relies on `create_env_from_core_vars`, `strip_proxy_env`, `run_linux_sandbox_direct`, and `is_bwrap_unavailable_output` to turn a quick sandbox probe into a skip decision.

*Call graph*: calls 5 internal fn (create_env_from_core_vars, is_bwrap_unavailable_output, run_linux_sandbox_direct, strip_proxy_env, read_only); called by 1 (managed_proxy_skip_reason).


##### `is_managed_proxy_permission_error`  (lines 77–81)

```
fn is_managed_proxy_permission_error(stderr: &str) -> bool
```

**Purpose**: Recognizes error messages that mean the current Linux environment cannot create the network isolation needed for managed proxy mode. This is common in restricted containers or systems without the right namespace privileges.

**Data flow**: It receives stderr text from a failed sandbox run and compares it with several known message fragments. It returns true if any fragment is present, otherwise false.

**Call relations**: This is used by `managed_proxy_skip_reason` after a managed-proxy probe fails. It helps distinguish “this machine cannot support the test” from “the sandbox behavior is actually wrong.”

*Call graph*: called by 1 (managed_proxy_skip_reason).


##### `managed_proxy_skip_reason`  (lines 83–113)

```
async fn managed_proxy_skip_reason() -> Option<String>
```

**Purpose**: Figures out whether managed proxy tests should be skipped, and if so gives a human-readable reason. It prevents noisy failures on machines that cannot support the sandbox features being tested.

**Data flow**: It first asks whether bubblewrap is unavailable. If so, it returns that skip reason. Otherwise it creates a clean environment, adds a dummy `HTTP_PROXY`, and tries to run a harmless command in managed proxy mode. If the command succeeds, it returns no skip reason. If it fails with known namespace or permission errors, it returns an explanation; other failures are left for the test to expose.

**Call relations**: Each real test calls this at the start. It calls `should_skip_bwrap_tests` for the basic dependency check, then uses `run_linux_sandbox_direct` for a managed-proxy capability probe, with help from the environment helpers and `is_managed_proxy_permission_error`.

*Call graph*: calls 5 internal fn (create_env_from_core_vars, is_managed_proxy_permission_error, run_linux_sandbox_direct, should_skip_bwrap_tests, strip_proxy_env); called by 3 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress); 2 external calls (from_utf8_lossy, format!).


##### `run_linux_sandbox_direct`  (lines 115–150)

```
async fn run_linux_sandbox_direct(
    command: &[&str],
    permission_profile: &PermissionProfile,
    allow_network_for_proxy: bool,
    env: HashMap<String, String>,
    timeout_ms: u64,
) -> Outp
```

**Purpose**: Runs the compiled `codex-linux-sandbox` test binary with a chosen command, permission profile, environment, and timeout. It is the shared launch helper that makes the tests exercise the real sandbox executable.

**Data flow**: It receives the command to run, the sandbox permission profile, whether managed proxy networking should be allowed, the environment map, and a timeout in milliseconds. It builds command-line arguments, clears the child process environment, installs the supplied variables, captures stdout and stderr, waits with a timeout, and returns the finished process output.

**Call relations**: All probes and tests use this as their doorway into the sandbox. Higher-level functions decide what scenario to test, then hand the exact command and environment to this helper; it hands back status, stdout, and stderr for assertions or skip decisions.

*Call graph*: called by 5 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress, managed_proxy_skip_reason, should_skip_bwrap_tests); 9 external calls (from_millis, null, piped, new, env!, to_string, current_dir, timeout, vec!).


##### `managed_proxy_mode_fails_closed_without_proxy_env`  (lines 153–177)

```
async fn managed_proxy_mode_fails_closed_without_proxy_env()
```

**Purpose**: Tests that managed proxy mode refuses to run when no proxy environment variable is present. This is important because a missing proxy should not accidentally become unrestricted network access.

**Data flow**: It first asks whether the test should be skipped. If not, it creates a clean environment with all proxy variables removed, runs `bash -c true` in managed proxy mode, and inspects the result. The expected outcome is failure with an error message saying proxy environment variables are required.

**Call relations**: This is one of the top-level Tokio async tests. It uses `managed_proxy_skip_reason` for environment suitability, then relies on `create_env_from_core_vars`, `strip_proxy_env`, and `run_linux_sandbox_direct` to create the exact “no proxy configured” situation.

*Call graph*: calls 4 internal fn (create_env_from_core_vars, managed_proxy_skip_reason, run_linux_sandbox_direct, strip_proxy_env); 4 external calls (from_utf8_lossy, assert!, assert_eq!, eprintln!).


##### `managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress`  (lines 180–257)

```
async fn managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress()
```

**Purpose**: Tests the central promise of managed proxy mode: traffic to the configured proxy is allowed, but direct outbound network access is blocked. In plain terms, it checks that the guarded gate works and the fence still holds.

**Data flow**: It starts by skipping unsupported environments. Then it opens a local TCP listener pretending to be an HTTP proxy and starts a thread to capture one request and reply `HTTP/1.1 200 OK`. It creates a clean environment with `HTTP_PROXY` pointing to that listener, runs a sandboxed shell command that connects to the proxy and sends an HTTP request, and verifies the response and captured request. Finally, it runs another sandboxed command that tries to connect directly to an external test address and expects that attempt to fail.

**Call relations**: This top-level async test uses the shared skip and environment helpers, then calls `run_linux_sandbox_direct` twice: once for the allowed proxy path and once for the blocked direct path. The local listener acts as the outside witness proving that the sandbox routed traffic through the proxy bridge.

*Call graph*: calls 4 internal fn (create_env_from_core_vars, managed_proxy_skip_reason, run_linux_sandbox_direct, strip_proxy_env); 9 external calls (from_secs, from_utf8_lossy, bind, assert!, assert_eq!, eprintln!, format!, channel, spawn).


##### `managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair`  (lines 260–303)

```
async fn managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair()
```

**Purpose**: Tests a subtle socket rule in managed proxy mode: creating a normal Unix-domain socket is denied, but creating a connected socket pair is allowed. Unix-domain sockets are local machine communication endpoints, while a socket pair is just a private two-ended pipe inside the same process.

**Data flow**: It first skips unsupported environments and also skips if `python3` is missing. Then it creates a clean environment with a dummy proxy, runs a small Python program inside the sandbox, and checks the program’s exit code. The Python code expects direct creation of an `AF_UNIX` socket to fail with permission denied, then verifies that `socket.socketpair` can still send and receive `ok` locally.

**Call relations**: This top-level async test uses `managed_proxy_skip_reason` before doing any sandbox assertions. It uses `run_linux_sandbox_direct` to execute Python inside the sandbox, while the environment helpers ensure proxy settings are controlled and predictable.

*Call graph*: calls 4 internal fn (create_env_from_core_vars, managed_proxy_skip_reason, run_linux_sandbox_direct, strip_proxy_env); 3 external calls (assert_eq!, new, eprintln!).


### `exec/tests/suite/sandbox.rs`

`test` · `test execution`

This is a test file for the Codex sandbox, which is the safety layer that limits what a spawned command can read, write, or access. Without tests like these, Codex might accidentally block ordinary tools that users expect to work, or worse, allow commands to write files they should not be able to touch.

The file uses the same sandbox launching path that production code uses. On Linux it runs commands through the Linux sandbox helper, and first checks whether Landlock is actually enforceable. Landlock is a Linux security feature that can restrict file access; some kernels or containers claim support but do not enforce it, so the tests skip themselves in that case. On macOS, the helper builds the sandboxed command request and starts it directly.

The tests cover both convenience and safety. Some prove that Python can still use multiprocessing locks and look up the current user. Others prove that write permission comes from the sandbox policy directory, not merely from the command’s current working directory. Another test checks that a command cannot create a fresh `.codex/config.toml` inside a workspace, which helps prevent a sandboxed command from changing Codex configuration for future runs.

The last part re-runs one test inside the sandboxed copy of the test binary itself. That lets the file test low-level Unix socket behavior from inside the sandbox, like sending and receiving data through a local socket pair.

#### Function details

##### `spawn_command_under_sandbox`  (lines 84–108)

```
async fn spawn_command_under_sandbox(
    command: Vec<String>,
    command_cwd: AbsolutePathBuf,
    permission_profile: &PermissionProfile,
    sandbox_cwd: &AbsolutePathBuf,
    stdio_policy: Stdio
```

**Purpose**: This helper starts a command inside the project’s sandbox, using the platform’s real sandbox path. Tests use it whenever they need to run an actual program under sandbox rules rather than just inspect configuration.

**Data flow**: It receives a command, the directory where that command should run, a permission profile, the sandbox policy directory, a standard input/output choice, and environment variables. It turns those into a sandboxed child process: on Linux by finding and invoking the Linux sandbox helper, and on macOS by building a sandboxed execution request and configuring a Tokio child process. The result is either a running child process that the test can wait on, or an I/O error explaining why it could not be started.

**Call relations**: Most tests in this file call this helper when they need to prove real sandbox behavior. The Linux capability probe calls it with `/usr/bin/true`; the Python tests call it with `python3`; the filesystem tests call it with shell commands or `touch`; and `run_code_under_sandbox` uses it to re-run the current test binary inside the sandbox.

*Call graph*: called by 6 (can_apply_linux_sandbox_policy, python_getpwuid_works_under_sandbox, python_multiprocessing_lock_works_under_sandbox, run_code_under_sandbox, sandbox_blocks_first_time_dot_codex_creation, sandbox_distinguishes_command_and_policy_cwds); 6 external calls (inherit, null, piped, new, find_codex_linux_sandbox_exe, from_ref).


##### `linux_sandbox_test_env`  (lines 117–135)

```
async fn linux_sandbox_test_env() -> Option<HashMap<String, String>>
```

**Purpose**: This Linux-only helper decides whether sandbox tests should run on the current machine. It prevents false failures on systems where Linux Landlock restrictions cannot actually be enforced.

**Data flow**: It reads the current directory and builds a read-only permission profile for a tiny trial run. It asks `can_apply_linux_sandbox_policy` whether the sandbox can successfully run a minimal command under those rules. If the probe succeeds, it returns an empty environment map for use by the tests; if not, it prints a skip message and returns nothing.

**Call relations**: Linux versions of the Python and filesystem tests call this before doing their real checks. It delegates the actual trial execution to `can_apply_linux_sandbox_policy`, so individual tests do not each need to know how to detect an unusable Landlock environment.

*Call graph*: calls 3 internal fn (can_apply_linux_sandbox_policy, read_only, current_dir); called by 4 (python_getpwuid_works_under_sandbox, python_multiprocessing_lock_works_under_sandbox, sandbox_blocks_first_time_dot_codex_creation, sandbox_distinguishes_command_and_policy_cwds); 2 external calls (new, eprintln!).


##### `can_apply_linux_sandbox_policy`  (lines 143–166)

```
async fn can_apply_linux_sandbox_policy(
    permission_profile: &PermissionProfile,
    command_cwd: &AbsolutePathBuf,
    sandbox_cwd: &AbsolutePathBuf,
    env: HashMap<String, String>,
) -> bool
```

**Purpose**: This helper performs the actual Linux sandbox capability check. It answers the question: can a simple command run successfully with the requested sandbox policy applied?

**Data flow**: It receives a permission profile, a command working directory, a sandbox policy directory, and environment variables. It tries to spawn `/usr/bin/true` under the sandbox, then waits for the child process. It returns `true` only if the process was spawned and exited successfully; any spawn failure, wait failure, or nonzero exit becomes `false`.

**Call relations**: It is called by `linux_sandbox_test_env` as a small, practical test before the larger sandbox behavior tests run. It uses `spawn_command_under_sandbox`, so the probe exercises the same sandbox launch path as the real tests.

*Call graph*: calls 1 internal fn (spawn_command_under_sandbox); called by 1 (linux_sandbox_test_env); 2 external calls (clone, vec!).


##### `python_multiprocessing_lock_works_under_sandbox`  (lines 169–229)

```
async fn python_multiprocessing_lock_works_under_sandbox()
```

**Purpose**: This test checks that Python multiprocessing locks still work inside the sandbox. That matters because Python creates named synchronization objects using shared memory areas such as `/dev/shm` on Linux, and an over-strict sandbox could break common Python programs.

**Data flow**: The test first skips if the surrounding environment says sandbox tests should not run, then gets a usable sandbox environment on Linux. It builds a permission profile that allows workspace writing and, on Linux, allows `/dev/shm` to be writable. It runs a small Python script that creates a multiprocessing lock, starts a child process, acquires the lock there, and exits. The test passes only if the sandboxed Python process exits successfully.

**Call relations**: Before running Python, it may call `linux_sandbox_test_env` to avoid running on unsupported Linux hosts. It then launches Python through `spawn_command_under_sandbox`, using the same sandbox machinery that Codex uses for real command execution.

*Call graph*: calls 4 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, workspace_write_with, current_dir); 5 external calls (new, new, assert!, skip_if_sandbox!, vec!).


##### `python_getpwuid_works_under_sandbox`  (lines 232–275)

```
async fn python_getpwuid_works_under_sandbox()
```

**Purpose**: This test checks that Python can still look up information about the current user while sandboxed. That is a basic operation used by many tools, so the sandbox should not accidentally block it in read-only mode.

**Data flow**: The test prepares a sandbox environment, skips if `python3` is not available, and creates a read-only permission profile. It then runs `python3 -c` with code that imports Python’s user database module and looks up the current user ID. It waits for the child process and passes only if Python exits successfully.

**Call relations**: On Linux, it first relies on `linux_sandbox_test_env` to make sure sandbox enforcement is usable. It uses `spawn_command_under_sandbox` to run the Python command under the real sandbox and then checks the child process result.

*Call graph*: calls 4 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, read_only, current_dir); 6 external calls (new, assert!, new, skip_if_sandbox!, eprintln!, vec!).


##### `sandbox_distinguishes_command_and_policy_cwds`  (lines 278–366)

```
async fn sandbox_distinguishes_command_and_policy_cwds()
```

**Purpose**: This test proves that the sandbox’s write permission is tied to the sandbox policy directory, not simply to whatever directory the command happens to run in. This prevents a command from gaining write access just by setting its current working directory somewhere else.

**Data flow**: The test creates two temporary directories: one used as the command’s current directory and one used as the sandbox policy root. It gives the sandbox workspace-write permissions with no extra writable roots. First it runs a shell command from the command directory that tries to create `forbidden.txt`; the test expects that to fail and confirms the file was not made. Then it runs `touch` on a path inside the sandbox policy root; the test expects that to succeed and confirms the allowed file exists.

**Call relations**: Like the other Linux-sensitive tests, it may call `linux_sandbox_test_env` first. It then uses `spawn_command_under_sandbox` twice: once to verify the forbidden write is blocked, and once to verify the allowed write is permitted.

*Call graph*: calls 3 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, workspace_write_with); 8 external calls (new, assert!, skip_if_sandbox!, tempdir, canonicalize, create_dir_all, try_exists, vec!).


##### `sandbox_blocks_first_time_dot_codex_creation`  (lines 369–437)

```
async fn sandbox_blocks_first_time_dot_codex_creation()
```

**Purpose**: This test checks that a sandboxed command cannot create a new `.codex/config.toml` file in a repository. That is important because such a file can affect Codex behavior later, so allowing a sandboxed command to create it would be a security risk.

**Data flow**: The test creates a temporary repository directory that does not yet contain `.codex`. It gives the command workspace-write permissions but no extra writable roots, then runs a shell command that tries to make `.codex` and write a config file setting dangerous full access. The expected result is failure. Afterward, the test checks that `.codex` was not created as a directory and that `config.toml` does not exist.

**Call relations**: It first asks `linux_sandbox_test_env` whether Linux sandbox tests can run, when relevant. It uses `spawn_command_under_sandbox` to run the attempted configuration write under the real sandbox, then inspects the filesystem to make sure the sandbox blocked it.

*Call graph*: calls 3 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, workspace_write_with); 10 external calls (new, assert!, assert_eq!, skip_if_sandbox!, panic!, tempdir, create_dir_all, symlink_metadata, try_exists, vec!).


##### `unix_sock_body`  (lines 439–510)

```
fn unix_sock_body()
```

**Purpose**: This function performs the low-level Unix socket checks used by the socket sandbox test. It proves that local process-to-process sockets still work inside the sandbox.

**Data flow**: It directly asks the operating system to create two connected Unix socket pairs: one datagram pair, which sends separate messages, and one stream pair, which behaves like a byte pipe. It writes the bytes `hello_unix` into one end, reads from the other end, checks that the received data matches, and closes all file descriptors when done. If any system call fails or the data is wrong, the assertions fail the test.

**Call relations**: `allow_unix_socketpair_recvfrom` arranges for this body to run inside a sandboxed copy of the test process. This function is the actual in-sandbox workload; it uses operating-system calls such as `socketpair`, `write`, `recvfrom`, and `recv` to exercise the behavior being tested.

*Call graph*: 8 external calls (assert!, assert_eq!, close, recv, recvfrom, socketpair, write, null_mut).


##### `allow_unix_socketpair_recvfrom`  (lines 513–521)

```
async fn allow_unix_socketpair_recvfrom()
```

**Purpose**: This test verifies that the sandbox allows Unix socket pairs and receiving data with `recvfrom`. Unix sockets are local communication channels on the same machine, and blocking them could break ordinary libraries and runtimes.

**Data flow**: It asks `run_code_under_sandbox` to re-run this exact test under a read-only permission profile. In the sandboxed child run, the provided body calls `unix_sock_body`, which creates socket pairs, sends data, receives it, and checks the result. The outer test expects the re-execution setup to succeed.

**Call relations**: This is the public test wrapper around `unix_sock_body`. It does not create sockets itself; instead, it hands that work to `run_code_under_sandbox` so the socket operations happen inside the sandbox rather than in the original test process.

*Call graph*: calls 2 internal fn (run_code_under_sandbox, read_only).


##### `run_code_under_sandbox`  (lines 525–566)

```
async fn run_code_under_sandbox(
    test_selector: &str,
    permission_profile: &PermissionProfile,
    child_body: F,
) -> io::Result<Option<ExitStatus>>
```

**Purpose**: This helper re-runs part of the current test binary inside the sandbox. It is useful for testing behavior that must happen within the sandboxed process itself, not merely in a separate command like Python or Bash.

**Data flow**: It first checks an environment variable named `IN_SANDBOX`. If that variable is absent, it builds a command that launches the current test executable with `--exact` and the requested test name, passes through `--nocapture` when needed, sets `IN_SANDBOX=1`, runs that command under the sandbox, waits for it, and returns the child exit status. If `IN_SANDBOX` is already present, it knows this is the sandboxed child run, so it executes the provided async body directly and returns no child status.

**Call relations**: `allow_unix_socketpair_recvfrom` uses this helper to make `unix_sock_body` run inside the sandbox. Internally, the helper calls `spawn_command_under_sandbox` for the parent-side re-execution step; the environment variable prevents endless self-relaunching by separating the parent branch from the child branch.

*Call graph*: calls 2 internal fn (spawn_command_under_sandbox, current_dir); called by 1 (allow_unix_socketpair_recvfrom); 5 external calls (from, args, current_exe, var, vec!).


### `cli/tests/sandbox_network_proxy.rs`

`test` · `test run on Linux`

This file is a safety test for Codex’s sandbox networking. A sandbox is an isolated space where a command is allowed to do only certain things, like a child-safe room with locked doors. Here, the test makes sure one of those doors stays locked: direct access to a loopback address, which is a network address that points back to the same computer.

The test creates a temporary Codex home folder and writes a small configuration file into it. That configuration turns on the network proxy feature and defines a permission profile that allows networking in general. Then the test starts listening on the local address 127.0.0.2 using a random free port. It does not matter that no full web server is running; the point is to see whether a sandboxed `curl` command can connect directly to that local address.

Next, the test runs the real `codex` command with `codex sandbox`, asking it to execute `curl` inside the sandbox. `curl` is told not to use any proxy, so if it succeeds, it has bypassed the proxy path. The expected result is failure with curl exit code 7, meaning it could not connect.

There is one practical escape hatch: if bubblewrap, the Linux sandboxing tool Codex depends on for this test, is not available on the machine, the test prints a skip message and passes instead of failing for an environmental reason.

#### Function details

##### `sandbox_with_network_proxy_blocks_direct_loopback_access`  (lines 11–70)

```
fn sandbox_with_network_proxy_blocks_direct_loopback_access() -> Result<()>
```

**Purpose**: This test proves that a sandboxed command cannot directly connect to a local loopback address when Codex’s network proxy feature is active. It is used to catch regressions where network isolation becomes too loose.

**Data flow**: It starts by creating a temporary Codex home directory, opening a local TCP listener on 127.0.0.2, and writing a test configuration file that enables the network proxy. It then builds a URL for that local listener and runs the `codex sandbox` command with `curl` inside it, forcing `curl` not to use a proxy. The command output is inspected: if the system reports that bubblewrap is unavailable, the test exits successfully as skipped; otherwise, the test expects curl to fail with exit code 7, proving the direct connection was blocked.

**Call relations**: This function is run by Rust’s test framework as an integration test. During the test it calls out to the real Codex binary, which in turn sets up the sandbox and runs `curl`; after that external process finishes, the test reads its status and error text to decide whether the sandbox behaved correctly.

*Call graph*: 9 external calls (from_utf8_lossy, bind, new, assert_eq!, new, cargo_bin, eprintln!, format!, write).


### Windows and cross-platform execution bridges
These files cover Windows sandbox and execution adapters, including stdio bridging, wrapper protocols, unified execution, and Wine-backed remote exec-server harnesses.

### `windows-sandbox-rs/src/stdio_bridge_tests.rs`

`test` · `test run`

This is a small test file for the project’s standard input/output bridge. That bridge is the part that lets ordinary blocking streams, like stdin and stdout, talk to Tokio channels, which are asynchronous queues used by the rest of the program. Without this bridge working correctly, text sent into or out of the sandbox could be lost, arrive in the wrong order, or never signal that it is finished.

The first test creates fake input containing two lines of text. It starts the input forwarder, then reads every byte that the forwarder sends through a channel. At the end it checks two things: the bytes match the original input exactly, and the forwarder reports that input reached end-of-file, meaning there is nothing more to read.

The second test builds a tiny in-memory writer, protected by a mutex, which is a lock that stops two pieces of code from changing the same byte buffer at once. It sends two output chunks, closes the sending side of the channel, waits for the forwarder to finish, and then checks that the writer received `alpha` followed by `beta` with nothing missing or rearranged.

Together these tests act like a receipt check: what goes into the bridge must come out unchanged, and shutdown must be noticed cleanly.

#### Function details

##### `input_forwarder_sends_chunks_and_reports_eof`  (lines 8–23)

```
async fn input_forwarder_sends_chunks_and_reports_eof() -> anyhow::Result<()>
```

**Purpose**: This test proves that the input forwarder reads all bytes from a normal input stream and sends them through an asynchronous channel. It also checks that the forwarder reports when the input stream has ended.

**Data flow**: The test starts with an in-memory input stream containing `first\nsecond\n`, a channel for byte chunks, and a one-time signal used to report that stdin has closed. The input forwarder reads from that fake input, sends byte chunks into the channel, and eventually closes the channel and sends the done signal. The test collects all received chunks into one byte list and confirms it exactly matches the original input.

**Call relations**: During the test, it builds the fake input with `new`, creates the communication path with `channel`, and uses `assert_eq!` to compare expected bytes with received bytes. It calls on the input-forwarding code as a real user would: start the forwarder, drain what it sends, wait for the close notice, and then verify the forwarder thread finished cleanly.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, channel).


##### `output_forwarder_writes_all_chunks`  (lines 26–63)

```
async fn output_forwarder_writes_all_chunks() -> anyhow::Result<()>
```

**Purpose**: This test proves that the output forwarder takes every chunk from an asynchronous channel and writes it to a normal writer in the right order. It uses an in-memory writer so the test can inspect exactly what was written.

**Data flow**: The test creates a shared byte buffer wrapped in a mutex, then makes a writer that appends any written bytes into that buffer. It sends `alpha` and `beta` through a channel, closes the channel, waits for the forwarder and its completion signal, then reads the buffer. The final output should be the combined bytes `alphabeta`.

**Call relations**: The test gets the current Tokio runtime with `current`, prepares the shared writer with `default` and `clone`, and uses `assert_eq!` for the final byte comparison. In the larger story, it exercises the output-forwarding code from start to shutdown: start the forwarder, feed it chunks, close the sender so it knows no more data is coming, and confirm the writer received everything.

*Call graph*: 4 external calls (assert_eq!, default, clone, current).


### `windows-sandbox-rs/src/wrapper_tests.rs`

`test` · `test run`

This test checks a simple but important promise: if the project turns sandbox settings into command-line arguments, the wrapper must be able to parse those same arguments back into the original settings. That matters because the Windows sandbox wrapper is launched as a separate process, so settings like the working folder, allowed workspace folders, environment variables, network restrictions, and read/write permissions have to travel through text arguments safely.

The test builds a realistic set of sandbox inputs. It includes Windows paths, a small environment map, a permission profile with restricted networking, an elevated sandbox level, private desktop mode, proxy enforcement, and custom read/write allow and deny lists. It then asks the production helper to create the wrapper arguments.

Before parsing, the test checks that the generated argument list contains the expected marker and option flags. This is like checking that every label is present on a packed shipping box before opening it again. Then it feeds the arguments into the production parser and compares every parsed field with the original input. If any value is missing, renamed, encoded incorrectly, or parsed into the wrong shape, the test fails. In short, this file is a safety net for the command-line contract between the sandbox launcher and wrapper.

#### Function details

##### `windows_wrapper_args_round_trip`  (lines 29–106)

```
fn windows_wrapper_args_round_trip()
```

**Purpose**: This test proves that Windows sandbox wrapper arguments make a clean round trip: original settings become command-line arguments, and those arguments parse back into the same settings. Someone would use this test to catch accidental changes that break how the sandbox process is launched.

**Data flow**: It starts with sample sandbox data: Windows folders, workspace roots, environment variables, permission rules, sandbox level, private desktop and proxy settings, and read/write path overrides. It passes those inputs into the argument-building function, checks that the expected command-line flags are present, then sends the produced arguments into the parsing function. The final output is not a returned value but a set of assertions: the test succeeds only if every parsed setting exactly matches the original input.

**Call relations**: During the test run, Rust's test framework calls this function because it is marked as a test. Inside, it relies on path-building helpers to create valid absolute Windows paths, then calls create_windows_sandbox_command_args_for_permission_profile to package the settings for the wrapper. It then calls parse_windows_sandbox_wrapper_args to unpack them again, and uses assertions to confirm that the two sides of the wrapper contract still agree.

*Call graph*: calls 1 internal fn (from_absolute_path); 7 external calls (from, new, assert!, assert_eq!, create_windows_sandbox_command_args_for_permission_profile, parse_windows_sandbox_wrapper_args, vec!).


### `windows-sandbox-rs/src/unified_exec/tests.rs`

`test` · `test run on Windows`

These are Windows-only tests for the code that runs commands inside the project’s Windows sandbox. The sandbox is meant to let Codex run user commands with controlled file access, collect their output, and optionally give them an interactive terminal. If this layer breaks, Codex might hang, lose output, leave input open when it should be closed, or report cancellations as timeouts.

The file uses small helper functions to create a clean test home folder, find the repository workspace, locate PowerShell 7 when it is installed, and run asynchronous tests on a simple Tokio runtime. Tokio is Rust’s async task system; here it lets tests wait for process output without blocking everything else.

The tests cover two kinds of execution. “Capture” runs a command and returns all stdout, stderr, exit code, and timeout status at the end. “Session” starts a live process and lets the test send bytes to its stdin while reading stdout as it arrives. The file also checks lower-level pieces: whether stdin is kept open or closed, whether an end-of-input message is sent, and whether terminal resize requests become framed messages. A global lock serializes legacy sandbox process tests, like letting only one person use a fragile shared machine at a time, because these Windows sandbox resources can interfere with each other.

#### Function details

##### `legacy_process_test_guard`  (lines 38–42)

```
fn legacy_process_test_guard() -> MutexGuard<'static, ()>
```

**Purpose**: This helper takes a global lock so only one legacy Windows sandbox process test runs at a time. It protects tests that use shared or fragile Windows sandbox resources from stepping on each other.

**Data flow**: It receives no input. It locks a shared mutex, which is a lock that allows only one holder at once, and returns the guard object; when the guard is dropped, the lock is released.

**Call relations**: The legacy process tests call this near the start of their work, before spawning sandboxed commands. It does not hand off to other project code; it simply creates a safe testing lane for the rest of each test.

*Call graph*: called by 6 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_powershell_emits_output_and_accepts_input).


##### `current_thread_runtime`  (lines 44–49)

```
fn current_thread_runtime() -> tokio::runtime::Runtime
```

**Purpose**: This builds a small Tokio async runtime for tests that need to await process output or channel messages. It keeps the test setup lightweight by running async tasks on the current thread.

**Data flow**: It takes no input. It asks Tokio to create a current-thread runtime with timers and I/O enabled, then returns that runtime or fails the test if creation is impossible.

**Call relations**: Many async-style tests call this first, then use the returned runtime to run their async block. Inside those blocks, the tests call sandbox spawning helpers, stdin writers, resizers, and output collectors.

*Call graph*: called by 10 (finish_driver_spawn_closes_stdin_when_not_requested, finish_driver_spawn_keeps_stdin_open_when_requested, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input, runner_resizer_sends_resize_frame, runner_stdin_writer_sends_close_stdin_after_input_eof); 1 external calls (new_current_thread).


##### `pwsh_path`  (lines 51–55)

```
fn pwsh_path() -> Option<PathBuf>
```

**Purpose**: This looks for PowerShell 7 in the standard Program Files location. Tests use it so they can skip PowerShell-specific checks on machines where PowerShell 7 is not installed.

**Data flow**: It reads the Windows ProgramFiles environment variable, builds the expected path to pwsh.exe, checks whether that file exists, and returns the path if found. If the environment variable is missing or the file is not there, it returns nothing.

**Call relations**: PowerShell-based tests call this before doing any sandbox work. If it returns a path, they pass that path into the sandbox command; if not, the test exits early rather than failing for a missing optional tool.

*Call graph*: called by 4 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_powershell_emits_output, legacy_tty_powershell_emits_output_and_accepts_input); 2 external calls (from, var_os).


##### `sandbox_cwd`  (lines 57–66)

```
fn sandbox_cwd() -> PathBuf
```

**Purpose**: This chooses the working directory that sandboxed test commands should run in. It makes tests work both under snapshot-style tooling and in normal Cargo test runs.

**Data flow**: It first checks for an INSTA_WORKSPACE_ROOT environment variable. If present, that becomes the working directory; otherwise it derives the repository root from the crate’s manifest directory and returns that path.

**Call relations**: Most sandbox process tests call this before spawning a command. The returned path is passed both as the command’s current directory and as the base for workspace permission setup.

*Call graph*: called by 8 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 3 external calls (from, env!, var).


##### `sandbox_home`  (lines 68–74)

```
fn sandbox_home(name: &str) -> TempDir
```

**Purpose**: This creates a fresh temporary Codex home directory for one test. It keeps logs and sandbox state isolated so one test’s files do not pollute another test.

**Data flow**: It takes a short test name, combines it with a counter, removes any old directory at that location, creates a new parent folder, and returns a temporary directory inside it. The temporary directory cleans itself up when dropped.

**Call relations**: Sandbox process and capture tests call this before running commands. They pass the resulting directory into the sandbox code as the Codex home, and other helpers can later read logs from it if something times out.

*Call graph*: called by 8 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 5 external calls (format!, create_dir_all, remove_dir_all, temp_dir, new_in).


##### `sandbox_log`  (lines 76–80)

```
fn sandbox_log(codex_home: &Path) -> String
```

**Purpose**: This reads the sandbox log for a given Codex home directory. It is mainly used to make timeout failures easier to diagnose.

**Data flow**: It takes the Codex home path, finds the current log file under its .sandbox folder, and tries to read it as text. If reading fails, it returns a message explaining which log file could not be read.

**Call relations**: The output collection helper uses this when waiting for a process or stdout task takes too long. Instead of a bare timeout, the test failure includes the sandbox log text.

*Call graph*: 3 external calls (join, current_log_file_path, read_to_string).


##### `workspace_roots_for`  (lines 82–84)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: This wraps one filesystem path as the list of workspace roots allowed by the sandbox. A workspace root is the project area the sandboxed command may read or write according to the permission profile.

**Data flow**: It takes a path, verifies and converts it into the project’s absolute-path type, places it in a one-item vector, and returns that vector.

**Call relations**: The sandbox execution tests call this right before spawning or capturing commands. The resulting list is passed into the sandbox permission setup alongside the permission profile.

*Call graph*: called by 8 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 1 external calls (vec!).


##### `wait_for_frame_count`  (lines 86–116)

```
fn wait_for_frame_count(frames_path: &Path, expected_frames: usize) -> Vec<Message>
```

**Purpose**: This waits until a frame file contains at least a requested number of messages. It helps tests observe asynchronous writer tasks that may not flush their output instantly.

**Data flow**: It takes the path to a frame file and a target message count. Until a short deadline, it repeatedly opens the file, reads framed messages from the beginning, and returns the messages once enough are present; if not enough arrive, it fails the test.

**Call relations**: The stdin-writer and terminal-resizer tests call this after asking lower-level code to write messages. It uses the framed IPC reader to turn raw file bytes back into Message values that the tests can inspect.

*Call graph*: calls 1 internal fn (read_frame); called by 2 (runner_resizer_sends_resize_frame, runner_stdin_writer_sends_close_stdin_after_input_eof); 8 external calls (from_millis, from_secs, now, new, Start, new, assert!, sleep).


##### `collect_stdout_and_exit`  (lines 118–150)

```
async fn collect_stdout_and_exit(
    spawned: codex_utils_pty::SpawnedProcess,
    codex_home: &Path,
    timeout_duration: Duration,
) -> (Vec<u8>, i32)
```

**Purpose**: This waits for a spawned sandbox process to finish and gathers all of its stdout bytes. It gives tests a simple result: what the command printed and which exit code it returned.

**Data flow**: It takes a spawned process, the Codex home path for logs, and a timeout. It starts a task that drains stdout chunks into one byte buffer, waits for the process exit code, then waits for stdout collection to finish; on timeout it fails with sandbox log text. It returns the combined stdout and exit code.

**Call relations**: Session-based sandbox tests call this after spawning a command, and sometimes after sending input. It consumes the process’s output and exit channels, letting the test make plain assertions about text and success.

*Call graph*: called by 5 (legacy_non_tty_cmd_emits_output, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 3 external calls (new, spawn, timeout).


##### `legacy_non_tty_cmd_emits_output`  (lines 153–189)

```
fn legacy_non_tty_cmd_emits_output()
```

**Purpose**: This test checks that a non-interactive cmd.exe command can run in the legacy Windows sandbox and produce stdout. It verifies the simplest useful case: run a command, get its printed text, and exit successfully.

**Data flow**: It creates a runtime, working directory, temporary Codex home, and workspace-write permission profile. It spawns cmd.exe with an echo command, collects stdout and the exit code, then checks that the exit code is zero and the expected text appears.

**Call relations**: The test uses the legacy process lock, setup helpers, the legacy session spawner, and the shared output collector. It exercises the sandbox session path without a terminal and without open stdin.

*Call graph*: calls 7 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, legacy_process_test_guard, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_non_tty_cmd_rejects_deny_read_overrides`  (lines 192–228)

```
fn legacy_non_tty_cmd_rejects_deny_read_overrides()
```

**Purpose**: This test confirms that the legacy backend refuses deny-read overrides. A deny-read override means hiding a specific file from the command, and this test documents that such hiding requires the elevated backend instead.

**Data flow**: It builds a fake secret file path inside the workspace, then tries to spawn a non-interactive cmd.exe command with that path listed as deny-read. Instead of expecting a process, it expects an error and checks that the error message explains the elevated-backend requirement.

**Call relations**: The test uses the same setup path as other legacy non-terminal tests, but intentionally feeds unsupported permission options into the legacy spawner. Its job is to protect the boundary between legacy sandbox behavior and elevated sandbox behavior.

*Call graph*: calls 7 internal fn (workspace_write, from_absolute_path, current_thread_runtime, legacy_process_test_guard, sandbox_cwd, sandbox_home, workspace_roots_for); 5 external calls (new, assert!, from_ref, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_non_tty_powershell_emits_output`  (lines 231–271)

```
fn legacy_non_tty_powershell_emits_output()
```

**Purpose**: This test checks that PowerShell 7 can run non-interactively in the legacy sandbox and print output. It is skipped automatically if PowerShell 7 is not installed.

**Data flow**: It finds pwsh.exe, prepares sandbox paths and permissions, starts PowerShell with a simple Write-Output command, collects stdout and exit status, then checks for a zero exit code and the expected output text.

**Call relations**: This follows the same flow as the cmd.exe non-terminal test, but uses PowerShell as the child program. It relies on the PowerShell path helper to avoid false failures on machines without pwsh.exe.

*Call graph*: calls 8 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `finish_driver_spawn_keeps_stdin_open_when_requested`  (lines 274–303)

```
fn finish_driver_spawn_keeps_stdin_open_when_requested()
```

**Purpose**: This test checks that finishing a process-driver spawn leaves stdin usable when the caller asked for streaming input. Stdin is the input pipe where later keystrokes or bytes are sent to the process.

**Data flow**: It creates fake channels for process input, output, and exit. After calling finish_driver_spawn with stdin_open set to true, it sends bytes through the returned session writer and confirms those bytes arrive on the original input channel.

**Call relations**: The test focuses on the adapter between a low-level ProcessDriver and the higher-level spawned process object. It does not run a real sandbox command; it verifies that the wrapping step preserves the input path.

*Call graph*: calls 1 internal fn (current_thread_runtime); 2 external calls (assert_eq!, finish_driver_spawn).


##### `finish_driver_spawn_closes_stdin_when_not_requested`  (lines 306–337)

```
fn finish_driver_spawn_closes_stdin_when_not_requested()
```

**Purpose**: This test checks that stdin is closed when streaming input was not requested. That matters because a command waiting for input should not hang forever just because an unused pipe stayed open.

**Data flow**: It creates fake process channels, calls finish_driver_spawn with stdin_open set to false, then tries to send bytes through the returned session writer. The expected result is an error, showing the input side was closed.

**Call relations**: Together with the stdin-open test, this verifies both branches of the process-driver wrapping behavior. It protects callers that want one-shot commands rather than interactive sessions.

*Call graph*: calls 1 internal fn (current_thread_runtime); 2 external calls (assert!, finish_driver_spawn).


##### `runner_stdin_writer_sends_close_stdin_after_input_eof`  (lines 340–383)

```
fn runner_stdin_writer_sends_close_stdin_after_input_eof()
```

**Purpose**: This test verifies that the runner-side stdin writer sends both the input bytes and a final close-stdin message when input ends. The close message tells the sandboxed process there will be no more input.

**Data flow**: It creates a temporary frame file, starts the pipe writer, sends the bytes “hello” through a stdin channel, then drops the sender to simulate end-of-file. After the writer task finishes, it reads the frame file and checks for one stdin message containing “hello” followed by one close-stdin message.

**Call relations**: The test connects the runner pipe writer, the stdin writer, the frame reader, and the message decoder. It checks the small protocol used to carry user input into the sandbox runner.

*Call graph*: calls 3 internal fn (decode_bytes, current_thread_runtime, wait_for_frame_count); 6 external calls (new, new, assert_eq!, panic!, start_runner_pipe_writer, start_runner_stdin_writer).


##### `runner_resizer_sends_resize_frame`  (lines 386–416)

```
fn runner_resizer_sends_resize_frame()
```

**Purpose**: This test checks that a terminal resize request is converted into a resize message for the sandbox runner. This is needed for interactive commands so full-screen or prompt-based tools know the terminal’s current size.

**Data flow**: It creates a temporary frame file, starts the pipe writer, builds a resizer callback, and calls it with 45 rows and 132 columns. It then reads the frame file and checks that the stored message carries the same dimensions.

**Call relations**: This exercises the resize callback made for runner communication. The test uses the frame waiting helper to observe the message that the callback hands to the pipe writer.

*Call graph*: calls 2 internal fn (current_thread_runtime, wait_for_frame_count); 6 external calls (new, new, assert_eq!, panic!, make_runner_resizer, start_runner_pipe_writer).


##### `legacy_capture_powershell_emits_output`  (lines 419–455)

```
fn legacy_capture_powershell_emits_output()
```

**Purpose**: This test checks the capture-style API for PowerShell in the legacy sandbox. Capture mode should run the command to completion and return all output in one result object.

**Data flow**: It finds PowerShell, prepares the working directory, Codex home, and permissions, then calls the capture API with a simple Write-Output command. It reads stdout and stderr from the result, checks that the exit code is zero, and confirms stdout contains the expected text.

**Call relations**: Unlike session tests, this calls the higher-level capture function directly instead of collecting from live channels. It still uses the shared setup helpers and the legacy process lock because it runs a real sandboxed process.

*Call graph*: calls 6 internal fn (workspace_write, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 7 external calls (new, from_utf8_lossy, assert!, assert_eq!, run_windows_sandbox_capture, println!, vec!).


##### `legacy_capture_cancellation_is_not_reported_as_timeout`  (lines 458–506)

```
fn legacy_capture_cancellation_is_not_reported_as_timeout()
```

**Purpose**: This regression test checks that cancelling a sandbox capture is treated as cancellation, not as a timeout. That distinction matters because a user-requested stop should not look like the command exceeded its time limit.

**Data flow**: It creates a cancellation token backed by an atomic boolean, starts a helper thread that flips the boolean after a short delay, then runs a long PowerShell sleep command with a much longer timeout. It checks that the call returns quickly, that timed_out is false, and that the exit code is not successful.

**Call relations**: The test uses the capture API with a cancellation token instead of a normal session. It coordinates a background thread, the cancellation token, and the sandbox capture result to protect correct status reporting.

*Call graph*: calls 7 internal fn (workspace_write, new, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 11 external calls (clone, new, new, new, now, assert!, assert_ne!, run_windows_sandbox_capture, eprintln!, spawn (+1 more)).


##### `legacy_tty_powershell_emits_output_and_accepts_input`  (lines 509–563)

```
fn legacy_tty_powershell_emits_output_and_accepts_input()
```

**Purpose**: This test checks that an interactive PowerShell session in the legacy sandbox can print initial output, accept later input, and exit cleanly. A TTY is a terminal-like interface, not just a plain input/output pipe.

**Data flow**: It starts PowerShell in no-exit terminal mode, sends a second command through the session writer, then sends exit and closes stdin. It collects stdout and the exit code, then checks that the process succeeded and that both the initial and later outputs appeared.

**Call relations**: This is the main PowerShell terminal-session test. It uses the legacy spawner with tty and stdin_open enabled, then uses the shared output collector after driving the live session through its writer.

*Call graph*: calls 8 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_tty_cmd_emits_output_and_accepts_input`  (lines 567–614)

```
fn legacy_tty_cmd_emits_output_and_accepts_input()
```

**Purpose**: This ignored test is intended to check that interactive cmd.exe can print output and accept input in the legacy sandbox. It is currently disabled because of a known ConPTY failure in continuous integration; ConPTY is Windows’ pseudo-terminal system.

**Data flow**: When enabled, it would start cmd.exe in keep-open mode, send an echo command, send exit, close stdin, collect stdout and the exit code, and assert that both the startup and second outputs are present.

**Call relations**: It follows the same live-session pattern as the PowerShell TTY test, but targets cmd.exe. Because it is ignored, it documents desired behavior without currently running in normal test suites.

*Call graph*: calls 6 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_tty_cmd_default_desktop_emits_output_and_accepts_input`  (lines 618–668)

```
fn legacy_tty_cmd_default_desktop_emits_output_and_accepts_input()
```

**Purpose**: This ignored test is like the interactive cmd.exe test, but it runs without a private desktop. It checks the alternate desktop setting for legacy terminal sessions.

**Data flow**: When enabled, it would create the sandbox setup, start cmd.exe as an interactive terminal using the default desktop, send a second echo command and exit, then collect output and verify success plus expected text.

**Call relations**: This mirrors the private-desktop cmd.exe TTY test but flips the desktop option passed to the legacy spawner. It remains ignored for the same known ConPTY issue, while preserving coverage intent for that configuration.

*Call graph*: calls 6 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


### `core/tests/suite/windows_sandbox.rs`

`test` · `test run`

These tests act like safety inspections for Codex on Windows. Codex sometimes runs commands suggested by a model, so it must be able to keep those commands away from files they should not read or change. This file builds small temporary workspaces with public files, secret files, and a Codex home directory, then runs real Windows commands through Codex’s normal execution path.

There are two main scenarios. The first uses the lighter “restricted token” Windows sandbox. That sandbox can limit some permissions, but it cannot directly enforce “deny read” rules for exact files or file patterns. The test makes sure Codex refuses to run instead of silently running with weaker protection. That failure is important: a safe refusal is better than pretending a file is protected.

The second scenario uses the elevated Windows sandbox helper. It stages the helper programs needed for that mode, creates files that should and should not be readable, then runs a command that tries to read each one. It also tries to read and overwrite Codex’s sandbox setup marker, which records that the sandbox was prepared correctly. The expected result is that secret reads fail, public reads work, and the setup marker remains protected. In short, this file proves that Windows sandbox policy is enforced rather than just described.

#### Function details

##### `EnvVarGuard::set`  (lines 31–37)

```
fn set(key: &'static str, value: &std::ffi::OsStr) -> Self
```

**Purpose**: Temporarily changes an environment variable for a test and remembers what it used to be. This lets a test point Codex at a test-only home directory without permanently changing the process environment.

**Data flow**: It receives the environment variable name and the value to use. It reads the current value, sets the new value, and returns a small guard object containing the name and the saved old value. Later, that guard can restore the environment.

**Call relations**: The Windows sandbox tests call this when they need to set CODEX_HOME for the duration of the test. It relies on the operating system environment functions to read and set the variable, then hands the saved state to EnvVarGuard::drop for cleanup.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvVarGuard::drop`  (lines 41–48)

```
fn drop(&mut self)
```

**Purpose**: Restores an environment variable when the guard goes out of scope. This keeps one test’s CODEX_HOME setting from leaking into another test.

**Data flow**: It reads the saved original value inside the guard. If there was an original value, it writes that value back; if there was not, it removes the variable. The outside world is changed back to how it was before EnvVarGuard::set ran.

**Call relations**: Rust calls this automatically when an EnvVarGuard is no longer needed. It completes the cleanup story started by EnvVarGuard::set, using the system’s set and remove environment-variable operations.

*Call graph*: 2 external calls (remove_var, set_var).


##### `TestCodexHome::path`  (lines 57–62)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the actual filesystem path for the test Codex home directory, whether that home is a persistent directory or a temporary one.

**Data flow**: It receives a TestCodexHome value. If the value stores a normal path, it returns that path; if it stores a temporary directory object, it returns the temporary directory’s path. It does not create, delete, or modify anything.

**Call relations**: The tests use this after codex_home_for_windows_sandbox_test chooses what kind of directory to use. The returned path is passed into EnvVarGuard::set as CODEX_HOME and is also used when checking sandbox setup state.


##### `codex_home_for_windows_sandbox_test`  (lines 65–77)

```
fn codex_home_for_windows_sandbox_test(name: &str) -> anyhow::Result<TestCodexHome>
```

**Purpose**: Chooses and prepares a CODEX_HOME directory for Windows sandbox tests. CODEX_HOME is where Codex stores its own state, so these tests need a safe, isolated version of it.

**Data flow**: It receives a test-specific name. If the TEST_TMPDIR environment variable exists, it creates a stable directory under that location and returns it as a persistent test home. If TEST_TMPDIR is not set, it creates a fresh temporary directory and returns that instead. Errors, such as failure to create the directory, are reported to the caller.

**Call relations**: Both Windows sandbox tests call this at the start so they can isolate Codex’s state. It reads TEST_TMPDIR from the environment, creates directories when needed, and returns a TestCodexHome that the tests later turn into a path with TestCodexHome::path.

*Call graph*: called by 2 (windows_elevated_enforces_deny_read_and_protects_setup_marker, windows_restricted_token_rejects_exact_and_glob_deny_read_policy); 6 external calls (from, new, Persistent, Temporary, var_os, create_dir_all).


##### `stage_windows_sandbox_helpers`  (lines 79–115)

```
fn stage_windows_sandbox_helpers() -> anyhow::Result<()>
```

**Purpose**: Copies the helper executables needed by the elevated Windows sandbox into the place where the test executable expects to find resources. Without these helper programs, the elevated sandbox test could not exercise the real sandbox path.

**Data flow**: It finds the currently running test executable, derives a sibling codex-resources directory, creates that directory if needed, then locates the built helper binaries and copies them there with .exe names. If a helper is already present but locked by a still-running process, it keeps the existing copy instead of failing the retry.

**Call relations**: The elevated sandbox test calls this before running a sandboxed command. This function uses cargo_bin to locate built helper binaries and filesystem operations to create the resource directory and copy files, preparing the environment that process_exec_tool_call later depends on.

*Call graph*: called by 1 (windows_elevated_enforces_deny_read_and_protects_setup_marker); 5 external calls (new, cargo_bin, current_exe, copy, create_dir_all).


##### `windows_restricted_token_rejects_exact_and_glob_deny_read_policy`  (lines 119–197)

```
async fn windows_restricted_token_rejects_exact_and_glob_deny_read_policy() -> anyhow::Result<()>
```

**Purpose**: Checks that the unelevated Windows restricted-token sandbox refuses policies it cannot safely enforce. In particular, it verifies that deny-read rules for exact files and glob patterns are rejected instead of ignored.

**Data flow**: The test creates an isolated CODEX_HOME, a temporary workspace, a secret .env file, a future denied file path, and a public file. It builds a filesystem policy that allows general reading and project writing but denies the secret patterns and path. It then asks Codex to run a Windows command under the restricted-token sandbox. The expected output is not command output, but an error explaining that this sandbox mode cannot enforce those deny-read restrictions.

**Call relations**: This is a top-level async test. It calls codex_home_for_windows_sandbox_test to prepare state, EnvVarGuard::set to point CODEX_HOME at that state, builds a permission profile from the sandbox policy, and then calls process_exec_tool_call through Codex’s normal execution path. The final assertion confirms that the failure message is the safe one.

*Call graph*: calls 5 internal fn (set, process_exec_tool_call, codex_home_for_windows_sandbox_test, from_runtime_permissions, restricted); 7 external calls (new, new, assert_eq!, canonicalize, write, from_ref, vec!).


##### `windows_elevated_enforces_deny_read_and_protects_setup_marker`  (lines 201–322)

```
async fn windows_elevated_enforces_deny_read_and_protects_setup_marker() -> anyhow::Result<()>
```

**Purpose**: Checks that the elevated Windows sandbox really blocks denied reads and protects Codex’s own sandbox setup marker. It also confirms that normal allowed file reads still work.

**Data flow**: The test prepares CODEX_HOME, stages helper executables, creates a workspace with secret and public files, and builds a policy that denies one secret by glob pattern and another by exact path. It runs a Windows command that tries to read the denied files, read and overwrite the setup marker, and read the public file. The command should finish successfully, but its text output should show denied access for secrets and the marker, while still showing the public file content. The test then checks that Codex still reports sandbox setup as complete.

**Call relations**: This is a top-level async test for the elevated sandbox path. It depends on codex_home_for_windows_sandbox_test and EnvVarGuard::set for isolated Codex state, stage_windows_sandbox_helpers for required helper programs, PermissionProfile construction for the rules, and process_exec_tool_call to run the real sandboxed command. Afterward it uses sandbox_setup_is_complete to confirm the attempted marker tampering did not break the sandbox setup.

*Call graph*: calls 6 internal fn (set, process_exec_tool_call, codex_home_for_windows_sandbox_test, stage_windows_sandbox_helpers, from_runtime_permissions, restricted); 8 external calls (new, new, assert!, assert_eq!, canonicalize, write, from_ref, vec!).


### `exec-server/testing/wine_exec_server.rs`

`test` · `test setup and teardown`

Some tests need to exercise the Windows version of the exec-server, even when the test runner is not actually on Windows. Wine is a compatibility layer that lets Windows programs run on other operating systems. This file wraps that setup into one small helper so each test does not have to know how to launch the server, find its address, and clean it up afterward.

The main piece is `WineExecServer`, a tiny type with one async method, `scope`. Think of it like borrowing a meeting room: it opens the room, tells you where it is, lets you do your work, and then closes the room when you leave. The method finds the built test binary named `wine-windows-exec-server`, starts it through `WineTestCommand`, and sets `CODEX_HOME` to a Windows-style path so the server sees a realistic Windows environment.

After starting the process, it watches the server's standard output line by line. The server announces its WebSocket URL by printing a line beginning with `ws://`. Once that line appears, this helper passes the URL into the caller's async operation. If the server exits before printing the URL, the helper returns a clear error instead of leaving the test to fail mysteriously. The surrounding `scope` call makes sure the Wine process is torn down afterward.

#### Function details

##### `WineExecServer::scope`  (lines 16–42)

```
async fn scope(self, operation: F) -> Result<T>
```

**Purpose**: Starts the Windows exec-server under Wine, waits until it prints its WebSocket URL, runs the caller's test operation with that URL, and then shuts the server down. Tests use this when they need a real Windows exec-server to talk to for only a limited time.

**Data flow**: It receives an async operation that expects a WebSocket URL string. First it locates the `wine-windows-exec-server` binary, starts it in Wine with `CODEX_HOME` set to `C:\codex-home`, and takes the server's output stream. It reads that output one line at a time until it finds a line starting with `ws://`; that line becomes the URL passed into the caller's operation. The final result is whatever the caller's operation returns, or an error if the server cannot start, cannot report its URL, or the operation fails.

**Call relations**: This is the helper that test code calls when it needs a temporary Wine-backed exec-server. Inside, it asks `cargo_bin` to find the test executable, uses `WineTestCommand::new` to build the Wine process command, and uses a buffered line reader to watch the process output. Once the URL is found, it hands control to the caller's operation; the Wine command's own scoped runner keeps the child process alive during that operation and tears it down afterward.

*Call graph*: 3 external calls (new, new, cargo_bin).


### `core/tests/remote_env_windows/remote_env_windows_test.rs`

`test` · `integration test run`

This is a Bazel-only integration test file. Its job is to prove that the system can talk to a Windows-style execution server even when the test is running through Wine, which is a compatibility layer that lets Windows programs run on non-Windows systems. Without tests like this, Codex could appear to work on normal local folders but fail when asked to run tools inside a remote Windows environment.

The first test simulates a model asking Codex to run a command. The command checks that PowerShell is really running in `C:\windows`. The test wires Codex to a fake model server, points it at the Wine-backed exec server, selects the remote Windows environment, then waits for command-start and command-finish events. It confirms that Codex launched `pwsh.exe` with the expected arguments and that the command succeeded.

The second test checks a higher-level path: the app server API. It starts a test app server with the Windows exec-server URL in its environment, asks it to create a thread whose remote working folder is `C:\windows`, then starts a turn and waits for completion. A few assertions document current limitations with TODO comments: the thread-start response still reports the host folder, not the selected remote Windows folder.

#### Function details

##### `windows_exec_server_runs_with_native_shell_and_cwd`  (lines 50–173)

```
async fn windows_exec_server_runs_with_native_shell_and_cwd() -> Result<()>
```

**Purpose**: This test proves that when Codex is told to use the Windows remote environment, an `exec_command` tool call runs through the native Windows shell and starts in the requested Windows folder. It is a smoke test: a small end-to-end check that the important pieces are connected correctly.

**Data flow**: The test starts with a Wine-backed exec-server URL and a fake model server response that asks Codex to run a PowerShell command. It builds a test Codex session with the unified exec feature enabled, selects the remote Windows environment with `file:///C:/windows` as the working folder, and submits a user message. Codex turns the fake model's tool call into a real command run. The test then reads Codex events, captures the command begin and end messages, and verifies that the command was launched as `pwsh.exe -NoProfile -Command ...`, exited with code 0, and sent successful command output back to the model server.

**Call relations**: This function is run by the Tokio async test runner. Inside the temporary Wine exec-server scope, it calls the mock response-server helpers to imitate the model, uses `test_codex` support to create a Codex session, submits a user input operation, and repeatedly calls `wait_for_event` until the command and turn finish. It depends on the exec-server, Codex core, and mock model server all working together, which is why it catches integration problems that a smaller unit test would miss.


##### `app_server_starts_thread_with_windows_environment_native_cwd`  (lines 176–252)

```
async fn app_server_starts_thread_with_windows_environment_native_cwd() -> Result<()>
```

**Purpose**: This test proves that the app server can start a conversation thread when the requested environment is the Windows remote environment and the client gives a native Windows path like `C:\windows`. It checks the public app-server API path rather than the lower-level Codex test harness.

**Data flow**: The test creates a temporary Codex home folder, starts a fake model server that always answers `done`, writes a mock configuration file, and launches a test app server with the Windows exec-server URL in its environment variables. It sends a thread-start request that includes the remote Windows environment and a Windows-style working folder. The app server returns a thread-start response, which the test checks for a non-empty thread id and for the currently expected host-side folder values. Then the test sends a turn-start request with a simple text input, reads the turn-start response, and waits until the app server reports that the turn completed.

**Call relations**: This function is also run by the Tokio async test runner inside a `WineExecServer` scope. It drives the system through `TestAppServer`, which means it exercises the app-server protocol messages: initialize, thread start, turn start, and turn completed notification. The TODO-backed assertions show how this test both protects current behavior and marks known gaps, such as not yet returning the selected remote Windows working folder in the thread-start response.


### RMCP remote client flows
This final group focuses on RMCP client-side harnesses and end-to-end remote execution paths over stdio and streamable HTTP transports.

### `rmcp-client/tests/streamable_http_test_support.rs`

`test` · `integration test setup and test request execution`

The tests that use this file need more than small unit-test stubs. They need a real HTTP test server, sometimes a real local exec-server process, and a client that speaks the same protocol the production code uses. This file provides those building blocks so each test can focus on the behavior it wants to prove, such as retrying after a temporary failure or recovering from an expired session.

The file works like a test kitchen. One set of helpers starts the Streamable HTTP server on an unused local port and waits until it is actually accepting connections. Another set creates an RMCP client, sends the protocol's initialization message, and supplies a simple automatic answer for any elicitation prompt, meaning a server request for extra user input. Several “arm” helpers tell the test server to intentionally fail a future request, either with a plain HTTP error or with a JSON-RPC error, so recovery paths can be tested repeatably.

For remote-transport tests, the file can also launch `codex exec-server`, read the WebSocket address it prints, connect an `ExecServerClient`, and clean up the process when the test is done. Without this file, many tests would duplicate fragile setup code and would be more likely to race the server startup or leave child processes running.

#### Function details

##### `streamable_http_server_bin`  (lines 53–55)

```
fn streamable_http_server_bin() -> Result<PathBuf, CargoBinError>
```

**Purpose**: Finds the compiled test HTTP server program that the integration tests need to run. This keeps tests from hard-coding a path to the binary.

**Data flow**: It takes no input. It asks the Cargo test environment for the path to the `test_streamable_http_server` binary, then returns that path or an error if the binary cannot be found.

**Call relations**: When a test needs a server, `spawn_streamable_http_server` calls this first so it knows what program to launch.

*Call graph*: called by 1 (spawn_streamable_http_server); 1 external calls (cargo_bin).


##### `init_params`  (lines 57–70)

```
fn init_params() -> InitializeRequestParams
```

**Purpose**: Builds the standard initialization message used by these RMCP client tests. It describes what the test client can do and which protocol version it wants to speak.

**Data flow**: It starts with default client capabilities, adds support for elicitation forms, sets a test name and version, selects the protocol version, and returns the completed initialization parameters.

**Call relations**: Both `initialize_client` and `create_remote_client` use this when they perform the RMCP handshake with the server. It gives all tests a consistent starting conversation.

*Call graph*: called by 2 (create_remote_client, initialize_client); 3 external calls (default, new, new).


##### `expected_echo_result`  (lines 72–79)

```
fn expected_echo_result(message: &str) -> CallToolResult
```

**Purpose**: Creates the expected answer from the test server's `echo` tool for a given message. Tests use it to compare the real result with the known correct shape.

**Data flow**: It receives a message string. It builds a successful tool result whose structured JSON content contains `ECHOING: <message>` and a null environment field, then returns that result.

**Call relations**: This helper is not called by another helper in this file; individual tests can use it after `call_echo_tool` to make assertions clearer and less repetitive.

*Call graph*: 3 external calls (new, json!, success).


##### `create_client`  (lines 81–84)

```
async fn create_client(base_url: &str) -> anyhow::Result<RmcpClient>
```

**Purpose**: Creates a ready-to-use Streamable HTTP RMCP client for the normal local test path. It hides the details of choosing the default test HTTP implementation and initializing the client.

**Data flow**: It receives the server base URL. It gets the default test environment HTTP client, passes both to `create_client_with_http_client`, and returns the initialized RMCP client or an error.

**Call relations**: Many recovery and retry tests call this after starting the test server. It delegates the real construction work to `create_client_with_http_client` so tests that need a special HTTP transport can reuse the same setup.

*Call graph*: calls 2 internal fn (default_for_tests, create_client_with_http_client); called by 11 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_initialize_retries_json_rpc_transient_status, streamable_http_initialize_retries_transient_http_status, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_retries_initialized_notification_status, streamable_http_tools_list_retries_json_rpc_transient_status (+1 more)).


##### `create_client_with_http_client`  (lines 86–106)

```
async fn create_client_with_http_client(
    base_url: &str,
    http_client: Arc<dyn HttpClient>,
) -> anyhow::Result<RmcpClient>
```

**Purpose**: Creates a Streamable HTTP RMCP client using a caller-supplied HTTP transport. This is useful when tests need to send traffic through a special path, such as a remote execution HTTP API.

**Data flow**: It receives a base URL and an HTTP client object. It builds an RMCP client pointed at `<base_url>/mcp`, adds a test bearer token, uses file-based OAuth credential storage settings, initializes the client, and returns it.

**Call relations**: `create_client` uses this for the standard local case, and some tests call it directly when they need custom transport behavior. It hands off the protocol handshake to `initialize_client` before returning.

*Call graph*: calls 3 internal fn (default, new_streamable_http_client, initialize_client); called by 3 (streamable_http_initialize_retries_remote_no_response_error, streamable_http_session_recovery_retries_initialize_failure, create_client); 1 external calls (format!).


##### `initialize_client`  (lines 108–126)

```
async fn initialize_client(client: &RmcpClient) -> anyhow::Result<()>
```

**Purpose**: Performs the RMCP initialization handshake for an already-created client. This is the step that turns a constructed client into one that is ready to make tool calls.

**Data flow**: It receives an RMCP client reference. It builds standard initialization parameters, sets a five-second timeout, provides an automatic accept response for any elicitation request, sends the initialize call, and returns success or an error.

**Call relations**: `create_client_with_http_client` calls this during client setup, and other test helpers can call it when they need initialization as a separate step. It relies on `init_params` for the common protocol details.

*Call graph*: calls 2 internal fn (initialize, init_params); called by 2 (oauth_startup_child, create_client_with_http_client); 2 external calls (new, from_secs).


##### `create_remote_client`  (lines 130–165)

```
async fn create_remote_client(
    base_url: &str,
    http_client: ExecServerClient,
) -> anyhow::Result<RmcpClient>
```

**Purpose**: Creates a Streamable HTTP RMCP client whose HTTP traffic goes through an exec-server client instead of directly through the local HTTP stack. This tests the remote runtime path using real protocol traffic.

**Data flow**: It receives the test server base URL and a connected `ExecServerClient`. It wraps that exec-server client as the HTTP transport, creates an RMCP client pointed at `<base_url>/mcp`, initializes it with the standard parameters and elicitation answer, and returns the ready client.

**Call relations**: The remote round-trip integration test calls this after `spawn_exec_server` has produced an `ExecServerClient`. It performs the same kind of handshake as `initialize_client`, but inlined for the remote-client construction path.

*Call graph*: calls 3 internal fn (default, new_streamable_http_client, init_params); called by 1 (streamable_http_remote_client_round_trips_through_exec_server); 4 external calls (new, new, from_secs, format!).


##### `call_echo_tool`  (lines 167–179)

```
async fn call_echo_tool(
    client: &RmcpClient,
    message: &str,
) -> anyhow::Result<CallToolResult>
```

**Purpose**: Calls the test server's `echo` tool with a message. It gives tests a simple, repeatable request to prove that the client and server can talk successfully.

**Data flow**: It receives an initialized RMCP client and a message. It sends a tool call named `echo` with JSON arguments containing that message, waits up to five seconds, and returns the server's tool result or an error.

**Call relations**: Most retry and recovery tests use this after creating a client or arming a failure. It is the visible action that shows whether the client recovered and completed the request.

*Call graph*: calls 1 internal fn (call_tool); called by 12 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_initialize_retries_json_rpc_transient_status, streamable_http_initialize_retries_remote_no_response_error, streamable_http_initialize_retries_transient_http_status, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_retries_initialized_notification_status (+2 more)); 2 external calls (from_secs, json!).


##### `arm_session_post_failure`  (lines 181–199)

```
async fn arm_session_post_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
    www_authenticate_headers: &[&str],
) -> anyhow::Result<()>
```

**Purpose**: Tells the test server to make upcoming session POST requests fail in a controlled way. Tests use this to check how the client reacts to HTTP failures such as unauthorized, forbidden, or not found responses.

**Data flow**: It receives the server base URL, an HTTP status code, a count of how many failures should remain, and optional `WWW-Authenticate` header values. It POSTs that configuration to the server's control endpoint and asserts that the server accepted it with a no-content response.

**Call relations**: Session recovery tests call this before making a request such as `call_echo_tool` or listing tools. It programs the server's next behavior so the client can be tested against a predictable failure.

*Call graph*: calls 1 internal fn (new); called by 8 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_session_recovery_retries_initialize_failure, streamable_http_tools_list_retries_transient_http_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_session_post_json_rpc_failure`  (lines 201–226)

```
async fn arm_session_post_json_rpc_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Tells the test server to fail upcoming session POST requests with a JSON-RPC error body. JSON-RPC is the message format used by the protocol, so this tests failures reported inside a normal-looking protocol response.

**Data flow**: It receives the server base URL, an HTTP status code, and a failure count. It sends a control request that includes a JSON content type and a JSON-RPC error message saying there was a transient session failure, then checks that the control request was accepted.

**Call relations**: The tools-list transient JSON-RPC retry test calls this before making the request under test. It lets that test verify retry behavior when the server reports a temporary protocol-level error.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_tools_list_retries_json_rpc_transient_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_initialized_notification_post_json_rpc_failure`  (lines 228–255)

```
async fn arm_initialized_notification_post_json_rpc_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Tells the test server to fail the initialized-notification POST with a JSON-RPC error. This checks the client's retry behavior during the final notification part of startup.

**Data flow**: It receives the server base URL, an HTTP status code, and a count of failures to inject. It sends those settings, plus a JSON-RPC transient failure body, to the initialized-notification control endpoint and verifies the server accepted them.

**Call relations**: The initialized-notification retry test calls this before client initialization reaches that notification step. The helper prepares the exact server failure that the test wants the client to survive.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_retries_initialized_notification_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_initialize_post_failure`  (lines 257–273)

```
async fn arm_initialize_post_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Tells the test server to fail upcoming initialize POST requests with a plain HTTP status. Tests use this to prove that startup retries work for temporary HTTP failures.

**Data flow**: It receives the base URL, status code, and remaining failure count. It sends that configuration to the initialize failure control endpoint and asserts that the server returned no content, meaning the failure rule was installed.

**Call relations**: The initialize retry test calls this before creating or initializing a client. The later client startup attempt then runs into the programmed failure.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_initialize_retries_transient_http_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_initialize_post_json_rpc_failure`  (lines 275–300)

```
async fn arm_initialize_post_json_rpc_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Tells the test server to fail upcoming initialize requests with a JSON-RPC error body. This tests startup retry behavior when the failure is expressed by the protocol rather than only by HTTP.

**Data flow**: It receives the base URL, status code, and failure count. It sends a control request containing a JSON-RPC error message for a transient initialize failure, then confirms the test server accepted the setup.

**Call relations**: The JSON-RPC initialize retry test calls this before client creation. When initialization runs, the server returns the programmed protocol error and the test can check whether the client retries correctly.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_initialize_retries_json_rpc_transient_status); 3 external calls (assert_eq!, format!, json!).


##### `spawn_streamable_http_server`  (lines 302–316)

```
async fn spawn_streamable_http_server() -> anyhow::Result<(Child, String)>
```

**Purpose**: Starts the local Streamable HTTP test server on an available port and returns both the child process and its base URL. This gives tests a real server without requiring a fixed port.

**Data flow**: It first binds to `127.0.0.1:0` to let the operating system choose a free port, records that port, closes the temporary listener, launches the test server binary with the chosen bind address in an environment variable, waits until the server accepts TCP connections, and returns the running process plus `http://host:port`.

**Call relations**: Most integration tests call this at the beginning. It uses `streamable_http_server_bin` to find the executable and `wait_for_streamable_http_server` to avoid racing ahead before the server is ready.

*Call graph*: calls 2 internal fn (streamable_http_server_bin, wait_for_streamable_http_server); called by 14 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_initialize_retries_json_rpc_transient_status, streamable_http_initialize_retries_remote_no_response_error, streamable_http_initialize_retries_transient_http_status, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_retries_initialized_notification_status (+4 more)); 4 external calls (from_secs, bind, new, format!).


##### `ExecServerProcess::drop`  (lines 327–329)

```
fn drop(&mut self)
```

**Purpose**: Stops the local exec-server process when its wrapper object is dropped. This is cleanup code that helps tests avoid leaving background processes behind.

**Data flow**: It receives mutable access to the `ExecServerProcess` during destruction. It asks the child process to start killing itself and ignores any error because cleanup is best-effort at test shutdown.

**Call relations**: Tests that call `spawn_exec_server` receive an `ExecServerProcess`. When that value goes out of scope, this method runs automatically and tears down the process that was started for the remote-client test.

*Call graph*: 1 external calls (start_kill).


##### `spawn_exec_server`  (lines 333–356)

```
async fn spawn_exec_server() -> anyhow::Result<ExecServerProcess>
```

**Purpose**: Starts a real `codex exec-server` process and connects an `ExecServerClient` to it. This lets tests verify the remote HTTP path using the same kind of local service used outside tests.

**Data flow**: It creates a temporary Codex home directory, launches the `codex` binary with `exec-server --listen ws://127.0.0.1:0`, captures standard output, reads the WebSocket listen URL printed by the server, connects an `ExecServerClient` to that URL, and returns an `ExecServerProcess` containing the temp directory, child process, and connected client.

**Call relations**: The remote round-trip test calls this before `create_remote_client`. It relies on `read_exec_server_listen_url` to discover where the child process is listening, then hands the connected client to the remote RMCP client setup.

*Call graph*: calls 1 internal fn (read_exec_server_listen_url); called by 1 (streamable_http_remote_client_round_trips_through_exec_server); 8 external calls (inherit, null, piped, new, new, cargo_bin, connect_websocket, new).


##### `read_exec_server_listen_url`  (lines 359–382)

```
async fn read_exec_server_listen_url(child: &mut Child) -> anyhow::Result<String>
```

**Purpose**: Waits for the exec-server process to print the WebSocket URL it is listening on. This turns the child process's startup message into a usable connection address.

**Data flow**: It receives the child process, takes its captured standard output, reads lines until a deadline, and returns the first trimmed line that starts with `ws://`. If output closes or the deadline passes first, it returns a clear error.

**Call relations**: `spawn_exec_server` calls this immediately after launching `codex exec-server`. Once this function returns the URL, `spawn_exec_server` can connect the `ExecServerClient`.

*Call graph*: called by 1 (spawn_exec_server); 5 external calls (new, from_secs, now, bail!, timeout).


##### `wait_for_streamable_http_server`  (lines 384–423)

```
async fn wait_for_streamable_http_server(
    server_child: &mut Child,
    address: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Waits until the Streamable HTTP test server is actually reachable. This prevents tests from failing just because they tried to connect a few milliseconds too early.

**Data flow**: It receives the server child process, address, and timeout. In a loop, it first checks whether the server has already exited, then tries to open a TCP connection before the deadline, waits briefly between attempts, and returns success when a connection works or an error if the server exits or the timeout expires.

**Call relations**: `spawn_streamable_http_server` calls this after launching the server and before returning to a test. It is the readiness gate that makes later client creation and tool calls reliable.

*Call graph*: called by 1 (spawn_streamable_http_server); 7 external calls (try_wait, from_millis, now, connect, anyhow!, sleep, timeout).


### `rmcp-client/tests/streamable_http_remote.rs`

`test` · `test run`

This test proves that several moving parts can work together in the same way they would in a real run. The RMCP client needs to talk to an MCP server over Streamable HTTP, but in this remote mode it does not make the HTTP requests directly. Instead, it sends the work through an exec-server process, which owns the actual network calls. You can think of the exec-server like a courier: the client prepares the request, the courier carries it to the server, and the response comes back through the same route.

The test starts two real pieces of infrastructure: a small Streamable HTTP test server and a local exec-server process. It then builds a client configured to use that exec-server-backed transport, initializes the client, and asks the server to run a simple echo tool. The echo tool is useful because it gives a clear, predictable answer: if the client sends "remote", the expected result should contain that same value in the normal RMCP response shape.

Without this test, the project could accidentally keep the direct HTTP path working while breaking the remote executor path. This matters because the remote path has extra boundaries, process communication, and request forwarding that unit tests or direct local calls may not catch.

#### Function details

##### `streamable_http_remote_client_round_trips_through_exec_server`  (lines 21–37)

```
async fn streamable_http_remote_client_round_trips_through_exec_server() -> anyhow::Result<()>
```

**Purpose**: This test checks that an RMCP client can initialize and call a tool through the remote Streamable HTTP route. It specifically verifies that the request travels through a real exec-server process and still returns the expected echo response.

**Data flow**: The test starts with no running test infrastructure. It first creates a Streamable HTTP test server and gets its base URL, then starts an exec-server process. Using those two pieces, it creates a remote RMCP client. The client sends the text "remote" to an echo tool, receives the tool result, and the test compares that result with the known expected echo output. If the values match, the test finishes successfully; if not, the assertion fails.

**Call relations**: This is the top-level test function that coordinates the full scenario. It calls `spawn_streamable_http_server` to provide a real MCP server, then `spawn_exec_server` to provide the separate process that will perform HTTP work. It passes both into `create_remote_client`, then uses `call_echo_tool` to prove the client can make a real tool call. Finally, it uses `assert_eq!` to confirm that the returned value matches `expected_echo_result` for the same input.

*Call graph*: calls 4 internal fn (call_echo_tool, create_remote_client, spawn_exec_server, spawn_streamable_http_server); 1 external calls (assert_eq!).


### `rmcp-client/tests/process_group_cleanup.rs`

`test` · `test execution on Unix`

This file tests a practical safety issue: when the client starts a local server through standard input and output, that server may start more processes of its own. If the client goes away, those processes must not be left behind like forgotten background jobs. Otherwise test runs, user machines, or long-running Codex sessions could slowly collect stray `sleep`, shell, or server processes.

The tests use temporary files as simple signposts. A launched process writes its process ID, or PID, into a file. The test then reads that PID and asks the operating system whether the process is still alive. On Unix, it uses `kill -0`, which does not actually kill anything; it is more like asking, "does this process exist?"

There are two main scenarios. The first starts `/bin/sh`, which starts a long `sleep` process. The test drops the client and checks that the grandchild `sleep` process exits too, proving the whole process group was cleaned up. The second starts the test MCP stdio server, initializes it, begins a long-running tool call, then shuts the client down. It checks that shutdown kills the server and that the blocked tool call does not hang forever. Together, these tests protect the cleanup behavior that keeps local process-based MCP servers from becoming orphaned.

#### Function details

##### `stdio_server_bin`  (lines 23–25)

```
fn stdio_server_bin() -> Result<std::path::PathBuf>
```

**Purpose**: Finds the compiled helper program named `test_stdio_server` so the test can launch it like a real local server. This avoids hard-coding a path that may differ between developer machines and CI systems.

**Data flow**: It takes no direct input. It asks Cargo's test helper to locate the `test_stdio_server` binary, then returns that path wrapped in the test's standard error-aware result type. If the binary cannot be found, the error is passed upward.

**Call relations**: The initialized-server shutdown test calls this when it is ready to start a real test MCP server. The path it returns is handed into `RmcpClient::new_stdio_client`, which starts the server process for the rest of the test.

*Call graph*: called by 1 (shutdown_kills_initialized_stdio_server_with_in_flight_operation); 1 external calls (cargo_bin).


##### `init_params`  (lines 27–33)

```
fn init_params() -> InitializeRequestParams
```

**Purpose**: Builds the initialization message that identifies this test client to the MCP server. It gives the server basic client capabilities, a name, a version, a title, and the protocol version to use.

**Data flow**: It starts with default client capabilities and a small client identity called `codex-test`. It adds a human-readable title and pins the protocol version, then returns the completed initialization parameters.

**Call relations**: The initialized-server shutdown test calls this just before `client.initialize`. Its output is the setup packet that lets the server and client agree on how they will speak before the long-running tool call is started.

*Call graph*: called by 1 (shutdown_kills_initialized_stdio_server_with_in_flight_operation); 3 external calls (default, new, new).


##### `process_exists`  (lines 35–43)

```
fn process_exists(pid: u32) -> bool
```

**Purpose**: Checks whether a Unix process with a given PID is still alive. It uses the `kill -0` convention, which asks the operating system about a process without sending it a real terminating signal.

**Data flow**: It receives a process ID number. It runs the system `kill` command with `-0` and hides any error text. If the command succeeds, it returns `true`; if the command fails or cannot be run, it returns `false`.

**Call relations**: This is the low-level process checker used by `wait_for_process_exit`. The tests do not call it directly when waiting for cleanup; instead, they rely on the waiting helper to repeatedly ask this question until the process disappears.

*Call graph*: called by 1 (wait_for_process_exit); 2 external calls (new, null).


##### `wait_for_pid_file`  (lines 45–70)

```
async fn wait_for_pid_file(path: &Path) -> Result<u32>
```

**Purpose**: Waits until a process writes its PID into a known file, then reads and returns that PID. This lets the test learn the identity of a child process that was started indirectly.

**Data flow**: It receives a file path. Up to about five seconds, it repeatedly tries to read the file. If the file is missing or empty, it sleeps briefly and tries again. Once the file contains text, it trims the text, parses it as a process ID, and returns that number. If reading fails unexpectedly, parsing fails, or the timeout is reached, it returns an error.

**Call relations**: Both process-cleanup tests use this after launching a client-controlled process. The returned PID becomes the thing they later check with `wait_for_process_exit`, so this helper bridges between the launched process and the cleanup assertion.

*Call graph*: called by 2 (drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation); 4 external calls (from_millis, bail!, read_to_string, sleep).


##### `wait_for_process_exit`  (lines 72–81)

```
async fn wait_for_process_exit(pid: u32) -> Result<()>
```

**Purpose**: Waits for a known process to stop running. It gives cleanup a short grace period instead of assuming the process must vanish instantly.

**Data flow**: It receives a process ID. It repeatedly calls `process_exists`; if the process is gone, it returns success. If the process is still present, it sleeps briefly and checks again. If the process remains alive after the retry window, it returns an error saying the process is still running.

**Call relations**: Both tests call this after dropping or shutting down the client. It turns the raw process existence check into a clear test verdict: cleanup either happened in time, or the test fails.

*Call graph*: calls 1 internal fn (process_exists); called by 2 (drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation); 3 external calls (from_millis, bail!, sleep).


##### `drop_kills_wrapper_process_group`  (lines 84–116)

```
async fn drop_kills_wrapper_process_group() -> Result<()>
```

**Purpose**: Verifies that simply dropping an `RmcpClient` kills not only the wrapper process it started, but also a background process created by that wrapper. This protects against orphaned grandchildren, which are easy to miss in process cleanup code.

**Data flow**: It creates a temporary directory and a PID file path. It starts `/bin/sh` through `RmcpClient::new_stdio_client`; the shell launches a long `sleep`, writes that child PID into the file, and then waits on standard input. The test reads the grandchild PID, confirms it is alive, drops the client, and then waits until that PID no longer exists. Success means the client cleanup reached the whole process group.

**Call relations**: This is a top-level asynchronous test run by the test framework. It uses `wait_for_pid_file` to discover the shell's background child, then uses `wait_for_process_exit` to prove that dropping the client caused that child process to exit.

*Call graph*: calls 4 internal fn (new_stdio_client, new, wait_for_pid_file, wait_for_process_exit); 7 external calls (new, from, from, assert!, current_dir, tempdir, vec!).


##### `shutdown_kills_initialized_stdio_server_with_in_flight_operation`  (lines 119–180)

```
async fn shutdown_kills_initialized_stdio_server_with_in_flight_operation() -> Result<()>
```

**Purpose**: Checks that an initialized local MCP server is killed during client shutdown even while a tool call is still running. It also checks that the in-flight call task does not stay stuck forever after shutdown.

**Data flow**: It creates a temporary PID file and starts the compiled `test_stdio_server` through `RmcpClient::new_stdio_client`, passing an environment variable that tells the server where to write its PID. It initializes the client with test parameters and a simple elicitation callback that always accepts. After confirming the server process is alive, it starts a tool call designed to sleep for a very long time. Then it shuts the client down, waits for the server PID to disappear, and waits briefly for the spawned call task to finish or be cancelled.

**Call relations**: This is the fuller end-to-end cleanup test. It calls `stdio_server_bin` to find the test server, `init_params` to prepare the MCP handshake, `wait_for_pid_file` to learn the server PID, and `wait_for_process_exit` to confirm shutdown killed it. The long-running `call_tool` operation creates the important pressure case: shutdown must work even when work is still in progress.

*Call graph*: calls 6 internal fn (new_stdio_client, new, init_params, stdio_server_bin, wait_for_pid_file, wait_for_process_exit); 15 external calls (clone, new, new, from_millis, from_secs, from, from, new, assert!, json! (+5 more)).
