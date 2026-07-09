# Public API request and transport schemas  `stage-18.4.2`

This stage defines the public “shapes” of data that move into and out of the Codex API. It sits at the boundary of the system: when outside code sends a request, receives a reply, or talks over a network connection, these types describe exactly what that data should look like.

The crate root, lib.rs, is the front desk. It gathers the important public pieces and re-exports them so other parts of the code can use one stable API instead of digging through internal folders.

common.rs provides the shared building blocks used across many endpoints, such as standard request and response formats, controls for text output, and the event messages used during streaming. error.rs defines one common error type so different failure cases—network trouble, bad protocol messages, rate limits, and API-specific problems—can be reported in a consistent way.

The other files cover specific transport styles and features. protocol.rs defines the realtime WebSocket message formats and routes incoming events to the right parser. images.rs describes image generation and editing payloads. search.rs defines the richer search commands and results, from web lookups to weather and finance. Together, these files make the API boundary predictable and safe.

## Files in this stage

### Crate surface
The crate root establishes the public API surface and re-exports the transport and schema types used by consumers.

### `codex-api/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the main public boundary of the `codex-api` crate. It declares internal modules for authentication, endpoint clients, request construction, provider selection, files, images, search, SSE/websocket telemetry, and error mapping, then re-exports a curated set of items from those modules and from dependent crates. The result is a single import surface through which consumers can access transport primitives (`ReqwestTransport`, `TransportError`), auth abstractions (`AuthProvider`, `SharedAuthProvider`, telemetry helpers), endpoint clients (`ResponsesClient`, `RealtimeWebsocketClient`, `ImagesClient`, `SearchClient`, etc.), request-building helpers (`build_session_headers`, `create_text_param_for_request`, websocket metadata helpers), and all major request/response data models for common, image, and search APIs.

It also re-exports lower-level protocol event types from `codex_protocol`, bridging the API client layer with the underlying realtime protocol definitions. The file’s design is intentionally selective: many modules remain `pub(crate)`, while only stable, consumer-relevant items are surfaced. That means this file effectively defines the crate’s compatibility contract and package ergonomics. There is no control flow here, but the export curation matters operationally: downstream code depends on this file to discover supported features, while internal refactors can proceed behind the stable re-export layer without changing consumer imports.


### Shared transport models
These files define the common error and cross-endpoint request/response shapes that underpin the public API and streaming transports.

### `codex-api/src/common.rs`

`data_model` · `request construction and streaming`

This module is the common schema layer for `codex-api`. Most of the file is made of serializable/deserializable structs and enums that mirror wire payloads: `CompactionInput`, `MemorySummarizeInput`, `RawMemory`, `MemorySummarizeOutput`, `ResponsesApiRequest`, `ResponseCreateWsRequest`, `ResponsesWsRequest`, and the streamed `ResponseEvent` enum. The serde annotations are important: optional fields are omitted when absent, `MemorySummarizeInput.raw_memories` is serialized as `traces`, and `MemorySummarizeOutput.raw_memory` accepts either `trace_summary` or legacy `raw_memory` on input.

A few helper functions encode policy. `OpenAiVerbosity::from` maps protocol verbosity config into the lowercase OpenAI-specific enum used in request JSON. `ResponseCreateWsRequest::from(&ResponsesApiRequest)` clones the HTTP request shape into the websocket create shape, explicitly setting `previous_response_id` and `generate` to `None`. `response_create_client_metadata` merges optional caller metadata with optional W3C trace context by inserting reserved metadata keys for `traceparent` and `tracestate`, returning `None` if the final map is empty. `create_text_param_for_request` builds the optional `text` control block only when verbosity or an output schema is requested, and names schema-based formatting `codex_output_schema`.

Finally, `ResponseStream` wraps a Tokio MPSC receiver of `Result<ResponseEvent, ApiError>` and implements `futures::Stream` by delegating polling to `poll_recv`, making endpoint-specific stream producers look like standard async streams to consumers.

#### Function details

##### `OpenAiVerbosity::from`  (lines 173–179)

```
fn from(v: VerbosityConfig) -> Self
```

**Purpose**: Maps the protocol-level verbosity configuration enum into the OpenAI wire enum used in serialized `text.verbosity` fields.

**Data flow**: Consumes a `VerbosityConfig` and returns the corresponding `OpenAiVerbosity` variant (`Low`, `Medium`, or `High`). It is a pure enum translation with no side effects.

**Call relations**: Used indirectly by request-building helpers such as `create_text_param_for_request` when converting higher-level config into API payloads.


##### `ResponseCreateWsRequest::from`  (lines 206–225)

```
fn from(request: &ResponsesApiRequest) -> Self
```

**Purpose**: Clones a standard Responses API request into the websocket `response.create` payload shape.

**Data flow**: Reads all fields from a borrowed `ResponsesApiRequest`, clones owned strings, vectors, optional structs, and metadata maps into a new `ResponseCreateWsRequest`, and explicitly sets `previous_response_id` and `generate` to `None`. It returns the new websocket request object without mutating the source.

**Call relations**: Called by websocket streaming code to reuse the same logical request content across HTTP and websocket transports while adapting to the websocket-specific envelope.

*Call graph*: called by 1 (stream_responses_websocket).


##### `response_create_client_metadata`  (lines 255–275)

```
fn response_create_client_metadata(
    client_metadata: Option<HashMap<String, String>>,
    trace: Option<&W3cTraceContext>,
) -> Option<HashMap<String, String>>
```

**Purpose**: Merges caller-supplied client metadata with optional W3C trace context for websocket request propagation.

**Data flow**: Starts from the provided metadata map or an empty one, conditionally inserts reserved keys for `traceparent` and `tracestate` when present in the supplied `W3cTraceContext`, and returns `Some(map)` only if the final map is non-empty; otherwise it returns `None`.

**Call relations**: Used during request construction for websocket response creation so tracing headers can be tunneled through `client_metadata` without overwriting unrelated caller metadata.


##### `create_text_param_for_request`  (lines 285–303)

```
fn create_text_param_for_request(
    verbosity: Option<VerbosityConfig>,
    output_schema: &Option<Value>,
    output_schema_strict: bool,
) -> Option<TextControls>
```

**Purpose**: Builds the optional `text` request block that combines verbosity controls and JSON-schema output formatting.

**Data flow**: Takes optional verbosity, optional output schema, and a strictness flag. If both optional inputs are absent it returns `None`. Otherwise it returns `Some(TextControls)` where `verbosity` is converted via `Into<OpenAiVerbosity>` and `format` is populated from the schema with type `JsonSchema`, the provided strictness, a cloned schema value, and fixed name `codex_output_schema`.

**Call relations**: This helper encapsulates the rule that the `text` field should be omitted entirely unless at least one text control is requested, keeping endpoint request builders consistent.


##### `ResponseStream::poll_next`  (lines 314–316)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements the `Stream` trait for `ResponseStream` by polling the underlying Tokio receiver.

**Data flow**: Takes a pinned mutable reference to `ResponseStream` and a task context, calls `self.rx_event.poll_recv(cx)`, and returns the resulting `Poll<Option<Result<ResponseEvent, ApiError>>>`. It does not transform items or mutate any state beyond receiver progress.

**Call relations**: This is the adapter that lets endpoint-specific producers expose `ResponseStream` as a standard `futures::Stream` to downstream consumers.

*Call graph*: 1 external calls (poll_recv).


### `codex-api/src/error.rs`

`data_model` · `cross-cutting`

This file is the central error model for the API layer. `ApiError` is an enum deriving `thiserror::Error`, so each variant carries both structured data and a human-readable display message. The variants cover low-level transport failures (`Transport(TransportError)`), HTTP-style API failures with explicit status and message, generic stream failures, several semantic conditions (`ContextWindowExceeded`, `QuotaExceeded`, `UsageNotIncluded`, `ServerOverloaded`), retryable failures with optional backoff delay, rate-limit failures, invalid requests, and cyber-policy rejections.

The design separates transport-originated failures from higher-level semantic ones so endpoint code can preserve HTTP metadata when available while still surfacing domain-specific conditions in a typed way. The `Retryable` variant is especially important for websocket and streaming code that may need to signal reconnect-worthy failures without pretending they were ordinary HTTP responses.

The only handwritten behavior in the file is a `From<RateLimitError>` implementation. Rather than preserving the source type directly, it stringifies the `RateLimitError` and stores it in `ApiError::RateLimit`. That keeps the public error surface uniform across modules that parse rate-limit payloads differently but want to expose a single API-layer error type.

#### Function details

##### `ApiError::from`  (lines 37–39)

```
fn from(err: RateLimitError) -> Self
```

**Purpose**: Converts a `RateLimitError` into the public `ApiError` type by wrapping its display text in `ApiError::RateLimit`. It standardizes rate-limit failures at the API boundary.

**Data flow**: Consumes `err: RateLimitError`, calls `err.to_string()`, and returns `ApiError::RateLimit` containing that message string.

**Call relations**: This conversion is used implicitly wherever code returns `Result<_, ApiError>` and encounters a `RateLimitError`. It bridges rate-limit parsing logic into the crate's shared error enum.

*Call graph*: 2 external calls (RateLimit, to_string).


### Realtime websocket protocol
This file specializes the shared models into the realtime websocket protocol and routes inbound events to version-specific parsing.

### `codex-api/src/endpoint/realtime_websocket/protocol.rs`

`data_model` · `request handling`

This file is the type hub for realtime websocket messaging. It re-exports the externally meaningful protocol types from `codex_protocol`—such as `RealtimeAudioFrame`, `RealtimeEvent`, `RealtimeOutputModality`, `RealtimeTranscriptEntry`, and `RealtimeVoice`—and defines the local enums and structs needed to serialize outbound websocket messages.

`RealtimeEventParser` selects between the legacy `V1` parser and `RealtimeV2`, while `RealtimeSessionMode` distinguishes conversational from transcription sessions. `RealtimeSessionConfig` packages all caller-supplied session bootstrap inputs: instructions, optional model, optional session ID, parser version, session mode, output modality, and voice.

The rest of the file is mostly data model: `RealtimeOutboundMessage` enumerates the supported outbound websocket commands (`input_audio_buffer.append`, `conversation.handoff.append`, `response.create`, `session.update`, and `conversation.item.create`). Supporting structs model the nested JSON for session updates, audio formats, turn detection, tools, conversation items, and function-call outputs, with serde attributes controlling exact field names and omission of `None` values. These types are consumed by the version-specific builders in `methods_v1` and `methods_v2`.

The only behavior here is `parse_realtime_event`, which dispatches raw text payloads to either `parse_realtime_event_v1` or `parse_realtime_event_v2` based on `RealtimeEventParser`. That keeps the receive loop version-agnostic while centralizing parser selection in one place.

#### Function details

##### `parse_realtime_event`  (lines 215–223)

```
fn parse_realtime_event(
    payload: &str,
    event_parser: RealtimeEventParser,
) -> Option<RealtimeEvent>
```

**Purpose**: Dispatches a raw realtime websocket payload to the appropriate version-specific parser.

**Data flow**: Takes `payload: &str` and `event_parser: RealtimeEventParser` → calls `parse_realtime_event_v1(payload)` for `V1` or `parse_realtime_event_v2(payload)` for `RealtimeV2` → returns `Option<RealtimeEvent>`.

**Call relations**: Called by `RealtimeWebsocketEvents::next_event` after a text websocket frame is received, allowing the event loop to remain agnostic to protocol-version parsing details.

*Call graph*: calls 2 internal fn (parse_realtime_event_v1, parse_realtime_event_v2); called by 1 (next_event).


### Endpoint payload schemas
These endpoint-specific schema modules define the request and response payloads for image and search APIs.

### `codex-api/src/images.rs`

`data_model` · `request handling`

This file is the image API schema layer. It defines two outbound request structs: `ImageGenerationRequest` for prompt-only generation and `ImageEditRequest` for prompt-guided edits over one or more existing images. Both requests carry a `prompt`, `model`, and optional tuning fields such as `background`, `n`, `quality`, and `size`; the edit request additionally requires `images: Vec<ImageUrl>`, making the source images explicit and strongly typed rather than passing raw strings. Optional fields are omitted from serialized JSON when absent, which keeps requests minimal and lets server defaults apply.

Supporting enums `ImageBackground` and `ImageQuality` are serialized/deserialized in lowercase, fixing the wire vocabulary to values like `transparent`, `opaque`, `low`, `medium`, and `high`. `ImageUrl` wraps an `image_url: String`, clarifying intent at the type level. On the inbound side, `ImageResponse` models the server reply with a creation timestamp, a vector of `ImageData` items containing `b64_json` image payloads, and optional echoed metadata for background, quality, and size. Those metadata fields use `#[serde(default)]`, so deserialization succeeds even when older or variant responses omit them. The file intentionally contains no endpoint logic; its value lies in the exact JSON contract and in preserving distinctions between generation inputs, edit inputs, and returned binary image data encoded as base64 JSON strings.


### `codex-api/src/search.rs`

`data_model` · `request handling`

This file is the search subsystem’s data model. `SearchRequest` is the top-level outbound payload, carrying a request `id`, target `model`, optional `Reasoning`, optional `input`, optional batched `commands`, optional `settings`, and an optional `max_output_tokens` cap. `SearchInput` is intentionally untagged, allowing either raw text or a vector of `codex_protocol::models::ResponseItem` values to serialize directly as the input body shape expected by the API.

The core of the file is `SearchCommands`, a schema-friendly struct whose optional fields each represent a category of operation: text search, image search, page open/click/find/screenshot, finance, weather, sports, time, and response-length selection. Each operation has its own strongly typed struct or enum with serde attributes that lock down wire names and omit absent optional filters. Several types derive `JsonSchema`, signaling that these command shapes are intended to be surfaced to tooling or model-facing schema generation. `SearchSettings` adds execution context such as approximate user location, context size, domain filters, image settings, allowed callers, and whether external web access is permitted. The response side is deliberately minimal: `SearchResponse` contains optional `encrypted_output` plus plain `output`. A notable design choice is the breadth of typed enums—`FinanceAssetType`, `SportsFunction`, `SportsLeague`, `SearchResponseLength`, `AllowedCaller`, and others—which constrain legal values at compile time and ensure stable serialized vocabularies across many heterogeneous search operations.
