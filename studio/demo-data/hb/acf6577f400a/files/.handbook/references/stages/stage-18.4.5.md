# MCP, exec, and sandbox wire models  `stage-18.4.5`

This stage defines the “wire models” for parts of the system that talk across a boundary. A wire model is the exact shape of messages sent between programs, processes, or tools, usually as JSON or another stream format. These files are shared behind-the-scenes support: they do not run the main agent themselves, but they make sure both sides of a conversation agree on what each message means.

The exec-server files describe how clients connect to an executor, how running processes are named, and what requests and replies look like for starting commands, reading output, accessing files, or making HTTP calls. The exec events file defines the JSON-lines event stream produced by `codex exec`, so outside tools can follow an agent run step by step. The Unix escalation protocol defines the messages exchanged when a shell command may need different sandbox permissions. The Windows framed IPC file does the same for communication with an elevated command runner, and also wraps messages into length-marked packets so they can be read safely from a stream.

## Files in this stage

### Exec server connection basics
These files establish the shared identifiers, connection settings, and core JSON-RPC schema used by exec-server clients and servers.

### `exec-server/src/client_api.rs`

`data_model` · `connection setup and request handling`

An exec-server is a service that can run work and make environment-owned HTTP requests on behalf of a client. This file is the shared vocabulary for connecting to one. It does not open sockets or start processes itself; instead, it defines the small bundles of information other code needs before that can happen.

The file covers several connection styles. A remote server can be reached with a plain WebSocket URL. A more secure rendezvous flow can use Noise, which is an encrypted handshake protocol; in that case, the code keeps together the URL, server identity, public keys, and registry authorization as one single-use bundle so pieces from different connection attempts are not accidentally mixed. A local command-backed server can also be described with a program name, arguments, environment variables, and working directory.

`ExecServerTransportParams` is the main “menu” of transport choices. It says, in one value, whether the caller wants WebSocket, Noise rendezvous, or stdio. The file also defines `HttpClient`, a trait, meaning a promise that any concrete client must fulfill: it can send an HTTP request and either return the whole response body at once or provide a stream for reading it gradually. Without this file, higher-level code would need to know too much about each connection type and could not treat different transports uniformly.

#### Function details

##### `ExecServerTransportParams::fmt`  (lines 111–135)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: This function controls how transport settings are shown in debug output. It makes ordinary connection details visible while keeping the Noise rendezvous variant intentionally sparse, because that path contains sensitive or complex authorization material.

**Data flow**: It receives one transport choice and a debug output writer. It looks at which kind of transport it is, writes a readable label and safe fields for that case, and returns whether formatting succeeded. It does not change the transport settings.

**Call relations**: This is used automatically when code asks Rust to print `ExecServerTransportParams` with debug formatting. Inside, it delegates to Rust’s debug-structure builder so logs and test failures show a tidy, structured view instead of a raw internal dump.

*Call graph*: 1 external calls (debug_struct).


##### `ExecServerTransportParams::websocket_url`  (lines 139–145)

```
fn websocket_url(websocket_url: String) -> Self
```

**Purpose**: This is a convenience constructor for the common case where a caller only has a WebSocket address and wants the normal timeout settings. It saves callers from repeating the default connection and initialization timeouts every time.

**Data flow**: It takes a WebSocket URL string as input. It wraps that URL together with the file’s default connect timeout and default initialize timeout, then returns a `WebSocketUrl` transport setting ready for connection code to use.

**Call relations**: Higher-level remote connection code calls this when it is preparing to talk to an exec-server over WebSocket. Tests also use it to build the same kind of transport value without spelling out all fields, which keeps the setup focused on the behavior being tested.

*Call graph*: called by 2 (remote_inner, remote_file_system_sends_path_and_sandbox_cwd_uris_without_native_conversion).


### `exec-server/src/process_id.rs`

`data_model` · `cross-cutting`

`ProcessId` is like putting a label on a plain piece of text that says, “this string is a process ID.” The value inside is still just a `String`, but wrapping it in its own type makes the code clearer and safer: functions can ask for a `ProcessId` instead of accepting any random text.

The file also makes this wrapper easy to use. Code can create one from a `String`, from a string slice like `"abc"`, or from a borrowed `String`. It can also turn a `ProcessId` back into the inner `String` when ownership of the text is needed. For read-only use, it behaves much like normal text: it can be viewed as `&str`, borrowed as `str`, dereferenced like a string, and printed.

The `Serialize` and `Deserialize` traits mean it can be sent to or read from formats such as JSON without adding an extra object layer. Because of `serde(transparent)`, it is stored as just the underlying string. Without this file, process identifiers would likely be passed around as bare strings, which would make the code easier to misuse and harder to understand.

#### Function details

##### `ProcessId::new`  (lines 13–15)

```
fn new(value: impl Into<String>) -> Self
```

**Purpose**: Creates a new `ProcessId` from any value that can be turned into a `String`. This is the main explicit constructor when code wants to mark some text as a process ID.

**Data flow**: It receives text-like input, converts that input into an owned `String`, then stores it inside a new `ProcessId`. The result is a typed process identifier ready to pass around.

**Call relations**: Tests such as `noise_environment_refreshes_bundle_for_each_connection_attempt` call this when they need a clear process ID value. Internally it relies on Rust’s standard conversion behavior to turn the input into a `String`.

*Call graph*: called by 1 (noise_environment_refreshes_bundle_for_each_connection_attempt); 1 external calls (into).


##### `ProcessId::as_str`  (lines 17–19)

```
fn as_str(&self) -> &str
```

**Purpose**: Gives a read-only view of the process ID as ordinary text. This is useful when code needs to compare, print, or look up the ID without taking it apart.

**Data flow**: It receives a borrowed `ProcessId`, looks at the inner `String`, and returns a borrowed `&str` view of that same text. Nothing is copied or changed.

**Call relations**: This is the shared helper used by `ProcessId::deref`, `ProcessId::borrow`, and `ProcessId::as_ref`. Those trait methods all need the same simple operation: expose the ID as text.

*Call graph*: called by 3 (as_ref, borrow, deref).


##### `ProcessId::into_inner`  (lines 21–23)

```
fn into_inner(self) -> String
```

**Purpose**: Consumes the `ProcessId` and returns the plain `String` stored inside it. Use this when the wrapper is no longer needed and the caller wants to own the raw text.

**Data flow**: It takes ownership of a `ProcessId`, removes the inner `String`, and returns that string. After this, the original `ProcessId` value is gone.

**Call relations**: This is a direct escape hatch from the wrapper type. It does not call other project code and is available when later code needs a normal owned string instead of a typed process ID.


##### `ProcessId::deref`  (lines 29–31)

```
fn deref(&self) -> &Self::Target
```

**Purpose**: Lets a `ProcessId` act like a string slice in many read-only situations. This makes the wrapper convenient while still keeping its stronger type meaning.

**Data flow**: It receives a borrowed `ProcessId`, asks `ProcessId::as_str` for the inner text view, and returns that `&str` view. The stored ID is not changed.

**Call relations**: Rust calls this automatically in places where a `ProcessId` needs to behave like `str`. It delegates the actual text access to `ProcessId::as_str` so there is one consistent way to expose the inner string.

*Call graph*: calls 1 internal fn (as_str).


##### `ProcessId::borrow`  (lines 35–37)

```
fn borrow(&self) -> &str
```

**Purpose**: Allows a `ProcessId` to be borrowed as plain `str`, which is especially useful for lookups in collections such as hash maps. For example, stored `ProcessId` keys can be searched using ordinary string text.

**Data flow**: It receives a borrowed `ProcessId`, calls `ProcessId::as_str`, and returns a borrowed text view. It does not allocate, copy, or modify anything.

**Call relations**: Collection and borrowing code can call this through Rust’s `Borrow` trait. It uses `ProcessId::as_str` so its behavior matches the other read-only string views.

*Call graph*: calls 1 internal fn (as_str).


##### `ProcessId::as_ref`  (lines 41–43)

```
fn as_ref(&self) -> &str
```

**Purpose**: Provides a standard way to view a `ProcessId` as `str`. This helps it work with generic code that accepts anything that can be referenced as text.

**Data flow**: It takes a borrowed `ProcessId`, gets the inner text through `ProcessId::as_str`, and returns that borrowed text. The process ID remains unchanged.

**Call relations**: Generic Rust APIs may call this through the `AsRef` trait when they need a text reference. Like the other view methods, it hands the work to `ProcessId::as_str`.

*Call graph*: calls 1 internal fn (as_str).


##### `ProcessId::fmt`  (lines 47–49)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Controls how a `ProcessId` is shown when formatted for display, such as in logs or user-facing messages. It prints just the underlying ID text.

**Data flow**: It receives a borrowed `ProcessId` and a formatter, then writes the inner string into that formatter. The output is whatever text the ID contains.

**Call relations**: Rust’s formatting system calls this when code uses display formatting, such as `{}`. It does not add decoration or metadata; it passes through the stored process ID text.


##### `ProcessId::from`  (lines 65–67)

```
fn from(value: &String) -> Self
```

**Purpose**: Builds a `ProcessId` from existing string data using Rust’s standard `From` conversion pattern. This lets callers write natural conversion code instead of always calling the constructor directly.

**Data flow**: It receives string data, either owned or borrowed depending on which conversion is being used, and wraps equivalent owned text inside a `ProcessId`. Borrowed text is copied so the new process ID owns its contents.

**Call relations**: Many tests and helper routines use this conversion when setting up process IDs, including session, notification, executor, and spawn-related tests. It serves the same purpose as `ProcessId::new`, but through Rust’s common conversion mechanism.

*Call graph*: called by 17 (process_events_are_delivered_in_seq_order_when_notifications_are_reordered, transport_disconnect_fails_sessions_and_rejects_new_sessions, wake_notifications_do_not_block_other_sessions, default_environment_has_ready_local_executor, spawn_test_process, test_exec_params, exec_params_with_argv, long_poll_read_fails_after_session_resume, output_and_exit_are_retained_after_notification_receiver_closes, terminate_reports_false_after_process_exit (+7 more)).


##### `String::from`  (lines 71–73)

```
fn from(value: ProcessId) -> Self
```

**Purpose**: Turns a `ProcessId` back into a plain owned `String` through Rust’s standard conversion pattern. This is useful when code must pass the ID to something that only accepts ordinary strings.

**Data flow**: It receives ownership of a `ProcessId`, takes out the inner `String`, and returns that string. The wrapper is consumed in the process.

**Call relations**: Rust conversion code calls this when a `ProcessId` is converted into `String`. It is the trait-based counterpart to `ProcessId::into_inner`.


### `exec-server/src/protocol.rs`

`data_model` · `cross-cutting protocol encoding during startup, request handling, streaming, and tests`

This file is like the form template drawer for the exec server protocol. When a client asks the server to start a process, read a file, send input, stop a process, or make an HTTP request, both sides need to agree on the exact field names and data formats. Without this file, one side might send “cwd” while the other expects something else, or binary output could be garbled while traveling through JSON.

The file starts by naming the protocol methods, such as `process/start`, `process/read`, `fs/readFile`, and `http/request`. These names are the labels used in JSON-RPC, a request-and-response style where each message says which method it wants.

Most of the file is made of small data structures. Each one describes the inputs or outputs for a protocol action: initialization, process execution, reading output chunks, writing stdin, filesystem operations, and HTTP requests. Paths are carried as `PathUri`, so paths can be represented safely across operating systems. Optional sandbox information can travel with filesystem calls, so the server can apply filesystem access rules.

A key detail is `ByteChunk`. JSON cannot carry raw bytes directly, so this file wraps byte arrays and serializes them as Base64 text, a common safe text encoding for binary data. That keeps terminal output, file blocks, stdin, and HTTP bodies intact while moving through JSON.

#### Function details

##### `ByteChunk::into_inner`  (lines 44–46)

```
fn into_inner(self) -> Vec<u8>
```

**Purpose**: This takes a `ByteChunk` wrapper and gives back the raw bytes inside it. Code uses it when it no longer needs the protocol wrapper and wants the actual byte data.

**Data flow**: It starts with a `ByteChunk` containing a vector of bytes. The function removes the wrapper and returns that byte vector unchanged. Afterward, the original wrapper is consumed, meaning it is not kept around separately.

**Call relations**: This is a small convenience method for code that receives protocol messages containing binary data. After deserialization has turned Base64 text back into bytes, callers can use this function to hand those bytes to process stdin, file logic, or HTTP body handling.


##### `ByteChunk::from`  (lines 50–52)

```
fn from(value: Vec<u8>) -> Self
```

**Purpose**: This builds a `ByteChunk` from ordinary raw bytes. It lets other code wrap binary data in the protocol-friendly type before sending it through JSON.

**Data flow**: It receives a vector of bytes, places that vector inside a `ByteChunk`, and returns the new wrapper. The bytes themselves are not changed here; the Base64 conversion happens later when serialization runs.

**Call relations**: This is used through Rust’s standard `From` conversion pattern. It fits into the larger flow whenever process output, file content, or HTTP body bytes need to become part of a protocol response or notification.


##### `base64_bytes::serialize`  (lines 477–482)

```
fn serialize(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error>
```

**Purpose**: This turns raw bytes into Base64 text so they can be safely written into JSON. It exists because JSON strings are text, while process output and file or HTTP bodies may contain any byte values.

**Data flow**: It receives a slice of bytes and a serializer, which is the component responsible for writing JSON-compatible data. It encodes the bytes using standard Base64, then asks the serializer to write that encoded text string. The output is a serialized JSON string representing the original bytes.

**Call relations**: This function is called automatically by Serde, the serialization library, whenever a `ByteChunk` is being turned into JSON. It hands the final text form to the serializer’s string-writing function so the rest of the protocol can treat binary data as ordinary JSON text.

*Call graph*: 1 external calls (serialize_str).


##### `base64_bytes::deserialize`  (lines 484–492)

```
fn deserialize(deserializer: D) -> Result<Vec<u8>, D::Error>
```

**Purpose**: This turns Base64 text from JSON back into the original raw bytes. It is the receiving-side partner to `base64_bytes::serialize`.

**Data flow**: It receives a deserializer, reads a string from the incoming JSON, and treats that string as Base64. If decoding succeeds, it returns the original byte vector. If the text is not valid Base64, it returns a deserialization error so the bad protocol message is rejected.

**Call relations**: This function is called automatically by Serde when JSON is being read into a `ByteChunk`. It first relies on Serde to read the JSON string, then decodes that string so higher-level process, filesystem, or HTTP code receives real bytes instead of encoded text.

*Call graph*: 1 external calls (deserialize).


##### `tests::filesystem_protocol_accepts_legacy_absolute_paths_and_serializes_path_uris`  (lines 505–537)

```
fn filesystem_protocol_accepts_legacy_absolute_paths_and_serializes_path_uris()
```

**Purpose**: This test checks that filesystem protocol messages still accept older-style absolute path strings, while writing them back out in the newer URI form. That matters for compatibility with clients or saved messages that were created before the path format changed.

**Data flow**: The test builds a current-directory path and a sandbox context, then deliberately rewrites the sandbox JSON to contain a plain native path string. It deserializes that JSON into `FsReadFileParams`, checks that the result matches the expected `PathUri`-based structure, then serializes it again and confirms the output uses URI strings. The before state is legacy-looking JSON; the after state is the normalized protocol form.

**Call relations**: This test exercises the protocol data types through JSON conversion rather than calling server behavior directly. It uses path conversion, sandbox construction, JSON parsing, JSON writing, and equality checks to prove that this file’s data model can bridge old client input and current protocol output.

*Call graph*: calls 3 internal fn (from_permission_profile_with_cwd, default, from_path); 5 external calls (assert_eq!, from_value, json!, to_value, current_dir).


##### `tests::http_request_timeout_treats_omitted_and_null_as_no_timeout`  (lines 540–577)

```
fn http_request_timeout_treats_omitted_and_null_as_no_timeout()
```

**Purpose**: This test confirms that an HTTP request with no timeout field and one with an explicit JSON `null` timeout both mean “no timeout.” It also confirms that a number is preserved as the requested millisecond timeout.

**Data flow**: The test creates three JSON HTTP request messages: one without `timeoutMs`, one with `timeoutMs` set to null, and one with `timeoutMs` set to 1234. It deserializes each into `HttpRequestParams` and checks the resulting `timeout_ms` field. The first two become `None`, meaning no deadline, while the third becomes `Some(1234)`.

**Call relations**: This test protects the behavior of the HTTP request protocol shape defined in this file. It is run by the test suite and verifies that Serde’s optional-field behavior matches what callers expect when they send executor-side HTTP requests.

*Call graph*: 3 external calls (assert_eq!, from_value, json!).


### Execution event stream
This file defines the structured JSONL event model emitted during exec runs for downstream consumers.

### `exec/src/exec_events.rs`

`data_model` · `active throughout event streaming during an exec run`

This file is the shared vocabulary for reporting what happens during a `codex exec` session. Think of it like a receipt printer for an agent run: each line says something specific happened, such as a thread starting, a user turn beginning, a command running, a file patch being applied, or an error occurring. Without these definitions, consumers of the event stream would have to guess what each JSON object means, and small changes could easily break dashboards, wrappers, tests, or TypeScript clients.

The main type is `ThreadEvent`, an enum, meaning a value can be one of several named event kinds. Each event is serialized with a `type` field such as `thread.started`, `turn.completed`, or `item.updated`. A thread is the larger conversation, while a turn is one prompt and the agent’s work to answer it.

Most detailed activity is represented as a `ThreadItem`. Each item has an `id` and a typed payload, such as an agent message, reasoning summary, command execution, file change, MCP tool call, collaboration tool call, web search, to-do list, or non-fatal error. Status enums record whether work is still in progress, completed, failed, or declined.

The file also derives serialization, deserialization, and TypeScript export support. That means the same event shapes can be used safely in Rust, JSON, and generated TypeScript types.


### Privilege and sandbox IPC
These files describe the wire contracts used for Unix shell escalation and Windows elevated sandbox message exchange.

### `shell-escalation/src/unix/escalate_protocol.rs`

`data_model` · `request handling for intercepted Unix exec calls`

This file is mostly a set of simple data shapes for the shell escalation system. The real-world problem is this: a command starts inside a patched shell, but before it actually runs, the system may need to ask, “Should this run normally, be rerun somewhere less restricted, or be blocked?” Without these shared types, the client and server could not reliably agree on what command was requested or what answer was given.

The file defines environment variable names used as signposts. One tells wrapper programs where to find the inherited socket, which is like a private phone line back to the escalation server. Another tells patched shells what executable wrapper to use around exec calls, where exec means replacing the current process with a new program.

`EscalateRequest` describes the command that was caught: the program path, its arguments, working directory, and environment variables. `EscalateResponse` carries back the server’s answer as an `EscalateAction`: run it, escalate it, or deny it with an optional reason.

There is also a more internal decision type, `EscalationDecision`, which can say not only “escalate” but also how to execute: outside the sandbox, with the turn’s default sandbox, or with explicit permissions. Finally, `SuperExecMessage` and `SuperExecResult` describe forwarding open file descriptors and reporting the final exit code after the command finishes.

#### Function details

##### `EscalationDecision::run`  (lines 55–57)

```
fn run() -> Self
```

**Purpose**: This is a small convenience function that creates a decision meaning “run the command as-is.” It gives other code a clear, readable way to say that no escalation or blocking is needed.

**Data flow**: Nothing goes in. The function simply produces an `EscalationDecision` value in the `Run` state. It does not read external data or change anything else.

**Call relations**: Decision-making code such as `process_decision` and `determine_action` uses this when the intercepted command should continue normally. Tests and session setup flows also use it to confirm that the wrapper and session behavior work when the answer is simply to run inside the normal path.

*Call graph*: called by 5 (process_decision, determine_action, exec_closes_parent_socket_after_shell_spawn, handle_escalate_session_respects_run_in_sandbox_decision, start_session_exposes_wrapper_env_overlay).


##### `EscalationDecision::escalate`  (lines 59–61)

```
fn escalate(execution: EscalationExecution) -> Self
```

**Purpose**: This creates a decision meaning “do not just run this locally; send it through the escalation path.” The caller supplies the kind of escalated execution to use, such as unsandboxed execution or a specific permission set.

**Data flow**: An `EscalationExecution` choice goes in. The function wraps that choice inside an `EscalationDecision::Escalate` value and returns it. Nothing else is modified.

**Call relations**: Code such as `process_decision` uses this when a command needs special execution rather than the ordinary path. Session and executor tests call it to exercise the escalation flow, including cases where file descriptors are forwarded, commands are actually run through the executor, or explicit permissions must be passed along.

*Call graph*: called by 5 (process_decision, dropping_session_aborts_intercept_workers_and_kills_spawned_child, handle_escalate_session_accepts_received_fds_that_overlap_destinations, handle_escalate_session_executes_escalated_command, handle_escalate_session_passes_permissions_to_executor); 1 external calls (Escalate).


##### `EscalationDecision::deny`  (lines 63–65)

```
fn deny(reason: Option<String>) -> Self
```

**Purpose**: This creates a decision meaning “do not execute the command.” It can include a human-readable reason, which helps explain why the command was refused.

**Data flow**: An optional text reason goes in. The function returns an `EscalationDecision::Deny` value containing that reason. It does not contact anything or change any shared state.

**Call relations**: `process_decision` calls this when the policy outcome is to block the intercepted command. That denial can later be turned into a protocol response so the client side knows not to launch the program and can surface the reason if one was provided.

*Call graph*: called by 1 (process_decision).


### `windows-sandbox-rs/src/elevated/ipc_framed.rs`

`io_transport` · `elevated command startup and I/O streaming`

When this project needs to run a command through an elevated Windows helper, two separate processes must stay in sync. The parent needs to say things like “start this command,” “send these stdin bytes,” or “please terminate.” The elevated runner needs to answer with things like “the child process is ready,” “here is stdout,” “here is stderr,” “the process exited,” or “something failed.” This file is the shared rulebook for that conversation.

The messages are JSON, which is a text format that is easy to inspect and version. Raw terminal bytes are not placed directly into JSON; they are converted to base64, a text-safe encoding, so arbitrary output or input can travel without corrupting the message. Each JSON message is wrapped in a frame: first four bytes say how long the message is, then the JSON bytes follow. This is like putting a label on a package saying exactly how big the package is, so the receiver knows where one message ends and the next begins.

The file also sets a maximum frame size of 8 MiB. That is not part of the message language itself; it is a safety guard so a broken or hostile sender cannot make the receiver allocate huge memory by claiming an enormous packet is coming.

#### Function details

##### `encode_bytes`  (lines 129–131)

```
fn encode_bytes(data: &[u8]) -> String
```

**Purpose**: Turns raw bytes into base64 text so they can be safely placed inside a JSON message. This is used for command input and output, where the bytes may contain anything, not just normal readable characters.

**Data flow**: It receives a slice of bytes, such as the bytes for `hello` or bytes read from stdout. It encodes those bytes using standard base64. It returns a string that can safely travel as JSON text.

**Call relations**: The round-trip test uses this before writing an `Output` message, proving that real byte data can be packed into the protocol. In normal use, the same idea is used whenever the parent or runner needs to send stdin, stdout, or stderr through the framed IPC messages.

*Call graph*: called by 1 (framed_round_trip).


##### `decode_bytes`  (lines 134–136)

```
fn decode_bytes(data: &str) -> Result<Vec<u8>>
```

**Purpose**: Turns base64 text from a message back into the original raw bytes. A caller uses this after receiving stdin, stdout, or stderr data in the protocol.

**Data flow**: It receives a string that should contain base64 text. It tries to decode that text into the original bytes. If the text is valid, it returns those bytes; if not, it returns an error explaining that decoding failed.

**Call relations**: The round-trip test calls this after reading an `Output` message to confirm that `hello` comes back unchanged. Another stdin-writer test elsewhere also calls it when checking that stdin data sent through the runner protocol can be read back correctly.

*Call graph*: called by 2 (framed_round_trip, runner_stdin_writer_sends_close_stdin_after_input_eof).


##### `write_frame`  (lines 139–149)

```
fn write_frame(mut writer: W, msg: &FramedMessage) -> Result<()>
```

**Purpose**: Writes one complete protocol message to a byte stream in a form the other side can reliably read. It adds the length prefix before the JSON so the receiver knows exactly how many bytes belong to this message.

**Data flow**: It receives a writable stream and a `FramedMessage`. It serializes the message into JSON bytes, checks that the payload is not larger than the 8 MiB safety limit, writes a four-byte little-endian length, writes the JSON payload, then flushes the stream so the data is pushed out. It returns success, or an error if serialization, size checking, writing, or flushing fails.

**Call relations**: The test uses it to write a message into an in-memory buffer before reading it back. In the real elevated flow, `send_spawn_request` calls it when the parent sends the initial command-start request to the elevated runner.

*Call graph*: called by 2 (framed_round_trip, send_spawn_request); 4 external calls (flush, write_all, bail!, to_vec).


##### `read_frame`  (lines 152–167)

```
fn read_frame(mut reader: R) -> Result<Option<FramedMessage>>
```

**Purpose**: Reads one complete protocol message from a byte stream. It understands the same length-prefixed format written by `write_frame`.

**Data flow**: It receives a readable stream. First it tries to read four bytes for the message length. If the stream ends cleanly before a length is available, it returns `None`, meaning there is no more message. Otherwise it checks the length against the 8 MiB safety limit, reads exactly that many JSON bytes, parses them into a `FramedMessage`, and returns it. Bad lengths, incomplete payloads, or invalid JSON become errors.

**Call relations**: The round-trip test calls this after `write_frame` to prove both sides of the framing format match. In the real elevated flow, `read_spawn_ready` uses it to wait for the runner’s startup acknowledgement, and `wait_for_frame_count` uses it while collecting messages in tests or helper logic.

*Call graph*: called by 3 (framed_round_trip, read_spawn_ready, wait_for_frame_count); 5 external calls (read_exact, bail!, from_slice, from_le_bytes, vec!).


##### `tests::framed_round_trip`  (lines 175–197)

```
fn framed_round_trip()
```

**Purpose**: Checks that a message can be encoded, framed, written, read back, decoded, and still contain the same meaning and bytes. It protects the basic contract between parent and elevated runner.

**Data flow**: It builds an `Output` message containing base64-encoded `hello` on stdout. It writes that message into a memory buffer with `write_frame`, reads it back with `read_frame`, checks the protocol version and stream name, decodes the base64 payload with `decode_bytes`, and confirms the final bytes are still `hello`.

**Call relations**: This test exercises the main helper chain in this file: `encode_bytes`, `write_frame`, `read_frame`, and `decode_bytes`. It acts like a miniature parent-runner conversation in memory, without needing real named pipes or real processes.

*Call graph*: calls 4 internal fn (decode_bytes, encode_bytes, read_frame, write_frame); 3 external calls (new, assert_eq!, panic!).


##### `tests::spawn_request_serializes_permission_profile`  (lines 200–238)

```
fn spawn_request_serializes_permission_profile()
```

**Purpose**: Checks that a command-start request serializes and deserializes the permission profile in the expected JSON shape. This matters because the parent and elevated runner must agree on how sandbox permissions are described.

**Data flow**: It builds a `SpawnRequest` with a command, working directory, workspace root, read-only permission profile, Codex home paths, capability identifiers, timeout, and terminal settings. It converts the full framed message to JSON, checks important JSON fields, then converts the JSON back into a `FramedMessage` and verifies that the permission profile and workspace roots survived unchanged.

**Call relations**: This test focuses on the `SpawnRequest` data defined in this file and the external `PermissionProfile::read_only` helper. It does not call the frame reader or writer; instead, it checks the JSON schema directly so changes to the message shape are caught early.

*Call graph*: calls 1 internal fn (read_only); 8 external calls (new, new, from, assert_eq!, panic!, from_value, to_value, vec!).
