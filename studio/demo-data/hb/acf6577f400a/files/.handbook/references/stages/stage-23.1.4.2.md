# App-server integration suites — transport, protocol contracts, and client connection behavior  `stage-23.1.4.2`

This stage is a set of integration tests for the app server’s live client connections. It checks the “front door” behavior: how desktop clients connect, prove who they are, exchange messages, use realtime features, and disconnect. These tests sit around the main work loop, where the server is already running and must behave predictably while clients talk to it.

The WebSocket tests check the basic pipe between client and server. They make sure separate clients do not leak into each other, authentication is enforced, health checks work, and reconnecting clients can recover recent work. The Unix WebSocket shutdown tests add pressure: they send Ctrl-C-style signals while a request is active and confirm the server waits, exits fast on a second signal, and closes cleanly.

The attestation test follows a proof token from the desktop client into the outgoing ChatGPT connection handshake. The experimental API test makes sure new features stay locked unless the client opts in. The realtime conversation tests cover the full live experience: text, audio, WebRTC setup, feature flags, handoffs to background agents, and expected error behavior.

## Files in this stage

### Websocket connection lifecycle
These tests establish the core websocket transport behavior, then extend it with Unix-specific shutdown and restart scenarios.

### `app-server/tests/suite/v2/connection_handling_websocket.rs`

`test` · `integration test run`

This is an integration test file: it starts a real `codex-app-server` process, connects to it like an outside client would, sends JSON-RPC messages, and checks the replies. JSON-RPC is a simple request-and-response format where each request has a method name and an id so the response can be matched back to it. WebSocket is the long-lived network connection used to carry those messages.

The file exists to catch mistakes that only show up when the whole server is running. For example, two browser tabs might both use request id `77`; the server must reply to the right tab, not mix them up. A server bound to all network interfaces must not start without authentication, because that could expose a local control API to the network. Browser `Origin` headers and bearer tokens are also tested so unsafe connections are rejected.

The helper functions are like test tools on a workbench. Some create a temporary config file, start the server, and wait until it prints its bound address. Others open WebSockets, build authorized handshake requests, send JSON-RPC messages, read only the response with a chosen id, or confirm that no message arrived. Together, they let the tests describe real user-level behavior while hiding the repetitive plumbing.

#### Function details

##### `websocket_transport_routes_per_connection_handshake_and_responses`  (lines 63–105)

```
async fn websocket_transport_routes_per_connection_handshake_and_responses() -> Result<()>
```

**Purpose**: This test proves that each WebSocket connection has its own initialization state and its own request routing. It protects against a serious bug where one client could receive another client’s response or where request ids collide across connections.

**Data flow**: It creates a temporary server configuration, starts the app server, opens two WebSocket clients, and sends initialization and config-read requests on each one. It checks that connection one receives only its own initialize response, connection two gets a clear "Not initialized" error before it initializes, and both clients can safely use the same request id later. At the end it stops the spawned server process.

**Call relations**: This test is the top-level story. It relies on setup helpers such as `create_config_toml`, `spawn_websocket_server`, and `connect_websocket`, then uses message helpers like `send_initialize_request`, `send_config_read_request`, `read_response_for_id`, `read_error_for_id`, and `assert_no_message` to exercise the server.

*Call graph*: calls 8 internal fn (assert_no_message, connect_websocket, create_config_toml, read_error_for_id, read_response_for_id, send_config_read_request, send_initialize_request, spawn_websocket_server); 6 external calls (from_millis, new, new, create_mock_responses_server_sequence_unchecked, assert!, assert_eq!).


##### `websocket_transport_serves_health_endpoints_on_same_listener`  (lines 108–132)

```
async fn websocket_transport_serves_health_endpoints_on_same_listener() -> Result<()>
```

**Purpose**: This test checks that the WebSocket listener also serves simple HTTP health endpoints. That matters because monitoring systems often ask `/readyz` or `/healthz` to decide whether a service is alive.

**Data flow**: It starts the app server, makes normal HTTP GET requests to `/readyz` and `/healthz`, and expects successful HTTP status codes. Then it also opens a WebSocket on the same address and initializes it, proving the same listener can serve both health checks and WebSocket traffic. Finally it kills the server process.

**Call relations**: The test calls `http_get` for the health-check side and `connect_websocket`, `send_initialize_request`, and `read_response_for_id` for the WebSocket side. `spawn_websocket_server` and `create_config_toml` provide the real server and its temporary configuration.

*Call graph*: calls 7 internal fn (connect_websocket, create_config_toml, http_get, read_response_for_id, send_initialize_request, spawn_websocket_server, new); 4 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!).


##### `websocket_transport_rejects_browser_origin_without_auth`  (lines 135–161)

```
async fn websocket_transport_rejects_browser_origin_without_auth() -> Result<()>
```

**Purpose**: This test confirms that an unauthenticated browser-style connection from an untrusted website is blocked. It protects users from a web page trying to control a local app server through the browser.

**Data flow**: It first starts the server and proves that a normal loopback WebSocket client can initialize successfully. Then it tries a WebSocket handshake with an `Origin` header set to `https://evil.example` and no bearer token. The expected result is an HTTP forbidden rejection, after which the server is stopped.

**Call relations**: The happy-path connection uses `connect_websocket`, `send_initialize_request`, and `read_response_for_id`. The unsafe browser-style attempt is delegated to `assert_websocket_connect_rejected_with_headers`, which builds the request and checks the rejection status.

*Call graph*: calls 6 internal fn (assert_websocket_connect_rejected_with_headers, connect_websocket, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server); 4 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!).


##### `websocket_transport_rejects_missing_and_invalid_capability_tokens`  (lines 164–193)

```
async fn websocket_transport_rejects_missing_and_invalid_capability_tokens() -> Result<()>
```

**Purpose**: This test checks the fixed bearer-token authentication mode. It proves that the server rejects clients with no token or the wrong token, while accepting the exact token from its configured token file.

**Data flow**: It writes a token file into a temporary app home, starts the server bound to `0.0.0.0` with capability-token authentication, and tries three connections. Missing token and wrong token both must be rejected. The correct token opens a WebSocket, sends initialize, receives the matching response, and then the test stops the server.

**Call relations**: The test starts the server through `spawn_websocket_server_with_args` because it needs custom authentication flags. It uses `assert_websocket_connect_rejected` for failed handshakes and `connect_websocket_with_bearer`, `send_initialize_request`, and `read_response_for_id` for the accepted client.

*Call graph*: calls 6 internal fn (assert_websocket_connect_rejected, connect_websocket_with_bearer, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server_with_args); 6 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!, write, vec!).


##### `websocket_transport_verifies_signed_short_lived_bearer_tokens`  (lines 196–290)

```
async fn websocket_transport_verifies_signed_short_lived_bearer_tokens() -> Result<()>
```

**Purpose**: This test checks the signed bearer-token mode, where clients present short-lived tokens similar to JSON Web Tokens. It verifies that the server rejects expired, malformed, not-yet-valid, wrong-issuer, wrong-audience, and wrongly signed tokens, while accepting a valid one.

**Data flow**: It writes a shared signing secret, starts the server with signed-token settings, then creates several token strings with different claims and signatures. Each bad token is sent in a WebSocket handshake and must be rejected. A valid token is finally used to connect, send initialize, and read a successful response before the server is stopped.

**Call relations**: This test depends on `signed_bearer_token` to create test tokens. It uses `assert_websocket_connect_rejected` for the negative cases, then `connect_websocket_with_bearer`, `send_initialize_request`, and `read_response_for_id` to prove the valid token path works.

*Call graph*: calls 7 internal fn (assert_websocket_connect_rejected, connect_websocket_with_bearer, create_config_toml, read_response_for_id, send_initialize_request, signed_bearer_token, spawn_websocket_server_with_args); 8 external calls (new, new, create_mock_responses_server_sequence_unchecked, assert_eq!, format!, json!, write, vec!).


##### `websocket_transport_rejects_short_signed_bearer_secret_configuration`  (lines 293–322)

```
async fn websocket_transport_rejects_short_signed_bearer_secret_configuration() -> Result<()>
```

**Purpose**: This test confirms that the server refuses to start signed-token authentication with a signing secret that is too short. A weak secret would make tokens easier to forge, so startup must fail loudly.

**Data flow**: It writes a too-short secret file, creates the normal temporary config, and runs the app server with signed-bearer-token flags until it exits. It expects a failed exit status and checks standard error for a message saying the secret must be at least 32 bytes.

**Call relations**: Unlike tests that keep the server running, this one uses `run_websocket_server_to_completion_with_args` because failure during startup is the expected behavior. `create_config_toml` supplies the rest of the needed app configuration.

*Call graph*: calls 2 internal fn (create_config_toml, run_websocket_server_to_completion_with_args); 6 external calls (from_utf8, new, new, create_mock_responses_server_sequence_unchecked, assert!, write).


##### `websocket_transport_rejects_unauthenticated_non_loopback_startup`  (lines 325–344)

```
async fn websocket_transport_rejects_unauthenticated_non_loopback_startup() -> Result<()>
```

**Purpose**: This test checks a safety rule: the server must not listen on all network interfaces without WebSocket authentication. Without this guard, a machine could accidentally expose the app server to other devices.

**Data flow**: It creates a temporary config and tries to run the server at `ws://0.0.0.0:0` without auth flags. The server is expected to exit unsuccessfully, and the test checks that standard error explains it refused to start a non-loopback unauthenticated listener.

**Call relations**: The test uses `run_websocket_server_to_completion_with_args` because the intended outcome is an immediate startup failure. It uses `create_config_toml` only to make the app otherwise startable, so the failure is clearly about listener safety.

*Call graph*: calls 2 internal fn (create_config_toml, run_websocket_server_to_completion_with_args); 5 external calls (from_utf8, new, new, create_mock_responses_server_sequence_unchecked, assert!).


##### `websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout`  (lines 347–376)

```
async fn websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout() -> Result<()>
```

**Purpose**: This test checks reconnect behavior for loaded threads. It proves that when a client disconnects, the thread it had loaded does not disappear immediately, giving a reconnecting client time to find it again.

**Data flow**: It starts the server, connects client one, initializes it, starts a thread, and checks that the thread is listed as loaded. It then closes client one, opens client two, initializes it, and repeatedly asks for the loaded thread list until the same thread appears. The server process is killed at the end.

**Call relations**: The test combines connection helpers with thread helpers: `start_thread` creates the thread, `assert_loaded_threads` checks the first client’s view, and `wait_for_loaded_threads` polls from the reconnecting client until the expected state appears.

*Call graph*: calls 8 internal fn (assert_loaded_threads, connect_websocket, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server, start_thread, wait_for_loaded_threads); 3 external calls (new, new, create_mock_responses_server_sequence_unchecked).


##### `spawn_websocket_server`  (lines 378–380)

```
async fn spawn_websocket_server(codex_home: &Path) -> Result<(Child, SocketAddr)>
```

**Purpose**: This helper starts the app server with the normal test WebSocket address, limited to local connections. Tests use it when they do not need special command-line authentication options.

**Data flow**: It receives the temporary `CODEX_HOME` path and passes it to the more flexible server-spawning helper with `ws://127.0.0.1:0`, meaning "bind to localhost on any free port." It returns the child process handle and the actual socket address printed by the server.

**Call relations**: Many tests call this as the simple startup path. It immediately hands off to `spawn_websocket_server_with_args`, which performs the real process launch and address detection.

*Call graph*: calls 1 internal fn (spawn_websocket_server_with_args); called by 8 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, start_ctrl_c_restart_fixture, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads).


##### `spawn_websocket_server_with_args`  (lines 382–455)

```
async fn spawn_websocket_server_with_args(
    codex_home: &Path,
    listen_url: &str,
    extra_args: &[String],
) -> Result<(Child, SocketAddr)>
```

**Purpose**: This helper launches a real `codex-app-server` process and waits until it reports the WebSocket address it bound to. It is the main bridge between the test code and the real server binary.

**Data flow**: It takes a config directory, listen URL, and extra command-line arguments. It builds a command with the right environment, starts the process, reads its standard error line by line, strips terminal color codes, and searches for a `ws://host:port` token. Once found, it keeps printing later stderr lines in the background and returns the process plus bind address.

**Call relations**: Simple startup goes through `spawn_websocket_server`, while authentication tests call this directly to add flags. The returned address is then used by connection helpers such as `connect_websocket_with_bearer` and `http_get`.

*Call graph*: called by 3 (spawn_websocket_server, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_verifies_signed_short_lived_bearer_tokens); 11 external calls (new, now, null, piped, with_capacity, new, cargo_bin, eprintln!, matches!, spawn (+1 more)).


##### `connect_websocket`  (lines 457–459)

```
async fn connect_websocket(bind_addr: SocketAddr) -> Result<WsClient>
```

**Purpose**: This helper opens a WebSocket connection without an authorization token. It is used for tests where local unauthenticated access is expected to be allowed.

**Data flow**: It receives the server bind address and passes it to `connect_websocket_with_bearer` with no token. The output is an open WebSocket stream ready to send and receive JSON-RPC messages.

**Call relations**: Most happy-path tests use this small wrapper. It delegates all connection retry and request-building work to `connect_websocket_with_bearer`.

*Call graph*: calls 1 internal fn (connect_websocket_with_bearer); called by 8 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, start_ctrl_c_restart_fixture, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads).


##### `connect_websocket_with_bearer`  (lines 461–479)

```
async fn connect_websocket_with_bearer(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
) -> Result<WsClient>
```

**Purpose**: This helper opens a WebSocket connection, optionally adding a bearer token in the authorization header. It retries briefly because the server process may need a moment before it accepts connections.

**Data flow**: It turns the bind address into a usable local address, builds a WebSocket handshake request with `websocket_request`, and repeatedly tries to connect until success or the default timeout. On success it returns the open WebSocket stream; on timeout it reports a clear failure.

**Call relations**: Authentication tests call this directly with valid tokens. `connect_websocket` calls it with no token for normal local tests, and it relies on `websocket_request` to add headers correctly.

*Call graph*: calls 1 internal fn (websocket_request); called by 3 (connect_websocket, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_verifies_signed_short_lived_bearer_tokens); 6 external calls (from_millis, now, bail!, format!, sleep, connect_async).


##### `assert_websocket_connect_rejected`  (lines 481–492)

```
async fn assert_websocket_connect_rejected(
    bind_addr: SocketAddr,
    bearer_token: Option<&str>,
) -> Result<()>
```

**Purpose**: This helper checks that a WebSocket handshake is rejected with the normal unauthorized status. It keeps negative authentication tests short and clear.

**Data flow**: It receives a bind address and optional bearer token, then calls the more general rejection helper with no `Origin` header and an expected `401 Unauthorized` status. It returns success only if the rejection matches.

**Call relations**: Token-authentication tests call this for missing, invalid, expired, malformed, or otherwise unacceptable credentials. It delegates the actual handshake attempt to `assert_websocket_connect_rejected_with_headers`.

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

**Purpose**: This helper attempts a WebSocket connection and expects the server to refuse it with a particular HTTP status. It is useful for checking security rules during the WebSocket handshake.

**Data flow**: It builds a WebSocket request with optional bearer-token and origin headers, tries to connect, and then interprets the outcome. A successful connection is treated as a test failure. An HTTP rejection succeeds only if its status matches the expected status.

**Call relations**: `assert_websocket_connect_rejected` uses this for standard unauthorized failures. The browser-origin test calls it directly because it needs to set an `Origin` header and expects `403 Forbidden`.

*Call graph*: calls 1 internal fn (websocket_request); called by 2 (assert_websocket_connect_rejected, websocket_transport_rejects_browser_origin_without_auth); 4 external calls (assert_eq!, bail!, format!, connect_async).


##### `run_websocket_server_to_completion_with_args`  (lines 518–539)

```
async fn run_websocket_server_to_completion_with_args(
    codex_home: &Path,
    listen_url: &str,
    extra_args: &[String],
) -> Result<std::process::Output>
```

**Purpose**: This helper runs the app server and waits for it to exit, instead of keeping it alive. It is used when a test expects startup to fail because of unsafe or invalid configuration.

**Data flow**: It builds the same kind of command as the long-running server helper, with the supplied listen URL and extra flags. It captures standard error, waits up to the default timeout for the process to finish, and returns the completed process output.

**Call relations**: Startup-failure tests call this to inspect the exit status and error text. It is separate from `spawn_websocket_server_with_args`, which waits for a successful bind address and returns a running process.

*Call graph*: called by 2 (websocket_transport_rejects_short_signed_bearer_secret_configuration, websocket_transport_rejects_unauthenticated_non_loopback_startup); 5 external calls (null, piped, new, cargo_bin, timeout).


##### `http_get`  (lines 541–564)

```
async fn http_get(
    client: &reqwest::Client,
    bind_addr: SocketAddr,
    path: &str,
) -> Result<reqwest::Response>
```

**Purpose**: This helper performs an HTTP GET request against the server, retrying until the listener is ready. It is used to test health endpoints that share the same address as the WebSocket server.

**Data flow**: It receives an HTTP client, bind address, and path. It converts wildcard bind addresses into connectable loopback addresses, repeatedly sends `GET http://address/path`, and returns the first successful HTTP response object. If no request succeeds before the timeout, it fails the test.

**Call relations**: The health-endpoint test calls this for `/readyz` and `/healthz`. It uses `connectable_bind_addr` so tests can connect even when the server reports a wildcard address like `0.0.0.0`.

*Call graph*: calls 1 internal fn (connectable_bind_addr); called by 1 (websocket_transport_serves_health_endpoints_on_same_listener); 6 external calls (from_millis, now, get, bail!, format!, sleep).


##### `websocket_request`  (lines 566–588)

```
fn websocket_request(
    url: &str,
    bearer_token: Option<&str>,
    origin: Option<&str>,
) -> Result<tokio_tungstenite::tungstenite::http::Request<()>>
```

**Purpose**: This helper builds the HTTP request used to start a WebSocket handshake. It can add authorization and origin headers so tests can simulate different kinds of clients.

**Data flow**: It starts from a WebSocket URL, converts it into a client request, optionally inserts an `Authorization: Bearer ...` header, and optionally inserts an `Origin` header. It returns the finished request or an error if a header value is invalid.

**Call relations**: Connection helpers use this before calling the WebSocket library. `connect_websocket_with_bearer` uses it for accepted connections, while `assert_websocket_connect_rejected_with_headers` uses it for rejected handshakes.

*Call graph*: called by 2 (assert_websocket_connect_rejected_with_headers, connect_websocket_with_bearer); 2 external calls (from_str, format!).


##### `send_initialize_request`  (lines 590–610)

```
async fn send_initialize_request(
    stream: &mut WsClient,
    id: i64,
    client_name: &str,
) -> Result<()>
```

**Purpose**: This helper sends the JSON-RPC `initialize` request that a client must send before using most server features. It identifies the test client by name and basic version information.

**Data flow**: It takes an open WebSocket stream, request id, and client name. It builds initialization parameters containing client metadata, converts them to JSON, and sends them as an `initialize` request. Nothing is read here; callers read the response separately.

**Call relations**: Nearly every WebSocket test calls this after connecting. It delegates the actual JSON-RPC request construction and sending to `send_request`.

*Call graph*: calls 1 internal fn (send_request); called by 9 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, websocket_transport_verifies_signed_short_lived_bearer_tokens, start_ctrl_c_restart_fixture, initialize_both_clients); 1 external calls (to_value).


##### `start_thread`  (lines 612–626)

```
async fn start_thread(stream: &mut WsClient, id: i64) -> Result<String>
```

**Purpose**: This helper asks the server to start a new thread and returns the thread id. A thread here is a server-side conversation or work context that later tests can check as loaded.

**Data flow**: It sends a `thread/start` request with a mock model, waits for the response with the same id, converts the generic JSON-RPC response into a typed thread-start response, and extracts the new thread’s id string.

**Call relations**: The reconnect test uses this after initialization. It builds on `send_request` to send the command and `read_response_for_id` to wait for the matching answer.

*Call graph*: calls 2 internal fn (read_response_for_id, send_request); called by 1 (websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout); 2 external calls (default, to_value).


##### `assert_loaded_threads`  (lines 628–640)

```
async fn assert_loaded_threads(stream: &mut WsClient, id: i64, expected: &[&str]) -> Result<()>
```

**Purpose**: This helper checks that the server’s loaded-thread list exactly matches an expected set. It makes ordering irrelevant by sorting both lists before comparing them.

**Data flow**: It sends a loaded-thread-list request through `request_loaded_threads`, receives the returned ids, sorts them, sorts the expected ids, and asserts that they are equal. It also checks there is no pagination cursor, meaning the full list fit in one response.

**Call relations**: The reconnect test uses this immediately after starting a thread to prove the first client sees it as loaded. The actual request and response decoding are delegated to `request_loaded_threads`.

*Call graph*: calls 1 internal fn (request_loaded_threads); called by 1 (websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout); 1 external calls (assert_eq!).


##### `wait_for_loaded_threads`  (lines 642–667)

```
async fn wait_for_loaded_threads(
    stream: &mut WsClient,
    first_id: i64,
    expected: &[&str],
) -> Result<()>
```

**Purpose**: This helper repeatedly asks for the loaded-thread list until it matches the expected ids or a timeout expires. It accounts for small delays in the server updating shared state.

**Data flow**: It starts with a request id, then loops: send a loaded-thread-list request, increment the id, sort the returned ids, compare to the expected list, and sleep briefly if they do not match yet. It returns success when the list matches, or a timeout error if it never does.

**Call relations**: The reconnect test uses this after opening the second client. It relies on `request_loaded_threads` for each poll and the default read timeout to avoid waiting forever.

*Call graph*: calls 1 internal fn (request_loaded_threads); called by 1 (websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout); 3 external calls (from_millis, sleep, timeout).


##### `request_loaded_threads`  (lines 669–682)

```
async fn request_loaded_threads(
    stream: &mut WsClient,
    id: i64,
) -> Result<ThreadLoadedListResponse>
```

**Purpose**: This helper sends the JSON-RPC request that asks the server which threads are currently loaded. It returns the typed response instead of leaving callers to parse JSON themselves.

**Data flow**: It sends `thread/loaded/list` with default parameters, waits for the response matching the request id, and converts that response into `ThreadLoadedListResponse`. The result contains the thread ids and any pagination cursor.

**Call relations**: `assert_loaded_threads` uses this for a one-time exact check, and `wait_for_loaded_threads` uses it repeatedly while polling. It combines `send_request`, `read_response_for_id`, and typed response conversion.

*Call graph*: calls 2 internal fn (read_response_for_id, send_request); called by 2 (assert_loaded_threads, wait_for_loaded_threads); 2 external calls (default, to_value).


##### `send_config_read_request`  (lines 684–692)

```
async fn send_config_read_request(stream: &mut WsClient, id: i64) -> Result<()>
```

**Purpose**: This helper sends a request to read the server configuration. It is used to test whether a connection is initialized and whether responses route back to the correct client.

**Data flow**: It takes a WebSocket stream and request id, builds a `config/read` request with `includeLayers` set to false, and sends it. The caller later reads either a normal response or an error for that id.

**Call relations**: The per-connection routing test uses this before and after initialization. It delegates the common JSON-RPC sending work to `send_request`.

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

**Purpose**: This helper builds a JSON-RPC request message from a method name, id, and optional parameters. It gives tests one consistent way to send server commands.

**Data flow**: It receives the stream, method, numeric id, and optional JSON parameters. It wraps them in a JSON-RPC request object with an integer request id and no trace data, then passes the message to `send_jsonrpc`. It changes the WebSocket by writing one text frame to it.

**Call relations**: Higher-level helpers such as `send_initialize_request`, `send_config_read_request`, `start_thread`, and `request_loaded_threads` all use this. It hands off serialization and frame sending to `send_jsonrpc`.

*Call graph*: calls 1 internal fn (send_jsonrpc); called by 9 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, request_loaded_threads, send_config_read_request, send_initialize_request, start_thread, send_thread_start_request, send_turn_start_request, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (Request, Integer).


##### `send_jsonrpc`  (lines 709–715)

```
async fn send_jsonrpc(stream: &mut WsClient, message: JSONRPCMessage) -> Result<()>
```

**Purpose**: This helper serializes a JSON-RPC message and sends it as a WebSocket text frame. It is the lowest-level sending tool in this file.

**Data flow**: It takes an already-built JSON-RPC message, turns it into a JSON string, wraps that string as a WebSocket text message, and writes it to the stream. On failure it returns an error that explains the frame could not be sent.

**Call relations**: `send_request` calls this after constructing request messages. Other helpers stay one level higher and do not need to know about WebSocket frame details.

*Call graph*: called by 1 (send_request); 3 external calls (Text, send, to_string).


##### `read_response_for_id`  (lines 717–730)

```
async fn read_response_for_id(
    stream: &mut WsClient,
    id: i64,
) -> Result<JSONRPCResponse>
```

**Purpose**: This helper reads incoming WebSocket messages until it finds the response for a specific request id. It lets tests ignore unrelated messages that may arrive on the same connection.

**Data flow**: It turns the numeric id into a JSON-RPC request id, then repeatedly calls `read_jsonrpc_message`. If a message is a response with the target id, it returns that response; otherwise it keeps reading.

**Call relations**: Most tests and helper functions use this after sending a request. It depends on `read_jsonrpc_message` to do the raw WebSocket reading, ping handling, and JSON parsing.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 11 (request_loaded_threads, start_thread, websocket_disconnect_keeps_last_subscribed_thread_loaded_until_idle_timeout, websocket_transport_rejects_browser_origin_without_auth, websocket_transport_rejects_missing_and_invalid_capability_tokens, websocket_transport_routes_per_connection_handshake_and_responses, websocket_transport_serves_health_endpoints_on_same_listener, websocket_transport_verifies_signed_short_lived_bearer_tokens, start_ctrl_c_restart_fixture, initialize_both_clients (+1 more)); 1 external calls (Integer).


##### `read_notification_for_method`  (lines 732–744)

```
async fn read_notification_for_method(
    stream: &mut WsClient,
    method: &str,
) -> Result<JSONRPCNotification>
```

**Purpose**: This helper waits for a JSON-RPC notification with a particular method name. A notification is a one-way message from the server that is not a direct response to a request.

**Data flow**: It repeatedly reads JSON-RPC messages from the stream. When it sees a notification whose method matches the requested method, it returns that notification. Other messages are ignored.

**Call relations**: Other WebSocket tests in the same suite use this when they expect server broadcasts, such as thread-name update notifications. It uses `read_jsonrpc_message` for the actual frame reading and parsing.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads).


##### `read_response_and_notification_for_method`  (lines 746–783)

```
async fn read_response_and_notification_for_method(
    stream: &mut WsClient,
    id: i64,
    method: &str,
) -> Result<(JSONRPCResponse, JSONRPCNotification)>
```

**Purpose**: This helper waits until both a specific response and a specific notification have arrived, in either order. It is useful when one action causes both an immediate reply and a broadcast.

**Data flow**: It tracks two empty slots: one for the response with the target request id and one for the notification with the target method. It reads messages until both slots are filled. If the same notification arrives twice before completion, it fails the test to flag an unexpected duplicate.

**Call relations**: Thread-name broadcast tests use this to avoid depending on message order. Like the other readers, it relies on `read_jsonrpc_message` for WebSocket and JSON details.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 2 (thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 2 external calls (Integer, bail!).


##### `read_error_for_id`  (lines 785–795)

```
async fn read_error_for_id(stream: &mut WsClient, id: i64) -> Result<JSONRPCError>
```

**Purpose**: This helper waits for a JSON-RPC error response for a specific request id. It is used when the correct server behavior is to reject a request but keep the connection alive.

**Data flow**: It repeatedly reads JSON-RPC messages and checks whether each one is an error with the target id. When it finds the matching error, it returns it; unrelated messages are skipped.

**Call relations**: The per-connection initialization test uses this when an uninitialized client tries to read config. It shares the low-level reading path through `read_jsonrpc_message`.

*Call graph*: calls 1 internal fn (read_jsonrpc_message); called by 1 (websocket_transport_routes_per_connection_handshake_and_responses); 1 external calls (Integer).


##### `read_jsonrpc_message`  (lines 797–818)

```
async fn read_jsonrpc_message(stream: &mut WsClient) -> Result<JSONRPCMessage>
```

**Purpose**: This helper reads one meaningful JSON-RPC message from a WebSocket stream. It also deals with WebSocket housekeeping, such as replying to ping frames with pong frames.

**Data flow**: It waits for the next WebSocket frame with a timeout. Text frames are parsed as JSON-RPC messages and returned. Ping frames are answered with pong and then the loop continues. Pong frames and raw protocol frames are ignored; close, binary, read errors, and timeouts become test failures.

**Call relations**: All higher-level message readers depend on this function. It is the shared doorway from raw WebSocket frames into structured JSON-RPC messages.

*Call graph*: called by 7 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, read_command_exec_delta_ws, read_initialize_response, read_error_for_id, read_notification_for_method, read_response_and_notification_for_method, read_response_for_id); 6 external calls (Pong, next, send, bail!, from_str, timeout).


##### `assert_no_message`  (lines 820–827)

```
async fn assert_no_message(stream: &mut WsClient, wait_for: Duration) -> Result<()>
```

**Purpose**: This helper confirms that a WebSocket stays silent for a short period. It is used to prove that messages did not leak to the wrong connection.

**Data flow**: It waits for one frame for the requested duration. If any frame, read error, or connection close appears, it fails. If the wait times out with no frame, that silence is considered success.

**Call relations**: Connection-isolation and broadcast tests call this after actions that should not produce messages on a given client. It uses the raw stream directly because it is checking for any frame at all, not just JSON-RPC text.

*Call graph*: called by 4 (command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, websocket_transport_routes_per_connection_handshake_and_responses, thread_name_updated_broadcasts_for_loaded_threads, thread_name_updated_broadcasts_for_not_loaded_threads); 3 external calls (next, bail!, timeout).


##### `create_config_toml`  (lines 829–854)

```
fn create_config_toml(
    codex_home: &Path,
    server_uri: &str,
    approval_policy: &str,
) -> std::io::Result<()>
```

**Purpose**: This helper writes a minimal `config.toml` for tests. It points the app server at a mock model provider so tests do not call a real external service.

**Data flow**: It receives the temporary app home path, mock server URI, and approval policy string. It writes a TOML configuration file containing the mock model, read-only sandbox mode, provider base URL, and retry settings. The output is a file on disk or an I/O error.

**Call relations**: Almost every integration test in this area uses this before starting the server. The spawned app server reads the file through `CODEX_HOME`, so the test controls the server’s environment.

*Call graph*: called by 32 (command_exec_accepts_permission_profile, command_exec_env_overrides_merge_with_server_environment_and_support_unset, command_exec_non_streaming_respects_output_cap, command_exec_permission_profile_does_not_reuse_default_network_proxy, command_exec_permission_profile_project_roots_use_command_cwd, command_exec_permission_profile_starts_selected_network_proxy, command_exec_pipe_streams_output_and_accepts_write, command_exec_process_ids_are_connection_scoped_and_disconnect_terminates_process, command_exec_rejects_disable_output_cap_with_output_bytes_cap, command_exec_rejects_disable_timeout_with_timeout_ms (+15 more)); 3 external calls (join, format!, write).


##### `connectable_bind_addr`  (lines 856–866)

```
fn connectable_bind_addr(bind_addr: SocketAddr) -> SocketAddr
```

**Purpose**: This helper turns wildcard bind addresses into addresses a client can actually connect to. A server may listen on `0.0.0.0`, but clients should connect to `127.0.0.1` in tests.

**Data flow**: It receives a socket address. If the address is an unspecified IPv4 address, it returns the same port on `127.0.0.1`; if it is unspecified IPv6, it returns the same port on `::1`. Otherwise it returns the original address unchanged.

**Call relations**: `http_get` uses this before building an HTTP URL. WebSocket connection helpers use the same idea when building their connection URL.

*Call graph*: called by 1 (http_get); 1 external calls (from).


##### `signed_bearer_token`  (lines 868–876)

```
fn signed_bearer_token(shared_secret: &[u8], claims: serde_json::Value) -> Result<String>
```

**Purpose**: This helper creates a signed test bearer token using HMAC-SHA256. HMAC is a shared-secret signature method that lets the server check the token was made by someone who knows the same secret.

**Data flow**: It takes secret bytes and a JSON object of claims, builds a token header, base64-url encodes the header and claims, signs the two-part payload with the shared secret, encodes the signature, and returns the final three-part token string. If JSON conversion or signing setup fails, it returns an error.

**Call relations**: The signed-token authentication test uses this to manufacture valid and invalid tokens by changing claims or the signing secret. The produced strings are passed to `connect_websocket_with_bearer` or rejection helpers as bearer credentials.

*Call graph*: called by 1 (websocket_transport_verifies_signed_short_lived_bearer_tokens); 3 external calls (new_from_slice, format!, to_vec).


### `app-server/tests/suite/v2/connection_handling_websocket_unix.rs`

`test` · `test execution`

This is a Unix-only behavior test for graceful shutdown. In everyday terms, it checks that the app server does not slam the door while it is still helping a user. The tests start a real app-server process, connect to it over WebSocket, begin a conversation turn, and arrange for the mocked model response to be delayed. That delay creates a known moment where work is still in progress.

Once the server is busy, each test sends an operating-system signal. A signal is a simple message from the operating system to a process, such as “please stop” or “reload.” The file checks several cases: one Ctrl-C waits for the running turn to finish, a second Ctrl-C forces shutdown sooner, SIGTERM behaves similarly, and repeated SIGHUP keeps waiting rather than forcing an exit.

The helper functions act like a test harness. They create temporary configuration, start a mock HTTP server, launch the WebSocket server, send protocol requests, wait until the server has made its outbound `/responses` call, then send Unix signals with the `kill` command. Finally, they verify two important outcomes: the process exits within the expected time, and the WebSocket client sees the connection close. Without these tests, shutdown bugs could leave users with interrupted work, hanging clients, or processes that never exit.

#### Function details

##### `websocket_transport_ctrl_c_waits_for_running_turn_before_exit`  (lines 35–57)

```
async fn websocket_transport_ctrl_c_waits_for_running_turn_before_exit() -> Result<()>
```

**Purpose**: This test checks the normal Ctrl-C path. It proves that one interrupt signal does not immediately kill the WebSocket server while a turn is still running; instead, the server waits for the work to finish and then exits cleanly.

**Data flow**: It starts a prepared server fixture with a delayed turn response, sends one Ctrl-C signal to the child process, and watches the process for a short window to make sure it stays alive. Then it waits longer for the delayed work to finish, checks that the process exits successfully, and confirms that the WebSocket connection closes.

**Call relations**: This is one of the top-level test cases. It relies on start_ctrl_c_restart_fixture to create a busy server, uses send_sigint to deliver the interrupt, uses assert_process_does_not_exit_within and wait_for_process_exit_within to check timing, and finishes with expect_websocket_disconnect to verify the client side saw shutdown.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigint, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_second_ctrl_c_forces_exit_while_turn_running`  (lines 60–83)

```
async fn websocket_transport_second_ctrl_c_forces_exit_while_turn_running() -> Result<()>
```

**Purpose**: This test checks the emergency Ctrl-C path. It proves that if the user presses Ctrl-C a second time while the server is still draining work, the server exits promptly instead of waiting for the full running turn.

**Data flow**: It starts the same delayed-turn fixture, sends one Ctrl-C, and confirms the server does not exit immediately. It then sends a second Ctrl-C, waits only a short time for the process to exit, checks that the exit was successful, and verifies the WebSocket is disconnected.

**Call relations**: This top-level test shares the same setup and checking helpers as the single-Ctrl-C test. The difference is that it calls send_sigint twice, using the second call to exercise the forced-exit behavior.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigint, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_sigterm_waits_for_running_turn_before_exit`  (lines 86–108)

```
async fn websocket_transport_sigterm_waits_for_running_turn_before_exit() -> Result<()>
```

**Purpose**: This test checks graceful shutdown for SIGTERM, a common Unix signal meaning “please terminate.” It makes sure SIGTERM behaves like a polite stop request while a turn is running.

**Data flow**: It creates a server that is busy with a delayed response, sends SIGTERM to the server process, and confirms the process does not exit during a short early window. After the delayed turn has time to finish, it waits for a successful process exit and then checks that the WebSocket connection closes.

**Call relations**: This top-level test uses start_ctrl_c_restart_fixture for setup, send_sigterm for the Unix signal, the process-wait helpers for timing expectations, and expect_websocket_disconnect for the final client-side shutdown check.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigterm, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_second_sigterm_forces_exit_while_turn_running`  (lines 111–134)

```
async fn websocket_transport_second_sigterm_forces_exit_while_turn_running() -> Result<()>
```

**Purpose**: This test checks that a second SIGTERM forces the server to stop sooner. It protects against a server that keeps waiting forever even after being asked to terminate repeatedly.

**Data flow**: It starts a busy WebSocket server, sends SIGTERM once, and verifies the process is still alive briefly. It then sends SIGTERM again, waits for the process to exit within a shorter timeout, checks that the exit succeeded, and confirms the WebSocket connection is gone.

**Call relations**: This top-level test follows the same pattern as the second-Ctrl-C test, but uses send_sigterm instead of send_sigint. It depends on the shared setup, process timing, and WebSocket disconnect helpers.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sigterm, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `websocket_transport_repeated_sighup_keeps_waiting_for_running_turn`  (lines 137–162)

```
async fn websocket_transport_repeated_sighup_keeps_waiting_for_running_turn() -> Result<()>
```

**Purpose**: This test checks that repeated SIGHUP signals do not force the server to quit while work is running. SIGHUP often means “reload” or “restart,” and here the expected behavior is still graceful waiting.

**Data flow**: It starts a server with an in-progress delayed turn, sends SIGHUP, and confirms the process does not exit right away. It sends SIGHUP again, confirms the process still does not exit right away, then waits for the turn to finish and verifies successful process exit and WebSocket disconnection.

**Call relations**: This top-level test uses start_ctrl_c_restart_fixture to get the server into a busy state, calls send_sighup twice, and uses the same process and WebSocket assertions used by the Ctrl-C and SIGTERM tests.

*Call graph*: calls 5 internal fn (assert_process_does_not_exit_within, expect_websocket_disconnect, send_sighup, start_ctrl_c_restart_fixture, wait_for_process_exit_within); 3 external calls (from_millis, from_secs, assert!).


##### `start_ctrl_c_restart_fixture`  (lines 171–207)

```
async fn start_ctrl_c_restart_fixture(turn_delay: Duration) -> Result<GracefulCtrlCFixture>
```

**Purpose**: This helper builds the full test scene: a mock model server, temporary configuration, a real WebSocket app-server process, and an active running turn that is intentionally delayed. Tests use it so they all begin from the same reliable “server is busy” state.

**Data flow**: It receives a delay duration for the mocked turn response. It starts a mock HTTP server, configures that mock to delay the `/responses` reply, writes temporary app configuration, launches the WebSocket server, connects a WebSocket client, initializes the protocol, starts a thread, starts a turn, and waits until the app server has actually called `/responses`. It returns a fixture containing the temporary home directory, mock server, child process, and WebSocket client.

**Call relations**: All five top-level signal tests call this first. Inside, it hands protocol details to helpers from the shared WebSocket test module and to this file’s send_thread_start_request, send_turn_start_request, and wait_for_responses_post helpers.

*Call graph*: calls 10 internal fn (connect_websocket, create_config_toml, read_response_for_id, send_initialize_request, spawn_websocket_server, send_thread_start_request, send_turn_start_request, wait_for_responses_post, sse_response, start_mock_server); called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 8 external calls (from_secs, given, new, create_final_assistant_message_sse_response, to_response, assert_eq!, method, path_regex).


##### `send_thread_start_request`  (lines 209–220)

```
async fn send_thread_start_request(stream: &mut WsClient, id: i64) -> Result<()>
```

**Purpose**: This helper asks the WebSocket server to create a new conversation thread. A thread is the container that later turns belong to.

**Data flow**: It takes a mutable WebSocket client and a request id. It builds a `thread/start` request with a mock model name, converts the request body into JSON, sends it through the WebSocket, and returns success or an error from sending.

**Call relations**: start_ctrl_c_restart_fixture calls this after initialization. The response gives the fixture a thread id, which is then passed into send_turn_start_request so the test can begin real work.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_ctrl_c_restart_fixture); 2 external calls (default, to_value).


##### `send_turn_start_request`  (lines 222–238)

```
async fn send_turn_start_request(stream: &mut WsClient, id: i64, thread_id: &str) -> Result<()>
```

**Purpose**: This helper asks the server to start a user turn in an existing thread. A turn is one round of user input and assistant response.

**Data flow**: It takes a WebSocket client, request id, and thread id. It builds a `turn/start` request containing a simple text input, converts that request to JSON, sends it over the WebSocket, and returns whether sending succeeded.

**Call relations**: start_ctrl_c_restart_fixture calls this after it has created a thread. Starting the turn is what causes the app server to call the mocked `/responses` endpoint, creating the in-progress work that the signal tests need.

*Call graph*: calls 1 internal fn (send_request); called by 1 (start_ctrl_c_restart_fixture); 3 external calls (default, to_value, vec!).


##### `wait_for_responses_post`  (lines 240–258)

```
async fn wait_for_responses_post(server: &wiremock::MockServer, wait_for: Duration) -> Result<()>
```

**Purpose**: This helper waits until the app server has actually begun its outbound model request. That matters because the shutdown signal should be sent while a turn is truly running, not before the work starts.

**Data flow**: It takes the mock server and a maximum wait time. It repeatedly reads the mock server’s received requests, looking for a POST request whose path ends in `/responses`. If it sees one, it returns success; if the deadline passes, it returns an error.

**Call relations**: start_ctrl_c_restart_fixture calls this after sending the turn-start request. It acts as the gate between setup and the signal tests, ensuring the process is in the right busy state before any test sends Ctrl-C, SIGTERM, or SIGHUP.

*Call graph*: called by 1 (start_ctrl_c_restart_fixture); 5 external calls (from_millis, now, received_requests, bail!, sleep).


##### `send_sigint`  (lines 260–262)

```
fn send_sigint(process: &Child) -> Result<()>
```

**Purpose**: This small helper sends SIGINT to the server process. SIGINT is the signal normally produced by pressing Ctrl-C in a terminal.

**Data flow**: It receives the child process, chooses the `-INT` signal name, and passes both to send_signal. It returns success if the signal command succeeds, or an error if it fails.

**Call relations**: The Ctrl-C tests call this instead of calling send_signal directly. It keeps those tests readable by naming the signal in human terms.

*Call graph*: calls 1 internal fn (send_signal); called by 2 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_second_ctrl_c_forces_exit_while_turn_running).


##### `send_sigterm`  (lines 264–266)

```
fn send_sigterm(process: &Child) -> Result<()>
```

**Purpose**: This small helper sends SIGTERM to the server process. SIGTERM is a standard Unix request asking a process to terminate.

**Data flow**: It receives the child process, chooses the `-TERM` signal name, and delegates the actual operating-system command to send_signal. It returns the result of that lower-level helper.

**Call relations**: The SIGTERM tests call this to express their intent clearly. send_signal does the shared work of finding the process id and invoking `kill`.

*Call graph*: calls 1 internal fn (send_signal); called by 2 (websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit).


##### `send_sighup`  (lines 268–270)

```
fn send_sighup(process: &Child) -> Result<()>
```

**Purpose**: This small helper sends SIGHUP to the server process. In this test suite, SIGHUP represents a restart-style signal that should still wait for running work.

**Data flow**: It receives the child process, selects the `-HUP` signal name, and passes it to send_signal. The output is success if the signal was delivered, otherwise an error.

**Call relations**: The repeated-SIGHUP test calls this twice. It uses the same shared signal-sending path as Ctrl-C and SIGTERM, but labels the signal behavior being tested.

*Call graph*: calls 1 internal fn (send_signal); called by 1 (websocket_transport_repeated_sighup_keeps_waiting_for_running_turn).


##### `send_signal`  (lines 272–285)

```
fn send_signal(process: &Child, signal: &str) -> Result<()>
```

**Purpose**: This helper does the actual Unix signal delivery. It uses the system `kill` command to send a named signal to the app-server child process.

**Data flow**: It receives a child process and a signal string such as `-INT`. It reads the process id, runs `kill <signal> <pid>`, checks the command’s exit status, and returns success only if the command reports success.

**Call relations**: send_sigint, send_sigterm, and send_sighup all call this. It centralizes the low-level operating-system interaction so the tests can talk in terms of the signal they care about.

*Call graph*: called by 3 (send_sighup, send_sigint, send_sigterm); 3 external calls (id, new, bail!).


##### `assert_process_does_not_exit_within`  (lines 287–293)

```
async fn assert_process_does_not_exit_within(process: &mut Child, window: Duration) -> Result<()>
```

**Purpose**: This helper confirms that the server stays alive for a short period. It is used to prove the server is waiting for running work instead of stopping immediately.

**Data flow**: It receives the child process and a time window. It waits for the process only up to that window. If the timeout expires, that is success because the process did not exit; if the process exits during the window, it returns an error explaining that it exited too early.

**Call relations**: Each top-level signal test calls this after the first signal, and the SIGHUP test calls it after each SIGHUP. It pairs with wait_for_process_exit_within: first the tests prove “not yet,” then later they prove “now it should exit.”

*Call graph*: called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 3 external calls (wait, bail!, timeout).


##### `wait_for_process_exit_within`  (lines 295–304)

```
async fn wait_for_process_exit_within(
    process: &mut Child,
    window: Duration,
    timeout_context: &'static str,
) -> Result<std::process::ExitStatus>
```

**Purpose**: This helper waits for the app-server process to finish, but only for a limited time. It prevents tests from hanging forever if shutdown breaks.

**Data flow**: It receives the child process, a maximum wait time, and a timeout message. It waits for the process to exit within that time. If it exits, it returns the process exit status; if it does not, or waiting itself fails, it returns a clear error.

**Call relations**: All top-level signal tests use this after the expected waiting or forced-exit point. The tests then inspect the returned exit status to make sure the shutdown was considered successful.

*Call graph*: called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 2 external calls (wait, timeout).


##### `expect_websocket_disconnect`  (lines 306–327)

```
async fn expect_websocket_disconnect(stream: &mut WsClient) -> Result<()>
```

**Purpose**: This helper verifies that the WebSocket client sees the server close or drop the connection. It makes sure shutdown is visible to the connected client, not just to the operating system process table.

**Data flow**: It reads WebSocket frames until it sees the stream end, a close frame, or a read error. If the server sends a ping while the helper is waiting, it replies with a pong so the connection stays well-behaved during shutdown. If no disconnect arrives before the read timeout, it returns an error.

**Call relations**: Every top-level signal test calls this after the process exits. It is the final check that shutdown cleaned up the network connection rather than leaving the client waiting.

*Call graph*: called by 5 (websocket_transport_ctrl_c_waits_for_running_turn_before_exit, websocket_transport_repeated_sighup_keeps_waiting_for_running_turn, websocket_transport_second_ctrl_c_forces_exit_while_turn_running, websocket_transport_second_sigterm_forces_exit_while_turn_running, websocket_transport_sigterm_waits_for_running_turn_before_exit); 4 external calls (Pong, next, send, timeout).


### Handshake and protocol gating
These tests verify client-visible protocol contracts at connection setup, covering attestation forwarding and experimental API opt-in requirements.

### `app-server/tests/suite/v2/attestation.rs`

`test` · `test run`

This test protects an important trust path. The app server sometimes needs to open a WebSocket connection to the ChatGPT backend, and that connection may need an attestation header: a small signed-looking proof that says the request came through an approved client. Without this behavior, the server might connect successfully in simple cases but fail in environments that require that extra proof.

The test builds a miniature world around the app server. It starts a fake WebSocket server that records the incoming handshake headers. It creates a temporary Codex home folder with a test configuration pointing ChatGPT traffic at that fake server. It also writes fake ChatGPT login credentials so the app server believes it can use ChatGPT-style authentication.

Then the test starts the app server and initializes it as if it were being used by Codex Desktop. During initialization, the client advertises that it supports the experimental API and can answer attestation requests. The test starts a thread, starts a turn with a simple user message, and then watches messages from the server. When the server asks for an attestation token, the test replies with a known token. Finally, it checks the fake WebSocket server’s recorded handshake to make sure the outgoing connection included the expected `x-oai-attestation` header. The helper function at the bottom writes the exact config needed to force this path.

#### Function details

##### `attestation_generate_round_trip_adds_header_to_responses_websocket_handshake`  (lines 35–172)

```
async fn attestation_generate_round_trip_adds_header_to_responses_websocket_handshake() -> Result<()>
```

**Purpose**: This is the main integration test. It proves that when the app server needs an attestation token for a WebSocket connection, it asks the client for one and adds the resulting value to the outgoing WebSocket handshake header.

**Data flow**: The test starts with a fake local WebSocket server, a temporary configuration folder, and fake ChatGPT credentials. It launches the app server with that setup, initializes it with a client that says it can provide attestations, starts a conversation turn, and waits for the server to request an attestation. The test sends back a known token, then inspects the fake WebSocket server’s recorded handshake. The expected result is that the handshake contains the `x-oai-attestation` header with the app server’s wrapped version of that token.

**Call relations**: This function drives the whole scenario. It calls the local helper `create_chatgpt_websocket_config` to write a test configuration, uses test-support tools to start the fake WebSocket service and app server, and responds when the app server sends an attestation request. The final check connects the incoming server request, the test’s reply, and the outgoing WebSocket header into one end-to-end proof.

*Call graph*: calls 4 internal fn (new, new_with_env, create_chatgpt_websocket_config, start_websocket_server_with_headers); 14 external calls (default, try_from, new, Integer, default, to_response, write_chatgpt_auth, assert!, assert_eq!, bail! (+4 more)).


##### `create_chatgpt_websocket_config`  (lines 174–196)

```
fn create_chatgpt_websocket_config(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a temporary `config.toml` file that makes the app server use the fake test server as its ChatGPT provider. It keeps the main test focused on behavior instead of file-writing details.

**Data flow**: It receives the temporary Codex home path and the fake server’s base address. It builds a small TOML configuration string that selects a mock model provider, enables the responses API over WebSockets, disables retries, and marks the provider as requiring OpenAI-style authentication. It writes that text to `config.toml` inside the temporary home folder and returns success or a file-writing error.

**Call relations**: The main test calls this before starting the app server. That timing matters because the app server reads this configuration at startup, so the helper sets the route that later causes the app server’s conversation turn to connect to the fake WebSocket server where the handshake header can be checked.

*Call graph*: called by 1 (attestation_generate_round_trip_adds_header_to_responses_websocket_handshake); 3 external calls (join, format!, write).


### `app-server/tests/suite/v2/experimental_api.rs`

`test` · `test run`

This is a safety net for the server’s experimental features. The app server speaks JSON-RPC, a request-and-response message format where each request has a method name and an id. Some methods and fields are marked experimental, meaning clients should not be able to use them unless they opted in during initialization. Without these tests, a client could accidentally rely on unstable behavior, or the server could expose features it meant to keep behind a capability flag.

Each test starts a temporary server home directory, launches a test app server, and initializes it as a client that says `experimental_api: false`. Then the test sends one request that uses an experimental method or option. The expected result is a JSON-RPC error saying that the exact method or field requires the `experimentalApi` capability.

A few tests create a mock model-provider configuration first, because starting a thread needs a provider to talk to. One test is the important counterexample: it starts a normal thread without experimental fields and confirms that the server accepts it even without experimental access. In other words, this file checks both sides of the gate: experimental things are blocked, but normal things are not.

#### Function details

##### `mock_experimental_method_requires_experimental_api_capability`  (lines 31–59)

```
async fn mock_experimental_method_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test proves that the mock experimental JSON-RPC method is blocked unless the client opts into experimental API support. It protects the server from accepting a clearly experimental method from a non-experimental client.

**Data flow**: It creates a temporary server home, starts a test app server, and initializes it with `experimental_api` set to false. It then sends a mock experimental request, waits for the matching error response, and checks that the error says `mock/experimentalMethod` requires the experimental capability.

**Call relations**: This test uses `default_client_info` to build the fake client identity and `assert_experimental_capability_error` to verify the exact error shape. It relies on the test server helpers to start the server, send the request, and read the JSON-RPC error before the timeout.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 5 external calls (new, bail!, Integer, default, timeout).


##### `realtime_conversation_start_requires_experimental_api_capability`  (lines 62–103)

```
async fn realtime_conversation_start_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test checks that starting a realtime audio conversation is treated as experimental. A client that did not opt in should receive a clear rejection instead of starting the session.

**Data flow**: It starts a fresh test server, initializes as a client without experimental API support, and sends a `thread/realtime/start` request with audio output and a simple prompt. It waits for the response tied to that request id, then confirms the server returned the expected capability error.

**Call relations**: Like the other gatekeeping tests, it gets client details from `default_client_info` and sends the final error into `assert_experimental_capability_error`. The timeout wrapper keeps the test from hanging if the server fails to answer.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 4 external calls (new, bail!, Integer, timeout).


##### `thread_memory_mode_set_requires_experimental_api_capability`  (lines 106–137)

```
async fn thread_memory_mode_set_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test makes sure changing a thread’s memory mode is not allowed for clients that have not enabled the experimental API. It verifies that memory-related experimental controls stay behind the capability gate.

**Data flow**: It creates and initializes a test server with experimental support turned off. Then it asks to set the memory mode for a sample thread to disabled, reads the matching JSON-RPC error, and checks that the error names `thread/memoryMode/set` as requiring experimental access.

**Call relations**: The setup follows the same pattern as the other tests: `default_client_info` supplies the client metadata, and `assert_experimental_capability_error` checks the server’s rejection. The test server helper sends the memory-mode request and reads the response stream.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 4 external calls (new, bail!, Integer, timeout).


##### `thread_settings_update_requires_experimental_api_capability`  (lines 140–171)

```
async fn thread_settings_update_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test verifies that updating thread settings is an experimental operation when called through this API. A non-experimental client should not be able to change those settings.

**Data flow**: It starts a test server, initializes with `experimental_api` set to false, and sends a thread settings update request for a sample thread using otherwise default settings. It waits for the server error and checks that the message points to `thread/settings/update` as the blocked feature.

**Call relations**: It shares the common client setup through `default_client_info` and the common error check through `assert_experimental_capability_error`. The default parameter helper fills in unused fields so the test focuses only on the capability rule.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 5 external calls (default, new, bail!, Integer, timeout).


##### `realtime_webrtc_start_requires_experimental_api_capability`  (lines 174–217)

```
async fn realtime_webrtc_start_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test checks the WebRTC form of realtime conversation startup. WebRTC is a browser-friendly realtime media transport, and this test makes sure it also requires experimental API opt-in.

**Data flow**: It launches a fresh test server and initializes a client without experimental support. The test sends a realtime start request that includes a WebRTC offer string, then reads the error for that request and verifies that `thread/realtime/start` is rejected for lacking experimental capability.

**Call relations**: This is a variant of the realtime start test, but with the transport field set to WebRTC. It uses `default_client_info` for setup and `assert_experimental_capability_error` for the shared expected-error check.

*Call graph*: calls 3 internal fn (new, assert_experimental_capability_error, default_client_info); 4 external calls (new, bail!, Integer, timeout).


##### `thread_start_mock_field_requires_experimental_api_capability`  (lines 220–254)

```
async fn thread_start_mock_field_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test confirms that even an experimental field inside an otherwise normal `thread/start` request is blocked. The server should reject the specific field, not silently accept it.

**Data flow**: It starts a mock model-provider server, writes a temporary configuration that points to it, and launches the app server. After initializing without experimental API support, it sends a thread start request containing `mock_experimental_field`. The test reads the error response and verifies that the message names `thread/start.mockExperimentalField`.

**Call relations**: `create_config_toml` prepares the local config needed for thread startup, and `default_client_info` supplies the client identity. Once the request fails, `assert_experimental_capability_error` checks that the rejection is the standard experimental-capability error.

*Call graph*: calls 4 internal fn (new, assert_experimental_capability_error, create_config_toml, default_client_info); 7 external calls (default, new, new, bail!, Integer, create_mock_responses_server_sequence_unchecked, timeout).


##### `thread_start_without_dynamic_tools_allows_without_experimental_api_capability`  (lines 257–291)

```
async fn thread_start_without_dynamic_tools_allows_without_experimental_api_capability() -> Result<()>
```

**Purpose**: This test is the positive control: it proves that normal thread startup still works when experimental API support is off. That matters because the capability gate should block only experimental features, not the basic product flow.

**Data flow**: It creates a mock provider, writes a matching config file, starts the app server, and initializes a client without experimental support. It then sends a plain thread start request with a model name, waits for a normal JSON-RPC response, and parses it as a `ThreadStartResponse`.

**Call relations**: `create_config_toml` makes the mock provider usable by the server, and `default_client_info` keeps initialization consistent with the other tests. Instead of calling the shared error assertion, this test converts the response with `to_response` to prove the request succeeded.

*Call graph*: calls 3 internal fn (new, create_config_toml, default_client_info); 8 external calls (default, new, new, bail!, Integer, create_mock_responses_server_sequence_unchecked, to_response, timeout).


##### `thread_start_granular_approval_policy_requires_experimental_api_capability`  (lines 294–335)

```
async fn thread_start_granular_approval_policy_requires_experimental_api_capability() -> Result<()>
```

**Purpose**: This test checks that the granular approval policy is experimental. Granular approval means separate switches for different kinds of permission prompts, and the server should not allow that detailed policy unless the client opted in.

**Data flow**: It prepares a mock provider configuration, starts the app server, and initializes without experimental support. It sends a thread start request whose approval policy is the granular variant, reads the error for that request, and confirms the server says `askForApproval.granular` requires experimental access.

**Call relations**: `create_config_toml` supplies the test configuration needed before a thread can start, while `default_client_info` supplies the fake client identity. The final error is checked through `assert_experimental_capability_error`, matching the pattern used by the other blocked-feature tests.

*Call graph*: calls 4 internal fn (new, assert_experimental_capability_error, create_config_toml, default_client_info); 7 external calls (default, new, new, bail!, Integer, create_mock_responses_server_sequence_unchecked, timeout).


##### `default_client_info`  (lines 337–343)

```
fn default_client_info() -> ClientInfo
```

**Purpose**: This helper builds the same simple client identity for every test. It keeps the tests focused on experimental capability behavior instead of repeating client-name and version details.

**Data flow**: It takes no input. It returns a `ClientInfo` value with the default test client name, no title, and version `0.1.0`.

**Call relations**: All the tests call this during initialization so they present themselves to the server in a consistent way. The only thing the tests vary is the capability flag, which makes failures easier to understand.

*Call graph*: called by 8 (mock_experimental_method_requires_experimental_api_capability, realtime_conversation_start_requires_experimental_api_capability, realtime_webrtc_start_requires_experimental_api_capability, thread_memory_mode_set_requires_experimental_api_capability, thread_settings_update_requires_experimental_api_capability, thread_start_granular_approval_policy_requires_experimental_api_capability, thread_start_mock_field_requires_experimental_api_capability, thread_start_without_dynamic_tools_allows_without_experimental_api_capability).


##### `assert_experimental_capability_error`  (lines 345–352)

```
fn assert_experimental_capability_error(error: JSONRPCError, reason: &str)
```

**Purpose**: This helper checks that a server error is exactly the expected experimental-capability rejection. It avoids copying the same three assertions into every test.

**Data flow**: It receives a JSON-RPC error and the method or field name that should appear in the message. It checks that the error code is `-32600`, the message says that the named feature requires `experimentalApi` capability, and there is no extra error data.

**Call relations**: The tests that expect rejection pass their received server error here after reading it from the test server stream. This helper is the shared ruler that makes sure all experimental-gate failures look the same.

*Call graph*: called by 7 (mock_experimental_method_requires_experimental_api_capability, realtime_conversation_start_requires_experimental_api_capability, realtime_webrtc_start_requires_experimental_api_capability, thread_memory_mode_set_requires_experimental_api_capability, thread_settings_update_requires_experimental_api_capability, thread_start_granular_approval_policy_requires_experimental_api_capability, thread_start_mock_field_requires_experimental_api_capability); 1 external calls (assert_eq!).


##### `create_config_toml`  (lines 354–375)

```
fn create_config_toml(codex_home: &Path, server_uri: &str) -> std::io::Result<()>
```

**Purpose**: This helper writes a minimal test configuration file that tells the app server to use a mock model provider. Tests need this when they send `thread/start` requests, because thread startup expects model-provider settings to exist.

**Data flow**: It receives the temporary Codex home directory and the mock server’s URI. It writes a `config.toml` file there with a mock model, a safe approval policy, read-only sandbox mode, and provider connection details pointing at the mock server. It returns success or a file-writing error.

**Call relations**: The thread-start tests call this before launching or using the app server so the server can resolve the model provider during the request. It is not used by tests that only check methods rejected before any provider configuration matters.

*Call graph*: called by 3 (thread_start_granular_approval_policy_requires_experimental_api_capability, thread_start_mock_field_requires_experimental_api_capability, thread_start_without_dynamic_tools_allows_without_experimental_api_capability); 3 external calls (join, format!, write).


### Realtime conversation flows
This suite exercises full end-to-end realtime conversation behavior across transports, protocol versions, event mediation, and delegated turns.

### `app-server/tests/suite/v2/realtime_conversation.rs`

`test` · `test execution`

Realtime conversation is a complicated path: the app server talks to a client over JSON-RPC, talks to a mocked OpenAI Responses endpoint for background work, and talks to a mocked realtime WebSocket for live speech and text events. This file builds that whole miniature world in tests. Think of it like a stage set: fake servers play the outside services, a TestAppServer plays the real app server, and each test watches what messages move between them.

The tests cover both older v1 realtime behavior and newer v2 behavior. They verify that starting a realtime session sends the right session settings, WebRTC offers are posted as multipart requests, SDP answers are returned to the client, audio and text are forwarded correctly, and server events become typed client notifications. They also check the handoff path where realtime asks a background agent to do work, including progress updates, final function-call outputs, steering an already-running task, and delegated shell commands.

Many helper functions keep the tests readable. The harness creates temporary config, starts mock HTTP and WebSocket servers, logs in with a fake API key, starts a thread, and offers small methods for sending realtime input or reading notifications. Without this file, regressions in the realtime protocol could silently break desktop or voice clients.

#### Function details

##### `RealtimeCallRequestCapture::new`  (lines 102–106)

```
fn new() -> Self
```

**Purpose**: Creates a small recorder for WebRTC call-creation HTTP requests. Tests use it when they need to inspect exactly what the app server posted to the realtime calls endpoint.

**Data flow**: It starts with no inputs, creates an empty shared list protected by a mutex, and returns a capture object that can safely collect requests from the mock server.

**Call relations**: The realtime harness and WebRTC-specific tests create this before mounting a mock endpoint. Later, the mock matching hook records incoming requests and tests read them back with `RealtimeCallRequestCapture::single_request`.

*Call graph*: called by 5 (new_with_main_loop_responses_server_and_sandbox, realtime_webrtc_start_emits_sdp_notification, conversation_webrtc_start_posts_generated_session, conversation_webrtc_start_uses_avas_architecture_query, conversation_webrtc_start_uses_configured_call_base_url_for_avas); 3 external calls (new, new, new).


##### `RealtimeCallRequestCapture::single_request`  (lines 108–115)

```
fn single_request(&self) -> WiremockRequest
```

**Purpose**: Returns the one captured realtime call request and fails the test if there was not exactly one. This keeps tests strict about duplicate or missing WebRTC call creation.

**Data flow**: It reads the shared request list, checks that its length is one, clones that request, and gives the clone back to the test.

**Call relations**: WebRTC tests call this after starting realtime. The returned request is then passed to assertions such as `assert_call_create_multipart` or inspected directly.

*Call graph*: 1 external calls (assert_eq!).


##### `RealtimeCallRequestCapture::matches`  (lines 119–125)

```
fn matches(&self, request: &WiremockRequest) -> bool
```

**Purpose**: Records every HTTP request that reaches the mock realtime call endpoint. It always returns true so it behaves as a passive recorder, not a filter.

**Data flow**: It receives a mock HTTP request, locks the shared list, stores a clone of the request, and reports that the request matched.

**Call relations**: Wiremock calls this while matching `/v1/realtime/calls`. Tests later retrieve the captured request through `single_request` to verify headers and body content.

*Call graph*: 1 external calls (clone).


##### `normalized_json_string`  (lines 128–131)

```
fn normalized_json_string(raw: &str) -> Result<String>
```

**Purpose**: Turns a JSON string into a stable, compact JSON string for comparison. This avoids false test failures caused only by spacing or formatting differences.

**Data flow**: It takes raw JSON text, parses it into a JSON value, serializes that value back into a normalized string, and returns an error if either step fails.

**Call relations**: Multipart assertion helpers and WebRTC tests use this before comparing generated session JSON with expected JSON embedded in the test.

*Call graph*: called by 2 (assert_call_create_multipart, realtime_webrtc_start_emits_sdp_notification); 2 external calls (from_str, to_string).


##### `GatedSseResponse::respond`  (lines 139–149)

```
fn respond(&self, _: &WiremockRequest) -> ResponseTemplate
```

**Purpose**: Delays a mocked streaming response until a test explicitly opens a gate. This lets tests simulate a background agent task that is still running.

**Data flow**: It receives a mock HTTP request, waits on a one-shot channel if one is present, then returns the stored server-sent-events response text. Server-sent events are streaming HTTP messages.

**Call relations**: Wiremock calls this when a delegated Responses request arrives. Concurrency tests use the delay to prove realtime sideband messages still flow while background work is blocked.

*Call graph*: calls 1 internal fn (sse_response).


##### `RealtimeTestVersion::config_value`  (lines 159–164)

```
fn config_value(self) -> &'static str
```

**Purpose**: Converts the test enum for realtime version into the string expected in the temporary config file.

**Data flow**: It takes either the V1 or V2 enum value and returns `"v1"` or `"v2"`.

**Call relations**: `create_config_toml_with_realtime_version` calls this while writing config for each harness or direct test setup.

*Call graph*: called by 1 (create_config_toml_with_realtime_version).


##### `RealtimeTestSandbox::config_value`  (lines 174–179)

```
fn config_value(self) -> &'static str
```

**Purpose**: Converts the test sandbox choice into the config-file string used by the app server.

**Data flow**: It takes the sandbox enum and returns either `"read-only"` or `"danger-full-access"`.

**Call relations**: `create_config_toml_with_realtime_version` uses this so tests can choose whether delegated shell tools are allowed.

*Call graph*: called by 1 (create_config_toml_with_realtime_version).


##### `RealtimeE2eHarness::new`  (lines 213–227)

```
async fn new(
        realtime_version: RealtimeTestVersion,
        main_loop: MainLoopResponsesScript,
        realtime_sideband: RealtimeSidebandScript,
    ) -> Result<Self>
```

**Purpose**: Builds the standard realtime end-to-end test harness with a read-only sandbox. It is the common setup path for most tests.

**Data flow**: It receives a realtime version, scripted Responses output, and scripted realtime WebSocket behavior. It starts a mock Responses server from the script, then delegates to the fuller setup method and returns a ready harness.

**Call relations**: Most WebRTC realtime tests call this first. It hands setup work to `new_with_main_loop_responses_server_and_sandbox` so all harness variants share the same core initialization.

*Call graph*: called by 11 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_forwards_audio_and_text_between_client_and_sideband, webrtc_v2_text_input_is_append_only_when_response_is_cancelled (+1 more)); 2 external calls (new_with_main_loop_responses_server_and_sandbox, create_mock_responses_server_sequence_unchecked).


##### `RealtimeE2eHarness::new_with_sandbox`  (lines 229–244)

```
async fn new_with_sandbox(
        realtime_version: RealtimeTestVersion,
        main_loop: MainLoopResponsesScript,
        realtime_sideband: RealtimeSidebandScript,
        sandbox: RealtimeTestSa
```

**Purpose**: Builds the realtime harness while letting the test choose the sandbox mode. This is needed for tests that expect delegated shell commands to run.

**Data flow**: It takes version, main-loop script, sideband script, and sandbox choice. It creates the mock Responses server, writes matching config through the shared setup path, and returns the harness.

**Call relations**: The delegated shell-tool test uses this with a permissive sandbox. Internally it follows the same setup route as `RealtimeE2eHarness::new`.

*Call graph*: called by 1 (webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool); 2 external calls (new_with_main_loop_responses_server_and_sandbox, create_mock_responses_server_sequence_unchecked).


##### `RealtimeE2eHarness::new_with_main_loop_responses_server`  (lines 246–258)

```
async fn new_with_main_loop_responses_server(
        realtime_version: RealtimeTestVersion,
        main_loop_responses_server: MockServer,
        realtime_sideband: RealtimeSidebandScript,
    ) ->
```

**Purpose**: Builds the realtime harness around a mock Responses server that the test created itself. This is useful when the test needs special server behavior, such as delayed streaming.

**Data flow**: It receives an already-running mock Responses server plus realtime version and sideband script, then forwards everything to the shared setup method with the default read-only sandbox.

**Call relations**: Tests for steering and nonblocking audio create custom gated servers and then call this to plug them into the rest of the harness.

*Call graph*: called by 2 (webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_tool_call_does_not_block_sideband_audio); 1 external calls (new_with_main_loop_responses_server_and_sandbox).


##### `RealtimeE2eHarness::new_with_main_loop_responses_server_and_sandbox`  (lines 260–313)

```
async fn new_with_main_loop_responses_server_and_sandbox(
        realtime_version: RealtimeTestVersion,
        main_loop_responses_server: MockServer,
        realtime_sideband: RealtimeSidebandScri
```

**Purpose**: Performs the full harness setup: mock HTTP endpoints, mock WebSocket realtime server, temporary config, app-server startup, login, and initial thread creation.

**Data flow**: It takes version, Responses server, sideband script, and sandbox. It mounts a fake WebRTC call endpoint, starts a fake realtime WebSocket, writes config, starts `TestAppServer`, logs in, creates a thread, and returns all those pieces in one harness object.

**Call relations**: All other harness constructors funnel into this method. Later tests use the returned harness methods to start realtime, send input, read notifications, inspect upstream requests, and shut down the fake realtime server.

*Call graph*: calls 5 internal fn (new, new, create_config_toml_with_realtime_version, login_with_api_key, start_websocket_server_with_headers); 11 external calls (given, uri, new, new, Integer, default, Override, to_response, timeout, method (+1 more)).


##### `RealtimeE2eHarness::start_webrtc_realtime`  (lines 315–320)

```
async fn start_webrtc_realtime(&mut self, offer_sdp: &str) -> Result<StartedWebrtcRealtime>
```

**Purpose**: Starts a WebRTC realtime session with the default response-item settings. It gives tests a short way to begin the common WebRTC flow.

**Data flow**: It receives an offer SDP string, passes it along with no special `codex_responses_as_items` override, and returns the started notification plus SDP answer.

**Call relations**: Many WebRTC tests call this after constructing the harness. It delegates to `start_webrtc_realtime_with_codex_responses_as_items` for the actual JSON-RPC request and notification reads.

*Call graph*: calls 1 internal fn (start_webrtc_realtime_with_codex_responses_as_items).


##### `RealtimeE2eHarness::start_webrtc_realtime_with_codex_response_items`  (lines 322–331)

```
async fn start_webrtc_realtime_with_codex_response_items(
        &mut self,
        offer_sdp: &str,
    ) -> Result<StartedWebrtcRealtime>
```

**Purpose**: Starts WebRTC realtime while asking Codex responses to be added as realtime conversation items. Tests use this to check context-update behavior.

**Data flow**: It takes an offer SDP, sets the response-item option to true, and returns the same started-and-SDP result as the base starter.

**Call relations**: Tests that verify backend output is inserted into realtime context call this. It shares all mechanics with `start_webrtc_realtime_with_codex_responses_as_items`.

*Call graph*: calls 1 internal fn (start_webrtc_realtime_with_codex_responses_as_items).


##### `RealtimeE2eHarness::start_webrtc_realtime_with_codex_responses_as_items`  (lines 333–377)

```
async fn start_webrtc_realtime_with_codex_responses_as_items(
        &mut self,
        offer_sdp: &str,
        codex_responses_as_items: Option<bool>,
    ) -> Result<StartedWebrtcRealtime>
```

**Purpose**: Sends the actual JSON-RPC request that starts a WebRTC realtime session and waits for the client-visible startup notifications.

**Data flow**: It builds start parameters from the harness thread id, offer SDP, output modality, prompt, and optional response-item setting. It sends the request, waits for the response, then reads `thread/realtime/started` and `thread/realtime/sdp` notifications and returns them together.

**Call relations**: The two simpler WebRTC start helpers call this. Its result drives the rest of each test, which then inspects sideband WebSocket messages or sends more realtime input.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_start_request); called by 2 (start_webrtc_realtime, start_webrtc_realtime_with_codex_response_items); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::read_notification`  (lines 379–381)

```
async fn read_notification(&mut self, method: &str) -> Result<T>
```

**Purpose**: Reads one typed notification from the app server for this harness. It saves tests from repeatedly passing the underlying app-server client.

**Data flow**: It takes a notification method name, asks the shared `read_notification` helper to wait for that method, deserializes the payload into the requested type, and returns it.

**Call relations**: Harness-based tests call this throughout turn and realtime flows. It is a thin wrapper over the file-level `read_notification` helper.

*Call graph*: calls 1 internal fn (read_notification).


##### `RealtimeE2eHarness::sideband_outbound_request`  (lines 385–394)

```
async fn sideband_outbound_request(&self, request_index: usize) -> Value
```

**Purpose**: Fetches a JSON message that the app server sent upstream to the fake realtime WebSocket. This lets tests inspect the protocol frames the server produced.

**Data flow**: It takes a request index, waits for that indexed WebSocket request on the first connection, parses its body as JSON, and returns the JSON value. The wait is bounded by a timeout.

**Call relations**: Most harness tests use this after starting realtime or sending input. The returned JSON is checked by assertion helpers such as `assert_v2_session_update` and `assert_v2_function_call_output`.

*Call graph*: calls 1 internal fn (wait_for_request); 1 external calls (timeout).


##### `RealtimeE2eHarness::append_audio`  (lines 396–418)

```
async fn append_audio(&mut self, thread_id: String) -> Result<()>
```

**Purpose**: Simulates a client app sending an audio chunk into an active realtime conversation.

**Data flow**: It takes a thread id, sends a JSON-RPC append-audio request containing a small base64 audio payload and audio metadata, waits for the response, verifies it has the expected response type, and returns success.

**Call relations**: Tests call this when they need to prove client audio reaches the realtime sideband. Afterward they inspect the outbound WebSocket request.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_append_audio_request); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::append_text`  (lines 420–437)

```
async fn append_text(&mut self, thread_id: String, text: &str) -> Result<()>
```

**Purpose**: Simulates a client app sending user text into an active realtime conversation.

**Data flow**: It takes a thread id and text, sends a JSON-RPC append-text request with the user role, waits for the response, checks the response type, and returns success.

**Call relations**: Forwarding and append-only regression tests use this. They then read the sideband message to ensure the app server translated the text correctly.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_append_text_request); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::append_speech`  (lines 439–455)

```
async fn append_speech(&mut self, thread_id: String, text: &str) -> Result<()>
```

**Purpose**: Simulates manually appending speech output for realtime to say aloud.

**Data flow**: It takes a thread id and text, sends a JSON-RPC append-speech request, waits for the matching response, checks the response type, and returns success.

**Call relations**: Tests for manual spoken updates call this after background output. They then verify the sideband received either a v1 handoff append or a v2 progress update plus response request.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_thread_realtime_append_speech_request); 3 external calls (Integer, to_response, timeout).


##### `RealtimeE2eHarness::main_loop_responses_requests`  (lines 457–459)

```
async fn main_loop_responses_requests(&self) -> Result<Vec<Value>>
```

**Purpose**: Returns the JSON request bodies sent to the mocked Responses API during the test.

**Data flow**: It reads the harness mock Responses server, filters for `/responses` calls, parses each body as JSON, and returns the list.

**Call relations**: Delegation tests call this after a background-agent turn to confirm the prompt, transcript context, steering text, or shell output was sent to the normal background agent path.

*Call graph*: calls 1 internal fn (responses_requests).


##### `RealtimeE2eHarness::shutdown`  (lines 461–463)

```
async fn shutdown(self)
```

**Purpose**: Stops the fake realtime WebSocket server used by the harness. This cleans up the test environment.

**Data flow**: It consumes the harness and calls shutdown on its realtime server. No value is returned.

**Call relations**: Harness-based tests call this at the end so mock server tasks do not leak into later tests.

*Call graph*: calls 1 internal fn (shutdown).


##### `main_loop_responses`  (lines 466–468)

```
fn main_loop_responses(responses: Vec<String>) -> MainLoopResponsesScript
```

**Purpose**: Wraps a list of scripted server-sent-event response bodies into the small struct used by the harness.

**Data flow**: It takes a vector of response strings and returns a `MainLoopResponsesScript` containing them.

**Call relations**: Tests use this when they want the mocked background-agent Responses endpoint to return specific outputs. `no_main_loop_responses` uses it for the empty case.

*Call graph*: called by 9 (no_main_loop_responses, realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool).


##### `no_main_loop_responses`  (lines 470–472)

```
fn no_main_loop_responses() -> MainLoopResponsesScript
```

**Purpose**: Creates an empty background-agent response script. This is for tests where realtime should not call the normal Responses loop.

**Data flow**: It creates an empty vector and passes it to `main_loop_responses`, returning the script wrapper.

**Call relations**: Tests that focus only on realtime WebSocket forwarding or startup use this to make unexpected Responses calls obvious.

*Call graph*: calls 1 internal fn (main_loop_responses); called by 4 (webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband, webrtc_v2_forwards_audio_and_text_between_client_and_sideband, webrtc_v2_text_input_is_append_only_when_response_is_cancelled, webrtc_v2_text_input_is_append_only_while_response_is_active); 1 external calls (new).


##### `realtime_sideband`  (lines 474–476)

```
fn realtime_sideband(connections: Vec<WebSocketConnectionConfig>) -> RealtimeSidebandScript
```

**Purpose**: Wraps scripted WebSocket connection behavior for the fake realtime sideband server.

**Data flow**: It takes a list of connection configurations and returns a `RealtimeSidebandScript` containing them.

**Call relations**: Harness tests call this while building their fake realtime server behavior. The harness later starts a WebSocket server from the wrapped connections.

*Call graph*: called by 14 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_forwards_audio_and_text_between_client_and_sideband (+4 more)).


##### `realtime_sideband_connection`  (lines 478–487)

```
fn realtime_sideband_connection(
    realtime_server_events: Vec<Vec<Value>>,
) -> WebSocketConnectionConfig
```

**Purpose**: Builds a default fake realtime WebSocket connection that sends scripted events and then closes after the expected requests.

**Data flow**: It takes batches of JSON events to send in response to app-server requests, fills in default headers and timing, sets close-after-requests to true, and returns the connection config.

**Call relations**: Most realtime sideband scripts use this. `open_realtime_sideband_connection` starts from it and changes the close behavior.

*Call graph*: called by 1 (open_realtime_sideband_connection); 1 external calls (new).


##### `open_realtime_sideband_connection`  (lines 489–496)

```
fn open_realtime_sideband_connection(
    realtime_server_events: Vec<Vec<Value>>,
) -> WebSocketConnectionConfig
```

**Purpose**: Builds a fake realtime WebSocket connection that stays open after scripted requests. This is important for WebRTC sessions that should remain alive.

**Data flow**: It takes scripted event batches, creates the normal sideband connection config, flips `close_after_requests` to false, and returns it.

**Call relations**: The v1 WebRTC startup test uses this to prove starting a WebRTC transport does not immediately close the realtime sideband.

*Call graph*: calls 1 internal fn (realtime_sideband_connection).


##### `session_updated`  (lines 498–503)

```
fn session_updated(realtime_session_id: &str) -> Value
```

**Purpose**: Creates a standard fake `session.updated` realtime event. It keeps test scripts short and consistent.

**Data flow**: It takes a realtime session id and returns JSON with that id plus the test backend prompt as instructions.

**Call relations**: Many sideband scripts use this as the first server event after the app server sends its session update.

*Call graph*: 1 external calls (json!).


##### `v2_background_agent_tool_call`  (lines 505–516)

```
fn v2_background_agent_tool_call(call_id: &str, prompt: &str) -> Value
```

**Purpose**: Creates a fake v2 realtime function-call event asking the background agent to do work.

**Data flow**: It takes a call id and prompt, builds a `conversation.item.done` JSON item for the `background_agent` function, and serializes the prompt into the function arguments field.

**Call relations**: V2 delegation, steering, progress, shell-tool, and nonblocking tests place this event in sideband scripts to trigger the app server's background-agent path.

*Call graph*: 1 external calls (json!).


##### `realtime_conversation_streams_v2_notifications`  (lines 519–831)

```
async fn realtime_conversation_streams_v2_notifications() -> Result<()>
```

**Purpose**: Tests the main v2 realtime event stream from startup through audio, transcript, handoff request, error, and close notifications.

**Data flow**: It starts mock Responses and realtime servers, writes config, starts and logs into the app server, creates a thread, starts realtime, appends audio and text, then reads and checks the notifications sent back to the client.

**Call relations**: This direct test uses helpers such as `create_config_toml`, `login_with_api_key`, and `read_notification`. It also inspects the fake WebSocket connection to prove client input became the correct upstream realtime messages.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 10 external calls (new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `realtime_start_can_skip_startup_context`  (lines 834–905)

```
async fn realtime_start_can_skip_startup_context() -> Result<()>
```

**Purpose**: Tests that a realtime start request can opt out of adding generated startup context to the realtime instructions.

**Data flow**: It starts a session with `include_startup_context` set to false, reads the first sideband session update, and checks that the instructions contain only the backend prompt.

**Call relations**: This test follows the direct setup pattern with `create_config_toml`, `login_with_api_key`, and `read_notification`, then validates the outbound WebSocket message.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 11 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout (+1 more)).


##### `realtime_text_output_modality_requests_text_output_and_final_transcript`  (lines 908–1045)

```
async fn realtime_text_output_modality_requests_text_output_and_final_transcript() -> Result<()>
```

**Purpose**: Tests that text-only realtime mode asks the upstream service for text output and emits one final assistant transcript.

**Data flow**: It starts realtime with text output modality, checks the session update requests `text`, consumes text delta and done events, and ensures no duplicate final transcript is emitted from a separate audio-transcript-done event.

**Call relations**: This test uses the direct app-server setup helpers and the generic notification reader. It guards against double-reporting final transcript text to clients.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 11 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout (+1 more)).


##### `realtime_list_voices_returns_supported_names`  (lines 1048–1105)

```
async fn realtime_list_voices_returns_supported_names() -> Result<()>
```

**Purpose**: Tests the JSON-RPC method that lists supported realtime voices. It verifies both v1 and v2 voice lists and defaults.

**Data flow**: It writes config, starts the app server, sends the list-voices request, converts the JSON-RPC response into the typed response, and compares it with the expected voice list.

**Call relations**: This test does not need network mocks beyond dummy config URLs because listing voices is local protocol behavior.

*Call graph*: calls 2 internal fn (new, create_config_toml); 5 external calls (new, Integer, to_response, assert_eq!, timeout).


##### `realtime_conversation_stop_emits_closed_notification`  (lines 1108–1194)

```
async fn realtime_conversation_stop_emits_closed_notification() -> Result<()>
```

**Purpose**: Tests that stopping an active realtime conversation sends a closed notification to the client.

**Data flow**: It starts a realtime session, sends a stop request for the thread, reads the stop response, then waits for `thread/realtime/closed` and checks the close reason.

**Call relations**: The test uses the same direct setup helpers as other startup tests and verifies the shutdown path exposed to client applications.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 11 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, assert!, assert_eq!, skip_if_no_network!, timeout (+1 more)).


##### `realtime_webrtc_start_emits_sdp_notification`  (lines 1197–1363)

```
async fn realtime_webrtc_start_emits_sdp_notification() -> Result<()>
```

**Purpose**: Tests the v2 WebRTC startup path, including posting the offer, returning the SDP answer, joining the sideband, and forming the session payload.

**Data flow**: It captures the HTTP call-create request, starts realtime with a WebRTC offer, reads started and SDP notifications, checks the sideband URL and startup context, then stops realtime and inspects the multipart call body.

**Call relations**: This test uses `RealtimeCallRequestCapture`, `normalized_json_string`, and direct setup helpers. It is the detailed v2 counterpart to harness-based WebRTC startup tests.

*Call graph*: calls 6 internal fn (new, new, create_config_toml, login_with_api_key, normalized_json_string, start_websocket_server_with_headers); 17 external calls (given, new, from_utf8, new, new, Integer, default, Override, create_mock_responses_server_sequence_unchecked, to_response (+7 more)).


##### `webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband`  (lines 1366–1424)

```
async fn webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband() -> Result<()>
```

**Purpose**: Tests that v1 WebRTC startup posts the SDP offer, returns the answer, and joins the v1 sideband connection without closing immediately.

**Data flow**: It builds a v1 harness, starts WebRTC, compares the started and SDP notifications, checks the captured multipart request and session update, and confirms no early closed notification appears.

**Call relations**: It relies on the harness setup, `assert_call_create_multipart`, `v1_session_create_json`, and `assert_v1_session_update` to validate the v1-specific protocol.

*Call graph*: calls 6 internal fn (new, assert_call_create_multipart, assert_v1_session_update, no_main_loop_responses, realtime_sideband, v1_session_create_json); 6 external calls (from_millis, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v1_default_automatic_output_uses_handoff_append`  (lines 1427–1481)

```
async fn webrtc_v1_default_automatic_output_uses_handoff_append() -> Result<()>
```

**Purpose**: Tests that automatic background-agent output in v1 is sent to realtime using the v1 handoff append message.

**Data flow**: It starts a v1 harness with a final mocked assistant response, begins realtime, starts a normal text turn, waits for completion, then checks the sideband received `conversation.handoff.append` with the output text.

**Call relations**: This connects the normal turn flow to the realtime v1 sideband. It uses the harness and `assert_v1_session_update` to keep setup and v1 session checks consistent.

*Call graph*: calls 4 internal fn (new, assert_v1_session_update, main_loop_responses, realtime_sideband); 7 external calls (default, Integer, to_response, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks`  (lines 1484–1585)

```
async fn webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks() -> Result<()>
```

**Purpose**: Tests v1 handoff delegation: realtime asks for background work, transcript context is sent to Responses, and manual speech output is spoken back.

**Data flow**: It scripts a v1 handoff request and transcript events, starts realtime with response items enabled, waits for the delegated turn to finish, inspects the Responses prompt, verifies context was inserted into realtime, then appends manual speech and checks it was sent as v1 handoff output.

**Call relations**: This test uses the harness, multipart/session assertions, `response_request_contains_text`, and `append_speech` to cover both delegation and manual output paths.

*Call graph*: calls 6 internal fn (new, assert_call_create_multipart, assert_v1_session_update, main_loop_responses, realtime_sideband, v1_session_create_json); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `realtime_automatic_standalone_output_is_item_and_append_speaks`  (lines 1588–1664)

```
async fn realtime_automatic_standalone_output_is_item_and_append_speaks() -> Result<()>
```

**Purpose**: Tests v2 behavior when ordinary background-agent output happens during realtime without a handoff call.

**Data flow**: It starts v2 WebRTC with response items enabled, runs a normal text turn, verifies the automatic output is added as a backend context item without requesting realtime speech, then appends manual speech and checks that it does request a realtime response.

**Call relations**: It uses the harness plus v2 assertion helpers for backend item updates, progress updates, and response creation.

*Call graph*: calls 6 internal fn (new, assert_v2_backend_item_update, assert_v2_progress_update, assert_v2_response_create, main_loop_responses, realtime_sideband); 9 external calls (default, from_millis, Integer, to_response, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `realtime_automatic_handoff_output_is_item_and_append_speaks`  (lines 1667–1738)

```
async fn realtime_automatic_handoff_output_is_item_and_append_speaks() -> Result<()>
```

**Purpose**: Tests v2 behavior when automatic output is produced by a realtime background-agent handoff.

**Data flow**: It scripts a v2 background-agent function call, waits for the delegated turn, verifies the final output is inserted as a backend item and the function-call output acknowledges completion, then checks manual speech creates a spoken realtime response.

**Call relations**: This test connects `v2_background_agent_tool_call` with harness notification reads and v2 sideband assertion helpers.

*Call graph*: calls 7 internal fn (new, assert_v2_backend_item_update, assert_v2_function_call_output, assert_v2_progress_update, assert_v2_response_create, main_loop_responses, realtime_sideband); 6 external calls (from_millis, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v2_assistant_output_without_handoff_reaches_realtime_context`  (lines 1741–1818)

```
async fn webrtc_v2_assistant_output_without_handoff_reaches_realtime_context() -> Result<()>
```

**Purpose**: Tests that assistant output from a normal turn reaches realtime context even when no realtime handoff requested it.

**Data flow**: It creates a long final answer plus a shorter preamble, runs a normal turn during v2 realtime, then checks that both pieces are sent as backend context items and that the long one is truncated to a safe size.

**Call relations**: The test uses `main_loop_responses`, the harness, and `assert_v2_backend_item_update` to guard the path that keeps realtime aware of background Codex responses.

*Call graph*: calls 4 internal fn (new, assert_v2_backend_item_update, main_loop_responses, realtime_sideband); 8 external calls (default, Integer, to_response, assert!, assert_eq!, skip_if_no_network!, timeout, vec!).


##### `webrtc_v2_forwards_audio_and_text_between_client_and_sideband`  (lines 1821–1897)

```
async fn webrtc_v2_forwards_audio_and_text_between_client_and_sideband() -> Result<()>
```

**Purpose**: Tests two-way v2 forwarding: client audio and text go to the realtime sideband, and sideband transcript and audio come back as client notifications.

**Data flow**: It starts a v2 harness, appends audio and text through JSON-RPC, reads transcript and audio notifications from sideband events, then inspects outbound WebSocket messages for the expected audio append and user text item.

**Call relations**: This test uses `no_main_loop_responses`, `assert_v2_session_update`, and the harness append/read helpers to focus on realtime transport forwarding.

*Call graph*: calls 4 internal fn (new, assert_v2_session_update, no_main_loop_responses, realtime_sideband); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_text_input_is_append_only_while_response_is_active`  (lines 1904–1973)

```
async fn webrtc_v2_text_input_is_append_only_while_response_is_active() -> Result<()>
```

**Purpose**: Tests that v2 text input does not request a new realtime response while one is already active.

**Data flow**: It scripts a response-created event, sends a first text item, reads an assistant delta, sends a second text item while the response is active, then sends audio and confirms all three outbound messages are only the expected append operations.

**Call relations**: This regression test uses the harness and `assert_v2_user_text_item` to protect append-only text behavior during active responses.

*Call graph*: calls 5 internal fn (new, assert_v2_session_update, assert_v2_user_text_item, no_main_loop_responses, realtime_sideband); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_text_input_is_append_only_when_response_is_cancelled`  (lines 1978–2031)

```
async fn webrtc_v2_text_input_is_append_only_when_response_is_cancelled() -> Result<()>
```

**Purpose**: Tests that v2 text input remains append-only while a response is open but later cancelled.

**Data flow**: It scripts a response-created event followed later by cancellation, sends two text items and one audio chunk, and checks the sideband only receives user text items and audio append, not extra response requests.

**Call relations**: This regression test mirrors the active-response test but covers cancellation. It uses the same harness and v2 text assertion helper.

*Call graph*: calls 5 internal fn (new, assert_v2_session_update, assert_v2_user_text_item, no_main_loop_responses, realtime_sideband); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output`  (lines 2039–2128)

```
async fn webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output() -> Result<()>
```

**Purpose**: Tests the core v2 background-agent handoff path from realtime function call to delegated turn and final function-call output.

**Data flow**: It scripts transcript events, a hidden collaboration update, and a background-agent function call. After realtime starts, it waits for the delegated turn, inspects the Responses request for the correct transcript envelope and absence of hidden control text, then checks progress and final function-call output messages to realtime.

**Call relations**: This test combines `v2_background_agent_tool_call`, `response_request_contains_text`, and v2 sideband assertion helpers to validate the main handoff contract.

*Call graph*: calls 5 internal fn (new, assert_v2_function_call_output, assert_v2_progress_update, main_loop_responses, realtime_sideband); 4 external calls (assert!, assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_background_agent_steering_ack_requests_response_create`  (lines 2137–2217)

```
async fn webrtc_v2_background_agent_steering_ack_requests_response_create() -> Result<()>
```

**Purpose**: Tests that a second background-agent call during an active delegated task is treated as steering, acknowledged, and then spoken by realtime.

**Data flow**: It uses a gated Responses stream to keep the first task active, sends two v2 tool calls, verifies the second call gets a steering acknowledgement and `response.create`, then releases the gate and checks the follow-up Responses request includes the steering text.

**Call relations**: This concurrency test uses `GatedSseResponse`, a custom mock server, the harness custom-server constructor, and v2 function-output and response-create assertions.

*Call graph*: calls 7 internal fn (new_with_main_loop_responses_server, assert_v2_function_call_output, assert_v2_response_create, assert_v2_session_update, realtime_sideband, sse, start_mock_server); 9 external calls (given, new, assert!, assert_eq!, channel, skip_if_no_network!, vec!, method, path_regex).


##### `webrtc_v2_background_agent_progress_is_sent_before_function_output`  (lines 2220–2259)

```
async fn webrtc_v2_background_agent_progress_is_sent_before_function_output() -> Result<()>
```

**Purpose**: Tests ordering for v2 delegated output: progress context should be sent before the final function-call output.

**Data flow**: It scripts a background-agent call and final assistant response, waits for turn completion, then checks the first sideband update is progress and the next is the completion function output.

**Call relations**: This test uses the harness and v2 assertion helpers to protect message ordering that realtime depends on.

*Call graph*: calls 5 internal fn (new, assert_v2_function_call_output, assert_v2_progress_update, main_loop_responses, realtime_sideband); 3 external calls (assert_eq!, skip_if_no_network!, vec!).


##### `webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool`  (lines 2262–2349)

```
async fn webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool() -> Result<()>
```

**Purpose**: Tests that a realtime v2 background-agent handoff can run a delegated shell command when the sandbox allows it.

**Data flow**: It starts the harness with dangerous full access, scripts a shell-tool request followed by a final answer, waits for command-started and command-completed item notifications, checks the command output, inspects Responses requests, and verifies progress plus final function-call output to realtime.

**Call relations**: This test uses `new_with_sandbox`, `realtime_tool_ok_command`, command-wait helpers, and v2 sideband assertions to cover tool execution inside delegated realtime work.

*Call graph*: calls 7 internal fn (new_with_sandbox, assert_v2_function_call_output, assert_v2_progress_update, main_loop_responses, realtime_sideband, wait_for_completed_command_execution, wait_for_started_command_execution); 5 external calls (assert!, assert_eq!, skip_if_no_network!, unreachable!, vec!).


##### `webrtc_v2_tool_call_does_not_block_sideband_audio`  (lines 2352–2429)

```
async fn webrtc_v2_tool_call_does_not_block_sideband_audio() -> Result<()>
```

**Purpose**: Tests that a slow delegated background-agent turn does not block realtime audio events from reaching the client.

**Data flow**: It gates the delegated Responses stream, scripts a tool call plus an audio delta, starts realtime, waits for the delegated turn to begin, confirms the audio notification arrives before releasing the gate, then verifies final progress and function output after completion.

**Call relations**: This uses `GatedSseResponse`, the custom harness constructor, and v2 assertions to prove sideband reading stays responsive during background work.

*Call graph*: calls 6 internal fn (new_with_main_loop_responses_server, assert_v2_function_call_output, assert_v2_progress_update, realtime_sideband, sse, start_mock_server); 8 external calls (given, new, assert_eq!, channel, skip_if_no_network!, vec!, method, path_regex).


##### `realtime_webrtc_start_surfaces_backend_error`  (lines 2432–2502)

```
async fn realtime_webrtc_start_surfaces_backend_error() -> Result<()>
```

**Purpose**: Tests that a failed backend WebRTC call-creation request becomes a typed realtime error notification for the client.

**Data flow**: It makes the mock call endpoint return a 500 error, starts app server and thread, requests WebRTC realtime, then reads `thread/realtime/error` and checks the message is user-friendly.

**Call relations**: This direct setup test uses `create_config_toml`, `login_with_api_key`, and `read_notification` to validate error reporting after the start request itself returns.

*Call graph*: calls 4 internal fn (new, create_config_toml, login_with_api_key, start_websocket_server); 15 external calls (given, new, new, new, Integer, default, Override, create_mock_responses_server_sequence_unchecked, to_response, assert! (+5 more)).


##### `realtime_conversation_requires_feature_flag`  (lines 2505–2564)

```
async fn realtime_conversation_requires_feature_flag() -> Result<()>
```

**Purpose**: Tests that realtime conversation cannot start when the feature flag is disabled.

**Data flow**: It writes config with realtime disabled, starts a thread, sends a realtime start request, reads the JSON-RPC error, and checks it is an invalid-request error with the expected message.

**Call relations**: This test uses `create_config_toml` and `assert_invalid_request`. It protects the feature-gating behavior before any realtime transport is opened.

*Call graph*: calls 4 internal fn (new, assert_invalid_request, create_config_toml, start_websocket_server); 10 external calls (new, new, Integer, default, create_mock_responses_server_sequence_unchecked, to_response, format!, skip_if_no_network!, timeout, vec!).


##### `read_notification`  (lines 2566–2579)

```
async fn read_notification(
    mcp: &mut TestAppServer,
    method: &str,
) -> Result<T>
```

**Purpose**: Waits for one app-server notification by method name and converts its JSON payload into a typed Rust value.

**Data flow**: It takes a mutable test app server and method string, waits up to the default timeout for that notification, extracts its params, deserializes them, and returns the typed result.

**Call relations**: Direct tests and the harness wrapper call this whenever they need to observe client-visible events such as realtime started, transcript delta, turn completed, or item completed.

*Call graph*: calls 1 internal fn (read_stream_until_notification_message); called by 1 (read_notification); 2 external calls (from_value, timeout).


##### `login_with_api_key`  (lines 2581–2592)

```
async fn login_with_api_key(mcp: &mut TestAppServer, api_key: &str) -> Result<()>
```

**Purpose**: Logs the test app server in with a fake API key and verifies the login response.

**Data flow**: It sends a login request, waits for the matching JSON-RPC response, converts it into `LoginAccountResponse`, checks that it is the API-key variant, and returns success.

**Call relations**: Harness setup and direct realtime startup tests call this before starting realtime, because realtime paths require an authenticated account.

*Call graph*: calls 2 internal fn (read_stream_until_response_message, send_login_account_api_key_request); called by 7 (new_with_main_loop_responses_server_and_sandbox, realtime_conversation_stop_emits_closed_notification, realtime_conversation_streams_v2_notifications, realtime_start_can_skip_startup_context, realtime_text_output_modality_requests_text_output_and_final_transcript, realtime_webrtc_start_emits_sdp_notification, realtime_webrtc_start_surfaces_backend_error); 4 external calls (Integer, to_response, assert_eq!, timeout).


##### `wait_for_started_command_execution`  (lines 2594–2603)

```
async fn wait_for_started_command_execution(
    mcp: &mut TestAppServer,
) -> Result<ItemStartedNotification>
```

**Purpose**: Waits until the app server reports that a command-execution item has started.

**Data flow**: It repeatedly reads `item/started` notifications, ignores non-command items, and returns the first notification whose thread item is command execution.

**Call relations**: The delegated shell-tool test calls this to observe the shell command launched by the background-agent turn.

*Call graph*: called by 1 (webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool).


##### `wait_for_completed_command_execution`  (lines 2605–2615)

```
async fn wait_for_completed_command_execution(
    mcp: &mut TestAppServer,
) -> Result<ItemCompletedNotification>
```

**Purpose**: Waits until the app server reports that a command-execution item has completed.

**Data flow**: It repeatedly reads `item/completed` notifications, ignores non-command items, and returns the first command-execution completion.

**Call relations**: The delegated shell-tool test calls this after command start to verify the command finished and produced the expected output.

*Call graph*: called by 1 (webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool).


##### `responses_requests`  (lines 2617–2630)

```
async fn responses_requests(server: &MockServer) -> Result<Vec<Value>>
```

**Purpose**: Collects the JSON bodies of requests sent to the mocked Responses endpoint.

**Data flow**: It asks the mock server for received requests, filters to URLs ending in `/responses`, parses each body as JSON, and returns the resulting list.

**Call relations**: `RealtimeE2eHarness::main_loop_responses_requests` calls this. Delegation tests then search these bodies for prompts, transcript envelopes, steering text, or shell output.

*Call graph*: called by 1 (main_loop_responses_requests); 1 external calls (received_requests).


##### `response_request_contains_text`  (lines 2632–2643)

```
fn response_request_contains_text(request: &Value, text: &str) -> bool
```

**Purpose**: Searches a JSON value recursively for a piece of text. Tests use it to check that important prompt content appears somewhere in a nested Responses request.

**Data flow**: It takes a JSON value and target text. If the value is a string, it checks for the text; if it is an array or object, it searches children; other JSON types return false.

**Call relations**: Delegation and shell-tool tests call this after collecting Responses requests to avoid depending on the exact nesting of the request schema.


##### `realtime_tool_ok_command`  (lines 2645–2660)

```
fn realtime_tool_ok_command() -> Vec<String>
```

**Purpose**: Returns a tiny cross-platform shell command that prints `realtime-tool-ok`.

**Data flow**: It checks the operating system at compile time. On Windows it returns a PowerShell command; elsewhere it returns `printf realtime-tool-ok`.

**Call relations**: The delegated shell-tool test uses this as the command that the mocked Responses stream asks the background agent to run.

*Call graph*: 1 external calls (vec!).


##### `assert_v2_function_call_output`  (lines 2662–2674)

```
fn assert_v2_function_call_output(request: &Value, call_id: &str, expected_output: &str)
```

**Purpose**: Checks that a sideband request is exactly the v2 function-call output message expected for a given call id and output string.

**Data flow**: It takes the JSON request, call id, and expected output, builds the expected JSON shape, and asserts exact equality.

**Call relations**: V2 handoff, steering, progress-order, shell-tool, and nonblocking tests use this to verify final or acknowledgement messages sent back to realtime.

*Call graph*: called by 6 (realtime_automatic_handoff_output_is_item_and_append_speaks, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool, webrtc_v2_tool_call_does_not_block_sideband_audio); 1 external calls (assert_eq!).


##### `assert_v2_progress_update`  (lines 2676–2691)

```
fn assert_v2_progress_update(request: &Value, expected_text: &str)
```

**Purpose**: Checks that a v2 progress update was sent as a user message marked with a `[BACKEND]` prefix.

**Data flow**: It takes a JSON request and expected text, builds the exact expected `conversation.item.create` message, and compares it with the request.

**Call relations**: Tests use this after automatic or delegated background output when realtime should be prompted to speak or react to progress.

*Call graph*: called by 6 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v2_background_agent_progress_is_sent_before_function_output, webrtc_v2_background_agent_tool_call_delegates_and_returns_function_output, webrtc_v2_tool_call_delegated_turn_can_execute_shell_tool, webrtc_v2_tool_call_does_not_block_sideband_audio); 1 external calls (assert_eq!).


##### `assert_v2_backend_item_update`  (lines 2693–2695)

```
fn assert_v2_backend_item_update(request: &Value, expected_text: &str)
```

**Purpose**: Checks that backend output was inserted into v2 realtime context as a developer item.

**Data flow**: It prefixes the expected text with `[BACKEND]` and passes the result to `assert_v2_items_update`.

**Call relations**: Automatic-output tests and the standalone assistant-output test call this when output should inform realtime silently rather than trigger speech.

*Call graph*: calls 1 internal fn (assert_v2_items_update); called by 3 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v2_assistant_output_without_handoff_reaches_realtime_context); 1 external calls (format!).


##### `assert_v2_items_update`  (lines 2697–2712)

```
fn assert_v2_items_update(request: &Value, expected_text: &str)
```

**Purpose**: Checks the exact v2 developer-message shape used to add backend context to realtime.

**Data flow**: It takes a JSON request and expected text, prepends the standard response-item instruction prefix, builds the expected `conversation.item.create` JSON, and asserts equality.

**Call relations**: `assert_v2_backend_item_update` calls this so multiple tests share one definition of the backend-context item format.

*Call graph*: called by 1 (assert_v2_backend_item_update); 1 external calls (assert_eq!).


##### `assert_v2_user_text_item`  (lines 2714–2729)

```
fn assert_v2_user_text_item(request: &Value, expected_text: &str)
```

**Purpose**: Checks that v2 user text was forwarded as a user conversation item with the `[USER]` prefix.

**Data flow**: It takes a JSON request and expected text, builds the exact expected sideband JSON, and compares them.

**Call relations**: The append-only text regression tests use this after each text append to prove no extra response request was sent in place of the user item.

*Call graph*: called by 2 (webrtc_v2_text_input_is_append_only_when_response_is_cancelled, webrtc_v2_text_input_is_append_only_while_response_is_active); 1 external calls (assert_eq!).


##### `assert_v2_response_create`  (lines 2731–2738)

```
fn assert_v2_response_create(request: &Value)
```

**Purpose**: Checks that the app server asked realtime to create a new response.

**Data flow**: It takes a JSON request and asserts it is exactly `{ "type": "response.create" }`.

**Call relations**: Tests call this after manual speech updates or steering acknowledgements, when realtime should actively respond to newly inserted content.

*Call graph*: called by 3 (realtime_automatic_handoff_output_is_item_and_append_speaks, realtime_automatic_standalone_output_is_item_and_append_speaks, webrtc_v2_background_agent_steering_ack_requests_response_create); 1 external calls (assert_eq!).


##### `assert_v1_session_update`  (lines 2740–2755)

```
fn assert_v1_session_update(request: &Value) -> Result<()>
```

**Purpose**: Checks the important fields of a v1 realtime session update.

**Data flow**: It reads fields from a JSON request and asserts the message type, v1 session type, startup context, default voice, and absence of tools.

**Call relations**: V1 WebRTC tests call this after startup to make sure the app server configured the v1 sideband session correctly.

*Call graph*: called by 3 (webrtc_v1_default_automatic_output_uses_handoff_append, webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband); 2 external calls (assert!, assert_eq!).


##### `assert_v2_session_update`  (lines 2757–2779)

```
fn assert_v2_session_update(request: &Value) -> Result<()>
```

**Purpose**: Checks the important fields of a v2 realtime session update.

**Data flow**: It reads fields from a JSON request and asserts the message type, realtime session type, startup context, expected tools, and transcription model.

**Call relations**: V2 forwarding, append-only, and steering tests call this after startup before checking later sideband messages.

*Call graph*: called by 4 (webrtc_v2_background_agent_steering_ack_requests_response_create, webrtc_v2_forwards_audio_and_text_between_client_and_sideband, webrtc_v2_text_input_is_append_only_when_response_is_cancelled, webrtc_v2_text_input_is_append_only_while_response_is_active); 2 external calls (assert!, assert_eq!).


##### `assert_call_create_multipart`  (lines 2781–2814)

```
fn assert_call_create_multipart(
    request: WiremockRequest,
    offer_sdp: &str,
    session: &str,
) -> Result<()>
```

**Purpose**: Checks the exact multipart HTTP request used to create a WebRTC realtime call.

**Data flow**: It receives a captured HTTP request, expected offer SDP, and expected session JSON. It checks URL, content type, converts the body to text, normalizes the session JSON, and compares the full multipart body.

**Call relations**: V1 WebRTC tests call this with `v1_session_create_json`. The lower-level v2 WebRTC test performs a similar direct check.

*Call graph*: calls 1 internal fn (normalized_json_string); called by 2 (webrtc_v1_handoff_request_delegates_context_and_manual_append_speaks, webrtc_v1_start_posts_offer_returns_sdp_and_joins_sideband); 2 external calls (from_utf8, assert_eq!).


##### `v1_session_create_json`  (lines 2816–2818)

```
fn v1_session_create_json() -> &'static str
```

**Purpose**: Provides the expected v1 session JSON used in WebRTC call creation.

**Data flow**: It takes no input and returns a static JSON string containing the v1 quicksilver session settings, model, voice, audio format, and instructions.

**Call relations**: V1 WebRTC tests pass this to `assert_call_create_multipart` when checking the captured call-create request.

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

**Purpose**: Writes a temporary app-server config file for tests using the default v2 realtime version and read-only sandbox.

**Data flow**: It receives the temporary Codex home path, mock server URLs, feature flag value, and startup-context setting, then delegates to the fuller config writer with default version and sandbox.

**Call relations**: Direct tests use this setup helper before starting `TestAppServer`. Harness setup uses the fuller version-aware helper directly.

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

**Purpose**: Writes the full temporary `config.toml` needed by realtime tests.

**Data flow**: It receives paths, mock URLs, feature flag, startup context, realtime version, and sandbox. It looks up the realtime feature key, converts enum choices to config strings, optionally writes startup context override text, and writes a TOML config file under the temporary Codex home.

**Call relations**: All direct config setup and the harness core setup use this. It is the bridge between test choices and the app server's normal configuration loader.

*Call graph*: calls 2 internal fn (config_value, config_value); called by 2 (new_with_main_loop_responses_server_and_sandbox, create_config_toml); 4 external calls (join, new, format!, write).


##### `assert_invalid_request`  (lines 2891–2895)

```
fn assert_invalid_request(error: JSONRPCError, message: String)
```

**Purpose**: Checks that a JSON-RPC error is the expected invalid-request error with no extra data.

**Data flow**: It takes the error object and expected message, then asserts the standard invalid-request code, exact message, and absent data field.

**Call relations**: The feature-flag test calls this after a realtime start request is rejected because realtime support is disabled.

*Call graph*: called by 1 (realtime_conversation_requires_feature_flag); 1 external calls (assert_eq!).
