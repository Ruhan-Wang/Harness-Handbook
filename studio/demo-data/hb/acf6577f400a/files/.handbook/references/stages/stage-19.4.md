# MCP and executor-backed transport adapters  `stage-19.4`

This stage is shared transport support for MCP, the Model Context Protocol, which is how the client talks to tool servers. It sits underneath the main client flow and turns high-level MCP messages into the actual ways bytes move: memory, process pipes, or HTTP. The crate front door, lib.rs, exposes the pieces other code should use. in_process_transport.rs creates a local, in-memory link to a server running in the same program, like connecting two parts with a short internal wire. executor_process_transport.rs connects to a separate server process managed by the executor, translating structured JSON-RPC messages into newline-based stdin and stdout traffic. For HTTP, reqwest_http_client.rs sends real network requests, while rpc_http_client.rs lets another runtime send them remotely, including streamed bodies. http_client_adapter.rs maps RMCP’s streamable HTTP protocol onto that shared HTTP interface. www_authenticate.rs reads authentication failure headers to detect missing permission scopes. streamable_http_retry.rs makes startup over streamable HTTP sturdier by retrying short-lived handshake failures.

## Files in this stage

### Client library surface
The crate root exposes the RMCP client API and the transport abstractions that higher-level consumers build on.

### `rmcp-client/src/lib.rs`

`other` · `cross-cutting public API surface`

This file does not contain the client logic itself. Instead, it is like the index page of a small library: it says which internal chapters exist, and which names are available to readers outside the crate. The `mod` lines pull in private source files for things like OAuth login, HTTP transport, launching local stdio servers, in-process transport, logging, and the main `RmcpClient`. The `pub use` lines then expose selected items as the crate’s public interface.

This matters because callers should not need to know the crate’s internal folder layout. They can import important pieces, such as `RmcpClient`, OAuth token helpers, authentication-status checks, or server launcher types, directly from `rmcp-client`. Without this file, users would either be unable to reach those items or would have to depend on internal module paths that are harder to understand and easier to break.

A few exports are deliberately kept narrower. For example, `load_oauth_tokens` is marked `pub(crate)`, meaning only code inside this crate can use it. That keeps sensitive or low-level behavior from becoming part of the public promise, while still letting the crate’s own modules share it.


### `rmcp-client/src/in_process_transport.rs`

`io_transport` · `connection setup and reconnect`

This file is about local, in-process communication. Instead of connecting to a server over a network socket or launching a separate program, the client can talk to a server through a pair of connected in-memory byte streams. A useful analogy is a short pipe inside the same machine: one end is handed to the client, and the other end is used by the server.

The main piece is the `InProcessTransportFactory` trait. A trait is a shared promise: any type that implements it must provide an `open` operation. That operation creates a fresh `DuplexStream`, which is Tokio’s in-memory stream that can both read and write bytes. It returns the stream asynchronously, because starting the paired server side may take time or may fail.

This matters because `RmcpClient` can keep one of these factories and use it whenever it needs to rebuild its connection. Without this abstraction, the client would have to know the details of every built-in server it might connect to. Instead, the factory hides those details: the client simply asks for a new stream, and the implementation is responsible for starting the server side first and then returning the client side.


### Executor-backed stdio transport
This transport bridges RMCP message flow onto an executor-managed child process using stdio streams.

### `rmcp-client/src/executor_process_transport.rs`

`io_transport` · `active while an executor-managed MCP stdio server is running`

This file is the bridge between two worlds. On one side, RMCP wants to send and receive structured JSON-RPC messages. JSON-RPC is a standard way for programs to call each other using JSON text. On the other side, an MCP server process speaks over standard input and standard output, like a command-line tool: one JSON message per line.

The transport in this file adds the missing plumbing. When RMCP sends a message, `ExecutorProcessTransport` turns it into JSON bytes, adds a newline, and asks the executor to write those bytes to the server process. When the server prints output, the executor pushes raw byte chunks back. The transport collects those chunks until it has a full line, parses that line back into an RMCP message, and returns it to RMCP.

A small `LineBuffer` works like a notepad for half-finished lines. If only part of a message has arrived, it waits for more bytes instead of guessing. Stderr is kept separate on purpose: it is logged for humans, not treated as protocol data. The file also protects against missed process events by using sequence numbers and recovering output from the executor when the event stream lags. Without this file, remote or executor-managed stdio MCP servers could not reliably speak to the RMCP client.

#### Function details

##### `LineBuffer::extend_from_slice`  (lines 59–61)

```
fn extend_from_slice(&mut self, bytes: &[u8])
```

**Purpose**: Adds newly received bytes to the end of the buffer. This is used when process output arrives in chunks that may not line up with whole text lines.

**Data flow**: It receives a slice of bytes. It appends those bytes to the buffer's existing bytes, leaving any previous partial line in place. It returns nothing, but the buffer now contains more data for later line extraction.

**Call relations**: Process output and stderr logging both feed new bytes into a `LineBuffer` through this function. Later, `take_line` or `take_remaining` reads back complete or leftover text from the same buffer.

*Call graph*: 1 external calls (extend_from_slice).


##### `LineBuffer::take_line`  (lines 63–74)

```
fn take_line(&mut self) -> Option<BytesMut>
```

**Purpose**: Pulls one complete newline-ended line out of the buffer, if one is available. It avoids repeatedly scanning bytes it has already checked.

**Data flow**: It looks at the buffered bytes starting after the part already known to contain no newline. If it finds a newline, it removes and returns everything before that newline, not including the newline itself. If no newline is found, it remembers that all current bytes were checked and returns nothing.

**Call relations**: This is the core line-splitting helper used by stdout parsing and stderr logging. `take_stdout_message` uses it to find full JSON-RPC messages, and `push_stderr` uses it to log stderr one line at a time.

*Call graph*: 3 external calls (len, split_to, memchr).


##### `LineBuffer::take_remaining`  (lines 76–83)

```
fn take_remaining(&mut self) -> Option<BytesMut>
```

**Purpose**: Takes whatever bytes are still buffered, even if they do not end with a newline. This is useful at the end of a process, when no more bytes will arrive.

**Data flow**: It checks whether the buffer is empty. If it is empty, it returns nothing. If there is leftover data, it clears the buffer and returns all remaining bytes as one chunk.

**Call relations**: When the process has closed, `take_stdout_message` uses this to accept a final unterminated JSON message. `flush_stderr` also uses it so the last partial stderr line is still logged.

*Call graph*: 2 external calls (is_empty, split).


##### `ExecutorProcessTransport::new`  (lines 135–151)

```
fn new(process: Arc<dyn ExecProcess>, program_name: String) -> Self
```

**Purpose**: Creates a new transport around an already-started executor process. It subscribes to that process's event stream immediately so early output is not missed.

**Data flow**: It receives a process handle and a human-readable program name. It asks the process for an event subscription, initializes empty stdout and stderr buffers, marks the transport as open and not yet terminated, and returns the ready transport.

**Call relations**: `launch_server` calls this after starting the MCP server process. From then on, RMCP uses the returned transport to send messages, receive messages, and close the server connection.

*Call graph*: called by 1 (launch_server); 1 external calls (default).


##### `ExecutorProcessTransport::next_process_id`  (lines 153–159)

```
fn next_process_id() -> ProcessId
```

**Purpose**: Creates a unique logical process id for a new MCP stdio server in the current executor session. This id is not an operating system process id; it is a client-side label used by the executor API.

**Data flow**: It reads and increments a shared counter. It turns the next number into a string like `mcp-stdio-1`, wraps that string as a `ProcessId`, and returns it.

**Call relations**: `launch_server` calls this before starting a new executor-managed MCP process. The generated id helps the executor distinguish multiple MCP server processes started during the same session.

*Call graph*: calls 1 internal fn (from); called by 1 (launch_server); 1 external calls (format!).


##### `ExecutorProcessTransport::send`  (lines 165–190)

```
fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleClient>,
    ) -> impl Future<Output = std::result::Result<(), Self::Error>> + Send + 'static
```

**Purpose**: Sends one RMCP JSON-RPC message to the server process through stdin. It converts the structured message into newline-delimited JSON, which is the format stdio MCP servers expect.

**Data flow**: It receives a JSON-RPC message from RMCP. Inside the returned asynchronous task, it serializes the message to JSON bytes, appends a newline, and asks the executor process to write those bytes. It returns success if the executor accepts the write, or an input/output error if the process is gone, stdin is closed, or the process is not ready yet.

**Call relations**: RMCP calls this whenever it needs to send a request, response, or notification to the MCP server. The function hands the actual byte writing off to the executor process handle.

*Call graph*: 3 external calls (clone, new, to_vec).


##### `ExecutorProcessTransport::receive`  (lines 192–194)

```
fn receive(&mut self) -> impl Future<Output = Option<RxJsonRpcMessage<RoleClient>>> + Send
```

**Purpose**: Starts receiving the next JSON-RPC message from the server process. It presents the lower-level process event stream as RMCP's normal incoming-message stream.

**Data flow**: It takes the current transport state and returns an asynchronous operation. That operation waits until a complete stdout message can be decoded, or returns nothing when the stream has ended.

**Call relations**: RMCP calls this when it wants the next inbound message. This method delegates the real waiting, buffering, and parsing work to `receive_message`.

*Call graph*: calls 1 internal fn (receive_message).


##### `ExecutorProcessTransport::close`  (lines 196–200)

```
async fn close(&mut self) -> std::result::Result<(), Self::Error>
```

**Purpose**: Closes the transport by asking the executor to terminate the MCP server process. It records that termination was requested so the drop cleanup does not repeat it unnecessarily.

**Data flow**: It uses the stored process handle to send a terminate request to the executor. If that succeeds, it marks the transport as terminated and returns success. If the executor reports an error, it turns that into an input/output error.

**Call relations**: RMCP calls this when it is done with the transport. It is the explicit, orderly shutdown path; the `drop` method exists as a backup if this close path was not used.


##### `ExecutorProcessTransport::receive_message`  (lines 204–258)

```
async fn receive_message(&mut self) -> Option<RxJsonRpcMessage<RoleClient>>
```

**Purpose**: Waits for and returns the next valid JSON-RPC message from the server's stdout. It also watches process lifecycle events and logs stderr output for diagnostics.

**Data flow**: It first checks whether the stdout buffer already contains a complete message. If not, it waits for the next executor event. Output events add bytes to stdout or stderr buffers. Exit and close events update the stream state. If the event stream falls behind, it tries to recover missed output. It returns a parsed message when one is available, or returns nothing once the process is closed and buffered data has been drained.

**Call relations**: `receive` calls this as the main receive loop. It coordinates helpers such as `take_stdout_message`, `push_process_output_if_new`, `recover_lagged_events`, `note_seq`, and `flush_stderr` to turn raw process events into RMCP messages.

*Call graph*: calls 6 internal fn (recv, flush_stderr, note_seq, push_process_output_if_new, recover_lagged_events, take_stdout_message); called by 1 (receive); 1 external calls (warn!).


##### `ExecutorProcessTransport::note_seq`  (lines 260–262)

```
fn note_seq(&mut self, seq: u64)
```

**Purpose**: Remembers the highest process event sequence number seen so far. Sequence numbers are ordered event labels that help detect old or missed output.

**Data flow**: It receives a sequence number from an executor event. It compares it with the stored highest sequence and keeps the larger value. It returns nothing, but updates the transport's recovery cursor.

**Call relations**: `receive_message` calls this for lifecycle events such as exit and close. The stored value is later used by lag recovery so the transport knows where to resume reading retained output.

*Call graph*: called by 1 (receive_message).


##### `ExecutorProcessTransport::should_accept_seq`  (lines 264–270)

```
fn should_accept_seq(&mut self, seq: u64) -> bool
```

**Purpose**: Decides whether an output chunk is new enough to process. This prevents duplicate output from being buffered when normal pushed events and recovery reads overlap.

**Data flow**: It receives an output chunk's sequence number. If the number is not greater than the last one already seen, it returns false. If it is newer, it records that number as the latest seen and returns true.

**Call relations**: `push_process_output_if_new` calls this before accepting any output chunk. This keeps the receive path safe when `recover_lagged_events` replays chunks that might also have arrived through the live event stream.

*Call graph*: called by 1 (push_process_output_if_new).


##### `ExecutorProcessTransport::recover_lagged_events`  (lines 272–296)

```
async fn recover_lagged_events(&mut self) -> io::Result<()>
```

**Purpose**: Recovers process output when the pushed event stream has fallen behind. This is a safety net so the client does not silently lose server messages during a burst of output.

**Data flow**: It asks the executor to read retained process output starting after the last sequence number already seen. It feeds each returned chunk through the normal output path, updates the last known sequence, and marks the transport closed if the retained read says the process failed or closed. It returns success or an input/output error if the recovery read itself fails.

**Call relations**: `receive_message` calls this when the broadcast event receiver reports that events were skipped. Recovered chunks go through `push_process_output_if_new`, so they are deduplicated before entering the stdout or stderr buffers.

*Call graph*: calls 1 internal fn (push_process_output_if_new); called by 1 (receive_message); 1 external calls (warn!).


##### `ExecutorProcessTransport::push_process_output_if_new`  (lines 298–303)

```
fn push_process_output_if_new(&mut self, chunk: ProcessOutputChunk)
```

**Purpose**: Adds a process output chunk only if it has not already been seen. It is the guard between the executor's event ordering and the transport's byte buffers.

**Data flow**: It receives a process output chunk containing a stream name, bytes, and a sequence number. It checks the sequence number. If the chunk is old or duplicate, it does nothing; if it is new, it passes the chunk on for buffering or logging.

**Call relations**: `receive_message` uses this for live output events, and `recover_lagged_events` uses it for recovered retained output. It calls `push_process_output` only after `should_accept_seq` approves the chunk.

*Call graph*: calls 2 internal fn (push_process_output, should_accept_seq); called by 2 (receive_message, recover_lagged_events).


##### `ExecutorProcessTransport::push_process_output`  (lines 305–320)

```
fn push_process_output(&mut self, chunk: ProcessOutputChunk)
```

**Purpose**: Routes raw process bytes to the right place. Stdout is treated as the MCP protocol stream, while stderr is kept separate and logged for humans.

**Data flow**: It receives a process output chunk and extracts its bytes. If the chunk came from stdout or a pseudo-terminal stream, it appends those bytes to the stdout line buffer. If it came from stderr, it sends the bytes to the stderr logging buffer.

**Call relations**: `push_process_output_if_new` calls this after deduplication. It feeds stdout bytes toward `take_stdout_message` and stderr bytes toward `push_stderr`.

*Call graph*: calls 2 internal fn (extend_from_slice, push_stderr); called by 1 (push_process_output_if_new).


##### `ExecutorProcessTransport::take_stdout_message`  (lines 322–344)

```
fn take_stdout_message(&mut self, allow_partial: bool) -> Option<RxJsonRpcMessage<RoleClient>>
```

**Purpose**: Turns buffered stdout text into one parsed RMCP message. It understands the MCP stdio rule that each JSON-RPC message normally ends at a newline.

**Data flow**: It tries to take one full line from the stdout buffer. If the process is already closed and there is no newline, it may take the remaining bytes as a final message. It removes a trailing carriage return if present, parses the line as a JSON-RPC message, and returns the first line that parses successfully. Bad lines are logged at debug level and skipped.

**Call relations**: `receive_message` calls this before waiting for more events and again after closure with partial-line support. It relies on `LineBuffer` for line extraction and on `trim_trailing_carriage_return` to tolerate Windows-style line endings.

*Call graph*: calls 1 internal fn (take_line); called by 1 (receive_message); 3 external calls (trim_trailing_carriage_return, debug!, take_remaining).


##### `ExecutorProcessTransport::push_stderr`  (lines 346–358)

```
fn push_stderr(&mut self, bytes: &[u8])
```

**Purpose**: Buffers stderr bytes and logs them one line at a time. Stderr is diagnostic output, not part of the MCP message stream.

**Data flow**: It receives raw stderr bytes and appends them to the stderr buffer. While complete lines are available, it removes each line, trims a trailing carriage return, converts the bytes to readable text as best it can, and writes an informational log message.

**Call relations**: `push_process_output` calls this for stderr chunks. It uses the same `LineBuffer` pattern as stdout, but its output goes to logs instead of RMCP.

*Call graph*: calls 2 internal fn (extend_from_slice, take_line); called by 1 (push_process_output); 2 external calls (trim_trailing_carriage_return, info!).


##### `ExecutorProcessTransport::flush_stderr`  (lines 360–369)

```
fn flush_stderr(&mut self)
```

**Purpose**: Logs any leftover stderr text when the process is closing. This ensures a final diagnostic message is not lost just because it did not end with a newline.

**Data flow**: It asks the stderr buffer for any remaining bytes. If there are none, it does nothing. If bytes remain, it converts them to readable text as best it can and logs them.

**Call relations**: `receive_message` calls this once the process is closed and no more RMCP messages will be returned. It completes the stderr logging path started by `push_stderr`.

*Call graph*: called by 1 (receive_message); 2 external calls (info!, take_remaining).


##### `ExecutorProcessTransport::trim_trailing_carriage_return`  (lines 371–376)

```
fn trim_trailing_carriage_return(mut line: BytesMut) -> BytesMut
```

**Purpose**: Removes a final carriage return character from a line. This makes lines ending in Windows-style `\r\n` look the same as lines ending in Unix-style `\n`.

**Data flow**: It receives a mutable byte line. If the last byte is carriage return, it shortens the line by one byte. It returns the possibly shortened line.

**Call relations**: `take_stdout_message` uses this before parsing JSON, and `push_stderr` uses it before logging text. It keeps line handling consistent across different operating systems and process behaviors.

*Call graph*: 3 external calls (last, len, truncate).


##### `ExecutorProcessTransport::drop`  (lines 384–406)

```
fn drop(&mut self)
```

**Purpose**: Provides backup cleanup if the transport is discarded without being explicitly closed. It tries to schedule termination of the MCP server process so the child process is not left running.

**Data flow**: When the transport is being destroyed, it first checks whether termination was already requested. If not, it clones the process handle and looks for a running Tokio runtime, which is the asynchronous task engine used here. If a runtime exists, it spawns a background task that asks the executor to terminate the process and logs any failure. If no runtime exists, it logs that cleanup could not be scheduled.

**Call relations**: This runs automatically when an `ExecutorProcessTransport` value goes out of scope. It is a fallback for cases where RMCP or its owner did not call `close`; explicit shutdown through `close` remains the preferred path.

*Call graph*: 4 external calls (clone, try_current, drop, warn!).


### HTTP capability implementations
These executor-side and orchestrator-side clients provide the concrete shared HTTP capability that higher-level MCP HTTP adaptation relies on.

### `exec-server/src/client/reqwest_http_client.rs`

`io_transport` · `request handling`

This file is the bridge between the exec server’s own request format and the outside web. Other parts of the system describe an HTTP request in project-specific types: method, URL, headers, optional body, timeout, and whether the response body should be streamed. This file checks that those details are safe and valid, then uses `reqwest` to send the request over the network.

It supports two ways to receive a response. For normal requests, it waits for the whole response body and returns the status code, headers, and body together. For streaming requests, it returns the status and headers right away, then keeps the network response open so chunks of the body can be forwarded later. This is like receiving a package either all at once or opening a pipe where pieces arrive over time.

The main public face is `ReqwestHttpClient`, which implements the project’s `HttpClient` interface. The detailed work is done by `ReqwestHttpRequestRunner`: it builds a configured HTTP client, validates methods and URLs, converts headers into `reqwest`’s format, sends the request, and converts the response back into the protocol’s format. The file also logs useful details when sending fails, while deliberately removing the URL from the logged error to avoid leaking sensitive information.

#### Function details

##### `ReqwestHttpClient::build_client`  (lines 53–62)

```
fn build_client(timeout_ms: Option<u64>) -> Result<reqwest::Client, ExecServerError>
```

**Purpose**: Builds the underlying `reqwest` HTTP client, optionally with a timeout. It also applies the project’s custom certificate authority setup, so HTTPS requests can trust any configured extra certificates.

**Data flow**: It receives an optional timeout in milliseconds. If a timeout is present, it creates a client builder with that timeout; otherwise it uses the default builder. It then passes the builder through the custom certificate setup and returns either a ready-to-use HTTP client or an exec-server error if setup failed.

**Call relations**: This is the low-level setup step used by `ReqwestHttpRequestRunner::new`. Higher-level request methods do not build network clients directly; they ask the runner to do it, and the runner calls this function.

*Call graph*: called by 1 (new); 3 external calls (from_millis, builder, build_reqwest_client_with_custom_ca).


##### `ReqwestHttpClient::http_request`  (lines 66–83)

```
fn http_request(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<HttpRequestResponse, ExecServerError>>
```

**Purpose**: Sends a regular HTTP request and returns the complete response body in one result. This is used when the caller does not want body chunks streamed separately.

**Data flow**: It takes internal HTTP request parameters from the caller. It creates a request runner using the requested timeout, forces `stream_response` to false, sends the request through the runner, and converts any JSON-RPC-style runner error into an `ExecServerError`. The output is a single `HttpRequestResponse` containing status, headers, and body bytes.

**Call relations**: This method is called through the `HttpClient` interface when the system wants a local, non-streaming web request. It starts by calling `ReqwestHttpRequestRunner::new`, then relies on the runner to validate and perform the actual network work.

*Call graph*: calls 1 internal fn (new).


##### `ReqwestHttpClient::http_request_stream`  (lines 85–110)

```
fn http_request_stream(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<(HttpRequestResponse, HttpResponseBodyStream), ExecServerError>>
```

**Purpose**: Sends an HTTP request where the response body should be read as a stream. It returns the response metadata first, along with a stream object that can later produce body chunks.

**Data flow**: It receives the internal request parameters, creates a runner with the requested timeout, and forces `stream_response` to true. The runner returns response status and headers plus a pending `reqwest` response body. This function checks that the pending stream really exists, wraps it as a local `HttpResponseBodyStream`, and returns both pieces to the caller.

**Call relations**: This method is used through the `HttpClient` interface when callers need streaming behavior, such as large or long-running responses. It calls `ReqwestHttpRequestRunner::new` for setup and then hands the kept-open response body to `HttpResponseBodyStream::local` so the rest of the system can read it using the project’s stream abstraction.

*Call graph*: calls 2 internal fn (local, new).


##### `ReqwestHttpRequestRunner::new`  (lines 114–118)

```
fn new(timeout_ms: Option<u64>) -> Result<Self, JSONRPCErrorError>
```

**Purpose**: Creates a request runner with a configured HTTP client. A runner is the object that validates one request format and sends it using `reqwest`.

**Data flow**: It receives an optional timeout. It asks `ReqwestHttpClient::build_client` to make a configured `reqwest` client. If that fails, it turns the failure into an internal JSON-RPC error; if it succeeds, it stores the client inside a new runner.

**Call relations**: This is the setup point used before actual requests are sent. It is called by the local `ReqwestHttpClient` request methods and by another `http_request` flow in the server route, so both local and forwarded requests share the same validation and sending behavior.

*Call graph*: calls 1 internal fn (build_client); called by 3 (http_request, http_request_stream, http_request).


##### `ReqwestHttpRequestRunner::run`  (lines 120–185)

```
async fn run(
        &self,
        params: HttpRequestParams,
    ) -> Result<(HttpRequestResponse, Option<PendingReqwestHttpBodyStream>), JSONRPCErrorError>
```

**Purpose**: Validates an internal HTTP request, sends it over the network, and converts the response back into the project’s response format. It is the central function in this file.

**Data flow**: It receives `HttpRequestParams`: method, URL, headers, optional body, request ID, timeout-related setup already stored in the runner, and a flag saying whether to stream the response. It first checks that the HTTP method is valid, parses the URL, rejects non-HTTP and non-HTTPS schemes, converts headers, attaches the body if present, and sends the request. On success it records the status and response headers. If streaming was requested, it returns an empty body plus a pending stream containing the still-open response. If not, it reads the full response body and returns it in the response object.

**Call relations**: Higher-level request paths call this after `ReqwestHttpRequestRunner::new` has made the client. During validation it uses `build_headers` and `response_headers` to translate between project types and `reqwest` types. If sending fails, it calls `log_send_error` for diagnostics and reports a JSON-RPC internal error to the caller.

*Call graph*: calls 3 internal fn (log_send_error, internal_error, invalid_params); 7 external calls (from_bytes, build_headers, response_headers, parse, new, request, format!).


##### `ReqwestHttpRequestRunner::stream_body`  (lines 187–244)

```
async fn stream_body(
        pending_stream: PendingReqwestHttpBodyStream,
        notifications: RpcNotificationSender,
    )
```

**Purpose**: Forwards a streaming HTTP response body chunk by chunk as notifications. This lets the receiver start processing data before the whole response has arrived.

**Data flow**: It receives a pending stream containing the request ID and the open `reqwest` response, plus a notification sender. It reads bytes from the response stream one chunk at a time. For each successful chunk, it sends a body-delta notification with an increasing sequence number. If reading fails, it sends a final notification containing the error. When the stream ends normally, it sends a final `done` notification with no error.

**Call relations**: This function is used after `run` has returned a pending stream for a streaming request. It hands each body piece to `send_body_delta`, which performs the actual notification send. If sending a notification fails, this function stops, because there is no longer a useful downstream listener.

*Call graph*: 2 external calls (new, send_body_delta).


##### `ReqwestHttpRequestRunner::build_headers`  (lines 246–261)

```
fn build_headers(headers: Vec<HttpHeader>) -> Result<HeaderMap, JSONRPCErrorError>
```

**Purpose**: Converts the project’s simple header list into the header map required by `reqwest`. It also rejects malformed header names or values before a network request is sent.

**Data flow**: It receives a list of `HttpHeader` values, each with a name and value string. For each one, it parses the name and value using `reqwest`/HTTP rules and appends it to a header map. If any header is invalid, it returns an invalid-parameters JSON-RPC error; otherwise it returns the completed header map.

**Call relations**: `ReqwestHttpRequestRunner::run` calls this while preparing the outgoing request. This keeps header validation in one place, so the request-sending logic can assume the headers it receives are already in the right format.

*Call graph*: 3 external calls (new, from_bytes, from_str).


##### `ReqwestHttpRequestRunner::response_headers`  (lines 263–273)

```
fn response_headers(headers: &HeaderMap) -> Vec<HttpHeader>
```

**Purpose**: Converts response headers from `reqwest`’s internal format back into the project’s protocol format.

**Data flow**: It receives a `reqwest` header map from the HTTP response. It walks through each header and keeps only values that can be represented as normal text. It returns a list of `HttpHeader` objects with string names and string values.

**Call relations**: `ReqwestHttpRequestRunner::run` calls this after a network response arrives. The converted headers are placed into `HttpRequestResponse`, which is what the rest of the exec-server protocol understands.

*Call graph*: 1 external calls (iter).


##### `log_send_error`  (lines 276–287)

```
fn log_send_error(method: &Method, error: reqwest::Error)
```

**Purpose**: Writes a structured warning when an HTTP request could not be sent. It records useful troubleshooting facts, such as whether the failure was a timeout or connection problem.

**Data flow**: It receives the HTTP method and the `reqwest` error. It removes the URL from the error, gathers the underlying error causes with `error_source_chain`, and writes a warning log entry with the method, timeout/connect flags, main error text, and cause chain. It does not return a value; its effect is the log record.

**Call relations**: `ReqwestHttpRequestRunner::run` calls this only when `reqwest` fails to send the request. This function then calls `error_source_chain` to make the warning more informative without cluttering the main request path.

*Call graph*: calls 1 internal fn (error_source_chain); called by 1 (run); 2 external calls (without_url, warn!).


##### `error_source_chain`  (lines 289–297)

```
fn error_source_chain(error: &reqwest::Error) -> Option<String>
```

**Purpose**: Builds a readable summary of the lower-level causes behind a `reqwest` error. This helps logs show not just that a request failed, but what deeper error led to it.

**Data flow**: It receives a `reqwest` error and follows its chain of source errors, collecting each source’s text. If it finds any sources, it joins them into one string separated by colons. If there are no deeper causes, it returns nothing.

**Call relations**: `log_send_error` calls this while preparing a warning log entry. It is a small helper whose only job is to make network failure logs more useful.

*Call graph*: called by 1 (log_send_error); 3 external calls (new, source, to_string).


### `exec-server/src/client/rpc_http_client.rs`

`io_transport` · `request handling`

The orchestrator process does not open the HTTP connection itself. Instead, it sends a JSON-RPC message, which is a structured request over an existing shared connection, to a remote runtime that performs the real HTTP work. This file is the adapter that makes that feel like using a normal HTTP client.

For a simple request, it marks the request as non-streaming and sends it to the remote runtime. The reply includes the response data directly.

For a streaming request, there is more bookkeeping. The file creates a fresh request id that is local to this connection. That id is like a claim ticket: when later body chunks arrive as separate `http/request/bodyDelta` notifications, the client can put each chunk into the right stream. It also creates a small queue for those chunks, registers that queue with the shared client state, sends the request, and then returns both the initial HTTP response and a stream object that will yield the body bytes. If the request fails before the stream is established, it removes the registration so old or abandoned chunks cannot be mistaken for a future response.

Finally, this file implements the project-wide `HttpClient` interface for `ExecServerClient`, so other code can depend on the general idea of an HTTP client without caring that the real work is happening remotely over JSON-RPC.

#### Function details

##### `ExecServerClient::http_request`  (lines 73–78)

```
fn http_request(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<HttpRequestResponse, ExecServerError>>
```

**Purpose**: Sends an HTTP request to the remote runtime and asks for the whole response body to be returned in one piece. This is used when the caller does not need to read the body gradually.

**Data flow**: It takes HTTP request details as input. Before sending them, it turns off response streaming, so the remote side knows to buffer the body. It then sends a JSON-RPC `http/request` call through the existing client connection and returns either the completed HTTP response or an execution-server error.

**Call relations**: This is the buffered path for HTTP traffic. Code that uses `ExecServerClient` directly, or through the `HttpClient` interface, reaches this method when it wants a normal request-response exchange. Internally it hands the prepared request to the shared JSON-RPC calling mechanism rather than opening a network connection itself.

*Call graph*: 1 external calls (http_request).


##### `ExecServerClient::http_request_stream`  (lines 82–87)

```
fn http_request_stream(
        &self,
        params: HttpRequestParams,
    ) -> BoxFuture<'_, Result<(HttpRequestResponse, HttpResponseBodyStream), ExecServerError>>
```

**Purpose**: Sends an HTTP request to the remote runtime and returns a stream for reading the response body piece by piece. This is useful for large responses or responses that arrive slowly over time.

**Data flow**: It takes HTTP request details as input, marks the request as streaming, and replaces any existing request id with a new connection-local id. It creates a bounded queue for incoming body chunks, registers that queue so later body notifications can find it, and sends the JSON-RPC request. On success it returns the initial HTTP response plus a body stream connected to that queue. On failure it removes the registration and returns the error, so no leftover stream state remains.

**Call relations**: This is the streaming path for HTTP traffic. Callers ask for it when they need the body as a live byte stream instead of one buffered value. It works together with the shared client state, which routes later body-delta notifications into the queue created here, and with `HttpResponseBodyStream`, which presents those queued chunks to the caller as a readable stream.

*Call graph*: calls 2 internal fn (new, remote); 3 external calls (clone, http_request_stream, channel).


### Streamable HTTP adaptation
These pieces adapt the shared HTTP capability into RMCP streamable HTTP semantics, including auth-aware error parsing and retry around initialization.

### `rmcp-client/src/http_client_adapter.rs`

`io_transport` · `request handling`

This file is a bridge between two worlds. On one side is RMCP, which wants to send JSON-RPC messages, open server-sent event streams, and close sessions. On the other side is a shared HttpClient, which only knows how to make HTTP requests and return response headers, status codes, and body bytes. The adapter turns each RMCP operation into the right HTTP method, headers, body, and response interpretation.

The main type, StreamableHttpClientAdapter, stores the HTTP client, default headers, and an optional authentication provider. When RMCP sends a message, the adapter builds a POST request with JSON content, adds session and authorization headers when needed, and asks for either JSON or a server-sent event stream. It then reads the response carefully: 401 can mean authentication is required, 403 can mean the token lacks a required permission, 404 with a session means the session expired, and successful responses are decoded as either JSON or a live stream.

It also supports DELETE for ending a session and GET for opening an ongoing event stream. Helper functions keep the edges safe: they validate headers, convert header formats, collect streamed bytes, shorten huge error bodies for logs, and recognize retryable server failures. Without this file, RMCP would not know how to use the project’s shared HTTP layer.

#### Function details

##### `StreamableHttpClientAdapter::new`  (lines 70–80)

```
fn new(
        http_client: Arc<dyn HttpClient>,
        default_headers: HeaderMap,
        auth_provider: Option<SharedAuthProvider>,
    ) -> Self
```

**Purpose**: Creates a new adapter by packaging together the shared HTTP client, default headers, and optional authentication source. This is used when the system is preparing an RMCP transport that will communicate over HTTP.

**Data flow**: It receives an HTTP client, a set of headers to include on requests, and maybe an authentication provider. It stores those pieces inside a StreamableHttpClientAdapter. The result is a ready-to-use object that can later send RMCP messages, open streams, and close sessions.

**Call relations**: Transport setup code calls this when creating pending transports or OAuth-enabled transports. After construction, RMCP calls the adapter through the StreamableHttpClient trait methods such as post_message, get_stream, and delete_session.

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

**Purpose**: Sends one RMCP JSON-RPC message to a server using an HTTP POST request. It also decides whether the server’s answer is plain JSON, an event stream, an accepted-but-empty response, or an error that needs special handling.

**Data flow**: It starts with a target URI, a client message, optional session and authentication values, and custom headers. It combines default, custom, auth, content type, accept, session, and bearer-token headers; turns the message into JSON bytes; sends a streaming HTTP POST; then inspects the status code and response headers. It returns an accepted result, a parsed JSON-RPC response, a server-sent event stream, or a clear protocol error.

**Call relations**: This is the main send path used by the RMCP transport. It leans on helpers to extract message details for logging, add authentication headers, insert safe header values, convert headers for the shared HTTP client, read response headers, collect body bytes, parse JSON-RPC errors, and turn a streamed body into an SSE stream.

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

**Purpose**: Asks the server to close an RMCP session using an HTTP DELETE request. It treats “method not allowed” as harmless, because some servers simply do not support explicit session deletion.

**Data flow**: It receives the URI, session id, optional bearer token, and custom headers. It builds headers with defaults, authentication, and the session id; sends a DELETE request without a body; then checks the status code. A success status or method-not-allowed response becomes Ok(()), while other failures become an unexpected server response error.

**Call relations**: RMCP calls this when a session should be cleaned up. It uses add_auth_headers, insert_header, protocol_headers, and status_is_success to prepare and judge the request before returning control to the transport.

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

**Purpose**: Opens a long-lived server-sent event stream for an existing RMCP session. Server-sent events are a simple HTTP-based way for a server to keep sending messages over time, like a live news ticker.

**Data flow**: It receives a URI, session id, optional last event id, optional bearer token, and custom headers. It builds a GET request that asks for streamable content, sends it through the shared HTTP client, checks for unsupported streaming, expired sessions, and bad status codes, then verifies the content type. If everything is valid, it returns a stream of parsed SSE events.

**Call relations**: RMCP calls this when it needs to listen for ongoing server messages. It uses shared helpers for authentication, headers, status checks, content-type checks, and finally hands the raw body stream to sse_stream_from_body so callers receive structured SSE events.

*Call graph*: calls 7 internal fn (add_auth_headers, insert_header, is_streamable_http_content_type, protocol_headers, response_header, sse_stream_from_body, status_is_success); 6 external calls (clone, from_static, Client, UnexpectedContentType, UnexpectedServerResponse, format!).


##### `StreamableHttpClientAdapter::add_auth_headers`  (lines 371–375)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds authentication headers from the configured authentication provider, if one exists. This lets the adapter include project-wide auth information without each request rebuilding it by hand.

**Data flow**: It receives a mutable header map. If the adapter has an auth provider, it asks that provider for headers and extends the map with them. The same header map then continues through request construction with the auth values included.

**Call relations**: post_message, delete_session, and get_stream all call this early while building their HTTP headers. It supplies baseline authentication before those functions add request-specific bearer tokens or session headers.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 1 external calls (extend).


##### `body_preview`  (lines 378–393)

```
fn body_preview(body: impl Into<String>) -> String
```

**Purpose**: Creates a safe, shortened version of a response body for error messages. This prevents huge or non-JSON server responses from flooding logs or user-facing errors.

**Data flow**: It receives something that can become a string. If the text is short enough, it returns it unchanged. If it is too long, it cuts it at a valid character boundary and appends a note saying how many bytes were omitted.

**Call relations**: post_message uses this when reporting unexpected non-success or wrong-content-type responses. It makes those errors useful without printing an entire large response body.

*Call graph*: 2 external calls (into, format!).


##### `client_jsonrpc_message_fields`  (lines 395–426)

```
fn client_jsonrpc_message_fields(
    message: &ClientJsonRpcMessage,
) -> (Option<String>, Option<String>)
```

**Purpose**: Pulls out the RMCP method name and request id from a client JSON-RPC message when those fields exist. This is mainly used to make failures easier to understand and to decide whether some server errors should be treated as retryable.

**Data flow**: It receives a client JSON-RPC message. For requests it returns the method and id; for responses it returns the id only; for notifications it returns the notification method; for errors it returns the error id if present. The output is a pair of optional strings.

**Call relations**: post_message calls this before sending the HTTP request. The extracted fields are used for logging failed HTTP requests and for later response decisions such as whether a failed POST belongs to an operation the client may retry.

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

**Purpose**: Writes a careful warning when the underlying HTTP POST fails before a usable response is received. It records useful context without dumping sensitive full URLs or tokens.

**Data flow**: It receives the URI, optional RMCP method and request id, and flags saying whether a session id and authorization header were present. It parses the URI enough to log the scheme, host, path, and whether there was a query string, then emits a structured warning.

**Call relations**: post_message calls this only when the shared HTTP client returns an error for the POST itself. After logging, post_message turns the lower-level HTTP failure into a streamable HTTP client error.

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

**Purpose**: Safely inserts one HTTP header value into a header map. It checks that the value is legal for an HTTP header before adding it.

**Data flow**: It receives a mutable header map, a header name, a string value, and a function for turning validation failures into the caller’s error type. It tries to convert the string into a header value; on success it inserts it, and on failure it returns a client error.

**Call relations**: post_message, delete_session, and get_stream call this whenever they add protocol headers such as Accept, Content-Type, Authorization, session id, or last event id. It keeps invalid header text from reaching the HTTP client.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 2 external calls (insert, from_str).


##### `is_streamable_http_content_type`  (lines 473–480)

```
fn is_streamable_http_content_type(content_type: &str) -> bool
```

**Purpose**: Checks whether a response content type is acceptable for streamable HTTP. In this adapter, acceptable means either server-sent events or JSON.

**Data flow**: It receives a content-type string from a response header. It compares the start of that string against the event-stream and JSON media types. It returns true when the content can be handled by this transport, otherwise false.

**Call relations**: get_stream uses this after receiving a successful GET response. If the server sends some other kind of content, get_stream rejects it instead of trying to parse unknown bytes as RMCP events.

*Call graph*: called by 1 (get_stream).


##### `protocol_headers`  (lines 482–492)

```
fn protocol_headers(headers: &HeaderMap) -> Vec<HttpHeader>
```

**Purpose**: Converts reqwest-style headers into the simpler HttpHeader format expected by the shared HttpClient. This is a translation step between two HTTP representations used inside the project.

**Data flow**: It receives a HeaderMap. It walks through each header, keeps only values that can be represented as normal text, and creates a list of HttpHeader objects with string names and string values. That list is passed into HttpRequestParams.

**Call relations**: post_message, delete_session, and get_stream all call this immediately before making a request through the shared HttpClient. It is the final header conversion before control leaves this adapter.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 1 external calls (iter).


##### `response_header`  (lines 494–500)

```
fn response_header(headers: &[HttpHeader], name: impl AsRef<str>) -> Option<String>
```

**Purpose**: Finds a response header by name, ignoring differences in letter case. HTTP header names are case-insensitive, so this avoids missing a header just because the server used different capitalization.

**Data flow**: It receives a list of response headers and the name to search for. It scans the list and returns a copy of the matching value if found, or None if no matching header exists.

**Call relations**: post_message uses this to read content type, session id, and authentication challenge headers. get_stream uses it to read and validate the content type before building an SSE stream.

*Call graph*: called by 2 (get_stream, post_message); 2 external calls (as_ref, iter).


##### `status_is_success`  (lines 502–504)

```
fn status_is_success(status: u16) -> bool
```

**Purpose**: Decides whether an HTTP status code means success. It uses the standard HTTP meaning of success, which is any 2xx status code.

**Data flow**: It receives a numeric status code. If the number is a valid HTTP status and falls in the success range, it returns true. Otherwise it returns false.

**Call relations**: post_message, delete_session, and get_stream use this after receiving responses. It gives those higher-level methods a single plain yes-or-no check before they decide how to handle failures.

*Call graph*: called by 3 (delete_session, get_stream, post_message); 1 external calls (from_u16).


##### `retryable_post_response_status`  (lines 506–515)

```
fn retryable_post_response_status(mcp_method: Option<&str>, status: u16) -> bool
```

**Purpose**: Decides whether a failed POST response should be treated as retryable for a small set of RMCP methods. This prevents the adapter from converting some temporary server failures into final JSON-RPC errors too eagerly.

**Data flow**: It receives an optional RMCP method name and an HTTP status code. It first checks whether the status code is one of the temporary-failure statuses. Then it checks whether the method is one of the specific startup or listing operations allowed for retry behavior. It returns true only when both checks pass.

**Call relations**: post_message calls this when it receives a non-success response with a JSON body. If the response is retryable, post_message avoids returning the JSON-RPC error as a normal response and instead reports an unexpected server response.

*Call graph*: calls 1 internal fn (is_retryable_http_status); called by 1 (post_message); 2 external calls (from_u16, matches!).


##### `is_retryable_http_status`  (lines 517–527)

```
fn is_retryable_http_status(status: StatusCode) -> bool
```

**Purpose**: Recognizes HTTP status codes that often mean a temporary problem, such as timeout, rate limiting, or server overload. These are cases where trying again later may make sense.

**Data flow**: It receives a StatusCode value. It compares it with a fixed set of retry-worthy statuses and returns true for matches, false otherwise.

**Call relations**: retryable_post_response_status calls this as its first filter. That larger helper then combines the HTTP status decision with the RMCP method name.

*Call graph*: called by 1 (retryable_post_response_status); 1 external calls (matches!).


##### `parse_json_rpc_error`  (lines 529–534)

```
fn parse_json_rpc_error(body: &[u8]) -> Option<ServerJsonRpcMessage>
```

**Purpose**: Tries to read a response body as a JSON-RPC error message from the server. This lets the adapter preserve a meaningful protocol-level error when the server returned one.

**Data flow**: It receives raw response bytes. It attempts to parse them as a ServerJsonRpcMessage and returns the message only if it is specifically a JSON-RPC error. If parsing fails or the message is not an error, it returns None.

**Call relations**: post_message uses this for non-success responses that claim to be JSON. When appropriate, post_message can return the parsed JSON-RPC error as a normal RMCP response instead of only reporting an HTTP failure.

*Call graph*: called by 1 (post_message).


##### `collect_body`  (lines 536–549)

```
async fn collect_body(
    body_stream: &mut HttpResponseBodyStream,
) -> std::result::Result<Vec<u8>, StreamableHttpError<StreamableHttpClientAdapterError>>
```

**Purpose**: Reads an entire streamed HTTP response body into memory as one byte vector. This is used when the adapter needs the full body before it can parse JSON or build an error message.

**Data flow**: It receives a mutable response body stream. It repeatedly waits for the next chunk, appends each chunk to a growing byte vector, and stops when the stream ends. It returns all collected bytes or a client error if reading the stream fails.

**Call relations**: post_message calls this when it needs to parse a JSON response, inspect a JSON-RPC error, or include a response body preview in an error. Streaming cases skip this and use sse_stream_from_body instead.

*Call graph*: calls 1 internal fn (recv); called by 1 (post_message); 1 external calls (new).


##### `sse_stream_from_body`  (lines 551–562)

```
fn sse_stream_from_body(
    body_stream: HttpResponseBodyStream,
) -> BoxStream<'static, std::result::Result<Sse, sse_stream::Error>>
```

**Purpose**: Turns the project’s raw HTTP body stream into a stream of server-sent events. This is the adapter’s live-message path for responses that should keep producing events over time.

**Data flow**: It receives an HttpResponseBodyStream that yields byte chunks. It wraps each chunk in the byte type expected by the SSE parser, converts read errors into I/O-style errors, and feeds the byte stream into SseStream. The output is a boxed stream of parsed SSE events or SSE parsing errors.

**Call relations**: post_message uses this when a POST response starts an event stream, and get_stream uses it after a successful streaming GET. It hands the raw byte flow off to the SSE library so callers see events rather than low-level chunks.

*Call graph*: called by 2 (get_stream, post_message); 2 external calls (from_byte_stream, unfold).


### `rmcp-client/src/http_client_adapter/www_authenticate.rs`

`io_transport` · `request handling`

When an HTTP request fails because the client’s access token does not have enough permission, the server can explain that in a `WWW-Authenticate` header. That header is compact and fussy: it can contain several authentication challenges, quoted text, escaped characters, commas, semicolons, and optional fields. This file is the careful reader for that header.

The main public-to-this-module function, `insufficient_scope_challenge`, scans response headers for `WWW-Authenticate`. For each matching header, it tries to find a Bearer challenge whose `error` value is exactly `insufficient_scope`. If it finds one, it returns the original header text plus an optional `scope`, which is the permission the server says is needed.

Most of the file is small parsing helpers. They split the header only at separators that are not inside quotes, recognize authentication parameters like `error="insufficient_scope"`, decode HTTP quoted strings, and check that names and scopes use characters allowed by the HTTP standards. This matters because a naive comma split could break quoted values and either miss the real error or accept a malformed one. Think of it like reading a shipping label where commas may appear inside quoted addresses: you need to know which commas separate fields and which are just part of the address.

#### Function details

##### `BearerChallenge::add_parameter`  (lines 33–48)

```
fn add_parameter(&mut self, name: &str, value: Option<String>)
```

**Purpose**: Adds one parsed field to a Bearer authentication challenge, but only if the field is one this code cares about: `error` or `scope`. It also marks the field as invalid if it is missing a value or appears more than once, because duplicate or incomplete values should not be trusted.

**Data flow**: It receives a parameter name and an optional value from the header parser. If the name is `error` or `scope`, it records the value when this is the first valid occurrence; otherwise it marks that stored field as invalid. It changes the `BearerChallenge` in place and returns nothing.

**Call relations**: During Bearer header parsing, each recognized `name=value` piece is fed into this function so the temporary challenge can collect the important facts. Later, `BearerChallenge::into_insufficient_scope` reads the stored `error` and `scope` decisions to decide whether the challenge is useful.

*Call graph*: 1 external calls (Value).


##### `BearerChallenge::into_insufficient_scope`  (lines 50–62)

```
fn into_insufficient_scope(self) -> Option<BearerInsufficientScope>
```

**Purpose**: Turns a collected Bearer challenge into a simpler result, but only when it really says `error="insufficient_scope"`. If a valid `scope` was also supplied, it keeps that scope as the permission the client may need.

**Data flow**: It takes ownership of a completed `BearerChallenge`. It checks whether the stored error is exactly `insufficient_scope`; if not, it produces no result. If the error matches, it checks the stored scope with `valid_scope` and returns a `BearerInsufficientScope` containing either the valid scope text or no scope.

**Call relations**: This is the final filter after parsing a Bearer challenge. `parse_bearer_insufficient_scope` uses it when a challenge ends or when the whole header has been read, and it relies on `valid_scope` to reject scope text that does not follow the Bearer-token rules.

*Call graph*: calls 1 internal fn (valid_scope).


##### `insufficient_scope_challenge`  (lines 67–81)

```
fn insufficient_scope_challenge(
    headers: &[HttpHeader],
) -> Option<InsufficientScopeChallenge>
```

**Purpose**: Searches a list of HTTP response headers for a Bearer insufficient-scope error. This is the function the HTTP client uses when it wants to know whether a failed request was rejected because the token needs extra permission.

**Data flow**: It receives all response headers. It keeps only headers named `WWW-Authenticate`, ignoring letter case, then tries to parse each header value. On the first header that contains a matching Bearer insufficient-scope challenge, it returns the original header value and the optional required scope; if none match, it returns nothing.

**Call relations**: The request-sending flow calls this from `post_message` after receiving a response. This function delegates the difficult header grammar to `parse_bearer_insufficient_scope`, then packages the parsed result into `InsufficientScopeChallenge` for the caller.

*Call graph*: called by 1 (post_message); 1 external calls (iter).


##### `parse_bearer_insufficient_scope`  (lines 98–128)

```
fn parse_bearer_insufficient_scope(header: &str) -> Option<BearerInsufficientScope>
```

**Purpose**: Parses one `WWW-Authenticate` header value and looks inside it for a Bearer challenge with an insufficient-scope error. It understands that one header can contain several challenges and several parameters.

**Data flow**: It receives raw header text. First it asks `split_unquoted_segments` to break the text into safe pieces without splitting inside quoted strings. It then walks those pieces, treating some as authentication parameters and others as the start of a new challenge. When it finishes a Bearer challenge, it converts it into a `BearerInsufficientScope` if possible; otherwise it returns nothing.

**Call relations**: This is the central parser used by `insufficient_scope_challenge`. It calls `parse_auth_param` for `name=value` parts, `parse_challenge_start` when a new authentication scheme may begin, and `split_unquoted_segments` before all of that so separators inside quotes do not confuse the parser.

*Call graph*: calls 3 internal fn (parse_auth_param, parse_challenge_start, split_unquoted_segments); 1 external calls (default).


##### `parse_challenge_start`  (lines 130–142)

```
fn parse_challenge_start(segment: &str) -> Option<ChallengeStart<'_>>
```

**Purpose**: Reads the beginning of an authentication challenge, such as `Bearer` followed by an optional first parameter. It makes sure the scheme name is a valid HTTP token before accepting it.

**Data flow**: It receives one segment of header text. It trims surrounding spaces, separates the first word as the authentication scheme, and, if more text follows, tries to parse that remainder as an authentication parameter. It returns the scheme plus the optional parameter, or nothing if the scheme name is not valid.

**Call relations**: When `parse_bearer_insufficient_scope` finds a segment that is not simply another parameter, it asks this function whether the segment starts a new challenge. This function uses `is_http_token` to validate the scheme and `parse_auth_param` to interpret any parameter that appears on the same segment.

*Call graph*: calls 2 internal fn (is_http_token, parse_auth_param); called by 1 (parse_bearer_insufficient_scope).


##### `parse_auth_param`  (lines 144–148)

```
fn parse_auth_param(segment: &str) -> Option<AuthParameter<'_>>
```

**Purpose**: Parses a single authentication parameter written like `name=value`. It checks that the name is legal HTTP syntax and decodes the value into plain text.

**Data flow**: It receives one header segment. It trims it, splits it at the first equals sign, validates the left side as a token name, and passes the right side to `parse_auth_param_value`. If everything is acceptable, it returns the name and an optional decoded value; if the segment is not a valid parameter, it returns nothing.

**Call relations**: Both `parse_bearer_insufficient_scope` and `parse_challenge_start` call this when they encounter possible `name=value` text. It hands value decoding to `parse_auth_param_value` and uses `is_http_token` to reject invalid parameter names.

*Call graph*: calls 2 internal fn (is_http_token, parse_auth_param_value); called by 2 (parse_bearer_insufficient_scope, parse_challenge_start).


##### `parse_auth_param_value`  (lines 150–166)

```
fn parse_auth_param_value(value: &str) -> Option<String>
```

**Purpose**: Turns the value part of an authentication parameter into usable text. It supports both quoted HTTP strings, like `"abc"`, and unquoted token values, like `abc`.

**Data flow**: It receives the raw value text after the equals sign. If the value is quoted, it removes the outer quotes and resolves backslash escapes by keeping the escaped character. If it is not quoted, it accepts it only if `is_http_token` says it is a legal token. It returns decoded text or nothing for malformed values.

**Call relations**: `parse_auth_param` calls this after it has identified a parameter name. This helper is where quoted-string details are handled, so the rest of the parser can work with ordinary decoded strings.

*Call graph*: calls 1 internal fn (is_http_token); called by 1 (parse_auth_param); 1 external calls (with_capacity).


##### `split_unquoted_segments`  (lines 168–196)

```
fn split_unquoted_segments(header: &str) -> Option<Vec<&str>>
```

**Purpose**: Splits a header into pieces at commas and semicolons, but only when those separators are outside quoted text. This prevents the parser from breaking a value just because it contains punctuation inside quotes.

**Data flow**: It receives the full header string and scans it character by character. It keeps track of whether it is inside quotes and whether the current character is escaped with a backslash. It returns a list of header slices if the quotes and escapes are balanced; if the header ends inside a quote or after an unfinished escape, it returns nothing.

**Call relations**: `parse_bearer_insufficient_scope` calls this before trying to understand the header. Its output becomes the sequence of pieces that are later interpreted by `parse_auth_param` and `parse_challenge_start`.

*Call graph*: called by 1 (parse_bearer_insufficient_scope); 1 external calls (new).


##### `valid_scope`  (lines 198–205)

```
fn valid_scope(scope: &str) -> bool
```

**Purpose**: Checks whether a Bearer `scope` value follows the allowed character rules. A scope is one or more non-empty tokens separated by spaces, where each token can only contain certain visible characters.

**Data flow**: It receives decoded scope text. It splits the text on spaces, rejects empty tokens, and checks every byte against the allowed Bearer scope character set. It returns true for a valid scope and false otherwise.

**Call relations**: `BearerChallenge::into_insufficient_scope` calls this before exposing a required scope to the rest of the client. That keeps malformed or unsafe-looking scope text from being treated as a real permission request.

*Call graph*: called by 1 (into_insufficient_scope).


##### `is_http_token`  (lines 207–229)

```
fn is_http_token(value: &str) -> bool
```

**Purpose**: Checks whether a string is a valid HTTP token, which is the restricted word-like format used for header names, scheme names, and unquoted values. It rejects empty strings and characters that HTTP token syntax does not allow.

**Data flow**: It receives a string. It verifies that the string is not empty and that every byte is either a letter, a digit, or one of the punctuation characters allowed in HTTP tokens. It returns true if the whole string is valid and false otherwise.

**Call relations**: This is a shared syntax checker used by `parse_challenge_start`, `parse_auth_param`, and `parse_auth_param_value`. Those parsing functions use it to decide whether a scheme, parameter name, or unquoted value can be trusted as valid HTTP header syntax.

*Call graph*: called by 3 (parse_auth_param, parse_auth_param_value, parse_challenge_start).


### `rmcp-client/src/streamable_http_retry.rs`

`orchestration` · `startup connection handshake`

When this client starts talking to an MCP server, it must complete an initial handshake: it opens a transport, sends an “initialize” request, and sends an “initialized” notification. Over HTTP, that can fail for reasons that are often temporary, such as a server restarting, a gateway returning a 502 error, or a response stream closing early. This file is the safety net for that startup moment.

The main flow tries the connection once, then retries it after short delays for streamable HTTP transports only. Other transport types, such as in-process or standard input/output, are not retried here because their failures usually mean something more direct than a flaky network hop. The retry loop also respects an overall timeout, so it will not keep waiting past the caller’s deadline.

A key part of the file is deciding which errors are worth retrying. It walks through wrapped error messages, recognizes MCP client initialization errors, then checks whether the underlying HTTP or stream error looks temporary. For example, HTTP 408, 429, 500, 502, 503, and 504 are treated as retryable. Authentication errors, expired sessions, bad content types, and deserialization failures are not retried because trying again without changing anything is unlikely to help.

In everyday terms, this file is like knocking on a server’s door: if there is no answer because the hallway is briefly blocked, it waits and knocks again; if the server says “you are not allowed in,” it stops.

#### Function details

##### `RmcpClient::connect_pending_transport_with_initialize_retries`  (lines 26–99)

```
async fn connect_pending_transport_with_initialize_retries(
        &self,
        initial_transport: PendingTransport,
        client_service: ElicitationClientService,
        timeout: Option<Durati
```

**Purpose**: This is the main retry loop for the initial MCP connection handshake. It tries to connect using a pending transport, and for streamable HTTP transports it retries a small number of times when the failure looks temporary.

**Data flow**: It receives an initial transport, a client service to attach to the MCP connection, and an optional total timeout. It decides whether this transport type should be retried, keeps track of the overall deadline, then tries to connect. On success, it returns the running MCP client service and any OAuth persistor. On a retryable HTTP initialization failure, it waits for the configured delay and tries again, creating a fresh pending transport if needed. If the timeout runs out or the error is not retryable, it returns an error.

**Call relations**: This function sits between transport creation and the normal MCP connection setup. It calls the lower-level connection routine to do the actual handshake, asks the retry-classification helpers whether an error deserves another try, uses the timeout helper before each attempt, and uses the sleep helper between attempts so the retry delay does not exceed the overall deadline.

*Call graph*: calls 2 internal fn (remaining_initialize_timeout, sleep_with_retry_deadline); 10 external calls (from_millis, connect_pending_transport, create_pending_transport, is_retryable_initialize_error, anyhow!, clone, once, timeout, unreachable!, warn!).


##### `RmcpClient::is_retryable_initialize_error`  (lines 101–110)

```
fn is_retryable_initialize_error(error: &anyhow::Error) -> bool
```

**Purpose**: This function answers one question: did the initialize handshake fail for a reason that might be fixed by trying again? It looks through nested error layers because the useful cause may be wrapped inside higher-level error messages.

**Data flow**: It receives a general error value. It walks through the error chain and looks for either this file’s handshake wrapper error or the MCP library’s client-initialize error. If it finds one, it passes the underlying initialize error to the next classifier. It returns true only when that deeper error is recognized as retryable.

**Call relations**: The retry loop calls this after a failed connection attempt. This helper does not decide HTTP details itself; it unwraps the error far enough to hand the real initialization problem to RmcpClient::is_retryable_client_initialize_error.

*Call graph*: 1 external calls (chain).


##### `RmcpClient::is_retryable_client_initialize_error`  (lines 112–135)

```
fn is_retryable_client_initialize_error(error: &rmcp::service::ClientInitializeError) -> bool
```

**Purpose**: This function decides whether a specific MCP initialization failure is safe to retry. It focuses on failures while sending the initialize request or the initialized notification, because those are the fragile network-facing parts of the handshake.

**Data flow**: It receives an MCP client initialization error. If the error happened while sending the initialize request, it checks whether the underlying streamable HTTP error is retryable. If the error happened while sending the initialized notification, it also treats a closed transport channel as retryable. Any other kind of initialization failure becomes false.

**Call relations**: This is the middle layer of the retry decision. RmcpClient::is_retryable_initialize_error finds the initialization error and sends it here; this function then delegates the transport-specific judgment to RmcpClient::is_retryable_streamable_http_error.


##### `RmcpClient::is_retryable_streamable_http_error`  (lines 137–165)

```
fn is_retryable_streamable_http_error(
        error: &StreamableHttpError<StreamableHttpClientAdapterError>,
    ) -> bool
```

**Purpose**: This function classifies streamable HTTP transport errors as temporary or not. It is the file’s detailed rulebook for which HTTP-related failures deserve another connection attempt.

**Data flow**: It receives a streamable HTTP error. It returns true for request failures, certain server-side JSON-RPC internal errors that clearly came from an HTTP request failure, protocol messages saying an HTTP response stream failed, and unexpected server responses with retryable HTTP status codes. It returns false for problems such as authentication, missing permissions, expired sessions, bad content types, unsupported server behavior, parsing failures, bad headers, and other non-temporary cases.

**Call relations**: This is called by the initialization-error classifier when the handshake failure came from streamable HTTP. When the error is expressed as a plain unexpected response message, it hands that message to is_retryable_unexpected_server_response so the HTTP status code can be parsed and checked.

*Call graph*: calls 1 internal fn (is_retryable_unexpected_server_response).


##### `is_retryable_unexpected_server_response`  (lines 168–183)

```
fn is_retryable_unexpected_server_response(message: &str) -> bool
```

**Purpose**: This helper recognizes unexpected server response messages that contain an HTTP status code, then decides whether that status code is temporary. It turns a text message like “HTTP 503 ...” into a normal status-code check.

**Data flow**: It receives a message string. It first checks that the message starts with “HTTP ”, extracts the following digits, parses them as a status code, and converts that number into a standard HTTP status value. If any of those steps fail, it returns false. If parsing succeeds, it passes the status to is_retryable_http_status and returns that answer.

**Call relations**: RmcpClient::is_retryable_streamable_http_error calls this when a streamable HTTP error only says the server response was unexpected. This helper bridges from free-form text to the clearer status-code rules in is_retryable_http_status.

*Call graph*: calls 1 internal fn (is_retryable_http_status); called by 1 (is_retryable_streamable_http_error); 1 external calls (from_u16).


##### `is_retryable_http_status`  (lines 185–195)

```
fn is_retryable_http_status(status: StatusCode) -> bool
```

**Purpose**: This helper names the HTTP status codes that are considered temporary enough to retry. These are common signs of overload, timeout, gateway trouble, or a server-side hiccup.

**Data flow**: It receives a standard HTTP status code. It compares it with a short allow-list: request timeout, too many requests, internal server error, bad gateway, service unavailable, and gateway timeout. It returns true for those codes and false for everything else.

**Call relations**: is_retryable_unexpected_server_response calls this after it has extracted a valid status code from an error message. This keeps the status-code policy in one small, easy-to-read place.

*Call graph*: called by 1 (is_retryable_unexpected_server_response); 1 external calls (matches!).


##### `remaining_initialize_timeout`  (lines 197–210)

```
fn remaining_initialize_timeout(
    timeout: Option<Duration>,
    deadline: Option<Instant>,
) -> Result<Option<Duration>>
```

**Purpose**: This helper calculates how much time is still available for the connection handshake. It prevents retries and new connection attempts from running beyond the caller’s overall timeout.

**Data flow**: It receives the original optional timeout and an optional absolute deadline. If there is no deadline, it returns None, meaning there is no time limit to apply here. If there is a deadline, it compares it with the current time. If time remains, it returns that remaining duration. If no time remains, it returns a timeout error.

**Call relations**: The main retry loop calls this before creating a fresh transport and before each connection attempt. When the deadline has passed, this helper uses initialize_timeout_error to produce the user-facing error message.

*Call graph*: calls 1 internal fn (initialize_timeout_error); called by 1 (connect_pending_transport_with_initialize_retries); 1 external calls (now).


##### `initialize_timeout_error`  (lines 212–215)

```
fn initialize_timeout_error(timeout: Option<Duration>, fallback: Duration) -> anyhow::Error
```

**Purpose**: This helper builds a consistent error message for handshake timeouts. It keeps timeout failures worded the same way throughout the retry code.

**Data flow**: It receives the original optional timeout and a fallback duration. It chooses the original timeout when available, otherwise the fallback, and puts that duration into an error saying the client timed out while handshaking with the MCP server. It returns that error object.

**Call relations**: remaining_initialize_timeout calls this when the overall deadline has already expired. The main retry loop also uses the same wording when a retry delay cannot fit inside the remaining time.

*Call graph*: called by 1 (remaining_initialize_timeout); 1 external calls (anyhow!).


##### `sleep_with_retry_deadline`  (lines 217–228)

```
async fn sleep_with_retry_deadline(delay: Duration, deadline: Option<Instant>) -> bool
```

**Purpose**: This async helper waits before a retry, but only if doing so still fits inside the overall deadline. It avoids sleeping past the point where the handshake should already have timed out.

**Data flow**: It receives a desired delay and an optional absolute deadline. If there is no deadline, it simply sleeps for the full delay and returns true. If there is a deadline, it checks how much time remains. If no time remains, it returns false immediately. Otherwise, it sleeps, but with a timeout capped by the remaining time. It returns true if the sleep completed and false if the deadline arrived first.

**Call relations**: The connection retry loop calls this between failed streamable HTTP handshake attempts. Another retry path, run_service_operation_with_transient_retries, also uses it for the same pattern: wait before retrying, but never beyond the caller’s time budget.

*Call graph*: called by 2 (run_service_operation_with_transient_retries, connect_pending_transport_with_initialize_retries); 3 external calls (now, sleep, timeout).
