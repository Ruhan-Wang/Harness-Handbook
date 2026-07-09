# App-server protocol schemas and transport contracts  `stage-18.2`

This stage is the shared rulebook for how the app server and its clients talk. It sits behind the main work loop: before any feature can send a request, reply, warning, file update, or command output, both sides need to agree on the exact message shape. The JSON-RPC files define the basic envelope, like an addressed letter with a request, response, notification, or error inside. The common, v1, and v2 protocol files define the actual “forms” that go in those envelopes: startup, login, threads, turns, items, reviews, realtime sessions, accounts, models, apps, permissions, config, plugins, hooks, feedback, files, processes, MCP, remote control, and more. Helper and mapper files smooth over format details and keep older v1 command requests working with v2. The export and fixture tools turn Rust types into TypeScript and JSON Schema so other clients can use the same contract and detect accidental changes. Transport files describe outgoing messages, remote-control websocket rules, and JSON-RPC errors. Small bridge files translate approvals and MCP messages into the shapes other parts of the system expect.

## Files in this stage

### Protocol facade and wire foundations
These files establish the crate-level entry points and the shared JSON-RPC and protocol scaffolding that all versioned schemas build on.

### `app-server-protocol/src/jsonrpc_lite.rs`

`data_model` · `request handling and protocol serialization`

This file is the protocol “envelope” for app-server messages. JSON-RPC is a common way for one program to call methods in another program using JSON text, but this project uses a lighter version: it does not require the usual "jsonrpc": "2.0" field, even though it keeps a JSONRPC_VERSION constant for that version string.

The main idea is simple: every incoming or outgoing message is one of four shapes. A request asks for something and includes an id so the answer can be matched back to the question. A notification announces something but does not expect an answer. A successful response carries the matching id and a result. An error response carries the matching id plus an error code, message, and optional extra data.

The RequestId type matters because different clients may identify requests with either strings or numbers. This file accepts both, like a coat-check ticket that may be labeled “42” or “abc-123” but still points to one request. The structures also support automatic JSON conversion, JSON schema generation, and TypeScript type generation, so Rust, JSON, and frontend code can agree on the same message format. Requests may also include W3C trace context, which is tracing information used to follow one operation across several services.

#### Function details

##### `RequestId::fmt`  (lines 24–29)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This function turns a request id into readable text. It lets code print or log a RequestId the same way whether the id was originally a string or a number.

**Data flow**: It receives a RequestId and a formatter, which is Rust’s destination for display text. If the id is a string, it writes that string directly. If the id is an integer, it converts the number to text while writing it. The result is either successful formatted output or a formatting error from the underlying writer.

**Call relations**: This is used whenever RequestId is displayed through Rust’s standard formatting system, such as in logs, error messages, or string interpolation. Inside the function, string ids are handed to the formatter’s write_str method, while integer ids are handed to Rust’s write! formatting macro so both forms become plain text.

*Call graph*: 2 external calls (write_str, write!).


### `app-server-protocol/src/lib.rs`

`other` · `cross-cutting: used whenever other code imports protocol types or schema/export helpers`

This file does not implement protocol behavior itself. Instead, it acts like a reception desk for the crate: callers import from this one place, and this file points them to the right underlying module. That matters because the protocol library contains many pieces: request and response types, event mappings, item builders, thread history structures, experimental API definitions, JSON-RPC support, and tools for generating JSON Schema and TypeScript definitions. Without this file, every caller would need to know the library’s internal folder layout and import each piece from its private location.

The file first declares the internal modules that make up the crate. Then it publicly re-exports selected names from those modules. “Re-export” means the item still lives in its original module, but users can access it directly through this crate’s public API. For example, code outside the crate can use protocol data types such as initialization parameters, authentication responses, Git information, sandbox settings, and v2 protocol definitions without caring where they are stored internally.

It also exposes schema fixture helpers used to read and write protocol schema examples, plus export functions that generate JSON, TypeScript, and internal JSON Schema output. One test-only helper is marked as hidden from normal documentation, which signals that it exists for tests rather than as part of the everyday public surface.


### `app-server-protocol/src/protocol/mod.rs`

`orchestration` · `compile-time module wiring`

This file does not contain the protocol rules itself. Instead, it organizes the protocol area of the project, much like a folder index at the front of a binder. The app-server protocol is the shared language used to describe messages, events, item shapes, versioned APIs, and conversion helpers. Without this file, Rust would not know how to find those pieces under the `protocol` namespace, and code such as `lib.rs` could not re-export or use them cleanly.

The `pub mod` entries are public doors: they make modules like `common`, `event_mapping`, `item_builders`, `thread_history`, `v1`, and `v2` available to code outside this module. The plain `mod` entries are private doors: `mappers` and `serde_helpers` are still compiled and used inside the protocol implementation, but they are not exposed as part of the public interface. That matters because helper code can change without forcing outside callers to depend on its details.

The versioned modules, `v1` and `v2`, suggest that the protocol supports more than one shape of API or message format. This file is what keeps those pieces grouped under one clear protocol namespace.


### `app-server-protocol/src/protocol/serde_helpers.rs`

`io_transport` · `protocol encoding and decoding`

When this project sends or receives protocol messages, it uses Serde, a Rust library that turns structured data into formats like JSON and back again. Most fields can use Serde’s default behavior, but a few need special rules. This file keeps those special rules in one place so message types can opt into them without repeating code.

The first rule treats an empty path as if no path was provided. That matters because some clients or formats may send an empty string for a path, even though the program really wants to understand that as “there is no path here.” It is like treating a blank address line on a form as unanswered, not as a real address.

The other two helpers deal with a “double option,” written in Rust as `Option<Option<T>>`. This is used when the protocol must tell apart three cases: a field was not sent at all, a field was sent as `null`, or a field was sent with a real value. Normal optional fields only distinguish two of those. These helpers delegate to the `serde_with` library, which provides the careful encoding and decoding needed for that three-way meaning.

#### Function details

##### `deserialize_empty_path_as_none`  (lines 8–14)

```
fn deserialize_empty_path_as_none(deserializer: D) -> Result<Option<PathBuf>, D::Error>
```

**Purpose**: This function reads an optional file path from incoming serialized data and turns an empty path into `None`, meaning “no path.” It is useful when protocol input may represent a missing path as an empty string.

**Data flow**: It receives a Serde deserializer, which is the reader for the incoming data. It first asks Serde to read the data as an optional `PathBuf`, then checks the result: if there is a path but its text is empty, it removes it. The output is either a real non-empty path, `None`, or an error if the input could not be read as a path.

**Call relations**: Serde calls this helper when a protocol field is configured to use this custom path-reading rule. Inside, it hands the basic reading work to Serde’s normal `deserialize` behavior, then adds the project-specific cleanup step before returning the value to the message being built.

*Call graph*: 1 external calls (deserialize).


##### `deserialize_double_option`  (lines 16–22)

```
fn deserialize_double_option(deserializer: D) -> Result<Option<Option<T>>, D::Error>
```

**Purpose**: This function reads a field where the protocol needs to distinguish between “not present,” “present but null,” and “present with a value.” It preserves that three-way meaning using `Option<Option<T>>`.

**Data flow**: It receives a Serde deserializer for incoming data and a target value type `T`. It passes the deserializer to `serde_with`’s double-option reader, which interprets the field’s presence and value. The result is an outer `Option` for whether the field existed, and an inner `Option` for whether the field’s value was null or real.

**Call relations**: Serde uses this helper when decoding a protocol field that needs three distinct states. This function does not invent the decoding rules itself; it forwards the work to `serde_with::rust::double_option::deserialize`, then returns that result to the surrounding protocol message.

*Call graph*: 1 external calls (deserialize).


##### `serialize_double_option`  (lines 24–33)

```
fn serialize_double_option(
    value: &Option<Option<T>>,
    serializer: S,
) -> Result<S::Ok, S::Error>
```

**Purpose**: This function writes a three-state optional field back into serialized protocol data. It keeps the difference between an omitted field, a null field, and a field with a value.

**Data flow**: It receives a reference to an `Option<Option<T>>` and a Serde serializer, which is the writer for outgoing data. It gives both to `serde_with`’s double-option writer, which emits the correct serialized form for the field’s state. The output is Serde’s normal success result, or an error if writing fails.

**Call relations**: Serde calls this helper when encoding a protocol field that uses the double-option convention. The function hands off the actual writing to `serde_with::rust::double_option::serialize` so outgoing messages match the same three-way meaning expected during decoding.

*Call graph*: 1 external calls (serialize).


### `app-server-protocol/src/protocol/common.rs`

`data_model` · `cross-cutting protocol definition, request handling, schema export, and tests`

This file is the protocol contract between the app server and anything that talks to it, such as a desktop app, editor extension, or other host. Without it, the two sides could easily disagree about message names, fields, response shapes, or which operations must not run at the same time.

Most of the file is a central catalogue of messages. A client can ask the server to start or resume a thread, read files, run commands, log in, list models, change configuration, and more. The server can ask the client for approvals, refreshed tokens, tool input, or attestations. The server can also send one-way notifications such as “thread started”, “item completed”, “file system changed”, or “account updated”.

The file uses Rust macros to avoid writing the same boilerplate for every message. From one compact definition, it generates typed Rust enums, JSON serialization rules, TypeScript exports, and JSON Schema exports. Think of it like one master menu that prints both the waiter’s copy and the kitchen’s copy, so everyone uses the same item names.

A key detail is request serialization scope. Some requests are allowed to run in parallel, while others are grouped by thread, configuration, account login, process, or watch id so they happen in a safe order. The tests at the bottom protect many wire-format details so older clients and newer servers keep understanding each other.

#### Function details

##### `AuthMode::has_chatgpt_account`  (lines 53–58)

```
fn has_chatgpt_account(self) -> bool
```

**Purpose**: This answers whether an authentication mode represents a human ChatGPT-style account rather than only a direct API key or machine identity. Code can use it when it needs to know whether account-specific ChatGPT behavior is available.

**Data flow**: It takes one AuthMode value, checks which variant it is, and returns true for ChatGPT, externally supplied ChatGPT tokens, or a personal access token. It returns false for API keys, agent identity, and Bedrock API keys, and it does not change anything.

**Call relations**: Other account or capability code can call this as a small decision point when it has already parsed or stored an AuthMode. It does not hand work off to other functions; it simply returns the classification.


##### `AuthMode::uses_codex_backend`  (lines 61–69)

```
fn uses_codex_backend(self) -> bool
```

**Purpose**: This answers whether an authentication mode goes through Codex services instead of talking directly to a model provider API. It helps callers choose the right backend path.

**Data flow**: It takes one AuthMode value, matches it against the known modes, and returns true for ChatGPT, externally supplied ChatGPT tokens, agent identity, and personal access token. It returns false for direct OpenAI API keys and Bedrock API keys, with no side effects.

**Call relations**: Code that is deciding how to route model or account traffic can call this after it has an AuthMode. The function is self-contained and does not call other project code.


##### `ServerRequest::try_from`  (lines 1417–1419)

```
fn try_from(value: JSONRPCRequest) -> Result<Self, Self::Error>
```

**Purpose**: This converts a raw JSON-RPC request into one of the typed server-to-client request variants. It is used when the program wants safety and named Rust fields instead of loose JSON.

**Data flow**: It receives a JSONRPCRequest, turns that request into a JSON value, then asks Serde, the serialization library, to decode that value as a ServerRequest. The result is either a typed ServerRequest or a JSON decoding error.

**Call relations**: This is the bridge from generic transport data into the typed protocol defined in this file. It calls external JSON conversion helpers, and callers use the returned ServerRequest to inspect the id, method, params, and expected response type.

*Call graph*: 2 external calls (from_value, to_value).


##### `tests::absolute_path_string`  (lines 1692–1695)

```
fn absolute_path_string(path: &str) -> String
```

**Purpose**: This test helper makes a stable absolute path string for expected JSON values. It keeps path formatting consistent across tests.

**Data flow**: It receives a path-like string, makes sure it starts with a slash, builds a test absolute path with the external test helper, and returns that path as display text.

**Call relations**: Serialization tests call this when they need to compare JSON containing paths. It relies on the external test path builder so the expected strings match the path type’s own formatting.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::absolute_path`  (lines 1697–1700)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: This test helper creates an AbsolutePathBuf for request or response structs that require real absolute paths. It saves each test from repeating the same setup.

**Data flow**: It receives a path-like string, normalizes it to begin with a slash, creates a test path buffer, converts it to an absolute path value, and returns that value.

**Call relations**: Many tests call this before constructing protocol messages with file paths. It hands back values that are then serialized and compared against expected JSON.

*Call graph*: 2 external calls (test_path_buf, format!).


##### `tests::request_id`  (lines 1702–1705)

```
fn request_id() -> RequestId
```

**Purpose**: This test helper returns the same simple request id every time. It makes tests easier to read by hiding repeated id construction.

**Data flow**: It takes no input, creates RequestId::Integer with the fixed number 1, and returns it.

**Call relations**: Serialization-scope tests call this while building many ClientRequest values. It depends only on the RequestId integer constructor.

*Call graph*: 1 external calls (Integer).


##### `tests::client_request_serialization_scope_covers_keyed_families`  (lines 1708–1997)

```
fn client_request_serialization_scope_covers_keyed_families()
```

**Purpose**: This test checks that requests tied to a particular thread, process, file watch, configuration area, account area, or similar key are grouped under the right serialization scope. That grouping is what prevents unsafe overlapping work.

**Data flow**: It creates many representative ClientRequest values, asks each one for its serialization_scope, and compares the result with the expected scope. The output is success if all assertions match, or a test failure if any request is grouped incorrectly.

**Call relations**: The Rust test runner calls this test. It uses the local request_id and absolute_path helpers plus standard constructors and assertions to exercise the serialization rules generated from the request definitions.

*Call graph*: 8 external calls (default, from, new, absolute_path, request_id, assert_eq!, json!, vec!).


##### `tests::client_request_serialization_scope_covers_unkeyed_representatives`  (lines 2000–2129)

```
fn client_request_serialization_scope_covers_unkeyed_representatives()
```

**Purpose**: This test checks examples of requests that are intentionally concurrent or globally shared-read. It protects the rule that not every request should be forced into a queue.

**Data flow**: It builds representative ClientRequest values, calls serialization_scope on each, and asserts either no scope or the expected global shared scope. Nothing is returned except test pass or failure.

**Call relations**: The test runner calls it alongside the keyed-scope test. It uses request_id and absolute_path to build sample messages and confirms the generated request metadata behaves as intended.

*Call graph*: 7 external calls (absolute_path, request_id, default, default, default, assert_eq!, vec!).


##### `tests::serialize_get_conversation_summary`  (lines 2132–2150)

```
fn serialize_get_conversation_summary() -> Result<()>
```

**Purpose**: This test verifies the legacy GetConversationSummary request still serializes to the exact JSON shape expected by clients and servers. It protects backward compatibility.

**Data flow**: It creates a thread id from a string, builds the request, serializes it to JSON, and compares that JSON with the expected method name, id, and params.

**Call relations**: The test runner calls it. It relies on ThreadId parsing and Serde serialization, then uses an assertion to make sure the protocol wire format has not drifted.

*Call graph*: calls 1 internal fn (from_string); 2 external calls (Integer, assert_eq!).


##### `tests::serialize_initialize_with_opt_out_notification_methods`  (lines 2153–2196)

```
fn serialize_initialize_with_opt_out_notification_methods() -> Result<()>
```

**Purpose**: This test checks that an initialize request can advertise capabilities, including a list of notification methods the client does not want. That matters during startup negotiation.

**Data flow**: It builds an Initialize request with client information and capability flags, serializes it to JSON, and compares the result with the expected camelCase fields and method name.

**Call relations**: The test runner calls it to protect the startup handshake format. It uses RequestId construction, vector construction, and JSON equality assertions.

*Call graph*: 3 external calls (Integer, assert_eq!, vec!).


##### `tests::deserialize_initialize_with_opt_out_notification_methods`  (lines 2199–2242)

```
fn deserialize_initialize_with_opt_out_notification_methods() -> Result<()>
```

**Purpose**: This test checks the reverse of initialization serialization: JSON from a client can be read back into the typed Initialize request. It ensures incoming startup messages are understood correctly.

**Data flow**: It starts with a JSON object, deserializes it into ClientRequest, and compares the typed result with the expected Rust value.

**Call relations**: The test runner calls it. It uses Serde’s JSON decoding and verifies that the same fields tested during serialization are accepted on input.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::conversation_id_serializes_as_plain_string`  (lines 2245–2253)

```
fn conversation_id_serializes_as_plain_string() -> Result<()>
```

**Purpose**: This test verifies that a conversation or thread id appears in JSON as just a string, not as a wrapped object. That keeps the public wire format simple.

**Data flow**: It parses a thread id from text, serializes it to JSON, and checks that the JSON value is the same plain string.

**Call relations**: The test runner calls it as a focused compatibility check for ThreadId formatting. It uses ThreadId parsing and JSON serialization.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (assert_eq!).


##### `tests::conversation_id_deserializes_from_plain_string`  (lines 2256–2264)

```
fn conversation_id_deserializes_from_plain_string() -> Result<()>
```

**Purpose**: This test verifies that a plain JSON string can be read back into a ThreadId. It protects clients that send ids as simple strings.

**Data flow**: It starts with a JSON string, deserializes it into a ThreadId, and compares it to a ThreadId parsed from the same text.

**Call relations**: The test runner calls it. Together with the matching serialization test, it confirms ThreadId round-trips cleanly through JSON.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::serialize_client_notification`  (lines 2267–2277)

```
fn serialize_client_notification() -> Result<()>
```

**Purpose**: This test checks the one client-to-server notification defined here, Initialized. It verifies that notifications with no payload do not accidentally include a params field.

**Data flow**: It creates ClientNotification::Initialized, serializes it, and compares the JSON with an object containing only the method name.

**Call relations**: The test runner calls it to protect the client notification wire format generated by the macro.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::serialize_server_request`  (lines 2280–2324)

```
fn serialize_server_request() -> Result<()>
```

**Purpose**: This test verifies a legacy server-to-client approval request for command execution. It protects the exact JSON shape used when the server asks the client to approve a command.

**Data flow**: It builds approval params, wraps them in a ServerRequest with an id, serializes the request to JSON, and checks the expected fields. It also checks that a ServerRequestPayload can be turned into the same request with the supplied id.

**Call relations**: The test runner calls it. It uses ThreadId parsing, payload construction, and the generated id and request_with_id helpers to verify both serialization and payload wrapping.

*Call graph*: calls 1 internal fn (from_string); 5 external calls (from, ExecCommandApproval, Integer, assert_eq!, vec!).


##### `tests::serialize_chatgpt_auth_tokens_refresh_request`  (lines 2327–2347)

```
fn serialize_chatgpt_auth_tokens_refresh_request() -> Result<()>
```

**Purpose**: This test checks the server request that asks a client or host app to refresh externally managed ChatGPT tokens. It ensures the method name and reason fields stay stable.

**Data flow**: It builds a ChatgptAuthTokensRefresh request, serializes it, and compares it with expected JSON containing the refresh reason and previous account id.

**Call relations**: The test runner calls it to protect an authentication-related server-to-client message. It uses the generated ServerRequest serialization.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_attestation_generate_request`  (lines 2350–2369)

```
fn serialize_attestation_generate_request() -> Result<()>
```

**Purpose**: This test verifies the server request that asks the client to generate an attestation result. Attestation is a proof-like check, so the request format must stay predictable.

**Data flow**: It creates empty attestation params, builds the ServerRequest, serializes it, and compares the JSON. It also verifies that ServerRequestPayload creates the same request when given an id.

**Call relations**: The test runner calls it. It exercises both direct request construction and the generated payload-to-request helper.

*Call graph*: 3 external calls (AttestationGenerate, Integer, assert_eq!).


##### `tests::serialize_server_response`  (lines 2372–2393)

```
fn serialize_server_response() -> Result<()>
```

**Purpose**: This test verifies a typed client response to a server approval request. It makes sure the response includes the original id, method name, and decision in the expected JSON form.

**Data flow**: It builds a ServerResponse with an approval decision, checks its id and method helper results, serializes it, and compares the JSON.

**Call relations**: The test runner calls it. It exercises the generated ServerResponse id, method, and serialization behavior.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_mcp_server_elicitation_request`  (lines 2396–2450)

```
fn serialize_mcp_server_elicitation_request() -> Result<()>
```

**Purpose**: This test checks the server request used when an MCP server asks the user for input. MCP means Model Context Protocol, a way for outside tools and resources to connect to the model workflow.

**Data flow**: It builds a requested JSON schema, places it inside elicitation params, creates a ServerRequest, serializes it, and compares the exact JSON. It also checks payload-to-request conversion for the same request.

**Call relations**: The test runner calls it. It uses JSON decoding for the nested schema, then exercises generated serialization and request wrapping.

*Call graph*: 5 external calls (McpServerElicitationRequest, Integer, assert_eq!, json!, from_value).


##### `tests::serialize_get_account_rate_limits`  (lines 2453–2468)

```
fn serialize_get_account_rate_limits() -> Result<()>
```

**Purpose**: This test verifies that the account rate-limit read request is serialized without a params field when there are no params. That keeps the wire format clean and compatible.

**Data flow**: It builds a ClientRequest::GetAccountRateLimits with params set to None, checks its id and method, serializes it, and compares the JSON.

**Call relations**: The test runner calls it. It exercises generated ClientRequest helpers and optional-params serialization.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_get_account_token_usage`  (lines 2471–2486)

```
fn serialize_get_account_token_usage() -> Result<()>
```

**Purpose**: This test verifies that the account usage read request is serialized correctly when it has no params. It protects a small but user-visible account API.

**Data flow**: It builds a GetAccountTokenUsage request with no params, checks the id and method, serializes it, and compares the JSON.

**Call relations**: The test runner calls it. It uses the generated ClientRequest id, method, and serialization behavior.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_client_response`  (lines 2489–2579)

```
fn serialize_client_response() -> Result<()>
```

**Purpose**: This test verifies the JSON form of a server-to-client response for starting a thread. It protects a large and important response shape used after a client asks to create a thread.

**Data flow**: It builds a detailed ThreadStart response with thread metadata, paths, model settings, and sandbox settings, wraps it in ClientResponse, serializes it, and compares the resulting JSON.

**Call relations**: The test runner calls it. It uses the absolute_path helper and generated ClientResponse id and method helpers to confirm the response contract.

*Call graph*: 5 external calls (new, Integer, absolute_path, assert_eq!, vec!).


##### `tests::serialize_config_requirements_read`  (lines 2582–2595)

```
fn serialize_config_requirements_read() -> Result<()>
```

**Purpose**: This test checks the request that reads configuration requirements. It verifies that a no-params request serializes to only method and id.

**Data flow**: It builds ConfigRequirementsRead with params None, serializes it, and compares the JSON.

**Call relations**: The test runner calls it to protect one configuration-related client request format.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_api_key`  (lines 2598–2617)

```
fn serialize_account_login_api_key() -> Result<()>
```

**Purpose**: This test verifies the login request shape for API-key authentication. It ensures the secret is placed under the expected field name.

**Data flow**: It builds a LoginAccount request with an API key, serializes it, and compares the JSON with type apiKey and apiKey fields.

**Call relations**: The test runner calls it as part of the account-login wire-format checks.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt`  (lines 2620–2638)

```
fn serialize_account_login_chatgpt() -> Result<()>
```

**Purpose**: This test verifies the standard ChatGPT login request shape. It also confirms that a false streamlined-login flag is omitted from JSON.

**Data flow**: It builds a LoginAccount request for ChatGPT with streamlined login disabled, serializes it, and compares the JSON.

**Call relations**: The test runner calls it. It protects the compact default JSON form for ChatGPT login.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt_streamlined`  (lines 2641–2660)

```
fn serialize_account_login_chatgpt_streamlined() -> Result<()>
```

**Purpose**: This test verifies the ChatGPT login request when streamlined login is explicitly enabled. It checks that the extra flag appears only when needed.

**Data flow**: It builds a ChatGPT LoginAccount request with the streamlined flag set to true, serializes it, and compares the expected JSON.

**Call relations**: The test runner calls it alongside the non-streamlined version to cover both branches of this login format.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt_device_code`  (lines 2663–2679)

```
fn serialize_account_login_chatgpt_device_code() -> Result<()>
```

**Purpose**: This test verifies the login request shape for the ChatGPT device-code flow. Device-code login is the flow where a user authorizes on another device or browser.

**Data flow**: It builds a LoginAccount request using the ChatgptDeviceCode variant, serializes it, and compares the JSON type field.

**Call relations**: The test runner calls it as another account-login compatibility check.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_logout`  (lines 2682–2695)

```
fn serialize_account_logout() -> Result<()>
```

**Purpose**: This test verifies the logout request shape. It makes sure logout does not send an unnecessary params field.

**Data flow**: It builds LogoutAccount with params None, serializes it, and checks method and id only.

**Call relations**: The test runner calls it to protect the account logout protocol.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_account_login_chatgpt_auth_tokens`  (lines 2698–2721)

```
fn serialize_account_login_chatgpt_auth_tokens() -> Result<()>
```

**Purpose**: This test verifies login using externally supplied ChatGPT auth tokens. That mode is marked for special host-app use, so its exact field names matter.

**Data flow**: It builds LoginAccount with access token, account id, and plan type, serializes it, and compares the JSON.

**Call relations**: The test runner calls it as part of the account authentication format suite.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_get_account`  (lines 2724–2756)

```
fn serialize_get_account() -> Result<()>
```

**Purpose**: This test verifies the account read request both with and without an explicit token refresh request. It checks that default false values are omitted while true values are sent.

**Data flow**: It builds two GetAccount requests, serializes each, and compares the JSON: one has empty params, and the other includes refreshToken.

**Call relations**: The test runner calls it. It protects optional/default field behavior in account reads.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::account_serializes_fields_in_camel_case`  (lines 2759–2804)

```
fn account_serializes_fields_in_camel_case() -> Result<()>
```

**Purpose**: This test checks that account values use camelCase field names in JSON, such as apiKey and planType. That is the style expected by TypeScript and JSON clients.

**Data flow**: It creates several account variants, serializes each to JSON, and compares the field names and values with the expected form.

**Call relations**: The test runner calls it. Although the account types live outside this file, this protocol test protects their wire format because this file exposes account-related messages.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::account_defaults_legacy_bedrock_credential_source`  (lines 2807–2817)

```
fn account_defaults_legacy_bedrock_credential_source() -> Result<()>
```

**Purpose**: This test verifies backward compatibility for older Amazon Bedrock account JSON that did not include a credential source. It ensures old data still reads as AWS-managed credentials.

**Data flow**: It deserializes a JSON account object with only the type field and checks that the resulting account has the expected default credential source.

**Call relations**: The test runner calls it as a compatibility guard for account data used by the protocol.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::serialize_list_models`  (lines 2820–2838)

```
fn serialize_list_models() -> Result<()>
```

**Purpose**: This test verifies the model list request format. It checks that default pagination and visibility fields are represented as null.

**Data flow**: It builds ModelList with default params, serializes it, and compares method, id, and null params fields.

**Call relations**: The test runner calls it to protect the model discovery API shape.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_model_provider_capabilities_read`  (lines 2841–2855)

```
fn serialize_model_provider_capabilities_read() -> Result<()>
```

**Purpose**: This test verifies the request that reads model-provider capabilities. It ensures an empty params object is still sent where the protocol expects one.

**Data flow**: It builds the request, serializes it, and compares the JSON with an empty params object.

**Call relations**: The test runner calls it as a focused check for the model provider capability endpoint.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_list_collaboration_modes`  (lines 2858–2872)

```
fn serialize_list_collaboration_modes() -> Result<()>
```

**Purpose**: This test verifies the request that lists collaboration mode presets. It protects the experimental method’s JSON shape.

**Data flow**: It builds CollaborationModeList with default params, serializes it, and compares the JSON.

**Call relations**: The test runner calls it to make sure the generated ClientRequest entry for collaboration modes stays stable.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_list_apps`  (lines 2875–2893)

```
fn serialize_list_apps() -> Result<()>
```

**Purpose**: This test verifies the request that lists apps. It checks default cursor, limit, and thread id fields.

**Data flow**: It builds AppsList with default params, serializes it, and compares the JSON containing null pagination and thread fields.

**Call relations**: The test runner calls it to protect the app listing protocol.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_environment_add`  (lines 2896–2916)

```
fn serialize_environment_add() -> Result<()>
```

**Purpose**: This test verifies the experimental request that registers or replaces a remote environment. It checks the environment id and execution server URL field names.

**Data flow**: It builds EnvironmentAdd params, wraps them in a ClientRequest, serializes the request, and compares the JSON.

**Call relations**: The test runner calls it. A separate experimental-gating test checks that the same method is marked experimental.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_fs_get_metadata`  (lines 2919–2937)

```
fn serialize_fs_get_metadata() -> Result<()>
```

**Purpose**: This test verifies the file-system metadata request format. It ensures absolute paths serialize the way clients expect.

**Data flow**: It creates an absolute test path, builds FsGetMetadata, serializes it, and compares the path string in JSON.

**Call relations**: The test runner calls it. It uses the local absolute_path and absolute_path_string helpers to compare typed and JSON path forms.

*Call graph*: 3 external calls (Integer, absolute_path, assert_eq!).


##### `tests::serialize_fs_watch`  (lines 2940–2960)

```
fn serialize_fs_watch() -> Result<()>
```

**Purpose**: This test verifies the request that starts watching a file-system path for changes. It checks both the watch id and path fields.

**Data flow**: It builds FsWatch with a watch id and absolute path, serializes it, and compares the expected JSON.

**Call relations**: The test runner calls it as part of file-system protocol coverage. The serialization-scope tests separately verify that watch requests are grouped by watch id.

*Call graph*: 3 external calls (Integer, absolute_path, assert_eq!).


##### `tests::serialize_list_experimental_features`  (lines 2963–2981)

```
fn serialize_list_experimental_features() -> Result<()>
```

**Purpose**: This test verifies the request that lists experimental features with default pagination. It protects the shape of the feature discovery API.

**Data flow**: It builds ExperimentalFeatureList with default params, serializes it, and compares JSON with null cursor, limit, and thread id.

**Call relations**: The test runner calls it. It checks the generated ClientRequest serialization for this configuration-related method.

*Call graph*: 3 external calls (Integer, default, assert_eq!).


##### `tests::serialize_list_experimental_features_with_thread_id`  (lines 2984–3006)

```
fn serialize_list_experimental_features_with_thread_id() -> Result<()>
```

**Purpose**: This test verifies experimental-feature listing when pagination and a thread id are supplied. It ensures non-default optional fields appear correctly.

**Data flow**: It builds ExperimentalFeatureList with cursor, limit, and thread id, serializes it, and compares the JSON values.

**Call relations**: The test runner calls it alongside the default version to cover both empty and populated params.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_background_terminals_clean`  (lines 3009–3027)

```
fn serialize_thread_background_terminals_clean() -> Result<()>
```

**Purpose**: This test verifies the experimental request that cleans background terminals for a thread. It checks that the thread id is sent correctly.

**Data flow**: It builds ThreadBackgroundTerminalsClean, serializes it, and compares method, id, and threadId.

**Call relations**: The test runner calls it to protect one of the background-terminal protocol messages.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_background_terminals_list`  (lines 3030–3052)

```
fn serialize_thread_background_terminals_list() -> Result<()>
```

**Purpose**: This test verifies the experimental request that lists background terminals for a thread. It checks the default pagination fields.

**Data flow**: It builds ThreadBackgroundTerminalsList with a thread id and no cursor or limit, serializes it, and compares the JSON.

**Call relations**: The test runner calls it as part of the background-terminal API coverage.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_background_terminals_terminate`  (lines 3055–3075)

```
fn serialize_thread_background_terminals_terminate() -> Result<()>
```

**Purpose**: This test verifies the experimental request that terminates a background terminal. It checks both the thread id and process id fields.

**Data flow**: It builds ThreadBackgroundTerminalsTerminate, serializes it, and compares the JSON.

**Call relations**: The test runner calls it to protect the terminate message in the background-terminal family.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_realtime_start`  (lines 3078–3118)

```
fn serialize_thread_realtime_start() -> Result<()>
```

**Purpose**: This test verifies the experimental request that starts a realtime thread session, including audio output settings and voice choice. Realtime here means an ongoing interactive session rather than a single text turn.

**Data flow**: It builds ThreadRealtimeStart with many optional and required fields, serializes it, and compares the complete JSON object.

**Call relations**: The test runner calls it. It protects the generated serialization for realtime startup, while other tests check its experimental gating.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_realtime_start_prompt_default_and_null`  (lines 3121–3233)

```
fn serialize_thread_realtime_start_prompt_default_and_null() -> Result<()>
```

**Purpose**: This test checks a subtle distinction in realtime startup: leaving prompt out versus explicitly sending prompt as null. That distinction lets clients say either “use the default” or “clear/no prompt”.

**Data flow**: It builds one request with prompt absent and another with prompt explicitly null, serializes both, and compares their JSON. It also deserializes JSON examples back into the expected typed requests.

**Call relations**: The test runner calls it. It uses JSON construction and equality assertions to protect both directions of this special optional-field behavior.

*Call graph*: 3 external calls (Integer, assert_eq!, json!).


##### `tests::serialize_thread_realtime_append_speech`  (lines 3236–3256)

```
fn serialize_thread_realtime_append_speech() -> Result<()>
```

**Purpose**: This test verifies the request that appends spoken text to a realtime thread. It checks that thread id and text are sent under the expected names.

**Data flow**: It builds ThreadRealtimeAppendSpeech, serializes it, and compares the JSON.

**Call relations**: The test runner calls it as part of realtime protocol coverage.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::serialize_thread_status_changed_notification`  (lines 3259–3278)

```
fn serialize_thread_status_changed_notification() -> Result<()>
```

**Purpose**: This test verifies the server notification sent when a thread changes status. Notifications are one-way messages, so clients rely on their exact method names and payload shapes.

**Data flow**: It builds a ThreadStatusChanged notification with an idle status, serializes it, and compares the JSON method and params.

**Call relations**: The test runner calls it. It exercises the server notification enum generated by the notification macro.

*Call graph*: 2 external calls (ThreadStatusChanged, assert_eq!).


##### `tests::serialize_thread_realtime_output_audio_delta_notification`  (lines 3281–3311)

```
fn serialize_thread_realtime_output_audio_delta_notification() -> Result<()>
```

**Purpose**: This test verifies the realtime notification that streams an audio chunk from the server. It protects the base64 audio payload metadata fields.

**Data flow**: It builds ThreadRealtimeOutputAudioDelta with audio data, sample rate, channel count, sample count, and no item id, serializes it, and compares the JSON.

**Call relations**: The test runner calls it. Later experimental-gating tests also check that this notification is marked experimental.

*Call graph*: 2 external calls (ThreadRealtimeOutputAudioDelta, assert_eq!).


##### `tests::mock_experimental_method_is_marked_experimental`  (lines 3314–3321)

```
fn mock_experimental_method_is_marked_experimental()
```

**Purpose**: This test verifies that a test-only mock method is reported as experimental. It exists to prove the experimental-gating machinery works.

**Data flow**: It builds MockExperimentalMethod, asks the ExperimentalApi trait for its experimental reason, and compares that reason with the expected method name.

**Call relations**: The test runner calls it. It directly exercises the generated ExperimentalApi implementation for ClientRequest.

*Call graph*: 4 external calls (experimental_reason, Integer, default, assert_eq!).


##### `tests::environment_add_is_marked_experimental`  (lines 3324–3334)

```
fn environment_add_is_marked_experimental()
```

**Purpose**: This test verifies that the environment/add request is marked experimental. That prevents callers from using it unless experimental APIs are allowed.

**Data flow**: It builds EnvironmentAdd, asks for its experimental reason, and checks that the reason is environment/add.

**Call relations**: The test runner calls it. It uses the same generated experimental metadata that runtime gating code would consult.

*Call graph*: 3 external calls (experimental_reason, Integer, assert_eq!).


##### `tests::command_exec_permission_profile_is_marked_experimental`  (lines 3337–3360)

```
fn command_exec_permission_profile_is_marked_experimental()
```

**Purpose**: This test verifies field-level experimental gating: command/exec itself can be stable, while using its permissionProfile field is experimental. This is more precise than marking the whole method experimental.

**Data flow**: It builds OneOffCommandExec with a permission profile set, asks for the experimental reason, and checks that the reason points to command/exec.permissionProfile.

**Call relations**: The test runner calls it. It exercises the inspect_params path, where the request asks its params type whether any field is experimental.

*Call graph*: 4 external calls (experimental_reason, Integer, assert_eq!, vec!).


##### `tests::thread_realtime_start_is_marked_experimental`  (lines 3363–3383)

```
fn thread_realtime_start_is_marked_experimental()
```

**Purpose**: This test verifies that starting realtime mode is marked experimental. It helps keep unfinished or unstable realtime APIs behind the experimental gate.

**Data flow**: It builds ThreadRealtimeStart, asks for its experimental reason, and compares it with thread/realtime/start.

**Call relations**: The test runner calls it. It checks the generated ClientRequest experimental metadata for a method-level experimental flag.

*Call graph*: 3 external calls (experimental_reason, Integer, assert_eq!).


##### `tests::thread_goal_methods_are_not_marked_experimental`  (lines 3386–3421)

```
fn thread_goal_methods_are_not_marked_experimental()
```

**Purpose**: This test verifies that thread goal set, get, and clear requests are considered stable. It protects them from accidentally being hidden behind experimental gating.

**Data flow**: It builds three thread-goal ClientRequest values, asks each for its experimental reason, and asserts that each returns None.

**Call relations**: The test runner calls it. It uses the generated ExperimentalApi implementation as runtime gating code would.

*Call graph*: 2 external calls (Integer, assert_eq!).


##### `tests::thread_goal_notifications_are_not_marked_experimental`  (lines 3424–3452)

```
fn thread_goal_notifications_are_not_marked_experimental()
```

**Purpose**: This test verifies that thread goal update and clear notifications are not experimental. It protects stable notification delivery for goal-related UI.

**Data flow**: It builds goal updated and goal cleared notifications, asks each for an experimental reason, and asserts that no reason is returned.

**Call relations**: The test runner calls it. It exercises the generated ExperimentalApi implementation for ServerNotification.

*Call graph*: 3 external calls (ThreadGoalCleared, ThreadGoalUpdated, assert_eq!).


##### `tests::thread_settings_updated_notification_is_marked_experimental`  (lines 3455–3486)

```
fn thread_settings_updated_notification_is_marked_experimental()
```

**Purpose**: This test verifies that the thread settings updated notification is marked experimental. That matters because clients may need to opt in before receiving or depending on it.

**Data flow**: It builds a ThreadSettingsUpdated notification with representative settings, asks for its experimental reason, and checks the expected reason string.

**Call relations**: The test runner calls it. It uses the absolute_path helper and the generated notification experimental metadata.

*Call graph*: 3 external calls (ThreadSettingsUpdated, absolute_path, assert_eq!).


##### `tests::turn_moderation_metadata_notification_is_marked_experimental`  (lines 3489–3501)

```
fn turn_moderation_metadata_notification_is_marked_experimental()
```

**Purpose**: This test verifies that moderation metadata notifications for turns are experimental. Moderation metadata is extra structured information, so the gate can protect clients from unstable shape changes.

**Data flow**: It builds a TurnModerationMetadata notification with JSON metadata, asks for its experimental reason, and compares it with the expected method name.

**Call relations**: The test runner calls it. It checks the ExperimentalApi implementation generated for server notifications.

*Call graph*: 3 external calls (TurnModerationMetadata, assert_eq!, json!).


##### `tests::thread_realtime_started_notification_is_marked_experimental`  (lines 3504–3513)

```
fn thread_realtime_started_notification_is_marked_experimental()
```

**Purpose**: This test verifies that the notification announcing realtime startup is experimental. It keeps realtime notification support behind opt-in behavior.

**Data flow**: It builds ThreadRealtimeStarted, asks for the experimental reason, and asserts that the reason is thread/realtime/started.

**Call relations**: The test runner calls it. It uses the generated ServerNotification experimental metadata.

*Call graph*: 3 external calls (ThreadRealtimeStarted, experimental_reason, assert_eq!).


##### `tests::thread_realtime_output_audio_delta_notification_is_marked_experimental`  (lines 3516–3531)

```
fn thread_realtime_output_audio_delta_notification_is_marked_experimental()
```

**Purpose**: This test verifies that realtime audio output delta notifications are marked experimental. It protects clients that do not yet support streaming audio notifications.

**Data flow**: It builds a ThreadRealtimeOutputAudioDelta notification, asks for its experimental reason, and compares it with the expected method name.

**Call relations**: The test runner calls it. It complements the serialization test for the same notification by checking access gating.

*Call graph*: 3 external calls (ThreadRealtimeOutputAudioDelta, experimental_reason, assert_eq!).


##### `tests::command_execution_request_approval_additional_permissions_is_marked_experimental`  (lines 3534–3564)

```
fn command_execution_request_approval_additional_permissions_is_marked_experimental()
```

**Purpose**: This test verifies field-level experimental gating for additional permissions inside command approval params. It ensures this extra permission request feature is detected even though the surrounding approval request is otherwise normal.

**Data flow**: It builds CommandExecutionRequestApprovalParams with additional file-system permissions, asks the params value for its experimental reason, and checks that the reason names the additionalPermissions field.

**Call relations**: The test runner calls it. It directly exercises the ExperimentalApi implementation for the params type, which request-level gating can also consult.

*Call graph*: 3 external calls (experimental_reason, assert_eq!, vec!).


### `app-server-protocol/src/protocol/mappers.rs`

`io_transport` · `request handling`

This file is a small compatibility bridge between two versions of the app server protocol. A protocol is the agreed shape of messages sent between parts of the system. Over time, the newer version gained more options for running a command, such as whether to stream input or output, whether to attach a terminal, and whether to disable limits. Older requests do not know about those options.

The file teaches Rust how to turn a v1::ExecOneOffCommandParams value into a v2::CommandExecParams value. Think of it like filling out a newer, longer form using information from an older, shorter form. Fields that existed in the old form, such as the command, working directory, timeout, and sandbox policy, are copied across. Fields that only exist in the new form are filled with safe defaults, such as no process id, no terminal, no streaming, no custom environment, and no disabled timeout.

One important detail is the timeout conversion. The old timeout value is converted into the signed number type used by the newer protocol. If that conversion somehow fails, it falls back to 60,000 milliseconds, which is one minute. Without this mapper, older clients or stored requests would need special handling elsewhere, or they could fail when the server expects the newer command parameter format.

#### Function details

##### `CommandExecParams::from`  (lines 4–23)

```
fn from(value: v1::ExecOneOffCommandParams) -> Self
```

**Purpose**: This function builds a version 2 command-execution request from a version 1 one. It preserves the information the old request can provide and supplies sensible default values for newer options that did not exist before.

**Data flow**: It receives a v1::ExecOneOffCommandParams value containing the command to run and optional settings like timeout, working directory, and sandbox policy. It copies or converts those known fields into a new v2::CommandExecParams value, while setting newer fields such as terminal mode, streaming, environment, size, and permission profile to default empty or false values. The result is a complete version 2 command request ready for the newer protocol code to use.

**Call relations**: This conversion is used whenever Rust's standard From conversion is requested between the old command parameter type and the new one. In the larger flow, code that receives or upgrades a version 1 command request can call on this function implicitly or explicitly, then pass the resulting v2::CommandExecParams onward to the newer command execution path.


### `app-server-protocol/src/protocol/v1.rs`

`data_model` · `API boundary during startup and request handling`

This file is like a set of blank forms for the app-server protocol. It does not run the server or make decisions by itself. Instead, it defines the exact fields that can travel between a client, such as an editor or UI, and the app server. Without these definitions, both sides could disagree about what a message looks like, which would make requests fail or be misunderstood.

Most types here are small data containers. For example, `InitializeParams` tells the server who the client is and what features it supports, while `InitializeResponse` tells the client where the server is running and where its Codex home directory is. Conversation-related types describe saved conversations, including preview text, timestamps, working directory, source, and optional Git information. Approval types describe moments when the agent needs the user to allow a patch or shell command before continuing.

The file also defines request and response shapes for login, authentication status, Git diffs, one-off command execution, saved user configuration, sandbox settings, and interruption results. Many structs derive serialization traits, meaning they can be turned into JSON and read back again. They also derive JSON Schema and TypeScript bindings, so other languages and tools can use the same contract. In short, this file is the protocol dictionary for version 1 of the app server API.


### V2 shared core and conversation model
This group introduces the v2 namespace, its shared enums and generic notifications, then the thread, turn, item, and review structures that form the central interactive protocol narrative.

### `app-server-protocol/src/protocol/v2/mod.rs`

`data_model` · `cross-cutting`

This file does not define message formats itself. Instead, it acts like the table of contents and reception desk for the protocol’s second version. The protocol is the shared language used by different parts of the system to talk to each other, such as account actions, file-system events, notifications, plugins, remote control, threads, turns, and more.

Each `mod` line tells Rust that there is a separate source file or folder for one topic area. For example, account-related protocol pieces live in the account module, file-system pieces live in the fs module, and real-time communication pieces live in the realtime module. Keeping these areas separate prevents one huge, hard-to-read file.

Each `pub use` line then makes the public items from those topic modules available through this single `protocol::v2` namespace. In everyday terms, callers do not need to know which drawer a form is stored in; they can come to this front desk and ask for it by name.

The `shared` module is included too, which likely contains common pieces reused by several protocol areas. The test module is only compiled when running tests. Without this file, other code would have to import protocol pieces from many scattered module paths, and the project would lose a clear public boundary for version 2 of the protocol.


### `app-server-protocol/src/protocol/v2/shared.rs`

`data_model` · `cross-cutting API request and response translation`

This file is a small bridge between two worlds: the outside API and the server’s internal code. Clients need stable, friendly names such as camelCase or kebab-case in JSON, while the core Codex code has its own Rust types and naming. Without this layer, API clients could receive confusing or unstable values, and the server would have to expose its internal type shapes directly.

The file mostly defines enums, which are lists of allowed choices. For example, it describes what kind of approval policy is active, who reviews approval requests, what sandbox mode limits file or system access, and what kind of error happened. It also defines conversions in both directions: from API v2 types into core types when a request comes in, and from core types back into API v2 types when sending a response.

One important detail is that some API values are intentionally renamed for compatibility and clarity. For example, approval reviewers accept both the current value `auto_review` and the older `guardian_subagent`. The file also builds a custom JSON schema, which is a machine-readable description of valid API values, so tools and generated TypeScript definitions can understand the contract.

#### Function details

##### `default_enabled`  (lines 52–54)

```
fn default_enabled() -> bool
```

**Purpose**: Returns `true` as a default value for settings that should be switched on unless the caller says otherwise. It is a tiny helper used when a missing field should mean “enabled.”

**Data flow**: Nothing goes in. The function always produces the boolean value `true`, and it does not read or change anything else.

**Call relations**: This is a reusable default function for shared API types. It sits alongside the data definitions so serialization or configuration code can refer to one clear default instead of repeating the literal value.


##### `CodexErrorInfo::from`  (lines 115–145)

```
fn from(value: CoreCodexErrorInfo) -> Self
```

**Purpose**: Converts an internal Codex error description into the public API v2 error description. This keeps API clients seeing the v2 names and shapes, even when the server stores the error internally in a core type.

**Data flow**: It receives a core error value. It checks which error case it is, copies over any extra information such as an optional HTTP status code, converts nested turn-kind information when needed, and returns the matching API v2 error value.

**Call relations**: This function is used when an error produced inside the core system needs to be sent out through the v2 protocol. For the `ActiveTurnNotSteerable` case, it hands the nested turn kind to `NonSteerableTurnKind::from` so that nested value is translated too.


##### `NonSteerableTurnKind::from`  (lines 149–154)

```
fn from(value: CoreNonSteerableTurnKind) -> Self
```

**Purpose**: Converts the internal description of a turn that cannot be steered into the API v2 version. A “non-steerable” turn is a kind of active operation, such as review or compaction, that cannot accept more user direction mid-turn.

**Data flow**: It receives a core turn-kind value. It matches `Review` to `Review` and `Compact` to `Compact`, then returns the API-facing version.

**Call relations**: This conversion is part of error translation. When `CodexErrorInfo::from` sees that an active turn cannot be steered, it uses this helper to translate the turn kind included in that error.


##### `AskForApproval::to_core`  (lines 182–202)

```
fn to_core(self) -> CoreAskForApproval
```

**Purpose**: Turns an API v2 approval policy into the internal approval policy the core server understands. This is used when a client or UI chooses when Codex should ask before doing something risky.

**Data flow**: It receives an API approval setting such as `on-request`, `never`, or the detailed `granular` form. It maps simple choices directly, and for the granular choice it gathers the individual permission flags into the core granular approval configuration. It returns the core approval policy.

**Call relations**: This function is called when user-facing approval choices need to affect the real runtime configuration, such as while setting an approval policy, applying a built-in permission mode, or updating configuration. For granular approval, it constructs the core granular configuration object before handing it onward.

*Call graph*: called by 3 (try_set_approval_policy_on_config, builtin_permission_mode_selection_item, set_approval_policy); 1 external calls (Granular).


##### `AskForApproval::from`  (lines 206–220)

```
fn from(value: CoreAskForApproval) -> Self
```

**Purpose**: Turns the internal approval policy back into the API v2 form. This lets the server report the current approval behavior to clients using the public protocol’s names and fields.

**Data flow**: It receives a core approval policy. It maps simple policies directly, and if the policy is granular it pulls out each detailed flag, such as sandbox approval and request permissions, and returns the matching API v2 `Granular` value.

**Call relations**: This function is used in many places that need to show or synchronize current approval settings, including event handling, feature flag updates, session state reporting, and permission-related UI flows. It is the outward-facing half of the approval-policy translation pair.

*Call graph*: called by 16 (ask_for_approval_granular_round_trips_request_permissions_flag, sync_auto_review_runtime_state_from_effective_config, update_feature_flags, handle_event, session_state_for_thread_read, sync_active_thread_permission_settings_to_cached_session, submit_user_message_with_history_and_shell_escape_policy, open_full_access_confirmation, open_permissions_popup, preset_matches_current (+6 more)).


##### `ApprovalsReviewer::schema_name`  (lines 241–243)

```
fn schema_name() -> String
```

**Purpose**: Provides the name used for this type in generated JSON schema. JSON schema is a machine-readable description of what values are valid in JSON.

**Data flow**: Nothing meaningful goes in. It returns the fixed schema name `ApprovalsReviewer` and does not change any state.

**Call relations**: Schema generation code calls this as part of documenting the API type. It pairs with `ApprovalsReviewer::json_schema`, which describes the allowed string values.


##### `ApprovalsReviewer::json_schema`  (lines 245–250)

```
fn json_schema(_generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: Builds the JSON schema for the approval reviewer setting. It tells tools that this setting is a string and lists the accepted values, including the older compatibility name.

**Data flow**: It receives a schema generator argument, but does not need to use it. It passes the accepted string values and a human-readable explanation to `string_enum_schema_with_description`, then returns the schema that helper builds.

**Call relations**: This function is called by schema generation for the public API. It delegates the low-level schema-building work to `string_enum_schema_with_description` so the reviewer-specific function can stay focused on the allowed reviewer values and their meaning.

*Call graph*: calls 1 internal fn (string_enum_schema_with_description).


##### `string_enum_schema_with_description`  (lines 253–269)

```
fn string_enum_schema_with_description(values: &[&str], description: &str) -> Schema
```

**Purpose**: Creates a JSON schema for a string field that can only be one of a fixed set of values, with explanatory text attached. It is a small helper for making API documentation accurate and readable.

**Data flow**: It receives a list of allowed strings and a description. It builds a schema object marked as a string, adds the description as metadata, converts each allowed string into a JSON value, stores them as the enum choices, and returns the finished schema.

**Call relations**: This helper is called by `ApprovalsReviewer::json_schema`. It does the mechanical schema construction so the caller only has to supply the meaning and the list of accepted values.

*Call graph*: called by 1 (json_schema); 3 external calls (new, default, Object).


##### `ApprovalsReviewer::to_core`  (lines 272–277)

```
fn to_core(self) -> CoreApprovalsReviewer
```

**Purpose**: Converts the API v2 reviewer choice into the internal reviewer choice. This decides whether approval requests go to the user or to the automated review path inside the core system.

**Data flow**: It receives an API reviewer value. `User` becomes the core `User` value, and `AutoReview` becomes the core `AutoReview` value. It returns that core value without changing anything else.

**Call relations**: This is used when API or configuration input needs to be applied to the core system. It is the inward conversion for the approval reviewer setting.


##### `ApprovalsReviewer::from`  (lines 281–286)

```
fn from(value: CoreApprovalsReviewer) -> Self
```

**Purpose**: Converts the internal reviewer choice into the API v2 reviewer choice. This lets the server expose the current reviewer setting without leaking internal type names.

**Data flow**: It receives a core reviewer value. It maps `User` to the API `User` variant and `AutoReview` to the API `AutoReview` variant, then returns the API value.

**Call relations**: This is the outward conversion for reviewer settings. It complements `ApprovalsReviewer::to_core`, so the same concept can move safely in both directions between API and core code.


##### `SandboxMode::to_core`  (lines 299–305)

```
fn to_core(self) -> CoreSandboxMode
```

**Purpose**: Converts the API v2 sandbox mode into the internal sandbox mode. Sandbox mode describes how much access Codex has to files and the wider system, from read-only to full access.

**Data flow**: It receives an API sandbox choice. It maps `ReadOnly`, `WorkspaceWrite`, and `DangerFullAccess` to the matching core values, then returns the core sandbox mode.

**Call relations**: This function is used when a client-selected or configured sandbox setting must be applied to the core runtime. It is the inward-facing translation for sandbox permissions.


##### `SandboxMode::from`  (lines 309–315)

```
fn from(value: CoreSandboxMode) -> Self
```

**Purpose**: Converts the internal sandbox mode back into the API v2 sandbox mode. This lets clients see the active sandbox setting using the public protocol’s names.

**Data flow**: It receives a core sandbox mode. It maps each possible core value to the matching API v2 value and returns it, without changing any state.

**Call relations**: This function is used when reporting sandbox configuration outward through the v2 API. It pairs with `SandboxMode::to_core` so sandbox settings can round-trip cleanly between clients and the core server.


### `app-server-protocol/src/protocol/v2/notification.rs`

`data_model` · `cross-cutting protocol messaging`

This file does not contain running behavior. Instead, it defines several message formats used when the server needs to tell the client something outside the normal request-and-response flow. Think of these structs like standardized forms: one form for a deprecation notice, one for a warning, one for an error, and so on. Because both the server and client use the same forms, they can exchange messages without guessing what each field means.

Each notification is designed for a specific kind of news. A deprecation notice tells the client that some feature or behavior is going away, with optional details about what to do instead. A warning can be general or tied to a particular thread. A guardian warning is always tied to a thread and carries a user-facing message. An error notification includes the actual turn error, the thread and turn it belongs to, and whether the server plans to retry automatically. A server-request-resolved notification tells the client that a previously opened server-side request has been completed.

The derive annotations make these message types easy to convert to and from JSON, generate JSON schema, and export matching TypeScript types. In plain terms, this helps keep Rust backend code, API documentation, and frontend code in sync.


### `app-server-protocol/src/protocol/v2/thread_data.rs`

`data_model` · `API request and response serialization`

This file is mostly a set of shared labels and record shapes. In plain terms, it describes how a conversation thread is packaged when it crosses the app-server boundary. Without it, different parts of the system could disagree about basic facts such as where a thread came from, what status it is in, which turns belong to it, or how errors should be shown to a user.

The file defines two kinds of source labels. `SessionSource` says what created the overall session, such as the command line, VS Code, app-server, or a custom source. `ThreadSource` says why a particular thread exists, such as a user thread, a subagent thread, a feature-created thread, or memory consolidation. These labels are translated to and from lower-level core protocol types, like a border checkpoint between the app-server API and the internal engine.

The main records are `Thread`, `Turn`, `GitInfo`, `TurnItemsView`, and `TurnError`. A `Thread` is the full conversation container: IDs, timestamps, working directory, model provider, source, optional Git details, optional title, and a list of turns. A `Turn` is one exchange or unit of work inside the thread, including its items, status, timing, and possible error. The serialization and schema annotations make these shapes usable as JSON and exportable to TypeScript, so frontend and API consumers can rely on the same structure.

#### Function details

##### `SessionSource::from`  (lines 37–49)

```
fn from(value: CoreSessionSource) -> Self
```

**Purpose**: This converts an internal core session source into the app-server protocol version of that source. It keeps public-facing source names stable and hides internal-only sources by turning them into `Unknown`.

**Data flow**: It receives a `CoreSessionSource`, which is the lower-level engine's label for where a session came from. It matches that label to the app-server-facing `SessionSource`; custom names and subagent details are carried across, while internal-only labels are not exposed and become `Unknown`. The output is the protocol-safe source value that can be sent to clients.

**Call relations**: This function sits at the boundary where core thread data is being prepared for the app-server API. When it sees a custom source or subagent source, it hands that contained value into the matching app-server variant so the information is preserved for the response.

*Call graph*: 2 external calls (Custom, SubAgent).


##### `CoreSessionSource::from`  (lines 53–63)

```
fn from(value: SessionSource) -> Self
```

**Purpose**: This converts the app-server protocol session source back into the core protocol's session source. It is used when information coming through the app-server layer needs to be understood by the lower-level engine.

**Data flow**: It receives a `SessionSource` from the app-server side. It maps each public variant to the matching core variant, including carrying through custom source text and subagent information. The result is a `CoreSessionSource` that core protocol code can use.

**Call relations**: This is the reverse trip of `SessionSource::from`: it moves source labels from the API-facing world back into the core protocol world. For custom and subagent values, it passes the embedded data into the core variant constructors so no meaningful source detail is lost.

*Call graph*: 2 external calls (Custom, SubAgent).


##### `ThreadSource::schema_name`  (lines 78–80)

```
fn schema_name() -> String
```

**Purpose**: This gives the JSON schema generator the public name `ThreadSource` for this type. A JSON schema is a machine-readable description of what valid JSON should look like.

**Data flow**: It takes no outside data beyond the type itself. It returns the fixed text name `ThreadSource`, which schema generation tools use when documenting or referencing this type.

**Call relations**: This is called by schema-generation machinery when building the protocol schema. It does not call other project logic; it simply supplies the stable name that other generated documentation or client code can refer to.


##### `ThreadSource::json_schema`  (lines 82–84)

```
fn json_schema(generator: &mut SchemaGenerator) -> Schema
```

**Purpose**: This tells the JSON schema generator that `ThreadSource` should be represented as a string in JSON. Even though Rust stores it as named variants, clients see and send it as text.

**Data flow**: It receives a schema generator object. Instead of building a custom object shape, it asks the normal `String` schema logic to produce the schema, then returns that schema. The result says, in effect, `ThreadSource` is valid wherever a string is valid.

**Call relations**: Schema-generation code calls this when it needs to describe `ThreadSource` for API consumers. The function delegates to the existing string schema generation, keeping the external contract simple and matching the file's string-based conversion behavior.

*Call graph*: 1 external calls (json_schema).


##### `ThreadSource::try_from`  (lines 90–92)

```
fn try_from(value: String) -> Result<Self, Self::Error>
```

**Purpose**: This tries to turn a plain string into a `ThreadSource`. It is useful when JSON or another text-based API gives the server a thread-source value.

**Data flow**: It receives a string from outside the typed Rust world. It asks the core thread-source parser to understand that text, then converts the parsed core value into the app-server `ThreadSource`. If the text is not valid, it returns an error message instead of inventing a value.

**Call relations**: This is part of the deserialization path for `ThreadSource`, because the type is declared to be read from a string. It relies on the core protocol's parsing rules first, then uses the conversion into `ThreadSource` so the app-server and core layers interpret the same text the same way.


##### `String::from`  (lines 96–98)

```
fn from(value: ThreadSource) -> Self
```

**Purpose**: This turns a `ThreadSource` back into the string form used in JSON and TypeScript-facing APIs. It is the outgoing companion to `ThreadSource::try_from`.

**Data flow**: It receives a typed app-server `ThreadSource`. It first converts that value into the core protocol's `CoreThreadSource`, then turns the core value into a string. The output is the text that can be serialized into JSON.

**Call relations**: This is used when `ThreadSource` needs to leave Rust as a string, such as in API responses. It hands off to the core conversion and string formatting path so the app-server does not define a separate spelling for the same source labels.

*Call graph*: 1 external calls (from).


##### `ThreadSource::from`  (lines 102–109)

```
fn from(value: CoreThreadSource) -> Self
```

**Purpose**: This converts a core protocol thread source into the app-server protocol's `ThreadSource`. It lets app-server responses reuse the lower-level engine's source classification without exposing a different type.

**Data flow**: It receives a `CoreThreadSource`. It matches each core variant to the app-server variant with the same meaning. If the source is tied to a named feature, it carries that feature name into `ThreadSource::Feature`. The output is the app-server protocol value.

**Call relations**: This is used after core code has identified why a thread exists and that information needs to be presented through the app-server protocol. For feature-created threads, it calls into the `Feature` variant construction so the feature name travels with the source label.

*Call graph*: 1 external calls (Feature).


##### `CoreThreadSource::from`  (lines 113–120)

```
fn from(value: ThreadSource) -> Self
```

**Purpose**: This converts the app-server protocol's `ThreadSource` back into the core protocol type. It is needed when API-facing data must be passed into core code that expects its own type.

**Data flow**: It receives a `ThreadSource` value. It maps user, subagent, feature, and memory-consolidation cases to the matching core variants, carrying the feature name along when present. The output is a `CoreThreadSource` ready for lower-level protocol logic.

**Call relations**: This is the reverse of `ThreadSource::from`. It is part of the bridge between the app-server protocol and the core protocol, and it uses the core `Feature` variant when the source includes a feature name.

*Call graph*: 1 external calls (Feature).


### `app-server-protocol/src/protocol/v2/thread.rs`

`data_model` · `cross-cutting`

A “thread” here is a saved conversation or work session with the agent. This file does not run the thread itself. Instead, it defines the data envelopes that travel between the app server and its clients, much like standardized forms at a service desk. Without these definitions, the client and server could disagree about field names, optional values, pagination cursors, permission settings, token usage, or status updates.

Most of the file is made of request and response types. For example, there are structures for starting a thread, resuming one from disk or history, forking one into a new thread, changing settings, archiving or deleting, listing turns, listing background terminal processes, and updating goals or metadata. Many fields are optional so a client can say “leave this unchanged,” while a few use a special nested optional form so the client can distinguish “not provided” from “clear this value.”

The file also defines notification messages that the server can send when something changes, such as a thread starting, being archived, changing status, or using more tokens. Several types are marked experimental, meaning the API can expose them only when the client has opted into that feature. A small number of conversion functions translate lower-level core protocol types into these public v2 API types, keeping the external API stable even if internal storage uses different Rust types.

#### Function details

##### `TurnsPage::from`  (lines 425–431)

```
fn from(response: ThreadTurnsListResponse) -> Self
```

**Purpose**: Turns a full thread-turns-list response into the smaller page object used inside a resume response. This lets the resume API include an initial page of turns without inventing a second shape for the same paging data.

**Data flow**: It receives a ThreadTurnsListResponse containing a list of turns plus forward and backward pagination cursors. It copies those three pieces into a TurnsPage. The result is a page with the same turn data and cursors, but under the type expected by thread resume responses.

**Call relations**: This conversion is used when code already has the normal result of listing turns and needs to place it into the optional initialTurnsPage field of a resume response. It acts as a small adapter between the standalone turns-list API and the resume API bootstrap flow.


##### `ThreadGoal::from`  (lines 682–693)

```
fn from(value: codex_protocol::protocol::ThreadGoal) -> Self
```

**Purpose**: Converts an internal core thread goal into the v2 API version that clients receive. This keeps client-facing data simple, including changing the internal thread id into a string.

**Data flow**: It receives a core ThreadGoal with fields such as thread id, objective, status, token budget, tokens used, elapsed time, and timestamps. It copies those values into the v2 ThreadGoal shape, converting the id and status into their API forms. The output is ready to serialize and send to a client.

**Call relations**: The thread_goal_set_inner flow calls this after setting or updating a goal. In that story, the lower-level goal is produced by the core system, then this function repackages it so the API response can return the public v2 version.

*Call graph*: called by 1 (thread_goal_set_inner).


##### `ThreadMemoryMode::as_str`  (lines 814–819)

```
fn as_str(self) -> &'static str
```

**Purpose**: Returns the plain text spelling for a thread memory mode. It is useful when code needs a stable string such as "enabled" or "disabled" for display, logging, or protocol-adjacent decisions.

**Data flow**: It receives a ThreadMemoryMode value. If the value is Enabled, it returns the string "enabled"; if it is Disabled, it returns "disabled". It does not change anything else.

**Call relations**: This is a helper attached to the ThreadMemoryMode enum. Other code can call it whenever it needs the API mode represented as a simple lowercase word rather than as a Rust enum value.


##### `ThreadMemoryMode::to_core`  (lines 821–826)

```
fn to_core(self) -> codex_protocol::protocol::ThreadMemoryMode
```

**Purpose**: Converts the v2 API memory-mode value into the matching core protocol value. This lets the public API type be accepted by lower-level code that expects the internal representation.

**Data flow**: It receives a v2 ThreadMemoryMode, checks whether it is Enabled or Disabled, and returns the corresponding codex_protocol core ThreadMemoryMode. Nothing is stored or modified by this function.

**Call relations**: This function is the bridge from the API layer into the core protocol layer for memory settings. When a client asks to set memory mode, server-side code can use this conversion before handing the value to the part of the system that actually applies the setting.


##### `ThreadTokenUsage::from`  (lines 1299–1305)

```
fn from(value: CoreTokenUsageInfo) -> Self
```

**Purpose**: Converts internal token-usage information into the v2 notification shape sent to clients. Tokens are the chunks of text the model reads and writes, so this lets clients show how much context and output a thread has consumed.

**Data flow**: It receives CoreTokenUsageInfo, which contains total usage, usage for the latest step, and the model context-window size. It converts the total and latest usage into TokenUsageBreakdown values and copies the context-window value. The output is a ThreadTokenUsage object suitable for a thread token usage update notification.

**Call relations**: send_thread_token_usage_update_to_connection calls this when preparing a token-usage update for a connected client. The server gathers core usage numbers, this function reshapes them for v2, and the connection-sending code can then serialize and deliver the notification.

*Call graph*: called by 1 (send_thread_token_usage_update_to_connection).


##### `TokenUsageBreakdown::from`  (lines 1325–1333)

```
fn from(value: CoreTokenUsage) -> Self
```

**Purpose**: Converts one internal token-usage record into the public breakdown clients understand. It preserves the important categories: total, input, cached input, output, and reasoning output tokens.

**Data flow**: It receives a CoreTokenUsage value. It copies each token count into the matching field of TokenUsageBreakdown. The result is a client-facing summary of one slice of token usage, with no side effects.

**Call relations**: This function is used as the smaller building block inside token-usage conversion. When ThreadTokenUsage::from prepares the full usage object, it relies on this conversion for both the total usage and the most recent usage.


### `app-server-protocol/src/protocol/v2/turn.rs`

`data_model` · `request handling and event notification`

A “turn” is one round of interaction with Codex: the user sends text, images, mentions, or skills, and the assistant works until it finishes, is interrupted, or fails. This file describes the data that can cross that boundary. Think of it like a set of labeled forms: one form starts a turn, another adds more input to an active turn, another reports that the plan changed, and so on.

Most of the file is made of serializable types, meaning Rust can turn them into JSON and back. It also exports TypeScript definitions, so browser or app clients can use the same shapes. The start and steer request types include user input plus optional overrides such as working directory, model, sandbox rules, approval routing, reasoning settings, and extra context. Notifications report important events back to clients, such as a turn starting, completing, producing a diff, or updating its plan.

The file also bridges between this public v2 API and the project’s internal “core” types. Small conversion functions translate byte ranges, text elements, user input, and plan step statuses back and forth. That keeps the outside protocol stable while allowing the internal engine to use its own representations.

#### Function details

##### `ByteRange::from`  (lines 220–225)

```
fn from(value: CoreByteRange) -> Self
```

**Purpose**: Converts an internal byte range into the v2 protocol byte range sent to or received from clients. A byte range marks a start and end position inside a text buffer.

**Data flow**: It receives a core byte range with a start and end position. It copies those two numbers into the public v2 `ByteRange`. The result is a protocol-friendly value with the same span.

**Call relations**: This sits at the boundary between the internal user-input model and the v2 API model. When text elements are converted outward, this function supplies the public byte-range shape used inside those elements.


##### `CoreByteRange::from`  (lines 229–234)

```
fn from(value: ByteRange) -> Self
```

**Purpose**: Converts a v2 protocol byte range back into the internal core byte range. This lets client-provided text spans be understood by the engine.

**Data flow**: It receives a public `ByteRange` with start and end positions. It copies those positions into the core byte-range type. The output is ready for internal user-input processing.

**Call relations**: This is the reverse of `ByteRange::from`. It is used as part of converting protocol text elements into the core form that the rest of Codex works with.


##### `TextElement::new`  (lines 248–253)

```
fn new(byte_range: ByteRange, placeholder: Option<String>) -> Self
```

**Purpose**: Creates a text element that points at a span inside a larger text string, with an optional display placeholder. A placeholder is human-readable text the UI can show for a special embedded element.

**Data flow**: It takes a byte range and an optional placeholder string. It stores both in a new `TextElement`. The output is a ready-to-use marker for a special part of a text input.

**Call relations**: The call graph shows this constructor being used by thread-reading and input-related flows, including paste expansion and tests around pending user input. `TextElement::from` also calls it when converting an internal text element into the v2 protocol form.

*Call graph*: called by 4 (thread_read_returns_summary_without_turns, task_finish_emits_turn_item_lifecycle_for_leftover_pending_user_input, text_elements, expand_pending_pastes).


##### `TextElement::set_placeholder`  (lines 255–257)

```
fn set_placeholder(&mut self, placeholder: Option<String>)
```

**Purpose**: Changes the optional placeholder text on an existing text element. This is useful when the same span should remain, but the label shown to a user needs to be added, removed, or replaced.

**Data flow**: It receives a mutable text element and a new optional placeholder. It replaces the old placeholder with the new one. It does not return a separate value; the existing object is changed in place.

**Call relations**: This is a small editing helper for code that already has a `TextElement`. It does not hand off to other functions in the provided call graph.


##### `TextElement::placeholder`  (lines 259–261)

```
fn placeholder(&self) -> Option<&str>
```

**Purpose**: Returns the text element’s placeholder, if it has one, without giving callers ownership of the stored string. This lets callers read the label safely.

**Data flow**: It reads the optional placeholder stored inside the text element. If one exists, it returns it as borrowed text; if not, it returns nothing. The text element itself is unchanged.

**Call relations**: This is a read-only accessor used by code that needs to inspect a text element. It has no listed calls or callers in the provided graph.


##### `TextElement::from`  (lines 265–270)

```
fn from(value: CoreTextElement) -> Self
```

**Purpose**: Converts an internal core text element into the v2 protocol text element. This prepares special text spans to be sent through the public API.

**Data flow**: It receives a core text element. It converts the core byte range into the public byte-range type, reads the core placeholder through its conversion-only accessor, turns that placeholder into an owned string when present, and builds a v2 `TextElement`. The result carries the same span and optional label in protocol form.

**Call relations**: This function calls the core element’s `_placeholder_for_conversion_only` method to read the placeholder, then calls `TextElement::new` to build the public value. It is part of the outward conversion path from internal user input to API user input.

*Call graph*: 2 external calls (_placeholder_for_conversion_only, new).


##### `CoreTextElement::from`  (lines 274–276)

```
fn from(value: TextElement) -> Self
```

**Purpose**: Converts a v2 protocol text element into the internal core text element. This lets special spans received from clients travel into the engine’s own user-input model.

**Data flow**: It receives a public `TextElement`. It converts the byte range into the core byte-range type and passes the placeholder along. The output is a core text element with the same span and optional label.

**Call relations**: This function calls the core `TextElement` constructor to create the internal value. It is used by the inward conversion path when `UserInput::into_core` turns protocol input into core input.

*Call graph*: 1 external calls (new).


##### `UserInput::into_core`  (lines 313–330)

```
fn into_core(self) -> CoreUserInput
```

**Purpose**: Turns v2 user input into the internal input type used by the Codex engine. This is how client-submitted text, images, local images, skills, and mentions enter the core system.

**Data flow**: It consumes a public `UserInput` value. For text, it keeps the text string and converts every text element into the core form. For remote images, it renames the public `url` field into the core `image_url` field. For local images, skills, and mentions, it passes through the relevant paths and names. The output is a core user-input value.

**Call relations**: This function is the main inward bridge for user input in turn start and steer requests. It does not call named project functions in the provided graph beyond the standard conversions for nested text elements.


##### `UserInput::from`  (lines 334–352)

```
fn from(value: CoreUserInput) -> Self
```

**Purpose**: Turns internal core user input into the v2 protocol form. This is used when internal input needs to be shown, stored, or returned through the public API.

**Data flow**: It receives a core user-input value. It maps text, images, local images, skills, and mentions into the matching public variants, converting text elements along the way. If it receives a core variant this v2 protocol does not support, it stops as unreachable because the code expects that case never to be sent here.

**Call relations**: This is the outward bridge paired with `UserInput::into_core`. Its only explicit call in the provided graph is to `unreachable!`, which marks unsupported internal variants as a programming error rather than a normal API case.

*Call graph*: 1 external calls (unreachable!).


##### `UserInput::text_char_count`  (lines 356–364)

```
fn text_char_count(&self) -> usize
```

**Purpose**: Counts how many human-visible characters are in a text input. Non-text inputs count as zero because images, skills, and mentions do not contain freeform message text here.

**Data flow**: It looks at the kind of `UserInput`. If it is text, it counts Unicode characters in the text string. If it is any other input kind, it returns zero. Nothing is changed.

**Call relations**: This is a small helper for code that needs a rough text length from mixed user input. It has no listed calls or callers in the provided graph.


##### `TurnPlanStep::from`  (lines 430–435)

```
fn from(value: CorePlanItemArg) -> Self
```

**Purpose**: Converts an internal plan item into the v2 protocol plan step sent to clients. A plan step is one item in the assistant’s visible checklist of work.

**Data flow**: It receives a core plan item with a step description and status. It copies the description and converts the internal status into the public status enum. The output is a `TurnPlanStep` ready to appear in a plan update notification.

**Call relations**: This function is part of the path that turns internal planning data into `TurnPlanUpdatedNotification` data. It relies on `TurnPlanStepStatus::from` for the status conversion.


##### `TurnPlanStepStatus::from`  (lines 439–445)

```
fn from(value: CorePlanStepStatus) -> Self
```

**Purpose**: Converts an internal plan-step status into the v2 protocol status. The statuses describe whether a plan item is waiting, currently being worked on, or finished.

**Data flow**: It receives a core status: pending, in progress, or completed. It maps that status to the matching public enum value. The output is safe to serialize in the v2 API.

**Call relations**: This supports `TurnPlanStep::from`, which uses it while preparing plan update data for clients. It does not call other functions in the provided graph.


### `app-server-protocol/src/protocol/v2/item.rs`

`data_model` · `request handling`

A client UI needs a clear stream of what the agent is doing: what the user said, what the agent answered, which command is running, whether a patch succeeded, or when the user must approve something risky. This file is the shared dictionary for that stream. It defines the data structures that are serialized to JSON and exported as TypeScript types, so Rust server code and web clients can agree on the exact names and fields.

The central type is `ThreadItem`, which is like a timeline card in a chat: one card might be a user message, another a shell command, another a web search, another a file edit. Around it are smaller types for statuses, approval decisions, patch details, tool-call results, guardian safety reviews, and notifications for “started,” “completed,” or “new text delta arrived.”

Because the server has older or deeper internal types, many functions here convert from those core types into the v2 protocol types, and sometimes back again. Without this file, clients would either receive unstable internal details or have no reliable way to render agent activity, ask for approvals, or route tool responses.

#### Function details

##### `CommandExecutionApprovalDecision::from`  (lines 69–87)

```
fn from(value: CoreReviewDecision) -> Self
```

**Purpose**: Turns the core server’s review decision for a command into the v2 API decision that a client understands. This keeps client-facing wording stable even if the internal approval system uses different names.

**Data flow**: It receives an internal command review decision. It matches each possible outcome, such as approved, denied, aborted, approved for session, or approved with a policy change, and produces the matching v2 approval decision. If the core decision carries a proposed execution or network policy change, that extra data is converted and carried along.

**Call relations**: This conversion is used when approval results move from the internal safety/review system toward the app-server protocol. It hands off any policy amendment details to their own conversion logic so the outgoing payload uses v2 shapes.


##### `MemoryCitation::from`  (lines 137–142)

```
fn from(value: CoreMemoryCitation) -> Self
```

**Purpose**: Converts an internal memory citation into the v2 format shown to clients. A memory citation explains which saved memory or prior thread information supported an agent message.

**Data flow**: It receives a core memory citation containing citation entries and rollout/thread identifiers. It converts each entry into the v2 `MemoryCitationEntry` shape and renames the core rollout identifiers into `thread_ids`. The result is a client-ready citation object.

**Call relations**: This is used when an agent message is converted into a `ThreadItem`. It relies on `MemoryCitationEntry::from` for each individual citation entry.


##### `MemoryCitationEntry::from`  (lines 156–163)

```
fn from(value: CoreMemoryCitationEntry) -> Self
```

**Purpose**: Converts one internal memory citation entry into the v2 entry format. Each entry points to a path, line range, and note that explain the source of remembered information.

**Data flow**: It receives a core citation entry. It copies the path, start line, end line, and explanatory note into the v2 struct. The output is one citation entry suitable for JSON serialization.

**Call relations**: This is called as part of `MemoryCitation::from`, which gathers many entries into the full citation object attached to an agent message.


##### `CommandAction::into_core`  (lines 167–188)

```
fn into_core(self) -> CoreParsedCommand
```

**Purpose**: Converts a client-facing parsed command action back into the core command parser’s type. This is useful when data that came through the v2 protocol must be interpreted by internal command logic.

**Data flow**: It receives a v2 `CommandAction`, such as reading a file, listing files, searching, or an unknown command. It renames fields into the core format and converts absolute paths into regular path buffers where needed. It returns the matching core parsed-command value.

**Call relations**: This function sits on the boundary from the app protocol back into core command understanding. It does not call other project-specific converters, but it preserves the action kind so later internal code can reason about the command.


##### `CommandAction::from_core_with_cwd`  (lines 190–207)

```
fn from_core_with_cwd(value: CoreParsedCommand, cwd: &AbsolutePathBuf) -> Self
```

**Purpose**: Converts an internally parsed command action into the v2 format, using the current working directory to make read paths absolute. This helps clients display file actions clearly and safely.

**Data flow**: It receives a core parsed command and the command’s working directory. For read actions, it joins the relative path from the parser onto the working directory so the client gets an absolute path. Other action types are copied into the matching v2 form. The output is a client-facing `CommandAction`.

**Call relations**: This is used when command details are prepared for display or approval prompts. Its one important handoff is to path joining, because clients should not have to guess what a relative file path means.

*Call graph*: calls 1 internal fn (join).


##### `ThreadItem::id`  (lines 395–416)

```
fn id(&self) -> &str
```

**Purpose**: Returns the identifier for any kind of thread item. This gives callers one simple way to ask, “Which timeline card is this?” without caring whether it is a message, command, file change, or tool call.

**Data flow**: It receives a reference to a `ThreadItem`. It checks which variant it is and returns the shared `id` field from that variant. It does not change the item.

**Call relations**: Any code that works generically with timeline items can call this instead of writing a separate match for every item type. It keeps item identity access consistent across all current `ThreadItem` variants.


##### `AutoReviewDecisionSource::from`  (lines 440–444)

```
fn from(value: CoreGuardianAssessmentDecisionSource) -> Self
```

**Purpose**: Converts the internal source of an automatic approval-review decision into the v2 source type. At present, the only supported source is the agent.

**Data flow**: It receives a core guardian decision source. It maps the internal `Agent` value to the v2 `Agent` value. The result can be placed in an approval-review completion notification.

**Call relations**: This belongs to the guardian approval-review conversion path. It is used when the server reports who or what produced a final automatic review decision.


##### `GuardianRiskLevel::from`  (lines 459–466)

```
fn from(value: CoreGuardianRiskLevel) -> Self
```

**Purpose**: Converts the internal safety risk level into the v2 risk level shown to clients. Risk levels describe how dangerous a reviewed action appears to be.

**Data flow**: It receives a core risk value: low, medium, high, or critical. It returns the matching v2 value with the same meaning. No extra data is added or removed.

**Call relations**: This supports guardian approval-review notifications. It lets the internal safety system report risk in a stable client-facing format.


##### `GuardianUserAuthorization::from`  (lines 481–488)

```
fn from(value: CoreGuardianUserAuthorization) -> Self
```

**Purpose**: Converts the internal estimate of user authorization into the v2 format. This describes how strongly the system believes the user authorized the action.

**Data flow**: It receives a core authorization value: unknown, low, medium, or high. It maps that value directly to the corresponding v2 value. The result can be included in a guardian review payload.

**Call relations**: This is part of the guardian review data path, alongside risk-level and rationale fields. It helps clients display why an automatic approval decision was made.


##### `GuardianCommandSource::from`  (lines 514–519)

```
fn from(value: CoreGuardianCommandSource) -> Self
```

**Purpose**: Converts the internal command source into the v2 command source. This tells clients whether a reviewed command came from the shell path or unified execution path.

**Data flow**: It receives a core guardian command source. It maps `Shell` to `Shell` and `UnifiedExec` to `UnifiedExec`. The output is the v2 enum used in review actions.

**Call relations**: This is used while converting guardian review actions from core into protocol form, especially for command and execve reviews.


##### `CoreGuardianCommandSource::from`  (lines 523–528)

```
fn from(value: GuardianCommandSource) -> Self
```

**Purpose**: Converts a v2 guardian command source back into the core command source. This is needed when a client-facing review action must be turned back into an internal review action.

**Data flow**: It receives a v2 `GuardianCommandSource`. It maps each variant to the matching core variant. The output is ready for core guardian assessment code.

**Call relations**: This is used by `CoreGuardianAssessmentAction::try_from` when converting protocol review actions back into core review actions.


##### `GuardianApprovalReviewAction::from`  (lines 639–696)

```
fn from(value: CoreGuardianAssessmentAction) -> Self
```

**Purpose**: Converts an internal guardian assessment action into the v2 action format. A review action is the thing being judged, such as a command, patch, network access, tool call, or permission request.

**Data flow**: It receives a core guardian action. It matches the action kind, copies its fields, and converts nested values such as command source, network protocol, and requested permissions into v2-compatible forms. The output is a `GuardianApprovalReviewAction` that can be sent to clients.

**Call relations**: This function is used when the server emits guardian approval-review notifications. It hands nested pieces to their own conversion methods so the full review action is safe to serialize through the v2 API.


##### `CoreGuardianAssessmentAction::try_from`  (lines 702–759)

```
fn try_from(value: GuardianApprovalReviewAction) -> Result<Self, Self::Error>
```

**Purpose**: Converts a v2 guardian review action back into the internal core action, returning an error if a nested permission conversion fails. This is the reverse path for data that needs to re-enter the core safety system.

**Data flow**: It receives a v2 guardian review action. It matches the action kind, copies fields into the core form, and converts nested values such as command source, network protocol, and permissions. It returns either a core action or an input/output error if permissions cannot be converted.

**Call relations**: This is the counterpart to `GuardianApprovalReviewAction::from`. It hands permission conversion to the permission profile’s own fallible converter because some client-facing permission shapes may not be valid internally.


##### `WebSearchAction::from`  (lines 783–796)

```
fn from(value: codex_protocol::models::WebSearchAction) -> Self
```

**Purpose**: Converts an internal web-search action into the v2 format. This lets clients show whether the agent searched, opened a page, searched within a page, or did something unknown.

**Data flow**: It receives a core web-search action. It copies search queries, URLs, and find patterns into the matching v2 variant, or maps unknown actions to `Other`. The result is a client-ready description of the web search step.

**Call relations**: This is called when web-search events are converted for the protocol, including from `ThreadItem::from` and from web-search completion handling. It gives those flows a consistent action payload.

*Call graph*: called by 2 (handle_web_search_end, from).


##### `ThreadItem::from`  (lines 800–890)

```
fn from(value: CoreTurnItem) -> Self
```

**Purpose**: Converts an internal turn item into the v2 timeline item that clients display. This is one of the main bridges from the agent engine’s internal event stream to the public app-server protocol.

**Data flow**: It receives a core turn item. Depending on the item kind, it copies IDs and fields, converts nested content such as user inputs, hook fragments, memory citations, file changes, web search actions, MCP tool-call results, and statuses, and calculates durations in milliseconds where available. The output is a `ThreadItem` ready to send in started or completed notifications.

**Call relations**: This conversion is called by item-started and item-completed handlers. It delegates patch conversion to `convert_patch_changes` and uses several `from` conversions in this file so each nested piece becomes the correct v2 shape.

*Call graph*: calls 3 internal fn (convert_patch_changes, from, from); called by 2 (handle_item_completed, handle_item_started).


##### `HookPromptFragment::from`  (lines 894–899)

```
fn from(value: codex_protocol::items::HookPromptFragment) -> Self
```

**Purpose**: Converts one internal hook prompt fragment into the v2 shape. A hook prompt fragment is a piece of prompt text produced by a hook run.

**Data flow**: It receives a core hook prompt fragment. It copies the text and hook run identifier into a v2 `HookPromptFragment`. The result can be included in a `ThreadItem::HookPrompt`.

**Call relations**: This is used inside `ThreadItem::from` when a core hook prompt is turned into a client-visible timeline item.


##### `CommandExecutionStatus::from`  (lines 919–925)

```
fn from(value: &CoreExecCommandStatus) -> Self
```

**Purpose**: Converts an internal command execution status into the v2 status. It tells clients whether a command completed, failed, or was declined.

**Data flow**: One implementation receives the core status by value and forwards to the borrowed-status conversion. The borrowed conversion then maps each core terminal status to its matching v2 status. The result is used in command execution items.

**Call relations**: This supports command execution display and notification payloads. The by-value converter calls the by-reference converter to avoid duplicating the mapping.

*Call graph*: 1 external calls (from).


##### `PatchApplyStatus::from`  (lines 986–992)

```
fn from(value: &CorePatchApplyStatus) -> Self
```

**Purpose**: Converts an internal patch-apply status into the v2 file-change status. This tells clients whether a file edit completed, failed, or was declined.

**Data flow**: One implementation receives the core patch status by value and forwards to the borrowed-status conversion. The borrowed conversion maps each core terminal status to the corresponding v2 status. The output is used in file-change timeline items.

**Call relations**: This is used when core file-change items are converted into `ThreadItem::FileChange`. The by-value path reuses the borrowed conversion for the actual mapping.

*Call graph*: 1 external calls (from).


##### `McpToolCallStatus::from`  (lines 996–1002)

```
fn from(value: CoreMcpToolCallStatus) -> Self
```

**Purpose**: Converts the internal status of an MCP tool call into the v2 status. MCP means Model Context Protocol, a way for the agent to call external tools provided by servers.

**Data flow**: It receives a core MCP tool-call status. It maps in-progress, completed, and failed states to the same meanings in the v2 enum. The result becomes part of a `ThreadItem::McpToolCall`.

**Call relations**: This is called from `ThreadItem::from` while building a client-visible MCP tool-call item. It keeps the timeline status vocabulary consistent with other protocol items.

*Call graph*: called by 1 (from).


##### `SubAgentActivityKind::from`  (lines 1042–1048)

```
fn from(value: CoreSubAgentActivityKind) -> Self
```

**Purpose**: Converts an internal sub-agent activity kind into the v2 form. This records whether a sub-agent started, was interacted with, or was interrupted.

**Data flow**: It receives a core sub-agent activity value. It returns the matching v2 value with the same meaning. No other state is changed.

**Call relations**: This supports timeline items that describe activity from helper or child agents. It is part of the general pattern of translating core event types into stable v2 protocol types.


##### `CollabAgentState::from`  (lines 1073–1104)

```
fn from(value: CoreAgentStatus) -> Self
```

**Purpose**: Converts an internal collaborative agent status into the v2 state shown to clients. It also preserves any human-readable message for completed or errored states.

**Data flow**: It receives a core agent status. For simple states like running, interrupted, shutdown, or not found, it creates a v2 state with no message. For completed and errored states, it carries over the associated message in the appropriate optional field. The output is a `CollabAgentState`.

**Call relations**: This is used by collaboration event flows such as spawn, resume, interaction, close, and server-notification conversion. It lets those flows report the current state of one or more collaborating agents in a uniform client-facing way.

*Call graph*: called by 6 (item_event_to_server_notification, collab_resume_end_maps_to_item_completed_resume_agent, handle_collab_agent_interaction_end, handle_collab_agent_spawn_end, handle_collab_close_end, handle_collab_resume_end).


##### `CommandExecutionRequestApprovalParams::strip_experimental_fields`  (lines 1365–1370)

```
fn strip_experimental_fields(&mut self)
```

**Purpose**: Removes fields that are marked experimental before sending approval parameters to clients that should not receive them. This protects compatibility while the API is still changing.

**Data flow**: It receives a mutable approval-parameter object. It sets the `additional_permissions` field to `None`, leaving the rest of the approval request unchanged. The same object is modified in place.

**Call relations**: This is used on outbound command approval requests when the server needs to hide experimental data. The comment notes that this is a temporary, hand-coded compatibility step rather than a general experimental-field system.


##### `DynamicToolCallOutputContentItem::from`  (lines 1439–1446)

```
fn from(item: DynamicToolCallOutputContentItem) -> Self
```

**Purpose**: Converts a v2 dynamic tool-call output item into the core dynamic-tools format. Dynamic tools can return content such as text or images for the agent to use.

**Data flow**: It receives a v2 output content item. If it is text, it copies the text into the core text variant; if it is an image, it copies the image URL into the core image variant. The result is ready for internal dynamic-tool handling.

**Call relations**: This is the bridge from protocol-level dynamic tool responses back into the core tool system. It preserves the content kind so later agent logic can consume text and images correctly.


### `app-server-protocol/src/protocol/v2/review.rs`

`data_model` · `request handling`

This file is a contract between the client and the server for the “start a review” feature. In plain terms, it says: when a user asks the system to review code, what information must the client send, and what shape will the server’s answer have? Without this file, the two sides could disagree about whether the user wants to review uncommitted files, a branch comparison, a commit, or custom instructions.

The main request type is `ReviewStartParams`. It includes the current conversation thread, the review target, and an optional delivery choice. Delivery means where the review should happen: inline in the same thread, or detached in a new review thread.

The response type, `ReviewStartResponse`, gives back a `Turn`, which represents the started assistant work, plus the thread id where the review is actually running. That matters because detached reviews create a different thread from the original one.

`ReviewTarget` lists the possible things to review. It can mean local uncommitted changes, changes compared with a base branch, one specific commit, or fully custom review instructions. The file also derives serialization, JSON schema, and TypeScript output, so the same message shapes can be used safely across Rust, JSON APIs, and frontend TypeScript code.


### `app-server-protocol/src/protocol/v2/realtime.rs`

`data_model` · `request handling and realtime event streaming`

This file is like the shared form book for a live conversation feature. Both sides need to agree on what a “start realtime session” request looks like, what an audio chunk contains, and what kinds of notifications may arrive while the session is running. Without these definitions, the client and server could send JSON that looks right to one side but cannot be understood by the other.

Most of the file is made of small data types. The request types describe actions a client can take: start realtime for a thread, append audio, append text, append speech-ready text, stop realtime, or list supported voices. The response types are the matching replies. The notification types describe events the backend can push back, such as “started,” “new item added,” transcript text streaming in pieces, final transcript text, output audio, WebRTC connection details, errors, and closure.

The file also exports TypeScript and JSON schema descriptions. In plain terms, that means frontend code and API tools can use the same contract instead of hand-copying it. One important bridge is `ThreadRealtimeAudioChunk`, which mirrors the core protocol’s audio frame type. The two conversion functions let this v2 API type move cleanly to and from the deeper core protocol type.

#### Function details

##### `ThreadRealtimeAudioChunk::from`  (lines 27–42)

```
fn from(value: CoreRealtimeAudioFrame) -> Self
```

**Purpose**: This converts a core realtime audio frame into the v2 API’s thread audio chunk shape. It is used when audio data from the lower-level protocol needs to be exposed through this app-server protocol type.

**Data flow**: It receives a core audio frame containing encoded audio data, sample rate, channel count, optional sample count, and an optional item id. It copies those same pieces into a `ThreadRealtimeAudioChunk`. The result is the same audio information, but packaged in the type used by this v2 thread realtime API.

**Call relations**: This is a bridge between the core realtime protocol and the app-server v2 protocol. When code needs to present core audio as a thread realtime API message, this conversion can be called directly or through Rust’s standard `From`/`Into` conversion pattern.


##### `CoreRealtimeAudioFrame::from`  (lines 46–61)

```
fn from(value: ThreadRealtimeAudioChunk) -> Self
```

**Purpose**: This converts the v2 API’s thread audio chunk back into the core protocol’s audio frame shape. It is used when audio supplied through the app-server API needs to be handed down to the lower-level realtime system.

**Data flow**: It receives a `ThreadRealtimeAudioChunk` with audio data and its basic format details. It moves those fields into a `CoreRealtimeAudioFrame`. The result is the same audio content, now packaged for the core realtime protocol to consume.

**Call relations**: This is the reverse bridge of `ThreadRealtimeAudioChunk::from`. When incoming thread realtime audio must be passed into the core realtime machinery, this conversion turns the public v2 API type into the internal core type, either explicitly or through Rust’s `From`/`Into` conversion pattern.


### V2 account and configuration surfaces
These files cover user/session state, models and apps, permissions and configuration, and the surrounding administrative and feature-management protocol payloads.

### `app-server-protocol/src/protocol/v2/account.rs`

`data_model` · `request handling and account-related notifications`

This file is mostly a dictionary of account-related messages for the v2 protocol. In plain terms, it says: “when a client asks to log in, list sessions, read rate limits, refresh tokens, or receive an account update, this is the exact form of the request or reply.” That matters because the server may be written in Rust while clients may use TypeScript or JSON. Without these shared shapes, both sides could disagree about field names, optional values, or what kinds of account states are possible.

The file covers several account paths: API-key accounts, ChatGPT accounts, and Amazon Bedrock accounts. It also describes login flows, including browser OAuth, device-code login, and an internal token-supplied flow. For multi-account use, it defines sessions, workspaces, switching, and logout messages.

A large part of the file describes usage limits. It exposes snapshots of rate-limit windows, credits, spend-control limits, reset credits, and token-usage summaries. Think of these snapshots like a fuel gauge: they show how much has been used, when the tank resets, and whether special credit or workspace rules are affecting access.

The final piece is translation. The app’s deeper core protocol has its own account and limit types. The small `From` conversions here turn those internal types into the v2 API types, keeping the public protocol stable while the inside of the system can use its own models.

#### Function details

##### `default_bedrock_credential_source`  (lines 38–40)

```
fn default_bedrock_credential_source() -> AmazonBedrockCredentialSource
```

**Purpose**: This supplies the default credential source for an Amazon Bedrock account when a client does not send one. It keeps older or simpler clients working by assuming AWS-managed credentials unless told otherwise.

**Data flow**: No input is provided. The function simply returns the `AwsManaged` credential source value, which is then used as the missing default for the `credential_source` field.

**Call relations**: This function is tied to the Amazon Bedrock account data shape through the serialization settings. When incoming JSON omits the credential source, the deserialization process calls this helper so the account object still has a clear, usable value.


##### `Account::from`  (lines 43–51)

```
fn from(account: ProviderAccount) -> Self
```

**Purpose**: This converts an internal provider account into the public v2 `Account` form that clients understand. It preserves the account kind and carries over the small amount of account-specific detail, such as ChatGPT email and plan type.

**Data flow**: It receives a `ProviderAccount` from the core account layer. It checks which kind it is: API key, ChatGPT, or Amazon Bedrock. It then builds the matching v2 `Account` value with the same relevant fields and returns it.

**Call relations**: This sits at the boundary between internal account state and the API protocol. When account information needs to be sent out through v2 responses or notifications, this conversion adapts the core model into the client-facing model.


##### `RateLimitSnapshot::from`  (lines 422–435)

```
fn from(value: CoreRateLimitSnapshot) -> Self
```

**Purpose**: This converts the core system’s rate-limit snapshot into the v2 protocol snapshot sent to clients. It keeps the same overall meaning while translating nested pieces, such as windows, credits, and spend-control limits, into their v2 forms.

**Data flow**: It receives a core `RateLimitSnapshot` containing optional fields about limit identity, time windows, credits, plan type, and why a limit was reached. It copies simple fields directly and converts nested core values into v2 values when they are present. The output is a v2 `RateLimitSnapshot` ready for API responses or notifications.

**Call relations**: This function is used when the server reports account rate-limit status through the v2 protocol. It hands nested conversion work to `RateLimitWindow::from`, `CreditsSnapshot::from`, `SpendControlLimitSnapshot::from`, and `RateLimitReachedType::from` so each smaller piece is translated consistently.


##### `RateLimitReachedType::from`  (lines 450–466)

```
fn from(value: CoreRateLimitReachedType) -> Self
```

**Purpose**: This converts the core explanation for a reached limit into the v2 explanation clients receive. The explanation distinguishes between general rate limits, depleted credits, and workspace owner or member usage-limit cases.

**Data flow**: It takes a core `RateLimitReachedType` value. It matches the exact reason and returns the corresponding v2 `RateLimitReachedType` value with the same meaning.

**Call relations**: This is called as part of building a v2 `RateLimitSnapshot` when the core snapshot says a limit has been reached. It keeps the public-facing reason aligned with the internal reason without exposing the internal type directly.


##### `CoreRateLimitReachedType::from`  (lines 470–486)

```
fn from(value: RateLimitReachedType) -> Self
```

**Purpose**: This converts a v2 rate-limit-reached reason back into the core protocol’s version of that reason. It is useful when client-facing values need to be passed back into internal logic without losing the exact meaning.

**Data flow**: It receives a v2 `RateLimitReachedType`. It checks which reason it represents and returns the matching core `CoreRateLimitReachedType`.

**Call relations**: This is the reverse companion to `RateLimitReachedType::from`. Together they let code move the same set of limit-reached reasons across the API boundary in either direction.


##### `RateLimitWindow::from`  (lines 501–507)

```
fn from(value: CoreRateLimitWindow) -> Self
```

**Purpose**: This converts one core rate-limit time window into the simpler v2 window shown to clients. A window describes how much of a limit has been used and when that window resets.

**Data flow**: It receives a core `RateLimitWindow` with a usage percentage, optional window length, and optional reset time. It rounds the usage percentage to a whole number, copies the timing fields, and returns the v2 `RateLimitWindow`.

**Call relations**: This is called while converting a full `RateLimitSnapshot`. It handles the small but important detail of presenting usage as an integer percentage, which is easier for clients to display.


##### `CreditsSnapshot::from`  (lines 520–526)

```
fn from(value: CoreCreditsSnapshot) -> Self
```

**Purpose**: This converts the core view of account credits into the v2 credit snapshot sent to clients. It tells the client whether credits exist, whether they are unlimited, and what balance text should be shown if available.

**Data flow**: It receives a core `CreditsSnapshot`. It copies `has_credits`, `unlimited`, and `balance` into a new v2 `CreditsSnapshot`, then returns it.

**Call relations**: This is used inside `RateLimitSnapshot::from` when the core rate-limit data includes credit information. It keeps credit display data moving cleanly from the account system to the v2 API.


##### `SpendControlLimitSnapshot::from`  (lines 541–548)

```
fn from(value: CoreSpendControlLimitSnapshot) -> Self
```

**Purpose**: This converts the core spend-control limit information into the v2 form clients can display. Spend-control limits are account or workspace spending caps, separate from ordinary short-term rate limits.

**Data flow**: It receives a core `SpendControlLimitSnapshot` with the configured limit, amount used, remaining percentage, and reset time. It copies those values into the v2 `SpendControlLimitSnapshot` and returns it.

**Call relations**: This is called while converting a full `RateLimitSnapshot` when individual spend-control information is present. It lets the public v2 response include spending-cap details without exposing the internal core type.


### `app-server-protocol/src/protocol/v2/model.rs`

`data_model` · `request handling and API serialization`

This file is mostly a set of data definitions for the app server's model API. Think of it like a set of blank forms: one form asks for a page of models, another form returns the model list, another announces that a request was rerouted from one model to another. These forms matter because both sides of the API need to agree on the same field names and meanings.

The structs are marked so they can be turned into JSON, read back from JSON, described in a JSON schema, and exported as TypeScript types. In plain terms, Rust, web clients, and documentation tools can all share the same contract. The `camelCase` setting means fields like `next_cursor` become `nextCursor` in the API, matching common JavaScript style.

The file defines request and response types for reading provider capabilities and listing models. A `Model` includes display text, availability notes, upgrade information, supported reasoning effort levels, input types, service tiers, and whether it is the default. It also defines notification payloads for model rerouting, model verification, and moderation metadata.

Two enums are copied from the core protocol into this v2 protocol layer. This keeps the external API stable while still reusing the deeper shared model definitions.

#### Function details

##### `ModelAvailabilityNux::from`  (lines 63–67)

```
fn from(value: CoreModelAvailabilityNux) -> Self
```

**Purpose**: This converts a core protocol `ModelAvailabilityNux` value into the version 2 API version of the same idea. A “NUX” message is a new-user-experience note, such as text explaining model availability to the user.

**Data flow**: It receives a core availability note containing a message. It copies that message into the v2 API struct. The result is a `ModelAvailabilityNux` value ready to be included in a v2 API response.

**Call relations**: This function is used automatically through Rust's `From` conversion pattern whenever code needs to translate core model data into the v2 protocol shape. It sits at the boundary between internal protocol data and the public v2 API data, making sure the client receives the expected field layout.


### `app-server-protocol/src/protocol/v2/apps.rs`

`data_model` · `request handling and protocol serialization`

This file is mostly a set of data definitions for an experimental API that lists available apps or connectors. Think of it like a printed form: it does not fetch apps itself, but it defines exactly which boxes exist on the form, such as app name, logo, install link, category, screenshots, and whether the app is enabled.

The types are prepared for several audiences at once. They can be serialized and deserialized, meaning converted to and from data sent over the wire, usually JSON. They also produce JSON Schema and TypeScript definitions, which helps other parts of the system and front-end code agree on the same message format.

The request type, AppsListParams, lets a caller ask for a page of apps, optionally continuing from a cursor, setting a limit, checking feature access for a thread, or forcing fresh data instead of cached data. The response types carry either a full list of AppInfo records or a notification that the list changed.

There is one small piece of behavior: AppInfo can choose a clean category for an app. It first looks at branding, then falls back to metadata categories, ignoring blank strings. AppSummary then uses that helper to create a smaller, simpler version of an app record for plugin responses.

#### Function details

##### `AppInfo::category`  (lines 106–120)

```
fn category(&self) -> Option<String>
```

**Purpose**: This method picks the best display category for an app. It prefers the category in the app's branding, but if that is missing or blank, it looks through the app metadata categories for the first usable one.

**Data flow**: It starts with one AppInfo record. It reads the optional branding category, trims and checks it through non_empty_category, and returns it if it is meaningful. If not, it reads the optional metadata category list, checks each category the same way, and returns the first non-blank category. If nothing usable exists, it returns no category.

**Call relations**: This is used when a full AppInfo is turned into an AppSummary. In that flow, AppSummary::from asks AppInfo::category for a clean category so the summary does not expose empty or misleading category text.

*Call graph*: called by 1 (from).


##### `non_empty_category`  (lines 123–130)

```
fn non_empty_category(category: Option<&str>) -> Option<String>
```

**Purpose**: This helper turns an optional category string into a clean category value only if it contains real text. It prevents blank strings, including strings that are only spaces, from being treated as valid categories.

**Data flow**: It receives either no category or a borrowed category string. If there is no string, it returns no category. If there is a string, it trims whitespace from the ends; an empty result becomes no category, while a real value is copied into a new String and returned.

**Call relations**: AppInfo::category relies on this helper whenever it checks branding or metadata categories. It acts like a small filter at the gate, allowing only meaningful category names into the final app summary.


##### `AppSummary::from`  (lines 145–154)

```
fn from(value: AppInfo) -> Self
```

**Purpose**: This conversion creates a smaller AppSummary from a full AppInfo. It keeps only the fields needed for a compact plugin-facing response: id, name, description, install URL, and a cleaned-up category.

**Data flow**: It takes ownership of a full AppInfo record. Before moving fields out of it, it asks AppInfo::category to calculate the best category. Then it builds a new AppSummary using selected fields from the original app and the computed category. The output is the smaller summary object.

**Call relations**: This function is used whenever code wants to present app information in a shorter form. During that conversion, it hands category selection to AppInfo::category so the summary gets the same category-cleaning behavior as the full app model.

*Call graph*: calls 1 internal fn (category).


### `app-server-protocol/src/protocol/v2/collaboration_mode.rs`

`data_model` · `request handling`

This file is part of the app server’s public protocol: the set of messages the server and client agree to exchange. Its job is to describe, in a stable and serializable form, what a collaboration mode preset looks like when sent over the API.

A collaboration mode preset is like a saved profile for how the assistant should work. It can include a human-readable name, an optional mode, an optional model name, and an optional reasoning effort setting. The file defines three message types: an empty request for asking for the list, one item of preset metadata, and the response containing a list of those items.

The types derive serialization support, which means they can be turned into JSON and read back from JSON. They also derive schema and TypeScript export support, so client developers can get matching type definitions instead of guessing the response format.

One small but important bridge is included: converting the core application’s internal collaboration mode data into this API-facing version. That keeps the public protocol separate from the internal configuration types, while still making it easy to send the internal data to clients.

#### Function details

##### `CollaborationModeMask::from`  (lines 29–36)

```
fn from(value: CoreCollaborationModeMask) -> Self
```

**Purpose**: This converts an internal collaboration mode preset into the version used by the app server protocol. It is used when the server has core configuration data and needs to send it to a client in the API’s expected shape.

**Data flow**: It receives a core collaboration mode preset containing a name and optional settings. It copies those fields into a protocol-facing `CollaborationModeMask`. The result is a value ready to be placed in an API response and serialized, for example as JSON.

**Call relations**: This function is the bridge between the core configuration layer and the protocol layer. When code builds a collaboration mode list response, it can call this conversion so internal preset data becomes client-facing preset metadata without duplicating field-copying logic elsewhere.


### `app-server-protocol/src/protocol/v2/permissions.rs`

`data_model` · `cross-cutting: used when reading, writing, and converting permission data during requests, settings sync, and approvals`

This file is a border checkpoint between the app-server protocol and the core permission engine. Clients speak in versioned JSON-friendly objects, while the core code uses its own Rust types. This file keeps those two worlds aligned.

The main idea is simple: describe permission choices in a form that can safely travel over an API, then convert them into the stricter internal form before the system acts on them. It covers network permissions, file-system permissions, active permission profiles, sandbox policies, and small policy changes such as allowing a command or a network host.

A lot of the code is translation. For example, a file permission may arrive as a legacy path string, a glob pattern, or a special path such as project roots or temporary directories. The file turns that into the core representation, reporting an input error if a path cannot be understood. It also does the reverse when sending information back to clients.

One important detail is backward compatibility. Some old fields are still accepted or emitted, but newer fields are preferred. For sandbox policies, the file explicitly rejects old “restricted read” settings and tells callers to use permission profiles instead. Without this file, clients and the core would disagree about what a permission request means, which could lead to broken requests or unsafe access decisions.

#### Function details

##### `NetworkApprovalContext::from`  (lines 47–52)

```
fn from(value: CoreNetworkApprovalContext) -> Self
```

**Purpose**: Builds the public version 2 network approval context from the core network approval context. This is used when the server needs to describe a network request to an API client.

**Data flow**: It receives a core object containing a host name and a protocol. It copies the host text and converts the protocol into the version 2 protocol enum. It returns the API-facing context object.

**Call relations**: This sits at the boundary where core approval information is prepared for protocol output. It does not call other project functions directly except the standard conversion for the protocol value.


##### `AdditionalFileSystemPermissions::from`  (lines 73–124)

```
fn from(value: CoreFileSystemPermissions<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts core file-system permission additions into the version 2 API form. It also fills the newer entry-based field even when the core data came from older separate read and write root lists.

**Data flow**: It receives core file permissions based on absolute paths. If the permissions can be expressed as old read/write root lists, it turns those roots into legacy path strings and also creates matching sandbox entries. Otherwise, it converts each existing core sandbox entry into the API entry form and carries over the glob scan depth. It returns an API permission object.

**Call relations**: This function calls the core helper that detects legacy read/write roots, and it preallocates space for generated entries. Tests call it to make sure legacy roots populate entries and modern canonical entries are preserved.

*Call graph*: called by 2 (additional_file_system_permissions_populates_entries_for_legacy_roots, additional_file_system_permissions_preserves_canonical_entries); 2 external calls (legacy_read_write_roots, with_capacity).


##### `CoreFileSystemPermissions::try_from`  (lines 131–171)

```
fn try_from(value: AdditionalFileSystemPermissions) -> Result<Self, Self::Error>
```

**Purpose**: Converts version 2 file-system permission additions back into the core form, checking that any path strings can be understood as real absolute paths. Someone would use this before applying client-requested file permissions inside the core system.

**Data flow**: It receives an API permission object. If the newer entries field is present, it converts each entry into a core sandbox entry. If entries are absent, it falls back to old read and write lists, converts their legacy path strings through native path URI rules into absolute paths, and builds core permissions from those roots. It then copies the optional glob scan depth and returns either core permissions or an input error.

**Call relations**: This is the inward half of the protocol boundary. It calls the core constructor for legacy read/write roots when old fields are used, and it is used by higher-level profile conversions when client data must become core data.

*Call graph*: 1 external calls (from_read_write_roots).


##### `AdditionalNetworkPermissions::from`  (lines 182–186)

```
fn from(value: CoreNetworkPermissions) -> Self
```

**Purpose**: Converts core network permission additions into the version 2 API form. It preserves whether network access is explicitly enabled, disabled, or left unspecified.

**Data flow**: It receives core network permissions with an optional enabled flag. It copies that flag into the API object and returns it.

**Call relations**: This small converter is used by profile conversions when network permission data is being sent outward to clients.


##### `CoreNetworkPermissions::from`  (lines 190–194)

```
fn from(value: AdditionalNetworkPermissions) -> Self
```

**Purpose**: Converts version 2 network permission additions into the core form. This lets client-supplied network permission settings be used by the permission engine.

**Data flow**: It receives the API object with an optional enabled flag. It copies that flag into the core object and returns it.

**Call relations**: This is used by request and profile conversions when network permission data moves from the API layer into core logic.


##### `RequestPermissionProfile::from`  (lines 208–213)

```
fn from(value: CoreRequestPermissionProfile) -> Self
```

**Purpose**: Turns a core request permission profile into the version 2 API shape. This is useful when the server needs to show a client what extra permissions are being requested.

**Data flow**: It receives a core request profile. If network permissions are present, it converts them to API network permissions. If file-system permissions are present, it converts them to API file-system permissions. It returns the API request profile.

**Call relations**: This function composes the smaller network and file-system converters so a whole request profile can cross from core code to protocol output.


##### `CoreRequestPermissionProfile::try_from`  (lines 219–227)

```
fn try_from(value: RequestPermissionProfile) -> Result<Self, Self::Error>
```

**Purpose**: Turns a version 2 request permission profile into the core request profile, validating file paths along the way. This is needed before the core can decide whether to grant requested permissions.

**Data flow**: It receives an API request profile. It converts any network section directly and tries to convert any file-system section, which may fail if a path is invalid. It returns either a core request profile or an input error.

**Call relations**: This function composes the inward network and file-system converters. It is part of the approval/request path where client-provided permission requests become internal permission data.


##### `FileSystemSpecialPath::from`  (lines 258–267)

```
fn from(value: CoreFileSystemSpecialPath) -> Self
```

**Purpose**: Converts a core special file-system location into the version 2 API enum. Special locations are named places like project roots, the system temporary directory, or the root of the file system.

**Data flow**: It receives a core special-path value. It matches the exact variant and copies any attached subpath or unknown-path text. It returns the matching API special-path value.

**Call relations**: This supports file path conversion when core file-system rules need to be described to clients.


##### `CoreFileSystemSpecialPath::from`  (lines 271–280)

```
fn from(value: FileSystemSpecialPath) -> Self
```

**Purpose**: Converts a version 2 special file-system location into the core enum. This lets client-provided special locations be used by the core permission engine.

**Data flow**: It receives an API special-path value. It matches the variant and copies any attached subpath or unknown-path text. It returns the matching core special-path value.

**Call relations**: This supports file path conversion when API file-system rules are accepted into core data.


##### `FileSystemPath::from`  (lines 296–306)

```
fn from(value: CoreFileSystemPath<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts a core file-system path rule into the version 2 API form. The rule may be a concrete path, a glob pattern, or a named special location.

**Data flow**: It receives a core path rule. For a concrete path, it turns the absolute path into the legacy app path string used by this API. For a glob pattern, it copies the pattern. For a special path, it converts the special-path value. It returns the API path rule.

**Call relations**: This function calls path-string conversion for absolute paths and delegates special-path conversion when needed. It is used inside sandbox entry and permission conversions that send file rules outward.

*Call graph*: calls 1 internal fn (from_abs_path); 1 external calls (into).


##### `CoreFileSystemPath::try_from`  (lines 313–326)

```
fn try_from(value: FileSystemPath) -> Result<Self, Self::Error>
```

**Purpose**: Converts a version 2 file-system path rule into the core form, validating concrete paths. This protects the core from receiving path strings it cannot safely interpret.

**Data flow**: It receives an API path rule. For a concrete path, it parses the legacy path string using the native path convention and turns it into an absolute path. For a glob pattern, it copies the pattern. For a special path, it converts the special-path value. It returns either a core path rule or an input error.

**Call relations**: This function calls the native path-convention helper for concrete paths and delegates special-path conversion when needed. It is used by sandbox entry conversion before file permissions enter the core.

*Call graph*: calls 1 internal fn (native); 1 external calls (into).


##### `FileSystemSandboxEntry::from`  (lines 339–344)

```
fn from(value: CoreFileSystemSandboxEntry<AbsolutePathBuf>) -> Self
```

**Purpose**: Converts one core file-system sandbox entry into the version 2 API entry. A sandbox entry is one rule saying which path-like target has read, write, or deny access.

**Data flow**: It receives a core entry with a path rule and an access mode. It converts the path rule into the API path form and converts the access mode into the API enum. It returns the API entry.

**Call relations**: This is used by broader file-system permission conversion when a list of core sandbox entries needs to be sent to clients.


##### `CoreFileSystemSandboxEntry::try_from`  (lines 350–355)

```
fn try_from(value: FileSystemSandboxEntry) -> Result<Self, Self::Error>
```

**Purpose**: Converts one version 2 sandbox entry into the core entry, checking the path part if needed. This is used before the core applies a client-supplied file access rule.

**Data flow**: It receives an API entry with a path rule and an access mode. It tries to convert the path rule into the core form and converts the access mode into the core enum. It returns either the core entry or an input error.

**Call relations**: This is called by file-system permission conversion when entry-based file rules are accepted from the API.


##### `ActivePermissionProfile::new`  (lines 407–412)

```
fn new(id: impl Into<String>) -> Self
```

**Purpose**: Creates an active permission profile from just an identifier. It is a convenience for saying “use this named profile” when there is no explicit parent profile attached.

**Data flow**: It receives anything that can become text, such as a string. It stores that text as the profile id and sets the parent profile field to none. It returns the new active profile.

**Call relations**: Many tests and flows call this when selecting or updating a permission profile by id, including active profile selection, embedded turn permissions, auto-review mode, and settings update scenarios.

*Call graph*: called by 24 (permission_snapshot_setter_preserves_permission_constraints, session_configuration_apply_rebinds_symbolic_profile_to_updated_workspace_roots, active_profile_selection_uses_profile_id_only, auto_review_mode, override_turn_context_sends_thread_settings_update, permission_settings_sync_updates_active_snapshot_without_rewriting_side_thread, embedded_turn_permissions_select_profile_id_only, embedded_turn_permissions_use_active_profile_selection, remote_turn_permissions_preserve_active_profile_selection, submission_includes_configured_active_permission_profile (+14 more)); 1 external calls (into).


##### `ActivePermissionProfile::read_only`  (lines 414–416)

```
fn read_only() -> Self
```

**Purpose**: Creates the built-in read-only active permission profile in the version 2 API form. This gives callers a safe default profile without needing to know its internal id details.

**Data flow**: It asks the core model for its read-only profile, then converts that core profile into the API profile type. It returns the API active profile.

**Call relations**: Callers use this in settings, status, and test flows that need the standard read-only profile. It delegates the actual built-in definition to the core type.

*Call graph*: called by 4 (inactive_thread_settings_notification_updates_cached_collaboration_mode, thread_settings_for_test, status_permissions_named_read_only_profile_shows_builtin_label, status_permissions_read_only_profile_shows_additional_writable_roots); 1 external calls (read_only).


##### `ActivePermissionProfile::from`  (lines 420–425)

```
fn from(value: CoreActivePermissionProfile) -> Self
```

**Purpose**: Converts a core active permission profile into the version 2 API profile. This is used when reporting the currently selected permission profile to clients.

**Data flow**: It receives the core profile with an id and optional parent profile id. It copies both fields into the API type and returns it.

**Call relations**: This is the outward profile conversion used wherever core session or permission state is exposed through the version 2 protocol.


##### `CoreActivePermissionProfile::from`  (lines 429–434)

```
fn from(value: ActivePermissionProfile) -> Self
```

**Purpose**: Converts a version 2 active permission profile into the core profile. This lets the core use a profile selection that came from the API layer.

**Data flow**: It receives the API profile with an id and optional parent profile id. It copies both fields into the core type and returns it.

**Call relations**: This is the inward profile conversion used when client or protocol data must update core permission state.


##### `AdditionalPermissionProfile::from`  (lines 448–453)

```
fn from(value: CoreAdditionalPermissionProfile) -> Self
```

**Purpose**: Converts a core additional permission profile into the version 2 API form. Additional profiles are partial overlays, such as extra permissions requested for one command.

**Data flow**: It receives a core additional profile. It converts any network section and any file-system section into their API forms. It returns the API additional profile.

**Call relations**: This function combines the smaller network and file-system converters when extra permissions need to be shown to the client.


##### `CoreAdditionalPermissionProfile::try_from`  (lines 485–493)

```
fn try_from(value: GrantedPermissionProfile) -> Result<Self, Self::Error>
```

**Purpose**: Converts a granted version 2 permission profile into the core additional permission profile, validating file paths if present. This is used after a client approves extra permissions so the core can apply them.

**Data flow**: It receives a granted permission profile with optional network and file-system sections. It converts the network section directly and tries to convert the file-system section, which may return an input error for invalid paths. It returns either the core additional profile or an error.

**Call relations**: This is part of the approval path after a response comes back from a client. It reuses the lower-level converters so granted permissions match the core permission engine’s format.


##### `SandboxPolicy::deserialize`  (lines 576–616)

```
fn deserialize(deserializer: D) -> Result<Self, D::Error>
```

**Purpose**: Reads a sandbox policy from incoming data while keeping some backward compatibility and rejecting old unsafe or unsupported fields. A sandbox policy describes how tightly command execution is boxed in, like full access, read-only, or workspace-write access.

**Data flow**: It receives serialized input from Serde, Rust’s common serialization library. It first reads into a helper enum that includes legacy fields. It then maps that helper into the current SandboxPolicy. If an old restricted-read field is present, it returns a clear deserialization error telling the caller to use permission profiles instead.

**Call relations**: Serde calls this automatically whenever a SandboxPolicy is deserialized. Inside, it calls the helper deserializer and creates custom error messages for unsupported legacy settings.

*Call graph*: 3 external calls (deserialize, custom, matches!).


##### `SandboxPolicy::to_core`  (lines 620–650)

```
fn to_core(&self) -> codex_protocol::protocol::SandboxPolicy
```

**Purpose**: Converts the version 2 sandbox policy into the core sandbox policy. This is needed before the core can actually run commands under the chosen sandbox rules.

**Data flow**: It reads the API sandbox variant. It copies booleans and writable roots, and for the external sandbox network setting it maps the API network access enum to the core enum. It returns the matching core sandbox policy.

**Call relations**: This function is called when displaying or deriving permission profile information from a thread response. It is the inward bridge from protocol sandbox settings to the core runtime policy.

*Call graph*: called by 1 (display_permission_profile_from_thread_response).


##### `SandboxPolicy::from`  (lines 654–682)

```
fn from(value: codex_protocol::protocol::SandboxPolicy) -> Self
```

**Purpose**: Converts a core sandbox policy into the version 2 API form. This lets the server report the active sandbox setup to clients.

**Data flow**: It receives a core sandbox policy. It matches the variant, copies roots and flags, and maps the core external-sandbox network access enum into the API enum. It returns the API sandbox policy.

**Call relations**: Tests call this to confirm sandbox policies round-trip correctly, including read-only, workspace-write, and external sandbox network access. It is also used when configured session state is synced to client-facing settings.

*Call graph*: called by 5 (sandbox_policy_round_trips_external_sandbox_network_access, sandbox_policy_round_trips_read_only_network_access, sandbox_policy_round_trips_workspace_write_access, session_configured_external_sandbox_keeps_external_runtime_policy, session_configured_syncs_widget_config_permissions_and_cwd).


##### `ExecPolicyAmendment::into_core`  (lines 693–695)

```
fn into_core(self) -> CoreExecPolicyAmendment
```

**Purpose**: Turns a version 2 execution policy amendment into the core form. An execution policy amendment is a command prefix that should be allowed or recognized by policy.

**Data flow**: It consumes the API object containing a list of command words. It passes that list to the core constructor. It returns the core execution policy amendment.

**Call relations**: This is used when an API-level command policy change needs to be applied by the core policy code. It delegates construction and validation rules to the core type.

*Call graph*: 1 external calls (new).


##### `ExecPolicyAmendment::from`  (lines 699–703)

```
fn from(value: CoreExecPolicyAmendment) -> Self
```

**Purpose**: Converts a core execution policy amendment into the version 2 API form. This is useful when reporting stored or updated command policy changes to clients.

**Data flow**: It receives a core amendment. It asks the core object for its command list, copies that list into a vector, and returns the API amendment.

**Call relations**: Tests call this around appending execution policy amendments, including rejecting empty prefixes and updating policy files. It is the outward bridge for command policy changes.

*Call graph*: called by 2 (append_execpolicy_amendment_rejects_empty_prefix, append_execpolicy_amendment_updates_policy_and_file); 1 external calls (command).


##### `NetworkPolicyAmendment::into_core`  (lines 721–726)

```
fn into_core(self) -> CoreNetworkPolicyAmendment
```

**Purpose**: Turns a version 2 network policy amendment into the core form. A network policy amendment says whether a particular host should be allowed or denied.

**Data flow**: It consumes the API object containing a host and an allow-or-deny action. It copies the host and converts the action enum into the core action. It returns the core amendment.

**Call relations**: This is used when a client-supplied host rule needs to be applied by core network policy code. It delegates action conversion through the enum’s core converter.

*Call graph*: 1 external calls (to_core).


##### `NetworkPolicyAmendment::from`  (lines 730–735)

```
fn from(value: CoreNetworkPolicyAmendment) -> Self
```

**Purpose**: Converts a core network policy amendment into the version 2 API form. This lets clients see host allow/deny rules in the protocol’s stable shape.

**Data flow**: It receives a core amendment with a host and action. It copies the host and converts the core action into the API action enum. It returns the API amendment.

**Call relations**: This is the outward bridge for network policy changes. It calls the action enum conversion so the public API uses its own versioned values rather than exposing core types directly.

*Call graph*: 1 external calls (from).


### `app-server-protocol/src/protocol/v2/config.rs`

`config` · `config read/write and protocol message exchange`

This file is mostly a contract. It does not load config files itself. Instead, it defines the names and shapes of the messages that other parts of the system use when reading, writing, explaining, and importing configuration.

A useful way to think about it is as the form template used by both sides of a conversation. If the client asks to read config, `ConfigReadParams` says what the request may contain, and `ConfigReadResponse` says what the reply will contain. If a setting is written, `ConfigValueWriteParams`, `ConfigBatchWriteParams`, `ConfigWriteResponse`, and related error/status types describe the request and outcome.

The file also models where configuration came from. `ConfigLayerSource` names layers such as system config, user config, project config, session flags, and managed enterprise settings. These layers matter because later, higher-priority layers can override earlier ones.

Many structs derive serialization, JSON schema, and TypeScript generation support. In plain terms, that means the same Rust definitions can be turned into JSON for the wire protocol, machine-checkable schemas, and matching TypeScript types for frontend or client code. Without this file, different parts of the app could disagree about what a config message means, which would make configuration reads, writes, diagnostics, and migrations unreliable.

#### Function details

##### `ConfigLayerSource::precedence`  (lines 102–119)

```
fn precedence(&self) -> i16
```

**Purpose**: This gives each configuration layer a priority number. The number answers a practical question: if two layers set the same option, which layer wins?

**Data flow**: It starts with one `ConfigLayerSource`, such as system config, user config, project config, or command-line session flags. It matches that source to a fixed priority number, with higher numbers meaning stronger override power. It returns that number without changing anything else.

**Call relations**: When two config layers need to be ordered, `ConfigLayerSource::partial_cmp` calls this method for each layer. The returned numbers become the simple basis for deciding which settings can override which others.

*Call graph*: called by 1 (partial_cmp).


##### `ConfigLayerSource::partial_cmp`  (lines 125–127)

```
fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering>
```

**Purpose**: This lets two configuration layer sources be compared according to their override priority. It makes ordinary comparison or sorting use the same rule as the config system: lower-priority layers come before higher-priority layers.

**Data flow**: It receives two layer sources: `self` and `other`. It asks each one for its precedence number, compares those numbers, and returns the ordering result. It does not inspect or merge the actual config values.

**Call relations**: This function is the comparison hook for `ConfigLayerSource`. Its whole job is to delegate the real priority decision to `ConfigLayerSource::precedence` for both sides, then hand that ordering back to whatever code is comparing layers.

*Call graph*: calls 1 internal fn (precedence); 1 external calls (precedence).


##### `ForcedChatgptWorkspaceIds::into_vec`  (lines 232–237)

```
fn into_vec(self) -> Vec<String>
```

**Purpose**: This normalizes an older flexible API shape into one simple list of workspace IDs. It lets callers treat both a single workspace ID and multiple workspace IDs the same way.

**Data flow**: It takes ownership of a `ForcedChatgptWorkspaceIds` value. If the value contains one string, it wraps that string in a one-item list. If it already contains a list, it returns that list as-is.

**Call relations**: This is used after deserializing the backward-compatible workspace restriction field. Instead of making later code check whether it received one ID or many, this function turns both cases into a plain vector before the next step.

*Call graph*: 1 external calls (vec!).


### `app-server-protocol/src/protocol/v2/experimental_feature.rs`

`data_model` · `request handling`

This file does not run behavior by itself. Instead, it defines the message formats for a feature-flag API: a way for users or tools to see which experimental features exist, what state they are in, and whether they are enabled. A feature flag is like a light switch for unfinished or optional product behavior. Without these shared definitions, the server might send fields the client does not understand, or the client might ask for changes in a shape the server cannot read.

The file describes request and response bodies for two main actions. First, a client can ask for a paged list of experimental features. The request can include a cursor, which is an opaque bookmark for continuing from a previous page, a limit for page size, and optionally a thread id so the server can calculate enablement using that thread’s current configuration. The response returns feature entries plus another cursor if more results are available.

Second, a client can send a map of feature names to true-or-false enabled states. Only the named features are changed; missing ones stay as they are. The response echoes the entries that were updated.

The types are also prepared for JSON, JSON Schema, and TypeScript generation. In plain terms, this means the same contract can be checked, documented, and reused by frontend code without hand-copying it.


### `app-server-protocol/src/protocol/v2/plugin.rs`

`data_model` · `request handling`

This file is mostly a dictionary of message formats. When a client asks to list plugins, read a plugin, install one, share one, list skills, or inspect hooks, the server needs a clear agreement about the names and types of every field in the request and response. This file provides that agreement.

The structs describe practical pieces of plugin data: where marketplaces live, which plugins are installed, what a plugin looks like in the UI, which skills it contains, what hooks it registers, and how shared plugins are made visible to users or groups. The enums describe fixed choices, such as whether a plugin can be installed, whether sharing is listed or private, or whether a skill belongs to the user, a repository, the system, or an administrator.

The file also derives JSON serialization, JSON schema, and TypeScript output. In plain terms, that means the same Rust definitions can be turned into network messages, documentation-like schemas, and matching frontend types. This helps prevent the server and user interface from silently disagreeing.

At the end, a few conversion functions translate lower-level core skill data into this v2 API shape. That keeps the public API stable even if the internal skill representation comes from another crate.

#### Function details

##### `SkillMetadata::from`  (lines 800–811)

```
fn from(value: CoreSkillMetadata) -> Self
```

**Purpose**: Turns internal skill metadata from the core protocol into the v2 app-server version that can be returned to clients. This is useful because the server may store or discover skills in one internal format but expose them through a separate public API format.

**Data flow**: It receives one core skill record containing the skill name, description, optional interface details, optional dependency details, path, and scope. It copies the simple fields across, converts nested interface and dependency data into their v2 forms when present, converts the scope into the v2 enum, and marks the exposed skill as enabled. The result is a complete `SkillMetadata` value ready for v2 responses.

**Call relations**: This conversion is used when skill discovery produces core protocol skill records and the app-server needs to send them through the v2 plugin and skills API. While building the public record, it hands nested work to `SkillInterface::from`, `SkillDependencies::from`, and `SkillScope::from` so each smaller piece is translated consistently.


##### `SkillInterface::from`  (lines 815–824)

```
fn from(value: CoreSkillInterface) -> Self
```

**Purpose**: Converts the UI-facing details of a skill from the core format into the v2 API format. These details include things a client might show to a user, such as display name, short description, icons, color, and a default prompt.

**Data flow**: It receives a core skill interface object. It moves each optional display-related field into a new v2 `SkillInterface` object without changing the meaning of the values. The output is the client-facing version of the skill's presentation details.

**Call relations**: This function is called as part of `SkillMetadata::from` whenever a core skill includes interface information. It is the small adapter that lets the larger skill conversion keep presentation fields in the same shape expected by the v2 API.


##### `SkillDependencies::from`  (lines 828–836)

```
fn from(value: CoreSkillDependencies) -> Self
```

**Purpose**: Converts a skill's tool requirements from the core format into the v2 API format. This lets clients see what external tools or services a skill depends on.

**Data flow**: It receives a core dependency object containing a list of tool dependencies. It walks through that list, converts each tool dependency into the v2 shape, collects the converted tools, and returns a new `SkillDependencies` value.

**Call relations**: This function is called by `SkillMetadata::from` when a skill has dependency information. For each individual tool requirement, it delegates to `SkillToolDependency::from`, so the list-level conversion stays simple and each item is translated the same way.


##### `SkillToolDependency::from`  (lines 840–849)

```
fn from(value: CoreSkillToolDependency) -> Self
```

**Purpose**: Converts one tool dependency for a skill from the core representation into the v2 API representation. A tool dependency describes something the skill needs, such as a command, transport, or URL.

**Data flow**: It receives one core tool dependency with fields like type, value, description, transport, command, and URL. It copies those fields into a new v2 `SkillToolDependency` object, preserving optional fields when they exist. The output is one dependency item suitable for client responses.

**Call relations**: This function is called by `SkillDependencies::from` for every tool listed in a skill's dependencies. It is the per-item translator inside the broader dependency conversion flow.


##### `SkillScope::from`  (lines 853–860)

```
fn from(value: CoreSkillScope) -> Self
```

**Purpose**: Converts the internal skill scope into the v2 API skill scope. The scope says where a skill comes from or who controls it, such as user, repository, system, or administrator.

**Data flow**: It receives one core scope value. It matches that value to the equivalent v2 scope value and returns it. No other data is read or changed.

**Call relations**: This function is called by `SkillMetadata::from` while preparing a full skill record for the v2 API. It keeps the public enum separate from the core enum while preserving the same meaning for each scope.


### `app-server-protocol/src/protocol/v2/hook.rs`

`data_model` · `request handling and event notification serialization`

This file is a translation layer between the project’s internal hook records and the public protocol sent to clients. A hook is like a checkpoint script: it can run at certain moments, produce messages, block work, or add context. Clients need a stable, clearly named format for seeing what hooks ran, where they came from, and what happened.

Most of the file defines small named value sets, such as the hook event name, execution mode, source, trust status, run status, and output kind. These are copied from the core protocol into this app-server protocol version, so version 2 can stay stable even if the internal code changes later. The structs then describe the actual messages: a hook output entry is one piece of text from a hook, and a hook run summary is the full report for one hook run, including timing, status, source file path, and all output entries.

The conversion functions turn internal core types into these public version 2 types. That matters because the server should not leak internal data shapes directly to clients. The file also derives JSON serialization and TypeScript schema generation, so the same definitions can be safely used by Rust code, JSON API messages, and frontend TypeScript code.

#### Function details

##### `default_hook_source`  (lines 64–66)

```
fn default_hook_source() -> HookSource
```

**Purpose**: Provides a safe fallback source for older or incomplete hook data that does not say where the hook came from. Instead of failing or leaving the field empty, the API labels it as unknown.

**Data flow**: No input is needed. The function simply returns the `Unknown` hook source value, which is then used as the default when deserializing a `HookRunSummary` that is missing its `source` field.

**Call relations**: This function is tied to the `source` field on `HookRunSummary` through Serde, the JSON reading and writing library. When incoming JSON lacks that field, Serde calls this function so the rest of the hook summary can still be read cleanly.


##### `HookOutputEntry::from`  (lines 89–94)

```
fn from(value: CoreHookOutputEntry) -> Self
```

**Purpose**: Converts one internal hook output entry into the version 2 API form. This is used when the server needs to show clients a warning, error, feedback message, or other text produced by a hook.

**Data flow**: It receives a core hook output entry containing a kind and some text. It converts the kind into the version 2 enum and keeps the text unchanged. The result is a `HookOutputEntry` ready to serialize into the public protocol.

**Call relations**: This conversion is used when building a full `HookRunSummary`. As each internal output entry is encountered, `HookRunSummary::from` hands it to this conversion so the summary contains client-facing entries rather than internal ones.


##### `HookRunSummary::from`  (lines 119–136)

```
fn from(value: CoreHookRunSummary) -> Self
```

**Purpose**: Converts a complete internal hook run report into the version 2 API report that clients can receive. It preserves the important facts: what hook ran, where it came from, when it ran, whether it succeeded, and what it printed.

**Data flow**: It receives a core hook run summary. Simple fields such as IDs, timestamps, messages, and paths are copied across. Enum fields such as event name, mode, scope, source, and status are converted into their version 2 forms. The list of output entries is walked one by one, and each entry is converted with `HookOutputEntry::from`. The result is a `HookRunSummary` suitable for API notifications or responses.

**Call relations**: This is the main bridge from the core hook system into the app-server protocol. When hook started or completed notifications need to include a run summary, this conversion prepares the public version of that summary and delegates each output item to `HookOutputEntry::from`.


### `app-server-protocol/src/protocol/v2/feedback.rs`

`data_model` · `request handling`

This file is like a simple paper form for sending feedback. It does not perform the upload itself. Instead, it defines what information can be sent and what information comes back.

`FeedbackUploadParams` describes the request from a client. It includes the feedback category, an optional written reason, an optional thread ID to connect the feedback to an existing conversation, and a flag saying whether logs should be included. It can also carry extra log file paths and optional tags, which are key-value labels such as environment or feature names. The fields are serialized using camelCase names, meaning Rust-style names like `thread_id` become API-style names like `threadId`.

`FeedbackUploadResponse` describes the server's reply. It returns a `thread_id`, so the client can know which feedback thread was created or used.

The file also derives support for JSON serialization, deserialization, JSON Schema generation, and TypeScript type export. In plain terms, that means the same definitions can be used by Rust code, API documentation or validation tools, and frontend TypeScript code without rewriting the shape by hand.


### `app-server-protocol/src/protocol/v2/attestation.rs`

`data_model` · `request handling`

This file is like a small form template for one protocol action: asking the server to generate an attestation token. An attestation token is an opaque proof string. “Opaque” means code that receives it should pass it along or store it, but should not try to inspect its inside meaning.

There are two data types here. `AttestationGenerateParams` represents the input for the generate request. It is currently empty, which means the client does not need to send any extra fields to ask for a token. Keeping it as a named type still matters because it gives this protocol action a clear place to grow later if parameters are added.

`AttestationGenerateResponse` represents the server’s answer. It contains one field, `token`, which is the generated attestation token string.

The derives on these structs make them usable across the protocol boundary: they can be serialized and deserialized, meaning converted to and from formats like JSON; they can produce JSON Schema for validation or documentation; and they can export TypeScript definitions so frontend or client code can use the same shapes. Field names are set to camelCase to match common JSON and TypeScript style.


### `app-server-protocol/src/protocol/v2/environment.rs`

`data_model` · `protocol definition and request handling`

This file is a small protocol contract. In plain terms, it describes what information must be sent when a client asks the server to add an environment, and what the server sends back afterward. An “environment” here is identified by an `environment_id` and points to an execution server through `exec_server_url`, which is the address where work for that environment can be run.

The important job of this file is consistency. The structs are marked so they can be turned into JSON and read back from JSON using `serde`, which is Rust’s common serialization library. They also produce a JSON Schema, which is a machine-readable description of valid JSON, and TypeScript types, so frontend or client code can use the same contract without guessing.

The `camelCase` setting matters because Rust field names usually use underscores, like `environment_id`, while JSON APIs often use names like `environmentId`. This file bridges that difference automatically. Without this file, different parts of the system could disagree about what an “add environment” request looks like, leading to broken API calls or duplicated type definitions.


### `app-server-protocol/src/protocol/v2/remote_control.rs`

`data_model` · `request handling and protocol serialization`

Remote control needs both sides of the system to agree on exactly what information is sent over the wire. This file is that agreement. It does not open network connections itself or decide whether remote control should be allowed. Instead, it defines the data packets that other code sends and receives.

The file covers several everyday actions: enabling or disabling remote control, telling clients when the connection status changes, starting a pairing flow, checking whether a pairing code has been claimed, listing known remote clients, and revoking one client. The structs are like forms with named fields. For example, a status response includes the current status, the server name, the installation id, and possibly an environment id.

The types derive serialization support, meaning Rust values can be converted to and from formats like JSON. They also derive JSON Schema and TypeScript output, so non-Rust clients can use matching definitions. Field names are converted to camelCase, which is common in JSON and TypeScript.

A small but important detail is the `ephemeral` flag on enable and disable requests. It defaults to false and is skipped when false, keeping older or simpler messages compact. The two conversion functions copy a status notification into response objects, so the same status data can be reused when replying to an enable or disable request.

#### Function details

##### `RemoteControlEnableResponse::from`  (lines 169–182)

```
fn from(notification: RemoteControlStatusChangedNotification) -> Self
```

**Purpose**: This turns a remote-control status notification into the response returned after enabling remote control. It lets the code reuse the same status information instead of rebuilding the response field by field elsewhere.

**Data flow**: It receives a `RemoteControlStatusChangedNotification`, which contains the connection status, server name, installation id, and optional environment id. It takes those four pieces out and places them unchanged into a new `RemoteControlEnableResponse`. The result is a response object ready to be serialized and sent back to the caller.

**Call relations**: When the enable flow has produced or received a status notification, the enable-related code calls this conversion to shape that notification into the expected enable response. In tests or scenario code, the same conversion is used to confirm that enabling remote control returns the same status details clients would see in a status-change notification.

*Call graph*: called by 2 (serve_enable_remote_control_scenario, enable).


##### `RemoteControlDisableResponse::from`  (lines 186–199)

```
fn from(notification: RemoteControlStatusChangedNotification) -> Self
```

**Purpose**: This turns a remote-control status notification into the response returned after disabling remote control. It provides a simple bridge between the general status update format and the specific disable response format.

**Data flow**: It receives a `RemoteControlStatusChangedNotification` with the current status and identity fields. It copies the status, server name, installation id, and optional environment id into a new `RemoteControlDisableResponse`. Nothing is transformed or looked up; the output is the same information in the response type expected by disable callers.

**Call relations**: When the disable flow finishes or receives a status update, it calls this conversion to return a disable response with the latest remote-control state. A compatibility-focused test also uses it in the path that retries disabling without parameters for older servers, so the final reply still has the standard disable-response shape.

*Call graph*: called by 2 (disable_remote_control_retries_without_params_for_older_servers, disable).


### V2 execution and host integration
This set defines the operational RPCs for command execution, processes, filesystem access, MCP integration, and sandbox-specific host interactions.

### `app-server-protocol/src/protocol/v2/command_exec.rs`

`data_model` · `request handling`

This file is like the order form and receipt format for running shell-style commands through the app server. It does not actually start processes itself. Instead, it describes the exact data that travels between a client and the server when a client wants to run a standalone command inside the server’s sandbox, which is the controlled environment that limits what the command can do.

The main request type, `CommandExecParams`, says what command to run, where to run it, what environment variables to use, whether output should be buffered or streamed live, and whether the command should run as a terminal session. It also describes safety and resource controls, such as timeouts, output size limits, and sandbox or permission settings.

Several smaller request and response types cover follow-up actions for a running command. A client can write bytes to stdin, close stdin, resize a pseudo-terminal, or terminate the process. Output can arrive as `CommandExecOutputDeltaNotification` messages, where chunks are base64-encoded so raw bytes can safely travel through JSON text.

The derives on these types make them serializable, deserializable, schema-generating, and exportable to TypeScript. Without this file, different parts of the system could disagree about what a command execution request or response looks like, causing clients and the server to misunderstand each other.


### `app-server-protocol/src/protocol/v2/process.rs`

`data_model` · `request handling`

This file does not run processes itself. Instead, it defines the data structures that travel across the protocol when a client asks the app server to run a command on the server machine. Think of it like a set of standardized forms: one form says “start this command in this folder,” another says “write these bytes to its input,” another says “the process printed this output,” and another says “the process has exited.”

The main request type, `ProcessSpawnParams`, describes everything needed to start a standalone process: the command words, a client-chosen process handle used as a name for later messages, the working directory, optional environment changes, timeouts, output limits, and whether the process should behave like it is attached to a terminal. A PTY, or pseudo-terminal, means the program sees a terminal-like screen instead of plain input and output pipes; `ProcessTerminalSize` describes that screen size in rows and columns.

The other request types describe follow-up actions: writing to stdin, killing the process, or resizing the PTY. The notification types describe messages the server sends back later: output chunks, marked as stdout or stderr, and a final exit report with exit code and any captured output. The structs derive serialization, JSON schema, and TypeScript bindings, so Rust, JSON clients, and TypeScript code all share the same contract.


### `app-server-protocol/src/protocol/v2/fs.rs`

`data_model` · `request handling`

This file is like a set of blank forms for filesystem requests in protocol version 2. It does not actually open, save, delete, or watch files itself. Instead, it defines the data that travels between a client and the server when those actions are requested.

Each struct describes one request or response. For example, `FsReadFileParams` says that a read request must include an absolute path, and `FsReadFileResponse` says the server answers with the file contents encoded as base64. Base64 is a text-safe way to carry raw file bytes through formats like JSON, which are mainly built for text.

The file covers common filesystem operations: reading and writing files, creating directories, getting metadata such as whether a path is a file or directory, listing directory entries, removing paths, copying files or folders, and subscribing to change notifications. Watch requests use a caller-provided `watch_id`, which acts like a ticket number so later change messages or unwatch requests can refer to the same watch.

The derive attributes make these structs serializable and deserializable, meaning they can be turned into protocol messages and read back again. They also generate JSON Schema and TypeScript definitions, helping Rust and TypeScript code stay in sync. Without this file, clients and the server could easily disagree about field names, path formats, or response contents.


### `app-server-protocol/src/protocol/v2/mcp.rs`

`data_model` · `cross-cutting`

MCP, the Model Context Protocol, lets Codex connect to outside tool servers. This file is mostly a dictionary for that part of the system: it names every request, response, notification, and small status value that can cross the app-server protocol boundary. Without it, the server and client could disagree about simple but important things, such as how to ask for a tool call, how to report that OAuth login finished, or how to describe a form that an MCP server wants the user to fill in.

The file covers several everyday flows. A client can list MCP servers and see their tools, resources, templates, and login state. It can read a resource from a named server. It can call a named tool with JSON arguments and receive JSON content back. It can refresh server state or start an OAuth login and receive the authorization URL to open.

A large section describes “elicitation,” which means an MCP server asking the user for more information. That can be a typed form, with fields like strings, numbers, booleans, and selectable options, or a URL-based prompt. The schema types are deliberately strict so clients can safely render forms from them.

Most types derive serialization, JSON schema, and TypeScript export support. In plain terms, the same Rust definitions become both the wire format and the client-facing type definitions, reducing drift between backend and frontend.

#### Function details

##### `McpServerToolCallResponse::from`  (lines 146–153)

```
fn from(result: CoreMcpCallToolResult) -> Self
```

**Purpose**: Turns the core tool-call result into the version 2 response sent over the app-server protocol. Someone uses this when an MCP tool has finished and the result needs to be shaped for API clients.

**Data flow**: It receives a core MCP tool result containing content, optional structured content, an optional error flag, and optional metadata. It copies those fields into the protocol response type. The output is the same information, but wrapped in the public v2 response shape.

**Call relations**: This is a bridge between the lower-level Codex protocol model and the app-server protocol model. After core finishes a tool call, this conversion prepares the data for the client-facing response instead of exposing the core type directly.


##### `McpToolCallResult::from`  (lines 157–163)

```
fn from(result: CoreMcpCallToolResult) -> Self
```

**Purpose**: Turns a core MCP tool-call result into a smaller result type used by this protocol. It keeps the returned content and metadata but does not include the separate error marker used by the full server response.

**Data flow**: It takes a core result with JSON content, optional structured content, an optional error flag, and optional metadata. It keeps the content, structured content, and metadata, and leaves out the error flag. The output is a v2 `McpToolCallResult` value.

**Call relations**: This conversion is used wherever the protocol needs the successful-result-shaped view of a tool call. It lets the rest of the app use the core result internally while still sending a stable v2 shape outward.


##### `McpToolCallError::from`  (lines 167–171)

```
fn from(error: CoreMcpToolCallError) -> Self
```

**Purpose**: Turns a core MCP tool-call error into the simpler error type exposed by this protocol. It keeps the human-readable error message.

**Data flow**: It receives a core error object with a message. It copies that message into the v2 error object. The output is an API-friendly error value.

**Call relations**: This sits at the boundary between internal tool execution and client-facing reporting. When core reports a tool-call failure, this conversion shapes the failure for v2 protocol users.


##### `McpServerElicitationAction::to_core`  (lines 255–261)

```
fn to_core(self) -> codex_protocol::approvals::ElicitationAction
```

**Purpose**: Converts a user’s elicitation choice into the equivalent core Codex action. The choice can be accept, decline, or cancel.

**Data flow**: It receives one v2 action value. It matches that value to the same meaning in the core protocol type. The output is the core action that internal Codex code understands.

**Call relations**: This is used when a response comes from the app-server protocol side and must be handed back to core logic. It is a small translator between the public API language and the internal Codex language.


##### `ElicitationAction::from`  (lines 265–271)

```
fn from(value: McpServerElicitationAction) -> Self
```

**Purpose**: Converts the v2 elicitation action into the action type used by the RMCP library. RMCP is the Rust MCP implementation this code interoperates with.

**Data flow**: It takes a v2 action: accept, decline, or cancel. It maps it to the matching RMCP action. The output is a value that RMCP can send or store as part of an MCP elicitation result.

**Call relations**: This function is used when protocol-level user input needs to be handed to RMCP. It keeps the app-server type separate from the library type while making the handoff painless.


##### `McpServerElicitationAction::from`  (lines 275–281)

```
fn from(value: rmcp::model::ElicitationAction) -> Self
```

**Purpose**: Converts an RMCP elicitation action back into the v2 protocol action. This lets data coming from the MCP library be represented in the app-server protocol.

**Data flow**: It receives an RMCP action value. It matches accept, decline, or cancel to the corresponding v2 action. The output is the app-server protocol version of that same choice.

**Call relations**: This is the reverse of the RMCP-facing conversion. It is used when RMCP produces or carries an elicitation result and the app-server needs to expose it through the v2 API.


##### `McpServerElicitationRequest::try_from`  (lines 650–673)

```
fn try_from(value: CoreElicitationRequest) -> Result<Self, Self::Error>
```

**Purpose**: Turns a core elicitation request into the v2 request type, while checking that form schemas really match the strict form shape this API promises. It can fail if a core form request contains invalid schema JSON.

**Data flow**: It receives a core elicitation request. If the request is a form, it keeps the metadata and message, then parses the raw JSON schema into the typed v2 schema; invalid or null schema data becomes an error. If the request is URL-based, it copies the metadata, message, URL, and elicitation id directly. The output is either a valid v2 elicitation request or a JSON parsing error.

**Call relations**: Tests call this for form requests, URL requests, and invalid form schemas. In the real flow, it is the safety gate between loosely shaped core request data and the stricter client-facing v2 shape, using JSON parsing to reject forms the client contract cannot describe.

*Call graph*: called by 4 (mcp_server_elicitation_request_from_core_form_request, mcp_server_elicitation_request_from_core_url_request, mcp_server_elicitation_request_rejects_invalid_core_form_schema, mcp_server_elicitation_request_rejects_null_core_form_schema); 1 external calls (from_value).


##### `CreateElicitationResult::from`  (lines 692–698)

```
fn from(value: McpServerElicitationRequestResponse) -> Self
```

**Purpose**: Turns a v2 elicitation response into the RMCP result type expected by the MCP library. This is used after a client answers an MCP server’s prompt.

**Data flow**: It takes the client-facing response, including the action and optional content. It converts the action into RMCP’s action type and copies the content. It deliberately sets RMCP metadata to none, so the returned RMCP result contains only the action and content.

**Call relations**: This function is part of the path from app-server client response back to the MCP server. Once the user accepts, declines, or cancels, this conversion prepares the answer for RMCP.


##### `McpServerElicitationRequestResponse::from`  (lines 702–708)

```
fn from(value: rmcp::model::CreateElicitationResult) -> Self
```

**Purpose**: Turns an RMCP elicitation result into the v2 response type. This is useful when data from RMCP needs to be checked, echoed, or exposed through the app-server protocol.

**Data flow**: It receives an RMCP result with an action, optional content, and possible metadata. It converts the action into the v2 action and copies the content. It sets the v2 metadata field to none. The output is the protocol response shape.

**Call relations**: A round-trip test calls this to confirm RMCP results can move into the v2 type cleanly. It is the reverse bridge of the conversion that sends v2 responses into RMCP.

*Call graph*: called by 1 (mcp_server_elicitation_response_round_trips_rmcp_result).


### `app-server-protocol/src/protocol/v2/windows_sandbox.rs`

`data_model` · `request handling and setup status reporting`

This file is like a set of blank forms for one narrow topic: preparing and checking the Windows sandbox. A sandbox is a safety boundary that lets the app run work with tighter limits, so mistakes or risky commands are less likely to affect the wider computer. Without these shared message definitions, the server and client could disagree about field names, possible states, or what a setup result means.

The file does not perform the setup itself. Instead, it defines data structures that can be serialized, meaning turned into a format that can travel across an app protocol, usually as JSON. It also derives JSON schema and TypeScript output, so other parts of the system, including frontend or client code, can use matching types automatically.

The messages cover a few moments in the Windows sandbox flow. One notification warns when world-writable paths are found, meaning locations that many users or processes can write to and may be unsafe. Another set of types describes whether setup should run in elevated mode, with higher Windows permissions, or unelevated mode, with normal permissions. Other messages ask to start setup, report whether setup started, check whether the sandbox is ready, and notify when setup finishes with either success or an error message.

All fields are named in camelCase when sent over the wire, which keeps the protocol friendly to JavaScript and TypeScript clients.


### Schema export and experimental filtering
These files describe how the protocol surface is analyzed for experimental fields and transformed into generated schema and TypeScript artifacts with fixture support.

### `app-server-protocol/src/experimental_api.rs`

`domain_logic` · `cross-cutting`

Some parts of the app-server protocol are stable, while others are experimental and should only be used by clients that explicitly opt in. This file is the common checkpoint for that rule. It defines the ExperimentalApi trait, which is a small promise that a type can answer the question: “does this value contain anything experimental, and if so, why?” The answer is either a short reason string or nothing.

The file also defines ExperimentalField, a small record describing an experimental field by type name, field name, and reason. These records are collected through the inventory system, which is like a shared noticeboard that different protocol types can pin entries to at compile time. Schema-generating code can later read that noticeboard and hide or mark experimental fields.

A useful detail is that experimental use can be nested. If an optional value, list, hash map, or ordered map contains something experimental, the container reports the first experimental reason it finds. This means callers do not need custom searching code for every shape of data. They can ask the outer value and get a clear yes-or-no answer.

The tests prove that the derive macro works for enum variants, nested fields, collections, maps, and optional experimental fields.

#### Function details

##### `experimental_fields`  (lines 25–27)

```
fn experimental_fields() -> Vec<&'static ExperimentalField>
```

**Purpose**: Returns the full set of experimental protocol fields that have been registered elsewhere in the program. This is used when other code needs a complete catalog of experimental fields, such as when producing filtered schemas or TypeScript definitions.

**Data flow**: It takes no input. It reads the global inventory of ExperimentalField records, turns that inventory into an iterator, collects references to all registered entries into a list, and returns that list without changing the records.

**Call relations**: Schema and TypeScript filtering code calls this when it needs to know which fields are experimental. This function acts like the doorway into the shared registry, so those callers do not need to know how the registry is stored.

*Call graph*: called by 3 (filter_experimental_schema, filter_experimental_ts, filter_experimental_ts_tree).


##### `experimental_required_message`  (lines 30–32)

```
fn experimental_required_message(reason: &str) -> String
```

**Purpose**: Builds the standard message used when a caller tries to use an experimental method or field without enabling the experimentalApi capability. Keeping this wording in one place makes errors consistent.

**Data flow**: It receives a reason string, inserts that reason into a fixed sentence, and returns the finished message as a new string. It does not read or change any shared state.

**Call relations**: Other validation or request-checking code can call this after it has discovered an experimental reason. This function then turns the internal reason identifier into the human-facing explanation.

*Call graph*: 1 external calls (format!).


##### `Option::experimental_reason`  (lines 35–37)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Lets an optional value report experimental use only when it actually contains a value. If the option is empty, it is treated as stable.

**Data flow**: It receives an Option containing a type that also knows how to report experimental use. If there is a contained value, it asks that value for its reason. If there is no value, it returns nothing.

**Call relations**: This is used automatically anywhere an optional protocol field is checked through the ExperimentalApi trait. It passes the question inward to the contained value instead of forcing every caller to unwrap optional fields by hand.


##### `Vec::experimental_reason`  (lines 41–43)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Lets a list report whether any item inside it uses an experimental API feature. It returns the first experimental reason it finds.

**Data flow**: It receives a list of values that can each report experimental use. It walks through the items in order, asks each one for a reason, stops at the first reason it finds, and returns that reason. If no item is experimental, it returns nothing.

**Call relations**: This supports nested protocol data, where a field may be a collection of more detailed objects. Higher-level checks can ask the list directly instead of writing their own loop.


##### `HashMap::experimental_reason`  (lines 47–49)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Lets a hash map, which is a key-value lookup table, report whether any stored value uses an experimental API feature. The keys are only labels; the values are what matter for this check.

**Data flow**: It receives a map whose values can report experimental use. It looks through the map values, asks each one for an experimental reason, and returns the first reason found. If none of the values are experimental, it returns nothing.

**Call relations**: This is used when protocol data stores nested objects in a map. It allows the outer map to take part in the same ExperimentalApi checking flow as ordinary structs and lists.


##### `BTreeMap::experimental_reason`  (lines 53–55)

```
fn experimental_reason(&self) -> Option<&'static str>
```

**Purpose**: Lets an ordered map report whether any of its values use an experimental API feature. Like the hash map version, it checks values rather than keys.

**Data flow**: It receives an ordered key-value map whose values can report experimental use. It scans the values, asks each one for a reason, returns the first reason found, or returns nothing if all values are stable.

**Call relations**: This fits ordered maps into the same experimental-checking system. Code that asks a protocol value for its experimental reason can work the same way whether nested data is stored in a struct, list, hash map, or ordered map.


##### `tests::derive_supports_all_enum_variant_shapes`  (lines 109–126)

```
fn derive_supports_all_enum_variant_shapes()
```

**Purpose**: Checks that the derive macro can mark different kinds of enum variants as experimental. Enum variants can be simple names, tuple-like values, or named-field records, and all should work correctly.

**Data flow**: It creates or references several enum variant values, asks each one for its experimental reason, and compares the answer to the expected result. Experimental variants should return their configured reason, while the stable variant should return nothing.

**Call relations**: This test exercises code produced by the ExperimentalApi derive macro. It uses assertions to confirm that enum-level experimental markers feed correctly into the shared ExperimentalApi trait.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_supports_nested_experimental_fields`  (lines 129–140)

```
fn derive_supports_nested_experimental_fields()
```

**Purpose**: Checks that a struct field marked as nested can pass through an experimental reason from the value inside it. This matters because experimental features may be hidden inside optional sub-objects.

**Data flow**: It builds one struct whose optional inner field contains an experimental enum value and another whose inner field is empty. It asks each struct for its reason and expects the first to report the inner enum reason and the second to report nothing.

**Call relations**: This test confirms that derived ExperimentalApi implementations cooperate with the Option implementation in this file. The derived struct logic asks the optional field, and the optional field asks its contained value.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_supports_nested_collections`  (lines 143–159)

```
fn derive_supports_nested_collections()
```

**Purpose**: Checks that a nested list can reveal an experimental item inside it. This prevents experimental use from being missed just because it is inside a collection.

**Data flow**: It builds a struct with a list containing one stable enum value and one experimental enum value, then checks that the struct reports the experimental reason. It also builds a struct with an empty list and checks that it reports nothing.

**Call relations**: This test ties together the derive macro and the Vec implementation of ExperimentalApi. The struct delegates to the list, and the list searches its items for the first experimental reason.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_supports_nested_maps`  (lines 162–178)

```
fn derive_supports_nested_maps()
```

**Purpose**: Checks that a nested map can reveal an experimental value stored under a key. This makes sure map-shaped protocol fields are not a blind spot for experimental gating.

**Data flow**: It builds a struct whose map contains an experimental enum value and checks that the reason is found. It then builds a struct with an empty map and checks that no reason is reported.

**Call relations**: This test confirms that derived struct checking works with the HashMap implementation in this file. The struct asks the map, and the map searches its stored values.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::derive_marks_optional_experimental_fields_when_some`  (lines 181–194)

```
fn derive_marks_optional_experimental_fields_when_some()
```

**Purpose**: Checks that an optional field directly marked as experimental counts as experimental when it is present. If the optional field is absent, it should not trigger the experimental gate.

**Data flow**: It builds one struct where the optional experimental field is present, even though the contained list is empty, and expects the field's own reason. It builds another where the field is absent and expects no reason.

**Call relations**: This test covers a different case from nested checking: the field itself is experimental, not necessarily the values inside it. It confirms that the derive macro reports the field-level reason when the optional field is used.

*Call graph*: 1 external calls (assert_eq!).


### `app-server-protocol/src/export.rs`

`orchestration` · `build-time schema generation`

This file is the protocol exporter. Its job is to take the app-server protocol as written in Rust and produce clear contract files for outside consumers: `.ts` files for TypeScript users and `.json` schema files for validators and code generators. Without it, other clients would have to guess the shape of requests, responses, and notifications, and experimental features could accidentally appear in the stable public API.

The file works like a careful publishing pipeline. First it asks the protocol types to export themselves. Then it writes index files so consumers can import everything from one place. It adds a “generated code” warning header, optionally runs Prettier to format TypeScript, and trims stray whitespace. For JSON Schema, it writes individual schemas, combines them into one large bundle, and creates a flatter v2-only bundle for tools that cannot understand nested schema namespaces.

A large part of the file is cleanup and safety work. It strips experimental methods, fields, and generated type files from stable exports. It rewrites JSON Schema references so that shared and namespaced types point to the right place. It also gives anonymous schema variants useful names, because downstream code generators need stable model names. The tests at the bottom protect these guarantees with realistic examples.

#### Function details

##### `GeneratedSchema::namespace`  (lines 67–69)

```
fn namespace(&self) -> Option<&str>
```

**Purpose**: Returns the optional namespace for a generated schema, such as `v2`. A namespace is like a folder name used to separate newer protocol types from older shared ones.

**Data flow**: It reads the schema object's stored namespace → converts it from owned text to a borrowed text view → returns either that text or nothing.

**Call relations**: Schema-bundling code asks this when deciding whether a schema belongs at the root of the bundle or inside a named section.


##### `GeneratedSchema::logical_name`  (lines 71–73)

```
fn logical_name(&self) -> &str
```

**Purpose**: Returns the plain type name for a generated schema, without any namespace prefix. This is the name used as the schema definition key.

**Data flow**: It reads the stored logical name → returns it as borrowed text → does not change the schema.

**Call relations**: Bundling and filtering code uses this name to compare schemas against allowlists and to place definitions under the right key.


##### `GeneratedSchema::value`  (lines 75–77)

```
fn value(&self) -> &Value
```

**Purpose**: Returns the actual JSON Schema value stored inside a `GeneratedSchema`. This lets later steps inspect definitions and references.

**Data flow**: It reads the stored JSON value → returns a borrowed view of it → leaves the original untouched.

**Call relations**: The namespace collection step uses this to discover nested definitions that also need namespace-aware references.


##### `generate_types`  (lines 81–85)

```
fn generate_types(out_dir: &Path, prettier: Option<&Path>) -> Result<()>
```

**Purpose**: Runs the full export: TypeScript first, then JSON Schema. It is the simple one-call entry for producing all protocol artifacts.

**Data flow**: It receives an output directory and optional Prettier path → writes TypeScript files, then JSON files → returns success or the first error it hits.

**Call relations**: This is the top-level helper that hands work to `generate_ts` and `generate_json` in sequence.

*Call graph*: calls 2 internal fn (generate_json, generate_ts).


##### `GenerateTsOptions::default`  (lines 96–103)

```
fn default() -> Self
```

**Purpose**: Provides the normal TypeScript generation settings. By default it creates index files, adds generated-code headers, runs Prettier, and excludes experimental APIs.

**Data flow**: It takes no input → creates a settings object with the standard flags → returns that object.

**Call relations**: The normal TypeScript generator and callers such as schema fixture generation start from these defaults unless they need special behavior.

*Call graph*: called by 3 (main, generate_ts, write_schema_fixtures_with_options).


##### `generate_ts`  (lines 106–108)

```
fn generate_ts(out_dir: &Path, prettier: Option<&Path>) -> Result<()>
```

**Purpose**: Generates TypeScript protocol files using the standard options. It is the convenient public wrapper for normal use.

**Data flow**: It receives an output directory and optional Prettier path → builds default options → passes everything to the configurable generator.

**Call relations**: The full export path calls this before generating JSON schemas.

*Call graph*: calls 2 internal fn (default, generate_ts_with_options); called by 1 (generate_types).


##### `generate_ts_with_options`  (lines 110–185)

```
fn generate_ts_with_options(
    out_dir: &Path,
    prettier: Option<&Path>,
    options: GenerateTsOptions,
) -> Result<()>
```

**Purpose**: Performs the full TypeScript export with caller-controlled options. It creates folders, exports all protocol request/response/notification types, filters unstable pieces when needed, writes index files, adds headers, formats, and cleans whitespace.

**Data flow**: It receives a destination, optional Prettier executable, and generation options → writes many `.ts` files and possibly removes or edits some → returns success or a detailed failure.

**Call relations**: This is the main TypeScript pipeline behind `generate_ts`; it calls the lower-level file, filtering, indexing, and formatting helpers.

*Call graph*: calls 5 internal fn (ensure_dir, filter_experimental_ts, generate_index_ts, trim_trailing_whitespace_in_ts_files, ts_files_in_recursive); called by 1 (generate_ts); 11 external calls (export_all_to, export_all_to, join, export_all_to, export_all_to, anyhow!, new, export_client_responses, export_server_responses, available_parallelism (+1 more)).


##### `generate_json`  (lines 187–189)

```
fn generate_json(out_dir: &Path) -> Result<()>
```

**Purpose**: Generates the stable JSON Schema export. Stable means experimental protocol pieces are left out.

**Data flow**: It receives an output directory → calls the JSON generator with experimental API disabled → returns the result.

**Call relations**: The full export path calls this after TypeScript generation.

*Call graph*: calls 1 internal fn (generate_json_with_experimental); called by 1 (generate_types).


##### `generate_internal_json_schema`  (lines 191–195)

```
fn generate_internal_json_schema(out_dir: &Path) -> Result<()>
```

**Purpose**: Writes an internal JSON Schema for `RolloutLine`, a protocol-related internal data shape. This is separate from the public app-server protocol bundle.

**Data flow**: It receives an output directory → makes sure the directory exists → writes one schema file → returns success or an error.

**Call relations**: It uses the same schema-writing machinery as the public exporter, but only for this internal type.

*Call graph*: calls 1 internal fn (ensure_dir).


##### `generate_json_with_experimental`  (lines 197–246)

```
fn generate_json_with_experimental(out_dir: &Path, experimental_api: bool) -> Result<()>
```

**Purpose**: Builds the JSON Schema export, optionally including experimental API parts. It writes individual schema files, a full combined bundle, and a flat v2 bundle for simpler code generators.

**Data flow**: It receives an output directory and a flag for experimental API inclusion → emits schema files for protocol envelopes and method payloads → bundles and filters them → writes final JSON outputs.

**Call relations**: This is the main JSON pipeline behind `generate_json` and the JSON-related tests.

*Call graph*: calls 6 internal fn (build_flat_v2_schema, build_schema_bundle, ensure_dir, filter_experimental_json_files, filter_experimental_schema, write_pretty_json); called by 3 (generate_json, generate_json_filters_experimental_fields_and_methods, generate_json_includes_remote_control_methods_with_experimental_api); 9 external calls (join, new, export_client_notification_schemas, export_client_param_schemas, export_client_response_schemas, export_server_notification_schemas, export_server_param_schemas, export_server_response_schemas, vec!).


##### `filter_experimental_ts`  (lines 248–259)

```
fn filter_experimental_ts(out_dir: &Path) -> Result<()>
```

**Purpose**: Removes experimental TypeScript API pieces from a generated output directory. This prevents unstable methods, fields, and type files from appearing in the stable package.

**Data flow**: It reads the registered experimental fields and method-related types → edits or deletes generated `.ts` files → returns success or an error.

**Call relations**: The TypeScript generator calls this when the caller did not request the experimental API.

*Call graph*: calls 5 internal fn (experimental_fields, experimental_method_types, filter_client_request_ts, filter_experimental_type_fields_ts, remove_generated_type_files); called by 1 (generate_ts_with_options).


##### `filter_experimental_ts_tree`  (lines 261–294)

```
fn filter_experimental_ts_tree(tree: &mut BTreeMap<PathBuf, String>) -> Result<()>
```

**Purpose**: Applies the same experimental TypeScript filtering to an in-memory tree of files instead of files on disk. This is useful for test fixture generation.

**Data flow**: It receives a map from file paths to file text → rewrites affected entries and removes experimental type entries → leaves the map as the filtered version.

**Call relations**: Fixture-building code uses this mirror of the disk-based filter so tests can compare generated content without writing every step to disk.

*Call graph*: calls 5 internal fn (experimental_fields, experimental_method_types, filter_client_request_ts_contents, filter_experimental_type_fields_ts_contents, remove_generated_type_entries); called by 1 (generate_typescript_schema_fixture_subtree_for_tests); 3 external calls (new, new, take).


##### `filter_client_request_ts`  (lines 297–308)

```
fn filter_client_request_ts(out_dir: &Path, experimental_methods: &[&str]) -> Result<()>
```

**Purpose**: Edits `ClientRequest.ts` on disk to remove union entries for experimental client methods. A union is a TypeScript “one of these shapes” type.

**Data flow**: It finds `ClientRequest.ts` → reads its text if it exists → filters the text → writes it back.

**Call relations**: The broader experimental TypeScript filter calls this as a special case because client methods are stored in one combined TypeScript union.

*Call graph*: calls 1 internal fn (filter_client_request_ts_contents); called by 1 (filter_experimental_ts); 3 external calls (join, read_to_string, write).


##### `filter_client_request_ts_contents`  (lines 310–333)

```
fn filter_client_request_ts_contents(mut content: String, experimental_methods: &[&str]) -> String
```

**Purpose**: Removes experimental method arms from the text of the generated `ClientRequest` TypeScript type. It also deletes now-unused type imports.

**Data flow**: It receives TypeScript source text and method names to remove → splits the type union at top-level `|` separators → drops matching method variants → returns rewritten source text.

**Call relations**: Both the disk-based and in-memory TypeScript filters use this for the `ClientRequest.ts` special case.

*Call graph*: calls 3 internal fn (prune_unused_type_imports, split_top_level, split_type_alias); called by 2 (filter_client_request_ts, filter_experimental_ts_tree); 1 external calls (format!).


##### `filter_experimental_type_fields_ts`  (lines 336–362)

```
fn filter_experimental_type_fields_ts(
    out_dir: &Path,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
) -> Result<()>
```

**Purpose**: Removes experimental properties from generated TypeScript type files. It groups experimental fields by their containing type, then edits only matching files.

**Data flow**: It receives an output directory and registered experimental fields → scans generated TypeScript files → rewrites files whose type name has experimental fields.

**Call relations**: The stable TypeScript export calls this after the main generation step; several tests call it directly with small sample files.

*Call graph*: calls 2 internal fn (filter_experimental_fields_in_ts_file, ts_files_in_recursive); called by 4 (filter_experimental_ts, experimental_type_fields_ts_filter_handles_generated_command_params_shape, experimental_type_fields_ts_filter_handles_interface_shape, experimental_type_fields_ts_filter_keeps_imports_used_in_intersection_suffix); 1 external calls (new).


##### `filter_experimental_fields_in_ts_file`  (lines 364–373)

```
fn filter_experimental_fields_in_ts_file(
    path: &Path,
    experimental_field_names: &HashSet<String>,
) -> Result<()>
```

**Purpose**: Reads one TypeScript file, removes selected experimental fields from it, and writes the result back.

**Data flow**: It receives a file path and field names → reads the file text → filters the type body → writes the updated text.

**Call relations**: The directory-wide TypeScript field filter calls this for each file whose type name matches registered experimental fields.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts_contents); called by 1 (filter_experimental_type_fields_ts); 2 external calls (read_to_string, write).


##### `filter_experimental_type_fields_ts_contents`  (lines 375–400)

```
fn filter_experimental_type_fields_ts_contents(
    mut content: String,
    experimental_field_names: &HashSet<String>,
) -> String
```

**Purpose**: Removes selected property declarations from TypeScript source text. It understands generated type aliases and interfaces well enough to avoid splitting inside nested objects or comments.

**Data flow**: It receives source text and field names → finds the main type body → splits top-level fields → drops matching properties → removes unused imports → returns rewritten text.

**Call relations**: Used by both disk-based filtering and in-memory fixture filtering.

*Call graph*: calls 4 internal fn (prune_unused_type_imports, split_top_level_multi, split_type_alias, type_body_brace_span); called by 2 (filter_experimental_fields_in_ts_file, filter_experimental_ts_tree); 1 external calls (format!).


##### `filter_experimental_schema`  (lines 402–409)

```
fn filter_experimental_schema(bundle: &mut Value) -> Result<()>
```

**Purpose**: Removes experimental API pieces from a JSON Schema value. It covers fields, method variants, and leftover type definitions.

**Data flow**: It receives a mutable JSON value → looks up registered experimental items → edits the schema in place → returns success.

**Call relations**: The JSON export pipeline and tests call this to turn a complete schema into the stable public version.

*Call graph*: calls 5 internal fn (experimental_fields, filter_experimental_fields_in_definitions, filter_experimental_fields_in_root, prune_experimental_methods, remove_experimental_method_type_definitions); called by 4 (filter_experimental_json_files, generate_json_with_experimental, stable_schema_filter_removes_mock_experimental_method, stable_schema_filter_removes_mock_thread_start_field).


##### `filter_experimental_fields_in_root`  (lines 411–426)

```
fn filter_experimental_fields_in_root(
    schema: &mut Value,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
)
```

**Purpose**: Removes experimental fields when the schema value itself is the schema for the affected type.

**Data flow**: It reads the schema title → compares it to registered experimental field type names → removes matching properties and required markers.

**Call relations**: The main schema filter calls this before checking nested definitions.

*Call graph*: calls 1 internal fn (remove_property_from_schema); called by 1 (filter_experimental_schema); 1 external calls (get).


##### `filter_experimental_fields_in_definitions`  (lines 428–437)

```
fn filter_experimental_fields_in_definitions(
    bundle: &mut Value,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
)
```

**Purpose**: Looks inside a schema bundle’s `definitions` map and removes experimental fields from definitions there.

**Data flow**: It receives a mutable schema bundle → finds its definitions object → passes that map to the recursive definition filter.

**Call relations**: The main schema filter uses this so experimental fields are removed not only from the root schema but from bundled child schemas too.

*Call graph*: calls 1 internal fn (filter_experimental_fields_in_definitions_map); called by 1 (filter_experimental_schema); 1 external calls (get_mut).


##### `filter_experimental_fields_in_definitions_map`  (lines 439–458)

```
fn filter_experimental_fields_in_definitions_map(
    definitions: &mut Map<String, Value>,
    experimental_fields: &[&'static crate::experimental_api::ExperimentalField],
)
```

**Purpose**: Recursively removes experimental fields from a definitions map, including maps nested under namespaces like `v2`.

**Data flow**: It receives a definitions object and experimental field list → walks each definition → removes matching properties from matching types.

**Call relations**: Called by the definitions-level experimental filter; it uses namespace detection so it can descend into namespace containers without treating them as schemas.

*Call graph*: calls 3 internal fn (definition_matches_type, is_namespace_map, remove_property_from_schema); called by 1 (filter_experimental_fields_in_definitions); 1 external calls (iter_mut).


##### `is_namespace_map`  (lines 460–476)

```
fn is_namespace_map(value: &Value) -> bool
```

**Purpose**: Decides whether a JSON object looks like a namespace container rather than an actual schema. A namespace container is a map of names to schemas.

**Data flow**: It receives a JSON value → checks for schema-like keys such as `type` or `properties` → returns true only if it looks like a plain map of schema objects.

**Call relations**: Filtering code uses this to know when to recurse into a namespace such as `definitions.v2`.

*Call graph*: called by 2 (filter_experimental_fields_in_definitions_map, remove_experimental_method_type_definitions_map).


##### `definition_matches_type`  (lines 478–480)

```
fn definition_matches_type(def_name: &str, type_name: &str) -> bool
```

**Purpose**: Checks whether a schema definition name refers to a given Rust type name. It supports both plain names and names with namespace-like prefixes.

**Data flow**: It receives a definition name and type name → compares exact match or `::TypeName` suffix → returns true or false.

**Call relations**: Experimental field and type-definition filters use this to find definitions that represent experimental types.

*Call graph*: called by 1 (filter_experimental_fields_in_definitions_map); 1 external calls (format!).


##### `remove_property_from_schema`  (lines 482–494)

```
fn remove_property_from_schema(schema: &mut Value, field_name: &str)
```

**Purpose**: Deletes a field from a JSON Schema object and also removes it from the schema’s required-field list. This keeps the schema valid after field removal.

**Data flow**: It receives a mutable schema and field name → removes that field from `properties`, `required`, and nested `schema` wrappers → changes the schema in place.

**Call relations**: Experimental field filtering calls this whenever a registered unstable property must be hidden.

*Call graph*: called by 2 (filter_experimental_fields_in_definitions_map, filter_experimental_fields_in_root); 1 external calls (get_mut).


##### `prune_experimental_methods`  (lines 496–503)

```
fn prune_experimental_methods(bundle: &mut Value, experimental_methods: &[&str])
```

**Purpose**: Removes method variants for experimental client methods from a JSON Schema bundle. A method variant is one possible request shape in a `oneOf` or similar list.

**Data flow**: It receives a mutable bundle and method names → builds a lookup set → recursively prunes matching variants.

**Call relations**: The main schema filter calls this after field filtering.

*Call graph*: calls 1 internal fn (prune_experimental_methods_inner); called by 1 (filter_experimental_schema).


##### `prune_experimental_methods_inner`  (lines 505–520)

```
fn prune_experimental_methods_inner(value: &mut Value, experimental_methods: &HashSet<&str>)
```

**Purpose**: Walks through any JSON value and removes array entries that represent experimental methods. It continues into nested objects and arrays.

**Data flow**: It receives a mutable JSON value and method-name set → retains only non-experimental array items → recursively checks all children.

**Call relations**: This is the recursive worker behind `prune_experimental_methods`.

*Call graph*: called by 1 (prune_experimental_methods).


##### `is_experimental_method_variant`  (lines 522–545)

```
fn is_experimental_method_variant(value: &Value, experimental_methods: &HashSet<&str>) -> bool
```

**Purpose**: Recognizes whether one JSON Schema variant describes an experimental method. It looks for a `method` property fixed to one of the experimental names.

**Data flow**: It receives a JSON value and method-name set → checks `properties.method.const` or single-value `enum` → returns true if it should be removed.

**Call relations**: It is the predicate used by recursive method pruning when deciding which schema variants to drop.


##### `filter_experimental_json_files`  (lines 547–556)

```
fn filter_experimental_json_files(out_dir: &Path) -> Result<()>
```

**Purpose**: Post-processes all generated JSON files in a directory to remove experimental API parts. It also deletes JSON files for experimental-only types.

**Data flow**: It scans for `.json` files → reads each as JSON → filters it → writes it back → removes generated files for experimental method types.

**Call relations**: The JSON generator calls this after writing individual and bundled schemas when producing the stable export.

*Call graph*: calls 6 internal fn (experimental_method_types, filter_experimental_schema, json_files_in_recursive, read_json_value, remove_generated_type_files, write_pretty_json); called by 1 (generate_json_with_experimental).


##### `experimental_method_types`  (lines 558–564)

```
fn experimental_method_types() -> HashSet<String>
```

**Purpose**: Builds the set of type names connected to experimental methods. These are the generated parameter, response, and dependency types that should disappear from stable exports.

**Data flow**: It reads constant lists of experimental type paths → extracts the final type names → returns a set of names.

**Call relations**: Both TypeScript and JSON filtering use this set to delete generated experimental type files and definitions.

*Call graph*: calls 1 internal fn (collect_experimental_type_names); called by 4 (filter_experimental_json_files, filter_experimental_ts, filter_experimental_ts_tree, remove_experimental_method_type_definitions); 1 external calls (new).


##### `collect_experimental_type_names`  (lines 566–577)

```
fn collect_experimental_type_names(entries: &[&str], out: &mut HashSet<String>)
```

**Purpose**: Adds type names from a list of possibly qualified type paths into a set. It keeps only the final name after `::`.

**Data flow**: It receives string entries and an output set → trims and extracts names → inserts non-empty names into the set.

**Call relations**: The experimental method type collector calls this for parameter, response, and dependency type lists.

*Call graph*: called by 1 (experimental_method_types).


##### `remove_generated_type_files`  (lines 579–600)

```
fn remove_generated_type_files(
    out_dir: &Path,
    type_names: &HashSet<String>,
    extension: &str,
) -> Result<()>
```

**Purpose**: Deletes generated files for a set of type names from the root, `v1`, and `v2` output folders. This hides experimental-only types from stable disk output.

**Data flow**: It receives an output directory, type names, and file extension → builds possible paths → removes files that exist.

**Call relations**: Experimental TypeScript and JSON filters call this after editing shared files.

*Call graph*: called by 2 (filter_experimental_json_files, filter_experimental_ts); 3 external calls (join, format!, remove_file).


##### `remove_generated_type_entries`  (lines 602–617)

```
fn remove_generated_type_entries(
    tree: &mut BTreeMap<PathBuf, String>,
    type_names: &HashSet<String>,
    extension: &str,
)
```

**Purpose**: Removes generated type files from an in-memory file tree. It mirrors `remove_generated_type_files` without touching disk.

**Data flow**: It receives a path-to-content map, type names, and extension → builds root, `v1`, and `v2` paths → deletes matching map entries.

**Call relations**: The in-memory TypeScript fixture filter uses this to remove experimental type files from fixture content.

*Call graph*: called by 1 (filter_experimental_ts_tree); 2 external calls (from, format!).


##### `remove_experimental_method_type_definitions`  (lines 619–625)

```
fn remove_experimental_method_type_definitions(bundle: &mut Value)
```

**Purpose**: Removes schema definitions for types that exist only because of experimental methods.

**Data flow**: It receives a mutable bundle → gets the experimental method type names → removes matching entries from the definitions map.

**Call relations**: The main JSON schema filter calls this after removing experimental method variants.

*Call graph*: calls 2 internal fn (experimental_method_types, remove_experimental_method_type_definitions_map); called by 1 (filter_experimental_schema); 1 external calls (get_mut).


##### `remove_experimental_method_type_definitions_map`  (lines 627–655)

```
fn remove_experimental_method_type_definitions_map(
    definitions: &mut Map<String, Value>,
    experimental_type_names: &HashSet<String>,
)
```

**Purpose**: Recursively deletes experimental method type definitions from a definitions map, including nested namespace maps.

**Data flow**: It receives a definitions object and names to remove → collects matching keys → removes them → descends into namespace containers.

**Call relations**: This is the worker used by `remove_experimental_method_type_definitions`.

*Call graph*: calls 1 internal fn (is_namespace_map); called by 1 (remove_experimental_method_type_definitions); 3 external calls (keys, remove, values_mut).


##### `prune_unused_type_imports`  (lines 657–674)

```
fn prune_unused_type_imports(content: String, type_alias_body: &str) -> String
```

**Purpose**: Removes simple TypeScript `import type` lines when the imported type is no longer used. This keeps filtered files from referring to deleted experimental types.

**Data flow**: It receives full file text and the remaining type body → checks each import line → drops imports whose type name no longer appears → returns rewritten text.

**Call relations**: The TypeScript method and field filters call this after removing parts of a generated type.

*Call graph*: calls 1 internal fn (parse_imported_type_name); called by 2 (filter_client_request_ts_contents, filter_experimental_type_fields_ts_contents); 1 external calls (new).


##### `parse_imported_type_name`  (lines 676–685)

```
fn parse_imported_type_name(line: &str) -> Option<&str>
```

**Purpose**: Extracts the type name from a simple TypeScript line like `import type { Foo } from ...`. It deliberately ignores complex imports.

**Data flow**: It receives one line of text → checks the expected import shape → returns the single imported type name if present.

**Call relations**: Unused-import pruning calls this for each line before deciding whether to keep or remove it.

*Call graph*: called by 1 (prune_unused_type_imports).


##### `json_files_in_recursive`  (lines 687–704)

```
fn json_files_in_recursive(dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Finds all JSON files under a directory and its subdirectories.

**Data flow**: It receives a starting directory → walks folders using a stack → collects paths ending in `.json` → returns the list.

**Call relations**: The experimental JSON post-processor uses this to revisit every generated schema file.

*Call graph*: called by 1 (filter_experimental_json_files); 4 external calls (new, read_dir, matches!, vec!).


##### `read_json_value`  (lines 706–710)

```
fn read_json_value(path: &Path) -> Result<Value>
```

**Purpose**: Reads a JSON file and parses it into a JSON value. It adds helpful error context if reading or parsing fails.

**Data flow**: It receives a file path → reads text from disk → parses JSON → returns the parsed value or an error.

**Call relations**: JSON filtering and tests use this when they need to inspect generated schema files.

*Call graph*: called by 2 (filter_experimental_json_files, generate_json_filters_experimental_fields_and_methods); 2 external calls (read_to_string, from_str).


##### `split_type_alias`  (lines 712–722)

```
fn split_type_alias(content: &str) -> Option<(String, String, String)>
```

**Purpose**: Splits a TypeScript type alias into the text before `=`, the body, and the text from the final semicolon onward.

**Data flow**: It receives TypeScript source text → finds the first `=` and last `;` → returns three pieces if the shape is valid.

**Call relations**: TypeScript filtering uses this to isolate the union or object body before removing experimental pieces.

*Call graph*: called by 2 (filter_client_request_ts_contents, filter_experimental_type_fields_ts_contents).


##### `type_body_brace_span`  (lines 724–739)

```
fn type_body_brace_span(content: &str) -> Option<(usize, usize)>
```

**Purpose**: Finds the main `{ ... }` body of a generated TypeScript type alias or interface. This lets field filtering edit only the object’s properties.

**Data flow**: It receives TypeScript text → looks after `=` or `export interface` → finds the matching top-level braces → returns their character positions.

**Call relations**: The TypeScript field-content filter calls this before splitting object fields.

*Call graph*: calls 1 internal fn (find_top_level_brace_span); called by 1 (filter_experimental_type_fields_ts_contents).


##### `find_top_level_brace_span`  (lines 741–758)

```
fn find_top_level_brace_span(input: &str) -> Option<(usize, usize)>
```

**Purpose**: Finds a matching pair of top-level braces in TypeScript-like text while ignoring braces inside strings and comments.

**Data flow**: It scans characters with a small state machine → records the first top-level `{` and matching `}` → returns their positions if found.

**Call relations**: Used for finding type bodies and for inspecting union arms that contain object shapes.

*Call graph*: called by 2 (extract_method_from_arm, type_body_brace_span); 1 external calls (default).


##### `split_top_level`  (lines 760–762)

```
fn split_top_level(input: &str, delimiter: char) -> Vec<String>
```

**Purpose**: Splits text on one delimiter only when that delimiter is at the top level, not inside braces, parentheses, strings, or comments.

**Data flow**: It receives text and one delimiter → delegates to the multi-delimiter splitter → returns trimmed pieces.

**Call relations**: Client request filtering uses this to split union arms and object fields safely.

*Call graph*: calls 1 internal fn (split_top_level_multi); called by 2 (extract_method_from_arm, filter_client_request_ts_contents).


##### `split_top_level_multi`  (lines 764–783)

```
fn split_top_level_multi(input: &str, delimiters: &[char]) -> Vec<String>
```

**Purpose**: Splits text on any of several delimiters, but only at top level. This prevents accidental splits inside nested object types or generic types.

**Data flow**: It receives text and delimiter characters → scans with nesting and comment/string awareness → returns non-empty trimmed parts.

**Call relations**: Field filtering and union parsing use this as their safe splitter.

*Call graph*: called by 2 (filter_experimental_type_fields_ts_contents, split_top_level); 2 external calls (new, default).


##### `extract_method_from_arm`  (lines 785–800)

```
fn extract_method_from_arm(arm: &str) -> Option<String>
```

**Purpose**: Reads a TypeScript union arm and tries to find its fixed `method` string. This identifies which request method a union variant represents.

**Data flow**: It receives one union-arm string → finds its object body → scans properties → parses the `method` string literal → returns that method if found.

**Call relations**: Client request filtering uses this to decide which union arms are experimental and should be removed.

*Call graph*: calls 4 internal fn (find_top_level_brace_span, parse_property, parse_string_literal, split_top_level).


##### `parse_property`  (lines 802–806)

```
fn parse_property(input: &str) -> Option<(String, &str)>
```

**Purpose**: Parses a TypeScript-like property into its name and value text. It expects a property name followed by a colon.

**Data flow**: It receives property text → parses the property name → finds the colon → returns the name and text after the colon.

**Call relations**: Method extraction uses this while scanning fields inside a union arm.

*Call graph*: calls 1 internal fn (parse_property_name); called by 1 (extract_method_from_arm).


##### `strip_leading_block_comments`  (lines 808–819)

```
fn strip_leading_block_comments(input: &str) -> &str
```

**Purpose**: Skips over leading `/* ... */` comments before a TypeScript field. This lets field-name parsing work even when generated comments appear before properties.

**Data flow**: It receives text → repeatedly removes leading block comments and whitespace → returns the remaining slice.

**Call relations**: TypeScript field filtering calls this before checking whether a field is experimental.


##### `parse_property_name`  (lines 821–855)

```
fn parse_property_name(input: &str) -> Option<String>
```

**Purpose**: Parses a TypeScript property name, including quoted names and optional fields marked with `?`. It only accepts names followed by a colon.

**Data flow**: It receives property text → reads a quoted string or identifier → skips an optional `?` → confirms a colon → returns the property name.

**Call relations**: Used by property parsing and experimental field filtering.

*Call graph*: calls 2 internal fn (is_ident_char, parse_string_literal); called by 1 (parse_property).


##### `parse_string_literal`  (lines 857–880)

```
fn parse_string_literal(input: &str) -> Option<(String, usize)>
```

**Purpose**: Parses a single- or double-quoted string literal and handles escaped characters. It reports both the string content and how much text was consumed.

**Data flow**: It receives text → verifies the opening quote → scans until the matching unescaped quote → returns the literal content and consumed length.

**Call relations**: Property-name parsing and method extraction use this for quoted fields and method names.

*Call graph*: called by 2 (extract_method_from_arm, parse_property_name).


##### `is_ident_char`  (lines 882–884)

```
fn is_ident_char(ch: char) -> bool
```

**Purpose**: Checks whether a character can be part of a simple TypeScript identifier used here. It allows ASCII letters, digits, and underscore.

**Data flow**: It receives one character → tests it against the allowed set → returns true or false.

**Call relations**: Property-name parsing uses this while reading unquoted field names.

*Call graph*: called by 1 (parse_property_name).


##### `ScanState::observe`  (lines 897–963)

```
fn observe(&mut self, ch: char)
```

**Purpose**: Updates the scanner’s memory after seeing one character. It tracks whether parsing is inside a string, comment, or nested brackets.

**Data flow**: It receives one character → updates comment/string flags and nesting depth → changes the scan state in place.

**Call relations**: Top-level splitters and brace finders rely on this to avoid being fooled by punctuation inside nested or ignored syntax.


##### `ScanState::in_ignored_syntax`  (lines 965–967)

```
fn in_ignored_syntax(&self) -> bool
```

**Purpose**: Reports whether the scanner is currently inside syntax that should be ignored for structural parsing, such as a string or comment.

**Data flow**: It reads the scanner flags → returns true if inside a string, block comment, or line comment.

**Call relations**: Brace-finding and splitting code consult this before treating punctuation as meaningful.


##### `Depth::is_top_level`  (lines 979–981)

```
fn is_top_level(&self) -> bool
```

**Purpose**: Reports whether the current scan position is not nested inside braces, brackets, parentheses, or angle brackets.

**Data flow**: It reads the four nesting counters → returns true only when all are zero.

**Call relations**: The TypeScript text parser uses this to split only at real top-level separators.


##### `build_schema_bundle`  (lines 984–1065)

```
fn build_schema_bundle(schemas: Vec<GeneratedSchema>) -> Result<Value>
```

**Purpose**: Combines many individual JSON Schemas into one bundle with a shared `definitions` map. It also fixes references so namespaced types point to the right place.

**Data flow**: It receives generated schemas → collects known namespaced type names → moves nested definitions into the bundle → rewrites `$ref` links → returns one combined JSON Schema value.

**Call relations**: The JSON generator calls this before writing the main combined schema bundle.

*Call graph*: calls 7 internal fn (annotate_schema, collect_namespaced_types, insert_into_namespace, namespace_for_definition, rewrite_named_ref_to_namespace, rewrite_refs_to_known_namespaces, rewrite_refs_to_namespace); called by 4 (generate_json_with_experimental, build_schema_bundle_rewrites_root_helper_refs_to_namespaced_defs, stable_schema_filter_removes_mock_experimental_method, stable_schema_filter_removes_mock_thread_start_field); 4 external calls (new, Object, String, new).


##### `build_flat_v2_schema`  (lines 1079–1127)

```
fn build_flat_v2_schema(bundle: &Value) -> Result<Value>
```

**Purpose**: Creates a v2-focused schema bundle with v2 definitions placed at the root. This helps code generators that only look one level deep in `definitions`.

**Data flow**: It receives the full mixed bundle → copies v2 definitions and needed shared dependencies → rewrites v2 references → verifies no references are broken → returns the flat bundle.

**Call relations**: The JSON generator writes this as the separate v2 bundle, and tests check that it keeps shared request and notification shapes.

*Call graph*: calls 5 internal fn (collect_definition_dependencies, collect_non_v2_refs, ensure_no_ref_prefix, ensure_referenced_definitions_present, rewrite_ref_prefix); called by 2 (generate_json_with_experimental, build_flat_v2_schema_keeps_shared_root_schemas_and_dependencies); 6 external calls (new, new, Object, String, anyhow!, format!).


##### `collect_non_v2_refs`  (lines 1129–1133)

```
fn collect_non_v2_refs(value: &Value) -> HashSet<String>
```

**Purpose**: Collects references to root-level definitions, excluding references already under `v2`. These are shared dependencies needed by the flat v2 bundle.

**Data flow**: It receives a JSON value → recursively scans for `$ref` strings → returns the set of non-v2 definition names.

**Call relations**: Flat v2 bundle creation uses this to know which shared helper schemas to pull in.

*Call graph*: calls 1 internal fn (collect_non_v2_refs_inner); called by 2 (build_flat_v2_schema, collect_definition_dependencies); 1 external calls (new).


##### `collect_non_v2_refs_inner`  (lines 1135–1155)

```
fn collect_non_v2_refs_inner(value: &Value, refs: &mut HashSet<String>)
```

**Purpose**: Recursively walks a JSON value to find non-v2 definition references.

**Data flow**: It receives a JSON value and an output set → adds matching `$ref` targets → descends through objects and arrays.

**Call relations**: This is the worker behind `collect_non_v2_refs`.

*Call graph*: called by 1 (collect_non_v2_refs).


##### `collect_definition_dependencies`  (lines 1157–1177)

```
fn collect_definition_dependencies(
    definitions: &Map<String, Value>,
    names: HashSet<String>,
) -> HashSet<String>
```

**Purpose**: Finds all shared definition dependencies reachable from an initial set of names. It follows references like a breadcrumb trail.

**Data flow**: It receives the full definitions map and starting names → repeatedly scans each referenced definition for more references → returns every discovered dependency name.

**Call relations**: Flat v2 bundle creation uses this so shared helpers are not copied without their own required helper types.

*Call graph*: calls 1 internal fn (collect_non_v2_refs); called by 1 (build_flat_v2_schema); 2 external calls (new, get).


##### `rewrite_ref_prefix`  (lines 1179–1196)

```
fn rewrite_ref_prefix(value: &mut Value, prefix: &str, replacement: &str)
```

**Purpose**: Rewrites `$ref` strings by replacing one prefix with another throughout a JSON value.

**Data flow**: It receives a mutable JSON value, old prefix, and replacement → walks all objects and arrays → changes matching reference strings in place.

**Call relations**: The flat v2 bundle uses this to turn `#/definitions/v2/Type` references into `#/definitions/Type` references.

*Call graph*: called by 1 (build_flat_v2_schema).


##### `ensure_no_ref_prefix`  (lines 1198–1205)

```
fn ensure_no_ref_prefix(value: &Value, prefix: &str, label: &str) -> Result<()>
```

**Purpose**: Checks that no `$ref` in a schema still starts with an unwanted prefix. It is a safety check after reference rewriting.

**Data flow**: It receives a schema, forbidden prefix, and label → searches for the first bad reference → returns success or an error naming the problem.

**Call relations**: Flat v2 bundle creation calls this after rewriting v2 references.

*Call graph*: calls 1 internal fn (first_ref_with_prefix); called by 1 (build_flat_v2_schema); 1 external calls (anyhow!).


##### `first_ref_with_prefix`  (lines 1207–1223)

```
fn first_ref_with_prefix(value: &Value, prefix: &str) -> Option<String>
```

**Purpose**: Finds the first `$ref` string in a JSON value that starts with a given prefix.

**Data flow**: It receives a JSON value and prefix → recursively scans objects and arrays → returns the first matching reference if any.

**Call relations**: The no-bad-prefix check uses this to produce a helpful error.

*Call graph*: called by 1 (ensure_no_ref_prefix).


##### `ensure_referenced_definitions_present`  (lines 1225–1241)

```
fn ensure_referenced_definitions_present(schema: &Value, label: &str) -> Result<()>
```

**Purpose**: Verifies that every local definition reference in a schema points to a definition that actually exists. This catches broken bundles before they are written.

**Data flow**: It receives a schema and label → gathers missing referenced names → returns success if none are missing, otherwise an error listing them.

**Call relations**: Flat v2 bundle creation calls this as a final integrity check.

*Call graph*: calls 1 internal fn (collect_missing_definitions); called by 1 (build_flat_v2_schema); 3 external calls (new, get, anyhow!).


##### `collect_missing_definitions`  (lines 1243–1269)

```
fn collect_missing_definitions(
    value: &Value,
    definitions: &Map<String, Value>,
    missing: &mut HashSet<String>,
)
```

**Purpose**: Recursively collects local `$ref` targets that are absent from a definitions map.

**Data flow**: It receives a JSON value, existing definitions, and a missing-name set → scans every child → inserts names whose definitions are missing.

**Call relations**: The referenced-definition integrity check uses this as its recursive worker.

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

**Purpose**: Adds a schema definition into a namespace object inside the bundle. If the namespace does not exist, it creates it.

**Data flow**: It receives the bundle definitions map, namespace, name, and schema → finds or creates the namespace map → inserts the definition safely.

**Call relations**: Schema bundle building calls this when placing v2 or other namespaced definitions.

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

**Purpose**: Inserts one schema definition and detects naming collisions. If the same name already exists with different content, it returns a clear error.

**Data flow**: It receives a definitions map, name, schema, and location label → compares with any existing entry → inserts or reports a collision.

**Call relations**: Namespace insertion uses this to avoid silently overwriting schema definitions.

*Call graph*: called by 1 (insert_into_namespace); 4 external calls (get, insert, get, anyhow!).


##### `write_json_schema_with_return`  (lines 1316–1361)

```
fn write_json_schema_with_return(out_dir: &Path, name: &str) -> Result<GeneratedSchema>
```

**Purpose**: Generates a JSON Schema for one Rust type, writes it to disk when appropriate, and returns it for bundling. It also applies naming and variant cleanup needed by code generators.

**Data flow**: It receives an output directory and schema name → derives namespace and logical name → builds the schema from the Rust type → filters special legacy variants, annotates it, writes a JSON file, and returns `GeneratedSchema`.

**Call relations**: The JSON export pipeline uses this through small emitter functions for many protocol types.

*Call graph*: calls 7 internal fn (annotate_schema, enforce_numbered_definition_collision_overrides, ensure_dir, split_namespace, strip_v1_client_request_variants_from_json_schema, strip_v1_server_notification_variants_from_json_schema, write_pretty_json); 4 external calls (join, format!, schema_for!, to_value).


##### `enforce_numbered_definition_collision_overrides`  (lines 1363–1370)

```
fn enforce_numbered_definition_collision_overrides(schema_name: &str, schema: &mut Value)
```

**Purpose**: Checks a schema for suspicious generated definition names such as `Foo1` when `Foo` also exists. That usually means two different types collided in generated names.

**Data flow**: It receives a schema name and schema value → inspects `definitions` and `$defs` maps → panics if it detects a numbered collision.

**Call relations**: Single-schema writing calls this before accepting a generated schema.

*Call graph*: calls 1 internal fn (detect_numbered_definition_collisions); called by 1 (write_json_schema_with_return); 1 external calls (get).


##### `strip_v1_client_request_variants_from_json_schema`  (lines 1372–1375)

```
fn strip_v1_client_request_variants_from_json_schema(schema: &mut Value)
```

**Purpose**: Removes selected legacy v1 client request methods from the JSON schema export. This keeps the JSON schema focused on the intended public surface.

**Data flow**: It builds the set of v1 methods to remove → passes the schema and set to the generic method-variant stripper.

**Call relations**: Single-schema writing calls this specifically for `ClientRequest`.

*Call graph*: calls 1 internal fn (strip_method_variants_from_json_schema); called by 1 (write_json_schema_with_return).


##### `strip_v1_server_notification_variants_from_json_schema`  (lines 1377–1383)

```
fn strip_v1_server_notification_variants_from_json_schema(schema: &mut Value)
```

**Purpose**: Removes selected server notification methods from the JSON schema export. These are excluded from the JSON-facing schema.

**Data flow**: It builds the set of notification methods to remove → passes the schema and set to the generic method-variant stripper.

**Call relations**: Single-schema writing calls this specifically for `ServerNotification`.

*Call graph*: calls 1 internal fn (strip_method_variants_from_json_schema); called by 1 (write_json_schema_with_return).


##### `strip_method_variants_from_json_schema`  (lines 1385–1403)

```
fn strip_method_variants_from_json_schema(schema: &mut Value, methods_to_remove: &HashSet<&str>)
```

**Purpose**: Removes method variants from a schema’s top-level `oneOf` list and then drops definitions no longer reachable. This avoids leaving dead helper definitions behind.

**Data flow**: It receives a schema and method names → filters matching variants → computes reachable local definitions → retains only those definitions.

**Call relations**: The v1 client request and server notification special-case filters both use this.

*Call graph*: calls 1 internal fn (reachable_local_definitions); called by 2 (strip_v1_client_request_variants_from_json_schema, strip_v1_server_notification_variants_from_json_schema); 1 external calls (as_object_mut).


##### `is_method_variant_in_set`  (lines 1405–1419)

```
fn is_method_variant_in_set(value: &Value, methods: &HashSet<&str>) -> bool
```

**Purpose**: Checks whether a schema variant represents one of a given set of methods.

**Data flow**: It receives a JSON variant and method set → looks for a fixed `method` property → returns true if that method is in the set.

**Call relations**: Method-variant stripping uses this as its test for each `oneOf` entry.

*Call graph*: calls 1 internal fn (string_literal).


##### `reachable_local_definitions`  (lines 1421–1436)

```
fn reachable_local_definitions(schema: &Value, defs_key: &str) -> HashSet<String>
```

**Purpose**: Finds which local schema definitions are still reachable after variants have been removed. Reachable means some remaining schema still references them.

**Data flow**: It receives a schema and definitions key name → starts from references outside the definitions map → follows references through definitions → returns the reachable definition names.

**Call relations**: Method-variant stripping uses this to prune unused local definitions.

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

**Purpose**: Collects local definition references while skipping entire definition maps. This finds references from the real schema body, not from every definition whether used or not.

**Data flow**: It receives a JSON value, definition key, queue, and reachable set → scans children except definitions containers → records referenced definition names.

**Call relations**: Reachability analysis uses this for its initial scan.

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

**Purpose**: Collects local definition references from a JSON value, including all nested children.

**Data flow**: It receives a JSON value, definition key, queue, and reachable set → records any `$ref` at this value → recursively scans children.

**Call relations**: Reachability analysis uses this when following references inside already-reachable definitions.

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

**Purpose**: Checks one JSON value for a local `$ref` to a definition and adds it to the reachability queue if new.

**Data flow**: It receives a JSON value, definition key, queue, and reachable set → extracts a `#/{defs_key}/Name` reference if present → stores the name.

**Call relations**: Both local-reference collectors use this small shared step.

*Call graph*: called by 2 (collect_local_definition_refs, collect_local_definition_refs_excluding_maps); 2 external calls (as_object, format!).


##### `detect_numbered_definition_collisions`  (lines 1507–1522)

```
fn detect_numbered_definition_collisions(
    schema_name: &str,
    defs_key: &str,
    defs: &Map<String, Value>,
)
```

**Purpose**: Detects generated schema definition names that look like automatic collision fallbacks. It panics to force the developer to add an explicit rename.

**Data flow**: It receives a schema name, definitions container name, and definitions map → checks whether names like `Foo1` coexist with `Foo` → panics on a collision.

**Call relations**: The numbered-collision enforcement helper calls this for each definitions map.

*Call graph*: called by 1 (enforce_numbered_definition_collision_overrides); 3 external calls (contains_key, keys, panic!).


##### `write_json_schema`  (lines 1524–1529)

```
fn write_json_schema(out_dir: &Path, name: &str) -> Result<GeneratedSchema>
```

**Purpose**: Public crate-level wrapper that writes a JSON Schema for one Rust type and returns its generated schema metadata.

**Data flow**: It receives an output directory and schema name → delegates to the main single-schema writer → returns the generated schema.

**Call relations**: Internal schema generation and other crate code use this simpler wrapper.


##### `write_pretty_json`  (lines 1531–1536)

```
fn write_pretty_json(path: PathBuf, value: &impl Serialize) -> Result<()>
```

**Purpose**: Writes a JSON value to disk using human-readable formatting. Pretty formatting makes generated schema files easier to inspect and diff.

**Data flow**: It receives a path and serializable value → converts the value to pretty JSON bytes → writes the file.

**Call relations**: The JSON generator, schema writer, and experimental JSON filter use this whenever they write schema files.

*Call graph*: called by 3 (filter_experimental_json_files, generate_json_with_experimental, write_json_schema_with_return); 2 external calls (write, to_vec_pretty).


##### `split_namespace`  (lines 1539–1542)

```
fn split_namespace(name: &str) -> (Option<&str>, &str)
```

**Purpose**: Splits a type name like `v2::ThreadStartParams` into namespace `v2` and logical name `ThreadStartParams`.

**Data flow**: It receives a name string → looks for `::` → returns optional namespace plus the remaining name.

**Call relations**: Single-schema writing uses this to decide both file location and bundle namespace.

*Call graph*: called by 1 (write_json_schema_with_return).


##### `rewrite_refs_to_namespace`  (lines 1546–1568)

```
fn rewrite_refs_to_namespace(value: &mut Value, ns: &str)
```

**Purpose**: Rewrites local schema references so they point inside a specific namespace. For example, `#/definitions/Foo` becomes `#/definitions/v2/Foo`.

**Data flow**: It receives a mutable JSON value and namespace → walks all children → updates `$ref` strings that need the namespace prefix.

**Call relations**: Schema bundle building calls this for schemas and definitions that belong to a namespace.

*Call graph*: called by 1 (build_schema_bundle); 1 external calls (format!).


##### `rewrite_refs_to_known_namespaces`  (lines 1580–1605)

```
fn rewrite_refs_to_known_namespaces(value: &mut Value, types: &HashMap<String, String>)
```

**Purpose**: Rewrites references in shared root schemas when the referenced type is known to live in a namespace. This prevents broken references in mixed root/v2 bundles.

**Data flow**: It receives a mutable JSON value and map of type names to namespaces → walks `$ref` strings → retargets known names to their namespace.

**Call relations**: Schema bundle building uses this for root schemas that refer to v2 types.

*Call graph*: calls 1 internal fn (namespace_for_definition); called by 1 (build_schema_bundle); 2 external calls (new, format!).


##### `collect_namespaced_types`  (lines 1607–1627)

```
fn collect_namespaced_types(schemas: &[GeneratedSchema]) -> HashMap<String, String>
```

**Purpose**: Builds a map from type names to the namespace where they are defined. It includes top-level schemas and nested definitions inside those schemas.

**Data flow**: It receives generated schemas → examines schemas with namespaces → records logical names and nested definition names → returns the map.

**Call relations**: Bundle construction uses this map before rewriting references.

*Call graph*: called by 1 (build_schema_bundle); 1 external calls (new).


##### `namespace_for_definition`  (lines 1629–1641)

```
fn namespace_for_definition(
    name: &str,
    types: &'a HashMap<String, String>,
) -> Option<&'a String>
```

**Purpose**: Finds the namespace for a definition name, including generated names with trailing numbers. This helps resolve references after schema generation renames some definitions.

**Data flow**: It receives a definition name and type-to-namespace map → checks exact name, then name without trailing digits → returns a namespace if found.

**Call relations**: Reference rewriting and bundle placement use this during schema bundling.

*Call graph*: called by 2 (build_schema_bundle, rewrite_refs_to_known_namespaces).


##### `variant_definition_name`  (lines 1643–1683)

```
fn variant_definition_name(base: &str, variant: &Value) -> Option<String>
```

**Purpose**: Creates a useful schema title for an unnamed variant. It derives names from discriminator fields such as `method` or `type`.

**Data flow**: It receives a base schema name and variant JSON → looks for fixed properties or single required fields → returns a PascalCase name if it can infer one.

**Call relations**: Variant annotation uses this to give code generators stable model names.

*Call graph*: calls 2 internal fn (literal_from_property, to_pascal_case); called by 1 (annotate_variant_list); 2 external calls (get, format!).


##### `literal_from_property`  (lines 1685–1687)

```
fn literal_from_property(props: &'a Map<String, Value>, key: &str) -> Option<&'a str>
```

**Purpose**: Gets a fixed string value from a named property schema. A fixed value may be stored as `const` or a one-value `enum`.

**Data flow**: It receives a properties map and key → finds the property schema → returns its string literal if present.

**Call relations**: Variant naming and collision reporting use this to read discriminator values.

*Call graph*: called by 2 (variant_definition_name, variant_title_collision_key); 1 external calls (get).


##### `string_literal`  (lines 1689–1697)

```
fn string_literal(value: &Value) -> Option<&str>
```

**Purpose**: Extracts a fixed string from a schema value, whether represented as `const` or as the first value of an `enum`.

**Data flow**: It receives a schema value → checks `const`, then `enum` → returns the string if found.

**Call relations**: Method filtering, variant naming diagnostics, and discriminator title generation all use this helper.

*Call graph*: called by 3 (is_method_variant_in_set, set_discriminator_titles, variant_title_collision_key); 1 external calls (get).


##### `annotate_schema`  (lines 1699–1709)

```
fn annotate_schema(value: &mut Value, base: Option<&str>)
```

**Purpose**: Adds helpful titles to schema variants and discriminator properties throughout a JSON Schema value. These titles make generated models more stable and readable.

**Data flow**: It receives a mutable JSON value and optional base name → recurses through objects and arrays → inserts missing titles where it can.

**Call relations**: Schema writing and bundle construction call this before schemas are written or merged.

*Call graph*: calls 1 internal fn (annotate_object); called by 4 (annotate_object, annotate_variant_list, build_schema_bundle, write_json_schema_with_return).


##### `annotate_object`  (lines 1711–1764)

```
fn annotate_object(map: &mut Map<String, Value>, base: Option<&str>)
```

**Purpose**: Annotates one JSON object schema by naming variants, discriminator properties, nested definitions, properties, and child schemas.

**Data flow**: It receives a mutable JSON object and optional base name → updates relevant child schema sections → recurses into remaining schema content.

**Call relations**: This is the object-specific worker behind `annotate_schema`.

*Call graph*: calls 3 internal fn (annotate_schema, annotate_variant_list, set_discriminator_titles); called by 1 (annotate_schema); 3 external calls (get, get_mut, iter_mut).


##### `annotate_variant_list`  (lines 1766–1805)

```
fn annotate_variant_list(variants: &mut [Value], base: Option<&str>)
```

**Purpose**: Adds titles to variants in `oneOf` or `anyOf` lists when they do not already have one. It also guards against generated title collisions.

**Data flow**: It receives a mutable list of variants and optional base name → tracks existing titles → generates missing names → sets discriminator property titles → annotates each variant recursively.

**Call relations**: Object annotation calls this for union-like schema sections.

*Call graph*: calls 5 internal fn (annotate_schema, set_discriminator_titles, variant_definition_name, variant_title, variant_title_collision_key); called by 1 (annotate_object); 5 external calls (new, String, iter, iter_mut, panic!).


##### `variant_title_collision_key`  (lines 1807–1847)

```
fn variant_title_collision_key(base: &str, generated_name: &str, variant: &Value) -> String
```

**Purpose**: Builds a detailed text key explaining why two schema variants would receive the same generated title. This makes panic messages actionable.

**Data flow**: It receives the base name, generated name, and variant → gathers discriminator and literal clues → returns a joined diagnostic string.

**Call relations**: Variant annotation calls this only when it detects a naming collision.

*Call graph*: calls 2 internal fn (literal_from_property, string_literal); called by 1 (annotate_variant_list); 3 external calls (get, format!, vec!).


##### `set_discriminator_titles`  (lines 1851–1864)

```
fn set_discriminator_titles(props: &mut Map<String, Value>, owner: &str)
```

**Purpose**: Adds titles to fixed discriminator properties such as `method`, `type`, or `status`. This helps code generators create better names for those literal fields.

**Data flow**: It receives a properties map and owner name → finds fixed literal discriminator properties → inserts a title if one is missing.

**Call relations**: Object and variant annotation call this after identifying the schema owner.

*Call graph*: calls 2 internal fn (string_literal, to_pascal_case); called by 2 (annotate_object, annotate_variant_list); 3 external calls (get_mut, String, format!).


##### `variant_title`  (lines 1866–1871)

```
fn variant_title(value: &Value) -> Option<&str>
```

**Purpose**: Reads the `title` field from a schema variant if it has one.

**Data flow**: It receives a JSON value → checks whether it is an object with a string `title` → returns that title if present.

**Call relations**: Variant annotation uses this to avoid renaming variants that already have explicit titles.

*Call graph*: called by 1 (annotate_variant_list); 1 external calls (as_object).


##### `to_pascal_case`  (lines 1873–1892)

```
fn to_pascal_case(input: &str) -> String
```

**Purpose**: Converts names like `thread-start` or `thread_start` into `ThreadStart`. This produces Rust- and TypeScript-style type names.

**Data flow**: It receives text → capitalizes the first letter after separators → skips `_` and `-` → returns the converted string.

**Call relations**: Variant and discriminator title generation use this when turning protocol method names into model names.

*Call graph*: called by 2 (set_discriminator_titles, variant_definition_name); 1 external calls (new).


##### `ensure_dir`  (lines 1894–1897)

```
fn ensure_dir(dir: &Path) -> Result<()>
```

**Purpose**: Creates an output directory and any missing parent directories. It adds context to errors so failures say which directory could not be created.

**Data flow**: It receives a directory path → calls the filesystem to create it → returns success or an error.

**Call relations**: All disk-writing generation paths use this before writing into an output folder.

*Call graph*: called by 4 (generate_internal_json_schema, generate_json_with_experimental, generate_ts_with_options, write_json_schema_with_return); 1 external calls (create_dir_all).


##### `rewrite_named_ref_to_namespace`  (lines 1899–1924)

```
fn rewrite_named_ref_to_namespace(value: &mut Value, ns: &str, name: &str)
```

**Purpose**: Rewrites references to one named definition so they point into a namespace. It handles both direct references and references to subpaths under that definition.

**Data flow**: It receives a mutable JSON value, namespace, and name → walks all children → replaces matching `$ref` strings.

**Call relations**: Bundle construction uses this when a root schema had a nested definition that was forced into a namespace.

*Call graph*: called by 1 (build_schema_bundle); 1 external calls (format!).


##### `prepend_header_if_missing`  (lines 1926–1946)

```
fn prepend_header_if_missing(path: &Path) -> Result<()>
```

**Purpose**: Adds the generated-code warning header to a TypeScript file if it is not already present.

**Data flow**: It receives a file path → reads the file → if the header is missing, rewrites the file with the header followed by original content.

**Call relations**: The TypeScript generator runs this over generated files, in parallel, before formatting.

*Call graph*: 3 external calls (new, create, open).


##### `ts_files_in`  (lines 1948–1961)

```
fn ts_files_in(dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Lists TypeScript files directly inside one directory, without descending into subdirectories.

**Data flow**: It receives a directory path → reads entries → keeps files ending in `.ts` → sorts and returns the paths.

**Call relations**: Index-file generation uses this to know what files to re-export.

*Call graph*: called by 1 (generate_index_ts); 3 external calls (new, new, read_dir).


##### `ts_files_in_recursive`  (lines 1963–1981)

```
fn ts_files_in_recursive(dir: &Path) -> Result<Vec<PathBuf>>
```

**Purpose**: Lists all TypeScript files under a directory and its subdirectories.

**Data flow**: It receives a directory path → walks folders with a stack → collects `.ts` files → sorts and returns them.

**Call relations**: The TypeScript generator uses this for headers, formatting, and whitespace cleanup; experimental field filtering also uses it.

*Call graph*: called by 2 (filter_experimental_type_fields_ts, generate_ts_with_options); 4 external calls (new, new, read_dir, vec!).


##### `trim_trailing_whitespace_in_ts_files`  (lines 1983–1994)

```
fn trim_trailing_whitespace_in_ts_files(paths: &[PathBuf]) -> Result<()>
```

**Purpose**: Removes trailing spaces and tabs from generated TypeScript files. This keeps generated output clean and stable in version control.

**Data flow**: It receives a list of paths → reads each file → trims trailing line whitespace → writes back only if changed.

**Call relations**: The TypeScript generator runs this as its final cleanup step.

*Call graph*: calls 1 internal fn (trim_trailing_line_whitespace); called by 1 (generate_ts_with_options); 2 external calls (read_to_string, write).


##### `trim_trailing_line_whitespace`  (lines 1996–2007)

```
fn trim_trailing_line_whitespace(content: &str) -> String
```

**Purpose**: Removes spaces and tabs at the end of each line while preserving line breaks. It works on text already loaded in memory.

**Data flow**: It receives text → processes each line → returns cleaned text.

**Call relations**: File cleanup and schema fixture generation use this shared text helper.

*Call graph*: called by 2 (trim_trailing_whitespace_in_ts_files, generate_typescript_schema_fixture_subtree_for_tests); 1 external calls (with_capacity).


##### `generate_index_ts`  (lines 2011–2028)

```
fn generate_index_ts(out_dir: &Path) -> Result<PathBuf>
```

**Purpose**: Writes an `index.ts` file that re-exports generated TypeScript types from one directory. This gives consumers a single import point.

**Data flow**: It receives an output directory → lists TypeScript files there and checks for v2 files → builds index content with a header → writes `index.ts`.

**Call relations**: The TypeScript generator calls this for the root output and the `v2` subdirectory.

*Call graph*: calls 3 internal fn (generated_index_ts_with_header, index_ts_entries, ts_files_in); called by 1 (generate_ts_with_options); 2 external calls (join, create).


##### `generate_index_ts_tree`  (lines 2030–2061)

```
fn generate_index_ts_tree(tree: &mut BTreeMap<PathBuf, String>)
```

**Purpose**: Adds `index.ts` files to an in-memory TypeScript file tree. It mirrors disk index generation for fixture creation.

**Data flow**: It receives a map of paths to contents → computes root and v2 export entries → inserts index files into the map.

**Call relations**: Schema fixture generation uses this before comparing in-memory generated TypeScript output.

*Call graph*: calls 1 internal fn (index_ts_entries); called by 1 (generate_typescript_schema_fixture_subtree_for_tests); 1 external calls (from).


##### `generated_index_ts_with_header`  (lines 2063–2068)

```
fn generated_index_ts_with_header(content: String) -> String
```

**Purpose**: Prepends the generated-code warning header to index file content.

**Data flow**: It receives index body text → allocates space for header plus body → returns the combined string.

**Call relations**: Disk index generation uses this before writing `index.ts`.

*Call graph*: called by 1 (generate_index_ts); 1 external calls (with_capacity).


##### `index_ts_entries`  (lines 2070–2091)

```
fn index_ts_entries(paths: &[&Path], has_v2_ts: bool) -> String
```

**Purpose**: Builds the export lines for a TypeScript index file. It skips the index file itself and one special `EventMsg` type.

**Data flow**: It receives TypeScript paths and a flag for whether v2 exists → extracts unique file stems → writes `export type` lines and optionally a `v2` namespace export → returns the text.

**Call relations**: Both disk and in-memory index generation use this to produce consistent index contents.

*Call graph*: called by 2 (generate_index_ts, generate_index_ts_tree); 3 external calls (iter, new, format!).


##### `tests::generated_ts_optional_nullable_fields_only_in_params`  (lines 2107–2327)

```
fn generated_ts_optional_nullable_fields_only_in_params() -> Result<()>
```

**Purpose**: Checks generated TypeScript fixtures for important public-shape rules: no experimental API in stable output, no `undefined` unions, and optional nullable fields only where allowed.

**Data flow**: It reads fixture files → searches their text for forbidden patterns and missing removals → fails the test with detailed offending locations if rules are broken.

**Call relations**: This test protects the TypeScript export pipeline and experimental filtering behavior.

*Call graph*: calls 1 internal fn (read_schema_fixture_subtree); 9 external calls (new, new, new, schema_root, assert!, assert_eq!, format!, matches!, from_utf8).


##### `tests::schema_root`  (lines 2329–2338)

```
fn schema_root() -> Result<PathBuf>
```

**Purpose**: Finds the root directory that contains schema fixtures for tests.

**Data flow**: It locates the known TypeScript fixture resource → moves up to the schema root directory → returns that path.

**Call relations**: The TypeScript fixture test calls this before reading fixture files.

*Call graph*: 1 external calls (find_resource!).


##### `tests::generate_ts_with_experimental_api_retains_experimental_entries`  (lines 2341–2369)

```
fn generate_ts_with_experimental_api_retains_experimental_entries() -> Result<()>
```

**Purpose**: Verifies that raw TypeScript export still contains experimental methods and fields when experimental filtering is not applied.

**Data flow**: It exports selected types to strings → checks for experimental method, parameter, response, and field names → returns success if they are present.

**Call relations**: This test confirms that filtering, not the base exporter, is responsible for hiding experimental API.

*Call graph*: 4 external calls (export_to_string, export_to_string, export_to_string, assert_eq!).


##### `tests::stable_schema_filter_removes_mock_thread_start_field`  (lines 2372–2395)

```
fn stable_schema_filter_removes_mock_thread_start_field() -> Result<()>
```

**Purpose**: Checks that the stable JSON schema filter removes an experimental field from `ThreadStartParams`.

**Data flow**: It writes a temporary schema → bundles it → applies the experimental filter → inspects the resulting definition → asserts the experimental property is gone.

**Call relations**: This directly exercises schema bundling plus field filtering.

*Call graph*: calls 2 internal fn (build_schema_bundle, filter_experimental_schema); 6 external calls (assert_eq!, format!, create_dir, remove_dir_all, temp_dir, vec!).


##### `tests::build_schema_bundle_rewrites_root_helper_refs_to_namespaced_defs`  (lines 2398–2477)

```
fn build_schema_bundle_rewrites_root_helper_refs_to_namespaced_defs() -> Result<()>
```

**Purpose**: Verifies that bundle construction rewrites references from shared root helper schemas to v2 definitions when needed.

**Data flow**: It builds a small artificial set of schemas → bundles them → checks that references to `ThreadId`, `MessagePhase`, and `UserInput` point into `definitions.v2`.

**Call relations**: This protects the reference-rewriting logic used by the JSON bundle generator.

*Call graph*: calls 1 internal fn (build_schema_bundle); 2 external calls (assert_eq!, vec!).


##### `tests::build_flat_v2_schema_keeps_shared_root_schemas_and_dependencies`  (lines 2480–2656)

```
fn build_flat_v2_schema_keeps_shared_root_schemas_and_dependencies() -> Result<()>
```

**Purpose**: Checks that the flat v2 bundle includes v2 definitions plus shared root request/notification schemas and their dependencies.

**Data flow**: It creates an artificial full bundle → flattens it → inspects titles, included definitions, kept variants, and absence of `#/definitions/v2/` references.

**Call relations**: This test protects the flat v2 schema path used for downstream Python-style code generation.

*Call graph*: calls 1 internal fn (build_flat_v2_schema); 2 external calls (assert_eq!, json!).


##### `tests::experimental_type_fields_ts_filter_handles_interface_shape`  (lines 2659–2694)

```
fn experimental_type_fields_ts_filter_handles_interface_shape() -> Result<()>
```

**Purpose**: Verifies that TypeScript experimental field filtering works on `export interface` files, not only type aliases.

**Data flow**: It writes a sample interface file → filters one experimental field → reads the result → checks that only the unstable field was removed.

**Call relations**: This test directly exercises the TypeScript field filter on an interface-shaped file.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts); 6 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, temp_dir).


##### `tests::experimental_type_fields_ts_filter_keeps_imports_used_in_intersection_suffix`  (lines 2697–2738)

```
fn experimental_type_fields_ts_filter_keeps_imports_used_in_intersection_suffix() -> Result<()>
```

**Purpose**: Checks that filtering a TypeScript field does not remove imports still used after the main object body, such as in an intersection type suffix.

**Data flow**: It writes a sample type with imports and an intersection suffix → removes one field → reads the result → asserts needed imports remain.

**Call relations**: This protects the unused-import pruning logic from being too aggressive.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts); 6 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, temp_dir).


##### `tests::experimental_type_fields_ts_filter_handles_generated_command_params_shape`  (lines 2741–2803)

```
fn experimental_type_fields_ts_filter_handles_generated_command_params_shape() -> Result<()>
```

**Purpose**: Verifies that the TypeScript field filter handles the comment-heavy shape produced for generated command parameter types.

**Data flow**: It writes a realistic generated type file → removes one experimental field → checks that the neighboring stable field and needed import remain.

**Call relations**: This guards the top-level field splitter and comment handling used in stable TypeScript exports.

*Call graph*: calls 1 internal fn (filter_experimental_type_fields_ts); 6 external calls (assert_eq!, format!, create_dir_all, read_to_string, write, temp_dir).


##### `tests::stable_schema_filter_removes_mock_experimental_method`  (lines 2806–2818)

```
fn stable_schema_filter_removes_mock_experimental_method() -> Result<()>
```

**Purpose**: Checks that the stable JSON schema filter removes an experimental client method from `ClientRequest`.

**Data flow**: It writes and bundles a `ClientRequest` schema → filters it → serializes the bundle → asserts the experimental method string is absent.

**Call relations**: This directly tests method pruning in the JSON schema filter.

*Call graph*: calls 2 internal fn (build_schema_bundle, filter_experimental_schema); 7 external calls (assert_eq!, format!, create_dir, remove_dir_all, to_string, temp_dir, vec!).


##### `tests::generate_json_filters_experimental_fields_and_methods`  (lines 2821–2959)

```
fn generate_json_filters_experimental_fields_and_methods() -> Result<()>
```

**Purpose**: Runs the JSON generator in stable mode and verifies that experimental fields, methods, type files, and v2 namespace references are absent from outputs.

**Data flow**: It generates schemas into a temporary directory → reads individual and bundled files → checks removed experimental content and required stable methods → validates the flat v2 bundle shape.

**Call relations**: This is the broad end-to-end test for stable JSON schema generation.

*Call graph*: calls 2 internal fn (generate_json_with_experimental, read_json_value); 6 external calls (assert_eq!, format!, create_dir, read_to_string, remove_dir_all, temp_dir).


##### `tests::generate_json_includes_remote_control_methods_with_experimental_api`  (lines 2962–2987)

```
fn generate_json_includes_remote_control_methods_with_experimental_api() -> Result<()>
```

**Purpose**: Verifies that experimental remote-control methods and schemas are included when JSON generation is explicitly run with experimental API enabled.

**Data flow**: It generates schemas with the experimental flag on → reads `ClientRequest.json` and checks method names → checks that related v2 schema files exist.

**Call relations**: This complements the stable filtering test by proving the opt-in experimental path keeps those APIs.

*Call graph*: calls 1 internal fn (generate_json_with_experimental); 6 external calls (assert!, format!, create_dir, read_to_string, remove_dir_all, temp_dir).


### `app-server-protocol/src/schema_fixtures.rs`

`orchestration` · `schema generation and fixture tests`

This file is a bridge between the protocol types in Rust and the schema files stored on disk. In everyday terms, it keeps the project's “official copies” of the protocol documents tidy and comparable. Without it, tests could fail just because Windows used different line endings, JSON object keys appeared in a different order, or old generated files were left behind.

The file has two main jobs. First, it can read a schema fixture tree from disk. While reading, it normalizes the contents: JSON is parsed and written back in a stable pretty format, TypeScript line endings are made consistent, and the standard generated banner is ignored for comparisons. This makes fixture tests focus on real schema meaning instead of formatting noise.

Second, it can regenerate the fixture directories. It empties the existing TypeScript and JSON schema folders, asks the crate’s schema generators to write fresh files, and optionally includes experimental protocol pieces.

For tests, it can also build an in-memory TypeScript fixture tree directly from Rust protocol types. A small visitor, `TypeScriptFixtureCollector`, walks through TypeScript type dependencies so related types are included once, like collecting all recipe cards needed for one meal without duplicating cards already picked.

#### Function details

##### `read_schema_fixture_tree`  (lines 29–42)

```
fn read_schema_fixture_tree(schema_root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Reads the full saved schema fixture set from a schema root directory. It gathers both the TypeScript fixtures and the JSON fixtures into one ordered collection so tests can compare them as a single tree.

**Data flow**: It receives the path to the schema root. From that, it looks under `typescript` and `json`, reads every file in each subtree through `collect_files_recursive`, prefixes each relative path with its fixture kind, and returns a sorted map from relative path to file bytes.

**Call relations**: This is a top-level reader for fixture comparisons. It delegates the actual directory walking and file cleanup to `collect_files_recursive`, so callers get normalized fixture contents without needing to know the on-disk details.

*Call graph*: calls 1 internal fn (collect_files_recursive); 3 external calls (new, join, from).


##### `read_schema_fixture_subtree`  (lines 44–51)

```
fn read_schema_fixture_subtree(
    schema_root: &Path,
    label: &str,
) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Reads just one named part of the schema fixture directory, such as only the TypeScript tree or another labeled subtree. This is useful for tests that want to inspect a smaller slice of the fixtures.

**Data flow**: It receives a schema root and a label. It joins them into one directory path, asks `collect_files_recursive` to read that directory, and returns the normalized files as a sorted map. If reading fails, it adds context naming the subtree that failed.

**Call relations**: This function is called by `generated_ts_optional_nullable_fields_only_in_params`, a test or check that needs a specific fixture subtree. It uses the same recursive reader as the full-tree reader, so both paths normalize files in the same way.

*Call graph*: calls 1 internal fn (collect_files_recursive); called by 1 (generated_ts_optional_nullable_fields_only_in_params); 1 external calls (join).


##### `generate_typescript_schema_fixture_subtree_for_tests`  (lines 54–80)

```
fn generate_typescript_schema_fixture_subtree_for_tests() -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Builds the TypeScript schema fixture files in memory for tests, starting from the protocol’s main request and notification types. It lets tests compare generated TypeScript without writing files to disk.

**Data flow**: It starts with empty collections for generated files and already-seen Rust types. It exports TypeScript for client requests, client notifications, server requests, server notifications, and their response dependencies. Then it removes experimental TypeScript entries, adds an index file, trims trailing whitespace, converts text into bytes, and returns the completed file map.

**Call relations**: This function is a test helper that coordinates several smaller pieces. It uses `collect_typescript_fixture_file` indirectly through dependency visitors, asks protocol helper functions to visit response types, then passes the result through export helpers such as `filter_experimental_ts_tree`, `generate_index_ts_tree`, and `trim_trailing_line_whitespace` so the output matches normal generated fixtures.

*Call graph*: calls 4 internal fn (filter_experimental_ts_tree, generate_index_ts_tree, trim_trailing_line_whitespace, visit_typescript_fixture_dependencies); 2 external calls (new, new).


##### `write_schema_fixtures`  (lines 86–88)

```
fn write_schema_fixtures(schema_root: &Path, prettier: Option<&Path>) -> Result<()>
```

**Purpose**: Regenerates the checked-in schema fixture directories using the default options. Tooling can call this when the protocol schema has intentionally changed and the saved fixtures need to be refreshed.

**Data flow**: It receives the schema root directory and an optional path to Prettier, a JavaScript formatter. It fills in default fixture options and passes everything to `write_schema_fixtures_with_options`. It returns success or any error from that fuller regeneration step.

**Call relations**: This is the simple public entry point for fixture writing. It exists so callers that do not care about special options can avoid constructing `SchemaFixtureOptions` themselves.

*Call graph*: calls 1 internal fn (write_schema_fixtures_with_options); 1 external calls (default).


##### `write_schema_fixtures_with_options`  (lines 91–113)

```
fn write_schema_fixtures_with_options(
    schema_root: &Path,
    prettier: Option<&Path>,
    options: SchemaFixtureOptions,
) -> Result<()>
```

**Purpose**: Regenerates both TypeScript and JSON schema fixture directories, with an option to include experimental API items. It also removes stale files first, so deleted schema files do not linger unnoticed.

**Data flow**: It receives the schema root, an optional Prettier path, and fixture options. It builds output paths for `typescript` and `json`, empties and recreates both directories, calls the TypeScript generator with the selected options, then calls the JSON generator with the same experimental setting. It returns success once both sets have been written.

**Call relations**: This is the main write-side coordinator. `write_schema_fixtures` calls it with defaults, and it hands work to `ensure_empty_dir`, `generate_ts_with_options`, and `generate_json_with_experimental` in that order.

*Call graph*: calls 2 internal fn (default, ensure_empty_dir); called by 1 (write_schema_fixtures); 3 external calls (join, generate_json_with_experimental, generate_ts_with_options).


##### `ensure_empty_dir`  (lines 115–122)

```
fn ensure_empty_dir(dir: &Path) -> Result<()>
```

**Purpose**: Makes sure a directory exists and contains no old files. This prevents stale generated schema files from staying on disk after regeneration.

**Data flow**: It receives a directory path. If the path already exists, it removes the whole directory tree. Then it creates the directory again. It returns success or an error with a helpful message if removal or creation fails.

**Call relations**: This helper is used by `write_schema_fixtures_with_options` before new TypeScript and JSON schemas are generated. It is the cleanup step that makes regeneration safe and complete.

*Call graph*: called by 1 (write_schema_fixtures_with_options); 3 external calls (exists, create_dir_all, remove_dir_all).


##### `read_file_bytes`  (lines 124–150)

```
fn read_file_bytes(path: &Path) -> Result<Vec<u8>>
```

**Purpose**: Reads one fixture file and normalizes it so comparisons are fair across platforms and generator runs. It treats JSON and TypeScript specially because their formatting can vary without changing the schema meaning.

**Data flow**: It receives a file path and reads the raw bytes from disk. For JSON files, it parses the bytes, canonicalizes the JSON structure, and writes it back in pretty form. For TypeScript files, it decodes UTF-8 text, changes Windows-style line endings to Unix-style line endings, and removes the standard generated header if present. Other files are returned unchanged.

**Call relations**: This function is called by `collect_files_recursive` for every file it finds. It hands JSON work to `canonicalize_json`, while it performs TypeScript text cleanup directly.

*Call graph*: calls 1 internal fn (canonicalize_json); called by 1 (collect_files_recursive); 5 external calls (extension, from_utf8, from_slice, to_vec_pretty, read).


##### `canonicalize_json`  (lines 152–208)

```
fn canonicalize_json(value: &Value) -> Value
```

**Purpose**: Turns a JSON value into a stable form for fixture comparison. It sorts object keys and, where safe, sorts arrays whose order does not affect JSON Schema meaning.

**Data flow**: It receives a JSON value. If the value is an object, it sorts the keys and canonicalizes each child. If it is an array, it canonicalizes each item and sorts the array only when every item has a safe sort key. Primitive values such as strings, numbers, booleans, and null are copied as-is. It returns the cleaned-up JSON value.

**Call relations**: This is used by `read_file_bytes` when reading JSON fixture files. It relies on `schema_array_item_sort_key` to decide whether an array can be safely sorted, avoiding changes to arrays where order might be meaningful.

*Call graph*: calls 1 internal fn (schema_array_item_sort_key); called by 1 (read_file_bytes); 6 external calls (with_capacity, Array, Object, clone, with_capacity, to_string).


##### `schema_array_item_sort_key`  (lines 210–227)

```
fn schema_array_item_sort_key(item: &Value) -> Option<String>
```

**Purpose**: Decides whether one JSON array item has a safe, stable key that can be used for sorting. This lets fixture comparison ignore harmless ordering differences without changing arrays whose order could matter.

**Data flow**: It receives one JSON value from an array. Simple values get keys based on their type and value. Objects get a key only if they have a string `$ref` field or a string `title` field. Nested arrays and objects without those known fields get no key. The result is either a string sort key or `None` to mean “do not sort this array.”

**Call relations**: This helper is called only by `canonicalize_json`. It acts like a safety check: if any array item cannot produce a key, `canonicalize_json` keeps that whole array in its original order.

*Call graph*: called by 1 (canonicalize_json); 1 external calls (format!).


##### `collect_files_recursive`  (lines 229–268)

```
fn collect_files_recursive(root: &Path) -> Result<BTreeMap<PathBuf, Vec<u8>>>
```

**Purpose**: Walks through a directory tree and reads every regular file beneath it. It returns paths relative to the root so the result can be compared or written without depending on the machine’s absolute paths.

**Data flow**: It receives a root directory. It keeps a stack of directories to visit, reads each directory entry, follows symlinks through file metadata, descends into subdirectories, skips non-file entries, and reads file contents with `read_file_bytes`. It returns a sorted map from relative file path to normalized bytes.

**Call relations**: Both `read_schema_fixture_tree` and `read_schema_fixture_subtree` rely on this function for the actual disk traversal. It calls `read_file_bytes`, so every collected file is normalized before it reaches the caller.

*Call graph*: calls 1 internal fn (read_file_bytes); called by 2 (read_schema_fixture_subtree, read_schema_fixture_tree); 4 external calls (new, metadata, read_dir, vec!).


##### `collect_typescript_fixture_file`  (lines 270–299)

```
fn collect_typescript_fixture_file(
    files: &mut BTreeMap<PathBuf, String>,
    seen: &mut HashSet<TypeId>,
) -> Result<()>
```

**Purpose**: Exports one Rust type as a TypeScript fixture file and then discovers the other TypeScript types it depends on. It avoids exporting the same Rust type more than once.

**Data flow**: It receives mutable maps for generated files and already-seen type IDs, and it is parameterized by the Rust type to export. If that type has no output path or was already seen, it stops. Otherwise it exports the TypeScript text, normalizes the output path and line endings, stores the file, then creates a `TypeScriptFixtureCollector` to visit and collect dependency types. It returns success or the first export error encountered.

**Call relations**: This is the core worker behind in-memory TypeScript fixture generation. `TypeScriptFixtureCollector::visit` calls it whenever the TypeScript type visitor finds a dependency, and it calls `normalize_relative_fixture_path` before inserting the file into the fixture map.

*Call graph*: calls 1 internal fn (normalize_relative_fixture_path); 3 external calls (export_to_string, output_path, visit_dependencies).


##### `normalize_relative_fixture_path`  (lines 301–303)

```
fn normalize_relative_fixture_path(path: &Path) -> PathBuf
```

**Purpose**: Cleans up a generated fixture path into a consistent relative path. This helps the same generated TypeScript file appear under the same key across platforms.

**Data flow**: It receives a path, breaks it into path components, and collects those components into a new `PathBuf`. The returned path is used as the key for a fixture file.

**Call relations**: This small helper is called by `collect_typescript_fixture_file` just before the generated TypeScript text is stored. It keeps path handling centralized for generated fixture entries.

*Call graph*: called by 1 (collect_typescript_fixture_file); 1 external calls (components).


##### `visit_typescript_fixture_dependencies`  (lines 305–320)

```
fn visit_typescript_fixture_dependencies(
    files: &mut BTreeMap<PathBuf, String>,
    seen: &mut HashSet<TypeId>,
    visit: impl FnOnce(&mut TypeScriptFixtureCollector<'_>),
) -> Result<()>
```

**Purpose**: Runs a caller-provided dependency visit using the fixture collector and converts any collection error into the function’s result. It is a small wrapper that makes dependency visiting fit neatly into normal error handling.

**Data flow**: It receives the current generated file map, the set of already-seen types, and a callback that knows which protocol types to visit. It builds a `TypeScriptFixtureCollector`, passes it to the callback, checks whether the collector recorded an error, and returns either that error or success.

**Call relations**: This is called by `generate_typescript_schema_fixture_subtree_for_tests` when it needs to add client and server response types. The callback performs the protocol-specific visiting, while this function supplies the common collector setup and error check.

*Call graph*: called by 1 (generate_typescript_schema_fixture_subtree_for_tests).


##### `TypeScriptFixtureCollector::visit`  (lines 329–334)

```
fn visit(&mut self)
```

**Purpose**: Responds when the TypeScript generation library reports a dependent type. It collects that dependency as another fixture file unless an earlier dependency already failed.

**Data flow**: It receives the collector state and the dependency type being visited. If an error has already been stored, it does nothing. Otherwise it calls `collect_typescript_fixture_file` for that type and stores any resulting error inside the collector.

**Call relations**: This method is called by the `ts_rs` dependency visitor machinery during TypeScript export. It feeds each discovered type back into `collect_typescript_fixture_file`, which may recursively visit more dependencies.


##### `tests::canonicalize_json_sorts_string_arrays`  (lines 343–347)

```
fn canonicalize_json_sorts_string_arrays()
```

**Purpose**: Checks that `canonicalize_json` sorts arrays of strings into a stable order. This protects fixture comparisons from harmless ordering differences in simple JSON arrays.

**Data flow**: It builds a JSON array containing `b` then `a`, builds the expected array containing `a` then `b`, calls `canonicalize_json`, and asserts that the result matches the expected sorted value.

**Call relations**: This test directly exercises `canonicalize_json`. It documents one important promise of the normalization logic used when `read_file_bytes` reads JSON fixtures.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::canonicalize_json_sorts_schema_ref_arrays`  (lines 350–360)

```
fn canonicalize_json_sorts_schema_ref_arrays()
```

**Purpose**: Checks that `canonicalize_json` sorts arrays of JSON Schema reference objects by their `$ref` value. This covers a common schema case where array order should not affect validation meaning.

**Data flow**: It builds a JSON array with references to `B` and then `A`, builds the expected array with `A` before `B`, calls `canonicalize_json`, and asserts that the normalized result has the expected order.

**Call relations**: This test verifies the cooperation between `canonicalize_json` and `schema_array_item_sort_key`. It makes sure schema reference arrays are treated as safely sortable during fixture normalization.

*Call graph*: 2 external calls (assert_eq!, json!).


### Transport and server contract glue
This final group captures the transport-layer message contracts, remote-control transport protocol, server error shaping, and downstream adapters that consume the app-server schemas.

### `app-server-transport/src/lib.rs`

`io_transport` · `cross-cutting`

This file does not contain its own logic. Instead, it acts like a reception desk for the transport crate: other code can come here to find the pieces needed to talk to the app server, without needing to know how the crate is split internally.

The transport crate appears to cover several ways of connecting to or controlling an app server, including standard input/output, WebSocket connections, and a remote-control socket. It also exposes startup helpers, such as paths for lock files and control sockets, plus policy and error types that explain when remote control is allowed, unavailable, or disabled by requirements.

The file pulls in two internal modules: `outgoing_message`, which defines the shapes and errors for messages being sent out, and `transport`, which provides the connection setup, startup coordination, remote-control policy, and event types. Then it re-exports selected items with `pub use`, meaning outside code can import them directly from this crate instead of reaching into its private layout.

This matters because it keeps the crate’s public surface stable and easy to understand. Internal files can be reorganized later, but users of the library can keep depending on this single, tidy API.


### `app-server-transport/src/outgoing_message.rs`

`data_model` · `request handling`

This file is like the outgoing mail format for the app server. When the server needs to talk to a connected client, it may send a request, a notification, a successful response, or an error response. The `OutgoingMessage` enum gathers those possibilities into one type, so the rest of the transport code can put “something to send” into a queue without caring which exact kind it is.

The file also defines `ConnectionId`, a stable numeric label for a client connection. Its display behavior prints just the number, which is useful for logs and human-readable messages.

Two response structs, `OutgoingResponse` and `OutgoingError`, describe the two ways the server can answer a client request: with a result or with a JSON-RPC error. JSON-RPC is a common request-and-response message format; here, the imported protocol types provide the official request IDs, results, notifications, and error shapes.

Finally, `QueuedOutgoingMessage` wraps an outgoing message while it waits to be written to the client. It can optionally carry a one-time completion signal, called a `oneshot` channel, so another task can be told when the message has actually been written. Without this file, different parts of the transport layer would have to invent their own message shapes and queue bookkeeping, making routing and writing responses much harder to keep consistent.

#### Function details

##### `ConnectionId::fmt`  (lines 16–18)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This function defines how a connection ID appears when it is turned into text. It prints the underlying number, which makes connection IDs easy to read in logs, diagnostics, or formatted messages.

**Data flow**: It receives a `ConnectionId` and a formatter, which is the standard Rust object used for building text output. It writes the numeric ID into that formatter. The result is either success or a formatting error if the formatter could not accept the text.

**Call relations**: Whenever code formats a `ConnectionId` for display, Rust calls this function automatically. Inside, it hands the work to the standard `write!` formatting machinery, so callers get a plain numeric label instead of a debug-style wrapper.

*Call graph*: 1 external calls (write!).


##### `QueuedOutgoingMessage::new`  (lines 52–57)

```
fn new(message: OutgoingMessage) -> Self
```

**Purpose**: This function creates a queue-ready outgoing message with no completion notification attached. It is the simple default way to put a server-to-client message into the outgoing pipeline.

**Data flow**: It takes an `OutgoingMessage` as input. It stores that message in a new `QueuedOutgoingMessage` and sets the optional write-completion sender to `None`, meaning nobody is waiting to be notified when the write finishes. It returns the newly wrapped message.

**Call relations**: Code that enqueues messages for connected clients calls this when it wants to place a message onto the outgoing writer queue. Later parts of the transport system can read the wrapped message and send it to the client; if no completion sender was attached, they do not need to report back after writing.

*Call graph*: called by 8 (enqueue_incoming_message, shutdown_cancels_blocked_outbound_forwarding, remote_control_http_mode_enrolls_before_connecting, remote_control_transport_clears_outgoing_buffer_when_backend_acks, remote_control_transport_manages_virtual_clients_and_routes_messages, enqueue_incoming_request_does_not_block_when_writer_queue_is_full, broadcast_does_not_block_on_slow_connection, to_connection_stdio_waits_instead_of_disconnecting_when_writer_queue_is_full).


### `app-server-transport/src/transport/remote_control/protocol.rs`

`io_transport` · `remote control setup and message exchange`

Remote control needs two things to work safely: a clear message format, and a careful way to decide which remote service the app is allowed to contact. This file provides both. It defines small request and response shapes for enrollment, token refresh, pairing, and pairing-status checks. These shapes are turned into or read from JSON, so both sides of the connection agree on field names and meaning.

It also defines the live message envelopes passed between the remote client and the local server. A client sends JSON-RPC messages, chunks of large messages, acknowledgements, pings, and close notices. The server sends responses, chunks, acknowledgements, and pongs. The envelope around each message adds a client id, stream id, and sequence id, much like a postal label that says who the message is for and where it fits in order.

The URL functions are a safety gate. They accept HTTPS URLs for chatgpt.com or chatgpt-staging.com, and allow HTTP only for localhost development. They then build the exact enrollment, refresh, pairing, pairing-status, and websocket URLs. Without this file, different parts of remote control could disagree about message shape, lose track of message chunks, or accidentally connect to an unsafe host.

#### Function details

##### `RemoteControlPairingStatusRequest::from`  (lines 71–82)

```
fn from(code: RemoteControlPairingStatusCode) -> Self
```

**Purpose**: This converts a pairing code into the request body used to ask whether pairing has been claimed. It makes sure exactly the right field is filled in, depending on whether the code is the normal pairing code or the manual pairing code.

**Data flow**: It receives a RemoteControlPairingStatusCode value. If that value holds a normal pairing code, it creates a request with pairing_code filled and manual_pairing_code empty. If it holds a manual code, it does the reverse. The result is a RemoteControlPairingStatusRequest ready to be serialized as JSON.

**Call relations**: There are no explicit callers shown in the graph, because this is a standard Rust conversion method that can be used indirectly through conversion helpers. It sits between code that has a pairing code and the HTTP request code that needs a correctly shaped status-check body.


##### `StreamId::new_random`  (lines 99–101)

```
fn new_random() -> Self
```

**Purpose**: This creates a fresh stream identifier for a remote-control conversation. A stream id helps separate one flow of messages from another, like giving each phone call its own call number.

**Data flow**: It takes no input. It asks the UUID library for a new time-ordered random UUID, turns that UUID into text, wraps it in a StreamId, and returns it.

**Call relations**: When remote-control code needs a new stream, this function supplies an id that can be placed into client and server envelopes. It delegates the actual unique-id creation to the external UUID function now_v7.

*Call graph*: 1 external calls (now_v7).


##### `ServerEvent::segment_id`  (lines 172–177)

```
fn segment_id(&self) -> Option<usize>
```

**Purpose**: This answers one simple question: does this server event represent one chunk of a larger message, and if so, which chunk number is it? It is useful for tracking acknowledgements and resend work for split-up messages.

**Data flow**: It receives a server event. If the event is a ServerMessageChunk, it extracts and returns that chunk's segment_id. For a whole server message, an acknowledgement, or a pong, it returns nothing because those events are not individual chunks.

**Call relations**: This helper belongs to the server-event type itself. Other message-sending or reconnect logic can use it when it needs to treat chunked messages differently from ordinary events.


##### `is_allowed_remote_control_chatgpt_host`  (lines 193–201)

```
fn is_allowed_remote_control_chatgpt_host(host: &Option<Host<&str>>) -> bool
```

**Purpose**: This checks whether a URL host is one of the ChatGPT hosts that remote control is allowed to use. It prevents lookalike or unrelated domains from being accepted.

**Data flow**: It receives an optional parsed host from a URL. If the host is not a domain name, it returns false. If it is a domain, it returns true only for chatgpt.com, chatgpt-staging.com, or their subdomains; otherwise it returns false.

**Call relations**: normalize_remote_control_base_url calls this during URL validation. It is one half of the safety check: this function covers real ChatGPT hosts, while is_localhost covers local development hosts.

*Call graph*: called by 1 (normalize_remote_control_base_url).


##### `is_localhost`  (lines 203–210)

```
fn is_localhost(host: &Option<Host<&str>>) -> bool
```

**Purpose**: This checks whether a URL points back to the same machine. That matters because local development may use plain HTTP, while public remote-control hosts must be HTTPS.

**Data flow**: It receives an optional parsed host from a URL. It returns true for the domain name localhost, for loopback IPv4 addresses such as 127.0.0.1, and for loopback IPv6 addresses such as ::1. All other hosts return false.

**Call relations**: normalize_remote_control_base_url calls this while deciding whether the URL scheme is allowed. Together with is_allowed_remote_control_chatgpt_host, it separates safe production targets from safe local testing targets.

*Call graph*: called by 1 (normalize_remote_control_base_url).


##### `normalize_remote_control_url`  (lines 212–258)

```
fn normalize_remote_control_url(
    remote_control_url: &str,
) -> io::Result<RemoteControlTarget>
```

**Purpose**: This turns a user-provided remote-control base URL into the exact set of endpoint URLs needed by the feature. It also chooses the correct websocket scheme: wss for secure HTTPS, ws for local HTTP.

**Data flow**: It receives a URL string. First it asks normalize_remote_control_base_url to parse, validate, and add a trailing slash if needed. Then it appends fixed paths for enrollment, refresh, pairing, pairing-status, and the websocket connection. If any URL cannot be built, it returns an input error. On success, it returns a RemoteControlTarget containing all five final URL strings.

**Call relations**: This is the main URL-building function used by remote-control setup paths such as load_or_enroll_server, persist_preference, enable, and resolve_persisted_preference, as well as many enrollment and preference tests. It hands validation to normalize_remote_control_base_url, then provides the rest of the system with concrete URLs to call.

*Call graph*: calls 1 internal fn (normalize_remote_control_base_url); called by 33 (load_or_enroll_server, persist_preference, enable, resolve_persisted_preference, clearing_persisted_remote_control_enrollment_removes_only_matching_entry, enroll_remote_control_server_parse_failure_includes_response_body, persisted_remote_control_enrollment_round_trips_by_target_and_account, remote_control_enrollment_refreshes_server_token_before_expiry, normalize_remote_control_url_rejects_unsupported_urls, start_remote_control (+15 more)).


##### `normalize_remote_control_base_url`  (lines 260–290)

```
fn normalize_remote_control_base_url(remote_control_url: &str) -> io::Result<Url>
```

**Purpose**: This parses and validates the base remote-control URL before anything tries to connect to it. It is the main guardrail that rejects unsafe schemes and untrusted hosts.

**Data flow**: It receives a URL string. It parses it into a URL object, adds a trailing slash to the path if one is missing, then checks the scheme and host. HTTPS is allowed for localhost and approved ChatGPT domains; HTTP is allowed only for localhost. If the URL fails parsing or safety checks, it returns an invalid-input error. If it passes, it returns the normalized URL object.

**Call relations**: normalize_remote_control_url calls this before building endpoint URLs, and environment_clients_url also calls it when it needs the normalized base. This function relies on is_localhost and is_allowed_remote_control_chatgpt_host for the host checks, and on the external URL parser to understand the input string.

*Call graph*: calls 2 internal fn (is_allowed_remote_control_chatgpt_host, is_localhost); called by 2 (environment_clients_url, normalize_remote_control_url); 2 external calls (parse, format!).


##### `tests::normalize_remote_control_url_accepts_chatgpt_https_urls`  (lines 298–337)

```
fn normalize_remote_control_url_accepts_chatgpt_https_urls()
```

**Purpose**: This test proves that approved ChatGPT HTTPS URLs are accepted and expanded into the expected remote-control endpoints. It covers both the main chatgpt.com domain and a staging subdomain.

**Data flow**: It feeds known-good ChatGPT URLs into normalize_remote_control_url. It compares the returned RemoteControlTarget values with the exact websocket, enroll, refresh, pair, and pair-status URLs that should be produced.

**Call relations**: The Rust test runner calls this test during automated testing. It protects the production URL behavior so future changes do not accidentally reject valid ChatGPT hosts or build the wrong endpoint paths.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_remote_control_url_accepts_localhost_urls`  (lines 340–376)

```
fn normalize_remote_control_url_accepts_localhost_urls()
```

**Purpose**: This test proves that localhost URLs work for development, both with HTTP and HTTPS. It also checks that HTTP becomes ws and HTTPS becomes wss for websocket connections.

**Data flow**: It gives normalize_remote_control_url two localhost base URLs. For each one, it checks that the returned RemoteControlTarget contains the expected endpoint strings and websocket scheme.

**Call relations**: The Rust test runner calls this during automated testing. It keeps local development support from being broken while the stricter production host checks remain in place.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_remote_control_url_rejects_unsupported_urls`  (lines 379–400)

```
fn normalize_remote_control_url_rejects_unsupported_urls()
```

**Purpose**: This test checks that unsafe or unsupported remote-control URLs are rejected. It is especially important because small domain-name mistakes can become security problems.

**Data flow**: It loops over several bad URL examples, such as plain HTTP for chatgpt.com, unrelated domains, old or lookalike domains, and fake localhost subdomains. Each URL is passed to normalize_remote_control_url, and the test confirms that the result is an invalid-input error with the expected message.

**Call relations**: The Rust test runner calls this test during automated testing. It exercises normalize_remote_control_url, which in turn uses the base-url validation helpers, so the test covers the file's main safety boundary.

*Call graph*: calls 1 internal fn (normalize_remote_control_url); 1 external calls (assert_eq!).


### `app-server/src/error_code.rs`

`util` · `cross-cutting request handling`

The app server speaks JSON-RPC, a request-and-response format where failures are sent back as structured error objects with a numeric code and a message. This file is the server’s small error-code toolbox. Instead of every caller remembering that “invalid request” is -32600 or “method not found” is -32601, they call a clearly named helper and get the right error shape back.

Think of it like a set of preprinted complaint forms at a service desk. Different workers may need to report different problems, but the form layout and official category codes must stay the same. Without this file, error replies could drift apart: the wrong code might be used, messages might be wrapped differently, or clients might receive inconsistent responses.

The public-facing pieces are constants for known error codes and helper functions such as `invalid_request`, `invalid_params`, and `internal_error`. Each helper accepts a message, then delegates to the private `error` function. That shared function builds a `JSONRPCErrorError` object with a code, the text message, and no extra data. The result is predictable, simple, and easy for client software to understand.

#### Function details

##### `invalid_request`  (lines 10–12)

```
fn invalid_request(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error saying the client sent a request that is not valid. This is used when the server cannot treat the incoming message as a proper request at all.

**Data flow**: It receives a human-readable message. It pairs that message with the standard “invalid request” numeric code, passes both to the shared error builder, and returns a structured JSON-RPC error object.

**Call relations**: Many request-processing paths call this when they reject a malformed or impossible request, such as during startup, request dispatch, process writing, watching, control sending, or configuration write failures. It hands the actual object construction to `error` so every invalid-request reply has the same shape.

*Call graph*: calls 1 internal fn (error); called by 38 (handle_thread_rollback_failed, send_control, start, command_no_longer_running_error, handle_process_write, watch, dispatch_initialized_client_request, config_write_error, map_fs_error, load_plugin_share_config_and_auth (+15 more)).


##### `method_not_found`  (lines 14–16)

```
fn method_not_found(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error saying the requested method or operation does not exist. This is how the server tells a client, in protocol terms, “I do not know how to do that.”

**Data flow**: It takes an explanatory message, combines it with the standard “method not found” code, and returns the JSON-RPC error object produced by the shared builder.

**Call relations**: Callers use this when a client asks for unsupported behavior, such as unsupported thread-store operations or unknown thread/core write actions. Like the other public helpers, it delegates to `error` for the common construction step.

*Call graph*: calls 1 internal fn (error); called by 3 (thread_turns_items_list, core_thread_write_error, unsupported_thread_store_operation).


##### `invalid_params`  (lines 18–20)

```
fn invalid_params(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error saying the method exists, but the client supplied bad arguments. This is different from an invalid request: the request is understandable, but its details are wrong.

**Data flow**: It receives a message explaining what was wrong with the parameters. It attaches the standard “invalid params” code and returns a structured error object.

**Call relations**: This is used by code that checks specific request details, such as terminal size conversion, standard-input writing, general writing, and process spawning. Those callers decide what is wrong; this function turns that decision into the correct JSON-RPC error response by calling `error`.

*Call graph*: calls 1 internal fn (error); called by 5 (write, terminal_size_from_protocol, write_stdin, process_spawn, terminal_size_from_protocol).


##### `internal_error`  (lines 22–24)

```
fn internal_error(message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Builds a JSON-RPC error saying something went wrong inside the server. It is used when the client request may be reasonable, but the server failed while trying to process it.

**Data flow**: It takes an explanatory message, combines it with the standard “internal error” code, and returns a JSON-RPC error object with no extra data attached.

**Call relations**: Server internals call this when failures occur during flows such as startup, uninitialized startup, response sending, request cancellation, event handling, or client error notification. It uses `error` so internal failures are reported in the same format as other JSON-RPC errors.

*Call graph*: calls 1 internal fn (error); called by 21 (apply_bespoke_event_handling, start, start_uninitialized, send_response_as, abort_pending_server_requests, cancel_requests_for_thread_cancels_all_thread_requests, notify_client_error_forwards_error_to_waiter, send_error_routes_to_target_connection, map_error, map_fs_error (+11 more)).


##### `error`  (lines 26–32)

```
fn error(code: i64, message: impl Into<String>) -> JSONRPCErrorError
```

**Purpose**: Creates the actual JSON-RPC error object used by all the named helper functions. It is the single place that defines the common error shape: code, message, and no extra data.

**Data flow**: It receives a numeric error code and a message value that can be turned into text. It converts the message into a `String`, puts the code and message into a `JSONRPCErrorError`, sets the optional data field to empty, and returns that object.

**Call relations**: The four named helpers call this after choosing the right standard code. Because they all funnel through this one builder, the rest of the server can create different kinds of errors without duplicating the object-building details.

*Call graph*: called by 4 (internal_error, invalid_params, invalid_request, method_not_found); 1 external calls (into).


### `mcp-server/src/outgoing_message.rs`

`io_transport` · `request handling and outgoing message delivery`

This file solves a practical communication problem: the server needs a safe, consistent way to talk back to the client. Some messages are simple announcements, some are replies to client requests, and some are server requests that need an answer later. Without this file, different parts of the server could format messages differently, lose track of replies, or send invalid JSON-RPC, which is the standard message shape used here.

The main piece is `OutgoingMessageSender`. Think of it like a post office counter. Other server code hands it a message. It puts the right label on it, gives requests a unique ID, and drops the message into a channel, which is an in-memory queue used by asynchronous tasks. When the server sends a request to the client, it also stores a one-time callback in a map. Later, when the client’s response arrives, that stored callback is used to wake whoever was waiting.

The file also defines the message shapes: request, notification, response, and error. It then converts those internal shapes into real JSON-RPC 2.0 messages. There is special support for sending Codex events as MCP notifications, including optional `_meta` data such as the original request ID or thread ID when several conversations share one connection.

#### Function details

##### `OutgoingMessageSender::new`  (lines 34–40)

```
fn new(sender: mpsc::UnboundedSender<OutgoingMessage>) -> Self
```

**Purpose**: Creates a new outgoing message sender around an existing message queue. Server code uses this when it wants one shared object responsible for sending messages and tracking replies.

**Data flow**: It receives an unbounded sender, which is the sending half of an in-memory queue. It creates a request counter starting at zero and an empty map for pending request callbacks. The result is an `OutgoingMessageSender` ready to be shared by server code.

**Call relations**: This is the setup step for the rest of the file. Later calls such as `send_request`, `send_response`, `send_notification`, and `send_error` all depend on the queue and callback map created here.

*Call graph*: 3 external calls (new, new, new).


##### `OutgoingMessageSender::send_request`  (lines 42–62)

```
async fn send_request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> oneshot::Receiver<Value>
```

**Purpose**: Sends a request from the server to the client and gives the caller a way to wait for the client’s answer. This is used when the server needs the client to make a decision or provide data, not just receive a notification.

**Data flow**: It takes a method name and optional JSON parameters. It creates a fresh numeric request ID, creates a one-use response channel, stores the sending end of that response channel under the request ID, then sends an outgoing request into the message queue. It returns the receiving end, so the caller can wait for the later response value.

**Call relations**: This function starts a request-and-reply story. It sends an `OutgoingMessage::Request`; later, when another part of the server sees the client’s reply, `notify_client_response` uses the saved request ID to deliver the answer back to the original waiter.

*Call graph*: 5 external calls (fetch_add, send, Number, Request, channel).


##### `OutgoingMessageSender::notify_client_response`  (lines 64–80)

```
async fn notify_client_response(&self, id: RequestId, result: Value)
```

**Purpose**: Delivers a client response to the server task that originally sent the matching request. It is the other half of `send_request`.

**Data flow**: It receives a request ID and a JSON result from the client. It looks up that ID in the pending-callback map and removes it, because each response should be used only once. If a waiting callback exists, it sends the result through it; if not, or if the receiver has gone away, it writes a warning.

**Call relations**: This function completes the flow begun by `send_request`. It does not send a JSON-RPC message outward; instead, it connects an incoming client response back to the local Rust task that was waiting for it.

*Call graph*: 1 external calls (warn!).


##### `OutgoingMessageSender::send_response`  (lines 82–97)

```
async fn send_response(&self, id: RequestId, response: T)
```

**Purpose**: Sends a successful response to a request that came from the client. It lets server code reply with any serializable Rust value instead of manually building JSON.

**Data flow**: It receives the client’s request ID and a response value. It tries to turn that value into JSON. If that succeeds, it wraps the JSON as an outgoing response and sends it to the queue. If serialization fails, it sends a JSON-RPC internal error instead.

**Call relations**: This is the normal success path for answering client requests. When the response value cannot be turned into JSON, it hands off to `send_error` so the client still receives a clear failure message rather than silence.

*Call graph*: calls 1 internal fn (send_error); 5 external calls (internal_error, send, Response, format!, to_value).


##### `OutgoingMessageSender::send_event_as_notification`  (lines 102–125)

```
async fn send_event_as_notification(
        &self,
        event: &Event,
        meta: Option<OutgoingNotificationMeta>,
    )
```

**Purpose**: Sends a Codex protocol event to the client as an MCP notification. This is used for server-to-client updates that are not direct replies, such as session events.

**Data flow**: It receives a Codex event and optional notification metadata. It serializes the event into JSON. If metadata is present, it tries to wrap the metadata and event together so the JSON has an MCP-style `_meta` field plus the event fields. If that wrapping fails, it falls back to sending just the event JSON and logs a warning. It then sends a `codex/event` notification.

**Call relations**: This is a specialized helper for MCP event streaming. After shaping the event payload, it delegates the actual queue send to `send_notification`, keeping the low-level notification-sending path in one place.

*Call graph*: calls 1 internal fn (send_notification); 2 external calls (to_value, warn!).


##### `OutgoingMessageSender::send_notification`  (lines 127–130)

```
async fn send_notification(&self, notification: OutgoingNotification)
```

**Purpose**: Sends a one-way message to the client. A notification is like an announcement: it does not expect a response.

**Data flow**: It receives an `OutgoingNotification`, wraps it as an outgoing message, and pushes it into the message queue. It does not return a reply channel or record any callback.

**Call relations**: This is the shared sending path for notifications. `send_event_as_notification` calls it after building the special `codex/event` notification payload.

*Call graph*: called by 1 (send_event_as_notification); 2 external calls (send, Notification).


##### `OutgoingMessageSender::send_error`  (lines 132–135)

```
async fn send_error(&self, id: RequestId, error: ErrorData)
```

**Purpose**: Sends an error response for a specific client request. This tells the client that its request could not be completed and includes structured error details.

**Data flow**: It receives the request ID and an `ErrorData` value. It wraps those into an outgoing error message and sends it into the queue. It does not wait for any response.

**Call relations**: This is used directly when server code needs to report failure. `send_response` also calls it when a supposedly successful response cannot be converted into JSON.

*Call graph*: called by 1 (send_response); 2 external calls (send, Error).


##### `OutgoingJsonRpcMessage::from`  (lines 147–176)

```
fn from(val: OutgoingMessage) -> Self
```

**Purpose**: Converts this file’s internal outgoing message types into the JSON-RPC 2.0 message type expected by the MCP library. This is the final packaging step before serialization to the client.

**Data flow**: It receives an `OutgoingMessage`, checks which kind it is, and builds the matching JSON-RPC request, notification, response, or error. It preserves the request ID, method name, parameters, result, or error data as appropriate, and adds the JSON-RPC version marker.

**Call relations**: The sender methods create internal `OutgoingMessage` values because they are convenient for server code. This conversion turns those values into the standardized wire format used by the transport layer.

*Call graph*: 6 external calls (new, new, Error, Notification, Request, Response).


##### `tests::outgoing_request_serializes_as_jsonrpc_request`  (lines 248–267)

```
fn outgoing_request_serializes_as_jsonrpc_request()
```

**Purpose**: Checks that an outgoing request becomes a proper JSON-RPC request when serialized. This protects the exact wire shape clients expect.

**Data flow**: The test builds a request with an ID, method, and parameters, converts it into an outgoing JSON-RPC message, then serializes it to JSON. It verifies that the JSON has `jsonrpc`, `id`, `method`, and `params` fields and does not contain an unwanted wrapper field.

**Call relations**: This test exercises `OutgoingJsonRpcMessage::from` for request messages. It is run by the test runner to catch formatting regressions before they affect real clients.

*Call graph*: 6 external calls (Number, Request, assert!, assert_eq!, json!, to_value).


##### `tests::outgoing_notification_serializes_as_jsonrpc_notification`  (lines 270–287)

```
fn outgoing_notification_serializes_as_jsonrpc_notification()
```

**Purpose**: Checks that an outgoing notification becomes a proper JSON-RPC notification when serialized. This matters because notifications must look different from requests: they have no request ID.

**Data flow**: The test builds a notification, converts it into a JSON-RPC message, and serializes it to JSON. It verifies the version and method fields, confirms the parameters are represented as JSON null when absent, and checks that no unwanted wrapper field appears.

**Call relations**: This test exercises `OutgoingJsonRpcMessage::from` for notification messages. It helps ensure the MCP library’s custom notification type is flattened into the JSON-RPC shape clients actually read.

*Call graph*: 4 external calls (Notification, assert!, assert_eq!, to_value).


##### `tests::test_send_event_as_notification`  (lines 290–335)

```
async fn test_send_event_as_notification() -> Result<()>
```

**Purpose**: Checks that a Codex event without extra metadata is sent as a `codex/event` notification. This verifies the basic event-to-client path.

**Data flow**: The test creates an in-memory outgoing queue, builds an `OutgoingMessageSender`, creates a sample session-configured event, and asks the sender to send it as a notification. It then reads the queued message and confirms the method is `codex/event` and the parameters match the event JSON.

**Call relations**: This test calls `OutgoingMessageSender::new` and `send_event_as_notification`. Through that helper, it also exercises the notification-sending path used for real MCP event updates.

*Call graph*: calls 4 internal fn (new, read_only, new, new); 7 external calls (new, assert_eq!, test_path_buf, panic!, default, SessionConfigured, to_value).


##### `tests::test_send_event_as_notification_with_meta`  (lines 338–403)

```
async fn test_send_event_as_notification_with_meta() -> Result<()>
```

**Purpose**: Checks that event notifications can include MCP `_meta` data, specifically a request ID. This makes sure clients can connect an event back to the request that caused it.

**Data flow**: The test creates a sender and a sample event, then adds metadata containing a string request ID. After sending the event as a notification, it reads the queued notification and compares the JSON payload against the expected structure with `_meta.requestId` plus the event fields.

**Call relations**: This test focuses on the metadata-wrapping branch inside `send_event_as_notification`. It confirms that the helper still sends through the normal notification path while enriching the payload.

*Call graph*: calls 4 internal fn (new, read_only, new, new); 8 external calls (new, String, assert_eq!, test_path_buf, json!, panic!, default, SessionConfigured).


##### `tests::test_send_event_as_notification_with_meta_and_thread_id`  (lines 406–472)

```
async fn test_send_event_as_notification_with_meta_and_thread_id() -> Result<()>
```

**Purpose**: Checks that event notifications can include both a request ID and a thread ID in `_meta`. This is important when several conversation threads share one MCP connection.

**Data flow**: The test creates a sender, a thread ID, a sample event, and metadata containing both the request ID and thread ID. It sends the notification, receives the queued message, and verifies that the JSON contains the expected `_meta.requestId`, `_meta.threadId`, and event content.

**Call relations**: This test covers the richer metadata case in `send_event_as_notification`. It protects the behavior described by the file’s comments: thread information must travel with notifications when multiplexed threads are involved.

*Call graph*: calls 4 internal fn (new, read_only, new, new); 8 external calls (new, String, assert_eq!, test_path_buf, json!, panic!, default, SessionConfigured).


### `tui/src/app_server_approval_conversions.rs`

`domain_logic` · `approval request handling and display`

The terminal UI receives and sends approval information: for example, which extra network or file access was granted, and which files a proposed patch would change. Different parts of the system describe that information in slightly different forms. This file is the small adapter between those forms, like a plug converter between two devices.

One helper turns a core permission request into the app-server format used when reporting a granted permission. It preserves the network setting and converts the file-system permission section into the app-server version.

The other helper turns a list of file update records from the app-server protocol into the UI’s display model. The server says, in protocol terms, “this path was added, deleted, or updated, with this diff.” The UI wants a map from file path to a display-friendly `FileChange`, so it can show the right kind of change in the approval screen.

Without this file, approval screens would either need conversion code scattered through the UI, or the UI could send and display permission information in the wrong shape.

#### Function details

##### `granted_permission_profile_from_request`  (lines 17–26)

```
fn granted_permission_profile_from_request(
    value: CoreRequestPermissionProfile,
) -> GrantedPermissionProfile
```

**Purpose**: Turns a core permission request into the app-server format for a granted permission. This is used when the UI needs to submit or describe what permission was approved.

**Data flow**: It receives a core `RequestPermissionProfile`, which may contain network permission and file-system permission sections. It copies the network `enabled` value into the app-server network permission type, converts the file-system section into the app-server type, and returns a `GrantedPermissionProfile` ready for outbound use.

**Call relations**: When permission rules are being formatted for approval, `format_requested_permissions_rule` calls this helper so it can work with the granted-permission shape expected by the app-server protocol. The helper does only the translation step and hands the finished profile back to that larger approval-formatting flow.

*Call graph*: called by 1 (format_requested_permissions_rule).


##### `file_update_changes_to_display`  (lines 28–50)

```
fn file_update_changes_to_display(
    changes: Vec<FileUpdateChange>,
) -> HashMap<PathBuf, FileChange>
```

**Purpose**: Converts file-change records from the app-server protocol into the UI’s own file-change display model. This lets the approval UI show added, deleted, and updated files in the form it expects.

**Data flow**: It receives a list of `FileUpdateChange` values. For each one, it turns the path string into a `PathBuf`, looks at whether the patch adds, deletes, or updates the file, and builds the matching `FileChange`. It returns a `HashMap` keyed by file path, so the UI can look up each displayed file change by its path.

**Call relations**: This helper sits at the boundary between protocol data and UI display data. No specific caller is shown in the provided call graph, but its role is to be used when app-server patch information needs to be shown through the terminal UI’s diff display model.


##### `tests::absolute_path`  (lines 73–75)

```
fn absolute_path(path: &str) -> AbsolutePathBuf
```

**Purpose**: Creates an absolute path value for tests. It keeps the test cases short and makes sure test paths are valid absolute paths.

**Data flow**: It receives a path string, turns it into a normal `PathBuf`, then tries to convert that into an `AbsolutePathBuf`. If the string is not an absolute path, the test fails immediately; otherwise it returns the absolute path object.

**Call relations**: The permission-conversion tests call this helper when building sample read and write paths. It prepares realistic path values so the tests can focus on permission conversion rather than path setup.

*Call graph*: calls 1 internal fn (try_from); 1 external calls (from).


##### `tests::converts_file_update_changes_to_display`  (lines 78–92)

```
fn converts_file_update_changes_to_display()
```

**Purpose**: Checks that an app-server file-add record becomes the UI’s display form for an added file. This protects the file-change conversion from accidental shape changes.

**Data flow**: It builds one `FileUpdateChange` for adding `foo.txt` with simple diff text. It passes that list into `file_update_changes_to_display`, then compares the result with the expected map from `foo.txt` to `FileChange::Add` containing the same text.

**Call relations**: This test exercises `file_update_changes_to_display` directly. It confirms that the protocol-to-display adapter produces the exact structure the rest of the UI expects.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::converts_request_permissions_into_granted_permissions`  (lines 95–137)

```
fn converts_request_permissions_into_granted_permissions()
```

**Purpose**: Checks that requested network and file permissions become the expected granted-permission profile. It also verifies the file-system permission data is expressed in the canonical entry-list form.

**Data flow**: It builds a sample request with network enabled, one read path, and one write path. The request is first converted into the core permission type, then passed into `granted_permission_profile_from_request`. The test compares the output with the expected app-server granted profile, including read and write sandbox entries.

**Call relations**: This test exercises `granted_permission_profile_from_request` using a common permission request shape. It depends on the test path helper to create valid absolute paths, then verifies the conversion result with an equality check.

*Call graph*: 3 external calls (try_from, assert_eq!, vec!).


##### `tests::converts_request_permissions_into_canonical_granted_permissions`  (lines 140–175)

```
fn converts_request_permissions_into_canonical_granted_permissions()
```

**Purpose**: Checks that a request already using the canonical file-system entry format stays correct after conversion. This guards against losing special path permissions such as root access.

**Data flow**: It builds a request with no network section and one file-system entry for the special root path with write access. After converting that request into the core type, it passes it into `granted_permission_profile_from_request` and compares the result with the expected granted profile containing the same special entry.

**Call relations**: This test covers a second path through `granted_permission_profile_from_request`: permissions that are already written as sandbox entries. It complements the other permission test, which starts from older read/write path lists.

*Call graph*: 3 external calls (try_from, assert_eq!, vec!).
