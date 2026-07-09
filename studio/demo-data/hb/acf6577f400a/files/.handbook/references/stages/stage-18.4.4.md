# Tool and protocol contract schemas  `stage-18.4.4`

This stage is cross-cutting contract infrastructure: it sits between internal tool execution and every external surface where the model, UI, MCP clients, or protocol consumers need stable schemas and payloads. Its job is to make tool calls, tool specs, and tool-related events serializable, versionable, and consistent across the system.

At the core, tools/src/tool_payload.rs, tools/src/tool_call.rs, and core/src/tools/context.rs define the canonical shapes for invoking tools, carrying execution context, and turning handler outputs into protocol items, code-mode payloads, and telemetry previews; core/src/tools/code_mode/response_adapter.rs narrows code-mode output into the shared response format. tools/src/tool_spec.rs exports valid Responses API tool JSON, while core/src/function_tool.rs re-exports the shared FunctionCallError type.

Several files pin down concrete model-visible contracts: shell_spec.rs, request_user_input_spec.rs, get_context_remaining_spec.rs, ext/goal/src/spec.rs, and mcp-server/src/codex_tool_config.rs define exact tool names, arguments, schemas, and MCP-facing parameters. protocol/src/request_permissions.rs, request_user_input.rs, plan_tool.rs, and mcp_approval_meta.rs define the payloads and metadata exchanged during permission requests, follow-up questions, planning, and approval flows. hook_names.rs preserves stable hook identifiers, and the skills and web-search schema builders generate trimmed JSON Schema fragments that plug into these tool specifications.

## Files in this stage

### Core tool contracts
These files define the shared payload, invocation, specification, and error types that underpin model-visible tool calls across the system.

### `core/src/function_tool.rs`

`data_model` · `cross-cutting`

This file contains a single public re-export of `codex_tools::FunctionCallError`. Its purpose is not to implement tool invocation behavior, but to make the canonical error type for function/tool calls available from the core crate's API surface. That keeps consumers from needing to depend directly on `codex_tools` just to name or match the error type, and it lets codex-core present a cohesive interface around tool execution even when the underlying implementation is split across crates. Because the export is direct and unwrapped, all variants, trait impls, and formatting behavior are inherited exactly from the upstream definition.


### `tools/src/tool_payload.rs`

`data_model` · `tool invocation and logging`

This file is a small but important normalization layer for incoming tool invocation data. `ToolPayload` is an enum with three concrete shapes: `Function { arguments: String }` for ordinary function-call tools, `ToolSearch { arguments: SearchToolCallParams }` for search-style tools that carry structured query parameters, and `Custom { input: String }` for custom tool invocations. The only behavior here is `log_payload`, which extracts the most relevant human-readable text for telemetry without forcing unnecessary allocation. Function and custom payloads return borrowed views of their existing strings, while tool-search payloads clone `arguments.query` into an owned `Cow` because the query is nested inside a structured parameter object rather than already available as a standalone borrowed `&str`. This design keeps logging code generic over payload type while preserving the richer structured form for actual execution paths elsewhere in the system.

#### Function details

##### `ToolPayload::log_payload`  (lines 14–20)

```
fn log_payload(&self) -> Cow<'_, str>
```

**Purpose**: Extracts the text that should appear in logs for a tool invocation, regardless of payload variant. It chooses the raw argument string for function/custom calls and the search query for tool-search calls.

**Data flow**: It borrows `self` and pattern matches on the enum. For `Function { arguments }` and `Custom { input }`, it returns `Cow::Borrowed` pointing at the existing string; for `ToolSearch { arguments }`, it clones `arguments.query` and returns `Cow::Owned`. It does not mutate the payload.

**Call relations**: Logging and telemetry code call this to obtain a uniform textual representation of invocation input without needing to understand each payload shape.

*Call graph*: 2 external calls (Borrowed, Owned).


### `tools/src/tool_call.rs`

`data_model` · `tool invocation setup and execution`

This module packages all state the host exposes when invoking an extension tool. `ConversationHistory` is a lightweight immutable wrapper around `Arc<[ResponseItem]>`, allowing a snapshot of prior response items to be cloned cheaply and exposed as a slice. `ExtensionTurnItem` enumerates the visible item types an extension may publish back into the host lifecycle—currently `WebSearch` and `ImageGeneration`—and the `TurnItemEmitter` trait defines asynchronous `emit_started` and `emit_completed` hooks for those lifecycle events. `ToolEnvironment` summarizes executor-scoped runtime context: a stable environment id, working directory, filesystem implementation, and sandbox context. `NoopTurnItemEmitter` is the fallback implementation for callers that do not support visible item emission; both trait methods immediately return a pinned ready future that resolves to `()`. The central `ToolCall` struct bundles identifiers (`turn_id`, `call_id`), the selected `ToolName`, model name, truncation policy, conversation history, emitter, available environments, and the raw `ToolPayload`. A custom `Debug` implementation intentionally avoids printing the emitter internals and instead reports only `environment_count`, making logs informative without exposing host implementation details. `ToolCall::function_arguments` enforces a key payload invariant: only `ToolPayload::Function` can be treated as function-call arguments; any other payload variant becomes a fatal `FunctionCallError` that names the incompatible tool.

#### Function details

##### `ConversationHistory::new`  (lines 22–26)

```
fn new(items: Vec<ResponseItem>) -> Self
```

**Purpose**: Creates an immutable, cheaply clonable conversation-history snapshot from an owned vector of response items. It converts the vector into an `Arc`-backed slice for shared use across tool-call clones.

**Data flow**: Consumes `items: Vec<ResponseItem>`, converts it with `items.into()` into `Arc<[ResponseItem]>`, stores that in a new `ConversationHistory`, and returns the wrapper. No external state is modified.

**Call relations**: This constructor is used when assembling extension-facing call context; the call graph shows it feeding `to_extension_call`. It is the entry point for turning mutable history collections into the immutable snapshot carried by `ToolCall`.

*Call graph*: called by 1 (to_extension_call).


##### `ConversationHistory::items`  (lines 28–30)

```
fn items(&self) -> &[ResponseItem]
```

**Purpose**: Exposes the stored conversation-history snapshot as a borrowed slice. It provides read-only access without cloning or reallocating.

**Data flow**: Takes `&self` and returns `&[ResponseItem]` by borrowing the internal `Arc<[ResponseItem]>`. It performs no transformation and writes no state.

**Call relations**: This accessor is used by consumers of `ConversationHistory` that need to inspect prior response items during tool execution. It is a simple read-only view over state established by `ConversationHistory::new`.


##### `NoopTurnItemEmitter::emit_started`  (lines 73–75)

```
fn emit_started(&'a self, _item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Implements the start-of-item emission hook as a no-op for hosts that do not surface visible turn items. The returned future resolves immediately.

**Data flow**: Accepts `&self` and an `ExtensionTurnItem`, ignores the item, wraps `std::future::ready(())` in `Box::pin`, and returns the resulting `TurnItemEmissionFuture<'a>`. It neither reads nor mutates any persistent state.

**Call relations**: This method is invoked through the `TurnItemEmitter` trait when a caller supplied `NoopTurnItemEmitter` instead of a real host emitter. Its role is to satisfy the async emission contract without affecting host lifecycle state.

*Call graph*: 2 external calls (pin, ready).


##### `NoopTurnItemEmitter::emit_completed`  (lines 77–79)

```
fn emit_completed(&'a self, _item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Implements the completed-item emission hook as a no-op, mirroring `emit_started`. It lets extension code await completion emission uniformly even when the host does nothing.

**Data flow**: Takes `&self` and an `ExtensionTurnItem`, discards the item, creates a pinned ready future yielding `()`, and returns it as `TurnItemEmissionFuture<'a>`. No state is read or written beyond constructing the future.

**Call relations**: Like `emit_started`, this is reached via dynamic dispatch on `TurnItemEmitter` when no visible item pipeline is available. It preserves the trait’s control-flow shape while intentionally delegating to no host behavior.

*Call graph*: 2 external calls (pin, ready).


##### `ToolCall::fmt`  (lines 96–108)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Formats `ToolCall` for debugging while redacting the concrete emitter implementation and summarizing environments by count. This keeps logs useful without exposing host internals or dumping potentially large environment details.

**Data flow**: Reads fields from `self` and feeds them into `f.debug_struct("ToolCall")`, including `turn_id`, `call_id`, `tool_name`, `model`, `truncation_policy`, `conversation_history`, a literal placeholder for `turn_item_emitter`, `self.environments.len()` as `environment_count`, and `payload`. Returns the formatter result `std::fmt::Result`.

**Call relations**: This implementation is used implicitly whenever a `ToolCall` is formatted with `{:?}` in logs or diagnostics. It does not participate in tool execution logic directly but shapes observability around `ToolCall` instances.

*Call graph*: 1 external calls (debug_struct).


##### `ToolCall::function_arguments`  (lines 112–120)

```
fn function_arguments(&self) -> Result<&str, FunctionCallError>
```

**Purpose**: Extracts the raw argument string when the tool call carries a function payload and rejects all other payload kinds as fatal misuse. It is the type-safe gate between generic tool-call envelopes and function-specific execution code.

**Data flow**: Borrows `self.payload` and pattern-matches it. If it is `ToolPayload::Function { arguments }`, returns `Ok(arguments)` as `&str`; otherwise constructs `FunctionCallError::Fatal` with a message naming `self.tool_name` and returns `Err(...)`. It does not mutate `self`.

**Call relations**: Function-oriented tool executors call this helper before parsing arguments. Its error path provides an early, explicit failure when some other payload variant reaches code that only understands function calls.

*Call graph*: 2 external calls (format!, Fatal).


### `tools/src/tool_spec.rs`

`io_transport` · `request construction`

This file centers on the `ToolSpec` enum, a serde-tagged representation of every tool shape this crate can send to the Responses API. Variants cover ordinary function tools (`ResponsesApiTool`), grouped namespace tools (`ResponsesApiNamespace`), tool search, image generation, web search, and a freeform custom tool (`FreeformTool`). The enum uses `#[serde(tag = "type")]` plus per-variant renames so serialization produces the exact top-level `type` discriminator required by the API. Several optional web-search fields are marked `skip_serializing_if = "Option::is_none"`, which keeps absent configuration out of the payload instead of serializing explicit nulls.

Beyond the enum, the file provides small conversion layers. `From<LoadableToolSpec>` narrows the loadable subset into the runtime `ToolSpec` enum, preserving only function and namespace variants because those are the only loadable forms. `ResponsesApiWebSearchFilters` and `ResponsesApiWebSearchUserLocation` mirror protocol config structs but are tailored for Responses API serialization, including renaming the location `type` field via raw identifier syntax (`r#type`).

The helper `create_tools_json_for_responses_api` serializes a slice of `ToolSpec` values into `Vec<serde_json::Value>`, failing fast on the first serde error. A subtle but important design choice is `ToolSpec::name()`: even non-user-named variants like `ToolSearch`, `ImageGeneration`, and `WebSearch` return stable synthetic names, allowing higher-level request-building code to treat all tool variants uniformly when it needs an identifier.

#### Function details

##### `ToolSpec::name`  (lines 54–63)

```
fn name(&self) -> &str
```

**Purpose**: Returns the canonical name string associated with a tool spec, whether that name comes from embedded tool metadata or from a fixed built-in variant label.

**Data flow**: Reads `self` and pattern-matches each `ToolSpec` variant. For `Function`, `Namespace`, and `Freeform`, it borrows the inner struct's `name` field as `&str`; for `ToolSearch`, `ImageGeneration`, and `WebSearch`, it returns fixed string literals. It does not mutate state.

**Call relations**: This is used by higher-level request assembly such as `spec_for_model_request` when code needs a uniform identifier for heterogeneous tool variants. It delegates only to enum destructuring and field access, intentionally avoiding serialization just to discover a name.

*Call graph*: called by 1 (spec_for_model_request).


##### `ToolSpec::from`  (lines 67–72)

```
fn from(value: LoadableToolSpec) -> Self
```

**Purpose**: Converts a `LoadableToolSpec` into the broader `ToolSpec` enum without changing the underlying payload.

**Data flow**: Consumes a `LoadableToolSpec` input, matches on whether it is `Function` or `Namespace`, and wraps the contained value in the corresponding `ToolSpec` variant. It returns the new enum value and performs no side effects.

**Call relations**: This conversion is part of the boundary between configuration/loading code and runtime tool emission. It is invoked wherever a loadable tool inventory must be promoted into the serializable Responses API representation, and it delegates only to enum construction.

*Call graph*: 2 external calls (Function, Namespace).


##### `create_tools_json_for_responses_api`  (lines 78–89)

```
fn create_tools_json_for_responses_api(
    tools: &[ToolSpec],
) -> Result<Vec<Value>, serde_json::Error>
```

**Purpose**: Serializes a list of tool specs into raw JSON values suitable for inclusion in a Responses API request body.

**Data flow**: Takes a borrowed slice of `ToolSpec`, allocates an output `Vec<Value>`, then iterates in order and calls `serde_json::to_value` on each tool. Successful serializations are pushed into the vector; the first serialization failure aborts the loop and returns `Err(serde_json::Error)`. On success it returns the accumulated JSON array elements.

**Call relations**: This helper is the final wire-shaping step before request submission. Callers provide already-constructed `ToolSpec` values; this function delegates serialization to serde and preserves input ordering so the outbound tool list matches the caller's sequence.

*Call graph*: 2 external calls (new, to_value).


##### `ResponsesApiWebSearchFilters::from`  (lines 98–102)

```
fn from(filters: ConfigWebSearchFilters) -> Self
```

**Purpose**: Maps config-layer web-search domain filters into the Responses API filter struct.

**Data flow**: Consumes `ConfigWebSearchFilters`, copies its `allowed_domains: Option<Vec<String>>` field directly into a new `ResponsesApiWebSearchFilters`, and returns that struct. No validation or normalization is applied.

**Call relations**: This conversion sits between config parsing and tool-spec assembly for web search. It is used when a configured filter set needs to be embedded into `ToolSpec::WebSearch` without exposing config-specific types at the serialization boundary.


##### `ResponsesApiWebSearchUserLocation::from`  (lines 120–128)

```
fn from(user_location: ConfigWebSearchUserLocation) -> Self
```

**Purpose**: Transforms configured user-location metadata into the Responses API's serialized web-search location shape.

**Data flow**: Consumes `ConfigWebSearchUserLocation`, copies over `type`, `country`, `region`, `city`, and `timezone` into a new `ResponsesApiWebSearchUserLocation`, and returns it. The raw-identifier field `r#type` preserves the JSON key name `type` during serialization.

**Call relations**: This is the companion conversion for location-aware web search setup. It is used when request-building code needs to embed location hints into `ToolSpec::WebSearch` while keeping config-layer structs separate from wire-format structs.


### `core/src/tools/context.rs`

`domain_logic` · `cross-cutting`

This file is the core data-shaping layer for tool execution. It defines `ToolCallSource`, `ToolInvocation`, and several concrete `ToolOutput` implementations: `McpToolOutput`, `ToolSearchOutput`, `FunctionToolOutput`, `ApplyPatchToolOutput`, `AbortedToolOutput`, and `ExecCommandToolOutput`. Each implementation decides how a tool result is previewed for logs, whether it counts as success, how it becomes a `ResponseInputItem`, and in some cases what JSON should be exposed to code mode or post-tool-use hooks.

A recurring pattern is conversion into `FunctionCallOutputPayload`. `function_tool_response` centralizes the protocol distinction between plain function outputs and custom tool outputs, and also collapses a single text content item into `FunctionCallOutputBody::Text` instead of `ContentItems`. `McpToolOutput::response_payload` adds a wall-time header, sanitizes unsupported `ImageDetail::Original`, preserves content items when possible, and truncates the payload with `truncate_function_output_payload` using a slight overhead buffer. `ExecCommandToolOutput` separately computes model-facing truncation budgets, formats structured execution summaries, and emits richer JSON for code mode.

The file also includes `boxed_tool_output`, a convenience for erasing concrete output types behind `Box<dyn ToolOutput>`, and `telemetry_preview`, which truncates by both byte count and line count while preserving UTF-8 boundaries and appending a standard truncation notice. Tests for these behaviors live in `context_tests.rs`, referenced via `#[path = "context_tests.rs"]`.

#### Function details

##### `boxed_tool_output`  (lines 31–36)

```
fn boxed_tool_output(output: T) -> Box<dyn ToolOutput>
```

**Purpose**: Boxes any concrete `ToolOutput` implementation into a trait object for uniform return from handlers. It is the standard erasure helper used across tool executors.

**Data flow**: Takes `output: T` where `T: ToolOutput + 'static` → allocates `Box::new(output)` → returns `Box<dyn ToolOutput>`. It reads no state and performs only heap allocation.

**Call relations**: Many handler `handle_call` implementations invoke this right before returning, including code-mode and other tool handlers. It delegates only to `Box::new`, letting callers avoid repeating trait-object boilerplate.

*Call graph*: called by 19 (handle_call, handle_call, handle, handle_call, handle_call, handle_call, handle_call, handle_call, handle, handle_call (+9 more)); 1 external calls (new).


##### `McpToolOutput::log_preview`  (lines 75–82)

```
fn log_preview(&self) -> String
```

**Purpose**: Builds a telemetry-safe preview string for an MCP tool result. It prefers the same response payload text that would be sent to the model, falling back to serialized raw MCP content if needed.

**Data flow**: Reads `self.result`, `self.wall_time`, truncation settings, and image-detail support indirectly through `response_payload()` → extracts `payload.body.to_text()` or serializes `self.result.content` to JSON on failure → passes the resulting string through `telemetry_preview` → returns the preview string.

**Call relations**: Logging code calls this through the `ToolOutput` trait. It delegates payload shaping to `McpToolOutput::response_payload` so previews match model-facing formatting as closely as possible.

*Call graph*: calls 2 internal fn (response_payload, telemetry_preview).


##### `McpToolOutput::success_for_logging`  (lines 84–86)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports whether the MCP call should be logged as successful. It mirrors the MCP result's own success semantics.

**Data flow**: Reads `self.result` → calls `self.result.success()` → returns `bool`.

**Call relations**: Used by generic tool logging via the `ToolOutput` trait. It delegates success determination to the MCP result type rather than reinterpreting fields locally.

*Call graph*: 1 external calls (success).


##### `McpToolOutput::to_response_item`  (lines 88–93)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts an MCP result into a standard function-call output response item. It packages the already formatted payload under the provided call id.

**Data flow**: Takes `call_id: &str` and ignores `_payload` → calls `self.response_payload()` → returns `ResponseInputItem::FunctionCallOutput { call_id: call_id.to_string(), output: payload }`.

**Call relations**: The conversation/history pipeline invokes this through `ToolOutput`. It delegates all body construction, wall-time header insertion, sanitization, and truncation to `response_payload`.

*Call graph*: calls 1 internal fn (response_payload).


##### `McpToolOutput::code_mode_result`  (lines 95–99)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Serializes the raw `CallToolResult` for code-mode consumers without applying the model-facing wall-time header or truncation. This preserves full structured MCP data for runtime use.

**Data flow**: Reads `self.result` → attempts `serde_json::to_value(&self.result)` → returns the JSON value, or a fallback `JsonValue::String` containing the serialization error.

**Call relations**: Code-mode paths call this through the `ToolOutput` trait when they need machine-readable tool results. It intentionally bypasses `response_payload`, unlike model-facing response generation.

*Call graph*: 1 external calls (to_value).


##### `McpToolOutput::post_tool_use_input`  (lines 101–103)

```
fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Exposes the original MCP tool input for post-tool-use hooks. This lets hook logic inspect what was sent to the MCP tool.

**Data flow**: Reads `self.tool_input` → clones it → wraps it in `Some(JsonValue)` and returns it.

**Call relations**: Post-tool-use hook machinery calls this through `ToolOutput`. It does not delegate further because the stored input is already in JSON form.

*Call graph*: 1 external calls (clone).


##### `McpToolOutput::post_tool_use_response`  (lines 105–107)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Exposes the raw MCP result as JSON for post-tool-use hooks. It gives hooks access to the unformatted result object rather than the model-facing payload text.

**Data flow**: Reads `self.result` → attempts `serde_json::to_value(&self.result)` → returns `Some(json)` on success or `None` on serialization failure.

**Call relations**: Called by post-tool-use hook plumbing via `ToolOutput`. Like `code_mode_result`, it bypasses `response_payload` to preserve raw structure.

*Call graph*: 1 external calls (to_value).


##### `McpToolOutput::response_payload`  (lines 111–140)

```
fn response_payload(&self) -> FunctionCallOutputPayload
```

**Purpose**: Builds the model-facing `FunctionCallOutputPayload` for an MCP result, adding wall-time metadata, sanitizing image detail, and truncating oversized payloads. It is the canonical formatter for MCP outputs in conversation history.

**Data flow**: Reads `self.result`, `self.wall_time`, `self.original_image_detail_supported`, and `self.truncation_policy` → starts from `self.result.as_function_call_output_payload()` → if content items exist, mutates them via `sanitize_original_image_detail(...)` → computes a header `Wall time: ... seconds\nOutput:` → prepends or inserts that header into either `FunctionCallOutputBody::Text` or `ContentItems` → passes the payload through `truncate_function_output_payload(&payload, self.truncation_policy * 1.2)` → returns the truncated payload.

**Call relations**: This helper is called by both `McpToolOutput::log_preview` and `McpToolOutput::to_response_item`. It delegates image normalization and truncation to shared utilities so MCP formatting stays aligned with broader function-output handling.

*Call graph*: called by 2 (log_preview, to_response_item); 5 external calls (as_secs_f64, truncate_function_output_payload, sanitize_original_image_detail, format!, as_function_call_output_payload).


##### `ToolSearchOutput::log_preview`  (lines 149–160)

```
fn log_preview(&self) -> String
```

**Purpose**: Produces a telemetry preview for tool-search results by serializing the discovered tool specs to JSON. It gives logs a compact representation of what tools were returned.

**Data flow**: Reads `self.tools` → serializes each `LoadableToolSpec` to `serde_json::Value`, substituting an error string value on failure → wraps them in `JsonValue::Array` → converts to string → truncates with `telemetry_preview` → returns the preview.

**Call relations**: Generic logging calls this through `ToolOutput`. It does not share a response-payload helper because tool-search outputs use a distinct protocol item shape.

*Call graph*: calls 1 internal fn (telemetry_preview); 1 external calls (Array).


##### `ToolSearchOutput::success_for_logging`  (lines 162–164)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks tool-search execution as successful for logging purposes. Search returning zero tools is still considered a successful operation.

**Data flow**: Takes `&self` → returns `true` unconditionally.

**Call relations**: Used by generic logging through the `ToolOutput` trait. It has no delegates because success is fixed by design.


##### `ToolSearchOutput::to_response_item`  (lines 166–181)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts discovered tool specs into a `ToolSearchOutput` protocol item. It serializes each tool and marks the search as completed on the client side.

**Data flow**: Takes `call_id: &str` and ignores `_payload` → reads `self.tools`, serializes each to JSON with error-string fallback → returns `ResponseInputItem::ToolSearchOutput { call_id, status: "completed", execution: "client", tools }`.

**Call relations**: Called by the response pipeline via `ToolOutput`. It directly constructs the protocol item because tool-search outputs are not function-call outputs.


##### `FunctionToolOutput::from_text`  (lines 191–197)

```
fn from_text(text: String, success: Option<bool>) -> Self
```

**Purpose**: Constructs a function-tool output from a single plain-text body. It is the convenience constructor used by many handlers that only return text.

**Data flow**: Takes `text: String` and `success: Option<bool>` → creates `body = vec![FunctionCallOutputContentItem::InputText { text }]` and `post_tool_use_response = None` → returns `FunctionToolOutput`.

**Call relations**: Many handlers and tests call this when they have a simple textual result. It feeds later methods like `to_response_item` and `log_preview` without additional transformation.

*Call graph*: called by 25 (custom_tool_calls_should_roundtrip_as_custom_outputs, function_payloads_remain_function_outputs, handle, handle, intercept_apply_patch, to_response_item, handle_call, serialize_function_output, tool_output_response_item, handle_message_string_tool (+15 more)); 1 external calls (vec!).


##### `FunctionToolOutput::from_content`  (lines 199–208)

```
fn from_content(
        content: Vec<FunctionCallOutputContentItem>,
        success: Option<bool>,
    ) -> Self
```

**Purpose**: Constructs a function-tool output from an explicit list of content items, preserving mixed text/image bodies. It is used when callers already have structured content.

**Data flow**: Takes `content: Vec<FunctionCallOutputContentItem>` and `success: Option<bool>` → stores them as `body`, sets `post_tool_use_response = None` → returns `FunctionToolOutput`.

**Call relations**: Called by code-mode response handling and tests that need content-item fidelity. It avoids collapsing structured output into plain text too early.

*Call graph*: called by 4 (handle_runtime_response, custom_tool_calls_can_derive_text_from_content_items, log_preview_uses_content_items_when_plain_text_is_missing, handle_call).


##### `FunctionToolOutput::into_text`  (lines 210–212)

```
fn into_text(self) -> String
```

**Purpose**: Converts a structured function-tool output into plain text by concatenating text-bearing content items. It is a lossy convenience for consumers that only need textual output.

**Data flow**: Consumes `self` → reads `self.body` → calls `function_call_output_content_items_to_text(&self.body)` → returns the resulting string or `""` if conversion fails.

**Call relations**: Used by callers that need a text-only view of a function output. It delegates the actual content-item flattening rules to the protocol helper.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text).


##### `FunctionToolOutput::log_preview`  (lines 216–220)

```
fn log_preview(&self) -> String
```

**Purpose**: Builds a telemetry preview from the textual rendering of the function output body. It supports both plain-text and structured content-item outputs.

**Data flow**: Reads `self.body` → converts content items to text with `function_call_output_content_items_to_text` using empty string fallback → truncates with `telemetry_preview` → returns the preview string.

**Call relations**: Generic logging invokes this through `ToolOutput`. It shares the same content-to-text helper used by `into_text` so previews reflect the visible textual portion of structured outputs.

*Call graph*: calls 2 internal fn (telemetry_preview, function_call_output_content_items_to_text).


##### `FunctionToolOutput::success_for_logging`  (lines 222–224)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports whether the function output should be logged as successful. Missing success metadata defaults to success.

**Data flow**: Reads `self.success` → returns `self.success.unwrap_or(true)`.

**Call relations**: Called by generic logging via `ToolOutput`. It has no delegates because the policy is a simple local default.


##### `FunctionToolOutput::to_response_item`  (lines 226–228)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts a function-tool output into either a normal function-call output or a custom-tool output, depending on the original payload kind. It preserves the stored body and success flag.

**Data flow**: Takes `call_id: &str` and `payload: &ToolPayload` → clones `self.body` and reads `self.success` → passes them to `function_tool_response` → returns the resulting `ResponseInputItem`.

**Call relations**: The response pipeline calls this through `ToolOutput`. It delegates the protocol branching and body-shape normalization to `function_tool_response`.

*Call graph*: calls 1 internal fn (function_tool_response); called by 1 (to_response_item).


##### `FunctionToolOutput::post_tool_use_response`  (lines 230–232)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Returns any explicitly stored post-tool-use response JSON for this function output. Most instances leave this unset.

**Data flow**: Reads `self.post_tool_use_response` → clones and returns the `Option<JsonValue>`.

**Call relations**: Post-tool-use hook plumbing calls this through `ToolOutput`. It does not compute anything dynamically; it simply exposes stored state.


##### `ApplyPatchToolOutput::from_text`  (lines 240–242)

```
fn from_text(text: String) -> Self
```

**Purpose**: Constructs an apply-patch output from plain text. It is a minimal convenience wrapper around the struct field.

**Data flow**: Takes `text: String` → returns `ApplyPatchToolOutput { text }`.

**Call relations**: Called by apply-patch handling code and tests. It prepares the value for later `ToolOutput` trait methods.

*Call graph*: called by 2 (handle_call, post_tool_use_payload_uses_patch_input_and_tool_output).


##### `ApplyPatchToolOutput::log_preview`  (lines 246–248)

```
fn log_preview(&self) -> String
```

**Purpose**: Produces a telemetry preview of the patch tool's text output. It uses the shared truncation helper.

**Data flow**: Reads `self.text` → passes it to `telemetry_preview` → returns the preview string.

**Call relations**: Generic logging invokes this through `ToolOutput`. It delegates truncation behavior to the shared preview helper.

*Call graph*: calls 1 internal fn (telemetry_preview).


##### `ApplyPatchToolOutput::success_for_logging`  (lines 250–252)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks apply-patch outputs as successful for logging. The output type itself represents a completed patch response.

**Data flow**: Takes `&self` → returns `true`.

**Call relations**: Used by generic logging through `ToolOutput`. It has no delegates.


##### `ApplyPatchToolOutput::to_response_item`  (lines 254–263)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Wraps patch output text as a successful function/custom tool response item. It always emits a single text content item.

**Data flow**: Takes `call_id: &str` and `payload: &ToolPayload` → clones `self.text` into `vec![InputText { text }]` → calls `function_tool_response(..., Some(true))` → returns the resulting `ResponseInputItem`.

**Call relations**: The response pipeline calls this through `ToolOutput`. It delegates payload-kind branching and text/body normalization to `function_tool_response`.

*Call graph*: calls 1 internal fn (function_tool_response); 1 external calls (vec!).


##### `ApplyPatchToolOutput::post_tool_use_response`  (lines 265–267)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Exposes the patch output text as a JSON string for post-tool-use hooks. This gives hooks a simple textual summary of the patch result.

**Data flow**: Reads `self.text` → clones it into `JsonValue::String` → returns `Some(...)`.

**Call relations**: Called by post-tool-use hook plumbing via `ToolOutput`. It does not delegate further.

*Call graph*: 1 external calls (String).


##### `ApplyPatchToolOutput::code_mode_result`  (lines 269–271)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Returns an empty JSON object for code-mode consumers of apply-patch results. Code mode does not receive the textual patch summary here.

**Data flow**: Takes `_payload` and ignores it → constructs `JsonValue::Object(serde_json::Map::new())` → returns it.

**Call relations**: Code-mode paths call this through `ToolOutput`. It intentionally emits a minimal machine-readable result instead of the human-facing text.

*Call graph*: 2 external calls (Object, new).


##### `AbortedToolOutput::log_preview`  (lines 279–281)

```
fn log_preview(&self) -> String
```

**Purpose**: Produces a telemetry preview of an aborted tool's message. It uses the shared truncation logic.

**Data flow**: Reads `self.message` → passes it to `telemetry_preview` → returns the preview string.

**Call relations**: Generic logging invokes this through `ToolOutput`. It delegates truncation to the shared helper.

*Call graph*: calls 1 internal fn (telemetry_preview).


##### `AbortedToolOutput::success_for_logging`  (lines 283–285)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks aborted tool outputs as unsuccessful for logging. This distinguishes cancellations/abortions from normal completions.

**Data flow**: Takes `&self` → returns `false`.

**Call relations**: Used by generic logging via `ToolOutput`. It has no delegates.


##### `AbortedToolOutput::to_response_item`  (lines 287–304)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Converts an aborted tool result into the appropriate protocol item for the original payload kind. Tool-search aborts become an empty completed search result; other aborts become text function/custom outputs with unknown success.

**Data flow**: Takes `call_id: &str` and `payload: &ToolPayload` → if payload is `ToolPayload::ToolSearch`, returns `ResponseInputItem::ToolSearchOutput` with empty `tools`; otherwise clones `self.message` into a single `InputText` item and calls `function_tool_response(..., None)` → returns the resulting item.

**Call relations**: The response pipeline calls this through `ToolOutput`. It delegates non-search formatting to `function_tool_response` while handling tool-search as a special protocol shape.

*Call graph*: calls 1 internal fn (function_tool_response); 2 external calls (new, vec!).


##### `ExecCommandToolOutput::log_preview`  (lines 323–325)

```
fn log_preview(&self) -> String
```

**Purpose**: Builds a telemetry preview from the formatted exec-command response text. It reflects the same summary shown to the model.

**Data flow**: Reads execution fields indirectly through `response_text()` → truncates that text with `telemetry_preview` → returns the preview string.

**Call relations**: Generic logging invokes this through `ToolOutput`. It delegates formatting to `response_text` so logs and model output stay aligned.

*Call graph*: calls 2 internal fn (response_text, telemetry_preview).


##### `ExecCommandToolOutput::success_for_logging`  (lines 327–329)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks exec-command outputs as successful from the transport/logging perspective. Exit-code failure is represented in the body rather than this flag.

**Data flow**: Takes `&self` → returns `true`.

**Call relations**: Used by generic logging via `ToolOutput`. It has no delegates.


##### `ExecCommandToolOutput::to_response_item`  (lines 331–340)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Wraps the formatted exec-command summary as a successful function/custom tool response item. It always emits a single text body.

**Data flow**: Takes `call_id: &str` and `payload: &ToolPayload` → computes `self.response_text()` → wraps it in `vec![InputText { text }]` → calls `function_tool_response(..., Some(true))` → returns the protocol item.

**Call relations**: The response pipeline calls this through `ToolOutput`. It delegates body-kind branching to `function_tool_response` and summary formatting to `response_text`.

*Call graph*: calls 1 internal fn (function_tool_response); 1 external calls (vec!).


##### `ExecCommandToolOutput::post_tool_use_id`  (lines 342–348)

```
fn post_tool_use_id(&self, call_id: &str) -> String
```

**Purpose**: Chooses the identifier that post-tool-use hooks should associate with this exec result. It prefers the event call id when present.

**Data flow**: Takes `call_id: &str` → reads `self.event_call_id` → returns `call_id.to_string()` if `event_call_id` is empty, otherwise returns `self.event_call_id.clone()`.

**Call relations**: Post-tool-use hook plumbing calls this through `ToolOutput`. It does not delegate further because the selection logic is local.


##### `ExecCommandToolOutput::post_tool_use_input`  (lines 350–354)

```
fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Exposes the hook command, if any, as JSON input for post-tool-use hooks. This is only relevant when the exec output corresponds to a hook command invocation.

**Data flow**: Reads `self.hook_command` → if present, maps it to `serde_json::json!({ "command": command })` → returns `Option<JsonValue>`.

**Call relations**: Called by post-tool-use hook plumbing via `ToolOutput`. It has no internal delegates beyond JSON construction.


##### `ExecCommandToolOutput::post_tool_use_response`  (lines 356–364)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Returns a truncated textual exec output for post-tool-use hooks only when the result came from a hook command and is not tied to a running process id. This avoids exposing streaming/live-process state through the hook response channel.

**Data flow**: Reads `self.process_id`, `self.hook_command`, and output fields → returns `None` immediately if `process_id.is_some()` or `hook_command.is_none()` → otherwise computes `self.model_output_max_tokens()`, truncates output with `self.truncated_output(...)`, wraps it in `JsonValue::String`, and returns `Some(...)`.

**Call relations**: Post-tool-use hook plumbing calls this through `ToolOutput`. It delegates token-budget calculation to `model_output_max_tokens` and text truncation to `truncated_output`.

*Call graph*: calls 2 internal fn (model_output_max_tokens, truncated_output); 1 external calls (String).


##### `ExecCommandToolOutput::code_mode_result`  (lines 366–396)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Serializes exec-command output into a structured JSON object for code-mode consumers, including timing, identifiers, exit status, and either raw or token-truncated output. It preserves more machine-readable metadata than the model-facing text summary.

**Data flow**: Reads `chunk_id`, `wall_time`, `exit_code`, `process_id`, `original_token_count`, `max_output_tokens`, and `raw_output` → builds an internal serializable `UnifiedExecCodeModeResult` with optional fields omitted when absent/empty → chooses `output` as `self.truncated_output(max_tokens)` when `max_output_tokens` is set, otherwise full `String::from_utf8_lossy(&self.raw_output)` → serializes with `serde_json::to_value`, falling back to an error string JSON value on failure.

**Call relations**: Code-mode paths call this through `ToolOutput`. It delegates truncation to `truncated_output` when a code-mode token cap is configured.

*Call graph*: calls 1 internal fn (truncated_output); 3 external calls (as_secs_f64, from_utf8_lossy, to_value).


##### `ExecCommandToolOutput::model_output_max_tokens`  (lines 400–402)

```
fn model_output_max_tokens(&self) -> usize
```

**Purpose**: Computes the effective token budget for model-facing exec output by combining the optional per-call limit with the truncation policy's own budget. It ensures the final budget never exceeds the policy cap.

**Data flow**: Reads `self.max_output_tokens` and `self.truncation_policy` → calls `resolve_max_tokens(self.max_output_tokens)` → takes `.min(self.truncation_policy.token_budget())` → returns `usize`.

**Call relations**: This helper is called by `post_tool_use_response` and `response_text`. It centralizes budget calculation so all model-facing truncation paths use the same limit.

*Call graph*: calls 2 internal fn (resolve_max_tokens, token_budget); called by 2 (post_tool_use_response, response_text).


##### `ExecCommandToolOutput::truncated_output`  (lines 404–407)

```
fn truncated_output(&self, max_tokens: usize) -> String
```

**Purpose**: Converts raw exec bytes to UTF-8-lossy text and truncates them according to a token budget. It is the shared low-level truncation routine for exec outputs.

**Data flow**: Takes `max_tokens: usize` → reads `self.raw_output` → converts bytes with `String::from_utf8_lossy(...).to_string()` → truncates via `formatted_truncate_text(&text, TruncationPolicy::Tokens(max_tokens))` → returns the truncated string.

**Call relations**: Called by `code_mode_result`, `post_tool_use_response`, and `response_text`. It delegates actual truncation formatting to the shared output-truncation utility.

*Call graph*: called by 3 (code_mode_result, post_tool_use_response, response_text); 3 external calls (from_utf8_lossy, formatted_truncate_text, Tokens).


##### `ExecCommandToolOutput::response_text`  (lines 409–435)

```
fn response_text(&self) -> String
```

**Purpose**: Formats a human-readable exec summary containing chunk id, wall time, exit/process metadata, original token count, and truncated output. This is the canonical model-facing text representation of exec results.

**Data flow**: Reads `chunk_id`, `wall_time`, `exit_code`, `process_id`, `original_token_count`, and output bytes → builds a `Vec<String>` of sections conditionally including non-empty metadata → appends `Output:` and `self.truncated_output(self.model_output_max_tokens())` → joins sections with newlines and returns the final string.

**Call relations**: Used by `log_preview` and `to_response_item` to keep logging and response formatting consistent. It delegates budget calculation to `model_output_max_tokens` and output truncation to `truncated_output`.

*Call graph*: calls 2 internal fn (model_output_max_tokens, truncated_output); called by 1 (log_preview); 3 external calls (as_secs_f64, new, format!).


##### `function_tool_response`  (lines 438–463)

```
fn function_tool_response(
    call_id: &str,
    payload: &ToolPayload,
    body: Vec<FunctionCallOutputContentItem>,
    success: Option<bool>,
) -> ResponseInputItem
```

**Purpose**: Constructs the correct protocol response item for function-like tool outputs, including custom tool calls. It also normalizes the body into plain text when there is exactly one text content item.

**Data flow**: Takes `call_id`, original `payload`, `body: Vec<FunctionCallOutputContentItem>`, and `success` → if `body` is exactly `[InputText { text }]`, converts it to `FunctionCallOutputBody::Text(text.clone())`; otherwise wraps it as `FunctionCallOutputBody::ContentItems(body)` → if `payload` matches `ToolPayload::Custom`, returns `ResponseInputItem::CustomToolCallOutput { ... }`; else returns `ResponseInputItem::FunctionCallOutput { ... }`.

**Call relations**: This helper is called by `FunctionToolOutput::to_response_item`, `ApplyPatchToolOutput::to_response_item`, `AbortedToolOutput::to_response_item`, and `ExecCommandToolOutput::to_response_item`. It centralizes protocol branching so each output type does not duplicate custom-vs-function response logic.

*Call graph*: called by 4 (to_response_item, to_response_item, to_response_item, to_response_item); 3 external calls (matches!, ContentItems, Text).


##### `telemetry_preview`  (lines 465–503)

```
fn telemetry_preview(content: &str) -> String
```

**Purpose**: Produces a bounded preview string for logs by truncating first at a UTF-8-safe byte boundary and then by line count, appending a standard truncation notice when needed. It prevents oversized or multi-line outputs from flooding telemetry.

**Data flow**: Takes `content: &str` → computes `truncated_slice = take_bytes_at_char_boundary(content, TELEMETRY_PREVIEW_MAX_BYTES)` and whether byte truncation occurred → iterates up to `TELEMETRY_PREVIEW_MAX_LINES` lines into a new `preview` string and detects line truncation → if neither byte nor line truncation happened, returns the original content unchanged → otherwise preserves a trailing newline when appropriate, ensures the preview ends with a newline, appends `TELEMETRY_PREVIEW_TRUNCATION_NOTICE`, and returns the result.

**Call relations**: This helper is called by all `log_preview` implementations in the file. It delegates only UTF-8-safe byte slicing to `take_bytes_at_char_boundary`, providing a single consistent telemetry truncation policy across tool outputs.

*Call graph*: called by 6 (log_preview, log_preview, log_preview, log_preview, log_preview, log_preview); 2 external calls (new, take_bytes_at_char_boundary).


### `core/src/tools/code_mode/response_adapter.rs`

`util` · `request handling`

This file defines a private conversion trait, `IntoProtocol<T>`, and uses it to bridge `codex_code_mode` response structures into `codex_protocol::models` equivalents. The top-level helper transforms a whole `Vec<codex_code_mode::FunctionCallOutputContentItem>` by consuming it and mapping each element through the trait implementation.

There are two concrete conversions. `CodeModeImageDetail` is translated variant-for-variant into protocol `ImageDetail`, with no fallback logic because the source enum is already explicit. `codex_code_mode::FunctionCallOutputContentItem` is converted into protocol `FunctionCallOutputContentItem` by matching on the source variant: text items keep their `text` unchanged, while image items keep `image_url` and normalize `detail`. The notable design choice is that image detail is never left absent in the protocol form: if the code-mode item has `None`, the adapter inserts `DEFAULT_IMAGE_DETAIL`; if it has `Some(detail)`, that nested enum is converted first. This means downstream protocol consumers can rely on image detail always being populated after adaptation, even when code mode omitted it.

The file contains no side effects, no shared state, and no error path; all conversions are total and lossless except for the intentional defaulting of missing image detail.

#### Function details

##### `into_function_call_output_content_items`  (lines 10–14)

```
fn into_function_call_output_content_items(
    items: Vec<codex_code_mode::FunctionCallOutputContentItem>,
) -> Vec<FunctionCallOutputContentItem>
```

**Purpose**: Consumes a vector of code-mode content items and returns the protocol-model equivalents in the same order. It is the batch entry point used when runtime responses need to be surfaced through the standard tool response path.

**Data flow**: Takes `items: Vec<codex_code_mode::FunctionCallOutputContentItem>` → iterates with `into_iter()`, converts each element via `IntoProtocol::into_protocol` → collects into `Vec<codex_protocol::models::FunctionCallOutputContentItem>` and returns it. It reads no external state and writes nothing.

**Call relations**: This helper is invoked from `handle_runtime_response` when code-mode output must be packaged as protocol content items. It delegates per-item conversion to the trait impl for `codex_code_mode::FunctionCallOutputContentItem` so the caller does not need to know variant-level mapping rules.

*Call graph*: called by 1 (handle_runtime_response).


##### `CodeModeImageDetail::into_protocol`  (lines 17–25)

```
fn into_protocol(self) -> ImageDetail
```

**Purpose**: Maps a code-mode image detail enum into the protocol image detail enum with a direct one-to-one variant translation. It exists so nested image metadata can be converted uniformly through the same trait.

**Data flow**: Consumes `self` as `CodeModeImageDetail` → matches `Auto | Low | High | Original` → returns the corresponding `codex_protocol::models::ImageDetail`. No state is read or mutated.

**Call relations**: This conversion is not called directly by the batch helper; it is used transitively from `FunctionCallOutputContentItem::into_protocol` when an image item carries an explicit `detail`. Its role is to keep nested enum conversion centralized and type-safe.


##### `FunctionCallOutputContentItem::into_protocol`  (lines 31–46)

```
fn into_protocol(self) -> FunctionCallOutputContentItem
```

**Purpose**: Converts one code-mode output content item into the protocol representation, preserving text and image URLs while normalizing optional image detail. It is the core adapter for mixed text/image tool output content.

**Data flow**: Consumes `self` as `codex_code_mode::FunctionCallOutputContentItem` → matches on `InputText { text }` or `InputImage { image_url, detail }` → returns protocol `FunctionCallOutputContentItem`. For text, it forwards `text` unchanged. For images, it forwards `image_url` and transforms `detail` by converting `Some(detail)` through `CodeModeImageDetail::into_protocol`, or replacing `None` with `Some(DEFAULT_IMAGE_DETAIL)`.

**Call relations**: This impl is used by `into_function_call_output_content_items` for each element in the vector. It in turn delegates nested detail conversion to `CodeModeImageDetail::into_protocol` so image metadata follows the same protocol normalization rules everywhere.


### Built-in tool schemas
These files declare the model-facing schemas and naming conventions for built-in tools and hook-related compatibility surfaces.

### `core/src/tools/handlers/get_context_remaining_spec.rs`

`config` · `tool registration`

This file is purely declarative. It exports the constant `GET_CONTEXT_REMAINING_TOOL_NAME` and builds the `ToolSpec` advertised to the model. `create_get_context_remaining_tool` returns `ToolSpec::Function(ResponsesApiTool)` with a fixed name and description, `strict: false`, no deferred loading, an empty object input schema, and an explicit output schema. The input schema is created with `JsonSchema::object(BTreeMap::new(), None, Some(false.into()))`, meaning the tool takes no defined properties and disallows extras.

The private `get_context_remaining_output_schema` returns a JSON Schema `Value` describing the response shape: an object with a required `tokens_left` property, where `tokens_left` may be either an integer or `null`, and no additional properties are allowed. The description on that property makes the semantic distinction explicit: `null` means the remaining budget is unavailable rather than zero. Keeping this schema separate from the runtime logic in `get_context_remaining.rs` ensures the handler and the advertised contract stay aligned while remaining easy to inspect independently.

#### Function details

##### `create_get_context_remaining_tool`  (lines 10–19)

```
fn create_get_context_remaining_tool() -> ToolSpec
```

**Purpose**: Builds the complete `ToolSpec` advertised for the `get_context_remaining` tool.

**Data flow**: Constructs a `ResponsesApiTool` using the exported tool-name constant, a fixed description, `strict: false`, `defer_loading: None`, an empty-object parameter schema from `JsonSchema::object`, and `Some(get_context_remaining_output_schema())` as `output_schema`. It wraps that in `ToolSpec::Function` and returns it.

**Call relations**: It is called by `GetContextRemainingHandler::spec` so the runtime handler can expose this exact wire contract.

*Call graph*: calls 2 internal fn (get_context_remaining_output_schema, object); called by 1 (spec); 2 external calls (new, Function).


##### `get_context_remaining_output_schema`  (lines 21–36)

```
fn get_context_remaining_output_schema() -> Value
```

**Purpose**: Defines the JSON Schema for the tool's structured output payload.

**Data flow**: Returns a `serde_json::Value` built with `json!` describing an object with required property `tokens_left`, where the property accepts either integer or null and forbids additional properties.

**Call relations**: This helper is used only by `create_get_context_remaining_tool` to keep the output schema readable and isolated.

*Call graph*: called by 1 (create_get_context_remaining_tool); 1 external calls (json!).


### `core/src/tools/handlers/request_user_input_spec.rs`

`config` · `tool registration and argument validation`

This file is the specification and validation companion for the `request_user_input` handler. It declares the tool name constant plus the supported auto-resolution bounds (`MIN_AUTO_RESOLUTION_MS = 60_000`, `MAX_AUTO_RESOLUTION_MS = 240_000`). `create_request_user_input_tool` builds a nested JSON schema for one to three questions: each question requires `id`, `header`, `question`, and `options`; each option requires `label` and `description`; and additional properties are disallowed throughout. The schema descriptions are prescriptive, including the instruction to provide 2–3 mutually exclusive choices, put the recommended option first, and omit an explicit “Other” choice because the client adds it automatically.

The runtime helpers encode policy that is easy to miss from the schema alone. `request_user_input_unavailable_message` compares the current `ModeKind` against an allowed-mode slice and returns a user-facing error string when disallowed. `normalize_request_user_input_args` rejects any question whose `options` field is missing or empty, force-enables `question.is_other = true` for every question so the client can offer free-form input, and clamps `auto_resolution_ms` into the supported range while emitting a `tracing::warn!` when clamping occurs. `request_user_input_tool_description` produces the long-form tool description shown to the model, using `format_allowed_modes` to render the allowed modes as “no modes”, a single “X mode”, a two-mode “A or B mode”, or a comma-joined plural list.

#### Function details

##### `create_request_user_input_tool`  (lines 12–92)

```
fn create_request_user_input_tool(description: String) -> ToolSpec
```

**Purpose**: Constructs the full `ToolSpec` for `request_user_input`, including nested schemas for questions and options and the optional auto-resolution field. It is the authoritative model-facing contract for this tool.

**Data flow**: It receives a prebuilt description string, creates `BTreeMap` property sets for option objects and question objects, wraps them in `JsonSchema::object` and `JsonSchema::array`, creates a `JsonSchema::number` for `autoResolutionMs` whose description embeds the min/max constants, then assembles a top-level object schema requiring only `questions`. It returns `ToolSpec::Function(ResponsesApiTool { name, description, strict: false, defer_loading: None, parameters, output_schema: None })`.

**Call relations**: The handler's `spec` method calls this after generating a mode-aware description. It delegates all schema node creation to `JsonSchema` constructors and serves as the single source of truth for the tool's wire shape.

*Call graph*: calls 4 internal fn (array, number, object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `request_user_input_unavailable_message`  (lines 94–106)

```
fn request_user_input_unavailable_message(
    mode: ModeKind,
    available_modes: &[ModeKind],
) -> Option<String>
```

**Purpose**: Determines whether the tool is allowed in the current collaboration mode and, if not, produces the exact model-facing rejection message. It keeps mode gating logic simple and reusable.

**Data flow**: It takes the current `ModeKind` and a slice of allowed modes. If `available_modes.contains(&mode)` is true, it returns `None`; otherwise it reads `mode.display_name()`, formats `"request_user_input is unavailable in {mode_name} mode"`, and returns that string inside `Some`.

**Call relations**: This helper is called by `RequestUserInputHandler::handle_call` after reading the session's current mode. It does not perform side effects; it just translates policy state into an optional error message.

*Call graph*: calls 1 internal fn (display_name); called by 1 (handle_call); 2 external calls (format!, contains).


##### `normalize_request_user_input_args`  (lines 108–137)

```
fn normalize_request_user_input_args(
    mut args: RequestUserInputArgs,
) -> Result<RequestUserInputArgs, String>
```

**Purpose**: Applies runtime validation and normalization to parsed `RequestUserInputArgs`. It enforces non-empty options, guarantees support for free-form “Other” answers, and bounds auto-resolution timing.

**Data flow**: It takes ownership of a mutable `RequestUserInputArgs`. It scans `args.questions` and returns `Err(String)` if any question has `options` missing or empty. It then mutates every question to set `is_other = true`. If `args.auto_resolution_ms` is `Some`, it clamps the value between `MIN_AUTO_RESOLUTION_MS` and `MAX_AUTO_RESOLUTION_MS`; when the clamped value differs, it logs a `tracing::warn!` and writes the clamped value back. Finally it returns `Ok(args)`.

**Call relations**: The request-user-input handler calls this immediately after JSON parsing and before invoking the session. It complements the schema by enforcing semantic rules that cannot be fully expressed or trusted at the model boundary.

*Call graph*: called by 1 (handle_call); 1 external calls (warn!).


##### `request_user_input_tool_description`  (lines 139–144)

```
fn request_user_input_tool_description(available_modes: &[ModeKind]) -> String
```

**Purpose**: Builds the long-form description string shown to the model for the `request_user_input` tool. The text explains when to use `autoResolutionMs` and explicitly names the allowed modes.

**Data flow**: It takes a slice of `ModeKind`, converts it to a human-readable phrase via `format_allowed_modes`, interpolates that phrase and the min/max constants into a fixed explanatory sentence, and returns the resulting `String`.

**Call relations**: This function is called by `RequestUserInputHandler::spec` before `create_request_user_input_tool`. It depends on `format_allowed_modes` to keep the mode-list wording consistent across different feature configurations.

*Call graph*: calls 1 internal fn (format_allowed_modes); called by 1 (spec); 1 external calls (format!).


##### `format_allowed_modes`  (lines 146–158)

```
fn format_allowed_modes(available_modes: &[ModeKind]) -> String
```

**Purpose**: Formats a slice of allowed `ModeKind` values into a compact English phrase suitable for embedding in tool descriptions. It handles zero, one, two, and many modes differently for readability.

**Data flow**: It iterates over `available_modes`, maps each mode to `mode.display_name()`, and collects the names into `Vec<&str>`. It then matches on the slice shape: empty becomes `"no modes"`, one item becomes `"<mode> mode"`, two items become `"<first> or <second> mode"`, and three or more become `"modes: <joined names>"` using comma joining.

**Call relations**: This is a private helper used only by `request_user_input_tool_description`. Its sole role is to keep the generated description grammatically sensible across feature-flag combinations.

*Call graph*: called by 1 (request_user_input_tool_description); 2 external calls (format!, iter).


### `core/src/tools/handlers/shell_spec.rs`

`config` · `tool registration / schema publication`

This file is the schema factory for the shell tool family. Its small `CommandToolOptions` struct controls two policy-sensitive branches in spec generation: whether login-shell behavior is exposed at all, and whether the richer `with_additional_permissions` approval mode is available. The main constructor builds an `exec_command` function spec by assembling a `BTreeMap<String, JsonSchema>` of parameters, then conditionally inserting `shell`, `login`, and `environment_id` before appending approval-related fields. The resulting tool advertises a shared structured output schema containing fields like `session_id`, `exit_code`, and truncated `output`, which is reused by both initial execution and `write_stdin` polling/writing.

A separate `shell_command` spec describes the simpler one-shot shell interface. Its description text diverges sharply by platform: on Windows it embeds concrete PowerShell examples plus a long safety appendix from `windows_shell_guidance`, while non-Windows builds emphasize setting `workdir` instead of issuing `cd`. Permission escalation is modeled uniformly through `create_approval_parameters`, which always exposes `sandbox_permissions`, `justification`, and `prefix_rule`, and conditionally adds `additional_permissions` when enabled. The permission request tool uses a nested schema composed from `permission_profile_schema`, `network_permissions_schema`, and `file_system_permissions_schema`, all with `additionalProperties: false` to keep requests tightly shaped. Overall, the file’s design makes policy toggles visible in the schema itself rather than hidden in runtime behavior.

#### Function details

##### `create_exec_command_tool`  (lines 15–19)

```
fn create_exec_command_tool(options: CommandToolOptions) -> ToolSpec
```

**Purpose**: Builds the standard test-visible `exec_command` tool spec with the default shape: no `environment_id` parameter, but with the `shell` parameter included. It is a thin convenience wrapper around the more configurable constructor.

**Data flow**: It takes `CommandToolOptions` and forwards them unchanged into the internal constructor, while hardcoding `include_environment_id = false` and `include_shell_parameter = true`. It returns the resulting `ToolSpec` without further modification.

**Call relations**: This wrapper is used in tests to exercise the public/default exec-command schema. Rather than duplicating schema assembly, it delegates all real work to `create_exec_command_tool_with_environment_id`.

*Call graph*: calls 1 internal fn (create_exec_command_tool_with_environment_id).


##### `create_exec_command_tool_with_environment_id`  (lines 21–108)

```
fn create_exec_command_tool_with_environment_id(
    options: CommandToolOptions,
    include_environment_id: bool,
    include_shell_parameter: bool,
) -> ToolSpec
```

**Purpose**: Constructs the full `exec_command` function specification, including conditional parameters and a shared structured output schema for interactive execution. It is the central builder for the unified exec tool definition.

**Data flow**: Inputs are `CommandToolOptions`, `include_environment_id`, and `include_shell_parameter`. It starts with a `BTreeMap` containing `cmd`, `workdir`, `tty`, `yield_time_ms`, and `max_output_tokens`; conditionally inserts `shell`, `login`, and `environment_id`; extends the map with approval fields from `create_approval_parameters`; then wraps everything in `ToolSpec::Function(ResponsesApiTool)` with a platform-dependent description and `parameters` built via `JsonSchema::object`. It returns that completed `ToolSpec`.

**Call relations**: It is invoked by the test-only `create_exec_command_tool` and by higher-level tool-spec assembly elsewhere (`spec`). During construction it delegates approval-field generation to `create_approval_parameters` and output-shape generation to `unified_exec_output_schema` so those concerns stay shared with other shell tools.

*Call graph*: calls 6 internal fn (create_approval_parameters, unified_exec_output_schema, boolean, number, object, string); called by 2 (create_exec_command_tool, spec); 5 external calls (from, cfg!, format!, Function, vec!).


##### `create_write_stdin_tool`  (lines 110–152)

```
fn create_write_stdin_tool() -> ToolSpec
```

**Purpose**: Defines the `write_stdin` tool spec used to continue or poll an existing unified exec session. Its schema is intentionally narrow: identify a session, optionally send bytes, and control wait/output budgets.

**Data flow**: It creates a fixed `BTreeMap` with `session_id`, `chars`, `yield_time_ms`, and `max_output_tokens`, then packages that map into a `ResponsesApiTool` named `write_stdin`. The returned `ToolSpec` requires only `session_id` and reuses `unified_exec_output_schema()` as its output schema.

**Call relations**: This function is called from tool registration (`spec`) to expose the continuation endpoint for interactive exec sessions. It shares output semantics with `exec_command` by delegating to `unified_exec_output_schema`.

*Call graph*: calls 4 internal fn (unified_exec_output_schema, number, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `create_shell_command_tool`  (lines 154–222)

```
fn create_shell_command_tool(options: CommandToolOptions) -> ToolSpec
```

**Purpose**: Builds the simpler `shell_command` tool spec for one-shot shell execution in the user’s default shell. It exposes fewer execution controls than `exec_command` and returns unstructured output.

**Data flow**: It accepts `CommandToolOptions`, creates a property map with `command`, `workdir`, and `timeout_ms`, conditionally inserts `login`, and extends the map with approval-related fields from `create_approval_parameters`. It then chooses a description string based on `cfg!(windows)`: either a PowerShell-focused example block plus safety guidance, or a Unix-oriented note about always setting `workdir`. Finally it returns a `ToolSpec::Function` with no `output_schema`.

**Call relations**: Tool registration calls this when exposing the classic shell-command interface. It relies on `create_approval_parameters` for consistent escalation fields and on `windows_shell_guidance` to append the Windows-specific safety rules.

*Call graph*: calls 5 internal fn (create_approval_parameters, boolean, number, object, string); called by 1 (spec); 5 external calls (from, cfg!, format!, Function, vec!).


##### `create_request_permissions_tool`  (lines 224–254)

```
fn create_request_permissions_tool(description: String) -> ToolSpec
```

**Purpose**: Creates the `request_permissions` tool spec that lets the model ask the user for additional filesystem or network access. The schema is centered on a nested permission profile object plus optional context fields.

**Data flow**: It takes a caller-supplied description string, builds a property map containing `reason`, `environment_id`, and `permissions`, where `permissions` comes from `permission_profile_schema()`. It wraps those properties in a `ResponsesApiTool` named `request_permissions`, requiring only `permissions`, and returns the resulting `ToolSpec`.

**Call relations**: This builder is used by tool-spec orchestration (`spec`) when permission-request functionality is enabled. It delegates nested permission-shape construction to `permission_profile_schema` so the same schema can also be reused in per-command approval parameters.

*Call graph*: calls 3 internal fn (permission_profile_schema, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `request_permissions_tool_description`  (lines 256–259)

```
fn request_permissions_tool_description() -> String
```

**Purpose**: Provides the canonical long-form description text for the `request_permissions` tool. The text explains environment targeting, cwd-relative path resolution, and how granted permissions persist.

**Data flow**: It has no inputs and returns a freshly allocated `String` containing the full explanatory description. It does not read or mutate any state.

**Call relations**: Higher-level spec assembly (`spec`) calls this helper when it wants the standard wording for the permission-request tool instead of inlining the text.

*Call graph*: called by 1 (spec).


##### `unified_exec_output_schema`  (lines 261–293)

```
fn unified_exec_output_schema() -> Value
```

**Purpose**: Defines the shared JSON output schema for unified exec operations. It documents the optional session/progress fields and the required timing/output fields returned by command execution and stdin writes.

**Data flow**: It takes no arguments and returns a `serde_json::Value` built with `json!`. The object schema includes `chunk_id`, `wall_time_seconds`, `exit_code`, `session_id`, `original_token_count`, and `output`, marks `wall_time_seconds` and `output` as required, and forbids additional properties.

**Call relations**: Both `create_exec_command_tool_with_environment_id` and `create_write_stdin_tool` call this helper so their outputs stay structurally identical.

*Call graph*: called by 2 (create_exec_command_tool_with_environment_id, create_write_stdin_tool); 1 external calls (json!).


##### `create_approval_parameters`  (lines 295–341)

```
fn create_approval_parameters(
    exec_permission_approvals_enabled: bool,
) -> BTreeMap<String, JsonSchema>
```

**Purpose**: Builds the parameter subset that controls per-command sandbox overrides and approval prompts. It encodes the policy distinction between plain escalation and additive sandbox permissions directly into the schema.

**Data flow**: It accepts the boolean `exec_permission_approvals_enabled`. From that flag it constructs the allowed enum values for `sandbox_permissions`, chooses the corresponding description text, and creates a `BTreeMap` containing `sandbox_permissions`, `justification`, and `prefix_rule`. If approvals are enabled, it also obtains a permission profile schema from `permission_profile_schema()`, rewrites its description to explain the `with_additional_permissions` mode, and inserts it as `additional_permissions`. The completed map is returned.

**Call relations**: This helper is shared by both `create_exec_command_tool_with_environment_id` and `create_shell_command_tool`, ensuring those tools expose the same approval vocabulary and conditional fields.

*Call graph*: calls 4 internal fn (permission_profile_schema, array, string, string_enum); called by 2 (create_exec_command_tool_with_environment_id, create_shell_command_tool); 3 external calls (from, json!, vec!).


##### `permission_profile_schema`  (lines 343–354)

```
fn permission_profile_schema() -> JsonSchema
```

**Purpose**: Creates the nested schema representing a permission request profile with optional network and filesystem sections. It is the common building block for explicit permission requests and additive command permissions.

**Data flow**: It has no inputs. It constructs a `JsonSchema::object` with `network` and `file_system` properties sourced from `network_permissions_schema()` and `file_system_permissions_schema()`, sets `additionalProperties` to false, assigns the description `Filesystem or network access request.`, and returns the schema.

**Call relations**: It is called from `create_request_permissions_tool` for the top-level permission request payload and from `create_approval_parameters` when additive per-command permissions are supported.

*Call graph*: calls 3 internal fn (file_system_permissions_schema, network_permissions_schema, object); called by 2 (create_approval_parameters, create_request_permissions_tool); 1 external calls (from).


##### `network_permissions_schema`  (lines 356–369)

```
fn network_permissions_schema() -> JsonSchema
```

**Purpose**: Defines the schema for the network portion of a permission profile. The shape is intentionally minimal: a single boolean switch indicating whether network access is requested.

**Data flow**: It takes no arguments, creates an object schema with one optional `enabled: boolean` property and `additionalProperties: false`, sets the description to `Network access request.`, and returns that `JsonSchema`.

**Call relations**: This function is only used by `permission_profile_schema`, which nests it under the `network` key.

*Call graph*: calls 2 internal fn (boolean, object); called by 1 (permission_profile_schema); 1 external calls (from).


##### `file_system_permissions_schema`  (lines 371–400)

```
fn file_system_permissions_schema() -> JsonSchema
```

**Purpose**: Defines the filesystem portion of a permission profile, separating read and write grants into explicit path arrays. It documents that the arrays contain absolute paths and may be omitted when no access is needed.

**Data flow**: It takes no inputs and builds an object schema with optional `read` and `write` array properties, each containing strings. It marks `additionalProperties` false, sets the description to `Filesystem access request.`, and returns the resulting `JsonSchema`.

**Call relations**: This helper is only consumed by `permission_profile_schema`, which embeds it as the `file_system` member of the broader permission profile.

*Call graph*: calls 3 internal fn (array, object, string); called by 1 (permission_profile_schema); 1 external calls (from).


##### `windows_shell_guidance`  (lines 402–407)

```
fn windows_shell_guidance() -> &'static str
```

**Purpose**: Returns the static Windows-specific safety guidance appended to shell tool descriptions. The guidance warns against cross-shell destructive commands, unchecked recursive path operations, and visible background windows.

**Data flow**: It has no inputs and returns a `&'static str` literal containing a multi-bullet safety block. No state is read or modified.

**Call relations**: Description-building code in `create_exec_command_tool_with_environment_id` and `create_shell_command_tool` uses this helper when compiling for Windows so both tools present the same safety rules.


### `core/src/tools/hook_names.rs`

`data_model` · `cross-cutting`

This file is a compact data-model helper for hook integration. The central type, `HookToolName`, stores two related but intentionally distinct concepts: `name`, the canonical string serialized into hook stdin, and `matcher_aliases`, extra names accepted only for hook matcher selection. The module-level documentation explains the design constraint: compatibility aliases such as Claude Code-style names may help existing hook configurations match, but they must never replace the stable payload name seen by hook processes.

The implementation provides a generic constructor, `new`, which creates a hook name with no aliases, plus three named constructors for important tool families. `apply_patch()` returns canonical name `apply_patch` with aliases `Write` and `Edit`, preserving Codex-native payloads while matching edit-oriented hook configs. `spawn_agent()` similarly keeps canonical `spawn_agent` while accepting `Agent` as a matcher alias. `bash()` returns the historically used shell-tool hook identity `Bash` with no aliases.

The remaining accessors expose the canonical serialized name and the alias slice. This separation is important elsewhere in the system: pre-tool-use hook execution can match on both canonical and alias names, while payload serialization always uses `name()` so compatibility logic does not leak into persisted logs, policies, or hook stdin.

#### Function details

##### `HookToolName::new`  (lines 21–26)

```
fn new(name: impl Into<String>) -> Self
```

**Purpose**: Constructs a canonical hook tool name with no matcher aliases.

**Data flow**: It accepts any `impl Into<String>`, converts it into the owned `name` field, initializes `matcher_aliases` as an empty `Vec<String>`, and returns the new `HookToolName`.

**Call relations**: Many callers use this generic constructor for simple hook identities, and `HookToolName::bash` delegates to it. It is the baseline constructor when no compatibility aliases are needed.

*Call graph*: called by 11 (approve_mode_skips_guardian_in_every_permission_mode, approve_mode_skips_when_annotations_do_not_require_approval, full_access_mode_skips_mcp_tool_approval_for_all_approval_modes, guardian_mode_mcp_denial_returns_rationale_message, guardian_mode_skips_auto_when_annotations_do_not_require_approval, permission_request_hook_allows_mcp_tool_call, permission_request_hook_runs_after_remembered_mcp_approval, permission_request_hook_uses_hook_tool_name_without_metadata, prompt_mode_waits_for_approval_when_annotations_do_not_require_approval, hook_tool_name (+1 more)); 2 external calls (into, new).


##### `HookToolName::apply_patch`  (lines 34–39)

```
fn apply_patch() -> Self
```

**Purpose**: Returns the hook identity for file-edit operations while preserving compatibility with alternate matcher names.

**Data flow**: It takes no inputs and returns `HookToolName { name: "apply_patch".to_string(), matcher_aliases: vec!["Write".to_string(), "Edit".to_string()] }`.

**Call relations**: Hook payload builders for patch/edit flows call this so serialized hook stdin stays Codex-native while matcher selection can still recognize Claude Code-style edit names.

*Call graph*: called by 2 (post_tool_use_payload, permission_request_payload); 1 external calls (vec!).


##### `HookToolName::spawn_agent`  (lines 46–51)

```
fn spawn_agent() -> Self
```

**Purpose**: Returns the hook identity for sub-agent creation with a compatibility alias for matcher selection.

**Data flow**: It takes no inputs and returns `HookToolName { name: "spawn_agent".to_string(), matcher_aliases: vec!["Agent".to_string()] }`.

**Call relations**: The hook-name selection logic for agent-spawning tools uses this constructor to preserve canonical payload naming while supporting legacy matcher terminology.

*Call graph*: called by 1 (function_hook_tool_name); 1 external calls (vec!).


##### `HookToolName::bash`  (lines 54–56)

```
fn bash() -> Self
```

**Purpose**: Returns the canonical hook identity used for shell-like tools.

**Data flow**: It takes no inputs and returns `Self::new("Bash")`.

**Call relations**: Unified exec post-hook generation and other shell-related hook paths call this constructor so all shell-like tools serialize under the same historical hook name.

*Call graph*: called by 3 (post_tool_use_payload, post_unified_exec_tool_use_payload, bash); 1 external calls (new).


##### `HookToolName::name`  (lines 59–61)

```
fn name(&self) -> &str
```

**Purpose**: Exposes the canonical string that should be serialized into hook stdin.

**Data flow**: It borrows `self` and returns `&self.name`.

**Call relations**: Pre-tool-use hook execution reads this accessor when constructing the actual hook payload, ensuring aliases are not serialized.

*Call graph*: called by 1 (run_pre_tool_use_hooks).


##### `HookToolName::matcher_aliases`  (lines 64–66)

```
fn matcher_aliases(&self) -> &[String]
```

**Purpose**: Exposes the additional names that should match the same hook handlers without changing serialized payloads.

**Data flow**: It borrows `self` and returns `&[String]` referencing `self.matcher_aliases`.

**Call relations**: Hook matcher selection reads this accessor alongside `name()` so compatibility aliases can trigger the same hooks while remaining internal-only.

*Call graph*: called by 1 (run_pre_tool_use_hooks).


### Protocol payload schemas
These files define the shared protocol-level request, response, metadata, and planning payloads consumed by tool and approval flows.

### `protocol/src/mcp_approval_meta.rs`

`config` · `request handling`

This file is a pure constant catalog for approval-related metadata exchanged through the MCP protocol layer. It groups string keys such as `APPROVAL_KIND_KEY`, `REQUEST_TYPE_KEY`, `APPROVALS_REVIEWER_KEY`, persistence/source fields, connector identity fields, and tool description/parameter fields. Alongside those keys, it defines the expected discriminator values for several of them: approval kinds (`mcp_tool_call`, `tool_suggestion`), request type (`approval_request`), persistence modes (`session`, `always`), and source (`connector`).

The practical effect is schema stability without introducing a dedicated struct type in this file. Other code can build loosely structured metadata maps while still relying on a single source of truth for exact wire-format spellings. That matters because these values are effectively protocol contracts: changing capitalization or wording would break interoperability with clients, reviewers, or connectors that inspect metadata by string key. The file also reveals the shape of approval metadata expected elsewhere in the system: approvals may carry reviewer identity, persistence semantics, connector provenance, and rich tool descriptors including name, title, description, raw params, and display-oriented params. There is no control flow here; correctness depends entirely on consumers using these constants instead of ad hoc literals.


### `protocol/src/plan_tool.rs`

`data_model` · `request handling`

This file models the request body expected by the plan-management tooling. `StepStatus` is an enum with three explicit workflow states: `Pending`, `InProgress`, and `Completed`. `PlanItemArg` pairs a human-readable `step` string with one of those statuses, representing a single checklist item. `UpdatePlanArgs` is the top-level payload for the `update_plan` tool and contains an optional `explanation` plus a required `plan: Vec<PlanItemArg>`.

Two schema decisions are notable. First, both `PlanItemArg` and `UpdatePlanArgs` use `#[serde(deny_unknown_fields)]`, which makes deserialization fail if callers send extra keys; this is stricter than many protocol structs and signals that tool arguments should match the contract exactly. Second, `explanation` is marked `#[serde(default)]`, so omitted explanations deserialize cleanly to `None` rather than causing an error. The file also derives `JsonSchema` and `TS`, indicating these Rust definitions are the source of truth for generated schemas and TypeScript types consumed by clients. There is no business logic here for validating plan semantics or transitioning statuses; the file’s responsibility is to define the exact wire shape and accepted status vocabulary for plan updates.


### `protocol/src/request_permissions.rs`

`data_model` · `request handling`

This file contains the small but important schema used when the agent asks the user to grant extra network or filesystem permissions. `PermissionGrantScope` distinguishes whether granted permissions apply only to the current turn or persist for the session. `RequestPermissionProfile` is a narrow wrapper around optional `NetworkPermissions` and `FileSystemPermissions`; it uses `deny_unknown_fields` so malformed or unexpected JSON is rejected instead of silently ignored.

The request/response/event structs separate the three stages of the flow. `RequestPermissionsArgs` is the tool-call argument shape, including an optional `environment_id`, optional human-readable `reason`, and the requested permission profile. `RequestPermissionsResponse` carries the granted profile back plus the chosen scope and a `strict_auto_review` flag that forces subsequent commands in the turn through review before normal sandboxed execution. `RequestPermissionsEvent` is the event emitted to clients, adding protocol metadata such as `call_id`, `turn_id`, `started_at_ms`, and optional `cwd`.

The conversion impls intentionally mirror field names exactly between `RequestPermissionProfile` and `AdditionalPermissionProfile`, making this file the adapter between protocol-facing permission requests and the internal model-layer representation. The only behavior beyond schema definition is `is_empty`, which lets callers detect no-op permission requests before surfacing them.

#### Function details

##### `RequestPermissionProfile::is_empty`  (lines 26–28)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a requested permission profile asks for nothing at all. Both network and filesystem sections must be absent for the profile to count as empty.

**Data flow**: Reads `self.network` and `self.file_system` → returns `true` when both are `None`, otherwise `false`.

**Call relations**: Used by callers that want to suppress or reject empty permission requests before prompting the user. It is a pure predicate with no delegation.


##### `AdditionalPermissionProfile::from`  (lines 32–37)

```
fn from(value: RequestPermissionProfile) -> Self
```

**Purpose**: Converts the protocol-specific `RequestPermissionProfile` into the broader `AdditionalPermissionProfile` used by the model/runtime layer. The conversion is field-for-field and lossless.

**Data flow**: Consumes `RequestPermissionProfile` → moves `network` and `file_system` into a new `AdditionalPermissionProfile` → returns it.

**Call relations**: Used when a permission request or response leaves the protocol layer and must be applied to runtime permission state.


##### `RequestPermissionProfile::from`  (lines 41–46)

```
fn from(value: AdditionalPermissionProfile) -> Self
```

**Purpose**: Converts an internal `AdditionalPermissionProfile` back into the protocol-facing `RequestPermissionProfile`. This supports emitting or persisting permission requests in protocol form.

**Data flow**: Consumes `AdditionalPermissionProfile` → moves `network` and `file_system` into a new `RequestPermissionProfile` → returns it.

**Call relations**: Used when internal permission deltas need to be surfaced through the request-permissions protocol.


### `protocol/src/request_user_input.rs`

`data_model` · `request handling`

This file provides a family of serializable structs for interactive user-input requests. `RequestUserInputQuestionOption` models a selectable option with `label` and `description`. `RequestUserInputQuestion` describes one prompt with stable `id`, display `header`, question text, two boolean flags (`is_other` and `is_secret`) that are explicitly renamed to `isOther` and `isSecret` on the wire, and optional multiple-choice `options`. `RequestUserInputArgs` groups a list of questions plus an optional `auto_resolution_ms` timeout, serialized as `autoResolutionMs`.

On the answer side, `RequestUserInputAnswer` stores `answers: Vec<String>`, allowing multi-valued responses per question. `RequestUserInputResponse` maps question IDs to those answer objects via `HashMap<String, RequestUserInputAnswer>`, making the response keyed and order-independent. `RequestUserInputEvent` mirrors the request content for event emission, but adds `call_id` to associate the request with a specific Responses API tool call and `turn_id` to associate it with a conversation turn; `turn_id` uses `#[serde(default)]` for backward compatibility so older payloads lacking the field still deserialize.

The file is careful about wire compatibility and frontend naming. Several fields use serde/schemars/ts rename annotations in parallel so Rust, JSON Schema, and generated TypeScript all agree on camelCase names. Optional fields skip serialization when absent, keeping payloads compact and preserving older clients’ expectations.


### Extension tool schemas
These files provide schema-generation and tool-contract definitions for goal, skills, and web-search extension surfaces.

### `ext/goal/src/spec.rs`

`config` · `tool registration / schema exposure`

This file is a pure tool-spec factory for the goal extension. It exports three stable tool-name constants and three constructors that wrap `ResponsesApiTool` values in `ToolSpec::Function`. The important content here is not runtime logic but the contract exposed to the model: parameter schemas, required fields, and long-form behavioral guidance embedded in each tool description. `create_get_goal_tool` intentionally exposes an empty object schema with no required fields and `additionalProperties` disabled, making the read operation argument-free. `create_create_goal_tool` builds a two-field object schema: required `objective` as a string and optional `token_budget` as an integer; its description explicitly forbids inferring goals from ordinary work and says creation must fail when an unfinished goal exists. `create_update_goal_tool` narrows updates to a single required `status` enum with only `complete` and `blocked`, and its description encodes the blocked-audit policy, the prohibition on using this tool for pause/resume or limit transitions, and the requirement to report final usage when a budgeted goal is completed. The file uses `BTreeMap` so schema properties are assembled deterministically.

#### Function details

##### `create_get_goal_tool`  (lines 13–23)

```
fn create_get_goal_tool() -> ToolSpec
```

**Purpose**: Builds the `get_goal` tool specification with no accepted arguments and a descriptive summary of the returned goal state. It exposes the read-only goal lookup operation to the Responses API.

**Data flow**: It takes no inputs, reads the `GET_GOAL_TOOL_NAME` constant, constructs an empty-object `JsonSchema` with no required properties and no additional properties, and returns a `ToolSpec::Function` containing a `ResponsesApiTool` with `output_schema` unset.

**Call relations**: It is invoked by the extension's spec assembly path when goal tools are registered. It delegates schema construction to `JsonSchema::object` and wraps the result in the external `ResponsesApiTool`/`ToolSpec::Function` types so executors can later advertise this tool.

*Call graph*: calls 1 internal fn (object); called by 1 (spec); 3 external calls (new, new, Function).


##### `create_create_goal_tool`  (lines 25–58)

```
fn create_create_goal_tool() -> ToolSpec
```

**Purpose**: Builds the `create_goal` tool specification, including the request schema for `objective` and optional `token_budget` plus strict usage instructions for when creation is allowed. The description text is part of the enforcement strategy because it constrains model behavior before runtime validation runs.

**Data flow**: It creates a `BTreeMap<String, JsonSchema>` for `objective` and `token_budget`, marks only `objective` as required, disables additional properties, formats a description string that references `UPDATE_GOAL_TOOL_NAME`, and returns the assembled `ToolSpec::Function`.

**Call relations**: It is called during tool-spec publication for the create executor. Internally it delegates primitive schema creation to `JsonSchema::string`, `JsonSchema::integer`, and `JsonSchema::object`, then packages everything into the external tool wrapper.

*Call graph*: calls 3 internal fn (integer, object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `create_update_goal_tool`  (lines 60–94)

```
fn create_update_goal_tool() -> ToolSpec
```

**Purpose**: Builds the `update_goal` tool specification for terminal goal status changes only. Its schema and description intentionally restrict updates to `complete` or `blocked` and explain the repeated-blocking threshold and non-goals of the tool.

**Data flow**: It constructs a one-property schema where `status` is a required string enum over JSON values `"complete"` and `"blocked"`, embeds a long explanatory description, and returns a `ToolSpec::Function` with no output schema override.

**Call relations**: It is used when the update executor reports its spec. It delegates enum/object schema creation to `JsonSchema::string_enum` and `JsonSchema::object`, then wraps the result for the Responses API.

*Call graph*: calls 2 internal fn (object, string_enum); called by 1 (spec); 3 external calls (from, Function, vec!).


### `ext/skills/src/tools/schema.rs`

`util` · `tool schema generation`

This file is a small schema-generation utility used by the skills tools. It exposes two wrappers, `input_schema_for` and `output_schema_for`, which differ only in whether `Option<T>` fields should be represented with an explicit `null` type. Both delegate to the internal `schema_for` function.

`schema_for` starts from `SchemaSettings::draft2019_09()` and mutates the settings before generation: `inline_subschemas` is forced to `true` so nested definitions are embedded directly where possible, and `option_add_null_type` is set from the caller so input and output schemas can follow slightly different conventions. It then generates a root schema for the requested `JsonSchema` type, serializes that schema to `serde_json::Value`, and asserts that the root is a JSON object.

Rather than returning the full schemars output, the function constructs a new `serde_json::Map` containing only a curated subset of top-level keys: `properties`, `required`, `type`, `additionalProperties`, `$defs`, and `definitions`. Any other metadata emitted by schemars is discarded. This keeps the tool-facing schema payload minimal and stable while preserving the structural information needed by `parse_tool_input_schema` and by output-schema consumers.

#### Function details

##### `input_schema_for`  (lines 6–8)

```
fn input_schema_for() -> Value
```

**Purpose**: Generates the JSON Schema fragment used for tool input parameters without adding explicit `null` types for optional fields.

**Data flow**: Accepts a generic `T: JsonSchema`, calls `schema_for::<T>(false)`, and returns the resulting `serde_json::Value`.

**Call relations**: This helper is used indirectly by `skill_function_tool` when building the parsed input schema for a skills function tool.


##### `output_schema_for`  (lines 10–12)

```
fn output_schema_for() -> Value
```

**Purpose**: Generates the JSON Schema fragment used for tool outputs, allowing optional fields to include explicit `null` typing.

**Data flow**: Accepts a generic `T: JsonSchema`, calls `schema_for::<T>(true)`, and returns the resulting `serde_json::Value`.

**Call relations**: This helper is used indirectly by `skill_function_tool` when attaching an output schema to a skills function tool.


##### `schema_for`  (lines 14–42)

```
fn schema_for(option_add_null_type: bool) -> Value
```

**Purpose**: Builds a reduced root JSON Schema object for a given type using draft 2019-09 settings and a curated set of top-level keys.

**Data flow**: Accepts a boolean `option_add_null_type`, creates `SchemaSettings::draft2019_09()`, mutates the settings to inline subschemas and set the null-type option, generates a root schema for `T`, serializes it to `serde_json::Value`, and panics if serialization fails. It then pattern-matches the value as `Value::Object`, panicking via `unreachable!` if not, removes selected keys from the generated object, inserts those keys into a fresh `Map`, and returns `Value::Object(tool_schema)`.

**Call relations**: This internal helper underpins both `input_schema_for` and `output_schema_for`. It encapsulates the exact schema-shaping policy expected by the shared tool-spec builder.

*Call graph*: 5 external calls (new, draft2019_09, Object, to_value, unreachable!).


### `ext/web-search/src/schema.rs`

`io_transport` · `spec generation`

This file contains a single helper that converts the Rust type `SearchCommands` into a `serde_json::Value` schema payload suitable for publication by the web-search extension. It starts from `schemars::r#gen::SchemaSettings::draft2019_09()`, then customizes generation in two important ways: `inline_subschemas = true` forces nested definitions to be embedded directly where possible, and `option_add_null_type = false` prevents `Option<T>` fields from being represented by an explicit JSON Schema `null` type. After generating a root schema for `SearchCommands`, it serializes that schema structure into JSON with `serde_json::to_value`; serialization failure is treated as impossible and causes a panic with a targeted message.

The function then enforces an invariant that the generated schema root must be a JSON object. Using pattern matching, it extracts the underlying `Map<String, Value>` and marks any non-object result as unreachable. Finally, it constructs a fresh object containing only a curated subset of top-level schema keys: `properties`, `required`, `type`, `additionalProperties`, `$defs`, and `definitions`. Any other metadata emitted by schemars—such as titles, descriptions, or schema dialect markers—is intentionally discarded. The result is therefore not the full root schema document, but a compact object-schema fragment tailored for the caller that assembles the extension's external spec.

#### Function details

##### `commands_schema`  (lines 6–36)

```
fn commands_schema() -> Value
```

**Purpose**: Generates a JSON Schema object for `SearchCommands` and reduces it to the subset of fields needed by the web-search tool spec. It deliberately returns only the structural object-schema members rather than the entire schemars root document.

**Data flow**: It reads no external mutable state. Starting from the static Rust type `SearchCommands`, it creates draft 2019-09 schema settings, mutates those settings to inline subschemas and suppress null typing for options, generates a root schema, serializes that schema into a `serde_json::Value`, asserts that the value is an object, then removes selected keys from that object into a new `serde_json::Map`. It returns `Value::Object(tool_schema)` containing only `properties`, `required`, `type`, `additionalProperties`, `$defs`, and `definitions` when present.

**Call relations**: This function is invoked by `spec` when the extension needs the command input schema embedded in its published specification. Within its own flow it delegates schema construction to schemars and JSON conversion to `serde_json::to_value`; if those assumptions fail, it terminates via `panic!` or `unreachable!` because the caller expects schema generation to be deterministic and structurally valid.

*Call graph*: called by 1 (spec); 6 external calls (new, draft2019_09, Object, panic!, to_value, unreachable!).


### MCP tool configuration
This file translates MCP-exposed codex tool payloads into validated schemas and core runtime configuration.

### `mcp-server/src/codex_tool_config.rs`

`config` · `MCP tool registration and tool-call argument parsing`

This file models the configuration accepted by MCP tool calls. `CodexToolCallParam` is a kebab-case, `deny_unknown_fields` request struct containing the initial prompt plus optional model, cwd, approval policy, sandbox mode, arbitrary config overrides, and instruction overrides. Because the protocol enums used internally do not derive `JsonSchema`, the file defines mirror enums `CodexToolCallApprovalPolicy` and `CodexToolCallSandboxMode`, each with `From` implementations into `AskForApproval` and `SandboxMode`. `create_tool_for_codex_tool_call_param` and `create_tool_for_codex_tool_call_reply_param` generate `rmcp::model::Tool` definitions by asking `schemars` for a Draft 2019-09 schema, forcing inline subschemas and suppressing nullable option encoding, then trimming the serialized schema down to the keys MCP clients need via `create_tool_input_schema`. Both tools share `codex_tool_output_schema`, which declares a structured object containing `threadId` and `content`. `CodexToolCallParam::into_config` is the main runtime bridge: it consumes the MCP request, separates the initial prompt from configuration fields, builds `ConfigOverrides` including executable paths from `Arg0DispatchPaths`, converts JSON config overrides into TOML values with `json_to_toml`, and asynchronously builds a `codex_core::config::Config` via `ConfigBuilder`. `CodexToolCallReplyParam` supports both deprecated `conversationId` and current `threadId`, with `get_thread_id` parsing either into a `ThreadId` and erroring only if both are absent. Inline tests snapshot the exact generated schemas and verify that removed fields like `profile` are rejected.

#### Function details

##### `AskForApproval::from`  (lines 77–84)

```
fn from(value: CodexToolCallApprovalPolicy) -> Self
```

**Purpose**: Converts the MCP schema-friendly approval-policy enum into the internal protocol enum used by Codex execution logic.

**Data flow**: Accepts `CodexToolCallApprovalPolicy` by value → matches each variant (`Untrusted`, `OnFailure`, `OnRequest`, `Never`) to the corresponding `AskForApproval` variant → returns the internal enum.

**Call relations**: Used indirectly by `CodexToolCallParam::into_config` when translating incoming tool-call parameters into `ConfigOverrides`.


##### `SandboxMode::from`  (lines 98–104)

```
fn from(value: CodexToolCallSandboxMode) -> Self
```

**Purpose**: Converts the MCP schema-friendly sandbox enum into the internal `codex_protocol::config_types::SandboxMode`.

**Data flow**: Accepts `CodexToolCallSandboxMode` by value → matches each variant to `SandboxMode::ReadOnly`, `WorkspaceWrite`, or `DangerFullAccess` → returns the internal enum.

**Call relations**: Also used by `CodexToolCallParam::into_config` while building runtime configuration from MCP input.


##### `create_tool_for_codex_tool_call_param`  (lines 108–126)

```
fn create_tool_for_codex_tool_call_param() -> Tool
```

**Purpose**: Builds the MCP `Tool` definition for starting a new Codex session, including input and output schemas.

**Data flow**: Generates a root JSON schema for `CodexToolCallParam` using `SchemaSettings::draft2019_09()` with inline subschemas and non-null options → passes it to `create_tool_input_schema` → constructs `Tool::new("codex", ...)`, sets title `Codex`, and attaches `codex_tool_output_schema()`.

**Call relations**: Called by schema snapshot tests and by tool-registration code elsewhere to expose the `codex` tool to MCP clients.

*Call graph*: calls 2 internal fn (codex_tool_output_schema, create_tool_input_schema); called by 1 (verify_codex_tool_json_schema); 2 external calls (draft2019_09, new).


##### `codex_tool_output_schema`  (lines 128–141)

```
fn codex_tool_output_schema() -> Arc<JsonObject>
```

**Purpose**: Creates the shared structured output schema used by both `codex` and `codex-reply` tool definitions.

**Data flow**: Builds a JSON object literal with `type: object`, `properties.threadId`, `properties.content`, and both fields required → if the literal is an object, wraps it in `Arc<JsonObject>`; otherwise panics via `unreachable!`.

**Call relations**: Used by both tool-definition builders so clients can rely on a consistent structured response shape.

*Call graph*: called by 2 (create_tool_for_codex_tool_call_param, create_tool_for_codex_tool_call_reply_param); 3 external calls (new, json!, unreachable!).


##### `CodexToolCallParam::into_config`  (lines 146–190)

```
async fn into_config(
        self,
        arg0_paths: Arg0DispatchPaths,
    ) -> std::io::Result<(String, Config)>
```

**Purpose**: Consumes an MCP `codex` tool-call request and turns it into the initial user prompt plus an effective `codex_core::Config`.

**Data flow**: Consumes `self` and `arg0_paths` → destructures request fields, preserving `prompt` separately → builds `ConfigOverrides` from optional model/cwd/approval/sandbox/instruction fields plus executable paths from `Arg0DispatchPaths` → converts optional JSON `config` map into TOML-valued CLI overrides with `json_to_toml` → feeds both override sets into `ConfigBuilder::default().cli_overrides(...).harness_overrides(...).build().await` → returns `Ok((prompt, cfg))`.

**Call relations**: Called when an incoming MCP `codex` tool invocation is accepted and needs to be translated into core runtime configuration before starting a thread.

*Call graph*: 2 external calls (default, default).


##### `CodexToolCallReplyParam::get_thread_id`  (lines 211–223)

```
fn get_thread_id(&self) -> anyhow::Result<ThreadId>
```

**Purpose**: Extracts the target conversation/thread identifier from a reply-tool request, supporting both the new `threadId` field and deprecated `conversationId`.

**Data flow**: Reads `self.thread_id` first; if present, parses it with `ThreadId::from_string` → otherwise reads `self.conversation_id` and parses that → if neither exists, returns an `anyhow!` error stating one of them must be provided.

**Call relations**: Used by reply-tool handling code to resolve which existing Codex thread should receive the follow-up prompt.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (anyhow!).


##### `create_tool_for_codex_tool_call_reply_param`  (lines 227–245)

```
fn create_tool_for_codex_tool_call_reply_param() -> Tool
```

**Purpose**: Builds the MCP `Tool` definition for continuing an existing Codex session.

**Data flow**: Generates a root JSON schema for `CodexToolCallReplyParam` with the same schemars settings as the main tool → trims it through `create_tool_input_schema` → constructs `Tool::new("codex-reply", ...)`, sets title `Codex Reply`, and attaches the shared output schema.

**Call relations**: Used by schema tests and by MCP tool registration for the reply/continuation endpoint.

*Call graph*: calls 2 internal fn (codex_tool_output_schema, create_tool_input_schema); called by 1 (verify_codex_tool_reply_json_schema); 2 external calls (draft2019_09, new).


##### `create_tool_input_schema`  (lines 247–276)

```
fn create_tool_input_schema(
    schema: schemars::schema::RootSchema,
    panic_message: &str,
) -> Arc<JsonObject>
```

**Purpose**: Normalizes a full schemars root schema into the smaller JSON object shape expected by MCP tool definitions.

**Data flow**: Accepts a `schemars::schema::RootSchema` and panic message → serializes the schema to `serde_json::Value` → requires it to be an object or panics → removes and preserves only selected keys (`additionalProperties`, `properties`, `required`, `type`, `$defs`, `definitions`) into a fresh `JsonObject` → wraps it in `Arc` and returns it.

**Call relations**: Shared helper used by both tool-definition builders to strip metadata and keep only the schema fields relevant to MCP clients.

*Call graph*: called by 2 (create_tool_for_codex_tool_call_param, create_tool_for_codex_tool_call_reply_param); 4 external calls (new, new, panic!, to_value).


##### `tests::verify_codex_tool_json_schema`  (lines 295–376)

```
fn verify_codex_tool_json_schema()
```

**Purpose**: Snapshots the exact serialized MCP schema for the `codex` tool to catch accidental schema drift.

**Data flow**: Calls `create_tool_for_codex_tool_call_param`, serializes the resulting `Tool` to JSON, constructs an expected JSON literal, and asserts exact equality.

**Call relations**: Run by the test harness; it validates the combined behavior of schema derivation, schema trimming, and tool construction.

*Call graph*: calls 1 internal fn (create_tool_for_codex_tool_call_param); 3 external calls (assert_eq!, json!, to_value).


##### `tests::codex_tool_call_param_rejects_removed_profile_field`  (lines 379–390)

```
fn codex_tool_call_param_rejects_removed_profile_field()
```

**Purpose**: Verifies that `CodexToolCallParam` rejects unknown fields, specifically the removed `profile` field.

**Data flow**: Attempts to deserialize a JSON object containing `prompt` and `profile` into `CodexToolCallParam` → expects an error → asserts the error string mentions `unknown field `profile``.

**Call relations**: Tests the `deny_unknown_fields` contract on the MCP request struct.

*Call graph*: 2 external calls (assert!, json!).


##### `tests::verify_codex_tool_reply_json_schema`  (lines 393–437)

```
fn verify_codex_tool_reply_json_schema()
```

**Purpose**: Snapshots the exact serialized MCP schema for the `codex-reply` tool.

**Data flow**: Calls `create_tool_for_codex_tool_call_reply_param`, serializes the `Tool` to JSON, builds the expected JSON literal, and asserts equality.

**Call relations**: Validates the reply-tool schema generation path, including backward-compatible optional `conversationId` and `threadId` fields.

*Call graph*: calls 1 internal fn (create_tool_for_codex_tool_call_reply_param); 3 external calls (assert_eq!, json!, to_value).
