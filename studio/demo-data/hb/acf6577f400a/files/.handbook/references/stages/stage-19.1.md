# Generic HTTP client, TLS, cookies, and streaming transport foundations  `stage-19.1`

This stage is shared behind-the-scenes networking support. It is the set of pipes, valves, and adapters that lets Codex safely talk to web services. The core client files define a common request and response shape, turn JSON or compressed bodies into bytes, send them with reqwest, retry temporary failures with backoff, and decode long-lived Server-Sent Events streams. The library front doors re-export these pieces so other crates use the same tools.

Several files add safety and environment support: custom certificate authorities for company proxies, a narrow Cloudflare cookie jar that avoids sharing private session cookies, and default clients that add tracing, user-agent, proxy, residency, and authentication headers. Backend, ChatGPT, cloud task, remote config, LM Studio, and file-upload clients build on these foundations to call their specific services and translate replies into project types.

The API provider and session code centralize endpoint URLs, headers, retries, telemetry, normal requests, and streaming requests. Endpoint, request, and SSE modules act as organized entry points, while realtime WebSocket helpers translate raw live messages into internal events.

## Files in this stage

### Transport primitives
These files define the shared request model, retry behavior, concrete reqwest transport, SSE decoding, and the crate facade that exposes them.

### `codex-client/src/request.rs`

`io_transport` · `request preparation before network send`

This file is the staging area for outgoing HTTP calls. Before a request can be sent, the client must know its method, URL, headers, body bytes, timeout, and whether the body should be compressed. That sounds simple, but it matters because some authentication systems sign the exact bytes that will be sent. If JSON is serialized twice, or compression happens after signing, the signature could be wrong.

The main type is Request. It starts as a convenient builder: create it with a method and URL, then add JSON, raw bytes, compression, or a timeout. JSON can be kept as a serde_json::Value, which is a general JSON value, or as EncodedJsonBody, meaning it has already been turned into bytes. Bytes are reference-counted, so clones can share the same memory instead of copying the whole body.

The important step is preparation. prepare_body_for_send looks at the body and returns a PreparedRequestBody: final headers plus final bytes. JSON gets a Content-Type header if one is missing. If zstd compression is requested, the JSON bytes are compressed and Content-Encoding is set. Raw bodies are not allowed to use this compression path, because the file cannot safely assume what raw bytes mean.

into_prepared goes one step further. It rewrites the request so it stores the already-prepared bytes. This is useful for retries: like sealing a package once, then sending the same sealed package again if needed.

#### Function details

##### `EncodedJsonBody::encode`  (lines 23–29)

```
fn encode(value: &T) -> Result<Self, serde_json::Error>
```

**Purpose**: Turns any serializable value into JSON bytes once, then stores those bytes in a shareable form. This avoids doing the same JSON conversion again for retries or cloned requests.

**Data flow**: It receives a value that can be written as JSON. It asks serde_json to convert that value into a byte vector, wraps those bytes in Bytes so they can be cheaply shared, marks the body as not yet prepared for sending, and returns either the new EncodedJsonBody or a JSON conversion error.

**Call relations**: Higher-level request flows call this when they need JSON in byte form. prepare_body_for_send uses it for ordinary JSON bodies, stream and stream_request use it before sending streamed requests, and the compression reuse test uses it to build a pre-encoded body.

*Call graph*: called by 4 (stream, stream_request, prepare_body_for_send, into_prepared_stores_compressed_body_for_reuse); 1 external calls (to_vec).


##### `EncodedJsonBody::as_bytes`  (lines 32–34)

```
fn as_bytes(&self) -> &[u8]
```

**Purpose**: Gives read-only access to the JSON bytes currently stored in an EncodedJsonBody. Code uses this when it needs the body contents without taking ownership of them.

**Data flow**: It receives an EncodedJsonBody by reference. It returns a borrowed byte slice pointing at the stored bytes, without copying or changing anything.

**Call relations**: prepare_encoded_json calls this when it needs to feed the body into the zstd compressor. It is the small doorway from the stored body object to the raw bytes used for the final network body.

*Call graph*: called by 1 (prepare_encoded_json).


##### `EncodedJsonBody::trace_bytes`  (lines 36–38)

```
fn trace_bytes(&self) -> &[u8]
```

**Purpose**: Returns the bytes that should be shown in detailed request-body tracing. When compression is used, this can preserve the original readable JSON for logs instead of showing compressed data.

**Data flow**: It reads the optional trace copy stored in the body. If trace bytes exist, it returns them; otherwise it returns the main stored bytes. It does not change the body.

**Call relations**: This is a support hook for tracing code elsewhere in the client. It pairs with into_prepared, which may save original JSON bytes when trace-level logging is enabled.


##### `RequestBody::json`  (lines 56–61)

```
fn json(&self) -> Option<&Value>
```

**Purpose**: Checks whether a request body is still stored as a plain JSON value and, if so, returns it. This is useful for code that needs to inspect structured JSON rather than already-encoded or raw bytes.

**Data flow**: It receives a RequestBody by reference. If the body is the Json variant, it returns a reference to the JSON value; if it is encoded JSON or raw bytes, it returns nothing.

**Call relations**: This is an access helper for callers that care about the high-level JSON form. It does not participate in the send-preparation path, which works with bytes.


##### `PreparedRequestBody::body_bytes`  (lines 71–73)

```
fn body_bytes(&self) -> Bytes
```

**Purpose**: Returns the prepared body bytes, using an empty byte buffer when the request has no body. This gives callers a simple always-bytes answer.

**Data flow**: It reads the optional body field. If bytes are present, it clones the cheap Bytes handle; if no body exists, it returns an empty Bytes value. The PreparedRequestBody itself is unchanged.

**Call relations**: This helper is meant for code that needs bytes regardless of whether the original request had a body, such as signing or transport code. It sits after prepare_body_for_send in the request flow.


##### `Request::new`  (lines 87–96)

```
fn new(method: Method, url: String) -> Self
```

**Purpose**: Creates a basic request with a method and URL, but no headers, body, compression, or timeout. It is the starting point for building an outgoing client request.

**Data flow**: It receives an HTTP method and a URL string. It creates an empty header map, sets the body to none, sets compression to none, leaves the timeout unset, and returns the new Request.

**Call relations**: Tests and other modules start with this function before adding details. The thread configuration request path and direct connector tests also call it when they need a simple request object to build on.

*Call graph*: called by 6 (into_prepared_stores_compressed_body_for_reuse, prepare_body_for_send_rejects_existing_content_encoding_when_compressing, prepare_body_for_send_serializes_json_and_sets_content_type, load_thread_config_request, direct_connector_allows_non_public_target_when_local_binding_enabled, direct_connector_rejects_non_public_target_when_local_binding_disabled); 1 external calls (new).


##### `Request::with_json`  (lines 98–101)

```
fn with_json(mut self, body: &T) -> Self
```

**Purpose**: Adds a JSON body to a request using a convenient builder style. It lets callers pass normal serializable data instead of manually creating a JSON value.

**Data flow**: It takes ownership of a Request and receives a serializable body by reference. It tries to convert that body into a serde_json::Value; if conversion succeeds, it stores it as RequestBody::Json. It returns the updated Request.

**Call relations**: This is usually called after Request::new while constructing a request. Later, prepare_body_for_send will turn this stored JSON value into final bytes and add the JSON content type header.

*Call graph*: 1 external calls (to_value).


##### `Request::with_raw_body`  (lines 103–106)

```
fn with_raw_body(mut self, body: impl Into<Bytes>) -> Self
```

**Purpose**: Adds an already-made byte body to a request. This is for cases where the caller knows exactly what bytes should be sent and does not want JSON serialization.

**Data flow**: It takes ownership of a Request and receives something that can become Bytes. It converts the input into Bytes, stores it as a raw request body, and returns the updated Request.

**Call relations**: This is another builder step after Request::new. When prepare_body_for_send later sees a raw body, it passes those bytes through unchanged and rejects request compression for them.

*Call graph*: 2 external calls (into, Raw).


##### `Request::with_compression`  (lines 108–111)

```
fn with_compression(mut self, compression: RequestCompression) -> Self
```

**Purpose**: Marks the request so its JSON body should be compressed before sending. Currently this supports choosing no compression or zstd compression.

**Data flow**: It takes ownership of a Request and a compression setting. It stores that setting on the request and returns the updated Request.

**Call relations**: Callers use this during request construction. prepare_encoded_json later reads the setting to decide whether to compress the JSON bytes and add a Content-Encoding header.


##### `Request::into_prepared`  (lines 118–149)

```
fn into_prepared(mut self) -> Result<Self, String>
```

**Purpose**: Converts a request into a sealed, ready-to-send form where the body bytes and headers are already finalized. This is important for retries and request signing, because every attempt uses the exact same bytes.

**Data flow**: It takes ownership of a Request. It checks whether the body is JSON-like, optionally keeps original JSON bytes for detailed tracing when compression is enabled, calls prepare_body_for_send to create final headers and body bytes, replaces the request headers and body with those prepared values, clears the compression flag, and returns the updated request or an error string.

**Call relations**: This function sits above prepare_body_for_send. It delegates the actual byte preparation there, then stores the result back into the Request so later transport or retry code can clone and reuse it without re-serializing or re-compressing.

*Call graph*: calls 1 internal fn (prepare_body_for_send); 6 external calls (from, EncodedJson, Raw, matches!, to_vec, enabled!).


##### `Request::prepare_body_for_send`  (lines 156–178)

```
fn prepare_body_for_send(&self) -> Result<PreparedRequestBody, String>
```

**Purpose**: Builds the final headers and body bytes that should be sent, without changing the request. Authentication code can use this to sign exactly what the transport will send.

**Data flow**: It reads the request headers, body, and compression setting. Raw bodies are cloned as-is unless compression was requested, which is rejected. JSON values are encoded into bytes. Already encoded JSON is reused. Missing bodies stay missing. The result is a PreparedRequestBody containing cloned headers plus optional final bytes, or an error string.

**Call relations**: into_prepared calls this when it wants to store final bytes back into the request. Other request-building and authentication paths, including build and apply_auth, call it when they need the final sendable form without mutating the original request.

*Call graph*: calls 2 internal fn (encode, prepare_encoded_json); called by 3 (into_prepared, build, apply_auth); 1 external calls (clone).


##### `Request::prepare_encoded_json`  (lines 180–238)

```
fn prepare_encoded_json(
        &self,
        mut headers: HeaderMap,
        body: &EncodedJsonBody,
    ) -> Result<PreparedRequestBody, String>
```

**Purpose**: Takes JSON that is already in byte form and makes it ready for the wire: optionally compressing it and ensuring the right HTTP headers are present. It is the shared helper for both freshly encoded and previously encoded JSON.

**Data flow**: It receives a copy of the request headers and an EncodedJsonBody. If the body is already marked prepared, it returns those bytes immediately. Otherwise, if compression is requested, it checks that Content-Encoding is not already set, compresses the JSON bytes with zstd, records Content-Encoding: zstd, and logs compression size and timing. Whether compressed or not, it adds Content-Type: application/json if missing, then returns the final headers and bytes.

**Call relations**: prepare_body_for_send calls this whenever it is dealing with JSON bytes. It uses EncodedJsonBody::as_bytes to read bytes for compression and hands the final PreparedRequestBody back up to preparation, signing, or retry flows.

*Call graph*: calls 2 internal fn (as_bytes, new); called by 1 (prepare_body_for_send); 8 external calls (from, contains_key, insert, from_static, now, debug!, unreachable!, encode_all).


##### `tests::prepare_body_for_send_serializes_json_and_sets_content_type`  (lines 249–273)

```
fn prepare_body_for_send_serializes_json_and_sets_content_type()
```

**Purpose**: Verifies that a JSON request is turned into compact JSON bytes and gets an application/json content type. It also checks that the non-mutating preparation step leaves the original request unchanged.

**Data flow**: The test builds a POST request with a small JSON body, calls prepare_body_for_send, then compares the prepared body and headers with expected values. It also inspects the original request afterward to confirm its body and compression setting are still the same.

**Call relations**: This test exercises the normal Request::new plus JSON preparation path. It protects the behavior that callers rely on when they need final send bytes without altering the original request.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, json!).


##### `tests::prepare_body_for_send_rejects_existing_content_encoding_when_compressing`  (lines 276–294)

```
fn prepare_body_for_send_rejects_existing_content_encoding_when_compressing()
```

**Purpose**: Verifies that the code refuses to compress a JSON body when the request already has a Content-Encoding header. This prevents the client from sending confusing or dishonest headers about how the body is encoded.

**Data flow**: The test creates a JSON POST request, asks for zstd compression, manually inserts Content-Encoding: gzip, then calls prepare_body_for_send. It expects an error and checks that the message matches the conflict.

**Call relations**: This test covers the safety check inside prepare_encoded_json through the public prepare_body_for_send path. It confirms that compression does not silently overwrite a caller-supplied encoding header.

*Call graph*: calls 1 internal fn (new); 3 external calls (from_static, assert_eq!, json!).


##### `tests::into_prepared_stores_compressed_body_for_reuse`  (lines 297–321)

```
fn into_prepared_stores_compressed_body_for_reuse()
```

**Purpose**: Verifies that into_prepared stores compressed JSON bytes directly on the request and clears the compression setting afterward. This proves retries can reuse the prepared body instead of compressing again.

**Data flow**: The test encodes a JSON body, builds a POST request with zstd compression, stores the encoded JSON body, and calls into_prepared. It then reads the resulting encoded body, decompresses it to confirm the original JSON is still there, and checks that the request now has the expected Content-Encoding and Content-Type headers with compression set back to none.

**Call relations**: This test exercises EncodedJsonBody::encode, Request::new, and into_prepared together. It protects the sealed-package behavior that later transport and retry code depend on.

*Call graph*: calls 3 internal fn (encode, new, new); 5 external calls (assert_eq!, EncodedJson, json!, panic!, decode_all).


### `codex-client/src/retry.rs`

`io_transport` · `request handling`

Network calls can fail for reasons that are not permanent: a server may be busy, a connection may briefly drop, or a request may time out. This file gives the client a simple retry system so it can pause and try again instead of failing immediately.

The main idea is a retry policy. The policy says how many tries are allowed, how long the first delay should be, and which kinds of failures are worth retrying. For example, it can retry HTTP 429 responses, which usually mean “too many requests,” or HTTP 5xx responses, which usually mean the server had a problem. It can also retry transport problems such as timeouts or network errors.

When a request fails, the code first asks whether that error is retryable. If it is, it waits before trying again. The wait time grows with each attempt, like giving a busy shop more time before knocking again. A small random variation, called jitter, is added so many clients do not all retry at exactly the same moment.

The file’s main function, `run_with_retry`, wraps an operation: it creates a fresh request for each attempt, runs the operation, returns success immediately if it works, or stops with the final error when retries are no longer allowed.

#### Function details

##### `RetryOn::should_retry`  (lines 23–35)

```
fn should_retry(&self, err: &TransportError, attempt: u64, max_attempts: u64) -> bool
```

**Purpose**: This function answers the question: “Given this error and this attempt number, should we try again?” It protects the client from retrying forever and only approves retries for the error types enabled in the retry settings.

**Data flow**: It receives a transport error, the current attempt number, and the maximum number of attempts. It first checks whether the retry limit has already been reached. If not, it looks at the error: selected HTTP 429 responses, selected server-side HTTP 5xx responses, and selected timeout or network failures can be approved for another try. It returns `true` when another attempt should happen, otherwise `false`.

**Call relations**: During `run_with_retry`, whenever an operation fails, this function is consulted before any waiting or retrying happens. Its answer decides whether the flow continues to `backoff` and `sleep`, or whether the error is returned to the caller immediately.


##### `backoff`  (lines 38–47)

```
fn backoff(base: Duration, attempt: u64) -> Duration
```

**Purpose**: This function calculates how long to wait before the next retry. The delay grows as attempts continue, with a small random adjustment so repeated retries are less likely to pile up at the same instant.

**Data flow**: It receives a base delay and an attempt number. For the first retry timing it starts from the base delay; for later attempts it multiplies that delay by a growing power of two. It then applies a random multiplier between 0.9 and 1.1 and returns the final waiting time as a `Duration`.

**Call relations**: `run_with_retry` calls this after `RetryOn::should_retry` says a failed request is worth trying again. The returned duration is handed to Tokio’s `sleep`, which pauses the asynchronous task before the next request attempt.

*Call graph*: called by 1 (run_with_retry); 3 external calls (as_millis, from_millis, rng).


##### `run_with_retry`  (lines 49–73)

```
async fn run_with_retry(
    policy: RetryPolicy,
    mut make_req: impl FnMut() -> Request,
    op: F,
) -> Result<T, TransportError>
```

**Purpose**: This is the main retry wrapper. It repeatedly builds a fresh request, runs the caller’s operation, and either returns the successful result or retries selected failures according to the policy.

**Data flow**: It receives a retry policy, a request-making function, and an operation to run. For each attempt, it asks for a new `Request`, passes that request and the attempt number into the operation, and waits for the result. If the operation succeeds, that result is returned. If it fails with a retryable error, it waits for the calculated backoff delay and tries again. If the error is not retryable, or retries are exhausted, it returns an error.

**Call relations**: This function is the coordinator for the file’s retry behavior. It calls `RetryOn::should_retry` to decide whether a failure deserves another attempt, then calls `backoff` and Tokio’s `sleep` to pause before looping. Code elsewhere in the client would use this function around actual request-sending work so the retry rules are applied consistently.

*Call graph*: calls 1 internal fn (backoff); 1 external calls (sleep).


### `codex-client/src/transport.rs`

`io_transport` · `request handling`

This file is the bridge between “what the Codex client wants to send” and the outside world of HTTP. HTTP is the common web protocol used to talk to APIs. Without this file, higher-level code could build a request, but it would have no standard way to actually send it, receive bytes back, or stream a long-running response.

The central idea is the `HttpTransport` trait, which describes two ways to send a request: `execute` for a normal request that returns the whole response body at once, and `stream` for a response that arrives piece by piece. The concrete implementation here is `ReqwestTransport`, which uses `reqwest`, a Rust HTTP library, under the hood.

Before sending, `ReqwestTransport::build` prepares the request body, headers, method, URL, and optional timeout. After sending, the code checks the HTTP status code. If the server reports success, the response is returned. If the server reports an error, this layer packages the status, headers, URL, and any body text into a `TransportError`, so callers get useful failure details.

The file also includes careful error translation. A timeout becomes a specific timeout error; other `reqwest` failures become network errors. When trace-level logging is enabled, it prints a safe summary of the outgoing request body, avoiding dumping raw bytes directly.

#### Function details

##### `ReqwestTransport::new`  (lines 42–46)

```
fn new(client: reqwest::Client) -> Self
```

**Purpose**: Creates a `ReqwestTransport` from an existing `reqwest::Client`, so the rest of the Codex client can send HTTP requests through a common transport interface. This is useful when setup code has already configured the underlying HTTP client with things like connection settings or default behavior.

**Data flow**: It receives a ready-made `reqwest::Client`. It wraps that client in the project’s `CodexHttpClient` helper, then stores it inside a new `ReqwestTransport`. The result is a transport object that can later build and send requests.

**Call relations**: This is called by setup and feature code that needs a transport, including model listing, response streaming, realtime call creation, conversation compaction, memory summarization, and test paths that hit model endpoints. After construction, later request flows call `execute` or `stream` on the created transport.

*Call graph*: calls 1 internal fn (new); called by 8 (models_client_hits_models_endpoint, compact_conversation_history, create_realtime_call_with_headers, summarize_memories, stream_responses_api, client, handle_call, list_models).


##### `ReqwestTransport::build`  (lines 48–74)

```
fn build(&self, req: Request) -> Result<CodexRequestBuilder, TransportError>
```

**Purpose**: Turns the project’s internal `Request` value into a `CodexRequestBuilder`, which is the object used to configure and send the real HTTP request. It is the place where method, URL, headers, body, and timeout are assembled into sendable form.

**Data flow**: It takes a `Request`. First it asks the request to prepare its body for sending, which may add headers or transform the body into bytes. It then reads the request method, URL, and timeout, creates a request builder from the stored HTTP client, applies the timeout if present, adds the prepared headers, and attaches the prepared body if there is one. It returns the finished builder, or a build error if body preparation failed.

**Call relations**: `execute` and `stream` both call this before any network traffic happens. In the bigger flow, it acts like packing a parcel before delivery: higher-level code provides the request details, `build` packages them correctly, and then the caller sends the packaged request.

*Call graph*: calls 2 internal fn (request, prepare_body_for_send); called by 2 (execute, stream); 1 external calls (from_bytes).


##### `ReqwestTransport::map_error`  (lines 76–82)

```
fn map_error(err: reqwest::Error) -> TransportError
```

**Purpose**: Converts errors from the `reqwest` HTTP library into the project’s own `TransportError` type. This keeps the rest of the client from needing to understand `reqwest` directly.

**Data flow**: It receives a `reqwest::Error`. If that error says the request timed out, it returns `TransportError::Timeout`. Otherwise it turns the original error into text and wraps it as a network error. Nothing else is changed.

**Call relations**: This helper is used when `execute` and `stream` send requests or read response data. It is the translation point between the outside HTTP library and the Codex client’s own error language.

*Call graph*: 3 external calls (is_timeout, to_string, Network).


##### `request_body_for_trace`  (lines 85–94)

```
fn request_body_for_trace(req: &Request) -> String
```

**Purpose**: Creates a readable version of a request body for trace logging, which is very detailed diagnostic logging. It helps developers see what is being sent without treating every body type the same way.

**Data flow**: It reads the body field from a `Request`. For a JSON body, it converts the JSON to text. For an already-encoded JSON body, it reads the trace-safe bytes and decodes them as text as best it can. For a raw byte body, it does not print the contents; it returns a placeholder showing only the byte count. If there is no body, it returns an empty string.

**Call relations**: `execute` and `stream` call this only when trace logging is enabled. It feeds the logging message with a body summary before the request is sent, while avoiding accidental noisy output for raw data.

*Call graph*: 3 external calls (from_utf8_lossy, new, format!).


##### `ReqwestTransport::execute`  (lines 97–127)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Sends a normal HTTP request and waits for the full response body before returning. Callers use this for API calls where the answer is expected as one complete block of bytes.

**Data flow**: It receives a `Request`. If trace logging is enabled, it logs the method, URL, and a readable body summary. It saves the URL for possible error reporting, calls `build` to create a sendable request, sends it, records the status and headers, and reads the whole response body into memory. If the HTTP status is not successful, it tries to turn the body into text and returns a detailed HTTP error. If the status is successful, it returns a `Response` containing the status, headers, and body bytes.

**Call relations**: This is one of the two main actions promised by the `HttpTransport` trait. Higher-level client code calls it when it wants a complete response. Internally it relies on `request_body_for_trace` for optional logging, `build` for request construction, and `map_error` to translate network-library failures into project errors.

*Call graph*: calls 1 internal fn (build); 3 external calls (from_utf8, enabled!, trace!).


##### `ReqwestTransport::stream`  (lines 129–161)

```
async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Sends an HTTP request and returns the response as a stream of byte chunks instead of waiting for the whole body. This is important for long-running or incremental API responses, where data may arrive over time.

**Data flow**: It receives a `Request`. If trace logging is enabled, it logs the method, URL, and body summary. It keeps the URL for error messages, calls `build`, sends the request, and reads the response status and headers. If the status is not successful, it reads the error body as text if possible and returns a detailed HTTP error. If the status is successful, it converts the response body into a stream where each incoming chunk is either bytes or a translated transport error, then returns a `StreamResponse` containing the status, headers, and byte stream.

**Call relations**: This is the streaming counterpart to `execute` in the `HttpTransport` trait. Higher-level code calls it when responses should be consumed piece by piece. Like `execute`, it uses `request_body_for_trace` for optional diagnostics, `build` to prepare the outgoing request, and `map_error` to turn lower-level HTTP failures into the client’s own error type.

*Call graph*: calls 1 internal fn (build); 3 external calls (pin, enabled!, trace!).


### `codex-client/src/sse.rs`

`io_transport` · `request handling for streaming responses`

Some API responses do not arrive all at once. Instead, the server keeps a connection open and sends small pieces as they become ready, like a live news ticker. This file provides the small bridge needed to read that kind of response when it uses Server-Sent Events, commonly called SSE. In SSE, each message can contain a `data:` field; this helper extracts that data and forwards it as normal UTF-8 text.

The main job here is to sit between the low-level byte stream from the transport layer and the rest of the client code, which wants plain strings or a clear error. It starts a background asynchronous task, meaning it runs without blocking the caller. Inside that task, it converts raw bytes into SSE events, waits for the next event, and sends each event's data through a channel. A channel is like a small pipe between tasks: one side sends messages and the other side receives them.

It is deliberately strict about failure. If the stream reports an error, closes unexpectedly, or stays silent longer than the allowed idle timeout, this helper sends one final `StreamError` and then stops. If the receiver has gone away, it also stops quietly because there is nobody left to deliver messages to.

#### Function details

##### `sse_stream`  (lines 12–48)

```
fn sse_stream(
    stream: ByteStream,
    idle_timeout: Duration,
    tx: mpsc::Sender<Result<String, StreamError>>,
)
```

**Purpose**: Starts a background task that reads a byte stream formatted as Server-Sent Events and forwards each event's `data` text through a message channel. It is used when the client expects a long-running streaming response and needs plain text chunks plus clear error reporting.

**Data flow**: It receives three things: a raw `ByteStream` from the network layer, an `idle_timeout` that says how long silence is allowed, and a sending side of a channel for results. It first wraps stream errors into this project's `StreamError` type, then parses the bytes as SSE events. For each valid event, it sends `Ok(text)` through the channel. If parsing fails, the stream ends too early, or no event arrives before the timeout, it sends `Err(StreamError)` once and exits. If the receiving side of the channel is already closed, it exits because there is nowhere useful to send data.

**Call relations**: This function is called by higher-level client code when it has opened a streaming response and wants to consume it as simple text updates. It hands the ongoing work to `tokio::spawn`, so the caller can continue immediately while the background task reads the stream. Inside that task it uses stream mapping to convert low-level errors, `eventsource` parsing to understand SSE framing, `next` to wait for the next event, `timeout` to detect silence, and channel `send` calls to pass either message text or a final error back to the rest of the program.

*Call graph*: 6 external calls (map, next, send, Stream, spawn, timeout).


### `codex-client/src/lib.rs`

`other` · `cross-cutting`

This file does not contain the networking logic itself. Instead, it acts like the reception desk for the `codex-client` crate: callers come here to find the approved tools for making HTTP requests, streaming server-sent events, retrying failed calls, adding custom certificate authorities, handling errors, and collecting request telemetry.

The first group of lines declares the private internal modules, such as request building, retry behavior, transport, and custom certificate support. These are the rooms behind the reception desk. The later `pub use` lines choose which items from those rooms are exposed as the library’s public interface.

This matters because it keeps the rest of the project from needing to know the crate’s internal file layout. A caller can import `CodexHttpClient`, `Request`, `RetryPolicy`, or `sse_stream` from the crate directly, instead of reaching into submodules. That makes the library easier to use and gives maintainers freedom to reorganize internal files later without breaking callers.

One item is deliberately marked as hidden from normal documentation: `build_reqwest_client_for_subprocess_tests`. It is public only so a test helper binary can reuse it. The comment warns ordinary users to use the normal custom certificate client builder instead.


### HTTP client configuration
These files build the reusable outbound client setup around tracing, custom CA handling, and constrained cookie storage for authenticated networking.

### `codex-client/src/chatgpt_cloudflare_cookies.rs`

`io_transport` · `cross-cutting during HTTP client setup and request handling`

When Codex talks to ChatGPT, Cloudflare may set small infrastructure cookies that prove the client has passed bot or routing checks. Reusing those cookies can make later requests work smoothly. But cookies can also contain sensitive account information, so a process-wide shared jar would be dangerous if it stored everything. This file solves that by acting like a strict gatekeeper: it only accepts cookies from approved ChatGPT HTTPS hosts, and only if the cookie name is on a Cloudflare allowlist.

The main type, ChatGptCloudflareCookieStore, wraps reqwest's Jar, which is reqwest's built-in place for storing HTTP cookies. Its set_cookies method first checks that the response came from a safe ChatGPT URL, then filters out every Set-Cookie header except known Cloudflare names. Its cookies method does the reverse when sending a request: it only returns cookies for safe ChatGPT HTTPS URLs, and it strips the outgoing Cookie header down to Cloudflare cookies only.

The public function with_chatgpt_cloudflare_cookie_store plugs this shared store into a reqwest ClientBuilder. The important caution is that the store is global inside the process. Like a shared lobby pass, it is acceptable only because it never keeps personal keys such as login or session cookies.

#### Function details

##### `ChatGptCloudflareCookieStore::set_cookies`  (lines 23–35)

```
fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &HeaderValue>,
        url: &reqwest::Url,
    )
```

**Purpose**: This is called when an HTTP response tries to set cookies. It stores only approved Cloudflare cookies from approved ChatGPT HTTPS URLs, and ignores everything else.

**Data flow**: It receives incoming Set-Cookie headers and the URL they came from. First it checks whether the URL is a valid ChatGPT cookie URL. If not, nothing changes. If the URL is allowed, it filters the headers down to known Cloudflare cookie names and passes only those into the inner cookie jar.

**Call relations**: Reqwest calls this through the CookieStore interface when processing response cookies. It relies on is_chatgpt_cookie_url to reject unsafe origins, uses the Cloudflare header filter before storage, and then hands the safe subset to reqwest's built-in jar.

*Call graph*: calls 1 internal fn (is_chatgpt_cookie_url); 2 external calls (filter, set_cookies).


##### `ChatGptCloudflareCookieStore::cookies`  (lines 37–43)

```
fn cookies(&self, url: &reqwest::Url) -> Option<HeaderValue>
```

**Purpose**: This is called when an HTTP request needs a Cookie header. It returns stored Cloudflare cookies only for approved ChatGPT HTTPS URLs.

**Data flow**: It receives the destination URL. If the URL is not an approved ChatGPT HTTPS URL, it returns no cookies. If it is allowed, it asks the inner jar for cookies and then trims the result so only Cloudflare cookie names remain before returning the header.

**Call relations**: Reqwest calls this through the CookieStore interface before sending requests. It uses is_chatgpt_cookie_url as the first safety check and then draws from reqwest's jar, with only_cloudflare_cookies acting as a final cleanup step before anything leaves the process.

*Call graph*: calls 1 internal fn (is_chatgpt_cookie_url); 1 external calls (cookies).


##### `with_chatgpt_cloudflare_cookie_store`  (lines 52–56)

```
fn with_chatgpt_cloudflare_cookie_store(
    builder: reqwest::ClientBuilder,
) -> reqwest::ClientBuilder
```

**Purpose**: This attaches the shared ChatGPT Cloudflare cookie jar to a reqwest HTTP client builder. Callers use it when they want a client to remember Cloudflare infrastructure cookies across requests.

**Data flow**: It takes a reqwest ClientBuilder as input. It clones the shared reference to the global cookie store, adds it as the client's cookie provider, and returns the updated builder.

**Call relations**: Higher-level client setup code calls this while constructing an HTTP client. It does not inspect cookies itself; it wires the global ChatGptCloudflareCookieStore into reqwest so the store's set_cookies and cookies methods are used later during requests and responses.

*Call graph*: 2 external calls (clone, cookie_provider).


##### `is_chatgpt_cookie_url`  (lines 58–69)

```
fn is_chatgpt_cookie_url(url: &reqwest::Url) -> bool
```

**Purpose**: This decides whether a URL is allowed to use this shared cookie jar. It accepts only HTTPS URLs whose host is one of the approved ChatGPT hosts.

**Data flow**: It reads the URL's scheme, such as https or http, and its host name. If the scheme is not https or there is no host, it returns false. Otherwise it asks the ChatGPT host allowlist whether the host is acceptable and returns that answer.

**Call relations**: Both ChatGptCloudflareCookieStore::set_cookies and ChatGptCloudflareCookieStore::cookies call this before storing or sending anything. It is the first lock on the gate, making sure the cookie jar is not used for unrelated sites or plain unencrypted HTTP.

*Call graph*: calls 1 internal fn (is_allowed_chatgpt_host); called by 2 (cookies, set_cookies); 2 external calls (host_str, scheme).


##### `is_allowed_cloudflare_set_cookie_header`  (lines 71–77)

```
fn is_allowed_cloudflare_set_cookie_header(header: &HeaderValue) -> bool
```

**Purpose**: This checks whether one Set-Cookie header appears to set a Cloudflare cookie that this file is allowed to keep.

**Data flow**: It receives a raw HTTP header value. It tries to read it as text, extracts the cookie name before the first equals sign, and checks that name against the Cloudflare allowlist. It returns true only if all of those steps succeed.

**Call relations**: ChatGptCloudflareCookieStore::set_cookies uses this as the filter before giving headers to the inner jar. It depends on set_cookie_name to identify the cookie and on is_allowed_cloudflare_cookie_name to decide whether the name is safe.

*Call graph*: 1 external calls (to_str).


##### `set_cookie_name`  (lines 79–83)

```
fn set_cookie_name(header: &str) -> Option<&str>
```

**Purpose**: This pulls the cookie name out of a Set-Cookie header string. It is a small parser for the part before the first equals sign.

**Data flow**: It receives a header as plain text. It splits the text at the first equals sign, trims spaces from the name, and returns that name if it is not empty. If the header does not look like a cookie assignment, it returns nothing.

**Call relations**: is_allowed_cloudflare_set_cookie_header uses this helper while deciding whether an incoming cookie should be kept. It keeps that filtering code focused on the safety decision rather than on string parsing details.


##### `only_cloudflare_cookies`  (lines 85–102)

```
fn only_cloudflare_cookies(header: HeaderValue) -> Option<HeaderValue>
```

**Purpose**: This cleans an outgoing Cookie header so it contains only allowed Cloudflare cookies. It is a last safety net before cookies are sent on a request.

**Data flow**: It receives a Cookie header value from the inner jar. It turns it into text, splits it into individual cookies separated by semicolons, keeps only entries whose names are on the Cloudflare allowlist, and rebuilds a new header. If nothing safe remains, it returns no header.

**Call relations**: ChatGptCloudflareCookieStore::cookies uses this after asking reqwest's jar for stored cookies. Even if the jar somehow contains something unexpected, this function prevents non-Cloudflare cookies from being returned to the HTTP client.

*Call graph*: 3 external calls (from_str, split, to_str).


##### `is_allowed_cloudflare_cookie_name`  (lines 104–119)

```
fn is_allowed_cloudflare_cookie_name(name: &str) -> bool
```

**Purpose**: This is the central allowlist of Cloudflare cookie names that are safe to store in the shared jar. Anything not on this list is treated as unsafe for this global store.

**Data flow**: It receives a cookie name as text. It compares the name with the known Cloudflare service cookie names and also allows names that start with the Cloudflare challenge prefix cf_chl_. It returns true for allowed names and false for all others.

**Call relations**: The incoming-cookie filter and outgoing-cookie cleanup both depend on this function. It is the policy point that keeps the shared jar limited to Cloudflare infrastructure cookies rather than user-specific ChatGPT cookies.

*Call graph*: 1 external calls (matches!).


##### `tests::stores_and_returns_cloudflare_cookies_for_chatgpt_hosts`  (lines 128–155)

```
fn stores_and_returns_cloudflare_cookies_for_chatgpt_hosts()
```

**Purpose**: This test proves that valid Cloudflare cookies from a ChatGPT HTTPS host are saved and later returned.

**Data flow**: It creates a fresh store, a ChatGPT URL, and two Cloudflare Set-Cookie headers. After storing them, it asks for cookies for the same URL, sorts the returned cookie strings, and checks that both expected cookie name-value pairs are present.

**Call relations**: This test exercises the normal success path through ChatGptCloudflareCookieStore::set_cookies and ChatGptCloudflareCookieStore::cookies. It shows the intended behavior that the rest of the file is built to support.

*Call graph*: 4 external calls (from_static, assert_eq!, default, parse).


##### `tests::ignores_non_chatgpt_cookies`  (lines 158–166)

```
fn ignores_non_chatgpt_cookies()
```

**Purpose**: This test proves that cookies from non-ChatGPT hosts are not stored, even if their names look like Cloudflare cookies.

**Data flow**: It creates a fresh store, uses an api.openai.com URL, and tries to store a Cloudflare-looking cookie. When it asks for cookies for that URL, it expects nothing back.

**Call relations**: This test checks the host restriction enforced by is_chatgpt_cookie_url through the set_cookies and cookies flow. It confirms that the shared jar is not a general Cloudflare cookie jar for every site.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::ignores_non_cloudflare_cookies_for_chatgpt_hosts`  (lines 169–179)

```
fn ignores_non_cloudflare_cookies_for_chatgpt_hosts()
```

**Purpose**: This test proves that user-session-style cookies from ChatGPT hosts are rejected. That is the key privacy and safety promise of this file.

**Data flow**: It creates a fresh store, uses a ChatGPT URL, and tries to store a cookie named like an authentication session token. Afterward, asking for cookies returns nothing.

**Call relations**: This test exercises the incoming-cookie filter used by ChatGptCloudflareCookieStore::set_cookies. It confirms that an approved host alone is not enough; the cookie name must also be on the Cloudflare allowlist.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::ignores_mixed_non_cloudflare_cookies_for_chatgpt_hosts`  (lines 182–197)

```
fn ignores_mixed_non_cloudflare_cookies_for_chatgpt_hosts()
```

**Purpose**: This test proves that when safe and unsafe cookies arrive together, the safe one is kept and the unsafe one is discarded.

**Data flow**: It creates a fresh store, a ChatGPT URL, one allowed Cloudflare cookie, and one account-like cookie. After storage, it asks for cookies and expects to see only the Cloudflare cookie.

**Call relations**: This test checks the filtering behavior inside ChatGptCloudflareCookieStore::set_cookies. It matters because real HTTP responses can include several cookies at once, and the store must not reject the whole batch or keep too much.

*Call graph*: 4 external calls (from_static, assert_eq!, default, parse).


##### `tests::does_not_return_chatgpt_cloudflare_cookies_for_other_hosts`  (lines 200–210)

```
fn does_not_return_chatgpt_cloudflare_cookies_for_other_hosts()
```

**Purpose**: This test proves that a cookie stored for ChatGPT is not sent to a different host.

**Data flow**: It stores a Cloudflare cookie using a ChatGPT URL, then asks for cookies using an api.openai.com URL. The expected result is no Cookie header.

**Call relations**: This test exercises ChatGptCloudflareCookieStore::cookies and its URL check. It confirms that stored ChatGPT Cloudflare cookies stay tied to allowed ChatGPT destinations.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::rejects_plain_http_chatgpt_cookie_urls`  (lines 213–225)

```
fn rejects_plain_http_chatgpt_cookie_urls()
```

**Purpose**: This test proves that plain HTTP ChatGPT URLs cannot store or receive cookies from this jar. Only encrypted HTTPS is allowed.

**Data flow**: It creates an http:// ChatGPT URL, an https:// version of the same host, and a Cloudflare cookie. It tries to store the cookie through the HTTP URL, then checks that neither the HTTP URL nor the HTTPS URL gets anything back.

**Call relations**: This test covers the scheme check inside is_chatgpt_cookie_url as used by set_cookies and cookies. It protects against accepting cookies from an unencrypted origin and later sending them in a more trusted-looking context.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::only_allows_https_urls`  (lines 228–236)

```
fn only_allows_https_urls()
```

**Purpose**: This test directly checks that the URL filter rejects non-HTTPS schemes.

**Data flow**: It parses a plain HTTP ChatGPT URL and a WebSocket-style wss URL. It passes each into is_chatgpt_cookie_url and expects both to be rejected.

**Call relations**: This test focuses on is_chatgpt_cookie_url without going through the cookie store. It documents that the store's idea of a safe cookie URL is deliberately limited to HTTPS web requests.

*Call graph*: 2 external calls (assert!, parse).


##### `tests::allows_only_known_cloudflare_cookie_names`  (lines 239–263)

```
fn allows_only_known_cloudflare_cookie_names()
```

**Purpose**: This test verifies the cookie-name allowlist. It makes sure known Cloudflare names are accepted and likely account or unrelated names are rejected.

**Data flow**: It loops over allowed names and checks that is_allowed_cloudflare_cookie_name returns true. Then it loops over disallowed names and checks that the same function returns false.

**Call relations**: This test protects the policy encoded in is_allowed_cloudflare_cookie_name. Since both storing and sending cookies depend on that policy, a mistake here could either break Cloudflare flows or leak sensitive user cookies.

*Call graph*: 1 external calls (assert!).


### `codex-client/src/custom_ca.rs`

`io_transport` · `outbound HTTP/websocket client construction`

When Codex connects to HTTPS or secure websocket services, it must decide which certificate authorities, or CAs, it trusts. A CA is an organization or internal system that vouches that a server certificate is legitimate. Normally the operating system supplies this trust list, but many enterprise networks add their own CA so traffic can pass through security gateways. Without this file, some Codex network paths might ignore that custom CA and fail only in those environments.

This module centralizes the rule: first look at CODEX_CA_CERTIFICATE, then fall back to SSL_CERT_FILE, and treat empty values as if they were not set. If a file is selected, it reads the PEM file, which is a text format commonly used for certificates. It accepts ordinary CERTIFICATE blocks, OpenSSL TRUSTED CERTIFICATE blocks, and ignores well-formed certificate revocation list sections. For TRUSTED CERTIFICATE input, it trims off OpenSSL-only extra data before giving the certificate to the TLS library.

The file then builds either a reqwest HTTP client or a rustls websocket TLS configuration with those added roots. If anything is wrong, such as a missing file or malformed certificate, it fails early with a clear message that names the environment variable and file path. Its tests use fake environments so developer machine settings do not accidentally change the result.

#### Function details

##### `Error::from`  (lines 148–161)

```
fn from(error: BuildCustomCaTransportError) -> Self
```

**Purpose**: Turns this module's detailed custom-CA error into a standard input/output error. This lets callers that only understand ordinary I/O errors still receive useful failure information.

**Data flow**: It receives a custom transport-building error. It keeps the original error message, chooses an appropriate broad error kind such as read failure, invalid data, or general failure, and returns a standard io::Error containing the original details.

**Call relations**: This is used when code outside this module wants to treat custom-CA setup failures like normal I/O failures. It does not build clients itself; it translates the error after another function has already failed.

*Call graph*: 2 external calls (new, other).


##### `build_reqwest_client_with_custom_ca`  (lines 179–183)

```
fn build_reqwest_client_with_custom_ca(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Builds a reqwest HTTP client using Codex's shared custom-certificate policy. Callers use it instead of building a raw HTTP client when outbound HTTPS should work behind enterprise proxies.

**Data flow**: It receives a preconfigured reqwest client builder from the caller. It reads the real process environment through ProcessEnv, applies any selected CA bundle, and returns either a ready HTTP client or a clear custom-CA setup error.

**Call relations**: This is the production HTTP entry point in this file. It immediately hands the real work to build_reqwest_client_with_env so the same logic can also be tested with fake environments.

*Call graph*: calls 1 internal fn (build_reqwest_client_with_env).


##### `maybe_build_rustls_client_config_with_custom_ca`  (lines 196–199)

```
fn maybe_build_rustls_client_config_with_custom_ca() -> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError>
```

**Purpose**: Builds a rustls TLS configuration for secure websockets when a custom CA bundle is configured. If no custom CA is requested, it deliberately returns nothing so websocket code can use its normal default path.

**Data flow**: It reads the real process environment. If a CA file is selected, it returns a shared TLS client configuration containing system roots plus the custom roots; if not, it returns Ok(None); if setup fails, it returns a detailed error.

**Call relations**: This is the websocket-facing production entry point. It delegates to maybe_build_rustls_client_config_with_env, which contains the testable selection and loading logic.

*Call graph*: calls 1 internal fn (maybe_build_rustls_client_config_with_env).


##### `build_reqwest_client_for_subprocess_tests`  (lines 209–213)

```
fn build_reqwest_client_for_subprocess_tests(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Builds a reqwest HTTP client for integration tests that run in child processes. It disables proxy auto-detection so tests can focus on custom certificate behavior instead of platform proxy probing.

**Data flow**: It receives a reqwest builder, turns off proxy use on that builder, then applies the same custom-CA environment logic as production. The result is either a test HTTP client or the same kind of setup error production would report.

**Call relations**: This is used by subprocess tests rather than normal Codex runtime code. After changing the builder with no_proxy, it hands off to build_reqwest_client_with_env for the shared certificate work.

*Call graph*: calls 1 internal fn (build_reqwest_client_with_env); 1 external calls (no_proxy).


##### `maybe_build_rustls_client_config_with_env`  (lines 215–262)

```
fn maybe_build_rustls_client_config_with_env(
    env_source: &dyn EnvSource,
) -> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError>
```

**Purpose**: Creates the TLS configuration used by secure websocket clients when an environment variable points to a custom CA bundle. It keeps normal system trust and adds Codex's extra trust on top.

**Data flow**: It receives an environment source, asks it whether a CA bundle is configured, and returns Ok(None) if not. If one is configured, it initializes rustls, loads native system root certificates, reads and parses the custom bundle, adds each parsed certificate to the root store, and returns a shared ClientConfig or an error that names the failing certificate or file.

**Call relations**: The production websocket helper calls this with the real environment, and tests call it with a fake environment. It relies on EnvSource::configured_ca_bundle to choose the file and ConfiguredCaBundle::load_certificates to turn that file into certificate bytes.

*Call graph*: calls 1 internal fn (configured_ca_bundle); called by 3 (maybe_build_rustls_client_config_with_custom_ca, rustls_config_reports_invalid_ca_file, rustls_config_uses_custom_ca_bundle_when_configured); 6 external calls (new, builder, empty, ensure_rustls_crypto_provider, load_native_certs, warn!).


##### `build_reqwest_client_with_env`  (lines 271–343)

```
fn build_reqwest_client_with_env(
    env_source: &dyn EnvSource,
    mut builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Contains the main HTTP-client construction logic in a form that can be tested without changing global environment variables. It preserves the caller's reqwest settings while adding custom CA support when requested.

**Data flow**: It receives an environment source and a reqwest client builder. If no CA file is configured, it simply builds the client with system roots. If a CA file is configured, it selects rustls as the TLS backend, loads certificate bytes from the bundle, registers each certificate with the builder, and then builds the client; each failure is turned into a specific user-facing error.

**Call relations**: Production HTTP setup and subprocess-test setup both call this. It calls EnvSource::configured_ca_bundle for policy, ConfiguredCaBundle::load_certificates for file parsing, and reqwest builder methods to produce the final client.

*Call graph*: calls 1 internal fn (configured_ca_bundle); called by 2 (build_reqwest_client_for_subprocess_tests, build_reqwest_client_with_custom_ca); 8 external calls (add_root_certificate, build, use_rustls_tls, BuildClientWithSystemRoots, ensure_rustls_crypto_provider, info!, from_der, warn!).


##### `EnvSource::non_empty_path`  (lines 362–366)

```
fn non_empty_path(&self, key: &str) -> Option<PathBuf>
```

**Purpose**: Reads one environment value and treats it as a filesystem path only if it is not empty. This prevents an empty variable like CODEX_CA_CERTIFICATE="" from being mistaken for a real file choice.

**Data flow**: It receives an environment variable name, asks the environment source for its value, filters out empty strings, and converts any remaining string into a PathBuf. The output is either a path or no value.

**Call relations**: EnvSource::configured_ca_bundle uses this helper while deciding which CA environment variable wins. Individual environment implementations only provide raw values; this method adds the shared empty-value rule.

*Call graph*: called by 1 (configured_ca_bundle).


##### `EnvSource::configured_ca_bundle`  (lines 373–386)

```
fn configured_ca_bundle(&self) -> Option<ConfiguredCaBundle>
```

**Purpose**: Chooses the CA bundle Codex should use, following the module's precedence rule. CODEX_CA_CERTIFICATE wins over SSL_CERT_FILE because it is the Codex-specific setting.

**Data flow**: It checks CODEX_CA_CERTIFICATE for a non-empty path first. If that is missing or empty, it checks SSL_CERT_FILE. It returns a ConfiguredCaBundle containing both the winning path and the variable name that selected it, or returns nothing if neither applies.

**Call relations**: Both HTTP and websocket setup call this before doing any certificate work. It depends on EnvSource::non_empty_path so production and tests share the same empty-string behavior.

*Call graph*: calls 1 internal fn (non_empty_path); called by 2 (build_reqwest_client_with_env, maybe_build_rustls_client_config_with_env).


##### `ProcessEnv::var`  (lines 397–399)

```
fn var(&self, key: &str) -> Option<String>
```

**Purpose**: Reads an environment variable from the real running process. This is the production implementation of the EnvSource abstraction.

**Data flow**: It receives a variable name, asks the operating system process environment for that value, and returns the string if present and readable. Missing or unreadable values become None.

**Call relations**: The public production builders use ProcessEnv so the shared logic sees real CODEX_CA_CERTIFICATE and SSL_CERT_FILE settings. Tests use MapEnv instead so they can avoid changing process-wide state.

*Call graph*: 1 external calls (var).


##### `ConfiguredCaBundle::load_certificates`  (lines 420–443)

```
fn load_certificates(
        &self,
    ) -> Result<Vec<CertificateDer<'static>>, BuildCustomCaTransportError>
```

**Purpose**: Loads all usable certificates from the selected CA bundle and logs whether that succeeded. It is the high-level file-loading step after environment selection has already picked a path.

**Data flow**: It starts with a ConfiguredCaBundle containing the source environment variable and file path. It calls parse_certificates, logs the certificate count on success or the error on failure, and returns either a list of certificate bytes or the same setup error.

**Call relations**: HTTP and websocket builders call this when they need actual certificates to add to their trust stores. It wraps ConfiguredCaBundle::parse_certificates with consistent logging.

*Call graph*: calls 1 internal fn (parse_certificates); 2 external calls (info!, warn!).


##### `ConfiguredCaBundle::parse_certificates`  (lines 451–497)

```
fn parse_certificates(
        &self,
    ) -> Result<Vec<CertificateDer<'static>>, BuildCustomCaTransportError>
```

**Purpose**: Reads and interprets the selected PEM file, accepting the certificate formats Codex expects to see in real deployments. It extracts certificate blocks while ignoring supported non-certificate sections such as CRLs.

**Data flow**: It reads the file bytes, normalizes the PEM text, walks through each recognized PEM section, keeps certificate sections, trims OpenSSL TRUSTED CERTIFICATE sections when needed, and ignores well-formed CRL sections. It returns certificate DER bytes, or an invalid-file error if parsing fails or no certificates are found.

**Call relations**: ConfiguredCaBundle::load_certificates calls this as the actual parser. It uses read_pem_data for disk access, NormalizedPem::from_pem_data and related methods for PEM compatibility, and pem_parse_error or invalid_ca_file to shape user-facing errors.

*Call graph*: calls 3 internal fn (pem_parse_error, read_pem_data, from_pem_data); called by 1 (load_certificates); 3 external calls (from, new, info!).


##### `ConfiguredCaBundle::read_pem_data`  (lines 504–510)

```
fn read_pem_data(&self) -> Result<Vec<u8>, BuildCustomCaTransportError>
```

**Purpose**: Reads the selected CA bundle file from disk. It keeps the original filesystem error kind so callers can tell, for example, a missing file from another read problem.

**Data flow**: It starts with the configured path, tries to read all bytes from that file, and returns those bytes on success. If reading fails, it returns a ReadCaFile error that includes the source environment variable, path, and original I/O error.

**Call relations**: ConfiguredCaBundle::parse_certificates calls this before any PEM parsing can happen. Later layers use the error it creates to report exactly which configured file could not be read.

*Call graph*: called by 1 (parse_certificates); 1 external calls (read).


##### `ConfiguredCaBundle::pem_parse_error`  (lines 517–524)

```
fn pem_parse_error(&self, error: &pem::Error) -> BuildCustomCaTransportError
```

**Purpose**: Turns a low-level PEM parser error into a clearer configuration error for users. It gives a friendlier message when no certificate blocks are found.

**Data flow**: It receives a PEM parsing error. If the parser found no items, it converts that into 'no certificates found in PEM file'; otherwise it includes the parser's message. It then returns an InvalidCaFile error tied to this bundle.

**Call relations**: ConfiguredCaBundle::parse_certificates calls this when section parsing fails or when the file contains no certificates. It hands off to invalid_ca_file so path and environment details are formatted consistently.

*Call graph*: calls 1 internal fn (invalid_ca_file); called by 1 (parse_certificates); 1 external calls (format!).


##### `ConfiguredCaBundle::invalid_ca_file`  (lines 531–537)

```
fn invalid_ca_file(&self, detail: impl std::fmt::Display) -> BuildCustomCaTransportError
```

**Purpose**: Creates the standard error used when a configured CA file can be read but is not usable. This keeps all invalid-file messages tied to the selected environment variable and path.

**Data flow**: It receives a human-readable detail message, combines it with this bundle's source environment variable and path, and returns an InvalidCaFile error. It does not read or parse anything itself.

**Call relations**: ConfiguredCaBundle::pem_parse_error and some parser branches in ConfiguredCaBundle::parse_certificates use this helper whenever they need to report malformed or unusable CA data.

*Call graph*: called by 1 (pem_parse_error); 2 external calls (to_string, clone).


##### `NormalizedPem::from_pem_data`  (lines 577–592)

```
fn from_pem_data(source_env: &'static str, path: &Path, pem_data: &[u8]) -> Self
```

**Purpose**: Converts raw PEM file bytes into text shaped for the parser this module uses. In particular, it rewrites OpenSSL TRUSTED CERTIFICATE labels into ordinary CERTIFICATE labels while remembering that trimming may be needed later.

**Data flow**: It receives the source environment name, file path, and raw file bytes. It decodes the bytes as text, looks for TRUSTED CERTIFICATE labels, optionally replaces those labels, logs that normalization happened, and returns either a Standard or TrustedCertificate normalized PEM value.

**Call relations**: ConfiguredCaBundle::parse_certificates calls this after reading the file. The returned NormalizedPem later supplies sections and decides whether certificate DER bytes must be trimmed.

*Call graph*: called by 1 (parse_certificates); 4 external calls (Standard, TrustedCertificate, from_utf8_lossy, info!).


##### `NormalizedPem::contents`  (lines 595–599)

```
fn contents(&self) -> &str
```

**Purpose**: Returns the normalized PEM text regardless of which variant produced it. This lets later code read the contents without caring whether labels were rewritten.

**Data flow**: It receives a NormalizedPem value by reference and returns a string slice pointing at its stored text. Nothing is copied or changed.

**Call relations**: NormalizedPem::sections calls this before passing the text to the PEM section iterator. It is a small helper that hides the Standard-versus-TrustedCertificate distinction for plain text access.

*Call graph*: called by 1 (sections).


##### `NormalizedPem::sections`  (lines 606–608)

```
fn sections(&self) -> impl Iterator<Item = Result<PemSection, pem::Error>> + '_
```

**Purpose**: Provides an iterator over the recognized PEM sections in the normalized text. A PEM section is one BEGIN/END block, such as a certificate or a certificate revocation list.

**Data flow**: It takes the normalized text, converts it to bytes, and asks the PEM parser to produce section results one by one. Each item is either a section kind with decoded bytes or a parsing error.

**Call relations**: ConfiguredCaBundle::parse_certificates uses this iterator to walk through the bundle. It relies on NormalizedPem::contents to get the actual text.

*Call graph*: calls 1 internal fn (contents); 1 external calls (pem_slice_iter).


##### `NormalizedPem::certificate_der`  (lines 615–620)

```
fn certificate_der(&self, der: &'a [u8]) -> Option<&'a [u8]>
```

**Purpose**: Returns the certificate bytes that should be registered as a trusted root. For ordinary certificates it keeps the bytes as-is; for OpenSSL trusted certificates it removes trailing OpenSSL-only metadata.

**Data flow**: It receives decoded bytes from one certificate PEM section. If the PEM was standard, it returns the whole byte slice. If the PEM came from TRUSTED CERTIFICATE labels, it asks first_der_item to find the first DER object and returns only that prefix, or None if the boundary cannot be found.

**Call relations**: ConfiguredCaBundle::parse_certificates calls this for each certificate section before storing it. It delegates the low-level DER boundary calculation to first_der_item.

*Call graph*: calls 1 internal fn (first_der_item).


##### `first_der_item`  (lines 635–637)

```
fn first_der_item(der: &[u8]) -> Option<&[u8]>
```

**Purpose**: Finds the first complete DER-encoded object inside a byte slice. This is used to cut a certificate away from any trailing OpenSSL trust metadata.

**Data flow**: It receives bytes that should start with a DER object. It asks der_item_length for the length of that first object and, if successful, returns a slice covering only those bytes.

**Call relations**: NormalizedPem::certificate_der calls this only for OpenSSL TRUSTED CERTIFICATE input. It does not validate the certificate itself; it only finds the safe slice boundary before reqwest or rustls does real certificate parsing.

*Call graph*: calls 1 internal fn (der_item_length); called by 1 (certificate_der).


##### `der_item_length`  (lines 663–687)

```
fn der_item_length(der: &[u8]) -> Option<usize>
```

**Purpose**: Calculates how many bytes the first DER object occupies. DER is a binary format where the first bytes say how long the object is.

**Data flow**: It receives a byte slice, reads the DER length field in either short or long form, checks for invalid or overflowing lengths, and returns the total object size if it fits inside the input. Malformed or incomplete input returns None.

**Call relations**: first_der_item depends on this to safely trim OpenSSL TRUSTED CERTIFICATE data. No higher-level client-building code calls it directly.

*Call graph*: called by 1 (first_der_item); 1 external calls (from).


##### `tests::MapEnv::var`  (lines 711–713)

```
fn var(&self, key: &str) -> Option<String>
```

**Purpose**: Provides environment-variable values from an in-memory map for tests. This lets tests check precedence rules without touching the real process environment.

**Data flow**: It receives a variable name, looks it up in the map, and returns a cloned string if present. Missing keys return None.

**Call relations**: Test helpers and test cases use MapEnv wherever production code would use ProcessEnv. This feeds fake values into EnvSource::configured_ca_bundle and the rustls config builder.


##### `tests::map_env`  (lines 716–723)

```
fn map_env(pairs: &[(&str, &str)]) -> MapEnv
```

**Purpose**: Builds a fake test environment from a small list of key-value pairs. It keeps test setup short and easy to read.

**Data flow**: It receives a slice of string pairs, copies them into a HashMap, and returns a MapEnv containing that map.

**Call relations**: The environment-selection tests and rustls-config tests call this before invoking the same EnvSource methods used by production logic.


##### `tests::write_cert_file`  (lines 725–731)

```
fn write_cert_file(temp_dir: &TempDir, name: &str, contents: &str) -> PathBuf
```

**Purpose**: Writes certificate fixture text into a temporary file for tests. This gives tests a real path to pass through the normal file-reading code.

**Data flow**: It receives a temporary directory, a file name, and file contents. It writes the contents to that file, panics with a helpful message if writing fails, and returns the file path.

**Call relations**: The rustls tests call this to create valid or invalid CA bundle files. Those paths are then placed into a fake environment made by tests::map_env.

*Call graph*: 2 external calls (path, write).


##### `tests::ca_path_prefers_codex_env`  (lines 734–744)

```
fn ca_path_prefers_codex_env()
```

**Purpose**: Checks that CODEX_CA_CERTIFICATE takes priority over SSL_CERT_FILE. This protects the Codex-specific override behavior.

**Data flow**: It builds a fake environment containing both variables, asks for the configured bundle, and asserts that the chosen path is the CODEX_CA_CERTIFICATE path.

**Call relations**: This test exercises EnvSource::configured_ca_bundle through MapEnv. It focuses only on selection logic, not file parsing or client construction.

*Call graph*: 2 external calls (assert_eq!, map_env).


##### `tests::ca_path_falls_back_to_ssl_cert_file`  (lines 747–754)

```
fn ca_path_falls_back_to_ssl_cert_file()
```

**Purpose**: Checks that SSL_CERT_FILE is used when the Codex-specific variable is absent. This supports common TLS tooling conventions without requiring a Codex-only setting.

**Data flow**: It builds a fake environment with only SSL_CERT_FILE, asks for the configured bundle, and asserts that the SSL_CERT_FILE path is selected.

**Call relations**: This test uses tests::map_env and the EnvSource selection logic. It verifies the fallback branch that HTTP and websocket builders rely on.

*Call graph*: 2 external calls (assert_eq!, map_env).


##### `tests::ca_path_ignores_empty_values`  (lines 757–767)

```
fn ca_path_ignores_empty_values()
```

**Purpose**: Checks that an empty CODEX_CA_CERTIFICATE does not block the SSL_CERT_FILE fallback. This prevents empty environment variables from being treated as real paths.

**Data flow**: It creates a fake environment where CODEX_CA_CERTIFICATE is an empty string and SSL_CERT_FILE has a real-looking path. It asks for the configured bundle and asserts that the fallback path is chosen.

**Call relations**: This test covers EnvSource::non_empty_path as used by EnvSource::configured_ca_bundle. It protects the empty-string rule used by both production client builders.

*Call graph*: 2 external calls (assert_eq!, map_env).


##### `tests::rustls_config_uses_custom_ca_bundle_when_configured`  (lines 770–780)

```
fn rustls_config_uses_custom_ca_bundle_when_configured()
```

**Purpose**: Checks that the websocket TLS configuration path actually builds a config when a valid custom CA bundle is provided. This confirms more than just environment selection: it also exercises file loading and certificate registration.

**Data flow**: It creates a temporary CA file from a test certificate, puts that path in a fake CODEX_CA_CERTIFICATE environment, calls the rustls config builder, and asserts that a config is returned with expected normal TLS behavior enabled.

**Call relations**: This test calls maybe_build_rustls_client_config_with_env directly with MapEnv. That drives the same parsing and rustls root-store setup used by the production websocket helper.

*Call graph*: calls 1 internal fn (maybe_build_rustls_client_config_with_env); 4 external calls (new, assert!, map_env, write_cert_file).


##### `tests::rustls_config_reports_invalid_ca_file`  (lines 783–794)

```
fn rustls_config_reports_invalid_ca_file()
```

**Purpose**: Checks that an invalid custom CA file produces the expected structured error. This protects the user-facing failure path for bad or empty CA bundles.

**Data flow**: It writes an empty PEM file, points fake CODEX_CA_CERTIFICATE at it, calls the rustls config builder, and asserts that the result is an InvalidCaFile error.

**Call relations**: This test calls maybe_build_rustls_client_config_with_env and reaches ConfiguredCaBundle parsing through the normal flow. It verifies that malformed input fails early instead of silently producing a bad TLS configuration.

*Call graph*: calls 1 internal fn (maybe_build_rustls_client_config_with_env); 4 external calls (new, assert!, map_env, write_cert_file).


### `codex-client/src/default_client.rs`

`io_transport` · `request handling`

This file is a small but important layer around reqwest, the Rust library used here for making HTTP requests. Its job is to make outgoing web calls behave consistently across the project. Instead of every caller remembering how to add tracing information or log request results, they use CodexHttpClient and CodexRequestBuilder.

The main idea is simple: CodexHttpClient starts a request, and CodexRequestBuilder lets the caller add details such as headers, a bearer token, a timeout, JSON data, or a raw body. When send is finally called, the wrapper adds trace headers. These headers carry the identity of the current tracing span, which is like putting a tracking label on a package so another service can connect its logs back to this request. Then it sends the request and writes a debug log with the method, URL, status, and either response details or the error.

The file also includes a tiny adapter, HeaderMapInjector, that lets OpenTelemetry, a standard tracing system, write trace values into an HTTP header map. A test checks that the trace headers really come from the current span, so distributed tracing does not silently break.

#### Function details

##### `CodexHttpClient::new`  (lines 22–24)

```
fn new(inner: reqwest::Client) -> Self
```

**Purpose**: Creates a CodexHttpClient from an existing reqwest client. This lets the rest of the project use the shared wrapper while still relying on reqwest for the actual network work.

**Data flow**: It receives a configured reqwest::Client as input. It stores that client inside a new CodexHttpClient. The result is a reusable HTTP client wrapper that can start requests.

**Call relations**: Other setup code creates the underlying reqwest client and then calls this function to wrap it. Later flows such as client creation and timeout-related tests depend on this wrapped client before any GET or POST request can be built.

*Call graph*: called by 3 (new, create_client, revoke_request_times_out).


##### `CodexHttpClient::get`  (lines 26–31)

```
fn get(&self, url: U) -> CodexRequestBuilder
```

**Purpose**: Starts building a GET request, which is normally used to fetch information from a URL. It gives callers a project-specific request builder instead of exposing raw reqwest behavior directly.

**Data flow**: It receives a URL-like value. It passes that URL and the GET method into CodexHttpClient::request. The output is a CodexRequestBuilder that can be further customized and then sent.

**Call relations**: When code such as hydrate_personal_access_token needs to fetch data, it calls this method. This method immediately hands off to CodexHttpClient::request so all request setup follows the same path as other HTTP methods.

*Call graph*: calls 1 internal fn (request); called by 1 (hydrate_personal_access_token).


##### `CodexHttpClient::post`  (lines 33–38)

```
fn post(&self, url: U) -> CodexRequestBuilder
```

**Purpose**: Starts building a POST request, which is normally used to submit data or trigger an action on a server. It keeps POST requests on the same traced and logged path as other requests.

**Data flow**: It receives a URL-like value. It combines that URL with the POST method by calling CodexHttpClient::request. The result is a CodexRequestBuilder ready for headers, authentication, body data, and sending.

**Call relations**: Token-related flows such as request_chatgpt_token_refresh and revoke_oauth_token call this when they need to send data to a server. Like get, it delegates to CodexHttpClient::request for the shared setup.

*Call graph*: calls 1 internal fn (request); called by 2 (request_chatgpt_token_refresh, revoke_oauth_token).


##### `CodexHttpClient::request`  (lines 40–46)

```
fn request(&self, method: Method, url: U) -> CodexRequestBuilder
```

**Purpose**: Creates the common request builder for any HTTP method. This is the shared doorway that records the method and URL so the eventual send can add trace headers and useful logs.

**Data flow**: It receives an HTTP method and a URL-like value. It asks the inner reqwest client to create a raw request builder, also saves a string copy of the URL and the method. It returns a CodexRequestBuilder containing both the raw builder and the extra information needed for logging.

**Call relations**: CodexHttpClient::get and CodexHttpClient::post both call this, and other builder-style code can call it too. It hands the raw reqwest builder to CodexRequestBuilder::new, which packages it into the project’s wrapper.

*Call graph*: calls 1 internal fn (new); called by 3 (get, post, build); 3 external calls (clone, as_str, request).


##### `CodexRequestBuilder::new`  (lines 58–64)

```
fn new(builder: reqwest::RequestBuilder, method: Method, url: String) -> Self
```

**Purpose**: Packages a raw reqwest request builder together with the request method and URL. The method and URL are kept so send can later write meaningful logs.

**Data flow**: It receives a reqwest::RequestBuilder, an HTTP method, and a URL string. It stores all three in a CodexRequestBuilder. Nothing is sent yet; the output is only a prepared request object.

**Call relations**: CodexHttpClient::request calls this after reqwest has created the underlying request. From there, callers can chain builder methods such as header, json, timeout, or send.

*Call graph*: called by 1 (request).


##### `CodexRequestBuilder::map`  (lines 66–72)

```
fn map(self, f: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder) -> Self
```

**Purpose**: Applies one change to the underlying reqwest request builder while preserving the saved method and URL. It is a small helper that keeps all the chainable builder methods consistent.

**Data flow**: It receives the current CodexRequestBuilder and a function that knows how to modify the inner reqwest builder. It runs that function, keeps the same method and URL, and returns a new CodexRequestBuilder with the changed inner builder.

**Call relations**: The public builder methods headers, header, bearer_auth, timeout, json, and body all call this. It is the common hinge that lets each customization change only the request details it cares about.

*Call graph*: called by 6 (bearer_auth, body, header, headers, json, timeout).


##### `CodexRequestBuilder::headers`  (lines 74–76)

```
fn headers(self, headers: HeaderMap) -> Self
```

**Purpose**: Adds a whole set of HTTP headers to the request. Headers are small name-value pieces of metadata, such as content type or authorization information.

**Data flow**: It receives a HeaderMap containing several headers. It passes a change function into CodexRequestBuilder::map, which applies those headers to the inner reqwest builder. The result is a new request builder with those headers attached.

**Call relations**: Callers use this while preparing a request before send. Internally it relies on map so it does not need to repeat the wrapping logic.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::header`  (lines 78–86)

```
fn header(self, key: K, value: V) -> Self
```

**Purpose**: Adds one HTTP header to the request. This is useful when the caller only needs to set a single piece of request metadata.

**Data flow**: It receives a header name and value in types that can be converted into valid HTTP header forms. It uses map to apply that single header to the inner reqwest builder. It returns a new builder with the header included.

**Call relations**: This is part of the chain used before send, alongside methods like bearer_auth and json. It delegates the actual builder transformation to CodexRequestBuilder::map.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::bearer_auth`  (lines 88–93)

```
fn bearer_auth(self, token: T) -> Self
```

**Purpose**: Adds bearer token authentication to the request. A bearer token is like a temporary pass that the server checks to decide whether the request is allowed.

**Data flow**: It receives a token value that can be displayed as text. It uses map to tell reqwest to add the standard bearer authorization header. It returns a new builder carrying that authentication information.

**Call relations**: Code that talks to protected APIs calls this before send. The method uses map so authentication is added without losing the stored method and URL used later for logging.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::timeout`  (lines 95–97)

```
fn timeout(self, timeout: Duration) -> Self
```

**Purpose**: Sets how long the request is allowed to wait before giving up. This prevents a stuck network call from hanging forever.

**Data flow**: It receives a Duration, meaning an amount of time. It uses map to apply that timeout to the inner reqwest request builder. The output is a request builder that will fail if the request takes too long.

**Call relations**: Callers add this before send when a request needs its own time limit. It relies on CodexRequestBuilder::map for the shared builder update pattern.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::json`  (lines 99–104)

```
fn json(self, value: &T) -> Self
```

**Purpose**: Sets the request body to JSON data. JSON is a common text format used to send structured data such as objects and lists to web APIs.

**Data flow**: It receives a reference to a value that can be serialized, meaning turned into a transferable format. It uses map to ask reqwest to encode that value as JSON in the request body. The returned builder is ready to send that JSON payload.

**Call relations**: Callers use this before send when posting structured data. It hands the actual request modification to map, keeping this wrapper’s behavior consistent with other builder methods.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::body`  (lines 106–111)

```
fn body(self, body: B) -> Self
```

**Purpose**: Sets the request body directly. This is used when the caller already has the exact bytes or body format to send.

**Data flow**: It receives something that can become a reqwest body. It uses map to attach that body to the inner request builder. It returns a new builder containing the raw body data.

**Call relations**: This is another pre-send customization method. Like json, header, and timeout, it uses CodexRequestBuilder::map so the request’s saved method and URL are preserved.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::send`  (lines 113–141)

```
async fn send(self) -> Result<Response, reqwest::Error>
```

**Purpose**: Sends the prepared HTTP request. Just before sending, it adds tracing headers, then logs either the successful response details or the failure details.

**Data flow**: It receives the completed builder. It calls trace_headers to create headers from the current tracing span, attaches those headers to the request, and awaits the network response. On success it returns the response and writes a debug log with status and response metadata. On failure it returns the reqwest error and writes a debug log with the error and any available status code.

**Call relations**: This is the final step after callers build a request with get, post, and optional customization methods. It calls trace_headers so downstream services can connect this request to the current trace, then relies on reqwest to perform the actual network send.

*Call graph*: calls 1 internal fn (trace_headers); 2 external calls (headers, debug!).


##### `HeaderMapInjector::set`  (lines 147–154)

```
fn set(&mut self, key: &str, value: String)
```

**Purpose**: Lets OpenTelemetry write one tracing value into an HTTP header map. It translates plain text key-value tracing data into valid HTTP header names and values.

**Data flow**: It receives a header key and value from the tracing system. It tries to convert the key into a HeaderName and the value into a HeaderValue. If both conversions are valid, it inserts them into the HeaderMap; if either is invalid, it skips that entry.

**Call relations**: trace_headers gives this injector to the OpenTelemetry propagator. The propagator calls set for each trace header it wants to add, and this adapter makes those values fit the HTTP header storage type.

*Call graph*: 2 external calls (from_bytes, from_str).


##### `trace_headers`  (lines 157–166)

```
fn trace_headers() -> HeaderMap
```

**Purpose**: Builds the HTTP headers needed to carry the current trace context to another service. This is what lets logs and traces from separate services be connected into one request story.

**Data flow**: It starts with an empty HeaderMap. It asks the global OpenTelemetry text-map propagator to inject the current tracing span’s context into that map through HeaderMapInjector. It returns the filled HeaderMap, which may contain headers such as trace identifiers.

**Call relations**: CodexRequestBuilder::send calls this immediately before sending a request. The test inject_trace_headers_uses_current_span_context also calls it to prove it uses the currently active span.

*Call graph*: called by 2 (send, inject_trace_headers_uses_current_span_context); 2 external calls (new, get_text_map_propagator).


##### `tests::inject_trace_headers_uses_current_span_context`  (lines 182–205)

```
fn inject_trace_headers_uses_current_span_context()
```

**Purpose**: Checks that trace_headers uses the active tracing span, not some unrelated or empty context. This protects distributed tracing from silently losing the link between caller and callee.

**Data flow**: The test installs a trace-context propagator, creates a tracer and tracing subscriber, enters a span, and records that span’s trace identifiers. It then calls trace_headers, extracts the trace information back out of the headers, and compares it with the original span. The test passes only if the extracted trace ID and span ID match the active span.

**Call relations**: This test drives trace_headers in a controlled tracing setup. It uses HeaderMapExtractor to read the produced headers back in the format expected by OpenTelemetry, then uses assertions to verify the round trip.

*Call graph*: calls 1 internal fn (trace_headers); 8 external calls (builder, new, assert!, assert_eq!, set_text_map_propagator, trace_span!, layer, registry).


##### `tests::HeaderMapExtractor::get`  (lines 210–212)

```
fn get(&self, key: &str) -> Option<&str>
```

**Purpose**: Reads one header value from a HeaderMap for the test tracing extractor. It gives OpenTelemetry a simple way to look up a header by name.

**Data flow**: It receives a header key as text. It looks up that key in the stored HeaderMap and tries to view the value as valid text. It returns the text value if present and readable, or nothing if the header is missing or not valid text.

**Call relations**: The test’s OpenTelemetry propagator calls this while extracting trace information from the headers made by trace_headers. It is the read-side partner to HeaderMapInjector::set.


##### `tests::HeaderMapExtractor::keys`  (lines 214–216)

```
fn keys(&self) -> Vec<&str>
```

**Purpose**: Lists all header names in the test HeaderMap. This lets the OpenTelemetry extractor discover which tracing headers are available.

**Data flow**: It reads the keys from the stored HeaderMap, converts each header name to text, and collects them into a list. The result is a list of header names for the extractor to inspect.

**Call relations**: The trace extraction code in the test can call this when it needs to know what headers exist. Together with tests::HeaderMapExtractor::get, it lets the test verify the headers produced by trace_headers.


### `login/src/auth/default_client.rs`

`io_transport` · `cross-cutting network client setup`

This file is the shared “front desk badge maker” for Codex network traffic. Before Codex sends HTTP requests, those requests need consistent labels: who is sending them, what app version and operating system they came from, and sometimes whether requests must stay in a required region such as the US. Without this file, different parts of Codex could send inconsistent or missing headers, which would make traffic harder to route, debug, authorize, or audit.

The central idea is an originator: a short name for the Codex client, such as the CLI or another first-party client. The file stores a process-wide default originator and lets startup code set it once. It also builds a User-Agent header, which is a standard HTTP label describing the software making the request. The code adds version, operating system, architecture, terminal information, and an optional suffix. Because HTTP headers cannot contain arbitrary characters, the user agent is checked and cleaned before use.

Finally, the file creates reqwest clients, where reqwest is the Rust HTTP library used here. It adds default headers, optional custom certificate authority support, a Cloudflare cookie store for ChatGPT traffic, and disables proxies in a specific sandbox mode. Higher-level Codex code can ask for either a raw reqwest client or a wrapped CodexHttpClient and get consistent behavior everywhere.

#### Function details

##### `get_originator_value`  (lines 57–76)

```
fn get_originator_value(provided: Option<String>) -> Originator
```

**Purpose**: Chooses the originator string that will identify this Codex process in HTTP headers. It prefers an internal environment-variable override, then a provided value, and finally the built-in default.

**Data flow**: It takes an optional originator string. It also reads the CODEX_INTERNAL_ORIGINATOR_OVERRIDE environment variable. It tries to turn the chosen string into a valid HTTP header value; if that fails, it logs an error and falls back to the safe default originator. It returns an Originator containing both the plain text and the prepared header value.

**Call relations**: This is the helper behind originator selection. set_default_originator uses it when startup code supplies a custom name, and originator uses it when code later asks, “what should this process call itself?”

*Call graph*: called by 2 (originator, set_default_originator); 4 external calls (from_static, from_str, var, error!).


##### `set_default_originator`  (lines 78–91)

```
fn set_default_originator(value: String) -> Result<(), SetOriginatorError>
```

**Purpose**: Sets the process-wide default originator once, usually during startup. This prevents later code from accidentally changing the identity used in outgoing requests.

**Data flow**: It receives a proposed originator string. First it checks that the string can legally be used as an HTTP header value. Then it builds the full Originator and writes it into a global lock-protected slot, but only if that slot is still empty. It returns success, or an error if the value is invalid or the originator was already set.

**Call relations**: Startup flows such as initialize and run_main call this before clients are built. After that, originator and default_headers read the stored value so network requests use the same identity.

*Call graph*: calls 1 internal fn (get_originator_value); called by 2 (initialize, run_main); 1 external calls (from_str).


##### `set_default_client_residency_requirement`  (lines 93–99)

```
fn set_default_client_residency_requirement(enforce_residency: Option<ResidencyRequirement>)
```

**Purpose**: Stores an optional residency requirement for default HTTP clients. A residency requirement tells services that requests should be treated as belonging to a particular region, currently the US.

**Data flow**: It receives either a residency requirement or nothing. It writes that value into a global lock-protected slot. If the lock cannot be acquired, it logs a warning and leaves the previous setting unchanged.

**Call relations**: Configuration and app startup paths call this when they learn the desired residency policy. Later, default_headers reads the stored value and adds the matching HTTP header to new clients.

*Call graph*: called by 6 (sync_default_client_residency_requirement, initialize, run_main, run_main, run_main, run_ratatui_app); 1 external calls (warn!).


##### `originator`  (lines 101–120)

```
fn originator() -> Originator
```

**Purpose**: Returns the originator that should be used right now. It hides the details of stored defaults, environment overrides, and safe fallback behavior.

**Data flow**: It first tries to read the cached global originator. If one exists, it returns a clone of it. If an internal environment override is present, it builds and caches that originator if possible. If nothing has been set, it computes an originator from the default rules and returns it.

**Call relations**: Many parts of Codex call this when they need to label requests, metadata, plugin information, or connector behavior. It delegates the actual choice and header conversion to get_originator_value.

*Call graph*: calls 1 internal fn (get_originator_value); called by 21 (codex_app_metadata, codex_plugin_metadata, ingest_skill_invoked, connectors_for_plugin_apps, merge_and_filter_plugin_connectors, merge_connectors_with_accessible, list_accessible_connectors_from_mcp_tools_with_mcp_manager, list_tool_suggest_discoverable_tools_with_auth, refresh_accessible_connectors_cache_from_mcp_tools, maybe_prompt_and_install_mcp_dependencies (+11 more)); 1 external calls (var).


##### `is_first_party_originator`  (lines 122–127)

```
fn is_first_party_originator(originator_value: &str) -> bool
```

**Purpose**: Answers whether an originator name belongs to a recognized first-party Codex client. This is used when behavior should be trusted or simplified for official Codex clients.

**Data flow**: It receives an originator string and compares it with known official names and a known prefix pattern. It returns true for recognized first-party names and false otherwise.

**Call relations**: The MCP dependency installation prompt uses this check to decide whether the current client should be treated as an official Codex originator.

*Call graph*: called by 1 (maybe_prompt_and_install_mcp_dependencies).


##### `is_first_party_chat_originator`  (lines 129–131)

```
fn is_first_party_chat_originator(originator_value: &str) -> bool
```

**Purpose**: Answers whether an originator name belongs to a recognized first-party ChatGPT-style client. This helps gate connector access based on the client family.

**Data flow**: It receives an originator string and checks it against the known ChatGPT-related originator names. It returns a simple yes-or-no result.

**Call relations**: Connector permission code calls this when deciding whether a connector ID is allowed for the current originator.

*Call graph*: called by 1 (is_connector_id_allowed_for_originator).


##### `get_codex_user_agent`  (lines 133–157)

```
fn get_codex_user_agent() -> String
```

**Purpose**: Builds the User-Agent text sent with Codex HTTP requests. This text tells the server which Codex client, version, operating system, architecture, and terminal environment made the request.

**Data flow**: It reads the package version, operating system details, terminal user-agent information, the current originator, and an optional global suffix. It combines those pieces into one string, trims and formats the suffix if present, then sends the result through sanitize_user_agent. It returns a safe user-agent string ready for an HTTP header.

**Call relations**: Initialization, authentication, backend setup, ChatGPT header construction, and default_headers call this when they need the standard Codex user agent. It relies on originator for the client identity and sanitize_user_agent for safety.

*Call graph*: calls 2 internal fn (originator, sanitize_user_agent); called by 5 (initialize, from_auth, init_backend, build_chatgpt_headers, default_headers); 3 external calls (env!, format!, get).


##### `sanitize_user_agent`  (lines 164–189)

```
fn sanitize_user_agent(candidate: String, fallback: &str) -> String
```

**Purpose**: Makes sure a proposed User-Agent string is legal for use as an HTTP header. If it contains invalid characters, it tries to clean it rather than failing the whole request setup.

**Data flow**: It receives a candidate user-agent string and a fallback string. If the candidate is already valid, it returns it unchanged. Otherwise, it replaces non-standard characters with underscores and checks again. If that still fails, it falls back to the base user-agent string, and if even that is invalid, it falls back to the originator value.

**Call relations**: get_codex_user_agent calls this as the final safety step before the user-agent text is used by default_headers. It logs warnings when it has to clean or replace the candidate string.

*Call graph*: calls 1 internal fn (originator); called by 1 (get_codex_user_agent); 2 external calls (from_str, warn!).


##### `create_client`  (lines 192–195)

```
fn create_client() -> CodexHttpClient
```

**Purpose**: Creates the standard wrapped Codex HTTP client for callers that do not need to work directly with reqwest. This is the convenient default for most Codex network code.

**Data flow**: It builds a configured reqwest client using build_reqwest_client. Then it wraps that lower-level client in CodexHttpClient and returns the wrapper.

**Call relations**: Authentication, update checks, event tracking, token revocation, release fetching, and test helpers call this when they need a ready-to-use Codex client. It hands off the lower-level setup to build_reqwest_client.

*Call graph*: calls 2 internal fn (new, build_reqwest_client); called by 8 (send_track_events_request, chatgpt_get_request_with_timeout, create_dummy_chatgpt_auth_for_testing, from_auth_dot_json, load, revoke_auth_tokens, check_for_update, fetch_latest_github_release_version).


##### `build_reqwest_client`  (lines 203–216)

```
fn build_reqwest_client() -> reqwest::Client
```

**Purpose**: Builds the default reqwest HTTP client and keeps the old infallible behavior: callers get a client even if optional setup fails. This prevents network setup errors, such as bad custom certificate configuration, from crashing older call paths unexpectedly.

**Data flow**: It calls try_build_reqwest_client. If that succeeds, it returns the configured client. If it fails, it logs a warning and tries to build a simpler fallback client with the ChatGPT Cloudflare cookie store. If even that fails, it returns reqwest’s plain default client.

**Call relations**: Many network features call this directly when they need a raw reqwest client, including client management, pairing, remote control, probes, and plugin fetching. It delegates the preferred build path to try_build_reqwest_client and provides fallback behavior around it.

*Call graph*: calls 1 internal fn (try_build_reqwest_client); called by 38 (send_client_management_request_once, pairing_status, start_pairing, send_remote_control_server_request, http_get_probe_status_with_timeout, http_probe_url_with_timeout, fetch_plugin_detail, fetch_recommended_plugins, fetch_remote_plugin_skill_detail, get_remote_plugin_installed_page (+15 more)).


##### `try_build_reqwest_client`  (lines 222–230)

```
fn try_build_reqwest_client() -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Attempts to build the fully configured default reqwest client and reports structured errors if custom certificate setup fails. Callers use this when they want to know exactly why client construction did not work.

**Data flow**: It starts a reqwest client builder with default_headers. If the process is running in the special Codex sandbox, it disables proxy use. It adds the ChatGPT Cloudflare cookie store, then passes the builder to shared custom-certificate setup. It returns either the finished client or a certificate/build error.

**Call relations**: build_reqwest_client calls this as the preferred construction path. It gathers information from default_headers and is_sandboxed, then hands the builder to the shared custom certificate helper.

*Call graph*: calls 2 internal fn (default_headers, is_sandboxed); called by 1 (build_reqwest_client); 3 external calls (builder, build_reqwest_client_with_custom_ca, with_chatgpt_cloudflare_cookie_store).


##### `default_headers`  (lines 232–248)

```
fn default_headers() -> HeaderMap
```

**Purpose**: Creates the standard HTTP headers that Codex should attach to outgoing requests. These include the originator, User-Agent, and optionally a residency header.

**Data flow**: It starts with an empty header map. It inserts the current originator header, tries to insert the generated Codex User-Agent, then reads the stored residency requirement and adds the residency header if one is set and not already present. It returns the completed header map.

**Call relations**: HTTP client creation and several direct network paths call this when opening web sockets, WebRTC sideband input, or reqwest clients. It depends on originator and get_codex_user_agent to fill in the identifying headers.

*Call graph*: calls 2 internal fn (get_codex_user_agent, originator); called by 5 (websocket_reachability_check, connect_websocket, start_inner, spawn_webrtc_sideband_input_task, try_build_reqwest_client); 3 external calls (new, from_static, from_str).


##### `is_sandboxed`  (lines 250–252)

```
fn is_sandboxed() -> bool
```

**Purpose**: Detects whether Codex is running inside a specific sandbox mode called seatbelt. In that mode, the HTTP client should avoid proxy settings.

**Data flow**: It reads the CODEX_SANDBOX environment variable and compares it with the value seatbelt. It returns true only for that exact sandbox marker.

**Call relations**: try_build_reqwest_client calls this while building the reqwest client. If it returns true, the client builder is changed so it will not use proxies.

*Call graph*: called by 1 (try_build_reqwest_client); 1 external calls (var).


### Backend-facing service clients
These files apply the shared transport foundations to concrete authenticated clients for backend APIs, cloud tasks, remote config loading, ChatGPT helpers, and LM Studio.

### `backend-client/src/client.rs`

`io_transport` · `cross-cutting backend request handling`

This file is the program’s “front desk” for backend calls. Other parts of the system should not need to remember whether an endpoint lives under /api/codex or /wham, how to attach auth headers, or how to turn a failed web request into a useful error. The Client type collects those details in one place.

When a Client is created, it normalizes the base URL, chooses a path style, builds a reqwest HTTP client, and starts with either no authentication or the authentication supplied by a logged-in Codex user. Before each request, it builds headers with a user agent, auth data, optional ChatGPT account routing, and optional FedRAMP routing.

Most public methods follow the same pattern: choose the correct endpoint, attach headers, send a GET or POST, check that the server returned a successful status, then decode the JSON body into a typed response. A few calls use a richer RequestError so callers can tell, for example, whether a request failed because the user is unauthorized.

The file also includes translation code for rate-limit and credit information. The backend has its own generated data shapes, while the rest of Codex uses protocol-level snapshots. These mapper functions are like adapters between two plug shapes: they preserve the meaning while changing the format.

#### Function details

##### `RequestError::status`  (lines 46–51)

```
fn status(&self) -> Option<StatusCode>
```

**Purpose**: Returns the HTTP status code from a request error when one exists. This lets callers inspect failures without parsing the error text.

**Data flow**: It receives a RequestError. If the error is an UnexpectedStatus, it takes the stored status code and returns it; if the error came from another source, it returns nothing.

**Call relations**: RequestError::is_unauthorized uses this helper so it can ask one simple question about the error: was the status code 401 Unauthorized?

*Call graph*: called by 1 (is_unauthorized).


##### `RequestError::is_unauthorized`  (lines 53–55)

```
fn is_unauthorized(&self) -> bool
```

**Purpose**: Answers whether a failed request was rejected because the user is not authorized. Callers can use this to trigger login or show a clearer message.

**Data flow**: It receives a RequestError, asks RequestError::status for its HTTP code, then compares that code with 401 Unauthorized. It returns true or false.

**Call relations**: This sits on top of RequestError::status. Instead of every caller checking status codes by hand, they can call this small, intention-revealing method.

*Call graph*: calls 1 internal fn (status).


##### `RequestError::fmt`  (lines 59–73)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Turns a RequestError into a human-readable sentence. This is what appears in logs or user-facing error output.

**Data flow**: It receives the error and a formatter. For failed HTTP statuses, it writes the method, URL, status, content type, and body; for other errors, it writes the wrapped error message.

**Call relations**: Rust’s formatting system calls this when the error is printed. It uses the standard write operation to build the message.

*Call graph*: 1 external calls (write!).


##### `RequestError::source`  (lines 77–82)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Reports the underlying cause of the error when there is one. This helps error-reporting tools show the chain of failures.

**Data flow**: It receives a RequestError. If it wraps another anyhow error, it returns that inner error as the source; if it is an HTTP status failure recorded directly here, it returns no source.

**Call relations**: The standard error system calls this when walking an error chain. It lets RequestError fit into normal Rust error handling.


##### `RequestError::from`  (lines 86–88)

```
fn from(err: anyhow::Error) -> Self
```

**Purpose**: Converts a general anyhow error into this file’s RequestError type. This makes it easy to use ordinary errors in functions that promise to return RequestError.

**Data flow**: It receives an anyhow error and wraps it in RequestError::Other. The original error is preserved inside the new value.

**Call relations**: Methods such as get_config_bundle can map JSON decoding or network errors into RequestError through this conversion.

*Call graph*: 1 external calls (Other).


##### `PathStyle::from_base_url`  (lines 112–118)

```
fn from_base_url(base_url: &str) -> Self
```

**Purpose**: Chooses which URL layout the backend uses. Codex endpoints and ChatGPT backend endpoints have different path prefixes, and this function picks the right one from the base URL.

**Data flow**: It receives a base URL string. If the URL contains /backend-api, it returns ChatGptApi; otherwise it returns CodexApi.

**Call relations**: Client::new calls this after normalizing the base URL, so later request methods can switch paths without re-checking the URL each time.

*Call graph*: called by 1 (new).


##### `Client::fmt`  (lines 133–145)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Builds a safe debug view of a Client. It shows useful setup fields while hiding the actual authentication provider details.

**Data flow**: It receives a Client and a formatter. It writes fields such as base URL, user agent, account ID, FedRAMP flag, and path style, but replaces the auth provider with a placeholder.

**Call relations**: Rust’s debug printing calls this when someone logs or inspects a Client. It relies on the formatter’s debug-struct builder.

*Call graph*: 1 external calls (debug_struct).


##### `Client::new`  (lines 149–175)

```
fn new(base_url: impl Into<String>) -> Result<Self>
```

**Purpose**: Creates a backend client from a base URL. It prepares the URL, HTTP engine, default authentication state, and path style needed for future requests.

**Data flow**: It takes a base URL, trims trailing slashes, adds /backend-api for common ChatGPT hosts when needed, builds a reqwest HTTP client with custom certificate and Cloudflare cookie support, chooses the path style, and returns a ready Client.

**Call relations**: This is the basic constructor used directly by tests and other setup code. Client::from_auth builds on it when a logged-in user is available.

*Call graph*: calls 1 internal fn (from_base_url); called by 18 (websocket_transport_serves_health_endpoints_on_same_listener, test_client, test_client, new, models_client_hits_models_endpoint, responses_post_drains_request_body, revoke_request_times_out, cancels_previous_login_server_when_port_is_in_use, creates_missing_codex_home_dir, forced_chatgpt_workspace_id_mismatch_blocks_login (+8 more)); 10 external calls (contains, ends_with, into, pop, starts_with, builder, build_reqwest_client_with_custom_ca, with_chatgpt_cloudflare_cookie_store, unauthenticated_auth_provider, format!).


##### `Client::from_auth`  (lines 177–181)

```
fn from_auth(base_url: impl Into<String>, auth: &CodexAuth) -> Result<Self>
```

**Purpose**: Creates a Client that is already configured for an authenticated Codex user. It is the convenient constructor for normal logged-in use.

**Data flow**: It receives a base URL and a CodexAuth object. It creates a plain Client, adds the standard Codex user agent, converts the auth object into an auth header provider, and returns the configured Client.

**Call relations**: This wraps Client::new and then applies Client::with_user_agent and Client::with_auth_provider, so callers do not have to repeat that setup.

*Call graph*: calls 1 internal fn (get_codex_user_agent); 2 external calls (new, auth_provider_from_auth).


##### `Client::with_auth_provider`  (lines 183–186)

```
fn with_auth_provider(mut self, auth: SharedAuthProvider) -> Self
```

**Purpose**: Returns a copy of the Client configured with a specific authentication provider. Use it when the caller already has a source of auth headers.

**Data flow**: It takes ownership of a Client and an auth provider, replaces the Client’s current provider, and returns the modified Client.

**Call relations**: Client::from_auth uses this after converting login information into a provider. Later, Client::headers asks that provider to add auth headers.


##### `Client::with_user_agent`  (lines 188–193)

```
fn with_user_agent(mut self, ua: impl Into<String>) -> Self
```

**Purpose**: Sets the User-Agent header, which tells the server what software is making the request. If the supplied value is not a valid header, it leaves the Client unchanged.

**Data flow**: It receives a Client and a user-agent string-like value. It tries to convert the string into an HTTP header value; on success it stores it, then returns the Client.

**Call relations**: Client::from_auth uses this to add the standard Codex user agent. Client::headers later includes the stored value, or a default if none was set.

*Call graph*: 2 external calls (from_str, into).


##### `Client::with_chatgpt_account_id`  (lines 195–198)

```
fn with_chatgpt_account_id(mut self, account_id: impl Into<String>) -> Self
```

**Purpose**: Sets the ChatGPT account ID header used to route requests to a particular account or workspace.

**Data flow**: It receives a Client and an account ID, stores the ID as text, and returns the modified Client.

**Call relations**: Client::headers later turns this stored account ID into a ChatGPT-Account-Id header on every request.

*Call graph*: 1 external calls (into).


##### `Client::with_fedramp_routing_header`  (lines 200–203)

```
fn with_fedramp_routing_header(mut self) -> Self
```

**Purpose**: Marks the Client so requests include the FedRAMP routing header. FedRAMP is a government compliance environment, and the server needs this header to route correctly.

**Data flow**: It receives a Client, sets a boolean flag to true, and returns the modified Client.

**Call relations**: Client::headers reads this flag and adds X-OpenAI-Fedramp: true when requests are sent.


##### `Client::with_path_style`  (lines 205–208)

```
fn with_path_style(mut self, style: PathStyle) -> Self
```

**Purpose**: Overrides the URL path style used by the Client. This is useful for tests or special routing situations.

**Data flow**: It receives a Client and a PathStyle value, stores that style, and returns the modified Client.

**Call relations**: Request methods later consult the stored path style when choosing between /api/codex and /wham endpoints.


##### `Client::headers`  (lines 210–230)

```
fn headers(&self) -> HeaderMap
```

**Purpose**: Builds the shared HTTP headers used on backend requests. This keeps authentication, user agent, account routing, and FedRAMP routing consistent.

**Data flow**: It starts with an empty header map, inserts a configured or default user agent, asks the auth provider to add auth headers, optionally adds ChatGPT account and FedRAMP headers, and returns the completed map.

**Call relations**: Every request-building method calls this before sending, including account checks, task operations, config fetches, token usage, and add-credit nudges.

*Call graph*: called by 8 (create_task, get_accounts_check, get_config_bundle, get_task_details_with_body, get_token_usage_profile, list_sibling_turns, list_tasks, send_add_credits_nudge_email); 5 external calls (new, from_bytes, from_static, from_str, add_auth_headers).


##### `Client::exec_request`  (lines 232–251)

```
async fn exec_request(
        &self,
        req: reqwest::RequestBuilder,
        method: &str,
        url: &str,
    ) -> Result<(String, String)>
```

**Purpose**: Sends an HTTP request and treats any non-success status as a general error. It is the common path for ordinary API calls.

**Data flow**: It receives a prepared request, method name, and URL. It sends the request, records the status, content type, and response body, then returns the body and content type if the status is successful; otherwise it produces an error message with the details.

**Call relations**: Methods such as get_accounts_check, list_tasks, get_task_details_with_body, list_sibling_turns, get_token_usage_profile, and create_task use this after they build their request.

*Call graph*: called by 6 (create_task, get_accounts_check, get_task_details_with_body, get_token_usage_profile, list_sibling_turns, list_tasks); 2 external calls (send, bail!).


##### `Client::exec_request_detailed`  (lines 253–278)

```
async fn exec_request_detailed(
        &self,
        req: reqwest::RequestBuilder,
        method: &str,
        url: &str,
    ) -> std::result::Result<(String, String), RequestError>
```

**Purpose**: Sends an HTTP request but returns a structured RequestError on failure. This is used when callers need to inspect details such as the HTTP status code.

**Data flow**: It receives a prepared request, method name, and URL. It sends the request, reads status, content type, and body, returns them on success, or returns RequestError::UnexpectedStatus on a bad HTTP status.

**Call relations**: get_config_bundle and send_add_credits_nudge_email use this because their callers may need more precise failure handling than a plain anyhow error.

*Call graph*: called by 2 (get_config_bundle, send_add_credits_nudge_email); 1 external calls (send).


##### `Client::decode_json`  (lines 280–287)

```
fn decode_json(&self, url: &str, ct: &str, body: &str) -> Result<T>
```

**Purpose**: Parses a JSON response body into the expected Rust data type. If parsing fails, it includes the URL, content type, and body in the error to make debugging easier.

**Data flow**: It receives a URL, content type, and response body text. It asks serde_json to deserialize the body into the requested type, returning the typed value or a detailed decode error.

**Call relations**: Request methods call this after exec_request has successfully returned a body, for example when reading account checks, token usage profiles, and task details.

*Call graph*: called by 3 (get_accounts_check, get_task_details_with_body, get_token_usage_profile); 1 external calls (bail!).


##### `Client::get_rate_limits`  (lines 289–296)

```
async fn get_rate_limits(&self) -> Result<RateLimitSnapshot>
```

**Purpose**: Returns the main rate-limit snapshot for the user. If multiple limits are available, it prefers the one identified as codex.

**Data flow**: It asks get_rate_limits_many for all snapshots, searches for the snapshot whose limit ID is codex, and returns that one; if none is marked codex, it returns the first snapshot.

**Call relations**: This is the simple single-answer API. It delegates the fetching and conversion work to Client::get_rate_limits_many.

*Call graph*: calls 1 internal fn (get_rate_limits_many).


##### `Client::get_rate_limits_many`  (lines 298–300)

```
async fn get_rate_limits_many(&self) -> Result<Vec<RateLimitSnapshot>>
```

**Purpose**: Returns all available rate-limit snapshots for the user. This is useful when the backend reports more than one metered feature.

**Data flow**: It fetches rate-limit data through the reset-credit-aware helper and returns the list of snapshots inside that result.

**Call relations**: Client::get_rate_limits calls this and then picks the preferred codex entry. The underlying fetch-and-reset behavior is supplied by the companion rate_limit_resets module.

*Call graph*: called by 1 (get_rate_limits).


##### `Client::get_accounts_check`  (lines 302–310)

```
async fn get_accounts_check(&self) -> Result<AccountsCheckResponse>
```

**Purpose**: Asks the backend for account-check information. This likely tells the client whether the current account is valid and usable for Codex.

**Data flow**: It chooses the account-check URL for the current path style, builds a GET request with shared headers, sends it, and decodes the JSON body into AccountsCheckResponse.

**Call relations**: This method uses Client::headers, Client::exec_request, and Client::decode_json in the standard request pipeline.

*Call graph*: calls 3 internal fn (decode_json, exec_request, headers); 2 external calls (get, format!).


##### `Client::get_token_usage_profile`  (lines 312–317)

```
async fn get_token_usage_profile(&self) -> Result<TokenUsageProfile>
```

**Purpose**: Fetches the current user’s token usage profile. This gives the rest of the app typed information about usage-related account state.

**Data flow**: It builds the correct profile URL, sends a GET request with shared headers, and decodes the returned JSON into TokenUsageProfile.

**Call relations**: It asks Client::token_usage_profile_url for the endpoint, then follows the normal headers, execute, decode flow.

*Call graph*: calls 4 internal fn (decode_json, exec_request, headers, token_usage_profile_url); 1 external calls (get).


##### `Client::token_usage_profile_url`  (lines 319–324)

```
fn token_usage_profile_url(&self) -> String
```

**Purpose**: Builds the URL for the current user’s token usage profile. It hides the difference between Codex and ChatGPT backend paths.

**Data flow**: It reads the Client’s base URL and path style, then returns either a /api/codex/profiles/me URL or a /wham/profiles/me URL.

**Call relations**: Client::get_token_usage_profile calls this before creating the GET request. Tests verify both URL forms.

*Call graph*: called by 1 (get_token_usage_profile); 1 external calls (format!).


##### `Client::send_add_credits_nudge_email`  (lines 326–339)

```
async fn send_add_credits_nudge_email(
        &self,
        credit_type: AddCreditsNudgeCreditType,
    ) -> std::result::Result<(), RequestError>
```

**Purpose**: Requests that the backend send an email nudging someone to add credits or raise a usage limit. It is used when the user has hit a credit or usage-control problem.

**Data flow**: It receives a credit type, builds the correct POST URL, sends JSON containing that credit type, and returns success or a structured RequestError.

**Call relations**: It uses Client::send_add_credits_nudge_email_url for routing, Client::headers for request headers, and Client::exec_request_detailed so callers can inspect failures.

*Call graph*: calls 3 internal fn (exec_request_detailed, headers, send_add_credits_nudge_email_url); 2 external calls (from_static, post).


##### `Client::list_tasks`  (lines 341–375)

```
async fn list_tasks(
        &self,
        limit: Option<i32>,
        task_filter: Option<&str>,
        environment_id: Option<&str>,
        cursor: Option<&str>,
    ) -> Result<PaginatedListTask
```

**Purpose**: Fetches a paginated list of Codex tasks. Optional filters let callers limit the number of tasks, choose a task filter, restrict by environment, or continue from a cursor.

**Data flow**: It builds the task-list URL, starts a GET request with shared headers, adds any provided query parameters, sends the request, and decodes the JSON into PaginatedListTaskListItem.

**Call relations**: Higher-level list commands call this when showing tasks. Internally it follows the same headers, execute, decode pattern as other GET methods.

*Call graph*: calls 2 internal fn (exec_request, headers); called by 1 (list); 2 external calls (get, format!).


##### `Client::get_task_details`  (lines 377–380)

```
async fn get_task_details(&self, task_id: &str) -> Result<CodeTaskDetailsResponse>
```

**Purpose**: Fetches parsed details for one task. It is the simple version for callers that do not need the raw response body.

**Data flow**: It receives a task ID, calls get_task_details_with_body, discards the raw body and content type, and returns only the parsed CodeTaskDetailsResponse.

**Call relations**: Command-running code calls this to inspect a task. It delegates all network work to Client::get_task_details_with_body.

*Call graph*: calls 1 internal fn (get_task_details_with_body); called by 1 (run).


##### `Client::get_task_details_with_body`  (lines 382–394)

```
async fn get_task_details_with_body(
        &self,
        task_id: &str,
    ) -> Result<(CodeTaskDetailsResponse, String, String)>
```

**Purpose**: Fetches details for one task and also returns the raw server response. This is useful when a caller wants both structured data and the original body for logging or debugging.

**Data flow**: It receives a task ID, builds the correct task URL, sends a GET request with shared headers, decodes the body into CodeTaskDetailsResponse, and returns the parsed value plus the raw body and content type.

**Call relations**: Client::get_task_details calls this and keeps only the parsed result. Other detail-oriented code can call it directly when it needs the raw response too.

*Call graph*: calls 3 internal fn (decode_json, exec_request, headers); called by 2 (get_task_details, details_with_body); 2 external calls (get, format!).


##### `Client::list_sibling_turns`  (lines 396–414)

```
async fn list_sibling_turns(
        &self,
        task_id: &str,
        turn_id: &str,
    ) -> Result<TurnAttemptsSiblingTurnsResponse>
```

**Purpose**: Lists alternative turns related to a task turn. In plain terms, it asks the backend for neighboring attempts or versions of the same conversation step.

**Data flow**: It receives a task ID and turn ID, builds the sibling-turns URL for the current path style, sends a GET request with shared headers, and decodes the response into TurnAttemptsSiblingTurnsResponse.

**Call relations**: List-oriented command code calls this when it needs sibling turn information. Internally it uses the standard headers and request execution helpers.

*Call graph*: calls 2 internal fn (exec_request, headers); called by 1 (list); 2 external calls (get, format!).


##### `Client::get_config_bundle`  (lines 420–431)

```
async fn get_config_bundle(
        &self,
    ) -> std::result::Result<ConfigBundleResponse, RequestError>
```

**Purpose**: Fetches the selected cloud-managed configuration bundle from the backend. This lets the service provide configuration to the client without shipping it locally.

**Data flow**: It chooses the config-bundle URL, sends a GET request with shared headers, then decodes the JSON into ConfigBundleResponse. Failures are returned as RequestError so status codes can be inspected.

**Call relations**: It uses Client::exec_request_detailed rather than the simpler executor because configuration fetch failures may need careful handling.

*Call graph*: calls 2 internal fn (exec_request_detailed, headers); 2 external calls (get, format!).


##### `Client::create_task`  (lines 435–466)

```
async fn create_task(&self, request_body: serde_json::Value) -> Result<String>
```

**Purpose**: Creates a new backend task by posting a JSON request body. It returns the new task’s ID so the caller can track or fetch it later.

**Data flow**: It receives a JSON value, chooses the task-creation URL, sends it as an application/json POST with shared headers, reads the response body, and looks for a task ID first at task.id and then at top-level id.

**Call relations**: Create-command code calls this to start a task. It uses Client::exec_request for the POST and then performs custom JSON inspection because the backend may return the ID in two possible places.

*Call graph*: calls 2 internal fn (exec_request, headers); called by 1 (create); 4 external calls (from_static, bail!, post, format!).


##### `Client::rate_limit_snapshots_from_payload`  (lines 469–505)

```
fn rate_limit_snapshots_from_payload(
        payload: RateLimitStatusPayload,
    ) -> Vec<RateLimitSnapshot>
```

**Purpose**: Converts the backend’s rate-limit status payload into the protocol snapshots used by the rest of Codex. It includes the main codex limit and any extra metered limits the backend reports.

**Data flow**: It receives a RateLimitStatusPayload, maps plan type, reached-limit reason, spend control, credits, and window data into one primary RateLimitSnapshot, then appends snapshots for additional rate limits.

**Call relations**: The tests exercise this directly to prove the conversion keeps primary limits, extra limits, credits, spend controls, and reached-limit reasons intact. It relies on the smaller mapping helpers below.

*Call graph*: called by 4 (usage_payload_maps_every_rate_limit_reached_type, usage_payload_maps_primary_and_additional_rate_limits, usage_payload_maps_zero_rate_limit_when_primary_absent, usage_payload_preserves_absent_rate_limit_reached_type); 2 external calls (map_plan_type, vec!).


##### `Client::make_rate_limit_snapshot`  (lines 507–533)

```
fn make_rate_limit_snapshot(
        limit_id: Option<String>,
        limit_name: Option<String>,
        rate_limit: Option<crate::types::RateLimitStatusDetails>,
        credits: Option<crate::type
```

**Purpose**: Builds one RateLimitSnapshot from its pieces. It is the shared constructor used for both the main codex limit and additional limits.

**Data flow**: It receives IDs, names, optional backend rate-limit details, optional credits, individual spend control, plan type, and reached-limit reason. It maps the primary and secondary windows plus credits, then returns a complete RateLimitSnapshot.

**Call relations**: Client::rate_limit_snapshots_from_payload uses this to avoid duplicating snapshot-building logic for main and additional limits.

*Call graph*: 2 external calls (map_credits, map_rate_limit_window).


##### `Client::map_rate_limit_reached_type`  (lines 535–556)

```
fn map_rate_limit_reached_type(
        kind: BackendRateLimitReachedKind,
    ) -> Option<RateLimitReachedType>
```

**Purpose**: Translates the backend’s reason for a limit being reached into the protocol reason used elsewhere in the app. Unknown backend values are deliberately dropped.

**Data flow**: It receives a backend RateLimitReachedKind and returns the matching protocol RateLimitReachedType, or None for Unknown.

**Call relations**: Client::rate_limit_snapshots_from_payload uses this while building the main snapshot. Tests cover every known variant.


##### `Client::send_add_credits_nudge_email_url`  (lines 558–571)

```
fn send_add_credits_nudge_email_url(&self) -> String
```

**Purpose**: Builds the endpoint URL for the add-credits nudge email request. It hides the path difference between Codex and ChatGPT backends.

**Data flow**: It reads the Client’s base URL and path style, then returns either the /api/codex/accounts/send_add_credits_nudge_email URL or the /wham/accounts/send_add_credits_nudge_email URL.

**Call relations**: Client::send_add_credits_nudge_email calls this before making its POST request. Tests verify both path styles.

*Call graph*: called by 1 (send_add_credits_nudge_email); 1 external calls (format!).


##### `Client::map_rate_limit_window`  (lines 573–586)

```
fn map_rate_limit_window(
        window: Option<Option<Box<crate::types::RateLimitWindowSnapshot>>>,
    ) -> Option<RateLimitWindow>
```

**Purpose**: Converts one backend rate-limit window into the protocol window shape. A window is a time bucket, such as a 5-minute or 1-hour usage period.

**Data flow**: It receives an optional nested backend window. If there is no window, it returns None; otherwise it converts used percent to a floating-point number, turns seconds into rounded-up minutes, copies the reset time, and returns a RateLimitWindow.

**Call relations**: Client::make_rate_limit_snapshot calls this for primary and secondary windows. It uses Client::window_minutes_from_seconds for the time conversion.

*Call graph*: 3 external calls (window_minutes_from_seconds, from, from).


##### `Client::map_credits`  (lines 588–596)

```
fn map_credits(credits: Option<crate::types::CreditStatusDetails>) -> Option<CreditsSnapshot>
```

**Purpose**: Converts backend credit information into the protocol credit snapshot. This tells the app whether credits exist, whether they are unlimited, and what balance is visible.

**Data flow**: It receives optional backend credit details. If absent, it returns None; otherwise it copies has_credits and unlimited and flattens the optional balance into the snapshot.

**Call relations**: Client::make_rate_limit_snapshot calls this while building each snapshot.


##### `Client::map_individual_limit`  (lines 598–607)

```
fn map_individual_limit(
        details: crate::types::SpendControlLimitDetails,
    ) -> SpendControlLimitSnapshot
```

**Purpose**: Converts a backend spend-control limit into the protocol snapshot. Spend control is a cap on how much an individual can use.

**Data flow**: It receives backend spend-control details and copies the limit, used amount, remaining percent, and reset time into SpendControlLimitSnapshot.

**Call relations**: Client::rate_limit_snapshots_from_payload uses this when the backend includes an individual spend-control limit.

*Call graph*: 1 external calls (from).


##### `Client::map_plan_type`  (lines 609–632)

```
fn map_plan_type(plan_type: crate::types::PlanType) -> AccountPlanType
```

**Purpose**: Translates backend account plan names into protocol account plan names. This keeps the rest of Codex from depending directly on backend-generated types.

**Data flow**: It receives a backend PlanType and returns the matching codex_protocol AccountPlanType. Several unsupported or ambiguous plans map to Unknown.

**Call relations**: Client::rate_limit_snapshots_from_payload calls this before producing snapshots. Tests check newer usage-based business variants and unknown-style cases.


##### `Client::window_minutes_from_seconds`  (lines 634–641)

```
fn window_minutes_from_seconds(seconds: i32) -> Option<i64>
```

**Purpose**: Turns a window length in seconds into minutes, rounding up. For example, 61 seconds becomes 2 minutes, which is usually clearer for display.

**Data flow**: It receives a number of seconds. If the value is zero or negative, it returns None; otherwise it converts to a larger integer type, rounds up to minutes, and returns that value.

**Call relations**: Client::map_rate_limit_window calls this while converting backend window data.

*Call graph*: 1 external calls (from).


##### `tests::map_plan_type_supports_usage_based_business_variants`  (lines 653–662)

```
fn map_plan_type_supports_usage_based_business_variants()
```

**Purpose**: Checks that newer usage-based business plan types are not accidentally collapsed to Unknown.

**Data flow**: The test feeds two backend plan variants into Client::map_plan_type and asserts that the exact matching protocol variants come out.

**Call relations**: The Rust test runner calls this during tests. It protects the mapping used by Client::rate_limit_snapshots_from_payload.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::usage_payload_maps_primary_and_additional_rate_limits`  (lines 665–771)

```
fn usage_payload_maps_primary_and_additional_rate_limits()
```

**Purpose**: Verifies that a rich backend rate-limit payload is converted correctly. It covers the main codex limit, an additional limit, credits, spend controls, plan type, and reached-limit reason.

**Data flow**: The test builds a sample RateLimitStatusPayload, passes it to Client::rate_limit_snapshots_from_payload, and checks the resulting snapshots field by field.

**Call relations**: The test runner calls this to guard the rate-limit adapter code against regressions.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 4 external calls (new, default, assert_eq!, vec!).


##### `tests::usage_payload_maps_zero_rate_limit_when_primary_absent`  (lines 774–795)

```
fn usage_payload_maps_zero_rate_limit_when_primary_absent()
```

**Purpose**: Checks that conversion still returns a main codex snapshot even when the backend omits the primary rate-limit details.

**Data flow**: The test builds a payload with no main rate-limit data but with an additional limit, converts it, and asserts that both expected snapshots exist with missing window data where appropriate.

**Call relations**: This protects Client::rate_limit_snapshots_from_payload from dropping important entries just because some optional backend fields are absent.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 2 external calls (assert_eq!, vec!).


##### `tests::preferred_snapshot_selection_matches_get_rate_limits_behavior`  (lines 798–836)

```
fn preferred_snapshot_selection_matches_get_rate_limits_behavior()
```

**Purpose**: Documents and verifies the rule used by get_rate_limits: prefer the snapshot whose limit ID is codex.

**Data flow**: The test creates two snapshots, one non-codex and one codex, applies the same selection logic as get_rate_limits, and asserts that the codex snapshot is chosen.

**Call relations**: The test runner calls this as a safety check for the selection behavior used by Client::get_rate_limits.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::usage_payload_maps_every_rate_limit_reached_type`  (lines 839–877)

```
fn usage_payload_maps_every_rate_limit_reached_type()
```

**Purpose**: Checks every known backend reason for a reached limit. This ensures user-facing logic can distinguish credits depleted from usage limits reached and owner from member cases.

**Data flow**: The test loops through backend reached-limit kinds, creates a payload for each, converts it, and asserts that the expected protocol reason appears in the snapshot.

**Call relations**: It exercises Client::rate_limit_snapshots_from_payload and, through it, the reached-type mapping helper.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 1 external calls (assert_eq!).


##### `tests::usage_payload_preserves_absent_rate_limit_reached_type`  (lines 880–892)

```
fn usage_payload_preserves_absent_rate_limit_reached_type()
```

**Purpose**: Verifies that if the backend does not say why a rate limit was reached, the converted snapshot also leaves that reason absent.

**Data flow**: The test builds a payload with no reached-limit type, converts it, and checks that the resulting snapshot has None for that field.

**Call relations**: This protects the conversion code from inventing a reason when the backend did not provide one.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 1 external calls (assert_eq!).


##### `tests::add_credits_nudge_email_uses_expected_paths_and_bodies`  (lines 895–922)

```
fn add_credits_nudge_email_uses_expected_paths_and_bodies()
```

**Purpose**: Checks the URL paths and JSON body shape for add-credit nudge emails. This prevents small naming changes from breaking the backend contract.

**Data flow**: The test creates Codex-style and ChatGPT-style clients, checks their generated nudge-email URLs, then serializes both credit-type request bodies and compares them to the expected JSON.

**Call relations**: It calls the test_client helper and exercises Client::send_add_credits_nudge_email_url plus the request-body serialization type.

*Call graph*: 2 external calls (assert_eq!, test_client).


##### `tests::token_usage_profile_uses_expected_paths`  (lines 925–937)

```
fn token_usage_profile_uses_expected_paths()
```

**Purpose**: Checks that token usage profile URLs are built correctly for both backend path styles.

**Data flow**: The test creates one Codex-style client and one ChatGPT-style client, calls token_usage_profile_url on each, and compares the strings to the expected endpoints.

**Call relations**: It calls the test_client helper and protects Client::get_token_usage_profile from using the wrong endpoint.

*Call graph*: 2 external calls (assert_eq!, test_client).


##### `tests::test_client`  (lines 939–949)

```
fn test_client(base_url: &str, path_style: PathStyle) -> Client
```

**Purpose**: Creates a lightweight Client for tests without going through the full constructor. This lets tests set the base URL and path style exactly.

**Data flow**: It receives a base URL and path style, fills in a Client with a plain reqwest client, unauthenticated auth provider, no user agent, no account ID, no FedRAMP flag, and the requested path style.

**Call relations**: URL-focused tests call this so they can inspect path-building behavior without making network requests or relying on Client::new’s URL normalization.

*Call graph*: calls 1 internal fn (new); 1 external calls (unauthenticated_auth_provider).


### `chatgpt/src/chatgpt_client.rs`

`io_transport` · `request handling`

This file solves a practical problem: other parts of the program need to ask the ChatGPT backend for information, but they should not each have to repeat the same login checks, URL building, headers, timeout handling, and JSON parsing. Without this file, every caller would need to know exactly how ChatGPT backend authentication works, and mistakes could lead to failed requests or confusing login errors.

The flow is like showing a membership card before entering a building. First, the code looks up the configured ChatGPT base URL. Then it gets the current authentication details from the shared login system. It refuses to continue unless the authentication is for the Codex backend and includes an account ID, because those are required for this backend. After that, it builds the final URL from the base URL and the requested path, creates an HTTP GET request, adds the authentication headers, marks the request as coming from the Codex product, and optionally applies a timeout.

When the backend replies, the file checks whether the HTTP status means success. If it does, it reads the response as JSON and converts it into the type the caller asked for. If the backend returns an error, it includes both the status code and response body in the error message, which makes failures easier to diagnose.

#### Function details

##### `chatgpt_get_request`  (lines 13–18)

```
async fn chatgpt_get_request(
    config: &Config,
    path: String,
) -> anyhow::Result<T>
```

**Purpose**: This is the simple way to make a ChatGPT backend GET request when the caller does not need a custom timeout. It exists as a convenience wrapper so callers can ask for data without thinking about timeout settings.

**Data flow**: It receives the app configuration and a backend path. It passes both to the timeout-aware request function, using no timeout. The result is either parsed JSON in the caller’s requested type or an error explaining what went wrong.

**Call relations**: When code such as get_task needs data from the ChatGPT backend, it calls this simpler function. This function immediately hands the real work to chatgpt_get_request_with_timeout, keeping the common case short and consistent.

*Call graph*: calls 1 internal fn (chatgpt_get_request_with_timeout); called by 1 (get_task).


##### `chatgpt_get_request_with_timeout`  (lines 20–72)

```
async fn chatgpt_get_request_with_timeout(
    config: &Config,
    path: String,
    timeout: Option<Duration>,
) -> anyhow::Result<T>
```

**Purpose**: This function performs the actual authenticated GET request to the ChatGPT backend. It checks that the user has the right login, builds the HTTP request, optionally sets a timeout, and parses the JSON response.

**Data flow**: It receives the app configuration, the API path to request, and an optional timeout. It reads the ChatGPT base URL and authentication details from the configuration, verifies that the login can be used for the Codex backend, builds the full URL, adds authentication and product headers, sends the request, and then either returns the parsed JSON response or an error containing the failed status and response body.

**Call relations**: This is the shared worker used by the convenience function chatgpt_get_request and by codex_plugins_enabled_for_workspace when a timeout may matter. Inside the request flow, it calls the login system to get authentication, creates an HTTP client, turns the authentication into request headers, and stops early with clear errors if the login or backend response is not acceptable.

*Call graph*: calls 2 internal fn (create_client, shared_from_config); called by 2 (chatgpt_get_request, codex_plugins_enabled_for_workspace); 4 external calls (bail!, ensure!, auth_provider_from_auth, format!).


### `cloud-tasks-client/src/http.rs`

`io_transport` · `request handling`

This file is the bridge between the local command-line tool and the cloud service that stores Codex tasks. Without it, the rest of the code could talk about tasks in a clean, project-friendly way, but it would not know how to actually ask the remote server for them or turn the server's raw replies into useful local objects.

The main type is `HttpClient`. It wraps a lower-level backend HTTP client and implements the `CloudBackend` trait, which is the common interface the rest of the application uses. Think of it like a travel adapter: the app speaks in terms of “task summaries” and “apply this diff,” while the server speaks in JSON responses and HTTP endpoints. This file converts between the two.

Inside the private `api` module, the work is split into small helper wrappers. `Tasks` covers listing, creating, and reading tasks. `Attempts` reads sibling attempts for a task turn. `Apply` fetches or receives a diff, checks that it is a normal unified git diff, and asks git-apply helper code to test or apply it locally.

The file also contains many translation helpers. They extract assistant messages, diff statistics, timestamps, statuses, environment labels, and attempt counts from sometimes-nested JSON. A small logging helper writes diagnostic information to `error.log`, especially when server responses or patch application do not behave as expected.

#### Function details

##### `HttpClient::new`  (lines 31–35)

```
fn new(base_url: impl Into<String>) -> anyhow::Result<Self>
```

**Purpose**: Creates a new HTTP cloud task client for a given server base URL. This is the starting point for using the cloud backend over the network.

**Data flow**: It receives a base URL, turns it into a string, builds the lower-level backend client with the same URL, and returns an `HttpClient` containing both. If the lower-level client cannot be created, the error is returned instead.

**Call relations**: Startup code calls this through `init_backend` when it needs a real cloud connection. After this, the returned client can be configured further or used through the `CloudBackend` interface.

*Call graph*: calls 1 internal fn (new); called by 1 (init_backend); 2 external calls (clone, into).


##### `HttpClient::with_user_agent`  (lines 37–40)

```
fn with_user_agent(mut self, ua: impl Into<String>) -> Self
```

**Purpose**: Returns a copy of the client that sends a custom user-agent string with HTTP requests. A user-agent identifies the calling program to the server.

**Data flow**: It takes the existing client and a user-agent value, clones the lower-level backend client with that setting added, and returns the updated `HttpClient`.

**Call relations**: This is an optional setup step after construction. Later task and apply calls use the configured backend client automatically.

*Call graph*: 1 external calls (clone).


##### `HttpClient::with_auth_provider`  (lines 42–45)

```
fn with_auth_provider(mut self, auth: SharedAuthProvider) -> Self
```

**Purpose**: Returns a copy of the client that knows how to authenticate requests. Authentication is how the server knows which user or account is making the request.

**Data flow**: It receives a shared authentication provider, installs it into a cloned backend client, and returns the updated `HttpClient`.

**Call relations**: This is used during client setup before any cloud calls are made. All later task, attempt, and apply API wrappers use this authenticated backend.

*Call graph*: 1 external calls (clone).


##### `HttpClient::with_chatgpt_account_id`  (lines 47–50)

```
fn with_chatgpt_account_id(mut self, account_id: impl Into<String>) -> Self
```

**Purpose**: Returns a copy of the client that sends a specific ChatGPT account identifier with requests. This lets the backend route requests to the right account context.

**Data flow**: It takes an account ID, attaches it to a cloned backend client, and returns the updated `HttpClient`.

**Call relations**: This is another optional setup step. Once set, all later requests made through this client carry the account information.

*Call graph*: 1 external calls (clone).


##### `HttpClient::tasks_api`  (lines 52–54)

```
fn tasks_api(&self) -> api::Tasks<'_>
```

**Purpose**: Creates a small task-specific helper for operations such as listing, reading, and creating tasks. It keeps task-related HTTP details out of the public client methods.

**Data flow**: It reads the client’s base URL and backend client reference, wraps them in an `api::Tasks` value, and returns that lightweight wrapper.

**Call relations**: The public task methods call this just before doing their work. It then hands off to the matching `api::Tasks` method.

*Call graph*: called by 6 (create_task, get_task_diff, get_task_messages, get_task_summary, get_task_text, list_tasks); 1 external calls (new).


##### `HttpClient::attempts_api`  (lines 56–58)

```
fn attempts_api(&self) -> api::Attempts<'_>
```

**Purpose**: Creates a helper focused on sibling task attempts. These are alternative runs or turns for the same task.

**Data flow**: It borrows the backend client from `HttpClient`, puts it into an `api::Attempts` wrapper, and returns that wrapper.

**Call relations**: The public sibling-attempt listing method calls this and then delegates the actual server request to `api::Attempts::list`.

*Call graph*: called by 1 (list_sibling_attempts); 1 external calls (new).


##### `HttpClient::apply_api`  (lines 60–62)

```
fn apply_api(&self) -> api::Apply<'_>
```

**Purpose**: Creates a helper for applying or preflighting a task’s patch. Preflighting means checking whether a patch would apply cleanly without actually changing files.

**Data flow**: It borrows the backend client and returns an `api::Apply` wrapper that can fetch task details and run patch application.

**Call relations**: The public apply methods call this wrapper so the patch-specific logic stays grouped in one place.

*Call graph*: called by 2 (apply_task, apply_task_preflight); 1 external calls (new).


##### `HttpClient::list_tasks`  (lines 66–73)

```
fn list_tasks(
        &'a self,
        env: Option<&'a str>,
        limit: Option<i64>,
        cursor: Option<&'a str>,
    ) -> CloudBackendFuture<'a, TaskListPage>
```

**Purpose**: Implements the public cloud-backend operation for listing tasks. Callers can optionally filter by environment, limit the number of results, and continue from a pagination cursor.

**Data flow**: It receives the filter and pagination inputs, creates a task API wrapper, and returns an asynchronous future that will produce a `TaskListPage` when awaited.

**Call relations**: Higher-level code calls this through the `CloudBackend` trait. The method immediately hands the real work to `api::Tasks::list`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_summary`  (lines 75–77)

```
fn get_task_summary(&self, id: TaskId) -> CloudBackendFuture<'_, TaskSummary>
```

**Purpose**: Fetches one task’s summary information, such as title, status, updated time, and diff statistics.

**Data flow**: It receives a task ID, creates a task API wrapper, and returns a future that resolves to a `TaskSummary`.

**Call relations**: This is the trait-level entry for summary lookups. It delegates parsing and server details to `api::Tasks::summary`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_diff`  (lines 79–81)

```
fn get_task_diff(&self, id: TaskId) -> CloudBackendFuture<'_, Option<String>>
```

**Purpose**: Fetches the patch or diff produced by a cloud task, if one is available. A diff is a text description of file changes.

**Data flow**: It receives a task ID, creates a task API wrapper, and returns a future that resolves to either a diff string or `None`.

**Call relations**: Cloud-backend callers use this when they need to inspect changes. The actual HTTP fetch is done by `api::Tasks::diff`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_messages`  (lines 83–85)

```
fn get_task_messages(&self, id: TaskId) -> CloudBackendFuture<'_, Vec<String>>
```

**Purpose**: Fetches assistant text messages for a task. These are the human-readable responses produced by the assistant during the task.

**Data flow**: It receives a task ID, delegates to the task API wrapper, and returns a future that resolves to a list of message strings.

**Call relations**: This is the public trait method for message retrieval. It hands off to `api::Tasks::messages`, which knows how to extract messages from the server response.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_text`  (lines 87–89)

```
fn get_task_text(&self, id: TaskId) -> CloudBackendFuture<'_, TaskText>
```

**Purpose**: Fetches the full text view of a task: the user prompt, assistant messages, and current attempt metadata.

**Data flow**: It receives a task ID, creates the task API wrapper, and returns a future producing a `TaskText` structure.

**Call relations**: Higher-level display code can call this through `CloudBackend`. The detailed extraction is performed by `api::Tasks::task_text`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::list_sibling_attempts`  (lines 91–97)

```
fn list_sibling_attempts(
        &self,
        task: TaskId,
        turn_id: String,
    ) -> CloudBackendFuture<'_, Vec<TurnAttempt>>
```

**Purpose**: Lists alternative attempts for the same task turn. This is useful when a task was run multiple ways and the user wants to compare them.

**Data flow**: It receives a task ID and turn ID, creates the attempts API wrapper, and returns a future containing sorted `TurnAttempt` values.

**Call relations**: The trait method delegates to `api::Attempts::list`, which talks to the backend and converts raw turn data into local attempt objects.

*Call graph*: calls 1 internal fn (attempts_api); 1 external calls (pin).


##### `HttpClient::apply_task`  (lines 99–109)

```
fn apply_task(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Applies a task’s diff to the current local working directory. This is the action that turns cloud-generated changes into local file edits.

**Data flow**: It receives a task ID and optional diff override, creates the apply API wrapper, and returns a future with an `ApplyOutcome` describing success, partial success, or failure.

**Call relations**: Callers use this when they want to actually change local files. It delegates to `api::Apply::run` with preflight mode turned off.

*Call graph*: calls 1 internal fn (apply_api); 1 external calls (pin).


##### `HttpClient::apply_task_preflight`  (lines 111–121)

```
fn apply_task_preflight(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Checks whether a task’s diff would apply cleanly, without modifying files. This gives users a safe preview before applying changes.

**Data flow**: It receives a task ID and optional diff override, creates the apply API wrapper, and returns a future with the check result.

**Call relations**: Callers use this before a real apply. It delegates to `api::Apply::run` with preflight mode turned on.

*Call graph*: calls 1 internal fn (apply_api); 1 external calls (pin).


##### `HttpClient::create_task`  (lines 123–136)

```
fn create_task(
        &'a self,
        env_id: &'a str,
        prompt: &'a str,
        git_ref: &'a str,
        qa_mode: bool,
        best_of_n: usize,
    ) -> CloudBackendFuture<'a, crate::Cr
```

**Purpose**: Creates a new cloud task from a prompt, environment, git reference, and run options. This starts new work on the server.

**Data flow**: It receives the task inputs, builds a task API wrapper, and returns a future that resolves to the newly created task ID.

**Call relations**: This is the public trait entry for task creation. It delegates request-building and error logging to `api::Tasks::create`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `api::Tasks::new`  (lines 151–156)

```
fn new(client: &'a HttpClient) -> Self
```

**Purpose**: Builds the internal task API helper from an `HttpClient`. This helper carries just the pieces needed for task-related server calls.

**Data flow**: It borrows the base URL and backend client from the outer client and stores those references in a new `Tasks` wrapper.

**Call relations**: The outer `HttpClient` creates this wrapper whenever a task operation begins, then calls one of its task-specific methods.


##### `api::Tasks::list`  (lines 158–191)

```
async fn list(
            &self,
            env: Option<&str>,
            limit: Option<i64>,
            cursor: Option<&str>,
        ) -> Result<TaskListPage>
```

**Purpose**: Asks the server for a page of tasks and converts the server’s task rows into local summaries. It also records a short diagnostic log entry.

**Data flow**: It receives optional environment, limit, and cursor values, sends them to the backend list endpoint, maps each returned item into a `TaskSummary`, and returns a page containing summaries plus the next cursor.

**Call relations**: This is reached from `HttpClient::list_tasks`. It relies on `map_task_list_item_to_summary` for the per-task translation and uses `append_error_log` to record what was requested and returned.

*Call graph*: calls 2 internal fn (list_tasks, append_error_log); 1 external calls (format!).


##### `api::Tasks::summary`  (lines 193–260)

```
async fn summary(&self, id: TaskId) -> Result<TaskSummary>
```

**Purpose**: Fetches detailed information for one task and turns it into a concise local summary. It fills in status, timestamps, environment labels, review flag, attempt count, and diff stats.

**Data flow**: It receives a task ID, fetches both parsed details and the raw response body, reads JSON fields from the response, computes missing diff statistics from the actual diff when needed, and returns a `TaskSummary`.

**Call relations**: This is reached from `HttpClient::get_task_summary`. It uses helper functions to interpret status displays, timestamps, diff summaries, environment labels, and attempt counts.

*Call graph*: calls 1 internal fn (details_with_body); 7 external calls (attempt_total_from_status_display, diff_summary_from_diff, diff_summary_from_status_display, env_label_from_status_display, map_status, parse_updated_at, from_str).


##### `api::Tasks::diff`  (lines 262–272)

```
async fn diff(&self, id: TaskId) -> Result<Option<String>>
```

**Purpose**: Fetches the unified diff for a task when the server has one. A unified diff is the standard text format used by git to describe file changes.

**Data flow**: It receives a task ID, fetches task details with the raw body, asks the parsed response for its diff, and returns that diff or `None`.

**Call relations**: This is reached from `HttpClient::get_task_diff`. It uses `details_with_body` for the HTTP call, but only needs the parsed detail object for the final answer.

*Call graph*: calls 1 internal fn (details_with_body).


##### `api::Tasks::messages`  (lines 274–298)

```
async fn messages(&self, id: TaskId) -> Result<Vec<String>>
```

**Purpose**: Extracts assistant messages for a task, using fallback paths when the normal parsed response does not contain them. It produces text that can be shown to a user.

**Data flow**: It receives a task ID, fetches parsed details plus raw JSON, first asks the parsed response for assistant messages, then falls back to manually scanning the raw body. If the task has an assistant error, it returns a failure message; if nothing useful is found, it returns an HTTP-style error with debugging context.

**Call relations**: This is reached from `HttpClient::get_task_messages`. It uses `extract_assistant_messages_from_body` as a fallback and `details_path` to build a helpful URL for error messages.

*Call graph*: calls 1 internal fn (details_with_body); 5 external calls (Http, details_path, extract_assistant_messages_from_body, format!, vec!).


##### `api::Tasks::task_text`  (lines 300–327)

```
async fn task_text(&self, id: TaskId) -> Result<TaskText>
```

**Purpose**: Builds a fuller text package for a task, including the user prompt, assistant messages, current turn ID, sibling IDs, attempt placement, and attempt status.

**Data flow**: It receives a task ID, fetches task details and raw JSON, extracts prompt and messages, reads current assistant-turn metadata, converts the raw status string into a local status value, and returns `TaskText`.

**Call relations**: This is reached from `HttpClient::get_task_text`. It shares the same message fallback helper as `api::Tasks::messages` and uses `attempt_status_from_str` for status translation.

*Call graph*: calls 1 internal fn (details_with_body); 2 external calls (attempt_status_from_str, extract_assistant_messages_from_body).


##### `api::Tasks::create`  (lines 329–390)

```
async fn create(
            &self,
            env_id: &str,
            prompt: &str,
            git_ref: &str,
            qa_mode: bool,
            best_of_n: usize,
        ) -> Result<crate::C
```

**Purpose**: Builds the JSON request for a new task and sends it to the server. It can also include a starting diff from an environment variable and metadata for running multiple attempts.

**Data flow**: It receives environment ID, prompt, git branch/reference, QA-mode flag, and best-of count. It constructs the request body, optionally adds `CODEX_STARTING_DIFF` and `best_of_n`, sends the request, logs success or failure, and returns the created task ID or an HTTP error.

**Call relations**: This is reached from `HttpClient::create_task`. It hands the final JSON to the lower-level backend client and uses `append_error_log` for audit-style diagnostics.

*Call graph*: calls 2 internal fn (create_task, append_error_log); 6 external calls (new, Http, new, format!, json!, var).


##### `api::Tasks::details_with_body`  (lines 392–398)

```
async fn details_with_body(
            &self,
            id: &str,
        ) -> anyhow::Result<(backend::CodeTaskDetailsResponse, String, String)>
```

**Purpose**: Fetches task details while keeping both the parsed response and the raw server body. The raw body is important for fallback parsing and better error messages.

**Data flow**: It receives a task ID string, asks the backend for parsed details plus body and content type, and returns all three together.

**Call relations**: The summary, diff, messages, and task-text flows all call this helper so they can share one consistent way of retrieving task details.

*Call graph*: calls 1 internal fn (get_task_details_with_body); called by 4 (diff, messages, summary, task_text).


##### `api::Attempts::new`  (lines 406–410)

```
fn new(client: &'a HttpClient) -> Self
```

**Purpose**: Builds the internal attempts API helper from an `HttpClient`. This helper is focused only on sibling-turn lookup.

**Data flow**: It borrows the backend client from the outer client and stores that reference in a new `Attempts` wrapper.

**Call relations**: The outer `HttpClient` creates this wrapper when sibling attempts are requested, then calls `api::Attempts::list`.


##### `api::Attempts::list`  (lines 412–426)

```
async fn list(&self, task: TaskId, turn_id: String) -> Result<Vec<TurnAttempt>>
```

**Purpose**: Fetches sibling turns for a task and turns them into sorted local attempt objects. This gives callers a clean list of alternative attempts.

**Data flow**: It receives a task ID and turn ID, asks the backend for sibling turns, converts each usable raw map into a `TurnAttempt`, sorts the attempts into a stable order, and returns the list.

**Call relations**: This is reached from `HttpClient::list_sibling_attempts`. It depends on `turn_attempt_from_map` for conversion and `compare_attempts` for ordering.

*Call graph*: calls 1 internal fn (list_sibling_turns).


##### `api::Apply::new`  (lines 434–438)

```
fn new(client: &'a HttpClient) -> Self
```

**Purpose**: Builds the internal apply API helper from an `HttpClient`. This helper owns the logic for fetching and applying task diffs.

**Data flow**: It borrows the backend client from the outer client and stores that reference in a new `Apply` wrapper.

**Call relations**: The outer `HttpClient` creates this wrapper for both real apply and preflight apply requests, then calls `api::Apply::run`.


##### `api::Apply::run`  (lines 440–571)

```
async fn run(
            &self,
            task_id: TaskId,
            diff_override: Option<String>,
            preflight: bool,
        ) -> Result<ApplyOutcome>
```

**Purpose**: Applies a task patch locally, or checks whether it would apply cleanly. It protects users from unsupported patch formats and reports detailed success, partial, or failure information.

**Data flow**: It receives a task ID, an optional diff override, and a preflight flag. If no override is supplied, it fetches the task details and extracts the diff. It rejects non-unified diffs, builds an apply request for the current directory, runs the git patch helper, translates the result into an `ApplyOutcome`, and logs rich diagnostics when something goes wrong.

**Call relations**: This is reached from `HttpClient::apply_task` and `HttpClient::apply_task_preflight`. It uses diff-format checking, patch summaries, tail extraction, the git-apply helper, and `append_error_log` to make failures understandable.

*Call graph*: calls 2 internal fn (get_task_details, append_error_log); 9 external calls (new, new, is_unified_diff, summarize_patch_for_logging, apply_git_patch, format!, matches!, current_dir, writeln!).


##### `api::details_path`  (lines 574–582)

```
fn details_path(base_url: &str, id: &str) -> Option<String>
```

**Purpose**: Builds a likely task-details URL for error messages based on the configured base URL shape. It is only for diagnostics, not for making the request.

**Data flow**: It receives a base URL and task ID, checks which known API path style the base URL contains, and returns a formatted details URL when it recognizes the style.

**Call relations**: The messages flow uses this when it cannot find assistant text, so the resulting error points to the endpoint that was probably queried.

*Call graph*: 1 external calls (format!).


##### `api::extract_assistant_messages_from_body`  (lines 584–625)

```
fn extract_assistant_messages_from_body(body: &str) -> Vec<String>
```

**Purpose**: Manually scans the raw JSON response body for assistant messages. This is a fallback for cases where the typed response helper did not expose the text.

**Data flow**: It receives a raw JSON string, parses it as generic JSON, walks into the current assistant turn’s worklog messages, collects non-empty text parts written by the assistant, and returns them as strings.

**Call relations**: Both `api::Tasks::messages` and `api::Tasks::task_text` use this when their first, cleaner extraction path returns no messages.

*Call graph*: 1 external calls (new).


##### `api::turn_attempt_from_map`  (lines 627–642)

```
fn turn_attempt_from_map(turn: &HashMap<String, Value>) -> Option<TurnAttempt>
```

**Purpose**: Turns one raw sibling-turn JSON map into a local `TurnAttempt`. It extracts the useful pieces needed for comparison or display.

**Data flow**: It receives a map of JSON fields, requires an ID, then reads placement, creation time, status, diff, and assistant messages. If the required ID is missing, it returns nothing; otherwise it returns a populated attempt.

**Call relations**: The attempts listing flow calls this for every sibling turn returned by the backend. It delegates timestamp, status, diff, and message extraction to smaller helpers.

*Call graph*: 4 external calls (attempt_status_from_str, extract_assistant_messages_from_turn, extract_diff_from_turn, parse_timestamp_value).


##### `api::compare_attempts`  (lines 644–656)

```
fn compare_attempts(a: &TurnAttempt, b: &TurnAttempt) -> Ordering
```

**Purpose**: Defines the sort order for task attempts. It prefers explicit attempt placement, then creation time, then turn ID as a final tie-breaker.

**Data flow**: It receives two `TurnAttempt` values and compares their placement fields first. If those are missing, it compares timestamps, and if those are also missing, it compares IDs.

**Call relations**: The attempts listing flow uses this after converting raw sibling turns, so callers receive attempts in a predictable, user-friendly order.


##### `api::extract_diff_from_turn`  (lines 658–684)

```
fn extract_diff_from_turn(turn: &HashMap<String, Value>) -> Option<String>
```

**Purpose**: Finds a diff inside one raw turn object. The server may store it in more than one output-item shape, so this helper checks the known places.

**Data flow**: It receives a JSON map for a turn, reads its output items, looks for either an `output_diff` item or a pull-request item containing an output diff, and returns the first non-empty diff string found.

**Call relations**: This is used while building a `TurnAttempt` from raw backend data. It lets attempt objects carry their own patch when available.


##### `api::extract_assistant_messages_from_turn`  (lines 686–706)

```
fn extract_assistant_messages_from_turn(turn: &HashMap<String, Value>) -> Vec<String>
```

**Purpose**: Finds assistant text messages inside one raw turn object. It collects the text content from message output items.

**Data flow**: It receives a JSON map, walks through output items of type `message`, reads text parts from their content arrays, skips empty text, and returns the collected strings.

**Call relations**: This is used by `turn_attempt_from_map` so each sibling attempt can include the assistant response text that belongs to that attempt.

*Call graph*: 1 external calls (new).


##### `api::attempt_status_from_str`  (lines 708–716)

```
fn attempt_status_from_str(raw: Option<&str>) -> AttemptStatus
```

**Purpose**: Converts the server’s attempt status text into the project’s local `AttemptStatus` value. Unknown or missing statuses are treated as pending.

**Data flow**: It receives an optional raw status string, matches known values such as failed, completed, in progress, and pending, and returns the corresponding enum value.

**Call relations**: Task-text and sibling-attempt conversion use this so the rest of the program does not need to know the server’s exact status strings.


##### `api::parse_timestamp_value`  (lines 718–725)

```
fn parse_timestamp_value(v: Option<&Value>) -> Option<DateTime<Utc>>
```

**Purpose**: Converts a JSON number timestamp into a UTC date-time value. The timestamp is expected to be seconds since the Unix epoch, possibly with decimals.

**Data flow**: It receives an optional JSON value, reads it as a floating-point number, splits it into seconds and nanoseconds, and returns a `DateTime<Utc>` when possible.

**Call relations**: Sibling-attempt conversion uses this to turn raw creation times into sortable and displayable time values.

*Call graph*: 2 external calls (from, new).


##### `api::map_task_list_item_to_summary`  (lines 727–743)

```
fn map_task_list_item_to_summary(src: backend::TaskListItem) -> TaskSummary
```

**Purpose**: Converts one task row from the list endpoint into the local `TaskSummary` shape. This keeps the rest of the app independent from the backend’s list response format.

**Data flow**: It receives a backend task-list item, reads its ID, title, status display, update time, pull-request marker, environment label, diff stats, and attempt count, then returns a `TaskSummary`.

**Call relations**: The task listing flow applies this to every item returned by the server. It uses the same small helper functions as the detailed summary path where possible.

*Call graph*: 6 external calls (new, attempt_total_from_status_display, diff_summary_from_status_display, env_label_from_status_display, map_status, parse_updated_at).


##### `api::map_status`  (lines 745–772)

```
fn map_status(v: Option<&HashMap<String, Value>>) -> TaskStatus
```

**Purpose**: Translates server status information into the project’s simpler task status values: pending, ready, applied, or error.

**Data flow**: It receives optional status-display data, first checks the latest turn status when present, then falls back to a general state field, and returns a local `TaskStatus`. Missing or unknown values become pending.

**Call relations**: Both list and detailed-summary conversion use this so user-facing code sees consistent statuses even though the backend response can vary.


##### `api::parse_updated_at`  (lines 774–783)

```
fn parse_updated_at(ts: Option<&f64>) -> DateTime<Utc>
```

**Purpose**: Converts an optional numeric timestamp into a UTC date-time, using the current time if no timestamp is available.

**Data flow**: It receives an optional floating-point timestamp, turns it into seconds and nanoseconds since the Unix epoch, and returns a `DateTime<Utc>`. If the input is missing, it returns `Utc::now()`.

**Call relations**: Task-list and detailed-summary conversion use this to give every summary an updated time, even when the server omits one.

*Call graph*: 3 external calls (from, now, new).


##### `api::env_label_from_status_display`  (lines 785–790)

```
fn env_label_from_status_display(v: Option<&HashMap<String, Value>>) -> Option<String>
```

**Purpose**: Extracts a human-friendly environment label from status-display data. The label is what users can recognize more easily than an internal environment ID.

**Data flow**: It receives optional status-display data, looks for the `environment_label` string, and returns it when present.

**Call relations**: Task-list and detailed-summary conversion call this while building `TaskSummary` values.


##### `api::diff_summary_from_diff`  (lines 792–818)

```
fn diff_summary_from_diff(diff: &str) -> DiffSummary
```

**Purpose**: Counts changed files, added lines, and removed lines directly from a diff string. This is a fallback when the server does not provide diff statistics.

**Data flow**: It receives diff text, walks line by line, counts `diff --git` file markers, counts real added and removed lines while ignoring diff headers, and returns a `DiffSummary`.

**Call relations**: The detailed summary flow uses this only when the status-display diff stats are all zero but an actual diff is available.


##### `api::diff_summary_from_status_display`  (lines 820–839)

```
fn diff_summary_from_status_display(v: Option<&HashMap<String, Value>>) -> DiffSummary
```

**Purpose**: Reads diff statistics from the server’s status-display JSON. These stats summarize how many files and lines changed.

**Data flow**: It receives optional status-display data, finds the latest turn’s `diff_stats`, reads files modified, lines added, and lines removed, clamps negative values to zero, and returns a `DiffSummary`.

**Call relations**: Task-list and detailed-summary conversion use this as the first source of diff statistics.

*Call graph*: 1 external calls (default).


##### `api::latest_turn_timestamp`  (lines 841–850)

```
fn latest_turn_timestamp(v: Option<&HashMap<String, Value>>) -> Option<f64>
```

**Purpose**: Finds the newest timestamp from the latest turn status. This gives the summary a useful time even when the top-level task timestamp is missing.

**Data flow**: It receives optional status-display data, walks into the latest turn object, prefers its updated time, falls back to created time, and returns the numeric timestamp if found.

**Call relations**: The detailed summary flow uses this as a fallback after checking the task’s own updated and created timestamps.


##### `api::attempt_total_from_status_display`  (lines 852–859)

```
fn attempt_total_from_status_display(v: Option<&HashMap<String, Value>>) -> Option<usize>
```

**Purpose**: Estimates how many attempts exist for a task turn. It counts sibling turn IDs and adds one for the current turn.

**Data flow**: It receives optional status-display data, finds the latest turn’s sibling ID array, and returns its length plus one. If the data is missing, it returns nothing.

**Call relations**: Task-list and detailed-summary conversion use this to fill the attempt count shown in `TaskSummary`.


##### `api::is_unified_diff`  (lines 861–869)

```
fn is_unified_diff(diff: &str) -> bool
```

**Purpose**: Checks whether patch text looks like a unified git diff. This protects the apply path from sending an incompatible patch format to git.

**Data flow**: It receives diff text, trims leading whitespace, then checks for either a `diff --git` header or the standard `---`, `+++`, and hunk-marker pattern. It returns true only when the text looks applyable as a unified diff.

**Call relations**: `api::Apply::run` calls this before attempting local patch application. If it fails, the apply flow returns a clear error instead of running git blindly.


##### `api::tail`  (lines 871–877)

```
fn tail(s: &str, max: usize) -> String
```

**Purpose**: Returns the last part of a string, capped to a maximum length. This keeps log entries useful without dumping unlimited command output.

**Data flow**: It receives a string and maximum byte length. If the string is short enough it returns the whole string; otherwise it returns only the final slice.

**Call relations**: `api::Apply::run` uses this when logging stdout and stderr from patch application failures, so the most recent output is preserved.


##### `api::summarize_patch_for_logging`  (lines 879–905)

```
fn summarize_patch_for_logging(patch: &str) -> String
```

**Purpose**: Creates a compact diagnostic summary of a patch. It records the apparent patch kind, size, current directory, and the first few lines.

**Data flow**: It receives patch text, classifies its format, counts lines and characters, reads the current working directory, truncates the first 20 lines if needed, and returns one formatted summary string.

**Call relations**: `api::Apply::run` uses this when a patch is not in the expected format or when apply/preflight fails, making `error.log` easier to understand.

*Call graph*: 2 external calls (format!, current_dir).


##### `append_error_log`  (lines 908–918)

```
fn append_error_log(message: &str)
```

**Purpose**: Appends a timestamped diagnostic message to `error.log` in the current directory. It is a best-effort helper: logging failures are ignored.

**Data flow**: It receives a message string, gets the current time, opens or creates `error.log` in append mode, and writes one timestamped line or block.

**Call relations**: Task listing, task creation, and patch application call this to leave breadcrumbs about requests, failures, and patch details without interrupting the main user flow.

*Call graph*: called by 3 (run, create, list); 3 external calls (now, new, writeln!).


### `config/src/thread_config/remote.rs`

`io_transport` · `config load`

A thread needs configuration before it can run: which model provider to use, which feature flags are on, and how authentication should work. This file is the bridge to a remote configuration service. Without it, any setup stored outside the local machine would be unavailable, and the rest of the app would not know how to ask for it.

The main type, RemoteThreadConfigLoader, stores the remote endpoint address. When asked to load configuration, it opens a gRPC client connection, builds a request containing the thread id and current working directory, sets a five-second timeout, sends the request, and receives a list of configuration sources. The remote service replies using generated protocol-buffer types, which are compact network message shapes. This file then translates those wire-format messages into the project’s internal Rust types.

It is careful about bad remote data. Missing payloads, missing provider ids, unknown wire API values, zero authentication timeouts, and invalid absolute paths become parse errors. Network failures, authentication failures, and timeouts are also converted into the project’s standard ThreadConfigLoadError, so callers do not need to understand gRPC details. The test code starts a small in-process gRPC server to prove that requests are formed correctly and that provider data survives a round trip.

#### Function details

##### `RemoteThreadConfigLoader::new`  (lines 33–37)

```
fn new(endpoint: impl Into<String>) -> Self
```

**Purpose**: Creates a remote configuration loader pointed at a specific service address. Callers use this when the app has been configured to fetch thread settings over the network.

**Data flow**: It receives an endpoint value, such as a URL-like string, converts it into an owned String, and stores it inside a new RemoteThreadConfigLoader. Nothing is contacted yet; this only prepares the loader for later use.

**Call relations**: Higher-level setup code such as configured_thread_config_loader calls this when choosing a remote loader. The integration-style test load_thread_config_calls_remote_service also uses it to point the loader at a temporary test server.

*Call graph*: called by 3 (configured_thread_config_loader, configured_thread_config_loader, load_thread_config_calls_remote_service); 1 external calls (into).


##### `RemoteThreadConfigLoader::client`  (lines 39–51)

```
async fn client(
        &self,
    ) -> Result<ThreadConfigLoaderClient<tonic::transport::Channel>, ThreadConfigLoadError>
```

**Purpose**: Opens a gRPC client connection to the configured remote service. It hides the network connection details and returns the project’s normal load error if the connection fails.

**Data flow**: It reads the loader’s endpoint string, asks the generated ThreadConfigLoaderClient to connect to that address, and returns the connected client. If the connection attempt fails, it turns the low-level connection error into a ThreadConfigLoadError marked as a request failure.

**Call relations**: RemoteThreadConfigLoader::load calls this first, before it can ask the service for configuration. If this step fails, the load stops early and no request is sent.

*Call graph*: called by 1 (load); 1 external calls (connect).


##### `RemoteThreadConfigLoader::load`  (lines 74–79)

```
fn load(
        &self,
        context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Fetches thread configuration from the remote service and returns it in the app’s normal configuration shape. This is the main operation provided by the remote loader.

**Data flow**: It receives a ThreadConfigContext containing details like the thread id and current directory. It opens a client, turns the context into a timed gRPC request, sends that request, maps any remote status error into a ThreadConfigLoadError, unwraps the response body, and converts each returned source from protocol-buffer form into internal ThreadConfigSource values.

**Call relations**: The ThreadConfigLoader trait exposes this method to the rest of the configuration system. Internally it depends on client to connect, load_thread_config_request to build the outbound request, remote_status_to_error for failed remote calls, and thread_config_source_from_proto for decoding the reply.

*Call graph*: calls 2 internal fn (client, load_thread_config_request); 1 external calls (pin).


##### `load_thread_config_request`  (lines 82–91)

```
fn load_thread_config_request(
    context: ThreadConfigContext,
) -> tonic::Request<proto::LoadThreadConfigRequest>
```

**Purpose**: Builds the network request sent to the remote configuration service. It also sets a five-second deadline so a stuck service does not make configuration loading hang forever.

**Data flow**: It receives a ThreadConfigContext, copies the optional thread id and current working directory into a protocol-buffer request message, wraps that message in a tonic request, sets the request timeout, and returns it ready to send.

**Call relations**: RemoteThreadConfigLoader::load uses this just before calling the remote service. The test load_thread_config_request_sets_timeout calls it directly to confirm the timeout metadata is present.

*Call graph*: calls 1 internal fn (new); called by 2 (load, load_thread_config_request_sets_timeout).


##### `remote_status_to_error`  (lines 93–119)

```
fn remote_status_to_error(status: tonic::Status) -> ThreadConfigLoadError
```

**Purpose**: Turns a gRPC failure status into the project’s own error type. This keeps the rest of the config-loading code from needing to know gRPC status codes.

**Data flow**: It receives a tonic Status from a failed remote call, looks at its code, chooses a matching ThreadConfigLoadErrorCode such as Auth, Timeout, or RequestFailed, and returns a ThreadConfigLoadError with a human-readable message.

**Call relations**: RemoteThreadConfigLoader::load uses this when the remote load call returns an error. It is the translation checkpoint between network-protocol errors and the configuration system’s shared error language.

*Call graph*: calls 1 internal fn (new); 2 external calls (code, format!).


##### `thread_config_source_from_proto`  (lines 121–133)

```
fn thread_config_source_from_proto(
    source: proto::ThreadConfigSource,
) -> Result<ThreadConfigSource, ThreadConfigLoadError>
```

**Purpose**: Converts one remote configuration source from protocol-buffer form into the app’s internal ThreadConfigSource enum. It makes sure the remote message actually contains a usable payload.

**Data flow**: It receives a proto ThreadConfigSource. If the source is a session config, it converts that nested session data. If it is a user config, it currently returns the default user config. If the source is missing entirely, it returns a parse error.

**Call relations**: RemoteThreadConfigLoader::load applies this to every source returned by the remote service. It hands session payloads to session_thread_config_from_proto and uses parse_error when the remote message is incomplete.

*Call graph*: calls 2 internal fn (parse_error, session_thread_config_from_proto); 2 external calls (User, default).


##### `session_thread_config_from_proto`  (lines 135–149)

```
fn session_thread_config_from_proto(
    config: proto::SessionThreadConfig,
) -> Result<SessionThreadConfig, ThreadConfigLoadError>
```

**Purpose**: Converts a remote session-level configuration message into the app’s SessionThreadConfig type. This includes the chosen model provider, the provider definitions, and feature switches.

**Data flow**: It receives a proto SessionThreadConfig, converts each model provider entry into a keyed internal provider record, collects feature flags into an ordered map, and returns a SessionThreadConfig. If any provider is invalid, the whole conversion returns that error.

**Call relations**: thread_config_source_from_proto calls this when a remote source is a session config. It relies on model_provider_from_proto for each provider entry so provider-specific validation happens in one place.

*Call graph*: called by 1 (thread_config_source_from_proto).


##### `model_provider_from_proto`  (lines 151–195)

```
fn model_provider_from_proto(
    provider: proto::ModelProvider,
) -> Result<(String, ModelProviderInfo), ThreadConfigLoadError>
```

**Purpose**: Converts one remote model-provider definition into the internal ModelProviderInfo form. It also validates important fields so the app does not accept broken provider settings.

**Data flow**: It receives a proto ModelProvider. It checks that the provider has an id, converts the numeric wire API value into the internal WireApi enum, converts optional authentication data, copies URLs, headers, retry limits, timeouts, and capability flags, then returns the provider id together with the built ModelProviderInfo. Bad or missing required values become parse errors.

**Call relations**: session_thread_config_from_proto uses this while decoding remote session config, and the test model_provider_proto_roundtrips_through_domain_type calls it after producing proto data. It calls model_provider_auth_from_proto for nested authentication details and parse_error for invalid remote data.

*Call graph*: calls 1 internal fn (parse_error); called by 1 (model_provider_proto_roundtrips_through_domain_type); 2 external calls (try_from, format!).


##### `model_provider_to_proto`  (lines 198–241)

```
fn model_provider_to_proto(
    id: impl Into<String>,
    provider: ModelProviderInfo,
) -> proto::ModelProvider
```

**Purpose**: Test-only helper that converts an internal ModelProviderInfo back into protocol-buffer form. It lets tests check that provider data can travel through the proto shape without changing.

**Data flow**: It receives a provider id and a ModelProviderInfo, breaks the internal struct into its fields, converts authentication and wire API values into proto equivalents, wraps optional string maps, and returns a proto ModelProvider.

**Call relations**: The test model_provider_proto_roundtrips_through_domain_type uses this to create a proto message, then sends that proto through model_provider_from_proto to verify the conversion path. It calls proto_wire_api for the API enum conversion.

*Call graph*: calls 1 internal fn (proto_wire_api); called by 1 (model_provider_proto_roundtrips_through_domain_type); 1 external calls (into).


##### `model_provider_auth_from_proto`  (lines 243–262)

```
fn model_provider_auth_from_proto(
    auth: proto::ModelProviderAuthInfo,
) -> Result<ModelProviderAuthInfo, ThreadConfigLoadError>
```

**Purpose**: Converts remote authentication-helper settings into the app’s internal authentication config. It checks values that would be unsafe or nonsensical if accepted blindly.

**Data flow**: It receives proto authentication data with a command, arguments, timeout, refresh interval, and working directory. It rejects a zero timeout, verifies that the working directory string is an absolute path, and returns a ModelProviderAuthInfo using the validated values.

**Call relations**: model_provider_from_proto calls this when the remote provider includes authentication settings. It uses parse_error-style failures so bad authentication data is reported as a remote parse problem.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (new).


##### `model_provider_auth_to_proto`  (lines 265–281)

```
fn model_provider_auth_to_proto(auth: ModelProviderAuthInfo) -> proto::ModelProviderAuthInfo
```

**Purpose**: Test-only helper that converts internal authentication settings into protocol-buffer form. It supports round-trip tests for model provider data.

**Data flow**: It receives a ModelProviderAuthInfo, extracts the command, arguments, non-zero timeout, refresh interval, and working directory, turns the path into a string, and returns a proto ModelProviderAuthInfo.

**Call relations**: model_provider_to_proto uses this for optional provider authentication data during tests. The production load path uses the opposite converter, model_provider_auth_from_proto.


##### `proto_string_map`  (lines 284–286)

```
fn proto_string_map(values: HashMap<String, String>) -> proto::StringMap
```

**Purpose**: Test-only helper that wraps a normal string-to-string map in the generated proto StringMap type. It keeps test setup concise when building provider headers or query parameters.

**Data flow**: It receives a HashMap of strings and places it directly into a proto StringMap. The output is a protocol-buffer wrapper around the same key-value data.

**Call relations**: model_provider_to_proto uses this in test builds when converting optional maps such as query parameters, HTTP headers, and environment-driven headers.


##### `proto_wire_api`  (lines 289–293)

```
fn proto_wire_api(wire_api: WireApi) -> proto::WireApi
```

**Purpose**: Test-only helper that converts the internal WireApi enum into the generated proto enum. At present it maps the supported Responses API value.

**Data flow**: It receives a WireApi value and returns the matching proto WireApi value. Since only Responses is represented here, the mapping is direct.

**Call relations**: model_provider_to_proto calls this while building a proto provider for tests. Production decoding uses the generated try_from conversion in model_provider_from_proto.

*Call graph*: called by 1 (model_provider_to_proto).


##### `parse_error`  (lines 295–301)

```
fn parse_error(message: impl Into<String>) -> ThreadConfigLoadError
```

**Purpose**: Creates a standard configuration-load error for malformed remote data. It gives all parsing failures the same error code and shape.

**Data flow**: It receives a message, converts it into a String, and returns a ThreadConfigLoadError with the Parse code and no HTTP-style status code.

**Call relations**: Conversion functions such as thread_config_source_from_proto and model_provider_from_proto call this when the remote service omits required data or sends values this app cannot understand.

*Call graph*: calls 1 internal fn (new); called by 2 (model_provider_from_proto, thread_config_source_from_proto); 1 external calls (into).


##### `tests::TestServer::load`  (lines 350–366)

```
fn load(
            &'a self,
            request: Request<proto::LoadThreadConfigRequest>,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
```

**Purpose**: Acts as a fake remote configuration service for tests. It verifies that the client sends the expected request and then returns prepared configuration sources.

**Data flow**: It receives a gRPC request, checks that the thread id and current directory match the test’s expectations, and returns a response containing the server’s stored proto sources. If the request is wrong, the assertion fails the test.

**Call relations**: The test gRPC server calls this when RemoteThreadConfigLoader sends a load request during load_thread_config_calls_remote_service. It plays the remote-service side of the conversation.

*Call graph*: 4 external calls (pin, assert_eq!, new, load).


##### `tests::load_thread_config_calls_remote_service`  (lines 370–405)

```
async fn load_thread_config_calls_remote_service()
```

**Purpose**: Tests the full remote-loading path against a real in-process gRPC server. It proves that the loader connects, sends the right context, receives sources, and decodes them correctly.

**Data flow**: It creates a fake workspace directory, starts a temporary server with known proto sources, builds a RemoteThreadConfigLoader pointed at that server, asks it to load config for a thread, shuts the server down, and compares the loaded internal sources with the expected result.

**Call relations**: This test uses RemoteThreadConfigLoader::new to create the client side, tests::TestServer::load as the server side, proto_sources as the remote reply, and expected_sources as the value the client should produce.

*Call graph*: calls 1 internal fn (new); 10 external calls (builder, assert_eq!, new, proto_sources, workspace_dir, format!, bind, spawn, channel, new).


##### `tests::load_thread_config_request_sets_timeout`  (lines 408–418)

```
fn load_thread_config_request_sets_timeout()
```

**Purpose**: Checks that outbound remote configuration requests include the intended timeout. This protects against future changes that might accidentally allow remote loading to wait forever.

**Data flow**: It builds a request from a default ThreadConfigContext, reads the gRPC timeout metadata, and asserts that it matches the five-second timeout encoded in microseconds.

**Call relations**: It calls load_thread_config_request directly, focusing only on request construction rather than starting a server or making a network call.

*Call graph*: calls 1 internal fn (load_thread_config_request); 2 external calls (assert_eq!, default).


##### `tests::model_provider_proto_roundtrips_through_domain_type`  (lines 421–428)

```
fn model_provider_proto_roundtrips_through_domain_type()
```

**Purpose**: Tests that model provider settings survive conversion to proto form and back into the internal type. This is important because remote configuration depends on this translation being faithful.

**Data flow**: It builds an expected provider, converts it into a proto provider with id local, converts that proto provider back with model_provider_from_proto, and checks both the id and provider fields against the original.

**Call relations**: It uses expected_provider as the source data, model_provider_to_proto for the test-only outgoing conversion, and model_provider_from_proto for the production-style incoming conversion.

*Call graph*: calls 2 internal fn (model_provider_from_proto, model_provider_to_proto); 2 external calls (assert_eq!, expected_provider).


##### `tests::proto_sources`  (lines 430–490)

```
fn proto_sources() -> Vec<proto::ThreadConfigSource>
```

**Purpose**: Builds the fake remote service’s response data for tests. The data includes both a session config and a user config source.

**Data flow**: It reads the test workspace directory, creates proto messages for a model provider, authentication helper, headers, query parameters, retry and timeout settings, feature flags, and a user source, then returns them as a vector.

**Call relations**: load_thread_config_calls_remote_service gives this data to TestServer so the fake server can return it to RemoteThreadConfigLoader.

*Call graph*: 2 external calls (workspace_dir, vec!).


##### `tests::expected_sources`  (lines 492–504)

```
fn expected_sources() -> Vec<ThreadConfigSource>
```

**Purpose**: Builds the internal configuration values that should result from decoding the fake remote response. It is the test’s answer key.

**Data flow**: It creates a vector containing an internal SessionThreadConfig with the expected provider and feature flags, followed by a default UserThreadConfig. The returned value is compared with what the loader actually produced.

**Call relations**: load_thread_config_calls_remote_service uses this after the remote load finishes. It relies on expected_provider so the provider details match the proto data from proto_sources.

*Call graph*: 1 external calls (vec!).


##### `tests::expected_provider`  (lines 506–541)

```
fn expected_provider() -> ModelProviderInfo
```

**Purpose**: Creates the expected internal model-provider record used by the tests. It centralizes the provider details so both round-trip and remote-load tests compare against the same shape.

**Data flow**: It builds a ModelProviderInfo with a name, base URL, authentication command, absolute working directory, wire API, query parameters, headers, retry settings, timeout settings, and capability flags, then returns it.

**Call relations**: expected_sources uses this as part of the decoded configuration answer key, and model_provider_proto_roundtrips_through_domain_type uses it as the original value for conversion testing.

*Call graph*: 4 external calls (from, new, workspace_dir, vec!).


##### `tests::workspace_dir`  (lines 543–547)

```
fn workspace_dir() -> AbsolutePathBuf
```

**Purpose**: Creates a stable absolute path for test workspace data. Tests need an absolute path because authentication configuration rejects relative working directories.

**Data flow**: It reads the current process directory, turns it into an AbsolutePathBuf, appends workspace, and returns that path.

**Call relations**: proto_sources and expected_provider call this so the proto test data and expected internal data refer to the same working directory. load_thread_config_calls_remote_service also uses it when sending context to the fake server.

*Call graph*: calls 1 internal fn (current_dir).


### `lmstudio/src/client.rs`

`io_transport` · `model setup and local LM Studio communication`

LM Studio lets a user run language models on their own computer. This file gives the rest of the project a small, focused client for talking to that local service, instead of making every caller know the LM Studio web addresses, response shapes, and command-line details. Think of it as a receptionist: it knows where LM Studio is, checks whether anyone is answering, asks for the model list, and sends a small request to wake up a model when needed.

The main type is `LMStudioClient`. It stores an HTTP client, which is the tool used to make web requests, and a `base_url`, which is the root address of the LM Studio server. `try_from_provider` builds this client from the project configuration and refuses to continue if the built-in LM Studio provider is missing or unusable. `check_server` then probes the `/models` endpoint so users get a clear message if LM Studio is not running.

For normal use, `fetch_models` reads the server’s model list, `load_model` sends a tiny request to make LM Studio load a chosen model, and `download_model` shells out to the `lms` command-line program to fetch a missing model. The tests use a fake HTTP server so they can check success and failure cases without depending on a real LM Studio installation.

#### Function details

##### `LMStudioClient::try_from_provider`  (lines 15–44)

```
async fn try_from_provider(config: &Config) -> std::io::Result<Self>
```

**Purpose**: Builds an `LMStudioClient` from the project configuration. It is used when the system wants to use the built-in LM Studio provider and needs a ready-to-use connection object.

**Data flow**: It receives the global configuration, looks up the LM Studio provider entry, reads its server address, creates an HTTP client with a short connection timeout, and checks that the server responds. If anything important is missing or the server cannot be reached, it returns an input/output error; otherwise it returns a ready client.

**Call relations**: `ensure_oss_ready` calls this when preparing the local open-source model flow. This function is the doorway from general configuration into the LM Studio-specific client used by later model operations.

*Call graph*: called by 1 (ensure_oss_ready); 2 external calls (builder, from_secs).


##### `LMStudioClient::check_server`  (lines 46–62)

```
async fn check_server(&self) -> io::Result<()>
```

**Purpose**: Checks whether the LM Studio server is alive and responding. It gives a clear, user-facing error if the local server is missing, stopped, or returning an error.

**Data flow**: It takes the client’s stored base URL, adds `/models`, and sends a GET request. A successful HTTP status becomes `Ok(())`; a failed status or network failure becomes an error that tells the user to install LM Studio and run `lms server start`.

**Call relations**: This is the client’s health check. Client setup uses it to avoid handing back a connection that cannot actually talk to LM Studio, and the tests exercise both the healthy and failing paths with a fake server.

*Call graph*: 3 external calls (get, other, format!).


##### `LMStudioClient::load_model`  (lines 65–92)

```
async fn load_model(&self, model: &str) -> io::Result<()>
```

**Purpose**: Asks LM Studio to load a specific model into memory. It does this by sending a tiny request that names the model and asks for almost no output.

**Data flow**: It receives a model name, builds a JSON request body with that name, an empty input, and `max_output_tokens` set to 1, then posts it to the `/responses` endpoint. If LM Studio accepts the request, it logs success and returns nothing; if the request fails or LM Studio returns an error status, it returns an input/output error.

**Call relations**: This function is used after a model has been chosen and the program wants LM Studio to be ready to answer real prompts. It hands the actual loading work off to LM Studio through its HTTP API.

*Call graph*: 5 external calls (post, other, format!, json!, info!).


##### `LMStudioClient::fetch_models`  (lines 95–124)

```
async fn fetch_models(&self) -> io::Result<Vec<String>>
```

**Purpose**: Gets the list of model IDs currently available from the LM Studio server. Callers use it to show or choose from the local models LM Studio knows about.

**Data flow**: It sends a GET request to `/models`, parses the response as JSON, expects a `data` array, and pulls each model’s `id` field out as a string. The result is a list of model names; bad HTTP responses, invalid JSON, or a missing `data` array become errors.

**Call relations**: This is the read side of the LM Studio client. The test suite calls it through a client pointed at a fake server to confirm that normal model lists, malformed responses, and server errors are all reported correctly.

*Call graph*: 3 external calls (get, other, format!).


##### `LMStudioClient::find_lms`  (lines 127–129)

```
fn find_lms() -> std::io::Result<String>
```

**Purpose**: Finds the `lms` command-line program that comes with LM Studio. This is needed before the code can ask LM Studio to download a model from the command line.

**Data flow**: It takes no input and delegates the search to `find_lms_with_home_dir`, using the real home directory from the operating system. The output is either a command name or full path that can be executed, or an error saying LM Studio was not found.

**Call relations**: `download_model` relies on this search before running `lms get --yes ...`. The `test_find_lms` test calls it directly and accepts either success, when LM Studio is installed, or the expected not-found error.

*Call graph*: called by 1 (test_find_lms); 1 external calls (find_lms_with_home_dir).


##### `LMStudioClient::find_lms_with_home_dir`  (lines 131–166)

```
fn find_lms_with_home_dir(home_dir: Option<&str>) -> std::io::Result<String>
```

**Purpose**: Searches for the LM Studio `lms` command, with an optional home directory supplied for testing. It first checks the normal command path, then checks LM Studio’s usual install location under the user’s home folder.

**Data flow**: It receives an optional home directory. It first asks whether `lms` is available in the system `PATH`; if so, it returns `lms`. If not, it builds the platform-specific fallback path, such as `.lmstudio/bin/lms` or `.lmstudio/bin/lms.exe`, checks whether that file exists, and returns that path or a not-found error.

**Call relations**: `find_lms` uses this as the real search worker. `test_find_lms_with_mock_home` calls it with a fake home directory so the fallback-path behavior can be checked without changing the user’s environment.

*Call graph*: called by 1 (test_find_lms_with_mock_home); 5 external calls (new, new, format!, var, which).


##### `LMStudioClient::download_model`  (lines 168–190)

```
async fn download_model(&self, model: &str) -> std::io::Result<()>
```

**Purpose**: Downloads a model by running LM Studio’s own `lms` command-line tool. This lets the program fetch a model even though the download operation is not done through the HTTP server.

**Data flow**: It receives a model name, finds the `lms` executable, prints a download message, and runs `lms get --yes <model>`. Standard output is shown to the user, standard error is hidden, and the process exit status is checked. A successful command returns `Ok(())`; a missing command, failed launch, or nonzero exit code becomes an error.

**Call relations**: This function bridges the Rust client to LM Studio’s external command-line program. It depends on `find_lms` for the executable location and then hands the actual download work to that program.

*Call graph*: 8 external calls (find_lms, new, other, eprintln!, format!, inherit, null, info!).


##### `LMStudioClient::from_host_root`  (lines 194–203)

```
fn from_host_root(host_root: impl Into<String>) -> Self
```

**Purpose**: Creates an `LMStudioClient` directly from a raw server address. It exists only for tests, where the client needs to point at a fake server instead of reading normal configuration.

**Data flow**: It receives a host root such as `http://localhost:1234`, creates an HTTP client with the same timeout used in normal construction, and stores the given address as the base URL. It returns a client without checking whether the server is real.

**Call relations**: The tests use this helper to aim the client at a `wiremock` fake server. That keeps tests focused on client behavior without needing a real LM Studio server running.

*Call graph*: called by 6 (test_check_server_error, test_check_server_happy_path, test_fetch_models_happy_path, test_fetch_models_no_data_array, test_fetch_models_server_error, test_from_host_root); 3 external calls (into, builder, from_secs).


##### `tests::test_fetch_models_happy_path`  (lines 212–241)

```
async fn test_fetch_models_happy_path()
```

**Purpose**: Checks that `fetch_models` succeeds when the server returns a normal model list. It proves the client can read the expected LM Studio response shape.

**Data flow**: The test starts a fake HTTP server, configures `/models` to return JSON with one model ID, builds a client with `from_host_root`, calls `fetch_models`, and verifies the returned list contains that model. If network use is disabled in the sandbox, it skips itself.

**Call relations**: This test drives `from_host_root` and then the model-list request path. It stands in for a healthy LM Studio server so the parsing behavior can be checked reliably.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert!, json!, var, info!, given, start, new, method, path).


##### `tests::test_fetch_models_no_data_array`  (lines 244–272)

```
async fn test_fetch_models_no_data_array()
```

**Purpose**: Checks that `fetch_models` reports a clear error when the server response is missing the expected `data` array.

**Data flow**: The test starts a fake server that returns an empty JSON object for `/models`, builds a client pointed at that server, and calls `fetch_models`. The expected result is an error whose text mentions that no `data` array was found.

**Call relations**: This test uses `from_host_root` to isolate the client from real LM Studio. It exercises the bad-response branch of the model-list parsing logic.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert!, json!, var, info!, given, start, new, method, path).


##### `tests::test_fetch_models_server_error`  (lines 275–300)

```
async fn test_fetch_models_server_error()
```

**Purpose**: Checks that `fetch_models` reports an error when LM Studio returns an HTTP server error. This protects callers from silently treating a failed server response as an empty model list.

**Data flow**: The test starts a fake server that answers `/models` with status 500, builds a client for that server, and calls `fetch_models`. It verifies that the result is an error mentioning the failed status code.

**Call relations**: This test again uses `from_host_root` to point at a controlled fake server. It confirms the client’s HTTP error handling for model listing.

*Call graph*: calls 1 internal fn (from_host_root); 8 external calls (assert!, var, info!, given, start, new, method, path).


##### `tests::test_check_server_happy_path`  (lines 303–324)

```
async fn test_check_server_happy_path()
```

**Purpose**: Checks that the server health check passes when `/models` returns success. This confirms that a reachable LM Studio-like server is accepted.

**Data flow**: The test starts a fake server, makes `/models` return status 200, creates a client with `from_host_root`, and calls the health check. The expected output is success, with no error.

**Call relations**: This test builds the client through the test-only constructor and exercises the same health-check endpoint used during normal client setup.

*Call graph*: calls 1 internal fn (from_host_root); 7 external calls (var, info!, given, start, new, method, path).


##### `tests::test_check_server_error`  (lines 327–352)

```
async fn test_check_server_error()
```

**Purpose**: Checks that the server health check fails when `/models` returns an error status. This ensures users get a useful failure instead of a misleading ready client.

**Data flow**: The test starts a fake server that returns status 404 for `/models`, creates a client pointing at it, and calls the health check. It expects an error message that includes the returned status.

**Call relations**: This test uses `from_host_root` to create a controlled failing server situation. It validates the error path of the LM Studio readiness check.

*Call graph*: calls 1 internal fn (from_host_root); 8 external calls (assert!, var, info!, given, start, new, method, path).


##### `tests::test_find_lms`  (lines 355–367)

```
fn test_find_lms()
```

**Purpose**: Checks the search for the LM Studio `lms` command in the real local environment. The test is written to pass whether or not LM Studio is installed.

**Data flow**: It calls `find_lms`. If a command path is found, that is acceptable; if not, the error must say that LM Studio was not found.

**Call relations**: This test calls `find_lms` directly. It gives basic coverage for the command lookup used later by `download_model`.

*Call graph*: calls 1 internal fn (find_lms); 1 external calls (assert!).


##### `tests::test_find_lms_with_mock_home`  (lines 370–387)

```
fn test_find_lms_with_mock_home()
```

**Purpose**: Checks the fallback command search using a made-up home directory. This verifies the path-building logic without depending on the tester’s actual home folder.

**Data flow**: It passes a fake Unix or Windows home path into `find_lms_with_home_dir`. If the fake fallback path does not exist, the function should return an error that says LM Studio was not found.

**Call relations**: This test calls the lower-level search helper directly. It supports the reliability of `find_lms`, which is the lookup step used before downloading a model.

*Call graph*: calls 1 internal fn (find_lms_with_home_dir); 1 external calls (assert!).


##### `tests::test_from_host_root`  (lines 390–396)

```
fn test_from_host_root()
```

**Purpose**: Checks that the test-only constructor stores the server address exactly as given. This matters because the other tests depend on it to point at their fake servers.

**Data flow**: It creates clients from two sample URLs and compares each client’s stored `base_url` with the original input. The output is only the test assertion result.

**Call relations**: This test calls `from_host_root` directly. It gives confidence that the helper used by the HTTP tests does not rewrite or damage the fake server address.

*Call graph*: calls 1 internal fn (from_host_root); 1 external calls (assert_eq!).


### API endpoint session layer
These files define provider configuration and the endpoint/session scaffolding that higher-level API clients use to assemble and execute requests.

### `codex-api/src/provider.rs`

`io_transport` · `request handling`

This file is the project’s “address book entry” for an API provider. A provider might be OpenAI, Azure OpenAI, or another compatible service. Without this file, the rest of the system would have to repeatedly guess how to build URLs, attach default headers, decide retry behavior, and convert normal web URLs into WebSocket URLs.

The two main pieces are `RetryConfig` and `Provider`. `RetryConfig` is a simple, human-sized retry setup: how many tries are allowed, how long to wait before trying again, and which kinds of failures are worth retrying. It can be converted into the lower-level retry policy used by the HTTP client.

`Provider` stores the practical details for one API deployment: its name, base URL, optional query parameters, headers, retry settings, and stream idle timeout. It can turn a path like `/responses` into a full URL, build a request object with the provider’s defaults, and produce a WebSocket URL when the connection needs to stay open for real-time communication.

The file also contains Azure detection logic. Some endpoints need slightly different request shapes when they are Azure “responses” endpoints, so this file checks both the provider name and known Azure URL patterns.

#### Function details

##### `RetryConfig::to_policy`  (lines 25–35)

```
fn to_policy(&self) -> RetryPolicy
```

**Purpose**: This turns the friendly retry settings stored in `RetryConfig` into the exact retry policy expected by the lower-level HTTP client. It is used when the transport layer needs concrete instructions for when to try a failed request again.

**Data flow**: It starts with `max_attempts`, `base_delay`, and three yes-or-no retry choices from the `RetryConfig`. It copies those values into a `RetryPolicy`, grouping the retry reasons into a `RetryOn` object. The result is a ready-to-use retry policy; the original config is not changed.

**Call relations**: This is the bridge between provider-level configuration and the client code that actually performs retries. Higher-level setup can keep retry rules readable, then call this when it needs the format used by `codex-client`.


##### `Provider::url_for_path`  (lines 53–75)

```
fn url_for_path(&self, path: &str) -> String
```

**Purpose**: This builds a complete request URL from the provider’s base URL and a path. It also adds any provider-wide query parameters, like fixed options that must be present on every request.

**Data flow**: It takes a path, removes extra slashes at the join point, and combines it with `base_url`. If the provider has query parameters, it turns them into `key=value` text joined with `&` and appends them after a `?`. The output is a full URL string.

**Call relations**: Other request-building code depends on this as the single place where provider URLs are assembled. `Provider::build_request` uses it for normal HTTP requests, and `Provider::websocket_url_for_path` uses it before converting the URL to WebSocket form.

*Call graph*: called by 2 (build_request, websocket_url_for_path); 1 external calls (format!).


##### `Provider::build_request`  (lines 77–86)

```
fn build_request(&self, method: Method, path: &str) -> Request
```

**Purpose**: This creates a basic HTTP request object for a provider and path, already filled with the provider’s URL and default headers. It is useful because callers do not have to remember the provider’s base address or shared headers each time.

**Data flow**: It receives an HTTP method, such as GET or POST, and a path. It asks `Provider::url_for_path` for the full URL, clones the provider’s headers so the request has its own copy, and creates a `Request` with no body, no compression, and no custom timeout yet. The result is a request ready for later code to add body data or send.

**Call relations**: This is called by `make_request` when the system is preparing an outbound API call. It hands off a standardized request object so later steps can focus on request-specific content instead of provider defaults.

*Call graph*: calls 1 internal fn (url_for_path); called by 1 (make_request); 1 external calls (clone).


##### `Provider::is_azure_responses_endpoint`  (lines 88–90)

```
fn is_azure_responses_endpoint(&self) -> bool
```

**Purpose**: This answers whether this provider should be treated as an Azure Responses endpoint. That matters because Azure-compatible APIs can require different URL or request formatting than the default provider.

**Data flow**: It reads the provider’s name and base URL, then passes them to `is_azure_responses_provider`. It returns `true` if either the name or URL suggests Azure, otherwise `false`. It does not change the provider.

**Call relations**: This is called by `build_responses_request` when a Responses API request is being prepared. It acts like a routing sign: if the provider looks like Azure, request construction can choose the Azure-specific path.

*Call graph*: calls 1 internal fn (is_azure_responses_provider); called by 1 (build_responses_request).


##### `Provider::websocket_url_for_path`  (lines 92–103)

```
fn websocket_url_for_path(&self, path: &str) -> Result<Url, url::ParseError>
```

**Purpose**: This creates a WebSocket URL for a provider path. A WebSocket is a long-lived connection used when both sides need to keep talking, like a phone call rather than sending letters one by one.

**Data flow**: It first builds the normal full URL with `Provider::url_for_path`, then parses it into a URL object. If the URL starts with `http`, it changes that to `ws`; if it starts with `https`, it changes that to `wss`, the encrypted WebSocket form. If the URL is already `ws` or `wss`, it leaves it alone. It returns either the converted URL or a parse error if the URL text is invalid.

**Call relations**: This is used by `connect` and `probe_handshake` when the system needs to open or test a WebSocket connection. It relies on `Provider::url_for_path` so WebSocket connections use the same base URL and query parameters as normal requests.

*Call graph*: calls 1 internal fn (url_for_path); called by 2 (connect, probe_handshake); 1 external calls (parse).


##### `is_azure_responses_provider`  (lines 106–114)

```
fn is_azure_responses_provider(name: &str, base_url: Option<&str>) -> bool
```

**Purpose**: This checks whether a provider should be considered Azure for Responses API behavior. It accepts both an explicit provider name and an optional base URL so it can detect Azure in either place.

**Data flow**: It receives a provider name and maybe a base URL. If the name is `azure`, ignoring letter case, it immediately returns `true`. Otherwise, if a base URL exists, it asks `matches_azure_responses_base_url` whether that URL contains known Azure patterns. If neither check matches, it returns `false`.

**Call relations**: This is the shared Azure decision helper used by `Provider::is_azure_responses_endpoint`. It delegates the URL-pattern details to `matches_azure_responses_base_url` so the top-level check stays easy to read.

*Call graph*: calls 1 internal fn (matches_azure_responses_base_url); called by 1 (is_azure_responses_endpoint).


##### `matches_azure_responses_base_url`  (lines 116–127)

```
fn matches_azure_responses_base_url(base_url: &str) -> bool
```

**Purpose**: This looks for known Azure URL markers inside a provider base URL. It helps catch Azure deployments even when the provider was not explicitly named `azure`.

**Data flow**: It receives a base URL string, lowercases it so the check is not affected by capitalization, and searches for several known Azure-related text fragments. It returns `true` if any marker appears in the URL, otherwise `false`.

**Call relations**: This is called by `is_azure_responses_provider` only after the provider name did not already prove it is Azure. It is the detailed pattern-matching step behind the broader Azure detection flow.

*Call graph*: called by 1 (is_azure_responses_provider).


##### `tests::detects_azure_responses_base_urls`  (lines 134–168)

```
fn detects_azure_responses_base_urls()
```

**Purpose**: This test checks that Azure endpoint detection recognizes expected Azure URLs and does not falsely label ordinary or unrelated URLs as Azure. It protects the special Azure request path from being chosen too often or not often enough.

**Data flow**: It feeds several known Azure-looking URLs into `is_azure_responses_provider` and asserts that they return `true`. It also checks that the provider name `Azure` is enough by itself. Then it feeds non-Azure examples and asserts that they return `false`. The output is a passing or failing test result.

**Call relations**: This test exercises the public Azure detection helper from the outside, the same way production code reaches it through `Provider::is_azure_responses_endpoint`. If future edits change the marker list or detection rules, this test shows whether the expected behavior was preserved.

*Call graph*: 1 external calls (assert!).


### `codex-api/src/endpoint/session.rs`

`io_transport` · `request handling`

EndpointSession is the shared “messenger” for this API layer. Higher-level endpoint code knows what it wants to do, such as list models or start a stream, but this file knows how to turn that intent into an authenticated HTTP request and send it through the configured transport.

The session holds four main pieces: a transport, which is the object that actually sends HTTP requests; a provider, which knows the base API shape and retry rules; an auth provider, which adds credentials; and optional request telemetry, which records information about attempts and timing. In everyday terms, the provider writes the envelope, the auth provider adds the stamp, the transport delivers it, and telemetry keeps the delivery receipt.

For regular JSON requests, callers use execute or execute_with. These build a request, optionally let the caller tweak it, apply authentication, then send it with retry and telemetry support. For streaming responses, stream_encoded_json_with does a similar job, but prepares an encoded JSON body and calls the transport’s streaming path instead of the normal request path.

The important behavior is that retries and telemetry wrap the whole send operation. That means a request can be recreated for each attempt, authentication is applied before each send, and callers get a single success or error result instead of having to coordinate all of that themselves.

#### Function details

##### `EndpointSession::new`  (lines 27–34)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a fresh endpoint session from the pieces needed to talk to an API provider: the HTTP transport, provider settings, and authentication source. It starts without request telemetry attached.

**Data flow**: The caller supplies a transport, a provider, and shared authentication. The function stores those inside a new EndpointSession and sets the optional telemetry slot to empty. The result is a ready-to-use session object that endpoint code can keep and use for requests.

**Call relations**: Higher-level constructors call this when they are setting up endpoint-specific clients. It is the starting point before any request is sent; later calls may add telemetry or use the session to execute requests.

*Call graph*: called by 7 (new, new, new, new, new, new, new).


##### `EndpointSession::with_request_telemetry`  (lines 36–42)

```
fn with_request_telemetry(
        mut self,
        request: Option<Arc<dyn RequestTelemetry>>,
    ) -> Self
```

**Purpose**: Attaches optional request telemetry to a session. Telemetry means a reporting hook that can observe request attempts, timing, and retry behavior.

**Data flow**: It takes an existing session and an optional shared telemetry object. It stores that telemetry object in the session and returns the same session back, now configured to report request activity when requests run.

**Call relations**: Builder-style setup code calls this after creating a session, usually through higher-level with_telemetry methods. The telemetry value it stores is later passed into the retry-and-send wrapper used by execute_with and stream_encoded_json_with.

*Call graph*: called by 7 (with_telemetry, with_telemetry, with_telemetry, with_telemetry, with_telemetry, with_telemetry, with_telemetry).


##### `EndpointSession::provider`  (lines 44–46)

```
fn provider(&self) -> &Provider
```

**Purpose**: Gives read-only access to the provider stored in the session. Callers use this when they need to inspect provider details, such as how requests should be shaped for a backend.

**Data flow**: It reads the provider field from the session and returns a reference to it. Nothing is copied or changed; the caller simply gets a safe view of the provider configuration.

**Call relations**: Code that checks backend request shape or prepares streaming requests calls this to ask what provider the session is using. It does not send anything itself; it supports decisions made before request execution.

*Call graph*: called by 3 (uses_backend_request_shape, stream_encoded, stream_request).


##### `EndpointSession::make_request`  (lines 48–61)

```
fn make_request(
        &self,
        method: &Method,
        path: &str,
        extra_headers: &HeaderMap,
        body: Option<&RequestBody>,
    ) -> Request
```

**Purpose**: Builds the common Request object used by the sending functions. It combines the provider’s base request, any extra headers, and an optional body into one complete request package.

**Data flow**: It receives an HTTP method, a path, extra headers, and maybe a request body. It asks the provider to build the base request for that method and path, copies in the extra headers, copies in the body if one was supplied, and returns the completed Request.

**Call relations**: The streaming request path calls this before preparing and sending the stream. It relies on the provider’s build_request behavior so all endpoint requests start from the same provider-specific rules.

*Call graph*: calls 1 internal fn (build_request); called by 1 (stream_encoded_json_with); 2 external calls (clone, clone).


##### `EndpointSession::execute`  (lines 63–72)

```
async fn execute(
        &self,
        method: Method,
        path: &str,
        extra_headers: HeaderMap,
        body: Option<Value>,
    ) -> Result<Response, ApiError>
```

**Purpose**: Sends a normal, non-streaming API request with an optional JSON body. It is the simple version for callers that do not need to customize the raw request.

**Data flow**: The caller gives an HTTP method, API path, headers, and optional JSON value. This function forwards those values to execute_with and supplies an empty customization step. The output is either a completed HTTP response or an API error.

**Call relations**: Endpoint operations such as image requests, summarization, and search call this when the default request shape is enough. It immediately hands the real work to execute_with, which performs building, authentication, retries, telemetry, and transport execution.

*Call graph*: calls 1 internal fn (execute_with); called by 3 (post_image_request, summarize, search).


##### `EndpointSession::execute_with`  (lines 80–114)

```
async fn execute_with(
        &self,
        method: Method,
        path: &str,
        extra_headers: HeaderMap,
        body: Option<Value>,
        configure: C,
    ) -> Result<Response, ApiErro
```

**Purpose**: Sends a normal API request while allowing the caller to make last-minute changes to the Request before it goes out. This is used when an endpoint needs custom request details beyond method, path, headers, and JSON body.

**Data flow**: It receives request details plus a configure function. It turns the optional JSON value into the internal request-body form, creates a fresh request when needed, lets the configure function edit it, then runs the request through retry and telemetry logic. For each send attempt, authentication is applied first, then the transport executes the request. The final output is a successful response or an API error.

**Call relations**: More specialized endpoint actions, including compacting, listing models, and creating requests with custom headers or session architecture details, call this when they need control over the outgoing request. The simpler execute function also delegates to it. It hands request attempts to run_with_request_telemetry so retry policy and measurement are applied around the transport call.

*Call graph*: calls 1 internal fn (run_with_request_telemetry); called by 5 (compact, list_models, create_with_headers, create_with_session_architecture_and_headers, execute).


##### `EndpointSession::stream_encoded_json_with`  (lines 122–155)

```
async fn stream_encoded_json_with(
        &self,
        method: Method,
        path: &str,
        extra_headers: HeaderMap,
        body: Option<EncodedJsonBody>,
        configure: C,
    ) -> Re
```

**Purpose**: Starts a streaming API request using an already encoded JSON body. A streaming request is one where the response arrives over time, rather than as one complete response.

**Data flow**: The caller supplies the method, path, headers, optional encoded JSON body, and a configure function. The function builds the request, lets the caller adjust it, prepares it into a send-ready form, and then runs it through the same retry and telemetry wrapper used for normal requests. Before each stream attempt, authentication is applied, and then the transport opens the stream. The result is either a StreamResponse or an API error.

**Call relations**: Streaming endpoint code calls this when it needs a response that can be read piece by piece. It uses make_request to assemble the request and run_with_request_telemetry to wrap the streaming transport call with retry and reporting behavior.

*Call graph*: calls 2 internal fn (make_request, run_with_request_telemetry); called by 1 (stream_encoded).


### `codex-api/src/endpoint/mod.rs`

`other` · `cross-cutting API organization`

This file does not contain the logic for talking to the API itself. Instead, it acts like a directory desk in a large building: it points to the rooms where the real work happens, and it makes the most important tools easy to find.

Each `mod` line tells Rust that there is another source file or folder containing code for a specific API area. For example, image-related API calls live under `images`, model listing under `models`, and realtime websocket communication under `realtime_websocket`. The `session` module is kept private to this endpoint area, meaning it is used internally but not offered directly to the rest of the crate.

The `pub use` lines re-export selected types from those modules. In plain terms, that means outside code can import `ResponsesClient` or `ImagesClient` from this endpoint layer without needing to know the exact submodule where each one is defined. This keeps the rest of the project cleaner and protects it from unnecessary file-layout details.

Without this file, callers would need to know and import every endpoint client from its individual module. Adding, renaming, or reorganizing endpoint files would be more painful because those internal paths would leak across the codebase.


### `codex-api/src/requests/mod.rs`

`orchestration` · `request handling`

This file is like a small index page for request support code. Instead of every caller needing to know exactly where request headers, response helpers, and compression choices live, this module gathers those pieces under one shared place.

It declares two child modules: one for HTTP-style headers and one for response-related helpers. A module is Rust’s way of grouping related code, much like putting papers into labeled folders. This file also re-exports selected items from the response module, which means other code can import them from this higher-level request module instead of reaching into the deeper folder. In particular, it makes the `Compression` choice available outside the response module, and it shares `attach_item_ids` within the crate for internal use.

Without this file, the request code would still exist in separate files, but it would be harder and messier for the rest of the project to find and use it. This file keeps the public shape of the request area tidy: it says, “these are the request-related building blocks, and these are the ones you should reach for from elsewhere.”


### Streaming and upload helpers
These files cover specialized API-side transport helpers for SSE exposure, realtime websocket event parsing, and file upload workflows.

### `codex-api/src/sse/mod.rs`

`io_transport` · `request handling`

This file does not contain its own logic. Instead, it organizes and re-exports the real server-sent events code from the `responses` module. Server-sent events, often shortened to SSE, are a simple way for a server to keep sending updates to a client over one long-lived web connection, like a live news ticker instead of separate page refreshes.

The file makes three response-streaming pieces available to the rest of the crate: a type representing response stream events, a function that processes incoming response events, and a function that starts or "spawns" the response stream. This matters because other parts of the API should not need to know the exact internal file layout. They can import streaming tools from this `sse` module and let it hide where the implementation lives.

Without this file, callers would have to reach directly into the `responses` submodule, making the code more tightly tied to the folder structure. This small module acts like a reception desk: it does not do the work itself, but it points the rest of the system to the right streaming tools.


### `codex-api/src/endpoint/realtime_websocket/protocol_common.rs`

`io_transport` · `realtime WebSocket message handling`

Realtime WebSocket messages arrive as plain text, usually shaped like JSON, which is a common format for sending structured data. This file checks that those messages are understandable and pulls out the few fields the rest of the system needs. Think of it like a mailroom clerk: it opens an envelope, checks the label, and sorts the contents into the right internal form.

The first step is parsing the text payload into a JSON value and finding its "type" field. Without that, the rest of the realtime code would not know what kind of event it received. If the payload is broken or missing a type, the helper logs a debug message and returns nothing instead of crashing.

The other helpers read specific event shapes: session updates, transcript text as it streams in, finished transcript text, and errors. Each one is deliberately tolerant: if a required field is missing or not a string, it returns nothing. That lets the higher-level protocol parsers decide what to do next. The file matters because it keeps the two realtime protocol versions consistent, avoids duplicated parsing code, and protects the rest of the system from malformed incoming messages.

#### Function details

##### `parse_realtime_payload`  (lines 7–25)

```
fn parse_realtime_payload(payload: &str, parser_name: &str) -> Option<(Value, String)>
```

**Purpose**: This function does the first basic check on an incoming realtime message. It turns raw text into JSON and extracts the message’s "type", which tells later code how to interpret the event.

**Data flow**: It receives a text payload and a parser name used only for clearer debug messages. It tries to parse the text as JSON, then looks for a string field named "type". If both steps work, it returns the parsed JSON together with the type string; if not, it logs what went wrong and returns no result.

**Call relations**: Both parse_realtime_event_v1 and parse_realtime_event_v2 call this at the start of their work. After this helper identifies the event type, those version-specific parsers can choose the right more specialized helper for the event body.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 2 external calls (debug!, from_str).


##### `parse_session_updated_event`  (lines 27–44)

```
fn parse_session_updated_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: This function reads a session update message and turns it into an internal realtime event. It extracts the realtime session ID and, if present, the session instructions.

**Data flow**: It receives an already-parsed JSON value. It looks inside the "session" object for an "id" string, which is required, and an "instructions" string, which is optional. If the session ID is present, it returns a SessionUpdated event; if not, it returns no result.

**Call relations**: The protocol version parsers, parse_realtime_event_v1 and parse_realtime_event_v2, call this when the incoming event type means the session has been updated. This helper supplies the common conversion so both protocol versions produce the same internal event shape.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


##### `parse_transcript_delta_event`  (lines 46–55)

```
fn parse_transcript_delta_event(
    parsed: &Value,
    field: &str,
) -> Option<RealtimeTranscriptDelta>
```

**Purpose**: This function reads a small piece of transcript text from a streaming message. A “delta” means only the newest added text, not the full transcript so far.

**Data flow**: It receives parsed JSON and the name of the field where the text is expected. It looks up that field, checks that it is a string, and wraps the string in a RealtimeTranscriptDelta value. If the field is missing or not text, it returns no result.

**Call relations**: parse_realtime_event_v1 and parse_realtime_event_v2 call this when they recognize an event that carries partial transcript text. They provide the field name because different event shapes may store the text under different keys.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


##### `parse_transcript_done_event`  (lines 57–66)

```
fn parse_transcript_done_event(
    parsed: &Value,
    field: &str,
) -> Option<RealtimeTranscriptDone>
```

**Purpose**: This function reads the final completed transcript text from an event. It is used when the stream is no longer just sending small additions, but has the finished text available.

**Data flow**: It receives parsed JSON and the expected text field name. It pulls that field out as a string and wraps it in a RealtimeTranscriptDone value. If it cannot find usable text, it returns no result.

**Call relations**: The two protocol parsers, parse_realtime_event_v1 and parse_realtime_event_v2, call this when an event signals that transcript text is complete. This keeps the final-transcript extraction logic shared between protocol versions.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


##### `parse_error_event`  (lines 68–83)

```
fn parse_error_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: This function turns an error-shaped JSON message into the project’s internal realtime error event. It accepts a few common error formats so the rest of the code can receive one consistent error type.

**Data flow**: It receives parsed JSON. It first looks for a top-level "message" string, then for an "error" object with its own "message" string, and finally falls back to converting the whole "error" value to text. If it finds any of these, it returns a RealtimeEvent::Error containing the message; otherwise it returns no result.

**Call relations**: parse_realtime_event_v1 and parse_realtime_event_v2 call this when they detect an error event. This helper absorbs differences in how errors are written in the incoming JSON and hands back one simple internal event.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


### `codex-api/src/files.rs`

`io_transport` · `file upload request handling`

This file is the project’s bridge between Codex and OpenAI’s file-upload service. When Codex needs to attach or send a file, it cannot simply invent a link. It must ask OpenAI for an upload slot, stream the bytes to that slot, then tell OpenAI the upload is complete and wait until OpenAI can provide a usable download link. Without this file, larger file attachments would have no safe, consistent path into the OpenAI backend.

The upload works like checking luggage at an airport. First, Codex checks that the file is not too large. Then it asks the backend for a luggage tag: a file ID and a temporary upload URL. Next, it sends the actual file bytes to that temporary URL. Finally, it goes back to the backend and says, “the upload is done.” The backend may answer “not ready yet,” so this file retries briefly before giving up.

The file also builds authenticated HTTP requests, meaning requests that include login/account headers supplied by an `AuthProvider`. It uses a custom certificate-aware HTTP client when possible, and falls back to a normal client if that setup fails. The tests set up a fake server and prove that the upload flow returns the expected canonical URI, such as `sediment://file_123`.

#### Function details

##### `openai_file_uri`  (lines 80–82)

```
fn openai_file_uri(file_id: &str) -> String
```

**Purpose**: Creates the project’s standard URI for an uploaded OpenAI file. This turns a raw file ID into a stable reference string that other parts of the system can store or send around.

**Data flow**: It receives a file ID such as `file_123` → adds the fixed `sediment://` prefix → returns a string such as `sediment://file_123`. It does not change any outside state.

**Call relations**: After `upload_openai_file` finishes the upload and receives a file ID from OpenAI, it calls this helper to produce the canonical URI included in the returned `UploadedOpenAiFile` record.

*Call graph*: called by 1 (upload_openai_file); 1 external calls (format!).


##### `upload_openai_file`  (lines 84–213)

```
async fn upload_openai_file(
    base_url: &str,
    auth: &dyn AuthProvider,
    file_name: String,
    file_size_bytes: u64,
    contents: impl Stream<Item = std::io::Result<Bytes>> + Send + 'static
```

**Purpose**: Uploads a file stream to OpenAI’s file service from start to finish. It checks the size, asks for an upload URL, sends the file bytes, waits for OpenAI to finalize the upload, and returns the file’s ID, URI, download URL, name, size, and optional MIME type.

**Data flow**: It receives a backend base URL, an authentication provider, the file name, the file size, and a stream of file bytes → rejects the upload immediately if the file is over the 512 MB limit → sends an authenticated create-file request to get a file ID and temporary upload URL → streams the bytes to that upload URL → repeatedly tells the backend the upload is complete until it succeeds, fails, or times out → returns an `UploadedOpenAiFile` on success, or an `OpenAiFileError` explaining what went wrong.

**Call relations**: This is the main workflow in the file. It calls `authorized_request` when talking to the OpenAI backend because those requests need account/authentication headers. It calls `build_reqwest_client` directly for the raw byte upload to the temporary storage URL. Once finalization succeeds, it calls `openai_file_uri` to create the stable `sediment://...` reference. The test `tests::upload_openai_file_returns_canonical_uri` drives this function through the full happy path, including a retry during finalization.

*Call graph*: calls 3 internal fn (authorized_request, build_reqwest_client, openai_file_uri); called by 1 (upload_openai_file_returns_canonical_uri); 6 external calls (now, wrap_stream, format!, from_str, json!, sleep).


##### `authorized_request`  (lines 215–228)

```
fn authorized_request(
    auth: &dyn AuthProvider,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder
```

**Purpose**: Builds an HTTP request that already contains the required authentication headers and timeout. This keeps the upload workflow from repeating the same setup for every backend call.

**Data flow**: It receives an authentication provider, an HTTP method such as POST, and a URL → asks the authentication provider to add headers like authorization/account information → creates an HTTP client → returns a request builder ready for the caller to add a JSON body and send.

**Call relations**: `upload_openai_file` uses this helper for the create-file request and the finalization request, because both go to the authenticated backend API. This helper in turn uses `build_reqwest_client` so those requests share the same client-building behavior.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (upload_openai_file); 2 external calls (add_auth_headers, new).


##### `build_reqwest_client`  (lines 230–235)

```
fn build_reqwest_client() -> reqwest::Client
```

**Purpose**: Creates the HTTP client used for file upload requests. It tries to include the project’s custom certificate authority support, which lets the client trust additional configured certificates.

**Data flow**: It starts with a standard `reqwest` HTTP client builder → passes it through the project’s custom-certificate setup → returns the configured client if that succeeds. If custom setup fails, it logs a warning and returns a plain default HTTP client instead.

**Call relations**: `authorized_request` calls this for authenticated backend requests, and `upload_openai_file` calls it directly for the raw PUT upload to the temporary storage URL. This means all network calls in the file go through the same client creation path.

*Call graph*: called by 2 (authorized_request, upload_openai_file); 2 external calls (builder, build_reqwest_client_with_custom_ca).


##### `tests::ChatGptTestAuth::add_auth_headers`  (lines 258–264)

```
fn add_auth_headers(&self, headers: &mut reqwest::header::HeaderMap)
```

**Purpose**: Provides fake authentication headers for the upload test. It stands in for the real authentication provider so the test server can verify that authenticated requests include the expected account information.

**Data flow**: It receives a mutable set of HTTP headers → inserts a fixed bearer token and a fixed ChatGPT account ID → leaves the headers ready to be attached to a request. It returns nothing directly.

**Call relations**: The helper `tests::chatgpt_auth` returns this test authentication provider. During the test, `upload_openai_file` passes it into `authorized_request`, which calls this method before sending backend requests to the fake server.

*Call graph*: 2 external calls (insert, from_static).


##### `tests::chatgpt_auth`  (lines 267–269)

```
fn chatgpt_auth() -> ChatGptTestAuth
```

**Purpose**: Creates the small fake authentication provider used by the test. This keeps the test setup readable and avoids repeating the test-auth type directly.

**Data flow**: It takes no input → returns a `ChatGptTestAuth` value → that value can add predictable authentication headers during the test.

**Call relations**: `tests::upload_openai_file_returns_canonical_uri` calls this helper when it invokes `upload_openai_file`, giving the upload flow a known source of authentication headers.


##### `tests::base_url_for`  (lines 271–273)

```
fn base_url_for(server: &MockServer) -> String
```

**Purpose**: Builds the fake backend base URL used in the test. It points the upload code at the mock server instead of the real OpenAI backend.

**Data flow**: It receives a mock server → reads the server’s generated local URL → appends `/backend-api` → returns that full base URL string.

**Call relations**: `tests::upload_openai_file_returns_canonical_uri` calls this after starting the mock server, then passes the result into `upload_openai_file` so every backend request goes to the test server.

*Call graph*: 1 external calls (format!).


##### `tests::upload_openai_file_returns_canonical_uri`  (lines 276–343)

```
async fn upload_openai_file_returns_canonical_uri()
```

**Purpose**: Tests the complete successful upload path, including finalization retry and canonical URI creation. It proves that the code sends the expected requests and returns the expected uploaded-file information.

**Data flow**: It starts a fake HTTP server → configures expected responses for creating a file, uploading bytes, and finalizing the upload → creates a small `hello` byte stream → calls `upload_openai_file` → checks that the returned file ID, `sediment://` URI, download URL, file name, MIME type, and retry count match expectations.

**Call relations**: This test is the caller that exercises the public upload workflow. It uses `tests::base_url_for` to aim requests at the fake server and `tests::chatgpt_auth` to supply predictable authentication. The upload flow then calls through to `authorized_request`, `build_reqwest_client`, and `openai_file_uri` as it would in real use.

*Call graph*: calls 1 internal fn (upload_openai_file); 17 external calls (clone, new, new, from_static, given, start, new, assert_eq!, base_url_for, chatgpt_auth (+7 more)).
