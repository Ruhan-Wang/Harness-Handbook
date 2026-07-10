# Exec-server, sandbox, and remote transport harnesses  `stage-23.4`

This stage is the system’s proving ground for running code outside the main app. It sits in shared behind-the-scenes support, but it checks many paths the system depends on later: starting an exec-server, talking to it over WebSocket or stdio, moving files, making HTTP requests, and running commands inside sandboxes or on remote machines.

The common test helpers boot fake helper programs, launch real exec-server processes, and let tests send JSON-RPC messages, which are structured request-and-response messages. From there, several groups check the server’s basic contract: initialize, health, WebSocket behavior, process start and stop, and the lower-level handler logic that keeps sessions and child processes straight.

Another group tests file access. Shared support runs the same scenarios against local and remote filesystems, plus Unix and Windows edge cases, URI path handling, and streamed file reads. Transport-focused tests check HTTP-over-RPC helpers, stdio-to-socket bridging, and remote-control message chunking.

Finally, the relay, Noise encryption, and remote-environment tests verify secure remote links, reconnect behavior, and encrypted traffic. Sandbox tests on Linux, macOS, Windows, and Wine make sure restricted execution really enforces the intended rules.

## Files in this stage

### Exec-server harness foundations
These files establish the reusable exec-server test harnesses and then validate the server's basic transport, initialization, health, and core handler behavior.

### `exec-server/tests/common/mod.rs`

`test` · `test binary initialization and helper-process dispatch`

This module is loaded by the test binary itself and uses a `#[ctor]` static initializer to configure dispatch behavior before tests run. `TEST_BINARY_DISPATCH_GUARD` calls `configure_test_binary_dispatch` so the current test executable can stand in for helper binaries such as the filesystem helper or Linux sandbox executable, choosing `DispatchArg0Only` for those special names and `InstallAliases` otherwise. During that same initialization it opportunistically checks whether the process was launched in one of two helper modes. `maybe_run_delayed_output_after_exit_from_test_binary` inspects argv for parent/child sentinel flags used by process tests: the parent mode respawns the current executable in child mode and exits immediately, while the child mode polls for a release file and only then writes `late output after exit` to stdout. This simulates output arriving after the original parent process has exited but before all inherited streams are closed.

The other embedded mode is `exec-server`. `maybe_run_exec_server_from_test_binary` validates the exact `exec-server --listen <url>` argument shape, resolves runtime paths using `ExecServerRuntimePaths::new` and `linux_sandbox_exe`, builds a Tokio runtime manually, and runs `codex_exec_server::run_main`, exiting the process with status 0 or 1 after printing any startup/runtime errors to stderr. `current_test_binary_helper_paths` exposes the current executable and optional Linux sandbox alias so other test harnesses can spawn this same binary as a helper. The file is therefore the glue that makes one compiled test binary serve as both test runner and helper-process host.

#### Function details

##### `current_test_binary_helper_paths`  (lines 40–51)

```
fn current_test_binary_helper_paths() -> anyhow::Result<(PathBuf, Option<PathBuf>)>
```

**Purpose**: Returns the current test executable path plus the Linux sandbox helper path that spawned helpers should use.

**Data flow**: Reads `env::current_exe()`, then on Linux prefers the dispatch guard's `codex_linux_sandbox_exe` alias and falls back to the current executable; on non-Linux it returns `None` for the sandbox executable. It returns a tuple `(PathBuf, Option<PathBuf>)` or propagates `current_exe` errors.

**Call relations**: Called by test harness code that needs to spawn helper binaries from the current test executable. Its output feeds both exec-server harness setup and process tests that launch the binary in helper modes.

*Call graph*: called by 2 (assert_exec_process_retains_output_after_exit_until_streams_close, remote_environment_routes_encrypted_exec_server_rpc); 2 external calls (cfg!, current_exe).


##### `maybe_run_delayed_output_after_exit_from_test_binary`  (lines 53–70)

```
fn maybe_run_delayed_output_after_exit_from_test_binary()
```

**Purpose**: Detects whether the current process invocation is one of the delayed-output helper modes and, if so, runs that helper behavior instead of continuing as a normal test binary.

**Data flow**: Consumes `env::args()`, skips argv0, and matches the next argument against the parent and child sentinel flags. For either recognized mode it parses the remaining release-path argument via `next_release_path_arg` and dispatches to the corresponding helper runner; otherwise it returns without side effects.

**Call relations**: Invoked during static initialization from `TEST_BINARY_DISPATCH_GUARD`. It is the top-level dispatcher for the delayed-output helper subprocesses used by exec-process tests.

*Call graph*: calls 3 internal fn (next_release_path_arg, run_delayed_output_after_exit_child, run_delayed_output_after_exit_parent); 1 external calls (args).


##### `next_release_path_arg`  (lines 72–82)

```
fn next_release_path_arg(mut args: impl Iterator<Item = String>) -> PathBuf
```

**Purpose**: Parses the single required release-path argument for delayed-output helper modes and terminates the process on malformed input.

**Data flow**: Consumes an iterator of `String`, extracts exactly one path argument, rejects missing or extra arguments by printing to stderr and exiting with code 1, and otherwise converts the string into a `PathBuf`.

**Call relations**: Used only by `maybe_run_delayed_output_after_exit_from_test_binary` to enforce the strict CLI shape expected by both delayed-output helper modes.

*Call graph*: called by 1 (maybe_run_delayed_output_after_exit_from_test_binary); 4 external calls (next, from, eprintln!, exit).


##### `run_delayed_output_after_exit_parent`  (lines 84–104)

```
fn run_delayed_output_after_exit_parent(release_path: &Path)
```

**Purpose**: Implements the parent helper mode by spawning the current test binary in child mode and then exiting immediately.

**Data flow**: Resolves `env::current_exe()`, builds a `std::process::Command` targeting that executable with the child sentinel flag and release path, nulls stdin, and spawns it. On success it exits the current process with code 0; on failure to resolve or spawn it prints an error and exits with code 1.

**Call relations**: Reached from `maybe_run_delayed_output_after_exit_from_test_binary` when the parent sentinel flag is present. It exists to create a child process that can keep stdout alive after the parent exits.

*Call graph*: called by 1 (maybe_run_delayed_output_after_exit_from_test_binary); 5 external calls (null, new, current_exe, eprintln!, exit).


##### `run_delayed_output_after_exit_child`  (lines 106–127)

```
fn run_delayed_output_after_exit_child(release_path: &Path)
```

**Purpose**: Waits for a release file to appear, then emits a line of stdout and exits, simulating delayed output after the original parent process has already terminated.

**Data flow**: Receives a release-path reference, loops up to 1,000 times sleeping 10 ms between checks, and tests `release_path.exists()`. Once the file appears it locks stdout, writes `late output after exit`, flushes, and exits 0; write/flush failures or timeout produce stderr diagnostics and exit 1.

**Call relations**: Reached from `maybe_run_delayed_output_after_exit_from_test_binary` in child mode. Process tests use this behavior to verify that exec output remains readable after process exit until inherited streams close.

*Call graph*: called by 1 (maybe_run_delayed_output_after_exit_from_test_binary); 7 external calls (from_millis, exists, eprintln!, stdout, exit, sleep, writeln!).


##### `maybe_run_exec_server_from_test_binary`  (lines 129–192)

```
fn maybe_run_exec_server_from_test_binary(guard: Option<&TestBinaryDispatchGuard>)
```

**Purpose**: Detects `exec-server --listen <url>` invocations of the test binary and runs the real exec-server main function inside this process.

**Data flow**: Parses `env::args()` after argv0, returns early unless the first argument is exactly `exec-server`, then validates the `--listen` flag, extracts the listen URL, and rejects extra arguments with stderr+exit. It resolves `current_exe`, computes runtime paths with `ExecServerRuntimePaths::new(current_exe.clone(), linux_sandbox_exe(...))`, builds a multi-thread Tokio runtime, runs `codex_exec_server::run_main(&listen_url, runtime_paths)` with `block_on`, maps success to exit code 0 and failure to stderr plus exit code 1, and terminates the process.

**Call relations**: Called during static initialization so helper subprocesses can immediately switch into exec-server mode before any tests execute. It depends on `linux_sandbox_exe` to supply the optional sandbox helper path and on the dispatch guard to know whether aliases were installed.

*Call graph*: calls 2 internal fn (new, linux_sandbox_exe); 6 external calls (run_main, args, current_exe, eprintln!, exit, new_multi_thread).


##### `linux_sandbox_exe`  (lines 194–210)

```
fn linux_sandbox_exe(
    guard: Option<&TestBinaryDispatchGuard>,
    current_exe: &std::path::Path,
) -> Option<PathBuf>
```

**Purpose**: Computes the Linux sandbox executable path to embed in exec-server runtime paths, with platform-specific behavior.

**Data flow**: On Linux, it prefers the dispatch guard's `codex_linux_sandbox_exe` alias and otherwise falls back to `current_exe.to_path_buf()`. On non-Linux, it ignores both inputs and returns `None`.

**Call relations**: Used only by `maybe_run_exec_server_from_test_binary` while constructing `ExecServerRuntimePaths`. It isolates the conditional compilation and fallback logic for sandbox helper resolution.

*Call graph*: called by 1 (maybe_run_exec_server_from_test_binary).


### `exec-server/tests/common/exec_server.rs`

`test` · `integration test setup, request/response exchange, teardown`

This file is the core test plumbing for exec-server integration tests. `ExecServerHarness` owns the temporary `CODEX_HOME`, helper binary paths, spawned `tokio::process::Child`, discovered listen URL, active `tokio_tungstenite` WebSocket stream, and a monotonically increasing integer request ID counter. Construction starts in `exec_server_with_env`: it resolves helper paths from the current test binary, creates a temp home directory, spawns the test binary in `exec-server --listen ws://127.0.0.1:0` mode with stdout piped, reads stdout until a `ws://` line appears, then repeatedly attempts WebSocket connection until the server is ready or a 10-second deadline expires. `exec_server` is the default no-extra-env wrapper.

Once running, the harness exposes both protocol-level and raw transport operations. `send_request` and `send_notification` build `JSONRPCRequest`/`JSONRPCNotification` values and serialize them through `send_message`; raw text and binary frame helpers bypass JSON encoding. Incoming frames are consumed by `next_event_with_timeout`, which ignores ping/pong traffic, parses text or binary payloads as `JSONRPCMessage`, and treats close or stream termination as errors. `wait_for_event` repeatedly polls until a predicate matches or the event deadline expires. Lifecycle cleanup is defensive: `Drop` issues `start_kill`, `disconnect_websocket` closes the socket, `reconnect_websocket` reconnects to the same URL, and `shutdown` kills the child and waits for process exit under timeout. The design assumes the server prints its listen URL on stdout and that tests need deterministic failure messages for startup, disconnect, and timeout conditions.

#### Function details

##### `ExecServerHarness::drop`  (lines 41–43)

```
fn drop(&mut self)
```

**Purpose**: Best-effort kills the spawned exec-server process when the harness is dropped.

**Data flow**: Reads the owned `child` field and invokes `start_kill()` on it, discarding any error. It returns no value and writes only the side effect of initiating process termination.

**Call relations**: This destructor runs automatically when an `ExecServerHarness` leaves scope, including failure paths in tests. It complements explicit `shutdown` by ensuring the subprocess does not outlive the harness.

*Call graph*: 1 external calls (start_kill).


##### `test_codex_helper_paths`  (lines 51–57)

```
fn test_codex_helper_paths() -> anyhow::Result<TestCodexHelperPaths>
```

**Purpose**: Resolves the helper executable paths that tests should use when spawning the exec-server and related sandbox helpers.

**Data flow**: Calls `super::current_test_binary_helper_paths()` to obtain the current test binary path and optional Linux sandbox executable, then wraps them into `TestCodexHelperPaths { codex_exe, codex_linux_sandbox_exe }`. It returns that struct or propagates resolution errors.

**Call relations**: This helper is used during harness creation in `exec_server_with_env` and by filesystem test support elsewhere. It centralizes the mapping from the current test binary to the helper paths expected by spawned subprocesses.

*Call graph*: called by 2 (exec_server_with_env, create_file_system_context); 1 external calls (current_test_binary_helper_paths).


##### `exec_server`  (lines 59–61)

```
async fn exec_server() -> anyhow::Result<ExecServerHarness>
```

**Purpose**: Creates an `ExecServerHarness` with no additional environment overrides.

**Data flow**: Supplies an empty iterator of environment pairs to `exec_server_with_env` and returns the resulting harness. It adds no state of its own.

**Call relations**: Many integration tests call this convenience wrapper when they need a default exec-server instance. It exists to avoid repeating the empty-env setup used by `exec_server_with_env`.

*Call graph*: calls 1 internal fn (exec_server_with_env); called by 24 (create_process_context, completed_streams_release_handle_capacity, file_reads_reject_fifo_without_waiting_for_a_writer, file_reads_reject_named_pipes, open_enforces_the_per_connection_limit_and_close_releases_capacity, open_rejects_handle_ids_longer_than_32_bytes, read_block_supports_non_sequential_offsets_and_lengths, stream_keeps_reading_the_open_file_after_path_replacement, stream_rejects_platform_sandbox, stream_stops_after_an_exact_block_boundary (+14 more)).


##### `exec_server_with_env`  (lines 63–91)

```
async fn exec_server_with_env(env: I) -> anyhow::Result<ExecServerHarness>
```

**Purpose**: Launches the exec-server subprocess with caller-specified extra environment variables and returns a connected harness.

**Data flow**: Accepts any iterable of `(K, V)` environment entries, resolves helper paths, creates a `TempDir` for `CODEX_HOME`, builds a `tokio::process::Command` targeting the helper binary in `exec-server --listen ws://127.0.0.1:0` mode, configures stdio and `kill_on_drop`, injects `CODEX_HOME` plus the provided envs, and spawns the child. It then reads the listen URL from stdout, connects a WebSocket once the server is accepting connections, and returns a fully populated `ExecServerHarness` with `next_request_id` initialized to 1.

**Call relations**: This is the main constructor behind `exec_server` and specialized tests that need environment overrides. It delegates startup synchronization to `read_listen_url_from_stdout` and `connect_websocket_when_ready` so callers receive a harness only after the server is reachable.

*Call graph*: calls 3 internal fn (connect_websocket_when_ready, read_listen_url_from_stdout, test_codex_helper_paths); called by 2 (exec_server, sandboxed_file_system_helper_finds_bwrap_on_preserved_path); 5 external calls (inherit, null, piped, new, new).


##### `ExecServerHarness::websocket_url`  (lines 94–96)

```
fn websocket_url(&self) -> &str
```

**Purpose**: Returns the discovered WebSocket listen URL for the running exec-server.

**Data flow**: Borrows `self.websocket_url` and returns it as `&str` without modification. It does not mutate harness state.

**Call relations**: Tests and helper constructors call this accessor when they need to connect higher-level clients or environments to the already-running server.


##### `ExecServerHarness::disconnect_websocket`  (lines 98–101)

```
async fn disconnect_websocket(&mut self) -> anyhow::Result<()>
```

**Purpose**: Closes the current WebSocket connection while leaving the exec-server subprocess running.

**Data flow**: Uses the mutable `websocket` field to send a close frame with no close reason, awaits completion, and returns `Ok(())` or the close error.

**Call relations**: This method is used by tests that need to simulate transport loss or reconnect behavior without killing the server process itself.

*Call graph*: 1 external calls (close).


##### `ExecServerHarness::reconnect_websocket`  (lines 103–107)

```
async fn reconnect_websocket(&mut self) -> anyhow::Result<()>
```

**Purpose**: Establishes a fresh WebSocket connection to the same exec-server URL and replaces the harness's current socket.

**Data flow**: Reads `self.websocket_url`, passes it to `connect_websocket_when_ready`, and overwrites `self.websocket` with the newly connected stream. It returns success once the replacement socket is installed.

**Call relations**: Called by reconnect-oriented tests after `disconnect_websocket` or other socket loss. It reuses the same startup retry logic as initial harness creation.

*Call graph*: calls 1 internal fn (connect_websocket_when_ready).


##### `ExecServerHarness::send_request`  (lines 109–124)

```
async fn send_request(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<RequestId>
```

**Purpose**: Builds and sends a JSON-RPC request with an auto-incremented integer request ID.

**Data flow**: Takes a method name and `serde_json::Value` params, reads and increments `self.next_request_id`, wraps the data in `RequestId::Integer` and `JSONRPCRequest`, then forwards the resulting `JSONRPCMessage::Request` to `send_message`. It returns the assigned `RequestId` so the caller can match responses.

**Call relations**: Higher-level test helpers invoke this when they need request/response semantics. It delegates actual serialization and frame transmission to `send_message`.

*Call graph*: calls 1 internal fn (send_message); called by 1 (initialize_exec_server); 2 external calls (Request, Integer).


##### `ExecServerHarness::send_notification`  (lines 126–136)

```
async fn send_notification(
        &mut self,
        method: &str,
        params: serde_json::Value,
    ) -> anyhow::Result<()>
```

**Purpose**: Builds and sends a JSON-RPC notification message with the given method and params.

**Data flow**: Accepts a method name and JSON params, constructs `JSONRPCNotification`, wraps it in `JSONRPCMessage::Notification`, and passes it to `send_message`. It returns `Ok(())` after the frame is sent.

**Call relations**: Used by tests that need fire-and-forget protocol messages. Like `send_request`, it relies on `send_message` for encoding and transport.

*Call graph*: calls 1 internal fn (send_message); called by 1 (initialize_exec_server); 1 external calls (Notification).


##### `ExecServerHarness::send_raw_text`  (lines 138–143)

```
async fn send_raw_text(&mut self, text: &str) -> anyhow::Result<()>
```

**Purpose**: Sends an arbitrary text WebSocket frame directly, bypassing JSON-RPC encoding.

**Data flow**: Takes a `&str`, clones it into an owned `String`, wraps it in `tungstenite::Message::Text`, sends it on `self.websocket`, and returns success or the send error.

**Call relations**: This helper supports malformed-input or protocol-boundary tests that need to control the exact text frame contents instead of sending structured JSON-RPC values.

*Call graph*: 2 external calls (send, Text).


##### `ExecServerHarness::send_raw_binary`  (lines 145–148)

```
async fn send_raw_binary(&mut self, bytes: Vec<u8>) -> anyhow::Result<()>
```

**Purpose**: Sends an arbitrary binary WebSocket frame directly to the server.

**Data flow**: Consumes a `Vec<u8>`, converts it into a tungstenite binary payload, sends it through `self.websocket`, and returns `Ok(())` or the transport error.

**Call relations**: Like `send_raw_text`, this is for low-level transport tests that need to bypass normal JSON serialization.

*Call graph*: 2 external calls (send, Binary).


##### `ExecServerHarness::next_event`  (lines 150–152)

```
async fn next_event(&mut self) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Waits for the next incoming JSON-RPC message using the file's standard event timeout.

**Data flow**: Reads no new inputs beyond `&mut self`, forwards the fixed `EVENT_TIMEOUT` constant to `next_event_with_timeout`, and returns the parsed `JSONRPCMessage` or a timeout/transport/parse error.

**Call relations**: Tests that simply want the next protocol event call this wrapper instead of specifying a timeout manually. It is a convenience layer over `next_event_with_timeout`.

*Call graph*: calls 1 internal fn (next_event_with_timeout); called by 1 (collect_response_body_deltas).


##### `ExecServerHarness::wait_for_event`  (lines 154–175)

```
async fn wait_for_event(
        &mut self,
        mut predicate: F,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Consumes incoming events until one satisfies a caller-provided predicate or the overall event deadline expires.

**Data flow**: Accepts a mutable predicate over `&JSONRPCMessage`, computes a deadline from `Instant::now() + EVENT_TIMEOUT`, repeatedly derives the remaining duration, fetches the next event via `next_event_with_timeout`, and returns the first matching message. If time runs out first, it returns an `anyhow!` timeout error.

**Call relations**: Response-waiting helpers elsewhere call this when they need to filter the event stream for a specific message shape. It delegates frame retrieval and parsing to `next_event_with_timeout` while adding predicate-based selection.

*Call graph*: calls 1 internal fn (next_event_with_timeout); called by 2 (wait_for_error_response, wait_for_response); 2 external calls (now, anyhow!).


##### `ExecServerHarness::shutdown`  (lines 177–183)

```
async fn shutdown(&mut self) -> anyhow::Result<()>
```

**Purpose**: Explicitly terminates the exec-server subprocess and waits for it to exit within the connection timeout window.

**Data flow**: Calls `start_kill()` on `self.child`, then awaits `self.child.wait()` under `tokio::time::timeout(CONNECT_TIMEOUT, ...)`. It returns `Ok(())` on timely process exit or an error if kill initiation, waiting, or the timeout fails.

**Call relations**: Tests use this when they need deterministic server shutdown, especially to provoke disconnect behavior. It is stronger and more observable than relying on `Drop` alone.

*Call graph*: 3 external calls (start_kill, wait, timeout).


##### `ExecServerHarness::send_message`  (lines 185–189)

```
async fn send_message(&mut self, message: JSONRPCMessage) -> anyhow::Result<()>
```

**Purpose**: Serializes a structured `JSONRPCMessage` to JSON text and sends it over the WebSocket.

**Data flow**: Consumes a `JSONRPCMessage`, encodes it with `serde_json::to_string`, wraps the JSON string in a text WebSocket frame, sends it on `self.websocket`, and returns `Ok(())` or any serialization/send error.

**Call relations**: This private helper is the common transmission path for `send_request` and `send_notification`, keeping JSON encoding logic in one place.

*Call graph*: called by 2 (send_notification, send_request); 3 external calls (send, to_string, Text).


##### `ExecServerHarness::next_event_with_timeout`  (lines 191–213)

```
async fn next_event_with_timeout(
        &mut self,
        timeout_duration: Duration,
    ) -> anyhow::Result<JSONRPCMessage>
```

**Purpose**: Reads WebSocket frames until it obtains a JSON-bearing text or binary frame, subject to a caller-specified timeout.

**Data flow**: Takes a `Duration`, awaits `self.websocket.next()` under `timeout`, errors if the timeout elapses or the stream ends, then matches the received `Message`. Text frames are parsed with `serde_json::from_str`, binary frames with `serde_json::from_slice`, close frames become an explicit closed error, ping/pong frames are ignored, and any other frame types are skipped in a loop. It returns the first successfully parsed `JSONRPCMessage`.

**Call relations**: This is the low-level receive primitive used by both `next_event` and `wait_for_event`. It isolates transport framing details and heartbeat suppression from higher-level test logic.

*Call graph*: called by 2 (next_event, wait_for_event); 5 external calls (next, anyhow!, from_slice, from_str, timeout).


##### `connect_websocket_when_ready`  (lines 216–239)

```
async fn connect_websocket_when_ready(
    websocket_url: &str,
) -> anyhow::Result<(
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungst
```

**Purpose**: Retries WebSocket connection attempts until the exec-server starts accepting connections or a startup deadline expires.

**Data flow**: Accepts a `&str` URL, computes a deadline from `CONNECT_TIMEOUT`, and repeatedly calls `connect_async`. Successful connection returns the `(WebSocketStream, Response)` pair immediately. If the error is specifically `ConnectionRefused` and the deadline has not passed, it sleeps for `CONNECT_RETRY_INTERVAL` and retries; any other error, or refusal after the deadline, is returned.

**Call relations**: Used during initial harness creation and reconnection. It bridges the race between process startup and socket readiness so callers do not need their own retry loops.

*Call graph*: called by 2 (reconnect_websocket, exec_server_with_env); 4 external calls (now, matches!, sleep, connect_async).


##### `read_listen_url_from_stdout`  (lines 241–266)

```
async fn read_listen_url_from_stdout(child: &mut Child) -> anyhow::Result<String>
```

**Purpose**: Consumes the child process stdout until it finds the line announcing the exec-server's `ws://` listen URL.

**Data flow**: Takes a mutable `Child`, extracts its piped stdout, wraps it in `BufReader::lines`, and loops until a deadline based on `CONNECT_TIMEOUT`. Each iteration waits for the next line under the remaining timeout, errors if stdout closes or the timeout expires, trims the line, and returns it once it starts with `ws://`.

**Call relations**: This startup helper is called only from `exec_server_with_env` before any WebSocket connection attempt. It synchronizes harness creation with the server's own stdout-based readiness signal.

*Call graph*: called by 1 (exec_server_with_env); 4 external calls (new, now, anyhow!, timeout).


### `exec-server/src/server/transport_tests.rs`

`test` · `startup and transport parsing behavior under test`

This test module focuses on the transport layer rather than handler internals. The first group of unit tests locks down `parse_listen_url`: the default websocket URL must parse to `ExecServerListenTransport::WebSocket(127.0.0.1:0)`, both `stdio` spellings must map to `Stdio`, a concrete websocket URL with an IP address must parse successfully, and invalid forms must produce the exact user-facing error strings. In particular, `ws://localhost:1234` is rejected because the parser requires a `SocketAddr`, not a hostname.

The async integration test `stdio_listen_transport_serves_initialize` exercises the generic stdio serving path with `tokio::io::duplex` streams. It first confirms that parsing `stdio` selects the stdio transport, then spawns `run_stdio_connection_with_io` using in-memory reader/writer pairs and a test `ExecServerRuntimePaths` built from the current executable. The client side writes a JSON-RPC initialize request, waits up to one second for a response line, decodes it as `JSONRPCMessage::Response`, checks the request id, and verifies that the returned `InitializeResponse` contains a non-empty session id. It then sends the required `initialized` notification, drops the client streams to simulate disconnect, and asserts that the server task exits cleanly within one second.

The helper `write_jsonrpc_line` performs newline-delimited JSON framing, matching the stdio transport's expectations, while `test_runtime_paths` mirrors production runtime-path construction in a test-safe way.

#### Function details

##### `parse_listen_url_accepts_default_websocket_url`  (lines 27–37)

```
fn parse_listen_url_accepts_default_websocket_url()
```

**Purpose**: Verifies that the built-in default listen URL parses as a websocket transport bound to `127.0.0.1:0`. This protects the default CLI configuration.

**Data flow**: Calls `parse_listen_url(DEFAULT_LISTEN_URL)`, unwraps the result, and asserts equality with `ExecServerListenTransport::WebSocket` containing the parsed `SocketAddr` for `127.0.0.1:0`.

**Call relations**: This is a direct unit test of `parse_listen_url`, covering the constant exported by the transport module.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_accepts_stdio`  (lines 40–43)

```
fn parse_listen_url_accepts_stdio()
```

**Purpose**: Checks that the plain `stdio` listen string selects stdio mode. It validates one of the two accepted stdio spellings.

**Data flow**: Calls `parse_listen_url("stdio")`, unwraps the result, and asserts it equals `ExecServerListenTransport::Stdio`.

**Call relations**: This test exercises the stdio branch of `parse_listen_url`.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_accepts_stdio_url`  (lines 46–49)

```
fn parse_listen_url_accepts_stdio_url()
```

**Purpose**: Checks that the alternate `stdio://` spelling also selects stdio mode. It ensures backward-compatible parsing of both accepted forms.

**Data flow**: Calls `parse_listen_url("stdio://")`, unwraps the result, and asserts it equals `ExecServerListenTransport::Stdio`.

**Call relations**: Like the previous test, this is a focused parser contract check.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `stdio_listen_transport_serves_initialize`  (lines 52–112)

```
async fn stdio_listen_transport_serves_initialize()
```

**Purpose**: End-to-end tests the stdio transport by running a server over in-memory streams and completing the initialize/initialized handshake. It proves that transport startup, framing, and request dispatch work together.

**Data flow**: Parses `stdio` and pattern-matches the result to `ExecServerListenTransport::Stdio`, creates duplex stream pairs for client/server IO, spawns `run_stdio_connection_with_io(server_reader, server_writer, test_runtime_paths())`, wraps the client read side in `BufReader::lines`, constructs and writes a JSON-RPC initialize request via `write_jsonrpc_line`, waits with `timeout` for the response line, parses it as `JSONRPCMessage`, extracts and validates the `JSONRPCResponse` id and `InitializeResponse.session_id`, sends an `initialized` notification, drops client handles, and waits with timeout for the server task to finish successfully.

**Call relations**: This test is the main integration check for `run_stdio_connection_with_io`. It uses `write_jsonrpc_line` and `test_runtime_paths` helpers to drive the same code path production stdio mode uses.

*Call graph*: calls 2 internal fn (test_runtime_paths, write_jsonrpc_line); 16 external calls (new, from_secs, Notification, Request, Integer, assert!, assert_eq!, panic!, from_str, from_value (+6 more)).


##### `parse_listen_url_accepts_websocket_url`  (lines 115–126)

```
fn parse_listen_url_accepts_websocket_url()
```

**Purpose**: Verifies that a concrete websocket URL with an IP address and port parses successfully. It covers the normal websocket configuration path.

**Data flow**: Calls `parse_listen_url("ws://127.0.0.1:1234")`, unwraps the result, and asserts equality with `ExecServerListenTransport::WebSocket` containing the parsed socket address.

**Call relations**: This unit test covers the successful websocket branch of `parse_listen_url`.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_rejects_invalid_websocket_url`  (lines 129–136)

```
fn parse_listen_url_rejects_invalid_websocket_url()
```

**Purpose**: Checks that websocket URLs not matching `SocketAddr` syntax are rejected with the expected message. It specifically documents that hostnames are not accepted.

**Data flow**: Calls `parse_listen_url("ws://localhost:1234")`, expects an error, converts it to string, and asserts the exact formatted message.

**Call relations**: This test validates both parser behavior and `ExecServerListenUrlParseError::fmt` output for invalid websocket addresses.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `parse_listen_url_rejects_unsupported_url`  (lines 139–146)

```
fn parse_listen_url_rejects_unsupported_url()
```

**Purpose**: Checks that unsupported schemes are rejected with the expected message. It documents the narrow accepted transport set.

**Data flow**: Calls `parse_listen_url("http://127.0.0.1:1234")`, expects an error, converts it to string, and asserts the exact unsupported-URL message.

**Call relations**: This test covers the fallback error branch of `parse_listen_url` and its display formatting.

*Call graph*: 2 external calls (assert_eq!, parse_listen_url).


##### `write_jsonrpc_line`  (lines 148–158)

```
async fn write_jsonrpc_line(writer: &mut tokio::io::DuplexStream, message: &JSONRPCMessage)
```

**Purpose**: Writes one newline-delimited JSON-RPC message to a duplex stream. It is the framing helper used by the stdio transport integration test.

**Data flow**: Accepts a mutable `tokio::io::DuplexStream` and a `JSONRPCMessage`, serializes the message with `serde_json::to_vec`, writes the bytes, then writes a trailing newline. It returns after both writes succeed.

**Call relations**: Called by `stdio_listen_transport_serves_initialize` to send both the initialize request and initialized notification into the server.

*Call graph*: called by 1 (stdio_listen_transport_serves_initialize); 2 external calls (write_all, to_vec).


##### `test_runtime_paths`  (lines 160–166)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Constructs runtime paths for transport tests from the current executable. It mirrors production setup while avoiding external sandbox dependencies.

**Data flow**: Reads `std::env::current_exe`, passes it and `None` into `ExecServerRuntimePaths::new`, and returns the resulting runtime-path object.

**Call relations**: Used by `stdio_listen_transport_serves_initialize` when spawning the stdio transport under test.

*Call graph*: calls 1 internal fn (new); called by 1 (stdio_listen_transport_serves_initialize); 1 external calls (current_exe).


### `exec-server/tests/initialize.rs`

`test` · `protocol handshake validation at session startup`

This small Unix-only test exercises the first protocol step any websocket client must perform. It starts the common exec-server harness, sends a JSON-RPC `initialize` request containing `InitializeParams` with a test client name and no resume session, then waits for the next websocket event. The event must be a `JSONRPCMessage::Response` whose `id` matches the request ID returned by the harness.

After confirming the response correlation, the test deserializes the `result` payload into `InitializeResponse` and validates that `session_id` parses as a UUID using `Uuid::parse_str`. That makes the assertion stronger than merely checking non-emptiness: the server must return a properly formatted session identifier suitable for later resume flows. The test then shuts the server down cleanly. Because it does not send the follow-up `initialized` notification or invoke any other methods, this file isolates the acceptance and shape of the initial handshake response itself.

#### Function details

##### `exec_server_accepts_initialize`  (lines 14–36)

```
async fn exec_server_accepts_initialize() -> anyhow::Result<()>
```

**Purpose**: Starts exec-server, sends an `initialize` request, and verifies the response matches the request ID and contains a UUID-formatted session ID.

**Data flow**: Creates a server harness, sends `initialize` with serialized `InitializeParams`, awaits the next websocket event, pattern-matches it as a `JSONRPCResponse`, asserts the response `id` equals the original request ID, deserializes `result` into `InitializeResponse`, parses `session_id` as a `Uuid`, then shuts the server down and returns `Ok(())`.

**Call relations**: This standalone test uses only the common harness and protocol types; it intentionally stops after the initialize response to validate the handshake entrypoint in isolation.

*Call graph*: calls 1 internal fn (exec_server); 5 external calls (parse_str, assert_eq!, panic!, from_value, to_value).


### `exec-server/tests/health.rs`

`test` · `startup and health-check validation during integration tests`

This Unix-only test file covers two lightweight but important integration paths. The first test starts a real exec-server harness, derives an HTTP base URL from its websocket URL by stripping the `ws://` prefix, and performs an actual `GET /readyz` request with `reqwest`. The assertion is intentionally minimal—HTTP 200 OK—because the goal is to prove the process exposes a readiness endpoint alongside the websocket transport rather than only speaking JSON-RPC.

The second test exercises the higher-level `codex_exec_server::Environment` abstraction. It starts a server, constructs a remote test environment pointing at that server's websocket URL, asserts `is_remote()`, then fetches `info()` from both the remote environment and `Environment::default_for_tests()` and compares them for equality. That verifies the remote environment forwards the same environment-information payload the local implementation would compute directly. Both tests explicitly shut the server down at the end, so they validate startup, request handling, and clean teardown of the harnessed server process.

#### Function details

##### `exec_server_serves_readyz_alongside_websocket_endpoint`  (lines 10–22)

```
async fn exec_server_serves_readyz_alongside_websocket_endpoint() -> anyhow::Result<()>
```

**Purpose**: Starts a real exec-server and verifies its HTTP readiness endpoint responds successfully while the websocket endpoint is also active.

**Data flow**: Creates a server harness with `exec_server()`, reads its websocket URL, strips the `ws://` prefix to form an HTTP base address, performs `reqwest::get` on `/readyz`, asserts the status is `200 OK`, then shuts the server down and returns `Ok(())`.

**Call relations**: This test drives the server process externally over HTTP rather than JSON-RPC. It depends on the common harness only for process startup and shutdown.

*Call graph*: calls 1 internal fn (exec_server); 3 external calls (assert_eq!, format!, get).


##### `remote_environment_fetches_info_from_exec_server`  (lines 25–36)

```
async fn remote_environment_fetches_info_from_exec_server() -> anyhow::Result<()>
```

**Purpose**: Checks that a remote `Environment` connected to exec-server reports the same environment info as the local test environment.

**Data flow**: Starts a server harness, constructs `Environment::create_for_tests(Some(websocket_url))`, asserts the environment is remote, awaits `info()` from both the remote environment and `Environment::default_for_tests()`, compares the two values, then shuts the server down.

**Call relations**: This test exercises the remote environment abstraction over the running server and compares its result against the local code path to validate protocol parity.

*Call graph*: calls 3 internal fn (create_for_tests, default_for_tests, exec_server); 2 external calls (assert!, assert_eq!).


### `exec-server/tests/websocket.rs`

`test` · `request handling / websocket integration testing`

This Unix-only test file exercises the exec server through a real WebSocket connection created by the shared `common::exec_server::exec_server` harness. Each test starts an isolated server instance, drives it with raw WebSocket traffic or a custom handshake, and then asserts on concrete JSON-RPC protocol behavior rather than internal implementation details. The first test deliberately sends invalid text (`"not-json"`) and confirms the server emits a `JSONRPCMessage::Error` with request id `-1` and parse/invalid-request code `-32600`, then immediately proves the connection remains usable by sending a normal `initialize` request and decoding the `InitializeResponse` session id as a UUID. The second test bypasses helper request APIs and sends a serialized `JSONRPCMessage::Request` as a binary frame, confirming the server accepts binary JSON carrying the same initialize payload. The third test mutates the client handshake request to include a browser-style `Origin: https://evil.example` header and asserts the handshake fails with HTTP 403, documenting a CSRF-style protection boundary at connection setup. Across all tests, successful shutdown is explicit, so the file validates both protocol correctness and server resilience after bad input.

#### Function details

##### `exec_server_reports_malformed_websocket_json_and_keeps_running`  (lines 21–68)

```
async fn exec_server_reports_malformed_websocket_json_and_keeps_running() -> anyhow::Result<()>
```

**Purpose**: Starts the exec server, sends malformed text over the WebSocket, and verifies the server responds with a JSON-RPC parse/invalid-request error without terminating the session. It then sends a valid `initialize` request to prove the same server instance still processes subsequent traffic normally.

**Data flow**: It obtains a mutable test server handle from `exec_server()`, writes raw text `not-json`, waits until an incoming event matches `JSONRPCMessage::Error`, destructures the returned `JSONRPCError`, and asserts its id and code. It then serializes `InitializeParams` with `serde_json::to_value`, sends an `initialize` request, waits for the matching `JSONRPCResponse`, deserializes the `result` into `InitializeResponse` with `serde_json::from_value`, validates `session_id` via `Uuid::parse_str`, and finally shuts the server down.

**Call relations**: This is a top-level async test invoked by the Tokio test runner. It relies on the shared exec-server harness for process setup and transport helpers, and its control flow intentionally chains an error path into a success path to demonstrate that malformed input handling is non-fatal.

*Call graph*: calls 1 internal fn (exec_server); 6 external calls (parse_str, assert!, assert_eq!, panic!, from_value, to_value).


##### `exec_server_accepts_binary_websocket_json`  (lines 71–104)

```
async fn exec_server_accepts_binary_websocket_json() -> anyhow::Result<()>
```

**Purpose**: Verifies that the WebSocket endpoint accepts JSON-RPC requests delivered in a binary frame, not only text frames. The test uses a hand-built `JSONRPCMessage::Request` for `initialize` and expects a normal initialize response.

**Data flow**: It creates a server handle, constructs a fixed `RequestId::Integer(1)`, builds a `JSONRPCMessage::Request` containing serialized `InitializeParams`, converts that message to bytes with `serde_json::to_vec`, and sends the bytes through `send_raw_binary`. It waits for a `JSONRPCMessage::Response` with the same id, asserts the id matches, deserializes the response payload into `InitializeResponse`, validates the returned session UUID, and shuts the server down.

**Call relations**: This Tokio integration test is called directly by the test harness. It complements the malformed-text test by covering an alternate transport encoding path, while still depending on the same shared server fixture and response-waiting helpers.

*Call graph*: calls 1 internal fn (exec_server); 8 external calls (parse_str, Request, Integer, assert_eq!, panic!, from_value, to_value, to_vec).


##### `exec_server_rejects_browser_origin_websocket_handshake`  (lines 107–125)

```
async fn exec_server_rejects_browser_origin_websocket_handshake() -> anyhow::Result<()>
```

**Purpose**: Checks that the server refuses WebSocket handshakes carrying a browser-like `Origin` header from an untrusted site. The expected failure mode is an HTTP response with status 403 Forbidden.

**Data flow**: It starts the server, converts the server WebSocket URL into a client request, mutates the request headers to insert `ORIGIN: https://evil.example`, and passes that request to `connect_async`. On success it aborts the test; on error it requires a `WebSocketError::Http` response and asserts the HTTP status is `StatusCode::FORBIDDEN`, then shuts the server down.

**Call relations**: This test is another top-level Tokio case run by the test framework. Unlike the other two, it validates connection establishment policy before any JSON-RPC exchange occurs, using `connect_async` directly instead of the harness's higher-level messaging helpers.

*Call graph*: calls 1 internal fn (exec_server); 4 external calls (from_static, bail!, assert_eq!, connect_async).


### `exec-server/src/server/handler/tests.rs`

`test` · `request handling and session-resume behavior under test`

This test module exercises the handler layer directly, without going through the JSON-RPC transport. It starts by defining small helpers that construct concrete `ExecParams` values: they derive a `ProcessId`, use the current working directory converted to `PathUri`, preserve only the inherited `PATH`, and choose shell commands that work on both Unix and Windows. `test_runtime_paths` points the handler at the current executable and disables the Linux sandbox path, matching the lightweight test environment.

The central setup helper, `initialized_handler`, creates an `ExecServerHandler` with a fresh `SessionRegistry` and a buffered notification channel, performs `initialize`, validates that the returned `session_id` parses as a UUID, and then sends the required `initialized` notification. The tests then probe concrete lifecycle edges: concurrent `exec` calls with the same process id must yield exactly one success; repeated `terminate` calls eventually report `running: false` after a short-lived process exits; a pending long-poll `exec_read` must fail once another connection resumes the same session; and resuming a still-attached session must be rejected.

The final scenario intentionally drops the notification receiver to prove that process output and exit state remain buffered inside the process subsystem even when notifications cannot be delivered. `read_process_until_closed` repeatedly issues `exec_read`, accumulates UTF-8-decoded chunks, tracks sequence numbers carefully via `after_seq` and `next_seq`, records exit codes once `exited` becomes true, and stops only when `closed` is reported. That helper encodes an important invariant: retained output and terminal state must remain readable until the process is fully closed, after which the process id becomes reusable.

#### Function details

##### `exec_params`  (lines 22–24)

```
fn exec_params(process_id: &str) -> ExecParams
```

**Purpose**: Builds a default `ExecParams` payload for a named process using the file's standard short sleep command line. It is the convenience constructor used by tests that only care about process identity and normal startup.

**Data flow**: Takes a `&str` process id, derives the platform-specific argv by calling `sleep_argv`, then forwards both pieces into `exec_params_with_argv`. It returns a fully populated `ExecParams` with cwd, PATH-only environment, and non-TTY/non-stdin-pipe defaults.

**Call relations**: This helper is invoked by tests that start a simple short-lived process before checking duplicate-id behavior or post-exit termination behavior. It delegates all field assembly to `exec_params_with_argv` so those tests share the same environment and cwd setup.

*Call graph*: calls 2 internal fn (exec_params_with_argv, sleep_argv); called by 2 (output_and_exit_are_retained_after_notification_receiver_closes, terminate_reports_false_after_process_exit).


##### `exec_params_with_argv`  (lines 26–37)

```
fn exec_params_with_argv(process_id: &str, argv: Vec<String>) -> ExecParams
```

**Purpose**: Constructs a concrete `ExecParams` struct from a caller-supplied argv vector. It centralizes the exact test process configuration so all process-starting tests use the same cwd, environment policy, and stdio flags.

**Data flow**: Consumes a process id string and a `Vec<String>` argv, converts the id with `ProcessId::from`, resolves `std::env::current_dir`, converts that path to `PathUri`, reads inherited PATH entries via `inherited_path_env`, and returns an `ExecParams` with `env_policy: None`, `tty: false`, `pipe_stdin: false`, and `arg0: None`.

**Call relations**: Called both by `exec_params` and by tests that need custom shell scripts, such as the long-poll resume case and the notification-drop retention case. It is a leaf-level fixture builder that feeds directly into `ExecServerHandler::exec` calls.

*Call graph*: calls 3 internal fn (from, inherited_path_env, from_path); called by 3 (exec_params, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes); 1 external calls (current_dir).


##### `inherited_path_env`  (lines 39–45)

```
fn inherited_path_env() -> HashMap<String, String>
```

**Purpose**: Creates the minimal environment map needed for spawned test commands to find shell binaries. It intentionally preserves only `PATH` rather than copying the full parent environment.

**Data flow**: Starts with an empty `HashMap<String, String>`, reads `PATH` from `std::env::var_os`, and if present inserts a lossy stringified copy under the `PATH` key. It returns that map for embedding into `ExecParams`.

**Call relations**: Used only by `exec_params_with_argv` as part of test fixture construction. Its narrow scope keeps process tests deterministic while still allowing `/bin/sh` or `cmd.exe` invocations to resolve.

*Call graph*: called by 1 (exec_params_with_argv); 2 external calls (new, var_os).


##### `sleep_argv`  (lines 47–49)

```
fn sleep_argv() -> Vec<String>
```

**Purpose**: Provides the default short-lived command line used by simple process tests. The command sleeps briefly on Unix or uses `ping` as a timing surrogate on Windows.

**Data flow**: Calls `shell_argv` with a Unix script of `sleep 0.1` and a Windows script of `ping -n 2 127.0.0.1 >NUL`, then returns the resulting argv vector.

**Call relations**: This helper is only reached through `exec_params`. It isolates the platform-specific timing command so tests that just need a process to exist briefly do not duplicate shell logic.

*Call graph*: calls 1 internal fn (shell_argv); called by 1 (exec_params).


##### `shell_argv`  (lines 51–65)

```
fn shell_argv(unix_script: &str, windows_script: &str) -> Vec<String>
```

**Purpose**: Builds a shell invocation argv for either Unix or Windows from script snippets. It abstracts away the command interpreter and argument shape differences between platforms.

**Data flow**: Accepts separate Unix and Windows script strings, checks `cfg!(windows)`, and returns either `[COMSPEC-or-cmd.exe, "/C", windows_script]` or `[/bin/sh, "-c", unix_script]` as a `Vec<String>`. On Windows it obtains the executable path through `windows_command_processor`.

**Call relations**: Used by `sleep_argv` and by tests that need custom scripts for long-running quiet processes or multi-line output. It is a pure fixture helper that feeds argv into `exec_params_with_argv`.

*Call graph*: called by 3 (long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, sleep_argv); 2 external calls (cfg!, vec!).


##### `windows_command_processor`  (lines 67–69)

```
fn windows_command_processor() -> String
```

**Purpose**: Finds the Windows shell executable used in test command lines. It prefers the `COMSPEC` environment variable and falls back to `cmd.exe`.

**Data flow**: Reads `COMSPEC` with `std::env::var`; if unavailable, returns the literal `cmd.exe` string. It produces a single executable path string for `shell_argv`.

**Call relations**: This helper supports `shell_argv` on Windows-only code paths. It keeps platform-specific shell discovery in one place.

*Call graph*: 1 external calls (var).


##### `test_runtime_paths`  (lines 71–77)

```
fn test_runtime_paths() -> ExecServerRuntimePaths
```

**Purpose**: Creates `ExecServerRuntimePaths` suitable for tests running inside the current binary. It disables the optional Linux sandbox executable path.

**Data flow**: Reads `std::env::current_exe`, passes that path and `None` for `codex_linux_sandbox_exe` into `ExecServerRuntimePaths::new`, and returns the validated runtime-path bundle.

**Call relations**: Used by all tests that instantiate a real `ExecServerHandler`. It supplies the runtime dependency expected by handler construction without requiring external binaries.

*Call graph*: calls 1 internal fn (new); called by 4 (active_session_resume_is_rejected, initialized_handler, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes); 1 external calls (current_exe).


##### `initialized_handler`  (lines 79–97)

```
async fn initialized_handler() -> Arc<ExecServerHandler>
```

**Purpose**: Builds a fully initialized `Arc<ExecServerHandler>` ready to accept exec and read requests. It performs the same initialize/initialized handshake that production connections must complete.

**Data flow**: Creates an mpsc channel for outbound notifications, a fresh `SessionRegistry`, and an `ExecServerHandler` wrapped in `Arc`. It calls `initialize` with a fixed client name and no resume id, parses the returned `session_id` as a `Uuid` to validate format, invokes `initialized`, and returns the handler.

**Call relations**: This setup helper is called by tests that do not need to control multiple connections manually. It encapsulates the required handshake before those tests invoke `exec` or `terminate` on the handler.

*Call graph*: calls 4 internal fn (new, new, test_runtime_paths, new); called by 2 (duplicate_process_ids_allow_only_one_successful_start, terminate_reports_false_after_process_exit); 3 external calls (new, parse_str, channel).


##### `duplicate_process_ids_allow_only_one_successful_start`  (lines 100–125)

```
async fn duplicate_process_ids_allow_only_one_successful_start()
```

**Purpose**: Verifies that two concurrent `exec` requests for the same `ProcessId` race safely and only one process start succeeds. The loser must receive a JSON-RPC invalid-request style error naming the duplicate id.

**Data flow**: Obtains an initialized handler, clones the `Arc` twice, and runs two `exec(exec_params("proc-1"))` futures concurrently with `tokio::join!`. It partitions the two results into successes and failures, asserts one of each, inspects the failing error's code and message, waits long enough for the successful short-lived process to exit, and then shuts the handler down.

**Call relations**: This test drives the handler's duplicate-process protection under concurrent access. It relies on `initialized_handler` for setup and on `exec_params` for identical process payloads, then observes the handler's externally visible error contract.

*Call graph*: calls 1 internal fn (initialized_handler); 5 external calls (clone, from_millis, assert_eq!, join!, sleep).


##### `terminate_reports_false_after_process_exit`  (lines 128–154)

```
async fn terminate_reports_false_after_process_exit()
```

**Purpose**: Checks that `terminate` eventually reports `running: false` once a short-lived process has already exited. This confirms the API distinguishes between an active process and one that is already gone.

**Data flow**: Creates an initialized handler, starts `proc-1` with `exec_params`, then loops until a one-second deadline repeatedly calling `terminate` with `TerminateParams { process_id }`. If the returned `TerminateResponse` is not yet `{ running: false }`, it sleeps 25 ms and retries; once false is observed, it shuts the handler down.

**Call relations**: The test uses `initialized_handler` and `exec_params` to create a process whose lifetime is shorter than the polling window. It exercises the terminate path repeatedly to observe the transition from still-running to already-exited.

*Call graph*: calls 3 internal fn (from, exec_params, initialized_handler); 5 external calls (from_millis, from_secs, assert!, now, sleep).


##### `long_poll_read_fails_after_session_resume`  (lines 157–227)

```
async fn long_poll_read_fails_after_session_resume()
```

**Purpose**: Ensures a pending long-poll `exec_read` on one connection is evicted when the same session is resumed by another connection. The blocked read must fail with a specific invalid-request error instead of hanging until process output or exit.

**Data flow**: Creates a shared `SessionRegistry`, constructs a first handler and initializes it, starts a quiet long-lived process with custom argv, and spawns a task that issues `exec_read` with `wait_ms: Some(500)`. After a short delay it shuts down the first handler, creates a second handler against the same registry, initializes it with `resume_session_id` from the first connection, marks it initialized, then awaits the read task and asserts the returned error code and message before shutting down the second handler.

**Call relations**: This test manually constructs two handlers sharing one registry to model connection handoff. It depends on `exec_params_with_argv`, `shell_argv`, and `test_runtime_paths` for setup, and its core assertion is that session resumption interrupts in-flight long-poll reads from the old attachment.

*Call graph*: calls 7 internal fn (from, new, new, exec_params_with_argv, shell_argv, test_runtime_paths, new); 7 external calls (clone, new, from_millis, assert_eq!, channel, spawn, sleep).


##### `active_session_resume_is_rejected`  (lines 230–270)

```
async fn active_session_resume_is_rejected()
```

**Purpose**: Verifies that a session cannot be resumed while it is still attached to another live connection. The second `initialize` must fail immediately with an error naming the occupied session id.

**Data flow**: Creates a shared `SessionRegistry`, initializes a first handler to obtain a session id, then creates a second handler against the same registry and calls `initialize` with `resume_session_id: Some(first_session_id)`. It expects an error, asserts the JSON-RPC code and formatted message, and finally shuts down the first handler.

**Call relations**: This test targets the registry-backed attachment rules exposed through handler initialization. It uses two handlers sharing one registry but intentionally does not detach the first before attempting the second attach.

*Call graph*: calls 4 internal fn (new, new, test_runtime_paths, new); 4 external calls (clone, new, assert_eq!, channel).


##### `output_and_exit_are_retained_after_notification_receiver_closes`  (lines 273–314)

```
async fn output_and_exit_are_retained_after_notification_receiver_closes()
```

**Purpose**: Confirms that process output buffering and exit retention do not depend on successful notification delivery. Even after the outbound notification receiver is dropped, the process's stdout and exit code must remain readable through `exec_read`, and the process id must become reusable after closure.

**Data flow**: Creates a handler with a real outbound channel, initializes it, starts a process that prints `first` and `second` with delays, then drops the receiver side of the notification channel. It calls `read_process_until_closed` to collect all buffered output and final exit code, normalizes CRLF to LF for assertion, waits briefly, starts a new process with the same id using `exec_params`, and shuts the handler down.

**Call relations**: This test combines custom argv setup with the polling helper `read_process_until_closed`. It specifically probes the interaction between notification failures and retained process state inside the handler/process subsystem.

*Call graph*: calls 9 internal fn (from, new, new, exec_params, exec_params_with_argv, read_process_until_closed, shell_argv, test_runtime_paths, new); 5 external calls (new, from_millis, assert_eq!, channel, sleep).


##### `read_process_until_closed`  (lines 316–352)

```
async fn read_process_until_closed(
    handler: &ExecServerHandler,
    process_id: ProcessId,
) -> (String, Option<i32>)
```

**Purpose**: Polls `exec_read` until a process reports `closed`, accumulating all output chunks and the final exit code. It is a reusable assertion helper for tests that need to observe retained output over multiple reads.

**Data flow**: Accepts an `&ExecServerHandler` and a `ProcessId`, initializes a five-second deadline, an output `String`, optional exit code, and optional `after_seq`. In a loop it calls `exec_read` with the current sequence cursor and a 500 ms wait, appends each returned chunk after UTF-8-lossy decoding, updates `after_seq` from chunk sequence numbers, records `exit_code` when `response.exited` is true, returns `(output, exit_code)` once `response.closed` is true, otherwise adjusts `after_seq` from `response.next_seq.checked_sub(1)` and asserts the deadline has not passed.

**Call relations**: This helper is called by `output_and_exit_are_retained_after_notification_receiver_closes` to consume a process stream to completion. It encapsulates the expected read-loop protocol around `after_seq`, `next_seq`, `exited`, and `closed`.

*Call graph*: calls 1 internal fn (exec_read); called by 1 (output_and_exit_are_retained_after_notification_receiver_closes); 6 external calls (from_secs, from_utf8_lossy, new, assert!, clone, now).


### `exec-server/tests/process.rs`

`test` · `process RPC validation during websocket session handling and resume flows`

This Unix-only file drives the real exec-server websocket API directly with JSON-RPC requests and notifications. Each test begins by starting the common harness and performing the initialize/initialized handshake inline rather than through a helper, making the protocol sequence explicit. The first test sends `process/start` for `true`, waits for the matching response, and asserts the typed `ExecResponse` echoes the requested `ProcessId`.

The second test targets a subtle defaulting rule: if `pipeStdin` is omitted from `process/start`, stdin should be treated as closed rather than implicitly piped. It starts a shell command that sleeps briefly and then attempts to read one line; after the process starts, the test sends `process/write` with base64-encoded input and asserts the typed `WriteResponse` reports `WriteStatus::StdinClosed`.

The third test validates detached-session resumption. It initializes a session, starts a long-running `sleep 5` process, disconnects and reconnects the websocket, then sends a second `initialize` with `resume_session_id` set to the original session ID. The resumed `InitializeResponse` must equal the original. After sending `initialized` again, the test issues `process/read` and asserts the process has not failed, exited, or closed, proving the disconnect did not kill it. Finally it sends `process/terminate` and expects `TerminateResponse { running: true }`, confirming the resumed session can still control the surviving process.

#### Function details

##### `exec_server_starts_process_over_websocket`  (lines 19–79)

```
async fn exec_server_starts_process_over_websocket() -> anyhow::Result<()>
```

**Purpose**: Verifies that after initialization, exec-server accepts `process/start` over websocket and returns the expected `ExecResponse` containing the requested process ID.

**Data flow**: Starts the server harness, sends `initialize`, waits for the matching response, sends `initialized`, then sends `process/start` with JSON containing `processId`, `argv`, current working directory, empty env, `tty: false`, `pipeStdin: false`, and `arg0: null`. It waits for the matching response, deserializes it into `ExecResponse`, asserts equality with `ProcessId::from("proc-1")`, and shuts down.

**Call relations**: This test exercises the minimal successful process-start path over the real websocket protocol, including the required handshake before executor methods are allowed.

*Call graph*: calls 1 internal fn (exec_server); 5 external calls (assert_eq!, panic!, from_value, json!, to_value).


##### `exec_server_defaults_omitted_pipe_stdin_to_closed_stdin`  (lines 82–172)

```
async fn exec_server_defaults_omitted_pipe_stdin_to_closed_stdin() -> anyhow::Result<()>
```

**Purpose**: Checks that omitting `pipeStdin` in `process/start` leaves stdin closed, so later `process/write` reports `StdinClosed` instead of writing data.

**Data flow**: Starts and initializes the server, sends `process/start` for a shell command that sleeps and then tries to read from stdin, intentionally omitting `pipeStdin` from the JSON payload. After asserting the `ExecResponse`, it sends `process/write` with base64 chunk `aWdub3JlZAo=` and waits for the matching response, deserializes `WriteResponse`, and asserts `status == WriteStatus::StdinClosed` before shutdown.

**Call relations**: This test extends the basic process-start flow by probing a default parameter behavior through a subsequent write RPC.

*Call graph*: calls 1 internal fn (exec_server); 5 external calls (assert_eq!, panic!, from_value, json!, to_value).


##### `exec_server_resumes_detached_session_without_killing_processes`  (lines 175–307)

```
async fn exec_server_resumes_detached_session_without_killing_processes() -> anyhow::Result<()>
```

**Purpose**: Verifies that disconnecting and reconnecting with `resume_session_id` preserves the session and leaves previously started processes running and controllable.

**Data flow**: Starts the server, sends `initialize`, captures and deserializes the initial `InitializeResponse`, sends `initialized`, starts a long-running process `sleep 5`, then disconnects and reconnects the websocket. It sends a second `initialize` with `resume_session_id` set to the original session ID, deserializes the resumed response and asserts it equals the original, sends `initialized` again, then issues `process/read` and asserts `failure.is_none()`, `exited == false`, and `closed == false`. Finally it sends `process/terminate`, deserializes `TerminateResponse`, asserts `running: true`, and shuts down.

**Call relations**: This test covers the full resume flow across websocket reconnection, proving that session state and process state survive transport loss and can be resumed through the initialize handshake.

*Call graph*: calls 1 internal fn (exec_server); 6 external calls (assert!, assert_eq!, panic!, from_value, json!, to_value).


### `exec-server/tests/exec_process.rs`

`test` · `integration test execution against process backends`

This test file validates the process-execution abstraction exposed by `codex_exec_server`. It introduces `ProcessContext`, which pairs an `Arc<dyn ExecBackend>` with an optional `ExecServerHarness` when tests run against the remote WebSocket-backed implementation, and `ProcessEventSnapshot`, a compact enum used to assert exact event sequences. `create_process_context` is the mode switch: local tests call `Environment::create_for_tests(None)`, while remote tests first launch a real exec-server and then create an environment pointing at its WebSocket URL.

Several helpers normalize asynchronous process observation. `read_process_until_change` performs a nonblocking `read(after_seq, None, Some(0))`, and if nothing changed it waits on the process wake channel before retrying. `collect_process_output_from_reads` repeatedly consumes `ReadResponse` chunks, concatenates UTF-8-lossy output, tracks `after_seq`, captures exit status, and stops only when `closed` becomes true; any `failure` field aborts the test. `collect_process_output_from_events` and `collect_process_event_snapshots` do the same through the event subscription API, distinguishing stdout/pty from stderr and preserving sequence numbers.

The assertions cover concrete semantics: successful startup and exit, delayed stdout streaming, ordered event emission (`Output`, `Exited`, `Closed`), replay of queued events after close, retention of output after process exit until inherited streams close, TTY and piped-stdin write behavior, rejection when stdin is closed, Unix interrupt signaling, Windows unsupported-signal reporting, preservation of queued output before subscription, and remote transport disconnect propagation into events, pending reads, subsequent reads, and writes. The bottom of the file contains thin `#[tokio::test]` wrappers, often parameterized with `test_case`, that invoke the shared assertion helpers for local and remote modes.

#### Function details

##### `create_process_context`  (lines 52–67)

```
async fn create_process_context(use_remote: bool) -> Result<ProcessContext>
```

**Purpose**: Builds a test context for either the local process backend or the remote exec-server-backed backend.

**Data flow**: Takes `use_remote: bool`. In remote mode it starts an `ExecServerHarness`, creates an `Environment` with the harness WebSocket URL, extracts the exec backend, and stores the harness in `server`. In local mode it creates an `Environment` with no exec-server URL, extracts the backend, and returns a context with `server: None`.

**Call relations**: All assertion helpers call this first to choose their backend mode. In remote mode it depends on `exec_server` to provision a real server process before constructing the environment.

*Call graph*: calls 2 internal fn (create_for_tests, exec_server); called by 12 (assert_exec_process_preserves_queued_events_before_subscribe, assert_exec_process_pushes_events, assert_exec_process_rejects_write_without_pipe_stdin, assert_exec_process_replays_events_after_close, assert_exec_process_retains_output_after_exit_until_streams_close, assert_exec_process_signal_interrupts_process, assert_exec_process_signal_reports_unsupported_on_windows, assert_exec_process_starts_and_exits, assert_exec_process_streams_output, assert_exec_process_write_then_read (+2 more)).


##### `assert_exec_process_starts_and_exits`  (lines 69–92)

```
async fn assert_exec_process_starts_and_exits(use_remote: bool) -> Result<()>
```

**Purpose**: Verifies that a trivial command starts under the selected backend, reports the requested process ID, exits with code 0, and reaches the closed state.

**Data flow**: Creates a context, starts `true` with `ExecParams` using `ProcessId::from("proc-1")`, current working directory converted through `PathUri::from_path`, and default environment settings. It subscribes to wake notifications, drains output and lifecycle state via `collect_process_output_from_reads`, and asserts process ID, exit code `Some(0)`, and `closed == true`.

**Call relations**: This helper is invoked by the `exec_process_starts_and_exits` test wrapper. It delegates all post-start observation to `collect_process_output_from_reads`.

*Call graph*: calls 4 internal fn (from, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_starts_and_exits); 5 external calls (default, assert!, assert_eq!, current_dir, vec!).


##### `read_process_until_change`  (lines 94–111)

```
async fn read_process_until_change(
    session: Arc<dyn ExecProcess>,
    wake_rx: &mut watch::Receiver<u64>,
    after_seq: Option<u64>,
) -> Result<ReadResponse>
```

**Purpose**: Performs a process read that returns immediately if data/state changed, otherwise waits for the wake channel and retries once.

**Data flow**: Accepts an `Arc<dyn ExecProcess>`, a mutable `watch::Receiver<u64>`, and an optional `after_seq`. It first calls `session.read(after_seq, None, Some(0))`; if the response contains chunks, `closed`, or `failure`, it returns that response. Otherwise it waits up to 2 seconds for `wake_rx.changed()`, then issues the same zero-wait read again and returns the second response.

**Call relations**: Used by output-collection helpers and disconnect/signal tests to avoid busy polling. It bridges the process wake subscription with the pull-based `read` API.

*Call graph*: called by 3 (assert_exec_process_signal_interrupts_process, collect_process_output_from_reads, remote_exec_process_reports_transport_disconnect); 3 external calls (from_secs, changed, timeout).


##### `collect_process_output_from_reads`  (lines 113–140)

```
async fn collect_process_output_from_reads(
    session: Arc<dyn ExecProcess>,
    mut wake_rx: watch::Receiver<u64>,
) -> Result<(String, Option<i32>, bool)>
```

**Purpose**: Consumes the pull-based `read` API until the process closes, concatenating output and tracking exit status.

**Data flow**: Takes a process handle and wake receiver, initializes `output`, `exit_code`, and `after_seq`, then loops calling `read_process_until_change`. It bails if `response.failure` is set, appends each chunk's bytes via `String::from_utf8_lossy`, advances `after_seq` to the last chunk sequence, records `response.exit_code` when `response.exited` is true, and stops when `response.closed` is true; otherwise it backs `after_seq` to `response.next_seq - 1` when possible. It drops the process handle and returns `(output, exit_code, true)`.

**Call relations**: This is the main observation helper for many tests covering startup, output, stdin, signals, queued events, and delayed output. It depends on `read_process_until_change` for efficient waiting.

*Call graph*: calls 1 internal fn (read_process_until_change); called by 9 (assert_exec_process_preserves_queued_events_before_subscribe, assert_exec_process_rejects_write_without_pipe_stdin, assert_exec_process_replays_events_after_close, assert_exec_process_retains_output_after_exit_until_streams_close, assert_exec_process_signal_interrupts_process, assert_exec_process_starts_and_exits, assert_exec_process_streams_output, assert_exec_process_write_then_read, assert_exec_process_write_then_read_without_tty); 4 external calls (clone, from_utf8_lossy, new, bail!).


##### `collect_process_output_from_events`  (lines 142–174)

```
async fn collect_process_output_from_events(
    session: Arc<dyn ExecProcess>,
) -> Result<(String, String, Option<i32>, bool)>
```

**Purpose**: Consumes the push-based event subscription stream until `Closed`, separating stdout/pty and stderr text and recording the exit code.

**Data flow**: Subscribes to `session.subscribe_events()`, then repeatedly awaits `events.recv()` under a 2-second timeout. `ExecProcessEvent::Output` appends bytes to either `stdout` or `stderr` depending on `ExecOutputStream`; `Exited` stores the code; `Closed` drops the session and returns `(stdout, stderr, exit_code, true)`; `Failed` aborts with `bail!`.

**Call relations**: Used by the replay-after-close test to verify that event subscriptions can still replay completed process history. It complements the read-based collector with event-stream semantics.

*Call graph*: called by 1 (assert_exec_process_replays_events_after_close); 5 external calls (from_secs, from_utf8_lossy, new, bail!, timeout).


##### `collect_process_event_snapshots`  (lines 176–203)

```
async fn collect_process_event_snapshots(
    session: Arc<dyn ExecProcess>,
) -> Result<Vec<ProcessEventSnapshot>>
```

**Purpose**: Captures the exact ordered sequence of process events, including sequence numbers and stream identity, until closure.

**Data flow**: Subscribes to process events, loops with a 2-second timeout, converts each received `ExecProcessEvent` into a `ProcessEventSnapshot` variant, pushes it into a `Vec`, and returns the vector once a `Closed` snapshot is observed. `Failed` events abort the helper.

**Call relations**: Called by the event-ordering assertion helper to compare the backend's emitted event sequence against an exact expected vector.

*Call graph*: called by 1 (assert_exec_process_pushes_events); 6 external calls (from_secs, from_utf8_lossy, new, bail!, matches!, timeout).


##### `assert_exec_process_streams_output`  (lines 205–234)

```
async fn assert_exec_process_streams_output(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that delayed stdout from a shell command is delivered through the read API and that the process closes cleanly afterward.

**Data flow**: Creates a context, starts `/bin/sh -c "sleep 0.05; printf 'session output\n'"` with process ID `proc-stream`, then collects output via `collect_process_output_from_reads`. It asserts the process ID, exact output string, exit code `Some(0)`, and closed state.

**Call relations**: Invoked by the `exec_process_streams_output` test wrapper. It relies on the shared read collector to observe the delayed output.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_streams_output); 5 external calls (default, assert!, assert_eq!, current_dir, vec!).


##### `assert_exec_process_pushes_events`  (lines 236–281)

```
async fn assert_exec_process_pushes_events(use_remote: bool) -> Result<()>
```

**Purpose**: Verifies that the event subscription API emits stdout, stderr, exit, and close events in the expected order with monotonically increasing sequence numbers.

**Data flow**: Creates a context, starts a shell command that prints to stdout, later to stderr, then exits 7, and passes the process to `collect_process_event_snapshots`. It asserts the process ID and compares the returned snapshot vector against the exact expected `Output(seq=1, Stdout)`, `Output(seq=2, Stderr)`, `Exited(seq=3, exit_code=7)`, `Closed(seq=4)` sequence.

**Call relations**: Called by the `exec_process_pushes_events` wrapper. It depends on `collect_process_event_snapshots` to preserve event ordering and payload details.

*Call graph*: calls 3 internal fn (collect_process_event_snapshots, create_process_context, from_path); called by 1 (exec_process_pushes_events); 4 external calls (default, assert_eq!, current_dir, vec!).


##### `assert_exec_process_replays_events_after_close`  (lines 283–324)

```
async fn assert_exec_process_replays_events_after_close(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that a process's completed output and lifecycle events remain replayable even after the process has already closed.

**Data flow**: Creates a context, starts a short-lived shell command that prints two lines, first drains the process through `collect_process_output_from_reads` using a cloned process handle, then subscribes to events afterward and drains them through `collect_process_output_from_events`. It asserts that both mechanisms report the same stdout content, empty stderr, exit code 0, and closed state.

**Call relations**: Invoked by the `exec_process_replays_events_after_close` wrapper. It intentionally uses both read-based and event-based collectors to prove post-close replay semantics.

*Call graph*: calls 4 internal fn (collect_process_output_from_events, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_replays_events_after_close); 5 external calls (clone, default, assert_eq!, current_dir, vec!).


##### `assert_exec_process_retains_output_after_exit_until_streams_close`  (lines 326–399)

```
async fn assert_exec_process_retains_output_after_exit_until_streams_close(
    use_remote: bool,
) -> Result<()>
```

**Purpose**: Verifies that output arriving from inherited streams after the parent process exits is still retained and readable before final closure.

**Data flow**: Creates a context, resolves the current helper binary path, creates a temp release file path, and starts the helper binary in delayed-output parent mode. It performs a blocking `process.read(None, None, Some(2000))` and asserts that the first response contains no chunks, reports exit code 0, and is not yet closed; it derives the exit sequence from `next_seq - 1`, writes the release file to trigger child output, then reads again from `Some(exit_seq)` and concatenates the late stdout chunk. Finally it subscribes to wake notifications and uses `collect_process_output_from_reads` to confirm the retained output and final closed state.

**Call relations**: Called by the corresponding test wrapper. It depends on `current_test_binary_helper_paths` and the delayed-output helper modes defined in `common/mod.rs`, then uses the shared read collector to validate final state.

*Call graph*: calls 4 internal fn (current_test_binary_helper_paths, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_retains_output_after_exit_until_streams_close); 11 external calls (default, from_secs, from_utf8_lossy, new, new, assert!, assert_eq!, current_dir, write, timeout (+1 more)).


##### `assert_exec_process_write_then_read`  (lines 401–439)

```
async fn assert_exec_process_write_then_read(use_remote: bool) -> Result<()>
```

**Purpose**: Checks interactive stdin round-tripping for a TTY-backed process.

**Data flow**: Creates a context, starts `/bin/sh -c "IFS= read line; printf 'from-stdin:%s\n' \"$line\""` with `tty: true` and `pipe_stdin: false`, sleeps briefly to let the shell start, writes `hello\n` to the process, then drains output via `collect_process_output_from_reads`. It asserts that the output contains `from-stdin:hello`, exit code 0, and closed state.

**Call relations**: Invoked by the `exec_process_write_then_read` wrapper. It uses the shared collector after performing a direct `write` on the process handle.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_write_then_read); 7 external calls (default, from_millis, assert!, assert_eq!, current_dir, sleep, vec!).


##### `assert_exec_process_write_then_read_without_tty`  (lines 441–472)

```
async fn assert_exec_process_write_then_read_without_tty(use_remote: bool) -> Result<()>
```

**Purpose**: Checks stdin round-tripping when stdin is explicitly piped instead of attached to a TTY.

**Data flow**: Creates a context, starts the same shell read/echo command with `tty: false` and `pipe_stdin: true`, sleeps briefly, writes `hello\n`, asserts that the returned `WriteStatus` is `Accepted`, then drains the process via `collect_process_output_from_reads` and compares the full tuple against `("from-stdin:hello\n", Some(0), true)`.

**Call relations**: Called by the `exec_process_write_then_read_without_tty` wrapper. It specifically validates the non-TTY stdin path and the write-status contract.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_write_then_read_without_tty); 6 external calls (default, from_millis, assert_eq!, current_dir, sleep, vec!).


##### `assert_exec_process_rejects_write_without_pipe_stdin`  (lines 474–506)

```
async fn assert_exec_process_rejects_write_without_pipe_stdin(use_remote: bool) -> Result<()>
```

**Purpose**: Verifies that writes are rejected when the process was started without a writable stdin pipe.

**Data flow**: Creates a context, starts a shell command that waits briefly and then prints either the read line or `eof`, with `pipe_stdin: false`, writes `ignored\n`, and asserts `WriteStatus::StdinClosed`. It then drains output via `collect_process_output_from_reads` and asserts the process observed EOF, exited 0, and closed.

**Call relations**: Invoked by the `exec_process_rejects_write_without_pipe_stdin` wrapper. It combines a direct write-status check with the shared read collector to confirm process-side behavior.

*Call graph*: calls 3 internal fn (collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_rejects_write_without_pipe_stdin); 5 external calls (default, assert!, assert_eq!, current_dir, vec!).


##### `assert_exec_process_signal_interrupts_process`  (lines 508–560)

```
async fn assert_exec_process_signal_interrupts_process(use_remote: bool) -> Result<()>
```

**Purpose**: Checks that sending `ProcessSignal::Interrupt` to a running Unix process triggers its signal handler and produces the expected exit code.

**Data flow**: Creates a context, starts a shell loop that prints `ready`, traps `INT` to print `signal:2` and exit 7, then repeatedly calls `read_process_until_change` until the readiness marker appears, tracking `after_seq` and accumulated output. It sends `process.signal(ProcessSignal::Interrupt)`, drains the remainder via `collect_process_output_from_reads`, and asserts that the output contains the signal marker, exit code is 7, and the process closes.

**Call relations**: Called by the `exec_process_signal_interrupts_process` wrapper. It uses `read_process_until_change` for readiness synchronization before invoking the signal API and then reuses the standard read collector.

*Call graph*: calls 4 internal fn (collect_process_output_from_reads, create_process_context, read_process_until_change, from_path); called by 1 (exec_process_signal_interrupts_process); 9 external calls (clone, default, from_utf8_lossy, new, bail!, assert!, assert_eq!, current_dir, vec!).


##### `assert_exec_process_signal_reports_unsupported_on_windows`  (lines 562–598)

```
async fn assert_exec_process_signal_reports_unsupported_on_windows(use_remote: bool) -> Result<()>
```

**Purpose**: Verifies the Windows backend reports a clear unsupported-operation error when interrupt signaling is attempted on a non-TTY process.

**Data flow**: Creates a context, starts `cmd /C "echo ready && ping -n 30 127.0.0.1 >NUL"`, attempts `signal(ProcessSignal::Interrupt)`, and treats success as a test failure. It converts the resulting error to a string and asserts that it contains both `failed to signal process` and `process interrupt is not supported by this process backend`, then terminates the process.

**Call relations**: Invoked by the Windows-only wrapper test. It focuses on error reporting rather than output collection.

*Call graph*: calls 3 internal fn (from, create_process_context, from_path); called by 1 (exec_process_signal_reports_unsupported_on_windows); 5 external calls (default, bail!, assert!, current_dir, vec!).


##### `assert_exec_process_preserves_queued_events_before_subscribe`  (lines 600–631)

```
async fn assert_exec_process_preserves_queued_events_before_subscribe(
    use_remote: bool,
) -> Result<()>
```

**Purpose**: Checks that output produced before a consumer subscribes is still available through subsequent reads.

**Data flow**: Creates a context, starts a short-lived shell command that prints `queued output`, sleeps 200 ms so the process can finish before subscription, then subscribes to wake notifications and drains via `collect_process_output_from_reads`. It asserts the exact output, exit code 0, and closed state.

**Call relations**: Called by the `exec_process_preserves_queued_events_before_subscribe` wrapper. It validates buffering/replay behavior by intentionally delaying subscription.

*Call graph*: calls 4 internal fn (from, collect_process_output_from_reads, create_process_context, from_path); called by 1 (exec_process_preserves_queued_events_before_subscribe); 7 external calls (default, from_millis, assert!, assert_eq!, current_dir, sleep, vec!).


##### `remote_exec_process_reports_transport_disconnect`  (lines 637–722)

```
async fn remote_exec_process_reports_transport_disconnect() -> Result<()>
```

**Purpose**: Exercises remote-only failure propagation when the underlying exec-server transport disappears while a process session is active.

**Data flow**: Creates a remote context, starts a long-running `sleep 10` process, clones the process handle, subscribes to events, and spawns a task performing a long-polling `read`. It then obtains the embedded `ExecServerHarness` from the context and calls `shutdown()` to kill the server. After shutdown it awaits the next event and asserts it is `ExecProcessEvent::Failed` with a message starting `exec-server transport disconnected`; awaits the pending read and asserts its `failure` field has the same prefix; performs another read via `read_process_until_change` and asserts it reports failure and `closed == true`; finally attempts a write and asserts the write error string also starts with the disconnect prefix.

**Call relations**: This is a standalone remote-only test, not a thin wrapper. It combines the process API with explicit harness shutdown to verify that disconnects surface consistently across event, read, and write paths.

*Call graph*: calls 4 internal fn (from, create_process_context, read_process_until_change, from_path); 9 external calls (clone, default, from_secs, bail!, assert!, current_dir, spawn, timeout, vec!).


##### `exec_process_starts_and_exits`  (lines 730–732)

```
async fn exec_process_starts_and_exits(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the start-and-exit assertion for the selected local or remote mode.

**Data flow**: Accepts the `use_remote` parameter supplied by `test_case` and simply awaits `assert_exec_process_starts_and_exits(use_remote)`, returning its `Result<()>`.

**Call relations**: This Tokio test wrapper is invoked by the test harness for both parameterized modes and delegates all substantive work to `assert_exec_process_starts_and_exits`.

*Call graph*: calls 1 internal fn (assert_exec_process_starts_and_exits).


##### `exec_process_streams_output`  (lines 740–742)

```
async fn exec_process_streams_output(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the output-streaming assertion for local and remote backends.

**Data flow**: Receives `use_remote`, forwards it to `assert_exec_process_streams_output`, and returns that result unchanged.

**Call relations**: Called by the test harness; it exists only to attach test attributes and parameterization around the shared assertion helper.

*Call graph*: calls 1 internal fn (assert_exec_process_streams_output).


##### `exec_process_pushes_events`  (lines 750–752)

```
async fn exec_process_pushes_events(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the event-order assertion for local and remote backends.

**Data flow**: Passes the `use_remote` argument through to `assert_exec_process_pushes_events` and returns the helper's result.

**Call relations**: This wrapper is the attributed test function that delegates to the shared assertion helper.

*Call graph*: calls 1 internal fn (assert_exec_process_pushes_events).


##### `exec_process_replays_events_after_close`  (lines 760–762)

```
async fn exec_process_replays_events_after_close(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the replay-after-close assertion for both backend modes.

**Data flow**: Forwards `use_remote` to `assert_exec_process_replays_events_after_close` and returns its `Result<()>`.

**Call relations**: Used by the test harness to execute the shared replay assertion under both local and remote implementations.

*Call graph*: calls 1 internal fn (assert_exec_process_replays_events_after_close).


##### `exec_process_retains_output_after_exit_until_streams_close`  (lines 770–774)

```
async fn exec_process_retains_output_after_exit_until_streams_close(
    use_remote: bool,
) -> Result<()>
```

**Purpose**: Test entrypoint that runs the delayed-output retention assertion for local and remote backends.

**Data flow**: Accepts `use_remote`, awaits `assert_exec_process_retains_output_after_exit_until_streams_close(use_remote)`, and returns the result.

**Call relations**: This wrapper attaches the test metadata while delegating the actual scenario to the assertion helper.

*Call graph*: calls 1 internal fn (assert_exec_process_retains_output_after_exit_until_streams_close).


##### `exec_process_write_then_read`  (lines 782–784)

```
async fn exec_process_write_then_read(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the TTY stdin round-trip assertion.

**Data flow**: Passes `use_remote` directly to `assert_exec_process_write_then_read` and returns its result.

**Call relations**: Invoked by the test harness for both local and remote modes; all logic lives in the helper.

*Call graph*: calls 1 internal fn (assert_exec_process_write_then_read).


##### `exec_process_write_then_read_without_tty`  (lines 792–794)

```
async fn exec_process_write_then_read_without_tty(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the piped-stdin round-trip assertion.

**Data flow**: Forwards `use_remote` to `assert_exec_process_write_then_read_without_tty` and returns the helper's result.

**Call relations**: A thin attributed wrapper around the shared non-TTY stdin assertion.

*Call graph*: calls 1 internal fn (assert_exec_process_write_then_read_without_tty).


##### `exec_process_rejects_write_without_pipe_stdin`  (lines 802–804)

```
async fn exec_process_rejects_write_without_pipe_stdin(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the stdin-closed rejection assertion.

**Data flow**: Accepts `use_remote`, calls `assert_exec_process_rejects_write_without_pipe_stdin(use_remote)`, and returns its result.

**Call relations**: This wrapper exists to expose the shared assertion as a parameterized Tokio test.

*Call graph*: calls 1 internal fn (assert_exec_process_rejects_write_without_pipe_stdin).


##### `exec_process_signal_interrupts_process`  (lines 812–814)

```
async fn exec_process_signal_interrupts_process(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the Unix interrupt-signal assertion.

**Data flow**: Passes `use_remote` through to `assert_exec_process_signal_interrupts_process` and returns the resulting `Result<()>`.

**Call relations**: The test harness invokes this wrapper; it delegates all scenario logic to the helper.

*Call graph*: calls 1 internal fn (assert_exec_process_signal_interrupts_process).


##### `exec_process_signal_reports_unsupported_on_windows`  (lines 822–824)

```
async fn exec_process_signal_reports_unsupported_on_windows(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the Windows unsupported-signal assertion.

**Data flow**: Forwards `use_remote` to `assert_exec_process_signal_reports_unsupported_on_windows` and returns its result.

**Call relations**: This wrapper exposes the Windows-only assertion helper as a parameterized test.

*Call graph*: calls 1 internal fn (assert_exec_process_signal_reports_unsupported_on_windows).


##### `exec_process_preserves_queued_events_before_subscribe`  (lines 832–834)

```
async fn exec_process_preserves_queued_events_before_subscribe(use_remote: bool) -> Result<()>
```

**Purpose**: Test entrypoint that runs the queued-output preservation assertion.

**Data flow**: Accepts `use_remote`, awaits `assert_exec_process_preserves_queued_events_before_subscribe(use_remote)`, and returns the result.

**Call relations**: A thin test wrapper around the shared assertion helper for both backend modes.

*Call graph*: calls 1 internal fn (assert_exec_process_preserves_queued_events_before_subscribe).


### `utils/pty/src/tests.rs`

`test` · `test execution`

This file exercises the crate's process/session API across real subprocesses and synthetic driver-backed sessions. The helper functions build portable shell commands, locate Python when needed, merge split output streams, collect bytes until exit, and wait for specific markers such as PTY readiness strings or background-child PIDs. Several helpers are Unix-only because they inspect process existence with `kill(pid, 0)`, parse PTY output for numeric PIDs, or rely on inherited file descriptors and `setsid`.

The tests cover both behavioral parity and edge cases. Basic coverage verifies that PTY and pipe backends share the same interface, that pipe stdin round-trips correctly, and that split stdout/stderr remain separated when requested. More subtle tests verify that pipe children detach from the parent session, stderr is drained even without stdout activity, detached reader tasks are aborted by `terminate()`, and PTY termination kills background descendants in the same process group.

Driver-backed tests validate the adapter in `spawn_from_driver`: split stdout/stderr forwarding, resize callback invocation, and the important guarantee that output arriving after the exit signal is still drained before shutdown. Unix-specific inherited-FD tests confirm both PTY and pipe spawn paths can preserve selected descriptors, that preserving descriptors does not break an interactive Python REPL, that missing executables still report exec failures, and that raw-PTY sessions support resize via `stty size` observations. Overall, the file documents the intended semantics of the subsystem as much as it verifies them.

#### Function details

##### `find_python`  (lines 19–30)

```
fn find_python() -> Option<String>
```

**Purpose**: Searches for a usable Python interpreter by trying `python3` and then `python`. It verifies availability by running `--version` and requiring a successful exit status.

**Data flow**: Iterates over two candidate executable names, spawns `std::process::Command::new(candidate).arg("--version").output()`, checks `output.status.success()`, and returns `Some(candidate.to_string())` for the first success or `None` if neither works.

**Call relations**: Several tests call this helper before attempting Python-based subprocess scenarios. Those tests skip themselves gracefully when no interpreter is available.

*Call graph*: called by 4 (pipe_drains_stderr_without_stdout_activity, pipe_process_round_trips_stdin, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits); 1 external calls (new).


##### `setsid_available`  (lines 32–41)

```
fn setsid_available() -> bool
```

**Purpose**: Checks whether the external `setsid` command is available for tests that rely on detached-session behavior. It returns `false` on Windows immediately.

**Data flow**: Reads `cfg!(windows)` and, if false, runs `std::process::Command::new("setsid").arg("true").status()`. It maps a successful command status to `true` and any failure to `false`.

**Call relations**: This helper gates the detached-reader termination test so it only runs in environments where the shell script can launch a separate session.

*Call graph*: called by 1 (pipe_terminate_aborts_detached_readers); 2 external calls (cfg!, new).


##### `shell_command`  (lines 43–53)

```
fn shell_command(program: &str) -> (String, Vec<String>)
```

**Purpose**: Wraps a shell snippet in the platform-appropriate command invocation. It returns both the shell executable and the argument vector needed to execute the snippet.

**Data flow**: Takes a shell program string and, depending on `cfg!(windows)`, either reads `COMSPEC` with a `cmd.exe` fallback and returns `[/C, program]`, or returns `("/bin/sh", ["-c", program])`.

**Call relations**: Many tests use this helper to express subprocess behavior as a short shell script while remaining portable across Windows and Unix.

*Call graph*: called by 5 (pipe_and_pty_share_interface, pipe_process_can_expose_split_stdout_and_stderr, pipe_process_detaches_from_parent_session, pipe_terminate_aborts_detached_readers, pty_terminate_kills_background_children_in_same_process_group); 3 external calls (cfg!, var, vec!).


##### `echo_sleep_command`  (lines 55–61)

```
fn echo_sleep_command(marker: &str) -> String
```

**Purpose**: Builds a tiny shell snippet that prints a marker and then waits briefly. The exact syntax differs between Windows `cmd.exe` and Unix shells.

**Data flow**: Accepts a marker string and formats either `echo {marker} & ping -n 2 127.0.0.1 > NUL` on Windows or `echo {marker}; sleep 0.05` on Unix, returning the resulting `String`.

**Call relations**: This helper is used by the interface-parity test to produce deterministic short-lived output from both pipe and PTY backends.

*Call graph*: called by 1 (pipe_and_pty_share_interface); 2 external calls (cfg!, format!).


##### `split_stdout_stderr_command`  (lines 63–71)

```
fn split_stdout_stderr_command() -> String
```

**Purpose**: Returns a shell snippet that emits one line on stdout and one line on stderr. It uses shell syntax chosen to avoid extra runtime dependencies.

**Data flow**: Takes no input and returns a platform-specific `String`: a `cmd.exe` expression on Windows or a pair of `printf` commands on Unix.

**Call relations**: The split-output pipe test uses this helper to verify that stdout and stderr remain separated all the way through the API.

*Call graph*: called by 1 (pipe_process_can_expose_split_stdout_and_stderr); 1 external calls (cfg!).


##### `collect_split_output`  (lines 73–79)

```
async fn collect_split_output(mut output_rx: tokio::sync::mpsc::Receiver<Vec<u8>>) -> Vec<u8>
```

**Purpose**: Drains an `mpsc` output receiver into a single byte vector. It is a simple utility for tests that want the complete contents of one stream.

**Data flow**: Consumes `tokio::sync::mpsc::Receiver<Vec<u8>>`, repeatedly awaits `recv()`, appends each chunk to a `Vec<u8>` with `extend_from_slice`, and returns the accumulated bytes when the channel closes.

**Call relations**: Tests that inspect split stdout and stderr spawn this helper in tasks so both streams can be drained concurrently.

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

**Purpose**: Converts a `SpawnedProcess` with split stdout/stderr into the common test shape of `(ProcessHandle, combined broadcast receiver, exit receiver)`. It is a convenience destructuring wrapper around `combine_output_receivers`.

**Data flow**: Consumes a `SpawnedProcess`, destructures out `session`, `stdout_rx`, `stderr_rx`, and `exit_rx`, combines the two output receivers with `combine_output_receivers`, and returns the tuple.

**Call relations**: Most tests call this immediately after spawning so they can treat pipe and PTY output uniformly.

*Call graph*: called by 11 (pipe_and_pty_share_interface, pipe_drains_stderr_without_stdout_activity, pipe_process_detaches_from_parent_session, pipe_process_round_trips_stdin, pipe_spawn_no_stdin_can_preserve_inherited_fds, pipe_terminate_aborts_detached_readers, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_supports_resize (+1 more)); 1 external calls (combine_output_receivers).


##### `collect_output_until_exit`  (lines 101–141)

```
async fn collect_output_until_exit(
    mut output_rx: tokio::sync::broadcast::Receiver<Vec<u8>>,
    exit_rx: tokio::sync::oneshot::Receiver<i32>,
    timeout_ms: u64,
) -> (Vec<u8>, i32)
```

**Purpose**: Collects broadcast output until the process exits or a timeout elapses, with an extra post-exit drain window to capture trailing PTY bytes. It returns both the collected bytes and the observed exit code.

**Data flow**: Takes a `broadcast::Receiver<Vec<u8>>`, an exit `oneshot::Receiver<i32>`, and a timeout in milliseconds. It loops with `tokio::select!`, appending received chunks to a `Vec<u8>` until either the exit receiver resolves or the deadline passes; after exit it performs a bounded quiet-window drain (longer on Windows) to capture late-arriving output, then returns `(collected, code)` or `(collected, -1)` on timeout.

**Call relations**: This helper underpins many tests that need deterministic output assertions despite asynchronous reader threads and PTY tail latency.

*Call graph*: called by 8 (pipe_and_pty_share_interface, pipe_drains_stderr_without_stdout_activity, pipe_process_round_trips_stdin, pipe_spawn_no_stdin_can_preserve_inherited_fds, pty_preserving_inherited_fds_keeps_python_repl_running, pty_python_repl_emits_output_and_exits, pty_spawn_can_preserve_inherited_fds, pty_spawn_with_inherited_fds_supports_resize); 5 external calls (new, pin!, select!, from_millis, now).


##### `wait_for_output_contains`  (lines 144–177)

```
async fn wait_for_output_contains(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    needle: &str,
    timeout_ms: u64,
) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Waits for a combined PTY output stream to contain a specific substring within a timeout. It returns all bytes seen up to and including the successful match.

**Data flow**: Takes a mutable broadcast receiver, a needle string, and a timeout in milliseconds. It repeatedly waits for chunks with `tokio::time::timeout`, appends them to a buffer, checks `String::from_utf8_lossy(&collected).contains(needle)`, and returns `Ok(collected)` on success or `anyhow::bail!` with the accumulated output on timeout or premature channel closure.

**Call relations**: The inherited-FD PTY resize test uses this helper to wait until the shell has printed the initial `stty size` line before issuing a resize.

*Call graph*: calls 1 internal fn (recv); called by 1 (pty_spawn_with_inherited_fds_supports_resize); 6 external calls (from_utf8_lossy, new, bail!, from_millis, now, timeout).


##### `wait_for_python_repl_ready`  (lines 179–212)

```
async fn wait_for_python_repl_ready(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    timeout_ms: u64,
    ready_marker: &str,
) -> anyhow::Result<Vec<u8>>
```

**Purpose**: Waits for a Python REPL launched under a PTY to emit a known readiness marker. It is similar to `wait_for_output_contains` but specialized for clearer error messages.

**Data flow**: Consumes a mutable broadcast receiver, timeout, and readiness marker string. It accumulates chunks until the marker appears in the UTF-8-lossy text view, then returns the collected bytes; otherwise it bails on closure or timeout with the partial output included.

**Call relations**: The basic PTY Python test uses this helper after launching `python -i -q -c ...` so it knows the interpreter is ready to accept further input.

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

**Purpose**: Actively probes an interactive Python REPL for readiness by sending a `print(...)` command repeatedly until the marker appears in output. This avoids relying on startup banners or prompts when preserving inherited file descriptors.

**Data flow**: Takes a stdin `mpsc::Sender<Vec<u8>>`, a mutable broadcast receiver, a timeout, and the newline sequence to use. It repeatedly sends `print('__codex_pty_ready__')` plus newline, then within a shorter probe window drains output chunks into a buffer until the marker appears, returning the collected bytes on success or bailing with the partial transcript on timeout or closure.

**Call relations**: This helper is used by the inherited-FD Python PTY test, where startup timing is less predictable and active probing is more reliable than waiting for a passive marker.

*Call graph*: calls 1 internal fn (recv); called by 1 (pty_preserving_inherited_fds_keeps_python_repl_running); 10 external calls (send, from_utf8_lossy, new, bail!, cfg!, format!, min, from_millis, now, timeout).


##### `process_exists`  (lines 267–279)

```
fn process_exists(pid: i32) -> anyhow::Result<bool>
```

**Purpose**: Checks whether a Unix PID still exists using `kill(pid, 0)`. It distinguishes nonexistent processes from permission-denied cases.

**Data flow**: Takes an `i32` PID, calls `libc::kill(pid, 0)`, and returns `Ok(true)` for success or `EPERM`, `Ok(false)` for `ESRCH`, and `Err(...)` for any other OS error.

**Call relations**: This helper is used by `wait_for_process_exit` and by tests that verify background children are alive before termination.

*Call graph*: called by 1 (wait_for_process_exit); 2 external calls (last_os_error, kill).


##### `wait_for_marker_pid`  (lines 282–327)

```
async fn wait_for_marker_pid(
    output_rx: &mut tokio::sync::broadcast::Receiver<Vec<u8>>,
    marker: &str,
    timeout_ms: u64,
) -> anyhow::Result<i32>
```

**Purpose**: Parses a numeric PID that appears in PTY output immediately after a known marker string. It keeps buffering output until it can extract a complete marker-plus-digits sequence.

**Data flow**: Takes a mutable broadcast receiver, marker string, and timeout. It accumulates chunks into a byte buffer, converts the buffer to lossy UTF-8, searches for the marker, scans following ASCII digits, requires at least one trailing character after the digits to ensure the PID token is complete, parses the digits into `i32`, and returns that PID or bails on timeout.

**Call relations**: Tests that launch background jobs or ask Python to print its PID use this helper to recover the child PID from asynchronous PTY output.

*Call graph*: calls 1 internal fn (recv); called by 2 (pty_preserving_inherited_fds_keeps_python_repl_running, pty_terminate_kills_background_children_in_same_process_group); 6 external calls (from_utf8_lossy, new, bail!, from_millis, now, timeout).


##### `wait_for_process_exit`  (lines 330–341)

```
async fn wait_for_process_exit(pid: i32, timeout_ms: u64) -> anyhow::Result<bool>
```

**Purpose**: Polls for a Unix process to disappear within a timeout. It is a simple loop around `process_exists` with a short sleep interval.

**Data flow**: Takes a PID and timeout in milliseconds, computes a deadline, repeatedly calls `process_exists(pid)?`, returns `Ok(true)` as soon as the process no longer exists, returns `Ok(false)` if the deadline passes first, and sleeps 20 ms between polls.

**Call relations**: The PTY descendant-kill test uses this helper after `session.terminate()` to verify that the background child actually died.

*Call graph*: calls 1 internal fn (process_exists); called by 1 (pty_terminate_kills_background_children_in_same_process_group); 3 external calls (from_millis, now, sleep).


##### `pty_python_repl_emits_output_and_exits`  (lines 344–390)

```
async fn pty_python_repl_emits_output_and_exits() -> anyhow::Result<()>
```

**Purpose**: Verifies that a PTY-backed interactive Python process can emit output after startup and then exit cleanly. It exercises PTY stdin writing, output collection, and exit reporting together.

**Data flow**: Finds Python, builds `-i -q -c print(marker)` args, spawns a PTY process with `TerminalSize::default()`, combines output, waits for the readiness marker, sends `print('hello from pty')` and `exit()` through the session writer, collects remaining output until exit, and asserts that the transcript contains the expected text and exit code `0`.

**Call relations**: This test drives the normal PTY spawn path end-to-end, relying on `find_python`, `combine_spawned_output`, `wait_for_python_repl_ready`, and `collect_output_until_exit`.

*Call graph*: calls 5 internal fn (default, collect_output_until_exit, combine_spawned_output, find_python, wait_for_python_repl_ready); 10 external calls (new, from_utf8_lossy, assert!, assert_eq!, cfg!, spawn_pty_process, eprintln!, format!, vars, vec!).


##### `pipe_process_round_trips_stdin`  (lines 393–441)

```
async fn pipe_process_round_trips_stdin() -> anyhow::Result<()>
```

**Purpose**: Checks that a pipe-backed process receives stdin bytes and echoes them back on output before exiting. It covers both Windows shell and Unix Python implementations.

**Data flow**: Chooses a platform-specific command that reads one line from stdin and prints it, spawns a pipe process, obtains the writer sender, sends `roundtrip` plus newline, drops the writer and closes stdin, collects combined output until exit, and asserts that the output contains `roundtrip` and the exit code is `0`.

**Call relations**: This test validates the pipe backend's stdin writer task, EOF handling via `close_stdin`, and output forwarding.

*Call graph*: calls 3 internal fn (collect_output_until_exit, combine_spawned_output, find_python); 11 external calls (new, from_utf8_lossy, assert!, assert_eq!, cfg!, spawn_pipe_process, eprintln!, format!, var, vars (+1 more)).


##### `pipe_process_detaches_from_parent_session`  (lines 445–484)

```
async fn pipe_process_detaches_from_parent_session() -> anyhow::Result<()>
```

**Purpose**: Verifies on Unix that a pipe-spawned child becomes a new session leader rather than inheriting the parent's session. This confirms the `detach_from_tty` pre-exec behavior.

**Data flow**: Reads the parent SID with `getsid(0)`, spawns a shell command that prints its PID and sleeps briefly, reads the first output chunk to parse the child PID, queries the child's SID with `getsid(child_pid)`, asserts that `child_sid == child_pid` and differs from the parent SID, then awaits and checks exit code `0`.

**Call relations**: This test specifically exercises the Unix pipe backend's session-detach setup and uses `combine_spawned_output` plus `shell_command` to observe the resulting process identity.

*Call graph*: calls 2 internal fn (combine_spawned_output, shell_command); 10 external calls (new, from_utf8_lossy, bail!, assert_eq!, assert_ne!, spawn_pipe_process, getsid, vars, from_millis, timeout).


##### `pipe_and_pty_share_interface`  (lines 487–525)

```
async fn pipe_and_pty_share_interface() -> anyhow::Result<()>
```

**Purpose**: Confirms that pipe and PTY spawns expose equivalent high-level behavior for simple commands. It compares successful output and exit handling across both backends.

**Data flow**: Builds two short shell commands with distinct markers, spawns one via the pipe API and one via the PTY API, combines each output stream, collects output until exit for both, and asserts exit code `0` plus presence of the expected marker in each transcript.

**Call relations**: This test is a broad API-parity check that uses the same helper flow for both backends, demonstrating why the shared `SpawnedProcess` abstraction exists.

*Call graph*: calls 5 internal fn (default, collect_output_until_exit, combine_spawned_output, echo_sleep_command, shell_command); 7 external calls (new, assert!, assert_eq!, cfg!, spawn_pipe_process, spawn_pty_process, vars).


##### `pipe_drains_stderr_without_stdout_activity`  (lines 528–546)

```
async fn pipe_drains_stderr_without_stdout_activity() -> anyhow::Result<()>
```

**Purpose**: Ensures the pipe backend drains stderr even when stdout is silent and stderr volume is large. This guards against deadlocks caused by neglecting one pipe.

**Data flow**: Finds Python, runs a script that writes many 64 KiB chunks to stderr only, spawns a pipe process, combines output, collects until exit, and asserts exit code `0` and non-empty collected output.

**Call relations**: This test targets the separate stdout/stderr reader tasks created by the pipe backend and verifies that stderr is consumed independently of stdout activity.

*Call graph*: calls 3 internal fn (collect_output_until_exit, combine_spawned_output, find_python); 7 external calls (new, assert!, assert_eq!, spawn_pipe_process, eprintln!, vars, vec!).


##### `pipe_process_can_expose_split_stdout_and_stderr`  (lines 549–592)

```
async fn pipe_process_can_expose_split_stdout_and_stderr() -> anyhow::Result<()>
```

**Purpose**: Verifies that the no-stdin pipe spawn path preserves stdout and stderr as distinct channels. It checks exact byte contents for each stream.

**Data flow**: Builds a shell command that writes one line to stdout and one to stderr, spawns it with `spawn_pipe_process_no_stdin`, destructures the `SpawnedProcess`, concurrently drains `stdout_rx` and `stderr_rx` with `collect_split_output`, awaits exit with a timeout, and asserts exact expected bytes and exit code `0`.

**Call relations**: This test exercises the pipe backend's split-stream API directly rather than using `combine_output_receivers`.

*Call graph*: calls 3 internal fn (collect_split_output, shell_command, split_stdout_stderr_command); 8 external calls (new, assert_eq!, cfg!, spawn_pipe_process_no_stdin, vars, spawn, from_millis, timeout).


##### `driver_backed_process_can_expose_split_stdout_and_stderr`  (lines 595–643)

```
async fn driver_backed_process_can_expose_split_stdout_and_stderr() -> anyhow::Result<()>
```

**Purpose**: Checks that `spawn_from_driver` correctly adapts separate broadcast stdout and stderr streams into split `mpsc` receivers. It validates the driver-backed path without spawning a real OS process.

**Data flow**: Creates synthetic stdin, stdout, stderr, and exit channels; wraps them in `ProcessDriver`; calls `spawn_from_driver`; drains the returned stdout/stderr receivers in tasks; sends one chunk on each broadcast channel, closes them, sends exit code `0`, and asserts the drained bytes and exit code.

**Call relations**: This test targets the adapter logic in `spawn_from_driver`, especially its per-stream forwarding tasks.

*Call graph*: calls 1 internal fn (collect_split_output); 5 external calls (assert_eq!, spawn_from_driver, spawn, from_secs, timeout).


##### `driver_backed_process_can_resize_via_resizer_hook`  (lines 646–689)

```
async fn driver_backed_process_can_resize_via_resizer_hook() -> anyhow::Result<()>
```

**Purpose**: Verifies that a driver-backed session can implement PTY resize through the optional resizer callback. It checks that `ProcessHandle::resize` forwards the exact `TerminalSize`.

**Data flow**: Builds a `ProcessDriver` whose `resizer` closure sends the received `TerminalSize` through a oneshot, spawns it with `spawn_from_driver`, calls `spawned.session.resize(TerminalSize { rows: 40, cols: 120 })`, sends exit code `0`, awaits the size oneshot, and asserts the received dimensions.

**Call relations**: This test exercises the fallback branch in `ProcessHandle::resize` where no local PTY handles exist and the resizer closure must be used.

*Call graph*: 7 external calls (new, assert_eq!, spawn_from_driver, new, new, from_secs, timeout).


##### `driver_backed_process_drains_output_that_arrives_after_exit_signal`  (lines 692–734)

```
async fn driver_backed_process_drains_output_that_arrives_after_exit_signal() -> anyhow::Result<()>
```

**Purpose**: Ensures the driver-backed adapter does not drop output that is published after the exit code has already been sent. This captures the shutdown contract documented in `spawn_from_driver`.

**Data flow**: Creates a driver with stdout broadcast and exit oneshot, spawns it, starts draining stdout, sends exit code `0`, waits briefly, then sends a final `tail` chunk and closes the broadcast sender. It then awaits the adapted exit receiver and stdout drain task and asserts that the tail output was preserved.

**Call relations**: This test directly validates the `exit_seen` watch-channel logic inside `spawn_from_driver`, which keeps waiting for broadcast closure after exit.

*Call graph*: calls 1 internal fn (collect_split_output); 7 external calls (assert_eq!, spawn_from_driver, spawn, from_millis, from_secs, sleep, timeout).


##### `pipe_terminate_aborts_detached_readers`  (lines 737–771)

```
async fn pipe_terminate_aborts_detached_readers() -> anyhow::Result<()>
```

**Purpose**: Checks that `ProcessHandle::terminate()` aborts reader tasks even when a detached subprocess keeps producing output independently. The expected result is that no further output is observed after termination.

**Data flow**: Skips if `setsid` is unavailable, spawns a shell command that backgrounds a detached loop printing `tick`, waits for at least one output chunk, calls `session.terminate()`, resubscribes to the combined broadcast receiver, and asserts that a short timeout yields either no message or channel closure rather than more output.

**Call relations**: This test targets the aggressive cleanup path in `ProcessHandle::terminate`, especially aborting detached reader tasks that would otherwise continue forwarding bytes.

*Call graph*: calls 3 internal fn (combine_spawned_output, setsid_available, shell_command); 7 external calls (new, bail!, spawn_pipe_process, eprintln!, vars, from_millis, timeout).


##### `pty_terminate_kills_background_children_in_same_process_group`  (lines 775–816)

```
async fn pty_terminate_kills_background_children_in_same_process_group() -> anyhow::Result<()>
```

**Purpose**: Verifies on Unix that terminating a PTY session kills background descendants in the same process group, not just the shell process itself. It protects against leaked child processes from interactive shells.

**Data flow**: Spawns a PTY shell command that backgrounds `sleep 1000`, prints the background PID with a marker, and waits. It parses the PID from PTY output, asserts the process exists, calls `session.terminate()`, waits up to 3 seconds for the background PID to disappear, force-kills it if necessary for cleanup, and asserts that it exited.

**Call relations**: This test exercises the PTY backend's process-group kill semantics implemented by `PtyChildTerminator` or `RawPidTerminator`.

*Call graph*: calls 5 internal fn (default, combine_spawned_output, shell_command, wait_for_marker_pid, wait_for_process_exit); 6 external calls (new, assert!, spawn_pty_process, format!, kill, vars).


##### `pty_spawn_can_preserve_inherited_fds`  (lines 820–863)

```
async fn pty_spawn_can_preserve_inherited_fds() -> anyhow::Result<()>
```

**Purpose**: Checks that the Unix PTY inherited-FD path leaves an explicitly preserved descriptor open across exec. The child writes through `/dev/fd/$PRESERVED_FD`, and the parent verifies the bytes arrive.

**Data flow**: Creates a Unix pipe, stores the write-end fd number in the environment, spawns `/bin/sh -c 'printf __preserved__ >"/dev/fd/$PRESERVED_FD"'` via `spawn_process_with_inherited_fds` while preserving that fd, drops the parent's write end, waits for process exit, reads the pipe's read end into a string, and asserts both exit code `0` and exact pipe contents.

**Call relations**: This test specifically drives `spawn_process_preserving_fds` and the `close_inherited_fds_except` logic in the PTY backend.

*Call graph*: calls 4 internal fn (default, spawn_process_with_inherited_fds, collect_output_until_exit, combine_spawned_output); 7 external calls (new, new, assert_eq!, last_os_error, pipe, vars, from_raw_fd).


##### `pty_preserving_inherited_fds_keeps_python_repl_running`  (lines 867–941)

```
async fn pty_preserving_inherited_fds_keeps_python_repl_running() -> anyhow::Result<()>
```

**Purpose**: Verifies that preserving inherited file descriptors in the Unix PTY path does not break an interactive Python REPL. It confirms both interactivity and process liveness before clean exit.

**Data flow**: Finds Python, creates a Unix pipe and exports the preserved fd number, spawns Python with `spawn_process_with_inherited_fds`, drops the parent's pipe handles, combines output, probes for REPL readiness by sending print commands, asks Python to print its PID with a marker, parses that PID, asserts the process still exists, sends `exit()`, collects remaining output until exit, and asserts exit code `0`.

**Call relations**: This test covers a subtle regression-prone path: the raw PTY inherited-FD spawn must preserve descriptors without interfering with controlling-terminal setup or interactive behavior.

*Call graph*: calls 7 internal fn (default, spawn_process_with_inherited_fds, collect_output_until_exit, combine_spawned_output, find_python, wait_for_marker_pid, wait_for_python_repl_ready_via_probe); 9 external calls (new, assert!, assert_eq!, last_os_error, eprintln!, format!, pipe, vars, from_raw_fd).


##### `pty_spawn_with_inherited_fds_reports_exec_failures`  (lines 945–989)

```
async fn pty_spawn_with_inherited_fds_reports_exec_failures() -> anyhow::Result<()>
```

**Purpose**: Ensures the Unix PTY inherited-FD path still reports exec failures when the executable is missing. This guards the special-case logic that intentionally leaves CLOEXEC descriptors alone.

**Data flow**: Creates a Unix pipe, attempts to spawn a definitely missing command via `spawn_process_with_inherited_fds` while preserving the write-end fd, drops both pipe ends, and asserts that spawning returned an error whose text indicates a missing executable rather than silently succeeding.

**Call relations**: This test validates the design choice in `close_inherited_fds_except` to keep CLOEXEC descriptors open so Rust's internal exec-error pipe remains functional.

*Call graph*: calls 2 internal fn (default, spawn_process_with_inherited_fds); 7 external calls (new, bail!, assert!, last_os_error, pipe, vars, from_raw_fd).


##### `pty_spawn_with_inherited_fds_supports_resize`  (lines 993–1054)

```
async fn pty_spawn_with_inherited_fds_supports_resize() -> anyhow::Result<()>
```

**Purpose**: Checks that the Unix raw-PTY inherited-FD path supports runtime resize and that the child observes the new dimensions. It uses `stty size` before and after a resize call.

**Data flow**: Creates a Unix pipe, spawns a shell script under `spawn_process_with_inherited_fds` with initial `TerminalSize { rows: 31, cols: 101 }`, waits until output contains `start:31 101`, calls `session.resize(TerminalSize { rows: 45, cols: 132 })`, sends `go\n`, closes stdin, collects remaining output until exit, normalizes CRLF to LF, and asserts that the transcript contains `after:45 132` and exit code `0`.

**Call relations**: This test exercises the `PtyMasterHandle::Opaque` branch in `ProcessHandle::resize`, which uses raw `ioctl(TIOCSWINSZ)` rather than a `MasterPty` object.

*Call graph*: calls 4 internal fn (spawn_process_with_inherited_fds, collect_output_until_exit, combine_spawned_output, wait_for_output_contains); 8 external calls (new, from_utf8_lossy, assert!, assert_eq!, last_os_error, pipe, vars, from_raw_fd).


##### `pipe_spawn_no_stdin_can_preserve_inherited_fds`  (lines 1058–1100)

```
async fn pipe_spawn_no_stdin_can_preserve_inherited_fds() -> anyhow::Result<()>
```

**Purpose**: Checks that the pipe backend's no-stdin spawn path can preserve selected inherited Unix file descriptors across exec. It mirrors the PTY preservation test for the pipe backend.

**Data flow**: Creates a Unix pipe, exports the write-end fd number in the environment, spawns `/bin/sh -c 'printf __pipe_preserved__ >"/dev/fd/$PRESERVED_FD"'` via `spawn_process_no_stdin_with_inherited_fds`, drops the parent's write end, waits for exit, reads the pipe's read end into a string, and asserts exit code `0` plus exact preserved output.

**Call relations**: This test targets the pipe backend's Unix `pre_exec` descriptor-pruning logic and confirms that the inherited-FD allowlist works outside PTY mode as well.

*Call graph*: calls 3 internal fn (spawn_process_no_stdin_with_inherited_fds, collect_output_until_exit, combine_spawned_output); 7 external calls (new, new, assert_eq!, last_os_error, pipe, vars, from_raw_fd).


### Filesystem and stream semantics
This group covers shared filesystem test scaffolding, platform-specific path and sandbox behavior, and the file and HTTP streaming APIs layered on top of exec-server transport.

### `exec-server/tests/file_system/support.rs`

`test` · `shared test setup and sandbox construction`

This support module underpins the filesystem test suite. `FileSystemContext` packages the active `Arc<dyn ExecutorFileSystem>` together with whichever resources must stay alive for that implementation: local mode retains resolved helper paths, while remote mode retains an `ExecServerHarness` so the spawned server process is not dropped during the test. `FileSystemImplementation` is the two-case enum (`Local`, `Remote`) used by parameterized tests, and its `Display` implementation emits the lowercase labels used in assertion context strings.

The central constructor is `create_file_system_context`. In local mode it resolves helper paths from the current test binary, builds `ExecServerRuntimePaths`, and constructs `LocalFileSystem::with_runtime_paths(...)`; this gives tests a direct in-process filesystem implementation configured with the same helper binaries the real server would use. In remote mode it launches a real exec-server with `exec_server()`, creates an `Environment` pointing at the harness WebSocket URL, and extracts the remote filesystem implementation from that environment. The returned context intentionally stores the helper paths or server in private fields so their lifetimes are tied to the filesystem object.

The remaining helpers build sandbox inputs used throughout the tests. `absolute_path` asserts that a `PathBuf` is already absolute before converting it to `AbsolutePathBuf`. `read_only_sandbox` and `workspace_write_sandbox` each wrap one absolute root in a `FileSystemSandboxEntry` with `Read` or `Write` access, and `sandbox_context` turns an arbitrary entry list into a `FileSystemSandboxContext` using a restricted filesystem policy and `NetworkSandboxPolicy::Restricted`.

#### Function details

##### `FileSystemImplementation::fmt`  (lines 36–41)

```
fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the implementation enum as the lowercase strings `local` or `remote` for diagnostics and test-case labels.

**Data flow**: Reads `self`, matches on `FileSystemImplementation::{Local, Remote}`, and writes the corresponding string into the provided formatter. It returns the formatter's `fmt::Result`.

**Call relations**: Used implicitly anywhere the implementation enum is formatted, especially in contextual error messages inside shared tests.

*Call graph*: 1 external calls (write_str).


##### `create_file_system_context`  (lines 44–71)

```
async fn create_file_system_context(
    implementation: FileSystemImplementation,
) -> Result<FileSystemContext>
```

**Purpose**: Constructs a filesystem test context for either the direct local implementation or the remote exec-server-backed implementation.

**Data flow**: Accepts a `FileSystemImplementation`. For `Local`, it resolves helper paths with `test_codex_helper_paths`, builds `ExecServerRuntimePaths::new` from those paths, constructs `LocalFileSystem::with_runtime_paths`, and returns a `FileSystemContext` holding that filesystem plus the helper paths. For `Remote`, it starts an `ExecServerHarness`, creates an `Environment` configured with the harness WebSocket URL, extracts `environment.get_filesystem()`, and returns a context holding the filesystem plus the live server.

**Call relations**: This is the main setup entrypoint for nearly all shared filesystem tests. It delegates to `exec_server` only in remote mode and to `test_codex_helper_paths` plus `ExecServerRuntimePaths::new` only in local mode.

*Call graph*: calls 5 internal fn (create_for_tests, with_runtime_paths, new, exec_server, test_codex_helper_paths); called by 34 (assert_canonicalize_resolves_directory_alias, assert_sandboxed_canonicalize_resolves_directory_alias, file_system_copy_copies_directory_recursively, file_system_copy_copies_file, file_system_copy_rejects_copying_directory_into_descendant, file_system_copy_rejects_directory_without_recursive, file_system_create_directory_creates_nested_directories, file_system_get_metadata_reports_files_and_directories, file_system_read_directory_lists_entries, file_system_read_file_returns_bytes (+15 more)); 1 external calls (new).


##### `absolute_path`  (lines 73–80)

```
fn absolute_path(path: std::path::PathBuf) -> AbsolutePathBuf
```

**Purpose**: Converts an already-absolute `PathBuf` into `AbsolutePathBuf`, failing fast if the input is not absolute.

**Data flow**: Takes ownership of a `PathBuf`, asserts `path.is_absolute()` with a descriptive message, then calls `AbsolutePathBuf::try_from(path)` and unwraps success with `expect`. It returns the validated absolute-path wrapper.

**Call relations**: Used by sandbox-building helpers and one policy-preservation test to ensure all sandbox roots are represented as absolute paths before constructing permission entries.

*Call graph*: calls 1 internal fn (try_from); called by 3 (sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths, read_only_sandbox, workspace_write_sandbox); 1 external calls (assert!).


##### `read_only_sandbox`  (lines 82–90)

```
fn read_only_sandbox(readable_root: std::path::PathBuf) -> FileSystemSandboxContext
```

**Purpose**: Builds a sandbox context that grants read-only access to a single root path.

**Data flow**: Accepts a `PathBuf`, normalizes it through `absolute_path`, wraps it in one `FileSystemSandboxEntry` with `FileSystemAccessMode::Read`, and passes that vector to `sandbox_context`. It returns the resulting `FileSystemSandboxContext`.

**Call relations**: Called by many sandbox-related filesystem tests whenever they need a minimal readable-root sandbox. It delegates common policy assembly to `sandbox_context`.

*Call graph*: calls 2 internal fn (absolute_path, sandbox_context); called by 7 (assert_sandboxed_canonicalize_resolves_directory_alias, file_system_sandboxed_metadata_and_read_allow_readable_root, file_system_sandboxed_write_allows_additional_write_root, file_system_read_directory_rejects_symlink_escape, file_system_sandboxed_read_rejects_symlink_escape, file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape, file_system_sandboxed_write_rejects_unwritable_path); 1 external calls (vec!).


##### `workspace_write_sandbox`  (lines 92–102)

```
fn workspace_write_sandbox(
    writable_root: std::path::PathBuf,
) -> FileSystemSandboxContext
```

**Purpose**: Builds a sandbox context that grants write access to a single workspace root path.

**Data flow**: Accepts a `PathBuf`, validates it with `absolute_path`, wraps it in one `FileSystemSandboxEntry` with `FileSystemAccessMode::Write`, and forwards the entry vector to `sandbox_context`. It returns the resulting sandbox context.

**Call relations**: Used by tests that need a writable-root sandbox, including policy-preservation and symlink/copy/remove scenarios. Like `read_only_sandbox`, it shares the final policy construction through `sandbox_context`.

*Call graph*: calls 2 internal fn (absolute_path, sandbox_context); called by 11 (sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths, file_system_copy_preserves_symlink_source, file_system_copy_rejects_symlink_escape_destination, file_system_copy_rejects_symlink_escape_source, file_system_create_directory_rejects_symlink_escape, file_system_remove_rejects_symlink_escape, file_system_remove_removes_symlink_not_target, file_system_sandboxed_write_allows_explicit_alias_roots, file_system_sandboxed_write_preserves_existing_hard_link, file_system_sandboxed_write_rejects_symlink_escape (+1 more)); 1 external calls (vec!).


##### `sandbox_context`  (lines 104–109)

```
fn sandbox_context(entries: Vec<FileSystemSandboxEntry>) -> FileSystemSandboxContext
```

**Purpose**: Converts a list of filesystem sandbox entries into a `FileSystemSandboxContext` with restricted filesystem and network policies.

**Data flow**: Consumes a `Vec<FileSystemSandboxEntry>`, builds `FileSystemSandboxPolicy::restricted(entries)`, combines it with `NetworkSandboxPolicy::Restricted` in `PermissionProfile::from_runtime_permissions`, and wraps that profile with `FileSystemSandboxContext::from_permission_profile`. It returns the constructed context.

**Call relations**: This private helper is the common implementation behind `read_only_sandbox` and `workspace_write_sandbox`, ensuring all test sandboxes use the same restricted-policy baseline.

*Call graph*: calls 3 internal fn (from_permission_profile, from_runtime_permissions, restricted); called by 2 (read_only_sandbox, workspace_write_sandbox).


### `exec-server/tests/file_system/shared.rs`

`test` · `integration test execution for filesystem implementations`

This file is the main behavioral test suite for `ExecutorFileSystem` implementations. Most tests are parameterized over `FileSystemImplementation::{Local, Remote}` and obtain a concrete filesystem through `create_file_system_context`, allowing the same assertions to validate both direct local execution and the exec-server-backed remote path. The tests cover metadata reporting for files and directories, recursive directory creation, byte writes and reads, text reads, bounded streaming reads using `FILE_READ_CHUNK_SIZE`, file and recursive directory copy, directory listing, recursive removal, and expected failures such as writing into a missing parent or copying a directory without `recursive: true`.

Several tests focus on path and sandbox semantics that are easy to miss. `path_uri_join_and_parent_preserve_lexical_paths` confirms `PathUri` operations are lexical rather than canonicalizing away `..`. `sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths` checks that converting a workspace-write sandbox through `PermissionProfile` preserves read-only subpaths such as `.git`. `file_system_sandboxed_metadata_and_read_allow_readable_root` verifies that a read-only sandbox still permits metadata and content reads inside the allowed root. The two `assert_*canonicalize*` helpers are reusable scenarios for symlink/junction tests in sibling modules: they create an aliased directory tree, prove the requested and canonical paths differ, then assert `canonicalize` resolves to the real target both with and without sandboxing. `file_system_sandboxed_write_allows_additional_write_root` goes further by manually combining a base read-only sandbox with `AdditionalPermissionProfile` data through `effective_file_system_sandbox_policy` and `effective_network_sandbox_policy`, then rebuilding the runtime `PermissionProfile` to prove additional writable roots are honored. Finally, `file_system_copy_rejects_copying_directory_into_descendant` asserts the implementation blocks recursive self-descendant copies with a precise invalid-input error.

#### Function details

##### `sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths`  (lines 28–51)

```
fn sandbox_context_from_profile_preserves_workspace_write_read_only_subpaths() -> Result<()>
```

**Purpose**: Verifies that converting a workspace-write sandbox through `PermissionProfile` preserves nested read-only exclusions such as `.git`.

**Data flow**: Creates a temp writable directory containing `.git`, builds a sandbox with `workspace_write_sandbox`, converts its permissions into a native `PermissionProfile`, extracts the filesystem policy, computes writable roots relative to the writable directory as cwd, canonicalizes the writable and `.git` paths, finds the matching writable root entry, and asserts that its `read_only_subpaths` contains the canonical `.git` path.

**Call relations**: This standalone unit-style test exercises sandbox-policy transformation logic rather than filesystem I/O. It depends on `workspace_write_sandbox` and `absolute_path` from support code.

*Call graph*: calls 2 internal fn (absolute_path, workspace_write_sandbox); 5 external calls (new, assert!, panic!, canonicalize, create_dir_all).


##### `file_system_get_metadata_reports_files_and_directories`  (lines 56–103)

```
async fn file_system_get_metadata_reports_files_and_directories(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that metadata queries correctly distinguish files from directories and report size and timestamps.

**Data flow**: Creates a filesystem context for the selected implementation, writes a file and creates a directory in a temp tree, then calls `get_metadata` on each path. It asserts the returned `FileMetadata` flags (`is_file`, `is_directory`, `is_symlink`), expected sizes, and that `modified_at_ms` is positive, while allowing the actual timestamp fields to vary by comparing them to themselves.

**Call relations**: This parameterized test uses `create_file_system_context` to run the same metadata assertions against both local and remote implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 5 external calls (new, assert!, assert_eq!, create_dir, write).


##### `file_system_create_directory_creates_nested_directories`  (lines 108–128)

```
async fn file_system_create_directory_creates_nested_directories(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that recursive directory creation creates missing parent directories as well as the final target.

**Data flow**: Creates a filesystem context, defines a nested path like `source/nested` under a temp directory, calls `create_directory` with `CreateDirectoryOptions { recursive: true }`, and asserts the nested directory now exists on disk.

**Call relations**: A shared trait test for both implementations, driven through `create_file_system_context`.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 2 external calls (new, assert!).


##### `file_system_write_file_writes_bytes`  (lines 133–152)

```
async fn file_system_write_file_writes_bytes(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that `write_file` writes the provided byte vector to the target path.

**Data flow**: Creates a filesystem context, chooses a temp file path, calls `write_file` with `b"hello from trait".to_vec()`, then reads the file from the host filesystem and asserts the bytes match exactly.

**Call relations**: This parameterized test validates the basic write path for both local and remote filesystems.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 2 external calls (new, assert_eq!).


##### `path_uri_join_and_parent_preserve_lexical_paths`  (lines 155–175)

```
fn path_uri_join_and_parent_preserve_lexical_paths() -> Result<()>
```

**Purpose**: Confirms that `PathUri::join` and `parent` operate lexically and do not normalize away traversal segments.

**Data flow**: Creates a temp source directory URI, joins `nested/note.txt` and compares it to the expected path-built URI, then checks `parent()` returns the lexical nested directory URI. It also joins `../outside` and asserts the resulting URI preserves that lexical traversal rather than canonicalizing it.

**Call relations**: This is a pure path-manipulation test independent of filesystem implementation, included here because many filesystem APIs consume `PathUri`.

*Call graph*: calls 1 internal fn (from_path); 2 external calls (new, assert_eq!).


##### `file_system_read_file_returns_bytes`  (lines 180–197)

```
async fn file_system_read_file_returns_bytes(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that `read_file` returns the exact bytes stored in a regular file.

**Data flow**: Creates a filesystem context, writes `hello from trait` to a temp file using `std::fs`, calls `read_file` on the corresponding `PathUri`, and asserts the returned byte vector matches the original contents.

**Call relations**: A shared read-path test for both local and remote implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, write).


##### `file_system_read_file_stream_returns_bounded_chunks`  (lines 202–236)

```
async fn file_system_read_file_stream_returns_bounded_chunks(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that streaming reads split data into non-empty chunks no larger than `FILE_READ_CHUNK_SIZE` and preserve the full byte sequence.

**Data flow**: Creates a filesystem context, generates a temp file containing `FILE_READ_CHUNK_SIZE * 2 + 17` patterned bytes, calls `read_file_stream`, collects all chunks, asserts every chunk is non-empty and within the size bound, then flattens the chunks and compares the reconstructed bytes to the original vector.

**Call relations**: This parameterized test validates chunk sizing and completeness for both filesystem implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, assert!, assert_eq!, write).


##### `file_system_read_file_text_returns_string`  (lines 241–258)

```
async fn file_system_read_file_text_returns_string(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that `read_file_text` decodes file contents into the expected string.

**Data flow**: Creates a filesystem context, writes a UTF-8 text file, calls `read_file_text` on its `PathUri`, and asserts the returned `String` equals `hello from trait`.

**Call relations**: A shared text-read test for both local and remote implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, write).


##### `file_system_copy_copies_file`  (lines 263–284)

```
async fn file_system_copy_copies_file(implementation: FileSystemImplementation) -> Result<()>
```

**Purpose**: Verifies that copying a regular file duplicates its contents at the destination path.

**Data flow**: Creates a filesystem context, writes a source file, calls `copy` with `CopyOptions { recursive: false }` from source URI to destination URI, then reads the destination file from disk and asserts its text matches the source.

**Call relations**: This parameterized test exercises the simple file-copy path for both implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, write).


##### `file_system_copy_copies_directory_recursively`  (lines 289–318)

```
async fn file_system_copy_copies_directory_recursively(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that recursive copy duplicates a directory tree and its nested file contents.

**Data flow**: Creates a filesystem context, builds a source directory with a nested file, calls `copy` with `CopyOptions { recursive: true }` to a new destination directory, and asserts the nested destination file contains the original text.

**Call relations**: A shared recursive-copy test for both local and remote filesystems.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `file_system_read_directory_lists_entries`  (lines 323–356)

```
async fn file_system_read_directory_lists_entries(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that directory listing returns the expected entry names and file/directory flags.

**Data flow**: Creates a filesystem context, builds a directory containing one nested directory and one file, calls `read_directory`, sorts the returned `ReadDirectoryEntry` values by `file_name`, and asserts the exact two-entry vector with correct `is_directory`/`is_file` flags.

**Call relations**: This parameterized test validates directory enumeration semantics across both implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `file_system_remove_removes_directory`  (lines 361–385)

```
async fn file_system_remove_removes_directory(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that recursive forced removal deletes a directory tree.

**Data flow**: Creates a filesystem context, creates a directory with a nested child, calls `remove` with `RemoveOptions { recursive: true, force: true }`, and asserts the original directory path no longer exists.

**Call relations**: A shared remove-operation test for both local and remote implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert!, create_dir_all).


##### `file_system_write_file_reports_missing_parent`  (lines 390–418)

```
async fn file_system_write_file_reports_missing_parent(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that writing a file into a nonexistent parent directory fails with `NotFound` and does not create the path.

**Data flow**: Creates a filesystem context, defines a file path under a missing parent directory, calls `write_file`, treats success as a test failure, and otherwise asserts the error kind is `std::io::ErrorKind::NotFound` and the target path still does not exist.

**Call relations**: This parameterized negative test checks consistent error semantics for both implementations.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, bail!, assert!, assert_eq!).


##### `file_system_copy_rejects_directory_without_recursive`  (lines 423–449)

```
async fn file_system_copy_rejects_directory_without_recursive(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that copying a directory with `recursive: false` is rejected with a precise invalid-input error.

**Data flow**: Creates a filesystem context, creates a source directory, calls `copy` to a destination with `CopyOptions { recursive: false }`, expects an error, and asserts `ErrorKind::InvalidInput` plus the exact message `fs/copy requires recursive: true when sourcePath is a directory`.

**Call relations**: A shared validation test for both implementations, ensuring the API rejects ambiguous directory-copy requests.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, create_dir_all).


##### `file_system_sandboxed_metadata_and_read_allow_readable_root`  (lines 454–490)

```
async fn file_system_sandboxed_metadata_and_read_allow_readable_root(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that a read-only sandbox permits metadata lookup and file reads within its allowed root.

**Data flow**: Creates a filesystem context, builds an allowed directory and file, constructs a sandbox with `read_only_sandbox(allowed_dir)`, calls `get_metadata` and `read_file` with `Some(&sandbox)`, and asserts the metadata flags/size and returned bytes match the file contents.

**Call relations**: This parameterized test uses the support-layer sandbox helper to validate sandbox enforcement for allowed reads in both implementations.

*Call graph*: calls 3 internal fn (create_file_system_context, read_only_sandbox, from_path); 4 external calls (new, assert_eq!, create_dir_all, write).


##### `assert_canonicalize_resolves_directory_alias`  (lines 492–519)

```
async fn assert_canonicalize_resolves_directory_alias(
    implementation: FileSystemImplementation,
    create_directory_alias: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<()>
```

**Purpose**: Reusable helper that verifies `canonicalize` resolves a directory alias such as a symlink or junction to the real target path.

**Data flow**: Creates a filesystem context, builds a source directory tree with a nested file, invokes the supplied `create_directory_alias` closure to create an alias directory, constructs a requested `PathUri` through the alias and an expected `PathUri` from `std::fs::canonicalize` of the real file, asserts they differ, then calls `file_system.canonicalize` and asserts the returned path equals the expected canonical path.

**Call relations**: This helper is called by platform-specific alias tests in sibling modules. It centralizes the common setup and assertion logic while leaving alias creation to the caller.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); called by 2 (file_system_canonicalize_resolves_directory_symlink, file_system_canonicalize_resolves_directory_junction); 6 external calls (new, assert_eq!, assert_ne!, canonicalize, create_dir_all, write).


##### `assert_sandboxed_canonicalize_resolves_directory_alias`  (lines 521–549)

```
async fn assert_sandboxed_canonicalize_resolves_directory_alias(
    implementation: FileSystemImplementation,
    create_directory_alias: impl FnOnce(&Path, &Path) -> Result<()>,
) -> Result<()>
```

**Purpose**: Reusable helper that verifies `canonicalize` still resolves a directory alias correctly when the request is subject to a sandbox.

**Data flow**: Creates a filesystem context, builds the same aliased directory tree as the unsandboxed helper, constructs a read-only sandbox rooted at the temp directory, computes requested and expected `PathUri` values, asserts they differ, then calls `file_system.canonicalize` with `Some(&sandbox)` and asserts the result equals the canonical target path.

**Call relations**: Called by sandboxed symlink/junction tests in sibling modules. It extends the unsandboxed alias scenario with sandbox setup via `read_only_sandbox`.

*Call graph*: calls 3 internal fn (create_file_system_context, read_only_sandbox, from_path); called by 2 (file_system_sandboxed_canonicalize_resolves_directory_symlink, file_system_sandboxed_canonicalize_resolves_directory_junction); 6 external calls (new, assert_eq!, assert_ne!, canonicalize, create_dir_all, write).


##### `file_system_sandboxed_write_allows_additional_write_root`  (lines 555–603)

```
async fn file_system_sandboxed_write_allows_additional_write_root(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that effective additional permissions can extend a base read-only sandbox to allow writes in an extra writable root.

**Data flow**: Creates a filesystem context, builds separate readable and writable directories, starts from a read-only sandbox over the readable directory, constructs an `AdditionalPermissionProfile` granting read-write access to the writable root, converts the sandbox permissions into a native `PermissionProfile`, computes effective filesystem and network policies with the additional permissions, rebuilds `sandbox.permissions` using `PermissionProfile::from_runtime_permissions_with_enforcement`, then calls `write_file` inside the writable root and asserts the file was created with the expected bytes.

**Call relations**: This parameterized test exercises policy-composition logic rather than just raw filesystem access, proving that additional permissions are merged before enforcement in both implementations.

*Call graph*: calls 7 internal fn (create_file_system_context, read_only_sandbox, from_read_write_roots, from_runtime_permissions_with_enforcement, effective_file_system_sandbox_policy, effective_network_sandbox_policy, from_path); 4 external calls (new, assert_eq!, create_dir_all, vec!).


##### `file_system_copy_rejects_copying_directory_into_descendant`  (lines 608–634)

```
async fn file_system_copy_rejects_copying_directory_into_descendant(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that recursive copy rejects attempts to copy a directory into itself or one of its descendants.

**Data flow**: Creates a filesystem context, builds a source directory with a nested child, calls `copy` from the source to `source/nested/copy` with `recursive: true`, expects an error, and asserts `ErrorKind::InvalidInput` plus the exact message `fs/copy cannot copy a directory to itself or one of its descendants`.

**Call relations**: A shared negative test for both implementations, validating cycle-prevention logic in recursive directory copy.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 3 external calls (new, assert_eq!, create_dir_all).


### `exec-server/tests/file_system_unix.rs`

`test` · `request handling and filesystem operation validation during integration tests`

This test file builds concrete Unix filesystem layouts in temporary directories and verifies how the exec-server filesystem API behaves when paths involve symlinks, hard links, alias roots, FIFOs, and sandbox restrictions. Most tests are parameterized over `FileSystemImplementation::{Local, Remote}` via helpers from `support`, so the same assertions validate both direct and websocket-backed implementations. The file uses `PathUri` to construct request paths, `TempDir` for isolated fixtures, and Unix-specific APIs such as `symlink`, `MetadataExt`, and on Linux `PermissionsExt`.

Two small assertion helpers normalize expected sandbox failures: `assert_sandbox_denied` accepts several OS-dependent error kinds/messages, while `assert_normalized_path_rejected` covers the special case where `PathUri::from_path` has already collapsed `link/../...` before the filesystem layer sees it. Additional helpers locate an aliasing temp root and create directory symlinks; on Linux, `write_fake_bwrap` installs a fake `bwrap` executable to prove the remote helper preserves `PATH` and invokes bubblewrap with `--argv0`.

The tests cover canonicalization through directory aliases, metadata for symlinked files and directories, rejection of reads/writes/copies/removes/create-directory/read-directory operations that would escape a sandbox through symlinks, allowance for explicit alias roots, preservation of existing hard links when writing through an allowed path, removal of a symlink without touching its target, copying symlinks as symlinks, recursive copy preserving symlinks while skipping unknown special files, and explicit rejection of standalone FIFO copy sources. Several assertions intentionally tolerate platform/runtime differences in exact errno mapping while still enforcing the security invariant that sandboxed operations must not traverse outside the allowed root.

#### Function details

##### `assert_sandbox_denied`  (lines 40–61)

```
fn assert_sandbox_denied(error: &std::io::Error)
```

**Purpose**: Checks that an I/O error returned from a sandboxed filesystem operation matches one of the accepted denial shapes on Unix. It accepts multiple `ErrorKind` and message combinations because local and remote implementations can surface slightly different OS-level failures.

**Data flow**: Takes a borrowed `std::io::Error`, reads its `kind()` and formatted message via `to_string()`, then matches them against expected denial cases: `InvalidInput`/`PermissionDenied` with permission text, `NotFound` with missing-file text, or `Other` with read-only-filesystem text. It returns `()` and only produces output by panicking/asserting on unexpected errors.

**Call relations**: This helper is invoked by the sandbox escape and unwritable-path tests after they intentionally provoke a failing operation. It does not delegate to project code; its role is to centralize the acceptance criteria for OS-dependent sandbox rejection behavior.

*Call graph*: called by 8 (file_system_copy_rejects_symlink_escape_destination, file_system_copy_rejects_symlink_escape_source, file_system_create_directory_rejects_symlink_escape, file_system_read_directory_rejects_symlink_escape, file_system_remove_rejects_symlink_escape, file_system_sandboxed_read_rejects_symlink_escape, file_system_sandboxed_write_rejects_symlink_escape, file_system_sandboxed_write_rejects_unwritable_path); 4 external calls (assert!, kind, to_string, panic!).


##### `assert_normalized_path_rejected`  (lines 63–80)

```
fn assert_normalized_path_rejected(error: &std::io::Error)
```

**Purpose**: Validates the error produced when a path containing `..` has already been normalized before reaching the filesystem layer. It allows either an upfront sandbox rejection or a normalized-path miss.

**Data flow**: Consumes a borrowed `std::io::Error`, inspects `kind()` and message text, and accepts either `NotFound` with a standard missing-file message or `InvalidInput`/`PermissionDenied` with permission-denied wording. It returns `()` and fails by panic/assertion if the error shape falls outside those cases.

**Call relations**: Only the `file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape` test uses this helper, because that scenario depends on `PathUri::from_path` collapsing `link/../secret.txt` before the request is sent.

*Call graph*: called by 1 (file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape); 4 external calls (assert!, kind, to_string, panic!).


##### `alias_root_candidate`  (lines 82–89)

```
fn alias_root_candidate() -> Result<Option<PathBuf>>
```

**Purpose**: Finds a temporary-directory root whose canonical path differs from its lexical path, so tests can verify sandbox allowances for explicitly configured alias roots. This targets environments where `/tmp` or the process temp dir is itself a symlink or alias.

**Data flow**: Iterates over `/tmp` and `std::env::temp_dir()`, reads filesystem state with `is_dir()` and `canonicalize()`, and returns `Ok(Some(root))` for the first directory whose canonicalized path is different from the original `PathBuf`. If none qualify, it returns `Ok(None)`.

**Call relations**: The explicit-alias-root write test calls this helper before setting up its sandbox. It has no internal project dependencies and simply prepares fixture selection for that test.

*Call graph*: called by 1 (file_system_sandboxed_write_allows_explicit_alias_roots); 2 external calls (new, temp_dir).


##### `create_directory_symlink`  (lines 91–94)

```
fn create_directory_symlink(target: &Path, alias: &Path) -> Result<()>
```

**Purpose**: Creates a Unix directory symlink used by shared canonicalization tests. It wraps `std::os::unix::fs::symlink` in the `anyhow::Result` shape expected by the shared helper.

**Data flow**: Accepts a target `&Path` and alias `&Path`, creates the symlink on disk, and returns `Ok(())` or the propagated filesystem error.

**Call relations**: This function is passed as a callback into the shared canonicalization assertions so those generic tests can create a platform-appropriate directory alias.

*Call graph*: 1 external calls (symlink).


##### `write_fake_bwrap`  (lines 97–143)

```
fn write_fake_bwrap(bin_dir: &Path) -> Result<PathBuf>
```

**Purpose**: Installs a fake executable named `bwrap` that logs its arguments and then execs the inner command, allowing the Linux test to verify helper-side sandbox invocation behavior without depending on a real bubblewrap binary. It also responds to `--help` so discovery logic treats it as usable.

**Data flow**: Takes a binary directory path, creates it, writes a shell script to `bin_dir/bwrap`, reads and mutates its permissions to mode `0o755`, and returns the resulting `PathBuf`. The script appends all arguments to `bwrap.log`, extracts `--argv0` and the command after `--`, then `exec`s that command.

**Call relations**: Only the Linux-specific PATH-preservation test calls this helper during fixture setup. The test later reads the generated log file to confirm the remote filesystem helper found and invoked this fake `bwrap`.

*Call graph*: called by 1 (sandboxed_file_system_helper_finds_bwrap_on_preserved_path); 5 external calls (join, create_dir_all, metadata, set_permissions, write).


##### `file_system_canonicalize_resolves_directory_symlink`  (lines 148–153)

```
async fn file_system_canonicalize_resolves_directory_symlink(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that canonicalization resolves a directory symlink alias to the underlying real directory for both filesystem implementations.

**Data flow**: Receives a `FileSystemImplementation`, passes it together with `create_directory_symlink` into the shared canonicalization assertion, awaits the async result, and returns that `Result<()>` unchanged.

**Call relations**: This is a thin test wrapper around `shared::assert_canonicalize_resolves_directory_alias`, supplying the Unix alias-construction function and running once for local and once for remote mode.

*Call graph*: calls 1 internal fn (assert_canonicalize_resolves_directory_alias).


##### `file_system_sandboxed_canonicalize_resolves_directory_symlink`  (lines 158–166)

```
async fn file_system_sandboxed_canonicalize_resolves_directory_symlink(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that canonicalization still resolves a directory symlink correctly when the operation is performed under sandbox rules.

**Data flow**: Accepts a `FileSystemImplementation`, forwards it and `create_directory_symlink` to the shared sandboxed canonicalization assertion, awaits completion, and returns the resulting `Result<()>`.

**Call relations**: Like the non-sandboxed variant, this test delegates almost all logic to the shared helper, differing only in using the sandbox-aware shared assertion.

*Call graph*: calls 1 internal fn (assert_sandboxed_canonicalize_resolves_directory_alias).


##### `sandboxed_file_system_helper_finds_bwrap_on_preserved_path`  (lines 170–207)

```
async fn sandboxed_file_system_helper_finds_bwrap_on_preserved_path() -> Result<()>
```

**Purpose**: Linux-only regression test proving that the remote filesystem helper preserves `PATH`, discovers `bwrap` from that path, and invokes it with `--argv0` while performing a sandboxed write.

**Data flow**: Creates a temp directory, writes a fake `bwrap`, prepends its directory to `PATH`, starts an exec-server with that environment, builds a remote `Environment`, obtains its filesystem, creates a workspace and write sandbox, then writes a file through `write_file`. After confirming the file contents on disk, it reads `bwrap.log` and asserts the logged invocation contains `--argv0`.

**Call relations**: This test drives the full remote path: it starts a server with `exec_server_with_env`, constructs a remote `Environment`, gets the filesystem, and performs a sandboxed write. The fake `bwrap` helper is used only to observe the helper process invocation indirectly.

*Call graph*: calls 5 internal fn (create_for_tests, exec_server_with_env, workspace_write_sandbox, write_fake_bwrap, from_path); 9 external calls (new, assert!, assert_eq!, join_paths, split_paths, var_os, create_dir_all, read_to_string, vec!).


##### `file_system_get_metadata_reports_symlink_targets`  (lines 212–264)

```
async fn file_system_get_metadata_reports_symlink_targets(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Ensures `get_metadata` reports symlink status while still reflecting the target type and size for both file and directory symlinks.

**Data flow**: Builds a filesystem context, creates a real file and a symlink to it, calls `get_metadata` on the symlink path, and compares the returned `FileMetadata` fields against expected values including `is_symlink: true`, target-derived `is_file`/`is_directory`, and target size. It repeats the pattern for a directory symlink and returns `Ok(())` after assertions.

**Call relations**: The test directly exercises the filesystem implementation returned by `create_file_system_context`. It does not use sandboxing; instead it validates the metadata contract exposed by `get_metadata`.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 6 external calls (new, assert!, assert_eq!, create_dir, write, symlink).


##### `file_system_sandboxed_write_rejects_unwritable_path`  (lines 269–294)

```
async fn file_system_sandboxed_write_rejects_unwritable_path(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that a write inside a read-only sandbox root is denied and does not create the target file.

**Data flow**: Creates a filesystem context and temp path, constructs a read-only sandbox rooted at the temp directory, attempts `write_file` to `blocked.txt`, captures the expected `std::io::Error`, validates it with `assert_sandbox_denied`, and finally asserts the path does not exist.

**Call relations**: This test invokes the filesystem's `write_file` under a restrictive sandbox and uses the shared denial helper to tolerate implementation-specific errno details.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_sandbox_denied, from_path); 3 external calls (new, bail!, assert!).


##### `file_system_sandboxed_write_allows_explicit_alias_roots`  (lines 299–326)

```
async fn file_system_sandboxed_write_allows_explicit_alias_roots(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that a sandbox rooted at an alias path still permits writes beneath that alias when the alias root itself is explicitly configured as writable.

**Data flow**: Calls `alias_root_candidate`; if no aliasing root exists, the test exits successfully. Otherwise it creates a temp directory under that alias root, builds a write sandbox rooted at the alias path, writes `note.txt` through the filesystem API, and confirms the file contains `created`.

**Call relations**: This test depends on `alias_root_candidate` to find a meaningful environment. It then exercises `write_file` with a sandbox that should accept the lexical alias root even if canonicalization differs.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, alias_root_candidate, from_path); 2 external calls (assert_eq!, new).


##### `file_system_sandboxed_read_rejects_symlink_escape`  (lines 331–357)

```
async fn file_system_sandboxed_read_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Ensures a sandboxed read cannot follow a symlink inside the allowed directory to a target outside the sandbox.

**Data flow**: Creates `allowed` and `outside` directories, writes `outside/secret.txt`, creates `allowed/link -> outside`, then attempts `read_file` on `allowed/link/secret.txt` under a read-only sandbox rooted at `allowed`. It expects an error, validates it with `assert_sandbox_denied`, and returns success only if the read was blocked.

**Call relations**: The test sets up a classic symlink escape and then drives the filesystem's `read_file`. It uses the common denial helper because exact error mapping may differ between local and remote implementations.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, create_dir_all, write, symlink).


##### `file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape`  (lines 362–392)

```
async fn file_system_sandboxed_read_rejects_symlink_parent_dotdot_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Tests the subtler case where a symlink escape path includes `..`, and path normalization may rewrite the request before the filesystem layer evaluates sandbox rules.

**Data flow**: Creates `allowed`, `outside`, and a top-level `secret.txt`, then creates `allowed/link -> outside`. It constructs a `PathUri` from `allowed/link/../secret.txt`, attempts `read_file` under a read-only sandbox rooted at `allowed`, captures the expected error, and validates it with `assert_normalized_path_rejected`.

**Call relations**: This test exists specifically because `PathUri::from_path` normalizes the path before transmission. The helper assertion reflects that the resulting failure may be either sandbox rejection or plain not-found depending on alias resolution.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_normalized_path_rejected, from_path); 5 external calls (new, bail!, create_dir_all, write, symlink).


##### `file_system_sandboxed_write_rejects_symlink_escape`  (lines 397–427)

```
async fn file_system_sandboxed_write_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that a sandboxed write cannot create or modify a file by traversing a symlink from an allowed directory into an outside directory.

**Data flow**: Creates `allowed` and `outside`, adds `allowed/link -> outside`, then attempts `write_file` to `allowed/link/blocked.txt` under a write sandbox rooted at `allowed`. It expects an error, validates it with `assert_sandbox_denied`, and asserts `outside/blocked.txt` was not created.

**Call relations**: This test mirrors the read-escape case but for writes, directly exercising `write_file` under a writable sandbox that should still reject symlink traversal outside the root.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, assert!, create_dir_all, symlink).


##### `file_system_sandboxed_write_preserves_existing_hard_link`  (lines 432–476)

```
async fn file_system_sandboxed_write_preserves_existing_hard_link(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that writing through an allowed hard link updates the shared inode rather than being rejected or replaced, even when the other link lives outside the sandbox.

**Data flow**: Creates `outside/outside.txt`, creates a hard link to it at `allowed/hard-link.txt`, then writes new contents through the allowed path under a write sandbox rooted at `allowed`. Afterward it reads both paths and compares `(dev, ino)` from `metadata()` to confirm they still reference the same inode.

**Call relations**: This test exercises a deliberate design distinction: symlink traversal is blocked, but an existing hard link inside the sandbox remains a legitimate writable path. It uses the filesystem API for the write and host filesystem metadata for postconditions.

*Call graph*: calls 3 internal fn (create_file_system_context, workspace_write_sandbox, from_path); 6 external calls (new, assert_eq!, create_dir_all, hard_link, metadata, write).


##### `file_system_create_directory_rejects_symlink_escape`  (lines 481–511)

```
async fn file_system_create_directory_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Ensures `create_directory` does not create a directory outside the sandbox by traversing a symlinked path component.

**Data flow**: Creates `allowed` and `outside`, adds `allowed/link -> outside`, then calls `create_directory` for `allowed/link/created` with `CreateDirectoryOptions { recursive: false }` under a write sandbox rooted at `allowed`. It expects an error, validates it, and asserts `outside/created` does not exist.

**Call relations**: This test covers sandbox enforcement for directory creation specifically, complementing the read/write/copy/remove escape tests.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, assert!, create_dir_all, symlink).


##### `file_system_read_directory_rejects_symlink_escape`  (lines 516–542)

```
async fn file_system_read_directory_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that `read_directory` cannot list an outside directory by addressing it through a symlink located inside the sandbox.

**Data flow**: Creates `allowed` and `outside`, writes a file in `outside`, creates `allowed/link -> outside`, then attempts `read_directory` on `allowed/link` under a read-only sandbox rooted at `allowed`. It expects and validates a denial error.

**Call relations**: This test targets directory listing rather than file reads, ensuring the same symlink-escape invariant applies to enumeration APIs.

*Call graph*: calls 4 internal fn (create_file_system_context, read_only_sandbox, assert_sandbox_denied, from_path); 5 external calls (new, bail!, create_dir_all, write, symlink).


##### `file_system_copy_rejects_symlink_escape_destination`  (lines 547–579)

```
async fn file_system_copy_rejects_symlink_escape_destination(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Ensures `copy` refuses to write the destination through a symlink that points outside the sandbox.

**Data flow**: Creates `allowed/source.txt`, creates `allowed/link -> outside`, then calls `copy` from the allowed source to `allowed/link/copied.txt` with `CopyOptions { recursive: false }` under a write sandbox rooted at `allowed`. It expects a denial and confirms the outside destination was not created.

**Call relations**: This test exercises destination-path validation in `copy`, using the same sandbox denial helper as other escape tests.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 6 external calls (new, bail!, assert!, create_dir_all, write, symlink).


##### `file_system_remove_removes_symlink_not_target`  (lines 584–618)

```
async fn file_system_remove_removes_symlink_not_target(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that removing a symlink path deletes the symlink itself rather than deleting the file it points to.

**Data flow**: Creates an outside file, creates a symlink to it inside `allowed`, then calls `remove` on the symlink path with non-recursive, non-force options under a write sandbox rooted at `allowed`. After the call it asserts the symlink no longer exists while the outside target still exists with unchanged contents.

**Call relations**: This test covers the non-escape case for symlink removal semantics: `remove` should operate on the link entry itself when that entry is inside the sandbox.

*Call graph*: calls 3 internal fn (create_file_system_context, workspace_write_sandbox, from_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, write, symlink).


##### `file_system_copy_preserves_symlink_source`  (lines 623–656)

```
async fn file_system_copy_preserves_symlink_source(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that copying a symlink source produces another symlink with the same target instead of dereferencing and copying the target file contents.

**Data flow**: Creates an outside file and a symlink to it inside `allowed`, then calls `copy` from that symlink to `allowed/copied-link` under a write sandbox. It inspects `symlink_metadata` on the destination to confirm it is a symlink and uses `read_link` to verify the stored target path equals the original outside file path.

**Call relations**: This test validates source semantics for `copy`, complementing the destination-escape and recursive-copy tests.

*Call graph*: calls 3 internal fn (create_file_system_context, workspace_write_sandbox, from_path); 7 external calls (new, assert!, assert_eq!, create_dir_all, symlink_metadata, write, symlink).


##### `file_system_remove_rejects_symlink_escape`  (lines 661–696)

```
async fn file_system_remove_rejects_symlink_escape(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Ensures `remove` cannot delete an outside file by traversing a symlinked directory from within the sandbox.

**Data flow**: Creates `outside/secret.txt`, creates `allowed/link -> outside`, then attempts `remove` on `allowed/link/secret.txt` under a write sandbox rooted at `allowed`. It expects a denial and confirms the outside file still contains `outside`.

**Call relations**: This test covers the dangerous remove-through-symlink case, using the same denial helper as the other sandbox escape tests.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 6 external calls (new, bail!, assert_eq!, create_dir_all, write, symlink).


##### `file_system_copy_rejects_symlink_escape_source`  (lines 701–735)

```
async fn file_system_copy_rejects_symlink_escape_source(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that `copy` refuses to read a source file through a symlinked path that escapes the sandbox, even when the destination is inside the sandbox.

**Data flow**: Creates `outside/secret.txt`, creates `allowed/link -> outside`, then calls `copy` from `allowed/link/secret.txt` to `allowed/copied.txt` under a write sandbox rooted at `allowed`. It expects a denial and asserts the destination file was not created.

**Call relations**: This complements the destination-escape copy test by validating source-path sandbox checks in `copy`.

*Call graph*: calls 4 internal fn (create_file_system_context, workspace_write_sandbox, assert_sandbox_denied, from_path); 6 external calls (new, bail!, assert!, create_dir_all, write, symlink).


##### `file_system_copy_preserves_symlinks_in_recursive_copy`  (lines 740–772)

```
async fn file_system_copy_preserves_symlinks_in_recursive_copy(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that recursive directory copy preserves symlink entries as symlinks rather than flattening them into copied directories or files.

**Data flow**: Creates `source/nested` and a relative symlink `source/nested-link -> nested`, then calls `copy` recursively from `source` to `copied` without a sandbox. It inspects `copied/nested-link` with `symlink_metadata` and `read_link` to confirm it remains a symlink pointing to the relative target `nested`.

**Call relations**: This test exercises recursive copy behavior on supported special entries, contrasting with the next test that skips unsupported special files.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 6 external calls (new, assert!, assert_eq!, create_dir_all, symlink_metadata, symlink).


##### `file_system_copy_ignores_unknown_special_files_in_recursive_copy`  (lines 777–816)

```
async fn file_system_copy_ignores_unknown_special_files_in_recursive_copy(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that recursive copy skips unsupported special files such as FIFOs while still copying ordinary files from the same directory tree.

**Data flow**: Creates a source directory with `note.txt`, creates a FIFO named `named-pipe` via `mkfifo`, then recursively copies the directory. Afterward it asserts `copied/note.txt` contains `hello` and `copied/named-pipe` does not exist.

**Call relations**: This test drives `copy` in recursive mode to validate its policy for unknown special file types: ignore them during tree copy instead of failing the whole operation.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 7 external calls (new, bail!, assert!, assert_eq!, new, create_dir_all, write).


##### `file_system_copy_rejects_standalone_fifo_source`  (lines 821–854)

```
async fn file_system_copy_rejects_standalone_fifo_source(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Ensures copying a FIFO as the top-level source is rejected with a clear `InvalidInput` error instead of hanging or treating it like a regular file.

**Data flow**: Creates a FIFO with `mkfifo`, calls `copy` on that FIFO path with `recursive: false`, captures the returned error, and asserts both its `ErrorKind` and exact message text match the documented unsupported-source error.

**Call relations**: This test complements the recursive-copy special-file behavior by asserting that an unsupported special file is skipped only when encountered inside a recursive tree, not accepted as a direct copy source.

*Call graph*: calls 2 internal fn (create_file_system_context, from_path); 4 external calls (new, bail!, assert_eq!, new).


### `exec-server/tests/file_system_windows.rs`

`test` · `filesystem canonicalization validation during Windows integration tests`

This file is the Windows counterpart to the Unix canonicalization tests. Rather than using symlinks, it creates directory aliases with `mklink /J`, because directory junctions are the Windows-native mechanism most relevant to path canonicalization and sandbox checks. The file imports the same shared test modules used on Unix and supplies a Windows-specific alias-construction callback.

`create_directory_junction` shells out to `cmd /C mklink /J <alias> <target>`, captures stdout/stderr, and fails with a detailed `anyhow::bail!` message if junction creation does not succeed. The two async tests are parameterized over `FileSystemImplementation::{Local, Remote}` and simply delegate to shared assertions that verify canonicalization behavior with and without sandboxing. The important design point is that the shared tests remain platform-neutral while this file provides the concrete alias primitive and error reporting needed on Windows.

#### Function details

##### `create_directory_junction`  (lines 19–33)

```
fn create_directory_junction(target: &Path, alias: &Path) -> Result<()>
```

**Purpose**: Creates a Windows directory junction by invoking `mklink /J` through `cmd.exe`. It wraps the platform-specific command invocation in a `Result<()>` suitable for the shared tests.

**Data flow**: Accepts target and alias `&Path` values, runs `cmd /C mklink /J alias target`, inspects the command exit status, and returns `Ok(())` on success. On failure it formats stdout and stderr into an `anyhow` error so the test reports the exact junction-creation problem.

**Call relations**: This helper is passed into the shared canonicalization assertions so those generic tests can create a Windows directory alias without embedding platform-specific command logic.

*Call graph*: 2 external calls (bail!, new).


##### `file_system_canonicalize_resolves_directory_junction`  (lines 38–43)

```
async fn file_system_canonicalize_resolves_directory_junction(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Verifies that canonicalization resolves a directory junction to its real target path for both local and remote filesystem implementations.

**Data flow**: Receives a `FileSystemImplementation`, forwards it and `create_directory_junction` to the shared non-sandboxed canonicalization assertion, awaits completion, and returns the resulting `Result<()>`.

**Call relations**: This test is a thin adapter around the shared helper, supplying the Windows alias constructor and running once per implementation mode.

*Call graph*: calls 1 internal fn (assert_canonicalize_resolves_directory_alias).


##### `file_system_sandboxed_canonicalize_resolves_directory_junction`  (lines 48–56)

```
async fn file_system_sandboxed_canonicalize_resolves_directory_junction(
    implementation: FileSystemImplementation,
) -> Result<()>
```

**Purpose**: Checks that canonicalization through a directory junction still works correctly when the operation is evaluated under sandbox rules.

**Data flow**: Accepts a `FileSystemImplementation`, passes it with `create_directory_junction` into the shared sandboxed canonicalization assertion, awaits the async result, and returns it unchanged.

**Call relations**: Like the non-sandboxed variant, this test delegates the scenario logic to the shared helper and exists to bind that helper to the Windows junction primitive.

*Call graph*: calls 1 internal fn (assert_sandboxed_canonicalize_resolves_directory_alias).


### `exec-server/src/local_file_system_path_uri_tests.rs`

`test` · `test`

This small test module exercises the boundary between `PathUri` parsing and native-path conversion in the direct filesystem backend. The helper `non_native_uri` deliberately constructs a syntactically valid `file:` URI that is non-native for the current platform: on Unix it uses a UNC-style authority (`file://server/share/file.txt`), while on Windows it uses a Unix-style absolute path (`file:///usr/local/file.txt`). The test then calls `DirectFileSystem.read_file(..., None)` and asserts that the operation fails with `io::ErrorKind::InvalidInput`.

The important nuance captured here is that `PathUri::parse` is not expected to reject every URI that cannot be used on the current host. Instead, the filesystem layer’s `to_abs_path()` conversion is the enforcement point. This test protects that contract and ensures direct filesystem operations fail cleanly before attempting any disk I/O when given a URI that is valid in abstract URI terms but not representable as a native absolute path on the running OS.

#### Function details

##### `direct_file_system_rejects_non_native_uri_as_invalid_input`  (lines 8–15)

```
async fn direct_file_system_rejects_non_native_uri_as_invalid_input()
```

**Purpose**: Verifies that `DirectFileSystem::read_file` rejects a parsed but non-native `PathUri` with `InvalidInput`. It confirms host-path validation happens in the filesystem layer.

**Data flow**: It builds a non-native `PathUri` via `non_native_uri()`, awaits `DirectFileSystem.read_file(&uri, None)`, expects an error, and asserts `error.kind() == io::ErrorKind::InvalidInput`.

**Call relations**: This test drives the direct read path specifically because `DirectFileSystem::open_file_for_read` and `to_abs_path()` are where native-path enforcement occurs.

*Call graph*: calls 1 internal fn (non_native_uri); 1 external calls (assert_eq!).


##### `non_native_uri`  (lines 17–27)

```
fn non_native_uri() -> PathUri
```

**Purpose**: Constructs a platform-opposite `file:` URI that should parse successfully but not map to a native absolute path on the current host. It gives the test a deterministic invalid-input case.

**Data flow**: It selects a URI string with `#[cfg]`, calls `PathUri::parse(uri)`, returns the parsed `PathUri` on success, and panics if parsing unexpectedly fails.

**Call relations**: Only the test function calls this helper. Its role is to isolate the distinction between URI syntax validity and native filesystem usability.

*Call graph*: calls 1 internal fn (parse); called by 1 (direct_file_system_rejects_non_native_uri_as_invalid_input); 1 external calls (panic!).


### `exec-server/src/remote_file_system_path_uri_tests.rs`

`test` · `test`

This file is a focused integration test for URI fidelity in `RemoteFileSystem`. The main test starts a temporary websocket server with `record_read_file_params`, constructs a `RemoteFileSystem` backed by `LazyRemoteExecServerClient::new(ExecServerTransportParams::websocket_url(...))`, and issues two `read_file` calls using deliberately non-native URIs: on Unix it uses Windows-style drive and UNC file URIs, while on Windows it uses a Unix-style cwd URI. It also builds a sandbox context whose cwd is required by a `project_roots` permission policy. The assertion is that the captured `FsReadFileParams` sent over JSON-RPC contain the exact original `PathUri` values and cloned sandbox context, proving no host-native path conversion occurred.

The helper server performs just enough protocol to satisfy the client. `record_read_file_params` binds a localhost listener, upgrades one websocket, calls `complete_websocket_initialize` to answer the client’s `initialize` request and consume the `initialized` notification, then reads a fixed number of JSON-RPC requests with `read_jsonrpc_websocket`. For each `fs/readFile` request it deserializes `FsReadFileParams`, stores them, and replies with an empty `FsReadFileResponse`. `read_jsonrpc_websocket` accepts either text or binary JSON-RPC frames and ignores ping/pong traffic, while `write_jsonrpc_websocket` always sends text frames. The test therefore validates the client’s serialized request content rather than any filesystem semantics.

#### Function details

##### `remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion`  (lines 35–79)

```
async fn remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion()
```

**Purpose**: Verifies that `RemoteFileSystem::read_file` transmits `PathUri` paths and sandbox cwd values exactly as URIs, even when those URIs are non-native for the local OS.

**Data flow**: The test starts a recording websocket server expecting two requests, constructs `RemoteFileSystem`, prepares two explicit `PathUri` file locations and a sandbox context with a non-native cwd, then calls `read_file` for each path and asserts both calls return empty byte vectors. It awaits the captured `FsReadFileParams` from the server and compares them against the exact expected parameter structs containing the original URIs and cloned sandbox.

**Call relations**: It exercises the full client stack behind `RemoteFileSystem::read_file`, while relying on `record_read_file_params` and related helpers to inspect the outbound JSON-RPC payloads.

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

**Purpose**: Runs a temporary websocket JSON-RPC server that captures a fixed number of `fs/readFile` request parameter objects and returns empty successful responses.

**Data flow**: It takes `expected_requests`, binds a localhost `TcpListener`, formats a websocket URL, creates a oneshot channel for captured params, and spawns a server task. That task accepts one TCP connection, upgrades it with `accept_async`, completes initialization, then loops `expected_requests` times reading JSON-RPC messages, asserting each is an `FS_READ_FILE_METHOD` request, deserializing `FsReadFileParams`, storing them, and replying with a `JSONRPCResponse` containing `FsReadFileResponse { data_base64: String::new() }`. The function returns the websocket URL, the oneshot receiver, and the server task handle.

**Call relations**: It is called only by the main path-URI test and delegates protocol details to `complete_websocket_initialize`, `read_jsonrpc_websocket`, and `write_jsonrpc_websocket`.

*Call graph*: calls 3 internal fn (complete_websocket_initialize, read_jsonrpc_websocket, write_jsonrpc_websocket); called by 1 (remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 11 external calls (new, bind, with_capacity, Response, format!, channel, panic!, from_value, to_value, spawn (+1 more)).


##### `non_native_cwd`  (lines 132–139)

```
fn non_native_cwd() -> PathUri
```

**Purpose**: Produces a cwd `PathUri` that is intentionally non-native for the current platform so the test can detect accidental path normalization.

**Data flow**: It selects a URI string at compile time: on Unix `file://server/share/checkout`, on Windows `file:///usr/local/checkout`, parses it with `PathUri::parse`, and returns the resulting URI.

**Call relations**: It is used by the main test to populate the sandbox context with a cwd that should survive transmission unchanged.

*Call graph*: calls 1 internal fn (parse); called by 1 (remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion).


##### `complete_websocket_initialize`  (lines 141–163)

```
async fn complete_websocket_initialize(websocket: &mut WebSocketStream<TcpStream>)
```

**Purpose**: Performs the minimal JSON-RPC initialization handshake expected by the remote exec-server client before normal requests can flow.

**Data flow**: It reads one JSON-RPC message from the websocket, requires it to be an `INITIALIZE_METHOD` request, replies with a `JSONRPCResponse` containing `InitializeResponse { session_id: "session-1" }`, then reads one more message and requires it to be an `INITIALIZED_METHOD` notification. Any mismatch causes a panic.

**Call relations**: It is called by `record_read_file_params` immediately after websocket upgrade so the client under test can proceed to send `fs/readFile` requests.

*Call graph*: calls 2 internal fn (read_jsonrpc_websocket, write_jsonrpc_websocket); called by 1 (record_read_file_params); 3 external calls (Response, panic!, to_value).


##### `read_jsonrpc_websocket`  (lines 165–185)

```
async fn read_jsonrpc_websocket(websocket: &mut WebSocketStream<TcpStream>) -> JSONRPCMessage
```

**Purpose**: Reads the next JSON-RPC message from a websocket, accepting either text or binary JSON payloads and ignoring ping/pong frames.

**Data flow**: It loops with a one-second timeout around `websocket.next()`, unwraps websocket and frame errors, and matches on the message type. `Message::Text` is parsed with `serde_json::from_str`, `Message::Binary` with `serde_json::from_slice`, ping/pong frames are ignored, and any other frame type causes a panic. It returns the parsed `JSONRPCMessage`.

**Call relations**: It is used by both `complete_websocket_initialize` and `record_read_file_params` to consume client traffic in a transport-agnostic way.

*Call graph*: called by 2 (complete_websocket_initialize, record_read_file_params); 6 external calls (from_secs, next, panic!, from_slice, from_str, timeout).


##### `write_jsonrpc_websocket`  (lines 187–196)

```
async fn write_jsonrpc_websocket(
    websocket: &mut WebSocketStream<TcpStream>,
    message: JSONRPCMessage,
)
```

**Purpose**: Serializes a JSON-RPC message and sends it as a websocket text frame.

**Data flow**: It takes a mutable websocket and a `JSONRPCMessage`, serializes the message with `serde_json::to_string`, wraps it in `Message::Text`, sends it with `websocket.send(...)`, and panics if serialization or sending fails.

**Call relations**: It is used by `complete_websocket_initialize` and `record_read_file_params` to send server responses back to the client under test.

*Call graph*: called by 2 (complete_websocket_initialize, record_read_file_params); 3 external calls (send, to_string, Text).


### `exec-server/src/sandboxed_file_system_path_uri_tests.rs`

`test` · `test execution`

This test file exercises a subtle validation rule in `SandboxedFileSystem`: only native local paths are accepted, even if a `PathUri` parses successfully. The main async test constructs real `ExecServerRuntimePaths` from the current executable, creates a `SandboxedFileSystem`, and builds a restrictive `FileSystemSandboxContext` from runtime permissions so the backend takes the sandboxed path rather than short-circuiting on policy. It then calls `read_file` with a deliberately non-native URI and asserts that the operation fails with `tokio::io::ErrorKind::InvalidInput`.

The helper `non_native_uri` is platform-conditional so the test always chooses a URI that is valid syntax but non-native for the current OS: on Unix it uses a UNC-style `file://server/share/file.txt`, while on Windows it uses a Unix-style absolute file URI. That distinction matters because the test is not checking URI parsing; it is checking the later `to_abs_path()` validation performed by `validate_native_path` in the production file.

Overall, this file documents an important invariant for callers: sandboxed filesystem methods accept only paths that can be interpreted as native absolute local filesystem paths on the running platform.

#### Function details

##### `sandboxed_file_system_rejects_non_native_uri_as_invalid_input`  (lines 11–31)

```
async fn sandboxed_file_system_rejects_non_native_uri_as_invalid_input()
```

**Purpose**: Verifies that a sandboxed read against a non-native URI fails with `InvalidInput` rather than reaching helper execution.

**Data flow**: Builds `ExecServerRuntimePaths` from `std::env::current_exe()`, constructs `SandboxedFileSystem::new(runtime_paths)`, creates a restrictive `FileSystemSandboxContext` from runtime permissions, invokes `file_system.read_file(&non_native_uri(), Some(&sandbox)).await`, expects an error, and asserts `error.kind() == io::ErrorKind::InvalidInput`.

**Call relations**: This test drives the production path through `SandboxedFileSystem::read_file`, relying on `non_native_uri` to supply a parsed-but-invalid-for-platform path.

*Call graph*: calls 6 internal fn (new, new, non_native_uri, from_permission_profile, from_runtime_permissions, restricted); 3 external calls (new, assert_eq!, current_exe).


##### `non_native_uri`  (lines 33–43)

```
fn non_native_uri() -> PathUri
```

**Purpose**: Produces a `PathUri` that parses successfully but is non-native on the current platform.

**Data flow**: Selects a platform-specific URI string via `#[cfg]`, parses it with `PathUri::parse`, returns the parsed URI on success, and panics if parsing unexpectedly fails.

**Call relations**: Used only by the test to isolate the platform-specific URI choice from the assertion logic.

*Call graph*: calls 1 internal fn (parse); called by 1 (sandboxed_file_system_rejects_non_native_uri_as_invalid_input); 1 external calls (panic!).


### `exec-server/tests/file_stream.rs`

`test` · `integration test execution against remote file-read APIs`

This file focuses on the remote filesystem path exposed through the exec-server. Most tests start a real server with `exec_server()`, connect either a high-level `ExecutorFileSystem` via `Environment::create_for_tests` or a lower-level `ExecServerClient`, and then exercise file-read operations against temporary files. The constants `BLOCK_SIZE` and `OPEN_FILE_LIMIT` encode the expected protocol chunk size and per-connection open-handle cap.

The streaming tests verify concrete semantics rather than just success: exact block-boundary reads must stop after two full chunks with no empty trailing chunk; repeatedly completed streams must release handle capacity so more than `OPEN_FILE_LIMIT` sequential reads succeed; platform sandbox arguments are rejected for streaming reads with `ErrorKind::Unsupported`; Unix FIFOs and Windows named pipes must fail quickly instead of blocking for a writer; and on Unix, replacing the path after opening a stream must not affect the already-open file descriptor, so the stream continues returning bytes from the original file.

The protocol-level tests use `ExecServerClient` directly to validate `fs/open`, `fs/readBlock`, and `fs/close`. They confirm non-sequential offset/length reads, EOF signaling when a requested range extends past the file end, enforcement of the per-connection open-file limit with a JSON-RPC server error, release of capacity after `fs_close`, and rejection of handle IDs longer than 32 bytes. Two small helpers round out the file: `connect_file_system` builds a remote `ExecutorFileSystem`, and `read_only_sandbox` constructs a `FileSystemSandboxContext` from runtime permissions for the one test that checks sandbox rejection.

#### Function details

##### `stream_stops_after_an_exact_block_boundary`  (lines 40–58)

```
async fn stream_stops_after_an_exact_block_boundary() -> Result<()>
```

**Purpose**: Verifies that streaming a file whose size is an exact multiple of the block size yields only full chunks and no extra empty chunk.

**Data flow**: Starts an exec-server, connects a remote filesystem, writes a temporary file containing `BLOCK_SIZE * 2` bytes of `x`, then calls `read_file_stream(...).try_collect::<Vec<_>>()`. It maps the resulting chunks to their lengths and asserts the vector is exactly `[BLOCK_SIZE, BLOCK_SIZE]`.

**Call relations**: This standalone test uses `exec_server` and `connect_file_system` to exercise the high-level streaming API against a real remote server.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 4 external calls (new, assert_eq!, write, vec!).


##### `completed_streams_release_handle_capacity`  (lines 61–79)

```
async fn completed_streams_release_handle_capacity() -> Result<()>
```

**Purpose**: Checks that fully consumed file streams free their underlying remote handles so repeated sequential reads do not exhaust the per-connection limit.

**Data flow**: Starts a server, connects the filesystem, writes a small file, converts its path to `PathUri`, and in a loop of `0..=OPEN_FILE_LIMIT` repeatedly opens a stream, collects all chunks, and asserts the content equals `repeated`. Successful completion of all iterations demonstrates capacity release.

**Call relations**: This test uses the high-level stream API rather than raw protocol calls to prove that normal stream completion closes remote handles.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 3 external calls (new, assert_eq!, write).


##### `stream_rejects_platform_sandbox`  (lines 82–105)

```
async fn stream_rejects_platform_sandbox() -> Result<()>
```

**Purpose**: Verifies that `read_file_stream` rejects requests that include a platform sandbox context.

**Data flow**: Starts a server, connects the filesystem, writes a temporary file, builds a read-only sandbox rooted at the temp directory, and calls `read_file_stream` with `Some(&sandbox)`. It expects an error, then asserts `ErrorKind::Unsupported` and the exact message `streaming file reads do not support platform sandboxing`.

**Call relations**: This test depends on `read_only_sandbox` to construct the sandbox context and confirms a deliberate API limitation in the remote streaming path.

*Call graph*: calls 4 internal fn (exec_server, connect_file_system, read_only_sandbox, from_path); 4 external calls (new, assert_eq!, panic!, write).


##### `file_reads_reject_fifo_without_waiting_for_a_writer`  (lines 109–146)

```
async fn file_reads_reject_fifo_without_waiting_for_a_writer() -> Result<()>
```

**Purpose**: On Unix, ensures both whole-file and streaming reads reject FIFOs promptly instead of blocking until some writer connects.

**Data flow**: Starts a server and filesystem, creates a FIFO with `mkfifo`, converts its path to `PathUri`, and wraps both `read_file` and `read_file_stream` calls in 1-second `timeout`s. It expects both operations to finish within the timeout and fail, then asserts both error strings equal `path `<fifo>` is not a file`.

**Call relations**: This Unix-only test uses timeouts to verify non-blocking rejection behavior for special files in both read APIs.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 8 external calls (from_secs, new, bail!, assert_eq!, new, format!, panic!, timeout).


##### `file_reads_reject_named_pipes`  (lines 150–194)

```
async fn file_reads_reject_named_pipes() -> Result<()>
```

**Purpose**: On Windows, ensures named pipes are rejected quickly by both whole-file and streaming read APIs.

**Data flow**: Starts a server and filesystem, creates two unique named pipes with `ServerOptions::new().first_pipe_instance(true).create(...)`, then wraps `read_file` and `read_file_stream` calls in 1-second timeouts. It expects both to fail without hanging and asserts both errors have `std::io::ErrorKind::InvalidInput`.

**Call relations**: This Windows-only test is the platform counterpart to the Unix FIFO test, validating prompt rejection of non-file pipe paths.

*Call graph*: calls 4 internal fn (exec_server, connect_file_system, new, from_path); 6 external calls (from_secs, assert_eq!, format!, panic!, new, timeout).


##### `stream_keeps_reading_the_open_file_after_path_replacement`  (lines 198–223)

```
async fn stream_keeps_reading_the_open_file_after_path_replacement() -> Result<()>
```

**Purpose**: On Unix, verifies that a streaming read continues from the originally opened file even if the pathname is deleted and replaced with a different file mid-stream.

**Data flow**: Starts a server and filesystem, writes a file containing `BLOCK_SIZE + 1` bytes of `a`, opens a stream, and asserts the first chunk is `BLOCK_SIZE` bytes of `a`. It then writes a replacement file of `b`s, removes the original path, renames the replacement into place, and asserts the existing stream yields the final single `a` byte and then ends.

**Call relations**: This test exercises descriptor stability of the remote streaming implementation after open, proving it is tied to the opened file object rather than repeated path lookups.

*Call graph*: calls 3 internal fn (exec_server, connect_file_system, from_path); 6 external calls (new, assert_eq!, remove_file, rename, write, vec!).


##### `read_block_supports_non_sequential_offsets_and_lengths`  (lines 226–285)

```
async fn read_block_supports_non_sequential_offsets_and_lengths() -> Result<()>
```

**Purpose**: Validates the low-level `fs/readBlock` protocol supports arbitrary offset/length requests and reports EOF correctly when reads extend past the end of the file.

**Data flow**: Starts a server, connects an `ExecServerClient` over WebSocket, writes `0123456789` to a temp file, opens it with a random UUID handle ID, then issues four `fs_read_block` requests for offsets/lengths `(6,3)`, `(1,2)`, `(8,4)`, and `(0,2)`. It collects the `FsReadBlockResponse` values, asserts the exact chunks and `eof` flags, closes the handle with `fs_close`, drops the client, and shuts down the server.

**Call relations**: Unlike the higher-level stream tests, this one talks directly to the protocol client to pin down raw block-read semantics and cleanup behavior.

*Call graph*: calls 2 internal fn (exec_server, from_path); 7 external calls (new, new_v4, new, assert_eq!, connect_websocket, new, write).


##### `open_enforces_the_per_connection_limit_and_close_releases_capacity`  (lines 288–345)

```
async fn open_enforces_the_per_connection_limit_and_close_releases_capacity() -> Result<()>
```

**Purpose**: Checks that `fs/open` enforces the configured maximum number of simultaneously open file reads per connection and that `fs/close` frees a slot.

**Data flow**: Starts a server, connects an `ExecServerClient`, writes a temp file, and opens it `OPEN_FILE_LIMIT` times with distinct UUID handle IDs, storing the returned IDs. It then attempts one more open and expects `ExecServerError::Server { code: -32600, message: ... }` with the exact capacity message. After closing one stored handle, it opens another handle successfully, then drops the client and shuts down the server.

**Call relations**: This protocol-level test complements `completed_streams_release_handle_capacity` by checking the server's explicit open-handle accounting and recovery after `fs_close`.

*Call graph*: calls 2 internal fn (exec_server, from_path); 8 external calls (new, new_v4, with_capacity, bail!, assert_eq!, connect_websocket, new, write).


##### `open_rejects_handle_ids_longer_than_32_bytes`  (lines 348–379)

```
async fn open_rejects_handle_ids_longer_than_32_bytes() -> Result<()>
```

**Purpose**: Verifies that the server rejects oversized file-read handle IDs during `fs/open` validation.

**Data flow**: Starts a server, connects an `ExecServerClient`, writes a temp file, and calls `fs_open` with a 33-character handle ID. It expects an `ExecServerError::Server`, destructures it, and asserts code `-32600` with message `file read handle ID must not exceed 32 bytes`.

**Call relations**: This test uses the raw protocol client because the validation occurs at the `fs/open` request layer rather than in the higher-level streaming wrapper.

*Call graph*: calls 2 internal fn (exec_server, from_path); 6 external calls (new, bail!, assert_eq!, connect_websocket, new, write).


##### `connect_file_system`  (lines 381–384)

```
fn connect_file_system(websocket_url: &str) -> Result<Arc<dyn ExecutorFileSystem>>
```

**Purpose**: Builds a remote `ExecutorFileSystem` implementation connected to an already-running exec-server URL.

**Data flow**: Accepts a WebSocket URL string slice, creates an `Environment` configured for tests with that URL, and returns `environment.get_filesystem()` as `Arc<dyn ExecutorFileSystem>`.

**Call relations**: Used by the high-level streaming tests in this file to avoid repeating environment construction for each server instance.

*Call graph*: calls 1 internal fn (create_for_tests); called by 6 (completed_streams_release_handle_capacity, file_reads_reject_fifo_without_waiting_for_a_writer, file_reads_reject_named_pipes, stream_keeps_reading_the_open_file_after_path_replacement, stream_rejects_platform_sandbox, stream_stops_after_an_exact_block_boundary).


##### `read_only_sandbox`  (lines 386–396)

```
fn read_only_sandbox(path: std::path::PathBuf) -> FileSystemSandboxContext
```

**Purpose**: Constructs a `FileSystemSandboxContext` that grants read-only access to a single absolute root path.

**Data flow**: Accepts a `PathBuf`, converts it to `AbsolutePathBuf` with a panic on non-absolute input, builds a restricted `FileSystemSandboxPolicy` containing one `FileSystemSandboxEntry` with `FileSystemAccessMode::Read`, combines it with `NetworkSandboxPolicy::Restricted` into a runtime `PermissionProfile`, and converts that into `FileSystemSandboxContext`.

**Call relations**: Called only by `stream_rejects_platform_sandbox` to supply a concrete sandbox argument for the unsupported-operation check.

*Call graph*: calls 4 internal fn (from_permission_profile, from_runtime_permissions, restricted, from_absolute_path); called by 1 (stream_rejects_platform_sandbox); 1 external calls (vec!).


### `exec-server/tests/http_client.rs`

`test` · `client protocol and streaming-body routing validation during integration tests`

This file builds a miniature scripted websocket server around JSON-RPC so tests can drive the public `ExecServerClient::connect_websocket` path without depending on the real HTTP runner. Constants define the initialize and HTTP method names, a five-second timeout, and the expected body-delta channel capacities used in overflow tests. The core harness consists of `ScriptedExecServer`, which owns a websocket URL and spawned task, plus `JsonRpcPeer`, which reads and writes typed JSON-RPC messages over a `WebSocketStream<TcpStream>`.

`spawn_scripted_exec_server` binds an ephemeral TCP listener, accepts one websocket client, completes the initialize/initialized handshake through `JsonRpcPeer::complete_initialize`, and then hands control to a per-test async script. `JsonRpcPeer` provides typed helpers to read `http/request` calls, validate methods, send responses, send `http/request/bodyDelta` notifications, and decode request params from JSON.

The tests focus on client-side semantics rather than server execution: buffered requests forcibly clear `stream_response`; streaming requests replace caller-supplied `request_id`s with generated connection-local IDs (`http-1`, `http-2`, ...); ordered body deltas are delivered and concatenated correctly; dropping or cancelling a stream removes its route so stale deltas are ignored; transport disconnects wake body receivers with explicit errors; and bounded body-delta queues report truncation or disconnect as terminal errors rather than clean EOF. Timeouts wrap every externally visible await so failures surface as deterministic test errors instead of hangs.

#### Function details

##### `http_request_forces_buffered_request_params`  (lines 51–112)

```
async fn http_request_forces_buffered_request_params() -> Result<()>
```

**Purpose**: Verifies that the client's buffered HTTP helper always sends `stream_response: false` on the wire, even if the caller mistakenly sets streaming-only fields. It also confirms the caller still receives the buffered body in the response result.

**Data flow**: Spawns a scripted fake server that reads one `http/request`, asserts the received `HttpRequestParams` have `stream_response: false` and preserve the caller's other fields, then writes a `HttpRequestResponse` with body `buffered`. The test connects a real `ExecServerClient`, calls `http_request` with `stream_response: true`, waits under `timeout`, and asserts the returned response contains the buffered body bytes.

**Call relations**: The test uses `spawn_scripted_exec_server` to exercise the public websocket connection path and relies on the fake peer's request-reading and response-writing helpers to inspect the exact JSON-RPC payload emitted by the client.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 3 external calls (new, assert_eq!, timeout).


##### `http_response_body_stream_uses_generated_ids_and_receives_ordered_deltas`  (lines 118–274)

```
async fn http_response_body_stream_uses_generated_ids_and_receives_ordered_deltas() -> Result<()>
```

**Purpose**: Checks that streamed HTTP requests use client-generated route IDs on the wire, that body-delta notifications are routed by those generated IDs, and that the caller receives chunks in order across multiple streams.

**Data flow**: The scripted server reads a first `http/request`, asserts its params contain generated `request_id: "http-1"` and `stream_response: true`, sends response headers, then emits three ordered `HttpRequestBodyDeltaNotification`s for `http-1`. It then reads a second request and asserts the next generated ID is `http-2`. On the client side, the test calls `http_request_stream` twice with the same caller-supplied ID, drains the first returned body stream into a `Vec<u8>`, and asserts it equals `hello world!`; it then verifies the second request succeeds independently.

**Call relations**: This test is one of the main consumers of the scripted server harness. It demonstrates the intended call flow from `ExecServerClient::http_request_stream` through generated route allocation to body-delta delivery and cleanup after EOF.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 4 external calls (new, assert_eq!, timeout, vec!).


##### `http_response_body_stream_drops_queued_terminal_before_next_generated_id`  (lines 279–394)

```
async fn http_response_body_stream_drops_queued_terminal_before_next_generated_id() -> Result<()>
```

**Purpose**: Ensures that if EOF is queued before headers arrive and the caller drops the returned body stream without reading that terminal frame, the old route is still cleaned up and the next stream gets a fresh generated ID.

**Data flow**: The fake server sends a terminal body-delta notification for `http-1` before sending the header response, then later expects a second request using `http-2`. The client starts a stream, receives headers, drops the unread body receiver, then starts another stream and asserts the second response succeeds.

**Call relations**: This test targets a cleanup edge case in the client's route table. It depends on the scripted server to force the unusual ordering of terminal delta before response headers.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 3 external calls (new, assert_eq!, timeout).


##### `http_response_body_stream_ignores_late_deltas_after_cancelled_request`  (lines 399–524)

```
async fn http_response_body_stream_ignores_late_deltas_after_cancelled_request() -> Result<()>
```

**Purpose**: Verifies that aborting a pending `http_request_stream` future before headers arrive removes its route, so later body deltas for the cancelled generated ID are ignored and do not contaminate the next stream.

**Data flow**: A oneshot channel coordinates when the fake server has observed the first request. The test spawns a task that starts `http_request_stream` and then aborts that task before headers are returned. The server later accepts a second request with generated ID `http-2`, sends a stale delta for `http-1`, then sends headers and a terminal fresh delta for `http-2`. The test drains the second body stream and asserts it contains only `fresh`.

**Call relations**: This test combines `spawn_scripted_exec_server`, task cancellation, and the fake peer's body-delta writer to validate route cleanup when the request future itself is cancelled before completion.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 5 external calls (new, assert_eq!, channel, spawn, timeout).


##### `http_response_body_stream_ignores_late_deltas_after_drop`  (lines 529–676)

```
async fn http_response_body_stream_ignores_late_deltas_after_drop() -> Result<()>
```

**Purpose**: Checks that dropping a returned body stream before EOF removes its route, preventing stale nonterminal deltas for the old generated ID from reaching a later stream.

**Data flow**: The fake server serves one streaming request by returning only headers, waits on a oneshot until the test drops the body receiver, sends a stale delta for `http-1`, then serves a second request with generated ID `http-2` and a terminal `fresh` delta. The test drops the first body stream, signals the server, starts the second stream, drains it, and asserts the body is exactly `fresh`.

**Call relations**: This test covers a different cleanup path from cancellation: the request future completed successfully, but the caller discarded the body receiver early. The scripted server provides the stale-delta injection needed to prove isolation.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 4 external calls (new, assert_eq!, channel, timeout).


##### `http_response_body_stream_fails_when_transport_disconnects`  (lines 681–744)

```
async fn http_response_body_stream_fails_when_transport_disconnects() -> Result<()>
```

**Purpose**: Ensures an in-flight streamed body does not hang forever if the shared websocket transport disconnects before a terminal body frame arrives. Instead, the body receiver must wake with an explicit protocol error.

**Data flow**: The fake server reads one streaming request, sends only the header response, and then ends without sending EOF. The client starts `http_request_stream`, receives headers, then awaits `body_stream.recv()` under timeout and asserts it returns an error whose message begins with the expected disconnect text for route `http-1`.

**Call relations**: This test relies on the scripted server task ending to simulate transport loss after headers. It validates the client's disconnect propagation into active body streams.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 3 external calls (new, assert_eq!, timeout).


##### `http_response_body_stream_reports_disconnect_when_queue_is_full`  (lines 749–836)

```
async fn http_response_body_stream_reports_disconnect_when_queue_is_full() -> Result<()>
```

**Purpose**: Checks that a transport disconnect is still surfaced as a terminal stream error even when the body-delta queue was already filled to capacity before headers arrived.

**Data flow**: The fake server sends exactly `HTTP_BODY_DELTA_CHANNEL_CAPACITY` nonterminal deltas for `http-1`, then sends headers and disconnects without EOF. The client starts the stream, drains queued chunks counting them, and loops until `recv()` returns an error; it asserts the number of chunks equals the configured capacity and that the final error message reports transport disconnect rather than clean EOF.

**Call relations**: This test stresses the interaction between queued body data and disconnect handling. It uses the scripted server to prefill the route before the public body stream is returned.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 4 external calls (new, assert_eq!, bail!, timeout).


##### `http_response_body_stream_reports_backpressure_truncation`  (lines 841–936)

```
async fn http_response_body_stream_reports_backpressure_truncation() -> Result<()>
```

**Purpose**: Verifies that overflowing the bounded body-delta channel produces an explicit truncation error instead of letting the caller observe a misleading clean EOF after partial data.

**Data flow**: The fake server sends `OVERFLOWING_BODY_DELTA_FRAMES` nonterminal deltas for `http-1` before returning headers, then stays connected until the test finishes. The client starts the stream, drains available chunks while counting them, and expects `recv()` to eventually return an error with the exact backpressure-truncation message; it also asserts fewer chunks were delivered than the total sent, proving truncation occurred.

**Call relations**: This test isolates backpressure from disconnect by keeping the transport alive via a oneshot-controlled server task. It validates the client's bounded-route failure semantics under overload.

*Call graph*: calls 1 internal fn (spawn_scripted_exec_server); 5 external calls (new, assert_eq!, bail!, channel, timeout).


##### `ScriptedExecServer::connect_client`  (lines 950–957)

```
async fn connect_client(&self) -> Result<ExecServerClient>
```

**Purpose**: Connects a real `ExecServerClient` to the fake websocket server using the same public API production code uses for remote websocket connections.

**Data flow**: Reads `self.websocket_url`, constructs `RemoteExecServerConnectArgs` with that URL and the constant client name, awaits `ExecServerClient::connect_websocket`, and wraps any failure with context before returning the connected client.

**Call relations**: Tests call this after `spawn_scripted_exec_server` returns. It is the bridge from the fake server harness into the actual client implementation under test.

*Call graph*: 2 external calls (connect_websocket, new).


##### `ScriptedExecServer::finish`  (lines 960–965)

```
async fn finish(self) -> Result<()>
```

**Purpose**: Waits for the spawned fake server task to complete and propagates any script or join failure.

**Data flow**: Consumes `self`, awaits the stored `JoinHandle<Result<()>>`, adds join context, unwraps the nested `Result`, and returns `Ok(())` on success.

**Call relations**: Each test calls this during teardown after dropping the client, ensuring the scripted server completed the expected protocol exchange.


##### `spawn_scripted_exec_server`  (lines 969–993)

```
async fn spawn_scripted_exec_server(script: F) -> Result<ScriptedExecServer>
```

**Purpose**: Starts a one-client fake websocket exec-server, performs the initialize handshake, and then runs a caller-provided async script against a typed JSON-RPC peer.

**Data flow**: Binds a `TcpListener` on `127.0.0.1:0`, formats a `ws://` URL from its local address, and spawns a task that accepts one TCP connection under timeout, upgrades it with `accept_async`, wraps it in `JsonRpcPeer`, completes initialization, and then awaits the supplied script. It returns a `ScriptedExecServer` containing the URL and task handle.

**Call relations**: All top-level tests in this file use this harness to control exact server-side protocol behavior while still exercising the client's real websocket connection and handshake path.

*Call graph*: called by 8 (http_request_forces_buffered_request_params, http_response_body_stream_drops_queued_terminal_before_next_generated_id, http_response_body_stream_fails_when_transport_disconnects, http_response_body_stream_ignores_late_deltas_after_cancelled_request, http_response_body_stream_ignores_late_deltas_after_drop, http_response_body_stream_reports_backpressure_truncation, http_response_body_stream_reports_disconnect_when_queue_is_full, http_response_body_stream_uses_generated_ids_and_receives_ordered_deltas); 5 external calls (bind, format!, spawn, timeout, accept_async).


##### `JsonRpcPeer::complete_initialize`  (lines 1002–1021)

```
async fn complete_initialize(&mut self) -> Result<()>
```

**Purpose**: Consumes and validates the client's initialize handshake, then sends the expected initialize response and waits for the `initialized` notification.

**Data flow**: Reads a request with method `initialize`, decodes its params into `InitializeParams`, asserts they match the expected client name and `resume_session_id: None`, writes an `InitializeResponse { session_id: "session-1" }`, then reads a notification with method `initialized` and returns `Ok(())`.

**Call relations**: Called automatically by `spawn_scripted_exec_server` before each test script runs, so individual tests can focus on post-handshake traffic.

*Call graph*: calls 4 internal fn (read_notification, read_request, write_response, decode_request_params); 1 external calls (assert_eq!).


##### `JsonRpcPeer::read_http_request`  (lines 1024–1028)

```
async fn read_http_request(&mut self) -> Result<(RequestId, HttpRequestParams)>
```

**Purpose**: Reads one JSON-RPC `http/request` call from the websocket and decodes its typed parameters.

**Data flow**: Calls `read_request` expecting method `http/request`, decodes the request's params into `HttpRequestParams` with `decode_request_params`, and returns the pair `(request.id, params)`.

**Call relations**: Most scripted server closures use this helper as their first step when validating what the client sent on the wire.

*Call graph*: calls 2 internal fn (read_request, decode_request_params).


##### `JsonRpcPeer::read_request`  (lines 1031–1043)

```
async fn read_request(&mut self, expected_method: &str) -> Result<JSONRPCRequest>
```

**Purpose**: Reads the next JSON-RPC message and asserts it is a request with a specific method name.

**Data flow**: Awaits `read_message`, pattern-matches the result as `JSONRPCMessage::Request`, compares `request.method` to `expected_method`, and returns the `JSONRPCRequest` or an `anyhow` protocol error.

**Call relations**: Used by `complete_initialize` and `read_http_request` to enforce message type and method ordering in the fake server scripts.

*Call graph*: calls 1 internal fn (read_message); called by 2 (complete_initialize, read_http_request); 1 external calls (bail!).


##### `JsonRpcPeer::read_notification`  (lines 1046–1058)

```
async fn read_notification(&mut self, expected_method: &str) -> Result<JSONRPCNotification>
```

**Purpose**: Reads the next JSON-RPC message and asserts it is a notification with the expected method.

**Data flow**: Awaits `read_message`, pattern-matches `JSONRPCMessage::Notification`, compares the notification method to `expected_method`, and returns the `JSONRPCNotification` or an error.

**Call relations**: Only `complete_initialize` uses this helper to verify the client sends `initialized` after receiving the initialize response.

*Call graph*: calls 1 internal fn (read_message); called by 1 (complete_initialize); 1 external calls (bail!).


##### `JsonRpcPeer::write_response`  (lines 1061–1070)

```
async fn write_response(&mut self, id: RequestId, result: T) -> Result<()>
```

**Purpose**: Sends a successful JSON-RPC response with a typed result payload over the websocket.

**Data flow**: Accepts a `RequestId` and any `Serialize` result value, converts the result to `serde_json::Value`, wraps it in `JSONRPCMessage::Response(JSONRPCResponse { ... })`, and forwards it to `write_message`.

**Call relations**: Used by `complete_initialize` and many scripted test closures to answer client requests with typed protocol payloads.

*Call graph*: calls 1 internal fn (write_message); called by 1 (complete_initialize); 2 external calls (Response, to_value).


##### `JsonRpcPeer::write_body_delta`  (lines 1073–1079)

```
async fn write_body_delta(&mut self, delta: HttpRequestBodyDeltaNotification) -> Result<()>
```

**Purpose**: Sends one `http/request/bodyDelta` JSON-RPC notification carrying a streamed HTTP response chunk or terminal marker.

**Data flow**: Accepts a `HttpRequestBodyDeltaNotification`, serializes it to JSON, wraps it in a `JSONRPCNotification` with method `http/request/bodyDelta`, and writes it via `write_message`.

**Call relations**: Scripted tests use this helper to inject ordered, stale, terminal, overflowing, or disconnect-adjacent body frames into the client.

*Call graph*: calls 1 internal fn (write_message); 2 external calls (Notification, to_value).


##### `JsonRpcPeer::read_message`  (lines 1082–1094)

```
async fn read_message(&mut self) -> Result<JSONRPCMessage>
```

**Purpose**: Reads one websocket frame under timeout and decodes it into a `JSONRPCMessage`, rejecting unexpected websocket message types.

**Data flow**: Awaits `self.websocket.next()` under `TEST_TIMEOUT`, unwraps stream closure and tungstenite errors with context, then matches the resulting `Message`: text is parsed with `from_str`, binary with `from_slice`, close frames become an error, and any other frame type is rejected.

**Call relations**: This is the low-level receive primitive used by `read_request` and `read_notification` to implement typed protocol assertions.

*Call graph*: called by 2 (read_notification, read_request); 5 external calls (next, bail!, from_slice, from_str, timeout).


##### `JsonRpcPeer::write_message`  (lines 1097–1106)

```
async fn write_message(&mut self, message: JSONRPCMessage) -> Result<()>
```

**Purpose**: Serializes a JSON-RPC message and sends it as a websocket text frame under timeout.

**Data flow**: Takes a `JSONRPCMessage`, encodes it with `serde_json::to_string`, wraps it in `Message::Text`, sends it through the websocket with `SinkExt::send` under `TEST_TIMEOUT`, and returns any write error with context.

**Call relations**: This is the low-level send primitive behind `write_response` and `write_body_delta`.

*Call graph*: called by 2 (write_body_delta, write_response); 4 external calls (send, to_string, timeout, Text).


##### `decode_request_params`  (lines 1110–1119)

```
fn decode_request_params(request: &JSONRPCRequest) -> Result<T>
```

**Purpose**: Decodes the `params` field of a JSON-RPC request into a typed protocol struct and errors if params are missing or malformed.

**Data flow**: Clones `request.params`, requires it to be `Some`, deserializes the contained `serde_json::Value` into generic type `T: DeserializeOwned`, and returns the typed value.

**Call relations**: Used by `complete_initialize` and `read_http_request` so the fake server can validate typed request payloads rather than raw JSON.

*Call graph*: called by 2 (complete_initialize, read_http_request); 1 external calls (from_value).


### `exec-server/tests/http_request.rs`

`test` · `real exec-server HTTP runner validation during integration tests`

This Unix-only file tests the real exec-server websocket API by pairing the common websocket harness with a tiny raw TCP HTTP/1.1 server implemented directly in the test. `CapturedHttpRequest` stores the accepted `TcpStream`, request line, lowercased headers, and body bytes so assertions can inspect exactly what exec-server emitted on the wire. The helper `initialize_exec_server` performs the required JSON-RPC initialize/initialized handshake before any executor methods are used.

The tests cover four major behaviors. Buffered requests send a normal HTTP request and return the full response body in the JSON-RPC result. Streamed requests return headers first in the JSON-RPC response and then emit ordered `http/request/bodyDelta` notifications carrying chunked response bytes and a terminal frame. Duplicate `requestId`s for concurrent streamed responses are rejected with JSON-RPC error `-32602` until the first stream finishes. Optional timeout handling is also verified: `timeoutMs: None` allows a delayed response to succeed, while a short explicit timeout yields a server error and may cause the peer-side TCP write to fail with an expected disconnect.

Supporting helpers wait for typed JSON-RPC responses or errors by request ID, parse one incoming HTTP request from a `TcpListener`, write fixed-length or chunked HTTP responses, keep a chunked response open until signaled, collect body-delta notifications until `done`, and perform case-insensitive response-header lookup. Together they make the tests concrete about protocol ordering, body framing, and error semantics.

#### Function details

##### `exec_server_http_request_buffers_response_body`  (lines 46–109)

```
async fn exec_server_http_request_buffers_response_body() -> anyhow::Result<()>
```

**Purpose**: Verifies that a real websocket `http/request` performs an HTTP request through exec-server and returns the complete response body in the JSON-RPC response payload.

**Data flow**: Starts an exec-server harness, completes initialization, binds a local TCP listener, sends a JSON-RPC `http/request` with POST method, custom header, body, timeout, and `stream_response: false`, then accepts the resulting HTTP request from the listener and asserts its request line, header, and body. It writes back a fixed-length `201 Created` response and waits for a typed `HttpRequestResponse`, asserting status, response header, and buffered body bytes before shutdown.

**Call relations**: This test drives the full stack: websocket JSON-RPC into exec-server, outbound HTTP from exec-server to the local TCP peer, then JSON-RPC response back to the harness. It relies on `initialize_exec_server`, `accept_http_request`, `respond_with_status_and_headers`, and `wait_for_response`.

*Call graph*: calls 5 internal fn (exec_server, accept_http_request, initialize_exec_server, respond_with_status_and_headers, wait_for_response); 5 external calls (bind, assert_eq!, format!, to_value, vec!).


##### `exec_server_http_request_streams_response_body_notifications`  (lines 115–198)

```
async fn exec_server_http_request_streams_response_body_notifications() -> anyhow::Result<()>
```

**Purpose**: Checks that when `stream_response` is requested, exec-server returns headers immediately in the JSON-RPC response and streams the HTTP body as ordered `http/request/bodyDelta` notifications.

**Data flow**: Starts and initializes exec-server, binds a local listener, sends a streamed GET `http/request`, accepts and validates the outbound HTTP request, then responds with chunked transfer encoding containing `hello ` and `world`. The test reads the first websocket event and asserts it is the `http/request` response with status and headers but an empty body, then collects subsequent body-delta notifications, extracting sequence numbers, concatenated bytes, and terminal status for assertion.

**Call relations**: This test depends on `respond_with_chunked_body` to force the streaming path and on `collect_response_body_deltas` to consume notifications until the terminal frame.

*Call graph*: calls 5 internal fn (exec_server, accept_http_request, collect_response_body_deltas, initialize_exec_server, respond_with_chunked_body); 7 external calls (bind, bail!, assert_eq!, format!, from_value, to_value, vec!).


##### `exec_server_http_request_rejects_duplicate_stream_request_ids`  (lines 203–275)

```
async fn exec_server_http_request_rejects_duplicate_stream_request_ids() -> anyhow::Result<()>
```

**Purpose**: Ensures exec-server reserves a streamed `requestId` until that body stream finishes, rejecting a second in-flight streamed request that tries to reuse the same ID.

**Data flow**: Starts and initializes exec-server, binds a listener, sends a first streamed GET with `request_id: "stream-dup"`, accepts the HTTP request, and spawns a task that writes a chunked response but waits on a oneshot before sending EOF. After receiving the first `HttpRequestResponse`, the test sends a second streamed request with the same `request_id`, waits for a matching JSON-RPC error event, and asserts code `-32602` and the duplicate-ID message. It then signals the first response to finish, awaits the response task, drains the remaining body deltas, and shuts down.

**Call relations**: This test combines the real server harness with `respond_with_chunked_body_until_finish` to keep the first stream active long enough to probe duplicate-ID rejection.

*Call graph*: calls 6 internal fn (exec_server, accept_http_request, collect_response_body_deltas, initialize_exec_server, respond_with_chunked_body_until_finish, wait_for_response); 8 external calls (bind, new, bail!, assert_eq!, format!, channel, to_value, spawn).


##### `exec_server_http_request_honors_optional_timeout`  (lines 280–349)

```
async fn exec_server_http_request_honors_optional_timeout() -> anyhow::Result<()>
```

**Purpose**: Verifies that omitting `timeoutMs` leaves the HTTP request effectively unbounded, while a short explicit timeout causes the same delayed response pattern to fail.

**Data flow**: Starts and initializes exec-server, binds a listener, sends a first buffered GET with `timeout_ms: None`, accepts the HTTP request, spawns a delayed fixed-length response after 100 ms, and waits for a successful `HttpRequestResponse` containing `slow-success`. It then repeats with `timeout_ms: Some(10)`, accepts the second HTTP request, spawns another delayed response, waits for a JSON-RPC error, asserts code `-32603` and an `http/request failed:` prefix, and tolerates expected peer disconnect errors from the delayed responder.

**Call relations**: This test uses both `wait_for_response` and `wait_for_error_response`, plus `is_expected_peer_disconnect`, to validate success and timeout-failure paths against the same local HTTP peer behavior.

*Call graph*: calls 7 internal fn (exec_server, accept_http_request, initialize_exec_server, is_expected_peer_disconnect, respond_with_status_and_headers, wait_for_error_response, wait_for_response); 9 external calls (from_millis, bind, new, assert!, assert_eq!, format!, to_value, spawn, sleep).


##### `initialize_exec_server`  (lines 352–367)

```
async fn initialize_exec_server(server: &mut ExecServerHarness) -> anyhow::Result<()>
```

**Purpose**: Performs the JSON-RPC initialize handshake required before invoking exec-server methods in these tests.

**Data flow**: Sends an `initialize` request with `InitializeParams { client_name: "exec-server-http-test", resume_session_id: None }`, waits for a typed response using `wait_for_response`, then sends an `initialized` notification with an empty JSON object and returns `Ok(())`.

**Call relations**: All top-level tests in this file call this helper immediately after starting the harness so later requests run against a fully initialized session.

*Call graph*: calls 3 internal fn (send_notification, send_request, wait_for_response); called by 4 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout, exec_server_http_request_rejects_duplicate_stream_request_ids, exec_server_http_request_streams_response_body_notifications); 2 external calls (json!, to_value).


##### `wait_for_response`  (lines 370–389)

```
async fn wait_for_response(
    server: &mut ExecServerHarness,
    request_id: RequestId,
) -> anyhow::Result<T>
```

**Purpose**: Waits for a JSON-RPC response event with a specific request ID and deserializes its `result` into a caller-specified type.

**Data flow**: Takes a mutable `ExecServerHarness` and `RequestId`, waits until `wait_for_event` yields a `JSONRPCMessage::Response` whose `id` matches, pattern-matches the event again to extract `result`, deserializes it with `serde_json::from_value`, and returns the typed value.

**Call relations**: Used by the initialize helper and several tests to turn raw websocket events into typed protocol responses keyed by request ID.

*Call graph*: calls 1 internal fn (wait_for_event); called by 4 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout, exec_server_http_request_rejects_duplicate_stream_request_ids, initialize_exec_server); 2 external calls (bail!, from_value).


##### `wait_for_error_response`  (lines 392–408)

```
async fn wait_for_error_response(
    server: &mut ExecServerHarness,
    request_id: RequestId,
) -> anyhow::Result<codex_app_server_protocol::JSONRPCErrorError>
```

**Purpose**: Waits for a JSON-RPC error event with a specific request ID and returns the embedded protocol error object.

**Data flow**: Accepts a mutable `ExecServerHarness` and `RequestId`, waits until `wait_for_event` yields a matching `JSONRPCMessage::Error`, extracts the `error` field, and returns it.

**Call relations**: Only the timeout test uses this helper to validate the server-side error response for a timed-out HTTP request.

*Call graph*: calls 1 internal fn (wait_for_event); called by 1 (exec_server_http_request_honors_optional_timeout); 1 external calls (bail!).


##### `accept_http_request`  (lines 411–446)

```
async fn accept_http_request(listener: &TcpListener) -> anyhow::Result<CapturedHttpRequest>
```

**Purpose**: Accepts one inbound HTTP/1.1 request from the local TCP listener and captures its request line, headers, body, and underlying stream for later response writing.

**Data flow**: Awaits `listener.accept()` under a five-second timeout, wraps the `TcpStream` in `BufReader`, reads the request line and strips trailing CRLF, then reads header lines until the blank line, lowercasing header names into a `BTreeMap`. It parses `content-length`, reads exactly that many body bytes, unwraps the stream from the reader, and returns a `CapturedHttpRequest` struct.

**Call relations**: All HTTP-request tests use this helper to inspect the exact outbound HTTP request generated by exec-server before sending a response back on the same stream.

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

**Purpose**: Writes a simple fixed-length HTTP/1.1 response with caller-specified status, extra headers, and body bytes to the captured request stream.

**Data flow**: Takes ownership of a `TcpStream`, a status string, a slice of header pairs, and a body slice; formats the response head including `content-type`, `content-length`, `connection: close`, and any extra headers; writes the head and body bytes; flushes the stream; and returns `Ok(())`.

**Call relations**: Used by the buffered-response and timeout tests to emulate a straightforward HTTP peer response.

*Call graph*: called by 2 (exec_server_http_request_buffers_response_body, exec_server_http_request_honors_optional_timeout); 3 external calls (flush, write_all, format!).


##### `is_expected_peer_disconnect`  (lines 469–480)

```
fn is_expected_peer_disconnect(err: &anyhow::Error) -> bool
```

**Purpose**: Classifies delayed-response write failures that are acceptable after exec-server has already timed out and closed the peer connection.

**Data flow**: Traverses the `anyhow::Error` chain, looks for an embedded `std::io::Error`, and returns `true` if its kind is `BrokenPipe`, `ConnectionReset`, or `UnexpectedEof`; otherwise returns `false`.

**Call relations**: The optional-timeout test uses this helper when awaiting the delayed responder task, because the server may have closed the socket before the peer finishes writing.

*Call graph*: called by 1 (exec_server_http_request_honors_optional_timeout); 1 external calls (chain).


##### `respond_with_chunked_body`  (lines 483–507)

```
async fn respond_with_chunked_body(
    mut stream: TcpStream,
    headers: &[(&str, &str)],
    chunks: &[&[u8]],
) -> anyhow::Result<()>
```

**Purpose**: Writes a chunked-transfer HTTP response so exec-server must consume the body incrementally and exercise its streaming path.

**Data flow**: Accepts a `TcpStream`, extra headers, and a slice of body chunks; formats an HTTP/1.1 response head with `transfer-encoding: chunked`, writes it, then for each chunk writes the hex length line, chunk bytes, trailing CRLF, and flushes. Finally it writes the terminating `0\r\n\r\n`, flushes, and returns.

**Call relations**: The streaming-body-notifications test uses this helper to force exec-server to emit body-delta notifications rather than buffering a fixed-length body.

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

**Purpose**: Writes an initial chunked HTTP response and keeps the stream open until the test signals completion, allowing a streamed response to remain active across additional assertions.

**Data flow**: Writes the same chunked response head and initial chunks as `respond_with_chunked_body`, then awaits a `oneshot::Receiver<()>` before sending the terminating zero-length chunk and flushing.

**Call relations**: The duplicate-stream-request-id test uses this helper to keep the first streamed response alive so the server still considers its `requestId` active when the duplicate request arrives.

*Call graph*: called by 1 (exec_server_http_request_rejects_duplicate_stream_request_ids); 3 external calls (flush, write_all, format!).


##### `collect_response_body_deltas`  (lines 539–560)

```
async fn collect_response_body_deltas(
    server: &mut ExecServerHarness,
    request_id: &str,
) -> anyhow::Result<Vec<HttpRequestBodyDeltaNotification>>
```

**Purpose**: Consumes websocket events from the exec-server harness until it has collected all `http/request/bodyDelta` notifications for a given request ID through the terminal frame.

**Data flow**: Loops on `server.next_event()`, requires each event to be a `JSONRPCMessage::Notification` with method `http/request/bodyDelta`, deserializes the params into `HttpRequestBodyDeltaNotification`, asserts the `request_id` matches the expected string, pushes each delta into a vector, and returns the vector once a delta with `done == true` is seen.

**Call relations**: Used by the streaming and duplicate-ID tests to validate notification ordering, payload bytes, and terminal semantics after the initial `http/request` response.

*Call graph*: calls 1 internal fn (next_event); called by 2 (exec_server_http_request_rejects_duplicate_stream_request_ids, exec_server_http_request_streams_response_body_notifications); 4 external calls (new, bail!, assert_eq!, from_value).


##### `response_header`  (lines 563–568)

```
fn response_header(headers: &[HttpHeader], name: &str) -> Option<String>
```

**Purpose**: Looks up a response header value case-insensitively from a slice of `HttpHeader` structs.

**Data flow**: Iterates over `headers`, finds the first entry whose `name` equals the requested header name ignoring ASCII case, clones its `value`, and returns `Option<String>`.

**Call relations**: The buffered and streaming tests use this helper when asserting response headers without depending on exact casing chosen by the HTTP stack.

*Call graph*: 1 external calls (iter).


### Noise relay and remote transport
These tests move from low-level Noise framing and relay mechanics up through remote environment reconnect logic and full relayed exec-server traffic.

### `exec-server/src/noise_channel_tests.rs`

`test` · `test`

This test module validates the end-to-end behavior of the hybrid Noise channel defined in `noise_channel.rs`. The main round-trip test generates independent initiator and responder identities, derives a transcript-binding prologue, runs the two-message hybrid IK handshake, verifies that the responder recovers the initiator’s authenticated public key and payload, and then confirms bidirectional transport encryption/decryption works and does not leave plaintext unchanged.

The remaining tests target failure modes and invariants. They verify that the initiator rejects a responder using the wrong static key, that the responder rejects a mismatched prologue, and that the prologue byte encoding is stable and unambiguous via an exact byte-for-byte assertion. Transport integrity is checked by tampering with ciphertext and by replaying the same ciphertext twice, expecting the second decrypt to fail as a transport error because implicit nonces have advanced. Public-key serialization tests ensure the `suite` field is emitted as `NOISE_CHANNEL_SUITE` and that an unknown suite is rejected even if the key material shape is otherwise valid. Finally, an oversized initiator payload is rejected before handshake emission, proving the module enforces `MAX_MESSAGE_LEN` constraints up front.

#### Function details

##### `hybrid_ik_roundtrip_authenticates_both_endpoints`  (lines 13–64)

```
fn hybrid_ik_roundtrip_authenticates_both_endpoints()
```

**Purpose**: Verifies a full initiator/responder handshake and subsequent bidirectional encrypted transport. It proves both endpoint authentication and successful message exchange.

**Data flow**: It generates initiator and responder identities, builds a prologue, starts the initiator handshake with an authorization payload, parses the request on the responder, asserts the recovered initiator public key and payload match expectations, completes the responder handshake, finishes the initiator handshake, encrypts and decrypts a request and response in opposite directions, and asserts ciphertext differs from plaintext while decrypted bytes match the originals.

**Call relations**: This is the broadest integration test in the module, exercising `NoiseChannelIdentity`, `noise_channel_prologue`, `InitiatorHandshake`, `PendingResponderHandshake`, and `NoiseTransport` together.

*Call graph*: calls 3 internal fn (start, generate, read_request); 3 external calls (assert_eq!, assert_ne!, noise_channel_prologue).


##### `initiator_rejects_wrong_responder_key`  (lines 67–84)

```
fn initiator_rejects_wrong_responder_key()
```

**Purpose**: Checks that a handshake request pinned to one responder key cannot be accepted by a different responder identity. It validates responder key pinning on the initiator side.

**Data flow**: It generates initiator, expected responder, and actual responder identities, builds a prologue, starts a handshake using the expected responder’s public key, then asserts that `PendingResponderHandshake::read_request` with the actual responder identity returns an error.

**Call relations**: This test specifically targets the responder-key pinning established in `InitiatorHandshake::start`.

*Call graph*: calls 2 internal fn (start, generate); 2 external calls (assert!, noise_channel_prologue).


##### `responder_rejects_mismatched_prologue`  (lines 87–103)

```
fn responder_rejects_mismatched_prologue()
```

**Purpose**: Verifies that the responder rejects a handshake when it uses a different transcript-binding prologue than the initiator. It protects against replay or splicing across streams or registrations.

**Data flow**: It generates initiator and responder identities, builds two different prologues differing only in stream ID, starts the initiator handshake with one prologue, and asserts that `PendingResponderHandshake::read_request` with the other prologue fails.

**Call relations**: This test exercises the prologue-binding behavior shared by `InitiatorHandshake::start` and `PendingResponderHandshake::read_request`.

*Call graph*: calls 2 internal fn (start, generate); 2 external calls (assert!, noise_channel_prologue).


##### `prologue_encoding_is_stable_and_unambiguous`  (lines 106–117)

```
fn prologue_encoding_is_stable_and_unambiguous()
```

**Purpose**: Asserts the exact byte encoding of the Noise prologue. It documents the length-prefixed format and guards against accidental encoding changes.

**Data flow**: It calls `noise_channel_prologue("env-1", "registration-1", "stream-1")` and compares the returned bytes to a hard-coded expected vector containing the domain and three identifiers with 8-byte big-endian length prefixes.

**Call relations**: This test directly covers `noise_channel_prologue` and, indirectly, `append_prologue_part`.

*Call graph*: 2 external calls (assert_eq!, noise_channel_prologue).


##### `transport_rejects_tampered_ciphertext`  (lines 120–146)

```
fn transport_rejects_tampered_ciphertext()
```

**Purpose**: Verifies that modifying ciphertext causes decryption failure. It checks authenticated encryption integrity after a successful handshake.

**Data flow**: It performs a full handshake, encrypts a request with the initiator transport, flips one bit in the ciphertext, and asserts that the responder transport fails to decrypt it.

**Call relations**: This test focuses on `NoiseTransport::encrypt` and `NoiseTransport::decrypt` after valid handshake setup.

*Call graph*: calls 3 internal fn (start, generate, read_request); 2 external calls (assert!, noise_channel_prologue).


##### `transport_rejects_replayed_ciphertext`  (lines 149–183)

```
fn transport_rejects_replayed_ciphertext()
```

**Purpose**: Verifies that replaying the same ciphertext fails on the second decrypt because transport nonces are implicit and single-use. It checks replay resistance at the transport-state level.

**Data flow**: It performs a full handshake, encrypts one request, decrypts it successfully once on the responder, then decrypts the same ciphertext again and asserts the second result is `Err(NoiseChannelError::Transport(_))`.

**Call relations**: This test exercises the nonce-advancing behavior of `NoiseTransport::decrypt` and the underlying Clatter transport state.

*Call graph*: calls 3 internal fn (start, generate, read_request); 3 external calls (assert!, assert_eq!, noise_channel_prologue).


##### `public_key_validation_rejects_unknown_suite`  (lines 186–198)

```
fn public_key_validation_rejects_unknown_suite()
```

**Purpose**: Checks that a public key with the wrong `suite` tag is rejected even if its serialized key material came from a valid identity. It protects protocol separation by suite name.

**Data flow**: It generates an identity, serializes its public key to JSON, mutates the `suite` field to `"unknown"`, deserializes back into `NoiseChannelPublicKey`, generates an initiator identity, and asserts `InitiatorHandshake::start` with that key fails.

**Call relations**: This test targets `NoiseChannelPublicKey::decode`, which is invoked by `InitiatorHandshake::start`.

*Call graph*: calls 1 internal fn (generate); 5 external calls (assert!, Object, from_value, json!, to_value).


##### `public_key_serializes_with_expected_suite`  (lines 201–209)

```
fn public_key_serializes_with_expected_suite()
```

**Purpose**: Verifies that exported public keys include the exact supported suite string. It guards the registry-facing serialization contract.

**Data flow**: It generates an identity, converts its public key to JSON with `serde_json::to_value`, and asserts `json["suite"] == NOISE_CHANNEL_SUITE`.

**Call relations**: This test covers `NoiseChannelIdentity::public_key` serialization behavior.

*Call graph*: calls 1 internal fn (generate); 2 external calls (assert_eq!, to_value).


##### `initiator_rejects_oversized_handshake_payload`  (lines 212–226)

```
fn initiator_rejects_oversized_handshake_payload()
```

**Purpose**: Verifies that the initiator refuses to emit a first handshake message when the payload would exceed the Noise maximum message size. It protects the preflight size check in handshake startup.

**Data flow**: It generates initiator and responder identities, creates a payload of length `MAX_MESSAGE_LEN`, calls `InitiatorHandshake::start`, and asserts the result is `Err(NoiseChannelError::InvalidMessage("handshake payload is too large"))`.

**Call relations**: This test directly exercises the payload-size validation branch in `InitiatorHandshake::start`.

*Call graph*: calls 2 internal fn (start, generate); 2 external calls (assert!, vec!).


### `exec-server/src/noise_relay/message_framing_tests.rs`

`test` · `test`

This test file validates the framing rules implemented in `message_framing.rs` using concrete protocol objects and exact error matching. The first test constructs a `JSONRPCMessage::Notification` whose JSON body contains a 128 KiB string, ensuring the serialized frame is larger than a single Noise plaintext record. It then slices the framed bytes into `NOISE_RECORD_PLAINTEXT_LEN` chunks, feeds them sequentially into a fresh `JsonRpcMessageDecoder`, and confirms the decoder emits exactly the original message once all fragments arrive.

The remaining tests target the decoder’s guardrails. One sends only a 4-byte length prefix declaring a payload larger than `MAX_NOISE_JSONRPC_MESSAGE_LEN`; this confirms the decoder rejects the authenticated length immediately, without waiting for any payload bytes. Another sends a single plaintext record one byte larger than `NOISE_RECORD_PLAINTEXT_LEN`, verifying that oversized decrypted records are rejected before any buffering or parsing occurs. Together these tests document the intended invariants: large valid messages may span records, but both per-record size and declared message size remain strictly bounded.

#### Function details

##### `fragments_and_reassembles_large_jsonrpc_message`  (lines 12–29)

```
fn fragments_and_reassembles_large_jsonrpc_message()
```

**Purpose**: Verifies that a JSON-RPC message much larger than one Noise plaintext record can be framed once, split into record-sized chunks, and reconstructed exactly by the incremental decoder. It proves the framing layer preserves message boundaries across fragmentation.

**Data flow**: The test builds a `JSONRPCMessage::Notification` with a large JSON payload, passes it to `frame_jsonrpc_message`, and asserts the resulting framed byte vector exceeds 128 KiB. It then creates a default `JsonRpcMessageDecoder`, iterates over `framed.chunks(NOISE_RECORD_PLAINTEXT_LEN)`, extends an output vector with each `push` result, and finally compares the decoded messages to a one-element vector containing the original message.

**Call relations**: This test directly drives both framing and decoding as an end-to-end round trip. It does not delegate beyond the production helpers under test and serves as the main proof that sender-side framing and receiver-side reassembly are compatible.

*Call graph*: 7 external calls (new, Notification, assert!, assert_eq!, default, json!, frame_jsonrpc_message).


##### `rejects_declared_message_length_above_limit_without_payload`  (lines 32–41)

```
fn rejects_declared_message_length_above_limit_without_payload()
```

**Purpose**: Checks that the decoder rejects an authenticated length prefix above the configured maximum even when no payload bytes have arrived yet. This captures the intended fail-fast behavior for malicious or invalid peers.

**Data flow**: The test creates a default decoder, computes a 4-byte big-endian length equal to `MAX_NOISE_JSONRPC_MESSAGE_LEN + 1`, and passes only those bytes to `decoder.push`. It asserts that the result is `Err(ExecServerError::Protocol(...))` with the exact invalid-length message string.

**Call relations**: This test isolates the prefix-validation branch inside `JsonRpcMessageDecoder::push`. It demonstrates that receive-side code need not accumulate payload bytes before discovering an impossible declared message size.

*Call graph*: 2 external calls (assert!, default).


##### `rejects_oversized_plaintext_record`  (lines 44–52)

```
fn rejects_oversized_plaintext_record()
```

**Purpose**: Confirms that a single decrypted Noise plaintext record larger than the configured record limit is rejected immediately. This protects the decoder from accepting transport inputs outside the relay contract.

**Data flow**: The test creates a default decoder and constructs a vector of zero bytes with length `NOISE_RECORD_PLAINTEXT_LEN + 1`. It passes that slice to `decoder.push` and asserts the returned error is `ExecServerError::Protocol` with the exact oversized-record message.

**Call relations**: This test targets the earliest validation branch in `JsonRpcMessageDecoder::push`, before any buffering or JSON parsing. It documents the contract expected from the upstream decryption/record transport layer.

*Call graph*: 2 external calls (assert!, default).


### `exec-server/src/noise_relay/ordered_ciphertext_tests.rs`

`test` · `test`

This test file documents the intended semantics of `OrderedCiphertextFrames` with small, concrete sequences. The first test demonstrates the core behavior: pushing sequence 1 before sequence 0 yields no output because a gap remains, but once sequence 0 arrives the buffer releases both payloads in nonce order. That confirms the structure does not emit future ciphertext early.

The second test focuses on duplicate handling. It buffers a payload for sequence 1, then sends another payload with the same sequence and verifies the second copy is ignored rather than replacing the first. After sequence 0 arrives, the released run contains the original buffered payload. It also confirms that duplicates for already-released sequence numbers are ignored as well.

The final test exercises both resource bounds. A sequence gap of 65 from an initial `next_seq` of 0 exceeds `MAX_REORDER_DISTANCE` and must error. Separately, buffering a single future payload larger than `MAX_PENDING_BYTES` also errors. Together these tests show that the reordering layer is intentionally conservative: it preserves order, never rewrites buffered data, and refuses to accumulate unbounded out-of-order ciphertext.

#### Function details

##### `releases_ciphertexts_only_in_nonce_order`  (lines 7–18)

```
fn releases_ciphertexts_only_in_nonce_order()
```

**Purpose**: Verifies that out-of-order ciphertext is withheld until the missing earlier sequence arrives, after which the contiguous run is released in order. This is the fundamental correctness property required by Noise nonce handling.

**Data flow**: The test creates a default `OrderedCiphertextFrames`, pushes sequence 1 with payload `second` and asserts an empty result, then pushes sequence 0 with payload `first` and asserts the returned vector contains `first` followed by `second`.

**Call relations**: This test directly exercises the normal buffering and drain path of `OrderedCiphertextFrames::push`. It demonstrates the transition from a pending-gap state to a contiguous-release state.

*Call graph*: 2 external calls (assert_eq!, default).


##### `ignores_duplicate_ciphertexts_without_replacing_buffered_record`  (lines 21–40)

```
fn ignores_duplicate_ciphertexts_without_replacing_buffered_record()
```

**Purpose**: Checks that duplicate sequence numbers are ignored both before and after release, and that an already-buffered payload is not replaced by a later duplicate. This preserves first-seen ciphertext for each sequence.

**Data flow**: The test creates a default frame buffer, pushes sequence 1 with `first copy`, then pushes sequence 1 again with `replacement`, asserting both calls return empty. It then pushes sequence 0 with `zero` and asserts the release contains `zero` and the original `first copy`, and finally pushes duplicate sequence 0 with `duplicate`, asserting another empty result.

**Call relations**: This test targets the duplicate-detection branches in `OrderedCiphertextFrames::push` for both pending and already-consumed sequences. It confirms the implementation’s first-write-wins policy.

*Call graph*: 2 external calls (assert_eq!, default).


##### `rejects_unbounded_reordering`  (lines 43–52)

```
fn rejects_unbounded_reordering()
```

**Purpose**: Ensures the reordering buffer enforces both its maximum sequence-gap window and its maximum buffered-byte budget. These checks prevent a peer from forcing unbounded memory growth.

**Data flow**: The test creates a default frame buffer, calls `push(65, Vec::new())` and asserts it errors because the gap from expected sequence 0 exceeds the allowed window, then calls `push(1, vec![0; MAX_PENDING_BYTES + 1])` and asserts that oversized pending buffering also errors.

**Call relations**: This test exercises the two protocol-error branches in `OrderedCiphertextFrames::push` that guard resource usage. It documents the exact thresholds expected by upstream receive logic.

*Call graph*: 2 external calls (assert!, default).


### `exec-server/src/noise_relay/executor_stream_tests.rs`

`test` · `test`

This test builds a complete executor-side virtual stream from scratch and checks one subtle lifecycle guarantee: when the `ConnectionProcessor` exits, the stream reports `ClosedNoiseVirtualStream` with the original `stream_id` and `instance_id`. To do that, it first generates executor and harness Noise identities, performs the full initiator/responder handshake using a fixed test prologue, and obtains paired `NoiseTransport` instances. It then creates a physical outgoing channel and a one-slot closed-stream notification channel, constructs a real `ConnectionProcessor` using `ExecServerRuntimePaths::new(current_exe, None)`, and calls `spawn_noise_virtual_stream` with `instance_id` 7.

To drive the processor, the test frames a JSON-RPC response message, encrypts it with the harness transport, wraps it in a single-segment `RelayData` frame with sequence 0, and feeds it into `stream.receive_data(...)`. The assertion waits up to one second for `closed_stream_rx.recv()` and matches the resulting `ClosedNoiseVirtualStream`, ensuring the closure report corresponds to `stream-1` and instance 7. This protects the stream-ID reuse design in `executor_stream.rs`: delayed closure notifications must identify the exact stream instance, not just the routing ID.

#### Function details

##### `processor_exit_reports_closed_virtual_stream`  (lines 22–70)

```
async fn processor_exit_reports_closed_virtual_stream() -> Result<()>
```

**Purpose**: Verifies that an executor-side virtual stream reports `ClosedNoiseVirtualStream` when its `ConnectionProcessor` exits, preserving the correct `stream_id` and `instance_id`. It is a regression test for safe stream-ID reuse.

**Data flow**: It generates executor and harness identities, performs a full Noise handshake to obtain executor and harness transports, creates physical and closed-stream channels, spawns a virtual stream with `instance_id` 7 and a real `ConnectionProcessor`, frames and encrypts a JSON-RPC response, injects it as `RelayData { seq: 0, segment_index: 0, segment_count: 1, payload }` via `receive_data`, then waits with `timeout` for a `ClosedNoiseVirtualStream` matching `stream-1` and instance 7.

**Call relations**: This test exercises `InitiatorHandshake`, `PendingResponderHandshake`, `spawn_noise_virtual_stream`, `frame_jsonrpc_message`, and the processor task’s closure-reporting path together.

*Call graph*: calls 6 internal fn (start, generate, read_request, frame_jsonrpc_message, new, new); 6 external calls (Response, Integer, assert!, channel, current_exe, spawn_noise_virtual_stream).


### `exec-server/src/relay_noise_tests.rs`

`test` · `test`

This file is a dedicated test module for the Noise-specific branches of `run_multiplexed_environment`. It defines `BlockingValidator`, a `HarnessKeyValidator` implementation that increments an atomic call counter and then waits on a `Notify`, allowing tests to hold authorization checks open and observe how the relay behaves while validations are in flight.

Each test spins up a real localhost websocket pair using `TcpListener`, upgrades the server side with `accept_async`, and runs `run_multiplexed_environment` in a task with generated executor and harness `NoiseChannelIdentity` values. Handshake requests are produced with `InitiatorHandshake::start` using the same `noise_channel_prologue` inputs the server expects, then wrapped in `RelayMessageFrame::handshake` and sent as binary websocket frames.

The scenarios are intentionally adversarial. One test proves that multiple pending validations can coexist and do not serialize the relay loop. Another repeatedly reuses the same `stream_id` to show duplicate handshakes trigger resets and eventually consume the fixed failure budget. A separate test confirms oversized authorization payloads are rejected before the validator is ever called. Two final tests show that repeated malformed handshake ciphertexts and repeated early data sent during validation both close the physical relay after the configured number of failures. Together these tests document subtle invariants: authorization checks are asynchronous and stale-safe, but malformed or abusive authenticated-channel setup attempts are connection-wide budgeted.

#### Function details

##### `BlockingValidator::validate_harness_key`  (lines 43–55)

```
fn validate_harness_key(
        &self,
        _harness_public_key: &NoiseChannelPublicKey,
        _authorization: &str,
    ) -> impl std::future::Future<Output = Result<(), ExecServerError>> + Sen
```

**Purpose**: Implements a controllably blocking harness-key validator for tests. It records each validation attempt and then waits until the test explicitly releases it.

**Data flow**: It takes a harness public key and authorization string but ignores their contents, clones the shared `calls` counter and `release` notifier into the returned async block, increments `calls` with `fetch_add`, awaits `release.notified()`, and finally returns `Ok(())`.

**Call relations**: This validator is passed into `run_multiplexed_environment` by all tests in the file. Its delayed completion lets tests observe pending-validation behavior, duplicate-handshake handling, and failure-budget accounting while authorization is still outstanding.

*Call graph*: 1 external calls (clone).


##### `pending_harness_key_validation_does_not_block_new_handshakes`  (lines 59–109)

```
async fn pending_harness_key_validation_does_not_block_new_handshakes() -> Result<()>
```

**Purpose**: Verifies that the relay can accept and start validating multiple handshake streams concurrently instead of blocking on the first registry-style authorization check.

**Data flow**: The test creates a websocket connection pair, generates environment and harness Noise identities, starts `run_multiplexed_environment` with a `BlockingValidator`, then sends two valid handshake frames for distinct stream ids. It waits until the validator call counter reaches `2`, proving both validations were launched, then closes the harness websocket and waits for the environment task to exit.

**Call relations**: It exercises the `validation_tasks.spawn(...)` path in `run_multiplexed_environment` and confirms the main relay loop keeps processing new handshake frames while earlier validations remain unresolved.

*Call graph*: calls 6 internal fn (start, generate, noise_channel_prologue, encode_relay_message_frame, new, new); 16 external calls (clone, new, new, from_secs, new, bind, handshake, format!, current_exe, run_multiplexed_environment (+6 more)).


##### `duplicate_handshakes_exhaust_failure_budget`  (lines 112–206)

```
async fn duplicate_handshakes_exhaust_failure_budget() -> Result<()>
```

**Purpose**: Checks that repeatedly sending duplicate handshakes for the same stream id causes resets and eventually closes the physical relay after the configured failure budget is consumed.

**Data flow**: The test starts the environment with a blocking validator, constructs one valid handshake frame for `stream-1`, and sends it once to begin validation. It then repeatedly sends the same encoded handshake again: each duplicate should provoke a reset frame, which the test reads, decodes, and validates as `RelayFrameBodyKind::Reset`. The loop continues until the number of failures reaches `MAX_FAILED_NOISE_HANDSHAKES`, after which one more duplicate causes the environment task itself to terminate.

**Call relations**: It targets the duplicate-pending-handshake branch in `run_multiplexed_environment` where existing pending state is removed, a reset is sent, and `failed_handshake_budget_exhausted` may break the outer loop.

*Call graph*: calls 7 internal fn (start, generate, noise_channel_prologue, decode_relay_message_frame, encode_relay_message_frame, new, new); 18 external calls (clone, new, new, from_secs, new, bind, bail!, assert_eq!, handshake, format! (+8 more)).


##### `oversized_harness_authorization_is_rejected_before_validation`  (lines 209–262)

```
async fn oversized_harness_authorization_is_rejected_before_validation() -> Result<()>
```

**Purpose**: Ensures that an authorization payload larger than the configured byte limit is rejected immediately and never reaches the validator.

**Data flow**: The test starts the environment with a `BlockingValidator`, builds a valid Noise handshake whose payload is `MAX_HARNESS_KEY_AUTHORIZATION_BYTES + 1` bytes of `a`, sends it, reads back a binary reset frame, decodes and validates it as a reset, and asserts that the validator call counter remains `0`. It then closes the websocket and waits for clean shutdown.

**Call relations**: It exercises the branch in `run_multiplexed_environment` that converts `pending.payload` to UTF-8, checks its length, and sends a reset before spawning any validation task.

*Call graph*: calls 7 internal fn (start, generate, noise_channel_prologue, decode_relay_message_frame, encode_relay_message_frame, new, new); 18 external calls (clone, new, new, from_secs, new, bind, bail!, assert_eq!, handshake, format! (+8 more)).


##### `repeated_malformed_handshakes_close_the_physical_relay`  (lines 265–309)

```
async fn repeated_malformed_handshakes_close_the_physical_relay() -> Result<()>
```

**Purpose**: Shows that repeatedly sending cryptographically malformed handshake requests consumes the relay’s failure budget and closes the websocket connection.

**Data flow**: The test starts the environment, then for each attempt up to `MAX_FAILED_NOISE_HANDSHAKES` creates a valid initiator handshake request, flips the last byte to corrupt it, wraps it in a handshake frame with a unique stream id, and sends it. After the configured number of malformed attempts, it waits for the environment task to finish.

**Call relations**: It drives the `PendingResponderHandshake::read_request` failure path in `run_multiplexed_environment`, where malformed Noise requests trigger resets and increment the connection-wide failed-handshake counter.

*Call graph*: calls 6 internal fn (start, generate, noise_channel_prologue, encode_relay_message_frame, new, new); 14 external calls (new, new, from_secs, new, bind, handshake, format!, current_exe, run_multiplexed_environment, spawn (+4 more)).


##### `repeated_early_data_during_validation_closes_the_physical_relay`  (lines 312–358)

```
async fn repeated_early_data_during_validation_closes_the_physical_relay() -> Result<()>
```

**Purpose**: Verifies that sending data on a stream before its pending handshake validation completes is treated as a failure, and repeating that pattern eventually closes the physical relay.

**Data flow**: For each attempt, the test creates a valid handshake request for a unique stream id and immediately follows it with a relay data frame containing a one-byte payload on the same stream. It sends both frames over the websocket and, after repeating this `MAX_FAILED_NOISE_HANDSHAKES` times, waits for the environment task to terminate.

**Call relations**: It exercises the `Data` branch in `run_multiplexed_environment` when no active stream exists but a pending handshake does; that branch removes pending state, sends a reset, and counts the incident against the failure budget.

*Call graph*: calls 6 internal fn (start, generate, noise_channel_prologue, encode_relay_message_frame, new, new); 16 external calls (new, new, from_secs, new, bind, data, handshake, format!, current_exe, run_multiplexed_environment (+6 more)).


### `exec-server/src/remote/noise_tests.rs`

`test` · `test`

This test module targets the production logic in `remote.rs` rather than the lower-level relay loop. It defines a minimal `StaticRegistryAuthProvider` that inserts a fixed bearer token, then uses `wiremock` and real TCP/websocket listeners to simulate both the environment registry and rendezvous endpoint.

`reconnect_reuses_registration_until_url_is_rejected` drives the full `run_remote_environment` loop. The registry mock is configured to expect exactly two registration calls. The first rendezvous websocket connection is accepted and then cleanly closed, demonstrating that an ordinary disconnect causes the executor to reconnect to the same URL without re-registering. The second connection is intercepted at raw TCP level and answered with `HTTP/1.1 401 Unauthorized`, which the websocket client surfaces as an HTTP client error; that rejection should invalidate the old registration and trigger a fresh `/register` call before the third connection attempt.

The other two tests exercise `RegistryHarnessKeyValidator` directly. One confirms that a `200 OK` response with `{ "valid": false }` still fails closed with a protocol error rather than being treated as success. The other returns a `500` body containing the authorization token and asserts that the resulting `ExecServerError::EnvironmentRegistryHttp` uses the generic validation-failed message and that the token does not appear in the error’s display text. Together these tests document the intended security posture: reconnects reuse valid registrations, but authorization checks require explicit approval and never echo sensitive authorization material.

#### Function details

##### `StaticRegistryAuthProvider::add_auth_headers`  (lines 30–35)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds the fixed bearer token header used by remote Noise tests.

**Data flow**: It mutates the provided `HeaderMap` by inserting `Authorization: Bearer registry-token` and returns no value.

**Call relations**: It is used indirectly through `static_registry_auth_provider` by tests that construct registry clients or remote environment configs.

*Call graph*: 2 external calls (insert, from_static).


##### `static_registry_auth_provider`  (lines 38–40)

```
fn static_registry_auth_provider() -> SharedAuthProvider
```

**Purpose**: Creates the shared auth provider fixture for this test module.

**Data flow**: It allocates `StaticRegistryAuthProvider` in an `Arc` and returns it as `SharedAuthProvider`.

**Call relations**: It is called by all tests in this file when constructing `EnvironmentRegistryClient` or `RemoteEnvironmentConfig`.

*Call graph*: called by 3 (reconnect_reuses_registration_until_url_is_rejected, validate_harness_key_does_not_expose_error_body, validate_harness_key_requires_explicit_valid_response); 1 external calls (new).


##### `reconnect_reuses_registration_until_url_is_rejected`  (lines 43–93)

```
async fn reconnect_reuses_registration_until_url_is_rejected() -> Result<()>
```

**Purpose**: Verifies that `run_remote_environment` keeps using the existing rendezvous registration across ordinary disconnects, but re-registers after a websocket connection attempt is rejected with an HTTP 4xx.

**Data flow**: The test binds a local TCP listener to act as rendezvous, starts a mock registry that returns that websocket URL and expects exactly two registration POSTs, constructs `RemoteEnvironmentConfig`, and spawns `run_remote_environment`. It accepts the first websocket and closes it normally, then accepts a second raw TCP connection and replies with `401 Unauthorized` instead of completing a websocket handshake, then accepts a third websocket connection. Finally it verifies the registry expectations and aborts the environment task.

**Call relations**: It exercises the reconnect loop in `run_remote_environment`, specifically the branch that distinguishes ordinary disconnects from registration-rejected websocket errors.

*Call graph*: calls 3 internal fn (new, static_registry_auth_provider, new); 13 external calls (from_secs, given, start, new, bind, format!, json!, current_exe, spawn, timeout (+3 more)).


##### `validate_harness_key_requires_explicit_valid_response`  (lines 96–131)

```
async fn validate_harness_key_requires_explicit_valid_response()
```

**Purpose**: Ensures that harness-key validation succeeds only when the registry explicitly returns `valid: true`; a successful HTTP status with `valid: false` must still reject the key.

**Data flow**: The test starts a mock server, generates a harness public key, installs a `/validate` mock expecting the bearer token and exact JSON body, returns `{ "valid": false }`, constructs an `EnvironmentRegistryClient`, wraps it in `RegistryHarnessKeyValidator`, calls `validate_harness_key`, and asserts that the result is `ExecServerError::Protocol("environment registry rejected Noise relay harness key")`.

**Call relations**: It directly exercises `RegistryHarnessKeyValidator::validate_harness_key` and documents its fail-closed interpretation of the registry response body.

*Call graph*: calls 3 internal fn (generate, new, static_registry_auth_provider); 9 external calls (given, start, new, assert!, json!, body_partial_json, header, method, path).


##### `validate_harness_key_does_not_expose_error_body`  (lines 134–163)

```
async fn validate_harness_key_does_not_expose_error_body()
```

**Purpose**: Checks that validation HTTP failures do not include the response body, even if that body contains the sensitive harness authorization token.

**Data flow**: The test starts a mock server, generates a harness public key, configures `/validate` to return `500` with the authorization token as the body, constructs the client and validator, calls `validate_harness_key`, captures the resulting error, and asserts both that `error.to_string()` does not contain the token and that the error variant is `ExecServerError::EnvironmentRegistryHttp` with the generic message `environment registry harness key validation failed`.

**Call relations**: It targets the non-success branch inside `RegistryHarnessKeyValidator::validate_harness_key`, confirming that this path intentionally does not reuse the more body-inclusive registry error helpers.

*Call graph*: calls 3 internal fn (generate, new, static_registry_auth_provider); 6 external calls (given, start, new, assert!, method, path).


### `exec-server/tests/relay.rs`

`test` · `remote environment connection and encrypted relay validation during integration tests`

This file assembles a realistic remote-environment scenario around the relay protocol. It imports generated relay protobuf types, defines constants for environment IDs and registry credentials, and provides two small test doubles: `StaticRegistryAuthProvider`, which always inserts `Authorization: Bearer registry-token`, and `FailingNoiseConnectProvider`, which increments an `AtomicUsize` and always returns `ExecServerError::Protocol("test registry connect failure")`.

The first test uses `EnvironmentManager::without_environments()` and a failing provider to prove that each backend connection attempt fetches a fresh Noise rendezvous bundle rather than caching a failed one; two failed `start` calls must increment the attempt counter twice. The second test stands up a fake registry with `wiremock`, a fake websocket rendezvous listener, and a real remote environment task via `codex_exec_server::run_remote_environment`. It captures the executor public key from the registry registration request, generates a harness Noise identity, constructs `NoiseRendezvousConnectArgs`, and connects a real `ExecServerClient` through the relay while a proxy task forwards websocket frames between harness and environment and records binary payloads.

After connection, the test performs both `exec` and `fs_read_file` RPCs through the encrypted channel, including a 128 KiB file read to ensure larger payloads traverse the relay. `assert_relay_data_is_encrypted` decodes captured `RelayMessageFrame`s and checks that `Data` payloads do not contain plaintext protocol strings like `initialize`, `process/start`, or the client name, while also asserting multiple data frames were observed. The helper functions accept websocket connections, extract the registered executor public key from wiremock's recorded requests, proxy frames bidirectionally with `tokio::select!`, and capture only binary websocket frames for later inspection.

#### Function details

##### `StaticRegistryAuthProvider::add_auth_headers`  (lines 67–72)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Implements `AuthProvider` by inserting a fixed bearer token into outgoing registry HTTP headers.

**Data flow**: Receives a mutable `HeaderMap`, inserts `AUTHORIZATION: Bearer registry-token` using a static `HeaderValue`, and returns `()`.

**Call relations**: The remote-environment relay test uses this provider through `static_registry_auth_provider` when constructing `RemoteEnvironmentConfig`, ensuring the fake registry sees authenticated requests.

*Call graph*: 2 external calls (insert, from_static).


##### `FailingNoiseConnectProvider::connect_bundle`  (lines 80–91)

```
fn connect_bundle(
        &self,
        _: NoiseChannelPublicKey,
    ) -> BoxFuture<'_, Result<NoiseRendezvousConnectBundle, ExecServerError>>
```

**Purpose**: Implements `NoiseRendezvousConnectProvider` with a deterministic failure used to test retry behavior. Each call increments a shared attempt counter and returns a protocol error.

**Data flow**: Ignores the requested `NoiseChannelPublicKey`, increments `self.attempts` with `Ordering::SeqCst`, then returns a boxed async future that resolves to `Err(ExecServerError::Protocol("test registry connect failure"))`.

**Call relations**: The bundle-refresh test installs this provider into `EnvironmentManager`; repeated backend starts should invoke it once per attempt, which the test verifies via the atomic counter.

*Call graph*: 1 external calls (Protocol).


##### `static_registry_auth_provider`  (lines 94–96)

```
fn static_registry_auth_provider() -> codex_api::SharedAuthProvider
```

**Purpose**: Constructs the shared auth-provider handle expected by remote environment configuration from the static test provider.

**Data flow**: Allocates `StaticRegistryAuthProvider` inside an `Arc` and returns it as `codex_api::SharedAuthProvider`.

**Call relations**: Only the encrypted-relay test calls this helper when building `RemoteEnvironmentConfig` for `run_remote_environment`.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 1 external calls (new).


##### `noise_environment_refreshes_bundle_for_each_connection_attempt`  (lines 99–135)

```
async fn noise_environment_refreshes_bundle_for_each_connection_attempt() -> Result<()>
```

**Purpose**: Verifies that a Noise-backed environment fetches a fresh rendezvous bundle on every connection attempt instead of reusing a previously failed bundle.

**Data flow**: Creates an `AtomicUsize` counter, an empty `EnvironmentManager`, and inserts a noise environment backed by `FailingNoiseConnectProvider`. It materializes the environment, gets its exec backend, then loops twice calling `backend.start` with `ExecParams` for `true` in the current directory. Each call must return `ExecServerError::Protocol("test registry connect failure")`; afterward the test asserts the atomic attempt count is `2`.

**Call relations**: This test exercises environment-manager orchestration and backend startup retry behavior without involving the full relay stack. The failing provider is the key dependency that exposes whether bundle acquisition is retried.

*Call graph*: calls 3 internal fn (without_environments, new, from_path); 9 external calls (clone, new, new, new, assert!, assert_eq!, format!, current_dir, vec!).


##### `remote_environment_routes_encrypted_exec_server_rpc`  (lines 138–250)

```
async fn remote_environment_routes_encrypted_exec_server_rpc() -> Result<()>
```

**Purpose**: End-to-end test proving that a remote environment can register with the registry, connect through the rendezvous relay, serve exec-server RPCs over Noise, and keep relayed payloads encrypted on the wire.

**Data flow**: Binds a fake rendezvous `TcpListener`, starts a `wiremock::MockServer`, installs `/register` and `/validate` mocks requiring the bearer token, computes runtime helper paths, builds `ExecServerRuntimePaths` and `RemoteEnvironmentConfig`, and spawns `run_remote_environment`. It accepts the environment websocket, extracts the executor public key from recorded registry requests, generates a harness `NoiseChannelIdentity`, builds `NoiseRendezvousConnectArgs`, and spawns `ExecServerClient::connect_noise_rendezvous`. After accepting the harness websocket, it starts `proxy_relay_frames` with a shared captured-frame buffer, awaits client connection, performs `exec` for `true`, creates a 128 KiB temp file, reads it through `fs_read_file`, base64-decodes the response, and asserts the bytes match. Finally it checks captured relay frames for encryption properties, then aborts relay and environment tasks.

**Call relations**: This is the central integration test in the file. It ties together the auth provider, fake registry, websocket rendezvous listener, relay proxy, remote environment runtime, and real client connection path.

*Call graph*: calls 11 internal fn (generate, from, new, new, current_test_binary_helper_paths, accept_websocket, assert_relay_data_is_encrypted, proxy_relay_frames, registered_executor_public_key, static_registry_auth_provider (+1 more)); 23 external calls (clone, new, new, given, start, new, new, bind, new, new (+13 more)).


##### `accept_websocket`  (lines 252–263)

```
async fn accept_websocket(
    listener: &TcpListener,
    role: &str,
) -> Result<WebSocketStream<TcpStream>>
```

**Purpose**: Accepts one websocket connection from the fake rendezvous listener with role-specific timeout/error context.

**Data flow**: Takes a `TcpListener` and role label, awaits `listener.accept()` under `TEST_TIMEOUT`, then upgrades the accepted socket with `accept_async` under another timeout. It returns the resulting `WebSocketStream<TcpStream>` or a contextualized error mentioning the role.

**Call relations**: The encrypted-relay test calls this twice—once for the environment side and once for the harness side—while assembling the fake rendezvous relay.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 3 external calls (accept, timeout, accept_async).


##### `registered_executor_public_key`  (lines 265–277)

```
async fn registered_executor_public_key(registry: &MockServer) -> Result<NoiseChannelPublicKey>
```

**Purpose**: Extracts the executor's registered Noise public key from the fake registry's recorded `/register` request body.

**Data flow**: Fetches `received_requests()` from the `MockServer`, finds the request whose URL path ends with `/register`, deserializes its JSON body into `serde_json::Value`, then deserializes the `executor_public_key` field into `NoiseChannelPublicKey` and returns it.

**Call relations**: The encrypted-relay test uses this helper after the remote environment registers, so it can build matching `NoiseRendezvousConnectArgs` for the harness client.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 3 external calls (received_requests, from_slice, from_value).


##### `proxy_relay_frames`  (lines 279–305)

```
async fn proxy_relay_frames(
    mut environment: WebSocketStream<TcpStream>,
    mut harness: WebSocketStream<TcpStream>,
    captured_frames: Arc<Mutex<Vec<Vec<u8>>>>,
) -> Result<()>
```

**Purpose**: Acts as a transparent fake relay between environment and harness websockets while recording binary frames for later encryption inspection.

**Data flow**: Owns two `WebSocketStream<TcpStream>` endpoints and a shared `Arc<Mutex<Vec<Vec<u8>>>>`. In a loop, `tokio::select!` waits for the next message from either side; for each received message it propagates websocket errors, records binary payloads via `capture_binary_frame`, forwards the message to the opposite side with `send`, and exits when either stream ends.

**Call relations**: Spawned by the encrypted-relay test after both websocket sides connect. It is the mechanism that both relays traffic and captures the raw relay frames inspected later.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 1 external calls (select!).


##### `capture_binary_frame`  (lines 307–314)

```
fn capture_binary_frame(captured_frames: &Mutex<Vec<Vec<u8>>>, message: &Message)
```

**Purpose**: Records websocket binary frames into a shared vector while ignoring non-binary messages.

**Data flow**: Takes a `Mutex<Vec<Vec<u8>>>` and a websocket `Message`; if the message is `Message::Binary`, it locks the mutex, recovering from poisoning with `PoisonError::into_inner`, clones the bytes into a new `Vec<u8>`, and pushes them into the capture buffer.

**Call relations**: Called by `proxy_relay_frames` on every forwarded message so the encrypted-relay test can later inspect the raw relay payloads.


##### `assert_relay_data_is_encrypted`  (lines 316–337)

```
fn assert_relay_data_is_encrypted(captured_frames: &Mutex<Vec<Vec<u8>>>) -> Result<()>
```

**Purpose**: Validates that captured relay `Data` frames do not expose plaintext JSON-RPC method names or client identifiers, providing evidence that the relay carries encrypted payloads.

**Data flow**: Locks the captured-frame buffer, iterates over each encoded frame, decodes it as `RelayMessageFrame`, filters to frames whose body is `relay_message_frame::Body::Data`, increments a counter, converts each data payload to lossy UTF-8, and asserts the plaintext does not contain `initialize`, `process/start`, or `noise-relay-test`. It finally asserts at least four data frames were seen and returns `Ok(())`.

**Call relations**: The encrypted-relay test calls this after successful RPCs have traversed the relay. It depends on `proxy_relay_frames` having captured the binary websocket frames.

*Call graph*: called by 1 (remote_environment_routes_encrypted_exec_server_rpc); 3 external calls (from_utf8_lossy, assert!, decode).


### `app-server-transport/src/transport/remote_control/segment_tests.rs`

`test` · `test-only`

This test file focuses narrowly on the segmentation rules implemented in `segment.rs`. The tests build concrete `ClientEnvelope` and `ServerEnvelope` values and verify both happy-path and edge-case behavior.

The inbound tests cover reassembly of a JSON-RPC notification split into two base64 chunks, explicit invalidation of an incomplete assembly when a stream is closed, replacement of an incomplete assembly when the same client starts a new stream, and the subtle stale-chunk cases that should be ignored rather than destroying a newer in-progress assembly. Those stale cases include an older `seq_id`, an invalid stale chunk with empty payload, and an invalid duplicate chunk for the current `seq_id` but already-consumed `segment_id`. The expected outcomes distinguish `Pending`, `Forward`, and `Dropped` exactly as the production reassembler does.

The outbound test constructs a deliberately oversized `ServerMessage` carrying a `ConfigWarningNotification` whose summary exceeds the segment size threshold. It then verifies that `split_server_envelope_for_transport` returns multiple `ServerMessageChunk` envelopes, preserves the original `seq_id`, and keeps every serialized chunk at or below `REMOTE_CONTROL_SEGMENT_MAX_BYTES`.

A small helper, `chunk_envelope`, centralizes construction of chunked client envelopes with base64 encoding so the tests can focus on sequencing and stream behavior rather than wire formatting.

#### Function details

##### `reassembles_client_message_chunks`  (lines 20–70)

```
fn reassembles_client_message_chunks()
```

**Purpose**: Verifies that two ordered chunks for the same client/stream/sequence are buffered and emitted as one reconstructed `ClientMessage` envelope.

**Data flow**: Builds a JSON-RPC notification, serializes it to bytes, splits the bytes in half, feeds two chunk envelopes into a fresh `ClientSegmentReassembler`, asserts the first result is `Pending`, unwraps the second as `Forward`, and checks that client id, stream id, seq id, cursor, and reconstructed message all match expectations.

**Call relations**: Directly exercises the happy-path branch of `ClientSegmentReassembler::observe` using the local `chunk_envelope` helper.

*Call graph*: calls 1 internal fn (chunk_envelope); 8 external calls (Notification, new, new, default, assert!, assert_eq!, panic!, to_vec).


##### `splits_large_server_messages_into_wire_chunks`  (lines 73–105)

```
fn splits_large_server_messages_into_wire_chunks()
```

**Purpose**: Checks that an oversized outbound server message is segmented into multiple chunk envelopes that each fit the configured wire-size limit.

**Data flow**: Constructs a `ServerEnvelope` containing a very large `ConfigWarningNotification`, passes it to `split_server_envelope_for_transport`, then asserts the result has more than one segment, every segment event is `ServerMessageChunk`, every segment preserves `seq_id = 9`, and each serialized segment length is within `REMOTE_CONTROL_SEGMENT_MAX_BYTES`.

**Call relations**: Covers the outbound segmentation path in `segment.rs`.

*Call graph*: calls 1 internal fn (split_server_envelope_for_transport); 6 external calls (new, ConfigWarning, AppServerNotification, new, new, assert!).


##### `invalidates_incomplete_stream_assemblies`  (lines 108–144)

```
fn invalidates_incomplete_stream_assemblies()
```

**Purpose**: Ensures that explicitly invalidating a stream discards any partial assembly so later chunks from that stream are dropped.

**Data flow**: Creates a two-chunk message, feeds the first chunk and observes `Pending`, calls `invalidate_stream`, then feeds the second chunk and asserts the result is `Dropped`.

**Call relations**: Exercises the interaction between `invalidate_stream` and `observe` for incomplete assemblies.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `resets_incomplete_client_assembly_when_stream_changes`  (lines 147–213)

```
fn resets_incomplete_client_assembly_when_stream_changes()
```

**Purpose**: Verifies that when the same client starts sending chunks on a new stream, the old incomplete assembly is replaced and only the new stream can complete.

**Data flow**: Starts an assembly on `stream-1`, then sends the first chunk of a newer sequence on `stream-2`, expecting both to be `Pending`. It completes `stream-2` successfully and asserts the reconstructed envelope carries `stream-2`, then sends the old second chunk for `stream-1` and asserts it is dropped.

**Call relations**: Covers the stream-change reset branch in the reassembler.

*Call graph*: calls 1 internal fn (chunk_envelope); 8 external calls (Notification, new, new, default, assert!, assert_eq!, panic!, to_vec).


##### `ignores_stale_chunks_without_dropping_newer_assembly`  (lines 216–263)

```
fn ignores_stale_chunks_without_dropping_newer_assembly()
```

**Purpose**: Checks that an older sequence’s chunk is ignored rather than tearing down a newer in-progress assembly for the same client and stream.

**Data flow**: Begins assembly for `seq_id = 8`, sends a stale first chunk for `seq_id = 7` and expects `Dropped`, then sends the valid second chunk for `seq_id = 8` and expects successful forwarding.

**Call relations**: Exercises the stale-sequence detection path implemented by `should_ignore_chunk`.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `ignores_invalid_stale_chunks_without_dropping_newer_assembly`  (lines 266–313)

```
fn ignores_invalid_stale_chunks_without_dropping_newer_assembly()
```

**Purpose**: Ensures that even malformed stale chunks do not destroy the newer assembly they are stale relative to.

**Data flow**: Starts assembly for `seq_id = 8`, sends a stale chunk for `seq_id = 7` with an empty payload and expects `Dropped`, then completes the `seq_id = 8` assembly successfully.

**Call relations**: Protects the reassembler’s distinction between stale chunks and fatal errors on the current assembly.

*Call graph*: 6 external calls (Notification, new, new, default, assert!, to_vec).


##### `ignores_invalid_duplicate_chunks_without_dropping_current_assembly`  (lines 316–363)

```
fn ignores_invalid_duplicate_chunks_without_dropping_current_assembly()
```

**Purpose**: Verifies that an invalid duplicate of an already-consumed chunk is ignored without breaking the current assembly.

**Data flow**: Starts assembly for `seq_id = 8`, sends another chunk with the same `segment_id = 0` but empty payload and expects `Dropped`, then sends the valid second chunk and expects successful forwarding.

**Call relations**: Covers the duplicate/stale-segment branch where `segment_id < next_segment_id` should not reset the assembly.

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

**Purpose**: Builds a `ClientEnvelope` representing one base64-encoded message chunk for test inputs.

**Data flow**: Takes client id, optional stream id, sequence id, segment metadata, and raw chunk bytes; base64-encodes the chunk and returns a `ClientEnvelope` with `ClientEvent::ClientMessageChunk`, `seq_id: Some(seq_id)`, and `cursor: None`.

**Call relations**: Shared helper used by the chunk-reassembly tests to generate realistic wire envelopes.

*Call graph*: called by 2 (reassembles_client_message_chunks, resets_incomplete_client_assembly_when_stream_changes).


### `app-server-transport/src/transport/remote_control/tests.rs`

`test` · `test-only`

This is the main integration test suite for the remote-control subsystem. It builds real `RemoteControlHandle` instances and background websocket tasks, drives them with local TCP listeners and websocket handshakes, and inspects both transport events and sqlite persistence. The file includes reusable fixtures for auth managers, synthetic `AuthDotJson` payloads, temporary `StateRuntime` instances, expected server-token JSON responses, and helpers for waiting on status watch channels.

The tests cover startup-state resolution from persisted `remote_control_enabled`, explicit disabled startup ignoring persisted enablement, managed-policy disablement blocking all backend contact, ephemeral enable preserving an existing durable preference, and startup behavior when URL validation, auth, or sqlite availability would otherwise fail. The transport-focused tests verify enrollment-before-connect, reconnect after disconnect, token refresh after websocket 401, virtual client creation only after `initialize`, routing of incoming/outgoing JSON-RPC messages, pong behavior for active vs unknown clients, and clearing of buffered outgoing messages after backend acknowledgements.

Several scenarios exercise persistence and reenrollment semantics in HTTP mode: refreshing a persisted enrollment before connecting, waiting for stdio client name before selecting a scoped persisted row, waiting for account id before enrolling, disabling when auth switches to an account without a persisted enable preference, reenrolling after refresh or websocket 404 indicates a stale server, and preserving stale enrollment rows when reenrollment fails or when a generic websocket 404 should not be treated as explicit missing-server state.

The helper functions at the bottom implement a tiny HTTP/websocket test server: they capture request lines, headers, and bodies; send JSON or arbitrary status responses; capture websocket handshake headers; send serialized client envelopes; and read server events while handling ping/pong frames.

#### Function details

##### `remote_control_auth_manager`  (lines 76–78)

```
fn remote_control_auth_manager() -> Arc<AuthManager>
```

**Purpose**: Creates an `AuthManager` seeded with dummy ChatGPT auth for tests that do not need a custom home directory.

**Data flow**: Builds a dummy `CodexAuth` via `create_dummy_chatgpt_auth_for_testing`, passes it to `auth_manager_from_auth`, and returns the resulting shared manager.

**Call relations**: Common fixture used by many integration tests that need authenticated remote-control requests.

*Call graph*: calls 2 internal fn (auth_manager_from_auth, create_dummy_chatgpt_auth_for_testing); called by 12 (ephemeral_enable_preserves_durable_preference, explicit_disabled_start_ignores_persisted_enable, managed_disable_overrides_startup_and_persisted_enablement, plain_start_resolves_persisted_remote_control_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_start_allows_remote_control_invalid_url_when_disabled, remote_control_start_reports_missing_state_db_as_disabled_when_enabled, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages (+2 more)).


##### `remote_control_auth_manager_with_home`  (lines 80–85)

```
fn remote_control_auth_manager_with_home(codex_home: &TempDir) -> Arc<AuthManager>
```

**Purpose**: Creates an `AuthManager` seeded with dummy ChatGPT auth and rooted at a supplied temporary home directory.

**Data flow**: Reads the temp directory path, creates dummy auth, passes both into `auth_manager_from_auth_with_home`, and returns the shared manager.

**Call relations**: Used by tests that need auth state and sqlite state to share the same temp home.

*Call graph*: calls 2 internal fn (auth_manager_from_auth_with_home, create_dummy_chatgpt_auth_for_testing); called by 6 (remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting); 1 external calls (path).


##### `remote_control_auth_dot_json`  (lines 87–125)

```
fn remote_control_auth_dot_json(account_id: Option<&str>) -> AuthDotJson
```

**Purpose**: Builds a synthetic `AuthDotJson` containing a fake ChatGPT JWT and configurable account id for auth-reload tests.

**Data flow**: Constructs a JWT header and payload JSON, base64url-encodes them, assembles a fake token string, parses claims with `parse_chatgpt_jwt_claims`, and returns an `AuthDotJson` with ChatGPT auth mode, token data, optional account id, and current refresh timestamp.

**Call relations**: Used by tests that save auth to disk and then trigger `AuthManager::reload()` to simulate account changes or delayed account-id availability.

*Call graph*: calls 1 internal fn (parse_chatgpt_jwt_claims); called by 2 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_waits_for_account_id_before_enrolling); 4 external calls (now, format!, json!, to_vec).


##### `remote_control_state_runtime`  (lines 127–131)

```
async fn remote_control_state_runtime(codex_home: &TempDir) -> Arc<StateRuntime>
```

**Purpose**: Initializes a temporary sqlite-backed `StateRuntime` for integration tests.

**Data flow**: Reads the temp directory path, calls `StateRuntime::init` with a fixed provider string, awaits initialization, and returns the runtime in `Arc`.

**Call relations**: Shared persistence fixture across startup, reenrollment, and transport tests.

*Call graph*: calls 1 internal fn (init); called by 19 (ephemeral_enable_preserves_durable_preference, explicit_disabled_start_ignores_persisted_enable, managed_disable_overrides_startup_and_persisted_enablement, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, plain_start_resolves_persisted_remote_control_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404 (+9 more)); 1 external calls (path).


##### `plain_start_resolves_persisted_remote_control_preference`  (lines 134–205)

```
async fn plain_start_resolves_persisted_remote_control_preference()
```

**Purpose**: Verifies that unknown startup state resolves to enabled only for rows with `remote_control_enabled = Some(true)` and otherwise resolves to disabled.

**Data flow**: Creates a temp state DB, inserts enrollment rows for several client-name cases with enabled/disabled/unset preferences, constructs a `RemoteControlWebsocket` with `desired_state_tx` initially `Unknown`, repeatedly resets the desired state, calls `resolve_unknown_desired_state(Some(name))`, and asserts the resulting desired state matches the persisted preference semantics.

**Call relations**: Exercises the websocket-side startup resolution path against real sqlite rows.

*Call graph*: calls 7 internal fn (new, normalize_remote_control_url, remote_control_auth_manager, remote_control_state_runtime, test_server_name, new, new); 9 external calls (new, new, new, new, assert!, assert_eq!, format!, channel, channel).


##### `explicit_disabled_start_ignores_persisted_enable`  (lines 208–263)

```
async fn explicit_disabled_start_ignores_persisted_enable()
```

**Purpose**: Checks that `DisabledEphemeral` startup mode forces runtime disabled state without altering an existing persisted enabled row.

**Data flow**: Persists an enabled enrollment row, starts remote control with `RemoteControlStartupMode::DisabledEphemeral`, asserts the handle’s desired state is `Disabled`, reloads the sqlite row to confirm it is unchanged, then shuts down the task.

**Call relations**: Covers startup-mode precedence over persisted preference.

*Call graph*: calls 3 internal fn (normalize_remote_control_url, remote_control_auth_manager, remote_control_state_runtime); 4 external calls (new, new, assert_eq!, channel).


##### `managed_disable_overrides_startup_and_persisted_enablement`  (lines 266–362)

```
async fn managed_disable_overrides_startup_and_persisted_enablement()
```

**Purpose**: Ensures managed requirements disable remote control regardless of startup mode or persisted enabled rows and prevent any backend contact.

**Data flow**: Persists an enabled enrollment, starts remote control with policy `DisabledByRequirements` and startup mode `EnabledEphemeral`, then asserts disabled status, policy-check failure, `resolve_persisted_preference` returning false without DB-driven enablement, ephemeral and durable enable/disable APIs returning permission errors, persisted sqlite row remaining intact, and no listener connection arriving.

**Call relations**: Integration test for policy gating across startup and handle APIs.

*Call graph*: calls 4 internal fn (normalize_remote_control_url, remote_control_auth_manager, remote_control_state_runtime, remote_control_url_for_listener); 8 external calls (new, from_millis, bind, new, assert!, assert_eq!, channel, timeout).


##### `remote_control_url_for_listener`  (lines 364–369)

```
fn remote_control_url_for_listener(listener: &TcpListener) -> String
```

**Purpose**: Builds a localhost backend base URL string from a bound test listener’s socket address.

**Data flow**: Reads `listener.local_addr()` and formats `http://{addr}/backend-api/`.

**Call relations**: Shared helper for tests that stand up a local fake backend.

*Call graph*: called by 17 (managed_disable_overrides_startup_and_persisted_enablement, persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_start_allows_missing_auth_when_enabled (+7 more)); 2 external calls (local_addr, format!).


##### `test_server_name`  (lines 371–373)

```
fn test_server_name() -> String
```

**Purpose**: Returns the hostname-derived server name used by the production startup code.

**Data flow**: Reads the system hostname, converts it lossily to string, trims whitespace, and returns it.

**Call relations**: Used in assertions so tests match the same server-name derivation as production code.

*Call graph*: called by 5 (plain_start_resolves_persisted_remote_control_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_handle_with_current_enrollment, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails); 1 external calls (gethostname).


##### `remote_control_handle_with_current_enrollment`  (lines 375–418)

```
fn remote_control_handle_with_current_enrollment(
    remote_control_url: &str,
    auth_manager: Arc<AuthManager>,
) -> RemoteControlHandle
```

**Purpose**: Constructs a `RemoteControlHandle` preloaded with an enabled desired state, connecting status, and a current enrollment carrying a valid token.

**Data flow**: Creates watch channels for desired state and status, normalizes the remote-control URL, builds a `RemoteControlEnrollment` with fixed account/environment/server ids and a far-future expiry, wraps it in `RemoteControlEnrollmentState`, and returns a handle with no state DB and policy `Allowed`.

**Call relations**: Fixture used by the ephemeral-enable preference-preservation test.

*Call graph*: calls 3 internal fn (new, normalize_remote_control_url, test_server_name); called by 1 (ephemeral_enable_preserves_durable_preference); 4 external calls (new, from_unix_timestamp, new, channel).


##### `ephemeral_enable_preserves_durable_preference`  (lines 421–456)

```
async fn ephemeral_enable_preserves_durable_preference()
```

**Purpose**: Verifies that ephemeral enable does not erase an existing durable preference but still uses runtime-only preference when enabling from disabled.

**Data flow**: Builds a handle with current enrollment, injects a real state DB, sets desired state first to `Enabled { Some(true) }` and calls `enable_ephemeral`, asserting the durable preference remains; then sets desired state to `Disabled`, calls `enable_ephemeral` again, and asserts the new state is `Enabled { None }`.

**Call relations**: Directly exercises the subtle preference-preservation logic in `enable_with_preference`.

*Call graph*: calls 3 internal fn (remote_control_auth_manager, remote_control_handle_with_current_enrollment, remote_control_state_runtime); 2 external calls (new, assert_eq!).


##### `remote_control_server_token_response`  (lines 458–469)

```
fn remote_control_server_token_response(
    server_id: &str,
    environment_id: &str,
    remote_control_token: &str,
) -> serde_json::Value
```

**Purpose**: Creates the JSON body used by fake backend enroll/refresh responses in tests.

**Data flow**: Formats a JSON object containing `server_id`, `environment_id`, `remote_control_token`, and the shared expiry constant.

**Call relations**: Shared response fixture for enrollment and refresh scenarios.

*Call graph*: called by 13 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages (+3 more)); 1 external calls (json!).


##### `expect_remote_control_status`  (lines 471–487)

```
async fn expect_remote_control_status(
    status_rx: &mut watch::Receiver<RemoteControlStatusChangedNotification>,
    expected_status: Option<RemoteControlConnectionStatus>,
    expected_environment
```

**Purpose**: Waits for one status-channel change and asserts selected fields of the resulting snapshot.

**Data flow**: Awaits `status_rx.changed()` with a 5-second timeout, borrows the new status, optionally checks `status.status`, and always checks `server_name`, `installation_id`, and `environment_id` against expected values.

**Call relations**: Used by many integration tests to synchronize on asynchronous status transitions.

*Call graph*: called by 9 (remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages, remote_control_transport_reconnects_after_disconnect, remote_control_transport_refreshes_server_token_after_websocket_unauthorized); 5 external calls (from_secs, assert_eq!, borrow, changed, timeout).


##### `expect_remote_control_status_snapshot`  (lines 489–515)

```
async fn expect_remote_control_status_snapshot(
    status_rx: &mut watch::Receiver<RemoteControlStatusChangedNotification>,
    expected_status: RemoteControlStatusChangedNotification,
)
```

**Purpose**: Waits until the status watch channel exactly matches a target snapshot, tolerating intermediate states.

**Data flow**: If the current borrowed status already equals the expected snapshot, it returns immediately. Otherwise it loops on `changed()` under a timeout until the borrowed value equals the expected snapshot, then asserts success.

**Call relations**: Used when tests need an exact status snapshot rather than just the next change.

*Call graph*: called by 2 (remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404); 6 external calls (from_secs, clone, assert!, borrow, changed, timeout).


##### `remote_control_transport_manages_virtual_clients_and_routes_messages`  (lines 518–812)

```
async fn remote_control_transport_manages_virtual_clients_and_routes_messages()
```

**Purpose**: End-to-end test that remote control enrolls, connects, creates virtual transport clients on initialize, routes messages, emits pong status, and closes connections on client close.

**Data flow**: Starts a fake backend listener and remote-control task in enabled mode, serves an enroll response, accepts the websocket, checks persisted enrollment state and status, sends ping and non-initialize messages, verifies only initialize opens a `TransportEvent::ConnectionOpened`, checks subsequent incoming messages route to the same connection id, sends an outgoing app-server notification through the returned writer and verifies the backend receives a `server_message`, then sends `ClientClosed` and confirms `ConnectionClosed`, followed by another ping showing the client is now unknown.

**Call relations**: This is the broadest transport integration test, covering the interaction between websocket protocol handling and the app-server transport event layer.

*Call graph*: calls 11 internal fn (new, normalize_remote_control_url, accept_http_request, accept_remote_control_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 15 external calls (new, from_secs, ConfigWarning, bind, new, Notification, Request, Integer, AppServerNotification, new (+5 more)).


##### `remote_control_transport_reconnects_after_disconnect`  (lines 815–914)

```
async fn remote_control_transport_reconnects_after_disconnect()
```

**Purpose**: Ensures the websocket task reconnects after the backend closes the connection and can still open virtual clients afterward.

**Data flow**: Starts remote control, serves enrollment, accepts and closes the first websocket, accepts the second websocket handshake, checks the authorization header and status, sends an initialize request over the reconnected websocket, and asserts a new `ConnectionOpened` transport event arrives.

**Call relations**: Covers reconnect behavior after transport-level disconnects.

*Call graph*: calls 9 internal fn (accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, send_client_event); 11 external calls (new, from_secs, bind, new, Request, Integer, new, assert_eq!, json!, panic! (+1 more)).


##### `remote_control_transport_refreshes_server_token_after_websocket_unauthorized`  (lines 917–1000)

```
async fn remote_control_transport_refreshes_server_token_after_websocket_unauthorized()
```

**Purpose**: Verifies that a websocket 401 response triggers a refresh request and reconnect using the refreshed bearer token.

**Data flow**: Starts remote control, serves enrollment, captures the first websocket HTTP upgrade request and responds `401 Unauthorized`, captures the subsequent refresh request and serves a refreshed token, then accepts the next websocket handshake and asserts it uses the refreshed bearer token while status reaches the expected environment.

**Call relations**: Exercises the websocket unauthorized-recovery path and token refresh integration.

*Call graph*: calls 9 internal fn (accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, respond_with_status); 4 external calls (new, bind, new, assert_eq!).


##### `remote_control_start_allows_remote_control_invalid_url_when_disabled`  (lines 1003–1028)

```
async fn remote_control_start_allows_remote_control_invalid_url_when_disabled()
```

**Purpose**: Checks that startup does not validate the remote-control URL when initial desired state is effectively disabled.

**Data flow**: Starts remote control with an invalid non-allowed URL, no state DB, and `ResolvePersisted` mode, asserts startup succeeds, then cancels shutdown and waits for the task to stop cleanly.

**Call relations**: Covers the startup optimization that skips URL normalization when remote control will not connect anyway.

*Call graph*: calls 1 internal fn (remote_control_auth_manager); 3 external calls (new, from_secs, timeout).


##### `remote_control_start_allows_missing_auth_when_enabled`  (lines 1031–1073)

```
async fn remote_control_start_allows_missing_auth_when_enabled()
```

**Purpose**: Ensures startup can begin in enabled mode even before ChatGPT auth exists, and that no backend contact occurs until auth becomes available.

**Data flow**: Creates an empty `AuthManager`, starts remote control in enabled mode with a real state DB, then asserts no listener connection arrives within a short timeout before shutting down.

**Call relations**: Tests that the websocket task waits for auth rather than failing startup.

*Call graph*: calls 4 internal fn (remote_control_state_runtime, remote_control_url_for_listener, default, shared); 6 external calls (new, from_millis, from_secs, bind, new, timeout).


##### `remote_control_start_reports_missing_state_db_as_disabled_when_enabled`  (lines 1076–1132)

```
async fn remote_control_start_reports_missing_state_db_as_disabled_when_enabled()
```

**Purpose**: Verifies that requesting enabled startup without sqlite state falls back to disabled status and rejects later enable attempts as unavailable.

**Data flow**: Starts remote control with no state DB and enabled startup mode, asserts the initial status snapshot is disabled, confirms no backend connection occurs, calls `enable_ephemeral` and checks it returns `RemoteControlUnavailable`, confirms no connection or status change follows, then shuts down.

**Call relations**: Covers the state-db availability invariant required for remote control enablement.

*Call graph*: calls 2 internal fn (remote_control_auth_manager, remote_control_url_for_listener); 6 external calls (new, from_millis, from_secs, bind, assert_eq!, timeout).


##### `remote_control_handle_enable_disable_stops_and_restarts_connections`  (lines 1135–1252)

```
async fn remote_control_handle_enable_disable_stops_and_restarts_connections()
```

**Purpose**: Checks that durable disable closes the websocket and durable enable restarts connection establishment while preserving environment status.

**Data flow**: Starts remote control, serves enrollment, accepts the first websocket, waits for connected status, calls `disable(Some("rpc-client"))` and asserts disabled status plus websocket closure and no reconnect, then calls `enable(Some("rpc-client"))`, asserts connecting status, accepts a second websocket, waits for environment status, and finally closes and shuts down.

**Call relations**: Exercises the handle’s durable enable/disable APIs against the live websocket task.

*Call graph*: calls 10 internal fn (accept_http_request, accept_remote_control_connection, expect_remote_control_status, expect_remote_control_status_snapshot, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, test_server_name); 7 external calls (new, from_millis, from_secs, bind, new, assert_eq!, timeout).


##### `remote_control_transport_clears_outgoing_buffer_when_backend_acks`  (lines 1255–1434)

```
async fn remote_control_transport_clears_outgoing_buffer_when_backend_acks()
```

**Purpose**: Verifies that backend acknowledgements clear buffered outgoing messages so they are not replayed after reconnect.

**Data flow**: Starts remote control, enrolls and connects, opens a virtual client via initialize, sends an outgoing notification through the writer and captures the resulting server event plus `stream_id`, sends an `Ack` for that `seq_id` and stream, closes the client and websocket, reconnects, sends a ping, and confirms no stale buffered message is replayed—only a pong for an unknown client is observed.

**Call relations**: Covers the interaction between outbound buffering, ack processing, and reconnect behavior.

*Call graph*: calls 11 internal fn (new, accept_http_request, accept_remote_control_connection, expect_remote_control_status, read_server_event_with_stream_id, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 13 external calls (new, from_secs, ConfigWarning, bind, new, Request, Integer, AppServerNotification, new, assert_eq! (+3 more)).


##### `remote_control_http_mode_enrolls_before_connecting`  (lines 1437–1661)

```
async fn remote_control_http_mode_enrolls_before_connecting()
```

**Purpose**: End-to-end test that enabled startup performs HTTP enrollment first, then websocket connect with the expected headers, and routes backend client traffic correctly.

**Data flow**: Starts remote control, captures the enroll request and asserts authorization/account/install headers plus request JSON fields, serves an enrollment token, accepts the websocket handshake and checks server-id/name/protocol/install headers, then sends an initialize request from a backend client, captures the resulting transport connection and incoming message, sends an initialize response and a config-warning notification through the writer, and verifies both arrive as `server_message` events on the websocket.

**Call relations**: This is the canonical happy-path integration test for enrollment plus websocket transport.

*Call graph*: calls 10 internal fn (new, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, send_client_event); 15 external calls (new, from_secs, ConfigWarning, bind, new, Request, Integer, AppServerNotification, Response, new (+5 more)).


##### `remote_control_http_mode_refreshes_persisted_enrollment_before_connecting`  (lines 1664–1768)

```
async fn remote_control_http_mode_refreshes_persisted_enrollment_before_connecting()
```

**Purpose**: Ensures that when a persisted enrollment exists, startup refreshes its token instead of reenrolling and preserves the persisted row.

**Data flow**: Persists an enrollment row, starts remote control, captures the refresh request and asserts its body references the persisted `server_id`, serves a refreshed token, accepts the websocket handshake and checks it uses the persisted server id and refreshed bearer token, then reloads the persisted enrollment and asserts it is unchanged.

**Call relations**: Covers the persisted-enrollment reuse path during startup.

*Call graph*: calls 9 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json); 4 external calls (new, bind, new, assert_eq!).


##### `remote_control_stdio_mode_waits_for_client_name_before_connecting`  (lines 1771–1848)

```
async fn remote_control_stdio_mode_waits_for_client_name_before_connecting()
```

**Purpose**: Verifies that stdio-mode remote control delays backend contact until the app-server client name arrives so it can select the correctly scoped persisted enrollment.

**Data flow**: Persists an enrollment row scoped to a specific `app_server_client_name`, starts remote control with a oneshot receiver for that name, asserts no backend connection occurs before the name is sent, sends the name, then observes a refresh request and websocket handshake using the persisted server id.

**Call relations**: Exercises the pairing-persistence-key gating used when persistence scope depends on the stdio client name.

*Call graph*: calls 9 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json); 6 external calls (new, from_millis, bind, new, assert_eq!, timeout).


##### `remote_control_waits_for_account_id_before_enrolling`  (lines 1851–1943)

```
async fn remote_control_waits_for_account_id_before_enrolling()
```

**Purpose**: Ensures enabled startup waits until auth includes an account id before attempting enrollment.

**Data flow**: Saves auth without an account id, starts remote control, asserts no backend contact occurs, then saves auth with an account id and reloads the manager. It captures the subsequent enroll request, serves an enrollment token, accepts the websocket handshake, and checks the expected server id is used.

**Call relations**: Covers delayed-auth readiness and wake-up on auth reload.

*Call graph*: calls 10 internal fn (normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_dot_json, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, default, shared); 8 external calls (new, from_millis, bind, new, assert_eq!, save_auth, gethostname, timeout).


##### `persisted_enable_does_not_follow_auth_to_an_account_without_a_preference`  (lines 1946–2064)

```
async fn persisted_enable_does_not_follow_auth_to_an_account_without_a_preference()
```

**Purpose**: Verifies that a persisted enabled preference for one account does not automatically enable remote control after auth switches to a different account lacking such a preference.

**Data flow**: Saves auth for account A, persists an enabled enrollment for account A, starts remote control in `ResolvePersisted` mode, serves refresh and websocket connect for account A, then rewrites auth to account B and reloads it, closes the websocket, waits for desired state to become `Disabled`, confirms no new backend contact occurs, and asserts account B has no persisted enrollment row.

**Call relations**: Exercises account-change handling and desired-state resolution across auth transitions.

*Call graph*: calls 11 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, remote_control_auth_dot_json, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json, default (+1 more)); 8 external calls (new, from_millis, from_secs, bind, new, assert_eq!, save_auth, timeout).


##### `remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment`  (lines 2067–2187)

```
async fn remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment()
```

**Purpose**: Checks that a refresh 404 is treated as stale enrollment, causing reenrollment and persisted-row replacement.

**Data flow**: Persists a stale enabled enrollment, starts remote control in `ResolvePersisted` mode, captures the refresh request and current stale environment status, responds `404 Not Found`, captures the subsequent enroll request and serves a new enrollment token, accepts the websocket handshake, waits for refreshed environment status, and asserts sqlite now contains the new server/environment ids with `remote_control_enabled: Some(true)`.

**Call relations**: Covers the explicit stale-enrollment recovery path driven by refresh failure.

*Call graph*: calls 11 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 5 external calls (new, bind, new, assert_eq!, gethostname).


##### `remote_control_http_mode_reenrolls_after_explicit_missing_server_404`  (lines 2190–2334)

```
async fn remote_control_http_mode_reenrolls_after_explicit_missing_server_404()
```

**Purpose**: Ensures that a websocket 404 explicitly indicating a missing remote app server triggers reenrollment and persisted-row replacement.

**Data flow**: Persists a stale enabled enrollment, starts remote control, serves a successful refresh for the stale server, captures the websocket upgrade request and responds with a 404 body indicating `Remote app server not found`, then captures a new enroll request, serves a fresh enrollment token, accepts the next websocket handshake, waits for refreshed environment status, and asserts sqlite now stores the refreshed enrollment with durable enablement preserved.

**Call relations**: Exercises the websocket-side explicit-missing-server detection and reenrollment path.

*Call graph*: calls 11 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener, respond_with_json (+1 more)); 6 external calls (new, bind, new, assert_eq!, gethostname, json!).


##### `remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails`  (lines 2337–2437)

```
async fn remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails()
```

**Purpose**: Verifies that if stale-enrollment detection is followed by failed reenrollment, the old current/persisted enrollment is retained rather than deleted.

**Data flow**: Persists a stale enabled enrollment, starts remote control, responds `404` to refresh, responds `500` to the reenroll attempt, then observes a retry refresh also failing. It finally inspects `remote_handle.current_enrollment` and sqlite to confirm the stale enrollment remains selected and persisted.

**Call relations**: Covers failure-handling semantics that prefer preserving stale state over destructive clearing.

*Call graph*: calls 8 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, remote_control_auth_manager_with_home, remote_control_state_runtime, remote_control_url_for_listener, respond_with_status, test_server_name); 4 external calls (new, bind, new, assert_eq!).


##### `remote_control_http_mode_preserves_enrollment_after_generic_websocket_404`  (lines 2440–2569)

```
async fn remote_control_http_mode_preserves_enrollment_after_generic_websocket_404()
```

**Purpose**: Ensures that a generic websocket 404 without explicit missing-server semantics does not trigger reenrollment or persistence changes.

**Data flow**: Persists a stale enrollment, starts remote control in enabled mode, serves a successful refresh, captures the websocket request and responds with a generic 404 plus request-id/cf-ray headers, reloads the persisted enrollment to confirm it is unchanged, then accepts a later websocket handshake using the same server id and refreshed token and waits for connected status.

**Call relations**: Distinguishes generic websocket failures from explicit stale-server signals.

*Call graph*: calls 13 internal fn (update_persisted_remote_control_enrollment, normalize_remote_control_url, accept_http_request, accept_remote_control_backend_connection, expect_remote_control_status, expect_remote_control_status_snapshot, remote_control_auth_manager_with_home, remote_control_server_token_response, remote_control_state_runtime, remote_control_url_for_listener (+3 more)); 4 external calls (new, bind, new, assert_eq!).


##### `accept_remote_control_connection`  (lines 2585–2593)

```
async fn accept_remote_control_connection(listener: &TcpListener) -> WebSocketStream<TcpStream>
```

**Purpose**: Accepts one incoming websocket connection from the remote-control task and completes a normal server-side websocket handshake.

**Data flow**: Accepts a TCP connection with timeout, passes the stream to `accept_async`, and returns the resulting `WebSocketStream<TcpStream>`.

**Call relations**: Used by tests that only need a websocket connection, not handshake-header capture.

*Call graph*: called by 3 (remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages); 4 external calls (from_secs, accept, timeout, accept_async).


##### `accept_http_request`  (lines 2595–2640)

```
async fn accept_http_request(listener: &TcpListener) -> CapturedHttpRequest
```

**Purpose**: Captures a full HTTP request from the fake backend, including request line, lowercase headers, and body.

**Data flow**: Accepts a TCP connection with timeout, reads the request line, reads headers until the blank line while storing them in a `BTreeMap`, parses `content-length`, reads that many body bytes, converts the body to UTF-8, and returns `CapturedHttpRequest { stream, request_line, headers, body }` with the underlying stream preserved for writing a response.

**Call relations**: Core helper used by nearly every integration test to inspect enroll, refresh, and failed websocket-upgrade requests.

*Call graph*: called by 14 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_preserves_stale_enrollment_when_reenrollment_fails, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks (+4 more)); 8 external calls (new, new, from_secs, from_utf8, new, accept, timeout, vec!).


##### `respond_with_json`  (lines 2642–2653)

```
async fn respond_with_json(mut stream: TcpStream, body: serde_json::Value)
```

**Purpose**: Writes a simple HTTP 200 JSON response on a captured test stream.

**Data flow**: Serializes the JSON body to string, formats an HTTP response with content type, content length, and `connection: close`, writes it to the stream, and flushes.

**Call relations**: Used by fake backend handlers for successful enroll, refresh, and management responses.

*Call graph*: called by 13 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_handle_enable_disable_stops_and_restarts_connections, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages (+3 more)); 4 external calls (flush, write_all, to_string, format!).


##### `respond_with_status`  (lines 2655–2657)

```
async fn respond_with_status(stream: TcpStream, status: &str, body: &str)
```

**Purpose**: Writes an HTTP response with an arbitrary status line and plain-text body.

**Data flow**: Delegates to `respond_with_status_and_headers` with no extra headers.

**Call relations**: Convenience wrapper used by tests simulating backend failures.

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

**Purpose**: Writes an HTTP response with arbitrary status, extra headers, and plain-text body.

**Data flow**: Formats the supplied headers into HTTP lines, builds a response string with content type, content length, connection close, extra headers, and body, writes it to the stream, and flushes.

**Call relations**: Used when tests need to simulate backend errors carrying request-id or cf-ray headers.

*Call graph*: called by 2 (remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, respond_with_status); 3 external calls (flush, write_all, format!).


##### `accept_remote_control_backend_connection`  (lines 2680–2723)

```
async fn accept_remote_control_backend_connection(
    listener: &TcpListener,
) -> (CapturedWebSocketRequest, WebSocketStream<TcpStream>)
```

**Purpose**: Accepts a websocket connection while capturing the incoming handshake path and headers for assertions.

**Data flow**: Accepts a TCP connection with timeout, installs an `accept_hdr_async` callback that copies the request URI path and lowercase headers into a shared `CapturedWebSocketRequest`, completes the websocket handshake, then returns the captured request plus the `WebSocketStream`.

**Call relations**: Used by tests that need to assert websocket authorization, server-id, protocol-version, or installation-id headers.

*Call graph*: called by 10 (persisted_enable_does_not_follow_auth_to_an_account_without_a_preference, remote_control_http_mode_enrolls_before_connecting, remote_control_http_mode_preserves_enrollment_after_generic_websocket_404, remote_control_http_mode_reenrolls_after_explicit_missing_server_404, remote_control_http_mode_reenrolls_when_refresh_reports_stale_enrollment, remote_control_http_mode_refreshes_persisted_enrollment_before_connecting, remote_control_stdio_mode_waits_for_client_name_before_connecting, remote_control_transport_reconnects_after_disconnect, remote_control_transport_refreshes_server_token_after_websocket_unauthorized, remote_control_waits_for_account_id_before_enrolling); 6 external calls (new, from_secs, accept, new, timeout, accept_hdr_async).


##### `send_client_event`  (lines 2725–2734)

```
async fn send_client_event(
    websocket: &mut WebSocketStream<TcpStream>,
    client_envelope: ClientEnvelope,
)
```

**Purpose**: Serializes a `ClientEnvelope` and sends it as a text websocket frame to the remote-control task.

**Data flow**: Converts the envelope to a JSON string, wraps it in `tungstenite::Message::Text`, sends it on the mutable websocket stream, and returns unit.

**Call relations**: Shared helper for transport tests that inject backend-originated client events.

*Call graph*: called by 4 (remote_control_http_mode_enrolls_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages, remote_control_transport_reconnects_after_disconnect); 3 external calls (send, to_string, Text).


##### `read_server_event`  (lines 2736–2738)

```
async fn read_server_event(websocket: &mut WebSocketStream<TcpStream>) -> serde_json::Value
```

**Purpose**: Reads the next server event from the websocket and returns only the JSON payload without the stream id.

**Data flow**: Delegates to `read_server_event_with_stream_id` and returns the first tuple element.

**Call relations**: Convenience wrapper for tests that do not need the stream id.

*Call graph*: calls 1 internal fn (read_server_event_with_stream_id).


##### `read_server_event_with_stream_id`  (lines 2740–2779)

```
async fn read_server_event_with_stream_id(
    websocket: &mut WebSocketStream<TcpStream>,
) -> (serde_json::Value, StreamId)
```

**Purpose**: Reads websocket frames until it finds a text server event, extracts and removes `stream_id`, and returns both the remaining JSON object and the parsed `StreamId`.

**Data flow**: Loops on `websocket.next()` under timeout. For text frames it parses JSON, removes `stream_id` from the object, converts it to `StreamId`, and returns `(event_json, stream_id)`. For ping frames it sends a pong reply; pong and raw frame variants are ignored; close or binary frames cause panic.

**Call relations**: Used by tests that need to inspect outbound server events and sometimes acknowledge them using the returned stream id.

*Call graph*: called by 2 (read_server_event, remote_control_transport_clears_outgoing_buffer_when_backend_acks); 8 external calls (from_secs, next, send, new, panic!, from_str, timeout, Pong).


### `stdio-to-uds/tests/stdio_to_uds.rs`

`test` · `integration test of the built bridge binary`

This integration test exercises the bridge as an external process rather than calling the library directly. It creates a temporary directory, writes a fixed request payload to a file that will become the child process’s stdin, and binds a `codex_uds::UnixListener` at a socket path inside that directory. The server side runs in a Tokio task and intentionally reads exactly `request.len()` bytes instead of waiting for EOF, avoiding races around half-close behavior on slower runners. It records progress messages through an `mpsc` channel so failures can report whether the server accepted, read, or wrote before the child stalled.

The child process is spawned with `std::process::Command` using the built `codex-stdio-to-uds` binary, with piped stdout/stderr and stdin redirected from the request file. Separate OS threads drain stdout and stderr to completion so the parent can poll process exit without blocking. A manual timeout loop polls `try_wait()` for up to five seconds, collecting server events along the way; on timeout it kills the child and includes server events plus stderr in the failure message. Successful completion requires a zero exit status, child stdout equal to `b"response"`, and server-observed request bytes equal to the original `b"request"`. Permission-denied socket binding is treated as a skip rather than a hard failure.

#### Function details

##### `pipes_stdin_and_stdout_through_socket`  (lines 18–157)

```
async fn pipes_stdin_and_stdout_through_socket() -> anyhow::Result<()>
```

**Purpose**: Runs a full request/response exchange through the `codex-stdio-to-uds` executable and verifies that child stdin reaches the socket server and server output reaches child stdout. It also includes robust timeout and diagnostics handling for flaky environments.

**Data flow**: The test creates a temp directory and request fixture file, binds a Unix listener, and if binding fails with `PermissionDenied` prints a skip message and returns `Ok(())`. It spawns a Tokio server task that accepts one connection, reads exactly the request length, writes `response`, and returns the received bytes while sending progress events over an `mpsc` channel. In parallel it runs a blocking child-management task that spawns the compiled binary with the socket path, redirects stdin from the fixture file, drains stdout/stderr on helper threads, polls for exit with a 5-second deadline, kills on timeout, and returns collected status/output/events. The test then asserts successful exit, exact stdout bytes, and exact server-received request bytes.

**Call relations**: This async integration test is invoked by the test runner and exercises the binary end-to-end through `std::process::Command`. It indirectly validates `stdio-to-uds/src/main.rs` argument handling and `stdio-to-uds/src/lib.rs::run` relay behavior under real socket I/O.

*Call graph*: calls 1 internal fn (bind); 11 external calls (Ok, assert!, assert_eq!, eprintln!, format!, channel, write, new, spawn, spawn_blocking (+1 more)).


### Sandbox policy and Linux execution
This section organizes sandbox policy-generation tests first, then the Linux sandbox helper and end-to-end sandbox execution suites that consume those policies.

### `sandboxing/src/manager_tests.rs`

`test` · `cross-cutting; exercised during unit test runs for sandbox selection and transform logic`

This file is a focused unit-test suite for the sandbox manager layer. The tests build real `SandboxTransformRequest` values around `SandboxCommand`, `PermissionProfile`, `FileSystemSandboxPolicy`, and `NetworkSandboxPolicy`, then assert on the exact `SandboxType` or transformed execution request produced. Several tests cover initial sandbox selection: unrestricted filesystem access with no managed-network requirement should stay at `SandboxType::None`, while either managed-network requirements or a restricted filesystem policy should push selection toward `get_platform_sandbox(...)` when available. The transformation tests are more detailed: they confirm that `SandboxManager::transform` preserves unrestricted filesystem policy when only network is restricted, upgrades an `External` permission profile’s network policy when `additional_permissions` explicitly enable network, and merges additional writable roots without dropping pre-existing `Deny` entries from a restricted filesystem policy.

A separate test validates `with_managed_mitm_ca_readable_root`, ensuring a managed CA bundle path is appended as a readable filesystem root for restricted sandboxes. Linux-only tests cover two distinct behaviors: `ensure_linux_bubblewrap_is_supported` must reject bubblewrap-dependent paths on WSL1 while allowing non-bubblewrap cases, and Linux seccomp transformation must set `arg0` either to the helper executable path itself or to the alias `codex-linux-sandbox` when the launcher path is not already the helper name. Temporary directories are canonicalized before use so assertions compare normalized absolute paths rather than unstable temp-path representations.

#### Function details

##### `danger_full_access_defaults_to_no_sandbox_without_network_requirements`  (lines 27–37)

```
fn danger_full_access_defaults_to_no_sandbox_without_network_requirements()
```

**Purpose**: Verifies the baseline selection rule for a fully unrestricted filesystem policy with no managed-network requirement. In that case, automatic sandbox selection should resolve to `SandboxType::None` rather than forcing a platform sandbox.

**Data flow**: Creates a fresh `SandboxManager`, passes `FileSystemSandboxPolicy::unrestricted()`, `NetworkSandboxPolicy::Enabled`, `SandboxablePreference::Auto`, `WindowsSandboxLevel::Disabled`, and `has_managed_network_requirements = false` into `select_initial`, then compares the returned `SandboxType` against `SandboxType::None`. It reads no external state beyond whatever defaults `SandboxManager::new()` encapsulates and writes no persistent state.

**Call relations**: This is a standalone test entry invoked by the Rust test harness. It directly exercises `SandboxManager::select_initial` on the simplest permissive path and does not delegate to any local helper.

*Call graph*: calls 2 internal fn (unrestricted, new); 1 external calls (assert_eq!).


##### `danger_full_access_uses_platform_sandbox_with_network_requirements`  (lines 40–52)

```
fn danger_full_access_uses_platform_sandbox_with_network_requirements()
```

**Purpose**: Checks that unrestricted filesystem access no longer implies no sandbox when managed-network requirements are present. The expected result is the platform-specific sandbox returned by `get_platform_sandbox`, falling back to `None` if the platform has no sandbox implementation.

**Data flow**: Builds a `SandboxManager`, computes `expected` from `get_platform_sandbox(false).unwrap_or(SandboxType::None)`, then calls `select_initial` with unrestricted filesystem access, enabled network, automatic preference, disabled Windows sandbox level, and `has_managed_network_requirements = true`. The test asserts that the selected sandbox equals the computed platform expectation.

**Call relations**: The test harness invokes this test directly. It couples `select_initial` to `get_platform_sandbox` semantically by deriving the expected value from the same platform capability query used elsewhere in the subsystem.

*Call graph*: calls 2 internal fn (unrestricted, new); 2 external calls (assert_eq!, get_platform_sandbox).


##### `restricted_file_system_uses_platform_sandbox_without_managed_network`  (lines 55–72)

```
fn restricted_file_system_uses_platform_sandbox_without_managed_network()
```

**Purpose**: Confirms that a restricted filesystem policy alone is enough to trigger platform sandbox selection, even when there are no managed-network requirements. The test uses a minimal restricted policy that grants read access to the special root path.

**Data flow**: Constructs a restricted `FileSystemSandboxPolicy` containing one `FileSystemSandboxEntry` for `FileSystemSpecialPath::Root` with `FileSystemAccessMode::Read`, computes the expected platform sandbox via `get_platform_sandbox(false).unwrap_or(SandboxType::None)`, and passes the policy into `select_initial` with enabled network, automatic preference, disabled Windows sandboxing, and `has_managed_network_requirements = false`. It asserts equality between the returned and expected `SandboxType`.

**Call relations**: This test is another direct test-harness entry. It complements the unrestricted-policy tests by proving that filesystem restriction itself changes the selection branch inside `select_initial`.

*Call graph*: calls 2 internal fn (restricted, new); 3 external calls (assert_eq!, get_platform_sandbox, vec!).


##### `transform_preserves_unrestricted_file_system_policy_for_restricted_network`  (lines 75–114)

```
fn transform_preserves_unrestricted_file_system_policy_for_restricted_network()
```

**Purpose**: Validates that transforming a command under restricted network permissions does not accidentally tighten an unrestricted filesystem policy. It also checks that path-like fields are converted from `PathUri` back into absolute filesystem paths correctly.

**Data flow**: Reads the current working directory into an `AbsolutePathBuf`, converts it to `PathUri`, derives a `PermissionProfile` from unrestricted filesystem plus restricted network, and builds a `SandboxTransformRequest` with `SandboxType::None` and no additional permissions. After `manager.transform(...)`, it asserts that the resulting execution request keeps `cwd` and `sandbox_policy_cwd` equal to the original absolute cwd, preserves `FileSystemSandboxPolicy::unrestricted()`, and keeps `NetworkSandboxPolicy::Restricted`.

**Call relations**: The Rust test harness invokes this test directly. It drives `SandboxManager::transform` through the no-sandbox path and inspects the transformed request rather than only the high-level permission profile.

*Call graph*: calls 5 internal fn (from_runtime_permissions, unrestricted, new, current_dir, from_abs_path); 3 external calls (new, new, assert_eq!).


##### `transform_additional_permissions_enable_network_for_external_sandbox`  (lines 117–168)

```
fn transform_additional_permissions_enable_network_for_external_sandbox()
```

**Purpose**: Checks that `additional_permissions` can widen an external permission profile’s network access and that the transformed request reflects the widened policy. It specifically covers the case where the base profile is `PermissionProfile::External { network: Restricted }`.

**Data flow**: Creates a current-directory `PathUri`, starts from `PermissionProfile::External { network: Restricted }`, allocates and canonicalizes a temporary directory into an `AbsolutePathBuf`, and embeds `AdditionalPermissionProfile` with `network.enabled = true` plus filesystem roots from `FileSystemPermissions::from_read_write_roots`. It passes these into `SandboxManager::transform` and asserts that both `exec_request.permission_profile` and `exec_request.network_sandbox_policy` become `Enabled`.

**Call relations**: This test is called directly by the test harness. It exercises the merge logic inside `transform`, specifically the branch where command-scoped additional permissions override or augment an externally supplied permission profile.

*Call graph*: calls 5 internal fn (from_read_write_roots, new, current_dir, from_absolute_path, from_abs_path); 6 external calls (new, new, new, assert_eq!, canonicalize, vec!).


##### `transform_additional_permissions_preserves_denied_entries`  (lines 171–250)

```
fn transform_additional_permissions_preserves_denied_entries()
```

**Purpose**: Ensures that adding writable filesystem roots through `additional_permissions` does not erase explicit deny rules already present in a restricted filesystem policy. The test verifies exact ordering and contents of the merged sandbox entries.

**Data flow**: Creates canonicalized temporary workspace paths, derives `allowed_path` and `denied_path`, builds a restricted filesystem policy containing a readable root special path and a `Deny` entry for `denied_path`, then converts that policy plus restricted network into a `PermissionProfile`. It submits a transform request whose `additional_permissions.file_system` adds `allowed_path` as writable. The returned execution request is asserted to contain the original read-root entry, the original deny entry for `denied_path`, and a new write entry for `allowed_path`, while leaving network policy restricted.

**Call relations**: The test harness invokes this test directly. It targets the policy-merging branch of `SandboxManager::transform`, proving that additive permissions are appended without weakening existing deny constraints.

*Call graph*: calls 7 internal fn (from_read_write_roots, from_runtime_permissions, restricted, new, current_dir, from_absolute_path, from_abs_path); 7 external calls (default, new, new, new, assert_eq!, canonicalize, vec!).


##### `managed_mitm_ca_bundle_becomes_readable_for_restricted_sandbox`  (lines 253–292)

```
fn managed_mitm_ca_bundle_becomes_readable_for_restricted_sandbox()
```

**Purpose**: Verifies that a managed MITM CA bundle path is injected as a readable filesystem root when a restricted permission profile is adjusted for managed networking. This protects TLS interception support from being blocked by the sandbox’s own filesystem restrictions.

**Data flow**: Creates canonicalized temporary directories for the cwd and a managed bundle location, builds a restricted `PermissionProfile` that initially allows only read access to the cwd, then passes that profile plus `Some(&managed_bundle_path)` and the cwd path into `with_managed_mitm_ca_readable_root`. It converts the resulting profile back to runtime permissions and asserts that the filesystem policy now contains both the original cwd read entry and a new read entry for the CA bundle path.

**Call relations**: This test is a direct test-harness entry. Rather than going through `SandboxManager::transform`, it isolates the helper `with_managed_mitm_ca_readable_root` to validate its policy-rewriting behavior independently.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, from_absolute_path); 5 external calls (new, assert_eq!, canonicalize, with_managed_mitm_ca_readable_root, vec!).


##### `transform_linux_seccomp_request`  (lines 295–322)

```
fn transform_linux_seccomp_request(
    codex_linux_sandbox_exe: &std::path::Path,
) -> super::SandboxExecRequest
```

**Purpose**: Provides a Linux-only helper that constructs a transformed execution request for `SandboxType::LinuxSeccomp`. It centralizes the common setup used by the two helper-path assertions below.

**Data flow**: Accepts a `&std::path::Path` pointing to the Linux sandbox helper executable, reads the current directory, converts it to `PathUri`, uses `PermissionProfile::Disabled`, and builds a `SandboxTransformRequest` with `sandbox = SandboxType::LinuxSeccomp`, `codex_linux_sandbox_exe = Some(...)`, and other flags disabled. It returns the successful `SandboxExecRequest` produced by `SandboxManager::transform`.

**Call relations**: This helper is not a test itself; it is called by `transform_linux_seccomp_preserves_helper_path_in_arg0_when_available` and `transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path` to avoid duplicating Linux seccomp request construction.

*Call graph*: calls 3 internal fn (new, current_dir, from_abs_path); called by 2 (transform_linux_seccomp_preserves_helper_path_in_arg0_when_available, transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path); 2 external calls (new, new).


##### `wsl1_rejects_linux_bubblewrap_path`  (lines 326–361)

```
fn wsl1_rejects_linux_bubblewrap_path()
```

**Purpose**: Asserts that WSL1 rejects every bubblewrap-dependent Linux sandbox path the subsystem can take. It covers restricted filesystem mode, unrestricted mode with proxy-network allowance, and unrestricted mode with legacy landlock enabled.

**Data flow**: Builds a restricted filesystem policy with a readable root special path, then calls `ensure_linux_bubblewrap_is_supported` three times with `is_wsl1 = true` and varying combinations of filesystem restriction, `use_legacy_landlock`, and `allow_network_for_proxy`. Each result is matched against `Err(super::SandboxTransformError::Wsl1UnsupportedForBubblewrap)`.

**Call relations**: This Linux-only test is invoked directly by the test harness. It probes the preflight validation helper rather than full request transformation, ensuring unsupported environments fail early and consistently.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert!, vec!).


##### `wsl1_allows_non_bubblewrap_linux_paths`  (lines 365–391)

```
fn wsl1_allows_non_bubblewrap_linux_paths()
```

**Purpose**: Checks the complementary WSL1 behavior: Linux execution paths that do not require bubblewrap should still be accepted. It demonstrates both unrestricted/no-proxy and restricted/legacy-landlock combinations that remain valid.

**Data flow**: First calls `ensure_linux_bubblewrap_is_supported` with unrestricted filesystem, no legacy landlock, no proxy-network allowance, and `is_wsl1 = true`, asserting success. Then it constructs a restricted readable-root policy and calls the same helper with `use_legacy_landlock = true`, `allow_network_for_proxy = false`, and `is_wsl1 = true`, again asserting `is_ok()`.

**Call relations**: The test harness invokes this Linux-only test directly. It pairs with `wsl1_rejects_linux_bubblewrap_path` to define the exact boundary between forbidden bubblewrap paths and acceptable non-bubblewrap paths.

*Call graph*: calls 1 internal fn (restricted); 2 external calls (assert!, vec!).


##### `transform_linux_seccomp_preserves_helper_path_in_arg0_when_available`  (lines 395–403)

```
fn transform_linux_seccomp_preserves_helper_path_in_arg0_when_available()
```

**Purpose**: Verifies that Linux seccomp transformation preserves the helper executable path in `arg0` when the launcher path already points at the dedicated helper binary. This ensures downstream process invocation can expose the helper’s real executable name.

**Data flow**: Creates a `PathBuf` for `/tmp/codex-linux-sandbox`, passes it into `transform_linux_seccomp_request`, and asserts that the returned `SandboxExecRequest.arg0` is `Some` containing that exact path string. It performs no mutation beyond constructing local values.

**Call relations**: This Linux-only test is called by the test harness and delegates all request construction to `transform_linux_seccomp_request`, focusing solely on the `arg0` postcondition.

*Call graph*: calls 1 internal fn (transform_linux_seccomp_request); 2 external calls (assert_eq!, from).


##### `transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path`  (lines 407–412)

```
fn transform_linux_seccomp_uses_helper_alias_when_launcher_is_not_helper_path()
```

**Purpose**: Checks the fallback naming behavior for Linux seccomp launches when the provided executable path is not itself the helper binary. In that case, `arg0` should be normalized to the alias `codex-linux-sandbox`.

**Data flow**: Builds a `PathBuf` for `/tmp/codex`, feeds it to `transform_linux_seccomp_request`, and asserts that the resulting `SandboxExecRequest.arg0` equals `Some("codex-linux-sandbox".to_string())`. The function only reads the helper result and performs an equality assertion.

**Call relations**: This Linux-only test is invoked directly by the test harness. Like the preceding test, it relies on `transform_linux_seccomp_request` for setup and isolates one branch of `arg0` normalization logic.

*Call graph*: calls 1 internal fn (transform_linux_seccomp_request); 2 external calls (assert_eq!, from).


### `sandboxing/src/landlock_tests.rs`

`test` · `test execution`

This compact test module validates the command-line assembly rules in `landlock.rs`. Rather than executing a sandbox helper, it inspects the returned `Vec<String>` values directly to ensure the helper would be invoked with the intended flags.

`legacy_landlock_flag_is_included_when_requested` compares two invocations of the private non-profile builder: one with `use_legacy_landlock` false and one with it true, confirming the `--use-legacy-landlock` flag appears only in the latter. `proxy_flag_takes_precedence_over_legacy_landlock` uses the profile-based builder with both booleans set and asserts that `--allow-network-for-proxy` is present while `--use-legacy-landlock` is absent, documenting the precedence rule that proxy networking requires bubblewrap rather than legacy landlock.

`permission_profile_flag_is_included` checks that the profile-based builder emits a non-empty value immediately after `--permission-profile` and also preserves the exact `--command-cwd` value. Finally, `proxy_network_requires_managed_requirements` verifies the tiny policy helper `allow_network_for_proxy` simply mirrors the managed-network enforcement flag. Together these tests pin down the helper CLI shape and prevent regressions in argument ordering or mutually exclusive flag behavior.

#### Function details

##### `legacy_landlock_flag_is_included_when_requested`  (lines 5–33)

```
fn legacy_landlock_flag_is_included_when_requested()
```

**Purpose**: Verifies that the non-profile sandbox argv builder includes `--use-legacy-landlock` only when explicitly requested.

**Data flow**: Creates a one-element command vector and two path values, calls `create_linux_sandbox_command_args` once with legacy mode off and once with it on, and asserts the first result does not contain `--use-legacy-landlock` while the second does.

**Call relations**: This test directly exercises the private helper's conditional flag insertion logic for the legacy-landlock branch.

*Call graph*: 3 external calls (new, assert_eq!, vec!).


##### `proxy_flag_takes_precedence_over_legacy_landlock`  (lines 36–55)

```
fn proxy_flag_takes_precedence_over_legacy_landlock()
```

**Purpose**: Checks that enabling proxy networking suppresses the legacy-landlock flag even when legacy mode is also requested.

**Data flow**: Builds a command vector, paths, and a read-only `PermissionProfile`, calls `create_linux_sandbox_command_args_for_permission_profile` with both booleans true, and asserts the returned args contain `--allow-network-for-proxy` but not `--use-legacy-landlock`.

**Call relations**: This test targets the precedence rule implemented in the exported profile-based builder.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (new, assert_eq!, vec!).


##### `permission_profile_flag_is_included`  (lines 58–83)

```
fn permission_profile_flag_is_included()
```

**Purpose**: Ensures the profile-based argv builder emits both the serialized permission-profile flag and the expected command-cwd pair.

**Data flow**: Creates a command vector, paths, and a read-only `PermissionProfile`, builds args with proxy networking off, then scans adjacent windows of the returned vector to assert there is a non-empty value after `--permission-profile` and that `--command-cwd` is followed by `/tmp/link`.

**Call relations**: This test validates the core CLI shape of the exported builder, especially the presence and placement of required argument pairs.

*Call graph*: calls 1 internal fn (read_only); 3 external calls (new, assert_eq!, vec!).


##### `proxy_network_requires_managed_requirements`  (lines 86–95)

```
fn proxy_network_requires_managed_requirements()
```

**Purpose**: Verifies that `allow_network_for_proxy` returns false without managed-network enforcement and true with it.

**Data flow**: Calls `allow_network_for_proxy(false)` and `allow_network_for_proxy(true)` and asserts the returned booleans are false and true respectively.

**Call relations**: This is a direct unit test of the small policy helper used by higher-level sandbox launch code.

*Call graph*: 1 external calls (assert_eq!).


### `sandboxing/src/seatbelt_tests.rs`

`test` · `test execution`

The file is a dense set of unit and integration-style tests around the Seatbelt policy builder exposed by the parent module. It exercises three main areas: static base policy contents, dynamic network policy generation, and filesystem/write carveout behavior for protected repository metadata such as `.git`, `.codex`, and `.agents`. Small helpers extract the `-p` inline policy from generated argument vectors, convert string literals into `AbsolutePathBuf`, and build the regex fragments expected to deny writes to protected metadata names under writable roots. `assert_seatbelt_denied` normalizes stderr checks for actual sandbox failures.

A lightweight `TestConfigReloader` implements `codex_network_proxy::ConfigReloader` so tests can construct a `NetworkProxyState` without needing a real reload source. Many tests inspect generated policy strings directly for exact Seatbelt clauses, parameter names like `WRITABLE_ROOT_0_EXCLUDED_1` and `UNIX_SOCKET_PATH_0`, newline termination, canonicalization, deduplication, and fail-closed behavior when proxy configuration exists but no usable endpoints are available.

The most concrete tests create temporary repositories, initialize Git state, generate Seatbelt-wrapped shell commands, and run them through `MACOS_PATH_TO_SEATBELT_EXECUTABLE`. Those tests prove that writes into `.codex/config.toml`, `.git/hooks`, `.git` pointer files, and gitdir configs are blocked while ordinary files in otherwise writable roots still succeed. `populate_tmpdir` builds the reusable fixture layout with canonical paths so assertions can match exact `-D...` parameter definitions.

#### Function details

##### `assert_seatbelt_denied`  (lines 40–48)

```
fn assert_seatbelt_denied(stderr: &[u8], path: &Path)
```

**Purpose**: Checks that a failed sandboxed command produced the expected macOS denial stderr for a specific path. It accepts either the shell-level `Operation not permitted` message or the earlier `sandbox_apply` failure form.

**Data flow**: Takes raw stderr bytes and the denied `Path`; converts stderr with `String::from_utf8_lossy`, formats the expected `bash: <path>: Operation not permitted` string, and asserts that stderr exactly matches that string or contains the sandbox-apply denial text. It returns no value and only fails the test on mismatch.

**Call relations**: This helper is invoked by the end-to-end write-blocking tests after running `sandbox-exec`, so those tests can focus on setup and file assertions while delegating stderr normalization to one place.

*Call graph*: called by 2 (create_seatbelt_args_with_read_only_git_and_codex_subpaths, create_seatbelt_args_with_read_only_git_pointer_file); 3 external calls (from_utf8_lossy, assert!, format!).


##### `absolute_path`  (lines 50–52)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an `AbsolutePathBuf` from a string literal used in test fixtures. It enforces that the provided path is already absolute.

**Data flow**: Accepts `&str`, wraps it in `Path::new`, passes it to `AbsolutePathBuf::from_absolute_path`, and panics with `expect("absolute path")` if validation fails. It returns the validated absolute-path wrapper.

**Call relations**: Used by tests that construct `FileSystemSandboxPolicy` entries or Unix-socket allowlists, ensuring those tests feed the production APIs the exact absolute-path type they require.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 2 (explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access, explicit_unreadable_paths_are_excluded_from_readable_roots); 1 external calls (new).


##### `seatbelt_policy_arg`  (lines 54–61)

```
fn seatbelt_policy_arg(args: &[String]) -> &str
```

**Purpose**: Extracts the inline Seatbelt policy text from a generated command-argument vector. It assumes the policy is passed after `-p`.

**Data flow**: Reads a `&[String]`, finds the index of `"-p"`, then returns the following string slice as `&str`. It panics if either the flag or policy text is missing.

**Call relations**: Many tests call this immediately after `create_seatbelt_command_args` or the legacy variant to inspect the exact generated policy body without re-parsing the whole command line.

*Call graph*: called by 7 (create_seatbelt_args_allowlists_explicit_unix_socket_paths_without_proxy, create_seatbelt_args_block_first_time_dot_codex_creation_with_metadata_name_regex, create_seatbelt_args_for_cwd_as_git_repo, create_seatbelt_args_preserves_full_network_with_explicit_unix_socket_paths, create_seatbelt_args_with_read_only_git_and_codex_subpaths, explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access, explicit_unreadable_paths_are_excluded_from_readable_roots).


##### `seatbelt_protected_metadata_name_requirements`  (lines 63–81)

```
fn seatbelt_protected_metadata_name_requirements(root: &Path) -> String
```

**Purpose**: Constructs the exact regex-based `require-not` fragments expected to block protected metadata names beneath a writable root. It mirrors the production policy shape closely enough for string containment assertions.

**Data flow**: Takes a root `Path`, stringifies it lossily, strips trailing slashes except for `/`, regex-escapes the root and each entry in `PROTECTED_METADATA_PATH_NAMES`, and joins the resulting `(require-not (regex ...))` clauses into one space-separated `String`. It returns that assembled policy fragment.

**Call relations**: This helper is used only inside tests that verify writable-root carveouts and first-time metadata creation protections, letting those tests compare generated policy text against the same protected-name set used by the protocol layer.

*Call graph*: 5 external calls (ends_with, len, pop, to_string_lossy, escape).


##### `TestConfigReloader::source_label`  (lines 86–88)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a fixed human-readable label for the fake config reloader used in proxy-related tests.

**Data flow**: Reads no external state and returns the constant string `seatbelt test config` as an owned `String`.

**Call relations**: It satisfies the `ConfigReloader` trait so `NetworkProxyState::with_reloader` can be instantiated in tests that need a realistic proxy object.


##### `TestConfigReloader::maybe_reload`  (lines 90–92)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements the non-forcing reload path for the fake reloader by always reporting that no new config is available.

**Data flow**: Takes `&self`, returns a boxed async future pinned with `Box::pin`, and resolves to `Ok(None)` without reading or mutating any state.

**Call relations**: This trait method exists only to make the test proxy state complete; the merge test constructs a `NetworkProxy` around it but does not depend on actual reload behavior.

*Call graph*: 1 external calls (pin).


##### `TestConfigReloader::reload_now`  (lines 94–96)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Implements the forced reload path for the fake reloader by always failing. This makes it explicit that the test fixture is static.

**Data flow**: Takes `&self`, returns a pinned async future, and resolves to an `Err(anyhow!("seatbelt test config cannot reload"))`. It writes no state.

**Call relations**: Like `maybe_reload`, this is trait plumbing for constructing `NetworkProxyState`; it documents that tests should not expect live config refresh.

*Call graph*: 2 external calls (pin, anyhow!).


##### `base_policy_allows_node_cpu_sysctls`  (lines 100–109)

```
fn base_policy_allows_node_cpu_sysctls()
```

**Purpose**: Verifies that the static base Seatbelt policy permits the specific sysctl lookups Node uses for `os.cpus()`.

**Data flow**: Reads the `MACOS_SEATBELT_BASE_POLICY` constant and asserts it contains clauses for `machdep.cpu.brand_string` and `hw.model`. It returns nothing.

**Call relations**: This is a pure regression test over the base policy constant, guarding against accidental removal of CPU-identification allowances.

*Call graph*: 1 external calls (assert!).


##### `base_policy_allows_kmp_registration_shm_read_create_and_unlink`  (lines 112–122)

```
fn base_policy_allows_kmp_registration_shm_read_create_and_unlink()
```

**Purpose**: Checks that the base policy includes the narrowly scoped POSIX shared-memory allowance needed for KMP registration.

**Data flow**: Builds the expected multiline policy snippet as a raw string and asserts that `MACOS_SEATBELT_BASE_POLICY` contains it. No state is modified.

**Call relations**: Another constant-level regression test, focused on preserving a precise allowlist rather than broad shared-memory access.

*Call graph*: 1 external calls (assert!).


##### `create_seatbelt_args_routes_network_through_proxy_ports`  (lines 125–161)

```
fn create_seatbelt_args_routes_network_through_proxy_ports()
```

**Purpose**: Confirms that when proxy ports are configured, dynamic network policy allows only those localhost endpoints and stays otherwise restricted.

**Data flow**: Creates a read-only `SandboxPolicy`, a `ProxyPolicyInputs` with ports `43128` and `48081`, proxy config enabled, and local binding disabled; passes them to `dynamic_network_policy`; then asserts the returned policy string contains per-port outbound rules and omits blanket outbound, bind, inbound, and DNS allowances.

**Call relations**: This test exercises the proxy-aware branch of `dynamic_network_policy`, specifically the case where managed routing should be narrowed to explicit proxy sockets.

*Call graph*: 5 external calls (new_read_only_policy, assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_allows_tls_without_darwin_user_cache_write`  (lines 164–184)

```
fn dynamic_network_policy_allows_tls_without_darwin_user_cache_write()
```

**Purpose**: Verifies that network-enabled policy still permits trustd access for TLS validation without granting broad writes to the Darwin user cache.

**Data flow**: Builds a `SandboxPolicy::WorkspaceWrite` with network access enabled, calls `dynamic_network_policy` with default proxy inputs, and asserts the resulting string contains the `com.apple.trustd.agent` allowance but not `DARWIN_USER_CACHE_DIR`.

**Call relations**: This test covers a subtle compatibility/security balance in network policy generation: enough access for certificate verification, but no unrelated cache-write expansion.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access`  (lines 187–257)

```
fn explicit_unreadable_paths_are_excluded_from_full_disk_read_and_write_access()
```

**Purpose**: Checks that an explicit deny path is carved out of a broad root-level write policy for both read and write permissions, including metadata-name protections.

**Data flow**: Constructs a restricted `FileSystemSandboxPolicy` with `/` writable and `/tmp/codex-unreadable` denied, generates Seatbelt args via `create_seatbelt_command_args`, extracts the policy text, computes unreadable roots from the policy, and asserts both policy fragments and `-DREADABLE_ROOT...` / `-DWRITABLE_ROOT...` definitions include the deny carveouts and `/.codex` exclusion. It returns nothing.

**Call relations**: This test drives the full command-arg generator rather than only string helpers, validating how filesystem policy entries become Seatbelt parameters and exclusion clauses.

*Call graph*: calls 3 internal fn (restricted, absolute_path, seatbelt_policy_arg); 5 external calls (new, assert!, assert_eq!, create_seatbelt_command_args, vec!).


##### `explicit_unreadable_paths_are_excluded_from_readable_roots`  (lines 260–308)

```
fn explicit_unreadable_paths_are_excluded_from_readable_roots()
```

**Purpose**: Verifies that a deny subpath is excluded from an otherwise readable root in generated Seatbelt policy and parameter definitions.

**Data flow**: Builds a restricted filesystem policy with `/tmp/codex-readable` readable and `/tmp/codex-readable/private` denied, generates args, extracts policy text, computes readable and unreadable roots, and asserts the policy contains `READABLE_ROOT_0_EXCLUDED_0` carveouts and the args contain both the readable root and excluded unreadable path definitions.

**Call relations**: This is the read-only analogue of the broader root-write carveout test, ensuring deny entries survive root aggregation.

*Call graph*: calls 3 internal fn (restricted, absolute_path, seatbelt_policy_arg); 4 external calls (new, assert!, create_seatbelt_command_args, vec!).


##### `unreadable_globstar_slash_matches_zero_or_more_directories`  (lines 311–321)

```
fn unreadable_globstar_slash_matches_zero_or_more_directories()
```

**Purpose**: Tests the glob-to-regex translation for `**/` so it matches files in the root directory and in arbitrarily nested subdirectories.

**Data flow**: Calls `seatbelt_regex_for_unreadable_glob` with `/tmp/repo/**/*.env`, asserts the exact regex string, compiles it with `regex_lite::Regex`, and checks positive and negative path matches.

**Call relations**: This is a focused unit test for the unreadable-glob translation logic, guarding the semantics of recursive directory matching.

*Call graph*: 4 external calls (assert!, assert_eq!, new, seatbelt_regex_for_unreadable_glob).


##### `unreadable_globs_use_git_style_component_matching`  (lines 324–337)

```
fn unreadable_globs_use_git_style_component_matching()
```

**Purpose**: Verifies that single-component glob syntax like `*`, character classes, and `?` are translated with Git-style path-component boundaries.

**Data flow**: Generates a regex from `/tmp/repo/*/file[0-9]?.txt`, asserts the exact regex text, compiles it, and checks that only one-level-deep matching with the expected filename shape succeeds.

**Call relations**: This test complements the `**` case by validating non-recursive component matching behavior in the glob translator.

*Call graph*: 4 external calls (assert!, assert_eq!, new, seatbelt_regex_for_unreadable_glob).


##### `unreadable_globs_treat_unclosed_character_classes_as_literals`  (lines 340–349)

```
fn unreadable_globs_treat_unclosed_character_classes_as_literals()
```

**Purpose**: Ensures malformed glob character classes are treated literally instead of producing broken or overbroad regexes.

**Data flow**: Translates `/tmp/repo/[*.env` to a regex, asserts the exact escaped form, compiles it, and verifies that paths beginning with a literal `[` match while ordinary names do not.

**Call relations**: This is an edge-case regression test for robust glob parsing under invalid input.

*Call graph*: 4 external calls (assert!, assert_eq!, new, seatbelt_regex_for_unreadable_glob).


##### `unreadable_glob_policy_includes_canonicalized_static_prefix`  (lines 353–384)

```
fn unreadable_glob_policy_includes_canonicalized_static_prefix()
```

**Purpose**: Checks that unreadable glob policy generation canonicalizes the static path prefix before embedding the regex in Seatbelt policy.

**Data flow**: On Unix, creates a temp directory with a real directory and a symlink to it, builds a deny glob using the symlinked path, computes the expected regex from the canonical path, inserts the glob into a default `FileSystemSandboxPolicy`, calls `build_seatbelt_unreadable_glob_policy`, and asserts the resulting policy contains a deny rule using the canonicalized regex.

**Call relations**: This test targets the interaction between filesystem canonicalization and unreadable-glob policy generation, preventing symlink aliases from bypassing deny rules.

*Call graph*: calls 1 internal fn (default); 6 external calls (new, assert!, format!, create_dir, build_seatbelt_unreadable_glob_policy, seatbelt_regex_for_unreadable_glob).


##### `seatbelt_args_without_extension_profile_keep_legacy_preferences_read_access`  (lines 387–399)

```
fn seatbelt_args_without_extension_profile_keep_legacy_preferences_read_access()
```

**Purpose**: Verifies that the legacy inline-policy path still grants preference reads but not preference writes.

**Data flow**: Uses the system temp dir as cwd, calls `create_seatbelt_command_args_for_legacy_policy` with a read-only sandbox policy and a simple `echo` command, then inspects `args[1]` as the policy text and asserts it contains `user-preference-read` but not `user-preference-write`.

**Call relations**: This regression test covers the legacy policy-generation entrypoint rather than the newer parameterized command builder.

*Call graph*: 5 external calls (new_read_only_policy, assert!, temp_dir, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_allows_local_binding_when_explicitly_enabled`  (lines 402–434)

```
fn create_seatbelt_args_allows_local_binding_when_explicitly_enabled()
```

**Purpose**: Confirms that proxy-routed network policy can additionally permit loopback bind/inbound/outbound and DNS when local binding is explicitly enabled.

**Data flow**: Builds proxy inputs with one proxy port, proxy config enabled, and `allow_local_binding = true`, calls `dynamic_network_policy`, and asserts the returned policy includes bind, localhost inbound/outbound, and `*:53` DNS rules while still omitting blanket outbound access.

**Call relations**: This test exercises the branch where local loopback support is intentionally widened without abandoning proxy-only external routing.

*Call graph*: 5 external calls (new_read_only_policy, assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_preserves_restricted_policy_when_proxy_config_without_ports`  (lines 437–470)

```
fn dynamic_network_policy_preserves_restricted_policy_when_proxy_config_without_ports()
```

**Purpose**: Checks fail-closed behavior when proxy configuration exists but no proxy ports are available.

**Data flow**: Creates a network-enabled workspace-write policy and proxy inputs with `has_proxy_config = true` but an empty `ports` list, calls `dynamic_network_policy`, and asserts the result still looks like the restricted profile (`AF_SYSTEM`) and omits blanket outbound, localhost proxy-port rules, and DNS egress.

**Call relations**: This test guards against accidentally treating the mere presence of proxy config as permission to open unrestricted network access.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_blocks_dns_when_local_binding_has_no_proxy_ports`  (lines 473–498)

```
fn dynamic_network_policy_blocks_dns_when_local_binding_has_no_proxy_ports()
```

**Purpose**: Verifies that enabling local binding alone does not implicitly permit DNS when there are no proxy ports.

**Data flow**: Builds a network-enabled workspace-write policy and proxy inputs with empty ports, proxy config enabled, and local binding enabled; calls `dynamic_network_policy`; then asserts bind is allowed but `*:53` outbound is absent.

**Call relations**: This narrows the previous fail-closed case to the specific interaction between local binding and DNS allowances.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `dynamic_network_policy_preserves_restricted_policy_for_managed_network_without_proxy_config`  (lines 501–530)

```
fn dynamic_network_policy_preserves_restricted_policy_for_managed_network_without_proxy_config()
```

**Purpose**: Checks that managed-network enforcement without any proxy endpoints also remains fail-closed.

**Data flow**: Creates a network-enabled workspace-write policy, sets `enforce_managed_network = true`, passes proxy inputs with no ports and no proxy config to `dynamic_network_policy`, and asserts the resulting policy retains restricted-network markers and omits blanket outbound and DNS rules.

**Call relations**: This covers the managed-network branch distinct from explicit proxy configuration, ensuring both modes behave conservatively when endpoints are unavailable.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `create_seatbelt_args_allowlists_unix_socket_paths`  (lines 533–567)

```
fn create_seatbelt_args_allowlists_unix_socket_paths()
```

**Purpose**: Verifies that restricted Unix-domain socket allowlists produce explicit AF_UNIX bind/connect rules for parameterized paths.

**Data flow**: Builds proxy inputs with one proxy port and `UnixDomainSocketPolicy::Restricted { allowed: ["/tmp/example.sock"] }`, calls `dynamic_network_policy`, and asserts the policy enables AF_UNIX sockets plus bind/outbound rules referencing `UNIX_SOCKET_PATH_0`, while omitting the older generic subpath rule form.

**Call relations**: This test focuses on the Unix-socket portion of dynamic network policy generation when sockets are selectively allowed.

*Call graph*: 4 external calls (new_read_only_policy, assert!, dynamic_network_policy, vec!).


##### `create_seatbelt_args_allowlists_explicit_unix_socket_paths_without_proxy`  (lines 570–607)

```
fn create_seatbelt_args_allowlists_explicit_unix_socket_paths_without_proxy()
```

**Purpose**: Checks that explicit Unix-socket paths supplied directly to command generation are propagated into restricted network policy even without a proxy object.

**Data flow**: Creates a temp cwd and derives a filesystem policy from the legacy read-only sandbox policy, passes one explicit socket path in `extra_allow_unix_sockets` to `create_seatbelt_command_args`, extracts the policy text, computes the normalized socket root with `normalize_path_for_sandbox`, and asserts both the AF_UNIX outbound rule and the corresponding `-DUNIX_SOCKET_PATH_0=...` argument are present.

**Call relations**: This test exercises the command-arg builder's merging of filesystem policy and explicit socket allowances in the no-proxy case.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, seatbelt_policy_arg); 7 external calls (new, new, new_read_only_policy, assert!, create_seatbelt_command_args, normalize_path_for_sandbox, vec!).


##### `create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths`  (lines 610–666)

```
async fn create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths() -> anyhow::Result<()>
```

**Purpose**: Verifies that command generation combines Unix-socket allowlists from both network proxy configuration and explicit caller-provided paths in a stable parameter order.

**Data flow**: Builds a temp cwd and filesystem policy, creates a `NetworkProxyConfig` with full network enabled and one allowed Unix socket, converts it to `ConfigState` with `build_config_state`, wraps it in `NetworkProxyState::with_reloader` using `TestConfigReloader`, builds a `NetworkProxy`, then calls `create_seatbelt_command_args` with both the proxy and one explicit socket. It normalizes both expected paths and asserts the collected `-DUNIX_SOCKET_PATH_*` arguments equal the two expected definitions in order.

**Call relations**: This async test is the only one that constructs a realistic `NetworkProxy`; it validates the integration path where command generation reads socket allowances from proxy state and merges them with direct inputs.

*Call graph*: calls 3 internal fn (builder, with_reloader, from_legacy_sandbox_policy_for_cwd); 11 external calls (new, new, new, new_read_only_policy, assert_eq!, build_config_state, default, default, create_seatbelt_command_args, normalize_path_for_sandbox (+1 more)).


##### `create_seatbelt_args_preserves_full_network_with_explicit_unix_socket_paths`  (lines 669–701)

```
fn create_seatbelt_args_preserves_full_network_with_explicit_unix_socket_paths()
```

**Purpose**: Checks that adding explicit Unix-socket allowances does not downgrade a fully enabled network sandbox policy.

**Data flow**: Creates a temp cwd and filesystem policy, calls `create_seatbelt_command_args` with `NetworkSandboxPolicy::Enabled` and one explicit Unix socket, extracts the policy text, and asserts it still contains blanket outbound and inbound network rules plus the explicit AF_UNIX outbound rule.

**Call relations**: This test covers the interaction between unrestricted network mode and extra Unix-socket path parameters, ensuring the latter are additive rather than restrictive.

*Call graph*: calls 2 internal fn (from_legacy_sandbox_policy_for_cwd, seatbelt_policy_arg); 5 external calls (new, new_read_only_policy, assert!, create_seatbelt_command_args, vec!).


##### `unix_socket_policy_non_empty_output_is_newline_terminated`  (lines 704–724)

```
fn unix_socket_policy_non_empty_output_is_newline_terminated()
```

**Purpose**: Ensures generated Unix-socket policy snippets end with a newline whenever they are non-empty.

**Data flow**: Calls `unix_socket_policy` twice: once with a restricted allowlist and once with `AllowAll`; then asserts each returned string ends with `\n`.

**Call relations**: This is a formatting regression test that protects policy concatenation behavior in the parent module.

*Call graph*: 4 external calls (assert!, default, unix_socket_policy, vec!).


##### `unix_socket_dir_params_use_stable_param_names`  (lines 727–752)

```
fn unix_socket_dir_params_use_stable_param_names()
```

**Purpose**: Verifies that Unix-socket parameter generation sorts and deduplicates paths before assigning stable `UNIX_SOCKET_PATH_n` names.

**Data flow**: Builds proxy inputs with restricted allowed sockets `b.sock`, `a.sock`, and duplicate `a.sock`, calls `unix_socket_dir_params`, and asserts the returned vector is exactly `[('UNIX_SOCKET_PATH_0', '/tmp/a.sock'), ('UNIX_SOCKET_PATH_1', '/tmp/b.sock')]`.

**Call relations**: This test targets deterministic parameter naming, which matters because other tests and policy templates rely on exact `-D` argument ordering.

*Call graph*: 4 external calls (assert_eq!, default, unix_socket_dir_params, vec!).


##### `normalize_path_for_sandbox_rejects_relative_paths`  (lines 755–757)

```
fn normalize_path_for_sandbox_rejects_relative_paths()
```

**Purpose**: Checks that sandbox path normalization refuses relative paths.

**Data flow**: Calls `normalize_path_for_sandbox` with `relative.sock` and asserts the result is `None`.

**Call relations**: This is a small guardrail test for the path-normalization helper used when constructing Unix-socket parameters.

*Call graph*: 1 external calls (assert_eq!).


##### `create_seatbelt_args_allows_all_unix_sockets_when_enabled`  (lines 760–788)

```
fn create_seatbelt_args_allows_all_unix_sockets_when_enabled()
```

**Purpose**: Verifies that `UnixDomainSocketPolicy::AllowAll` expands to unrestricted AF_UNIX bind/connect rules rather than path-scoped subpath rules.

**Data flow**: Builds proxy inputs with one proxy port and `AllowAll`, calls `dynamic_network_policy`, and asserts the policy contains AF_UNIX socket creation, local unix-socket bind, and remote unix-socket outbound rules, while omitting generic subpath-based rules.

**Call relations**: This complements the restricted allowlist test by covering the broad Unix-socket policy branch.

*Call graph*: 4 external calls (new_read_only_policy, assert!, dynamic_network_policy, vec!).


##### `create_seatbelt_args_full_network_with_proxy_is_still_proxy_only`  (lines 791–820)

```
fn create_seatbelt_args_full_network_with_proxy_is_still_proxy_only()
```

**Purpose**: Checks that a sandbox policy with network access enabled is still narrowed to proxy-only endpoints when proxy configuration is present.

**Data flow**: Creates a network-enabled workspace-write policy and proxy inputs with one localhost proxy port, calls `dynamic_network_policy`, and asserts the policy contains the localhost proxy rule but omits blanket outbound and inbound allowances.

**Call relations**: This test confirms that proxy presence overrides the otherwise broad network-enabled policy shape.

*Call graph*: 4 external calls (assert!, default, dynamic_network_policy, vec!).


##### `create_seatbelt_args_with_read_only_git_and_codex_subpaths`  (lines 823–1070)

```
fn create_seatbelt_args_with_read_only_git_and_codex_subpaths()
```

**Purpose**: Performs an end-to-end regression test proving writable roots exclude protected repository metadata while still allowing ordinary writes elsewhere.

**Data flow**: Creates a temp workspace via `populate_tmpdir`, adds a separate cwd, builds a `SandboxPolicy::WorkspaceWrite` over two writable roots with tmp defaults disabled, generates legacy Seatbelt args for shell commands that attempt writes into `.codex/config.toml`, `.git/hooks/pre-commit`, and an ordinary file. It inspects policy text for writable-root exclusions and metadata-name regex requirements, asserts exact `-DWRITABLE_ROOT_*` definitions and command passthrough after `--`, then executes `sandbox-exec` commands via `Command::new(MACOS_PATH_TO_SEATBELT_EXECUTABLE)`. It verifies protected files remain unchanged or absent, allowed files are written successfully, and denial stderr matches via `assert_seatbelt_denied`.

**Call relations**: This is the file's most comprehensive integration test: it uses `populate_tmpdir` for fixtures, `seatbelt_policy_arg` for static inspection, and `assert_seatbelt_denied` for runtime validation of the generated policy.

*Call graph*: calls 3 internal fn (assert_seatbelt_denied, populate_tmpdir, seatbelt_policy_arg); 9 external calls (from_utf8_lossy, new, assert!, assert_eq!, new, format!, create_dir_all, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_block_first_time_dot_codex_creation_with_metadata_name_regex`  (lines 1073–1120)

```
fn create_seatbelt_args_block_first_time_dot_codex_creation_with_metadata_name_regex()
```

**Purpose**: Verifies that metadata-name regex protections block creation of a previously absent `.codex` directory under a writable repo root.

**Data flow**: Creates a temp repo, initializes Git, defines a workspace-write policy over that repo, builds a shell command that would `mkdir -p .codex` and write `config.toml`, generates legacy Seatbelt args, extracts the policy text, and asserts it contains the regex requirements produced by `seatbelt_protected_metadata_name_requirements` for the canonical repo root.

**Call relations**: Unlike the broader integration test, this one focuses specifically on the policy-text mechanism that protects metadata names even before those paths exist.

*Call graph*: calls 1 internal fn (seatbelt_policy_arg); 6 external calls (new, assert!, new, create_dir_all, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_with_read_only_git_pointer_file`  (lines 1123–1217)

```
fn create_seatbelt_args_with_read_only_git_pointer_file()
```

**Purpose**: Checks that Seatbelt protects both a `.git` pointer file and the referenced gitdir contents in a worktree-style repository layout.

**Data flow**: Creates a temp worktree root, an `actual-gitdir`, writes a gitdir `config`, writes `.git` as a `gitdir: ...` pointer file, creates a separate cwd, builds a workspace-write policy over the worktree root, and generates legacy Seatbelt args for shell commands that try to overwrite the `.git` pointer and then the gitdir config. It runs both commands through `sandbox-exec`, asserts the original file contents remain unchanged, checks command failure, and validates stderr with `assert_seatbelt_denied`.

**Call relations**: This end-to-end test extends metadata protection coverage to the special case where `.git` is a file rather than a directory, again relying on `assert_seatbelt_denied` for runtime failure checks.

*Call graph*: calls 1 internal fn (assert_seatbelt_denied); 9 external calls (new, assert!, assert_eq!, new, format!, create_dir_all, write, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `create_seatbelt_args_for_cwd_as_git_repo`  (lines 1220–1333)

```
fn create_seatbelt_args_for_cwd_as_git_repo()
```

**Purpose**: Verifies writable-root and metadata carveout generation when the current working directory itself is the repository root and default writable roots like `/tmp` and `TMPDIR` are included.

**Data flow**: Builds a populated temp repo via `populate_tmpdir`, creates a workspace-write policy with no explicit roots and tmp defaults enabled, generates legacy Seatbelt args for a command targeting `.codex/config.toml`, canonicalizes `/tmp` and optionally `TMPDIR`, extracts policy text, and asserts metadata-name regex requirements exist for cwd, `/tmp`, and `TMPDIR` when present. It also checks exact `-DWRITABLE_ROOT_0` and exclusion definitions for `.git` and `.codex`, confirms `.agents` is protected by regex rather than a materialized path parameter, verifies `/tmp` is included as another writable root, and checks command passthrough after `--`.

**Call relations**: This test reuses `populate_tmpdir` but targets the default-root expansion path instead of explicit writable roots, emphasizing how cwd and temp directories are parameterized.

*Call graph*: calls 2 internal fn (populate_tmpdir, seatbelt_policy_arg); 8 external calls (from, new, assert!, assert_eq!, format!, var, create_seatbelt_command_args_for_legacy_policy, vec!).


##### `populate_tmpdir`  (lines 1355–1395)

```
fn populate_tmpdir(tmp: &Path) -> PopulatedTmp
```

**Purpose**: Creates a reusable temporary workspace fixture containing one repository-like root with protected metadata and one empty root, along with canonical path variants for exact assertions.

**Data flow**: Takes a temp parent `Path`, creates `vulnerable_root`, runs `git init` there, creates `.codex/config.toml` with read-only contents, creates `empty_root`, canonicalizes both roots, derives canonical `.git`, `.agents`, and `.codex` paths under the vulnerable root, and returns them bundled in a `PopulatedTmp` struct.

**Call relations**: This fixture builder is called by the two largest writable-root tests so they can share a consistent repository layout and exact canonical paths for `-D` parameter assertions.

*Call graph*: called by 2 (create_seatbelt_args_for_cwd_as_git_repo, create_seatbelt_args_with_read_only_git_and_codex_subpaths); 4 external calls (join, new, create_dir_all, write).


### `linux-sandbox/src/linux_run_main_tests.rs`

`test` · `test-time validation of startup/orchestration helpers`

This test module targets the helper runtime's most failure-prone branches. Two small fixtures, `read_only_permission_profile` and `read_only_file_system_policy`, provide a canonical restricted profile used across many tests. Several tests validate pure decision helpers: proc-mount stderr classification, network-mode precedence, direct-runtime-enforcement detection for split filesystem policies, and rejection of invalid inner-stage/legacy combinations.

A large group of tests focuses on bubblewrap argv construction and compatibility behavior. They verify that `apply_inner_command_argv0_for_launcher` inserts `--argv0 codex-linux-sandbox` before the first `--` when supported, rewrites only the helper command path when not supported, and leaves nested user commands untouched. Related tests confirm that isolated and proxy-only network modes both inject `--unshare-net`, and that preflight argv remains properly wrapped.

The filesystem-cleanup tests exercise the shared marker-registry logic for synthetic mount targets and protected-create targets. They create temporary files/directories, register targets, simulate concurrent owners by writing marker files, and assert that cleanup removes only transient empty artifacts, preserves real pre-existing files, waits for other active registrations, and reports violations when protected paths are created.

The module also includes a fork-based signal-forwarding test that proves forwarded `SIGTERM` kills the bubblewrap child while leaving the supervising parent alive, plus tests for inner-command proxy-route arguments and permission-profile resolution semantics. Together these tests document the intended invariants of the helper's orchestration layer.

#### Function details

##### `read_only_permission_profile`  (lines 18–20)

```
fn read_only_permission_profile() -> PermissionProfile
```

**Purpose**: Creates the canonical read-only permission profile used by many tests. It centralizes the fixture so tests share the same baseline policy.

**Data flow**: Calls `PermissionProfile::read_only()` and returns the resulting `PermissionProfile`. It is pure.

**Call relations**: Used by tests that need a full permission profile, including inner-command construction and permission-resolution checks.

*Call graph*: calls 1 internal fn (read_only); called by 5 (inner_command_includes_permission_profile_flag, managed_proxy_inner_command_includes_route_spec, non_managed_inner_command_omits_route_spec, read_only_file_system_policy, resolve_permission_profile_derives_runtime_policies).


##### `read_only_file_system_policy`  (lines 22–24)

```
fn read_only_file_system_policy() -> FileSystemSandboxPolicy
```

**Purpose**: Derives the filesystem policy from the canonical read-only permission profile. It provides a convenient fixture for bubblewrap argv tests.

**Data flow**: Calls `read_only_permission_profile()`, then `file_system_sandbox_policy()` on the returned profile, and returns the `FileSystemSandboxPolicy`.

**Call relations**: Used by tests that build bubblewrap argv and only care about filesystem policy, not the full profile object.

*Call graph*: calls 1 internal fn (read_only_permission_profile); called by 4 (inserts_bwrap_argv0_before_command_separator, inserts_unshare_net_when_network_isolation_requested, inserts_unshare_net_when_proxy_only_network_mode_requested, rewrites_inner_command_path_when_bwrap_lacks_argv0).


##### `detects_proc_mount_invalid_argument_failure`  (lines 27–30)

```
fn detects_proc_mount_invalid_argument_failure()
```

**Purpose**: Checks that proc-mount stderr containing `Invalid argument` is recognized as a proc-mount failure. It validates one of the accepted error strings.

**Data flow**: Defines a representative stderr string and asserts `is_proc_mount_failure(stderr)` is true. No state is mutated.

**Call relations**: Exercises one branch of the proc-mount failure classifier used by preflight fallback logic.

*Call graph*: 1 external calls (assert!).


##### `detects_proc_mount_operation_not_permitted_failure`  (lines 33–36)

```
fn detects_proc_mount_operation_not_permitted_failure()
```

**Purpose**: Checks that proc-mount stderr containing `Operation not permitted` is recognized as a proc-mount failure. It covers another expected container restriction message.

**Data flow**: Builds a sample stderr string and asserts the classifier returns true. It is pure.

**Call relations**: Complements the other proc-mount classifier tests by covering a second accepted errno phrase.

*Call graph*: 1 external calls (assert!).


##### `detects_proc_mount_permission_denied_failure`  (lines 39–42)

```
fn detects_proc_mount_permission_denied_failure()
```

**Purpose**: Checks that proc-mount stderr containing `Permission denied` is recognized as a proc-mount failure. It covers the third accepted failure phrase.

**Data flow**: Supplies a sample stderr string to `is_proc_mount_failure` and asserts true. No state changes occur.

**Call relations**: Together with the other proc-mount tests, this locks down the exact stderr patterns that trigger `--no-proc` fallback.

*Call graph*: 1 external calls (assert!).


##### `ignores_non_proc_mount_errors`  (lines 45–48)

```
fn ignores_non_proc_mount_errors()
```

**Purpose**: Verifies that unrelated bubblewrap mount errors are not mistaken for proc-mount failures. This prevents false fallback to `--no-proc`.

**Data flow**: Uses a stderr string about bind-mounting `/dev/null` and asserts `is_proc_mount_failure` returns false. It is pure.

**Call relations**: Covers the negative branch of the proc-mount classifier.

*Call graph*: 1 external calls (assert!).


##### `inserts_bwrap_argv0_before_command_separator`  (lines 51–92)

```
fn inserts_bwrap_argv0_before_command_separator()
```

**Purpose**: Verifies that when the launcher supports `--argv0`, the helper inserts `--argv0 codex-linux-sandbox` immediately before the first `--` in bubblewrap argv. It checks the exact argv shape expected by the inner-stage re-entry path.

**Data flow**: Builds bubblewrap argv from a read-only filesystem policy and full-access network mode, mutates it with `apply_inner_command_argv0_for_launcher(..., true, ...)`, and asserts the resulting vector exactly matches the expected sequence including `--argv0` before `--`.

**Call relations**: Exercises the `supports_argv0` branch of the argv-rewrite helper used in production by `apply_inner_command_argv0`.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert_eq!, vec!).


##### `rewrites_inner_command_path_when_bwrap_lacks_argv0`  (lines 95–121)

```
fn rewrites_inner_command_path_when_bwrap_lacks_argv0()
```

**Purpose**: Checks the fallback behavior for older system bubblewrap builds that lack `--argv0`. The helper should rewrite the first command after `--` instead of inserting a flag.

**Data flow**: Builds bubblewrap argv, calls `apply_inner_command_argv0_for_launcher(..., false, fallback)`, then asserts no `--argv0` remains and that the command immediately after `--` is the fallback helper path.

**Call relations**: Covers the compatibility branch used when `preferred_bwrap_supports_argv0()` is false.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert!, vec!).


##### `rewrites_bwrap_helper_command_not_nested_user_command_when_current_exe_appears_later`  (lines 124–161)

```
fn rewrites_bwrap_helper_command_not_nested_user_command_when_current_exe_appears_later()
```

**Purpose**: Ensures the fallback argv rewrite only changes the helper command immediately after the first `--`, not later nested commands that may also reference the current executable. This protects nested user-command semantics.

**Data flow**: Constructs a synthetic argv containing two `--` separators and a later nested current-exe path, applies the fallback rewrite, and asserts only the first post-separator command was replaced.

**Call relations**: Tests a subtle edge case in `apply_inner_command_argv0_for_launcher` where naive replacement could corrupt nested command invocations.

*Call graph*: 3 external calls (assert_eq!, current_exe, vec!).


##### `inserts_unshare_net_when_network_isolation_requested`  (lines 164–180)

```
fn inserts_unshare_net_when_network_isolation_requested()
```

**Purpose**: Verifies that isolated network mode causes bubblewrap argv to include `--unshare-net`. This confirms the network namespace is created for restricted networking.

**Data flow**: Builds bubblewrap argv with `BwrapNetworkMode::Isolated` and asserts the resulting args contain `--unshare-net`.

**Call relations**: Exercises the lower-level bubblewrap argument builder through `build_bwrap_argv` for the isolated-network branch.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert!, vec!).


##### `inserts_unshare_net_when_proxy_only_network_mode_requested`  (lines 183–199)

```
fn inserts_unshare_net_when_proxy_only_network_mode_requested()
```

**Purpose**: Verifies that proxy-only network mode also unshares the network namespace. Managed proxy routing still requires isolation from the host network stack.

**Data flow**: Builds bubblewrap argv with `BwrapNetworkMode::ProxyOnly` and asserts `--unshare-net` is present.

**Call relations**: Complements the isolated-network test by covering the managed-proxy branch of network-mode handling.

*Call graph*: calls 1 internal fn (read_only_file_system_policy); 4 external calls (default, new, assert!, vec!).


##### `proxy_only_mode_takes_precedence_over_full_network_policy`  (lines 202–208)

```
fn proxy_only_mode_takes_precedence_over_full_network_policy()
```

**Purpose**: Checks that the helper chooses `ProxyOnly` bubblewrap networking when managed proxy mode is enabled, even if the external network policy is fully enabled. This matches the production precedence rule.

**Data flow**: Calls `bwrap_network_mode(NetworkSandboxPolicy::Enabled, true)` and asserts the result is `BwrapNetworkMode::ProxyOnly`.

**Call relations**: Exercises the pure decision helper used by `run_bwrap_with_proc_fallback`.

*Call graph*: 1 external calls (assert_eq!).


##### `split_only_filesystem_policy_requires_direct_runtime_enforcement`  (lines 211–234)

```
fn split_only_filesystem_policy_requires_direct_runtime_enforcement()
```

**Purpose**: Verifies that a filesystem policy with writable project roots and a separate read-only path requires direct runtime enforcement. This is one of the policy shapes incompatible with legacy Landlock mode.

**Data flow**: Creates a temp directory and docs subdirectory, builds a restricted `FileSystemSandboxPolicy` with mixed special/path entries, and asserts `needs_direct_runtime_enforcement(NetworkSandboxPolicy::Restricted, temp_dir.path())` is true.

**Call relations**: Supports the policy-validation logic exercised by `ensure_legacy_landlock_mode_supports_policy` in production.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (assert!, create_dir_all, new, vec!).


##### `root_write_read_only_carveout_requires_direct_runtime_enforcement`  (lines 237–258)

```
fn root_write_read_only_carveout_requires_direct_runtime_enforcement()
```

**Purpose**: Checks another unsupported policy shape: writable root with a read-only carveout path. It should also require direct runtime enforcement.

**Data flow**: Creates temp directories, constructs a restricted filesystem policy with root write plus a read-only docs path, and asserts `needs_direct_runtime_enforcement(...)` is true.

**Call relations**: Covers a second policy shape that should trigger legacy-mode rejection.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 4 external calls (assert!, create_dir_all, new, vec!).


##### `managed_proxy_preflight_argv_is_wrapped_for_full_access_policy`  (lines 261–275)

```
fn managed_proxy_preflight_argv_is_wrapped_for_full_access_policy()
```

**Purpose**: Verifies that the proc-mount preflight command remains a wrapped bubblewrap invocation even when the filesystem policy is unrestricted and proxy-only networking is selected. The presence of `--` confirms command wrapping.

**Data flow**: Computes `ProxyOnly` mode, builds preflight bubblewrap argv for unrestricted filesystem access, and asserts the args contain `--`.

**Call relations**: Exercises `build_preflight_bwrap_argv`, which is used by proc-mount support probing in production.

*Call graph*: calls 1 internal fn (unrestricted); 2 external calls (new, assert!).


##### `cleanup_synthetic_mount_targets_removes_only_empty_mount_targets`  (lines 278–303)

```
fn cleanup_synthetic_mount_targets_removes_only_empty_mount_targets()
```

**Purpose**: Checks that synthetic mount cleanup removes transient empty files/directories but preserves non-empty files and tolerates missing paths. This validates the safety checks around synthetic cleanup.

**Data flow**: Creates a temp workspace with an empty file, empty dir, non-empty file, and missing path; registers synthetic targets for all four; runs `cleanup_synthetic_mount_targets`; then asserts the empty artifacts are gone, the non-empty file still contains its data, and the missing path remains absent.

**Call relations**: Exercises the registration and cleanup path for synthetic mount targets, including `should_remove_after_bwrap` behavior on different metadata states.

*Call graph*: calls 2 internal fn (missing, missing_empty_directory); 5 external calls (assert!, assert_eq!, create_dir, write, new).


##### `synthetic_mount_registry_root_is_unique_to_effective_user`  (lines 306–314)

```
fn synthetic_mount_registry_root_is_unique_to_effective_user()
```

**Purpose**: Verifies that the synthetic mount registry root path is namespaced by effective uid. This prevents cross-user collisions in shared temp directories.

**Data flow**: Reads `geteuid()`, computes the expected temp-dir path string, and asserts it equals `synthetic_mount_registry_root()`.

**Call relations**: Documents the registry-root naming invariant used by all synthetic/protected target coordination.

*Call graph*: 2 external calls (assert_eq!, geteuid).


##### `cleanup_synthetic_mount_targets_waits_for_other_active_registrations`  (lines 317–335)

```
fn cleanup_synthetic_mount_targets_waits_for_other_active_registrations()
```

**Purpose**: Checks that synthetic cleanup does not remove a target while another active registration marker exists, but does remove it once that marker disappears. This validates concurrent-owner coordination.

**Data flow**: Creates an empty file target, registers it, writes a fake active marker file in the marker dir, runs cleanup and asserts the file still exists, removes the fake marker, registers again, runs cleanup, and asserts the file is finally removed.

**Call relations**: Exercises the active-process marker logic used by `cleanup_synthetic_mount_targets` to avoid deleting paths still owned by another helper.

*Call graph*: calls 1 internal fn (missing); 5 external calls (assert!, remove_file, write, from_ref, new).


##### `cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits`  (lines 338–359)

```
fn cleanup_synthetic_mount_targets_removes_transient_file_after_concurrent_owner_exits()
```

**Purpose**: Verifies that a transient empty file created while another synthetic owner is active is eventually removed after that owner exits, even when a later registration treats the path as pre-existing. This covers a subtle concurrent-registration edge case.

**Data flow**: Registers a missing synthetic target, creates the empty file, writes an active synthetic-owner marker, constructs an `existing_empty_file` target from current metadata, registers that second target, cleans up the first registration and confirms the file remains, removes the active marker, cleans up the second registration, and asserts the file is removed.

**Call relations**: Tests the marker-content distinction between synthetic and existing ownership that `register_synthetic_mount_targets` uses to avoid preserving transient artifacts forever.

*Call graph*: calls 2 internal fn (existing_empty_file, missing); 5 external calls (assert!, remove_file, symlink_metadata, write, new).


##### `cleanup_synthetic_mount_targets_preserves_real_pre_existing_empty_file`  (lines 362–379)

```
fn cleanup_synthetic_mount_targets_preserves_real_pre_existing_empty_file()
```

**Purpose**: Checks that two registrations for a genuinely pre-existing empty file do not cause the file to be deleted during cleanup. This protects real user files from synthetic cleanup.

**Data flow**: Creates an empty file, captures metadata, constructs two `existing_empty_file` targets, registers both, cleans up both registrations, and asserts the file still exists.

**Call relations**: Validates the 'existing' marker semantics that distinguish real pre-existing paths from synthetic placeholders.

*Call graph*: calls 1 internal fn (existing_empty_file); 4 external calls (assert!, symlink_metadata, write, new).


##### `cleanup_protected_create_targets_removes_created_path_and_reports_violation`  (lines 382–393)

```
fn cleanup_protected_create_targets_removes_created_path_and_reports_violation()
```

**Purpose**: Verifies that if a protected-create target appears during execution, cleanup removes it and reports a policy violation. This is the core protected-create enforcement behavior.

**Data flow**: Creates a temp target path, registers it as missing, creates the directory at that path, runs `cleanup_protected_create_targets`, and asserts the returned violation flag is true and the path no longer exists.

**Call relations**: Exercises the final cleanup path for protected-create targets after a forbidden path was created.

*Call graph*: calls 1 internal fn (missing); 3 external calls (assert!, create_dir, new).


##### `cleanup_protected_create_targets_waits_for_other_active_registrations`  (lines 396–416)

```
fn cleanup_protected_create_targets_waits_for_other_active_registrations()
```

**Purpose**: Checks that protected-create cleanup reports a violation immediately but defers actual deletion while another active registration exists, then removes the path once that marker is gone. This mirrors the concurrent-owner behavior of synthetic cleanup.

**Data flow**: Registers a protected target, writes a fake active marker and creates the protected path, runs cleanup and asserts violation=true while the path still exists, removes the fake marker, registers again, runs cleanup, and asserts violation=true and the path is now gone.

**Call relations**: Exercises the active-registration branch in `cleanup_protected_create_targets`.

*Call graph*: calls 1 internal fn (missing); 5 external calls (assert!, remove_file, write, from_ref, new).


##### `bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive`  (lines 419–430)

```
fn bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive()
```

**Purpose**: Forks a supervisor process to verify that the installed signal forwarders send `SIGTERM` to the bubblewrap child without killing the supervising parent. It validates the helper's signal-forwarding design.

**Data flow**: Forks a supervisor; in the child branch it runs `run_bwrap_signal_forwarder_test_supervisor()`. In the parent it waits for the supervisor with `wait_for_bwrap_child`, asserts the supervisor exited normally, and asserts exit status 0.

**Call relations**: This is the top-level test harness for the signal-forwarding behavior implemented by `install_bwrap_signal_forwarders`.

*Call graph*: calls 2 internal fn (wait_for_bwrap_child, run_bwrap_signal_forwarder_test_supervisor); 3 external calls (assert!, assert_eq!, fork).


##### `run_bwrap_signal_forwarder_test_supervisor`  (lines 433–460)

```
fn run_bwrap_signal_forwarder_test_supervisor() -> !
```

**Purpose**: Acts as the forked supervisor used by the signal-forwarding test. It creates a paused child, installs forwarders, raises `SIGTERM` in itself, and exits with success only if the child died from forwarded `SIGTERM`.

**Data flow**: Forks a child; the child loops on `pause()`. The supervisor installs signal forwarders for that child, raises `SIGTERM` on itself, waits for the child, checks `WIFSIGNALED && WTERMSIG == SIGTERM`, and exits via `_exit(0 or 1)` accordingly. On fork failure it `_exit(2)`.

**Call relations**: Called only by `bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive`. It directly exercises `install_bwrap_signal_forwarders` and `wait_for_bwrap_child` under real signal delivery.

*Call graph*: calls 2 internal fn (install_bwrap_signal_forwarders, wait_for_bwrap_child); called by 1 (bwrap_signal_forwarder_terminates_child_and_keeps_parent_alive); 6 external calls (WIFSIGNALED, WTERMSIG, _exit, fork, pause, raise).


##### `managed_proxy_inner_command_includes_route_spec`  (lines 463–476)

```
fn managed_proxy_inner_command_includes_route_spec()
```

**Purpose**: Verifies that the inner helper command includes `--proxy-route-spec` and the serialized route spec when managed proxy mode is enabled. This ensures the inner stage can activate proxy routing inside the network namespace.

**Data flow**: Builds `InnerSeccompCommandArgs` with `allow_network_for_proxy: true` and a JSON route spec, calls `build_inner_seccomp_command`, and asserts the resulting argv contains both the flag and the JSON payload.

**Call relations**: Exercises the managed-proxy branch of inner-command construction used by `run_main` before launching bubblewrap.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 3 external calls (new, assert!, vec!).


##### `inner_command_includes_permission_profile_flag`  (lines 479–495)

```
fn inner_command_includes_permission_profile_flag()
```

**Purpose**: Checks that the inner helper command always carries the serialized permission profile and optional command cwd. This ensures the re-entered helper can reconstruct effective permissions and logical cwd.

**Data flow**: Builds inner-command args with a read-only profile and command cwd, calls `build_inner_seccomp_command`, and asserts the argv contains `--permission-profile` and the `--command-cwd /tmp/link` pair.

**Call relations**: Covers the common non-proxy branch of inner-command construction.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 3 external calls (new, assert!, vec!).


##### `non_managed_inner_command_omits_route_spec`  (lines 498–510)

```
fn non_managed_inner_command_omits_route_spec()
```

**Purpose**: Verifies that non-managed inner commands do not include proxy-routing flags. This prevents unnecessary or invalid proxy activation in ordinary runs.

**Data flow**: Builds inner-command args with `allow_network_for_proxy: false`, calls `build_inner_seccomp_command`, and asserts no argument equals `--proxy-route-spec`.

**Call relations**: Exercises the branch where proxy-routing arguments should be absent.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 3 external calls (new, assert!, vec!).


##### `managed_proxy_inner_command_requires_route_spec`  (lines 513–526)

```
fn managed_proxy_inner_command_requires_route_spec()
```

**Purpose**: Checks that managed proxy mode panics if no route spec is supplied. This enforces the invariant expected by the inner-stage activation logic.

**Data flow**: Wraps a call to `build_inner_seccomp_command` with `allow_network_for_proxy: true` and `proxy_route_spec: None` inside `catch_unwind`, then asserts the result is an error.

**Call relations**: Tests the panic path that protects `run_main` from constructing an unusable managed-proxy inner command.

*Call graph*: 2 external calls (assert!, catch_unwind).


##### `resolve_permission_profile_derives_runtime_policies`  (lines 529–543)

```
fn resolve_permission_profile_derives_runtime_policies()
```

**Purpose**: Verifies that resolving a standard read-only permission profile preserves the profile and derives the expected runtime filesystem and network policies. It checks the normal resolution path.

**Data flow**: Creates the read-only profile, calls `resolve_permission_profile(Some(profile.clone()))`, unwraps success, and asserts the returned `EffectivePermissions` contains the original profile, the expected read-only filesystem policy, and `NetworkSandboxPolicy::Restricted`.

**Call relations**: Exercises the successful branch of `resolve_permission_profile` used at startup.

*Call graph*: calls 1 internal fn (read_only_permission_profile); 1 external calls (assert_eq!).


##### `resolve_permission_profile_preserves_direct_runtime_profile`  (lines 546–579)

```
fn resolve_permission_profile_preserves_direct_runtime_profile()
```

**Purpose**: Checks that a permission profile created directly from runtime permissions survives resolution unchanged. This matters for profiles that encode direct-runtime-enforcement shapes.

**Data flow**: Builds a temp-directory-based restricted filesystem policy, constructs a `PermissionProfile::from_runtime_permissions`, resolves it, and asserts the returned profile and both runtime policies exactly match the originals.

**Call relations**: Covers the case where the profile already represents a direct runtime policy rather than a canned preset.

*Call graph*: calls 3 internal fn (from_runtime_permissions, restricted, from_absolute_path); 4 external calls (assert_eq!, create_dir_all, new, vec!).


##### `resolve_permission_profile_rejects_missing_configuration`  (lines 582–587)

```
fn resolve_permission_profile_rejects_missing_configuration()
```

**Purpose**: Verifies that missing permission-profile configuration is rejected with the expected error variant. This prevents silent defaults at startup.

**Data flow**: Calls `resolve_permission_profile(None)`, unwraps the error, and asserts it equals `ResolvePermissionProfileError::MissingConfiguration`.

**Call relations**: Exercises the error branch that `run_main` converts into a panic when required configuration is absent.

*Call graph*: 1 external calls (assert_eq!).


##### `apply_seccomp_then_exec_with_legacy_landlock_panics`  (lines 590–597)

```
fn apply_seccomp_then_exec_with_legacy_landlock_panics()
```

**Purpose**: Checks that the helper rejects the incompatible combination of inner-stage seccomp mode and legacy Landlock mode. This validates startup argument validation.

**Data flow**: Wraps `ensure_inner_stage_mode_is_valid(true, true)` in `catch_unwind` and asserts it panics.

**Call relations**: Exercises the panic branch of the mode-validation helper used at the start of `run_main`.

*Call graph*: 2 external calls (assert!, catch_unwind).


##### `legacy_landlock_rejects_split_only_filesystem_policies`  (lines 600–628)

```
fn legacy_landlock_rejects_split_only_filesystem_policies()
```

**Purpose**: Verifies that legacy Landlock mode rejects a filesystem policy requiring direct runtime enforcement. This matches the production compatibility guard.

**Data flow**: Builds a temp-directory-based restricted filesystem policy with root read and docs write, calls `ensure_legacy_landlock_mode_supports_policy(true, &policy, Restricted, temp_dir.path())` inside `catch_unwind`, and asserts it panics.

**Call relations**: Exercises the policy-validation panic path that protects the legacy Landlock branch in `run_main`.

*Call graph*: calls 2 internal fn (restricted, from_absolute_path); 5 external calls (assert!, create_dir_all, catch_unwind, new, vec!).


##### `valid_inner_stage_modes_do_not_panic`  (lines 631–641)

```
fn valid_inner_stage_modes_do_not_panic()
```

**Purpose**: Confirms that all supported combinations of inner-stage and legacy-mode flags pass validation. It documents the accepted mode matrix.

**Data flow**: Calls `ensure_inner_stage_mode_is_valid` three times for the valid boolean combinations and expects no panic. It has no side effects.

**Call relations**: Covers the non-panicking branches of the mode-validation helper.


### `linux-sandbox/tests/all.rs`

`test` · `test discovery / integration test startup`

This file is the top-level integration test harness for the linux-sandbox crate. Rather than maintaining multiple standalone integration test binaries under `tests/`, it declares one `suite` module and lets that module pull in the individual test groups. The crate-level `#![allow(clippy::expect_used)]` attribute relaxes linting specifically for tests, acknowledging that `expect` calls are acceptable in test code where immediate, explicit failure messages are often preferable to more defensive error handling.

There is no executable test logic in this file itself; its role is to shape how Cargo discovers and builds tests. By aggregating all integration tests into a single binary, the project can share setup code more easily, reduce duplication in test harness initialization, and keep the `tests/` directory organized around modules instead of many separate roots. The comment makes that migration explicit: the real test implementations live in `tests/suite/`. This file therefore serves as the bridge between Cargo’s integration-test conventions and the project’s preferred internal test organization.


### `linux-sandbox/tests/suite/mod.rs`

`test` · `test compilation / suite assembly`

This module file sits beneath the top-level integration test harness and declares the actual test group modules: `landlock` and `managed_proxy`. Its purpose is purely structural, but that structure matters because it determines how the integration test binary is composed. Instead of each test area being a separate Cargo integration target, both are compiled as submodules of the shared `suite`, which allows common imports, helper visibility, and potentially shared fixtures to be managed more naturally within one module tree.

The comment notes that these modules were formerly standalone integration tests, so this file represents a consolidation step in the test architecture. That consolidation can reduce compile overhead and make cross-suite organization clearer, while preserving logical separation between sandboxing behavior tests (`landlock`) and proxy-management behavior tests (`managed_proxy`). There is no runtime control flow here beyond Rust’s normal module inclusion during test compilation. The key design point is that this file defines the suite boundary and keeps the test taxonomy explicit without exposing any production functionality.


### `linux-sandbox/tests/suite/landlock.rs`

`test` · `integration test execution`

This test file is the main behavioral specification for the Linux sandbox path. It defines small helpers that convert plain command arrays plus writable roots into full `ExecParams` and `PermissionProfile` objects, then invokes `codex_core::exec::process_exec_tool_call` against the `codex-linux-sandbox` test binary. The helpers deliberately exclude tmp-related paths from writable roots when constructing `PermissionProfile::workspace_write_with`, so tests can distinguish explicitly allowed directories from globally writable temp locations. Two execution styles are covered: the legacy bridge from writable roots to a permission profile, and direct split-policy construction with `FileSystemSandboxPolicy::restricted` entries using `Read`, `Write`, and `Deny` access modes.

The suite checks baseline invariants such as root reads succeeding, root writes failing, writable roots being honored, `NoNewPrivs` being enabled, and timeouts surfacing as sandbox timeout errors. A substantial subset is bubblewrap-specific: tests skip themselves when probe output indicates missing bwrap or namespace prerequisites, and they verify `/dev` population, `/dev/shm` bind-mount writability, tolerance of missing writable roots, denial of writes into `.git`/`.codex`, resistance to symlink replacement attacks, and preservation of parent-repo discovery while blocking child metadata directories. Network tests run commands like `curl`, `wget`, `ping`, `nc`, `ssh`, `getent`, and bash `/dev/tcp`, treating any zero exit code as a sandbox breach while allowing missing binaries to count as acceptable nonzero failures.

#### Function details

##### `create_env_from_core_vars`  (lines 45–48)

```
fn create_env_from_core_vars() -> HashMap<String, String>
```

**Purpose**: Builds the environment map used for sandboxed test commands from the default shell-environment policy. It centralizes environment creation so all command-launch helpers use the same baseline variables.

**Data flow**: Creates `ShellEnvironmentPolicy::default()`, passes it with `thread_id = None` into `create_env`, and returns the resulting `HashMap<String, String>`. It does not mutate global state.

**Call relations**: This helper is used when constructing `ExecParams` for both the generic command path and the network-blocking assertions, ensuring those callers exercise the sandbox with the same environment shaping logic as production code.

*Call graph*: calls 2 internal fn (create_env, default); called by 2 (assert_network_blocked, run_cmd_result_with_permission_profile_for_cwd).


##### `codex_linux_sandbox_exe`  (lines 50–56)

```
fn codex_linux_sandbox_exe() -> PathBuf
```

**Purpose**: Resolves the path to the `codex-linux-sandbox` test binary, preferring a canonicalized absolute path when possible. This avoids path ambiguity when the helper binary is passed into sandbox execution.

**Data flow**: Reads the compile-time `CARGO_BIN_EXE_codex-linux-sandbox` path, wraps it in a `PathBuf`, attempts `canonicalize`, and returns either the canonical path or the original path on failure.

**Call relations**: Execution helpers call this before invoking `process_exec_tool_call`, and split-policy tests also use its parent directory to explicitly grant read access to the sandbox helper when bypassing the legacy permission bridge.

*Call graph*: called by 4 (assert_network_blocked, run_cmd_result_with_permission_profile_for_cwd, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_reenables_writable_subpaths_under_unreadable_parents); 2 external calls (from, env!).


##### `run_cmd`  (lines 59–66)

```
async fn run_cmd(cmd: &[&str], writable_roots: &[PathBuf], timeout_ms: u64)
```

**Purpose**: Runs a sandboxed command and turns any nonzero exit into a test failure with captured stdout and stderr printed for diagnosis. It is the convenience wrapper for tests that expect success.

**Data flow**: Accepts a command slice, writable roots, and timeout; awaits `run_cmd_output`; if `exit_code != 0`, prints `stdout.text` and `stderr.text` and panics, otherwise returns unit.

**Call relations**: Simple success-path tests invoke this directly instead of matching on `Result`; it delegates all sandbox setup to `run_cmd_output` and only adds assertion/reporting behavior.

*Call graph*: calls 1 internal fn (run_cmd_output); called by 4 (test_root_read, test_root_write, test_timeout, test_writable_root); 2 external calls (panic!, println!).


##### `run_cmd_output`  (lines 68–82)

```
async fn run_cmd_output(
    cmd: &[&str],
    writable_roots: &[PathBuf],
    timeout_ms: u64,
) -> codex_protocol::exec_output::ExecToolCallOutput
```

**Purpose**: Executes a command under the default writable-root-derived permission profile and returns the raw captured output. It assumes the sandbox invocation itself should succeed at the API level.

**Data flow**: Takes command, writable roots, and timeout; calls `run_cmd_result_with_writable_roots` with `use_legacy_landlock = false` and `network_access = false`; unwraps the `Result` with an expectation message and returns `ExecToolCallOutput`.

**Call relations**: Used by `run_cmd` and by tests that need to inspect stdout directly, such as the `NoNewPrivs` assertion. It is the narrow bridge from high-level tests to the more configurable helper below.

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

**Purpose**: Builds a workspace-write permission profile from a list of writable roots and executes the command under that profile. It is the main helper for tests that vary writable directories and network policy.

**Data flow**: Converts each `PathBuf` root into `AbsolutePathBuf`, constructs `PermissionProfile::workspace_write_with` using either `NetworkSandboxPolicy::Enabled` or `Restricted`, with tmp exclusions enabled, then forwards to `run_cmd_result_with_permission_profile`. Returns the sandbox execution `Result` unchanged.

**Call relations**: Most filesystem and bubblewrap tests call this helper because they want the production-style workspace-write policy. It delegates profile-independent execution details to `run_cmd_result_with_permission_profile`.

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

**Purpose**: Runs a command under an explicitly supplied `PermissionProfile` using the current working directory as both execution cwd and sandbox cwd. It is the entry point for tests that handcraft filesystem policies.

**Data flow**: Reads the current directory as an `AbsolutePathBuf`, then passes command, cwd, permission profile, timeout, and legacy-landlock flag into `run_cmd_result_with_permission_profile_for_cwd`. Returns that `Result` directly.

**Call relations**: Called by the writable-root helper and by split-policy carveout tests that need exact `FileSystemSandboxPolicy` semantics without the workspace-write convenience layer.

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

**Purpose**: Like the writable-root helper, but lets a test choose an explicit absolute cwd distinct from the process current directory. This is needed for nested-repository scenarios.

**Data flow**: Converts writable roots to `AbsolutePathBuf`, builds `PermissionProfile::workspace_write_with` with tmp exclusions, converts the provided cwd to `AbsolutePathBuf`, and forwards everything to `run_cmd_result_with_permission_profile_for_cwd`.

**Call relations**: The parent-repo-discovery test uses this helper to run inside a subdirectory while granting write access only to that subdirectory, exercising path-sensitive metadata protections.

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

**Purpose**: Constructs the full `ExecParams` for a sandboxed tool call and invokes `process_exec_tool_call`. This is the lowest-level execution helper in the file.

**Data flow**: Receives command strings, absolute cwd, permission profile, timeout, and legacy flag; clones cwd into `sandbox_cwd`; builds `ExecParams` with command vector, expiration, `ExecCapturePolicy::ShellTool`, environment from `create_env_from_core_vars`, default sandbox permissions, disabled Windows sandbox settings, and no network override; resolves the sandbox helper path; then awaits `process_exec_tool_call` with the cwd as both sandbox cwd and sole writable root slice. Returns the resulting `Result<ExecToolCallOutput>`.

**Call relations**: Higher-level helpers funnel into this function. It is the point where test inputs become the same execution API used by the rest of the system.

*Call graph*: calls 3 internal fn (process_exec_tool_call, codex_linux_sandbox_exe, create_env_from_core_vars); called by 2 (run_cmd_result_with_cwd_and_writable_roots, run_cmd_result_with_permission_profile); 2 external calls (from_ref, clone).


##### `is_bwrap_unavailable_output`  (lines 198–207)

```
fn is_bwrap_unavailable_output(output: &codex_protocol::exec_output::ExecToolCallOutput) -> bool
```

**Purpose**: Recognizes stderr patterns that mean bubblewrap or its namespace/mount prerequisites are unavailable in the current environment. It normalizes several failure signatures into a single skip decision.

**Data flow**: Reads `output.stderr.text` and returns `true` if it contains the explicit missing-bwrap message or the proc-mount failure text combined with one of several permission-related suffixes.

**Call relations**: Only the skip probe uses this helper, but many bubblewrap-specific tests depend on that probe to avoid failing in restricted CI environments.

*Call graph*: called by 1 (should_skip_bwrap_tests).


##### `should_skip_bwrap_tests`  (lines 209–228)

```
async fn should_skip_bwrap_tests() -> bool
```

**Purpose**: Performs a live probe to decide whether bubblewrap-dependent assertions should be skipped. It treats unavailable bwrap and probe timeouts as non-actionable skip conditions.

**Data flow**: Runs `bash -lc true` with network enabled through `run_cmd_result_with_writable_roots`; on success or sandbox denial, inspects the output with `is_bwrap_unavailable_output`; on sandbox timeout returns `true`; on any other error panics. Returns a boolean skip decision.

**Call relations**: Nearly every bubblewrap-focused test calls this first. It gates those tests before they make stronger assertions about `/dev`, bind mounts, or deny rules.

*Call graph*: calls 2 internal fn (is_bwrap_unavailable_output, run_cmd_result_with_writable_roots); called by 11 (bwrap_populates_minimal_dev_nodes, bwrap_preserves_writable_dev_shm_bind_mount, sandbox_blocks_codex_symlink_replacement_attack, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_blocks_git_and_codex_writes_inside_writable_root, sandbox_blocks_root_read_carveouts_under_bwrap, sandbox_ignores_missing_writable_roots_under_bwrap, sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata, sandbox_reenables_writable_subpaths_under_unreadable_parents, sandbox_reports_codex_symlink_build_failure_without_panicking (+1 more)); 1 external calls (panic!).


##### `expect_denied`  (lines 230–242)

```
fn expect_denied(
    result: Result<codex_protocol::exec_output::ExecToolCallOutput>,
    context: &str,
) -> codex_protocol::exec_output::ExecToolCallOutput
```

**Purpose**: Normalizes sandbox-denial expectations so tests can assert on the captured output regardless of whether denial surfaced as an error or as a nonzero process exit. It fails loudly if the command unexpectedly succeeds.

**Data flow**: Consumes a `Result<ExecToolCallOutput>` plus context string. If `Ok(output)`, asserts `exit_code != 0` and returns the output; if `Err(CodexErr::Sandbox(SandboxErr::Denied { output, .. }))`, unwraps and returns the boxed output; otherwise panics with context.

**Call relations**: Used by tests that care about deny semantics but still want access to stderr and exit code for follow-up assertions.

*Call graph*: called by 5 (sandbox_blocks_codex_symlink_replacement_attack, sandbox_blocks_explicit_split_policy_carveouts_under_bwrap, sandbox_blocks_git_and_codex_writes_inside_writable_root, sandbox_blocks_root_read_carveouts_under_bwrap, sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata); 2 external calls (assert_ne!, panic!).


##### `test_root_read`  (lines 245–247)

```
async fn test_root_read()
```

**Purpose**: Verifies that reading standard system paths such as `/bin` remains allowed inside the sandbox.

**Data flow**: Runs `ls -l /bin` with no writable roots and the short timeout, expecting success via `run_cmd`.

**Call relations**: This is a baseline allow-case test built on the generic success wrapper.

*Call graph*: calls 1 internal fn (run_cmd).


##### `test_root_write`  (lines 251–260)

```
async fn test_root_write()
```

**Purpose**: Verifies that writing to an arbitrary root-level path outside declared writable roots is rejected. The test is marked `should_panic` because the helper treats nonzero exit as failure.

**Data flow**: Creates a host temp file, formats a shell redirection command targeting that path, and invokes `run_cmd` with no writable roots. The expected sandbox denial causes the test to panic.

**Call relations**: This complements `test_root_read` by proving the default profile is read-only outside explicit carveouts.

*Call graph*: calls 1 internal fn (run_cmd); 2 external calls (new, format!).


##### `test_dev_null_write`  (lines 263–282)

```
async fn test_dev_null_write()
```

**Purpose**: Checks that bubblewrap mode still permits writing to `/dev/null`, a required minimal device behavior for many shell commands.

**Data flow**: Skips if bubblewrap is unavailable; otherwise runs `echo blah > /dev/null` with network enabled and no writable roots, then asserts `exit_code == 0`.

**Call relations**: This is one of the bwrap-specific smoke tests validating the synthetic `/dev` environment.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 2 external calls (assert_eq!, eprintln!).


##### `bwrap_populates_minimal_dev_nodes`  (lines 285–306)

```
async fn bwrap_populates_minimal_dev_nodes()
```

**Purpose**: Asserts that the bubblewrap sandbox exposes a minimal set of character devices under `/dev`: `null`, `zero`, `full`, `random`, `urandom`, and `tty`.

**Data flow**: After skip probing, runs a shell loop that checks each node with `-c` and exits nonzero if any are missing; then asserts the sandboxed command exited successfully.

**Call relations**: This test deepens the `/dev` validation beyond `/dev/null` by checking the exact expected node set.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 2 external calls (assert_eq!, eprintln!).


##### `bwrap_preserves_writable_dev_shm_bind_mount`  (lines 309–348)

```
async fn bwrap_preserves_writable_dev_shm_bind_mount()
```

**Purpose**: Verifies that when `/dev/shm` is declared writable, writes inside the sandbox affect the host bind-mounted file rather than an isolated copy. It protects shared-memory workflows.

**Data flow**: Skips if bwrap or `/dev/shm` is unavailable; creates a temp file in `/dev/shm`, seeds it with `host-before`, runs a sandboxed shell command that overwrites it while `/dev/shm` is in writable roots, then asserts success and reads the host file back as `sandbox-after`.

**Call relations**: This test exercises writable-root handling for special mount points and confirms the bind mount remains writable through bubblewrap.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 7 external calls (new_in, from, assert_eq!, eprintln!, format!, write, new).


##### `test_writable_root`  (lines 351–366)

```
async fn test_writable_root()
```

**Purpose**: Confirms that files can be created inside an explicitly declared writable root.

**Data flow**: Creates a temporary directory, formats a shell redirection into a file inside it, and runs the command with that directory listed as a writable root using the long timeout.

**Call relations**: This is the positive counterpart to root-write denial, validating the workspace-write permission bridge.

*Call graph*: calls 1 internal fn (run_cmd); 2 external calls (format!, tempdir).


##### `sandbox_ignores_missing_writable_roots_under_bwrap`  (lines 369–392)

```
async fn sandbox_ignores_missing_writable_roots_under_bwrap()
```

**Purpose**: Checks that bubblewrap setup tolerates writable-root entries that do not exist, as long as existing roots are valid. This prevents over-strict setup failures.

**Data flow**: Creates one existing directory and one missing path under a tempdir, runs `printf sandbox-ok` with both paths supplied as writable roots and network enabled, then asserts exit code 0 and exact stdout.

**Call relations**: This test targets sandbox setup behavior rather than command semantics, ensuring missing optional roots are ignored instead of aborting execution.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 4 external calls (assert_eq!, eprintln!, create_dir, tempdir).


##### `test_no_new_privs_is_enabled`  (lines 395–411)

```
async fn test_no_new_privs_is_enabled()
```

**Purpose**: Verifies that the sandboxed process has Linux `NoNewPrivs` enabled.

**Data flow**: Runs `grep '^NoNewPrivs:' /proc/self/status`, scans stdout lines for the matching field, defaults to an empty string if absent, and asserts the trimmed line equals `NoNewPrivs:\t1`.

**Call relations**: Uses `run_cmd_output` because it needs to inspect stdout rather than only success/failure.

*Call graph*: calls 1 internal fn (run_cmd_output); 1 external calls (assert_eq!).


##### `test_timeout`  (lines 415–417)

```
async fn test_timeout()
```

**Purpose**: Ensures sandbox execution timeouts propagate as sandbox timeout failures. The test expects a panic containing `Sandbox(Timeout`.

**Data flow**: Invokes `run_cmd` on `sleep 2` with a 50 ms timeout and no writable roots; the helper unwrap path panics when the sandbox reports timeout.

**Call relations**: This is the timeout-path regression test for the generic execution helper stack.

*Call graph*: calls 1 internal fn (run_cmd).


##### `assert_network_blocked`  (lines 423–477)

```
async fn assert_network_blocked(cmd: &[&str])
```

**Purpose**: Runs a command under a read-only, network-restricted sandbox and asserts that it does not exit successfully. It treats missing binaries as acceptable skips-by-exit-code rather than failures.

**Data flow**: Builds `ExecParams` from the current directory, default environment, shell capture policy, and default sandbox settings; uses `PermissionProfile::read_only`; invokes `process_exec_tool_call`; accepts either `Ok(output)` or sandbox-denied output; debug-prints stdout, stderr, and exit code; panics only if `exit_code == 0`.

**Call relations**: All network-blocking tests delegate here so they share identical sandbox setup and breach criteria.

*Call graph*: calls 5 internal fn (process_exec_tool_call, codex_linux_sandbox_exe, create_env_from_core_vars, read_only, current_dir); called by 7 (sandbox_blocks_curl, sandbox_blocks_dev_tcp_redirection, sandbox_blocks_getent, sandbox_blocks_nc, sandbox_blocks_ping, sandbox_blocks_ssh, sandbox_blocks_wget); 3 external calls (dbg!, panic!, from_ref).


##### `sandbox_blocks_curl`  (lines 480–482)

```
async fn sandbox_blocks_curl()
```

**Purpose**: Checks that `curl` cannot make outbound HTTP requests from the sandbox.

**Data flow**: Passes `curl -I http://openai.com` into `assert_network_blocked` and returns unit.

**Call relations**: One of several thin wrappers around the shared network-denial assertion.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_wget`  (lines 485–487)

```
async fn sandbox_blocks_wget()
```

**Purpose**: Checks that `wget` cannot fetch HTTP content from the sandbox.

**Data flow**: Passes `wget -qO- http://openai.com` into `assert_network_blocked`.

**Call relations**: Exercises a different userspace networking tool against the same network sandbox.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_ping`  (lines 490–493)

```
async fn sandbox_blocks_ping()
```

**Purpose**: Checks that raw-socket ICMP via `ping` is denied quickly.

**Data flow**: Invokes `assert_network_blocked` with `ping -c 1 8.8.8.8`.

**Call relations**: Targets raw-socket restrictions rather than TCP client behavior.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_nc`  (lines 496–499)

```
async fn sandbox_blocks_nc()
```

**Purpose**: Checks that `nc` cannot open a TCP connection, even to localhost.

**Data flow**: Invokes `assert_network_blocked` with `nc -z 127.0.0.1 80`.

**Call relations**: Covers a minimal TCP connect path distinct from HTTP clients.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_git_and_codex_writes_inside_writable_root`  (lines 502–550)

```
async fn sandbox_blocks_git_and_codex_writes_inside_writable_root()
```

**Purpose**: Verifies that bubblewrap denies writes into `.git` and `.codex` even when their parent directory is otherwise writable. This protects repository and Codex metadata from modification.

**Data flow**: Creates a tempdir with `.git` and `.codex` directories, computes target files inside them, runs shell redirections to each target with the tempdir as writable root and network enabled, normalizes both results through `expect_denied`, and asserts both exit codes are nonzero.

**Call relations**: This test exercises metadata-path deny rules layered on top of a broad writable-root allow.

*Call graph*: calls 3 internal fn (expect_denied, run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 5 external calls (assert_ne!, eprintln!, format!, create_dir_all, tempdir).


##### `sandbox_blocks_codex_symlink_replacement_attack`  (lines 553–586)

```
async fn sandbox_blocks_codex_symlink_replacement_attack()
```

**Purpose**: Checks that a `.codex` symlink pointing elsewhere cannot be used to bypass metadata protections. It models a symlink replacement attack.

**Data flow**: Creates a tempdir, a decoy directory, and a `.codex` symlink to that decoy; attempts to write `config.toml` through the symlink path under a writable-root sandbox; normalizes with `expect_denied`; asserts nonzero exit.

**Call relations**: This is the adversarial counterpart to direct `.codex` write denial, proving the protection survives symlink indirection.

*Call graph*: calls 3 internal fn (expect_denied, run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 5 external calls (assert_ne!, eprintln!, format!, create_dir_all, tempdir).


##### `sandbox_reports_codex_symlink_build_failure_without_panicking`  (lines 589–639)

```
async fn sandbox_reports_codex_symlink_build_failure_without_panicking()
```

**Purpose**: Ensures that when bubblewrap command construction fails because `.codex` is a symlink, the sandbox returns a structured denial message instead of panicking internally.

**Data flow**: Creates the same `.codex` symlink setup as the attack test, runs a harmless `true` command, expects a `SandboxErr::Denied`, extracts the output, and asserts exit code 1, presence of specific stderr substrings about bubblewrap command building and read-only enforcement, and absence of `panicked at`.

**Call relations**: This test focuses on error reporting quality during sandbox setup rather than on command execution.

*Call graph*: calls 2 internal fn (run_cmd_result_with_writable_roots, should_skip_bwrap_tests); 6 external calls (assert!, assert_eq!, eprintln!, panic!, create_dir_all, tempdir).


##### `sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata`  (lines 642–762)

```
async fn sandbox_keeps_parent_repo_discovery_while_blocking_child_metadata()
```

**Purpose**: Verifies a nuanced repository scenario: commands in a writable child directory can still discover a parent Git repo, but cannot create child `.git`, `.codex`, or `.agents` metadata. It also confirms ordinary file creation still works.

**Data flow**: Skips if prerequisites are missing; creates a temp repo with nested subdir and initializes Git in the parent; runs a shell script from the subdir asserting `git rev-parse --show-toplevel` points to the parent and that `git status --short` does not mention metadata directories; then separately expects denial for `git init -q` and `mkdir .codex` in the child; finally runs another script that writes `jsonl_viewer.py`, pipes JSON through Python, and asserts success plus resulting file existence while metadata directories remain absent.

**Call relations**: This is the most scenario-rich filesystem test, combining cwd-sensitive execution, writable-root policy, Git behavior, and metadata deny rules.

*Call graph*: calls 3 internal fn (expect_denied, run_cmd_result_with_cwd_and_writable_roots, should_skip_bwrap_tests); 9 external calls (assert!, assert_eq!, assert_ne!, new, eprintln!, format!, create_dir_all, from_ref, tempdir).


##### `sandbox_blocks_explicit_split_policy_carveouts_under_bwrap`  (lines 765–829)

```
async fn sandbox_blocks_explicit_split_policy_carveouts_under_bwrap()
```

**Purpose**: Checks that an explicit `Deny` entry in a hand-built restricted filesystem policy overrides a broader writable parent under bubblewrap.

**Data flow**: Creates temp directories, computes the sandbox helper directory, builds `FileSystemSandboxPolicy::restricted` with `Minimal` read access, helper-dir read access, tempdir write access, and blocked-dir deny access; converts it to a `PermissionProfile`; attempts to write into the blocked directory; normalizes with `expect_denied`; asserts nonzero exit.

**Call relations**: Unlike most tests, this bypasses the legacy writable-root bridge and directly validates split-policy precedence.

*Call graph*: calls 6 internal fn (codex_linux_sandbox_exe, expect_denied, run_cmd_result_with_permission_profile, should_skip_bwrap_tests, from_runtime_permissions, restricted); 6 external calls (assert_ne!, eprintln!, format!, create_dir_all, tempdir, vec!).


##### `sandbox_reenables_writable_subpaths_under_unreadable_parents`  (lines 832–906)

```
async fn sandbox_reenables_writable_subpaths_under_unreadable_parents()
```

**Purpose**: Verifies that a nested writable carveout can re-enable access inside a denied parent path. This tests precedence and path-specific override behavior.

**Data flow**: Builds a restricted filesystem policy granting `Minimal` and helper-dir reads, tempdir write, blocked-dir deny, and allowed-subdir write; runs a shell command that writes and then cats a file in the allowed subdir; asserts exit code 0 and stdout `allowed`.

**Call relations**: This complements the explicit carveout denial test by proving more specific allow entries can reopen a subpath beneath a denied ancestor.

*Call graph*: calls 5 internal fn (codex_linux_sandbox_exe, run_cmd_result_with_permission_profile, should_skip_bwrap_tests, from_runtime_permissions, restricted); 6 external calls (assert_eq!, eprintln!, format!, create_dir_all, tempdir, vec!).


##### `sandbox_blocks_root_read_carveouts_under_bwrap`  (lines 909–955)

```
async fn sandbox_blocks_root_read_carveouts_under_bwrap()
```

**Purpose**: Checks that a specific `Deny` path still blocks reads even when the policy broadly grants root read access.

**Data flow**: Creates and seeds a file in a blocked directory, builds a restricted policy with `FileSystemSpecialPath::Root` read plus blocked-dir deny, converts to a permission profile, runs `cat` on the blocked file, normalizes with `expect_denied`, and asserts nonzero exit.

**Call relations**: This is the read-side analogue of the explicit split-policy write carveout test.

*Call graph*: calls 5 internal fn (expect_denied, run_cmd_result_with_permission_profile, should_skip_bwrap_tests, from_runtime_permissions, restricted); 7 external calls (assert_ne!, eprintln!, format!, create_dir_all, write, tempdir, vec!).


##### `sandbox_blocks_ssh`  (lines 958–970)

```
async fn sandbox_blocks_ssh()
```

**Purpose**: Checks that `ssh` cannot establish outbound TCP connections from the sandbox, even with options chosen to fail quickly and avoid prompts.

**Data flow**: Passes `ssh -o BatchMode=yes -o ConnectTimeout=1 github.com` into `assert_network_blocked`.

**Call relations**: Extends network-denial coverage to a more complex client that may otherwise hang or prompt.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_getent`  (lines 973–975)

```
async fn sandbox_blocks_getent()
```

**Purpose**: Checks that hostname resolution via `getent ahosts` is blocked under the network sandbox.

**Data flow**: Invokes `assert_network_blocked` with `getent ahosts openai.com`.

**Call relations**: This targets DNS/name-service access rather than direct socket clients.

*Call graph*: calls 1 internal fn (assert_network_blocked).


##### `sandbox_blocks_dev_tcp_redirection`  (lines 978–983)

```
async fn sandbox_blocks_dev_tcp_redirection()
```

**Purpose**: Checks that bash `/dev/tcp` redirection cannot open a socket from inside the sandbox.

**Data flow**: Invokes `assert_network_blocked` with `bash -c 'echo hi > /dev/tcp/127.0.0.1/80'`.

**Call relations**: This covers shell-level socket creation syntax that bypasses standalone networking binaries.

*Call graph*: calls 1 internal fn (assert_network_blocked).


### `linux-sandbox/tests/suite/managed_proxy.rs`

`test` · `integration test execution`

This suite focuses on the special execution mode where network access is permitted only for traffic routed through a managed proxy bridge. Instead of going through `process_exec_tool_call`, it invokes the `codex-linux-sandbox` executable directly with CLI flags such as `--sandbox-policy-cwd`, `--permission-profile`, and `--allow-network-for-proxy`, making these tests close to end-to-end binary tests. Environment handling is deliberate: `create_env_from_core_vars` seeds a baseline shell environment, and `strip_proxy_env` removes all common uppercase and lowercase proxy variables so each test can opt in to exactly one proxy configuration.

The file contains two skip mechanisms. One probes for bubblewrap availability by running a trivial command under a read-only profile and scanning stderr for the known missing-bwrap message. The other probes whether managed proxy mode itself is usable in the current kernel/container environment by attempting a no-op command with `HTTP_PROXY` set and recognizing namespace-permission failures from a curated list of stderr snippets. Actual tests then verify three core properties: managed proxy mode fails closed when no proxy variables are present; traffic to the configured proxy is bridged successfully while direct `/dev/tcp` egress still fails; and AF_UNIX socket creation is denied while `socketpair(AF_UNIX, ...)` remains allowed for local IPC.

#### Function details

##### `create_env_from_core_vars`  (lines 45–48)

```
fn create_env_from_core_vars() -> HashMap<String, String>
```

**Purpose**: Builds the baseline environment map for direct sandbox binary invocations using the default shell policy.

**Data flow**: Creates `ShellEnvironmentPolicy::default()`, passes it to `create_env` with no thread id, and returns the resulting `HashMap<String, String>`.

**Call relations**: All probe and managed-proxy tests start from this helper before stripping or adding proxy variables.

*Call graph*: calls 2 internal fn (create_env, default); called by 5 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress, managed_proxy_skip_reason, should_skip_bwrap_tests).


##### `strip_proxy_env`  (lines 50–56)

```
fn strip_proxy_env(env: &mut HashMap<String, String>)
```

**Purpose**: Removes all known proxy-related environment variables, in both canonical uppercase and lowercase forms, from a mutable environment map.

**Data flow**: Iterates `PROXY_ENV_KEYS`, removes each exact key from the provided `HashMap`, computes its lowercase form with `to_ascii_lowercase`, and removes that too. It mutates the map in place and returns unit.

**Call relations**: Callers use this before adding a single controlled `HTTP_PROXY` value so tests are not contaminated by host proxy settings.

*Call graph*: called by 5 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress, managed_proxy_skip_reason, should_skip_bwrap_tests).


##### `is_bwrap_unavailable_output`  (lines 58–60)

```
fn is_bwrap_unavailable_output(output: &Output) -> bool
```

**Purpose**: Detects the specific stderr message indicating bubblewrap is unavailable.

**Data flow**: Converts `output.stderr` bytes to lossy UTF-8 and returns whether the resulting string contains `BWRAP_UNAVAILABLE_ERR`.

**Call relations**: Used only by the bubblewrap skip probe to decide whether managed-proxy tests should be skipped early.

*Call graph*: called by 1 (should_skip_bwrap_tests); 1 external calls (from_utf8_lossy).


##### `should_skip_bwrap_tests`  (lines 62–75)

```
async fn should_skip_bwrap_tests() -> bool
```

**Purpose**: Runs a minimal direct sandbox invocation to determine whether bubblewrap prerequisites are present.

**Data flow**: Builds a default environment, strips proxy variables, runs `bash -c true` through `run_linux_sandbox_direct` with `PermissionProfile::read_only()` and proxy networking disabled, then returns the result of `is_bwrap_unavailable_output` on the process output.

**Call relations**: This is the first gate inside `managed_proxy_skip_reason`, separating generic bwrap absence from managed-proxy-specific privilege issues.

*Call graph*: calls 5 internal fn (create_env_from_core_vars, is_bwrap_unavailable_output, run_linux_sandbox_direct, strip_proxy_env, read_only); called by 1 (managed_proxy_skip_reason).


##### `is_managed_proxy_permission_error`  (lines 77–81)

```
fn is_managed_proxy_permission_error(stderr: &str) -> bool
```

**Purpose**: Recognizes stderr fragments that mean managed proxy mode cannot create the required namespaces or loopback setup in the current environment.

**Data flow**: Checks whether any string in `MANAGED_PROXY_PERMISSION_ERR_SNIPPETS` is contained in the provided stderr string and returns that boolean.

**Call relations**: Used by the managed-proxy skip probe to convert low-level namespace failures into a human-readable skip reason.

*Call graph*: called by 1 (managed_proxy_skip_reason).


##### `managed_proxy_skip_reason`  (lines 83–113)

```
async fn managed_proxy_skip_reason() -> Option<String>
```

**Purpose**: Determines whether managed-proxy tests should be skipped and, if so, returns a descriptive reason string.

**Data flow**: First calls `should_skip_bwrap_tests`; if true, returns a bubblewrap-unavailable message. Otherwise it builds a stripped environment, injects `HTTP_PROXY=http://127.0.0.1:9`, runs a no-op command with `PermissionProfile::Disabled` and proxy networking enabled, and returns `None` on success. If the command fails, it inspects stderr; recognized namespace-permission failures become a formatted skip reason, while other failures are treated as non-skip and return `None`.

**Call relations**: Each actual test calls this at the top so unsupported environments are skipped consistently with an explanatory message.

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

**Purpose**: Launches the `codex-linux-sandbox` binary as a subprocess with explicit CLI arguments, serialized permission profile JSON, and a fully controlled environment.

**Data flow**: Reads the current directory, serializes the supplied `PermissionProfile` to JSON, builds argument vectors including `--sandbox-policy-cwd`, `--permission-profile`, optional `--allow-network-for-proxy`, and `--` followed by the command; constructs a `tokio::process::Command` for the sandbox binary; clears inherited env, installs the provided env map, pipes stdout/stderr, nulls stdin, and awaits `cmd.output()` under a Tokio timeout. Returns the resulting `std::process::Output`.

**Call relations**: All probes and managed-proxy tests delegate actual process execution to this helper because they need direct binary-level control rather than the higher-level exec API.

*Call graph*: called by 5 (managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair, managed_proxy_mode_fails_closed_without_proxy_env, managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress, managed_proxy_skip_reason, should_skip_bwrap_tests); 9 external calls (from_millis, null, piped, new, env!, to_string, current_dir, timeout, vec!).


##### `managed_proxy_mode_fails_closed_without_proxy_env`  (lines 153–177)

```
async fn managed_proxy_mode_fails_closed_without_proxy_env()
```

**Purpose**: Verifies that enabling managed proxy mode without any proxy environment variables causes the sandbox to reject execution rather than silently allowing unrestricted networking.

**Data flow**: Obtains an optional skip reason and returns early if present; otherwise builds a stripped environment with no proxy variables, runs `bash -c true` under `PermissionProfile::Disabled` with proxy networking enabled, asserts the process status is unsuccessful, and checks stderr for the fail-closed message about requiring proxy environment variables.

**Call relations**: This is the baseline safety test for managed proxy mode's configuration validation.

*Call graph*: calls 4 internal fn (create_env_from_core_vars, managed_proxy_skip_reason, run_linux_sandbox_direct, strip_proxy_env); 4 external calls (from_utf8_lossy, assert!, assert_eq!, eprintln!).


##### `managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress`  (lines 180–257)

```
async fn managed_proxy_mode_routes_through_bridge_and_blocks_direct_egress()
```

**Purpose**: Checks both sides of managed proxy behavior: traffic to the configured proxy is bridged successfully, but direct outbound socket creation remains blocked.

**Data flow**: After skip handling, binds a localhost `TcpListener` on an ephemeral port and spawns a thread that accepts one connection, captures the HTTP request, and replies `HTTP/1.1 200 OK`. It then builds a stripped environment with `HTTP_PROXY` pointing at that listener, runs a bash script that opens `/dev/tcp` to the proxy host/port and sends an absolute-form HTTP request, asserts successful execution and expected response text, receives and validates the captured request from the thread, then runs a second command attempting direct `/dev/tcp/192.0.2.1/80` egress and asserts failure.

**Call relations**: This is the main end-to-end managed-proxy test, proving the bridge path works while non-proxy egress remains denied.

*Call graph*: calls 4 internal fn (create_env_from_core_vars, managed_proxy_skip_reason, run_linux_sandbox_direct, strip_proxy_env); 9 external calls (from_secs, from_utf8_lossy, bind, assert!, assert_eq!, eprintln!, format!, channel, spawn).


##### `managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair`  (lines 260–303)

```
async fn managed_proxy_mode_denies_af_unix_socket_but_allows_socketpair()
```

**Purpose**: Verifies the seccomp/socket policy used in managed proxy mode: creating an AF_UNIX socket should fail, but `socketpair` for local IPC should still work.

**Data flow**: After skip handling, probes for `python3` availability via `bash -c 'command -v python3 >/dev/null'`; if absent, skips. Otherwise it builds a stripped environment with a dummy `HTTP_PROXY`, runs an inline Python program that expects `socket.socket(AF_UNIX, SOCK_STREAM)` to raise `PermissionError`, then creates a UNIX `socketpair`, sends `b'ok'`, and verifies receipt. The test asserts exit code `Some(0)` and includes stdout/stderr in the failure message.

**Call relations**: This complements the network-routing test by validating local IPC allowances that managed proxy mode must preserve.

*Call graph*: calls 4 internal fn (create_env_from_core_vars, managed_proxy_skip_reason, run_linux_sandbox_direct, strip_proxy_env); 3 external calls (assert_eq!, new, eprintln!).


### `exec/tests/suite/sandbox.rs`

`test` · `request handling`

This file is a platform-gated test suite for sandbox enforcement. The central helper, `spawn_command_under_sandbox`, is implemented separately for macOS and Linux: on macOS it builds an `ExecParams` request with `build_exec_request`, translates it into a `tokio::process::Command`, clears and repopulates the environment, and applies either inherited or piped stdio; on Linux it delegates directly to `codex_core::spawn_command_under_linux_sandbox` after locating the sandbox executable. Linux-specific capability probing is handled by `linux_sandbox_test_env` and `can_apply_linux_sandbox_policy`, which run `/usr/bin/true` under a read-only profile and skip tests entirely when Landlock cannot actually be enforced on the host.

The tests themselves target concrete regressions and policy boundaries. Two Python tests verify that sandboxing still permits multiprocessing locks and `pwd.getpwuid(os.getuid())`. `sandbox_distinguishes_command_and_policy_cwds` proves write permission is derived from the sandbox policy cwd, not merely the process cwd, by denying writes in one directory while allowing writes under the canonicalized sandbox root. `sandbox_blocks_first_time_dot_codex_creation` ensures a workspace-write profile still blocks first-time creation of `.codex/config.toml`. `unix_sock_body` performs raw `libc` `socketpair`, `write`, `recvfrom`, and `recv` calls for both datagram and stream AF_UNIX sockets, and `run_code_under_sandbox` re-execs the current test binary with an `IN_SANDBOX` environment marker so that `allow_unix_socketpair_recvfrom` can execute that body inside the sandboxed child process.

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

**Purpose**: Launches a child process under the production sandbox implementation for the current Unix platform. It is the common execution primitive used by all sandbox behavior tests.

**Data flow**: Inputs are the command vector, command cwd, `PermissionProfile`, sandbox cwd, `StdioPolicy`, and environment map. On Linux it resolves the sandbox executable and forwards all parameters to `spawn_command_under_linux_sandbox`; on macOS it builds an exec request, splits the resulting command into program and args, configures cwd, arg0, a cleared environment, and stdio mode, then spawns a `tokio::process::Child` with `kill_on_drop(true)`. It returns `io::Result<Child>` and does not itself wait for completion.

**Call relations**: This helper sits beneath every test in the file except the raw socket body. Capability probing calls it first to decide whether Linux tests should run at all, and the higher-level tests then use it to execute Python, shell, or utility commands under specific permission profiles.

*Call graph*: called by 6 (can_apply_linux_sandbox_policy, python_getpwuid_works_under_sandbox, python_multiprocessing_lock_works_under_sandbox, run_code_under_sandbox, sandbox_blocks_first_time_dot_codex_creation, sandbox_distinguishes_command_and_policy_cwds); 6 external calls (inherit, null, piped, new, find_codex_linux_sandbox_exe, from_ref).


##### `linux_sandbox_test_env`  (lines 117–135)

```
async fn linux_sandbox_test_env() -> Option<HashMap<String, String>>
```

**Purpose**: Determines whether Linux sandbox tests should execute on the current host by probing whether Landlock enforcement is actually effective. If enforcement is unavailable, it emits a skip message and returns `None`.

**Data flow**: It derives the current directory as both command and sandbox cwd, constructs a read-only `PermissionProfile`, and calls `can_apply_linux_sandbox_policy` with an empty environment. On success it returns `Some(HashMap::new())`; on failure it prints a diagnostic to stderr and returns `None`.

**Call relations**: Linux-only tests call this near the top of their bodies and early-return when it yields `None`. That makes the rest of the suite conditional on real sandbox enforcement rather than merely on running on a Linux kernel.

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

**Purpose**: Performs the actual Linux capability probe by attempting to run `/usr/bin/true` under the requested sandbox policy. It reduces the result to a simple boolean.

**Data flow**: Accepts a permission profile, command cwd, sandbox cwd, and environment map. It clones the cwd inputs as needed, invokes `spawn_command_under_sandbox` with `StdioPolicy::RedirectForShellTool`, and if spawning succeeds waits for the child and returns `status.success()`. Any spawn or wait failure becomes `false`.

**Call relations**: This function is only called by `linux_sandbox_test_env`. It isolates the probe mechanics so the tests themselves can simply branch on `Option<HashMap<String, String>>` rather than duplicate spawn-and-wait logic.

*Call graph*: calls 1 internal fn (spawn_command_under_sandbox); called by 1 (linux_sandbox_test_env); 2 external calls (clone, vec!).


##### `python_multiprocessing_lock_works_under_sandbox`  (lines 169–229)

```
async fn python_multiprocessing_lock_works_under_sandbox()
```

**Purpose**: Checks that Python's `multiprocessing.Lock` and child process startup still function inside the sandbox. This guards against sandbox restrictions breaking named semaphore usage.

**Data flow**: After skipping nested-sandbox runs and optionally probing Linux support, it computes writable roots (`/dev/shm` on Linux, empty on macOS), builds a `workspace_write_with` permission profile with restricted networking and tmp exclusions, embeds a Python script that creates a lock and child process, and spawns `python3 -c <script>` under the sandbox with inherited stdio. It waits for the child and asserts a successful exit.

**Call relations**: This is a top-level async test that depends on `linux_sandbox_test_env` for conditional execution and on `spawn_command_under_sandbox` for the actual sandboxed run. Its profile setup is tailored to the Linux semaphore implementation noted in the comments.

*Call graph*: calls 4 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, workspace_write_with, current_dir); 5 external calls (new, new, assert!, skip_if_sandbox!, vec!).


##### `python_getpwuid_works_under_sandbox`  (lines 232–275)

```
async fn python_getpwuid_works_under_sandbox()
```

**Purpose**: Verifies that Python can resolve the current user via `pwd.getpwuid(os.getuid())` while sandboxed. It protects against sandbox policies accidentally blocking NSS or passwd lookups needed by common runtimes.

**Data flow**: It skips nested sandboxing, optionally skips unsupported Linux hosts, checks whether `python3 --version` is available in PATH, constructs a read-only permission profile, and spawns `python3 -c 'import pwd, os; print(...)'` under the sandbox with redirected stdio. It waits for completion and asserts success.

**Call relations**: Like the multiprocessing test, this is a direct consumer of `linux_sandbox_test_env` and `spawn_command_under_sandbox`. It adds an external prerequisite check for Python availability before attempting the sandboxed execution.

*Call graph*: calls 4 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, read_only, current_dir); 6 external calls (new, assert!, new, skip_if_sandbox!, eprintln!, vec!).


##### `sandbox_distinguishes_command_and_policy_cwds`  (lines 278–366)

```
async fn sandbox_distinguishes_command_and_policy_cwds()
```

**Purpose**: Demonstrates that sandbox write permissions are based on the policy cwd, not simply the process's command cwd. It tests both a denied write outside the policy root and an allowed write inside it.

**Data flow**: The test creates a temporary directory tree with separate `sandbox` and `command` roots, canonicalizes the sandbox root, computes one allowed path under it and one forbidden path under the command root, and builds a workspace-write profile with no extra writable roots. It first spawns `bash -lc 'echo forbidden > forbidden.txt'` with command cwd set to the command root but sandbox cwd set to the canonical sandbox root, waits for failure, and asserts the forbidden file does not exist. It then spawns `/usr/bin/touch <allowed-path>` under the same policy, waits for success, and asserts the allowed file exists.

**Call relations**: This async test uses `linux_sandbox_test_env` for Linux gating and `spawn_command_under_sandbox` twice to exercise both sides of the policy boundary. The canonicalization step is important because the policy is evaluated against the canonical sandbox root.

*Call graph*: calls 3 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, workspace_write_with); 8 external calls (new, assert!, skip_if_sandbox!, tempdir, canonicalize, create_dir_all, try_exists, vec!).


##### `sandbox_blocks_first_time_dot_codex_creation`  (lines 369–437)

```
async fn sandbox_blocks_first_time_dot_codex_creation()
```

**Purpose**: Ensures the sandbox prevents a command from creating a new `.codex/config.toml` inside a repository, even under a workspace-write profile. It codifies a policy exception around first-time `.codex` creation.

**Data flow**: It creates a temporary repo root, computes `.codex` and `.codex/config.toml` paths, builds a workspace-write permission profile with no extra writable roots, and spawns a shell command that tries to `mkdir -p .codex` and write a config file. After waiting for a non-success exit, it inspects symlink metadata for `.codex`, asserting either that it does not exist or is not a directory, then checks `try_exists` for `config.toml`, treating `NotADirectory` as false, and asserts the file was not created.

**Call relations**: This test follows the standard Linux gating path and then uses `spawn_command_under_sandbox` for one negative execution. Its postconditions are intentionally defensive, handling both complete absence and malformed partial creation attempts.

*Call graph*: calls 3 internal fn (linux_sandbox_test_env, spawn_command_under_sandbox, workspace_write_with); 10 external calls (new, assert!, assert_eq!, skip_if_sandbox!, panic!, tempdir, create_dir_all, symlink_metadata, try_exists, vec!).


##### `unix_sock_body`  (lines 439–510)

```
fn unix_sock_body()
```

**Purpose**: Executes low-level AF_UNIX socket operations directly through `libc` to verify that local Unix-domain communication primitives remain usable. It covers both datagram `recvfrom` and stream `recv` paths.

**Data flow**: Inside an `unsafe` block it creates a datagram socketpair, writes a fixed `b"hello_unix"` payload on one fd, receives it with `recvfrom` on the other, compares the received bytes to the original payload, then repeats the exercise with a stream socketpair using `recv`. It closes all file descriptors before returning and uses assertions to fail immediately on any syscall error or payload mismatch.

**Call relations**: This function is not itself a test entrypoint; it is passed as the child body to `run_code_under_sandbox` by `allow_unix_socketpair_recvfrom`. That arrangement ensures the raw socket syscalls execute inside a sandboxed re-exec of the test binary.

*Call graph*: 8 external calls (assert!, assert_eq!, close, recv, recvfrom, socketpair, write, null_mut).


##### `allow_unix_socketpair_recvfrom`  (lines 513–521)

```
async fn allow_unix_socketpair_recvfrom()
```

**Purpose**: Runs the AF_UNIX socket syscall body inside the sandbox and asserts the re-executed test process can complete. It is the public test wrapper around `unix_sock_body`.

**Data flow**: It calls `run_code_under_sandbox` with a selector string matching this test name, a read-only permission profile, and an async closure that invokes `unix_sock_body()`. It awaits the result and expects the re-exec setup to succeed.

**Call relations**: This top-level async test delegates all real work to `run_code_under_sandbox`. The selector string is used by the re-exec branch to invoke exactly this test in the child process.

*Call graph*: calls 2 internal fn (run_code_under_sandbox, read_only).


##### `run_code_under_sandbox`  (lines 525–566)

```
async fn run_code_under_sandbox(
    test_selector: &str,
    permission_profile: &PermissionProfile,
    child_body: F,
) -> io::Result<Option<ExitStatus>>
```

**Purpose**: Implements a two-branch re-exec harness for running arbitrary async test code inside the sandbox. The parent branch launches the current test binary under sandbox control; the child branch detects the marker environment variable and executes the supplied closure.

**Data flow**: Inputs are a `test_selector`, a `PermissionProfile`, and a `FnOnce() -> Fut` child body. If `IN_SANDBOX` is absent, it resolves `current_exe`, builds a command line beginning with the test binary and `--exact`, optionally forwards `--nocapture` while switching stdio policy to `Inherit`, appends the selector, derives the current directory as both command and sandbox cwd, and spawns the child with `IN_SANDBOX=1` in its environment. It waits for the child and returns `Ok(Some(status))`. If the env var is already present, it awaits `child_body()` directly and returns `Ok(None)`.

**Call relations**: Only `allow_unix_socketpair_recvfrom` calls this helper. It in turn delegates process creation to `spawn_command_under_sandbox`, making it the bridge between ordinary Rust test code and a sandboxed subprocess that reruns a single selected test.

*Call graph*: calls 2 internal fn (spawn_command_under_sandbox, current_dir); called by 1 (allow_unix_socketpair_recvfrom); 5 external calls (from, args, current_exe, var, vec!).


### `cli/tests/sandbox_network_proxy.rs`

`test` · `Linux sandbox integration testing`

This file contains a single platform-gated test guarded by `#![cfg(target_os = "linux")]`, because it depends on the Linux sandbox implementation and bubblewrap availability. The test creates a temporary Codex home and binds a `TcpListener` to `127.0.0.2:0`, capturing the assigned port. It then writes a `config.toml` enabling `network_proxy`, `use_legacy_landlock`, and a custom permissions profile `network-test` whose network mode is `full` and extends `:workspace`.

Using `std::process::Command` directly rather than `assert_cmd`, the test launches the built `codex` binary with `sandbox --permissions-profile network-test -- curl ... <url>`, targeting the loopback listener via `curl` with proxy bypass and short connection/time limits. After execution it decodes stderr lossily and checks for the sentinel string `bubblewrap is unavailable`; if present, the test prints a skip message and returns success instead of failing, making the test robust on systems lacking bubblewrap. Otherwise it asserts the process exit code is exactly `7`, the curl connection-failure code, and includes stdout/stderr in the assertion message for debugging. The key invariant is that sandboxed direct loopback access should fail even though a listener exists outside the sandbox.

#### Function details

##### `sandbox_with_network_proxy_blocks_direct_loopback_access`  (lines 11–70)

```
fn sandbox_with_network_proxy_blocks_direct_loopback_access() -> Result<()>
```

**Purpose**: Launches a sandboxed `curl` against a loopback listener and verifies the sandbox blocks direct access when network proxying is enabled.

**Data flow**: It creates a temporary Codex home, binds a `TcpListener` on `127.0.0.2` with an ephemeral port, writes a sandbox/network-enabled `config.toml`, formats the target URL, runs `codex sandbox --permissions-profile network-test -- curl ... <url>` via `std::process::Command`, decodes stderr with `String::from_utf8_lossy`, conditionally returns early if bubblewrap is unavailable, and otherwise asserts the exit status code is `Some(7)` while embedding stdout/stderr in the failure message.

**Call relations**: This is the file’s only test and directly drives the external sandbox command path. It does not delegate to local helpers; instead it performs all setup inline so the exact sandbox configuration and skip condition are visible in one place.

*Call graph*: 9 external calls (from_utf8_lossy, bind, new, assert_eq!, new, cargo_bin, eprintln!, format!, write).


### Windows and cross-platform execution bridges
These files cover Windows sandbox and execution adapters, including stdio bridging, wrapper protocols, unified execution, and Wine-backed remote exec-server harnesses.

### `windows-sandbox-rs/src/stdio_bridge_tests.rs`

`test` · `test execution`

This file exercises the two low-level forwarding helpers from `stdio_bridge.rs` using in-memory inputs and outputs. The first test builds a Tokio `mpsc` channel to stand in for the sandbox stdin writer and a oneshot channel for EOF notification, then feeds `spawn_input_forwarder` with a `std::io::Cursor` containing two lines. It drains all chunks from the receiver, waits for the EOF signal, joins the thread, and asserts that the concatenated bytes exactly match the original input.

The second test defines a small `SharedWriter` type backed by `Arc<Mutex<Vec<u8>>>` and implementing `std::io::Write`. That lets the test inspect everything written by `spawn_output_forwarder` after the thread exits. A Tokio runtime handle is passed in because the helper blocks on a Tokio receiver from a standard thread. The test sends two chunks, drops the sender to terminate the receive loop, joins the thread, awaits the done oneshot, and confirms the sink contains `alphabeta`. Together these tests pin down the bridge's chunk transport, EOF semantics, and completion signaling.

#### Function details

##### `input_forwarder_sends_chunks_and_reports_eof`  (lines 8–23)

```
async fn input_forwarder_sends_chunks_and_reports_eof() -> anyhow::Result<()>
```

**Purpose**: Verifies that the input forwarder copies all bytes from a readable source into the writer channel and emits its EOF notification when the source is exhausted.

**Data flow**: Creates a bounded Tokio `mpsc::channel<Vec<u8>>`, a oneshot EOF channel, and a `Cursor<Vec<u8>>` containing `first\nsecond\n`. It starts `spawn_input_forwarder`, asynchronously receives all forwarded chunks into a `Vec<u8>`, awaits the EOF receiver, joins the thread, and asserts the accumulated bytes equal the original payload.

**Call relations**: This test directly invokes `spawn_input_forwarder` to validate the helper's standalone behavior, especially the contract relied on by `forward_sandbox_session_stdio` when closing sandbox stdin after local EOF.

*Call graph*: calls 1 internal fn (new); 3 external calls (new, assert_eq!, channel).


##### `output_forwarder_writes_all_chunks`  (lines 26–63)

```
async fn output_forwarder_writes_all_chunks() -> anyhow::Result<()>
```

**Purpose**: Verifies that the output forwarder drains every chunk from its receiver and writes them in order to the provided writer.

**Data flow**: Defines a `SharedWriter` wrapping `Arc<Mutex<Vec<u8>>>`, creates a Tokio runtime handle and an `mpsc::channel<Vec<u8>>`, then starts `spawn_output_forwarder`. It sends `alpha` and `beta`, drops the sender to end the stream, joins the thread, awaits the done signal, reads the collected bytes from the mutex-protected sink, and asserts they equal `alphabeta`.

**Call relations**: This test targets `spawn_output_forwarder` directly, confirming the completion signal and ordered writes that the production bridge depends on during stdout/stderr draining.

*Call graph*: 4 external calls (assert_eq!, default, clone, current).


### `windows-sandbox-rs/src/wrapper_tests.rs`

`test` · `test run`

This test file exercises the contract defined in `wrapper.rs` from both directions. The single test constructs a realistic sandbox launch request with an absolute command cwd, two workspace roots, one environment variable, an `External` permission profile with restricted networking, explicit read and write root overrides, deny-read and deny-write absolute path overrides, private desktop enabled, proxy enforcement enabled, and a concrete Codex home path. It then calls `create_windows_sandbox_command_args_for_permission_profile` to produce the wrapper argv vector.

Before parsing, the test asserts that the generated vector contains every expected flag constant, including the wrapper selector, required path and JSON flags, and all optional booleans and override flags. It then slices off the first wrapper selector argument and feeds the remainder to `parse_windows_sandbox_wrapper_args`, mirroring how the runtime entrypoint skips the executable path and wrapper mode token. The final assertions compare every parsed field against the original structured inputs: command argv, cwd, workspace roots, environment map, permission profile, sandbox level, booleans, optional override vectors, and deny-path lists. The test therefore validates both serialization defaults and parser fidelity for the wrapper protocol's richest path.

#### Function details

##### `windows_wrapper_args_round_trip`  (lines 29–106)

```
fn windows_wrapper_args_round_trip()
```

**Purpose**: Builds a representative wrapper request, serializes it to argv, parses it back, and asserts that all fields round-trip exactly. It is the main regression test for the wrapper CLI contract.

**Data flow**: Creates absolute path values with `AbsolutePathBuf::from_absolute_path`, builds workspace root, env, permission profile, read/write override, and deny-path collections, then calls `create_windows_sandbox_command_args_for_permission_profile(...)` to obtain `args`. It asserts presence of all expected flags in `args`, parses `args[1..].to_vec()` with `parse_windows_sandbox_wrapper_args`, and compares every parsed field to the original inputs with `assert_eq!`.

**Call relations**: This test directly exercises the public serializer and internal parser from `wrapper.rs`. It models the same argument slicing convention used by `run_windows_sandbox_wrapper_main`, where the wrapper selector itself is not part of the parser input.

*Call graph*: calls 1 internal fn (from_absolute_path); 7 external calls (from, new, assert!, assert_eq!, create_windows_sandbox_command_args_for_permission_profile, parse_windows_sandbox_wrapper_args, vec!).


### `windows-sandbox-rs/src/unified_exec/tests.rs`

`test` · `test execution`

This test module mixes small utility helpers with end-to-end Windows process tests. The helper layer creates isolated Tokio runtimes, locates PowerShell 7 when available, chooses a workspace root, allocates unique temporary sandbox homes using an atomic counter, reads sandbox logs for timeout diagnostics, and polls frame files until expected IPC messages appear. A global `Mutex<()>` serializes legacy process tests so Windows process/desktop state does not interfere across concurrent test runs.

The integration tests exercise the legacy backend in several modes: non-TTY `cmd.exe` and PowerShell output capture, TTY PowerShell interactive input/output, and rejection of deny-read overrides that only the elevated backend supports. Two ignored tests document current CI instability for ConPTY `cmd.exe`. Separate tests validate shared helper behavior: `finish_driver_spawn` must either preserve or immediately close stdin depending on `stdin_open`; `start_runner_stdin_writer` must emit a trailing `CloseStdin` frame after input EOF; and `make_runner_resizer` must serialize the requested terminal dimensions into a `Resize` frame. The capture tests also verify that cancellation ends a long-running process promptly without incorrectly setting the `timed_out` flag. Throughout, failures include sandbox log contents to make Windows-specific hangs diagnosable.

#### Function details

##### `legacy_process_test_guard`  (lines 38–42)

```
fn legacy_process_test_guard() -> MutexGuard<'static, ()>
```

**Purpose**: Acquires the global mutex that serializes legacy process tests on Windows.

**Data flow**: Locks the static `LEGACY_PROCESS_TEST_LOCK` and returns the resulting `MutexGuard<'static, ()>`, panicking if the mutex is poisoned.

**Call relations**: Legacy process integration tests call this at the start of each test body to prevent concurrent sandbox launches from interfering with one another.

*Call graph*: called by 6 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_powershell_emits_output_and_accepts_input).


##### `current_thread_runtime`  (lines 44–49)

```
fn current_thread_runtime() -> tokio::runtime::Runtime
```

**Purpose**: Builds a single-threaded Tokio runtime with all drivers enabled for synchronous-style tests.

**Data flow**: Creates a runtime via `Builder::new_current_thread().enable_all().build()` and returns it, panicking if runtime construction fails.

**Call relations**: Many tests call this helper before `block_on` so they can run async spawn and channel code from ordinary `#[test]` functions.

*Call graph*: called by 10 (finish_driver_spawn_closes_stdin_when_not_requested, finish_driver_spawn_keeps_stdin_open_when_requested, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input, runner_resizer_sends_resize_frame, runner_stdin_writer_sends_close_stdin_after_input_eof); 1 external calls (new_current_thread).


##### `pwsh_path`  (lines 51–55)

```
fn pwsh_path() -> Option<PathBuf>
```

**Purpose**: Finds a PowerShell 7 executable under `%ProgramFiles%` if it is installed.

**Data flow**: Reads the `ProgramFiles` environment variable, constructs `PowerShell\7\pwsh.exe` beneath it, checks `is_file()`, and returns `Some(PathBuf)` only when the executable exists.

**Call relations**: PowerShell-dependent tests call this first and return early when it yields `None`, making those tests optional on machines without PowerShell 7.

*Call graph*: called by 4 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_powershell_emits_output, legacy_tty_powershell_emits_output_and_accepts_input); 2 external calls (from, var_os).


##### `sandbox_cwd`  (lines 57–66)

```
fn sandbox_cwd() -> PathBuf
```

**Purpose**: Chooses the working directory used for sandbox tests, preferring an externally supplied workspace root.

**Data flow**: If `INSTA_WORKSPACE_ROOT` is set, returns that path as a `PathBuf`; otherwise derives the repository root by taking the parent of `env!("CARGO_MANIFEST_DIR")`.

**Call relations**: Most integration tests call this to produce a stable workspace root and current directory for sandbox launches.

*Call graph*: called by 8 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 3 external calls (from, env!, var).


##### `sandbox_home`  (lines 68–74)

```
fn sandbox_home(name: &str) -> TempDir
```

**Purpose**: Creates a unique temporary codex-home directory for a test case under the system temp directory.

**Data flow**: Uses the static `TEST_HOME_COUNTER` to generate a unique suffix, constructs a path like `codex-windows-sandbox-{name}-{id}`, removes any stale directory at that path, recreates it, and returns a `tempfile::TempDir` rooted there.

**Call relations**: Integration tests call this to isolate logs and sandbox state between runs while still producing predictable directory names for debugging.

*Call graph*: called by 8 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 5 external calls (format!, create_dir_all, remove_dir_all, temp_dir, new_in).


##### `sandbox_log`  (lines 76–80)

```
fn sandbox_log(codex_home: &Path) -> String
```

**Purpose**: Reads the current sandbox log file for a given codex-home path, returning a fallback error string if the log cannot be read.

**Data flow**: Builds the `.sandbox` log path with `crate::current_log_file_path`, attempts `fs::read_to_string`, and on failure returns a formatted message containing the path and read error.

**Call relations**: This helper is used by timeout diagnostics in `collect_stdout_and_exit`, so failed waits include the sandbox log contents in panic messages.

*Call graph*: 3 external calls (join, current_log_file_path, read_to_string).


##### `workspace_roots_for`  (lines 82–84)

```
fn workspace_roots_for(root: &Path) -> Vec<AbsolutePathBuf>
```

**Purpose**: Wraps one absolute filesystem path into the `Vec<AbsolutePathBuf>` shape expected by sandbox spawn APIs.

**Data flow**: Converts the supplied `&Path` into an `AbsolutePathBuf` with `from_absolute_path(...).expect(...)` and returns it inside a one-element vector.

**Call relations**: Most spawn tests call this to build the workspace-roots argument from the chosen test working directory.

*Call graph*: called by 8 (legacy_capture_cancellation_is_not_reported_as_timeout, legacy_capture_powershell_emits_output, legacy_non_tty_cmd_emits_output, legacy_non_tty_cmd_rejects_deny_read_overrides, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 1 external calls (vec!).


##### `wait_for_frame_count`  (lines 86–116)

```
fn wait_for_frame_count(frames_path: &Path, expected_frames: usize) -> Vec<Message>
```

**Purpose**: Polls a frame file until at least a specified number of IPC frames can be decoded or a short deadline expires.

**Data flow**: Takes a frame-file path and expected frame count, computes a deadline two seconds in the future, repeatedly opens the file for reading, seeks to offset 0, decodes frames with `read_frame` into a `Vec<Message>`, and returns once enough frames are present. If the deadline passes first it asserts with a timeout message; between polls it sleeps for 10 ms.

**Call relations**: The runner-frame helper tests use this to observe asynchronously written IPC frames without racing the background writer tasks.

*Call graph*: calls 1 internal fn (read_frame); called by 2 (runner_resizer_sends_resize_frame, runner_stdin_writer_sends_close_stdin_after_input_eof); 8 external calls (from_millis, from_secs, now, new, Start, new, assert!, sleep).


##### `collect_stdout_and_exit`  (lines 118–150)

```
async fn collect_stdout_and_exit(
    spawned: codex_utils_pty::SpawnedProcess,
    codex_home: &Path,
    timeout_duration: Duration,
) -> (Vec<u8>, i32)
```

**Purpose**: Consumes a `SpawnedProcess`'s stdout stream and exit receiver with explicit timeouts, returning the collected stdout bytes and exit code.

**Data flow**: Destructures the `SpawnedProcess`, spawns an async task that drains `stdout_rx` into a `Vec<u8>`, waits for `exit_rx` under `tokio::time::timeout`, panicking with `sandbox_log(codex_home)` on timeout, then waits for the stdout task under the same timeout policy and returns `(stdout, exit_code)` with `-1` as the fallback exit code if the oneshot resolves to `None`.

**Call relations**: Several legacy spawn tests use this helper after launching a process so they can assert on both output and termination without duplicating timeout/error-reporting logic.

*Call graph*: called by 5 (legacy_non_tty_cmd_emits_output, legacy_non_tty_powershell_emits_output, legacy_tty_cmd_default_desktop_emits_output_and_accepts_input, legacy_tty_cmd_emits_output_and_accepts_input, legacy_tty_powershell_emits_output_and_accepts_input); 3 external calls (new, spawn, timeout).


##### `legacy_non_tty_cmd_emits_output`  (lines 153–189)

```
fn legacy_non_tty_cmd_emits_output()
```

**Purpose**: Checks that the legacy backend can launch a non-TTY `cmd.exe` process and capture its stdout successfully.

**Data flow**: Acquires the legacy-process test lock, builds a current-thread runtime, computes cwd and sandbox home, creates a workspace-write permission profile, spawns `cmd.exe /c echo LEGACY-NONTTY-CMD` through `spawn_windows_sandbox_session_legacy`, collects stdout and exit code with `collect_stdout_and_exit`, and asserts exit code 0 plus presence of the expected marker string.

**Call relations**: This is an end-to-end legacy backend test covering non-TTY process creation, stdout forwarding, and normal exit handling.

*Call graph*: calls 7 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, legacy_process_test_guard, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_non_tty_cmd_rejects_deny_read_overrides`  (lines 192–228)

```
fn legacy_non_tty_cmd_rejects_deny_read_overrides()
```

**Purpose**: Verifies that the legacy backend rejects deny-read overrides with the documented elevated-backend-only error.

**Data flow**: Acquires the test lock, builds a runtime, computes cwd and sandbox home, constructs an absolute deny-read fixture path, creates a workspace-write permission profile, attempts to spawn a simple non-TTY `cmd.exe` session with that deny-read override, expects an error, and asserts the error string contains the elevated-backend requirement message.

**Call relations**: This test exercises the early validation branch in the legacy backend before any process is launched.

*Call graph*: calls 7 internal fn (workspace_write, from_absolute_path, current_thread_runtime, legacy_process_test_guard, sandbox_cwd, sandbox_home, workspace_roots_for); 5 external calls (new, assert!, from_ref, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_non_tty_powershell_emits_output`  (lines 231–271)

```
fn legacy_non_tty_powershell_emits_output()
```

**Purpose**: Checks that the legacy backend can launch a non-TTY PowerShell process and capture its stdout.

**Data flow**: Skips if `pwsh_path()` returns `None`; otherwise acquires the test lock, builds a runtime, computes cwd and sandbox home, creates a workspace-write permission profile, spawns `pwsh -NoProfile -Command Write-Output LEGACY-NONTTY-DIRECT`, collects stdout and exit code, and asserts success plus presence of the expected output string.

**Call relations**: This complements the `cmd.exe` test by covering a more realistic shell process under the same non-TTY legacy path.

*Call graph*: calls 8 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `finish_driver_spawn_keeps_stdin_open_when_requested`  (lines 274–303)

```
fn finish_driver_spawn_keeps_stdin_open_when_requested()
```

**Purpose**: Verifies that `finish_driver_spawn` does not proactively close stdin when `stdin_open` is true.

**Data flow**: Builds a runtime, creates a one-slot stdin channel, stdout broadcast channel, and exit oneshot, constructs a minimal `ProcessDriver`, passes it to `super::finish_driver_spawn(..., true)`, sends `open` through the returned session writer sender, and asserts the original writer receiver gets that payload.

**Call relations**: This test targets the shared helper re-exported from `windows_common`, validating the positive branch of its stdin policy.

*Call graph*: calls 1 internal fn (current_thread_runtime); 2 external calls (assert_eq!, finish_driver_spawn).


##### `finish_driver_spawn_closes_stdin_when_not_requested`  (lines 306–337)

```
fn finish_driver_spawn_closes_stdin_when_not_requested()
```

**Purpose**: Verifies that `finish_driver_spawn` immediately closes stdin when `stdin_open` is false.

**Data flow**: Builds a runtime, creates minimal driver channels, calls `super::finish_driver_spawn(..., false)`, then attempts to send `closed` through the returned session writer sender and asserts that the send fails.

**Call relations**: This is the negative-branch companion to the previous test and confirms the invariant relied on by both backends.

*Call graph*: calls 1 internal fn (current_thread_runtime); 2 external calls (assert!, finish_driver_spawn).


##### `runner_stdin_writer_sends_close_stdin_after_input_eof`  (lines 340–383)

```
fn runner_stdin_writer_sends_close_stdin_after_input_eof()
```

**Purpose**: Checks that the runner stdin writer emits both a `Stdin` frame for input bytes and a trailing `CloseStdin` frame when the input channel closes.

**Data flow**: Builds a runtime, creates a temporary frame file, starts `super::start_runner_pipe_writer(file)` and `super::start_runner_stdin_writer(writer_rx, outbound_tx, false, true)`, sends `hello` on the stdin channel, drops the sender, awaits the writer task, reads frames with `wait_for_frame_count`, decodes the first frame's payload with `decode_bytes`, and asserts the frame sequence is `Message::Stdin("hello")` followed by `Message::CloseStdin`.

**Call relations**: This test exercises the shared elevated-backend IPC helper in isolation, especially its EOF behavior.

*Call graph*: calls 3 internal fn (decode_bytes, current_thread_runtime, wait_for_frame_count); 6 external calls (new, new, assert_eq!, panic!, start_runner_pipe_writer, start_runner_stdin_writer).


##### `runner_resizer_sends_resize_frame`  (lines 386–416)

```
fn runner_resizer_sends_resize_frame()
```

**Purpose**: Checks that the runner resizer closure serializes terminal dimensions into a `Resize` frame.

**Data flow**: Builds a runtime, creates a temporary frame file, starts `super::start_runner_pipe_writer(file)`, obtains a mutable resizer from `super::make_runner_resizer(outbound_tx)`, invokes it with rows 45 and cols 132, reads one frame with `wait_for_frame_count`, and asserts the decoded message is `Message::Resize` with those exact dimensions.

**Call relations**: This test validates the shared resize helper used only by the elevated backend's TTY sessions.

*Call graph*: calls 2 internal fn (current_thread_runtime, wait_for_frame_count); 6 external calls (new, new, assert_eq!, panic!, make_runner_resizer, start_runner_pipe_writer).


##### `legacy_capture_powershell_emits_output`  (lines 419–455)

```
fn legacy_capture_powershell_emits_output()
```

**Purpose**: Verifies that the higher-level capture API can run a PowerShell command through the legacy sandbox path and return its stdout and exit status.

**Data flow**: Skips if PowerShell is unavailable; otherwise acquires the test lock, computes cwd and sandbox home, creates a workspace-write permission profile, calls `run_windows_sandbox_capture` with a PowerShell `Write-Output LEGACY-CAPTURE-DIRECT` command and no cancellation token, then asserts exit code 0 and that stdout contains the expected marker.

**Call relations**: Unlike the direct session tests, this one exercises the capture-oriented API layered above unified exec, ensuring the legacy backend integrates correctly into that higher abstraction.

*Call graph*: calls 6 internal fn (workspace_write, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 7 external calls (new, from_utf8_lossy, assert!, assert_eq!, run_windows_sandbox_capture, println!, vec!).


##### `legacy_capture_cancellation_is_not_reported_as_timeout`  (lines 458–506)

```
fn legacy_capture_cancellation_is_not_reported_as_timeout()
```

**Purpose**: Verifies that cancelling a long-running legacy capture ends it promptly and does not incorrectly mark the result as timed out.

**Data flow**: Skips if PowerShell is unavailable; otherwise acquires the test lock, computes cwd and sandbox home, creates a workspace-write permission profile, builds an `Arc<AtomicBool>` cancellation flag and a `WindowsSandboxCancellationToken` that reads it, spawns a thread that flips the flag after 200 ms, runs `run_windows_sandbox_capture` on `Start-Sleep -Seconds 30` with a 30-second timeout and the cancellation token, joins the cancel thread, and asserts the call returned in under 10 seconds, `timed_out` is false, and the exit code is nonzero.

**Call relations**: This is a regression-style integration test for the capture layer's interaction with legacy process termination and timeout accounting.

*Call graph*: calls 7 internal fn (workspace_write, new, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 11 external calls (clone, new, new, new, now, assert!, assert_ne!, run_windows_sandbox_capture, eprintln!, spawn (+1 more)).


##### `legacy_tty_powershell_emits_output_and_accepts_input`  (lines 509–563)

```
fn legacy_tty_powershell_emits_output_and_accepts_input()
```

**Purpose**: Checks that the legacy backend's ConPTY path supports interactive PowerShell I/O: initial output, subsequent stdin commands, and clean exit.

**Data flow**: Skips if PowerShell is unavailable; otherwise acquires the test lock, builds a runtime, computes cwd and sandbox home, creates a workspace-write permission profile, spawns a TTY PowerShell session with `-NoExit -Command "$PID; Write-Output ready"`, sends `Write-Output second\n` and `exit\n` through the session writer, closes stdin, collects stdout and exit code, and asserts exit code 0 plus presence of both `ready` and `second` in stdout.

**Call relations**: This is the main interactive legacy backend test, covering ConPTY spawn, TTY newline handling, stdin forwarding, stdout capture, and orderly termination.

*Call graph*: calls 8 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, legacy_process_test_guard, pwsh_path, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_tty_cmd_emits_output_and_accepts_input`  (lines 567–614)

```
fn legacy_tty_cmd_emits_output_and_accepts_input()
```

**Purpose**: Documents the intended interactive `cmd.exe` behavior under the legacy ConPTY backend, though it is currently ignored in CI.

**Data flow**: Builds a runtime, computes cwd and sandbox home, creates a workspace-write permission profile, spawns a TTY `cmd.exe /K echo ready` session, sends `echo second\n` and `exit\n`, closes stdin, collects stdout and exit code, and asserts success plus both expected output markers.

**Call relations**: This ignored test mirrors the PowerShell TTY test but for `cmd.exe`, serving as a specification and regression target once the CI instability is resolved.

*Call graph*: calls 6 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


##### `legacy_tty_cmd_default_desktop_emits_output_and_accepts_input`  (lines 618–668)

```
fn legacy_tty_cmd_default_desktop_emits_output_and_accepts_input()
```

**Purpose**: Documents the intended interactive `cmd.exe` behavior when using the default desktop instead of a private desktop, though it is currently ignored in CI.

**Data flow**: Builds a runtime, computes cwd and sandbox home, creates a workspace-write permission profile, spawns a TTY `cmd.exe /K echo ready` session with `use_private_desktop` set to false, sends `echo second\n` and `exit\n`, closes stdin, collects stdout and exit code, and asserts success plus both expected output markers.

**Call relations**: This ignored test specifically covers the desktop-selection variant of the legacy ConPTY path, complementing the private-desktop `cmd.exe` test.

*Call graph*: calls 6 internal fn (workspace_write, collect_stdout_and_exit, current_thread_runtime, sandbox_cwd, sandbox_home, workspace_roots_for); 8 external calls (from_secs, new, from_utf8_lossy, assert!, assert_eq!, println!, spawn_windows_sandbox_session_legacy, vec!).


### `core/tests/suite/windows_sandbox.rs`

`test` · `sandbox execution and platform-specific integration testing`

This file exercises two distinct Windows sandbox modes through `process_exec_tool_call`. `EnvVarGuard` is a scoped helper that temporarily sets an environment variable and restores or removes it on drop; the tests use it to point `CODEX_HOME` at an isolated location. `TestCodexHome` abstracts over either a persistent path under `TEST_TMPDIR`—important for Bazel retries on the same VM—or a fresh `TempDir`, and `codex_home_for_windows_sandbox_test` chooses between those modes.

`stage_windows_sandbox_helpers` prepares the elevated sandbox helper executables by copying `codex-windows-sandbox-setup.exe` and `codex-command-runner.exe` into a `codex-resources` directory next to the current test binary. It tolerates `PermissionDenied` when the destination already exists, because a previous helper process may still have the file open during a retry.

The first async test proves that the unelevated `RestrictedToken` sandbox refuses to run when the policy contains deny-read restrictions, rather than silently running without enforcement. The second test stages helpers, creates secret/public files plus the sandbox setup marker path, runs a command under `WindowsSandboxLevel::Elevated`, and asserts from stdout that glob and exact deny-read rules block access, allowed reads still succeed, and the setup marker cannot be read or overwritten. It finishes by checking `sandbox_setup_is_complete` to ensure the tamper attempt did not break readiness state.

#### Function details

##### `EnvVarGuard::set`  (lines 31–37)

```
fn set(key: &'static str, value: &std::ffi::OsStr) -> Self
```

**Purpose**: Creates a scoped guard that sets an environment variable immediately and remembers its prior value for restoration. It is the test-safe entry point for temporarily overriding `CODEX_HOME`.

**Data flow**: It takes a static key and an `OsStr` value, reads the current value with `std::env::var_os`, writes the new value with `std::env::set_var`, and returns `EnvVarGuard { key, original }`. The stored `original` state is later consumed by `Drop` to restore the process environment.

**Call relations**: Both sandbox tests call this helper before invoking sandbox setup/execution so all filesystem state lands under the intended test home. It does not delegate to other local functions; its paired cleanup behavior is implemented in `EnvVarGuard::drop`.

*Call graph*: 2 external calls (set_var, var_os).


##### `EnvVarGuard::drop`  (lines 41–48)

```
fn drop(&mut self)
```

**Purpose**: Restores the guarded environment variable to its original state when the guard leaves scope. If the variable did not previously exist, it removes it entirely.

**Data flow**: On drop, it inspects `self.original`: when `Some(value)`, it writes that value back with `std::env::set_var`; when `None`, it removes the variable with `std::env::remove_var`. The only state it mutates is the process environment.

**Call relations**: This runs automatically after `EnvVarGuard::set` has been used in the tests and the guard variable goes out of scope. It is the cleanup half of the environment override pattern and requires no explicit caller action.

*Call graph*: 2 external calls (remove_var, set_var).


##### `TestCodexHome::path`  (lines 57–62)

```
fn path(&self) -> &Path
```

**Purpose**: Returns the filesystem path backing either a persistent or temporary test home. It hides whether the home is represented by a raw `PathBuf` or a `TempDir`.

**Data flow**: It matches on `self`: `Persistent(path)` yields `path.as_path()`, and `Temporary(temp_dir)` yields `temp_dir.path()`. It returns a borrowed `&Path` without modifying any state.

**Call relations**: The two sandbox tests use it when setting `CODEX_HOME` and when constructing the setup marker path. `codex_home_for_windows_sandbox_test` produces the enum value that this accessor normalizes.


##### `codex_home_for_windows_sandbox_test`  (lines 65–77)

```
fn codex_home_for_windows_sandbox_test(name: &str) -> anyhow::Result<TestCodexHome>
```

**Purpose**: Chooses a stable or temporary `CODEX_HOME` location for a Windows sandbox test, depending on whether Bazel-style `TEST_TMPDIR` is available. The stable-path branch is specifically designed to survive retried runs on the same VM.

**Data flow**: It takes a test name, checks `std::env::var_os("TEST_TMPDIR")`, and if present joins that root with the provided name, creates the directory tree, and returns `TestCodexHome::Persistent`. Otherwise it allocates a fresh `TempDir` and returns `TestCodexHome::Temporary`. Errors from directory creation or tempdir allocation are propagated as `anyhow::Result` with added context in the persistent case.

**Call relations**: Both async sandbox tests call it first to establish where sandbox setup state should live. The returned enum is then consumed through `TestCodexHome::path` and wrapped by `EnvVarGuard::set`.

*Call graph*: called by 2 (windows_elevated_enforces_deny_read_and_protects_setup_marker, windows_restricted_token_rejects_exact_and_glob_deny_read_policy); 6 external calls (from, new, Persistent, Temporary, var_os, create_dir_all).


##### `stage_windows_sandbox_helpers`  (lines 79–115)

```
fn stage_windows_sandbox_helpers() -> anyhow::Result<()>
```

**Purpose**: Copies the Windows sandbox helper executables into the runtime-visible `codex-resources` directory next to the current test binary. This prepares the elevated sandbox path to find its helper programs during execution.

**Data flow**: It resolves the current executable, derives its parent directory and a `codex-resources` subdirectory, creates that directory while tolerating an existing directory blocked by `PermissionDenied`, then iterates over the helper names `codex-windows-sandbox-setup` and `codex-command-runner`. For each helper it resolves the built binary via `cargo_bin`, copies it to `<resources>/<name>.exe`, and on copy failure tolerates `PermissionDenied` only if the destination already exists; all other failures are returned with contextualized error messages.

**Call relations**: Only `windows_elevated_enforces_deny_read_and_protects_setup_marker` invokes it, because the elevated sandbox path depends on these staged helpers. It is a prerequisite setup step before `process_exec_tool_call` can exercise elevated enforcement.

*Call graph*: called by 1 (windows_elevated_enforces_deny_read_and_protects_setup_marker); 5 external calls (new, cargo_bin, current_exe, copy, create_dir_all).


##### `windows_restricted_token_rejects_exact_and_glob_deny_read_policy`  (lines 119–197)

```
async fn windows_restricted_token_rejects_exact_and_glob_deny_read_policy() -> anyhow::Result<()>
```

**Purpose**: Verifies that the unelevated Windows restricted-token sandbox rejects execution when the filesystem policy includes deny-read entries, both glob-based and exact-path-based. The expected behavior is refusal to run rather than partial or unsandboxed execution.

**Data flow**: It creates an isolated `CODEX_HOME`, a temporary workspace, canonicalizes the workspace path, writes secret/public files, and builds a `FileSystemSandboxPolicy::restricted` containing root read, project-root write, a `**/*.env` deny rule, and an exact-path deny rule for a future file. It converts that policy plus restricted networking into a `PermissionProfile`, invokes `process_exec_tool_call` with a `cmd.exe /C` command under `WindowsSandboxLevel::RestrictedToken`, expects an error, and asserts the exact error string returned.

**Call relations**: This is a top-level serial async test. It depends on `codex_home_for_windows_sandbox_test` and `EnvVarGuard::set` for environment isolation, then delegates the actual sandbox execution attempt to `process_exec_tool_call`; the assertion confirms that the lower layer refuses unsupported deny-read enforcement in this mode.

*Call graph*: calls 5 internal fn (set, process_exec_tool_call, codex_home_for_windows_sandbox_test, from_runtime_permissions, restricted); 7 external calls (new, new, assert_eq!, canonicalize, write, from_ref, vec!).


##### `windows_elevated_enforces_deny_read_and_protects_setup_marker`  (lines 201–322)

```
async fn windows_elevated_enforces_deny_read_and_protects_setup_marker() -> anyhow::Result<()>
```

**Purpose**: Checks that the elevated Windows sandbox actually enforces deny-read rules and also prevents the sandboxed process from reading or tampering with the setup readiness marker under `CODEX_HOME/.sandbox`. It is the positive enforcement counterpart to the restricted-token refusal test.

**Data flow**: It allocates/stabilizes `CODEX_HOME`, stages helper executables, creates a workspace and files for glob-secret, exact-secret, and public content, and computes the setup marker path. It builds a restricted filesystem policy with root read, project-root write, glob deny for `**/*.env`, and exact deny for the exact-secret path, derives a `PermissionProfile`, and runs a compound `cmd.exe` command under `WindowsSandboxLevel::Elevated` that attempts to read denied files, read/write the setup marker, and read the public file. From the returned `ExecToolCallOutput` it asserts exit code 0 and inspects `stdout.text` for the expected DENIED/allowed markers, then separately asserts `sandbox_setup_is_complete(codex_home.path())` remains true.

**Call relations**: As the second top-level serial async test, it calls `codex_home_for_windows_sandbox_test`, `EnvVarGuard::set`, and `stage_windows_sandbox_helpers` before invoking `process_exec_tool_call`. Its assertions validate both the command-visible effects of the sandbox policy and the post-run integrity of the persisted setup marker.

*Call graph*: calls 6 internal fn (set, process_exec_tool_call, codex_home_for_windows_sandbox_test, stage_windows_sandbox_helpers, from_runtime_permissions, restricted); 8 external calls (new, new, assert!, assert_eq!, canonicalize, write, from_ref, vec!).


### `exec-server/testing/wine_exec_server.rs`

`test` · `test setup and scoped teardown`

This file exists solely to support integration tests that need a real Windows build of the exec-server running inside Wine. It defines a marker struct, `WineExecServer`, with one scoped lifecycle method. `WineExecServer::scope` resolves the `wine-windows-exec-server` test binary via `codex_utils_cargo_bin::cargo_bin`, starts it through `wine_test_support::WineTestCommand`, and forces `CODEX_HOME` to `C:\codex-home` so the Windows process sees a stable home directory inside the Wine environment. After spawning, it captures stdout and enters the command's own scoped lifetime wrapper so teardown is tied to the completion of the provided async closure. Inside that scope it reads stdout line-by-line with `tokio::io::BufReader::lines`, ignoring all output until it finds a line beginning with `ws://`; that line is treated as the server's listen URL. If stdout ends before such a line appears, the method raises a contextual error explaining that the server exited before reporting its URL. Once the URL is found, it invokes the caller's `FnOnce(String) -> Future<Output = Result<T>>`, awaits it, and then lets the surrounding command scope cleanly tear down the Wine-hosted server.

#### Function details

##### `WineExecServer::scope`  (lines 16–42)

```
async fn scope(self, operation: F) -> Result<T>
```

**Purpose**: Starts the Wine-hosted exec-server, waits until it prints its WebSocket URL, then runs a caller-provided async operation against that URL before the process is torn down.

**Data flow**: Consumes `self` and a one-shot closure `operation` that accepts the discovered URL string. It resolves the executable path, spawns a `WineTestCommand` with `CODEX_HOME` set, takes the child stdout, scans stdout lines until one starts with `ws://`, and passes that URL into `operation`. It returns the `Result<T>` produced by the operation, or an error if binary lookup, spawn, stdout reading, or URL discovery fails.

**Call relations**: This is the file's only public behavior and is intended to be called by Wine-based test runners. Internally it delegates process creation to `cargo_bin` and `WineTestCommand::new`, then relies on the command's scoped execution helper so the child process lifetime is bounded by the async closure.

*Call graph*: 3 external calls (new, new, cargo_bin).


### `core/tests/remote_env_windows/remote_env_windows_test.rs`

`test` · `integration test execution for remote Windows environment flows`

Both tests run inside `WineExecServer::scope`, which supplies a temporary exec-server URL representing a Windows environment exposed through Wine. The first test drives the lower-level `TestCodex` path end to end. It mounts a two-step SSE conversation on a mock Responses server: the model first emits an `exec_command` tool call with PowerShell command arguments, then a follow-up assistant message. The fixture is built with `Feature::UnifiedExec` enabled and the remote exec-server URL injected. Before submission, the test computes turn permission fields from `PermissionProfile::Disabled` and constructs `TurnEnvironmentSelections` pointing at `REMOTE_ENVIRONMENT_ID` with native Windows cwd `file:///C:/windows`. After submitting `Op::UserInput`, it loops on `wait_for_event`, capturing `ExecCommandBegin`, `ExecCommandEnd`, and `TurnComplete`, then asserts that the actual spawned command uses `pwsh.exe`, preserves the requested cwd semantics, exits successfully, and sends command output back to the model. The second test exercises the app-server protocol surface instead of direct Codex submission. It writes a mock responses config into a temporary Codex home, starts `TestAppServer` with `CODEX_EXEC_SERVER_URL_ENV_VAR`, initializes it under a timeout, sends `thread/start` with a Windows environment cwd, and checks the current placeholder behavior: host cwd and workspace roots are still returned, instruction sources are empty, and active permission profile is `None`. It then starts a turn and waits for `turn/completed`, proving the thread can execute successfully with the selected remote environment.

#### Function details

##### `windows_exec_server_runs_with_native_shell_and_cwd`  (lines 50–173)

```
async fn windows_exec_server_runs_with_native_shell_and_cwd() -> Result<()>
```

**Purpose**: Validates that a turn targeting the Windows remote environment executes through the native Windows shell with the requested native cwd and reports successful tool completion back to the model. It is effectively a smoke test for unified exec over Wine-backed remote execution.

**Data flow**: Inside `WineExecServer::scope`, it creates a mock SSE server, serializes an `exec_command` argument object containing the PowerShell command, mounts two SSE responses, builds a `TestCodex` fixture with unified-exec enabled and the provided exec-server URL, derives sandbox and permission fields, and constructs `TurnEnvironmentSelections` with `REMOTE_ENVIRONMENT_ID` and `file:///C:/windows` → submits `Op::UserInput` with those thread settings, loops over emitted `EventMsg`s until both `TurnComplete` and `ExecCommandEnd` are observed, then asserts on the begin/end event payloads and inspects the recorded model request for successful function-call output → returns `Result<()>`.

**Call relations**: The Tokio test harness invokes this as an end-to-end integration test. It orchestrates mock model responses, Codex execution, and event observation itself; the only delegated runtime wrapper is `WineExecServer::scope`, which provides the temporary remote exec-server endpoint.


##### `app_server_starts_thread_with_windows_environment_native_cwd`  (lines 176–252)

```
async fn app_server_starts_thread_with_windows_environment_native_cwd() -> Result<()>
```

**Purpose**: Checks the app-server protocol path for creating a thread with a selected Windows remote environment and then starting a turn on that thread. It verifies current response fields and ensures the thread remains usable even though some remote-environment metadata is still TODO-backed.

**Data flow**: Within `WineExecServer::scope`, it creates a temporary Codex home, starts a repeating mock responses server, writes mock config TOML, launches `TestAppServer::new_with_env` with `CODEX_EXEC_SERVER_URL_ENV_VAR`, and initializes the server under a timeout → sends `ThreadStartParams` containing a `TurnEnvironmentParams` entry for `REMOTE_ENVIRONMENT_ID` with native cwd `C:\windows`, waits for the matching response, deserializes `ThreadStartResponse`, and asserts thread id presence plus placeholder values for cwd, workspace roots, instruction sources, and permission profile. It then sends `TurnStartParams`, waits for `TurnStartResponse` and a `turn/completed` notification, and returns `Ok(())`.

**Call relations**: This is the higher-level companion to the direct Codex execution test above, invoked by the Tokio test harness. It drives the app-server request/response stream rather than internal event APIs, using timeouts to fail fast if initialization or turn processing stalls.


### RMCP remote client flows
This final group focuses on RMCP client-side harnesses and end-to-end remote execution paths over stdio and streamable HTTP transports.

### `rmcp-client/tests/streamable_http_test_support.rs`

`test` · `shared integration-test setup, fault injection, and teardown`

This support module underpins multiple Streamable HTTP integration test files, so it intentionally centralizes repetitive setup and fault-injection logic. It defines constants for the test server's control endpoints that can be POSTed to in order to arm failures on initialize requests, initialized notifications, or ordinary session POSTs. The `init_params` helper builds a consistent `InitializeRequestParams` advertising elicitation support, and `expected_echo_result` constructs the canonical `CallToolResult` shape expected from the test server's echo tool.

Client creation is split into local and remote variants. `create_client` uses the default test HTTP client, while `create_client_with_http_client` accepts any `Arc<dyn HttpClient>` and always initializes the returned `RmcpClient`. `create_remote_client` does the same using an `ExecServerClient`, wrapping it in `Arc` so all HTTP traffic goes through the remote runtime API. `call_echo_tool` standardizes the echo invocation and timeout.

For infrastructure, `spawn_streamable_http_server` binds an ephemeral localhost port, launches the `test_streamable_http_server` binary with `kill_on_drop(true)`, and waits for TCP readiness using `wait_for_streamable_http_server`, which also detects early child exit and deadline expiry. Remote-path tests use `spawn_exec_server`, which launches `codex exec-server --listen ws://127.0.0.1:0` in an isolated temporary `CODEX_HOME`, reads the emitted websocket URL from stdout, and connects an `ExecServerClient`. The `ExecServerProcess` wrapper owns the temp home, child process, and connected client, and best-effort kills the child on drop.

#### Function details

##### `streamable_http_server_bin`  (lines 53–55)

```
fn streamable_http_server_bin() -> Result<PathBuf, CargoBinError>
```

**Purpose**: Resolves the path to the `test_streamable_http_server` binary used by the Streamable HTTP integration tests.

**Data flow**: It takes no arguments, calls `codex_utils_cargo_bin::cargo_bin("test_streamable_http_server")`, and returns the resulting `PathBuf` or `CargoBinError`.

**Call relations**: Only `spawn_streamable_http_server` calls this helper before launching the test server process.

*Call graph*: called by 1 (spawn_streamable_http_server); 1 external calls (cargo_bin).


##### `init_params`  (lines 57–70)

```
fn init_params() -> InitializeRequestParams
```

**Purpose**: Builds the standard RMCP initialization payload used by the Streamable HTTP tests, including elicitation capability and fixed client identity.

**Data flow**: It creates default `ClientCapabilities`, sets `elicitation` to a `FormElicitationCapability` with `schema_validation: None`, constructs `InitializeRequestParams` with implementation name `codex-test`, version `0.0.0-test`, and title `Codex rmcp recovery test`, applies protocol version `V_2025_06_18`, and returns the struct.

**Call relations**: Both `initialize_client` and `create_remote_client` use this helper so local and remote test clients negotiate the same capabilities.

*Call graph*: called by 2 (create_remote_client, initialize_client); 3 external calls (default, new, new).


##### `expected_echo_result`  (lines 72–79)

```
fn expected_echo_result(message: &str) -> CallToolResult
```

**Purpose**: Constructs the canonical successful `CallToolResult` expected from the test server's `echo` tool. It standardizes assertions across many tests.

**Data flow**: It takes `message: &str`, creates `CallToolResult::success(Vec::new())`, sets `structured_content` to JSON `{ "echo": format!("ECHOING: {message}"), "env": null }`, and returns the modified result.

**Call relations**: Most Streamable HTTP tests compare actual tool-call results against this helper's output after invoking `call_echo_tool`.

*Call graph*: 3 external calls (new, json!, success).


##### `create_client`  (lines 81–84)

```
async fn create_client(base_url: &str) -> anyhow::Result<RmcpClient>
```

**Purpose**: Creates and initializes a local Streamable HTTP RMCP client using the default test HTTP client implementation.

**Data flow**: It takes `base_url: &str`, obtains `Environment::default_for_tests().get_http_client()`, forwards both into `create_client_with_http_client`, awaits the result, and returns the initialized `RmcpClient`.

**Call relations**: The majority of local Streamable HTTP tests call this convenience wrapper instead of constructing clients manually.

*Call graph*: calls 2 internal fn (default_for_tests, create_client_with_http_client); called by 11 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_initialize_retries_json_rpc_transient_status, streamable_http_initialize_retries_transient_http_status, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_retries_initialized_notification_status, streamable_http_tools_list_retries_json_rpc_transient_status (+1 more)).


##### `create_client_with_http_client`  (lines 86–106)

```
async fn create_client_with_http_client(
    base_url: &str,
    http_client: Arc<dyn HttpClient>,
) -> anyhow::Result<RmcpClient>
```

**Purpose**: Creates a Streamable HTTP RMCP client with a caller-supplied HTTP client and performs initialization before returning it. This allows tests to inject custom transport behavior while reusing common setup.

**Data flow**: It takes `base_url` and `http_client: Arc<dyn HttpClient>`, constructs an `RmcpClient` via `RmcpClient::new_streamable_http_client` using server name `test-streamable-http`, URL `{base_url}/mcp`, bearer token `test-bearer`, no extra headers, file-backed OAuth storage, default keyring backend, and the supplied HTTP client. It then awaits `initialize_client(&client)` and returns the initialized client.

**Call relations**: Fault-injection tests call this directly with `FailFirstInitializeHttpClient`; `create_client` delegates to it for the normal path.

*Call graph*: calls 3 internal fn (default, new_streamable_http_client, initialize_client); called by 3 (streamable_http_initialize_retries_remote_no_response_error, streamable_http_session_recovery_retries_initialize_failure, create_client); 1 external calls (format!).


##### `initialize_client`  (lines 108–126)

```
async fn initialize_client(client: &RmcpClient) -> anyhow::Result<()>
```

**Purpose**: Performs the standard RMCP initialization handshake for a Streamable HTTP client using the shared test parameters and an always-accept elicitation callback.

**Data flow**: It takes `&RmcpClient`, calls `client.initialize(init_params(), Some(Duration::from_secs(5)), Box::new(...))`, where the callback returns `ElicitationResponse { action: Accept, content: Some(json!({})), meta: None }`, awaits completion, and returns `Ok(())` on success.

**Call relations**: This helper is used by `create_client_with_http_client` and by the OAuth startup child test to ensure all tests initialize clients consistently.

*Call graph*: calls 2 internal fn (initialize, init_params); called by 2 (oauth_startup_child, create_client_with_http_client); 2 external calls (new, from_secs).


##### `create_remote_client`  (lines 130–165)

```
async fn create_remote_client(
    base_url: &str,
    http_client: ExecServerClient,
) -> anyhow::Result<RmcpClient>
```

**Purpose**: Creates and initializes a Streamable HTTP RMCP client whose HTTP transport is backed by a connected `ExecServerClient`. It is the remote-runtime counterpart to `create_client_with_http_client`.

**Data flow**: It takes `base_url: &str` and `http_client: ExecServerClient`, wraps the client in `Arc`, constructs an `RmcpClient` with server name `test-streamable-http-remote`, URL `{base_url}/mcp`, bearer token `test-bearer`, no extra headers, file-backed OAuth storage, and default keyring backend, then directly calls `client.initialize(...)` with `init_params()`, a 5-second timeout, and the standard always-accept elicitation callback. It returns the initialized client.

**Call relations**: The remote integration test calls this after `spawn_exec_server` so all MCP HTTP requests flow through the exec-server process.

*Call graph*: calls 3 internal fn (default, new_streamable_http_client, init_params); called by 1 (streamable_http_remote_client_round_trips_through_exec_server); 4 external calls (new, new, from_secs, format!).


##### `call_echo_tool`  (lines 167–179)

```
async fn call_echo_tool(
    client: &RmcpClient,
    message: &str,
) -> anyhow::Result<CallToolResult>
```

**Purpose**: Invokes the test server's `echo` tool with a standard JSON argument shape and timeout. It keeps the individual tests focused on behavior rather than request construction.

**Data flow**: It takes `&RmcpClient` and `message: &str`, calls `client.call_tool("echo".to_string(), Some(json!({ "message": message })), None, Some(Duration::from_secs(5)))`, awaits the result, and returns the resulting `CallToolResult` or error.

**Call relations**: Nearly every Streamable HTTP test uses this helper after client creation to validate successful operation or inspect surfaced errors.

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

**Purpose**: Configures the test HTTP server to fail upcoming session POST requests with a chosen status and optional `WWW-Authenticate` headers. It is the main fault-injection hook for post-initialize traffic.

**Data flow**: It takes `base_url`, `status`, `remaining`, and a slice of header strings, creates a fresh `reqwest::Client`, POSTs JSON to `{base_url}/test/control/session-post-failure` containing those fields, awaits the response, asserts the status is `204 NO_CONTENT`, and returns `Ok(())`.

**Call relations**: Many recovery and authorization tests call this before issuing a tool or `list_tools` request to force the next session operation(s) into a specific failure mode.

*Call graph*: calls 1 internal fn (new); called by 8 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_session_recovery_retries_initialize_failure, streamable_http_tools_list_retries_transient_http_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_session_post_json_rpc_failure`  (lines 201–226)

```
async fn arm_session_post_json_rpc_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Configures the test server to fail session POSTs with a chosen HTTP status and a JSON-RPC error body. This lets tests distinguish transport handling of structured error responses.

**Data flow**: It takes `base_url`, `status`, and `remaining`, POSTs JSON to the session-failure control endpoint with `content_type: "application/json"` and a serialized JSON-RPC error body, asserts the control response is `204 NO_CONTENT`, and returns `Ok(())`.

**Call relations**: The JSON-RPC session retry test uses this helper to arm a transient structured failure before repeating `list_tools`.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_tools_list_retries_json_rpc_transient_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_initialized_notification_post_json_rpc_failure`  (lines 228–255)

```
async fn arm_initialized_notification_post_json_rpc_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Configures the test server to fail the `notifications/initialized` POST with a chosen status and JSON-RPC error body. It targets the post-initialize notification phase specifically.

**Data flow**: It takes `base_url`, `status`, and `remaining`, POSTs a JSON control payload to `{base_url}/test/control/initialized-notification-post-failure`, asserts the response is `204 NO_CONTENT`, and returns `Ok(())`.

**Call relations**: The initialized-notification retry test calls this before creating the client so the startup sequence encounters the injected failure.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_retries_initialized_notification_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_initialize_post_failure`  (lines 257–273)

```
async fn arm_initialize_post_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Configures the test server to fail upcoming initialize POSTs with a chosen HTTP status. It is used to test startup retry behavior on plain transient statuses.

**Data flow**: It takes `base_url`, `status`, and `remaining`, POSTs JSON to `{base_url}/test/control/initialize-post-failure`, asserts the control response is `204 NO_CONTENT`, and returns `Ok(())`.

**Call relations**: The initialize-transient-status retry test uses this helper before creating the client.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_initialize_retries_transient_http_status); 3 external calls (assert_eq!, format!, json!).


##### `arm_initialize_post_json_rpc_failure`  (lines 275–300)

```
async fn arm_initialize_post_json_rpc_failure(
    base_url: &str,
    status: u16,
    remaining: usize,
) -> anyhow::Result<()>
```

**Purpose**: Configures the test server to fail initialize POSTs with a chosen HTTP status and JSON-RPC error body. This supports startup retry tests for structured error responses.

**Data flow**: It takes `base_url`, `status`, and `remaining`, POSTs a JSON payload to the initialize-failure control endpoint including `content_type: "application/json"` and a serialized JSON-RPC error body, asserts `204 NO_CONTENT`, and returns `Ok(())`.

**Call relations**: The initialize JSON-RPC retry test calls this helper before client creation.

*Call graph*: calls 1 internal fn (new); called by 1 (streamable_http_initialize_retries_json_rpc_transient_status); 3 external calls (assert_eq!, format!, json!).


##### `spawn_streamable_http_server`  (lines 302–316)

```
async fn spawn_streamable_http_server() -> anyhow::Result<(Child, String)>
```

**Purpose**: Launches the standalone Streamable HTTP test server on an ephemeral localhost port and waits until it is reachable. It returns both the child process handle and the base URL.

**Data flow**: It binds a temporary `TcpListener` to `127.0.0.1:0` to reserve a free port, reads the assigned port, drops the listener, formats `bind_addr` and `base_url`, spawns `test_streamable_http_server` with `kill_on_drop(true)` and environment variable `MCP_STREAMABLE_HTTP_BIND_ADDR`, then awaits `wait_for_streamable_http_server(&mut child, &bind_addr, Duration::from_secs(5))`. On success it returns `(Child, String)`.

**Call relations**: All Streamable HTTP integration tests call this helper first to obtain a fresh isolated server instance. It delegates readiness polling to `wait_for_streamable_http_server`.

*Call graph*: calls 2 internal fn (streamable_http_server_bin, wait_for_streamable_http_server); called by 14 (streamable_http_401_does_not_trigger_recovery, streamable_http_403_finds_bearer_challenge_in_later_header_value, streamable_http_403_scope_challenge_returns_insufficient_scope, streamable_http_404_recovery_only_retries_once, streamable_http_404_session_expiry_recovers_and_retries_once, streamable_http_initialize_retries_json_rpc_transient_status, streamable_http_initialize_retries_remote_no_response_error, streamable_http_initialize_retries_transient_http_status, streamable_http_non_session_failure_does_not_trigger_recovery, streamable_http_retries_initialized_notification_status (+4 more)); 4 external calls (from_secs, bind, new, format!).


##### `ExecServerProcess::drop`  (lines 327–329)

```
fn drop(&mut self)
```

**Purpose**: Best-effort cleanup hook that kills the spawned exec-server process when the owning test helper is dropped.

**Data flow**: It takes `&mut self` and calls `self.child.start_kill()`, ignoring the result. It mutates only the child process state.

**Call relations**: This runs automatically for values returned by `spawn_exec_server`, ensuring remote-path tests do not leave background exec-server processes behind.

*Call graph*: 1 external calls (start_kill).


##### `spawn_exec_server`  (lines 333–356)

```
async fn spawn_exec_server() -> anyhow::Result<ExecServerProcess>
```

**Purpose**: Starts a real local `codex exec-server`, waits for it to print its websocket listen URL, and connects an initialized `ExecServerClient`. It packages the process, temp home, and client together for remote transport tests.

**Data flow**: It creates a temporary `CODEX_HOME`, spawns `codex exec-server --listen ws://127.0.0.1:0` with stdin null, stdout piped, stderr inherited, `kill_on_drop(true)`, and the temp home in the environment, then awaits `read_exec_server_listen_url(&mut child)` to obtain the websocket URL. It connects `ExecServerClient::connect_websocket(RemoteExecServerConnectArgs::new(websocket_url, "rmcp-client-remote-http-test".to_string()))`, awaits the connection, and returns `ExecServerProcess { _codex_home, child, client }`.

**Call relations**: The remote Streamable HTTP integration test calls this helper before `create_remote_client`. It depends on `read_exec_server_listen_url` to discover the dynamically assigned websocket endpoint.

*Call graph*: calls 1 internal fn (read_exec_server_listen_url); called by 1 (streamable_http_remote_client_round_trips_through_exec_server); 8 external calls (inherit, null, piped, new, new, cargo_bin, connect_websocket, new).


##### `read_exec_server_listen_url`  (lines 359–382)

```
async fn read_exec_server_listen_url(child: &mut Child) -> anyhow::Result<String>
```

**Purpose**: Reads stdout from a spawned exec-server until it emits a websocket listen URL or a timeout occurs. It turns the server's startup log line into a concrete connection target.

**Data flow**: It takes `&mut Child`, extracts `child.stdout` with `.take()` and errors if unavailable, wraps it in `BufReader`, computes a deadline 10 seconds in the future, and loops reading lines with `tokio::time::timeout(remaining, lines.next_line())`. If time expires it bails; if stdout closes early it errors with context; when a trimmed line starts with `ws://`, it returns that line as a `String`.

**Call relations**: Only `spawn_exec_server` calls this helper during remote test setup.

*Call graph*: called by 1 (spawn_exec_server); 5 external calls (new, from_secs, now, bail!, timeout).


##### `wait_for_streamable_http_server`  (lines 384–423)

```
async fn wait_for_streamable_http_server(
    server_child: &mut Child,
    address: &str,
    timeout: Duration,
) -> anyhow::Result<()>
```

**Purpose**: Polls for TCP readiness of the spawned Streamable HTTP server while also detecting early process exit and enforcing an overall timeout. It prevents tests from racing ahead before the server is listening.

**Data flow**: It takes `server_child: &mut Child`, `address: &str`, and `timeout: Duration`, computes a deadline, and loops until success or failure. Each iteration first checks `server_child.try_wait()` for early exit, then computes remaining time and errors if exhausted, then attempts `tokio::time::timeout(remaining, TcpStream::connect(address))`. A successful connection returns `Ok(())`; a connection error retries unless the deadline has passed; a timeout on the connect call returns an error immediately. Between retries it sleeps 50 ms.

**Call relations**: `spawn_streamable_http_server` delegates readiness detection to this helper after spawning the child process.

*Call graph*: called by 1 (spawn_streamable_http_server); 7 external calls (try_wait, from_millis, now, connect, anyhow!, sleep, timeout).


### `rmcp-client/tests/streamable_http_remote.rs`

`test` · `integration test execution across remote HTTP transport setup and request handling`

This integration test is intentionally narrow and high-value: it validates the remote transport path rather than the direct local `reqwest` path already covered elsewhere. The test starts two real components using shared support helpers: the Streamable HTTP MCP test server and a local `codex exec-server` process that exposes the remote HTTP API. It then creates an RMCP client with `create_remote_client`, passing the exec-server's connected `ExecServerClient` so the RMCP transport performs HTTP requests through the executor-backed runtime instead of directly from the test process.

After initialization, the test performs a single echo tool call and compares the returned `CallToolResult` against the canonical expected structure from `expected_echo_result("remote")`. That assertion checks not just that the call succeeded, but that the remote path preserves the normal RMCP response shape and structured content. Because the helper initializes the client before returning it, this test effectively covers remote transport creation, session initialization, request forwarding through exec-server, and response propagation back into the RMCP client API.

#### Function details

##### `streamable_http_remote_client_round_trips_through_exec_server`  (lines 21–37)

```
async fn streamable_http_remote_client_round_trips_through_exec_server() -> anyhow::Result<()>
```

**Purpose**: Starts a real Streamable HTTP test server and a real exec-server, creates an RMCP client that routes HTTP through the exec-server, and verifies a tool call round-trips successfully. It is the primary end-to-end proof that the remote adapter path works.

**Data flow**: It awaits `spawn_streamable_http_server()` to get the MCP server child and base URL, awaits `spawn_exec_server()` to get an `ExecServerProcess` containing a connected `ExecServerClient`, passes the base URL and cloned exec-server client into `create_remote_client(...)`, then calls `call_echo_tool(&client, "remote")`. It asserts the returned `CallToolResult` equals `expected_echo_result("remote")` and returns `Ok(())`.

**Call relations**: This top-level test composes the shared support helpers for server startup, remote client creation, and echo-call assertion. It specifically exercises `create_remote_client`, unlike the local Streamable HTTP tests that use `create_client`.

*Call graph*: calls 4 internal fn (call_echo_tool, create_remote_client, spawn_exec_server, spawn_streamable_http_server); 1 external calls (assert_eq!).


### `rmcp-client/tests/process_group_cleanup.rs`

`test` · `integration test execution and teardown`

This integration test file focuses on cleanup behavior for stdio-backed RMCP servers on Unix. It defines small helpers to locate the `test_stdio_server` binary, build a consistent `InitializeRequestParams`, probe whether a PID still exists using `kill -0`, and poll for PID-file creation or process exit with bounded retries. Those polling helpers deliberately tolerate startup races: `wait_for_pid_file` retries when the file is missing or temporarily empty, and both wait loops sleep in 100 ms increments for up to roughly five seconds before failing with contextual `anyhow` errors.

The first test launches `/bin/sh -c 'sleep 300 & ...; cat >/dev/null'` through `RmcpClient::new_stdio_client`, using an env var to tell the shell where to write the spawned background child's PID. After confirming the grandchild is alive, it drops the client and asserts that the background process exits, demonstrating that the wrapper process group is killed rather than only the immediate shell.

The second test uses the real `test_stdio_server`, initializes the RMCP session with an elicitation callback that always accepts, starts a long-running `call_tool("sync", { sleep_after_ms: 300_000 })` in a spawned task, then invokes `shutdown()`. It verifies that shutdown terminates the initialized server process and that the in-flight task completes promptly instead of hanging indefinitely.

#### Function details

##### `stdio_server_bin`  (lines 23–25)

```
fn stdio_server_bin() -> Result<std::path::PathBuf>
```

**Purpose**: Resolves the path to the `test_stdio_server` test binary. It wraps the cargo-bin lookup in an `anyhow::Result` for convenient use in async tests.

**Data flow**: It takes no arguments, calls `codex_utils_cargo_bin::cargo_bin("test_stdio_server")`, converts any error with `Into::into`, and returns a `PathBuf` on success.

**Call relations**: Only the initialized-shutdown test uses this helper when it needs to launch the dedicated RMCP test server rather than a shell wrapper.

*Call graph*: called by 1 (shutdown_kills_initialized_stdio_server_with_in_flight_operation); 1 external calls (cargo_bin).


##### `init_params`  (lines 27–33)

```
fn init_params() -> InitializeRequestParams
```

**Purpose**: Builds the initialization payload shared by the stdio cleanup tests. It fixes the client identity and protocol version used during RMCP handshake.

**Data flow**: It creates default `ClientCapabilities`, constructs an `Implementation` named `codex-test` with version `0.0.0-test` and a descriptive title, wraps them in `InitializeRequestParams::new`, applies `ProtocolVersion::V_2025_06_18`, and returns the resulting struct.

**Call relations**: The shutdown test passes this into `client.initialize(...)` before exercising cleanup of an initialized session with active work.

*Call graph*: called by 1 (shutdown_kills_initialized_stdio_server_with_in_flight_operation); 3 external calls (default, new, new).


##### `process_exists`  (lines 35–43)

```
fn process_exists(pid: u32) -> bool
```

**Purpose**: Checks whether a Unix process ID currently exists by invoking `kill -0`. It treats command failures conservatively as 'does not exist'.

**Data flow**: It takes a `u32` PID, spawns `std::process::Command::new("kill")` with arguments `-0` and the PID string, suppresses stderr with `Stdio::null()`, and maps the exit status to a boolean. If spawning or waiting fails, it returns `false` via `unwrap_or(false)`.

**Call relations**: The polling helper `wait_for_process_exit` repeatedly calls this to decide when cleanup has completed.

*Call graph*: called by 1 (wait_for_process_exit); 2 external calls (new, null).


##### `wait_for_pid_file`  (lines 45–70)

```
async fn wait_for_pid_file(path: &Path) -> Result<u32>
```

**Purpose**: Polls a file until it contains a parseable child PID. It smooths over races where the file is not yet created or has been created but not yet populated.

**Data flow**: It takes a `&Path`, loops up to 50 times, and on each iteration tries `fs::read_to_string(path)`. Missing files trigger a 100 ms async sleep and retry; empty trimmed content also sleeps and retries; non-empty content is parsed as `u32` with contextual error reporting; other I/O errors are returned with path context. If no PID is obtained after all retries, it returns a timeout error via `anyhow::bail!`.

**Call relations**: Both cleanup tests use this helper after launching a process to discover the server or grandchild PID written by the child side.

*Call graph*: called by 2 (drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation); 4 external calls (from_millis, bail!, read_to_string, sleep).


##### `wait_for_process_exit`  (lines 72–81)

```
async fn wait_for_process_exit(pid: u32) -> Result<()>
```

**Purpose**: Waits for a process to disappear within a bounded timeout. It is the final assertion helper for cleanup semantics.

**Data flow**: It takes a PID, loops up to 50 times, calls `process_exists(pid)` each time, and returns `Ok(())` as soon as the process no longer exists. Otherwise it sleeps 100 ms between checks and eventually returns a timeout error if the PID is still alive.

**Call relations**: The two main tests call this after dropping or shutting down the client to verify that process-group termination actually happened.

*Call graph*: calls 1 internal fn (process_exists); called by 2 (drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation); 3 external calls (from_millis, bail!, sleep).


##### `drop_kills_wrapper_process_group`  (lines 84–116)

```
async fn drop_kills_wrapper_process_group() -> Result<()>
```

**Purpose**: Proves that dropping a stdio RMCP client kills the entire launched wrapper process group, not just the immediate parent process. The test uses a shell that spawns a long-lived background child to make that distinction observable.

**Data flow**: It creates a temp directory and PID-file path, launches `/bin/sh` via `RmcpClient::new_stdio_client` with a script that backgrounds `sleep 300`, writes the child PID to `$CHILD_PID_FILE`, and then blocks on stdin. It passes an env override map containing `CHILD_PID_FILE`, waits for the PID file, asserts the grandchild exists, drops the client handle, and then awaits `wait_for_process_exit(grandchild_pid)`.

**Call relations**: This is a top-level integration test of the stdio launcher/drop path. It depends on `wait_for_pid_file` and `wait_for_process_exit` to observe the side effects of `RmcpClient::new_stdio_client` and subsequent `drop(client)`.

*Call graph*: calls 4 internal fn (new_stdio_client, new, wait_for_pid_file, wait_for_process_exit); 7 external calls (new, from, from, assert!, current_dir, tempdir, vec!).


##### `shutdown_kills_initialized_stdio_server_with_in_flight_operation`  (lines 119–180)

```
async fn shutdown_kills_initialized_stdio_server_with_in_flight_operation() -> Result<()>
```

**Purpose**: Verifies that explicit client shutdown terminates an initialized stdio server even while a long-running tool call is in flight. It also checks that the spawned task finishes promptly after shutdown rather than hanging.

**Data flow**: It creates a temp directory and server PID-file path, launches `test_stdio_server` with `RmcpClient::new_stdio_client`, wraps the client in `Arc`, initializes it using `init_params()` and an elicitation callback that returns `ElicitationResponse { action: Accept, content: Some({}), meta: None }`, waits for the server PID file, and asserts the server process exists. It then clones the `Arc`, spawns a task that calls tool `sync` with JSON args `{ "sleep_after_ms": 300_000 }` and a long timeout, sleeps briefly to ensure the call is in flight, invokes `client.shutdown().await`, waits for the server process to exit, and finally waits up to five seconds for the spawned call task to complete.

**Call relations**: This test drives the full initialized-session shutdown path rather than relying on drop semantics. It uses `stdio_server_bin`, `init_params`, `wait_for_pid_file`, and `wait_for_process_exit` to set up and verify the behavior around `initialize`, `call_tool`, and `shutdown`.

*Call graph*: calls 6 internal fn (new_stdio_client, new, init_params, stdio_server_bin, wait_for_pid_file, wait_for_process_exit); 15 external calls (clone, new, new, from_millis, from_secs, from, from, new, assert!, json! (+5 more)).
