# MCP and executor-backed transport adapters  `stage-19.4`

This stage is the bridge between the MCP client’s high-level “talk to a server” logic and the real ways that talking can happen underneath. It is part of the system’s main work, but mostly as behind-the-scenes plumbing.

At the top, rmcp-client/src/lib.rs is the front door. It gathers the public client API and the helper pieces so other code can use MCP without knowing the internal layout.

The transport files provide different roads to the same destination. in_process_transport.rs defines how to create a connection to a server that lives inside the same program. executor_process_transport.rs does the same for a server started as a child process, sending and receiving JSON-RPC messages over standard input and output, line by line, while keeping error output separate.

For HTTP-based MCP, http_client_adapter.rs converts the project’s shared HTTP capability into the streamable HTTP form MCP expects, including server-sent events (a way to receive updates as a stream). It relies on reqwest_http_client.rs for real network calls and rpc_http_client.rs when HTTP must be forwarded through the exec-server connection. www_authenticate.rs reads auth challenge headers, and streamable_http_retry.rs retries startup and temporary failures so connections are more resilient.

## Files in this stage

### Client library surface
The crate root exposes the RMCP client API and the transport abstractions that higher-level consumers build on.

### `rmcp-client/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the public façade for the `rmcp-client` crate. Internally it declares modules for authentication status discovery, elicitation support, executor-process and stdio transports, HTTP adaptation, in-process transport creation, logging, OAuth token handling and login flows, program resolution, the core `RmcpClient`, and utility code. Externally it curates that implementation into a stable API through `pub use` re-exports.

The exported surface falls into several groups. Authentication exports include discovery/status helpers (`determine_streamable_http_auth_status`, `discover_streamable_http_oauth`, `supports_oauth_login`) and the `StreamableHttpOAuthDiscovery` plus protocol-level `McpAuthStatus` type. OAuth lifecycle exports include token wrapper/storage types and functions to save or delete tokens, while `load_oauth_tokens` remains crate-private, signaling that reading persisted credentials is an internal concern. Login-flow exports expose `perform_oauth_login` variants and related error/handle types. Client-operation exports expose `RmcpClient` itself plus elicitation request/response types and tool-listing result wrappers. Transport exports expose `InProcessTransportFactory` and stdio launcher types for local or executor-backed servers.

The main design choice here is API curation rather than implementation: consumers can depend on this crate root instead of internal module paths, while the crate authors retain freedom to reorganize internals behind the re-export boundary.


### `rmcp-client/src/in_process_transport.rs`

`io_transport` · `connection setup`

This file defines a single trait, `InProcessTransportFactory`, which is the extension point for in-memory MCP connections inside the `rmcp-client` crate. The trait requires implementors to be `Send + Sync`, allowing the factory object to be retained and invoked safely from asynchronous, potentially multi-threaded client code. Its sole method, `open`, returns a `BoxFuture<'static, io::Result<DuplexStream>>`, meaning transport creation is asynchronous, heap-erased, and yields a Tokio `DuplexStream` representing the client side of a byte stream.

The documentation captures the key lifecycle contract: each `open` call must recreate a fresh in-process transport, and implementations are expected to start the paired server side before returning the client stream. That design supports reconnect behavior in `RmcpClient`; instead of caching a one-shot stream, the client stores a factory and asks it to build a new stream whenever the connection must be re-established. Using `DuplexStream` makes the transport look like a bidirectional byte channel rather than a higher-level RPC object, keeping this abstraction focused on transport plumbing. There is no implementation here, only the interface and its concurrency/reconnection expectations.


### Executor-backed stdio transport
This transport bridges RMCP message flow onto an executor-managed child process using stdio streams.

### `rmcp-client/src/executor_process_transport.rs`

`io_transport` · `request handling and transport teardown`

This module sits below MCP protocol logic and above the executor process API. `ExecutorProcessTransport` owns an `Arc<dyn ExecProcess>` for writes and termination plus an `ExecProcessEventReceiver` subscription for pushed stdout/stderr/lifecycle events. Outbound messages are serialized with `serde_json::to_vec`, suffixed with `\n`, and written through `process.write`; executor `WriteStatus` values are mapped into `io::Error` kinds such as `BrokenPipe` or `WouldBlock`. Inbound handling is more involved: stdout bytes are buffered in a `LineBuffer`, which tracks `scanned_len` so repeated partial-line checks only search newly appended bytes. `receive_message` first drains any complete buffered line, then waits on process events, updating `last_seq` and routing output chunks by stream. Stdout and PTY bytes feed the MCP framing buffer; stderr bytes are line-buffered and logged with `tracing::info!` so diagnostics stay readable and never enter the protocol stream.

The transport is resilient to dropped broadcast events. If `recv()` reports lag, `recover_lagged_events` performs a retained-output `process.read` starting from `last_seq`, replays unseen chunks, and marks the stream closed if the executor reports failure or closure. Once closed, `take_stdout_message` is allowed to parse one final unterminated stdout fragment, mirroring EOF decoding behavior. `Drop` is defensive: if the caller forgot to `close`, it tries to schedule `process.terminate()` on the current Tokio runtime and logs a warning if no runtime is available.

#### Function details

##### `LineBuffer::extend_from_slice`  (lines 59–61)

```
fn extend_from_slice(&mut self, bytes: &[u8])
```

**Purpose**: Appends newly received bytes to the line buffer without altering the already-scanned prefix marker.

**Data flow**: It takes a byte slice and extends `self.bytes` with those bytes in place; it returns no value and leaves `self.scanned_len` unchanged.

**Call relations**: It is the primitive append operation used by `ExecutorProcessTransport::push_process_output` for stdout and by `ExecutorProcessTransport::push_stderr` for stderr.

*Call graph*: 1 external calls (extend_from_slice).


##### `LineBuffer::take_line`  (lines 63–74)

```
fn take_line(&mut self) -> Option<BytesMut>
```

**Purpose**: Extracts the next newline-terminated line from the buffer, searching only bytes not previously known to be newline-free.

**Data flow**: It scans `self.bytes[self.scanned_len..]` with `memchr` for `\n`. If none is found, it updates `self.scanned_len` to the current buffer length and returns `None`. If a newline is found, it splits the buffer through that newline, truncates the returned chunk to exclude the newline byte, resets `self.scanned_len` to `0`, and returns the line as `BytesMut`.

**Call relations**: It is used by `ExecutorProcessTransport::take_stdout_message` to frame MCP messages and by `ExecutorProcessTransport::push_stderr` to emit complete stderr log lines.

*Call graph*: 3 external calls (len, split_to, memchr).


##### `LineBuffer::take_remaining`  (lines 76–83)

```
fn take_remaining(&mut self) -> Option<BytesMut>
```

**Purpose**: Returns all buffered bytes as one unterminated fragment, typically at EOF.

**Data flow**: If `self.bytes` is empty it returns `None`; otherwise it resets `self.scanned_len` to `0`, splits out the entire buffer, and returns it as `Some(BytesMut)`.

**Call relations**: It is used by `ExecutorProcessTransport::take_stdout_message` when the process has closed and by `ExecutorProcessTransport::flush_stderr` to log a final partial stderr line.

*Call graph*: 2 external calls (is_empty, split).


##### `ExecutorProcessTransport::new`  (lines 135–151)

```
fn new(process: Arc<dyn ExecProcess>, program_name: String) -> Self
```

**Purpose**: Constructs a transport around an already-started executor process and subscribes to its event stream immediately.

**Data flow**: It takes an `Arc<dyn ExecProcess>` and a diagnostic `program_name`, calls `process.subscribe_events()`, initializes empty `LineBuffer`s for stdout and stderr, sets `closed`, `terminated`, and `last_seq` to false/false/0, and returns the transport.

**Call relations**: It is called by higher-level launch logic after a process has been started. Early subscription ensures `receive_message` can replay output emitted before rmcp begins reading.

*Call graph*: called by 1 (launch_server); 1 external calls (default).


##### `ExecutorProcessTransport::next_process_id`  (lines 153–159)

```
fn next_process_id() -> ProcessId
```

**Purpose**: Generates a unique logical process id for a new MCP stdio server within the current executor session.

**Data flow**: It atomically increments the global `PROCESS_COUNTER` with relaxed ordering, formats the resulting index as `mcp-stdio-<index>`, converts that string into `ProcessId`, and returns it.

**Call relations**: It is used by server-launch orchestration before constructing the transport so each started process gets a collision-free client-side identifier.

*Call graph*: calls 1 internal fn (from); called by 1 (launch_server); 1 external calls (format!).


##### `ExecutorProcessTransport::send`  (lines 165–190)

```
fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = std::result::Result<(), Self::Error>> + Send + 'static
```

**Purpose**: Serializes an rmcp outbound message into newline-delimited JSON and writes it to the executor-managed process stdin.

**Data flow**: It takes `TxJsonRpcMessage<RoleClient>`, clones the process handle into the async future, serializes the message with `serde_json::to_vec`, appends `\n`, awaits `process.write(bytes)`, and maps `WriteStatus::Accepted` to success while converting `UnknownProcess`, `StdinClosed`, and `Starting` into `io::Error`s with appropriate kinds.

**Call relations**: rmcp calls this whenever it needs to send a client-side JSON-RPC message over the stdio transport.

*Call graph*: 3 external calls (clone, new, to_vec).


##### `ExecutorProcessTransport::receive`  (lines 192–194)

```
fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send
```

**Purpose**: Exposes the transport's inbound receive loop through the rmcp `Transport` trait.

**Data flow**: It takes `&mut self` and returns the future produced by `self.receive_message()`, which eventually yields `Option<RxJsonRpcMessage<RoleClient>>`.

**Call relations**: rmcp calls this repeatedly to obtain the next inbound server message; all actual buffering and event handling lives in `ExecutorProcessTransport::receive_message`.

*Call graph*: calls 1 internal fn (receive_message).


##### `ExecutorProcessTransport::close`  (lines 196–200)

```
async fn close(&mut self) -> std::result::Result<(), Self::Error>
```

**Purpose**: Terminates the wrapped process explicitly and marks the transport as already terminated.

**Data flow**: It awaits `self.process.terminate()`, maps executor errors into `io::Error`, sets `self.terminated = true` on success, and returns `Ok(())`.

**Call relations**: rmcp or higher-level shutdown logic calls this during orderly teardown; setting `terminated` suppresses duplicate termination attempts in `Drop`.


##### `ExecutorProcessTransport::receive_message`  (lines 204–258)

```
async fn receive_message(&mut self) -> Option<RxJsonRpcMessage<RoleClient>>
```

**Purpose**: Runs the main inbound event loop, turning executor output and lifecycle events into parsed rmcp messages or EOF.

**Data flow**: It loops indefinitely. First it tries `self.take_stdout_message(self.closed)` and returns a parsed message if available. If the transport is closed and no message remains, it flushes any buffered stderr via `flush_stderr` and returns `None`. Otherwise it awaits `self.events.recv()`: output chunks are fed to `push_process_output_if_new`; `Exited` and `Closed` update sequence tracking and closure state; `Failed` logs a warning and closes; lagged broadcast errors trigger `recover_lagged_events` and close on recovery failure; a closed broadcast channel also marks the transport closed.

**Call relations**: It is the core implementation behind `receive`, coordinating `take_stdout_message`, sequence tracking, lag recovery, stderr flushing, and output routing.

*Call graph*: calls 6 internal fn (recv, flush_stderr, note_seq, push_process_output_if_new, recover_lagged_events, take_stdout_message); called by 1 (receive); 1 external calls (warn!).


##### `ExecutorProcessTransport::note_seq`  (lines 260–262)

```
fn note_seq(&mut self, seq: u64)
```

**Purpose**: Advances the highest observed executor event sequence number.

**Data flow**: It takes a `seq` and sets `self.last_seq` to the maximum of the current value and `seq`.

**Call relations**: It is used by `receive_message` when processing non-output lifecycle events so later lag recovery starts from the correct retained-output cursor.

*Call graph*: called by 1 (receive_message).


##### `ExecutorProcessTransport::should_accept_seq`  (lines 264–270)

```
fn should_accept_seq(&mut self, seq: u64) -> bool
```

**Purpose**: Filters duplicate or stale output chunks based on executor sequence numbers.

**Data flow**: It compares the incoming `seq` to `self.last_seq`; if `seq <= last_seq` it returns `false`, otherwise it updates `self.last_seq = seq` and returns `true`.

**Call relations**: It is called by `push_process_output_if_new` before any chunk is buffered, preventing replayed retained-output reads from duplicating already processed bytes.

*Call graph*: called by 1 (push_process_output_if_new).


##### `ExecutorProcessTransport::recover_lagged_events`  (lines 272–296)

```
async fn recover_lagged_events(&mut self) -> io::Result<()>
```

**Purpose**: Recovers missed stdout/stderr chunks after the broadcast event stream reports lag.

**Data flow**: It calls `self.process.read(Some(self.last_seq), None, Some(0))`, replays each returned chunk through `push_process_output_if_new`, advances `self.last_seq` to at least `response.next_seq - 1`, and if the retained read reports `failure` or `closed`, logs and marks `self.closed = true`. It returns `Ok(())` or an `io::Error` if the retained read itself fails.

**Call relations**: It is invoked only from `receive_message` when `events.recv()` returns `RecvError::Lagged`, allowing the transport to continue instead of silently losing protocol bytes.

*Call graph*: calls 1 internal fn (push_process_output_if_new); called by 1 (receive_message); 1 external calls (warn!).


##### `ExecutorProcessTransport::push_process_output_if_new`  (lines 298–303)

```
fn push_process_output_if_new(&mut self, chunk: ProcessOutputChunk)
```

**Purpose**: Accepts an output chunk only if its sequence number has not already been processed.

**Data flow**: It takes a `ProcessOutputChunk`, checks `self.should_accept_seq(chunk.seq)`, returns early on duplicates, and otherwise forwards the chunk to `self.push_process_output`.

**Call relations**: It is used both in the normal event path inside `receive_message` and in replay processing inside `recover_lagged_events`.

*Call graph*: calls 2 internal fn (push_process_output, should_accept_seq); called by 2 (receive_message, recover_lagged_events).


##### `ExecutorProcessTransport::push_process_output`  (lines 305–320)

```
fn push_process_output(&mut self, chunk: ProcessOutputChunk)
```

**Purpose**: Routes raw process output bytes into either the MCP stdout framing buffer or the stderr diagnostic logger.

**Data flow**: It consumes a `ProcessOutputChunk`, extracts the raw bytes, matches on `chunk.stream`, appends stdout or PTY bytes to `self.stdout`, and forwards stderr bytes to `self.push_stderr` for line-oriented logging.

**Call relations**: It is called only after sequence filtering by `push_process_output_if_new`, and it feeds the buffers later consumed by `take_stdout_message` and `flush_stderr`.

*Call graph*: calls 2 internal fn (extend_from_slice, push_stderr); called by 1 (push_process_output_if_new).


##### `ExecutorProcessTransport::take_stdout_message`  (lines 322–344)

```
fn take_stdout_message(&mut self, allow_partial: bool) -> Option<RxJsonRpcMessage<RoleClient>>
```

**Purpose**: Parses the next complete JSON-RPC message from buffered stdout, optionally accepting a final unterminated line after process closure.

**Data flow**: It loops pulling either `self.stdout.take_line()` or, when `allow_partial` is true and no newline exists, `self.stdout.take_remaining()`. Each candidate line is normalized by `trim_trailing_carriage_return` and deserialized with `serde_json::from_slice::<RxJsonRpcMessage<RoleClient>>`. On successful parse it returns the message; on parse failure it logs a debug message and continues scanning for another line; if no candidate exists it returns `None`.

**Call relations**: It is called at the top of each `receive_message` loop iteration to drain already-buffered stdout before waiting for more executor events.

*Call graph*: calls 1 internal fn (take_line); called by 1 (receive_message); 3 external calls (trim_trailing_carriage_return, debug!, take_remaining).


##### `ExecutorProcessTransport::push_stderr`  (lines 346–358)

```
fn push_stderr(&mut self, bytes: &[u8])
```

**Purpose**: Buffers stderr bytes and emits complete stderr lines as structured log records.

**Data flow**: It appends incoming bytes to `self.stderr`, repeatedly extracts complete lines with `take_line`, trims trailing `\r`, converts each line lossily to UTF-8, and logs it with `tracing::info!` tagged by `program_name`.

**Call relations**: It is called by `push_process_output` whenever the executor reports `ExecOutputStream::Stderr`, keeping stderr out of the MCP framing path.

*Call graph*: calls 2 internal fn (extend_from_slice, take_line); called by 1 (push_process_output); 2 external calls (trim_trailing_carriage_return, info!).


##### `ExecutorProcessTransport::flush_stderr`  (lines 360–369)

```
fn flush_stderr(&mut self)
```

**Purpose**: Logs any final unterminated stderr fragment when the process stream ends.

**Data flow**: It calls `self.stderr.take_remaining()`, returns immediately if empty, otherwise converts the remaining bytes lossily to UTF-8 and logs one final `info!` record.

**Call relations**: It is called by `receive_message` once the transport is closed and no more stdout messages remain, ensuring trailing stderr diagnostics are not lost.

*Call graph*: called by 1 (receive_message); 2 external calls (info!, take_remaining).


##### `ExecutorProcessTransport::trim_trailing_carriage_return`  (lines 371–376)

```
fn trim_trailing_carriage_return(mut line: BytesMut) -> BytesMut
```

**Purpose**: Normalizes CRLF-framed lines by removing a trailing carriage return before parsing or logging.

**Data flow**: It takes ownership of a `BytesMut`, checks whether the last byte is `\r`, truncates one byte if so, and returns the possibly shortened buffer.

**Call relations**: It is used by both `take_stdout_message` and `push_stderr` so stdout JSON parsing and stderr logging behave correctly with CRLF line endings.

*Call graph*: 3 external calls (last, len, truncate).


##### `ExecutorProcessTransport::drop`  (lines 384–406)

```
fn drop(&mut self)
```

**Purpose**: Best-effort cleanup that terminates the remote MCP server process if the transport is dropped without an explicit close.

**Data flow**: On drop, it returns immediately if `self.terminated` is already true. Otherwise it clones the process handle and program name, tries to obtain the current Tokio runtime handle, logs a warning and gives up if none exists, and if a runtime is available spawns an async task that awaits `process.terminate()` and logs any termination failure.

**Call relations**: This runs automatically at object destruction time as a safety net for callers that forget to invoke `close`.

*Call graph*: 4 external calls (clone, try_current, drop, warn!).


### HTTP capability implementations
These executor-side and orchestrator-side clients provide the concrete shared HTTP capability that higher-level MCP HTTP adaptation relies on.

### `exec-server/src/client/reqwest_http_client.rs`

`io_transport` · `outbound HTTP execution and streamed response forwarding`

This module is the network-originating side of the HTTP capability. `ReqwestHttpClient` is a lightweight adapter implementing the shared `HttpClient` trait, while `ReqwestHttpRequestRunner` owns a configured `reqwest::Client` and performs the actual request execution. `build_client` applies an optional timeout and delegates TLS/custom-CA setup to `build_reqwest_client_with_custom_ca`, converting builder failures into `ExecServerError::HttpRequest`.

`run` is the central routine. It validates the HTTP method bytes, parses the URL, and explicitly restricts schemes to `http` and `https`. It converts protocol headers into a `HeaderMap`, builds the request, attaches an optional body, and sends it. Send failures are logged with `log_send_error`, which strips the URL from the `reqwest::Error` and records timeout/connect flags plus the source chain for diagnostics. On success, the runner captures status and response headers. If `stream_response` is false, it eagerly reads the full body into `HttpRequestResponse`; otherwise it returns headers immediately plus a `PendingReqwestHttpBodyStream` containing the live `reqwest::Response`.

`stream_body` consumes that pending stream and forwards each chunk as `HttpRequestBodyDeltaNotification` with monotonically increasing sequence numbers. Any chunk read error becomes a terminal delta with `done: true` and an `error` string; normal completion sends a final empty terminal delta. Header validation is strict: invalid names or values become JSON-RPC invalid-params errors before any network request is attempted.

#### Function details

##### `ReqwestHttpClient::build_client`  (lines 53–62)

```
fn build_client(timeout_ms: Option<u64>) -> Result<reqwest::Client, ExecServerError>
```

**Purpose**: Builds a configured `reqwest::Client` with an optional request timeout and custom CA support. It is the shared constructor used by the request runner.

**Data flow**: It takes `Option<u64>` timeout milliseconds, chooses either a default `reqwest::Client::builder()` or one with `.timeout(Duration::from_millis(timeout_ms))`, then passes the builder to `build_reqwest_client_with_custom_ca`. Success returns the built client; failure is converted to `ExecServerError::HttpRequest(error.to_string())`.

**Call relations**: Called by `ReqwestHttpRequestRunner::new`. It isolates client-construction policy from request execution.

*Call graph*: called by 1 (new); 3 external calls (from_millis, builder, build_reqwest_client_with_custom_ca).


##### `ReqwestHttpClient::http_request`  (lines 66–83)

```
fn http_request(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<HttpRequestResponse, ExecServerError>>
```

**Purpose**: Implements buffered HTTP requests for the shared `HttpClient` trait using `reqwest`. It forces non-streaming mode and returns the full response body in one result.

**Data flow**: It takes `HttpRequestParams`, constructs a `ReqwestHttpRequestRunner` from `params.timeout_ms`, maps runner-construction and execution errors from JSON-RPC error objects into `ExecServerError::HttpRequest(error.message)`, calls `runner.run` with `stream_response: false`, discards the optional pending stream, and returns the `HttpRequestResponse`.

**Call relations**: Used wherever the local runtime should perform a complete HTTP request without streaming. It delegates validation and network I/O to `ReqwestHttpRequestRunner::new` and `run`.

*Call graph*: calls 1 internal fn (new).


##### `ReqwestHttpClient::http_request_stream`  (lines 85–110)

```
fn http_request_stream(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<(HttpRequestResponse, HttpResponseBodyStream), ExecServerError>>
```

**Purpose**: Implements streamed HTTP requests for the shared `HttpClient` trait using `reqwest`. It returns response metadata immediately plus a local body stream wrapper.

**Data flow**: It takes `HttpRequestParams`, constructs a `ReqwestHttpRequestRunner`, calls `runner.run` with `stream_response: true`, maps JSON-RPC-style errors into `ExecServerError::HttpRequest(error.message)`, requires that the returned pending stream is `Some`, and wraps `pending_stream.response` with `HttpResponseBodyStream::local`. If the pending stream is unexpectedly absent, it returns `ExecServerError::Protocol`.

**Call relations**: Used by local-runtime callers that want incremental body consumption. It depends on `ReqwestHttpRequestRunner::run` to split headers from the live response stream and on `HttpResponseBodyStream::local` to expose the shared stream API.

*Call graph*: calls 2 internal fn (local, new).


##### `ReqwestHttpRequestRunner::new`  (lines 114–118)

```
fn new(timeout_ms: Option<u64>) -> Result<Self, JSONRPCErrorError>
```

**Purpose**: Constructs a request runner with a ready-to-use `reqwest::Client`, converting client-construction failures into JSON-RPC internal errors suitable for server-side use. It is the bridge between transport-neutral request params and concrete HTTP execution.

**Data flow**: It takes `Option<u64>` timeout milliseconds, calls `ReqwestHttpClient::build_client(timeout_ms)`, maps any `ExecServerError` into `internal_error(error.to_string())`, and returns `ReqwestHttpRequestRunner { client }`.

**Call relations**: Called by both `ReqwestHttpClient` trait methods and by server-side HTTP request handling paths elsewhere in the crate. It centralizes client creation and error-shape conversion.

*Call graph*: calls 1 internal fn (build_client); called by 3 (http_request, http_request_stream, http_request).


##### `ReqwestHttpRequestRunner::run`  (lines 120–185)

```
async fn run(
        &self,
        params: HttpRequestParams,
    ) -> Result<(HttpRequestResponse, Option<PendingReqwestHttpBodyStream>), JSONRPCErrorError>
```

**Purpose**: Validates `http/request` parameters, performs the actual network request, and returns either a buffered response or a pending stream handle. It is the core execution routine for this module.

**Data flow**: It takes `HttpRequestParams`, parses `params.method` into a `reqwest::Method`, parses `params.url` into a `Url`, rejects any scheme other than `http` or `https`, builds request headers with `Self::build_headers`, constructs a request from the internal client, optionally attaches `params.body`, and awaits `request.send()`. Send failures are logged via `log_send_error` and returned as `internal_error("http/request failed: ...")`. On success it extracts status and response headers via `Self::response_headers`. If `params.stream_response` is true, it returns `HttpRequestResponse { status, headers, body: empty }` plus `Some(PendingReqwestHttpBodyStream { request_id: params.request_id, response })`; otherwise it awaits `response.bytes()`, converts body-read failures into `internal_error`, and returns the full body with `None` for the pending stream.

**Call relations**: This is the main worker used by both buffered and streaming trait methods. When streaming is requested, its `PendingReqwestHttpBodyStream` output is later consumed by `ReqwestHttpRequestRunner::stream_body` or wrapped locally by `HttpResponseBodyStream::local`.

*Call graph*: calls 3 internal fn (log_send_error, internal_error, invalid_params); 7 external calls (from_bytes, build_headers, response_headers, parse, new, request, format!).


##### `ReqwestHttpRequestRunner::stream_body`  (lines 187–244)

```
async fn stream_body(
        pending_stream: PendingReqwestHttpBodyStream,
        notifications: RpcNotificationSender,
    )
```

**Purpose**: Consumes a pending streamed `reqwest` response and forwards each chunk as JSON-RPC body-delta notifications. It is the producer side of remote streamed HTTP responses.

**Data flow**: It takes `PendingReqwestHttpBodyStream { request_id, response }` and an `RpcNotificationSender`, initializes `seq = 1`, then iterates `response.bytes_stream()`. Each successful chunk is sent with `done: false` and `error: None`; if `send_body_delta` returns false, the function stops early because the transport is gone. If reading a chunk fails, it sends one terminal delta with empty bytes, `done: true`, and `error: Some(error.to_string())`, then returns. On normal EOF it sends a final empty terminal delta with `done: true` and no error.

**Call relations**: Used by server-side code after `run` returns a pending stream for a remote caller. It delegates notification emission to `send_body_delta`, which abstracts the JSON-RPC notification transport.

*Call graph*: 2 external calls (new, send_body_delta).


##### `ReqwestHttpRequestRunner::build_headers`  (lines 246–261)

```
fn build_headers(headers: Vec<HttpHeader>) -> Result<HeaderMap, JSONRPCErrorError>
```

**Purpose**: Validates and converts protocol-level HTTP headers into a `reqwest`/`http` `HeaderMap`. It rejects malformed names and values before any request is sent.

**Data flow**: It takes `Vec<HttpHeader>`, creates an empty `HeaderMap`, then for each header parses `header.name` with `HeaderName::from_bytes` and `header.value` with `HeaderValue::from_str`. Parsed headers are appended to the map; any parse failure becomes `invalid_params(...)`. On success it returns the populated `HeaderMap`.

**Call relations**: Called by `ReqwestHttpRequestRunner::run` during request validation. It isolates header parsing and error wording from the rest of request execution.

*Call graph*: 3 external calls (new, from_bytes, from_str).


##### `ReqwestHttpRequestRunner::response_headers`  (lines 263–273)

```
fn response_headers(headers: &HeaderMap) -> Vec<HttpHeader>
```

**Purpose**: Converts response headers from `reqwest`’s `HeaderMap` into the protocol’s serializable `Vec<HttpHeader>`. It drops headers whose values are not valid UTF-8.

**Data flow**: It iterates over the provided `HeaderMap`, and for each `(name, value)` attempts `value.to_str()`. Successful pairs become `HttpHeader { name: name.as_str().to_string(), value: ... }`; invalid UTF-8 values are skipped via `filter_map`. The collected vector is returned.

**Call relations**: Called by `ReqwestHttpRequestRunner::run` after a successful send. It prepares response metadata for the protocol layer.

*Call graph*: 1 external calls (iter).


##### `log_send_error`  (lines 276–287)

```
fn log_send_error(method: &Method, error: reqwest::Error)
```

**Purpose**: Logs a failed `reqwest` send with sanitized and structured diagnostics. It intentionally removes the URL from the error before logging.

**Data flow**: It takes a `Method` and `reqwest::Error`, calls `without_url()` on the error, computes an optional source-chain string via `error_source_chain`, and emits a `tracing::warn!` record containing the HTTP method, timeout/connect flags, the sanitized error text, and the source chain.

**Call relations**: Called only by `ReqwestHttpRequestRunner::run` when `request.send()` fails. It exists purely for observability and does not affect returned error values beyond logging.

*Call graph*: calls 1 internal fn (error_source_chain); called by 1 (run); 2 external calls (without_url, warn!).


##### `error_source_chain`  (lines 289–297)

```
fn error_source_chain(error: &reqwest::Error) -> Option<String>
```

**Purpose**: Builds a colon-separated string of nested source errors from a `reqwest::Error`, if any exist. This gives logs more context without exposing the request URL.

**Data flow**: It starts from `error.source()`, walks the source chain collecting each `to_string()` into a vector, and returns `Some(joined_sources)` if the vector is non-empty or `None` otherwise.

**Call relations**: Used only by `log_send_error` to enrich warning logs for failed sends. It is a pure formatting helper.

*Call graph*: called by 1 (log_send_error); 3 external calls (new, source, to_string).


### `exec-server/src/client/rpc_http_client.rs`

`io_transport` · `orchestrator-side remote HTTP forwarding`

This small module adds HTTP capability methods directly onto `ExecServerClient` and implements the shared `HttpClient` trait for it. The non-streaming path is intentionally simple: `ExecServerClient::http_request` forces `stream_response = false` on the supplied `HttpRequestParams` and forwards the request through the generic RPC call path using `HTTP_REQUEST_METHOD`.

The streaming path is more careful because response headers and body arrive through different mechanisms. `ExecServerClient::http_request_stream` forces `stream_response = true`, replaces any caller-provided `request_id` with a connection-local id from `Inner::next_http_body_stream_request_id`, allocates an `mpsc` channel with `HTTP_BODY_DELTA_CHANNEL_CAPACITY`, and registers that sender in the client’s HTTP body routing table before issuing the RPC. A `HttpBodyStreamRegistration` guard protects against cancellation while the initial request is in flight: if the future is dropped before headers return, the route is removed automatically. If the RPC itself fails, the method explicitly removes the route, disarms the guard, and returns the error. On success it disarms the guard and returns the initial `HttpRequestResponse` plus a `HttpResponseBodyStream::remote` bound to the registered request id and receiver.

The trait impls are thin boxed-future adapters around these inherent methods so higher layers can depend on `HttpClient` without knowing whether requests are local or RPC-forwarded.

#### Function details

##### `ExecServerClient::http_request`  (lines 73–78)

```
fn http_request(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<HttpRequestResponse, ExecServerError>>
```

**Purpose**: Performs a buffered HTTP request by forwarding `http/request` over JSON-RPC to the remote runtime. It disables streaming so the full body is returned in the RPC response.

**Data flow**: It takes mutable `HttpRequestParams`, sets `params.stream_response = false`, calls `self.call(HTTP_REQUEST_METHOD, &params).await`, and returns `HttpRequestResponse` or `ExecServerError`.

**Call relations**: Used by callers treating `ExecServerClient` as an `HttpClient` for non-streaming requests. It delegates all transport/error handling to the generic `call` path.

*Call graph*: 1 external calls (http_request).


##### `ExecServerClient::http_request_stream`  (lines 82–87)

```
fn http_request_stream(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<(HttpRequestResponse, HttpResponseBodyStream), ExecServerError>>
```

**Purpose**: Performs a streamed HTTP request over JSON-RPC and returns a body stream reconstructed from later `http/request/bodyDelta` notifications. It is the orchestrator-side setup path for remote streaming.

**Data flow**: It takes mutable `HttpRequestParams`, sets `stream_response = true`, allocates a fresh connection-local `request_id` from `self.inner.next_http_body_stream_request_id()`, overwrites `params.request_id`, creates an `mpsc` channel, and registers the sender with `self.inner.insert_http_body_stream`. It then creates a `HttpBodyStreamRegistration` guard and issues `self.call(HTTP_REQUEST_METHOD, &params)`. On RPC error it removes the route, disarms the guard, and returns the error. On success it disarms the guard and returns the `HttpRequestResponse` plus `HttpResponseBodyStream::remote(Arc::clone(&self.inner), request_id, rx)`.

**Call relations**: Called by the `HttpClient` trait adapter for streamed requests. It depends on the HTTP body stream module’s registration guard and remote stream constructor, and later body deltas are routed by the main client notification dispatcher into the registered channel.

*Call graph*: calls 2 internal fn (new, remote); 3 external calls (clone, http_request_stream, channel).


### Streamable HTTP adaptation
These pieces adapt the shared HTTP capability into RMCP streamable HTTP semantics, including auth-aware error parsing and retry around initialization.

### `rmcp-client/src/http_client_adapter.rs`

`io_transport` · `HTTP request handling`

This module runs in the orchestrator and is the HTTP-side counterpart to the stdio transport adapter. `StreamableHttpClientAdapter` stores an `Arc<dyn HttpClient>`, a base `HeaderMap`, and an optional shared auth provider. Its three trait methods implement the MCP streamable HTTP contract. `post_message` is the most complex: it derives diagnostic fields from the outgoing `ClientJsonRpcMessage`, merges default and custom headers, injects auth headers from both the shared provider and an explicit bearer token, sets `Accept` to `text/event-stream, application/json`, sets `Content-Type: application/json`, optionally adds `mcp-session-id`, serializes the JSON-RPC body, and performs a streaming POST. The response path distinguishes session-expired 404s, 401 `WWW-Authenticate` challenges, 403 insufficient-scope Bearer challenges, accepted/no-content acknowledgements, retryable non-success statuses, JSON-RPC error bodies, SSE streams, plain JSON responses, and unexpected content types with truncated body previews.

`delete_session` and `get_stream` reuse the same header-building helpers but implement the narrower semantics of session deletion and SSE subscription. Supporting helpers normalize header insertion and conversion to executor `HttpHeader` values, extract case-insensitive response headers, classify success and retryable statuses, parse JSON-RPC error bodies, collect streamed response bodies into bytes, and wrap a chunked `HttpResponseBodyStream` as an `SseStream`. Logging is intentionally careful: `log_post_message_http_error` records URL components and MCP method/request-id metadata without dumping full payloads.

#### Function details

##### `StreamableHttpClientAdapter::new`  (lines 70–80)

```
fn new(
        http_client: Arc<dyn HttpClient>,
        default_headers: HeaderMap,
        auth_provider: Option<SharedAuthProvider>,
    ) -> Self
```

**Purpose**: Constructs the adapter from a shared HTTP client, default headers, and optional auth provider.

**Data flow**: It takes `Arc<dyn HttpClient>`, a `HeaderMap`, and `Option<SharedAuthProvider>`, stores them directly in a new `StreamableHttpClientAdapter`, and returns it.

**Call relations**: It is called by higher-level transport creation code before rmcp begins issuing streamable HTTP operations through this adapter.

*Call graph*: called by 2 (create_pending_transport, create_oauth_transport_and_runtime).


##### `StreamableHttpClientAdapter::post_message`  (lines 86–229)

```
async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: Ha
```

**Purpose**: Sends one MCP JSON-RPC message as an HTTP POST and interprets the server response as accepted, JSON, or SSE, with special handling for auth and retry semantics.

**Data flow**: It takes the target `uri`, a `ClientJsonRpcMessage`, optional `session_id`, optional explicit `auth_token`, and custom headers. It derives `(mcp_method, mcp_request_id)` via `client_jsonrpc_message_fields`, clones and extends default headers, calls `add_auth_headers`, inserts `Accept` and `Content-Type`, optionally inserts `Authorization` and `mcp-session-id`, serializes the message body, and calls `http_client.http_request_stream`. Transport-level request failures are logged through `log_post_message_http_error` and returned as `StreamableHttpError::Client`. For responses, it maps session-bound 404 to `SessionExpired404`, 401 with `WWW-Authenticate` to `AuthRequired`, 403 with a parsed insufficient-scope challenge to `InsufficientScope`, and 202/204 to `Accepted`. For other non-success statuses it collects the body with `collect_body`; if the status is not retryable for the current MCP method and the content type is JSON, it tries `parse_json_rpc_error` and may return `StreamableHttpPostResponse::Json`. Otherwise it returns `UnexpectedServerResponse` with a truncated `body_preview`. For successful responses it inspects `Content-Type`: event-stream becomes `Sse(sse_stream_from_body(...), session_id_header)`, JSON becomes a deserialized `ServerJsonRpcMessage`, and anything else becomes `UnexpectedContentType` with a body preview.

**Call relations**: This is the main outbound operation used by rmcp's streamable HTTP transport. It depends on most helper functions in the file and on `www_authenticate::insufficient_scope_challenge` for auth-specific error mapping.

*Call graph*: calls 12 internal fn (add_auth_headers, client_jsonrpc_message_fields, collect_body, insert_header, log_post_message_http_error, parse_json_rpc_error, protocol_headers, response_header, retryable_post_response_status, sse_stream_from_body (+2 more)); 16 external calls (new, clone, from_static, new, AuthRequired, Client, InsufficientScope, UnexpectedContentType, UnexpectedServerResponse, Json (+6 more)).


##### `StreamableHttpClientAdapter::delete_session`  (lines 231–280)

```
async fn delete_session(
        &self,
        uri: Arc<str>,
        session: Arc<str>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, reqwest::header::HeaderValue>,
```

**Purpose**: Issues the MCP session-deletion HTTP request and normalizes permissive server behaviors.

**Data flow**: It takes the endpoint `uri`, session id, optional explicit auth token, and custom headers; clones and extends default headers; calls `add_auth_headers`; optionally inserts `Authorization`; inserts `mcp-session-id`; performs a non-streaming `DELETE` via `http_client.http_request`; maps client errors into `StreamableHttpError::Client`; treats `405 Method Not Allowed` as success because some servers do not support deletion; rejects any other non-success status with `UnexpectedServerResponse`; and otherwise returns `Ok(())`.

**Call relations**: rmcp calls this during streamable HTTP session teardown. It shares header-building helpers with `post_message` and `get_stream` but has simpler response semantics.

*Call graph*: calls 4 internal fn (add_auth_headers, insert_header, protocol_headers, status_is_success); 4 external calls (clone, from_static, UnexpectedServerResponse, format!).


##### `StreamableHttpClientAdapter::get_stream`  (lines 282–367)

```
async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<Head
```

**Purpose**: Opens or resumes the server-sent-events stream for an existing MCP streamable HTTP session.

**Data flow**: It takes the endpoint `uri`, `session_id`, optional `last_event_id`, optional explicit auth token, and custom headers; clones and extends default headers; calls `add_auth_headers`; inserts `Accept`, `mcp-session-id`, optional `last-event-id`, and optional `Authorization`; performs a streaming `GET`; maps client errors into `StreamableHttpError::Client`; converts `405` into `ServerDoesNotSupportSse`, `404` into `SessionExpired404`, and other non-success statuses into `UnexpectedServerResponse`; then validates that `Content-Type` starts with either `text/event-stream` or `application/json` via `is_streamable_http_content_type`, returning `UnexpectedContentType` otherwise. On success it wraps the body stream with `sse_stream_from_body` and returns it.

**Call relations**: rmcp uses this when it needs the long-lived SSE channel for server-to-client messages. It shares header and status helpers with `post_message`.

*Call graph*: calls 7 internal fn (add_auth_headers, insert_header, is_streamable_http_content_type, protocol_headers, response_header, sse_stream_from_body, status_is_success); 6 external calls (clone, from_static, Client, UnexpectedContentType, UnexpectedServerResponse, format!).


##### `StreamableHttpClientAdapter::add_auth_headers`  (lines 371–375)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds default authorization headers supplied by the shared auth provider.

**Data flow**: It takes a mutable `HeaderMap`; if `self.auth_provider` is present, it extends the map with `auth_provider.to_auth_headers()`; otherwise it leaves the map unchanged.

**Call relations**: It is a shared helper used by `post_message`, `delete_session`, and `get_stream` before any per-request explicit bearer token is added.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 1 external calls (extend).


##### `body_preview`  (lines 378–393)

```
fn body_preview(body: impl Into<String>) -> String
```

**Purpose**: Produces a bounded-length string preview of a non-JSON response body for error messages.

**Data flow**: It converts the input into `String`, checks its byte length, and if it exceeds `NON_JSON_RESPONSE_BODY_PREVIEW_BYTES` truncates at the nearest valid UTF-8 boundary not past that limit, appending a `... (truncated N bytes)` suffix. It returns the resulting preview string.

**Call relations**: It is used by `post_message` when constructing `UnexpectedServerResponse` and `UnexpectedContentType` errors from arbitrary response bodies.

*Call graph*: 2 external calls (into, format!).


##### `client_jsonrpc_message_fields`  (lines 395–426)

```
fn client_jsonrpc_message_fields(
    message: &ClientJsonRpcMessage,
) -> (Option<String>, Option<String>)
```

**Purpose**: Extracts the MCP method name and/or request id from an outgoing client JSON-RPC message for diagnostics and retry classification.

**Data flow**: It pattern-matches `ClientJsonRpcMessage`: requests yield `(Some(method), Some(id))`; responses yield `(None, Some(id))`; notifications inspect the concrete `ClientNotification` variant and return its method with no id; errors yield `(None, optional id)`. It returns a pair of `Option<String>` values.

**Call relations**: It is called by `post_message` before the HTTP request is sent so failures and retry logic can be annotated with protocol-level context.

*Call graph*: called by 1 (post_message).


##### `log_post_message_http_error`  (lines 428–456)

```
fn log_post_message_http_error(
    uri: &str,
    mcp_method: Option<&str>,
    mcp_request_id: Option<&str>,
    has_session_id: bool,
    has_authorization_header: bool,
)
```

**Purpose**: Logs structured diagnostics when the underlying HTTP client fails before any HTTP response is received.

**Data flow**: It takes the target URI plus optional MCP method and request id and booleans indicating whether session and authorization headers were present. It parses the URI with `reqwest::Url::parse`, extracts scheme/host/path/query-presence when possible, and emits a `tracing::warn!` record containing those fields and the MCP metadata.

**Call relations**: It is called only from `post_message` when `http_request_stream` returns an error, providing observability without exposing full request bodies.

*Call graph*: called by 1 (post_message); 2 external calls (parse, warn!).


##### `insert_header`  (lines 458–471)

```
fn insert_header(
    headers: &mut HeaderMap,
    name: HeaderName,
    value: String,
    map_error: impl FnOnce(String) -> Error,
) -> std::result::Result<(), StreamableHttpError<Error>>
```

**Purpose**: Validates and inserts a string header value into a `HeaderMap`, mapping parse failures into the adapter's error type.

**Data flow**: It takes a mutable `HeaderMap`, a `HeaderName`, a string value, and an error-mapping closure. It parses the value into `HeaderValue::from_str`, converts parse failures into `StreamableHttpError::Client(map_error(...))`, inserts the header on success, and returns `Ok(())`.

**Call relations**: It is the common header-construction helper used by `post_message`, `delete_session`, and `get_stream` for both protocol-required and auth/session headers.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 2 external calls (insert, from_str).


##### `is_streamable_http_content_type`  (lines 473–480)

```
fn is_streamable_http_content_type(content_type: &str) -> bool
```

**Purpose**: Checks whether a response content type is one of the MIME prefixes accepted by MCP streamable HTTP.

**Data flow**: It compares the raw bytes of the input string against the prefixes `text/event-stream` and `application/json` and returns `true` if either matches.

**Call relations**: It is used by `get_stream` to validate the content type of the SSE endpoint response.

*Call graph*: called by 1 (get_stream).


##### `protocol_headers`  (lines 482–492)

```
fn protocol_headers(headers: &HeaderMap) -> Vec<HttpHeader>
```

**Purpose**: Converts a reqwest `HeaderMap` into the executor protocol's serializable `Vec<HttpHeader>` representation.

**Data flow**: It iterates over all headers, drops any whose value cannot be converted to UTF-8 text with `to_str()`, maps the rest into `HttpHeader { name, value }`, collects them into a vector, and returns it.

**Call relations**: It is used by all three HTTP operations before calling the shared `HttpClient`, which expects protocol-level header structs rather than reqwest types.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 1 external calls (iter).


##### `response_header`  (lines 494–500)

```
fn response_header(headers: &[HttpHeader], name: impl AsRef<str>) -> Option<String>
```

**Purpose**: Performs a case-insensitive lookup of a named header in an executor HTTP response.

**Data flow**: It takes a slice of `HttpHeader` and a header name, scans the slice for the first entry whose `name` matches case-insensitively, clones that header's value, and returns it as `Option<String>`.

**Call relations**: It is used by `post_message` and `get_stream` to inspect `Content-Type`, `WWW-Authenticate`, and `Mcp-Session-Id` response headers.

*Call graph*: called by 2 (get_stream, post_message); 2 external calls (as_ref, iter).


##### `status_is_success`  (lines 502–504)

```
fn status_is_success(status: u16) -> bool
```

**Purpose**: Determines whether a raw numeric HTTP status code is in the success class.

**Data flow**: It attempts to convert the `u16` into `reqwest::StatusCode` and returns `true` only if conversion succeeds and `status.is_success()` is true.

**Call relations**: It is a shared helper used by `post_message`, `delete_session`, and `get_stream` when deciding whether to treat a response as successful.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 1 external calls (from_u16).


##### `retryable_post_response_status`  (lines 506–515)

```
fn retryable_post_response_status(mcp_method: Option<&str>, status: u16) -> bool
```

**Purpose**: Restricts HTTP retryability to specific MCP methods and a fixed set of transient HTTP statuses.

**Data flow**: It converts the raw `u16` status into `StatusCode`; if conversion fails it returns `false`. Otherwise it returns true only when `is_retryable_http_status(status)` is true and `mcp_method` is one of `initialize`, `notifications/initialized`, or `tools/list`.

**Call relations**: It is used by `post_message` when deciding whether a non-success JSON response should still be interpreted as a JSON-RPC error body versus surfaced as an HTTP-layer failure.

*Call graph*: calls 1 internal fn (is_retryable_http_status); called by 1 (post_message); 2 external calls (from_u16, matches!).


##### `is_retryable_http_status`  (lines 517–527)

```
fn is_retryable_http_status(status: StatusCode) -> bool
```

**Purpose**: Defines the set of transient HTTP statuses considered retryable by the adapter.

**Data flow**: It matches the input `StatusCode` against `408`, `429`, `500`, `502`, `503`, and `504`, returning `true` for those and `false` otherwise.

**Call relations**: It is called only by `retryable_post_response_status` as the status-classification primitive.

*Call graph*: called by 1 (retryable_post_response_status); 1 external calls (matches!).


##### `parse_json_rpc_error`  (lines 529–534)

```
fn parse_json_rpc_error(body: &[u8]) -> Option<ServerJsonRpcMessage>
```

**Purpose**: Recognizes a response body as a JSON-RPC error message and rejects non-error JSON-RPC payloads.

**Data flow**: It attempts to deserialize the byte slice into `ServerJsonRpcMessage`; if the result is `JsonRpcMessage::Error(_)` it returns that message, otherwise it returns `None`.

**Call relations**: It is used by `post_message` on certain non-success HTTP responses so server-generated JSON-RPC errors can still be surfaced through the normal MCP path.

*Call graph*: called by 1 (post_message).


##### `collect_body`  (lines 536–549)

```
async fn collect_body(
    body_stream: &mut HttpResponseBodyStream,
) -> std::result::Result<Vec<u8>, StreamableHttpError<StreamableHttpClientAdapterError>>
```

**Purpose**: Consumes a streamed HTTP response body into a single byte vector.

**Data flow**: It takes a mutable `HttpResponseBodyStream`, repeatedly awaits `recv()`, maps stream errors into `StreamableHttpError::Client`, appends each received chunk to a `Vec<u8>`, and returns the accumulated bytes when the stream ends.

**Call relations**: It is used by `post_message` whenever the adapter needs the full body to parse JSON or include a preview in an error.

*Call graph*: calls 1 internal fn (recv); called by 1 (post_message); 1 external calls (new).


##### `sse_stream_from_body`  (lines 551–562)

```
fn sse_stream_from_body(
    body_stream: HttpResponseBodyStream,
) -> BoxStream<'static, std::result::Result<Sse, sse_stream::Error>>
```

**Purpose**: Wraps the executor's chunked body stream as a boxed SSE parser stream.

**Data flow**: It takes ownership of `HttpResponseBodyStream`, builds a byte stream with `stream::unfold` that repeatedly awaits `recv()` and yields `Bytes` chunks or `io::Error::other(error)`, passes that byte stream into `SseStream::from_byte_stream`, boxes the resulting stream, and returns it.

**Call relations**: It is used by both `post_message` and `get_stream` whenever a successful response body should be interpreted as server-sent events.

*Call graph*: called by 2 (get_stream, post_message); 2 external calls (from_byte_stream, unfold).


### `rmcp-client/src/http_client_adapter/www_authenticate.rs`

`util` · `HTTP response parsing`

This module implements a small HTTP-auth parser specialized for one case: Bearer challenges whose `error` parameter is `insufficient_scope`. The public entrypoint, `insufficient_scope_challenge`, scans all response headers for `WWW-Authenticate` fields, parses each field value, and returns the first matching challenge together with the original header text and an optional required scope. Parsing is intentionally stricter than a naive substring search. `split_unquoted_segments` tokenizes a header field on commas and semicolons while respecting quoted strings and backslash escapes; `parse_challenge_start` recognizes the start of a new auth challenge; `parse_auth_param` and `parse_auth_param_value` decode token or quoted-string parameter values using HTTP quoting rules rather than JSON rules.

State for a single Bearer challenge is accumulated in `BearerChallenge`, which tracks only the `error` and `scope` parameters using a three-state `Parameter` enum: `Missing`, `Value(String)`, or `Invalid`. Duplicate parameters, missing values, or malformed forms mark the parameter invalid. `into_insufficient_scope` succeeds only when `error` is exactly `insufficient_scope`; it then validates the optional scope string with `valid_scope`, which enforces RFC-style space-separated scope tokens containing only allowed visible ASCII ranges. This design deliberately ignores unrelated schemes and unrelated Bearer parameters while rejecting ambiguous scope encodings.

#### Function details

##### `BearerChallenge::add_parameter`  (lines 33–48)

```
fn add_parameter(&mut self, name: &str, value: Option<String>)
```

**Purpose**: Records a parsed `error` or `scope` parameter into the current Bearer challenge state while detecting duplicates and malformed values.

**Data flow**: It takes a parameter `name` and optional decoded `value`, selects either `self.error` or `self.scope` based on a case-insensitive name match, ignores all other parameter names, and updates the chosen `Parameter`: a first valid value becomes `Value`, while a missing value or any duplicate transitions the field to `Invalid`.

**Call relations**: It is used by `parse_bearer_insufficient_scope` as it walks challenge segments, accumulating only the Bearer parameters relevant to insufficient-scope detection.

*Call graph*: 1 external calls (Value).


##### `BearerChallenge::into_insufficient_scope`  (lines 50–62)

```
fn into_insufficient_scope(self) -> Option<BearerInsufficientScope>
```

**Purpose**: Converts accumulated Bearer challenge state into a parsed insufficient-scope result if and only if the challenge semantically matches that error.

**Data flow**: It consumes `self`. If `self.error` is `Value("insufficient_scope")`, it inspects `self.scope`: a valid scope string per `valid_scope` becomes `Some(scope)`, while missing, invalid, or syntactically unacceptable scope values become `None`. Any other `error` state returns `None`.

**Call relations**: It is called by `parse_bearer_insufficient_scope` when a Bearer challenge ends or at end-of-header to decide whether the accumulated parameters represent the target condition.

*Call graph*: calls 1 internal fn (valid_scope).


##### `insufficient_scope_challenge`  (lines 67–81)

```
fn insufficient_scope_challenge(
    headers: &[HttpHeader],
) -> Option<InsufficientScopeChallenge>
```

**Purpose**: Finds the first Bearer insufficient-scope challenge across all `WWW-Authenticate` response headers.

**Data flow**: It iterates over the provided `HttpHeader` slice, filters to headers whose name matches `WWW-Authenticate` case-insensitively, parses each header value with `parse_bearer_insufficient_scope`, and on the first match returns `InsufficientScopeChallenge { www_authenticate_header: original_value, required_scope }`.

**Call relations**: It is called by `StreamableHttpClientAdapter::post_message` when handling HTTP 403 responses so the adapter can raise a structured `InsufficientScopeError`.

*Call graph*: called by 1 (post_message); 1 external calls (iter).


##### `parse_bearer_insufficient_scope`  (lines 98–128)

```
fn parse_bearer_insufficient_scope(header: &str) -> Option<BearerInsufficientScope>
```

**Purpose**: Parses one `WWW-Authenticate` field value and extracts a Bearer insufficient-scope challenge if present.

**Data flow**: It splits the header into unquoted segments with `split_unquoted_segments`, then iterates segment by segment. Segments that parse as auth parameters are added to the current Bearer challenge, if any. A segment that starts a new challenge first finalizes any existing Bearer challenge via `into_insufficient_scope`; then `parse_challenge_start` identifies the new scheme and optional first parameter. If the scheme is `Bearer`, it starts a fresh default `BearerChallenge` and records that first parameter if present. After all segments, it finalizes the last Bearer challenge and returns the parsed `BearerInsufficientScope` or `None`.

**Call relations**: It is the core parser used by `insufficient_scope_challenge` and is also exercised directly by the unit tests.

*Call graph*: calls 3 internal fn (parse_auth_param, parse_challenge_start, split_unquoted_segments); 1 external calls (default).


##### `parse_challenge_start`  (lines 130–142)

```
fn parse_challenge_start(segment: &str) -> Option<ChallengeStart<'_>>
```

**Purpose**: Recognizes the beginning of an HTTP auth challenge and optionally parses its first parameter.

**Data flow**: It trims the segment, finds the first whitespace boundary, splits the segment into `scheme` and trailing parameter text when present, parses that trailing text with `parse_auth_param`, validates that `scheme` is an HTTP token via `is_http_token`, and returns `(scheme, optional_parameter)` or `None`.

**Call relations**: It is called by `parse_bearer_insufficient_scope` whenever a segment is not itself an auth parameter, allowing the parser to detect transitions between auth schemes.

*Call graph*: calls 2 internal fn (is_http_token, parse_auth_param); called by 1 (parse_bearer_insufficient_scope).


##### `parse_auth_param`  (lines 144–148)

```
fn parse_auth_param(segment: &str) -> Option<AuthParameter<'_>>
```

**Purpose**: Parses a single `name=value` auth parameter from a segment.

**Data flow**: It trims the segment, splits once on `=`, trims the parameter name, validates the name with `is_http_token`, parses the value with `parse_auth_param_value`, and returns `(name, Option<String>)` or `None` if the segment is not a syntactically valid auth parameter.

**Call relations**: It is used both by `parse_bearer_insufficient_scope` for ordinary parameter segments and by `parse_challenge_start` for a challenge's inline first parameter.

*Call graph*: calls 2 internal fn (is_http_token, parse_auth_param_value); called by 2 (parse_bearer_insufficient_scope, parse_challenge_start).


##### `parse_auth_param_value`  (lines 150–166)

```
fn parse_auth_param_value(value: &str) -> Option<String>
```

**Purpose**: Decodes an auth parameter value as either an HTTP token or a quoted-string with backslash unescaping.

**Data flow**: If the value starts with `"`, it requires a matching trailing `"`, iterates the interior characters, replaces each backslash escape with the escaped character, and returns the decoded string or `None` on malformed escaping. Otherwise it validates the raw value as an HTTP token with `is_http_token` and returns it as `Some(String)` or `None`.

**Call relations**: It is called by `parse_auth_param` and provides the HTTP-specific quoted-string decoding needed for accurate scope extraction.

*Call graph*: calls 1 internal fn (is_http_token); called by 1 (parse_auth_param); 1 external calls (with_capacity).


##### `split_unquoted_segments`  (lines 168–196)

```
fn split_unquoted_segments(header: &str) -> Option<Vec<&str>>
```

**Purpose**: Splits a `WWW-Authenticate` field value into challenge/parameter segments on commas and semicolons while respecting quoted strings.

**Data flow**: It iterates through `header.char_indices()`, tracking whether parsing is currently inside quotes and whether the previous character was an escape. Unquoted `,` and `;` delimit segments, which are sliced from the original string and pushed into a `Vec<&str>`. If parsing ends while still in quotes or after a dangling escape, it returns `None`; otherwise it returns the collected segments.

**Call relations**: It is the first parsing step in `parse_bearer_insufficient_scope`, enabling later challenge and parameter parsing without being confused by commas or semicolons inside quoted strings.

*Call graph*: called by 1 (parse_bearer_insufficient_scope); 1 external calls (new).


##### `valid_scope`  (lines 198–205)

```
fn valid_scope(scope: &str) -> bool
```

**Purpose**: Validates that a decoded Bearer scope string is a space-separated list of non-empty tokens using only allowed visible ASCII characters.

**Data flow**: It splits the scope string on spaces and returns true only if every token is non-empty and every byte falls in the allowed ranges `!`, `#` through `[`, or `]` through `~`.

**Call relations**: It is used by `BearerChallenge::into_insufficient_scope` to decide whether a parsed `scope` parameter can be surfaced as a required scope or must be treated as invalid/ambiguous.

*Call graph*: called by 1 (into_insufficient_scope).


##### `is_http_token`  (lines 207–229)

```
fn is_http_token(value: &str) -> bool
```

**Purpose**: Checks whether a string is a valid HTTP token per the restricted character set used for auth schemes and token-valued parameters.

**Data flow**: It returns false for empty strings; otherwise it verifies that every byte is ASCII alphanumeric or one of the allowed punctuation characters defined in the function's match expression.

**Call relations**: It is the low-level syntax predicate used by `parse_challenge_start`, `parse_auth_param`, and `parse_auth_param_value`.

*Call graph*: called by 3 (parse_auth_param, parse_auth_param_value, parse_challenge_start).


### `rmcp-client/src/streamable_http_retry.rs`

`util` · `initialize handshake and transient retry handling`

This file isolates retry behavior for streamable HTTP transports. The central method, `RmcpClient::connect_pending_transport_with_initialize_retries`, wraps the normal handshake path with bounded retries when the transport is HTTP-based. It distinguishes retryable transports (`StreamableHttp` and `StreamableHttpWithOAuth`) from non-retryable ones (`InProcess`, `Stdio`), shares one absolute deadline across all attempts, recreates the transport between retries when needed, and uses the fixed backoff schedule in `STREAMABLE_HTTP_RETRY_DELAYS_MS`.

Retry classification is layered. `is_retryable_initialize_error` walks the `anyhow::Error` chain looking for either the local `HandshakeError` wrapper or rmcp's `ClientInitializeError`. `is_retryable_client_initialize_error` then narrows retryability to transport errors occurring while sending the initialize request or initialized notification; for the latter it also treats `TransportChannelClosed` as transient. The deepest classifier, `is_retryable_streamable_http_error`, recognizes network/request failures surfaced through `ExecServerError`, selected protocol/body-stream failures, and retryable HTTP status codes embedded in `UnexpectedServerResponse` strings. It explicitly excludes auth-required, insufficient-scope, session-expired, content-type, deserialization, and header-construction failures.

The remaining helpers are deadline utilities. `remaining_initialize_timeout` computes the remaining handshake budget and turns exhaustion into the standard timeout error message produced by `initialize_timeout_error`. `sleep_with_retry_deadline` performs backoff sleeps that abort early if the overall deadline has already expired. `HandshakeError` wraps rmcp's `ClientInitializeError` so higher layers can preserve handshake context while still participating in retry classification.

#### Function details

##### `RmcpClient::connect_pending_transport_with_initialize_retries`  (lines 26–99)

```
async fn connect_pending_transport_with_initialize_retries(
        &self,
        initial_transport: PendingTransport,
        client_service: ElicitationClientService,
        timeout: Option<Durati
```

**Purpose**: Performs MCP initialization handshake with bounded retries for streamable HTTP transports, recreating the transport between attempts when necessary. It enforces one overall timeout budget across transport creation, handshake attempts, and retry delays.

**Data flow**: Takes an initial `PendingTransport`, `ElicitationClientService`, and optional timeout → determines whether retries are allowed from the transport variant, computes an absolute retry deadline, and iterates over configured retry delays plus a final terminal attempt; each iteration either reuses the initial transport or recreates one with `Self::create_pending_transport(&self.transport_recipe)` under the remaining timeout, computes the remaining handshake timeout with `remaining_initialize_timeout`, calls `Self::connect_pending_transport(transport, client_service.clone(), attempt_timeout)`, and on retryable failure logs a warning and sleeps with `sleep_with_retry_deadline`; returns the first successful `(RunningService, Option<OAuthPersistor>)` or the final error/timeout.

**Call relations**: Called by `RmcpClient::initialize` and by session recovery in `reinitialize_after_session_expiry`. It delegates actual handshake execution to `connect_pending_transport` and retry classification to `is_retryable_initialize_error`.

*Call graph*: calls 2 internal fn (remaining_initialize_timeout, sleep_with_retry_deadline); 10 external calls (from_millis, connect_pending_transport, create_pending_transport, is_retryable_initialize_error, anyhow!, clone, once, timeout, unreachable!, warn!).


##### `RmcpClient::is_retryable_initialize_error`  (lines 101–110)

```
fn is_retryable_initialize_error(error: &anyhow::Error) -> bool
```

**Purpose**: Determines whether an initialization failure should be retried by scanning the error chain for retryable rmcp client-initialize errors. It understands both direct rmcp errors and the local handshake wrapper.

**Data flow**: Takes `&anyhow::Error`, iterates `error.chain()`, and returns true if any source downcasts to `HandshakeError` whose `source` is retryable via `is_retryable_client_initialize_error`, or directly downcasts to `rmcp::service::ClientInitializeError` that is retryable.

**Call relations**: Used only by `connect_pending_transport_with_initialize_retries` after a failed handshake attempt.

*Call graph*: 1 external calls (chain).


##### `RmcpClient::is_retryable_client_initialize_error`  (lines 112–135)

```
fn is_retryable_client_initialize_error(error: &rmcp::service::ClientInitializeError) -> bool
```

**Purpose**: Classifies rmcp client-initialize errors by handshake phase and underlying transport error. Only selected transport-send failures during initialize request or initialized notification are considered transient.

**Data flow**: Matches `rmcp::service::ClientInitializeError` → for `TransportError` with context `send initialize request`, downcasts the dynamic transport error to `StreamableHttpError<StreamableHttpClientAdapterError>` and delegates to `is_retryable_streamable_http_error`; for context `send initialized notification`, also treats `StreamableHttpError::TransportChannelClosed` as retryable in addition to the delegated classifier; all other variants return false.

**Call relations**: Called by `is_retryable_initialize_error` and directly by retry tests.


##### `RmcpClient::is_retryable_streamable_http_error`  (lines 137–165)

```
fn is_retryable_streamable_http_error(
        error: &StreamableHttpError<StreamableHttpClientAdapterError>,
    ) -> bool
```

**Purpose**: Recognizes streamable HTTP transport errors that are likely transient and worth retrying. It intentionally excludes authentication, protocol-shape, and session-expiry failures that require different handling.

**Data flow**: Matches `StreamableHttpError<StreamableHttpClientAdapterError>` → returns true for client-side `ExecServerError::HttpRequest(_)`, JSON-RPC internal errors whose message starts with `http/request failed:`, protocol errors whose message indicates a failed HTTP response stream, and `UnexpectedServerResponse` messages whose embedded HTTP status is retryable via `is_retryable_unexpected_server_response`; returns false for auth-required, insufficient-scope, session-expired, unexpected content type, unsupported SSE, deserialize errors, synthetic `SessionExpired404`, header errors, and all other unmatched variants.

**Call relations**: Used by both initialize retry classification in this file and operation retry classification in `RmcpClient::is_retryable_tools_list_error`.

*Call graph*: calls 1 internal fn (is_retryable_unexpected_server_response).


##### `is_retryable_unexpected_server_response`  (lines 168–183)

```
fn is_retryable_unexpected_server_response(message: &str) -> bool
```

**Purpose**: Parses `UnexpectedServerResponse` strings of the form `HTTP <status>: ...` and decides whether the embedded HTTP status code is retryable.

**Data flow**: Strips the `HTTP ` prefix from `message`, collects leading ASCII digits into a status-code string, parses it as `u16`, converts it to `StatusCode`, and delegates to `is_retryable_http_status`; any parse failure returns false.

**Call relations**: Used only by `RmcpClient::is_retryable_streamable_http_error` for the `UnexpectedServerResponse` branch.

*Call graph*: calls 1 internal fn (is_retryable_http_status); called by 1 (is_retryable_streamable_http_error); 1 external calls (from_u16).


##### `is_retryable_http_status`  (lines 185–195)

```
fn is_retryable_http_status(status: StatusCode) -> bool
```

**Purpose**: Defines the set of HTTP status codes treated as transient for retry purposes.

**Data flow**: Matches the input `StatusCode` against `408 Request Timeout`, `429 Too Many Requests`, `500 Internal Server Error`, `502 Bad Gateway`, `503 Service Unavailable`, and `504 Gateway Timeout` → returns `bool`.

**Call relations**: Called by `is_retryable_unexpected_server_response`.

*Call graph*: called by 1 (is_retryable_unexpected_server_response); 1 external calls (matches!).


##### `remaining_initialize_timeout`  (lines 197–210)

```
fn remaining_initialize_timeout(
    timeout: Option<Duration>,
    deadline: Option<Instant>,
) -> Result<Option<Duration>>
```

**Purpose**: Computes the remaining handshake timeout budget relative to an absolute deadline. It converts an exhausted deadline into the standard initialize-timeout error.

**Data flow**: Takes the original optional timeout and optional deadline → if no deadline, returns `Ok(None)`; otherwise computes `deadline - now`, returning `Err(initialize_timeout_error(...))` when zero and `Ok(Some(remaining))` otherwise.

**Call relations**: Used by `connect_pending_transport_with_initialize_retries` before transport recreation and before each handshake attempt.

*Call graph*: calls 1 internal fn (initialize_timeout_error); called by 1 (connect_pending_transport_with_initialize_retries); 1 external calls (now).


##### `initialize_timeout_error`  (lines 212–215)

```
fn initialize_timeout_error(timeout: Option<Duration>, fallback: Duration) -> anyhow::Error
```

**Purpose**: Builds the canonical timeout error message for MCP handshake expiration. It prefers the original configured timeout when available.

**Data flow**: Takes optional original timeout and a fallback duration → chooses `timeout.unwrap_or(fallback)` and formats `anyhow!("timed out handshaking with MCP server after {duration:?}")`.

**Call relations**: Used by `remaining_initialize_timeout` and by the retry loop when a backoff sleep would exceed the deadline.

*Call graph*: called by 1 (remaining_initialize_timeout); 1 external calls (anyhow!).


##### `sleep_with_retry_deadline`  (lines 217–228)

```
async fn sleep_with_retry_deadline(delay: Duration, deadline: Option<Instant>) -> bool
```

**Purpose**: Sleeps for a retry backoff delay without exceeding the overall retry deadline. It reports whether the sleep completed before the deadline expired.

**Data flow**: Takes a `delay` and optional absolute `deadline` → if a deadline exists, computes remaining time and returns false immediately if exhausted, otherwise wraps `time::sleep(delay)` in `time::timeout(remaining, ...)` and returns whether it completed; if no deadline exists, simply sleeps and returns true.

**Call relations**: Used by both initialization retries in this file and operation retries in `RmcpClient::run_service_operation_with_transient_retries`.

*Call graph*: called by 2 (run_service_operation_with_transient_retries, connect_pending_transport_with_initialize_retries); 3 external calls (now, sleep, timeout).
