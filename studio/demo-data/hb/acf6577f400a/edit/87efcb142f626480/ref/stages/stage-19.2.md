# App-server, exec-server, and relay transport channels  `stage-19.2`

This stage is shared plumbing. It sits behind the scenes and gives different parts of the system reliable ways to move data between processes and services, whether that data is a small message, an HTTP response, a file, or an encrypted relay packet.

At the center, app-server-transport/src/transport/mod.rs defines the common transport building blocks: how a connection is described, how incoming events are forwarded, how outgoing messages are encoded, and what to do when the system is overloaded. The remote-control files add two special jobs on top of that. segment.rs breaks large websocket messages into chunks and puts incoming chunks back together. clients.rs talks to the backend service to list or revoke enrolled remote-control clients.

On the exec-server side, http_client.rs and http_response_body_stream.rs make HTTP responses look the same whether they come directly from a local request or arrive piece by piece through remote procedure calls. remote_file_stream.rs does the same for remote files, reading them in chunks and closing them when finished.

For secure relay traffic, noise_channel.rs sets up an authenticated encrypted channel, ordered_ciphertext.rs straightens slightly out-of-order packets, message_framing.rs preserves message boundaries, and relay.rs carries those framed encrypted messages over websockets.

## Files in this stage

### App transport foundation
These modules define the shared app-server transport layer and the remote-control-specific message and client-management pieces built on top of it.

### `app-server-transport/src/transport/mod.rs`

`orchestration` · `startup transport selection and cross-cutting message forwarding`

This module defines the common transport vocabulary and helper logic used across all connection types. It exposes path helpers for the default unix control socket and startup lock under `CODEX_HOME`, and defines `AppServerTransport`, which can be `Stdio`, `UnixSocket`, `WebSocket`, or `Off`. `from_listen_url` parses the CLI `--listen` value, supporting `stdio://`, `unix://` with either an explicit path or the default control-socket location, `ws://IP:PORT`, and `off`; parse failures are represented by `AppServerTransportParseError` with user-facing `Display` messages.

For live connections, the file defines `TransportEvent` variants for connection open/close and inbound JSON-RPC messages, plus `ConnectionOrigin` to distinguish stdio, in-process, websocket, and remote-control sources. `next_connection_id` allocates stable ids from a global `AtomicU64`. The inbound forwarding path is intentionally nuanced: `forward_incoming_message` deserializes raw JSON text into `JSONRPCMessage`, logging and dropping malformed payloads without tearing down the connection. `enqueue_incoming_message` first tries a non-blocking send into the transport-event queue; if the queue is full and the message is a JSON-RPC request, it immediately attempts to enqueue an overload error response (`code -32001`) back to the same connection instead of blocking. Non-request messages, or requests when the queue-full pattern does not match, fall back to an awaited send so responses and notifications are preserved. `serialize_outgoing_message` converts `OutgoingMessage` to JSON via `serde_json::to_value` then `to_string`, logging serialization failures and returning `None` rather than panicking. The tests focus on overload semantics and queue-backpressure behavior.

#### Function details

##### `app_server_control_socket_path`  (lines 56–62)

```
fn app_server_control_socket_path(codex_home: &Path) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Builds the default absolute unix-socket path used for app-server control connections under the Codex home directory. It centralizes the directory and filename convention.

**Data flow**: Takes `&Path` for `codex_home`, appends `app-server-control/app-server-control.sock`, converts the result to `AbsolutePathBuf`, and returns it or an `io::Error` if the path is not absolute/valid.

**Call relations**: Called by `AppServerTransport::from_listen_url` when parsing `unix://` with no explicit socket path.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (from_listen_url); 1 external calls (join).


##### `app_server_startup_lock_path`  (lines 64–70)

```
fn app_server_startup_lock_path(codex_home: &Path) -> std::io::Result<AbsolutePathBuf>
```

**Purpose**: Builds the absolute path of the startup lock file used to coordinate app-server startup. It mirrors the control-socket directory layout.

**Data flow**: Accepts `&Path` for `codex_home`, appends `app-server-control/app-server-startup.lock`, converts to `AbsolutePathBuf`, and returns the result.

**Call relations**: Used during startup orchestration outside this file when transport options require a startup lock.

*Call graph*: calls 1 internal fn (from_absolute_path); called by 1 (run_main_with_transport_options); 1 external calls (join).


##### `AppServerTransportParseError::fmt`  (lines 88–106)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats transport parse errors into user-facing CLI messages that explain the accepted `--listen` forms. Each variant includes the offending input and, for unix paths, the underlying resolution message.

**Data flow**: Borrows the parse error and formatter, matches on the enum variant, writes the corresponding explanatory string, and returns the formatting result.

**Call relations**: Used implicitly when transport parsing errors are surfaced to users or tests.

*Call graph*: 1 external calls (write!).


##### `AppServerTransport::from_listen_url`  (lines 114–158)

```
fn from_listen_url(listen_url: &str) -> Result<Self, AppServerTransportParseError>
```

**Purpose**: Parses the `--listen` URL string into a concrete transport configuration. It supports defaults, derived unix-socket paths, explicit websocket bind addresses, and disabling transport entirely.

**Data flow**: Takes a listen URL string, returns `Stdio` for `stdio://`, handles `unix://` by either resolving the default socket path from `find_codex_home` and `app_server_control_socket_path` or converting an explicit path relative to the current directory, returns `Off` for `off`, parses `ws://IP:PORT` into `SocketAddr` for `WebSocket`, and otherwise returns `UnsupportedListenUrl` or a more specific parse error.

**Call relations**: Called by CLI/config parsing to decide which transport subsystem to start. It delegates path resolution to helper functions and `AbsolutePathBuf` constructors.

*Call graph*: calls 3 internal fn (app_server_control_socket_path, find_codex_home, relative_to_current_dir); called by 1 (explicit_remote_control_startup_fails_when_disabled_by_requirements); 1 external calls (UnsupportedListenUrl).


##### `AppServerTransport::from_str`  (lines 164–166)

```
fn from_str(s: &str) -> Result<Self, Self::Err>
```

**Purpose**: Implements `FromStr` by delegating directly to `from_listen_url`. This allows transport parsing through generic string-parsing APIs.

**Data flow**: Accepts a string slice and returns the result of `Self::from_listen_url(s)`.

**Call relations**: Used implicitly by argument parsing or tests that rely on `FromStr` rather than calling `from_listen_url` directly.

*Call graph*: 1 external calls (from_listen_url).


##### `next_connection_id`  (lines 196–198)

```
fn next_connection_id() -> ConnectionId
```

**Purpose**: Allocates a new stable connection identifier from a global atomic counter. It provides unique ids across all transport origins.

**Data flow**: Fetches and increments `CONNECTION_ID_COUNTER` with relaxed ordering, wraps the previous value in `ConnectionId`, and returns it.

**Call relations**: Used by transport implementations and remote-control client tracking whenever a new logical connection is opened.

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

**Purpose**: Deserializes a raw inbound JSON string into a `JSONRPCMessage` and forwards it into the transport event pipeline. Malformed payloads are logged and ignored without disconnecting the sender.

**Data flow**: Takes the transport-event sender, writer sender, connection id, and raw payload string. It attempts `serde_json::from_str::<JSONRPCMessage>`; on success it awaits `enqueue_incoming_message`, and on parse failure it logs an error and returns `true` to indicate the connection should remain alive.

**Call relations**: Called by concrete transport readers after they receive a text frame or line. It delegates queue/backpressure handling to `enqueue_incoming_message`.

*Call graph*: calls 1 internal fn (enqueue_incoming_message); 1 external calls (error!).


##### `enqueue_incoming_message`  (lines 217–256)

```
async fn enqueue_incoming_message(
    transport_event_tx: &mpsc::Sender<TransportEvent>,
    writer: &mpsc::Sender<QueuedOutgoingMessage>,
    connection_id: ConnectionId,
    message: JSONRPCMessage
```

**Purpose**: Forwards an already parsed inbound JSON-RPC message into the central transport-event queue, with special overload handling for requests when the queue is full. It is the key backpressure policy point for inbound traffic.

**Data flow**: Accepts the transport-event sender, writer sender, connection id, and `JSONRPCMessage`. It wraps the message in `TransportEvent::IncomingMessage` and first tries `try_send`. If the queue is closed it returns `false`. If the queue is full specifically with an incoming request, it constructs an `OutgoingMessage::Error` carrying code `-32001` and the original request id, then tries to enqueue that overload response to the writer without blocking; if the writer is also full it logs a warning and still returns `true`. For all other full-queue cases it awaits `transport_event_tx.send(event)` and returns whether that succeeds.

**Call relations**: Called by `forward_incoming_message` and directly by tests. It uses `QueuedOutgoingMessage::new` to package overload responses.

*Call graph*: calls 1 internal fn (new); called by 3 (forward_incoming_message, enqueue_incoming_request_does_not_block_when_writer_queue_is_full, enqueue_incoming_response_waits_instead_of_dropping_when_queue_is_full); 4 external calls (send, try_send, Error, warn!).


##### `serialize_outgoing_message`  (lines 258–273)

```
fn serialize_outgoing_message(outgoing_message: OutgoingMessage) -> Option<String>
```

**Purpose**: Serializes an `OutgoingMessage` into a JSON string suitable for transport writers. It logs and suppresses serialization failures instead of propagating panics.

**Data flow**: Consumes an `OutgoingMessage`, converts it to a `serde_json::Value` with `to_value`, then to a string with `to_string`, returning `Some(json)` on success or `None` after logging any conversion/serialization error.

**Call relations**: Used by concrete transport writers before sending outbound messages over stdio, sockets, or websockets.

*Call graph*: 3 external calls (error!, to_string, to_value).


##### `tests::listen_off_parses_as_off_transport`  (lines 290–295)

```
fn listen_off_parses_as_off_transport()
```

**Purpose**: Verifies that the special `off` listen URL parses to `AppServerTransport::Off`. It protects the transport-disable CLI behavior.

**Data flow**: Calls `AppServerTransport::from_listen_url("off")` and asserts equality with `Ok(AppServerTransport::Off)`.

**Call relations**: Exercises the `from_listen_url` parser directly.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::enqueue_incoming_request_returns_overload_error_when_queue_is_full`  (lines 298–356)

```
async fn enqueue_incoming_request_returns_overload_error_when_queue_is_full()
```

**Purpose**: Checks that when the inbound transport-event queue is full, a JSON-RPC request receives an immediate overload error response instead of blocking. It validates the request-specific backpressure policy.

**Data flow**: Creates one-slot transport and writer channels, pre-fills the transport queue with a notification event, constructs a request message, calls `enqueue_incoming_message`, then drains the original queued event and inspects the writer queue to assert that it contains the expected overload error JSON with code `-32001` and the original request id.

**Call relations**: Directly tests the queue-full request branch in `enqueue_incoming_message`.

*Call graph*: 10 external calls (Notification, Request, Integer, new, assert!, assert_eq!, json!, channel, panic!, to_value).


##### `tests::enqueue_incoming_response_waits_instead_of_dropping_when_queue_is_full`  (lines 359–425)

```
async fn enqueue_incoming_response_waits_instead_of_dropping_when_queue_is_full()
```

**Purpose**: Verifies that non-request messages, specifically responses, are not dropped or converted to overload errors when the transport queue is full. Instead they wait until capacity becomes available.

**Data flow**: Creates one-slot channels, pre-fills the transport queue, spawns a task that calls `enqueue_incoming_message` with a response, drains the first queued event to free capacity, awaits the enqueue task, and then asserts that the response was forwarded as a normal `TransportEvent::IncomingMessage`.

**Call relations**: Exercises the fallback awaited-send branch in `enqueue_incoming_message` for non-request messages.

*Call graph*: calls 1 internal fn (enqueue_incoming_message); 10 external calls (Notification, Response, Integer, new, assert!, assert_eq!, json!, channel, panic!, spawn).


##### `tests::enqueue_incoming_request_does_not_block_when_writer_queue_is_full`  (lines 428–489)

```
async fn enqueue_incoming_request_does_not_block_when_writer_queue_is_full()
```

**Purpose**: Ensures that request overload handling remains non-blocking even if the outbound writer queue is already full. The original queued outbound message must remain intact.

**Data flow**: Creates one-slot transport and writer channels, pre-fills both queues, calls `enqueue_incoming_message` with a request under a short timeout, asserts the call completes promptly, then drains the writer queue and verifies it still contains the original notification rather than a blocked or replaced overload response.

**Call relations**: Tests the nested queue-full path in `enqueue_incoming_message` where both inbound and outbound queues are saturated.

*Call graph*: calls 2 internal fn (new, enqueue_incoming_message); 13 external calls (from_millis, ConfigWarning, Notification, Request, Integer, new, AppServerNotification, assert!, assert_eq!, json! (+3 more)).


### `app-server-transport/src/transport/remote_control/segment.rs`

`domain_logic` · `request handling and websocket send/receive paths for large messages`

This file enforces the remote-control transport’s message size limits by converting between whole JSON-RPC messages and segmented wire envelopes. On the inbound side, `ClientSegmentReassembler` tracks at most one in-progress assembly per `ClientId` in a `HashMap`. Each `ClientSegmentAssembly` records the active `StreamId`, expected metadata (`seq_id`, `segment_count`, `message_size_bytes`), accumulated raw bytes, the next expected segment index, and the timestamp of the last chunk for LRU eviction.

`observe` is the core state machine. Non-chunk envelopes pass straight through. Chunk envelopes must include both `seq_id` and `stream_id`; otherwise they are dropped with warnings. The method ignores stale chunks that are older than the current assembly, resets assembly state when the stream changes, rejects invalid counts/sizes/base64, enforces in-order delivery, and only emits a reconstructed `ClientMessage` once all chunks decode successfully and the final byte length matches `message_size_bytes`. Any malformed or out-of-order current chunk drops the assembly for that client/stream; stale duplicates are dropped without disturbing the newer assembly.

On the outbound side, `split_server_envelope_for_transport` leaves non-message events untouched and only segments `ServerMessage` envelopes whose serialized size exceeds `REMOTE_CONTROL_SEGMENT_MAX_BYTES`. It serializes the inner `OutgoingMessage`, rejects payloads above `REMOTE_CONTROL_REASSEMBLED_MAX_BYTES`, checks that even a one-byte chunk can fit within the envelope limit, then searches for a chunk size/segment count where every encoded chunk envelope stays under the wire-size cap. Chunk envelopes carry base64 payload plus original message size and segment count. `CountingWriter` and `serialized_len` let the code measure JSON size without allocating a full serialized string.

#### Function details

##### `ClientSegmentReassembler::observe`  (lines 51–224)

```
fn observe(&mut self, envelope: ClientEnvelope) -> ClientSegmentObservation
```

**Purpose**: Consumes one inbound client envelope and either forwards it unchanged, buffers it as part of an in-progress chunk assembly, drops it, or emits a fully reassembled `ClientMessage` envelope.

**Data flow**: Takes ownership of a `ClientEnvelope`. If `event` is not `ClientMessageChunk`, it returns `ClientSegmentObservation::Forward(Box::new(envelope))`. For chunk events it extracts segment metadata, requires `seq_id` and `stream_id`, checks `should_ignore_chunk` for stale duplicates, validates segment counts, message size, and non-empty base64, creates or resets a `ClientSegmentAssembly` as needed, and then updates the assembly in place. It decodes the base64 chunk into the assembly buffer, advances `next_segment_id`, and when the final chunk arrives verifies total size and deserializes `JSONRPCMessage`. Depending on the outcome it returns `Pending`, `Dropped`, or `Forward` with a synthesized `ClientEvent::ClientMessage` envelope. It also removes assemblies on fatal errors or completion.

**Call relations**: Called by websocket client-message observation logic. It is the sole reassembly state machine for inbound segmented traffic and delegates stale checks, metadata extraction, eviction, and assembly removal to helpers.

*Call graph*: calls 4 internal fn (from_envelope, evict_assemblies_if_full, remove_assembly, should_ignore_chunk); called by 1 (observe_client_message); 8 external calls (new, now, new, Complete, Forward, decoded_len_estimate, min, warn!).


##### `ClientSegmentReassembler::invalidate_stream`  (lines 226–228)

```
fn invalidate_stream(&mut self, client_id: &ClientId, stream_id: &StreamId)
```

**Purpose**: Drops any in-progress assembly for a specific client and stream.

**Data flow**: Takes borrowed `ClientId` and `StreamId`, calls `remove_assembly`, and returns unit.

**Call relations**: Used when stream lifecycle events indicate that partial chunks for that stream should no longer be accepted.

*Call graph*: calls 1 internal fn (remove_assembly); called by 1 (observe_client_message).


##### `ClientSegmentReassembler::invalidate_client`  (lines 230–232)

```
fn invalidate_client(&mut self, client_id: &ClientId)
```

**Purpose**: Drops any in-progress assembly for an entire client regardless of stream.

**Data flow**: Removes the `client_id` entry from `assemblies` and returns unit.

**Call relations**: Used when a client disconnects or is otherwise invalidated wholesale.


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

**Purpose**: Determines whether a chunk is stale relative to the currently tracked assembly for the same client and stream.

**Data flow**: Reads the current assembly for `client_id` and returns `true` when the stream matches and either the incoming `seq_id` is older than the assembly’s `seq_id` or it is the same `seq_id` with a `segment_id` lower than `next_segment_id`.

**Call relations**: Consulted before validation and also by higher-level message observation logic so stale duplicates do not tear down a newer assembly.

*Call graph*: called by 2 (observe, observe_client_message).


##### `ClientSegmentReassembler::remove_assembly`  (lines 249–257)

```
fn remove_assembly(&mut self, client_id: &ClientId, stream_id: &StreamId)
```

**Purpose**: Conditionally removes the tracked assembly for a client only if it belongs to the specified stream.

**Data flow**: Looks up `client_id` in `assemblies`, compares the stored `stream_id` to the provided one, and removes the map entry only on match.

**Call relations**: Used by `observe` and `invalidate_stream` to avoid deleting a replacement assembly that may already exist for a different stream.

*Call graph*: called by 2 (invalidate_stream, observe).


##### `ClientSegmentReassembler::evict_assemblies_if_full`  (lines 259–271)

```
fn evict_assemblies_if_full(&mut self)
```

**Purpose**: Enforces the maximum number of concurrent in-progress assemblies by evicting the least recently updated ones.

**Data flow**: While `assemblies.len()` is at or above `REMOTE_CONTROL_SEGMENT_ASSEMBLY_MAX_COUNT`, it finds the entry with the minimum `last_chunk_seen_at` and removes it.

**Call relations**: Called when a new assembly must be inserted and the map is already full.

*Call graph*: called by 1 (observe).


##### `ClientSegmentMetadata::from_envelope`  (lines 282–296)

```
fn from_envelope(envelope: &ClientEnvelope) -> Option<Self>
```

**Purpose**: Extracts the metadata needed to identify and validate a chunk assembly from a chunk envelope.

**Data flow**: Pattern-matches `ClientEnvelope.event` as `ClientMessageChunk`, reads `segment_count` and `message_size_bytes`, pulls `seq_id` from `envelope.seq_id`, and returns `Some(ClientSegmentMetadata)` or `None` if the envelope is not a chunk or lacks `seq_id`.

**Call relations**: Used only by `observe` as the canonical metadata extractor for inbound chunk handling.

*Call graph*: called by 1 (observe).


##### `split_server_envelope_for_transport`  (lines 299–385)

```
fn split_server_envelope_for_transport(
    envelope: ServerEnvelope,
) -> io::Result<Vec<ServerEnvelope>>
```

**Purpose**: Splits an oversized outbound `ServerMessage` envelope into multiple `ServerMessageChunk` envelopes that each fit within the wire-size limit.

**Data flow**: Consumes a `ServerEnvelope`. If the event is not `ServerMessage`, it returns a one-element vector containing the original envelope. Otherwise it measures the serialized envelope size with `serialized_len`; if already within `REMOTE_CONTROL_SEGMENT_MAX_BYTES`, it returns the original envelope unchanged. For oversized messages it serializes the inner `OutgoingMessage` to bytes, rejects payloads above `REMOTE_CONTROL_REASSEMBLED_MAX_BYTES`, verifies that even the smallest possible chunk envelope can fit, then iteratively chooses a `segment_count`/`chunk_size` pair and checks every chunk with `serialized_chunk_len`. Once all chunks fit, it maps each raw chunk through `build_chunk_envelope` and returns the vector. If no valid segmentation exists, it logs a warning and returns an empty vector.

**Call relations**: Called by the server-writer path before websocket transmission. It is the outbound counterpart to the inbound reassembler.

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

**Purpose**: Measures the serialized JSON size of a hypothetical chunk envelope.

**Data flow**: Builds a chunk envelope from the provided parameters via `build_chunk_envelope`, then passes it to `serialized_len` and returns the resulting byte count.

**Call relations**: Used internally by `split_server_envelope_for_transport` while searching for a chunking strategy that satisfies the wire-size cap.

*Call graph*: calls 2 internal fn (build_chunk_envelope, serialized_len); called by 1 (split_server_envelope_for_transport).


##### `CountingWriter::write`  (lines 409–412)

```
fn write(&mut self, buf: &[u8]) -> io::Result<usize>
```

**Purpose**: Implements `Write` by counting bytes instead of storing them.

**Data flow**: Adds `buf.len()` to `self.len` and returns that length as if all bytes were written successfully.

**Call relations**: Used by `serialized_len` to measure JSON serialization output without allocating a buffer.


##### `CountingWriter::flush`  (lines 414–416)

```
fn flush(&mut self) -> io::Result<()>
```

**Purpose**: Implements a no-op flush for the counting writer.

**Data flow**: Returns `Ok(())` without changing state.

**Call relations**: Required by the `Write` trait so `serde_json::to_writer` can serialize into `CountingWriter`.


##### `serialized_len`  (lines 419–423)

```
fn serialized_len(value: &impl serde::Serialize) -> io::Result<usize>
```

**Purpose**: Computes the JSON-serialized byte length of any serializable value.

**Data flow**: Creates a default `CountingWriter`, serializes `value` into it with `serde_json::to_writer`, maps serialization errors to `io::Error::other`, and returns the accumulated `len`.

**Call relations**: Shared helper for measuring whole envelopes and candidate chunk envelopes during outbound segmentation.

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

**Purpose**: Constructs one `ServerMessageChunk` envelope carrying a base64-encoded slice of the original message.

**Data flow**: Takes the original `ServerEnvelope` metadata plus `segment_id`, `segment_count`, `message_size_bytes`, and raw chunk bytes. It rejects `segment_count` values above `REMOTE_CONTROL_SEGMENT_COUNT_MAX`, base64-encodes the chunk, and returns a new `ServerEnvelope` preserving `client_id`, `stream_id`, and `seq_id` while replacing the event with `ServerEvent::ServerMessageChunk`.

**Call relations**: Used by both `serialized_chunk_len` and the final chunk-construction phase of `split_server_envelope_for_transport`.

*Call graph*: called by 1 (serialized_chunk_len); 1 external calls (new).


### `app-server-transport/src/transport/remote_control/clients.rs`

`io_transport` · `remote-control management request handling`

This file wraps the remote-control management HTTP endpoints behind typed async functions. It defines internal response models for the list endpoint, a small request enum distinguishing list versus revoke operations, and a `ClientManagementResponse` carrying raw HTTP status, headers, and body bytes. `list_remote_control_clients` validates that `environment_id` is present and that `limit`, if supplied, is between 1 and 100, then builds the environment-specific clients URL, sends the request, checks for HTTP success, decodes the JSON body, and converts each `RemoteControlClientResponse` into the protocol `RemoteControlClient`. `revoke_remote_control_client` similarly validates `environment_id` and `client_id`, appends the client id to the same base URL, sends a DELETE, and only needs to verify success.

The request path is split into `send_client_management_request`, which handles auth loading and a single unauthorized-recovery retry, and `send_client_management_request_once`, which builds a reqwest client, adds auth headers from `RemoteControlConnectionAuth`, includes the remote-control account-id header, applies a 30-second timeout, and captures the full response body for later error reporting. `ensure_success_response` maps HTTP status codes into meaningful `io::ErrorKind`s (`InvalidInput`, `PermissionDenied`, `NotFound`, or `Other`) and includes formatted headers plus a preview of the response body in the error text. URL construction goes through `normalize_remote_control_base_url` and appends `wham/remote/control/environments/<environment_id>/clients`. The `TryFrom` implementation for `RemoteControlClient` preserves optional metadata fields and parses `last_seen_at` from RFC3339 into a unix timestamp, surfacing invalid timestamps as `InvalidData`.

#### Function details

##### `list_remote_control_clients`  (lines 70–123)

```
async fn list_remote_control_clients(
    remote_control_url: &str,
    auth_manager: &Arc<AuthManager>,
    params: RemoteControlClientsListParams,
) -> io::Result<RemoteControlClientsListResponse>
```

**Purpose**: Lists enrolled remote-control clients for a specific environment, with optional pagination and ordering. It validates inputs, performs the authenticated HTTP request, and decodes the typed response.

**Data flow**: Takes the remote-control base URL, shared `AuthManager`, and `RemoteControlClientsListParams`. It rejects empty `environment_id` and out-of-range `limit`, builds the endpoint URL with `environment_clients_url`, sends the request through `send_client_management_request`, previews the body, checks HTTP success with `ensure_success_response`, deserializes `ListRemoteControlClientsResponse` from the body, converts each item via `RemoteControlClient::try_from`, and returns `RemoteControlClientsListResponse { data, next_cursor }`.

**Call relations**: Called by higher-level remote-control command handling for client listing. It delegates auth/retry behavior to `send_client_management_request` and response validation to `ensure_success_response`.

*Call graph*: calls 4 internal fn (ensure_success_response, environment_clients_url, send_client_management_request, preview_remote_control_response_body); called by 4 (list_clients, list_remote_control_clients_preserves_decode_error_context, list_remote_control_clients_recovers_auth_after_unauthorized, list_remote_control_clients_retries_unauthorized_only_once); 1 external calls (new).


##### `revoke_remote_control_client`  (lines 125–165)

```
async fn revoke_remote_control_client(
    remote_control_url: &str,
    auth_manager: &Arc<AuthManager>,
    params: RemoteControlClientsRevokeParams,
) -> io::Result<RemoteControlClientsRevokeRespon
```

**Purpose**: Revokes a specific enrolled remote-control client from an environment. It validates required identifiers, performs the authenticated DELETE request, and checks for HTTP success.

**Data flow**: Accepts the remote-control base URL, shared `AuthManager`, and `RemoteControlClientsRevokeParams`. It rejects empty `environment_id` or `client_id`, builds the environment clients URL then appends the client id path segment, sends the request via `send_client_management_request`, previews the body, validates success with `ensure_success_response`, and returns an empty `RemoteControlClientsRevokeResponse` on success.

**Call relations**: Called by higher-level remote-control revoke commands. It shares the same auth/retry and error-reporting helpers as the list path.

*Call graph*: calls 4 internal fn (ensure_success_response, environment_clients_url, send_client_management_request, preview_remote_control_response_body); called by 2 (revoke_client, revoke_remote_control_client_does_not_retry_forbidden); 1 external calls (new).


##### `send_client_management_request`  (lines 167–183)

```
async fn send_client_management_request(
    auth_manager: &Arc<AuthManager>,
    request: ClientManagementRequest<'_>,
    action: &str,
) -> io::Result<ClientManagementResponse>
```

**Purpose**: Performs a client-management HTTP request with one optional auth-recovery retry after an unauthorized response. It centralizes the retry policy for list and revoke operations.

**Data flow**: Takes the shared `AuthManager`, a `ClientManagementRequest`, and an action label. It creates an `UnauthorizedRecovery` and auth-change receiver from the auth manager, loads current remote-control auth with `load_remote_control_auth`, sends the request once with `send_client_management_request_once`, and if the response status is 401 and `recover_remote_control_auth` succeeds, reloads auth and retries exactly once. It returns the final `ClientManagementResponse`.

**Call relations**: Called by both `list_remote_control_clients` and `revoke_remote_control_client`. It delegates actual HTTP I/O to `send_client_management_request_once` and auth handling to the auth helpers in the sibling module.

*Call graph*: calls 3 internal fn (load_remote_control_auth, recover_remote_control_auth, send_client_management_request_once); called by 2 (list_remote_control_clients, revoke_remote_control_client).


##### `send_client_management_request_once`  (lines 185–235)

```
async fn send_client_management_request_once(
    auth: &RemoteControlConnectionAuth,
    request: &ClientManagementRequest<'_>,
    action: &str,
) -> io::Result<ClientManagementResponse>
```

**Purpose**: Builds and sends a single authenticated HTTP request to the remote-control management API and captures the raw response. It handles query construction, headers, timeout, and body collection.

**Data flow**: Accepts `&RemoteControlConnectionAuth`, a borrowed `ClientManagementRequest`, and an action label. It creates a reqwest client, populates a `HeaderMap` with auth headers from `auth.auth_provider`, builds either a GET request with optional `cursor`, `limit`, and `order` query parameters or a DELETE request, applies the fixed timeout, adds the auth headers and `REMOTE_CONTROL_ACCOUNT_ID_HEADER`, sends the request, clones response headers and status, reads the body bytes into a `Vec<u8>`, and returns `ClientManagementResponse` or an `io::Error` with action-specific context.

**Call relations**: Called by `send_client_management_request` for both the initial attempt and the single retry after auth recovery.

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

**Purpose**: Converts non-success HTTP responses from the remote-control management API into `io::Error`s with meaningful kinds and detailed context. It standardizes error mapping for both list and revoke operations.

**Data flow**: Takes the HTTP status, response headers, request URL, body preview string, and a response-kind label. If `status.is_success()` it returns `Ok(())`; otherwise it maps status codes 400, 401/403, 404, and all others to `InvalidInput`, `PermissionDenied`, `NotFound`, and `Other` respectively, then returns an `io::Error` containing the URL, status, formatted headers, and body preview.

**Call relations**: Called by both public operations after receiving a raw `ClientManagementResponse` and before attempting to decode or accept the body.

*Call graph*: called by 2 (list_remote_control_clients, revoke_remote_control_client); 4 external calls (as_u16, is_success, new, format!).


##### `environment_clients_url`  (lines 262–276)

```
fn environment_clients_url(remote_control_url: &str, environment_id: &str) -> io::Result<Url>
```

**Purpose**: Constructs the base URL for remote-control client-management operations within a specific environment. It normalizes the configured base URL and appends the fixed API path segments.

**Data flow**: Accepts the remote-control base URL string and environment id, normalizes the base with `normalize_remote_control_base_url`, joins `wham/remote/control/environments`, mutates path segments to append `<environment_id>/clients`, and returns the resulting `Url` or an `io::Error` if the base URL cannot accept path segments.

**Call relations**: Used by both `list_remote_control_clients` and `revoke_remote_control_client` before the latter appends an additional client-id segment.

*Call graph*: calls 1 internal fn (normalize_remote_control_base_url); called by 2 (list_remote_control_clients, revoke_remote_control_client).


##### `RemoteControlClient::try_from`  (lines 281–306)

```
fn try_from(client: RemoteControlClientResponse) -> Result<Self, Self::Error>
```

**Purpose**: Converts the wire-format remote-control client record into the protocol type exposed to callers, including timestamp parsing. It preserves optional metadata while normalizing `last_seen_at` to a unix timestamp.

**Data flow**: Consumes `RemoteControlClientResponse`, moves across all optional string fields, and for `last_seen_at` optionally parses the RFC3339 string with `OffsetDateTime::parse`, converts it to `unix_timestamp`, and returns `RemoteControlClient` or an `io::ErrorKind::InvalidData` if parsing fails.

**Call relations**: Called by `list_remote_control_clients` when decoding the list response body into the final protocol response.


### Exec HTTP and file streams
These files expose exec-server client-side transport facades for HTTP responses and remote file contents as unified local async streams.

### `exec-server/src/client/http_client.rs`

`orchestration` · `request handling and client capability setup`

This module is a thin orchestration layer over three implementation files. Through `#[path = ...]` declarations it binds `reqwest_http_client.rs`, `http_response_body_stream.rs`, and `rpc_http_client.rs` into a single client-facing namespace. The module-level documentation explains the architectural split: an orchestrator process owns an `Arc<dyn HttpClient>` capability and can either execute HTTP requests locally with `reqwest` or forward them over JSON-RPC to a remote runtime, which then performs the actual request.

The exports reflect that split. `ReqwestHttpClient` is the concrete local implementation for direct HTTP execution. `ReqwestHttpRequestRunner` and `PendingReqwestHttpBodyStream` are kept crate-visible for internal coordination around request execution and body streaming. `HttpResponseBodyStream` is publicly re-exported as the common byte-stream API presented to callers regardless of transport. The remote RPC-backed client implementation is intentionally not re-exported here as a public type, reinforcing that callers should depend on the higher-level `HttpClient` capability rather than transport-specific details.

There is no executable logic in this file; its value is in API shaping. It centralizes the HTTP capability surface, hides file layout details, and documents the invariant that local buffered bodies and remote streamed body deltas must look identical to downstream consumers.


### `exec-server/src/client/http_response_body_stream.rs`

`io_transport` · `streamed HTTP request handling and transport disconnect cleanup`

This module defines the byte-stream type exposed by the `HttpClient` abstraction. `HttpResponseBodyStream` is an enum-backed wrapper with two modes: `Local`, which directly wraps `reqwest::Response::bytes_stream()`, and `Remote`, which reconstructs a body from `HttpRequestBodyDeltaNotification` messages delivered over the exec-server’s shared JSON-RPC connection. The remote variant tracks `request_id`, the next expected sequence number, an `mpsc::Receiver` for queued deltas, a `pending_eof` flag used when a terminal delta carries a final non-empty chunk, and a `closed` flag to avoid double cleanup.

`recv` is the core consumer API. For local streams it simply forwards chunks or converts `reqwest` errors into `ExecServerError::HttpRequest`. For remote streams it enforces strict in-order delivery, converts terminal `error` fields into protocol errors, handles EOF whether it arrives as an empty terminal delta or after a final payload chunk, and removes the request route when the stream finishes or fails.

`HttpBodyStreamRegistration` is a cancellation guard used while the initial `http/request` RPC is still in flight: if the future is dropped before headers return, its `Drop` removes the route. The module also provides `send_body_delta` for producers and several `Inner` methods that maintain the request-id routing table and a side map of stream failures. Backpressure is treated as fatal: if the per-request channel is full, the stream is failed, removed, and future `recv` calls surface a protocol error instead of hanging.

#### Function details

##### `HttpResponseBodyStream::local`  (lines 58–64)

```
fn local(response: Response) -> Self
```

**Purpose**: Constructs a streamed HTTP body wrapper around a local `reqwest::Response`. This is the local-runtime implementation of the shared body-stream API.

**Data flow**: It takes a `reqwest::Response`, calls `response.bytes_stream()`, boxes and pins that stream, stores it in `HttpResponseBodyStreamInner::Local`, and returns `HttpResponseBodyStream`.

**Call relations**: Called by the `reqwest`-backed `http_request_stream` implementation after the initial response headers have been received. It is the local counterpart to `HttpResponseBodyStream::remote`.

*Call graph*: called by 1 (http_request_stream); 2 external calls (pin, bytes_stream).


##### `HttpResponseBodyStream::remote`  (lines 66–81)

```
fn remote(
        inner: Arc<Inner>,
        request_id: String,
        rx: mpsc::Receiver<HttpRequestBodyDeltaNotification>,
    ) -> Self
```

**Purpose**: Constructs a streamed HTTP body wrapper backed by remote body-delta notifications. It initializes the per-request sequencing and cleanup state.

**Data flow**: It takes `Arc<Inner>`, a `request_id`, and an `mpsc::Receiver<HttpRequestBodyDeltaNotification>`, then returns `HttpResponseBodyStream` with `next_seq: 1`, `pending_eof: false`, and `closed: false` in the `Remote` variant.

**Call relations**: Called by the RPC-backed `ExecServerClient::http_request_stream` after the request id has been registered and the initial `http/request` response has succeeded. It depends on `Inner` methods for later route removal and failure lookup.

*Call graph*: called by 1 (http_request_stream).


##### `HttpResponseBodyStream::recv`  (lines 87–145)

```
async fn recv(&mut self) -> Result<Option<Vec<u8>>, ExecServerError>
```

**Purpose**: Receives the next body chunk from either a local `reqwest` stream or a remote notification-backed stream. It is the main consumer-facing API for streamed HTTP bodies.

**Data flow**: For `Local`, it awaits `body.next()`: successful bytes become `Ok(Some(Vec<u8>))`, stream end becomes `Ok(None)`, and `reqwest` errors become `ExecServerError::HttpRequest`. For `Remote`, it first checks `pending_eof` and, if set, clears it, finishes the stream route, and returns `Ok(None)`. Otherwise it awaits `rx.recv()`: channel closure triggers route cleanup and, if a stored failure exists in `Inner`, returns `ExecServerError::Protocol`; absent a stored failure it returns EOF. If a delta arrives with the wrong `seq`, it cleans up and returns a protocol error. Matching deltas advance `next_seq`; a non-`None` `error` field becomes a protocol error after cleanup; `done` triggers cleanup immediately, returning EOF if the chunk is empty or setting `pending_eof` so the final payload chunk is returned once before EOF on the next call.

**Call relations**: Called by higher-level body collectors such as `collect_body`. It delegates remote cleanup to `finish_remote_stream` and remote failure retrieval to `Inner::take_http_body_stream_failure`, and it is the point where backpressure or protocol-ordering problems become visible to consumers.

*Call graph*: calls 1 internal fn (finish_remote_stream); called by 1 (collect_body); 3 external calls (HttpRequest, Protocol, format!).


##### `HttpResponseBodyStream::drop`  (lines 150–164)

```
fn drop(&mut self)
```

**Purpose**: Ensures that dropping a remote body stream before EOF eventually removes its request-id route. This prevents abandoned streams from leaking routing-table entries.

**Data flow**: On drop, if the stream is `Remote` and not already marked `closed`, it sets `closed = true` and calls `spawn_remove_http_body_stream(Arc::clone(inner), request_id.clone())`. Local streams require no special cleanup.

**Call relations**: Runs automatically when callers abandon a streamed HTTP response. It complements `recv`’s explicit EOF/error cleanup and uses `spawn_remove_http_body_stream` because `Drop` cannot await.

*Call graph*: calls 1 internal fn (spawn_remove_http_body_stream); 1 external calls (clone).


##### `HttpBodyStreamRegistration::new`  (lines 168–174)

```
fn new(inner: Arc<Inner>, request_id: String) -> Self
```

**Purpose**: Creates a cancellation guard for a just-registered remote HTTP body stream route. The guard assumes the route is active until explicitly disarmed.

**Data flow**: It takes `Arc<Inner>` and a `request_id`, stores them with `active: true`, and returns `HttpBodyStreamRegistration`.

**Call relations**: Used by the RPC-backed `http_request_stream` path immediately after inserting the request-id route and before awaiting the initial `http/request` RPC. If that future is cancelled or errors before disarming, the guard’s `Drop` removes the route.

*Call graph*: called by 1 (http_request_stream).


##### `HttpBodyStreamRegistration::disarm`  (lines 176–178)

```
fn disarm(&mut self)
```

**Purpose**: Marks the registration guard as inactive so dropping it will no longer remove the route. This is called once ownership of the route has been successfully transferred to a live body stream or explicitly cleaned up elsewhere.

**Data flow**: It mutably sets `self.active = false`. No other state is touched.

**Call relations**: Called by the RPC-backed `http_request_stream` implementation after either successful response receipt or explicit error cleanup. It prevents the guard’s `Drop` from racing with normal route ownership.


##### `HttpBodyStreamRegistration::drop`  (lines 183–187)

```
fn drop(&mut self)
```

**Purpose**: Removes the request-id route if the stream setup future is cancelled before headers are returned. It is the cancellation-safety mechanism for remote streamed HTTP requests.

**Data flow**: On drop, if `self.active` is still true, it clones `inner` and `request_id` and passes them to `spawn_remove_http_body_stream`. If disarmed, it does nothing.

**Call relations**: Runs automatically when the registration guard falls out of scope. It complements `HttpBodyStreamRegistration::new` and `disarm` in the remote stream setup flow.

*Call graph*: calls 1 internal fn (spawn_remove_http_body_stream); 1 external calls (clone).


##### `finish_remote_stream`  (lines 190–196)

```
async fn finish_remote_stream(inner: &Arc<Inner>, request_id: &str, closed: &mut bool)
```

**Purpose**: Performs one-time async cleanup for a remote body stream by removing its route if it has not already been closed. It centralizes the `closed` flag check used by `recv`.

**Data flow**: It takes `&Arc<Inner>`, a `request_id`, and `&mut bool closed`; if `closed` is already true it returns immediately, otherwise it sets `*closed = true` and awaits `inner.remove_http_body_stream(request_id)`.

**Call relations**: Called from `HttpResponseBodyStream::recv` on EOF, protocol error, or terminal delta handling. It is the awaited cleanup path, whereas `spawn_remove_http_body_stream` is used from synchronous drop contexts.

*Call graph*: called by 1 (recv).


##### `spawn_remove_http_body_stream`  (lines 199–205)

```
fn spawn_remove_http_body_stream(inner: Arc<Inner>, request_id: String)
```

**Purpose**: Schedules asynchronous route removal from contexts that cannot await, such as `Drop`. If no Tokio runtime is active, it silently does nothing.

**Data flow**: It attempts `Handle::try_current()`, and on success spawns an async task that awaits `inner.remove_http_body_stream(&request_id)`. It consumes the cloned `Arc<Inner>` and `String` request id.

**Call relations**: Used by both `HttpResponseBodyStream::drop` and `HttpBodyStreamRegistration::drop`. It is the non-blocking cleanup bridge for synchronous destructors.

*Call graph*: called by 2 (drop, drop); 1 external calls (try_current).


##### `send_body_delta`  (lines 207–215)

```
async fn send_body_delta(
    notifications: &RpcNotificationSender,
    delta: HttpRequestBodyDeltaNotification,
) -> bool
```

**Purpose**: Sends one `http/request/bodyDelta` notification to a remote consumer and reports whether delivery to the JSON-RPC layer succeeded. It is the producer-side helper used by streaming HTTP implementations.

**Data flow**: It takes an `RpcNotificationSender` and a `HttpRequestBodyDeltaNotification`, calls `notifications.notify(HTTP_REQUEST_BODY_DELTA_METHOD, &delta).await`, and returns `true` on success or `false` on error.

**Call relations**: Called by the `reqwest` streaming producer in `ReqwestHttpRequestRunner::stream_body`. The boolean return lets producers stop work early if the shared transport is already gone.

*Call graph*: calls 1 internal fn (notify).


##### `Inner::handle_http_body_delta_notification`  (lines 219–258)

```
async fn handle_http_body_delta_notification(
        &self,
        params: Option<Value>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Routes one incoming remote body-delta notification into the request-local channel for that streamed HTTP response. It also handles terminal cleanup and backpressure failures.

**Data flow**: It deserializes `params` into `HttpRequestBodyDeltaNotification`, looks up the sender for `params.request_id` in `http_body_streams`, and if found computes whether the delta is terminal (`done` or `error.is_some()`). It then `try_send`s the delta: on success, terminal deltas trigger `remove_http_body_stream`; on `Closed`, it removes the route and logs that the receiver was dropped; on `Full`, it records a failure message with `record_http_body_stream_failure`, removes the route, and logs a backpressure warning. Unknown request ids are ignored.

**Call relations**: Called from the main client notification dispatcher when `HTTP_REQUEST_BODY_DELTA_METHOD` arrives. It depends on the routing/failure helpers on `Inner` and is the bridge from connection-global notifications to per-request streams.

*Call graph*: calls 2 internal fn (record_http_body_stream_failure, remove_http_body_stream); 2 external calls (debug!, from_value).


##### `Inner::fail_all_http_body_streams`  (lines 262–284)

```
async fn fail_all_http_body_streams(&self, message: String)
```

**Purpose**: Fails every active remote HTTP body stream when the shared transport dies or notification handling aborts. This prevents consumers from waiting forever on channels that will never receive more deltas.

**Data flow**: It acquires `http_body_streams_write_lock`, clones and clears the entire `http_body_streams` map, then iterates each `(request_id, tx)`. For each stream it tries to send a synthetic terminal `HttpRequestBodyDeltaNotification` with `seq: 1`, empty delta, `done: true`, and `error: Some(message.clone())`; if that send fails, it records the failure message in `http_body_stream_failures` so a later `recv` can surface it after channel closure.

**Call relations**: Called by `fail_all_in_flight_work` during transport teardown. It is the HTTP-stream analogue of `fail_all_sessions`.

*Call graph*: 3 external calls (new, new, new).


##### `Inner::next_http_body_stream_request_id`  (lines 287–292)

```
fn next_http_body_stream_request_id(&self) -> String
```

**Purpose**: Allocates a unique connection-local request id for a streamed HTTP response. This prevents late body deltas from one abandoned request being mistaken for another.

**Data flow**: It atomically increments `http_body_stream_next_id` with relaxed ordering, formats the previous value as `http-<id>`, and returns that string.

**Call relations**: Used by the RPC-backed `ExecServerClient::http_request_stream` before registering a new route. It is the source of request ids for remote streamed HTTP calls.

*Call graph*: 1 external calls (format!).


##### `Inner::insert_http_body_stream`  (lines 295–318)

```
async fn insert_http_body_stream(
        &self,
        request_id: String,
        tx: mpsc::Sender<HttpRequestBodyDeltaNotification>,
    ) -> Result<(), ExecServerError>
```

**Purpose**: Registers a request id and sender channel before issuing a remote streaming HTTP request. It also clears any stale recorded failure for the same id.

**Data flow**: It acquires `http_body_streams_write_lock`, loads the current streams map, rejects duplicate request ids with `ExecServerError::Protocol`, clones and updates the map with the new sender, and stores it back. It then checks `http_body_stream_failures`; if a stale failure exists for that request id, it clones the failure map, removes the entry, and stores the cleaned map.

**Call relations**: Called by the RPC-backed `http_request_stream` path before the initial `http/request` RPC is sent. It pairs with `remove_http_body_stream` for normal cleanup and with `HttpBodyStreamRegistration` for cancellation safety.

*Call graph*: 3 external calls (new, Protocol, format!).


##### `Inner::remove_http_body_stream`  (lines 321–333)

```
async fn remove_http_body_stream(
        &self,
        request_id: &str,
    ) -> Option<mpsc::Sender<HttpRequestBodyDeltaNotification>>
```

**Purpose**: Removes a request-id route from the active HTTP body stream table and returns the sender if one existed. It is the normal cleanup path after EOF, terminal error, or abandoned setup.

**Data flow**: It acquires `http_body_streams_write_lock`, loads the current streams map, clones the sender for `request_id` if present, returns `None` early if absent, otherwise clones the map, removes the entry, stores the new map, and returns the removed sender.

**Call relations**: Called by `finish_remote_stream`, `Inner::handle_http_body_delta_notification`, and the remote `http_request_stream` error path. It is the central route-removal primitive used throughout the module.

*Call graph*: called by 1 (handle_http_body_delta_notification); 1 external calls (new).


##### `Inner::record_http_body_stream_failure`  (lines 335–342)

```
async fn record_http_body_stream_failure(&self, request_id: &str, message: String)
```

**Purpose**: Stores a terminal failure message for a request id after the active route has been removed. This lets a consumer learn why its channel closed instead of seeing a silent EOF.

**Data flow**: It acquires `http_body_streams_write_lock`, clones the current `http_body_stream_failures` map, inserts `request_id -> message`, and stores the updated map.

**Call relations**: Called by `Inner::handle_http_body_delta_notification` when backpressure fills the per-request channel. The stored message is later consumed by `take_http_body_stream_failure` during `recv`.

*Call graph*: called by 1 (handle_http_body_delta_notification); 1 external calls (new).


##### `Inner::take_http_body_stream_failure`  (lines 344–354)

```
async fn take_http_body_stream_failure(&self, request_id: &str) -> Option<String>
```

**Purpose**: Retrieves and removes any recorded failure message for a request id. It is the one-shot read path for deferred stream failures.

**Data flow**: It acquires `http_body_streams_write_lock`, loads the failure map, clones the message for `request_id` if present, returns `None` early if absent, otherwise clones the map, removes the entry, stores the updated map, and returns the message.

**Call relations**: Called by `HttpResponseBodyStream::recv` when the remote channel closes unexpectedly. It turns previously recorded routing/backpressure failures into a surfaced `ExecServerError::Protocol`.

*Call graph*: 1 external calls (new).


### `exec-server/src/remote_file_stream.rs`

`io_transport` · `request handling`

This file turns the exec-server’s open/readBlock/close RPC trio into a `FileSystemReadStream`. The internal `FileReadRegistration` stores the `ExecServerClient`, a generated `handle_id`, an optional Tokio runtime handle captured at creation time, and an `active` flag indicating whether the remote handle still needs cleanup.

The exported `open` function creates a fresh registration with a UUID-based handle id and immediately sends `fs_open` using `FsOpenParams { handle_id, path, sandbox }`. On success it returns `FileSystemReadStream::new(...)` wrapping a `futures::stream::try_unfold` state machine whose state is `Option<(FileReadRegistration, u64)>`, where the `u64` is the current byte offset. Each iteration calls `fs_read_block` with the current offset and `FILE_READ_CHUNK_SIZE`, converts the returned chunk into `bytes::Bytes`, and enforces several protocol invariants: the chunk must not exceed the requested maximum, non-EOF responses must not be empty, and advancing the offset must not overflow `u64`. When `response.eof` is true, it attempts `fs_close`; if that succeeds it marks the registration inactive so drop will not issue a second close. EOF with an empty chunk ends the stream, while EOF with trailing bytes yields one final chunk and then terminates.

`Drop` on `FileReadRegistration` is a cleanup backstop. If the handle is still active, it clones the client and handle id, finds a runtime handle either from the stored one or the current context, and spawns an async `fs_close` call. If no runtime is available, cleanup is skipped rather than blocking synchronously. This design favors nonblocking teardown and leak prevention without making stream consumers explicitly close handles.

#### Function details

##### `open`  (lines 24–102)

```
async fn open(
    client: ExecServerClient,
    path: PathUri,
    sandbox: Option<FileSystemSandboxContext>,
) -> FileSystemResult<FileSystemReadStream>
```

**Purpose**: Opens a remote file for streaming reads and returns a `FileSystemReadStream` that fetches fixed-size blocks over RPC until EOF.

**Data flow**: It takes an `ExecServerClient`, `PathUri`, and optional `FileSystemSandboxContext`, creates a `FileReadRegistration` with a UUID-derived `handle_id`, captures `tokio::runtime::Handle::try_current()`, and sends `fs_open`. It then builds a `try_unfold` stream whose state carries the registration and current offset. Each poll issues `fs_read_block`, converts the returned chunk to `Bytes`, validates chunk size and EOF semantics, optionally sends `fs_close` on EOF, updates `registration.active`, computes the next offset with checked addition, and yields either the next chunk plus updated state or stream termination. RPC errors are mapped through `map_remote_error`, while protocol violations become `io::ErrorKind::InvalidData`.

**Call relations**: It is called by `RemoteFileSystem::read_file_stream` after the remote client has been acquired and sandbox support checked. Its internal state machine relies on `FileReadRegistration::drop` as a fallback cleanup path if the stream is abandoned before EOF.

*Call graph*: calls 1 internal fn (new); 3 external calls (new_v4, try_unfold, try_current).


##### `FileReadRegistration::drop`  (lines 105–120)

```
fn drop(&mut self)
```

**Purpose**: Performs best-effort asynchronous remote handle cleanup when a streaming read registration is dropped before it has been explicitly closed.

**Data flow**: On drop it first checks `self.active`; if false it returns immediately. Otherwise it clones the client and handle id, obtains a Tokio runtime handle from the stored `runtime` or `Handle::try_current()`, and if one is available spawns an async task that calls `client.fs_close(FsCloseParams { handle_id })`, ignoring the result.

**Call relations**: This runs automatically when the stream state is dropped, especially if a consumer stops reading before EOF. It complements the explicit EOF close path inside `open` by covering early cancellation and abandonment.

*Call graph*: 1 external calls (clone).


### Noise relay primitives
These modules provide the authenticated channel, ciphertext ordering, and decrypted message framing primitives that underpin the relay transport.

### `exec-server/src/noise_channel.rs`

`domain_logic` · `connection setup and encrypted transport`

This file wraps the `clatter` Noise implementation in exec-server-specific types and validation. `NoiseChannelPublicKey` is the serialized registry-facing public key format: it carries a `suite` tag plus base64-encoded X25519 and ML-KEM-768 public keys. The suite string is mandatory, preventing accidental acceptance of similarly shaped keys from another protocol. `NoiseChannelIdentity` holds the long-lived static DH and KEM keypairs for one process and can generate fresh identities or export the public half.

Handshake state is split by role. `InitiatorHandshake::start` pins the responder’s expected static key, binds the transcript to a caller-supplied prologue, checks that the first encrypted payload fits within `MAX_MESSAGE_LEN`, and emits the first IK message plus resumable initiator state. `InitiatorHandshake::finish` consumes the responder’s second message, requires that it carry no application payload, and finalizes into `NoiseTransport`. On the executor side, `PendingResponderHandshake::read_request` parses the first message, authenticates and extracts the initiator static key, and returns both that key and the decrypted payload so external authorization can happen before `complete` sends the empty second handshake message and enters transport mode.

`NoiseTransport` enforces frame-size limits before calling Clatter’s `send_vec`/`receive_vec`; decryption also rejects ciphertext shorter than the AES-GCM tag. `noise_channel_prologue` length-prefixes a fixed domain plus environment, registration, and stream identifiers so transcript binding is stable and unambiguous. Errors are normalized into `NoiseChannelError`, with `From` conversions preserving handshake versus transport failure categories.

#### Function details

##### `NoiseChannelPublicKey::fmt`  (lines 55–61)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Implements a redacted `Debug` view for public key material. It exposes the suite string but hides the actual encoded key bytes.

**Data flow**: It writes a `debug_struct("NoiseChannelPublicKey")` containing `suite` and placeholder strings `"<redacted>"` for both key fields, then finishes the formatter.

**Call relations**: This is used implicitly by Rust formatting and logging paths so diagnostics can mention the key object without leaking raw public-key strings.

*Call graph*: 1 external calls (debug_struct).


##### `NoiseChannelPublicKey::decode`  (lines 66–88)

```
fn decode(&self) -> Result<(<X25519 as Dh>::PubKey, MlKem768PublicKey), NoiseChannelError>
```

**Purpose**: Validates and decodes registry-provided public key material into the concrete Clatter key types needed for handshake setup. It enforces both suite identity and component lengths.

**Data flow**: It checks `self.suite` against `NOISE_CHANNEL_SUITE`, base64-decodes `x25519_public_key` and converts it into `<X25519 as Dh>::PubKey`, base64-decodes `mlkem768_public_key`, verifies its length equals `MlKem768PublicKey::LENGTH`, converts it with `MlKem768PublicKey::from_slice`, and returns the `(dh, kem)` pair or `NoiseChannelError::InvalidPublicKey(...)`.

**Call relations**: Only `InitiatorHandshake::start` calls this, so responder key validation happens before any handshake bytes are emitted.

*Call graph*: called by 1 (start); 2 external calls (from_slice, InvalidPublicKey).


##### `NoiseChannelIdentity::generate`  (lines 99–105)

```
fn generate() -> Result<Self, NoiseChannelError>
```

**Purpose**: Generates a fresh static Noise identity containing both X25519 and ML-KEM-768 keypairs. It is the constructor for executor and harness identities.

**Data flow**: It calls `X25519::genkey()` and `MlKem768::genkey()`, maps any generation failure into `NoiseChannelError::KeyGeneration(error.to_string())`, and returns `NoiseChannelIdentity { dh, kem }`.

**Call relations**: Used by production setup and many tests to create endpoint identities before exporting public keys or starting handshakes.

*Call graph*: called by 22 (upsert_noise_environment, hybrid_ik_roundtrip_authenticates_both_endpoints, initiator_rejects_oversized_handshake_payload, initiator_rejects_wrong_responder_key, public_key_serializes_with_expected_suite, public_key_validation_rejects_unknown_suite, responder_rejects_mismatched_prologue, transport_rejects_replayed_ciphertext, transport_rejects_tampered_ciphertext, processor_exit_reports_closed_virtual_stream (+12 more)); 2 external calls (genkey, genkey).


##### `NoiseChannelIdentity::public_key`  (lines 107–113)

```
fn public_key(&self) -> NoiseChannelPublicKey
```

**Purpose**: Exports the public half of a static identity in the serialized registry format. It tags the key with the exact supported suite string.

**Data flow**: It reads `self.dh.public` and `self.kem.public`, base64-encodes them, constructs `NoiseChannelPublicKey { suite: NOISE_CHANNEL_SUITE.to_string(), ... }`, and returns it.

**Call relations**: Callers use this when publishing or pinning an endpoint’s static key. The initiator later validates this structure with `NoiseChannelPublicKey::decode`.


##### `InitiatorHandshake::start`  (lines 126–151)

```
fn start(
        identity: &NoiseChannelIdentity,
        responder_public_key: &NoiseChannelPublicKey,
        prologue: &[u8],
        payload: &[u8],
    ) -> Result<(Self, Vec<u8>), NoiseChannelE
```

**Purpose**: Begins the harness-side hybrid IK handshake, pins the responder’s expected static key, and emits the first encrypted handshake message carrying an authorization payload. It also returns resumable initiator state needed to finish the handshake on the same stream.

**Data flow**: It decodes the responder public key with `decode()`, builds `HybridHandshakeParams::new(noise_hybrid_ik(), true)` with the supplied `prologue`, initiator static DH/KEM keys, and responder static DH/KEM keys, constructs `Handshake::new(params)`, queries `get_next_message_overhead()`, rejects oversized payloads relative to `MAX_MESSAGE_LEN`, writes the first message into a fixed `[u8; MAX_MESSAGE_LEN]` buffer with `write_message(payload, &mut output)`, and returns `(InitiatorHandshake { handshake }, output[..output_len].to_vec())`.

**Call relations**: Called by harness-side connection setup and tests. It delegates responder-key validation to `NoiseChannelPublicKey::decode` and leaves finalization to `InitiatorHandshake::finish`.

*Call graph*: calls 1 internal fn (decode); called by 13 (hybrid_ik_roundtrip_authenticates_both_endpoints, initiator_rejects_oversized_handshake_payload, initiator_rejects_wrong_responder_key, responder_rejects_mismatched_prologue, transport_rejects_replayed_ciphertext, transport_rejects_tampered_ciphertext, processor_exit_reports_closed_virtual_stream, noise_harness_connection_from_websocket, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation (+3 more)); 4 external calls (new, new, noise_hybrid_ik, InvalidMessage).


##### `InitiatorHandshake::finish`  (lines 155–167)

```
fn finish(mut self, response: &[u8]) -> Result<NoiseTransport, NoiseChannelError>
```

**Purpose**: Consumes the responder’s second handshake message and transitions the initiator into transport mode. It requires the v1 responder message to carry no application payload.

**Data flow**: It checks `response.len()` with `ensure_noise_frame_len`, allocates a `[u8; MAX_MESSAGE_LEN]` payload buffer, calls `self.handshake.read_message(response, &mut payload)`, returns `InvalidMessage` if the decrypted payload length is nonzero, finalizes the handshake with `self.handshake.finalize()`, and wraps the result in `NoiseTransport`.

**Call relations**: Called after `InitiatorHandshake::start` once the responder’s handshake frame arrives. It is the final initiator-side step before encrypted transport records can be sent.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); 3 external calls (finalize, read_message, InvalidMessage).


##### `PendingResponderHandshake::read_request`  (lines 182–211)

```
fn read_request(
        identity: &NoiseChannelIdentity,
        prologue: &[u8],
        request: &[u8],
    ) -> Result<Self, NoiseChannelError>
```

**Purpose**: Parses the initiator’s first IK message on the executor side, authenticates the initiator static key, and exposes both that key and the decrypted payload for external authorization. It intentionally stops short of entering transport mode.

**Data flow**: It validates `request.len()` with `ensure_noise_frame_len`, builds responder-side `HybridHandshakeParams::new(noise_hybrid_ik(), false)` with the supplied `prologue` and local static DH/KEM keys, constructs `Handshake::new(params)`, reads the request into a fixed payload buffer with `read_message`, fetches the authenticated remote static key via `get_remote_static()`, errors if absent, serializes that remote key into `NoiseChannelPublicKey` using base64 encoding, copies the decrypted payload bytes into a `Vec<u8>`, and returns `PendingResponderHandshake { handshake, initiator_public_key, payload }`.

**Call relations**: Executor-side relay code calls this when a handshake request frame arrives. Authorization logic is expected to inspect `initiator_public_key` and `payload` before calling `complete`.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); called by 5 (hybrid_ik_roundtrip_authenticates_both_endpoints, transport_rejects_replayed_ciphertext, transport_rejects_tampered_ciphertext, processor_exit_reports_closed_virtual_stream, run_multiplexed_environment); 4 external calls (new, new, noise_hybrid_ik, InvalidMessage).


##### `PendingResponderHandshake::complete`  (lines 214–223)

```
fn complete(mut self) -> Result<(NoiseTransport, Vec<u8>), NoiseChannelError>
```

**Purpose**: Finishes the responder side of the handshake after the initiator key has been authorized. It emits the second handshake message and returns an established transport.

**Data flow**: It writes an empty payload handshake response into a fixed buffer with `self.handshake.write_message(&[], &mut response)`, finalizes the handshake with `self.handshake.finalize()`, wraps the transport in `NoiseTransport`, and returns `(transport, response[..response_len].to_vec())`.

**Call relations**: Called only after `read_request` and external authorization. It is the responder-side transition from pending authorization state to usable encrypted transport.

*Call graph*: 2 external calls (finalize, write_message).


##### `NoiseTransport::encrypt`  (lines 235–241)

```
fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseChannelError>
```

**Purpose**: Encrypts one ordered transport record using the next implicit send nonce. It enforces the Noise maximum frame size before handing bytes to Clatter.

**Data flow**: It computes `frame_len = plaintext.len() + AesGcm::tag_len()` with checked addition, returns `InvalidMessage` on overflow or if the resulting frame exceeds `MAX_MESSAGE_LEN` via `ensure_noise_frame_len`, then calls `self.transport.send_vec(plaintext)` and returns the ciphertext `Vec<u8>`.

**Call relations**: Used by relay stream writers after the handshake completes. Because Noise transport nonces are implicit, callers must not retry encryption of the same logical record.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); called by 1 (spawn_noise_virtual_stream); 3 external calls (tag_len, send_vec, InvalidMessage).


##### `NoiseTransport::decrypt`  (lines 244–252)

```
fn decrypt(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseChannelError>
```

**Purpose**: Decrypts one ordered transport record using the next implicit receive nonce. It rejects obviously invalid ciphertext lengths before invoking Clatter.

**Data flow**: It checks that `ciphertext.len()` is at least `AesGcm::tag_len()`, validates the total frame length with `ensure_noise_frame_len`, calls `self.transport.receive_vec(ciphertext)`, and returns the plaintext `Vec<u8>` or a `NoiseChannelError`.

**Call relations**: Called by relay receive paths after ciphertext frames have been ordered. Replay or out-of-order delivery is expected to fail here because the transport state advances nonces implicitly.

*Call graph*: calls 1 internal fn (ensure_noise_frame_len); called by 1 (receive_data); 3 external calls (tag_len, receive_vec, InvalidMessage).


##### `noise_channel_prologue`  (lines 258–269)

```
fn noise_channel_prologue(
    environment_id: &str,
    executor_registration_id: &str,
    stream_id: &str,
) -> Vec<u8>
```

**Purpose**: Builds the transcript-binding prologue shared by both peers for one environment registration and relay stream. It ensures the handshake is tied to the intended environment, executor registration, and stream ID.

**Data flow**: It creates an empty `Vec<u8>`, appends the fixed `PROLOGUE_DOMAIN`, `environment_id`, `executor_registration_id`, and `stream_id` using `append_prologue_part`, and returns the resulting byte vector.

**Call relations**: Harness and executor relay code call this before starting or reading a handshake. The resulting bytes are fed into `InitiatorHandshake::start` and `PendingResponderHandshake::read_request`.

*Call graph*: calls 1 internal fn (append_prologue_part); called by 7 (noise_harness_connection_from_websocket, run_multiplexed_environment, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation, pending_harness_key_validation_does_not_block_new_handshakes, repeated_early_data_during_validation_closes_the_physical_relay, repeated_malformed_handshakes_close_the_physical_relay); 1 external calls (new).


##### `append_prologue_part`  (lines 271–277)

```
fn append_prologue_part(prologue: &mut Vec<u8>, part: &[u8])
```

**Purpose**: Appends one length-prefixed component to the Noise prologue. The length prefix prevents ambiguous concatenation of adjacent identifiers.

**Data flow**: It computes `part.len() as u64`, appends its big-endian bytes to `prologue`, then appends the raw `part` bytes.

**Call relations**: Used only by `noise_channel_prologue` to encode each prologue component in a stable, unambiguous format.

*Call graph*: called by 1 (noise_channel_prologue).


##### `ensure_noise_frame_len`  (lines 279–287)

```
fn ensure_noise_frame_len(
    frame_len: usize,
    message: &'static str,
) -> Result<(), NoiseChannelError>
```

**Purpose**: Rejects handshake or transport frames larger than Clatter’s `MAX_MESSAGE_LEN`. It centralizes the size check and error shape.

**Data flow**: It compares `frame_len` to `MAX_MESSAGE_LEN`; if too large it returns `NoiseChannelError::InvalidMessage(message)`, otherwise `Ok(())`.

**Call relations**: Called by initiator finish, responder request parsing, and transport encrypt/decrypt so all inbound and outbound frame-size checks share the same limit and error category.

*Call graph*: called by 4 (finish, decrypt, encrypt, read_request); 1 external calls (InvalidMessage).


##### `NoiseChannelError::from`  (lines 310–312)

```
fn from(error: clatter::error::TransportError) -> Self
```

**Purpose**: Converts Clatter handshake or transport errors into the exec-server-specific `NoiseChannelError` enum. It preserves whether the failure happened during handshake or transport.

**Data flow**: It takes a Clatter error, converts it to string with `to_string()`, wraps it in either `NoiseChannelError::Handshake(...)` or `NoiseChannelError::Transport(...)`, and returns the new error value.

**Call relations**: These `From` impls are used implicitly by `?` throughout the handshake and transport methods so Clatter failures surface in the module’s public error type.

*Call graph*: 4 external calls (Handshake, Transport, to_string, to_string).


### `exec-server/src/noise_relay/ordered_ciphertext.rs`

`domain_logic` · `request handling`

This file protects the Noise receive path from out-of-order websocket delivery by restoring strict sequence order ahead of decryption. `OrderedCiphertextFrames` tracks three pieces of state: `next_seq`, the next expected relay sequence number; `pending`, a `BTreeMap<u32, Vec<u8>>` of future records keyed by sequence; and `pending_bytes`, the total buffered payload size. The design keeps the first payload seen for each sequence and ignores later duplicates, so replayed or duplicated transport frames cannot replace already-buffered ciphertext.

Its main `push` method has three branches. If the incoming `seq` is older than `next_seq` or already present in `pending`, it is treated as a duplicate and yields no output. If `seq` is ahead of `next_seq`, the method checks two bounds before buffering: the gap may not exceed `MAX_REORDER_DISTANCE` (64), and total buffered bytes may not exceed `MAX_PENDING_BYTES` (1 MiB). If either bound is exceeded, it returns `ExecServerError::Protocol`.

When the incoming record matches `next_seq`, the method emits that payload immediately, advances the expected sequence, and then repeatedly drains any now-contiguous buffered records from the `BTreeMap`. `advance` uses checked arithmetic, so sequence exhaustion is surfaced as a protocol error rather than wrapping. The result is a deterministic, bounded release of ciphertext in nonce order.

#### Function details

##### `OrderedCiphertextFrames::push`  (lines 22–58)

```
fn push(
        &mut self,
        seq: u32,
        payload: Vec<u8>,
    ) -> Result<Vec<Vec<u8>>, ExecServerError>
```

**Purpose**: Accepts one ciphertext frame tagged with a relay sequence number and returns the newly contiguous run of ciphertext payloads that can now be processed in order. It also deduplicates repeats and enforces bounded reordering distance and memory use.

**Data flow**: It takes `&mut self`, a `u32` sequence number, and an owned `Vec<u8>` payload. If the sequence is older than `self.next_seq` or already buffered, it returns an empty vector. If the sequence is ahead, it checks the gap against `MAX_REORDER_DISTANCE`, computes prospective buffered bytes against `MAX_PENDING_BYTES`, inserts the payload into `self.pending`, updates `self.pending_bytes`, and returns empty. If the sequence equals `self.next_seq`, it starts a `ready` vector with the payload, advances `self.next_seq`, repeatedly removes any buffered payload at the new `next_seq`, subtracts each removed payload’s length from `pending_bytes`, appends it to `ready`, advances again, and finally returns `ready`.

**Call relations**: Receive-side relay handlers call this from `receive_data` before decrypting records, because Noise requires ciphertexts to be consumed in nonce order. It delegates sequence advancement to `advance`; its returned contiguous payload list is then suitable for downstream decryption.

*Call graph*: calls 1 internal fn (advance); called by 2 (receive_data, receive_data); 3 external calls (new, Protocol, vec!).


##### `OrderedCiphertextFrames::advance`  (lines 60–65)

```
fn advance(&mut self) -> Result<(), ExecServerError>
```

**Purpose**: Moves the expected sequence number forward by one while forbidding wraparound. It isolates the overflow check used whenever a record is accepted into the contiguous stream.

**Data flow**: It takes `&mut self`, performs `checked_add(1)` on `self.next_seq`, writes the incremented value back on success, and returns `()`. On overflow it returns `ExecServerError::Protocol("Noise relay sequence number exhausted")`.

**Call relations**: This helper is only called internally by `OrderedCiphertextFrames::push` after releasing an expected record. Its sole role is to keep the sequence progression logic and exhaustion error consistent.

*Call graph*: called by 1 (push).


### `exec-server/src/noise_relay/message_framing.rs`

`io_transport` · `request handling`

This file implements the relay’s plaintext framing layer that sits between JSON serialization and Noise record chunking. `frame_jsonrpc_message` serializes a `codex_app_server_protocol::JSONRPCMessage` directly into a `Vec<u8>` that begins with four reserved bytes, then backfills those bytes with the serialized JSON payload length encoded as big-endian `u32`. The function enforces a hard maximum message size of 64 MiB and rejects anything larger with `ExecServerError::Protocol`, preventing peers from emitting arbitrarily large authenticated messages.

On the receive side, `JsonRpcMessageDecoder` owns a persistent `buffered: Vec<u8>` reassembly buffer. Its `push` method accepts one decrypted Noise plaintext record at a time, first rejecting any record larger than `NOISE_RECORD_PLAINTEXT_LEN` (60 KiB), then appending it to the buffer. It repeatedly parses complete framed messages only when both the 4-byte prefix and the full declared payload are present. A single record may therefore complete multiple messages, and a single message may span many records. Declared lengths of zero or above the 64 MiB cap are rejected immediately, before waiting for payload bytes. After extracting each complete message with `serde_json::from_slice`, the consumed bytes are drained from the front of the buffer. Even when no full message is available yet, the file preserves a strict memory invariant by rejecting any reassembly buffer larger than prefix plus maximum payload.

#### Function details

##### `frame_jsonrpc_message`  (lines 15–26)

```
fn frame_jsonrpc_message(message: &JSONRPCMessage) -> Result<Vec<u8>, ExecServerError>
```

**Purpose**: Serializes one `JSONRPCMessage` into the relay framing format: a 4-byte big-endian payload length followed by the JSON bytes. It also enforces the relay’s maximum authenticated JSON-RPC message size before returning the framed byte stream.

**Data flow**: It takes `&JSONRPCMessage`, allocates a `Vec<u8>` prefilled with four zero bytes, and streams JSON into that vector with `serde_json::to_writer`. It computes the payload length as total length minus the reserved prefix, rejects lengths above `MAX_NOISE_JSONRPC_MESSAGE_LEN` with `ExecServerError::Protocol`, writes the big-endian `u32` length into the first four bytes, and returns the completed `Vec<u8>`.

**Call relations**: This function is used by relay send paths such as `spawn_noise_virtual_stream` and `processor_exit_reports_closed_virtual_stream` when they need to turn a logical JSON-RPC message into bytes that can then be split across Noise records. It delegates serialization to `serde_json::to_writer`; callers are responsible for subsequent record chunking and encryption.

*Call graph*: called by 2 (spawn_noise_virtual_stream, processor_exit_reports_closed_virtual_stream); 3 external calls (Protocol, to_writer, vec!).


##### `JsonRpcMessageDecoder::push`  (lines 39–80)

```
fn push(
        &mut self,
        plaintext_record: &[u8],
    ) -> Result<Vec<JSONRPCMessage>, ExecServerError>
```

**Purpose**: Consumes one decrypted plaintext record, appends it to the decoder’s reassembly buffer, and emits every complete framed `JSONRPCMessage` now available. It is the boundary-restoration step that turns arbitrary record fragmentation back into exact message objects.

**Data flow**: It takes `&mut self` plus a plaintext byte slice. It first validates the record length against `NOISE_RECORD_PLAINTEXT_LEN`, then extends `self.buffered` with the new bytes. In a loop, it reads the first four buffered bytes as a big-endian length, rejects zero or oversized declared lengths, checks whether the full frame is present, deserializes the payload slice with `serde_json::from_slice` when complete, pushes each decoded message into a result vector, and drains consumed bytes from `self.buffered`. Before returning, it verifies the remaining buffered bytes do not exceed prefix plus maximum payload size, then returns `Vec<JSONRPCMessage>`.

**Call relations**: Receive-side relay logic invokes this from `receive_data` after ciphertext has been reordered and decrypted into plaintext records. It delegates JSON parsing to `serde_json::from_slice`; its output feeds higher-level JSON-RPC processing, while protocol violations abort the relay path early.

*Call graph*: called by 2 (receive_data, receive_data); 4 external calls (new, Protocol, from_slice, from_be_bytes).


### Relay transport implementation
This module assembles the lower-level relay pieces into websocket-based relay transports, from simple harness connections to multiplexed Noise-authenticated relays.

### `exec-server/src/relay.rs`

`io_transport` · `request handling`

This file defines the relay protocol boundary between websocket frames and internal JSON-RPC streams. `RelayMessageFrame` gets convenience constructors for `Data`, `Resume`, `Handshake`, and `Reset` bodies, plus validation and typed extraction helpers that enforce protocol invariants: version must equal `1`, `stream_id` must be nonblank, data frames must be single-segment and nonempty, reset reasons must be present, and handshake payloads cannot be empty. Encoding and decoding are thin prost wrappers, while `jsonrpc_payload` serializes `JSONRPCMessage` values to bytes.

Two transport modes live here. `harness_connection_from_websocket` wraps one websocket as one `JsonRpcConnection`: it sends an initial resume frame with a generated UUID stream id, forwards outgoing JSON-RPC messages as relay data frames with incrementing wrapping sequence numbers, emits websocket pings on a fixed keepalive interval, and converts inbound binary relay frames back into `JsonRpcConnectionEvent`s. `send_event_with_keepalive` is the key backpressure helper: while waiting for a full incoming channel to accept an event, it continues sending websocket pings so the peer does not time out.

The larger `run_multiplexed_environment` function serves many virtual Noise streams over one executor websocket. It splits the websocket into reader/writer halves, runs a dedicated writer task fed by an mpsc queue, tracks active streams and pending responder handshakes by `stream_id`, and runs harness-key authorization checks in a `JoinSet` so slow registry calls do not block frame processing. A `validation_id` guards against stale authorization results completing a reused stream id. The loop enforces hard limits on active streams, pending validations, authorization payload size, and total failed handshakes; repeated malformed, duplicate, or early-data attempts eventually close the physical relay. Successful handshakes are the only path that completes Noise IK and spawns a `NoiseVirtualStream` via `spawn_noise_virtual_stream`. Resets are sent best-effort with a generic reason and unauthenticated reset text is never trusted for logging. The embedded tests exercise keepalive timing, malformed frame reporting, close handling, and a controllable fake websocket that simulates sink backpressure.

#### Function details

##### `RelayMessageFrame::data`  (lines 63–76)

```
fn data(stream_id: String, seq: u32, payload: Vec<u8>) -> Self
```

**Purpose**: Builds a relay protobuf frame carrying one JSON-RPC payload segment for a specific virtual stream and sequence number. It always emits the protocol’s single-segment form.

**Data flow**: Consumes a `stream_id: String`, `seq: u32`, and raw `payload: Vec<u8>`, and returns a `RelayMessageFrame` with version `1`, zeroed ack fields, and a `Body::Data(RelayData)` containing `segment_index = 0`, `segment_count = 1`, and the payload bytes.

**Call relations**: It is used wherever outbound relay data frames are created, including the plain harness websocket path and tests. It does not delegate further logic beyond constructing the protobuf body variant.

*Call graph*: 1 external calls (Data).


##### `RelayMessageFrame::resume`  (lines 78–88)

```
fn resume(stream_id: String) -> Self
```

**Purpose**: Builds the initial resume/control frame announcing a stream id on the plain relay transport. The frame carries a zero `next_seq` placeholder.

**Data flow**: Consumes a `stream_id: String` and returns a `RelayMessageFrame` with version `1`, zeroed ack fields, and a `Body::Resume(RelayResume { next_seq: 0 })`.

**Call relations**: It is used by `harness_connection_from_websocket` immediately after connection setup so the peer learns the generated stream id. It is a pure constructor with no side effects.

*Call graph*: 1 external calls (Resume).


##### `RelayMessageFrame::handshake`  (lines 90–100)

```
fn handshake(stream_id: String, payload: Vec<u8>) -> Self
```

**Purpose**: Builds a relay frame containing a Noise handshake payload for a given virtual stream. It is used for both incoming initiator requests and outgoing responder replies.

**Data flow**: Consumes a `stream_id: String` and handshake `payload: Vec<u8>`, and returns a versioned `RelayMessageFrame` whose body is `Body::Handshake(RelayHandshake { payload })` with ack fields cleared.

**Call relations**: It participates in the multiplexed Noise handshake flow: harnesses send these frames to `run_multiplexed_environment`, and successful responder completion sends one back. Tests also use it to synthesize handshake traffic.

*Call graph*: 1 external calls (Handshake).


##### `RelayMessageFrame::reset`  (lines 102–110)

```
fn reset(stream_id: String, reason: String) -> Self
```

**Purpose**: Builds a relay reset frame carrying a textual reason string. The reason is control metadata, not trusted application text.

**Data flow**: Consumes `stream_id: String` and `reason: String`, and returns a versioned `RelayMessageFrame` with zeroed ack fields and `Body::Reset(RelayReset { reason })`.

**Call relations**: It is used by `send_reset` and tests to terminate or reject streams. The broader relay logic treats the reason conservatively and does not rely on it for authenticated semantics.

*Call graph*: 1 external calls (Reset).


##### `RelayMessageFrame::validate`  (lines 112–156)

```
fn validate(&self) -> Result<RelayFrameBodyKind, ExecServerError>
```

**Purpose**: Checks that a decoded relay frame is structurally valid and identifies which body kind it contains. It centralizes protocol invariants before any typed extraction occurs.

**Data flow**: Reads `self.version`, `self.stream_id`, and `self.body`. It returns `Ok(RelayFrameBodyKind)` for valid frames or `ExecServerError::Protocol` with a specific message when the version is unsupported, the stream id is blank, required fields are missing, or the body is absent.

**Call relations**: It is called by typed accessors such as `into_data` and `into_handshake_payload`, and also by the websocket processing loops before dispatching on frame kind. Its result drives later control flow by distinguishing data, reset, handshake, and ignorable control frames.

*Call graph*: called by 2 (into_data, into_handshake_payload); 2 external calls (Protocol, format!).


##### `RelayMessageFrame::into_data`  (lines 158–171)

```
fn into_data(self) -> Result<RelayData, ExecServerError>
```

**Purpose**: Consumes a frame and extracts its `RelayData` payload, failing if the frame is not a valid data frame. It combines validation with body downcasting.

**Data flow**: Takes ownership of `self`, first runs `validate`, then checks that the returned kind is `Data`. If so it matches `self.body` and returns the contained `RelayData`; otherwise it returns `ExecServerError::Protocol("expected relay data message frame")`.

**Call relations**: It is used by `into_jsonrpc_message` and by the multiplexed environment when processing inbound data. It depends on `validate` to reject malformed frames before extraction.

*Call graph*: calls 1 internal fn (validate); called by 1 (into_jsonrpc_message); 1 external calls (Protocol).


##### `RelayMessageFrame::into_jsonrpc_message`  (lines 173–176)

```
fn into_jsonrpc_message(self) -> Result<JSONRPCMessage, ExecServerError>
```

**Purpose**: Converts a relay data frame directly into a parsed `JSONRPCMessage`. It is the bridge from protobuf relay framing to JSON-RPC semantics.

**Data flow**: Consumes `self`, delegates to `into_data` to obtain the payload bytes, then deserializes those bytes with `serde_json::from_slice`. It returns either the parsed `JSONRPCMessage` or an `ExecServerError` wrapping protocol or JSON parsing failure.

**Call relations**: It is used in `harness_connection_from_websocket` when inbound relay data should become `JsonRpcConnectionEvent::Message`. Its only delegation is to `into_data` and JSON decoding.

*Call graph*: calls 1 internal fn (into_data); 1 external calls (from_slice).


##### `RelayMessageFrame::into_handshake_payload`  (lines 178–191)

```
fn into_handshake_payload(self) -> Result<Vec<u8>, ExecServerError>
```

**Purpose**: Consumes a frame and extracts the raw Noise handshake bytes, failing unless the frame is a valid handshake frame. This keeps handshake parsing separate from generic frame validation.

**Data flow**: Takes ownership of `self`, runs `validate`, requires the resulting kind to be `Handshake`, and then returns the `handshake.payload` bytes from the body. Any mismatch or malformed frame becomes `ExecServerError::Protocol`.

**Call relations**: It is used by `run_multiplexed_environment` before calling `PendingResponderHandshake::read_request`. It relies on `validate` to enforce nonempty payloads and other shared frame checks.

*Call graph*: calls 1 internal fn (validate); 1 external calls (Protocol).


##### `RelayMessageFrame::into_reset_reason`  (lines 193–200)

```
fn into_reset_reason(self) -> Option<String>
```

**Purpose**: Extracts a nonempty reset reason string if the frame body is a reset. It is intentionally permissive and returns `None` for anything else.

**Data flow**: Consumes `self`, pattern-matches `self.body`, and returns `Some(reset.reason)` only when the body is `Reset` and the reason is nonempty; otherwise it returns `None`.

**Call relations**: It is used by the plain harness websocket path when converting an inbound reset frame into a `Disconnected` event. Unlike the stricter typed extractors, it does not call `validate` because callers already know they are handling a reset branch.


##### `encode_relay_message_frame`  (lines 203–205)

```
fn encode_relay_message_frame(frame: &RelayMessageFrame) -> Vec<u8>
```

**Purpose**: Serializes a relay protobuf frame into bytes suitable for a websocket binary message. It is the canonical outbound encoder for this transport.

**Data flow**: Takes `&RelayMessageFrame`, calls prost’s `encode_to_vec`, and returns the resulting `Vec<u8>`.

**Call relations**: It is used throughout relay sending paths: plain harness transport, multiplexed Noise streams, reset emission, and tests that synthesize frames. It is a leaf serialization helper with no branching logic.

*Call graph*: called by 10 (spawn_noise_virtual_stream, noise_harness_connection_from_websocket, harness_connection_from_websocket, send_reset, harness_connection_sends_keepalive_and_receives_relay_data, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation, pending_harness_key_validation_does_not_block_new_handshakes, repeated_early_data_during_validation_closes_the_physical_relay, repeated_malformed_handshakes_close_the_physical_relay); 1 external calls (encode_to_vec).


##### `decode_relay_message_frame`  (lines 207–212)

```
fn decode_relay_message_frame(
    payload: &[u8],
) -> Result<RelayMessageFrame, ExecServerError>
```

**Purpose**: Parses websocket binary payload bytes into a `RelayMessageFrame` and normalizes decode failures into protocol errors. It is the canonical inbound decoder.

**Data flow**: Takes `&[u8]`, invokes prost `RelayMessageFrame::decode`, and returns either the decoded frame or `ExecServerError::Protocol` with an `invalid relay message frame` message containing the decode error text.

**Call relations**: It is used by websocket readers in both relay modes and by tests that inspect emitted frames. Callers typically follow it with `validate` before acting on the frame contents.

*Call graph*: called by 5 (noise_harness_connection_from_websocket, harness_connection_keeps_outbound_frame_while_send_is_backpressured, read_resume_stream_id, duplicate_handshakes_exhaust_failure_budget, oversized_harness_authorization_is_rejected_before_validation); 1 external calls (decode).


##### `jsonrpc_payload`  (lines 214–216)

```
fn jsonrpc_payload(message: &JSONRPCMessage) -> Result<Vec<u8>, ExecServerError>
```

**Purpose**: Serializes a `JSONRPCMessage` into raw bytes for embedding in a relay data frame. It isolates JSON encoding errors behind the server’s error type.

**Data flow**: Takes `&JSONRPCMessage`, calls `serde_json::to_vec`, and returns either the encoded bytes or `ExecServerError::Json`.

**Call relations**: It is used when the plain harness websocket path turns outgoing JSON-RPC messages into relay data frames, and in tests that construct expected payloads. It is a simple serialization helper.

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

**Purpose**: Attempts to enqueue an inbound `JsonRpcConnectionEvent` while continuing to send websocket pings if the receiver channel is backpressured. This prevents idle timeouts during slow consumer periods.

**Data flow**: Receives a mutable websocket sink, mutable keepalive interval, an `mpsc::Sender<JsonRpcConnectionEvent>`, and the event to send. It pins the send future and loops in `tokio::select!`, returning `Ok(())` when the channel send completes, `IncomingClosed` if the receiver is gone, or `WebSocketClosed` if a keepalive ping fails.

**Call relations**: It is called from `harness_connection_from_websocket` specifically when forwarding an inbound JSON-RPC message to the connection’s incoming queue. The helper exists because that path must not stop pinging the websocket while waiting for channel capacity.

*Call graph*: called by 1 (send_event_with_keepalive_pings_while_incoming_queue_is_full); 3 external calls (send, pin!, select!).


##### `harness_connection_from_websocket`  (lines 249–424)

```
fn harness_connection_from_websocket(
    stream: T,
    connection_label: String,
) -> JsonRpcConnection
```

**Purpose**: Wraps a websocket carrying relay protobuf frames as a `JsonRpcConnection` for a single logical stream. It owns the task that translates between websocket messages and internal JSON-RPC events.

**Data flow**: Takes a generic websocket-like `stream` and a `connection_label`. It generates a UUID `stream_id`, creates outgoing/incoming/disconnected channels, and spawns a task that sends an initial resume frame, then loops over three sources: outgoing JSON-RPC messages, keepalive ticks, and inbound websocket frames. Outgoing messages are JSON-serialized, wrapped in `RelayMessageFrame::data`, sequence-numbered with wrapping `u32`, encoded, and sent as binary websocket frames. Inbound binary frames are decoded, filtered to the generated stream id, validated, and converted into `JsonRpcConnectionEvent::Message`, `MalformedMessage`, or `Disconnected`; close/error conditions update the watch channel and terminate the task. The function returns a populated `JsonRpcConnection` with the spawned task handle and `JsonRpcTransport::Plain`.

**Call relations**: It is called by higher-level websocket connection setup such as `connect_websocket`, and by several tests. Internally it delegates framing to `encode_relay_message_frame`, `decode_relay_message_frame`, `jsonrpc_payload`, and `send_event_with_keepalive`, and it is the plain non-Noise counterpart to `run_multiplexed_environment`.

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

**Purpose**: Runs the executor side of the multiplexed Noise relay over one websocket, authorizing harness keys and spawning per-stream virtual JSON-RPC transports. It is the core server loop for remote environments.

**Data flow**: It takes a `WebSocketStream`, a `ConnectionProcessor`, environment and registration identifiers, the executor `NoiseChannelIdentity`, and a `HarnessKeyValidator`. It splits the websocket, starts a dedicated writer task fed by `physical_outgoing_tx`, and maintains mutable state: active `streams`, `pending_handshakes`, a `JoinSet` of authorization tasks, a failed-handshake counter, and a monotonically increasing `validation_id`. In its main `select!` loop it reacts to writer failure, closed virtual streams, completed validation tasks, and inbound websocket frames. Handshake frames are parsed with a stream-specific Noise prologue, converted into `PendingResponderHandshake`, checked for UTF-8 and size-bounded authorization payloads, stored in `pending_handshakes`, and validated asynchronously with a timeout. Successful validation completes the responder handshake, queues a handshake reply, and inserts a spawned `NoiseVirtualStream`; failures send generic resets and may consume the physical relay’s failure budget. Data frames are routed only to existing active streams; early data or malformed data resets the stream and may count against the budget if it canceled a pending handshake. Reset frames clear pending state and disconnect active streams. On exit it disconnects all remaining streams and aborts the writer task if still running.

**Call relations**: It is invoked by `run_remote_environment` in production and by relay tests. Within its flow it delegates to Noise handshake parsing/completion, `send_reset` for best-effort rejection, `failed_handshake_budget_exhausted` for connection-wide abuse control, and `spawn_noise_virtual_stream` to hand successful streams off to the JSON-RPC processor.

*Call graph*: calls 4 internal fn (read_request, noise_channel_prologue, failed_handshake_budget_exhausted, send_reset); called by 2 (multiplexed_environment_sends_keepalive, run_remote_environment); 16 external calls (new, new, from_utf8, clone, validate_harness_key, disconnect, receive_data, split, Protocol, take (+6 more)).


##### `failed_handshake_budget_exhausted`  (lines 815–818)

```
fn failed_handshake_budget_exhausted(failed_handshakes: &mut usize) -> bool
```

**Purpose**: Charges one failed authenticated-channel attempt against the physical relay and reports whether the fixed failure budget has been reached. It is the abuse-throttling primitive for repeated bad handshakes.

**Data flow**: Takes `&mut usize`, increments the counter in place, and returns `true` once the updated count is greater than or equal to `MAX_FAILED_NOISE_HANDSHAKES`.

**Call relations**: It is called from multiple failure branches inside `run_multiplexed_environment`, including duplicate handshakes, malformed Noise requests, authorization failures, and early data during validation. Its boolean result determines whether the outer relay loop should break and close the physical websocket.

*Call graph*: called by 1 (run_multiplexed_environment).


##### `send_reset`  (lines 835–838)

```
fn send_reset(physical_outgoing_tx: &mpsc::Sender<Vec<u8>>, stream_id: String)
```

**Purpose**: Queues a reset frame for a stream without blocking the shared websocket loop. It intentionally treats reset delivery as best effort.

**Data flow**: Takes a sender for encoded physical websocket payloads and a `stream_id`. It constructs a reset frame using the constant `NOISE_RELAY_RESET_REASON`, encodes it, and attempts `try_send`; any queue-full or closed-channel error is ignored.

**Call relations**: It is used throughout `run_multiplexed_environment` whenever a stream or handshake must be rejected or torn down quickly. It delegates frame construction to `RelayMessageFrame::reset` and serialization to `encode_relay_message_frame`.

*Call graph*: calls 1 internal fn (encode_relay_message_frame); called by 1 (run_multiplexed_environment); 2 external calls (try_send, reset).


##### `tests::harness_connection_sends_keepalive_and_receives_relay_data`  (lines 871–899)

```
async fn harness_connection_sends_keepalive_and_receives_relay_data() -> anyhow::Result<()>
```

**Purpose**: Verifies that the plain harness relay sends an initial resume frame, emits keepalive pings, and converts an inbound relay data frame into a JSON-RPC message event.

**Data flow**: The test creates a client/server websocket pair, wraps the client side with `harness_connection_from_websocket`, reads the generated stream id from the server side, waits for a ping, sends a pong, then sends a binary relay data frame containing a serialized test JSON-RPC message. It asserts that `incoming_rx` yields `JsonRpcConnectionEvent::Message` with the expected payload.

**Call relations**: It exercises the normal happy-path control flow of `harness_connection_from_websocket`, relying on helper functions like `read_resume_stream_id`, `read_keepalive_ping`, and `test_jsonrpc_message` to inspect the transport.

*Call graph*: calls 3 internal fn (encode_relay_message_frame, harness_connection_from_websocket, jsonrpc_payload); 8 external calls (assert!, data, read_keepalive_ping, read_resume_stream_id, test_jsonrpc_message, websocket_pair, Binary, Pong).


##### `tests::multiplexed_environment_sends_keepalive`  (lines 902–923)

```
async fn multiplexed_environment_sends_keepalive() -> anyhow::Result<()>
```

**Purpose**: Checks that the multiplexed Noise environment emits websocket keepalive pings even before any virtual streams are established.

**Data flow**: The test creates a websocket pair, constructs runtime paths, a `ConnectionProcessor`, and a generated `NoiseChannelIdentity`, then spawns `run_multiplexed_environment`. It waits for a ping on the server websocket and then aborts the environment task.

**Call relations**: It validates the dedicated writer task behavior inside `run_multiplexed_environment`, specifically the branch that sends `Message::Ping` when no outbound relay payload is queued.

*Call graph*: calls 4 internal fn (generate, run_multiplexed_environment, new, new); 4 external calls (read_keepalive_ping, websocket_pair, current_exe, spawn).


##### `tests::AllowHarnessKeyValidator::validate_harness_key`  (lines 929–935)

```
async fn validate_harness_key(
            &self,
            _harness_public_key: &NoiseChannelPublicKey,
            _authorization: &str,
        ) -> Result<(), ExecServerError>
```

**Purpose**: Implements a test validator that authorizes every harness key immediately. It removes registry behavior from tests that only care about relay mechanics.

**Data flow**: It accepts a harness public key and authorization string but ignores both, returning `Ok(())` asynchronously without mutating any state.

**Call relations**: This validator is passed into `run_multiplexed_environment` by tests that need successful authorization without external dependencies. It stands in for production `HarnessKeyValidator` implementations.


##### `tests::send_event_with_keepalive_pings_while_incoming_queue_is_full`  (lines 939–983)

```
async fn send_event_with_keepalive_pings_while_incoming_queue_is_full() -> anyhow::Result<()>
```

**Purpose**: Proves that `send_event_with_keepalive` continues sending websocket pings while blocked on a full incoming event channel, then completes once capacity is freed.

**Data flow**: The test builds a `ControlledWebSocket`, fills a one-slot `incoming_tx` channel with a first event, starts `send_event_with_keepalive` in a task for a second event, observes an outbound ping, drains the first queued event, waits for the send task to finish, and finally asserts that the second event arrives.

**Call relations**: It directly targets the helper’s select-loop behavior under backpressure, using the controllable fake websocket to make ping traffic observable.

*Call graph*: calls 1 internal fn (send_event_with_keepalive); 8 external calls (assert!, new, Message, test_jsonrpc_message, channel, spawn, now, interval_at).


##### `tests::harness_connection_reports_text_frames_as_malformed`  (lines 986–1001)

```
async fn harness_connection_reports_text_frames_as_malformed() -> anyhow::Result<()>
```

**Purpose**: Ensures that text websocket frames are rejected on the relay transport and surfaced as malformed-message events rather than being silently ignored or parsed.

**Data flow**: The test creates a websocket pair, starts `harness_connection_from_websocket`, consumes the initial resume frame, sends a `Message::Text("nope")` from the server side, and asserts that the connection’s incoming channel yields `JsonRpcConnectionEvent::MalformedMessage` with the expected reason string.

**Call relations**: It exercises the text-frame branch in the websocket reader inside `harness_connection_from_websocket`.

*Call graph*: calls 1 internal fn (harness_connection_from_websocket); 4 external calls (assert!, read_resume_stream_id, websocket_pair, Text).


##### `tests::harness_connection_reports_server_close`  (lines 1004–1018)

```
async fn harness_connection_reports_server_close() -> anyhow::Result<()>
```

**Purpose**: Checks that a websocket close from the peer becomes a disconnected event on the plain harness connection.

**Data flow**: The test creates a websocket pair, wraps the client side, reads the initial resume frame, closes the server websocket, and asserts that `incoming_rx` receives `JsonRpcConnectionEvent::Disconnected { reason: None }`.

**Call relations**: It covers the close/EOF branch in `harness_connection_from_websocket` where the task marks the connection disconnected and exits.

*Call graph*: calls 1 internal fn (harness_connection_from_websocket); 3 external calls (assert!, read_resume_stream_id, websocket_pair).


##### `tests::harness_connection_keeps_outbound_frame_while_send_is_backpressured`  (lines 1021–1057)

```
async fn harness_connection_keeps_outbound_frame_while_send_is_backpressured() -> anyhow::Result<()>
```

**Purpose**: Verifies that an outbound relay data frame is not lost when websocket writes are temporarily blocked. The queued JSON-RPC message should be sent once the sink becomes writable again.

**Data flow**: Using `ControlledWebSocket`, the test captures the initial resume frame and stream id, blocks writes, sends a JSON-RPC message through `connection.outgoing_tx`, waits until the sink reports blocked, injects an inbound pong, confirms no spurious incoming event appears, then re-enables writes and inspects the next outbound binary frame to ensure it contains the original message for the same stream id.

**Call relations**: It exercises the outgoing-message branch of `harness_connection_from_websocket` under sink backpressure, with `ControlledWebSocket` providing deterministic readiness transitions.

*Call graph*: calls 2 internal fn (decode_relay_message_frame, harness_connection_from_websocket); 8 external calls (from_secs, bail!, assert!, assert_eq!, new, test_jsonrpc_message, timeout, Pong).


##### `tests::websocket_pair`  (lines 1059–1072)

```
async fn websocket_pair() -> anyhow::Result<(
        WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WebSocketStream<tokio::net::TcpStream>,
    )>
```

**Purpose**: Creates a connected client/server websocket pair bound to a temporary localhost listener for integration-style relay tests.

**Data flow**: It binds a `TcpListener` on `127.0.0.1:0`, formats a websocket URL from the chosen port, spawns a server accept-and-upgrade task with `accept_async`, connects the client with `connect_async`, awaits the server task, and returns both websocket streams.

**Call relations**: It is a shared test helper used by multiple relay tests that need a real websocket transport rather than the synthetic `ControlledWebSocket`.

*Call graph*: 5 external calls (bind, format!, spawn, accept_async, connect_async).


##### `tests::read_resume_stream_id`  (lines 1074–1086)

```
async fn read_resume_stream_id(
        websocket: &mut WebSocketStream<tokio::net::TcpStream>,
    ) -> anyhow::Result<String>
```

**Purpose**: Reads the next websocket message and asserts that it is a relay resume frame, returning the embedded stream id for later test traffic.

**Data flow**: It waits up to one second for `websocket.next()`, requires a binary frame, decodes it with `decode_relay_message_frame`, validates that the body kind is `Resume`, and returns `frame.stream_id`.

**Call relations**: It is used by tests that need to know the generated stream id emitted by `harness_connection_from_websocket` before sending matching relay frames back.

*Call graph*: calls 1 internal fn (decode_relay_message_frame); 5 external calls (from_secs, next, bail!, assert_eq!, timeout).


##### `tests::read_keepalive_ping`  (lines 1088–1101)

```
async fn read_keepalive_ping(
        websocket: &mut WebSocketStream<tokio::net::TcpStream>,
    ) -> anyhow::Result<()>
```

**Purpose**: Consumes websocket traffic until it observes a ping frame or fails if the socket closes first. It abstracts away unrelated frames during keepalive assertions.

**Data flow**: It loops with a one-second timeout around `websocket.next()`, ignoring binary, text, pong, and raw frame variants, returning `Ok(())` on `Message::Ping(_)`, and failing if the websocket closes before a ping arrives.

**Call relations**: It is used by tests for both plain and multiplexed relay modes to assert that keepalive behavior is active.

*Call graph*: 4 external calls (from_secs, next, bail!, timeout).


##### `tests::test_jsonrpc_message`  (lines 1103–1110)

```
fn test_jsonrpc_message() -> JSONRPCMessage
```

**Purpose**: Constructs a stable sample JSON-RPC request used across relay tests.

**Data flow**: It returns `JSONRPCMessage::Request(JSONRPCRequest { id: RequestId::Integer(1), method: "test", params: None, trace: None })` with no inputs or side effects.

**Call relations**: It is a pure fixture helper used by tests that need a known message to serialize, send, and compare.

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

**Purpose**: Builds a synthetic websocket-like object with externally controlled write readiness and observable outbound traffic for deterministic transport tests.

**Data flow**: It creates unbounded inbound and outbound futures channels, shared atomic flags for write readiness and blocked state, and atomic wakers for coordination. It returns a `ControlledWebSocket`, a `ControlledWebSocketHandle` sharing the control state, and the outbound receiver used by tests to inspect sent messages.

**Call relations**: It underpins tests for `send_event_with_keepalive` and `harness_connection_from_websocket` where real websocket timing would be hard to control.

*Call graph*: 5 external calls (clone, new, new, new, unbounded).


##### `tests::ControlledWebSocketHandle::send_inbound`  (lines 1165–1169)

```
fn send_inbound(&self, message: Message) -> anyhow::Result<()>
```

**Purpose**: Injects an inbound websocket message into the controlled test transport.

**Data flow**: It takes a `Message`, wraps it as `Ok(message)`, sends it through the shared unbounded inbound sender, and returns an `anyhow::Result<()>` reflecting whether the receiver is still present.

**Call relations**: Tests call it to simulate peer traffic arriving at code under test that is reading from `ControlledWebSocket` as a `Stream`.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocketHandle::set_write_blocked`  (lines 1171–1173)

```
fn set_write_blocked(&self)
```

**Purpose**: Forces the controlled websocket sink into a non-ready state so future sends will block in `poll_ready`.

**Data flow**: It writes `false` into the shared `write_ready` atomic flag and returns no value.

**Call relations**: Tests use it before sending outbound messages to create backpressure scenarios for relay code.


##### `tests::ControlledWebSocketHandle::set_write_ready`  (lines 1175–1178)

```
fn set_write_ready(&self)
```

**Purpose**: Marks the controlled websocket sink writable again and wakes any task waiting for readiness.

**Data flow**: It stores `true` into the shared `write_ready` flag and calls the stored write waker so pending sink operations can resume.

**Call relations**: It is used by backpressure tests to release a blocked send and observe that queued relay output is eventually emitted.


##### `tests::ControlledWebSocketHandle::wait_for_blocked_write`  (lines 1180–1194)

```
async fn wait_for_blocked_write(&self) -> anyhow::Result<()>
```

**Purpose**: Waits until the controlled websocket has actually attempted a blocked write, rather than merely being configured as non-ready.

**Data flow**: It polls a future that checks the shared `write_blocked` atomic, registering the blocked-write waker when not yet set, and wraps that poll loop in a one-second timeout. It returns `Ok(())` once a blocked write has been observed.

**Call relations**: Tests call it after queueing outbound work to ensure the code under test has reached the sink backpressure point before proceeding.

*Call graph*: 3 external calls (from_secs, poll_fn, timeout).


##### `tests::ControlledWebSocket::poll_ready`  (lines 1200–1209)

```
fn poll_ready(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements sink readiness for the controlled websocket, exposing deterministic writable and blocked states to tests.

**Data flow**: When polled, it reads the shared `write_ready` flag. If true it returns `Poll::Ready(Ok(()))`; otherwise it marks `write_blocked = true`, wakes any waiter interested in that fact, registers the caller’s waker for future readiness, and returns `Poll::Pending`.

**Call relations**: This method is exercised indirectly by relay code using `SinkExt::send` on `ControlledWebSocket`, enabling tests to observe and manipulate send backpressure.

*Call graph*: 2 external calls (waker, Ready).


##### `tests::ControlledWebSocket::start_send`  (lines 1211–1216)

```
fn start_send(self: Pin<&mut Self>, item: Message) -> Result<(), Self::Error>
```

**Purpose**: Records an outbound websocket message emitted by code under test.

**Data flow**: It takes the `Message` item passed by the sink machinery, forwards it into the unbounded outbound sender, and returns `Ok(())`, panicking only if the test receiver has been dropped unexpectedly.

**Call relations**: It is the sink-side observation point used by tests to inspect pings, resume frames, and data frames sent by relay logic.

*Call graph*: 1 external calls (unbounded_send).


##### `tests::ControlledWebSocket::poll_flush`  (lines 1218–1223)

```
fn poll_flush(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements a no-op flush for the controlled websocket sink.

**Data flow**: It ignores the context and immediately returns `Poll::Ready(Ok(()))` without mutating state.

**Call relations**: Relay code reaches this through `SinkExt::send`; the trivial implementation keeps tests focused on readiness and message capture rather than buffering semantics.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_close`  (lines 1225–1230)

```
fn poll_close(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<Result<(), Self::Error>>
```

**Purpose**: Implements a no-op close for the controlled websocket sink.

**Data flow**: It ignores the context and immediately returns `Poll::Ready(Ok(()))`.

**Call relations**: It satisfies the `Sink<Message>` contract for the test transport; relay tests do not rely on any special close behavior here.

*Call graph*: 1 external calls (Ready).


##### `tests::ControlledWebSocket::poll_next`  (lines 1236–1238)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements stream polling for inbound test messages injected through the paired handle.

**Data flow**: It delegates polling to the internal unbounded inbound receiver and returns the next `Result<Message, Infallible>` item or end-of-stream.

**Call relations**: Relay code under test reads from `ControlledWebSocket` as a `Stream`, and tests feed it via `ControlledWebSocketHandle::send_inbound`.

*Call graph*: 1 external calls (new).
