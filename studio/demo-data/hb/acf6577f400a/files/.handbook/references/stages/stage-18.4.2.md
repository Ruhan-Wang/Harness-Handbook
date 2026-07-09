# Public API request and transport schemas  `stage-18.4.2`

This stage is the public “language” of the Codex API layer. It is shared behind-the-scenes support used whenever the program sends requests to external services or reads their replies. Instead of each caller inventing its own message format, these files define the agreed shapes of those messages.

The library front door, lib.rs, decides what parts of this API package are visible to the rest of the codebase. common.rs provides the everyday forms for the Responses API: requests, responses, streamed events, and extra metadata such as tracing details used to follow a request through the system. error.rs gives all API code one common way to describe failures, such as bad requests, network trouble, or rate limits.

The remaining files cover specific transports or features. protocol.rs defines realtime WebSocket messages, which are two-way live messages, and selects the right parser for different protocol versions. images.rs defines image generation and editing payloads. search.rs defines request and reply formats for web, image, finance, weather, sports, time, and page-navigation searches.

## Files in this stage

### Crate surface
The crate root establishes the public API surface and re-exports the transport and schema types used by consumers.

### `codex-api/src/lib.rs`

`other` · `cross-cutting`

This file does not contain the API logic itself. Instead, it acts like the reception desk for the whole `codex-api` crate, which is Rust’s name for a library package. First, it declares the internal modules, such as authentication, endpoints, files, images, search, streaming events, and telemetry. These modules contain the real code for talking to API services and shaping requests and responses.

Then it re-exports selected items from those modules. A re-export means outside code can import important pieces from `codex_api` directly, without needing to know the exact internal file where each one lives. For example, callers can get clients like `ResponsesClient`, authentication types like `AuthProvider`, request and response data types, image and search types, telemetry helpers, and transport errors from this single public surface.

This matters because it keeps the rest of the project from depending on the library’s private folder layout. If the internal modules are like rooms in a building, this file is the signboard in the lobby: it tells users which doors are available and gives them stable names to use. Without it, callers would either be unable to reach these API tools or would need to know too much about the library’s internals.


### Shared transport models
These files define the common error and cross-endpoint request/response shapes that underpin the public API and streaming transports.

### `codex-api/src/common.rs`

`data_model` · `request construction and streaming`

This file is mostly a set of plain data shapes for conversations with the model service. Think of it like a stack of standard forms: one form for creating a response, one for summarizing memory, one for describing reasoning settings, one for text-output controls, and one for events that can arrive while a streamed answer is in progress. Without these shared shapes, different parts of the code would have to guess how to format requests and interpret replies, which would make API calls fragile.

The file defines request bodies for normal HTTP-style Responses API calls and for WebSocket response creation. A WebSocket is a long-lived connection where client and server can keep sending messages to each other. It also defines `ResponseEvent`, which is the set of meaningful things the server can report during a response: text arriving in pieces, tool-call input arriving in pieces, completion, token usage, rate limits, server-selected model details, and moderation or verification information.

A few helper pieces turn local configuration into API-ready fields. For example, verbosity settings are converted into OpenAI’s expected names, optional JSON schema output formatting is packaged into the `text` field, and trace headers are copied into client metadata so a request can be followed across systems. Finally, `ResponseStream` wraps an internal message receiver and exposes it as a standard asynchronous stream, so callers can consume model events one at a time as they arrive.

#### Function details

##### `OpenAiVerbosity::from`  (lines 173–179)

```
fn from(v: VerbosityConfig) -> Self
```

**Purpose**: This converts Codex’s own verbosity setting into the matching OpenAI API verbosity value. It lets the rest of the code use the project’s configuration type while still sending the exact form the API expects.

**Data flow**: It receives a verbosity choice from configuration: low, medium, or high. It matches that choice to the equivalent `OpenAiVerbosity` value. The result is a value ready to be serialized into a request body.

**Call relations**: This conversion is used when request text controls are built. In practice, `create_text_param_for_request` relies on it when a user or configuration asks for a certain answer length or detail level.


##### `ResponseCreateWsRequest::from`  (lines 206–225)

```
fn from(request: &ResponsesApiRequest) -> Self
```

**Purpose**: This builds a WebSocket version of a response-creation request from the normal Responses API request. It avoids duplicating request-building logic when the same conversation needs to be sent over a WebSocket instead of a regular request.

**Data flow**: It receives an existing `ResponsesApiRequest` by reference. It copies over the model, instructions, input items, tools, reasoning options, streaming settings, metadata, and other request options. It returns a new `ResponseCreateWsRequest`, adding WebSocket-specific fields such as `previous_response_id` and `generate` as empty values.

**Call relations**: When `stream_responses_websocket` is preparing to send a response-create message over the WebSocket connection, it calls this conversion. The converted request is then ready to be wrapped as a WebSocket message and sent to the server.

*Call graph*: called by 1 (stream_responses_websocket).


##### `response_create_client_metadata`  (lines 255–275)

```
fn response_create_client_metadata(
    client_metadata: Option<HashMap<String, String>>,
    trace: Option<&W3cTraceContext>,
) -> Option<HashMap<String, String>>
```

**Purpose**: This prepares the optional metadata map sent with a response-create request, including trace information when available. Trace information helps connect logs across different services, like putting the same tracking number on every package in a delivery chain.

**Data flow**: It starts with optional existing client metadata. If a W3C trace context is provided, it copies the `traceparent` and `tracestate` values into the metadata under the keys expected by this API layer. If the final map has at least one entry, it returns it; if it is empty, it returns nothing.

**Call relations**: This helper is used during request construction whenever response-create metadata needs to include tracing details. It does not send the request itself; it simply produces the metadata value that request-building code can attach.


##### `create_text_param_for_request`  (lines 285–303)

```
fn create_text_param_for_request(
    verbosity: Option<VerbosityConfig>,
    output_schema: &Option<Value>,
    output_schema_strict: bool,
) -> Option<TextControls>
```

**Purpose**: This builds the optional `text` section of a model request. That section can tell the API how verbose the answer should be and, if needed, what JSON shape the answer must follow.

**Data flow**: It receives an optional verbosity setting, an optional JSON schema, and a flag saying whether the schema should be enforced strictly. If neither verbosity nor schema is present, it returns nothing. Otherwise, it creates `TextControls`, converting verbosity into the API form and wrapping the schema with its format type, strictness flag, and a stable name.

**Call relations**: Request-building code can call this before sending a Responses API request. The helper packages user-facing output preferences into the exact nested structure expected by the API, instead of making each caller assemble that structure by hand.


##### `ResponseStream::poll_next`  (lines 314–316)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: This lets `ResponseStream` behave like a standard asynchronous stream of response events. Callers can wait for the next event without knowing that the events are stored internally in a Tokio message channel.

**Data flow**: It receives the pinned stream object and the current async task context. It asks the internal receiver for the next message. The result is either the next response event or API error, a signal that no item is ready yet, or an indication that the stream has ended.

**Call relations**: This is called by Rust’s asynchronous stream machinery whenever a consumer asks for the next item from `ResponseStream`. It hands the work off to the receiver’s `poll_recv` method, which actually checks whether another event has arrived.

*Call graph*: 1 external calls (poll_recv).


### `codex-api/src/error.rs`

`data_model` · `cross-cutting`

When software talks to an external API, many different failures can happen. The network might fail, the server might reject the request, the user might run out of quota, or the response stream might break halfway through. This file gathers those possibilities into one enum called `ApiError`, which is like a labeled set of possible failure reasons.

That matters because callers do not need to juggle many unrelated error shapes. They can receive one `ApiError` and then decide what to do: retry later, show a clear message, stop because the request is invalid, or report that the context window was too large. Some variants carry extra detail, such as an HTTP status code, a human-readable message, or an optional retry delay. An HTTP status code is the numeric result code from a web server, such as 404 or 500.

The file also connects lower-level errors to this API-level error. For example, a `TransportError` from the HTTP client can automatically become an `ApiError::Transport`, and a `RateLimitError` can become `ApiError::RateLimit`. In everyday terms, this file is the translation table that turns many kinds of trouble into a common language the API layer understands.

#### Function details

##### `ApiError::from`  (lines 37–39)

```
fn from(err: RateLimitError) -> Self
```

**Purpose**: This function converts a `RateLimitError` into the API layer's shared `ApiError` type. It lets code that detects rate limiting report that problem in the same error format used everywhere else in the API layer.

**Data flow**: It receives a `RateLimitError` as input. It turns that error into text using its string form, then wraps that text in `ApiError::RateLimit`. The output is a single `ApiError` value that says the request was blocked or delayed because of rate limiting.

**Call relations**: This function is used automatically by Rust's error conversion system when code needs to turn a rate-limit-specific error into the broader API error type. Inside, it relies on the rate limit error's own display text, then hands the result back as the API-facing error that callers can match on or show to users.

*Call graph*: 2 external calls (RateLimit, to_string).


### Realtime websocket protocol
This file specializes the shared models into the realtime websocket protocol and routes inbound events to version-specific parsing.

### `codex-api/src/endpoint/realtime_websocket/protocol.rs`

`data_model` · `request handling`

A realtime WebSocket session is a live back-and-forth connection, often carrying audio, text, session settings, and tool results. This file is the local “dictionary” for that conversation: it names the kinds of messages the server can send, the session options it can describe, and the event types it can receive from the shared protocol crate.

Most of the file is made of Rust structs and enums that are turned into JSON with serde, a library that converts Rust data into JSON and back. For example, it describes messages like “append this audio,” “create a response,” “update the session,” or “add this conversation item.” It also describes session details such as the model, instructions, voice, audio format, transcription settings, noise reduction, turn detection, and function tools. The serde annotations make sure the JSON field names match what the realtime API expects.

The file also supports two incoming event formats: an older v1 parser and a newer realtime v2 parser. The small parsing function acts like a switchboard. Given raw text from the WebSocket and the chosen protocol version, it forwards the text to the matching parser. Without this file, other realtime WebSocket code would lack a clear, consistent set of message shapes and would have to duplicate version-selection logic.

#### Function details

##### `parse_realtime_event`  (lines 215–223)

```
fn parse_realtime_event(
    payload: &str,
    event_parser: RealtimeEventParser,
) -> Option<RealtimeEvent>
```

**Purpose**: This function turns a raw incoming WebSocket message into a structured realtime event, using the protocol version selected for the session. It exists so the rest of the realtime code can ask for “an event” without needing to know which parser version to call.

**Data flow**: It receives the message payload as plain text and a parser choice. It checks whether the session is using the v1 format or the realtime v2 format, then sends the payload to the matching parser. The result is either a parsed RealtimeEvent or nothing if the payload could not be understood.

**Call relations**: When the WebSocket code is ready to read the next incoming event, next_event calls this function. This function then hands the raw text to parse_realtime_event_v1 or parse_realtime_event_v2, depending on the configured protocol, and returns the parsed event back to the caller.

*Call graph*: calls 2 internal fn (parse_realtime_event_v1, parse_realtime_event_v2); called by 1 (next_event).


### Endpoint payload schemas
These endpoint-specific schema modules define the request and response payloads for image and search APIs.

### `codex-api/src/images.rs`

`data_model` · `request building and response parsing`

This file is a collection of data types for working with images through an API. It does not perform the network call itself. Instead, it defines exactly what information must be packaged up before sending a request, and what information the program should expect back afterward.

There are two main request types. `ImageGenerationRequest` is used when asking the API to create a new image from a text prompt. `ImageEditRequest` is used when asking the API to edit one or more existing images, so it includes a list of image URLs as well as a prompt. Both request types include options such as background style, model name, number of images, quality, and size.

Several fields are optional. The `serde(skip_serializing_if = "Option::is_none")` setting means those fields are left out of the outgoing message when they are not set. In everyday terms, the program does not send blank boxes on the form.

The response types describe what comes back: when the image was created, the returned image data, and optional details such as background, quality, and size. The image itself is represented as base64 text, which is a way of safely carrying binary image data inside plain text formats like JSON.


### `codex-api/src/search.rs`

`data_model` · `request handling`

This file is mostly a set of data definitions. It does not perform searches itself. Instead, it describes the exact messages that other parts of the system can send to a search service, and the exact form of the answer they expect back. Think of it like a standardized order form: one part of the program fills it out, another part reads it, and both sides avoid guessing what each field means.

The central type is `SearchRequest`. It includes an id, the model to use, optional reasoning settings, optional input, optional commands, optional search settings, and an optional output limit. The input can be either plain text or a list of previous response items. The commands section is broad: it can ask for normal search queries, image searches, opening pages, clicking links, finding text, taking PDF screenshots, looking up finance data, weather, sports, or time.

The file also defines settings that guide how search should behave, such as approximate user location, how much search context to gather, allowed or blocked domains, image result limits, and whether outside web access is allowed. Many fields are optional and are skipped when converted to JSON if they are not set, which keeps API messages small and clear.

Without this file, the rest of the project would lack a clear, typed agreement for search-related API traffic. That would make it much easier to send malformed requests or misunderstand responses.
