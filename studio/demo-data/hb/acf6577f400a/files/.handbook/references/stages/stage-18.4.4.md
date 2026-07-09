# Tool and protocol contract schemas  `stage-18.4.4`

This stage is shared behind-the-scenes support. It defines the “contracts” for tools and protocol messages: the agreed shapes of data that the model, Codex core, extensions, hooks, MCP clients, and user interfaces pass to each other. Like blank forms, these schemas say what fields are allowed, what names to use, and how results should be reported safely.

The tools files describe model-visible calls: generic tool inputs, tool-call packages, OpenAI Responses API tool specs, shell tools, context-count tools, user-input tools, goal tools, web search, skills, and MCP Codex session tools. They do not usually perform the work; they describe how to ask for it. The core context and code-mode adapter files translate real tool results, including text, images, commands, patches, and MCP outputs, into shared messages for the model, logs, hooks, and code mode. The protocol files define common payloads for permission requests, human questions, plan updates, and MCP approval labels, so Rust, JSON schemas, and generated TypeScript stay in agreement. Small support files forward shared errors and keep hook tool names consistent.

## Files in this stage

### Core tool contracts
These files define the shared payload, invocation, specification, and error types that underpin model-visible tool calls across the system.

### `core/src/function_tool.rs`

`util` · `cross-cutting`

This file exists to simplify how the rest of the project refers to errors from tool or function calls. Instead of every part of the codebase needing to know that `FunctionCallError` originally lives in the `codex_tools` package, this file re-exports it from the `core` package. A re-export means: “make something from another module available here too.” It is like placing a commonly used tool at a shared front desk, even though it is stored in another room.

The practical value is consistency. Code that already depends on `core` can use `core::function_tool::FunctionCallError` without directly depending on or naming `codex_tools`. That keeps the project’s public interface cleaner and gives maintainers more freedom to reorganize internals later. If the original location of this error type changes, this file can be updated while much of the rest of the code stays the same.

There is no new behavior here. It does not create, inspect, or change errors. It simply exposes an existing error type in a more convenient place.


### `tools/src/tool_payload.rs`

`data_model` · `tool request handling and logging`

Tools can be called in a few different ways, and each kind of call carries its input in a slightly different form. This file gives those forms one shared name: `ToolPayload`. Think of it like a labeled envelope: the label says what kind of tool call it is, and the contents hold the data that tool needs.

There are three accepted payload shapes. A normal function-style tool call carries raw argument text. A search tool call carries a structured search request, including a query. A custom tool call carries raw input text. Putting these into one enum means the rest of the tool system can pass around “a tool payload” without guessing which shape it has.

The file also includes `log_payload`, which extracts the most useful text from each payload for logs. For function and custom calls, it can borrow the existing string directly. For search calls, it pulls out the search query and returns an owned copy. This avoids unnecessary copying where possible while still giving callers a single text value they can record. Without this file, different tool runtimes would likely invent their own payload formats, making logging and dispatch less consistent.

#### Function details

##### `ToolPayload::log_payload`  (lines 14–20)

```
fn log_payload(&self) -> Cow<'_, str>
```

**Purpose**: This function returns the human-readable text that should be written to logs for a tool payload. It hides the differences between payload types so logging code can ask for one simple text value.

**Data flow**: It receives a `ToolPayload`. If the payload is a function call, it returns the existing argument text. If it is a search call, it takes the search query from the structured search parameters and returns a copied string. If it is a custom call, it returns the existing input text. The result is a `Cow`, which means “borrow the original text when possible, or own a new copy when needed.”

**Call relations**: When tool code needs to record what was sent to a tool, it calls this method on the payload instead of inspecting each payload shape itself. Inside, the method chooses between borrowed text and owned text using the standard `Borrowed` and `Owned` forms, so callers get a single log-ready value without caring how it was stored.

*Call graph*: 2 external calls (Borrowed, Owned).


### `tools/src/tool_call.rs`

`data_model` · `tool invocation during a conversation turn`

When the host system calls a tool, the tool needs more than just its typed name. It needs to know which conversation turn it belongs to, what arguments the model supplied, what files or working directory it may use, how much output should be kept, and whether it can publish visible progress items such as web searches or image generation. This file gathers those pieces into clear data types.

The main type is `ToolCall`, which is like a work order handed to a tool. It includes IDs for tracking, the selected tool name, the model that requested it, the conversation history so far, the payload to run with, and one or more execution environments. An environment describes where the tool is allowed to work, including the current directory, the file system interface, and the sandbox context, which is the set of safety rules for file access.

The file also defines `TurnItemEmitter`, a host-provided way for extension tools to announce visible lifecycle events. If a caller does not support that, `NoopTurnItemEmitter` quietly accepts those announcements and does nothing, like a mailbox that discards letters. Finally, `ToolCall::function_arguments` protects tools from receiving the wrong kind of payload by returning the function arguments only when the payload is actually a function call.

#### Function details

##### `ConversationHistory::new`  (lines 22–26)

```
fn new(items: Vec<ResponseItem>) -> Self
```

**Purpose**: Creates a snapshot of the conversation items that are available to a tool. This lets a tool inspect what has happened so far without owning or changing the original conversation data.

**Data flow**: It takes a list of response items from the conversation, stores them inside a shared, read-only container, and returns a `ConversationHistory` value. After this, the history can be cheaply copied while still pointing at the same stored items.

**Call relations**: This is used when a regular host tool request is converted into an extension-tool call. At that point, the current conversation items are wrapped up so the tool receives them as part of its `ToolCall` context.

*Call graph*: called by 1 (to_extension_call).


##### `ConversationHistory::items`  (lines 28–30)

```
fn items(&self) -> &[ResponseItem]
```

**Purpose**: Gives read-only access to the stored conversation items. A tool can use this to look back at the conversation without being able to edit it.

**Data flow**: It reads the `ConversationHistory` object and returns a borrowed slice of its response items. Nothing is copied or changed; the caller simply gets a view of the saved history.

**Call relations**: This is the access point for any code that has been handed a `ConversationHistory` and wants to inspect the raw items. It does not call out to other project code; it simply exposes the stored snapshot safely.


##### `NoopTurnItemEmitter::emit_started`  (lines 73–75)

```
fn emit_started(&'a self, _item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Pretends to publish the start of a visible tool item, but intentionally does nothing. This is useful when the host does not support or does not want visible progress events.

**Data flow**: It receives an item that would normally be announced, ignores it, and returns a future that is already finished. The outside effect is that no event is sent and no state changes.

**Call relations**: Code that expects a `TurnItemEmitter` can call this just like a real emitter. Instead of forwarding the start event into the host event pipeline, this implementation immediately completes, allowing the rest of the tool flow to continue unchanged.

*Call graph*: 2 external calls (pin, ready).


##### `NoopTurnItemEmitter::emit_completed`  (lines 77–79)

```
fn emit_completed(&'a self, _item: ExtensionTurnItem) -> TurnItemEmissionFuture<'a>
```

**Purpose**: Pretends to publish the completion of a visible tool item, but intentionally does nothing. It provides a safe default when there is no real event pipeline attached.

**Data flow**: It receives the completed item, discards it, and returns a future that is already complete. No event is persisted, sent to a client, or otherwise acted on.

**Call relations**: Any tool code using the generic `TurnItemEmitter` interface may call this after finishing a visible item. With this no-op implementation, that call becomes harmless and immediate rather than requiring special-case checks elsewhere.

*Call graph*: 2 external calls (pin, ready).


##### `ToolCall::fmt`  (lines 96–108)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Builds a debugging view of a `ToolCall` that is useful but avoids printing the actual host emitter object. This helps developers inspect tool calls without exposing or depending on internals of the event emitter.

**Data flow**: It reads the fields of a `ToolCall` and writes a structured debug representation into the formatter. The turn item emitter is represented as a simple placeholder, and the environments are summarized by count rather than fully expanded.

**Call relations**: This is used automatically when Rust code formats a `ToolCall` with debug output. It hands the field-by-field display work to Rust’s debug formatting builder, while choosing carefully what information to include.

*Call graph*: 1 external calls (debug_struct).


##### `ToolCall::function_arguments`  (lines 112–120)

```
fn function_arguments(&self) -> Result<&str, FunctionCallError>
```

**Purpose**: Returns the raw argument string for tools that are invoked as function calls. If the tool was invoked with a different kind of payload, it reports a fatal error because the tool cannot safely interpret the data.

**Data flow**: It looks inside the `payload` field of the `ToolCall`. If the payload is a function payload, it returns a borrowed string of arguments; otherwise, it creates an error message naming the tool and returns that failure.

**Call relations**: Tool implementations can call this when they expect ordinary function-call arguments. This method acts as a guardrail before parsing or executing the request, and it hands back a `FunctionCallError::Fatal` when the surrounding dispatch has paired a tool with an incompatible payload.

*Call graph*: 2 external calls (format!, Fatal).


### `tools/src/tool_spec.rs`

`data_model` · `request construction`

This file is a translator between Codex’s idea of a “tool” and the format expected by the OpenAI Responses API. A tool is something the model may be allowed to use, such as calling a named function, searching the web, generating an image, or using a freeform custom interface. Without this file, the system would not have one clear place that says, “Here is what a valid API tool looks like.”

The main piece is the `ToolSpec` enum. An enum is a type that can be one of several named choices. Here, each choice matches a different API tool kind. The file also tells `serde`, the Rust serialization library, how to turn those choices into JSON, including the exact `type` names the API expects, such as `function`, `namespace`, `web_search`, and `custom`.

It also contains small adapter types for web search filters and user location. These copy configuration settings into the API-facing shape. Optional fields are skipped when they are not set, so the outgoing JSON stays clean instead of sending empty values.

The helper `create_tools_json_for_responses_api` takes a list of tool specs and serializes each one into a JSON value. In everyday terms, this file is like a packing checklist: it makes sure every tool is labeled and boxed in the way the remote API expects before the request is sent.

#### Function details

##### `ToolSpec::name`  (lines 54–63)

```
fn name(&self) -> &str
```

**Purpose**: Returns the public name of a tool so other code can identify it. For tools with their own names, such as functions or freeform tools, it returns that stored name; for built-in tool kinds like web search, it returns the fixed API name.

**Data flow**: It starts with one `ToolSpec` value. It checks which kind of tool it is, then either reads the name field from that tool or supplies a built-in string such as `web_search`. The result is a borrowed text name, and the tool itself is not changed.

**Call relations**: When `spec_for_model_request` is preparing a model request, it calls this method to ask each tool what it should be called. This lets the request-building code treat many tool kinds uniformly without needing to know every detail of their internal shape.

*Call graph*: called by 1 (spec_for_model_request).


##### `ToolSpec::from`  (lines 67–72)

```
fn from(value: LoadableToolSpec) -> Self
```

**Purpose**: Converts a smaller, loadable tool definition into the fuller `ToolSpec` type used for API requests. It is used when a tool has been loaded from configuration or another source and needs to join the common tool list.

**Data flow**: It receives a `LoadableToolSpec`, which can currently be either a function tool or a namespace tool. It looks at which one it received and wraps the same inner data in the matching `ToolSpec` variant. The output is a `ToolSpec` ready to be serialized or inspected with the rest of the tools.

**Call relations**: This conversion sits at the boundary between loading tools and sending tools. It hands function and namespace definitions into the shared `ToolSpec` form, using the corresponding `Function` or `Namespace` variant so later code can treat them as normal Responses API tools.

*Call graph*: 2 external calls (Function, Namespace).


##### `create_tools_json_for_responses_api`  (lines 78–89)

```
fn create_tools_json_for_responses_api(
    tools: &[ToolSpec],
) -> Result<Vec<Value>, serde_json::Error>
```

**Purpose**: Turns a list of `ToolSpec` values into JSON values that can be placed into a Responses API request. This is the final packaging step before tools are sent over the wire.

**Data flow**: It receives a slice of tool specifications. It creates an empty output list, then serializes each tool into a JSON value using `serde_json`. If every tool can be serialized, it returns the full list; if serialization fails for any tool, it returns that error instead.

**Call relations**: Code that is building a Responses API request calls this when it already knows which tools should be offered to the model. This function does not decide which tools are allowed; it simply converts the chosen `ToolSpec` values into the JSON form the API expects.

*Call graph*: 2 external calls (new, to_value).


##### `ResponsesApiWebSearchFilters::from`  (lines 98–102)

```
fn from(filters: ConfigWebSearchFilters) -> Self
```

**Purpose**: Converts web search filter settings from the project’s configuration format into the format used in a Responses API tool definition. At present, this mainly carries across the allowed web domains.

**Data flow**: It receives configured web search filters. It takes the optional list of allowed domains from that configuration and places it into a new API-facing filter object. The result is ready to be included inside a `web_search` tool spec.

**Call relations**: This function is used when configured web search limits need to become part of the outgoing API tool description. It forms a small bridge from general configuration types into the serialized Responses API data model.


##### `ResponsesApiWebSearchUserLocation::from`  (lines 120–128)

```
fn from(user_location: ConfigWebSearchUserLocation) -> Self
```

**Purpose**: Converts a configured user location into the Responses API shape used for web search. This lets web search requests include location hints such as country, city, or timezone when those are configured.

**Data flow**: It receives a configuration user-location object. It copies over the location type and any optional country, region, city, and timezone fields into a new API-facing object. The output can then be attached to a `web_search` tool spec, while missing fields remain absent from the final JSON.

**Call relations**: This function is part of preparing web search tools for a model request. It takes location information from configuration and hands it forward in the exact structure that the Responses API serialization code knows how to emit.


### `core/src/tools/context.rs`

`io_transport` · `request handling, after a tool finishes and before its result is logged or returned`

When Codex runs a tool, the result may be a shell command output, a patch result, a list of available tools, an external MCP tool response, or an abort message. This file is the adapter layer that makes all of those different results look consistent. It is like a packaging station: each tool drops off its raw output, and this file wraps it with labels such as wall time, success, call ID, and output text before sending it onward.

A key job here is limiting how much text is shown. Tool output can be huge, so the file trims previews for telemetry logs and truncates command or MCP output before it is injected back into the model conversation. That prevents logs and model context from being flooded.

The file also preserves different views of the same result. The model may receive a formatted function-call output. Code mode may receive structured JSON. Post-tool hooks may receive either the original input or a compact response. Several output structs implement the shared `ToolOutput` behavior so the rest of the system can treat them uniformly even though each tool type needs slightly different packaging.

#### Function details

##### `boxed_tool_output`  (lines 31–36)

```
fn boxed_tool_output(output: T) -> Box<dyn ToolOutput>
```

**Purpose**: Wraps any concrete tool result in a shared `ToolOutput` box so callers can store and pass around different kinds of tool outputs through one common interface.

**Data flow**: It receives a specific output value, such as a command result or patch result. It places that value behind a boxed trait object, which is Rust's way of saying, "treat this as any tool output." The returned box can then be used without knowing the exact output type.

**Call relations**: Tool handlers call this after they finish creating a specific result. It hands the result back in the common form expected by the rest of the tool pipeline.

*Call graph*: called by 19 (handle_call, handle_call, handle, handle_call, handle_call, handle_call, handle_call, handle_call, handle, handle_call (+9 more)); 1 external calls (new).


##### `McpToolOutput::log_preview`  (lines 75–82)

```
fn log_preview(&self) -> String
```

**Purpose**: Builds a short, safe preview of an MCP tool result for telemetry logs. MCP means Model Context Protocol, a standard way for external tools to talk to the system.

**Data flow**: It starts from the MCP result, turns it into the same payload that would be shown to the model, extracts readable text when possible, and falls back to JSON if needed. It then cuts that text down to a telemetry-sized preview.

**Call relations**: The logging path asks this method for a compact summary. It uses `McpToolOutput::response_payload` for the model-shaped content and then passes the text to `telemetry_preview` so logs stay small.

*Call graph*: calls 2 internal fn (response_payload, telemetry_preview).


##### `McpToolOutput::success_for_logging`  (lines 84–86)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports whether the MCP tool succeeded, specifically for logging and telemetry.

**Data flow**: It reads the stored MCP result and asks it whether it represents success. It returns that yes-or-no answer without changing anything.

**Call relations**: The shared tool-output logging flow calls this when it needs to record success status for an MCP tool result.

*Call graph*: 1 external calls (success).


##### `McpToolOutput::to_response_item`  (lines 88–93)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns an MCP tool result into a response item that can be inserted back into the model conversation.

**Data flow**: It receives the tool call ID, builds a formatted and possibly truncated payload from the MCP result, and returns a function-call output item tied to that call ID.

**Call relations**: After an MCP tool finishes, the broader tool pipeline calls this to produce the item that the model will see. It relies on `McpToolOutput::response_payload` to prepare the actual content.

*Call graph*: calls 1 internal fn (response_payload).


##### `McpToolOutput::code_mode_result`  (lines 95–99)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Provides the MCP result in JSON form for code mode consumers, which prefer structured data over a formatted conversation message.

**Data flow**: It reads the stored MCP result and tries to serialize it to JSON. If serialization fails, it returns a JSON string explaining the failure.

**Call relations**: Code mode calls this when it needs the raw-ish MCP result rather than the model-facing response payload.

*Call graph*: 1 external calls (to_value).


##### `McpToolOutput::post_tool_use_input`  (lines 101–103)

```
fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Returns the original input that was sent to the MCP tool, so post-tool hooks can inspect what was requested.

**Data flow**: It reads the saved `tool_input`, clones it, and returns it as optional JSON. The stored input remains unchanged.

**Call relations**: The post-tool-use flow asks this method for the input side of an MCP call, usually for auditing, hooks, or follow-up processing.

*Call graph*: 1 external calls (clone).


##### `McpToolOutput::post_tool_use_response`  (lines 105–107)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Returns the MCP result as JSON for post-tool hooks.

**Data flow**: It reads the MCP result and attempts to serialize it into JSON. If that works, the JSON is returned; if not, there is no response value.

**Call relations**: After an MCP tool runs, post-tool-use handling calls this to capture the response side of the tool interaction.

*Call graph*: 1 external calls (to_value).


##### `McpToolOutput::response_payload`  (lines 111–140)

```
fn response_payload(&self) -> FunctionCallOutputPayload
```

**Purpose**: Builds the model-facing payload for an MCP tool result, including wall time, output content, image-detail cleanup, and truncation.

**Data flow**: It starts with the raw MCP result, converts it to a function-call output payload, removes unsupported original-image detail when necessary, adds a header with elapsed time, and truncates the payload to fit the configured budget. The result is a safe payload ready for conversation context.

**Call relations**: `McpToolOutput::log_preview` and `McpToolOutput::to_response_item` both use this because they need the same model-shaped version of the MCP output.

*Call graph*: called by 2 (log_preview, to_response_item); 5 external calls (as_secs_f64, truncate_function_output_payload, sanitize_original_image_detail, format!, as_function_call_output_payload).


##### `ToolSearchOutput::log_preview`  (lines 149–160)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short telemetry preview of the tools returned by a tool search.

**Data flow**: It serializes each found tool specification to JSON, places them in a JSON array, turns that into text, and trims it to the telemetry preview limit.

**Call relations**: The logging flow calls this after a tool search completes, so logs can show what was found without storing an unbounded amount of data.

*Call graph*: calls 1 internal fn (telemetry_preview); 1 external calls (Array).


##### `ToolSearchOutput::success_for_logging`  (lines 162–164)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks tool search output as successful for logging.

**Data flow**: It does not need to inspect any fields. It simply returns `true`, meaning a produced search result is considered a successful output.

**Call relations**: The shared logging path calls this when recording the status of a tool search result.


##### `ToolSearchOutput::to_response_item`  (lines 166–181)

```
fn to_response_item(&self, call_id: &str, _payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns found tool descriptions into a response item the model can receive as the result of a tool search.

**Data flow**: It receives the call ID, serializes each discovered tool into JSON, and returns a tool-search output item marked as completed and run on the client.

**Call relations**: The tool pipeline calls this after tool search finishes so the model can see the available tool specifications.


##### `FunctionToolOutput::from_text`  (lines 191–197)

```
fn from_text(text: String, success: Option<bool>) -> Self
```

**Purpose**: Creates a generic function-tool result from plain text.

**Data flow**: It receives text and an optional success flag. It wraps the text as a single content item and stores the success value, leaving post-tool response empty.

**Call relations**: Many tool handlers and tests use this as the simplest way to create a standard function-style tool result before it is converted to a response item.

*Call graph*: called by 25 (custom_tool_calls_should_roundtrip_as_custom_outputs, function_payloads_remain_function_outputs, handle, handle, intercept_apply_patch, to_response_item, handle_call, serialize_function_output, tool_output_response_item, handle_message_string_tool (+15 more)); 1 external calls (vec!).


##### `FunctionToolOutput::from_content`  (lines 199–208)

```
fn from_content(
        content: Vec<FunctionCallOutputContentItem>,
        success: Option<bool>,
    ) -> Self
```

**Purpose**: Creates a generic function-tool result from richer content items instead of plain text.

**Data flow**: It receives a list of content items and an optional success flag. It stores them directly and leaves post-tool response empty.

**Call relations**: Runtime responses and content-focused tool paths use this when the output is not just one plain text string.

*Call graph*: called by 4 (handle_runtime_response, custom_tool_calls_can_derive_text_from_content_items, log_preview_uses_content_items_when_plain_text_is_missing, handle_call).


##### `FunctionToolOutput::into_text`  (lines 210–212)

```
fn into_text(self) -> String
```

**Purpose**: Converts a generic function-tool output into plain text when a caller needs a string version.

**Data flow**: It consumes the output, reads its content items, and tries to join or extract them as text. If that cannot produce text, it returns an empty string.

**Call relations**: Callers use this when they need to collapse structured function output into a simple string, such as for compatibility or testing.

*Call graph*: calls 1 internal fn (function_call_output_content_items_to_text).


##### `FunctionToolOutput::log_preview`  (lines 216–220)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short telemetry preview for a generic function-tool output.

**Data flow**: It converts the stored content items to text, falls back to an empty string if needed, and then trims the result to the telemetry preview size.

**Call relations**: The shared logging path calls this for ordinary function-tool outputs. It delegates the final trimming to `telemetry_preview`.

*Call graph*: calls 2 internal fn (telemetry_preview, function_call_output_content_items_to_text).


##### `FunctionToolOutput::success_for_logging`  (lines 222–224)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Reports whether a generic function-tool output should be logged as successful.

**Data flow**: It reads the optional success flag. If the flag is present, it returns that value; if it is missing, it treats the output as successful.

**Call relations**: The logging flow calls this when recording the status of standard function-tool outputs.


##### `FunctionToolOutput::to_response_item`  (lines 226–228)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns a generic function-tool output into the protocol item that goes back into the conversation.

**Data flow**: It receives the call ID and original tool payload, clones the stored content, keeps the success flag, and passes everything to the shared response-building helper.

**Call relations**: The tool pipeline calls this after a function-like tool completes. It hands the details to `function_tool_response`, which chooses the exact response shape.

*Call graph*: calls 1 internal fn (function_tool_response); called by 1 (to_response_item).


##### `FunctionToolOutput::post_tool_use_response`  (lines 230–232)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Returns any extra JSON response saved for post-tool hooks.

**Data flow**: It reads the optional stored post-tool response, clones it, and returns it. Nothing else is changed.

**Call relations**: Post-tool-use handling calls this when it wants an additional structured response from a generic function tool.


##### `ApplyPatchToolOutput::from_text`  (lines 240–242)

```
fn from_text(text: String) -> Self
```

**Purpose**: Creates an apply-patch result from plain text.

**Data flow**: It receives the patch result text and stores it in a new `ApplyPatchToolOutput` value.

**Call relations**: Patch handling calls this after applying or preparing a patch result, so the result can move through the common tool-output pipeline.

*Call graph*: called by 2 (handle_call, post_tool_use_payload_uses_patch_input_and_tool_output).


##### `ApplyPatchToolOutput::log_preview`  (lines 246–248)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short telemetry preview of an apply-patch result.

**Data flow**: It reads the stored patch text and trims it to the telemetry preview limit.

**Call relations**: The logging path calls this after patch tool output is produced. It relies on `telemetry_preview` to keep logs compact.

*Call graph*: calls 1 internal fn (telemetry_preview).


##### `ApplyPatchToolOutput::success_for_logging`  (lines 250–252)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks apply-patch output as successful for logging.

**Data flow**: It returns `true` without inspecting the text. The output type represents a completed patch response.

**Call relations**: The shared logging flow calls this when recording patch tool status.


##### `ApplyPatchToolOutput::to_response_item`  (lines 254–263)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns apply-patch text into the model-facing response item for the original tool call.

**Data flow**: It receives the call ID and payload, wraps the patch text as an input-text content item, marks success as true, and passes the result to the shared response builder.

**Call relations**: After patch handling completes, the tool pipeline calls this. It uses `function_tool_response` so patch output follows the same response format as other function-like tools.

*Call graph*: calls 1 internal fn (function_tool_response); 1 external calls (vec!).


##### `ApplyPatchToolOutput::post_tool_use_response`  (lines 265–267)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Returns the patch result text for post-tool hooks.

**Data flow**: It clones the stored text and returns it as a JSON string.

**Call relations**: Post-tool-use handling calls this when it wants to report what the patch tool produced.

*Call graph*: 1 external calls (String).


##### `ApplyPatchToolOutput::code_mode_result`  (lines 269–271)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Returns an empty JSON object for code mode after an apply-patch operation.

**Data flow**: It ignores the stored text and creates an empty JSON object. The patch result is therefore acknowledged without sending extra structured data.

**Call relations**: Code mode calls this when it needs a JSON result for apply-patch output, even though this tool does not expose detailed code-mode data here.

*Call graph*: 2 external calls (Object, new).


##### `AbortedToolOutput::log_preview`  (lines 279–281)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short telemetry preview of a tool-aborted message.

**Data flow**: It reads the stored abort message and trims it to the telemetry preview size.

**Call relations**: The logging flow calls this when a tool was stopped or could not run and needs a compact explanation in logs.

*Call graph*: calls 1 internal fn (telemetry_preview).


##### `AbortedToolOutput::success_for_logging`  (lines 283–285)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks an aborted tool as unsuccessful for logging.

**Data flow**: It always returns `false`, because this output means the intended tool work did not complete.

**Call relations**: The shared logging path calls this when recording the result status for an aborted tool call.


##### `AbortedToolOutput::to_response_item`  (lines 287–304)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns an aborted tool result into the right kind of response item for the model.

**Data flow**: It receives the call ID and original payload. If the aborted call was a tool search, it returns an empty completed tool-search result; otherwise, it returns a function-style output containing the abort message.

**Call relations**: The tool pipeline calls this when a tool call is cancelled or blocked. It uses `function_tool_response` for ordinary tool calls but handles tool search specially so the response matches the expected protocol shape.

*Call graph*: calls 1 internal fn (function_tool_response); 2 external calls (new, vec!).


##### `ExecCommandToolOutput::log_preview`  (lines 323–325)

```
fn log_preview(&self) -> String
```

**Purpose**: Creates a short telemetry preview of command execution output.

**Data flow**: It first builds the full model-facing command response text, including timing and output, then trims that text for telemetry logs.

**Call relations**: The logging flow calls this after a command tool returns output. It uses `ExecCommandToolOutput::response_text` for consistent formatting and `telemetry_preview` for safe log size.

*Call graph*: calls 2 internal fn (response_text, telemetry_preview).


##### `ExecCommandToolOutput::success_for_logging`  (lines 327–329)

```
fn success_for_logging(&self) -> bool
```

**Purpose**: Marks command output as successful for logging at this layer.

**Data flow**: It returns `true` without checking the process exit code. The exit code is still included in the text, but this method treats the production of command output itself as successful.

**Call relations**: The shared logging path calls this when recording command tool output status.


##### `ExecCommandToolOutput::to_response_item`  (lines 331–340)

```
fn to_response_item(&self, call_id: &str, payload: &ToolPayload) -> ResponseInputItem
```

**Purpose**: Turns command execution output into the model-facing response item.

**Data flow**: It receives the call ID and payload, builds formatted command response text, wraps it as a text content item, marks success as true, and passes it to the shared response builder.

**Call relations**: After a command completes or yields a chunk, the tool pipeline calls this so the model can see timing, status, and truncated output.

*Call graph*: calls 1 internal fn (function_tool_response); 1 external calls (vec!).


##### `ExecCommandToolOutput::post_tool_use_id`  (lines 342–348)

```
fn post_tool_use_id(&self, call_id: &str) -> String
```

**Purpose**: Chooses the identifier to use for post-tool-use reporting of a command result.

**Data flow**: It checks whether the command output has its own event call ID. If so, it returns that; otherwise, it returns the original call ID supplied by the caller.

**Call relations**: Post-tool-use handling calls this when command output may need to be associated with a different event-level identifier.


##### `ExecCommandToolOutput::post_tool_use_input`  (lines 350–354)

```
fn post_tool_use_input(&self, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Provides the command text to post-tool hooks when this output came from a hook command.

**Data flow**: It checks whether `hook_command` is present. If it is, it returns JSON like `{ "command": ... }`; if not, it returns nothing.

**Call relations**: The post-tool-use flow calls this for command outputs so hook executions can report what command was run.


##### `ExecCommandToolOutput::post_tool_use_response`  (lines 356–364)

```
fn post_tool_use_response(&self, _call_id: &str, _payload: &ToolPayload) -> Option<JsonValue>
```

**Purpose**: Provides a compact command output string for post-tool hooks in the special case of completed hook commands.

**Data flow**: It first skips responses for still-running processes or non-hook commands. For a completed hook command, it computes the allowed model output size, truncates the raw output, and returns it as a JSON string.

**Call relations**: Post-tool-use handling calls this after command execution. It uses `ExecCommandToolOutput::model_output_max_tokens` and `ExecCommandToolOutput::truncated_output` to avoid sending oversized hook output.

*Call graph*: calls 2 internal fn (model_output_max_tokens, truncated_output); 1 external calls (String).


##### `ExecCommandToolOutput::code_mode_result`  (lines 366–396)

```
fn code_mode_result(&self, _payload: &ToolPayload) -> JsonValue
```

**Purpose**: Builds the structured JSON result that code mode receives after command execution.

**Data flow**: It gathers command metadata such as chunk ID, wall time, exit code, session ID for a running process, original token count, and output text. If a maximum output size is set, it truncates the output; otherwise, it decodes all raw bytes as text. It then serializes the whole result to JSON.

**Call relations**: Code mode calls this instead of using the model-facing text response, because code mode can consume fields like `exit_code` and `session_id` directly.

*Call graph*: calls 1 internal fn (truncated_output); 3 external calls (as_secs_f64, from_utf8_lossy, to_value).


##### `ExecCommandToolOutput::model_output_max_tokens`  (lines 400–402)

```
fn model_output_max_tokens(&self) -> usize
```

**Purpose**: Calculates how many output tokens may be shown to the model for a command result.

**Data flow**: It starts with the command's optional maximum-output setting, resolves it to an actual limit, and then caps that limit by the broader truncation policy's token budget.

**Call relations**: `ExecCommandToolOutput::response_text` and `ExecCommandToolOutput::post_tool_use_response` call this before truncating command output, so both paths respect the same size rules.

*Call graph*: calls 2 internal fn (resolve_max_tokens, token_budget); called by 2 (post_tool_use_response, response_text).


##### `ExecCommandToolOutput::truncated_output`  (lines 404–407)

```
fn truncated_output(&self, max_tokens: usize) -> String
```

**Purpose**: Turns raw command output bytes into readable text and cuts it to a requested token limit.

**Data flow**: It decodes the raw bytes as UTF-8 text, using replacement characters if the bytes are not valid text. It then applies formatted token-based truncation and returns the shortened string.

**Call relations**: Command response formatting, code mode output, and post-tool hook output all call this when they need command output that will not exceed a chosen size.

*Call graph*: called by 3 (code_mode_result, post_tool_use_response, response_text); 3 external calls (from_utf8_lossy, formatted_truncate_text, Tokens).


##### `ExecCommandToolOutput::response_text`  (lines 409–435)

```
fn response_text(&self) -> String
```

**Purpose**: Builds the human-readable command result text that goes back to the model.

**Data flow**: It collects sections such as chunk ID, wall time, exit code, running process session ID, original token count, and an `Output:` label. It then appends truncated command output and joins all sections with newlines.

**Call relations**: `ExecCommandToolOutput::log_preview` and `ExecCommandToolOutput::to_response_item` use this formatted text so logs and model responses describe command results consistently.

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

**Purpose**: Creates the correct protocol response item for function-like tool output.

**Data flow**: It receives a call ID, the original tool payload, content items, and an optional success flag. If the body is just one text item, it stores it as plain text; otherwise, it stores the full content list. For custom tools, it returns a custom-tool output item; for normal tools, it returns a standard function-call output item.

**Call relations**: Several `to_response_item` methods call this helper so they do not each have to duplicate the rules for standard versus custom tool responses.

*Call graph*: called by 4 (to_response_item, to_response_item, to_response_item, to_response_item); 3 external calls (matches!, ContentItems, Text).


##### `telemetry_preview`  (lines 465–503)

```
fn telemetry_preview(content: &str) -> String
```

**Purpose**: Creates a bounded preview string for telemetry so logs stay useful but do not become huge.

**Data flow**: It receives arbitrary text, cuts it at a safe byte boundary so it does not split a character, then keeps only a limited number of lines. If anything was removed, it appends a truncation notice.

**Call relations**: All the output-specific `log_preview` methods call this. It is the shared safety valve that keeps command, patch, MCP, tool-search, function, and abort logs within fixed limits.

*Call graph*: called by 6 (log_preview, log_preview, log_preview, log_preview, log_preview, log_preview); 2 external calls (new, take_bytes_at_char_boundary).


### `core/src/tools/code_mode/response_adapter.rs`

`io_transport` · `request handling`

This file is a small adapter, like a plug converter between two devices that speak almost the same language but use different socket shapes. The code-mode tool has its own types for function-call output content, such as text and images. The broader Codex protocol has matching types that other parts of the system expect. This file converts from the code-mode versions into the protocol versions.

The main public helper takes a list of code-mode output items and converts each item one by one. Text is passed through unchanged. Images keep their URL, and their image detail setting is translated from the code-mode enum into the protocol enum. If an image does not say what level of detail it wants, the adapter fills in the protocol’s default image detail. That defaulting is important because downstream code can then rely on a clear value instead of having to guess.

The private `IntoProtocol` trait gives the file a simple shared pattern for these conversions. It is not a general system-wide feature; it is a local tool that keeps the conversion code tidy and consistent.

#### Function details

##### `into_function_call_output_content_items`  (lines 10–14)

```
fn into_function_call_output_content_items(
    items: Vec<codex_code_mode::FunctionCallOutputContentItem>,
) -> Vec<FunctionCallOutputContentItem>
```

**Purpose**: Converts a whole list of code-mode function-call output items into the protocol format used outside the code-mode tool. Someone uses this when a runtime response from code mode needs to be sent on through the normal system pipeline.

**Data flow**: It receives a vector of code-mode content items. It walks through the vector, converts each item into its protocol version, and collects the converted items into a new vector. The original code-mode items are consumed, and the result is a protocol-ready list.

**Call relations**: When `handle_runtime_response` receives output from the code-mode runtime, it calls this function to make that output understandable to the rest of the protocol layer. This function then relies on `FunctionCallOutputContentItem::into_protocol` for the item-by-item conversion.

*Call graph*: called by 1 (handle_runtime_response).


##### `CodeModeImageDetail::into_protocol`  (lines 17–25)

```
fn into_protocol(self) -> ImageDetail
```

**Purpose**: Converts an image detail choice from the code-mode type into the matching protocol type. This matters because image detail values must be expressed in the protocol’s vocabulary before they can travel farther through the system.

**Data flow**: It receives one code-mode image detail value, such as automatic, low, high, or original. It matches that value to the equivalent protocol value and returns it. Nothing else is changed.

**Call relations**: This conversion is used when an image output item includes an explicit detail setting. In that larger flow, `FunctionCallOutputContentItem::into_protocol` calls on this function so the image item can be fully converted into protocol form.


##### `FunctionCallOutputContentItem::into_protocol`  (lines 31–46)

```
fn into_protocol(self) -> FunctionCallOutputContentItem
```

**Purpose**: Converts one code-mode output item into one protocol output item. It supports both text and image content, preserving the useful information while changing it into the type expected downstream.

**Data flow**: It receives a single code-mode content item. If the item is text, it copies the text into the protocol text shape. If the item is an image, it keeps the image URL, converts the optional detail value when present, and otherwise supplies the default image detail. It returns the finished protocol content item.

**Call relations**: This function is the per-item worker used by `into_function_call_output_content_items`. In the image case, it hands the detail value to `CodeModeImageDetail::into_protocol` so that nested image settings are converted as well.


### Built-in tool schemas
These files declare the model-facing schemas and naming conventions for built-in tools and hook-related compatibility surfaces.

### `core/src/tools/handlers/get_context_remaining_spec.rs`

`config` · `tool registration`

This file is like the label and instruction card for a tool. It does not calculate the remaining token count itself. Instead, it tells the tool system that a tool named `get_context_remaining` exists, what it is for, what inputs it accepts, and what kind of answer it will return.

The problem it solves is consistency. Tools are often called by an outside API or model, so both sides need a clear contract. Here, the contract says: this tool takes no input fields, and its answer must be an object with one field called `tokens_left`. That field is either an integer, when the system knows the remaining token count, or `null`, when that information is not available.

The main function builds a `ToolSpec`, which is the system’s standard description of a callable tool. It includes a short human-readable description, an empty parameter schema, and an output schema. The helper function builds that output schema using JSON. Without this file, the tool could not be cleanly registered or described to callers, and callers would not know what response shape to expect.

#### Function details

##### `create_get_context_remaining_tool`  (lines 10–19)

```
fn create_get_context_remaining_tool() -> ToolSpec
```

**Purpose**: Creates the formal description of the `get_context_remaining` tool. Other parts of the system use this description to register or expose the tool safely and predictably.

**Data flow**: It starts with no caller-provided input. It fills in the tool name, a short description, an empty input schema meaning the tool expects no arguments, and an output schema produced by `get_context_remaining_output_schema`. It returns a `ToolSpec` that can be handed to the tool registration system.

**Call relations**: This function is called by `spec` when the system is collecting tool definitions. During that setup, it asks `get_context_remaining_output_schema` for the exact response shape, then wraps everything into the standard external `Function` tool form.

*Call graph*: calls 2 internal fn (get_context_remaining_output_schema, object); called by 1 (spec); 2 external calls (new, Function).


##### `get_context_remaining_output_schema`  (lines 21–36)

```
fn get_context_remaining_output_schema() -> Value
```

**Purpose**: Builds the JSON schema that describes what the tool returns. It makes clear that every response contains `tokens_left`, and that the value may be either a number or `null` if unavailable.

**Data flow**: It takes no input. It constructs a JSON object describing the allowed output fields and rules: one required field named `tokens_left`, no extra fields, and a value that can be an integer or null. It returns that JSON schema value to its caller.

**Call relations**: This helper is used by `create_get_context_remaining_tool` while building the full tool specification. It supplies the output contract so callers know how to read the result of the tool.

*Call graph*: called by 1 (create_get_context_remaining_tool); 1 external calls (json!).


### `core/src/tools/handlers/request_user_input_spec.rs`

`domain_logic` · `tool registration and request handling`

This file is the rulebook for a tool that lets the assistant pause and ask the user for guidance. Without it, the assistant could send vague or malformed questions, ask for input in modes where that is not allowed, or wait too long or too briefly for an optional answer.

The main job is to describe the tool in a machine-readable way. It builds a JSON schema, which is like a form template: every question needs an id, a short header, the question text, and a list of answer options. The schema also explains that the client will add its own free-form “Other” choice, so the model should not include one itself.

The file also sets clear time limits for optional automatic resolution: one to four minutes. If the caller asks for a value outside that range, the code clamps it back inside the allowed window and records a warning.

There is also mode checking. Some product modes may allow user questions and others may not. This file can produce a clear message when the tool is unavailable. In short, it keeps user-interruption polite, bounded, and compatible with the current mode.

#### Function details

##### `create_request_user_input_tool`  (lines 12–92)

```
fn create_request_user_input_tool(description: String) -> ToolSpec
```

**Purpose**: Builds the official tool definition for `request_user_input`. This tells the model and API what fields are expected when asking the user questions, including the required shape of questions and answer options.

**Data flow**: It takes a human-readable tool description as input. It builds nested JSON schema objects for answer options, questions, and the optional auto-resolution timeout. It returns a `ToolSpec` that names the tool, attaches the description, and describes the allowed input structure.

**Call relations**: This is used when the broader tool registry asks for the tool's specification. It prepares the contract that later calls must follow, so request handling can rely on the incoming data having the intended shape.

*Call graph*: calls 4 internal fn (array, number, object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `request_user_input_unavailable_message`  (lines 94–106)

```
fn request_user_input_unavailable_message(
    mode: ModeKind,
    available_modes: &[ModeKind],
) -> Option<String>
```

**Purpose**: Checks whether the current mode is allowed to use `request_user_input`. If not, it creates a plain error message explaining that the tool is unavailable in that mode.

**Data flow**: It receives the current mode and a list of modes where the tool is allowed. If the current mode is in that list, it returns nothing, meaning there is no problem. If the mode is missing, it reads the mode's display name and returns a message such as saying the tool is unavailable in that mode.

**Call relations**: This is called during tool-call handling before the system proceeds with asking the user. It acts like a gatekeeper: allowed modes pass through, while disallowed modes get a clear message instead of attempting the user prompt.

*Call graph*: calls 1 internal fn (display_name); called by 1 (handle_call); 2 external calls (format!, contains).


##### `normalize_request_user_input_args`  (lines 108–137)

```
fn normalize_request_user_input_args(
    mut args: RequestUserInputArgs,
) -> Result<RequestUserInputArgs, String>
```

**Purpose**: Validates and tidies the arguments for a user-input request. It makes sure every question has answer options, marks questions so the client can include an “Other” path, and keeps the optional timeout within the supported range.

**Data flow**: It receives parsed request arguments. First it checks every question for a non-empty options list; if any question has none, it returns an error message. Then it marks each question as allowing the client-provided “Other” option. Finally, if an auto-resolution timeout was provided, it clamps that number between the minimum and maximum allowed values and logs a warning if it had to change it. The result is either cleaned-up arguments or an error string.

**Call relations**: This is called while handling an actual `request_user_input` call. It sits between raw model-provided input and the user-facing prompt flow, making sure later code does not have to deal with missing options or unsupported timeout values.

*Call graph*: called by 1 (handle_call); 1 external calls (warn!).


##### `request_user_input_tool_description`  (lines 139–144)

```
fn request_user_input_tool_description(available_modes: &[ModeKind]) -> String
```

**Purpose**: Creates the text description shown for the `request_user_input` tool. The description tells the model when to use the tool, how long optional waiting may last, and which modes support it.

**Data flow**: It receives the list of modes where the tool is available. It turns that list into readable wording, then inserts that wording and the timeout limits into a full sentence-style description. It returns the finished description string.

**Call relations**: This is used when building the tool specification. It relies on `format_allowed_modes` for the readable mode list, then hands the completed description to the code that publishes the tool contract.

*Call graph*: calls 1 internal fn (format_allowed_modes); called by 1 (spec); 1 external calls (format!).


##### `format_allowed_modes`  (lines 146–158)

```
fn format_allowed_modes(available_modes: &[ModeKind]) -> String
```

**Purpose**: Turns a list of allowed modes into a short phrase that reads naturally in the tool description. This avoids awkward wording when there are zero, one, two, or many modes.

**Data flow**: It receives a list of mode values. It reads each mode's display name, then chooses wording based on how many names there are: no modes, one mode, two alternatives, or a longer comma-joined list. It returns that phrase as text.

**Call relations**: This is a helper used only by `request_user_input_tool_description`. It supplies the small piece of readable language that lets the final tool description tell users and models where the tool is available.

*Call graph*: called by 1 (request_user_input_tool_description); 2 external calls (format!, iter).


### `core/src/tools/handlers/shell_spec.rs`

`config` · `tool registration before model/tool use`

This file is like a menu card for command-line tools. Before a model can call a tool safely, the system needs to tell it what the tool is named, what fields it may send, which fields are required, and what kind of answer will come back. This file builds those descriptions using JSON Schema, which is a machine-readable way to say “this input should be a string,” “this field is optional,” and so on.

The main tools described here are `exec_command`, for running a command in a more interactive terminal-like session; `write_stdin`, for sending more text to a still-running command; `shell_command`, a simpler one-shot command tool; and `request_permissions`, which lets the assistant ask the user for extra file or network access.

A key theme is safety. The file adds permission-related fields when the system supports them, such as asking for unsandboxed execution or limited extra access. A sandbox is a restricted environment that limits what a command can touch. The file also gives extra Windows guidance, because mixing Windows shells can make file operations risky.

Without this file, the model would not have a clear contract for these shell tools. It might send the wrong arguments, misunderstand permission rules, or fail to interpret command output correctly.

#### Function details

##### `create_exec_command_tool`  (lines 15–19)

```
fn create_exec_command_tool(options: CommandToolOptions) -> ToolSpec
```

**Purpose**: This test-only helper creates the standard `exec_command` tool description. It uses the normal defaults expected by tests, without exposing an environment selector but with the shell parameter included.

**Data flow**: It takes `CommandToolOptions`, which say whether login shells and permission approvals are allowed. It passes those options plus fixed choices into `create_exec_command_tool_with_environment_id`, then returns the completed tool specification.

**Call relations**: Tests call this as a convenient shortcut. It immediately hands the real work to `create_exec_command_tool_with_environment_id`, so the test path stays aligned with the production builder.

*Call graph*: calls 1 internal fn (create_exec_command_tool_with_environment_id).


##### `create_exec_command_tool_with_environment_id`  (lines 21–108)

```
fn create_exec_command_tool_with_environment_id(
    options: CommandToolOptions,
    include_environment_id: bool,
    include_shell_parameter: bool,
) -> ToolSpec
```

**Purpose**: This builds the full description for the `exec_command` tool, which runs a command and may keep it alive as an interactive session. It defines what arguments the model may provide and what output shape it should expect back.

**Data flow**: It starts with common input fields such as the command text, working directory, terminal mode, wait time, and output size limit. Depending on the options, it adds fields for choosing a shell, using a login shell, selecting an environment, and asking for permission changes. It then wraps all of that into a `ToolSpec` with an output schema for command results.

**Call relations**: This is called by the test helper `create_exec_command_tool` and by the broader tool-spec building flow named `spec`. While building the tool, it asks `create_approval_parameters` for safety-related fields and `unified_exec_output_schema` for the standard command-output format.

*Call graph*: calls 6 internal fn (create_approval_parameters, unified_exec_output_schema, boolean, number, object, string); called by 2 (create_exec_command_tool, spec); 5 external calls (from, cfg!, format!, Function, vec!).


##### `create_write_stdin_tool`  (lines 110–152)

```
fn create_write_stdin_tool() -> ToolSpec
```

**Purpose**: This builds the description for `write_stdin`, the tool used to send more input to a command that is already running. It is needed for interactive programs, such as prompts or long-running sessions.

**Data flow**: It defines inputs for the existing session number, the characters to write, how long to wait for new output, and how much output to return. It then returns a tool specification whose output uses the same command-output shape as `exec_command`.

**Call relations**: The broader `spec` flow calls this when registering available tools. It relies on `unified_exec_output_schema` so that continuing a session reports output in the same format as starting one.

*Call graph*: calls 4 internal fn (unified_exec_output_schema, number, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `create_shell_command_tool`  (lines 154–222)

```
fn create_shell_command_tool(options: CommandToolOptions) -> ToolSpec
```

**Purpose**: This builds the description for `shell_command`, a simpler tool for running one shell command and getting its output. It also includes instructions that steer the model toward safer and clearer command usage.

**Data flow**: It takes command-tool options, creates fields for the command text, working directory, and timeout, and optionally adds a login-shell choice. It also adds permission-related fields. Finally, it returns a tool specification with a description tailored for Windows or non-Windows systems.

**Call relations**: The broader `spec` flow calls this when exposing the one-shot shell command tool. It uses `create_approval_parameters` to attach the same permission-request choices used by `exec_command`; on Windows it also pulls in `windows_shell_guidance` through the formatted description.

*Call graph*: calls 5 internal fn (create_approval_parameters, boolean, number, object, string); called by 1 (spec); 5 external calls (from, cfg!, format!, Function, vec!).


##### `create_request_permissions_tool`  (lines 224–254)

```
fn create_request_permissions_tool(description: String) -> ToolSpec
```

**Purpose**: This builds the description for `request_permissions`, which lets the assistant ask the user for extra file-system or network access. It gives the model a structured way to ask instead of guessing or silently failing.

**Data flow**: It receives the human-readable tool description text. It creates input fields for an optional reason, an optional environment id, and a required permission profile, then returns the complete tool specification.

**Call relations**: The broader `spec` flow calls this when permission requests are available. It delegates the nested permission shape to `permission_profile_schema`, so the request uses the same file and network permission format as other parts of this file.

*Call graph*: calls 3 internal fn (permission_profile_schema, object, string); called by 1 (spec); 3 external calls (from, Function, vec!).


##### `request_permissions_tool_description`  (lines 256–259)

```
fn request_permissions_tool_description() -> String
```

**Purpose**: This returns the standard explanation shown for the `request_permissions` tool. The text tells the model when to ask, how environment targeting works, and how granted permissions are later applied.

**Data flow**: It takes no input. It returns a fixed string describing how to request more file-system or network permissions and what happens after the user grants them.

**Call relations**: The broader `spec` flow calls this to get the wording used when registering the permissions tool. That wording is then passed into `create_request_permissions_tool` or otherwise used alongside it.

*Call graph*: called by 1 (spec).


##### `unified_exec_output_schema`  (lines 261–293)

```
fn unified_exec_output_schema() -> Value
```

**Purpose**: This defines the shared output format for tools that run or continue commands. It makes command results predictable by naming fields such as output text, elapsed time, exit code, and session id.

**Data flow**: It takes no input. It returns a JSON object schema that says command responses must include elapsed wall time and output text, and may include details like whether the process finished or should be continued later.

**Call relations**: `create_exec_command_tool_with_environment_id` and `create_write_stdin_tool` call this so both tools describe their results the same way. That shared shape makes it easier for callers to understand command output no matter whether they just started a process or wrote to an existing one.

*Call graph*: called by 2 (create_exec_command_tool_with_environment_id, create_write_stdin_tool); 1 external calls (json!).


##### `create_approval_parameters`  (lines 295–341)

```
fn create_approval_parameters(
    exec_permission_approvals_enabled: bool,
) -> BTreeMap<String, JsonSchema>
```

**Purpose**: This creates the permission-related input fields that can be attached to command tools. These fields let a command use the default sandbox, ask for limited extra permissions, or request fully escalated execution.

**Data flow**: It receives a flag saying whether per-command extra permission approvals are enabled. From that, it builds allowed choices for `sandbox_permissions`, adds fields for a user-facing justification and reusable command prefix, and, when enabled, adds an `additional_permissions` profile.

**Call relations**: `create_exec_command_tool_with_environment_id` and `create_shell_command_tool` call this while assembling their input schemas. If extra permissions are enabled, it calls `permission_profile_schema` to describe exactly what network or file access the command wants.

*Call graph*: calls 4 internal fn (permission_profile_schema, array, string, string_enum); called by 2 (create_exec_command_tool_with_environment_id, create_shell_command_tool); 3 external calls (from, json!, vec!).


##### `permission_profile_schema`  (lines 343–354)

```
fn permission_profile_schema() -> JsonSchema
```

**Purpose**: This defines the overall shape of a permission request. A permission profile can ask for network access, file-system access, or both.

**Data flow**: It takes no input. It combines the network permission schema and file-system permission schema into one object and labels it as a file-system or network access request.

**Call relations**: `create_approval_parameters` uses this for per-command additional permissions, and `create_request_permissions_tool` uses it for standalone permission requests. It gets its two main pieces from `network_permissions_schema` and `file_system_permissions_schema`.

*Call graph*: calls 3 internal fn (file_system_permissions_schema, network_permissions_schema, object); called by 2 (create_approval_parameters, create_request_permissions_tool); 1 external calls (from).


##### `network_permissions_schema`  (lines 356–369)

```
fn network_permissions_schema() -> JsonSchema
```

**Purpose**: This defines the small part of a permission request that asks for network access. It keeps the request explicit by using an `enabled` true-or-false field.

**Data flow**: It takes no input. It returns a schema for an object where `enabled: true` means network access is requested, while false or missing means no network access is requested.

**Call relations**: `permission_profile_schema` calls this when building the larger permission profile. It supplies the network half of that combined request.

*Call graph*: calls 2 internal fn (boolean, object); called by 1 (permission_profile_schema); 1 external calls (from).


##### `file_system_permissions_schema`  (lines 371–400)

```
fn file_system_permissions_schema() -> JsonSchema
```

**Purpose**: This defines the file access part of a permission request. It lets the assistant ask for read access, write access, or both, using explicit absolute paths.

**Data flow**: It takes no input. It returns a schema with optional `read` and `write` arrays, where each array contains paths that should be granted for that kind of access.

**Call relations**: `permission_profile_schema` calls this when building the larger permission profile. It supplies the file-system half of that combined request.

*Call graph*: calls 3 internal fn (array, object, string); called by 1 (permission_profile_schema); 1 external calls (from).


##### `windows_shell_guidance`  (lines 402–407)

```
fn windows_shell_guidance() -> &'static str
```

**Purpose**: This returns safety guidance for using shell commands on Windows. The guidance warns against risky cross-shell file operations and reminds callers to verify destructive paths.

**Data flow**: It takes no input. It returns a fixed text block with Windows-specific rules for safer deletion, moving, and background process launching.

**Call relations**: The shell tool builders use this guidance in Windows descriptions, especially for command-running tools. It does not build schemas itself; it supplies human-readable warnings that are embedded into tool descriptions.


### `core/src/tools/hook_names.rs`

`data_model` · `hook matching and hook payload creation`

Hooks are outside programs or scripts that Codex can run before or after a tool is used. To make that work, Codex sends each hook a tool name, such as `apply_patch` or `Bash`, so the hook knows what is happening. This file protects that name from getting mixed up with look-alike names used by other tool ecosystems.

The key idea is simple: there is one canonical name that gets written into the hook input, and there may also be matcher aliases. A matcher alias is an extra name that can trigger the same hook rule, but it is not shown to the hook as the real tool name. For example, Codex's file-editing tool is called `apply_patch`, but some hook configurations may refer to similar editing tools as `Write` or `Edit`. This file lets those old or external names still match, while keeping the actual hook payload honest.

The main type, `HookToolName`, is like a name badge with a list of nicknames on the back. The badge says the official name; the nicknames help recognize it in different contexts. Without this separation, Codex might accidentally tell a hook that the tool was `Write` when it was really `apply_patch`, which could confuse logs, policies, and hook behavior.

#### Function details

##### `HookToolName::new`  (lines 21–26)

```
fn new(name: impl Into<String>) -> Self
```

**Purpose**: Creates a `HookToolName` with one official name and no extra matching aliases. Use this when the tool name does not need compatibility names from other systems.

**Data flow**: It receives a name-like value, turns it into a stored string, and builds a `HookToolName` whose alias list is empty. The result is a clean, single-name identity for hook payloads and hook matching.

**Call relations**: This is the basic constructor used by code and tests that need ordinary hook tool names, especially around permission and approval behavior. The `bash` helper also builds on it, so shell-like tools get the same simple no-alias treatment.

*Call graph*: called by 11 (approve_mode_skips_guardian_in_every_permission_mode, approve_mode_skips_when_annotations_do_not_require_approval, full_access_mode_skips_mcp_tool_approval_for_all_approval_modes, guardian_mode_mcp_denial_returns_rationale_message, guardian_mode_skips_auto_when_annotations_do_not_require_approval, permission_request_hook_allows_mcp_tool_call, permission_request_hook_runs_after_remembered_mcp_approval, permission_request_hook_uses_hook_tool_name_without_metadata, prompt_mode_waits_for_approval_when_annotations_do_not_require_approval, hook_tool_name (+1 more)); 2 external calls (into, new).


##### `HookToolName::apply_patch`  (lines 34–39)

```
fn apply_patch() -> Self
```

**Purpose**: Creates the hook identity for Codex file edits done through `apply_patch`. It keeps `apply_patch` as the official name while allowing hook rules written for `Write` or `Edit` to match too.

**Data flow**: It takes no input. It returns a `HookToolName` whose main name is `apply_patch` and whose matcher aliases are `Write` and `Edit`; those aliases help select hooks but are not the name sent in the hook payload.

**Call relations**: This is used when building hook payloads for file-editing activity, including permission-request and post-tool-use flows. It gives those flows both a stable Codex name for the hook input and compatibility names for rule selection.

*Call graph*: called by 2 (post_tool_use_payload, permission_request_payload); 1 external calls (vec!).


##### `HookToolName::spawn_agent`  (lines 46–51)

```
fn spawn_agent() -> Self
```

**Purpose**: Creates the hook identity for starting a sub-agent. It reports the official Codex name `spawn_agent` while allowing hook matchers that say `Agent` to apply.

**Data flow**: It takes no input. It returns a `HookToolName` with `spawn_agent` as the canonical name and `Agent` as a matcher-only alias.

**Call relations**: This is used when code determines the hook-facing name for a function call that spawns another agent. It lets that flow preserve Codex's real tool name while still honoring hook configurations that use the more general `Agent` label.

*Call graph*: called by 1 (function_hook_tool_name); 1 external calls (vec!).


##### `HookToolName::bash`  (lines 54–56)

```
fn bash() -> Self
```

**Purpose**: Creates the hook identity historically used for shell-like tool execution. It uses `Bash` as the official hook name and adds no aliases.

**Data flow**: It takes no input. It calls the general constructor with `Bash`, producing a `HookToolName` with that single name and an empty alias list.

**Call relations**: This is used when hook payloads are created for shell or unified execution tools. By going through the shared constructor, it follows the same shape as other hook names even though it has no compatibility aliases.

*Call graph*: called by 3 (post_tool_use_payload, post_unified_exec_tool_use_payload, bash); 1 external calls (new).


##### `HookToolName::name`  (lines 59–61)

```
fn name(&self) -> &str
```

**Purpose**: Returns the official tool name that should be serialized into hook input. This is the name hook programs actually see.

**Data flow**: It reads the stored canonical name inside an existing `HookToolName` and returns it as borrowed text. It does not change the object.

**Call relations**: When pre-tool-use hooks are run, this method supplies the real tool name for the hook payload. That keeps the payload stable even if alias names are also considered during matcher selection.

*Call graph*: called by 1 (run_pre_tool_use_hooks).


##### `HookToolName::matcher_aliases`  (lines 64–66)

```
fn matcher_aliases(&self) -> &[String]
```

**Purpose**: Returns the extra names that should be considered when deciding whether a hook rule matches this tool. These names are for selection only, not for the hook payload itself.

**Data flow**: It reads the alias list stored inside an existing `HookToolName` and returns it as a borrowed list. Nothing is copied or changed.

**Call relations**: When pre-tool-use hooks are run, this method gives the matcher its compatibility names. The matcher can then treat names like `Write`, `Edit`, or `Agent` as selecting the same handlers without changing the official name sent to the hook.

*Call graph*: called by 1 (run_pre_tool_use_hooks).


### Protocol payload schemas
These files define the shared protocol-level request, response, metadata, and planning payloads consumed by tool and approval flows.

### `protocol/src/mcp_approval_meta.rs`

`data_model` · `cross-cutting`

This file is a small dictionary of constant text values. The project uses these strings as metadata keys and values when it needs to ask for, describe, or remember an approval related to MCP, which means “Model Context Protocol,” a way for the system to connect to external tools and services.

Think of it like a standardized form. Every field on the form needs the same name wherever it is filled in or read later. For example, the file defines the key for the approval kind, possible approval kinds such as an MCP tool call or a tool suggestion, fields for whether approval should persist for a session or always, and fields that describe where the request came from, such as a connector and its name or description. It also names fields for the tool itself, including the tool name, title, description, parameters, and display-friendly parameter text.

Without this file, different parts of the system might type these labels by hand. A tiny difference, such as `tool_name` in one place and `toolName` in another, could make approval information disappear or fail to match. By keeping the protocol vocabulary here, the code has one reliable source of truth.


### `protocol/src/plan_tool.rs`

`data_model` · `request handling`

This file is a small contract for the `update_plan` tool. Think of it like a form template: every part of the system that sends or receives a plan update needs to know which fields are allowed, what they are called, and what values they can contain.

It defines three data types. `StepStatus` says where a plan step is in its life: not started yet, currently being worked on, or finished. `PlanItemArg` represents one row in the plan, with the text of the step and its status. `UpdatePlanArgs` represents the whole update sent to the tool: an optional explanation plus a list of plan items.

The file also adds rules for converting these Rust types to and from JSON, which is the text-based format commonly used when tools communicate. For example, status names are written in `snake_case`, such as `in_progress`, so outside callers know the exact spelling to use. The structs reject unknown fields, which helps catch mistakes early instead of silently ignoring bad input.

The schema and TypeScript generation traits let other parts of the project produce machine-readable documentation and matching TypeScript types from the same source. Without this file, different components could easily disagree about the plan update format, causing tool calls to fail or be misunderstood.


### `protocol/src/request_permissions.rs`

`data_model` · `permission request and response exchange`

This file is mostly a set of data shapes for a permission-request conversation. In plain terms, it describes what information must be carried when a tool says, “I need more access to continue,” and when the user or host answers that request.

The central idea is a permission profile: a small bundle that may contain network permissions, file-system permissions, or both. If both are missing, the request is effectively empty. The file also defines how long a granted permission should last: only for the current turn, or for the whole session. A “turn” means one round of interaction; a “session” means the broader ongoing run.

There are three main message shapes. `RequestPermissionsArgs` is what gets sent when asking for permissions, including an optional environment id and a human-readable reason. `RequestPermissionsResponse` is what comes back, including the approved permissions, the grant scope, and a flag that can force stricter review of later commands in the same turn. `RequestPermissionsEvent` records or broadcasts that such a request happened, with details like call id, turn id, time started, reason, permissions, and optionally the current working directory.

The serialization annotations matter because these structures travel across boundaries, such as JSON APIs and TypeScript clients. They make sure both older and newer naming styles are understood where needed.

#### Function details

##### `RequestPermissionProfile::is_empty`  (lines 26–28)

```
fn is_empty(&self) -> bool
```

**Purpose**: Checks whether a permission request profile asks for nothing at all. This is useful before sending or acting on a request, because an empty request would not grant any network or file-system ability.

**Data flow**: It reads the profile’s two optional fields: `network` and `file_system`. If both are absent, it returns `true`; if either one is present, it returns `false`. It does not change the profile.

**Call relations**: This is a small helper attached to the permission profile itself. Other parts of the permission flow can call it when deciding whether a request contains any real permission change before showing it, sending it, or processing it.


##### `AdditionalPermissionProfile::from`  (lines 32–37)

```
fn from(value: RequestPermissionProfile) -> Self
```

**Purpose**: Converts a `RequestPermissionProfile` into an `AdditionalPermissionProfile`. This lets the same requested network and file-system access be reused in places that expect the broader “additional permissions” type.

**Data flow**: It takes a request permission profile as input, moves out its optional network permissions and optional file-system permissions, and builds a new additional permission profile with those same values. Nothing is interpreted or changed; the data is simply repackaged.

**Call relations**: This function is used automatically by Rust’s standard `From` conversion pattern when code needs to treat a permission request as an additional permission profile. It helps keep the request/response protocol type compatible with the internal permission model without manual field copying at every call site.


##### `RequestPermissionProfile::from`  (lines 41–46)

```
fn from(value: AdditionalPermissionProfile) -> Self
```

**Purpose**: Converts an `AdditionalPermissionProfile` back into a `RequestPermissionProfile`. This is useful when existing permission data needs to be sent through the request-permissions protocol.

**Data flow**: It takes an additional permission profile, moves its optional network permissions and optional file-system permissions into a new request permission profile, and returns that new profile. The permission contents stay the same; only the wrapper type changes.

**Call relations**: This is the reverse conversion of `AdditionalPermissionProfile::from`. It supports the same larger flow from the other direction: code that already has additional permissions can hand them to the request-permission message types without rebuilding the fields by hand.


### `protocol/src/request_user_input.rs`

`data_model` · `request handling`

This file is like a blank form template for asking the user questions and collecting answers. It does not ask the questions itself. Instead, it defines the exact structure of the data that other parts of the system send around.

The main idea is simple: the system may need to pause and ask the user one or more questions. Each question has an id, a header, the question text, and optional answer choices. A question can also be marked as “other,” meaning it may allow a custom answer, or “secret,” meaning the answer should be treated like sensitive text such as a password.

A request groups several questions together and may include an automatic timeout in milliseconds. A response maps each question id to the answer or answers the user gave. There is also an event type, used when announcing that user input is needed during a larger turn of work. That event carries the related tool-call id, the turn id, the questions, and the same optional timeout.

The derive annotations are important glue. They let these structs be converted to and from JSON, checked against generated JSON Schema, and exported to TypeScript. Without this file, different parts of the system could disagree about field names like `isSecret` or `autoResolutionMs`, causing user prompts or replies to break across language or process boundaries.


### Extension tool schemas
These files provide schema-generation and tool-contract definitions for goal, skills, and web-search extension surfaces.

### `ext/goal/src/spec.rs`

`config` · `startup/tool registration`

This file is like the instruction card and form layout for a small goal-tracking feature. It does not store goals itself. Instead, it describes tools that another part of the system can offer to an AI agent through the Responses API, which is the interface where tools are listed with names, descriptions, and input shapes.

There are three tool names: `get_goal`, `create_goal`, and `update_goal`. Each builder function returns a `ToolSpec`, meaning a machine-readable description of one callable tool. The descriptions are unusually important here because they guide when the agent should and should not use the tool. For example, creating a goal is only allowed when the user or higher-level instructions explicitly ask for one; ordinary tasks should not silently become goals.

The file also defines input schemas, which are like forms with allowed fields. `get_goal` takes no input. `create_goal` requires an `objective` and can optionally take a `token_budget`. `update_goal` only accepts a `status`, and that status must be either `complete` or `blocked`. The long wording around `blocked` matters: it prevents the agent from declaring itself blocked too quickly, and says that being slow, uncertain, or near a budget limit is not enough.

#### Function details

##### `create_get_goal_tool`  (lines 13–23)

```
fn create_get_goal_tool() -> ToolSpec
```

**Purpose**: Builds the tool definition for asking, “What is the current goal?” Someone would use this when registering tools so the agent can inspect the active goal, its status, and its budget or usage information.

**Data flow**: It starts with no caller-provided input. It creates an empty input schema, because this tool needs no arguments, then wraps the tool name, description, and schema into a `ToolSpec`. The result is a ready-to-register description of the `get_goal` tool; it does not fetch the goal itself.

**Call relations**: During goal tool setup, the surrounding `spec` code calls this function to produce one of the available tool definitions. This function hands back a completed `ToolSpec` built from a Responses API tool object, so the broader system can advertise `get_goal` to the agent.

*Call graph*: calls 1 internal fn (object); called by 1 (spec); 3 external calls (new, new, Function).


##### `create_create_goal_tool`  (lines 25–58)

```
fn create_create_goal_tool() -> ToolSpec
```

**Purpose**: Builds the tool definition for starting a new persisted goal. It makes clear that the tool should only be used when a goal is explicitly requested, and that a token budget should only be included when one was explicitly requested too.

**Data flow**: It creates a small input form with two possible fields: a required `objective`, which is the concrete thing to pursue, and an optional `token_budget`, which must be a positive integer when used. It then places that form together with the tool name and usage instructions into a `ToolSpec`. The output is the definition of the `create_goal` tool, not a newly created goal.

**Call relations**: The surrounding `spec` setup calls this function when assembling the goal tools. Inside, it builds the schema pieces for strings and integers, then hands the finished Responses API tool definition back to the caller so the agent can be offered a safe, clearly constrained way to create goals.

*Call graph*: calls 3 internal fn (integer, object, string); called by 1 (spec); 4 external calls (from, format!, Function, vec!).


##### `create_update_goal_tool`  (lines 60–94)

```
fn create_update_goal_tool() -> ToolSpec
```

**Purpose**: Builds the tool definition for changing an existing goal’s status to either `complete` or `blocked`. Its main job is to make the rules around those status changes explicit, so the agent does not mark work done or blocked for the wrong reason.

**Data flow**: It defines one required input field, `status`, and restricts that field to exactly two values: `complete` or `blocked`. It attaches a detailed description explaining when each value is allowed, especially the repeated-condition rule for `blocked`. It returns a `ToolSpec` describing the `update_goal` tool; it does not update any stored goal by itself.

**Call relations**: The surrounding `spec` setup calls this function while collecting the goal-related tool definitions. This function creates the allowed-value schema, wraps it in a Responses API tool object, and returns it so the rest of the system can expose only these narrow, rule-bound updates to the agent.

*Call graph*: calls 2 internal fn (object, string_enum); called by 1 (spec); 3 external calls (from, Function, vec!).


### `ext/skills/src/tools/schema.rs`

`util` · `tool schema generation`

Skill tools need a clear contract: “send me data shaped like this, and I will return data shaped like that.” This file builds that contract automatically from Rust types that implement `JsonSchema`, meaning they know how to describe themselves as JSON Schema. JSON Schema is a standard way to describe JSON data, such as which fields exist, which are required, and what types those fields have.

There are two public helpers inside this module. One builds schemas for tool inputs, and the other builds schemas for tool outputs. They are almost the same, but output schemas allow optional values to be represented with `null`, while input schemas do not add that extra `null` type.

The shared worker, `schema_for`, asks the `schemars` library to generate a draft 2019-09 JSON Schema. It keeps nested schemas inline, so the result is easier to hand directly to tool consumers. After generating the full schema, it trims it down to only the parts this tool system cares about, such as `properties`, `required`, `type`, and schema definitions. In effect, it is like taking a full instruction manual and copying only the pages needed by the tool interface.

#### Function details

##### `input_schema_for`  (lines 6–8)

```
fn input_schema_for() -> Value
```

**Purpose**: Builds a JSON Schema for the data a tool accepts as input. It is used when the system needs to advertise or validate the expected arguments for a skill tool.

**Data flow**: It receives a Rust type `T` that can describe itself as JSON Schema. It passes that type to the shared schema builder with the setting that optional values should not automatically include `null`. It returns a JSON value containing the simplified schema.

**Call relations**: When some part of the skills system needs an input contract for a tool, it calls `input_schema_for`. This function does not build the schema itself; it delegates to `schema_for` with input-specific settings.


##### `output_schema_for`  (lines 10–12)

```
fn output_schema_for() -> Value
```

**Purpose**: Builds a JSON Schema for the data a tool returns. It differs from the input version by allowing optional output fields to include `null`, which is often how missing or empty returned values are represented in JSON.

**Data flow**: It receives a Rust type `T` that can produce a JSON Schema. It sends that type to the shared schema builder with the setting that optional values may include `null`. It returns the simplified schema as a JSON value.

**Call relations**: When the skills system needs to describe a tool’s result shape, it calls `output_schema_for`. Like the input helper, it hands the real work to `schema_for`, but chooses the output-friendly setting.


##### `schema_for`  (lines 14–42)

```
fn schema_for(option_add_null_type: bool) -> Value
```

**Purpose**: Creates the actual JSON Schema and trims it to the fields this tool system wants to expose. This keeps input and output schema generation consistent while allowing one small setting to differ between them.

**Data flow**: It takes a Rust type `T` and a true-or-false setting for whether optional values should also allow `null`. It asks `schemars` to generate a JSON Schema using draft 2019-09 rules, converts that schema into ordinary JSON, checks that the top level is a JSON object, then copies only selected keys into a new object. The result is a smaller JSON schema object returned to the caller. If serialization fails, it stops with a clear panic because generated schemas are expected to be serializable.

**Call relations**: `input_schema_for` and `output_schema_for` both call this function so they share the same schema-building path. Inside, it relies on external library calls from `schemars` and `serde_json` to generate and convert the schema, then performs the project-specific filtering before handing the final JSON back.

*Call graph*: 5 external calls (new, draft2019_09, Object, to_value, unreachable!).


### `ext/web-search/src/schema.rs`

`io_transport` · `spec generation`

This file exists to turn the Rust type `SearchCommands` into a JSON Schema, which is a machine-readable set of rules for JSON data. In plain terms, it answers: “What should a valid web-search command look like?” Without this, the system would have a harder time publishing or checking the command format that the web-search extension understands.

The file asks the `schemars` library to generate a schema using the 2019-09 JSON Schema draft. It adjusts two details before generating it: nested schemas are written directly in place, and optional values are not automatically described as also allowing `null`. After the schema is generated, it is converted into regular JSON.

Then the file trims the generated JSON down to the parts that are useful for a tool specification: fields such as `properties`, `required`, `type`, and schema definitions. Think of this like taking a full instruction manual and copying only the pages needed for a public checklist. If schema generation ever produced something impossible or unserializable, the function stops loudly, because that would mean the command contract could not be trusted.

#### Function details

##### `commands_schema`  (lines 6–36)

```
fn commands_schema() -> Value
```

**Purpose**: Builds a JSON Schema for `SearchCommands`, the set of commands the web-search extension accepts. It returns only the schema parts needed by the tool specification that advertises those commands.

**Data flow**: It starts with the Rust command type `SearchCommands` and reads its structure through the schema-generation library. It configures how the schema should be written, generates the schema, turns it into JSON, then copies selected top-level fields into a new JSON object. The result is a compact JSON value describing the valid command format; if conversion fails, the function stops with an error because the schema must be available.

**Call relations**: The `spec` code calls this function when it needs to describe the web-search tool’s command input. This function does the schema-building work and hands back JSON that `spec` can include in the public tool definition.

*Call graph*: called by 1 (spec); 6 external calls (new, draft2019_09, Object, panic!, to_value, unreachable!).


### MCP tool configuration
This file translates MCP-exposed codex tool payloads into validated schemas and core runtime configuration.

### `mcp-server/src/codex_tool_config.rs`

`config` · `tool registration and request handling`

This file is the contract between the MCP server and any outside client that wants to use Codex through tool calls. In plain terms, it says: “Here are the fields you may send, here is what they mean, and here is how they become a real Codex configuration.” Without it, clients would not have a clear, machine-readable recipe for starting a Codex conversation, choosing a model, setting the working folder, deciding when shell commands need approval, or selecting how restricted the sandbox should be.

The main input type is `CodexToolCallParam`, used to start a session. It includes the first prompt plus optional settings such as model name, current working directory, approval policy, sandbox mode, and instruction overrides. The file also defines small wrapper enums for approval and sandbox choices because these need JSON schema support for MCP clients.

When a request arrives, `CodexToolCallParam::into_config` converts the client’s friendly JSON-shaped input into the internal `Config` object used by `codex-core`. Think of it like translating a hotel booking form into the exact instructions the hotel staff system understands.

The reply side is handled by `CodexToolCallReplyParam`, which continues an existing session using a thread id. The file also builds MCP `Tool` descriptions for both starting and continuing Codex sessions, including their expected input and output schemas. The tests lock down those schemas so accidental changes are easy to spot.

#### Function details

##### `AskForApproval::from`  (lines 77–84)

```
fn from(value: CodexToolCallApprovalPolicy) -> Self
```

**Purpose**: This converts the MCP-facing approval choice into the internal Codex approval setting. It lets the public tool API use names that are easy to describe in JSON while still feeding the exact type expected by Codex itself.

**Data flow**: It receives one `CodexToolCallApprovalPolicy` value, such as `OnFailure` or `Never`. It matches that value to the corresponding internal `AskForApproval` value. The output is the internal approval policy that later becomes part of the Codex configuration.

**Call relations**: This conversion is used when `CodexToolCallParam::into_config` builds configuration overrides. The client sends the public-facing value, and this function quietly translates it before the setting is handed to `codex-core`.


##### `SandboxMode::from`  (lines 98–104)

```
fn from(value: CodexToolCallSandboxMode) -> Self
```

**Purpose**: This converts the MCP-facing sandbox choice into the internal Codex sandbox setting. The sandbox is the safety boundary that controls what the Codex session may read or write.

**Data flow**: It receives one `CodexToolCallSandboxMode` value, such as `ReadOnly` or `DangerFullAccess`. It maps that value to the matching internal `SandboxMode`. The output is the sandbox mode that Codex’s core configuration understands.

**Call relations**: This conversion is used while building a real Codex config from a tool call. `CodexToolCallParam::into_config` accepts the client’s JSON-friendly sandbox value, then relies on this mapping before passing the result onward.


##### `create_tool_for_codex_tool_call_param`  (lines 108–126)

```
fn create_tool_for_codex_tool_call_param() -> Tool
```

**Purpose**: This builds the MCP tool definition for starting a new Codex session. It tells MCP clients the tool name, description, title, accepted input fields, and output shape.

**Data flow**: It starts with the Rust type `CodexToolCallParam` and asks the schema generator to turn it into a JSON Schema, which is a machine-readable description of valid JSON. It trims that schema into the shape MCP expects, attaches the standard Codex output schema, and returns a `Tool` named `codex`.

**Call relations**: This function is used when the server advertises its available tools. The test `tests::verify_codex_tool_json_schema` calls it to make sure the advertised contract has not changed unexpectedly. It delegates input-schema cleanup to `create_tool_input_schema` and reuses `codex_tool_output_schema` for the result format.

*Call graph*: calls 2 internal fn (codex_tool_output_schema, create_tool_input_schema); called by 1 (verify_codex_tool_json_schema); 2 external calls (draft2019_09, new).


##### `codex_tool_output_schema`  (lines 128–141)

```
fn codex_tool_output_schema() -> Arc<JsonObject>
```

**Purpose**: This creates the shared output schema for Codex tool calls. It says that a successful tool response contains a `threadId` and some textual `content`.

**Data flow**: It builds a small JSON object with two required string fields: `threadId` and `content`. It wraps that object in shared ownership storage so the MCP `Tool` definition can hold onto it. The result is a reusable output schema object.

**Call relations**: Both tool builders call this function: one for starting a session and one for replying to a session. This keeps the output contract consistent between `codex` and `codex-reply`.

*Call graph*: called by 2 (create_tool_for_codex_tool_call_param, create_tool_for_codex_tool_call_reply_param); 3 external calls (new, json!, unreachable!).


##### `CodexToolCallParam::into_config`  (lines 146–190)

```
async fn into_config(
        self,
        arg0_paths: Arg0DispatchPaths,
    ) -> std::io::Result<(String, Config)>
```

**Purpose**: This turns a client’s start-session request into the real Codex configuration used to run the session. It also returns the initial prompt separately, because that prompt starts the conversation rather than simply configuring it.

**Data flow**: It receives a filled `CodexToolCallParam` and the paths to helper executables discovered from process startup. It separates the prompt from the optional settings, converts public approval and sandbox values into internal ones, turns any JSON config overrides into TOML-style values, and asks `ConfigBuilder` to combine these with normal Codex configuration files. The output is either an error or a pair: the original prompt and the finished `Config`.

**Call relations**: This is called when the server is about to start a Codex session from an MCP request. It is the bridge from external tool input to `codex-core`: after this function succeeds, the rest of the system can run with a normal internal `Config` instead of raw client JSON.

*Call graph*: 2 external calls (default, default).


##### `CodexToolCallReplyParam::get_thread_id`  (lines 211–223)

```
fn get_thread_id(&self) -> anyhow::Result<ThreadId>
```

**Purpose**: This finds and validates the conversation thread id in a reply request. It supports both the current field name, `threadId`, and the older `conversationId` name for backward compatibility.

**Data flow**: It reads the reply request. If `threadId` is present, it parses that string into a `ThreadId`. If not, it tries the deprecated `conversationId` field. If neither exists, it returns an error explaining that one of them is required.

**Call relations**: This is used when a client wants to continue an existing Codex session. It gives the request-handling code a proper `ThreadId` to look up the conversation, while hiding the compatibility detail that older clients may still send `conversationId`.

*Call graph*: calls 1 internal fn (from_string); 1 external calls (anyhow!).


##### `create_tool_for_codex_tool_call_reply_param`  (lines 227–245)

```
fn create_tool_for_codex_tool_call_reply_param() -> Tool
```

**Purpose**: This builds the MCP tool definition for continuing an existing Codex session. It describes the `codex-reply` tool, including the needed prompt and thread identifier.

**Data flow**: It starts from the Rust type `CodexToolCallReplyParam`, generates a JSON Schema for its accepted input, filters that schema into the form MCP expects, attaches the shared Codex output schema, and returns a `Tool` named `codex-reply`.

**Call relations**: This function is used when the server advertises the reply tool to clients. The test `tests::verify_codex_tool_reply_json_schema` calls it to check that the tool contract stays stable. It shares helper functions with the start-session tool builder so both tools are described consistently.

*Call graph*: calls 2 internal fn (codex_tool_output_schema, create_tool_input_schema); called by 1 (verify_codex_tool_reply_json_schema); 2 external calls (draft2019_09, new).


##### `create_tool_input_schema`  (lines 247–276)

```
fn create_tool_input_schema(
    schema: schemars::schema::RootSchema,
    panic_message: &str,
) -> Arc<JsonObject>
```

**Purpose**: This reshapes a generated Rust JSON Schema into the smaller schema object expected by MCP tool definitions. It keeps the important validation pieces and discards extra wrapper details.

**Data flow**: It receives a generated root schema and an error message to use if serialization fails. It converts the schema into JSON, confirms that it is an object, then copies only core keys such as `properties`, `required`, `type`, and definition sections. The output is a shared JSON object ready to become a tool’s `inputSchema`.

**Call relations**: Both tool-builder functions call this after generating schemas from their request types. It acts like a sieve: the schema generator produces a full document, and this function keeps the parts MCP clients actually need.

*Call graph*: called by 2 (create_tool_for_codex_tool_call_param, create_tool_for_codex_tool_call_reply_param); 4 external calls (new, new, panic!, to_value).


##### `tests::verify_codex_tool_json_schema`  (lines 295–376)

```
fn verify_codex_tool_json_schema()
```

**Purpose**: This test protects the exact advertised schema for the `codex` tool. It makes schema changes visible and intentional instead of accidental.

**Data flow**: It builds the `codex` tool definition, serializes it to JSON, and compares it with a hand-written expected JSON value. If any field, description, enum, required list, or output shape changes, the test fails.

**Call relations**: The test calls `create_tool_for_codex_tool_call_param`, so it checks the public contract produced by the same path used by the server. It is especially useful because generated schemas can change in subtle ways when types or dependencies change.

*Call graph*: calls 1 internal fn (create_tool_for_codex_tool_call_param); 3 external calls (assert_eq!, json!, to_value).


##### `tests::codex_tool_call_param_rejects_removed_profile_field`  (lines 379–390)

```
fn codex_tool_call_param_rejects_removed_profile_field()
```

**Purpose**: This test confirms that the old `profile` field is no longer accepted in start-session requests. It protects clients and maintainers from silently relying on a removed setting.

**Data flow**: It tries to deserialize JSON containing a valid `prompt` plus an unexpected `profile` field into `CodexToolCallParam`. The expected result is an error, and the test checks that the error says `profile` is unknown.

**Call relations**: This test exercises the strict input rules declared on `CodexToolCallParam`. It does not go through a tool builder; instead, it verifies that request parsing itself rejects unsupported fields before configuration building begins.

*Call graph*: 2 external calls (assert!, json!).


##### `tests::verify_codex_tool_reply_json_schema`  (lines 393–437)

```
fn verify_codex_tool_reply_json_schema()
```

**Purpose**: This test protects the exact advertised schema for the `codex-reply` tool. It makes sure clients continue to see the expected fields for continuing a conversation.

**Data flow**: It builds the `codex-reply` tool definition, serializes it to JSON, and compares it with the expected JSON structure. The expected schema includes both the current `threadId` field and the deprecated `conversationId` field.

**Call relations**: The test calls `create_tool_for_codex_tool_call_reply_param`, checking the same schema-building path the server uses when advertising tools. It helps keep backward compatibility visible because the deprecated field is still part of the expected contract.

*Call graph*: calls 1 internal fn (create_tool_for_codex_tool_call_reply_param); 3 external calls (assert_eq!, json!, to_value).
