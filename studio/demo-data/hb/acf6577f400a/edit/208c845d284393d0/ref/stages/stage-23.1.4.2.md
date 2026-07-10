# App-server integration suites — transport, protocol contracts, and client connection behavior  `stage-23.1.4.2`

This stage is a set of end-to-end checks for how the app server talks to clients in real time. It sits in the system’s “main work loop”: once the server is running, these tests make sure connections open correctly, carry the right information, and behave safely when things go wrong.

The websocket connection tests are the foundation. They check that each client connection is kept in the right scope, that health-check web pages respond, that different login rules work, and that reconnecting does not confuse which worker thread is loaded. The Unix-only websocket tests add operating-system signal cases, such as shutting down or restarting the server while work is still in progress, and confirm clients see a clean disconnect.

The attestation tests focus on trust at the start of a connection. They verify that a client can be asked for a proof token and that the server forwards it in the websocket handshake header. The experimental API tests make sure hidden or in-progress features stay blocked unless the client explicitly opts in. Finally, the realtime conversation tests tie many features together, covering full live conversations over WebSocket and WebRTC, protocol version differences, event translation, and background agent turns.

## Files in this stage

### Websocket connection lifecycle
These tests establish the core websocket transport behavior, then extend it with Unix-specific shutdown and restart scenarios.

### `app-server/tests/suite/v2/connection_handling_websocket.rs`

`test` · `startup and request handling`

This file serves two roles: it contains end-to-end websocket transport tests, and it exports a set of `pub(super)` helpers used by other v2 test modules. The tests launch the real `codex-app-server` binary as a subprocess with `--listen`, parse its bound websocket address from stderr, and then interact with it using `tokio_tungstenite`. The helper type alias `WsClient` standardizes the websocket stream type, while `DEFAULT_READ_TIMEOUT` is tuned for slower CI environments.

The transport tests cover per-connection request routing and initialization state, HTTP `/readyz` and `/healthz` served on the same listener, browser-origin rejection without auth, capability-token auth, signed short-lived bearer-token auth, startup rejection for too-short signing secrets, startup rejection for unauthenticated non-loopback listeners, and persistence of the last loaded thread across disconnect/reconnect until idle timeout. Authentication helpers build websocket handshake requests with optional `Authorization` and `Origin` headers, and `signed_bearer_token` constructs HS256 JWT-like tokens for the signed-bearer tests.

The helper layer includes subprocess spawning, retrying websocket and HTTP connection attempts until the listener is ready, JSON-RPC send/read utilities, silence assertions, and convenience wrappers for initialize, thread start, and loaded-thread listing. `read_jsonrpc_message` is careful about websocket control frames: it replies to pings with pongs, ignores pongs and raw frame variants, and treats close or binary frames as errors. `connectable_bind_addr` rewrites unspecified listener addresses like `0.0.0.0` or `::` to loopback equivalents so tests can connect reliably.

#### Function details

##### `websocket_transport_routes_per_connection_handshake_and_responses`  (lines 63–105)

```
async fn websocket_transport_routes_per_connection_handshake_and_responses() -> Result<()>
```

**Purpose**: Verifies websocket initialization and subsequent JSON-RPC responses are scoped to the connection that issued the request. It also checks that uninitialized connections receive `Not initialized` errors and that identical request ids on different sockets do not collide.

**Data flow**: Creates config and spawns the websocket server, opens two websocket clients, sends initialize on `ws1` and reads its response, asserts `ws2` receives no message, sends `config/read` on uninitialized `ws2` and reads an error with message `Not initialized`, initializes `ws2`, then sends `config/read` with id 77 on both sockets and reads separate responses from each. It asserts both responses carry id 77 and contain a `config` object, then kills the subprocess.

**Call relations**: Invoked by the test harness. It relies heavily on the helper stack—`spawn_websocket_server`, `connect_websocket`, `send_initialize_request`, `send_config_read_request`, `read_response_for_id`, `read_error_for_id`, and `assert_no_message`—to express the transport-scoping contract.

*Call graph*: calls 8 internal fn (assert_no_message, connect_websocket, create_config_toml, read_error_for_id, read_response_for_id, send_config_read_request, send_initialize_request, spawn_websocket_server); 6 external calls (from_millis, new, new, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!).


##### `websocket_transport_serves_health_endpoints_on_same_listener`  (lines 108–132)

```
async fn websocket_transport_serves_health_endpoints_on_same_listener() -> Result<()>
```

**Purpose**: Checks that the websocket listener also serves HTTP health endpoints and still accepts websocket traffic. It validates listener multiplexing between HTTP and websocket protocols.

**Data flow**: Creates config, spawns the websocket server, constructs a `reqwest::Client`, performs `GET /readyz` and `GET /healthz` via `http_get`, asserts both return `StatusCode::OK`, then opens a websocket connection, sends initialize, reads the response, asserts the id matches, and kills the subprocess.

**Call relations**: Run by the harness. It combines the HTTP retry helper `http_get` with the websocket helpers to prove both protocols are available on the same bound address.

*Call graph*: calls 7 internal fn (connect_websocket, create_config_toml, http_get, read_response_for_id, send_initialize_request, spawn_websocket_server, new); 4 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!).


##### `websocket_transport_rejects_browser_origin_without_auth`  (lines 135–161)

```
async fn websocket_transport_rejects_browser_origin_without_auth() -> Result<()>
```

**Purpose**: Verifies that a browser-style `Origin` header from a non-loopback site is rejected when no websocket auth is configured. It protects the listener against unauthenticated browser-origin access.

**Data flow**: Starts the websocket server, first confirms a normal loopback websocket connection can initialize successfully, then drops that socket and attempts a new websocket handshake with `Origin: https://evil.example` and no bearer token. It expects an HTTP 403 rejection from `assert_websocket_connect_rejected_with_headers`, then kills the subprocess.

**Call relations**: Invoked by the harness. It uses a successful baseline connection before exercising the rejection path, and delegates the handshake-status assertion to `assert_websocket_connect_rejected_with_headers`.

*Call graph*: calls 6 internal fn (assert_websocket_connect_rejected_with_headers, connect_websocket, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server); 4 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!).


##### `websocket_transport_rejects_missing_and_invalid_capability_tokens`  (lines 164–193)

```
async fn websocket_transport_rejects_missing_and_invalid_capability_tokens() -> Result<()>
```

**Purpose**: Checks capability-token authentication: missing or wrong bearer tokens must be rejected, while the configured token is accepted. It validates the token-file auth mode end to end.

**Data flow**: Writes a token file containing `super-secret-token`, creates config, spawns the websocket server with `--ws-auth capability-token --ws-token-file <file>` on `ws://0.0.0.0:0`, attempts websocket connections with no token and with `wrong-token` and expects rejection, then connects with bearer token `super-secret-token`, sends initialize, reads the response, asserts the id, and kills the subprocess.

**Call relations**: Called by the harness. It depends on `spawn_websocket_server_with_args` for auth-mode startup and on `assert_websocket_connect_rejected` / `connect_websocket_with_bearer` for the handshake checks.

*Call graph*: calls 6 internal fn (assert_websocket_connect_rejected, connect_websocket_with_bearer, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server_with_args); 6 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!, write, vec!).


##### `websocket_transport_verifies_signed_short_lived_bearer_tokens`  (lines 196–290)

```
async fn websocket_transport_verifies_signed_short_lived_bearer_tokens() -> Result<()>
```

**Purpose**: Exercises signed bearer-token authentication with expiry, not-before, issuer, audience, and signature validation. It proves only correctly signed and timely tokens are accepted.

**Data flow**: Writes a 32-byte shared secret file, creates config, spawns the websocket server with signed-bearer auth arguments including issuer, audience, and max clock skew, then generates several tokens with `signed_bearer_token`: expired, malformed, not-yet-valid, wrong issuer, wrong audience, wrong signature, and valid. It asserts all invalid tokens are rejected, connects successfully with the valid token, sends initialize, reads the response, asserts the id, and kills the subprocess.

**Call relations**: Invoked by the harness. It uses `signed_bearer_token` to synthesize test credentials and `assert_websocket_connect_rejected` / `connect_websocket_with_bearer` to drive the handshake outcomes.

*Call graph*: calls 7 internal fn (assert_websocket_connect_rejected, connect_websocket_with_bearer, create_config_toml, read_response_for_id, send_initialize_request, signed_bearer_token, spawn_websocket_server_with_args); 8 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!, format!, json!, write, vec!).


##### `websocket_transport_rejects_short_signed_bearer_secret_configuration`  (lines 293–322)

```
async fn websocket_transport_rejects_short_signed_bearer_secret_configuration() -> Result<()>
```

**Purpose**: Checks server startup fails when signed-bearer auth is configured with a secret shorter than 32 bytes. This validates startup-time configuration hardening rather than handshake-time behavior.

**Data flow**: Writes a too-short shared secret file and config, runs the websocket server to completion with signed-bearer auth arguments using `run_websocket_server_to_completion_with_args`, asserts the process exits unsuccessfully, decodes stderr as UTF-8, and asserts it contains `must be at least 32 bytes`.

**Call relations**: Run by the harness as a startup validation test. It bypasses the normal spawn-and-connect helpers because the expected outcome is immediate process failure.

*Call graph*: calls 2 internal fn (create_config_toml, run_websocket_server_to_completion_with_args); 6 external calls (from_utf8, new, new, create_mock_responses_server_sequence_unchecked, assert!, write).


##### `websocket_transport_rejects_unauthenticated_non_loopback_startup`  (lines 325–344)

```
async fn websocket_transport_rejects_unauthenticated_non_loopback_startup() -> Result<()>
```

**Purpose**: Verifies the server refuses to start a non-loopback websocket listener without authentication. It enforces a startup safety invariant for exposed listeners.

**Data flow**: Creates config, runs the websocket server to completion with listen URL `ws://0.0.0.0:0` and no auth args, asserts the process exits unsuccessfully, decodes stderr, and checks it contains `refusing to start non-loopback websocket listener`.

**Call relations**: Invoked by the harness. Like the short-secret test, it uses `run_websocket_server_to_completion_with_args` because the expected behavior is startup failure before any client connects.

*Call graph*: calls 2 internal fn (create_config_toml, run_websocket_server_to_completion_with_args); 5 external calls (from_utf8, new, new, create_mock_responses_server_sequence_unchecked, assert!).


##### `websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout`  (lines 347–376)

```
async fn websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout() -> Result<()>
```

**Purpose**: Checks that after a websocket client disconnects, its last loaded thread remains visible to a reconnecting client until the server’s idle timeout expires. It validates temporary retention of loaded-thread state across reconnects.

**Data flow**: Creates config and spawns the websocket server, connects `ws1`, initializes it, starts a thread, asserts the loaded-thread list contains that thread, closes `ws1`, connects `ws2`, initializes it, and repeatedly requests loaded threads until the same thread id appears. It then kills the subprocess.

**Call relations**: Called by the harness. It uses `start_thread`, `assert_loaded_threads`, and `wait_for_loaded_threads` to express the before-disconnect and after-reconnect observations.

*Call graph*: calls 8 internal fn (assert_loaded_threads, connect_websocket, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server, start_thread, wait_for_loaded_threads); 3 external calls (new, new, create_mock_responses_server_sequence_unchecked).


##### `spawn_websocket_server`  (lines 378–380)

```
async fn spawn_websocket_server(codex_home: &Path) -> Result<(Child, SocketAddr)>
```

**Purpose**: Starts the app-server websocket listener on loopback with default arguments and returns the child process plus bound socket address. It is the common subprocess launcher used by websocket-based tests.

**Data flow**: Accepts a CODEX_HOME path and forwards it to `spawn_websocket_server_with_args` with listen URL `ws://127.0.0.1:0` and no extra args. It returns the spawned `tokio::process::Child` and parsed `SocketAddr`.

**Call relations**: Used by tests in this file and by other modules such as command-exec and Unix signal-handling tests. It is a thin convenience wrapper over `spawn_websocket_server_with_args`.

*Call graph*: calls 1 internal fn (spawn_websocket_server_with_args); called by 8 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, start_ctrl_c_restart_fixture, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads).


##### `spawn_websocket_server_with_args`  (lines 382–455)

```
async fn spawn_websocket_server_with_args(
    codex_home: &Path,
    listen_url: &str,
    extra_args: &[String],
) -> Result<(Child, SocketAddr)>
```

**Purpose**: Launches the real `codex-app-server` binary with websocket listener arguments, waits until it reports its bound address on stderr, and returns the running child plus parsed socket address. It is the core subprocess bootstrap helper for websocket integration tests.

**Data flow**: Builds a `tokio::process::Command` for the cargo-built `codex-app-server`, adds `--listen`, disables plugin startup tasks, appends extra args, nulls stdin/stdout, pipes stderr, sets `CODEX_HOME` and `RUST_LOG`, and spawns the child with `kill_on_drop(true)`. It then reads stderr lines through `BufReader::lines()` until timeout, strips ANSI escape sequences from each line, scans whitespace tokens for a `ws://<addr>` prefix, parses the first valid `SocketAddr`, spawns a background task to continue echoing remaining stderr lines, and returns `(process, bind_addr)`.

**Call relations**: Called directly by auth-related tests and indirectly through `spawn_websocket_server`. Other modules reuse it when they need a real websocket listener with custom auth flags.

*Call graph*: called by 3 (spawn_websocket_server, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_verifies_signed_short_lived_bearer_tokens); 11 external calls (new, now, null, piped, with_capacity, new, cargo_bin, eprintln!, matches!, spawn (+1 more)).


##### `connect_websocket`  (lines 457–459)

```
async fn connect_websocket(bind_addr: SocketAddr) -> Result<WsClient>
```

**Purpose**: Connects to the websocket listener without authentication. It is the default client constructor for tests that do not need bearer tokens.

**Data flow**: Accepts a bound socket address and forwards it to `connect_websocket_with_bearer` with `None` for the bearer token. It returns an established `WsClient`.

**Call relations**: Used throughout this file and by sibling test modules. It is a convenience wrapper over the more general authenticated connector.

*Call graph*: calls 1 internal fn (connect_websocket_with_bearer); called by 8 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, start_ctrl_c_restart_fixture, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads).


##### `connect_websocket_with_bearer`  (lines 461–479)

```
async fn connect_websocket_with_bearer(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
) -> Result<WsClient>
```

**Purpose**: Attempts to establish a websocket connection, optionally with a bearer token, retrying until the listener is ready or the timeout expires. It normalizes unspecified bind addresses to loopback before connecting.

**Data flow**: Formats `ws://<connectable_bind_addr(bind_addr)>`, builds an HTTP websocket request with `websocket_request`, computes a deadline, and loops calling `connect_async(request.clone())`. On success it returns the websocket stream; on failure before the deadline it sleeps 50 ms and retries; after the deadline it returns an error describing the failed URL and last error.

**Call relations**: Called by `connect_websocket` and directly by auth tests. It depends on `websocket_request` for header construction and provides the retry behavior that hides listener startup races from callers.

*Call graph*: calls 1 internal fn (websocket_request); called by 3 (connect_websocket, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_verifies_signed_short_lived_bearer_tokens); 6 external calls (from_millis, now, bail!, format!, sleep, connect_async).


##### `assert_websocket_connect_rejected`  (lines 481–492)

```
async fn assert_websocket_connect_rejected(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
) -> Result<()>
```

**Purpose**: Asserts that a websocket handshake is rejected with HTTP 401 Unauthorized when using the default no-origin rejection path. It is a small wrapper for auth rejection tests.

**Data flow**: Accepts a bind address and optional bearer token, then calls `assert_websocket_connect_rejected_with_headers` with no origin and expected status `StatusCode::UNAUTHORIZED`. It returns `Ok(())` only if the handshake fails with that status.

**Call relations**: Used by the capability-token and signed-bearer-token tests. It delegates the actual handshake attempt and status inspection to `assert_websocket_connect_rejected_with_headers`.

*Call graph*: calls 1 internal fn (assert_websocket_connect_rejected_with_headers); called by 2 (websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_verifies_signed_short_lived_bearer_tokens).


##### `assert_websocket_connect_rejected_with_headers`  (lines 494–516)

```
async fn assert_websocket_connect_rejected_with_headers(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
    origin: Option<&str>,
    expected_status: StatusCode,
) -> Result<()>
```

**Purpose**: Attempts a websocket handshake with optional bearer token and origin header and asserts the server rejects it with a specific HTTP status. It distinguishes expected HTTP rejection from unexpected websocket or transport errors.

**Data flow**: Builds a websocket URL from `connectable_bind_addr`, constructs a request with `websocket_request`, and calls `connect_async`. If the handshake unexpectedly succeeds it returns an error naming the received status; if it fails with `WsError::Http(response)` it asserts `response.status() == expected_status`; any other error is treated as an unexpected failure mode.

**Call relations**: Called by `assert_websocket_connect_rejected` and directly by the browser-origin rejection test. It is the central assertion helper for negative handshake cases.

*Call graph*: calls 1 internal fn (websocket_request); called by 2 (assert_websocket_connect_rejected, websocket_transport_rejects_browser_origin_without_auth); 4 external calls (assert_eq!, bail!, format!, connect_async).


##### `run_websocket_server_to_completion_with_args`  (lines 518–539)

```
async fn run_websocket_server_to_completion_with_args(
    codex_home: &Path,
    listen_url: &str,
    extra_args: &[String],
) -> Result<std::process::Output>
```

**Purpose**: Runs the app-server websocket binary to process completion and captures its output, with a timeout. It is used for tests where startup itself is expected to fail.

**Data flow**: Builds a `tokio::process::Command` for `codex-app-server` with listen URL, disabled plugin startup tasks, extra args, null stdin/stdout, piped stderr, and environment variables, then awaits `cmd.output()` under `DEFAULT_READ_TIMEOUT`. It returns the captured `std::process::Output` or a contextual timeout/spawn error.

**Call relations**: Used only by the startup-failure tests for short signing secrets and unauthenticated non-loopback listeners. It complements `spawn_websocket_server_with_args`, which is for successful startup cases.

*Call graph*: called by 2 (websocket_transport_rejects_short_signed_bearer_secret_configuration, websocket_transport_rejects_unauthenticated_non_loopback_startup); 5 external calls (null, piped, new, cargo_bin, timeout).


##### `http_get`  (lines 541–564)

```
async fn http_get(
    client: &reqwest::Client,
    bind_addr: SocketAddr,
    path: &str,
) -> Result<reqwest::Response>
```

**Purpose**: Performs an HTTP GET against the websocket listener’s HTTP side, retrying until the listener is ready or timeout expires. It smooths over startup races for health endpoint tests.

**Data flow**: Normalizes the bind address with `connectable_bind_addr`, computes a deadline, and loops calling `client.get(format!("http://{addr}{path}")).send().await`. On success it returns the `reqwest::Response`; on failure before the deadline it sleeps 50 ms and retries; after the deadline it returns an error naming the URL and last failure.

**Call relations**: Called only by `websocket_transport_serves_health_endpoints_on_same_listener`. It mirrors the retry behavior of `connect_websocket_with_bearer` but for plain HTTP requests.

*Call graph*: calls 1 internal fn (connectable_bind_addr); called by 1 (websocket_transport_serves_health_endpoints_on_same_listener); 6 external calls (from_millis, now, get, bail!, format!, sleep).


##### `websocket_request`  (lines 566–588)

```
fn websocket_request(
    url: &str,
    bearer_token: Option<&str>,
    origin: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>>
```

**Purpose**: Constructs a websocket handshake request with optional bearer-token and origin headers. It centralizes header formatting and validation for websocket clients.

**Data flow**: Converts the URL into a client request, optionally inserts `Authorization: Bearer <token>` and `Origin: <origin>` headers using validated `HeaderValue`s, and returns the resulting HTTP request object. Invalid header values produce contextual errors.

**Call relations**: Used by both connection helpers and rejection helpers. It keeps handshake request construction consistent across successful and negative websocket tests.

*Call graph*: called by 2 (assert_websocket_connect_rejected_with_headers, connect_websocket_with_bearer); 2 external calls (from_str, format!).


##### `send_initialize_request`  (lines 590–610)

```
async fn send_initialize_request(
    stream: &mut WsClient,
    id: i64,
    client_name: &str,
) -> Result<()>
```

**Purpose**: Sends a JSON-RPC `initialize` request over a websocket with a concrete `ClientInfo` payload. It is the standard handshake helper for websocket tests.

**Data flow**: Builds `InitializeParams` containing `ClientInfo { name, title: Some("WebSocket Test Client"), version: "0.1.0" }` and `capabilities: None`, serializes it to JSON, and forwards it to `send_request` with method `initialize` and the provided id.

**Call relations**: Used by many websocket tests in this file and by sibling modules. It sits at the start of most websocket flows before any other RPCs are allowed.

*Call graph*: calls 1 internal fn (send_request); called by 9 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, websocket_transport_verifies_signed_short_lived_bearer_tokens, start_ctrl_c_restart_fixture, initialize_both_clients); 1 external calls (to_value).


##### `start_thread`  (lines 612–626)

```
async fn start_thread(stream: &mut WsClient, id: i64) -> Result<String>
```

**Purpose**: Starts a thread over websocket and returns its id. It is a websocket-specific convenience wrapper around `thread/start` plus response decoding.

**Data flow**: Sends a `thread/start` request with `ThreadStartParams { model: Some("mock-model"), ..Default::default() }`, waits for the matching response via `read_response_for_id`, deserializes it to `ThreadStartResponse`, and returns `thread.id`.

**Call relations**: Used by the loaded-thread reconnect test. It depends on `send_request` and `read_response_for_id` to hide the raw JSON-RPC mechanics.

*Call graph*: calls 2 internal fn (read_response_for_id, send_request); called by 1 (websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout); 2 external calls (default, to_value).


##### `assert_loaded_threads`  (lines 628–640)

```
async fn assert_loaded_threads(stream: &mut WsClient, id: i64, expected: &[&str]) -> Result<()>
```

**Purpose**: Requests the loaded-thread list and asserts it exactly matches an expected set of thread ids with no pagination cursor. It is a one-shot assertion helper for thread-loading state.

**Data flow**: Calls `request_loaded_threads`, sorts the returned `data` vector and the expected ids, asserts they are equal, asserts `next_cursor == None`, and returns `Ok(())`.

**Call relations**: Called by the reconnect test immediately after starting a thread. It delegates the actual RPC to `request_loaded_threads` and focuses on exact-set comparison.

*Call graph*: calls 1 internal fn (request_loaded_threads); called by 1 (websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout); 1 external calls (assert_eq!).


##### `wait_for_loaded_threads`  (lines 642–667)

```
async fn wait_for_loaded_threads(
    stream: &mut WsClient,
    first_id: i64,
    expected: &[&str],
) -> Result<()>
```

**Purpose**: Polls `thread/loaded/list` until the returned thread ids match an expected set or timeout expires. It is used when loaded-thread state may appear asynchronously after reconnect.

**Data flow**: Accepts a websocket client, starting request id, and expected thread ids, converts the expected ids to owned strings, then loops under `DEFAULT_READ_TIMEOUT` calling `request_loaded_threads` with incrementing ids, sorting the returned `data`, and comparing it to the expected vector. If they do not match yet, it sleeps 50 ms and retries; on timeout it returns a contextual error.

**Call relations**: Used by the reconnect test after opening the second websocket. It builds on `request_loaded_threads` to turn a one-shot list RPC into an eventual-consistency wait.

*Call graph*: calls 1 internal fn (request_loaded_threads); called by 1 (websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout); 3 external calls (from_millis, sleep, timeout).


##### `request_loaded_threads`  (lines 669–682)

```
async fn request_loaded_threads(
    stream: &mut WsClient,
    id: i64,
) -> Result<ThreadLoadedListResponse>
```

**Purpose**: Sends `thread/loaded/list` over websocket and returns the typed response. It is the low-level helper behind loaded-thread assertions and polling.

**Data flow**: Serializes `ThreadLoadedListParams::default()`, sends it with method `thread/loaded/list`, waits for the matching response via `read_response_for_id`, and deserializes it to `ThreadLoadedListResponse` with `to_response`.

**Call relations**: Called by both `assert_loaded_threads` and `wait_for_loaded_threads`. It encapsulates the request/response mechanics for the loaded-thread listing RPC.

*Call graph*: calls 2 internal fn (read_response_for_id, send_request); called by 2 (assert_loaded_threads, wait_for_loaded_threads); 2 external calls (default, to_value).


##### `send_config_read_request`  (lines 684–692)

```
async fn send_config_read_request(stream: &mut WsClient, id: i64) -> Result<()>
```

**Purpose**: Sends a minimal `config/read` request over websocket. It is a tiny helper used in connection-routing tests.

**Data flow**: Calls `send_request` with method `config/read`, the provided id, and JSON params `{ "includeLayers": false }`. It returns once the request frame has been sent.

**Call relations**: Used only by `websocket_transport_routes_per_connection_handshake_and_responses`. It exists to keep that test focused on routing behavior rather than request construction.

*Call graph*: calls 1 internal fn (send_request); called by 1 (websocket_transport_routes_per_connection_handshake_and_responses); 1 external calls (json!).


##### `send_request`  (lines 694–707)

```
async fn send_request(
    stream: &mut WsClient,
    method: &str,
    id: i64,
    params: Option<serde_json::Value>,
) -> Result<()>
```

**Purpose**: Builds and sends a JSON-RPC request message over websocket. It is the generic request primitive used by higher-level websocket helpers.

**Data flow**: Constructs `JSONRPCMessage::Request(JSONRPCRequest { id: RequestId::Integer(id), method, params, trace: None })` and passes it to `send_jsonrpc`. It returns any send or serialization error from the lower layer.

**Call relations**: Called by initialize, thread-start, turn-start, config-read, and other websocket helper functions across this and sibling modules. It is the central outbound JSON-RPC request constructor.

*Call graph*: calls 1 internal fn (send_jsonrpc); called by 9 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, request_loaded_threads, send_config_read_request, send_initialize_request, start_thread, send_thread_start_request, send_turn_start_request, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (Request, Integer).


##### `send_jsonrpc`  (lines 709–715)

```
async fn send_jsonrpc(stream: &mut WsClient, message: JSONRPCMessage) -> Result<()>
```

**Purpose**: Serializes a `JSONRPCMessage` and sends it as a websocket text frame. It is the lowest-level outbound transport helper in this file.

**Data flow**: Converts the message to a JSON string with `serde_json::to_string`, wraps it in `WebSocketMessage::Text`, sends it on the websocket sink, and returns `Ok(())` or a contextual send error.

**Call relations**: Called only by `send_request`. It isolates the actual websocket frame emission from request construction.

*Call graph*: called by 1 (send_request); 3 external calls (Text, send, to_string).


##### `read_response_for_id`  (lines 717–730)

```
async fn read_response_for_id(
    stream: &mut WsClient,
    id: i64,
) -> Result<JSONRPCResponse>
```

**Purpose**: Reads websocket JSON-RPC messages until it finds a response with the specified request id. It filters out unrelated responses and notifications.

**Data flow**: Converts the integer id to `RequestId::Integer`, loops on `read_jsonrpc_message`, and returns the first `JSONRPCMessage::Response` whose `id` matches the target. Other messages are ignored.

**Call relations**: Used widely by websocket tests and helpers after sending requests. It depends on `read_jsonrpc_message` for frame parsing and message decoding.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 11 (request_loaded_threads, start_thread, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, websocket_transport_verifies_signed_short_lived_bearer_tokens, start_ctrl_c_restart_fixture, initialize_both_clients (+1 more)); 1 external calls (Integer).


##### `read_notification_for_method`  (lines 732–744)

```
async fn read_notification_for_method(
    stream: &mut WsClient,
    method: &str,
) -> Result<JSONRPCNotification>
```

**Purpose**: Reads websocket JSON-RPC messages until it finds a notification with the specified method name. It is a generic notification filter for websocket tests.

**Data flow**: Loops on `read_jsonrpc_message` and returns the first `JSONRPCMessage::Notification` whose `method` equals the requested method string. All other messages are skipped.

**Call relations**: Used by thread-name update tests in the broader suite. It complements `read_response_for_id` by filtering on notification method instead of request id.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads).


##### `read_response_and_notification_for_method`  (lines 746–783)

```
async fn read_response_and_notification_for_method(
    stream: &mut WsClient,
    id: i64,
    method: &str,
) -> Result<(JSONRPCResponse, JSONRPCNotification)>
```

**Purpose**: Collects both a specific response and a specific notification from the websocket stream, in either arrival order, while rejecting duplicate matching notifications. It is useful for RPCs that are expected to produce both artifacts.

**Data flow**: Tracks a target `RequestId::Integer(id)` plus an optional response and notification slot, loops on `read_jsonrpc_message`, stores the matching response when seen, stores the first matching notification for the given method, errors if a second matching notification arrives before completion, ignores unrelated messages, and finally returns the pair once both slots are filled.

**Call relations**: Used by thread-name update tests elsewhere in the suite. It builds on `read_jsonrpc_message` to coordinate two expected outputs from one logical action.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (Integer, bail!).


##### `read_error_for_id`  (lines 785–795)

```
async fn read_error_for_id(stream: &mut WsClient, id: i64) -> Result<JSONRPCError>
```

**Purpose**: Reads websocket JSON-RPC messages until it finds an error object for the specified request id. It is the error-path counterpart to `read_response_for_id`.

**Data flow**: Converts the integer id to `RequestId::Integer`, loops on `read_jsonrpc_message`, and returns the first `JSONRPCMessage::Error` whose `id` matches. Other messages are ignored.

**Call relations**: Used by the connection-routing test to observe the `Not initialized` error. It shares the same filtering pattern as `read_response_for_id` but for error messages.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 1 (websocket_transport_routes_per_connection_handshake_and_responses); 1 external calls (Integer).


##### `read_jsonrpc_message`  (lines 797–818)

```
async fn read_jsonrpc_message(stream: &mut WsClient) -> Result<JSONRPCMessage>
```

**Purpose**: Reads the next meaningful JSON-RPC message from a websocket stream, handling control frames and enforcing timeouts. It is the central inbound transport parser for websocket tests.

**Data flow**: Waits under `DEFAULT_READ_TIMEOUT` for the next websocket frame from `stream.next()`, errors if the stream ends or frame read fails, then matches on the frame: `Text` is parsed from JSON into `JSONRPCMessage` and returned; `Ping` triggers an immediate `Pong` reply and the loop continues; `Pong` and raw `Frame` variants are ignored; `Close` produces an error; `Binary` also produces an error. The function loops until it can return a parsed JSON-RPC message.

**Call relations**: This helper underpins all websocket read-side utilities in this file and is also reused by sibling modules such as command-exec websocket tests. It centralizes protocol housekeeping so higher-level readers can focus on filtering by id or method.

*Call graph*: called by 7 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, read_command_exec_delta_ws, read_initialize_response, read_error_for_id, read_notification_for_method, read_response_and_notification_for_method, read_response_for_id); 6 external calls (Pong, next, send, bail!, from_str, timeout).


##### `assert_no_message`  (lines 820–827)

```
async fn assert_no_message(stream: &mut WsClient, wait_for: Duration) -> Result<()>
```

**Purpose**: Asserts that no websocket frame arrives within a specified duration. It is used to prove absence of cross-connection leakage or unexpected broadcasts.

**Data flow**: Runs `timeout(wait_for, stream.next())`; if a frame arrives, a read error occurs, or the stream closes, it returns an error describing the unexpected event. If the timeout elapses first, it returns `Ok(())`.

**Call relations**: Used by the connection-routing test, the command-exec websocket scoping test, and thread-name tests elsewhere. It is the negative-space counterpart to the positive read helpers.

*Call graph*: called by 4 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_transport_routes_per_connection_handshake_and_responses, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 3 external calls (next, bail!, timeout).


##### `create_config_toml`  (lines 829–854)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()>
```

**Purpose**: Writes a minimal mock-provider `config.toml` suitable for websocket transport tests and many sibling integration tests. It standardizes model, approval policy, sandbox mode, and mock provider settings.

**Data flow**: Joins `config.toml` under the provided CODEX_HOME path and writes a formatted TOML string containing `model = "mock-model"`, the supplied `approval_policy`, `sandbox_mode = "read-only"`, `model_provider = "mock_provider"`, and a `[model_providers.mock_provider]` table pointing at `<server_uri>/v1` with zero retries.

**Call relations**: Used extensively across this file and by other v2 test modules such as command-exec and Unix websocket signal tests. It is the shared config fixture generator for app-server subprocess tests.

*Call graph*: called by 32 (command_exec_accepts_permission_profile, command_exec_env_overrides_merge_with_server_environment_and_support_unset, command_exec_non_streaming_respects_output_cap, command_exec_permission_profile_does_not_reuse_default_network_proxy, command_exec_permission_profile_project_roots_use_command_cwd, command_exec_permission_profile_starts_selected_network_proxy, command_exec_pipe_streams_output_and_accepts_write, command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, command_exec_rejects_disable_output_cap_with_output_bytes_cap, command_exec_rejects_disable_timeout_with_timeout_ms (+15 more)); 3 external calls (join, format!, write).


##### `connectable_bind_addr`  (lines 856–866)

```
fn connectable_bind_addr(bind_addr: SocketAddr) -> SocketAddr
```

**Purpose**: Rewrites unspecified listener addresses to loopback addresses so tests can connect to listeners bound on `0.0.0.0` or `::`. It avoids trying to dial an unspecified address directly.

**Data flow**: Matches on the provided `SocketAddr`; if it is IPv4 unspecified, returns `127.0.0.1:<port>`; if IPv6 unspecified, returns `::1:<port>`; otherwise returns the original address unchanged.

**Call relations**: Used by `connect_websocket_with_bearer` and `http_get` before constructing URLs. It is a small but important normalization helper for tests that intentionally start non-loopback listeners.

*Call graph*: called by 1 (http_get); 1 external calls (from).


##### `signed_bearer_token`  (lines 868–876)

```
fn signed_bearer_token(shared_secret: &[u8], claims: serde_json::Value) -> Result<String>
```

**Purpose**: Constructs an HS256-signed JWT-like bearer token from arbitrary JSON claims for websocket auth tests. It is a local token generator, not a general JWT library wrapper.

**Data flow**: Base64url-encodes a fixed header `{"alg":"HS256","typ":"JWT"}` and the serialized claims JSON, concatenates them as `header.claims`, initializes `HmacSha256` with the shared secret, signs the payload bytes, base64url-encodes the signature, and returns `header.claims.signature` as a string.

**Call relations**: Used only by `websocket_transport_verifies_signed_short_lived_bearer_tokens`. It supplies concrete tokens for the server’s signed-bearer validation path.

*Call graph*: called by 1 (websocket_transport_verifies_signed_short_lived_bearer_tokens); 3 external calls (new_from_slice, format!, to_vec).


### `app-server/tests/suite/v2/connection_handling_websocket_unix.rs`

`test` · `teardown`

This Unix-only companion to the websocket transport tests focuses on process lifecycle under POSIX signals. Each test starts a real websocket app-server subprocess with a mock `/responses` endpoint that intentionally delays completion of a turn, then sends `SIGINT`, `SIGTERM`, or `SIGHUP` while that turn is in flight. The expected behavior differs by signal count: the first `SIGINT` or `SIGTERM` should begin graceful drain and wait for the running turn to finish before exit, a second signal should force earlier exit, and repeated `SIGHUP` should continue waiting rather than escalating.

The shared fixture builder `start_ctrl_c_restart_fixture` mounts a delayed SSE response, writes config, spawns the websocket server, initializes a websocket client, starts a thread, starts a turn, and then waits until the mock server has actually received the `/responses` POST. That last step is important: it guarantees the turn is genuinely running before any signal is sent, so the tests are measuring shutdown semantics rather than startup races.

Helper functions wrap raw `kill` invocations (`send_sigint`, `send_sigterm`, `send_sighup`, `send_signal`), assert that the subprocess does not exit too early, wait for eventual exit with contextual timeout messages, and consume websocket frames until a disconnect is observed. `expect_websocket_disconnect` mirrors the main websocket reader’s control-frame handling by replying to pings while waiting for closure, ensuring the client side does not itself cause the connection to fail prematurely.

#### Function details

##### `websocket_transport_ctrl_c_waits_for_running_turn_before_exit`  (lines 35–57)

```
async fn websocket_transport_ctrl_c_waits_for_running_turn_before_exit() -> Result<()>
```

**Purpose**: Verifies a single Ctrl-C (`SIGINT`) triggers graceful shutdown that waits for the in-flight turn to finish before the app-server exits. It also checks the websocket eventually disconnects cleanly.

**Data flow**: Builds a delayed-turn fixture with `start_ctrl_c_restart_fixture`, sends `SIGINT` to the subprocess, asserts the process does not exit within 300 ms, then waits up to 10 seconds for process exit and asserts the exit status is successful. Finally it waits for websocket disconnect and returns `Ok(())`.

**Call relations**: Invoked by the Tokio test harness. It depends on the shared fixture setup plus `send_sigint`, `assert_process_does_not_exit_within`, `wait_for_process_exit_within`, and `expect_websocket_disconnect` to express the graceful-drain contract.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigint, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_second_ctrl_c_forces_exit_while_turn_running`  (lines 60–83)

```
async fn websocket_transport_second_ctrl_c_forces_exit_while_turn_running() -> Result<()>
```

**Purpose**: Checks that a second Ctrl-C escalates shutdown and forces the app-server to exit promptly even while a turn is still running. It distinguishes first-signal graceful drain from second-signal forced termination.

**Data flow**: Starts the delayed-turn fixture, sends `SIGINT`, confirms the process stays alive for at least 300 ms, sends `SIGINT` again, waits up to 2 seconds for exit, asserts the exit status is successful, and then waits for websocket disconnect.

**Call relations**: Called by the harness. It reuses the same fixture and helper sequence as the single-Ctrl-C test but adds a second signal and a shorter forced-exit timeout.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigint, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_sigterm_waits_for_running_turn_before_exit`  (lines 86–108)

```
async fn websocket_transport_sigterm_waits_for_running_turn_before_exit() -> Result<()>
```

**Purpose**: Verifies a single `SIGTERM` behaves like graceful shutdown, waiting for the running turn to complete before process exit. It ensures TERM follows the same drain semantics as Ctrl-C.

**Data flow**: Creates the delayed-turn fixture, sends `SIGTERM`, asserts the process does not exit within 300 ms, waits up to 10 seconds for exit, asserts success, and then waits for websocket disconnect.

**Call relations**: Invoked by the harness. It mirrors the Ctrl-C graceful test but uses `send_sigterm` to exercise the TERM signal path.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigterm, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_second_sigterm_forces_exit_while_turn_running`  (lines 111–134)

```
async fn websocket_transport_second_sigterm_forces_exit_while_turn_running() -> Result<()>
```

**Purpose**: Checks that a second `SIGTERM` forces prompt exit while a turn is still running. It validates escalation behavior for repeated TERM signals.

**Data flow**: Starts the delayed-turn fixture, sends `SIGTERM`, confirms the process remains alive briefly, sends `SIGTERM` again, waits up to 2 seconds for exit, asserts success, and waits for websocket disconnect.

**Call relations**: Run by the harness. It is the TERM analogue of the second-Ctrl-C escalation test and uses the same helper sequence with a different signal sender.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigterm, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_repeated_sighup_keeps_waiting_for_running_turn`  (lines 137–162)

```
async fn websocket_transport_repeated_sighup_keeps_waiting_for_running_turn() -> Result<()>
```

**Purpose**: Verifies repeated `SIGHUP` signals do not escalate to forced termination and the server continues waiting for the running turn to finish. It captures the distinct restart-oriented semantics of HUP.

**Data flow**: Starts the delayed-turn fixture, sends `SIGHUP`, asserts the process does not exit within 300 ms, sends `SIGHUP` again, asserts it still does not exit within 300 ms, then waits up to 10 seconds for graceful exit, asserts success, and waits for websocket disconnect.

**Call relations**: Invoked by the harness. It uses `send_sighup` plus the same process and websocket wait helpers to show that repeated HUP differs from repeated INT/TERM.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sighup, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `start_ctrl_c_restart_fixture`  (lines 171–207)

```
async fn start_ctrl_c_restart_fixture(turn_delay: Duration) -> Result<GracefulCtrlCFixture>
```

**Purpose**: Sets up a running websocket app-server with an active delayed turn so signal-handling tests can observe shutdown behavior mid-request. It returns the temp home, mock server, child process, and connected websocket client.

**Data flow**: Starts a wiremock server, creates a delayed SSE `/responses` reply using `create_final_assistant_message_sse_response("Done")` and `responses::sse_response(...).set_delay(turn_delay)`, mounts it for one POST, creates a temp CODEX_HOME and writes config, spawns the websocket server, connects a websocket client, sends initialize and verifies the response id, sends `thread/start` and deserializes `ThreadStartResponse` to get the thread id, sends `turn/start` for that thread and verifies the response id, waits for the mock server to observe a `/responses` POST via `wait_for_responses_post`, and returns a `GracefulCtrlCFixture` containing the resources.

**Call relations**: Called by all five signal-handling tests. It depends on websocket helpers from the sibling module for transport setup and on local helpers `send_thread_start_request`, `send_turn_start_request`, and `wait_for_responses_post` to ensure the turn is truly in flight before signals are sent.

*Call graph*: calls 10 internal fn (connect_websocket, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server, send_thread_start_request, send_turn_start_request, wait_for_responses_post, sse_response, start_mock_server); called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 8 external calls (from_secs, given, new, create_final_assistant_message_sse_response, to_response, assert_eq!, method, path_regex).


##### `send_thread_start_request`  (lines 209–220)

```
async fn send_thread_start_request(stream: &mut WsClient, id: i64) -> Result<()>
```

**Purpose**: Sends a websocket `thread/start` request with the mock model. It is a small fixture helper used during signal-handling setup.

**Data flow**: Serializes `ThreadStartParams { model: Some("mock-model"), ..Default::default() }` and forwards it to `send_request` with method `thread/start` and the provided id. It returns once the request has been sent.

**Call relations**: Used only by `start_ctrl_c_restart_fixture`. It keeps the fixture setup concise by hiding the request construction details.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_ctrl_c_restart_fixture); 2 external calls (default, to_value).


##### `send_turn_start_request`  (lines 222–238)

```
async fn send_turn_start_request(stream: &mut WsClient, id: i64, thread_id: &str) -> Result<()>
```

**Purpose**: Sends a websocket `turn/start` request with a single text input targeting a specific thread. It is the fixture helper that begins the long-running turn.

**Data flow**: Builds `TurnStartParams` with the supplied `thread_id`, no client user message id, and one `V2UserInput::Text { text: "Hello", text_elements: Vec::new() }`, serializes it, and sends it via `send_request` with method `turn/start` and the provided id.

**Call relations**: Called only by `start_ctrl_c_restart_fixture`. It is paired with `wait_for_responses_post` so the fixture knows the delayed turn has actually reached the mock backend.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_ctrl_c_restart_fixture); 3 external calls (default, to_value, vec!).


##### `wait_for_responses_post`  (lines 240–258)

```
async fn wait_for_responses_post(server: &wiremock::MockServer, wait_for: Duration) -> Result<()>
```

**Purpose**: Polls the mock server until it has received a POST request whose path ends with `/responses`. It ensures the turn request is actively being processed before shutdown signals are sent.

**Data flow**: Computes a deadline from the supplied duration, repeatedly fetches `server.received_requests()`, scans for any request with method `POST` and a path ending in `/responses`, and returns once found. If the deadline expires first it returns a timeout error; between polls it sleeps for 10 ms.

**Call relations**: Used only by `start_ctrl_c_restart_fixture`. It turns wiremock request logs into a synchronization point that eliminates races in the signal tests.

*Call graph*: called by 1 (start_ctrl_c_restart_fixture); 5 external calls (from_millis, now, received_requests, bail!, sleep).


##### `send_sigint`  (lines 260–262)

```
fn send_sigint(process: &Child) -> Result<()>
```

**Purpose**: Sends `SIGINT` to the app-server subprocess. It is a thin named wrapper around the generic signal sender.

**Data flow**: Accepts a `tokio::process::Child` reference and calls `send_signal(process, "-INT")`. It returns any error from signal delivery.

**Call relations**: Used by the two Ctrl-C tests. It exists for readability so those tests can name the signal they are exercising.

*Call graph*: calls 1 internal fn (send_signal); called by 2 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_second_ctrl_c_forces_exit_while_turn_running).


##### `send_sigterm`  (lines 264–266)

```
fn send_sigterm(process: &Child) -> Result<()>
```

**Purpose**: Sends `SIGTERM` to the app-server subprocess. It is the TERM-specific wrapper around `send_signal`.

**Data flow**: Accepts a child-process reference and forwards it to `send_signal(process, "-TERM")`. It returns `Ok(())` on successful `kill` invocation.

**Call relations**: Used by the two SIGTERM tests. Like `send_sigint`, it is a readability wrapper over the generic signal helper.

*Call graph*: calls 1 internal fn (send_signal); called by 2 (websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit).


##### `send_sighup`  (lines 268–270)

```
fn send_sighup(process: &Child) -> Result<()>
```

**Purpose**: Sends `SIGHUP` to the app-server subprocess. It is the HUP-specific wrapper around `send_signal`.

**Data flow**: Accepts a child-process reference and calls `send_signal(process, "-HUP")`. It returns any error from the underlying `kill` command.

**Call relations**: Used only by the repeated-SIGHUP test. It keeps that test’s intent explicit.

*Call graph*: calls 1 internal fn (send_signal); called by 1 (websocket_transport_repeated_sighup_keeps_waiting_for_running_turn).


##### `send_signal`  (lines 272–285)

```
fn send_signal(process: &Child, signal: &str) -> Result<()>
```

**Purpose**: Invokes the system `kill` command to send a named POSIX signal to the subprocess pid. It is the low-level Unix signal delivery helper for this file.

**Data flow**: Extracts the child pid with `process.id()`, errors if absent, runs `kill <signal> <pid>` via `std::process::Command`, adds context if the command cannot be invoked, checks the exit status, and returns an error if `kill` itself exits unsuccessfully.

**Call relations**: Called by `send_sigint`, `send_sigterm`, and `send_sighup`. It centralizes the actual OS interaction so the tests can work with semantic signal-specific wrappers.

*Call graph*: called by 3 (send_sighup, send_sigint, send_sigterm); 3 external calls (id, new, bail!).


##### `assert_process_does_not_exit_within`  (lines 287–293)

```
async fn assert_process_does_not_exit_within(process: &mut Child, window: Duration) -> Result<()>
```

**Purpose**: Asserts the subprocess remains alive for at least a given time window. It is used to prove the server does not terminate immediately after the first graceful-drain signal.

**Data flow**: Runs `timeout(window, process.wait())`; if the timeout elapses, it returns `Ok(())` because the process stayed alive long enough. If `process.wait()` completes successfully within the window, it returns an error saying the process exited too early; if waiting itself errors, that error is wrapped with context.

**Call relations**: Used by all five signal-handling tests immediately after sending the first signal. It complements `wait_for_process_exit_within`, which checks the eventual exit.

*Call graph*: called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 3 external calls (wait, bail!, timeout).


##### `wait_for_process_exit_within`  (lines 295–304)

```
async fn wait_for_process_exit_within(
    process: &mut Child,
    window: Duration,
    timeout_context: &'static str,
) -> Result<std::process::ExitStatus>
```

**Purpose**: Waits for the subprocess to exit within a bounded time and returns its exit status. It is the positive counterpart to `assert_process_does_not_exit_within`.

**Data flow**: Runs `timeout(window, process.wait())`, applies the caller-provided timeout context string if the deadline expires, and otherwise returns the resulting `std::process::ExitStatus` or a contextual wait error.

**Call relations**: Called by all signal-handling tests after they have established whether the process should still be alive. The tests then assert the returned status indicates success.

*Call graph*: called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 2 external calls (wait, timeout).


##### `expect_websocket_disconnect`  (lines 306–327)

```
async fn expect_websocket_disconnect(stream: &mut WsClient) -> Result<()>
```

**Purpose**: Consumes websocket frames until the connection closes or errors, replying to pings while waiting. It confirms the client observes disconnect after server shutdown.

**Data flow**: Loops reading `stream.next()` under `DEFAULT_READ_TIMEOUT`; `None` or a `Close` frame counts as success and returns `Ok(())`, `Ping` triggers a `Pong` reply and continues, `Pong`, raw `Frame`, `Text`, and `Binary` frames are ignored while waiting, and any websocket read error also counts as disconnect success.

**Call relations**: Used by all signal-handling tests after process exit. It mirrors the control-frame handling in the main websocket helper module so the client side remains well-behaved while waiting for shutdown.

*Call graph*: called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 4 external calls (Pong, next, send, timeout).


### Handshake and protocol gating
These tests verify client-visible protocol contracts at connection setup, covering attestation forwarding and experimental API opt-in requirements.

### `app-server/tests/suite/v2/attestation.rs`

`test` · `turn startup and websocket handshake in integration tests`

This file contains a single end-to-end integration test plus a config writer. The test spins up a local websocket test server that accepts two connections: one disposable connection consumed by the app server's `/models` refresh probe during thread startup, and a second connection that serves the warmup and real response streams for the turn under test. The app server is configured with a mock provider that requires OpenAI auth and supports websockets, and a ChatGPT auth fixture is written so the websocket path is actually used.

Initialization is performed with explicit client metadata (`codex_desktop`) and `InitializeCapabilities` enabling both `experimental_api` and `request_attestation`. After starting a thread and a turn, the test enters a loop reading arbitrary JSON-RPC messages from the server. Every `ServerRequest::AttestationGenerate` is answered with `AttestationGenerateResponse { token: "v1.integration-test" }`, while the loop exits only after `turn/completed` arrives. The test asserts that at least one attestation request occurred, then inspects the websocket server's recorded handshake and checks that header `x-oai-attestation` equals the app-server encoded JSON wrapper `{"v":1,"s":0,"t":"v1.integration-test"}`. This captures the full round trip from capability negotiation through runtime request/response and transport-layer header injection.

#### Function details

##### `attestation_generate_round_trip_adds_header_to_responses_websocket_handshake`  (lines 35–172)

```
async fn attestation_generate_round_trip_adds_header_to_responses_websocket_handshake() -> Result<()>
```

**Purpose**: Exercises the full attestation flow for websocket-backed Responses API turns. It verifies that the server requests attestation from the client and forwards the returned token in the websocket handshake header.

**Data flow**: Starts a local websocket server with one throwaway connection config and one real response-stream config, creates temp codex-home config via `create_chatgpt_websocket_config`, writes ChatGPT auth, starts the app server with `OPENAI_API_KEY` unset, initializes it with client info and capabilities requesting attestation, starts a thread and then a turn, loops over incoming JSON-RPC messages responding to each `ServerRequest::AttestationGenerate` with `AttestationGenerateResponse { token: ATTESTATION_HEADER }` until `turn/completed` arrives, asserts at least one attestation request was seen, waits for one websocket handshake on the test server, and asserts the handshake's `x-oai-attestation` header equals `APP_SERVER_ATTESTATION_HEADER`; finally shuts down the websocket server.

**Call relations**: This is the file's sole top-level test and drives both the JSON-RPC control plane and websocket transport plane to verify attestation propagation.

*Call graph*: calls 4 internal fn (new, new_with_env, create_chatgpt_websocket_config, start_websocket_server_with_headers); 14 external calls (default, try_from, new, Integer, default, to_response, write_chatgpt_auth, assert!, assert_eq!, bail! (+4 more)).


##### `create_chatgpt_websocket_config`  (lines 174–196)

```
fn create_chatgpt_websocket_config(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes a provider config that forces websocket-capable, OpenAI-authenticated Responses API traffic against a supplied local server URI.

**Data flow**: Takes codex-home path and `server_uri` → writes `config.toml` containing model defaults, `model_provider = "mock_provider"`, and a `[model_providers.mock_provider]` section with `base_url = "{server_uri}/v1"`, `wire_api = "responses"`, zero retries, `requires_openai_auth = true`, and `supports_websockets = true` → returns `std::io::Result<()>`.

**Call relations**: Called by the attestation round-trip test before starting the app server so the turn uses the websocket transport under test.

*Call graph*: called by 1 (attestation_generate_round_trip_adds_header_to_responses_websocket_handshake); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/experimental_api.rs`

`test` · `startup and request validation`

This file is a focused capability-gating test suite for the app server's experimental API surface. Most tests follow the same pattern: create a temporary Codex home, optionally write a minimal mock-provider `config.toml`, start `TestAppServer`, initialize it with `InitializeCapabilities { experimental_api: false, ... }`, verify initialization returned a JSON-RPC response rather than some other message, then send one experimental request or a request containing one experimental field. The expected failure shape is standardized through `assert_experimental_capability_error`: JSON-RPC code `-32600`, a message of the form `"<reason> requires experimentalApi capability"`, and no error data.

The covered surface includes the dedicated mock experimental method, realtime conversation start (including explicit WebRTC transport), thread memory mode changes, thread settings updates, `ThreadStartParams.mock_experimental_field`, and granular approval policy via `AskForApproval::Granular`. One positive control confirms that a normal `thread/start` with only a model set is still accepted without the capability, proving the gate is field-specific rather than blanket denial of thread creation. Helper functions keep the tests concise: `default_client_info` produces a stable `ClientInfo` using `DEFAULT_CLIENT_NAME`, and `create_config_toml` writes the minimal provider configuration needed for thread-start tests that must parse model settings.

#### Function details

##### `mock_experimental_method_requires_experimental_api_capability`  (lines 31–59)

```
async fn mock_experimental_method_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Verifies that calling the mock experimental RPC method without `experimental_api` enabled is rejected with the standard invalid-request error.

**Data flow**: It creates a temp home, starts `TestAppServer`, initializes with `default_client_info()` and `InitializeCapabilities` where `experimental_api` is false, pattern-matches the initialize result as `JSONRPCMessage::Response`, then sends `MockExperimentalMethodParams::default()`. It waits for the error message for that request ID and passes the resulting `JSONRPCError` plus the method name string to `assert_experimental_capability_error`.

**Call relations**: The test harness invokes it directly. It depends on `default_client_info` to build the initialize payload and delegates final validation to `assert_experimental_capability_error` after the server returns an error for the experimental method call.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 5 external calls (new, bail!, Integer, default, timeout).


##### `realtime_conversation_start_requires_experimental_api_capability`  (lines 62–103)

```
async fn realtime_conversation_start_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Confirms that `thread/realtime/start` is capability-gated even for a basic audio realtime session request.

**Data flow**: It initializes a fresh server with `experimental_api: false`, then sends `ThreadRealtimeStartParams` populated with a thread ID, audio output modality, and a prompt. After waiting for the request-specific error response, it validates the error contents against the expected `thread/realtime/start` reason string.

**Call relations**: Called by the test runner, it follows the common initialize-then-request pattern and uses `default_client_info` plus `assert_experimental_capability_error` to keep setup and assertions consistent with the other gating tests.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 4 external calls (new, bail!, Integer, timeout).


##### `thread_memory_mode_set_requires_experimental_api_capability`  (lines 106–137)

```
async fn thread_memory_mode_set_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Checks that changing a thread's memory mode is treated as experimental and rejected when the client did not opt into the experimental API.

**Data flow**: It starts and initializes the server with experimental support disabled, sends `ThreadMemoryModeSetParams` targeting `thr_123` with `ThreadMemoryMode::Disabled`, waits for the JSON-RPC error tied to that request ID, and validates the code/message/data triple through the shared assertion helper.

**Call relations**: This test is another direct harness entrypoint. It uses `default_client_info` during initialization and funnels the returned error into `assert_experimental_capability_error` with the `thread/memoryMode/set` reason.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 4 external calls (new, bail!, Integer, timeout).


##### `thread_settings_update_requires_experimental_api_capability`  (lines 140–171)

```
async fn thread_settings_update_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Ensures `thread/settings/update` cannot be used by clients that did not advertise experimental API support.

**Data flow**: After standard initialization with `experimental_api: false`, it sends `ThreadSettingsUpdateParams` containing a thread ID and default values for the remaining fields. It waits for the request's error response and checks that the server reports `thread/settings/update requires experimentalApi capability` with code `-32600` and no data.

**Call relations**: Invoked by the test harness, it mirrors the other negative tests and delegates the exact error-shape check to `assert_experimental_capability_error`.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 5 external calls (default, new, bail!, Integer, timeout).


##### `realtime_webrtc_start_requires_experimental_api_capability`  (lines 174–217)

```
async fn realtime_webrtc_start_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Verifies that the WebRTC variant of realtime start is also blocked behind the same experimental capability gate.

**Data flow**: It initializes the server without experimental support, sends `ThreadRealtimeStartParams` whose `transport` is `Some(ThreadRealtimeStartTransport::Webrtc { sdp })`, waits for the error response for that request ID, and validates the returned `JSONRPCError` against the shared expectation for `thread/realtime/start`.

**Call relations**: This test is entered by the async test runner and reuses `default_client_info` and `assert_experimental_capability_error`; its distinguishing input is the explicit WebRTC transport payload.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 4 external calls (new, bail!, Integer, timeout).


##### `thread_start_mock_field_requires_experimental_api_capability`  (lines 220–254)

```
async fn thread_start_mock_field_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Checks that an experimental field embedded inside `thread/start` is rejected even though the base method itself is normally allowed.

**Data flow**: It first creates a mock responses server and writes a minimal provider config via `create_config_toml`, then initializes `TestAppServer` with `experimental_api: false`. It sends `ThreadStartParams` with `mock_experimental_field: Some("mock")`, waits for the error response, and validates that the reason string names `thread/start.mockExperimentalField`.

**Call relations**: The test runner invokes it directly. It relies on `create_config_toml` because thread start needs model-provider configuration, and then uses `assert_experimental_capability_error` to verify the field-level gate.

*Call graph*: calls 4 internal fn (new, assert_experimental_capability_error, create_config_toml, default_client_info); 7 external calls (default, new, new, bail!, Integer, create_mock_responses_server_sequence_unchecked, timeout).


##### `thread_start_without_dynamic_tools_allows_without_experimental_api_capability`  (lines 257–291)

```
async fn thread_start_without_dynamic_tools_allows_without_experimental_api_capability() -> Result<()>
```

**Purpose**: Provides the positive control showing that ordinary thread creation still works when experimental API support is disabled.

**Data flow**: It creates a mock provider config, initializes the server with `experimental_api: false`, sends `ThreadStartParams` containing only `model: Some("mock-model")`, waits for a normal JSON-RPC response, and deserializes it into `ThreadStartResponse`. The test succeeds if deserialization works and no error is returned.

**Call relations**: This test is the counterpart to the negative thread-start cases. It uses `create_config_toml` for provider setup and `to_response` to prove the server accepted the non-experimental request path.

*Call graph*: calls 3 internal fn (new, create_config_toml, default_client_info); 8 external calls (default, new, new, bail!, Integer, create_mock_responses_server_sequence_unchecked, to_response, timeout).


##### `thread_start_granular_approval_policy_requires_experimental_api_capability`  (lines 294–335)

```
async fn thread_start_granular_approval_policy_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: Verifies that the granular approval-policy variant on thread start is considered experimental and rejected without the capability.

**Data flow**: It writes provider config, initializes with `experimental_api: false`, sends `ThreadStartParams` whose `approval_policy` is `Some(AskForApproval::Granular { ... })`, waits for the request error, and checks that the reason string is `askForApproval.granular`.

**Call relations**: Invoked by the test harness, it shares setup with the other thread-start tests and delegates exact error validation to `assert_experimental_capability_error`.

*Call graph*: calls 4 internal fn (new, assert_experimental_capability_error, create_config_toml, default_client_info); 7 external calls (default, new, new, bail!, Integer, create_mock_responses_server_sequence_unchecked, timeout).


##### `default_client_info`  (lines 337–343)

```
fn default_client_info() -> ClientInfo
```

**Purpose**: Constructs the standard `ClientInfo` used by this file's initialization calls.

**Data flow**: It takes no arguments and returns a `ClientInfo` with `name` copied from `DEFAULT_CLIENT_NAME`, `title` set to `None`, and `version` fixed at `0.1.0`. It does not read or mutate external state.

**Call relations**: All tests in this file that call `initialize_with_capabilities` use this helper so they share the same client identity while varying only capability flags and subsequent requests.

*Call graph*: called by 8 (mock_experimental_method_requires_experimental_api_capability, realtime_conversation_start_requires_experimental_api_capability, realtime_webrtc_start_requires_experimental_api_capability, thread_memory_mode_set_requires_experimental_api_capability, thread_settings_update_requires_experimental_api_capability, thread_start_granular_approval_policy_requires_experimental_api_capability, thread_start_mock_field_requires_experimental_api_capability, thread_start_without_dynamic_tools_allows_without_experimental_api_capability).


##### `assert_experimental_capability_error`  (lines 345–352)

```
fn assert_experimental_capability_error(error: JSONRPCError, reason: &str)
```

**Purpose**: Centralizes the exact JSON-RPC error shape expected when an experimental method or field is used without `experimentalApi` capability.

**Data flow**: It accepts a `JSONRPCError` and a reason string, reads `error.error.code`, `message`, and `data`, and asserts that they equal `-32600`, `"<reason> requires experimentalApi capability"`, and `None` respectively. It returns unit and only produces output through assertion failures.

**Call relations**: Every negative test in this file calls it after obtaining an error response, so it serves as the shared terminal assertion step for the capability-gating flow.

*Call graph*: called by 7 (mock_experimental_method_requires_experimental_api_capability, realtime_conversation_start_requires_experimental_api_capability, realtime_webrtc_start_requires_experimental_api_capability, thread_memory_mode_set_requires_experimental_api_capability, thread_settings_update_requires_experimental_api_capability, thread_start_granular_approval_policy_requires_experimental_api_capability, thread_start_mock_field_requires_experimental_api_capability); 1 external calls (assert_eq!).


##### `create_config_toml`  (lines 354–375)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: Writes the minimal `config.toml` needed for tests that must start threads against a mock Responses provider.

**Data flow**: It takes a Codex home path and mock server URI, joins `config.toml` under the home directory, formats a TOML string containing model, approval policy, sandbox mode, provider selection, and provider endpoint/retry settings, and writes that file to disk. It returns the `std::io::Result<()>` from `std::fs::write`.

**Call relations**: Only the thread-start-related tests call this helper, because those requests need a configured model provider before the server can accept them.

*Call graph*: called by 3 (thread_start_granular_approval_policy_requires_experimental_api_capability, thread_start_mock_field_requires_experimental_api_capability, thread_start_without_dynamic_tools_allows_without_experimental_api_capability); 3 external calls (join, format!, write).


### Realtime conversation flows
This suite exercises full end-to-end realtime conversation behavior across transports, protocol versions, event mediation, and delegated turns.

### `app-server/tests/suite/v2/realtime_conversation.rs`

`test` · `request handling`

This is a large integration-style test suite for realtime conversation behavior. It defines small protocol fixtures (`session_updated`, `v2_background_agent_tool_call`), assertion helpers for expected upstream sideband frames, and a reusable `RealtimeE2eHarness` that wires together a `TestAppServer`, a mock Responses server for ordinary background-agent turns, a fake realtime sideband WebSocket server, captured WebRTC call-create requests, config generation, API-key login, and an initial thread. The harness can start realtime over plain WebSocket or WebRTC, append audio/text/speech, inspect outbound sideband frames, and collect mocked Responses requests.

The tests cover startup-context generation and suppression, supported voice listing, stop/closed notifications, and backend error surfacing. They also distinguish Realtime V1 and V2 semantics: v1 uses `quicksilver`, no tools, and `conversation.handoff.append`; v2 uses `realtime`, explicit `background_agent` and `remain_silent` tools, developer/user item injection, and `function_call_output` plus optional `response.create`. Several regressions focus on delegated background-agent turns triggered from realtime tool calls, including transcript-envelope construction, steering while a task is active, ordering of progress updates before final function output, shell-tool execution inside delegated turns, and ensuring sideband audio continues while delegated work is blocked. Additional tests verify append-only text behavior while a realtime response is active or cancelled, and that long backend outputs are truncated before being injected back into realtime context. The file also includes low-level helpers for multipart WebRTC call assertions, JSON normalization, gated SSE responses, config writing keyed off feature flags, and notification polling.

#### Function details

##### `RealtimeCallRequestCapture::new`  (lines 102–106)

```
fn new() -> Self
```

**Purpose**: Creates a request-capture matcher that records every wiremock request it sees.

**Data flow**: Allocates an `Arc<Mutex<Vec<WiremockRequest>>>` initialized to an empty vector and returns `RealtimeCallRequestCapture { requests }`.

**Call relations**: Harness setup and direct WebRTC tests instantiate this helper before mounting `/v1/realtime/calls` so later assertions can inspect the exact multipart request body.

*Call graph*: called by 5 (new_with_main_loop_responses_server_and_sandbox, realtime_webrtc_start_emits_sdp_notification, conversation_webrtc_start_posts_generated_session, conversation_webrtc_start_uses_avas_architecture_query, conversation_webrtc_start_uses_configured_call_base_url_for_avas); 3 external calls (new, new, new).


##### `RealtimeCallRequestCapture::single_request`  (lines 108–115)

```
fn single_request(&self) -> WiremockRequest
```

**Purpose**: Returns the only captured realtime call-create request, asserting exactly one was recorded.

**Data flow**: Locks the internal request vector, recovers from poison by taking the inner value, asserts `len() == 1`, clones the sole `WiremockRequest`, and returns it.

**Call relations**: WebRTC tests call this after startup to inspect the call-create HTTP request and verify SDP/session payload formatting.

*Call graph*: 1 external calls (assert_eq!).


##### `RealtimeCallRequestCapture::matches`  (lines 119–125)

```
fn matches(&self, request: &WiremockRequest) -> bool
```

**Purpose**: Implements `wiremock::Match` by recording the incoming request and always matching it.

**Data flow**: Locks the internal request vector, pushes a clone of the incoming `WiremockRequest`, and returns `true`.

**Call relations**: Wiremock invokes this matcher whenever the mounted `/v1/realtime/calls` endpoint is hit, allowing tests to capture requests without constraining them.

*Call graph*: 1 external calls (clone).


##### `normalized_json_string`  (lines 128–131)

```
fn normalized_json_string(raw: &str) -> Result<String>
```

**Purpose**: Parses and reserializes JSON to a canonical compact string for stable multipart-body comparisons.

**Data flow**: Parses the input string into `serde_json::Value`, adds context if parsing fails, then serializes it back with `serde_json::to_string`, again adding context on failure.

**Call relations**: Multipart assertion helpers and one direct WebRTC test use this to compare JSON session payloads independent of whitespace formatting.

*Call graph*: called by 2 (assert_call_create_multipart, realtime_webrtc_start_emits_sdp_notification); 2 external calls (from_str, to_string).


##### `GatedSseResponse::respond`  (lines 139–149)

```
fn respond(&self, _: &WiremockRequest) -> ResponseTemplate
```

**Purpose**: Delays an SSE response until an external gate is released, then returns the scripted SSE payload.

**Data flow**: Locks `gate_rx`, takes the optional `mpsc::Receiver<()>`, blocks on `recv()` if present, and finally returns `responses::sse_response(self.response.clone())`.

**Call relations**: Steering and nonblocking-audio tests mount this responder on the mock Responses server to keep a delegated background-agent turn in flight while other realtime events continue.

*Call graph*: calls 1 internal fn (sse_response).


##### `RealtimeTestVersion::config_value`  (lines 159–164)

```
fn config_value(self) -> &'static str
```

**Purpose**: Maps the test enum to the config string used in `[realtime].version`.

**Data flow**: Returns `"v1"` for `RealtimeTestVersion::V1` and `"v2"` for `RealtimeTestVersion::V2`.

**Call relations**: Config-writing helpers call this when generating `config.toml` for harness-backed tests.

*Call graph*: called by 1 (create_config_toml_with_realtime_version).


##### `RealtimeTestSandbox::config_value`  (lines 174–179)

```
fn config_value(self) -> &'static str
```

**Purpose**: Maps the sandbox enum to the config string used in `sandbox_mode`.

**Data flow**: Returns `"read-only"` or `"danger-full-access"` depending on the enum variant.

**Call relations**: Harness config generation uses this to switch delegated-turn shell-tool permissions for specific tests.

*Call graph*: called by 1 (create_config_toml_with_realtime_version).


##### `RealtimeE2eHarness::new`  (lines 213–227)

```
async fn new(
        realtime_version: RealtimeTestVersion,
        main_loop: MainLoopResponsesScript,
        realtime_sideband: RealtimeSidebandScript,
    ) -> Result<Self>
```

**Purpose**: Builds a full realtime test harness using a scripted Responses server and default read-only sandbox.

**Data flow**: Starts a mock Responses server from the provided scripted SSE responses, then forwards all setup to `new_with_main_loop_responses_server_and_sandbox` with `RealtimeTestSandbox::ReadOnly`.

**Call relations**: Most realtime integration tests call this constructor to get a ready-to-use app server, thread id, sideband server, and call-capture fixture.

*Call graph*: called by 11 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_forwards_audio_and_text_between_client_and_sideband, webrtc_v2_text_input_is_append_only_when_response_is_cancelled (+1 more)); 2 external calls (new_with_main_loop_responses_server_and_sandbox, create_mock_responses_server_sequence_unchecked).


##### `RealtimeE2eHarness::new_with_sandbox`  (lines 229–244)

```
async fn new_with_sandbox(
        realtime_version: RealtimeTestVersion,
        main_loop: MainLoopResponsesScript,
        realtime_sideband: RealtimeSidebandScript,
        sandbox: RealtimeTestSa
```

**Purpose**: Builds the full realtime harness while allowing the caller to choose the sandbox mode.

**Data flow**: Starts a mock Responses server from the provided script and forwards setup to `new_with_main_loop_responses_server_and_sandbox` with the supplied sandbox enum.

**Call relations**: The delegated shell-tool test uses this constructor so the background-agent turn can execute shell commands under `danger-full-access`.

*Call graph*: called by 1 (webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool); 2 external calls (new_with_main_loop_responses_server_and_sandbox, create_mock_responses_server_sequence_unchecked).


##### `RealtimeE2eHarness::new_with_main_loop_responses_server`  (lines 246–258)

```
async fn new_with_main_loop_responses_server(
        realtime_version: RealtimeTestVersion,
        main_loop_responses_server: MockServer,
        realtime_sideband: RealtimeSidebandScript,
    ) ->
```

**Purpose**: Builds the harness around an already-created mock Responses server, using the default read-only sandbox.

**Data flow**: Forwards the provided `MockServer`, realtime version, and sideband script to `new_with_main_loop_responses_server_and_sandbox` with `ReadOnly` sandbox.

**Call relations**: Tests that need custom wiremock behavior, such as gated SSE responses, call this constructor instead of letting the harness create the Responses server.

*Call graph*: called by 2 (webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_tool_call_does_not_block_sideband_audio); 1 external calls (new_with_main_loop_responses_server_and_sandbox).


##### `RealtimeE2eHarness::new_with_main_loop_responses_server_and_sandbox`  (lines 260–313)

```
async fn new_with_main_loop_responses_server_and_sandbox(
        realtime_version: RealtimeTestVersion,
        main_loop_responses_server: MockServer,
        realtime_sideband: RealtimeSidebandScri
```

**Purpose**: Performs the complete harness setup: call-create mock, sideband WebSocket server, config file, app-server startup, API-key login, and initial thread creation.

**Data flow**: Creates a `RealtimeCallRequestCapture`, mounts `POST /v1/realtime/calls` on the provided Responses server to return a fixed SDP answer and `Location` header, starts the sideband WebSocket server with scripted connections, creates a temp codex home, writes realtime config with selected version and sandbox, starts `TestAppServer`, initializes it, logs in with API key, sends `thread/start`, decodes `ThreadStartResponse`, and stores the resulting thread id alongside the servers and capture object in `RealtimeE2eHarness`.

**Call relations**: All harness constructors funnel into this method. It is the central orchestration point that wires together every external dependency needed by the higher-level realtime tests.

*Call graph*: calls 5 internal fn (new, new, create_config_toml_with_realtime_version, login_with_api_key, start_websocket_server_with_headers); 11 external calls (given, uri, new, new, Integer, default, Override, to_response, timeout, method (+1 more)).


##### `RealtimeE2eHarness::start_webrtc_realtime`  (lines 315–320)

```
async fn start_webrtc_realtime(&mut self, offer_sdp: &str) -> Result<StartedWebrtcRealtime>
```

**Purpose**: Starts realtime over WebRTC using default `codex_responses_as_items = None` behavior.

**Data flow**: Delegates to `start_webrtc_realtime_with_codex_responses_as_items(offer_sdp, None)` and returns the resulting `StartedWebrtcRealtime` bundle.

**Call relations**: Many WebRTC tests use this convenience wrapper when they do not need to force backend responses into realtime items.

*Call graph*: calls 1 internal fn (start_webrtc_realtime_with_codex_responses_as_items).


##### `RealtimeE2eHarness::start_webrtc_realtime_with_codex_response_items`  (lines 322–331)

```
async fn start_webrtc_realtime_with_codex_response_items(
        &mut self,
        offer_sdp: &str,
    ) -> Result<StartedWebrtcRealtime>
```

**Purpose**: Starts WebRTC realtime while explicitly enabling backend responses to be injected as realtime items.

**Data flow**: Delegates to `start_webrtc_realtime_with_codex_responses_as_items(offer_sdp, Some(true))` and returns the started/session-SDP notifications.

**Call relations**: Tests that assert backend output is reflected into realtime context call this wrapper to enable the item-injection mode.

*Call graph*: calls 1 internal fn (start_webrtc_realtime_with_codex_responses_as_items).


##### `RealtimeE2eHarness::start_webrtc_realtime_with_codex_responses_as_items`  (lines 333–377)

```
async fn start_webrtc_realtime_with_codex_responses_as_items(
        &mut self,
        offer_sdp: &str,
        codex_responses_as_items: Option<bool>,
    ) -> Result<StartedWebrtcRealtime>
```

**Purpose**: Sends the realtime-start RPC for WebRTC transport and waits for both the started and SDP notifications visible to the client.

**Data flow**: Builds `ThreadRealtimeStartParams` using the harness thread id, optional `codex_responses_as_items`, optional `codex_response_item_prefix`, audio output modality, optional backend prompt, and `ThreadRealtimeStartTransport::Webrtc { sdp }`. It sends the request, waits for and decodes the empty `ThreadRealtimeStartResponse`, then reads `thread/realtime/started` and `thread/realtime/sdp` notifications and returns them as `StartedWebrtcRealtime`.

**Call relations**: All harness WebRTC start helpers route through this method. It bridges the synchronous JSON-RPC start call and the asynchronous notifications that tests assert on next.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_start_request); called by 2 (start_webrtc_realtime, start_webrtc_realtime_with_codex_response_items); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::read_notification`  (lines 379–381)

```
async fn read_notification(&mut self, method: &str) -> Result<T>
```

**Purpose**: Harness-scoped wrapper around the module-level typed notification reader.

**Data flow**: Forwards the mutable harness app-server handle and method string to the free `read_notification` helper and returns the deserialized notification payload.

**Call relations**: Higher-level harness tests use this method to keep notification reads concise and tied to the harness instance.

*Call graph*: calls 1 internal fn (read_notification).


##### `RealtimeE2eHarness::sideband_outbound_request`  (lines 385–394)

```
async fn sideband_outbound_request(&self, request_index: usize) -> Value
```

**Purpose**: Returns the nth JSON frame the app server sent upstream on the fake realtime sideband WebSocket.

**Data flow**: Waits under `DEFAULT_TIMEOUT` for `realtime_server.wait_for_request(0, request_index)`, panics if the timeout expires, and returns the request body parsed as JSON `Value`.

**Call relations**: Most harness-backed tests use this to assert exact upstream protocol frames such as `session.update`, `conversation.item.create`, `function_call_output`, and `response.create`.

*Call graph*: calls 1 internal fn (wait_for_request); 1 external calls (timeout).


##### `RealtimeE2eHarness::append_audio`  (lines 396–418)

```
async fn append_audio(&mut self, thread_id: String) -> Result<()>
```

**Purpose**: Sends a realtime append-audio RPC with a fixed sample chunk and asserts the typed success response.

**Data flow**: Builds `ThreadRealtimeAppendAudioParams` with the provided thread id and a `ThreadRealtimeAudioChunk` containing base64 `BQYH`, 24 kHz mono metadata, and no item id; sends the request; waits for the response; decodes `ThreadRealtimeAppendAudioResponse`; and returns success.

**Call relations**: Harness-backed streaming tests call this helper to drive client-to-realtime audio input without repeating request boilerplate.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_append_audio_request); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::append_text`  (lines 420–437)

```
async fn append_text(&mut self, thread_id: String, text: &str) -> Result<()>
```

**Purpose**: Sends a realtime append-text RPC as a user text message and asserts success.

**Data flow**: Builds `ThreadRealtimeAppendTextParams` with the provided thread id, text, and `ConversationTextRole::User`, sends the request, waits for the response, decodes `ThreadRealtimeAppendTextResponse`, and returns success.

**Call relations**: Used by harness tests that verify user text is translated into upstream realtime conversation items.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_append_text_request); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::append_speech`  (lines 439–455)

```
async fn append_speech(&mut self, thread_id: String, text: &str) -> Result<()>
```

**Purpose**: Sends a realtime append-speech RPC and asserts the typed success response.

**Data flow**: Builds `ThreadRealtimeAppendSpeechParams` from the provided thread id and text, sends the request, waits for the response, decodes `ThreadRealtimeAppendSpeechResponse`, and returns success.

**Call relations**: Tests use this helper when they want app-server to inject spoken progress or manual updates back into realtime.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_append_speech_request); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::main_loop_responses_requests`  (lines 457–459)

```
async fn main_loop_responses_requests(&self) -> Result<Vec<Value>>
```

**Purpose**: Fetches the JSON bodies of all mocked Responses API requests issued during the test.

**Data flow**: Delegates to `responses_requests(&self.main_loop_responses_server)` and returns the collected `Vec<Value>`.

**Call relations**: Delegation tests call this after a background-agent turn completes to inspect the exact prompt/context sent to the ordinary Responses API.

*Call graph*: calls 1 internal fn (responses_requests).


##### `RealtimeE2eHarness::shutdown`  (lines 461–463)

```
async fn shutdown(self)
```

**Purpose**: Stops the fake realtime sideband server owned by the harness.

**Data flow**: Consumes the harness and awaits `self.realtime_server.shutdown()`.

**Call relations**: Most harness-backed tests call this at the end to cleanly terminate the sideband server.

*Call graph*: calls 1 internal fn (shutdown).


##### `main_loop_responses`  (lines 466–468)

```
fn main_loop_responses(responses: Vec<String>) -> MainLoopResponsesScript
```

**Purpose**: Wraps a vector of scripted SSE payload strings into `MainLoopResponsesScript`.

**Data flow**: Constructs and returns `MainLoopResponsesScript { responses }`.

**Call relations**: Many harness-backed tests use this helper to describe the mocked ordinary Responses stream that delegated background-agent turns will consume.

*Call graph*: called by 9 (no_main_loop_responses, realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool).


##### `no_main_loop_responses`  (lines 470–472)

```
fn no_main_loop_responses() -> MainLoopResponsesScript
```

**Purpose**: Creates an empty main-loop Responses script.

**Data flow**: Calls `main_loop_responses(Vec::new())` and returns the resulting script.

**Call relations**: Tests that only exercise realtime transport behavior without delegated background-agent turns use this helper.

*Call graph*: calls 1 internal fn (main_loop_responses); called by 4 (webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband, webrtc_v2_forwards_audio_and_text_between_client_and_sideband, webrtc_v2_text_input_is_append_only_when_response_is_cancelled, webrtc_v2_text_input_is_append_only_while_response_is_active); 1 external calls (new).


##### `realtime_sideband`  (lines 474–476)

```
fn realtime_sideband(connections: Vec<WebSocketConnectionConfig>) -> RealtimeSidebandScript
```

**Purpose**: Wraps scripted WebSocket connection configs into `RealtimeSidebandScript`.

**Data flow**: Constructs and returns `RealtimeSidebandScript { connections }`.

**Call relations**: Harness-backed tests use this helper to define the fake realtime server’s per-connection event scripts.

*Call graph*: called by 14 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_forwards_audio_and_text_between_client_and_sideband (+4 more)).


##### `realtime_sideband_connection`  (lines 478–487)

```
fn realtime_sideband_connection(
    realtime_server_events: Vec<Vec<Value>>,
) -> WebSocketConnectionConfig
```

**Purpose**: Builds a sideband connection config that closes after the scripted requests are consumed.

**Data flow**: Returns `WebSocketConnectionConfig` with the provided request batches, empty response headers, no accept delay, and `close_after_requests = true`.

**Call relations**: Most scripted sideband scenarios use this helper as the default connection behavior.

*Call graph*: called by 1 (open_realtime_sideband_connection); 1 external calls (new).


##### `open_realtime_sideband_connection`  (lines 489–496)

```
fn open_realtime_sideband_connection(
    realtime_server_events: Vec<Vec<Value>>,
) -> WebSocketConnectionConfig
```

**Purpose**: Builds a sideband connection config that stays open after scripted requests.

**Data flow**: Creates a `WebSocketConnectionConfig` by reusing `realtime_sideband_connection` and overriding `close_after_requests = false`.

**Call relations**: The v1 WebRTC startup test uses this helper to prove the transport remains alive after SDP exchange.

*Call graph*: calls 1 internal fn (realtime_sideband_connection).


##### `session_updated`  (lines 498–503)

```
fn session_updated(realtime_session_id: &str) -> Value
```

**Purpose**: Creates a minimal `session.updated` server event fixture for the fake realtime sideband.

**Data flow**: Returns a JSON value with `type = session.updated` and a `session` object containing the supplied realtime session id and fixed instructions `backend prompt`.

**Call relations**: Many sideband scripts begin with this event so the app server can observe the upstream session id and initial instructions.

*Call graph*: 1 external calls (json!).


##### `v2_background_agent_tool_call`  (lines 505–516)

```
fn v2_background_agent_tool_call(call_id: &str, prompt: &str) -> Value
```

**Purpose**: Creates a v2 realtime `conversation.item.done` function-call event for the `background_agent` tool.

**Data flow**: Returns a JSON value whose `item` has type `function_call`, name `background_agent`, the supplied `call_id`, and serialized JSON arguments containing the supplied prompt.

**Call relations**: Delegation and steering tests use this fixture to trigger app-server background-agent handoff logic from the fake realtime sideband.

*Call graph*: 1 external calls (json!).


##### `realtime_conversation_streams_v2_notifications`  (lines 519–831)

```
async fn realtime_conversation_streams_v2_notifications() -> Result<()>
```

**Purpose**: End-to-end test for the v2 realtime notification stream, covering startup, audio/text append, transcript deltas, item-added events, handoff requests, upstream errors, and closure.

**Data flow**: Starts a mock Responses server and a scripted realtime WebSocket server that emits session update, output audio delta, assistant item, transcript deltas/done, a background-agent function call, and an error. It writes realtime-enabled config, starts and logs into the app server, creates a thread, starts realtime with audio modality and explicit model/voice, asserts the startup `session.update` request and handshake URI, appends audio and developer text, then reads and asserts typed notifications for output audio, item added, transcript deltas, transcript done, handoff item added, realtime error, and closed. Finally it inspects the outbound sideband requests to confirm one `session.update`, one `conversation.item.create` for developer text, and one `input_audio_buffer.append`.

**Call relations**: This is a broad top-level integration test that exercises the core v2 realtime transport path without the harness abstraction, directly proving client-visible notifications and upstream sideband translation.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 10 external calls (new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `realtime_start_can_skip_startup_context`  (lines 834–905)

```
async fn realtime_start_can_skip_startup_context() -> Result<()>
```

**Purpose**: Verifies `include_startup_context = false` suppresses generated startup context in the initial realtime instructions.

**Data flow**: Starts empty mock Responses and realtime servers, writes realtime-enabled config with generated startup context available, starts and logs into the app server, creates a thread, starts realtime with `include_startup_context: Some(false)`, waits for the started notification, then inspects the first sideband `session.update` request and asserts its instructions equal only `backend prompt` without the startup-context header.

**Call relations**: This test isolates one startup parameter branch in the realtime-start path and validates it by inspecting the upstream sideband request.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 11 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout (+1 more)).


##### `realtime_text_output_modality_requests_text_output_and_final_transcript`  (lines 908–1045)

```
async fn realtime_text_output_modality_requests_text_output_and_final_transcript() -> Result<()>
```

**Purpose**: Checks that text output modality requests `output_modalities = ["text"]` and that transcript notifications are emitted from text output without duplication from audio transcript completion.

**Data flow**: Starts mock servers where the sideband emits `session.updated`, two `response.output_text.delta` events, `response.output_audio_transcript.done`, and a final assistant message item. After config, startup, login, thread creation, and realtime start with `RealtimeOutputModality::Text`, it inspects the initial `session.update` request for `output_modalities = ["text"]`, then reads two transcript-delta notifications and one transcript-done notification and compares them to expected typed values. It finally asserts that no duplicate transcript-done notification arrives within 200 ms.

**Call relations**: This top-level test focuses on modality-specific translation from upstream realtime events into client notifications.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 11 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout (+1 more)).


##### `realtime_list_voices_returns_supported_names`  (lines 1048–1105)

```
async fn realtime_list_voices_returns_supported_names() -> Result<()>
```

**Purpose**: Verifies the voice-list RPC returns the expected supported voice sets and defaults for realtime v1 and v2.

**Data flow**: Writes realtime-enabled config pointing at dummy URLs, starts the app server, sends `thread/realtime/listVoices`, decodes `ThreadRealtimeListVoicesResponse`, and asserts the exact `RealtimeVoicesList` contents for `v1`, `v2`, `default_v1`, and `default_v2`.

**Call relations**: This is a pure RPC test with no network side effects; it validates static capability reporting from the app server.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `realtime_conversation_stop_emits_closed_notification`  (lines 1108–1194)

```
async fn realtime_conversation_stop_emits_closed_notification() -> Result<()>
```

**Purpose**: Ensures stopping an active realtime conversation returns success and emits a closed notification.

**Data flow**: Starts mock servers, writes realtime-enabled config, starts and logs into the app server, creates a thread, starts realtime with audio modality and backend prompt, reads the started notification, sends `thread/realtime/stop`, decodes `ThreadRealtimeStopResponse`, then reads `ThreadRealtimeClosedNotification` and asserts the thread id and a close reason of either `requested` or `transport_closed`.

**Call relations**: This test covers the explicit stop path after successful realtime startup and validates the asynchronous closure notification.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 11 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout (+1 more)).


##### `realtime_webrtc_start_emits_sdp_notification`  (lines 1197–1363)

```
async fn realtime_webrtc_start_emits_sdp_notification() -> Result<()>
```

**Purpose**: Verifies WebRTC realtime startup performs call creation, emits started and SDP notifications, joins the sideband with the returned call id, and sends the expected multipart session payload.

**Data flow**: Starts a mock Responses server with a captured `/v1/realtime/calls` endpoint returning `Location: /v1/realtime/calls/rtc_app_test` and SDP answer, plus a sideband WebSocket server. After writing config, starting and logging into the app server, and creating a thread, it sends realtime start with `ThreadRealtimeStartTransport::Webrtc { sdp: "v=offer\r\n" }`, decodes the start response, reads started and SDP notifications, inspects the first sideband `session.update` request and handshake URI, sends realtime stop and reads the closed notification, then inspects the captured HTTP request headers and multipart body to assert exact SDP and normalized JSON session contents.

**Call relations**: This direct WebRTC test covers the full call-create plus sideband-join path without the harness abstraction, and it uses `normalized_json_string` for stable multipart comparison.

*Call graph*: calls 6 internal fn (new, new, create_config_toml, login_with_api_key, normalized_json_string, start_websocket_server_with_headers); 17 external calls (given, new, from_utf8, new, new, Integer, default, Override, create_mock_responses_server_sequence_unchecked, to_response (+7 more)).


##### `webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband`  (lines 1366–1424)

```
async fn webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband() -> Result<()>
```

**Purpose**: Harness-backed regression test for Realtime V1 WebRTC startup semantics.

**Data flow**: Builds a v1 harness with no delegated Responses traffic and an open sideband connection that emits `session.updated`, starts WebRTC realtime, asserts the returned `StartedWebrtcRealtime` contains v1 started and SDP notifications, verifies the captured call-create multipart body against `v1_session_create_json`, inspects the first sideband request with `assert_v1_session_update`, checks the handshake URI includes `intent=quicksilver&call_id=rtc_e2e`, and confirms no immediate `thread/realtime/closed` notification arrives.

**Call relations**: This test uses the reusable harness to focus on v1-specific startup differences from v2, especially the session type and sideband join URI.

*Call graph*: calls 6 internal fn (new, assert_call_create_multipart, assert_v1_session_update, no_main_loop_responses, realtime_sideband, v1_session_create_json); 6 external calls (from_millis, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v1_default_automatic_output_uses_handoff_append`  (lines 1427–1481)

```
async fn webrtc_v1_default_automatic_output_uses_handoff_append() -> Result<()>
```

**Purpose**: Checks that automatic output from a delegated v1 background-agent turn is sent back to realtime as `conversation.handoff.append`.

**Data flow**: Creates a v1 harness whose delegated Responses turn returns `legacy automatic speech`, starts WebRTC realtime, verifies the initial v1 session update, starts a normal turn with user text, waits for `turn/completed`, then inspects the second sideband outbound request and asserts it is a `conversation.handoff.append` with `handoff_id = codex` and the delegated output text.

**Call relations**: This harness-backed test covers the v1 automatic-output path after a standard app-server turn completes.

*Call graph*: calls 4 internal fn (new, assert_v1_session_update, main_loop_responses, realtime_sideband); 7 external calls (default, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks`  (lines 1484–1585)

```
async fn webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks() -> Result<()>
```

**Purpose**: Verifies a v1 handoff request launches a delegated Responses turn with transcript context and that manual speech append uses `conversation.handoff.append`.

**Data flow**: Creates a v1 harness whose sideband emits session update, completed user transcription, assistant transcript deltas, and `conversation.handoff.requested`, while the delegated Responses turn returns `delegated from v1`. After starting WebRTC realtime with backend responses as items, it waits for `turn/started` and `turn/completed`, fetches the mocked Responses request and asserts it contains a `<realtime_delegation>` envelope with input and transcript delta context, inspects the sideband context update item carrying the delegated result under `RESPONSE_ITEM_PREFIX`, then calls `append_speech` and asserts the next sideband request is a spoken `conversation.handoff.append`.

**Call relations**: This test exercises the v1 delegated-handoff path end to end, linking sideband tool-like events to a background-agent turn and then back to realtime context and speech.

*Call graph*: calls 6 internal fn (new, assert_call_create_multipart, assert_v1_session_update, main_loop_responses, realtime_sideband, v1_session_create_json); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `realtime_automatic_standalone_output_is_item_and_append_speaks`  (lines 1588–1664)

```
async fn realtime_automatic_standalone_output_is_item_and_append_speaks() -> Result<()>
```

**Purpose**: Checks that in v2, automatic standalone backend output is injected as a realtime context item, while manual speech append triggers both a progress item and `response.create`.

**Data flow**: Creates a v2 harness whose delegated Responses turn returns `automatic output`, starts WebRTC realtime with backend responses as items, starts a normal turn with user text, waits for `turn/completed`, asserts the next sideband request is a backend item update via `assert_v2_backend_item_update`, confirms no automatic `response.create` follows, then calls `append_speech` and asserts the subsequent sideband requests are a progress update and a `response.create`.

**Call relations**: This harness-backed test distinguishes automatic backend context injection from explicit spoken updates in the v2 protocol.

*Call graph*: calls 6 internal fn (new, assert_v2_backend_item_update, assert_v2_progress_update, assert_v2_response_create, main_loop_responses, realtime_sideband); 9 external calls (default, from_millis, Integer, to_response, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `realtime_automatic_handoff_output_is_item_and_append_speaks`  (lines 1667–1738)

```
async fn realtime_automatic_handoff_output_is_item_and_append_speaks() -> Result<()>
```

**Purpose**: Verifies that automatic output from a v2 background-agent handoff becomes a backend item plus empty function-call output, while manual speech append still requests a realtime response.

**Data flow**: Creates a v2 harness whose sideband emits a background-agent tool call and whose delegated Responses turn returns `automatic final response`, starts WebRTC realtime with backend responses as items, waits for `turn/started` and `turn/completed`, asserts sideband request 1 is a backend item update, request 2 is a `function_call_output` with empty output for the original call id, confirms no automatic `response.create` follows, then appends speech and asserts the next two sideband requests are a progress update and `response.create`.

**Call relations**: This test covers the v2 handoff-completion path where realtime should receive both context and tool-call completion without automatically speaking.

*Call graph*: calls 7 internal fn (new, assert_v2_backend_item_update, assert_v2_function_call_output, assert_v2_progress_update, assert_v2_response_create, main_loop_responses, realtime_sideband); 6 external calls (from_millis, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v2_assistant_output_without_handoff_reaches_realtime_context`  (lines 1741–1818)

```
async fn webrtc_v2_assistant_output_without_handoff_reaches_realtime_context() -> Result<()>
```

**Purpose**: Ensures direct assistant output from a normal v2 turn, even when long, is injected back into realtime context with truncation markers and size limits.

**Data flow**: Creates a v2 harness whose mocked Responses stream emits a commentary preamble and a very long final assistant message, starts WebRTC realtime with backend responses as items, starts a normal text turn, waits for `turn/completed`, asserts the first sideband update is a backend item for the preamble, then inspects the next sideband `conversation.item.create` developer message and checks that its text starts with `RESPONSE_ITEM_PREFIX` plus `[BACKEND]`, contains `tokens truncated`, and is at most 4000 characters.

**Call relations**: This harness-backed regression test focuses on the path that mirrors ordinary assistant output into realtime context without any background-agent handoff.

*Call graph*: calls 4 internal fn (new, assert_v2_backend_item_update, main_loop_responses, realtime_sideband); 8 external calls (default, Integer, to_response, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v2_forwards_audio_and_text_between_client_and_sideband`  (lines 1821–1897)

```
async fn webrtc_v2_forwards_audio_and_text_between_client_and_sideband() -> Result<()>
```

**Purpose**: Verifies v2 WebRTC forwards client audio/text upstream and translates upstream transcript/audio events back into client notifications.

**Data flow**: Creates a v2 harness whose sideband emits `session.updated`, then later an input-audio transcription delta and output-audio delta. After starting WebRTC realtime and asserting the initial v2 session update, it appends audio and text through the harness, reads transcript-delta and output-audio notifications from the app server, then inspects the outbound sideband requests to confirm one `input_audio_buffer.append` with `BQYH` and one user `conversation.item.create` carrying `[USER] hello`.

**Call relations**: This test covers the bidirectional streaming path between client RPCs and the upstream realtime sideband in v2.

*Call graph*: calls 4 internal fn (new, assert_v2_session_update, no_main_loop_responses, realtime_sideband); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_text_input_is_append_only_while_response_is_active`  (lines 1904–1973)

```
async fn webrtc_v2_text_input_is_append_only_while_response_is_active() -> Result<()>
```

**Purpose**: Regression test ensuring v2 text input remains append-only while an upstream realtime response is active and does not trigger a new `response.create`.

**Data flow**: Creates a v2 harness whose sideband emits `session.updated`, then `response.created` and a transcript delta, and only later `response.done`. After startup and initial session-update assertion, it appends first text and verifies the corresponding user text item upstream, reads the transcript delta, appends second text while the response is still active, verifies another user text item upstream, then appends audio and confirms audio forwarding still works.

**Call relations**: This harness-backed test targets a specific concurrency regression in the v2 sideband state machine around active responses.

*Call graph*: calls 5 internal fn (new, assert_v2_session_update, assert_v2_user_text_item, no_main_loop_responses, realtime_sideband); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_text_input_is_append_only_when_response_is_cancelled`  (lines 1978–2031)

```
async fn webrtc_v2_text_input_is_append_only_when_response_is_cancelled() -> Result<()>
```

**Purpose**: Regression test ensuring append-only v2 text behavior also holds when the active response is later cancelled instead of completed.

**Data flow**: Creates a v2 harness whose sideband emits `session.updated`, then `response.created`, and only later `response.cancelled`. After startup and session-update assertion, it appends first text and verifies the user text item, appends second text while the response is still active, verifies another user text item, then appends audio and confirms the next upstream request is `input_audio_buffer.append` with `BQYH`.

**Call relations**: This test mirrors the active-response case but covers the cancellation branch to prevent regressions in response-lifecycle bookkeeping.

*Call graph*: calls 5 internal fn (new, assert_v2_session_update, assert_v2_user_text_item, no_main_loop_responses, realtime_sideband); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output`  (lines 2039–2128)

```
async fn webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output() -> Result<()>
```

**Purpose**: Verifies a v2 `background_agent` function call launches a delegated Responses turn with cleaned transcript context, sends progress to realtime, and then returns final function-call output.

**Data flow**: Creates a v2 harness whose sideband emits multiple completed transcriptions, a hidden collaboration-update message, an assistant transcript delta, and finally a background-agent tool call, while the delegated Responses turn returns `delegated from v2`. After startup it waits for `turn/started` and `turn/completed`, fetches the mocked Responses request and asserts it contains a `<realtime_delegation>` envelope with the expected transcript history but excludes the hidden collaboration-update text, then inspects sideband request 1 as a progress update and request 2 as a `function_call_output` carrying `V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT`.

**Call relations**: This is a core v2 delegation regression test linking sideband function calls to delegated background-agent execution and final tool output.

*Call graph*: calls 5 internal fn (new, assert_v2_function_call_output, assert_v2_progress_update, main_loop_responses, realtime_sideband); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_background_agent_steering_ack_requests_response_create`  (lines 2137–2217)

```
async fn webrtc_v2_background_agent_steering_ack_requests_response_create() -> Result<()>
```

**Purpose**: Checks that a second v2 background-agent tool call arriving while one is active is treated as steering: it is acknowledged immediately and later included in a follow-up delegated Responses request.

**Data flow**: Starts a custom mock Responses server whose first delegated SSE response is gated, then builds a v2 harness whose sideband emits two background-agent tool calls back to back. After startup and `turn/started`, it asserts sideband request 1 is a `function_call_output` for the steering call containing `V2_STEERING_ACKNOWLEDGEMENT`, and request 2 is `response.create`. It then releases the gated delegated turn, waits for `turn/completed`, fetches the two mocked Responses requests, and asserts the second request contains the steering prompt text.

**Call relations**: This multi-threaded regression test exercises active-handoff steering behavior and proves the acknowledgement path does not drop the steering instruction.

*Call graph*: calls 7 internal fn (new_with_main_loop_responses_server, assert_v2_function_call_output, assert_v2_response_create, assert_v2_session_update, realtime_sideband, sse, start_mock_server); 9 external calls (given, new, assert!, assert_eq!, channel, skip_if_no_network!, vec!, method, path_regex).


##### `webrtc_v2_background_agent_progress_is_sent_before_function_output`  (lines 2220–2259)

```
async fn webrtc_v2_background_agent_progress_is_sent_before_function_output() -> Result<()>
```

**Purpose**: Ensures v2 sends delegated progress into realtime before the final function-call output item.

**Data flow**: Creates a v2 harness whose sideband emits one background-agent tool call and whose delegated Responses turn returns `progress before final`, starts WebRTC realtime, waits for `turn/completed`, then inspects sideband request 1 as a progress update and request 2 as the final `function_call_output` with `V2_HANDOFF_COMPLETE_ACKNOWLEDGEMENT`.

**Call relations**: This test isolates ordering guarantees in the v2 handoff-completion path.

*Call graph*: calls 5 internal fn (new, assert_v2_function_call_output, assert_v2_progress_update, main_loop_responses, realtime_sideband); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool`  (lines 2262–2349)

```
async fn webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool() -> Result<()>
```

**Purpose**: Verifies a delegated background-agent turn triggered from realtime can execute a shell tool and feed its output back through Responses and then realtime.

**Data flow**: Builds a v2 harness in `DangerFullAccess` sandbox with a delegated Responses script that first requests a shell command and then returns `shell tool finished`, while the sideband emits a background-agent tool call. After startup, it waits for `item/started` and `item/completed` notifications whose `ThreadItem` is `CommandExecution`, asserting the shell call id, status transitions, and aggregated output `realtime-tool-ok`. It then waits for `turn/completed`, fetches the mocked Responses requests to confirm the shell output appears in the follow-up request, and inspects sideband requests for progress update and final function-call output.

**Call relations**: This harness-backed test ties together realtime delegation, delegated shell-tool execution, thread item notifications, and final realtime handoff completion.

*Call graph*: calls 7 internal fn (new_with_sandbox, assert_v2_function_call_output, assert_v2_progress_update, main_loop_responses, realtime_sideband, wait_for_completed_command_execution, wait_for_started_command_execution); 5 external calls (assert!, assert_eq!, skip_if_no_network!, unreachable!, vec!).


##### `webrtc_v2_tool_call_does_not_block_sideband_audio`  (lines 2352–2429)

```
async fn webrtc_v2_tool_call_does_not_block_sideband_audio() -> Result<()>
```

**Purpose**: Ensures sideband audio events continue to flow to the client while a delegated background-agent turn is blocked waiting on Responses.

**Data flow**: Starts a custom gated Responses server and a v2 harness whose sideband emits a background-agent tool call followed immediately by output-audio delta. After startup and `turn/started`, it reads `thread/realtime/outputAudio/delta` and asserts the audio chunk arrived before the delegated turn completed. It then releases the gate, waits for `turn/completed`, and inspects sideband requests for the later progress update and final function-call output.

**Call relations**: This multi-threaded regression test covers nonblocking behavior between delegated-turn execution and independent sideband event fan-out.

*Call graph*: calls 6 internal fn (new_with_main_loop_responses_server, assert_v2_function_call_output, assert_v2_progress_update, realtime_sideband, sse, start_mock_server); 8 external calls (given, new, assert_eq!, channel, skip_if_no_network!, vec!, method, path_regex).


##### `realtime_webrtc_start_surfaces_backend_error`  (lines 2432–2502)

```
async fn realtime_webrtc_start_surfaces_backend_error() -> Result<()>
```

**Purpose**: Verifies a failing WebRTC call-create backend request is surfaced to the client as a realtime error notification rather than a failed start RPC.

**Data flow**: Starts a mock Responses server whose `POST /v1/realtime/calls` returns 500 `boom`, plus a dummy realtime WebSocket server, writes realtime-enabled config, starts and logs into the app server, creates a thread, sends realtime start with WebRTC transport, decodes the nominal `ThreadRealtimeStartResponse`, then reads `ThreadRealtimeErrorNotification` and asserts its message mentions high demand.

**Call relations**: This test covers asynchronous error delivery for WebRTC startup failures after the JSON-RPC start request itself has already returned.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 15 external calls (given, new, new, new, Integer, default, Override, create_mock_responses_server_sequence_unchecked, to_response, assert! (+5 more)).


##### `realtime_conversation_requires_feature_flag`  (lines 2505–2564)

```
async fn realtime_conversation_requires_feature_flag() -> Result<()>
```

**Purpose**: Ensures realtime conversation RPCs are rejected when the realtime feature flag is disabled in config.

**Data flow**: Starts mock Responses and realtime servers, writes config with realtime disabled, starts the app server, creates a thread, sends realtime start, reads the error response, and passes it to `assert_invalid_request` with a message naming the thread id and stating it does not support realtime conversation.

**Call relations**: This top-level test covers feature gating before any realtime transport setup occurs.

*Call graph*: calls 4 internal fn (new, assert_invalid_request, create_config_toml, start_websocket_server); 10 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, format!, skip_if_no_network!, timeout, vec!).


##### `read_notification`  (lines 2566–2579)

```
async fn read_notification(
    mcp: &mut TestAppServer,
    method: &str,
) -> Result<T>
```

**Purpose**: Reads a notification by method name under the standard timeout and deserializes its params into a typed payload.

**Data flow**: Waits for `read_stream_until_notification_message(method)` under `DEFAULT_TIMEOUT`, extracts `params` with context if absent, deserializes them with `serde_json::from_value`, and returns the typed value.

**Call relations**: Both the harness method and many direct tests use this helper to consume typed notifications from the app server stream.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (read_notification); 2 external calls (from_value, timeout).


##### `login_with_api_key`  (lines 2581–2592)

```
async fn login_with_api_key(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: Logs into the app server with an API key and asserts the typed login response is `ApiKey`.

**Data flow**: Sends `send_login_account_api_key_request(api_key)`, waits for the matching response under `DEFAULT_TIMEOUT`, converts it with `to_response`, asserts it equals `LoginAccountResponse::ApiKey {}`, and returns success.

**Call relations**: Harness setup and several direct realtime tests call this helper before starting threads or realtime sessions.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_login_account_api_key_request); called by 7 (new_with_main_loop_responses_server_and_sandbox, realtime_conversation_stop_emits_closed_notification, realtime_conversation_streams_v2_notifications, realtime_start_can_skip_startup_context, realtime_text_output_modality_requests_text_output_and_final_transcript, realtime_webrtc_start_emits_sdp_notification, realtime_webrtc_start_surfaces_backend_error); 4 external calls (Integer, to_response, assert_eq!, timeout).


##### `wait_for_started_command_execution`  (lines 2594–2603)

```
async fn wait_for_started_command_execution(
    mcp: &mut TestAppServer,
) -> Result<ItemStartedNotification>
```

**Purpose**: Consumes notifications until it finds an `item/started` notification whose item is a command execution.

**Data flow**: Loops calling `read_notification::<ItemStartedNotification>(..., "item/started")` until `started.item` matches `ThreadItem::CommandExecution`, then returns that notification.

**Call relations**: The delegated shell-tool test uses this helper to ignore unrelated item-started notifications and focus on the shell command execution item.

*Call graph*: called by 1 (webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool).


##### `wait_for_completed_command_execution`  (lines 2605–2615)

```
async fn wait_for_completed_command_execution(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Consumes notifications until it finds an `item/completed` notification whose item is a command execution.

**Data flow**: Loops calling `read_notification::<ItemCompletedNotification>(..., "item/completed")` until `completed.item` matches `ThreadItem::CommandExecution`, then returns that notification.

**Call relations**: Used alongside `wait_for_started_command_execution` in the delegated shell-tool test to observe command completion.

*Call graph*: called by 1 (webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool).


##### `responses_requests`  (lines 2617–2630)

```
async fn responses_requests(server: &MockServer) -> Result<Vec<Value>>
```

**Purpose**: Collects and parses all recorded mock Responses API request bodies from a wiremock server.

**Data flow**: Fetches `received_requests()` from the server with context on failure, filters requests whose path ends with `/responses`, parses each body as JSON `Value`, and returns the collected vector.

**Call relations**: Harness methods and delegation tests use this helper to inspect the exact prompts/context sent to the ordinary Responses API.

*Call graph*: called by 1 (main_loop_responses_requests); 1 external calls (received_requests).


##### `response_request_contains_text`  (lines 2632–2643)

```
fn response_request_contains_text(request: &Value, text: &str) -> bool
```

**Purpose**: Recursively searches an arbitrary JSON value for a substring in any nested string field.

**Data flow**: Matches on `serde_json::Value`: for strings it checks `contains(text)`, for arrays and objects it recurses into elements/values, and for null/bool/number it returns `false`.

**Call relations**: Delegation tests use this helper when asserting that mocked Responses requests contain specific transcript envelopes, steering prompts, or shell output somewhere in their nested JSON structure.


##### `realtime_tool_ok_command`  (lines 2645–2660)

```
fn realtime_tool_ok_command() -> Vec<String>
```

**Purpose**: Returns a platform-specific shell command vector that prints `realtime-tool-ok`.

**Data flow**: On Windows it returns a PowerShell command writing to console; on non-Windows it returns `printf realtime-tool-ok`.

**Call relations**: The delegated shell-tool test passes this command into `create_shell_command_sse_response` so the delegated turn executes a deterministic command.

*Call graph*: 1 external calls (vec!).


##### `assert_v2_function_call_output`  (lines 2662–2674)

```
fn assert_v2_function_call_output(request: &Value, call_id: &str, expected_output: &str)
```

**Purpose**: Asserts a sideband request is exactly the expected v2 `function_call_output` item.

**Data flow**: Compares the provided JSON value against a constructed object with `type = conversation.item.create`, `item.type = function_call_output`, the supplied `call_id`, and the supplied `output` string.

**Call relations**: Many v2 delegation tests use this helper to verify final tool-call completion or steering acknowledgements sent upstream.

*Call graph*: called by 6 (realtime_automatic_handoff_output_is_item_and_append_speaks, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool, webrtc_v2_tool_call_does_not_block_sideband_audio); 1 external calls (assert_eq!).


##### `assert_v2_progress_update`  (lines 2676–2691)

```
fn assert_v2_progress_update(request: &Value, expected_text: &str)
```

**Purpose**: Asserts a sideband request is the expected v2 user-message progress update carrying `[BACKEND] ...` text.

**Data flow**: Compares the provided JSON value against a constructed `conversation.item.create` message with role `user` and one `input_text` content item containing `[BACKEND] <expected_text>`.

**Call relations**: Used by v2 tests that expect delegated progress or manual speech updates to be surfaced upstream before or alongside response creation.

*Call graph*: called by 6 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool, webrtc_v2_tool_call_does_not_block_sideband_audio); 1 external calls (assert_eq!).


##### `assert_v2_backend_item_update`  (lines 2693–2695)

```
fn assert_v2_backend_item_update(request: &Value, expected_text: &str)
```

**Purpose**: Asserts a sideband request is a backend context item update prefixed with `[BACKEND]` and wrapped under `RESPONSE_ITEM_PREFIX`.

**Data flow**: Formats `[BACKEND] <expected_text>` and forwards to `assert_v2_items_update`.

**Call relations**: Tests that mirror backend output into realtime context use this helper instead of spelling out the full developer-message JSON each time.

*Call graph*: calls 1 internal fn (assert_v2_items_update); called by 3 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context); 1 external calls (format!).


##### `assert_v2_items_update`  (lines 2697–2712)

```
fn assert_v2_items_update(request: &Value, expected_text: &str)
```

**Purpose**: Asserts a sideband request is a developer message item carrying the standard response-item prefix plus supplied text.

**Data flow**: Compares the provided JSON value against a `conversation.item.create` developer message whose single `input_text` content is `RESPONSE_ITEM_PREFIX + "\n\n" + expected_text`.

**Call relations**: This is the underlying assertion used by `assert_v2_backend_item_update` and by tests that check direct context injection into realtime.

*Call graph*: called by 1 (assert_v2_backend_item_update); 1 external calls (assert_eq!).


##### `assert_v2_user_text_item`  (lines 2714–2729)

```
fn assert_v2_user_text_item(request: &Value, expected_text: &str)
```

**Purpose**: Asserts a sideband request is a v2 user text item with the `[USER]` prefix.

**Data flow**: Compares the provided JSON value against a `conversation.item.create` user message whose single `input_text` content is `[USER] <expected_text>`.

**Call relations**: Append-only text regression tests use this helper to verify that text input is forwarded upstream without extra response-creation side effects.

*Call graph*: called by 2 (webrtc_v2_text_input_is_append_only_when_response_is_cancelled, webrtc_v2_text_input_is_append_only_while_response_is_active); 1 external calls (assert_eq!).


##### `assert_v2_response_create`  (lines 2731–2738)

```
fn assert_v2_response_create(request: &Value)
```

**Purpose**: Asserts a sideband request is exactly `{ "type": "response.create" }`.

**Data flow**: Performs an equality assertion against the fixed JSON object.

**Call relations**: Used in tests where app-server should explicitly ask realtime to speak or react after a manual update or steering acknowledgement.

*Call graph*: called by 3 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v2_background_agent_steering_ack_requests_response_create); 1 external calls (assert_eq!).


##### `assert_v1_session_update`  (lines 2740–2755)

```
fn assert_v1_session_update(request: &Value) -> Result<()>
```

**Purpose**: Validates the shape of a v1 `session.update` request sent upstream.

**Data flow**: Checks `type = session.update`, `session.type = quicksilver`, verifies instructions contain `startup context`, asserts output voice `cove`, and asserts `session.tools` is `null`.

**Call relations**: V1 startup and handoff tests call this helper to distinguish v1 session semantics from v2.

*Call graph*: called by 3 (webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband); 2 external calls (assert!, assert_eq!).


##### `assert_v2_session_update`  (lines 2757–2779)

```
fn assert_v2_session_update(request: &Value) -> Result<()>
```

**Purpose**: Validates the shape of a v2 `session.update` request sent upstream.

**Data flow**: Checks `type = session.update`, `session.type = realtime`, verifies instructions contain `startup context`, asserts the first two tools are `background_agent` and `remain_silent`, and checks the audio transcription model is `gpt-4o-mini-transcribe`.

**Call relations**: V2 startup and append-only regression tests use this helper to confirm the initial upstream session configuration.

*Call graph*: called by 4 (webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_forwards_audio_and_text_between_client_and_sideband, webrtc_v2_text_input_is_append_only_when_response_is_cancelled, webrtc_v2_text_input_is_append_only_while_response_is_active); 2 external calls (assert!, assert_eq!).


##### `assert_call_create_multipart`  (lines 2781–2814)

```
fn assert_call_create_multipart(
    request: WiremockRequest,
    offer_sdp: &str,
    session: &str,
) -> Result<()>
```

**Purpose**: Asserts a captured WebRTC call-create HTTP request has the expected path, content type, SDP part, and normalized JSON session part.

**Data flow**: Checks the request path and absence of query string, verifies the multipart boundary content type, decodes the body as UTF-8, normalizes the expected session JSON with `normalized_json_string`, and compares the full multipart body string including boundaries and headers.

**Call relations**: Harness-backed WebRTC tests use this helper to validate the exact HTTP payload sent to `/v1/realtime/calls`.

*Call graph*: calls 1 internal fn (normalized_json_string); called by 2 (webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband); 2 external calls (from_utf8, assert_eq!).


##### `v1_session_create_json`  (lines 2816–2818)

```
fn v1_session_create_json() -> &'static str
```

**Purpose**: Returns the canonical compact JSON string expected in v1 WebRTC call-create requests.

**Data flow**: Returns a static string containing v1 audio input/output settings, `type = quicksilver`, model `gpt-realtime-1.5`, and instructions `backend prompt\n\nstartup context`.

**Call relations**: V1 WebRTC tests pass this string into `assert_call_create_multipart` when checking the captured call-create request.

*Call graph*: called by 2 (webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband).


##### `create_config_toml`  (lines 2820–2836)

```
fn create_config_toml(
    codex_home: &Path,
    responses_server_uri: &str,
    realtime_server_uri: &str,
    realtime_enabled: bool,
    startup_context: StartupContextConfig<'_>,
) -> std::io::Re
```

**Purpose**: Writes a realtime test config using default v2 version and read-only sandbox.

**Data flow**: Forwards the provided codex-home path, responses server URI, realtime server URI, feature-flag boolean, and startup-context mode to `create_config_toml_with_realtime_version` with `RealtimeTestVersion::V2` and `RealtimeTestSandbox::ReadOnly`.

**Call relations**: Direct realtime tests call this helper to generate the minimal config needed for startup without specifying version/sandbox explicitly.

*Call graph*: calls 1 internal fn (create_config_toml_with_realtime_version); called by 8 (realtime_conversation_requires_feature_flag, realtime_conversation_stop_emits_closed_notification, realtime_conversation_streams_v2_notifications, realtime_list_voices_returns_supported_names, realtime_start_can_skip_startup_context, realtime_text_output_modality_requests_text_output_and_final_transcript, realtime_webrtc_start_emits_sdp_notification, realtime_webrtc_start_surfaces_backend_error).


##### `create_config_toml_with_realtime_version`  (lines 2838–2889)

```
fn create_config_toml_with_realtime_version(
    codex_home: &Path,
    responses_server_uri: &str,
    realtime_server_uri: &str,
    realtime_enabled: bool,
    startup_context: StartupContextConfig
```

**Purpose**: Generates the full `config.toml` used by realtime tests, including feature flag, realtime version/type, startup context override, model provider, and sandbox mode.

**Data flow**: Looks up the feature key for `Feature::RealtimeConversation` from `FEATURES`, converts the version and sandbox enums to strings, optionally formats `experimental_realtime_ws_startup_context`, then writes a TOML file containing model/provider settings, realtime backend URLs and prompt, `[realtime]` section, `[features]` section, and mock provider configuration under `[model_providers.mock_provider]`.

**Call relations**: Both direct tests and harness setup funnel through this helper to ensure all realtime scenarios use consistent config structure.

*Call graph*: calls 2 internal fn (config_value, config_value); called by 2 (new_with_main_loop_responses_server_and_sandbox, create_config_toml); 4 external calls (join, new, format!, write).


##### `assert_invalid_request`  (lines 2891–2895)

```
fn assert_invalid_request(error: JSONRPCError, message: String)
```

**Purpose**: Asserts a `JSONRPCError` is an invalid-request error with the exact supplied message and no data payload.

**Data flow**: Checks `error.error.code == -32600`, `error.error.message == message`, and `error.error.data == None`.

**Call relations**: The feature-flag test uses this helper to keep the expected invalid-request assertion concise and explicit.

*Call graph*: called by 1 (realtime_conversation_requires_feature_flag); 1 external calls (assert_eq!).
