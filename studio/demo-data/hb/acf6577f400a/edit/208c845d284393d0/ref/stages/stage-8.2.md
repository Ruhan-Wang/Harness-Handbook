# Execution and integration sidecar servers  `stage-8.2`

This stage is a set of helper servers that run beside the main app and expose its abilities through different “wire formats” and channels. Think of it as the adapter rack: one piece speaks over standard input/output, another over WebSocket, another over HTTP, and they all let outside tools reach the same core features.

The exec-server is the biggest piece. Its library root defines the public surface. The connection and transport files open JSON-RPC links, which means request-and-response messages sent as structured text, over stdio or WebSocket. The client and client transport layers then use those links to control processes, access files, track sessions, and reconnect if a remote side drops.

The Noise relay files add a secure encrypted path for remote execution. They perform the handshake, wrap messages into relay frames, and turn them back into normal JSON-RPC streams on each side. Remote registration ties this into the environment registry and key authorization.

Alongside that, the MCP runtime and clients launch and manage tool servers, either locally or in remote environments. The MCP server runs its own message loop. Separate bridges relay stdio to Unix sockets, proxy response API calls with injected auth, and run HTTP/SOCKS network proxies. Together, these sidecars let the system plug into many environments safely and consistently.

## Files in this stage

### Exec server transport foundation
These files define the exec-server crate surface and its shared JSON-RPC transport primitives used by both clients and servers.

### `exec-server/src/lib.rs`

`orchestration` · `compile-time API exposure and startup integration`

This file is the central facade for the `exec-server` crate. The first section declares the internal module graph: client and transport layers, environment management, filesystem helpers and sandboxing, local and remote process execution, Noise-based channels and relays, RPC/protocol definitions, runtime path handling, and the server runtime itself. None of those modules are implemented here, but this file determines the crate’s structure and visibility boundaries.

Its main job is the long list of `pub use` re-exports. These flatten the crate into a consumer-friendly API: connection options and client types (`ExecServerClient`, `ExecServerClientConnectOptions`), the abstract `HttpClient` capability and concrete `ReqwestHttpClient`, filesystem traits and result types from `codex_file_system`, environment identifiers and providers, process abstractions (`ExecBackend`, `ExecProcess`, event receiver types), protocol request/response structs for exec, filesystem, HTTP, initialization, signaling, and stream I/O, plus remote-environment configuration and top-level runners like `run_remote_environment`, `run_fs_helper_main`, and `run_main`.

The design choice here is deliberate API curation. External code can depend on `exec-server` without knowing which submodule owns a type, while internal modules remain separately organized. This file is therefore the stable import surface and the place where crate-level boundaries are enforced.


### `exec-server/src/connection.rs`

`io_transport` · `request handling / transport lifetime`

This file defines the concrete mechanics for moving `codex_app_server_protocol::JSONRPCMessage` values between async transports and the rest of the server. `JsonRpcConnection` exposes an `mpsc::Sender<JSONRPCMessage>` for outbound traffic, an `mpsc::Receiver<JsonRpcConnectionEvent>` for inbound parsed messages and protocol errors, and a `watch::Receiver<bool>` that flips when the transport is considered disconnected. Construction splits by transport type: `from_stdio` spawns separate reader and writer tasks around `BufReader::lines()` and `BufWriter`, treating each non-empty line as one JSON-RPC frame; `from_websocket_stream` runs a single `tokio::select!` loop that multiplexes outbound sends, optional periodic ping keepalives, and inbound WebSocket frames.

The file is careful about failure semantics. Parse failures do not tear down the connection; they emit `MalformedMessage` and continue. EOF, read errors, and write errors emit `Disconnected` and set the watch channel. WebSocket ping/pong and other non-data frames are ignored, while close frames become clean disconnects. Serialization is centralized so stdio and WebSocket paths produce identical JSON text.

For stdio transports associated with a spawned child process, `JsonRpcTransport::Stdio` wraps a reference-counted termination handle. Dropping the last handle or calling `terminate()` sends a one-shot watch signal to a supervisor task, which first attempts graceful process-group termination, waits up to `STDIO_TERMINATION_GRACE_PERIOD`, then force-kills the process tree if needed. Platform-specific behavior is explicit: Unix uses `codex_utils_pty::process_group`, Windows shells out to `taskkill`, and unsupported platforms fall back to killing only the direct child. Tests cover keepalive pings, ignored pong frames, close handling, binary JSON-RPC frames, and backpressure behavior with a custom controllable WebSocket sink/stream.

#### Function details

##### `JsonRpcTransport::from_child_process`  (lines 53–57)

```
fn from_child_process(child_process: Child) -> Self
```

**Purpose**: Wraps a spawned `tokio::process::Child` in the stdio transport variant so the connection can later terminate the associated process tree.

**Data flow**: Takes ownership of a `Child` → constructs `JsonRpcTransport::Stdio` with a freshly spawned `StdioTransport` supervisor → returns the transport enum value without mutating external state.

**Call relations**: Used only when `JsonRpcConnection::with_child_process` upgrades an already-created connection to track a backing subprocess; it delegates child supervision setup to `StdioTransport::spawn`.

*Call graph*: calls 1 internal fn (spawn); called by 1 (with_child_process).


##### `JsonRpcTransport::terminate`  (lines 59–64)

```
fn terminate(&self)
```

**Purpose**: Requests shutdown of any transport-owned subprocess, if this connection is stdio-backed by a child process.

**Data flow**: Reads the enum variant of `self` → does nothing for `Plain`, or forwards to the embedded `StdioTransport` for `Stdio` → returns `()` and may trigger asynchronous child termination through the watch channel.

**Call relations**: Reached indirectly when the stdio transport handle is dropped; it is the enum-level dispatch point before process-specific termination logic runs.

*Call graph*: called by 1 (drop).


##### `StdioTransport::spawn`  (lines 78–86)

```
fn spawn(child_process: Child) -> Self
```

**Purpose**: Creates the shared termination handle for a stdio child process and launches the background supervisor task that watches process exit or explicit termination requests.

**Data flow**: Consumes a `Child` → creates a `watch` channel carrying a boolean termination flag and an `Arc<StdioTransportHandle>` with an `AtomicBool` guard → starts `spawn_stdio_child_supervisor` with the child and receiver → returns a clonable `StdioTransport` holding the shared handle.

**Call relations**: Called from `JsonRpcTransport::from_child_process` during connection augmentation; it delegates all actual waiting and kill/terminate behavior to the supervisor task.

*Call graph*: calls 1 internal fn (spawn_stdio_child_supervisor); called by 1 (from_child_process); 3 external calls (new, new, channel).


##### `StdioTransport::terminate`  (lines 88–90)

```
fn terminate(&self)
```

**Purpose**: Forwards a termination request to the shared stdio transport handle.

**Data flow**: Reads `self.handle` → invokes the handle’s termination method → returns `()` while the actual process shutdown proceeds asynchronously.

**Call relations**: Used by `JsonRpcTransport::terminate` as the concrete implementation for stdio-backed transports.


##### `StdioTransportHandle::terminate`  (lines 94–98)

```
fn terminate(&self)
```

**Purpose**: Sends the termination signal exactly once, even if multiple clones or drops race to request shutdown.

**Data flow**: Reads and atomically swaps `terminate_requested` from `false` to `true` → on the first caller, sends `true` on `terminate_tx`; later callers do nothing → returns `()`.

**Call relations**: Invoked both by explicit transport termination and by `Drop` on the handle; the atomic guard prevents duplicate watch sends.

*Call graph*: called by 1 (drop); 2 external calls (swap, send).


##### `StdioTransportHandle::drop`  (lines 102–104)

```
fn drop(&mut self)
```

**Purpose**: Ensures that losing the last stdio transport handle still requests child termination.

**Data flow**: Runs during handle destruction → calls `terminate()` → returns after best-effort signaling.

**Call relations**: This is the cleanup hook that causes `JsonRpcTransport::terminate` behavior to happen automatically on handle teardown.

*Call graph*: calls 1 internal fn (terminate).


##### `spawn_stdio_child_supervisor`  (lines 107–120)

```
fn spawn_stdio_child_supervisor(mut child_process: Child, mut terminate_rx: watch::Receiver<bool>)
```

**Purpose**: Starts the detached async task that owns child-process waiting and termination escalation for stdio-backed connections.

**Data flow**: Takes a mutable `Child` and a `watch::Receiver<bool>` → captures the child PID/process-group id → spawns a task that `select!`s between natural child exit and a termination request → on exit logs wait errors and force-kills the tree; on termination request performs graceful shutdown with escalation.

**Call relations**: Created by `StdioTransport::spawn`; it delegates waiting for the watch signal to `wait_for_stdio_termination` and shutdown sequencing to `terminate_stdio_child`.

*Call graph*: called by 1 (spawn); 3 external calls (id, select!, spawn).


##### `wait_for_stdio_termination`  (lines 122–131)

```
async fn wait_for_stdio_termination(terminate_rx: &mut watch::Receiver<bool>)
```

**Purpose**: Blocks until the stdio transport’s watch channel indicates termination or the sender disappears.

**Data flow**: Mutably borrows a `watch::Receiver<bool>` → loops checking the current borrowed value and awaiting `changed()` → returns once the flag is true or the channel closes.

**Call relations**: Used only inside the stdio child supervisor’s `select!` branch to represent the explicit-termination side of the race.

*Call graph*: 2 external calls (borrow, changed).


##### `terminate_stdio_child`  (lines 133–144)

```
async fn terminate_stdio_child(child_process: &mut Child, process_group_id: Option<u32>)
```

**Purpose**: Attempts graceful process-tree termination, waits for exit for a bounded grace period, then escalates to force-kill if the child does not stop in time.

**Data flow**: Receives mutable access to the `Child` and optional process-group id → calls `terminate_process_tree` first → waits on `child_process.wait()` under `tokio::time::timeout` → logs the wait result on success, or force-kills via `kill_process_tree` and waits/logs again on timeout.

**Call relations**: Called by the stdio supervisor when a termination request wins the `select!`; it orchestrates the graceful-then-forceful shutdown path.

*Call graph*: calls 3 internal fn (kill_process_tree, log_stdio_child_wait_result, terminate_process_tree); 2 external calls (wait, timeout).


##### `terminate_process_tree`  (lines 146–168)

```
fn terminate_process_tree(child_process: &mut Child, process_group_id: Option<u32>)
```

**Purpose**: Sends a graceful termination signal to the child process group when possible, with platform-specific fallbacks.

**Data flow**: Takes mutable child access plus optional process-group id → if no group id exists, directly kills the child with the semantic action label `terminate`; otherwise uses Unix process-group termination, Windows `taskkill`, or direct-child fallback → returns `()` after best-effort signaling.

**Call relations**: Used only by `terminate_stdio_child` before the grace-period wait; it delegates direct-child fallback to `kill_direct_child` and Windows tree handling to `kill_windows_process_tree`.

*Call graph*: calls 3 internal fn (kill_direct_child, kill_windows_process_tree, terminate_process_group); called by 1 (terminate_stdio_child); 1 external calls (warn!).


##### `kill_process_tree`  (lines 170–191)

```
fn kill_process_tree(child_process: &mut Child, process_group_id: Option<u32>)
```

**Purpose**: Forcefully kills the child process group or direct child after graceful termination fails or after the child exits unexpectedly.

**Data flow**: Takes mutable child access plus optional process-group id → if no group id exists, directly kills the child with action label `kill`; otherwise uses Unix process-group kill, Windows `taskkill`, or direct-child fallback → returns `()`.

**Call relations**: Called from `terminate_stdio_child` after grace-period timeout and from the supervisor branch that handles natural child exit; it is the hard-stop counterpart to `terminate_process_tree`.

*Call graph*: calls 3 internal fn (kill_direct_child, kill_windows_process_tree, kill_process_group); called by 1 (terminate_stdio_child); 1 external calls (warn!).


##### `kill_direct_child`  (lines 193–197)

```
fn kill_direct_child(child_process: &mut Child, action: &str)
```

**Purpose**: Issues `start_kill()` against the direct child process and logs debug output if that fails.

**Data flow**: Consumes mutable `Child` access and an action label string → calls `start_kill()` → on error emits a debug log mentioning the requested action → returns `()`.

**Call relations**: Used as the fallback path by both process-tree termination helpers when group-level termination is unavailable or fails.

*Call graph*: called by 2 (kill_process_tree, terminate_process_tree); 2 external calls (start_kill, debug!).


##### `kill_windows_process_tree`  (lines 200–215)

```
fn kill_windows_process_tree(pid: u32) -> bool
```

**Purpose**: Uses the Windows `taskkill` utility to terminate an entire process tree rooted at the given PID.

**Data flow**: Converts the `u32` PID to a string → runs `taskkill /PID <pid> /T /F` with stdio redirected to null → returns `true` on successful exit status, otherwise logs a warning and returns `false`.

**Call relations**: Called by both `terminate_process_tree` and `kill_process_tree` on Windows to avoid leaving descendant processes behind.

*Call graph*: called by 2 (kill_process_tree, terminate_process_tree); 3 external calls (null, new, warn!).


##### `log_stdio_child_wait_result`  (lines 217–221)

```
fn log_stdio_child_wait_result(result: std::io::Result<std::process::ExitStatus>)
```

**Purpose**: Suppresses successful child wait results and logs only wait failures at debug level.

**Data flow**: Accepts `std::io::Result<ExitStatus>` from `Child::wait()` → if it is `Err`, logs the error → otherwise produces no output and returns `()`.

**Call relations**: Used by `terminate_stdio_child` and the stdio supervisor’s natural-exit branch to centralize wait-error logging.

*Call graph*: called by 1 (terminate_stdio_child); 1 external calls (debug!).


##### `JsonRpcConnection::from_stdio`  (lines 232–321)

```
fn from_stdio(reader: R, writer: W, connection_label: String) -> Self
```

**Purpose**: Builds a JSON-RPC connection over newline-delimited stdio streams by spawning separate reader and writer tasks around generic async reader/writer halves.

**Data flow**: Takes an async reader, async writer, and a human-readable connection label → creates bounded outgoing/incoming `mpsc` channels and a `watch` disconnect flag → reader task reads lines, skips blank lines, deserializes `JSONRPCMessage`, emits `Message` or `MalformedMessage`, and emits `Disconnected` on EOF/read error; writer task receives outbound messages, serializes each to one JSON line, flushes it, and emits `Disconnected` on write failure → returns `JsonRpcConnection` with both task handles and `JsonRpcTransport::Plain`.

**Call relations**: Used by stdio connection setup elsewhere in the server and in tests; internally it delegates disconnect signaling to `send_disconnected`, parse-failure reporting to `send_malformed_message`, and line encoding to `write_jsonrpc_line_message`.

*Call graph*: calls 3 internal fn (send_disconnected, send_malformed_message, write_jsonrpc_line_message); called by 7 (process_events_are_delivered_in_seq_order_when_notifications_are_reordered, transport_disconnect_fails_sessions_and_rejects_new_sessions, wake_notifications_do_not_block_other_sessions, connect_stdio_command, rpc_client_matches_out_of_order_responses_by_request_id, spawn_test_connection, run_stdio_connection_with_io); 8 external calls (new, new, Message, format!, channel, spawn, vec!, channel).


##### `JsonRpcConnection::from_websocket`  (lines 323–328)

```
fn from_websocket(stream: WebSocketStream<S>, connection_label: String) -> Self
```

**Purpose**: Constructs a JSON-RPC connection over a tungstenite `WebSocketStream` without periodic keepalive pings.

**Data flow**: Consumes a `WebSocketStream<S>` and connection label → forwards both to `from_websocket_stream` with `ping_interval` set to `None` → returns the resulting `JsonRpcConnection`.

**Call relations**: This is the normal WebSocket constructor used by production callers and several tests; it is a thin wrapper over the generic stream implementation.

*Call graph*: called by 4 (connect_websocket, websocket_connection_accepts_binary_jsonrpc_message, websocket_connection_ignores_server_pong, websocket_connection_reports_server_close); 1 external calls (from_websocket_stream).


##### `JsonRpcConnection::from_axum_websocket`  (lines 330–332)

```
fn from_axum_websocket(stream: AxumWebSocket, connection_label: String) -> Self
```

**Purpose**: Constructs a JSON-RPC connection over Axum’s WebSocket type and enables periodic ping keepalives.

**Data flow**: Consumes an `AxumWebSocket` and connection label → forwards them to `from_websocket_stream` with `Some(WEBSOCKET_KEEPALIVE_INTERVAL)` → returns the resulting connection.

**Call relations**: Used for Axum-served WebSocket endpoints so idle browser/server connections receive keepalive pings.

*Call graph*: 1 external calls (from_websocket_stream).


##### `JsonRpcConnection::from_websocket_stream`  (lines 334–458)

```
fn from_websocket_stream(
        mut websocket: T,
        connection_label: String,
        ping_interval: Option<Duration>,
    ) -> Self
```

**Purpose**: Implements the generic WebSocket JSON-RPC event loop for any sink/stream pair whose message type can parse and emit JSON-RPC frames.

**Data flow**: Takes a bidirectional WebSocket-like object, a connection label, and optional ping interval → creates outgoing/incoming/disconnect channels → spawns one task that optionally initializes a Tokio interval and then loops in `tokio::select!` over outbound queue receives, ping ticks, and inbound frames. Outbound messages are serialized and sent as text frames; ping ticks send empty ping frames; inbound frames are parsed into `Message`, `Close`, or `Ignore`, producing `JsonRpcConnectionEvent::Message`, `Disconnected`, or no event. Read/write/serialization failures become `Disconnected`; malformed JSON frames become `MalformedMessage` without closing the loop. Returns a `JsonRpcConnection` with one task handle and plain transport.

**Call relations**: Called by both WebSocket constructors and by tests using a custom controlled stream; it delegates frame parsing to the `JsonRpcWebSocketMessage` trait and outbound serialization/sending to `send_websocket_jsonrpc_message`.

*Call graph*: called by 2 (websocket_connection_keeps_outbound_message_while_send_is_backpressured, websocket_connection_sends_configured_ping); 5 external calls (channel, select!, spawn, vec!, channel).


##### `JsonRpcConnection::with_child_process`  (lines 460–463)

```
fn with_child_process(mut self, child_process: Child) -> Self
```

**Purpose**: Associates an existing connection with a spawned child process so dropping or terminating the connection also supervises that subprocess.

**Data flow**: Takes ownership of `self` and a `Child` → replaces `self.transport` with `JsonRpcTransport::from_child_process(child_process)` → returns the modified connection.

**Call relations**: Used after constructing a stdio connection when the underlying reader/writer came from a child process; it is the only caller of `JsonRpcTransport::from_child_process`.

*Call graph*: calls 1 internal fn (from_child_process).


##### `Message::parse_jsonrpc_frame`  (lines 479–492)

```
fn parse_jsonrpc_frame(self) -> Result<JsonRpcWebSocketFrame, serde_json::Error>
```

**Purpose**: Interprets tungstenite WebSocket frames as either JSON-RPC payloads, close notifications, or ignorable control frames.

**Data flow**: Consumes a `tokio_tungstenite::tungstenite::Message` → deserializes text and binary payloads into `JSONRPCMessage`, maps close frames to `JsonRpcWebSocketFrame::Close`, and maps ping/pong/raw frame variants to `Ignore` → returns either a parsed frame enum or a `serde_json::Error`.

**Call relations**: Used by the generic WebSocket connection loop through the `JsonRpcWebSocketMessage` trait to normalize tungstenite-specific frame types.

*Call graph*: 2 external calls (from_slice, from_str).


##### `Message::from_text`  (lines 494–496)

```
fn from_text(text: String) -> Self
```

**Purpose**: Builds a tungstenite text frame from serialized JSON-RPC text.

**Data flow**: Takes a `String` → wraps it in `Message::Text` → returns the frame value.

**Call relations**: Called by `send_websocket_jsonrpc_message` through the trait abstraction when sending outbound JSON-RPC over tungstenite.

*Call graph*: 1 external calls (Text).


##### `Message::ping`  (lines 498–500)

```
fn ping() -> Self
```

**Purpose**: Builds an empty tungstenite ping frame for keepalive traffic.

**Data flow**: Creates an empty byte vector and wraps it in `Message::Ping` → returns the ping frame.

**Call relations**: Used by the WebSocket event loop when a configured ping interval ticks.

*Call graph*: 2 external calls (Ping, new).


##### `AxumWebSocketMessage::parse_jsonrpc_frame`  (lines 504–517)

```
fn parse_jsonrpc_frame(self) -> Result<JsonRpcWebSocketFrame, serde_json::Error>
```

**Purpose**: Interprets Axum WebSocket frames as JSON-RPC messages, close notifications, or ignorable control frames.

**Data flow**: Consumes an `axum::extract::ws::Message` → deserializes text and binary payloads into `JSONRPCMessage`, maps close frames to `Close`, and ping/pong frames to `Ignore` → returns a `JsonRpcWebSocketFrame` or parse error.

**Call relations**: Used by the generic WebSocket connection loop when the underlying stream is Axum’s WebSocket type.

*Call graph*: 2 external calls (from_slice, from_str).


##### `AxumWebSocketMessage::from_text`  (lines 519–521)

```
fn from_text(text: String) -> Self
```

**Purpose**: Builds an Axum text frame from serialized JSON-RPC text.

**Data flow**: Takes a `String` → wraps it in `AxumWebSocketMessage::Text` → returns the frame.

**Call relations**: Called indirectly by `send_websocket_jsonrpc_message` for Axum-backed connections.

*Call graph*: 1 external calls (Text).


##### `AxumWebSocketMessage::ping`  (lines 523–525)

```
fn ping() -> Self
```

**Purpose**: Builds an empty Axum ping frame for keepalive traffic.

**Data flow**: Creates an empty payload and wraps it in `AxumWebSocketMessage::Ping` → returns the frame.

**Call relations**: Used by the generic WebSocket loop when Axum connections are configured with keepalive pings.

*Call graph*: 2 external calls (Ping, new).


##### `send_disconnected`  (lines 528–537)

```
async fn send_disconnected(
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    disconnected_tx: &watch::Sender<bool>,
    reason: Option<String>,
)
```

**Purpose**: Marks a connection as disconnected and emits a terminal `Disconnected` event with an optional reason string.

**Data flow**: Takes references to the incoming-event sender and disconnect watch sender plus an optional reason → sends `true` on the watch channel, then asynchronously sends `JsonRpcConnectionEvent::Disconnected { reason }` on the incoming queue, ignoring send failures → returns `()`.

**Call relations**: Called from both stdio and WebSocket connection loops whenever EOF, close, read failure, or write failure should terminate the connection.

*Call graph*: called by 1 (from_stdio); 1 external calls (send).


##### `send_malformed_message`  (lines 539–548)

```
async fn send_malformed_message(
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    reason: Option<String>,
)
```

**Purpose**: Reports a parse failure to connection consumers without disconnecting the transport.

**Data flow**: Takes the incoming-event sender and an optional reason → constructs `JsonRpcConnectionEvent::MalformedMessage` using the provided reason or a default message → sends it asynchronously, ignoring send failure → returns `()`.

**Call relations**: Used by stdio and WebSocket readers when a frame cannot be parsed as `JSONRPCMessage` but the transport itself remains usable.

*Call graph*: called by 1 (from_stdio); 1 external calls (send).


##### `write_jsonrpc_line_message`  (lines 550–562)

```
async fn write_jsonrpc_line_message(
    writer: &mut BufWriter<W>,
    message: &JSONRPCMessage,
) -> std::io::Result<()>
```

**Purpose**: Serializes one JSON-RPC message as UTF-8 JSON followed by a newline and flushes it to a buffered stdio writer.

**Data flow**: Takes a mutable `BufWriter<W>` and a `&JSONRPCMessage` → serializes via `serialize_jsonrpc_message`, converts serialization failure into `std::io::Error::other`, writes the bytes, writes `\n`, flushes, and returns the resulting `io::Result<()>`.

**Call relations**: Called by the stdio writer task inside `JsonRpcConnection::from_stdio` for every outbound message.

*Call graph*: calls 1 internal fn (serialize_jsonrpc_message); called by 1 (from_stdio); 2 external calls (flush, write_all).


##### `send_websocket_jsonrpc_message`  (lines 564–585)

```
async fn send_websocket_jsonrpc_message(
    websocket_writer: &mut W,
    connection_label: &str,
    message: &JSONRPCMessage,
) -> Result<(), String>
```

**Purpose**: Serializes a JSON-RPC message and sends it as a text WebSocket frame, returning a human-readable error string on failure.

**Data flow**: Takes a mutable sink, connection label, and `&JSONRPCMessage` → serializes to JSON text, converts it to the transport-specific text frame type, sends it through the sink, and maps either serialization or sink errors into descriptive `String` values → returns `Result<(), String>`.

**Call relations**: Used by the generic WebSocket event loop for outbound traffic so disconnect reasons include the connection label and whether serialization or transport send failed.

*Call graph*: calls 1 internal fn (serialize_jsonrpc_message); 3 external calls (from_text, send, format!).


##### `serialize_jsonrpc_message`  (lines 587–589)

```
fn serialize_jsonrpc_message(message: &JSONRPCMessage) -> Result<String, serde_json::Error>
```

**Purpose**: Provides the shared JSON serialization step for outbound JSON-RPC messages.

**Data flow**: Takes `&JSONRPCMessage` → calls `serde_json::to_string` → returns `Result<String, serde_json::Error>`.

**Call relations**: Called by both stdio and WebSocket send helpers to keep outbound encoding consistent.

*Call graph*: called by 2 (send_websocket_jsonrpc_message, write_jsonrpc_line_message); 1 external calls (to_string).


##### `tests::websocket_connection_sends_configured_ping`  (lines 612–627)

```
async fn websocket_connection_sends_configured_ping() -> anyhow::Result<()>
```

**Purpose**: Verifies that a WebSocket connection configured with a ping interval emits a ping frame without requiring application traffic.

**Data flow**: Creates a client/server WebSocket pair, builds a connection with keepalive enabled, waits up to one second for the server side to receive a frame, and asserts that it is `Message::Ping(_)`.

**Call relations**: Exercises `JsonRpcConnection::from_websocket_stream` with a real socket pair to validate the ping branch of its `select!` loop.

*Call graph*: calls 1 internal fn (from_websocket_stream); 4 external calls (from_secs, assert!, websocket_pair, timeout).


##### `tests::websocket_connection_ignores_server_pong`  (lines 630–645)

```
async fn websocket_connection_ignores_server_pong() -> anyhow::Result<()>
```

**Purpose**: Checks that inbound pong frames do not surface as connection events.

**Data flow**: Creates a WebSocket pair and connection, sends a `Pong` frame from the server side, then asserts that `incoming_rx.recv()` times out rather than yielding an event.

**Call relations**: Targets the `Ignore` branch produced by `Message::parse_jsonrpc_frame` and consumed by the WebSocket loop.

*Call graph*: calls 1 internal fn (from_websocket); 3 external calls (assert!, websocket_pair, Pong).


##### `tests::websocket_connection_reports_server_close`  (lines 648–660)

```
async fn websocket_connection_reports_server_close() -> anyhow::Result<()>
```

**Purpose**: Confirms that a remote WebSocket close frame becomes a clean disconnect event with no reason string.

**Data flow**: Creates a WebSocket pair and connection, closes the server socket, awaits one incoming event, and asserts it matches `Disconnected { reason: None }`.

**Call relations**: Exercises the close-frame path in `from_websocket_stream`.

*Call graph*: calls 1 internal fn (from_websocket); 2 external calls (assert!, websocket_pair).


##### `tests::websocket_connection_accepts_binary_jsonrpc_message`  (lines 663–683)

```
async fn websocket_connection_accepts_binary_jsonrpc_message() -> anyhow::Result<()>
```

**Purpose**: Ensures binary WebSocket frames containing JSON bytes are accepted and decoded as JSON-RPC messages.

**Data flow**: Builds a test `JSONRPCMessage::Request`, sends its serialized bytes as `Message::Binary` from the server side, then asserts the connection emits the same message value.

**Call relations**: Validates the binary branch of `Message::parse_jsonrpc_frame` and the message-delivery path in the WebSocket loop.

*Call graph*: calls 1 internal fn (from_websocket); 6 external calls (Request, Integer, assert!, websocket_pair, to_vec, Binary).


##### `tests::websocket_connection_keeps_outbound_message_while_send_is_backpressured`  (lines 686–713)

```
async fn websocket_connection_keeps_outbound_message_while_send_is_backpressured() -> anyhow::Result<()>
```

**Purpose**: Checks that an outbound JSON-RPC message remains queued while the WebSocket sink is not ready, and that unrelated inbound control frames still do not leak through as events.

**Data flow**: Creates a `ControlledWebSocket` with writes initially blocked, sends one outbound JSON-RPC message into `outgoing_tx`, waits until the sink reports blocked, injects an inbound pong and confirms no event is emitted, then marks the sink writable and asserts the queued outbound text frame eventually appears on the captured outbound receiver.

**Call relations**: Exercises `from_websocket_stream` under sink backpressure using the custom test transport.

*Call graph*: calls 1 internal fn (from_websocket_stream); 4 external calls (assert!, new, test_jsonrpc_message, Pong).


##### `tests::websocket_pair`  (lines 715–728)

```
async fn websocket_pair() -> anyhow::Result<(
        WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WebSocketStream<tokio::net::TcpStream>,
    )>
```

**Purpose**: Creates a real client/server WebSocket pair bound to a temporary localhost TCP listener for integration-style transport tests.

**Data flow**: Binds a `TcpListener` on `127.0.0.1:0`, spawns a server accept-and-upgrade task, connects a client with `connect_async`, awaits the accepted server WebSocket, and returns both streams.

**Call relations**: Shared helper for the WebSocket tests above so they exercise actual tungstenite streams.

*Call graph*: 5 external calls (bind, format!, spawn, accept_async, connect_async).


##### `tests::test_jsonrpc_message`  (lines 730–737)

```
fn test_jsonrpc_message() -> JSONRPCMessage
```

**Purpose**: Builds a small deterministic JSON-RPC request used by transport tests.

**Data flow**: Constructs and returns `JSONRPCMessage::Request` with integer id `1`, method `test`, and no params or trace.

**Call relations**: Used by the backpressure test to compare outbound serialization results.

*Call graph*: 2 external calls (Request, Integer).


##### `tests::ControlledWebSocket::new`  (lines 757–788)

```
fn new(
            write_ready: bool,
        ) -> (
            Self,
            ControlledWebSocketHandle,
            futures_mpsc::UnboundedReceiver<Message>,
        )
```

**Purpose**: Constructs a fully in-memory test WebSocket plus a control handle and outbound capture stream for deterministic backpressure testing.

**Data flow**: Creates unbounded inbound and outbound futures channels, shared `AtomicBool` flags for write readiness and blocked state, and `AtomicWaker`s for coordination → returns `(ControlledWebSocket, ControlledWebSocketHandle, outbound_rx)`.

**Call relations**: Used only by the backpressure test to stand in for a real sink/stream while exposing readiness controls.

*Call graph*: 5 external calls (clone, new, new, new, unbounded).


##### `tests::ControlledWebSocketHandle::send_inbound`  (lines 792–796)

```
fn send_inbound(&self, message: Message) -> anyhow::Result<()>
```

**Purpose**: Injects an inbound WebSocket message into the controlled test transport.

**Data flow**: Takes a `Message` → sends `Ok(message)` into the controlled inbound channel → returns `anyhow::Result<()>` based on channel send success.

**Call relations**: Used by the backpressure test to simulate server-originated frames while the outbound side is blocked.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocketHandle::set_write_ready`  (lines 798–801)

```
fn set_write_ready(&self)
```

**Purpose**: Marks the controlled sink as writable and wakes any task waiting in `poll_ready`.

**Data flow**: Stores `true` into the shared `write_ready` flag and wakes the registered write waker → returns `()`.

**Call relations**: Used by the backpressure test to release the blocked outbound send path.


##### `tests::ControlledWebSocketHandle::wait_for_blocked_write`  (lines 803–817)

```
async fn wait_for_blocked_write(&self) -> anyhow::Result<()>
```

**Purpose**: Waits until the controlled sink has observed a blocked write attempt.

**Data flow**: Polls the shared `write_blocked` flag via `futures::future::poll_fn`, registering the blocked-write waker until it becomes true, and wraps the wait in a one-second timeout → returns `anyhow::Result<()>`.

**Call relations**: Used by the backpressure test to ensure the connection task has actually reached sink backpressure before injecting other frames.

*Call graph*: 3 external calls (from_secs, poll_fn, timeout).


##### `tests::ControlledWebSocket::poll_ready`  (lines 823–832)

```
fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements sink readiness for the controlled test transport, either allowing sends immediately or recording/waking blocked state.

**Data flow**: Reads the shared `write_ready` flag → returns `Poll::Ready(Ok(()))` when writable; otherwise sets `write_blocked = true`, wakes the blocked-write waiter, registers the caller’s waker for later, and returns `Poll::Pending`.

**Call relations**: Called by the futures sink machinery when `from_websocket_stream` tries to send an outbound frame.

*Call graph*: 2 external calls (waker, Ready).


##### `tests::ControlledWebSocket::start_send`  (lines 834–839)

```
fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error>
```

**Purpose**: Captures outbound frames sent through the controlled sink.

**Data flow**: Takes a `Message` item and forwards it into the unbounded outbound channel, panicking if the receiver has been dropped → returns `Ok(())`.

**Call relations**: Used by the sink implementation after `poll_ready` succeeds so tests can inspect what the connection attempted to send.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocket::poll_flush`  (lines 841–846)

```
fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements a no-op flush for the controlled sink.

**Data flow**: Ignores its context and returns `Poll::Ready(Ok(()))` immediately.

**Call relations**: Part of the sink contract needed for `SinkExt::send` in the connection loop.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_close`  (lines 848–853)

```
fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements a no-op close for the controlled sink.

**Data flow**: Ignores its context and returns `Poll::Ready(Ok(()))` immediately.

**Call relations**: Completes the sink implementation for the controlled test transport.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_next`  (lines 859–861)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements stream polling by forwarding to the controlled inbound receiver.

**Data flow**: Pins and polls `self.inbound_rx` → returns the next queued inbound `Result<Message, Infallible>` or stream termination.

**Call relations**: Used by `from_websocket_stream` as the inbound side of the custom test transport.

*Call graph*: 1 external calls (new).


### `exec-server/src/client.rs`

`orchestration` · `connection setup, request dispatch, notification handling, and disconnect recovery`

This file is the main orchestration layer between higher-level callers and an exec-server transport. `ExecServerClient` wraps an `Arc<Inner>` containing the `RpcClient`, process-session routing tables, HTTP body-stream routing tables, a disconnect latch, the negotiated session id, and a background reader task. `LazyRemoteExecServerClient` adds transport-aware caching and reconnection: it reuses a healthy client, reconnects after disconnect for websocket/noise transports, and serializes connection attempts with a `Semaphore`.

The client exposes thin RPC wrappers for process execution (`exec`, `read`, `write`, `signal`, `terminate`), environment info, and filesystem methods. All of them funnel through `ExecServerClient::call`, which first rejects work if `Inner.disconnected` is set, then maps JSON-RPC failures into `ExecServerError`, canonicalizing transport-closed races into a sticky disconnected state.

Process notifications are not treated as the source of truth for reads, but they do drive wakeups and streaming subscribers. `SessionState` stores an `ExecProcessEventLog`, a watch channel for wake notifications, an ordered-event buffer keyed by sequence number, and an optional terminal failure. `publish_ordered_event` reorders out-of-order output/exited/closed notifications so subscribers always observe monotonic sequence delivery; only once `Closed` is actually published does the client remove the session route. On transport failure, `record_disconnected`, `fail_all_sessions`, and `fail_all_in_flight_work` synthesize terminal failures for both process sessions and streamed HTTP bodies so callers do not hang indefinitely.

The embedded tests cover stdio/websocket initialization, child-process cleanup, malformed server behavior, notification reordering, disconnect semantics, lazy websocket replacement, and fairness of wake notifications across noisy and quiet sessions.

#### Function details

##### `ExecServerClientConnectOptions::default`  (lines 108–114)

```
fn default() -> Self
```

**Purpose**: Provides the standard client initialization settings used when no explicit options are supplied. It defaults the client name to `codex-core`, uses the file-level initialize timeout constant, and does not request session resumption.

**Data flow**: It constructs and returns a new `ExecServerClientConnectOptions` with `client_name`, `initialize_timeout`, and `resume_session_id: None`. It reads only compile-time constants and writes no external state.

**Call relations**: This default is used by tests and any callers that want a baseline initialize handshake without custom naming or resume behavior. It feeds directly into `ExecServerClient::connect` and then `ExecServerClient::initialize`.


##### `ExecServerClientConnectOptions::from`  (lines 128–134)

```
fn from(value: StdioExecServerConnectArgs) -> Self
```

**Purpose**: Converts remote websocket connection arguments into the narrower initialize-only option set. It strips transport-specific fields while preserving handshake identity and resume intent.

**Data flow**: It takes `RemoteExecServerConnectArgs`, moves out `client_name`, `initialize_timeout`, and `resume_session_id`, and returns an `ExecServerClientConnectOptions`. Transport fields like URL and connect timeout are discarded.

**Call relations**: This conversion is used when transport-opening code has already handled the websocket connection and needs to pass only initialize parameters into `ExecServerClient::connect`. It is part of the handoff from transport setup to common JSON-RPC initialization.


##### `RemoteExecServerConnectArgs::new`  (lines 138–146)

```
fn new(websocket_url: String, client_name: String) -> Self
```

**Purpose**: Builds a websocket connection argument bundle with standard connect and initialize timeouts. It is a convenience constructor for callers that only know the URL and desired client name.

**Data flow**: It accepts a websocket URL and client name, then returns `RemoteExecServerConnectArgs` populated with those values plus `CONNECT_TIMEOUT`, `INITIALIZE_TIMEOUT`, and `resume_session_id: None`. No external state is read or modified.

**Call relations**: Callers use it before invoking websocket transport connection paths. The resulting struct can later be converted into `ExecServerClientConnectOptions` once the transport itself is established.


##### `Inner::drop`  (lines 200–202)

```
fn drop(&mut self)
```

**Purpose**: Stops the background notification reader task when the last client reference is dropped. This prevents the task from outliving the client state it routes into.

**Data flow**: On drop it calls `abort()` on `self.reader_task`. It consumes no inputs beyond `self` and writes no state except cancelling the spawned task.

**Call relations**: This runs automatically when the `Arc<Inner>` is torn down, typically after all `ExecServerClient` clones are dropped. It is the cleanup counterpart to the reader task created in `ExecServerClient::connect`.

*Call graph*: 1 external calls (abort).


##### `LazyRemoteExecServerClient::new`  (lines 218–224)

```
fn new(transport_params: ExecServerTransportParams) -> Self
```

**Purpose**: Creates a lazily connecting remote client wrapper around transport parameters. The wrapper starts disconnected and will establish the underlying `ExecServerClient` on first use.

**Data flow**: It stores the provided `ExecServerTransportParams`, initializes the cached client slot to `None` inside a `StdMutex`, and creates a one-permit `Semaphore` used to serialize connection attempts. It returns the assembled `LazyRemoteExecServerClient`.

**Call relations**: Higher-level remote execution code and tests construct this wrapper instead of eagerly connecting. Subsequent calls to `get`, `http_request`, `http_request_stream`, or `environment_info` trigger the actual connection path.

*Call graph*: called by 3 (remote_websocket_client_replaces_disconnected_client_with_fresh_session, remote_with_transport, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 3 external calls (new, new, new).


##### `LazyRemoteExecServerClient::get`  (lines 226–258)

```
async fn get(&self) -> Result<ExecServerClient, ExecServerError>
```

**Purpose**: Returns a usable `ExecServerClient`, reusing a healthy cached client or reconnecting when necessary. It also prevents duplicate concurrent reconnects.

**Data flow**: It first checks `connected_client`; if absent, it acquires the semaphore permit, rechecks, then inspects `cached_client`. For websocket and noise transports, a cached-but-disconnected client is replaced by `ExecServerClient::connect_for_transport`; for stdio, an existing cached client is reused; if no client exists, it connects fresh. The chosen client is stored back into the mutex-protected cache and returned.

**Call relations**: This is the central entry point used by the lazy wrapper’s `HttpClient` methods and `environment_info`, and by many higher-level remote filesystem operations elsewhere in the crate. It delegates transport-specific connection work to `ExecServerClient::connect_for_transport` only when the cache state and transport kind require it.

*Call graph*: calls 2 internal fn (cached_client, connected_client); called by 13 (environment_info, http_request, http_request_stream, canonicalize, copy, create_directory, get_metadata, read_directory, read_file, read_file_stream (+3 more)); 3 external calls (connect_for_transport, clone, matches!).


##### `LazyRemoteExecServerClient::connected_client`  (lines 260–263)

```
fn connected_client(&self) -> Option<ExecServerClient>
```

**Purpose**: Fetches the cached client only if it is still considered connected. It filters out stale cached clients after transport loss.

**Data flow**: It calls `cached_client()`, then applies `!client.is_disconnected()` as a predicate. It returns `Some(ExecServerClient)` for a healthy cached client or `None` otherwise.

**Call relations**: Used internally by `get` before and after acquiring the connection semaphore so fast-path callers can avoid reconnect work. It depends on `ExecServerClient::is_disconnected` to interpret client health.

*Call graph*: calls 1 internal fn (cached_client); called by 1 (get).


##### `LazyRemoteExecServerClient::cached_client`  (lines 265–270)

```
fn cached_client(&self) -> Option<ExecServerClient>
```

**Purpose**: Returns the currently cached client clone regardless of connection health. It is the raw cache accessor behind the healthier `connected_client` check.

**Data flow**: It locks the internal `StdMutex<Option<ExecServerClient>>`, recovers from poisoning by taking the inner value, clones the `Option`, and returns it. No external state is changed.

**Call relations**: Only internal lazy-client methods use it, primarily `connected_client` and `get`. It separates cache retrieval from health filtering and reconnect policy.

*Call graph*: called by 2 (connected_client, get).


##### `LazyRemoteExecServerClient::http_request`  (lines 274–279)

```
fn http_request(
        &self,
        params: crate::HttpRequestParams,
    ) -> BoxFuture<'_, Result<crate::HttpRequestResponse, ExecServerError>>
```

**Purpose**: Implements the `HttpClient` trait by lazily obtaining a remote client and forwarding a buffered HTTP request through it. The method itself is just an async adapter.

**Data flow**: It takes `HttpRequestParams`, awaits `self.get()`, then calls `http_request` on the resulting `ExecServerClient`, returning the boxed future’s `HttpRequestResponse` or `ExecServerError`. It writes no local state beyond any cache updates performed by `get`.

**Call relations**: This is invoked by callers using the lazy wrapper as an `HttpClient`. It delegates connection establishment to `get` and actual request execution to the underlying client’s RPC-backed HTTP implementation.

*Call graph*: calls 1 internal fn (get).


##### `LazyRemoteExecServerClient::http_request_stream`  (lines 281–289)

```
fn http_request_stream(
        &self,
        params: crate::HttpRequestParams,
    ) -> BoxFuture<
        '_,
        Result<(crate::HttpRequestResponse, crate::HttpResponseBodyStream), ExecServerE
```

**Purpose**: Implements streamed HTTP requests for the lazy wrapper by connecting on demand and forwarding to the underlying client. It exposes the remote body as an `HttpResponseBodyStream`.

**Data flow**: It accepts `HttpRequestParams`, awaits `self.get()`, then calls `http_request_stream` on the connected `ExecServerClient`. The returned boxed future yields `(HttpRequestResponse, HttpResponseBodyStream)` or an `ExecServerError`.

**Call relations**: Like the buffered variant, this is used through the `HttpClient` trait. It relies on `get` for cache/reconnect behavior and on the underlying client’s stream registration logic for body-delta routing.

*Call graph*: calls 1 internal fn (get).


##### `LazyRemoteExecServerClient::environment_info`  (lines 293–295)

```
async fn environment_info(&self) -> Result<EnvironmentInfo, ExecServerError>
```

**Purpose**: Fetches environment metadata from the remote exec-server through a lazily connected client. It is a convenience wrapper around `get` plus the underlying RPC call.

**Data flow**: It awaits `self.get()`, then invokes `environment_info()` on the resulting `ExecServerClient`, returning an `EnvironmentInfo` or `ExecServerError`. Any cache mutation occurs inside `get`.

**Call relations**: Higher-level info/reporting code calls this when it needs environment details without caring whether the remote client is already connected. It delegates transport acquisition to `get` and the actual RPC to `ExecServerClient::environment_info`.

*Call graph*: calls 1 internal fn (get); called by 1 (info).


##### `ExecServerClient::initialize`  (lines 339–376)

```
async fn initialize(
        &self,
        options: ExecServerClientConnectOptions,
    ) -> Result<InitializeResponse, ExecServerError>
```

**Purpose**: Performs the JSON-RPC initialize handshake, stores the negotiated session id, and sends the follow-up `initialized` notification. It wraps the whole handshake in a timeout.

**Data flow**: It destructures `ExecServerClientConnectOptions`, runs a timed async block that calls the RPC client with `INITIALIZE_METHOD` and `InitializeParams { client_name, resume_session_id }`, writes `response.session_id` into `inner.session_id`, then calls `notify_initialized()` and returns the `InitializeResponse`. If the timeout elapses, it returns `ExecServerError::InitializeTimedOut`.

**Call relations**: Called from `ExecServerClient::connect` immediately after transport setup. It delegates the post-response notification to `notify_initialized`, and its stored session id is later exposed by `session_id()` and used by tests to verify handshake behavior.

*Call graph*: calls 1 internal fn (notify_initialized); 1 external calls (timeout).


##### `ExecServerClient::exec`  (lines 378–380)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, ExecServerError>
```

**Purpose**: Sends an `exec` RPC to start a process on the exec-server. It is a thin typed wrapper over the generic call path.

**Data flow**: It takes `ExecParams`, passes them to `self.call(EXEC_METHOD, &params)`, and returns the deserialized `ExecResponse` or an `ExecServerError`. No client-local state is modified beyond any disconnect latching performed by `call`.

**Call relations**: Higher-level process-launch code invokes this to create remote processes. It delegates all transport/disconnect/error handling to `ExecServerClient::call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::environment_info`  (lines 382–384)

```
async fn environment_info(&self) -> Result<EnvironmentInfo, ExecServerError>
```

**Purpose**: Requests environment metadata from the server using the dedicated protocol method. It is another typed wrapper around the shared RPC call machinery.

**Data flow**: It calls `self.call(ENVIRONMENT_INFO_METHOD, &())` and returns an `EnvironmentInfo` or `ExecServerError`. There is no local transformation beyond method selection.

**Call relations**: Used directly by callers with an eager client and indirectly by `LazyRemoteExecServerClient::environment_info`. It relies on `call` for preflight disconnect checks and error normalization.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::read`  (lines 386–388)

```
async fn read(&self, params: ReadParams) -> Result<ReadResponse, ExecServerError>
```

**Purpose**: Reads process output and lifecycle state from the server for a registered process. This is the polling counterpart to pushed process notifications.

**Data flow**: It accepts `ReadParams`, forwards them through `self.call(EXEC_READ_METHOD, &params)`, and returns a `ReadResponse` or `ExecServerError`. It does not itself synthesize failures; that logic lives in `Session::read`.

**Call relations**: Called by `Session::read` after session-level failure checks. It is the low-level RPC used when consumers poll for output rather than relying solely on pushed events.

*Call graph*: calls 1 internal fn (call); called by 1 (read).


##### `ExecServerClient::write`  (lines 390–403)

```
async fn write(
        &self,
        process_id: &ProcessId,
        chunk: Vec<u8>,
    ) -> Result<WriteResponse, ExecServerError>
```

**Purpose**: Writes a chunk of stdin data to a remote process. It packages the process id and bytes into the protocol’s `WriteParams`.

**Data flow**: It takes a `&ProcessId` and `Vec<u8>`, clones the process id into `WriteParams { process_id, chunk }`, calls `self.call(EXEC_WRITE_METHOD, &...)`, and returns the resulting `WriteResponse` or `ExecServerError`.

**Call relations**: Used by `Session::write` and any direct process I/O callers. It delegates transport and disconnect handling to `call` after constructing the typed request payload.

*Call graph*: calls 1 internal fn (call); called by 1 (write); 1 external calls (clone).


##### `ExecServerClient::signal`  (lines 405–420)

```
async fn signal(
        &self,
        process_id: &ProcessId,
        signal: ProcessSignal,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Sends a process signal request to the server and discards the protocol response body once successful. It provides a simpler `Result<(), _>` API to callers.

**Data flow**: It takes a `&ProcessId` and `ProcessSignal`, clones the process id into `SignalParams`, awaits `self.call(EXEC_SIGNAL_METHOD, &...)` as a `SignalResponse`, ignores the response value, and returns `Ok(())` or an `ExecServerError`.

**Call relations**: Called by `Session::signal`. It exists as a convenience wrapper over `call` so higher layers do not need to care about the empty-ish response type.

*Call graph*: calls 1 internal fn (call); called by 1 (signal); 1 external calls (clone).


##### `ExecServerClient::terminate`  (lines 422–433)

```
async fn terminate(
        &self,
        process_id: &ProcessId,
    ) -> Result<TerminateResponse, ExecServerError>
```

**Purpose**: Requests process termination through the exec-server. Unlike `signal`, it returns the typed terminate response.

**Data flow**: It takes a `&ProcessId`, clones it into `TerminateParams`, forwards the request via `self.call(EXEC_TERMINATE_METHOD, &...)`, and returns `TerminateResponse` or `ExecServerError`.

**Call relations**: Used by `Session::terminate` and any direct callers that need the terminate RPC. It is another typed façade over the generic `call` path.

*Call graph*: calls 1 internal fn (call); called by 1 (terminate); 1 external calls (clone).


##### `ExecServerClient::fs_read_file`  (lines 435–440)

```
async fn fs_read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, ExecServerError>
```

**Purpose**: Performs the `fs/readFile` RPC and returns the server’s file contents response. It is one of several filesystem convenience wrappers.

**Data flow**: It accepts `FsReadFileParams`, passes them to `self.call(FS_READ_FILE_METHOD, &params)`, and returns `FsReadFileResponse` or `ExecServerError`.

**Call relations**: Higher-level remote filesystem code invokes this method directly or through wrappers. It delegates all common RPC behavior to `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_open`  (lines 442–444)

```
async fn fs_open(&self, params: FsOpenParams) -> Result<FsOpenResponse, ExecServerError>
```

**Purpose**: Opens a remote file handle through the `fs/open` RPC. It exposes the typed protocol response without additional logic.

**Data flow**: It takes `FsOpenParams`, forwards them through `self.call(FS_OPEN_METHOD, &params)`, and returns `FsOpenResponse` or `ExecServerError`.

**Call relations**: Used by remote filesystem consumers that need block-based reads or writes. It is a direct wrapper over `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_read_block`  (lines 446–451)

```
async fn fs_read_block(
        &self,
        params: FsReadBlockParams,
    ) -> Result<FsReadBlockResponse, ExecServerError>
```

**Purpose**: Reads a block from an already opened remote file handle. It maps directly to the `fs/readBlock` protocol method.

**Data flow**: It accepts `FsReadBlockParams`, calls `self.call(FS_READ_BLOCK_METHOD, &params)`, and returns `FsReadBlockResponse` or `ExecServerError`.

**Call relations**: Called by higher-level file-reading code after `fs_open`. It relies on `call` for transport and error semantics.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_close`  (lines 453–458)

```
async fn fs_close(
        &self,
        params: FsCloseParams,
    ) -> Result<FsCloseResponse, ExecServerError>
```

**Purpose**: Closes a remote file handle via the `fs/close` RPC. It is the cleanup counterpart to `fs_open`.

**Data flow**: It takes `FsCloseParams`, forwards them through `self.call(FS_CLOSE_METHOD, &params)`, and returns `FsCloseResponse` or `ExecServerError`.

**Call relations**: Used after block-based file operations complete. It is a thin typed wrapper over `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_write_file`  (lines 460–465)

```
async fn fs_write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, ExecServerError>
```

**Purpose**: Writes an entire file through the `fs/writeFile` RPC. It exposes the typed response directly.

**Data flow**: It accepts `FsWriteFileParams`, invokes `self.call(FS_WRITE_FILE_METHOD, &params)`, and returns `FsWriteFileResponse` or `ExecServerError`.

**Call relations**: Called by remote filesystem write paths. It delegates all shared behavior to `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_create_directory`  (lines 467–472)

```
async fn fs_create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, ExecServerError>
```

**Purpose**: Creates a directory on the remote filesystem. It is the typed wrapper for `fs/createDirectory`.

**Data flow**: It takes `FsCreateDirectoryParams`, forwards them via `self.call(FS_CREATE_DIRECTORY_METHOD, &params)`, and returns `FsCreateDirectoryResponse` or `ExecServerError`.

**Call relations**: Used by higher-level directory creation code. It depends on `call` for disconnect checks and RPC error mapping.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_get_metadata`  (lines 474–479)

```
async fn fs_get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, ExecServerError>
```

**Purpose**: Fetches metadata for a remote path. It maps directly to the `fs/getMetadata` RPC.

**Data flow**: It accepts `FsGetMetadataParams`, calls `self.call(FS_GET_METADATA_METHOD, &params)`, and returns `FsGetMetadataResponse` or `ExecServerError`.

**Call relations**: Invoked by remote filesystem inspection code. It is another direct wrapper over `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_canonicalize`  (lines 481–486)

```
async fn fs_canonicalize(
        &self,
        params: FsCanonicalizeParams,
    ) -> Result<FsCanonicalizeResponse, ExecServerError>
```

**Purpose**: Canonicalizes a remote path through the exec-server. It exposes the typed canonicalization response.

**Data flow**: It takes `FsCanonicalizeParams`, forwards them through `self.call(FS_CANONICALIZE_METHOD, &params)`, and returns `FsCanonicalizeResponse` or `ExecServerError`.

**Call relations**: Used by higher-level path normalization code. It relies on the shared `call` implementation.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_read_directory`  (lines 488–493)

```
async fn fs_read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, ExecServerError>
```

**Purpose**: Lists directory entries from the remote filesystem. It is the typed wrapper for `fs/readDirectory`.

**Data flow**: It accepts `FsReadDirectoryParams`, invokes `self.call(FS_READ_DIRECTORY_METHOD, &params)`, and returns `FsReadDirectoryResponse` or `ExecServerError`.

**Call relations**: Called by remote directory traversal code. It delegates to `call` for all common mechanics.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_remove`  (lines 495–500)

```
async fn fs_remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, ExecServerError>
```

**Purpose**: Removes a remote filesystem entry through the `fs/remove` RPC. It returns the typed removal response.

**Data flow**: It takes `FsRemoveParams`, forwards them via `self.call(FS_REMOVE_METHOD, &params)`, and returns `FsRemoveResponse` or `ExecServerError`.

**Call relations**: Used by remote deletion code. It is a straightforward wrapper over `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_copy`  (lines 502–504)

```
async fn fs_copy(&self, params: FsCopyParams) -> Result<FsCopyResponse, ExecServerError>
```

**Purpose**: Copies a remote filesystem entry using the `fs/copy` RPC. It exposes the typed response directly.

**Data flow**: It accepts `FsCopyParams`, calls `self.call(FS_COPY_METHOD, &params)`, and returns `FsCopyResponse` or `ExecServerError`.

**Call relations**: Invoked by remote copy operations. It shares the same low-level path as the other filesystem wrappers.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::register_session`  (lines 506–519)

```
async fn register_session(
        &self,
        process_id: &ProcessId,
    ) -> Result<Session, ExecServerError>
```

**Purpose**: Creates client-side tracking state for one process id so connection-global notifications can be routed into a process-local session. It returns a `Session` handle that higher layers use for reads, writes, and subscriptions.

**Data flow**: It allocates a fresh `Arc<SessionState>` via `SessionState::new`, inserts it into `inner.sessions` keyed by the provided `ProcessId`, and returns `Session { client: self.clone(), process_id: process_id.clone(), state }`. If insertion fails because the transport is disconnected or the process id is already registered, it returns an `ExecServerError`.

**Call relations**: Higher-level process startup code calls this after obtaining a process id from `exec`. It delegates registry mutation to `Inner::insert_session`, and the returned `Session` later drives `Session::read`, `subscribe_events`, and cleanup via `unregister`.

*Call graph*: calls 1 internal fn (new); 3 external calls (clone, new, clone).


##### `ExecServerClient::unregister_session`  (lines 521–523)

```
async fn unregister_session(&self, process_id: &ProcessId)
```

**Purpose**: Removes a process session route from the client’s notification registry. This stops future connection-global notifications from being delivered to that session state.

**Data flow**: It takes a `&ProcessId` and awaits `self.inner.remove_session(process_id)`. It returns no value and ignores whether a session was actually present.

**Call relations**: Called by `Session::unregister` and also indirectly by notification handling when an ordered `Closed` event has been published. It is the explicit cleanup path for session routing.

*Call graph*: called by 1 (unregister).


##### `ExecServerClient::session_id`  (lines 525–531)

```
fn session_id(&self) -> Option<String>
```

**Purpose**: Returns the session id negotiated during initialization, if one has been stored. It exposes handshake state for diagnostics and resume-aware callers.

**Data flow**: It reads the `RwLock<Option<String>>` in `inner.session_id`, clones the option, and returns it. No state is modified.

**Call relations**: Tests use this to verify successful initialization and client replacement behavior. The value is written by `ExecServerClient::initialize`.


##### `ExecServerClient::is_disconnected`  (lines 533–535)

```
fn is_disconnected(&self) -> bool
```

**Purpose**: Reports whether the client has observed a transport disconnect. It checks both the sticky disconnect latch and the underlying RPC client state.

**Data flow**: It returns `true` if `inner.disconnected.get().is_some()` or `inner.client.is_disconnected()` is true; otherwise `false`. It reads state only.

**Call relations**: Used by `LazyRemoteExecServerClient::connected_client` to decide cache reuse and by tests such as `wait_for_disconnect` to observe transport loss. It is the health predicate for the eager client.

*Call graph*: called by 1 (wait_for_disconnect).


##### `ExecServerClient::connect`  (lines 537–591)

```
async fn connect(
        connection: JsonRpcConnection,
        options: ExecServerClientConnectOptions,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds an `ExecServerClient` around an already-open `JsonRpcConnection`, starts the background reader task, initializes all routing tables, and runs the initialize handshake. It is the common post-transport setup path shared by websocket, noise, and stdio transports.

**Data flow**: It creates an `RpcClient` plus event receiver from the connection, then constructs `Inner` with `Arc::new_cyclic` so the spawned reader task can upgrade a weak pointer back to the shared state. The reader task loops over `RpcClientEvent`s: notifications are passed to `handle_server_notification`, and disconnects record a canonical message and call `fail_all_in_flight_work`. After assembling `ExecServerClient { inner }`, it calls `client.initialize(options).await?` and returns the connected client.

**Call relations**: Transport-specific constructors such as websocket and stdio ultimately delegate here, and several tests call it directly with in-memory stdio connections. It depends on `handle_server_notification`, `record_disconnected`, and `fail_all_in_flight_work` to keep session and HTTP-stream state coherent after asynchronous transport events.

*Call graph*: calls 1 internal fn (new); called by 3 (process_events_are_delivered_in_seq_order_when_notifications_are_reordered, transport_disconnect_fails_sessions_and_rejects_new_sessions, wake_notifications_do_not_block_other_sessions); 1 external calls (new_cyclic).


##### `ExecServerClient::notify_initialized`  (lines 593–599)

```
async fn notify_initialized(&self) -> Result<(), ExecServerError>
```

**Purpose**: Sends the JSON-RPC `initialized` notification after a successful initialize response. This completes the two-step handshake expected by the server.

**Data flow**: It calls `inner.client.notify(INITIALIZED_METHOD, &json!({}))`, maps any serialization error into `ExecServerError::Json`, and returns `Ok(())` or that error. It does not mutate client state.

**Call relations**: Only `ExecServerClient::initialize` calls this, immediately after storing the session id. It exists to keep the handshake sequence explicit and isolated.

*Call graph*: called by 1 (initialize); 1 external calls (json!).


##### `ExecServerClient::call`  (lines 601–629)

```
async fn call(&self, method: &str, params: &P) -> Result<T, ExecServerError>
```

**Purpose**: Shared low-level RPC invocation path for nearly every client operation. It enforces preflight disconnect rejection, converts JSON-RPC errors into `ExecServerError`, and canonicalizes transport-closed races into a sticky disconnected state.

**Data flow**: It takes a method name and serializable params, first checks `inner.disconnected_error()` and returns that immediately if present, then awaits `inner.client.call(method, params)`. Successful responses are returned as deserialized `T`; failures are converted via `ExecServerError::from`. If the resulting error matches `is_transport_closed_error`, it records a canonical disconnect message with `record_disconnected` and returns `ExecServerError::Disconnected(message)`; otherwise it returns the converted error unchanged.

**Call relations**: All typed RPC wrappers—process, filesystem, environment, and remote HTTP—delegate here. It is the central failure path after transport loss, and its disconnect latching complements the reader task’s broader `fail_all_in_flight_work` handling.

*Call graph*: calls 4 internal fn (from, disconnected_message, is_transport_closed_error, record_disconnected); called by 17 (environment_info, exec, fs_canonicalize, fs_close, fs_copy, fs_create_directory, fs_get_metadata, fs_open, fs_read_block, fs_read_directory (+7 more)); 1 external calls (Disconnected).


##### `ExecServerError::from`  (lines 633–642)

```
fn from(value: RpcCallError) -> Self
```

**Purpose**: Maps generic JSON-RPC call failures into the client’s domain-specific error enum. It preserves server error codes/messages and distinguishes closed transports from JSON serialization failures.

**Data flow**: It matches on `RpcCallError`: `Closed` becomes `ExecServerError::Closed`, `Json(err)` becomes `ExecServerError::Json(err)`, and `Server(error)` becomes `ExecServerError::Server { code, message }`. It returns the converted enum value.

**Call relations**: Used by `ExecServerClient::call` whenever the underlying RPC client returns an error. It is the first stage of error normalization before transport-closed special handling.

*Call graph*: called by 1 (call); 1 external calls (Json).


##### `SessionState::new`  (lines 646–657)

```
fn new() -> Self
```

**Purpose**: Allocates the per-process state used for wake notifications, retained event streaming, ordered notification buffering, and terminal failure tracking. It establishes the initial empty session state.

**Data flow**: It creates a watch channel seeded with `0`, an `ExecProcessEventLog` configured with `PROCESS_EVENT_CHANNEL_CAPACITY` and `PROCESS_EVENT_RETAINED_BYTES`, a default `OrderedSessionEvents`, and a `Mutex<Option<String>>` failure slot initialized to `None`. It returns the assembled `SessionState`.

**Call relations**: Called by `ExecServerClient::register_session` whenever a new process session is registered. The resulting state is then read and mutated by notification handling and `Session` methods.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, default, channel).


##### `SessionState::subscribe`  (lines 659–661)

```
fn subscribe(&self) -> watch::Receiver<u64>
```

**Purpose**: Creates a new watch receiver for wake sequence updates on this session. Consumers use it to be notified that some process state changed.

**Data flow**: It calls `self.wake_tx.subscribe()` and returns the resulting `watch::Receiver<u64>`. No state is modified.

**Call relations**: Used by `Session::subscribe_wake`, which exposes the wake channel to callers. Notification handling and failure paths later drive this channel via `note_change` and `set_failure`.

*Call graph*: 1 external calls (subscribe).


##### `SessionState::subscribe_events`  (lines 663–665)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Creates a receiver for the retained process event log. This is the streaming event subscription API for one process session.

**Data flow**: It calls `self.events.subscribe()` and returns an `ExecProcessEventReceiver`. It reads session state only.

**Call relations**: Exposed through `Session::subscribe_events` and used heavily in tests. Events are published into this log by `publish_ordered_event` and `set_failure`.

*Call graph*: calls 1 internal fn (subscribe).


##### `SessionState::note_change`  (lines 667–670)

```
fn note_change(&self, seq: u64)
```

**Purpose**: Advances the wake sequence to at least the provided sequence number and notifies watchers. It is intentionally lightweight so notification routing can wake readers without blocking on event-log delivery.

**Data flow**: It reads the current watch value with `borrow()`, computes `max(current, seq)`, and sends that value on `wake_tx`. The send result is ignored because there may be no active watchers.

**Call relations**: Called from `handle_server_notification` whenever output, exited, or closed notifications arrive for a registered process. It complements `publish_ordered_event` by providing a cheap wake signal even if event publication is delayed by reordering.

*Call graph*: 2 external calls (borrow, send).


##### `SessionState::publish_ordered_event`  (lines 679–714)

```
fn publish_ordered_event(&self, event: ExecProcessEvent) -> bool
```

**Purpose**: Publishes process events to subscribers only when all lower sequence numbers have already been delivered, preserving monotonic event order despite out-of-order server notifications. It also tells the caller whether the ordered `Closed` event was actually published.

**Data flow**: If the event has no sequence, it is published immediately and returns `false`. Otherwise it locks `ordered_events`, drops duplicates or stale events whose seq is `<= last_published_seq`, inserts the event into `pending`, then repeatedly drains contiguous `last_published_seq + 1` entries into a local `ready` vector. After releasing the lock, it publishes each ready event to `self.events`, tracks whether any published event is `ExecProcessEvent::Closed`, and returns that boolean.

**Call relations**: Used by `handle_server_notification` for output/exited/closed notifications and by `SessionState::set_failure` for the synthetic `Failed` event. Notification handling uses the returned `published_closed` flag to decide when it is finally safe to remove the session route.

*Call graph*: calls 2 internal fn (seq, publish); called by 1 (set_failure); 3 external calls (lock, new, matches!).


##### `SessionState::set_failure`  (lines 716–728)

```
async fn set_failure(&self, message: String)
```

**Purpose**: Marks the session as terminally failed, wakes waiters, and publishes a single synthetic `Failed` event. It ensures disconnect-related failures are visible to both polling and streaming consumers.

**Data flow**: It locks `failure`, stores the provided message only if no failure was already recorded, then drops the lock. It increments the current wake value with saturation, sends the new wake sequence, and if this was the first failure, publishes `ExecProcessEvent::Failed(message)` through `publish_ordered_event`.

**Call relations**: Called by `fail_all_sessions` during transport teardown and by `Session::read` when a read races with transport closure. It relies on `publish_ordered_event` so the failure becomes part of the same event-stream mechanism as normal process notifications.

*Call graph*: calls 1 internal fn (publish_ordered_event); 3 external calls (borrow, send, Failed).


##### `SessionState::failed_response`  (lines 730–736)

```
async fn failed_response(&self) -> Option<ReadResponse>
```

**Purpose**: Returns a synthesized terminal `ReadResponse` if the session has already been marked failed. This lets polling readers stop immediately after disconnect.

**Data flow**: It locks `failure`, clones the optional message, and if present maps it through `synthesized_failure(message)`. The result is `Option<ReadResponse>`.

**Call relations**: Called at the start of `Session::read` before any RPC is attempted. It is the polling-side mirror of the pushed `Failed` event published by `set_failure`.


##### `SessionState::synthesized_failure`  (lines 738–748)

```
fn synthesized_failure(&self, message: String) -> ReadResponse
```

**Purpose**: Builds a terminal `ReadResponse` representing a disconnected or failed session without contacting the server. The response reports closed/exited state and carries the failure message.

**Data flow**: It reads the current wake value, computes `next_seq` as `current + 1` with saturation, and returns `ReadResponse { chunks: Vec::new(), next_seq, exited: true, exit_code: None, closed: true, failure: Some(message) }`.

**Call relations**: Used by `failed_response` and by `Session::read` after it detects a transport-closed error from the underlying RPC. It centralizes the exact synthetic response shape for failed sessions.

*Call graph*: 2 external calls (borrow, new).


##### `Session::process_id`  (lines 752–754)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Returns the process id associated with this session handle. It is a simple accessor for higher-level code.

**Data flow**: It returns `&self.process_id` by reference and does not modify any state.

**Call relations**: Used by callers that need to correlate a `Session` with the underlying process id. The value was originally captured in `ExecServerClient::register_session`.


##### `Session::subscribe_wake`  (lines 756–758)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Exposes the session’s wake watch channel to callers. This is the public session-level wrapper around `SessionState::subscribe`.

**Data flow**: It calls `self.state.subscribe()` and returns a `watch::Receiver<u64>`. No state is changed.

**Call relations**: Used by tests and any consumers that want lightweight change notifications instead of full event streaming. The wake channel is driven by `note_change` and `set_failure`.


##### `Session::subscribe_events`  (lines 760–762)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Exposes the retained process event stream for this session. It is the session-level wrapper around `SessionState::subscribe_events`.

**Data flow**: It calls `self.state.subscribe_events()` and returns an `ExecProcessEventReceiver`. It reads state only.

**Call relations**: Tests and streaming consumers call this to observe ordered output/exited/closed/failed events. The underlying events are published by notification handling and failure synthesis.


##### `Session::read`  (lines 764–792)

```
async fn read(
        &self,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> Result<ReadResponse, ExecServerError>
```

**Purpose**: Reads process output for this session while gracefully converting transport disconnects into synthesized terminal responses. It is the session-aware wrapper around the client’s raw `read` RPC.

**Data flow**: It first awaits `self.state.failed_response()` and returns that immediately if present. Otherwise it calls `self.client.read(ReadParams { process_id: self.process_id.clone(), after_seq, max_bytes, wait_ms })`. On success it returns the server response; if the error matches `is_transport_closed_error`, it computes a canonical disconnect message, stores it via `self.state.set_failure`, and returns `self.state.synthesized_failure(message)`; other errors are propagated unchanged.

**Call relations**: Higher-level process consumers call this instead of `ExecServerClient::read` so they get session-local failure semantics. It delegates the actual RPC to `ExecServerClient::read` and uses `disconnected_message` plus `set_failure` to keep polling and streaming views consistent after disconnect.

*Call graph*: calls 3 internal fn (read, disconnected_message, is_transport_closed_error); 1 external calls (clone).


##### `Session::write`  (lines 794–796)

```
async fn write(&self, chunk: Vec<u8>) -> Result<WriteResponse, ExecServerError>
```

**Purpose**: Writes stdin bytes to the process represented by this session. It is a convenience wrapper that binds the stored process id.

**Data flow**: It takes a `Vec<u8>`, forwards it to `self.client.write(&self.process_id, chunk)`, and returns `WriteResponse` or `ExecServerError`.

**Call relations**: Called by higher-level process I/O code. It delegates directly to `ExecServerClient::write`.

*Call graph*: calls 1 internal fn (write).


##### `Session::signal`  (lines 798–800)

```
async fn signal(&self, signal: ProcessSignal) -> Result<(), ExecServerError>
```

**Purpose**: Sends a signal to the process represented by this session. It binds the session’s process id so callers only provide the signal value.

**Data flow**: It takes a `ProcessSignal`, calls `self.client.signal(&self.process_id, signal)`, and returns `Ok(())` or `ExecServerError`.

**Call relations**: Used by higher-level lifecycle control code. It is a thin wrapper over `ExecServerClient::signal`.

*Call graph*: calls 1 internal fn (signal).


##### `Session::terminate`  (lines 802–805)

```
async fn terminate(&self) -> Result<(), ExecServerError>
```

**Purpose**: Requests termination of the process represented by this session. It hides the underlying terminate response type from callers.

**Data flow**: It calls `self.client.terminate(&self.process_id).await?` and then returns `Ok(())`. The only transformation is discarding the `TerminateResponse`.

**Call relations**: Called by higher-level cleanup code. It delegates to `ExecServerClient::terminate`.

*Call graph*: calls 1 internal fn (terminate).


##### `Session::unregister`  (lines 807–809)

```
async fn unregister(&self)
```

**Purpose**: Explicitly removes this session from the client’s routing table. This is the session-handle cleanup API.

**Data flow**: It awaits `self.client.unregister_session(&self.process_id)` and returns no value. It mutates the client’s session registry indirectly.

**Call relations**: Used when callers are done with a session before or after process completion. It delegates to `ExecServerClient::unregister_session`.

*Call graph*: calls 1 internal fn (unregister_session).


##### `Inner::disconnected_error`  (lines 813–818)

```
fn disconnected_error(&self) -> Option<ExecServerError>
```

**Purpose**: Returns the sticky disconnected error if the client has already latched a transport failure. It converts the stored message into the public error type.

**Data flow**: It reads `self.disconnected.get()`, clones the stored string if present, wraps it in `ExecServerError::Disconnected`, and returns `Option<ExecServerError>`.

**Call relations**: Used by `ExecServerClient::call` for preflight rejection and by `Inner::insert_session` to prevent registering sessions that can never receive notifications. It is the read side of the disconnect latch.

*Call graph*: called by 1 (insert_session); 1 external calls (get).


##### `Inner::set_disconnected`  (lines 820–825)

```
fn set_disconnected(&self, message: String) -> Option<String>
```

**Purpose**: Attempts to latch the canonical disconnect message exactly once. Subsequent callers learn that the latch was already set.

**Data flow**: It calls `self.disconnected.set(message.clone())`; on success it returns `Some(message)`, and on failure returns `None`. It mutates the once-only disconnect latch.

**Call relations**: Used by `record_disconnected` to establish the first canonical disconnect reason. It is not called directly by higher-level code.

*Call graph*: 1 external calls (set).


##### `Inner::get_session`  (lines 827–829)

```
fn get_session(&self, process_id: &ProcessId) -> Option<Arc<SessionState>>
```

**Purpose**: Looks up the registered session state for a process id from the lock-free read path. It supports hot notification routing.

**Data flow**: It loads the current `Arc<HashMap<ProcessId, Arc<SessionState>>>` from `sessions`, clones the matching `Arc<SessionState>` if present, and returns it.

**Call relations**: Called by `handle_server_notification` for output, exited, and closed notifications. It is optimized for frequent reads while writes are serialized elsewhere.

*Call graph*: 1 external calls (load).


##### `Inner::insert_session`  (lines 831–853)

```
async fn insert_session(
        &self,
        process_id: &ProcessId,
        session: Arc<SessionState>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adds a new process-to-session route into the shared session registry, rejecting duplicates and disconnected clients. It performs copy-on-write updates under a write lock.

**Data flow**: It acquires `sessions_write_lock`, checks `disconnected_error()` and returns that if set, loads the current sessions map, rejects duplicate `process_id`s with `ExecServerError::Protocol`, clones the map, inserts the new `Arc<SessionState>`, and stores the new `Arc<HashMap<...>>` back into `sessions`.

**Call relations**: Called only by `ExecServerClient::register_session`. It is the serialized mutation path that complements `Inner::get_session`’s cheap read path.

*Call graph*: calls 1 internal fn (disconnected_error); 6 external calls (new, load, store, Protocol, clone, format!).


##### `Inner::remove_session`  (lines 855–864)

```
async fn remove_session(&self, process_id: &ProcessId) -> Option<Arc<SessionState>>
```

**Purpose**: Removes a process session route from the registry if present. It uses the same copy-on-write pattern as insertion.

**Data flow**: It acquires `sessions_write_lock`, loads the current sessions map, clones out the existing session if any, returns `None` early if absent, otherwise clones the map, removes the process id, stores the new map, and returns the removed `Arc<SessionState>`.

**Call relations**: Called by `ExecServerClient::unregister_session` and by `handle_server_notification` once an ordered `Closed` event has been published. It is also part of disconnect cleanup via `take_all_sessions` rather than direct iteration.

*Call graph*: 3 external calls (new, load, store).


##### `Inner::take_all_sessions`  (lines 866–872)

```
async fn take_all_sessions(&self) -> HashMap<ProcessId, Arc<SessionState>>
```

**Purpose**: Atomically drains the entire session registry and returns the removed sessions. It is used during transport failure to fail every in-flight process session exactly once.

**Data flow**: It acquires `sessions_write_lock`, loads and clones the current sessions map, replaces `sessions` with an empty `HashMap`, and returns the drained map.

**Call relations**: Called by `fail_all_sessions` during disconnect handling. It is the bulk-removal counterpart to `remove_session`.

*Call graph*: 4 external calls (new, load, store, new).


##### `disconnected_message`  (lines 875–880)

```
fn disconnected_message(reason: Option<&str>) -> String
```

**Purpose**: Builds the canonical human-readable disconnect message, optionally including a transport-provided reason. This keeps disconnect wording consistent across code paths.

**Data flow**: It takes `Option<&str>` and returns either `"exec-server transport disconnected"` or `format!("exec-server transport disconnected: {reason}")`.

**Call relations**: Used by `ExecServerClient::call`, `Session::read`, and the reader task’s disconnect branch. It centralizes the exact message later stored in the disconnect latch and surfaced to callers.

*Call graph*: called by 2 (call, read); 1 external calls (format!).


##### `is_transport_closed_error`  (lines 882–893)

```
fn is_transport_closed_error(error: &ExecServerError) -> bool
```

**Purpose**: Recognizes errors that semantically mean the shared JSON-RPC transport is gone, including a specific server-side sentinel error. This lets the client collapse several failure shapes into one disconnect path.

**Data flow**: It pattern-matches an `ExecServerError` and returns `true` for `Closed`, `Disconnected(_)`, or `Server { code: -32000, message: "JSON-RPC transport closed" }`; otherwise `false`.

**Call relations**: Called by `ExecServerClient::call` and `Session::read` to decide when to synthesize disconnect behavior instead of propagating a raw RPC error. It is a pure classifier used in multiple failure paths.

*Call graph*: called by 2 (call, read); 1 external calls (matches!).


##### `record_disconnected`  (lines 895–904)

```
fn record_disconnected(inner: &Arc<Inner>, message: String) -> String
```

**Purpose**: Stores the first canonical disconnect message and returns the canonical value that should be used by the caller. Later callers get back the already-recorded message.

**Data flow**: It takes `&Arc<Inner>` and a candidate message, calls `inner.set_disconnected(message.clone())`, and returns either the newly stored message or the previously stored one from `inner.disconnected.get()`. It mutates the disconnect latch only on the first call.

**Call relations**: Used by `ExecServerClient::call` and by the reader task in `ExecServerClient::connect` when notification handling fails or the transport disconnects. It separates one-time latching from the broader cleanup work done by `fail_all_in_flight_work`.

*Call graph*: called by 1 (call).


##### `fail_all_sessions`  (lines 906–915)

```
async fn fail_all_sessions(inner: &Arc<Inner>, message: String)
```

**Purpose**: Marks every registered process session as failed with the same disconnect message. This ensures both polling and streaming consumers stop waiting after transport loss.

**Data flow**: It drains all sessions via `inner.take_all_sessions().await`, then iterates the resulting map and awaits `session.set_failure(message.clone())` for each `SessionState`. It mutates each session’s failure slot, wake channel, and event log.

**Call relations**: Called only by `fail_all_in_flight_work`. It is the process-session half of global transport-failure cleanup.

*Call graph*: called by 1 (fail_all_in_flight_work).


##### `fail_all_in_flight_work`  (lines 918–921)

```
async fn fail_all_in_flight_work(inner: &Arc<Inner>, message: String)
```

**Purpose**: Fails every outstanding operation that depends on the shared transport, covering both process sessions and streamed HTTP bodies. It is the one-stop disconnect cleanup routine.

**Data flow**: It takes `&Arc<Inner>` and a message, calls `fail_all_sessions(inner, message.clone()).await`, then `inner.fail_all_http_body_streams(message).await`. It mutates all in-flight session and HTTP-stream state.

**Call relations**: Invoked by the reader task in `ExecServerClient::connect` after notification handling failure or transport disconnect. It coordinates cleanup across subsystems rather than implementing either cleanup path itself.

*Call graph*: calls 1 internal fn (fail_all_sessions).


##### `handle_server_notification`  (lines 923–983)

```
async fn handle_server_notification(
    inner: &Arc<Inner>,
    notification: JSONRPCNotification,
) -> Result<(), ExecServerError>
```

**Purpose**: Routes one incoming JSON-RPC notification from the shared connection to the appropriate process session or HTTP body stream. It is the central notification dispatcher for the client.

**Data flow**: It matches `notification.method`. For `EXEC_OUTPUT_DELTA_METHOD`, `EXEC_EXITED_METHOD`, and `EXEC_CLOSED_METHOD`, it deserializes the typed params, looks up the session by `process_id`, calls `note_change(seq)`, publishes the corresponding `ExecProcessEvent` through `publish_ordered_event`, and removes the session if that call reports that `Closed` was actually published. For `HTTP_REQUEST_BODY_DELTA_METHOD`, it delegates to `inner.handle_http_body_delta_notification(notification.params)`. Unknown methods are ignored with a debug log.

**Call relations**: Only the reader task spawned in `ExecServerClient::connect` calls this, once per incoming notification. It delegates process-local ordering to `SessionState` and HTTP stream routing to the helper methods implemented on `Inner` in the HTTP body stream module.

*Call graph*: 3 external calls (debug!, Output, from_value).


##### `tests::read_jsonrpc_line`  (lines 1039–1049)

```
async fn read_jsonrpc_line(lines: &mut tokio::io::Lines<BufReader<R>>) -> JSONRPCMessage
```

**Purpose**: Test helper that reads one newline-delimited JSON-RPC message from an async reader with a short timeout. It fails loudly if the test transport stalls or closes unexpectedly.

**Data flow**: It takes mutable `Lines<BufReader<R>>`, wraps `next_line()` in a one-second `timeout`, unwraps timeout/I/O/EOF conditions with `expect`, parses the resulting line with `serde_json::from_str`, and returns a `JSONRPCMessage`.

**Call relations**: Used by the in-memory stdio transport tests to emulate a simple line-based JSON-RPC server. It pairs with `tests::write_jsonrpc_line`.

*Call graph*: 4 external calls (from_secs, next_line, from_str, timeout).


##### `tests::write_jsonrpc_line`  (lines 1051–1060)

```
async fn write_jsonrpc_line(writer: &mut W, message: JSONRPCMessage)
```

**Purpose**: Test helper that serializes a JSON-RPC message and writes it as one newline-terminated line. It is the write-side companion to `read_jsonrpc_line`.

**Data flow**: It takes a mutable async writer and a `JSONRPCMessage`, serializes the message with `serde_json::to_string`, appends `\n`, writes the bytes with `write_all`, and panics on failure via `expect`.

**Call relations**: Used by stdio-based tests to send initialize responses and notifications to the client under test. It complements `read_jsonrpc_line` in the fake server tasks.

*Call graph*: 3 external calls (write_all, format!, to_string).


##### `tests::accept_websocket`  (lines 1062–1067)

```
async fn accept_websocket(listener: &TcpListener) -> WebSocketStream<TcpStream>
```

**Purpose**: Accepts one TCP connection from a test listener and upgrades it to a websocket stream. It hides the handshake boilerplate for websocket-based tests.

**Data flow**: It awaits `listener.accept()`, discards the peer address, passes the stream to `accept_async`, and returns the resulting `WebSocketStream<TcpStream>`. Errors are converted into test panics with `expect`.

**Call relations**: Used by the websocket reconnection test before running the initialize handshake helper. It is the websocket analogue of the stdio fake-server setup helpers.

*Call graph*: 2 external calls (accept, accept_async).


##### `tests::read_jsonrpc_websocket`  (lines 1069–1089)

```
async fn read_jsonrpc_websocket(websocket: &mut WebSocketStream<TcpStream>) -> JSONRPCMessage
```

**Purpose**: Reads the next JSON-RPC message from a websocket test stream, accepting either text or binary frames and ignoring ping/pong frames. It enforces a short timeout and panics on unexpected frame types.

**Data flow**: It loops, awaiting `websocket.next()` under a one-second timeout. Text frames are parsed with `serde_json::from_str`, binary frames with `serde_json::from_slice`, ping/pong frames are skipped, and any other frame causes a panic. It returns the parsed `JSONRPCMessage`.

**Call relations**: Used by websocket-based tests and by `complete_websocket_initialize` to inspect client handshake traffic. It pairs with `write_jsonrpc_websocket`.

*Call graph*: 6 external calls (from_secs, next, panic!, from_slice, from_str, timeout).


##### `tests::write_jsonrpc_websocket`  (lines 1091–1100)

```
async fn write_jsonrpc_websocket(
        websocket: &mut WebSocketStream<TcpStream>,
        message: JSONRPCMessage,
    )
```

**Purpose**: Serializes and sends one JSON-RPC message as a websocket text frame in tests. It is the write-side helper for websocket fake servers.

**Data flow**: It takes a mutable websocket stream and a `JSONRPCMessage`, serializes it with `serde_json::to_string`, wraps it in `Message::Text`, sends it, and panics on failure via `expect`.

**Call relations**: Used by `complete_websocket_initialize` and websocket fake-server tasks. It complements `read_jsonrpc_websocket`.

*Call graph*: 3 external calls (send, to_string, Text).


##### `tests::complete_websocket_initialize`  (lines 1102–1137)

```
async fn complete_websocket_initialize(
        websocket: &mut WebSocketStream<TcpStream>,
        session_id: &str,
        expected_resume_session_id: Option<&str>,
    )
```

**Purpose**: Runs the server side of the websocket initialize handshake in tests, including optional resume-session-id verification. It validates both the request and the follow-up `initialized` notification.

**Data flow**: It reads the first websocket message, asserts it is an initialize request, deserializes `InitializeParams`, checks `resume_session_id` against the expected value, writes a matching `InitializeResponse` containing the supplied `session_id`, then reads the next message and asserts it is an `INITIALIZED_METHOD` notification.

**Call relations**: Used by the websocket reconnection test to stand in for a minimal exec-server. It delegates frame I/O to `read_jsonrpc_websocket` and `write_jsonrpc_websocket`.

*Call graph*: 7 external calls (Response, assert_eq!, read_jsonrpc_websocket, write_jsonrpc_websocket, panic!, from_value, to_value).


##### `tests::wait_for_disconnect`  (lines 1139–1150)

```
async fn wait_for_disconnect(client: &ExecServerClient)
```

**Purpose**: Polls until a client reports itself disconnected or times out. It gives asynchronous disconnect propagation a bounded window in tests.

**Data flow**: It repeatedly checks `client.is_disconnected()` inside a one-second `timeout`, yielding with `tokio::task::yield_now()` between checks. It returns unit on success and panics if the timeout expires.

**Call relations**: Used by the lazy websocket replacement test after the first server-side close. It depends on `ExecServerClient::is_disconnected` to observe the client’s health state.

*Call graph*: calls 1 internal fn (is_disconnected); 3 external calls (from_secs, yield_now, timeout).


##### `tests::connect_stdio_command_initializes_json_rpc_client`  (lines 1154–1173)

```
async fn connect_stdio_command_initializes_json_rpc_client()
```

**Purpose**: Verifies on non-Windows platforms that connecting to an exec-server over stdio performs the initialize handshake and stores the returned session id. The fake server is a shell command that speaks minimal line-delimited JSON-RPC.

**Data flow**: It constructs `StdioExecServerConnectArgs` with a `sh -c` script that reads one line, prints an initialize response containing `stdio-test`, then waits. It awaits `ExecServerClient::connect_stdio_command(...)` and asserts `client.session_id()` equals `Some("stdio-test")`.

**Call relations**: This test exercises the stdio transport path and the common `connect`/`initialize` logic together. It is one of the basic handshake smoke tests in the module.

*Call graph*: 5 external calls (from_secs, new, assert_eq!, connect_stdio_command, vec!).


##### `tests::connect_for_transport_initializes_stdio_command`  (lines 1177–1196)

```
async fn connect_for_transport_initializes_stdio_command()
```

**Purpose**: Checks that the transport-dispatching `connect_for_transport` path correctly handles the stdio transport variant and still completes initialization. It validates the transport multiplexer rather than the raw stdio constructor alone.

**Data flow**: It builds an `ExecServerTransportParams::StdioCommand` containing a shell script fake server, awaits `ExecServerClient::connect_for_transport(...)`, and asserts the resulting client’s session id is `stdio-test`.

**Call relations**: This test specifically covers `ExecServerClient::connect_for_transport` dispatch to the stdio branch. It complements the direct stdio connection test.

*Call graph*: 4 external calls (new, assert_eq!, connect_for_transport, vec!).


##### `tests::connect_stdio_command_initializes_json_rpc_client_on_windows`  (lines 1200–1220)

```
async fn connect_stdio_command_initializes_json_rpc_client_on_windows()
```

**Purpose**: Windows-specific version of the stdio initialization smoke test using PowerShell instead of `sh`. It confirms the same handshake behavior on the Windows command environment.

**Data flow**: It constructs `StdioExecServerConnectArgs` with a PowerShell command that reads one line, writes an initialize response with session id `stdio-test`, then sleeps. It connects with `ExecServerClient::connect_stdio_command` and asserts the stored session id.

**Call relations**: This is the platform-specific counterpart to the non-Windows stdio handshake test. It exercises the same client code against a Windows-friendly fake server.

*Call graph*: 5 external calls (from_secs, new, assert_eq!, connect_stdio_command, vec!).


##### `tests::dropping_stdio_client_terminates_spawned_process`  (lines 1224–1267)

```
async fn dropping_stdio_client_terminates_spawned_process()
```

**Purpose**: Ensures that dropping a stdio-backed client tears down the spawned exec-server process tree, including a child process started by the fake server. This guards against leaked subprocesses.

**Data flow**: It creates temp files for server and child PIDs, launches a shell script fake server that records both PIDs and waits, connects a client, reads the PID files, asserts both processes exist, drops the client, then waits for both processes to exit using polling helpers.

**Call relations**: This test exercises the child-process ownership behavior attached to `JsonRpcConnection::with_child_process` in the stdio transport path. It relies on `read_pid_file`, `process_exists`, and `wait_for_process_exit` helpers.

*Call graph*: 9 external calls (from_secs, new, assert!, connect_stdio_command, read_pid_file, wait_for_process_exit, format!, tempdir, vec!).


##### `tests::malformed_stdio_message_terminates_spawned_process`  (lines 1271–1298)

```
async fn malformed_stdio_message_terminates_spawned_process()
```

**Purpose**: Verifies that if the stdio server emits malformed JSON during initialization, connection fails and the spawned process is still cleaned up. It protects against orphaned bad servers on handshake failure.

**Data flow**: It launches a shell script fake server that writes its PID file and then prints `not-json`, attempts `ExecServerClient::connect_stdio_command`, asserts the result is an error, reads the server PID, and waits for that process to exit.

**Call relations**: This test covers the failure path of stdio initialization rather than the success path. It uses `read_pid_file` and `wait_for_process_exit` to confirm cleanup after a parse error.

*Call graph*: 9 external calls (from_secs, new, assert!, connect_stdio_command, read_pid_file, wait_for_process_exit, format!, tempdir, vec!).


##### `tests::read_pid_file`  (lines 1301–1312)

```
async fn read_pid_file(path: &Path) -> u32
```

**Purpose**: Polls for a PID file to appear and parses its contents as a process id. It smooths over the race between process startup and test assertions.

**Data flow**: It loops up to 20 times, attempting `std::fs::read_to_string(path)`; on success it trims and parses the contents as `u32` and returns it. Between attempts it sleeps 50 ms, and if the file never appears it panics with the path.

**Call relations**: Used by the stdio process-lifecycle tests to discover the fake server and child PIDs written by shell scripts. It pairs with `wait_for_process_exit` and `process_exists`.

*Call graph*: 4 external calls (from_millis, panic!, read_to_string, sleep).


##### `tests::wait_for_process_exit`  (lines 1315–1323)

```
async fn wait_for_process_exit(pid: u32)
```

**Purpose**: Polls until a process no longer exists, with a bounded retry window. It is a simple synchronization helper for process-cleanup tests.

**Data flow**: It loops up to 20 times, calling `process_exists(pid)` each iteration; if the process is gone it returns, otherwise it sleeps 100 ms. If the process still exists after all retries, it panics.

**Call relations**: Used by the stdio cleanup tests after dropping the client or after a malformed handshake. It depends on `process_exists` for the actual liveness check.

*Call graph*: 4 external calls (from_millis, process_exists, panic!, sleep).


##### `tests::process_exists`  (lines 1326–1332)

```
fn process_exists(pid: u32) -> bool
```

**Purpose**: Checks process liveness on Unix by invoking `kill -0`. It is a low-level helper for the process-cleanup tests.

**Data flow**: It runs `Command::new("kill").arg("-0").arg(pid.to_string()).status()` and returns whether the command succeeded with a success status. It reads OS process state but does not mutate client state.

**Call relations**: Used by `wait_for_process_exit` and directly in the stdio cleanup test’s pre-drop assertions. It is Unix-only support code for those tests.

*Call graph*: 1 external calls (new).


##### `tests::shell_quote`  (lines 1335–1338)

```
fn shell_quote(path: &Path) -> String
```

**Purpose**: Quotes a filesystem path for safe embedding in a shell script string. It handles single quotes using the standard shell escape pattern.

**Data flow**: It converts the path to a lossy string and returns a single-quoted shell literal with internal `'` replaced by `'\''`. No external state is touched.

**Call relations**: Used by the Unix stdio fake-server scripts in the process-lifecycle tests. It keeps those scripts robust when temp paths contain special characters.

*Call graph*: 2 external calls (to_string_lossy, format!).


##### `tests::process_events_are_delivered_in_seq_order_when_notifications_are_reordered`  (lines 1341–1481)

```
async fn process_events_are_delivered_in_seq_order_when_notifications_are_reordered()
```

**Purpose**: Proves that out-of-order output/exited/closed notifications are published to subscribers in sequence order. This is the main regression test for `SessionState::publish_ordered_event`.

**Data flow**: It creates an in-memory stdio JSON-RPC connection, spawns a fake server that completes initialization and then forwards queued notifications, connects a client, registers a session for process `reordered`, subscribes to events, sends notifications in the order closed(4), output(1), exited(3), output(2), collects four delivered events, and asserts they arrive as output(1), output(2), exited(3), closed(4).

**Call relations**: This test drives `ExecServerClient::connect`, `register_session`, the reader task, `handle_server_notification`, and ordered event publication together. It validates that session removal waits until ordered `Closed` publication rather than first receipt.

*Call graph*: calls 3 internal fn (connect, from_stdio, from); 15 external calls (new, from_secs, new, Notification, Response, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, default, channel (+5 more)).


##### `tests::transport_disconnect_fails_sessions_and_rejects_new_sessions`  (lines 1484–1567)

```
async fn transport_disconnect_fails_sessions_and_rejects_new_sessions()
```

**Purpose**: Checks that a transport disconnect publishes a session failure event, causes subsequent reads to synthesize terminal failure responses, and prevents new session registration. It validates the sticky disconnect and cleanup logic.

**Data flow**: It sets up an in-memory stdio fake server that initializes and then drops its writer when signaled, connects a client, registers a session, subscribes to events, triggers disconnect, receives and pattern-matches an `ExecProcessEvent::Failed`, asserts the failure message, calls `session.read(...)` and checks the synthesized failure/closed fields, then attempts to register a new session and asserts it returns `ExecServerError::Disconnected(_)`.

**Call relations**: This test exercises the reader task’s disconnect branch, `record_disconnected`, `fail_all_in_flight_work`, `SessionState::set_failure`, `Session::read`, and `Inner::insert_session`’s disconnected preflight. It is the main regression test for disconnect semantics.

*Call graph*: calls 3 internal fn (connect, from_stdio, from); 14 external calls (new, from_secs, Response, assert!, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, default, channel, panic! (+4 more)).


##### `tests::remote_websocket_client_replaces_disconnected_client_with_fresh_session`  (lines 1570–1618)

```
async fn remote_websocket_client_replaces_disconnected_client_with_fresh_session()
```

**Purpose**: Verifies that `LazyRemoteExecServerClient` reconnects after a websocket disconnect and that concurrent callers share the same replacement client. It specifically tests cache replacement and connection serialization.

**Data flow**: It binds a local TCP listener, spawns a websocket fake server that accepts one connection, completes initialization with session `session-1`, closes it, then accepts a second connection and initializes `session-2`. The test creates a lazy websocket client, gets the first client, waits for disconnect, then concurrently calls `get()` twice and asserts both results report `session-2` and share the same `Arc<Inner>`.

**Call relations**: This test directly exercises `LazyRemoteExecServerClient::new`, `get`, `connected_client`, and the reconnect branch that calls `ExecServerClient::connect_for_transport`. It also uses `accept_websocket`, `complete_websocket_initialize`, and `wait_for_disconnect` helpers.

*Call graph*: calls 1 internal fn (new); 10 external calls (from_secs, bind, assert!, assert_eq!, accept_websocket, complete_websocket_initialize, wait_for_disconnect, format!, join!, spawn).


##### `tests::wake_notifications_do_not_block_other_sessions`  (lines 1621–1721)

```
async fn wake_notifications_do_not_block_other_sessions()
```

**Purpose**: Ensures that a flood of notifications for one process does not prevent another session’s wake channel from being updated promptly. It validates the lightweight wake path under load.

**Data flow**: It creates an in-memory stdio fake server, connects a client, registers a noisy and a quiet session, subscribes to the quiet session’s wake receiver, sends thousands of output notifications for the noisy process followed by one exited notification for the quiet process, waits for `quiet_wake_rx.changed()`, and asserts the quiet wake value becomes `1`.

**Call relations**: This test exercises `handle_server_notification` and `SessionState::note_change` under asymmetric load. It demonstrates why wake notifications are separate from potentially heavier event-log publication and retention.

*Call graph*: calls 3 internal fn (connect, from_stdio, from); 14 external calls (new, from_secs, Notification, Response, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, default, channel, panic! (+4 more)).


### `exec-server/src/server/transport.rs`

`io_transport` · `startup and connection acceptance`

This file is the boundary between process startup and the per-connection JSON-RPC processor. It defines `DEFAULT_LISTEN_URL` as `ws://127.0.0.1:0`, the `ExecServerListenTransport` enum distinguishing websocket bind addresses from stdio mode, and `ExecServerListenUrlParseError`, whose `Display` implementation produces user-facing CLI error messages for unsupported or malformed listen URLs.

`parse_listen_url` accepts exactly three forms: `stdio`, `stdio://`, or `ws://IP:PORT`. Websocket URLs are parsed into `SocketAddr`, which intentionally rejects hostnames like `localhost`; anything else becomes either `InvalidWebSocketListenUrl` or `UnsupportedListenUrl`. `run_transport` is the dispatcher that parses the string and then either runs a single stdio connection or starts a websocket listener.

The stdio path is straightforward: `run_stdio_connection` forwards stdin/stdout into `run_stdio_connection_with_io`, which constructs a `ConnectionProcessor`, logs that the server is listening on stdio, wraps the streams in `JsonRpcConnection::from_stdio`, and awaits one connection to completion.

The websocket path binds a `TcpListener`, logs and prints the actual bound `ws://IP:PORT` URL, flushes stdout so supervising processes can read it immediately, and builds an Axum router. The router serves `/readyz` with HTTP 200, routes `/` to websocket upgrade handling, and applies middleware that rejects any request carrying an `Origin` header with HTTP 403. That origin check is a notable security choice: this listener is intended for local trusted clients, not browser-originated traffic. On successful upgrade, `websocket_upgrade_handler` logs the peer address and hands the websocket stream to `ConnectionProcessor::run_connection` via `JsonRpcConnection::from_axum_websocket`.

#### Function details

##### `ExecServerListenUrlParseError::fmt`  (lines 43–54)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats listen-URL parse errors into explicit CLI-facing messages. It distinguishes unsupported schemes from malformed websocket bind addresses.

**Data flow**: Matches on `self` and writes one of two fixed message templates containing the original listen URL into the formatter. It returns the standard formatting result.

**Call relations**: Used implicitly whenever parse errors are surfaced through `run_transport` to callers such as the main entrypoint.

*Call graph*: 1 external calls (write!).


##### `parse_listen_url`  (lines 59–78)

```
fn parse_listen_url(
    listen_url: &str,
) -> Result<ExecServerListenTransport, ExecServerListenUrlParseError>
```

**Purpose**: Parses the configured listen URL into either stdio mode or a websocket socket address. It enforces the server's intentionally narrow accepted syntax.

**Data flow**: Accepts a `&str` listen URL, returns `ExecServerListenTransport::Stdio` for `stdio` or `stdio://`, strips a `ws://` prefix and parses the remainder as `SocketAddr` for websocket mode, mapping parse failures to `InvalidWebSocketListenUrl`, and otherwise returns `UnsupportedListenUrl` with the original string.

**Call relations**: Called by `run_transport` before any transport startup occurs. The transport tests exercise both accepted and rejected forms to lock down this parsing contract.

*Call graph*: called by 1 (run_transport); 2 external calls (UnsupportedListenUrl, matches!).


##### `run_transport`  (lines 80–90)

```
async fn run_transport(
    listen_url: &str,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Dispatches startup into stdio or websocket serving based on the parsed listen URL. It is the transport-level entry point used by the executable.

**Data flow**: Consumes a listen URL string and `ExecServerRuntimePaths`, calls `parse_listen_url`, then matches the resulting `ExecServerListenTransport`: websocket addresses are passed to `run_websocket_listener`, while stdio mode is passed to `run_stdio_connection`. It returns any startup or serving error boxed as a trait object.

**Call relations**: Invoked by the main program flow after runtime paths are prepared. It delegates all actual serving behavior to the mode-specific helpers.

*Call graph*: calls 3 internal fn (parse_listen_url, run_stdio_connection, run_websocket_listener); called by 1 (run_main).


##### `run_stdio_connection`  (lines 92–96)

```
async fn run_stdio_connection(
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Starts the exec server over the process's stdin/stdout streams. It is the concrete implementation of stdio listen mode.

**Data flow**: Takes `ExecServerRuntimePaths`, obtains `tokio::io::stdin()` and `tokio::io::stdout()`, forwards them into `run_stdio_connection_with_io`, and returns that async result.

**Call relations**: Selected by `run_transport` when the listen URL parses as stdio. The separate helper with generic IO types exists so tests can inject duplex streams.

*Call graph*: calls 1 internal fn (run_stdio_connection_with_io); called by 1 (run_transport); 2 external calls (stdin, stdout).


##### `run_stdio_connection_with_io`  (lines 98–117)

```
async fn run_stdio_connection_with_io(
    reader: R,
    writer: W,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Runs one stdio-style JSON-RPC connection over arbitrary async reader/writer objects. It is the reusable implementation behind both production stdio mode and transport tests.

**Data flow**: Consumes a reader, writer, and `ExecServerRuntimePaths`, constructs a `ConnectionProcessor`, logs that the server is listening on stdio, wraps the IO pair in `JsonRpcConnection::from_stdio` with a fixed label, awaits `processor.run_connection(...)`, and returns `Ok(())` once the connection ends.

**Call relations**: Called by `run_stdio_connection` in production and directly by `transport_tests::stdio_listen_transport_serves_initialize`. It bridges raw byte streams into the processor's JSON-RPC event loop.

*Call graph*: calls 2 internal fn (from_stdio, new); called by 1 (run_stdio_connection); 1 external calls (info!).


##### `run_websocket_listener`  (lines 119–141)

```
async fn run_websocket_listener(
    bind_address: SocketAddr,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: Binds and serves the websocket transport, exposing both the websocket endpoint and a readiness probe. It is the concrete implementation of websocket listen mode.

**Data flow**: Consumes a `SocketAddr` and `ExecServerRuntimePaths`, binds a `TcpListener`, reads the actual local address, constructs a `ConnectionProcessor`, logs and prints `ws://{local_addr}`, flushes stdout, builds an Axum `Router` with `/` routed to `websocket_upgrade_handler`, `/readyz` routed to `readiness_handler`, and middleware `reject_requests_with_origin_header`, stores the processor in `ExecServerWebSocketState`, then awaits `axum::serve(...)`. It returns `Ok(())` after the server exits or propagates any bind/serve/flush error.

**Call relations**: Selected by `run_transport` for websocket listen URLs. It delegates per-request behavior to the middleware and upgrade handler, and per-connection protocol handling to `ConnectionProcessor`.

*Call graph*: calls 1 internal fn (new); called by 1 (run_transport); 9 external calls (new, bind, any, get, serve, info!, from_fn, println!, stdout).


##### `readiness_handler`  (lines 148–150)

```
async fn readiness_handler() -> StatusCode
```

**Purpose**: Implements the lightweight readiness endpoint for the websocket server. It always reports success.

**Data flow**: Takes no inputs and returns `StatusCode::OK`.

**Call relations**: Registered on `/readyz` by `run_websocket_listener` so external supervisors can probe whether the listener is up.


##### `reject_requests_with_origin_header`  (lines 152–166)

```
async fn reject_requests_with_origin_header(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
```

**Purpose**: Rejects HTTP requests that include an `Origin` header before they reach the websocket upgrade route. This prevents browser-originated cross-origin websocket attempts from using the local exec server.

**Data flow**: Accepts an Axum `Request<Body>` and `Next`. It checks `request.headers().contains_key(ORIGIN)`; if present, it logs a warning with method and URI and returns `Err(StatusCode::FORBIDDEN)`. Otherwise it forwards the request to `next.run(request).await` and wraps the resulting response in `Ok`.

**Call relations**: Installed as middleware by `run_websocket_listener` and therefore runs on both websocket and readiness requests. It is a transport-level guard that executes before route handlers.

*Call graph*: 3 external calls (run, headers, warn!).


##### `websocket_upgrade_handler`  (lines 168–183)

```
async fn websocket_upgrade_handler(
    websocket: WebSocketUpgrade,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    State(state): State<ExecServerWebSocketState>,
) -> impl IntoResponse
```

**Purpose**: Accepts a websocket upgrade request and launches JSON-RPC processing for the upgraded stream. It is the bridge from Axum's HTTP layer into the exec server connection loop.

**Data flow**: Receives `WebSocketUpgrade`, the peer `SocketAddr` via `ConnectInfo`, and shared `ExecServerWebSocketState`. It logs the peer address and returns `websocket.on_upgrade(...)`, where the upgrade future wraps the stream with `JsonRpcConnection::from_axum_websocket`, labels it with the peer address, and awaits `state.processor.run_connection(...)`.

**Call relations**: Registered on `/` by `run_websocket_listener`. After the HTTP upgrade succeeds, it hands control to the same `ConnectionProcessor` used by stdio mode.

*Call graph*: 2 external calls (on_upgrade, info!).


### Noise relay remote connectivity
These files layer authenticated rendezvous and relay behavior on top of exec-server transports for remote environments and executor streams.

### `exec-server/src/noise_relay/mod.rs`

`orchestration` · `startup`

This module is the top-level glue for the `noise_relay` subsystem. It declares the relay submodules (`executor_stream`, `harness`, `message_framing`, and `ordered_ciphertext`), re-exports `NoiseHarnessConnectionArgs` and `noise_harness_connection_from_websocket` for external callers, and defines constants that shape protocol behavior. `NOISE_RELAY_RESET_REASON` is the canonical reset string used when the relay aborts due to protocol errors.

The file also sets a websocket-level allocation bound with `MAX_NOISE_RELAY_WEBSOCKET_MESSAGE_SIZE` at 256 KiB. That limit is intentionally larger than a maximum Noise record plus framing overhead, so tungstenite rejects oversized websocket frames before protobuf parsing or Noise validation allocates more memory. `noise_relay_websocket_config` packages those limits into a `tokio_tungstenite::tungstenite::protocol::WebSocketConfig` used by every relay endpoint.

Finally, `take_next_sequence` encapsulates relay sequence-number advancement for outbound records. The sequence is not allowed to wrap because it doubles as the explicit ordering key for an implicit Noise nonce; reusing zero after `u32::MAX` would make nonce interpretation ambiguous and unsafe. Instead, exhaustion becomes a protocol error. This file therefore captures subsystem-wide invariants rather than implementing the relay data path itself.

#### Function details

##### `noise_relay_websocket_config`  (lines 20–24)

```
fn noise_relay_websocket_config() -> WebSocketConfig
```

**Purpose**: Builds the websocket configuration required by Noise relay connections, with both frame and message sizes capped to the relay’s maximum accepted websocket payload. It ensures transport-level allocation limits are applied consistently across relay entry points.

**Data flow**: It takes no arguments, starts from `WebSocketConfig::default()`, sets `max_frame_size` and `max_message_size` to `Some(MAX_NOISE_RELAY_WEBSOCKET_MESSAGE_SIZE)`, and returns the configured `WebSocketConfig` value.

**Call relations**: Relay setup code such as `connect_noise_rendezvous` and `run_remote_environment` calls this during websocket establishment. The function delegates only to tungstenite’s builder-style setters and serves as the shared source of truth for relay websocket limits.

*Call graph*: called by 2 (connect_noise_rendezvous, run_remote_environment); 1 external calls (default).


##### `take_next_sequence`  (lines 26–34)

```
fn take_next_sequence(next_seq: &mut u32) -> Result<u32, ExecServerError>
```

**Purpose**: Returns the current outbound relay sequence number and advances the caller’s counter by one without allowing wraparound. It turns sequence exhaustion into a protocol error instead of silently reusing values.

**Data flow**: It takes `&mut u32` holding the next sequence, copies out the current value, attempts `checked_add(1)`, writes the incremented value back on success, and returns the original sequence. If incrementing would overflow, it returns `ExecServerError::Protocol("Noise relay sequence number exhausted")` and leaves the caller with an explicit failure.

**Call relations**: Outbound relay code in `spawn_noise_virtual_stream` invokes this whenever it needs a fresh ordering key for a ciphertext record. The helper does not delegate further; its role is to enforce the nonce/ordering invariant in one place.

*Call graph*: called by 1 (spawn_noise_virtual_stream).


### `exec-server/src/noise_relay/harness.rs`

`orchestration` · `connection setup and encrypted request handling`

This file is the harness counterpart to the executor-side Noise relay stream. `NoiseHarnessConnectionArgs` groups the registry-derived values needed to bind one websocket to one executor registration: environment ID, registration ID, harness identity, pinned responder public key, and short-lived harness authorization. `noise_harness_connection_from_websocket` immediately creates a `JsonRpcConnection` backed by channels and a background websocket task; the connection is only usable once that task completes the Noise handshake.

The task first generates a fresh `stream_id`, derives a transcript-binding prologue with `noise_channel_prologue`, and starts `InitiatorHandshake::start`, embedding the authorization bytes in the first encrypted IK message. It then sends cleartext relay `resume` and `handshake` frames. During handshake, it ignores unrelated streams and benign control frames, but any `Data` frame on the claimed stream is treated as a protocol violation and causes disconnect; this prevents an unauthenticated plaintext path. Once a valid handshake response arrives for the correct stream, `finish` yields a `NoiseTransport`.

After that, a `tokio::select!` loop multiplexes outbound JSON-RPC and inbound websocket frames. Outbound messages are framed, split into `NOISE_RECORD_PLAINTEXT_LEN` chunks, assigned monotonically increasing relay sequence numbers, encrypted exactly once, and sent as relay `Data` frames. Inbound binary frames are decoded, filtered by `stream_id`, validated by relay body kind, reordered with `OrderedCiphertextFrames`, decrypted with the shared transport state, and reassembled into complete JSON-RPC messages via `JsonRpcMessageDecoder`. Reset frames are surfaced as a sanitized disconnect reason, malformed or unexpected frames become `MalformedMessage` events, and all terminal paths set the disconnected watch channel.

#### Function details

##### `noise_harness_connection_from_websocket`  (lines 69–401)

```
fn noise_harness_connection_from_websocket(
    stream: T,
    args: NoiseHarnessConnectionArgs,
) -> JsonRpcConnection
```

**Purpose**: Wraps one rendezvous websocket as a Noise-authenticated `JsonRpcConnection`, performing the initiator handshake in a background task and then relaying encrypted JSON-RPC traffic. It is the main harness-side entrypoint for the Noise relay.

**Data flow**: It destructures `NoiseHarnessConnectionArgs`, generates a fresh UUID `stream_id`, creates outgoing/incoming/disconnected channels, and spawns an instrumented websocket task. That task computes the prologue with `noise_channel_prologue`, starts the initiator handshake with `InitiatorHandshake::start`, sends relay `resume` and `handshake` frames, then loops reading websocket messages until it receives a valid handshake response for the same `stream_id`. On any startup or handshake failure it calls `send_disconnected`. After handshake completion it initializes `next_outbound_seq`, `OrderedCiphertextFrames`, and `JsonRpcMessageDecoder`, then enters a `tokio::select!` loop: outgoing JSON-RPC messages are framed, chunked, sequenced with `take_next_sequence`, encrypted with `transport.encrypt`, wrapped in `RelayMessageFrame::data`, encoded, and sent on the websocket; incoming websocket binary frames are decoded with `decode_relay_message_frame`, filtered by `stream_id`, validated, and either passed to `receive_data`, converted into a sanitized disconnect on reset, ignored for benign control frames, or reported as malformed. On loop exit it sends `true` on `disconnected_tx`. The function returns `JsonRpcConnection { outgoing_tx, incoming_rx, disconnected_rx, task_handles, transport: JsonRpcTransport::Plain }` immediately.

**Call relations**: Higher-level harness code calls this to establish a remote exec-server connection over rendezvous. It delegates transcript binding to `noise_channel_prologue`, handshake startup to `InitiatorHandshake::start`, inbound data processing to `receive_data`, and terminal event emission to `send_disconnected`/`send_malformed`.

*Call graph*: calls 5 internal fn (start, noise_channel_prologue, send_disconnected, decode_relay_message_frame, encode_relay_message_frame); 15 external calls (new_v4, debug!, default, default, handshake, resume, format!, info!, channel, select! (+5 more)).


##### `receive_data`  (lines 406–431)

```
async fn receive_data(
    inbound_ciphertexts: &mut OrderedCiphertextFrames,
    transport: &mut NoiseTransport,
    decoder: &mut JsonRpcMessageDecoder,
    data: RelayData,
    incoming_tx: &mpsc::
```

**Purpose**: Processes one post-handshake relay data frame by ordering ciphertext records, decrypting them, decoding JSON-RPC messages, and forwarding complete messages to the connection. It is the harness-side inbound data path.

**Data flow**: It pushes `data.seq` and `data.payload` into `inbound_ciphertexts`, iterates any completed ciphertext records returned, decrypts each with `transport.decrypt`, maps decryption failures into `ExecServerError::Protocol`, feeds plaintext into `decoder.push(&plaintext)`, and asynchronously sends each decoded message as `JsonRpcConnectionEvent::Message(message)` on `incoming_tx`, mapping send failure to `ExecServerError::Closed`.

**Call relations**: Called only from the post-handshake branch of `noise_harness_connection_from_websocket`. It mirrors the executor-side receive path but uses async `send` instead of `try_send`.

*Call graph*: calls 3 internal fn (decrypt, push, push); 2 external calls (send, Message).


##### `send_malformed`  (lines 433–437)

```
async fn send_malformed(incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>, reason: String)
```

**Purpose**: Emits a `MalformedMessage` event into the connection’s inbound queue. It is the helper used when relay framing or post-handshake protocol validation fails.

**Data flow**: It asynchronously sends `JsonRpcConnectionEvent::MalformedMessage { reason }` on `incoming_tx` and ignores send failure.

**Call relations**: Used by `noise_harness_connection_from_websocket` when a binary frame cannot be decoded, converted, or validated after the handshake.

*Call graph*: 1 external calls (send).


##### `send_disconnected`  (lines 439–450)

```
async fn send_disconnected(
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    disconnected_tx: &watch::Sender<bool>,
    reason: String,
)
```

**Purpose**: Marks the connection disconnected and emits a disconnect event with a reason string. It is the helper for handshake-time and transport-level terminal failures.

**Data flow**: It sends `true` on `disconnected_tx`, then asynchronously sends `JsonRpcConnectionEvent::Disconnected { reason: Some(reason) }` on `incoming_tx`, ignoring failures.

**Call relations**: Called from many early-return branches in `noise_harness_connection_from_websocket`, especially during handshake setup and validation failures.

*Call graph*: called by 1 (noise_harness_connection_from_websocket); 1 external calls (send).


### `exec-server/src/noise_relay/executor_stream.rs`

`orchestration` · `encrypted request handling`

This file models a single logical JSON-RPC stream multiplexed over the executor’s physical relay connection. `NoiseVirtualStream` owns the inbound side: an `mpsc::Sender<JsonRpcConnectionEvent>` for delivering parsed messages or disconnects, a `watch::Sender<bool>` for disconnected state, a shared `Arc<Mutex<NoiseTransport>>`, an `OrderedCiphertextFrames` reorder buffer, a `JsonRpcMessageDecoder` for post-decryption message reassembly, and an `instance_id` used to distinguish reused relay `stream_id`s.

The key design constraint is that `NoiseTransport` contains both send and receive nonce state, so reads and writes share one mutex-protected transport object. The mutex is only held around immediate `encrypt`/`decrypt` calls and never across `.await`, preventing deadlocks while preserving nonce correctness. `receive_data` is intentionally nonblocking because all virtual streams share the physical read loop: it reorders ciphertext segments by relay sequence, decrypts each completed record, decodes one or more JSON-RPC messages from the authenticated plaintext stream, and uses `try_send` so an overloaded or abandoned stream fails independently instead of stalling the whole relay.

`spawn_noise_virtual_stream` creates the paired `JsonRpcConnection`, spawns a writer task that frames outgoing JSON-RPC, splits it into `NOISE_RECORD_PLAINTEXT_LEN` chunks, assigns relay sequence numbers with `take_next_sequence`, encrypts each chunk, and sends `RelayMessageFrame::data` frames to the physical relay. On writer exit it best-effort sends a reset frame and always reports `ClosedNoiseVirtualStream { stream_id, instance_id }`. A second task runs the supplied `ConnectionProcessor` and also reports closure on exit, making stream-ID reuse safe even if delayed notifications arrive.

#### Function details

##### `NoiseVirtualStream::disconnect`  (lines 56–61)

```
fn disconnect(self, reason: Option<String>)
```

**Purpose**: Marks the virtual stream disconnected and injects a disconnect event into its inbound JSON-RPC queue. It is the local shutdown path for one stream instance.

**Data flow**: It consumes `self`, sends `true` on `disconnected_tx`, then best-effort `try_send`s `JsonRpcConnectionEvent::Disconnected { reason }` on `incoming_tx`.

**Call relations**: Called by higher-level relay management when a stream must be torn down locally. It does not await, preserving the nonblocking nature of stream cleanup.

*Call graph*: 2 external calls (send, try_send).


##### `NoiseVirtualStream::receive_data`  (lines 65–87)

```
fn receive_data(&mut self, data: RelayData) -> Result<(), ExecServerError>
```

**Purpose**: Processes one inbound relay data frame for this stream by reordering, decrypting, decoding, and queueing complete JSON-RPC messages. It is the executor-side inbound data path after handshake completion.

**Data flow**: It pushes `data.seq` and `data.payload` into `self.inbound_ciphertexts`, iterates any completed ciphertext records returned, locks `self.transport` to call `decrypt`, maps decryption failures into `ExecServerError::Protocol`, feeds each plaintext into `self.inbound_decoder.push(&plaintext)`, and `try_send`s each decoded message as `JsonRpcConnectionEvent::Message(message)`. If the queue is full or closed, it returns a protocol error.

**Call relations**: The environment read loop calls this whenever a `RelayData` frame arrives for the stream. It depends on `OrderedCiphertextFrames` and `JsonRpcMessageDecoder` to restore record and message boundaries before handing data to the JSON-RPC layer.

*Call graph*: calls 2 internal fn (push, push); 2 external calls (try_send, Message).


##### `spawn_noise_virtual_stream`  (lines 94–189)

```
fn spawn_noise_virtual_stream(
    stream_id: String,
    instance_id: u64,
    processor: ConnectionProcessor,
    physical_outgoing_tx: mpsc::Sender<Vec<u8>>,
    closed_stream_tx: mpsc::Sender<Clos
```

**Purpose**: Creates a completed executor-side virtual stream, starts its outbound writer task and JSON-RPC processor task, and returns the inbound/read half. It is the constructor that turns a finished Noise handshake into a live `JsonRpcConnection`.

**Data flow**: It creates outgoing/incoming/disconnected channels, wraps the supplied `NoiseTransport` in `Arc<Mutex<_>>`, clones IDs and senders for task ownership, and spawns a writer task. That task receives JSON-RPC messages from `json_outgoing_rx`, frames them with `frame_jsonrpc_message`, splits them into `NOISE_RECORD_PLAINTEXT_LEN` plaintext records, allocates relay sequence numbers with `take_next_sequence`, locks the shared transport to `encrypt` each record, wraps ciphertext in `RelayMessageFrame::data`, encodes it with `encode_relay_message_frame`, and sends it on `physical_outgoing_tx`. On exit it best-effort sends a reset frame and then sends `ClosedNoiseVirtualStream { stream_id, instance_id }` on `closed_stream_tx`. The function also constructs `JsonRpcConnection { outgoing_tx, incoming_rx, disconnected_rx, task_handles, transport: JsonRpcTransport::Plain }`, spawns `processor.run_connection(connection)` and reports closure again when that task exits, then returns `NoiseVirtualStream` with fresh inbound reorder/decoder state.

**Call relations**: Called after a successful executor-side Noise handshake. It delegates outbound framing to `frame_jsonrpc_message`, sequence management to `take_next_sequence`, encryption to `NoiseTransport::encrypt`, and application processing to `ConnectionProcessor::run_connection`.

*Call graph*: calls 5 internal fn (encrypt, frame_jsonrpc_message, take_next_sequence, encode_relay_message_frame, run_connection); 15 external calls (clone, new, new, clone, send, try_send, default, default, data, reset (+5 more)).


### `exec-server/src/remote.rs`

`orchestration` · `startup`

This file is the remote-execution control plane. `EnvironmentRegistryClient` wraps a normalized base URL, a shared auth provider, and a `reqwest::Client` configured with redirects disabled so bearer-style headers are never forwarded to redirect targets. Its `register_environment` method POSTs the executor’s `NoiseChannelPublicKey` and the fixed `NOISE_RELAY_SECURITY_PROFILE` to `/cloud/environment/{environment_id}/register`, parses the JSON response, and then verifies that the registry echoed the requested environment id and supported security profile before returning the rendezvous URL and executor registration id.

`RegistryHarnessKeyValidator` implements the relay’s `HarnessKeyValidator` trait by POSTing the authenticated harness public key, short-lived authorization string, and executor registration id to `/cloud/environment/{environment_id}/validate`. The implementation is intentionally fail-closed and privacy-conscious: non-success statuses become generic auth/HTTP errors without including response bodies that might echo the authorization token, and a JSON response must explicitly contain `valid: true`.

`RemoteEnvironmentConfig` stores the registry base URL, normalized environment id, a default name, and redacted auth provider. `run_remote_environment` is the orchestration loop: it ensures the rustls crypto provider is installed, creates one long-lived executor Noise identity, registers once to obtain rendezvous allocation, then repeatedly connects to the returned websocket URL using `noise_relay_websocket_config`. Successful connections reset exponential backoff and hand the socket to `run_multiplexed_environment` with a fresh `RegistryHarnessKeyValidator`. If websocket connection fails with an HTTP 4xx, the code treats the registration as rejected and re-registers before retrying; otherwise it sleeps with capped exponential backoff. Helper functions normalize config strings, build endpoint URLs, and convert registry error bodies into `ExecServerError` variants with bounded body previews and redacted debug output. The tests verify auth headers, redirect refusal, and debug redaction.

#### Function details

##### `EnvironmentRegistryClient::fmt`  (lines 35–40)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the registry client for debugging while redacting the auth provider contents. It exposes only safe structural fields.

**Data flow**: It reads `self.base_url`, inserts that into a `debug_struct`, substitutes the literal `"<redacted>"` for `auth_provider`, marks the output non-exhaustive, and writes the formatted representation into the provided formatter.

**Call relations**: This is used implicitly by Rust formatting and tests that inspect debug output. Its role is defensive observability rather than runtime control flow.

*Call graph*: 1 external calls (debug_struct).


##### `EnvironmentRegistryClient::new`  (lines 44–53)

```
fn new(base_url: String, auth_provider: SharedAuthProvider) -> Result<Self, ExecServerError>
```

**Purpose**: Constructs a registry client with a normalized base URL and an HTTP client that will not follow redirects. This prevents auth headers from being replayed to redirected destinations.

**Data flow**: It takes a `base_url: String` and `SharedAuthProvider`, trims and validates the URL via `normalize_base_url`, builds a `reqwest::Client` with `redirect(Policy::none())`, and returns `EnvironmentRegistryClient` or an `ExecServerError` if normalization or client construction fails.

**Call relations**: It is called during remote environment startup and by tests that exercise registration and validation behavior. The resulting client is later used by both `register_environment` and `RegistryHarnessKeyValidator::validate_harness_key`.

*Call graph*: calls 1 internal fn (normalize_base_url); called by 5 (validate_harness_key_does_not_expose_error_body, validate_harness_key_requires_explicit_valid_response, run_remote_environment, register_environment_does_not_follow_redirects_with_auth_headers, register_environment_posts_with_auth_provider_headers); 2 external calls (builder, none).


##### `EnvironmentRegistryClient::register_environment`  (lines 57–100)

```
async fn register_environment(
        &self,
        environment_id: &str,
        executor_public_key: &NoiseChannelPublicKey,
    ) -> Result<EnvironmentRegistryRegistrationResponse, ExecServerErro
```

**Purpose**: Registers the executor’s public key with the environment registry and retrieves the rendezvous allocation needed to accept remote connections.

**Data flow**: It takes `environment_id` and `executor_public_key`, builds the `/register` endpoint URL, adds auth headers from the shared provider, serializes `EnvironmentRegistryRegistrationRequest`, sends the POST, and parses the response through `parse_json_response`. It then checks that `response.environment_id` matches the requested id and that `response.security_profile` equals `NOISE_RELAY_SECURITY_PROFILE`, logging success details before returning the typed response or a protocol error.

**Call relations**: It is called by `run_remote_environment` initially and again when rendezvous rejects a stale registration. It delegates HTTP error handling to `parse_json_response` and URL construction to `endpoint_url`.

*Call graph*: calls 2 internal fn (parse_json_response, endpoint_url); 6 external calls (to_auth_headers, post, debug!, Protocol, format!, info!).


##### `EnvironmentRegistryClient::parse_json_response`  (lines 102–120)

```
async fn parse_json_response(
        &self,
        response: reqwest::Response,
    ) -> Result<R, ExecServerError>
```

**Purpose**: Parses a registry HTTP response into a typed JSON body on success or converts failures into structured registry-specific errors.

**Data flow**: It takes a `reqwest::Response`. If `status().is_success()` it deserializes `response.json::<R>()` and returns the typed value. Otherwise it reads the response text, maps `401` and `403` to `environment_registry_auth_error`, and maps all other statuses to `environment_registry_http_error`.

**Call relations**: It is used by `register_environment` after the POST completes. Its separation keeps registration logic focused on semantic checks while centralizing status/body error translation.

*Call graph*: calls 2 internal fn (environment_registry_auth_error, environment_registry_http_error); called by 1 (register_environment); 3 external calls (status, text, matches!).


##### `RegistryHarnessKeyValidator::validate_harness_key`  (lines 160–205)

```
async fn validate_harness_key(
        &self,
        harness_public_key: &NoiseChannelPublicKey,
        authorization: &str,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Asks the environment registry whether a Noise-authenticated harness public key and authorization token are allowed to use this executor registration. It is the production authorization gate for multiplexed relay handshakes.

**Data flow**: It reads `self.environment_id`, `self.executor_registration_id`, and the embedded `EnvironmentRegistryClient`, builds the `/validate` endpoint URL, adds auth headers, serializes `EnvironmentRegistryHarnessKeyValidationRequest`, and sends the POST. Non-success statuses become either `ExecServerError::EnvironmentRegistryAuth` for `401/403` or a generic `ExecServerError::EnvironmentRegistryHttp` message that intentionally omits the response body. On success it deserializes `EnvironmentRegistryHarnessKeyValidationResponse` and returns `Ok(())` only if `valid` is `true`; otherwise it returns `ExecServerError::Protocol`.

**Call relations**: Instances of this validator are created inside `run_remote_environment` and passed into `run_multiplexed_environment`, which invokes the trait method during pending handshake authorization. It delegates endpoint formatting to `endpoint_url` but keeps response-body redaction local because the request contains sensitive authorization text.

*Call graph*: calls 1 internal fn (endpoint_url); 4 external calls (EnvironmentRegistryAuth, Protocol, format!, matches!).


##### `RemoteEnvironmentConfig::fmt`  (lines 218–225)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats remote environment configuration for debugging while redacting the auth provider internals.

**Data flow**: It reads `base_url`, `environment_id`, and `name`, inserts them into a debug struct, substitutes `"<redacted>"` for `auth_provider`, and writes the result to the formatter.

**Call relations**: It is used by debug formatting and tested explicitly to ensure credentials are not leaked through logs or diagnostics.

*Call graph*: 1 external calls (debug_struct).


##### `RemoteEnvironmentConfig::new`  (lines 229–241)

```
fn new(
        base_url: String,
        environment_id: String,
        auth_provider: SharedAuthProvider,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds validated configuration for remote registration, normalizing the environment id and assigning the default executor name.

**Data flow**: It takes `base_url`, `environment_id`, and `auth_provider`, trims and validates the environment id via `normalize_environment_id`, then returns `RemoteEnvironmentConfig { base_url, environment_id, name: "codex-exec-server", auth_provider }`.

**Call relations**: It is called by higher-level command setup and tests. The resulting config is consumed by `run_remote_environment`.

*Call graph*: calls 1 internal fn (normalize_environment_id); called by 4 (run_exec_server_command, reconnect_reuses_registration_until_url_is_rejected, debug_output_redacts_auth_provider, remote_environment_routes_encrypted_exec_server_rpc).


##### `run_remote_environment`  (lines 250–320)

```
async fn run_remote_environment(
    config: RemoteEnvironmentConfig,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), ExecServerError>
```

**Purpose**: Runs the long-lived remote executor loop: register with the registry, connect to rendezvous, serve multiplexed Noise streams, and reconnect with backoff when disconnected.

**Data flow**: It takes `RemoteEnvironmentConfig` and `ExecServerRuntimePaths`, installs the rustls crypto provider, constructs an `EnvironmentRegistryClient`, a `ConnectionProcessor`, and one generated `NoiseChannelIdentity`, then registers the environment to obtain a rendezvous URL and executor registration id. In an infinite loop it attempts `connect_async_with_config` using `noise_relay_websocket_config`; on success it resets backoff, logs connection success, and awaits `run_multiplexed_environment` with cloned processor/identity and a `RegistryHarnessKeyValidator`. On websocket error it logs the failure, detects whether the error was an HTTP client error indicating registration rejection, and if so re-registers before retrying. After each iteration it sleeps for the current backoff and doubles it up to 30 seconds.

**Call relations**: This is the production entry into the remote relay subsystem. It orchestrates `EnvironmentRegistryClient::new`, `register_environment`, websocket connection setup, and `run_multiplexed_environment`, and it is exercised by reconnect-focused tests.

*Call graph*: calls 5 internal fn (generate, noise_relay_websocket_config, run_multiplexed_environment, new, new); 8 external calls (from_secs, ensure_rustls_crypto_provider, debug!, info!, matches!, sleep, connect_async_with_config, warn!).


##### `normalize_environment_id`  (lines 322–330)

```
fn normalize_environment_id(environment_id: String) -> Result<String, ExecServerError>
```

**Purpose**: Trims and validates the configured environment id, rejecting empty values with a configuration-specific error.

**Data flow**: It takes an owned `String`, trims whitespace, converts it back to `String`, and returns it if nonempty; otherwise it returns `ExecServerError::EnvironmentRegistryConfig` with a fixed explanatory message.

**Call relations**: It is called only by `RemoteEnvironmentConfig::new` during configuration construction.

*Call graph*: called by 1 (new); 1 external calls (EnvironmentRegistryConfig).


##### `normalize_base_url`  (lines 343–351)

```
fn normalize_base_url(base_url: String) -> Result<String, ExecServerError>
```

**Purpose**: Normalizes the registry base URL by trimming whitespace and removing trailing slashes, while rejecting empty results.

**Data flow**: It takes an owned `String`, applies `trim()` and `trim_end_matches('/')`, and returns the normalized string if nonempty; otherwise it returns `ExecServerError::EnvironmentRegistryConfig`.

**Call relations**: It is called by `EnvironmentRegistryClient::new` before any HTTP client is built.

*Call graph*: called by 1 (new); 1 external calls (EnvironmentRegistryConfig).


##### `endpoint_url`  (lines 353–355)

```
fn endpoint_url(base_url: &str, path: &str) -> String
```

**Purpose**: Joins a normalized base URL and endpoint path into one absolute URL string without duplicating slashes.

**Data flow**: It takes `base_url: &str` and `path: &str`, strips any leading slash from `path`, formats `"{base_url}/{path}"`, and returns the resulting `String`.

**Call relations**: It is used by both registry POST methods to build `/register` and `/validate` URLs.

*Call graph*: called by 2 (register_environment, validate_harness_key); 1 external calls (format!).


##### `environment_registry_auth_error`  (lines 357–362)

```
fn environment_registry_auth_error(status: StatusCode, body: &str) -> ExecServerError
```

**Purpose**: Builds an authentication-specific registry error from an HTTP status and response body preview.

**Data flow**: It takes a `StatusCode` and raw body text, extracts a message with `registry_error_message` or falls back to `"empty error body"`, and returns `ExecServerError::EnvironmentRegistryAuth` containing the status and message.

**Call relations**: It is called by `EnvironmentRegistryClient::parse_json_response` for `401` and `403` responses.

*Call graph*: calls 1 internal fn (registry_error_message); called by 1 (parse_json_response); 2 external calls (EnvironmentRegistryAuth, format!).


##### `environment_registry_http_error`  (lines 364–388)

```
fn environment_registry_http_error(status: StatusCode, body: &str) -> ExecServerError
```

**Purpose**: Builds a structured non-auth registry HTTP error, preserving an optional registry error code and a bounded message preview.

**Data flow**: It takes a `StatusCode` and body text, tries to parse `RegistryErrorBody`, extracts `error.code` and `error.message` when present, otherwise falls back to `preview_error_body` or fixed empty/malformed messages, and returns `ExecServerError::EnvironmentRegistryHttp { status, code, message }`.

**Call relations**: It is called by `EnvironmentRegistryClient::parse_json_response` for all non-success, non-auth statuses. Its parsing logic is shared by registration failures but not by harness-key validation, which intentionally avoids body inclusion.

*Call graph*: called by 1 (parse_json_response).


##### `registry_error_message`  (lines 390–396)

```
fn registry_error_message(body: &str) -> Option<String>
```

**Purpose**: Extracts a human-readable message from a registry error body if possible, with fallback to a trimmed preview of the raw body.

**Data flow**: It attempts to deserialize `RegistryErrorBody`, then drills into `body.error.message`; if that is absent it falls back to `preview_error_body(body)`. It returns `Option<String>`.

**Call relations**: It is used by `environment_registry_auth_error` to produce a more informative auth failure message.

*Call graph*: called by 1 (environment_registry_auth_error).


##### `preview_error_body`  (lines 398–404)

```
fn preview_error_body(body: &str) -> Option<String>
```

**Purpose**: Returns a trimmed, length-limited preview of an HTTP error body for diagnostics.

**Data flow**: It trims the input `&str`; if the result is empty it returns `None`, otherwise it collects up to `ERROR_BODY_PREVIEW_BYTES` characters into a new `String` and returns `Some(...)`.

**Call relations**: It is used by registry error formatting helpers as a safe fallback when structured JSON error parsing fails or lacks a message.


##### `tests::StaticRegistryAuthProvider::add_auth_headers`  (lines 428–437)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds fixed authorization headers used by remote registry tests.

**Data flow**: It mutates the provided `HeaderMap`, inserting `Authorization: Bearer registry-token` and `ChatGPT-Account-ID: workspace-123`.

**Call relations**: Tests wrap this provider in `SharedAuthProvider` and pass it into config/client constructors to verify header propagation and redaction behavior.

*Call graph*: 2 external calls (insert, from_static).


##### `tests::static_registry_auth_provider`  (lines 440–442)

```
fn static_registry_auth_provider() -> SharedAuthProvider
```

**Purpose**: Constructs the shared test auth provider used by registry client tests.

**Data flow**: It allocates `StaticRegistryAuthProvider` inside an `Arc` and returns it as `SharedAuthProvider`.

**Call relations**: It is a fixture helper used by the registration and debug-redaction tests in this file.

*Call graph*: 1 external calls (new).


##### `tests::register_environment_posts_with_auth_provider_headers`  (lines 445–483)

```
async fn register_environment_posts_with_auth_provider_headers()
```

**Purpose**: Verifies that environment registration sends the expected auth headers and JSON body, and that the typed response is parsed correctly.

**Data flow**: The test starts a `wiremock::MockServer`, generates an executor public key, installs a mock expecting a POST to the `/register` path with both auth headers and the expected JSON fields, constructs an `EnvironmentRegistryClient`, calls `register_environment`, and asserts that the returned `EnvironmentRegistryRegistrationResponse` matches the mocked payload.

**Call relations**: It exercises `EnvironmentRegistryClient::new` and `register_environment` together, validating request construction and response parsing.

*Call graph*: calls 2 internal fn (generate, new); 10 external calls (given, start, new, assert_eq!, static_registry_auth_provider, json!, body_partial_json, header, method, path).


##### `tests::register_environment_does_not_follow_redirects_with_auth_headers`  (lines 486–521)

```
async fn register_environment_does_not_follow_redirects_with_auth_headers()
```

**Purpose**: Ensures the registry client does not follow redirects, preventing auth headers from being forwarded to a redirected target.

**Data flow**: The test starts a mock server, configures `/register` to return `302 Found` with a `Location` header, configures the redirect target to expect zero authorized requests, constructs the client, calls `register_environment`, and asserts that the result is an `ExecServerError::EnvironmentRegistryHttp` with `StatusCode::FOUND`.

**Call relations**: It specifically validates the redirect policy configured in `EnvironmentRegistryClient::new` and the non-success handling path in `register_environment`.

*Call graph*: calls 2 internal fn (generate, new); 9 external calls (given, start, new, assert!, static_registry_auth_provider, format!, header, method, path).


##### `tests::debug_output_redacts_auth_provider`  (lines 524–536)

```
fn debug_output_redacts_auth_provider()
```

**Purpose**: Checks that formatting `RemoteEnvironmentConfig` for debugging does not leak auth-provider details.

**Data flow**: It constructs a `RemoteEnvironmentConfig` with the static test auth provider, formats it with `format!("{config:?}")`, and asserts that the output contains `<redacted>` but not the workspace identifier.

**Call relations**: It exercises the custom `Debug` implementation for `RemoteEnvironmentConfig`.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, static_registry_auth_provider, format!).


### `exec-server/src/client_transport.rs`

`io_transport` · `connection establishment and transport bootstrap`

This file is responsible for the part of client startup that depends on the physical transport. `ExecServerClient::connect_for_transport` is the dispatcher: it matches `ExecServerTransportParams` and constructs the appropriate argument bundle for websocket, Noise rendezvous, or stdio command transports, always using the fixed environment-facing client name `codex-environment` and no resume session id in this path.

`connect_websocket` ensures the Rustls crypto provider is installed, opens a websocket under a timeout, maps timeout and tungstenite failures into transport-specific `ExecServerError` variants, and then decides how to wrap the websocket. If the URL query contains `role=harness`, `is_rendezvous_harness_url` selects `harness_connection_from_websocket`; otherwise it uses a plain `JsonRpcConnection::from_websocket`. The resulting connection is passed to the common `ExecServerClient::connect` handshake path.

`connect_noise_rendezvous` performs a similar websocket open, but first unpacks a single-use `NoiseRendezvousConnectBundle`, strips query/fragment data from the URL for diagnostics, applies `noise_relay_websocket_config`, and wraps the websocket with `noise_harness_connection_from_websocket` using the environment id, executor registration id, pinned executor public key, harness identity, and authorization token. This ensures the websocket carries only ciphertext before JSON-RPC begins.

`connect_stdio_command` spawns a child process with piped stdio, validates that stdin/stdout are present, spawns a background task to log stderr lines, and creates a stdio `JsonRpcConnection` that owns the child process for cleanup. `stdio_command_process` centralizes command construction, environment injection, optional cwd, and Unix process-group setup.

#### Function details

##### `ExecServerClient::connect_for_transport`  (lines 34–80)

```
async fn connect_for_transport(
        transport_params: crate::client_api::ExecServerTransportParams,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Dispatches from the abstract transport enum to the concrete websocket, Noise rendezvous, or stdio connection routine. It is the top-level transport bootstrap entry point.

**Data flow**: It takes `ExecServerTransportParams` and matches it. For `WebSocketUrl`, it builds `RemoteExecServerConnectArgs` with the environment client name and forwards to `connect_websocket`; for `NoiseRendezvous`, it asks the provider for a fresh bundle using the harness public key, builds `NoiseRendezvousConnectArgs`, and forwards to `connect_noise_rendezvous`; for `StdioCommand`, it builds `StdioExecServerConnectArgs` and forwards to `connect_stdio_command`. It returns the connected `ExecServerClient` or an `ExecServerError`.

**Call relations**: Called by `LazyRemoteExecServerClient::get` when it needs to establish or replace an underlying client, and by tests covering transport dispatch. It delegates all transport-specific work to the three concrete connection methods.

*Call graph*: 3 external calls (connect_noise_rendezvous, connect_stdio_command, connect_websocket).


##### `ExecServerClient::connect_websocket`  (lines 82–106)

```
async fn connect_websocket(
        args: RemoteExecServerConnectArgs,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Opens a websocket transport to an exec-server, wraps it as the appropriate JSON-RPC connection type, and runs the common client initialization handshake. It also recognizes rendezvous harness URLs that need a special websocket wrapper.

**Data flow**: It takes `RemoteExecServerConnectArgs`, ensures the Rustls provider is installed, clones the URL and timeout for error reporting, awaits `connect_async(websocket_url.as_str())` under `timeout(connect_timeout, ...)`, maps timeout to `ExecServerError::WebSocketConnectTimeout` and tungstenite errors to `ExecServerError::WebSocketConnect`, builds a connection label string, chooses `harness_connection_from_websocket` if `is_rendezvous_harness_url(&websocket_url)` is true or `JsonRpcConnection::from_websocket` otherwise, then calls `Self::connect(connection, args.into()).await`.

**Call relations**: Used by `connect_for_transport` for plain websocket transports and potentially by direct callers. It delegates post-transport setup to `ExecServerClient::connect` and uses `is_rendezvous_harness_url` to select the correct websocket wrapper.

*Call graph*: calls 3 internal fn (is_rendezvous_harness_url, from_websocket, harness_connection_from_websocket); 6 external calls (connect, ensure_rustls_crypto_provider, into, format!, timeout, connect_async).


##### `ExecServerClient::connect_noise_rendezvous`  (lines 111–176)

```
async fn connect_noise_rendezvous(
        args: NoiseRendezvousConnectArgs,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Connects to an exec-server through an authenticated Noise rendezvous websocket, pinning the executor key before JSON-RPC starts. It is the secure remote transport path.

**Data flow**: It takes `NoiseRendezvousConnectArgs`, ensures the Rustls provider is installed, destructures the args and embedded bundle, derives a `diagnostic_url` by stripping query/fragment components, opens the websocket with `connect_async_with_config` and `noise_relay_websocket_config()` under the supplied timeout, maps timeout/connect failures into websocket-specific `ExecServerError`s using the diagnostic URL, builds a connection label, wraps the websocket with `noise_harness_connection_from_websocket` using `NoiseHarnessConnectionArgs` populated from the bundle and harness identity, then calls `Self::connect(connection, ExecServerClientConnectOptions { client_name, initialize_timeout, resume_session_id }).await`.

**Call relations**: Called by `connect_for_transport` after a provider supplies a fresh rendezvous bundle. It delegates the common JSON-RPC client setup to `ExecServerClient::connect` after transport-level authentication and encryption are established.

*Call graph*: calls 1 internal fn (noise_relay_websocket_config); 6 external calls (connect, ensure_rustls_crypto_provider, noise_harness_connection_from_websocket, format!, timeout, connect_async_with_config).


##### `ExecServerClient::connect_stdio_command`  (lines 178–216)

```
async fn connect_stdio_command(
        args: StdioExecServerConnectArgs,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Spawns an exec-server subprocess and connects to it over piped stdio. It also logs the child’s stderr asynchronously and ties child-process lifetime to the JSON-RPC connection.

**Data flow**: It takes `StdioExecServerConnectArgs`, builds a `tokio::process::Command` via `stdio_command_process(&args.command)`, configures piped stdin/stdout/stderr, spawns the child, extracts stdin and stdout or returns `ExecServerError::Protocol` if either is missing, and if stderr is present spawns a task that reads lines and logs them with `debug!`, warning on read errors. It then creates `JsonRpcConnection::from_stdio(stdout, stdin, "exec-server stdio command".to_string()).with_child_process(child)` and passes that plus `args.into()` to `Self::connect`.

**Call relations**: Called by `connect_for_transport` for stdio transports and directly by tests. It delegates command construction to `stdio_command_process` and common client initialization to `ExecServerClient::connect`.

*Call graph*: calls 2 internal fn (stdio_command_process, from_stdio); 7 external calls (new, connect, piped, debug!, into, spawn, warn!).


##### `is_rendezvous_harness_url`  (lines 219–227)

```
fn is_rendezvous_harness_url(websocket_url: &str) -> bool
```

**Purpose**: Detects whether a websocket URL represents a rendezvous harness endpoint by inspecting its query string. This determines whether the websocket should be wrapped with the harness-specific connection adapter.

**Data flow**: It takes `&str`, splits once on `?`, returns `false` if there is no query, otherwise splits the query on `&`, then each pair on `=`, and returns `true` if any key/value pair is exactly `role=harness`.

**Call relations**: Used only by `ExecServerClient::connect_websocket`. It is a small classifier that influences transport wrapping but performs no I/O itself.

*Call graph*: called by 1 (connect_websocket).


##### `stdio_command_process`  (lines 229–239)

```
fn stdio_command_process(stdio_command: &StdioExecServerCommand) -> Command
```

**Purpose**: Builds a `tokio::process::Command` from structured stdio transport settings. It centralizes program, args, environment, cwd, and Unix process-group configuration.

**Data flow**: It takes `&StdioExecServerCommand`, creates `Command::new(&stdio_command.program)`, applies `.args(&stdio_command.args)`, `.envs(&stdio_command.env)`, and optional `.current_dir(cwd)`. On Unix it also sets `.process_group(0)`, then returns the configured `Command`.

**Call relations**: Called only by `ExecServerClient::connect_stdio_command` before spawning the child process. It isolates command assembly from the rest of stdio transport setup.

*Call graph*: called by 1 (connect_stdio_command); 1 external calls (new).


### MCP sidecar startup
These files build the runtime context and launch machinery for MCP servers, then manage per-server RMCP client lifecycles.

### `codex-mcp/src/runtime.rs`

`orchestration` · `startup and transport resolution`

This module holds the runtime-side state that complements static `McpConfig`. `SandboxState` is the serializable payload sent to capable MCP servers, carrying the optional `PermissionProfile`, effective `SandboxPolicy`, optional `codex_linux_sandbox_exe`, sandbox working directory, and the legacy-Landlock flag. `McpRuntimeContext` then packages the shared `EnvironmentManager` together with a fallback cwd for local stdio servers that omit one.

The key behavior is environment resolution. `resolve_server_environment` first asks the shared registry for `config.environment_id`. If an environment exists, it returns it, but for non-local servers it first enforces `ensure_remote_stdio_cwd` so remote stdio transports always have an absolute working directory. If no environment exists and the config is local, the function distinguishes transports: local stdio is rejected because it requires a local environment to launch, while local streamable HTTP is allowed to proceed with `Ok(None)` because it can use the ambient HTTP client without a registered local runtime. Non-local unknown environment IDs are always rejected with a descriptive error.

The file's final helper, `emit_duration`, is intentionally tiny and best-effort: it checks `codex_otel::global()` and records a duration metric if telemetry is configured, ignoring any recording failure. The tests cover all important resolution branches, including missing local environments, explicit remote environments, and the absolute-cwd requirement for remote stdio.

#### Function details

##### `McpRuntimeContext::new`  (lines 44–52)

```
fn new(
        environment_manager: Arc<EnvironmentManager>,
        local_stdio_fallback_cwd: PathBuf,
    ) -> Self
```

**Purpose**: Constructs the runtime context used for MCP environment resolution and local stdio fallback cwd selection.

**Data flow**: Consumes an `Arc<EnvironmentManager>` and a `PathBuf` fallback cwd, stores them in `McpRuntimeContext`, and returns the new context.

**Call relations**: This constructor is used by production startup paths and many tests before any MCP server launch or environment resolution occurs.

*Call graph*: called by 13 (list_mcp_server_status, read_mcp_resource, no_local_runtime_fails_local_stdio_but_keeps_local_http_server, explicit_remote_stdio_and_http_accept_named_environment, local_http_does_not_require_local_stdio_availability, local_stdio_accepts_local_environment_when_available, local_stdio_requires_local_stdio_availability, remote_stdio_requires_absolute_cwd, unknown_explicit_environment_is_rejected, list_accessible_connectors_from_mcp_tools_with_mcp_manager (+3 more)).


##### `McpRuntimeContext::local_stdio_fallback_cwd`  (lines 54–56)

```
fn local_stdio_fallback_cwd(&self) -> PathBuf
```

**Purpose**: Returns the configured fallback working directory for local stdio MCP servers. The path is cloned so callers can own and pass it onward.

**Data flow**: Reads `self.local_stdio_fallback_cwd`, clones the `PathBuf`, and returns it.

**Call relations**: This helper is used by `make_rmcp_client` when constructing a `LocalStdioServerLauncher`.

*Call graph*: called by 1 (make_rmcp_client); 1 external calls (clone).


##### `McpRuntimeContext::resolve_server_environment`  (lines 58–89)

```
fn resolve_server_environment(
        &self,
        server_name: &str,
        config: &codex_config::McpServerConfig,
    ) -> Result<Option<Arc<Environment>>, String>
```

**Purpose**: Resolves a server's configured environment ID to an actual runtime environment, while enforcing special rules for local HTTP and remote stdio transports. It is the central policy gate between static config and executable transport setup.

**Data flow**: Reads `server_name`, a borrowed `McpServerConfig`, and `self.environment_manager`. If `get_environment(&config.environment_id)` returns an environment, it validates remote stdio cwd with `ensure_remote_stdio_cwd` when `!config.is_local_environment()`, then returns `Ok(Some(environment))`. If no environment exists and `config.is_local_environment()` is true, it returns an error for `Stdio` transports and `Ok(None)` for `StreamableHttp`. Otherwise it returns an error naming the unknown environment ID.

**Call relations**: This function is called by `make_rmcp_client` before transport construction. It delegates only the remote-stdio cwd check to `ensure_remote_stdio_cwd`.

*Call graph*: calls 2 internal fn (ensure_remote_stdio_cwd, is_local_environment); called by 1 (make_rmcp_client); 1 external calls (format!).


##### `ensure_remote_stdio_cwd`  (lines 92–111)

```
fn ensure_remote_stdio_cwd(
    server_name: &str,
    config: &codex_config::McpServerConfig,
) -> Result<(), String>
```

**Purpose**: Validates that a remote stdio MCP server has an absolute working directory. Remote stdio launch is rejected when `cwd` is missing or relative.

**Data flow**: Reads `server_name` and a borrowed `McpServerConfig`. If the transport is not `Stdio`, it returns `Ok(())`. For stdio transports it inspects `cwd`: `None` yields an error saying an absolute cwd is required, an absolute path yields success, and a relative path yields an error including the relative path text.

**Call relations**: This helper is used only by `resolve_server_environment` for non-local servers.

*Call graph*: called by 1 (resolve_server_environment); 1 external calls (format!).


##### `emit_duration`  (lines 113–117)

```
fn emit_duration(metric: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records a duration metric through the global telemetry handle when one is configured. Metric emission is best-effort and silently ignored when telemetry is unavailable or recording fails.

**Data flow**: Reads `metric`, `duration`, and `tags`, checks `codex_otel::global()`, and if present calls `record_duration(metric, duration, tags)`, discarding the result.

**Call relations**: This helper is shared by startup and cache code elsewhere in the crate to avoid duplicating the global-telemetry check.

*Call graph*: called by 4 (write_cached_codex_apps_tools_if_needed, hard_refresh_codex_apps_tools_cache, listed_tools, start_server_task); 1 external calls (global).


##### `tests::stdio_server`  (lines 131–155)

```
fn stdio_server(environment_id: &str) -> McpServerConfig
```

**Purpose**: Builds a minimal stdio `McpServerConfig` fixture for runtime-context tests. It defaults `cwd` to `None` so tests can override it as needed.

**Data flow**: Consumes an `environment_id` string and returns an enabled `McpServerConfig` with `McpServerTransportConfig::Stdio { command: "echo", args: [], env: None, env_vars: [], cwd: None }`, the supplied environment ID, and all optional MCP fields unset.

**Call relations**: This fixture is used by multiple tests that exercise environment resolution for stdio transports.

*Call graph*: 2 external calls (new, new).


##### `tests::http_server`  (lines 157–168)

```
fn http_server(environment_id: &str) -> McpServerConfig
```

**Purpose**: Builds a minimal streamable-HTTP `McpServerConfig` fixture for runtime-context tests. It reuses the stdio fixture for shared defaults.

**Data flow**: Consumes an `environment_id`, constructs a `StreamableHttp` transport with URL `http://127.0.0.1:1` and no auth/header settings, and fills the remaining fields from `stdio_server(environment_id)` via struct update syntax.

**Call relations**: This fixture is used by tests that exercise local and remote HTTP environment resolution.

*Call graph*: 1 external calls (stdio_server).


##### `tests::local_stdio_requires_local_stdio_availability`  (lines 171–187)

```
fn local_stdio_requires_local_stdio_availability()
```

**Purpose**: Verifies that local stdio MCP servers cannot resolve without a registered local environment. This protects launch paths that require local execution support.

**Data flow**: Constructs an `McpRuntimeContext` with `EnvironmentManager::without_environments()`, calls `resolve_server_environment` on a local stdio config, captures the error branch, and asserts the error string matches the expected message.

**Call relations**: This test covers the local-stdio/no-environment rejection branch in `resolve_server_environment`.

*Call graph*: calls 2 internal fn (new, without_environments); 5 external calls (new, from, assert_eq!, stdio_server, panic!).


##### `tests::local_http_does_not_require_local_stdio_availability`  (lines 190–203)

```
fn local_http_does_not_require_local_stdio_availability()
```

**Purpose**: Verifies that local streamable-HTTP MCP servers can resolve even when no local environment is registered. They should fall back to ambient HTTP behavior.

**Data flow**: Constructs an `McpRuntimeContext` with no environments, calls `resolve_server_environment` on a local HTTP config, unwraps the success branch, and asserts the returned option is `None`.

**Call relations**: This test covers the special-case local-HTTP branch in `resolve_server_environment`.

*Call graph*: calls 2 internal fn (new, without_environments); 5 external calls (new, from, assert!, http_server, panic!).


##### `tests::unknown_explicit_environment_is_rejected`  (lines 206–221)

```
fn unknown_explicit_environment_is_rejected()
```

**Purpose**: Verifies that non-local servers referencing an unknown environment ID are rejected with a descriptive error. Unknown remote environments must not silently fall back.

**Data flow**: Constructs an `McpRuntimeContext` with no environments, calls `resolve_server_environment` on a stdio config using environment ID `remote`, captures the error branch, and asserts the exact error string.

**Call relations**: This test covers the final unknown-environment error branch in `resolve_server_environment`.

*Call graph*: calls 2 internal fn (new, without_environments); 5 external calls (new, from, assert_eq!, stdio_server, panic!).


##### `tests::explicit_remote_stdio_and_http_accept_named_environment`  (lines 224–251)

```
async fn explicit_remote_stdio_and_http_accept_named_environment()
```

**Purpose**: Verifies that both remote stdio and remote HTTP servers resolve successfully when the named environment exists. It also ensures remote stdio passes validation when given an absolute cwd.

**Data flow**: Creates a runtime context backed by `EnvironmentManager::create_for_tests(...)`, mutates a remote stdio fixture to set `cwd` to `std::env::temp_dir()`, then calls `resolve_server_environment` for both that stdio config and a remote HTTP config, asserting each result is `Some(environment)`.

**Call relations**: This test exercises the successful environment-present branches of `resolve_server_environment`, including `ensure_remote_stdio_cwd` success.

*Call graph*: calls 2 internal fn (new, create_for_tests); 8 external calls (new, from, assert!, http_server, stdio_server, panic!, temp_dir, unreachable!).


##### `tests::local_stdio_accepts_local_environment_when_available`  (lines 254–267)

```
async fn local_stdio_accepts_local_environment_when_available()
```

**Purpose**: Verifies that local stdio servers resolve successfully when a local environment is registered. This is the positive counterpart to the missing-local-environment test.

**Data flow**: Constructs an `McpRuntimeContext` with `EnvironmentManager::default_for_tests()`, calls `resolve_server_environment` on a local stdio config, unwraps success, and asserts the returned option is `Some(environment)`.

**Call relations**: This test covers the local-environment-present success path in `resolve_server_environment`.

*Call graph*: calls 2 internal fn (new, default_for_tests); 5 external calls (new, from, assert!, stdio_server, panic!).


##### `tests::remote_stdio_requires_absolute_cwd`  (lines 270–295)

```
async fn remote_stdio_requires_absolute_cwd()
```

**Purpose**: Verifies that remote stdio servers are rejected when their configured `cwd` is relative. Remote execution must always receive an absolute working directory.

**Data flow**: Creates a runtime context with a named remote environment, mutates a remote stdio fixture to set `cwd` to `PathBuf::from("relative")`, calls `resolve_server_environment`, captures the error branch, and asserts the exact error string naming the relative path.

**Call relations**: This test directly exercises the relative-path failure branch in `ensure_remote_stdio_cwd` as reached through `resolve_server_environment`.

*Call graph*: calls 2 internal fn (new, create_for_tests); 6 external calls (new, from, assert_eq!, stdio_server, panic!, unreachable!).


### `rmcp-client/src/stdio_server_launcher.rs`

`io_transport` · `process launch and teardown`

This module is the process-placement layer for stdio-based MCP servers. The public trait `StdioServerLauncher` abstracts over two implementations: `LocalStdioServerLauncher`, which spawns a child process directly with `tokio::process::Command`, and `ExecutorStdioServerLauncher`, which asks an `ExecBackend` to start the process remotely and then adapts its byte streams back into rmcp framing through `ExecutorProcessTransport`.

`StdioServerCommand` captures the launch shape shared by both implementations: program, args, optional environment overlay, configured env-var rules, and optional cwd. `StdioServerTransport` hides whether the underlying transport is local (`TokioChildProcess`) or executor-backed, but forwards rmcp `send`, `receive`, and `close` calls to the inner transport. `close` always terminates the associated process handle first.

Local launch builds the final environment with `create_env_for_mcp_server`, resolves the executable path with `program_resolver::resolve`, clears inherited environment, wires stdin/stdout/stderr pipes, and on Unix starts the child in its own process group. It also spawns a task that streams stderr lines into tracing logs. Remote launch requires an explicit cwd, builds a UTF-8-only argv/env payload for the executor protocol, computes an environment policy that either inherits only core variables or all variables filtered by `include_only`, starts the process with raw pipes (`tty = false`, `pipe_stdin = true`), and wraps the returned `ExecProcess`.

Process lifetime is centralized in `StdioServerProcessHandle`. It tracks whether termination already happened with an `AtomicBool`, supports explicit async termination, and also terminates on drop. Local termination uses process-group semantics on Unix with a grace-period escalation from terminate to kill, and `taskkill /T /F` on Windows. Executor-backed processes are terminated asynchronously through the current Tokio runtime if one is available.

#### Function details

##### `StdioServerTransport::send`  (lines 106–117)

```
fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = std::result::Result<(), Self::Error>> + Send + 'static
```

**Purpose**: Forwards an rmcp outbound JSON-RPC message to the underlying local or executor-backed transport. It preserves the transport abstraction while hiding process placement.

**Data flow**: Takes `&mut self` and a `TxJsonRpcMessage<RoleClient>` → matches `self.inner` and delegates to either `TokioChildProcess::send(item)` or `ExecutorProcessTransport::send(item)` → returns the boxed async send result.

**Call relations**: Called by rmcp once a stdio transport has been handed to `service::serve_client`. It is the write half of the transport wrapper.


##### `StdioServerTransport::receive`  (lines 119–127)

```
fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send
```

**Purpose**: Receives the next inbound rmcp JSON-RPC message from the underlying local or executor-backed transport. The executor variant has already adapted remote process output into rmcp's expected stream shape.

**Data flow**: Matches `self.inner` and delegates to the corresponding `receive()` future on the local or executor transport → returns an async future yielding `Option<RxJsonRpcMessage<RoleClient>>`.

**Call relations**: Called by rmcp's service loop after launch. It is the read half of the transport wrapper.


##### `StdioServerTransport::close`  (lines 129–135)

```
async fn close(&mut self) -> std::result::Result<(), Self::Error>
```

**Purpose**: Closes the transport and terminates the associated server process. Process termination happens before the underlying transport close operation.

**Data flow**: Awaits `self.process.terminate()`, then matches `self.inner` and awaits `transport.close()` on the local or executor transport → returns `io::Result<()>`.

**Call relations**: Invoked by rmcp when the transport is being shut down. It delegates process termination to `StdioServerProcessHandle::terminate`.

*Call graph*: calls 1 internal fn (terminate).


##### `StdioServerTransport::process_handle`  (lines 139–141)

```
fn process_handle(&self) -> StdioServerProcessHandle
```

**Purpose**: Returns a cloneable handle for terminating the launched stdio server process independently of the transport object.

**Data flow**: Reads `self.process`, clones it, and returns the clone.

**Call relations**: Used by `RmcpClient::new_stdio_client` to retain a process handle for explicit shutdown.

*Call graph*: 1 external calls (clone).


##### `StdioServerCommand::new`  (lines 147–161)

```
fn new(
        program: OsString,
        args: Vec<OsString>,
        env: Option<HashMap<OsString, OsString>>,
        env_vars: Vec<McpServerEnvVar>,
        cwd: Option<PathBuf>,
    ) -> Self
```

**Purpose**: Packages the configured stdio server command and launch context into a single value that launcher implementations can consume.

**Data flow**: Takes `program`, `args`, optional `env`, `env_vars`, and optional `cwd` → stores them in `StdioServerCommand` → returns the command object.

**Call relations**: Called by `RmcpClient::new_stdio_client` before handing the command to a launcher.

*Call graph*: called by 1 (new_stdio_client).


##### `LocalStdioServerLauncher::new`  (lines 181–183)

```
fn new(fallback_cwd: PathBuf) -> Self
```

**Purpose**: Creates a local stdio launcher with a fallback working directory used when the MCP server config omits `cwd`.

**Data flow**: Takes `fallback_cwd: PathBuf` → stores it in `LocalStdioServerLauncher` → returns the launcher.

**Call relations**: Constructed by higher-level client setup code for local stdio servers.

*Call graph*: called by 4 (make_rmcp_client, drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation, rmcp_client_can_list_and_read_resources).


##### `LocalStdioServerLauncher::launch`  (lines 187–193)

```
fn launch(
        &self,
        command: StdioServerCommand,
    ) -> BoxFuture<'static, io::Result<StdioServerTransport>>
```

**Purpose**: Starts a local stdio server asynchronously by delegating to the synchronous `launch_server` helper inside a boxed future.

**Data flow**: Clones `self.fallback_cwd`, captures `command`, and returns a boxed async block that calls `Self::launch_server(command, fallback_cwd)`.

**Call relations**: Implements the `StdioServerLauncher` trait for local process placement. `RmcpClient::create_pending_transport` invokes it through the trait object.

*Call graph*: 2 external calls (clone, launch_server).


##### `LocalStdioServerLauncher::launch_server`  (lines 237–296)

```
fn launch_server(
        command: StdioServerCommand,
        fallback_cwd: PathBuf,
    ) -> io::Result<StdioServerTransport>
```

**Purpose**: Spawns the configured MCP server as a local child process, wires its stdio into rmcp transport, and starts stderr logging. It also creates the process handle used for later termination.

**Data flow**: Destructures `StdioServerCommand`, derives `program_name`, builds the final environment with `create_env_for_mcp_server`, chooses `cwd` from command or fallback, resolves the executable with `program_resolver::resolve`, constructs a `tokio::process::Command` with piped stdin/stdout/stderr, cleared environment, args, and on Unix a new process group, then spawns it through `TokioChildProcess::builder(command).stderr(Stdio::piped()).spawn()`; creates `StdioServerProcessHandle::local(program_name.clone(), transport.id().map(LocalProcessTerminator::new))`; if stderr exists, spawns a task that reads lines and logs them with `info!` or warns on read failure; finally returns `StdioServerTransport { inner: Local(transport), process }`.

**Call relations**: Called by `LocalStdioServerLauncher::launch`. It delegates executable lookup to `program_resolver::resolve` and process-handle creation to `StdioServerProcessHandle::local`.

*Call graph*: calls 3 internal fn (resolve, local, create_env_for_mcp_server); 10 external calls (new, piped, builder, new, info!, kill_on_drop, process_group, Local, spawn, warn!).


##### `LocalProcessTerminator::new`  (lines 300–316)

```
fn new(process_group_id: u32) -> Self
```

**Purpose**: Constructs the platform-specific local-process terminator state from the spawned process identifier. On Unix this is a process-group id; on Windows it is a PID.

**Data flow**: Takes `process_group_id: u32` and stores it in the platform-appropriate field, or ignores it on unsupported platforms → returns `LocalProcessTerminator`.

**Call relations**: Used when creating a local `StdioServerProcessHandle` after spawning the child process.


##### `LocalProcessTerminator::terminate`  (lines 352–352)

```
fn terminate(&self)
```

**Purpose**: Terminates a locally launched MCP server process tree using platform-specific semantics. Unix uses process-group termination with delayed escalation; Windows shells out to `taskkill`.

**Data flow**: On Unix, reads `process_group_id`, calls `terminate_process_group`, warns on error, and if the group still exists spawns a thread that sleeps for `PROCESS_GROUP_TERM_GRACE_PERIOD` then calls `kill_process_group`, warning on failure; on Windows, runs `taskkill /PID <pid> /T /F` with stdio redirected to null; on unsupported platforms it does nothing.

**Call relations**: Called by `StdioServerProcessHandle::terminate` and by `StdioServerProcessHandleInner::drop` for local processes.

*Call graph*: calls 1 internal fn (terminate_process_group); 4 external calls (null, new, spawn, warn!).


##### `StdioServerProcessHandle::local`  (lines 356–364)

```
fn local(program_name: String, terminator: Option<LocalProcessTerminator>) -> Self
```

**Purpose**: Creates a process handle representing a locally launched stdio server. The handle tracks termination state and optional local terminator.

**Data flow**: Takes `program_name` and optional `LocalProcessTerminator` → wraps `StdioServerProcessHandleInner { program_name, kind: Local(terminator), terminated: AtomicBool::new(false) }` in `Arc` → returns `StdioServerProcessHandle`.

**Call relations**: Called by `LocalStdioServerLauncher::launch_server` after spawning the child.

*Call graph*: called by 1 (launch_server); 3 external calls (new, new, Local).


##### `StdioServerProcessHandle::executor`  (lines 366–374)

```
fn executor(program_name: String, process: Arc<dyn ExecProcess>) -> Self
```

**Purpose**: Creates a process handle representing an executor-managed stdio server. The handle stores the remote `ExecProcess` for later termination.

**Data flow**: Takes `program_name` and `Arc<dyn ExecProcess>` → wraps `StdioServerProcessHandleInner { program_name, kind: Executor(process), terminated: AtomicBool::new(false) }` in `Arc` → returns `StdioServerProcessHandle`.

**Call relations**: Called by `ExecutorStdioServerLauncher::launch_server` after the executor starts the remote process.

*Call graph*: called by 1 (launch_server); 3 external calls (new, new, Executor).


##### `StdioServerProcessHandle::terminate`  (lines 376–395)

```
async fn terminate(&self) -> io::Result<()>
```

**Purpose**: Performs explicit one-time termination of the launched process, suppressing duplicate termination attempts. Executor termination failures reset the terminated flag so callers can retry.

**Data flow**: Atomically swaps `inner.terminated` to `true`; if it was already true, returns `Ok(())`; otherwise matches `inner.kind`: for local with terminator, calls `terminator.terminate()` and returns `Ok(())`; for local without terminator, returns `Ok(())`; for executor, awaits `process.terminate()`, returning `Ok(())` on success or storing `false` back into `terminated` and returning `io::Error::other(error)` on failure.

**Call relations**: Called by `StdioServerTransport::close` and by `RmcpClient::shutdown` through the retained process handle.

*Call graph*: called by 1 (close); 1 external calls (other).


##### `StdioServerProcessHandleInner::drop`  (lines 399–429)

```
fn drop(&mut self)
```

**Purpose**: Best-effort cleanup path that terminates the process if no explicit termination happened before the last handle is dropped. It handles local and executor-backed processes differently.

**Data flow**: Atomically marks `terminated`; if already true, returns immediately. For local processes, calls `terminator.terminate()` if present. For executor processes, clones the `ExecProcess`, tries to get the current Tokio runtime handle, warns and returns if none exists, otherwise spawns an async task that awaits `process.terminate()` and warns on failure.

**Call relations**: Runs automatically when the last `StdioServerProcessHandle` reference is dropped. It is the fallback safety net behind explicit shutdown.

*Call graph*: 5 external calls (clone, swap, drop, try_current, warn!).


##### `ExecutorStdioServerLauncher::new`  (lines 446–448)

```
fn new(exec_backend: Arc<dyn ExecBackend>) -> Self
```

**Purpose**: Creates a stdio launcher that starts MCP servers through the executor process API instead of as local child processes.

**Data flow**: Takes `exec_backend: Arc<dyn ExecBackend>` → stores it in `ExecutorStdioServerLauncher` → returns the launcher.

**Call relations**: Constructed by higher-level client setup code for remote/executor-backed stdio servers.

*Call graph*: called by 1 (make_rmcp_client).


##### `ExecutorStdioServerLauncher::launch`  (lines 452–458)

```
fn launch(
        &self,
        command: StdioServerCommand,
    ) -> BoxFuture<'static, io::Result<StdioServerTransport>>
```

**Purpose**: Starts an executor-backed stdio server asynchronously by delegating to the async `launch_server` helper inside a boxed future.

**Data flow**: Clones `self.exec_backend`, captures `command`, and returns a boxed async block that awaits `Self::launch_server(command, exec_backend)`.

**Call relations**: Implements the `StdioServerLauncher` trait for executor placement. `RmcpClient::create_pending_transport` invokes it through the trait object.

*Call graph*: 2 external calls (clone, launch_server).


##### `ExecutorStdioServerLauncher::launch_server`  (lines 466–519)

```
async fn launch_server(
        command: StdioServerCommand,
        exec_backend: Arc<dyn ExecBackend>,
    ) -> io::Result<StdioServerTransport>
```

**Purpose**: Starts the MCP server through the executor API, converting local command/env data into the executor protocol's UTF-8 request format and wrapping the resulting remote process in an rmcp transport.

**Data flow**: Destructures `StdioServerCommand`, requires `cwd` to be present or returns an error, derives `program_name`, builds environment overlay with `create_env_overlay_for_remote_mcp_server`, computes remote-source env var names with `remote_mcp_env_var_names`, converts program/args to UTF-8 argv via `process_api_argv`, converts env map to UTF-8 strings via `process_api_env`, converts cwd to `PathUri`, allocates a process id with `ExecutorProcessTransport::next_process_id()`, starts the process through `exec_backend.start(ExecParams { process_id, argv, cwd, env_policy: Some(remote_env_policy(...)), env, tty: false, pipe_stdin: true, arg0: None })`, creates `StdioServerProcessHandle::executor`, wraps the remote process in `ExecutorProcessTransport::new(started.process, program_name)`, and returns `StdioServerTransport { inner: Executor(...), process }`.

**Call relations**: Called by `ExecutorStdioServerLauncher::launch`. It delegates UTF-8 conversion and env-policy construction to helper methods in this impl.

*Call graph*: calls 6 internal fn (new, next_process_id, executor, create_env_overlay_for_remote_mcp_server, remote_mcp_env_var_names, from_path); 6 external calls (clone, process_api_argv, process_api_env, remote_env_policy, other, Executor).


##### `ExecutorStdioServerLauncher::process_api_argv`  (lines 521–534)

```
fn process_api_argv(program: &OsString, args: &[OsString]) -> Result<Vec<String>>
```

**Purpose**: Converts the configured program and argument list into the executor protocol's UTF-8 argv vector. Non-Unicode values are rejected with contextual errors.

**Data flow**: Allocates a `Vec<String>` with capacity for program plus args, converts the program with `os_string_to_process_api_string(..., "command")`, converts each arg with label `"argument"`, pushes them into the vector, and returns it.

**Call relations**: Used by `ExecutorStdioServerLauncher::launch_server` before sending the start request to the executor.

*Call graph*: 4 external calls (clone, len, os_string_to_process_api_string, with_capacity).


##### `ExecutorStdioServerLauncher::process_api_env`  (lines 536–545)

```
fn process_api_env(env: HashMap<OsString, OsString>) -> Result<HashMap<String, String>>
```

**Purpose**: Converts an environment map from `OsString` keys and values into the executor protocol's UTF-8 `HashMap<String, String>`. It rejects non-Unicode names or values.

**Data flow**: Consumes `HashMap<OsString, OsString>`, maps each `(key, value)` through `os_string_to_process_api_string` with labels `environment variable name` and `environment variable value`, and collects the results into a new `HashMap<String, String>`.

**Call relations**: Used by `ExecutorStdioServerLauncher::launch_server` when preparing the executor start request.


##### `ExecutorStdioServerLauncher::os_string_to_process_api_string`  (lines 547–551)

```
fn os_string_to_process_api_string(value: OsString, label: &str) -> Result<String>
```

**Purpose**: Converts one `OsString` into a UTF-8 `String` suitable for the executor API, producing a contextual error if conversion fails.

**Data flow**: Consumes `value: OsString` and `label: &str` → calls `into_string()` and on failure returns `anyhow!("{label} must be valid Unicode for remote MCP stdio")` → otherwise returns the `String`.

**Call relations**: Shared helper used by both `process_api_argv` and `process_api_env`.

*Call graph*: 1 external calls (into_string).


##### `ExecutorStdioServerLauncher::remote_env_policy`  (lines 553–578)

```
fn remote_env_policy(remote_env_vars: &[String]) -> ExecEnvPolicy
```

**Purpose**: Builds the executor environment inheritance policy for remote MCP servers. It either inherits only core variables or inherits all variables but filters the effective child environment to requested names plus default essentials.

**Data flow**: Takes a slice of remote-source env var names → if empty, sets `inherit` to `ShellEnvironmentPolicyInherit::Core` and `include_only` to empty; otherwise sets `inherit` to `All` and builds `include_only` from `crate::utils::DEFAULT_ENV_VARS` plus the requested remote vars; in both cases returns `ExecEnvPolicy { inherit, ignore_default_excludes: true, exclude: Vec::new(), set: HashMap::new(), include_only }`.

**Call relations**: Used by `ExecutorStdioServerLauncher::launch_server` and directly by tests that verify filtering semantics.

*Call graph*: called by 3 (remote_env_policy_effectively_filters_unrequested_vars, remote_env_policy_includes_remote_source_vars_without_full_env, remote_env_policy_uses_core_env_without_remote_source_vars); 2 external calls (new, new).


##### `tests::remote_env_policy_uses_core_env_without_remote_source_vars`  (lines 589–594)

```
fn remote_env_policy_uses_core_env_without_remote_source_vars()
```

**Purpose**: Verifies that when no remote-source variables are requested, the executor env policy inherits only the core environment and does not populate `include_only`.

**Data flow**: Calls `ExecutorStdioServerLauncher::remote_env_policy(&[])` and asserts `inherit == Core` and `include_only.is_empty()`.

**Call relations**: Direct unit test for the empty-input branch of `remote_env_policy`.

*Call graph*: calls 1 internal fn (remote_env_policy); 2 external calls (assert!, assert_eq!).


##### `tests::remote_env_policy_includes_remote_source_vars_without_full_env`  (lines 597–611)

```
fn remote_env_policy_includes_remote_source_vars_without_full_env()
```

**Purpose**: Checks that requesting remote-source variables switches inheritance to `All` but still constrains the effective environment through `include_only`, which must contain both the requested variable and default env vars.

**Data flow**: Calls `remote_env_policy(&["REMOTE_TOKEN".to_string()])` and asserts `inherit == All`, `include_only` contains `REMOTE_TOKEN`, and it also contains at least one default env var.

**Call relations**: Exercises the non-empty-input branch of `remote_env_policy`.

*Call graph*: calls 1 internal fn (remote_env_policy); 2 external calls (assert!, assert_eq!).


##### `tests::remote_env_policy_effectively_filters_unrequested_vars`  (lines 614–653)

```
fn remote_env_policy_effectively_filters_unrequested_vars()
```

**Purpose**: Validates the practical effect of the generated executor env policy by applying it to a sample environment and checking that unrequested secrets are excluded.

**Data flow**: Builds an `ExecEnvPolicy` with `REMOTE_TOKEN`, converts it into a `ShellEnvironmentPolicy`, applies it to a sample environment containing `PATH`, `REMOTE_TOKEN`, and `UNREQUESTED_SECRET` via `shell_environment::create_env_from_vars`, and asserts that `PATH` and `REMOTE_TOKEN` remain while `UNREQUESTED_SECRET` is absent.

**Call relations**: End-to-end test of the filtering semantics implied by `remote_env_policy`.

*Call graph*: calls 2 internal fn (create_env_from_vars, remote_env_policy); 2 external calls (assert!, assert_eq!).


### `codex-mcp/src/rmcp_client.rs`

`io_transport` · `server startup, tool listing, and shutdown`

This module is the low-level engine behind MCP server startup. `ManagedClient` represents a fully initialized RMCP connection plus its normalized `McpServerInfo`, filtered `ToolInfo` list, timeout settings, optional server instructions, sandbox-state capability flag, and optional Codex Apps cache context. `AsyncManagedClient` wraps startup in a shared future so multiple consumers can await the same initialization, while also exposing cached tool/server snapshots during startup and a cancellation token for shutdown.

Startup in `AsyncManagedClient::new` is deliberately staged. It derives a `ToolFilter` from the configured server, loads startup cache snapshots for the built-in apps server, validates the server name against `^[a-zA-Z0-9_-]+$`, constructs an `RmcpClient` with `make_rmcp_client`, and then runs `start_server_task`. That task initializes the server with explicit client capabilities and protocol version `V_2025_06_18`, wires elicitation callbacks, detects the experimental `codex/sandbox-state-meta` capability, lists tools uncached, writes Codex Apps cache entries when appropriate, emits timing metrics, and applies final tool filtering.

The module also contains several trust and normalization boundaries. Non-`codex_apps` servers have connector metadata stripped from tool `_meta` and from returned connector fields, preventing untrusted servers from spoofing connector identity. Bearer tokens for HTTP transports are resolved from environment variables with explicit errors for unset, empty, or non-Unicode values. Transport creation distinguishes local stdio launch via `LocalStdioServerLauncher`, remote stdio launch via `ExecutorStdioServerLauncher` after environment resolution, and streamable HTTP launch with optional environment-provided HTTP clients and runtime auth providers. Tests at the bottom pin down the connector-metadata stripping rules.

#### Function details

##### `ManagedClient::listed_tools`  (lines 101–124)

```
fn listed_tools(&self) -> Vec<ToolInfo>
```

**Purpose**: Returns the managed client's current tool list, consulting the Codex Apps cache when available. Cached tools are filtered through the same `ToolFilter` as live tools and metric timings are emitted for cache hits and misses.

**Data flow**: Reads `self.codex_apps_tools_cache_context`, `self.tool_filter`, and `self.tools`. It records a start time, attempts `load_cached_codex_apps_tools` when a cache context exists, and on cache hit emits `MCP_TOOLS_LIST_DURATION_METRIC` with `cache=hit` and returns `filter_tools(cached_tools, &self.tool_filter)`. On cache miss it emits `cache=miss` when applicable and returns `self.tools.clone()`.

**Call relations**: This method is used after startup has completed to serve tool listings from a `ManagedClient`. It delegates cache loading and filtering to helper modules while owning the cache-hit/miss policy.

*Call graph*: calls 3 internal fn (load_cached_codex_apps_tools, emit_duration, filter_tools); 1 external calls (now).


##### `AsyncManagedClient::new`  (lines 141–237)

```
fn new(
        server_name: String,
        server: EffectiveMcpServer,
        store_mode: OAuthCredentialsStoreMode,
        keyring_backend_kind: AuthKeyringBackendKind,
        cancel_token: Canc
```

**Purpose**: Constructs an asynchronously initializing MCP client wrapper with optional startup cache snapshots. It packages validation, transport creation, server initialization, cancellation handling, and eager background startup into one shared future.

**Data flow**: Consumes server identity/config, OAuth storage settings, cancellation and event plumbing, elicitation manager, optional Codex Apps cache context, plugin provenance, runtime context, optional runtime auth provider, and client elicitation capability. It derives a `ToolFilter` from `server.configured_config()`, loads cached startup tools and server info, filters cached tools, creates an `AtomicBool` startup flag, and builds an async future that validates the server name, awaits `make_rmcp_client`, then awaits `start_server_task`, all wrapped in `or_cancel(&cancel_token)`. The future stores startup completion before returning either `ManagedClient` or `StartupOutcomeError`. The future is boxed and shared; if cached startup tools exist, a background task is spawned to begin startup eagerly. The function returns `AsyncManagedClient` holding the shared future, caches, provenance, and cancel token.

**Call relations**: This constructor is the main entry point used by higher-level connection management. It delegates transport creation to `make_rmcp_client`, initialization/listing to `start_server_task`, and name validation to `validate_mcp_server_name`.

*Call graph*: calls 6 internal fn (load_startup_cached_codex_apps_server_info, load_startup_cached_codex_apps_tools_snapshot, make_rmcp_client, start_server_task, validate_mcp_server_name, configured_config); called by 1 (new); 6 external calls (clone, new, new, clone, clone, spawn).


##### `AsyncManagedClient::client`  (lines 239–241)

```
async fn client(&self) -> Result<ManagedClient, StartupOutcomeError>
```

**Purpose**: Awaits and returns the shared startup result for this async managed client. Multiple callers share the same initialization future.

**Data flow**: Clones `self.client` and awaits it, returning `Result<ManagedClient, StartupOutcomeError>`.

**Call relations**: This helper is used by `listed_tools` and `shutdown` so they can observe the shared startup outcome without duplicating initialization work.

*Call graph*: called by 2 (listed_tools, shutdown); 1 external calls (clone).


##### `AsyncManagedClient::shutdown`  (lines 243–252)

```
async fn shutdown(&self)
```

**Purpose**: Cancels startup or shuts down the initialized RMCP client, depending on how far startup progressed. Initialization failures during shutdown are logged rather than propagated.

**Data flow**: Cancels `self.cancel_token`, awaits `self.client()`, and then either calls `client.client.shutdown().await` on success, ignores `StartupOutcomeError::Cancelled`, or logs a warning for any other startup failure.

**Call relations**: This method is called during connection-manager teardown. It relies on `client()` to synchronize with any in-flight startup before deciding whether a real RMCP shutdown call is possible.

*Call graph*: calls 1 internal fn (client); 2 external calls (cancel, warn!).


##### `AsyncManagedClient::cached_tool_info_snapshot_while_initializing`  (lines 254–259)

```
fn cached_tool_info_snapshot_while_initializing(&self) -> Option<Vec<ToolInfo>>
```

**Purpose**: Returns the cached startup tool snapshot only while initialization is still in progress. Once startup completes, the cache is suppressed so callers use live results or final fallback behavior.

**Data flow**: Reads `self.startup_complete` with `Ordering::Acquire`; if startup is not complete it clones and returns `self.cached_tool_info_snapshot`, otherwise it returns `None`.

**Call relations**: This helper is used by `AsyncManagedClient::listed_tools` to decide whether to serve startup cache data.

*Call graph*: called by 1 (listed_tools).


##### `AsyncManagedClient::listed_tools`  (lines 261–324)

```
async fn listed_tools(&self) -> Option<Vec<ToolInfo>>
```

**Purpose**: Returns the best available tool list for a server, preferring startup cache while initializing, then live initialized tools, then cached fallback on startup failure. It also annotates each tool with plugin provenance and, for `codex_apps`, a model-visible input schema.

**Data flow**: Reads startup state, cached snapshots, shared client result, and `tool_plugin_provenance`. It first chooses a raw tool list: cached startup tools if initialization is still running, otherwise `client.listed_tools()` on successful startup, otherwise the cached snapshot if startup failed. It then mutates each `ToolInfo`: for `codex_apps` it rewrites `tool.tool` with `tool_with_model_visible_input_schema`; it looks up plugin display names by connector ID or server name, stores them in `tool.plugin_display_names`, and appends a sentence like `This tool is part of plugin ...` or `plugins ...` to the tool description with punctuation-aware formatting. It returns the annotated vector wrapped in `Option`.

**Call relations**: This method is the consumer-facing tool-list path for async clients. It depends on `cached_tool_info_snapshot_while_initializing` and `client()` for source selection, and on provenance accessors from `ToolPluginProvenance` for annotation.

*Call graph*: calls 2 internal fn (cached_tool_info_snapshot_while_initializing, client).


##### `StartupOutcomeError::from`  (lines 338–342)

```
fn from(error: anyhow::Error) -> Self
```

**Purpose**: Converts an `anyhow::Error` into a cloneable startup error variant by stringifying it. This preserves a readable message while avoiding ownership of non-`Clone` error state.

**Data flow**: Consumes `anyhow::Error`, calls `to_string()`, and returns `StartupOutcomeError::Failed { error }`.

**Call relations**: This conversion is used throughout startup code paths such as initialization, transport creation, and tool listing whenever an `anyhow` failure must cross the shared-future boundary.

*Call graph*: 1 external calls (to_string).


##### `list_tools_for_client_uncached`  (lines 345–408)

```
async fn list_tools_for_client_uncached(
    server_name: &str,
    client: &Arc<RmcpClient>,
    timeout: Option<Duration>,
    server_instructions: Option<&str>,
) -> Result<Vec<ToolInfo>>
```

**Purpose**: Lists tools directly from an initialized RMCP client and converts them into normalized `ToolInfo` records. It sanitizes connector metadata, normalizes callable names/titles/namespaces, and filters disallowed Codex Apps tools.

**Data flow**: Reads `server_name`, an `Arc<RmcpClient>`, optional timeout, and optional server instructions. It awaits `client.list_tools_with_connector_ids(None, timeout)`, then maps each returned tool: extracts and mutates `tool.tool`, sanitizes connector metadata with `sanitize_tool_connector_metadata`, computes `callable_name`, `callable_namespace`, and normalized title using Codex Apps normalization helpers, chooses `namespace_description` from connector description when connector metadata exists or from `server_instructions` otherwise, and constructs `ToolInfo` with empty `plugin_display_names`. After collecting the vector, it returns `filter_disallowed_codex_apps_tools(tools)` for the built-in apps server or the unmodified vector otherwise.

**Call relations**: This function is called during startup by `start_server_task` and by cache-refresh code elsewhere. It delegates trust filtering to `sanitize_tool_connector_metadata` and Codex Apps-specific filtering to `filter_disallowed_codex_apps_tools`.

*Call graph*: calls 1 internal fn (filter_disallowed_codex_apps_tools); called by 2 (hard_refresh_codex_apps_tools_cache, start_server_task).


##### `sanitize_tool_connector_metadata`  (lines 410–423)

```
fn sanitize_tool_connector_metadata(
    server_name: &str,
    tool: &mut RmcpTool,
    connector_id: Option<String>,
    connector_name: Option<String>,
    connector_description: Option<String>,
)
```

**Purpose**: Decides whether connector metadata from a listed tool should be trusted. Only the built-in `codex_apps` server preserves connector identity; all other servers have connector metadata stripped and connector fields nulled out.

**Data flow**: Reads `server_name`, mutably borrows an `RmcpTool`, and consumes optional `connector_id`, `connector_name`, and `connector_description`. If the server is `CODEX_APPS_MCP_SERVER_NAME`, it returns the inputs unchanged. Otherwise it calls `strip_untrusted_connector_meta(tool)` and returns `(None, None, None)`.

**Call relations**: This helper is used by `list_tools_for_client_uncached` and is directly covered by the module tests to enforce the trust boundary around connector metadata.

*Call graph*: calls 1 internal fn (strip_untrusted_connector_meta); called by 2 (codex_apps_connector_metadata_is_preserved, custom_mcp_connector_metadata_is_stripped).


##### `strip_untrusted_connector_meta`  (lines 425–429)

```
fn strip_untrusted_connector_meta(tool: &mut RmcpTool)
```

**Purpose**: Removes known connector-related keys from a tool's `_meta` object. It leaves unrelated metadata untouched.

**Data flow**: Mutably reads `tool.meta`; if present, it retains only entries whose keys do not satisfy `is_untrusted_connector_meta_key`.

**Call relations**: This helper is called by `sanitize_tool_connector_metadata` for non-`codex_apps` servers.

*Call graph*: called by 1 (sanitize_tool_connector_metadata).


##### `is_untrusted_connector_meta_key`  (lines 431–433)

```
fn is_untrusted_connector_meta_key(key: &str) -> bool
```

**Purpose**: Checks whether a metadata key is one of the connector-related keys that should be stripped from untrusted servers. The match is exact and case-sensitive against a fixed allowlist of keys to remove.

**Data flow**: Reads `key` and returns whether `UNTRUSTED_CONNECTOR_META_KEYS.contains(&key)`.

**Call relations**: This predicate is used only by `strip_untrusted_connector_meta`.


##### `resolve_bearer_token`  (lines 435–460)

```
fn resolve_bearer_token(
    server_name: &str,
    bearer_token_env_var: Option<&str>,
) -> Result<Option<String>>
```

**Purpose**: Resolves an HTTP bearer token from an environment variable for one MCP server. It treats missing, empty, and non-Unicode values as distinct configuration errors.

**Data flow**: Reads `server_name` and optional `bearer_token_env_var`. If no env var is configured it returns `Ok(None)`. Otherwise it reads the environment variable and returns `Ok(Some(value))` for a non-empty Unicode value, or an `anyhow!` error describing the variable as empty, not set, or invalid Unicode.

**Call relations**: This helper is called by `make_rmcp_client` when constructing streamable HTTP clients so transport creation fails early with a precise message if bearer-token configuration is broken.

*Call graph*: called by 1 (make_rmcp_client); 2 external calls (anyhow!, var).


##### `validate_mcp_server_name`  (lines 462–471)

```
fn validate_mcp_server_name(server_name: &str) -> Result<()>
```

**Purpose**: Validates that an MCP server name contains only ASCII letters, digits, underscores, and hyphens. Invalid names are rejected before any transport startup occurs.

**Data flow**: Compiles the regex `^[a-zA-Z0-9_-]+$`, tests `server_name`, and returns `Ok(())` on match or an `anyhow!` error that includes the invalid name and regex pattern on mismatch.

**Call relations**: This validation runs at the start of `AsyncManagedClient::new` so malformed names fail fast before client construction or initialization.

*Call graph*: called by 1 (new); 2 external calls (anyhow!, new).


##### `start_server_task`  (lines 473–551)

```
async fn start_server_task(
    server_name: String,
    client: Arc<RmcpClient>,
    params: StartServerTaskParams,
) -> Result<ManagedClient, StartupOutcomeError>
```

**Purpose**: Initializes an RMCP client, lists and filters its tools, records cache and metrics, and packages the result into a `ManagedClient`. It is the core startup routine executed inside the shared async future.

**Data flow**: Consumes `server_name`, an `Arc<RmcpClient>`, and `StartServerTaskParams`. It builds `ClientCapabilities` with the supplied elicitation capability, constructs `InitializeRequestParams` with implementation name `codex-mcp-client`, title `Codex`, and protocol version `V_2025_06_18`, then creates an elicitation sender and awaits `client.initialize(...)`. From the initialize result it derives the sandbox-state capability flag, times and awaits `list_tools_for_client_uncached`, emits uncached-fetch duration, converts server info with `mcp_server_info_from_implementation`, writes Codex Apps cache entries if needed, emits list-duration metrics for `codex_apps` cache misses, filters tools with `filter_tools`, and returns a populated `ManagedClient` containing the client, server info, filtered tools, timeout, filter, instructions, capability flag, and cache context.

**Call relations**: This function is called by `AsyncManagedClient::new` after transport creation. It delegates raw tool listing to `list_tools_for_client_uncached`, cache persistence to `write_cached_codex_apps_tools_if_needed`, metrics to `emit_duration`, and server-info conversion to `mcp_server_info_from_implementation`.

*Call graph*: calls 5 internal fn (write_cached_codex_apps_tools_if_needed, list_tools_for_client_uncached, mcp_server_info_from_implementation, emit_duration, filter_tools); called by 1 (new); 6 external calls (clone, default, new, new, now, env!).


##### `mcp_server_info_from_implementation`  (lines 553–567)

```
fn mcp_server_info_from_implementation(server_info: Implementation) -> McpServerInfo
```

**Purpose**: Converts RMCP `Implementation` metadata from server initialization into the protocol-layer `McpServerInfo` struct. It preserves optional title, description, icons, and website URL.

**Data flow**: Consumes `Implementation`, moves scalar fields directly into `McpServerInfo`, and maps optional icons by serializing each icon to JSON and dropping any icon that fails serialization.

**Call relations**: This helper is used by `start_server_task` after successful initialization.

*Call graph*: called by 1 (start_server_task).


##### `make_rmcp_client`  (lines 579–663)

```
async fn make_rmcp_client(
    server_name: &str,
    server: EffectiveMcpServer,
    store_mode: OAuthCredentialsStoreMode,
    keyring_backend_kind: AuthKeyringBackendKind,
    runtime_context: McpR
```

**Purpose**: Constructs an `RmcpClient` for either stdio or streamable HTTP transport after resolving the server's runtime environment. It chooses the correct launcher or HTTP client based on whether the server runs locally or in an executor environment.

**Data flow**: Reads `server_name`, `EffectiveMcpServer`, OAuth storage settings, `McpRuntimeContext`, and optional runtime auth provider. It extracts the configured `McpServerConfig` from `server.launch()`, resolves the runtime environment with `runtime_context.resolve_server_environment`, checks `config.is_local_environment()`, and matches on `transport`. For `Stdio`, it converts command/args/env to `OsString` forms, chooses `LocalStdioServerLauncher` with `runtime_context.local_stdio_fallback_cwd()` for local environments or `ExecutorStdioServerLauncher` from the resolved environment for remote ones, then awaits `RmcpClient::new_stdio_client(...)`. For `StreamableHttp`, it chooses either `ReqwestHttpClient` or the environment's HTTP client, resolves any bearer token with `resolve_bearer_token`, and awaits `RmcpClient::new_streamable_http_client(...)`. Errors are converted into `StartupOutcomeError`.

**Call relations**: This transport-construction function is called by `AsyncManagedClient::new` before initialization. It depends on `McpRuntimeContext` for environment resolution and on `resolve_bearer_token` for HTTP auth setup.

*Call graph*: calls 8 internal fn (resolve_bearer_token, local_stdio_fallback_cwd, resolve_server_environment, launch, new_stdio_client, new_streamable_http_client, new, new); called by 1 (new); 2 external calls (new, unreachable!).


##### `tests::tool_with_connector_meta`  (lines 671–693)

```
fn tool_with_connector_meta() -> RmcpTool
```

**Purpose**: Builds a synthetic RMCP tool containing both connector-related and unrelated `_meta` fields. It serves as shared fixture data for connector-metadata sanitization tests.

**Data flow**: Constructs an `RmcpTool` named `capture_file_upload` with a default JSON schema object, attaches a `Meta` object containing connector keys, future connector-like keys, OpenAI file params, and a custom field, and returns the tool.

**Call relations**: This fixture is used by both connector-metadata tests below.

*Call graph*: 5 external calls (new, default, new, Meta, json!).


##### `tests::custom_mcp_connector_metadata_is_stripped`  (lines 696–729)

```
fn custom_mcp_connector_metadata_is_stripped()
```

**Purpose**: Verifies that non-`codex_apps` servers cannot surface connector identity. Connector fields should be nulled out and known connector `_meta` keys removed, while unrelated metadata remains.

**Data flow**: Creates the fixture tool, calls `sanitize_tool_connector_metadata` with a non-apps server name and populated connector fields, asserts the returned connector values are all `None`, then inspects `tool.meta` to assert connector keys were removed while unrelated keys remain present.

**Call relations**: This test directly exercises the non-trusted branch of `sanitize_tool_connector_metadata` and the key-removal behavior of `strip_untrusted_connector_meta`.

*Call graph*: calls 1 internal fn (sanitize_tool_connector_metadata); 3 external calls (assert!, assert_eq!, tool_with_connector_meta).


##### `tests::codex_apps_connector_metadata_is_preserved`  (lines 732–760)

```
fn codex_apps_connector_metadata_is_preserved()
```

**Purpose**: Verifies that the built-in `codex_apps` server is trusted to preserve connector metadata. Both returned connector fields and `_meta` keys should remain intact.

**Data flow**: Creates the fixture tool, calls `sanitize_tool_connector_metadata` with `CODEX_APPS_MCP_SERVER_NAME` and populated connector fields, asserts the returned connector values match the inputs, and checks that all connector-related metadata keys are still present in `tool.meta`.

**Call relations**: This test covers the trusted-server branch of `sanitize_tool_connector_metadata`.

*Call graph*: calls 1 internal fn (sanitize_tool_connector_metadata); 3 external calls (assert!, assert_eq!, tool_with_connector_meta).


### `mcp-server/src/lib.rs`

`orchestration` · `startup and main loop`

This file is the crate-level driver for the prototype MCP server. `run_main` eagerly parses CLI config overrides into a concrete `Config`, applies strictness rules, sets the login client residency requirement, initializes OpenTelemetry providers, records process startup, installs SQLite telemetry, opens the state database, and constructs an `EnvironmentManager` from Codex home plus optional runtime executable paths. It also installs tracing subscribers with stderr formatting and optional OTEL logging/tracing layers.

After setup, the function wires three asynchronous tasks together with channels. A bounded `incoming` channel carries parsed client JSON-RPC messages from stdin into the processor; an unbounded `outgoing` channel carries server messages toward stdout. The stdin task reads line-delimited JSON, deserializes each line into `JsonRpcMessage<ClientRequest, Value, ClientNotification>`, forwards valid messages, and logs malformed input. The processor task creates `OutgoingMessageSender` and `MessageProcessor`, then dispatches each incoming request/response/notification/error to the appropriate processor method. The stdout task converts internal `OutgoingMessage` values into flattened RMCP JSON-RPC messages, serializes them, writes them to stdout with newline framing, and stops on write failure.

Shutdown is intentionally channel-driven: EOF on stdin drops the sender, which drains the processor loop, which then lets the stdout writer exit. The tests in this file pin two invariants: analytics default to enabled, and OTEL provider construction can produce log, trace, and metrics exporters when configured.

#### Function details

##### `run_main`  (lines 59–203)

```
async fn run_main(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    strict_config: bool,
) -> IoResult<()>
```

**Purpose**: Bootstraps the MCP server process and runs its three-task stdin/process/stdout pipeline until shutdown. It is the library entry used by the binary wrapper.

**Data flow**: Inputs are `Arg0DispatchPaths`, CLI config overrides, and a strict-config flag. It parses overrides, builds `Config`, derives telemetry and state/database resources, constructs `EnvironmentManager`, initializes tracing, creates incoming/outgoing channels, resolves the installation id, and spawns three Tokio tasks: stdin reader, message processor, and stdout writer. It returns `IoResult<()>`, mapping configuration and environment setup failures into `std::io::Error`, while runtime task failures are ignored via `tokio::join!` and normal completion returns `Ok(())`.

**Call relations**: It is called by the binary `main` after arg0 dispatch has selected the executable path layout. Inside, it instantiates `MessageProcessor::new` and `OutgoingMessageSender::new`, then repeatedly delegates incoming traffic to the processor methods and outgoing traffic to JSON serialization and stdout writes.

*Call graph*: calls 9 internal fn (new, new, build_provider, install_sqlite_telemetry, record_process_start, from_codex_home, from_optional_paths, set_default_client_residency_requirement, parse_overrides); 17 external calls (new, new, from_default_env, init_state_db, resolve_installation_id, default, debug!, env!, error!, info! (+7 more)).


##### `tests::mcp_server_defaults_analytics_to_enabled`  (lines 215–217)

```
fn mcp_server_defaults_analytics_to_enabled()
```

**Purpose**: Verifies the crate-level default analytics flag remains enabled. This protects a behavioral default relied on by telemetry initialization.

**Data flow**: It reads the `DEFAULT_ANALYTICS_ENABLED` constant and compares it to `true` with an assertion. It returns no value and mutates no state.

**Call relations**: This test is run in the unit-test phase and does not participate in runtime call flow. Its role is to catch accidental constant changes that would alter `run_main` telemetry behavior.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mcp_server_builds_otel_provider_with_logs_traces_and_metrics`  (lines 220–254)

```
async fn mcp_server_builds_otel_provider_with_logs_traces_and_metrics() -> anyhow::Result<()>
```

**Purpose**: Exercises OTEL provider construction with explicit exporter settings and confirms all three signal pipelines can be created. It also shuts the provider down to validate the constructed object is usable.

**Data flow**: It creates a temporary Codex home, builds a baseline config, mutates the OTEL exporter, trace exporter, metrics exporter, and analytics flag fields, then calls `codex_core::otel_init::build_provider`. From the returned provider it asserts `logger`, `tracer_provider`, and `metrics()` are present, invokes `shutdown()`, and returns `anyhow::Result<()>`.

**Call relations**: This is a unit test for the startup path used by `run_main`. It directly exercises the same OTEL builder that production startup uses, but in isolation from the rest of the server runtime.

*Call graph*: calls 1 internal fn (build_provider); 4 external calls (new, new, assert!, default).


### Protocol bridge utilities
These files provide small dedicated sidecars that bridge local protocols or proxy a single API surface.

### `stdio-to-uds/src/lib.rs`

`io_transport` · `main I/O relay while the bridge process is connected to a socket`

This library exposes a single async entrypoint, `run`, that turns the current process into a bidirectional stdio-to-UDS pipe. It first connects to the supplied socket path using `codex_uds::UnixStream::connect`, attaching contextual error text that includes the path on failure. Once connected, it splits the stream into independent read and write halves so traffic can flow concurrently in both directions.

The function then defines two async tasks. `copy_socket_to_stdout` continuously copies bytes from the socket reader to Tokio stdout and flushes stdout at the end so the peer’s final response is visible before exit. `copy_stdin_to_socket` copies all stdin bytes into the socket writer and then attempts to half-close the write side with `shutdown()`. A notable edge case is handled here: if the peer has already closed after sending its response, some platforms report `io::ErrorKind::NotConnected` during shutdown; that specific error is ignored, while any other shutdown failure is wrapped with context and returned.

Finally, `tokio::try_join!` runs both directions concurrently and fails the whole relay if either side errors. The outer context message makes it clear that the failure happened during relay rather than initial connection. On success, the function returns `Ok(())` after both copy loops complete.

#### Function details

##### `run`  (lines 12–46)

```
async fn run(socket_path: &Path) -> anyhow::Result<()>
```

**Purpose**: Connects to a Unix domain socket and concurrently relays stdin to the socket while relaying socket output to stdout. It is the complete transport loop for the bridge process.

**Data flow**: It takes a socket `&Path`, opens a `UnixStream`, splits it into reader and writer halves, and constructs two async blocks. One copies from the socket reader into Tokio stdout and flushes stdout; the other copies from Tokio stdin into the socket writer, then attempts `shutdown()` on the writer while tolerating `NotConnected`. `tokio::try_join!` awaits both blocks, returning `Ok(())` on success or an `anyhow` error with contextual messages on connection, copy, shutdown, or relay failure.

**Call relations**: The binary entrypoint in `stdio-to-uds/src/main.rs` calls this function after parsing the socket path argument. Internally it delegates byte movement to Tokio's `copy`, stream splitting to `tokio::io::split`, and connection establishment to `codex_uds::UnixStream::connect`.

*Call graph*: calls 1 internal fn (connect); 6 external calls (Ok, copy, split, stdin, stdout, try_join!).


### `responses-api-proxy/src/lib.rs`

`orchestration` · `startup, request handling loop, per-request forwarding, shutdown`

This library is the operational core of the `responses-api-proxy` binary. `Args` defines CLI configuration for bind port, startup info file, optional `/shutdown`, upstream URL override, and optional dump directory. `run_main` performs startup in a strict sequence: read the bearer token from stdin using the hardened helper, parse the upstream URL, derive the `Host` header from host and optional port, optionally create an `ExchangeDumper`, bind a loopback listener, optionally write a one-line JSON `ServerInfo` file, construct a `tiny_http::Server`, and build a reqwest blocking client with timeout disabled so long-lived streams are not cut off.

The main loop accepts incoming requests and spawns one thread per request. Each worker optionally handles `GET /shutdown` by responding 200 and exiting the process. Otherwise it calls `forward_request`. That function enforces a narrow allowlist: only exact `POST /v1/responses` with no query string is forwarded; everything else gets HTTP 403. It reads the full request body into memory, optionally writes a request dump, then rebuilds upstream headers by forwarding all incoming headers except `Authorization` and `Host`. Header names are normalized to lowercase and invalid names/values are skipped rather than failing the request.

The proxy inserts its own sensitive `Authorization` header from the leaked static token and overwrites `Host` with the upstream host. It sends the request upstream with reqwest, converts the upstream response into a `tiny_http::Response`, strips hop-by-hop headers tiny_http manages itself, computes a safe `usize` content length when possible, and streams the body directly. If dumping is enabled, the body is wrapped in `tee_response_body` so the response is captured while still streaming to the client. Errors in forwarding are logged per request; if the server loop itself ends, `run_main` returns an unexpected-stop error.

#### Function details

##### `run_main`  (lines 73–136)

```
fn run_main(args: Args) -> Result<()>
```

**Purpose**: Performs full proxy startup and runs the incoming-request loop. It wires together auth loading, upstream configuration, optional dump setup, listener binding, server-info output, HTTP server creation, and per-request thread dispatch.

**Data flow**: Consumes parsed `Args`. It reads a static auth header from stdin, parses `args.upstream_url` into `Url`, derives a `HeaderValue` for `Host`, stores both in `ForwardConfig` inside an `Arc`, optionally creates an `ExchangeDumper` from `args.dump_dir`, binds a listener with `bind_listener`, optionally writes `ServerInfo` via `write_server_info`, creates a `tiny_http::Server`, builds a reqwest blocking `Client` with no timeout, then loops over `server.incoming_requests()`. For each request it clones shared `Arc`s and spawns a thread that either serves `/shutdown` or calls `forward_request`; forwarding errors are printed to stderr. If the server loop ends, it returns an `anyhow!` error.

**Call relations**: This is the library entrypoint invoked by the binary `main`. It delegates listener setup to `bind_listener`, startup metadata emission to `write_server_info`, auth loading to `read_auth_header_from_stdin`, and all actual proxying to `forward_request`.

*Call graph*: calls 3 internal fn (bind_listener, read_auth_header_from_stdin, write_server_info); 9 external calls (new, from_str, from_listener, parse, anyhow!, builder, eprintln!, format!, spawn).


##### `bind_listener`  (lines 138–143)

```
fn bind_listener(port: Option<u16>) -> Result<(TcpListener, SocketAddr)>
```

**Purpose**: Binds a loopback TCP listener on the requested port or an ephemeral port and reports the actual bound address. It centralizes bind-time error context.

**Data flow**: Takes `port: Option<u16>`, constructs `SocketAddr::from(([127, 0, 0, 1], port.unwrap_or(0)))`, binds a `TcpListener`, reads `local_addr()`, and returns `(listener, bound_addr)` wrapped in `anyhow::Result` with contextual messages on failure.

**Call relations**: Called during startup from `run_main` before the HTTP server is created. Its returned bound port is also used for optional server-info output.

*Call graph*: called by 1 (run_main); 2 external calls (from, bind).


##### `write_server_info`  (lines 145–161)

```
fn write_server_info(path: &Path, port: u16) -> Result<()>
```

**Purpose**: Writes a single-line JSON file describing the running proxy process and bound port. It creates parent directories when needed.

**Data flow**: Takes `path: &Path` and `port: u16`. If `path.parent()` exists and is non-empty, it creates that directory tree. It then builds `ServerInfo { port, pid: std::process::id() }`, serializes it with `serde_json::to_string`, appends a newline, creates the file, writes the bytes, and returns `Result<()>`.

**Call relations**: Invoked by `run_main` only when `--server-info` is configured, so external tooling can discover the chosen port and process ID after startup.

*Call graph*: called by 1 (run_main); 5 external calls (create, parent, create_dir_all, to_string, id).


##### `forward_request`  (lines 163–275)

```
fn forward_request(
    client: &Client,
    auth_header: &'static str,
    config: &ForwardConfig,
    dump_dir: Option<&ExchangeDumper>,
    mut req: Request,
) -> Result<()>
```

**Purpose**: Validates an incoming proxy request, forwards it to the configured upstream with injected auth, and streams the upstream response back to the client. It also integrates optional request/response dumping.

**Data flow**: Takes a reqwest `Client`, the static `auth_header`, `ForwardConfig`, optional `ExchangeDumper`, and a mutable `tiny_http::Request`. It clones the request method and URL path, rejects anything except exact `POST /v1/responses` with a 403 response, then reads the full request body into `Vec<u8>`. If dumping is enabled it calls `dump_request`; dump failures are logged and ignored. It rebuilds a reqwest `HeaderMap` from incoming headers, skipping `authorization` and `host`, lowercasing names, and ignoring invalid names/values. It inserts a sensitive `Authorization` header from `auth_header` and the configured `Host`, sends the upstream POST with body bytes, then translates the upstream response into tiny_http headers while skipping hop-by-hop headers (`content-length`, `transfer-encoding`, `connection`, `trailer`, `upgrade`). It computes an optional `usize` content length, wraps the upstream body in `tee_response_body` when dumping is active or uses it directly otherwise, constructs `tiny_http::Response::new(...)`, responds to the client, and returns `Ok(())`.

**Call relations**: This is the per-request worker invoked from the thread spawned in `run_main`. It is the only place where the proxy’s allowlist, header rewriting, upstream I/O, and dump integration come together.

*Call graph*: 17 external calls (new, from_bytes, new, from_bytes, from_bytes, from_static, new, post, as_reader, headers (+7 more)).


### Network proxy runtime
These files orchestrate the standalone network proxy process and its SOCKS5 transport implementation.

### `network-proxy/src/proxy.rs`

`orchestration` · `startup, runtime reconfiguration, child-process environment setup, and shutdown`

This file assembles a runnable `NetworkProxy` from config state and optional integrations. `NetworkProxyBuilder` collects the shared `NetworkProxyState`, optional explicit bind addresses, whether Codex manages listener allocation, an optional `NetworkPolicyDecider`, and an optional `BlockedRequestObserver`. In managed mode, `build` resolves runtime addresses from config, reserves loopback listeners up front so child processes can be told stable ports before the async servers start, and on Windows prefers configured loopback ports with fallback to ephemeral ports if they are busy. In unmanaged mode it uses caller-supplied or configured addresses directly, then clamps both addresses through `config::clamp_bind_addrs` so unix-socket proxying cannot accidentally expose non-loopback listeners.

`NetworkProxyRuntimeSettings` snapshots mutable runtime knobs derived from config: local binding, unix-socket allowlist, the dangerous allow-all-unix-sockets flag, and an optional managed MITM CA trust bundle built from startup CA-related environment variables when MITM is enabled. `NetworkProxy::replace_config_state` intentionally forbids changing listener-shape settings (`enabled`, proxy URLs, SOCKS enablement) on a running proxy, but refreshes the runtime settings lock for safe live updates.

`apply_proxy_env_overrides` is the child-process integration point. It rewrites many common proxy environment variables to the managed HTTP endpoint, uses SOCKS only for `ALL_PROXY`/`FTP_PROXY` when enabled, forces a conservative `NO_PROXY` list for loopback/private IP literals, sets Node/Electron toggles, optionally injects or refreshes a macOS `GIT_SSH_COMMAND` wrapper, and installs the managed MITM CA bundle unless a command-scoped CA override should be preserved.

`run` starts the HTTP proxy task unconditionally when networking is enabled and the SOCKS task only when configured, consuming any reserved listeners exactly once and returning a `NetworkProxyHandle` that can wait, shut down, or abort tasks on drop.

#### Function details

##### `ReservedListeners::new`  (lines 33–38)

```
fn new(http: StdTcpListener, socks: Option<StdTcpListener>) -> Self
```

**Purpose**: Wraps pre-bound std listeners in mutex-protected `Option`s so each can be consumed exactly once later.

**Data flow**: Takes ownership of an HTTP listener and optional SOCKS listener, stores them as `Some(...)` inside `Mutex<Option<StdTcpListener>>`, and returns `ReservedListeners`.

**Call relations**: Constructed by `ReservedListenerSet::into_reserved_listeners` after listener reservation during proxy build.

*Call graph*: called by 1 (into_reserved_listeners); 1 external calls (new).


##### `ReservedListeners::take_http`  (lines 40–46)

```
fn take_http(&self) -> Option<StdTcpListener>
```

**Purpose**: Consumes and returns the reserved HTTP listener if it has not already been taken.

**Data flow**: Locks the HTTP mutex, recovers from poisoning if needed, calls `take()` on the inner `Option`, and returns the listener or `None`.

**Call relations**: Used by `NetworkProxy::run` to hand the pre-bound HTTP socket to the HTTP server task.


##### `ReservedListeners::take_socks`  (lines 48–54)

```
fn take_socks(&self) -> Option<StdTcpListener>
```

**Purpose**: Consumes and returns the reserved SOCKS listener if present and not already taken.

**Data flow**: Locks the SOCKS mutex, recovers from poisoning, takes the inner `Option<StdTcpListener>`, and returns it.

**Call relations**: Used by `NetworkProxy::run` when SOCKS5 is enabled.


##### `ReservedListenerSet::new`  (lines 63–68)

```
fn new(http_listener: StdTcpListener, socks_listener: Option<StdTcpListener>) -> Self
```

**Purpose**: Creates the temporary reservation bundle returned by listener-reservation helpers.

**Data flow**: Stores the provided HTTP listener and optional SOCKS listener in a plain struct and returns it.

**Call relations**: Produced by loopback and Windows reservation helpers before being converted into shared `ReservedListeners`.

*Call graph*: called by 2 (reserve_loopback_ephemeral_listeners, try_reserve_windows_managed_listeners).


##### `ReservedListenerSet::http_addr`  (lines 70–74)

```
fn http_addr(&self) -> Result<SocketAddr>
```

**Purpose**: Reads the local address of the reserved HTTP listener with contextual error reporting.

**Data flow**: Calls `local_addr()` on `http_listener`, wraps any error with `failed to read reserved HTTP proxy address`, and returns the `SocketAddr`.

**Call relations**: Used during `NetworkProxyBuilder::build` to determine the actual managed HTTP bind address.

*Call graph*: 1 external calls (local_addr).


##### `ReservedListenerSet::socks_addr`  (lines 76–84)

```
fn socks_addr(&self, default_addr: SocketAddr) -> Result<SocketAddr>
```

**Purpose**: Reads the local address of the reserved SOCKS listener or falls back to a supplied default when no SOCKS listener was reserved.

**Data flow**: If `socks_listener` is `Some`, calls `local_addr()` with contextual error text; otherwise returns `Ok(default_addr)`.

**Call relations**: Used by `build` so disabled SOCKS mode keeps the configured address while enabled managed mode reports the reserved port.


##### `ReservedListenerSet::into_reserved_listeners`  (lines 86–91)

```
fn into_reserved_listeners(self) -> Arc<ReservedListeners>
```

**Purpose**: Converts the temporary reservation bundle into the shared, one-shot listener holder stored on `NetworkProxy`.

**Data flow**: Consumes `self`, passes its listeners to `ReservedListeners::new`, wraps the result in `Arc`, and returns it.

**Call relations**: Called by `NetworkProxyBuilder::build` after addresses have been read from the reserved sockets.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `NetworkProxyBuilder::default`  (lines 105–114)

```
fn default() -> Self
```

**Purpose**: Creates a builder with no state, no explicit addresses, Codex-managed listener allocation enabled, and no optional integrations.

**Data flow**: Returns a `NetworkProxyBuilder` with all optional fields set to `None` except `managed_by_codex: true`.

**Call relations**: Used by `NetworkProxy::builder` as the public entry point.

*Call graph*: called by 1 (builder).


##### `NetworkProxyBuilder::state`  (lines 118–121)

```
fn state(mut self, state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Sets the shared runtime state required to build a proxy.

**Data flow**: Takes ownership of an `Arc<NetworkProxyState>`, stores it in `self.state`, and returns the updated builder.

**Call relations**: Must be called before `build`; otherwise `build` errors.


##### `NetworkProxyBuilder::http_addr`  (lines 123–126)

```
fn http_addr(mut self, addr: SocketAddr) -> Self
```

**Purpose**: Overrides the HTTP bind address for unmanaged builds.

**Data flow**: Stores the provided `SocketAddr` in `self.http_addr` and returns the builder.

**Call relations**: Relevant when `managed_by_codex(false)` is used.


##### `NetworkProxyBuilder::socks_addr`  (lines 128–131)

```
fn socks_addr(mut self, addr: SocketAddr) -> Self
```

**Purpose**: Overrides the SOCKS bind address for unmanaged builds.

**Data flow**: Stores the provided `SocketAddr` in `self.socks_addr` and returns the builder.

**Call relations**: Relevant when `managed_by_codex(false)` is used.


##### `NetworkProxyBuilder::managed_by_codex`  (lines 133–136)

```
fn managed_by_codex(mut self, managed_by_codex: bool) -> Self
```

**Purpose**: Selects whether the proxy should reserve/manage its own loopback listeners or use configured/caller-provided addresses directly.

**Data flow**: Stores the boolean flag and returns the builder.

**Call relations**: Changes the main branch inside `build`.


##### `NetworkProxyBuilder::policy_decider`  (lines 138–144)

```
fn policy_decider(mut self, decider: D) -> Self
```

**Purpose**: Installs an async policy decider provided as a concrete type or closure.

**Data flow**: Wraps the decider in `Arc`, stores it in `self.policy_decider`, and returns the builder.

**Call relations**: Feeds the optional decider later passed into HTTP and SOCKS request handlers.

*Call graph*: 1 external calls (new).


##### `NetworkProxyBuilder::policy_decider_arc`  (lines 146–149)

```
fn policy_decider_arc(mut self, decider: Arc<dyn NetworkPolicyDecider>) -> Self
```

**Purpose**: Installs an already boxed/shared policy decider.

**Data flow**: Stores the supplied `Arc<dyn NetworkPolicyDecider>` and returns the builder.

**Call relations**: Alternative to the generic `policy_decider` setter.


##### `NetworkProxyBuilder::blocked_request_observer`  (lines 151–157)

```
fn blocked_request_observer(mut self, observer: O) -> Self
```

**Purpose**: Installs a blocked-request observer from a concrete type or closure.

**Data flow**: Wraps the observer in `Arc`, stores it in `self.blocked_request_observer`, and returns the builder.

**Call relations**: The observer is pushed into `NetworkProxyState` during `build`.

*Call graph*: 1 external calls (new).


##### `NetworkProxyBuilder::blocked_request_observer_arc`  (lines 159–165)

```
fn blocked_request_observer_arc(
        mut self,
        observer: Arc<dyn BlockedRequestObserver>,
    ) -> Self
```

**Purpose**: Installs an already shared blocked-request observer.

**Data flow**: Stores the supplied `Arc<dyn BlockedRequestObserver>` and returns the builder.

**Call relations**: Alternative to the generic observer setter.


##### `NetworkProxyBuilder::build`  (lines 167–231)

```
async fn build(self) -> Result<NetworkProxy>
```

**Purpose**: Validates builder inputs, derives runtime settings, reserves listeners when needed, and constructs the runnable `NetworkProxy`.

**Data flow**: Requires `self.state` or returns an error. It writes the optional blocked-request observer into state, loads current config, resolves runtime addresses, then branches on `managed_by_codex`: managed mode reserves loopback listeners (or Windows managed listeners with fallback), reads their actual addresses, and stores them as `reserved_listeners`; unmanaged mode uses explicit or configured addresses directly. It then clamps both addresses through `config::clamp_bind_addrs`, derives `NetworkProxyRuntimeSettings::from_config`, and returns a `NetworkProxy` containing state, addresses, SOCKS enablement, runtime settings lock, reserved listeners, and optional policy decider.

**Call relations**: This is the main assembly step invoked by callers before `run`; it delegates address resolution to config helpers and listener reservation to platform-specific helpers.

*Call graph*: calls 5 internal fn (clamp_bind_addrs, resolve_runtime, from_config, reserve_loopback_ephemeral_listeners, reserve_windows_managed_listeners); 2 external calls (new, new).


##### `reserve_loopback_ephemeral_listeners`  (lines 234–245)

```
fn reserve_loopback_ephemeral_listeners(
    reserve_socks_listener: bool,
) -> Result<ReservedListenerSet>
```

**Purpose**: Pre-binds one or two ephemeral loopback TCP listeners for managed proxy startup.

**Data flow**: Always reserves an HTTP listener via `reserve_loopback_ephemeral_listener`; conditionally reserves a SOCKS listener when requested; wraps both in `ReservedListenerSet` and returns it.

**Call relations**: Used by `build` on non-Windows and as the fallback path on Windows when configured managed ports are busy.

*Call graph*: calls 2 internal fn (new, reserve_loopback_ephemeral_listener); called by 2 (build, reserve_windows_managed_listeners).


##### `reserve_windows_managed_listeners`  (lines 248–265)

```
fn reserve_windows_managed_listeners(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    reserve_socks_listener: bool,
) -> Result<ReservedListenerSet>
```

**Purpose**: Attempts to reserve configured Windows managed proxy ports on loopback, falling back to ephemeral loopback ports if the address is already in use.

**Data flow**: Clamps both requested addresses to loopback with `windows_managed_loopback_addr`, calls `try_reserve_windows_managed_listeners`, returns success directly, falls back to `reserve_loopback_ephemeral_listeners` on `AddrInUse`, or wraps other errors with context.

**Call relations**: Windows-only helper used by `build`; its fallback behavior is covered by tests.

*Call graph*: calls 3 internal fn (reserve_loopback_ephemeral_listeners, try_reserve_windows_managed_listeners, windows_managed_loopback_addr); called by 2 (build, reserve_windows_managed_listeners_falls_back_when_http_port_is_busy); 1 external calls (warn!).


##### `try_reserve_windows_managed_listeners`  (lines 268–280)

```
fn try_reserve_windows_managed_listeners(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    reserve_socks_listener: bool,
) -> std::io::Result<ReservedListenerSet>
```

**Purpose**: Binds the requested Windows managed HTTP and optional SOCKS ports without fallback logic.

**Data flow**: Calls `StdTcpListener::bind` for the HTTP address and optionally for the SOCKS address, then returns a `ReservedListenerSet`.

**Call relations**: Internal helper called by `reserve_windows_managed_listeners`.

*Call graph*: calls 1 internal fn (new); called by 1 (reserve_windows_managed_listeners); 1 external calls (bind).


##### `windows_managed_loopback_addr`  (lines 283–291)

```
fn windows_managed_loopback_addr(addr: SocketAddr) -> SocketAddr
```

**Purpose**: Forces a managed Windows bind address onto `127.0.0.1` while preserving the port.

**Data flow**: Checks whether the input IP is loopback, logs a warning if not, and returns `SocketAddr::from(([127,0,0,1], addr.port()))`.

**Call relations**: Used before binding managed Windows listeners so they never expose non-loopback interfaces.

*Call graph*: called by 1 (reserve_windows_managed_listeners); 4 external calls (from, ip, port, warn!).


##### `reserve_loopback_ephemeral_listener`  (lines 293–296)

```
fn reserve_loopback_ephemeral_listener() -> Result<StdTcpListener>
```

**Purpose**: Binds a single ephemeral TCP listener on IPv4 loopback.

**Data flow**: Calls `StdTcpListener::bind(127.0.0.1:0)`, adds context on failure, and returns the listener.

**Call relations**: Primitive used by `reserve_loopback_ephemeral_listeners`.

*Call graph*: called by 1 (reserve_loopback_ephemeral_listeners); 2 external calls (from, bind).


##### `NetworkProxyRuntimeSettings::from_config`  (lines 307–323)

```
fn from_config(config: &config::NetworkProxyConfig) -> Result<Self>
```

**Purpose**: Extracts the subset of config that can change at runtime without restarting listeners, including optional managed MITM CA state.

**Data flow**: Reads booleans and unix-socket allowlist from `config.network`. If MITM is enabled, collects startup values for `crate::certs::CUSTOM_CA_ENV_KEYS` from the process environment and builds a managed CA trust bundle; otherwise leaves it `None`. Returns the populated settings struct.

**Call relations**: Called during initial `build` and later by `replace_config_state` when live config updates are applied.

*Call graph*: calls 1 internal fn (managed_ca_trust_bundle); called by 2 (replace_config_state, build).


##### `NetworkProxy::fmt`  (lines 338–345)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats the proxy for debugging without exposing sensitive or noisy internal config-derived state.

**Data flow**: Writes a non-exhaustive debug struct containing only `http_addr` and `socks_addr`.

**Call relations**: Used implicitly by logging/debugging code.

*Call graph*: 1 external calls (debug_struct).


##### `NetworkProxy::eq`  (lines 349–353)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Defines equality in terms of externally relevant bind addresses and runtime settings snapshot.

**Data flow**: Compares `http_addr`, `socks_addr`, and the cloned result of `runtime_settings()` between two proxies, returning a boolean.

**Call relations**: Supports tests and comparisons without considering internal shared-state identity.

*Call graph*: calls 1 internal fn (runtime_settings); 1 external calls (runtime_settings).


##### `proxy_url_env_value`  (lines 452–461)

```
fn proxy_url_env_value(
    env: &'a HashMap<String, String>,
    canonical_key: &str,
) -> Option<&'a str>
```

**Purpose**: Looks up a canonical proxy environment variable, falling back to its lowercase alias.

**Data flow**: Checks `env` for `canonical_key`; if absent, lowercases the key and checks again. Returns `Option<&str>`.

**Call relations**: Used by `has_proxy_url_env_vars` to detect whether any proxy URL variables are already present.


##### `has_proxy_url_env_vars`  (lines 463–467)

```
fn has_proxy_url_env_vars(env: &HashMap<String, String>) -> bool
```

**Purpose**: Detects whether an environment map already contains any non-empty proxy URL variables.

**Data flow**: Iterates `PROXY_URL_ENV_KEYS`, resolves each through `proxy_url_env_value`, trims the value, and returns true if any are non-empty.

**Call relations**: Utility for callers deciding whether proxy-related environment is already configured.


##### `set_env_keys`  (lines 469–473)

```
fn set_env_keys(env: &mut HashMap<String, String>, keys: &[&str], value: &str)
```

**Purpose**: Writes the same string value to a list of environment-variable keys.

**Data flow**: Iterates the provided key slice and inserts `value.to_string()` into the mutable `HashMap` under each key.

**Call relations**: Internal helper used repeatedly by `apply_proxy_env_overrides`.

*Call graph*: called by 1 (apply_proxy_env_overrides).


##### `codex_proxy_git_ssh_command`  (lines 476–478)

```
fn codex_proxy_git_ssh_command(socks_addr: SocketAddr) -> String
```

**Purpose**: Builds the managed macOS `GIT_SSH_COMMAND` wrapper that tunnels SSH through the SOCKS proxy.

**Data flow**: Formats the configured prefix, `socks_addr`, and suffix into a single shell command string.

**Call relations**: Used by `apply_proxy_env_overrides` and macOS-specific tests.

*Call graph*: called by 2 (apply_proxy_env_overrides, apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command); 1 external calls (format!).


##### `is_codex_proxy_git_ssh_command`  (lines 481–484)

```
fn is_codex_proxy_git_ssh_command(command: &str) -> bool
```

**Purpose**: Recognizes whether an existing `GIT_SSH_COMMAND` was previously injected by Codex.

**Data flow**: Checks whether the command starts with the managed prefix and ends with the managed suffix, returning a boolean.

**Call relations**: Used by `apply_proxy_env_overrides` to refresh only Codex-managed wrappers while preserving user-provided SSH wrappers.

*Call graph*: called by 1 (apply_proxy_env_overrides).


##### `apply_proxy_env_overrides`  (lines 486–593)

```
fn apply_proxy_env_overrides(
    env: &mut HashMap<String, String>,
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    socks_enabled: bool,
    allow_local_binding: bool,
    mitm_ca_trust_bu
```

**Purpose**: Rewrites a child-process environment so common tools route traffic through the managed proxy while preserving a few intentional overrides.

**Data flow**: Builds `http://{http_addr}` and `socks5h://{socks_addr}` URLs, sets `CODEX_NETWORK_PROXY_ACTIVE` and `CODEX_NETWORK_ALLOW_LOCAL_BINDING`, writes HTTP-family proxy vars to the HTTP URL, websocket vars to the HTTP URL, and `NO_PROXY` vars to `DEFAULT_NO_PROXY_VALUE`. It enables Electron/Node proxy toggles, sets `ALL_PROXY` and `FTP_PROXY` to SOCKS when SOCKS is enabled or HTTP otherwise, optionally injects/refreshed macOS `GIT_SSH_COMMAND`, and if a managed MITM CA bundle exists, writes CA env vars unless a non-startup command-scoped override should be preserved. It mutates the provided `HashMap<String, String>` in place and returns nothing.

**Call relations**: Called by `NetworkProxy::apply_to_env`; tests cover the exact key set, SOCKS-vs-HTTP routing, CA bundle behavior, and macOS SSH wrapper preservation.

*Call graph*: calls 3 internal fn (codex_proxy_git_ssh_command, is_codex_proxy_git_ssh_command, set_env_keys); called by 10 (apply_to_env, apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override, apply_proxy_env_overrides_preserves_existing_git_ssh_command, apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape, apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command, apply_proxy_env_overrides_sets_common_tool_vars, apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars, apply_proxy_env_overrides_sets_only_expected_env_keys, apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks, apply_proxy_env_overrides_uses_plain_http_proxy_url); 1 external calls (format!).


##### `NetworkProxy::builder`  (lines 596–598)

```
fn builder() -> NetworkProxyBuilder
```

**Purpose**: Returns a fresh builder for constructing a proxy instance.

**Data flow**: Calls `NetworkProxyBuilder::default()` and returns it.

**Call relations**: Public entry point used by startup code and tests.

*Call graph*: calls 1 internal fn (default); called by 6 (start_proxy, test_network_proxy, managed_proxy_builder_does_not_reserve_socks_listener_when_disabled, managed_proxy_builder_uses_loopback_ports, non_codex_managed_proxy_builder_uses_configured_ports, create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths).


##### `NetworkProxy::http_addr`  (lines 600–602)

```
fn http_addr(&self) -> SocketAddr
```

**Purpose**: Returns the configured HTTP listener address.

**Data flow**: Copies and returns `self.http_addr`.

**Call relations**: Used by callers that need to advertise or inspect the HTTP proxy endpoint.


##### `NetworkProxy::socks_addr`  (lines 604–606)

```
fn socks_addr(&self) -> SocketAddr
```

**Purpose**: Returns the configured SOCKS listener address.

**Data flow**: Copies and returns `self.socks_addr`.

**Call relations**: Used by callers that need to advertise or inspect the SOCKS proxy endpoint.


##### `NetworkProxy::current_cfg`  (lines 608–610)

```
async fn current_cfg(&self) -> Result<config::NetworkProxyConfig>
```

**Purpose**: Fetches the current live network proxy config from shared state.

**Data flow**: Awaits `self.state.current_cfg()` and returns the resulting `NetworkProxyConfig`.

**Call relations**: Thin forwarding method for callers that hold a `NetworkProxy` rather than the underlying state.


##### `NetworkProxy::add_allowed_domain`  (lines 612–614)

```
async fn add_allowed_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host to the live allowlist through shared state.

**Data flow**: Forwards the host string to `self.state.add_allowed_domain(host).await` and returns its `Result<()>`.

**Call relations**: Convenience wrapper over runtime state mutation.


##### `NetworkProxy::add_denied_domain`  (lines 616–618)

```
async fn add_denied_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host to the live denylist through shared state.

**Data flow**: Forwards the host string to `self.state.add_denied_domain(host).await` and returns its `Result<()>`.

**Call relations**: Convenience wrapper over runtime state mutation.


##### `NetworkProxy::allow_local_binding`  (lines 620–622)

```
fn allow_local_binding(&self) -> bool
```

**Purpose**: Returns the current runtime snapshot of whether local/private destinations may be contacted.

**Data flow**: Clones the runtime settings via `runtime_settings()` and returns its `allow_local_binding` field.

**Call relations**: Used by callers that need a cheap synchronous view of this runtime knob.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::allow_unix_sockets`  (lines 624–626)

```
fn allow_unix_sockets(&self) -> Arc<[String]>
```

**Purpose**: Returns the current runtime unix-socket allowlist snapshot.

**Data flow**: Clones runtime settings and returns the `Arc<[String]>` allowlist.

**Call relations**: Used by callers integrating unix-socket proxying or sandbox rules.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::dangerously_allow_all_unix_sockets`  (lines 628–630)

```
fn dangerously_allow_all_unix_sockets(&self) -> bool
```

**Purpose**: Returns whether unix-socket access is globally allowed at runtime.

**Data flow**: Clones runtime settings and returns the boolean flag.

**Call relations**: Used by callers that need to mirror proxy unix-socket policy elsewhere.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::managed_mitm_ca_trust_bundle_path`  (lines 633–641)

```
fn managed_mitm_ca_trust_bundle_path(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the absolute path to the managed MITM CA bundle, if one exists and validates as an absolute path wrapper.

**Data flow**: Clones runtime settings, extracts the optional bundle path, attempts `AbsolutePathBuf::from_absolute_path`, logs a warning on validation failure, and returns `Option<AbsolutePathBuf>`.

**Call relations**: Used by child-sandbox setup code that needs to expose the generated CA bundle.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::apply_to_env`  (lines 643–655)

```
fn apply_to_env(&self, env: &mut HashMap<String, String>)
```

**Purpose**: Applies the proxy’s current endpoint and runtime settings to a mutable child-process environment map.

**Data flow**: Clones runtime settings, then calls `apply_proxy_env_overrides` with the proxy’s HTTP/SOCKS addresses, SOCKS enablement, local-binding flag, and optional MITM CA bundle reference. Mutates the provided environment map in place.

**Call relations**: Public wrapper around the lower-level environment rewrite helper.

*Call graph*: calls 2 internal fn (runtime_settings, apply_proxy_env_overrides).


##### `NetworkProxy::replace_config_state`  (lines 657–688)

```
async fn replace_config_state(&self, new_state: ConfigState) -> Result<()>
```

**Purpose**: Applies a live config-state replacement while forbidding changes that would require listener topology changes or restart.

**Data flow**: Loads current config from state, uses `ensure!` to reject changes to `network.enabled`, `proxy_url`, `socks_url`, `enable_socks5`, and `enable_socks5_udp`, derives fresh `NetworkProxyRuntimeSettings` from the new config, writes the new `ConfigState` into `self.state`, then updates the `runtime_settings` write lock.

**Call relations**: Used for live reconfiguration after startup; delegates actual state replacement to `NetworkProxyState` but guards immutable-at-runtime fields here.

*Call graph*: calls 1 internal fn (from_config); 1 external calls (ensure!).


##### `NetworkProxy::runtime_settings`  (lines 690–695)

```
fn runtime_settings(&self) -> NetworkProxyRuntimeSettings
```

**Purpose**: Returns a cloned snapshot of the proxy’s mutable runtime settings.

**Data flow**: Reads the `RwLock<NetworkProxyRuntimeSettings>`, recovers from poisoning if needed, clones the settings, and returns them.

**Call relations**: Internal helper used by synchronous getters, equality, env application, and CA bundle path lookup.

*Call graph*: called by 6 (allow_local_binding, allow_unix_sockets, apply_to_env, dangerously_allow_all_unix_sockets, eq, managed_mitm_ca_trust_bundle_path).


##### `NetworkProxy::run`  (lines 697–763)

```
async fn run(&self) -> Result<NetworkProxyHandle>
```

**Purpose**: Starts the HTTP and optional SOCKS proxy servers as Tokio tasks and returns a handle for waiting or shutdown.

**Data flow**: Loads current config; if networking is disabled, logs a warning and returns `NetworkProxyHandle::noop()`. Otherwise warns on unsupported unix-socket permissions platforms, consumes any reserved listeners, clones state and optional decider for each task, spawns the HTTP server using either a reserved std listener or bind address, conditionally spawns the SOCKS server similarly when enabled, and returns `NetworkProxyHandle { http_task, socks_task, completed: false }`.

**Call relations**: Main runtime entry point after `build`; delegates transport serving to `http_proxy` and `socks5` modules.

*Call graph*: calls 6 internal fn (run_http_proxy, run_http_proxy_with_std_listener, noop, unix_socket_permissions_supported, run_socks5, run_socks5_with_std_listener); 2 external calls (spawn, warn!).


##### `NetworkProxyHandle::noop`  (lines 773–779)

```
fn noop() -> Self
```

**Purpose**: Creates a handle representing a disabled proxy run that is already effectively complete.

**Data flow**: Spawns a trivial Tokio task returning `Ok(())`, stores it as `http_task`, leaves `socks_task` as `None`, marks `completed: true`, and returns the handle.

**Call relations**: Returned by `NetworkProxy::run` when `network.enabled` is false.

*Call graph*: called by 1 (run); 1 external calls (spawn).


##### `NetworkProxyHandle::wait`  (lines 781–795)

```
async fn wait(mut self) -> Result<()>
```

**Purpose**: Awaits proxy task completion and propagates task or inner server errors.

**Data flow**: Takes ownership of the stored join handles, errors if the HTTP task is missing, awaits the HTTP task and optional SOCKS task, marks `completed = true`, unwraps both join results and inner `Result<()>` values, and returns `Ok(())` on success.

**Call relations**: Used by callers that want the proxy to run until one of its server tasks exits.


##### `NetworkProxyHandle::shutdown`  (lines 797–801)

```
async fn shutdown(mut self) -> Result<()>
```

**Purpose**: Aborts running proxy tasks and waits for their termination.

**Data flow**: Takes both task handles, passes them to `abort_tasks`, marks the handle completed, and returns `Ok(())`.

**Call relations**: Explicit shutdown path for callers that do not want to rely on drop-triggered cleanup.

*Call graph*: calls 1 internal fn (abort_tasks).


##### `abort_task`  (lines 804–809)

```
async fn abort_task(task: Option<JoinHandle<Result<()>>>)
```

**Purpose**: Aborts a single optional Tokio task and suppresses any join error after cancellation.

**Data flow**: If the handle is `Some`, calls `abort()`, awaits it, discards the result, and returns `()`.

**Call relations**: Internal helper used by `abort_tasks`.

*Call graph*: called by 1 (abort_tasks).


##### `abort_tasks`  (lines 811–817)

```
async fn abort_tasks(
    http_task: Option<JoinHandle<Result<()>>>,
    socks_task: Option<JoinHandle<Result<()>>>,
)
```

**Purpose**: Sequentially aborts the HTTP and SOCKS server tasks.

**Data flow**: Calls `abort_task(http_task).await` and then `abort_task(socks_task).await`.

**Call relations**: Used by explicit shutdown and by the handle’s `Drop` implementation.

*Call graph*: calls 1 internal fn (abort_task); called by 2 (drop, shutdown).


##### `NetworkProxyHandle::drop`  (lines 820–829)

```
fn drop(&mut self)
```

**Purpose**: Ensures unfinished proxy tasks are aborted asynchronously if the handle is dropped without `wait` or `shutdown`.

**Data flow**: If `completed` is false, takes both task handles and spawns a Tokio task that calls `abort_tasks` on them.

**Call relations**: Safety net for leaked or forgotten handles so background proxy tasks do not outlive their owner unexpectedly.

*Call graph*: calls 1 internal fn (abort_tasks); 1 external calls (spawn).


##### `tests::managed_proxy_builder_uses_loopback_ports`  (lines 843–881)

```
async fn managed_proxy_builder_uses_loopback_ports()
```

**Purpose**: Verifies managed builds reserve loopback listener addresses rather than exposing arbitrary configured addresses.

**Data flow**: Pre-binds temporary loopback listeners to obtain free ports, builds a managed proxy from config pointing at those ports, tolerates permission-related build failures, and asserts resulting HTTP/SOCKS addresses are loopback with platform-specific expectations.

**Call relations**: Exercises the managed branch of `NetworkProxyBuilder::build`.

*Call graph*: calls 2 internal fn (default, builder); 9 external calls (new, from, bind, assert!, assert_eq!, assert_ne!, network_proxy_state_for_policy, format!, panic!).


##### `tests::non_codex_managed_proxy_builder_uses_configured_ports`  (lines 884–906)

```
async fn non_codex_managed_proxy_builder_uses_configured_ports()
```

**Purpose**: Checks unmanaged builds use the configured bind addresses directly.

**Data flow**: Builds state with explicit proxy URLs, constructs a builder with `managed_by_codex(false)`, awaits `build`, and asserts the resulting addresses equal the configured socket addresses.

**Call relations**: Covers the unmanaged branch of `build`.

*Call graph*: calls 2 internal fn (default, builder); 3 external calls (new, assert_eq!, network_proxy_state_for_policy).


##### `tests::managed_proxy_builder_does_not_reserve_socks_listener_when_disabled`  (lines 909–944)

```
async fn managed_proxy_builder_does_not_reserve_socks_listener_when_disabled()
```

**Purpose**: Ensures managed builds skip reserving a SOCKS listener when SOCKS5 is disabled in config.

**Data flow**: Builds managed proxy state with `enable_socks5: false`, awaits `build`, then asserts the HTTP address is loopback/ephemeral, the SOCKS address remains the configured one, and `reserved_listeners.take_socks()` returns `None`.

**Call relations**: Tests the conditional SOCKS reservation logic in `build` and `reserve_loopback_ephemeral_listeners`.

*Call graph*: calls 2 internal fn (default, builder); 6 external calls (new, assert!, assert_eq!, assert_ne!, network_proxy_state_for_policy, panic!).


##### `tests::windows_managed_loopback_addr_clamps_non_loopback_inputs`  (lines 948–957)

```
fn windows_managed_loopback_addr_clamps_non_loopback_inputs()
```

**Purpose**: Verifies Windows managed addresses are clamped to IPv4 loopback while preserving ports.

**Data flow**: Calls `windows_managed_loopback_addr` on non-loopback IPv4 and IPv6 wildcard addresses and asserts the returned addresses are `127.0.0.1` with the same ports.

**Call relations**: Windows-only regression test for the loopback-clamping helper.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::reserve_windows_managed_listeners_falls_back_when_http_port_is_busy`  (lines 961–985)

```
fn reserve_windows_managed_listeners_falls_back_when_http_port_is_busy()
```

**Purpose**: Checks that Windows managed listener reservation falls back to ephemeral loopback ports when the configured HTTP port is occupied.

**Data flow**: Occupies a loopback port, calls `reserve_windows_managed_listeners` with that busy port, and asserts the returned HTTP listener is still loopback but not on the busy port and that no SOCKS listener was reserved.

**Call relations**: Covers the `AddrInUse` fallback branch.

*Call graph*: calls 1 internal fn (reserve_windows_managed_listeners); 4 external calls (from, bind, assert!, assert_ne!).


##### `tests::proxy_url_env_value_resolves_lowercase_aliases`  (lines 988–999)

```
fn proxy_url_env_value_resolves_lowercase_aliases()
```

**Purpose**: Verifies canonical proxy env lookup falls back to lowercase aliases.

**Data flow**: Creates an env map containing only `http_proxy`, calls `proxy_url_env_value(&env, "HTTP_PROXY")`, and asserts the lowercase value is returned.

**Call relations**: Unit test for environment lookup normalization.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::has_proxy_url_env_vars_detects_lowercase_aliases`  (lines 1002–1010)

```
fn has_proxy_url_env_vars_detects_lowercase_aliases()
```

**Purpose**: Checks proxy-env detection notices lowercase proxy variables.

**Data flow**: Creates an env map with `all_proxy`, calls `has_proxy_url_env_vars`, and asserts it returns true.

**Call relations**: Covers `has_proxy_url_env_vars` plus lowercase alias resolution.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::has_proxy_url_env_vars_detects_websocket_proxy_keys`  (lines 1013–1018)

```
fn has_proxy_url_env_vars_detects_websocket_proxy_keys()
```

**Purpose**: Checks proxy-env detection includes websocket-specific proxy variables.

**Data flow**: Creates an env map with `wss_proxy`, calls `has_proxy_url_env_vars`, and asserts true.

**Call relations**: Documents that websocket proxy vars count as proxy configuration.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::apply_proxy_env_overrides_sets_common_tool_vars`  (lines 1021–1082)

```
fn apply_proxy_env_overrides_sets_common_tool_vars()
```

**Purpose**: Verifies the environment rewrite populates the expected common proxy variables and toggles.

**Data flow**: Calls `apply_proxy_env_overrides` on an empty env with localhost HTTP/SOCKS addresses and asserts values for HTTP/WS/npm/ALL_PROXY/FTP_PROXY/NO_PROXY, local-binding and active flags, Electron/Node toggles, and macOS-specific SSH wrapper behavior.

**Call relations**: Broad regression test for the main env-rewrite helper.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 5 external calls (new, V4, new, assert!, assert_eq!).


##### `tests::apply_proxy_env_overrides_sets_only_expected_env_keys`  (lines 1085–1104)

```
fn apply_proxy_env_overrides_sets_only_expected_env_keys()
```

**Purpose**: Ensures the env rewrite does not introduce unexpected keys beyond the documented proxy-related set.

**Data flow**: Applies overrides to an empty env, iterates resulting keys, and asserts each is in `PROXY_ENV_KEYS` or the managed macOS SSH key.

**Call relations**: Guards against accidental environment sprawl in `apply_proxy_env_overrides`.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 5 external calls (new, V4, new, assert!, cfg!).


##### `tests::apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars`  (lines 1107–1129)

```
fn apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars()
```

**Purpose**: Checks that a managed MITM CA bundle path is written to all custom CA environment variables.

**Data flow**: Constructs a `ManagedMitmCaTrustBundle`, applies env overrides with it, and asserts every key in `crate::certs::CUSTOM_CA_ENV_KEYS` points to the bundle path string.

**Call relations**: Covers the CA-bundle branch of `apply_proxy_env_overrides`.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 5 external calls (new, V4, new, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override`  (lines 1132–1158)

```
fn apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override()
```

**Purpose**: Verifies command-scoped CA overrides are preserved while other CA vars still receive the managed bundle.

**Data flow**: Starts with `REQUESTS_CA_BUNDLE` already set to a command-specific path, applies overrides with a managed bundle, and asserts that key is unchanged while `SSL_CERT_FILE` is set to the managed path.

**Call relations**: Tests the selective-preservation logic for CA env vars.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 6 external calls (from, new, V4, new, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks`  (lines 1161–1177)

```
fn apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks()
```

**Purpose**: Checks that `ALL_PROXY` falls back to the HTTP proxy URL when SOCKS is disabled.

**Data flow**: Applies overrides with `socks_enabled: false` and asserts `ALL_PROXY` uses `http://...` and local binding flag is `1`.

**Call relations**: Covers the non-SOCKS branch in env rewriting.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_uses_plain_http_proxy_url`  (lines 1180–1221)

```
fn apply_proxy_env_overrides_uses_plain_http_proxy_url()
```

**Purpose**: Verifies HTTP-family variables always use plain HTTP proxy URLs even when SOCKS is enabled.

**Data flow**: Applies overrides with SOCKS enabled and asserts `HTTP_PROXY`, `HTTPS_PROXY`, `WS_PROXY`, and `WSS_PROXY` use the HTTP URL while `ALL_PROXY` uses the SOCKS URL, plus macOS SSH wrapper expectations.

**Call relations**: Documents the deliberate split between HTTP-family vars and `ALL_PROXY`.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_preserves_existing_git_ssh_command`  (lines 1225–1244)

```
fn apply_proxy_env_overrides_preserves_existing_git_ssh_command()
```

**Purpose**: Ensures a user-provided macOS `GIT_SSH_COMMAND` is not overwritten by the managed proxy wrapper.

**Data flow**: Seeds the env with a non-Codex SSH wrapper, applies overrides, and asserts the original command remains unchanged.

**Call relations**: Covers the preservation branch guarded by `is_codex_proxy_git_ssh_command`.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape`  (lines 1248–1267)

```
fn apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape()
```

**Purpose**: Checks that even a proxy-shaped SSH command is preserved if it was not marked as Codex-managed.

**Data flow**: Seeds `GIT_SSH_COMMAND` with an unmarked `nc -X 5 -x ...` wrapper, applies overrides with a different SOCKS port, and asserts the original command is retained.

**Call relations**: Prevents accidental takeover of user-managed SSH proxy wrappers.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command`  (lines 1271–1294)

```
fn apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command()
```

**Purpose**: Verifies a previously injected Codex SSH wrapper is refreshed to the new SOCKS port after restart.

**Data flow**: Seeds `GIT_SSH_COMMAND` with `codex_proxy_git_ssh_command(old_port)`, applies overrides with a new SOCKS port, and asserts the env now contains the regenerated command for the new port.

**Call relations**: Covers the refresh branch for managed SSH wrappers.

*Call graph*: calls 2 internal fn (apply_proxy_env_overrides, codex_proxy_git_ssh_command); 4 external calls (new, V4, new, assert_eq!).


### `network-proxy/src/socks5.rs`

`io_transport` · `SOCKS listener startup and per-request handling`

This file wires the `rama_socks5` server stack into the proxy’s policy engine. `run_socks5` binds a listener, `run_socks5_with_std_listener` adapts a pre-reserved std listener, and `run_socks5_with_listener` builds the acceptor pipeline: a `TargetCheckedTcpConnector` for outbound TCP dials, a policy-aware TCP connector service that routes each SOCKS CONNECT through `handle_socks5_tcp`, and an optional UDP relay inspector that routes each UDP association packet through `inspect_socks5_udp`. The shared `Arc<NetworkProxyState>` is injected into request extensions so handlers can read live policy.

`handle_socks5_tcp` is the main admission path. It normalizes the target host, extracts the client peer address if available, rejects disabled proxy state and limited-mode non-HTTPS traffic with non-domain audit events plus `BlockedRequest` telemetry, then builds a `NetworkPolicyRequest` and calls `evaluate_host_policy`. On denial it records the blocked request and returns an `io::ErrorKind::PermissionDenied` whose message comes from `blocked_message_with_policy`. On allow, it decides whether HTTPS MITM is required: port 443 is the only SOCKS TCP target treated as safely identifiable HTTPS, and MITM is required either in limited mode or when host-specific MITM hooks exist. If MITM is needed but unavailable—or hooks exist on a non-443 target—the request is denied. Otherwise the function either returns a `Socks5TcpConnection::Mitm` placeholder carrying target metadata and `MitmState`, or performs a real upstream dial and wraps the resulting `TcpStream` as `Direct`.

`Socks5TcpConnection` implements `AsyncRead`, `AsyncWrite`, `Socket`, and extension access. The `Mitm` variant is intentionally a dummy socket that reports success/no-op behavior until `proxy_socks5_tcp` swaps into the MITM stream path by inserting `ProxyTarget`, `NetworkMode`, and `MitmState` into source extensions and calling `mitm::mitm_stream`.

#### Function details

##### `run_socks5`  (lines 63–78)

```
async fn run_socks5(
    state: Arc<NetworkProxyState>,
    addr: SocketAddr,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    enable_socks5_udp: bool,
) -> Result<()>
```

**Purpose**: Binds a SOCKS5 TCP listener on the requested address and starts serving requests.

**Data flow**: Takes shared state, bind address, optional policy decider, and UDP enable flag; builds a `rama_tcp::server::TcpListener`, wraps bind errors with context, then delegates to `run_socks5_with_listener`.

**Call relations**: Called by `NetworkProxy::run` when SOCKS5 is enabled and no reserved std listener is being used.

*Call graph*: calls 1 internal fn (run_socks5_with_listener); called by 1 (run); 1 external calls (build).


##### `run_socks5_with_std_listener`  (lines 80–89)

```
async fn run_socks5_with_std_listener(
    state: Arc<NetworkProxyState>,
    listener: StdTcpListener,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    enable_socks5_udp: bool,
) -> Res
```

**Purpose**: Starts the SOCKS5 server from a pre-bound std TCP listener.

**Data flow**: Converts `StdTcpListener` into `rama`’s `TcpListener` with contextual error handling, then delegates to `run_socks5_with_listener`.

**Call relations**: Called by `NetworkProxy::run` when managed startup reserved the SOCKS listener in advance.

*Call graph*: calls 1 internal fn (run_socks5_with_listener); called by 1 (run); 1 external calls (try_from).


##### `run_socks5_with_listener`  (lines 91–151)

```
async fn run_socks5_with_listener(
    state: Arc<NetworkProxyState>,
    listener: TcpListener,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
    enable_socks5_udp: bool,
) -> Result<()>
```

**Purpose**: Builds the SOCKS5 acceptor pipeline, logs startup/mode information, and serves TCP and optional UDP traffic.

**Data flow**: Reads the listener’s local address for logging, queries `state.network_mode()` to log limited-mode caveats, constructs a `TargetCheckedTcpConnector`, wraps `handle_socks5_tcp` in a `service_fn`, builds a `DefaultConnector` and `Socks5Acceptor`, optionally attaches a UDP relay inspector that calls `inspect_socks5_udp`, injects shared state into request extensions with `AddInputExtensionLayer`, and awaits `listener.serve(...)`. Returns `Ok(())` after serving exits.

**Call relations**: Shared serving implementation used by both bind paths.

*Call graph*: calls 1 internal fn (new); called by 2 (run_socks5, run_socks5_with_std_listener); 9 external calls (new, default, default, new, local_addr, serve, info!, service_fn, warn!).


##### `handle_socks5_tcp`  (lines 153–408)

```
async fn handle_socks5_tcp(
    req: TcpRequest,
    tcp_connector: TargetCheckedTcpConnector,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<EstablishedClientConnection<Socks5
```

**Purpose**: Evaluates one SOCKS5 TCP CONNECT request against proxy-enabled state, mode restrictions, host policy, and MITM requirements, then either dials upstream or returns a MITM placeholder connection.

**Data flow**: Reads `Arc<NetworkProxyState>` and optional `SocketInfo` from request extensions, normalizes the target host, rejects empty hosts, and branches through several checks: proxy enabled, network mode, limited-mode HTTPS-only rule, domain policy via `evaluate_host_policy`, MITM-hook presence, and MITM-state availability. On each denial branch it emits a non-domain audit event when appropriate, constructs `PolicyDecisionDetails`, records a `BlockedRequest`, logs a warning, and returns `PermissionDenied`. On allow, if MITM is needed and available it returns `EstablishedClientConnection { input: req, conn: Socks5TcpConnection::Mitm { ... } }`; otherwise it times and awaits `tcp_connector.serve(req)`, wraps the resulting stream as `Direct`, logs success/failure timing, and returns the connection or upstream error.

**Call relations**: Installed as the TCP connector service inside `run_socks5_with_listener`; it delegates baseline/domain policy to `evaluate_host_policy`, blocked telemetry to `record_blocked`, and MITM execution later to `proxy_socks5_tcp`.

*Call graph*: calls 7 internal fn (serve, new, evaluate_host_policy, normalize_host, new, emit_socks_block_decision_audit_event, policy_denied_error); called by 4 (handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode, handle_socks5_tcp_blocks_limited_mode_without_mitm_state, handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode, handle_socks5_tcp_uses_mitm_in_limited_mode); 8 external calls (new, now, extensions, new, other, error!, info!, warn!).


##### `Socks5TcpConnection::poll_read`  (lines 424–433)

```
fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>>
```

**Purpose**: Implements async reads for direct upstream sockets and a no-op successful read for MITM placeholders.

**Data flow**: Matches on the mutable enum: forwards `poll_read` to the inner `TcpStream` for `Direct`, or returns `Poll::Ready(Ok(()))` for `Mitm`.

**Call relations**: Part of making `Socks5TcpConnection` satisfy the socket traits expected by the SOCKS server stack.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::poll_write`  (lines 437–446)

```
fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>>
```

**Purpose**: Implements async writes for direct sockets and a sink-like successful write for MITM placeholders.

**Data flow**: For `Direct`, forwards to the inner stream’s `poll_write`; for `Mitm`, immediately returns `Ok(buf.len())`.

**Call relations**: Used by the SOCKS stack before `proxy_socks5_tcp` decides whether to forward directly or enter MITM.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::poll_flush`  (lines 448–453)

```
fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>>
```

**Purpose**: Implements flush behavior for direct sockets and a no-op success for MITM placeholders.

**Data flow**: For `Direct`, forwards `poll_flush`; for `Mitm`, returns `Poll::Ready(Ok(()))`.

**Call relations**: Trait plumbing for the connection wrapper.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::poll_shutdown`  (lines 455–460)

```
fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>>
```

**Purpose**: Implements shutdown behavior for direct sockets and a no-op success for MITM placeholders.

**Data flow**: For `Direct`, forwards `poll_shutdown`; for `Mitm`, returns `Poll::Ready(Ok(()))`.

**Call relations**: Trait plumbing for the connection wrapper.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::local_addr`  (lines 464–469)

```
fn local_addr(&self) -> io::Result<SocketAddr>
```

**Purpose**: Returns the local socket address for direct connections and a dummy zero address for MITM placeholders.

**Data flow**: Matches on `self`; forwards to `TcpStream::local_addr()` for `Direct`, or returns `0.0.0.0:0` for `Mitm`.

**Call relations**: Implements the `Socket` trait required by the SOCKS proxy machinery.

*Call graph*: 1 external calls (from).


##### `Socks5TcpConnection::peer_addr`  (lines 471–476)

```
fn peer_addr(&self) -> io::Result<SocketAddr>
```

**Purpose**: Returns the peer socket address for direct connections and a dummy zero address for MITM placeholders.

**Data flow**: Matches on `self`; forwards to `TcpStream::peer_addr()` for `Direct`, or returns `0.0.0.0:0` for `Mitm`.

**Call relations**: Implements the `Socket` trait required by the SOCKS proxy machinery.

*Call graph*: 1 external calls (from).


##### `Socks5TcpConnection::extensions`  (lines 480–485)

```
fn extensions(&self) -> &Extensions
```

**Purpose**: Exposes immutable extension storage for either the direct stream or the MITM placeholder.

**Data flow**: Returns `stream.extensions()` for `Direct` or the stored `extensions` field for `Mitm`.

**Call relations**: Allows later pipeline stages to read connection-associated metadata uniformly.


##### `Socks5TcpConnection::extensions_mut`  (lines 489–494)

```
fn extensions_mut(&mut self) -> &mut Extensions
```

**Purpose**: Exposes mutable extension storage for either the direct stream or the MITM placeholder.

**Data flow**: Returns `stream.extensions_mut()` for `Direct` or `&mut extensions` for `Mitm`.

**Call relations**: Used when later stages need to attach metadata to the connection wrapper.


##### `proxy_socks5_tcp`  (lines 497–515)

```
async fn proxy_socks5_tcp(
    request: ProxyRequest<TcpStream, Socks5TcpConnection>,
) -> Result<(), BoxError>
```

**Purpose**: Executes the final SOCKS5 TCP proxy action, either direct stream forwarding or MITM interception.

**Data flow**: Destructures `ProxyRequest { source, target }`. For `Direct(target)`, forwards bytes with `StreamForwardService::default().serve(...)`. For `Mitm { target, mode, mitm, .. }`, inserts `ProxyTarget(target)`, `mode`, and `mitm` into the source stream’s extensions and calls `mitm::mitm_stream(source)`. Returns `Result<(), BoxError>`.

**Call relations**: Installed as the SOCKS proxy service in `run_socks5_with_listener`; it is the consumer of the `Socks5TcpConnection` variant chosen by `handle_socks5_tcp`.

*Call graph*: calls 1 internal fn (mitm_stream); 2 external calls (default, ProxyTarget).


##### `inspect_socks5_udp`  (lines 517–673)

```
async fn inspect_socks5_udp(
    request: RelayRequest,
    state: Arc<NetworkProxyState>,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> io::Result<RelayResponse>
```

**Purpose**: Evaluates one SOCKS5 UDP relay request against proxy-enabled state, mode restrictions, and host policy before allowing the payload through.

**Data flow**: Extracts destination IP/port and extensions from `RelayRequest`, normalizes the destination host string, rejects invalid hosts, reads optional client address from `SocketInfo`, then checks proxy enabled, rejects all UDP in limited mode with audit and blocked telemetry, builds a `NetworkPolicyRequest`, and calls `evaluate_host_policy`. On denial it records a `BlockedRequest`, logs a warning, and returns `PermissionDenied`; on allow it returns `RelayResponse { maybe_payload: Some(payload), extensions }`; on internal errors it returns `io::Error::other("proxy error")`.

**Call relations**: Installed as the UDP inspector when `enable_socks5_udp` is true in `run_socks5_with_listener`.

*Call graph*: calls 6 internal fn (new, evaluate_host_policy, normalize_host, new, emit_socks_block_decision_audit_event, policy_denied_error); 4 external calls (new, other, error!, warn!).


##### `emit_socks_block_decision_audit_event`  (lines 675–696)

```
fn emit_socks_block_decision_audit_event(
    state: &NetworkProxyState,
    source: NetworkDecisionSource,
    reason: &str,
    protocol: NetworkProtocol,
    host: &str,
    port: u16,
    client_a
```

**Purpose**: Adapts SOCKS-specific denial context into the generic non-domain audit-event helper.

**Data flow**: Packages source, reason, protocol, host, port, and optional client address into `BlockDecisionAuditEventArgs` with `method: None`, then calls `emit_block_decision_audit_event`.

**Call relations**: Used by both TCP and UDP SOCKS denial branches before domain policy evaluation or when MITM/mode guards reject a request.

*Call graph*: calls 1 internal fn (emit_block_decision_audit_event); called by 2 (handle_socks5_tcp, inspect_socks5_udp).


##### `policy_denied_error`  (lines 698–703)

```
fn policy_denied_error(reason: &str, details: &PolicyDecisionDetails<'_>) -> io::Error
```

**Purpose**: Builds the `PermissionDenied` I/O error returned to the SOCKS stack for policy denials.

**Data flow**: Calls `blocked_message_with_policy(reason, details)` to get the user-facing message, then constructs `io::Error::new(io::ErrorKind::PermissionDenied, message)`.

**Call relations**: Used by both `handle_socks5_tcp` and `inspect_socks5_udp` for all policy-denied exits.

*Call graph*: calls 1 internal fn (blocked_message_with_policy); called by 2 (handle_socks5_tcp, inspect_socks5_udp); 1 external calls (new).


##### `tests::StaticReloader::maybe_reload`  (lines 742–744)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Test reloader that never reports pending config changes.

**Data flow**: Returns a boxed async future resolving to `Ok(None)`.

**Call relations**: Used by SOCKS tests’ `state_for_settings` helper.

*Call graph*: 1 external calls (pin).


##### `tests::StaticReloader::reload_now`  (lines 746–748)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Test reloader that returns its stored config state clone on forced reload.

**Data flow**: Clones `self.state` inside a boxed async future and returns `Ok(clone)`.

**Call relations**: Supports the runtime trait for test state construction.

*Call graph*: 2 external calls (pin, clone).


##### `tests::StaticReloader::source_label`  (lines 750–752)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a stable source label for test reload logging.

**Data flow**: Returns `static test reloader` as an owned string.

**Call relations**: Used indirectly by runtime reload paths if triggered in tests.


##### `tests::state_for_settings`  (lines 755–766)

```
fn state_for_settings(network: NetworkProxySettings) -> Arc<NetworkProxyState>
```

**Purpose**: Builds an `Arc<NetworkProxyState>` from test settings, serializing MITM-enabled state creation to avoid shared test-home conflicts.

**Data flow**: Wraps settings in `NetworkProxyConfig`, conditionally acquires `MITM_CONFIG_STATE_LOCK` when MITM is enabled, compiles a `ConfigState` with `build_config_state`, creates a `StaticReloader`, and returns `Arc::new(NetworkProxyState::with_reloader(...))`.

**Call relations**: Shared fixture helper for all SOCKS tests.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 2 external calls (new, default).


##### `tests::handle_socks5_tcp_emits_block_decision_for_proxy_disabled`  (lines 769–807)

```
async fn handle_socks5_tcp_emits_block_decision_for_proxy_disabled()
```

**Purpose**: Verifies disabled proxy state causes SOCKS TCP requests to be denied with the expected non-domain audit event.

**Data flow**: Builds disabled state, inserts it into a `TcpRequest`, runs `handle_socks5_tcp` under `capture_events`, asserts the result is an error, then inspects the captured policy event fields for scope, decision, source, reason, protocol, address, port, and default method/client values.

**Call relations**: Covers the proxy-disabled branch in `handle_socks5_tcp`.

*Call graph*: calls 1 internal fn (default); 7 external calls (try_from, new, assert!, assert_eq!, capture_events, find_event_by_name, state_for_settings).


##### `tests::handle_socks5_tcp_uses_mitm_in_limited_mode`  (lines 810–832)

```
async fn handle_socks5_tcp_uses_mitm_in_limited_mode()
```

**Purpose**: Checks that limited-mode HTTPS SOCKS TCP requests use the MITM connection path when MITM is enabled.

**Data flow**: Builds limited-mode MITM-enabled state with `example.com` allowlisted, constructs a `TcpRequest` for `example.com:443`, calls `handle_socks5_tcp`, and asserts the returned connection variant is `Socks5TcpConnection::Mitm`.

**Call relations**: Covers the successful MITM branch in limited mode.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_blocks_non_https_in_limited_mode`  (lines 835–878)

```
async fn handle_socks5_tcp_blocks_non_https_in_limited_mode()
```

**Purpose**: Verifies limited mode rejects non-443 SOCKS TCP targets and emits the expected mode-guard audit event.

**Data flow**: Builds limited-mode state, sends a request for `example.com:80`, captures events around `handle_socks5_tcp`, asserts an error, and checks the event fields for non-domain deny, source `mode_guard`, reason `REASON_METHOD_NOT_ALLOWED`, protocol, address, port, and default placeholders.

**Call relations**: Covers the limited-mode non-HTTPS guard branch.

*Call graph*: calls 1 internal fn (default); 8 external calls (try_from, new, assert!, assert_eq!, capture_events, find_event_by_name, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_blocks_limited_mode_without_mitm_state`  (lines 881–905)

```
async fn handle_socks5_tcp_blocks_limited_mode_without_mitm_state()
```

**Purpose**: Checks that limited-mode HTTPS is denied when MITM is required but unavailable.

**Data flow**: Builds limited-mode state without MITM enabled, sends a request for `example.com:443`, captures the error from `handle_socks5_tcp`, and asserts its debug text contains `MITM required`.

**Call relations**: Covers the MITM-required denial branch.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode`  (lines 908–939)

```
async fn handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode()
```

**Purpose**: Verifies host-specific MITM hooks force HTTPS SOCKS TCP traffic through the MITM path even in full mode.

**Data flow**: Builds full-mode MITM-enabled state with a hook for `api.github.com` and that host allowlisted, sends a `:443` request, and asserts the returned connection variant is `Mitm`.

**Call relations**: Covers the hook-driven MITM branch independent of limited mode.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode`  (lines 942–976)

```
async fn handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode()
```

**Purpose**: Checks that a hooked host on a non-443 SOCKS TCP target is denied because MITM cannot be safely applied.

**Data flow**: Builds full-mode MITM-enabled hooked state, sends a request for `api.github.com:80`, captures the error from `handle_socks5_tcp`, and asserts it mentions `MITM required`.

**Call relations**: Covers the branch where hooks exist but the target is not identifiable as HTTPS.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::inspect_socks5_udp_emits_block_decision_for_mode_guard_deny`  (lines 979–1015)

```
async fn inspect_socks5_udp_emits_block_decision_for_mode_guard_deny()
```

**Purpose**: Verifies limited mode rejects SOCKS UDP relay requests and emits the expected non-domain audit event.

**Data flow**: Builds limited-mode state, constructs a `RelayRequest` to a public DNS IP, runs `inspect_socks5_udp` under `capture_events`, asserts an error, and checks the captured event fields for scope, decision, source, reason, protocol, address, port, and default placeholders.

**Call relations**: Covers the limited-mode UDP guard branch in `inspect_socks5_udp`.

*Call graph*: calls 1 internal fn (default); 10 external calls (default, new, V4, new, new, assert!, assert_eq!, capture_events, find_event_by_name, state_for_settings).
