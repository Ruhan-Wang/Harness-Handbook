# App-server protocol schemas and transport contracts  `stage-18.2`

This stage defines the shared “language” that the app server and its clients use to talk. It is mostly behind-the-scenes support, but it is essential during normal operation: every request, reply, notification, and error passes through these contracts.

At the bottom, jsonrpc_lite.rs supplies the basic JSON-RPC message envelope, meaning the standard wrapper around calls and responses. common.rs ties real app actions to those wire messages, while protocol/mod.rs, v1.rs, and the many v2 files organize the actual payload shapes for both the older and newer protocol versions. The v2 modules cover the system’s main topics: threads and turns, items and reviews, accounts, models, apps, permissions, config, plugins, file and process access, command execution, remote control, realtime sessions, and more. Mapper and helper files smooth over naming differences, special serialization rules, and v1-to-v2 compatibility.

Around that core, export.rs, schema_fixtures.rs, and experimental_api.rs generate JSON Schema and TypeScript descriptions so other tools can use the same contract safely. The transport files define how outgoing messages are queued and identified, and error_code.rs makes sure server errors are reported in a consistent format.

## Files in this stage

### Protocol facade and wire foundations
These files establish the crate-level entry points and the shared JSON-RPC and protocol scaffolding that all versioned schemas build on.

### `app-server-protocol/src/jsonrpc_lite.rs`

`data_model` · `request handling`

This module contains the protocol’s minimal JSON-RPC framing types. `JSONRPC_VERSION` is declared as `"2.0"`, but the module-level comment makes the design choice explicit: the system does not send or require the standard `jsonrpc` field. Instead, the wire model is represented by `JSONRPCMessage`, an untagged enum over `JSONRPCRequest`, `JSONRPCNotification`, `JSONRPCResponse`, and `JSONRPCError`.

`RequestId` is also an untagged enum, allowing either `String(String)` or `Integer(i64)` IDs. It derives serde, schemars, and `ts_rs::TS`, with the integer variant explicitly exported to TypeScript as `number`. The module aliases `Result` to `serde_json::Value`, so successful JSON-RPC responses can carry arbitrary JSON payloads.

The request and notification structs both carry a `method: String` and optional `params: Option<serde_json::Value>`, serialized only when present. `JSONRPCRequest` additionally includes `id: RequestId` and optional distributed tracing metadata via `trace: Option<W3cTraceContext>`. `JSONRPCResponse` pairs an `id` with a `result`, while `JSONRPCError` wraps `JSONRPCErrorError { code, data, message }` plus the request ID. The file is mostly data definitions; its only behavior is `Display` formatting for `RequestId`, which renders either the raw string ID or decimal integer form.

#### Function details

##### `RequestId::fmt`  (lines 24–29)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a `RequestId` for display by emitting either the contained string or the decimal representation of the integer variant. It gives request IDs a uniform textual form for logs and messages.

**Data flow**: Reads `self` and mutable formatter `f`; for `RequestId::String(value)` it writes `value` directly with `write_str`, and for `RequestId::Integer(value)` it formats the integer with `write!`. Returns `fmt::Result` and writes only to the formatter output stream.

**Call relations**: This is the `fmt::Display` implementation for `RequestId`, used implicitly anywhere a request ID is formatted as text. It does not call internal helpers beyond standard formatting primitives.

*Call graph*: 2 external calls (write_str, write!).


### `app-server-protocol/src/lib.rs`

`orchestration` · `cross-cutting`

This file is the crate root for `app-server-protocol`, and its main responsibility is curating the public API. It declares internal modules for `experimental_api`, `export`, `jsonrpc_lite`, `protocol`, and `schema_fixtures`, then re-exports a broad set of items so downstream code can depend on one stable namespace instead of the internal module layout.

The re-exports reveal the crate’s responsibilities. From `export`, it exposes schema and code-generation entry points such as `generate_json`, `generate_ts`, `generate_types`, and option types like `GenerateTsOptions`. From `jsonrpc_lite`, it surfaces lightweight JSON-RPC protocol types. From `protocol`, it re-exports common shared types, event mapping helpers, item builders, thread history structures, selected v1 request/response types, and the entire v2 protocol surface via `pub use protocol::v2::*`. It also exposes schema fixture readers and writers for tests and tooling, with one hidden helper reserved for test support. The design intentionally mixes stable protocol definitions with generation utilities in one crate so the same source of truth can drive runtime serialization, schema export, and fixture generation. This file is active anywhere protocol types are imported, schemas are generated, or tests need fixture trees derived from the protocol definitions.


### `app-server-protocol/src/protocol/mod.rs`

`orchestration` · `compile-time module wiring / cross-cutting`

This file is the protocol module root: it does not implement behavior itself, but it determines how the rest of the protocol schema is structured and exposed to the crate. The public modules `common`, `event_mapping`, `item_builders`, `thread_history`, `v1`, and `v2` form the externally consumable protocol surface, while `mappers` and `serde_helpers` remain internal implementation details. That split is important because it signals which pieces are intended as stable API definitions versus translation and serialization support used behind the scenes.

The module layout also encodes the protocol’s versioning strategy. Shared definitions live outside the versioned trees, while request/response payloads that differ by API generation are isolated under `v1` and `v2`. Consumers reaching this module through the crate root can import protocol types without needing to know the internal file layout, and the comment indicates that `lib.rs` re-exports pieces from `protocol::common`. In practice, this file is the namespace switchboard for schema compilation, serde support, JSON Schema generation, and TypeScript export performed by the child modules. Because there are no functions or state here, its main invariant is module visibility: public declarations define the supported protocol surface, and private declarations keep helper machinery out of the public API.


### `app-server-protocol/src/protocol/serde_helpers.rs`

`util` · `cross-cutting`

This file is a focused collection of serialization/deserialization helpers intended to be referenced from `#[serde(...)]` field attributes elsewhere in the protocol layer. It defines three generic free functions, each adapting Serde behavior without introducing new wrapper types. The first helper targets `Option<PathBuf>` fields and normalizes an empty path string into `None`; it first deserializes using Serde’s standard `Option<PathBuf>` implementation, then post-processes the result by filtering out any `PathBuf` whose `OsStr` is empty. That preserves ordinary `None` and non-empty paths while collapsing a protocol edge case that would otherwise produce `Some("")`.

The other two helpers expose `serde_with::rust::double_option` for fields typed as `Option<Option<T>>`, preserving the distinction between an omitted field, an explicit null, and a concrete value. Rather than reimplementing that logic, this file forwards directly to the external helper module for both deserialize and serialize paths. The design is intentionally minimal: no local state, no custom error shaping, and no protocol-specific types beyond `PathBuf`. Its value is in centralizing these conventions so protocol structs can opt into consistent wire semantics declaratively.

#### Function details

##### `deserialize_empty_path_as_none`  (lines 8–14)

```
fn deserialize_empty_path_as_none(deserializer: D) -> Result<Option<PathBuf>, D::Error>
```

**Purpose**: Deserializes an optional filesystem path and converts an empty path payload into `None` instead of leaving it as `Some(PathBuf::new())` or equivalent.

**Data flow**: It accepts a generic Serde `Deserializer`, invokes the standard `Option::<PathBuf>::deserialize` implementation to obtain `Option<PathBuf>`, then applies `Option::filter` with a predicate that checks `!path.as_os_str().is_empty()`. The function returns the filtered `Option<PathBuf>` wrapped in `Result`, propagating any deserialization error from Serde unchanged.

**Call relations**: This helper is intended to be invoked by Serde during field deserialization when a struct field is annotated to use it. In its internal flow it delegates only to the external `deserialize` implementation for `Option<PathBuf>`, then performs the protocol-specific normalization step locally.

*Call graph*: 1 external calls (deserialize).


##### `deserialize_double_option`  (lines 16–22)

```
fn deserialize_double_option(deserializer: D) -> Result<Option<Option<T>>, D::Error>
```

**Purpose**: Deserializes a nested optional value so callers can distinguish between a missing field, an explicit null, and a present non-null value.

**Data flow**: It takes a generic `Deserializer` for some `T: Deserialize<'de>` and forwards that deserializer directly to `serde_with::rust::double_option::deserialize`. The returned value is `Result<Option<Option<T>>, D::Error>`, preserving all three states without additional transformation or local state.

**Call relations**: This function is used as a Serde field-level adapter wherever protocol structs need tri-state optional semantics. Its entire implementation is delegation to the external `serde_with` deserializer, serving as a local stable entry point for that behavior.

*Call graph*: 1 external calls (deserialize).


##### `serialize_double_option`  (lines 24–33)

```
fn serialize_double_option(
    value: &Option<Option<T>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
```

**Purpose**: Serializes a nested optional value using Serde conventions that preserve the distinction between absent, null, and concrete values.

**Data flow**: It receives a borrowed `&Option<Option<T>>` plus a generic Serde `Serializer`, then passes both directly to `serde_with::rust::double_option::serialize`. It returns the serializer’s `Ok`/`Error` result unchanged and does not mutate any state.

**Call relations**: This helper is called by Serde during struct serialization for fields configured to use it. In the call flow it acts purely as a thin wrapper around the external `serde_with` serializer so protocol types can reuse the same tri-state encoding convention consistently.

*Call graph*: 1 external calls (serialize).


### `app-server-protocol/src/protocol/common.rs`

`data_model` · `cross-cutting protocol definition, serialization, and schema export`

This file is the protocol catalog for the app-server boundary. Its core job is to declare the enums that represent every client-initiated request, server-initiated request, and server/client notification, then derive the serde, TypeScript, and JSON Schema machinery needed to move those messages over JSON-RPC and publish the contract externally. Rather than hand-writing dozens of near-identical enums and helpers, it uses macros to generate `ClientRequest`, `ClientResponse`, `ClientResponsePayload`, `ServerRequest`, `ServerResponse`, `ServerRequestPayload`, `ServerNotification`, and `ClientNotification`, along with helper methods such as ID extraction, method-name recovery, JSON-RPC conversion, schema export, and type visitation.

A notable design feature is request serialization scoping. `ClientRequestSerializationScope` classifies requests into concurrency buckets such as global config, per-thread, per-process, per-watch, or per-MCP OAuth server; the generated `ClientRequest::serialization_scope()` computes these from request params so higher layers can serialize conflicting operations while allowing unrelated ones to run concurrently. Another important axis is experimental gating: macro annotations attach explicit experimental reasons to methods, or defer to param-level inspection via the `ExperimentalApi` trait when only certain fields are unstable. The file also includes a small set of concrete protocol structs for fuzzy file search and a large test module that locks down exact JSON shapes, omitted optional params, rename behavior, experimental markers, and serialization-scope decisions.

#### Function details

##### `AuthMode::has_chatgpt_account`  (lines 53–58)

```
fn has_chatgpt_account(self) -> bool
```

**Purpose**: Classifies an authentication mode by whether it corresponds to an authenticated human ChatGPT account. It distinguishes ChatGPT-backed and personal-token-backed modes from direct API-key, agent identity, and Bedrock modes.

**Data flow**: Takes `self: AuthMode` by value and pattern-matches the enum variant. It returns `true` for `Chatgpt`, `ChatgptAuthTokens`, and `PersonalAccessToken`, and `false` for `ApiKey`, `AgentIdentity`, and `BedrockApiKey`; it does not mutate any state.

**Call relations**: This is a leaf classification helper on the `AuthMode` enum, used by higher-level account/auth logic when protocol consumers need to know whether a mode implies a ChatGPT account context rather than a raw provider credential.


##### `AuthMode::uses_codex_backend`  (lines 61–69)

```
fn uses_codex_backend(self) -> bool
```

**Purpose**: Reports whether an auth mode routes through Codex-managed backend services instead of talking directly to a model provider API. It encodes the protocol-level distinction between Codex-backed account modes and direct credential modes.

**Data flow**: Consumes `self: AuthMode`, matches on the variant, and returns `true` for `Chatgpt`, `ChatgptAuthTokens`, `AgentIdentity`, and `PersonalAccessToken`, while returning `false` for `ApiKey` and `BedrockApiKey`. No external state is read or written.

**Call relations**: Like `AuthMode::has_chatgpt_account`, this is a pure helper used by callers outside this file to branch on backend behavior, especially where transport or capability decisions depend on Codex mediation.


##### `ServerRequest::try_from`  (lines 1417–1419)

```
fn try_from(value: JSONRPCRequest) -> Result<Self, Self::Error>
```

**Purpose**: Converts a generic JSON-RPC request object into the strongly typed `ServerRequest` enum defined by this protocol file. It is the bridge from transport-level JSON-RPC framing into typed server-to-client request variants.

**Data flow**: Accepts a `JSONRPCRequest`, serializes it to a generic `serde_json::Value`, then deserializes that value into `ServerRequest`. It returns either the typed enum or a `serde_json::Error`; it performs no side effects beyond serialization/deserialization work.

**Call relations**: This `TryFrom` implementation is invoked when infrastructure receives a server-originated JSON-RPC request and needs typed dispatch. Internally it delegates entirely to `serde_json::to_value` and `serde_json::from_value`, relying on the enum's serde tags and renames generated by `server_request_definitions!`.

*Call graph*: 2 external calls (from_value, to_value).


##### `tests::absolute_path_string`  (lines 1692–1695)

```
fn absolute_path_string(path: &str) -> String
```

**Purpose**: Builds a normalized absolute-path string for test assertions. It ensures fixture paths are rooted and rendered exactly as the absolute-path helper library would serialize them.

**Data flow**: Takes a `&str`, strips any leading slash, prefixes one slash via `format!`, converts it with `test_path_buf`, and returns the displayed path as a `String`. It reads no shared state and writes nothing.

**Call relations**: This helper is called by serialization tests that compare JSON output containing absolute filesystem paths, so expected JSON strings match the same path normalization used by protocol types.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::absolute_path`  (lines 1697–1700)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Constructs an `AbsolutePathBuf` test value from a string path. It centralizes path normalization for tests that need typed absolute-path params rather than plain strings.

**Data flow**: Receives a `&str`, normalizes it to a rooted path string with `format!`, passes it through `test_path_buf`, then converts to an absolute-path wrapper with `.abs()`. It returns the typed path and does not mutate external state.

**Call relations**: Used throughout the test module when building request params or notification payloads that contain absolute paths, keeping fixtures concise and consistent with production path serialization.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::request_id`  (lines 1702–1705)

```
fn request_id() -> RequestId
```

**Purpose**: Provides a stable integer `RequestId` fixture for tests. It avoids repeating the same literal construction across many assertions.

**Data flow**: Creates and returns `RequestId::Integer(1)` from a local constant. No inputs are read and no state is modified.

**Call relations**: This helper is used by the serialization-scope tests to populate request IDs while focusing assertions on scope behavior rather than ID construction.

*Call graph*: 1 external calls (Integer).


##### `tests::client_request_serialization_scope_covers_keyed_families`  (lines 1708–1997)

```
fn client_request_serialization_scope_covers_keyed_families()
```

**Purpose**: Verifies that representative client requests with key-bearing params map to the correct `ClientRequestSerializationScope` variants. It exercises thread-, process-, watch-, config-, account-, environment-, and MCP-scoped requests.

**Data flow**: Constructs many `ClientRequest` values with concrete params, often using `request_id()`, `absolute_path()`, `PathBuf::from`, `json!`, and vectors. For each request it calls `serialization_scope()` and asserts the returned `Option<ClientRequestSerializationScope>` matches the expected keyed scope; no persistent state is changed.

**Call relations**: This test directly validates the behavior generated by `client_request_definitions!` and `serialization_scope_expr!`. It is invoked by the Rust test runner and serves as regression coverage for macro-specified serialization policies on requests that should serialize by shared key.

*Call graph*: 8 external calls (default, from, new, absolute_path, request_id, assert_eq!, json!, vec!).


##### `tests::client_request_serialization_scope_covers_unkeyed_representatives`  (lines 2000–2129)

```
fn client_request_serialization_scope_covers_unkeyed_representatives()
```

**Purpose**: Checks that representative requests intended to run concurrently either produce `None` serialization scope or the expected global/shared-read scope for unkeyed operations. It complements the keyed-family test by covering intentionally concurrent APIs.

**Data flow**: Builds sample `ClientRequest` values for initialize, thread start, command exec without process ID, filesystem reads, append-only thread history reads, MCP resource reads without thread context, and remote-control operations. It calls `serialization_scope()` on each and asserts the exact `Option<ClientRequestSerializationScope>` result.

**Call relations**: Run by the test harness, this test confirms that the macro-declared serialization annotations preserve concurrency where intended and only impose global serialization on the remote-control families that explicitly require it.

*Call graph*: 7 external calls (absolute_path, request_id, default, default, default, assert_eq!, vec!).


##### `tests::serialize_get_conversation_summary`  (lines 2132–2150)

```
fn serialize_get_conversation_summary() -> Result<()>
```

**Purpose**: Confirms the legacy `GetConversationSummary` client request serializes to the expected JSON shape, including plain-string thread ID encoding and camelCase field names.

**Data flow**: Creates a `ThreadId` from a UUID string, wraps it in `v1::GetConversationSummaryParams::ThreadId`, embeds that in `ClientRequest::GetConversationSummary`, serializes with `serde_json::to_value`, and compares the result to a literal `json!` object. It returns `anyhow::Result<()>` to propagate parse/serialization failures.

**Call relations**: This test is invoked by the test runner and validates serde behavior for one deprecated v1 request variant generated by `client_request_definitions!`.

*Call graph*: calls 1 internal fn (from_string); 2 external calls (Integer, assert_eq!).


##### `tests::serialize_initialize_with_opt_out_notification_methods`  (lines 2153–2196)

```
fn serialize_initialize_with_opt_out_notification_methods() -> Result<()>
```

**Purpose**: Verifies that `Initialize` requests serialize optional client capabilities, including `optOutNotificationMethods`, exactly as expected on the wire.

**Data flow**: Builds a `ClientRequest::Initialize` with populated `v1::InitializeParams` and nested `InitializeCapabilities`, serializes it to JSON, and asserts equality with a hand-written `json!` value. It returns `Result<()>` for test ergonomics.

**Call relations**: This test covers the initialization handshake contract and ensures optional capability fields survive serde renaming and nesting correctly.

*Call graph*: 3 external calls (Integer, assert_eq!, vec!).


##### `tests::deserialize_initialize_with_opt_out_notification_methods`  (lines 2199–2242)

```
fn deserialize_initialize_with_opt_out_notification_methods() -> Result<()>
```

**Purpose**: Checks the inverse of the previous test: JSON for `initialize` with opt-out notification methods deserializes into the exact typed `ClientRequest` value.

**Data flow**: Starts from a literal `json!` object, deserializes it with `serde_json::from_value` into `ClientRequest`, and compares the result to a manually constructed `ClientRequest::Initialize`. It returns `Result<()>` on success or deserialization failure.

**Call relations**: This test is called by the test harness to lock down backward-compatible parsing of initialization capabilities, complementing the serialization test.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::conversation_id_serializes_as_plain_string`  (lines 2245–2253)

```
fn conversation_id_serializes_as_plain_string() -> Result<()>
```

**Purpose**: Ensures `ThreadId` serializes as a bare JSON string rather than an object wrapper. This is important because many protocol payloads embed thread IDs directly.

**Data flow**: Parses a `ThreadId` from a UUID string, serializes it with `serde_json::to_value`, and asserts the result equals a JSON string literal. It returns `Result<()>`.

**Call relations**: This focused test supports many request/notification contracts in this file by pinning the serialization behavior of the shared `ThreadId` type used in v1 payloads.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (assert_eq!).


##### `tests::conversation_id_deserializes_from_plain_string`  (lines 2256–2264)

```
fn conversation_id_deserializes_from_plain_string() -> Result<()>
```

**Purpose**: Verifies that a plain JSON string can be parsed back into `ThreadId`. It protects the inverse compatibility guarantee of the previous test.

**Data flow**: Deserializes a JSON string literal into `ThreadId` using `serde_json::from_value`, constructs the expected `ThreadId` from the same UUID string, and asserts equality. It returns `Result<()>`.

**Call relations**: Run by the test harness, this test confirms that protocol consumers can send thread IDs as simple strings and still obtain the typed identifier.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::serialize_client_notification`  (lines 2267–2277)

```
fn serialize_client_notification() -> Result<()>
```

**Purpose**: Checks that the `ClientNotification::Initialized` variant serializes without a `params` field. This captures the special no-payload notification shape generated by the notification macro.

**Data flow**: Constructs `ClientNotification::Initialized`, serializes it to JSON, and asserts the output contains only the `method` field. It returns `Result<()>`.

**Call relations**: This test validates the `client_notification_definitions!` output for payload-less notifications and is executed by the standard test runner.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::serialize_server_request`  (lines 2280–2324)

```
fn serialize_server_request() -> Result<()>
```

**Purpose**: Verifies serialization of a legacy server-initiated approval request and the payload-to-request constructor path. It checks both wire JSON and helper enum behavior.

**Data flow**: Builds `v1::ExecCommandApprovalParams` with a parsed `ThreadId`, command vector, cwd, and parsed command list; wraps it in `ServerRequest::ExecCommandApproval`; serializes to JSON and asserts the exact shape. It also constructs `ServerRequestPayload::ExecCommandApproval`, calls `request_with_id`, and asserts the reconstructed request matches the original.

**Call relations**: This test exercises code generated by `server_request_definitions!`, specifically `ServerRequest::id` and `ServerRequestPayload::request_with_id`, and confirms legacy v1 server requests still serialize correctly.

*Call graph*: calls 1 internal fn (from_string); 5 external calls (from, ExecCommandApproval, Integer, assert_eq!, vec!).


##### `tests::serialize_chatgpt_auth_tokens_refresh_request`  (lines 2327–2347)

```
fn serialize_chatgpt_auth_tokens_refresh_request() -> Result<()>
```

**Purpose**: Checks the wire format for the server-to-client `account/chatgptAuthTokens/refresh` request, including enum string values and optional previous account ID.

**Data flow**: Constructs `ServerRequest::ChatgptAuthTokensRefresh` with concrete params, serializes it to JSON, and compares against a literal expected object. It returns `Result<()>`.

**Call relations**: This test is run by the test harness to validate one of the newer v2 server request variants generated by the macro.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_attestation_generate_request`  (lines 2350–2369)

```
fn serialize_attestation_generate_request() -> Result<()>
```

**Purpose**: Verifies serialization of the server-initiated attestation generation request and the payload helper that wraps params into a request with an ID.

**Data flow**: Creates empty `v2::AttestationGenerateParams`, embeds them in `ServerRequest::AttestationGenerate`, serializes to JSON, and asserts the exact object. It also creates `ServerRequestPayload::AttestationGenerate`, calls `request_with_id`, and checks equality with the original request.

**Call relations**: This test covers both the serde contract and the helper constructor generated by `server_request_definitions!` for a modern v2 request.

*Call graph*: 3 external calls (AttestationGenerate, Integer, assert_eq!).


##### `tests::serialize_server_response`  (lines 2372–2393)

```
fn serialize_server_response() -> Result<()>
```

**Purpose**: Confirms that a typed client-to-server response to a server request serializes with the correct method tag, ID, and nested `response` payload.

**Data flow**: Builds `ServerResponse::CommandExecutionRequestApproval` with a concrete approval decision, checks `id()` and `method()`, serializes to JSON, and asserts the exact output. It returns `Result<()>`.

**Call relations**: This test validates helper methods generated on `ServerResponse` and the serde tagging for server-request response messages.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_mcp_server_elicitation_request`  (lines 2396–2450)

```
fn serialize_mcp_server_elicitation_request() -> Result<()>
```

**Purpose**: Tests serialization of an MCP elicitation request carrying a JSON-schema-like form definition, plus the payload helper path. It ensures the tagged request mode and `_meta` field layout are preserved.

**Data flow**: Deserializes a JSON object into `v2::McpElicitationSchema`, builds `v2::McpServerElicitationRequestParams::Form`, wraps it in `ServerRequest::McpServerElicitationRequest`, serializes to JSON, and asserts the exact structure. It also constructs the corresponding `ServerRequestPayload`, calls `request_with_id`, and checks equality.

**Call relations**: This test is invoked by the test runner to validate a complex server request variant generated by `server_request_definitions!`, especially one with nested tagged payload semantics.

*Call graph*: 5 external calls (McpServerElicitationRequest, Integer, assert_eq!, json!, from_value).


##### `tests::serialize_get_account_rate_limits`  (lines 2453–2468)

```
fn serialize_get_account_rate_limits() -> Result<()>
```

**Purpose**: Verifies that a client request whose params are `Option<()>` serializes without a `params` field when `None`. It specifically covers `account/rateLimits/read`.

**Data flow**: Constructs `ClientRequest::GetAccountRateLimits` with `params: None`, checks `id()` and `method()`, serializes to JSON, and asserts the resulting object omits `params`. It returns `Result<()>`.

**Call relations**: This test protects the serde behavior of optional-unit params in the generated `ClientRequest` enum for no-argument methods.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_get_account_token_usage`  (lines 2471–2486)

```
fn serialize_get_account_token_usage() -> Result<()>
```

**Purpose**: Checks the same omitted-params behavior as the previous test, but for `account/usage/read`.

**Data flow**: Builds `ClientRequest::GetAccountTokenUsage` with `None` params, verifies `id()` and `method()`, serializes to JSON, and compares to the expected object lacking `params`. It returns `Result<()>`.

**Call relations**: This test complements the rate-limits case and ensures multiple no-arg request variants behave consistently under serde.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_client_response`  (lines 2489–2579)

```
fn serialize_client_response() -> Result<()>
```

**Purpose**: Validates serialization of a large, nested `ClientResponse::ThreadStart` payload, including thread metadata, path handling, enums, and nested settings-like fields.

**Data flow**: Uses `absolute_path()` to build typed paths, constructs a detailed `v2::ThreadStartResponse` and wraps it in `ClientResponse::ThreadStart`, checks `id()` and `method()`, serializes to JSON, and asserts equality with a fully expanded expected object. It returns `Result<()>`.

**Call relations**: This test exercises the generated `ClientResponse` helpers and serves as a broad regression test for nested v2 response serialization, especially camelCase conversion and absolute-path rendering.

*Call graph*: 5 external calls (new, Integer, absolute_path, assert_eq!, vec!).


##### `tests::serialize_config_requirements_read`  (lines 2582–2595)

```
fn serialize_config_requirements_read() -> Result<()>
```

**Purpose**: Ensures `configRequirements/read` also omits `params` when represented as `None`. It covers another no-argument request variant.

**Data flow**: Constructs `ClientRequest::ConfigRequirementsRead` with `params: None`, serializes it, and asserts the JSON contains only `method` and `id`. It returns `Result<()>`.

**Call relations**: This test is part of the suite pinning down optional-unit request serialization generated by `client_request_definitions!`.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_api_key`  (lines 2598–2617)

```
fn serialize_account_login_api_key() -> Result<()>
```

**Purpose**: Checks the tagged-union wire format for `LoginAccount` when using the API key variant.

**Data flow**: Builds `ClientRequest::LoginAccount` with `v2::LoginAccountParams::ApiKey`, serializes to JSON, and asserts the payload contains `type: apiKey` and the `apiKey` field. It returns `Result<()>`.

**Call relations**: This test validates one branch of the account-login request enum defined in v2 and wrapped by the generated `ClientRequest` variant.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt`  (lines 2620–2638)

```
fn serialize_account_login_chatgpt() -> Result<()>
```

**Purpose**: Verifies the standard ChatGPT login variant serializes with the correct discriminator and omits falsey optional fields not meant to appear.

**Data flow**: Constructs `ClientRequest::LoginAccount` with `v2::LoginAccountParams::Chatgpt { codex_streamlined_login: false }`, serializes it, and compares to the expected JSON containing only `type: chatgpt`. It returns `Result<()>`.

**Call relations**: This test complements the API-key login case and confirms serde omission behavior inside the nested login params enum.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt_streamlined`  (lines 2641–2660)

```
fn serialize_account_login_chatgpt_streamlined() -> Result<()>
```

**Purpose**: Checks that the ChatGPT login variant includes `codexStreamlinedLogin` when that flag is true.

**Data flow**: Builds the ChatGPT login request with `codex_streamlined_login: true`, serializes it, and asserts the JSON includes both the `type` discriminator and the streamlined-login flag. It returns `Result<()>`.

**Call relations**: This test covers the alternate serialization branch of the same nested login enum, ensuring conditional field emission is correct.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt_device_code`  (lines 2663–2679)

```
fn serialize_account_login_chatgpt_device_code() -> Result<()>
```

**Purpose**: Verifies serialization of the device-code login variant for account login.

**Data flow**: Constructs `ClientRequest::LoginAccount` with `v2::LoginAccountParams::ChatgptDeviceCode`, serializes it, and asserts the JSON contains the expected `type: chatgptDeviceCode` payload. It returns `Result<()>`.

**Call relations**: This test adds coverage for another branch of the login tagged union used by the generated client request.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_logout`  (lines 2682–2695)

```
fn serialize_account_logout() -> Result<()>
```

**Purpose**: Ensures the logout request serializes as a no-params method call.

**Data flow**: Builds `ClientRequest::LogoutAccount` with `params: None`, serializes it, and asserts the JSON contains only `method` and `id`. It returns `Result<()>`.

**Call relations**: This test is another guardrail around optional-unit params and account-auth request wire shape.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt_auth_tokens`  (lines 2698–2721)

```
fn serialize_account_login_chatgpt_auth_tokens() -> Result<()>
```

**Purpose**: Checks serialization of the unstable/internal ChatGPT auth-token login variant, including token and account metadata fields.

**Data flow**: Constructs `ClientRequest::LoginAccount` with `v2::LoginAccountParams::ChatgptAuthTokens`, serializes it, and compares to expected JSON containing `accessToken`, `chatgptAccountId`, and `chatgptPlanType`. It returns `Result<()>`.

**Call relations**: This test covers a less common login branch and ensures the custom discriminator spelling `chatgptAuthTokens` is preserved.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_get_account`  (lines 2724–2756)

```
fn serialize_get_account() -> Result<()>
```

**Purpose**: Verifies both compact and expanded serialization forms of `account/read`, depending on whether `refresh_token` is false or true.

**Data flow**: Builds two `ClientRequest::GetAccount` values: one with `refresh_token: false` and one with `refresh_token: true`. It serializes each and asserts that the false case yields an empty params object while the true case includes `refreshToken: true`.

**Call relations**: This test is run by the test harness to pin down serde defaults and omission behavior inside a non-optional params struct.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::account_serializes_fields_in_camel_case`  (lines 2759–2804)

```
fn account_serializes_fields_in_camel_case() -> Result<()>
```

**Purpose**: Checks that the `v2::Account` enum serializes each variant and nested field names in camelCase, including Bedrock credential source values.

**Data flow**: Constructs several `v2::Account` variants (`ApiKey`, `Chatgpt`, and two `AmazonBedrock` forms), serializes each to JSON, and asserts exact equality with expected literals. It returns `Result<()>`.

**Call relations**: Although it tests a type defined elsewhere, this file includes the test because account payloads are part of the protocol surface exercised by requests and notifications declared here.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::account_defaults_legacy_bedrock_credential_source`  (lines 2807–2817)

```
fn account_defaults_legacy_bedrock_credential_source() -> Result<()>
```

**Purpose**: Ensures deserializing a legacy Bedrock account payload without `credentialSource` defaults to `AwsManaged`.

**Data flow**: Deserializes a minimal JSON object into `v2::Account`, then asserts the result equals the `AmazonBedrock` variant with `credential_source: AwsManaged`. It returns `Result<()>`.

**Call relations**: This test protects backward compatibility for older serialized account payloads consumed through the protocol.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::serialize_list_models`  (lines 2820–2838)

```
fn serialize_list_models() -> Result<()>
```

**Purpose**: Verifies the default wire shape of the `model/list` request, including explicit nulls for optional pagination fields.

**Data flow**: Constructs `ClientRequest::ModelList` with `v2::ModelListParams::default()`, serializes it, and asserts the JSON contains `limit`, `cursor`, and `includeHidden` as null. It returns `Result<()>`.

**Call relations**: This test validates one representative list-style request generated by `client_request_definitions!`.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_model_provider_capabilities_read`  (lines 2841–2855)

```
fn serialize_model_provider_capabilities_read() -> Result<()>
```

**Purpose**: Checks serialization of the `modelProvider/capabilities/read` request with an empty params object.

**Data flow**: Builds `ClientRequest::ModelProviderCapabilitiesRead` with empty params, serializes it, and compares to the expected JSON. It returns `Result<()>`.

**Call relations**: This test covers a simple v2 request variant and confirms empty-struct params serialize as `{}` rather than being omitted.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_list_collaboration_modes`  (lines 2858–2872)

```
fn serialize_list_collaboration_modes() -> Result<()>
```

**Purpose**: Verifies the `collaborationMode/list` request serializes with an empty params object.

**Data flow**: Constructs `ClientRequest::CollaborationModeList` from default params, serializes it, and asserts the exact JSON shape. It returns `Result<()>`.

**Call relations**: This test covers an experimental request variant's serde contract without testing experimental gating itself.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_list_apps`  (lines 2875–2893)

```
fn serialize_list_apps() -> Result<()>
```

**Purpose**: Checks the default serialization of the `app/list` request, including null pagination and optional thread filter fields.

**Data flow**: Builds `ClientRequest::AppsList` with default params, serializes it, and asserts the JSON contains `cursor`, `limit`, and `threadId` as null. It returns `Result<()>`.

**Call relations**: This test validates another list-style request variant generated by the client request macro.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_environment_add`  (lines 2896–2916)

```
fn serialize_environment_add() -> Result<()>
```

**Purpose**: Verifies the wire format for the experimental `environment/add` request.

**Data flow**: Constructs `ClientRequest::EnvironmentAdd` with an environment ID and exec server URL, serializes it, and asserts the expected camelCase JSON fields. It returns `Result<()>`.

**Call relations**: This test covers the request's serde contract; a separate test in this module checks its experimental marker.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_fs_get_metadata`  (lines 2919–2937)

```
fn serialize_fs_get_metadata() -> Result<()>
```

**Purpose**: Checks serialization of the filesystem metadata request with an absolute path payload.

**Data flow**: Uses `absolute_path()` to build the path, constructs `ClientRequest::FsGetMetadata`, serializes it, and compares to expected JSON using `absolute_path_string()` semantics. It returns `Result<()>`.

**Call relations**: This test validates one of the intentionally concurrent filesystem request variants declared in the client request macro.

*Call graph*: 3 external calls (Integer, absolute_path, assert_eq!).


##### `tests::serialize_fs_watch`  (lines 2940–2960)

```
fn serialize_fs_watch() -> Result<()>
```

**Purpose**: Verifies the wire format for `fs/watch`, including watch ID and absolute path serialization.

**Data flow**: Builds `ClientRequest::FsWatch` with a watch ID and absolute path, serializes it, and asserts the exact JSON object. It returns `Result<()>`.

**Call relations**: This test complements the serialization-scope tests for filesystem watch requests by checking the actual serde output.

*Call graph*: 3 external calls (Integer, absolute_path, assert_eq!).


##### `tests::serialize_list_experimental_features`  (lines 2963–2981)

```
fn serialize_list_experimental_features() -> Result<()>
```

**Purpose**: Checks the default serialization of `experimentalFeature/list`, including null pagination and thread filter fields.

**Data flow**: Constructs `ClientRequest::ExperimentalFeatureList` with default params, serializes it, and asserts the expected JSON. It returns `Result<()>`.

**Call relations**: This test validates the request's wire shape; the request itself is not marked experimental despite listing experimental features.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_list_experimental_features_with_thread_id`  (lines 2984–3006)

```
fn serialize_list_experimental_features_with_thread_id() -> Result<()>
```

**Purpose**: Verifies non-default serialization of `experimentalFeature/list` when cursor, limit, and thread ID are provided.

**Data flow**: Builds `ClientRequest::ExperimentalFeatureList` with explicit values, serializes it, and compares to the expected JSON containing those fields. It returns `Result<()>`.

**Call relations**: This test complements the default-params case by ensuring optional fields are emitted correctly when present.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_background_terminals_clean`  (lines 3009–3027)

```
fn serialize_thread_background_terminals_clean() -> Result<()>
```

**Purpose**: Checks serialization of the experimental request that cleans background terminals for a thread.

**Data flow**: Constructs `ClientRequest::ThreadBackgroundTerminalsClean` with a thread ID, serializes it, and asserts the exact JSON shape. It returns `Result<()>`.

**Call relations**: This test validates one of the thread-scoped experimental request variants declared in the macro.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_background_terminals_list`  (lines 3030–3052)

```
fn serialize_thread_background_terminals_list() -> Result<()>
```

**Purpose**: Verifies serialization of the background-terminal listing request, including null pagination fields.

**Data flow**: Builds `ClientRequest::ThreadBackgroundTerminalsList` with thread ID and `None` cursor/limit, serializes it, and asserts the expected JSON. It returns `Result<()>`.

**Call relations**: This test covers another thread-scoped request variant and its nested params layout.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_background_terminals_terminate`  (lines 3055–3075)

```
fn serialize_thread_background_terminals_terminate() -> Result<()>
```

**Purpose**: Checks the wire format for terminating a background terminal by thread and process ID.

**Data flow**: Constructs `ClientRequest::ThreadBackgroundTerminalsTerminate`, serializes it, and compares to the expected JSON object. It returns `Result<()>`.

**Call relations**: This test validates the serde contract for a thread-scoped terminal-management request.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_realtime_start`  (lines 3078–3118)

```
fn serialize_thread_realtime_start() -> Result<()>
```

**Purpose**: Verifies serialization of the experimental realtime conversation start request with many optional fields populated.

**Data flow**: Builds `ClientRequest::ThreadRealtimeStart` with architecture, thread ID, model, output modality, startup-context flag, prompt, session ID, version, and voice, serializes it, and asserts the exact JSON. It returns `Result<()>`.

**Call relations**: This test covers a complex experimental request variant whose params include nested enums and optional fields with nuanced omission behavior.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_realtime_start_prompt_default_and_null`  (lines 3121–3233)

```
fn serialize_thread_realtime_start_prompt_default_and_null() -> Result<()>
```

**Purpose**: Pins down the distinction between omitted prompt, explicit null prompt, and deserialization back into the corresponding `Option<Option<String>>` states for realtime start.

**Data flow**: Constructs two `ClientRequest::ThreadRealtimeStart` values—one with `prompt: None` and one with `prompt: Some(None)`—serializes each and asserts the expected JSON difference. It then deserializes matching JSON payloads back into `ClientRequest` and asserts equality with the original values.

**Call relations**: This test is important because the realtime-start params intentionally preserve a three-state prompt field; it validates both serialization and parsing of that subtle contract.

*Call graph*: 3 external calls (Integer, assert_eq!, json!).


##### `tests::serialize_thread_realtime_append_speech`  (lines 3236–3256)

```
fn serialize_thread_realtime_append_speech() -> Result<()>
```

**Purpose**: Checks serialization of the experimental realtime speech-append request.

**Data flow**: Builds `ClientRequest::ThreadRealtimeAppendSpeech` with thread ID and text, serializes it, and asserts the exact JSON output. It returns `Result<()>`.

**Call relations**: This test covers another realtime request variant generated by the client request macro.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_status_changed_notification`  (lines 3259–3278)

```
fn serialize_thread_status_changed_notification() -> Result<()>
```

**Purpose**: Verifies the wire format of the `thread/status/changed` server notification.

**Data flow**: Constructs `ServerNotification::ThreadStatusChanged` with a thread ID and idle status, serializes it, and compares to the expected JSON object with `method` and `params`. It returns `Result<()>`.

**Call relations**: This test validates notification serialization generated by `server_notification_definitions!` for a common thread lifecycle event.

*Call graph*: 2 external calls (ThreadStatusChanged, assert_eq!).


##### `tests::serialize_thread_realtime_output_audio_delta_notification`  (lines 3281–3311)

```
fn serialize_thread_realtime_output_audio_delta_notification() -> Result<()>
```

**Purpose**: Checks serialization of the experimental realtime audio-output delta notification, including nested audio chunk metadata.

**Data flow**: Builds `ServerNotification::ThreadRealtimeOutputAudioDelta` with thread ID and a `ThreadRealtimeAudioChunk`, serializes it, and asserts the exact JSON shape. It returns `Result<()>`.

**Call relations**: This test covers a complex notification variant and complements later tests that verify its experimental marker.

*Call graph*: 2 external calls (ThreadRealtimeOutputAudioDelta, assert_eq!).


##### `tests::mock_experimental_method_is_marked_experimental`  (lines 3314–3321)

```
fn mock_experimental_method_is_marked_experimental()
```

**Purpose**: Ensures the mock experimental client request reports the expected experimental reason string.

**Data flow**: Constructs `ClientRequest::MockExperimentalMethod` with a default params value, calls `ExperimentalApi::experimental_reason(&request)`, and asserts the returned `Option<&'static str>` is `Some("mock/experimentalMethod")`.

**Call relations**: This test directly validates the `ExperimentalApi` implementation generated for `ClientRequest` by `client_request_definitions!` when a variant carries an explicit `#[experimental(...)]` annotation.

*Call graph*: 4 external calls (experimental_reason, Integer, default, assert_eq!).


##### `tests::environment_add_is_marked_experimental`  (lines 3324–3334)

```
fn environment_add_is_marked_experimental()
```

**Purpose**: Checks that the `environment/add` request is surfaced as experimental with its method string as the reason.

**Data flow**: Builds `ClientRequest::EnvironmentAdd`, invokes `ExperimentalApi::experimental_reason`, and asserts the result is `Some("environment/add")`. No state is mutated.

**Call relations**: This test confirms explicit experimental tagging on a concrete request variant generated by the macro.

*Call graph*: 3 external calls (experimental_reason, Integer, assert_eq!).


##### `tests::command_exec_permission_profile_is_marked_experimental`  (lines 3337–3360)

```
fn command_exec_permission_profile_is_marked_experimental()
```

**Purpose**: Verifies field-level experimental gating for `command/exec` when the optional `permission_profile` param is present.

**Data flow**: Constructs `ClientRequest::OneOffCommandExec` with `permission_profile: Some(...)`, calls `ExperimentalApi::experimental_reason` on the request, and asserts the result is `Some("command/exec.permissionProfile")`.

**Call relations**: Unlike explicit variant-level tags, this test exercises the `inspect_params: true` path in the generated `ClientRequest` experimental implementation, where the params type itself determines whether the request is experimental.

*Call graph*: 4 external calls (experimental_reason, Integer, assert_eq!, vec!).


##### `tests::thread_realtime_start_is_marked_experimental`  (lines 3363–3383)

```
fn thread_realtime_start_is_marked_experimental()
```

**Purpose**: Ensures the realtime-start request reports its explicit experimental reason.

**Data flow**: Builds `ClientRequest::ThreadRealtimeStart` with representative params, calls `ExperimentalApi::experimental_reason`, and asserts the returned reason is `Some("thread/realtime/start")`.

**Call relations**: This test validates explicit experimental tagging on one of the realtime request variants.

*Call graph*: 3 external calls (experimental_reason, Integer, assert_eq!).


##### `tests::thread_goal_methods_are_not_marked_experimental`  (lines 3386–3421)

```
fn thread_goal_methods_are_not_marked_experimental()
```

**Purpose**: Confirms that the thread goal set/get/clear request family is considered stable and returns no experimental reason.

**Data flow**: Constructs `ClientRequest::ThreadGoalSet`, `ThreadGoalGet`, and `ThreadGoalClear`, calls `ExperimentalApi::experimental_reason` on each, and asserts all results are `None`.

**Call relations**: This test guards against accidental experimental tagging of stable goal-management methods in the generated `ClientRequest` implementation.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::thread_goal_notifications_are_not_marked_experimental`  (lines 3424–3452)

```
fn thread_goal_notifications_are_not_marked_experimental()
```

**Purpose**: Checks that thread goal update and clear notifications are also treated as stable by the derived `ExperimentalApi` implementation on `ServerNotification`.

**Data flow**: Builds a `v2::ThreadGoal`, wraps it in `ServerNotification::ThreadGoalUpdated`, also constructs `ServerNotification::ThreadGoalCleared`, calls `ExperimentalApi::experimental_reason` on both, and asserts both are `None`.

**Call relations**: This test validates the derive-based experimental metadata on notifications, ensuring only explicitly annotated notification variants are gated.

*Call graph*: 3 external calls (ThreadGoalCleared, ThreadGoalUpdated, assert_eq!).


##### `tests::thread_settings_updated_notification_is_marked_experimental`  (lines 3455–3486)

```
fn thread_settings_updated_notification_is_marked_experimental()
```

**Purpose**: Ensures the `thread/settings/updated` notification carries its experimental reason string.

**Data flow**: Constructs a detailed `ServerNotification::ThreadSettingsUpdated` with nested `ThreadSettings`, including an absolute cwd path and collaboration mode settings, then calls `ExperimentalApi::experimental_reason` and asserts it returns `Some("thread/settings/updated")`.

**Call relations**: This test covers explicit experimental tagging on a notification variant generated by `server_notification_definitions!` and derived `ExperimentalApi`.

*Call graph*: 3 external calls (ThreadSettingsUpdated, absolute_path, assert_eq!).


##### `tests::turn_moderation_metadata_notification_is_marked_experimental`  (lines 3489–3501)

```
fn turn_moderation_metadata_notification_is_marked_experimental()
```

**Purpose**: Checks that the moderation metadata notification is marked experimental.

**Data flow**: Builds `ServerNotification::TurnModerationMetadata` with thread ID, turn ID, and arbitrary JSON metadata, calls `ExperimentalApi::experimental_reason`, and asserts the expected reason string is returned.

**Call relations**: This test validates another explicitly annotated notification variant in the generated notification enum.

*Call graph*: 3 external calls (TurnModerationMetadata, assert_eq!, json!).


##### `tests::thread_realtime_started_notification_is_marked_experimental`  (lines 3504–3513)

```
fn thread_realtime_started_notification_is_marked_experimental()
```

**Purpose**: Verifies that the realtime-started notification reports its experimental reason.

**Data flow**: Constructs `ServerNotification::ThreadRealtimeStarted`, invokes `ExperimentalApi::experimental_reason`, and asserts the result is `Some("thread/realtime/started")`.

**Call relations**: This test is part of the realtime notification gating coverage for the derived `ExperimentalApi` implementation.

*Call graph*: 3 external calls (ThreadRealtimeStarted, experimental_reason, assert_eq!).


##### `tests::thread_realtime_output_audio_delta_notification_is_marked_experimental`  (lines 3516–3531)

```
fn thread_realtime_output_audio_delta_notification_is_marked_experimental()
```

**Purpose**: Ensures the realtime output-audio delta notification is marked experimental in metadata as well as serializable on the wire.

**Data flow**: Builds `ServerNotification::ThreadRealtimeOutputAudioDelta` with a nested audio chunk, calls `ExperimentalApi::experimental_reason`, and asserts the expected reason string.

**Call relations**: This test complements the earlier serialization test for the same notification variant by checking experimental gating metadata.

*Call graph*: 3 external calls (ThreadRealtimeOutputAudioDelta, experimental_reason, assert_eq!).


##### `tests::command_execution_request_approval_additional_permissions_is_marked_experimental`  (lines 3534–3564)

```
fn command_execution_request_approval_additional_permissions_is_marked_experimental()
```

**Purpose**: Verifies field-level experimental gating on the server-request approval params type when `additional_permissions` is present.

**Data flow**: Constructs `v2::CommandExecutionRequestApprovalParams` with nested additional filesystem permissions and other approval metadata, calls `ExperimentalApi::experimental_reason(&params)` directly on the params object, and asserts the result is `Some("item/commandExecution/requestApproval.additionalPermissions")`.

**Call relations**: This test targets param-type experimental inspection rather than a top-level request enum, validating the field-sensitive `ExperimentalApi` implementation used by request/notification gating elsewhere in the protocol.

*Call graph*: 3 external calls (experimental_reason, assert_eq!, vec!).


### `app-server-protocol/src/protocol/mappers.rs`

`domain_logic` · `request translation`

This file contains a single `From` implementation that maps `v1::ExecOneOffCommandParams` into `v2::CommandExecParams`. Its role is narrowly focused but important: it codifies the exact compatibility contract between the older request schema and the richer v2 execution model. The conversion moves shared fields directly (`command`, `cwd`) and translates optional timeout data from the v1 numeric type into the v2 `i64` representation using `i64::try_from`. If that conversion fails, it does not propagate an error; instead it substitutes a hardcoded fallback of `60_000`, making timeout conversion intentionally lossy but predictable.

All v2 fields that have no v1 equivalent are initialized to conservative defaults: no `process_id`, no TTY, no stdin/stdout streaming, no output cap override, no timeout disablement, no environment override, no terminal size, and no permission profile. `sandbox_policy` is the only nontrivial nested mapping, converted only when present via `Into::into`, implying a separate policy mapper elsewhere. The implementation is purely functional and stateless: it consumes the v1 value and constructs a fresh v2 struct in one expression. The main invariant is that every v2 field is explicitly populated, so callers never receive a partially initialized command request during version bridging.

#### Function details

##### `CommandExecParams::from`  (lines 4–23)

```
fn from(value: v1::ExecOneOffCommandParams) -> Self
```

**Purpose**: Builds a `v2::CommandExecParams` from a consumed `v1::ExecOneOffCommandParams`, preserving the fields both versions share and filling every newer v2 field with explicit compatibility defaults. It also converts the optional timeout into `i64`, falling back to `60_000` if the source value cannot be represented.

**Data flow**: Input is a by-value `v1::ExecOneOffCommandParams`. It reads `command`, `timeout_ms`, `cwd`, and `sandbox_policy`; moves `command` and `cwd` directly into the result; maps `timeout_ms` through `i64::try_from(...).unwrap_or(60_000)` when present; maps `sandbox_policy` with `Into::into` when present; and writes fixed literals or `None` into all remaining v2-only fields (`process_id`, `tty`, streaming flags, output cap controls, `disable_timeout`, `env`, `size`, `permission_profile`). It returns a fully populated `v2::CommandExecParams` and mutates no external state.

**Call relations**: This conversion is invoked wherever code needs to pass a legacy v1 one-off command request into logic standardized on the v2 command execution type. Within that flow it serves as the version-bridge step before downstream execution or validation code consumes `v2::CommandExecParams`; its only delegated work is the nested `sandbox_policy` conversion and the standard-library integer conversion used for `timeout_ms`.


### `app-server-protocol/src/protocol/v1.rs`

`data_model` · `request/response schema definition across startup, auth, conversation handling, approvals, and config persistence`

This file is a dense schema catalog for the v1 protocol. It consists entirely of serde-serializable request and response structs and enums, each annotated for JSON Schema generation (`schemars::JsonSchema`) and TypeScript export (`ts_rs::TS`). The types bridge the app-server API to shared protocol primitives from `codex_protocol`, such as `ThreadId`, `ReviewDecision`, `SandboxPolicy`, `SessionSource`, `TurnAbortReason`, `ParsedCommand`, and model/config enums like `ReasoningEffort`, `ReasoningSummary`, `Verbosity`, `SandboxMode`, and `ForcedLoginMethod`.

The file covers several distinct API areas. Initialization uses `InitializeParams`, `ClientInfo`, `InitializeCapabilities`, and `InitializeResponse`, including negotiated capability flags like `experimental_api`, `request_attestation`, and notification suppression via `opt_out_notification_methods`. Conversation lookup is modeled by the untagged `GetConversationSummaryParams`, which accepts either a rollout path or a `conversationId`, and returns a `ConversationSummary` with filesystem location, preview text, timestamps, model provider, cwd, CLI version, source, and optional git metadata. Approval flows are represented separately for patch application and command execution, each carrying a `conversation_id`, correlation `call_id`, and a `ReviewDecision` response. Configuration persistence is captured by `UserSavedConfig`, `SandboxSettings`, and `Tools`, where most fields are optional to support partial user overrides rather than a fully materialized config.

Several design choices matter for consumers: many fields are optional and omitted when absent, camelCase is used almost everywhere except `ConversationGitInfo`’s snake_case payload, and `SandboxSettings.writable_roots` defaults to an empty vector to avoid null handling. `AbsolutePathBuf` is used where the protocol requires canonical absolute paths, while plain `PathBuf` is used for more general path references. The file therefore acts as the compatibility contract for older clients and servers, not as executable logic.


### V2 shared core and conversation model
This group introduces the v2 namespace, its shared enums and generic notifications, then the thread, turn, item, and review structures that form the central interactive protocol narrative.

### `app-server-protocol/src/protocol/v2/mod.rs`

`orchestration` · `cross-cutting`

This module is the aggregation point for the entire v2 app-server protocol. It declares all protocol-area submodules—such as account, config, process, review, notification, realtime, thread, and windows_sandbox—and then publicly re-exports their contents so downstream code can import protocol v2 types from a single place instead of addressing each leaf module individually. The file itself contains no executable logic; its significance is structural. It establishes the canonical composition of the v2 schema, including shared definitions via `shared` and feature-specific request/response/notification types in the other modules. Because every listed module is re-exported with `pub use ...::*`, this file effectively defines the public boundary of the versioned protocol crate for consumers, schema generation, and TypeScript export discovery. The `#[cfg(test)] mod tests;` declaration also makes room for protocol-level validation tests without exposing them in production builds. A reader should treat this file as the index of what belongs to protocol v2 and as the place where version membership is made explicit.


### `app-server-protocol/src/protocol/v2/shared.rs`

`util` · `cross-cutting protocol conversion and schema generation`

This file centralizes reusable protocol types that appear across many v2 endpoints. It starts with the `v2_enum_from_core!` macro, which generates API enums mirroring core enums while changing serde/TS casing and adding both `to_core` and `From<core>` conversions. The file then defines concrete shared types: `NonSteerableTurnKind`, `CodexErrorInfo`, `AskForApproval`, `ApprovalsReviewer`, and `SandboxMode`.

`CodexErrorInfo` is a carefully curated translation layer over upstream/core error variants. It preserves structured HTTP status metadata on selected variants and rewrites nested `turn_kind` into the v2 enum. `AskForApproval` is more involved: its `Granular` variant expands into booleans that are packed into or unpacked from `CoreGranularApprovalConfig`, with `skill_approval` and `request_permissions` defaulting to `false` on deserialization. `ApprovalsReviewer` is notable because it accepts both `"auto_review"` and legacy `"guardian_subagent"`; instead of deriving `JsonSchema`, it hand-builds a string enum schema with a descriptive compatibility note. `SandboxMode` is a straightforward kebab-case enum bridge.

The helper `default_enabled()` returns `true` for use by other modules’ serde defaults. Overall, this file’s design goal is stable external wire compatibility even when core enums use different casing, legacy aliases, or richer internal representations.

#### Function details

##### `default_enabled`  (lines 52–54)

```
fn default_enabled() -> bool
```

**Purpose**: Supplies a const default boolean value of `true` for serde defaults in other protocol types. It exists as a reusable named function because serde attributes require a function path.

**Data flow**: Takes no input, reads no state, and returns the literal boolean `true`.

**Call relations**: Referenced from serde default annotations elsewhere in the protocol module tree. It is not part of runtime control flow so much as compile-time wiring for deserialization defaults.


##### `CodexErrorInfo::from`  (lines 115–145)

```
fn from(value: CoreCodexErrorInfo) -> Self
```

**Purpose**: Translates core codex error variants into the v2 API error enum, preserving structured metadata where present. It also converts nested non-steerable turn kinds into the API enum.

**Data flow**: Consumes `CoreCodexErrorInfo`, matches each variant, and returns the corresponding `CodexErrorInfo`. For HTTP-related variants it copies `http_status_code`; for `ActiveTurnNotSteerable` it converts `turn_kind` via `NonSteerableTurnKind::from`; all simple variants map one-to-one.

**Call relations**: Used whenever backend/core failures are surfaced through v2 responses or notifications. In the nested active-turn case it delegates to `NonSteerableTurnKind::from` so the entire error payload is converted consistently.


##### `NonSteerableTurnKind::from`  (lines 149–154)

```
fn from(value: CoreNonSteerableTurnKind) -> Self
```

**Purpose**: Maps the core non-steerable turn kind enum into the v2 enum. It preserves whether the active turn is blocked because of review or compact mode.

**Data flow**: Accepts `CoreNonSteerableTurnKind`, matches `Review` or `Compact`, and returns the corresponding `NonSteerableTurnKind` variant.

**Call relations**: Called from `CodexErrorInfo::from` when converting `ActiveTurnNotSteerable` errors. It is a small nested adapter in the broader error translation path.


##### `AskForApproval::to_core`  (lines 182–202)

```
fn to_core(self) -> CoreAskForApproval
```

**Purpose**: Converts the API-facing approval policy into the core protocol representation used by backend logic. The granular variant is packed into `CoreGranularApprovalConfig`.

**Data flow**: Consumes `self` and matches each variant. Simple variants map directly to `CoreAskForApproval`; `Granular` extracts its five booleans and constructs `CoreAskForApproval::Granular(CoreGranularApprovalConfig { ... })`; the resulting core enum is returned.

**Call relations**: Invoked by configuration and request-building flows when user-supplied v2 approval settings must be applied to runtime/core config. It delegates only in the sense of constructing the core granular config payload for the backend.

*Call graph*: called by 3 (try_set_approval_policy_on_config, builtin_permission_mode_selection_item, set_approval_policy); 1 external calls (Granular).


##### `AskForApproval::from`  (lines 206–220)

```
fn from(value: CoreAskForApproval) -> Self
```

**Purpose**: Converts a core approval policy into the v2 API enum, unpacking granular configuration into explicit booleans. This keeps the wire format readable and stable for clients.

**Data flow**: Consumes `CoreAskForApproval`, matches each variant, and returns the corresponding `AskForApproval`. For `CoreAskForApproval::Granular`, it reads the embedded `granular_config` fields and expands them into the named booleans of `AskForApproval::Granular`.

**Call relations**: Used broadly when effective config or thread state is exposed back to clients, including config reads, session synchronization, event handling, and request/response assembly. It is the reverse half of the approval-policy boundary conversion.

*Call graph*: called by 16 (ask_for_approval_granular_round_trips_request_permissions_flag, sync_auto_review_runtime_state_from_effective_config, update_feature_flags, handle_event, session_state_for_thread_read, sync_active_thread_permission_settings_to_cached_session, submit_user_message_with_history_and_shell_escape_policy, open_full_access_confirmation, open_permissions_popup, preset_matches_current (+6 more)).


##### `ApprovalsReviewer::schema_name`  (lines 241–243)

```
fn schema_name() -> String
```

**Purpose**: Provides the explicit schema name for the custom `JsonSchema` implementation of `ApprovalsReviewer`. This keeps generated schema output stable and readable.

**Data flow**: Takes no input and returns the fixed string `"ApprovalsReviewer"`.

**Call relations**: Called by schemars during schema generation for this enum. It pairs with `ApprovalsReviewer::json_schema` to replace the derive-generated schema with a custom one.


##### `ApprovalsReviewer::json_schema`  (lines 245–250)

```
fn json_schema(_generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds a custom JSON Schema for `ApprovalsReviewer` that documents both canonical and legacy accepted string values. It ensures schema consumers see compatibility details that serde aliases alone would hide.

**Data flow**: Ignores the provided `SchemaGenerator`, calls `string_enum_schema_with_description` with the accepted values `user`, `auto_review`, and `guardian_subagent` plus a long description, and returns the resulting `Schema`.

**Call relations**: Invoked by schemars when exporting protocol schema. It delegates schema object construction to `string_enum_schema_with_description` so the enum-specific method stays declarative.

*Call graph*: calls 1 internal fn (string_enum_schema_with_description).


##### `string_enum_schema_with_description`  (lines 253–269)

```
fn string_enum_schema_with_description(values: &[&str], description: &str) -> Schema
```

**Purpose**: Constructs a string-enum JSON Schema object with an attached description. It is a reusable helper for custom schema generation.

**Data flow**: Accepts a slice of allowed string values and a description string, creates a `SchemaObject` with `instance_type` set to string and `metadata.description` populated, fills `enum_values` with `JsonValue::String` entries for each allowed value, wraps it in `Schema::Object`, and returns it.

**Call relations**: Called by `ApprovalsReviewer::json_schema` to avoid duplicating low-level schemars object assembly. It is a local helper for custom schema authoring rather than runtime protocol logic.

*Call graph*: called by 1 (json_schema); 3 external calls (new, default, Object).


##### `ApprovalsReviewer::to_core`  (lines 272–277)

```
fn to_core(self) -> CoreApprovalsReviewer
```

**Purpose**: Converts the API reviewer-routing enum into the core config enum. It collapses the API’s accepted values into the backend’s canonical reviewer choices.

**Data flow**: Consumes `self`, matches `User` or `AutoReview`, and returns `CoreApprovalsReviewer::User` or `CoreApprovalsReviewer::AutoReview` respectively.

**Call relations**: Used when applying v2 configuration or request overrides to backend runtime settings. It is the outbound half of the reviewer-routing conversion boundary.


##### `ApprovalsReviewer::from`  (lines 281–286)

```
fn from(value: CoreApprovalsReviewer) -> Self
```

**Purpose**: Converts the core reviewer-routing enum into the v2 API enum. It exposes the backend’s effective reviewer choice to clients.

**Data flow**: Accepts `CoreApprovalsReviewer`, matches `User` or `AutoReview`, and returns the corresponding `ApprovalsReviewer` variant.

**Call relations**: Used when serializing effective config or thread/session state back to clients. It complements `to_core` for round-tripping reviewer settings.


##### `SandboxMode::to_core`  (lines 299–305)

```
fn to_core(self) -> CoreSandboxMode
```

**Purpose**: Maps the v2 sandbox mode enum into the core config enum used by backend execution policy logic. The conversion is direct and exhaustive.

**Data flow**: Consumes `self`, matches `ReadOnly`, `WorkspaceWrite`, or `DangerFullAccess`, and returns the corresponding `CoreSandboxMode` variant.

**Call relations**: Called when thread/config requests specify sandbox mode and the backend needs the core representation. It is a simple boundary adapter with no nested delegation.


##### `SandboxMode::from`  (lines 309–315)

```
fn from(value: CoreSandboxMode) -> Self
```

**Purpose**: Maps the core sandbox mode enum into the v2 API enum. It exposes effective sandbox mode in the API’s kebab-case/camel-case schema layer.

**Data flow**: Accepts `CoreSandboxMode`, matches its three variants, and returns the corresponding `SandboxMode` value.

**Call relations**: Used when effective configuration or thread state is serialized back to clients. It is the inverse of `SandboxMode::to_core`.


### `app-server-protocol/src/protocol/v2/notification.rs`

`data_model` · `request handling`

This file defines several standalone notification structs that represent server-initiated events outside of feature-specific request/response flows. All types derive `Serialize`, `Deserialize`, `JsonSchema`, and `TS`, so the same Rust definitions drive wire encoding, JSON schema generation, and exported TypeScript bindings. `DeprecationNoticeNotification` carries a short deprecation summary plus optional migration details. `WarningNotification` models a user-facing warning that may optionally target a specific thread, while `GuardianWarningNotification` makes the thread target mandatory for guardian-specific warnings. `ErrorNotification` packages a `TurnError` together with retry semantics and the affected `thread_id` and `turn_id`; the `will_retry` flag is an important protocol invariant because it distinguishes transient background failures from turn-interrupting errors. `ServerRequestResolvedNotification` links a completed server-side request back to a `RequestId` and thread. The file’s design is intentionally data-only: there are no constructors or helpers, so field names, optionality, and serde casing are the protocol contract. The imported `TurnError` and `RequestId` tie these notifications back to the broader turn-processing and request-tracking model defined elsewhere in v2.


### `app-server-protocol/src/protocol/v2/thread_data.rs`

`data_model` · `cross-cutting thread/turn payload serialization`

This file contains the reusable data structures that represent threads and turns themselves. `Thread` captures identity, session tree relationships (`session_id`, `forked_from_id`, `parent_thread_id`), preview text, persistence mode, provider, timestamps, runtime `ThreadStatus`, optional rollout path, cwd, CLI version, source metadata, optional git info, optional user-facing name, and an optionally populated `turns` vector. `Turn` carries item payloads plus `items_view`, status, optional `TurnError`, and timing fields. `TurnItemsView` defaults to `Full`, which is important for backward compatibility with legacy payloads that omitted the field.

The file also defines source enums. `SessionSource` is a serde-friendly API enum that maps core session origins into public categories, intentionally collapsing `CoreSessionSource::Mcp` into `AppServer` and hiding `Internal(_)` as `Unknown`. `ThreadSource` is more specialized: it serializes as a plain string via `try_from = "String"` and `into = "String"`, delegates parsing/formatting to `CoreThreadSource`, and exposes a custom `JsonSchema` that is simply the schema for a string. That design lets feature-specific thread sources remain open-ended while still round-tripping through the core parser.

The behavioral code is all conversion glue: bidirectional `SessionSource` mapping, string-based `ThreadSource` parsing/formatting, and bidirectional conversion between API and core thread-source enums. `TurnError` derives `thiserror::Error`, formatting itself as its `message` while carrying optional structured `CodexErrorInfo` and additional details.

#### Function details

##### `SessionSource::from`  (lines 37–49)

```
fn from(value: CoreSessionSource) -> Self
```

**Purpose**: Converts a core session source into the API-facing `SessionSource` enum. It also intentionally hides internal-only sources from app-server clients.

**Data flow**: Consumes `CoreSessionSource`, matches each variant, and returns the corresponding `SessionSource`: `Cli`, `VsCode`, `Exec`, `AppServer` for `Mcp`, `Custom(source)`, `SubAgent(sub)`, or `Unknown` for both `Internal(_)` and `Unknown`.

**Call relations**: Used whenever thread/session metadata from core state is exposed through the v2 API. It delegates no further logic beyond constructing nested `Custom` or `SubAgent` variants.

*Call graph*: 2 external calls (Custom, SubAgent).


##### `CoreSessionSource::from`  (lines 53–63)

```
fn from(value: SessionSource) -> Self
```

**Purpose**: Converts the API `SessionSource` enum back into the core session source enum. It reverses the public-facing mapping used for thread metadata and request handling.

**Data flow**: Consumes `SessionSource`, matches each variant, and returns the corresponding `CoreSessionSource`: `Cli`, `VSCode`, `Exec`, `Mcp` for `AppServer`, `Custom(source)`, `SubAgent(sub)`, or `Unknown`.

**Call relations**: Used when API-layer session source values need to be handed back to core logic or persisted in core-native form. It is the inverse boundary adapter for `SessionSource::from`.

*Call graph*: 2 external calls (Custom, SubAgent).


##### `ThreadSource::schema_name`  (lines 78–80)

```
fn schema_name() -> String
```

**Purpose**: Provides the explicit schema name for the custom `JsonSchema` implementation of `ThreadSource`. This keeps generated schema output stable despite custom string-based serialization.

**Data flow**: Takes no input and returns the fixed string `"ThreadSource"`.

**Call relations**: Called by schemars during schema generation for `ThreadSource`, alongside `ThreadSource::json_schema`.


##### `ThreadSource::json_schema`  (lines 82–84)

```
fn json_schema(generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Defines `ThreadSource`’s JSON Schema as a plain string schema. This matches its serde representation, which is an untagged scalar string rather than an enum object.

**Data flow**: Accepts a mutable `SchemaGenerator`, delegates to `String::json_schema(generator)`, and returns the resulting `Schema`.

**Call relations**: Invoked by schemars when exporting protocol schema. It intentionally reuses the built-in string schema instead of enumerating values, because feature names are open-ended.

*Call graph*: 1 external calls (json_schema).


##### `ThreadSource::try_from`  (lines 90–92)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: Parses a string into the API `ThreadSource` by delegating to the core thread-source parser and then converting the parsed core value. This centralizes validation and accepted labels in the core type.

**Data flow**: Accepts a `String`, calls `value.parse::<CoreThreadSource>()`, maps the successful parse through `Into::into` to produce `ThreadSource`, and returns `Result<ThreadSource, String>` with the parser’s error string on failure.

**Call relations**: Used by serde deserialization because `ThreadSource` is declared with `#[serde(try_from = "String")]`. It depends on the core parser and then on `From<CoreThreadSource> for ThreadSource` for the final mapping.


##### `String::from`  (lines 96–98)

```
fn from(value: ThreadSource) -> Self
```

**Purpose**: Formats an API `ThreadSource` back into its scalar string representation by converting through the core thread-source type. This keeps serialization aligned with the core formatter.

**Data flow**: Consumes `ThreadSource`, converts it to `CoreThreadSource` via `CoreThreadSource::from(value)`, then converts that core value into `String` and returns it.

**Call relations**: Used by serde serialization because `ThreadSource` is declared with `#[serde(into = "String")]`. It relies on the `From<ThreadSource> for CoreThreadSource` adapter and the core type’s string conversion.

*Call graph*: 1 external calls (from).


##### `ThreadSource::from`  (lines 102–109)

```
fn from(value: CoreThreadSource) -> Self
```

**Purpose**: Converts a parsed core thread source into the API enum. It preserves built-in variants and carries feature names through unchanged.

**Data flow**: Consumes `CoreThreadSource`, matches `User`, `Subagent`, `Feature(feature)`, or `MemoryConsolidation`, and returns the corresponding `ThreadSource` variant, moving the feature string when present.

**Call relations**: Used after `ThreadSource::try_from` parses a string through the core type, and anywhere core thread metadata is exposed through the API. It is the inbound half of the thread-source boundary conversion.

*Call graph*: 1 external calls (Feature).


##### `CoreThreadSource::from`  (lines 113–120)

```
fn from(value: ThreadSource) -> Self
```

**Purpose**: Converts the API `ThreadSource` enum into the core thread-source enum. It preserves feature labels and built-in source categories exactly.

**Data flow**: Consumes `ThreadSource`, matches `User`, `Subagent`, `Feature(feature)`, or `MemoryConsolidation`, and returns the corresponding `CoreThreadSource` variant.

**Call relations**: Used by `String::from` during serialization and anywhere API thread-source values must be passed into core logic. It is the outbound half of the thread-source conversion pair.

*Call graph*: 1 external calls (Feature).


### `app-server-protocol/src/protocol/v2/thread.rs`

`data_model` · `thread request handling, pagination, and event serialization`

This file is the main protocol model for thread-oriented operations. It declares request and response structs for starting, resuming, forking, updating settings, reading, listing, searching, archiving, deleting, unsubscribing, naming, compacting, rolling back, and managing background terminals. Several fields use custom serde helpers to preserve nuanced semantics: `service_tier: Option<Option<String>>` distinguishes omission from explicit clearing, and `path` on resume/fork treats empty strings as absent. Experimental fields are annotated with `ExperimentalApi` metadata so schema filtering and runtime gating can identify them precisely.

The file also defines pagination containers (`ThreadListResponse`, `ThreadTurnsListResponse`, `ThreadTurnsItemsListResponse`, and `TurnsPage`), thread goal management types, thread memory mode, and token usage reporting. `ThreadListParams.cwd` is intentionally polymorphic via the untagged `ThreadListCwdFilter`, accepting either one string or many. `ThreadStatus` is a tagged enum with an `Active` variant carrying `active_flags`, while `ThreadMemoryMode` exposes both a string form and a core conversion.

Behavior is limited to six conversion helpers. `TurnsPage::from` repackages a turn-list response for resume bootstrapping. `ThreadGoal::from` adapts core goal state into API fields, stringifying the thread id and converting status. `ThreadTokenUsage::from` and `TokenUsageBreakdown::from` recursively translate core token accounting into API payloads, preserving total/last breakdowns and optional context window. These adapters keep the wire schema decoupled from core types while remaining structurally faithful.

#### Function details

##### `TurnsPage::from`  (lines 425–431)

```
fn from(response: ThreadTurnsListResponse) -> Self
```

**Purpose**: Converts a `ThreadTurnsListResponse` into the simpler `TurnsPage` wrapper used by thread resume responses. It reuses the same pagination data under a different type name.

**Data flow**: Consumes `ThreadTurnsListResponse`, copies `data`, `next_cursor`, and `backwards_cursor` into a new `TurnsPage`, and returns it.

**Call relations**: Used when a resume flow includes an initial turns page and wants to embed the result under `initial_turns_page`. It is a shallow adapter with no nested transformation beyond moving the existing fields.


##### `ThreadGoal::from`  (lines 682–693)

```
fn from(value: codex_protocol::protocol::ThreadGoal) -> Self
```

**Purpose**: Transforms a core thread goal into the API-facing `ThreadGoal` payload. It preserves counters and timestamps while converting the goal status enum and thread id representation.

**Data flow**: Consumes `codex_protocol::protocol::ThreadGoal`, converts `thread_id` to string, copies `objective`, `token_budget`, `tokens_used`, `time_used_seconds`, `created_at`, and `updated_at`, converts `status` via `.into()`, and returns the assembled `ThreadGoal`.

**Call relations**: Called by thread goal handling code when returning goal state to clients, including the goal-set path. It relies on the macro-generated `ThreadGoalStatus` conversion for the nested status field.

*Call graph*: called by 1 (thread_goal_set_inner).


##### `ThreadMemoryMode::as_str`  (lines 814–819)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the canonical lowercase string label for a thread memory mode. It provides a lightweight textual form without going through serde.

**Data flow**: Consumes `self`, matches `Enabled` or `Disabled`, and returns the corresponding `&'static str` literal `"enabled"` or `"disabled"`.

**Call relations**: Used wherever code needs a stable string representation of memory mode outside JSON serialization, such as logging, metrics, or command construction.


##### `ThreadMemoryMode::to_core`  (lines 821–826)

```
fn to_core(self) -> codex_protocol::protocol::ThreadMemoryMode
```

**Purpose**: Converts the API thread memory mode enum into the core protocol enum. The mapping is direct and exhaustive.

**Data flow**: Consumes `self`, matches `Enabled` or `Disabled`, and returns `codex_protocol::protocol::ThreadMemoryMode::Enabled` or `Disabled`.

**Call relations**: Used when thread memory mode requests from clients are applied to backend/core state. It is the outbound boundary adapter for this enum.


##### `ThreadTokenUsage::from`  (lines 1299–1305)

```
fn from(value: CoreTokenUsageInfo) -> Self
```

**Purpose**: Converts core token usage info into the API notification payload used for thread token usage updates. It preserves both cumulative and last-turn breakdowns.

**Data flow**: Consumes `CoreTokenUsageInfo`, converts `total_token_usage` and `last_token_usage` via `TokenUsageBreakdown::from`, copies `model_context_window`, and returns `ThreadTokenUsage { total, last, model_context_window }`.

**Call relations**: Called when sending token-usage update notifications to a connection. It delegates the nested breakdown conversion to `TokenUsageBreakdown::from` so the top-level adapter stays concise.

*Call graph*: called by 1 (send_thread_token_usage_update_to_connection).


##### `TokenUsageBreakdown::from`  (lines 1325–1333)

```
fn from(value: CoreTokenUsage) -> Self
```

**Purpose**: Maps a core token usage breakdown into the API-facing breakdown struct. It preserves all token counters exactly.

**Data flow**: Accepts `CoreTokenUsage`, copies `total_tokens`, `input_tokens`, `cached_input_tokens`, `output_tokens`, and `reasoning_output_tokens` into a new `TokenUsageBreakdown`, and returns it.

**Call relations**: Used by `ThreadTokenUsage::from` for both the cumulative and last-turn usage sections. It is the leaf conversion in the token accounting adaptation path.


### `app-server-protocol/src/protocol/v2/turn.rs`

`data_model` · `request/response schema definition and turn event serialization`

This file is primarily a schema layer: it declares the serialized request, response, and notification structs/enums used by the app-server’s v2 turn APIs, and derives Serde, JSON Schema, and TypeScript exports for them. The top half models turn lifecycle state (`TurnStatus`), turn-scoped overrides (`TurnStartParams`), steering and interruption requests, and notifications such as turn started/completed, diff updates, and plan updates. `TurnStartParams` is the densest type: it carries thread identity, user input, optional Responses API metadata, optional additional context fragments, environment selection, cwd/workspace overrides, approval and sandbox policy overrides, model/service-tier/reasoning/personality overrides, optional output schema, and experimental collaboration mode. Several fields are explicitly sticky across subsequent turns, and `service_tier` uses a double-`Option` serde helper so callers can distinguish omitted vs explicit null.

The lower half focuses on user input and plan conversion. `ByteRange` and `TextElement` preserve UI-defined spans inside text input, including an optional placeholder that is intentionally encapsulated behind constructor/accessor methods. `UserInput` supports text, remote images, local images, skills, and mentions; conversion to/from `CoreUserInput` renames the remote image URL field and rejects unsupported core variants with `unreachable!`. `text_char_count` counts Unicode scalar values only for text inputs, returning zero for non-text variants. Finally, `TurnPlanStep` and `TurnPlanStepStatus` convert plan-tool core types into the exported v2 notification shape.

#### Function details

##### `ByteRange::from`  (lines 220–225)

```
fn from(value: CoreByteRange) -> Self
```

**Purpose**: Converts a core `codex_protocol::user_input::ByteRange` into the app-server protocol `ByteRange` by copying its numeric bounds unchanged.

**Data flow**: Takes a `CoreByteRange` with `start` and `end` fields, reads those two `usize` values, and constructs a new public `ByteRange` with the same coordinates. It returns the new protocol-layer value and does not mutate external state.

**Call relations**: This conversion is used when higher-level protocol values are built from core user-input structures, notably through `TextElement::from` and `UserInput::from` paths that surface core data to API consumers.


##### `CoreByteRange::from`  (lines 229–234)

```
fn from(value: ByteRange) -> Self
```

**Purpose**: Converts the public protocol `ByteRange` back into the core `CoreByteRange` representation expected by lower-level logic.

**Data flow**: Consumes a `ByteRange`, reads its `start` and `end` fields, and returns a `CoreByteRange` with identical bounds. No shared state is read or written.

**Call relations**: This is the inverse bridge used when app-server request payloads are lowered into core protocol types, especially from `CoreTextElement::from` and then `UserInput::into_core`.


##### `TextElement::new`  (lines 248–253)

```
fn new(byte_range: ByteRange, placeholder: Option<String>) -> Self
```

**Purpose**: Constructs a `TextElement` from an explicit byte span and optional placeholder string, preserving the UI metadata attached to a text fragment.

**Data flow**: Accepts a `ByteRange` and `Option<String>`, stores them directly into a new `TextElement`, and returns that value. It performs no validation on the range or placeholder contents.

**Call relations**: It is the canonical constructor for this type: conversion from core text elements delegates here, and tests/builders call it directly when fabricating text-element spans.

*Call graph*: called by 4 (thread_read_returns_summary_without_turns, task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input, text_elements, expand_pending_pastes).


##### `TextElement::set_placeholder`  (lines 255–257)

```
fn set_placeholder(&mut self, placeholder: Option<String>)
```

**Purpose**: Replaces the stored placeholder text for an existing `TextElement`.

**Data flow**: Takes `&mut self` plus a new `Option<String>`, overwrites the private `placeholder` field, and returns unit. The byte range is left unchanged.

**Call relations**: This is a local mutator for callers that need to adjust UI display metadata after construction; it does not delegate further.


##### `TextElement::placeholder`  (lines 259–261)

```
fn placeholder(&self) -> Option<&str>
```

**Purpose**: Exposes the optional placeholder as a borrowed string slice without giving direct mutable access to the private field.

**Data flow**: Reads `self.placeholder`, converts `Option<String>` to `Option<&str>` via `as_deref`, and returns the borrowed view. It does not allocate or mutate state.

**Call relations**: This accessor complements `set_placeholder` and `new`, letting consumers inspect placeholder metadata while preserving field encapsulation.


##### `TextElement::from`  (lines 265–270)

```
fn from(value: CoreTextElement) -> Self
```

**Purpose**: Builds a public `TextElement` from a core `CoreTextElement`, including extraction of the placeholder through the core type’s conversion-only accessor.

**Data flow**: Consumes a `CoreTextElement`, converts its nested `byte_range` via `Into`, reads the optional placeholder through `_placeholder_for_conversion_only()`, clones that borrowed placeholder into an owned `String` when present, and passes both pieces into `TextElement::new`. It returns the resulting protocol-layer element.

**Call relations**: This function is part of the core-to-public conversion chain. `UserInput::from` uses it when translating text input element spans from core protocol values.

*Call graph*: 2 external calls (_placeholder_for_conversion_only, new).


##### `CoreTextElement::from`  (lines 274–276)

```
fn from(value: TextElement) -> Self
```

**Purpose**: Converts a public `TextElement` into the core `CoreTextElement` expected by downstream protocol logic.

**Data flow**: Consumes a `TextElement`, converts its `byte_range` into `CoreByteRange`, moves out the owned `placeholder`, and constructs the core value with `CoreTextElement::new`. It returns the new core element.

**Call relations**: This is the lowering step used by `UserInput::into_core` when serializable app-server text input is transformed into core protocol input.

*Call graph*: 1 external calls (new).


##### `UserInput::into_core`  (lines 313–330)

```
fn into_core(self) -> CoreUserInput
```

**Purpose**: Lowers each public `UserInput` variant into the corresponding `CoreUserInput` variant, including field renaming and nested text-element conversion.

**Data flow**: Consumes `self` and pattern-matches on the variant. For `Text`, it moves the `text` string and maps each `TextElement` through `Into::into`; for `Image`, it renames `url` to `image_url`; for `LocalImage`, `Skill`, and `Mention`, it forwards the stored fields unchanged. It returns a `CoreUserInput` and writes no external state.

**Call relations**: This function is the main bridge from API-layer turn input into core protocol processing. It delegates nested conversions for text spans so the rest of the system can operate on core types.


##### `UserInput::from`  (lines 334–352)

```
fn from(value: CoreUserInput) -> Self
```

**Purpose**: Raises a core `CoreUserInput` into the exported app-server `UserInput` enum, translating supported variants into the public wire shape.

**Data flow**: Consumes a `CoreUserInput` and matches its variant. `Text` maps nested `CoreTextElement`s into `TextElement`s; `Image` renames `image_url` to `url`; `LocalImage`, `Skill`, and `Mention` are copied structurally. Any unsupported core variant falls into `unreachable!`, asserting that this protocol layer should never receive it.

**Call relations**: This is the inverse of `into_core`, used when core-layer user input must be surfaced through app-server APIs or notifications. Its `unreachable!` marks an invariant between the supported core and public variant sets.

*Call graph*: 1 external calls (unreachable!).


##### `UserInput::text_char_count`  (lines 356–364)

```
fn text_char_count(&self) -> usize
```

**Purpose**: Computes the Unicode character count for text input while treating all non-text input variants as contributing zero characters.

**Data flow**: Borrows `self`, matches on the variant, and for `Text` counts `text.chars()`. For `Image`, `LocalImage`, `Skill`, and `Mention`, it returns `0` directly. No state is mutated.

**Call relations**: This is a small helper on the input model itself, likely used by callers that need text-length accounting without separately unpacking the enum.


##### `TurnPlanStep::from`  (lines 430–435)

```
fn from(value: CorePlanItemArg) -> Self
```

**Purpose**: Converts a core plan item argument into the public turn-plan step shape used in plan update notifications.

**Data flow**: Consumes a `CorePlanItemArg`, moves its `step` string, converts its `status` through `Into`, and returns a `TurnPlanStep`. No external state is touched.

**Call relations**: This conversion is used when plan-tool output from the core layer is repackaged into `TurnPlanUpdatedNotification.plan` entries.


##### `TurnPlanStepStatus::from`  (lines 439–445)

```
fn from(value: CorePlanStepStatus) -> Self
```

**Purpose**: Maps each core plan-step status enum variant to the corresponding public v2 status variant.

**Data flow**: Consumes a `CorePlanStepStatus`, matches `Pending`, `InProgress`, or `Completed`, and returns the identically named `TurnPlanStepStatus`. It is a pure enum translation.

**Call relations**: This is the nested status conversion used by `TurnPlanStep::from` so plan notifications expose stable app-server protocol enums instead of core ones.


### `app-server-protocol/src/protocol/v2/item.rs`

`data_model` · `thread item serialization, item lifecycle notifications, approval prompts, and tool-call/result transport`

This is the largest item-level protocol schema module. It declares the `ThreadItem` enum that represents all item kinds a client can observe in a thread—user messages, hook prompts, agent messages, plans, reasoning, command executions, file changes, MCP and dynamic tool calls, collaboration events, web search, image operations, review-mode markers, and context compaction. Around that core enum it defines many supporting types: command approval decisions, parsed command actions, memory citations, guardian auto-review payloads, command/file-change approval request and response structs, dynamic tool call payloads, and numerous streaming notifications.

Most behavior is conversion logic between core protocol types and v2 wire types. `ThreadItem::from` is the central adapter: it pattern-matches each `CoreTurnItem` variant, converts nested content, concatenates agent text fragments, derives file-change status with an `InProgress` fallback when core status is absent, converts MCP durations from `Duration` to `Option<i64>` milliseconds, and delegates nested conversions to helpers such as `convert_patch_changes`, `HookPromptFragment::from`, `PatchApplyStatus::from`, `McpToolCallStatus::from`, and `WebSearchAction::from`. Other conversions map approval decisions, guardian review actions, command parsing structures, memory citations, and collaboration agent states.

A few functions encode important compatibility rules: `ThreadItem::id` provides a uniform identifier accessor across all variants; `CommandExecutionStatus::from` and `PatchApplyStatus::from` intentionally only map terminal core statuses because `InProgress` is represented elsewhere in lifecycle handling; and `CommandExecutionRequestApprovalParams::strip_experimental_fields` explicitly removes unstable outbound fields for compatibility with clients that should not see them yet.

#### Function details

##### `CommandExecutionApprovalDecision::from`  (lines 69–87)

```
fn from(value: CoreReviewDecision) -> Self
```

**Purpose**: Maps a core review decision into the v2 command-approval decision enum, preserving richer approval outcomes such as session approval and policy amendments. It also collapses timeout into a decline for the client-facing API.

**Data flow**: Consumes `CoreReviewDecision`, pattern-matches each variant, converts embedded exec-policy or network-policy amendments with `.into()` where present, and returns the corresponding `CommandExecutionApprovalDecision`. No state is mutated.

**Call relations**: This conversion is used when approval outcomes from core need to be surfaced through v2 request/response or notification payloads.


##### `MemoryCitation::from`  (lines 137–142)

```
fn from(value: CoreMemoryCitation) -> Self
```

**Purpose**: Converts a core memory citation bundle into the v2 representation attached to agent messages. It preserves both the cited entries and the associated rollout/thread identifiers.

**Data flow**: Consumes `CoreMemoryCitation`, maps `entries` through `Into::into` into `Vec<MemoryCitationEntry>`, moves `rollout_ids` into `thread_ids`, and returns `MemoryCitation`.

**Call relations**: This conversion is invoked from `ThreadItem::from` when adapting a core `AgentMessage` that carries memory citation metadata.


##### `MemoryCitationEntry::from`  (lines 156–163)

```
fn from(value: CoreMemoryCitationEntry) -> Self
```

**Purpose**: Converts one cited memory span from the core type into the v2 wire struct. It is a direct field-preserving adapter.

**Data flow**: Consumes `CoreMemoryCitationEntry`, moves `path`, `line_start`, `line_end`, and `note` into a new `MemoryCitationEntry`, and returns it.

**Call relations**: This function is used by `MemoryCitation::from` while converting the citation's `entries` vector.


##### `CommandAction::into_core`  (lines 167–188)

```
fn into_core(self) -> CoreParsedCommand
```

**Purpose**: Turns the v2 parsed-command action enum back into the core parsed-command type used by internal command-processing code. It preserves the command text and any parsed path/query metadata.

**Data flow**: Consumes `self`, pattern-matches each `CommandAction` variant, renames the `command` field to the core `cmd` field, converts `AbsolutePathBuf` to a plain path buffer for `Read`, and returns the corresponding `CoreParsedCommand` variant.

**Call relations**: This is the outbound adapter used when client-provided or v2-layer command action data must be handed back to core parsing/execution logic.


##### `CommandAction::from_core_with_cwd`  (lines 190–207)

```
fn from_core_with_cwd(value: CoreParsedCommand, cwd: &AbsolutePathBuf) -> Self
```

**Purpose**: Builds a v2 command action from a core parsed command while rebasing relative read paths against a supplied working directory. This makes the wire payload carry an absolute path for `Read` actions.

**Data flow**: Consumes a `CoreParsedCommand` and borrows `cwd: &AbsolutePathBuf`; for `Read`, joins `cwd` with the core path and stores the resulting absolute path, while other variants move command/query/path fields directly. Returns a `CommandAction` and does not mutate external state.

**Call relations**: This helper is used when core parsed-command data is exposed to clients and the client-facing representation needs a cwd-aware absolute path for file reads.

*Call graph*: calls 1 internal fn (join).


##### `ThreadItem::id`  (lines 395–416)

```
fn id(&self) -> &str
```

**Purpose**: Provides a uniform way to access the stable item identifier regardless of which `ThreadItem` variant is present. It avoids repeated exhaustive matching at call sites.

**Data flow**: Borrows `&self`, matches every enum variant, and returns a shared `&str` reference to that variant's `id` field. It performs no allocation or mutation.

**Call relations**: This accessor is used by code that needs item identity without caring about item kind, especially notification and UI plumbing around heterogeneous thread items.


##### `AutoReviewDecisionSource::from`  (lines 440–444)

```
fn from(value: CoreGuardianAssessmentDecisionSource) -> Self
```

**Purpose**: Converts the core guardian decision-source enum into the v2 auto-review decision-source enum. At present it exposes only the `Agent` source.

**Data flow**: Consumes `CoreGuardianAssessmentDecisionSource`, matches the single supported variant, and returns `AutoReviewDecisionSource::Agent`.

**Call relations**: This adapter is used when guardian auto-review completion data is emitted to clients.


##### `GuardianRiskLevel::from`  (lines 459–466)

```
fn from(value: CoreGuardianRiskLevel) -> Self
```

**Purpose**: Maps the core guardian risk classification into the v2 risk-level enum used in approval auto-review payloads. It preserves the exact severity bucket.

**Data flow**: Consumes `CoreGuardianRiskLevel`, matches `Low`, `Medium`, `High`, or `Critical`, and returns the corresponding `GuardianRiskLevel`.

**Call relations**: This conversion is part of building `GuardianApprovalReview` payloads from core assessment results.


##### `GuardianUserAuthorization::from`  (lines 481–488)

```
fn from(value: CoreGuardianUserAuthorization) -> Self
```

**Purpose**: Maps the core guardian user-authorization level into the v2 enum. It preserves whether the user is unknown or classified at low/medium/high authorization.

**Data flow**: Consumes `CoreGuardianUserAuthorization`, matches each variant, and returns the corresponding `GuardianUserAuthorization`.

**Call relations**: This adapter is used alongside risk-level conversion when constructing approval auto-review payloads.


##### `GuardianCommandSource::from`  (lines 514–519)

```
fn from(value: CoreGuardianCommandSource) -> Self
```

**Purpose**: Converts the core command-source enum used by guardian reviews into the v2 command-source enum. It distinguishes shell-originated commands from unified-exec commands.

**Data flow**: Consumes `CoreGuardianCommandSource`, matches `Shell` or `UnifiedExec`, and returns the corresponding `GuardianCommandSource`.

**Call relations**: This conversion is used inside `GuardianApprovalReviewAction::from` when adapting command and execve review actions.


##### `CoreGuardianCommandSource::from`  (lines 523–528)

```
fn from(value: GuardianCommandSource) -> Self
```

**Purpose**: Converts the v2 guardian command-source enum back into the core enum. It is the inverse adapter for request paths that send review actions inward.

**Data flow**: Consumes `GuardianCommandSource`, matches `Shell` or `UnifiedExec`, and returns the corresponding `CoreGuardianCommandSource`.

**Call relations**: This conversion is used by `CoreGuardianAssessmentAction::try_from` when rebuilding core review actions from v2 payloads.


##### `GuardianApprovalReviewAction::from`  (lines 639–696)

```
fn from(value: CoreGuardianAssessmentAction) -> Self
```

**Purpose**: Transforms a core guardian assessment action into the tagged v2 review-action enum used in auto-review notifications. It preserves the action-specific payload for commands, execve, patch application, network access, MCP tool calls, and permission requests.

**Data flow**: Consumes `CoreGuardianAssessmentAction`, pattern-matches each variant, converts nested enums (`source`, `protocol`, `permissions`) where needed, moves strings/paths/vectors directly, and returns the corresponding `GuardianApprovalReviewAction` variant.

**Call relations**: This is the outward-facing adapter for guardian review notifications; it delegates nested conversions to `GuardianCommandSource::from`, `NetworkApprovalProtocol` conversion, and `RequestPermissionProfile` conversion.


##### `CoreGuardianAssessmentAction::try_from`  (lines 702–759)

```
fn try_from(value: GuardianApprovalReviewAction) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert a v2 guardian review action back into the core assessment-action type, validating nested permission payloads as needed. It returns an `io::Error` when nested conversions fail.

**Data flow**: Consumes `GuardianApprovalReviewAction`, pattern-matches each variant, converts nested command source and network protocol values, and for `RequestPermissions` calls `permissions.try_into()?`. Wraps the constructed core action in `Ok(...)` or propagates conversion errors.

**Call relations**: This is the inverse of `GuardianApprovalReviewAction::from`; it is used when client-supplied review-action data must be handed back to core approval logic.


##### `WebSearchAction::from`  (lines 783–796)

```
fn from(value: codex_protocol::models::WebSearchAction) -> Self
```

**Purpose**: Converts the core web-search action descriptor into the v2 tagged enum. It preserves the specific search/open/find-in-page operation and its optional parameters.

**Data flow**: Consumes `codex_protocol::models::WebSearchAction`, matches each variant, moves optional query/url/pattern fields into the corresponding `WebSearchAction`, and returns it.

**Call relations**: This conversion is used by `ThreadItem::from` for `CoreTurnItem::WebSearch`, and also by web-search event handling paths that need the same client-facing action shape.

*Call graph*: called by 2 (handle_web_search_end, from).


##### `ThreadItem::from`  (lines 800–890)

```
fn from(value: CoreTurnItem) -> Self
```

**Purpose**: Converts a core turn item into the v2 `ThreadItem` enum that clients consume. It is the central translation point for all item kinds emitted during a thread or turn.

**Data flow**: Consumes `CoreTurnItem` and pattern-matches each variant. It maps nested user inputs and hook prompt fragments, concatenates agent message text from `CoreAgentMessageContent::Text` entries, copies plan/reasoning/image/sleep fields, converts web-search actions, transforms file changes via `convert_patch_changes` and a status fallback to `PatchApplyStatus::InProgress`, converts MCP tool-call status/result/error and duration, and maps context compaction directly. Returns the assembled `ThreadItem` without mutating external state.

**Call relations**: This function is called by item lifecycle handlers when emitting started/completed notifications. It delegates nested work to helpers such as `convert_patch_changes`, `HookPromptFragment::from`, `PatchApplyStatus::from`, `McpToolCallStatus::from`, `McpToolCallResult::from`, `McpToolCallError::from`, `MemoryCitation::from`, and `WebSearchAction::from`.

*Call graph*: calls 3 internal fn (convert_patch_changes, from, from); called by 2 (handle_item_completed, handle_item_started).


##### `HookPromptFragment::from`  (lines 894–899)

```
fn from(value: codex_protocol::items::HookPromptFragment) -> Self
```

**Purpose**: Converts a core hook prompt fragment into the v2 fragment struct. It preserves the fragment text and the originating hook run identifier.

**Data flow**: Consumes `codex_protocol::items::HookPromptFragment`, moves `text` and `hook_run_id` into a new `HookPromptFragment`, and returns it.

**Call relations**: This conversion is used by `ThreadItem::from` when adapting `CoreTurnItem::HookPrompt`.


##### `CommandExecutionStatus::from`  (lines 919–925)

```
fn from(value: &CoreExecCommandStatus) -> Self
```

**Purpose**: Converts an owned core command-execution terminal status into the v2 status enum by delegating to the borrowed implementation. It avoids duplicating the actual mapping logic.

**Data flow**: Consumes `CoreExecCommandStatus`, borrows it temporarily, calls `Self::from(&value)`, and returns the resulting `CommandExecutionStatus`.

**Call relations**: This owned conversion exists as a convenience wrapper around the borrowed conversion implementation used elsewhere in the codebase.

*Call graph*: 1 external calls (from).


##### `PatchApplyStatus::from`  (lines 986–992)

```
fn from(value: &CorePatchApplyStatus) -> Self
```

**Purpose**: Converts an owned core patch-apply terminal status into the v2 status enum by delegating to the borrowed implementation. It keeps the mapping logic centralized.

**Data flow**: Consumes `CorePatchApplyStatus`, borrows it, calls `Self::from(&value)`, and returns the resulting `PatchApplyStatus`.

**Call relations**: This wrapper supports callers that own the core status while reusing the borrowed conversion logic.

*Call graph*: 1 external calls (from).


##### `McpToolCallStatus::from`  (lines 996–1002)

```
fn from(value: CoreMcpToolCallStatus) -> Self
```

**Purpose**: Maps the core MCP tool-call lifecycle status into the v2 enum. It preserves whether the call is still running, completed successfully, or failed.

**Data flow**: Consumes `CoreMcpToolCallStatus`, matches `InProgress`, `Completed`, or `Failed`, and returns the corresponding `McpToolCallStatus`.

**Call relations**: This conversion is used by `ThreadItem::from` when adapting `CoreTurnItem::McpToolCall`.

*Call graph*: called by 1 (from).


##### `SubAgentActivityKind::from`  (lines 1042–1048)

```
fn from(value: CoreSubAgentActivityKind) -> Self
```

**Purpose**: Converts the core sub-agent activity kind into the v2 enum used in thread items and notifications. It preserves whether the sub-agent started, interacted, or was interrupted.

**Data flow**: Consumes `CoreSubAgentActivityKind`, matches each variant, and returns the corresponding `SubAgentActivityKind`.

**Call relations**: This adapter is used wherever core collaboration/sub-agent activity is surfaced through the v2 item model.


##### `CollabAgentState::from`  (lines 1073–1104)

```
fn from(value: CoreAgentStatus) -> Self
```

**Purpose**: Converts a core agent runtime status into the v2 collaboration-agent state, including any terminal message text when present. It normalizes all statuses into a common `{ status, message }` shape.

**Data flow**: Consumes `CoreAgentStatus`, matches each variant, sets the corresponding `CollabAgentStatus`, and fills `message` with `None`, the optional completion message, or `Some(error)` for errored states. Returns a new `CollabAgentState`.

**Call relations**: This conversion is used by multiple collaboration event handlers when they need to publish the latest known state of spawned/resumed/closed agents to clients.

*Call graph*: called by 6 (item_event_to_server_notification, collab_resume_end_maps_to_item_completed_resume_agent, handle_collab_agent_interaction_end, handle_collab_agent_spawn_end, handle_collab_close_end, handle_collab_resume_end).


##### `CommandExecutionRequestApprovalParams::strip_experimental_fields`  (lines 1365–1370)

```
fn strip_experimental_fields(&mut self)
```

**Purpose**: Removes unstable fields from an approval-request payload before it is sent to clients that should not receive experimental data. Currently it strips only `additional_permissions`.

**Data flow**: Borrows `&mut self` and sets `self.additional_permissions = None`. It returns `()` and mutates the payload in place.

**Call relations**: This method is called on outbound approval-request payloads as a compatibility filter; the comment notes it is a temporary hardcoded approach pending a more generic experimental-field stripping mechanism.


##### `DynamicToolCallOutputContentItem::from`  (lines 1439–1446)

```
fn from(item: DynamicToolCallOutputContentItem) -> Self
```

**Purpose**: Converts the v2 dynamic-tool output content item into the core dynamic-tools content item. It preserves whether the content is text or an image URL.

**Data flow**: Consumes `DynamicToolCallOutputContentItem`, matches `InputText` or `InputImage`, moves the contained string, and returns the corresponding `codex_protocol::dynamic_tools::DynamicToolCallOutputContentItem`.

**Call relations**: This conversion is used when client-provided dynamic tool call responses are handed back to core dynamic-tool execution logic.


### `app-server-protocol/src/protocol/v2/review.rs`

`data_model` · `request handling`

This file models the review-start API in protocol v2. It begins by deriving a protocol-facing `ReviewDelivery` enum from the core protocol enum via the `v2_enum_from_core!` macro, preserving the allowed delivery modes `Inline` and `Detached` while keeping the v2 schema aligned with shared core definitions. `ReviewStartParams` identifies the source thread, the review target, and an optional delivery preference; when omitted, delivery defaults to inline behavior as documented in the field comment. `ReviewStartResponse` returns the resulting `Turn` plus a `review_thread_id`, which is either the original thread for inline execution or a newly created thread for detached execution. The `ReviewTarget` tagged enum is the main domain model here: it supports reviewing all uncommitted changes, a diff against a named base branch, a specific commit identified by SHA with an optional UI title, or arbitrary custom instructions equivalent to the older free-form prompt style. Serde and TS tagging use `type` with camelCase naming, making the discriminated union explicit on the wire. The file is purely declarative, but its comments encode important semantics around default delivery and the meaning of the returned thread id.


### `app-server-protocol/src/protocol/v2/realtime.rs`

`data_model` · `realtime session setup and streaming event serialization`

This file models the experimental realtime API surface for a thread. It introduces `ThreadRealtimeAudioChunk`, a transport-friendly audio frame carrying base64/string `data`, `sample_rate`, `num_channels`, optional `samples_per_channel`, and optional `item_id`. Around that, it defines request/response structs for starting a realtime session, appending audio/text/speech, stopping a session, and listing supported voices. `ThreadRealtimeStartParams` is the richest payload: it allows per-session overrides for architecture, model, protocol version, voice, transport (`Websocket` or `Webrtc { sdp }`), startup context inclusion, and a double-optional `prompt` that distinguishes omission from explicit null.

The notification types describe the event stream emitted after startup: acceptance (`ThreadRealtimeStartedNotification`), raw non-audio items, transcript deltas and completions, output audio chunks, remote SDP for WebRTC, errors, and closure reasons. The only executable logic is the pair of `From` implementations between `CoreRealtimeAudioFrame` and `ThreadRealtimeAudioChunk`. Both are symmetric destructuring/reconstruction adapters with no validation or transformation, which keeps the app-server wire format aligned with the core realtime engine while still letting this crate own its exported schema and TypeScript bindings.

#### Function details

##### `ThreadRealtimeAudioChunk::from`  (lines 27–42)

```
fn from(value: CoreRealtimeAudioFrame) -> Self
```

**Purpose**: Converts a core realtime audio frame into the v2 thread realtime audio chunk used on the app-server API. It is a lossless field-for-field adaptation.

**Data flow**: Consumes `CoreRealtimeAudioFrame`, destructures out `data`, `sample_rate`, `num_channels`, `samples_per_channel`, and `item_id`, then returns `ThreadRealtimeAudioChunk` with those same values.

**Call relations**: Used when backend/core realtime events need to be emitted through the v2 protocol, especially in output-audio notifications or any API surface that exposes audio frames. It does not delegate further because all fields are scalar or optional scalar values.


##### `CoreRealtimeAudioFrame::from`  (lines 46–61)

```
fn from(value: ThreadRealtimeAudioChunk) -> Self
```

**Purpose**: Converts the API-facing `ThreadRealtimeAudioChunk` back into the core realtime frame type consumed by backend logic. This is the inverse of the other conversion.

**Data flow**: Takes ownership of a `ThreadRealtimeAudioChunk`, destructures its five fields, and rebuilds a `CoreRealtimeAudioFrame` with identical contents.

**Call relations**: Used when client-supplied audio chunks from `thread/realtime/appendAudio` or similar flows must be handed to the core realtime subsystem. It sits at the protocol boundary and performs no validation beyond Rust type compatibility.


### V2 account and configuration surfaces
These files cover user/session state, models and apps, permissions and configuration, and the surrounding administrative and feature-management protocol payloads.

### `app-server-protocol/src/protocol/v2/account.rs`

`data_model` · `request/response serialization and notification payload definition across account-related API calls`

This file is the protocol surface for account features in API v2. Most of it is made of serde/JsonSchema/ts-rs annotated enums and structs that precisely shape JSON and generated TypeScript definitions for account login flows, session management, token refresh, rate-limit inspection, token-usage reporting, add-credits nudges, and account-change notifications. The `Account` enum models the currently authenticated provider account with variants for API key, ChatGPT, and Amazon Bedrock; the Bedrock variant uses a serde default so omitted `credential_source` fields deserialize to `AwsManaged`. Login is split into request and response enums so each auth mode carries only the fields relevant to that flow, including an experimental internal-only `chatgptAuthTokens` path and a device-code variant with verification URL and user code.

The second major responsibility is adapting core protocol/domain types into this v2 schema. `From` implementations convert `ProviderAccount`, rate-limit snapshots, windows, credits, spend-control limits, and reached-type enums from `codex_protocol` types into the local exported forms. These conversions preserve optionality, map nested structures recursively, and normalize a few representation details such as rounding `used_percent` from a core floating-point value into an `i32`. Several payloads intentionally use plain `String` identifiers instead of UUID-specific types to avoid JSON Schema and TypeScript generation quirks; conversion to stronger ID types is deferred to higher layers. Sparse rolling notifications are documented as merge-on-client updates rather than full replacements, which is an important behavioral contract not visible from the field list alone.

#### Function details

##### `default_bedrock_credential_source`  (lines 38–40)

```
fn default_bedrock_credential_source() -> AmazonBedrockCredentialSource
```

**Purpose**: Supplies the default Amazon Bedrock credential source used when deserializing an `Account::AmazonBedrock` payload that omits `credential_source`. It hard-codes the protocol default to AWS-managed credentials.

**Data flow**: It takes no arguments and reads no external state. It constructs and returns the enum value `AmazonBedrockCredentialSource::AwsManaged`, which serde uses through the `default` attribute on the `credential_source` field.

**Call relations**: This function is not part of request handling logic directly; serde invokes it during deserialization only when an `amazonBedrock` account object lacks the `credential_source` property. It delegates to no other code because the default is a single constant enum variant.


##### `Account::from`  (lines 43–51)

```
fn from(account: ProviderAccount) -> Self
```

**Purpose**: Converts an internal/provider-facing `ProviderAccount` enum into the v2 protocol `Account` enum exposed on the wire. It preserves the provider-specific payload fields while changing only the type namespace.

**Data flow**: It consumes a `ProviderAccount` value, pattern-matches on its variant, and rebuilds the corresponding local `Account` variant. For `Chatgpt` it moves `email` and `plan_type`; for `AmazonBedrock` it moves `credential_source`; for `ApiKey` it returns the empty `ApiKey {}` variant.

**Call relations**: This conversion is used wherever higher layers need to serialize provider account state into a v2 response such as `GetAccountResponse`. It is a leaf adapter: callers hand it a core/provider model, and it delegates only to Rust pattern matching without invoking helper functions.


##### `RateLimitSnapshot::from`  (lines 422–435)

```
fn from(value: CoreRateLimitSnapshot) -> Self
```

**Purpose**: Transforms a core rate-limit snapshot into the v2 snapshot shape returned by account rate-limit endpoints and notifications. It performs the top-level field mapping and recursively converts nested optional substructures.

**Data flow**: It consumes a `CoreRateLimitSnapshot` and copies scalar/optional fields like `limit_id`, `limit_name`, and `plan_type` directly. For nested fields it maps `primary` and `secondary` through `RateLimitWindow::from`, `credits` through `CreditsSnapshot::from`, `individual_limit` through `SpendControlLimitSnapshot::from`, and `rate_limit_reached_type` through `RateLimitReachedType::from`, returning a fully populated local `RateLimitSnapshot`.

**Call relations**: Callers use this when exposing core metering state through `GetAccountRateLimitsResponse` or `AccountRateLimitsUpdatedNotification`. It sits at the center of the conversion chain, delegating nested pieces to the other `From` implementations in this file so the outer response builder does not need to know each sub-type mapping.


##### `RateLimitReachedType::from`  (lines 450–466)

```
fn from(value: CoreRateLimitReachedType) -> Self
```

**Purpose**: Maps the core enum describing why a rate limit was hit into the v2 protocol enum with the same semantic cases. It preserves all distinct workspace-owner/member and credits/usage-limit reasons.

**Data flow**: It takes a `CoreRateLimitReachedType`, matches each variant, and returns the corresponding local `RateLimitReachedType` variant. No fields are transformed because both enums are simple tagged cases.

**Call relations**: This function is reached from `RateLimitSnapshot::from` when a core snapshot includes `rate_limit_reached_type`. It delegates nowhere else; its role is to isolate the wire-format enum from the core enum so the rest of the protocol layer can depend only on local exported types.


##### `CoreRateLimitReachedType::from`  (lines 470–486)

```
fn from(value: RateLimitReachedType) -> Self
```

**Purpose**: Performs the reverse conversion from the v2 `RateLimitReachedType` back into the core `CoreRateLimitReachedType`. This allows code that accepts protocol-layer values to pass them back into core logic without exposing protocol enums downstream.

**Data flow**: It consumes a local `RateLimitReachedType`, matches on the five possible variants, and returns the equivalent `CoreRateLimitReachedType`. The transformation is one-to-one and does not touch any external state.

**Call relations**: This reverse adapter is used when protocol input or intermediate state must be converted back into core metering types. Unlike the forward conversion used by snapshot serialization, this one supports flows moving from API-layer representations into internal logic.


##### `RateLimitWindow::from`  (lines 501–507)

```
fn from(value: CoreRateLimitWindow) -> Self
```

**Purpose**: Converts a core rate-limit window into the v2 wire representation, including normalizing percentage precision. It turns the core floating-point usage percentage into an integer percentage for clients.

**Data flow**: It consumes a `CoreRateLimitWindow`, reads `used_percent`, `window_minutes`, and `resets_at`, rounds `used_percent` with `.round()` and casts it to `i32`, renames `window_minutes` to `window_duration_mins`, and returns a local `RateLimitWindow`.

**Call relations**: This function is called from `RateLimitSnapshot::from` for both `primary` and `secondary` windows when those options are present. It is a narrow leaf conversion whose main design choice is the explicit rounding step before serialization.


##### `CreditsSnapshot::from`  (lines 520–526)

```
fn from(value: CoreCreditsSnapshot) -> Self
```

**Purpose**: Adapts the core credits snapshot into the v2 credits payload embedded in rate-limit responses. It preserves the account's credit availability, unlimited flag, and optional balance string exactly.

**Data flow**: It takes a `CoreCreditsSnapshot`, copies `has_credits`, `unlimited`, and `balance` into a new local `CreditsSnapshot`, and returns it. There is no computation beyond field transfer.

**Call relations**: This converter is invoked by `RateLimitSnapshot::from` when the core snapshot includes credits information. It exists to keep the outer snapshot conversion simple and to decouple the exported schema type from the core protocol type.


##### `SpendControlLimitSnapshot::from`  (lines 541–548)

```
fn from(value: CoreSpendControlLimitSnapshot) -> Self
```

**Purpose**: Converts a core spend-control limit snapshot into the v2 representation used inside account rate-limit payloads. It carries over the monetary/string values and reset timing without reinterpretation.

**Data flow**: It consumes a `CoreSpendControlLimitSnapshot`, copies `limit`, `used`, `remaining_percent`, and `resets_at` into a local `SpendControlLimitSnapshot`, and returns the new struct. No optional wrapping or numeric normalization is applied here.

**Call relations**: This function is called from `RateLimitSnapshot::from` when an `individual_limit` is present in the core snapshot. It is one of the nested adapters that collectively build the full v2 rate-limit response tree.


### `app-server-protocol/src/protocol/v2/model.rs`

`data_model` · `model catalog reads and model-related notifications during turn execution`

This file is a compact schema module for model-related API payloads. It exports macro-generated enums for model reroute reasons and verification markers, request/response structs for reading provider capabilities and listing models, and the nested model metadata types used in those responses (`Model`, `ModelUpgradeInfo`, `ModelServiceTier`, `ReasoningEffortOption`, `ModelAvailabilityNux`). It also defines notifications for model rerouting, model verification, and arbitrary moderation metadata attached to a turn.

The `Model` struct is the main payload shape and includes both catalog metadata (`id`, `display_name`, `description`, `hidden`, `is_default`) and capability/configuration details such as supported reasoning efforts, default reasoning effort, input modalities, personality support, and service-tier information. Several serde defaults are important here: `input_modalities` falls back to `default_input_modalities`, `supports_personality` and tier lists default to empty/false, and `default_service_tier` is optional. That keeps deserialization stable across older payloads and partial catalogs.

Behavior in this file is intentionally minimal. `ModelAvailabilityNux::from` is a direct adapter from the core type, exposing only the user-facing message string that explains availability or upgrade context for a model.

#### Function details

##### `ModelAvailabilityNux::from`  (lines 63–67)

```
fn from(value: CoreModelAvailabilityNux) -> Self
```

**Purpose**: Converts the core model-availability NUX payload into the v2 wire struct. It preserves the explanatory message shown to clients.

**Data flow**: Consumes `CoreModelAvailabilityNux`, moves `value.message` into a new `ModelAvailabilityNux`, and returns it. No state is mutated.

**Call relations**: This adapter is used when model catalog data from core includes availability NUX information that must be serialized through the v2 API.


### `app-server-protocol/src/protocol/v2/apps.rs`

`data_model` · `request/response serialization for app listing and app-change notifications`

This file is primarily a protocol schema module: it declares request/response payloads such as `AppsListParams`, `AppsListResponse`, and `AppListUpdatedNotification`, plus the nested metadata structs that describe an app (`AppBranding`, `AppMetadata`, `AppReview`, `AppScreenshot`, `AppInfo`, `AppSummary`). All types derive `Serialize`, `Deserialize`, `JsonSchema`, and `TS`, so the same Rust definitions drive JSON transport, schema generation, and TypeScript export.

The only behavioral logic is around category normalization. `AppInfo::category` computes a single display category by first checking `branding.category`, then falling back to the first non-empty string in `app_metadata.categories`. The helper trims whitespace and rejects empty strings, so callers do not have to distinguish between missing, blank, and whitespace-only categories. `AppSummary` is a reduced projection of `AppInfo` intended for plugin responses; its `From<AppInfo>` implementation preserves only the identifier, name, description, install URL, and the derived category. A notable design choice is that `AppInfo` carries several booleans with explicit serde defaults (`is_accessible`, `is_enabled`, `plugin_display_names`), making absent fields deserialize into stable, client-friendly values rather than `Option`s.

#### Function details

##### `AppInfo::category`  (lines 106–120)

```
fn category(&self) -> Option<String>
```

**Purpose**: Computes a normalized category string for an app from the richer metadata already stored on `AppInfo`. It prefers branding metadata and only falls back to app metadata categories when branding does not yield a usable value.

**Data flow**: Reads `self.branding.category` first, passes it through `non_empty_category` to trim whitespace and discard blank strings, and if that returns `None`, reads `self.app_metadata.categories`, scans the vector in order, and returns the first category whose trimmed text is non-empty. Produces `Option<String>` and does not mutate any state.

**Call relations**: This method is used when converting a full `AppInfo` into an `AppSummary`, so summary generation inherits the same fallback and normalization rules instead of duplicating them.

*Call graph*: called by 1 (from).


##### `non_empty_category`  (lines 123–130)

```
fn non_empty_category(category: Option<&str>) -> Option<String>
```

**Purpose**: Normalizes an optional category string by trimming it and rejecting empty results. It centralizes the distinction between absent, blank, and meaningful category values.

**Data flow**: Accepts `Option<&str>`, returns early with `None` if the option is absent, trims the borrowed string slice, checks `is_empty`, and either returns `None` or allocates and returns `Some(String)` from the trimmed text. It has no side effects.

**Call relations**: This helper is the shared predicate used by `AppInfo::category` for both the branding field and each candidate in the metadata category list, ensuring both paths apply identical cleanup rules.


##### `AppSummary::from`  (lines 145–154)

```
fn from(value: AppInfo) -> Self
```

**Purpose**: Builds the compact summary representation from a full `AppInfo` by moving over only the fields needed by lightweight plugin-facing responses. It also computes the summary category using the same normalization logic as the full app model.

**Data flow**: Consumes an `AppInfo`, invokes `value.category()` before moving fields out, then constructs `AppSummary` with `id`, `name`, `description`, `install_url`, and the derived `category`. Returns the new summary and drops all other `AppInfo` fields.

**Call relations**: This conversion is the caller of `AppInfo::category`; it sits at the boundary where richer app inventory data is reduced to a smaller payload for downstream consumers.

*Call graph*: calls 1 internal fn (category).


### `app-server-protocol/src/protocol/v2/collaboration_mode.rs`

`data_model` · `request/response serialization for collaboration mode preset listing`

This module is a thin schema adapter around collaboration mode presets. It declares an empty `CollaborationModeListParams` request, a `CollaborationModeListResponse` containing a vector of masks, and the `CollaborationModeMask` struct itself. The mask exposes the preset `name` plus optional `mode`, `model`, and `reasoning_effort`, mirroring the core configuration surface while remaining serializable to JSON and exportable to TypeScript.

The only logic is the `From<CoreCollaborationModeMask>` conversion, which performs a field-for-field transfer from the core type imported from `codex_protocol::config_types`. One subtle point is the `reasoning_effort` field type: `Option<Option<ReasoningEffort>>`. That preserves three distinct states on the wire—field absent, field explicitly null, and field set to a concrete effort—so clients can distinguish “unset” from “intentionally cleared.” The serde and ts-rs rename attributes keep the field spelled `reasoning_effort` rather than camel-casing it, matching existing protocol expectations.

#### Function details

##### `CollaborationModeMask::from`  (lines 29–36)

```
fn from(value: CoreCollaborationModeMask) -> Self
```

**Purpose**: Converts the core collaboration mode preset descriptor into the v2 protocol struct without changing semantics. It preserves optionality exactly so clients can see whether each preset overrides a field or leaves it unspecified.

**Data flow**: Consumes a `CoreCollaborationModeMask`, moves out `name`, `mode`, `model`, and `reasoning_effort`, and returns a new `CollaborationModeMask`. No external state is read or written.

**Call relations**: This conversion is used wherever core collaboration mode inventory is exposed through the v2 API, acting as the final adaptation step before serialization.


### `app-server-protocol/src/protocol/v2/permissions.rs`

`data_model` · `approval prompts, permission profile reads, sandbox configuration parsing, and permission-related request/response serialization`

This module is the protocol boundary for permission-related data. It models network approval context, additional filesystem and network permissions, request and granted permission profiles, active permission profile selection, filesystem path/sandbox entry abstractions, sandbox policies, exec-policy amendments, network policy amendments, and approval request/response payloads. Many of these types exist specifically to bridge between client-friendly wire shapes and core types that still use older path representations or internal enums.

The most involved logic is in the filesystem permission conversions. `AdditionalFileSystemPermissions::from` supports both legacy read/write root lists and the newer canonical `entries` representation: if core exposes legacy roots, it populates both the deprecated `read`/`write` fields and synthesizes equivalent `entries`; otherwise it preserves canonical entries and `glob_scan_max_depth`. The inverse `TryFrom` accepts either representation, converting `LegacyAppPathString` values into native absolute paths and propagating invalid-path errors as `io::Error`. Similar bidirectional adapters exist for request/additional permission profiles, filesystem special paths, sandbox entries, and network permissions.

`SandboxPolicy` has custom deserialization to reject deprecated restricted-read settings (`readOnly.access` and `workspaceWrite.readOnlyAccess`) with explicit error messages, while still accepting older payload shapes that map cleanly to current variants. The `to_core`/`from` methods then translate between the v2 enum and core runtime sandbox policy, including the nested external-sandbox network access mode.

#### Function details

##### `NetworkApprovalContext::from`  (lines 47–52)

```
fn from(value: CoreNetworkApprovalContext) -> Self
```

**Purpose**: Converts the core network approval context into the v2 wire struct used in approval prompts. It preserves the target host and protocol.

**Data flow**: Consumes `CoreNetworkApprovalContext`, moves `host`, converts `protocol` with `.into()`, and returns `NetworkApprovalContext`.

**Call relations**: This adapter is used when managed-network approval requests are surfaced to clients.


##### `AdditionalFileSystemPermissions::from`  (lines 73–124)

```
fn from(value: CoreFileSystemPermissions<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts core filesystem permissions into the v2 additional-permissions shape while preserving backward compatibility with deprecated `read`/`write` root lists. When legacy roots are present, it also synthesizes canonical `entries` so clients can consume either representation.

**Data flow**: Consumes `CoreFileSystemPermissions<AbsolutePathBuf>`. If `legacy_read_write_roots()` returns roots, it allocates an `entries` vector sized for both read and write lists, converts each absolute path into `LegacyAppPathString`, emits deprecated `read`/`write` fields, and creates matching `FileSystemSandboxEntry` values with `Read` or `Write` access. Otherwise it preserves `glob_scan_max_depth` and maps canonical `entries` through `FileSystemSandboxEntry::from`. Returns `AdditionalFileSystemPermissions`.

**Call relations**: This conversion is used by higher-level permission profile adapters and is covered by tests that verify both legacy-root synthesis and canonical-entry preservation.

*Call graph*: called by 2 (additional_file_system_permissions_populates_entries_for_legacy_roots, additional_file_system_permissions_preserves_canonical_entries); 2 external calls (legacy_read_write_roots, with_capacity).


##### `CoreFileSystemPermissions::try_from`  (lines 131–171)

```
fn try_from(value: AdditionalFileSystemPermissions) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert the v2 additional-filesystem-permissions payload back into core filesystem permissions, accepting either canonical `entries` or deprecated `read`/`write` roots. It validates and normalizes path strings into native absolute paths.

**Data flow**: Consumes `AdditionalFileSystemPermissions`. If `entries` is present, it converts each entry with `CoreFileSystemSandboxEntry::try_from` and builds a core permissions struct with `glob_scan_max_depth: None`. Otherwise it converts `read` and `write` `LegacyAppPathString` values into native path URIs and absolute paths, then calls `CoreFileSystemPermissions::from_read_write_roots`. Finally it overwrites `glob_scan_max_depth` from the input and returns `Ok(core_permissions)` or an `io::Error` on invalid paths.

**Call relations**: This is the inverse of `AdditionalFileSystemPermissions::from`; it is used by request/additional/granted permission profile conversions whenever client-supplied filesystem permissions must be handed to core.

*Call graph*: 1 external calls (from_read_write_roots).


##### `AdditionalNetworkPermissions::from`  (lines 182–186)

```
fn from(value: CoreNetworkPermissions) -> Self
```

**Purpose**: Converts core network permission settings into the v2 additional-network-permissions struct. It currently exposes only the optional enabled flag.

**Data flow**: Consumes `CoreNetworkPermissions`, moves `enabled` into `AdditionalNetworkPermissions`, and returns it.

**Call relations**: This adapter is used by request and additional permission profile conversions.


##### `CoreNetworkPermissions::from`  (lines 190–194)

```
fn from(value: AdditionalNetworkPermissions) -> Self
```

**Purpose**: Converts the v2 additional-network-permissions struct back into the core network permissions type. It is a direct field-preserving adapter.

**Data flow**: Consumes `AdditionalNetworkPermissions`, moves `enabled` into `CoreNetworkPermissions`, and returns it.

**Call relations**: This inverse conversion is used when client-supplied permission overlays are passed into core.


##### `RequestPermissionProfile::from`  (lines 208–213)

```
fn from(value: CoreRequestPermissionProfile) -> Self
```

**Purpose**: Converts the core request-permission profile into the v2 wire struct used in permission approval prompts. It preserves optional network and filesystem sections.

**Data flow**: Consumes `CoreRequestPermissionProfile`, maps `network` with `AdditionalNetworkPermissions::from`, maps `file_system` with `AdditionalFileSystemPermissions::from`, and returns `RequestPermissionProfile`.

**Call relations**: This adapter is used when core asks the client to approve requested permissions.


##### `CoreRequestPermissionProfile::try_from`  (lines 219–227)

```
fn try_from(value: RequestPermissionProfile) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert a v2 request-permission profile back into the core type, validating nested filesystem permissions as needed. It propagates path-conversion failures.

**Data flow**: Consumes `RequestPermissionProfile`, maps `network` with `CoreNetworkPermissions::from`, converts optional `file_system` with `CoreFileSystemPermissions::<AbsolutePathBuf>::try_from` and `transpose()?`, and returns `Ok(CoreRequestPermissionProfile)` or an `io::Error`.

**Call relations**: This is the inverse of `RequestPermissionProfile::from`; it is used when client-provided permission requests or review actions are sent back to core.


##### `FileSystemSpecialPath::from`  (lines 258–267)

```
fn from(value: CoreFileSystemSpecialPath) -> Self
```

**Purpose**: Converts the core special filesystem path enum into the v2 tagged enum. It preserves both known symbolic paths and unknown custom symbolic paths with their optional subpaths.

**Data flow**: Consumes `CoreFileSystemSpecialPath`, matches each variant, moves any `subpath` or `path` payloads, and returns the corresponding `FileSystemSpecialPath`.

**Call relations**: This conversion is used by `FileSystemPath::from` when adapting special-path filesystem entries.


##### `CoreFileSystemSpecialPath::from`  (lines 271–280)

```
fn from(value: FileSystemSpecialPath) -> Self
```

**Purpose**: Converts the v2 special filesystem path enum back into the core enum. It is the inverse adapter for symbolic path references.

**Data flow**: Consumes `FileSystemSpecialPath`, matches each variant, moves any payload fields, and returns the corresponding `CoreFileSystemSpecialPath`.

**Call relations**: This conversion is used by `CoreFileSystemPath::try_from` when rebuilding core filesystem paths from v2 payloads.


##### `FileSystemPath::from`  (lines 296–306)

```
fn from(value: CoreFileSystemPath<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a core filesystem path into the v2 tagged path enum, translating absolute native paths into legacy app path strings for wire compatibility. It preserves glob patterns and special paths as structured variants.

**Data flow**: Consumes `CoreFileSystemPath<AbsolutePathBuf>`, matches `Path`, `GlobPattern`, or `Special`; for `Path`, converts the absolute path with `LegacyAppPathString::from_abs_path`, and for `Special`, converts the nested special path with `.into()`. Returns `FileSystemPath`.

**Call relations**: This adapter is used by `FileSystemSandboxEntry::from` and higher-level filesystem permission conversions.

*Call graph*: calls 1 internal fn (from_abs_path); 1 external calls (into).


##### `CoreFileSystemPath::try_from`  (lines 313–326)

```
fn try_from(value: FileSystemPath) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert the v2 filesystem path enum back into the core path type, validating path strings and preserving glob/special variants. Invalid path strings become `io::Error`s.

**Data flow**: Consumes `FileSystemPath`. For `Path`, converts `LegacyAppPathString` to a native `PathUri`, then to an absolute path; for `GlobPattern`, moves the pattern directly; for `Special`, converts the nested special path with `.into()`. Returns `Ok(CoreFileSystemPath<AbsolutePathBuf>)` or an error.

**Call relations**: This inverse conversion is used by `CoreFileSystemSandboxEntry::try_from` and ultimately by all inbound filesystem permission profile conversions.

*Call graph*: calls 1 internal fn (native); 1 external calls (into).


##### `FileSystemSandboxEntry::from`  (lines 339–344)

```
fn from(value: CoreFileSystemSandboxEntry<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a core filesystem sandbox entry into the v2 wire struct. It preserves both the path selector and the access mode.

**Data flow**: Consumes `CoreFileSystemSandboxEntry<AbsolutePathBuf>`, converts `path` with `.into()`, converts `access` with `.into()`, and returns `FileSystemSandboxEntry`.

**Call relations**: This adapter is used by `AdditionalFileSystemPermissions::from` when preserving canonical filesystem permission entries.


##### `CoreFileSystemSandboxEntry::try_from`  (lines 350–355)

```
fn try_from(value: FileSystemSandboxEntry) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert a v2 filesystem sandbox entry back into the core type, validating the nested path and translating the access mode. It propagates path-conversion failures.

**Data flow**: Consumes `FileSystemSandboxEntry`, converts `path` with `try_into()?`, converts `access` with `to_core()`, and returns `Ok(CoreFileSystemSandboxEntry<AbsolutePathBuf>)` or an `io::Error`.

**Call relations**: This inverse conversion is used by `CoreFileSystemPermissions::try_from` when rebuilding canonical filesystem permission entries.


##### `ActivePermissionProfile::new`  (lines 407–412)

```
fn new(id: impl Into<String>) -> Self
```

**Purpose**: Constructs an active permission profile selection from an identifier, leaving `extends` unset. It is a convenience constructor for code that only needs to select a profile by id.

**Data flow**: Accepts any `id` implementing `Into<String>`, converts it, sets `extends: None`, and returns a new `ActivePermissionProfile`.

**Call relations**: This helper is widely used by session/thread permission-selection code and tests that need to create a profile selection without manually filling the struct.

*Call graph*: called by 24 (permission_snapshot_setter_preserves_permission_constraints, session_configuration_apply_rebinds_symbolic_profile_to_updated_workspace_roots, active_profile_selection_uses_profile_id_only, auto_review_mode, override_turn_context_sends_thread_settings_update, permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread, embedded_turn_permissions_select_profile_id_only, embedded_turn_permissions_use_active_profile_selection, remote_turn_permissions_preserve_active_profile_selection, submission_includes_configured_active_permission_profile (+14 more)); 1 external calls (into).


##### `ActivePermissionProfile::read_only`  (lines 414–416)

```
fn read_only() -> Self
```

**Purpose**: Builds the built-in read-only active permission profile by delegating to the core helper and converting the result back into the v2 type. It ensures the v2 layer stays aligned with core’s canonical read-only profile definition.

**Data flow**: Calls `CoreActivePermissionProfile::read_only()`, converts the returned core profile with `.into()`, and returns `ActivePermissionProfile`.

**Call relations**: This convenience constructor is used by status and thread-settings code that needs the standard read-only profile without hardcoding its identifier.

*Call graph*: called by 4 (inactive_thread_settings_notification_updates_cached_collaboration_mode, thread_settings_for_test, status_permissions_named_read_only_profile_shows_builtin_label, status_permissions_read_only_profile_shows_additional_writable_roots); 1 external calls (read_only).


##### `ActivePermissionProfile::from`  (lines 420–425)

```
fn from(value: CoreActivePermissionProfile) -> Self
```

**Purpose**: Converts the core active permission profile into the v2 wire struct. It preserves the selected profile id and optional parent profile id.

**Data flow**: Consumes `CoreActivePermissionProfile`, moves `id` and `extends` into `ActivePermissionProfile`, and returns it.

**Call relations**: This adapter is used when active permission profile state is exposed to clients.


##### `CoreActivePermissionProfile::from`  (lines 429–434)

```
fn from(value: ActivePermissionProfile) -> Self
```

**Purpose**: Converts the v2 active permission profile back into the core type. It is a direct field-preserving adapter.

**Data flow**: Consumes `ActivePermissionProfile`, moves `id` and `extends` into `CoreActivePermissionProfile`, and returns it.

**Call relations**: This inverse conversion is used when client-selected active profiles are passed into core session or thread configuration.


##### `AdditionalPermissionProfile::from`  (lines 448–453)

```
fn from(value: CoreAdditionalPermissionProfile) -> Self
```

**Purpose**: Converts the core additional-permission overlay into the v2 wire struct used for per-command permission requests. It preserves optional network and filesystem overlays.

**Data flow**: Consumes `CoreAdditionalPermissionProfile`, maps `network` with `AdditionalNetworkPermissions::from`, maps `file_system` with `AdditionalFileSystemPermissions::from`, and returns `AdditionalPermissionProfile`.

**Call relations**: This adapter is used when core exposes extra per-command permissions to clients, such as in approval prompts.


##### `CoreAdditionalPermissionProfile::try_from`  (lines 485–493)

```
fn try_from(value: GrantedPermissionProfile) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert the v2 additional-permission overlay back into the core type, validating nested filesystem permissions. It propagates invalid path errors.

**Data flow**: Consumes `AdditionalPermissionProfile`, maps `network` with `CoreNetworkPermissions::from`, converts optional `file_system` with `CoreFileSystemPermissions::<AbsolutePathBuf>::try_from` and `transpose()?`, and returns `Ok(CoreAdditionalPermissionProfile)` or an `io::Error`.

**Call relations**: This inverse conversion is used when client-provided additional permission overlays must be applied in core.


##### `SandboxPolicy::deserialize`  (lines 576–616)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Implements custom deserialization for sandbox policies so the protocol can accept some legacy shapes while explicitly rejecting deprecated restricted-read settings. It normalizes accepted legacy payloads into the current `SandboxPolicy` enum.

**Data flow**: Deserializes into the private `SandboxPolicyDeserialize` helper enum, matches the result, and constructs the corresponding `SandboxPolicy`. For `ReadOnly` and `WorkspaceWrite`, it checks legacy access fields and returns a serde custom error if they are `Restricted`; otherwise it preserves network access, writable roots, and tmpdir exclusion flags. Returns `Result<SandboxPolicy, D::Error>`.

**Call relations**: This logic runs automatically during serde deserialization of sandbox policy payloads, acting as the compatibility and validation gate for inbound config or API data.

*Call graph*: 3 external calls (deserialize, custom, matches!).


##### `SandboxPolicy::to_core`  (lines 620–650)

```
fn to_core(&self) -> codex_protocol::protocol::SandboxPolicy
```

**Purpose**: Converts the v2 sandbox policy enum into the core runtime sandbox policy. It preserves variant-specific settings and translates external-sandbox network access into the core enum.

**Data flow**: Borrows `&self`, matches each variant, clones `writable_roots` when needed, copies booleans, maps `NetworkAccess::{Restricted,Enabled}` to `CoreNetworkAccess`, and returns `codex_protocol::protocol::SandboxPolicy`.

**Call relations**: This conversion is used when v2-layer sandbox policy data must be applied to core runtime/session configuration.

*Call graph*: called by 1 (display_permission_profile_from_thread_response).


##### `SandboxPolicy::from`  (lines 654–682)

```
fn from(value: codex_protocol::protocol::SandboxPolicy) -> Self
```

**Purpose**: Converts the core runtime sandbox policy into the v2 wire enum. It preserves all variant-specific fields and maps external-sandbox network access back into the v2 enum.

**Data flow**: Consumes `codex_protocol::protocol::SandboxPolicy`, matches each variant, moves or copies fields into the corresponding `SandboxPolicy`, and returns it.

**Call relations**: This adapter is used when runtime sandbox policy state is exposed back to clients and is covered by round-trip tests for multiple variants.

*Call graph*: called by 5 (sandbox_policy_round_trips_external_sandbox_network_access, sandbox_policy_round_trips_read_only_network_access, sandbox_policy_round_trips_workspace_write_access, session_configured_external_sandbox_keeps_external_runtime_policy, session_configured_syncs_widget_config_permissions_and_cwd).


##### `ExecPolicyAmendment::into_core`  (lines 693–695)

```
fn into_core(self) -> CoreExecPolicyAmendment
```

**Purpose**: Converts the v2 exec-policy amendment wrapper into the core amendment type. It forwards the command prefix vector into core’s constructor.

**Data flow**: Consumes `self`, passes `self.command` to `CoreExecPolicyAmendment::new`, and returns the resulting core amendment.

**Call relations**: This helper is used when a client accepts a command with an exec-policy amendment and the amendment must be applied in core.

*Call graph*: 1 external calls (new).


##### `ExecPolicyAmendment::from`  (lines 699–703)

```
fn from(value: CoreExecPolicyAmendment) -> Self
```

**Purpose**: Converts a core exec-policy amendment into the v2 transparent wrapper. It exposes the amendment as a plain command vector on the wire.

**Data flow**: Consumes `CoreExecPolicyAmendment`, calls `value.command()` to borrow the command slice, clones it with `to_vec()`, and returns `ExecPolicyAmendment`.

**Call relations**: This adapter is used when proposed or applied exec-policy amendments are surfaced to clients and is exercised by amendment-related tests.

*Call graph*: called by 2 (append_execpolicy_amendment_rejects_empty_prefix, append_execpolicy_amendment_updates_policy_and_file); 1 external calls (command).


##### `NetworkPolicyAmendment::into_core`  (lines 721–726)

```
fn into_core(self) -> CoreNetworkPolicyAmendment
```

**Purpose**: Converts the v2 network policy amendment into the core amendment type. It preserves the host and translates the rule action into the core enum.

**Data flow**: Consumes `self`, moves `host`, converts `action` with `to_core()`, constructs `CoreNetworkPolicyAmendment`, and returns it.

**Call relations**: This helper is used when a client chooses to apply a persistent network allow/deny rule and that amendment must be forwarded to core.

*Call graph*: 1 external calls (to_core).


##### `NetworkPolicyAmendment::from`  (lines 730–735)

```
fn from(value: CoreNetworkPolicyAmendment) -> Self
```

**Purpose**: Converts a core network policy amendment into the v2 wire struct. It preserves the host and maps the rule action into the exported enum.

**Data flow**: Consumes `CoreNetworkPolicyAmendment`, moves `host`, converts `action` with `NetworkPolicyRuleAction::from`, and returns `NetworkPolicyAmendment`.

**Call relations**: This adapter is used when proposed or existing network policy amendments are exposed to clients.

*Call graph*: 1 external calls (from).


### `app-server-protocol/src/protocol/v2/config.rs`

`data_model` · `config load, config inspection, config editing, and config-related notifications`

This is the central schema file for configuration-related API traffic. It models where config comes from (`ConfigLayerSource`), what the effective config contains (`Config` and many nested structs/enums), how layered config is reported (`ConfigLayerMetadata`, `ConfigLayer`, `ConfigReadResponse`), how requirements are surfaced (`ConfigRequirements` and related hook/network/residency structs), and how external-agent migration and config editing APIs exchange data. Nearly every type derives serde/schema/TS traits so the same definitions serve runtime transport and generated client types.

The main behavior is precedence handling for config layers. `ConfigLayerSource::precedence` assigns explicit numeric priorities to each source, including the distinction between base user config and profile-overlaid user config. `PartialOrd` is then implemented in terms of those numbers so sorting or comparisons reflect override order: lower precedence means “more easily overridden.” Another small compatibility helper is `ForcedChatgptWorkspaceIds::into_vec`, which collapses the backward-compatible untagged enum (`Single` or `Multiple`) into a uniform `Vec<String>` for internal consumers.

A notable design choice throughout the file is preserving backward compatibility and partial evolution: many fields are optional, some are flattened into `additional` maps for unknown keys, and several structs are marked `ExperimentalApi` or carry explicit experimental field annotations so the protocol can expose unstable capabilities without breaking older clients.

#### Function details

##### `ConfigLayerSource::precedence`  (lines 102–119)

```
fn precedence(&self) -> i16
```

**Purpose**: Assigns a fixed numeric precedence to each config layer source so override order is deterministic and comparable. It encodes the policy that later, more specific, or legacy-forced layers win over earlier ones.

**Data flow**: Reads the enum variant and, for `User`, also inspects whether `profile` is `Some`. Returns an `i16` precedence value: MDM lowest, then system, enterprise-managed, user/base, user/profile, project, session flags, and finally legacy managed config variants highest. It does not mutate state.

**Call relations**: This method is the basis for `PartialOrd`; comparisons between two layer sources delegate to these numeric values rather than duplicating the match logic.

*Call graph*: called by 1 (partial_cmp).


##### `ConfigLayerSource::partial_cmp`  (lines 125–127)

```
fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering>
```

**Purpose**: Implements ordering for config layer sources in terms of override precedence. It makes ordinary comparisons reflect the semantic rule that higher-precedence layers override lower-precedence ones.

**Data flow**: Accepts `&self` and `&other`, calls `precedence()` on both values, compares the resulting integers, and wraps the `Ordering` in `Some(...)`. Returns `Option<Ordering>` as required by `PartialOrd` and has no side effects.

**Call relations**: This trait method is invoked by generic ordering/sorting code whenever config layers are compared; internally it delegates entirely to `ConfigLayerSource::precedence` for both operands.

*Call graph*: calls 1 internal fn (precedence); 1 external calls (precedence).


##### `ForcedChatgptWorkspaceIds::into_vec`  (lines 232–237)

```
fn into_vec(self) -> Vec<String>
```

**Purpose**: Normalizes the backward-compatible workspace-id representation into a single vector form. It lets downstream code ignore whether the wire payload used a single string or an array.

**Data flow**: Consumes `self`; if it is `Single(value)`, allocates and returns a one-element `Vec<String>`, and if it is `Multiple(values)`, returns the existing vector unchanged. No external state is touched.

**Call relations**: This helper is used by internal consumers that want a uniform collection after deserialization, collapsing the compatibility enum into the shape most processing code expects.

*Call graph*: 1 external calls (vec!).


### `app-server-protocol/src/protocol/v2/experimental_feature.rs`

`data_model` · `request handling for feature flag UI, config inspection, and runtime toggle updates`

This file models the API surface around feature flags exposed to clients. `ExperimentalFeatureListParams` supports paginated listing with an opaque `cursor`, optional `limit`, and an optional `thread_id` used to compute enablement in the context of an existing thread’s refreshed configuration, including project-local config tied to that thread’s cwd. That thread-aware parameter is a notable design choice: feature visibility is not purely global, but can depend on per-thread configuration state.

Feature metadata itself is represented by `ExperimentalFeature`, which combines a stable config key (`name`), lifecycle stage (`ExperimentalFeatureStage`), optional user-facing beta-only copy (`display_name`, `description`, `announcement`), and two booleans distinguishing current effective enablement from default enablement. The stage enum captures the progression from `UnderDevelopment` through `Beta` and `Stable` to `Deprecated` and `Removed`, giving clients enough information to render warnings or hide obsolete toggles. `ExperimentalFeatureListResponse` returns a page of `data` plus an optional `next_cursor` for continuation.

The second half of the file defines mutation payloads for runtime toggles. `ExperimentalFeatureEnablementSetParams` carries a `BTreeMap<String, bool>` keyed by canonical feature name; omitted features are intentionally left unchanged, and an empty map is a no-op. The response echoes the entries actually updated in another ordered `BTreeMap`, which provides deterministic serialization order useful for tests and UI diffing. Overall, the file freezes the wire contract for feature discovery and selective enablement updates without embedding policy logic.


### `app-server-protocol/src/protocol/v2/plugin.rs`

`data_model` · `request/response schema definition and protocol serialization`

This file is a large protocol surface definition for plugin-related RPCs and notifications. Most of the file consists of serde/ts-rs/schemars-annotated structs and enums that precisely shape request and response payloads for listing skills and hooks, adding/removing/upgrading marketplaces, listing and reading plugins, installing/uninstalling plugins, reading remote skill contents, and managing plugin sharing. The schema distinguishes local filesystem-backed marketplaces from remote-only catalogs via `PluginMarketplaceEntry.path: Option<AbsolutePathBuf>` and `PluginSource` variants (`Local`, `Git`, `Remote`). Several fields intentionally preserve nullable-vs-omitted semantics, such as optional marketplace selectors and sharing metadata, while others default for backward compatibility, like `PluginSummary.availability` defaulting to `Available` and accepting the upstream alias `ENABLED`.

The behavioral code in the file is limited to five `From` conversions that adapt core skill types from `codex_protocol::protocol` into v2 API types. Those conversions are field-preserving and recursive: `SkillMetadata::from` maps nested `interface` and `dependencies`, converts `scope`, and explicitly forces `enabled: true` because the core metadata does not carry the app-server’s effective enablement state. `SkillDependencies::from` maps each tool dependency element-by-element, and `SkillScope::from` is a closed enum translation with no fallback branch. The file ends with `SkillsChangedNotification`, a pure invalidation signal telling clients to re-run `skills/list` rather than expecting embedded delta data.

#### Function details

##### `SkillMetadata::from`  (lines 800–811)

```
fn from(value: CoreSkillMetadata) -> Self
```

**Purpose**: Converts a core `CoreSkillMetadata` record into the v2 `SkillMetadata` payload exposed by app-server. It preserves descriptive fields and nested metadata while supplying the API-layer `enabled` flag as `true` by default.

**Data flow**: Consumes a `CoreSkillMetadata` value by value. It copies `name`, `description`, `short_description`, and `path`; maps `interface` through `SkillInterface::from` when present; maps `dependencies` through `SkillDependencies::from` when present; converts `scope` through `SkillScope::from`; and returns a new `SkillMetadata` with `enabled` hard-coded to `true`.

**Call relations**: Used wherever core skill discovery results need to be surfaced through the v2 protocol. In that flow it acts as the top-level adapter, delegating nested conversion to the interface, dependency, and scope converters so callers can transform an entire skill tree with a single `into()`.


##### `SkillInterface::from`  (lines 815–824)

```
fn from(value: CoreSkillInterface) -> Self
```

**Purpose**: Transforms a core skill interface description into the API-facing `SkillInterface`. It is a direct field mapping for presentation-oriented metadata such as names, prompts, colors, and icon paths.

**Data flow**: Takes `CoreSkillInterface`, reads its optional fields `display_name`, `short_description`, `brand_color`, `default_prompt`, `icon_small`, and `icon_large`, and returns a `SkillInterface` containing the same values without mutation.

**Call relations**: Invoked from `SkillMetadata::from` when a discovered skill includes interface metadata. It exists to isolate nested interface translation so the top-level metadata conversion stays shallow and compositional.


##### `SkillDependencies::from`  (lines 828–836)

```
fn from(value: CoreSkillDependencies) -> Self
```

**Purpose**: Converts a core dependency list into the v2 `SkillDependencies` structure. Its main job is to recursively translate each tool dependency entry.

**Data flow**: Consumes `CoreSkillDependencies`, takes ownership of its `tools` vector, iterates through it with `into_iter()`, maps each element via `SkillToolDependency::from`, collects the results into a new `Vec<SkillToolDependency>`, and returns `SkillDependencies { tools }`.

**Call relations**: Called from `SkillMetadata::from` when a skill declares dependencies. It delegates per-item conversion to `SkillToolDependency::from` so callers get a fully converted dependency graph rather than raw core entries.


##### `SkillToolDependency::from`  (lines 840–849)

```
fn from(value: CoreSkillToolDependency) -> Self
```

**Purpose**: Maps one core tool dependency record into the API schema used in skill metadata. It preserves both generic dependency identity fields and transport-specific optional fields.

**Data flow**: Accepts `CoreSkillToolDependency`, copies `type`, `value`, `description`, `transport`, `command`, and `url` into a new `SkillToolDependency`, and returns it unchanged apart from the type rename to `r#type` in Rust.

**Call relations**: Reached through `SkillDependencies::from` for each dependency entry in a skill. It is the leaf conversion in the skill dependency adaptation chain.


##### `SkillScope::from`  (lines 853–860)

```
fn from(value: CoreSkillScope) -> Self
```

**Purpose**: Translates the core skill scope enum into the v2 protocol enum. The mapping is exhaustive and preserves the semantic scope category exactly.

**Data flow**: Reads a `CoreSkillScope` variant and matches it to one of `SkillScope::User`, `Repo`, `System`, or `Admin`, returning the corresponding v2 enum value.

**Call relations**: Used by `SkillMetadata::from` when adapting top-level skill metadata. It provides the enum bridge needed so API payloads stay decoupled from core protocol type names and serde settings.


### `app-server-protocol/src/protocol/v2/hook.rs`

`data_model` · `hook lifecycle notifications and hook run serialization`

This module exposes hook execution state to clients. A series of `v2_enum_from_core!` macro invocations define protocol enums mirroring core hook concepts such as event names, handler types, execution mode, scope, source, trust status, run status, and output entry kind. On top of those enums, the file defines `HookOutputEntry`, `HookRunSummary`, and the `HookStartedNotification` / `HookCompletedNotification` payloads used to stream hook lifecycle events.

The behavioral code is straightforward conversion logic. `HookOutputEntry::from` maps a single core output entry into the v2 struct, converting the entry kind and preserving the text. `HookRunSummary::from` performs a full record conversion: it maps all enum fields through `Into`, copies timestamps and identifiers, preserves the source path, and converts each output entry in `entries` with an iterator pipeline. The `source` field on `HookRunSummary` has a serde default supplied by `default_hook_source`, which returns `HookSource::Unknown`; this ensures older payloads or omitted fields still deserialize into a valid enum value instead of failing. The file is intentionally transport-focused: it does not execute hooks, only describes and translates their observed results.

#### Function details

##### `default_hook_source`  (lines 64–66)

```
fn default_hook_source() -> HookSource
```

**Purpose**: Provides the fallback hook source used during deserialization when no explicit source is present. It keeps the wire format backward-compatible by defaulting missing values to `Unknown`.

**Data flow**: Takes no arguments and returns `HookSource::Unknown`. It reads and writes no state.

**Call relations**: This function is referenced by serde as the default provider for `HookRunSummary.source`, so it runs only during deserialization of payloads missing that field.


##### `HookOutputEntry::from`  (lines 89–94)

```
fn from(value: CoreHookOutputEntry) -> Self
```

**Purpose**: Converts one core hook output entry into the v2 wire representation. It preserves the textual payload and translates the entry kind into the exported enum.

**Data flow**: Consumes a `CoreHookOutputEntry`, converts `value.kind` with `.into()`, moves `value.text`, and returns a new `HookOutputEntry`. No side effects occur.

**Call relations**: This conversion is used while building a full `HookRunSummary`; each core entry in the summary's `entries` vector is mapped through this function.


##### `HookRunSummary::from`  (lines 119–136)

```
fn from(value: CoreHookRunSummary) -> Self
```

**Purpose**: Transforms a complete core hook run record into the client-facing summary payload used in notifications. It preserves execution identity, timing, ordering, status, and all emitted output entries.

**Data flow**: Consumes `CoreHookRunSummary`, converts enum-valued fields (`event_name`, `handler_type`, `execution_mode`, `scope`, `source`, `status`) via `.into()`, moves scalar and optional fields directly, and converts `entries` by iterating and mapping each element through `Into::into` before collecting into a `Vec<HookOutputEntry>`. Returns the assembled `HookRunSummary`.

**Call relations**: This is the main adapter used when hook lifecycle events are surfaced to v2 clients; it delegates per-entry conversion to `HookOutputEntry::from` and relies on the macro-generated enum conversions for the rest.


### `app-server-protocol/src/protocol/v2/feedback.rs`

`data_model` · `request handling for user feedback and diagnostics submission`

This file specifies the request and response schema for a feedback submission endpoint. `FeedbackUploadParams` requires a `classification` string and then layers on optional context: a free-form `reason`, an optional `thread_id` to associate the feedback with a conversation, a boolean `include_logs` flag, optional extra log file paths, and optional structured `tags` stored in a `BTreeMap<String, String>`. The use of `PathBuf` for `extra_log_files` indicates these are filesystem references supplied by the client rather than opaque attachment ids.

The request shape is designed to support both lightweight feedback and richer diagnostic submissions. `include_logs` defaults to false and is omitted when false, keeping the serialized payload compact; `extra_log_files` and `tags` are nullable/optional so clients can progressively add detail without constructing placeholder values. The ordered `BTreeMap` for tags gives deterministic key ordering across serialization and generated bindings.

`FeedbackUploadResponse` returns a single `thread_id: String`, which implies the server normalizes or creates a thread association for the uploaded feedback and reports that canonical identifier back to the caller. The file itself contains no upload mechanics, file reading, or validation rules; it only defines the exact wire-level contract for the feedback workflow.


### `app-server-protocol/src/protocol/v2/attestation.rs`

`data_model` · `request handling for optional attestation flows`

This file contains the minimal schema for the `attestation/generate` API in protocol v2. `AttestationGenerateParams` is an empty parameter object, intentionally represented as a struct rather than omitted entirely so the method has a stable, explicit request shape for serde, schema generation, and TypeScript bindings. It derives `Default`, which makes it easy for callers and tests to construct the request without fields.

`AttestationGenerateResponse` carries a single `token: String`, documented as an opaque client attestation token. The opacity is significant: the protocol contract promises transport of the token, not any client-visible structure or semantics. Both types use camelCase serde naming and export into the `v2/` TypeScript output tree, keeping them aligned with the rest of the versioned API surface.

There is no validation or generation logic here; this file’s responsibility is to freeze the wire format. In practice it is active only when a client has negotiated or opted into attestation-related behavior elsewhere in the protocol and needs a typed payload for the request/response exchange.


### `app-server-protocol/src/protocol/v2/environment.rs`

`data_model` · `request handling when environments are registered or updated`

This file contains the schema for a simple environment-registration API. `EnvironmentAddParams` carries two required strings: `environment_id`, which identifies the environment being added, and `exec_server_url`, which points at the execution server endpoint associated with that environment. The shape is intentionally small and direct, suggesting that environment creation or discovery happens elsewhere and this method only binds an identifier to a reachable execution backend.

`EnvironmentAddResponse` is an empty success object, which means the protocol treats successful registration as acknowledgment-only and does not return derived metadata, canonicalized values, or server-generated ids. As with the rest of the v2 protocol, both types derive serde serialization/deserialization, JSON Schema, and TypeScript export metadata, and use camelCase field naming on the wire.

There is no embedded validation logic here, so constraints such as uniqueness of `environment_id`, URL correctness, or replacement semantics must be enforced by the server implementation that consumes these types. This file’s role is to define the exact request and response envelope for that interaction.


### `app-server-protocol/src/protocol/v2/remote_control.rs`

`data_model` · `remote-control request handling and status notification serialization`

This file is the protocol model for remote-control features. It declares request and response structs for enabling and disabling remote control, reading current status, starting and polling pairing, listing paired clients with pagination and sort order, and revoking a client. The central shared state shape is `RemoteControlStatusChangedNotification`, which carries `status: RemoteControlConnectionStatus`, `server_name`, `installation_id`, and optional `environment_id`. Both `RemoteControlEnableResponse` and `RemoteControlDisableResponse` intentionally mirror that exact payload, allowing the implementation to derive synchronous RPC responses from the same state snapshot used for notifications.

Serde annotations preserve the wire contract: booleans like `ephemeral` and `manual_code` default to `false` and are omitted when false, while list parameters keep nullable optional fields such as `cursor`, `limit`, and `order`. `RemoteControlConnectionStatus` is a compact enum with `Disabled`, `Connecting`, `Connected`, and `Errored`, representing the externally visible lifecycle rather than transport internals. The only behavior in the file is two `From` impls that destructure a status notification and rebuild the corresponding response type. That design avoids duplicate field-copying logic in handlers and guarantees response payloads stay structurally aligned with the notification schema.

#### Function details

##### `RemoteControlEnableResponse::from`  (lines 169–182)

```
fn from(notification: RemoteControlStatusChangedNotification) -> Self
```

**Purpose**: Builds an enable-response payload from a `RemoteControlStatusChangedNotification`. It reuses the notification’s connection snapshot as the RPC result after enabling remote control.

**Data flow**: Consumes a `RemoteControlStatusChangedNotification`, destructures `status`, `server_name`, `installation_id`, and `environment_id`, and returns a `RemoteControlEnableResponse` containing the same values.

**Call relations**: Called by the remote-control enable flow and its scenario test path after the system obtains or emits a status notification. It serves as the final adapter from shared status state into the specific response type returned by `enable`.

*Call graph*: called by 2 (serve_enable_remote_control_scenario, enable).


##### `RemoteControlDisableResponse::from`  (lines 186–199)

```
fn from(notification: RemoteControlStatusChangedNotification) -> Self
```

**Purpose**: Builds a disable-response payload from a `RemoteControlStatusChangedNotification`. It lets disable handlers return the same connection snapshot shape used by status-change notifications.

**Data flow**: Takes a `RemoteControlStatusChangedNotification`, reads `status`, `server_name`, `installation_id`, and `environment_id`, and returns `RemoteControlDisableResponse` with those fields copied directly.

**Call relations**: Used by the disable flow, including the compatibility path that retries without params for older servers. In that call chain it converts the shared status notification/state object into the concrete RPC response expected by callers.

*Call graph*: called by 2 (disable_remote_control_retries_without_params_for_older_servers, disable).


### V2 execution and host integration
This set defines the operational RPCs for command execution, processes, filesystem access, MCP integration, and sandbox-specific host interactions.

### `app-server-protocol/src/protocol/v2/command_exec.rs`

`data_model` · `request handling for standalone process execution and streaming session control`

This file models the full wire contract for `command/exec` and its follow-up methods. The central request type, `CommandExecParams`, describes how a client asks the server to run an argv vector outside the thread/turn system. It includes execution mode flags (`tty`, `stream_stdin`, `stream_stdout_stderr`), resource controls (`output_bytes_cap`, `disable_output_cap`, `timeout_ms`, `disable_timeout`), process identity (`process_id`), environment and cwd overrides, optional PTY size, and sandbox selection via either `sandbox_policy` or the experimental `permission_profile`. The comments encode important invariants that the server is expected to enforce: empty commands are invalid; PTY implies stdin/stdout streaming; several features require a client-supplied `processId`; and timeout/output-cap options are mutually exclusive with their corresponding disable flags.

The rest of the file defines the lifecycle around that execution. `CommandExecResponse` returns the final exit code and any buffered stdout/stderr, with the explicit rule that streamed output is not duplicated into the final response. `CommandExecWriteParams`, `CommandExecTerminateParams`, and `CommandExecResizeParams` target an existing connection-scoped process id and each have empty success response structs, making the protocol acknowledge control actions without extra payload. `CommandExecTerminalSize` standardizes PTY dimensions as rows and columns. For streaming, `CommandExecOutputStream` distinguishes stdout from stderr, and `CommandExecOutputDeltaNotification` carries base64-encoded chunks plus a `cap_reached` marker indicating truncation at the configured capture limit.

The file is purely declarative, but it captures subtle transport semantics: process ids are scoped to a connection, output chunks are base64 rather than raw bytes, and if the originating connection disappears the associated process is expected to be terminated by the server. The `ExperimentalApi` derive on `CommandExecParams` also marks this surface as gated or opt-in relative to the stable protocol.


### `app-server-protocol/src/protocol/v2/process.rs`

`data_model` · `request handling`

This module is the schema for the `process/*` API family. It models both control requests and asynchronous output/exit notifications for connection-scoped subprocesses started by the app server. `ProcessTerminalSize` captures PTY dimensions in character cells and is reused by spawn and resize operations. `ProcessSpawnParams` is the central request payload: it includes the argv vector, a client-chosen `process_handle`, absolute `cwd`, PTY enablement, stdin/stdout streaming flags, optional output and timeout limits, environment overrides, and optional initial PTY size. Two fields—`output_bytes_cap` and `timeout_ms`—use a double-`Option` serde helper to distinguish omitted (use server default) from explicit `null` (disable limit), which is a subtle but important wire-level contract. Empty marker structs represent successful responses for spawn, stdin writes, kills, and PTY resize. `ProcessWriteStdinParams` supports writing base64-encoded bytes, closing stdin, or both in one request. `ProcessOutputStream` labels streamed chunks as stdout or stderr. `ProcessOutputDeltaNotification` carries base64 output chunks and indicates truncation on the final chunk when a cap is reached. `ProcessExitedNotification` reports the final exit code plus buffered stdout/stderr when not streamed, along with per-stream cap flags. The comments encode key invariants: duplicate active handles are rejected per connection, PTY mode implies streaming behavior, and streamed output is not duplicated into the final exit notification.


### `app-server-protocol/src/protocol/v2/fs.rs`

`data_model` · `request handling and notification delivery for filesystem access`

This file is the typed contract for a broad filesystem API exposed over protocol v2. Every operation uses explicit request and response structs with `AbsolutePathBuf` for paths that must be absolute on the host, making path expectations part of the type system rather than an informal convention. The API covers reading and writing files (`FsReadFileParams`/`FsReadFileResponse`, `FsWriteFileParams`/`FsWriteFileResponse`), creating directories, querying metadata, listing directory contents, removing paths, copying files or directory trees, and subscribing to change notifications.

Several payloads encode important semantics directly in their fields and comments. File contents are transported as base64 strings (`data_base64`) rather than raw bytes. Directory creation and removal expose optional booleans (`recursive`, `force`) whose absence means server defaults apply; comments document those defaults as `true`. Metadata responses flatten common stat information into booleans for directory/file/symlink plus millisecond timestamps, using `0` when creation or modification time is unavailable. Directory listings return only direct child names in `FsReadDirectoryEntry.file_name`, not full paths, along with file-vs-directory classification.

The watch API introduces connection-scoped identifiers: `FsWatchParams` binds a client-provided `watch_id` to an absolute path, `FsWatchResponse` returns the canonicalized watched path, `FsUnwatchParams` tears down that subscription, and `FsChangedNotification` reports changed absolute paths associated with the watch. Empty response structs are used consistently for acknowledgment-only operations. The file contains no I/O implementation, but it precisely defines the transport shapes and invariants that filesystem-capable server code must honor.


### `app-server-protocol/src/protocol/v2/mcp.rs`

`io_transport` · `MCP server discovery, MCP tool/resource requests, and MCP elicitation round-tripping`

This module is the MCP-facing transport schema for app-server. It declares request/response payloads for listing MCP server status, reading resources, invoking tools, refreshing server inventory, and handling OAuth login completion. It also defines the wire representations of MCP tool-call results and errors, plus a substantial typed schema model for MCP elicitation forms (`McpElicitationSchema` and its nested enum/string/number/boolean variants).

The conversion logic falls into two groups. First, simple adapters map core MCP tool-call results and errors into v2 structs: `McpServerToolCallResponse::from` preserves content, structured content, error flag, and metadata; `McpToolCallResult::from` preserves the same payload minus `is_error`; and `McpToolCallError::from` exposes only the message. Second, elicitation bridging converts between app-server’s v2 types, core approval types, and RMCP model types. `McpServerElicitationAction` can be converted to the core approval action or to/from `rmcp::model::ElicitationAction`. `McpServerElicitationRequest::try_from` parses a core form request’s `requested_schema` JSON into the strongly typed v2 schema, failing with `serde_json::Error` if the schema is invalid or null; URL-mode requests pass through directly. Response conversions intentionally drop client `_meta` when converting to or from RMCP `CreateElicitationResult`, leaving `meta: None` in both directions.

#### Function details

##### `McpServerToolCallResponse::from`  (lines 146–153)

```
fn from(result: CoreMcpCallToolResult) -> Self
```

**Purpose**: Converts a core MCP call-tool result into the direct response payload returned by the v2 MCP tool-call API. It preserves both unstructured and structured content plus error signaling metadata.

**Data flow**: Consumes `CoreMcpCallToolResult`, moves `content`, `structured_content`, `is_error`, and `meta` into a new `McpServerToolCallResponse`, and returns it.

**Call relations**: This adapter is used on the synchronous MCP tool-call response path where the server returns the tool result directly to the client.


##### `McpToolCallResult::from`  (lines 157–163)

```
fn from(result: CoreMcpCallToolResult) -> Self
```

**Purpose**: Converts a core MCP call-tool result into the item/notification-oriented result struct embedded in thread items. It intentionally omits the separate `is_error` flag because error cases are represented elsewhere.

**Data flow**: Consumes `CoreMcpCallToolResult`, moves `content`, `structured_content`, and `meta` into `McpToolCallResult`, and returns it.

**Call relations**: This conversion is used when MCP tool-call outcomes are attached to `ThreadItem::McpToolCall` rather than returned as a direct RPC response.


##### `McpToolCallError::from`  (lines 167–171)

```
fn from(error: CoreMcpToolCallError) -> Self
```

**Purpose**: Converts a core MCP tool-call error into the simplified v2 error payload. It exposes only the human-readable message.

**Data flow**: Consumes `CoreMcpToolCallError`, moves `error.message` into a new `McpToolCallError`, and returns it.

**Call relations**: This adapter is used when failed MCP tool calls are represented in item payloads or notifications.


##### `McpServerElicitationAction::to_core`  (lines 255–261)

```
fn to_core(self) -> codex_protocol::approvals::ElicitationAction
```

**Purpose**: Maps the v2 elicitation action enum into the core approvals-layer elicitation action. It preserves the user's accept/decline/cancel choice.

**Data flow**: Consumes `self`, matches `Accept`, `Decline`, or `Cancel`, and returns the corresponding `codex_protocol::approvals::ElicitationAction`.

**Call relations**: This conversion is used when a client’s elicitation response must be forwarded into core approval handling.


##### `ElicitationAction::from`  (lines 265–271)

```
fn from(value: McpServerElicitationAction) -> Self
```

**Purpose**: Converts the v2 elicitation action into the RMCP model action enum. It is the bridge from app-server’s wire type to the RMCP library type.

**Data flow**: Consumes `McpServerElicitationAction`, matches each variant, and returns the corresponding `rmcp::model::ElicitationAction`.

**Call relations**: This conversion is used by `CreateElicitationResult::from` when building an RMCP result from a v2 elicitation response.


##### `McpServerElicitationAction::from`  (lines 275–281)

```
fn from(value: rmcp::model::ElicitationAction) -> Self
```

**Purpose**: Converts an RMCP elicitation action back into the v2 action enum. It preserves the same three-way decision space.

**Data flow**: Consumes `rmcp::model::ElicitationAction`, matches `Accept`, `Decline`, or `Cancel`, and returns the corresponding `McpServerElicitationAction`.

**Call relations**: This adapter is used when RMCP results are translated back into app-server’s v2 response type.


##### `McpServerElicitationRequest::try_from`  (lines 650–673)

```
fn try_from(value: CoreElicitationRequest) -> Result<Self, Self::Error>
```

**Purpose**: Attempts to convert a core elicitation request into the typed v2 elicitation request enum, validating form schemas by deserializing them from raw JSON. Invalid form schemas cause conversion failure instead of producing a malformed wire payload.

**Data flow**: Consumes `CoreElicitationRequest`. For `Form`, it moves `meta` and `message`, deserializes `requested_schema` with `serde_json::from_value`, and returns `Ok(McpServerElicitationRequest::Form { ... })` or a `serde_json::Error`. For `Url`, it moves fields directly into `McpServerElicitationRequest::Url` and returns `Ok(...)`.

**Call relations**: This conversion is exercised by tests covering valid form/url requests and invalid/null form schemas. It is the key validation boundary between loosely typed core JSON schema payloads and the strongly typed v2 elicitation schema model.

*Call graph*: called by 4 (mcp_server_elicitation_request_from_core_form_request, mcp_server_elicitation_request_from_core_url_request, mcp_server_elicitation_request_rejects_invalid_core_form_schema, mcp_server_elicitation_request_rejects_null_core_form_schema); 1 external calls (from_value).


##### `CreateElicitationResult::from`  (lines 692–698)

```
fn from(value: McpServerElicitationRequestResponse) -> Self
```

**Purpose**: Converts a v2 elicitation response into the RMCP `CreateElicitationResult` used by the MCP library. It forwards the action and content but intentionally drops client metadata.

**Data flow**: Consumes `McpServerElicitationRequestResponse`, converts `action` with `.into()`, moves `content`, sets `meta: None`, and returns `rmcp::model::CreateElicitationResult`.

**Call relations**: This is the outbound bridge from app-server’s v2 response payload to RMCP. It relies on the `From<McpServerElicitationAction> for rmcp::model::ElicitationAction` conversion.


##### `McpServerElicitationRequestResponse::from`  (lines 702–708)

```
fn from(value: rmcp::model::CreateElicitationResult) -> Self
```

**Purpose**: Converts an RMCP elicitation result back into the v2 response struct. It preserves the action and structured content while normalizing metadata to `None`.

**Data flow**: Consumes `rmcp::model::CreateElicitationResult`, converts `action` with `.into()`, moves `content`, sets `meta: None`, and returns `McpServerElicitationRequestResponse`.

**Call relations**: This conversion is used in round-trip scenarios and tests that verify app-server’s v2 elicitation response shape can be reconstructed from RMCP results.

*Call graph*: called by 1 (mcp_server_elicitation_response_round_trips_rmcp_result).


### `app-server-protocol/src/protocol/v2/windows_sandbox.rs`

`data_model` · `request handling`

This module contains the Windows-specific protocol schema for sandbox configuration and diagnostics. `WindowsWorldWritableWarningNotification` reports potentially unsafe filesystem findings using a bounded list of `sample_paths`, an `extra_count` for omitted additional matches, and a `failed_scan` flag to indicate incomplete inspection. Two enums capture setup and status state: `WindowsSandboxSetupMode` distinguishes elevated from unelevated setup flows, and `WindowsSandboxReadiness` reports whether the sandbox is ready, not configured, or requires an update. `WindowsSandboxSetupStartParams` starts a setup attempt with a chosen mode and an optional absolute working directory, represented by `AbsolutePathBuf`. The corresponding `WindowsSandboxSetupStartResponse` only indicates whether setup was actually started, which implies the operation may be rejected or skipped without immediate completion. `WindowsSandboxReadinessResponse` wraps the readiness enum for query-style responses. Finally, `WindowsSandboxSetupCompletedNotification` is the asynchronous completion event, echoing the mode used, a success boolean, and an optional error string when setup fails. As with the other protocol files, all types derive serde, schema, and TypeScript traits, making this file the authoritative wire contract for Windows sandbox lifecycle messaging.


### Schema export and experimental filtering
These files describe how the protocol surface is analyzed for experimental fields and transformed into generated schema and TypeScript artifacts with fixture support.

### `app-server-protocol/src/experimental_api.rs`

`domain_logic` · `cross-cutting`

This module establishes the contract for experimental API gating. The `ExperimentalApi` trait exposes a single method, `experimental_reason`, which returns an optional stable reason string identifying the experimental method or field in use. That reason is later turned into user-facing capability errors and used by export code to strip unstable surface area from generated artifacts.

For field-level metadata, the file defines `ExperimentalField { type_name, field_name, reason }` and registers instances through `inventory::collect!`. `experimental_fields()` materializes the inventory into a `Vec<&'static ExperimentalField>`, giving the export pipeline a runtime list of all experimental fields declared across protocol types. `experimental_required_message()` standardizes the capability error text as `"<reason> requires experimentalApi capability"`.

A key design choice is the set of blanket `ExperimentalApi` impls for `Option<T>`, `Vec<T>`, `HashMap<K, V, S>`, and `BTreeMap<K, V>`. These implementations recursively inspect contained values and return the first nested experimental reason they find, allowing derive-generated implementations on structs and enums to mark fields as `#[experimental(nested)]` without hand-writing traversal logic.

The tests validate the derive macro integration across enum variant shapes, nested optional fields, nested collections, nested maps, and optional experimental fields that only count as experimental when present.

#### Function details

##### `experimental_fields`  (lines 25–27)

```
fn experimental_fields() -> Vec<&'static ExperimentalField>
```

**Purpose**: Returns the runtime registry of all experimental fields declared across protocol types. Export code uses this list to remove unstable properties from generated TypeScript and JSON Schema output.

**Data flow**: Reads the global `inventory` of `ExperimentalField` registrations, iterates over it, and collects the entries into a `Vec<&'static ExperimentalField>`. It returns that vector without mutating state.

**Call relations**: This function is called by `filter_experimental_schema`, `filter_experimental_ts`, and `filter_experimental_ts_tree` to drive field-level filtering. It is the bridge between compile-time field registration and runtime export pruning.

*Call graph*: called by 3 (filter_experimental_schema, filter_experimental_ts, filter_experimental_ts_tree).


##### `experimental_required_message`  (lines 30–32)

```
fn experimental_required_message(reason: &str) -> String
```

**Purpose**: Builds the canonical capability error message for an experimental reason identifier. It keeps user-visible gating text consistent across the protocol.

**Data flow**: Takes `reason: &str` and formats it into a new `String` of the form `"{reason} requires experimentalApi capability"`. It has no side effects.

**Call relations**: This helper is used wherever the protocol needs to report that a request or field requires the experimental API capability. It does not participate in traversal or filtering itself.

*Call graph*: 1 external calls (format!).


##### `Option::experimental_reason`  (lines 35–37)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Propagates experimental detection through optional values by inspecting the contained value only when present. `None` is always treated as stable.

**Data flow**: Reads `self: &Option<T>` where `T: ExperimentalApi` → if `Some`, calls the inner value’s `experimental_reason`; if `None`, returns `None`. It is pure and allocates nothing.

**Call relations**: This blanket impl is used implicitly by derive-generated `ExperimentalApi` implementations for optional fields and nested optional structures. It enables `#[experimental(nested)]` fields to work without custom code.


##### `Vec::experimental_reason`  (lines 41–43)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Propagates experimental detection through vectors by returning the first nested experimental reason found among elements. Empty vectors are stable.

**Data flow**: Reads `self: &Vec<T>` where `T: ExperimentalApi` → iterates elements and applies `ExperimentalApi::experimental_reason` until one returns `Some`, otherwise returns `None`. It does not mutate the collection.

**Call relations**: This impl is used transitively by nested collection fields in protocol types and is validated by the nested-collections test. It supports export/runtime gating for list-valued experimental content.


##### `HashMap::experimental_reason`  (lines 47–49)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Propagates experimental detection through hash maps by scanning values for the first experimental entry. Keys are ignored because only values implement the trait.

**Data flow**: Reads `self: &HashMap<K, V, S>` where `V: ExperimentalApi` → iterates `self.values()` and returns the first nested `Some(reason)`, else `None`. It is pure.

**Call relations**: This blanket impl supports nested map fields in protocol types and is exercised by the nested-maps test. It lets derive-generated code treat map-valued fields the same way as other nested containers.


##### `BTreeMap::experimental_reason`  (lines 53–55)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Propagates experimental detection through ordered maps by scanning values for nested experimental usage. Like the hash-map impl, only values matter.

**Data flow**: Reads `self: &BTreeMap<K, V>` where `V: ExperimentalApi` → iterates ordered values and returns the first nested experimental reason found, or `None` if all values are stable. No state is changed.

**Call relations**: This impl is available for protocol types that use ordered maps and participates implicitly in derive-generated traversal. It mirrors the `HashMap` behavior for deterministic map types.


##### `tests::derive_supports_all_enum_variant_shapes`  (lines 109–126)

```
fn derive_supports_all_enum_variant_shapes()
```

**Purpose**: Verifies that the `ExperimentalApi` derive macro correctly marks unit, tuple, and named enum variants while leaving stable variants unmarked. It protects the enum-side code generation contract.

**Data flow**: Constructs several `EnumVariantShapes` values, calls `ExperimentalApiTrait::experimental_reason` on each, and asserts the returned `Option<&'static str>` matches the expected reason or `None`. It has no side effects.

**Call relations**: This test validates the derive macro behavior that production protocol enums rely on. It specifically covers variant-shape handling rather than container traversal.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_supports_nested_experimental_fields`  (lines 129–140)

```
fn derive_supports_nested_experimental_fields()
```

**Purpose**: Checks that a field marked `#[experimental(nested)]` forwards the inner experimental reason when populated and stays stable when absent. It confirms optional nested traversal works.

**Data flow**: Builds `NestedFieldShape` values with `inner: Some(...)` and `inner: None`, evaluates `experimental_reason`, and compares the results to the expected nested reason or `None`. No external state is touched.

**Call relations**: This test exercises the interaction between derive-generated field logic and the blanket `Option<T>` implementation. It covers the nested optional-field path used by real protocol structs.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_supports_nested_collections`  (lines 143–159)

```
fn derive_supports_nested_collections()
```

**Purpose**: Checks that nested vectors surface the first experimental element and that empty vectors remain stable. It validates collection traversal in derive-generated implementations.

**Data flow**: Constructs `NestedCollectionShape` values containing either a mix of stable and experimental enum variants or an empty vector, then asserts the returned experimental reason matches expectations. It is side-effect free.

**Call relations**: This test depends on the blanket `Vec<T>` implementation and confirms that derive-generated nested-field handling composes correctly with it.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_supports_nested_maps`  (lines 162–178)

```
fn derive_supports_nested_maps()
```

**Purpose**: Checks that nested maps surface experimental reasons from their values and that empty maps remain stable. It validates map traversal support in the derive system.

**Data flow**: Constructs `NestedMapShape` values with either a populated `HashMap<String, EnumVariantShapes>` or an empty map, calls `experimental_reason`, and asserts the expected result. It mutates no shared state.

**Call relations**: This test covers the blanket `HashMap` implementation as used through a derive-generated nested field. It ensures map-valued protocol fields participate in experimental gating.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_marks_optional_experimental_fields_when_some`  (lines 181–194)

```
fn derive_marks_optional_experimental_fields_when_some()
```

**Purpose**: Verifies that an explicitly experimental optional field is considered experimental only when present, even if the contained collection is empty. This distinguishes field-level gating from nested-content gating.

**Data flow**: Builds `ExperimentalFieldShape` with `optional_collection: Some(Vec::new())` and `None`, evaluates `experimental_reason`, and asserts `Some("field/optionalCollection")` versus `None`. It has no side effects.

**Call relations**: This test documents the semantics of field-level `#[experimental("...")]` on optional fields, complementing the nested traversal tests. It protects export/runtime gating behavior for optional experimental fields.

*Call graph*: 1 external calls (assert_eq!).


### `app-server-protocol/src/export.rs`

`orchestration` · `build/export tooling`

This module is the protocol crate’s largest orchestration layer for schema export. It emits per-type TypeScript files and JSON Schemas, then post-processes them into stable consumable outputs. The top-level entrypoints are `generate_types`, `generate_ts[_with_options]`, `generate_json[_with_experimental]`, and `generate_internal_json_schema`. TypeScript generation writes root and `v2/` files via `ts-rs` exporters on request/notification/response types, optionally strips experimental methods and fields, generates `index.ts` files, prepends a generated-code header in parallel, optionally runs Prettier, and finally trims trailing whitespace.

JSON generation emits individual schemas for JSON-RPC envelopes and protocol payload types, then builds a bundled schema document with `build_schema_bundle`. That bundler rewrites `$ref` targets into namespaces, preserves selected shared root definitions, annotates schemas and variants with stable titles, detects naming collisions, and writes both a mixed bundle and a flattened v2-only bundle for downstream code generators. The flattening path preserves shared root unions like `ClientRequest` and `ServerNotification` while recursively pulling in non-v2 dependencies and validating that no `#/definitions/v2/` refs remain dangling.

A substantial portion of the file is dedicated to stable-vs-experimental filtering. It uses `experimental_fields()` plus hard-coded experimental method/type lists to remove unstable union arms, object properties, generated files, and schema definitions from both TS and JSON outputs. Because generated TS is manipulated as source text, the module includes a small parser-like toolkit (`ScanState`, `Depth`, top-level splitting, property parsing, string literal parsing) that understands braces, comments, strings, and generic angle brackets well enough to safely edit unions and object/interface bodies without a full TypeScript parser. The extensive tests lock down edge cases such as import pruning, namespaced ref rewriting, flat-v2 dependency retention, and the absence of `?: T | null` outside approved parameter types.

#### Function details

##### `GeneratedSchema::namespace`  (lines 67–69)

```
fn namespace(&self) -> Option<&str>
```

**Purpose**: Returns the optional namespace assigned to a generated schema, such as `v2`. It exposes the internal `Option<String>` as `Option<&str>` for read-only consumers.

**Data flow**: Reads `self.namespace` and converts it with `as_deref()` into `Option<&str>`. It returns borrowed data and does not mutate state.

**Call relations**: Used by bundling helpers like `collect_namespaced_types` and `build_schema_bundle` when deciding where definitions belong and how `$ref` values should be rewritten.


##### `GeneratedSchema::logical_name`  (lines 71–73)

```
fn logical_name(&self) -> &str
```

**Purpose**: Returns the schema’s logical type name without namespace decoration. This is the key used for output filenames and bundle definition names.

**Data flow**: Borrows and returns `&self.logical_name`. No transformation beyond borrowing occurs.

**Call relations**: Consumed by bundling and filtering code to compare against allowlists, ignored definitions, and namespace ownership maps.


##### `GeneratedSchema::value`  (lines 75–77)

```
fn value(&self) -> &Value
```

**Purpose**: Returns the underlying JSON schema value for a generated schema record. It provides read-only access to the schema payload collected during export.

**Data flow**: Borrows and returns `&self.value` as a `&serde_json::Value`. It does not clone or mutate.

**Call relations**: Used by namespace collection and bundle assembly code that needs to inspect nested `definitions` or `$defs` inside each generated schema.


##### `generate_types`  (lines 81–85)

```
fn generate_types(out_dir: &Path, prettier: Option<&Path>) -> Result<()>
```

**Purpose**: Runs both TypeScript and JSON schema generation into a single output directory. It is the convenience entrypoint for callers that want the full export set.

**Data flow**: Takes `out_dir` and optional `prettier` path → calls `generate_ts(out_dir, prettier)` and then `generate_json(out_dir)` → returns `Ok(())` only if both succeed. It writes generated files under `out_dir`.

**Call relations**: This function is a thin orchestrator above the two specialized generation paths. It delegates all substantive work to `generate_ts` and `generate_json`.

*Call graph*: calls 2 internal fn (generate_json, generate_ts).


##### `GenerateTsOptions::default`  (lines 96–103)

```
fn default() -> Self
```

**Purpose**: Defines the standard TypeScript export behavior: generate indices, ensure generated headers, run Prettier, and exclude experimental API by default. It centralizes the baseline policy used by binaries and fixture generation.

**Data flow**: Constructs and returns a `GenerateTsOptions` value with `generate_indices: true`, `ensure_headers: true`, `run_prettier: true`, and `experimental_api: false`. It has no side effects.

**Call relations**: Called by the export CLI `main`, by `generate_ts`, and by fixture-writing code to seed option structs before selective overrides.

*Call graph*: called by 3 (main, generate_ts, write_schema_fixtures_with_options).


##### `generate_ts`  (lines 106–108)

```
fn generate_ts(out_dir: &Path, prettier: Option<&Path>) -> Result<()>
```

**Purpose**: Generates TypeScript output using the default option set. It is the simple wrapper for callers that do not need fine-grained control.

**Data flow**: Takes `out_dir` and optional `prettier` path, creates a default `GenerateTsOptions`, and forwards all arguments to `generate_ts_with_options`. Returns that function’s `Result<()>`.

**Call relations**: Called by `generate_types`; internally it exists only to pair `GenerateTsOptions::default` with `generate_ts_with_options`.

*Call graph*: calls 2 internal fn (default, generate_ts_with_options); called by 1 (generate_types).


##### `generate_ts_with_options`  (lines 110–185)

```
fn generate_ts_with_options(
    out_dir: &Path,
    prettier: Option<&Path>,
    options: GenerateTsOptions,
) -> Result<()>
```

**Purpose**: Executes the full TypeScript export pipeline: emit files, optionally strip experimental API, generate indexes, ensure headers, optionally format with Prettier, and normalize trailing whitespace. It is the main TS generation driver.

**Data flow**: Takes `out_dir`, optional `prettier`, and `GenerateTsOptions` → ensures `out_dir` and `out_dir/v2` exist, invokes `export_all_to`/response exporters for client and server request/notification families, optionally filters experimental TS, optionally writes root and `v2/index.ts`, recursively collects `.ts` files, optionally prepends `GENERATED_TS_HEADER` in parallel worker threads, optionally runs Prettier over all TS files, then trims trailing spaces/tabs line-by-line. It returns `Result<()>` and writes/rewrites many files under the output tree.

**Call relations**: This is called by `generate_ts` and indirectly by the export CLI. It delegates emission to protocol type exporters, filtering to `filter_experimental_ts`, index creation to `generate_index_ts`, file discovery to `ts_files_in_recursive`, header insertion to `prepend_header_if_missing`, and final cleanup to `trim_trailing_whitespace_in_ts_files`.

*Call graph*: calls 5 internal fn (ensure_dir, filter_experimental_ts, generate_index_ts, trim_trailing_whitespace_in_ts_files, ts_files_in_recursive); called by 1 (generate_ts); 11 external calls (export_all_to, export_all_to, join, export_all_to, export_all_to, anyhow!, new, export_client_responses, export_server_responses, available_parallelism (+1 more)).


##### `generate_json`  (lines 187–189)

```
fn generate_json(out_dir: &Path) -> Result<()>
```

**Purpose**: Generates stable JSON schema output with experimental API excluded. It is the default JSON export wrapper.

**Data flow**: Takes `out_dir` and forwards to `generate_json_with_experimental(out_dir, false)`. Returns the delegated `Result<()>` and writes JSON files under `out_dir`.

**Call relations**: Called by `generate_types`; it exists to expose the common stable-export case without requiring callers to pass the experimental flag explicitly.

*Call graph*: calls 1 internal fn (generate_json_with_experimental); called by 1 (generate_types).


##### `generate_internal_json_schema`  (lines 191–195)

```
fn generate_internal_json_schema(out_dir: &Path) -> Result<()>
```

**Purpose**: Writes internal-only JSON schema artifacts that are not part of the public app-server protocol bundle. Currently it emits the schema for `RolloutLine`.

**Data flow**: Ensures `out_dir` exists, then writes the schema for `RolloutLine` via `write_json_schema::<RolloutLine>(out_dir, "RolloutLine")`. Returns `Result<()>` and writes one schema file.

**Call relations**: This helper is separate from the public protocol export path and delegates directory creation to `ensure_dir` plus schema emission to `write_json_schema`.

*Call graph*: calls 1 internal fn (ensure_dir).


##### `generate_json_with_experimental`  (lines 197–246)

```
fn generate_json_with_experimental(out_dir: &Path, experimental_api: bool) -> Result<()>
```

**Purpose**: Generates individual JSON schema files plus bundled schema documents, optionally retaining experimental API surface. It is the main JSON export driver.

**Data flow**: Ensures `out_dir` exists, builds a list of envelope schema emitters, executes them into a `Vec<GeneratedSchema>`, extends that vector with exported client/server param/response/notification schemas, drops most `v1` entries except an allowlist, builds a mixed bundle with `build_schema_bundle`, optionally filters experimental fields/methods from the bundle, writes the mixed bundle and a flattened v2 bundle, and if stable mode is requested also post-processes individual JSON files and removes experimental type files. Returns `Result<()>` and writes multiple `.json` outputs.

**Call relations**: Called by `generate_json` and by tests covering stable and experimental export behavior. It delegates bundling to `build_schema_bundle`, flattening to `build_flat_v2_schema`, stable filtering to `filter_experimental_schema` and `filter_experimental_json_files`, and file writes to `write_pretty_json`.

*Call graph*: calls 6 internal fn (build_flat_v2_schema, build_schema_bundle, ensure_dir, filter_experimental_json_files, filter_experimental_schema, write_pretty_json); called by 3 (generate_json, generate_json_filters_experimental_fields_and_methods, generate_json_includes_remote_control_methods_with_experimental_api); 9 external calls (join, new, export_client_notification_schemas, export_client_param_schemas, export_client_response_schemas, export_server_notification_schemas, export_server_param_schemas, export_server_response_schemas, vec!).


##### `filter_experimental_ts`  (lines 248–259)

```
fn filter_experimental_ts(out_dir: &Path) -> Result<()>
```

**Purpose**: Removes experimental methods, fields, and generated type files from an on-disk TypeScript export tree. It is the stable-output post-processing step for TS.

**Data flow**: Reads registered experimental fields and the computed set of experimental method-related type names, rewrites `ClientRequest.ts` to drop experimental union arms, rewrites matching type files to remove experimental properties, then deletes generated `.ts` files for experimental-only types. Returns `Result<()>` after mutating files under `out_dir`.

**Call relations**: Called by `generate_ts_with_options` when `experimental_api` is false. It delegates method filtering to `filter_client_request_ts`, field filtering to `filter_experimental_type_fields_ts`, and file deletion to `remove_generated_type_files`.

*Call graph*: calls 5 internal fn (experimental_fields, experimental_method_types, filter_client_request_ts, filter_experimental_type_fields_ts, remove_generated_type_files); called by 1 (generate_ts_with_options).


##### `filter_experimental_ts_tree`  (lines 261–294)

```
fn filter_experimental_ts_tree(tree: &mut BTreeMap<PathBuf, String>) -> Result<()>
```

**Purpose**: Applies the same experimental-TypeScript filtering logic as `filter_experimental_ts`, but against an in-memory file tree instead of the filesystem. This supports fixture generation in tests.

**Data flow**: Takes `tree: &mut BTreeMap<PathBuf, String>` representing relative TS file contents, rewrites `ClientRequest.ts` if present, groups registered experimental fields by type name, rewrites matching file contents to remove those fields, and removes entries for experimental-only generated types. Returns `Result<()>` after mutating the map in place.

**Call relations**: Called by `generate_typescript_schema_fixture_subtree_for_tests`. It mirrors the on-disk filtering path but delegates to the pure string transformers `filter_client_request_ts_contents` and `filter_experimental_type_fields_ts_contents`, then uses `remove_generated_type_entries` instead of deleting files.

*Call graph*: calls 5 internal fn (experimental_fields, experimental_method_types, filter_client_request_ts_contents, filter_experimental_type_fields_ts_contents, remove_generated_type_entries); called by 1 (generate_typescript_schema_fixture_subtree_for_tests); 3 external calls (new, new, take).


##### `filter_client_request_ts`  (lines 297–308)

```
fn filter_client_request_ts(out_dir: &Path, experimental_methods: &[&str]) -> Result<()>
```

**Purpose**: Rewrites the generated `ClientRequest.ts` file on disk to remove union arms for experimental client methods. It is a targeted post-processor for a file whose method union cannot be fully filtered by schema-level processing alone.

**Data flow**: Builds `out_dir/ClientRequest.ts`, returns early if it does not exist, otherwise reads the file to a string, transforms it with `filter_client_request_ts_contents`, and writes the filtered content back. Returns `Result<()>` and mutates that single file.

**Call relations**: Called by `filter_experimental_ts` as part of stable TS export cleanup. It delegates the actual source-text transformation to `filter_client_request_ts_contents`.

*Call graph*: calls 1 internal fn (filter_client_request_ts_contents); called by 1 (filter_experimental_ts); 3 external calls (join, read_to_string, write).


##### `filter_client_request_ts_contents`  (lines 310–333)

```
fn filter_client_request_ts_contents(mut content: String, experimental_methods: &[&str]) -> String
```

**Purpose**: Removes experimental method variants from the body of a generated `ClientRequest` type alias and prunes now-unused type imports. It performs source-text surgery without a full TS parser.

**Data flow**: Takes the full file `content` string and a slice of experimental method names, splits the type alias into prefix/body/suffix, splits top-level union arms on `|`, extracts each arm’s `method` literal, drops arms whose method is in the experimental set, rejoins the union, reconstructs the file, then removes import lines whose imported type names are no longer referenced in the surviving alias body. Returns the rewritten `String`.

**Call relations**: Used by both `filter_client_request_ts` and `filter_experimental_ts_tree`. It depends on `split_type_alias`, `split_top_level`, `extract_method_from_arm`, and `prune_unused_type_imports` to safely edit generated TS.

*Call graph*: calls 3 internal fn (prune_unused_type_imports, split_top_level, split_type_alias); called by 2 (filter_client_request_ts, filter_experimental_ts_tree); 1 external calls (format!).


##### `filter_experimental_type_fields_ts`  (lines 336–362)

```
fn filter_experimental_type_fields_ts(
    out_dir: &Path,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
) -> Result<()>
```

**Purpose**: Removes experimental properties from generated TypeScript type files based on registered field metadata. It scans the export tree and rewrites only files whose type names match experimental field registrations.

**Data flow**: Builds a `HashMap<String, HashSet<String>>` from type name to experimental field names, returns early if empty, recursively enumerates `.ts` files under `out_dir`, derives each file’s type name from its stem, and for matching types rewrites the file via `filter_experimental_fields_in_ts_file`. Returns `Result<()>` after mutating selected files.

**Call relations**: Called by `filter_experimental_ts` and several tests that validate edge-case TS filtering. It delegates file enumeration to `ts_files_in_recursive` and per-file rewriting to `filter_experimental_fields_in_ts_file`.

*Call graph*: calls 2 internal fn (filter_experimental_fields_in_ts_file, ts_files_in_recursive); called by 4 (filter_experimental_ts, experimental_type_fields_ts_filter_handles_generated_command_params_shape, experimental_type_fields_ts_filter_handles_interface_shape, experimental_type_fields_ts_filter_keeps_imports_used_in_intersection_suffix); 1 external calls (new).


##### `filter_experimental_fields_in_ts_file`  (lines 364–373)

```
fn filter_experimental_fields_in_ts_file(
    path: &Path,
    experimental_field_names: &HashSet<String>,
) -> Result<()>
```

**Purpose**: Applies experimental-field removal to one TypeScript file on disk. It is the file-level wrapper around the pure content transformer.

**Data flow**: Reads `path` into a string, transforms it with `filter_experimental_type_fields_ts_contents` using the provided set of field names, and writes the result back to the same path. Returns `Result<()>` and mutates that file.

**Call relations**: Called by `filter_experimental_type_fields_ts` for each matching generated type file. It delegates the parsing/editing logic to `filter_experimental_type_fields_ts_contents`.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts_contents); called by 1 (filter_experimental_type_fields_ts); 2 external calls (read_to_string, write).


##### `filter_experimental_type_fields_ts_contents`  (lines 375–400)

```
fn filter_experimental_type_fields_ts_contents(
    mut content: String,
    experimental_field_names: &HashSet<String>,
) -> String
```

**Purpose**: Removes named experimental properties from a generated TypeScript object/interface body and prunes imports that become unused afterward. It handles both type aliases and interface shapes.

**Data flow**: Takes file `content` and a set of experimental field names, locates the top-level object body with `type_body_brace_span`, splits fields at top-level commas/semicolons, strips leading block comments before property-name parsing, drops fields whose parsed property name is in the experimental set, reconstructs the body, then prunes unused single-type imports based on the remaining usage scope. Returns the rewritten `String`.

**Call relations**: Used by `filter_experimental_fields_in_ts_file` and `filter_experimental_ts_tree`. It relies on `type_body_brace_span`, `split_top_level_multi`, `strip_leading_block_comments`, `parse_property_name`, and `prune_unused_type_imports` to avoid corrupting nested TS syntax.

*Call graph*: calls 4 internal fn (prune_unused_type_imports, split_top_level_multi, split_type_alias, type_body_brace_span); called by 2 (filter_experimental_fields_in_ts_file, filter_experimental_ts_tree); 1 external calls (format!).


##### `filter_experimental_schema`  (lines 402–409)

```
fn filter_experimental_schema(bundle: &mut Value) -> Result<()>
```

**Purpose**: Removes experimental fields, methods, and method-only type definitions from a bundled JSON schema value. It is the stable-output filter for schema bundles and individual schema files.

**Data flow**: Reads registered experimental fields, removes matching properties from the root schema and nested definitions, prunes experimental method variants from arrays/objects recursively, and deletes definitions for experimental-only method parameter/response/dependency types. It mutates the provided `serde_json::Value` in place and returns `Result<()>`.

**Call relations**: Called by `generate_json_with_experimental`, `filter_experimental_json_files`, and tests that validate stable filtering. It delegates field removal to `filter_experimental_fields_in_root` and `filter_experimental_fields_in_definitions`, method pruning to `prune_experimental_methods`, and definition cleanup to `remove_experimental_method_type_definitions`.

*Call graph*: calls 5 internal fn (experimental_fields, filter_experimental_fields_in_definitions, filter_experimental_fields_in_root, prune_experimental_methods, remove_experimental_method_type_definitions); called by 4 (filter_experimental_json_files, generate_json_with_experimental, stable_schema_filter_removes_mock_experimental_method, stable_schema_filter_removes_mock_thread_start_field).


##### `filter_experimental_fields_in_root`  (lines 411–426)

```
fn filter_experimental_fields_in_root(
    schema: &mut Value,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
)
```

**Purpose**: Removes experimental properties from the root schema object when its `title` matches a registered experimental field’s owning type. It handles the top-level schema case outside nested definitions.

**Data flow**: Reads the schema’s `title` string, compares it against each registered `ExperimentalField.type_name`, and for matches removes the named property from the schema via `remove_property_from_schema`. It mutates the provided schema value in place.

**Call relations**: Called by `filter_experimental_schema` before nested-definition filtering. It exists because the root schema may itself represent a concrete type with removable experimental fields.

*Call graph*: calls 1 internal fn (remove_property_from_schema); called by 1 (filter_experimental_schema); 1 external calls (get).


##### `filter_experimental_fields_in_definitions`  (lines 428–437)

```
fn filter_experimental_fields_in_definitions(
    bundle: &mut Value,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
)
```

**Purpose**: Removes experimental properties from the bundle’s `definitions` map. It is the entrypoint for recursive definition-map filtering.

**Data flow**: Looks up `bundle["definitions"]` as a mutable object map and, if present, passes it plus the registered field list to `filter_experimental_fields_in_definitions_map`. It mutates the bundle in place and returns no value.

**Call relations**: Called by `filter_experimental_schema`. It is a shallow wrapper that isolates the `definitions` lookup from the recursive map-walking logic.

*Call graph*: calls 1 internal fn (filter_experimental_fields_in_definitions_map); called by 1 (filter_experimental_schema); 1 external calls (get_mut).


##### `filter_experimental_fields_in_definitions_map`  (lines 439–458)

```
fn filter_experimental_fields_in_definitions_map(
    definitions: &mut Map<String, Value>,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
)
```

**Purpose**: Recursively traverses schema definition maps, including namespace submaps, and removes registered experimental properties from matching type definitions. It understands both flat and namespaced bundle layouts.

**Data flow**: Iterates mutable `(def_name, def_schema)` pairs in a `Map<String, Value>`. If an entry is a namespace map, it recurses into that object; otherwise it compares each registered field’s `type_name` against `def_name` using `definition_matches_type` and removes matching properties from `def_schema` via `remove_property_from_schema`. It mutates the map contents in place.

**Call relations**: Called by `filter_experimental_fields_in_definitions`. It depends on `is_namespace_map` to distinguish nested namespace containers from actual schema objects.

*Call graph*: calls 3 internal fn (definition_matches_type, is_namespace_map, remove_property_from_schema); called by 1 (filter_experimental_fields_in_definitions); 1 external calls (iter_mut).


##### `is_namespace_map`  (lines 460–476)

```
fn is_namespace_map(value: &Value) -> bool
```

**Purpose**: Heuristically distinguishes a namespace container object from an actual JSON Schema object. This prevents recursive definition walkers from treating namespace maps as schemas.

**Data flow**: Inspects a `Value`; returns `false` unless it is an object with no `$`-prefixed keys, no obvious schema-shape keys like `type`/`properties`/`oneOf`, and all values are themselves objects. It is pure.

**Call relations**: Used by `filter_experimental_fields_in_definitions_map` and `remove_experimental_method_type_definitions_map` to recurse correctly through namespaced definition trees.

*Call graph*: called by 2 (filter_experimental_fields_in_definitions_map, remove_experimental_method_type_definitions_map).


##### `definition_matches_type`  (lines 478–480)

```
fn definition_matches_type(def_name: &str, type_name: &str) -> bool
```

**Purpose**: Checks whether a definition key corresponds to a logical type name, either exactly or as a namespaced suffix like `v2::Type`. It normalizes matching across bundle layouts.

**Data flow**: Takes `def_name` and `type_name` strings and returns `true` if `def_name == type_name` or if it ends with `::{type_name}`. It has no side effects.

**Call relations**: Called during experimental-field filtering to decide whether a schema definition owns a registered experimental field. It encapsulates the exact matching rule used across namespaced and non-namespaced definitions.

*Call graph*: called by 1 (filter_experimental_fields_in_definitions_map); 1 external calls (format!).


##### `remove_property_from_schema`  (lines 482–494)

```
fn remove_property_from_schema(schema: &mut Value, field_name: &str)
```

**Purpose**: Deletes a named property from a schema object and removes it from the `required` list, recursing through nested `schema` wrappers when present. It is the primitive used for field-level schema filtering.

**Data flow**: Mutably inspects a schema `Value`, removes `field_name` from `properties` if present, retains only nonmatching entries in `required`, and if the schema contains an inner `schema` field recursively applies the same removal there. It mutates in place and returns no value.

**Call relations**: Used by both root-level and definition-level experimental field filtering. Its recursive `schema` handling covers wrapped schema shapes that would otherwise retain stale required entries.

*Call graph*: called by 2 (filter_experimental_fields_in_definitions_map, filter_experimental_fields_in_root); 1 external calls (get_mut).


##### `prune_experimental_methods`  (lines 496–503)

```
fn prune_experimental_methods(bundle: &mut Value, experimental_methods: &[&str])
```

**Purpose**: Removes schema variants corresponding to experimental client methods from an arbitrary schema tree. It prepares the experimental method set and delegates recursive traversal.

**Data flow**: Builds a `HashSet<&str>` from the provided method slice, ignoring empty strings, then calls `prune_experimental_methods_inner` on the mutable bundle. It mutates the bundle in place.

**Call relations**: Called by `filter_experimental_schema` after field filtering. It exists mainly to normalize the method list before recursive pruning.

*Call graph*: calls 1 internal fn (prune_experimental_methods_inner); called by 1 (filter_experimental_schema).


##### `prune_experimental_methods_inner`  (lines 505–520)

```
fn prune_experimental_methods_inner(value: &mut Value, experimental_methods: &HashSet<&str>)
```

**Purpose**: Recursively walks a JSON value and removes array elements that represent experimental method variants. It is the tree traversal behind method pruning.

**Data flow**: Matches on `Value`: for arrays, retains only items for which `is_experimental_method_variant` is false and then recurses into remaining items; for objects, recurses into all values; scalars are ignored. It mutates the tree in place.

**Call relations**: Called only by `prune_experimental_methods`. It depends on `is_experimental_method_variant` to recognize the specific schema shape of a method-discriminated union arm.

*Call graph*: called by 1 (prune_experimental_methods).


##### `is_experimental_method_variant`  (lines 522–545)

```
fn is_experimental_method_variant(value: &Value, experimental_methods: &HashSet<&str>) -> bool
```

**Purpose**: Recognizes whether a schema object encodes a method-discriminated variant whose `method` literal is in the experimental set. It supports both `const` and single-value `enum` encodings.

**Data flow**: Inspects a `Value` as an object, drills into `properties.method`, extracts either `const` or a one-element `enum`, and returns whether that method string is contained in the provided `HashSet<&str>`. It is pure.

**Call relations**: Used by `prune_experimental_methods_inner` to decide which array entries to drop from union-like schema arrays.


##### `filter_experimental_json_files`  (lines 547–556)

```
fn filter_experimental_json_files(out_dir: &Path) -> Result<()>
```

**Purpose**: Applies stable experimental filtering to every generated JSON file on disk and removes experimental-only schema files afterward. It is the file-tree counterpart to bundle filtering.

**Data flow**: Recursively enumerates `.json` files under `out_dir`, reads each into a `Value`, mutates it with `filter_experimental_schema`, writes it back prettily, computes experimental method-related type names, and deletes matching generated `.json` files from root, `v1`, and `v2` subdirs. Returns `Result<()>` after mutating the output tree.

**Call relations**: Called by `generate_json_with_experimental` only in stable mode. It delegates file discovery to `json_files_in_recursive`, parsing to `read_json_value`, schema mutation to `filter_experimental_schema`, writing to `write_pretty_json`, and cleanup to `remove_generated_type_files`.

*Call graph*: calls 6 internal fn (experimental_method_types, filter_experimental_schema, json_files_in_recursive, read_json_value, remove_generated_type_files, write_pretty_json); called by 1 (generate_json_with_experimental).


##### `experimental_method_types`  (lines 558–564)

```
fn experimental_method_types() -> HashSet<String>
```

**Purpose**: Computes the set of generated type names that exist only to support experimental client methods or their dependencies. This set drives file and definition removal in stable exports.

**Data flow**: Creates an empty `HashSet<String>`, then feeds the configured experimental param, response, and dependency type lists through `collect_experimental_type_names`. Returns the populated set.

**Call relations**: Used by TS filtering, JSON filtering, in-memory tree filtering, and schema-definition cleanup. It centralizes the hard-coded mapping from experimental methods to generated type names.

*Call graph*: calls 1 internal fn (collect_experimental_type_names); called by 4 (filter_experimental_json_files, filter_experimental_ts, filter_experimental_ts_tree, remove_experimental_method_type_definitions); 1 external calls (new).


##### `collect_experimental_type_names`  (lines 566–577)

```
fn collect_experimental_type_names(entries: &[&str], out: &mut HashSet<String>)
```

**Purpose**: Normalizes a list of possibly namespaced type identifiers into bare type names and inserts them into an output set. It strips whitespace and namespace prefixes.

**Data flow**: Iterates `entries: &[&str]`, trims each string, skips empties, takes the last `::` segment if present, and inserts the resulting nonempty name into `out: &mut HashSet<String>`. It mutates the provided set in place.

**Call relations**: Called only by `experimental_method_types` to populate the aggregate set from multiple constant lists.

*Call graph*: called by 1 (experimental_method_types).


##### `remove_generated_type_files`  (lines 579–600)

```
fn remove_generated_type_files(
    out_dir: &Path,
    type_names: &HashSet<String>,
    extension: &str,
) -> Result<()>
```

**Purpose**: Deletes generated files for a set of type names across root, `v1`, and `v2` directories. It is used to physically remove experimental-only artifacts from stable exports.

**Data flow**: For each `type_name` and each subdir in `""`, `"v1"`, `"v2"`, constructs the expected file path with the given extension, checks existence, and removes the file if present. Returns `Result<()>` and mutates the filesystem.

**Call relations**: Called by `filter_experimental_ts` and `filter_experimental_json_files` after content-level filtering. It is the final cleanup step for types that should disappear entirely.

*Call graph*: called by 2 (filter_experimental_json_files, filter_experimental_ts); 3 external calls (join, format!, remove_file).


##### `remove_generated_type_entries`  (lines 602–617)

```
fn remove_generated_type_entries(
    tree: &mut BTreeMap<PathBuf, String>,
    type_names: &HashSet<String>,
    extension: &str,
)
```

**Purpose**: Removes generated file entries for a set of type names from an in-memory file tree. It mirrors `remove_generated_type_files` for test fixture generation.

**Data flow**: For each type name and each of the root/`v1`/`v2` relative locations, constructs the corresponding `PathBuf` and removes that key from `tree: &mut BTreeMap<PathBuf, String>`. It mutates the map in place.

**Call relations**: Called by `filter_experimental_ts_tree` after content filtering. It provides the non-filesystem equivalent of generated-file deletion.

*Call graph*: called by 1 (filter_experimental_ts_tree); 2 external calls (from, format!).


##### `remove_experimental_method_type_definitions`  (lines 619–625)

```
fn remove_experimental_method_type_definitions(bundle: &mut Value)
```

**Purpose**: Deletes schema definitions corresponding to experimental-only method types from a bundle’s `definitions` tree. This prevents stable bundles from retaining unreachable experimental schemas.

**Data flow**: Computes the experimental type-name set, looks up mutable `definitions`, and if present recursively removes matching entries via `remove_experimental_method_type_definitions_map`. It mutates the bundle in place.

**Call relations**: Called by `filter_experimental_schema` after method pruning. It complements file deletion by cleaning the bundled schema document itself.

*Call graph*: calls 2 internal fn (experimental_method_types, remove_experimental_method_type_definitions_map); called by 1 (filter_experimental_schema); 1 external calls (get_mut).


##### `remove_experimental_method_type_definitions_map`  (lines 627–655)

```
fn remove_experimental_method_type_definitions_map(
    definitions: &mut Map<String, Value>,
    experimental_type_names: &HashSet<String>,
)
```

**Purpose**: Recursively removes definitions whose names match experimental-only type names, including inside namespace maps. It is the definition-map walker behind experimental type cleanup.

**Data flow**: Collects keys to remove by comparing each definition name against all experimental type names with `definition_matches_type`, removes those keys, then recurses into any remaining values recognized as namespace maps. It mutates the provided map in place.

**Call relations**: Called by `remove_experimental_method_type_definitions`. It relies on `is_namespace_map` to recurse only into namespace containers.

*Call graph*: calls 1 internal fn (is_namespace_map); called by 1 (remove_experimental_method_type_definitions); 3 external calls (keys, remove, values_mut).


##### `prune_unused_type_imports`  (lines 657–674)

```
fn prune_unused_type_imports(content: String, type_alias_body: &str) -> String
```

**Purpose**: Drops simple `import type { X } from ...` lines whose imported type name no longer appears in the relevant type alias body. It keeps TS post-processing from leaving stale imports behind.

**Data flow**: Takes full file `content` and a `type_alias_body` usage scope, preserves whether the original content ended with a newline, scans each line, removes lines whose imported type name parsed by `parse_imported_type_name` is absent from `type_alias_body`, rejoins the remaining lines, and restores the trailing newline if needed. Returns the rewritten `String`.

**Call relations**: Called after TS union/property filtering by `filter_client_request_ts_contents` and `filter_experimental_type_fields_ts_contents`. It intentionally handles only simple one-name type imports.

*Call graph*: calls 1 internal fn (parse_imported_type_name); called by 2 (filter_client_request_ts_contents, filter_experimental_type_fields_ts_contents); 1 external calls (new).


##### `parse_imported_type_name`  (lines 676–685)

```
fn parse_imported_type_name(line: &str) -> Option<&str>
```

**Purpose**: Parses a simple single-name `import type { Name } from ...` line and returns the imported type name. It rejects multi-import and aliased forms.

**Data flow**: Trims the input line, checks for the `import type {` prefix, splits at `} from `, trims the extracted name, and returns `Some(&str)` only if the name is nonempty, contains no comma, and contains no ` as `. Otherwise returns `None`.

**Call relations**: Used exclusively by `prune_unused_type_imports` to identify import lines eligible for removal.

*Call graph*: called by 1 (prune_unused_type_imports).


##### `json_files_in_recursive`  (lines 687–704)

```
fn json_files_in_recursive(dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Recursively enumerates all `.json` files under a directory. It is a small filesystem traversal helper for schema post-processing.

**Data flow**: Uses a stack of directories starting with `dir`, repeatedly reads directory entries, pushes subdirectories, and collects paths whose extension is `json`. Returns a `Vec<PathBuf>` of discovered files.

**Call relations**: Called by `filter_experimental_json_files` to find every generated JSON file that needs stable filtering.

*Call graph*: called by 1 (filter_experimental_json_files); 4 external calls (new, read_dir, matches!, vec!).


##### `read_json_value`  (lines 706–710)

```
fn read_json_value(path: &Path) -> Result<Value>
```

**Purpose**: Reads and parses a JSON file into a `serde_json::Value` with path-specific error context. It is the basic JSON file loader for post-processing and tests.

**Data flow**: Reads the file at `path` to a string, parses it with `serde_json::from_str`, and returns the resulting `Value`. It does not mutate state.

**Call relations**: Used by `filter_experimental_json_files` during on-disk rewriting and by tests that inspect generated bundle contents.

*Call graph*: called by 2 (filter_experimental_json_files, generate_json_filters_experimental_fields_and_methods); 2 external calls (read_to_string, from_str).


##### `split_type_alias`  (lines 712–722)

```
fn split_type_alias(content: &str) -> Option<(String, String, String)>
```

**Purpose**: Splits a TypeScript type-alias declaration into prefix, body, and suffix around the top-level `=` and trailing `;`. It provides a simple structural decomposition for source-text rewriting.

**Data flow**: Searches `content` for the first `=` and last `;`; if both exist in the right order, returns `(prefix, body, suffix)` as owned `String`s, otherwise `None`. It is pure.

**Call relations**: Used by `filter_client_request_ts_contents` and `filter_experimental_type_fields_ts_contents` to isolate the editable portion of generated type aliases.

*Call graph*: called by 2 (filter_client_request_ts_contents, filter_experimental_type_fields_ts_contents).


##### `type_body_brace_span`  (lines 724–739)

```
fn type_body_brace_span(content: &str) -> Option<(usize, usize)>
```

**Purpose**: Finds the byte span of the top-level `{ ... }` body for either a type alias or an `export interface` declaration. It lets field filtering target object bodies precisely.

**Data flow**: If the content contains `=`, searches for the top-level brace span after it; otherwise looks for `export interface` and searches after that marker. Returns `Some((open_index, close_index))` or `None` if no suitable body is found.

**Call relations**: Called by `filter_experimental_type_fields_ts_contents`. It delegates brace matching to `find_top_level_brace_span`.

*Call graph*: calls 1 internal fn (find_top_level_brace_span); called by 1 (filter_experimental_type_fields_ts_contents).


##### `find_top_level_brace_span`  (lines 741–758)

```
fn find_top_level_brace_span(input: &str) -> Option<(usize, usize)>
```

**Purpose**: Finds the first top-level brace pair in a string while ignoring nested syntax, strings, and comments. It is the core scanner used by TS source-text parsing helpers.

**Data flow**: Initializes `ScanState`, iterates `input.char_indices()`, records an opening `{` seen at top level outside ignored syntax, updates scanner state on every character, and returns the matching top-level closing `}` span once found. Returns `Option<(usize, usize)>`.

**Call relations**: Used by `type_body_brace_span` and `extract_method_from_arm`. It depends on `ScanState` and `Depth` to avoid false matches inside nested constructs.

*Call graph*: called by 2 (extract_method_from_arm, type_body_brace_span); 1 external calls (default).


##### `split_top_level`  (lines 760–762)

```
fn split_top_level(input: &str, delimiter: char) -> Vec<String>
```

**Purpose**: Splits a string on a single delimiter only when that delimiter appears at top level outside nested syntax. It is a convenience wrapper over the multi-delimiter splitter.

**Data flow**: Takes `input` and `delimiter`, forwards to `split_top_level_multi(input, &[delimiter])`, and returns the resulting `Vec<String>`. It is pure.

**Call relations**: Used when splitting union arms and object fields in TS source-text transformations.

*Call graph*: calls 1 internal fn (split_top_level_multi); called by 2 (extract_method_from_arm, filter_client_request_ts_contents).


##### `split_top_level_multi`  (lines 764–783)

```
fn split_top_level_multi(input: &str, delimiters: &[char]) -> Vec<String>
```

**Purpose**: Splits a string on any of several delimiters, but only at top level outside strings, comments, and nested braces/brackets/parens/angles. It is the general-purpose tokenizer for lightweight TS parsing.

**Data flow**: Scans `input` with `ScanState`, tracks the start index of the current segment, emits trimmed nonempty substrings whenever a delimiter is encountered at top level outside ignored syntax, and appends the final tail. Returns a `Vec<String>`.

**Call relations**: Called by `split_top_level` and directly by `filter_experimental_type_fields_ts_contents`. It is one of the key helpers that makes source-text filtering robust enough for generated TS.

*Call graph*: called by 2 (filter_experimental_type_fields_ts_contents, split_top_level); 2 external calls (new, default).


##### `extract_method_from_arm`  (lines 785–800)

```
fn extract_method_from_arm(arm: &str) -> Option<String>
```

**Purpose**: Extracts the string literal assigned to the `method` property from a TypeScript union arm representing an object type. It is used to identify experimental request variants.

**Data flow**: Finds the arm’s top-level brace span, slices the inner object body, splits top-level fields on commas, parses each field into `(name, value)`, and when `name == "method"` parses the leading string literal from the value and returns it as `Some(String)`. Returns `None` if no method literal is found.

**Call relations**: Used by `filter_client_request_ts_contents` to decide which union arms to remove. It depends on `find_top_level_brace_span`, `split_top_level`, `parse_property`, and `parse_string_literal`.

*Call graph*: calls 4 internal fn (find_top_level_brace_span, parse_property, parse_string_literal, split_top_level).


##### `parse_property`  (lines 802–806)

```
fn parse_property(input: &str) -> Option<(String, &str)>
```

**Purpose**: Parses a TypeScript object property declaration into its property name and the remainder of the value text after the colon. It is a small helper for field inspection.

**Data flow**: Calls `parse_property_name(input)` to get the property name, finds the first `:`, and returns `(name, trimmed_value_suffix)` if both are present. Otherwise returns `None`.

**Call relations**: Used by `extract_method_from_arm` when scanning object-type fields.

*Call graph*: calls 1 internal fn (parse_property_name); called by 1 (extract_method_from_arm).


##### `strip_leading_block_comments`  (lines 808–819)

```
fn strip_leading_block_comments(input: &str) -> &str
```

**Purpose**: Removes one or more leading `/* ... */` block comments from a field snippet before property-name parsing. This prevents documentation comments from confusing TS field filtering.

**Data flow**: Trims leading whitespace, repeatedly strips a leading block comment if present and complete, then returns the remaining `&str`. It does not allocate unless the caller later copies the result.

**Call relations**: Used by `filter_experimental_type_fields_ts_contents` before calling `parse_property_name` on generated field snippets that may begin with doc comments.


##### `parse_property_name`  (lines 821–855)

```
fn parse_property_name(input: &str) -> Option<String>
```

**Purpose**: Parses a TypeScript property name from a field declaration, supporting quoted names, identifiers, and optional `?` markers. It rejects inputs that are not property declarations.

**Data flow**: Trims leading whitespace, first tries to parse a quoted string literal name followed by `:`, otherwise scans identifier characters with `is_ident_char`, optionally consumes a trailing `?`, and returns the property name as `Some(String)` only if the remaining text starts with `:`. Returns `None` on failure.

**Call relations**: Used by `parse_property` and by TS field filtering to identify which generated properties should be removed.

*Call graph*: calls 2 internal fn (is_ident_char, parse_string_literal); called by 1 (parse_property).


##### `parse_string_literal`  (lines 857–880)

```
fn parse_string_literal(input: &str) -> Option<(String, usize)>
```

**Purpose**: Parses a single- or double-quoted string literal from the start of an input string, honoring backslash escapes. It returns both the literal contents and the number of bytes consumed.

**Data flow**: Reads the first character as the quote delimiter, scans subsequent characters while tracking escape state, and on the matching closing quote returns `(literal_contents, consumed_len)`. Returns `None` if the input does not start with a quote or the literal is unterminated.

**Call relations**: Used by `extract_method_from_arm` and `parse_property_name` to recognize quoted property names and method literals.

*Call graph*: called by 2 (extract_method_from_arm, parse_property_name).


##### `is_ident_char`  (lines 882–884)

```
fn is_ident_char(ch: char) -> bool
```

**Purpose**: Defines the subset of characters accepted in parsed TypeScript identifier property names for this lightweight parser. It allows ASCII alphanumerics and underscore.

**Data flow**: Takes a `char` and returns `true` if it is ASCII alphanumeric or `_`, otherwise `false`. It is pure.

**Call relations**: Used by `parse_property_name` during identifier scanning.

*Call graph*: called by 1 (parse_property_name).


##### `ScanState::observe`  (lines 897–963)

```
fn observe(&mut self, ch: char)
```

**Purpose**: Updates the lightweight TS scanner state for one character, tracking nesting depth, strings, escapes, and comments. It is the engine behind top-level splitting and brace matching.

**Data flow**: Mutates `self` based on the incoming character: exits line comments on newline, exits block comments on `*/`, handles string delimiters and escapes, detects comment starts from prior `/`, and adjusts `Depth` counters for braces, brackets, parens, and angle brackets when not inside ignored syntax. It returns no value.

**Call relations**: Called repeatedly by `find_top_level_brace_span` and `split_top_level_multi`. Its correctness determines whether TS source-text edits respect nested syntax boundaries.


##### `ScanState::in_ignored_syntax`  (lines 965–967)

```
fn in_ignored_syntax(&self) -> bool
```

**Purpose**: Reports whether the scanner is currently inside a string literal or comment. This tells callers whether delimiters and braces should be ignored.

**Data flow**: Reads `self.string_delim`, `self.block_comment`, and `self.line_comment` and returns `true` if any are active. It is pure.

**Call relations**: Used by the scanner-driven parsing helpers to avoid splitting or matching syntax inside comments and strings.


##### `Depth::is_top_level`  (lines 979–981)

```
fn is_top_level(&self) -> bool
```

**Purpose**: Reports whether all tracked nesting counters are zero. It defines the notion of “top level” for the lightweight TS parser.

**Data flow**: Reads `brace`, `bracket`, `paren`, and `angle` counters and returns `true` only when all are zero. It is pure.

**Call relations**: Used by `find_top_level_brace_span` and `split_top_level_multi` to decide when delimiters and braces are structurally significant.


##### `build_schema_bundle`  (lines 984–1065)

```
fn build_schema_bundle(schemas: Vec<GeneratedSchema>) -> Result<Value>
```

**Purpose**: Combines many generated per-type schemas into one bundled JSON Schema document with a unified `definitions` map, namespace-aware `$ref` rewriting, extracted nested definitions, and schema annotation. It is the central bundling algorithm for protocol JSON export.

**Data flow**: Takes `Vec<GeneratedSchema>`, computes known namespaced types, iterates each schema, skips ignored definitions, rewrites refs either into the schema’s own namespace or toward known namespaced definitions, extracts nested `definitions` from each schema value, annotates schemas and nested definitions with titles, inserts definitions into root or namespace maps while detecting collisions, rewrites forced refs for extracted definitions that belong in another namespace, and finally constructs a root object containing `$schema`, `title`, `type`, and the assembled `definitions`. Returns the bundled `Value`.

**Call relations**: Called by `generate_json_with_experimental` and several tests. It delegates namespace discovery to `collect_namespaced_types`, ref rewriting to `rewrite_refs_to_namespace`, `rewrite_refs_to_known_namespaces`, and `rewrite_named_ref_to_namespace`, annotation to `annotate_schema`, and insertion/collision handling to `insert_into_namespace`.

*Call graph*: calls 7 internal fn (annotate_schema, collect_namespaced_types, insert_into_namespace, namespace_for_definition, rewrite_named_ref_to_namespace, rewrite_refs_to_known_namespaces, rewrite_refs_to_namespace); called by 4 (generate_json_with_experimental, build_schema_bundle_rewrites_root_helper_refs_to_namespaced_defs, stable_schema_filter_removes_mock_experimental_method, stable_schema_filter_removes_mock_thread_start_field); 4 external calls (new, Object, String, new).


##### `build_flat_v2_schema`  (lines 1079–1127)

```
fn build_flat_v2_schema(bundle: &Value) -> Result<Value>
```

**Purpose**: Transforms the mixed bundled schema into a flat v2-only bundle suitable for downstream code generators that cannot traverse nested namespace maps. It preserves shared root unions and pulls in any non-v2 dependencies they reference.

**Data flow**: Validates that the input bundle root and `definitions.v2` exist, clones the root, starts flat definitions from the `v2` namespace contents, copies selected shared root schemas (`ClientRequest`, `ServerNotification`), collects their non-v2 refs, recursively gathers dependent root definitions, merges everything into one flat `definitions` map, retitles the bundle as `...V2`, rewrites `#/definitions/v2/` refs to `#/definitions/`, and validates that no namespaced refs remain and all referenced definitions are present. Returns the flattened `Value`.

**Call relations**: Called by `generate_json_with_experimental` and tested directly. It delegates dependency discovery to `collect_non_v2_refs` and `collect_definition_dependencies`, ref rewriting to `rewrite_ref_prefix`, and integrity checks to `ensure_no_ref_prefix` and `ensure_referenced_definitions_present`.

*Call graph*: calls 5 internal fn (collect_definition_dependencies, collect_non_v2_refs, ensure_no_ref_prefix, ensure_referenced_definitions_present, rewrite_ref_prefix); called by 2 (generate_json_with_experimental, build_flat_v2_schema_keeps_shared_root_schemas_and_dependencies); 6 external calls (new, new, Object, String, anyhow!, format!).


##### `collect_non_v2_refs`  (lines 1129–1133)

```
fn collect_non_v2_refs(value: &Value) -> HashSet<String>
```

**Purpose**: Collects root-definition references from a schema tree, excluding refs that already point into the `v2` namespace. It identifies shared-root dependencies needed by the flat-v2 bundle.

**Data flow**: Creates an empty `HashSet<String>`, recursively traverses the input value with `collect_non_v2_refs_inner`, and returns the accumulated set of referenced definition names. It is pure aside from mutating the local set.

**Call relations**: Used by `build_flat_v2_schema` and `collect_definition_dependencies` to discover non-v2 dependencies that must be retained in the flattened bundle.

*Call graph*: calls 1 internal fn (collect_non_v2_refs_inner); called by 2 (build_flat_v2_schema, collect_definition_dependencies); 1 external calls (new).


##### `collect_non_v2_refs_inner`  (lines 1135–1155)

```
fn collect_non_v2_refs_inner(value: &Value, refs: &mut HashSet<String>)
```

**Purpose**: Recursively walks a schema tree and records `$ref` targets under `#/definitions/` that do not start with `#/definitions/v2/`. It is the traversal worker for non-v2 dependency collection.

**Data flow**: For objects, inspects `$ref` and inserts the referenced name when it is a non-v2 root definition, then recurses into all child values; for arrays, recurses into each item; scalars are ignored. It mutates the provided `refs` set in place.

**Call relations**: Called only by `collect_non_v2_refs`.

*Call graph*: called by 1 (collect_non_v2_refs).


##### `collect_definition_dependencies`  (lines 1157–1177)

```
fn collect_definition_dependencies(
    definitions: &Map<String, Value>,
    names: HashSet<String>,
) -> HashSet<String>
```

**Purpose**: Computes the transitive closure of non-v2 definition dependencies starting from an initial set of names. It ensures the flat-v2 bundle includes all shared root helpers still referenced indirectly.

**Data flow**: Takes the root `definitions` map and an initial `HashSet<String>` of names, then performs a worklist traversal: pop a name, skip if already seen, look up its schema, collect its non-v2 refs, and enqueue unseen dependencies. Returns the final `seen` set.

**Call relations**: Called by `build_flat_v2_schema` after collecting direct non-v2 refs from shared root schemas.

*Call graph*: calls 1 internal fn (collect_non_v2_refs); called by 1 (build_flat_v2_schema); 2 external calls (new, get).


##### `rewrite_ref_prefix`  (lines 1179–1196)

```
fn rewrite_ref_prefix(value: &mut Value, prefix: &str, replacement: &str)
```

**Purpose**: Recursively rewrites `$ref` strings by replacing one prefix with another. It is used to flatten namespaced refs into root refs.

**Data flow**: Traverses a mutable `Value`; whenever it finds an object `$ref` string, it applies `String::replace(prefix, replacement)`, then recurses into child values and array items. It mutates the tree in place.

**Call relations**: Called by `build_flat_v2_schema` after assembling the flat bundle so all `#/definitions/v2/...` refs become `#/definitions/...`.

*Call graph*: called by 1 (build_flat_v2_schema).


##### `ensure_no_ref_prefix`  (lines 1198–1205)

```
fn ensure_no_ref_prefix(value: &Value, prefix: &str, label: &str) -> Result<()>
```

**Purpose**: Validates that a schema tree contains no `$ref` values starting with a forbidden prefix. It turns leftover namespaced refs into a descriptive error.

**Data flow**: Searches the schema with `first_ref_with_prefix`; if a matching ref is found, returns an `anyhow!` error naming the offending reference and label, otherwise returns `Ok(())`. It does not mutate state.

**Call relations**: Called by `build_flat_v2_schema` after ref rewriting to ensure flattening completed successfully.

*Call graph*: calls 1 internal fn (first_ref_with_prefix); called by 1 (build_flat_v2_schema); 1 external calls (anyhow!).


##### `first_ref_with_prefix`  (lines 1207–1223)

```
fn first_ref_with_prefix(value: &Value, prefix: &str) -> Option<String>
```

**Purpose**: Finds the first `$ref` string in a schema tree that starts with a given prefix. It is a diagnostic helper for validation.

**Data flow**: Recursively traverses objects and arrays, returning the first matching `$ref` string clone it encounters, or `None` if no match exists. It is pure.

**Call relations**: Used by `ensure_no_ref_prefix` to produce a concrete offending reference in error messages.

*Call graph*: called by 1 (ensure_no_ref_prefix).


##### `ensure_referenced_definitions_present`  (lines 1225–1241)

```
fn ensure_referenced_definitions_present(schema: &Value, label: &str) -> Result<()>
```

**Purpose**: Checks that every `#/definitions/...` reference in a schema points to an existing top-level definition. It guards against producing incomplete bundles.

**Data flow**: Reads the bundle’s `definitions` object, recursively collects missing referenced names into a `HashSet` via `collect_missing_definitions`, and returns `Ok(())` if empty or an `anyhow!` error listing sorted missing names otherwise. It does not mutate the schema.

**Call relations**: Called by `build_flat_v2_schema` as a final integrity check after flattening and ref rewriting.

*Call graph*: calls 1 internal fn (collect_missing_definitions); called by 1 (build_flat_v2_schema); 3 external calls (new, get, anyhow!).


##### `collect_missing_definitions`  (lines 1243–1269)

```
fn collect_missing_definitions(
    value: &Value,
    definitions: &Map<String, Value>,
    missing: &mut HashSet<String>,
)
```

**Purpose**: Recursively scans a schema tree for `#/definitions/...` refs whose top-level definition name is absent from the provided definitions map. It is the worker behind missing-definition validation.

**Data flow**: Traverses objects and arrays; when it finds a `$ref` under `#/definitions/`, it extracts the first path segment after `definitions/` and inserts it into `missing` if `definitions` lacks that key. It mutates the provided set in place.

**Call relations**: Called by `ensure_referenced_definitions_present`.

*Call graph*: called by 1 (ensure_referenced_definitions_present); 1 external calls (contains_key).


##### `insert_into_namespace`  (lines 1271–1286)

```
fn insert_into_namespace(
    definitions: &mut Map<String, Value>,
    namespace: &str,
    name: String,
    schema: Value,
) -> Result<()>
```

**Purpose**: Inserts a schema definition into a namespace object inside the bundle’s `definitions` map, creating the namespace map if needed. It enforces that namespace entries are objects.

**Data flow**: Looks up or creates `definitions[namespace]` as a `Value::Object`, then inserts the named schema into that map via `insert_definition`. Returns `Result<()>` and mutates the definitions map.

**Call relations**: Called by `build_schema_bundle` whenever a schema or extracted nested definition belongs under a namespace like `v2`.

*Call graph*: calls 1 internal fn (insert_definition); called by 1 (build_schema_bundle); 3 external calls (entry, anyhow!, format!).


##### `insert_definition`  (lines 1288–1314)

```
fn insert_definition(
    definitions: &mut Map<String, Value>,
    name: String,
    schema: Value,
    location: &str,
) -> Result<()>
```

**Purpose**: Inserts one named schema definition into a definitions map while detecting collisions between unequal schemas. Equal duplicates are tolerated; unequal duplicates become an error with rename guidance.

**Data flow**: Checks whether `definitions` already contains `name`; if absent, inserts `schema`. If present and equal, returns success unchanged; if present and different, extracts existing/new titles and returns an `anyhow!` collision error naming the location and suggesting `#[schemars(rename = ...)]`. It mutates the map only on successful insertion.

**Call relations**: Called by `insert_into_namespace` and indirectly by `build_schema_bundle` to enforce uniqueness of bundled definitions.

*Call graph*: called by 1 (insert_into_namespace); 4 external calls (get, insert, get, anyhow!).


##### `write_json_schema_with_return`  (lines 1316–1361)

```
fn write_json_schema_with_return(out_dir: &Path, name: &str) -> Result<GeneratedSchema>
```

**Purpose**: Generates a JSON schema for one Rust type, writes it to the appropriate output path, and returns a `GeneratedSchema` record describing the emitted schema for later bundling. It is the per-type schema emission primitive.

**Data flow**: Takes `out_dir` and a schema `name`, splits namespace and logical name, decides whether the schema should be included in JSON codegen, generates the raw schema with `schema_for!(T)`, optionally strips selected v1 variants, checks for numbered-definition collisions, annotates titles, computes the output path (including namespace subdir), writes pretty JSON unless excluded/ignored, and returns `GeneratedSchema { namespace, logical_name, value, in_v1_dir }`.

**Call relations**: Used by `generate_json_with_experimental` through emitter closures and by tests. It delegates namespace parsing to `split_namespace`, v1 pruning to `strip_v1_client_request_variants_from_json_schema` / `strip_v1_server_notification_variants_from_json_schema`, collision checks to `enforce_numbered_definition_collision_overrides`, annotation to `annotate_schema`, directory creation to `ensure_dir`, and writing to `write_pretty_json`.

*Call graph*: calls 7 internal fn (annotate_schema, enforce_numbered_definition_collision_overrides, ensure_dir, split_namespace, strip_v1_client_request_variants_from_json_schema, strip_v1_server_notification_variants_from_json_schema, write_pretty_json); 4 external calls (join, format!, schema_for!, to_value).


##### `enforce_numbered_definition_collision_overrides`  (lines 1363–1370)

```
fn enforce_numbered_definition_collision_overrides(schema_name: &str, schema: &mut Value)
```

**Purpose**: Checks a generated schema’s nested definitions for numbered-name collisions such as `Type` and `Type2` coexisting in a problematic way. It fails fast on ambiguous generated naming.

**Data flow**: Looks for both `definitions` and `$defs` maps in the schema and, when present, passes each to `detect_numbered_definition_collisions` along with the schema name and container key. It does not mutate the schema.

**Call relations**: Called by `write_json_schema_with_return` before annotation and writing.

*Call graph*: calls 1 internal fn (detect_numbered_definition_collisions); called by 1 (write_json_schema_with_return); 1 external calls (get).


##### `strip_v1_client_request_variants_from_json_schema`  (lines 1372–1375)

```
fn strip_v1_client_request_variants_from_json_schema(schema: &mut Value)
```

**Purpose**: Removes selected legacy v1 client-request method variants from a generated `ClientRequest` schema. It keeps JSON exports aligned with the intended v1 surface.

**Data flow**: Builds a `HashSet<&str>` from `V1_CLIENT_REQUEST_METHODS` and passes it to `strip_method_variants_from_json_schema`. It mutates the schema in place.

**Call relations**: Called by `write_json_schema_with_return` only when emitting the `ClientRequest` schema.

*Call graph*: calls 1 internal fn (strip_method_variants_from_json_schema); called by 1 (write_json_schema_with_return).


##### `strip_v1_server_notification_variants_from_json_schema`  (lines 1377–1383)

```
fn strip_v1_server_notification_variants_from_json_schema(schema: &mut Value)
```

**Purpose**: Removes selected server-notification method variants from generated JSON schema output. It excludes methods intentionally omitted from JSON exports.

**Data flow**: Builds a `HashSet<&str>` from `EXCLUDED_SERVER_NOTIFICATION_METHODS_FOR_JSON` and passes it to `strip_method_variants_from_json_schema`. It mutates the schema in place.

**Call relations**: Called by `write_json_schema_with_return` only when emitting the `ServerNotification` schema.

*Call graph*: calls 1 internal fn (strip_method_variants_from_json_schema); called by 1 (write_json_schema_with_return).


##### `strip_method_variants_from_json_schema`  (lines 1385–1403)

```
fn strip_method_variants_from_json_schema(schema: &mut Value, methods_to_remove: &HashSet<&str>)
```

**Purpose**: Removes union variants whose method discriminator is in a removal set, then prunes now-unreachable local definitions. It is the generic variant-stripping helper for generated schemas.

**Data flow**: Mutably accesses the schema root object, retains only `oneOf` variants not matched by `is_method_variant_in_set`, computes reachable local definitions with `reachable_local_definitions`, and then retains only those definitions in the root `definitions` map. It mutates the schema in place.

**Call relations**: Called by both v1-specific stripping helpers. It depends on `is_method_variant_in_set` for variant recognition and `reachable_local_definitions` to clean up orphaned nested definitions.

*Call graph*: calls 1 internal fn (reachable_local_definitions); called by 2 (strip_v1_client_request_variants_from_json_schema, strip_v1_server_notification_variants_from_json_schema); 1 external calls (as_object_mut).


##### `is_method_variant_in_set`  (lines 1405–1419)

```
fn is_method_variant_in_set(value: &Value, methods: &HashSet<&str>) -> bool
```

**Purpose**: Checks whether a schema variant object has a `method` discriminator whose literal value is in a target set. It recognizes the schema shape used for request/notification unions.

**Data flow**: Inspects `value.properties.method`, extracts its literal with `string_literal`, and returns whether that method is contained in `methods`. It is pure.

**Call relations**: Used by `strip_method_variants_from_json_schema` when filtering `oneOf` arrays.

*Call graph*: calls 1 internal fn (string_literal).


##### `reachable_local_definitions`  (lines 1421–1436)

```
fn reachable_local_definitions(schema: &Value, defs_key: &str) -> HashSet<String>
```

**Purpose**: Computes which local definitions in a schema remain reachable from the root after variant pruning. It supports cleanup of nested `definitions` maps.

**Data flow**: Reads the schema’s local definitions map, initializes a queue and reachable set, collects root-level refs excluding nested definition maps, then repeatedly follows refs inside reachable definitions until closure is reached. Returns the set of reachable definition names.

**Call relations**: Called by `strip_method_variants_from_json_schema` to decide which nested definitions to retain.

*Call graph*: calls 2 internal fn (collect_local_definition_refs, collect_local_definition_refs_excluding_maps); called by 1 (strip_method_variants_from_json_schema); 3 external calls (new, get, new).


##### `collect_local_definition_refs_excluding_maps`  (lines 1438–1461)

```
fn collect_local_definition_refs_excluding_maps(
    value: &Value,
    defs_key: &str,
    queue: &mut Vec<String>,
    reachable: &mut HashSet<String>,
)
```

**Purpose**: Collects local-definition refs from a schema tree while skipping traversal into definition containers themselves. This avoids treating all definitions as root-reachable.

**Data flow**: Recurses through objects and arrays, skipping keys equal to the active defs key, `$defs`, or `definitions`, then calls `collect_local_definition_ref_here` on each visited node. It mutates the provided queue and reachable set.

**Call relations**: Called by `reachable_local_definitions` for the initial root traversal.

*Call graph*: calls 1 internal fn (collect_local_definition_ref_here); called by 1 (reachable_local_definitions).


##### `collect_local_definition_refs`  (lines 1463–1483)

```
fn collect_local_definition_refs(
    value: &Value,
    defs_key: &str,
    queue: &mut Vec<String>,
    reachable: &mut HashSet<String>,
)
```

**Purpose**: Collects local-definition refs from a schema subtree, including inside nested structures. It is used when traversing already-reachable definitions.

**Data flow**: Calls `collect_local_definition_ref_here` on the current node, then recurses through all object values and array items. It mutates the provided queue and reachable set.

**Call relations**: Called by `reachable_local_definitions` while expanding the worklist of reachable definitions.

*Call graph*: calls 1 internal fn (collect_local_definition_ref_here); called by 1 (reachable_local_definitions).


##### `collect_local_definition_ref_here`  (lines 1485–1505)

```
fn collect_local_definition_ref_here(
    value: &Value,
    defs_key: &str,
    queue: &mut Vec<String>,
    reachable: &mut HashSet<String>,
)
```

**Purpose**: Examines one schema node for a local `$ref` into the active definitions container and enqueues the referenced definition if newly discovered. It is the primitive ref extractor for reachability analysis.

**Data flow**: Reads `value` as an object, extracts `$ref` as a string, checks for the `#/{defs_key}/` prefix, takes the first path segment after that prefix, and if newly inserted into `reachable` also pushes it onto `queue`. It mutates both collections in place.

**Call relations**: Used by both local-definition ref collectors during reachability analysis.

*Call graph*: called by 2 (collect_local_definition_refs, collect_local_definition_refs_excluding_maps); 2 external calls (as_object, format!).


##### `detect_numbered_definition_collisions`  (lines 1507–1522)

```
fn detect_numbered_definition_collisions(
    schema_name: &str,
    defs_key: &str,
    defs: &Map<String, Value>,
)
```

**Purpose**: Panics if a schema contains both a base definition name and a numbered variant like `Type2`, which would indicate unstable or ambiguous generated naming. It is a defensive invariant check.

**Data flow**: Iterates definition keys, trims trailing ASCII digits from each to compute a base name, and if the trimmed base differs and also exists as a key, panics with a detailed collision message naming the schema and container. It does not mutate state.

**Call relations**: Called by `enforce_numbered_definition_collision_overrides` during per-type schema generation.

*Call graph*: called by 1 (enforce_numbered_definition_collision_overrides); 3 external calls (contains_key, keys, panic!).


##### `write_json_schema`  (lines 1524–1529)

```
fn write_json_schema(out_dir: &Path, name: &str) -> Result<GeneratedSchema>
```

**Purpose**: Thin wrapper around `write_json_schema_with_return` that preserves the public helper name. It emits one schema and returns its `GeneratedSchema` metadata.

**Data flow**: Forwards `out_dir` and `name` to `write_json_schema_with_return::<T>` and returns the resulting `Result<GeneratedSchema>`. It writes the same files as the delegated function.

**Call relations**: Used by `generate_internal_json_schema`; otherwise it simply exposes the lower-level emitter under a shorter name.


##### `write_pretty_json`  (lines 1531–1536)

```
fn write_pretty_json(path: PathBuf, value: &impl Serialize) -> Result<()>
```

**Purpose**: Serializes a value as pretty-printed JSON and writes it to disk with contextualized errors. It is the common JSON file writer for export outputs.

**Data flow**: Takes a target `PathBuf` and any `Serialize` value, converts it to pretty JSON bytes with `serde_json::to_vec_pretty`, writes those bytes to the path with `fs::write`, and returns `Result<()>`. It mutates the filesystem.

**Call relations**: Called by bundle generation, JSON file filtering, and per-type schema emission.

*Call graph*: called by 3 (filter_experimental_json_files, generate_json_with_experimental, write_json_schema_with_return); 2 external calls (write, to_vec_pretty).


##### `split_namespace`  (lines 1539–1542)

```
fn split_namespace(name: &str) -> (Option<&str>, &str)
```

**Purpose**: Splits a fully qualified schema name like `v2::Type` into `(namespace, logical_name)`. Names without `::` are treated as unnamespaced.

**Data flow**: Uses `split_once("::")` on `name` and returns either `(Some(ns), rest)` or `(None, name)`. It is pure.

**Call relations**: Called by `write_json_schema_with_return` to decide output paths and bundle namespace placement.

*Call graph*: called by 1 (write_json_schema_with_return).


##### `rewrite_refs_to_namespace`  (lines 1546–1568)

```
fn rewrite_refs_to_namespace(value: &mut Value, ns: &str)
```

**Purpose**: Recursively rewrites local `#/definitions/...` refs so they point under a specific namespace in the bundled schema. It keeps namespaced schemas internally consistent after insertion.

**Data flow**: Traverses a mutable schema `Value`; when it finds a `$ref` string starting with `#/definitions/`, it prefixes the referenced suffix with `{ns}/` unless already namespaced, then recurses into child values and arrays. It mutates the schema in place.

**Call relations**: Called by `build_schema_bundle` for schemas and nested definitions that belong to a namespace.

*Call graph*: called by 1 (build_schema_bundle); 1 external calls (format!).


##### `rewrite_refs_to_known_namespaces`  (lines 1580–1605)

```
fn rewrite_refs_to_known_namespaces(value: &mut Value, types: &HashMap<String, String>)
```

**Purpose**: Retargets bare root-definition refs to the namespace that actually owns the referenced type, based on a precomputed type-to-namespace map. This fixes shared root helpers that refer to namespaced definitions.

**Data flow**: Traverses a mutable schema `Value`; for each `$ref` under `#/definitions/`, extracts the referenced name and optional tail, looks up the owning namespace with `namespace_for_definition`, and rewrites the ref to `#/definitions/{ns}/{name}{tail}` when a namespace is known. It mutates the schema in place.

**Call relations**: Called by `build_schema_bundle` for unnamespaced schemas so shared root definitions can still point at namespaced v2 leaf types.

*Call graph*: calls 1 internal fn (namespace_for_definition); called by 1 (build_schema_bundle); 2 external calls (new, format!).


##### `collect_namespaced_types`  (lines 1607–1627)

```
fn collect_namespaced_types(schemas: &[GeneratedSchema]) -> HashMap<String, String>
```

**Purpose**: Builds a map from logical type names to the namespace that owns them by inspecting generated schemas and their nested definitions. It informs later `$ref` rewriting decisions.

**Data flow**: Iterates `schemas`, and for each namespaced schema inserts its logical name plus any keys found in nested `definitions` or `$defs` into a `HashMap<String, String>` if not already present. Returns the completed map.

**Call relations**: Called by `build_schema_bundle` before ref rewriting. Its output is consumed by `rewrite_refs_to_known_namespaces` and `namespace_for_definition`.

*Call graph*: called by 1 (build_schema_bundle); 1 external calls (new).


##### `namespace_for_definition`  (lines 1629–1641)

```
fn namespace_for_definition(
    name: &str,
    types: &'a HashMap<String, String>,
) -> Option<&'a String>
```

**Purpose**: Looks up which namespace owns a definition name, falling back from numbered generated names to their unnumbered base. It supports ref rewriting and extracted-definition placement.

**Data flow**: Checks `types.get(name)` first; if absent, trims trailing ASCII digits and checks the trimmed base name when different. Returns `Option<&String>`.

**Call relations**: Used by `build_schema_bundle` and `rewrite_refs_to_known_namespaces` whenever a definition name must be mapped to its namespace.

*Call graph*: called by 2 (build_schema_bundle, rewrite_refs_to_known_namespaces).


##### `variant_definition_name`  (lines 1643–1683)

```
fn variant_definition_name(base: &str, variant: &Value) -> Option<String>
```

**Purpose**: Synthesizes a stable title/name for a schema variant based on discriminator literals or single-property shapes. It gives anonymous union arms deterministic names for downstream tooling.

**Data flow**: Inspects a variant schema’s `properties` and `required` arrays, prefers literals from `method` or `type`, otherwise derives from a sole property key, converts the chosen token to PascalCase, and appends a suffix based on the base union type (`Request`, `Notification`, `EventMsg`, etc.). Returns `Option<String>`.

**Call relations**: Called by `annotate_variant_list` when a variant lacks an explicit title. It depends on `literal_from_property`, `string_literal`, and `to_pascal_case`.

*Call graph*: calls 2 internal fn (literal_from_property, to_pascal_case); called by 1 (annotate_variant_list); 2 external calls (get, format!).


##### `literal_from_property`  (lines 1685–1687)

```
fn literal_from_property(props: &'a Map<String, Value>, key: &str) -> Option<&'a str>
```

**Purpose**: Extracts a string literal discriminator from a named property schema. It is a tiny convenience wrapper around `string_literal`.

**Data flow**: Looks up `props[key]` and passes the value to `string_literal`, returning `Option<&str>`. It is pure.

**Call relations**: Used by `variant_definition_name` and `variant_title_collision_key` when inspecting discriminator properties.

*Call graph*: called by 2 (variant_definition_name, variant_title_collision_key); 1 external calls (get).


##### `string_literal`  (lines 1689–1697)

```
fn string_literal(value: &Value) -> Option<&str>
```

**Purpose**: Extracts a string literal from a schema encoded either as `const: "..."` or as a one-element `enum`. It normalizes the two common discriminator encodings.

**Data flow**: Reads `value["const"]` as a string if present, otherwise reads the first string element of `value["enum"]`. Returns `Option<&str>` without mutation.

**Call relations**: Used by method-variant detection, discriminator-title generation, and variant naming/collision diagnostics.

*Call graph*: called by 3 (is_method_variant_in_set, set_discriminator_titles, variant_title_collision_key); 1 external calls (get).


##### `annotate_schema`  (lines 1699–1709)

```
fn annotate_schema(value: &mut Value, base: Option<&str>)
```

**Purpose**: Recursively annotates a schema tree with generated titles for variants and discriminator properties. It improves downstream code generation and schema readability.

**Data flow**: Matches on `Value`; for objects it delegates to `annotate_object`, for arrays it recurses into each item, and scalars are ignored. It mutates the schema in place.

**Call relations**: Called during per-type schema generation and bundle assembly, and recursively by `annotate_object` and `annotate_variant_list`.

*Call graph*: calls 1 internal fn (annotate_object); called by 4 (annotate_object, annotate_variant_list, build_schema_bundle, write_json_schema_with_return).


##### `annotate_object`  (lines 1711–1764)

```
fn annotate_object(map: &mut Map<String, Value>, base: Option<&str>)
```

**Purpose**: Annotates one schema object by setting discriminator-property titles, naming variants in `oneOf`/`anyOf`, and recursing through nested schema-bearing fields. It is the object-specific worker for schema annotation.

**Data flow**: Reads the object’s `title` to title discriminator properties in `properties`, annotates `oneOf` and `anyOf` arrays via `annotate_variant_list`, recurses into nested `definitions`, `$defs`, `properties`, `items`, `additionalProperties`, and all other child values except those already handled. It mutates the object in place.

**Call relations**: Called by `annotate_schema`. It delegates variant naming to `annotate_variant_list` and discriminator-property titling to `set_discriminator_titles`.

*Call graph*: calls 3 internal fn (annotate_schema, annotate_variant_list, set_discriminator_titles); called by 1 (annotate_schema); 3 external calls (get, get_mut, iter_mut).


##### `annotate_variant_list`  (lines 1766–1805)

```
fn annotate_variant_list(variants: &mut [Value], base: Option<&str>)
```

**Purpose**: Ensures each schema variant in a union has a stable title and titled discriminator properties, while detecting generated-name collisions. It is central to producing deterministic union schemas.

**Data flow**: Scans existing variant titles into a `HashSet`, then for each variant either keeps its title or generates one from `variant_definition_name`, panicking on collisions detected via `variant_title_collision_key`, inserts the generated title into the variant object, titles discriminator properties if present, and recursively annotates the variant schema. It mutates the variant list in place.

**Call relations**: Called by `annotate_object` for both `oneOf` and `anyOf` arrays. It depends on `variant_title`, `variant_definition_name`, `variant_title_collision_key`, `set_discriminator_titles`, and `annotate_schema`.

*Call graph*: calls 5 internal fn (annotate_schema, set_discriminator_titles, variant_definition_name, variant_title, variant_title_collision_key); called by 1 (annotate_object); 5 external calls (new, String, iter, iter_mut, panic!).


##### `variant_title_collision_key`  (lines 1807–1847)

```
fn variant_title_collision_key(base: &str, generated_name: &str, variant: &Value) -> String
```

**Purpose**: Builds a detailed diagnostic string describing the shape of a variant whose generated title collides with another. It makes panic messages actionable when naming heuristics are ambiguous.

**Data flow**: Starts with `base` and `generated` fields, then inspects discriminator literals and other literal-valued properties, sole-property shapes, and single required keys to append identifying fragments; if nothing descriptive is found, includes the full variant JSON. Returns the assembled `String`.

**Call relations**: Called by `annotate_variant_list` only when a generated variant title would collide with an existing one.

*Call graph*: calls 2 internal fn (literal_from_property, string_literal); called by 1 (annotate_variant_list); 3 external calls (get, format!, vec!).


##### `set_discriminator_titles`  (lines 1851–1864)

```
fn set_discriminator_titles(props: &mut Map<String, Value>, owner: &str)
```

**Purpose**: Adds `title` fields to discriminator property schemas like `method`, `type`, or `status` when they have string literals and no title yet. This improves generated model names for downstream tools.

**Data flow**: Iterates the fixed `DISCRIMINATOR_KEYS`, and for each matching property whose schema has a string literal and lacks `title`, inserts `"{owner}{PascalKey}"` into that property object. It mutates the properties map in place.

**Call relations**: Called by `annotate_object` and `annotate_variant_list` after determining the owning schema or variant name.

*Call graph*: calls 2 internal fn (string_literal, to_pascal_case); called by 2 (annotate_object, annotate_variant_list); 3 external calls (get_mut, String, format!).


##### `variant_title`  (lines 1866–1871)

```
fn variant_title(value: &Value) -> Option<&str>
```

**Purpose**: Returns the explicit `title` of a schema variant if present. It is a small accessor used during annotation.

**Data flow**: Reads the value as an object and then `obj["title"]` as a string, returning `Option<&str>`. It is pure.

**Call relations**: Used by `annotate_variant_list` to preserve existing titles and seed the collision-detection set.

*Call graph*: called by 1 (annotate_variant_list); 1 external calls (as_object).


##### `to_pascal_case`  (lines 1873–1892)

```
fn to_pascal_case(input: &str) -> String
```

**Purpose**: Converts strings with underscores or hyphens into PascalCase. It is used to derive schema and discriminator titles from method/type literals.

**Data flow**: Iterates input characters, uppercasing the next character after `_` or `-` separators and otherwise appending characters as-is. Returns the transformed `String`.

**Call relations**: Used by `variant_definition_name` and `set_discriminator_titles` when synthesizing stable schema titles.

*Call graph*: called by 2 (set_discriminator_titles, variant_definition_name); 1 external calls (new).


##### `ensure_dir`  (lines 1894–1897)

```
fn ensure_dir(dir: &Path) -> Result<()>
```

**Purpose**: Creates an output directory tree with contextualized errors. It is the common directory-preparation helper for export routines.

**Data flow**: Calls `fs::create_dir_all(dir)` and returns `Result<()>`, adding the directory path to any error message. It mutates the filesystem by creating directories as needed.

**Call relations**: Called by TS generation, JSON generation, internal schema generation, and per-type schema emission before writing files.

*Call graph*: called by 4 (generate_internal_json_schema, generate_json_with_experimental, generate_ts_with_options, write_json_schema_with_return); 1 external calls (create_dir_all).


##### `rewrite_named_ref_to_namespace`  (lines 1899–1924)

```
fn rewrite_named_ref_to_namespace(value: &mut Value, ns: &str, name: &str)
```

**Purpose**: Rewrites refs to one specific definition name so they point into a target namespace, preserving any trailing JSON Pointer path. It fixes extracted-definition refs after bundle placement decisions are made.

**Data flow**: Traverses a mutable schema `Value`; when it finds a `$ref` equal to `#/definitions/{name}` or prefixed by that path plus `/`, it rewrites it to `#/definitions/{ns}/{name}` with the same suffix, then recurses into child values and arrays. It mutates the tree in place.

**Call relations**: Called by `build_schema_bundle` for definitions that were extracted from one schema but ultimately inserted into a namespace different from the containing schema.

*Call graph*: called by 1 (build_schema_bundle); 1 external calls (format!).


##### `prepend_header_if_missing`  (lines 1926–1946)

```
fn prepend_header_if_missing(path: &Path) -> Result<()>
```

**Purpose**: Ensures a generated TypeScript file begins with the standard generated-code header comment. It avoids duplicating the header when already present.

**Data flow**: Opens `path`, reads the full file into a string, returns early if it already starts with `GENERATED_TS_HEADER`, otherwise recreates the file and writes the header followed by the original content. Returns `Result<()>` and mutates the file on disk.

**Call relations**: Called in parallel worker threads by `generate_ts_with_options` when `ensure_headers` is enabled.

*Call graph*: 3 external calls (new, create, open).


##### `ts_files_in`  (lines 1948–1961)

```
fn ts_files_in(dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Lists `.ts` files directly inside one directory, sorted by path. It is used for index generation.

**Data flow**: Reads directory entries from `dir`, collects paths that are files with extension `ts`, sorts the vector, and returns it. It does not recurse.

**Call relations**: Called by `generate_index_ts` to gather root-level and `v2`-level TypeScript files for re-export generation.

*Call graph*: called by 1 (generate_index_ts); 3 external calls (new, new, read_dir).


##### `ts_files_in_recursive`  (lines 1963–1981)

```
fn ts_files_in_recursive(dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Recursively enumerates all `.ts` files under a directory tree, sorted by path. It supports header insertion, whitespace cleanup, and field filtering.

**Data flow**: Uses a directory stack starting at `dir`, pushes subdirectories, collects file paths whose extension is `ts`, sorts the final vector, and returns it. It does not mutate files.

**Call relations**: Called by `generate_ts_with_options` and `filter_experimental_type_fields_ts`.

*Call graph*: called by 2 (filter_experimental_type_fields_ts, generate_ts_with_options); 4 external calls (new, new, read_dir, vec!).


##### `trim_trailing_whitespace_in_ts_files`  (lines 1983–1994)

```
fn trim_trailing_whitespace_in_ts_files(paths: &[PathBuf]) -> Result<()>
```

**Purpose**: Normalizes generated TypeScript files by removing trailing spaces and tabs from each line. It is a final cleanup pass after generation and optional formatting.

**Data flow**: For each path in `paths`, reads the file content, computes a trimmed version with `trim_trailing_line_whitespace`, and rewrites the file only if the content changed. Returns `Result<()>` and mutates files as needed.

**Call relations**: Called by `generate_ts_with_options` after header insertion and optional Prettier execution.

*Call graph*: calls 1 internal fn (trim_trailing_line_whitespace); called by 1 (generate_ts_with_options); 2 external calls (read_to_string, write).


##### `trim_trailing_line_whitespace`  (lines 1996–2007)

```
fn trim_trailing_line_whitespace(content: &str) -> String
```

**Purpose**: Removes trailing spaces and tabs from every line of a string while preserving newline structure. It is the pure text transformer behind TS whitespace cleanup.

**Data flow**: Allocates an output string with the input capacity, iterates lines using `split_inclusive('\n')`, trims trailing spaces/tabs from each line body, preserves newline characters, and returns the cleaned `String`.

**Call relations**: Used by `trim_trailing_whitespace_in_ts_files` and by test fixture generation helpers.

*Call graph*: called by 2 (trim_trailing_whitespace_in_ts_files, generate_typescript_schema_fixture_subtree_for_tests); 1 external calls (with_capacity).


##### `generate_index_ts`  (lines 2011–2028)

```
fn generate_index_ts(out_dir: &Path) -> Result<PathBuf>
```

**Purpose**: Writes an `index.ts` file that re-exports all generated root-level types and optionally the `v2` namespace. It gives consumers a single import surface.

**Data flow**: Collects root `.ts` files and checks whether `out_dir/v2` contains any non-index TS files, builds export lines with `index_ts_entries`, prepends the generated header with `generated_index_ts_with_header`, writes the result to `out_dir/index.ts`, and returns the index path.

**Call relations**: Called by `generate_ts_with_options` for both the root output directory and the `v2` subdirectory.

*Call graph*: calls 3 internal fn (generated_index_ts_with_header, index_ts_entries, ts_files_in); called by 1 (generate_ts_with_options); 2 external calls (join, create).


##### `generate_index_ts_tree`  (lines 2030–2061)

```
fn generate_index_ts_tree(tree: &mut BTreeMap<PathBuf, String>)
```

**Purpose**: Generates `index.ts` entries inside an in-memory TypeScript fixture tree rather than on disk. It mirrors `generate_index_ts` for tests.

**Data flow**: Scans `tree` keys to collect root-level entries and detect whether `v2` contains TS files, inserts a root `index.ts` entry built by `index_ts_entries`, then collects `v2` entries and inserts `v2/index.ts` when applicable. It mutates the `BTreeMap<PathBuf, String>` in place.

**Call relations**: Called by `generate_typescript_schema_fixture_subtree_for_tests` during fixture assembly.

*Call graph*: calls 1 internal fn (index_ts_entries); called by 1 (generate_typescript_schema_fixture_subtree_for_tests); 1 external calls (from).


##### `generated_index_ts_with_header`  (lines 2063–2068)

```
fn generated_index_ts_with_header(content: String) -> String
```

**Purpose**: Prepends the standard generated-code header to already-built index content. It is a tiny helper for index file emission.

**Data flow**: Allocates a string large enough for the header plus content, appends `GENERATED_TS_HEADER`, then appends `content`, and returns the combined `String`.

**Call relations**: Called by `generate_index_ts` before writing the on-disk index file.

*Call graph*: called by 1 (generate_index_ts); 1 external calls (with_capacity).


##### `index_ts_entries`  (lines 2070–2091)

```
fn index_ts_entries(paths: &[&Path], has_v2_ts: bool) -> String
```

**Purpose**: Builds the body of an `index.ts` file by emitting sorted `export type { Name } from "./Name";` lines for generated TS files, excluding `index` and `EventMsg`, and optionally adding a `v2` namespace export. It is the pure formatter behind index generation.

**Data flow**: Takes a slice of paths and a `has_v2_ts` flag, extracts unique file stems for `.ts` files excluding `index` and `EventMsg`, sorts and deduplicates them, formats one export line per stem, and appends `export * as v2 from "./v2";` when requested. Returns the assembled `String`.

**Call relations**: Used by both `generate_index_ts` and `generate_index_ts_tree`.

*Call graph*: called by 2 (generate_index_ts, generate_index_ts_tree); 3 external calls (iter, new, format!).


##### `tests::generated_ts_optional_nullable_fields_only_in_params`  (lines 2107–2327)

```
fn generated_ts_optional_nullable_fields_only_in_params() -> Result<()>
```

**Purpose**: Validates the checked-in TypeScript fixture tree for several stable-export invariants, especially that optional nullable fields (`?: T | null`) appear only in approved parameter-like types and that experimental entries are absent. It is a broad regression test over generated TS output.

**Data flow**: Loads the vendored TypeScript fixture subtree, inspects specific files and tree membership for expected inclusions/exclusions, then scans every `.ts` file for `| undefined` and disallowed `?: ... | null` patterns using custom line/segment parsing logic, collecting offenders and asserting both offender sets are empty. It reads fixture files but does not mutate them.

**Call relations**: This test exercises the end-to-end effects of TS generation and filtering indirectly through checked-in fixtures. It depends on `schema_root` and `read_schema_fixture_subtree` rather than calling generation functions directly.

*Call graph*: calls 1 internal fn (read_schema_fixture_subtree); 9 external calls (new, new, new, schema_root, assert!, assert_eq!, format!, matches!, from_utf8).


##### `tests::schema_root`  (lines 2329–2338)

```
fn schema_root() -> Result<PathBuf>
```

**Purpose**: Resolves the root directory of vendored schema fixtures from a known fixture file path. It is a small test helper for locating checked-in schema assets.

**Data flow**: Uses `find_resource!` to locate `schema/typescript/index.ts`, walks up two parent directories, and returns the resulting `PathBuf`. It returns an error if resource resolution or parent derivation fails.

**Call relations**: Called by `generated_ts_optional_nullable_fields_only_in_params` to locate the fixture tree.

*Call graph*: 1 external calls (find_resource!).


##### `tests::generate_ts_with_experimental_api_retains_experimental_entries`  (lines 2341–2369)

```
fn generate_ts_with_experimental_api_retains_experimental_entries() -> Result<()>
```

**Purpose**: Checks that raw TS export paths still include experimental methods and fields when experimental filtering is not applied. It verifies the positive case opposite the stable-export tests.

**Data flow**: Calls `export_to_string()` on `ClientRequest`, `v2::MockExperimentalMethodParams`, `v2::MockExperimentalMethodResponse`, `v2::ThreadStartParams`, and `v2::CommandExecutionRequestApprovalParams`, then asserts that experimental method names and field names are present in the generated strings. It performs no filesystem writes.

**Call relations**: This test validates the unfiltered generation behavior that precedes `filter_experimental_ts` in stable exports.

*Call graph*: 4 external calls (export_to_string, export_to_string, export_to_string, assert_eq!).


##### `tests::stable_schema_filter_removes_mock_thread_start_field`  (lines 2372–2395)

```
fn stable_schema_filter_removes_mock_thread_start_field() -> Result<()>
```

**Purpose**: Verifies that bundle-level experimental schema filtering removes a known experimental field from `ThreadStartParams`. It is a focused regression test for field pruning in JSON bundles.

**Data flow**: Creates a temp output dir, emits a schema for `v2::ThreadStartParams`, builds a bundle from that single schema, applies `filter_experimental_schema`, locates the matching definition, inspects its `properties`, and asserts `mockExperimentalField` is absent. It cleans up the temp directory afterward.

**Call relations**: This test directly exercises `build_schema_bundle` plus `filter_experimental_schema` on a minimal input.

*Call graph*: calls 2 internal fn (build_schema_bundle, filter_experimental_schema); 6 external calls (assert_eq!, format!, create_dir, remove_dir_all, temp_dir, vec!).


##### `tests::build_schema_bundle_rewrites_root_helper_refs_to_namespaced_defs`  (lines 2398–2477)

```
fn build_schema_bundle_rewrites_root_helper_refs_to_namespaced_defs() -> Result<()>
```

**Purpose**: Checks that `build_schema_bundle` rewrites refs inside unnamespaced helper schemas so they point at namespaced v2 definitions when appropriate. It protects against dangling root refs in mixed bundles.

**Data flow**: Constructs several synthetic `GeneratedSchema` values in memory, including an unnamespaced helper with refs to `ThreadId`, `MessagePhase`, and `UserInput`, builds a bundle, and asserts the resulting `$ref` strings point to `#/definitions/v2/...` where expected while preserving local helper refs. It mutates only local test data.

**Call relations**: This test targets the `rewrite_refs_to_known_namespaces` path inside `build_schema_bundle`.

*Call graph*: calls 1 internal fn (build_schema_bundle); 2 external calls (assert_eq!, vec!).


##### `tests::build_flat_v2_schema_keeps_shared_root_schemas_and_dependencies`  (lines 2480–2656)

```
fn build_flat_v2_schema_keeps_shared_root_schemas_and_dependencies() -> Result<()>
```

**Purpose**: Verifies that flat-v2 bundle generation preserves shared root unions and pulls in their non-v2 dependencies while removing the nested `v2` namespace. It protects the downstream-codegen compatibility path.

**Data flow**: Builds a synthetic mixed bundle JSON value, calls `build_flat_v2_schema`, inspects the resulting title, definitions membership, retained union variant titles, and absence of `#/definitions/v2/` refs, and asserts all expected shared and dependent definitions remain present. It uses only in-memory values.

**Call relations**: This test directly exercises `build_flat_v2_schema` and its dependency-collection/ref-rewrite logic.

*Call graph*: calls 1 internal fn (build_flat_v2_schema); 2 external calls (assert_eq!, json!).


##### `tests::experimental_type_fields_ts_filter_handles_interface_shape`  (lines 2659–2694)

```
fn experimental_type_fields_ts_filter_handles_interface_shape() -> Result<()>
```

**Purpose**: Checks that TS field filtering can remove an experimental property from an `export interface` declaration, not just type aliases. It covers one parser shape handled by `type_body_brace_span`.

**Data flow**: Creates a temp directory and writes `CustomParams.ts` containing an interface with stable and unstable fields, defines a synthetic `ExperimentalField`, runs `filter_experimental_type_fields_ts`, reads the file back, and asserts the unstable field is gone while stable fields remain. It cleans up via a drop guard.

**Call relations**: This test directly exercises `filter_experimental_type_fields_ts` and the interface branch of `filter_experimental_type_fields_ts_contents`.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts); 6 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, temp_dir).


##### `tests::experimental_type_fields_ts_filter_keeps_imports_used_in_intersection_suffix`  (lines 2697–2738)

```
fn experimental_type_fields_ts_filter_keeps_imports_used_in_intersection_suffix() -> Result<()>
```

**Purpose**: Checks that TS field filtering does not over-prune imports still referenced outside the main object body, such as in an intersection suffix. It protects a subtle import-usage-scope edge case.

**Data flow**: Writes a temp `Config.ts` containing imports and a type alias with an object body intersected with another type expression, removes one experimental field via `filter_experimental_type_fields_ts`, then asserts the unstable field is gone but both `JsonValue` and `Keep` imports remain. It mutates only temp files.

**Call relations**: This test targets the `import_usage_scope` logic in `filter_experimental_type_fields_ts_contents` and `prune_unused_type_imports`.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts); 6 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, temp_dir).


##### `tests::experimental_type_fields_ts_filter_handles_generated_command_params_shape`  (lines 2741–2803)

```
fn experimental_type_fields_ts_filter_handles_generated_command_params_shape() -> Result<()>
```

**Purpose**: Checks that TS field filtering handles generated command-params formatting with embedded comments and preserves unrelated imports. It covers a realistic generated-file shape.

**Data flow**: Writes a temp `CommandExecParams.ts` file containing commented fields and imports, defines `permissionProfile` as experimental, runs `filter_experimental_type_fields_ts`, reads the file back, and asserts the target field is removed while `sandboxPolicy` and its import remain. It uses temp files only.

**Call relations**: This test exercises comment stripping and property parsing in `filter_experimental_type_fields_ts_contents`.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts); 6 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, temp_dir).


##### `tests::stable_schema_filter_removes_mock_experimental_method`  (lines 2806–2818)

```
fn stable_schema_filter_removes_mock_experimental_method() -> Result<()>
```

**Purpose**: Verifies that bundle-level experimental filtering removes a known experimental client method from `ClientRequest`. It is a focused regression test for method pruning.

**Data flow**: Creates a temp directory, emits a `ClientRequest` schema, builds a bundle, applies `filter_experimental_schema`, serializes the bundle to a string, and asserts the experimental method name is absent. It removes the temp directory afterward.

**Call relations**: This test directly exercises `build_schema_bundle` plus `filter_experimental_schema` on a request-union schema.

*Call graph*: calls 2 internal fn (build_schema_bundle, filter_experimental_schema); 7 external calls (assert_eq!, format!, create_dir, remove_dir_all, to_string, temp_dir, vec!).


##### `tests::generate_json_filters_experimental_fields_and_methods`  (lines 2821–2959)

```
fn generate_json_filters_experimental_fields_and_methods() -> Result<()>
```

**Purpose**: Runs end-to-end stable JSON generation and asserts that experimental fields, methods, and dependent type files are absent from both individual schemas and bundled outputs. It is the broad regression test for stable JSON export.

**Data flow**: Creates a temp output dir, calls `generate_json_with_experimental(..., false)`, reads multiple generated files and bundles, checks for absence of experimental strings and files, validates flat-v2 bundle title and lack of namespaced refs, inspects retained `ClientRequest` and `ServerNotification` method sets, and cleans up the temp directory. It performs real filesystem generation and reads.

**Call relations**: This test exercises the full stable JSON pipeline, including per-type emission, bundle building, experimental filtering, flat-v2 generation, and file deletion.

*Call graph*: calls 2 internal fn (generate_json_with_experimental, read_json_value); 6 external calls (assert_eq!, format!, create_dir, read_to_string, remove_dir_all, temp_dir).


##### `tests::generate_json_includes_remote_control_methods_with_experimental_api`  (lines 2962–2987)

```
fn generate_json_includes_remote_control_methods_with_experimental_api() -> Result<()>
```

**Purpose**: Verifies that enabling experimental API generation retains remote-control methods and their schema files. It is the positive counterpart to stable JSON filtering tests.

**Data flow**: Creates a temp output dir, calls `generate_json_with_experimental(..., true)`, reads `ClientRequest.json`, asserts remote-control method names are present, and checks that the corresponding v2 schema files exist. It removes the temp directory afterward.

**Call relations**: This test directly exercises the experimental-enabled branch of `generate_json_with_experimental`, confirming that filtering is skipped.

*Call graph*: calls 1 internal fn (generate_json_with_experimental); 6 external calls (assert!, format!, create_dir, read_to_string, remove_dir_all, temp_dir).


### `app-server-protocol/src/schema_fixtures.rs`

`util` · `schema generation, fixture comparison, and test support`

This file supports schema fixture testing and regeneration. At the top level, `read_schema_fixture_tree` and `read_schema_fixture_subtree` load vendored fixture files from `schema/typescript` and `schema/json`, returning a `BTreeMap<PathBuf, Vec<u8>>` keyed by relative path for deterministic comparison. File reads are normalized by `read_file_bytes`: JSON files are parsed, recursively canonicalized, and pretty-serialized so object key order and many schema-array orderings become stable across platforms; TypeScript files have CRLF normalized and the standard generated banner stripped so fixture diffs focus on schema content rather than boilerplate.

Generation flows split in two. `generate_typescript_schema_fixture_subtree_for_tests` exports the root request/notification types plus all visited response dependencies into an in-memory tree, filters experimental files, synthesizes `index.ts`, and trims trailing whitespace. `write_schema_fixtures_with_options` is the destructive on-disk regeneration path: it empties `schema/typescript` and `schema/json`, then invokes the crate’s TypeScript and JSON generators with an `experimental_api` option.

The TypeScript dependency traversal is implemented by `collect_typescript_fixture_file`, `visit_typescript_fixture_dependencies`, and `TypeScriptFixtureCollector`. They use `ts_rs::TS` metadata (`output_path`, `export_to_string`, `visit_dependencies`) plus a `HashSet<TypeId>` to avoid duplicate exports and recursively collect every referenced type exactly once. Tests at the bottom pin the JSON canonicalization behavior for sortable arrays.

#### Function details

##### `read_schema_fixture_tree`  (lines 29–42)

```
fn read_schema_fixture_tree(schema_root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Reads both vendored schema subtrees (`typescript` and `json`) under a schema root and merges them into one relative-path map.

**Data flow**: Takes `schema_root`, derives `typescript_root` and `json_root` with `join`, recursively collects files from each subtree, prefixes each relative path with its top-level label, and inserts the normalized bytes into a `BTreeMap`. It returns the combined map.

**Call relations**: This is the broadest fixture reader in the file, delegating all traversal and normalization to `collect_files_recursive` and `read_file_bytes`.

*Call graph*: calls 1 internal fn (collect_files_recursive); 3 external calls (new, join, from).


##### `read_schema_fixture_subtree`  (lines 44–51)

```
fn read_schema_fixture_subtree(
    schema_root: &Path,
    label: &str,
) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Reads one labeled fixture subtree such as `typescript` or `json` and annotates traversal failures with the subtree path.

**Data flow**: Accepts a schema root and subtree label, joins them into `subtree_root`, calls `collect_files_recursive`, and returns the resulting `BTreeMap<PathBuf, Vec<u8>>`. Errors are wrapped with contextual text naming the subtree.

**Call relations**: Tests call this helper when they want to compare one fixture family at a time rather than the whole tree.

*Call graph*: calls 1 internal fn (collect_files_recursive); called by 1 (generated_ts_optional_nullable_fields_only_in_params); 1 external calls (join).


##### `generate_typescript_schema_fixture_subtree_for_tests`  (lines 54–80)

```
fn generate_typescript_schema_fixture_subtree_for_tests() -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Builds an in-memory TypeScript fixture tree matching the vendored TypeScript schema layout used by tests.

**Data flow**: Initializes mutable `files` and `seen` collections, exports the root request/notification types and traverses response-type dependencies via `visit_typescript_fixture_dependencies`, then filters experimental files, generates an index tree, trims trailing whitespace in every file, and converts the `String` contents into UTF-8 byte vectors. It returns a deterministic `BTreeMap<PathBuf, Vec<u8>>`.

**Call relations**: This is the test-side generator counterpart to on-disk schema generation. It orchestrates repeated calls into `collect_typescript_fixture_file` through the visitor helpers, then post-processes the tree for fixture comparison.

*Call graph*: calls 4 internal fn (filter_experimental_ts_tree, generate_index_ts_tree, trim_trailing_line_whitespace, visit_typescript_fixture_dependencies); 2 external calls (new, new).


##### `write_schema_fixtures`  (lines 86–88)

```
fn write_schema_fixtures(schema_root: &Path, prettier: Option<&Path>) -> Result<()>
```

**Purpose**: Regenerates vendored schema fixtures on disk using default options.

**Data flow**: Receives the schema root and optional prettier path, constructs default `SchemaFixtureOptions`, and forwards all work to `write_schema_fixtures_with_options`. It returns that result unchanged.

**Call relations**: This is the simple tooling entrypoint used when callers do not need to toggle experimental schema emission.

*Call graph*: calls 1 internal fn (write_schema_fixtures_with_options); 1 external calls (default).


##### `write_schema_fixtures_with_options`  (lines 91–113)

```
fn write_schema_fixtures_with_options(
    schema_root: &Path,
    prettier: Option<&Path>,
    options: SchemaFixtureOptions,
) -> Result<()>
```

**Purpose**: Deletes and rewrites the vendored TypeScript and JSON schema fixture directories with configurable experimental API inclusion.

**Data flow**: Computes `typescript_out_dir` and `json_out_dir`, empties both via `ensure_empty_dir`, then invokes crate-level TypeScript generation with `GenerateTsOptions { experimental_api, ..default }` and JSON generation with the same experimental flag. It returns `Ok(())` only after both outputs are regenerated.

**Call relations**: Tooling reaches this function either directly or through `write_schema_fixtures`; it coordinates directory setup and delegates actual schema emission to crate-level generators.

*Call graph*: calls 2 internal fn (default, ensure_empty_dir); called by 1 (write_schema_fixtures); 3 external calls (join, generate_json_with_experimental, generate_ts_with_options).


##### `ensure_empty_dir`  (lines 115–122)

```
fn ensure_empty_dir(dir: &Path) -> Result<()>
```

**Purpose**: Recreates a directory from scratch so schema regeneration cannot leave stale files behind.

**Data flow**: Checks whether `dir` exists; if so, removes it recursively, then creates the directory tree anew. It returns unit on success and wraps filesystem failures with path-specific context.

**Call relations**: This helper is called by `write_schema_fixtures_with_options` before writing fresh TypeScript and JSON outputs.

*Call graph*: called by 1 (write_schema_fixtures_with_options); 3 external calls (exists, create_dir_all, remove_dir_all).


##### `read_file_bytes`  (lines 124–150)

```
fn read_file_bytes(path: &Path) -> Result<Vec<u8>>
```

**Purpose**: Reads one fixture file and normalizes its contents according to file type so comparisons are stable across platforms and generators.

**Data flow**: Reads raw bytes from `path`. For `.json`, it parses into `serde_json::Value`, canonicalizes recursively, and pretty-serializes back to bytes; for `.ts`, it decodes UTF-8, normalizes line endings to `\n`, strips the standard generated header if present, and returns the resulting bytes; all other files are returned unchanged.

**Call relations**: Directory traversal delegates every file through this function, making it the normalization choke point for fixture comparisons.

*Call graph*: calls 1 internal fn (canonicalize_json); called by 1 (collect_files_recursive); 5 external calls (extension, from_utf8, from_slice, to_vec_pretty, read).


##### `canonicalize_json`  (lines 152–208)

```
fn canonicalize_json(value: &Value) -> Value
```

**Purpose**: Recursively rewrites JSON values into a deterministic form by sorting object keys and sorting only those arrays whose elements all admit a safe stable sort key.

**Data flow**: Matches on the input `Value`. Arrays are first canonicalized element-wise; if every element yields a key from `schema_array_item_sort_key`, the function sorts by that key and then by serialized JSON as a tiebreaker, otherwise it preserves original order. Objects are rebuilt with lexicographically sorted keys and recursively canonicalized children. Scalars are cloned unchanged.

**Call relations**: This function is used only by `read_file_bytes` for JSON fixture normalization. Its selective array sorting is a deliberate design choice to avoid changing semantics for order-sensitive arrays.

*Call graph*: calls 1 internal fn (schema_array_item_sort_key); called by 1 (read_file_bytes); 6 external calls (with_capacity, Array, Object, clone, with_capacity, to_string).


##### `schema_array_item_sort_key`  (lines 210–227)

```
fn schema_array_item_sort_key(item: &Value) -> Option<String>
```

**Purpose**: Determines whether a JSON array element can participate in stable schema-array sorting and, if so, produces the comparison key.

**Data flow**: Inspects one `Value`: nulls, booleans, numbers, and strings get prefixed scalar keys; objects get keys only if they contain a string `$ref` or `title`; arrays and unkeyed objects return `None`. The returned `Option<String>` tells callers whether sorting is safe.

**Call relations**: `canonicalize_json` calls this for every array element and aborts sorting for the whole array if any element lacks a key.

*Call graph*: called by 1 (canonicalize_json); 1 external calls (format!).


##### `collect_files_recursive`  (lines 229–268)

```
fn collect_files_recursive(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Walks a directory tree, following symlink targets via metadata, and returns normalized file contents keyed by paths relative to the traversal root.

**Data flow**: Starts with a stack containing `root`, repeatedly pops directories, reads entries, stats each path with `metadata`, pushes subdirectories back onto the stack, skips non-files, strips the root prefix from file paths, and inserts `read_file_bytes(path)` into a `BTreeMap`. It returns the full map after traversal completes.

**Call relations**: Both fixture-reading entrypoints delegate to this walker. It centralizes recursive traversal while relying on `read_file_bytes` for per-file normalization.

*Call graph*: calls 1 internal fn (read_file_bytes); called by 2 (read_schema_fixture_subtree, read_schema_fixture_tree); 4 external calls (new, metadata, read_dir, vec!).


##### `collect_typescript_fixture_file`  (lines 270–299)

```
fn collect_typescript_fixture_file(
    files: &mut BTreeMap<PathBuf, String>,
    seen: &mut HashSet<TypeId>,
) -> Result<()>
```

**Purpose**: Exports one `ts_rs::TS` type into the fixture tree exactly once and recursively visits its TypeScript dependencies.

**Data flow**: Given mutable `files` and `seen`, it asks `T::output_path()` for a destination and returns early if absent or already seen by `TypeId`. Otherwise it exports the type to a string, normalizes the relative path, normalizes line endings, inserts the file content, then constructs a `TypeScriptFixtureCollector` and invokes `T::visit_dependencies`. Any visitor error is propagated.

**Call relations**: This is the core recursive export primitive used directly by the test generator and indirectly by the dependency visitor implementation.

*Call graph*: calls 1 internal fn (normalize_relative_fixture_path); 3 external calls (export_to_string, output_path, visit_dependencies).


##### `normalize_relative_fixture_path`  (lines 301–303)

```
fn normalize_relative_fixture_path(path: &Path) -> PathBuf
```

**Purpose**: Normalizes a relative fixture path by rebuilding it from its path components.

**Data flow**: Takes a `Path`, iterates its components, collects them into a new `PathBuf`, and returns that normalized path. No filesystem access occurs.

**Call relations**: `collect_typescript_fixture_file` uses this before inserting exported TypeScript content into the fixture map.

*Call graph*: called by 1 (collect_typescript_fixture_file); 1 external calls (components).


##### `visit_typescript_fixture_dependencies`  (lines 305–320)

```
fn visit_typescript_fixture_dependencies(
    files: &mut BTreeMap<PathBuf, String>,
    seen: &mut HashSet<TypeId>,
    visit: impl FnOnce(&mut TypeScriptFixtureCollector<'_>),
) -> Result<()>
```

**Purpose**: Runs an arbitrary dependency visitation closure against a `TypeScriptFixtureCollector` and converts any deferred visitor error into a returned `Result`.

**Data flow**: Builds a `TypeScriptFixtureCollector` over the shared `files` and `seen` sets, invokes the supplied closure with it, then checks `visitor.error` and returns either that error or success. It does not itself export types except through the visitor callback.

**Call relations**: The TypeScript test generator uses this helper to traverse response-type sets exposed by `visit_client_response_types` and `visit_server_response_types`.

*Call graph*: called by 1 (generate_typescript_schema_fixture_subtree_for_tests).


##### `TypeScriptFixtureCollector::visit`  (lines 329–334)

```
fn visit(&mut self)
```

**Purpose**: Implements `ts_rs::TypeVisitor` by exporting each visited dependency type into the fixture tree unless a prior error has already occurred.

**Data flow**: On each visited `T`, it first checks whether `self.error` is already set; if not, it calls `collect_typescript_fixture_file::<T>` and stores any resulting error into `self.error`. It returns unit and mutates the collector’s shared maps and error slot.

**Call relations**: This method is invoked by `TS::visit_dependencies` and by the explicit dependency-walking closures, making it the adapter between ts-rs traversal and fixture collection.


##### `tests::canonicalize_json_sorts_string_arrays`  (lines 343–347)

```
fn canonicalize_json_sorts_string_arrays()
```

**Purpose**: Verifies that `canonicalize_json` sorts arrays of plain strings into deterministic order.

**Data flow**: Constructs an unsorted JSON string array and an expected sorted array, calls `canonicalize_json`, and asserts equality. It writes no persistent state.

**Call relations**: This unit test guards one of the intended normalization behaviors used during fixture comparison.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::canonicalize_json_sorts_schema_ref_arrays`  (lines 350–360)

```
fn canonicalize_json_sorts_schema_ref_arrays()
```

**Purpose**: Verifies that `canonicalize_json` sorts arrays of schema objects by `$ref` value.

**Data flow**: Builds a JSON array containing two `$ref` objects in reverse order, canonicalizes it, and asserts that the result matches the expected sorted array. No external state is touched.

**Call relations**: This test specifically covers the object-key path in `schema_array_item_sort_key`, ensuring schema reference arrays compare stably.

*Call graph*: 2 external calls (assert_eq!, json!).


### Transport and server contract glue
This final group captures the transport-layer message contracts, remote-control transport protocol, server error shaping, and downstream adapters that consume the app-server schemas.

### `app-server-transport/src/lib.rs`

`orchestration` · `startup`

This crate root is a façade over two internal modules: `outgoing_message` and `transport`. It does not implement transport behavior itself; instead, it selects which internal types and functions are part of the crate’s stable external interface. From `outgoing_message`, it re-exports identifiers and queueable response/error message types such as `ConnectionId`, `OutgoingMessage`, `OutgoingResponse`, `OutgoingError`, and `QueuedOutgoingMessage`. From `transport`, it re-exports the main runtime driver `AppServerTransport`, startup coordination via `AppServerStartupLock` and `acquire_app_server_startup_lock`, parse and policy errors, connection-origin metadata, remote-control configuration and availability types, event types, environment-variable helpers, socket-path helpers, and startup functions for stdio, websocket, and control-socket acceptors. This organization makes the crate consumable from a single import path while hiding the internal module layout. The file’s main design role is boundary definition: it tells readers which transport concepts are intended for use by other crates and which startup/remote-control entry points are officially exposed. Because all behavior is delegated to the submodules, this file is active wherever transport functionality is imported, especially during server startup and connection establishment.


### `app-server-transport/src/outgoing_message.rs`

`data_model` · `cross-cutting during outbound message routing and writing`

This file is a compact data-model module for outbound transport traffic. `ConnectionId` is a thin `u64` newtype used as a stable identifier for a live transport connection; it derives equality, hashing, and copy semantics so it can be stored in maps and attached to events. Its `Display` implementation prints the raw numeric id, which is useful in logs and diagnostics.

The main payload type is `OutgoingMessage`, an untagged serializable enum that can carry a `ServerRequest`, an app-server-specific `ServerNotification`, a successful `OutgoingResponse`, or an `OutgoingError`. The response and error structs preserve the JSON-RPC request id and either a protocol `Result` or `JSONRPCErrorError`. `QueuedOutgoingMessage` wraps an `OutgoingMessage` together with an optional `tokio::sync::oneshot::Sender<()>` used by writers to signal that a particular message has been fully written. That completion channel is intentionally optional so most messages can be queued without extra synchronization overhead. The file contains almost no behavior beyond formatting and construction; its importance is in standardizing the exact shape of outbound messages shared across stdio, websocket, unix-socket, and remote-control transports.

#### Function details

##### `ConnectionId::fmt`  (lines 16–18)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats a connection id as its underlying decimal integer. This keeps logs and user-facing diagnostics concise and stable.

**Data flow**: Borrows `self` and a formatter, writes `self.0` into the formatter with `write!`, and returns the formatting result.

**Call relations**: Used implicitly anywhere `ConnectionId` is formatted, especially in transport logging and diagnostics.

*Call graph*: 1 external calls (write!).


##### `QueuedOutgoingMessage::new`  (lines 52–57)

```
fn new(message: OutgoingMessage) -> Self
```

**Purpose**: Constructs a queued outbound message with no write-completion notifier attached. It is the default constructor used by most transport code paths.

**Data flow**: Consumes an `OutgoingMessage` and returns `QueuedOutgoingMessage { message, write_complete_tx: None }`.

**Call relations**: Called by multiple transport and test paths whenever a message is enqueued without needing an acknowledgment that the writer flushed it.

*Call graph*: called by 8 (enqueue_incoming_message, shutdown_cancels_blocked_outbound_forwarding, remote_control_http_mode_enrolls_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages, enqueue_incoming_request_does_not_block_when_writer_queue_is_full, broadcast_does_not_block_on_slow_connection, to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full).


### `app-server-transport/src/transport/remote_control/protocol.rs`

`data_model` · `cross-cutting; used whenever remote-control URLs or wire payloads are constructed or parsed`

This file is the schema layer for remote control. It declares the request/response structs used for enrollment, refresh, pairing start, and pairing status, plus the websocket envelope types exchanged between backend and app-server. `ClientId` and `StreamId` are transparent string wrappers used to key virtual remote clients and per-stream sequencing; `StreamId::new_random` generates a UUID v7 string for new outbound streams.

The websocket protocol distinguishes `ClientEvent` values coming from the backend (`ClientMessage`, chunked message fragments, acknowledgements, ping, close) from `ServerEvent` values sent back (`ServerMessage`, chunked server message fragments, ack, pong). `ClientEnvelope` and `ServerEnvelope` carry those events together with `client_id`, optional or required `stream_id`, sequence cursoring, and reconnect metadata. `ServerEvent::segment_id` exposes the chunk index only for `ServerMessageChunk`, which lets reconnect/ack logic reason about partially acknowledged segmented payloads.

The other major responsibility is URL validation and derivation. `normalize_remote_control_base_url` parses the configured base URL, ensures the path ends with `/`, and enforces a strict host/scheme policy: HTTPS for `chatgpt.com`, `chatgpt-staging.com`, and their subdomains; HTTP or HTTPS only for localhost/loopback. `normalize_remote_control_url` then derives the concrete enroll, refresh, pair, pair-status, and websocket endpoints under `wham/remote/control/server`, switching the websocket scheme to `wss` for HTTPS bases and `ws` for HTTP localhost. The tests lock in accepted ChatGPT and localhost forms and reject lookalike or insecure external hosts.

#### Function details

##### `RemoteControlPairingStatusRequest::from`  (lines 71–82)

```
fn from(code: RemoteControlPairingStatusCode) -> Self
```

**Purpose**: Converts the internal pairing-status code enum into the serialized request body expected by the backend.

**Data flow**: Consumes a `RemoteControlPairingStatusCode` and returns `RemoteControlPairingStatusRequest` with exactly one of `pairing_code` or `manual_pairing_code` populated and the other set to `None`.

**Call relations**: Used by pairing-status orchestration after parameter validation has already ensured only one code type is present.


##### `StreamId::new_random`  (lines 99–101)

```
fn new_random() -> Self
```

**Purpose**: Creates a fresh stream identifier using a time-ordered UUID v7.

**Data flow**: Calls `uuid::Uuid::now_v7()`, converts it to a string, wraps it in `StreamId`, and returns it.

**Call relations**: Used when the transport needs a new per-stream identifier for outbound server envelopes.

*Call graph*: 1 external calls (now_v7).


##### `ServerEvent::segment_id`  (lines 172–177)

```
fn segment_id(&self) -> Option<usize>
```

**Purpose**: Extracts the chunk index from a segmented server event and returns `None` for non-chunk events.

**Data flow**: Pattern-matches `self`; returns `Some(segment_id)` for `ServerMessageChunk` and `None` for `ServerMessage`, `Ack`, and `Pong`.

**Call relations**: Supports buffering and acknowledgement logic that only cares about chunked payloads.


##### `is_allowed_remote_control_chatgpt_host`  (lines 193–201)

```
fn is_allowed_remote_control_chatgpt_host(host: &Option<Host<&str>>) -> bool
```

**Purpose**: Checks whether a parsed URL host is exactly `chatgpt.com` / `chatgpt-staging.com` or one of their subdomains.

**Data flow**: Reads `Option<Host<&str>>`, returns `false` for non-domain hosts, and otherwise compares the domain string against the allowed exact names and suffixes.

**Call relations**: Used by base-URL normalization to enforce the production/staging host allowlist.

*Call graph*: called by 1 (normalize_remote_control_base_url).


##### `is_localhost`  (lines 203–210)

```
fn is_localhost(host: &Option<Host<&str>>) -> bool
```

**Purpose**: Recognizes localhost and loopback IPv4/IPv6 hosts.

**Data flow**: Matches the parsed host and returns `true` for domain `localhost` or loopback IP addresses; otherwise `false`.

**Call relations**: Used by base-URL normalization to permit local development URLs over HTTP or HTTPS.

*Call graph*: called by 1 (normalize_remote_control_base_url).


##### `normalize_remote_control_url`  (lines 212–258)

```
fn normalize_remote_control_url(
    remote_control_url: &str,
) -> io::Result<RemoteControlTarget>
```

**Purpose**: Validates a configured remote-control base URL and derives all concrete backend endpoint URLs from it.

**Data flow**: Calls `normalize_remote_control_base_url` to parse and validate the base URL, then joins fixed relative paths for enroll, refresh, pair, pair-status, and websocket endpoints. It rewrites the websocket URL scheme to `wss` when the base scheme is HTTPS and `ws` otherwise, and returns a populated `RemoteControlTarget` or an `InvalidInput` `io::Error` if parsing/joining fails.

**Call relations**: Called throughout enrollment, persistence, startup, and tests whenever the subsystem needs canonical endpoint URLs.

*Call graph*: calls 1 internal fn (normalize_remote_control_base_url); called by 33 (load_or_enroll_server, persist_preference, enable, resolve_persisted_preference, clearing_persisted_remote_control_enrollment_removes_only_matching_entry, enroll_remote_control_server_parse_failure_includes_response_body, persisted_remote_control_enrollment_round_trips_by_target_and_account, remote_control_enrollment_refreshes_server_token_before_expiry, normalize_remote_control_url_rejects_unsupported_urls, start_remote_control (+15 more)).


##### `normalize_remote_control_base_url`  (lines 260–290)

```
fn normalize_remote_control_base_url(remote_control_url: &str) -> io::Result<Url>
```

**Purpose**: Parses and validates the configured remote-control base URL against strict scheme and host rules.

**Data flow**: Parses the input string into `Url`, appends a trailing slash to the path if missing, inspects the host, and accepts only `https` for allowed ChatGPT/staging hosts or `http`/`https` for localhost. On failure it returns `InvalidInput` with a message describing the accepted URL classes.

**Call relations**: Used directly by environment-client URL construction elsewhere and indirectly by `normalize_remote_control_url`.

*Call graph*: calls 2 internal fn (is_allowed_remote_control_chatgpt_host, is_localhost); called by 2 (environment_clients_url, normalize_remote_control_url); 2 external calls (parse, format!).


##### `tests::normalize_remote_control_url_accepts_chatgpt_https_urls`  (lines 298–337)

```
fn normalize_remote_control_url_accepts_chatgpt_https_urls()
```

**Purpose**: Verifies that production and staging ChatGPT HTTPS base URLs normalize into the expected endpoint set.

**Data flow**: Calls `normalize_remote_control_url` on representative ChatGPT and staging URLs and asserts the returned `RemoteControlTarget` contains the exact expected `wss` websocket URL and HTTPS REST endpoints.

**Call relations**: Locks in accepted production/staging URL forms.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_remote_control_url_accepts_localhost_urls`  (lines 340–376)

```
fn normalize_remote_control_url_accepts_localhost_urls()
```

**Purpose**: Verifies that localhost HTTP and HTTPS URLs are accepted and normalized correctly.

**Data flow**: Normalizes localhost URLs and asserts the resulting target uses `ws` for HTTP localhost and `wss` for HTTPS localhost, with the expected REST endpoint paths.

**Call relations**: Covers the local-development branch of URL validation.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_remote_control_url_rejects_unsupported_urls`  (lines 379–400)

```
fn normalize_remote_control_url_rejects_unsupported_urls()
```

**Purpose**: Ensures insecure or lookalike hosts are rejected with the documented validation error.

**Data flow**: Iterates over unsupported URLs, calls `normalize_remote_control_url`, asserts each call fails with `ErrorKind::InvalidInput`, and checks the exact error message.

**Call relations**: Protects the host/scheme allowlist from accidental broadening.

*Call graph*: calls 1 internal fn (normalize_remote_control_url); 1 external calls (assert_eq!).


### `app-server/src/error_code.rs`

`util` · `cross-cutting error response construction`

This file is a compact utility module for JSON-RPC error construction. It declares numeric constants for the standard JSON-RPC codes used by the server—invalid request (`-32600`), method not found (`-32601`), invalid params (`-32602`), internal error (`-32603`)—plus an overloaded server code (`-32001`) and a string constant for the special `input_too_large` condition. The constants are public or crate-public depending on whether other crates need direct access.

The four exported constructor functions are thin wrappers around a single private `error` helper. Each wrapper fixes the numeric code and accepts any message convertible into `String`, returning a `codex_app_server_protocol::JSONRPCErrorError` with `data: None`. This keeps call sites terse and avoids repeated struct literals throughout request handlers, transport code, and bespoke error mapping.

There is intentionally no branching or logging here: the module’s only job is to standardize protocol payload shape. Because many unrelated subsystems call these helpers, this file acts as a cross-cutting vocabulary layer between internal failures and externally visible JSON-RPC responses.

#### Function details

##### `invalid_request`  (lines 10–12)

```
fn invalid_request(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error object for malformed requests using code `-32600`. It is the standard constructor for request-shape or protocol-state violations.

**Data flow**: Accepts any message convertible into `String`, forwards it with `INVALID_REQUEST_ERROR_CODE` to `error`, and returns the resulting `JSONRPCErrorError`.

**Call relations**: Widely used by request dispatch and transport code whenever the incoming request itself is invalid or cannot be processed in the current protocol state.

*Call graph*: calls 1 internal fn (error); called by 38 (handle_thread_rollback_failed, send_control, start, command_no_longer_running_error, handle_process_write, watch, dispatch_initialized_client_request, config_write_error, map_fs_error, load_plugin_share_config_and_auth (+15 more)).


##### `method_not_found`  (lines 14–16)

```
fn method_not_found(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error object for unknown or unsupported methods using code `-32601`. It standardizes the response for unrecognized RPC method names.

**Data flow**: Accepts a message, passes it with `METHOD_NOT_FOUND_ERROR_CODE` to `error`, and returns the constructed `JSONRPCErrorError`.

**Call relations**: Used by handlers that reject unsupported operations or unknown method names.

*Call graph*: calls 1 internal fn (error); called by 3 (thread_turns_items_list, core_thread_write_error, unsupported_thread_store_operation).


##### `invalid_params`  (lines 18–20)

```
fn invalid_params(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error object for parameter validation failures using code `-32602`. It is used when the method exists but the supplied arguments are malformed or semantically invalid.

**Data flow**: Accepts a message, forwards it with `INVALID_PARAMS_ERROR_CODE` to `error`, and returns the resulting error object.

**Call relations**: Called by parameter-parsing and validation code such as process/terminal request handlers.

*Call graph*: calls 1 internal fn (error); called by 5 (write, terminal_size_from_protocol, write_stdin, process_spawn, terminal_size_from_protocol).


##### `internal_error`  (lines 22–24)

```
fn internal_error(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error object for server-side failures using code `-32603`. It is the generic fallback for unexpected internal problems.

**Data flow**: Accepts a message, forwards it with `INTERNAL_ERROR_CODE` to `error`, and returns the resulting `JSONRPCErrorError`.

**Call relations**: Used broadly across server orchestration and request handling when internal operations fail after a request has already been accepted.

*Call graph*: calls 1 internal fn (error); called by 21 (apply_bespoke_event_handling, start, start_uninitialized, send_response_as, abort_pending_server_requests, cancel_requests_for_thread_cancels_all_thread_requests, notify_client_error_forwards_error_to_waiter, send_error_routes_to_target_connection, map_error, map_fs_error (+11 more)).


##### `error`  (lines 26–32)

```
fn error(code: i64, message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Private helper that constructs the actual `JSONRPCErrorError` struct from a code and message. It ensures all exported constructors produce the same `data: None` shape.

**Data flow**: Consumes an `i64` code and message convertible into `String`, converts the message, and returns `JSONRPCErrorError { code, message, data: None }`.

**Call relations**: Called by all four public constructor helpers in this module.

*Call graph*: called by 4 (internal_error, invalid_params, invalid_request, method_not_found); 1 external calls (into).


### `mcp-server/src/outgoing_message.rs`

`io_transport` · `cross-cutting`

This file is the outbound transport abstraction for the MCP server. `OutgoingMessageSender` wraps an unbounded Tokio sender plus two pieces of state: an `AtomicI64` used to allocate monotonically increasing numeric request ids for server-originated requests, and a mutex-protected `HashMap<RequestId, oneshot::Sender<Value>>` that stores the callback channel waiting for each client response. That callback map is what lets features like approval elicitation send a request to the client and later resume when `process_response` delivers the matching result.

The sender exposes four main operations. `send_request` allocates an id, stores a oneshot sender in the callback map, enqueues an `OutgoingMessage::Request`, and returns the receiver. `notify_client_response` removes the callback entry and forwards the raw JSON result into the waiting oneshot, warning if the id is unknown or the receiver has gone away. `send_response` serializes any `Serialize` payload into JSON and falls back to `send_error` with `internal_error` if serialization fails. `send_event_as_notification` converts a Codex `Event` into a `codex/event` notification, optionally wrapping it in `OutgoingNotificationParams` so `_meta.requestId` and `_meta.threadId` can be attached for MCP multiplexing.

The file also defines the internal `OutgoingMessage` enum and the `From<OutgoingMessage> for OutgoingJsonRpcMessage` conversion that flattens custom RMCP request/notification wrappers into standard JSON-RPC wire messages. Tests verify both flattening behavior and the exact notification payload shape with and without `_meta`.

#### Function details

##### `OutgoingMessageSender::new`  (lines 34–40)

```
fn new(sender: mpsc::UnboundedSender<OutgoingMessage>) -> Self
```

**Purpose**: Creates a fresh outbound sender with request-id allocation and an empty callback registry. It is the constructor used by the main processor task.

**Data flow**: It takes an `mpsc::UnboundedSender<OutgoingMessage>`, initializes `next_request_id` to zero, stores the sender, creates an empty `HashMap<RequestId, oneshot::Sender<Value>>` inside a Tokio `Mutex`, and returns `OutgoingMessageSender`.

**Call relations**: It is called from `run_main` before constructing `MessageProcessor`, and also from tests that exercise outbound behavior in isolation. All later send/notify methods operate on the state initialized here.

*Call graph*: 3 external calls (new, new, new).


##### `OutgoingMessageSender::send_request`  (lines 42–62)

```
async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> oneshot::Receiver<Value>
```

**Purpose**: Sends a server-originated JSON-RPC request to the client and returns a oneshot receiver for the eventual response payload. It is the core primitive used for elicitation flows.

**Data flow**: Inputs are a method string and optional JSON params. It atomically allocates a numeric `RequestId`, creates a oneshot channel, inserts the sender half into `request_id_to_callback` under that id, constructs `OutgoingMessage::Request(OutgoingRequest { id, method, params })`, sends it on the unbounded channel, and returns the receiver half. If the channel send fails, the receiver is still returned but will never be fulfilled unless some other path injects a response.

**Call relations**: It is used by approval modules such as `handle_exec_approval_request` and `handle_patch_approval_request` to ask the client for approval. The matching response later flows back through `notify_client_response`.

*Call graph*: 5 external calls (fetch_add, send, Number, Request, channel).


##### `OutgoingMessageSender::notify_client_response`  (lines 64–80)

```
async fn notify_client_response(&self, id: RequestId, result: Value)
```

**Purpose**: Matches an inbound client response to the callback registered for that request id and delivers the raw JSON result. It also cleans up the callback map entry.

**Data flow**: It takes a `RequestId` and `Value`, locks `request_id_to_callback`, removes the entry for that id, and if found sends the result into the stored oneshot sender. If the send fails because the receiver was dropped, or if no entry exists, it emits a warning. It returns unit.

**Call relations**: It is called by `MessageProcessor::process_response` whenever the client sends a JSON-RPC response. Its successful path wakes tasks spawned by code that previously called `send_request`.

*Call graph*: 1 external calls (warn!).


##### `OutgoingMessageSender::send_response`  (lines 82–97)

```
async fn send_response(&self, id: RequestId, response: T)
```

**Purpose**: Serializes a typed response payload and enqueues it as a JSON-RPC success response. Serialization failures are converted into JSON-RPC internal errors for the same request id.

**Data flow**: Inputs are a request id and any `T: Serialize`. It attempts `serde_json::to_value(response)`; on success it wraps the result in `OutgoingMessage::Response(OutgoingResponse { id, result })` and sends it on the channel. On serialization failure it calls `send_error` with `ErrorData::internal_error(format!(...))` and returns unit.

**Call relations**: It is used throughout request handlers such as initialization, ping, tool listing, and tool-call error paths. Its fallback to `send_error` ensures malformed response payloads still produce a protocol-level reply.

*Call graph*: calls 1 internal fn (send_error); 5 external calls (internal_error, send, Response, format!, to_value).


##### `OutgoingMessageSender::send_event_as_notification`  (lines 102–125)

```
async fn send_event_as_notification(
        &self,
        event: &Event,
        meta: Option<OutgoingNotificationMeta>,
    )
```

**Purpose**: Converts a Codex protocol `Event` into a `codex/event` MCP notification, optionally attaching `_meta` fields for request and thread correlation. It preserves the raw event payload when wrapper serialization fails.

**Data flow**: Inputs are an `Event` reference and optional `OutgoingNotificationMeta`. It serializes the event to JSON, then tries to serialize `OutgoingNotificationParams { meta, event: event_json.clone() }`; if that wrapper fails it warns and falls back to the plain event JSON. It then calls `send_notification` with method `codex/event` and the chosen params. It returns unit.

**Call relations**: It is called by session-running code that streams Codex events back to the MCP client. Internally it delegates the actual enqueueing to `send_notification`.

*Call graph*: calls 1 internal fn (send_notification); 2 external calls (to_value, warn!).


##### `OutgoingMessageSender::send_notification`  (lines 127–130)

```
async fn send_notification(&self, notification: OutgoingNotification)
```

**Purpose**: Enqueues an outbound JSON-RPC notification without expecting any response. It is the low-level notification primitive.

**Data flow**: It takes an `OutgoingNotification`, wraps it in `OutgoingMessage::Notification`, sends it on the unbounded channel, and returns unit. Channel send failure is ignored.

**Call relations**: It is called directly by `send_event_as_notification` and could be used by other server code needing fire-and-forget notifications. The stdout writer later converts the queued message into wire JSON.

*Call graph*: called by 1 (send_event_as_notification); 2 external calls (send, Notification).


##### `OutgoingMessageSender::send_error`  (lines 132–135)

```
async fn send_error(&self, id: RequestId, error: ErrorData)
```

**Purpose**: Enqueues a JSON-RPC error response for a specific request id. It is the low-level error primitive used across the server.

**Data flow**: Inputs are a request id and `ErrorData`. It wraps them in `OutgoingMessage::Error(OutgoingError { id, error })`, sends that enum value on the unbounded channel, and returns unit. Channel send failure is ignored.

**Call relations**: It is called directly by handlers that need to reject requests and indirectly by `send_response` when response serialization fails. The queued error is later converted to `JsonRpcMessage::Error` by `OutgoingJsonRpcMessage::from`.

*Call graph*: called by 1 (send_response); 2 external calls (send, Error).


##### `OutgoingJsonRpcMessage::from`  (lines 147–176)

```
fn from(val: OutgoingMessage) -> Self
```

**Purpose**: Transforms the server’s internal outbound message enum into the flattened RMCP JSON-RPC wire representation. It is the final structural conversion before serialization to stdout.

**Data flow**: It consumes an `OutgoingMessage` and pattern-matches each variant. Requests become `JsonRpcMessage::Request(JsonRpcRequest { jsonrpc: 2.0, id, request: CustomRequest::new(method, params) })`; notifications become `JsonRpcMessage::Notification(JsonRpcNotification { ... CustomNotification::new(...) })`; responses become `JsonRpcMessage::Response(JsonRpcResponse { ... })`; errors become `JsonRpcMessage::Error(JsonRpcError { id: Some(id), error, ... })`. It returns the constructed `OutgoingJsonRpcMessage`.

**Call relations**: It is used by the stdout writer task in `run_main` when draining the outgoing channel. This conversion is what ensures internal request/notification structs flatten into standard JSON-RPC `method`/`params` fields on the wire.

*Call graph*: 6 external calls (new, new, Error, Notification, Request, Response).


##### `tests::outgoing_request_serializes_as_jsonrpc_request`  (lines 248–267)

```
fn outgoing_request_serializes_as_jsonrpc_request()
```

**Purpose**: Checks that an internal outbound request converts into a flattened JSON-RPC request object with top-level `method` and `params`. It guards against RMCP wrapper fields leaking into serialized output.

**Data flow**: It constructs an `OutgoingMessage::Request`, converts it into `OutgoingJsonRpcMessage`, serializes to `serde_json::Value`, inspects the resulting object, and asserts the expected `jsonrpc`, `id`, `method`, and `params` fields are present while `request` is absent.

**Call relations**: This unit test validates the `From<OutgoingMessage>` implementation used by the stdout writer. It specifically covers the request branch.

*Call graph*: 6 external calls (Number, Request, assert!, assert_eq!, json!, to_value).


##### `tests::outgoing_notification_serializes_as_jsonrpc_notification`  (lines 270–287)

```
fn outgoing_notification_serializes_as_jsonrpc_notification()
```

**Purpose**: Checks that an internal outbound notification serializes as a flattened JSON-RPC notification. It also verifies that absent params become JSON null and no nested `notification` field remains.

**Data flow**: It builds an `OutgoingMessage::Notification`, converts and serializes it, then asserts the top-level `jsonrpc`, `method`, and `params` values and the absence of a `notification` wrapper field.

**Call relations**: This test complements `tests::outgoing_request_serializes_as_jsonrpc_request` by covering the notification branch of `OutgoingJsonRpcMessage::from`.

*Call graph*: 4 external calls (Notification, assert!, assert_eq!, to_value).


##### `tests::test_send_event_as_notification`  (lines 290–335)

```
async fn test_send_event_as_notification() -> Result<()>
```

**Purpose**: Verifies that sending an event notification without metadata emits a `codex/event` notification whose params are exactly the serialized event object. It confirms the no-meta fast path.

**Data flow**: It creates an unbounded channel and `OutgoingMessageSender`, constructs a realistic `Event::SessionConfigured` payload, calls `send_event_as_notification(&event, None)`, receives the queued `OutgoingMessage`, pattern-matches it as a notification, and compares its method and params against the expected serialized event JSON.

**Call relations**: This test exercises `OutgoingMessageSender::send_event_as_notification` and indirectly `send_notification`. It validates the branch where no `_meta` wrapper is attached.

*Call graph*: calls 4 internal fn (new, read_only, new, new); 7 external calls (new, assert_eq!, test_path_buf, panic!, default, SessionConfigured, to_value).


##### `tests::test_send_event_as_notification_with_meta`  (lines 338–403)

```
async fn test_send_event_as_notification_with_meta() -> Result<()>
```

**Purpose**: Verifies that event notifications with metadata include an `_meta` object containing `requestId` while preserving the event payload fields. It checks the wrapper serialization path.

**Data flow**: It sets up a sender and channel, constructs a `SessionConfigured` event plus `OutgoingNotificationMeta { request_id: Some(...), thread_id: None }`, sends the event, receives the queued notification, and asserts the params JSON matches the expected object with `_meta.requestId` and the flattened event body.

**Call relations**: This test covers the metadata branch of `send_event_as_notification`. It ensures MCP-specific correlation data is inserted in the shape expected by clients.

*Call graph*: calls 4 internal fn (new, read_only, new, new); 8 external calls (new, String, assert_eq!, test_path_buf, json!, panic!, default, SessionConfigured).


##### `tests::test_send_event_as_notification_with_meta_and_thread_id`  (lines 406–472)

```
async fn test_send_event_as_notification_with_meta_and_thread_id() -> Result<()>
```

**Purpose**: Verifies that event notifications can carry both `requestId` and `threadId` in `_meta`. It protects the multiplexing metadata used when multiple Codex threads share one MCP connection.

**Data flow**: It constructs a sender, event, and `OutgoingNotificationMeta` containing both a string request id and a `ThreadId`, sends the event, receives the queued notification, and asserts the params JSON includes `_meta.requestId`, `_meta.threadId`, and the expected event body.

**Call relations**: This test extends the previous metadata test to the full correlation case. It validates the exact serialized shape consumed by clients that need thread-aware event routing.

*Call graph*: calls 4 internal fn (new, read_only, new, new); 8 external calls (new, String, assert_eq!, test_path_buf, json!, panic!, default, SessionConfigured).


### `tui/src/app_server_approval_conversions.rs`

`util` · `request handling`

This file contains two small but important translation functions used around approval UX. `granted_permission_profile_from_request` converts the core/native `codex_protocol::request_permissions::RequestPermissionProfile` into the app-server-facing `GrantedPermissionProfile`, preserving optional network permissions and converting file-system permissions through the protocol's `Into` implementation. `file_update_changes_to_display` converts a vector of app-server `FileUpdateChange` records into the TUI's `HashMap<PathBuf, FileChange>` display model, mapping each `PatchChangeKind` variant to the corresponding `FileChange::{Add,Delete,Update}` shape and keying by the changed path.

The tests are concrete and reveal intended invariants. They verify that add diffs become `FileChange::Add`, that request-permission payloads with legacy `read`/`write` lists are canonicalized into `entries` in the granted profile, and that already-canonical `entries` survive unchanged. The local `absolute_path` helper exists only to build valid `AbsolutePathBuf` fixtures for those tests.

Overall, this module is intentionally narrow: it does not own approval logic, only the exact shape conversions needed where the TUI diverges from raw app-server types or needs a richer display-oriented file-change map.

#### Function details

##### `granted_permission_profile_from_request`  (lines 17–26)

```
fn granted_permission_profile_from_request(
    value: CoreRequestPermissionProfile,
) -> GrantedPermissionProfile
```

**Purpose**: Transforms a core request-permissions profile into the app-server's granted-permissions payload shape.

**Data flow**: It takes a `CoreRequestPermissionProfile` by value. It reads `value.network` and, when present, maps it into `AdditionalNetworkPermissions { enabled: network.enabled }`. It reads `value.file_system` and converts it with `Into::into`. It returns a new `GrantedPermissionProfile` and writes no external state.

**Call relations**: This helper is used when formatting requested-permissions rules for outbound submission/display. It isolates the protocol boundary so callers can work with the core-native request type and only convert at the app-server edge.

*Call graph*: called by 1 (format_requested_permissions_rule).


##### `file_update_changes_to_display`  (lines 28–50)

```
fn file_update_changes_to_display(
    changes: Vec<FileUpdateChange>,
) -> HashMap<PathBuf, FileChange>
```

**Purpose**: Converts app-server file-update change records into the TUI's per-path diff display model.

**Data flow**: It consumes `Vec<FileUpdateChange>`, iterates through each change, converts `change.path` into a `PathBuf`, pattern-matches `change.kind`, and builds a `FileChange::Add`, `FileChange::Delete`, or `FileChange::Update { unified_diff, move_path }` using `change.diff` and any move target. It collects the `(PathBuf, FileChange)` pairs into a `HashMap<PathBuf, FileChange>` and returns it.

**Call relations**: This function serves approval and diff-rendering code that needs a display-friendly map keyed by path rather than raw protocol records. It performs the one-time normalization before UI rendering.


##### `tests::absolute_path`  (lines 73–75)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Builds an `AbsolutePathBuf` test fixture from a string path and fails the test if the path is not absolute.

**Data flow**: It takes `&str`, converts it to `PathBuf`, then calls `AbsolutePathBuf::try_from(...)`. On success it returns the absolute path wrapper; on failure it panics via `expect`.

**Call relations**: This helper is only used inside the module's tests to keep fixture construction concise and to guarantee valid absolute-path inputs for permission-profile assertions.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (from).


##### `tests::converts_file_update_changes_to_display`  (lines 78–92)

```
fn converts_file_update_changes_to_display()
```

**Purpose**: Verifies that an app-server add-change becomes the expected `FileChange::Add` entry in the display map.

**Data flow**: It constructs a one-element `Vec<FileUpdateChange>`, passes it to `file_update_changes_to_display`, and compares the returned `HashMap<PathBuf, FileChange>` against an expected literal with `assert_eq!`.

**Call relations**: This test exercises the add-path branch of `file_update_changes_to_display` and documents the intended path-keyed output shape.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::converts_request_permissions_into_granted_permissions`  (lines 95–137)

```
fn converts_request_permissions_into_granted_permissions()
```

**Purpose**: Checks that legacy-style request permissions with separate read/write lists are converted into a granted profile with canonical sandbox entries.

**Data flow**: It builds an app-server `RequestPermissionProfile` containing network and file-system permissions, converts it into the core request type with `try_from`, passes that to `granted_permission_profile_from_request`, and asserts that the result contains the expected network flag plus synthesized `entries` for read and write paths.

**Call relations**: This test documents that the conversion preserves semantics while canonicalizing file-system permissions into the app-server's granted-profile representation.

*Call graph*: 3 external calls (try_from, assert_eq!, vec!).


##### `tests::converts_request_permissions_into_canonical_granted_permissions`  (lines 140–175)

```
fn converts_request_permissions_into_canonical_granted_permissions()
```

**Purpose**: Verifies that already-canonical file-system permission entries remain unchanged when converted into a granted profile.

**Data flow**: It constructs a `RequestPermissionProfile` whose file-system permissions are expressed directly as `entries`, converts it to the core request type, feeds it to `granted_permission_profile_from_request`, and asserts equality with the expected `GrantedPermissionProfile`.

**Call relations**: This test covers the non-legacy path of the conversion and ensures the helper does not rewrite or lose canonical sandbox entries.

*Call graph*: 3 external calls (try_from, assert_eq!, vec!).
