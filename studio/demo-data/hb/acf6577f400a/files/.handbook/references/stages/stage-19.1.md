# Generic HTTP client, TLS, cookies, and streaming transport foundations  `stage-19.1`

This stage is the outbound networking foundation that sits beneath higher-level backend, auth, and API clients. It standardizes how the system builds requests, opens TLS connections, retries failures, streams responses, and exposes those capabilities as reusable client surfaces.

At its core, codex-client defines the transport-neutral Request/Response model, one-shot body preparation and compression, retry/backoff policy, the reqwest-based transport, SSE decoding, custom CA loading, a restricted Cloudflare-only cookie jar, and a public facade tying those pieces together. Its default client wrappers add trace propagation and structured request logging. Login code reuses that infrastructure to construct the shared authenticated HTTP client configuration.

Built on top of those primitives, backend-client, chatgpt, cloud-tasks-client, thread-config remote loading, LM Studio integration, and file upload support each implement concrete protocol clients for specific services. The codex-api crate then organizes provider configuration, authenticated endpoint sessions, request builders, SSE exports, and shared realtime parsing helpers into the main backend-facing API layer. Together, these parts ensure all outbound HTTP traffic follows consistent security, observability, retry, and streaming behavior.

## Files in this stage

### Transport primitives
These files define the shared request model, retry behavior, concrete reqwest transport, SSE decoding, and the crate facade that exposes them.

### `codex-client/src/request.rs`

`data_model` · `request assembly, auth signing, retry preparation, and transport handoff`

This file is the core request representation used before handing work to a concrete HTTP transport. `Request` stores the HTTP `Method`, URL string, mutable `HeaderMap`, optional `RequestBody`, requested `RequestCompression`, and optional timeout. `RequestBody` distinguishes three cases: structured `Json(Value)`, already serialized `EncodedJson(EncodedJsonBody)`, and arbitrary `Raw(Bytes)`. `EncodedJsonBody` is optimized for retries and tracing: it keeps reference-counted `Bytes`, optionally preserves pre-compression bytes for trace logging, and marks whether the stored bytes are already in final wire form.

The central logic is `prepare_body_for_send`, which clones headers and converts the body into exact outbound bytes without mutating the request. Raw bodies are passed through unchanged but explicitly reject compression. JSON bodies are serialized once via `EncodedJsonBody::encode`, then delegated to `prepare_encoded_json`, which optionally compresses with zstd level 3, inserts `Content-Encoding: zstd`, logs compression statistics, and ensures `Content-Type: application/json` is present unless already set. `into_prepared` is the mutating counterpart: it computes optional trace bytes when trace logging is enabled, calls `prepare_body_for_send`, writes the prepared headers back into the request, replaces the body with reusable final bytes, and resets `compression` to `None` so later sends do not recompress. The tests focus on preserving immutability in `prepare_body_for_send`, rejecting conflicting `Content-Encoding`, and caching compressed bytes for reuse.

#### Function details

##### `EncodedJsonBody::encode`  (lines 23–29)

```
fn encode(value: &T) -> Result<Self, serde_json::Error>
```

**Purpose**: Serializes a Rust value into shared JSON bytes that can be reused across clones and retries.

**Data flow**: Accepts `&T` where `T: Serialize`, runs `serde_json::to_vec`, wraps the resulting `Vec<u8>` in `Bytes`, sets `trace_bytes` to `None` and `prepared` to `false`, and returns `Result<EncodedJsonBody, serde_json::Error>`.

**Call relations**: This is the canonical JSON encoding path used by request preparation and some streaming/request-building code. Callers use it when they want a body that can later be compressed or reused without reserializing.

*Call graph*: called by 4 (stream, stream_request, prepare_body_for_send, into_prepared_stores_compressed_body_for_reuse); 1 external calls (to_vec).


##### `EncodedJsonBody::as_bytes`  (lines 32–34)

```
fn as_bytes(&self) -> &[u8]
```

**Purpose**: Exposes the currently stored body bytes, whether they are original JSON or already prepared wire bytes.

**Data flow**: Reads `self.bytes` and returns it as `&[u8]` without allocation or mutation.

**Call relations**: Used by `Request::prepare_encoded_json` when feeding bytes into zstd compression.

*Call graph*: called by 1 (prepare_encoded_json).


##### `EncodedJsonBody::trace_bytes`  (lines 36–38)

```
fn trace_bytes(&self) -> &[u8]
```

**Purpose**: Returns the bytes that should be shown in trace logs, preferring preserved pre-compression JSON when available.

**Data flow**: Reads `self.trace_bytes`; if present returns that slice, otherwise falls back to `self.bytes`. It does not mutate state.

**Call relations**: This supports transport-layer trace logging for prepared compressed requests so logs can still show readable JSON rather than compressed wire bytes.


##### `RequestBody::json`  (lines 56–61)

```
fn json(&self) -> Option<&Value>
```

**Purpose**: Provides access to the structured JSON value only when the body is still stored as `RequestBody::Json`.

**Data flow**: Matches on `self`; returns `Some(&Value)` for `Json`, and `None` for `EncodedJson` or `Raw`.

**Call relations**: This is a small inspection helper for code that wants to look at unencoded JSON bodies without decoding bytes.


##### `PreparedRequestBody::body_bytes`  (lines 71–73)

```
fn body_bytes(&self) -> Bytes
```

**Purpose**: Returns the prepared body bytes, defaulting to empty bytes when the request has no body.

**Data flow**: Clones `self.body` if present; otherwise returns `Bytes::default()`. No mutation occurs.

**Call relations**: Useful to downstream code that wants a concrete byte buffer regardless of whether the request body was optional.


##### `Request::new`  (lines 87–96)

```
fn new(method: Method, url: String) -> Self
```

**Purpose**: Creates a new request with empty headers, no body, no compression, and no timeout.

**Data flow**: Takes an HTTP `Method` and URL `String`, initializes `headers` with `HeaderMap::new()`, sets `body` to `None`, `compression` to `RequestCompression::None`, and `timeout` to `None`, then returns the `Request`.

**Call relations**: This is the standard constructor used by production code and tests before chaining body/compression setters.

*Call graph*: called by 6 (into_prepared_stores_compressed_body_for_reuse, prepare_body_for_send_rejects_existing_content_encoding_when_compressing, prepare_body_for_send_serializes_json_and_sets_content_type, load_thread_config_request, direct_connector_allows_non_public_target_when_local_binding_enabled, direct_connector_rejects_non_public_target_when_local_binding_disabled); 1 external calls (new).


##### `Request::with_json`  (lines 98–101)

```
fn with_json(mut self, body: &T) -> Self
```

**Purpose**: Stores a serializable value as a structured JSON `Value` inside the request.

**Data flow**: Consumes `self` mutably, converts `&T` with `serde_json::to_value`, maps successful conversion to `RequestBody::Json`, assigns it to `self.body`, and returns the updated request. Serialization failure is silently converted to `None` body via `.ok()`.

**Call relations**: This is a convenience builder for callers constructing JSON requests. Actual byte encoding is deferred until preparation.

*Call graph*: 1 external calls (to_value).


##### `Request::with_raw_body`  (lines 103–106)

```
fn with_raw_body(mut self, body: impl Into<Bytes>) -> Self
```

**Purpose**: Stores arbitrary bytes as an opaque raw request body.

**Data flow**: Consumes `self` mutably, converts the input into `Bytes`, wraps it in `RequestBody::Raw`, assigns it to `self.body`, and returns the updated request.

**Call relations**: Used when the caller already has exact bytes and does not want JSON serialization. Later preparation enforces that such bodies cannot also request compression.

*Call graph*: 2 external calls (into, Raw).


##### `Request::with_compression`  (lines 108–111)

```
fn with_compression(mut self, compression: RequestCompression) -> Self
```

**Purpose**: Marks the request to apply a specific compression scheme during body preparation.

**Data flow**: Consumes `self` mutably, writes the provided `RequestCompression` into `self.compression`, and returns the updated request.

**Call relations**: This only records intent; the actual compression work happens later in `prepare_body_for_send` / `prepare_encoded_json`.


##### `Request::into_prepared`  (lines 118–149)

```
fn into_prepared(mut self) -> Result<Self, String>
```

**Purpose**: Mutates the request into a reusable, fully prepared form whose body bytes and headers exactly match what the transport will send.

**Data flow**: Consumes `self` mutably, first determines whether the body is JSON-like, then conditionally captures pre-compression `trace_bytes` when compression is requested and trace logging for `codex_client::transport` is enabled. It calls `prepare_body_for_send`, replaces `self.headers` with the prepared headers, rewrites `self.body` to either `RequestBody::EncodedJson` with `prepared: true`, `RequestBody::Raw`, or `None`, resets `self.compression` to `None`, and returns `Result<Self, String>`.

**Call relations**: This is the caching path for retries and signing-sensitive flows that need stable final bytes. It delegates the actual preparation rules to `prepare_body_for_send` and then stores the result back into the request.

*Call graph*: calls 1 internal fn (prepare_body_for_send); 6 external calls (from, EncodedJson, Raw, matches!, to_vec, enabled!).


##### `Request::prepare_body_for_send`  (lines 156–178)

```
fn prepare_body_for_send(&self) -> Result<PreparedRequestBody, String>
```

**Purpose**: Computes the exact outbound headers and body bytes for the current request without mutating it.

**Data flow**: Clones `self.headers`, inspects `self.body`, and returns a `PreparedRequestBody`. Raw bodies are cloned directly unless compression was requested, in which case it returns an error string. JSON values are encoded with `EncodedJsonBody::encode` and then passed to `prepare_encoded_json`; already encoded JSON bodies are passed straight through; absent bodies yield `body: None` with cloned headers.

**Call relations**: This is the main non-mutating preparation API used by transport building and auth/signing code. It funnels all JSON-specific work into `prepare_encoded_json`.

*Call graph*: calls 2 internal fn (encode, prepare_encoded_json); called by 3 (into_prepared, build, apply_auth); 1 external calls (clone).


##### `Request::prepare_encoded_json`  (lines 180–238)

```
fn prepare_encoded_json(
        &self,
        mut headers: HeaderMap,
        body: &EncodedJsonBody,
    ) -> Result<PreparedRequestBody, String>
```

**Purpose**: Finalizes an encoded JSON body by optionally compressing it, setting content headers, and returning the exact bytes to send.

**Data flow**: Takes cloned/mutable headers and an `EncodedJsonBody`. If `body.prepared` is already true, it returns the stored bytes unchanged. Otherwise, when compression is requested it first rejects any preexisting `Content-Encoding`, measures compression time, compresses `body.as_bytes()` with zstd level 3, inserts `Content-Encoding: zstd`, and logs pre/post sizes and duration. Whether compressed or not, it ensures `Content-Type: application/json` exists, then returns `PreparedRequestBody { headers, body: Some(bytes) }`.

**Call relations**: Only `prepare_body_for_send` calls this helper. It encapsulates the invariants around JSON compression, header insertion, and reuse of already prepared bodies.

*Call graph*: calls 2 internal fn (as_bytes, new); called by 1 (prepare_body_for_send); 8 external calls (from, contains_key, insert, from_static, now, debug!, unreachable!, encode_all).


##### `tests::prepare_body_for_send_serializes_json_and_sets_content_type`  (lines 249–273)

```
fn prepare_body_for_send_serializes_json_and_sets_content_type()
```

**Purpose**: Checks that preparing a JSON request serializes the body, adds `application/json`, and leaves the original request unchanged.

**Data flow**: Builds a POST `Request` with JSON, calls `prepare_body_for_send`, and asserts the prepared bytes, prepared `Content-Type`, original `request.body`, and original `request.compression` all match expected values.

**Call relations**: This test guards the non-mutating contract of `prepare_body_for_send` and the default content-type behavior for JSON.

*Call graph*: calls 1 internal fn (new); 2 external calls (assert_eq!, json!).


##### `tests::prepare_body_for_send_rejects_existing_content_encoding_when_compressing`  (lines 276–294)

```
fn prepare_body_for_send_rejects_existing_content_encoding_when_compressing()
```

**Purpose**: Verifies that compression fails if the caller already set a `Content-Encoding` header.

**Data flow**: Builds a JSON POST request, enables zstd compression, manually inserts `Content-Encoding: gzip`, calls `prepare_body_for_send`, captures the error string, and asserts it matches the expected conflict message.

**Call relations**: This test exercises the explicit header-conflict guard inside `prepare_encoded_json`.

*Call graph*: calls 1 internal fn (new); 3 external calls (from_static, assert_eq!, json!).


##### `tests::into_prepared_stores_compressed_body_for_reuse`  (lines 297–321)

```
fn into_prepared_stores_compressed_body_for_reuse()
```

**Purpose**: Confirms that `into_prepared` stores compressed bytes in the request body and clears the compression flag so later sends reuse the prepared payload.

**Data flow**: Creates an `EncodedJsonBody`, inserts it into a request with zstd compression, calls `into_prepared`, pattern-matches the resulting body back to `RequestBody::EncodedJson`, decompresses `body.as_bytes()`, and asserts the decompressed JSON plus the request’s headers and `compression` field are correct.

**Call relations**: This test validates the mutating preparation path used for retries and repeated sends.

*Call graph*: calls 3 internal fn (encode, new, new); 5 external calls (assert_eq!, EncodedJson, json!, panic!, decode_all).


### `codex-client/src/retry.rs`

`domain_logic` · `request execution around transient failures`

This file contains the retry control logic for transport failures. `RetryPolicy` bundles three pieces of state: `max_attempts`, a `base_delay`, and a `RetryOn` selector. `RetryOn` is the policy matrix itself, with booleans for retrying HTTP 429 responses, HTTP 5xx responses, and transport-level failures such as timeouts or network errors.

`RetryOn::should_retry` is the classification function. It first enforces the attempt ceiling, then matches on `TransportError`: `TransportError::Http` is retried only when the status matches the enabled categories (`429` or any server error), `Timeout` and `Network(_)` are controlled by `retry_transport`, and all other variants are terminal. `backoff` computes the sleep duration from the base delay using powers of two with saturating arithmetic and a random jitter factor in the range `0.9..1.1`; attempt zero returns the base delay directly. `run_with_retry` ties everything together: for each attempt from `0` through `max_attempts` inclusive, it asks `make_req` for a fresh `Request`, invokes the async operation `op(req, attempt)`, returns immediately on success, sleeps and retries only when `should_retry` says so, and otherwise returns the encountered error. If the loop somehow exhausts without returning, it emits `TransportError::RetryLimit`. The design assumes requests may need rebuilding because bodies, auth, or timestamps can differ per attempt.

#### Function details

##### `RetryOn::should_retry`  (lines 23–35)

```
fn should_retry(&self, err: &TransportError, attempt: u64, max_attempts: u64) -> bool
```

**Purpose**: Decides whether a specific `TransportError` should trigger another attempt under the current retry policy.

**Data flow**: Reads `self`’s three booleans plus the current `attempt` and `max_attempts`. It returns `false` immediately when the attempt limit has been reached; otherwise it matches the error: HTTP errors are checked against status 429 and `is_server_error()`, timeout/network errors consult `retry_transport`, and all other variants return `false`.

**Call relations**: This is the policy gate used inside `run_with_retry` after a failed operation. It determines whether control flows into backoff-and-sleep or exits with the error.


##### `backoff`  (lines 38–47)

```
fn backoff(base: Duration, attempt: u64) -> Duration
```

**Purpose**: Computes an exponential retry delay from a base duration, with saturating growth and small random jitter.

**Data flow**: Takes `base: Duration` and `attempt: u64`. For attempt 0 it returns `base`; otherwise it computes `2^(attempt-1)` with `saturating_pow`, multiplies the base milliseconds with saturation, samples a jitter factor from `rand::rng().random_range(0.9..1.1)`, and returns `Duration::from_millis` of the jittered result.

**Call relations**: Only `run_with_retry` calls this helper, immediately before sleeping between retry attempts.

*Call graph*: called by 1 (run_with_retry); 3 external calls (as_millis, from_millis, rng).


##### `run_with_retry`  (lines 49–73)

```
async fn run_with_retry(
    policy: RetryPolicy,
    mut make_req: impl FnMut() -> Request,
    op: F,
) -> Result<T, TransportError>
```

**Purpose**: Executes an async request operation repeatedly under a retry policy, rebuilding the request each time and sleeping between retryable failures.

**Data flow**: Consumes a `RetryPolicy`, a mutable request factory `make_req`, and an async operation `op`. For each attempt index it calls `make_req()` to obtain a fresh `Request`, awaits `op(req, attempt)`, returns `Ok(T)` on success, or on retryable `Err(TransportError)` sleeps for `backoff(policy.base_delay, attempt + 1)` before continuing. Non-retryable errors are returned immediately; if the loop exits unexpectedly it returns `TransportError::RetryLimit`.

**Call relations**: This is the orchestration function for retry behavior. It delegates classification to `RetryOn::should_retry`, delay calculation to `backoff`, and actual waiting to `tokio::time::sleep`.

*Call graph*: calls 1 internal fn (backoff); 1 external calls (sleep).


### `codex-client/src/transport.rs`

`io_transport` · `outbound HTTP execution and response decoding`

This file defines the transport boundary for the client. `HttpTransport` is the trait exposing two async operations: `execute` for fully buffered responses and `stream` for byte-streaming responses. `ReqwestTransport` is the concrete implementation, holding a `CodexHttpClient` so all outbound requests inherit trace-header injection and request logging from `default_client.rs`.

The private `build` method is the key adapter from the transport-neutral `Request` model to a `CodexRequestBuilder`. It first calls `Request::prepare_body_for_send`, so auth/signing and transport both see the exact same final headers and bytes. It then destructures the original request, reconstructs an `http::Method` from `method.as_str().as_bytes()` with a conservative fallback to `GET`, applies any per-request timeout, installs the prepared headers, and attaches the prepared body bytes if present. `map_error` collapses reqwest errors into `TransportError::Timeout` or `TransportError::Network(String)`. For trace-level logging, `request_body_for_trace` renders JSON bodies as text, encoded JSON via preserved `trace_bytes`, raw bodies as a byte-count placeholder, and absent bodies as empty string.

`execute` and `stream` share the same flow: optionally emit a trace log, clone the URL for error reporting, build and send the request, inspect status, and convert non-success responses into `TransportError::Http` carrying status, URL, headers, and optional body text. `execute` buffers the full body into `Bytes`; `stream` instead exposes `resp.bytes_stream()` as a boxed stream of `Bytes` chunks with transport errors mapped lazily.

#### Function details

##### `ReqwestTransport::new`  (lines 42–46)

```
fn new(client: reqwest::Client) -> Self
```

**Purpose**: Constructs the reqwest-backed transport from an already configured `reqwest::Client`.

**Data flow**: Takes a `reqwest::Client`, wraps it with `CodexHttpClient::new`, stores that in `ReqwestTransport { client }`, and returns the transport.

**Call relations**: This is the standard constructor used by many higher-level clients and tests before issuing requests through the `HttpTransport` trait.

*Call graph*: calls 1 internal fn (new); called by 8 (models_client_hits_models_endpoint, compact_conversation_history, create_realtime_call_with_headers, summarize_memories, stream_responses_api, client, handle_call, list_models).


##### `ReqwestTransport::build`  (lines 48–74)

```
fn build(&self, req: Request) -> Result<CodexRequestBuilder, TransportError>
```

**Purpose**: Converts a transport-neutral `Request` into a `CodexRequestBuilder` with prepared headers, body bytes, and timeout applied.

**Data flow**: Consumes a `Request`, calls `req.prepare_body_for_send()` and maps any string error into `TransportError::Build`. It then destructures the original request to extract `method`, `url`, and `timeout`, reconstructs an `http::Method` from the method bytes with fallback to `GET`, creates a builder via `self.client.request(..., &url)`, conditionally applies timeout, replaces headers with `prepared.headers`, conditionally sets `prepared.body`, and returns `Result<CodexRequestBuilder, TransportError>`.

**Call relations**: Both `execute` and `stream` call this before sending. It is the single place where request preparation and reqwest builder assembly are joined.

*Call graph*: calls 2 internal fn (request, prepare_body_for_send); called by 2 (execute, stream); 1 external calls (from_bytes).


##### `ReqwestTransport::map_error`  (lines 76–82)

```
fn map_error(err: reqwest::Error) -> TransportError
```

**Purpose**: Normalizes reqwest transport failures into the client’s `TransportError` enum.

**Data flow**: Takes a `reqwest::Error`, checks `err.is_timeout()`, and returns either `TransportError::Timeout` or `TransportError::Network(err.to_string())`.

**Call relations**: Used in both buffered and streaming send paths to keep reqwest-specific error details from leaking past the transport boundary.

*Call graph*: 3 external calls (is_timeout, to_string, Network).


##### `request_body_for_trace`  (lines 85–94)

```
fn request_body_for_trace(req: &Request) -> String
```

**Purpose**: Formats a request body into a trace-log-friendly string without mutating the request.

**Data flow**: Reads `req.body.as_ref()` and matches variants: `Json(Value)` becomes `body.to_string()`, `EncodedJson` becomes `String::from_utf8_lossy(body.trace_bytes()).into_owned()`, `Raw(Bytes)` becomes a placeholder string with the byte length, and `None` becomes an empty string.

**Call relations**: Called by both `execute` and `stream` only when trace logging is enabled, so logs can include a readable representation of the outbound payload.

*Call graph*: 3 external calls (from_utf8_lossy, new, format!).


##### `ReqwestTransport::execute`  (lines 97–127)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Sends a request and buffers the entire successful response body, or returns a structured HTTP/transport error.

**Data flow**: Consumes a `Request`. If trace logging is enabled, it logs method, URL, and formatted body via `request_body_for_trace`. It clones `req.url` for later error reporting, builds a `CodexRequestBuilder` with `self.build(req)?`, awaits `builder.send()`, maps reqwest errors through `map_error`, then reads status, clones headers, and awaits `resp.bytes()`. Non-success statuses are converted into `TransportError::Http` with optional UTF-8 body text; success returns `crate::request::Response { status, headers, body: bytes }`.

**Call relations**: This is the non-streaming implementation of `HttpTransport::execute`. It depends on `build` for request assembly and on `CodexRequestBuilder::send` for actual network dispatch with trace propagation.

*Call graph*: calls 1 internal fn (build); 3 external calls (from_utf8, enabled!, trace!).


##### `ReqwestTransport::stream`  (lines 129–161)

```
async fn stream(&self, req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Sends a request and returns a streaming response body for successful statuses, or a structured HTTP/transport error otherwise.

**Data flow**: Consumes a `Request`, optionally emits the same trace log as `execute`, clones the URL, builds and sends the request, maps reqwest send errors with `map_error`, and inspects status and headers. For non-success statuses it buffers body text with `resp.text().await.ok()` and returns `TransportError::Http`; for success it converts `resp.bytes_stream()` into a stream of `Result<Bytes, TransportError>` by mapping each chunk error through `map_error`, boxes it, and returns `StreamResponse { status, headers, bytes }`.

**Call relations**: This is the streaming implementation of `HttpTransport::stream`. It shares the same setup path as `execute` but leaves body consumption incremental for SSE and other streaming consumers.

*Call graph*: calls 1 internal fn (build); 3 external calls (pin, enabled!, trace!).


### `codex-client/src/sse.rs`

`io_transport` · `streaming response handling`

This file contains a single helper, `sse_stream`, that turns a `ByteStream` from the transport layer into a background task producing `Result<String, StreamError>` messages over a Tokio MPSC channel. It uses `eventsource_stream::Eventsource` to parse Server-Sent Events framing from the incoming byte stream after first mapping transport errors into `StreamError::Stream` strings.

The function immediately spawns an async task and returns, so the caller does not await parsing directly. Inside the task, it repeatedly wraps `stream.next()` in `tokio::time::timeout` using the supplied idle timeout. Four outcomes are handled explicitly: a parsed event sends `Ok(ev.data.clone())`; a parser or upstream stream error sends `Err(StreamError::Stream(...))`; end-of-stream before a terminal event sends a synthetic `StreamError::Stream("stream closed before completion")`; and timeout expiration sends `Err(StreamError::Timeout)`. In every error or closed-channel case the task exits immediately. If the receiver side has already been dropped, even successful event forwarding stops silently by returning early. The helper intentionally forwards only the raw `data` field and ignores other SSE metadata such as event names, IDs, or retry hints, making it suitable for simple text/event-stream APIs where payload frames are the only meaningful output.

#### Function details

##### `sse_stream`  (lines 12–48)

```
fn sse_stream(
    stream: ByteStream,
    idle_timeout: Duration,
    tx: mpsc::Sender<Result<String, StreamError>>,
)
```

**Purpose**: Spawns a background loop that parses SSE frames from a byte stream and forwards each `data:` payload or terminal error through a channel.

**Data flow**: Takes a `ByteStream`, an `idle_timeout: Duration`, and an `mpsc::Sender<Result<String, StreamError>>`. It maps transport errors into `StreamError::Stream`, converts the stream into an SSE parser, then in a spawned task repeatedly awaits `timeout(idle_timeout, stream.next())`. Parsed events yield `Ok(ev.data.clone())` sent on `tx`; parser errors, premature EOF, and timeout each send an `Err(StreamError)` variant before returning. If `tx.send(...)` fails because the receiver is gone, the task exits without further work.

**Call relations**: This helper sits between the transport layer’s raw byte streaming and higher-level consumers expecting discrete SSE payload strings. It delegates framing to `eventsource_stream` and uses Tokio spawning so callers can continue immediately after wiring the channel.

*Call graph*: 6 external calls (map, next, send, Stream, spawn, timeout).


### `codex-client/src/lib.rs`

`orchestration` · `cross-cutting`

This crate root wires together the client subsystem by declaring its internal modules and re-exporting the types and functions intended for consumers. The internal layout separates concerns cleanly: host and Cloudflare-cookie helpers for ChatGPT-specific access control, custom certificate-authority support, a default HTTP client implementation, request/response body abstractions, retry policy machinery, SSE streaming, telemetry hooks, and transport traits plus reqwest-backed implementations. The public exports define the crate's usable surface: callers can construct requests with `Request`, `RequestBody`, `PreparedRequestBody`, `EncodedJsonBody`, and `RequestCompression`; execute them through `CodexHttpClient`, `CodexRequestBuilder`, `HttpTransport`, or `ReqwestTransport`; consume responses via `Response`, `ByteStream`, and `StreamResponse`; and configure resilience with `RetryPolicy`, `RetryOn`, `backoff`, and `run_with_retry`. It also exposes `sse_stream` for event streams and `RequestTelemetry` for per-attempt instrumentation. A notable design detail is the hidden-but-public subprocess helper for custom CA tests: it remains exported solely so a separate binary target can reuse it, while docs steer normal users toward `build_reqwest_client_with_custom_ca`. Overall, this file is the crate's compatibility boundary: internal modules can evolve as long as these re-exports remain stable.


### HTTP client configuration
These files build the reusable outbound client setup around tracing, custom CA handling, and constrained cookie storage for authenticated networking.

### `codex-client/src/chatgpt_cloudflare_cookies.rs`

`io_transport` · `cross-cutting HTTP client setup and request/response cookie handling`

This module implements a deliberately narrow cookie policy for Codex HTTP clients talking to ChatGPT surfaces. A global `LazyLock<Arc<ChatGptCloudflareCookieStore>>` exposes one shared store per process, but the store is safe to share only because it hard-restricts both where cookies may be stored and which cookie names survive. The internal `ChatGptCloudflareCookieStore` wraps reqwest's `Jar` and implements `reqwest::cookie::CookieStore`.

On writes, `set_cookies` first rejects any non-HTTPS or non-allowed ChatGPT URL via `is_chatgpt_cookie_url`. For accepted URLs, it filters incoming `Set-Cookie` headers through `is_allowed_cloudflare_set_cookie_header`, which parses just the cookie name and checks it against a Cloudflare allowlist plus the `cf_chl_` prefix. On reads, `cookies` again requires an allowed ChatGPT URL, then asks the underlying jar for the cookie header and strips out any non-Cloudflare cookies with `only_cloudflare_cookies` before returning it. This double filtering means even if the jar ever contained mixed cookies, callers only receive the infrastructure subset.

Helper functions encode the policy details: host validation is delegated to `chatgpt_hosts`, only HTTPS is accepted, malformed header values are ignored, and OpenAI/ChatGPT account cookies are intentionally excluded. The tests exercise positive storage, host rejection, mixed-cookie filtering, HTTPS-only behavior, and the exact allowlist boundaries.

#### Function details

##### `ChatGptCloudflareCookieStore::set_cookies`  (lines 23–35)

```
fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &HeaderValue>,
        url: &reqwest::Url,
    )
```

**Purpose**: Accepts response `Set-Cookie` headers only for approved ChatGPT HTTPS URLs and forwards only Cloudflare-allowed cookies into the underlying jar.

**Data flow**: It receives an iterator of `HeaderValue` references and a request URL. It first reads the URL through `is_chatgpt_cookie_url`; if that check fails, it returns without mutating state. Otherwise it filters the header iterator with `is_allowed_cloudflare_set_cookie_header` and passes the reduced stream plus the URL into the inner `Jar::set_cookies`, thereby mutating only the jar's stored Cloudflare cookie state.

**Call relations**: This method is invoked by reqwest's cookie machinery when responses arrive for clients using this store. It delegates URL policy to `is_chatgpt_cookie_url` and header-name policy to `is_allowed_cloudflare_set_cookie_header` before handing accepted cookies to the standard jar implementation.

*Call graph*: calls 1 internal fn (is_chatgpt_cookie_url); 2 external calls (filter, set_cookies).


##### `ChatGptCloudflareCookieStore::cookies`  (lines 37–43)

```
fn cookies(&self, url: &reqwest::Url) -> Option<HeaderValue>
```

**Purpose**: Returns a request `Cookie` header only for approved ChatGPT HTTPS URLs and only containing Cloudflare cookie pairs.

**Data flow**: It takes a URL reference, checks it with `is_chatgpt_cookie_url`, and if allowed asks the inner jar for its cookie header for that URL. The resulting `HeaderValue` is then transformed by `only_cloudflare_cookies`, which may drop disallowed cookie pairs and return `None` if nothing allowed remains. For non-allowed URLs it returns `None` immediately and reads no jar state.

**Call relations**: Reqwest calls this during outbound request preparation for clients configured with the store. It mirrors `set_cookies` by enforcing the same URL gate and then delegates final header sanitization to `only_cloudflare_cookies`.

*Call graph*: calls 1 internal fn (is_chatgpt_cookie_url); 1 external calls (cookies).


##### `with_chatgpt_cloudflare_cookie_store`  (lines 52–56)

```
fn with_chatgpt_cloudflare_cookie_store(
    builder: reqwest::ClientBuilder,
) -> reqwest::ClientBuilder
```

**Purpose**: Attaches the shared process-global Cloudflare-only cookie store to a reqwest client builder.

**Data flow**: It takes ownership of a `reqwest::ClientBuilder`, clones the global `Arc<ChatGptCloudflareCookieStore>`, installs it via `cookie_provider`, and returns the modified builder. No cookie contents are changed here; only builder configuration is updated.

**Call relations**: This is the public integration point for callers constructing HTTP clients. Rather than creating per-client stores, it wires the shared allowlisted store into reqwest so later response and request flows hit `set_cookies` and `cookies`.

*Call graph*: 2 external calls (clone, cookie_provider).


##### `is_chatgpt_cookie_url`  (lines 58–69)

```
fn is_chatgpt_cookie_url(url: &reqwest::Url) -> bool
```

**Purpose**: Determines whether a URL is eligible for shared Cloudflare cookie storage by requiring HTTPS and an allowed ChatGPT host.

**Data flow**: It reads the URL scheme and host string. Any scheme other than `https` or any URL without a host returns `false`; otherwise it passes the host into `is_allowed_chatgpt_host` and returns that boolean result.

**Call relations**: This helper is called by both `ChatGptCloudflareCookieStore::set_cookies` and `ChatGptCloudflareCookieStore::cookies` so read and write paths share identical URL eligibility rules.

*Call graph*: calls 1 internal fn (is_allowed_chatgpt_host); called by 2 (cookies, set_cookies); 2 external calls (host_str, scheme).


##### `is_allowed_cloudflare_set_cookie_header`  (lines 71–77)

```
fn is_allowed_cloudflare_set_cookie_header(header: &HeaderValue) -> bool
```

**Purpose**: Checks whether a raw `Set-Cookie` header names one of the Cloudflare cookies the shared store is allowed to persist.

**Data flow**: It takes a `HeaderValue`, attempts to decode it to `&str`, extracts the cookie name with `set_cookie_name`, and then tests that name with `is_allowed_cloudflare_cookie_name`. Invalid header encoding or missing names collapse to `false`.

**Call relations**: Used as the predicate inside `ChatGptCloudflareCookieStore::set_cookies`'s iterator filter. It delegates parsing and allowlist matching to smaller helpers so malformed headers are simply ignored.

*Call graph*: 1 external calls (to_str).


##### `set_cookie_name`  (lines 79–83)

```
fn set_cookie_name(header: &str) -> Option<&str>
```

**Purpose**: Extracts the cookie name token from a `Set-Cookie` header string.

**Data flow**: It receives a header string, splits once on `'='`, trims the left-hand side, and returns `Some(name)` only if the trimmed name is non-empty. If no equals sign exists or the name is blank, it returns `None`.

**Call relations**: This helper supports `is_allowed_cloudflare_set_cookie_header` by isolating the minimal parsing needed for allowlist checks without interpreting attributes or values.


##### `only_cloudflare_cookies`  (lines 85–102)

```
fn only_cloudflare_cookies(header: HeaderValue) -> Option<HeaderValue>
```

**Purpose**: Filters an outbound `Cookie` header down to only the allowed Cloudflare cookie pairs and rebuilds the header if any remain.

**Data flow**: It takes an owned `HeaderValue`, converts it to `&str`, splits on semicolons into individual cookie pairs, trims each pair, extracts each cookie name, and keeps only those whose names satisfy `is_allowed_cloudflare_cookie_name`. The surviving pairs are joined with `"; "` and converted back into a `HeaderValue`; if conversion fails or no allowed cookies remain, it returns `None`.

**Call relations**: Called by `ChatGptCloudflareCookieStore::cookies` after the underlying jar has produced a combined cookie header. It acts as a final outbound safety filter independent of what may be stored internally.

*Call graph*: 3 external calls (from_str, split, to_str).


##### `is_allowed_cloudflare_cookie_name`  (lines 104–119)

```
fn is_allowed_cloudflare_cookie_name(name: &str) -> bool
```

**Purpose**: Implements the explicit allowlist of Cloudflare service cookie names that may be shared process-wide.

**Data flow**: It reads a cookie name string and returns `true` if it matches one of the hardcoded documented Cloudflare names or starts with the `cf_chl_` prefix; otherwise it returns `false`. It does not inspect values or mutate state.

**Call relations**: This is the core policy predicate used by both inbound filtering (`is_allowed_cloudflare_set_cookie_header`) and outbound filtering (`only_cloudflare_cookies`). The tests also exercise it directly to pin the allowlist boundary.

*Call graph*: 1 external calls (matches!).


##### `tests::stores_and_returns_cloudflare_cookies_for_chatgpt_hosts`  (lines 128–155)

```
fn stores_and_returns_cloudflare_cookies_for_chatgpt_hosts()
```

**Purpose**: Verifies that allowed Cloudflare cookies set on an approved ChatGPT HTTPS URL are stored and later returned as request cookies.

**Data flow**: The test constructs a default store, parses a ChatGPT URL, creates `_cfuvid` and `cf_clearance` `HeaderValue`s, feeds them into `set_cookies`, then reads back `cookies`, converts the header to strings, sorts the cookie pairs, and asserts the expected two entries are present.

**Call relations**: This test exercises the positive path through both `set_cookies` and `cookies`, confirming that the allowlist and URL gate permit legitimate Cloudflare infrastructure cookies.

*Call graph*: 4 external calls (from_static, assert_eq!, default, parse).


##### `tests::ignores_non_chatgpt_cookies`  (lines 158–166)

```
fn ignores_non_chatgpt_cookies()
```

**Purpose**: Checks that even allowed Cloudflare cookie names are ignored when the URL host is outside the approved ChatGPT set.

**Data flow**: It creates a store, parses an `api.openai.com` URL, constructs an `_cfuvid` header, calls `set_cookies`, then asserts that `cookies` for that URL returns `None`.

**Call relations**: This test covers the host gate enforced by `is_chatgpt_cookie_url`, showing that cookie-name allowlisting alone is insufficient without an approved HTTPS ChatGPT host.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::ignores_non_cloudflare_cookies_for_chatgpt_hosts`  (lines 169–179)

```
fn ignores_non_cloudflare_cookies_for_chatgpt_hosts()
```

**Purpose**: Ensures that ChatGPT account/session cookies are not stored even when they arrive from an approved ChatGPT host.

**Data flow**: It builds a store, parses a ChatGPT URL, creates a `__Secure-next-auth.session-token` header, passes it to `set_cookies`, and asserts that no cookies are returned for that URL.

**Call relations**: This test targets the cookie-name allowlist path, proving that the shared jar refuses user-specific cookies on otherwise eligible hosts.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::ignores_mixed_non_cloudflare_cookies_for_chatgpt_hosts`  (lines 182–197)

```
fn ignores_mixed_non_cloudflare_cookies_for_chatgpt_hosts()
```

**Purpose**: Verifies that mixed `Set-Cookie` input stores only the Cloudflare subset and drops unrelated ChatGPT cookies.

**Data flow**: It creates a store and ChatGPT URL, constructs one allowed `_cfuvid` header and one disallowed `chatgpt_session` header, stores both, then reads back the cookie header as a string and asserts only `_cfuvid=visitor` remains.

**Call relations**: This test exercises the filtering behavior inside `set_cookies` and confirms that disallowed cookies do not contaminate the shared jar when mixed with allowed ones.

*Call graph*: 4 external calls (from_static, assert_eq!, default, parse).


##### `tests::does_not_return_chatgpt_cloudflare_cookies_for_other_hosts`  (lines 200–210)

```
fn does_not_return_chatgpt_cloudflare_cookies_for_other_hosts()
```

**Purpose**: Confirms that cookies stored for an approved ChatGPT host are not exposed when requests target a different host.

**Data flow**: It stores an allowed `_cfuvid` cookie against a ChatGPT URL, then asks for cookies on an `api.openai.com` URL and asserts the result is `None`.

**Call relations**: This test covers the outbound read path's URL gate in `cookies`, ensuring host scoping is enforced even after valid cookies have been stored.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::rejects_plain_http_chatgpt_cookie_urls`  (lines 213–225)

```
fn rejects_plain_http_chatgpt_cookie_urls()
```

**Purpose**: Checks that plain HTTP ChatGPT URLs are rejected for both storage and retrieval, even though the host itself is otherwise allowed.

**Data flow**: It creates HTTP and HTTPS ChatGPT URLs, attempts to store an allowed `_cfuvid` cookie using the HTTP URL, then asserts that `cookies` returns `None` for both the HTTP and HTTPS URLs.

**Call relations**: This test exercises the scheme check inside `is_chatgpt_cookie_url`, proving the shared store is HTTPS-only and does not accept downgraded origins.

*Call graph*: 5 external calls (from_static, assert_eq!, default, parse, once).


##### `tests::only_allows_https_urls`  (lines 228–236)

```
fn only_allows_https_urls()
```

**Purpose**: Directly verifies that `is_chatgpt_cookie_url` rejects non-HTTPS schemes such as `http` and `wss`.

**Data flow**: It parses two non-HTTPS URLs and asserts that `is_chatgpt_cookie_url` returns false for each.

**Call relations**: This is a focused unit test for the URL predicate used by both cookie read and write paths.

*Call graph*: 2 external calls (assert!, parse).


##### `tests::allows_only_known_cloudflare_cookie_names`  (lines 239–263)

```
fn allows_only_known_cloudflare_cookie_names()
```

**Purpose**: Pins the exact cookie-name allowlist by asserting acceptance of documented Cloudflare names and rejection of unrelated names.

**Data flow**: It iterates over a list of expected-true names and expected-false names, calling `is_allowed_cloudflare_cookie_name` for each and asserting the result.

**Call relations**: This test directly guards the central allowlist predicate that both inbound and outbound filtering depend on.

*Call graph*: 1 external calls (assert!).


### `codex-client/src/custom_ca.rs`

`config` · `HTTP/websocket client construction and config load`

This module is the system's shared trust-store policy for enterprise environments that require custom root CAs. Its public entrypoints build either a reqwest client or an optional rustls `ClientConfig` by consulting `CODEX_CA_CERTIFICATE` first and `SSL_CERT_FILE` second, treating empty values as unset. The core flow is: select a `ConfiguredCaBundle` through the `EnvSource` abstraction, read the PEM file, normalize OpenSSL `TRUSTED CERTIFICATE` labels via `NormalizedPem`, iterate mixed PEM sections, ignore CRLs, extract every certificate DER block, and register those certificates with either reqwest or a rustls `RootCertStore`. When no CA override is configured, reqwest builds with system roots and websocket callers get `Ok(None)` so they can keep their default connector path.

The file's most important design choices are defensive and operator-facing. Errors are represented by `BuildCustomCaTransportError`, which preserves whether failure came from file I/O, malformed PEM, per-certificate registration, or final client build. The `From<...> for io::Error` conversion maps those variants onto sensible `io::ErrorKind`s. For compatibility, `NormalizedPem` rewrites `TRUSTED CERTIFICATE` labels and trims trailing OpenSSL `X509_AUX` metadata using `first_der_item`/`der_item_length` rather than rejecting such bundles outright. Logging records which environment variable selected the bundle, how many certificates loaded, and whether CRLs or native-root loading issues were encountered. Tests cover precedence, empty-value handling, and rustls config creation against fixture PEM files.

#### Function details

##### `Error::from`  (lines 148–161)

```
fn from(error: BuildCustomCaTransportError) -> Self
```

**Purpose**: Converts `BuildCustomCaTransportError` into an `io::Error` while preserving meaningful error kinds for callers that only traffic in I/O-style failures.

**Data flow**: It takes ownership of a `BuildCustomCaTransportError`, pattern-matches its variant, and constructs an `io::Error`: `ReadCaFile` preserves the underlying source kind, parse/registration failures become `InvalidData`, and client-build failures become `io::Error::other`. It returns the new `io::Error` and writes no external state.

**Call relations**: This conversion is used implicitly when higher layers want to collapse custom-CA transport failures into standard I/O errors without losing the formatted diagnostic message.

*Call graph*: 2 external calls (new, other).


##### `build_reqwest_client_with_custom_ca`  (lines 179–183)

```
fn build_reqwest_client_with_custom_ca(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Public production entrypoint for building a reqwest client that honors Codex CA override environment variables.

**Data flow**: It accepts a caller-prepared `reqwest::ClientBuilder`, passes it with the real `ProcessEnv` into `build_reqwest_client_with_env`, and returns either the built `reqwest::Client` or a `BuildCustomCaTransportError`.

**Call relations**: This is the normal HTTP-facing wrapper around `build_reqwest_client_with_env`. Callers use it instead of constructing reqwest clients directly so custom CA policy is consistently applied.

*Call graph*: calls 1 internal fn (build_reqwest_client_with_env).


##### `maybe_build_rustls_client_config_with_custom_ca`  (lines 196–199)

```
fn maybe_build_rustls_client_config_with_custom_ca() -> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError>
```

**Purpose**: Public production entrypoint for optionally building a rustls client config when a custom CA bundle is configured in the environment.

**Data flow**: It reads no inputs beyond the real process environment indirectly through `ProcessEnv`, delegates to `maybe_build_rustls_client_config_with_env`, and returns `Ok(None)` when no CA override is selected or `Ok(Some(Arc<ClientConfig>))`/`Err(...)` otherwise.

**Call relations**: This is the websocket-facing sibling of the reqwest builder. It exists so websocket code can share the same CA-selection and parsing policy as HTTP code.

*Call graph*: calls 1 internal fn (maybe_build_rustls_client_config_with_env).


##### `build_reqwest_client_for_subprocess_tests`  (lines 209–213)

```
fn build_reqwest_client_for_subprocess_tests(
    builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Builds a reqwest client through the shared custom-CA path but disables reqwest proxy autodetection for hermetic subprocess tests.

**Data flow**: It takes a `reqwest::ClientBuilder`, applies `no_proxy()` to suppress ambient proxy discovery, then delegates to `build_reqwest_client_with_env` with `ProcessEnv`. It returns the resulting client or transport error.

**Call relations**: This wrapper is called by subprocess test helpers such as the custom CA probe binary. It reuses the production CA logic while altering only proxy behavior to make tests more deterministic.

*Call graph*: calls 1 internal fn (build_reqwest_client_with_env); 1 external calls (no_proxy).


##### `maybe_build_rustls_client_config_with_env`  (lines 215–262)

```
fn maybe_build_rustls_client_config_with_env(
    env_source: &dyn EnvSource,
) -> Result<Option<Arc<ClientConfig>>, BuildCustomCaTransportError>
```

**Purpose**: Internal rustls-config builder that applies environment-driven CA selection, loads native roots, and layers custom certificates on top when configured.

**Data flow**: It takes an `EnvSource`, asks it for `configured_ca_bundle`, and returns `Ok(None)` if none is selected. Otherwise it ensures the rustls crypto provider is installed, creates an empty `RootCertStore`, loads native certificates with `rustls_native_certs::load_native_certs`, logs any native-root load errors, adds parsable native certs, loads custom certificates from the selected bundle, and inserts them one by one into the root store. On success it builds a `ClientConfig` with those roots and no client auth, wraps it in `Arc`, and returns `Ok(Some(...))`; on registration failure it returns `RegisterRustlsCertificate`.

**Call relations**: This function underlies the public websocket entrypoint and is also called directly by tests using fake env sources. It delegates bundle parsing to `ConfiguredCaBundle::load_certificates` and owns the rustls-specific root-store assembly.

*Call graph*: calls 1 internal fn (configured_ca_bundle); called by 3 (maybe_build_rustls_client_config_with_custom_ca, rustls_config_reports_invalid_ca_file, rustls_config_uses_custom_ca_bundle_when_configured); 6 external calls (new, builder, empty, ensure_rustls_crypto_provider, load_native_certs, warn!).


##### `build_reqwest_client_with_env`  (lines 271–343)

```
fn build_reqwest_client_with_env(
    env_source: &dyn EnvSource,
    mut builder: reqwest::ClientBuilder,
) -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Internal shared implementation that selects a CA bundle from an injected environment source, loads certificates if present, and builds the final reqwest client.

**Data flow**: It takes an `EnvSource` and mutable `reqwest::ClientBuilder`. If `configured_ca_bundle` returns a bundle, it ensures the rustls provider, logs the selected env/path, switches the builder to rustls, loads certificates from the bundle, converts each DER blob into a `reqwest::Certificate`, adds each as a root certificate, and finally builds the client. Certificate conversion failures become `RegisterCertificate`; final build failures become `BuildClientWithCustomCa`. If no bundle is configured, it logs that system roots are being used, builds the client unchanged, and maps any build failure to `BuildClientWithSystemRoots`.

**Call relations**: This is the central implementation used by both `build_reqwest_client_with_custom_ca` and `build_reqwest_client_for_subprocess_tests`. It delegates env precedence to `EnvSource::configured_ca_bundle` and PEM parsing to `ConfiguredCaBundle::load_certificates`.

*Call graph*: calls 1 internal fn (configured_ca_bundle); called by 2 (build_reqwest_client_for_subprocess_tests, build_reqwest_client_with_custom_ca); 8 external calls (add_root_certificate, build, use_rustls_tls, BuildClientWithSystemRoots, ensure_rustls_crypto_provider, info!, from_der, warn!).


##### `EnvSource::non_empty_path`  (lines 362–366)

```
fn non_empty_path(&self, key: &str) -> Option<PathBuf>
```

**Purpose**: Interprets an environment variable as a filesystem path only when it is present and non-empty.

**Data flow**: It calls `self.var(key)`, filters out empty strings, converts the remaining string into a `PathBuf`, and returns `Option<PathBuf>`. It performs no trimming beyond rejecting exact emptiness.

**Call relations**: This default trait helper is used by `EnvSource::configured_ca_bundle` so precedence logic can treat empty env vars as unset rather than as bogus paths.

*Call graph*: called by 1 (configured_ca_bundle).


##### `EnvSource::configured_ca_bundle`  (lines 373–386)

```
fn configured_ca_bundle(&self) -> Option<ConfiguredCaBundle>
```

**Purpose**: Applies environment-variable precedence to choose which CA bundle path, if any, should be loaded.

**Data flow**: It queries `non_empty_path(CODEX_CA_CERTIFICATE)` first and, if present, wraps that path in a `ConfiguredCaBundle` tagged with `CODEX_CA_CERTIFICATE`. Otherwise it queries `non_empty_path(SSL_CERT_FILE)` and wraps that path similarly. If neither yields a path, it returns `None`.

**Call relations**: Both reqwest and rustls build paths call this method to share one precedence rule. It depends on `non_empty_path` so empty strings do not win precedence.

*Call graph*: calls 1 internal fn (non_empty_path); called by 2 (build_reqwest_client_with_env, maybe_build_rustls_client_config_with_env).


##### `ProcessEnv::var`  (lines 397–399)

```
fn var(&self, key: &str) -> Option<String>
```

**Purpose**: Production `EnvSource` implementation that reads environment variables from the real process.

**Data flow**: It takes a key string, calls `std::env::var`, converts successful reads into `Some(String)`, and collapses missing or unreadable values into `None`.

**Call relations**: This method supplies actual environment values to the public reqwest and rustls entrypoints through the `EnvSource` trait.

*Call graph*: 1 external calls (var).


##### `ConfiguredCaBundle::load_certificates`  (lines 420–443)

```
fn load_certificates(
        &self,
    ) -> Result<Vec<CertificateDer<'static>>, BuildCustomCaTransportError>
```

**Purpose**: Loads and logs the certificate set for the selected CA bundle, wrapping lower-level parse results with bundle-specific diagnostics.

**Data flow**: It reads `self.source_env` and `self.path`, calls `parse_certificates`, logs success with the certificate count when parsing succeeds, or logs a warning with the error when parsing fails. It returns the parsed `Vec<CertificateDer<'static>>` or propagates the shaped `BuildCustomCaTransportError`.

**Call relations**: Called by both reqwest and rustls build paths after env selection. It delegates actual file reading and PEM parsing to `parse_certificates` and owns the high-level success/failure logging for that phase.

*Call graph*: calls 1 internal fn (parse_certificates); 2 external calls (info!, warn!).


##### `ConfiguredCaBundle::parse_certificates`  (lines 451–497)

```
fn parse_certificates(
        &self,
    ) -> Result<Vec<CertificateDer<'static>>, BuildCustomCaTransportError>
```

**Purpose**: Reads the selected PEM bundle, normalizes supported variants, extracts certificate sections, ignores CRLs, and returns all usable certificate DER blobs.

**Data flow**: It first calls `read_pem_data` to get raw bytes, then constructs a `NormalizedPem` with `from_pem_data`. It iterates `normalized_pem.sections()`, converting parser errors through `pem_parse_error`. For `SectionKind::Certificate`, it obtains the certificate bytes via `normalized_pem.certificate_der`, errors if trimming fails, and pushes owned `CertificateDer` values into a vector. For the first `SectionKind::Crl`, it logs that CRLs are being ignored; all other section kinds are skipped. If no certificates were collected, it returns a `NoItemsFound`-based invalid-file error; otherwise it returns the vector.

**Call relations**: This is the core PEM-processing routine behind `load_certificates`. It delegates raw file I/O to `read_pem_data`, PEM normalization to `NormalizedPem::from_pem_data`, and parse-error shaping to `pem_parse_error`.

*Call graph*: calls 3 internal fn (pem_parse_error, read_pem_data, from_pem_data); called by 1 (load_certificates); 3 external calls (from, new, info!).


##### `ConfiguredCaBundle::read_pem_data`  (lines 504–510)

```
fn read_pem_data(&self) -> Result<Vec<u8>, BuildCustomCaTransportError>
```

**Purpose**: Reads the configured CA bundle file from disk and preserves the original filesystem error in a structured transport error.

**Data flow**: It uses `fs::read(&self.path)` to load the file bytes. On success it returns the `Vec<u8>`; on failure it constructs `BuildCustomCaTransportError::ReadCaFile` containing the source env name, cloned path, and original `io::Error`.

**Call relations**: Called only by `parse_certificates` as the first step of bundle loading, separating filesystem failure handling from PEM parsing logic.

*Call graph*: called by 1 (parse_certificates); 1 external calls (read).


##### `ConfiguredCaBundle::pem_parse_error`  (lines 517–524)

```
fn pem_parse_error(&self, error: &pem::Error) -> BuildCustomCaTransportError
```

**Purpose**: Transforms a low-level PEM parser error into a user-facing invalid-CA error message tied to the selected bundle.

**Data flow**: It takes a `pem::Error`, maps `NoItemsFound` to the friendlier detail `no certificates found in PEM file`, formats all other parser errors into `failed to parse PEM file: ...`, and passes that detail into `invalid_ca_file` to produce a `BuildCustomCaTransportError`.

**Call relations**: Used by `parse_certificates` whenever section iteration fails or no certificates are found, so all parse-time failures share consistent wording and remediation hints.

*Call graph*: calls 1 internal fn (invalid_ca_file); called by 1 (parse_certificates); 1 external calls (format!).


##### `ConfiguredCaBundle::invalid_ca_file`  (lines 531–537)

```
fn invalid_ca_file(&self, detail: impl std::fmt::Display) -> BuildCustomCaTransportError
```

**Purpose**: Constructs the `InvalidCaFile` error variant for this bundle with a supplied detail string.

**Data flow**: It reads `self.source_env`, clones `self.path`, converts the provided displayable detail into a `String`, and returns `BuildCustomCaTransportError::InvalidCaFile`.

**Call relations**: This helper is the common sink for parse-related failures, called by `pem_parse_error` and by `parse_certificates` when trusted-certificate DER trimming fails.

*Call graph*: called by 1 (pem_parse_error); 2 external calls (to_string, clone).


##### `NormalizedPem::from_pem_data`  (lines 577–592)

```
fn from_pem_data(source_env: &'static str, path: &Path, pem_data: &[u8]) -> Self
```

**Purpose**: Normalizes raw PEM text into either standard form or a rewritten form that treats OpenSSL `TRUSTED CERTIFICATE` blocks as ordinary certificate blocks.

**Data flow**: It takes the source env name, bundle path, and raw PEM bytes, decodes them lossily to text, checks whether the text contains `TRUSTED CERTIFICATE`, and if so logs that normalization is happening and replaces the begin/end labels with standard `CERTIFICATE` labels. It returns either `NormalizedPem::TrustedCertificate` with rewritten contents or `NormalizedPem::Standard` with the original text.

**Call relations**: Called by `ConfiguredCaBundle::parse_certificates` before section iteration. It prepares the PEM text so `rustls_pki_types` mixed-section parsing can see trusted-certificate blocks as certificate sections.

*Call graph*: called by 1 (parse_certificates); 4 external calls (Standard, TrustedCertificate, from_utf8_lossy, info!).


##### `NormalizedPem::contents`  (lines 595–599)

```
fn contents(&self) -> &str
```

**Purpose**: Returns the normalized PEM text regardless of whether it originated from standard or trusted-certificate input.

**Data flow**: It matches on `self` and returns a shared `&str` reference to the stored string contents.

**Call relations**: This small accessor is used by `NormalizedPem::sections` to feed the parser without exposing enum internals to callers.

*Call graph*: called by 1 (sections).


##### `NormalizedPem::sections`  (lines 606–608)

```
fn sections(&self) -> impl Iterator<Item = Result<PemSection, pem::Error>> + '_
```

**Purpose**: Creates an iterator over parsed PEM sections from the normalized PEM contents.

**Data flow**: It reads the normalized text via `contents()`, converts it to bytes, and returns the iterator produced by `PemSection::pem_slice_iter`, yielding `Result<(SectionKind, Vec<u8>), pem::Error>` items.

**Call relations**: Called by `ConfiguredCaBundle::parse_certificates` to walk mixed PEM content one section at a time.

*Call graph*: calls 1 internal fn (contents); 1 external calls (pem_slice_iter).


##### `NormalizedPem::certificate_der`  (lines 615–620)

```
fn certificate_der(&self, der: &'a [u8]) -> Option<&'a [u8]>
```

**Purpose**: Returns the certificate DER bytes for a parsed certificate section, trimming trailing OpenSSL auxiliary metadata when necessary.

**Data flow**: It takes a borrowed DER byte slice from a parsed PEM section. For `Standard` PEM it returns the slice unchanged; for `TrustedCertificate` PEM it calls `first_der_item` to locate and return only the first top-level DER object. The result is `Option<&[u8]>` so malformed trusted-certificate data can be rejected.

**Call relations**: Used by `ConfiguredCaBundle::parse_certificates` when converting parsed certificate sections into `CertificateDer` values.

*Call graph*: calls 1 internal fn (first_der_item).


##### `first_der_item`  (lines 635–637)

```
fn first_der_item(der: &[u8]) -> Option<&[u8]>
```

**Purpose**: Slices out the first top-level DER object from a byte buffer, ignoring any trailing bytes such as OpenSSL `X509_AUX` metadata.

**Data flow**: It takes a DER byte slice, calls `der_item_length` to compute the first object's total length, and if successful returns a subslice covering exactly that prefix. If the length cannot be determined, it returns `None`.

**Call relations**: This helper is called by `NormalizedPem::certificate_der` only for trusted-certificate inputs that may contain appended metadata.

*Call graph*: calls 1 internal fn (der_item_length); called by 1 (certificate_der).


##### `der_item_length`  (lines 663–687)

```
fn der_item_length(der: &[u8]) -> Option<usize>
```

**Purpose**: Parses the outer DER length encoding of the first ASN.1 item and returns the total byte length of that item.

**Data flow**: It reads the second byte of the input as the DER length octet. For short-form lengths it computes `2 + length`; for long-form lengths it reads the declared number of subsequent length bytes, accumulates them into a `usize` content length with checked arithmetic, and returns `length_end + content_length`. It rejects indefinite lengths, arithmetic overflow, missing bytes, and any declared length beyond the input slice by returning `None`.

**Call relations**: Called only by `first_der_item`. It intentionally performs just enough DER parsing to find a safe boundary for the leading certificate object.

*Call graph*: called by 1 (first_der_item); 1 external calls (from).


##### `tests::MapEnv::var`  (lines 711–713)

```
fn var(&self, key: &str) -> Option<String>
```

**Purpose**: Implements the `EnvSource` trait for the test-only in-memory environment map.

**Data flow**: It takes a key string, looks it up in the `values` `HashMap`, clones the stored string if present, and returns `Option<String>`.

**Call relations**: This method lets unit tests drive `configured_ca_bundle` and rustls-config logic deterministically without mutating the real process environment.


##### `tests::map_env`  (lines 716–723)

```
fn map_env(pairs: &[(&str, &str)]) -> MapEnv
```

**Purpose**: Builds a `MapEnv` test environment from a slice of key/value pairs.

**Data flow**: It takes a slice of `(&str, &str)` pairs, converts each key and value into owned `String`s, collects them into a `HashMap`, wraps that map in `MapEnv`, and returns it.

**Call relations**: Used by the unit tests to create concise fake environments for precedence and empty-value scenarios.


##### `tests::write_cert_file`  (lines 725–731)

```
fn write_cert_file(temp_dir: &TempDir, name: &str, contents: &str) -> PathBuf
```

**Purpose**: Writes a certificate fixture file into a temporary directory and returns its path for tests.

**Data flow**: It takes a `TempDir`, filename, and file contents string, joins the filename onto the temp directory path, writes the contents with `fs::write`, panics with a descriptive message if writing fails, and returns the resulting `PathBuf`.

**Call relations**: This helper is used by rustls-related tests to materialize PEM fixtures on disk before invoking the bundle-loading code.

*Call graph*: 2 external calls (path, write).


##### `tests::ca_path_prefers_codex_env`  (lines 734–744)

```
fn ca_path_prefers_codex_env()
```

**Purpose**: Verifies that `CODEX_CA_CERTIFICATE` wins over `SSL_CERT_FILE` when both are set.

**Data flow**: The test constructs a `MapEnv` containing both variables, calls `configured_ca_bundle`, maps the result to its path, and asserts that the chosen path is the Codex-specific one.

**Call relations**: This test exercises the precedence logic implemented in `EnvSource::configured_ca_bundle`.

*Call graph*: 2 external calls (assert_eq!, map_env).


##### `tests::ca_path_falls_back_to_ssl_cert_file`  (lines 747–754)

```
fn ca_path_falls_back_to_ssl_cert_file()
```

**Purpose**: Checks that `SSL_CERT_FILE` is selected when the Codex-specific variable is absent.

**Data flow**: It creates a `MapEnv` with only `SSL_CERT_FILE`, calls `configured_ca_bundle`, extracts the path, and asserts that the fallback path is returned.

**Call relations**: This test covers the fallback branch of the environment-selection logic.

*Call graph*: 2 external calls (assert_eq!, map_env).


##### `tests::ca_path_ignores_empty_values`  (lines 757–767)

```
fn ca_path_ignores_empty_values()
```

**Purpose**: Ensures that empty environment-variable values are treated as unset rather than as selected paths.

**Data flow**: It builds a `MapEnv` where `CODEX_CA_CERTIFICATE` is the empty string and `SSL_CERT_FILE` has a real path, calls `configured_ca_bundle`, and asserts that the fallback path is chosen.

**Call relations**: This test specifically validates the `non_empty_path` helper used by the precedence logic.

*Call graph*: 2 external calls (assert_eq!, map_env).


##### `tests::rustls_config_uses_custom_ca_bundle_when_configured`  (lines 770–780)

```
fn rustls_config_uses_custom_ca_bundle_when_configured()
```

**Purpose**: Verifies that the rustls builder path returns a concrete client config when pointed at a valid CA PEM file.

**Data flow**: It creates a temporary directory, writes the test CA fixture to `ca.pem`, builds a `MapEnv` pointing `CODEX_CA_CERTIFICATE` at that file, calls `maybe_build_rustls_client_config_with_env`, unwraps the `Some(config)` result, and asserts that SNI is enabled on the returned config.

**Call relations**: This test exercises the successful path through env selection, PEM loading, native-root layering, and rustls config construction.

*Call graph*: calls 1 internal fn (maybe_build_rustls_client_config_with_env); 4 external calls (new, assert!, map_env, write_cert_file).


##### `tests::rustls_config_reports_invalid_ca_file`  (lines 783–794)

```
fn rustls_config_reports_invalid_ca_file()
```

**Purpose**: Checks that an empty PEM file is reported as an `InvalidCaFile` error by the rustls builder path.

**Data flow**: It creates a temporary directory, writes an empty `empty.pem`, points `CODEX_CA_CERTIFICATE` at that file via `MapEnv`, calls `maybe_build_rustls_client_config_with_env`, captures the error, and asserts it matches `BuildCustomCaTransportError::InvalidCaFile`.

**Call relations**: This test covers the parse-failure path from `ConfiguredCaBundle::parse_certificates` through `maybe_build_rustls_client_config_with_env`.

*Call graph*: calls 1 internal fn (maybe_build_rustls_client_config_with_env); 4 external calls (new, assert!, map_env, write_cert_file).


### `codex-client/src/default_client.rs`

`io_transport` · `request construction and outbound HTTP send`

This file defines a thin HTTP client façade over `reqwest` with two concrete types: `CodexHttpClient`, which owns a cloneable `reqwest::Client`, and `CodexRequestBuilder`, which preserves the original HTTP `Method` and URL string alongside the underlying `reqwest::RequestBuilder`. The wrapper exists mainly to centralize cross-cutting behavior at send time. Builder-style methods such as `headers`, `header`, `bearer_auth`, `timeout`, `json`, and `body` all route through a private `map` helper so they transform only the inner builder while preserving the stored method/URL metadata for later logging.

The key behavior is in `CodexRequestBuilder::send`: before dispatching, it calls `trace_headers()` to collect the current tracing span’s OpenTelemetry propagation headers into an `http::HeaderMap`, merges those into the outgoing request, then awaits the reqwest send. Success and failure paths both emit `tracing::debug!` records with concrete request metadata; failures include any HTTP status embedded in the `reqwest::Error`. Trace propagation is implemented by `HeaderMapInjector`, an `opentelemetry::propagation::Injector` that inserts only headers whose names and values parse successfully, silently dropping malformed propagation entries rather than failing the request. The included test constructs a tracing subscriber with an OpenTelemetry layer and verifies that `trace_headers()` exports the current span context into W3C trace-context headers that can be extracted back unchanged.

#### Function details

##### `CodexHttpClient::new`  (lines 22–24)

```
fn new(inner: reqwest::Client) -> Self
```

**Purpose**: Constructs the Codex wrapper around an existing `reqwest::Client` without altering its configuration.

**Data flow**: Takes a fully built `reqwest::Client` as `inner` and stores it in the `CodexHttpClient { inner }` struct. It returns the wrapper by value and does not perform I/O or mutate external state.

**Call relations**: This is the entry constructor used wherever higher-level code has already configured a reqwest client and wants Codex request behavior layered on top. Callers such as client creation paths and timeout-focused tests invoke it before using `get`, `post`, or `request`.

*Call graph*: called by 3 (new, create_client, revoke_request_times_out).


##### `CodexHttpClient::get`  (lines 26–31)

```
fn get(&self, url: U) -> CodexRequestBuilder
```

**Purpose**: Starts building a GET request using the wrapped reqwest client.

**Data flow**: Accepts any `U: IntoUrl`, fixes the HTTP method to `Method::GET`, and forwards both to `self.request`. It returns a `CodexRequestBuilder` carrying the reqwest builder plus copied method/URL metadata.

**Call relations**: This is a convenience front-end for callers that need a GET without specifying the method explicitly. It delegates all actual builder creation to `CodexHttpClient::request`.

*Call graph*: calls 1 internal fn (request); called by 1 (hydrate_personal_access_token).


##### `CodexHttpClient::post`  (lines 33–38)

```
fn post(&self, url: U) -> CodexRequestBuilder
```

**Purpose**: Starts building a POST request using the wrapped reqwest client.

**Data flow**: Accepts any `U: IntoUrl`, fixes the method to `Method::POST`, and forwards to `self.request`. The returned `CodexRequestBuilder` can then be enriched with headers, auth, body, timeout, and finally sent.

**Call relations**: Used by token refresh and revoke flows that issue POSTs. Like `get`, it is only a convenience shim over `CodexHttpClient::request`.

*Call graph*: calls 1 internal fn (request); called by 2 (request_chatgpt_token_refresh, revoke_oauth_token).


##### `CodexHttpClient::request`  (lines 40–46)

```
fn request(&self, method: Method, url: U) -> CodexRequestBuilder
```

**Purpose**: Creates the underlying reqwest request builder and captures stable request metadata for later logging.

**Data flow**: Consumes a `Method` and `IntoUrl` input, derives a string form with `url.as_str().to_string()`, clones the method for reqwest, calls `self.inner.request(method.clone(), url)`, and wraps the result with `CodexRequestBuilder::new`. It returns the new builder object.

**Call relations**: This is the common construction path behind `get`, `post`, and transport-layer build logic. It delegates the final wrapper assembly to `CodexRequestBuilder::new` so all request starts share the same metadata capture.

*Call graph*: calls 1 internal fn (new); called by 3 (get, post, build); 3 external calls (clone, as_str, request).


##### `CodexRequestBuilder::new`  (lines 58–64)

```
fn new(builder: reqwest::RequestBuilder, method: Method, url: String) -> Self
```

**Purpose**: Packages a `reqwest::RequestBuilder` together with the request method and URL string that Codex wants to log later.

**Data flow**: Takes the raw reqwest builder, a `Method`, and a `String` URL, stores them in the `CodexRequestBuilder` fields, and returns the struct. No network work occurs here.

**Call relations**: Only `CodexHttpClient::request` calls this constructor, making it the single place where wrapped builders are instantiated.

*Call graph*: called by 1 (request).


##### `CodexRequestBuilder::map`  (lines 66–72)

```
fn map(self, f: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder) -> Self
```

**Purpose**: Implements the immutable builder pattern for all request customization methods while preserving stored metadata.

**Data flow**: Consumes `self` and a closure from `reqwest::RequestBuilder` to `reqwest::RequestBuilder`, applies the closure to `self.builder`, and rebuilds `CodexRequestBuilder` with the transformed builder and the original `method` and `url`. It returns the updated wrapper.

**Call relations**: All fluent modifier methods delegate here so they do not duplicate reconstruction logic. It is the internal backbone for `headers`, `header`, `bearer_auth`, `timeout`, `json`, and `body`.

*Call graph*: called by 6 (bearer_auth, body, header, headers, json, timeout).


##### `CodexRequestBuilder::headers`  (lines 74–76)

```
fn headers(self, headers: HeaderMap) -> Self
```

**Purpose**: Replaces or extends the outgoing request headers using an `http::HeaderMap`.

**Data flow**: Consumes `self` and a `HeaderMap`, passes them into `reqwest::RequestBuilder::headers` via `map`, and returns the updated `CodexRequestBuilder`.

**Call relations**: This is one of the fluent customization methods used by transport code after request preparation. It delegates the actual transformation to `CodexRequestBuilder::map`.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::header`  (lines 78–86)

```
fn header(self, key: K, value: V) -> Self
```

**Purpose**: Adds a single header to the outgoing request with generic key/value conversion matching reqwest’s API.

**Data flow**: Consumes `self`, a header key `K`, and value `V`; relies on `TryFrom` conversions into `HeaderName` and `HeaderValue`; applies `reqwest::RequestBuilder::header` through `map`; and returns the updated wrapper. Conversion failures are deferred to reqwest’s builder error handling semantics.

**Call relations**: Used when callers want to append one header rather than supply a whole map. Like the other modifiers, it is implemented entirely through `map`.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::bearer_auth`  (lines 88–93)

```
fn bearer_auth(self, token: T) -> Self
```

**Purpose**: Adds an `Authorization: Bearer ...` header using reqwest’s standard formatting.

**Data flow**: Consumes `self` and any `Display` token, applies `reqwest::RequestBuilder::bearer_auth` through `map`, and returns the updated builder wrapper.

**Call relations**: This is a fluent convenience method for authenticated requests. It delegates to `map` so metadata survives unchanged.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::timeout`  (lines 95–97)

```
fn timeout(self, timeout: Duration) -> Self
```

**Purpose**: Sets a per-request timeout on the underlying reqwest builder.

**Data flow**: Consumes `self` and a `Duration`, applies `reqwest::RequestBuilder::timeout` via `map`, and returns the updated wrapper.

**Call relations**: Transport code uses this when a `Request` carries a timeout. The method itself only delegates through `map`.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::json`  (lines 99–104)

```
fn json(self, value: &T) -> Self
```

**Purpose**: Serializes a value as JSON and configures the request body using reqwest’s JSON helper.

**Data flow**: Consumes `self` and a borrowed serializable value `&T`, passes it to `reqwest::RequestBuilder::json` through `map`, and returns the updated wrapper. Serialization is handled later by reqwest.

**Call relations**: Available to callers building requests directly through this wrapper. It shares the common `map` path with the other builder modifiers.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::body`  (lines 106–111)

```
fn body(self, body: B) -> Self
```

**Purpose**: Sets an arbitrary request body on the underlying reqwest builder.

**Data flow**: Consumes `self` and any `B: Into<reqwest::Body>`, converts through reqwest’s builder API inside `map`, and returns the updated wrapper.

**Call relations**: Used by transport code after body preparation has produced exact bytes. It delegates to `map` to preserve method/URL metadata.

*Call graph*: calls 1 internal fn (map).


##### `CodexRequestBuilder::send`  (lines 113–141)

```
async fn send(self) -> Result<Response, reqwest::Error>
```

**Purpose**: Injects trace propagation headers, sends the HTTP request, and logs either the completed response metadata or the failure details.

**Data flow**: Consumes the builder wrapper, calls `trace_headers()` to build a propagation `HeaderMap`, applies those headers to the underlying reqwest builder, and awaits `.send()`. On success it reads response status, headers, and HTTP version for a debug log and returns `Ok(Response)`; on error it extracts any embedded status for logging and returns `Err(reqwest::Error)` unchanged.

**Call relations**: This is the terminal operation for all requests built through this file. Higher-level transport methods call it after configuring timeout, headers, and body; internally it depends on `trace_headers` for tracing context injection.

*Call graph*: calls 1 internal fn (trace_headers); 2 external calls (headers, debug!).


##### `HeaderMapInjector::set`  (lines 147–154)

```
fn set(&mut self, key: &str, value: String)
```

**Purpose**: Implements OpenTelemetry header injection into an `http::HeaderMap`, inserting only syntactically valid header names and values.

**Data flow**: Receives a propagation key `&str` and value `String`, attempts `HeaderName::from_bytes` and `HeaderValue::from_str`, and if both succeed inserts the pair into the wrapped mutable `HeaderMap`. Invalid names or values are ignored with no error return.

**Call relations**: This method is invoked by the OpenTelemetry propagator during `trace_headers()`. Its permissive behavior prevents malformed propagation data from aborting request creation.

*Call graph*: 2 external calls (from_bytes, from_str).


##### `trace_headers`  (lines 157–166)

```
fn trace_headers() -> HeaderMap
```

**Purpose**: Extracts the current tracing span’s OpenTelemetry context into an HTTP header map suitable for outbound propagation.

**Data flow**: Creates an empty `HeaderMap`, asks `opentelemetry::global::get_text_map_propagator` for the active propagator, and calls `inject_context` with `Span::current().context()` and a `HeaderMapInjector` over the map. It returns the populated header map.

**Call relations**: Called immediately before sending requests so propagation reflects the current span at send time, not builder creation time. The unit test also calls it directly to verify context export behavior.

*Call graph*: called by 2 (send, inject_trace_headers_uses_current_span_context); 2 external calls (new, get_text_map_propagator).


##### `tests::inject_trace_headers_uses_current_span_context`  (lines 182–205)

```
fn inject_trace_headers_uses_current_span_context()
```

**Purpose**: Verifies that `trace_headers()` exports the currently entered tracing span’s trace and span IDs into standard trace-context headers.

**Data flow**: Installs a `TraceContextPropagator`, builds an OpenTelemetry-backed tracing subscriber, enters a `trace_span!`, captures that span’s context, calls `trace_headers()`, extracts a context back out of the produced headers via `HeaderMapExtractor`, and asserts the extracted context is valid and matches the original trace ID and span ID.

**Call relations**: This test exercises the full propagation path in-process: tracing span → `trace_headers` → header map → propagator extraction. It exists to guard the integration between tracing, OpenTelemetry, and the custom injector.

*Call graph*: calls 1 internal fn (trace_headers); 8 external calls (builder, new, assert!, assert_eq!, set_text_map_propagator, trace_span!, layer, registry).


##### `tests::HeaderMapExtractor::get`  (lines 210–212)

```
fn get(&self, key: &str) -> Option<&str>
```

**Purpose**: Provides OpenTelemetry extraction access to a single header value from an `http::HeaderMap` during tests.

**Data flow**: Takes a header key `&str`, looks it up in the wrapped `HeaderMap`, attempts UTF-8 conversion with `to_str`, and returns `Option<&str>`.

**Call relations**: The test propagator calls this while reconstructing a context from the headers produced by `trace_headers()`.


##### `tests::HeaderMapExtractor::keys`  (lines 214–216)

```
fn keys(&self) -> Vec<&str>
```

**Purpose**: Enumerates all header names in the wrapped map for OpenTelemetry extraction during tests.

**Data flow**: Iterates over `self.0.keys()`, converts each `HeaderName` to `&str` with `HeaderName::as_str`, collects them into a `Vec<&str>`, and returns it.

**Call relations**: Used by the propagator in the trace-header test so it can inspect all available header keys during extraction.


### `login/src/auth/default_client.rs`

`io_transport` · `startup and outbound HTTP request setup`

This file centralizes the default outbound HTTP identity for Codex requests. It defines process-global state for two pieces of metadata: an optional `Originator` override cached in `ORIGINATOR`, and an optional residency requirement cached in `REQUIREMENTS_RESIDENCY`. `USER_AGENT_SUFFIX` is a separate global used to append a parenthesized suffix to the generated user agent, primarily for MCP clients. The `Originator` struct stores both the raw string and a prevalidated `HeaderValue`, avoiding repeated parsing when headers are built.

The main flow is: compute an originator value from an environment override, an explicitly set default, or `DEFAULT_ORIGINATOR`; derive a Codex user agent string from package version, OS info, architecture, terminal-detection user agent, and optional suffix; sanitize that string if invalid header characters appear; then assemble a `HeaderMap` containing `originator`, `User-Agent`, and optionally `x-openai-internal-codex-residency`. Client construction uses those headers, disables proxies when `CODEX_SANDBOX=seatbelt`, installs the ChatGPT Cloudflare cookie store, and attempts to layer in custom CA certificates from shared `codex_client` helpers. A key design choice is compatibility: `build_reqwest_client` never fails outwardly. Structured CA-loading errors are available through `try_build_reqwest_client`, but the legacy path logs warnings and falls back first to a simpler builder and finally to `reqwest::Client::new()`.

#### Function details

##### `get_originator_value`  (lines 57–76)

```
fn get_originator_value(provided: Option<String>) -> Originator
```

**Purpose**: Computes the effective originator string and converts it into a reusable header-safe representation. It also hardens the result by falling back to the default originator if header parsing fails.

**Data flow**: It accepts an optional provided originator string, then reads `CODEX_INTERNAL_ORIGINATOR_OVERRIDE_ENV_VAR`; the environment value wins over the provided value, which wins over `DEFAULT_ORIGINATOR`. It attempts `HeaderValue::from_str` on the chosen string and returns an `Originator` containing both the original string and parsed header value; on parse failure it logs an error and returns a fallback `Originator` using `DEFAULT_ORIGINATOR` and `HeaderValue::from_static`.

**Call relations**: This is the shared normalization routine used both when explicitly initializing the global originator and when lazily resolving it for request headers.

*Call graph*: called by 2 (originator, set_default_originator); 4 external calls (from_static, from_str, var, error!).


##### `set_default_originator`  (lines 78–91)

```
fn set_default_originator(value: String) -> Result<(), SetOriginatorError>
```

**Purpose**: Initializes the process-wide default originator exactly once, rejecting invalid header values and repeated initialization.

**Data flow**: It takes an owned `String`, first validates it with `HeaderValue::from_str`, then derives the final `Originator` via `get_originator_value(Some(value))`. It writes that value into the `ORIGINATOR` `RwLock` only if the lock is obtainable and currently empty; otherwise it returns `SetOriginatorError::InvalidHeaderValue` or `SetOriginatorError::AlreadyInitialized`.

**Call relations**: Startup paths call this to pin the originator before clients are created. It delegates normalization to `get_originator_value` so environment overrides still take precedence over the provided string.

*Call graph*: calls 1 internal fn (get_originator_value); called by 2 (initialize, run_main); 1 external calls (from_str).


##### `set_default_client_residency_requirement`  (lines 93–99)

```
fn set_default_client_residency_requirement(enforce_residency: Option<ResidencyRequirement>)
```

**Purpose**: Stores the optional residency requirement that should be emitted on future default-client requests.

**Data flow**: It accepts `Option<ResidencyRequirement>`, acquires the `REQUIREMENTS_RESIDENCY` write lock, and replaces the cached value. If the lock cannot be acquired it logs a warning and leaves the previous state unchanged.

**Call relations**: Initialization and runtime sync code call this before requests are built; `default_headers` later reads the cached requirement to decide whether to add the residency header.

*Call graph*: called by 6 (sync_default_client_residency_requirement, initialize, run_main, run_main, run_main, run_ratatui_app); 1 external calls (warn!).


##### `originator`  (lines 101–120)

```
fn originator() -> Originator
```

**Purpose**: Returns the effective originator for this process, using cached state when available and lazily caching environment overrides.

**Data flow**: It first tries to read a previously initialized `Originator` from the `ORIGINATOR` lock and clones it if present. If not, it checks whether the override environment variable exists; when it does, it computes an originator with `get_originator_value(None)`, attempts to cache it under the write lock, and returns either the existing cached value or the newly computed one. Without any override, it simply returns a fresh default-derived `Originator` without caching.

**Call relations**: Many metadata and request-building paths depend on this function. It is the central read-side accessor that all header generation and user-agent construction flows go through.

*Call graph*: calls 1 internal fn (get_originator_value); called by 21 (codex_app_metadata, codex_plugin_metadata, ingest_skill_invoked, connectors_for_plugin_apps, merge_and_filter_plugin_connectors, merge_connectors_with_accessible, list_accessible_connectors_from_mcp_tools_with_mcp_manager, list_tool_suggest_discoverable_tools_with_auth, refresh_accessible_connectors_cache_from_mcp_tools, maybe_prompt_and_install_mcp_dependencies (+11 more)); 1 external calls (var).


##### `is_first_party_originator`  (lines 122–127)

```
fn is_first_party_originator(originator_value: &str) -> bool
```

**Purpose**: Recognizes originator strings that should be treated as first-party Codex clients.

**Data flow**: It takes a borrowed originator string and returns `true` if it equals `DEFAULT_ORIGINATOR`, `codex-tui`, `codex_vscode`, or begins with `Codex `; otherwise it returns `false`.

**Call relations**: Callers use this classification to gate behavior such as dependency prompts or trust decisions based on whether the request source is an official Codex surface.

*Call graph*: called by 1 (maybe_prompt_and_install_mcp_dependencies).


##### `is_first_party_chat_originator`  (lines 129–131)

```
fn is_first_party_chat_originator(originator_value: &str) -> bool
```

**Purpose**: Recognizes the narrower set of first-party chat-specific originators.

**Data flow**: It accepts an originator string and returns `true` only for `codex_atlas` or `codex_chatgpt_desktop`.

**Call relations**: Authorization and connector-selection code uses this helper when chat-originator-specific policy differs from the broader first-party set.

*Call graph*: called by 1 (is_connector_id_allowed_for_originator).


##### `get_codex_user_agent`  (lines 133–157)

```
fn get_codex_user_agent() -> String
```

**Purpose**: Constructs the canonical Codex `User-Agent` string, including originator, package version, OS details, terminal-detection metadata, and optional suffix.

**Data flow**: It reads the crate version from `env!("CARGO_PKG_VERSION")`, obtains OS/type/version/architecture from `os_info::get()`, fetches the current originator via `originator()`, and formats a base prefix string. It then reads `USER_AGENT_SUFFIX` under a mutex, trims and ignores empty values, appends a parenthesized suffix when present, and passes the candidate plus base prefix to `sanitize_user_agent`; the sanitized string is returned.

**Call relations**: This function feeds both direct callers that need the UA string and `default_headers`, which inserts it into outbound requests. It delegates validation and fallback behavior to `sanitize_user_agent`.

*Call graph*: calls 2 internal fn (originator, sanitize_user_agent); called by 5 (initialize, from_auth, init_backend, build_chatgpt_headers, default_headers); 3 external calls (env!, format!, get).


##### `sanitize_user_agent`  (lines 164–189)

```
fn sanitize_user_agent(candidate: String, fallback: &str) -> String
```

**Purpose**: Ensures the generated user-agent string is valid as an HTTP header value, replacing invalid characters or falling back when necessary.

**Data flow**: It takes a candidate UA string and a fallback base string. If `HeaderValue::from_str` accepts the candidate, it returns it unchanged. Otherwise it maps non-printable/non-ASCII-visible characters to underscores and retries; if that succeeds it logs a warning and returns the sanitized string. If sanitization still fails, it falls back to the provided base string when valid, or finally to `originator().value` after logging warnings.

**Call relations**: Only `get_codex_user_agent` calls this helper, making it the validation choke point for any globally configured suffix or unusual platform-derived UA content.

*Call graph*: calls 1 internal fn (originator); called by 1 (get_codex_user_agent); 2 external calls (from_str, warn!).


##### `create_client`  (lines 192–195)

```
fn create_client() -> CodexHttpClient
```

**Purpose**: Creates the shared high-level `CodexHttpClient` wrapper around the default reqwest client configuration.

**Data flow**: It takes no arguments, calls `build_reqwest_client()` to obtain a configured `reqwest::Client`, wraps it with `CodexHttpClient::new`, and returns the wrapper.

**Call relations**: Auth loading, token revocation, update checks, and other HTTP consumers call this convenience constructor when they want the standard Codex client identity and transport behavior.

*Call graph*: calls 2 internal fn (new, build_reqwest_client); called by 8 (send_track_events_request, chatgpt_get_request_with_timeout, create_dummy_chatgpt_auth_for_testing, from_auth_dot_json, load, revoke_auth_tokens, check_for_update, fetch_latest_github_release_version).


##### `build_reqwest_client`  (lines 203–216)

```
fn build_reqwest_client() -> reqwest::Client
```

**Purpose**: Builds the default reqwest client while preserving legacy infallible behavior through logged fallbacks.

**Data flow**: It calls `try_build_reqwest_client()`. On success it returns that client. On error it logs a warning, then tries a simpler `reqwest::Client::builder()` augmented only with the ChatGPT Cloudflare cookie store; if that build also fails it logs again and returns `reqwest::Client::new()`.

**Call relations**: Most ordinary HTTP call sites use this function rather than the fallible variant. It delegates the preferred construction path to `try_build_reqwest_client` and only handles compatibility fallbacks itself.

*Call graph*: calls 1 internal fn (try_build_reqwest_client); called by 38 (send_client_management_request_once, pairing_status, start_pairing, send_remote_control_server_request, http_get_probe_status_with_timeout, http_probe_url_with_timeout, fetch_plugin_detail, fetch_recommended_plugins, fetch_remote_plugin_skill_detail, get_remote_plugin_installed_page (+15 more)).


##### `try_build_reqwest_client`  (lines 222–230)

```
fn try_build_reqwest_client() -> Result<reqwest::Client, BuildCustomCaTransportError>
```

**Purpose**: Performs the full preferred reqwest-client construction and surfaces custom-CA failures to callers.

**Data flow**: It starts from `reqwest::Client::builder().default_headers(default_headers())`, conditionally applies `.no_proxy()` when `is_sandboxed()` is true, then wraps the builder with `with_chatgpt_cloudflare_cookie_store`. Finally it passes the builder to `build_reqwest_client_with_custom_ca` and returns that `Result<reqwest::Client, BuildCustomCaTransportError>`.

**Call relations**: This is the structured, fallible builder used internally by `build_reqwest_client`. It depends on `default_headers` for request identity and `is_sandboxed` for proxy policy.

*Call graph*: calls 2 internal fn (default_headers, is_sandboxed); called by 1 (build_reqwest_client); 3 external calls (builder, build_reqwest_client_with_custom_ca, with_chatgpt_cloudflare_cookie_store).


##### `default_headers`  (lines 232–248)

```
fn default_headers() -> HeaderMap
```

**Purpose**: Assembles the standard header set attached to default Codex HTTP clients and some direct protocol clients.

**Data flow**: It creates a fresh `HeaderMap`, inserts the `originator` header using `originator().header_value`, computes the user agent with `get_codex_user_agent()` and inserts it as `USER_AGENT` if it parses as a `HeaderValue`, then reads `REQUIREMENTS_RESIDENCY`; when a residency requirement is present and the header is not already set, it inserts `x-openai-internal-codex-residency` with the corresponding static value (`us`). It returns the populated map.

**Call relations**: Websocket setup and reqwest-client construction call this helper to ensure all outbound traffic shares the same identity headers and optional residency constraint.

*Call graph*: calls 2 internal fn (get_codex_user_agent, originator); called by 5 (websocket_reachability_check, connect_websocket, start_inner, spawn_webrtc_sideband_input_task, try_build_reqwest_client); 3 external calls (new, from_static, from_str).


##### `is_sandboxed`  (lines 250–252)

```
fn is_sandboxed() -> bool
```

**Purpose**: Detects the specific sandbox mode that requires disabling proxy use in the default HTTP client.

**Data flow**: It reads the `CODEX_SANDBOX` environment variable and returns `true` only when its value is exactly `seatbelt`.

**Call relations**: Only `try_build_reqwest_client` uses this helper, applying `.no_proxy()` when the process is running in that sandbox environment.

*Call graph*: called by 1 (try_build_reqwest_client); 1 external calls (var).


### Backend-facing service clients
These files apply the shared transport foundations to concrete authenticated clients for backend APIs, cloud tasks, remote config loading, ChatGPT helpers, and LM Studio.

### `backend-client/src/client.rs`

`io_transport` · `request handling`

This file defines the backend client used to talk to either Codex-style `/api/codex/...` endpoints or ChatGPT backend-api `/wham/...` endpoints. `PathStyle` selects between those URL schemes, with `Client::new` normalizing common ChatGPT hostnames by trimming trailing slashes and appending `/backend-api` when needed. The client stores a `reqwest::Client`, shared auth provider, optional user-agent, optional ChatGPT account id, optional FedRAMP routing flag, and the chosen path style.

Request plumbing is centralized in `headers`, `exec_request`, `exec_request_detailed`, and `decode_json`. `headers` always sets a user agent, injects auth headers from `SharedAuthProvider`, and conditionally adds `ChatGPT-Account-Id` and `X-OpenAI-Fedramp`. `exec_request` returns body and content type or raises an `anyhow` error with method, URL, status, content type, and body embedded; `exec_request_detailed` preserves non-success responses as structured `RequestError::UnexpectedStatus` instead. `decode_json` adds the same contextual detail on deserialization failures.

The API methods build concrete URLs based on `path_style`, attach headers, optionally add query parameters, and decode typed responses for accounts, token usage profile, tasks, sibling turns, config bundles, and task creation. `create_task` has a notable compatibility fallback: it first looks for `task.id` in the response JSON, then top-level `id`. The latter half of the file is pure mapping logic that converts backend rate-limit payloads into protocol-layer `RateLimitSnapshot`, `RateLimitWindow`, `CreditsSnapshot`, `SpendControlLimitSnapshot`, and `RateLimitReachedType`, including plan-type translation and minute rounding from seconds.

#### Function details

##### `RequestError::status`  (lines 46–51)

```
fn status(&self) -> Option<StatusCode>
```

**Purpose**: Extracts the HTTP status code from a structured backend request error when one exists. Non-HTTP wrapper errors return no status.

**Data flow**: Borrows `self`, matches on `RequestError`, returns `Some(status)` for `UnexpectedStatus` and `None` for `Other`.

**Call relations**: It is used by `RequestError::is_unauthorized` to classify auth failures.

*Call graph*: called by 1 (is_unauthorized).


##### `RequestError::is_unauthorized`  (lines 53–55)

```
fn is_unauthorized(&self) -> bool
```

**Purpose**: Reports whether the error corresponds to HTTP 401 Unauthorized. It is a convenience classifier for callers handling auth expiry or login prompts.

**Data flow**: Borrows `self`, calls `status()`, compares the result to `Some(StatusCode::UNAUTHORIZED)`, and returns a boolean.

**Call relations**: It builds directly on `RequestError::status`.

*Call graph*: calls 1 internal fn (status).


##### `RequestError::fmt`  (lines 59–73)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats backend request failures with detailed HTTP context or delegates to the wrapped error’s display text. This makes logs and surfaced errors include method, URL, status, content type, and body.

**Data flow**: Borrows `self` and a formatter; for `UnexpectedStatus` it writes a synthesized message containing method/url/status/content-type/body, and for `Other` it writes the inner error.

**Call relations**: This is trait plumbing used whenever `RequestError` is rendered.

*Call graph*: 1 external calls (write!).


##### `RequestError::source`  (lines 77–82)

```
fn source(&self) -> Option<&(dyn std::error::Error + 'static)>
```

**Purpose**: Exposes the underlying error source for wrapped non-HTTP failures. Structured unexpected-status errors intentionally have no source.

**Data flow**: Borrows `self`, returns `None` for `UnexpectedStatus` and `Some(err.as_ref())` for `Other`.

**Call relations**: This supports standard error chaining for callers inspecting `RequestError`.


##### `RequestError::from`  (lines 86–88)

```
fn from(err: anyhow::Error) -> Self
```

**Purpose**: Converts an `anyhow::Error` into `RequestError::Other`. It is the bridge used when JSON decoding or transport setup fails in APIs that return structured request errors.

**Data flow**: Consumes an `anyhow::Error` and wraps it in `RequestError::Other`.

**Call relations**: It is used, for example, when `get_config_bundle` maps `decode_json` failures into the file’s structured error type.

*Call graph*: 1 external calls (Other).


##### `PathStyle::from_base_url`  (lines 112–118)

```
fn from_base_url(base_url: &str) -> Self
```

**Purpose**: Infers whether a base URL should use Codex API paths or ChatGPT backend-api paths. The decision is based on whether the URL already contains `/backend-api`.

**Data flow**: Reads the input `base_url` string, checks for the substring `/backend-api`, and returns `PathStyle::ChatGptApi` if present or `PathStyle::CodexApi` otherwise.

**Call relations**: It is called by `Client::new` after base URL normalization.

*Call graph*: called by 1 (new).


##### `Client::fmt`  (lines 133–145)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the client for debugging while redacting the auth provider internals. It exposes routing-relevant fields but not credential contents.

**Data flow**: Borrows `self`, writes `base_url`, placeholder auth provider text, optional user agent, optional account id, FedRAMP flag, and path style into a `DebugStruct`, and returns the formatter result.

**Call relations**: This is trait plumbing for safe debug output of client instances.

*Call graph*: 1 external calls (debug_struct).


##### `Client::new`  (lines 149–175)

```
fn new(base_url: impl Into<String>) -> Result<Self>
```

**Purpose**: Constructs a backend client from a base URL, normalizing ChatGPT hostnames and building a reqwest client with custom CA and Cloudflare cookie-store support. It initializes the client unauthenticated by default.

**Data flow**: Consumes `base_url` into a `String`, strips trailing slashes in a loop, appends `/backend-api` for `chatgpt.com` or `chat.openai.com` URLs that lack it, builds a `reqwest::Client` via `build_reqwest_client_with_custom_ca(with_chatgpt_cloudflare_cookie_store(...))`, derives `path_style` with `PathStyle::from_base_url`, and returns a `Client` with default auth/user-agent/account-routing fields.

**Call relations**: It is the primary constructor used across the codebase and by tests. `Client::from_auth` builds on it, and many higher-level flows start by calling this constructor.

*Call graph*: calls 1 internal fn (from_base_url); called by 18 (websocket_transport_serves_health_endpoints_on_same_listener, test_client, test_client, new, models_client_hits_models_endpoint, responses_post_drains_request_body, revoke_request_times_out, cancels_previous_login_server_when_port_is_in_use, creates_missing_codex_home_dir, forced_chatgpt_workspace_id_mismatch_blocks_login (+8 more)); 10 external calls (contains, ends_with, into, pop, starts_with, builder, build_reqwest_client_with_custom_ca, with_chatgpt_cloudflare_cookie_store, unauthenticated_auth_provider, format!).


##### `Client::from_auth`  (lines 177–181)

```
fn from_auth(base_url: impl Into<String>, auth: &CodexAuth) -> Result<Self>
```

**Purpose**: Constructs a client preconfigured with the standard Codex user agent and an auth provider derived from `CodexAuth`. It is the authenticated convenience constructor.

**Data flow**: Consumes a base URL and borrows `CodexAuth`, creates a base client with `Client::new`, then applies `with_user_agent(get_codex_user_agent())` and `with_auth_provider(auth_provider_from_auth(auth))`, returning the configured client.

**Call relations**: It layers authentication and user-agent setup on top of `Client::new`.

*Call graph*: calls 1 internal fn (get_codex_user_agent); 2 external calls (new, auth_provider_from_auth).


##### `Client::with_auth_provider`  (lines 183–186)

```
fn with_auth_provider(mut self, auth: SharedAuthProvider) -> Self
```

**Purpose**: Replaces the client’s auth provider and returns the modified client for builder-style chaining.

**Data flow**: Consumes `self` mutably plus a `SharedAuthProvider`, assigns `self.auth_provider = auth`, and returns `self`.

**Call relations**: It is used by `Client::from_auth` and can be used by callers customizing auth behavior.


##### `Client::with_user_agent`  (lines 188–193)

```
fn with_user_agent(mut self, ua: impl Into<String>) -> Self
```

**Purpose**: Sets an explicit user-agent header value if the provided string is a valid HTTP header value. Invalid values are silently ignored, leaving the previous/default behavior intact.

**Data flow**: Consumes `self` mutably and a string-like input, converts it into `String`, attempts `HeaderValue::from_str`, stores `Some(hv)` on success, and returns `self`.

**Call relations**: It is used by `Client::from_auth` and by callers that want custom user-agent branding.

*Call graph*: 2 external calls (from_str, into).


##### `Client::with_chatgpt_account_id`  (lines 195–198)

```
fn with_chatgpt_account_id(mut self, account_id: impl Into<String>) -> Self
```

**Purpose**: Stores a ChatGPT account id to be emitted as a request header on subsequent calls. This supports account-scoped backend routing.

**Data flow**: Consumes `self` mutably and a string-like account id, converts it into `String`, stores it in `self.chatgpt_account_id`, and returns `self`.

**Call relations**: It participates in later header construction inside `Client::headers`.

*Call graph*: 1 external calls (into).


##### `Client::with_fedramp_routing_header`  (lines 200–203)

```
fn with_fedramp_routing_header(mut self) -> Self
```

**Purpose**: Enables emission of the FedRAMP routing header on future requests. It is a simple builder toggle.

**Data flow**: Consumes `self` mutably, sets `self.chatgpt_account_is_fedramp = true`, and returns `self`.

**Call relations**: Its effect is realized later in `Client::headers`.


##### `Client::with_path_style`  (lines 205–208)

```
fn with_path_style(mut self, style: PathStyle) -> Self
```

**Purpose**: Overrides the inferred path style for URL construction. This is mainly useful in tests or specialized callers that need explicit routing.

**Data flow**: Consumes `self` mutably, assigns `self.path_style = style`, and returns `self`.

**Call relations**: Subsequent endpoint methods consult `self.path_style` when building URLs.


##### `Client::headers`  (lines 210–230)

```
fn headers(&self) -> HeaderMap
```

**Purpose**: Builds the common request headers for all backend calls, including user agent, auth, optional ChatGPT account id, and optional FedRAMP routing. It centralizes per-request header policy.

**Data flow**: Reads `self.user_agent`, `self.auth_provider`, `self.chatgpt_account_id`, and `self.chatgpt_account_is_fedramp`. It creates a new `HeaderMap`, inserts either the configured user agent or `codex-cli`, asks the auth provider to mutate the map with auth headers, conditionally inserts `ChatGPT-Account-Id` if both header name and value parse successfully, conditionally inserts `X-OpenAI-Fedramp: true`, and returns the map.

**Call relations**: Nearly every HTTP API method calls this before constructing its request builder.

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

**Purpose**: Sends a request and returns the response body plus content type, failing with an `anyhow` error that includes full HTTP context on non-success statuses. It is the simpler execution path for APIs that do not need structured status inspection.

**Data flow**: Consumes a `reqwest::RequestBuilder` plus method and URL strings, awaits `send()`, reads status, content type header, and response text, and returns `(body, ct)` if `status.is_success()`. Otherwise it constructs an `anyhow` failure embedding method, URL, status, content type, and body.

**Call relations**: It is the common transport helper used by most typed API methods such as task, account, and profile fetches.

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

**Purpose**: Sends a request and preserves non-success HTTP responses as structured `RequestError::UnexpectedStatus` values. This is used where callers need to inspect status codes like 401.

**Data flow**: Consumes a `reqwest::RequestBuilder` plus method and URL strings, awaits `send()`, maps transport errors into `RequestError::Other`, reads status/content type/body, and returns `(body, content_type)` on success or `RequestError::UnexpectedStatus { method, url, status, content_type, body }` on failure.

**Call relations**: It is used by `get_config_bundle` and `send_add_credits_nudge_email`, the APIs that expose `RequestError` instead of plain `anyhow::Result`.

*Call graph*: called by 2 (get_config_bundle, send_add_credits_nudge_email); 1 external calls (send).


##### `Client::decode_json`  (lines 280–287)

```
fn decode_json(&self, url: &str, ct: &str, body: &str) -> Result<T>
```

**Purpose**: Deserializes a response body into a caller-specified type and enriches parse failures with URL, content type, and raw body context. It keeps decoding diagnostics close to the transport layer.

**Data flow**: Borrows `self`, a URL, content type, and body string; attempts `serde_json::from_str::<T>(body)`; returns the parsed value on success or an `anyhow` error containing the decode error and response context on failure.

**Call relations**: It is called after successful HTTP execution by typed endpoint methods and by `get_config_bundle` before mapping into `RequestError`.

*Call graph*: called by 3 (get_accounts_check, get_task_details_with_body, get_token_usage_profile); 1 external calls (bail!).


##### `Client::get_rate_limits`  (lines 289–296)

```
async fn get_rate_limits(&self) -> Result<RateLimitSnapshot>
```

**Purpose**: Returns a single preferred rate-limit snapshot, favoring the one whose `limit_id` is `codex`. If no such snapshot exists, it falls back to the first returned snapshot.

**Data flow**: Awaits `get_rate_limits_many()`, scans the resulting vector for a snapshot with `limit_id == Some("codex")`, clones that snapshot if found, otherwise clones index 0, and returns it.

**Call relations**: It is a convenience wrapper over `Client::get_rate_limits_many` for callers that only want the primary Codex limit.

*Call graph*: calls 1 internal fn (get_rate_limits_many).


##### `Client::get_rate_limits_many`  (lines 298–300)

```
async fn get_rate_limits_many(&self) -> Result<Vec<RateLimitSnapshot>>
```

**Purpose**: Returns all mapped rate-limit snapshots from the backend, including additional metered-feature limits. It strips off the reset-credit wrapper and exposes only the snapshot list.

**Data flow**: Awaits `get_rate_limits_with_reset_credits()` from the rate-limit-resets submodule and returns its `rate_limits` field.

**Call relations**: It is called by `Client::get_rate_limits`; the actual HTTP fetch happens in the submodule implementation.

*Call graph*: called by 1 (get_rate_limits).


##### `Client::get_accounts_check`  (lines 302–310)

```
async fn get_accounts_check(&self) -> Result<AccountsCheckResponse>
```

**Purpose**: Fetches the backend account-check payload from the path appropriate to the current path style. It is a typed GET endpoint wrapper.

**Data flow**: Builds either `/api/codex/accounts/check` or `/wham/accounts/check` under `self.base_url`, creates a GET request with `self.headers()`, executes it via `exec_request`, and deserializes the body into `AccountsCheckResponse` with `decode_json`.

**Call relations**: It uses the shared header, execution, and decode helpers defined earlier in the file.

*Call graph*: calls 3 internal fn (decode_json, exec_request, headers); 2 external calls (get, format!).


##### `Client::get_token_usage_profile`  (lines 312–317)

```
async fn get_token_usage_profile(&self) -> Result<TokenUsageProfile>
```

**Purpose**: Fetches the current token-usage profile for the authenticated user/account. The endpoint path depends on `path_style`.

**Data flow**: Computes the URL with `token_usage_profile_url()`, builds a GET request with common headers, executes it via `exec_request`, and decodes the body into `TokenUsageProfile`.

**Call relations**: It delegates URL construction to `Client::token_usage_profile_url` and transport work to the shared helpers.

*Call graph*: calls 4 internal fn (decode_json, exec_request, headers, token_usage_profile_url); 1 external calls (get).


##### `Client::token_usage_profile_url`  (lines 319–324)

```
fn token_usage_profile_url(&self) -> String
```

**Purpose**: Builds the token-usage profile endpoint URL for the current path style. It encapsulates the Codex-vs-WHAM path difference.

**Data flow**: Reads `self.path_style` and `self.base_url`, formats either `{base}/api/codex/profiles/me` or `{base}/wham/profiles/me`, and returns the string.

**Call relations**: It is used by `Client::get_token_usage_profile` and validated by tests.

*Call graph*: called by 1 (get_token_usage_profile); 1 external calls (format!).


##### `Client::send_add_credits_nudge_email`  (lines 326–339)

```
async fn send_add_credits_nudge_email(
        &self,
        credit_type: AddCreditsNudgeCreditType,
    ) -> std::result::Result<(), RequestError>
```

**Purpose**: POSTs a request asking the backend to send an add-credits nudge email for either credits or usage-limit exhaustion. It returns structured request errors so callers can inspect HTTP status.

**Data flow**: Builds the endpoint URL with `send_add_credits_nudge_email_url()`, creates a POST request with common headers and `content-type: application/json`, serializes `SendAddCreditsNudgeEmailRequest { credit_type }` as JSON, executes via `exec_request_detailed`, and returns `Ok(())` on success.

**Call relations**: It relies on `Client::headers`, `Client::send_add_credits_nudge_email_url`, and `Client::exec_request_detailed`.

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

**Purpose**: Fetches a paginated task list with optional limit, task filter, environment id, and cursor query parameters. It builds the query incrementally based on which options are present.

**Data flow**: Builds the list URL for the current path style, starts a GET request with common headers, conditionally adds `limit`, `task_filter`, `cursor`, and `environment_id` query pairs when each argument is `Some`, executes via `exec_request`, and decodes into `PaginatedListTaskListItem`.

**Call relations**: It is called by higher-level task-listing flows and uses the shared request helpers.

*Call graph*: calls 2 internal fn (exec_request, headers); called by 1 (list); 2 external calls (get, format!).


##### `Client::get_task_details`  (lines 377–380)

```
async fn get_task_details(&self, task_id: &str) -> Result<CodeTaskDetailsResponse>
```

**Purpose**: Fetches task details and returns only the parsed response object. It is a convenience wrapper over the variant that also exposes raw body and content type.

**Data flow**: Borrows `task_id`, awaits `get_task_details_with_body(task_id)`, discards the raw body and content type, and returns the parsed `CodeTaskDetailsResponse`.

**Call relations**: It is used by higher-level task-detail flows and delegates all transport work to `Client::get_task_details_with_body`.

*Call graph*: calls 1 internal fn (get_task_details_with_body); called by 1 (run).


##### `Client::get_task_details_with_body`  (lines 382–394)

```
async fn get_task_details_with_body(
        &self,
        task_id: &str,
    ) -> Result<(CodeTaskDetailsResponse, String, String)>
```

**Purpose**: Fetches task details and returns the parsed object together with the raw response body and content type. This supports callers that need both structured data and original payload context.

**Data flow**: Builds the task-details URL for the current path style and task id, creates a GET request with common headers, executes via `exec_request`, decodes the body into `CodeTaskDetailsResponse`, and returns `(parsed, body, ct)`.

**Call relations**: It underpins `Client::get_task_details` and any caller that needs raw response inspection.

*Call graph*: calls 3 internal fn (decode_json, exec_request, headers); called by 2 (get_task_details, details_with_body); 2 external calls (get, format!).


##### `Client::list_sibling_turns`  (lines 396–414)

```
async fn list_sibling_turns(
        &self,
        task_id: &str,
        turn_id: &str,
    ) -> Result<TurnAttemptsSiblingTurnsResponse>
```

**Purpose**: Fetches sibling turns for a given task and turn id. The endpoint path is nested under the task and turn resources.

**Data flow**: Formats the sibling-turns URL according to `path_style`, builds a GET request with common headers, executes via `exec_request`, and decodes into `TurnAttemptsSiblingTurnsResponse`.

**Call relations**: It is used by higher-level listing flows and shares the common transport helpers.

*Call graph*: calls 2 internal fn (exec_request, headers); called by 1 (list); 2 external calls (get, format!).


##### `Client::get_config_bundle`  (lines 420–431)

```
async fn get_config_bundle(
        &self,
    ) -> std::result::Result<ConfigBundleResponse, RequestError>
```

**Purpose**: Fetches the cloud-managed config bundle from the backend and returns structured request errors on HTTP failure. It is one of the endpoints where callers may need status-aware handling.

**Data flow**: Builds either `/api/codex/config/bundle` or `/wham/config/bundle`, creates a GET request with common headers, executes via `exec_request_detailed`, then decodes the body into `ConfigBundleResponse`, mapping any decode failure into `RequestError::Other`.

**Call relations**: It uses the detailed execution path rather than `exec_request` so callers can inspect non-success statuses.

*Call graph*: calls 2 internal fn (exec_request_detailed, headers); 2 external calls (get, format!).


##### `Client::create_task`  (lines 435–466)

```
async fn create_task(&self, request_body: serde_json::Value) -> Result<String>
```

**Purpose**: Creates a new backend task by POSTing arbitrary JSON and extracting the created task id from the response. It tolerates two response shapes for compatibility.

**Data flow**: Builds the create-task URL for the current path style, creates a POST request with common headers and JSON content type, serializes the provided `serde_json::Value`, executes via `exec_request`, parses the response body as generic JSON, then returns `task.id` if present, otherwise top-level `id`, otherwise an `anyhow` error containing response context.

**Call relations**: It is called by higher-level task-creation flows and uses the shared header/execution helpers plus custom response-shape extraction logic.

*Call graph*: calls 2 internal fn (exec_request, headers); called by 1 (create); 4 external calls (from_static, bail!, post, format!).


##### `Client::rate_limit_snapshots_from_payload`  (lines 469–505)

```
fn rate_limit_snapshots_from_payload(
        payload: RateLimitStatusPayload,
    ) -> Vec<RateLimitSnapshot>
```

**Purpose**: Transforms the backend’s rate-limit status payload into one primary `RateLimitSnapshot` plus zero or more additional snapshots for extra metered features. It also carries through plan type, credits, spend-control limit, and reached-type information.

**Data flow**: Consumes `RateLimitStatusPayload`, maps `plan_type`, flattens nested optional `rate_limit_reached_type`, extracts optional individual spend-control limit, constructs the primary `codex` snapshot via `make_rate_limit_snapshot`, then extends the vector with snapshots for each entry in `additional_rate_limits`, and returns the vector.

**Call relations**: It is used by `Client::get_rate_limits_with_reset_credits` in the submodule and heavily exercised by tests in this file.

*Call graph*: called by 4 (usage_payload_maps_every_rate_limit_reached_type, usage_payload_maps_primary_and_additional_rate_limits, usage_payload_maps_zero_rate_limit_when_primary_absent, usage_payload_preserves_absent_rate_limit_reached_type); 2 external calls (map_plan_type, vec!).


##### `Client::make_rate_limit_snapshot`  (lines 507–533)

```
fn make_rate_limit_snapshot(
        limit_id: Option<String>,
        limit_name: Option<String>,
        rate_limit: Option<crate::types::RateLimitStatusDetails>,
        credits: Option<crate::type
```

**Purpose**: Builds a single protocol-layer `RateLimitSnapshot` from backend rate-limit, credits, spend-control, plan, and reached-type components. It centralizes the field-by-field mapping logic.

**Data flow**: Consumes optional identifiers plus optional backend detail structs, maps primary and secondary windows through `map_rate_limit_window`, maps credits through `map_credits`, and returns a populated `RateLimitSnapshot` with the provided individual limit, plan type, and reached type.

**Call relations**: It is the internal constructor used by `Client::rate_limit_snapshots_from_payload` for both primary and additional snapshots.

*Call graph*: 2 external calls (map_credits, map_rate_limit_window).


##### `Client::map_rate_limit_reached_type`  (lines 535–556)

```
fn map_rate_limit_reached_type(
        kind: BackendRateLimitReachedKind,
    ) -> Option<RateLimitReachedType>
```

**Purpose**: Converts backend-specific rate-limit reached kinds into protocol-layer `RateLimitReachedType` values. Unknown backend values are intentionally dropped as `None`.

**Data flow**: Consumes a `BackendRateLimitReachedKind`, matches each known variant to the corresponding `RateLimitReachedType`, and returns `Option<RateLimitReachedType>`.

**Call relations**: It is used while mapping payloads in `Client::rate_limit_snapshots_from_payload`.


##### `Client::send_add_credits_nudge_email_url`  (lines 558–571)

```
fn send_add_credits_nudge_email_url(&self) -> String
```

**Purpose**: Builds the add-credits-nudge endpoint URL for the current path style. It encapsulates the Codex-vs-WHAM path difference for that POST route.

**Data flow**: Reads `self.path_style` and `self.base_url`, formats the appropriate endpoint string, and returns it.

**Call relations**: It is used by `Client::send_add_credits_nudge_email` and validated by tests.

*Call graph*: called by 1 (send_add_credits_nudge_email); 1 external calls (format!).


##### `Client::map_rate_limit_window`  (lines 573–586)

```
fn map_rate_limit_window(
        window: Option<Option<Box<crate::types::RateLimitWindowSnapshot>>>,
    ) -> Option<RateLimitWindow>
```

**Purpose**: Converts an optionally nested backend rate-limit window snapshot into the protocol-layer `RateLimitWindow`. It also rounds positive window lengths up to whole minutes.

**Data flow**: Consumes `Option<Option<Box<RateLimitWindowSnapshot>>>`, flattens and dereferences it, converts `used_percent` to `f64`, computes `window_minutes` via `window_minutes_from_seconds`, wraps `reset_at` as `Some(i64)`, and returns `Option<RateLimitWindow>`.

**Call relations**: It is used by `Client::make_rate_limit_snapshot` for both primary and secondary windows.

*Call graph*: 3 external calls (window_minutes_from_seconds, from, from).


##### `Client::map_credits`  (lines 588–596)

```
fn map_credits(credits: Option<crate::types::CreditStatusDetails>) -> Option<CreditsSnapshot>
```

**Purpose**: Converts backend credit-status details into the protocol-layer `CreditsSnapshot`. Missing credit details remain absent.

**Data flow**: Consumes `Option<CreditStatusDetails>`, returns `None` if absent, otherwise constructs `CreditsSnapshot` from `has_credits`, `unlimited`, and flattened `balance`.

**Call relations**: It is used by `Client::make_rate_limit_snapshot`.


##### `Client::map_individual_limit`  (lines 598–607)

```
fn map_individual_limit(
        details: crate::types::SpendControlLimitDetails,
    ) -> SpendControlLimitSnapshot
```

**Purpose**: Converts backend spend-control limit details into the protocol-layer `SpendControlLimitSnapshot`. It preserves the numeric strings and remaining percentage while normalizing reset time to `i64`.

**Data flow**: Consumes `SpendControlLimitDetails`, copies `limit`, `used`, and `remaining_percent`, converts `reset_at` to `i64`, and returns `SpendControlLimitSnapshot`.

**Call relations**: It is used by `Client::rate_limit_snapshots_from_payload` when spend-control data is present.

*Call graph*: 1 external calls (from).


##### `Client::map_plan_type`  (lines 609–632)

```
fn map_plan_type(plan_type: crate::types::PlanType) -> AccountPlanType
```

**Purpose**: Maps backend account plan variants into protocol-layer `AccountPlanType`. Several backend-only or unsupported variants collapse to `Unknown`.

**Data flow**: Consumes `crate::types::PlanType`, matches each variant, and returns the corresponding `AccountPlanType`.

**Call relations**: It is used during rate-limit payload mapping and covered by dedicated tests for usage-based business variants.


##### `Client::window_minutes_from_seconds`  (lines 634–641)

```
fn window_minutes_from_seconds(seconds: i32) -> Option<i64>
```

**Purpose**: Rounds a positive window length in seconds up to whole minutes, returning `None` for non-positive values. This normalizes backend window durations for protocol consumers.

**Data flow**: Consumes an `i32` seconds value; if `<= 0` returns `None`, otherwise converts to `i64`, computes `(seconds + 59) / 60`, and returns `Some(minutes)`.

**Call relations**: It is used by `Client::map_rate_limit_window`.

*Call graph*: 1 external calls (from).


##### `tests::map_plan_type_supports_usage_based_business_variants`  (lines 653–662)

```
fn map_plan_type_supports_usage_based_business_variants()
```

**Purpose**: Verifies that the two usage-based business backend plan variants map to their protocol equivalents rather than collapsing to unknown. This protects a subtle compatibility case.

**Data flow**: Calls `Client::map_plan_type` for `SelfServeBusinessUsageBased` and `EnterpriseCbpUsageBased` and asserts the expected `AccountPlanType` outputs.

**Call relations**: It targets specific branches in `Client::map_plan_type`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::usage_payload_maps_primary_and_additional_rate_limits`  (lines 665–771)

```
fn usage_payload_maps_primary_and_additional_rate_limits()
```

**Purpose**: Verifies full mapping of a rich backend usage payload containing primary and secondary windows, additional limits, credits, spend-control data, and a reached-type. It is the broadest end-to-end mapping test in the file.

**Data flow**: Constructs a nested `RateLimitStatusPayload` with populated fields, calls `Client::rate_limit_snapshots_from_payload`, and asserts the resulting snapshots contain the expected ids, windows, credits, plan type, reached type, and individual limit values.

**Call relations**: It exercises `rate_limit_snapshots_from_payload` and, indirectly, the helper mappers it uses.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 4 external calls (new, default, assert_eq!, vec!).


##### `tests::usage_payload_maps_zero_rate_limit_when_primary_absent`  (lines 774–795)

```
fn usage_payload_maps_zero_rate_limit_when_primary_absent()
```

**Purpose**: Verifies that the primary `codex` snapshot is still emitted even when the backend omits the main rate-limit details. This preserves a stable snapshot list shape.

**Data flow**: Builds a payload with no primary rate limit and one additional limit, maps it through `Client::rate_limit_snapshots_from_payload`, and asserts the primary snapshot exists with `None` windows while the additional snapshot is still present.

**Call relations**: It covers the branch where `make_rate_limit_snapshot` receives `None` for rate-limit details.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 2 external calls (assert_eq!, vec!).


##### `tests::preferred_snapshot_selection_matches_get_rate_limits_behavior`  (lines 798–836)

```
fn preferred_snapshot_selection_matches_get_rate_limits_behavior()
```

**Purpose**: Documents the selection rule used by `get_rate_limits`: prefer the snapshot whose `limit_id` is `codex`, otherwise use the first element. It tests the selection logic independently of HTTP fetching.

**Data flow**: Creates an array of two `RateLimitSnapshot` values, one non-codex and one codex, runs the same iterator/find/clone fallback logic used in `get_rate_limits`, and asserts the codex snapshot is chosen.

**Call relations**: It mirrors the in-method logic of `Client::get_rate_limits`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::usage_payload_maps_every_rate_limit_reached_type`  (lines 839–877)

```
fn usage_payload_maps_every_rate_limit_reached_type()
```

**Purpose**: Verifies mapping for every backend `RateLimitReachedKind` variant, including the `Unknown` case mapping to `None`. This guards the enum translation table.

**Data flow**: Iterates over backend kind/expected-output pairs, constructs a minimal payload for each, maps it through `Client::rate_limit_snapshots_from_payload`, and asserts the first snapshot’s `rate_limit_reached_type` matches expectation.

**Call relations**: It exercises all branches of `Client::map_rate_limit_reached_type` through the higher-level payload mapper.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 1 external calls (assert_eq!).


##### `tests::usage_payload_preserves_absent_rate_limit_reached_type`  (lines 880–892)

```
fn usage_payload_preserves_absent_rate_limit_reached_type()
```

**Purpose**: Verifies that a completely absent reached-type field remains absent after mapping. This distinguishes missing data from an explicit known enum value.

**Data flow**: Builds a payload with `rate_limit_reached_type: None`, maps it through `Client::rate_limit_snapshots_from_payload`, and asserts the resulting snapshot has `None` for `rate_limit_reached_type`.

**Call relations**: It covers the nested-optional flattening behavior in `Client::rate_limit_snapshots_from_payload`.

*Call graph*: calls 1 internal fn (rate_limit_snapshots_from_payload); 1 external calls (assert_eq!).


##### `tests::add_credits_nudge_email_uses_expected_paths_and_bodies`  (lines 895–922)

```
fn add_credits_nudge_email_uses_expected_paths_and_bodies()
```

**Purpose**: Verifies endpoint URL construction and JSON serialization for the add-credits-nudge email API under both path styles. It also checks enum serialization names.

**Data flow**: Builds test clients for Codex and ChatGPT path styles, asserts `send_add_credits_nudge_email_url()` outputs, serializes `SendAddCreditsNudgeEmailRequest` for both enum variants, and asserts the resulting JSON values.

**Call relations**: It validates `Client::send_add_credits_nudge_email_url` and the request payload shape used by `Client::send_add_credits_nudge_email`.

*Call graph*: 2 external calls (assert_eq!, test_client).


##### `tests::token_usage_profile_uses_expected_paths`  (lines 925–937)

```
fn token_usage_profile_uses_expected_paths()
```

**Purpose**: Verifies token-usage profile URL construction for both Codex and ChatGPT path styles. This protects the path-style routing split.

**Data flow**: Builds test clients for both path styles, calls `token_usage_profile_url()`, and asserts the exact URLs.

**Call relations**: It directly tests `Client::token_usage_profile_url`.

*Call graph*: 2 external calls (assert_eq!, test_client).


##### `tests::test_client`  (lines 939–949)

```
fn test_client(base_url: &str, path_style: PathStyle) -> Client
```

**Purpose**: Builds a minimal client fixture with a plain reqwest client and unauthenticated auth provider. It avoids the heavier constructor path in tests that only need URL or mapping behavior.

**Data flow**: Consumes a base URL and `PathStyle`, constructs a `Client` with those values plus `reqwest::Client::new()`, unauthenticated auth provider, and default optional fields, and returns it.

**Call relations**: It is a shared fixture for URL-construction tests in this file.

*Call graph*: calls 1 internal fn (new); 1 external calls (unauthenticated_auth_provider).


### `chatgpt/src/chatgpt_client.rs`

`io_transport` · `authenticated backend request handling`

This file is the transport shim used by ChatGPT-specific features elsewhere in the crate. `chatgpt_get_request` is a convenience wrapper that forwards to `chatgpt_get_request_with_timeout` with no explicit timeout. The main function, `chatgpt_get_request_with_timeout`, performs both auth validation and HTTP execution.

It begins by reading `config.chatgpt_base_url` and obtaining a shared `AuthManager` from the current config with Codex API key env support disabled. It then requires a present auth session, verifies that the auth uses the Codex backend, and requires a non-empty account id; otherwise it returns explicit `anyhow` errors instructing the user to log in again. Once auth is validated, it creates the default HTTP client, joins the base URL and requested path while trimming duplicate slashes, and builds a GET request with auth headers from `codex_model_provider::auth_provider_from_auth`, the `OAI-Product-Sku: codex` header, and JSON content type. An optional timeout is applied per request.

After sending, success responses are parsed as JSON into generic `T: DeserializeOwned`; parse and send failures are wrapped with context strings. Non-success statuses are not silently ignored: the function reads the response body as text and returns an error containing both HTTP status and body, which is important for debugging backend failures.

#### Function details

##### `chatgpt_get_request`  (lines 13–18)

```
async fn chatgpt_get_request(
    config: &Config,
    path: String,
) -> anyhow::Result<T>
```

**Purpose**: Issues a ChatGPT backend GET request using the default timeout behavior. It is a thin convenience wrapper around the timeout-capable variant.

**Data flow**: It takes a `Config` reference and request path string, forwards both to `chatgpt_get_request_with_timeout(config, path, None).await`, and returns the deserialized `T` or propagated error.

**Call relations**: Called by `get_task` for standard task fetches. It exists so most callers do not need to mention timeout handling explicitly.

*Call graph*: calls 1 internal fn (chatgpt_get_request_with_timeout); called by 1 (get_task).


##### `chatgpt_get_request_with_timeout`  (lines 20–72)

```
async fn chatgpt_get_request_with_timeout(
    config: &Config,
    path: String,
    timeout: Option<Duration>,
) -> anyhow::Result<T>
```

**Purpose**: Builds and sends an authenticated GET request to the ChatGPT backend, optionally with a timeout, and deserializes a successful JSON response. It also enforces that the current auth session is a Codex-backend ChatGPT session with an account id.

**Data flow**: It takes `config`, a relative path, and `Option<Duration>`. It reads `config.chatgpt_base_url`, obtains `AuthManager::shared_from_config`, awaits `auth_manager.auth()`, validates auth presence, backend type, and account id, creates an HTTP client, formats the full URL by trimming slashes, and builds a GET request with auth headers, `OAI-Product-Sku`, and `Content-Type`. If `timeout` is `Some`, it applies it to the request. It sends the request, and on success parses JSON into `T`; on failure status it reads the body text and returns an error containing status and body.

**Call relations**: Used directly by `codex_plugins_enabled_for_workspace` and indirectly by `get_task` through `chatgpt_get_request`. It is the shared transport primitive for ChatGPT backend reads in this crate.

*Call graph*: calls 2 internal fn (create_client, shared_from_config); called by 2 (chatgpt_get_request, codex_plugins_enabled_for_workspace); 4 external calls (bail!, ensure!, auth_provider_from_auth, format!).


### `cloud-tasks-client/src/http.rs`

`io_transport` · `request handling`

This file contains the production transport implementation for cloud tasks. `HttpClient` wraps a `codex_backend_client::Client` plus the configured `base_url`, exposes builder-style mutators for user agent, auth provider, and ChatGPT account ID, and implements `CloudBackend` by boxing async calls into helper sub-APIs. Those helpers split responsibilities into `api::Tasks` for listing/details/creation, `api::Attempts` for sibling-turn enumeration, and `api::Apply` for local patch application.

The task path is intentionally defensive. Detail fetches use `details_with_body` so callers can inspect both parsed extension methods (`unified_diff`, `assistant_text_messages`, `user_text_prompt`) and the raw JSON body when fields are missing. Summary construction merges metadata from `task`, `task_status_display`, and fallback diff parsing; timestamps fall back from `updated_at` to `created_at` to latest turn timestamps, and diff stats fall back from structured counters to line-by-line unified diff parsing.

Attempt handling extracts diffs and assistant messages from loosely typed `serde_json::Value` maps, then sorts attempts by placement, timestamp, and finally turn ID. Apply logic is local rather than remote: it fetches or accepts a diff override, rejects non-unified patch formats up front, invokes `apply_git_patch`, derives `Success`/`Partial`/`Error` from exit code and path lists, and emits detailed diagnostics to `error.log` including stdout/stderr tails and the full patch on failures. Logging is pervasive but best-effort: `append_error_log` silently ignores file-open/write errors.

#### Function details

##### `HttpClient::new`  (lines 31–35)

```
fn new(base_url: impl Into<String>) -> anyhow::Result<Self>
```

**Purpose**: Builds a new HTTP cloud-tasks client from a base URL and initializes the underlying backend client against that same endpoint.

**Data flow**: It takes any `Into<String>` base URL, converts it into an owned `String`, passes a clone into `backend::Client::new`, and returns `Ok(HttpClient { base_url, backend })` on success. Backend-construction failures are propagated as `anyhow::Result` errors.

**Call relations**: This is the constructor used during backend initialization before auth and user-agent customization are layered on. After creation, callers typically chain `with_user_agent`, `with_auth_provider`, and `with_chatgpt_account_id` before the instance is wrapped behind `CloudBackend`.

*Call graph*: calls 1 internal fn (new); called by 1 (init_backend); 2 external calls (clone, into).


##### `HttpClient::with_user_agent`  (lines 37–40)

```
fn with_user_agent(mut self, ua: impl Into<String>) -> Self
```

**Purpose**: Returns a modified client whose underlying backend client sends a custom user-agent string.

**Data flow**: It consumes `self`, clones the embedded backend client, applies `with_user_agent` to that clone, stores the result back into `self.backend`, and returns the updated `HttpClient`. The `base_url` is preserved unchanged.

**Call relations**: This is a builder step used immediately after construction when startup code wants requests tagged with the Codex user agent. It delegates the actual header behavior to the backend client implementation.

*Call graph*: 1 external calls (clone).


##### `HttpClient::with_auth_provider`  (lines 42–45)

```
fn with_auth_provider(mut self, auth: SharedAuthProvider) -> Self
```

**Purpose**: Attaches an authentication provider to the backend client so subsequent HTTP requests carry ChatGPT/Codex auth.

**Data flow**: It takes ownership of `self` and a `SharedAuthProvider`, clones the current backend client, applies `with_auth_provider(auth)`, writes the updated backend back into the struct, and returns the modified client.

**Call relations**: Startup code invokes this after loading auth state. It is purely a wiring step; all later task and attempt requests rely on the backend client configured here.

*Call graph*: 1 external calls (clone).


##### `HttpClient::with_chatgpt_account_id`  (lines 47–50)

```
fn with_chatgpt_account_id(mut self, account_id: impl Into<String>) -> Self
```

**Purpose**: Configures the backend client to send a specific ChatGPT account identifier with requests.

**Data flow**: It consumes `self`, converts the provided account ID into a string inside the backend builder call, replaces `self.backend` with the configured clone, and returns the updated client.

**Call relations**: This is another optional builder-stage customization used when auth exposes an account ID. It affects all later API calls indirectly through the backend client.

*Call graph*: 1 external calls (clone).


##### `HttpClient::tasks_api`  (lines 52–54)

```
fn tasks_api(&self) -> api::Tasks<'_>
```

**Purpose**: Creates a lightweight `api::Tasks` view borrowing this client’s base URL and backend client.

**Data flow**: It reads `self.base_url` and `self.backend` and packages references to them into a new `api::Tasks<'_>` value. No state is mutated.

**Call relations**: All task-oriented `CloudBackend` methods route through this helper before calling `list`, `summary`, `diff`, `messages`, `task_text`, or `create`. It centralizes the borrow setup for those operations.

*Call graph*: called by 6 (create_task, get_task_diff, get_task_messages, get_task_summary, get_task_text, list_tasks); 1 external calls (new).


##### `HttpClient::attempts_api`  (lines 56–58)

```
fn attempts_api(&self) -> api::Attempts<'_>
```

**Purpose**: Creates a borrowed `api::Attempts` helper for sibling-attempt queries.

**Data flow**: It reads the embedded backend client reference and returns `api::Attempts::new(self)`. No mutation or I/O occurs here.

**Call relations**: The `CloudBackend::list_sibling_attempts` implementation uses this helper to reach the attempt-listing logic.

*Call graph*: called by 1 (list_sibling_attempts); 1 external calls (new).


##### `HttpClient::apply_api`  (lines 60–62)

```
fn apply_api(&self) -> api::Apply<'_>
```

**Purpose**: Creates a borrowed `api::Apply` helper for local patch application and preflight checks.

**Data flow**: It reads the backend client reference from `self` and returns a new `api::Apply<'_>` wrapper. It has no side effects.

**Call relations**: Both `apply_task` and `apply_task_preflight` delegate through this helper to share the same patch-fetching and git-apply logic.

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

**Purpose**: Implements the trait method by boxing an async call that fetches one page of task summaries.

**Data flow**: It accepts optional environment, limit, and cursor parameters, captures them in an async block, invokes `self.tasks_api().list(...)`, and returns a pinned future yielding `Result<TaskListPage>`. It does not itself perform the HTTP request until awaited.

**Call relations**: Callers use this through the `CloudBackend` trait. The future delegates all real work to `api::Tasks::list`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_summary`  (lines 75–77)

```
fn get_task_summary(&self, id: TaskId) -> CloudBackendFuture<'_, TaskSummary>
```

**Purpose**: Boxes an async request that loads and maps a single task’s summary metadata.

**Data flow**: It takes a `TaskId`, captures it in an async block, calls `self.tasks_api().summary(id).await`, and returns a pinned future producing `Result<TaskSummary>`.

**Call relations**: Trait consumers invoke this when they need status/title/diff-summary metadata for one task. The mapping logic lives in `api::Tasks::summary`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_diff`  (lines 79–81)

```
fn get_task_diff(&self, id: TaskId) -> CloudBackendFuture<'_, Option<String>>
```

**Purpose**: Boxes an async request that retrieves the unified diff for a task when present.

**Data flow**: It captures the provided `TaskId`, calls `self.tasks_api().diff(id).await` inside an async block, and returns a pinned future yielding `Result<Option<String>>`.

**Call relations**: Used by CLI and TUI detail flows through the `CloudBackend` trait. It delegates extraction and fallback behavior to `api::Tasks::diff`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_messages`  (lines 83–85)

```
fn get_task_messages(&self, id: TaskId) -> CloudBackendFuture<'_, Vec<String>>
```

**Purpose**: Boxes an async request that retrieves assistant text messages for a task without diff content.

**Data flow**: It takes a `TaskId`, invokes `self.tasks_api().messages(id).await` inside a boxed async block, and returns a future yielding `Result<Vec<String>>`.

**Call relations**: This trait method is used when callers want textual assistant output. The actual extraction path is implemented in `api::Tasks::messages`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::get_task_text`  (lines 87–89)

```
fn get_task_text(&self, id: TaskId) -> CloudBackendFuture<'_, TaskText>
```

**Purpose**: Boxes an async request that retrieves the creating prompt, assistant messages, and attempt metadata for a task.

**Data flow**: It captures the `TaskId`, awaits `self.tasks_api().task_text(id)`, and returns a pinned future yielding `Result<TaskText>`.

**Call relations**: Higher layers use this for richer detail views and attempt navigation. It delegates parsing to `api::Tasks::task_text`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `HttpClient::list_sibling_attempts`  (lines 91–97)

```
fn list_sibling_attempts(
        &self,
        task: TaskId,
        turn_id: String,
    ) -> CloudBackendFuture<'_, Vec<TurnAttempt>>
```

**Purpose**: Boxes an async request that fetches alternate assistant attempts for a given task turn.

**Data flow**: It takes a `TaskId` and `turn_id`, captures them in an async block, calls `self.attempts_api().list(task, turn_id).await`, and returns a future yielding `Result<Vec<TurnAttempt>>`.

**Call relations**: This is invoked after task text reveals sibling turn IDs. The sorting and extraction logic lives in `api::Attempts::list`.

*Call graph*: calls 1 internal fn (attempts_api); 1 external calls (pin).


##### `HttpClient::apply_task`  (lines 99–109)

```
fn apply_task(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Boxes an async operation that applies a task’s diff locally to the working tree.

**Data flow**: It accepts a task ID and optional diff override, then awaits `self.apply_api().run(id, diff_override, false)` inside a boxed future. The returned `ApplyOutcome` reflects actual application, not dry-run validation.

**Call relations**: CLI and TUI apply actions call this through the trait. It shares implementation with preflight via `api::Apply::run`.

*Call graph*: calls 1 internal fn (apply_api); 1 external calls (pin).


##### `HttpClient::apply_task_preflight`  (lines 111–121)

```
fn apply_task_preflight(
        &self,
        id: TaskId,
        diff_override: Option<String>,
    ) -> CloudBackendFuture<'_, ApplyOutcome>
```

**Purpose**: Boxes an async dry-run patch validation for a task diff without modifying the working tree.

**Data flow**: It takes a task ID and optional diff override, calls `self.apply_api().run(id, diff_override, true)` in an async block, and returns a future yielding `Result<ApplyOutcome>`.

**Call relations**: Used before actual apply to surface skipped/conflicting paths. It differs from `apply_task` only by the `preflight` flag passed into shared apply logic.

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

**Purpose**: Boxes an async request that submits a new cloud task with environment, prompt, branch, QA mode, and best-of-N settings.

**Data flow**: It captures borrowed `env_id`, `prompt`, and `git_ref` plus `qa_mode` and `best_of_n`, awaits `self.tasks_api().create(...)`, and returns a future yielding `Result<CreatedTask>`.

**Call relations**: CLI exec and TUI new-task submission use this trait method. Request-body construction and logging are delegated to `api::Tasks::create`.

*Call graph*: calls 1 internal fn (tasks_api); 1 external calls (pin).


##### `api::Tasks::new`  (lines 151–156)

```
fn new(client: &'a HttpClient) -> Self
```

**Purpose**: Builds a borrowed task-API helper from an `HttpClient`.

**Data flow**: It reads `client.base_url` and `client.backend` and stores references to them in a `Tasks<'a>` struct. No allocation beyond the wrapper itself and no I/O occur.

**Call relations**: This helper is created by `HttpClient::tasks_api` before any task-listing, detail, or creation operation.


##### `api::Tasks::list`  (lines 158–191)

```
async fn list(
            &self,
            env: Option<&str>,
            limit: Option<i64>,
            cursor: Option<&str>,
        ) -> Result<TaskListPage>
```

**Purpose**: Fetches one page of tasks from the backend, converts each backend list item into a `TaskSummary`, and records a diagnostic log entry.

**Data flow**: It takes optional environment, limit, and cursor inputs; converts `limit` from `i64` to `Option<i32>` when possible; calls `backend.list_tasks(limit_i32, Some("current"), env, cursor)`; maps each returned `backend::TaskListItem` through `map_task_list_item_to_summary`; logs env/limit/cursor/item-count to `error.log`; and returns `TaskListPage { tasks, cursor: resp.cursor }`. HTTP failures are wrapped as `CloudTaskError::Http`.

**Call relations**: This is the concrete implementation behind `HttpClient::list_tasks`. It delegates per-item mapping to `map_task_list_item_to_summary` and logging to `append_error_log`.

*Call graph*: calls 2 internal fn (list_tasks, append_error_log); 1 external calls (format!).


##### `api::Tasks::summary`  (lines 193–260)

```
async fn summary(&self, id: TaskId) -> Result<TaskSummary>
```

**Purpose**: Loads full task details, decodes raw JSON metadata, and synthesizes a `TaskSummary` with status, timestamps, environment info, diff stats, review flag, and attempt count.

**Data flow**: It takes a `TaskId`, fetches `(details, body, content-type)` via `details_with_body`, parses `body` as `serde_json::Value`, extracts the `task` object and optional `task_status_display`, computes `TaskStatus` via `map_status`, computes `DiffSummary` from structured stats or falls back to parsing `details.unified_diff()`, derives `updated_at` from task timestamps or latest turn timestamps, reads `environment_id`, `environment_label`, `attempt_total`, `title`, and `is_review`, then returns a populated `TaskSummary`. Missing metadata or JSON decode failures become `CloudTaskError::Http` with the raw body embedded for debugging.

**Call relations**: This powers `HttpClient::get_task_summary`. It relies on `details_with_body` for transport, then delegates specific field derivations to `map_status`, `diff_summary_from_status_display`, `diff_summary_from_diff`, `latest_turn_timestamp`, `env_label_from_status_display`, `attempt_total_from_status_display`, and `parse_updated_at`.

*Call graph*: calls 1 internal fn (details_with_body); 7 external calls (attempt_total_from_status_display, diff_summary_from_diff, diff_summary_from_status_display, env_label_from_status_display, map_status, parse_updated_at, from_str).


##### `api::Tasks::diff`  (lines 262–272)

```
async fn diff(&self, id: TaskId) -> Result<Option<String>>
```

**Purpose**: Retrieves task details and returns the unified diff if the parsed backend response exposes one.

**Data flow**: It takes a `TaskId`, fetches details/body/content-type via `details_with_body`, checks `details.unified_diff()`, and returns `Ok(Some(diff))` when present or `Ok(None)` otherwise. Transport failures are converted into `CloudTaskError::Http`.

**Call relations**: This is the implementation behind `HttpClient::get_task_diff`. It intentionally ignores the raw body unless needed for debugging elsewhere.

*Call graph*: calls 1 internal fn (details_with_body).


##### `api::Tasks::messages`  (lines 274–298)

```
async fn messages(&self, id: TaskId) -> Result<Vec<String>>
```

**Purpose**: Extracts assistant text output from task details, falling back to raw-body JSON traversal and finally to a synthesized failure message when the assistant turn contains an error.

**Data flow**: It fetches details/body/content-type, starts with `details.assistant_text_messages()`, falls back to `extract_assistant_messages_from_body(&body)` if empty, returns those messages if any exist, otherwise checks `details.assistant_error_message()` and returns a single `Task failed: ...` string, and if still empty constructs a detailed `CloudTaskError::Http` including the inferred details URL, content type, and raw body.

**Call relations**: This backs `HttpClient::get_task_messages`. It delegates URL formatting to `details_path` and raw JSON scraping to `extract_assistant_messages_from_body`.

*Call graph*: calls 1 internal fn (details_with_body); 5 external calls (Http, details_path, extract_assistant_messages_from_body, format!, vec!).


##### `api::Tasks::task_text`  (lines 300–327)

```
async fn task_text(&self, id: TaskId) -> Result<TaskText>
```

**Purpose**: Builds a rich `TaskText` object containing the user prompt, assistant messages, and current attempt metadata from task details.

**Data flow**: It fetches details/body, reads `prompt` from `details.user_text_prompt()`, gathers assistant messages from parsed details or raw-body fallback, inspects `details.current_assistant_turn` for `turn_id`, `sibling_turn_ids`, `attempt_placement`, and `turn_status`, maps the status string through `attempt_status_from_str`, and returns a `TaskText` struct.

**Call relations**: This is the implementation behind `HttpClient::get_task_text`. It is used by higher layers that need both conversation text and attempt navigation metadata.

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

**Purpose**: Constructs the backend JSON payload for a new task submission, optionally injects a starting diff from the environment, adds best-of-N metadata when needed, submits the request, and logs success or failure.

**Data flow**: It takes `env_id`, `prompt`, `git_ref`, `qa_mode`, and `best_of_n`; builds `input_items` starting with a user text message; conditionally appends a `pre_apply_patch` item from `CODEX_STARTING_DIFF`; builds a `new_task` JSON object with environment, branch, and QA mode; inserts `metadata.best_of_n` when `best_of_n > 1`; calls `backend.create_task(request_body)`; logs either the created ID or the failure with prompt length; and returns `CreatedTask { id: TaskId(id) }` or `CloudTaskError::Http`.

**Call relations**: This powers `HttpClient::create_task`. It is the only place in this file that shapes outbound task-creation JSON.

*Call graph*: calls 2 internal fn (create_task, append_error_log); 6 external calls (new, Http, new, format!, json!, var).


##### `api::Tasks::details_with_body`  (lines 392–398)

```
async fn details_with_body(
            &self,
            id: &str,
        ) -> anyhow::Result<(backend::CodeTaskDetailsResponse, String, String)>
```

**Purpose**: Fetches task details while preserving both the parsed response object and the raw response body/content type.

**Data flow**: It takes a task ID string, awaits `backend.get_task_details_with_body(id)`, and returns the parsed `CodeTaskDetailsResponse`, raw body string, and content-type string as a tuple inside `anyhow::Result`.

**Call relations**: This helper is shared by summary, diff, messages, and task-text retrieval so those paths can combine extension-method access with raw-body diagnostics and fallback parsing.

*Call graph*: calls 1 internal fn (get_task_details_with_body); called by 4 (diff, messages, summary, task_text).


##### `api::Attempts::new`  (lines 406–410)

```
fn new(client: &'a HttpClient) -> Self
```

**Purpose**: Builds a borrowed attempts-API helper from an `HttpClient`.

**Data flow**: It reads the client’s backend reference and stores it in an `Attempts<'a>` wrapper. No I/O or mutation occurs.

**Call relations**: Created by `HttpClient::attempts_api` before sibling-attempt listing.


##### `api::Attempts::list`  (lines 412–426)

```
async fn list(&self, task: TaskId, turn_id: String) -> Result<Vec<TurnAttempt>>
```

**Purpose**: Fetches sibling turns for a task turn, converts each raw map into a `TurnAttempt`, sorts them into display order, and returns the resulting list.

**Data flow**: It takes a `TaskId` and `turn_id`, calls `backend.list_sibling_turns(&task.0, &turn_id)`, iterates `resp.sibling_turns`, converts each map with `turn_attempt_from_map`, sorts the resulting vector with `compare_attempts`, and returns it. Backend failures become `CloudTaskError::Http`.

**Call relations**: This is the concrete implementation behind `HttpClient::list_sibling_attempts`. It delegates extraction and ordering to `turn_attempt_from_map` and `compare_attempts`.

*Call graph*: calls 1 internal fn (list_sibling_turns).


##### `api::Apply::new`  (lines 434–438)

```
fn new(client: &'a HttpClient) -> Self
```

**Purpose**: Builds a borrowed apply-API helper from an `HttpClient`.

**Data flow**: It stores a reference to the client’s backend in an `Apply<'a>` wrapper. No side effects occur.

**Call relations**: Created by `HttpClient::apply_api` before preflight or actual apply operations.


##### `api::Apply::run`  (lines 440–571)

```
async fn run(
            &self,
            task_id: TaskId,
            diff_override: Option<String>,
            preflight: bool,
        ) -> Result<ApplyOutcome>
```

**Purpose**: Fetches or accepts a diff, validates that it is a unified patch, runs local git apply in either preflight or real mode, derives an `ApplyOutcome`, and logs detailed diagnostics for failures or partial application.

**Data flow**: It takes a `TaskId`, optional `diff_override`, and `preflight` flag. If no override is supplied, it fetches task details and extracts `unified_diff`, erroring if absent. It rejects non-unified patch formats early with an `ApplyOutcome` carrying `ApplyStatus::Error`. Otherwise it builds `ApplyGitRequest { cwd, diff, revert: false, preflight }`, invokes `apply_git_patch`, derives `ApplyStatus` from exit code and applied/conflicted path counts, computes `applied` as success-and-not-preflight, formats a human-readable message tailored to preflight vs apply, conditionally logs command/stdout/stderr/patch details for partial or failed results, and returns `ApplyOutcome { applied, status, message, skipped_paths, conflict_paths }`. Execution failures of git apply itself become `CloudTaskError::Io`; missing diffs become `CloudTaskError::Msg`; backend fetch failures become `CloudTaskError::Http`.

**Call relations**: Both `HttpClient::apply_task` and `HttpClient::apply_task_preflight` funnel into this shared implementation with different `preflight` flags. It delegates patch-format checks and diagnostics to `is_unified_diff`, `summarize_patch_for_logging`, `tail`, and `append_error_log`.

*Call graph*: calls 2 internal fn (get_task_details, append_error_log); 9 external calls (new, new, is_unified_diff, summarize_patch_for_logging, apply_git_patch, format!, matches!, current_dir, writeln!).


##### `api::details_path`  (lines 574–582)

```
fn details_path(base_url: &str, id: &str) -> Option<String>
```

**Purpose**: Infers the human-readable task-details endpoint path shape from the configured base URL.

**Data flow**: It takes `base_url` and task ID, checks whether the base URL contains `/backend-api` or `/api/codex`, and returns the corresponding formatted details URL or `None` if the path style is unknown.

**Call relations**: This helper is only used when `api::Tasks::messages` needs to embed a likely GET URL in an error message.

*Call graph*: 1 external calls (format!).


##### `api::extract_assistant_messages_from_body`  (lines 584–625)

```
fn extract_assistant_messages_from_body(body: &str) -> Vec<String>
```

**Purpose**: Walks raw task-details JSON to recover assistant text messages from the current assistant turn worklog when typed helper methods return nothing.

**Data flow**: It parses the raw body into `serde_json::Value`, navigates to `current_assistant_turn.worklog.messages`, filters entries whose `author.role` is `assistant`, then extracts text from `content.parts` whether each part is a bare string or an object with `content_type == "text"`. It returns all non-empty text fragments as a `Vec<String>`.

**Call relations**: This is a fallback parser used by both `api::Tasks::messages` and `api::Tasks::task_text` when the backend extension methods do not expose assistant messages.

*Call graph*: 1 external calls (new).


##### `api::turn_attempt_from_map`  (lines 627–642)

```
fn turn_attempt_from_map(turn: &HashMap<String, Value>) -> Option<TurnAttempt>
```

**Purpose**: Converts one loosely typed sibling-turn map into a strongly typed `TurnAttempt` if the required turn ID is present.

**Data flow**: It reads `id`, `attempt_placement`, `created_at`, `turn_status`, `output_items`, and message content from a `HashMap<String, Value>`, parses timestamps with `parse_timestamp_value`, maps status with `attempt_status_from_str`, extracts diff and assistant messages with dedicated helpers, and returns `Some(TurnAttempt)` or `None` if no string `id` exists.

**Call relations**: Used by `api::Attempts::list` as the per-item conversion step before sorting.

*Call graph*: 4 external calls (attempt_status_from_str, extract_assistant_messages_from_turn, extract_diff_from_turn, parse_timestamp_value).


##### `api::compare_attempts`  (lines 644–656)

```
fn compare_attempts(a: &TurnAttempt, b: &TurnAttempt) -> Ordering
```

**Purpose**: Defines stable ordering for attempts: explicit placement first, then creation time, then turn ID.

**Data flow**: It compares two `TurnAttempt` references by `attempt_placement` when both or either are present; if neither has placement, it compares `created_at`; if timestamps are also absent, it compares `turn_id`. It returns a standard `Ordering`.

**Call relations**: This comparator is passed to `sort_by` in `api::Attempts::list` so sibling attempts appear in a predictable sequence.


##### `api::extract_diff_from_turn`  (lines 658–684)

```
fn extract_diff_from_turn(turn: &HashMap<String, Value>) -> Option<String>
```

**Purpose**: Searches a sibling-turn payload for an embedded diff in either direct `output_diff` items or nested PR output structures.

**Data flow**: It reads the `output_items` array from a turn map, iterates items, and for each item returns the first non-empty diff string found either at `type == "output_diff"` / `diff` or at `type == "pr"` / `output_diff.diff`. If nothing matches, it returns `None`.

**Call relations**: Called by `api::turn_attempt_from_map` to populate `TurnAttempt.diff`.


##### `api::extract_assistant_messages_from_turn`  (lines 686–706)

```
fn extract_assistant_messages_from_turn(turn: &HashMap<String, Value>) -> Vec<String>
```

**Purpose**: Extracts assistant text message parts from a sibling-turn `output_items` array.

**Data flow**: It scans `output_items`, keeps only items with `type == "message"`, iterates their `content` arrays, and collects non-empty `text` fields from parts whose `content_type` is `text`. It returns the collected strings.

**Call relations**: Called by `api::turn_attempt_from_map` to populate `TurnAttempt.messages`.

*Call graph*: 1 external calls (new).


##### `api::attempt_status_from_str`  (lines 708–716)

```
fn attempt_status_from_str(raw: Option<&str>) -> AttemptStatus
```

**Purpose**: Maps backend turn-status strings into the local `AttemptStatus` enum.

**Data flow**: It takes an optional status string, substitutes an empty default when absent, matches known values (`failed`, `completed`, `in_progress`, `pending`), and returns the corresponding enum. Any unknown or missing value currently maps to `AttemptStatus::Pending`.

**Call relations**: Used when building both `TaskText` and `TurnAttempt` values from backend payloads.


##### `api::parse_timestamp_value`  (lines 718–725)

```
fn parse_timestamp_value(v: Option<&Value>) -> Option<DateTime<Utc>>
```

**Purpose**: Converts an optional JSON numeric Unix timestamp with fractional seconds into `DateTime<Utc>`.

**Data flow**: It reads an optional `serde_json::Value`, extracts it as `f64`, splits it into integer seconds and fractional nanoseconds, clamps negative seconds to zero, constructs a `Duration` from the Unix epoch, and returns `Some(DateTime<Utc>)` or `None` if parsing fails.

**Call relations**: Used by `api::turn_attempt_from_map` for sibling-turn creation timestamps.

*Call graph*: 2 external calls (from, new).


##### `api::map_task_list_item_to_summary`  (lines 727–743)

```
fn map_task_list_item_to_summary(src: backend::TaskListItem) -> TaskSummary
```

**Purpose**: Converts a backend task-list row into the shared `TaskSummary` model.

**Data flow**: It takes a `backend::TaskListItem`, reads its `task_status_display`, maps status via `map_status`, parses `updated_at` via `parse_updated_at`, derives environment label and diff summary from status display, marks `is_review` true when `pull_requests` is non-empty, computes `attempt_total`, and returns a `TaskSummary` with `environment_id` left as `None` because list rows do not provide it.

**Call relations**: This is the per-item mapper used by `api::Tasks::list`.

*Call graph*: 6 external calls (new, attempt_total_from_status_display, diff_summary_from_status_display, env_label_from_status_display, map_status, parse_updated_at).


##### `api::map_status`  (lines 745–772)

```
fn map_status(v: Option<&HashMap<String, Value>>) -> TaskStatus
```

**Purpose**: Normalizes backend status-display structures into the local four-state `TaskStatus` enum.

**Data flow**: It inspects an optional status-display map, first preferring `latest_turn_status_display.turn_status` and mapping backend turn states like `completed`, `failed`, `cancelled`, and `in_progress`; if absent, it falls back to top-level `state`; if neither is usable, it returns `TaskStatus::Pending`.

**Call relations**: Used by both list-item and full-summary mapping so task status is derived consistently across endpoints.


##### `api::parse_updated_at`  (lines 774–783)

```
fn parse_updated_at(ts: Option<&f64>) -> DateTime<Utc>
```

**Purpose**: Converts an optional floating-point Unix timestamp into `DateTime<Utc>`, defaulting to the current time when absent.

**Data flow**: It takes `Option<&f64>`, computes seconds and nanoseconds when present, constructs a UTC datetime from the Unix epoch, and otherwise returns `Utc::now()`. Negative seconds are clamped to zero.

**Call relations**: Used when mapping both list rows and full task summaries.

*Call graph*: 3 external calls (from, now, new).


##### `api::env_label_from_status_display`  (lines 785–790)

```
fn env_label_from_status_display(v: Option<&HashMap<String, Value>>) -> Option<String>
```

**Purpose**: Extracts the optional human-friendly environment label from a status-display map.

**Data flow**: It takes an optional `HashMap<String, Value>`, looks up `environment_label`, converts a string value into an owned `String`, and returns `Option<String>`.

**Call relations**: Used by both list and summary mapping to populate `TaskSummary.environment_label`.


##### `api::diff_summary_from_diff`  (lines 792–818)

```
fn diff_summary_from_diff(diff: &str) -> DiffSummary
```

**Purpose**: Computes coarse diff statistics directly from unified diff text when structured stats are unavailable.

**Data flow**: It iterates over diff lines, increments `files_changed` on `diff --git` headers, ignores file headers and hunk markers, counts leading `+` lines as additions and leading `-` lines as removals, and if no file header was seen but the diff is non-empty treats it as one changed file. It returns a `DiffSummary` with those counts.

**Call relations**: Used as a fallback in `api::Tasks::summary` when backend status-display diff stats are all zero.


##### `api::diff_summary_from_status_display`  (lines 820–839)

```
fn diff_summary_from_status_display(v: Option<&HashMap<String, Value>>) -> DiffSummary
```

**Purpose**: Reads structured diff statistics from `latest_turn_status_display.diff_stats` when the backend provides them.

**Data flow**: It starts from `DiffSummary::default()`, navigates through the optional status-display map to `latest_turn_status_display.diff_stats`, reads `files_modified`, `lines_added`, and `lines_removed` as signed integers, clamps negatives to zero, and returns the populated summary.

**Call relations**: Used by both list and summary mapping as the preferred source of diff counts.

*Call graph*: 1 external calls (default).


##### `api::latest_turn_timestamp`  (lines 841–850)

```
fn latest_turn_timestamp(v: Option<&HashMap<String, Value>>) -> Option<f64>
```

**Purpose**: Extracts the latest assistant-turn timestamp from status-display metadata.

**Data flow**: It navigates an optional status-display map to `latest_turn_status_display`, then returns `updated_at` or `created_at` as `Option<f64>`. If any layer is missing, it returns `None`.

**Call relations**: Used by `api::Tasks::summary` as a fallback source for `updated_at` when task-level timestamps are absent.


##### `api::attempt_total_from_status_display`  (lines 852–859)

```
fn attempt_total_from_status_display(v: Option<&HashMap<String, Value>>) -> Option<usize>
```

**Purpose**: Infers the total number of attempts from sibling turn IDs in status-display metadata.

**Data flow**: It navigates to `latest_turn_status_display.sibling_turn_ids`, reads the array length, adds one for the current turn, and returns that as `Option<usize>`. Missing metadata yields `None`.

**Call relations**: Used by both list and summary mapping to populate `TaskSummary.attempt_total`.


##### `api::is_unified_diff`  (lines 861–869)

```
fn is_unified_diff(diff: &str) -> bool
```

**Purpose**: Performs a lightweight format check to decide whether a patch string looks like a unified git diff.

**Data flow**: It trims leading whitespace, returns true immediately for `diff --git` prefixes, otherwise checks for both `---`/`+++` file headers and at least one `@@` hunk marker. It returns a boolean only and does not parse the patch fully.

**Call relations**: Used by `api::Apply::run` to reject incompatible patch formats before invoking git.


##### `api::tail`  (lines 871–877)

```
fn tail(s: &str, max: usize) -> String
```

**Purpose**: Returns the last `max` bytes of a string for compact logging.

**Data flow**: It takes a string slice and maximum length, returns the whole string if already short enough, otherwise slices from `s.len() - max` to the end and returns that substring as a new `String`.

**Call relations**: Used by `api::Apply::run` when logging stdout and stderr tails from git apply failures.


##### `api::summarize_patch_for_logging`  (lines 879–905)

```
fn summarize_patch_for_logging(patch: &str) -> String
```

**Purpose**: Builds a compact textual summary of a patch’s apparent format, size, current working directory, and leading lines for diagnostics.

**Data flow**: It inspects the patch prefix to classify it as `codex-patch`, `git-diff`, `unified-diff`, or `unknown`, counts lines and characters, reads the current working directory if available, captures up to the first 20 lines, truncates that preview to 800 characters, and returns a formatted summary string.

**Call relations**: Used by `api::Apply::run` both when rejecting non-unified patches and when logging partial/error apply results.

*Call graph*: 2 external calls (format!, current_dir).


##### `append_error_log`  (lines 908–918)

```
fn append_error_log(message: &str)
```

**Purpose**: Appends a timestamped diagnostic line to `error.log` on a best-effort basis.

**Data flow**: It gets the current UTC timestamp, opens `error.log` in create-and-append mode, and writes `[timestamp] message` followed by a newline if the file opens successfully. Any file-open or write failure is ignored.

**Call relations**: This is the shared logging sink used by task listing, task creation, and apply flows to preserve debugging context without interrupting normal execution.

*Call graph*: called by 3 (run, create, list); 3 external calls (now, new, writeln!).


### `config/src/thread_config/remote.rs`

`io_transport` · `config load`

This file is the concrete remote-backed adapter for thread configuration loading. `RemoteThreadConfigLoader` stores a single endpoint string and exposes a trait-compatible `load` method that opens a tonic client connection, sends a `LoadThreadConfigRequest`, and translates the returned protobuf `sources` into local `ThreadConfigSource` values. The request builder preserves the optional `thread_id`, stringifies the optional absolute `cwd`, and sets a fixed 5-second gRPC timeout via request metadata.

Most of the file is conversion and validation logic. `remote_status_to_error` collapses tonic status codes into the crate’s `ThreadConfigLoadErrorCode`, distinguishing auth failures and deadlines from generic request failures. `thread_config_source_from_proto` enforces that the `oneof` payload is present and dispatches session/user variants. `session_thread_config_from_proto` converts repeated model providers into a `HashMap` keyed by provider id and normalizes feature flags into a `BTreeMap`. `model_provider_from_proto` is strict: provider ids must be non-empty, `wire_api` must decode to `Responses` rather than `Unspecified`, and unknown numeric enum values become parse errors. Auth payload conversion additionally requires nonzero `timeout_ms` and an absolute `cwd` validated through `AbsolutePathBuf::from_absolute_path_checked`.

The test module spins up an in-process tonic server implementing the generated service trait, verifies the exact request payload and timeout header, and checks that a rich `ModelProviderInfo` survives proto conversion with headers, retries, websocket flags, and auth command settings intact.

#### Function details

##### `RemoteThreadConfigLoader::new`  (lines 33–37)

```
fn new(endpoint: impl Into<String>) -> Self
```

**Purpose**: Constructs a remote loader pointed at a specific gRPC endpoint string. It is the minimal setup entrypoint for callers selecting remote thread-config loading.

**Data flow**: Accepts `endpoint: impl Into<String>` → converts it into an owned `String` → stores it in `RemoteThreadConfigLoader { endpoint }` → returns the loader.

**Call relations**: Called by configuration assembly code and by the integration-style test before any network activity occurs; later `client` reads the stored endpoint.

*Call graph*: called by 3 (configured_thread_config_loader, configured_thread_config_loader, load_thread_config_calls_remote_service); 1 external calls (into).


##### `RemoteThreadConfigLoader::client`  (lines 39–51)

```
async fn client(
        &self,
    ) -> Result<ThreadConfigLoaderClient<tonic::transport::Channel>, ThreadConfigLoadError>
```

**Purpose**: Opens a tonic `ThreadConfigLoaderClient` connected to the configured endpoint and maps transport connection failures into the crate’s thread-config error type.

**Data flow**: Reads `self.endpoint`, clones it, and awaits `ThreadConfigLoaderClient::connect(...)` → on success returns the connected client; on failure constructs `ThreadConfigLoadError` with code `RequestFailed`, no HTTP status code, and a formatted connection message.

**Call relations**: Used only by `RemoteThreadConfigLoader::load` as the first network step before issuing the RPC.

*Call graph*: called by 1 (load); 1 external calls (connect).


##### `RemoteThreadConfigLoader::load`  (lines 74–79)

```
fn load(
        &self,
        context: ThreadConfigContext,
    ) -> ThreadConfigLoaderFuture<'_, Vec<ThreadConfigSource>>
```

**Purpose**: Performs the full remote fetch: connect, send the request, map transport status errors, and decode each returned source into local domain values.

**Data flow**: Consumes `context: ThreadConfigContext` → awaits `self.client()` → builds a tonic request with `load_thread_config_request(context)` → awaits the remote `.load(...)` RPC → maps `tonic::Status` through `remote_status_to_error`, extracts the protobuf body with `into_inner()`, iterates over `response.sources`, converts each via `thread_config_source_from_proto`, and collects into `Result<Vec<ThreadConfigSource>, ThreadConfigLoadError>`.

**Call relations**: This async method backs the trait implementation below. It is invoked when the system asks this loader to resolve thread config and delegates request construction and proto decoding to helper functions in this file.

*Call graph*: calls 2 internal fn (client, load_thread_config_request); 1 external calls (pin).


##### `load_thread_config_request`  (lines 82–91)

```
fn load_thread_config_request(
    context: ThreadConfigContext,
) -> tonic::Request<proto::LoadThreadConfigRequest>
```

**Purpose**: Builds the outbound tonic request for the remote `Load` RPC and attaches the fixed timeout expected by the remote loader contract.

**Data flow**: Takes `ThreadConfigContext` with optional `thread_id` and optional `cwd` → constructs `proto::LoadThreadConfigRequest` using the raw thread id and a lossy string conversion of `cwd` when present → wraps it in `tonic::Request::new(...)` → sets timeout to `REMOTE_THREAD_CONFIG_LOAD_TIMEOUT` → returns the request.

**Call relations**: Called by `RemoteThreadConfigLoader::load` for real RPCs and by a unit test that inspects the generated `grpc-timeout` metadata.

*Call graph*: calls 1 internal fn (new); called by 2 (load, load_thread_config_request_sets_timeout).


##### `remote_status_to_error`  (lines 93–119)

```
fn remote_status_to_error(status: tonic::Status) -> ThreadConfigLoadError
```

**Purpose**: Maps tonic gRPC status codes into the narrower thread-config loader error taxonomy used by the rest of the config subsystem.

**Data flow**: Consumes `status: tonic::Status` → matches `status.code()` → maps `Unauthenticated` and `PermissionDenied` to `ThreadConfigLoadErrorCode::Auth`, `DeadlineExceeded` to `Timeout`, and all other non-OK codes to `RequestFailed` → constructs and returns `ThreadConfigLoadError` with no status code and a formatted message containing the original status.

**Call relations**: Used as the error adapter on the RPC future in `RemoteThreadConfigLoader::load`; it centralizes transport-to-domain error translation.

*Call graph*: calls 1 internal fn (new); 2 external calls (code, format!).


##### `thread_config_source_from_proto`  (lines 121–133)

```
fn thread_config_source_from_proto(
    source: proto::ThreadConfigSource,
) -> Result<ThreadConfigSource, ThreadConfigLoadError>
```

**Purpose**: Converts one protobuf `ThreadConfigSource` wrapper into the local enum while enforcing that the `oneof` payload is actually present.

**Data flow**: Takes `source: proto::ThreadConfigSource` → matches `source.source` → for `Session(config)` delegates to `session_thread_config_from_proto` and wraps the result in `ThreadConfigSource::Session`; for `User(_)` returns `ThreadConfigSource::User(UserThreadConfig::default())`; for `None` returns a parse error.

**Call relations**: Called while collecting the remote response’s `sources` vector. It delegates session payload decoding to the dedicated helper and handles the trivial user case inline.

*Call graph*: calls 2 internal fn (parse_error, session_thread_config_from_proto); 2 external calls (User, default).


##### `session_thread_config_from_proto`  (lines 135–149)

```
fn session_thread_config_from_proto(
    config: proto::SessionThreadConfig,
) -> Result<SessionThreadConfig, ThreadConfigLoadError>
```

**Purpose**: Transforms a protobuf session config into the local `SessionThreadConfig`, including keyed provider lookup and deterministic feature ordering.

**Data flow**: Consumes `proto::SessionThreadConfig` → iterates `config.model_providers`, converting each with `model_provider_from_proto` and collecting into `HashMap<String, ModelProviderInfo>` → converts `config.features` into `BTreeMap<String, bool>` → returns `SessionThreadConfig { model_provider, model_providers, features }` or the first conversion error encountered.

**Call relations**: Reached from `thread_config_source_from_proto` when the remote source is a session config; it delegates per-provider validation to `model_provider_from_proto`.

*Call graph*: called by 1 (thread_config_source_from_proto).


##### `model_provider_from_proto`  (lines 151–195)

```
fn model_provider_from_proto(
    provider: proto::ModelProvider,
) -> Result<(String, ModelProviderInfo), ThreadConfigLoadError>
```

**Purpose**: Validates and converts one protobuf `ModelProvider` into the local `(id, ModelProviderInfo)` pair used inside session config maps.

**Data flow**: Consumes `provider: proto::ModelProvider` → rejects empty `provider.id` with a parse error → decodes numeric `provider.wire_api` via `proto::WireApi::try_from`, accepting only `Responses`, rejecting `Unspecified` and unknown values → builds `ModelProviderInfo` by moving across name/base URL/env/header/retry/websocket fields, converting optional auth via `model_provider_auth_from_proto` with `transpose()`, and leaving `aws` as `None` → returns `(id, info)`.

**Call relations**: Called from `session_thread_config_from_proto` for each repeated provider and directly by the round-trip test. It is the strictest parser in the file because malformed provider metadata would poison downstream model selection.

*Call graph*: calls 1 internal fn (parse_error); called by 1 (model_provider_proto_roundtrips_through_domain_type); 2 external calls (try_from, format!).


##### `model_provider_to_proto`  (lines 198–241)

```
fn model_provider_to_proto(
    id: impl Into<String>,
    provider: ModelProviderInfo,
) -> proto::ModelProvider
```

**Purpose**: Test-only inverse conversion from local `ModelProviderInfo` back into the protobuf `ModelProvider` shape. It exists to verify that the parser and serializer agree on field mapping.

**Data flow**: Takes an `id` and owned `ModelProviderInfo` → destructures the domain struct, discarding `aws` → converts optional auth with `model_provider_auth_to_proto`, maps `wire_api` through `proto_wire_api`, wraps optional maps with `proto_string_map`, and copies retry/websocket flags → returns `proto::ModelProvider`.

**Call relations**: Used only by the round-trip unit test, where it feeds `model_provider_from_proto` to confirm lossless conversion for supported fields.

*Call graph*: calls 1 internal fn (proto_wire_api); called by 1 (model_provider_proto_roundtrips_through_domain_type); 1 external calls (into).


##### `model_provider_auth_from_proto`  (lines 243–262)

```
fn model_provider_auth_from_proto(
    auth: proto::ModelProviderAuthInfo,
) -> Result<ModelProviderAuthInfo, ThreadConfigLoadError>
```

**Purpose**: Converts protobuf auth-command metadata into the local `ModelProviderAuthInfo` while enforcing nonzero timeout and absolute working-directory validity.

**Data flow**: Consumes `auth: proto::ModelProviderAuthInfo` → converts `timeout_ms` into `NonZeroU64`, failing with a parse error if zero → validates `auth.cwd` with `AbsolutePathBuf::from_absolute_path_checked`, mapping path errors into parse errors → returns `ModelProviderAuthInfo { command, args, timeout_ms, refresh_interval_ms, cwd }`.

**Call relations**: Called from `model_provider_from_proto` when a provider includes nested auth info; it isolates the extra validation rules for auth execution settings.

*Call graph*: calls 1 internal fn (from_absolute_path_checked); 1 external calls (new).


##### `model_provider_auth_to_proto`  (lines 265–281)

```
fn model_provider_auth_to_proto(auth: ModelProviderAuthInfo) -> proto::ModelProviderAuthInfo
```

**Purpose**: Test-only inverse conversion from local auth-command settings into the protobuf auth message. It serializes the validated domain type back into plain wire fields.

**Data flow**: Consumes owned `ModelProviderAuthInfo` → destructures it → converts `timeout_ms` from `NonZeroU64` to raw `u64` with `.get()` and stringifies `cwd` → returns `proto::ModelProviderAuthInfo`.

**Call relations**: Used only by `model_provider_to_proto` in tests to build a protobuf provider payload from a domain provider.


##### `proto_string_map`  (lines 284–286)

```
fn proto_string_map(values: HashMap<String, String>) -> proto::StringMap
```

**Purpose**: Wraps a plain `HashMap<String, String>` in the protobuf `StringMap` message used by optional header/query fields.

**Data flow**: Takes `values: HashMap<String, String>` → returns `proto::StringMap { values }` unchanged.

**Call relations**: Test-only helper used by `model_provider_to_proto` when constructing protobuf maps.


##### `proto_wire_api`  (lines 289–293)

```
fn proto_wire_api(wire_api: WireApi) -> proto::WireApi
```

**Purpose**: Maps the domain `WireApi` enum into the protobuf `WireApi` enum for test serialization.

**Data flow**: Consumes `wire_api: WireApi` → matches supported variants and returns the corresponding `proto::WireApi` variant.

**Call relations**: Called by `model_provider_to_proto` to populate the numeric protobuf enum field.

*Call graph*: called by 1 (model_provider_to_proto).


##### `parse_error`  (lines 295–301)

```
fn parse_error(message: impl Into<String>) -> ThreadConfigLoadError
```

**Purpose**: Creates a standardized parse-class `ThreadConfigLoadError` for malformed remote payloads. It keeps parse failures distinct from transport failures.

**Data flow**: Accepts `message: impl Into<String>` → converts it into a `String` → constructs `ThreadConfigLoadError` with code `Parse`, no status code, and that message → returns the error.

**Call relations**: Shared by the proto-decoding helpers whenever the remote service returns structurally invalid or semantically incomplete data.

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

**Purpose**: Implements the test server’s `Load` RPC by asserting the exact incoming request payload and returning a canned response source list.

**Data flow**: Reads `self.sources` and `self.expected_cwd`; consumes `Request<proto::LoadThreadConfigRequest>` → asserts that `request.into_inner()` equals the expected thread id and cwd → constructs `Response::new(proto::LoadThreadConfigResponse { sources: self.sources.clone() })` → returns it.

**Call relations**: Invoked by tonic through the generated server trait implementation during `load_thread_config_calls_remote_service`; it serves as the remote endpoint under test.

*Call graph*: 4 external calls (pin, assert_eq!, new, load).


##### `tests::load_thread_config_calls_remote_service`  (lines 370–405)

```
async fn load_thread_config_calls_remote_service()
```

**Purpose**: End-to-end test that starts a local tonic server, invokes `RemoteThreadConfigLoader`, and verifies the decoded domain result matches the expected sources.

**Data flow**: Builds a workspace cwd and expected string form → binds a local TCP listener on an ephemeral port → spawns a tonic `Server` with `ThreadConfigLoaderServer::new(TestServer { ... })` and shutdown channel → constructs `RemoteThreadConfigLoader` with `http://{addr}` → awaits `loader.load(ThreadConfigContext { ... })` → shuts down the server and asserts the loaded sources equal `expected_sources()`.

**Call relations**: Exercises the full call chain from loader construction through request building, tonic transport, generated client/server bindings, and proto-to-domain conversion.

*Call graph*: calls 1 internal fn (new); 10 external calls (builder, assert_eq!, new, proto_sources, workspace_dir, format!, bind, spawn, channel, new).


##### `tests::load_thread_config_request_sets_timeout`  (lines 408–418)

```
fn load_thread_config_request_sets_timeout()
```

**Purpose**: Verifies that outbound remote-load requests carry the intended 5-second gRPC timeout metadata.

**Data flow**: Calls `load_thread_config_request(ThreadConfigContext::default())` → reads request metadata key `grpc-timeout` and converts it to `&str` → asserts it equals `Some("5000000u")`.

**Call relations**: Targets the request-construction helper directly rather than the network path, ensuring timeout behavior is pinned by a small unit test.

*Call graph*: calls 1 internal fn (load_thread_config_request); 2 external calls (assert_eq!, default).


##### `tests::model_provider_proto_roundtrips_through_domain_type`  (lines 421–428)

```
fn model_provider_proto_roundtrips_through_domain_type()
```

**Purpose**: Checks that a representative `ModelProviderInfo` survives conversion to protobuf and back without losing supported fields or changing values.

**Data flow**: Builds `expected = expected_provider()` → converts it with `model_provider_to_proto("local", expected.clone())` → parses it back with `model_provider_from_proto` → asserts the returned id is `local` and the parsed provider equals `expected`.

**Call relations**: Exercises the paired test-only serializer and production parser to lock down field mapping for provider metadata.

*Call graph*: calls 2 internal fn (model_provider_from_proto, model_provider_to_proto); 2 external calls (assert_eq!, expected_provider).


##### `tests::proto_sources`  (lines 430–490)

```
fn proto_sources() -> Vec<proto::ThreadConfigSource>
```

**Purpose**: Constructs a realistic protobuf response payload containing both session and user thread-config sources for integration testing.

**Data flow**: Computes a workspace cwd string → returns a `Vec<proto::ThreadConfigSource>` containing one session source with a populated `proto::SessionThreadConfig` and one user source with `proto::UserThreadConfig {}`.

**Call relations**: Used by the remote-service integration test to seed the test server’s canned response.

*Call graph*: 2 external calls (workspace_dir, vec!).


##### `tests::expected_sources`  (lines 492–504)

```
fn expected_sources() -> Vec<ThreadConfigSource>
```

**Purpose**: Builds the local-domain equivalent of `proto_sources()` for assertion against the loader’s decoded output.

**Data flow**: Returns a `Vec<ThreadConfigSource>` containing a `Session(SessionThreadConfig { ... })` with provider map and ordered features plus a default `User` source.

**Call relations**: Consumed by `load_thread_config_calls_remote_service` as the expected post-conversion result.

*Call graph*: 1 external calls (vec!).


##### `tests::expected_provider`  (lines 506–541)

```
fn expected_provider() -> ModelProviderInfo
```

**Purpose**: Creates the canonical `ModelProviderInfo` fixture used by both the round-trip test and expected decoded sources.

**Data flow**: Constructs and returns a `ModelProviderInfo` populated with name, base URL, auth command settings, query/header maps, retry counts, websocket settings, and `aws: None`.

**Call relations**: Shared fixture builder for `expected_sources` and `model_provider_proto_roundtrips_through_domain_type`.

*Call graph*: 4 external calls (from, new, workspace_dir, vec!).


##### `tests::workspace_dir`  (lines 543–547)

```
fn workspace_dir() -> AbsolutePathBuf
```

**Purpose**: Builds a deterministic absolute workspace path fixture rooted under the current directory. This keeps path-sensitive tests stable.

**Data flow**: Calls `AbsolutePathBuf::current_dir()` → appends `workspace` with `.join("workspace")` → returns the resulting absolute path.

**Call relations**: Used by multiple tests and fixture builders whenever an absolute cwd is needed.

*Call graph*: calls 1 internal fn (current_dir).


### `lmstudio/src/client.rs`

`io_transport` · `OSS model setup and local model management`

This file defines `LMStudioClient`, a small cloneable wrapper around `reqwest::Client` plus a `base_url` string. Its constructor path is configuration-driven: `try_from_provider` looks up the built-in LM Studio provider by `LMSTUDIO_OSS_PROVIDER_ID` inside `Config.model_providers`, requires a `base_url`, builds a reqwest client with a 5-second connect timeout, and immediately probes the server with `check_server`. That probe performs a GET on `{base_url}/models` and turns either transport failure or non-success HTTP status into an `io::Error` that includes a user-facing installation/startup hint.

Operational methods map directly to LM Studio endpoints. `fetch_models` GETs `/models`, parses JSON, requires a top-level `data` array, and extracts each model's `id` string. `load_model` POSTs to `/responses` with a minimal JSON body (`model`, empty `input`, `max_output_tokens: 1`) to trigger model loading, logging success via `tracing::info!`. For local downloads, `download_model` shells out to `lms get --yes <model>`, inheriting stdout but discarding stderr, and reports nonzero exit codes as `io::Error`s. The helper `find_lms_with_home_dir` first checks `PATH` via `which`, then falls back to `~/.lmstudio/bin/lms` or `.exe` depending on platform. Tests use `wiremock` to validate happy paths and error handling for `/models` and `/check_server`, and they exercise fallback path construction and the test-only raw constructor `from_host_root`.

#### Function details

##### `LMStudioClient::try_from_provider`  (lines 15–44)

```
async fn try_from_provider(config: &Config) -> std::io::Result<Self>
```

**Purpose**: Constructs an `LMStudioClient` from the configured built-in LM Studio provider and verifies the server is reachable before returning it.

**Data flow**: Reads `config.model_providers`, looks up `LMSTUDIO_OSS_PROVIDER_ID`, extracts `base_url`, builds a `reqwest::Client` with a 5-second connect timeout falling back to `reqwest::Client::new()` on builder failure, stores the client and base URL in `LMStudioClient`, awaits `check_server`, and returns either the initialized client or an `io::Error`.

**Call relations**: This is the public constructor used by higher-level OSS setup code; it delegates connectivity validation to `check_server` so callers fail early if LM Studio is not running.

*Call graph*: called by 1 (ensure_oss_ready); 2 external calls (builder, from_secs).


##### `LMStudioClient::check_server`  (lines 46–62)

```
async fn check_server(&self) -> io::Result<()>
```

**Purpose**: Performs a lightweight health check against the LM Studio `/models` endpoint.

**Data flow**: Formats `{base_url}/models` after trimming any trailing slash, sends a GET request, and returns `Ok(())` only if the response arrives and has a success status. Non-success statuses become `io::Error::other` with the status code plus the standard connection-help message; transport failures become the same help message without a status.

**Call relations**: Called during client construction and directly by tests to validate both success and failure messaging.

*Call graph*: 3 external calls (get, other, format!).


##### `LMStudioClient::load_model`  (lines 65–92)

```
async fn load_model(&self, model: &str) -> io::Result<()>
```

**Purpose**: Triggers LM Studio to load a specific model by sending a minimal responses request.

**Data flow**: Formats `{base_url}/responses`, builds a JSON body containing the model name, empty input, and `max_output_tokens: 1`, POSTs it with `Content-Type: application/json`, maps request errors into `io::Error::other`, and returns success only for HTTP success statuses. On success it logs via `tracing::info!`; on failure it returns an error containing the response status.

**Call relations**: Higher-level setup code spawns this in the background after ensuring the model exists locally.

*Call graph*: 5 external calls (post, other, format!, json!, info!).


##### `LMStudioClient::fetch_models`  (lines 95–124)

```
async fn fetch_models(&self) -> io::Result<Vec<String>>
```

**Purpose**: Retrieves the list of model IDs currently exposed by the LM Studio server.

**Data flow**: GETs `{base_url}/models`, maps transport errors into `io::Error::other`, and on success parses the body as `serde_json::Value`. It requires `json["data"]` to be an array, extracts each element's `id` string, collects them into `Vec<String>`, and returns that vector. Non-success HTTP statuses and malformed JSON/data shape become `io::Error`s.

**Call relations**: Used by OSS setup to decide whether a model must be downloaded, and heavily exercised by the wiremock tests.

*Call graph*: 3 external calls (get, other, format!).


##### `LMStudioClient::find_lms`  (lines 127–129)

```
fn find_lms() -> std::io::Result<String>
```

**Purpose**: Finds the `lms` CLI using the real environment and default home-directory lookup rules.

**Data flow**: Calls `find_lms_with_home_dir(None)` and returns its `std::io::Result<String>` unchanged.

**Call relations**: This is the production entry point for CLI discovery and is used by `download_model`; tests call it directly to tolerate either installed or missing LM Studio.

*Call graph*: called by 1 (test_find_lms); 1 external calls (find_lms_with_home_dir).


##### `LMStudioClient::find_lms_with_home_dir`  (lines 131–166)

```
fn find_lms_with_home_dir(home_dir: Option<&str>) -> std::io::Result<String>
```

**Purpose**: Locates the `lms` executable either in `PATH` or in LM Studio's per-user fallback install directory.

**Data flow**: First checks `which::which("lms")`; if found, returns the literal command `"lms"`. Otherwise it determines a home directory from the optional argument or from `HOME`/`USERPROFILE`, constructs a platform-specific fallback path under `.lmstudio/bin`, checks `Path::exists`, and returns either that path string or a `NotFound` error with installation guidance.

**Call relations**: Called by `find_lms` in production and by tests with a mock home directory to validate fallback path construction without mutating process env.

*Call graph*: called by 1 (test_find_lms_with_mock_home); 5 external calls (new, new, format!, var, which).


##### `LMStudioClient::download_model`  (lines 168–190)

```
async fn download_model(&self, model: &str) -> std::io::Result<()>
```

**Purpose**: Downloads a model through the external `lms` CLI.

**Data flow**: Finds the CLI path via `find_lms`, prints a progress line to stderr, runs `lms get --yes <model>` with inherited stdout and null stderr, maps process-launch failures into `io::Error::other`, checks `status.success()`, and returns either `Ok(())` with an info log or an error containing the exit code.

**Call relations**: Called by higher-level OSS setup only when `fetch_models` indicates the requested model is not already present.

*Call graph*: 8 external calls (find_lms, new, other, eprintln!, format!, inherit, null, info!).


##### `LMStudioClient::from_host_root`  (lines 194–203)

```
fn from_host_root(host_root: impl Into<String>) -> Self
```

**Purpose**: Test-only constructor that creates a client from an arbitrary base URL without consulting configuration or probing the server.

**Data flow**: Builds a reqwest client with the same 5-second connect timeout and fallback behavior as the main constructor, converts the supplied host root into a `String`, and returns `LMStudioClient { client, base_url }`.

**Call relations**: All HTTP unit tests use this helper to point the client at a `wiremock::MockServer`.

*Call graph*: called by 6 (test_check_server_error, test_check_server_happy_path, test_fetch_models_happy_path, test_fetch_models_no_data_array, test_fetch_models_server_error, test_from_host_root); 3 external calls (into, builder, from_secs).


##### `tests::test_fetch_models_happy_path`  (lines 212–241)

```
async fn test_fetch_models_happy_path()
```

**Purpose**: Verifies that `fetch_models` extracts model IDs from a valid `/models` response.

**Data flow**: Skips when sandboxed networking is disabled via env var; otherwise starts a wiremock server, mounts a `GET /models` response containing a `data` array with one `id`, constructs a client from the mock URI, calls `fetch_models`, and asserts the returned vector contains `openai/gpt-oss-20b`.

**Call relations**: This is the positive-path test for the JSON parsing logic in `fetch_models`.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert!, json!, var, info!, given, start, new, method, path).


##### `tests::test_fetch_models_no_data_array`  (lines 244–272)

```
async fn test_fetch_models_no_data_array()
```

**Purpose**: Verifies that `fetch_models` rejects a successful HTTP response whose JSON body lacks the required `data` array.

**Data flow**: Optionally skips on disabled networking, serves `{}` from `GET /models`, calls `fetch_models`, asserts the result is an error, and checks the error text contains `No 'data' array in response`.

**Call relations**: This covers the schema-validation branch inside `fetch_models`.

*Call graph*: calls 1 internal fn (from_host_root); 9 external calls (assert!, json!, var, info!, given, start, new, method, path).


##### `tests::test_fetch_models_server_error`  (lines 275–300)

```
async fn test_fetch_models_server_error()
```

**Purpose**: Verifies that non-success HTTP status codes from `/models` are surfaced as fetch errors.

**Data flow**: Optionally skips on disabled networking, serves HTTP 500 from `GET /models`, calls `fetch_models`, asserts error, and checks the message contains `Failed to fetch models: 500`.

**Call relations**: This covers the non-success status branch in `fetch_models`.

*Call graph*: calls 1 internal fn (from_host_root); 8 external calls (assert!, var, info!, given, start, new, method, path).


##### `tests::test_check_server_happy_path`  (lines 303–324)

```
async fn test_check_server_happy_path()
```

**Purpose**: Verifies that `check_server` succeeds when `/models` returns HTTP 200.

**Data flow**: Optionally skips on disabled networking, serves HTTP 200 from `GET /models`, constructs a client from the mock URI, and awaits `check_server` expecting success.

**Call relations**: This is the positive-path test for the constructor's connectivity probe.

*Call graph*: calls 1 internal fn (from_host_root); 7 external calls (var, info!, given, start, new, method, path).


##### `tests::test_check_server_error`  (lines 327–352)

```
async fn test_check_server_error()
```

**Purpose**: Verifies that `check_server` reports non-success statuses with the expected message prefix.

**Data flow**: Optionally skips on disabled networking, serves HTTP 404 from `GET /models`, calls `check_server`, asserts error, and checks the message contains `Server returned error: 404`.

**Call relations**: This covers the HTTP-error branch of the server probe.

*Call graph*: calls 1 internal fn (from_host_root); 8 external calls (assert!, var, info!, given, start, new, method, path).


##### `tests::test_find_lms`  (lines 355–367)

```
fn test_find_lms()
```

**Purpose**: Exercises `find_lms` against the real environment, accepting either an installed CLI or the expected not-found error.

**Data flow**: Calls `LMStudioClient::find_lms`; if it returns `Err`, asserts the error text contains `LM Studio not found`; otherwise accepts success without further checks.

**Call relations**: This is a tolerant environment-dependent smoke test for CLI discovery.

*Call graph*: calls 1 internal fn (find_lms); 1 external calls (assert!).


##### `tests::test_find_lms_with_mock_home`  (lines 370–387)

```
fn test_find_lms_with_mock_home()
```

**Purpose**: Checks fallback-path construction using a supplied mock home directory on the current platform.

**Data flow**: Calls `find_lms_with_home_dir(Some(...))` with a platform-specific fake home path and, if the result is an error, asserts it contains `LM Studio not found`.

**Call relations**: This isolates the fallback-path branch from real environment variables.

*Call graph*: calls 1 internal fn (find_lms_with_home_dir); 1 external calls (assert!).


##### `tests::test_from_host_root`  (lines 390–396)

```
fn test_from_host_root()
```

**Purpose**: Verifies that the test-only constructor preserves the provided base URL exactly.

**Data flow**: Constructs two clients with different URL strings and asserts each client's `base_url` field equals the input string.

**Call relations**: This is a simple constructor sanity test supporting the rest of the wiremock-based suite.

*Call graph*: calls 1 internal fn (from_host_root); 1 external calls (assert_eq!).


### API endpoint session layer
These files define provider configuration and the endpoint/session scaffolding that higher-level API clients use to assemble and execute requests.

### `codex-api/src/provider.rs`

`config` · `client setup and request construction`

This file packages transport-facing provider settings into two structs: `RetryConfig`, a high-level retry description, and `Provider`, the per-deployment endpoint definition. `RetryConfig` is intentionally simpler than `codex_client::RetryPolicy`; its conversion method fills the nested `RetryOn` flags expected by the lower-level client. `Provider` stores a human-readable `name`, a `base_url`, optional default query parameters, default `HeaderMap` headers, retry behavior, and a stream idle timeout used by streaming consumers.

The core behavior is `Provider::url_for_path`, which normalizes both sides of the join by trimming trailing `/` from the base and leading `/` from the path, then appends serialized query parameters if configured. Query parameters are emitted by iterating the stored `HashMap` and concatenating `k=v` pairs with `&`; there is no URL encoding here, so callers are expected to provide already-safe values. `build_request` turns that URL plus cloned default headers into a `codex_client::Request` with no body, no compression, and no timeout override.

The Azure helpers are a notable design detail: Azure detection can come either from the provider name (`azure`, case-insensitive) or from known Azure hostname/path markers in the base URL. `websocket_url_for_path` reuses normal URL construction, parses it as `url::Url`, and rewrites only `http`→`ws` and `https`→`wss`, leaving existing WebSocket schemes and unknown schemes untouched.

#### Function details

##### `RetryConfig::to_policy`  (lines 25–35)

```
fn to_policy(&self) -> RetryPolicy
```

**Purpose**: Converts the file's simplified retry settings into the exact `codex_client::RetryPolicy` structure used by transport retry code. It preserves the attempt count and base delay while nesting the three retry booleans under `RetryOn`.

**Data flow**: `self.max_attempts`, `self.base_delay`, and the `retry_429` / `retry_5xx` / `retry_transport` flags are read from the `RetryConfig` instance. They are copied directly into a newly constructed `RetryPolicy` and returned; no external state is mutated.

**Call relations**: This is the bridge from provider configuration into lower-level HTTP execution. It is used when higher-level request orchestration needs a transport retry policy rather than the API-facing config struct.


##### `Provider::url_for_path`  (lines 53–75)

```
fn url_for_path(&self, path: &str) -> String
```

**Purpose**: Builds the full request URL for a relative API path, including any provider-wide query parameters. It normalizes slash boundaries so callers can pass paths with or without a leading slash.

**Data flow**: Reads `self.base_url` and trims trailing `/`; reads the `path` argument and trims leading `/`. It either returns the bare base URL for an empty path or formats `base/path`, then, if `self.query_params` exists and is non-empty, appends `?` plus `key=value` pairs joined by `&`. The result is a `String` URL.

**Call relations**: This is the common URL builder used by both `Provider::build_request` for HTTP requests and `Provider::websocket_url_for_path` before scheme conversion. Those callers rely on it to keep path joining and provider-level query parameters consistent.

*Call graph*: called by 2 (build_request, websocket_url_for_path); 1 external calls (format!).


##### `Provider::build_request`  (lines 77–86)

```
fn build_request(&self, method: Method, path: &str) -> Request
```

**Purpose**: Creates a baseline `codex_client::Request` for an HTTP method and provider-relative path. The request is intentionally skeletal so later layers can attach body, compression, and timeout details.

**Data flow**: Consumes the `method` and `path` arguments, calls `url_for_path` to compute the URL, clones `self.headers` into the request, and sets `body` to `None`, `compression` to `RequestCompression::None`, and `timeout` to `None`. It returns the assembled `Request` without mutating provider state.

**Call relations**: Higher-level request code invokes this as the starting point for outbound API calls; the graph shows it feeding a `make_request` path. It delegates URL assembly to `url_for_path` so all request builders share the same base URL and query parameter logic.

*Call graph*: calls 1 internal fn (url_for_path); called by 1 (make_request); 1 external calls (clone).


##### `Provider::is_azure_responses_endpoint`  (lines 88–90)

```
fn is_azure_responses_endpoint(&self) -> bool
```

**Purpose**: Answers whether this provider should be treated as an Azure Responses endpoint. It combines the provider's configured name and base URL into the shared Azure detection routine.

**Data flow**: Reads `self.name` and `self.base_url`, passes them to `is_azure_responses_provider`, and returns the resulting boolean. It does not alter any provider fields.

**Call relations**: This method is used by request-building logic for Responses requests, where Azure deployments need slightly different behavior. It is a thin instance-level wrapper around the file-level detection helper.

*Call graph*: calls 1 internal fn (is_azure_responses_provider); called by 1 (build_responses_request).


##### `Provider::websocket_url_for_path`  (lines 92–103)

```
fn websocket_url_for_path(&self, path: &str) -> Result<Url, url::ParseError>
```

**Purpose**: Builds a parsed WebSocket URL for a provider-relative path by reusing normal URL construction and then rewriting the scheme when appropriate. It supports HTTP and HTTPS origins while tolerating already-WebSocket or unknown schemes.

**Data flow**: Calls `url_for_path(path)` to get a string, parses it into `url::Url`, then inspects `url.scheme()`. For `http` it sets `ws`; for `https` it sets `wss`; for `ws`, `wss`, or any other scheme it returns the parsed URL unchanged. Parse failures are returned as `url::ParseError`.

**Call relations**: WebSocket connection code invokes this before opening a socket; the graph shows `connect` and `probe_handshake` as consumers. It depends on `url_for_path` so WebSocket and HTTP endpoints stay aligned except for scheme translation.

*Call graph*: calls 1 internal fn (url_for_path); called by 2 (connect, probe_handshake); 1 external calls (parse).


##### `is_azure_responses_provider`  (lines 106–114)

```
fn is_azure_responses_provider(name: &str, base_url: Option<&str>) -> bool
```

**Purpose**: Determines whether a provider should be classified as Azure based on either an explicit provider name or recognizable Azure URL patterns. This lets callers detect Azure even when the provider name is generic.

**Data flow**: Reads the `name` string first and returns `true` if it equals `azure` ignoring ASCII case. Otherwise, if `base_url` is present, it passes that string to `matches_azure_responses_base_url`; if no URL is provided, it returns `false`.

**Call relations**: This is the shared predicate behind `Provider::is_azure_responses_endpoint`. It delegates hostname/path pattern matching to `matches_azure_responses_base_url` when name-based detection does not already decide the result.

*Call graph*: calls 1 internal fn (matches_azure_responses_base_url); called by 1 (is_azure_responses_endpoint).


##### `matches_azure_responses_base_url`  (lines 116–127)

```
fn matches_azure_responses_base_url(base_url: &str) -> bool
```

**Purpose**: Checks a base URL string for a fixed set of Azure-specific host and path markers associated with Azure OpenAI-style deployments. The match is substring-based and case-insensitive.

**Data flow**: Lowercases the `base_url` input, then scans it for any of six constant markers such as `openai.azure.`, `cognitiveservices.azure.`, `azurefd.`, and `windows.net/openai`. It returns `true` on the first contained marker and `false` otherwise.

**Call relations**: This helper is only reached through `is_azure_responses_provider`, where it supplies URL-based Azure detection after the provider name check fails.

*Call graph*: called by 1 (is_azure_responses_provider).


##### `tests::detects_azure_responses_base_urls`  (lines 134–168)

```
fn detects_azure_responses_base_urls()
```

**Purpose**: Verifies the Azure detection heuristics against representative positive and negative URLs, plus the explicit provider-name override. It documents the accepted Azure host variants and a few near-miss cases that must not match.

**Data flow**: Builds arrays of positive and negative URL literals, feeds them into `is_azure_responses_provider`, and asserts the expected boolean result for each case. It also checks that the provider name `Azure` forces a positive result even with a non-Azure URL.

**Call relations**: This test exercises the public detection path rather than the private matcher directly, ensuring the combined name-first and URL-fallback logic behaves as intended.

*Call graph*: 1 external calls (assert!).


### `codex-api/src/endpoint/session.rs`

`orchestration` · `cross-cutting request setup`

This file defines `EndpointSession<T>`, the common transport wrapper that endpoint-specific clients build on. It owns four pieces of state: the concrete `HttpTransport`, the resolved `Provider`, the shared auth provider, and optional request telemetry. The type is intentionally generic over transport so tests and alternate backends can reuse the same endpoint logic.

The session's responsibilities are request construction and execution policy. `make_request` starts from `provider.build_request(method, path)`, merges caller-supplied headers, and optionally attaches a cloned `RequestBody`. `provider()` exposes the stored provider so endpoint clients can inspect endpoint-specific capabilities such as Azure behavior or idle timeout.

There are two execution paths. `execute` is the simple JSON request wrapper and just forwards to `execute_with` with a no-op configurator. `execute_with` converts an optional `serde_json::Value` into `RequestBody::Json`, builds a closure that reconstructs the request each retry attempt, lets the caller mutate the `Request` via `configure`, and then runs the request through `run_with_request_telemetry`. Inside the transport closure, auth is applied asynchronously with `auth.apply_auth`, auth failures are converted into `TransportError`, and the prepared request is sent with `transport.execute`.

`stream_encoded_json_with` is the streaming counterpart for pre-encoded JSON bodies. It builds the request once, applies caller configuration, converts it into a prepared request up front with `into_prepared()` so retries can clone an identical request, and then uses the same telemetry/retry wrapper around `transport.stream`. The design keeps endpoint files focused on endpoint-specific paths and headers while centralizing auth, retries, and request shaping here.

#### Function details

##### `EndpointSession::new`  (lines 27–34)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a new endpoint session from transport, provider, and auth state. It initializes request telemetry as absent.

**Data flow**: Consumes `transport: T`, `provider: Provider`, and `auth: SharedAuthProvider`, stores them in `EndpointSession`, sets `request_telemetry` to `None`, and returns the session.

**Call relations**: This constructor is called by multiple endpoint clients during their own `new` methods. It is the common root for all authenticated HTTP interactions in this crate.

*Call graph*: called by 7 (new, new, new, new, new, new, new).


##### `EndpointSession::with_request_telemetry`  (lines 36–42)

```
fn with_request_telemetry(
        mut self,
        request: Option<Arc<dyn RequestTelemetry>>,
    ) -> Self
```

**Purpose**: Attaches optional request telemetry to the session in builder style. It allows endpoint clients to opt into instrumentation without mutating shared state in place.

**Data flow**: Consumes `mut self` and `request: Option<Arc<dyn RequestTelemetry>>`, assigns the telemetry into `self.request_telemetry`, and returns the updated session.

**Call relations**: This method is called by endpoint-specific `with_telemetry` builders. The stored telemetry is later consumed by `execute_with` and `stream_encoded_json_with` through `run_with_request_telemetry`.

*Call graph*: called by 7 (with_telemetry, with_telemetry, with_telemetry, with_telemetry, with_telemetry, with_telemetry, with_telemetry).


##### `EndpointSession::provider`  (lines 44–46)

```
fn provider(&self) -> &Provider
```

**Purpose**: Exposes the resolved provider configuration stored in the session. Endpoint clients use it to inspect provider-specific behavior and timeouts.

**Data flow**: Borrows `self` and returns `&Provider`.

**Call relations**: This accessor is used by higher-level endpoint clients such as the responses client when they need provider metadata without duplicating storage.

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

**Purpose**: Builds a `codex_client::Request` from provider defaults, caller headers, and an optional body. It is the shared request-construction primitive for both execute and stream paths.

**Data flow**: Accepts `method`, `path`, `extra_headers`, and optional `&RequestBody`. It calls `self.provider.build_request(method.clone(), path)`, extends the request headers with a clone of `extra_headers`, clones the body into `req.body` when present, and returns the assembled `Request`.

**Call relations**: This helper is used directly by `stream_encoded_json_with` and indirectly by `execute_with` through its `make_request` closure. It centralizes provider-based request initialization.

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

**Purpose**: Sends a standard JSON request without any extra request customization. It is the convenience wrapper used by simple endpoints.

**Data flow**: Accepts HTTP `method`, `path`, `extra_headers`, and optional JSON `Value`, then forwards them to `execute_with` with a no-op configurator closure. It returns the resulting `Response` or `ApiError`.

**Call relations**: This method is called by endpoint clients like search and other non-streaming APIs. It exists so those callers do not need to supply an explicit configure closure.

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

**Purpose**: Executes a JSON request with retry, auth application, optional request mutation, and request telemetry. It is the main non-streaming orchestration path for endpoint clients.

**Data flow**: Takes HTTP `method`, `path`, `extra_headers`, optional JSON `Value`, and a `configure` closure. It wraps the JSON body as `RequestBody::Json`, defines `make_request` to call `self.make_request(...)` and then apply `configure`, and passes that plus the provider retry policy and optional telemetry into `run_with_request_telemetry`. For each attempt, the async transport closure clones auth, applies it with `auth.apply_auth(req)`, maps auth failures into `TransportError`, and calls `transport.execute(req)`. The awaited result is returned as `Response` or propagated as `ApiError`.

**Call relations**: This method underpins `execute` and is also called directly by endpoint clients that need to tweak the outgoing request. It is the central place where retries, telemetry, auth, and transport execution are wired together.

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

**Purpose**: Executes a streaming request whose JSON body has already been encoded, with retry, auth, and request customization. It is the streaming counterpart to `execute_with`.

**Data flow**: Accepts HTTP `method`, `path`, `extra_headers`, optional `EncodedJsonBody`, and a `configure` closure. It wraps the body as `RequestBody::EncodedJson`, builds a request with `make_request`, applies `configure`, converts the request into a prepared form with `into_prepared()` so it can be cloned safely across retries, and defines `make_request` as `|| request.clone()`. It then calls `run_with_request_telemetry` with the provider retry policy and optional telemetry; each attempt applies auth asynchronously and invokes `transport.stream(req)`. The resulting `StreamResponse` is returned or mapped into `ApiError`.

**Call relations**: This method is called by higher-level streaming clients such as `ResponsesClient::stream_encoded`. It centralizes the prepared-request requirement and retry/auth behavior for streaming transports.

*Call graph*: calls 2 internal fn (make_request, run_with_request_telemetry); called by 1 (stream_encoded).


### `codex-api/src/endpoint/mod.rs`

`orchestration` · `cross-cutting`

This module is the public façade over the crate’s endpoint implementations. It declares submodules for compacting, images, memories, models, realtime call transport, realtime websocket transport, standard responses, websocket responses, and search, plus a private `session` helper module. It then re-exports the concrete client types from those modules—such as `CompactClient`, `ImagesClient`, `ResponsesClient`, `SearchClient`, and the realtime websocket/call clients—so callers can construct and use endpoint-specific APIs without depending on the internal directory structure.

Beyond client structs, the file also re-exports endpoint-specific protocol and connection types that are part of the usable surface: realtime websocket parsers and session configuration enums, websocket connection/writer/event stream types, websocket close/probe helpers for responses, and the `session_update_session_json` helper used to build realtime session update payloads. The design choice here is separation of concerns: endpoint implementations remain in dedicated modules, while this file defines the stable namespace that `codex-api` exposes upward through its crate root. There is no runtime logic, but the export list is semantically important because it determines which endpoint capabilities are considered supported and discoverable by downstream code.


### `codex-api/src/requests/mod.rs`

`orchestration` · `request handling`

This module is a small organizational layer over request-building code. It declares two submodules: `headers`, which contains logic for constructing outbound HTTP or websocket headers, and `responses`, which contains request assembly helpers specific to the responses API. From those modules it publicly re-exports `Compression`, making the request compression choice part of the crate’s external API, while only crate-internally re-exporting `attach_item_ids` for use by other internal request-building code.

The distinction between `pub use` and `pub(crate) use` is the key design detail. `Compression` is intended for callers configuring outbound requests, so it is surfaced publicly. `attach_item_ids`, by contrast, is treated as implementation plumbing: other modules in the crate can share it, but external consumers are prevented from coupling to that helper. This file therefore acts as a narrow visibility gate rather than a logic-bearing module. Its role in the runtime is indirect but important during request assembly, because it centralizes where request helper capabilities are exposed and preserves a clean public API boundary around internal request mutation details.


### Streaming and upload helpers
These files cover specialized API-side transport helpers for SSE exposure, realtime websocket event parsing, and file upload workflows.

### `codex-api/src/sse/mod.rs`

`orchestration` · `request handling`

This module is a thin namespace and re-export layer for SSE handling in the API crate. It declares a single internal submodule, `responses`, and then selectively republishes the pieces that other parts of the crate or downstream crates are expected to use: the `ResponsesStreamEvent` event type, the `process_responses_event` helper, and the public `spawn_response_stream` entrypoint. The visibility split is intentional: `responses` itself stays crate-private, while the specific items form the stable interface for consuming streamed response events. Because there is no logic in this file, its main architectural role is to keep the SSE implementation physically isolated while presenting a compact API at `codex_api::sse`. That arrangement also makes it clear that the crate currently centers SSE support around response streaming specifically, rather than a broader event framework. Readers should treat this file as the module boundary that defines what the rest of the system is allowed to know about SSE internals.


### `codex-api/src/endpoint/realtime_websocket/protocol_common.rs`

`util` · `request handling`

This file contains small parser utilities shared by the v1 and v2 realtime event decoders. Rather than duplicating JSON decoding and field extraction logic in each parser, it centralizes the common pieces here.

`parse_realtime_payload` is the entry helper: it attempts to deserialize the raw websocket text into `serde_json::Value`, logs a debug message and returns `None` on malformed JSON, then extracts the top-level `type` field as a `String`. If the `type` field is missing or not a string, it also logs and returns `None`. Successful callers receive both the parsed JSON tree and the message type string.

The remaining helpers each extract one common event shape from a parsed JSON value. `parse_session_updated_event` reads `session.id` and optional `session.instructions` and returns `RealtimeEvent::SessionUpdated`. `parse_transcript_delta_event` and `parse_transcript_done_event` read a named string field and wrap it in `RealtimeTranscriptDelta` or `RealtimeTranscriptDone`. `parse_error_event` is intentionally tolerant: it first looks for a top-level `message`, then `error.message`, then falls back to serializing the entire `error` field if present, finally wrapping the chosen string in `RealtimeEvent::Error`.

These helpers are pure and side-effect free except for debug logging on malformed payloads, making them easy building blocks for the version-specific parsers.

#### Function details

##### `parse_realtime_payload`  (lines 7–25)

```
fn parse_realtime_payload(payload: &str, parser_name: &str) -> Option<(Value, String)>
```

**Purpose**: Parses a raw websocket payload into JSON and extracts its top-level event type string.

**Data flow**: Takes `payload: &str` and `parser_name: &str` → attempts `serde_json::from_str(payload)` into `Value`; on failure logs and returns `None` → reads `parsed["type"]` as `&str`; if missing logs and returns `None` → returns `Some((parsed, message_type.to_string()))`.

**Call relations**: Used by both `parse_realtime_event_v1` and `parse_realtime_event_v2` as their common first step before event-specific matching.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 2 external calls (debug!, from_str).


##### `parse_session_updated_event`  (lines 27–44)

```
fn parse_session_updated_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: Extracts a `SessionUpdated` event from a parsed JSON payload when `session.id` is present.

**Data flow**: Reads `parsed["session"]["id"]` as a string and optional `parsed["session"]["instructions"]` → if `id` exists returns `RealtimeEvent::SessionUpdated { realtime_session_id, instructions }`, otherwise returns `None`.

**Call relations**: Called by both version-specific parsers for `session.updated` events.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


##### `parse_transcript_delta_event`  (lines 46–55)

```
fn parse_transcript_delta_event(
    parsed: &Value,
    field: &str,
) -> Option<RealtimeTranscriptDelta>
```

**Purpose**: Extracts a transcript delta string from a named field and wraps it in `RealtimeTranscriptDelta`.

**Data flow**: Takes `parsed: &Value` and `field: &str` → reads `parsed[field]` as `&str` → returns `Some(RealtimeTranscriptDelta { delta })` or `None`.

**Call relations**: Used by both parsers for input/output transcript delta event variants.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


##### `parse_transcript_done_event`  (lines 57–66)

```
fn parse_transcript_done_event(
    parsed: &Value,
    field: &str,
) -> Option<RealtimeTranscriptDone>
```

**Purpose**: Extracts a finalized transcript string from a named field and wraps it in `RealtimeTranscriptDone`.

**Data flow**: Takes `parsed: &Value` and `field: &str` → reads `parsed[field]` as `&str` → returns `Some(RealtimeTranscriptDone { text })` or `None`.

**Call relations**: Used by both parsers for transcript completion event variants.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


##### `parse_error_event`  (lines 68–83)

```
fn parse_error_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: Normalizes several possible JSON error shapes into `RealtimeEvent::Error`.

**Data flow**: Reads `parsed["message"]`, then `parsed["error"]["message"]`, then falls back to `parsed["error"].to_string()` if present → wraps the chosen string in `RealtimeEvent::Error` → returns `Option<RealtimeEvent>`.

**Call relations**: Used by both version-specific parsers when handling error event payloads.

*Call graph*: called by 2 (parse_realtime_event_v1, parse_realtime_event_v2); 1 external calls (get).


### `codex-api/src/files.rs`

`io_transport` · `file upload`

This file contains the complete multi-step OpenAI file upload workflow. It defines constants for the canonical URI prefix (`sediment://`), the 512 MiB upload limit, request/finalization timeouts, retry delay, and the fixed use case string `codex`. `UploadedOpenAiFile` is the success payload returned to callers, while `OpenAiFileError` enumerates validation, request, status, decode, not-ready, and finalization-failed cases.

`upload_openai_file` performs three sequential phases. First it validates `file_size_bytes` against `OPENAI_FILE_UPLOAD_LIMIT_BYTES`. Then it creates the upload by POSTing authenticated JSON to `{base_url}/files`, expecting a `CreateFileResponse` containing `file_id` and `upload_url`. Next it uploads the raw bytes to the returned blob URL with a plain reqwest client, setting `x-ms-blob-type: BlockBlob`, `Content-Length`, a 60-second timeout, and streaming the provided `Stream<Item = io::Result<Bytes>>` via `reqwest::Body::wrap_stream`.

Finally it polls `{base_url}/files/{file_id}/uploaded` until the server reports `status: "success"`, `status: "retry"` until a 30-second deadline expires, or any other status indicating failure. On success it constructs `UploadedOpenAiFile`, deriving `uri` from `openai_file_uri`, preserving the original file size, defaulting `file_name` to the caller's original name if omitted, and requiring `download_url` to be present. `authorized_request` centralizes auth-header injection for API-hosted requests, while `build_reqwest_client` applies custom CA configuration and falls back to `reqwest::Client::new()` with a warning if custom TLS setup fails. The test exercises the full happy path, including one retry during finalization and canonical URI generation.

#### Function details

##### `openai_file_uri`  (lines 80–82)

```
fn openai_file_uri(file_id: &str) -> String
```

**Purpose**: Builds the canonical OpenAI file URI used by the rest of the system to reference uploaded files. It simply prefixes the file ID with `sediment://`.

**Data flow**: Accepts `file_id: &str`, formats `"{OPENAI_FILE_URI_PREFIX}{file_id}"`, and returns the resulting `String`.

**Call relations**: This helper is called by `upload_openai_file` after successful finalization so the returned `UploadedOpenAiFile` includes the canonical URI.

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

**Purpose**: Executes the full OpenAI file upload lifecycle: create upload session, stream file contents to the returned upload URL, and poll finalization until the file is ready or fails. It is the main runtime API in this file.

**Data flow**: Takes `base_url`, an auth provider, `file_name`, `file_size_bytes`, and a byte stream of file contents. It first rejects oversized files with `OpenAiFileError::FileTooLarge`. It then POSTs authenticated JSON to `{base_url}/files`, parses `CreateFileResponse`, uploads the content stream with a PUT to `upload_url` using `build_reqwest_client`, and checks each HTTP status for success. After upload, it repeatedly POSTs `{}` to `{base_url}/files/{file_id}/uploaded`, parsing `DownloadLinkResponse` each time. `status == "success"` returns `UploadedOpenAiFile` with canonical URI, required `download_url`, fallback `file_name`, original size, and optional MIME type; `status == "retry"` sleeps `OPENAI_FILE_FINALIZE_RETRY_DELAY` until `OPENAI_FILE_FINALIZE_TIMEOUT` elapses, then returns `UploadNotReady`; any other status returns `UploadFailed` using `error_message` or a default message. Request send failures, non-success HTTP statuses, and JSON decode failures are mapped into the corresponding `OpenAiFileError` variants with the relevant URL attached.

**Call relations**: This function is the top-level upload workflow exercised by the integration-style test in this file. It delegates authenticated API request construction to `authorized_request`, raw upload client creation to `build_reqwest_client`, and URI formatting to `openai_file_uri`.

*Call graph*: calls 3 internal fn (authorized_request, build_reqwest_client, openai_file_uri); called by 1 (upload_openai_file_returns_canonical_uri); 6 external calls (now, wrap_stream, format!, from_str, json!, sleep).


##### `authorized_request`  (lines 215–228)

```
fn authorized_request(
    auth: &dyn AuthProvider,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder
```

**Purpose**: Builds a reqwest request builder with auth headers and the standard file-request timeout already applied. It is used for the API-hosted create and finalize calls.

**Data flow**: Accepts an auth provider, HTTP method, and URL. It creates a fresh `http::HeaderMap`, asks `auth.add_auth_headers(&mut headers)` to populate it, obtains a client from `build_reqwest_client()`, and returns `client.request(method, url).timeout(OPENAI_FILE_REQUEST_TIMEOUT).headers(headers)`.

**Call relations**: This helper is called by `upload_openai_file` for the create-upload-session and finalize-poll POST requests. It keeps auth/header setup consistent across those API calls.

*Call graph*: calls 1 internal fn (build_reqwest_client); called by 1 (upload_openai_file); 2 external calls (add_auth_headers, new).


##### `build_reqwest_client`  (lines 230–235)

```
fn build_reqwest_client() -> reqwest::Client
```

**Purpose**: Creates the reqwest client used for file API and blob-upload requests, honoring any configured custom CA bundle when possible. It falls back to the default reqwest client if custom TLS setup fails.

**Data flow**: Starts from `reqwest::Client::builder()`, passes it to `build_reqwest_client_with_custom_ca`, and returns the resulting client on success. If custom-CA setup returns an error, it logs a warning and returns `reqwest::Client::new()` instead.

**Call relations**: This helper is used by both `authorized_request` and the raw upload phase inside `upload_openai_file`. It centralizes TLS policy for all file-upload HTTP traffic.

*Call graph*: called by 2 (authorized_request, upload_openai_file); 2 external calls (builder, build_reqwest_client_with_custom_ca).


##### `tests::ChatGptTestAuth::add_auth_headers`  (lines 258–264)

```
fn add_auth_headers(&self, headers: &mut reqwest::header::HeaderMap)
```

**Purpose**: Adds deterministic authorization headers for the file-upload test server. It simulates the auth shape expected by the backend API.

**Data flow**: Receives a mutable reqwest `HeaderMap` and inserts `Authorization: Bearer token` plus `ChatGPT-Account-ID: account_id`.

**Call relations**: This test auth provider is used by `authorized_request` during `upload_openai_file_returns_canonical_uri`, allowing the mock server to assert on expected headers.

*Call graph*: 2 external calls (insert, from_static).


##### `tests::chatgpt_auth`  (lines 267–269)

```
fn chatgpt_auth() -> ChatGptTestAuth
```

**Purpose**: Returns the test auth provider value used by file-upload tests. It is a tiny convenience constructor.

**Data flow**: Takes no arguments and returns `ChatGptTestAuth`.

**Call relations**: This helper is called by the upload test when invoking `upload_openai_file`.


##### `tests::base_url_for`  (lines 271–273)

```
fn base_url_for(server: &MockServer) -> String
```

**Purpose**: Builds the backend API base URL for a wiremock server. It mirrors the production expectation that file endpoints live under `/backend-api`.

**Data flow**: Accepts `&MockServer`, formats `"{server.uri()}/backend-api"`, and returns the resulting `String`.

**Call relations**: This helper is used by the upload test to produce the `base_url` argument passed into `upload_openai_file`.

*Call graph*: 1 external calls (format!).


##### `tests::upload_openai_file_returns_canonical_uri`  (lines 276–343)

```
async fn upload_openai_file_returns_canonical_uri()
```

**Purpose**: Exercises the happy-path file upload flow against a mock server, including one finalization retry and canonical URI generation. It validates request shapes, auth headers, and the returned `UploadedOpenAiFile` fields.

**Data flow**: Starts a `MockServer`, installs mocks for the create POST, blob PUT, and finalize POST endpoints, with the finalize responder returning `status: "retry"` once and `status: "success"` on the second call. It builds the backend base URL, creates a one-chunk byte stream containing `hello`, calls `upload_openai_file`, awaits success, and asserts the returned file ID, `sediment://` URI, download URL, file name, MIME type, and that finalization was attempted twice.

**Call relations**: This test drives the full runtime path through `upload_openai_file`, indirectly exercising `authorized_request`, `build_reqwest_client`, and `openai_file_uri` while validating the polling behavior.

*Call graph*: calls 1 internal fn (upload_openai_file); 17 external calls (clone, new, new, from_static, given, start, new, assert_eq!, base_url_for, chatgpt_auth (+7 more)).
