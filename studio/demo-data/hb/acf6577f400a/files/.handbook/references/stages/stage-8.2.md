# Execution and integration sidecar servers  `stage-8.2`

This stage is the “sidecar” layer: helper servers and bridges that run beside the main Codex process. They expose Codex abilities over specific communication routes during startup and the main work loop. The exec-server files define the public library, choose how clients connect, and turn WebSockets, standard input/output, child processes, or encrypted relays into one JSON-RPC channel, meaning structured request-and-response messages. Its client code sends command and file requests and safely routes process output back.

The Noise relay and remote files add encrypted WebSocket plumbing, so a cloud rendezvous service can connect clients to executors without reading or forging their messages. MCP files start tool servers, describe their runtime environment, connect over standard input/output locally or remotely, load available tools, filter them, and shut down cleanly. The prototype MCP server wires terminal streams into Codex’s message processor.

Other sidecars are practical bridges. stdio-to-uds connects terminal-style programs to Unix sockets. The Responses API proxy forwards only approved local HTTP requests with real credentials. The network proxy starts HTTP and SOCKS listeners, assigns safe ports, sets child-process environment variables, and enforces network rules before traffic leaves.

## Files in this stage

### Exec server transport foundation
These files define the exec-server crate surface and its shared JSON-RPC transport primitives used by both clients and servers.

### `exec-server/src/lib.rs`

`other` · `cross-cutting`

This file does not contain the server’s behavior itself. Instead, it is like the table of contents and public reception desk for the crate. The `mod` lines tell Rust which internal source files belong to this library, such as the client, server, process runner, file-system access, remote connection code, and protocol message definitions. Most of those modules stay private to the crate.

The many `pub use` lines choose which pieces are part of the public API. In plain terms, they let outside code import important items from `exec_server` directly, without needing to know which internal file they came from. For example, users can reach `ExecServerClient`, file-system traits and options, protocol request and response types, process event types, environment helpers, Noise-channel security types, and the `run_main` server entry function from this one place.

This matters because it keeps the rest of the project from depending on the crate’s internal layout. The implementation can be reorganized later while callers keep using the same public names. Without this file, the crate would either expose nothing useful, or every caller would need to know the private folder structure and module names, making the system harder to use and easier to break.


### `exec-server/src/connection.rs`

`io_transport` · `connection setup, message exchange, disconnect, teardown`

This file is the server’s communication adapter. JSON-RPC is a simple message format where requests, replies, and notifications are written as JSON. The rest of the program wants to deal with those messages, not with raw bytes, WebSocket frames, broken pipes, process cleanup, or keepalive pings. This file hides those details.

For standard input/output, it reads one line at a time, ignores blank lines, parses each line as a JSON-RPC message, and sends valid messages into an internal queue. When the program sends a message out, it turns it into JSON, appends a newline, writes it, and flushes it. If reading or writing fails, it reports a disconnect.

For WebSockets, it does the same job using WebSocket text or binary frames. It ignores ping and pong control frames, notices close frames, and can send regular pings so idle browser-style connections stay alive.

The file also tracks optional child processes attached to a connection. When a connection is dropped or explicitly terminated, it tries to shut down the whole process tree politely, waits briefly, and then force-kills it if needed. This prevents orphan helper processes from being left behind.

#### Function details

##### `JsonRpcTransport::from_child_process`  (lines 53–57)

```
fn from_child_process(child_process: Child) -> Self
```

**Purpose**: Wraps a spawned child process as the transport attached to a JSON-RPC connection. This is used when the connection is backed by another program that must be cleaned up later.

**Data flow**: It receives a running child process, starts a stdio transport supervisor for it, and returns a transport value that remembers how to terminate that process later.

**Call relations**: JsonRpcConnection::with_child_process calls this after a connection has been created. It hands the child process to StdioTransport::spawn so background cleanup begins immediately.

*Call graph*: calls 1 internal fn (spawn); called by 1 (with_child_process).


##### `JsonRpcTransport::terminate`  (lines 59–64)

```
fn terminate(&self)
```

**Purpose**: Asks the underlying transport to stop. Plain connections do not need extra cleanup, while stdio-backed connections may have a child process to shut down.

**Data flow**: It looks at the transport kind. If there is no child process, nothing changes; if there is a stdio transport, it forwards the termination request to it.

**Call relations**: This is the common shutdown doorway for transports. When the transport is later dropped or explicitly ended, this keeps callers from needing to know which kind of transport they are dealing with.

*Call graph*: called by 1 (drop).


##### `StdioTransport::spawn`  (lines 78–86)

```
fn spawn(child_process: Child) -> Self
```

**Purpose**: Creates the control handle for a stdio-backed child process and starts a background watcher for it. This makes sure the child is not forgotten if the connection ends.

**Data flow**: It takes a child process, creates a small notification channel used to request termination, stores that channel in a shared handle, starts the child supervisor task, and returns a StdioTransport that owns the handle.

**Call relations**: JsonRpcTransport::from_child_process calls this when a connection is attached to a child process. It immediately calls spawn_stdio_child_supervisor so process cleanup is handled in the background.

*Call graph*: calls 1 internal fn (spawn_stdio_child_supervisor); called by 1 (from_child_process); 3 external calls (new, new, channel).


##### `StdioTransport::terminate`  (lines 88–90)

```
fn terminate(&self)
```

**Purpose**: Requests termination of the child process owned by this stdio transport. It is the public-facing stop button for the transport.

**Data flow**: It reads the shared handle stored inside the transport and asks that handle to send the termination signal. The child process itself is stopped by the supervisor that is listening for that signal.

**Call relations**: JsonRpcTransport::terminate delegates to this when the connection uses stdio. It keeps the transport wrapper small and leaves the one-time signaling details to StdioTransportHandle::terminate.


##### `StdioTransportHandle::terminate`  (lines 94–98)

```
fn terminate(&self)
```

**Purpose**: Sends the termination signal exactly once, even if several clones of the transport all try to stop the process. This avoids repeated shutdown requests racing with each other.

**Data flow**: It checks and flips an atomic flag, which is a thread-safe yes/no value. If no termination was requested before, it sends true on the watch channel; if one was already sent, it does nothing.

**Call relations**: StdioTransportHandle::drop calls this automatically, so losing the last handle also requests cleanup. StdioTransport::terminate uses the same path for explicit shutdown.

*Call graph*: called by 1 (drop); 2 external calls (swap, send).


##### `StdioTransportHandle::drop`  (lines 102–104)

```
fn drop(&mut self)
```

**Purpose**: Automatically requests child-process termination when the last transport handle is destroyed. This is a safety net against leaked helper processes.

**Data flow**: When the handle is being dropped, it calls terminate. That may send a shutdown signal if one has not already been sent.

**Call relations**: This function calls StdioTransportHandle::terminate as part of Rust’s normal cleanup path. It means callers do not have to remember a separate cleanup call in every path.

*Call graph*: calls 1 internal fn (terminate).


##### `spawn_stdio_child_supervisor`  (lines 107–120)

```
fn spawn_stdio_child_supervisor(mut child_process: Child, mut terminate_rx: watch::Receiver<bool>)
```

**Purpose**: Starts a background task that watches a child process and a shutdown signal at the same time. It is the file’s process babysitter.

**Data flow**: It receives the child process and a receiver for termination requests. The spawned task waits for either the process to exit by itself or for a termination request; then it logs the result or shuts down the process tree.

**Call relations**: StdioTransport::spawn calls this as soon as a child process is attached. The supervisor later uses wait_for_stdio_termination, terminate_stdio_child, and process-killing helpers to complete cleanup.

*Call graph*: called by 1 (spawn); 3 external calls (id, select!, spawn).


##### `wait_for_stdio_termination`  (lines 122–131)

```
async fn wait_for_stdio_termination(terminate_rx: &mut watch::Receiver<bool>)
```

**Purpose**: Waits until someone asks for the stdio child process to stop. It also returns if the signaling channel is closed.

**Data flow**: It repeatedly checks the watched boolean value. If it sees true, or if no sender remains, it returns to its caller.

**Call relations**: The supervisor task created by spawn_stdio_child_supervisor waits on this while also waiting for the child process to exit. When this finishes first, the supervisor moves on to terminate_stdio_child.

*Call graph*: 2 external calls (borrow, changed).


##### `terminate_stdio_child`  (lines 133–144)

```
async fn terminate_stdio_child(child_process: &mut Child, process_group_id: Option<u32>)
```

**Purpose**: Tries to shut down a child process tree politely, then forcefully if it does not exit quickly. This is like asking a program to close, waiting a moment, and then using force if it ignores the request.

**Data flow**: It receives the child process and optional process group id. It first sends a termination request to the process tree, waits up to the grace period, logs the result if it exits, or force-kills the tree and waits again if it does not.

**Call relations**: The stdio supervisor calls this after wait_for_stdio_termination reports that shutdown was requested. It relies on terminate_process_tree for the polite attempt, kill_process_tree for the fallback, and log_stdio_child_wait_result for logging.

*Call graph*: calls 3 internal fn (kill_process_tree, log_stdio_child_wait_result, terminate_process_tree); 2 external calls (wait, timeout).


##### `terminate_process_tree`  (lines 146–168)

```
fn terminate_process_tree(child_process: &mut Child, process_group_id: Option<u32>)
```

**Purpose**: Sends a polite termination request to a child process and, where possible, all of its descendants. This gives helper programs a chance to clean up normally.

**Data flow**: It receives a child process plus an optional process group id. If a group id is available, it uses the operating system’s group/tree termination method; otherwise, or if that fails, it falls back to killing only the direct child.

**Call relations**: terminate_stdio_child calls this before waiting during graceful shutdown. On Unix it uses process-group termination, on Windows it may use kill_windows_process_tree, and otherwise it falls back to kill_direct_child.

*Call graph*: calls 3 internal fn (kill_direct_child, kill_windows_process_tree, terminate_process_group); called by 1 (terminate_stdio_child); 1 external calls (warn!).


##### `kill_process_tree`  (lines 170–191)

```
fn kill_process_tree(child_process: &mut Child, process_group_id: Option<u32>)
```

**Purpose**: Force-kills a child process tree when polite termination was not enough, or when the process already exited but children may remain. This is the last-resort cleanup step.

**Data flow**: It receives a child process and optional group id. If possible it asks the operating system to kill the whole group or tree; if that is not possible on the platform, it kills only the direct child.

**Call relations**: terminate_stdio_child calls this after the grace period expires. spawn_stdio_child_supervisor also uses it after the child exits, to clean up any remaining process group members.

*Call graph*: calls 3 internal fn (kill_direct_child, kill_windows_process_tree, kill_process_group); called by 1 (terminate_stdio_child); 1 external calls (warn!).


##### `kill_direct_child`  (lines 193–197)

```
fn kill_direct_child(child_process: &mut Child, action: &str)
```

**Purpose**: Force-stops only the immediate child process. This is the fallback when the code cannot address a full process tree.

**Data flow**: It receives the child process and a word describing the action for logging. It asks Tokio to start killing the process and logs a debug message if that request fails.

**Call relations**: terminate_process_tree and kill_process_tree call this when process-group cleanup is unavailable or fails. It is the simple emergency brake underneath the broader cleanup helpers.

*Call graph*: called by 2 (kill_process_tree, terminate_process_tree); 2 external calls (start_kill, debug!).


##### `kill_windows_process_tree`  (lines 200–215)

```
fn kill_windows_process_tree(pid: u32) -> bool
```

**Purpose**: On Windows, kills a process and its descendants using the system taskkill command. It exists because Windows process trees are controlled differently from Unix process groups.

**Data flow**: It receives a process id, runs taskkill with flags for that id, its child processes, and forceful termination, suppresses taskkill’s own input and output, and returns whether the command succeeded.

**Call relations**: terminate_process_tree and kill_process_tree use this on Windows when a process group id is available. If it returns false, those callers fall back to kill_direct_child.

*Call graph*: called by 2 (kill_process_tree, terminate_process_tree); 3 external calls (null, new, warn!).


##### `log_stdio_child_wait_result`  (lines 217–221)

```
fn log_stdio_child_wait_result(result: std::io::Result<std::process::ExitStatus>)
```

**Purpose**: Records a debug message if waiting for the child process failed. Successful exits do not need extra logging here.

**Data flow**: It receives the result of waiting for a process. If the result is an error, it writes that error to the debug log; otherwise it does nothing.

**Call relations**: terminate_stdio_child calls this after waiting during graceful or forceful shutdown. spawn_stdio_child_supervisor also uses it when the child exits by itself.

*Call graph*: called by 1 (terminate_stdio_child); 1 external calls (debug!).


##### `JsonRpcConnection::from_stdio`  (lines 232–321)

```
fn from_stdio(reader: R, writer: W, connection_label: String) -> Self
```

**Purpose**: Builds a JSON-RPC connection over any asynchronous reader and writer, such as standard input and output or a pipe. It turns newline-separated JSON text into incoming events and outgoing messages into newline-separated JSON text.

**Data flow**: It receives a reader, a writer, and a human-readable connection label. It creates queues for outgoing messages, incoming events, and disconnect status; then it starts one task to read and parse lines and another task to serialize and write outgoing messages. It returns a JsonRpcConnection containing the queues and task handles.

**Call relations**: Many higher-level flows create stdio connections through this function, including command connection setup and tests. Its reader task uses send_malformed_message and send_disconnected to report problems, while its writer task uses write_jsonrpc_line_message and reports disconnects on write failure.

*Call graph*: calls 3 internal fn (send_disconnected, send_malformed_message, write_jsonrpc_line_message); called by 7 (process_events_are_delivered_in_seq_order_when_notifications_are_reordered, transport_disconnect_fails_sessions_and_rejects_new_sessions, wake_notifications_do_not_block_other_sessions, connect_stdio_command, rpc_client_matches_out_of_order_responses_by_request_id, spawn_test_connection, run_stdio_connection_with_io); 8 external calls (new, new, Message, format!, channel, spawn, vec!, channel).


##### `JsonRpcConnection::from_websocket`  (lines 323–328)

```
fn from_websocket(stream: WebSocketStream<S>, connection_label: String) -> Self
```

**Purpose**: Builds a JSON-RPC connection over a tokio-tungstenite WebSocket. This is for WebSocket clients that do not need this file’s built-in keepalive interval.

**Data flow**: It receives a WebSocket stream and connection label, then passes them to the shared WebSocket setup function with no ping interval. The returned connection exposes the same send and receive queues as other transports.

**Call relations**: WebSocket connection setup and several tests call this. It delegates the real loop to JsonRpcConnection::from_websocket_stream so all WebSocket-like implementations share the same behavior.

*Call graph*: called by 4 (connect_websocket, websocket_connection_accepts_binary_jsonrpc_message, websocket_connection_ignores_server_pong, websocket_connection_reports_server_close); 1 external calls (from_websocket_stream).


##### `JsonRpcConnection::from_axum_websocket`  (lines 330–332)

```
fn from_axum_websocket(stream: AxumWebSocket, connection_label: String) -> Self
```

**Purpose**: Builds a JSON-RPC connection from an Axum WebSocket, which is the WebSocket type used by the Axum web framework. It enables periodic pings by default.

**Data flow**: It receives an Axum WebSocket and label, then calls the shared WebSocket setup with the configured keepalive interval. The result is a standard JsonRpcConnection.

**Call relations**: Server request-handling code can use this when an HTTP request upgrades to a WebSocket. It shares the same machinery as JsonRpcConnection::from_websocket_stream but supplies a ping interval for keepalive.

*Call graph*: 1 external calls (from_websocket_stream).


##### `JsonRpcConnection::from_websocket_stream`  (lines 334–458)

```
fn from_websocket_stream(
        mut websocket: T,
        connection_label: String,
        ping_interval: Option<Duration>,
    ) -> Self
```

**Purpose**: Creates the common WebSocket message loop used by both supported WebSocket types. It sends JSON-RPC messages out, parses JSON-RPC messages coming in, sends optional pings, and reports disconnects.

**Data flow**: It receives a WebSocket-like stream, a label, and an optional ping interval. It creates outgoing and incoming queues, starts one task with a select loop, and returns a connection. Inside the loop it either sends queued messages, sends pings on schedule, or reads incoming frames and turns them into connection events.

**Call relations**: JsonRpcConnection::from_websocket and JsonRpcConnection::from_axum_websocket delegate to this. The WebSocket tests also call it directly to control ping timing and backpressure behavior.

*Call graph*: called by 2 (websocket_connection_keeps_outbound_message_while_send_is_backpressured, websocket_connection_sends_configured_ping); 5 external calls (channel, select!, spawn, vec!, channel).


##### `JsonRpcConnection::with_child_process`  (lines 460–463)

```
fn with_child_process(mut self, child_process: Child) -> Self
```

**Purpose**: Attaches a child process to an already-created connection so the process will be supervised and cleaned up with the connection. This is useful when a connection talks to a spawned helper program.

**Data flow**: It receives the connection and a running child process. It replaces the connection’s plain transport with a stdio transport made from that process, then returns the updated connection.

**Call relations**: This calls JsonRpcTransport::from_child_process to create the supervised transport. Code that launches stdio commands can use it after building the reader/writer connection.

*Call graph*: calls 1 internal fn (from_child_process).


##### `Message::parse_jsonrpc_frame`  (lines 479–492)

```
fn parse_jsonrpc_frame(self) -> Result<JsonRpcWebSocketFrame, serde_json::Error>
```

**Purpose**: Interprets a tokio-tungstenite WebSocket message as either a JSON-RPC message, a close signal, or something to ignore. It gives the shared WebSocket loop one simple result to work with.

**Data flow**: It receives a WebSocket frame. Text and binary frames are parsed as JSON-RPC; close frames become a close result; ping, pong, and low-level frame variants are marked as ignorable.

**Call relations**: The shared WebSocket loop calls this through the JsonRpcWebSocketMessage trait when using tokio-tungstenite. It feeds parsed messages into incoming events and treats close frames as disconnects.

*Call graph*: 2 external calls (from_slice, from_str).


##### `Message::from_text`  (lines 494–496)

```
fn from_text(text: String) -> Self
```

**Purpose**: Creates a tokio-tungstenite text WebSocket message from a JSON string. It is used when sending JSON-RPC over that WebSocket type.

**Data flow**: It receives an encoded JSON string and wraps it as a WebSocket text frame. The frame is then ready to send through the WebSocket sink.

**Call relations**: send_websocket_jsonrpc_message calls this through the shared trait after serializing a JSON-RPC message. This lets one sending helper work with more than one WebSocket library type.

*Call graph*: 1 external calls (Text).


##### `Message::ping`  (lines 498–500)

```
fn ping() -> Self
```

**Purpose**: Creates an empty ping frame for tokio-tungstenite WebSockets. A ping is a lightweight keepalive signal that checks whether the other side is still there.

**Data flow**: It takes no input and returns a WebSocket ping message with an empty payload.

**Call relations**: JsonRpcConnection::from_websocket_stream calls this through the trait when a ping interval is configured. If sending the ping fails, the loop reports a disconnect.

*Call graph*: 2 external calls (Ping, new).


##### `AxumWebSocketMessage::parse_jsonrpc_frame`  (lines 504–517)

```
fn parse_jsonrpc_frame(self) -> Result<JsonRpcWebSocketFrame, serde_json::Error>
```

**Purpose**: Interprets an Axum WebSocket message as JSON-RPC data, a close signal, or a frame to ignore. It mirrors the tokio-tungstenite parsing behavior for Axum’s message type.

**Data flow**: It receives an Axum WebSocket frame. Text and binary frames are parsed into JSON-RPC messages; close frames become close events; ping and pong frames are ignored.

**Call relations**: The shared WebSocket loop calls this through the JsonRpcWebSocketMessage trait when the connection came from Axum. This keeps Axum-specific details out of the rest of the loop.

*Call graph*: 2 external calls (from_slice, from_str).


##### `AxumWebSocketMessage::from_text`  (lines 519–521)

```
fn from_text(text: String) -> Self
```

**Purpose**: Creates an Axum text WebSocket message from a serialized JSON-RPC string. It adapts outgoing JSON-RPC text to Axum’s WebSocket type.

**Data flow**: It receives a JSON string and wraps it as an Axum text frame. The frame can then be sent through the Axum WebSocket sink.

**Call relations**: send_websocket_jsonrpc_message uses this through the JsonRpcWebSocketMessage trait. That shared helper can therefore send through both Axum and tokio-tungstenite WebSockets.

*Call graph*: 1 external calls (Text).


##### `AxumWebSocketMessage::ping`  (lines 523–525)

```
fn ping() -> Self
```

**Purpose**: Creates an empty ping frame for Axum WebSockets. This supports keepalive pings on server-side WebSocket connections.

**Data flow**: It takes no input and returns an Axum ping message with an empty payload.

**Call relations**: The WebSocket loop in JsonRpcConnection::from_websocket_stream calls this through the trait whenever the configured keepalive timer ticks.

*Call graph*: 2 external calls (Ping, new).


##### `send_disconnected`  (lines 528–537)

```
async fn send_disconnected(
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    disconnected_tx: &watch::Sender<bool>,
    reason: Option<String>,
)
```

**Purpose**: Reports that a connection has ended or failed. It updates both the quick disconnect flag and the incoming event queue.

**Data flow**: It receives the incoming-event sender, the watched disconnect flag, and an optional reason. It sets the disconnect flag to true and sends a Disconnected event containing the reason, if any.

**Call relations**: JsonRpcConnection::from_stdio calls this when reading reaches end-of-file or when reading or writing fails. The WebSocket loop also uses the same idea to make disconnect reporting consistent.

*Call graph*: called by 1 (from_stdio); 1 external calls (send).


##### `send_malformed_message`  (lines 539–548)

```
async fn send_malformed_message(
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    reason: Option<String>,
)
```

**Purpose**: Reports that incoming data looked like a message but could not be parsed as valid JSON-RPC. This lets the application know about bad input without necessarily closing the connection.

**Data flow**: It receives the incoming-event sender and an optional reason. It sends a MalformedMessage event, using a default explanation if no specific reason was supplied.

**Call relations**: JsonRpcConnection::from_stdio calls this when a non-empty input line fails JSON parsing. The WebSocket parsing path uses the same event type when a frame cannot be parsed.

*Call graph*: called by 1 (from_stdio); 1 external calls (send).


##### `write_jsonrpc_line_message`  (lines 550–562)

```
async fn write_jsonrpc_line_message(
    writer: &mut BufWriter<W>,
    message: &JSONRPCMessage,
) -> std::io::Result<()>
```

**Purpose**: Writes one JSON-RPC message to a line-based stream. This is the outgoing side of the stdio transport format.

**Data flow**: It receives a buffered writer and a JSON-RPC message. It serializes the message to JSON text, writes the text, writes a newline, flushes the writer, and returns success or an I/O error.

**Call relations**: The writer task inside JsonRpcConnection::from_stdio calls this for every outgoing message. It relies on serialize_jsonrpc_message so stdio and WebSocket sending use the same JSON encoding.

*Call graph*: calls 1 internal fn (serialize_jsonrpc_message); called by 1 (from_stdio); 2 external calls (flush, write_all).


##### `send_websocket_jsonrpc_message`  (lines 564–585)

```
async fn send_websocket_jsonrpc_message(
    websocket_writer: &mut W,
    connection_label: &str,
    message: &JSONRPCMessage,
) -> Result<(), String>
```

**Purpose**: Sends one JSON-RPC message through a WebSocket. It turns the message into JSON text and reports any serialization or send failure as a readable string.

**Data flow**: It receives a WebSocket writer, a label for error messages, and a JSON-RPC message. It serializes the message, wraps the text as the correct WebSocket message type, sends it, and returns either success or an error explanation.

**Call relations**: The shared WebSocket loop uses this when an outgoing JSON-RPC message arrives from the outgoing queue. It calls serialize_jsonrpc_message and the message type’s from_text adapter.

*Call graph*: calls 1 internal fn (serialize_jsonrpc_message); 3 external calls (from_text, send, format!).


##### `serialize_jsonrpc_message`  (lines 587–589)

```
fn serialize_jsonrpc_message(message: &JSONRPCMessage) -> Result<String, serde_json::Error>
```

**Purpose**: Converts a structured JSON-RPC message into JSON text. This is the common encoder for all outgoing transports.

**Data flow**: It receives a JSONRPCMessage value by reference and asks serde_json to turn it into a string. It returns either the JSON string or a serialization error.

**Call relations**: write_jsonrpc_line_message uses this for stdio output, and send_websocket_jsonrpc_message uses it for WebSocket output. Keeping the encoder shared helps both transports produce the same format.

*Call graph*: called by 2 (send_websocket_jsonrpc_message, write_jsonrpc_line_message); 1 external calls (to_string).


##### `tests::websocket_connection_sends_configured_ping`  (lines 612–627)

```
async fn websocket_connection_sends_configured_ping() -> anyhow::Result<()>
```

**Purpose**: Checks that a WebSocket connection sends a ping when a ping interval is configured. This protects the keepalive behavior.

**Data flow**: It creates a client/server WebSocket pair, wraps the client side in a JsonRpcConnection with a short ping interval, waits for the server side to receive a frame, and asserts that the frame is a ping.

**Call relations**: The test calls websocket_pair to create the connection and JsonRpcConnection::from_websocket_stream to use the shared WebSocket loop directly. It verifies the ping branch of that loop.

*Call graph*: calls 1 internal fn (from_websocket_stream); 4 external calls (from_secs, assert!, websocket_pair, timeout).


##### `tests::websocket_connection_ignores_server_pong`  (lines 630–645)

```
async fn websocket_connection_ignores_server_pong() -> anyhow::Result<()>
```

**Purpose**: Checks that incoming pong frames do not appear as application messages. Pong frames are WebSocket housekeeping, not JSON-RPC data.

**Data flow**: It creates a WebSocket pair, builds a connection from the client side, sends a pong from the server side, and confirms that no incoming JSON-RPC event arrives shortly afterward.

**Call relations**: The test uses JsonRpcConnection::from_websocket and websocket_pair. It exercises the parsing path where pong frames become Ignore results.

*Call graph*: calls 1 internal fn (from_websocket); 3 external calls (assert!, websocket_pair, Pong).


##### `tests::websocket_connection_reports_server_close`  (lines 648–660)

```
async fn websocket_connection_reports_server_close() -> anyhow::Result<()>
```

**Purpose**: Checks that closing the WebSocket from the server side is reported as a clean disconnect. This ensures callers can react when the peer goes away normally.

**Data flow**: It creates a WebSocket pair, builds a connection, closes the server side, waits for an incoming event, and asserts that the event is Disconnected with no error reason.

**Call relations**: The test calls JsonRpcConnection::from_websocket after creating a pair with websocket_pair. It verifies the close-frame branch of the WebSocket loop.

*Call graph*: calls 1 internal fn (from_websocket); 2 external calls (assert!, websocket_pair).


##### `tests::websocket_connection_accepts_binary_jsonrpc_message`  (lines 663–683)

```
async fn websocket_connection_accepts_binary_jsonrpc_message() -> anyhow::Result<()>
```

**Purpose**: Checks that JSON-RPC messages can arrive as binary WebSocket frames as well as text frames. Some clients may choose binary framing for JSON bytes.

**Data flow**: It builds a sample JSON-RPC request, serializes it to bytes, sends those bytes as a binary frame from the server side, and asserts that the connection receives the same structured message.

**Call relations**: The test uses JsonRpcConnection::from_websocket and websocket_pair. It exercises the binary parsing branch of Message::parse_jsonrpc_frame.

*Call graph*: calls 1 internal fn (from_websocket); 6 external calls (Request, Integer, assert!, websocket_pair, to_vec, Binary).


##### `tests::websocket_connection_keeps_outbound_message_while_send_is_backpressured`  (lines 686–713)

```
async fn websocket_connection_keeps_outbound_message_while_send_is_backpressured() -> anyhow::Result<()>
```

**Purpose**: Checks that an outgoing message is not lost if the WebSocket is temporarily not ready to write. Backpressure means the receiver or network is making the sender wait.

**Data flow**: It creates a controlled fake WebSocket that initially blocks writes, sends a JSON-RPC message through the connection, confirms the write is blocked, sends an unrelated pong, then makes writing ready and checks that the original message is finally sent.

**Call relations**: The test uses ControlledWebSocket::new, JsonRpcConnection::from_websocket_stream, and test_jsonrpc_message. It protects the select-loop behavior so an incoming ignored frame does not cancel a pending outbound send.

*Call graph*: calls 1 internal fn (from_websocket_stream); 4 external calls (assert!, new, test_jsonrpc_message, Pong).


##### `tests::websocket_pair`  (lines 715–728)

```
async fn websocket_pair() -> anyhow::Result<(
        WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WebSocketStream<tokio::net::TcpStream>,
    )>
```

**Purpose**: Creates a real connected WebSocket client and server pair for tests. It gives tests a small local network setup without requiring an external server.

**Data flow**: It binds a local TCP listener, starts a task that accepts one connection and upgrades it to a WebSocket, connects a client to that address, waits for the server upgrade, and returns both WebSocket ends.

**Call relations**: Several WebSocket tests call this before creating a JsonRpcConnection. It hides the setup ceremony so each test can focus on one connection behavior.

*Call graph*: 5 external calls (bind, format!, spawn, accept_async, connect_async).


##### `tests::test_jsonrpc_message`  (lines 730–737)

```
fn test_jsonrpc_message() -> JSONRPCMessage
```

**Purpose**: Builds a simple sample JSON-RPC request for tests. It keeps repeated test setup short and consistent.

**Data flow**: It takes no input and returns a request message with integer id 1, method name "test", and no parameters or trace information.

**Call relations**: The backpressure test calls this to get an outgoing message. Other tests build similar messages inline when they need custom serialization.

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

**Purpose**: Creates a fake WebSocket whose write readiness can be controlled by the test. This lets tests simulate backpressure reliably.

**Data flow**: It receives an initial write-ready flag. It creates channels for inbound and outbound frames plus shared atomic flags and wakers, then returns the fake WebSocket, a handle for controlling it, and a receiver for observing outbound frames.

**Call relations**: tests::websocket_connection_keeps_outbound_message_while_send_is_backpressured calls this. The returned fake WebSocket is passed into JsonRpcConnection::from_websocket_stream.

*Call graph*: 5 external calls (clone, new, new, new, unbounded).


##### `tests::ControlledWebSocketHandle::send_inbound`  (lines 792–796)

```
fn send_inbound(&self, message: Message) -> anyhow::Result<()>
```

**Purpose**: Injects a message into the fake WebSocket as if it arrived from the network. Tests use it to drive the connection’s read side.

**Data flow**: It receives a WebSocket message, wraps it as a successful inbound item, sends it into the fake socket’s inbound channel, and returns success or an error if the channel is closed.

**Call relations**: The backpressure test uses this to send a pong while an outgoing write is blocked. That checks that ignored inbound frames do not disturb the pending write.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocketHandle::set_write_ready`  (lines 798–801)

```
fn set_write_ready(&self)
```

**Purpose**: Unblocks writes on the fake WebSocket. It simulates the network becoming ready to accept outgoing data again.

**Data flow**: It sets the shared write-ready flag to true and wakes any task waiting for write readiness.

**Call relations**: The backpressure test calls this after confirming that the write is blocked. This allows ControlledWebSocket::poll_ready to return ready and the pending message to be sent.


##### `tests::ControlledWebSocketHandle::wait_for_blocked_write`  (lines 803–817)

```
async fn wait_for_blocked_write(&self) -> anyhow::Result<()>
```

**Purpose**: Waits until the fake WebSocket has actually reached a blocked write state. This makes the backpressure test deterministic instead of timing-based.

**Data flow**: It watches the shared write-blocked flag using a waker. If the flag becomes true within the timeout, it returns success; otherwise the timeout fails the wait.

**Call relations**: The backpressure test calls this after queuing an outgoing message. It is awakened by ControlledWebSocket::poll_ready when that method finds writes are not ready.

*Call graph*: 3 external calls (from_secs, poll_fn, timeout).


##### `tests::ControlledWebSocket::poll_ready`  (lines 823–832)

```
fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements the fake WebSocket’s readiness check for sending. It either says writes can proceed or records that a write is blocked.

**Data flow**: It reads the shared write-ready flag. If true, it returns ready; if false, it marks write-blocked, wakes anyone waiting for that fact, stores the current task’s waker, and returns pending.

**Call relations**: The WebSocket sending helper reaches this through the Sink interface when trying to send. The backpressure test observes its blocked state through ControlledWebSocketHandle::wait_for_blocked_write.

*Call graph*: 2 external calls (waker, Ready).


##### `tests::ControlledWebSocket::start_send`  (lines 834–839)

```
fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error>
```

**Purpose**: Records a sent WebSocket message from the fake socket. This lets the test inspect what the connection tried to write.

**Data flow**: It receives the WebSocket message being sent, pushes it into the outbound channel, and returns success.

**Call relations**: After ControlledWebSocket::poll_ready allows sending, the WebSocket loop’s send path reaches this through the Sink interface. The backpressure test reads the outbound channel to confirm the JSON-RPC message was preserved.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocket::poll_flush`  (lines 841–846)

```
fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Completes flush requests immediately for the fake WebSocket. The fake socket does not buffer data beyond its test channel.

**Data flow**: It ignores the task context and returns ready success right away.

**Call relations**: The WebSocket Sink contract may call this after sending. Returning ready keeps the test focused on write readiness rather than flush behavior.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_close`  (lines 848–853)

```
fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Completes close requests immediately for the fake WebSocket. Closing behavior is not what this fake is designed to test.

**Data flow**: It ignores the task context and returns ready success right away.

**Call relations**: This satisfies the Sink interface used by the shared WebSocket loop. It keeps the controlled socket simple while still behaving like a valid sink.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_next`  (lines 859–861)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Supplies inbound messages from the fake WebSocket to the connection. It is the read side of the test double.

**Data flow**: It polls the inbound receiver channel. If a test has injected a message, that message is returned; otherwise it waits until one is available or the channel closes.

**Call relations**: The shared WebSocket loop reads from this through the Stream interface. tests::ControlledWebSocketHandle::send_inbound feeds the channel that this function polls.

*Call graph*: 1 external calls (new).


### `exec-server/src/client.rs`

`io_transport` · `startup, request handling, background notification routing, disconnect handling`

This file lets the rest of the project use a remote or child exec-server as if it were a local helper. Without it, callers would have to know how to open the connection, perform the startup handshake, encode every request as JSON-RPC, track which output belongs to which process, and recover when the connection disappears.

The main type, `ExecServerClient`, wraps a lower-level JSON-RPC client. It exposes friendly methods such as `exec`, `read`, `write`, file-system calls, and `environment_info`. Each one sends a named request to the server and turns the reply into a typed Rust value.

A background reader task listens for server notifications. These notifications are like announcements over a shared loudspeaker: output from all processes arrives on one connection. The file keeps a registry from process id to `SessionState`, so each notification wakes and updates only the matching process session. It also fixes an important race: output, exit, and closed notifications can arrive out of order, so `SessionState` buffers them by sequence number and publishes them in the right order.

`LazyRemoteExecServerClient` delays connecting until someone actually needs the server, then reuses the connection. For reconnectable remote transports, it replaces a disconnected client with a fresh one.

The file also centralizes failure behavior. Once the transport closes, new work is rejected quickly, active sessions receive a synthetic failure event, and streaming HTTP responses are failed too. That prevents callers from waiting for output that can never arrive.

#### Function details

##### `ExecServerClientConnectOptions::default`  (lines 108–114)

```
fn default() -> Self
```

**Purpose**: Builds the standard connection options used when a caller does not provide custom settings. It names the client, sets the initialize timeout, and starts without trying to resume an old session.

**Data flow**: No input is needed. The function creates an options value with default fields and returns it to the caller.

**Call relations**: It is used wherever a simple exec-server connection is enough, especially in tests that create a client directly and then let `ExecServerClient::connect` perform the startup handshake.


##### `ExecServerClientConnectOptions::from`  (lines 128–134)

```
fn from(value: StdioExecServerConnectArgs) -> Self
```

**Purpose**: Converts higher-level connection argument objects into the shared options used by the client startup handshake. This lets remote and stdio connection paths feed the same initialization code.

**Data flow**: It receives connection arguments containing a client name, timeout, and optional session id to resume. It copies those fields into an `ExecServerClientConnectOptions` value and returns it.

**Call relations**: Transport-specific setup code can prepare its own argument type, then hand the common pieces to `ExecServerClient::initialize` through this conversion.


##### `RemoteExecServerConnectArgs::new`  (lines 138–146)

```
fn new(websocket_url: String, client_name: String) -> Self
```

**Purpose**: Creates a basic set of remote WebSocket connection arguments. It fills in sensible timeout defaults so callers only need to provide the server URL and client name.

**Data flow**: The caller supplies a WebSocket URL and client name. The function combines them with default connect and initialize timeouts, leaves resume-session empty, and returns the complete argument object.

**Call relations**: This is a convenience constructor for code that wants to connect to a remote exec-server without manually choosing every option.


##### `Inner::drop`  (lines 200–202)

```
fn drop(&mut self)
```

**Purpose**: Stops the background reader task when the shared client internals are destroyed. This prevents a task from continuing to read a dead connection after the client is gone.

**Data flow**: When `Inner` is being dropped, it calls abort on the stored task handle. Nothing is returned, but the background task is told to stop.

**Call relations**: It runs automatically when the last `ExecServerClient` clone disappears, cleaning up the reader task created by `ExecServerClient::connect`.

*Call graph*: 1 external calls (abort).


##### `LazyRemoteExecServerClient::new`  (lines 218–224)

```
fn new(transport_params: ExecServerTransportParams) -> Self
```

**Purpose**: Creates a wrapper that will connect to the remote exec-server only when it is first needed. This avoids opening a network connection before any work actually requires it.

**Data flow**: It receives transport settings, stores them, creates an empty cached-client slot, and creates a one-at-a-time connection gate. It returns the lazy client wrapper.

**Call relations**: Remote environment code and tests construct this wrapper, then later call `get`, HTTP methods, or `environment_info`, which trigger the real connection.

*Call graph*: called by 3 (remote_websocket_client_replaces_disconnected_client_with_fresh_session, remote_with_transport, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion); 3 external calls (new, new, new).


##### `LazyRemoteExecServerClient::get`  (lines 226–258)

```
async fn get(&self) -> Result<ExecServerClient, ExecServerError>
```

**Purpose**: Returns a usable `ExecServerClient`, connecting or reconnecting if necessary. It also makes sure only one task performs the connection attempt at a time.

**Data flow**: It first checks the cached client. If it is present and still connected, that client is returned. Otherwise it takes the connection permit, checks again, creates a new client for reconnectable transports when needed, stores it, and returns it.

**Call relations**: All lazy operations pass through this function. HTTP requests, file operations, and environment info calls ask `get` for the real client before sending their request.

*Call graph*: calls 2 internal fn (cached_client, connected_client); called by 13 (environment_info, http_request, http_request_stream, canonicalize, copy, create_directory, get_metadata, read_directory, read_file, read_file_stream (+3 more)); 3 external calls (connect_for_transport, clone, matches!).


##### `LazyRemoteExecServerClient::connected_client`  (lines 260–263)

```
fn connected_client(&self) -> Option<ExecServerClient>
```

**Purpose**: Looks for a cached client that has not disconnected. It is a quick filter used before doing the slower connection work.

**Data flow**: It reads the cached client and checks its disconnect state. It returns the client only if it exists and is still usable.

**Call relations**: `LazyRemoteExecServerClient::get` calls this before and after taking the connection permit, so it can reuse a good existing connection whenever possible.

*Call graph*: calls 1 internal fn (cached_client); called by 1 (get).


##### `LazyRemoteExecServerClient::cached_client`  (lines 265–270)

```
fn cached_client(&self) -> Option<ExecServerClient>
```

**Purpose**: Reads the currently stored client, if one exists. It hides the locking needed to safely read the shared cache.

**Data flow**: It locks the cache, clones the optional client value, and returns that clone. It does not check whether the client is still connected.

**Call relations**: `connected_client` uses it for the common healthy-client path, and `get` uses it to decide whether to reuse, reconnect, or create the first connection.

*Call graph*: called by 2 (connected_client, get).


##### `LazyRemoteExecServerClient::http_request`  (lines 274–279)

```
fn http_request(
        &self,
        params: crate::HttpRequestParams,
    ) -> BoxFuture<'_, Result<crate::HttpRequestResponse, ExecServerError>>
```

**Purpose**: Sends a non-streaming HTTP request through the exec-server, connecting first if needed. This lets higher layers use the remote environment as an HTTP proxy.

**Data flow**: It receives HTTP request parameters. It obtains a real client with `get`, forwards the request to that client, and returns the HTTP response or an exec-server error.

**Call relations**: This is the `HttpClient` trait entry for lazy clients. It delegates the actual request to the connected `ExecServerClient`.

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

**Purpose**: Starts an HTTP request whose response body will arrive as a stream of chunks. It connects lazily before handing the work to the real client.

**Data flow**: It receives HTTP request parameters. It gets or creates the underlying client, asks it to start the streaming request, and returns both the response metadata and a body stream.

**Call relations**: This is the streaming `HttpClient` trait path. It depends on `get`, then relies on the connected client’s HTTP streaming machinery.

*Call graph*: calls 1 internal fn (get).


##### `LazyRemoteExecServerClient::environment_info`  (lines 293–295)

```
async fn environment_info(&self) -> Result<EnvironmentInfo, ExecServerError>
```

**Purpose**: Fetches information about the remote execution environment, such as what kind of system the server represents. It connects lazily before asking.

**Data flow**: No request-specific data is supplied. The function obtains a real client and forwards the environment info request, returning the server’s answer.

**Call relations**: Higher-level info commands call this when they need environment details but do not want to know whether the client is already connected.

*Call graph*: calls 1 internal fn (get); called by 1 (info).


##### `ExecServerClient::initialize`  (lines 339–376)

```
async fn initialize(
        &self,
        options: ExecServerClientConnectOptions,
    ) -> Result<InitializeResponse, ExecServerError>
```

**Purpose**: Performs the startup handshake with the exec-server. This confirms both sides are ready and records the session id assigned by the server.

**Data flow**: It receives connection options, sends an `initialize` JSON-RPC request with the client name and optional resume id, waits only up to the configured timeout, stores the returned session id, sends an `initialized` notification, and returns the initialize response.

**Call relations**: `ExecServerClient::connect` calls this after creating the lower-level JSON-RPC client. It hands off to `notify_initialized` after the server replies.

*Call graph*: calls 1 internal fn (notify_initialized); 1 external calls (timeout).


##### `ExecServerClient::exec`  (lines 378–380)

```
async fn exec(&self, params: ExecParams) -> Result<ExecResponse, ExecServerError>
```

**Purpose**: Asks the exec-server to start a process. This is the main way callers begin remote command execution.

**Data flow**: It receives execution parameters, sends them using the shared request helper, and returns the server’s process-start response.

**Call relations**: It is a thin, typed wrapper around `ExecServerClient::call`, using the exec method name from the protocol.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::environment_info`  (lines 382–384)

```
async fn environment_info(&self) -> Result<EnvironmentInfo, ExecServerError>
```

**Purpose**: Requests details about the environment behind this exec-server connection. Callers use it to understand where commands and file operations will run.

**Data flow**: It sends an environment-info request with no parameters and returns the decoded environment information.

**Call relations**: The lazy client’s `environment_info` method obtains a real client and then delegates here; this method delegates the protocol details to `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::read`  (lines 386–388)

```
async fn read(&self, params: ReadParams) -> Result<ReadResponse, ExecServerError>
```

**Purpose**: Reads buffered output and status for a running process. It supports polling after a sequence number and optionally waiting for new data.

**Data flow**: It receives read parameters, sends them to the server, and returns output chunks plus process state such as exited, closed, or failure.

**Call relations**: `Session::read` wraps this with a fixed process id and adds special handling for transport disconnects.

*Call graph*: calls 1 internal fn (call); called by 1 (read).


##### `ExecServerClient::write`  (lines 390–403)

```
async fn write(
        &self,
        process_id: &ProcessId,
        chunk: Vec<u8>,
    ) -> Result<WriteResponse, ExecServerError>
```

**Purpose**: Writes bytes to a running process, usually to its standard input. This is how callers feed input into a remote command.

**Data flow**: It receives a process id and a byte chunk. It builds write parameters, sends them to the server, and returns the server’s write response.

**Call relations**: `Session::write` calls this so session users do not need to pass the process id every time.

*Call graph*: calls 1 internal fn (call); called by 1 (write); 1 external calls (clone).


##### `ExecServerClient::signal`  (lines 405–420)

```
async fn signal(
        &self,
        process_id: &ProcessId,
        signal: ProcessSignal,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Sends a signal to a running process, such as an interrupt. The function hides the request/response details and returns success or failure.

**Data flow**: It receives a process id and signal value, sends a signal request, discards the empty success response, and returns `Ok` if the server accepted it.

**Call relations**: `Session::signal` calls this for the session’s process. The shared `call` method does the actual JSON-RPC request.

*Call graph*: calls 1 internal fn (call); called by 1 (signal); 1 external calls (clone).


##### `ExecServerClient::terminate`  (lines 422–433)

```
async fn terminate(
        &self,
        process_id: &ProcessId,
    ) -> Result<TerminateResponse, ExecServerError>
```

**Purpose**: Asks the exec-server to terminate a process. This is the explicit stop command for a remote process.

**Data flow**: It receives a process id, sends a terminate request, and returns the server’s terminate response.

**Call relations**: `Session::terminate` calls this and then simplifies the result to success or error for session users.

*Call graph*: calls 1 internal fn (call); called by 1 (terminate); 1 external calls (clone).


##### `ExecServerClient::fs_read_file`  (lines 435–440)

```
async fn fs_read_file(
        &self,
        params: FsReadFileParams,
    ) -> Result<FsReadFileResponse, ExecServerError>
```

**Purpose**: Reads an entire file through the exec-server. This lets callers inspect files in the remote environment.

**Data flow**: It receives file-read parameters, sends them to the file-read protocol method, and returns the file contents or an error.

**Call relations**: It is one of several file-system wrappers that all delegate to the common `call` helper.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_open`  (lines 442–444)

```
async fn fs_open(&self, params: FsOpenParams) -> Result<FsOpenResponse, ExecServerError>
```

**Purpose**: Opens a remote file for block-based reading. This is useful when a file is too large or inconvenient to read all at once.

**Data flow**: It receives open parameters, sends them to the server, and returns an open-file handle or related response data.

**Call relations**: Callers combine this with `fs_read_block` and `fs_close`; all three use the shared `call` path.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_read_block`  (lines 446–451)

```
async fn fs_read_block(
        &self,
        params: FsReadBlockParams,
    ) -> Result<FsReadBlockResponse, ExecServerError>
```

**Purpose**: Reads one block from a previously opened remote file. This supports chunked file reading.

**Data flow**: It receives block-read parameters, sends the request, and returns the requested bytes and related metadata.

**Call relations**: It normally follows `fs_open` and eventually pairs with `fs_close`, while `call` performs the JSON-RPC exchange.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_close`  (lines 453–458)

```
async fn fs_close(
        &self,
        params: FsCloseParams,
    ) -> Result<FsCloseResponse, ExecServerError>
```

**Purpose**: Closes a remote file handle opened earlier. This tells the server it can release resources for that file.

**Data flow**: It receives close parameters, sends them to the server, and returns the close response.

**Call relations**: It completes the open/read/close flow started by `fs_open`; the protocol request itself is sent through `call`.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_write_file`  (lines 460–465)

```
async fn fs_write_file(
        &self,
        params: FsWriteFileParams,
    ) -> Result<FsWriteFileResponse, ExecServerError>
```

**Purpose**: Writes a complete file through the exec-server. Callers use it to create or replace files in the remote environment.

**Data flow**: It receives write-file parameters, sends them to the server, and returns the write result.

**Call relations**: Like the other file-system methods, it is a typed wrapper around the common `call` helper.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_create_directory`  (lines 467–472)

```
async fn fs_create_directory(
        &self,
        params: FsCreateDirectoryParams,
    ) -> Result<FsCreateDirectoryResponse, ExecServerError>
```

**Purpose**: Creates a directory in the remote environment. It lets callers prepare folders before writing files or running commands.

**Data flow**: It receives directory-creation parameters, sends them to the server, and returns the creation response.

**Call relations**: This method is part of the remote file-system surface and uses `call` for transport and error handling.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_get_metadata`  (lines 474–479)

```
async fn fs_get_metadata(
        &self,
        params: FsGetMetadataParams,
    ) -> Result<FsGetMetadataResponse, ExecServerError>
```

**Purpose**: Asks for information about a remote file or directory, such as whether it exists and what kind of item it is.

**Data flow**: It receives metadata parameters, sends them to the server, and returns the metadata response.

**Call relations**: Higher-level file logic can call this before deciding how to read, write, or remove a path; the shared `call` helper sends the request.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_canonicalize`  (lines 481–486)

```
async fn fs_canonicalize(
        &self,
        params: FsCanonicalizeParams,
    ) -> Result<FsCanonicalizeResponse, ExecServerError>
```

**Purpose**: Asks the server to resolve a path into its canonical, normalized form. This avoids guessing path rules on the client side.

**Data flow**: It receives canonicalize parameters, sends them to the server, and returns the resolved path response.

**Call relations**: It keeps path interpretation in the environment where the file actually lives, while `call` handles the RPC details.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_read_directory`  (lines 488–493)

```
async fn fs_read_directory(
        &self,
        params: FsReadDirectoryParams,
    ) -> Result<FsReadDirectoryResponse, ExecServerError>
```

**Purpose**: Reads the entries inside a remote directory. Callers use it to list files and subdirectories.

**Data flow**: It receives directory-read parameters, sends them to the server, and returns the directory listing response.

**Call relations**: It is a typed file-system request wrapper over the common `call` mechanism.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_remove`  (lines 495–500)

```
async fn fs_remove(
        &self,
        params: FsRemoveParams,
    ) -> Result<FsRemoveResponse, ExecServerError>
```

**Purpose**: Removes a file or directory in the remote environment. This gives callers a safe protocol-level way to delete remote paths.

**Data flow**: It receives remove parameters, sends them to the server, and returns the removal response.

**Call relations**: It belongs to the remote file-system API and relies on `call` for disconnect checks and JSON-RPC errors.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::fs_copy`  (lines 502–504)

```
async fn fs_copy(&self, params: FsCopyParams) -> Result<FsCopyResponse, ExecServerError>
```

**Purpose**: Copies a file or directory within the remote environment. This avoids pulling data back to the client just to copy it elsewhere.

**Data flow**: It receives copy parameters, sends them to the server, and returns the copy response.

**Call relations**: It is another narrow wrapper around `call`, using the protocol’s copy method name.

*Call graph*: calls 1 internal fn (call).


##### `ExecServerClient::register_session`  (lines 506–519)

```
async fn register_session(
        &self,
        process_id: &ProcessId,
    ) -> Result<Session, ExecServerError>
```

**Purpose**: Creates local tracking for one remote process. This is needed so shared server notifications can be routed to the right process session.

**Data flow**: It receives a process id, creates a fresh `SessionState`, inserts it into the client’s session registry, and returns a `Session` object tied to that process.

**Call relations**: Code that starts or attaches to a process calls this before expecting output notifications. It delegates the registry update to `Inner::insert_session`.

*Call graph*: calls 1 internal fn (new); 3 external calls (clone, new, clone).


##### `ExecServerClient::unregister_session`  (lines 521–523)

```
async fn unregister_session(&self, process_id: &ProcessId)
```

**Purpose**: Removes local tracking for a process session. This stops routing future notifications for that process to the session.

**Data flow**: It receives a process id and asks the inner registry to remove the matching session. It does not return the removed state to the caller.

**Call relations**: `Session::unregister` calls this when a session is no longer needed.

*Call graph*: called by 1 (unregister).


##### `ExecServerClient::session_id`  (lines 525–531)

```
fn session_id(&self) -> Option<String>
```

**Purpose**: Returns the session id assigned by the exec-server during initialization. This can be used for inspection or resume-related behavior.

**Data flow**: It reads the stored optional session id under a read lock, clones it, and returns it.

**Call relations**: Tests and higher-level code use this after connection to confirm which server session was established.


##### `ExecServerClient::is_disconnected`  (lines 533–535)

```
fn is_disconnected(&self) -> bool
```

**Purpose**: Reports whether this client can no longer use its transport. It checks both the client’s own disconnect latch and the lower-level RPC client.

**Data flow**: It reads the disconnect marker and the RPC client state. It returns `true` if either says the connection is gone.

**Call relations**: The lazy client uses this through `connected_client`, and tests use `wait_for_disconnect` to observe when a closed connection has been noticed.

*Call graph*: called by 1 (wait_for_disconnect).


##### `ExecServerClient::connect`  (lines 537–591)

```
async fn connect(
        connection: JsonRpcConnection,
        options: ExecServerClientConnectOptions,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Builds a full exec-server client around an already-open JSON-RPC connection. It starts the background notification reader and performs initialization.

**Data flow**: It receives a JSON-RPC connection and options, creates an RPC client plus event receiver, spawns a reader task that handles notifications and disconnects, builds the shared inner state, runs `initialize`, and returns the ready client.

**Call relations**: Transport-specific constructors feed their connection here. The reader task it creates later calls notification handling and failure cleanup when events arrive.

*Call graph*: calls 1 internal fn (new); called by 3 (process_events_are_delivered_in_seq_order_when_notifications_are_reordered, transport_disconnect_fails_sessions_and_rejects_new_sessions, wake_notifications_do_not_block_other_sessions); 1 external calls (new_cyclic).


##### `ExecServerClient::notify_initialized`  (lines 593–599)

```
async fn notify_initialized(&self) -> Result<(), ExecServerError>
```

**Purpose**: Sends the final `initialized` notification after the server answers the initialize request. This completes the startup handshake.

**Data flow**: It sends an empty JSON object as a notification. If JSON serialization fails, it returns an exec-server JSON error.

**Call relations**: `ExecServerClient::initialize` calls this after storing the server-provided session id.

*Call graph*: called by 1 (initialize); 1 external calls (json!).


##### `ExecServerClient::call`  (lines 601–629)

```
async fn call(&self, method: &str, params: &P) -> Result<T, ExecServerError>
```

**Purpose**: Sends one typed JSON-RPC request and decodes its typed response. It is the shared safety gate for almost every client operation.

**Data flow**: It receives a method name and serializable parameters. It first rejects work if the transport is already marked disconnected, then sends the request, converts success into the requested response type, and converts failures into `ExecServerError` values. If it notices the transport closed, it records the disconnect.

**Call relations**: Most public methods in `ExecServerClient` call this. It uses `disconnected_message`, `is_transport_closed_error`, `record_disconnected`, and `ExecServerError::from` to keep error behavior consistent.

*Call graph*: calls 4 internal fn (from, disconnected_message, is_transport_closed_error, record_disconnected); called by 17 (environment_info, exec, fs_canonicalize, fs_close, fs_copy, fs_create_directory, fs_get_metadata, fs_open, fs_read_block, fs_read_directory (+7 more)); 1 external calls (Disconnected).


##### `ExecServerError::from`  (lines 633–642)

```
fn from(value: RpcCallError) -> Self
```

**Purpose**: Converts lower-level RPC call errors into the error type used by this client. This gives callers one error vocabulary instead of several.

**Data flow**: It receives an RPC error. Closed, JSON, and server-reported errors are mapped into the matching `ExecServerError` variants and returned.

**Call relations**: `ExecServerClient::call` uses this whenever the lower-level RPC client reports a failed request.

*Call graph*: called by 1 (call); 1 external calls (Json).


##### `SessionState::new`  (lines 646–657)

```
fn new() -> Self
```

**Purpose**: Creates the local state needed to track one process session. It prepares wake notifications, an event log, ordering buffers, and an empty failure slot.

**Data flow**: No input is needed. It creates a watch channel, an event log with capacity limits, an empty ordered-event buffer, and an empty failure value, then returns the state.

**Call relations**: `ExecServerClient::register_session` calls this whenever a process starts being tracked.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, new, default, channel).


##### `SessionState::subscribe`  (lines 659–661)

```
fn subscribe(&self) -> watch::Receiver<u64>
```

**Purpose**: Lets a consumer be notified when this process has new output or status changes. The returned receiver is a lightweight wake-up signal.

**Data flow**: It reads the internal watch sender and creates a new receiver subscribed to future changes. The session state itself is not changed.

**Call relations**: `Session::subscribe_wake` exposes this to session users.

*Call graph*: 1 external calls (subscribe).


##### `SessionState::subscribe_events`  (lines 663–665)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Lets a consumer receive the stream of process events, such as output, exit, closed, or failure. This is for consumers that want pushed events rather than polling reads.

**Data flow**: It asks the event log for a new receiver and returns it to the caller.

**Call relations**: `Session::subscribe_events` exposes this, and `publish_ordered_event` later feeds events into the log.

*Call graph*: calls 1 internal fn (subscribe).


##### `SessionState::note_change`  (lines 667–670)

```
fn note_change(&self, seq: u64)
```

**Purpose**: Wakes listeners when a process changes. It stores the highest sequence number seen so waiters know something new may be available.

**Data flow**: It receives a sequence number, compares it with the current wake value, sends the larger value to subscribers, and ignores send failure if nobody is listening.

**Call relations**: The server-notification handler calls this before publishing output, exit, or closed events for a process.

*Call graph*: 2 external calls (borrow, send).


##### `SessionState::publish_ordered_event`  (lines 679–714)

```
fn publish_ordered_event(&self, event: ExecProcessEvent) -> bool
```

**Purpose**: Publishes process events in sequence order, even if the server notifications arrived out of order. This prevents consumers from seeing a process close before its final output appears.

**Data flow**: It receives a process event. Events without a sequence number are published immediately. Sequenced events are stored in a pending map until all earlier sequence numbers have been published, then ready events are emitted to the event log. It returns `true` only when a closed event was actually published.

**Call relations**: Server notification handling uses this for output, exit, and closed events. `set_failure` also uses it for failure events. When it reports that `Closed` was published, the session route can be removed safely.

*Call graph*: calls 2 internal fn (seq, publish); called by 1 (set_failure); 3 external calls (lock, new, matches!).


##### `SessionState::set_failure`  (lines 716–728)

```
async fn set_failure(&self, message: String)
```

**Purpose**: Marks a session as failed and wakes every kind of consumer. This is how a disconnect becomes visible to both polling readers and event-stream readers.

**Data flow**: It receives a failure message. If no failure was recorded before, it stores the message, bumps the wake value, and publishes a `Failed` event. Repeated calls still wake listeners but do not publish duplicate failure events.

**Call relations**: `fail_all_sessions` calls this during transport shutdown, and `Session::read` calls it if a read notices the transport closed.

*Call graph*: calls 1 internal fn (publish_ordered_event); 3 external calls (borrow, send, Failed).


##### `SessionState::failed_response`  (lines 730–736)

```
async fn failed_response(&self) -> Option<ReadResponse>
```

**Purpose**: Builds a read response for a session that has already failed. This lets polling readers get a clean closed response instead of an error loop.

**Data flow**: It checks the stored failure message. If one exists, it turns it into a synthesized `ReadResponse`; otherwise it returns no response.

**Call relations**: `Session::read` checks this before making a server request, so failed sessions answer immediately.


##### `SessionState::synthesized_failure`  (lines 738–748)

```
fn synthesized_failure(&self, message: String) -> ReadResponse
```

**Purpose**: Creates a fake read response that says the process is closed because the session failed. This gives callers the same shape of response they expect from normal reads.

**Data flow**: It receives a failure message, chooses the next wake sequence number, and returns a `ReadResponse` with no chunks, closed and exited set, no exit code, and the failure text.

**Call relations**: `failed_response` and `Session::read` use this after a disconnect or stored failure.

*Call graph*: 2 external calls (borrow, new).


##### `Session::process_id`  (lines 752–754)

```
fn process_id(&self) -> &ProcessId
```

**Purpose**: Returns the process id associated with this session. It is a simple accessor for callers that need to identify the remote process.

**Data flow**: It borrows the process id stored in the session and returns a reference to it.

**Call relations**: Session users can call this without reaching into the session’s private fields.


##### `Session::subscribe_wake`  (lines 756–758)

```
fn subscribe_wake(&self) -> watch::Receiver<u64>
```

**Purpose**: Subscribes to wake-up notifications for this process. This is useful for code that wants to wait until new output or status may be available.

**Data flow**: It asks the session state for a watch receiver and returns it.

**Call relations**: It delegates to `SessionState::subscribe`; tests use this to ensure one noisy process does not block another session’s wakeups.


##### `Session::subscribe_events`  (lines 760–762)

```
fn subscribe_events(&self) -> ExecProcessEventReceiver
```

**Purpose**: Subscribes to the ordered event stream for this process. Consumers use it to receive output and lifecycle events as they are published.

**Data flow**: It asks the session state for an event receiver and returns it.

**Call relations**: It delegates to `SessionState::subscribe_events`, which is fed by notification handling.


##### `Session::read`  (lines 764–792)

```
async fn read(
        &self,
        after_seq: Option<u64>,
        max_bytes: Option<usize>,
        wait_ms: Option<u64>,
    ) -> Result<ReadResponse, ExecServerError>
```

**Purpose**: Reads output and status for this session’s process. It also turns transport shutdown into a normal closed failure response so callers do not hang.

**Data flow**: It first checks whether the session already failed. If not, it sends a read request with this session’s process id and the caller’s read options. On normal success it returns the server response; if the transport closed, it records a failure and returns a synthesized closed response.

**Call relations**: It wraps `ExecServerClient::read` and uses `disconnected_message` plus `is_transport_closed_error` for the disconnect path.

*Call graph*: calls 3 internal fn (read, disconnected_message, is_transport_closed_error); 1 external calls (clone).


##### `Session::write`  (lines 794–796)

```
async fn write(&self, chunk: Vec<u8>) -> Result<WriteResponse, ExecServerError>
```

**Purpose**: Writes bytes to this session’s process. It saves the caller from passing the process id separately.

**Data flow**: It receives a byte chunk, combines it with the session’s process id, forwards it to the client, and returns the write response.

**Call relations**: It delegates directly to `ExecServerClient::write`.

*Call graph*: calls 1 internal fn (write).


##### `Session::signal`  (lines 798–800)

```
async fn signal(&self, signal: ProcessSignal) -> Result<(), ExecServerError>
```

**Purpose**: Sends a signal to this session’s process. This is the session-level shortcut for interrupts or other process signals.

**Data flow**: It receives a signal value, forwards it with the session’s process id, and returns success or an error.

**Call relations**: It delegates directly to `ExecServerClient::signal`.

*Call graph*: calls 1 internal fn (signal).


##### `Session::terminate`  (lines 802–805)

```
async fn terminate(&self) -> Result<(), ExecServerError>
```

**Purpose**: Terminates this session’s process. It hides the terminate response details and only reports success or failure.

**Data flow**: It asks the client to terminate the session’s process id, ignores the successful response content, and returns `Ok` or the error.

**Call relations**: It delegates to `ExecServerClient::terminate`.

*Call graph*: calls 1 internal fn (terminate).


##### `Session::unregister`  (lines 807–809)

```
async fn unregister(&self)
```

**Purpose**: Stops local routing for this session’s process. Callers use it when they are done listening to a process.

**Data flow**: It passes the session’s process id to the client’s unregister method. The client removes any matching entry from the session registry.

**Call relations**: It is a convenience wrapper around `ExecServerClient::unregister_session`.

*Call graph*: calls 1 internal fn (unregister_session).


##### `Inner::disconnected_error`  (lines 813–818)

```
fn disconnected_error(&self) -> Option<ExecServerError>
```

**Purpose**: Returns the stored disconnect error, if the client has already been marked disconnected. This lets new work fail immediately.

**Data flow**: It reads the disconnect latch. If a message is present, it wraps that message in `ExecServerError::Disconnected`; otherwise it returns nothing.

**Call relations**: `Inner::insert_session` uses this to avoid registering sessions that can never receive notifications, and `ExecServerClient::call` uses the same idea through the inner state.

*Call graph*: called by 1 (insert_session); 1 external calls (get).


##### `Inner::set_disconnected`  (lines 820–825)

```
fn set_disconnected(&self, message: String) -> Option<String>
```

**Purpose**: Records the first disconnect message for the client. The message is latched so every later failure reports the same reason.

**Data flow**: It receives a message and tries to store it. If this is the first disconnect, it returns the message; if another task already stored one, it returns nothing.

**Call relations**: `record_disconnected` calls this so competing observers do not overwrite the canonical disconnect reason.

*Call graph*: 1 external calls (set).


##### `Inner::get_session`  (lines 827–829)

```
fn get_session(&self, process_id: &ProcessId) -> Option<Arc<SessionState>>
```

**Purpose**: Finds the local session state for a process id. This is the routing lookup for incoming process notifications.

**Data flow**: It reads the current session map, looks up the process id, clones the shared session state if found, and returns it.

**Call relations**: The notification handler calls this before waking or publishing events for a process.

*Call graph*: 1 external calls (load).


##### `Inner::insert_session`  (lines 831–853)

```
async fn insert_session(
        &self,
        process_id: &ProcessId,
        session: Arc<SessionState>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Adds a process session to the routing table. It prevents duplicate registrations and refuses registration after disconnect.

**Data flow**: It locks session writes, checks whether the transport is already disconnected, checks for an existing entry with the same process id, clones the map, inserts the new session, swaps the map into place, and returns success.

**Call relations**: `ExecServerClient::register_session` calls this. The write lock and copy-on-write map keep notification reads fast while making updates safe.

*Call graph*: calls 1 internal fn (disconnected_error); 6 external calls (new, load, store, Protocol, clone, format!).


##### `Inner::remove_session`  (lines 855–864)

```
async fn remove_session(&self, process_id: &ProcessId) -> Option<Arc<SessionState>>
```

**Purpose**: Removes one process session from the routing table. This stops future connection-wide notifications from being delivered to that session.

**Data flow**: It locks session writes, reads the map, clones and returns the existing session if present, builds a new map without that process id, and swaps it in.

**Call relations**: `ExecServerClient::unregister_session` calls it directly, and notification handling calls it after an ordered closed event has actually been published.

*Call graph*: 3 external calls (new, load, store).


##### `Inner::take_all_sessions`  (lines 866–872)

```
async fn take_all_sessions(&self) -> HashMap<ProcessId, Arc<SessionState>>
```

**Purpose**: Drains all registered sessions at once. This is used when the whole transport has failed and every process session must be marked failed.

**Data flow**: It locks session writes, clones the current map, replaces it with an empty map, and returns the drained sessions.

**Call relations**: `fail_all_sessions` calls this during disconnect cleanup.

*Call graph*: 4 external calls (new, load, store, new).


##### `disconnected_message`  (lines 875–880)

```
fn disconnected_message(reason: Option<&str>) -> String
```

**Purpose**: Creates the user-facing text for a transport disconnect. It includes the lower-level reason when one is available.

**Data flow**: It receives an optional reason string. With a reason, it formats it into a longer message; without one, it returns a standard disconnect message.

**Call relations**: `ExecServerClient::call` and `Session::read` use this when they discover the transport has closed.

*Call graph*: called by 2 (call, read); 1 external calls (format!).


##### `is_transport_closed_error`  (lines 882–893)

```
fn is_transport_closed_error(error: &ExecServerError) -> bool
```

**Purpose**: Recognizes the different error shapes that all mean the JSON-RPC transport is closed. This keeps disconnect handling consistent.

**Data flow**: It receives an `ExecServerError` and checks whether it is a closed/disconnected error or a server error with the known transport-closed code and message. It returns a boolean.

**Call relations**: `ExecServerClient::call` and `Session::read` use this to decide whether to record or synthesize disconnect behavior.

*Call graph*: called by 2 (call, read); 1 external calls (matches!).


##### `record_disconnected`  (lines 895–904)

```
fn record_disconnected(inner: &Arc<Inner>, message: String) -> String
```

**Purpose**: Stores the canonical disconnect message and returns the message everyone should use. If another task already recorded one, it reuses that first message.

**Data flow**: It receives the shared inner state and a proposed message. It tries to set the disconnect latch; on success it returns the proposed message, otherwise it reads and returns the existing stored message.

**Call relations**: `ExecServerClient::call` uses this when a request races with disconnect. The background reader task also records disconnects before failing in-flight work.

*Call graph*: called by 1 (call).


##### `fail_all_sessions`  (lines 906–915)

```
async fn fail_all_sessions(inner: &Arc<Inner>, message: String)
```

**Purpose**: Marks every active process session as failed after the shared transport goes away. This wakes readers and event subscribers that would otherwise wait forever.

**Data flow**: It drains the session registry, then calls `set_failure` on each session with the same message.

**Call relations**: `fail_all_in_flight_work` calls this as part of global disconnect cleanup.

*Call graph*: called by 1 (fail_all_in_flight_work).


##### `fail_all_in_flight_work`  (lines 918–921)

```
async fn fail_all_in_flight_work(inner: &Arc<Inner>, message: String)
```

**Purpose**: Fails all outstanding work that depends on the shared JSON-RPC connection. It covers both process sessions and streaming HTTP bodies.

**Data flow**: It receives the shared inner state and failure message. It fails all sessions, then tells the HTTP streaming registry to fail its open streams.

**Call relations**: The background reader task calls this after notification handling fails or the RPC client reports a disconnect.

*Call graph*: calls 1 internal fn (fail_all_sessions).


##### `handle_server_notification`  (lines 923–983)

```
async fn handle_server_notification(
    inner: &Arc<Inner>,
    notification: JSONRPCNotification,
) -> Result<(), ExecServerError>
```

**Purpose**: Routes one server notification to the right local consumer. It understands process output, process exit, process closed, and HTTP body chunk notifications.

**Data flow**: It receives a raw JSON-RPC notification. For process notifications, it decodes the parameters, finds the matching session, wakes it, publishes the ordered event, and removes the route after `Closed` is actually published. For HTTP body chunks, it delegates to HTTP stream handling. Unknown methods are logged and ignored.

**Call relations**: The background reader task created by `ExecServerClient::connect` calls this for every incoming notification.

*Call graph*: 3 external calls (debug!, Output, from_value).


##### `tests::read_jsonrpc_line`  (lines 1039–1049)

```
async fn read_jsonrpc_line(lines: &mut tokio::io::Lines<BufReader<R>>) -> JSONRPCMessage
```

**Purpose**: Test helper that reads one newline-delimited JSON-RPC message. It keeps tests from hanging forever by using a short timeout.

**Data flow**: It receives a buffered line reader, waits for one line, parses that line as JSON-RPC, and returns the message. If reading or parsing fails, the test panics.

**Call relations**: Several stdio-style tests use this helper to act like a fake exec-server.

*Call graph*: 4 external calls (from_secs, next_line, from_str, timeout).


##### `tests::write_jsonrpc_line`  (lines 1051–1060)

```
async fn write_jsonrpc_line(writer: &mut W, message: JSONRPCMessage)
```

**Purpose**: Test helper that writes one JSON-RPC message followed by a newline. It simulates server responses and notifications over stdio.

**Data flow**: It receives a writer and a JSON-RPC message, serializes the message to text, appends a newline, and writes it out.

**Call relations**: Fake server tasks in the tests call this after reading client requests.

*Call graph*: 3 external calls (write_all, format!, to_string).


##### `tests::accept_websocket`  (lines 1062–1067)

```
async fn accept_websocket(listener: &TcpListener) -> WebSocketStream<TcpStream>
```

**Purpose**: Test helper that accepts one TCP connection and upgrades it to a WebSocket. It gives tests a fake remote server endpoint.

**Data flow**: It receives a TCP listener, accepts the next connection, performs the WebSocket handshake, and returns the WebSocket stream.

**Call relations**: The remote reconnect test uses this to accept the first and second client connections.

*Call graph*: 2 external calls (accept, accept_async).


##### `tests::read_jsonrpc_websocket`  (lines 1069–1089)

```
async fn read_jsonrpc_websocket(websocket: &mut WebSocketStream<TcpStream>) -> JSONRPCMessage
```

**Purpose**: Test helper that reads one JSON-RPC message from a WebSocket. It ignores ping and pong frames because those are connection housekeeping.

**Data flow**: It receives a WebSocket stream, waits for a text or binary frame, parses it as JSON-RPC, and returns the message. Unexpected frames or timeouts fail the test.

**Call relations**: `tests::complete_websocket_initialize` uses this while pretending to be a WebSocket exec-server.

*Call graph*: 6 external calls (from_secs, next, panic!, from_slice, from_str, timeout).


##### `tests::write_jsonrpc_websocket`  (lines 1091–1100)

```
async fn write_jsonrpc_websocket(
        websocket: &mut WebSocketStream<TcpStream>,
        message: JSONRPCMessage,
    )
```

**Purpose**: Test helper that sends one JSON-RPC message over a WebSocket. It is the WebSocket version of the line-writing helper.

**Data flow**: It receives a WebSocket and message, serializes the message to JSON text, sends it as a WebSocket text frame, and returns when the send completes.

**Call relations**: `tests::complete_websocket_initialize` uses this to send the fake server’s initialize response.

*Call graph*: 3 external calls (send, to_string, Text).


##### `tests::complete_websocket_initialize`  (lines 1102–1137)

```
async fn complete_websocket_initialize(
        websocket: &mut WebSocketStream<TcpStream>,
        session_id: &str,
        expected_resume_session_id: Option<&str>,
    )
```

**Purpose**: Test helper that performs the server side of the initialize handshake over WebSocket. It verifies the client sent the expected resume-session value.

**Data flow**: It reads the client’s initialize request, decodes and checks its parameters, writes an initialize response with the supplied session id, then reads and verifies the follow-up initialized notification.

**Call relations**: The remote reconnect test calls this for both the first and replacement WebSocket connections.

*Call graph*: 7 external calls (Response, assert_eq!, read_jsonrpc_websocket, write_jsonrpc_websocket, panic!, from_value, to_value).


##### `tests::wait_for_disconnect`  (lines 1139–1150)

```
async fn wait_for_disconnect(client: &ExecServerClient)
```

**Purpose**: Test helper that waits until a client notices its connection has closed. It polls briefly rather than assuming the background task has already run.

**Data flow**: It receives a client, repeatedly checks `is_disconnected`, yields to let async tasks run, and fails the test if the condition is not reached before timeout.

**Call relations**: The remote reconnect test uses this after the fake server closes the first WebSocket.

*Call graph*: calls 1 internal fn (is_disconnected); 3 external calls (from_secs, yield_now, timeout).


##### `tests::connect_stdio_command_initializes_json_rpc_client`  (lines 1154–1173)

```
async fn connect_stdio_command_initializes_json_rpc_client()
```

**Purpose**: Checks that a Unix stdio command can be launched and initialized as an exec-server. The fake command reads the initialize request and replies with a session id.

**Data flow**: The test builds stdio command arguments, connects the client, and verifies the stored session id equals the fake server’s value.

**Call relations**: It exercises the stdio connection path that eventually feeds into the client initialization logic in this file.

*Call graph*: 5 external calls (from_secs, new, assert_eq!, connect_stdio_command, vec!).


##### `tests::connect_for_transport_initializes_stdio_command`  (lines 1177–1196)

```
async fn connect_for_transport_initializes_stdio_command()
```

**Purpose**: Checks that the generic transport selection path can initialize a stdio command transport. This protects the higher-level `connect_for_transport` route.

**Data flow**: The test builds `ExecServerTransportParams::StdioCommand`, connects through the generic transport function, and asserts the session id from the fake server was recorded.

**Call relations**: It verifies code outside this file can choose a transport and still reach the initialization flow described here.

*Call graph*: 4 external calls (new, assert_eq!, connect_for_transport, vec!).


##### `tests::connect_stdio_command_initializes_json_rpc_client_on_windows`  (lines 1200–1220)

```
async fn connect_stdio_command_initializes_json_rpc_client_on_windows()
```

**Purpose**: Windows version of the stdio initialization test. It uses PowerShell instead of a Unix shell to act as the fake server.

**Data flow**: The test launches a PowerShell command that replies to initialization, connects the client, and checks the stored session id.

**Call relations**: It covers the same client initialization behavior as the Unix stdio test, but for Windows command syntax.

*Call graph*: 5 external calls (from_secs, new, assert_eq!, connect_stdio_command, vec!).


##### `tests::dropping_stdio_client_terminates_spawned_process`  (lines 1224–1267)

```
async fn dropping_stdio_client_terminates_spawned_process()
```

**Purpose**: Checks that dropping a stdio-backed client terminates the spawned server process and its child process. This prevents orphaned helper processes.

**Data flow**: The test starts a shell script that writes process ids and keeps running, verifies both processes exist, drops the client, then waits until both processes exit.

**Call relations**: It validates cleanup behavior for the stdio transport used by `ExecServerClient`, even though the process-spawning details live outside this file.

*Call graph*: 9 external calls (from_secs, new, assert!, connect_stdio_command, read_pid_file, wait_for_process_exit, format!, tempdir, vec!).


##### `tests::malformed_stdio_message_terminates_spawned_process`  (lines 1271–1298)

```
async fn malformed_stdio_message_terminates_spawned_process()
```

**Purpose**: Checks that a stdio server process is cleaned up when it sends invalid JSON during initialization. A bad server should not be left running.

**Data flow**: The test starts a shell script that replies with non-JSON text, expects connection to fail, reads the server pid, and waits for that process to exit.

**Call relations**: It protects the failure path around client startup and transport cleanup.

*Call graph*: 9 external calls (from_secs, new, assert!, connect_stdio_command, read_pid_file, wait_for_process_exit, format!, tempdir, vec!).


##### `tests::read_pid_file`  (lines 1301–1312)

```
async fn read_pid_file(path: &Path) -> u32
```

**Purpose**: Test helper that waits for a script-created pid file and reads the process id from it. This makes process-cleanup tests less timing-sensitive.

**Data flow**: It receives a path, repeatedly tries to read it, parses the contents as a pid when available, and panics if the file never appears.

**Call relations**: The Unix process cleanup tests use this before checking whether spawned processes still exist.

*Call graph*: 4 external calls (from_millis, panic!, read_to_string, sleep).


##### `tests::wait_for_process_exit`  (lines 1315–1323)

```
async fn wait_for_process_exit(pid: u32)
```

**Purpose**: Test helper that waits for a process to disappear. It avoids declaring cleanup failed before the operating system has had time to reap the process.

**Data flow**: It receives a pid, repeatedly checks whether the process exists, sleeps between checks, and panics if the process is still present after the retry window.

**Call relations**: The stdio cleanup tests call this after dropping or failing a client.

*Call graph*: 4 external calls (from_millis, process_exists, panic!, sleep).


##### `tests::process_exists`  (lines 1326–1332)

```
fn process_exists(pid: u32) -> bool
```

**Purpose**: Unix test helper that checks whether a process id is alive. It uses `kill -0`, which asks the operating system about a process without sending a real signal.

**Data flow**: It receives a pid, runs `kill -0 <pid>`, and returns true if the command succeeds.

**Call relations**: `wait_for_process_exit` and the process cleanup test use this to observe spawned helper processes.

*Call graph*: 1 external calls (new).


##### `tests::shell_quote`  (lines 1335–1338)

```
fn shell_quote(path: &Path) -> String
```

**Purpose**: Test helper that safely quotes a path for insertion into a shell script. This prevents paths with special characters from breaking the test script.

**Data flow**: It receives a path, turns it into text, escapes single quotes, wraps it in single quotes, and returns the shell-safe string.

**Call relations**: The Unix stdio process tests use this when building shell scripts that write pid files.

*Call graph*: 2 external calls (to_string_lossy, format!).


##### `tests::process_events_are_delivered_in_seq_order_when_notifications_are_reordered`  (lines 1341–1481)

```
async fn process_events_are_delivered_in_seq_order_when_notifications_are_reordered()
```

**Purpose**: Verifies that process events are delivered by sequence number even when notifications arrive out of order. This protects users from seeing close before final output.

**Data flow**: The test creates an in-memory JSON-RPC connection, initializes a client, registers a session, sends closed/output/exited/output notifications in scrambled order, reads four events, and asserts they arrived as output 1, output 2, exited 3, closed 4.

**Call relations**: It directly exercises `ExecServerClient::connect`, session registration, `handle_server_notification`, and `SessionState::publish_ordered_event`.

*Call graph*: calls 3 internal fn (connect, from_stdio, from); 15 external calls (new, from_secs, new, Notification, Response, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, default, channel (+5 more)).


##### `tests::transport_disconnect_fails_sessions_and_rejects_new_sessions`  (lines 1484–1567)

```
async fn transport_disconnect_fails_sessions_and_rejects_new_sessions()
```

**Purpose**: Verifies that a transport disconnect wakes existing sessions with a failure and prevents new sessions from being registered. This guards against hangs after the server disappears.

**Data flow**: The test initializes a fake connection, registers a session, closes the server side, waits for a failed event, checks that `read` returns a closed failure response, and confirms a new registration returns a disconnected error.

**Call relations**: It exercises the reader task’s disconnect handling, `fail_all_sessions`, `SessionState::set_failure`, and `Inner::insert_session` disconnect checks.

*Call graph*: calls 3 internal fn (connect, from_stdio, from); 14 external calls (new, from_secs, Response, assert!, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, default, channel, panic! (+4 more)).


##### `tests::remote_websocket_client_replaces_disconnected_client_with_fresh_session`  (lines 1570–1618)

```
async fn remote_websocket_client_replaces_disconnected_client_with_fresh_session()
```

**Purpose**: Verifies that the lazy remote client reconnects after a WebSocket client disconnects. It also checks that concurrent callers share the same replacement client.

**Data flow**: The test starts a fake WebSocket server, completes one initialization, closes it, waits for the client to observe disconnect, then calls `get` twice concurrently and checks both returned clients use the second session id and the same shared inner state.

**Call relations**: It focuses on `LazyRemoteExecServerClient::new`, `get`, `connected_client`, and the reconnect behavior for remote transports.

*Call graph*: calls 1 internal fn (new); 10 external calls (from_secs, bind, assert!, assert_eq!, accept_websocket, complete_websocket_initialize, wait_for_disconnect, format!, join!, spawn).


##### `tests::wake_notifications_do_not_block_other_sessions`  (lines 1621–1721)

```
async fn wake_notifications_do_not_block_other_sessions()
```

**Purpose**: Verifies that many notifications for one process do not prevent another process from receiving its wake notification. This matters because all process notifications share one connection.

**Data flow**: The test creates two sessions, sends thousands of output notifications for the noisy one, then sends an exit notification for the quiet one. It waits for the quiet session’s wake receiver and checks it receives the expected sequence.

**Call relations**: It exercises the notification routing map, `SessionState::note_change`, and the non-blocking wake behavior used by independent sessions.

*Call graph*: calls 3 internal fn (connect, from_stdio, from); 14 external calls (new, from_secs, Notification, Response, assert_eq!, read_jsonrpc_line, write_jsonrpc_line, default, channel, panic! (+4 more)).


### `exec-server/src/server/transport.rs`

`io_transport` · `startup and connection handling`

This file is the server’s front door. A client needs some way to talk to the exec server, and this code supports two doors: a WebSocket URL such as `ws://127.0.0.1:1234`, or `stdio`, meaning the server reads from standard input and writes to standard output like a command-line tool connected by pipes.

The first job is to understand the listen URL. `parse_listen_url` accepts only those two forms and returns a clear error for anything else. Then `run_transport` chooses the right path.

For `stdio`, the file wraps stdin and stdout in a `JsonRpcConnection`. JSON-RPC is a simple request-and-response message format using JSON. That connection is then given to `ConnectionProcessor`, which is the part that understands what the client is asking the server to do.

For WebSockets, the file opens a TCP listener, prints the chosen WebSocket address, and builds a small Axum web server. Axum is the Rust web framework used here. The server has a health check at `/readyz`, accepts WebSocket upgrades at `/`, and rejects any request with an `Origin` header. That rejection is a safety measure: it helps stop web pages in browsers from casually connecting to this local execution server. In short, this file is the bridge between the outside world and the server’s real work.

#### Function details

##### `ExecServerListenUrlParseError::fmt`  (lines 43–54)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This formats listen URL parsing errors into readable messages. It explains whether the URL used an unsupported scheme or looked like a WebSocket URL but had an invalid address.

**Data flow**: It receives an error value and a formatter to write into. It checks which kind of error happened, writes a human-friendly message containing the bad listen URL, and returns the formatting result.

**Call relations**: This is used automatically when the parse error needs to be shown as text, such as when startup fails after `parse_listen_url` rejects a listen URL.

*Call graph*: 1 external calls (write!).


##### `parse_listen_url`  (lines 59–78)

```
fn parse_listen_url(
    listen_url: &str,
) -> Result<ExecServerListenTransport, ExecServerListenUrlParseError>
```

**Purpose**: This turns the user-provided listen setting into a concrete transport choice. It accepts `stdio` for pipe-based communication or `ws://IP:PORT` for WebSocket communication.

**Data flow**: It receives a listen URL string. If the string is `stdio` or `stdio://`, it returns the stdio transport. If it starts with `ws://`, it tries to parse the rest as an IP address and port. If parsing works, it returns a WebSocket transport with that address; otherwise it returns a clear error. Any other form also becomes an error.

**Call relations**: `run_transport` calls this first, before starting any listener. Its result decides whether the server opens stdin/stdout or starts a WebSocket listener.

*Call graph*: called by 1 (run_transport); 2 external calls (UnsupportedListenUrl, matches!).


##### `run_transport`  (lines 80–90)

```
async fn run_transport(
    listen_url: &str,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: This is the top-level chooser for the server’s communication method. It reads the listen URL, picks stdio or WebSocket, and starts the matching transport.

**Data flow**: It receives the listen URL and runtime path information needed by later server work. It parses the URL, then sends the runtime paths into either the stdio runner or the WebSocket listener. It returns success when that transport finishes, or an error if setup fails.

**Call relations**: `run_main` calls this during server startup. This function then hands off to `run_stdio_connection` for pipe-based use or `run_websocket_listener` for network use.

*Call graph*: calls 3 internal fn (parse_listen_url, run_stdio_connection, run_websocket_listener); called by 1 (run_main).


##### `run_stdio_connection`  (lines 92–96)

```
async fn run_stdio_connection(
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: This starts the server in standard-input/standard-output mode. That mode is useful when another process launches the server and talks to it through pipes instead of the network.

**Data flow**: It receives runtime paths. It opens the process stdin as the reader and stdout as the writer, then passes both to `run_stdio_connection_with_io`. It returns whatever setup or connection result comes back.

**Call relations**: `run_transport` calls this when the listen URL selects stdio. It is a small wrapper that supplies the real operating-system input and output streams before handing off to `run_stdio_connection_with_io`.

*Call graph*: calls 1 internal fn (run_stdio_connection_with_io); called by 1 (run_transport); 2 external calls (stdin, stdout).


##### `run_stdio_connection_with_io`  (lines 98–117)

```
async fn run_stdio_connection_with_io(
    reader: R,
    writer: W,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: This runs one JSON-RPC connection over any provided input and output streams. It exists so the stdio path can be tested or reused with custom streams, not only the real terminal pipes.

**Data flow**: It receives a reader, a writer, and runtime paths. It creates a `ConnectionProcessor`, wraps the reader and writer as a stdio `JsonRpcConnection`, logs that the server is listening, and waits while the processor runs that connection. When the connection ends, it returns success.

**Call relations**: `run_stdio_connection` calls this after choosing real stdin and stdout. This function creates the connection object and hands it to `ConnectionProcessor`, which performs the actual request processing.

*Call graph*: calls 2 internal fn (from_stdio, new); called by 1 (run_stdio_connection); 1 external calls (info!).


##### `run_websocket_listener`  (lines 119–141)

```
async fn run_websocket_listener(
    bind_address: SocketAddr,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
```

**Purpose**: This starts the WebSocket version of the exec server. It binds a network socket, builds the HTTP/WebSocket routes, and serves clients until the listener stops or fails.

**Data flow**: It receives an IP address and port plus runtime paths. It binds a TCP listener, discovers the actual local address, creates a shared `ConnectionProcessor`, prints the WebSocket URL to stdout, and builds an Axum router. Incoming requests then go through an Origin-header safety check, `/readyz` returns OK, and `/` can upgrade to a WebSocket connection. The function returns an error if binding or serving fails.

**Call relations**: `run_transport` calls this when the listen URL is a WebSocket address. Once running, the Axum server calls `readiness_handler`, `reject_requests_with_origin_header`, and `websocket_upgrade_handler` as requests arrive.

*Call graph*: calls 1 internal fn (new); called by 1 (run_transport); 9 external calls (new, bind, any, get, serve, info!, from_fn, println!, stdout).


##### `readiness_handler`  (lines 148–150)

```
async fn readiness_handler() -> StatusCode
```

**Purpose**: This answers the server’s readiness check. It lets another process ask, “Are you alive and accepting HTTP requests?”

**Data flow**: It receives no input. It immediately returns HTTP status 200 OK, meaning the listener is up enough to answer health checks.

**Call relations**: `run_websocket_listener` attaches this to the `/readyz` route. Axum calls it whenever a client requests that health-check path.


##### `reject_requests_with_origin_header`  (lines 152–166)

```
async fn reject_requests_with_origin_header(
    request: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode>
```

**Purpose**: This blocks requests that include an HTTP `Origin` header. That is a deliberate safety check to reduce the chance that a browser-based web page can connect to this execution server.

**Data flow**: It receives an incoming HTTP request and the next step in the server pipeline. It checks the request headers. If an `Origin` header is present, it logs a warning and returns HTTP 403 Forbidden. If not, it passes the request onward and returns the next response.

**Call relations**: `run_websocket_listener` installs this as middleware, meaning it runs before the route handlers. If it allows the request through, Axum can continue to `readiness_handler` or `websocket_upgrade_handler`; if it blocks the request, those handlers are never reached.

*Call graph*: 3 external calls (run, headers, warn!).


##### `websocket_upgrade_handler`  (lines 168–183)

```
async fn websocket_upgrade_handler(
    websocket: WebSocketUpgrade,
    ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
    State(state): State<ExecServerWebSocketState>,
) -> impl IntoResponse
```

**Purpose**: This accepts a valid WebSocket connection request and turns it into a JSON-RPC connection for the exec server. It is the point where a network client becomes an active server session.

**Data flow**: It receives the WebSocket upgrade request, the client’s socket address, and shared server state containing the `ConnectionProcessor`. It logs the client address, accepts the WebSocket upgrade, wraps the WebSocket stream as a `JsonRpcConnection`, and asks the processor to run it. The returned response tells Axum how to complete the upgrade.

**Call relations**: `run_websocket_listener` attaches this to the root route `/`. Axum calls it for WebSocket-capable requests that pass the Origin-header middleware, and it hands the upgraded stream to `ConnectionProcessor` for the real JSON-RPC work.

*Call graph*: 2 external calls (on_upgrade, info!).


### Noise relay remote connectivity
These files layer authenticated rendezvous and relay behavior on top of exec-server transports for remote environments and executor streams.

### `exec-server/src/noise_relay/mod.rs`

`config` · `connection setup and relay runtime`

The Noise relay is a part of the server that moves encrypted messages between places. “Noise” here means the Noise encryption protocol, and the relay needs to be careful about both message size and message order. This file gathers the relay’s submodules, re-exports the main connection-building pieces that other code needs, and defines shared rules used by every relay endpoint.

The first important rule is a size limit for WebSocket messages. A WebSocket is a long-lived network connection that can carry messages both ways. Without a limit, a peer could send a very large message and make the server allocate too much memory before the encrypted record is even checked. The limit here is large enough for one maximum Noise record plus its surrounding metadata, but small enough to bound memory use early.

The second important rule is that relay sequence numbers must only move forward. These numbers are used as ordering keys for encrypted records, similar to numbering envelopes before sending them so the receiver knows the intended order. If the number wrapped around after reaching its maximum, an old-looking number could be reused, which would be unsafe for the encryption scheme. The helper in this file stops with a protocol error instead of wrapping.

#### Function details

##### `noise_relay_websocket_config`  (lines 20–24)

```
fn noise_relay_websocket_config() -> WebSocketConfig
```

**Purpose**: This function creates the standard WebSocket settings required by Noise relay endpoints. It keeps incoming frames and complete messages below the relay’s fixed maximum size, so oversized traffic is rejected before deeper parsing and decryption work begins.

**Data flow**: It takes no input. It starts from the WebSocket library’s default settings, then fills in the maximum frame size and maximum message size using the relay’s shared size limit. It returns a WebSocketConfig value that callers use when opening or accepting a relay WebSocket connection.

**Call relations**: When code starts a Noise relay connection, connect_noise_rendezvous and run_remote_environment call this function to get the correct WebSocket limits. The returned configuration is handed to the WebSocket layer, which enforces the size bounds while the connection is active.

*Call graph*: called by 2 (connect_noise_rendezvous, run_remote_environment); 1 external calls (default).


##### `take_next_sequence`  (lines 26–34)

```
fn take_next_sequence(next_seq: &mut u32) -> Result<u32, ExecServerError>
```

**Purpose**: This function hands out the next relay sequence number and advances the counter. It refuses to wrap back to zero, because reusing sequence numbers would make encrypted message ordering ambiguous and unsafe.

**Data flow**: It receives a mutable counter holding the next sequence number to use. It copies the current value as the sequence number to return, then tries to increase the counter by one. If the increase is possible, it returns the copied number; if the counter is already at the largest possible u32 value, it leaves the flow with a protocol error instead of wrapping around.

**Call relations**: During relay streaming, spawn_noise_virtual_stream calls this helper whenever it needs a fresh ordering number for outgoing encrypted relay data. The helper gives back a safe sequence number or stops the stream setup/operation with an ExecServerError if the sequence space has been exhausted.

*Call graph*: called by 1 (spawn_noise_virtual_stream).


### `exec-server/src/noise_relay/harness.rs`

`io_transport` · `connection setup and request handling`

The relay service in the middle only knows how to move frames between endpoints using a stream ID. This file adds the missing safety layer on the harness side: it claims a relay stream, performs a Noise handshake with the executor, and only then lets normal JSON-RPC messages flow. Noise is an encryption and authentication protocol; here it is used so the harness can prove it is talking to the executor key that came from the registry, not to a random relay peer.

The main flow starts by creating a fresh stream ID and channels for outgoing and incoming JSON-RPC events. A background task then sends relay control frames to claim the stream and begin the handshake. During this early stage, the code is strict: it ignores unrelated streams, accepts only the expected handshake response, and rejects any data sent before encryption is ready.

Once the handshake succeeds, the file acts like a secure adapter. Outgoing JSON-RPC messages are length-framed, split into Noise-sized records, encrypted, numbered, and sent as relay data frames. Incoming relay data frames are first put back into sequence, then decrypted, then reassembled into complete JSON-RPC messages. This order matters because Noise uses an implicit message counter, like a lock that expects keys in the exact right order. Reset frames are treated as disconnects, but their untrusted text is replaced with a safe fixed reason.

#### Function details

##### `noise_harness_connection_from_websocket`  (lines 69–401)

```
fn noise_harness_connection_from_websocket(
    stream: T,
    args: NoiseHarnessConnectionArgs,
) -> JsonRpcConnection
```

**Purpose**: This function wraps one relay websocket and presents it as a normal JSON-RPC connection. It performs the secure handshake first, then encrypts outgoing JSON-RPC messages and decrypts incoming ones.

**Data flow**: It receives a websocket-like stream plus registry-derived connection details such as the environment ID, executor registration ID, harness identity, executor public key, and authorization bytes. It creates internal channels, picks a fresh stream ID, starts a background task, and returns a JsonRpcConnection immediately. Inside the task, it sends relay resume and handshake frames, waits for the matching handshake response, and then moves messages both ways: outgoing JSON-RPC text becomes framed encrypted relay data, while incoming encrypted relay data becomes JsonRPC connection events. If something is wrong, it sends a disconnect or malformed-message event and marks the connection as closed.

**Call relations**: This is the file’s central entry point for callers that already have a relay websocket. It uses noise_channel_prologue and InitiatorHandshake::start to bind the handshake to this exact environment, executor, and stream. It uses relay frame encoding and decoding to speak to the rendezvous service. After the handshake, it hands inbound data frames to receive_data for ordering, decryption, and JSON-RPC reassembly, and it calls send_disconnected when setup fails or the connection must be closed cleanly.

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

**Purpose**: This function processes one incoming encrypted relay data frame after the Noise handshake has completed. It puts frames in the right order, decrypts them, and emits complete JSON-RPC messages when enough bytes have arrived.

**Data flow**: It receives the current ordered-frame buffer, the active Noise transport, the JSON-RPC decoder, one relay data frame, and the channel used to report connection events. It stores the frame by its sequence number, takes any now-ready ciphertext frames in order, decrypts each one, and feeds the plaintext bytes into the decoder. For every full JSON-RPC message produced, it sends a Message event to the connection’s incoming event stream. If ordering, decryption, decoding, or event delivery fails, it returns an error.

**Call relations**: The main websocket task calls this after it has verified that an incoming post-handshake relay frame is data for the current stream. This helper protects the Noise channel from out-of-order or duplicate ciphertext and then hands completed application messages back to the JsonRpcConnection event channel.

*Call graph*: calls 3 internal fn (decrypt, push, push); 2 external calls (send, Message).


##### `send_malformed`  (lines 433–437)

```
async fn send_malformed(incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>, reason: String)
```

**Purpose**: This small helper reports that the peer or relay sent something that could not be accepted as a valid protocol message. It packages the explanation as a MalformedMessage event.

**Data flow**: It receives the incoming-event channel and a human-readable reason string. It sends a JsonRpcConnectionEvent::MalformedMessage into that channel. It does not return an error to its caller if the receiver is already gone; it simply ignores the failed send.

**Call relations**: The websocket task uses this when a frame cannot be decoded, has the wrong shape, contains invalid post-handshake data, or uses text where binary relay frames are expected. It is the path for protocol problems that are not normal disconnects.

*Call graph*: 1 external calls (send).


##### `send_disconnected`  (lines 439–450)

```
async fn send_disconnected(
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    disconnected_tx: &watch::Sender<bool>,
    reason: String,
)
```

**Purpose**: This helper tells the rest of the connection that the secure relay connection is no longer usable. It updates both the watch flag used to observe disconnection and the event stream used to explain why.

**Data flow**: It receives the incoming-event channel, the shared disconnected flag sender, and a reason string. It first sets the disconnected flag to true, then sends a Disconnected event containing the reason. If either receiver has already been dropped, it ignores that failed notification.

**Call relations**: noise_harness_connection_from_websocket calls this during handshake and setup failures, such as websocket closure, invalid relay frames, early data, parse errors, or Noise handshake failure. It gives callers one consistent shutdown signal instead of making each failure path build its own event.

*Call graph*: called by 1 (noise_harness_connection_from_websocket); 1 external calls (send).


### `exec-server/src/noise_relay/executor_stream.rs`

`io_transport` · `after Noise handshake, during relay stream request handling`

A relay connection can carry several logical conversations at once, a bit like several phone calls sharing one cable. This file is the executor-side wrapper for one of those conversations after the Noise handshake has already proved the peer and created shared encryption keys. Its job is to keep that one virtual stream secure, ordered, and independent from the others.

Incoming relay data arrives as encrypted chunks with sequence numbers. `NoiseVirtualStream` first puts those chunks back into the right order, then decrypts them using `NoiseTransport`, then feeds the plain bytes into a JSON-RPC decoder. Whenever a full JSON-RPC message is found, it is queued for the normal connection processor. This is deliberately nonblocking: if one stream is overloaded or abandoned, it should fail by itself instead of freezing every other stream using the same physical websocket.

Outgoing traffic runs in a separate spawned task. The normal JSON-RPC processor sends messages into a channel. The writer task frames each message, splits it into record-sized pieces, encrypts each piece, gives it a sequence number, wraps it as a relay data frame, and sends it to the shared physical relay output. When the stream ends, it sends a best-effort reset frame and reports which stream instance closed. The instance ID matters because relay stream IDs are untrusted and may be reused; it prevents an old close notice from accidentally deleting a newer stream with the same ID.

#### Function details

##### `NoiseVirtualStream::disconnect`  (lines 56–61)

```
fn disconnect(self, reason: Option<String>)
```

**Purpose**: This tells the local JSON-RPC side that the virtual stream is no longer usable. It sends both a general disconnected signal and a specific disconnected event, optionally including a human-readable reason.

**Data flow**: It receives ownership of the stream object and an optional reason string. It marks the watch channel as disconnected, then tries to place a disconnected event into the stream's incoming event queue. Nothing is returned; the effect is that readers waiting on this stream learn that it has closed.

**Call relations**: This is used when the relay layer needs to shut down a particular virtual stream. It relies on the underlying channel send operations to notify the JSON-RPC connection side, but it does not wait or retry if the event queue is already closed.

*Call graph*: 2 external calls (send, try_send).


##### `NoiseVirtualStream::receive_data`  (lines 65–87)

```
fn receive_data(&mut self, data: RelayData) -> Result<(), ExecServerError>
```

**Purpose**: This accepts one encrypted relay data frame for the stream and turns it into zero or more complete JSON-RPC messages. It also protects the shared read loop by failing quickly if this stream cannot accept more input.

**Data flow**: It takes relay data containing a sequence number and encrypted bytes. First it feeds the data into the ordered-frame buffer, which may return this frame and any later frames that can now be processed in order. For each encrypted chunk, it locks the shared Noise transport just long enough to decrypt it, then passes the decrypted bytes into the JSON-RPC message decoder. Each complete decoded message is placed into the incoming event queue. On success it returns nothing meaningful; on bad ordering, failed decryption, invalid message framing, or a full or closed queue, it returns an execution-server error.

**Call relations**: The environment or relay read loop calls this whenever encrypted data arrives for this virtual stream. Inside, it hands data first to `OrderedCiphertextFrames::push` for ordering, then to `NoiseTransport` for decryption, then to `JsonRpcMessageDecoder::push` for message assembly, and finally to the JSON-RPC connection event queue as `Message` events.

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

**Purpose**: This creates a fully working virtual stream after the Noise handshake is complete. It starts the normal JSON-RPC processor for the stream and starts a writer task that encrypts outgoing JSON-RPC messages into relay frames.

**Data flow**: It receives the relay stream ID, a unique instance ID, the connection processor, channels for physical outgoing relay bytes and closed-stream notices, and the established Noise transport. It builds internal channels for JSON-RPC input, JSON-RPC output, and disconnection notices. It wraps the Noise transport in a shared lock so the reader side and writer side can both use the same encryption state safely. It then spawns one task that reads outgoing JSON-RPC messages, frames and splits them, assigns sequence numbers, encrypts each chunk, wraps it in relay frames, and sends the encoded bytes to the physical relay output. It also spawns the JSON-RPC processor task. The function returns the read-side `NoiseVirtualStream`, which the relay loop can use to feed inbound encrypted data.

**Call relations**: This is the setup point for a completed secure relay stream. It wires together the JSON-RPC processor, the encrypted relay writer, and the object used by the relay read loop. The writer task calls `frame_jsonrpc_message` to make message bytes, `take_next_sequence` to number chunks safely, `NoiseTransport::encrypt` to protect them, `RelayMessageFrame::data` and `encode_relay_message_frame` to prepare relay output, and finally sends closure notices when it exits. The processor task calls `run_connection` with the constructed `JsonRpcConnection`, so the rest of the server can treat this encrypted virtual stream like an ordinary JSON-RPC connection.

*Call graph*: calls 5 internal fn (encrypt, frame_jsonrpc_message, take_next_sequence, encode_relay_message_frame, run_connection); 15 external calls (clone, new, new, clone, send, try_send, default, default, data, reset (+5 more)).


### `exec-server/src/remote.rs`

`orchestration` · `remote startup and long-running connection loop`

This file solves the “how does a remote client safely find and use this exec-server?” problem. First, it cleans and stores the remote configuration: the registry URL, the environment id, and an authentication provider. Then it creates a small registry client that talks to the cloud registry over HTTP. The executor generates a Noise identity, meaning a public/private key pair used for encrypted communication. It registers the public key with the registry and gets back a rendezvous URL plus a registration id.

After that, the file keeps a long-running connection loop alive. It opens a WebSocket to the rendezvous service, like joining a meeting room where clients can find it. The WebSocket carries routing details in the clear, but the actual payloads are protected by Noise encryption. Once connected, it hands the socket to the relay layer, which can serve many logical streams over one WebSocket.

The file also asks the registry to validate each incoming harness key before allowing it to use this executor. This is the security gate: proving possession of a key is not enough; the registry must also say that key is allowed. Error helpers turn registry failures into clear internal errors while avoiding leaks of sensitive tokens.

#### Function details

##### `EnvironmentRegistryClient::fmt`  (lines 35–40)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This defines how the registry client appears in debug logs. It shows the registry URL but deliberately hides the authentication provider so secrets are not printed.

**Data flow**: It receives the client and a debug formatter. It writes a debug-shaped summary containing the base URL and a placeholder for authentication, then returns the formatter result.

**Call relations**: Rust calls this when something formats an EnvironmentRegistryClient with debug output. It relies on the standard debug builder and does not take part in network flow.

*Call graph*: 1 external calls (debug_struct).


##### `EnvironmentRegistryClient::new`  (lines 44–53)

```
fn new(base_url: String, auth_provider: SharedAuthProvider) -> Result<Self, ExecServerError>
```

**Purpose**: This creates the HTTP client used to talk to the environment registry. It also normalizes the registry URL and disables automatic redirects so authorization headers are not accidentally sent somewhere else.

**Data flow**: It takes a base URL and an authentication provider. It trims and checks the URL, builds a reqwest HTTP client with redirects turned off, and returns a ready-to-use EnvironmentRegistryClient or an error.

**Call relations**: The remote runner creates this client during startup. The tests also create it to verify registration and redirect behavior. It calls normalize_base_url before building the underlying HTTP client.

*Call graph*: calls 1 internal fn (normalize_base_url); called by 5 (validate_harness_key_does_not_expose_error_body, validate_harness_key_requires_explicit_valid_response, run_remote_environment, register_environment_does_not_follow_redirects_with_auth_headers, register_environment_posts_with_auth_provider_headers); 2 external calls (builder, none).


##### `EnvironmentRegistryClient::register_environment`  (lines 57–100)

```
async fn register_environment(
        &self,
        environment_id: &str,
        executor_public_key: &NoiseChannelPublicKey,
    ) -> Result<EnvironmentRegistryRegistrationResponse, ExecServerErro
```

**Purpose**: This registers this executor with the cloud registry and asks where it should connect for rendezvous. The registry response tells the executor which WebSocket URL to use and what registration id to include later.

**Data flow**: It takes an environment id and the executor’s public Noise key. It sends an authenticated JSON POST to the registry, parses the JSON response, checks that the returned environment id and security profile match what was requested, logs success, and returns the registration details.

**Call relations**: run_remote_environment calls this before the first rendezvous connection and again if a previous rendezvous URL is rejected. It uses endpoint_url to build the request URL and parse_json_response to turn the HTTP response into either a typed result or a meaningful error.

*Call graph*: calls 2 internal fn (parse_json_response, endpoint_url); 6 external calls (to_auth_headers, post, debug!, Protocol, format!, info!).


##### `EnvironmentRegistryClient::parse_json_response`  (lines 102–120)

```
async fn parse_json_response(
        &self,
        response: reqwest::Response,
    ) -> Result<R, ExecServerError>
```

**Purpose**: This is the common response checker for registry HTTP calls that should return JSON. It keeps success parsing in one place and turns failed HTTP statuses into project-specific errors.

**Data flow**: It receives a raw HTTP response. If the status means success, it decodes the body as JSON into the requested type. If the status is unauthorized or forbidden, it builds an authentication error; otherwise it builds a registry HTTP error with a safe message.

**Call relations**: register_environment uses this after sending its POST request. It delegates error-message construction to environment_registry_auth_error or environment_registry_http_error depending on the status code.

*Call graph*: calls 2 internal fn (environment_registry_auth_error, environment_registry_http_error); called by 1 (register_environment); 3 external calls (status, text, matches!).


##### `RegistryHarnessKeyValidator::validate_harness_key`  (lines 160–205)

```
async fn validate_harness_key(
        &self,
        harness_public_key: &NoiseChannelPublicKey,
        authorization: &str,
    ) -> Result<(), ExecServerError>
```

**Purpose**: This asks the registry whether an incoming harness public key is allowed to use this registered executor. It is the authorization check for remote clients after the cryptographic handshake proves they own the key.

**Data flow**: It receives a harness public key and a short-lived authorization string. It posts those, along with the executor registration id, to the registry validation endpoint. If the registry returns success with valid=true, it returns success; otherwise it returns an authentication, HTTP, or protocol error.

**Call relations**: run_remote_environment creates this validator and passes it into run_multiplexed_environment. The relay layer calls it when a new harness connection needs to be approved. It uses endpoint_url to form the validation URL and intentionally avoids including response bodies in some errors because they might contain sensitive authorization data.

*Call graph*: calls 1 internal fn (endpoint_url); 4 external calls (EnvironmentRegistryAuth, Protocol, format!, matches!).


##### `RemoteEnvironmentConfig::fmt`  (lines 218–225)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This defines safe debug output for remote environment configuration. It prints useful non-secret fields and hides the authentication provider.

**Data flow**: It receives the config and a formatter. It writes the base URL, environment id, and name, replaces the auth provider with '<redacted>', and returns the formatter result.

**Call relations**: Rust calls this when the config is printed with debug formatting. The debug_output_redacts_auth_provider test checks that this safety behavior works.

*Call graph*: 1 external calls (debug_struct).


##### `RemoteEnvironmentConfig::new`  (lines 229–241)

```
fn new(
        base_url: String,
        environment_id: String,
        auth_provider: SharedAuthProvider,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: This builds a validated configuration object for remote exec-server mode. It makes sure the environment id is present before the rest of the remote startup uses it.

**Data flow**: It takes a base URL, an environment id, and an auth provider. It trims and validates the environment id, sets a default display name of 'codex-exec-server', keeps the auth provider private, and returns the config or an error.

**Call relations**: The exec-server command setup calls this when preparing remote mode. Integration-style tests also call it while setting up remote behavior. It relies on normalize_environment_id for the validation step.

*Call graph*: calls 1 internal fn (normalize_environment_id); called by 4 (run_exec_server_command, reconnect_reuses_registration_until_url_is_rejected, debug_output_redacts_auth_provider, remote_environment_routes_encrypted_exec_server_rpc).


##### `run_remote_environment`  (lines 250–320)

```
async fn run_remote_environment(
    config: RemoteEnvironmentConfig,
    runtime_paths: ExecServerRuntimePaths,
) -> Result<(), ExecServerError>
```

**Purpose**: This is the main remote-mode loop. It registers the executor, connects to the rendezvous WebSocket, hands the live connection to the encrypted relay, and retries with backoff when connections fail.

**Data flow**: It receives remote configuration and runtime paths. It prepares TLS crypto support, creates a registry client, creates a connection processor, generates one Noise identity for the process, registers the executor, and then repeatedly tries to connect to the returned WebSocket URL. On a successful connection it runs the multiplexed environment until that session ends. On failure it waits, doubles the wait time up to 30 seconds, and re-registers if the rendezvous service rejects the old registration URL.

**Call relations**: This is called by the remote exec-server startup path. It calls EnvironmentRegistryClient::new, EnvironmentRegistryClient::register_environment, noise_relay_websocket_config, the WebSocket connector, and run_multiplexed_environment. It also creates RegistryHarnessKeyValidator so the relay can check each incoming harness key with the registry.

*Call graph*: calls 5 internal fn (generate, noise_relay_websocket_config, run_multiplexed_environment, new, new); 8 external calls (from_secs, ensure_rustls_crypto_provider, debug!, info!, matches!, sleep, connect_async_with_config, warn!).


##### `normalize_environment_id`  (lines 322–330)

```
fn normalize_environment_id(environment_id: String) -> Result<String, ExecServerError>
```

**Purpose**: This cleans and validates the environment id supplied by the user or caller. It prevents the remote registration flow from starting with a blank id.

**Data flow**: It takes a string, trims surrounding whitespace, and checks whether anything remains. If the result is empty it returns a configuration error; otherwise it returns the cleaned id.

**Call relations**: RemoteEnvironmentConfig::new calls this while building remote configuration. That means bad environment ids are caught early, before any network request is made.

*Call graph*: called by 1 (new); 1 external calls (EnvironmentRegistryConfig).


##### `normalize_base_url`  (lines 343–351)

```
fn normalize_base_url(base_url: String) -> Result<String, ExecServerError>
```

**Purpose**: This cleans and validates the registry base URL. It avoids later URL-building mistakes caused by extra spaces or trailing slashes.

**Data flow**: It takes a base URL string, trims whitespace, removes trailing slash characters, and checks that the result is not empty. It returns the cleaned URL or a configuration error.

**Call relations**: EnvironmentRegistryClient::new calls this before storing the URL. Later, endpoint_url assumes the base URL is already in this cleaned form.

*Call graph*: called by 1 (new); 1 external calls (EnvironmentRegistryConfig).


##### `endpoint_url`  (lines 353–355)

```
fn endpoint_url(base_url: &str, path: &str) -> String
```

**Purpose**: This joins the registry base URL and an endpoint path into one request URL. It is a small helper that avoids double slashes or missing slashes.

**Data flow**: It receives a base URL and a path. It removes leading slashes from the path, inserts exactly one slash between the two parts, and returns the combined URL string.

**Call relations**: register_environment uses it for the registration endpoint, and validate_harness_key uses it for the validation endpoint. It is the shared URL builder for registry API calls in this file.

*Call graph*: called by 2 (register_environment, validate_harness_key); 1 external calls (format!).


##### `environment_registry_auth_error`  (lines 357–362)

```
fn environment_registry_auth_error(status: StatusCode, body: &str) -> ExecServerError
```

**Purpose**: This turns a registry authentication failure into the project’s own error type. It preserves a useful message while clearly labeling the problem as an authentication issue.

**Data flow**: It takes an HTTP status and response body. It tries to extract a registry error message, falls back to a safe preview or 'empty error body', and returns an ExecServerError::EnvironmentRegistryAuth message.

**Call relations**: parse_json_response calls this when the registry returns unauthorized or forbidden. It uses registry_error_message to find the best safe explanation.

*Call graph*: calls 1 internal fn (registry_error_message); called by 1 (parse_json_response); 2 external calls (EnvironmentRegistryAuth, format!).


##### `environment_registry_http_error`  (lines 364–388)

```
fn environment_registry_http_error(status: StatusCode, body: &str) -> ExecServerError
```

**Purpose**: This turns a non-authentication registry HTTP failure into a structured project error. It tries to keep the registry’s error code and message when available.

**Data flow**: It receives an HTTP status and response body. It tries to parse the body as the registry’s error JSON shape. If parsing works, it uses the embedded code and message; if not, it uses a short preview of the raw body. It returns an ExecServerError::EnvironmentRegistryHttp.

**Call relations**: parse_json_response calls this for failed registry responses that are not authorization failures. It uses preview_error_body when it needs a safe fallback message.

*Call graph*: called by 1 (parse_json_response).


##### `registry_error_message`  (lines 390–396)

```
fn registry_error_message(body: &str) -> Option<String>
```

**Purpose**: This extracts a human-readable error message from a registry error body. If the body is not in the expected JSON shape, it falls back to a short raw preview.

**Data flow**: It takes the response body text. It tries to parse it as a registry error object and pull out the nested message. If that fails or the message is missing, it returns preview_error_body’s trimmed preview, or nothing if the body is empty.

**Call relations**: environment_registry_auth_error calls this so authentication errors can include the registry’s explanation when one is safely available.

*Call graph*: called by 1 (environment_registry_auth_error).


##### `preview_error_body`  (lines 398–404)

```
fn preview_error_body(body: &str) -> Option<String>
```

**Purpose**: This produces a safe, short preview of an error body for diagnostics. It prevents very large response bodies from being copied into errors or logs.

**Data flow**: It takes raw response text, trims whitespace, and returns nothing if it is empty. Otherwise it returns at most the configured number of characters from the trimmed body.

**Call relations**: The registry error helpers use this when they cannot extract a cleaner structured message. It is a last-resort way to give people a clue about what failed without dumping unlimited text.


##### `tests::StaticRegistryAuthProvider::add_auth_headers`  (lines 428–437)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: This test-only authentication provider adds fixed headers to mock registry requests. It gives tests a predictable way to check that authentication headers are sent.

**Data flow**: It receives a mutable HTTP header map. It inserts a bearer token and a workspace account id, then leaves the modified header map for the request code to use.

**Call relations**: tests::static_registry_auth_provider wraps this provider so tests can pass it into EnvironmentRegistryClient::new or RemoteEnvironmentConfig::new. The registration tests then make the mock server require these headers.

*Call graph*: 2 external calls (insert, from_static).


##### `tests::static_registry_auth_provider`  (lines 440–442)

```
fn static_registry_auth_provider() -> SharedAuthProvider
```

**Purpose**: This builds the shared test authentication provider used by the registry tests. It hides the wrapping details so each test can ask for a ready provider in one call.

**Data flow**: It creates a StaticRegistryAuthProvider, places it behind a shared pointer, and returns it as the shared authentication provider type expected by production code.

**Call relations**: The registration and debug-output tests call this during setup. It supports the test-only StaticRegistryAuthProvider::add_auth_headers behavior.

*Call graph*: 1 external calls (new).


##### `tests::register_environment_posts_with_auth_provider_headers`  (lines 445–483)

```
async fn register_environment_posts_with_auth_provider_headers()
```

**Purpose**: This test proves that environment registration sends the right endpoint, authentication headers, request body, and parses the registry’s successful response correctly.

**Data flow**: It starts a mock HTTP server, generates an executor public key, configures the server to expect a POST with specific headers and JSON, creates a registry client, calls register_environment, and compares the returned registration data to the expected value.

**Call relations**: This test exercises EnvironmentRegistryClient::new and EnvironmentRegistryClient::register_environment together. It uses tests::static_registry_auth_provider so the expected auth headers are added to the request.

*Call graph*: calls 2 internal fn (generate, new); 10 external calls (given, start, new, assert_eq!, static_registry_auth_provider, json!, body_partial_json, header, method, path).


##### `tests::register_environment_does_not_follow_redirects_with_auth_headers`  (lines 486–521)

```
async fn register_environment_does_not_follow_redirects_with_auth_headers()
```

**Purpose**: This test checks an important security behavior: registry requests must not automatically follow redirects while carrying authorization headers. Without this, a redirect could expose credentials to another URL.

**Data flow**: It starts a mock server, sets the registration endpoint to return a redirect, sets the redirect target to expect no authenticated follow-up request, creates a client, calls register_environment, and confirms the result is an HTTP error for the redirect status.

**Call relations**: This test depends on EnvironmentRegistryClient::new building an HTTP client with redirects disabled. It also uses tests::static_registry_auth_provider to make sure the original request carries auth headers.

*Call graph*: calls 2 internal fn (generate, new); 9 external calls (given, start, new, assert!, static_registry_auth_provider, format!, header, method, path).


##### `tests::debug_output_redacts_auth_provider`  (lines 524–536)

```
fn debug_output_redacts_auth_provider()
```

**Purpose**: This test ensures debug printing of remote configuration does not reveal authentication details. It protects against accidental secret leaks in logs.

**Data flow**: It creates a RemoteEnvironmentConfig with the static test auth provider, formats it with debug output, and checks that the output contains '<redacted>' and does not contain the workspace id.

**Call relations**: This test calls RemoteEnvironmentConfig::new and relies on RemoteEnvironmentConfig::fmt being used by debug formatting. It uses tests::static_registry_auth_provider as a known source of sensitive-looking test data.

*Call graph*: calls 1 internal fn (new); 3 external calls (assert!, static_registry_auth_provider, format!).


### `exec-server/src/client_transport.rs`

`io_transport` · `connection setup and reconnect`

An exec server can live in more than one place. It might be waiting at a WebSocket URL, hidden behind a secure relay, or started locally as a command-line program. This file is the adapter that makes all of those routes look the same to the rest of the client.

The main idea is: first open the chosen transport, then wrap it as a `JsonRpcConnection`. JSON-RPC is a simple request-and-response message format, like sending labeled forms back and forth. After the transport is ready, this file hands the connection to the shared `ExecServerClient::connect` setup step, which performs the normal client initialization.

For WebSockets, it applies a connection timeout and reports clear errors if the server cannot be reached. For rendezvous relay connections, it also prepares an encrypted Noise session. Noise is a cryptographic handshake protocol; here it means the relay only carries unreadable ciphertext after the secure setup. For local command connections, it starts a child process, pipes its stdin and stdout into JSON-RPC, and logs anything the child writes to stderr for debugging.

A useful analogy is a phone charger with several plug adapters. The wall outlets differ, but this file chooses the right adapter so the client always receives the same usable power: a ready JSON-RPC connection.

#### Function details

##### `ExecServerClient::connect_for_transport`  (lines 34–80)

```
async fn connect_for_transport(
        transport_params: crate::client_api::ExecServerTransportParams,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Chooses the right connection method based on the transport settings it is given. This is the entry point when the caller says, in effect, “connect however these parameters describe.”

**Data flow**: It receives transport parameters that describe one of three routes: a WebSocket URL, a Noise rendezvous provider and identity, or a local stdio command. It fills in common details such as the client name and default timeouts where needed, fetches a fresh rendezvous bundle for Noise connections, and then passes the prepared arguments to the matching connector. The result is either a ready `ExecServerClient` or a clear connection error.

**Call relations**: This function is the dispatcher for the file. When a WebSocket transport is requested, it sends the work to `ExecServerClient::connect_websocket`. When a Noise rendezvous transport is requested, it first asks the provider for fresh connection details and then calls `ExecServerClient::connect_noise_rendezvous`. When a stdio command is requested, it calls `ExecServerClient::connect_stdio_command`.

*Call graph*: 3 external calls (connect_noise_rendezvous, connect_stdio_command, connect_websocket).


##### `ExecServerClient::connect_websocket`  (lines 82–106)

```
async fn connect_websocket(
        args: RemoteExecServerConnectArgs,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Opens a WebSocket connection to a remote exec server and turns it into the common JSON-RPC client connection. A WebSocket is a long-lived network connection that lets both sides send messages over the same link.

**Data flow**: It receives a URL, timeouts, a client name, and optional session-resume information. It makes sure the TLS cryptography provider is installed, tries to connect before the timeout expires, and turns timeout or network failures into `ExecServerError` values. Once the WebSocket is open, it labels the connection for diagnostics, decides whether the URL represents a special rendezvous harness connection, wraps the stream accordingly, and then hands it to the shared client initialization step. The output is a fully initialized `ExecServerClient` or an error.

**Call relations**: This function is called by `ExecServerClient::connect_for_transport` when the chosen transport is a plain WebSocket. During setup it asks `is_rendezvous_harness_url` whether the URL needs the harness wrapper; otherwise it uses the normal WebSocket-to-JSON-RPC wrapper. In both cases it finishes by handing the connection to the shared `ExecServerClient::connect` flow.

*Call graph*: calls 3 internal fn (is_rendezvous_harness_url, from_websocket, harness_connection_from_websocket); 6 external calls (connect, ensure_rustls_crypto_provider, into, format!, timeout, connect_async).


##### `ExecServerClient::connect_noise_rendezvous`  (lines 111–176)

```
async fn connect_noise_rendezvous(
        args: NoiseRendezvousConnectArgs,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Connects to an exec server through an authenticated rendezvous relay and sets up encryption before normal JSON-RPC begins. This is used when the client and server meet through a relay but still need to prove who they are and keep messages private.

**Data flow**: It receives a rendezvous bundle containing the WebSocket URL, environment and executor identifiers, the executor public key, and authorization for the harness key, plus the client identity and timeout settings. It strips sensitive query details from the URL for safer diagnostics, opens the WebSocket with a Noise-specific configuration, and reports timeout or connection errors using that safer URL. Then it builds a Noise harness connection using the identity and pinned executor key, and finally passes that secure connection into the common client initialization step. The result is a ready client over an encrypted relay stream, or an error.

**Call relations**: This function is reached from `ExecServerClient::connect_for_transport` after that function obtains a fresh rendezvous bundle from the provider. It calls the Noise relay helpers to configure the WebSocket and wrap it in the encrypted harness connection. Once the secure stream exists, it joins the same path as the other transports by calling `ExecServerClient::connect`.

*Call graph*: calls 1 internal fn (noise_relay_websocket_config); 6 external calls (connect, ensure_rustls_crypto_provider, noise_harness_connection_from_websocket, format!, timeout, connect_async_with_config).


##### `ExecServerClient::connect_stdio_command`  (lines 178–216)

```
async fn connect_stdio_command(
        args: StdioExecServerConnectArgs,
    ) -> Result<Self, ExecServerError>
```

**Purpose**: Starts an exec server as a local child process and talks to it through standard input and output. This is useful when the server is not remote at all, but is launched directly by the client.

**Data flow**: It receives a command description: program, arguments, environment variables, optional working directory, and client initialization options. It builds the process command, starts it with piped stdin, stdout, and stderr, and checks that the input and output pipes are actually available. It starts a background task that reads stderr line by line and logs it, so diagnostic messages are not lost. Then it wraps stdout and stdin as a JSON-RPC connection, attaches the child process to that connection for lifecycle tracking, and runs the shared client initialization. The output is an initialized client connected to the child process, or a spawn/protocol error.

**Call relations**: This function is called by `ExecServerClient::connect_for_transport` for stdio-based transports. It relies on `stdio_command_process` to build the `tokio::process::Command` correctly, then uses the JSON-RPC stdio wrapper before handing everything to `ExecServerClient::connect`. It also spawns a small background reader so the child process stderr stream is drained and logged while the client runs.

*Call graph*: calls 2 internal fn (stdio_command_process, from_stdio); 7 external calls (new, connect, piped, debug!, into, spawn, warn!).


##### `is_rendezvous_harness_url`  (lines 219–227)

```
fn is_rendezvous_harness_url(websocket_url: &str) -> bool
```

**Purpose**: Checks whether a WebSocket URL is marked as a rendezvous harness connection. The client uses this to decide which wrapper should interpret the WebSocket stream.

**Data flow**: It receives a URL string. It looks for a query string after `?`, splits that query into key-value pairs, and searches for `role=harness`. It returns `true` if that marker is present and `false` if there is no query string or no matching role value.

**Call relations**: This helper is used by `ExecServerClient::connect_websocket` after the WebSocket opens. If it returns `true`, the WebSocket is wrapped with `harness_connection_from_websocket`; if it returns `false`, the connection uses the standard `JsonRpcConnection::from_websocket` path.

*Call graph*: called by 1 (connect_websocket).


##### `stdio_command_process`  (lines 229–239)

```
fn stdio_command_process(stdio_command: &StdioExecServerCommand) -> Command
```

**Purpose**: Builds the operating-system command used to start a stdio exec server. It gathers the program name, arguments, environment, and working directory into a launchable process description.

**Data flow**: It receives a `StdioExecServerCommand` containing the program to run and its launch settings. It creates a new process command, adds arguments and environment variables, applies the working directory if one was supplied, and on Unix places the child in a new process group. It returns the prepared command object; it does not start the process itself.

**Call relations**: This helper is called by `ExecServerClient::connect_stdio_command` just before spawning the local exec server. By keeping process setup here, the stdio connector can focus on wiring the child process pipes into JSON-RPC and running the common client initialization.

*Call graph*: called by 1 (connect_stdio_command); 1 external calls (new).


### MCP sidecar startup
These files build the runtime context and launch machinery for MCP servers, then manage per-server RMCP client lifecycles.

### `codex-mcp/src/runtime.rs`

`orchestration` · `MCP server startup and cross-cutting metrics`

MCP means Model Context Protocol, a way for Codex to talk to tool servers. Those servers may run locally, or in a named remote execution environment. This file is the small checkpoint that decides whether a server’s configured environment makes sense before the rest of the MCP startup code tries to launch or contact it.

The main piece is McpRuntimeContext. It carries two things: a shared EnvironmentManager, which is like a registry of known places where servers may run, and a fallback working directory for local servers that communicate through standard input/output. When a server is being prepared, the context looks up the server’s environment id. If it finds an environment, it returns it. If the server is a remote stdio server, it also insists on an absolute working directory, because a relative path would be ambiguous on another machine. If no environment exists, local HTTP servers are allowed to continue without one, but local stdio servers are rejected because they need a local runtime to spawn a process.

The file also defines SandboxState, the payload that describes sandbox permissions and paths for servers that understand sandboxing. Finally, emit_duration records timing information if telemetry is enabled, while safely doing nothing when it is not.

#### Function details

##### `McpRuntimeContext::new`  (lines 44–52)

```
fn new(
        environment_manager: Arc<EnvironmentManager>,
        local_stdio_fallback_cwd: PathBuf,
    ) -> Self
```

**Purpose**: Creates a runtime context for MCP server setup. It bundles the known execution environments together with the fallback folder used for local stdio servers.

**Data flow**: It receives a shared EnvironmentManager and a PathBuf for the fallback current working directory. It stores both values inside a new McpRuntimeContext. The result is a context object that later startup code can ask about where MCP servers should run.

**Call relations**: Higher-level MCP flows, such as listing server status and reading MCP resources, build this context before resolving individual servers. The tests also create it with different environment registries to prove the later resolution rules behave correctly.

*Call graph*: called by 13 (list_mcp_server_status, read_mcp_resource, no_local_runtime_fails_local_stdio_but_keeps_local_http_server, explicit_remote_stdio_and_http_accept_named_environment, local_http_does_not_require_local_stdio_availability, local_stdio_accepts_local_environment_when_available, local_stdio_requires_local_stdio_availability, remote_stdio_requires_absolute_cwd, unknown_explicit_environment_is_rejected, list_accessible_connectors_from_mcp_tools_with_mcp_manager (+3 more)).


##### `McpRuntimeContext::local_stdio_fallback_cwd`  (lines 54–56)

```
fn local_stdio_fallback_cwd(&self) -> PathBuf
```

**Purpose**: Returns the fallback working directory for a local stdio MCP server. This is used when a local process-based server does not name its own folder to start in.

**Data flow**: It reads the stored fallback path from the runtime context, clones it, and returns the clone. Nothing inside the context is changed.

**Call relations**: make_rmcp_client calls this while building a client for an MCP server. It lets that startup code fill in a safe default directory without taking ownership of the path stored in the shared context.

*Call graph*: called by 1 (make_rmcp_client); 1 external calls (clone).


##### `McpRuntimeContext::resolve_server_environment`  (lines 58–89)

```
fn resolve_server_environment(
        &self,
        server_name: &str,
        config: &codex_config::McpServerConfig,
    ) -> Result<Option<Arc<Environment>>, String>
```

**Purpose**: Decides which execution environment, if any, an MCP server should use. It turns a server’s configuration into either a known environment, no environment for the special local HTTP case, or a clear error message.

**Data flow**: It takes a server name and that server’s configuration. It looks up the configuration’s environment id in the EnvironmentManager. If found, it may validate the working directory for remote stdio, then returns the environment. If not found, it checks whether the server claims to be local: local stdio becomes an error, local HTTP returns no environment, and unknown non-local ids become an error.

**Call relations**: make_rmcp_client calls this during MCP client construction, before the client launches or connects to a server. When a remote stdio server is involved, this function delegates the path check to ensure_remote_stdio_cwd so the main decision remains easy to read.

*Call graph*: calls 2 internal fn (ensure_remote_stdio_cwd, is_local_environment); called by 1 (make_rmcp_client); 1 external calls (format!).


##### `ensure_remote_stdio_cwd`  (lines 92–111)

```
fn ensure_remote_stdio_cwd(
    server_name: &str,
    config: &codex_config::McpServerConfig,
) -> Result<(), String>
```

**Purpose**: Checks that a remote stdio MCP server has a clear, absolute working directory. This prevents Codex from sending a vague relative path to a different machine or runtime.

**Data flow**: It receives the server name and configuration. If the server is not stdio-based, it accepts it immediately. If it is stdio-based, it looks for a cwd value; missing cwd is an error, an absolute cwd is accepted, and a relative cwd becomes an error that includes the bad path.

**Call relations**: resolve_server_environment calls this only after it has found a named non-local environment. It acts as the safety gate for remote process-style MCP servers before startup continues.

*Call graph*: called by 1 (resolve_server_environment); 1 external calls (format!).


##### `emit_duration`  (lines 113–117)

```
fn emit_duration(metric: &str, duration: Duration, tags: &[(&str, &str)])
```

**Purpose**: Records how long an operation took, when telemetry is available. Telemetry means optional measurement data used to understand performance.

**Data flow**: It receives a metric name, a Duration value, and tags that add context such as labels. It asks for the global telemetry recorder. If one exists, it records the duration; if not, it quietly does nothing. It does not return useful data to the caller.

**Call relations**: Tool cache refreshes, tool listing, and server startup tasks call this after timed work finishes. It keeps those callers simple because they do not need to know whether telemetry has been configured.

*Call graph*: called by 4 (write_cached_codex_apps_tools_if_needed, hard_refresh_codex_apps_tools_cache, listed_tools, start_server_task); 1 external calls (global).


##### `tests::stdio_server`  (lines 131–155)

```
fn stdio_server(environment_id: &str) -> McpServerConfig
```

**Purpose**: Builds a sample stdio MCP server configuration for tests. Stdio here means the server is run as a local or remote process that communicates through standard input and output.

**Data flow**: It receives an environment id string. It creates an McpServerConfig that runs the command echo with no arguments, no current working directory, and default settings for the other server options. The returned value is ready for tests to modify or pass into environment resolution.

**Call relations**: The test cases call this helper whenever they need a process-style MCP server. Some tests use it as-is, while others change its cwd or environment id to exercise different branches of resolve_server_environment.

*Call graph*: 2 external calls (new, new).


##### `tests::http_server`  (lines 157–168)

```
fn http_server(environment_id: &str) -> McpServerConfig
```

**Purpose**: Builds a sample HTTP MCP server configuration for tests. HTTP servers are contacted over a URL rather than launched as a stdio process.

**Data flow**: It receives an environment id string. It starts from the stdio test configuration for shared default fields, then replaces the transport with a StreamableHttp configuration pointing at a loopback test URL. The returned config represents an HTTP MCP server.

**Call relations**: Tests use this helper to compare HTTP behavior with stdio behavior. It is especially important for proving that local HTTP can proceed even when no local process runtime is available.

*Call graph*: 1 external calls (stdio_server).


##### `tests::local_stdio_requires_local_stdio_availability`  (lines 171–187)

```
fn local_stdio_requires_local_stdio_availability()
```

**Purpose**: Verifies that a local stdio MCP server is rejected when there is no local environment available. Without this rule, Codex might try to launch a local process when it has no runtime capable of doing so.

**Data flow**: The test creates a runtime context whose EnvironmentManager has no environments. It creates a local stdio server config and asks the context to resolve it. The expected result is an error with the exact message saying a local environment is required.

**Call relations**: This test directly exercises McpRuntimeContext::new and resolve_server_environment using the stdio_server helper. It protects the behavior that make_rmcp_client depends on before starting local process-based MCP servers.

*Call graph*: calls 2 internal fn (new, without_environments); 5 external calls (new, from, assert_eq!, stdio_server, panic!).


##### `tests::local_http_does_not_require_local_stdio_availability`  (lines 190–203)

```
fn local_http_does_not_require_local_stdio_availability()
```

**Purpose**: Verifies the special case that local HTTP MCP servers can be used even when no local stdio environment exists. This matters because HTTP servers may already be running and do not need Codex to spawn a local process.

**Data flow**: The test creates a runtime context with no environments, builds a local HTTP server config, and asks for environment resolution. The expected result is success with no environment returned.

**Call relations**: This test uses McpRuntimeContext::new and the http_server helper to exercise the local HTTP branch of resolve_server_environment. It prevents future changes from accidentally requiring a process runtime for an HTTP connection.

*Call graph*: calls 2 internal fn (new, without_environments); 5 external calls (new, from, assert!, http_server, panic!).


##### `tests::unknown_explicit_environment_is_rejected`  (lines 206–221)

```
fn unknown_explicit_environment_is_rejected()
```

**Purpose**: Verifies that a server naming an environment id that does not exist gets a clear error. This avoids silently running a server somewhere unintended.

**Data flow**: The test creates a runtime context with an empty environment registry. It builds a stdio server that asks for the environment id remote. Resolution is expected to fail with an error naming that unknown id.

**Call relations**: This test calls McpRuntimeContext::new and resolve_server_environment with a config from stdio_server. It guards the error path used when make_rmcp_client receives a configuration pointing at a missing remote environment.

*Call graph*: calls 2 internal fn (new, without_environments); 5 external calls (new, from, assert_eq!, stdio_server, panic!).


##### `tests::explicit_remote_stdio_and_http_accept_named_environment`  (lines 224–251)

```
async fn explicit_remote_stdio_and_http_accept_named_environment()
```

**Purpose**: Verifies that both remote stdio and remote HTTP MCP servers are accepted when their named environment exists. It also confirms that remote stdio works when given an absolute working directory.

**Data flow**: The test creates an EnvironmentManager with a remote test environment and builds a runtime context around it. It makes one remote stdio config, gives it an absolute temporary directory, and also makes a remote HTTP config. Resolving each config should succeed and return an environment.

**Call relations**: This test uses McpRuntimeContext::new, stdio_server, http_server, and the remote test EnvironmentManager setup. It covers the successful path through resolve_server_environment, including the call into ensure_remote_stdio_cwd for stdio.

*Call graph*: calls 2 internal fn (new, create_for_tests); 8 external calls (new, from, assert!, http_server, stdio_server, panic!, temp_dir, unreachable!).


##### `tests::local_stdio_accepts_local_environment_when_available`  (lines 254–267)

```
async fn local_stdio_accepts_local_environment_when_available()
```

**Purpose**: Verifies that a local stdio MCP server is accepted when a local environment is available. This is the normal success case for launching a local process-based MCP server.

**Data flow**: The test creates a runtime context using a default test EnvironmentManager that includes a local environment. It builds a local stdio config and resolves it. The expected result is success with an environment returned.

**Call relations**: This test calls McpRuntimeContext::new and resolve_server_environment with a config from stdio_server. It complements the failure test for missing local runtime and confirms the intended local stdio startup path.

*Call graph*: calls 2 internal fn (new, default_for_tests); 5 external calls (new, from, assert!, stdio_server, panic!).


##### `tests::remote_stdio_requires_absolute_cwd`  (lines 270–295)

```
async fn remote_stdio_requires_absolute_cwd()
```

**Purpose**: Verifies that a remote stdio MCP server is rejected when its working directory is relative. This protects remote execution from ambiguous paths such as relative, whose meaning depends on an unknown starting folder.

**Data flow**: The test creates a runtime context with a remote test environment. It builds a remote stdio config and sets its cwd to the relative path relative. Resolving it should fail with an error that includes the bad path.

**Call relations**: This test drives resolve_server_environment into ensure_remote_stdio_cwd’s error branch. It ensures remote stdio setup fails early with a helpful message instead of reaching make_rmcp_client with an unsafe path.

*Call graph*: calls 2 internal fn (new, create_for_tests); 6 external calls (new, from, assert_eq!, stdio_server, panic!, unreachable!).


### `rmcp-client/src/stdio_server_launcher.rs`

`io_transport` · `MCP server startup, message transport, and shutdown`

An MCP server can be a separate program that reads requests from stdin and writes replies to stdout. This file is the launch pad for those programs. Without it, the client would have to know too much about process details: how to build the environment, where the command runs, how to connect pipes, and how to stop the process later.

The main idea is a small shared interface, `StdioServerLauncher`. One implementation, `LocalStdioServerLauncher`, starts the command directly on the same machine. The other, `ExecutorStdioServerLauncher`, asks an executor service to start the command somewhere else, while still sending and receiving raw bytes as if they were stdin and stdout.

Both launch paths return `StdioServerTransport`, a wrapper that looks like a normal rmcp transport. rmcp is the library that speaks MCP messages; it does not need to care where the process lives. This is like giving someone the same phone handset whether the call is local or routed through another office.

The file also owns cleanup. It keeps a process handle and tries to terminate the MCP server when the transport closes or when the handle is dropped. On Unix it terminates the whole process group, not just the first process, so helper children do not get left behind.

#### Function details

##### `StdioServerTransport::send`  (lines 106–117)

```
fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = std::result::Result<(), Self::Error>> + Send + 'static
```

**Purpose**: Sends one outgoing MCP JSON-RPC message through the launched server's stdin-like channel. It gives rmcp one simple sending method even though the bytes may go to a local process or to an executor-backed process.

**Data flow**: It receives a message from rmcp. It checks which kind of transport is inside the wrapper, then forwards the message unchanged to that transport. The result is a future that finishes successfully if the write worked, or returns an I/O error if it failed.

**Call relations**: This is called by rmcp while the client is talking to an MCP server. The function does not interpret the message; it only passes it to either the local child-process transport or the executor process transport.


##### `StdioServerTransport::receive`  (lines 119–127)

```
fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send
```

**Purpose**: Waits for the next incoming MCP JSON-RPC message from the launched server's stdout-like channel. It lets rmcp read responses the same way for both local and executor-started servers.

**Data flow**: It reads from the wrapped transport. For a local process, that means the child's stdout stream; for an executor process, that means bytes delivered by the executor and adapted back into rmcp's expected stream. It returns the next message if one arrives, or `None` if the stream ends.

**Call relations**: This is used by rmcp during normal MCP conversations. It delegates to the concrete transport and keeps the rest of the client from knowing whether the server is nearby or remote.


##### `StdioServerTransport::close`  (lines 129–135)

```
async fn close(&mut self) -> std::result::Result<(), Self::Error>
```

**Purpose**: Closes the connection to the MCP server and asks the server process to stop. This prevents background server processes from being left running after the client is finished.

**Data flow**: It starts with an open transport and its stored process handle. It first calls the process handle's termination method, then closes the underlying local or executor transport. It returns success or an I/O error if cleanup fails.

**Call relations**: rmcp or client shutdown code calls this when the MCP session is over. It hands off process cleanup to `StdioServerProcessHandle::terminate`, then lets the underlying transport finish its own close work.

*Call graph*: calls 1 internal fn (terminate).


##### `StdioServerTransport::process_handle`  (lines 139–141)

```
fn process_handle(&self) -> StdioServerProcessHandle
```

**Purpose**: Returns a clone of the process handle for the launched MCP server. Other code can keep this handle if it needs a way to terminate the server separately from the transport object.

**Data flow**: It reads the stored process handle and clones the lightweight shared reference. The returned handle points to the same underlying process state; it does not start a new process.

**Call relations**: This is used by code that needs lifecycle control over the server process. It fits alongside `close`: `close` uses the handle internally, while this function lets outside code hold the same kind of handle.

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

**Purpose**: Builds the command description used to start an MCP stdio server. It gathers the program name, arguments, environment settings, and working directory into one object.

**Data flow**: It receives the raw command parts from higher-level MCP client setup. It stores them without launching anything. The result is a `StdioServerCommand` that a launcher can later turn into a real process.

**Call relations**: This is called by `new_stdio_client` when the client is being prepared. The resulting command is passed to either a local or executor launcher, depending on where the server should run.

*Call graph*: called by 1 (new_stdio_client).


##### `LocalStdioServerLauncher::new`  (lines 181–183)

```
fn new(fallback_cwd: PathBuf) -> Self
```

**Purpose**: Creates a launcher that starts MCP servers as child processes on the local machine. The fallback working directory is kept for configurations that do not specify one.

**Data flow**: It receives a path to use as the default current directory. It stores that path in the launcher. The returned launcher can later start configured MCP server commands locally.

**Call relations**: Client construction code and tests call this when they want local MCP server behavior. Later, `LocalStdioServerLauncher::launch` uses the saved fallback directory if the server command lacks its own `cwd`.

*Call graph*: called by 4 (make_rmcp_client, drop_kills_wrapper_process_group, shutdown_kills_initialized_stdio_server_with_in_flight_operation, rmcp_client_can_list_and_read_resources).


##### `LocalStdioServerLauncher::launch`  (lines 187–193)

```
fn launch(
        &self,
        command: StdioServerCommand,
    ) -> BoxFuture<'static, io::Result<StdioServerTransport>>
```

**Purpose**: Starts the asynchronous launch flow for a local MCP stdio server. It adapts the launcher's stored settings to the shared `StdioServerLauncher` interface.

**Data flow**: It receives a `StdioServerCommand` and copies the launcher's fallback working directory. It returns a boxed future; when that future runs, it calls the local launch helper and produces a `StdioServerTransport` or an I/O error.

**Call relations**: Higher-level MCP lifecycle code calls this through the shared launcher trait. It hands the actual work to `LocalStdioServerLauncher::launch_server` so the trait method stays small.

*Call graph*: 2 external calls (clone, launch_server).


##### `LocalStdioServerLauncher::launch_server`  (lines 237–296)

```
fn launch_server(
        command: StdioServerCommand,
        fallback_cwd: PathBuf,
    ) -> io::Result<StdioServerTransport>
```

**Purpose**: Actually starts a local MCP server process and connects its stdin and stdout to rmcp. It also starts reading the server's stderr so diagnostic messages are logged instead of disappearing.

**Data flow**: It takes a command description and a fallback directory. It builds the environment, chooses the working directory, resolves the program path, configures piped stdin/stdout/stderr, and spawns the child process. It returns a `StdioServerTransport` containing the child-process transport and a handle that can terminate it.

**Call relations**: This is called by `LocalStdioServerLauncher::launch`. It uses environment-building utilities, program resolution, `TokioChildProcess` for async process pipes, and `StdioServerProcessHandle::local` for cleanup. A background task logs each stderr line from the server.

*Call graph*: calls 3 internal fn (resolve, local, create_env_for_mcp_server); 10 external calls (new, piped, builder, new, info!, kill_on_drop, process_group, Local, spawn, warn!).


##### `LocalProcessTerminator::new`  (lines 300–316)

```
fn new(process_group_id: u32) -> Self
```

**Purpose**: Creates the small platform-specific object used to stop a local MCP server later. On Unix it records a process group id; on Windows it records a process id.

**Data flow**: It receives the numeric id returned for the spawned process. It stores that id in the form needed by the current operating system. The result is a terminator object that can later be called during shutdown.

**Call relations**: Local process launch code creates this right after spawning the server. It is stored inside `StdioServerProcessHandle::local`, which later calls its termination method.


##### `LocalProcessTerminator::terminate`  (lines 352–352)

```
fn terminate(&self)
```

**Purpose**: Stops a local MCP server process, using the operating system's best available method. This is important because MCP servers may spawn helper processes that also need to be cleaned up.

**Data flow**: It reads the stored process or process-group id. On Unix it asks the process group to terminate, then schedules a stronger kill after a short grace period if the group still exists. On Windows it runs `taskkill` to stop the process tree. It does not return data.

**Call relations**: This is called by `StdioServerProcessHandle::terminate` and by the drop cleanup path. It is the final local-process cleanup step after the transport decides the MCP server should stop.

*Call graph*: calls 1 internal fn (terminate_process_group); 4 external calls (null, new, spawn, warn!).


##### `StdioServerProcessHandle::local`  (lines 356–364)

```
fn local(program_name: String, terminator: Option<LocalProcessTerminator>) -> Self
```

**Purpose**: Builds a shared process handle for a locally started MCP server. The handle remembers the server name and, if available, how to terminate the local process.

**Data flow**: It receives the program name and an optional local terminator. It wraps them in shared state with a flag saying the process has not yet been terminated. The result is a cloneable handle pointing to that shared state.

**Call relations**: This is called by `LocalStdioServerLauncher::launch_server` after the child process is spawned. The returned handle is stored in `StdioServerTransport` so close and drop cleanup can stop the process.

*Call graph*: called by 1 (launch_server); 3 external calls (new, new, Local).


##### `StdioServerProcessHandle::executor`  (lines 366–374)

```
fn executor(program_name: String, process: Arc<dyn ExecProcess>) -> Self
```

**Purpose**: Builds a shared process handle for an MCP server started through the executor API. The handle keeps the executor process object so it can ask the executor to terminate the remote process later.

**Data flow**: It receives the program name and a shared executor process object. It stores them with a not-yet-terminated flag in shared state. The result is a cloneable handle for remote-process cleanup.

**Call relations**: This is called by `ExecutorStdioServerLauncher::launch_server` after the executor reports that the process has started. The handle is stored in the returned transport and used during close or drop cleanup.

*Call graph*: called by 1 (launch_server); 3 external calls (new, new, Executor).


##### `StdioServerProcessHandle::terminate`  (lines 376–395)

```
async fn terminate(&self) -> io::Result<()>
```

**Purpose**: Terminates the MCP server process represented by this handle, but only once. The once-only behavior avoids sending duplicate shutdown requests from multiple cloned handles.

**Data flow**: It checks and flips an atomic boolean, which is a thread-safe flag. If another caller already terminated the process, it returns success immediately. Otherwise it calls the local terminator, does nothing if no local terminator exists, or awaits the executor process termination. If executor termination fails, it resets the flag and returns an I/O error.

**Call relations**: This is called by `StdioServerTransport::close`. It is also mirrored by the drop cleanup logic in `StdioServerProcessHandleInner::drop`, so processes are cleaned up even if explicit close is missed.

*Call graph*: called by 1 (close); 1 external calls (other).


##### `StdioServerProcessHandleInner::drop`  (lines 399–429)

```
fn drop(&mut self)
```

**Purpose**: Acts as a safety net that tries to stop the MCP server when the last process handle is discarded. This protects against process leaks if normal shutdown does not happen.

**Data flow**: When the shared inner handle is being destroyed, it checks the terminated flag. If cleanup already happened, it does nothing. For a local process it calls the local terminator. For an executor process it tries to find the current Tokio runtime, which is the async task runner, and schedules an async termination request; if no runtime is available, it logs a warning.

**Call relations**: This runs automatically when Rust drops the final shared process handle. It complements explicit calls to `StdioServerProcessHandle::terminate` and is especially important for unexpected shutdown paths.

*Call graph*: 5 external calls (clone, swap, drop, try_current, warn!).


##### `ExecutorStdioServerLauncher::new`  (lines 446–448)

```
fn new(exec_backend: Arc<dyn ExecBackend>) -> Self
```

**Purpose**: Creates a launcher that starts MCP servers through the executor process API. The executor backend is the service object that knows how to start and stop those remote or delegated processes.

**Data flow**: It receives a shared executor backend and stores it in the launcher. The returned launcher can later convert MCP server commands into executor start requests.

**Call relations**: Client setup code calls this when MCP servers should be placed through the executor instead of being spawned directly. Later, `ExecutorStdioServerLauncher::launch` uses the stored backend.

*Call graph*: called by 1 (make_rmcp_client).


##### `ExecutorStdioServerLauncher::launch`  (lines 452–458)

```
fn launch(
        &self,
        command: StdioServerCommand,
    ) -> BoxFuture<'static, io::Result<StdioServerTransport>>
```

**Purpose**: Starts the asynchronous launch flow for an executor-backed MCP stdio server. It adapts executor launching to the same `StdioServerLauncher` interface used by local launching.

**Data flow**: It receives a `StdioServerCommand` and clones the shared executor backend. It returns a boxed future; when run, that future asks `launch_server` to start the process and build the transport.

**Call relations**: Higher-level MCP lifecycle code calls this through the shared launcher trait. It hands the real work to `ExecutorStdioServerLauncher::launch_server`.

*Call graph*: 2 external calls (clone, launch_server).


##### `ExecutorStdioServerLauncher::launch_server`  (lines 466–519)

```
async fn launch_server(
        command: StdioServerCommand,
        exec_backend: Arc<dyn ExecBackend>,
    ) -> io::Result<StdioServerTransport>
```

**Purpose**: Starts an MCP stdio server through the executor API and wraps it in a transport rmcp can use. It keeps MCP parsing in the client while the executor only runs the process and moves raw bytes.

**Data flow**: It takes the command description and executor backend. It requires an explicit working directory, builds a remote environment overlay, converts command parts and environment keys to Unicode strings required by the executor protocol, turns the working directory into a URI, chooses a process id, and sends a start request. If the process starts, it returns a `StdioServerTransport` backed by `ExecutorProcessTransport` plus a process handle for termination.

**Call relations**: This is called by `ExecutorStdioServerLauncher::launch`. It uses helper functions in this file to prepare argv, environment, and environment policy, then calls the executor backend. It creates `StdioServerProcessHandle::executor` so later close or drop can stop the remote process.

*Call graph*: calls 6 internal fn (new, next_process_id, executor, create_env_overlay_for_remote_mcp_server, remote_mcp_env_var_names, from_path); 6 external calls (clone, process_api_argv, process_api_env, remote_env_policy, other, Executor).


##### `ExecutorStdioServerLauncher::process_api_argv`  (lines 521–534)

```
fn process_api_argv(program: &OsString, args: &[OsString]) -> Result<Vec<String>>
```

**Purpose**: Converts the program and its arguments into the string list required by the executor process API. It rejects values that are not valid Unicode, because the remote protocol cannot carry arbitrary operating-system strings.

**Data flow**: It receives the program name and argument list as `OsString` values. It converts the program first, then each argument, into ordinary Rust `String` values. It returns the completed argv list or an error naming the invalid part.

**Call relations**: This is used inside `ExecutorStdioServerLauncher::launch_server` before the executor start request is sent. It relies on `os_string_to_process_api_string` for each individual conversion.

*Call graph*: 4 external calls (clone, len, os_string_to_process_api_string, with_capacity).


##### `ExecutorStdioServerLauncher::process_api_env`  (lines 536–545)

```
fn process_api_env(env: HashMap<OsString, OsString>) -> Result<HashMap<String, String>>
```

**Purpose**: Converts environment variables into the plain string map required by the executor process API. This makes sure both variable names and values can be safely sent through the remote protocol.

**Data flow**: It receives a map whose keys and values are operating-system strings. For each pair, it converts the name and value to Unicode strings. It returns a new string-to-string map, or an error if any name or value cannot be represented.

**Call relations**: This is used by `ExecutorStdioServerLauncher::launch_server` while preparing the executor start request. Like argv conversion, it depends on `os_string_to_process_api_string` for the actual Unicode check.


##### `ExecutorStdioServerLauncher::os_string_to_process_api_string`  (lines 547–551)

```
fn os_string_to_process_api_string(value: OsString, label: &str) -> Result<String>
```

**Purpose**: Converts one operating-system string into a normal Unicode string for the executor API. It gives a clear error message when the value cannot be sent remotely.

**Data flow**: It receives an `OsString` and a label such as `command` or `environment variable value`. It tries to turn the value into a `String`. On success it returns the string; on failure it returns an error that includes the label.

**Call relations**: This helper is called by the executor argv and environment conversion functions. It centralizes the rule that remote MCP stdio data must be valid Unicode.

*Call graph*: 1 external calls (into_string).


##### `ExecutorStdioServerLauncher::remote_env_policy`  (lines 553–578)

```
fn remote_env_policy(remote_env_vars: &[String]) -> ExecEnvPolicy
```

**Purpose**: Builds the executor environment policy for a remote MCP server. The policy decides which environment variables the executor process may inherit from its own machine.

**Data flow**: It receives the names of environment variables that should be read from the remote executor side. If none are requested, it uses only the executor's core environment and leaves the include-only filter empty. If remote variables are requested, it allows inheritance from all variables but then narrows the actual child environment to default safe variables plus the requested names.

**Call relations**: This is used by `ExecutorStdioServerLauncher::launch_server` when creating the executor start parameters. The tests in this file call it directly to confirm that requested remote variables are included and unrequested secrets are filtered out.

*Call graph*: called by 3 (remote_env_policy_effectively_filters_unrequested_vars, remote_env_policy_includes_remote_source_vars_without_full_env, remote_env_policy_uses_core_env_without_remote_source_vars); 2 external calls (new, new).


##### `tests::remote_env_policy_uses_core_env_without_remote_source_vars`  (lines 589–594)

```
fn remote_env_policy_uses_core_env_without_remote_source_vars()
```

**Purpose**: Checks the simple case where no remote-sourced environment variables are requested. The expected behavior is to inherit only the executor's core environment.

**Data flow**: It calls `remote_env_policy` with an empty list. It then verifies that the policy uses `Core` inheritance and has no include-only filter entries.

**Call relations**: This test protects the default remote-launch behavior. It makes sure the executor path does not broaden environment inheritance when no remote variables are needed.

*Call graph*: calls 1 internal fn (remote_env_policy); 2 external calls (assert!, assert_eq!).


##### `tests::remote_env_policy_includes_remote_source_vars_without_full_env`  (lines 597–611)

```
fn remote_env_policy_includes_remote_source_vars_without_full_env()
```

**Purpose**: Checks that a requested remote environment variable is made available without blindly passing every remote variable through. This matters for secrets: only named variables should reach the MCP server.

**Data flow**: It calls `remote_env_policy` with `REMOTE_TOKEN`. It verifies that the policy switches to `All` inheritance so the named remote variable can be seen by the filter, and that the include-only list contains both the requested variable and the standard default variables.

**Call relations**: This test exercises the special branch in `remote_env_policy` for remote-sourced variables. It confirms the intended balance: broad enough to find requested variables, narrow enough to filter the final child environment.

*Call graph*: calls 1 internal fn (remote_env_policy); 2 external calls (assert!, assert_eq!).


##### `tests::remote_env_policy_effectively_filters_unrequested_vars`  (lines 614–653)

```
fn remote_env_policy_effectively_filters_unrequested_vars()
```

**Purpose**: Checks the end result of applying the remote environment policy to a sample executor environment. It proves that unrequested secret variables do not reach the MCP server.

**Data flow**: It builds an executor policy requesting `REMOTE_TOKEN`, converts it into the shell environment policy type used by the environment builder, and applies it to sample variables including `PATH`, `REMOTE_TOKEN`, and `UNREQUESTED_SECRET`. It verifies that `PATH` and `REMOTE_TOKEN` remain, while `UNREQUESTED_SECRET` is absent.

**Call relations**: This test connects `remote_env_policy` to the real environment-filtering code from `shell_environment`. It guards against policy changes that would accidentally leak unrelated remote environment variables.

*Call graph*: calls 2 internal fn (create_env_from_vars, remote_env_policy); 2 external calls (assert!, assert_eq!).


### `codex-mcp/src/rmcp_client.rs`

`orchestration` · `startup, tool listing, shutdown`

An MCP server is an outside service that can offer tools to Codex. This file is the “connection starter” for one such server. Without it, Codex would not know how to launch a local MCP process, connect to a remote HTTP MCP server, ask what tools it provides, or keep useful startup information available while the server is still warming up.

The main shape is a two-layer client. `AsyncManagedClient` represents a client that may still be starting. It can return cached tool information early, like showing yesterday’s menu while the kitchen is still opening. Once startup finishes, it yields a `ManagedClient`, which contains the live RMCP client, server details, filtered tool list, timeout settings, and capability flags.

Startup follows a careful sequence. The server name is checked for safe characters. The file creates either a standard-input/standard-output client for a launched process, or a streamable HTTP client for a remote server. It initializes the MCP protocol, records whether the server supports Codex-specific sandbox metadata, asks the server for tools, removes or preserves connector metadata depending on trust, normalizes Codex Apps tool names, writes cache entries when useful, and applies configured tool filters.

It also handles cancellation and shutdown. If startup is cancelled, callers get a clear `StartupOutcomeError::Cancelled`; other failures are converted into cloneable error text so shared startup futures can be reused safely.

#### Function details

##### `ManagedClient::listed_tools`  (lines 101–124)

```
fn listed_tools(&self) -> Vec<ToolInfo>
```

**Purpose**: Returns the tool list for a fully started client. For Codex Apps, it first tries to use a fresh cache so tool listing can be faster, then applies the server’s configured tool filter.

**Data flow**: It reads the client’s cache context, stored tools, and tool filter. If a Codex Apps tools cache entry is found, it records a cache-hit timing metric and filters the cached tools. If there is no usable cache, it records a miss when relevant and returns the already stored tool list.

**Call relations**: This is used after `AsyncManagedClient::client` has produced a live `ManagedClient`. `AsyncManagedClient::listed_tools` calls into it when startup has completed and it wants the current live view of tools rather than a startup snapshot.

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

**Purpose**: Creates an asynchronously starting MCP client. It immediately prepares cached startup information if available, then launches the real startup work in a shared future that other code can await.

**Data flow**: It receives the server name, server configuration, authentication settings, cancellation token, event channel, elicitation support, cache context, plugin provenance, runtime context, and client capabilities. It derives the tool filter, loads any cached tool and server snapshots, starts an async sequence that validates the name, builds the RMCP client, initializes the server, and marks startup as complete. It returns an `AsyncManagedClient` that can be queried while startup is still running.

**Call relations**: This is the constructor used by higher-level connection setup code. Inside its startup future it calls `validate_mcp_server_name`, then `make_rmcp_client`, then `start_server_task`. If cached tools exist, it also spawns the startup task in the background so the live connection continues warming up even before someone awaits it.

*Call graph*: calls 6 internal fn (load_startup_cached_codex_apps_server_info, load_startup_cached_codex_apps_tools_snapshot, make_rmcp_client, start_server_task, validate_mcp_server_name, configured_config); called by 1 (new); 6 external calls (clone, new, new, clone, clone, spawn).


##### `AsyncManagedClient::client`  (lines 239–241)

```
async fn client(&self) -> Result<ManagedClient, StartupOutcomeError>
```

**Purpose**: Waits for the asynchronous startup work and returns the finished managed client or a startup error. It gives callers one simple doorway to the eventual live connection.

**Data flow**: It reads the shared startup future stored in the object, clones that shared handle, awaits it, and returns the resulting `ManagedClient` or `StartupOutcomeError`. It does not change the client itself.

**Call relations**: Both `AsyncManagedClient::listed_tools` and `AsyncManagedClient::shutdown` use this when they need to know whether startup has finished and what live client, if any, resulted.

*Call graph*: called by 2 (listed_tools, shutdown); 1 external calls (clone).


##### `AsyncManagedClient::shutdown`  (lines 243–252)

```
async fn shutdown(&self)
```

**Purpose**: Stops this MCP client as cleanly as possible. It cancels any in-progress startup and, if a client did start, asks the underlying RMCP client to shut down.

**Data flow**: It sends cancellation through the stored cancellation token. Then it awaits `client()`: if startup succeeded, it calls shutdown on the live RMCP client; if startup was cancelled, it quietly finishes; if startup failed for another reason, it logs a warning.

**Call relations**: This is called during teardown. It depends on `AsyncManagedClient::client` to discover whether there is a live connection to close, and it deliberately treats cancellation as a normal shutdown path.

*Call graph*: calls 1 internal fn (client); 2 external calls (cancel, warn!).


##### `AsyncManagedClient::cached_tool_info_snapshot_while_initializing`  (lines 254–259)

```
fn cached_tool_info_snapshot_while_initializing(&self) -> Option<Vec<ToolInfo>>
```

**Purpose**: Returns cached tool information only while startup is still in progress. This lets the rest of the system show tools early without confusing old cache data for final live data.

**Data flow**: It checks the atomic startup-complete flag, which is a small thread-safe boolean. If startup is not complete, it clones and returns the cached tool snapshot. If startup has completed, it returns nothing.

**Call relations**: This helper is used by `AsyncManagedClient::listed_tools`. It is the guardrail that decides when cached startup data is acceptable and when the code should move on to the real client result.

*Call graph*: called by 1 (listed_tools).


##### `AsyncManagedClient::listed_tools`  (lines 261–324)

```
async fn listed_tools(&self) -> Option<Vec<ToolInfo>>
```

**Purpose**: Returns the best available tool list for an asynchronously starting client. It may use cached tools during startup, live tools after startup, or fallback cached tools if startup failed.

**Data flow**: It first defines a local annotation step that adds plugin display names and plugin source notes to tool descriptions, and makes Codex Apps input schemas visible to the model. It then chooses tools: cached snapshot if still initializing, live `ManagedClient::listed_tools` if startup succeeds, or cached snapshot if startup fails. Finally it annotates the chosen tools and returns them, or returns nothing if no tool data is available.

**Call relations**: This is the read path used by code that wants to show or use tools without caring whether startup has fully completed. It calls `cached_tool_info_snapshot_while_initializing` first, then may call `client`; after the tools are selected, it consults plugin provenance to add human-facing plugin context.

*Call graph*: calls 2 internal fn (cached_tool_info_snapshot_while_initializing, client).


##### `StartupOutcomeError::from`  (lines 338–342)

```
fn from(error: anyhow::Error) -> Self
```

**Purpose**: Converts a general error into this file’s cloneable startup error type. This matters because the startup result is shared, and the usual rich error type cannot be cloned safely.

**Data flow**: It receives an `anyhow::Error`, turns it into plain text, and stores that text inside `StartupOutcomeError::Failed`. The detailed original error object is not kept.

**Call relations**: Startup helpers use this conversion whenever a lower-level operation fails. It lets `AsyncManagedClient::new`, `start_server_task`, and `make_rmcp_client` all report failures through the same shared error shape.

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

**Purpose**: Asks a live MCP server for its tools without using the tools cache. It also turns raw RMCP tool records into Codex’s richer `ToolInfo` records.

**Data flow**: It receives a server name, RMCP client, optional timeout, and optional server instructions. It calls the server’s tool-list API, then for each tool sanitizes connector metadata, normalizes names and titles for Codex Apps when needed, chooses a namespace description, and builds a `ToolInfo`. For the Codex Apps server, it removes disallowed tools before returning the list.

**Call relations**: `start_server_task` uses this during normal startup after initialization. A cache-refresh path also calls it when it needs a fresh server read rather than cached tool data.

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

**Purpose**: Decides whether connector metadata on a tool should be trusted. Codex Apps metadata is preserved, while similar metadata from other MCP servers is stripped to avoid trusting labels that only Codex Apps is allowed to define.

**Data flow**: It receives the server name, a mutable tool, and optional connector ID, name, and description. If the server is the trusted Codex Apps server, it returns those values unchanged. Otherwise it removes known connector metadata keys from the tool’s metadata and returns `None` for all connector fields.

**Call relations**: `list_tools_for_client_uncached` calls this for every raw tool before creating `ToolInfo`. The test functions call it directly to prove that custom MCP servers lose untrusted connector metadata while Codex Apps keeps it.

*Call graph*: calls 1 internal fn (strip_untrusted_connector_meta); called by 2 (codex_apps_connector_metadata_is_preserved, custom_mcp_connector_metadata_is_stripped).


##### `strip_untrusted_connector_meta`  (lines 425–429)

```
fn strip_untrusted_connector_meta(tool: &mut RmcpTool)
```

**Purpose**: Removes specific connector-related metadata keys from a tool. This prevents ordinary MCP servers from presenting themselves with Codex Apps connector labels.

**Data flow**: It receives a mutable RMCP tool. If the tool has metadata, it keeps only entries whose keys are not in the untrusted connector-key list. The tool is changed in place; nothing is returned.

**Call relations**: `sanitize_tool_connector_metadata` calls this whenever the tool came from a server other than Codex Apps. It is the small cleanup step that enforces the trust boundary.

*Call graph*: called by 1 (sanitize_tool_connector_metadata).


##### `is_untrusted_connector_meta_key`  (lines 431–433)

```
fn is_untrusted_connector_meta_key(key: &str) -> bool
```

**Purpose**: Checks whether a metadata key is one of the connector keys that should not be trusted from general MCP servers.

**Data flow**: It receives a metadata key string and compares it with the fixed list of blocked connector metadata keys. It returns true if the key should be removed, otherwise false.

**Call relations**: This helper is used inside the metadata filtering performed by `strip_untrusted_connector_meta`. It centralizes the exact key list so the stripping rule stays consistent.


##### `resolve_bearer_token`  (lines 435–460)

```
fn resolve_bearer_token(
    server_name: &str,
    bearer_token_env_var: Option<&str>,
) -> Result<Option<String>>
```

**Purpose**: Reads an HTTP bearer token from an environment variable when a server configuration asks for one. A bearer token is a secret string used as proof of authorization for a remote request.

**Data flow**: It receives the server name and an optional environment-variable name. If no variable is configured, it returns no token. If a variable is configured, it reads it from the process environment, rejects missing, empty, or non-Unicode values with a clear error, and returns the token string when valid.

**Call relations**: `make_rmcp_client` calls this before creating a streamable HTTP client. That keeps secret lookup close to the HTTP transport setup and gives startup a useful error if the expected secret is unavailable.

*Call graph*: called by 1 (make_rmcp_client); 2 external calls (anyhow!, var).


##### `validate_mcp_server_name`  (lines 462–471)

```
fn validate_mcp_server_name(server_name: &str) -> Result<()>
```

**Purpose**: Checks that an MCP server name contains only letters, numbers, underscores, and hyphens. This keeps server names predictable and safe for later use in routing, cache keys, and display.

**Data flow**: It receives a server-name string, builds a regular expression for the allowed pattern, and tests the name. It returns success for a valid name or an error explaining the required pattern for an invalid one.

**Call relations**: `AsyncManagedClient::new` calls this at the start of the startup future, before any process is launched or network connection is made. That means bad names fail early.

*Call graph*: called by 1 (new); 2 external calls (anyhow!, new).


##### `start_server_task`  (lines 473–551)

```
async fn start_server_task(
    server_name: String,
    client: Arc<RmcpClient>,
    params: StartServerTaskParams,
) -> Result<ManagedClient, StartupOutcomeError>
```

**Purpose**: Performs the actual MCP startup conversation after a transport client has been created. It initializes the server, fetches tools, records metrics, writes caches, applies filters, and returns the ready `ManagedClient`.

**Data flow**: It receives the server name, RMCP client, timeouts, tool filter, event sender, elicitation manager, cache context, and elicitation capability. It builds MCP initialization parameters, creates a path for server elicitation requests, initializes the server, detects Codex sandbox metadata support, fetches uncached tools, records timing metrics, converts server info, writes Codex Apps cache data if needed, filters the tools, and returns a populated `ManagedClient`.

**Call relations**: `AsyncManagedClient::new` calls this after `make_rmcp_client` succeeds. It hands off to `list_tools_for_client_uncached` to ask for tools, to `mcp_server_info_from_implementation` to reshape server identity data, and to cache/filter helpers so the final managed client is ready for ordinary use.

*Call graph*: calls 5 internal fn (write_cached_codex_apps_tools_if_needed, list_tools_for_client_uncached, mcp_server_info_from_implementation, emit_duration, filter_tools); called by 1 (new); 6 external calls (clone, default, new, new, now, env!).


##### `mcp_server_info_from_implementation`  (lines 553–567)

```
fn mcp_server_info_from_implementation(server_info: Implementation) -> McpServerInfo
```

**Purpose**: Converts RMCP’s server identity record into Codex’s protocol-facing server info record. This gives the rest of Codex a stable shape for server name, title, version, description, icons, and website URL.

**Data flow**: It receives an RMCP `Implementation` object from initialization. It copies the simple fields directly, converts any icons into JSON values when possible, drops icons that cannot be serialized, and returns an `McpServerInfo`.

**Call relations**: `start_server_task` calls this immediately after initialization and tool fetching. The result is stored in `ManagedClient` and may also be written into Codex Apps startup cache data.

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

**Purpose**: Builds the low-level RMCP client using the transport configured for the server. It chooses between launching a process over standard input/output and connecting to a streamable HTTP endpoint.

**Data flow**: It receives the server name, effective server configuration, OAuth and keyring settings, runtime context, and optional auth provider. It resolves the server’s runtime environment, checks whether it is local, then inspects the transport configuration. For stdio, it prepares command, arguments, environment, working directory, and the right launcher. For HTTP, it selects an HTTP client, resolves any bearer token, and passes authentication settings along. It returns a ready `RmcpClient` or a startup error.

**Call relations**: `AsyncManagedClient::new` calls this before `start_server_task`. It also calls `resolve_bearer_token` for HTTP servers and uses runtime-context methods to decide whether execution should happen locally or through an executor-backed environment.

*Call graph*: calls 8 internal fn (resolve_bearer_token, local_stdio_fallback_cwd, resolve_server_environment, launch, new_stdio_client, new_streamable_http_client, new, new); called by 1 (new); 2 external calls (new, unreachable!).


##### `tests::tool_with_connector_meta`  (lines 671–693)

```
fn tool_with_connector_meta() -> RmcpTool
```

**Purpose**: Builds a sample RMCP tool containing connector metadata for tests. The sample includes both metadata that should be stripped and metadata that should be kept.

**Data flow**: It creates a tool named `capture_file_upload`, adds a JSON metadata object with connector IDs, names, descriptions, future connector-looking keys, an OpenAI file parameter key, and a custom key, then returns that tool.

**Call relations**: The two connector-metadata tests call this helper to start from the same realistic tool shape. That keeps the tests focused on what `sanitize_tool_connector_metadata` changes.

*Call graph*: 5 external calls (new, default, new, Meta, json!).


##### `tests::custom_mcp_connector_metadata_is_stripped`  (lines 696–729)

```
fn custom_mcp_connector_metadata_is_stripped()
```

**Purpose**: Verifies that connector metadata from a non-Codex Apps MCP server is not trusted. This protects Codex from treating arbitrary servers as if they supplied official connector information.

**Data flow**: It creates the sample tool, calls `sanitize_tool_connector_metadata` with a normal server name and connector fields, and checks that the returned connector fields are all gone. It then checks the tool metadata: known untrusted connector keys are removed, while unrelated or future-looking keys remain.

**Call relations**: This test directly exercises `sanitize_tool_connector_metadata`, which calls `strip_untrusted_connector_meta`. It documents the expected behavior for custom MCP servers.

*Call graph*: calls 1 internal fn (sanitize_tool_connector_metadata); 3 external calls (assert!, assert_eq!, tool_with_connector_meta).


##### `tests::codex_apps_connector_metadata_is_preserved`  (lines 732–760)

```
fn codex_apps_connector_metadata_is_preserved()
```

**Purpose**: Verifies that connector metadata from the trusted Codex Apps MCP server is preserved. Codex Apps needs this metadata so tools can be grouped and described by connector.

**Data flow**: It creates the sample tool, calls `sanitize_tool_connector_metadata` using the Codex Apps server name, and checks that the connector ID, name, and description are returned unchanged. It also checks that all connector-related metadata keys remain on the tool.

**Call relations**: This test covers the trusted branch of `sanitize_tool_connector_metadata`. Together with the custom-server test, it defines the file’s connector metadata trust rule.

*Call graph*: calls 1 internal fn (sanitize_tool_connector_metadata); 3 external calls (assert!, assert_eq!, tool_with_connector_meta).


### `mcp-server/src/lib.rs`

`entrypoint` · `startup, main loop, shutdown`

This file is the front door for the MCP server. MCP, or Model Context Protocol, is a way for a client and a tool server to talk using structured JSON messages. This server communicates over standard input and standard output, which means another program can launch it and exchange one JSON message per line, like passing notes through two pipes.

At startup, the file reads command-line configuration overrides, builds the main Codex configuration, sets telemetry and analytics behavior, opens the state database, and prepares an execution environment for running Codex tools. It also sets up tracing and OpenTelemetry, which are systems for recording logs, traces, and metrics so operators can understand what the server is doing.

After setup, it creates three asynchronous tasks. One reads lines from stdin and turns each line into a JSON-RPC message. Another receives those messages and asks `MessageProcessor` to deal with requests, responses, notifications, or errors. The last takes outgoing messages, turns them back into JSON, and writes them to stdout. The channels between these tasks act like conveyor belts: input comes in, processing happens in the middle, and output leaves on the other side.

Shutdown is simple and important. When stdin reaches the end of file, the input task stops, which closes the channel, which lets the processor stop, which then lets the output writer stop. Without this file, the lower-level MCP and Codex logic would exist, but there would be no running server loop connecting it to the outside world.

#### Function details

##### `run_main`  (lines 59–203)

```
async fn run_main(
    arg0_paths: Arg0DispatchPaths,
    cli_config_overrides: CliConfigOverrides,
    strict_config: bool,
) -> IoResult<()>
```

**Purpose**: Starts and runs the MCP server. It prepares configuration, telemetry, database state, and execution support, then runs the read-process-write loop that lets an external client talk to Codex over JSON-RPC.

**Data flow**: It receives launch-time inputs: paths discovered from the program name, command-line configuration overrides, and whether configuration parsing should be strict. It turns those into a Codex configuration, initializes telemetry and state storage, creates an execution environment, and opens message channels. Incoming text lines from stdin become parsed JSON-RPC messages, those messages are processed by `MessageProcessor`, and outgoing replies are serialized back to JSON lines on stdout. It returns success when the server shuts down cleanly, or an I/O error if setup fails.

**Call relations**: This is the main coordinator for the file. Early in startup it calls configuration, telemetry, installation, and environment setup helpers such as `build_provider`, `record_process_start`, `install_sqlite_telemetry`, `from_optional_paths`, `from_codex_home`, and `set_default_client_residency_requirement`. During the main loop it creates a `MessageProcessor`, then feeds incoming requests, responses, notifications, and errors into that processor. It also hands outgoing messages to the stdout writer task so replies can reach the client.

*Call graph*: calls 9 internal fn (new, new, build_provider, install_sqlite_telemetry, record_process_start, from_codex_home, from_optional_paths, set_default_client_residency_requirement, parse_overrides); 17 external calls (new, new, from_default_env, init_state_db, resolve_installation_id, default, debug!, env!, error!, info! (+7 more)).


##### `tests::mcp_server_defaults_analytics_to_enabled`  (lines 215–217)

```
fn mcp_server_defaults_analytics_to_enabled()
```

**Purpose**: Checks that this server treats analytics as enabled by default. This protects an intentional product decision from being changed accidentally.

**Data flow**: It reads the file-level default analytics constant and compares it with `true`. Nothing is changed; the test either passes if the value is still enabled or fails if someone changed the default.

**Call relations**: This test directly supports the startup behavior in `run_main`, because `run_main` passes the default analytics setting into telemetry setup. It uses an assertion to lock down that default.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::mcp_server_builds_otel_provider_with_logs_traces_and_metrics`  (lines 220–254)

```
async fn mcp_server_builds_otel_provider_with_logs_traces_and_metrics() -> anyhow::Result<()>
```

**Purpose**: Checks that the server can build an OpenTelemetry provider with all three observability outputs: logs, traces, and metrics. OpenTelemetry is a standard way to export runtime information to monitoring tools.

**Data flow**: It creates a temporary Codex home directory, builds a test configuration, and fills in OpenTelemetry exporters for logs, traces, and metrics. It then calls `build_provider` with the same service name and analytics default used by the real server. The result is inspected to make sure logger, tracer, and metrics components exist, and then the provider is shut down.

**Call relations**: This test mirrors the telemetry setup path used by `run_main`. It calls `build_provider` directly and uses assertions to confirm that the server will be able to emit the observability data that `run_main` installs during startup.

*Call graph*: calls 1 internal fn (build_provider); 4 external calls (new, new, assert!, default).


### Protocol bridge utilities
These files provide small dedicated sidecars that bridge local protocols or proxy a single API surface.

### `stdio-to-uds/src/lib.rs`

`io_transport` · `during command execution, while relaying input and output`

This file solves a small but important plumbing problem: it moves bytes back and forth between the user-facing command line and a local socket. A Unix domain socket is like a private local pipe that two programs on the same machine can use to talk to each other. Without this bridge, a tool that reads from standard input and writes to standard output would not be able to communicate with a service that expects socket traffic.

The main function, `run`, first connects to the socket path it is given. If that fails, it adds a clear error message showing which socket path could not be reached. Once connected, it splits the socket into two halves: one for reading and one for writing. This is like separating a telephone line into an earpiece and a microphone so both directions can be used at the same time.

Then it starts two asynchronous copy jobs. One copies data from the socket to standard output, so responses from the service appear to the caller. The other copies data from standard input into the socket, so requests can be sent to the service. These jobs run together, and the function only finishes when both directions are done or one of them fails.

One careful detail is the socket shutdown step. After input has been sent, the code closes only the writing side of the socket to signal “no more data is coming.” If the other side already closed first, some systems report that as “not connected”; this specific case is treated as harmless.

#### Function details

##### `run`  (lines 12–46)

```
async fn run(socket_path: &Path) -> anyhow::Result<()>
```

**Purpose**: `run` connects to a local Unix domain socket and relays data in both directions between that socket and the process’s standard input and output. It is the core routine that makes a terminal-style tool able to speak to a socket-based local service.

**Data flow**: It receives a filesystem path pointing to the socket. It opens a connection there, splits that connection into a read side and a write side, then copies socket responses to standard output while also copying standard input into the socket. When standard input ends, it politely shuts down the socket’s write side, ignoring one harmless “already disconnected” case, and returns success if the whole relay completed without a real error.

**Call relations**: When called, `run` begins by using the external socket `connect` operation. It then uses Tokio’s asynchronous input/output helpers: `split` to separate reading from writing, `stdin` and `stdout` to reach the process streams, `copy` to move bytes, and `try_join!` to run the two copy directions at the same time. It also uses `Ok` from the surrounding result/error system to report successful completion.

*Call graph*: calls 1 internal fn (connect); 6 external calls (Ok, copy, split, stdin, stdout, try_join!).


### `responses-api-proxy/src/lib.rs`

`entrypoint` · `startup, main loop, and per-request handling`

This file is the heart of the proxy. Its job is to let another program talk to a local server instead of directly to OpenAI, while this proxy quietly supplies the real API authorization and optionally records request and response data for debugging. Without it, there would be no listening server, no forwarding to the upstream API, and no controlled place to hide or inject the API key.

At startup, it reads command-line settings such as the port, upstream URL, optional dump directory, and optional shutdown endpoint. It reads the authorization header from standard input, which helps avoid putting secrets directly in command-line arguments. It then binds a local TCP listener, writes a small server-info file if requested, builds an HTTP client, and waits for incoming requests.

For each request, it starts a separate thread so one slow request does not block the whole proxy. It only permits `POST /v1/responses`; anything else gets a forbidden response. For allowed requests, it reads the body, copies safe headers, replaces `Authorization` with the secret header, sets the correct upstream `Host`, sends the request to the configured upstream URL, and streams the response back to the original caller. If dumping is enabled, it also records the exchange. Think of it like a guarded mailroom: only one kind of package is accepted, the mailroom adds the private postage, forwards it, and hands the reply back.

#### Function details

##### `run_main`  (lines 73–136)

```
fn run_main(args: Args) -> Result<()>
```

**Purpose**: Starts and runs the proxy server. It turns command-line options into a live local HTTP server, prepares the upstream forwarding settings, and keeps accepting requests until the server stops or an optional shutdown request exits the process.

**Data flow**: It receives parsed `Args`, reads the authorization header from standard input, parses the upstream URL, builds the `Host` header, creates an optional exchange dumper, opens a local listening socket, optionally writes a server-info JSON file, and builds an HTTP client. After that, each incoming HTTP request is moved into its own thread, where it is either treated as a shutdown request or passed to `forward_request`. If the request loop ends unexpectedly, it returns an error.

**Call relations**: This is the top-level driver for the file. It calls `read_auth_header_from_stdin` to get the secret authorization value, `bind_listener` to reserve a localhost port, and `write_server_info` when another process needs to discover the chosen port. During normal operation it dispatches each accepted request to `forward_request`, which does the actual proxying work.

*Call graph*: calls 3 internal fn (bind_listener, read_auth_header_from_stdin, write_server_info); 9 external calls (new, from_str, from_listener, parse, anyhow!, builder, eprintln!, format!, spawn).


##### `bind_listener`  (lines 138–143)

```
fn bind_listener(port: Option<u16>) -> Result<(TcpListener, SocketAddr)>
```

**Purpose**: Opens the local network socket that the proxy will listen on. If no port is provided, it asks the operating system for a free temporary port.

**Data flow**: It receives an optional port number. It builds a localhost address using `127.0.0.1` and either the requested port or `0`, where `0` means “pick any free port.” It asks the operating system to bind a `TcpListener` to that address, then reads back the real bound address. It returns both the listener and the address, or an error if binding fails.

**Call relations**: `run_main` calls this during startup before creating the HTTP server. The returned listener is handed to `tiny_http` so incoming proxy requests can be accepted, and the returned address is used for logging and for writing the optional server-info file.

*Call graph*: called by 1 (run_main); 2 external calls (from, bind).


##### `write_server_info`  (lines 145–161)

```
fn write_server_info(path: &Path, port: u16) -> Result<()>
```

**Purpose**: Writes a small JSON file that tells other tools which port the proxy is using and which process ID owns it. This is useful when the proxy picked an automatic port and another process needs to connect to it.

**Data flow**: It receives a file path and a port number. If the path has a parent directory, it creates that directory if needed. It builds a `ServerInfo` value containing the port and current process ID, converts it to one line of JSON, creates the output file, and writes the JSON plus a newline. On success it changes the filesystem by creating or replacing that file.

**Call relations**: `run_main` calls this during startup only when the `--server-info` option is provided. It does not participate in request forwarding; it is a setup step that helps outside programs discover and track the running proxy.

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

**Purpose**: Forwards one accepted client request to the upstream Responses API and sends the upstream response back to the client. It also enforces the proxy’s narrow safety rule: only `POST /v1/responses` is allowed.

**Data flow**: It receives the shared HTTP client, the secret authorization header, forwarding settings, an optional dumper, and the incoming request. First it checks the method and path; if they are not exactly allowed, it replies with HTTP 403 and stops. For an allowed request, it reads the request body, optionally records it, copies incoming headers except `Authorization` and `Host`, inserts the secret authorization value and the upstream host, and sends a POST to the configured upstream URL. It then copies safe response headers, wraps the upstream response body so it can be streamed back through `tiny_http`, optionally tees the response body into the dump file, and responds to the original client.

**Call relations**: `run_main` calls this inside a newly spawned thread for each normal incoming request. It is the bridge between the local server side and the upstream API side: it receives a `tiny_http` request from the local listener, uses `reqwest` to contact the upstream server, and converts the upstream response back into a `tiny_http` response for the original caller.

*Call graph*: 17 external calls (new, from_bytes, new, from_bytes, from_bytes, from_static, new, post, as_reader, headers (+7 more)).


### Network proxy runtime
These files orchestrate the standalone network proxy process and its SOCKS5 transport implementation.

### `network-proxy/src/proxy.rs`

`orchestration` · `startup, child-process environment setup, and active while the proxy runs`

Codex runs untrusted or sandboxed work, so network access needs a gatekeeper. This file creates that gatekeeper. It reads the current network configuration, reserves loopback ports so the proxy is reachable only from the same machine, and then starts the HTTP proxy and, when enabled, a SOCKS5 proxy. SOCKS5 is a general proxy protocol that can carry more kinds of traffic than plain HTTP proxying.

A useful way to think about this file is as the proxy's control panel. The builder collects choices such as addresses, policy hooks, and observers. The built NetworkProxy can then start listener tasks, expose its chosen addresses, update the parts of configuration that are safe to change while running, and rewrite a child process environment so common tools like npm, pip, Docker, Git, Electron, and Node know to use the proxy.

It also protects important edges. Managed proxies are clamped to loopback addresses, meaning they should not listen on public network interfaces. It keeps reserved sockets until the async server is ready, avoiding a race where another process could grab the chosen port. If HTTPS interception is enabled, it also points child tools at a managed certificate bundle. Without this file, the proxy pieces might exist, but Codex would not have a safe, consistent way to start them or make child commands use them.

#### Function details

##### `ReservedListeners::new`  (lines 33–38)

```
fn new(http: StdTcpListener, socks: Option<StdTcpListener>) -> Self
```

**Purpose**: Creates a small holder for already-open HTTP and optional SOCKS listener sockets. This keeps selected ports reserved until the real proxy server is ready to use them.

**Data flow**: It receives an HTTP listener and maybe a SOCKS listener. It wraps each in a mutex, which is a lock that stops two tasks from taking the same listener at once, and stores them for later. The result is a ReservedListeners object.

**Call relations**: ReservedListenerSet::into_reserved_listeners calls this after the builder has reserved ports. Later, NetworkProxy::run takes the listeners out and gives them to the HTTP and SOCKS server runners.

*Call graph*: called by 1 (into_reserved_listeners); 1 external calls (new).


##### `ReservedListeners::take_http`  (lines 40–46)

```
fn take_http(&self) -> Option<StdTcpListener>
```

**Purpose**: Takes ownership of the reserved HTTP listener exactly once. This lets the running proxy use the socket that was opened earlier during setup.

**Data flow**: It reads the locked HTTP listener slot, removes the listener from the option, and returns it. After this call, the stored HTTP listener is empty, so a later call gets nothing.

**Call relations**: NetworkProxy::run uses this when a managed proxy has pre-reserved sockets. It hands the returned listener to the HTTP proxy runner instead of asking that runner to bind a fresh port.


##### `ReservedListeners::take_socks`  (lines 48–54)

```
fn take_socks(&self) -> Option<StdTcpListener>
```

**Purpose**: Takes ownership of the reserved SOCKS listener, if one was reserved. This is used only when SOCKS5 support is enabled.

**Data flow**: It locks the SOCKS listener slot, removes the optional listener, and returns it. The stored value becomes empty afterward.

**Call relations**: NetworkProxy::run calls this before starting the SOCKS5 task. If it returns a listener, the SOCKS server uses that already-reserved socket; otherwise it binds normally or does not start.


##### `ReservedListenerSet::new`  (lines 63–68)

```
fn new(http_listener: StdTcpListener, socks_listener: Option<StdTcpListener>) -> Self
```

**Purpose**: Packages an HTTP listener and optional SOCKS listener together while the builder is still deciding which addresses to advertise.

**Data flow**: It receives the two listener values and stores them in a ReservedListenerSet. Nothing is started yet; the sockets are simply kept open.

**Call relations**: reserve_loopback_ephemeral_listeners and the Windows reservation path create this set after binding sockets. The builder later reads addresses from it and converts it into ReservedListeners.

*Call graph*: called by 2 (reserve_loopback_ephemeral_listeners, try_reserve_windows_managed_listeners).


##### `ReservedListenerSet::http_addr`  (lines 70–74)

```
fn http_addr(&self) -> Result<SocketAddr>
```

**Purpose**: Finds the actual local address of the reserved HTTP listener. This matters when the operating system picked an available port automatically.

**Data flow**: It asks the listener for its local address. On success it returns that address; on failure it returns an error with context saying the HTTP proxy address could not be read.

**Call relations**: NetworkProxyBuilder::build uses this after reserving a listener, so the finished NetworkProxy knows the HTTP address that child processes should use.

*Call graph*: 1 external calls (local_addr).


##### `ReservedListenerSet::socks_addr`  (lines 76–84)

```
fn socks_addr(&self, default_addr: SocketAddr) -> Result<SocketAddr>
```

**Purpose**: Finds the actual local address of the reserved SOCKS listener, or uses a default address when no SOCKS listener was reserved.

**Data flow**: It checks whether a SOCKS listener exists. If yes, it reads and returns that listener's local address; if no, it returns the provided default address.

**Call relations**: NetworkProxyBuilder::build uses this so the proxy object always has a SOCKS address field, even when SOCKS support is disabled and no socket was reserved.


##### `ReservedListenerSet::into_reserved_listeners`  (lines 86–91)

```
fn into_reserved_listeners(self) -> Arc<ReservedListeners>
```

**Purpose**: Turns the temporary reservation set into the shared holder used by the running proxy. This is the handoff from setup-time sockets to run-time sockets.

**Data flow**: It consumes the ReservedListenerSet, moves out its HTTP and SOCKS listeners, wraps them in ReservedListeners, and places that inside an Arc, which is a thread-safe shared pointer.

**Call relations**: NetworkProxyBuilder::build calls this after it has read the chosen addresses. NetworkProxy::run later uses the shared holder to take the sockets.

*Call graph*: calls 1 internal fn (new); 1 external calls (new).


##### `NetworkProxyBuilder::default`  (lines 105–114)

```
fn default() -> Self
```

**Purpose**: Creates a builder with safe default choices. By default, Codex is treated as managing the proxy, but no state or optional hooks have been supplied yet.

**Data flow**: It produces a NetworkProxyBuilder with empty state, empty address overrides, managed_by_codex set to true, and no policy decider or blocked-request observer.

**Call relations**: NetworkProxy::builder calls this to begin the normal builder chain used by startup code and tests.

*Call graph*: called by 1 (builder).


##### `NetworkProxyBuilder::state`  (lines 118–121)

```
fn state(mut self, state: Arc<NetworkProxyState>) -> Self
```

**Purpose**: Supplies the shared proxy state that the proxy needs to read configuration and update policy lists. Building cannot succeed without this.

**Data flow**: It receives shared NetworkProxyState, stores it in the builder, and returns the updated builder so more options can be chained.

**Call relations**: Callers use this early in the builder chain. NetworkProxyBuilder::build later pulls this value out and fails if it was never provided.


##### `NetworkProxyBuilder::http_addr`  (lines 123–126)

```
fn http_addr(mut self, addr: SocketAddr) -> Self
```

**Purpose**: Lets a caller request a specific HTTP proxy address when the proxy is not fully managed by Codex. This is useful when embedding the proxy into another setup.

**Data flow**: It receives a socket address, stores it as the requested HTTP address, and returns the builder.

**Call relations**: NetworkProxyBuilder::build consults this only in the non-Codex-managed path, falling back to configuration if no override was supplied.


##### `NetworkProxyBuilder::socks_addr`  (lines 128–131)

```
fn socks_addr(mut self, addr: SocketAddr) -> Self
```

**Purpose**: Lets a caller request a specific SOCKS proxy address when the proxy is not fully managed by Codex.

**Data flow**: It receives a socket address, stores it as the requested SOCKS address, and returns the builder.

**Call relations**: NetworkProxyBuilder::build uses this in the non-managed path, otherwise managed setup reserves its own safe listener when needed.


##### `NetworkProxyBuilder::managed_by_codex`  (lines 133–136)

```
fn managed_by_codex(mut self, managed_by_codex: bool) -> Self
```

**Purpose**: Chooses whether Codex should reserve and choose safe listener ports itself. Turning this off means the caller or configuration is responsible for the requested addresses.

**Data flow**: It receives a boolean, stores it in the builder, and returns the builder.

**Call relations**: NetworkProxyBuilder::build branches on this value. In managed mode it reserves loopback listeners; in non-managed mode it uses caller or configuration addresses.


##### `NetworkProxyBuilder::policy_decider`  (lines 138–144)

```
fn policy_decider(mut self, decider: D) -> Self
```

**Purpose**: Attaches a network policy decision object that can approve or reject requests. This is the hook that lets the proxy ask, “is this connection allowed?”

**Data flow**: It receives a concrete policy decider, wraps it in a shared pointer, stores it, and returns the builder.

**Call relations**: NetworkProxy::run later clones this optional decider into the HTTP and SOCKS server tasks so request handling can apply policy.

*Call graph*: 1 external calls (new).


##### `NetworkProxyBuilder::policy_decider_arc`  (lines 146–149)

```
fn policy_decider_arc(mut self, decider: Arc<dyn NetworkPolicyDecider>) -> Self
```

**Purpose**: Attaches an already shared policy decision object. This avoids wrapping it again when the caller already has shared ownership.

**Data flow**: It receives an Arc containing a NetworkPolicyDecider trait object, stores it, and returns the builder.

**Call relations**: NetworkProxy::run later passes this decider to the proxy server tasks, just like the non-Arc builder method.


##### `NetworkProxyBuilder::blocked_request_observer`  (lines 151–157)

```
fn blocked_request_observer(mut self, observer: O) -> Self
```

**Purpose**: Attaches an observer that can be told when requests are blocked. This supports reporting or logging blocked network attempts.

**Data flow**: It receives an observer object, wraps it in a shared pointer, stores it, and returns the builder.

**Call relations**: NetworkProxyBuilder::build installs this observer into NetworkProxyState before the proxy is returned.

*Call graph*: 1 external calls (new).


##### `NetworkProxyBuilder::blocked_request_observer_arc`  (lines 159–165)

```
fn blocked_request_observer_arc(
        mut self,
        observer: Arc<dyn BlockedRequestObserver>,
    ) -> Self
```

**Purpose**: Attaches an already shared blocked-request observer. This is useful when another part of the program already owns the observer in shared form.

**Data flow**: It receives an Arc containing a BlockedRequestObserver trait object, stores it, and returns the builder.

**Call relations**: NetworkProxyBuilder::build passes the stored observer into NetworkProxyState so later request decisions can report blocked traffic.


##### `NetworkProxyBuilder::build`  (lines 167–231)

```
async fn build(self) -> Result<NetworkProxy>
```

**Purpose**: Creates a ready-to-run NetworkProxy from the builder options and current configuration. It also reserves safe listener sockets when Codex is managing the proxy.

**Data flow**: It requires shared state, installs any blocked-request observer, reads the current config, resolves configured runtime addresses, and chooses HTTP and SOCKS addresses. In managed mode it opens loopback listeners first; in non-managed mode it uses overrides or config. It clamps addresses according to safety rules, builds runtime settings, and returns a NetworkProxy.

**Call relations**: This is the main assembly step after callers use NetworkProxy::builder. It calls configuration helpers, listener reservation helpers, and NetworkProxyRuntimeSettings::from_config, then NetworkProxy::run can start the actual servers.

*Call graph*: calls 5 internal fn (clamp_bind_addrs, resolve_runtime, from_config, reserve_loopback_ephemeral_listeners, reserve_windows_managed_listeners); 2 external calls (new, new).


##### `reserve_loopback_ephemeral_listeners`  (lines 234–245)

```
fn reserve_loopback_ephemeral_listeners(
    reserve_socks_listener: bool,
) -> Result<ReservedListenerSet>
```

**Purpose**: Reserves one or two safe local ports chosen by the operating system. “Ephemeral” means the OS picks an available temporary port.

**Data flow**: It always opens an HTTP listener on 127.0.0.1 with port 0, meaning any free local port. If requested, it also opens a SOCKS listener the same way. It returns both as a ReservedListenerSet.

**Call relations**: NetworkProxyBuilder::build uses this on non-Windows managed setups. The Windows managed reservation path also falls back to this when fixed configured ports are busy.

*Call graph*: calls 2 internal fn (new, reserve_loopback_ephemeral_listener); called by 2 (build, reserve_windows_managed_listeners).


##### `reserve_windows_managed_listeners`  (lines 248–265)

```
fn reserve_windows_managed_listeners(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    reserve_socks_listener: bool,
) -> Result<ReservedListenerSet>
```

**Purpose**: On Windows, tries to reserve the configured managed proxy ports on loopback, and falls back to random local ports if those are already busy.

**Data flow**: It first converts requested addresses to 127.0.0.1 with the same ports. It then tries to bind those ports. If the address is already in use, it logs a warning and reserves ephemeral loopback ports instead; other errors are returned.

**Call relations**: NetworkProxyBuilder::build uses this only on Windows. It delegates to windows_managed_loopback_addr, try_reserve_windows_managed_listeners, and possibly reserve_loopback_ephemeral_listeners.

*Call graph*: calls 3 internal fn (reserve_loopback_ephemeral_listeners, try_reserve_windows_managed_listeners, windows_managed_loopback_addr); called by 2 (build, reserve_windows_managed_listeners_falls_back_when_http_port_is_busy); 1 external calls (warn!).


##### `try_reserve_windows_managed_listeners`  (lines 268–280)

```
fn try_reserve_windows_managed_listeners(
    http_addr: SocketAddr,
    socks_addr: SocketAddr,
    reserve_socks_listener: bool,
) -> std::io::Result<ReservedListenerSet>
```

**Purpose**: Performs the direct Windows attempt to bind the requested managed HTTP and optional SOCKS ports.

**Data flow**: It receives HTTP and SOCKS socket addresses and a flag saying whether SOCKS is needed. It binds the HTTP address, optionally binds the SOCKS address, and returns them as a ReservedListenerSet or an I/O error.

**Call relations**: reserve_windows_managed_listeners calls this and decides whether any error should trigger a fallback or be reported.

*Call graph*: calls 1 internal fn (new); called by 1 (reserve_windows_managed_listeners); 1 external calls (bind).


##### `windows_managed_loopback_addr`  (lines 283–291)

```
fn windows_managed_loopback_addr(addr: SocketAddr) -> SocketAddr
```

**Purpose**: Forces a Windows managed proxy address onto the local-only interface. This prevents a managed proxy from accidentally listening on a public interface.

**Data flow**: It receives a socket address. If the IP address is not loopback, it logs a warning. It returns a new address using 127.0.0.1 and the original port.

**Call relations**: reserve_windows_managed_listeners calls this for both HTTP and SOCKS addresses before trying to bind them.

*Call graph*: called by 1 (reserve_windows_managed_listeners); 4 external calls (from, ip, port, warn!).


##### `reserve_loopback_ephemeral_listener`  (lines 293–296)

```
fn reserve_loopback_ephemeral_listener() -> Result<StdTcpListener>
```

**Purpose**: Opens one TCP listener on a random available loopback port. This is the basic building block for safe managed listener reservation.

**Data flow**: It asks the operating system to bind 127.0.0.1:0. The OS replaces port 0 with a free port. It returns the open listener or an error with context.

**Call relations**: reserve_loopback_ephemeral_listeners calls this for HTTP and, when needed, SOCKS.

*Call graph*: called by 1 (reserve_loopback_ephemeral_listeners); 2 external calls (from, bind).


##### `NetworkProxyRuntimeSettings::from_config`  (lines 307–323)

```
fn from_config(config: &config::NetworkProxyConfig) -> Result<Self>
```

**Purpose**: Extracts the parts of configuration that the running proxy and child environments need quickly. If HTTPS interception is enabled, it prepares the managed certificate bundle information.

**Data flow**: It reads network settings such as local binding, allowed Unix socket paths, and MITM settings. MITM means the proxy can inspect encrypted HTTPS traffic by using a trusted local certificate. It returns a NetworkProxyRuntimeSettings value.

**Call relations**: NetworkProxyBuilder::build uses this for the initial settings. NetworkProxy::replace_config_state uses it again when allowed runtime configuration changes are applied.

*Call graph*: calls 1 internal fn (managed_ca_trust_bundle); called by 2 (replace_config_state, build).


##### `NetworkProxy::fmt`  (lines 338–345)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Controls what appears when a NetworkProxy is printed for debugging. It intentionally keeps noisy or sensitive internal state out of logs.

**Data flow**: It receives a formatting target and writes only the HTTP and SOCKS addresses, marking the rest as omitted.

**Call relations**: Rust's Debug formatting calls this automatically. It helps logging code inspect the proxy without dumping full configuration details.

*Call graph*: 1 external calls (debug_struct).


##### `NetworkProxy::eq`  (lines 349–353)

```
fn eq(&self, other: &Self) -> bool
```

**Purpose**: Defines when two NetworkProxy values are considered equal. It compares their public addresses and current runtime settings.

**Data flow**: It reads both proxies' HTTP addresses, SOCKS addresses, and cloned runtime settings. It returns true only if all those pieces match.

**Call relations**: Rust equality checks call this automatically. It uses NetworkProxy::runtime_settings so the comparison sees the current settings behind the lock.

*Call graph*: calls 1 internal fn (runtime_settings); 1 external calls (runtime_settings).


##### `proxy_url_env_value`  (lines 452–461)

```
fn proxy_url_env_value(
    env: &'a HashMap<String, String>,
    canonical_key: &str,
) -> Option<&'a str>
```

**Purpose**: Looks up a proxy environment variable while accepting both uppercase and lowercase spellings. Many tools use different casing conventions.

**Data flow**: It receives an environment map and a canonical key like HTTP_PROXY. It first checks that exact key, then checks its lowercase form, and returns the value if found.

**Call relations**: has_proxy_url_env_vars uses this to detect whether any proxy URL is already present in an environment.


##### `has_proxy_url_env_vars`  (lines 463–467)

```
fn has_proxy_url_env_vars(env: &HashMap<String, String>) -> bool
```

**Purpose**: Checks whether an environment already contains any non-empty proxy URL setting. This can tell Codex whether proxy-related variables are present.

**Data flow**: It scans the known proxy URL keys, looks up each with proxy_url_env_value, trims whitespace, and returns true if any value is not empty.

**Call relations**: Tests exercise this helper for lowercase and WebSocket keys. It relies on proxy_url_env_value for case-insensitive lookup behavior.


##### `set_env_keys`  (lines 469–473)

```
fn set_env_keys(env: &mut HashMap<String, String>, keys: &[&str], value: &str)
```

**Purpose**: Writes the same value into many environment variable names. This avoids repeating the same loop for each tool-specific proxy variable group.

**Data flow**: It receives a mutable environment map, a list of keys, and a value. It inserts that value under every key in the list.

**Call relations**: apply_proxy_env_overrides calls this repeatedly to set HTTP, WebSocket, no-proxy, ALL_PROXY, and FTP proxy variables.

*Call graph*: called by 1 (apply_proxy_env_overrides).


##### `codex_proxy_git_ssh_command`  (lines 476–478)

```
fn codex_proxy_git_ssh_command(socks_addr: SocketAddr) -> String
```

**Purpose**: Builds the macOS Git SSH command that sends SSH traffic through the SOCKS proxy. This helps Git-over-SSH use the proxy when SOCKS is available.

**Data flow**: It receives the SOCKS address and formats a GIT_SSH_COMMAND string using netcat as the proxy connector. It returns the command text.

**Call relations**: apply_proxy_env_overrides uses this on macOS when it needs to insert or refresh Codex's own Git SSH proxy wrapper. A macOS test also calls it to build the expected value.

*Call graph*: called by 2 (apply_proxy_env_overrides, apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command); 1 external calls (format!).


##### `is_codex_proxy_git_ssh_command`  (lines 481–484)

```
fn is_codex_proxy_git_ssh_command(command: &str) -> bool
```

**Purpose**: Recognizes whether an existing macOS Git SSH command was created by Codex. This prevents Codex from overwriting a user's own SSH wrapper.

**Data flow**: It receives a command string and checks whether it has Codex's known prefix and suffix. It returns true for Codex-generated commands and false otherwise.

**Call relations**: apply_proxy_env_overrides calls this before deciding whether to preserve or replace GIT_SSH_COMMAND.

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

**Purpose**: Rewrites a child process environment so common tools send network traffic through Codex's proxy. It is the bridge between the running proxy and programs launched inside the sandbox.

**Data flow**: It receives a mutable environment map, proxy addresses, whether SOCKS is enabled, local-binding permission, and optional MITM certificate bundle information. It writes standard proxy variables, no-proxy exceptions for local/private IPs, Node and Electron flags, optional macOS Git SSH proxy settings, and optional custom certificate variables. The changed environment map is the output.

**Call relations**: NetworkProxy::apply_to_env calls this during child setup. Many tests call it directly to verify tool variables, SOCKS behavior, certificate handling, and macOS Git SSH preservation.

*Call graph*: calls 3 internal fn (codex_proxy_git_ssh_command, is_codex_proxy_git_ssh_command, set_env_keys); called by 10 (apply_to_env, apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override, apply_proxy_env_overrides_preserves_existing_git_ssh_command, apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape, apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command, apply_proxy_env_overrides_sets_common_tool_vars, apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars, apply_proxy_env_overrides_sets_only_expected_env_keys, apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks, apply_proxy_env_overrides_uses_plain_http_proxy_url); 1 external calls (format!).


##### `NetworkProxy::builder`  (lines 596–598)

```
fn builder() -> NetworkProxyBuilder
```

**Purpose**: Starts a new NetworkProxy builder. This is the normal entry point for constructing a proxy object.

**Data flow**: It takes no input and returns a default NetworkProxyBuilder.

**Call relations**: Startup code and tests call this, then chain builder methods such as state, managed_by_codex, and policy_decider before build.

*Call graph*: calls 1 internal fn (default); called by 6 (start_proxy, test_network_proxy, managed_proxy_builder_does_not_reserve_socks_listener_when_disabled, managed_proxy_builder_uses_loopback_ports, non_codex_managed_proxy_builder_uses_configured_ports, create_seatbelt_args_merges_proxy_and_explicit_unix_socket_paths).


##### `NetworkProxy::http_addr`  (lines 600–602)

```
fn http_addr(&self) -> SocketAddr
```

**Purpose**: Returns the HTTP proxy address that child tools should use for HTTP-style proxy variables.

**Data flow**: It reads the stored HTTP socket address from the proxy and returns a copy.

**Call relations**: Callers use this after building the proxy when they need to display, test, or pass around the selected HTTP endpoint.


##### `NetworkProxy::socks_addr`  (lines 604–606)

```
fn socks_addr(&self) -> SocketAddr
```

**Purpose**: Returns the SOCKS proxy address. This is useful for SOCKS-aware clients or for Git SSH proxying on macOS.

**Data flow**: It reads the stored SOCKS socket address from the proxy and returns a copy.

**Call relations**: Callers use this after setup to know where the SOCKS listener is expected to be, even if SOCKS is disabled.


##### `NetworkProxy::current_cfg`  (lines 608–610)

```
async fn current_cfg(&self) -> Result<config::NetworkProxyConfig>
```

**Purpose**: Fetches the proxy's current configuration from shared state. This lets callers inspect the live configuration through the proxy object.

**Data flow**: It asks NetworkProxyState for the current config asynchronously and returns that config or an error.

**Call relations**: This is a thin pass-through to state. Other methods in this file also query state directly when they need configuration before running or updating.


##### `NetworkProxy::add_allowed_domain`  (lines 612–614)

```
async fn add_allowed_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host name to the allowed-domain list. This lets policy be relaxed for a specific destination while the proxy is running.

**Data flow**: It receives a host string, passes it to NetworkProxyState, and returns success or an error.

**Call relations**: Callers can use this as a runtime control hook. The actual policy storage and later request decisions happen in NetworkProxyState and the proxy request handlers.


##### `NetworkProxy::add_denied_domain`  (lines 616–618)

```
async fn add_denied_domain(&self, host: &str) -> Result<()>
```

**Purpose**: Adds a host name to the denied-domain list. This lets policy block a specific destination while the proxy is running.

**Data flow**: It receives a host string, passes it to NetworkProxyState, and returns success or an error.

**Call relations**: Callers use this to change policy at runtime. Request handling elsewhere consults the state when deciding whether traffic is allowed.


##### `NetworkProxy::allow_local_binding`  (lines 620–622)

```
fn allow_local_binding(&self) -> bool
```

**Purpose**: Reports whether child processes are allowed to bind local listening sockets. This is a runtime setting exposed for sandbox setup.

**Data flow**: It reads the current runtime settings behind a lock, copies the allow_local_binding flag, and returns it.

**Call relations**: It depends on NetworkProxy::runtime_settings. NetworkProxy::replace_config_state can change the setting while the proxy remains running.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::allow_unix_sockets`  (lines 624–626)

```
fn allow_unix_sockets(&self) -> Arc<[String]>
```

**Purpose**: Returns the configured list of Unix socket paths that child processes may use. A Unix socket is a local file-like connection endpoint used for inter-process communication.

**Data flow**: It reads the current runtime settings, clones the shared list of allowed socket path strings, and returns it.

**Call relations**: Sandbox setup code can call this to decide which local socket paths to expose. NetworkProxy::runtime_settings supplies the latest value.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::dangerously_allow_all_unix_sockets`  (lines 628–630)

```
fn dangerously_allow_all_unix_sockets(&self) -> bool
```

**Purpose**: Reports whether the configuration allows all Unix sockets, a broad and risky permission. The name makes the danger explicit.

**Data flow**: It reads the current runtime settings and returns the boolean flag.

**Call relations**: It is a small accessor over NetworkProxy::runtime_settings. Other setup code can use it when building sandbox permissions.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::managed_mitm_ca_trust_bundle_path`  (lines 633–641)

```
fn managed_mitm_ca_trust_bundle_path(&self) -> Option<AbsolutePathBuf>
```

**Purpose**: Returns the path to the managed certificate bundle that child HTTPS clients should trust when MITM interception is enabled. If the path is invalid or MITM is off, it returns nothing.

**Data flow**: It reads current runtime settings, looks for a managed MITM CA bundle, converts its path into an absolute path type, logs a warning if conversion fails, and returns the valid path if present.

**Call relations**: This accessor uses NetworkProxy::runtime_settings. Environment setup also uses the same certificate bundle through apply_proxy_env_overrides.

*Call graph*: calls 1 internal fn (runtime_settings).


##### `NetworkProxy::apply_to_env`  (lines 643–655)

```
fn apply_to_env(&self, env: &mut HashMap<String, String>)
```

**Purpose**: Applies this proxy's current addresses and settings to a child process environment. This is the method callers use instead of manually setting many proxy variables.

**Data flow**: It reads runtime settings, then passes the environment map, HTTP address, SOCKS address, SOCKS enabled flag, local binding flag, and optional certificate bundle to apply_proxy_env_overrides. The environment map is modified in place.

**Call relations**: It is the public wrapper around apply_proxy_env_overrides. Child launch code calls it after the proxy has been built so tools know where to send traffic.

*Call graph*: calls 2 internal fn (runtime_settings, apply_proxy_env_overrides).


##### `NetworkProxy::replace_config_state`  (lines 657–688)

```
async fn replace_config_state(&self, new_state: ConfigState) -> Result<()>
```

**Purpose**: Updates the running proxy's configuration state, but only for settings that are safe to change without restarting listeners. It refuses changes to core listener/proxy URL options.

**Data flow**: It reads the current config, compares fixed fields such as enabled, proxy URL, SOCKS URL, and SOCKS feature flags against the new config, and errors if any changed. If allowed, it builds new runtime settings, replaces state, updates the locked runtime settings, and returns success.

**Call relations**: This method calls NetworkProxyRuntimeSettings::from_config for the new live settings. It protects NetworkProxy::run from having its bound listener assumptions changed underneath it.

*Call graph*: calls 1 internal fn (from_config); 1 external calls (ensure!).


##### `NetworkProxy::runtime_settings`  (lines 690–695)

```
fn runtime_settings(&self) -> NetworkProxyRuntimeSettings
```

**Purpose**: Safely reads a snapshot of the proxy's current runtime settings. The snapshot avoids holding the lock while callers use the values.

**Data flow**: It takes a read lock on the runtime settings, recovers if the lock was poisoned by a panic, clones the settings, and returns the clone.

**Call relations**: Accessors, equality comparison, and environment application call this whenever they need the latest settings.

*Call graph*: called by 6 (allow_local_binding, allow_unix_sockets, apply_to_env, dangerously_allow_all_unix_sockets, eq, managed_mitm_ca_trust_bundle_path).


##### `NetworkProxy::run`  (lines 697–763)

```
async fn run(&self) -> Result<NetworkProxyHandle>
```

**Purpose**: Starts the proxy listener tasks. It launches the HTTP proxy and, if configured, the SOCKS5 proxy, then returns a handle that can wait for or stop them.

**Data flow**: It reads current configuration. If networking is disabled, it returns a completed no-op handle. Otherwise it warns about unsupported Unix socket permissions when needed, takes any reserved listeners, spawns an HTTP task, optionally spawns a SOCKS task, and returns a NetworkProxyHandle containing those tasks.

**Call relations**: This is called after NetworkProxyBuilder::build. It hands work to http_proxy::run_http_proxy or run_http_proxy_with_std_listener, and to socks5::run_socks5 or run_socks5_with_std_listener when SOCKS is enabled.

*Call graph*: calls 6 internal fn (run_http_proxy, run_http_proxy_with_std_listener, noop, unix_socket_permissions_supported, run_socks5, run_socks5_with_std_listener); 2 external calls (spawn, warn!).


##### `NetworkProxyHandle::noop`  (lines 773–779)

```
fn noop() -> Self
```

**Purpose**: Creates a handle for the case where the proxy is disabled and no real listeners were started. It still behaves like a completed proxy run.

**Data flow**: It spawns a tiny task that immediately returns success, stores no SOCKS task, marks the handle completed, and returns it.

**Call relations**: NetworkProxy::run calls this when network.enabled is false, so callers can still receive a NetworkProxyHandle and use the same wait/shutdown flow.

*Call graph*: called by 1 (run); 1 external calls (spawn).


##### `NetworkProxyHandle::wait`  (lines 781–795)

```
async fn wait(mut self) -> Result<()>
```

**Purpose**: Waits for the proxy tasks to finish and reports whether either task failed. This is for running the proxy until its listener tasks exit.

**Data flow**: It takes the stored HTTP task and optional SOCKS task, awaits them, marks the handle completed, unwraps task join errors and proxy errors, and returns success only if all tasks succeeded.

**Call relations**: Callers use this when they want the proxy process to keep running. Because it marks the handle completed, Drop will not later abort the tasks.


##### `NetworkProxyHandle::shutdown`  (lines 797–801)

```
async fn shutdown(mut self) -> Result<()>
```

**Purpose**: Stops the running proxy tasks on purpose. This is the graceful control path for teardown from the owner's point of view, even though the tasks are stopped by aborting them.

**Data flow**: It takes the stored task handles, passes them to abort_tasks, marks itself completed, and returns success.

**Call relations**: Callers use this during teardown. It delegates the actual stopping work to abort_tasks.

*Call graph*: calls 1 internal fn (abort_tasks).


##### `abort_task`  (lines 804–809)

```
async fn abort_task(task: Option<JoinHandle<Result<()>>>)
```

**Purpose**: Stops one spawned async task if it exists. This is a small helper for cleanup.

**Data flow**: It receives an optional task handle. If present, it aborts the task and awaits it to let Tokio finish cleanup; if absent, it does nothing.

**Call relations**: abort_tasks calls this for the HTTP task and then the SOCKS task. It is used by explicit shutdown and by Drop cleanup.

*Call graph*: called by 1 (abort_tasks).


##### `abort_tasks`  (lines 811–817)

```
async fn abort_tasks(
    http_task: Option<JoinHandle<Result<()>>>,
    socks_task: Option<JoinHandle<Result<()>>>,
)
```

**Purpose**: Stops both proxy listener tasks, if they exist. It centralizes the cleanup sequence for HTTP and SOCKS tasks.

**Data flow**: It receives optional HTTP and SOCKS task handles, aborts and awaits the HTTP task, then aborts and awaits the SOCKS task.

**Call relations**: NetworkProxyHandle::shutdown calls this when the owner explicitly shuts down. NetworkProxyHandle::drop also calls it in a background task if the owner forgets.

*Call graph*: calls 1 internal fn (abort_task); called by 2 (drop, shutdown).


##### `NetworkProxyHandle::drop`  (lines 820–829)

```
fn drop(&mut self)
```

**Purpose**: Prevents leaked proxy tasks when a handle is dropped without wait or shutdown. It acts like a safety net.

**Data flow**: When the handle is being destroyed, it checks whether it was marked completed. If not, it takes any task handles and spawns a cleanup task that aborts them.

**Call relations**: Rust calls this automatically. It uses abort_tasks so cleanup matches explicit shutdown behavior.

*Call graph*: calls 1 internal fn (abort_tasks); 1 external calls (spawn).


##### `tests::managed_proxy_builder_uses_loopback_ports`  (lines 843–881)

```
async fn managed_proxy_builder_uses_loopback_ports()
```

**Purpose**: Checks that a Codex-managed proxy chooses loopback-only addresses. This protects against accidentally exposing the proxy to the wider network.

**Data flow**: The test creates temporary local ports, builds a managed proxy with those ports in configuration, and inspects the resulting addresses. It accepts permission-related setup failure, otherwise it asserts that addresses are loopback and ports are sensible for the platform.

**Call relations**: It exercises NetworkProxy::builder and the managed build path, including listener reservation behavior.

*Call graph*: calls 2 internal fn (default, builder); 9 external calls (new, from, bind, assert!, assert_eq!, assert_ne!, network_proxy_state_for_policy, format!, panic!).


##### `tests::non_codex_managed_proxy_builder_uses_configured_ports`  (lines 884–906)

```
async fn non_codex_managed_proxy_builder_uses_configured_ports()
```

**Purpose**: Checks that a non-Codex-managed proxy uses the configured ports instead of reserving new managed ones.

**Data flow**: The test builds state with fixed proxy URLs, disables managed_by_codex, builds the proxy, and compares the proxy's addresses with the configured values.

**Call relations**: It exercises NetworkProxy::builder, NetworkProxyBuilder::managed_by_codex, and NetworkProxyBuilder::build in the non-managed path.

*Call graph*: calls 2 internal fn (default, builder); 3 external calls (new, assert_eq!, network_proxy_state_for_policy).


##### `tests::managed_proxy_builder_does_not_reserve_socks_listener_when_disabled`  (lines 909–944)

```
async fn managed_proxy_builder_does_not_reserve_socks_listener_when_disabled()
```

**Purpose**: Checks that managed setup does not reserve a SOCKS socket when SOCKS5 is disabled. This avoids taking an unnecessary port.

**Data flow**: The test builds managed proxy state with enable_socks5 false, builds the proxy, checks that the HTTP address is loopback and nonzero, checks that the SOCKS address remains the configured one, and confirms no SOCKS listener was reserved.

**Call relations**: It exercises the builder's managed reservation path and the ReservedListeners::take_socks behavior.

*Call graph*: calls 2 internal fn (default, builder); 6 external calls (new, assert!, assert_eq!, assert_ne!, network_proxy_state_for_policy, panic!).


##### `tests::windows_managed_loopback_addr_clamps_non_loopback_inputs`  (lines 948–957)

```
fn windows_managed_loopback_addr_clamps_non_loopback_inputs()
```

**Purpose**: Checks that Windows managed addresses are forced to 127.0.0.1 even when configuration asks for a wider bind address.

**Data flow**: The test passes non-loopback IPv4 and IPv6-any addresses to windows_managed_loopback_addr and asserts that the returned addresses use 127.0.0.1 with the original ports.

**Call relations**: It directly verifies the safety helper used by reserve_windows_managed_listeners.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::reserve_windows_managed_listeners_falls_back_when_http_port_is_busy`  (lines 961–985)

```
fn reserve_windows_managed_listeners_falls_back_when_http_port_is_busy()
```

**Purpose**: Checks that Windows managed setup falls back to a random loopback port when the configured HTTP port is already occupied.

**Data flow**: The test binds a temporary listener to occupy a port, asks reserve_windows_managed_listeners to use that port, and asserts that it returns a loopback listener on a different port with no SOCKS listener when SOCKS was not requested.

**Call relations**: It directly exercises reserve_windows_managed_listeners and its fallback to reserve_loopback_ephemeral_listeners.

*Call graph*: calls 1 internal fn (reserve_windows_managed_listeners); 4 external calls (from, bind, assert!, assert_ne!).


##### `tests::proxy_url_env_value_resolves_lowercase_aliases`  (lines 988–999)

```
fn proxy_url_env_value_resolves_lowercase_aliases()
```

**Purpose**: Checks that proxy environment lookup finds lowercase variable names. This matters because many programs use lowercase proxy variables.

**Data flow**: The test creates an environment containing http_proxy, asks for HTTP_PROXY, and asserts that the lowercase value is returned.

**Call relations**: It directly verifies proxy_url_env_value.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::has_proxy_url_env_vars_detects_lowercase_aliases`  (lines 1002–1010)

```
fn has_proxy_url_env_vars_detects_lowercase_aliases()
```

**Purpose**: Checks that proxy detection notices lowercase proxy URL variables.

**Data flow**: The test creates an environment with all_proxy set and asserts that has_proxy_url_env_vars returns true.

**Call relations**: It exercises has_proxy_url_env_vars, which depends on proxy_url_env_value.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::has_proxy_url_env_vars_detects_websocket_proxy_keys`  (lines 1013–1018)

```
fn has_proxy_url_env_vars_detects_websocket_proxy_keys()
```

**Purpose**: Checks that WebSocket proxy variables count as proxy settings too.

**Data flow**: The test creates an environment with wss_proxy and asserts that proxy-variable detection returns true.

**Call relations**: It verifies that the PROXY_URL_ENV_KEYS list used by has_proxy_url_env_vars includes WebSocket-related keys.

*Call graph*: 2 external calls (new, assert_eq!).


##### `tests::apply_proxy_env_overrides_sets_common_tool_vars`  (lines 1021–1082)

```
fn apply_proxy_env_overrides_sets_common_tool_vars()
```

**Purpose**: Checks that environment rewriting sets the proxy variables used by common tools. It also checks important safety defaults like NO_PROXY for local and private addresses.

**Data flow**: The test starts with an empty environment, applies overrides with HTTP and SOCKS enabled, and asserts that HTTP, WebSocket, npm, ALL_PROXY, FTP, NO_PROXY, Codex marker, local-binding flag, Electron, and Node variables have expected values.

**Call relations**: It directly exercises apply_proxy_env_overrides across its main happy path.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 5 external calls (new, V4, new, assert!, assert_eq!).


##### `tests::apply_proxy_env_overrides_sets_only_expected_env_keys`  (lines 1085–1104)

```
fn apply_proxy_env_overrides_sets_only_expected_env_keys()
```

**Purpose**: Checks that environment rewriting does not create surprise variables. This keeps the proxy setup predictable for child processes.

**Data flow**: The test applies proxy overrides to an empty environment and then checks every resulting key against the known allowed proxy environment key list, with a macOS exception for Git SSH command.

**Call relations**: It directly verifies the surface area of apply_proxy_env_overrides.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 5 external calls (new, V4, new, assert!, cfg!).


##### `tests::apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars`  (lines 1107–1129)

```
fn apply_proxy_env_overrides_sets_mitm_ca_trust_bundle_vars()
```

**Purpose**: Checks that MITM certificate bundle variables are written when a managed bundle is provided.

**Data flow**: The test creates a fake managed certificate bundle path, applies proxy overrides, and asserts that every known custom CA environment key points to that path.

**Call relations**: It verifies the certificate-related branch inside apply_proxy_env_overrides.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 5 external calls (new, V4, new, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override`  (lines 1132–1158)

```
fn apply_proxy_env_overrides_preserves_command_scoped_mitm_ca_override()
```

**Purpose**: Checks that a child-command-specific certificate override is not overwritten by the managed MITM bundle. This preserves a user's explicit command setting.

**Data flow**: The test starts with REQUESTS_CA_BUNDLE already set to a command-specific path, applies overrides with a managed bundle, and asserts that the existing value remains while other CA keys can be set to the managed path.

**Call relations**: It exercises apply_proxy_env_overrides logic that distinguishes command-scoped overrides from startup values.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 6 external calls (from, new, V4, new, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks`  (lines 1161–1177)

```
fn apply_proxy_env_overrides_uses_http_for_all_proxy_without_socks()
```

**Purpose**: Checks that ALL_PROXY falls back to the HTTP proxy when SOCKS is disabled.

**Data flow**: The test applies overrides with socks_enabled false and allow_local_binding true, then asserts that ALL_PROXY uses the HTTP URL and the local-binding flag is set to 1.

**Call relations**: It verifies the no-SOCKS branch of apply_proxy_env_overrides.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_uses_plain_http_proxy_url`  (lines 1180–1221)

```
fn apply_proxy_env_overrides_uses_plain_http_proxy_url()
```

**Purpose**: Checks that HTTP-style environment variables always receive plain HTTP proxy URLs, even when SOCKS is enabled. Some clients break if HTTP_PROXY contains a SOCKS URL.

**Data flow**: The test applies overrides with SOCKS enabled and asserts that HTTP_PROXY, HTTPS_PROXY, and WebSocket variables use http:// while ALL_PROXY uses socks5h://. It also checks macOS Git SSH behavior when applicable.

**Call relations**: It verifies an important compatibility rule inside apply_proxy_env_overrides.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_preserves_existing_git_ssh_command`  (lines 1225–1244)

```
fn apply_proxy_env_overrides_preserves_existing_git_ssh_command()
```

**Purpose**: On macOS, checks that Codex does not overwrite a user's existing Git SSH wrapper. This protects setups such as corporate or secret-manager SSH tooling.

**Data flow**: The test starts with GIT_SSH_COMMAND set to a custom command, applies proxy overrides with SOCKS enabled, and asserts that the original command remains unchanged.

**Call relations**: It exercises the macOS branch of apply_proxy_env_overrides and its call to is_codex_proxy_git_ssh_command.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape`  (lines 1248–1267)

```
fn apply_proxy_env_overrides_preserves_unmarked_git_ssh_command_with_proxy_shape()
```

**Purpose**: On macOS, checks that Codex preserves an existing Git SSH command even if it looks like a SOCKS proxy command, as long as Codex did not mark it.

**Data flow**: The test sets GIT_SSH_COMMAND to an unmarked netcat SOCKS command, applies overrides with a different SOCKS port, and asserts that the original command remains.

**Call relations**: It verifies that apply_proxy_env_overrides only refreshes commands recognized by is_codex_proxy_git_ssh_command as Codex-generated.

*Call graph*: calls 1 internal fn (apply_proxy_env_overrides); 4 external calls (new, V4, new, assert_eq!).


##### `tests::apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command`  (lines 1271–1294)

```
fn apply_proxy_env_overrides_refreshes_previous_codex_proxy_git_ssh_command()
```

**Purpose**: On macOS, checks that Codex updates its own previous Git SSH proxy command when the SOCKS port changes. This avoids leaving Git pointed at a stale proxy port.

**Data flow**: The test starts with a Codex-generated GIT_SSH_COMMAND for one SOCKS port, applies overrides with a new SOCKS port, and asserts that the command is replaced with the new Codex-generated value.

**Call relations**: It exercises codex_proxy_git_ssh_command and the refresh branch inside apply_proxy_env_overrides.

*Call graph*: calls 2 internal fn (apply_proxy_env_overrides, codex_proxy_git_ssh_command); 4 external calls (new, V4, new, assert_eq!).


### `network-proxy/src/socks5.rs`

`orchestration` · `startup and request handling`

SOCKS5 is a general-purpose proxy protocol: a client says, “please connect me to this host and port,” and the proxy carries bytes back and forth. This file is the gatekeeper for that path. Without it, SOCKS5 clients could either not connect at all, or they could bypass the project’s network restrictions.

The file starts a TCP listener, builds a SOCKS5 acceptor, and attaches the shared NetworkProxyState so each request can see whether the proxy is enabled, which network mode is active, and which hosts are allowed. For TCP requests, it normalizes the target host, checks whether the proxy is enabled, checks the current mode, asks the host policy engine for allow-or-deny, and records/audits denials. In limited mode, SOCKS5 TCP is only accepted for port 443 because that is the only case the code can safely treat as HTTPS. If HTTPS inspection is required, it routes the connection into the MITM path, meaning “man in the middle” inspection where the proxy terminates TLS so it can enforce detailed HTTPS rules. Otherwise it opens a direct upstream TCP connection.

UDP support is optional. When enabled, UDP relay packets go through similar checks, but limited mode blocks SOCKS5 UDP entirely. The file also includes tests that prove important deny events and MITM choices happen as expected.

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

**Purpose**: Starts the SOCKS5 proxy by binding a new TCP listening socket to the requested address. Use this when the proxy should create and own its listening socket.

**Data flow**: It receives shared proxy state, a socket address, an optional policy checker, and a flag for UDP support. It creates a TCP listener at that address, adds helpful error context if binding fails, then passes the listener and settings into the common SOCKS5 runner. It returns success only if the server setup path completes without an error.

**Call relations**: The top-level proxy runner calls this when it wants a normal SOCKS5 listener. After creating the listener, it hands control to run_socks5_with_listener, which does the actual server wiring.

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

**Purpose**: Starts the SOCKS5 proxy from an already-created standard TCP listener. This is useful when another part of the program, or a test harness, prepared the socket first.

**Data flow**: It receives the shared proxy state, an existing standard library listener, an optional policy checker, and the UDP flag. It converts that listener into the async listener type used by the Rama networking library, then sends it to the common SOCKS5 runner. If conversion fails, it returns an error explaining that the listener could not be converted.

**Call relations**: The top-level proxy runner calls this variant when socket setup happened elsewhere. Once conversion is done, it joins the same path as run_socks5 by calling run_socks5_with_listener.

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

**Purpose**: Builds and runs the actual SOCKS5 service on a prepared listener. It connects the listener, policy checks, TCP forwarding, optional UDP relay, and shared state into one working server.

**Data flow**: It reads the listener’s local address for logging, checks the current network mode for startup warnings, builds a TCP connector that will run handle_socks5_tcp for every outbound TCP request, and builds a SOCKS5 acceptor around that connector. If UDP is enabled, it also adds a UDP relay inspector that calls inspect_socks5_udp. Finally it starts serving incoming clients and injects the shared state into each request.

**Call relations**: Both public startup functions hand listeners to this function. During serving, it arranges for TCP requests to flow into handle_socks5_tcp and, when UDP is enabled, UDP relay packets to flow into inspect_socks5_udp.

*Call graph*: calls 1 internal fn (new); called by 2 (run_socks5, run_socks5_with_std_listener); 9 external calls (new, default, default, new, local_addr, serve, info!, service_fn, warn!).


##### `handle_socks5_tcp`  (lines 153–408)

```
async fn handle_socks5_tcp(
    req: TcpRequest,
    tcp_connector: TargetCheckedTcpConnector,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> Result<EstablishedClientConnection<Socks5
```

**Purpose**: Decides whether a SOCKS5 TCP connection may proceed, and whether it should be a direct connection or an inspected HTTPS connection. This is the main policy checkpoint for SOCKS5 TCP traffic.

**Data flow**: It receives a TCP connect request, a connector that can open approved upstream sockets, and an optional policy decider. It pulls shared state and client information from request extensions, normalizes the target host, checks whether the proxy is enabled, checks network mode restrictions, asks the host policy system for an allow-or-deny decision, records and audits denials, and then checks whether MITM inspection is required. The output is either an error explaining the denial, a direct TCP connection, or a special MITM connection placeholder carrying the target and inspection state.

**Call relations**: run_socks5_with_listener wires this into the SOCKS5 connector, so it runs before TCP forwarding begins. If it allows a direct connection, it hands off to the target-checked TCP connector. If HTTPS inspection is needed, it returns a Socks5TcpConnection::Mitm that proxy_socks5_tcp later routes into the MITM stream.

*Call graph*: calls 7 internal fn (serve, new, evaluate_host_policy, normalize_host, new, emit_socks_block_decision_audit_event, policy_denied_error); called by 4 (handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode, handle_socks5_tcp_blocks_limited_mode_without_mitm_state, handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode, handle_socks5_tcp_uses_mitm_in_limited_mode); 8 external calls (new, now, extensions, new, other, error!, info!, warn!).


##### `Socks5TcpConnection::poll_read`  (lines 424–433)

```
fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>>
```

**Purpose**: Lets Socks5TcpConnection act like a readable async stream. For direct connections it reads from the real TCP socket; for MITM placeholders it reports an immediate empty read because there is no upstream socket yet.

**Data flow**: It receives a pinned mutable connection, async task context, and a read buffer. If the connection is direct, it delegates the read to the underlying TcpStream. If it is a MITM placeholder, it immediately says the read operation is complete without adding bytes.

**Call relations**: The networking library calls this through the AsyncRead trait when treating Socks5TcpConnection like a stream. It supports the direct forwarding path used by proxy_socks5_tcp, while the MITM path mainly uses the original client stream instead.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::poll_write`  (lines 437–446)

```
fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>>
```

**Purpose**: Lets Socks5TcpConnection act like a writable async stream. Direct connections write to the upstream server; MITM placeholders accept the bytes without sending them anywhere because forwarding is not done through this placeholder.

**Data flow**: It receives a pinned mutable connection, async task context, and bytes to write. For a direct connection, it writes those bytes to the TcpStream. For a MITM placeholder, it reports that all bytes were accepted.

**Call relations**: The stream forwarding service can call this when copying client bytes to a direct upstream socket. MITM connections avoid normal byte forwarding and are later redirected by proxy_socks5_tcp.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::poll_flush`  (lines 448–453)

```
fn poll_flush(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>>
```

**Purpose**: Flushes pending outgoing bytes for direct SOCKS5 TCP connections. For MITM placeholders it succeeds immediately because there is no real upstream stream to flush.

**Data flow**: It receives the connection and async task context. Direct connections pass the flush request to the underlying TcpStream. MITM placeholders return immediate success.

**Call relations**: This is part of making Socks5TcpConnection compatible with async writing. The forwarding service relies on it in the direct path; the MITM path does not need real flushing here.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::poll_shutdown`  (lines 455–460)

```
fn poll_shutdown(self: Pin<&mut Self>, cx: &mut TaskContext<'_>) -> Poll<io::Result<()>>
```

**Purpose**: Shuts down the writable side of a direct SOCKS5 TCP stream. For MITM placeholders it succeeds immediately because no upstream socket exists yet.

**Data flow**: It receives the connection and async task context. Direct connections delegate shutdown to the TcpStream. MITM placeholders simply report success.

**Call relations**: The stream forwarding service may call this when a direct connection is closing. MITM traffic is instead closed by the MITM stream handling code.

*Call graph*: 2 external calls (new, Ready).


##### `Socks5TcpConnection::local_addr`  (lines 464–469)

```
fn local_addr(&self) -> io::Result<SocketAddr>
```

**Purpose**: Reports the local socket address for a SOCKS5 TCP connection. For MITM placeholders it returns a harmless all-zero address because there is no actual upstream socket.

**Data flow**: It reads the connection variant. Direct connections return the local address from the TcpStream. MITM placeholders return 0.0.0.0:0 as a dummy value.

**Call relations**: The Rama networking traits call this when they need socket metadata. It keeps both direct and MITM connection variants fitting the same Socket interface.

*Call graph*: 1 external calls (from).


##### `Socks5TcpConnection::peer_addr`  (lines 471–476)

```
fn peer_addr(&self) -> io::Result<SocketAddr>
```

**Purpose**: Reports the remote peer address for a SOCKS5 TCP connection. Direct connections return the upstream server address; MITM placeholders return a dummy all-zero address.

**Data flow**: It checks whether the connection is direct or MITM. Direct connections ask the TcpStream for its peer address. MITM placeholders return 0.0.0.0:0 because no upstream peer has been dialed.

**Call relations**: The networking framework uses this through the Socket trait. It allows code that expects socket-like metadata to work even when the connection is actually waiting for MITM handling.

*Call graph*: 1 external calls (from).


##### `Socks5TcpConnection::extensions`  (lines 480–485)

```
fn extensions(&self) -> &Extensions
```

**Purpose**: Gives read-only access to the connection’s extension store, which is a small bag of extra typed metadata attached to a stream.

**Data flow**: It receives a connection reference. For direct connections, it returns the TcpStream’s extensions. For MITM placeholders, it returns the placeholder’s own extension store.

**Call relations**: Rama services use extensions to pass extra context along a request path. This function keeps that mechanism available for both direct sockets and MITM placeholders.


##### `Socks5TcpConnection::extensions_mut`  (lines 489–494)

```
fn extensions_mut(&mut self) -> &mut Extensions
```

**Purpose**: Gives writable access to the connection’s extension store so later code can attach or update metadata.

**Data flow**: It receives a mutable connection reference. Direct connections expose the TcpStream’s mutable extensions. MITM placeholders expose their internal mutable extensions.

**Call relations**: This supports the same extension-passing pattern as extensions. proxy_socks5_tcp uses related extension machinery on the source stream before sending MITM traffic onward.


##### `proxy_socks5_tcp`  (lines 497–515)

```
async fn proxy_socks5_tcp(
    request: ProxyRequest<TcpStream, Socks5TcpConnection>,
) -> Result<(), BoxError>
```

**Purpose**: Moves an approved SOCKS5 TCP connection into its final data path. It either forwards bytes directly to the upstream server or sends the client stream into HTTPS MITM inspection.

**Data flow**: It receives a proxy request containing the client-side stream and the target connection chosen by handle_socks5_tcp. If the target is direct, it asks the stream forwarder to copy bytes between client and server. If the target is MITM, it attaches the original target, network mode, and MITM state to the client stream, then calls the MITM stream processor. It returns success or an error from whichever path runs.

**Call relations**: run_socks5_with_listener installs this as the service used after a SOCKS5 TCP request has been accepted. It consumes the Socks5TcpConnection result produced by handle_socks5_tcp and hands MITM cases to mitm::mitm_stream.

*Call graph*: calls 1 internal fn (mitm_stream); 2 external calls (default, ProxyTarget).


##### `inspect_socks5_udp`  (lines 517–673)

```
async fn inspect_socks5_udp(
    request: RelayRequest,
    state: Arc<NetworkProxyState>,
    policy_decider: Option<Arc<dyn NetworkPolicyDecider>>,
) -> io::Result<RelayResponse>
```

**Purpose**: Checks whether a SOCKS5 UDP relay packet is allowed before the proxy forwards it. It is the UDP counterpart to the TCP policy checkpoint, with stricter mode rules.

**Data flow**: It receives a UDP relay request, shared proxy state, and an optional policy decider. It extracts the destination IP and port, normalizes the host string, reads client metadata, checks whether the proxy is enabled, blocks all UDP in limited mode, and then asks the host policy system whether this destination is allowed. If denied, it records and audits the block and returns a permission error. If allowed, it returns the original payload and extensions so the relay can continue.

**Call relations**: run_socks5_with_listener installs this as the UDP relay inspector when UDP support is enabled. It calls the same audit helper and policy error helper used by handle_socks5_tcp.

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

**Purpose**: Emits a structured audit event whenever SOCKS5 traffic is blocked. This gives logs and monitoring a consistent record of who was blocked, where they tried to connect, and why.

**Data flow**: It receives proxy state, the source of the decision, the reason string, protocol, host, port, and optional client address. It packages those values into BlockDecisionAuditEventArgs and sends them to the shared audit-event emitter. It does not return a value.

**Call relations**: handle_socks5_tcp and inspect_socks5_udp call this at each policy-denial point. It delegates the actual event writing to emit_block_decision_audit_event so SOCKS5 uses the same audit format as the rest of the proxy.

*Call graph*: calls 1 internal fn (emit_block_decision_audit_event); called by 2 (handle_socks5_tcp, inspect_socks5_udp).


##### `policy_denied_error`  (lines 698–703)

```
fn policy_denied_error(reason: &str, details: &PolicyDecisionDetails<'_>) -> io::Error
```

**Purpose**: Builds the permission-denied error returned to the SOCKS5 machinery when policy blocks a request. The message includes policy details rather than a vague failure.

**Data flow**: It receives a denial reason and detailed policy information. It formats a blocked message using blocked_message_with_policy, wraps it in an I/O error with PermissionDenied status, and returns that error.

**Call relations**: Both handle_socks5_tcp and inspect_socks5_udp use this when they need to stop traffic after a deny decision. It centralizes the wording of policy-denial errors.

*Call graph*: calls 1 internal fn (blocked_message_with_policy); called by 2 (handle_socks5_tcp, inspect_socks5_udp); 1 external calls (new).


##### `tests::StaticReloader::maybe_reload`  (lines 742–744)

```
fn maybe_reload(&self) -> ConfigReloaderFuture<'_, Option<ConfigState>>
```

**Purpose**: Implements the test config reloader’s “check for changes” operation by always saying there are no changes. Tests use this to keep configuration stable and predictable.

**Data flow**: It receives the test reloader and returns a boxed async result containing None. No state is changed.

**Call relations**: NetworkProxyState expects a ConfigReloader, so tests provide StaticReloader. state_for_settings builds that reloader, and this method satisfies the reload interface during test runs.

*Call graph*: 1 external calls (pin).


##### `tests::StaticReloader::reload_now`  (lines 746–748)

```
fn reload_now(&self) -> ConfigReloaderFuture<'_, ConfigState>
```

**Purpose**: Implements the test config reloader’s forced reload operation by returning the fixed test configuration. This gives tests a simple, known config source.

**Data flow**: It reads the stored ConfigState from StaticReloader, clones it, and returns it inside a boxed async result. The original stored state remains unchanged.

**Call relations**: NetworkProxyState can call this through the ConfigReloader interface. state_for_settings creates StaticReloader so tests can exercise normal state behavior without reading real config files.

*Call graph*: 2 external calls (pin, clone).


##### `tests::StaticReloader::source_label`  (lines 750–752)

```
fn source_label(&self) -> String
```

**Purpose**: Provides a human-readable name for the test reloader. This is useful in logs or errors that mention where configuration came from.

**Data flow**: It takes the reloader reference and returns the fixed string “static test reloader”. It reads no external data and changes nothing.

**Call relations**: This completes the ConfigReloader implementation used by test-created NetworkProxyState values. It is not part of live SOCKS5 request handling.


##### `tests::state_for_settings`  (lines 755–766)

```
fn state_for_settings(network: NetworkProxySettings) -> Arc<NetworkProxyState>
```

**Purpose**: Builds a NetworkProxyState for tests from a simple settings object. It saves each test from repeating the longer setup needed to create config state and a reloader.

**Data flow**: It receives NetworkProxySettings, wraps them in NetworkProxyConfig, builds a ConfigState with default constraints, creates a StaticReloader holding that state, and returns a shared NetworkProxyState. If MITM is enabled, it takes a lock so tests do not collide over shared test certificate files.

**Call relations**: All the tests in this file call this helper before exercising handle_socks5_tcp or inspect_socks5_udp. It connects test settings to the same state type used by production code.

*Call graph*: calls 2 internal fn (with_reloader, build_config_state); 2 external calls (new, default).


##### `tests::handle_socks5_tcp_emits_block_decision_for_proxy_disabled`  (lines 769–807)

```
async fn handle_socks5_tcp_emits_block_decision_for_proxy_disabled()
```

**Purpose**: Tests that SOCKS5 TCP is denied and audited when the whole proxy is disabled. This protects the expectation that the global on/off switch is enforced before traffic proceeds.

**Data flow**: It creates disabled proxy settings, builds state, creates a SOCKS5 TCP request for example.com:443, attaches state to the request, and runs handle_socks5_tcp while capturing emitted events. It expects an error, then checks that the captured policy event says deny, proxy_state, proxy_disabled, socks5_tcp, and the correct host and port.

**Call relations**: The test calls state_for_settings to build state and then directly calls handle_socks5_tcp. It uses the event-capture helpers to verify that the audit path triggered through emit_socks_block_decision_audit_event.

*Call graph*: calls 1 internal fn (default); 7 external calls (try_from, new, assert!, assert_eq!, capture_events, find_event_by_name, state_for_settings).


##### `tests::handle_socks5_tcp_uses_mitm_in_limited_mode`  (lines 810–832)

```
async fn handle_socks5_tcp_uses_mitm_in_limited_mode()
```

**Purpose**: Tests that limited-mode SOCKS5 TCP to HTTPS uses MITM inspection when MITM is configured. This confirms limited mode can still allow inspectable HTTPS traffic.

**Data flow**: It creates enabled limited-mode settings with MITM turned on and example.com allowed. It builds a request for example.com:443, runs handle_socks5_tcp, and expects success. The returned connection must be the MITM variant rather than a direct socket.

**Call relations**: The test sets up state with state_for_settings and calls handle_socks5_tcp directly. It verifies the branch that later causes proxy_socks5_tcp to call the MITM stream path.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_blocks_non_https_in_limited_mode`  (lines 835–878)

```
async fn handle_socks5_tcp_blocks_non_https_in_limited_mode()
```

**Purpose**: Tests that limited mode blocks SOCKS5 TCP to a non-HTTPS port. This matters because SOCKS5 only reveals host and port, so the proxy cannot safely inspect arbitrary non-443 traffic as HTTPS.

**Data flow**: It creates enabled limited-mode settings, allows example.com, builds a request for example.com:80, and runs handle_socks5_tcp while capturing events. It expects denial, then checks that the event records a mode_guard denial with method_not_allowed for socks5_tcp on port 80.

**Call relations**: The test calls state_for_settings and then handle_socks5_tcp. It verifies the limited-mode guard inside handle_socks5_tcp and the audit helper used when that guard blocks a request.

*Call graph*: calls 1 internal fn (default); 8 external calls (try_from, new, assert!, assert_eq!, capture_events, find_event_by_name, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_blocks_limited_mode_without_mitm_state`  (lines 881–905)

```
async fn handle_socks5_tcp_blocks_limited_mode_without_mitm_state()
```

**Purpose**: Tests that limited-mode HTTPS is blocked if MITM inspection is required but no MITM state exists. This prevents traffic from slipping through when the proxy cannot enforce the intended HTTPS policy.

**Data flow**: It creates enabled limited-mode settings without MITM enabled, allows example.com, builds a request for example.com:443, and runs handle_socks5_tcp. It expects an error whose text mentions that MITM is required.

**Call relations**: This test exercises handle_socks5_tcp’s MITM-requirement branch. It uses state_for_settings for setup and confirms the function refuses to return either a direct connection or a MITM connection when inspection state is missing.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode`  (lines 908–939)

```
async fn handle_socks5_tcp_uses_mitm_for_hooked_host_in_full_mode()
```

**Purpose**: Tests that a host with configured MITM hooks is inspected even in full network mode. A hook means the proxy needs to see HTTPS request details such as method or path.

**Data flow**: It creates full-mode settings with MITM enabled and a hook for api.github.com, allows that domain, and builds a request to api.github.com:443. After running handle_socks5_tcp, it expects the returned connection to be the MITM variant.

**Call relations**: The test calls state_for_settings and handle_socks5_tcp. It verifies that host-specific MITM hooks influence the connection choice that proxy_socks5_tcp will later act on.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode`  (lines 942–976)

```
async fn handle_socks5_tcp_blocks_hooked_non_https_host_in_full_mode()
```

**Purpose**: Tests that a hooked host on a non-HTTPS port is blocked instead of being passed through. The proxy cannot apply HTTPS MITM hooks to traffic that is not identifiable as HTTPS.

**Data flow**: It creates full-mode settings with MITM enabled and a hook for api.github.com, allows the domain, and builds a request to api.github.com:80. It runs handle_socks5_tcp and expects an error mentioning that MITM is required.

**Call relations**: This test targets the MITM safety check inside handle_socks5_tcp. It confirms that hooks do not cause unsafe inspection attempts and do not allow an uninspectable direct connection.

*Call graph*: calls 3 internal fn (default, new, handle_socks5_tcp); 5 external calls (try_from, new, assert!, state_for_settings, vec!).


##### `tests::inspect_socks5_udp_emits_block_decision_for_mode_guard_deny`  (lines 979–1015)

```
async fn inspect_socks5_udp_emits_block_decision_for_mode_guard_deny()
```

**Purpose**: Tests that SOCKS5 UDP is blocked and audited in limited mode. This protects the rule that limited mode does not allow UDP relay traffic.

**Data flow**: It creates enabled limited-mode state, builds a UDP relay request to 93.184.216.34:53, and runs inspect_socks5_udp while capturing events. It expects an error, then checks that the captured policy event records a mode_guard denial with method_not_allowed for socks5_udp and the correct destination.

**Call relations**: The test calls state_for_settings and then inspect_socks5_udp directly. It verifies the UDP limited-mode branch and the shared SOCKS block audit helper.

*Call graph*: calls 1 internal fn (default); 10 external calls (default, new, V4, new, new, assert!, assert_eq!, capture_events, find_event_by_name, state_for_settings).
