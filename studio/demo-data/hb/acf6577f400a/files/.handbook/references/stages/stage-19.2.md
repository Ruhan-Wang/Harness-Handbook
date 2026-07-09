# App-server, exec-server, and relay transport channels  `stage-19.2`

This stage is shared behind-the-scenes plumbing. It is the set of “pipes” that lets different parts of the system talk to each other, whether they are on the same machine, behind an app server, or reached through a remote exec server.

The app-server transport module defines the common events for connections: a client opens a link, sends a message, or receives a reply. Remote-control segmenting acts like cutting a large parcel into numbered boxes, then rebuilding it safely while rejecting bad pieces. The remote-control clients code uses authenticated HTTP calls to list connected devices and revoke them.

On the exec-server side, the HTTP client module gathers the ways to make requests, while the response-body stream reads replies a chunk at a time and matches remote chunks to the right request. The remote file stream does the same for files, reading safe-sized pieces and closing the remote file afterward.

The relay pieces carry messages over WebSockets. Noise channels encrypt and authenticate them. Framing splits large JSON-RPC messages into allowed record sizes, and ordered ciphertext makes sure encrypted records arrive in the exact order needed.

## Files in this stage

### App transport foundation
These modules define the shared app-server transport layer and the remote-control-specific message and client-management pieces built on top of it.

### `app-server-transport/src/transport/mod.rs`

`io_transport` · `startup and request handling`

This file ties together the different ways the app server can talk to the outside world: standard input/output, Unix sockets, WebSockets, remote control, or no listener at all. A transport is like a front desk for the server. It accepts visitors through different doors, gives each visitor an ID, and passes their messages to the rest of the application in a consistent form.

It defines the listening choices in AppServerTransport and parses strings such as `stdio://`, `unix://`, `ws://IP:PORT`, and `off`. For Unix sockets, it also knows the default control socket and startup lock file names under the Codex home directory. These paths matter because they let another process find and safely start or contact the app server.

The file also defines TransportEvent, the shared event format used by lower-level connection code to tell the main server what happened: a connection opened, a connection closed, or a JSON-RPC message arrived. JSON-RPC is a simple request/response message format encoded as JSON.

A key detail is overload protection. Incoming messages go through a bounded queue, meaning it can only hold a fixed number of items. If a new request arrives while the queue is full, the server sends back a clear “Server overloaded; retry later” error instead of silently blocking forever. Responses and notifications are treated differently: some are allowed to wait so important protocol flow is not lost.

#### Function details

##### `app_server_control_socket_path`  (lines 56–62)

```
fn app_server_control_socket_path(codex_home: &Path) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Builds the default filesystem path for the app server’s Unix control socket. This is the socket file other local processes can use to connect to the running server.

**Data flow**: It receives the Codex home directory path. It appends the app-server control directory name and socket filename, then checks that the result is an absolute path wrapper the rest of the code can trust. It returns that validated absolute path or an I/O-style error if the path cannot be accepted.

**Call relations**: When AppServerTransport::from_listen_url sees `unix://` with no explicit path, it calls this function to fill in the standard socket location. This keeps the default Unix socket path in one place instead of scattering the directory and filename rules around the codebase.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (from_listen_url); 1 external calls (join).


##### `app_server_startup_lock_path`  (lines 64–70)

```
fn app_server_startup_lock_path(codex_home: &Path) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Builds the default filesystem path for the startup lock file used when starting the app server. The lock file helps stop two server instances from racing to start at the same time.

**Data flow**: It receives the Codex home directory path. It appends the app-server control directory name and the startup lock filename, then returns a validated absolute path or an error if that validation fails.

**Call relations**: The main startup path, represented in the call graph by run_main_with_transport_options, uses this function when it needs the lock file location. It is the companion to the control socket path: one file is for talking to the server, the other is for coordinating startup safely.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (run_main_with_transport_options); 1 external calls (join).


##### `AppServerTransportParseError::fmt`  (lines 88–106)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Turns transport parsing errors into clear human-readable messages. This is what a user or log reader sees when a `--listen` value is wrong.

**Data flow**: It receives a specific parse error, such as an unsupported URL or a bad socket path. It writes a sentence explaining what was wrong and, when useful, what formats are accepted. The result is formatted text, not a changed program state.

**Call relations**: This function is used automatically by Rust’s display machinery when the error needs to be printed. It sits on the boundary between internal error types and the person trying to understand why startup failed.

*Call graph*: 1 external calls (write!).


##### `AppServerTransport::from_listen_url`  (lines 114–158)

```
fn from_listen_url(listen_url: &str) -> Result<Self, AppServerTransportParseError>
```

**Purpose**: Converts a user-facing listen setting into the server’s internal transport choice. Someone uses this when turning command-line or configuration text into a real connection mode.

**Data flow**: It receives a string such as `stdio://`, `unix://`, `unix:///tmp/server.sock`, `ws://127.0.0.1:9000`, or `off`. It checks the prefix, resolves paths when needed, parses WebSocket addresses, and returns the matching AppServerTransport value. If the text is invalid, it returns a precise parse error explaining the problem.

**Call relations**: This is the main parser for transport selection. It calls app_server_control_socket_path when a default Unix socket path is needed, asks find_codex_home where the Codex home directory is, and uses path/address parsing helpers for the formats that need them. Tests and remote-control startup flows rely on it to reject or accept listen settings consistently.

*Call graph*: calls 3 internal fn (app_server_control_socket_path, find_codex_home, relative_to_current_dir); called by 1 (explicit_remote_control_startup_fails_when_disabled_by_requirements); 1 external calls (UnsupportedListenUrl).


##### `AppServerTransport::from_str`  (lines 164–166)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Lets AppServerTransport be parsed through Rust’s standard string-parsing pattern. This makes the transport type easier to use with generic configuration or command-line parsing code.

**Data flow**: It receives a string slice. It passes that string directly to AppServerTransport::from_listen_url and returns the same success or error result.

**Call relations**: This is a thin adapter around from_listen_url. Its role is not to add new behavior, but to let other code say “parse this string as an AppServerTransport” using the usual FromStr interface.

*Call graph*: 1 external calls (from_listen_url).


##### `next_connection_id`  (lines 196–198)

```
fn next_connection_id() -> ConnectionId
```

**Purpose**: Creates a fresh numeric ID for a new connection. These IDs let the server tell different clients apart after their messages enter shared queues.

**Data flow**: It reads and increments a process-wide atomic counter. Atomic means it is safe for multiple asynchronous tasks or threads to ask for IDs without accidentally getting the same one. It returns the old counter value wrapped as a ConnectionId.

**Call relations**: Connection-opening code in the transport modules uses this helper when a new client arrives. The ID it returns later appears in TransportEvent values and outgoing-message routing, so replies can go back to the right connection.

*Call graph*: 1 external calls (new).


##### `forward_incoming_message`  (lines 200–215)

```
async fn forward_incoming_message(
    transport_event_tx: &mpsc::Sender<TransportEvent>,
    writer: &mpsc::Sender<QueuedOutgoingMessage>,
    connection_id: ConnectionId,
    payload: &str,
) -> boo
```

**Purpose**: Takes raw text received from a connection, tries to understand it as a JSON-RPC message, and forwards it into the server’s event queue. It is the bridge between bytes from the outside world and typed messages inside the app.

**Data flow**: It receives the main transport event sender, the connection’s outgoing writer queue, the connection ID, and a text payload. It tries to parse the payload as JSON-RPC. If parsing succeeds, it hands the typed message to enqueue_incoming_message. If parsing fails, it logs the problem and keeps the connection alive by returning true.

**Call relations**: Lower-level transport code calls this when a line or frame of input arrives. It delegates the queueing policy to enqueue_incoming_message so all transports share the same overload behavior.

*Call graph*: calls 1 internal fn (enqueue_incoming_message); 1 external calls (error!).


##### `enqueue_incoming_message`  (lines 217–256)

```
async fn enqueue_incoming_message(
    transport_event_tx: &mpsc::Sender<TransportEvent>,
    writer: &mpsc::Sender<QueuedOutgoingMessage>,
    connection_id: ConnectionId,
    message: JSONRPCMessage
```

**Purpose**: Places a parsed incoming message onto the main server event queue, while protecting the server from overload. If the server is too busy to accept a new request, it tries to send the client a polite retry-later error.

**Data flow**: It receives the event queue, the connection’s outgoing writer queue, the connection ID, and a parsed JSON-RPC message. It wraps the message in a TransportEvent and tries to send it without waiting. If the queue is closed, it returns false to signal that processing should stop. If the queue is full and the message is a request, it builds an overload error using that request’s ID and tries to send it back through the writer queue. If the full queue contains another kind of event, it waits until it can send it. It returns true as long as the connection can continue.

**Call relations**: forward_incoming_message calls this for normal incoming traffic. The tests call it directly to prove the overload rules: requests get an immediate error when the main queue is full, responses wait instead of being dropped, and a full outgoing writer queue does not make the server block while trying to report overload.

*Call graph*: calls 1 internal fn (new); called by 3 (forward_incoming_message, enqueue_incoming_request_does_not_block_when_writer_queue_is_full, enqueue_incoming_response_waits_instead_of_dropping_when_queue_is_full); 4 external calls (send, try_send, Error, warn!).


##### `serialize_outgoing_message`  (lines 258–273)

```
fn serialize_outgoing_message(outgoing_message: OutgoingMessage) -> Option<String>
```

**Purpose**: Turns an internal outgoing message into a JSON string ready to write to a connection. This is the last translation step before data leaves the server.

**Data flow**: It receives an OutgoingMessage. It first converts it into a general JSON value, then converts that value into a compact JSON text string. If either conversion fails, it logs the error and returns nothing; otherwise it returns the serialized string.

**Call relations**: Transport writer code uses this kind of function when sending replies, notifications, or errors back to clients. It keeps serialization failure handling in one shared place, so individual transports do not each need to decide how to log those failures.

*Call graph*: 3 external calls (error!, to_string, to_value).


##### `tests::listen_off_parses_as_off_transport`  (lines 290–295)

```
fn listen_off_parses_as_off_transport()
```

**Purpose**: Checks that the special listen value `off` really disables the transport listener. This protects a small but important startup option from being broken by future parser changes.

**Data flow**: It calls the listen URL parser with `off`. It compares the result with the expected AppServerTransport::Off value. The test passes if the parser returns Off and fails otherwise.

**Call relations**: This test exercises AppServerTransport::from_listen_url through one of its simplest branches. It documents that `off` is an intentional supported value, not just an unsupported URL.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::enqueue_incoming_request_returns_overload_error_when_queue_is_full`  (lines 298–356)

```
async fn enqueue_incoming_request_returns_overload_error_when_queue_is_full()
```

**Purpose**: Checks that an incoming request receives a clear overload error when the main transport queue is already full. This matters because requests expect replies, and dropping them would leave clients waiting.

**Data flow**: It creates a tiny event queue and fills it with one notification. Then it tries to enqueue a request. Because the queue is full, the function under test should not add the request; instead it should place an overload error into the outgoing writer queue. The test reads both queues and confirms the original event stayed queued and the outgoing error has the right request ID and message.

**Call relations**: This test calls enqueue_incoming_message directly to exercise the full-queue request path. It proves the overload branch builds an OutgoingMessage error instead of blocking or silently losing the request.

*Call graph*: 10 external calls (Notification, Request, Integer, new, assert!, assert_eq!, json!, channel, panic!, to_value).


##### `tests::enqueue_incoming_response_waits_instead_of_dropping_when_queue_is_full`  (lines 359–425)

```
async fn enqueue_incoming_response_waits_instead_of_dropping_when_queue_is_full()
```

**Purpose**: Checks that responses are not replaced with overload errors when the main queue is full. Responses are part of an existing conversation, so the server should wait for room rather than discard them.

**Data flow**: It fills a one-item event queue, then starts enqueue_incoming_message with a response in a separate asynchronous task. After the test removes the first queued event, space becomes available. The enqueue operation should finish successfully, and the test then confirms the response appears in the event queue unchanged.

**Call relations**: This test calls enqueue_incoming_message directly and focuses on the non-request full-queue behavior. It complements the request overload test by showing that different JSON-RPC message kinds are treated differently on purpose.

*Call graph*: calls 1 internal fn (enqueue_incoming_message); 10 external calls (Notification, Response, Integer, new, assert!, assert_eq!, json!, channel, panic!, spawn).


##### `tests::enqueue_incoming_request_does_not_block_when_writer_queue_is_full`  (lines 428–489)

```
async fn enqueue_incoming_request_does_not_block_when_writer_queue_is_full()
```

**Purpose**: Checks that overload reporting does not get stuck if the outgoing writer queue is also full. This prevents a busy or stalled client from freezing the input side of the server.

**Data flow**: It fills the main event queue and also fills the outgoing writer queue with an existing notification. Then it tries to enqueue a new request while both queues are full, with a short timeout around the operation. The expected result is that enqueue_incoming_message returns quickly and leaves the original outgoing message in place, even though it could not send the overload error.

**Call relations**: This test calls enqueue_incoming_message directly to cover the worst-case overload path. It verifies the warning-and-drop behavior for the overload response, which keeps the transport task responsive under pressure.

*Call graph*: calls 2 internal fn (new, enqueue_incoming_message); 13 external calls (from_millis, ConfigWarning, Notification, Request, Integer, new, AppServerNotification, assert!, assert_eq!, json! (+3 more)).


### `app-server-transport/src/transport/remote_control/segment.rs`

`io_transport` · `message handling`

Remote-control messages travel inside envelopes. Most envelopes can be sent as they are, but some JSON-RPC messages can be too large for the transport to carry safely in one piece. This file acts like a postal clerk for oversized packages: it cuts a big package into numbered boxes, labels each box, and later checks the labels before putting the package back together.

On the incoming client side, `ClientSegmentReassembler` watches for chunked client messages. It keeps one unfinished assembly per client, checks that chunks arrive in the expected order, decodes each chunk from base64 (a text-safe way to carry raw bytes), and finally parses the rebuilt bytes as a JSON-RPC message. If anything looks unsafe or inconsistent, such as missing IDs, too many chunks, a changed stream, bad base64, or a wrong final size, it drops the partial message instead of forwarding corrupted data.

On the outgoing server side, `split_server_envelope_for_transport` measures a server envelope. If it is small enough, it leaves it alone. If it is too large, it serializes the message, slices it into chunks, wraps each chunk in a new envelope, and makes sure every resulting envelope stays under the size limit. The file also has small helpers for measuring serialized JSON without storing it and for building chunk envelopes consistently.

#### Function details

##### `ClientSegmentReassembler::observe`  (lines 51–224)

```
fn observe(&mut self, envelope: ClientEnvelope) -> ClientSegmentObservation
```

**Purpose**: This is the main incoming-message checkpoint for segmented client messages. It either forwards normal messages unchanged, stores a valid chunk while waiting for the rest, rebuilds a complete message, or drops unsafe or invalid chunks.

**Data flow**: It receives a `ClientEnvelope`. If the envelope is not a chunk, it comes out unchanged as something to forward. If it is a chunk, the function reads its client ID, stream ID, sequence ID, chunk number, total chunk count, expected final size, and base64 text. It validates those details, adds the decoded bytes to the current assembly for that client, and when the last chunk arrives it turns the rebuilt bytes into a `JSONRPCMessage`. The result is one of three outcomes: forward a full envelope, report that the message is still pending, or say the data was dropped.

**Call relations**: This is called by `observe_client_message` when client traffic is being inspected. It asks `ClientSegmentMetadata::from_envelope` to extract the labels needed for reassembly, uses `should_ignore_chunk` to reject stale repeats early, may call `evict_assemblies_if_full` before starting a new partial message, and uses `remove_assembly` when a stream is finished or must be abandoned.

*Call graph*: calls 4 internal fn (from_envelope, evict_assemblies_if_full, remove_assembly, should_ignore_chunk); called by 1 (observe_client_message); 8 external calls (new, now, new, Complete, Forward, decoded_len_estimate, min, warn!).


##### `ClientSegmentReassembler::invalidate_stream`  (lines 226–228)

```
fn invalidate_stream(&mut self, client_id: &ClientId, stream_id: &StreamId)
```

**Purpose**: This clears any unfinished chunk assembly for a particular client stream. It is used when that stream should no longer accept old partial data.

**Data flow**: It receives a client ID and a stream ID. It checks whether the stored partial assembly for that client belongs to that exact stream. If it does, the partial bytes and progress are removed; if not, nothing changes.

**Call relations**: This is called by `observe_client_message` when the surrounding message flow knows a stream has become invalid or ended. It delegates the actual conditional removal to `remove_assembly`, so stream-specific cleanup follows the same rule used inside `observe`.

*Call graph*: calls 1 internal fn (remove_assembly); called by 1 (observe_client_message).


##### `ClientSegmentReassembler::invalidate_client`  (lines 230–232)

```
fn invalidate_client(&mut self, client_id: &ClientId)
```

**Purpose**: This forgets all unfinished segmented message state for one client. It is useful when a client disconnects or must be reset.

**Data flow**: It receives a client ID and removes that client's entry from the map of in-progress assemblies. Any partially collected chunks for that client are discarded, and there is no returned value.

**Call relations**: This is a direct cleanup hook for higher-level code. Unlike `invalidate_stream`, it does not check a stream ID; it removes the whole client assembly at once.


##### `ClientSegmentReassembler::should_ignore_chunk`  (lines 234–247)

```
fn should_ignore_chunk(
        &self,
        client_id: &ClientId,
        stream_id: &StreamId,
        seq_id: u64,
        segment_id: usize,
    ) -> bool
```

**Purpose**: This answers whether an incoming chunk is old news and should be ignored. It prevents duplicate or older chunks from disturbing an assembly that has already moved forward.

**Data flow**: It receives a client ID, stream ID, sequence ID, and chunk number. It looks up the current partial assembly for that client. If the assembly is for the same stream and the incoming chunk belongs to an older message, or to an already-accepted earlier chunk of the same message, it returns `true`; otherwise it returns `false`.

**Call relations**: `observe` calls this near the start so stale data can be dropped before doing more work. `observe_client_message` also calls it to make the same early decision in the wider client-message flow.

*Call graph*: called by 2 (observe, observe_client_message).


##### `ClientSegmentReassembler::remove_assembly`  (lines 249–257)

```
fn remove_assembly(&mut self, client_id: &ClientId, stream_id: &StreamId)
```

**Purpose**: This removes a partial message only if it belongs to the stream being cleaned up. That avoids accidentally deleting a newer assembly from another stream for the same client.

**Data flow**: It receives a client ID and stream ID. It checks the stored assembly for that client. If the stored stream matches the given stream, it deletes the assembly; otherwise the stored data is left alone.

**Call relations**: This is the shared cleanup helper used by `observe` after errors or successful completion, and by `invalidate_stream` during explicit stream cleanup.

*Call graph*: called by 2 (invalidate_stream, observe).


##### `ClientSegmentReassembler::evict_assemblies_if_full`  (lines 259–271)

```
fn evict_assemblies_if_full(&mut self)
```

**Purpose**: This keeps the reassembler from holding too many unfinished messages at once. If the storage is full, it discards the least recently updated assemblies until there is room.

**Data flow**: It reads the map of in-progress client assemblies. While the map is at or above its allowed capacity, it finds the assembly with the oldest `last_chunk_seen_at` timestamp and removes it. It returns nothing; the effect is freeing memory and space for new chunked messages.

**Call relations**: `observe` calls this before creating a new assembly for a client. That way a flood of incomplete segmented messages cannot grow the in-memory tracking table without limit.

*Call graph*: called by 1 (observe).


##### `ClientSegmentMetadata::from_envelope`  (lines 282–296)

```
fn from_envelope(envelope: &ClientEnvelope) -> Option<Self>
```

**Purpose**: This extracts the identifying information that says which segmented message a chunk belongs to. Without this metadata, the reassembler cannot safely know how to combine chunks.

**Data flow**: It receives a client envelope. If the envelope contains a client message chunk and has a sequence ID, it returns a small metadata value containing the sequence ID, total segment count, and expected final byte size. If the envelope is not a chunk or lacks the needed sequence ID, it returns nothing.

**Call relations**: `observe` calls this when it sees a chunk. The returned metadata is then compared with any existing assembly to make sure all chunks are from the same logical message.

*Call graph*: called by 1 (observe).


##### `split_server_envelope_for_transport`  (lines 299–385)

```
fn split_server_envelope_for_transport(
    envelope: ServerEnvelope,
) -> io::Result<Vec<ServerEnvelope>>
```

**Purpose**: This prepares outgoing server envelopes for the transport size limits. Small messages pass through unchanged; large server messages are split into numbered base64 chunks.

**Data flow**: It receives a `ServerEnvelope`. If the envelope is not a server message, or if its serialized JSON size is already small enough, it returns a one-item list containing the original envelope. For a large server message, it serializes the inner message to bytes, checks the total size limit, chooses a chunk size, verifies that every chunk envelope will fit, and returns a list of chunk envelopes. If the message cannot be safely split within the limits, it returns an empty list rather than sending invalid oversized data.

**Call relations**: This is used by `run_server_writer_inner` during outgoing transport writing, and by tests such as `splits_large_server_messages_into_wire_chunks`. It relies on `serialized_len` to measure JSON size, `serialized_chunk_len` to test proposed chunks, and ultimately `build_chunk_envelope` to create each wire-ready chunk.

*Call graph*: calls 2 internal fn (serialized_chunk_len, serialized_len); called by 2 (splits_large_server_messages_into_wire_chunks, run_server_writer_inner); 8 external calls (new, matches!, to_vec, unreachable!, max, min, vec!, warn!).


##### `serialized_chunk_len`  (lines 387–401)

```
fn serialized_chunk_len(
    envelope: &ServerEnvelope,
    segment_id: usize,
    segment_count: usize,
    message_size_bytes: usize,
    chunk: &[u8],
) -> io::Result<usize>
```

**Purpose**: This measures how large one proposed chunk envelope would be after JSON serialization. It helps the splitter choose chunks that fit the transport limit.

**Data flow**: It receives the original server envelope, a chunk number, the total chunk count, the full message size, and the chunk bytes. It first builds the chunk envelope, then measures the serialized length of that envelope. It returns the byte count or an I/O-style error if the chunk envelope cannot be built or serialized.

**Call relations**: `split_server_envelope_for_transport` calls this repeatedly while searching for a safe chunk size. It uses `build_chunk_envelope` for the proposed wrapper and `serialized_len` for the actual measurement.

*Call graph*: calls 2 internal fn (build_chunk_envelope, serialized_len); called by 1 (split_server_envelope_for_transport).


##### `CountingWriter::write`  (lines 409–412)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: This pretends to write bytes but only counts them. It is a lightweight way to measure serialized output without saving the output itself.

**Data flow**: It receives a byte slice from a serializer. Instead of storing or sending those bytes, it adds their length to its internal counter and reports that all bytes were accepted.

**Call relations**: This method is used indirectly by `serialized_len` when `serde_json` writes JSON into a `CountingWriter`. The serializer thinks it is writing normally, while this writer simply keeps score.


##### `CountingWriter::flush`  (lines 414–416)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: This satisfies the standard writer interface for `CountingWriter`. Since nothing is actually buffered or sent, flushing has no real work to do.

**Data flow**: It receives a request to flush pending output. Because `CountingWriter` only counts bytes and holds no pending data, it immediately returns success and changes nothing.

**Call relations**: This is part of the writer behavior needed by `serde_json::to_writer` inside `serialized_len`. It exists so `CountingWriter` can be used wherever a normal writer is expected.


##### `serialized_len`  (lines 419–423)

```
fn serialized_len(value: &impl serde::Serialize) -> io::Result<usize>
```

**Purpose**: This calculates how many bytes a value would take if written as JSON. It avoids creating a temporary JSON string just to measure its length.

**Data flow**: It receives any value that can be serialized. It creates a fresh `CountingWriter`, asks `serde_json` to write the value into it, and then returns the number of bytes the writer counted. If serialization fails, the error is converted into an I/O-style error.

**Call relations**: `split_server_envelope_for_transport` uses this to decide whether an envelope is too large. `serialized_chunk_len` also uses it to test each possible chunk envelope.

*Call graph*: called by 2 (serialized_chunk_len, split_server_envelope_for_transport); 2 external calls (default, to_writer).


##### `build_chunk_envelope`  (lines 425–449)

```
fn build_chunk_envelope(
    envelope: &ServerEnvelope,
    segment_id: usize,
    segment_count: usize,
    message_size_bytes: usize,
    chunk: &[u8],
) -> io::Result<ServerEnvelope>
```

**Purpose**: This creates a server envelope that carries one piece of a larger message. It preserves the original routing details while replacing the event with a numbered base64 chunk.

**Data flow**: It receives the original server envelope, the chunk number, total chunk count, full message size, and raw chunk bytes. It checks that the total chunk count is not above the allowed maximum, encodes the chunk bytes as base64 text, and returns a new `ServerEnvelope` with the same client ID, stream ID, and sequence ID as the original. If the chunk count is too high, it returns an error.

**Call relations**: `serialized_chunk_len` calls this when measuring candidate chunks. In the main splitting path, `split_server_envelope_for_transport` creates final chunk envelopes using the same construction logic so every segment has consistent labels.

*Call graph*: called by 1 (serialized_chunk_len); 1 external calls (new).


### `app-server-transport/src/transport/remote_control/clients.rs`

`io_transport` · `request handling`

This file is the bridge between the app server and the remote-control client management API. In human terms, it lets the app ask, “Which devices are allowed to control this environment?” and “Remove this device’s access.” Without it, the higher-level commands for listing and revoking remote-control clients would have no safe, consistent way to contact the remote service.

The file first validates the caller’s request. For example, listing clients must include an environment ID, and the requested page size must be reasonable. It then builds the correct web address for that environment’s client list. For listing it sends an HTTP GET request; for revoking it sends an HTTP DELETE request. HTTP is the standard request/response protocol used on the web.

Authentication is important here. The request includes saved remote-control credentials and an account ID header. If the server replies “401 Unauthorized,” the file asks the authentication system to recover or refresh credentials, then retries once. This is like trying a locked door, realizing the key is stale, getting a fresh key, and trying one more time.

After a response comes back, the file checks whether the status means success. If not, it creates a useful error that includes the HTTP status, response headers, and a short preview of the body. For successful list responses, it decodes the returned JSON and converts timestamps into Unix time, which is a simple number of seconds since 1970.

#### Function details

##### `list_remote_control_clients`  (lines 70–123)

```
async fn list_remote_control_clients(
    remote_control_url: &str,
    auth_manager: &Arc<AuthManager>,
    params: RemoteControlClientsListParams,
) -> io::Result<RemoteControlClientsListResponse>
```

**Purpose**: Lists the remote-control clients registered for one environment. A caller uses this when it needs to show or inspect the devices or apps that can connect to that environment.

**Data flow**: It receives a base remote-control URL, an authentication manager, and list options such as environment ID, cursor, limit, and sort order. It first rejects missing or invalid inputs, builds the environment-specific clients URL, sends an authenticated list request, checks that the HTTP response succeeded, then decodes the JSON body. It returns a local list response containing clean `RemoteControlClient` records and an optional cursor for the next page.

**Call relations**: Higher-level code such as `list_clients` calls this when a user or API request asks for the client list. Inside, it relies on `environment_clients_url` to form the endpoint, `send_client_management_request` to perform the authenticated network call, `preview_remote_control_response_body` to make error messages readable, and `ensure_success_response` to turn failed HTTP statuses into meaningful local errors. Tests call it to verify parsing errors keep useful context and that authentication recovery is retried correctly.

*Call graph*: calls 4 internal fn (ensure_success_response, environment_clients_url, send_client_management_request, preview_remote_control_response_body); called by 4 (list_clients, list_remote_control_clients_preserves_decode_error_context, list_remote_control_clients_recovers_auth_after_unauthorized, list_remote_control_clients_retries_unauthorized_only_once); 1 external calls (new).


##### `revoke_remote_control_client`  (lines 125–165)

```
async fn revoke_remote_control_client(
    remote_control_url: &str,
    auth_manager: &Arc<AuthManager>,
    params: RemoteControlClientsRevokeParams,
) -> io::Result<RemoteControlClientsRevokeRespon
```

**Purpose**: Revokes one remote-control client’s access to an environment. A caller uses this when a device or app should no longer be allowed to connect.

**Data flow**: It receives the base remote-control URL, the authentication manager, and revoke parameters containing the environment ID and client ID. It rejects missing IDs, builds the clients URL for the environment, appends the specific client ID, sends an authenticated delete request, and checks that the service accepted it. On success it returns an empty revoke response, meaning there is no extra data to report.

**Call relations**: Higher-level code such as `revoke_client` calls this when access should be removed. It shares the same helper path as listing: `environment_clients_url` builds the base endpoint, `send_client_management_request` sends the authenticated HTTP request, `preview_remote_control_response_body` prepares readable failure details, and `ensure_success_response` decides whether the server reply counts as success. A test checks that forbidden responses are not treated like recoverable unauthorized responses.

*Call graph*: calls 4 internal fn (ensure_success_response, environment_clients_url, send_client_management_request, preview_remote_control_response_body); called by 2 (revoke_client, revoke_remote_control_client_does_not_retry_forbidden); 1 external calls (new).


##### `send_client_management_request`  (lines 167–183)

```
async fn send_client_management_request(
    auth_manager: &Arc<AuthManager>,
    request: ClientManagementRequest<'_>,
    action: &str,
) -> io::Result<ClientManagementResponse>
```

**Purpose**: Sends one client-management request with authentication, and retries once if the server says the credentials are unauthorized and recovery succeeds. This keeps list and revoke operations from each having to duplicate the same login-recovery logic.

**Data flow**: It receives the authentication manager, a description of the request to send, and a short action name for error messages. It loads the current remote-control authentication, sends the request once, and examines the HTTP status. If the status is not 401, or if authentication recovery cannot happen, it returns that first response. If recovery succeeds, it reloads authentication and sends the same request one more time, returning the second response.

**Call relations**: `list_remote_control_clients` and `revoke_remote_control_client` both call this before they inspect the server response. This function delegates the actual HTTP work to `send_client_management_request_once`, and delegates credential loading and recovery to `load_remote_control_auth` and `recover_remote_control_auth`. It is the small coordinator that makes authentication retry behavior consistent for both operations.

*Call graph*: calls 3 internal fn (load_remote_control_auth, recover_remote_control_auth, send_client_management_request_once); called by 2 (list_remote_control_clients, revoke_remote_control_client).


##### `send_client_management_request_once`  (lines 185–235)

```
async fn send_client_management_request_once(
    auth: &RemoteControlConnectionAuth,
    request: &ClientManagementRequest<'_>,
    action: &str,
) -> io::Result<ClientManagementResponse>
```

**Purpose**: Performs a single HTTP request to the remote-control service using the supplied authentication. It does not decide whether to retry; it only sends once and collects the raw response.

**Data flow**: It receives authenticated connection information, either a list or revoke request, and an action label for error text. It builds an HTTP client, asks the authentication provider to add its headers, adds the remote-control account ID header, and creates either a GET request with query parameters or a DELETE request. It applies a 30-second timeout, sends the request, reads the status, headers, and body bytes, then returns them together in a simple response struct.

**Call relations**: `send_client_management_request` calls this for the first attempt and, if needed, for the one retry after authentication recovery. It uses `build_reqwest_client` to create the network client and the request library’s timeout feature so a stuck remote service does not hang the caller forever.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (send_client_management_request); 3 external calls (new, new, timeout).


##### `ensure_success_response`  (lines 237–260)

```
fn ensure_success_response(
    status: axum::http::StatusCode,
    headers: &HeaderMap,
    url: &Url,
    body_preview: &str,
    response_kind: &str,
) -> io::Result<()>
```

**Purpose**: Checks whether an HTTP response status means success, and turns failures into local errors with helpful categories and details. This gives callers clear reasons such as invalid input, permission denied, or not found.

**Data flow**: It receives the HTTP status, response headers, URL, a short preview of the body, and a label describing what kind of response was expected. If the status is successful, it returns nothing and lets the caller continue. If not, it maps common HTTP codes to suitable `io::ErrorKind` values and returns an error message that includes the URL, status, formatted headers, and body preview.

**Call relations**: Both `list_remote_control_clients` and `revoke_remote_control_client` call this after the network request returns. It is the shared gatekeeper before list results are decoded or revoke success is reported, ensuring failed server replies do not accidentally look like successful operations.

*Call graph*: called by 2 (list_remote_control_clients, revoke_remote_control_client); 4 external calls (as_u16, is_success, new, format!).


##### `environment_clients_url`  (lines 262–276)

```
fn environment_clients_url(remote_control_url: &str, environment_id: &str) -> io::Result<Url>
```

**Purpose**: Builds the exact remote-control API URL for the clients belonging to one environment. It keeps URL construction in one place so list and revoke requests use the same path shape.

**Data flow**: It receives the remote-control base URL as text and an environment ID. It normalizes the base URL, joins it with the fixed remote-control environments path, then appends the environment ID and `clients` path segment. It returns the completed URL or an input error if the base URL cannot be used that way.

**Call relations**: `list_remote_control_clients` calls this to get the collection URL for listing clients. `revoke_remote_control_client` calls it too, then appends one client ID to target a single client. It relies on `normalize_remote_control_base_url` so callers can pass a base URL in a consistent, forgiving way.

*Call graph*: calls 1 internal fn (normalize_remote_control_base_url); called by 2 (list_remote_control_clients, revoke_remote_control_client).


##### `RemoteControlClient::try_from`  (lines 281–306)

```
fn try_from(client: RemoteControlClientResponse) -> Result<Self, Self::Error>
```

**Purpose**: Converts the raw client record received from the remote-control service into the app’s public client record type. It also validates and translates the optional last-seen timestamp into a simpler numeric form.

**Data flow**: It receives a decoded `RemoteControlClientResponse`, which mirrors the JSON fields from the service. It copies over identifiers and optional device details such as display name, platform, model, and app version. If `last_seen_at` is present, it parses the RFC 3339 timestamp format, which is a standard date-time text format, and converts it to a Unix timestamp. It returns a `RemoteControlClient`, or an invalid-data error if the timestamp cannot be parsed.

**Call relations**: `list_remote_control_clients` uses this conversion for every item returned by the service before handing the list back to its caller. This keeps the rest of the app from depending on the remote service’s raw JSON shape and catches bad timestamp data at the boundary.


### Exec HTTP and file streams
These files expose exec-server client-side transport facades for HTTP responses and remote file contents as unified local async streams.

### `exec-server/src/client/http_client.rs`

`io_transport` · `request handling and cross-cutting client setup`

This file does not contain the HTTP logic itself. Instead, it acts like a signpost and reception desk for the HTTP client parts of the system. The project can run HTTP requests in two different ways: directly in the current process using `reqwest` (a Rust library for making web requests), or indirectly by sending a JSON-RPC message to a remote execution server. JSON-RPC is a simple request-and-response message format often used between processes.

The file pulls in three nearby source files. One contains the direct `reqwest`-based client. One contains the RPC-based client that forwards HTTP work elsewhere. One contains `HttpResponseBodyStream`, which gives callers one consistent way to read response bytes whether the body was already buffered locally or arrives piece by piece from a remote server.

That consistency is the main reason this facade matters. Code elsewhere should not need to care whether an HTTP request is local or remote. It can ask for an HTTP client and read the response stream in the same shape either way. Without this file, other parts of the codebase would have to know the internal file layout and choose between implementation details themselves, making the local-versus-remote split harder to keep clean.


### `exec-server/src/client/http_response_body_stream.rs`

`io_transport` · `request handling`

An HTTP response body can be large, so this code does not require the whole body to arrive at once. Instead, it treats the body like water coming through a pipe: callers ask for the next chunk until the stream ends. For local HTTP requests, it wraps reqwest’s normal byte stream. For remote requests, the first response only gives status and headers, while the actual body arrives later as `http/request/bodyDelta` notifications. A notification is a small message saying “here are the next bytes for request X.”

The central type, `HttpResponseBodyStream`, hides that difference from the caller. Its `recv` method returns the next chunk, reports end-of-file, and turns broken ordering or stream errors into clear protocol errors. Remote chunks are checked with sequence numbers so missing or out-of-order messages are caught instead of silently corrupting the body.

The file also maintains a routing table inside `Inner`: request id to a channel sender. Think of it like a mailroom sorting incoming envelopes by request id. Registrations and drop cleanup remove routes when a stream finishes, fails, or is abandoned, so stale request ids do not pile up and future notifications do not go to the wrong place.

#### Function details

##### `HttpResponseBodyStream::local`  (lines 58–64)

```
fn local(response: Response) -> Self
```

**Purpose**: Creates a response-body stream for an HTTP request that was performed in this process. It lets the rest of the client read the body chunk by chunk without caring that the source is local.

**Data flow**: It receives a `reqwest::Response`, takes that response’s built-in byte stream, pins it so it can be safely polled while async work is in progress, and stores it inside a `HttpResponseBodyStream`. The result is a stream object ready for callers to read with `recv`.

**Call relations**: The HTTP request path calls this after a local streaming request returns its headers. Later, body collection code reads from the returned stream rather than reading directly from the underlying HTTP library.

*Call graph*: called by 1 (http_request_stream); 2 external calls (pin, bytes_stream).


##### `HttpResponseBodyStream::remote`  (lines 66–81)

```
fn remote(
        inner: Arc<Inner>,
        request_id: String,
        rx: mpsc::Receiver<HttpRequestBodyDeltaNotification>,
    ) -> Self
```

**Purpose**: Creates a response-body stream for an HTTP request whose body will arrive through remote notifications. It ties one request id to a receiver channel where body chunks will be delivered.

**Data flow**: It receives shared client state, a request id, and a channel receiver. It stores those along with bookkeeping: the next expected sequence number starts at 1, and the stream is marked not finished and not closed. The output is a stream object that can turn remote notifications into ordinary body chunks.

**Call relations**: The HTTP request path calls this after setting up a remote streamed request. Incoming notifications are routed into the channel elsewhere, and `recv` later pulls them out in order.

*Call graph*: called by 1 (http_request_stream).


##### `HttpResponseBodyStream::recv`  (lines 87–145)

```
async fn recv(&mut self) -> Result<Option<Vec<u8>>, ExecServerError>
```

**Purpose**: Returns the next chunk of response-body bytes, or says that the body is finished. It also protects callers from bad remote streams by reporting missing, out-of-order, or failed chunks as errors.

**Data flow**: For a local stream, it waits for the next bytes from the HTTP library and converts them into a plain `Vec<u8>`. For a remote stream, it waits for the next routed notification, checks that its sequence number is exactly the one expected, extracts the bytes, and watches for `done` or `error` flags. It returns `Ok(Some(bytes))` for a chunk, `Ok(None)` at end-of-file, or an `ExecServerError` if the stream breaks.

**Call relations**: Body collection code calls this repeatedly until it receives end-of-file or an error. When a remote stream ends or becomes invalid, this function hands cleanup to `finish_remote_stream` so the request id is removed from the routing table.

*Call graph*: calls 1 internal fn (finish_remote_stream); called by 1 (collect_body); 3 external calls (HttpRequest, Protocol, format!).


##### `HttpResponseBodyStream::drop`  (lines 150–164)

```
fn drop(&mut self)
```

**Purpose**: Cleans up a remote stream if the caller stops using it before reading to the end. This prevents the client from keeping a dead request route around.

**Data flow**: When the stream object is destroyed, it checks whether it represents a remote stream and whether cleanup has already happened. If not, it marks the stream closed and schedules removal of that request id from the shared routing table.

**Call relations**: Rust calls this automatically when a `HttpResponseBodyStream` goes out of scope. It uses `spawn_remove_http_body_stream` because dropping an object is synchronous, while route removal needs async work.

*Call graph*: calls 1 internal fn (spawn_remove_http_body_stream); 1 external calls (clone).


##### `HttpBodyStreamRegistration::new`  (lines 168–174)

```
fn new(inner: Arc<Inner>, request_id: String) -> Self
```

**Purpose**: Creates a temporary guard for a remote body-stream registration. The guard exists so that if request setup is cancelled halfway through, the route can still be removed.

**Data flow**: It receives shared client state and a request id, stores them, and marks the registration as active. The returned guard will clean up the route unless it is later disarmed.

**Call relations**: The streaming HTTP request setup path calls this before issuing a request. It acts like a safety tag attached during setup, making sure unfinished setup does not leave stale routing entries behind.

*Call graph*: called by 1 (http_request_stream).


##### `HttpBodyStreamRegistration::disarm`  (lines 176–178)

```
fn disarm(&mut self)
```

**Purpose**: Turns off the registration guard once setup has succeeded and ownership has moved elsewhere. After this, dropping the guard will not remove the stream route.

**Data flow**: It changes the guard’s `active` flag from true to false. Nothing is returned, but the guard’s later drop behavior changes.

**Call relations**: This is meant to be called by the request setup flow after the response stream is safely established. From that point on, cleanup belongs to `HttpResponseBodyStream::recv` or `HttpResponseBodyStream::drop`.


##### `HttpBodyStreamRegistration::drop`  (lines 183–187)

```
fn drop(&mut self)
```

**Purpose**: Removes a stream route if setup is abandoned before the response stream takes over. This avoids leaving a channel registered for a request that will never be read.

**Data flow**: When the guard is destroyed, it checks whether it is still active. If so, it schedules removal of its request id from the shared routing table.

**Call relations**: Rust calls this automatically when the registration guard goes away. It uses `spawn_remove_http_body_stream` for the async cleanup, just like the response stream’s drop path.

*Call graph*: calls 1 internal fn (spawn_remove_http_body_stream); 1 external calls (clone).


##### `finish_remote_stream`  (lines 190–196)

```
async fn finish_remote_stream(inner: &Arc<Inner>, request_id: &str, closed: &mut bool)
```

**Purpose**: Performs final cleanup for a remote body stream. It removes the request id from the routing table exactly once.

**Data flow**: It receives shared client state, a request id, and the stream’s `closed` flag. If cleanup already happened, it does nothing. Otherwise it marks the stream closed and asks `Inner` to remove the route.

**Call relations**: `HttpResponseBodyStream::recv` calls this whenever a remote stream reaches end-of-file, reports an error, loses its channel, or receives an invalid sequence. It centralizes the “close this stream route” step so the caller does not repeat it in every branch.

*Call graph*: called by 1 (recv).


##### `spawn_remove_http_body_stream`  (lines 199–205)

```
fn spawn_remove_http_body_stream(inner: Arc<Inner>, request_id: String)
```

**Purpose**: Starts async route removal from places that cannot directly `await`, such as destructors. It is a bridge between synchronous cleanup and asynchronous shared-state updates.

**Data flow**: It receives shared client state and a request id. If there is a current Tokio runtime handle, it spawns a small async task that removes that request id from the routing table. It does not return the removed route to the caller.

**Call relations**: Both stream-related drop functions call this when an object is abandoned. It lets cleanup still happen even though Rust destructors cannot pause and wait for async work.

*Call graph*: called by 2 (drop, drop); 1 external calls (try_current).


##### `send_body_delta`  (lines 207–215)

```
async fn send_body_delta(
    notifications: &RpcNotificationSender,
    delta: HttpRequestBodyDeltaNotification,
) -> bool
```

**Purpose**: Sends one response-body chunk notification to the other side of the RPC connection. It reports only whether the send succeeded.

**Data flow**: It receives an RPC notification sender and a body-delta notification. It sends the notification using the HTTP body-delta method name and returns `true` if that send worked, or `false` if it failed.

**Call relations**: This is the outgoing counterpart to the incoming routing code. Code that is streaming an HTTP response body over RPC can call this for each chunk so the remote client can rebuild the body stream.

*Call graph*: calls 1 internal fn (notify).


##### `Inner::handle_http_body_delta_notification`  (lines 219–258)

```
async fn handle_http_body_delta_notification(
        &self,
        params: Option<Value>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Receives an incoming remote body-delta message and delivers it to the waiting stream for the matching request id. It is the mailroom sorter for streamed HTTP response chunks.

**Data flow**: It receives optional JSON parameters, decodes them into a body-delta notification, and looks up the request id in the stream routing table. If a matching channel exists, it tries to send the notification into that channel. Terminal messages remove the route, closed channels are cleaned up, and full channels are treated as stream failure so the reader will not wait forever.

**Call relations**: The RPC notification layer calls this when an `http/request/bodyDelta` notification arrives. It may call `remove_http_body_stream` after final or undeliverable messages, and it calls `record_http_body_stream_failure` when backpressure means the chunk could not be delivered.

*Call graph*: calls 2 internal fn (record_http_body_stream_failure, remove_http_body_stream); 2 external calls (debug!, from_value).


##### `Inner::fail_all_http_body_streams`  (lines 262–284)

```
async fn fail_all_http_body_streams(&self, message: String)
```

**Purpose**: Fails every active streamed HTTP response, usually after a transport disconnect or serious notification error. This makes waiting readers wake up with an error instead of hanging forever.

**Data flow**: It locks the stream table, copies all active routes, replaces the table with an empty one, and then tries to send each stream a final notification containing the failure message. If a channel cannot receive that message, it stores the failure in a separate failure map so the stream can still discover it later.

**Call relations**: This is used when the connection as a whole can no longer be trusted. It feeds failure messages into the same per-request channels that normal body notifications use, so `recv` can surface the problem to callers.

*Call graph*: 3 external calls (new, new, new).


##### `Inner::next_http_body_stream_request_id`  (lines 287–292)

```
fn next_http_body_stream_request_id(&self) -> String
```

**Purpose**: Creates a new request id for a streamed HTTP response body on this connection. The id lets later body notifications be matched back to the right request.

**Data flow**: It increments an atomic counter, which is a number safe to update from multiple tasks at once, and formats the number as a string like `http-123`. The returned string becomes the stream’s request id.

**Call relations**: The streaming HTTP request setup code uses this before registering a route and sending the request. Later, both incoming and outgoing body-delta messages rely on this id to identify the stream.

*Call graph*: 1 external calls (format!).


##### `Inner::insert_http_body_stream`  (lines 295–318)

```
async fn insert_http_body_stream(
        &self,
        request_id: String,
        tx: mpsc::Sender<HttpRequestBodyDeltaNotification>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Registers a new request id and channel before starting a remote streamed HTTP request. This gives incoming body notifications somewhere to go.

**Data flow**: It locks the stream table, checks that the request id is not already present, clones the current table, adds the new sender, and swaps the updated table into shared state. It also clears any old stored failure for the same id. It returns success or a protocol error if the id was already registered.

**Call relations**: The HTTP request setup flow calls this before the remote request is issued. Later, `Inner::handle_http_body_delta_notification` reads this table to deliver chunks, and cleanup functions remove the entry when the stream ends.

*Call graph*: 3 external calls (new, Protocol, format!).


##### `Inner::remove_http_body_stream`  (lines 321–333)

```
async fn remove_http_body_stream(
        &self,
        request_id: &str,
    ) -> Option<mpsc::Sender<HttpRequestBodyDeltaNotification>>
```

**Purpose**: Unregisters a streamed HTTP response body after it finishes, fails, or is abandoned. This stops future notifications for that request id from being routed to an old channel.

**Data flow**: It locks the stream table, looks for the request id, and if found, creates a new table without that id and stores it. It returns the removed channel sender if there was one, or `None` if nothing was registered.

**Call relations**: `Inner::handle_http_body_delta_notification` calls this when a terminal or undeliverable notification arrives. It is also used by stream cleanup paths, including `finish_remote_stream` and spawned drop cleanup.

*Call graph*: called by 1 (handle_http_body_delta_notification); 1 external calls (new).


##### `Inner::record_http_body_stream_failure`  (lines 335–342)

```
async fn record_http_body_stream_failure(&self, request_id: &str, message: String)
```

**Purpose**: Stores a failure message for a request id when the normal channel delivery path cannot report it directly. This preserves the reason the stream was closed.

**Data flow**: It locks the shared stream state, clones the current failure map, inserts the request id and message, and swaps the updated map back into shared state. It does not return anything.

**Call relations**: `Inner::handle_http_body_delta_notification` calls this when a body-delta channel is full and the notification cannot be delivered. Later, the stream reader can retrieve the stored message through `Inner::take_http_body_stream_failure`.

*Call graph*: called by 1 (handle_http_body_delta_notification); 1 external calls (new).


##### `Inner::take_http_body_stream_failure`  (lines 344–354)

```
async fn take_http_body_stream_failure(&self, request_id: &str) -> Option<String>
```

**Purpose**: Retrieves and removes a stored failure message for a request id. It is used so a stream reader can report the real reason a remote body stream ended unexpectedly.

**Data flow**: It locks the shared state, looks up the request id in the failure map, and if a message exists, clones the map without that entry and stores the updated version. It returns the message if one was found, otherwise `None`.

**Call relations**: `HttpResponseBodyStream::recv` uses this after a remote channel closes without a normal final chunk. That lets `recv` turn a previously recorded delivery problem into a clear protocol error for the caller.

*Call graph*: 1 external calls (new).


### `exec-server/src/remote_file_stream.rs`

`io_transport` · `request handling`

This file solves a simple but important problem: the client needs to read file contents from another process or machine without loading the whole file at once. It does that by turning remote file-reading protocol calls into a stream of byte chunks. Think of it like checking out a library book by ID, reading a few pages at a time, then returning the book when finished.

The main entry point, `open`, first creates a unique handle ID. That handle ID is like a claim ticket for the remote file. It then asks the exec server to open the requested path, optionally inside a sandbox context, which means a restricted file-system view. If the open succeeds, it returns a `FileSystemReadStream` that repeatedly asks the server for the next block of bytes.

Each read block is checked carefully. The server must not send more than the agreed chunk size. If it says the file is not finished, it must send at least one byte, otherwise the stream could loop forever. The code also checks that the byte offset does not overflow.

A small guard object, `FileReadRegistration`, remembers whether the remote file is still open. If the stream reaches end-of-file, it closes the remote handle normally. If the stream is dropped early, its `Drop` method tries to close the handle in the background, preventing leaked remote file handles.

#### Function details

##### `open`  (lines 24–102)

```
async fn open(
    client: ExecServerClient,
    path: PathUri,
    sandbox: Option<FileSystemSandboxContext>,
) -> FileSystemResult<FileSystemReadStream>
```

**Purpose**: Opens a remote file for reading and returns a stream that produces its contents piece by piece. Someone would use this when they want file bytes from the exec server without downloading the whole file into memory at once.

**Data flow**: It receives an exec-server client, a file path, and an optional sandbox description. It creates a fresh handle ID, asks the server to open that path under that handle, then builds a stream. Each time the stream is polled, it asks the server for the next block of bytes, checks that the response is valid, advances the offset, and yields the bytes. When the server reports end-of-file, it closes the remote handle and ends the stream.

**Call relations**: This function starts the remote-read story. It creates the `FileReadRegistration` guard, then uses the client’s remote file operations to open, read, and eventually close the file. The stream machinery calls its inner read step repeatedly until there is no more data or an error occurs. If normal closing does not happen because the stream is abandoned, `FileReadRegistration::drop` is the backup cleanup path.

*Call graph*: calls 1 internal fn (new); 3 external calls (new_v4, try_unfold, try_current).


##### `FileReadRegistration::drop`  (lines 105–120)

```
fn drop(&mut self)
```

**Purpose**: Acts as a safety net for remote file handles. If a read stream is dropped before it has cleanly closed the remote file, this function tries to close it in the background.

**Data flow**: It looks at the registration object as it is being destroyed. If the remote handle is already marked inactive, it does nothing. If the handle is still active, it copies the client and handle ID, finds a Tokio runtime handle if one is available, and schedules an asynchronous close request. It does not return useful data; its effect is the attempted cleanup of the remote server resource.

**Call relations**: This function is called automatically by Rust when a `FileReadRegistration` is destroyed. It supports the stream created by `open`: normal end-of-file closes the handle directly and marks it inactive, but early cancellation or errors may leave it active. In that case, this drop hook hands off a close request to the async runtime so the remote server is not left holding an unused file handle.

*Call graph*: 1 external calls (clone).


### Noise relay primitives
These modules provide the authenticated channel, ciphertext ordering, and decrypted message framing primitives that underpin the relay transport.

### `exec-server/src/noise_channel.rs`

`io_transport` · `connection setup and relay message transport`

This file is the lock, key check, and sealed pipe for exec-server relay traffic. Before any normal messages are sent, the harness and executor run a two-message Noise handshake. Noise is a standard way to set up encrypted connections; here it is "hybrid", meaning it combines a traditional X25519 key exchange with ML-KEM-768, a newer post-quantum key exchange method. The goal is that both today’s attackers and future quantum-capable attackers have a harder time reading the traffic.

The harness starts by using the executor public key it got from the registry. That key is "pinned", meaning the harness refuses to continue if the responder key does not exactly match what was expected. The executor reads the first handshake message, learns the authenticated harness public key, and pauses so another part of the system can ask the registry whether that harness is allowed. Only after that authorization does the executor finish the handshake.

Both sides also build a shared "prologue", which is extra context mixed into the handshake. It includes the environment, executor registration, and stream identifiers, so a valid handshake for one stream cannot be silently reused as if it belonged to another. Once the handshake is complete, NoiseTransport encrypts and decrypts ordered records. The ordering matters because the encryption state advances with each record, like a ticket book where each ticket can be used only once.

#### Function details

##### `NoiseChannelPublicKey::fmt`  (lines 55–61)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This defines how a public key is shown in debug output. It keeps the suite name visible but hides the actual key strings, so logs can be useful without casually exposing sensitive key material.

**Data flow**: It receives a formatter that is building a debug string. It writes a structured view named NoiseChannelPublicKey, includes the suite value, replaces both public-key fields with "<redacted>", and returns the formatter result.

**Call relations**: This is used automatically when Rust debug-printing asks how to display a NoiseChannelPublicKey. It delegates to the standard debug_struct helper to build the redacted output.

*Call graph*: 1 external calls (debug_struct).


##### `NoiseChannelPublicKey::decode`  (lines 66–88)

```
fn decode(&self) -> Result<(<X25519 as Dh>::PubKey, MlKem768PublicKey), NoiseChannelError>
```

**Purpose**: This checks that a registry-provided public key belongs to this exact Noise channel design, then turns its base64 text fields into the binary key objects the cryptography library needs. It prevents keys from a different protocol, or malformed keys, from being accepted by accident.

**Data flow**: It starts with a NoiseChannelPublicKey containing a suite string and two base64-encoded keys. It first checks the suite name, then decodes the X25519 and ML-KEM-768 public keys and verifies their lengths. On success it returns the two usable public keys; on failure it returns a clear invalid-public-key error.

**Call relations**: InitiatorHandshake::start calls this before the harness begins a handshake. That means the expected executor key is validated and converted before being pinned into the cryptographic setup.

*Call graph*: called by 1 (start); 2 external calls (from_slice, InvalidPublicKey).


##### `NoiseChannelIdentity::generate`  (lines 99–105)

```
fn generate() -> Result<Self, NoiseChannelError>
```

**Purpose**: This creates a fresh long-lived Noise identity for a harness or executor process. The identity contains both kinds of private key material needed for the hybrid handshake.

**Data flow**: It takes no input. It asks the cryptography library to generate an X25519 key pair and an ML-KEM-768 key pair. If both succeed, it returns a NoiseChannelIdentity holding them; if either fails, it returns a key-generation error with the underlying message.

**Call relations**: Startup and tests call this when they need a new secure identity. For example, environment registration code uses it before publishing the public half, and handshake tests use it to create both endpoints.

*Call graph*: called by 22 (upsert_noise_environment, hybrid_ik_roundtrip_authenticates_both_endpoints, initiator_rejects_oversized_handshake_payload, initiator_rejects_wrong_responder_key, public_key_serializes_with_expected_suite, public_key_validation_rejects_unknown_suite, responder_rejects_mismatched_prologue, transport_rejects_replayed_ciphertext, transport_rejects_tampered_ciphertext, processor_exit_reports_closed_virtual_stream (+12 more)); 2 external calls (genkey, genkey).


##### `NoiseChannelIdentity::public_key`  (lines 107–113)

```
fn public_key(&self) -> NoiseChannelPublicKey
```

**Purpose**: This extracts the shareable public part of a Noise identity. It packages the public keys with the suite label so another party can later verify they are for the right protocol.

**Data flow**: It reads the identity’s X25519 and ML-KEM public keys. It base64-encodes them into text and returns a NoiseChannelPublicKey containing those strings plus the fixed suite name. It does not expose the private keys.

**Call relations**: Other parts of the system use this when registering or comparing endpoint keys. The returned value is the form that can safely travel through registry data or JSON.


##### `InitiatorHandshake::start`  (lines 126–151)

```
fn start(
        identity: &NoiseChannelIdentity,
        responder_public_key: &NoiseChannelPublicKey,
        prologue: &[u8],
        payload: &[u8],
    ) -> Result<(Self, Vec<u8>), NoiseChannelE
```

**Purpose**: This begins the harness side of the secure handshake. It creates the first encrypted handshake message and locks the conversation to the expected executor public key.

**Data flow**: It receives the harness identity, the executor public key expected from the registry, a prologue tying the handshake to this stream, and a small payload such as temporary authorization data. It decodes and validates the executor key, configures the hybrid IK handshake as the initiator, checks that the payload will fit, writes the first handshake message, and returns both the saved handshake state and the bytes to send to the executor.

**Call relations**: Connection code and tests call this when the harness opens a Noise-protected relay stream. It calls NoiseChannelPublicKey::decode first, then hands the prepared settings to the Clatter Noise library to produce the outbound request.

*Call graph*: calls 1 internal fn (decode); called by 13 (hybrid_ik_roundtrip_authenticates_both_endpoints, initiator_rejects_oversized_handshake_payload, initiator_rejects_wrong_responder_key, responder_rejects_mismatched_prologue, transport_rejects_replayed_ciphertext, transport_rejects_tampered_ciphertext, processor_exit_reports_closed_virtual_stream, noise_harness_connection_from_websocket, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation (+3 more)); 4 external calls (new, new, noise_hybrid_ik, InvalidMessage).


##### `InitiatorHandshake::finish`  (lines 155–167)

```
fn finish(mut self, response: &[u8]) -> Result<NoiseTransport, NoiseChannelError>
```

**Purpose**: This completes the harness side after the executor sends its handshake response. If the response is valid and empty as expected, it turns the temporary handshake state into a usable encrypted transport.

**Data flow**: It consumes the saved InitiatorHandshake and receives the executor response bytes. It checks the response size, asks the handshake object to decrypt and verify the response, rejects it if it contains unexpected application payload, finalizes the handshake, and returns a NoiseTransport ready to encrypt and decrypt records.

**Call relations**: This is the second half of the harness connection setup. It uses ensure_noise_frame_len before processing, then calls into the Noise library to read the response and finalize the session keys.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); 3 external calls (finalize, read_message, InvalidMessage).


##### `PendingResponderHandshake::read_request`  (lines 182–211)

```
fn read_request(
        identity: &NoiseChannelIdentity,
        prologue: &[u8],
        request: &[u8],
    ) -> Result<Self, NoiseChannelError>
```

**Purpose**: This reads the executor side of the first handshake message. It authenticates enough of the request to recover the harness public key, but deliberately stops before creating a usable transport so the registry can decide whether that harness is allowed.

**Data flow**: It receives the executor identity, the shared prologue, and the first handshake message from the harness. It checks the message size, builds the responder-side hybrid IK handshake, reads and verifies the request, extracts the authenticated remote static key, encodes that key into NoiseChannelPublicKey form, saves any payload from the request, and returns a PendingResponderHandshake.

**Call relations**: The relay server calls this when a harness begins a connection, including in run_multiplexed_environment. After this function returns, the caller is expected to validate initiator_public_key with the registry before calling PendingResponderHandshake::complete.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); called by 5 (hybrid_ik_roundtrip_authenticates_both_endpoints, transport_rejects_replayed_ciphertext, transport_rejects_tampered_ciphertext, processor_exit_reports_closed_virtual_stream, run_multiplexed_environment); 4 external calls (new, new, noise_hybrid_ik, InvalidMessage).


##### `PendingResponderHandshake::complete`  (lines 214–223)

```
fn complete(mut self) -> Result<(NoiseTransport, Vec<u8>), NoiseChannelError>
```

**Purpose**: This finishes the executor side of the handshake after the harness key has been authorized. It produces the executor’s response message and the encrypted transport state for future records.

**Data flow**: It consumes the pending responder handshake. It writes an empty second handshake message into a buffer, finalizes the cryptographic state, and returns both the new NoiseTransport and the response bytes that must be sent back to the harness.

**Call relations**: This is called only after the caller has accepted the authenticated harness public key. It hands off to the Noise library to write the response and finalize the session, completing the bridge from authorization to encrypted traffic.

*Call graph*: 2 external calls (finalize, write_message).


##### `NoiseTransport::encrypt`  (lines 235–241)

```
fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseChannelError>
```

**Purpose**: This encrypts one outgoing transport record after the handshake is complete. It also checks that the plaintext plus the authentication tag will fit inside the Noise maximum message size.

**Data flow**: It receives plaintext bytes. It adds the expected AES-GCM tag length to know how large the encrypted record will be, rejects data that is too large, then asks the transport state to encrypt the plaintext. It returns ciphertext bytes and advances the send side of the transport state.

**Call relations**: spawn_noise_virtual_stream calls this when it needs to send data over the protected virtual stream. It relies on ensure_noise_frame_len for size safety and on the underlying Noise transport for the actual encryption.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); called by 1 (spawn_noise_virtual_stream); 3 external calls (tag_len, send_vec, InvalidMessage).


##### `NoiseTransport::decrypt`  (lines 244–252)

```
fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseChannelError>
```

**Purpose**: This decrypts one incoming ordered transport record. It rejects records that are too short or too large before asking the cryptographic state to verify and open them.

**Data flow**: It receives ciphertext bytes. It first checks that there is at least room for the AES-GCM authentication tag, then checks the overall Noise frame limit. If those checks pass, it decrypts and verifies the record, returning plaintext bytes and advancing the receive side of the transport state.

**Call relations**: receive_data calls this when encrypted relay data arrives. Because the Noise transport state advances each time, callers must feed records in order and must not replay old ciphertext.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); called by 1 (receive_data); 3 external calls (tag_len, receive_vec, InvalidMessage).


##### `noise_channel_prologue`  (lines 258–269)

```
fn noise_channel_prologue(
    environment_id: &str,
    executor_registration_id: &str,
    stream_id: &str,
) -> Vec<u8>
```

**Purpose**: This builds the shared context string that both sides mix into the handshake before any messages are processed. It binds the secure channel to one environment, one executor registration, and one relay stream.

**Data flow**: It receives three identifier strings: environment ID, executor registration ID, and stream ID. It creates a byte vector, appends a fixed protocol domain marker, then appends each identifier with a length prefix. It returns the finished prologue bytes.

**Call relations**: Harness and executor connection setup both call this before starting or reading a handshake. It calls append_prologue_part for each component so both peers compute exactly the same unambiguous context.

*Call graph*: calls 1 internal fn (append_prologue_part); called by 7 (noise_harness_connection_from_websocket, run_multiplexed_environment, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation, pending_harness_key_validation_does_not_block_new_handshakes, repeated_early_data_during_validation_closes_the_physical_relay, repeated_malformed_handshakes_close_the_physical_relay); 1 external calls (new).


##### `append_prologue_part`  (lines 271–277)

```
fn append_prologue_part(prologue: &mut Vec<u8>, part: &[u8])
```

**Purpose**: This appends one piece of data to a prologue in a way that cannot be confused with neighboring pieces. The length prefix acts like a label saying where this piece ends.

**Data flow**: It receives a mutable prologue byte vector and one byte slice to add. It writes the part length as an eight-byte big-endian number, then writes the part itself. It changes the provided vector in place and returns nothing.

**Call relations**: noise_channel_prologue calls this repeatedly while building the full handshake context. Its small job is important because raw concatenation could let different identifier combinations produce the same final bytes.

*Call graph*: called by 1 (noise_channel_prologue).


##### `ensure_noise_frame_len`  (lines 279–287)

```
fn ensure_noise_frame_len(
    frame_len: usize,
    message: &'static str,
) -> Result<(), NoiseChannelError>
```

**Purpose**: This enforces the maximum message size allowed by the Noise library. It gives callers a single simple check before they pass data into handshake or transport code.

**Data flow**: It receives a frame length and an error message to use if the frame is too large. If the length is within MAX_MESSAGE_LEN, it returns success. If it is too large, it returns an invalid-message error using the supplied message.

**Call relations**: Handshake finishing, responder request reading, encryption, and decryption all call this before processing frames. It is the shared guardrail that keeps oversized data away from the lower-level cryptographic routines.

*Call graph*: called by 4 (finish, decrypt, encrypt, read_request); 1 external calls (InvalidMessage).


##### `NoiseChannelError::from`  (lines 310–312)

```
fn from(error: clatter::error::TransportError) -> Self
```

**Purpose**: This converts errors from the Clatter cryptography library into this file’s own error type. That lets the rest of the exec-server code talk about Noise channel failures in one consistent vocabulary.

**Data flow**: It receives either a Clatter handshake error or a Clatter transport error. It turns the original error into text and wraps it as either a NoiseChannelError::Handshake or NoiseChannelError::Transport value. The result is returned to the caller through normal Rust error propagation.

**Call relations**: The handshake and transport functions use the question-mark error shortcut when calling Clatter. These conversion functions are what make that shortcut produce NoiseChannelError values instead of leaking library-specific error types outward.

*Call graph*: 4 external calls (Handshake, Transport, to_string, to_string).


### `exec-server/src/noise_relay/ordered_ciphertext.rs`

`io_transport` · `relay data receive`

Noise is an encryption protocol that expects incoming encrypted messages to be opened in the same sequence they were sent, because each message uses an implicit counter called a nonce. If message 5 is decrypted before message 4, decryption can fail or the connection state can become wrong. This file solves that by acting like a small waiting room for encrypted relay records.

`OrderedCiphertextFrames` tracks the next sequence number it expects. If the next expected record arrives, it releases it immediately, then also releases any later records that had been waiting and now form an unbroken run. If a future record arrives early, it is stored in a sorted map until the gap is filled. If the same record arrives twice, it is ignored so each sequence number is released at most once.

The waiting room is deliberately small. It rejects records that are too far ahead, and it also limits the total bytes being held. This matters because otherwise a peer could send many future messages and make the server spend too much memory. It is like letting people queue for numbered tickets, but refusing tickets that are far beyond the current line or would overcrowd the room.

#### Function details

##### `OrderedCiphertextFrames::push`  (lines 22–58)

```
fn push(
        &mut self,
        seq: u32,
        payload: Vec<u8>,
    ) -> Result<Vec<Vec<u8>>, ExecServerError>
```

**Purpose**: Accepts one encrypted relay record with its sequence number and returns any records that are now safe to decrypt in order. It ignores duplicates, buffers records that arrived too early, and rejects records that would make the reorder buffer unsafe or too large.

**Data flow**: A sequence number and ciphertext bytes go in. The function compares the sequence number with the next one it is waiting for: old or already stored records produce no output; future records may be saved for later; the exact next record is released and may unlock more saved records after it. The result is either a list of ready ciphertext payloads in correct order, an empty list if nothing can be released yet, or a protocol error if the input is too far ahead, too large in total, or the sequence counter runs out.

**Call relations**: During relay receiving, `receive_data` calls this before ciphertext reaches the Noise decryption state. When `push` can release a record, it calls `OrderedCiphertextFrames::advance` to move the expected sequence number forward, repeating that as long as buffered records continue the sequence.

*Call graph*: calls 1 internal fn (advance); called by 2 (receive_data, receive_data); 3 external calls (new, Protocol, vec!).


##### `OrderedCiphertextFrames::advance`  (lines 60–65)

```
fn advance(&mut self) -> Result<(), ExecServerError>
```

**Purpose**: Moves the expected sequence number forward by one after a record has been accepted for release. It also detects the impossible edge case where the 32-bit sequence number has no next value left.

**Data flow**: It reads the current `next_seq`, tries to add one, and writes the new value back. If adding one would overflow, it returns a protocol error instead of silently wrapping back to zero.

**Call relations**: `OrderedCiphertextFrames::push` uses this each time it releases a ciphertext frame. This keeps the reorder logic honest: every released record advances the single shared expectation for what sequence number must come next.

*Call graph*: called by 1 (push).


### `exec-server/src/noise_relay/message_framing.rs`

`io_transport` · `message send and receive over the Noise relay`

The Noise relay sends data in encrypted chunks called records. A JSON-RPC message, which is a structured request or response encoded as JSON, does not naturally say where one message ends and the next begins once it has been turned into raw bytes. This file adds that missing boundary marker.

When sending, it writes four bytes at the front of each JSON-RPC message. Those four bytes say how long the JSON part is. Think of it like putting a label on a parcel that says how many pages are inside. After that, another part of the relay can split the bytes into safe-sized Noise records without losing the original message boundary.

When receiving, `JsonRpcMessageDecoder` keeps a small waiting area for bytes that have arrived but do not yet make a full message. Each new decrypted record is appended there. The decoder reads the length label, waits until the full message has arrived, parses the JSON, and returns any complete messages it found.

The file also protects the server from bad or broken peers. It rejects records and messages that are too large, and it rejects zero-length messages. Without these checks, a peer could make the server wait forever or grow memory without limit.

#### Function details

##### `frame_jsonrpc_message`  (lines 15–26)

```
fn frame_jsonrpc_message(message: &JSONRPCMessage) -> Result<Vec<u8>, ExecServerError>
```

**Purpose**: This function prepares one JSON-RPC message for encrypted transport. It converts the message to JSON bytes and prefixes it with a four-byte length, so the receiver can later know exactly where that message ends.

**Data flow**: It receives a `JSONRPCMessage`. It first reserves four bytes for the length, writes the JSON form of the message after those bytes, checks that the JSON is not larger than the allowed maximum, then fills in the reserved bytes with the message length. It returns the complete framed byte buffer, or an error if the message is too large or cannot be serialized.

**Call relations**: When code such as `spawn_noise_virtual_stream` or `processor_exit_reports_closed_virtual_stream` needs to send a JSON-RPC message through the Noise relay, it calls this function first. The result is not yet the final encrypted network data; it is the clean byte stream that later code can split into Noise-sized records and encrypt.

*Call graph*: called by 2 (spawn_noise_virtual_stream, processor_exit_reports_closed_virtual_stream); 3 external calls (Protocol, to_writer, vec!).


##### `JsonRpcMessageDecoder::push`  (lines 39–80)

```
fn push(
        &mut self,
        plaintext_record: &[u8],
    ) -> Result<Vec<JSONRPCMessage>, ExecServerError>
```

**Purpose**: This method feeds newly decrypted Noise record bytes into a decoder and returns every complete JSON-RPC message that can now be reconstructed. It is designed for streaming data, where one record may contain part of a message, one whole message, or several messages.

**Data flow**: It receives one plaintext record, meaning bytes that have already been decrypted. It rejects the record if it is too large, appends it to the decoder's internal buffer, then repeatedly checks whether the buffer starts with a complete framed message. For each complete message, it reads the four-byte length, parses the following JSON bytes into a `JSONRPCMessage`, removes those bytes from the buffer, and adds the message to the output list. If only part of a message has arrived, it keeps those bytes for the next call. It returns the list of completed messages, or an error if the length is invalid, parsing fails, or the waiting buffer grows too large.

**Call relations**: `receive_data` calls this method when decrypted bytes arrive from the Noise relay. The method acts like the receiver's reassembly station: it turns a stream of record-sized pieces back into whole JSON-RPC messages, then hands those messages back to the receiving flow for normal processing.

*Call graph*: called by 2 (receive_data, receive_data); 4 external calls (new, Protocol, from_slice, from_be_bytes).


### Relay transport implementation
This module assembles the lower-level relay pieces into websocket-based relay transports, from simple harness connections to multiplexed Noise-authenticated relays.

### `exec-server/src/relay.rs`

`io_transport` · `websocket connection handling`

This file solves a transport problem: the exec server needs to talk to remote harnesses through WebSockets, but the rest of the server wants ordinary JSON-RPC messages. The relay wraps each message in a small protobuf envelope, called a relay message frame, so every packet says which logical stream it belongs to and what kind of packet it is: data, handshake, reset, and so on.

For the simpler path, `harness_connection_from_websocket` turns one WebSocket into one `JsonRpcConnection`. It sends an initial “resume” frame, converts outgoing JSON-RPC messages into binary relay frames, reads incoming relay frames back into JSON-RPC messages, reports malformed input, and sends ping frames as keepalives so idle connections do not silently die.

For the more advanced path, `run_multiplexed_environment` lets one physical executor WebSocket carry many separate encrypted virtual streams. A new stream starts with a Noise handshake, which is a cryptographic greeting that proves the harness key. The file then asks a validator whether that key is authorized before exposing the stream to normal request processing. It also limits active streams, pending validations, and repeated bad handshakes, so one bad peer cannot consume unlimited work. Without this file, the server would not be able to safely translate relay WebSocket traffic into the JSON-RPC conversations used by the rest of the system.

#### Function details

##### `RelayMessageFrame::data`  (lines 63–76)

```
fn data(stream_id: String, seq: u32, payload: Vec<u8>) -> Self
```

**Purpose**: Builds a relay frame that carries real JSON-RPC bytes for one logical stream. Code uses this when it needs to send application data through the relay.

**Data flow**: It receives a stream id, a sequence number, and a byte payload. It puts those values into a versioned relay frame with a data body, marking it as one complete segment, and returns the finished frame.

**Call relations**: This is one of the frame constructors used by the relay sender side. `harness_connection_from_websocket` creates these frames when normal JSON-RPC messages need to leave over the WebSocket, and tests use it to simulate incoming relay data.

*Call graph*: 1 external calls (Data).


##### `RelayMessageFrame::resume`  (lines 78–88)

```
fn resume(stream_id: String) -> Self
```

**Purpose**: Builds a relay frame that announces or resumes a relay stream. The plain harness connection sends this first so the other side knows which stream id to use.

**Data flow**: It receives a stream id. It creates a versioned relay frame with a resume body and an initial next-sequence value, then returns that frame.

**Call relations**: This is used at the start of `harness_connection_from_websocket`. That connection sends the resume frame before exchanging JSON-RPC data frames.

*Call graph*: 1 external calls (Resume).


##### `RelayMessageFrame::handshake`  (lines 90–100)

```
fn handshake(stream_id: String, payload: Vec<u8>) -> Self
```

**Purpose**: Builds a relay frame that carries Noise handshake bytes. This is used when starting an encrypted virtual stream inside a multiplexed WebSocket.

**Data flow**: It receives a stream id and handshake bytes. It wraps those bytes in a versioned relay frame with a handshake body and returns it.

**Call relations**: The multiplexed relay uses this when replying to an accepted Noise handshake. It is also part of the wider handshake flow started and checked inside `run_multiplexed_environment`.

*Call graph*: 1 external calls (Handshake).


##### `RelayMessageFrame::reset`  (lines 102–110)

```
fn reset(stream_id: String, reason: String) -> Self
```

**Purpose**: Builds a relay frame that tells the other side a stream should be closed or rejected. It is the relay equivalent of saying, “stop using this stream.”

**Data flow**: It receives a stream id and a text reason. It places them into a versioned reset frame and returns that frame.

**Call relations**: `send_reset` uses this helper whenever `run_multiplexed_environment` needs to reject a bad handshake, close an unknown stream, or signal that a virtual stream cannot continue.

*Call graph*: 1 external calls (Reset).


##### `RelayMessageFrame::validate`  (lines 112–156)

```
fn validate(&self) -> Result<RelayFrameBodyKind, ExecServerError>
```

**Purpose**: Checks that a relay frame is well formed before the server trusts it. It catches wrong versions, missing stream ids, empty payloads, and incomplete reset or handshake frames.

**Data flow**: It reads the frame’s version, stream id, and body fields. If anything required is missing or invalid, it returns a protocol error; otherwise it returns the kind of frame body it found.

**Call relations**: Extraction helpers such as `into_data` and `into_handshake_payload` call this before taking bytes out of a frame. The main relay loops also use this check before deciding how to route an incoming frame.

*Call graph*: called by 2 (into_data, into_handshake_payload); 2 external calls (Protocol, format!).


##### `RelayMessageFrame::into_data`  (lines 158–171)

```
fn into_data(self) -> Result<RelayData, ExecServerError>
```

**Purpose**: Turns a validated relay frame into its data body. It is used when the caller expects actual application bytes, not a handshake or reset.

**Data flow**: It takes ownership of a relay frame, validates it, checks that the body kind is data, and then returns the contained `RelayData`. If the frame is not data, it returns a protocol error.

**Call relations**: `into_jsonrpc_message` calls this before decoding JSON-RPC. The multiplexed relay also uses it before passing encrypted data into a virtual Noise stream.

*Call graph*: calls 1 internal fn (validate); called by 1 (into_jsonrpc_message); 1 external calls (Protocol).


##### `RelayMessageFrame::into_jsonrpc_message`  (lines 173–176)

```
fn into_jsonrpc_message(self) -> Result<JSONRPCMessage, ExecServerError>
```

**Purpose**: Extracts a JSON-RPC message from a data relay frame. JSON-RPC is the request-and-response message format used by the server above the transport layer.

**Data flow**: It takes a relay frame, pulls out its data payload, and parses those bytes as JSON. The result is a `JSONRPCMessage`, or an error if the frame or JSON is invalid.

**Call relations**: The plain WebSocket connection path uses this when a binary relay frame arrives and needs to become a normal incoming server message.

*Call graph*: calls 1 internal fn (into_data); 1 external calls (from_slice).


##### `RelayMessageFrame::into_handshake_payload`  (lines 178–191)

```
fn into_handshake_payload(self) -> Result<Vec<u8>, ExecServerError>
```

**Purpose**: Extracts the raw bytes from a handshake frame. The Noise code needs these bytes to continue or complete the encrypted-channel setup.

**Data flow**: It takes ownership of a relay frame, validates it, checks that it is a handshake frame, and returns the handshake payload bytes. If the frame is the wrong kind, it returns a protocol error.

**Call relations**: `run_multiplexed_environment` uses this when a harness asks to open a new encrypted virtual stream.

*Call graph*: calls 1 internal fn (validate); 1 external calls (Protocol).


##### `RelayMessageFrame::into_reset_reason`  (lines 193–200)

```
fn into_reset_reason(self) -> Option<String>
```

**Purpose**: Pulls out the reason text from a reset frame, if one is present. This lets the plain connection report why the peer disconnected.

**Data flow**: It takes a relay frame and looks only for a non-empty reset body. If found, it returns the reason string; otherwise it returns nothing.

**Call relations**: The plain relay reader uses this after receiving a reset frame so it can send a `Disconnected` event with an optional reason.


##### `encode_relay_message_frame`  (lines 203–205)

```
fn encode_relay_message_frame(frame: &RelayMessageFrame) -> Vec<u8>
```

**Purpose**: Serializes a relay frame into bytes ready to send over a WebSocket. Serialization means turning structured data into a compact binary form.

**Data flow**: It receives a `RelayMessageFrame`, encodes it using protobuf, and returns the byte vector that can be placed inside a WebSocket binary message.

**Call relations**: Both the plain connection and the multiplexed Noise relay use this whenever they send resume, data, handshake, or reset frames. Tests also use it to create realistic frames.

*Call graph*: called by 10 (spawn_noise_virtual_stream, noise_harness_connection_from_websocket, harness_connection_from_websocket, send_reset, harness_connection_sends_keepalive_and_receives_relay_data, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation, pending_harness_key_validation_does_not_block_new_handshakes, repeated_early_data_during_validation_closes_the_physical_relay, repeated_malformed_handshakes_close_the_physical_relay); 1 external calls (encode_to_vec).


##### `decode_relay_message_frame`  (lines 207–212)

```
fn decode_relay_message_frame(
    payload: &[u8],
) -> Result<RelayMessageFrame, ExecServerError>
```

**Purpose**: Parses bytes from a WebSocket binary message back into a relay frame. It is the receive-side partner of `encode_relay_message_frame`.

**Data flow**: It receives raw bytes. It asks the protobuf decoder to read them as a `RelayMessageFrame`; decoding failures become protocol errors with a clear message.

**Call relations**: Incoming WebSocket frames in both relay modes pass through this before validation and routing. Tests use it to inspect what the relay sent.

*Call graph*: called by 5 (noise_harness_connection_from_websocket, harness_connection_keeps_outbound_frame_while_send_is_backpressured, read_resume_stream_id, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation); 1 external calls (decode).


##### `jsonrpc_payload`  (lines 214–216)

```
fn jsonrpc_payload(message: &JSONRPCMessage) -> Result<Vec<u8>, ExecServerError>
```

**Purpose**: Turns a JSON-RPC message into bytes that can be carried inside a relay data frame. This keeps JSON formatting details out of the relay loops.

**Data flow**: It receives a `JSONRPCMessage`, serializes it as JSON bytes, and returns those bytes or a JSON error.

**Call relations**: The plain harness connection uses this before wrapping outgoing JSON-RPC messages in relay data frames. Tests also use it to build valid incoming data frames.

*Call graph*: called by 1 (harness_connection_sends_keepalive_and_receives_relay_data); 1 external calls (to_vec).


##### `send_event_with_keepalive`  (lines 223–247)

```
async fn send_event_with_keepalive(
    websocket: &mut T,
    keepalive: &mut tokio::time::Interval,
    incoming_tx: &mpsc::Sender<JsonRpcConnectionEvent>,
    event: JsonRpcConnectionEvent,
) -> Re
```

**Purpose**: Sends an event into the server’s incoming-message queue while still keeping the WebSocket alive. This matters when the queue is full and sending has to wait.

**Data flow**: It receives a WebSocket writer, a keepalive timer, an incoming-event channel, and the event to send. While waiting for the event channel to accept the event, it sends WebSocket ping messages on each keepalive tick. It returns success, or tells the caller whether the incoming queue or WebSocket closed.

**Call relations**: The plain relay reader calls this before handing a decoded JSON-RPC message to the rest of the server. The dedicated test proves that keepalive pings continue even while the incoming queue is backed up.

*Call graph*: called by 1 (send_event_with_keepalive_pings_while_incoming_queue_is_full); 3 external calls (send, pin!, select!).


##### `harness_connection_from_websocket`  (lines 249–424)

```
fn harness_connection_from_websocket(
    stream: T,
    connection_label: String,
) -> JsonRpcConnection
```

**Purpose**: Converts one WebSocket into one plain `JsonRpcConnection`. It hides relay framing so the rest of the server can send and receive JSON-RPC events normally.

**Data flow**: It receives a WebSocket-like stream and a label for logs and errors. It creates outgoing and incoming channels, chooses a fresh stream id, sends a resume frame, then runs a background task that translates outgoing JSON-RPC messages into relay data frames and incoming relay data frames back into JSON-RPC events. It returns a `JsonRpcConnection` connected to that task.

**Call relations**: Higher-level connection setup calls this after accepting or opening a relay WebSocket. Inside its loop it uses frame encoding, decoding, JSON serialization, validation, and `send_event_with_keepalive` to bridge WebSocket traffic to the server’s normal connection interface.

*Call graph*: calls 1 internal fn (encode_relay_message_frame); called by 5 (connect_websocket, harness_connection_keeps_outbound_frame_while_send_is_backpressured, harness_connection_reports_server_close, harness_connection_reports_text_frames_as_malformed, harness_connection_sends_keepalive_and_receives_relay_data); 10 external calls (new_v4, resume, channel, select!, spawn, now, interval_at, vec!, channel, Binary).


##### `run_multiplexed_environment`  (lines 452–809)

```
async fn run_multiplexed_environment(
    stream: WebSocketStream<S>,
    processor: ConnectionProcessor,
    environment_id: String,
    executor_registration_id: String,
    identity: NoiseChannelId
```

**Purpose**: Runs the encrypted, multi-stream relay for one executor WebSocket. It lets many authenticated harness connections share one physical WebSocket safely.

**Data flow**: It receives the WebSocket, the connection processor, environment and registration ids, the executor’s Noise identity, and a key validator. It splits the WebSocket into reader and writer halves, sends outgoing frames through a shared writer task, tracks active virtual streams and pending handshakes, validates harness keys with timeouts, starts virtual streams only after authorization succeeds, routes data frames to the right stream, and sends resets for bad or rejected streams. When the WebSocket ends, it disconnects all remaining streams and aborts unfinished validation work.

**Call relations**: `run_remote_environment` calls this to serve a remote environment over the relay. It coordinates with Noise handshake code, `spawn_noise_virtual_stream` for per-stream JSON-RPC processing, the validator for authorization, and helpers such as `send_reset` and `failed_handshake_budget_exhausted` for protection against repeated bad attempts.

*Call graph*: calls 4 internal fn (read_request, noise_channel_prologue, failed_handshake_budget_exhausted, send_reset); called by 2 (multiplexed_environment_sends_keepalive, run_remote_environment); 16 external calls (new, new, from_utf8, clone, validate_harness_key, disconnect, receive_data, split, Protocol, take (+6 more)).


##### `failed_handshake_budget_exhausted`  (lines 815–818)

```
fn failed_handshake_budget_exhausted(failed_handshakes: &mut usize) -> bool
```

**Purpose**: Counts failed Noise handshake attempts and decides when the relay should give up on the whole WebSocket. This prevents an unauthorized peer from forcing unlimited cryptographic or registry work.

**Data flow**: It receives a mutable failure counter, increments it by one, and returns true once the fixed failure limit has been reached.

**Call relations**: `run_multiplexed_environment` calls this after duplicate, malformed, failed, or unauthorized handshake attempts. When it returns true, the main relay loop closes the physical relay.

*Call graph*: called by 1 (run_multiplexed_environment).


##### `send_reset`  (lines 835–838)

```
fn send_reset(physical_outgoing_tx: &mpsc::Sender<Vec<u8>>, stream_id: String)
```

**Purpose**: Queues a reset frame for a stream without waiting. It is a best-effort way to tell the peer that a virtual stream has been rejected or closed.

**Data flow**: It receives the shared outgoing-byte channel and a stream id. It builds a reset frame with the standard relay reset reason, encodes it, and tries to place it on the outgoing queue; if the queue cannot accept it immediately, it silently drops the reset.

**Call relations**: `run_multiplexed_environment` calls this in many rejection paths: bad handshakes, too many streams, unknown data streams, and stream processing errors.

*Call graph*: calls 1 internal fn (encode_relay_message_frame); called by 1 (run_multiplexed_environment); 2 external calls (try_send, reset).


##### `tests::harness_connection_sends_keepalive_and_receives_relay_data`  (lines 871–899)

```
async fn harness_connection_sends_keepalive_and_receives_relay_data() -> anyhow::Result<()>
```

**Purpose**: Tests that a plain harness connection sends keepalive pings and can receive a relay data frame as a JSON-RPC message.

**Data flow**: It creates a client/server WebSocket pair, wraps the client with `harness_connection_from_websocket`, reads the initial stream id and keepalive ping from the server side, sends a valid relay data frame back, and checks that the connection produces the expected JSON-RPC event.

**Call relations**: This test exercises the normal receive path through frame encoding, JSON payload creation, WebSocket reading, relay decoding, and JSON-RPC delivery.

*Call graph*: calls 3 internal fn (encode_relay_message_frame, harness_connection_from_websocket, jsonrpc_payload); 8 external calls (assert!, data, read_keepalive_ping, read_resume_stream_id, test_jsonrpc_message, websocket_pair, Binary, Pong).


##### `tests::multiplexed_environment_sends_keepalive`  (lines 902–923)

```
async fn multiplexed_environment_sends_keepalive() -> anyhow::Result<()>
```

**Purpose**: Tests that the multiplexed Noise environment sends WebSocket keepalive pings even before any virtual stream is active.

**Data flow**: It creates a WebSocket pair, starts `run_multiplexed_environment` with a test validator and generated Noise identity, waits for a ping on the server side, then aborts the task.

**Call relations**: This test checks the writer task inside `run_multiplexed_environment`, especially the keepalive behavior that protects idle executor WebSockets.

*Call graph*: calls 4 internal fn (generate, run_multiplexed_environment, new, new); 4 external calls (read_keepalive_ping, websocket_pair, current_exe, spawn).


##### `tests::AllowHarnessKeyValidator::validate_harness_key`  (lines 929–935)

```
async fn validate_harness_key(
            &self,
            _harness_public_key: &NoiseChannelPublicKey,
            _authorization: &str,
        ) -> Result<(), ExecServerError>
```

**Purpose**: Provides a test validator that always authorizes the harness key. It lets tests focus on relay behavior instead of registry authorization rules.

**Data flow**: It receives a harness public key and authorization string but does not inspect them. It immediately returns success.

**Call relations**: `tests::multiplexed_environment_sends_keepalive` passes this validator into `run_multiplexed_environment` so the environment can be constructed with a valid validator implementation.


##### `tests::send_event_with_keepalive_pings_while_incoming_queue_is_full`  (lines 939–983)

```
async fn send_event_with_keepalive_pings_while_incoming_queue_is_full() -> anyhow::Result<()>
```

**Purpose**: Tests that `send_event_with_keepalive` keeps pinging the WebSocket while it waits for room in a full incoming-event queue.

**Data flow**: It creates a controlled fake WebSocket and a one-slot incoming channel, fills the channel, starts `send_event_with_keepalive`, observes a ping, frees the queue slot, and checks that the intended JSON-RPC event is finally delivered.

**Call relations**: This test directly exercises the helper used by the plain relay receive loop when backpressure, meaning a temporarily full queue, delays event delivery.

*Call graph*: calls 1 internal fn (send_event_with_keepalive); 8 external calls (assert!, new, Message, test_jsonrpc_message, channel, spawn, now, interval_at).


##### `tests::harness_connection_reports_text_frames_as_malformed`  (lines 986–1001)

```
async fn harness_connection_reports_text_frames_as_malformed() -> anyhow::Result<()>
```

**Purpose**: Tests that the plain relay rejects text WebSocket frames. The relay protocol expects binary protobuf frames, not human-readable WebSocket text.

**Data flow**: It starts a harness connection, waits for the initial resume frame, sends a text frame from the server side, and checks that the connection reports a malformed-message event with the expected reason.

**Call relations**: This test covers an error branch inside `harness_connection_from_websocket` and confirms that bad frame types are reported instead of silently accepted.

*Call graph*: calls 1 internal fn (harness_connection_from_websocket); 4 external calls (assert!, read_resume_stream_id, websocket_pair, Text).


##### `tests::harness_connection_reports_server_close`  (lines 1004–1018)

```
async fn harness_connection_reports_server_close() -> anyhow::Result<()>
```

**Purpose**: Tests that the plain relay reports a clean peer close as a disconnection. This is important so callers can stop waiting for more messages.

**Data flow**: It creates a harness connection, reads the initial resume frame, closes the server WebSocket, and checks that the incoming event stream receives a disconnected event with no reason.

**Call relations**: This test exercises the WebSocket close handling inside `harness_connection_from_websocket`.

*Call graph*: calls 1 internal fn (harness_connection_from_websocket); 3 external calls (assert!, read_resume_stream_id, websocket_pair).


##### `tests::harness_connection_keeps_outbound_frame_while_send_is_backpressured`  (lines 1021–1057)

```
async fn harness_connection_keeps_outbound_frame_while_send_is_backpressured() -> anyhow::Result<()>
```

**Purpose**: Tests that an outgoing JSON-RPC message is not lost when the WebSocket writer is temporarily unable to send. Backpressure here means the socket says, “not ready yet.”

**Data flow**: It uses a controlled fake WebSocket, blocks writes, queues an outgoing JSON-RPC message, proves no incoming event appears just because writing is blocked, then unblocks writing and checks that the correct relay data frame is sent with the original message.

**Call relations**: This test covers the outgoing side of `harness_connection_from_websocket` and uses `decode_relay_message_frame` to inspect the binary frame that was eventually written.

*Call graph*: calls 2 internal fn (decode_relay_message_frame, harness_connection_from_websocket); 8 external calls (from_secs, bail!, assert!, assert_eq!, new, test_jsonrpc_message, timeout, Pong).


##### `tests::websocket_pair`  (lines 1059–1072)

```
async fn websocket_pair() -> anyhow::Result<(
        WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WebSocketStream<tokio::net::TcpStream>,
    )>
```

**Purpose**: Creates a connected pair of real WebSockets for tests. One side acts like the client and the other like the server.

**Data flow**: It binds a local TCP listener, starts a task to accept and upgrade one connection to WebSocket, connects to that listener, and returns both WebSocket endpoints.

**Call relations**: Several relay tests call this helper so they can exercise real WebSocket behavior without needing an external server.

*Call graph*: 5 external calls (bind, format!, spawn, accept_async, connect_async).


##### `tests::read_resume_stream_id`  (lines 1074–1086)

```
async fn read_resume_stream_id(
        websocket: &mut WebSocketStream<tokio::net::TcpStream>,
    ) -> anyhow::Result<String>
```

**Purpose**: Reads the first resume frame from a test WebSocket and returns its stream id. Tests need this id to send frames that the relay will accept.

**Data flow**: It waits for the next WebSocket message, requires it to be binary, decodes it as a relay frame, checks that it is a resume frame, and returns the frame’s stream id.

**Call relations**: Plain harness connection tests call this right after creating `harness_connection_from_websocket`, because that connection sends a resume frame before normal data exchange.

*Call graph*: calls 1 internal fn (decode_relay_message_frame); 5 external calls (from_secs, next, bail!, assert_eq!, timeout).


##### `tests::read_keepalive_ping`  (lines 1088–1101)

```
async fn read_keepalive_ping(
        websocket: &mut WebSocketStream<tokio::net::TcpStream>,
    ) -> anyhow::Result<()>
```

**Purpose**: Waits until a test WebSocket receives a ping frame. It ignores unrelated non-close messages while looking for the keepalive.

**Data flow**: It repeatedly waits for the next WebSocket message with a timeout. If it sees a ping, it returns success; if the socket closes or no ping arrives in time, it fails the test.

**Call relations**: Keepalive-related tests use this helper to confirm that both plain and multiplexed relay paths keep the WebSocket alive during idle periods.

*Call graph*: 4 external calls (from_secs, next, bail!, timeout).


##### `tests::test_jsonrpc_message`  (lines 1103–1110)

```
fn test_jsonrpc_message() -> JSONRPCMessage
```

**Purpose**: Builds a small sample JSON-RPC request for tests. It gives tests a consistent message to send through the relay.

**Data flow**: It creates a JSON-RPC request with integer id `1`, method name `test`, and no parameters or trace data, then wraps it as a `JSONRPCMessage`.

**Call relations**: Several tests use this helper when they need a valid JSON-RPC payload for relay data frames or outgoing connection messages.

*Call graph*: 2 external calls (Request, Integer).


##### `tests::ControlledWebSocket::new`  (lines 1130–1161)

```
fn new(
            write_ready: bool,
        ) -> (
            Self,
            ControlledWebSocketHandle,
            futures_mpsc::UnboundedReceiver<Message>,
        )
```

**Purpose**: Creates a fake WebSocket whose read and write readiness can be controlled by a test. This makes it possible to test backpressure and keepalive timing reliably.

**Data flow**: It receives an initial write-ready flag. It builds inbound and outbound message channels plus shared atomic flags and wakers, then returns the fake WebSocket, a handle for controlling it, and a receiver for messages written by the relay.

**Call relations**: Tests use this instead of a real socket when they need precise control over whether writes are ready or blocked, especially around `send_event_with_keepalive` and outgoing relay frames.

*Call graph*: 5 external calls (clone, new, new, new, unbounded).


##### `tests::ControlledWebSocketHandle::send_inbound`  (lines 1165–1169)

```
fn send_inbound(&self, message: Message) -> anyhow::Result<()>
```

**Purpose**: Injects an incoming WebSocket message into the controlled fake socket. From the relay’s point of view, this looks like the peer sent a message.

**Data flow**: It receives a WebSocket message, wraps it as a successful inbound item, and pushes it into the fake socket’s inbound channel. It returns success or a send error.

**Call relations**: Backpressure tests use this handle method to send pongs or other peer messages while the relay task is using the fake WebSocket.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocketHandle::set_write_blocked`  (lines 1171–1173)

```
fn set_write_blocked(&self)
```

**Purpose**: Marks the fake WebSocket as not ready to write. This simulates a real socket applying backpressure.

**Data flow**: It changes the shared write-ready flag to false. Future write readiness checks will pause instead of accepting a message.

**Call relations**: The outbound backpressure test calls this before queueing a message, so it can prove the relay keeps the message until writing becomes possible.


##### `tests::ControlledWebSocketHandle::set_write_ready`  (lines 1175–1178)

```
fn set_write_ready(&self)
```

**Purpose**: Marks the fake WebSocket as ready to write again and wakes any task waiting on it.

**Data flow**: It changes the shared write-ready flag to true and wakes the stored writer task. After this, pending sends can continue.

**Call relations**: Backpressure tests call this after confirming a write is blocked, allowing the relay send path to finish and emit the expected frame.


##### `tests::ControlledWebSocketHandle::wait_for_blocked_write`  (lines 1180–1194)

```
async fn wait_for_blocked_write(&self) -> anyhow::Result<()>
```

**Purpose**: Waits until the fake WebSocket has actually observed a blocked write attempt. This avoids races in tests.

**Data flow**: It polls a shared flag until the fake socket reports that a writer tried to send while writes were blocked, with a timeout to prevent hanging forever.

**Call relations**: The outbound backpressure test uses this after disabling writes, so it knows the relay task is truly waiting before it changes other conditions.

*Call graph*: 3 external calls (from_secs, poll_fn, timeout).


##### `tests::ControlledWebSocket::poll_ready`  (lines 1200–1209)

```
fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements the fake socket’s write-readiness check for the `Sink` interface. A sink is an asynchronous place where code can send messages.

**Data flow**: It reads the shared write-ready flag. If writing is allowed, it reports ready; otherwise it records that a write is blocked, wakes anyone waiting for that fact, stores the current task’s waker, and reports pending.

**Call relations**: The relay’s normal WebSocket send code calls this indirectly when using the fake socket in tests. The control handle changes the flags that determine this function’s answer.

*Call graph*: 2 external calls (waker, Ready).


##### `tests::ControlledWebSocket::start_send`  (lines 1211–1216)

```
fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error>
```

**Purpose**: Records a message that the relay wrote to the fake WebSocket. Tests can then inspect the outbound channel to see what would have gone over the network.

**Data flow**: It receives a WebSocket message and pushes it into the fake socket’s outbound channel. It returns success if the test receiver is still present.

**Call relations**: This is called by the relay send path after `poll_ready` says writing is possible. Tests read from the paired outbound receiver to assert on pings and binary relay frames.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocket::poll_flush`  (lines 1218–1223)

```
fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Reports that the fake socket has flushed all written data. For these tests, flushing is immediate.

**Data flow**: It ignores the polling context and returns ready success without changing state.

**Call relations**: The generic WebSocket sending code may call this as part of the `Sink` contract. The fake implementation keeps it simple because outbound messages are stored immediately.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_close`  (lines 1225–1230)

```
fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Reports that the fake socket can close immediately. The tests do not need a detailed close handshake.

**Data flow**: It ignores the polling context and returns ready success without changing state.

**Call relations**: This completes the fake socket’s `Sink` implementation so it can be used anywhere the relay expects a WebSocket-like writer.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_next`  (lines 1236–1238)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements the fake socket’s receive side. It lets relay code read messages that the test injected.

**Data flow**: It polls the inbound channel for the next injected message and returns that message, pending, or end-of-stream depending on the channel state.

**Call relations**: The relay’s normal WebSocket read loop calls this indirectly during tests. `ControlledWebSocketHandle::send_inbound` feeds the channel that this function reads.

*Call graph*: 1 external calls (new).
