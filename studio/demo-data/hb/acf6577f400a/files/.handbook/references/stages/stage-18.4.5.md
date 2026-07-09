# MCP, exec, and sandbox wire models  `stage-18.4.5`

This stage is cross-cutting infrastructure: it does not execute work itself, but defines the wire contracts that let the rest of the system start processes, talk to helpers, stream execution state, and cross privilege or sandbox boundaries safely. Everything here sits at the edges between components, where values must be serialized, named consistently, and interpreted the same way on both sides of a connection.

The exec-server side is anchored by client_api.rs, which describes how clients connect, what transports and timeouts they use, and the transport-neutral HTTP client capability expected by higher layers. protocol.rs then supplies the JSON-RPC schema and method names for the actual exec-server operations, while process_id.rs gives those messages a distinct, strongly typed logical process identifier.

For command execution output, exec_events.rs defines the JSONL event stream emitted by codex exec, so producers and consumers agree on every event and payload shape. On privileged execution paths, shell-escalation’s escalate_protocol.rs specifies the Unix request/response contract between patched shells and the escalation server, and windows-sandbox-rs’s ipc_framed.rs does the same for elevated Windows runners, including the framing format used on raw byte streams. Together, these models make inter-process coordination reliable and portable.

## Files in this stage

### Exec server connection basics
These files establish the shared identifiers, connection settings, and core JSON-RPC schema used by exec-server clients and servers.

### `exec-server/src/client_api.rs`

`config` · `connection configuration and cross-layer capability typing`

This file is primarily a data-definition layer for the exec-server client subsystem. It declares the timeout constants used as defaults for remote connection and initialization, the `ExecServerClientConnectOptions` handshake settings, and transport-specific argument structs for websocket, Noise rendezvous, and stdio-backed connections. The Noise types are intentionally explicit about connection material: `NoiseRendezvousConnectBundle` packages the registry-authorized URL, environment and registration identifiers, pinned executor public key, and harness authorization as a single-use bundle, while `NoiseRendezvousConnectProvider` abstracts fetching a fresh bundle for each physical connection attempt.

`ExecServerTransportParams` is the runtime-selected transport enum used by lazy remote clients and transport dispatch code. Its custom `Debug` implementation is careful about representation: websocket and stdio variants print their concrete fields, while the Noise variant is rendered as a non-exhaustive debug struct so provider internals and sensitive connection material are not dumped. The `websocket_url` constructor is a convenience for the common websocket case, filling in the standard connect and initialize timeouts.

The file also defines the `HttpClient` trait, which is the HTTP analogue of the execution backend abstraction. It exposes both buffered and streamed request methods returning boxed futures, allowing higher layers to depend on environment-owned HTTP capability without coupling to whether requests are executed locally, over JSON-RPC, or through some future transport.

#### Function details

##### `ExecServerTransportParams::fmt`  (lines 111–135)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats transport parameters for debugging while avoiding overexposure of Noise rendezvous internals. It gives detailed output for websocket and stdio transports and a redacted/non-exhaustive view for Noise.

**Data flow**: It matches on `self`: `WebSocketUrl` writes a debug struct containing `websocket_url`, `connect_timeout`, and `initialize_timeout`; `NoiseRendezvous` writes `NoiseRendezvous` as non-exhaustive; `StdioCommand` writes a debug struct containing `command` and `initialize_timeout`. It returns the formatter result.

**Call relations**: Used implicitly whenever `ExecServerTransportParams` is logged or debug-printed. It supports diagnostics for transport selection without leaking provider-backed rendezvous details.

*Call graph*: 1 external calls (debug_struct).


##### `ExecServerTransportParams::websocket_url`  (lines 139–145)

```
fn websocket_url(websocket_url: String) -> Self
```

**Purpose**: Convenience constructor for the common websocket transport case using standard timeout defaults. It lets callers specify only the URL.

**Data flow**: It takes a `String` websocket URL and returns `ExecServerTransportParams::WebSocketUrl { websocket_url, connect_timeout: DEFAULT_REMOTE_EXEC_SERVER_CONNECT_TIMEOUT, initialize_timeout: DEFAULT_REMOTE_EXEC_SERVER_INITIALIZE_TIMEOUT }`.

**Call relations**: Called by higher-level remote setup code and tests that want a websocket transport enum without manually supplying timeout values. The resulting enum is later consumed by lazy clients and transport dispatch.

*Call graph*: called by 2 (remote_inner, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion).


### `exec-server/src/process_id.rs`

`data_model` · `cross-cutting`

This file is a compact data-model wrapper around a process identifier string. `ProcessId` is declared as `pub struct ProcessId(String)` with `Serialize`/`Deserialize` and `#[serde(transparent)]`, so on the wire it is encoded exactly like a plain JSON string while remaining a distinct Rust type in the codebase. The inherent methods cover the common ownership patterns: `new` accepts any `Into<String>`, `as_str` exposes a borrowed `&str`, and `into_inner` consumes the wrapper to return the owned `String`.

To make the type behave naturally in generic code, the file implements `Deref<Target = str>`, `Borrow<str>`, and `AsRef<str>`, all forwarding to `as_str`. That allows `ProcessId` to be used where string slices are expected, including map lookups keyed by `str`. `fmt::Display` delegates directly to the inner string’s formatter, preserving the exact identifier text. Several `From` conversions support construction from `String`, `&str`, and `&String`, plus conversion back into `String`.

There is intentionally no validation logic here: the wrapper’s job is type distinction and ergonomic interoperability, not enforcing an identifier grammar. As a result, all semantics about uniqueness or scope are imposed by higher-level protocol/session code.

#### Function details

##### `ProcessId::new`  (lines 13–15)

```
fn new(value: impl Into<String>) -> Self
```

**Purpose**: Constructs a `ProcessId` from any value convertible into `String`. It is the explicit constructor when callers want to signal they are creating a logical process identifier.

**Data flow**: It takes `value: impl Into<String>`, converts it with `into()`, wraps the resulting `String` in `ProcessId`, and returns the new value.

**Call relations**: Tests such as `noise_environment_refreshes_bundle_for_each_connection_attempt` call this directly when creating protocol objects. It delegates only to the standard `Into<String>` conversion.

*Call graph*: called by 1 (noise_environment_refreshes_bundle_for_each_connection_attempt); 1 external calls (into).


##### `ProcessId::as_str`  (lines 17–19)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the identifier as a borrowed string slice without transferring ownership. It is the common accessor used by the trait adapters in this file.

**Data flow**: It takes `&self` and returns `&self.0` as `&str`.

**Call relations**: The `Deref`, `Borrow<str>`, and `AsRef<str>` implementations all call this so there is one canonical borrowed-string view of the wrapped identifier.

*Call graph*: called by 3 (as_ref, borrow, deref).


##### `ProcessId::into_inner`  (lines 21–23)

```
fn into_inner(self) -> String
```

**Purpose**: Consumes the wrapper and yields the owned underlying `String`. It is the escape hatch when callers need ownership of the raw identifier text.

**Data flow**: It takes `self`, moves out `self.0`, and returns that `String`.

**Call relations**: This method stands alone as the owned extraction path; unlike `as_str`, it is not used by the trait implementations shown here.


##### `ProcessId::deref`  (lines 29–31)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Makes `ProcessId` behave like `&str` in deref-coercion contexts. This improves ergonomics when passing a process id to APIs expecting string slices.

**Data flow**: It takes `&self`, calls `self.as_str()`, and returns the resulting `&str` as `&Self::Target`.

**Call relations**: Rust’s deref coercion machinery invokes this implicitly in many call sites. Internally it delegates to `ProcessId::as_str` to keep the borrowed representation consistent.

*Call graph*: calls 1 internal fn (as_str).


##### `ProcessId::borrow`  (lines 35–37)

```
fn borrow(&self) -> &str
```

**Purpose**: Implements `Borrow<str>` so collections keyed by `ProcessId` can be queried with `&str`. This is especially useful for map lookups without allocating temporary `String`s.

**Data flow**: It takes `&self`, calls `self.as_str()`, and returns the borrowed `&str`.

**Call relations**: Standard library collection APIs use this trait implementation implicitly. It forwards to `ProcessId::as_str` rather than duplicating access logic.

*Call graph*: calls 1 internal fn (as_str).


##### `ProcessId::as_ref`  (lines 41–43)

```
fn as_ref(&self) -> &str
```

**Purpose**: Implements `AsRef<str>` for generic APIs that accept string-like inputs. It provides another zero-copy borrowed view of the identifier.

**Data flow**: It takes `&self`, calls `self.as_str()`, and returns the resulting `&str`.

**Call relations**: Generic helper code may invoke this implicitly through `AsRef<str>` bounds. Like the other adapters, it centralizes on `ProcessId::as_str`.

*Call graph*: calls 1 internal fn (as_str).


##### `ProcessId::fmt`  (lines 47–49)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the process id exactly as its inner string for user-facing output and logging. There is no extra decoration or quoting added by the wrapper.

**Data flow**: It takes `&self` and a mutable `fmt::Formatter`, then delegates formatting to `self.0.fmt(f)`, returning the resulting `fmt::Result`.

**Call relations**: Any code using `{}` formatting on `ProcessId` reaches this implementation. It delegates directly to the wrapped `String` formatter.


##### `ProcessId::from`  (lines 65–67)

```
fn from(value: &String) -> Self
```

**Purpose**: Converts an owned `String` into a `ProcessId`. This supports idiomatic `.into()` usage at many protocol construction sites.

**Data flow**: It takes `value: String`, wraps it in `ProcessId`, and returns the new wrapper.

**Call relations**: Many tests and setup paths construct process ids through this `From<String>` implementation, often via `.into()`. It is one of the main ergonomic entry points for creating `ProcessId` values.

*Call graph*: called by 17 (process_events_are_delivered_in_seq_order_when_notifications_are_reordered, transport_disconnect_fails_sessions_and_rejects_new_sessions, wake_notifications_do_not_block_other_sessions, default_environment_has_ready_local_executor, spawn_test_process, test_exec_params, exec_params_with_argv, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, terminate_reports_false_after_process_exit (+7 more)).


##### `String::from`  (lines 71–73)

```
fn from(value: ProcessId) -> Self
```

**Purpose**: Converts a `ProcessId` back into its owned inner `String`. It is the inverse of the wrapper construction path for callers that need raw ownership.

**Data flow**: It takes `value: ProcessId`, moves out `value.0`, and returns that `String`.

**Call relations**: This `From<ProcessId> for String` implementation is used implicitly by `.into()` when higher-level code needs to leave the typed wrapper and recover plain text.


### `exec-server/src/protocol.rs`

`data_model` · `cross-cutting`

This file is the protocol schema hub for the exec server. It declares string constants for every JSON-RPC method name, including initialization, process lifecycle operations (`process/start`, `process/read`, `process/write`, `process/signal`, `process/terminate`), process notifications (`process/output`, `process/exited`, `process/closed`), filesystem methods, and executor-owned HTTP methods. The bulk of the file consists of `Serialize`/`Deserialize` data structures that define the exact request and response payloads exchanged over the protocol.

Several design choices are worth noting. `ByteChunk` is a transparent wrapper around `Vec<u8>` that serializes through the private `base64_bytes` module, so binary payloads such as process output, stdin writes, file blocks, and HTTP bodies appear as base64 strings in JSON while remaining typed as bytes in Rust. `ProcessId` is used throughout process-related messages to keep logical process handles distinct from OS pids. Many structs use `#[serde(rename_all = "camelCase")]` and selective `#[serde(default)]` or `skip_serializing_if` attributes to preserve a stable JSON shape, including backward-compatible handling of omitted or null optional fields like `timeoutMs`.

The file spans multiple protocol domains: execution (`ExecParams`, `ReadResponse`, `WriteResponse`, notifications), filesystem requests and metadata responses, environment info, and streamed HTTP response bodies via `HttpRequestBodyDeltaNotification`. Aside from the base64 helpers and tiny `ByteChunk` conversions, behavior is intentionally minimal; this module’s main responsibility is to define exact wire contracts.

#### Function details

##### `ByteChunk::into_inner`  (lines 44–46)

```
fn into_inner(self) -> Vec<u8>
```

**Purpose**: Consumes a `ByteChunk` and returns the owned raw bytes it wraps. It is the owned extraction path for binary protocol fields after deserialization.

**Data flow**: It takes `self`, moves out the inner `Vec<u8>`, and returns it.

**Call relations**: This helper is used wherever higher-level code needs to leave the protocol wrapper and operate directly on bytes. It does not delegate further.


##### `ByteChunk::from`  (lines 50–52)

```
fn from(value: Vec<u8>) -> Self
```

**Purpose**: Wraps an owned byte vector in the protocol’s `ByteChunk` type. This is the ergonomic constructor used when preparing binary data for serialization.

**Data flow**: It takes `value: Vec<u8>`, stores it in `ByteChunk`, and returns the wrapper.

**Call relations**: Callers use this through `ByteChunk::from` or `.into()` when populating protocol structs containing binary fields. It is the inverse of `ByteChunk::into_inner`.


##### `base64_bytes::serialize`  (lines 477–482)

```
fn serialize(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes a byte slice as a base64 string for JSON transport. It is the custom serde serializer behind `ByteChunk`.

**Data flow**: It takes `bytes: &[u8]` and a serde `Serializer`, encodes the bytes with `BASE64_STANDARD.encode(bytes)`, passes the resulting string to `serializer.serialize_str`, and returns the serializer’s result.

**Call relations**: Serde invokes this automatically for `ByteChunk` fields because of `#[serde(with = "base64_bytes")]`. It delegates the actual encoding to the base64 engine and string emission to the serializer.

*Call graph*: 1 external calls (serialize_str).


##### `base64_bytes::deserialize`  (lines 484–492)

```
fn deserialize(deserializer: D) -> Result<Vec<u8>, D::Error>
```

**Purpose**: Deserializes a base64-encoded JSON string back into raw bytes. It is the custom serde deserializer paired with `base64_bytes::serialize`.

**Data flow**: It takes a serde `Deserializer`, first deserializes a `String`, then decodes that string with `BASE64_STANDARD.decode(encoded)`. On success it returns `Vec<u8>`; on decode failure it converts the error into a serde custom error.

**Call relations**: Serde invokes this automatically when reading `ByteChunk` fields from JSON. It bridges textual JSON transport back into binary data for the rest of the protocol layer.

*Call graph*: 1 external calls (deserialize).


##### `tests::filesystem_protocol_accepts_legacy_absolute_paths_and_serializes_path_uris`  (lines 505–537)

```
fn filesystem_protocol_accepts_legacy_absolute_paths_and_serializes_path_uris()
```

**Purpose**: Verifies backward-compatible deserialization of legacy absolute filesystem paths while ensuring serialization still emits canonical `PathUri` strings. It also checks sandbox context round-tripping in that mixed legacy/current shape.

**Data flow**: The test builds native current-directory paths, constructs a `FileSystemSandboxContext` from a default permission profile and a `PathUri` cwd, serializes that sandbox to JSON, mutates its `cwd` field to a legacy native-path string, and then deserializes `FsReadFileParams` from JSON containing a legacy absolute `path` plus the modified sandbox. It compares the result to an expected `FsReadFileParams` using `PathUri::from_path`, then serializes the params back to JSON and asserts the output uses URI strings and the expected sandbox serialization.

**Call relations**: This test exercises serde behavior for `FsReadFileParams`, `PathUri`, and `FileSystemSandboxContext` together. It documents a compatibility guarantee relied on by older clients sending native absolute paths.

*Call graph*: calls 3 internal fn (from_permission_profile_with_cwd, default, from_path); 5 external calls (assert_eq!, from_value, json!, to_value, current_dir).


##### `tests::http_request_timeout_treats_omitted_and_null_as_no_timeout`  (lines 540–577)

```
fn http_request_timeout_treats_omitted_and_null_as_no_timeout()
```

**Purpose**: Checks that `HttpRequestParams.timeout_ms` treats both an omitted field and an explicit JSON `null` as `None`, while preserving numeric values when provided. This locks in the intended optional-field semantics for HTTP requests.

**Data flow**: The test deserializes three `HttpRequestParams` values from JSON: one without `timeoutMs`, one with `timeoutMs: null`, and one with `timeoutMs: 1234`. It then asserts that the first two produce `timeout_ms == None` and the third produces `Some(1234)`, while also confirming the `request_id` values were parsed correctly.

**Call relations**: This test targets serde defaults on `HttpRequestParams` and documents the wire compatibility expected by callers constructing executor-side HTTP requests.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


### Execution event stream
This file defines the structured JSONL event model emitted during exec runs for downstream consumers.

### `exec/src/exec_events.rs`

`data_model` · `cross-cutting event serialization and consumption`

This file is a pure data-model module for the execution event stream. Its top-level type, `ThreadEvent`, is a serde-tagged enum using explicit event names like `thread.started`, `turn.completed`, and `item.updated`, so each JSONL record carries a stable `type` discriminator. Turn lifecycle is represented by `ThreadStartedEvent`, `TurnStartedEvent`, `TurnCompletedEvent`, and `TurnFailedEvent`; token accounting is captured in `Usage`, including cached input and reasoning output counts.

The other major branch is item tracking. `ThreadItem` pairs a stable `id` with a flattened `ThreadItemDetails` enum, so item payload fields appear inline in serialized JSON while still preserving a typed `type` tag such as `agent_message`, `command_execution`, or `todo_list`. Each item struct captures the concrete state relevant to that domain: command text, aggregated output, exit code, and `CommandExecutionStatus`; patch file paths and `PatchChangeKind`; MCP server/tool names, JSON arguments, result blocks, and error payloads; collab tool metadata including sender/receiver thread IDs and a `HashMap<String, CollabAgentState>` keyed by agent/thread identifier; web search query/action; and todo entries with completion flags.

A notable design choice is the use of `serde_json::Value` for MCP content and metadata instead of tighter Rust MCP model types, explicitly favoring schema export and loose wire compatibility. Most enums use `snake_case` serde naming, several statuses derive `Default` with `InProgress` as the initial state, and optional fields are omitted or marked optional in generated TS where appropriate.


### Privilege and sandbox IPC
These files describe the wire contracts used for Unix shell escalation and Windows elevated sandbox message exchange.

### `shell-escalation/src/unix/escalate_protocol.rs`

`data_model` · `request handling`

This file is the schema layer for shell escalation on Unix. At the top it declares two string constants that form part of the process-environment contract: `CODEX_ESCALATE_SOCKET` tells exec wrappers which inherited file descriptor carries the escalation socket, and `EXEC_WRAPPER` tells patched shells which wrapper to invoke around `exec()`. The main request payload is `EscalateRequest`, a serde-serializable struct carrying the intercepted executable path, full argv vector, absolute working directory, and a complete environment map. Its `file` may be relative, and the comment establishes the invariant that consumers must resolve it against `workdir` before execution.

Responses are split into two layers. `EscalateResponse` is the serialized server reply containing an `EscalateAction`, a compact wire enum with only `Run`, `Escalate`, and `Deny { reason }`. Separately, the non-serialized `EscalationDecision` and `EscalationExecution` enums represent richer internal policy outcomes: run locally, deny with an optional explanation, or escalate with a specific execution mode (`Unsandboxed`, `TurnDefault`, or explicit `EscalationPermissions`). The three constructor helpers on `EscalationDecision` make those outcomes explicit at call sites.

The file also defines the super-exec side channel messages: `SuperExecMessage` forwards a list of inherited raw file descriptors, and `SuperExecResult` returns the child exit code after the server-side exec completes. Overall, this module contains mostly data definitions, but the comments encode important semantics about path resolution, sandbox selection, and how client/server responsibilities are divided.

#### Function details

##### `EscalationDecision::run`  (lines 55–57)

```
fn run() -> Self
```

**Purpose**: Constructs the internal decision variant meaning the intercepted command should execute normally without server-side escalation. It exists as a named constructor so callers express policy intent directly instead of spelling the enum variant inline.

**Data flow**: It takes no arguments and reads no external state. It creates and returns `EscalationDecision::Run`, without mutating any shared data or performing I/O.

**Call relations**: This helper is used by higher-level decision-making and session-processing code when policy concludes the client can execute directly. In the observed call flow, decision evaluators and session tests invoke it to produce the non-escalated branch that downstream logic then translates into a wire action or local execution path.

*Call graph*: called by 5 (process_decision, determine_action, exec_closes_parent_socket_after_shell_spawn, handle_escalate_session_respects_run_in_sandbox_decision, start_session_exposes_wrapper_env_overlay).


##### `EscalationDecision::escalate`  (lines 59–61)

```
fn escalate(execution: EscalationExecution) -> Self
```

**Purpose**: Constructs the internal decision variant for commands that must be rerouted through the escalation server, preserving the chosen execution mode. It packages the caller's sandbox/execution choice into the richer policy enum.

**Data flow**: It accepts one `EscalationExecution` argument, wraps that value in `EscalationDecision::Escalate(...)`, and returns the new enum. No external state is read or written; the only transformation is embedding the execution-mode payload into the decision.

**Call relations**: Callers use this when policy or session state requires elevated/server-side execution, including paths that preserve explicit permissions or choose unsandboxed/default sandbox behavior. In the broader flow, decision processors create this variant first, and later orchestration code inspects it to launch the escalated execution branch rather than the direct-run branch.

*Call graph*: called by 5 (process_decision, dropping_session_aborts_intercept_workers_and_kills_spawned_child, handle_escalate_session_accepts_received_fds_that_overlap_destinations, handle_escalate_session_executes_escalated_command, handle_escalate_session_passes_permissions_to_executor); 1 external calls (Escalate).


##### `EscalationDecision::deny`  (lines 63–65)

```
fn deny(reason: Option<String>) -> Self
```

**Purpose**: Constructs the internal denial outcome, optionally carrying a human-readable reason that can be surfaced back to the requester. It standardizes creation of the refusal branch of escalation policy.

**Data flow**: It takes an `Option<String>` reason, embeds it into `EscalationDecision::Deny { reason }`, and returns that enum value. It performs no side effects and does not consult any ambient state.

**Call relations**: This helper is used by decision-processing code when neither direct execution nor escalation is permitted. Downstream logic can then inspect the returned denial variant and convert it into the serialized `EscalateAction::Deny` response sent back to the client.

*Call graph*: called by 1 (process_decision).


### `windows-sandbox-rs/src/elevated/ipc_framed.rs`

`io_transport` · `elevated runner handshake and streaming I/O`

This file is the protocol definition for parent-to-elevated-runner communication. It contains both the serializable message types and the framing helpers that turn those messages into a stream-safe wire format. The protocol is versioned with `IPC_PROTOCOL_VERSION`, and every frame is a `FramedMessage` containing that version plus a tagged `Message` enum variant.

The schema covers the full elevated execution lifecycle: `SpawnRequest` carries command, cwd, environment, permission profile, workspace roots, home directories, capability SIDs, timeout, TTY mode, stdin-open state, and private-desktop preference; `SpawnReady` acknowledges child creation; `Output`, `Stdin`, `CloseStdin`, `Resize`, `Exit`, `Error`, and `Terminate` cover streaming and control. Binary payloads are represented as base64 strings, with `encode_bytes` and `decode_bytes` providing the conversion.

`write_frame` serializes a message to JSON bytes, enforces an 8 MiB maximum payload size, writes a little-endian `u32` length prefix followed by the payload, and flushes the writer. `read_frame` performs the inverse: it reads exactly four bytes for the length, treats `UnexpectedEof` at that boundary as clean end-of-stream, rejects oversized frames, reads the payload body, and deserializes JSON into `FramedMessage`. The framing layer is intentionally simple and stream-oriented, making it suitable for named pipes used by the elevated runner path.

#### Function details

##### `encode_bytes`  (lines 129–131)

```
fn encode_bytes(data: &[u8]) -> String
```

**Purpose**: Base64-encodes raw bytes for inclusion in JSON IPC payloads. It is used for binary stdin/stdout/stderr transport over the text-based protocol.

**Data flow**: It takes a byte slice, passes it to the standard base64 engine, and returns the encoded `String`. It reads no external state and performs no I/O.

**Call relations**: This helper is used by protocol producers and is exercised in the round-trip framing test when constructing an `OutputPayload`.

*Call graph*: called by 1 (framed_round_trip).


##### `decode_bytes`  (lines 134–136)

```
fn decode_bytes(data: &str) -> Result<Vec<u8>>
```

**Purpose**: Decodes a base64 payload string back into raw bytes. It is the inverse helper for binary data carried inside JSON messages.

**Data flow**: It accepts a `&str`, decodes its UTF-8 bytes with the standard base64 engine, and returns a `Result<Vec<u8>>`. Errors from the decoder propagate through `anyhow` conversion.

**Call relations**: This helper is used by protocol consumers and tests that validate output payload round-tripping and stdin writer behavior.

*Call graph*: called by 2 (framed_round_trip, runner_stdin_writer_sends_close_stdin_after_input_eof).


##### `write_frame`  (lines 139–149)

```
fn write_frame(mut writer: W, msg: &FramedMessage) -> Result<()>
```

**Purpose**: Serializes a framed message to JSON and writes it with a 4-byte little-endian length prefix. It enforces a maximum payload size before writing.

**Data flow**: It takes a generic `Write` implementor and a borrowed `FramedMessage`, serializes the message with `serde_json::to_vec`, checks `payload.len()` against `MAX_FRAME_LEN`, writes the length prefix and payload bytes with `write_all`, flushes the writer, and returns `Result<()>`.

**Call relations**: This is the outbound transport primitive used by the elevated runner client when sending spawn requests, and by tests that verify framing round-trips.

*Call graph*: called by 2 (framed_round_trip, send_spawn_request); 4 external calls (flush, write_all, bail!, to_vec).


##### `read_frame`  (lines 152–167)

```
fn read_frame(mut reader: R) -> Result<Option<FramedMessage>>
```

**Purpose**: Reads one length-prefixed JSON frame from a byte stream and deserializes it into a `FramedMessage`. It treats EOF before a new frame header as a clean end-of-stream.

**Data flow**: It takes a generic `Read` implementor, attempts to `read_exact` four bytes into a length buffer, returns `Ok(None)` on `UnexpectedEof` at that stage, converts the header with `u32::from_le_bytes`, rejects lengths above `MAX_FRAME_LEN`, allocates a payload buffer of that size, reads the payload exactly, deserializes it with `serde_json::from_slice`, and returns `Ok(Some(msg))`.

**Call relations**: This is the inbound transport primitive used by the runner client to receive `spawn_ready` and by tests and helper wait loops that consume framed protocol messages.

*Call graph*: called by 3 (framed_round_trip, read_spawn_ready, wait_for_frame_count); 5 external calls (read_exact, bail!, from_slice, from_le_bytes, vec!).


##### `tests::framed_round_trip`  (lines 175–197)

```
fn framed_round_trip()
```

**Purpose**: Verifies that a framed `Output` message can be serialized, written, read back, and decoded without losing protocol version, stream identity, or payload bytes.

**Data flow**: It constructs a `FramedMessage` containing base64-encoded `"hello"`, writes it into a `Vec<u8>` with `write_frame`, reads it back with `read_frame`, asserts the version and output stream, decodes the payload with `decode_bytes`, and asserts the recovered bytes.

**Call relations**: This test exercises the full happy-path interaction among `encode_bytes`, `write_frame`, `read_frame`, and `decode_bytes`.

*Call graph*: calls 4 internal fn (decode_bytes, encode_bytes, read_frame, write_frame); 3 external calls (new, assert_eq!, panic!).


##### `tests::spawn_request_serializes_permission_profile`  (lines 200–238)

```
fn spawn_request_serializes_permission_profile()
```

**Purpose**: Checks that `SpawnRequest` JSON includes the permission profile in the expected tagged form and omits unrelated legacy fields. It also verifies deserialization back into the same structured values.

**Data flow**: It builds a `SpawnRequest` with representative command, paths, capability SIDs, timeout, and flags; serializes the enclosing `FramedMessage` to a JSON value; asserts selected fields and absent keys; then deserializes back and asserts the recovered `permission_profile` and `workspace_roots`.

**Call relations**: This test validates the serde schema for the protocol types in this file, especially the shape of `SpawnRequest` when embedded in a framed message.

*Call graph*: calls 1 internal fn (read_only); 8 external calls (new, new, from, assert_eq!, panic!, from_value, to_value, vec!).
