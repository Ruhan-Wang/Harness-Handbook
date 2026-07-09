# Model transport execution  `stage-13.1`

This stage is the network layer for talking to model services during the main work of a session, with a little startup help. Shared request plumbing in client_common, responses_metadata, responses.rs, and tools/responses_api shapes Codex turns, IDs, metadata, and tool descriptions before they leave the app. The main client chooses HTTP streaming or WebSocket, adds authentication, sends the request, records telemetry, and uses retry policy when a stream fails.

Endpoint clients are the doorways to specific remote jobs: Responses, compact history, memories, images, search, and realtime calls. Their companion decoders turn raw server streams, JSON, SSE events, WebSocket messages, or WebRTC answers into clear Codex events and typed results. api_bridge makes network and HTTP failures understandable to the rest of the program.

Realtime files are the live conversation machinery. They hide protocol version differences, build outgoing voice/text messages, decode incoming events, and run WebSocket or WebRTC audio sessions. Higher-level orchestration starts realtime conversations, prewarms connections during session startup, and runs remote compaction so long chats stay usable.

## Files in this stage

### Shared request and error foundations
These files define the common request payload helpers, metadata, stream wrappers, tool serialization, and public error translation used across outbound model transports.

### `core/src/client_common.rs`

`io_transport` · `request handling`

This file is a small shared toolkit for talking to the model API. Its main request type, `Prompt`, is the bundle of information needed for one model turn: the conversation so far, the tools the model may call, the base instructions, optional personality settings, and optional rules for the shape of the answer. Think of it like the envelope prepared before mailing a question to the model.

One important detail is that the file can prepare the prompt differently depending on which API mode is being used. For the lighter Responses API mode, it removes image “detail” settings from image inputs. The images themselves remain, but the extra detail preference is stripped out so the request matches what that mode expects.

The other main type, `ResponseStream`, is a wrapper around a channel that receives response events over time. A stream means the caller can read pieces of the model response as they arrive instead of waiting for everything at once. If the caller stops reading early, the stream’s cleanup code sends a cancellation signal to the background task that was mapping provider events. This prevents unused work from continuing after the consumer has walked away.

#### Function details

##### `Prompt::default`  (lines 43–53)

```
fn default() -> Self
```

**Purpose**: Creates a safe, empty starting prompt. Code uses this when it wants a blank request and will fill in only the parts it needs.

**Data flow**: It takes no input. It builds a `Prompt` with no conversation items, no tools, no personality, no output schema, parallel tool calls turned off, strict schema checking turned on, and default base instructions. The result is a ready-to-edit prompt value.

**Call relations**: Many tests and setup helpers call this when they need a simple prompt to customize. It relies on the default value for base instructions and creates new empty lists for fields like input and tools.

*Call graph*: calls 1 internal fn (default); called by 8 (responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request, prompt_with_input, sample, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata); 1 external calls (new).


##### `Prompt::get_formatted_input_for_request`  (lines 57–66)

```
fn get_formatted_input_for_request(
        &self,
        use_responses_lite: bool,
    ) -> Vec<ResponseItem>
```

**Purpose**: Returns the conversation input in the exact form needed for an outgoing API request. It preserves the original prompt while making a request-specific copy.

**Data flow**: It reads the prompt’s stored input items and makes a clone of them. If the caller says the lighter Responses API mode is being used, it edits that copied input to remove image detail settings. It returns the copied, possibly simplified input list and does not change the original prompt.

**Call relations**: The request-building code calls this while assembling a Responses API request. When the lighter API mode needs image details removed, this function hands the copied input to `strip_image_details` before returning it.

*Call graph*: calls 1 internal fn (strip_image_details); called by 1 (build_responses_request).


##### `strip_image_details`  (lines 69–106)

```
fn strip_image_details(items: &mut [ResponseItem])
```

**Purpose**: Removes optional image detail settings from conversation items. This keeps image content while dropping a setting that is not wanted for certain request formats.

**Data flow**: It receives a mutable list of response items. It walks through each item, looks inside normal messages and tool-output messages, and when it finds an image input it sets that image’s `detail` field to `None`. Items that cannot contain those image details are left unchanged.

**Call relations**: This is an internal helper used by `Prompt::get_formatted_input_for_request`. It is only part of the request-preparation path, and its job is narrowly focused: clean image detail metadata from a copied prompt before that copy is sent onward.

*Call graph*: called by 1 (get_formatted_input_for_request).


##### `ResponseStream::poll_next`  (lines 118–120)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Lets callers read the next streamed response event, if one is ready. This is what makes `ResponseStream` behave like an asynchronous stream.

**Data flow**: It receives a pinned mutable reference to the stream and the task wake-up context used by asynchronous Rust. It asks the internal receiving channel for the next item. The output is either a response event, an error wrapped in the shared result type, a signal that nothing is ready yet, or the end of the stream.

**Call relations**: Any code consuming `ResponseStream` calls this indirectly through normal stream-reading operations. The function delegates the actual waiting and receiving work to the underlying channel receiver.

*Call graph*: 1 external calls (poll_recv).


##### `ResponseStream::drop`  (lines 124–126)

```
fn drop(&mut self)
```

**Purpose**: Stops background response work when the response stream is abandoned. This is cleanup code that prevents the provider-mapping task from continuing after nobody is listening.

**Data flow**: It runs automatically when a `ResponseStream` is destroyed. It does not return a value. It sends a cancellation signal through the stored cancellation token, changing shared state so the mapper task can notice that the consumer stopped polling early.

**Call relations**: This is called by Rust automatically during cleanup, not by ordinary application code. It hands off to the cancellation token’s `cancel` operation so the background mapper can shut down instead of continuing to process provider events for a dropped stream.

*Call graph*: 1 external calls (cancel).


### `core/src/responses_metadata.rs`

`io_transport` · `request building`

When Codex sends a request to the model service, the service needs context: which installation sent it, which conversation thread it belongs to, whether it is a normal turn or a background memory task, and whether it came from a subagent. This file is the central place that turns that context into metadata for the Responses API.

The main object, CodexResponsesMetadata, is like a shipping label for a model request. It stores the official Codex fields, optional details such as parent thread and sandbox, workspace snapshots, and caller-provided extra fields. It can then print that label in a few formats: a structured JSON blob, a flat client_metadata map, and older compatibility HTTP headers.

The file also protects reserved names. App-server clients may add extra metadata, but they are not allowed to replace core fields such as installation_id, thread_id, or x-codex-turn-metadata. Without this filtering, outside metadata could accidentally or deliberately confuse request tracking.

A special path exists for compaction, which is the process of shortening or summarizing conversation history. Compaction requests carry extra metadata describing why and how compaction is being done. Memory requests are treated differently from normal turns, so some turn identity fields are intentionally left out.

#### Function details

##### `CompactionTurnMetadata::new`  (lines 79–92)

```
fn new(
        trigger: CompactionTrigger,
        reason: CompactionReason,
        implementation: CompactionImplementation,
        phase: CompactionPhase,
    ) -> Self
```

**Purpose**: Creates the small metadata record used when a request is for conversation compaction. It records why compaction is happening, what triggered it, which implementation is being used, and which phase the operation is in.

**Data flow**: The caller gives the trigger, reason, implementation, and phase. The function packages those into a CompactionTurnMetadata value and sets the compaction strategy to Memento by default. The result is returned to be attached to a compaction request.

**Call relations**: Compaction flows call this when they are preparing local or remote compaction work. The resulting value is later carried inside CodexResponsesRequestKind::Compaction so the request metadata can include compaction details.

*Call graph*: called by 4 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner, turn_metadata_state_overlays_compaction_only_on_compaction_requests).


##### `CodexResponsesRequestKind::metadata`  (lines 104–111)

```
fn metadata(self) -> (&'static str, Option<CompactionTurnMetadata>)
```

**Purpose**: Turns an internal request kind into the simple label that will appear in metadata, such as "turn", "prewarm", "compaction", or "memory". For compaction, it also returns the attached compaction details.

**Data flow**: It receives one request-kind value. It matches that value to a text label and, only for compaction, keeps the CompactionTurnMetadata alongside it. It returns both pieces as a pair.

**Call relations**: This is used while building the turn metadata payload. It translates Rust enum choices into the plain metadata values that can be serialized and sent with the request.


##### `CodexResponsesRequestKind::has_turn_identity`  (lines 113–115)

```
fn has_turn_identity(self) -> bool
```

**Purpose**: Answers whether this kind of request should be treated as belonging to a normal conversation turn. Memory requests are the exception, because they are background-style work and should not carry the same turn identity.

**Data flow**: It receives a request kind and checks whether it is Memory. It returns false for Memory and true for the other request kinds.

**Call relations**: The metadata payload builder uses this to decide which identity fields to include. This prevents memory requests from being labeled like regular user turns.

*Call graph*: 1 external calls (matches!).


##### `CodexResponsesMetadata::new`  (lines 153–175)

```
fn new(
        installation_id: String,
        session_id: String,
        thread_id: String,
        window_id: String,
    ) -> Self
```

**Purpose**: Creates a fresh metadata object with the required identity fields filled in. It starts with only the core request identifiers and leaves optional fields empty until other code adds them.

**Data flow**: The caller provides installation ID, session ID, thread ID, and window ID. The function stores those strings, sets optional fields such as turn ID, subagent, sandbox, and request kind to none, and starts the workspace and extra metadata maps empty. It returns the ready-to-fill metadata object.

**Call relations**: Request setup code calls this when it needs a metadata template for normal Responses API calls, detached memory work, or reusable response metadata. Later steps enrich the object before it is converted into client metadata or headers.

*Call graph*: called by 3 (responses_metadata, responses_metadata_template, detached_memory_responses_metadata); 1 external calls (new).


##### `CodexResponsesMetadata::has_turn_metadata`  (lines 177–179)

```
fn has_turn_metadata(&self) -> bool
```

**Purpose**: Checks whether this metadata object has enough request-kind information to produce the full Codex turn metadata blob. In practice, it means the request has been labeled as a turn, prewarm, compaction, or memory request.

**Data flow**: It reads the request_kind field from the metadata object. If that field is present, it returns true; otherwise it returns false. It does not change anything.

**Call relations**: The client metadata and compatibility header builders call this before adding x-codex-turn-metadata. That keeps incomplete metadata objects from sending a misleading or premature turn metadata blob.

*Call graph*: called by 2 (client_metadata, compatibility_headers).


##### `CodexResponsesMetadata::turn_metadata_json`  (lines 181–183)

```
fn turn_metadata_json(&self) -> Option<String>
```

**Purpose**: Builds the canonical Codex turn metadata blob as an ASCII JSON string. This is the main serialized form sent under x-codex-turn-metadata.

**Data flow**: It first asks turn_metadata_payload to assemble the structured payload from the current metadata fields. Then it converts that payload into an ASCII-only JSON string. If serialization succeeds, it returns the string; if not, it returns nothing.

**Call relations**: Both client_metadata and compatibility_headers call this when they need to attach the full turn metadata blob. It is the bridge between the in-memory metadata object and the wire format sent to the Responses API.

*Call graph*: calls 1 internal fn (turn_metadata_payload); called by 2 (client_metadata, compatibility_headers); 1 external calls (to_ascii_json_string).


##### `CodexResponsesMetadata::turn_metadata_value`  (lines 185–187)

```
fn turn_metadata_value(&self) -> Option<Value>
```

**Purpose**: Builds the same Codex turn metadata payload as a serde_json Value, which is a generic JSON value used inside Rust. This is useful when code wants structured JSON rather than a string.

**Data flow**: It asks turn_metadata_payload for the current structured payload, then converts that payload into a JSON value. If conversion succeeds, it returns that value; otherwise it returns nothing.

**Call relations**: This function uses the same payload-building path as turn_metadata_json, so callers get the same metadata content in a different form. It is not part of the listed outgoing request-building calls, but it provides a structured view for code that needs one.

*Call graph*: calls 1 internal fn (turn_metadata_payload); 1 external calls (to_value).


##### `CodexResponsesMetadata::client_metadata`  (lines 189–220)

```
fn client_metadata(&self) -> HashMap<String, String>
```

**Purpose**: Creates the flat client_metadata map sent with a Responses API request. This includes core identifiers and, when available, the full x-codex-turn-metadata JSON blob.

**Data flow**: It reads the metadata object and starts a string-to-string map with installation ID, session ID, thread ID, and window ID. It adds optional fields such as turn ID, subagent header, parent thread ID, and the serialized turn metadata when those are present. The finished map is returned.

**Call relations**: Request-building code calls this when constructing normal Responses requests or WebSocket client metadata. It packages the metadata into the format expected by the API client.

*Call graph*: calls 2 internal fn (has_turn_metadata, turn_metadata_json); called by 2 (build_responses_request, build_ws_client_metadata); 1 external calls (from).


##### `CodexResponsesMetadata::compatibility_headers`  (lines 222–247)

```
fn compatibility_headers(&self) -> ApiHeaderMap
```

**Purpose**: Creates older-style HTTP headers that mirror selected metadata fields. These headers exist for compatibility, while newer consumers should prefer the client_metadata form.

**Data flow**: It starts with an empty HTTP header map. It inserts the window ID, optionally inserts the serialized turn metadata, and also adds parent-thread and subagent headers when present. Invalid header values are quietly skipped by insert_header, and the finished header map is returned.

**Call relations**: The compatibility-header builder calls this when an outgoing request still needs direct HTTP headers. It reuses the same turn_metadata_json output as client_metadata, so both formats come from the same source.

*Call graph*: calls 3 internal fn (has_turn_metadata, turn_metadata_json, insert_header); called by 1 (build_responses_compatibility_headers); 1 external calls (new).


##### `CodexResponsesMetadata::turn_metadata_payload`  (lines 249–280)

```
fn turn_metadata_payload(&self) -> CodexTurnMetadataPayload<'_>
```

**Purpose**: Assembles the structured contents of the Codex turn metadata blob. It decides exactly which fields belong in the JSON before serialization happens.

**Data flow**: It reads the metadata object, translates the request kind into a label and optional compaction details, and decides whether turn identity fields should be included. It includes workspace data only when the workspace map is not empty, carries through extra metadata, and returns a lightweight payload object that borrows from the original metadata.

**Call relations**: turn_metadata_json and turn_metadata_value call this before converting metadata into JSON. It is the central rulebook for what appears inside x-codex-turn-metadata.

*Call graph*: calls 1 internal fn (non_empty_workspaces); called by 2 (turn_metadata_json, turn_metadata_value).


##### `subagent_header_value`  (lines 283–302)

```
fn subagent_header_value(session_source: &SessionSource) -> Option<String>
```

**Purpose**: Converts a session source into the short subagent header value used on requests. This tells the receiving side whether the request came from a review agent, compact agent, memory consolidation, thread spawn, or another labeled subagent.

**Data flow**: It receives a SessionSource. If the source represents a subagent or internal memory consolidation, it returns the appropriate text label. If the source is a normal client such as CLI, VS Code, exec, MCP, custom, or unknown, it returns nothing.

**Call relations**: Metadata-building and subagent-header code call this when preparing request metadata. Its result may be stored in CodexResponsesMetadata and later emitted through client metadata or compatibility headers.

*Call graph*: called by 4 (build_subagent_headers, responses_metadata, new, detached_memory_responses_metadata).


##### `subagent_metadata_kind`  (lines 304–315)

```
fn subagent_metadata_kind(session_source: &SessionSource) -> Option<String>
```

**Purpose**: Extracts the broader subagent kind for the structured turn metadata blob. This is separate from the HTTP-style subagent header value.

**Data flow**: It receives a SessionSource. If the source is a SubAgent, it asks that subagent source for its kind and returns it as text. For normal, internal, custom, or unknown sources, it returns nothing.

**Call relations**: Metadata construction code calls this when filling CodexResponsesMetadata. The resulting value can later be included in the turn metadata payload as subagent_kind.

*Call graph*: called by 1 (new).


##### `insert_header`  (lines 317–321)

```
fn insert_header(headers: &mut ApiHeaderMap, name: &'static str, value: &str)
```

**Purpose**: Safely inserts one string value into an HTTP header map. It avoids adding the header if the value cannot legally be used as an HTTP header value.

**Data flow**: It receives a mutable header map, a header name, and a string value. It tries to convert the string into an HTTP HeaderValue. If that succeeds, it inserts the header into the map; if it fails, the map is left unchanged for that header.

**Call relations**: compatibility_headers uses this helper for every compatibility header it emits. This keeps header creation safe and keeps invalid metadata values from breaking request construction.

*Call graph*: called by 1 (compatibility_headers); 2 external calls (insert, from_str).


##### `filter_extra_metadata`  (lines 323–328)

```
fn filter_extra_metadata(extra: HashMap<String, String>) -> BTreeMap<String, String>
```

**Purpose**: Removes caller-provided metadata entries that try to use Codex-reserved names. This protects core request fields from being overwritten by extra app-server metadata.

**Data flow**: It receives a HashMap of extra string metadata. It walks through every key-value pair and keeps only entries whose key is not in the reserved list. It returns the filtered entries in a sorted BTreeMap.

**Call relations**: set_responsesapi_client_metadata calls this when accepting extra metadata from outside callers. The filtered result can then be merged into the turn metadata blob without risking conflicts with Codex-owned fields.

*Call graph*: called by 1 (set_responsesapi_client_metadata).


##### `non_empty_workspaces`  (lines 330–334)

```
fn non_empty_workspaces(
    workspaces: &BTreeMap<String, TurnMetadataWorkspace>,
) -> Option<&BTreeMap<String, TurnMetadataWorkspace>>
```

**Purpose**: Includes workspace metadata only when there is something to say. This keeps the serialized JSON from containing an empty workspaces field.

**Data flow**: It receives the workspace map by reference. If the map is empty, it returns nothing. If the map has entries, it returns a reference to that same map.

**Call relations**: turn_metadata_payload calls this while building the metadata blob. It is a small cleanup step that keeps outgoing metadata compact and avoids meaningless empty fields.

*Call graph*: called by 1 (turn_metadata_payload).


### `codex-api/src/requests/responses.rs`

`io_transport` · `request handling`

This file sits at the boundary between the project’s internal Rust data and the JSON sent to an API. JSON is a flexible text-like format used for exchanging data, while `ResponseItem` is the project’s structured Rust version of a response item. When the system turns structured items into JSON, some item IDs may need to be copied back onto the outgoing JSON so the API can recognize or continue tracking the same conversation pieces. Without this step, later parts of the conversation could lose their identity, a bit like mailing several forms without their reference numbers attached.

The file also defines a small `Compression` choice, saying whether data should be left uncompressed or compressed with Zstandard (`Zstd`, a common compression method that makes data smaller). In the shown code, this is just a simple option type, not active behavior.

The key function, `attach_item_ids`, looks inside a JSON payload for an `input` array. It then walks through that JSON array side by side with the original `ResponseItem` list. For item kinds that can carry an ID, it copies a non-empty ID into the matching JSON object. It is deliberately cautious: if the payload does not have the expected shape, or an ID is missing or empty, it simply leaves that part unchanged.

#### Function details

##### `attach_item_ids`  (lines 11–37)

```
fn attach_item_ids(payload_json: &mut Value, original_items: &[ResponseItem])
```

**Purpose**: This function copies known item IDs from the original structured response items into the matching JSON objects in an outgoing payload. It is used so the JSON sent onward preserves the identity of messages, tool calls, reasoning items, and similar conversation pieces.

**Data flow**: It receives a mutable JSON payload and a list of original `ResponseItem` values. It looks for an `input` field in the JSON, checks that it is an array, then pairs each JSON array entry with the corresponding original item. If the original item has a non-empty ID and the JSON entry is an object, it inserts that ID into the JSON object. The function returns nothing; its result is the changed JSON payload.

**Call relations**: This function is called during request preparation, after the system already has both the JSON payload and the original response items. Internally it uses standard JSON and collection operations to find the `input` field, walk through the items, and create string keys when inserting IDs. It does not call other project-specific helpers; it acts as a small final repair step before the payload moves on.

*Call graph*: 3 external calls (String, get_mut, iter).


### `tools/src/responses_api.rs`

`io_transport` · `tool registration and request preparation`

The system has tools from more than one source. Some are dynamic tools defined by the Codex protocol, and some come from MCP, the Model Context Protocol, which is a standard way for external services to offer tools. The Responses API expects these tools to be described in a particular format: each tool needs a name, a description, input parameters as a JSON schema, and a few extra flags.

This file provides the shared structures for that API-facing shape, such as `ResponsesApiTool`, `LoadableToolSpec`, and `ResponsesApiNamespace`. A namespace is a named group of tools, like a labeled drawer in a toolbox. The file also contains conversion functions that take a tool from another format, parse it into the project's common `ToolDefinition`, and then turn that into a `ResponsesApiTool`.

One important behavior is namespace coalescing. If several tool groups have the same namespace name, `coalesce_loadable_tool_specs` merges their tool lists instead of leaving duplicate namespaces. Without this file, the rest of the system would need to know the details of every tool source and the exact JSON layout expected by the Responses API, which would make tool loading harder to keep consistent.

#### Function details

##### `default_namespace_description`  (lines 58–60)

```
fn default_namespace_description(namespace_name: &str) -> String
```

**Purpose**: Creates a simple fallback description for a group of tools when no custom description is supplied. This keeps namespace descriptions predictable and human-readable.

**Data flow**: It receives a namespace name as text. It inserts that name into the sentence "Tools in the ... namespace." and returns the finished sentence.

**Call relations**: This is a small helper used when building Responses API namespace information. It does not call into the rest of this file; it only formats a standard description string.

*Call graph*: 1 external calls (format!).


##### `dynamic_tool_to_responses_api_tool`  (lines 69–75)

```
fn dynamic_tool_to_responses_api_tool(
    tool: &DynamicToolFunctionSpec,
) -> Result<ResponsesApiTool, serde_json::Error>
```

**Purpose**: Turns a dynamic Codex tool description into a tool description suitable for the Responses API. Someone would use it when a tool is defined dynamically but still needs to be advertised to the API in the standard format.

**Data flow**: It receives a `DynamicToolFunctionSpec`, which is the Codex protocol's description of a tool. It first asks `parse_dynamic_tool` to turn that into the project's common `ToolDefinition`; if that parsing fails, the error is returned. If parsing succeeds, it passes the common definition into `tool_definition_to_responses_api_tool` and returns the resulting `ResponsesApiTool`.

**Call relations**: This function sits at the edge between dynamic tool definitions and the Responses API format. It relies on `parse_dynamic_tool` to understand the incoming dynamic format, then hands the normalized result to `tool_definition_to_responses_api_tool` for the final API-facing conversion.

*Call graph*: calls 1 internal fn (tool_definition_to_responses_api_tool); 1 external calls (parse_dynamic_tool).


##### `coalesce_loadable_tool_specs`  (lines 77–105)

```
fn coalesce_loadable_tool_specs(
    specs: impl IntoIterator<Item = LoadableToolSpec>,
) -> Vec<LoadableToolSpec>
```

**Purpose**: Combines tool specifications so that namespaces with the same name are merged into one namespace. This prevents the final tool list from containing several separate groups with the same label.

**Data flow**: It receives any iterable collection of `LoadableToolSpec` values. It walks through them in order. Plain function tools are copied into the output as-is. Namespace specs are either added as new namespaces or, if a namespace with the same name already exists, their tools are appended to the existing namespace. It returns the cleaned-up list.

**Call relations**: This function is used after tools have already been shaped as loadable Responses API specs. It does not convert individual tools; instead, it organizes the list so later code can send or load a simpler, consolidated set of tool groups.

*Call graph*: 3 external calls (new, Function, Namespace).


##### `mcp_tool_to_responses_api_tool`  (lines 107–114)

```
fn mcp_tool_to_responses_api_tool(
    tool_name: &ToolName,
    tool: &rmcp::model::Tool,
) -> Result<ResponsesApiTool, serde_json::Error>
```

**Purpose**: Turns an MCP tool into a normal Responses API tool description. It also applies the project’s chosen tool name, which may differ from the original name supplied by the MCP server.

**Data flow**: It receives a `ToolName` and an MCP `Tool`. It asks `parse_mcp_tool` to convert the MCP tool into the project's common `ToolDefinition`; if that fails, the error is returned. It then renames the parsed definition to match `ToolName`, converts it with `tool_definition_to_responses_api_tool`, and returns the finished API tool.

**Call relations**: This function is the normal path for MCP tools that should be fully described up front. It depends on `parse_mcp_tool` to understand the MCP format, then uses `tool_definition_to_responses_api_tool` to produce the Responses API structure.

*Call graph*: calls 1 internal fn (tool_definition_to_responses_api_tool); 1 external calls (parse_mcp_tool).


##### `mcp_tool_to_deferred_responses_api_tool`  (lines 116–125)

```
fn mcp_tool_to_deferred_responses_api_tool(
    tool_name: &ToolName,
    tool: &rmcp::model::Tool,
) -> Result<ResponsesApiTool, serde_json::Error>
```

**Purpose**: Turns an MCP tool into a Responses API tool description marked for deferred loading. Deferred loading means the tool details can be treated as not fully loaded until later, which is useful when tools are discovered or expanded lazily.

**Data flow**: It receives a `ToolName` and an MCP `Tool`. It parses the MCP tool into a common `ToolDefinition`, renames it to the project’s chosen name, marks it as deferred, and then converts it into a `ResponsesApiTool`. If parsing fails, it returns the JSON-related error instead of a tool.

**Call relations**: This is the deferred-loading version of `mcp_tool_to_responses_api_tool`. Like the normal version, it starts with `parse_mcp_tool` and finishes through `tool_definition_to_responses_api_tool`, but it changes the intermediate tool definition so the final API object carries the deferred-loading flag.

*Call graph*: calls 1 internal fn (tool_definition_to_responses_api_tool); 1 external calls (parse_mcp_tool).


##### `tool_definition_to_responses_api_tool`  (lines 127–136)

```
fn tool_definition_to_responses_api_tool(tool_definition: ToolDefinition) -> ResponsesApiTool
```

**Purpose**: Converts the project's common internal tool description into the exact structure used for the Responses API. This is the central final step shared by the other conversion functions.

**Data flow**: It receives a `ToolDefinition` containing the tool name, description, input JSON schema, optional output schema, and deferred-loading setting. It copies those fields into a new `ResponsesApiTool`, sets `strict` to false, turns the deferred-loading boolean into an optional API field, and returns the new tool object.

**Call relations**: This function is called by the dynamic-tool and MCP-tool conversion paths after they have parsed their source-specific formats. It is the common exit point that ensures all tool sources end up with the same Responses API shape.

*Call graph*: called by 3 (dynamic_tool_to_responses_api_tool, mcp_tool_to_deferred_responses_api_tool, mcp_tool_to_responses_api_tool).


### `codex-api/src/api_bridge.rs`

`domain_logic` · `request handling`

When Codex talks to an API, many things can go wrong: the request may be too large, the server may be overloaded, the user may have hit a usage limit, the network may time out, or the API may return a detailed error hidden inside a JSON body or an HTTP header. This file is the translator for those situations.

Its main job is to take an internal `ApiError` and convert it into a `CodexErr`, which is the error shape expected by the rest of the Codex system. Think of it like an interpreter at a help desk: it listens to many different ways the API can say “no” or “try later,” then rewrites that into a standard form the application knows how to display or react to.

The most important function, `map_api_error`, looks at the kind of failure and preserves useful details where it can. For example, it recognizes when a 429 “too many requests” response is really a usage-limit problem, extracts reset times and plan information, and includes rate-limit details from headers. It also catches special cases such as server overload, invalid image uploads, cybersecurity policy blocks, request timeouts, and unexpected statuses.

The smaller helper functions read useful tracking information from HTTP headers, such as request IDs or Cloudflare ray IDs. Those IDs matter because they help support teams and logs connect a user-visible failure to the exact request that failed.

#### Function details

##### `map_api_error`  (lines 18–137)

```
fn map_api_error(err: ApiError) -> CodexErr
```

**Purpose**: This function converts an `ApiError` into a `CodexErr`, which is the error format used outside the API layer. It keeps important details such as status codes, retry information, usage-limit reset times, and request tracking IDs so the caller can respond properly.

**Data flow**: It receives one API-side error. It inspects the error kind, and for HTTP failures it also reads the status code, response body, URL, and headers. It then matches known cases such as bad requests, server overload, rate limits, timeouts, and policy blocks, sometimes parsing JSON from the response body or headers. The result is a single `CodexErr` value that carries the clearest available explanation and any useful supporting details.

**Call relations**: This is the central bridge function in the file. When it needs extra information from HTTP headers, it asks `extract_header`, `extract_request_id`, `extract_request_tracking_id`, or `extract_x_error_json_code` to pull out those details. It also uses rate-limit parsing helpers from the rate limit module when a usage limit has been reached, so the final error can include more than just “too many requests.”

*Call graph*: calls 4 internal fn (extract_header, extract_request_id, extract_request_tracking_id, extract_x_error_json_code); 7 external calls (matches!, InvalidImageRequest, InvalidRequest, RetryLimit, Stream, UnexpectedStatus, UsageLimitReached).


##### `extract_request_tracking_id`  (lines 153–155)

```
fn extract_request_tracking_id(headers: Option<&HeaderMap>) -> Option<String>
```

**Purpose**: This function finds the best available ID for tracking a failed request. It first looks for a normal request ID, and if that is missing it falls back to the Cloudflare ray ID, another identifier that can help trace a request through infrastructure.

**Data flow**: It receives optional HTTP headers. It asks `extract_request_id` for the preferred request identifier. If that returns nothing, it tries to read the `cf-ray` header instead. It returns either a tracking string or nothing if no useful header is present.

**Call relations**: It is called by `map_api_error` when building retry-limit errors. In that situation, the caller may not need all response details, but it still benefits from a compact tracking ID that can be shown in logs or support messages.

*Call graph*: calls 1 internal fn (extract_request_id); called by 1 (map_api_error).


##### `extract_request_id`  (lines 157–160)

```
fn extract_request_id(headers: Option<&HeaderMap>) -> Option<String>
```

**Purpose**: This function looks for the standard request identifier headers used by the API. It checks both the common request ID header and an OpenAI-specific alternative.

**Data flow**: It receives optional HTTP headers. It tries to read `x-request-id`; if that is not present or not readable, it tries `x-oai-request-id`. It returns the first valid string it finds, or nothing if neither header is available.

**Call relations**: It is used directly by `map_api_error` when reporting unexpected HTTP statuses, and indirectly through `extract_request_tracking_id` for retry-limit errors. It relies on `extract_header` for the actual safe reading of a named header.

*Call graph*: calls 1 internal fn (extract_header); called by 2 (extract_request_tracking_id, map_api_error).


##### `extract_header`  (lines 162–168)

```
fn extract_header(headers: Option<&HeaderMap>, name: &str) -> Option<String>
```

**Purpose**: This small helper safely reads one named HTTP header as text. It avoids crashes or invalid text by returning nothing when the header is missing or cannot be converted into a normal string.

**Data flow**: It receives optional HTTP headers and the name of the header to read. If the headers exist, it looks up that name, checks that the value is valid text, and copies it into a new string. The output is either that string or nothing.

**Call relations**: This is the basic header-reading tool used by the rest of the file. `map_api_error` calls it for details such as Cloudflare ray IDs and authorization errors, `extract_request_id` uses it to check request ID headers, and `extract_x_error_json_code` uses it before decoding the special error header.

*Call graph*: called by 3 (extract_request_id, extract_x_error_json_code, map_api_error).


##### `extract_x_error_json_code`  (lines 170–181)

```
fn extract_x_error_json_code(headers: Option<&HeaderMap>) -> Option<String>
```

**Purpose**: This function reads a special header that contains encoded JSON error information and extracts the error code from it. It is used when the API has put structured error details in a header instead of only in the response body.

**Data flow**: It receives optional HTTP headers. It first reads the `x-error-json` header, then decodes it from base64, which is a text-safe way to pack raw data into a header. It parses the decoded bytes as JSON and looks for `error.code`. If every step succeeds, it returns that code as text; if any step fails, it returns nothing.

**Call relations**: It is called by `map_api_error` while building an unexpected-status error. That lets the final `CodexErr` carry an identity or authorization error code when the server supplied one in this encoded header.

*Call graph*: calls 1 internal fn (extract_header); called by 1 (map_api_error).


### Responses and endpoint clients
These files implement the concrete HTTP, SSE, and WebSocket clients for Responses and adjacent provider endpoints that the core client can invoke.

### `codex-api/src/endpoint/responses.rs`

`io_transport` · `request handling`

This file is about one job: take a request for the Responses API, package it correctly, send it over HTTP, and return a live stream of events from the server. Without it, the rest of the system could build response requests, but it would not know how to address the right endpoint, add the right authentication/session headers, request streaming output, or decode the server’s event stream.

The main type is `ResponsesClient`. It owns an `EndpointSession`, which is the lower-level piece that knows how to talk to a provider using an HTTP transport and authentication. `ResponsesClient` adds Responses-specific behavior on top: it always posts to the `responses` path, asks for `text/event-stream` data, optionally compresses the request body, and can attach telemetry so the system can observe request and stream behavior.

There are two ways to send data. `stream_request` accepts a structured `ResponsesApiRequest` and builds the final JSON body and headers. It has special Azure behavior: when storing a response through Azure’s Responses endpoint, it adds item IDs into the JSON body before sending. `stream` is a more direct escape hatch for callers that already have raw JSON. Both routes end in `stream_encoded`, which does the common HTTP work and then starts the server-sent-event stream. A server-sent event stream is like a live news ticker: the server sends small pieces over time instead of one finished answer.

#### Function details

##### `ResponsesClient::new`  (lines 43–48)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a new Responses API client from an HTTP transport, a provider description, and shared authentication. Callers use this when they are ready to talk to the Responses endpoint.

**Data flow**: It receives the network transport, provider settings, and authentication provider. It wraps them in an `EndpointSession`, starts with no streaming telemetry attached, and returns a ready-to-use `ResponsesClient`.

**Call relations**: Tests and higher-level setup code call this first to create the client. The client it returns is then used for streaming requests, including checks around authentication, retries, correct endpoint paths, and end-to-end streamed response parsing.

*Call graph*: calls 1 internal fn (new); called by 8 (azure_default_store_attaches_ids_and_headers, responses_client_stream_request_preserves_exact_json_body, responses_client_uses_responses_path, streaming_client_adds_auth_headers, streaming_client_does_not_retry_auth_build_error, streaming_client_retries_on_transient_auth_error, streaming_client_retries_on_transport_error, responses_stream_parses_items_and_completed_end_to_end).


##### `ResponsesClient::with_telemetry`  (lines 50–59)

```
fn with_telemetry(
        self,
        request: Option<Arc<dyn RequestTelemetry>>,
        sse: Option<Arc<dyn SseTelemetry>>,
    ) -> Self
```

**Purpose**: Returns a copy of the client with optional telemetry added. Telemetry means observation hooks that record what happened during requests and streamed responses.

**Data flow**: It takes an existing client plus optional request telemetry and optional stream telemetry. It passes the request telemetry into the underlying session, stores the stream telemetry on the client, and returns the updated client.

**Call relations**: This is used after creating a client when the caller wants monitoring. Later, when a request is sent, the stored request telemetry is used by the session and the stored stream telemetry is passed into the response-stream machinery.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `ResponsesClient::stream_request`  (lines 71–107)

```
async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        options: ResponsesOptions,
    ) -> Result<ResponseStream, ApiError>
```

**Purpose**: Sends a normal structured Responses API request and returns a live response stream. It is the main high-level method for callers that have a `ResponsesApiRequest` rather than raw JSON.

**Data flow**: It receives the request plus options such as session ID, thread ID, source information, extra headers, compression choice, and shared turn state. It turns the request into JSON, adds Azure-specific item IDs when required, builds the needed headers, and then hands the encoded body and headers to `stream_encoded`. The output is either a `ResponseStream` or an API error explaining what failed.

**Call relations**: This method sits above `stream_encoded`. It prepares the Responses-specific request details first: encoding the request, adding session headers, adding a client request ID from the thread ID, and adding a subagent header when the session source calls for it. Once the request is fully prepared, it delegates the actual HTTP streaming work to `stream_encoded`.

*Call graph*: calls 6 internal fn (stream_encoded, provider, build_session_headers, insert_header, subagent_header, encode); 2 external calls (attach_item_ids, to_value).


##### `ResponsesClient::path`  (lines 109–111)

```
fn path() -> &'static str
```

**Purpose**: Gives the fixed API path used by this client: `responses`. Keeping it in one small function avoids repeating the endpoint string in multiple places.

**Data flow**: It takes no input and returns the static path string used for the Responses API endpoint.

**Call relations**: The lower-level sending code uses this when building the HTTP request. This keeps the client consistently pointed at the Responses endpoint.


##### `ResponsesClient::stream`  (lines 124–135)

```
async fn stream(
        &self,
        body: Value,
        extra_headers: HeaderMap,
        compression: Compression,
        turn_state: Option<Arc<OnceLock<String>>>,
    ) -> Result<ResponseStre
```

**Purpose**: Sends a raw JSON body to the Responses endpoint and returns a live response stream. This is useful when the caller already has the exact JSON it wants to send.

**Data flow**: It receives a JSON value, extra headers, a compression choice, and optional turn state. It encodes the JSON body, reports an API error if encoding fails, and then passes the encoded body to `stream_encoded`. The result is a streamed response or an error.

**Call relations**: This is the simpler sibling of `stream_request`. It skips the structured request and session-header building done by `stream_request`, then joins the same common path by calling `stream_encoded`.

*Call graph*: calls 2 internal fn (stream_encoded, encode).


##### `ResponsesClient::stream_encoded`  (lines 137–172)

```
async fn stream_encoded(
        &self,
        body: EncodedJsonBody,
        extra_headers: HeaderMap,
        compression: Compression,
        turn_state: Option<Arc<OnceLock<String>>>,
    ) -> R
```

**Purpose**: Does the shared low-level work of sending an already encoded request body and turning the HTTP response into a usable event stream. Both public streaming methods rely on it.

**Data flow**: It receives an encoded JSON body, headers, a compression setting, and optional shared turn state. It translates the file’s compression option into the transport layer’s compression option, sends a POST request to the `responses` path, adds an `Accept: text/event-stream` header so the server knows to stream events, and then wraps the HTTP stream with timeout and telemetry support. It returns a `ResponseStream` or passes back any API error from the session.

**Call relations**: `stream_request` and `stream` both hand off to this function after preparing the body. It calls the underlying session to perform the HTTP request, then gives the raw streaming response to `spawn_response_stream`, which is responsible for reading server-sent events over time and applying stream telemetry, idle timeout behavior, and turn-state tracking.

*Call graph*: calls 2 internal fn (provider, stream_encoded_json_with); called by 2 (stream, stream_request); 2 external calls (path, spawn_response_stream).


### `codex-api/src/sse/responses.rs`

`io_transport` · `request handling: active while a Responses API stream is being read`

When the server sends a response, it arrives as a sequence of small text events over a server-sent events stream, often called SSE: a simple web format for sending updates one after another. This file is the translator at that boundary. It reads the raw stream, pulls useful header information such as the model name, request id, rate limits, and model metadata, then emits cleaner internal events like “text delta arrived”, “tool call input arrived”, “response completed”, or “quota exceeded”.

The main flow starts with `spawn_response_stream`, which creates a background task and a channel. Think of the channel like a conveyor belt: the background task puts parsed events on it, and the rest of the app takes them off. `process_sse` then keeps reading the byte stream, applies an idle timeout so it does not wait forever, parses each SSE message as JSON, extracts side metadata, and hands normal response events to `process_responses_event`.

The file is also careful about errors. Some server failures are not all the same: a too-large prompt, exhausted quota, cyber-safety block, overloaded server, and rate limit each become a different `ApiError`. That distinction matters because callers may retry some failures but must stop or show a specific message for others.

#### Function details

##### `spawn_response_stream`  (lines 31–88)

```
fn spawn_response_stream(
    stream_response: StreamResponse,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
    turn_state: Option<Arc<OnceLock<String>>>,
) -> ResponseStr
```

**Purpose**: Starts reading a streamed response in the background and returns a `ResponseStream` that the rest of the app can receive events from. It also immediately forwards useful response headers, such as model name, rate limits, model list tag, and request id.

**Data flow**: It receives a `StreamResponse` containing headers and a byte stream, plus timeout, optional telemetry, and optional shared turn-state storage. It reads metadata from the headers, creates a channel, starts an async task, sends header-derived events into the channel, then passes the raw byte stream to `process_sse`. It returns the receiving side of the channel and the upstream request id.

**Call relations**: This is the entry point for this file's streaming work. Tests call it to verify header behavior, and in real use it hands off the long-running stream parsing to `process_sse` inside a spawned task.

*Call graph*: calls 2 internal fn (parse_all_rate_limits, process_sse); called by 2 (spawn_response_stream_emits_header_events, spawn_response_stream_ignores_model_verification_header); 5 external calls (ModelsEtag, RateLimits, ServerModel, ServerReasoningIncluded, spawn).


##### `TokenUsage::from`  (lines 120–134)

```
fn from(val: ResponseCompletedUsage) -> Self
```

**Purpose**: Converts the server's completed-response usage format into the project's common token-usage format. This lets the rest of the system use one shape for token counts.

**Data flow**: It receives a `ResponseCompletedUsage` value from parsed JSON. It copies total input, output, and total token counts, fills in cached input tokens and reasoning output tokens when those details are present, and uses zero when they are absent. It returns a `TokenUsage` value.

**Call relations**: It is used when `process_responses_event` parses a `response.completed` event and needs to include usage information in the internal completion event.


##### `ResponsesStreamEvent::kind`  (lines 163–165)

```
fn kind(&self) -> &str
```

**Purpose**: Returns the event type string, such as `response.completed` or `response.metadata`. Other helpers use this to decide whether an event can contain certain metadata.

**Data flow**: It reads the `kind` field already deserialized from JSON and returns it as a borrowed string. It does not change the event.

**Call relations**: The metadata helpers call this before looking for turn state, model verification, or moderation metadata, so they only read those fields from the right kind of event.

*Call graph*: called by 3 (model_verifications, turn_moderation_metadata, turn_state).


##### `ResponsesStreamEvent::response_model`  (lines 172–186)

```
fn response_model(&self) -> Option<String>
```

**Purpose**: Finds the effective server model name reported inside a stream event, if one is present. It prefers model information attached to the response itself, then falls back to top-level headers.

**Data flow**: It looks inside `response.headers` first and then `headers`, checking for model header names regardless of letter case. If a value is found, it returns the model name as a string; otherwise it returns nothing.

**Call relations**: `process_sse` calls this for every parsed event so it can emit a `ServerModel` event when the server reports or changes the model.


##### `ResponsesStreamEvent::turn_state`  (lines 188–196)

```
fn turn_state(&self) -> Option<String>
```

**Purpose**: Extracts the Codex turn state from metadata events. Turn state is extra server-provided state about the current conversation turn.

**Data flow**: It first checks that the event type is `response.metadata`. If so, it looks in the event's headers for the turn-state header and returns its string value if present.

**Call relations**: It relies on `kind` to avoid reading irrelevant events. This helper is available to stream users, although this file's main loop currently extracts turn state from initial response headers instead.

*Call graph*: calls 1 internal fn (kind).


##### `ResponsesStreamEvent::model_verifications`  (lines 198–207)

```
fn model_verifications(&self) -> Option<Vec<ModelVerification>>
```

**Purpose**: Reads model verification recommendations from a metadata event. These recommendations tell the rest of the system about special verification status, such as trusted cyber access.

**Data flow**: It checks that the event is `response.metadata`, then looks under `metadata.openai_verification_recommendation`. It parses known string values into `ModelVerification` entries, removes duplicates, and returns them only if at least one known value was found.

**Call relations**: `process_sse` calls this on each stream event and sends a `ModelVerifications` event when the server includes recognized recommendations.

*Call graph*: calls 1 internal fn (kind).


##### `ResponsesStreamEvent::turn_moderation_metadata`  (lines 209–219)

```
fn turn_moderation_metadata(&self) -> Option<TurnModerationMetadataEvent>
```

**Purpose**: Pulls moderation metadata for the current turn out of a metadata event. This gives callers extra safety or presentation information from the server.

**Data flow**: It checks that the event type is `response.metadata`, then looks for `metadata.openai_chatgpt_moderation_metadata`. If found, it clones that JSON value into a `TurnModerationMetadataEvent`.

**Call relations**: `process_sse` calls this while reading the stream and forwards the result as a `TurnModerationMetadata` event.

*Call graph*: calls 1 internal fn (kind).


##### `header_openai_model_value_from_json`  (lines 222–232)

```
fn header_openai_model_value_from_json(value: &Value) -> Option<String>
```

**Purpose**: Finds an OpenAI model header inside a JSON object that represents headers. It accepts both `openai-model` and `x-openai-model`, ignoring letter case.

**Data flow**: It receives a JSON value, treats it as an object if possible, scans its header names, and converts the matching header value into a string. If the JSON is not an object or no matching header exists, it returns nothing.

**Call relations**: `ResponsesStreamEvent::response_model` uses this to read model names from both response-level and top-level header JSON.

*Call graph*: 1 external calls (as_object).


##### `header_turn_state_value_from_json`  (lines 234–243)

```
fn header_turn_state_value_from_json(value: &Value) -> Option<String>
```

**Purpose**: Finds the Codex turn-state header inside a JSON header object. This helps extract conversation-turn state from metadata-like payloads.

**Data flow**: It receives a JSON value, checks that it is an object, searches for the configured turn-state header name ignoring letter case, and returns its string value if present.

**Call relations**: `ResponsesStreamEvent::turn_state` uses this after confirming that the event is a metadata event.

*Call graph*: 1 external calls (as_object).


##### `model_verifications_from_json_value`  (lines 245–268)

```
fn model_verifications_from_json_value(value: &Value) -> Option<Vec<ModelVerification>>
```

**Purpose**: Turns a JSON list of verification recommendation strings into typed `ModelVerification` values. It ignores unknown entries and avoids returning duplicates.

**Data flow**: It receives a JSON value, reads it as an array when possible, keeps only string items, parses known verification names, and collects unique results. It returns `None` when nothing recognized was found.

**Call relations**: `ResponsesStreamEvent::model_verifications` calls this after locating the verification field inside event metadata.

*Call graph*: 1 external calls (as_array).


##### `parse_model_verification`  (lines 270–275)

```
fn parse_model_verification(value: &str) -> Option<ModelVerification>
```

**Purpose**: Recognizes one model verification string and maps it to the project's enum value. Currently it knows the trusted-access-for-cyber recommendation.

**Data flow**: It receives a string from server metadata. If it matches the known trusted cyber access value, it returns the corresponding `ModelVerification`; otherwise it returns nothing.

**Call relations**: `model_verifications_from_json_value` calls this for each string in the metadata array.


##### `json_value_as_string`  (lines 277–283)

```
fn json_value_as_string(value: &Value) -> Option<String>
```

**Purpose**: Extracts a string from a JSON header value, including the common case where a header value is represented as a one-item array. This makes header parsing tolerant of slightly different JSON shapes.

**Data flow**: It receives a JSON value. If it is a string, it clones and returns it; if it is an array, it tries the first item; for other JSON types it returns nothing.

**Call relations**: The header-reading helpers use this so they can accept both plain string headers and array-style headers.

*Call graph*: 1 external calls (clone).


##### `ResponsesEventError::into_api_error`  (lines 291–295)

```
fn into_api_error(self) -> ApiError
```

**Purpose**: Unwraps this file's local response-event error into the shared `ApiError` type. This keeps the public error shape consistent for callers.

**Data flow**: It receives a `ResponsesEventError`. If it contains an API error, it returns that API error.

**Call relations**: `process_sse` uses this when `process_responses_event` reports a response failure, storing the underlying API error for later emission.


##### `process_responses_event`  (lines 298–432)

```
fn process_responses_event(
    event: ResponsesStreamEvent,
) -> std::result::Result<Option<ResponseEvent>, ResponsesEventError>
```

**Purpose**: Converts one parsed Responses stream event into one internal `ResponseEvent`, or into a meaningful `ApiError`. This is the central event translator for normal response content and server-side failures.

**Data flow**: It receives a `ResponsesStreamEvent` parsed from JSON. It switches on the event type, extracts fields like output items, text deltas, tool input deltas, reasoning deltas, completion usage, and error details. It returns an optional internal event, or an error when the server reports failure or an incomplete response.

**Call relations**: `process_sse` calls this after parsing each SSE message. It delegates error classification to helpers such as `is_context_window_error`, `is_quota_exceeded_error`, `cyber_policy_message`, and `try_parse_retry_after`.

*Call graph*: calls 8 internal fn (cyber_policy_message, is_context_window_error, is_cyber_policy_error, is_invalid_prompt_error, is_quota_exceeded_error, is_server_overloaded_error, is_usage_not_included, try_parse_retry_after); called by 1 (process_sse); 8 external calls (OutputItemAdded, OutputItemDone, OutputTextDelta, Stream, Api, debug!, format!, trace!).


##### `process_sse`  (lines 434–529)

```
async fn process_sse(
    stream: ByteStream,
    tx_event: mpsc::Sender<Result<ResponseEvent, ApiError>>,
    idle_timeout: Duration,
    telemetry: Option<Arc<dyn SseTelemetry>>,
)
```

**Purpose**: Reads the live SSE byte stream until the response completes, fails, times out, or closes unexpectedly. It sends cleaned-up events and errors into a channel for the rest of the app.

**Data flow**: It receives a byte stream, an event sender, an idle timeout, and optional telemetry. It converts bytes into SSE events, waits for each next item with a timeout, logs or reports parse problems, extracts model and metadata side events, translates response events, and sends results through the channel. It stops after a completed response, a stream error, an idle timeout, or a closed stream.

**Call relations**: `spawn_response_stream` starts this in the background, and tests call it directly through helpers. It calls `process_responses_event` for the main event translation and sends `ServerModel`, `ModelVerifications`, and `TurnModerationMetadata` events itself.

*Call graph*: calls 1 internal fn (process_responses_event); called by 4 (spawn_response_stream, collect_events, emits_completed_without_stream_end, run_sse); 13 external calls (eventsource, next, now, send, ModelVerifications, ServerModel, TurnModerationMetadata, Stream, debug!, matches! (+3 more)).


##### `try_parse_retry_after`  (lines 531–555)

```
fn try_parse_retry_after(err: &Error) -> Option<Duration>
```

**Purpose**: Tries to pull a suggested retry delay out of a rate-limit error message. This lets callers know how long to wait before trying again.

**Data flow**: It receives a parsed server error. If the code is not `rate_limit_exceeded`, it returns nothing. Otherwise it searches the message for phrases like “try again in 11.054s”, “28ms”, or “35 seconds” and converts the number and unit into a `Duration`.

**Call relations**: `process_responses_event` uses this when turning unknown rate-limit failures into retryable API errors. Tests call it with several message formats.

*Call graph*: calls 1 internal fn (rate_limit_regex); called by 4 (process_responses_event, test_try_parse_retry_after, test_try_parse_retry_after_azure, test_try_parse_retry_after_no_delay); 2 external calls (from_millis, from_secs_f64).


##### `is_context_window_error`  (lines 557–559)

```
fn is_context_window_error(error: &Error) -> bool
```

**Purpose**: Checks whether a server error means the request was too large for the model's context window. A context window is the amount of text the model can consider at once.

**Data flow**: It reads the error code and returns true only when it is `context_length_exceeded`.

**Call relations**: `process_responses_event` uses this to emit `ContextWindowExceeded` instead of treating the failure as retryable.

*Call graph*: called by 1 (process_responses_event).


##### `is_quota_exceeded_error`  (lines 561–563)

```
fn is_quota_exceeded_error(error: &Error) -> bool
```

**Purpose**: Checks whether a server error means the account has no available quota. This is a hard stop rather than a normal transient stream failure.

**Data flow**: It reads the error code and returns true only when it is `insufficient_quota`.

**Call relations**: `process_responses_event` uses this to emit `QuotaExceeded`.

*Call graph*: called by 1 (process_responses_event).


##### `is_usage_not_included`  (lines 565–567)

```
fn is_usage_not_included(error: &Error) -> bool
```

**Purpose**: Checks whether the server rejected the request because usage information is not included. This maps a specific server code to a specific user-facing API error.

**Data flow**: It reads the error code and returns true only when it is `usage_not_included`.

**Call relations**: `process_responses_event` uses this while classifying `response.failed` events.

*Call graph*: called by 1 (process_responses_event).


##### `is_invalid_prompt_error`  (lines 569–571)

```
fn is_invalid_prompt_error(error: &Error) -> bool
```

**Purpose**: Checks whether the server says the prompt itself is invalid. This allows the caller to show the server's message instead of retrying.

**Data flow**: It reads the error code and returns true only when it is `invalid_prompt`.

**Call relations**: `process_responses_event` uses this to build an `InvalidRequest` error with the server message or a fallback.

*Call graph*: called by 1 (process_responses_event).


##### `is_cyber_policy_error`  (lines 573–575)

```
fn is_cyber_policy_error(error: &Error) -> bool
```

**Purpose**: Checks whether the request was blocked by a cybersecurity policy rule. This lets the app surface a clear safety-related message.

**Data flow**: It reads the error code and returns true only when it is `cyber_policy`.

**Call relations**: `process_responses_event` uses this with `cyber_policy_message` to create a `CyberPolicy` error.

*Call graph*: called by 1 (process_responses_event).


##### `is_server_overloaded_error`  (lines 577–580)

```
fn is_server_overloaded_error(error: &Error) -> bool
```

**Purpose**: Checks whether the server says it is overloaded or asking the client to slow down. This separates capacity problems from other stream errors.

**Data flow**: It reads the error code and returns true for `server_is_overloaded` or `slow_down`.

**Call relations**: `process_responses_event` uses this to emit `ServerOverloaded`.

*Call graph*: called by 1 (process_responses_event).


##### `cyber_policy_fallback_message`  (lines 582–584)

```
fn cyber_policy_fallback_message() -> String
```

**Purpose**: Provides a default message for cybersecurity policy blocks when the server does not send a useful one.

**Data flow**: It takes no input and returns a fixed human-readable string explaining that the request was flagged for possible cybersecurity risk.

**Call relations**: `cyber_policy_message` calls this when the server's message is missing or blank.


##### `cyber_policy_message`  (lines 586–590)

```
fn cyber_policy_message(message: Option<String>) -> String
```

**Purpose**: Chooses the message to show for a cybersecurity policy block. It preserves a non-empty server message and otherwise uses a safe default.

**Data flow**: It receives an optional string. If the string exists and is not just whitespace, it returns it; otherwise it returns `cyber_policy_fallback_message`.

**Call relations**: `process_responses_event` calls this when classifying a `cyber_policy` failure.

*Call graph*: called by 1 (process_responses_event).


##### `rate_limit_regex`  (lines 592–598)

```
fn rate_limit_regex() -> &'static regex_lite::Regex
```

**Purpose**: Builds and reuses the regular expression used to find retry delays in rate-limit messages. A regular expression is a pattern for searching text.

**Data flow**: It creates the pattern the first time it is needed and stores it in a `OnceLock`, which is a safe one-time initializer. Later calls return the same compiled pattern.

**Call relations**: `try_parse_retry_after` calls this before searching an error message for delay text.

*Call graph*: called by 1 (try_parse_retry_after); 1 external calls (new).


##### `tests::collect_events`  (lines 620–642)

```
async fn collect_events(chunks: &[&[u8]]) -> Vec<Result<ResponseEvent, ApiError>>
```

**Purpose**: Test helper that feeds raw byte chunks into `process_sse` and collects every result it sends. It lets tests simulate a streaming server without making a network request.

**Data flow**: It receives byte chunks, builds a fake async reader, wraps it as a byte stream, starts `process_sse`, and receives all channel outputs into a vector. It returns both successful response events and API errors.

**Call relations**: Many tests use this helper when they need low-level control over the exact SSE text or stream ending behavior.

*Call graph*: calls 1 internal fn (process_sse); 6 external calls (pin, new, new, new, idle_timeout, spawn).


##### `tests::run_sse`  (lines 644–673)

```
async fn run_sse(events: Vec<serde_json::Value>) -> Vec<ResponseEvent>
```

**Purpose**: Test helper that turns JSON event objects into SSE-formatted text and returns only successful `ResponseEvent` values. It makes event-focused tests shorter and easier to read.

**Data flow**: It receives JSON events, formats each as an SSE event with `event:` and `data:` lines, runs `process_sse` on that text, and collects successful events. If an error appears, the helper fails the test.

**Call relations**: Tests use this helper for normal stream scenarios where they expect parsing to succeed.

*Call graph*: calls 2 internal fn (process_sse, new); 7 external calls (pin, new, new, new, idle_timeout, format!, spawn).


##### `tests::idle_timeout`  (lines 675–677)

```
fn idle_timeout() -> Duration
```

**Purpose**: Provides a standard timeout duration for stream tests. This keeps tests consistent and avoids repeating the same number everywhere.

**Data flow**: It takes no input and returns a one-second `Duration`.

**Call relations**: The test helpers and several direct stream tests pass this value to `process_sse` or `spawn_response_stream`.

*Call graph*: 1 external calls (from_millis).


##### `tests::parses_items_and_completed`  (lines 680–743)

```
async fn parses_items_and_completed()
```

**Purpose**: Verifies that completed output items and the final completion event are parsed correctly. It checks both an item with a message phase and one without.

**Data flow**: It builds three SSE messages, collects parsed results, and asserts that two output items and one completion event come out with the expected fields.

**Call relations**: This test exercises `collect_events`, which runs `process_sse`, which in turn calls `process_responses_event`.

*Call graph*: 7 external calls (assert!, assert_eq!, assert_matches!, collect_events, format!, json!, panic!).


##### `tests::error_when_missing_completed`  (lines 746–771)

```
async fn error_when_missing_completed()
```

**Purpose**: Checks that a stream ending without `response.completed` is treated as an error. This protects callers from silently accepting an unfinished answer.

**Data flow**: It sends one output item and then ends the fake stream. It expects the item event followed by a stream error saying the stream closed before completion.

**Call relations**: It uses `collect_events` to drive `process_sse` through the premature-close path.

*Call graph*: 6 external calls (assert_eq!, assert_matches!, collect_events, format!, json!, panic!).


##### `tests::parses_tool_search_call_items`  (lines 774–807)

```
async fn parses_tool_search_call_items()
```

**Purpose**: Verifies that tool search call output items are parsed into the correct internal item type. This matters because tool calls need structured arguments, not just text.

**Data flow**: It sends a tool search call item followed by completion, then checks the call id, execution mode, and JSON arguments in the first emitted event.

**Call relations**: It uses `run_sse`, so it exercises the normal successful path through `process_sse` and `process_responses_event`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, run_sse, vec!).


##### `tests::parses_tool_call_input_deltas`  (lines 810–839)

```
async fn parses_tool_call_input_deltas()
```

**Purpose**: Checks that custom tool call input deltas are emitted as tool input updates, while unrelated function-call argument deltas are ignored here. This prevents mixing unsupported event types into the internal stream.

**Data flow**: It sends a custom tool call delta, an unhandled function call argument delta, and a completion. It expects a tool input delta followed by completion.

**Call relations**: It relies on `run_sse` and indirectly verifies the event-type matching inside `process_responses_event`.

*Call graph*: 3 external calls (assert_matches!, run_sse, vec!).


##### `tests::emits_completed_without_stream_end`  (lines 842–884)

```
async fn emits_completed_without_stream_end()
```

**Purpose**: Verifies that `process_sse` stops as soon as it sees `response.completed`, even if the underlying byte stream stays open. This avoids hanging while waiting for a server connection to close.

**Data flow**: It creates a stream that sends a completion event and then never ends. It runs `process_sse` and asserts that exactly one completion event is collected within the test timeout.

**Call relations**: This test calls `process_sse` directly to exercise its stop-on-completion behavior.

*Call graph*: calls 1 internal fn (process_sse); 14 external calls (pin, from_millis, new, assert!, assert_eq!, idle_timeout, format!, json!, panic!, iter (+4 more)).


##### `tests::error_when_error_event`  (lines 887–906)

```
async fn error_when_error_event()
```

**Purpose**: Checks that a rate-limit `response.failed` event becomes a retryable API error with a parsed delay. This ensures callers can back off for the right amount of time.

**Data flow**: It sends a server failure message containing `rate_limit_exceeded` and “try again in 11.054s”. It expects an `ApiError::Retryable` with the original message and a duration of 11.054 seconds.

**Call relations**: It drives `process_sse` through `collect_events`; `process_responses_event` classifies the error and calls `try_parse_retry_after`.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::context_window_error_is_fatal`  (lines 909–919)

```
async fn context_window_error_is_fatal()
```

**Purpose**: Verifies that a context-window error is classified as `ContextWindowExceeded`. This prevents the app from retrying a request that is too large to fit.

**Data flow**: It sends a failed response with code `context_length_exceeded` and checks that the collected result is the specific fatal error.

**Call relations**: It exercises `process_responses_event` through `collect_events` and the `is_context_window_error` helper.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, collect_events, format!).


##### `tests::context_window_error_with_newline_is_fatal`  (lines 922–932)

```
async fn context_window_error_with_newline_is_fatal()
```

**Purpose**: Checks that a context-window error is still recognized when the server message contains a newline. The classification depends on the code, not fragile message text.

**Data flow**: It sends a failed response with code `context_length_exceeded` and a multi-line message. It expects `ApiError::ContextWindowExceeded`.

**Call relations**: It uses `collect_events` to run the same error path as real streaming.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, collect_events, format!).


##### `tests::quota_exceeded_error_is_fatal`  (lines 935–945)

```
async fn quota_exceeded_error_is_fatal()
```

**Purpose**: Verifies that an insufficient-quota server error becomes `QuotaExceeded`. This tells callers that account limits, not a temporary stream issue, stopped the request.

**Data flow**: It sends a failed response with code `insufficient_quota` and asserts that the parsed result is the quota error.

**Call relations**: It reaches `is_quota_exceeded_error` through `process_responses_event` and `collect_events`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, collect_events, format!).


##### `tests::cyber_policy_error_is_fatal`  (lines 948–963)

```
async fn cyber_policy_error_is_fatal()
```

**Purpose**: Checks that a cyber policy block becomes a `CyberPolicy` error with the server's message. This preserves the explanation the server provided.

**Data flow**: It sends a failed response with code `cyber_policy` and a non-empty message. It asserts that the emitted error contains that exact message.

**Call relations**: It exercises `is_cyber_policy_error` and `cyber_policy_message` through the stream-processing path.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::cyber_policy_error_uses_fallback_for_empty_message`  (lines 966–984)

```
async fn cyber_policy_error_uses_fallback_for_empty_message()
```

**Purpose**: Checks that a blank cyber policy message is replaced with a useful fallback. This avoids showing users an empty error message.

**Data flow**: It sends a `cyber_policy` failure whose message is only spaces. It expects a `CyberPolicy` error with the default cybersecurity-risk text.

**Call relations**: It verifies the `cyber_policy_message` and `cyber_policy_fallback_message` behavior through `process_responses_event`.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::invalid_prompt_without_type_is_invalid_request`  (lines 987–1005)

```
async fn invalid_prompt_without_type_is_invalid_request()
```

**Purpose**: Verifies that an invalid prompt failure becomes an invalid request error using the server's message. This gives callers a clear reason to show to the user.

**Data flow**: It sends a failed response with code `invalid_prompt` and checks that the resulting `InvalidRequest` error carries the same message.

**Call relations**: It exercises `is_invalid_prompt_error` through the normal SSE processing path.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::table_driven_event_kinds`  (lines 1008–1083)

```
async fn table_driven_event_kinds()
```

**Purpose**: Checks several event kinds in one compact test table: created events, output item events, and unknown events. This confirms that known events are emitted and unknown events are ignored.

**Data flow**: It builds multiple test cases, appends a completion event to each, runs them through `run_sse`, and checks the number and type of emitted events.

**Call relations**: It broadly exercises the event-kind switch inside `process_responses_event`.

*Call graph*: 5 external calls (assert!, assert_eq!, run_sse, json!, vec!).


##### `tests::spawn_response_stream_emits_header_events`  (lines 1086–1119)

```
async fn spawn_response_stream_emits_header_events()
```

**Purpose**: Verifies that `spawn_response_stream` reads important headers before processing the body. In particular, it checks request id and server model forwarding.

**Data flow**: It creates a fake `StreamResponse` with request-id and model headers but no body bytes. It starts `spawn_response_stream`, checks the returned request id, and reads the first emitted server-model event.

**Call relations**: This test calls `spawn_response_stream` directly and confirms the setup work that happens before `process_sse` reads the stream.

*Call graph*: calls 1 internal fn (spawn_response_stream); 8 external calls (pin, new, from_static, new, assert_eq!, idle_timeout, panic!, iter).


##### `tests::spawn_response_stream_ignores_model_verification_header`  (lines 1122–1156)

```
async fn spawn_response_stream_ignores_model_verification_header()
```

**Purpose**: Checks that model verification recommendations are not read from initial HTTP headers. They should come from stream metadata events instead.

**Data flow**: It builds a response with a verification recommendation header and a normal completion SSE event. It collects all emitted events and asserts that none are `ModelVerifications`.

**Call relations**: It calls `spawn_response_stream` and verifies that only `process_sse` metadata extraction, not header parsing, can emit model verifications.

*Call graph*: calls 1 internal fn (spawn_response_stream); 10 external calls (pin, new, from_static, new, assert!, idle_timeout, format!, json!, iter, vec!).


##### `tests::process_sse_ignores_response_model_field_in_payload`  (lines 1159–1188)

```
async fn process_sse_ignores_response_model_field_in_payload()
```

**Purpose**: Verifies that plain `response.model` fields do not cause server model events. Only header-shaped model data is trusted for this purpose.

**Data flow**: It sends created and completed events whose response objects contain a `model` field. It expects only created and completed events, with no server-model event.

**Call relations**: It uses `run_sse` to confirm the behavior of `ResponsesStreamEvent::response_model` as called by `process_sse`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, run_sse, vec!).


##### `tests::process_sse_emits_server_model_from_response_headers_payload`  (lines 1191–1225)

```
async fn process_sse_emits_server_model_from_response_headers_payload()
```

**Purpose**: Checks that model information embedded in `response.headers` is emitted as a server model event. This covers streams where the model arrives inside the event payload.

**Data flow**: It sends a created event containing `response.headers.OpenAI-Model`, then a completion. It expects a server-model event before the created and completed events.

**Call relations**: It tests the path from `process_sse` through `ResponsesStreamEvent::response_model` and `header_openai_model_value_from_json`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, run_sse, vec!).


##### `tests::process_sse_emits_model_verification_field`  (lines 1228–1260)

```
async fn process_sse_emits_model_verification_field()
```

**Purpose**: Verifies that known model verification metadata is emitted as an internal event. This checks the trusted-access-for-cyber metadata path.

**Data flow**: It sends a `response.metadata` event with a verification recommendation array, followed by completion. It expects a `ModelVerifications` event containing `TrustedAccessForCyber`.

**Call relations**: It exercises `ResponsesStreamEvent::model_verifications`, `model_verifications_from_json_value`, and `parse_model_verification` through `process_sse`.

*Call graph*: 3 external calls (assert_matches!, run_sse, vec!).


##### `tests::process_sse_emits_turn_moderation_metadata_field`  (lines 1263–1295)

```
async fn process_sse_emits_turn_moderation_metadata_field()
```

**Purpose**: Checks that turn moderation metadata is forwarded when present. This ensures safety or presentation metadata is not lost during stream parsing.

**Data flow**: It sends a metadata event with `openai_chatgpt_moderation_metadata`, followed by completion. It expects a `TurnModerationMetadata` event containing the same JSON object.

**Call relations**: It verifies the `turn_moderation_metadata` helper as used by `process_sse`.

*Call graph*: 3 external calls (assert_matches!, run_sse, vec!).


##### `tests::responses_stream_event_response_model_reads_top_level_headers`  (lines 1298–1311)

```
fn responses_stream_event_response_model_reads_top_level_headers()
```

**Purpose**: Verifies that `response_model` can read model names from top-level headers on metadata events. This covers websocket-style metadata shapes.

**Data flow**: It deserializes a JSON event with top-level `headers.openai-model` and checks that `response_model` returns that model string.

**Call relations**: It tests `ResponsesStreamEvent::response_model` and the header model extraction helper directly.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_response_model_prefers_response_headers`  (lines 1314–1333)

```
fn responses_stream_event_response_model_prefers_response_headers()
```

**Purpose**: Checks that response-level headers win over top-level headers when both contain a model. This avoids using less-specific metadata when a direct response header is available.

**Data flow**: It creates an event with different model names in top-level headers and `response.headers`. It asserts that `response_model` returns the response-level model.

**Call relations**: It directly verifies the precedence documented in `ResponsesStreamEvent::response_model`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_model_verification_reads_metadata_field`  (lines 1336–1352)

```
fn responses_stream_event_model_verification_reads_metadata_field()
```

**Purpose**: Verifies that model verification recommendations are read from the expected metadata field. This confirms the happy path for known verification values.

**Data flow**: It deserializes a metadata event with a recommendation array containing the trusted cyber access value and checks that the helper returns the matching enum.

**Call relations**: It tests `ResponsesStreamEvent::model_verifications` and its parsing helpers directly.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_model_verification_ignores_unknown_field`  (lines 1355–1366)

```
fn responses_stream_event_model_verification_ignores_unknown_field()
```

**Purpose**: Checks that unknown verification recommendation strings are ignored. This keeps future or unexpected server values from breaking clients.

**Data flow**: It deserializes a metadata event with an array containing `unknown` and asserts that no verifications are returned.

**Call relations**: It directly tests the filtering behavior in `parse_model_verification` and `model_verifications_from_json_value`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_model_verification_ignores_non_array_field`  (lines 1369–1380)

```
fn responses_stream_event_model_verification_ignores_non_array_field()
```

**Purpose**: Checks that the verification field must be an array. This avoids treating malformed metadata as a valid recommendation.

**Data flow**: It deserializes a metadata event where the recommendation field is a single string instead of a list and expects no result.

**Call relations**: It verifies the array check inside `model_verifications_from_json_value` through `ResponsesStreamEvent::model_verifications`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::test_try_parse_retry_after`  (lines 1383–1394)

```
fn test_try_parse_retry_after()
```

**Purpose**: Verifies that millisecond retry delays can be parsed from rate-limit messages. This covers messages that say things like `28ms`.

**Data flow**: It builds an `Error` with code `rate_limit_exceeded` and a message containing `try again in 28ms`, calls `try_parse_retry_after`, and expects a 28 millisecond duration.

**Call relations**: It tests `try_parse_retry_after` directly, including its use of `rate_limit_regex`.

*Call graph*: calls 1 internal fn (try_parse_retry_after); 1 external calls (assert_eq!).


##### `tests::test_try_parse_retry_after_no_delay`  (lines 1397–1407)

```
fn test_try_parse_retry_after_no_delay()
```

**Purpose**: Verifies that fractional-second retry delays can be parsed from rate-limit messages. Despite the name, this test expects a delay from `1.898s`.

**Data flow**: It builds a rate-limit `Error` message containing `try again in 1.898s`, calls `try_parse_retry_after`, and checks for a 1.898 second duration.

**Call relations**: It directly exercises the seconds branch in `try_parse_retry_after`.

*Call graph*: calls 1 internal fn (try_parse_retry_after); 1 external calls (assert_eq!).


##### `tests::test_try_parse_retry_after_azure`  (lines 1410–1420)

```
fn test_try_parse_retry_after_azure()
```

**Purpose**: Verifies that Azure-style rate-limit wording with full `seconds` units is parsed. This makes retry behavior work across slightly different server messages.

**Data flow**: It builds a rate-limit `Error` with the message `Try again in 35 seconds`, calls `try_parse_retry_after`, and expects a 35 second duration.

**Call relations**: It directly tests `try_parse_retry_after` and the shared retry-delay regular expression.

*Call graph*: calls 1 internal fn (try_parse_retry_after); 1 external calls (assert_eq!).


### `codex-api/src/endpoint/responses_websocket.rs`

`io_transport` · `websocket connection setup and response streaming`

A normal HTTP request is like mailing a letter and waiting for a reply. A WebSocket is more like keeping a phone line open: the client can send a request, and the server can stream back many small updates as work progresses. This file builds and protects that phone line for the Responses API.

The lower layer, `WsStream`, wraps the raw WebSocket connection. It runs a background task that is the only place allowed to touch the socket directly. That task sends outgoing messages, reads incoming messages, answers server pings with pongs, and forwards useful messages to the rest of the code. This avoids two async tasks writing to or reading from the same socket at the same time.

`ResponsesWebsocketClient` knows how to create a connection: build the provider URL, combine headers, add authentication, configure TLS certificate trust, and read special headers returned by the server. `ResponsesWebsocketConnection` then uses that open connection to stream a request. It serializes the request as JSON, sends it, waits for text events, maps rate limits and wrapped server errors, records turn state, and stops only when it sees the final completed event. If anything goes wrong, it closes the shared connection so later code does not reuse a broken socket.

#### Function details

##### `WsStream::new`  (lines 64–126)

```
fn new(inner: WebSocketStream<MaybeTlsStream<TcpStream>>) -> Self
```

**Purpose**: Creates a safe wrapper around a raw WebSocket connection. It starts a background pump task that owns the actual socket, so all reads and writes happen in one controlled place.

**Data flow**: It receives an open WebSocket stream. It creates one channel for outgoing commands and another for incoming messages, then starts a background task that sends messages, reads messages, replies to pings, ignores pongs, and forwards text, binary, close, or error results. It returns a `WsStream` containing the command sender, message receiver, and task handle.

**Call relations**: This is used after `connect_websocket` successfully upgrades to a WebSocket. Later, `WsStream::send` asks the pump to write, and `WsStream::next` receives messages that the pump has read.

*Call graph*: 2 external calls (select!, spawn).


##### `WsStream::request`  (lines 128–137)

```
async fn request(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<(), WsError>>) -> WsCommand,
    ) -> Result<(), WsError>
```

**Purpose**: Sends a command to the WebSocket pump and waits to learn whether it succeeded. It is a small helper used to make socket operations feel like direct async calls while still going through the pump task.

**Data flow**: It receives a function that builds a command, creates a one-use reply channel, sends the command to the pump, and waits for the reply. If the pump is gone or does not answer, it returns a closed-connection error.

**Call relations**: `WsStream::send` calls this when it wants to write a message. The background pump created by `WsStream::new` receives the command and sends the success or failure result back.

*Call graph*: called by 1 (send); 2 external calls (send, channel).


##### `WsStream::send`  (lines 139–142)

```
async fn send(&self, message: Message) -> Result<(), WsError>
```

**Purpose**: Queues one WebSocket message to be sent. Callers use it when they need to send a request frame without directly touching the socket.

**Data flow**: It receives a WebSocket message, wraps it in a send command, passes it through `WsStream::request`, and returns either success or the socket write error.

**Call relations**: `send_websocket_request` calls this to send the serialized Responses request. Internally it hands the work to `WsStream::request`, which hands it to the pump task.

*Call graph*: calls 1 internal fn (request).


##### `WsStream::next`  (lines 144–146)

```
async fn next(&mut self) -> Option<Result<Message, WsError>>
```

**Purpose**: Waits for the next meaningful incoming WebSocket message or socket error. It gives higher-level code a simple way to consume messages that the pump task has already filtered.

**Data flow**: It reads from the incoming message channel. The result is either the next message, an error from the socket, or `None` if the stream has ended.

**Call relations**: `run_websocket_response_stream` uses this while waiting for server response events. `probe_handshake` also uses it briefly to see whether the server closes immediately after connecting.

*Call graph*: 1 external calls (recv).


##### `WsStream::drop`  (lines 150–152)

```
fn drop(&mut self)
```

**Purpose**: Stops the background WebSocket pump when the wrapper is no longer needed. This prevents an abandoned task from continuing to run after the connection has been discarded.

**Data flow**: When the `WsStream` is dropped, it aborts the pump task stored inside it. Nothing is returned, but the background task is told to stop.

**Call relations**: This runs automatically when a connection is closed or removed from `ResponsesWebsocketConnection`. It cleans up the task started by `WsStream::new`.

*Call graph*: 1 external calls (abort).


##### `ResponsesWebsocketConnection::fmt`  (lines 173–182)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a safe debug view of a WebSocket connection. It shows useful connection settings without trying to print the raw socket or telemetry object.

**Data flow**: It receives the connection and a debug formatter. It writes fields like timeout, server feature flags, model information, and placeholders for private or complex fields.

**Call relations**: Rust debugging tools call this when the connection is formatted with debug output. It avoids exposing low-level stream details while still helping diagnose state.

*Call graph*: 1 external calls (debug_struct).


##### `ResponsesWebsocketConnection::new`  (lines 186–202)

```
fn new(
        stream: WsStream,
        idle_timeout: Duration,
        server_reasoning_included: bool,
        models_etag: Option<String>,
        server_model: Option<String>,
        telemetry:
```

**Purpose**: Builds the reusable connection object after a WebSocket has been opened. It stores the stream, timeout, server-provided metadata, and optional telemetry hooks together.

**Data flow**: It receives a `WsStream`, an idle timeout, server capability flags, optional model metadata, and optional telemetry. It wraps the stream in a shared async lock and returns a `ResponsesWebsocketConnection` ready to stream requests.

**Call relations**: `ResponsesWebsocketClient::connect` calls this after `connect_websocket` succeeds. Later, `stream_request` uses the stored pieces to send a request and report events.

*Call graph*: called by 1 (connect); 2 external calls (new, new).


##### `ResponsesWebsocketConnection::is_closed`  (lines 204–206)

```
async fn is_closed(&self) -> bool
```

**Purpose**: Checks whether this connection has already been marked unusable. It is a simple health check before trying to reuse the WebSocket.

**Data flow**: It locks the shared stream slot and checks whether the slot is empty. It returns `true` if the stream has been removed and `false` if a stream is still present.

**Call relations**: Other code can call this before deciding whether to reuse or replace the connection. The slot becomes empty when streaming hits a terminal error and `stream_request` removes the failed stream.


##### `ResponsesWebsocketConnection::stream_request`  (lines 214–287)

```
async fn stream_request(
        &self,
        request: ResponsesWsRequest,
        connection_reused: bool,
        turn_state: Option<Arc<OnceLock<String>>>,
    ) -> Result<ResponseStream, ApiErro
```

**Purpose**: Starts one Responses request over the existing WebSocket and returns a stream of app-level events. It keeps exclusive use of the shared socket until that response finishes, so overlapping requests do not mix their messages.

**Data flow**: It receives a request, a flag saying whether the connection was reused, and optional turn-state storage. It serializes the request to JSON, creates an event channel for the caller, sends initial server metadata events, locks the socket, and spawns a task that runs the actual streaming loop. It returns a `ResponseStream` immediately, while the spawned task feeds events or errors into it.

**Call relations**: Callers use this after `ResponsesWebsocketClient::connect` has produced a connection. It delegates request encoding to `serialize_websocket_request` and message processing to `run_websocket_response_stream`; if that lower-level stream fails, it removes the socket so the broken connection will not be reused.

*Call graph*: calls 2 internal fn (run_websocket_response_stream, serialize_websocket_request); 7 external calls (clone, current, ModelsEtag, ServerModel, ServerReasoningIncluded, Stream, spawn).


##### `ResponsesWebsocketClient::new`  (lines 324–326)

```
fn new(provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a client tied to one provider and one authentication source. This gives later connection attempts everything they need to know where to connect and how to prove identity.

**Data flow**: It receives a `Provider` and shared authentication provider, stores them in a new `ResponsesWebsocketClient`, and returns it.

**Call relations**: The websocket reachability check and normal API setup can create this client before calling `connect` or `probe_handshake`.

*Call graph*: called by 1 (websocket_reachability_check).


##### `ResponsesWebsocketClient::connect`  (lines 334–360)

```
async fn connect(
        &self,
        extra_headers: HeaderMap,
        default_headers: HeaderMap,
        turn_state: Option<Arc<OnceLock<String>>>,
        telemetry: Option<Arc<dyn WebsocketTel
```

**Purpose**: Opens a real Responses WebSocket connection for streaming model responses. It applies provider headers, caller headers, default headers, and authentication before connecting.

**Data flow**: It receives extra headers, default headers, optional turn-state storage, and optional telemetry. It asks the provider for the `responses` WebSocket URL, merges headers, adds auth, calls `connect_websocket`, then wraps the resulting stream and server metadata in a `ResponsesWebsocketConnection`.

**Call relations**: Higher-level code calls this when it needs a usable WebSocket. It relies on `merge_request_headers` for header precedence, `connect_websocket` for the network handshake, and `ResponsesWebsocketConnection::new` for the final connection object.

*Call graph*: calls 4 internal fn (new, connect_websocket, merge_request_headers, websocket_url_for_path); 1 external calls (add_auth_headers).


##### `ResponsesWebsocketClient::probe_handshake`  (lines 369–404)

```
async fn probe_handshake(
        &self,
        extra_headers: HeaderMap,
        default_headers: HeaderMap,
        immediate_close_timeout: Duration,
    ) -> Result<ResponsesWebsocketProbe, ApiEr
```

**Purpose**: Tests whether a Responses WebSocket handshake works without sending an actual model request. It is used for diagnostics, like checking whether the server upgrades successfully or closes immediately.

**Data flow**: It builds the same URL and headers as a real connection, adds authentication, connects, then waits only briefly for a close message. It returns a probe report containing the URL, HTTP upgrade status, server feature hints, and any immediate close reason.

**Call relations**: Diagnostic code calls this instead of `connect` when it only wants reachability information. It uses `connect_websocket` for the same connection path as production traffic and `immediate_close_from_message` to interpret a quick close frame.

*Call graph*: calls 3 internal fn (connect_websocket, merge_request_headers, websocket_url_for_path); 2 external calls (add_auth_headers, timeout).


##### `immediate_close_from_message`  (lines 407–412)

```
fn immediate_close_from_message(message: Message) -> Option<ResponsesWebsocketClose>
```

**Purpose**: Extracts close information from a WebSocket message if the message is a close frame. It helps diagnostic probes describe why a server accepted a connection and then immediately ended it.

**Data flow**: It receives one WebSocket message. If it is not a close message, it returns nothing; if it is a close message with frame details, it converts those details into a `ResponsesWebsocketClose`.

**Call relations**: `probe_handshake` calls this after its short wait for an immediate server message. It hands close frames to `close_frame_to_probe` for formatting.


##### `close_frame_to_probe`  (lines 414–419)

```
fn close_frame_to_probe(frame: CloseFrame) -> ResponsesWebsocketClose
```

**Purpose**: Turns a low-level WebSocket close frame into a small diagnostic record. This makes the close code and human-readable reason easy to include in probe results.

**Data flow**: It receives a close frame from the WebSocket library. It copies the close code and reason into strings and returns a `ResponsesWebsocketClose`.

**Call relations**: `immediate_close_from_message` calls this when the probe sees a close frame right after connection.


##### `merge_request_headers`  (lines 421–434)

```
fn merge_request_headers(
    provider_headers: &HeaderMap,
    extra_headers: HeaderMap,
    default_headers: HeaderMap,
) -> HeaderMap
```

**Purpose**: Combines headers from three sources using the same priority rules as HTTP requests elsewhere in the client. Provider headers come first, extra caller headers can override them, and defaults only fill missing names.

**Data flow**: It receives provider headers by reference plus owned extra and default headers. It clones the provider headers, extends them with extra headers, then inserts each default only if that header is still absent. It returns the merged header map.

**Call relations**: `ResponsesWebsocketClient::connect` and `probe_handshake` call this before adding authentication and connecting. The test `tests::merge_request_headers_matches_http_precedence` checks the intended priority order.

*Call graph*: called by 3 (connect, probe_handshake, merge_request_headers_matches_http_precedence); 1 external calls (clone).


##### `connect_websocket`  (lines 436–505)

```
async fn connect_websocket(
    url: Url,
    headers: HeaderMap,
    turn_state: Option<Arc<OnceLock<String>>>,
) -> Result<(WsStream, StatusCode, bool, Option<String>, Option<String>), ApiError>
```

**Purpose**: Performs the actual network handshake for a Responses WebSocket. It builds the request, applies TLS settings, connects to the server, reads useful upgrade headers, and wraps the socket for safe use.

**Data flow**: It receives a WebSocket URL, headers, and optional turn-state storage. It ensures the TLS crypto provider is ready, builds a WebSocket request, attaches headers, optionally builds a custom certificate configuration, connects, and maps any connection failure to `ApiError`. On success, it records server flags and headers such as reasoning support, model ETag, selected model, and turn state, then returns a `WsStream`, HTTP status, and metadata.

**Call relations**: Both `ResponsesWebsocketClient::connect` and `probe_handshake` call this. It uses `websocket_config` for compression support, `map_ws_error` for failed handshakes, and `WsStream::new` to wrap the connected socket.

*Call graph*: calls 3 internal fn (new, map_ws_error, websocket_config); called by 2 (connect, probe_handshake); 6 external calls (as_str, maybe_build_rustls_client_config_with_custom_ca, ensure_rustls_crypto_provider, error!, info!, connect_async_tls_with_config).


##### `websocket_config`  (lines 507–514)

```
fn websocket_config() -> WebSocketConfig
```

**Purpose**: Creates the WebSocket configuration used by this client. Its important choice is enabling per-message deflate, which is compression for individual WebSocket messages.

**Data flow**: It starts from default extension and socket settings, enables deflate compression in the extensions, places those extensions into the WebSocket config, and returns the config.

**Call relations**: `connect_websocket` passes this configuration into the WebSocket library during connection. The test `tests::websocket_config_enables_permessage_deflate` verifies compression is enabled.

*Call graph*: called by 2 (connect_websocket, websocket_config_enables_permessage_deflate); 3 external calls (default, default, default).


##### `map_ws_error`  (lines 516–538)

```
fn map_ws_error(err: WsError, url: &Url) -> ApiError
```

**Purpose**: Converts errors from the WebSocket library into the API client's own error types. This keeps callers from needing to understand the WebSocket library's private error vocabulary.

**Data flow**: It receives a WebSocket error and the URL being contacted. HTTP handshake failures become transport HTTP errors with status, headers, body, and URL; closed connections become stream errors; input/output and other failures become network transport errors.

**Call relations**: `connect_websocket` calls this when the handshake fails. The mapped `ApiError` then travels back to `connect` or `probe_handshake`.

*Call graph*: called by 1 (connect_websocket); 5 external calls (to_string, to_string, Stream, Transport, Network).


##### `parse_wrapped_websocket_error_event`  (lines 558–564)

```
fn parse_wrapped_websocket_error_event(payload: &str) -> Option<WrappedWebsocketErrorEvent>
```

**Purpose**: Recognizes server-sent WebSocket text messages that are wrapped error events. It separates real error envelopes from normal response events.

**Data flow**: It receives a text payload, tries to parse it as JSON shaped like a wrapped error event, and checks that its type is `error`. It returns the parsed error event only when both parsing and the type check succeed.

**Call relations**: `run_websocket_response_stream` calls this before normal event parsing so server errors can become proper `ApiError`s. Several tests call it directly to confirm error and non-error payloads are distinguished.

*Call graph*: called by 6 (run_websocket_response_stream, parse_wrapped_websocket_error_event_ignores_non_error_payloads, parse_wrapped_websocket_error_event_maps_to_transport_http, parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable, parse_wrapped_websocket_error_event_with_status_maps_invalid_request, parse_wrapped_websocket_error_event_without_status_is_not_mapped); 1 external calls (from_str).


##### `map_wrapped_websocket_error_event`  (lines 566–601)

```
fn map_wrapped_websocket_error_event(
    event: WrappedWebsocketErrorEvent,
    original_payload: String,
) -> Option<ApiError>
```

**Purpose**: Turns a parsed wrapped WebSocket error event into the API client's error type when enough information is present. It also treats the known WebSocket connection time-limit error as retryable, because the client can open a new connection.

**Data flow**: It receives the parsed event and the original JSON text. If the error code says the connection limit was reached, it returns a retryable error. Otherwise it requires a non-success HTTP status, converts any JSON headers to real HTTP headers, and returns a transport HTTP error containing the original payload as the body. If there is no status or the status is successful, it returns nothing.

**Call relations**: `run_websocket_response_stream` calls this right after `parse_wrapped_websocket_error_event`. The tests cover rate-limit-like HTTP errors, invalid requests, connection-limit retry behavior, and missing-status cases.

*Call graph*: called by 5 (run_websocket_response_stream, parse_wrapped_websocket_error_event_maps_to_transport_http, parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable, parse_wrapped_websocket_error_event_with_status_maps_invalid_request, parse_wrapped_websocket_error_event_without_status_is_not_mapped); 2 external calls (from_u16, Transport).


##### `json_headers_to_http_headers`  (lines 603–615)

```
fn json_headers_to_http_headers(headers: JsonMap<String, Value>) -> HeaderMap
```

**Purpose**: Converts headers represented in a JSON object into a normal HTTP header map. This is needed because wrapped WebSocket errors may carry HTTP-like headers inside their JSON payload.

**Data flow**: It receives a JSON map from header names to JSON values. For each entry, it keeps only valid header names and values that can become strings, then inserts them into a new header map. Invalid names or unsupported value shapes are skipped.

**Call relations**: `map_wrapped_websocket_error_event` uses this when a wrapped error event includes headers. It calls `json_header_value` to convert each JSON value safely.

*Call graph*: calls 1 internal fn (json_header_value); 2 external calls (new, from_bytes).


##### `json_header_value`  (lines 617–625)

```
fn json_header_value(value: Value) -> Option<HeaderValue>
```

**Purpose**: Converts one JSON value into an HTTP header value when that is safe and meaningful. It accepts simple string, number, and boolean values and rejects structured values like arrays and objects.

**Data flow**: It receives a JSON value. Strings are used as-is, numbers and booleans are converted to text, and other JSON shapes return nothing; then it tries to build a valid HTTP header value from the text.

**Call relations**: `json_headers_to_http_headers` calls this for every header value found inside a wrapped WebSocket error payload.

*Call graph*: called by 1 (json_headers_to_http_headers); 2 external calls (from_str, to_string).


##### `run_websocket_response_stream`  (lines 627–755)

```
async fn run_websocket_response_stream(
    ws_stream: &mut WsStream,
    tx_event: mpsc::Sender<std::result::Result<ResponseEvent, ApiError>>,
    request_text: String,
    idle_timeout: Duration,
```

**Purpose**: Runs the main loop for one Responses request over an existing WebSocket. It sends the request, reads server events until completion, translates them into `ResponseEvent`s, and turns bad or unexpected messages into API errors.

**Data flow**: It receives the WebSocket stream, an event sender, serialized request text, timeout, optional telemetry, reuse flag, and optional turn-state storage. It sends the request, then repeatedly waits for the next message with an idle timeout. Text messages are checked for wrapped errors, parsed as response events, used to update turn state and model metadata, and forwarded as app-level events. Rate-limit snapshots, model verifications, and moderation metadata are sent as special events. The loop exits successfully only after a completed event; socket errors, binary messages, early closes, idle timeouts, and dropped consumers become errors.

**Call relations**: `ResponsesWebsocketConnection::stream_request` calls this inside a spawned task while holding exclusive access to the connection. It calls `send_websocket_request` first, then uses `parse_wrapped_websocket_error_event`, `map_wrapped_websocket_error_event`, `parse_rate_limit_event`, and `process_responses_event` to turn raw messages into meaningful results.

*Call graph*: calls 4 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event, send_websocket_request, parse_rate_limit_event); called by 1 (stream_request); 13 external calls (now, send, ModelVerifications, RateLimits, ServerModel, TurnModerationMetadata, next, Stream, process_responses_event, debug! (+3 more)).


##### `send_websocket_request`  (lines 757–788)

```
async fn send_websocket_request(
    ws_stream: &WsStream,
    request_text: String,
    idle_timeout: Duration,
    telemetry: Option<&Arc<dyn WebsocketTelemetry>>,
    connection_reused: bool,
) ->
```

**Purpose**: Sends the already-serialized Responses request over the WebSocket and records timing information. It makes sure a stuck send does not hang forever by applying the connection's idle timeout.

**Data flow**: It receives the stream, request JSON text, timeout, optional telemetry, and whether the connection was reused. It sends the text as a WebSocket text message inside a timeout, maps timeout or send failures into `ApiError`, reports duration and errors to telemetry if present, and returns success only after the message was sent.

**Call relations**: `run_websocket_response_stream` calls this before it starts reading response events. It uses `WsStream::send` to hand the outgoing frame to the pump task.

*Call graph*: calls 1 internal fn (send); called by 1 (run_websocket_response_stream); 4 external calls (now, timeout, trace!, Text).


##### `serialize_websocket_request`  (lines 790–793)

```
fn serialize_websocket_request(request: &ResponsesWsRequest) -> Result<String, ApiError>
```

**Purpose**: Encodes a Responses WebSocket request as JSON text ready to send over the wire. It keeps request serialization in one small place so errors can be reported consistently.

**Data flow**: It receives a `ResponsesWsRequest`, asks the JSON library to turn it into a string, and returns that string. If encoding fails, it returns an API stream error describing the failure.

**Call relations**: `ResponsesWebsocketConnection::stream_request` calls this before spawning the streaming task. The test `tests::direct_serialization_preserves_websocket_request_payload` checks that the WebSocket payload matches the normal JSON form.

*Call graph*: called by 2 (stream_request, direct_serialization_preserves_websocket_request_payload); 1 external calls (to_string).


##### `tests::direct_serialization_preserves_websocket_request_payload`  (lines 806–848)

```
fn direct_serialization_preserves_websocket_request_payload()
```

**Purpose**: Checks that WebSocket request serialization does not reshape or lose fields from a Responses request. This protects the wire format sent to the server.

**Data flow**: It builds a detailed sample request, serializes it once to a JSON value and once through `serialize_websocket_request`, parses the string back to JSON, and compares the two JSON values. The test passes only if they are identical.

**Call relations**: This test calls `serialize_websocket_request` directly. It guards the path used by `ResponsesWebsocketConnection::stream_request` before sending a request.

*Call graph*: calls 1 internal fn (serialize_websocket_request); 5 external calls (from, assert_eq!, ResponseCreate, to_value, vec!).


##### `tests::websocket_config_enables_permessage_deflate`  (lines 851–854)

```
fn websocket_config_enables_permessage_deflate()
```

**Purpose**: Checks that the WebSocket configuration enables message compression. This prevents an accidental change from silently disabling deflate support.

**Data flow**: It creates a config with `websocket_config` and asserts that the per-message deflate setting is present.

**Call relations**: This test protects the configuration that `connect_websocket` uses for real WebSocket handshakes.

*Call graph*: calls 1 internal fn (websocket_config); 1 external calls (assert!).


##### `tests::parse_wrapped_websocket_error_event_maps_to_transport_http`  (lines 857–906)

```
fn parse_wrapped_websocket_error_event_maps_to_transport_http()
```

**Purpose**: Checks that a wrapped error event with an HTTP status and headers becomes a transport HTTP error. This matters for rate-limit and usage-limit style server responses sent over WebSocket text.

**Data flow**: It builds a JSON error payload with status 429 and headers, parses it with `parse_wrapped_websocket_error_event`, maps it with `map_wrapped_websocket_error_event`, and asserts that the resulting error contains the expected status, headers, and body text.

**Call relations**: This test covers the same wrapped-error path that `run_websocket_response_stream` uses before normal response event processing.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 4 external calls (assert!, assert_eq!, json!, panic!).


##### `tests::parse_wrapped_websocket_error_event_ignores_non_error_payloads`  (lines 909–920)

```
fn parse_wrapped_websocket_error_event_ignores_non_error_payloads()
```

**Purpose**: Checks that normal response events are not mistaken for wrapped errors. Without this, ordinary streaming messages could be diverted into error handling.

**Data flow**: It builds a sample non-error JSON payload, passes it to `parse_wrapped_websocket_error_event`, and asserts that the result is empty.

**Call relations**: This protects `run_websocket_response_stream`, which calls the parser on every incoming text message before trying normal event parsing.

*Call graph*: calls 1 internal fn (parse_wrapped_websocket_error_event); 2 external calls (assert!, json!).


##### `tests::parse_wrapped_websocket_error_event_with_status_maps_invalid_request`  (lines 923–945)

```
fn parse_wrapped_websocket_error_event_with_status_maps_invalid_request()
```

**Purpose**: Checks that an invalid-request error sent over the WebSocket becomes an HTTP-style API error. This lets callers see the same kind of error they would expect from an HTTP endpoint.

**Data flow**: It builds a JSON error payload with status 400, parses it, maps it, and asserts that the result is a transport HTTP error with bad-request status and the original message in the body.

**Call relations**: This test exercises `parse_wrapped_websocket_error_event` and `map_wrapped_websocket_error_event`, the same pair used inside `run_websocket_response_stream`.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 4 external calls (assert!, assert_eq!, json!, panic!).


##### `tests::parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable`  (lines 948–969)

```
fn parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable()
```

**Purpose**: Checks that the known WebSocket connection time-limit error is marked retryable. That tells higher-level code it can recover by opening a fresh WebSocket connection.

**Data flow**: It builds a wrapped error payload with the connection-limit code, parses and maps it, then asserts that the result is a retryable error with the expected message and no fixed delay.

**Call relations**: This test protects the special branch in `map_wrapped_websocket_error_event` that `run_websocket_response_stream` depends on when a long-lived connection expires.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 3 external calls (assert_eq!, json!, panic!).


##### `tests::parse_wrapped_websocket_error_event_without_status_is_not_mapped`  (lines 972–990)

```
fn parse_wrapped_websocket_error_event_without_status_is_not_mapped()
```

**Purpose**: Checks that a wrapped error without an HTTP status is not forced into an HTTP transport error. This avoids inventing missing status information.

**Data flow**: It builds an error JSON payload with headers but no status, parses it, tries to map it, and asserts that no API error is produced.

**Call relations**: This test covers the cautious behavior of `map_wrapped_websocket_error_event`, which is used by `run_websocket_response_stream`.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 2 external calls (assert!, json!).


##### `tests::merge_request_headers_matches_http_precedence`  (lines 993–1023)

```
fn merge_request_headers_matches_http_precedence()
```

**Purpose**: Checks the intended priority order when combining provider, extra, and default headers. This prevents subtle authentication or routing bugs caused by the wrong header winning.

**Data flow**: It creates provider headers, extra headers, and default headers with overlapping names, merges them with `merge_request_headers`, and asserts that provider-only values stay, extra headers override provider values, and defaults fill only missing names.

**Call relations**: This test protects the header-building step used by both `ResponsesWebsocketClient::connect` and `probe_handshake`.

*Call graph*: calls 1 internal fn (merge_request_headers); 3 external calls (new, from_static, assert_eq!).


### `codex-api/src/endpoint/compact.rs`

`io_transport` · `request handling`

Conversation history can grow too large to send around in full. This file is the small client wrapper that asks the server to compact that history into a shorter form. In everyday terms, it is like sending a long stack of notes to a summarizing service and getting back a smaller set of notes that still matter.

The main type is `CompactClient`, which owns an `EndpointSession`. The session is the shared helper that knows how to build authenticated HTTP requests for a provider. `CompactClient` adds the endpoint-specific details: the path is `responses/compact`, the HTTP method is POST, and the response is expected to contain an `output` list.

There are two ways to use it. `compact_input` accepts a structured `CompactionInput`, converts it into JSON, and then calls `compact`. `compact` accepts JSON directly, sends it to the server, optionally stores a returned `x-codex-turn-state` header, parses the JSON body, and returns a list of `ResponseItem` values.

The optional turn-state header is important because it lets later requests carry forward server-side state from this compaction turn. The test code only checks that the endpoint path is correct, using a dummy transport that should never actually send a request.

#### Function details

##### `CompactClient::new`  (lines 24–28)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a new client for the compact-history endpoint. A caller uses this when it has a transport for sending HTTP requests, a provider configuration, and shared authentication.

**Data flow**: It receives the HTTP transport, provider details, and shared authentication provider. It wraps them in an `EndpointSession`, which becomes the stored session inside a new `CompactClient`. The result is a ready-to-use client object.

**Call relations**: This is the setup step before any compaction call can happen. It delegates the common request setup work to `EndpointSession::new`, so later methods can focus only on the compact endpoint’s specific behavior.

*Call graph*: calls 1 internal fn (new).


##### `CompactClient::with_telemetry`  (lines 30–34)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client with optional request telemetry attached. Telemetry means extra observation data, such as timing or request metadata, used to understand how requests behave.

**Data flow**: It takes an existing client and an optional telemetry object. It asks the stored session to attach that telemetry, then returns a new `CompactClient` containing the updated session. The original request behavior stays the same except for added observation.

**Call relations**: This is used after client creation when callers want request-level reporting. It passes the work down to the session’s `with_request_telemetry` helper, because telemetry is a general endpoint-session feature rather than something unique to compaction.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `CompactClient::path`  (lines 36–38)

```
fn path() -> &'static str
```

**Purpose**: Provides the fixed API path for the compact-history endpoint. Keeping it in one function makes the endpoint string easy to reuse and test.

**Data flow**: It takes no input and returns the literal path string `responses/compact`. It does not read or change any state.

**Call relations**: The main `compact` request uses this path when sending the POST request. The test also calls it directly to make sure the client points at the expected endpoint.


##### `CompactClient::compact`  (lines 40–70)

```
async fn compact(
        &self,
        body: serde_json::Value,
        extra_headers: HeaderMap,
        request_timeout: Duration,
        turn_state: Option<&OnceLock<String>>,
    ) -> Result<Ve
```

**Purpose**: Sends a JSON compaction request to the server and returns the compacted response items. Use this when the caller already has the request body as JSON.

**Data flow**: It receives a JSON body, extra HTTP headers, a timeout, and an optional place to store turn-state returned by the server. It sends a POST request to `responses/compact`, applies the timeout, reads the response headers, saves the `x-codex-turn-state` header if one is present, parses the response body as JSON, and returns the `output` list. If sending or parsing fails, it returns an `ApiError` instead.

**Call relations**: `compact_input` calls this after converting a structured input into JSON. Inside, it relies on the shared endpoint session’s `execute_with` method to perform the actual HTTP request, uses `path` to choose the endpoint, and uses JSON parsing to turn the server’s bytes into a `CompactHistoryResponse`.

*Call graph*: calls 1 internal fn (execute_with); called by 1 (compact_input); 2 external calls (path, from_slice).


##### `CompactClient::compact_input`  (lines 72–83)

```
async fn compact_input(
        &self,
        input: &CompactionInput<'_>,
        extra_headers: HeaderMap,
        request_timeout: Duration,
        turn_state: Option<&OnceLock<String>>,
    ) ->
```

**Purpose**: Accepts a structured compaction request and sends it through the compact endpoint. This is the friendlier entry point for callers that have a `CompactionInput` rather than raw JSON.

**Data flow**: It receives a `CompactionInput`, headers, timeout, and optional turn-state storage. It converts the input into a JSON value. If that conversion works, it hands the JSON to `compact`; if conversion fails, it returns an `ApiError` explaining that the input could not be encoded.

**Call relations**: This function sits one layer above `compact`. It prepares the body in the format the lower-level request function expects, then lets `compact` do the network call, header capture, and response parsing.

*Call graph*: calls 1 internal fn (compact); 1 external calls (to_value).


##### `tests::DummyTransport::execute`  (lines 103–105)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Provides a fake HTTP `execute` method for the test-only dummy transport. It exists only so the dummy type can satisfy the same transport interface as a real network transport.

**Data flow**: It receives a request but ignores it. Instead of sending anything, it immediately returns a build error saying this method should not run.

**Call relations**: The path test does not need real network traffic, but `CompactClient` is generic over an HTTP transport, so the test needs a placeholder transport type. If this method were accidentally called during the path test, the returned error would make that mistake obvious.

*Call graph*: 1 external calls (Build).


##### `tests::DummyTransport::stream`  (lines 107–109)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Provides a fake streaming method for the test-only dummy transport. Streaming means receiving a response in pieces over time, but this test transport never actually streams.

**Data flow**: It receives a request but does not inspect or send it. It immediately returns a build error saying streaming should not run.

**Call relations**: This completes the dummy implementation of the HTTP transport interface. The endpoint path test only needs the type to exist, and this method acts as a guard against accidental network-like behavior in the test.

*Call graph*: 1 external calls (Build).


##### `tests::path_is_responses_compact`  (lines 113–115)

```
fn path_is_responses_compact()
```

**Purpose**: Checks that the compact client uses the exact endpoint path expected by the API. This protects against accidental changes to the URL path string.

**Data flow**: It asks `CompactClient` for its path using the dummy transport type, then compares the returned string with `responses/compact`. The test passes if they match and fails if they do not.

**Call relations**: This test directly exercises `CompactClient::path`. It does not create a real client or send a request, which is why the dummy transport methods are designed never to run.

*Call graph*: 1 external calls (assert_eq!).


### `codex-api/src/endpoint/memories.rs`

`io_transport` · `request handling`

This file is a small doorway from local Rust code to a remote “memories” API endpoint. Its job is to take memory trace data, turn it into JSON, send it with an HTTP POST request, and turn the server’s JSON reply back into Rust values the rest of the program can use. Without this file, callers would have to know the exact URL path, request format, headers, and response format themselves, which would make the code easier to break when the API contract changes.

The main type is `MemoriesClient`. It wraps an `EndpointSession`, which is the shared helper that knows how to build and send authenticated HTTP requests for a configured provider. The client fixes the endpoint path to `memories/trace_summarize`, preserving compatibility with the server. Callers can either pass an already-built JSON body to `summarize`, or pass a typed `MemorySummarizeInput` to `summarize_input`, which first converts the structured input into JSON.

The response is expected to be JSON with an `output` field containing a list of memory summaries. If the server reply cannot be decoded, the file turns that into an `ApiError` so callers get a clear failure instead of bad data.

The test code uses fake transports, like a pretend mail carrier, to inspect the outgoing request without making a real network call.

#### Function details

##### `MemoriesClient::new`  (lines 20–24)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a new memories API client. A caller uses this when they have an HTTP transport, provider settings such as the base URL, and an authentication provider ready to use.

**Data flow**: It receives a transport, provider configuration, and shared authentication provider. It passes those into `EndpointSession::new`, then stores the resulting session inside a `MemoriesClient`. The result is a ready-to-use client that knows where and how to send memory summarization requests.

**Call relations**: In normal use, this is the starting point for this client. The test `tests::summarize_input_posts_expected_payload_and_parses_output` calls it to build a client around a capturing fake transport, so the test can later verify the request that was sent.

*Call graph*: calls 1 internal fn (new); called by 1 (summarize_input_posts_expected_payload_and_parses_output).


##### `MemoriesClient::with_telemetry`  (lines 26–30)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client with optional request telemetry attached. Telemetry means extra observation data about requests, such as timing or tracing information, used to understand what the client is doing.

**Data flow**: It takes an existing client and an optional shared telemetry object. It asks the inner session to attach that telemetry, then wraps the updated session in a new `MemoriesClient`. The old client is consumed, and the returned client is the one to use afterward.

**Call relations**: This function fits into setup before requests are sent. It delegates the actual telemetry attachment to the shared endpoint session through `with_request_telemetry`, because the session is the part that builds and executes HTTP requests.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `MemoriesClient::path`  (lines 32–34)

```
fn path() -> &'static str
```

**Purpose**: Returns the fixed server path for the memory summarization endpoint. Keeping this in one place helps prevent accidental changes to the API route.

**Data flow**: It takes no input and returns the string `memories/trace_summarize`. It does not read or change any outside state.

**Call relations**: The request-sending function `MemoriesClient::summarize` uses this path when building the HTTP request. The test `tests::path_is_memories_trace_summarize_for_wire_compatibility` checks it directly to protect compatibility with the server.


##### `MemoriesClient::summarize`  (lines 36–48)

```
async fn summarize(
        &self,
        body: serde_json::Value,
        extra_headers: HeaderMap,
    ) -> Result<Vec<MemorySummarizeOutput>, ApiError>
```

**Purpose**: Sends a memory summarization request using a JSON body that has already been prepared. This is the lower-level request method for callers that already have the exact JSON payload they want to send.

**Data flow**: It receives a JSON value and any extra HTTP headers. It sends a POST request to the memories summarization path through the endpoint session. When the response comes back, it reads the response body as JSON, expects an `output` list inside it, and returns that list of `MemorySummarizeOutput` values. If sending fails or the response cannot be decoded, it returns an `ApiError`.

**Call relations**: This is the core network call in the file. `MemoriesClient::summarize_input` calls it after converting typed input into JSON. It relies on the shared session’s `execute` method for the actual HTTP work and uses `MemoriesClient::path` to choose the correct endpoint.

*Call graph*: calls 1 internal fn (execute); called by 1 (summarize_input); 2 external calls (path, from_slice).


##### `MemoriesClient::summarize_input`  (lines 50–59)

```
async fn summarize_input(
        &self,
        input: &MemorySummarizeInput,
        extra_headers: HeaderMap,
    ) -> Result<Vec<MemorySummarizeOutput>, ApiError>
```

**Purpose**: Lets callers send a typed `MemorySummarizeInput` instead of manually building JSON. This is the friendlier, safer method for ordinary use.

**Data flow**: It receives a structured memory summarization input and extra headers. It converts the input into JSON; if that conversion fails, it returns an `ApiError` with a message explaining the encoding problem. If conversion succeeds, it passes the JSON body to `MemoriesClient::summarize` and returns the summaries from the server.

**Call relations**: This sits one level above `MemoriesClient::summarize`. It prepares the body, then hands off to `summarize` for the actual HTTP request and response parsing. The main behavior test calls this method to verify the complete path from typed input to outgoing request to parsed output.

*Call graph*: calls 1 internal fn (summarize); 1 external calls (to_value).


##### `tests::DummyTransport::execute`  (lines 92–94)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Provides a fake HTTP `execute` method for tests where no request should actually be sent. If this method runs, the test has gone down the wrong path.

**Data flow**: It receives a request but ignores it. Instead of returning a response, it immediately returns a transport build error saying `execute should not run`.

**Call relations**: This belongs to `DummyTransport`, a simple stand-in used when tests only need a transport type but do not want network behavior. If a test accidentally triggers an HTTP execute call through this dummy, the error makes that mistake obvious.

*Call graph*: 1 external calls (Build).


##### `tests::DummyTransport::stream`  (lines 96–98)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Provides a fake streaming HTTP method for tests where streaming must not be used. Streaming means receiving a response in pieces over time rather than as one complete body.

**Data flow**: It receives a request but ignores it. It returns a transport build error saying `stream should not run`.

**Call relations**: This is part of the dummy test transport. It protects tests from silently using the wrong kind of HTTP operation, because the memories endpoint in this file uses normal request-response execution, not streaming.

*Call graph*: 1 external calls (Build).


##### `tests::DummyAuth::add_auth_headers`  (lines 105–105)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Acts as a no-op authentication provider for tests. It satisfies the same interface as real authentication without adding any headers.

**Data flow**: It receives a mutable set of HTTP headers and leaves it unchanged. Nothing is returned beyond the normal completion of the method.

**Call relations**: Tests use this when they need to construct a `MemoriesClient` but do not care about real credentials. It lets the test focus on the memories request body and URL rather than authentication.


##### `tests::CapturingTransport::new`  (lines 115–120)

```
fn new(response_body: Vec<u8>) -> Self
```

**Purpose**: Builds a fake transport that records the last request it was asked to send and returns a chosen response body. This lets tests inspect outgoing HTTP requests without using the network.

**Data flow**: It receives bytes for the fake response body. It creates shared storage for the last request, initially empty, and shared storage for the response bytes. It returns a `CapturingTransport` holding both pieces.

**Call relations**: The main behavior test creates this transport before building the client. Later, when the client sends a request, `tests::CapturingTransport::execute` stores that request so the test can check the method, URL, and JSON body.

*Call graph*: 2 external calls (new, new).


##### `tests::CapturingTransport::execute`  (lines 124–131)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Pretends to send an HTTP request while actually saving it for inspection and returning a canned successful response.

**Data flow**: It receives a request from the client. It locks the shared request store, saves a copy of the request there, and then returns an HTTP 200 OK response whose body is the preconfigured fake response bytes. It does not contact any server.

**Call relations**: This is the key test double for the end-to-end client test. `MemoriesClient::summarize_input` eventually causes the endpoint session to call this method, and the test later reads the captured request to confirm the client built it correctly.

*Call graph*: 1 external calls (new).


##### `tests::CapturingTransport::stream`  (lines 133–135)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Rejects streaming calls in tests that use the capturing transport. The memories client should not stream for this endpoint.

**Data flow**: It receives a request but ignores it. It returns a transport build error saying `stream should not run`.

**Call relations**: This guards the test setup. If the memories client accidentally used the streaming path instead of the normal execute path, the test would fail clearly rather than hiding the mistake.

*Call graph*: 1 external calls (Build).


##### `tests::provider`  (lines 138–153)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Creates a small provider configuration for tests. A provider is the bundle of settings that tells the client the service name, base URL, retry rules, and timeout behavior.

**Data flow**: It receives a base URL string. It builds a `Provider` named `test` with that base URL, no query parameters, empty default headers, short retry delays, and a short stream idle timeout. It returns the completed provider configuration.

**Call relations**: The main behavior test calls this helper while constructing the `MemoriesClient`. Keeping the provider setup in one helper makes the test easier to read and keeps unrelated configuration details out of the request assertions.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::path_is_memories_trace_summarize_for_wire_compatibility`  (lines 156–161)

```
fn path_is_memories_trace_summarize_for_wire_compatibility()
```

**Purpose**: Checks that the endpoint path remains exactly `memories/trace_summarize`. This protects the client-server contract, because changing this string would send requests to a different URL.

**Data flow**: It calls `MemoriesClient::path`, compares the returned string to the expected path, and passes only if they match. It does not send any request or change state.

**Call relations**: This test directly protects the helper used by `MemoriesClient::summarize`. If someone edits the path by accident, this test fails before that change can break real API calls.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::summarize_input_posts_expected_payload_and_parses_output`  (lines 164–224)

```
async fn summarize_input_posts_expected_payload_and_parses_output()
```

**Purpose**: Tests the full happy path for summarizing typed memory input. It proves that the client sends the right POST request, formats the JSON body correctly, and reads the server’s response into useful output values.

**Data flow**: It creates a fake server response containing one summary, builds a capturing transport and client, and prepares a `MemorySummarizeInput` with a model name and one raw memory trace. It calls `summarize_input`, checks that one parsed output came back with the expected summary text, then inspects the captured request to confirm the HTTP method, URL, model field, trace id, and trace metadata were all correct.

**Call relations**: This test ties together most of the file’s production path: it constructs the client with `MemoriesClient::new`, creates provider settings with `tests::provider`, sends through `MemoriesClient::summarize_input`, which calls `MemoriesClient::summarize`, and relies on `tests::CapturingTransport::execute` to capture the request instead of making a real network call.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, new, assert_eq!, new, provider, json!, to_vec, vec!).


### `codex-api/src/endpoint/images.rs`

`io_transport` · `request handling`

This file is the bridge between the project’s image features and the remote provider’s image API. Without it, the rest of the code could build an image request, but would not have a clear, reusable way to send that request to the right web endpoint or decode the answer.

The main type is `ImagesClient`. It wraps an `EndpointSession`, which is the shared helper that knows the provider’s base URL, authentication, headers, retries, and actual HTTP transport. Think of `ImagesClient` as a small service desk: callers hand it a well-shaped image request, and it fills out the shipping label, sends it to the right address, and opens the reply package.

There are two public operations. `generate` sends a request to create an image from a prompt. `edit` sends a request to modify an existing image. Both use the same private helper, `post_image_request`, because the steps are almost identical: serialize the request into JSON, POST it to the correct path, and deserialize the response body into an `ImageResponse`.

The tests build a fake transport that records the outgoing request instead of using the network. They verify that generation and editing use the correct URL, omit empty optional fields from JSON, parse valid image responses, and report an error if the response is missing required image data.

#### Function details

##### `ImagesClient::new`  (lines 21–25)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a new image API client. A caller uses this when it has an HTTP transport, provider settings, and an authentication provider ready to use.

**Data flow**: It receives a transport, provider configuration, and shared authentication provider. It passes those into a new `EndpointSession`, then stores that session inside an `ImagesClient`. The result is a client ready to make image API calls.

**Call relations**: This is the setup step for the image endpoint. The tests and higher-level client construction call it before making image requests. Internally it hands the real connection details to `EndpointSession::new`, so later calls such as `generate` and `edit` can focus only on image-specific paths and data.

*Call graph*: calls 1 internal fn (new); called by 4 (edit_posts_typed_request_and_parses_image_response, generate_posts_typed_request_and_parses_image_response, image_response_requires_image_data, client).


##### `ImagesClient::with_telemetry`  (lines 27–31)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client with optional request telemetry attached. Telemetry means extra observation code that can record details about outgoing requests, such as timing or metadata.

**Data flow**: It takes the existing client and an optional shared telemetry object. It asks the underlying session to attach that telemetry, then returns a new `ImagesClient` containing the updated session. It does not send any request by itself.

**Call relations**: This fits into client configuration before requests are made. It delegates the actual telemetry attachment to `EndpointSession::with_request_telemetry`, so image operations later benefit from the same request-observation machinery as other endpoints.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `ImagesClient::generate`  (lines 33–45)

```
async fn generate(
        &self,
        request: &ImageGenerationRequest,
        extra_headers: HeaderMap,
    ) -> Result<ImageResponse, ApiError>
```

**Purpose**: Sends an image generation request. A caller uses it when they want the provider to create an image from a prompt and options such as size, quality, or background.

**Data flow**: It receives an `ImageGenerationRequest` and any extra HTTP headers. It chooses the `images/generations` API path and labels the operation as `image generation`, then passes everything to the shared POST helper. It returns either a parsed `ImageResponse` or an `ApiError` if sending or decoding fails.

**Call relations**: This is the public entry for image creation. It is called by tests and by any code that wants generated images. Rather than duplicating HTTP and JSON work, it hands off to `ImagesClient::post_image_request`.

*Call graph*: calls 1 internal fn (post_image_request).


##### `ImagesClient::edit`  (lines 47–54)

```
async fn edit(
        &self,
        request: &ImageEditRequest,
        extra_headers: HeaderMap,
    ) -> Result<ImageResponse, ApiError>
```

**Purpose**: Sends an image edit request. A caller uses it when they have an existing image and want the provider to change it according to a prompt.

**Data flow**: It receives an `ImageEditRequest` and any extra HTTP headers. It chooses the `images/edits` API path and labels the operation as `image edit`, then passes everything to the shared POST helper. It returns a parsed `ImageResponse` or an `ApiError`.

**Call relations**: This is the public entry for image editing. It follows the same flow as generation, but targets a different endpoint. It relies on `ImagesClient::post_image_request` for the common send-and-decode work.

*Call graph*: calls 1 internal fn (post_image_request).


##### `ImagesClient::post_image_request`  (lines 56–71)

```
async fn post_image_request(
        &self,
        path: &str,
        request: &R,
        extra_headers: HeaderMap,
        operation: &str,
    ) -> Result<ImageResponse, ApiError>
```

**Purpose**: Performs the common work for both image generation and image editing. It converts a typed request into JSON, sends it as an HTTP POST, and converts the response JSON back into an image response.

**Data flow**: It receives the API path, the request object, extra headers, and a human-readable operation name. First it serializes the request to JSON; if that fails, it returns an `ApiError` explaining that the request could not be encoded. Then it asks the session to execute a POST request. Finally it reads the response body and deserializes it into `ImageResponse`; if that fails, it returns an `ApiError` explaining that the response could not be decoded.

**Call relations**: `generate` and `edit` both call this helper because their mechanics are the same. It hands the actual HTTP work to `EndpointSession::execute`, and uses JSON conversion functions to move between Rust data structures and wire-format JSON.

*Call graph*: calls 1 internal fn (execute); called by 2 (edit, generate); 2 external calls (from_slice, to_value).


##### `tests::DummyAuth::add_auth_headers`  (lines 98–98)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Provides a no-op authentication provider for tests. It satisfies the client’s need for an auth object without adding real credentials.

**Data flow**: It receives mutable HTTP headers but deliberately leaves them unchanged. Nothing is returned, and no authentication data is added.

**Call relations**: The test clients pass `DummyAuth` into `ImagesClient::new`. This keeps the tests focused on image request formatting and response parsing, not on authentication behavior.


##### `tests::CapturingTransport::new`  (lines 108–113)

```
fn new(response_body: Vec<u8>) -> Self
```

**Purpose**: Creates a fake HTTP transport for tests. It records the last request it was asked to send and returns a pre-chosen response body.

**Data flow**: It receives response bytes that should be returned later. It creates shared storage for the last request, wraps the response body so cloned transports share it, and returns a `CapturingTransport` ready for use.

**Call relations**: The image client tests call this before creating an `ImagesClient`. Later, when the client sends a request, `tests::CapturingTransport::execute` stores that request so the test can inspect it.

*Call graph*: 2 external calls (new, new).


##### `tests::CapturingTransport::execute`  (lines 117–124)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Pretends to send an HTTP request during tests. Instead of using the network, it captures the request and returns a successful response with the prepared body.

**Data flow**: It receives a `Request`. It stores a copy in shared test storage, then builds a response with status OK, empty headers, and the configured body bytes. It returns that response as if it came from a real server.

**Call relations**: This is called indirectly when `ImagesClient::post_image_request` asks the session to execute the HTTP POST. The tests then call `tests::captured_request` to check whether the client built the correct URL and JSON body.

*Call graph*: 1 external calls (new).


##### `tests::CapturingTransport::stream`  (lines 126–128)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Rejects streaming requests in these tests. Image generation and editing here are expected to use normal request-response HTTP, not streaming.

**Data flow**: It receives a request but ignores it. It returns a transport build error saying streaming should not run.

**Call relations**: This exists because the fake transport must implement the full `HttpTransport` interface. If image code accidentally tried to stream, this method would make the test fail clearly.

*Call graph*: 1 external calls (Build).


##### `tests::provider`  (lines 131–146)

```
fn provider() -> Provider
```

**Purpose**: Builds a simple provider configuration for tests. It supplies a base URL and retry settings without depending on real production configuration.

**Data flow**: It creates a `Provider` with the name `test`, a fixed base URL, no query parameters, empty headers, short retry delays, and a short stream idle timeout. The finished provider is returned to the caller.

**Call relations**: The tests pass this provider into `ImagesClient::new`. It gives the session enough information to construct full request URLs such as `https://example.com/api/codex/images/generations`.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::response_body`  (lines 148–171)

```
fn response_body() -> Vec<u8>
```

**Purpose**: Builds a realistic successful image API response body for tests. It gives the fake transport JSON bytes that the client should be able to parse.

**Data flow**: It creates a JSON value containing creation time, image data, format-like metadata, quality, size, and usage information. It serializes that JSON into bytes and returns the byte vector.

**Call relations**: The generation and edit tests feed this body into `tests::CapturingTransport::new`. When the client sends a request, the fake transport returns these bytes, and `ImagesClient::post_image_request` must decode them into an `ImageResponse`.

*Call graph*: 2 external calls (json!, to_vec).


##### `tests::expected_response`  (lines 173–183)

```
fn expected_response() -> ImageResponse
```

**Purpose**: Builds the `ImageResponse` value that the tests expect after decoding the fake JSON response.

**Data flow**: It creates an `ImageResponse` with the expected timestamp, background, one base64 image entry, quality, and size. It returns that structured value for comparison.

**Call relations**: The generation and edit tests compare the actual client result with this expected value. This confirms that response parsing keeps the fields the image API client cares about.

*Call graph*: 1 external calls (vec!).


##### `tests::captured_request`  (lines 185–192)

```
fn captured_request(transport: &CapturingTransport) -> Request
```

**Purpose**: Retrieves the request that the fake transport most recently recorded. Tests use it to inspect what the client tried to send.

**Data flow**: It receives a reference to the fake transport. It locks the shared request storage, clones the saved request, and returns it. If no request was saved, the test fails with a clear message.

**Call relations**: After `generate` or `edit` runs, the tests call this helper. It connects the fake transport’s captured data back to the assertions about URL and JSON request body.


##### `tests::generate_posts_typed_request_and_parses_image_response`  (lines 195–231)

```
async fn generate_posts_typed_request_and_parses_image_response()
```

**Purpose**: Tests the image generation path from typed request to outgoing HTTP request to parsed response.

**Data flow**: It creates a fake transport loaded with a valid response body, builds an image client, and sends an `ImageGenerationRequest`. It checks that the returned response matches `tests::expected_response`, then retrieves the captured request and checks that the URL and JSON body are correct.

**Call relations**: This test exercises `ImagesClient::new`, `ImagesClient::generate`, the shared POST helper, and the fake transport. It proves that generation calls the `images/generations` endpoint and serializes only the intended fields.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, new, assert_eq!, new, captured_request, provider, response_body).


##### `tests::edit_posts_typed_request_and_parses_image_response`  (lines 234–268)

```
async fn edit_posts_typed_request_and_parses_image_response()
```

**Purpose**: Tests the image editing path from typed request to outgoing HTTP request to parsed response.

**Data flow**: It creates a fake transport with a valid response body, builds an image client, and sends an `ImageEditRequest` containing an image URL and prompt. It checks the parsed response, then inspects the captured request to verify the edit URL and JSON body.

**Call relations**: This test exercises `ImagesClient::new`, `ImagesClient::edit`, the shared POST helper, and the fake transport. It proves that editing calls the `images/edits` endpoint and omits optional fields that were not set.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, new, assert_eq!, new, captured_request, provider, response_body, vec!).


##### `tests::image_response_requires_image_data`  (lines 271–299)

```
async fn image_response_requires_image_data()
```

**Purpose**: Tests that the client rejects an image response without required image data. This protects callers from receiving a supposedly successful result that contains no usable image.

**Data flow**: It creates a fake response body containing only a creation timestamp and no `data` field. It sends a generation request and expects an error. It then checks that the error message says decoding failed because the required `data` field is missing.

**Call relations**: This test drives the same `ImagesClient::generate` and response-decoding path as the happy-path generation test, but with invalid response JSON. It confirms that `ImagesClient::post_image_request` reports malformed provider responses instead of silently accepting them.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, new, assert!, new, provider, json!, panic!, to_vec).


### `codex-api/src/endpoint/search.rs`

`io_transport` · `active whenever a search API request is made; test helpers run during tests`

This file exists so the rest of the project can ask for a web-style search without hand-building HTTP requests each time. Instead of every caller remembering the URL path, headers, authentication, JSON shape, and response parsing rules, they use `SearchClient`.

`SearchClient` is built around an `EndpointSession`, which is the shared piece that knows how to talk to a provider: where the API lives, how authentication headers are added, and how the actual HTTP transport is used. The search client adds the search-specific part: the endpoint path is `alpha/search`, the method is POST, and the body is a serialized `SearchRequest`.

The main flow is simple. A caller creates a client with a transport, provider settings, and an authentication provider. When `search` is called, the typed request is converted into JSON. The session sends that JSON to the search endpoint with any extra headers the caller supplied. When bytes come back, they are decoded as a `SearchResponse`. If the request cannot be encoded or the response cannot be decoded, the function returns an API error with a clear message.

The test code builds a fake transport that records the outgoing request instead of using the network. That lets the test prove two things: the client sends the exact JSON shape expected by the API, and it correctly reads the response JSON.

#### Function details

##### `SearchClient::new`  (lines 19–23)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a search client ready to send requests through a chosen HTTP transport, provider configuration, and authentication provider. Use this when code wants to talk to the search endpoint without manually wiring those pieces each time.

**Data flow**: It receives a transport, provider settings such as the base URL, and shared authentication. It wraps them in an `EndpointSession`, which is the common request-sending helper, and stores that session inside a new `SearchClient`. The result is a client object that can later send search requests.

**Call relations**: Higher-level code, including `handle_call` and the test in this file, calls this first to build the client. Internally it hands the setup work to `EndpointSession::new`, so later `SearchClient::search` can focus only on the search-specific request.

*Call graph*: calls 1 internal fn (new); called by 2 (search_posts_typed_request_and_parses_output, handle_call).


##### `SearchClient::with_telemetry`  (lines 25–29)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the search client that also reports request telemetry, if telemetry is supplied. Telemetry means extra observation data about requests, such as timing or tracing, used to understand what happened during a call.

**Data flow**: It takes an existing client and an optional shared telemetry object. It passes that telemetry into the stored endpoint session and returns a new `SearchClient` containing the updated session. Nothing is sent immediately; it only changes how future requests are observed.

**Call relations**: This sits between client creation and actual searching. It delegates to the session's telemetry setup, then later `SearchClient::search` benefits from that session configuration when it sends the request.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `SearchClient::path`  (lines 31–33)

```
fn path() -> &'static str
```

**Purpose**: Provides the fixed API path used for search requests. Keeping this in one small function avoids scattering the endpoint string through the file.

**Data flow**: It takes no input and always returns the same text path, `alpha/search`. It does not read or change any outside state.

**Call relations**: `SearchClient::search` asks this function for the path right before sending the POST request. This keeps the endpoint address separate from the rest of the request-building steps.


##### `SearchClient::search`  (lines 35–48)

```
async fn search(
        &self,
        request: &SearchRequest,
        extra_headers: HeaderMap,
    ) -> Result<SearchResponse, ApiError>
```

**Purpose**: Sends one typed search request to the API and returns the typed search response. This is the main function callers use when they want the service to perform a search.

**Data flow**: It receives a `SearchRequest` and any extra HTTP headers. First it converts the request into JSON; if that fails, it returns an API error. Then it asks the endpoint session to POST that JSON to `alpha/search`. When the response body comes back as bytes, it decodes those bytes into a `SearchResponse`; if decoding fails, it returns an API error instead.

**Call relations**: Callers use this after building a client with `SearchClient::new`. During the call it gets the endpoint from `SearchClient::path`, relies on the session's `execute` method to do the actual HTTP work, and uses JSON conversion functions to move between Rust data and API wire format.

*Call graph*: calls 1 internal fn (execute); 3 external calls (path, from_slice, to_value).


##### `tests::DummyAuth::add_auth_headers`  (lines 84–84)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Provides a no-op authentication provider for tests. It lets the test build a realistic client without adding real credentials or changing the outgoing headers.

**Data flow**: It receives mutable HTTP headers, but deliberately leaves them unchanged. It returns nothing and has no side effects.

**Call relations**: The test passes `DummyAuth` into `SearchClient::new` so the normal client setup path is used. When the endpoint session asks authentication to add headers, this test implementation quietly does nothing.


##### `tests::CapturingTransport::new`  (lines 94–99)

```
fn new(response_body: Vec<u8>) -> Self
```

**Purpose**: Creates a fake HTTP transport for tests that records the request it was asked to send and later returns a prepared response body. This is like a mailbox with a camera: it captures what was posted and hands back a canned reply.

**Data flow**: It receives response bytes that should be returned later. It creates shared storage for the last request, initially empty, and shared storage for the response body. The result is a `CapturingTransport` that can be cloned while still sharing the same captured request.

**Call relations**: The search endpoint test calls this before building the client. Later, when `SearchClient::search` sends a request through the session, the session reaches this fake transport's `execute` method, which records the request for inspection.

*Call graph*: 2 external calls (new, new).


##### `tests::CapturingTransport::execute`  (lines 103–110)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Pretends to send an HTTP request during tests, while actually saving the request and returning a fixed successful response. This avoids network access and makes the test fully predictable.

**Data flow**: It receives a request from the endpoint session. It stores that request in the shared `last_request` slot, then builds a response with status OK, empty headers, and the preconfigured response body. The returned response is what the client later parses.

**Call relations**: This is called indirectly when `SearchClient::search` asks the session to execute the POST request. After the search call finishes, the test reads the stored request to check that the JSON body was exactly what it expected.

*Call graph*: 1 external calls (new).


##### `tests::CapturingTransport::stream`  (lines 112–114)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Rejects streaming requests in this test transport because the search client path under test should not use streaming. If streaming happens, the test should fail loudly.

**Data flow**: It receives a request but ignores it. It immediately returns a transport build error saying that streaming should not run. No request is stored and no response stream is created.

**Call relations**: This completes the fake transport's required interface, but the search test expects `SearchClient::search` to use normal `execute`, not `stream`. If some future change accidentally switches this code path to streaming, this function will expose that mistake.

*Call graph*: 1 external calls (Build).


##### `tests::provider`  (lines 117–132)

```
fn provider() -> Provider
```

**Purpose**: Builds a simple provider configuration for tests. It gives the client a base URL, headers, retry rules, and timeouts without depending on real project configuration.

**Data flow**: It takes no input. It creates a `Provider` named `test` with base URL `https://example.com/v1`, no query parameters, empty headers, one retry attempt, short retry delays, and a short stream idle timeout. The completed provider is returned to the test.

**Call relations**: The main test calls this when constructing `SearchClient::new`. The provider then flows into the endpoint session, which uses it while forming the request that the fake transport captures.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::search_posts_typed_request_and_parses_output`  (lines 135–266)

```
async fn search_posts_typed_request_and_parses_output()
```

**Purpose**: Checks that the search client sends the right JSON request and reads the JSON response correctly. It protects the contract between the typed Rust search structures and the API's expected wire format.

**Data flow**: It prepares a fake response body containing `encrypted_output` and `output`, builds a fake transport and search client, then calls `search` with a rich `SearchRequest` containing messages, image input, search commands, settings, and token limits. After the call, it verifies the returned `SearchResponse`. It then inspects the captured outgoing request body and compares it to the exact JSON the API should receive.

**Call relations**: This test drives the full local flow: it creates the fake transport with `tests::CapturingTransport::new`, creates provider settings with `tests::provider`, builds the client with `SearchClient::new`, and then calls `SearchClient::search`. The fake transport's `execute` method supplies the response and records the request so the test can assert both directions of the conversion.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, default, new, assert_eq!, new, provider, Items, json!, to_vec, vec!).


### `codex-api/src/endpoint/realtime_call.rs`

`io_transport` · `realtime call setup`

A WebRTC call starts with an SDP message, which is a text description of media settings and network details. This file packages that SDP offer into the right HTTP request, sends it to the Realtime call endpoint, then unpacks the response so the rest of the app can finish connecting. Without this file, the client could not start Realtime voice or audio calls through the HTTP API.

The main type is RealtimeCallClient. It wraps an EndpointSession, which knows the provider URL, authentication, retries, and request execution. The simplest path sends only raw SDP with the content type application/sdp. A richer path also sends an initial Realtime session configuration, so the server knows things like model, voice, instructions, and output mode as soon as the call begins.

There is one important split: normal API URLs receive a multipart form body, like a package with two labeled compartments: one for SDP and one for session JSON. Backend API URLs receive a single JSON object instead, because that route currently expects a different shape.

After each request, the file decodes the response body as SDP and extracts the call ID from the Location header. The call ID matters because a later sideband WebSocket connection uses it to join this exact call.

#### Function details

##### `RealtimeCallClient::new`  (lines 50–54)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Creates a Realtime call client from a network transport, provider settings, and shared authentication. Use this when code needs an object that can start Realtime WebRTC calls.

**Data flow**: It receives the HTTP transport, the provider information, and an auth provider. It puts them into an EndpointSession, which becomes the client’s stored connection context. The result is a ready-to-use RealtimeCallClient.

**Call relations**: The test cases call this before making any Realtime call request. Inside, it hands the raw pieces to EndpointSession::new so later methods can focus on call creation instead of rebuilding request setup each time.

*Call graph*: calls 1 internal fn (new); called by 6 (errors_when_location_is_missing, extracts_call_id_from_forwarded_backend_location, sends_api_session_call_as_multipart_body, sends_avas_session_call_query_params, sends_backend_session_call_as_json_body, sends_sdp_offer_as_raw_body).


##### `RealtimeCallClient::with_telemetry`  (lines 56–60)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client that will attach optional request telemetry. Telemetry means extra measurement or tracing information about outgoing requests.

**Data flow**: It takes an existing client and an optional telemetry object. It asks the stored EndpointSession to attach that telemetry, then returns a new RealtimeCallClient with the updated session. It does not send a request itself.

**Call relations**: This is a setup step used before real call creation. It delegates to the session’s telemetry support, so the create methods later benefit from request measurement without knowing the telemetry details.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `RealtimeCallClient::path`  (lines 62–64)

```
fn path() -> &'static str
```

**Purpose**: Provides the fixed API path for creating Realtime calls. Keeping it in one function avoids repeating the string in every request builder.

**Data flow**: It takes no input. It returns the endpoint path string realtime/calls. Nothing else changes.

**Call relations**: The request-making methods use this path when they ask EndpointSession to execute a POST request. The session combines it with the provider’s base URL.


##### `RealtimeCallClient::uses_backend_request_shape`  (lines 66–68)

```
fn uses_backend_request_shape(&self) -> bool
```

**Purpose**: Decides whether this client should use the backend-specific request format instead of the public API format. This matters because the two endpoints expect different body shapes.

**Data flow**: It reads the provider base URL from the stored session. If the URL contains /backend-api, it returns true; otherwise it returns false. It does not modify anything.

**Call relations**: The session-aware call creation method uses this as a fork in the road. A true result leads to a JSON request body, while a false result leads to a multipart form body.

*Call graph*: calls 1 internal fn (provider); called by 1 (create_with_session_architecture_and_headers).


##### `RealtimeCallClient::create`  (lines 79–81)

```
async fn create(&self, sdp: String) -> Result<RealtimeCallResponse, ApiError>
```

**Purpose**: Starts a Realtime call using only an SDP offer and no extra headers. This is the simplest way to create a call.

**Data flow**: It receives the local SDP offer as text. It passes that text along with an empty header map to create_with_headers. It returns the server’s SDP answer and call ID, or an API error.

**Call relations**: This is a convenience wrapper. It is called by tests that check the plain SDP flow, and it hands the actual request work to create_with_headers.

*Call graph*: calls 1 internal fn (create_with_headers); 1 external calls (new).


##### `RealtimeCallClient::create_with_session`  (lines 83–90)

```
async fn create_with_session(
        &self,
        sdp: String,
        session_config: RealtimeSessionConfig,
    ) -> Result<RealtimeCallResponse, ApiError>
```

**Purpose**: Starts a Realtime call and includes an initial session configuration. Use this when the server should know model, voice, and instructions during call creation.

**Data flow**: It receives SDP text and a Realtime session configuration. It adds no custom headers, then forwards everything to create_with_session_and_headers. The output is the same call response or an error.

**Call relations**: This is a convenience wrapper for the more complete session creation flow. Tests use it to verify both public API and backend API session request formats.

*Call graph*: calls 1 internal fn (create_with_session_and_headers); 1 external calls (new).


##### `RealtimeCallClient::create_with_headers`  (lines 92–116)

```
async fn create_with_headers(
        &self,
        sdp: String,
        extra_headers: HeaderMap,
    ) -> Result<RealtimeCallResponse, ApiError>
```

**Purpose**: Starts a Realtime call with raw SDP and caller-supplied extra HTTP headers. This is useful when a caller needs to add special headers while keeping the basic SDP-only request.

**Data flow**: It receives SDP text and extra headers. It builds a POST request to realtime/calls, marks the body as application/sdp, sends the raw SDP bytes, then waits for the response. It turns the response body into SDP text and pulls the call ID from the Location header.

**Call relations**: The simple create method calls this. It relies on EndpointSession to send the request, then uses decode_sdp_response and decode_call_id_from_location to turn the HTTP response into a RealtimeCallResponse.

*Call graph*: calls 3 internal fn (decode_call_id_from_location, decode_sdp_response, execute_with); called by 1 (create); 1 external calls (path).


##### `RealtimeCallClient::create_with_session_and_headers`  (lines 118–131)

```
async fn create_with_session_and_headers(
        &self,
        sdp: String,
        session_config: RealtimeSessionConfig,
        extra_headers: HeaderMap,
    ) -> Result<RealtimeCallResponse, Api
```

**Purpose**: Starts a Realtime call with session configuration and extra headers, using the default Realtime API conversation architecture. It is a middle-level helper for callers that need headers but not architecture customization.

**Data flow**: It receives SDP, session configuration, and headers. It adds the default architecture choice and forwards everything to create_with_session_architecture_and_headers. It returns the created call response or an error.

**Call relations**: create_with_session calls this with empty headers. This function then hands off to the most detailed session-aware creation method.

*Call graph*: calls 1 internal fn (create_with_session_architecture_and_headers); called by 1 (create_with_session).


##### `RealtimeCallClient::create_with_session_architecture_and_headers`  (lines 133–208)

```
async fn create_with_session_architecture_and_headers(
        &self,
        sdp: String,
        session_config: RealtimeSessionConfig,
        architecture: RealtimeConversationArchitecture,
```

**Purpose**: Creates a Realtime call while also sending session settings, extra headers, and an architecture choice. This is the main full-featured call creation path.

**Data flow**: It receives SDP text, a session configuration, a conversation architecture, and extra headers. It converts the session configuration into JSON, removes the session id because call creation should not send it, then chooses a body format. Backend URLs get a JSON object containing SDP and session data; normal API URLs get a multipart body with separate SDP and session sections. It sends the POST request, decodes the returned SDP answer, extracts the call ID, and returns both.

**Call relations**: create_with_session_and_headers calls this. It uses realtime_session_json to prepare the session, uses uses_backend_request_shape to choose the request format, uses configure_realtime_call_request to add architecture-specific URL details, and finally uses the decode helpers to interpret the response.

*Call graph*: calls 5 internal fn (uses_backend_request_shape, decode_call_id_from_location, decode_sdp_response, realtime_session_json, execute_with); called by 1 (create_with_session_and_headers); 6 external calls (path, new, format!, to_string, to_value, trace!).


##### `configure_realtime_call_request`  (lines 211–222)

```
fn configure_realtime_call_request(
    request: &mut Request,
    architecture: RealtimeConversationArchitecture,
)
```

**Purpose**: Adds architecture-specific URL query parameters to a Realtime call request when needed. Query parameters are the key-value options after a question mark in a URL.

**Data flow**: It receives a mutable request and an architecture choice. For the standard Realtime API architecture, it leaves the request unchanged. For the Avas architecture, it appends intent=quicksilver and architecture=avas to the request URL.

**Call relations**: The session-aware call creation method calls this while preparing the HTTP request. When it needs to add URL options, it delegates the actual string editing to append_query_pair.

*Call graph*: calls 1 internal fn (append_query_pair).


##### `append_query_pair`  (lines 224–233)

```
fn append_query_pair(url: &mut String, key: &str, value: &str)
```

**Purpose**: Adds one key-value pair to the query part of a URL string. It is a small helper that avoids duplicating the question-mark-versus-ampersand rule.

**Data flow**: It receives a mutable URL string plus a key and value. If the URL already has a question mark, it adds an ampersand; otherwise it adds a question mark. Then it appends key=value to the URL.

**Call relations**: configure_realtime_call_request calls this when building the Avas-specific request URL. It does not know anything about Realtime calls; it only edits the URL text.

*Call graph*: called by 1 (configure_realtime_call_request).


##### `realtime_session_json`  (lines 235–238)

```
fn realtime_session_json(session_config: RealtimeSessionConfig) -> Result<Value, ApiError>
```

**Purpose**: Converts a Realtime session configuration into JSON for call creation. JSON is a common text-like data format used in API requests.

**Data flow**: It receives a RealtimeSessionConfig. It asks the websocket session code to build the session.update-style JSON, then converts any encoding failure into this file’s API error type. The result is a JSON value ready to include in the call request.

**Call relations**: The full session call creation method uses this before sending a request. Some tests also call it to build the expected request body and compare that expected body against what the client sent.

*Call graph*: called by 3 (create_with_session_architecture_and_headers, sends_api_session_call_as_multipart_body, sends_backend_session_call_as_json_body); 1 external calls (session_update_session_json).


##### `decode_sdp_response`  (lines 240–246)

```
fn decode_sdp_response(body: &[u8]) -> Result<String, ApiError>
```

**Purpose**: Turns the HTTP response body into SDP text. This is needed because the server’s WebRTC answer is returned as raw bytes.

**Data flow**: It receives a byte slice from the response body. It tries to read those bytes as UTF-8 text, the usual encoding for strings on the web. On success it returns the SDP string; on failure it returns an API error explaining that the SDP response could not be decoded.

**Call relations**: Both raw SDP and session-aware call creation paths use this after EndpointSession returns a response. It is one half of turning a generic HTTP response into a RealtimeCallResponse.

*Call graph*: called by 2 (create_with_headers, create_with_session_architecture_and_headers); 1 external calls (from_utf8).


##### `decode_call_id_from_location`  (lines 248–268)

```
fn decode_call_id_from_location(headers: &HeaderMap) -> Result<String, ApiError>
```

**Purpose**: Finds the Realtime call ID inside the response Location header. The call ID is needed later so a sideband WebSocket can join the exact call that was just created.

**Data flow**: It receives response headers. It looks for the Location header, checks that it is valid text, ignores any query string, then scans path segments from the end until it finds something that looks like a Realtime call ID. It returns that ID as a string or an API error if none can be found.

**Call relations**: The call creation methods use this after every successful HTTP response. Tests call it directly to confirm that missing or malformed locations fail and UUID-shaped call IDs are accepted.

*Call graph*: called by 4 (create_with_headers, create_with_session_architecture_and_headers, accepts_uuid_call_id_from_location, rejects_location_without_call_id); 2 external calls (get, trace!).


##### `is_realtime_call_id_segment`  (lines 270–283)

```
fn is_realtime_call_id_segment(segment: &str) -> bool
```

**Purpose**: Checks whether one URL path segment looks like a valid Realtime call ID. It accepts both rtc_-prefixed IDs and UUID-style IDs.

**Data flow**: It receives one piece of a URL path. If the piece starts with rtc_ and has more characters after that, it returns true. Otherwise it checks for the 36-character UUID pattern with dashes in the right places and hexadecimal digits elsewhere. It returns true or false.

**Call relations**: decode_call_id_from_location uses this while scanning the Location header. This helper keeps the ID recognition rule separate from the header parsing work.


##### `tests::CapturingTransport::new`  (lines 310–312)

```
fn new() -> Self
```

**Purpose**: Creates a fake HTTP transport for tests with a normal Realtime call Location header. It lets tests inspect what request the client tried to send.

**Data flow**: It takes no input. It calls the location-based constructor with /v1/realtime/calls/rtc_test. The result is a CapturingTransport that will save the next request and return a canned response.

**Call relations**: Most tests use this to stand in for the network. It delegates to tests::CapturingTransport::with_location so all fake transport setup stays in one place.

*Call graph*: 1 external calls (with_location).


##### `tests::CapturingTransport::with_location`  (lines 314–321)

```
fn with_location(location: &str) -> Self
```

**Purpose**: Creates a fake test transport that returns a chosen Location header. This helps tests check how call IDs are extracted from different server locations.

**Data flow**: It receives a Location header string. It creates response headers containing that value, initializes empty storage for the last request, and returns the fake transport. Later, execute will store the request and return these headers.

**Call relations**: The default fake transport constructor calls this, and tests use it directly for backend-style Location paths. It supports tests that need precise control over the server’s fake response.

*Call graph*: 4 external calls (new, new, from_str, new).


##### `tests::CapturingTransport::without_location`  (lines 323–328)

```
fn without_location() -> Self
```

**Purpose**: Creates a fake test transport that returns no Location header. This is used to prove the client reports a clear error when the server response is incomplete.

**Data flow**: It takes no input. It creates empty last-request storage and an empty header map. The returned transport will still return a successful status and body, but without the call ID location.

**Call relations**: The missing-location test uses this before calling the client. It sets up the exact failure condition that decode_call_id_from_location should detect.

*Call graph*: 3 external calls (new, new, new).


##### `tests::CapturingTransport::execute`  (lines 332–339)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Imitates sending an HTTP request in tests, without using the network. It records the request so the test can inspect it afterward.

**Data flow**: It receives a Request. It stores that request in shared test memory, then returns a fake successful response with the configured headers and a small SDP body. The outside world is not contacted.

**Call relations**: EndpointSession calls this when the client under test thinks it is making a real HTTP request. The tests then read the captured request to confirm URL, headers, and body.

*Call graph*: 2 external calls (from_static, clone).


##### `tests::CapturingTransport::stream`  (lines 341–343)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Rejects streaming requests in this fake transport. These tests are only about one-shot HTTP calls, not streaming responses.

**Data flow**: It receives a request but ignores it. It returns a transport build error saying streaming should not run. Nothing is recorded or streamed.

**Call relations**: This completes the HttpTransport interface for the fake transport. If code accidentally tries to use streaming during these tests, the test will fail loudly.

*Call graph*: 1 external calls (Build).


##### `tests::DummyAuth::add_auth_headers`  (lines 350–355)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds a fixed test Authorization header. This proves that the client includes authentication without needing real credentials.

**Data flow**: It receives mutable HTTP headers. It inserts Authorization: Bearer test-token. It returns nothing, but the headers are changed.

**Call relations**: EndpointSession calls this while preparing requests in tests. The raw SDP test then checks that the captured request contains the expected auth header.

*Call graph*: 2 external calls (insert, from_static).


##### `tests::provider`  (lines 358–373)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Builds provider settings for tests. A provider describes the API base URL, retry behavior, headers, and timeouts.

**Data flow**: It receives a base URL string. It creates a Provider named test with that base URL, no extra query parameters, empty headers, short retry delays, and a short stream idle timeout. The result is passed into RealtimeCallClient::new.

**Call relations**: All client tests use this to create public API or backend API providers. Changing the base URL lets tests exercise both request body formats.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::realtime_session_config`  (lines 375–385)

```
fn realtime_session_config(session_id: &str) -> RealtimeSessionConfig
```

**Purpose**: Builds a standard Realtime session configuration for tests. This avoids repeating model, voice, mode, and instruction settings in every test.

**Data flow**: It receives a session ID string. It returns a RealtimeSessionConfig with fixed instructions, model, parser, mode, audio output, and voice, plus the provided session ID.

**Call relations**: The session-related tests call this before creating calls or building expected JSON. It gives all those tests a consistent session input.


##### `tests::sends_sdp_offer_as_raw_body`  (lines 388–427)

```
async fn sends_sdp_offer_as_raw_body()
```

**Purpose**: Checks that the simplest call creation path sends raw SDP correctly. It also confirms the response is decoded into SDP and call ID.

**Data flow**: It creates a fake transport, provider, auth, and client. It calls create with an SDP offer, then compares the returned response with the expected SDP answer and call ID. It also inspects the captured request for method, URL, content type, auth header, and raw body.

**Call relations**: This test exercises RealtimeCallClient::new and the create path through the fake transport. It verifies the behavior of create_with_headers indirectly.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, new, provider).


##### `tests::extracts_call_id_from_forwarded_backend_location`  (lines 430–462)

```
async fn extracts_call_id_from_forwarded_backend_location()
```

**Purpose**: Checks that the client can find a call ID in a backend-forwarded Location path. Backend paths may include extra segments, so the parser must not assume the ID is always in one exact position.

**Data flow**: It creates a fake transport with a backend-like Location value, then calls create. It expects the response call ID to be rtc_backend_test and checks that the request used the backend base URL while still sending raw SDP.

**Call relations**: This test uses RealtimeCallClient::new and the raw create path. It especially confirms decode_call_id_from_location can scan through a forwarded backend Location.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, with_location, provider).


##### `tests::sends_api_session_call_as_multipart_body`  (lines 465–524)

```
async fn sends_api_session_call_as_multipart_body()
```

**Purpose**: Checks that public API session-aware calls are sent as multipart form data. Multipart form data is like an envelope with separate labeled parts.

**Data flow**: It creates a client for the public API URL and calls create_with_session. Then it inspects the captured request, checks the multipart content type, rebuilds the expected session JSON with the id removed, and compares the whole raw multipart body to the expected text.

**Call relations**: This test exercises the non-backend branch of create_with_session_architecture_and_headers. It also calls realtime_session_json directly to build the expected session part.

*Call graph*: calls 2 internal fn (new, realtime_session_json); 8 external calls (new, assert_eq!, new, provider, realtime_session_config, panic!, to_string, from_utf8).


##### `tests::sends_avas_session_call_query_params`  (lines 527–559)

```
async fn sends_avas_session_call_query_params()
```

**Purpose**: Checks that the Avas architecture adds the right query parameters to the call creation URL. This ensures the server receives the architecture hint it expects.

**Data flow**: It creates a public API client and calls create_with_session_architecture_and_headers with the Avas architecture. It then checks that the captured request URL includes intent=quicksilver and architecture=avas.

**Call relations**: This test goes through the full session-aware creation method. It verifies the effect of configure_realtime_call_request and append_query_pair from the outside.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, assert_eq!, new, provider, realtime_session_config).


##### `tests::sends_backend_session_call_as_json_body`  (lines 562–608)

```
async fn sends_backend_session_call_as_json_body()
```

**Purpose**: Checks that backend API session-aware calls are sent as JSON, not multipart form data. This protects compatibility with the backend route’s current expectations.

**Data flow**: It creates a client whose base URL contains /backend-api, calls create_with_session, then inspects the captured request. It builds the expected session JSON with the id removed and compares the request body to the expected JSON object containing SDP and session.

**Call relations**: This test exercises the backend branch selected by uses_backend_request_shape. It calls realtime_session_json directly to build the expected body for comparison.

*Call graph*: calls 2 internal fn (new, realtime_session_json); 5 external calls (new, assert_eq!, new, provider, realtime_session_config).


##### `tests::errors_when_location_is_missing`  (lines 611–628)

```
async fn errors_when_location_is_missing()
```

**Purpose**: Checks that the client fails clearly when the server response does not include a Location header. Without that header, the client cannot know the call ID.

**Data flow**: It creates a fake transport with no Location header, then calls create. It expects an error and compares the error text to the expected missing-Location message.

**Call relations**: This test uses RealtimeCallClient::new and the raw create path. It verifies that decode_call_id_from_location reports the missing header instead of silently returning a bad response.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, without_location, provider).


##### `tests::rejects_location_without_call_id`  (lines 631–642)

```
fn rejects_location_without_call_id()
```

**Purpose**: Checks that a Location header without an actual call ID is rejected. This prevents later code from trying to join a call with an empty or wrong identifier.

**Data flow**: It creates headers with Location set to /v1/realtime/calls, then calls decode_call_id_from_location directly. It expects an error and checks the exact message.

**Call relations**: This test focuses on the call ID parser without making a full client request. It confirms the parser does not mistake ordinary path words for a call ID.

*Call graph*: calls 1 internal fn (decode_call_id_from_location); 3 external calls (new, from_static, assert_eq!).


##### `tests::accepts_uuid_call_id_from_location`  (lines 645–655)

```
fn accepts_uuid_call_id_from_location()
```

**Purpose**: Checks that UUID-shaped call IDs are accepted, not only IDs that start with rtc_. A UUID is a common 36-character identifier with dashes.

**Data flow**: It creates headers containing a Location path ending in a UUID-like value. It calls decode_call_id_from_location and expects that UUID string to be returned.

**Call relations**: This test directly exercises the call ID decoding helper. It confirms the ID recognition rule in is_realtime_call_id_segment supports both current accepted formats.

*Call graph*: calls 1 internal fn (decode_call_id_from_location); 3 external calls (new, from_static, assert_eq!).


### Core transport orchestration
These files assemble session-scoped model transport behavior in core, including client setup, retries, prewarming, and the streamed remote compaction flow.

### `core/src/client.rs`

`io_transport` · `request handling`

This file exists so the rest of Codex can ask a model for work without knowing all the details of provider setup, authentication, routing headers, retry rules, WebSocket reuse, and streaming event conversion. Think of it as the travel desk for model calls: callers say where they need to go, and this file books the route, carries the right papers, watches for delays, and switches trains if needed.

The long-lived `ModelClient` stores session-wide facts such as the provider, thread id, auth environment, feature headers, attestation support, and whether WebSockets have been disabled after a failure. For each user turn, `ModelClientSession` holds short-lived state: a reusable WebSocket connection, the previous request/response needed for incremental WebSocket sends, and a sticky routing token called `x-codex-turn-state` that must stay within one turn only.

The main path builds a Responses API request from a prompt, model settings, tools, reasoning options, output schema controls, and metadata. If WebSockets are available, it tries that first, including optional preconnect or prewarm. If WebSockets are unsupported or fail in specific ways, it falls back to HTTP streaming for the rest of the session. It also supports non-streaming calls for conversation compaction, memory summarization, and starting realtime WebRTC calls. Along the way it refreshes auth once after unauthorized responses, records timing and failure details, and maps low-level API events into Codex's internal response stream.

#### Function details

##### `RequestRouteTelemetry::for_endpoint`  (lines 203–205)

```
fn for_endpoint(endpoint: &'static str) -> Self
```

**Purpose**: Creates a small telemetry label that says which API endpoint a request is using. This lets later logging distinguish, for example, normal response streaming from compaction or memory summarization.

**Data flow**: It receives a fixed endpoint string, stores it in a `RequestRouteTelemetry` value, and returns that value for telemetry code to read later.

**Call relations**: Higher-level request paths create this label before building telemetry. The label is then carried into API, SSE, or WebSocket telemetry so records can be tied back to the endpoint being contacted.

*Call graph*: called by 5 (compact_conversation_history, summarize_memories, preconnect_websocket, stream_responses_api, stream_responses_websocket).


##### `responses_request_properties_match`  (lines 272–321)

```
fn responses_request_properties_match(
    previous: &ResponsesApiRequest,
    current: &ResponsesApiRequest,
) -> bool
```

**Purpose**: Checks whether two Responses API requests are the same in every way that matters for safely sending only a WebSocket delta. It deliberately ignores the input and client metadata because those are checked or handled separately.

**Data flow**: It receives a previous request and a current request, compares model, instructions, tools, reasoning, streaming options, service tier, cache key, and text controls, and returns `true` only when those request settings match.

**Call relations**: The WebSocket incremental-send logic calls this before trying to reuse the previous response id. If the settings changed, the session sends a full request instead of a smaller follow-up.

*Call graph*: called by 1 (get_incremental_items).


##### `WebsocketSession::set_connection_reused`  (lines 324–329)

```
fn set_connection_reused(&self, connection_reused: bool)
```

**Purpose**: Records whether the current WebSocket request is using an already-open connection. This matters for telemetry and auth debugging.

**Data flow**: It receives a boolean, locks a small shared value inside the WebSocket session, and replaces the old reuse flag with the new one.

**Call relations**: Connection setup, reset, and preconnect code update this flag. Later, the WebSocket streaming path reads it and passes it to the API layer so timing records can say whether the socket was fresh or reused.

*Call graph*: called by 3 (preconnect_websocket, reset_websocket_session, websocket_connection); 1 external calls (lock).


##### `WebsocketSession::connection_reused`  (lines 331–336)

```
fn connection_reused(&self) -> bool
```

**Purpose**: Reads the remembered WebSocket reuse flag. Callers use it when reporting or sending a request over the socket.

**Data flow**: It locks the stored boolean, copies its current value, and returns it without changing the session.

**Call relations**: The WebSocket streaming path asks for this value just before sending a request. That value is then handed to the underlying WebSocket connection for telemetry.

*Call graph*: called by 1 (stream_responses_websocket); 1 external calls (lock).


##### `sideband_websocket_auth_headers`  (lines 360–364)

```
fn sideband_websocket_auth_headers(api_auth: &dyn AuthProvider) -> ApiHeaderMap
```

**Purpose**: Builds the authentication headers needed for a realtime sideband WebSocket to join a WebRTC call created earlier. It preserves the same identity used to create the call.

**Data flow**: It receives an auth provider, creates an empty header map, asks the auth provider to add its headers, and returns the filled map.

**Call relations**: Realtime call creation uses this after preparing the HTTP call request. The returned headers are stored with the call details so later sideband WebSocket machinery can join the same call.

*Call graph*: called by 1 (create_realtime_call_with_headers); 2 external calls (new, add_auth_headers).


##### `ModelClient::new`  (lines 372–408)

```
fn new(
        auth_manager: Option<Arc<AuthManager>>,
        thread_id: ThreadId,
        provider_info: ModelProviderInfo,
        session_source: SessionSource,
        model_verbosity: Option<Ve
```

**Purpose**: Creates the long-lived model client for one Codex session. It gathers stable session settings such as provider choice, auth setup, telemetry context, WebSocket state, and attestation support.

**Data flow**: It receives session configuration and an optional auth manager, builds a shared provider, collects auth-environment telemetry, creates default WebSocket cache state, and returns a `ModelClient` ready to create per-turn sessions.

**Call relations**: Session setup code and tests construct this client before any model calls happen. Later methods clone it cheaply and use its shared state for streaming, compaction, memory, and realtime requests.

*Call graph*: calls 1 internal fn (collect_auth_env_telemetry); called by 13 (model_client_with_counting_attestation, test_model_client, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, test_model_client_session, responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids (+3 more)); 5 external calls (new, new, new, create_model_provider, default).


##### `ModelClient::with_prompt_cache_key_override`  (lines 410–416)

```
fn with_prompt_cache_key_override(
        mut self,
        prompt_cache_key_override: Option<String>,
    ) -> Self
```

**Purpose**: Returns a copy of the client that uses a caller-supplied prompt cache key instead of the session thread id. This is useful when tests or special flows need cache behavior to be controlled explicitly.

**Data flow**: It receives the client by value plus an optional string, stores that optional override, and returns the modified client.

**Call relations**: When request-building later asks for the prompt cache key, this override wins. If no override was set, normal session-based caching is used.


##### `ModelClient::prompt_cache_key`  (lines 418–422)

```
fn prompt_cache_key(&self) -> String
```

**Purpose**: Chooses the prompt cache key to attach to model requests. The cache key helps the provider reuse prior prompt processing for the same thread or chosen override.

**Data flow**: It reads the optional override; if present it returns that string, otherwise it converts the session thread id into a string and returns it.

**Call relations**: The Responses request builder calls this while assembling the request body. The resulting value travels to the provider as part of every relevant model request.

*Call graph*: called by 1 (build_responses_request).


##### `ModelClient::new_session`  (lines 428–434)

```
fn new_session(&self) -> ModelClientSession
```

**Purpose**: Starts a fresh per-turn model session. It gives the turn its own sticky routing state while reusing any cached WebSocket connection from the long-lived client.

**Data flow**: It takes any cached WebSocket session from shared storage, creates a new one-time turn-state holder, and returns a `ModelClientSession` tied to this client.

**Call relations**: Turn execution code calls this before streaming. When the session is later dropped, its WebSocket state is stored back for possible reuse by the next turn.

*Call graph*: calls 1 internal fn (take_cached_websocket_session); 2 external calls (new, new).


##### `ModelClient::auth_manager`  (lines 436–438)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Exposes the optional authentication manager associated with the model provider. Callers use it when they need session auth services directly.

**Data flow**: It reads the provider's stored auth manager and returns a cloned shared pointer if one exists.

**Call relations**: This is a small access point from the model client to the login layer. Most request paths instead use `current_client_setup`, which resolves auth for a specific attempt.


##### `ModelClient::take_cached_websocket_session`  (lines 440–447)

```
fn take_cached_websocket_session(&self) -> WebsocketSession
```

**Purpose**: Moves the cached WebSocket session out of the shared client state so a new turn can use it. This avoids two turn sessions trying to own the same socket state at once.

**Data flow**: It locks the shared cache, replaces it with an empty default session, and returns the previous cached session.

**Call relations**: Only new per-turn session creation uses this. The matching drop path later puts the WebSocket session back into the client cache.

*Call graph*: called by 1 (new_session); 1 external calls (take).


##### `ModelClient::store_cached_websocket_session`  (lines 449–455)

```
fn store_cached_websocket_session(&self, websocket_session: WebsocketSession)
```

**Purpose**: Stores WebSocket session state back into the long-lived client. This makes connection reuse possible across turn sessions.

**Data flow**: It receives a WebSocket session, locks the shared cache, and replaces whatever was there with the provided session.

**Call relations**: A `ModelClientSession` calls this when it is dropped. HTTP fallback also calls it with an empty session to clear any unusable socket state.

*Call graph*: called by 2 (force_http_fallback, drop).


##### `ModelClient::force_http_fallback`  (lines 457–476)

```
fn force_http_fallback(
        &self,
        session_telemetry: &SessionTelemetry,
        _model_info: &ModelInfo,
    ) -> bool
```

**Purpose**: Permanently switches this Codex session away from Responses-over-WebSocket and onto HTTP. This is used when WebSockets are unsupported or unhealthy enough that retrying them would waste time.

**Data flow**: It checks whether WebSockets were still enabled, atomically marks them disabled, records a fallback telemetry counter if this call caused the switch, clears cached WebSocket state, and returns whether fallback was newly activated.

**Call relations**: The per-turn session calls this through `try_switch_fallback_transport`. After it runs, later streams skip the WebSocket path and go straight to HTTP.

*Call graph*: calls 3 internal fn (responses_websocket_enabled, store_cached_websocket_session, counter); called by 1 (try_switch_fallback_transport); 2 external calls (default, warn!).


##### `ModelClient::compact_conversation_history`  (lines 486–580)

```
async fn compact_conversation_history(
        &self,
        prompt: &Prompt,
        model_info: &ModelInfo,
        turn_state: Option<Arc<OnceLock<String>>>,
        settings: CompactConversationR
```

**Purpose**: Sends the current conversation transcript to the compact endpoint and receives a shorter replacement transcript. This keeps long sessions from growing too large while preserving useful context.

**Data flow**: It receives a prompt, model settings, optional turn state, telemetry, trace context, and metadata. If there is no input it returns an empty list; otherwise it resolves auth/provider setup, builds a Responses-like payload and headers, calls the compact API, records the trace result, and returns compacted response items or an error.

**Call relations**: Compaction flows call this when they need to shrink history. It reuses the same request-building, auth, header, attestation, and telemetry conventions as normal model calls so compaction behaves like the rest of the session.

*Call graph*: calls 11 internal fn (new, new, build_responses_compatibility_headers, build_responses_request, current_client_setup, generate_attestation_header_for, for_endpoint, add_responses_lite_header, build_responses_headers, build_reqwest_client (+1 more)); 7 external calls (new, new, from_str, build_request_telemetry, new, build_session_headers, default).


##### `ModelClient::create_realtime_call_with_headers`  (lines 582–616)

```
async fn create_realtime_call_with_headers(
        &self,
        sdp: String,
        session_config: ApiRealtimeSessionConfig,
        architecture: RealtimeConversationArchitecture,
        mut ex
```

**Purpose**: Starts a realtime WebRTC call through the model provider and returns the details needed to connect media and sideband control. WebRTC is a browser-style realtime media connection; the sideband WebSocket is a separate control channel for the same call.

**Data flow**: It receives an SDP offer string, realtime session config, architecture choice, extra headers, and an optional provider override. It resolves auth/provider setup, adds attestation if available, prepares sideband auth headers, sends the HTTP call-create request, and returns the SDP answer, call id, and sideband headers.

**Call relations**: Realtime session setup calls this before ordinary realtime WebSocket control attaches. The function keeps the HTTP-created call identity and the sideband auth identity aligned.

*Call graph*: calls 5 internal fn (new, current_client_setup, generate_attestation_header_for, sideband_websocket_auth_headers, build_reqwest_client); 3 external calls (clone, insert, new).


##### `ModelClient::summarize_memories`  (lines 624–665)

```
async fn summarize_memories(
        &self,
        raw_memories: Vec<ApiRawMemory>,
        model_info: &ModelInfo,
        effort: Option<ReasoningEffortConfig>,
        session_telemetry: &SessionT
```

**Purpose**: Asks the provider to summarize raw memory records. This helps memory-related flows turn normalized raw facts into concise summaries.

**Data flow**: It receives raw memories, model info, optional reasoning effort, and telemetry. If there are no memories it returns an empty list; otherwise it resolves auth/provider setup, builds telemetry and a memory-summary payload, sends it with subagent headers, and returns provider summaries or an error.

**Call relations**: Memory consolidation paths use this unary API call. It shares auth setup and telemetry style with the rest of the client but uses the memories endpoint instead of response streaming.

*Call graph*: calls 6 internal fn (new, new, build_subagent_headers, current_client_setup, for_endpoint, build_reqwest_client); 4 external calls (new, build_request_telemetry, new, default).


##### `ModelClient::build_subagent_headers`  (lines 667–684)

```
fn build_subagent_headers(&self) -> ApiHeaderMap
```

**Purpose**: Builds headers that identify special internal subagent work, especially memory consolidation. These headers let the provider know the request is not a normal user-facing turn.

**Data flow**: It reads the session source, creates a header map, adds a subagent header when one applies, adds a memory-generation marker for memory consolidation sessions, and returns the headers.

**Call relations**: Memory summarization calls this before sending its request. The headers become part of the provider call so backend routing or accounting can treat the request appropriately.

*Call graph*: calls 1 internal fn (subagent_header_value); called by 1 (summarize_memories); 4 external calls (new, from_static, from_str, matches!).


##### `ModelClient::build_responses_compatibility_headers`  (lines 686–701)

```
fn build_responses_compatibility_headers(
        &self,
        responses_metadata: &CodexResponsesMetadata,
    ) -> ApiHeaderMap
```

**Purpose**: Builds compatibility headers for Responses API calls and adds memory-consolidation markers when needed. These headers help older or special backend paths understand Codex requests.

**Data flow**: It starts with compatibility headers from response metadata, checks whether the session is an internal memory-consolidation session, possibly adds a memory-generation header, and returns the combined map.

**Call relations**: HTTP response options, WebSocket handshakes, and compaction requests all call this. It keeps those different transports using the same compatibility markers.

*Call graph*: calls 1 internal fn (compatibility_headers); called by 3 (build_websocket_headers, compact_conversation_history, build_responses_options); 2 external calls (from_static, matches!).


##### `ModelClient::build_ws_client_metadata`  (lines 703–716)

```
fn build_ws_client_metadata(
        &self,
        responses_metadata: &CodexResponsesMetadata,
        use_responses_lite: bool,
    ) -> HashMap<String, String>
```

**Purpose**: Builds metadata that travels inside a WebSocket response-create request. It includes normal Codex metadata and, when needed, a marker saying the request uses Responses Lite.

**Data flow**: It receives response metadata and a boolean for Responses Lite, copies the metadata into a string map, optionally inserts the Responses Lite marker, and returns the map.

**Call relations**: The WebSocket streaming path uses this before creating its WebSocket payload. Later it may also add the turn-state token before sending.

*Call graph*: calls 1 internal fn (client_metadata); called by 1 (stream_responses_websocket).


##### `ModelClient::generate_attestation_header_for`  (lines 718–730)

```
async fn generate_attestation_header_for(&self) -> Option<HeaderValue>
```

**Purpose**: Creates an attestation header when this provider and session require one. Attestation is a signed or verifiable proof about the client context sent with a request.

**Data flow**: It checks whether attestation is enabled, looks up the attestation provider, asks it for a header using the session thread id, and returns the header value if one can be made.

**Call relations**: Request-building paths for compaction, realtime calls, HTTP streaming options, and WebSocket handshakes call this so protected provider requests carry the same proof.

*Call graph*: called by 4 (build_websocket_headers, compact_conversation_history, create_realtime_call_with_headers, build_responses_options).


##### `ModelClient::build_request_telemetry`  (lines 733–747)

```
fn build_request_telemetry(
        session_telemetry: &SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_te
```

**Purpose**: Creates telemetry for non-streaming, one-shot API calls. Telemetry records timing, status, auth details, and endpoint information.

**Data flow**: It receives session telemetry, auth context, route information, and auth-environment information, wraps them in an `ApiTelemetry` object, and returns it as a request telemetry interface.

**Call relations**: Compaction and memory summarization use this before constructing their API clients. The API client then calls the telemetry object as requests finish.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, clone).


##### `ModelClient::build_reasoning`  (lines 749–771)

```
fn build_reasoning(
        model_info: &ModelInfo,
        effort: Option<ReasoningEffortConfig>,
        summary: ReasoningSummaryConfig,
    ) -> Option<Reasoning>
```

**Purpose**: Builds the reasoning settings for a model request when the model supports reasoning summaries. Reasoning settings control effort level, summary reporting, and context scope.

**Data flow**: It receives model info, optional effort, and requested summary behavior. If unsupported it returns nothing; otherwise it fills defaults from the model, omits summary when set to none, sets Responses Lite context when appropriate, and returns a reasoning block.

**Call relations**: The main Responses request builder calls this for every model request. Its output determines whether reasoning-related fields and includes are sent to the provider.


##### `ModelClient::build_responses_request`  (lines 774–831)

```
fn build_responses_request(
        &self,
        provider: &codex_api::Provider,
        prompt: &Prompt,
        model_info: &ModelInfo,
        effort: Option<ReasoningEffortConfig>,
        summa
```

**Purpose**: Turns Codex's internal prompt and model settings into the provider's Responses API request body. This is the central place where instructions, conversation items, tools, reasoning, output schema, cache key, and service tier become one request.

**Data flow**: It receives provider info, prompt, model info, reasoning choices, service tier, and metadata. It formats input, strips metadata for non-OpenAI providers, converts tools, builds reasoning and text controls, chooses cache and tier settings, and returns a complete `ResponsesApiRequest`.

**Call relations**: Streaming over HTTP, streaming over WebSocket, and compaction all use this shared builder. That keeps request bodies consistent even though the transport differs.

*Call graph*: calls 5 internal fn (is_azure_responses_endpoint, prompt_cache_key, get_formatted_input_for_request, client_metadata, service_tier_for_request); called by 3 (compact_conversation_history, stream_responses_api, stream_responses_websocket); 6 external calls (build_reasoning, new, create_text_param_for_request, create_tools_json_for_responses_api, vec!, warn!).


##### `ModelClient::responses_websocket_enabled`  (lines 836–844)

```
fn responses_websocket_enabled(&self) -> bool
```

**Purpose**: Answers whether this session should currently try Responses over WebSocket. It combines provider capability with the session-wide fallback flag.

**Data flow**: It reads provider capabilities and the atomic disable flag. It returns `false` if WebSockets are unsupported or already disabled, otherwise `true`.

**Call relations**: Preconnect, prewarm, normal stream selection, and fallback activation all consult this. Once fallback disables WebSockets, this function steers future turns to HTTP.

*Call graph*: called by 4 (force_http_fallback, preconnect_websocket, prewarm_websocket, stream).


##### `ModelClient::current_client_setup`  (lines 850–859)

```
async fn current_client_setup(&self) -> Result<CurrentClientSetup>
```

**Purpose**: Resolves the current auth and provider objects for one request attempt. Keeping this in one place prevents prewarm, WebSocket, HTTP, compaction, and memory calls from drifting apart.

**Data flow**: It asks the shared model provider for the current Codex auth, API provider configuration, and API auth provider, then returns them bundled together.

**Call relations**: Every network path that needs provider credentials calls this shortly before sending. If auth state changes after recovery, the next loop iteration resolves fresh setup here.

*Call graph*: called by 6 (compact_conversation_history, create_realtime_call_with_headers, summarize_memories, preconnect_websocket, stream_responses_api, stream_responses_websocket).


##### `ModelClient::connect_websocket`  (lines 866–946)

```
async fn connect_websocket(
        &self,
        session_telemetry: &SessionTelemetry,
        api_provider: codex_api::Provider,
        api_auth: SharedAuthProvider,
        responses_metadata: &C
```

**Purpose**: Opens a Responses API WebSocket connection with the same headers, auth, timeout, and telemetry behavior used by normal turns. It is the common handshake path for preconnect and reconnect.

**Data flow**: It receives telemetry, provider/auth objects, response metadata, and auth/route context. It builds headers, creates WebSocket telemetry, attempts the connection with a provider-specific timeout, records success or error details, emits feedback tags, and returns the connection or API error.

**Call relations**: Preconnect and the turn-time WebSocket connection getter both call this. Its result becomes the stored socket used by streaming requests.

*Call graph*: calls 4 internal fn (build_websocket_headers, build_websocket_telemetry, default_headers, record_websocket_connect); called by 2 (preconnect_websocket, websocket_connection); 5 external calls (new, now, Transport, emit_feedback_request_tags_with_auth_env, timeout).


##### `ModelClient::build_websocket_headers`  (lines 949–979)

```
async fn build_websocket_headers(
        &self,
        responses_metadata: &CodexResponsesMetadata,
    ) -> ApiHeaderMap
```

**Purpose**: Builds headers for the WebSocket handshake. These headers carry session identity, compatibility flags, beta WebSocket version, optional timing metrics, and optional attestation.

**Data flow**: It receives response metadata, starts with shared Responses headers, adds request/session/thread identifiers, compatibility headers, attestation if available, the required WebSocket beta header, and timing metrics when enabled, then returns the map.

**Call relations**: Only the WebSocket connect path calls this. The resulting headers are sent during the socket handshake before any prompt payload is streamed.

*Call graph*: calls 3 internal fn (build_responses_compatibility_headers, generate_attestation_header_for, build_responses_headers); called by 1 (connect_websocket); 3 external calls (from_static, from_str, build_session_headers).


##### `ModelClientSession::drop`  (lines 983–987)

```
fn drop(&mut self)
```

**Purpose**: Returns this turn session's WebSocket state to the long-lived client when the turn session goes away. This enables safe connection reuse across turns.

**Data flow**: It takes the session's WebSocket state, leaves an empty one behind, and stores the taken state in the parent client cache.

**Call relations**: Rust calls this automatically when a `ModelClientSession` is dropped. It pairs with `new_session`, which takes the cached state at the start of a turn.

*Call graph*: calls 1 internal fn (store_cached_websocket_session); 1 external calls (take).


##### `ModelClientSession::turn_state`  (lines 991–993)

```
fn turn_state(&self) -> Arc<OnceLock<String>>
```

**Purpose**: Gives callers shared access to this turn's sticky routing token holder. The token is set once when received and then reused for requests in the same turn.

**Data flow**: It clones the shared `OnceLock` pointer that may eventually contain the turn-state string and returns it.

**Call relations**: Auto-compaction and related flows can pass this holder into request methods. The request header builders read the stored value when it exists.

*Call graph*: called by 1 (run_auto_compact); 1 external calls (clone).


##### `ModelClientSession::reset_websocket_session`  (lines 995–1002)

```
fn reset_websocket_session(&mut self)
```

**Purpose**: Clears all stored WebSocket state for the current turn. This is used when a socket is known to be bad or timed out.

**Data flow**: It removes the connection, previous request, pending previous response, warmup marker, and resets the connection-reused flag to false.

**Call relations**: The WebSocket connection getter calls this after certain connection failures. After reset, later WebSocket use must open a fresh connection and send full request state.

*Call graph*: calls 1 internal fn (set_connection_reused); called by 1 (websocket_connection).


##### `ModelClientSession::build_responses_options`  (lines 1009–1037)

```
async fn build_responses_options(
        &self,
        responses_metadata: &CodexResponsesMetadata,
        compression: Compression,
        use_responses_lite: bool,
    ) -> ApiResponsesOptions
```

**Purpose**: Builds the transport options for an HTTP Responses API stream. These options include session ids, headers, compression choice, and the turn-state holder.

**Data flow**: It receives metadata, compression mode, and Responses Lite choice. It builds common headers, compatibility headers, optional attestation, optional Responses Lite header, and returns an `ApiResponsesOptions` value.

**Call relations**: The HTTP streaming path calls this just before sending a request. It keeps request-scoped headers consistent with compaction and WebSocket setup where appropriate.

*Call graph*: calls 4 internal fn (build_responses_compatibility_headers, generate_attestation_header_for, add_responses_lite_header, build_responses_headers); called by 1 (stream_responses_api); 1 external calls (clone).


##### `ModelClientSession::get_incremental_items`  (lines 1039–1079)

```
fn get_incremental_items(
        &self,
        request: &ResponsesApiRequest,
        last_response: Option<&LastResponse>,
        allow_empty_delta: bool,
    ) -> Option<Vec<ResponseItem>>
```

**Purpose**: Finds the new input items that can be sent over WebSocket instead of resending the whole conversation. This is an optimization that only runs when the current request safely extends the previous one.

**Data flow**: It receives the current request, an optional previous response, and whether an empty delta is allowed. It checks non-input request properties, compares current input against previous input plus server-added output items, strips provider metadata when needed, and returns only the new items or `None`.

**Call relations**: WebSocket request preparation uses this after reading the last response. If it cannot prove the request is a clean extension, the caller sends a full response-create payload instead.

*Call graph*: calls 1 internal fn (responses_request_properties_match); called by 1 (prepare_websocket_request); 1 external calls (trace!).


##### `ModelClientSession::get_last_response`  (lines 1081–1089)

```
fn get_last_response(&mut self) -> Option<LastResponse>
```

**Purpose**: Retrieves the completed previous WebSocket response if it is already available. This gives the session the response id and output items needed for incremental follow-up requests.

**Data flow**: It takes the stored one-shot receiver, tries to read from it without waiting, and returns the `LastResponse` if one has arrived; otherwise it returns nothing.

**Call relations**: WebSocket request preparation calls this before deciding whether it can use `previous_response_id`. The receiver is produced by the stream-mapping code when a response completes.

*Call graph*: called by 1 (prepare_websocket_request).


##### `ModelClientSession::prepare_websocket_request`  (lines 1091–1122)

```
fn prepare_websocket_request(
        &mut self,
        payload: ResponseCreateWsRequest,
        request: &ResponsesApiRequest,
    ) -> (ResponsesWsRequest, bool)
```

**Purpose**: Chooses whether a WebSocket request should be full or incremental. Incremental requests can reference the previous response id and send only new input items.

**Data flow**: It receives a WebSocket payload and the full logical request. It tries to read the last response, checks whether the current request is an incremental extension, and returns either the original full request or a modified request with `previous_response_id` and reduced input, plus a flag about warmup tracing.

**Call relations**: The WebSocket streaming path calls this after building the payload and before sending. The returned request is what gets stamped with timing metadata and sent over the socket.

*Call graph*: calls 2 internal fn (get_incremental_items, get_last_response); called by 1 (stream_responses_websocket); 2 external calls (ResponseCreate, trace!).


##### `ModelClientSession::preconnect_websocket`  (lines 1127–1164)

```
async fn preconnect_websocket(
        &mut self,
        session_telemetry: &SessionTelemetry,
        responses_metadata: &CodexResponsesMetadata,
    ) -> std::result::Result<(), ApiError>
```

**Purpose**: Opens a WebSocket early for the current turn without sending prompt content. This can reduce delay when the real model request starts.

**Data flow**: It checks whether WebSockets are enabled and no connection already exists. If so, it resolves auth/provider setup, builds auth telemetry context, opens the socket, stores it, marks it as not reused yet, and returns success or an API error.

**Call relations**: Startup or turn-preparation code can call this as an opportunistic warmup. Later streaming reuses the stored connection if it is still open.

*Call graph*: calls 6 internal fn (new, connect_websocket, current_client_setup, responses_websocket_enabled, for_endpoint, set_connection_reused); 1 external calls (default).


##### `ModelClientSession::websocket_connection`  (lines 1178–1233)

```
async fn websocket_connection(
        &mut self,
        params: WebsocketConnectParams<'_>,
    ) -> std::result::Result<&ApiWebSocketConnection, ApiError>
```

**Purpose**: Returns an open WebSocket connection for the current turn, creating a new one if needed. It also marks whether the connection is reused.

**Data flow**: It receives connection parameters, checks whether the stored socket is missing or closed, clears previous incremental state when opening a new socket, calls the shared connect function, handles timeout reset behavior, stores the new connection, and returns a reference to it.

**Call relations**: The WebSocket streaming path calls this before sending a request. If it returns specific provider errors, the caller may fall back to HTTP or retry after auth recovery.

*Call graph*: calls 3 internal fn (connect_websocket, reset_websocket_session, set_connection_reused); called by 1 (stream_responses_websocket); 2 external calls (Stream, matches!).


##### `ModelClientSession::responses_request_compression`  (lines 1235–1244)

```
fn responses_request_compression(&self, auth: Option<&CodexAuth>) -> Compression
```

**Purpose**: Chooses whether to compress an HTTP Responses request body. Compression is only used when enabled, when authenticated through the Codex backend, and when the provider is OpenAI.

**Data flow**: It receives optional auth, reads session settings and provider info, and returns either Zstd compression or no compression.

**Call relations**: The HTTP streaming path calls this before building request options. The selected compression mode is passed into the Responses API client.

*Call graph*: called by 1 (stream_responses_api).


##### `ModelClientSession::stream_responses_api`  (lines 1263–1364)

```
async fn stream_responses_api(
        &self,
        prompt: &Prompt,
        model_info: &ModelInfo,
        session_telemetry: &SessionTelemetry,
        effort: Option<ReasoningEffortConfig>,
```

**Purpose**: Streams a model response through the HTTP Responses API. It is the reliable fallback path when WebSockets are unavailable or disabled.

**Data flow**: It receives prompt, model settings, telemetry, metadata, and trace context. It loops through request attempts, resolves auth/provider setup, builds telemetry, compression, options, and request body, sends the HTTP stream, maps successful API events into Codex events, and on unauthorized errors tries auth recovery once before retrying.

**Call relations**: The public `stream` method calls this when it chooses HTTP. It hands successful streams to the common stream mapper so callers see the same `ResponseStream` shape as WebSocket calls.

*Call graph*: calls 12 internal fn (new, new, build_responses_request, current_client_setup, build_responses_options, responses_request_compression, from_recovery, for_endpoint, handle_unauthorized, map_response_stream (+2 more)); called by 1 (stream); 7 external calls (new, build_streaming_telemetry, map_api_error, extract_response_debug_context, extract_response_debug_context_from_api_error, default, clone).


##### `ModelClientSession::stream_responses_websocket`  (lines 1381–1520)

```
async fn stream_responses_websocket(
        &mut self,
        prompt: &Prompt,
        model_info: &ModelInfo,
        session_telemetry: &SessionTelemetry,
        effort: Option<ReasoningEffortCon
```

**Purpose**: Streams a model response over the Responses WebSocket transport. It handles warmup requests, connection reuse, incremental request payloads, auth recovery, and fallback signals.

**Data flow**: It receives prompt, model settings, telemetry, metadata, a warmup flag, trace context, and inference trace context. It resolves auth/provider setup, builds the logical request and WebSocket payload, gets a socket, prepares full or incremental sending, records tracing, sends the request, maps the resulting stream, and returns either a stream or a signal to fall back to HTTP.

**Call relations**: Both prewarm and normal streaming call this. Normal streaming consumes the returned stream; prewarm consumes it only until the warmup completion event.

*Call graph*: calls 15 internal fn (from, new, build_responses_request, build_ws_client_metadata, current_client_setup, prepare_websocket_request, websocket_connection, from_recovery, for_endpoint, connection_reused (+5 more)); called by 2 (prewarm_websocket, stream); 6 external calls (clone, map_api_error, response_create_client_metadata, default, Stream, clone).


##### `ModelClientSession::build_streaming_telemetry`  (lines 1523–1538)

```
fn build_streaming_telemetry(
        session_telemetry: &SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_
```

**Purpose**: Creates telemetry objects for HTTP streaming: one for the request itself and one for server-sent event polling. Server-sent events are the HTTP streaming chunks sent by the provider.

**Data flow**: It receives session telemetry, auth context, route information, and auth-environment information, creates one shared `ApiTelemetry`, and returns it through both request and SSE telemetry interfaces.

**Call relations**: The HTTP streaming path calls this before constructing the API client. The client then reports request attempts and stream polling activity through these interfaces.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, clone).


##### `ModelClientSession::build_websocket_telemetry`  (lines 1541–1555)

```
fn build_websocket_telemetry(
        session_telemetry: &SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_
```

**Purpose**: Creates telemetry for WebSocket requests and events. This lets the session record socket request timing, reuse, errors, and incoming event timing.

**Data flow**: It receives session telemetry, auth context, route information, and auth-environment information, wraps them in `ApiTelemetry`, and returns it as a WebSocket telemetry interface.

**Call relations**: The shared WebSocket connection function calls this during handshake setup. The underlying WebSocket client uses it while sending requests and reading events.

*Call graph*: calls 1 internal fn (new); called by 1 (connect_websocket); 2 external calls (new, clone).


##### `ModelClientSession::prewarm_websocket`  (lines 1558–1608)

```
async fn prewarm_websocket(
        &mut self,
        prompt: &Prompt,
        model_info: &ModelInfo,
        session_telemetry: &SessionTelemetry,
        effort: Option<ReasoningEffortConfig>,
```

**Purpose**: Performs a WebSocket warmup request for the turn using `generate=false`, meaning it prepares the connection and response chain without asking the model to generate user-visible output. This can make the following real request faster and eligible for incremental reuse.

**Data flow**: It checks whether WebSockets are enabled and no prior request exists. It calls the WebSocket stream path in warmup mode with tracing disabled, waits until a completion event arrives, switches to HTTP fallback if instructed, and returns success or error.

**Call relations**: Turn execution can call this before the first real stream. Its completed warmup response may be reused by the next WebSocket request, but it is intentionally omitted from inference traces.

*Call graph*: calls 4 internal fn (responses_websocket_enabled, stream_responses_websocket, try_switch_fallback_transport, disabled); 1 external calls (current_span_w3c_trace_context).


##### `ModelClientSession::stream`  (lines 1619–1670)

```
async fn stream(
        &mut self,
        prompt: &Prompt,
        model_info: &ModelInfo,
        session_telemetry: &SessionTelemetry,
        effort: Option<ReasoningEffortConfig>,
        summar
```

**Purpose**: Streams one model request for the current turn using the best available transport. It prefers WebSocket when enabled and falls back to HTTP when necessary.

**Data flow**: It receives prompt, model settings, telemetry, metadata, and trace context. It checks the provider wire API, tries WebSocket first when allowed, switches fallback on provider upgrade-required signals, and otherwise sends the request through HTTP, returning a `ResponseStream`.

**Call relations**: Higher-level Codex execution code calls this for actual model turns, sampling requests, and remote compaction work. It hides transport selection so callers only consume a unified stream.

*Call graph*: calls 4 internal fn (responses_websocket_enabled, stream_responses_api, stream_responses_websocket, try_switch_fallback_transport); called by 5 (drain_to_completed, run_remote_compaction_request_v2, try_run_sampling_request, stream_until_complete_with_metadata, stream_until_complete_with_model_info); 1 external calls (current_span_w3c_trace_context).


##### `ModelClientSession::try_switch_fallback_transport`  (lines 1678–1688)

```
fn try_switch_fallback_transport(
        &mut self,
        session_telemetry: &SessionTelemetry,
        model_info: &ModelInfo,
    ) -> bool
```

**Purpose**: Disables WebSockets for the whole Codex session and clears this turn's WebSocket state. It returns whether this call was the one that actually activated fallback.

**Data flow**: It receives telemetry and model info, asks the parent client to force HTTP fallback, replaces the local WebSocket session with a default empty one, and returns the activation flag.

**Call relations**: Prewarm, normal stream selection, and retry/error handling call this when WebSocket should no longer be used. Future turns then skip WebSocket because the parent client records the disabled state.

*Call graph*: calls 1 internal fn (force_http_fallback); called by 3 (prewarm_websocket, stream, handle_retryable_response_stream_error); 1 external calls (default).


##### `stamp_ws_stream_request_start_ms`  (lines 1695–1704)

```
fn stamp_ws_stream_request_start_ms(request: &mut ResponsesWsRequest)
```

**Purpose**: Adds the current client-side send time to a WebSocket request's metadata. This helps measure realistic transport timing from just before the request leaves the client.

**Data flow**: It receives a mutable WebSocket request, ensures the request has a metadata map, inserts the current Unix timestamp in milliseconds under a Codex-specific key, and changes the request in place.

**Call relations**: The WebSocket streaming path calls this immediately before recording and sending the request. The provider or telemetry systems can later use the timestamp for timing analysis.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (stream_responses_websocket).


##### `build_responses_headers`  (lines 1712–1730)

```
fn build_responses_headers(
    beta_features_header: Option<&str>,
    turn_state: Option<&Arc<OnceLock<String>>>,
) -> ApiHeaderMap
```

**Purpose**: Builds common Codex headers for Responses API calls. These include optional beta feature flags and the per-turn sticky routing token.

**Data flow**: It receives an optional beta feature string and optional turn-state holder. It creates a header map, adds the beta header when non-empty and valid, adds `x-codex-turn-state` when a token exists and is valid, and returns the headers.

**Call relations**: HTTP options, WebSocket handshake setup, and compaction request setup all call this. It keeps the same header rules across transports.

*Call graph*: called by 3 (build_websocket_headers, compact_conversation_history, build_responses_options); 2 external calls (new, from_str).


##### `add_responses_lite_header`  (lines 1732–1739)

```
fn add_responses_lite_header(headers: &mut ApiHeaderMap, use_responses_lite: bool)
```

**Purpose**: Adds the internal Responses Lite header when a model request should use Responses Lite. Responses Lite is a lighter provider mode controlled by model information.

**Data flow**: It receives a mutable header map and a boolean. If the boolean is true, it inserts the static Responses Lite header; otherwise it leaves the map unchanged.

**Call relations**: Compaction and HTTP streaming options call this while preparing headers. WebSocket requests carry the same idea through client metadata instead.

*Call graph*: called by 2 (compact_conversation_history, build_responses_options); 2 external calls (insert, from_static).


##### `map_response_stream`  (lines 1744–1763)

```
fn map_response_stream(
    api_stream: codex_api::ResponseStream,
    session_telemetry: SessionTelemetry,
    inference_trace_attempt: InferenceTraceAttempt,
) -> (ResponseStream, oneshot::Receiver<
```

**Purpose**: Converts the API crate's response stream wrapper into Codex's internal response stream wrapper. It also preserves the upstream request id for tracing and feedback tags.

**Data flow**: It receives an API stream, session telemetry, and an inference trace attempt. It separates out the upstream request id, rebuilds the stream without that id, delegates event conversion, and returns the Codex stream plus a receiver for the final response summary.

**Call relations**: Both HTTP and WebSocket streaming paths call this after the provider accepts a request. The returned stream is what higher-level Codex code consumes.

*Call graph*: calls 1 internal fn (map_response_events); called by 2 (stream_responses_api, stream_responses_websocket).


##### `map_response_events`  (lines 1765–1910)

```
fn map_response_events(
    upstream_request_id: Option<String>,
    api_stream: S,
    session_telemetry: SessionTelemetry,
    inference_trace_attempt: InferenceTraceAttempt,
) -> (ResponseStream, o
```

**Purpose**: Pumps provider response events into Codex's internal stream while recording telemetry, trace results, and the last completed response. This is the event translator and bookkeeper for streaming.

**Data flow**: It receives an upstream request id, an event stream, session telemetry, and an inference trace attempt. It spawns a task that reads events, forwards them through a channel, tracks output items, records completion, failure, cancellation, and token usage, and sends the final response id/items through a one-shot channel.

**Call relations**: The stream wrapper calls this for all transports. WebSocket incremental sending later reads the last-response channel to decide whether it can send only new input.

*Call graph*: calls 5 internal fn (see_event_completed_failed, sse_event_completed, record_cancelled, record_completed, record_failed); called by 1 (map_response_stream); 9 external calls (new, new, OutputItemDone, map_api_error, extract_response_debug_context_from_api_error, feedback_tags!, take, select!, spawn).


##### `PendingUnauthorizedRetry::from_recovery`  (lines 1930–1936)

```
fn from_recovery(recovery: UnauthorizedRecoveryExecution) -> Self
```

**Purpose**: Creates retry telemetry state after an auth recovery step succeeds. It marks the next request as a retry caused by an unauthorized response.

**Data flow**: It receives the recovery execution details, sets `retry_after_unauthorized` to true, stores the recovery mode and phase, and returns the pending retry record.

**Call relations**: HTTP and WebSocket streaming loops use this after `handle_unauthorized` succeeds. The next attempt's telemetry then explains why it is being retried.

*Call graph*: called by 3 (stream_responses_api, stream_responses_websocket, auth_request_telemetry_context_tracks_attached_auth_and_retry_phase).


##### `AuthRequestTelemetryContext::new`  (lines 1950–1970)

```
fn new(
        auth_mode: Option<AuthMode>,
        api_auth: &dyn AuthProvider,
        retry: PendingUnauthorizedRetry,
    ) -> Self
```

**Purpose**: Builds the auth-related telemetry snapshot for one request attempt. It records what kind of auth is being used, whether an auth header was attached, and whether this is a retry after recovery.

**Data flow**: It receives optional Codex auth mode, an API auth provider, and pending retry info. It inspects the auth headers, maps auth modes into telemetry-friendly labels, combines retry details, and returns the context.

**Call relations**: All major request paths create this before building telemetry or opening WebSockets. Later telemetry callbacks read it when recording requests and feedback tags.

*Call graph*: called by 6 (compact_conversation_history, summarize_memories, preconnect_websocket, stream_responses_api, stream_responses_websocket, auth_request_telemetry_context_tracks_attached_auth_and_retry_phase); 1 external calls (auth_header_telemetry).


##### `handle_unauthorized`  (lines 1982–2096)

```
async fn handle_unauthorized(
    transport: TransportError,
    auth_recovery: &mut Option<UnauthorizedRecovery>,
    session_telemetry: &SessionTelemetry,
) -> Result<UnauthorizedRecoveryExecution>
```

**Purpose**: Handles a 401 Unauthorized response by running the available auth recovery step, usually refreshing ChatGPT tokens, and telling the caller whether to retry. If recovery cannot run or fails, it returns a user-facing Codex error.

**Data flow**: It receives the transport error, mutable recovery state, and session telemetry. It extracts debug details, runs the next recovery step if available, records success or permanent/transient failure, emits feedback tags, and returns recovery execution details or a mapped error.

**Call relations**: HTTP and WebSocket streaming loops call this when an API attempt returns unauthorized. On success, those loops rebuild auth/provider setup and retry the original request.

*Call graph*: calls 2 internal fn (emit_feedback_auth_recovery_tags, record_auth_recovery); called by 2 (stream_responses_api, stream_responses_websocket); 5 external calls (Transport, map_api_error, extract_response_debug_context, Io, RefreshTokenFailed).


##### `api_error_http_status`  (lines 2098–2103)

```
fn api_error_http_status(error: &ApiError) -> Option<u16>
```

**Purpose**: Extracts an HTTP status code from an API error when the error came from an HTTP response. It returns nothing for non-HTTP errors such as timeouts or stream errors.

**Data flow**: It receives an API error, checks whether it wraps an HTTP transport error, and returns the numeric status code if present.

**Call relations**: WebSocket connection and telemetry code use this to attach status codes to records and feedback tags. It is a small helper for error reporting.


##### `ApiTelemetry::new`  (lines 2113–2125)

```
fn new(
        session_telemetry: SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_telemetry: AuthEnvTelem
```

**Purpose**: Creates the shared telemetry object used by request, SSE, and WebSocket reporting. It bundles session telemetry with auth context, route labels, and auth-environment details.

**Data flow**: It receives the four telemetry ingredients, stores them in an `ApiTelemetry` struct, and returns it.

**Call relations**: Telemetry builder functions create this and then expose it through the interface needed by each transport. The API clients call its trait methods as network activity happens.

*Call graph*: called by 3 (build_request_telemetry, build_streaming_telemetry, build_websocket_telemetry).


##### `ApiTelemetry::on_request`  (lines 2129–2183)

```
fn on_request(
        &self,
        attempt: u64,
        status: Option<HttpStatusCode>,
        error: Option<&TransportError>,
        duration: Duration,
    )
```

**Purpose**: Records the result of an HTTP API request attempt. It captures status, error text, duration, auth header details, endpoint, and server debug identifiers.

**Data flow**: It receives attempt number, optional status, optional transport error, and duration. It extracts a plain error message and debug context, records the API request in session telemetry, and emits feedback request tags with auth-environment information.

**Call relations**: The HTTP API client invokes this through the request telemetry interface. It is used for both streaming and unary HTTP calls that opted into this telemetry.

*Call graph*: calls 1 internal fn (record_api_request); 1 external calls (emit_feedback_request_tags_with_auth_env).


##### `ApiTelemetry::on_sse_poll`  (lines 2187–2196)

```
fn on_sse_poll(
        &self,
        result: &std::result::Result<
            Option<std::result::Result<Event, EventStreamError<TransportError>>>,
            tokio::time::error::Elapsed,
```

**Purpose**: Records timing and result information for polling the next server-sent event from an HTTP stream. This helps diagnose slow or failing streaming reads.

**Data flow**: It receives the poll result and how long the poll took, then passes both to session telemetry for logging.

**Call relations**: The HTTP streaming API client invokes this while reading streamed events. It complements request-level telemetry by measuring the stream after the request has started.

*Call graph*: calls 1 internal fn (log_sse_event).


##### `ApiTelemetry::on_ws_request`  (lines 2200–2237)

```
fn on_ws_request(&self, duration: Duration, error: Option<&ApiError>, connection_reused: bool)
```

**Purpose**: Records the result of sending a request over WebSocket. It includes duration, error details, whether the connection was reused, and auth recovery follow-up information.

**Data flow**: It receives request duration, optional API error, and the connection-reused flag. It extracts error message, status, and debug context, records WebSocket request telemetry, and emits feedback tags.

**Call relations**: The WebSocket client invokes this for WebSocket request sends. It gives the same auth and endpoint visibility that HTTP request telemetry provides.

*Call graph*: calls 1 internal fn (record_websocket_request); 1 external calls (emit_feedback_request_tags_with_auth_env).


##### `ApiTelemetry::on_ws_event`  (lines 2239–2246)

```
fn on_ws_event(
        &self,
        result: &std::result::Result<Option<std::result::Result<Message, Error>>, ApiError>,
        duration: Duration,
    )
```

**Purpose**: Records timing and result information for receiving WebSocket events. This helps track how long socket reads take and whether they fail.

**Data flow**: It receives the WebSocket event result and duration, then forwards them to session telemetry.

**Call relations**: The WebSocket client invokes this while reading messages from the provider. It pairs with `on_ws_request` to describe both sending and receiving on the socket.

*Call graph*: calls 1 internal fn (record_websocket_event).


### `core/src/responses_retry.rs`

`domain_logic` · `request handling`

Some model requests arrive as a stream, meaning the program receives pieces of the answer over time rather than one single finished reply. Streams can fail for ordinary reasons, such as a temporary network drop or a WebSocket connection closing. This file is the safety routine for those moments.

Its main job is to answer: should we try again, should we switch to a different transport, or should we give up? A transport is the route used to talk to the model service. Here, the system may fall back from WebSockets, which keep an open two-way connection, to HTTPS, the more traditional request-and-response web method.

The key function receives the current error, how many retries have already happened, the allowed maximum, and context about the current user turn. If retries are still available, it increases the retry count, chooses a waiting time using either the error's requested delay or an exponential-style backoff helper, logs what is happening, optionally tells the user interface that it is reconnecting, waits, and then tells the caller it is safe to retry. If retries are exhausted, it may first try switching transport and reset the retry count. If neither retrying nor fallback is allowed, it returns the original error.

This matters because without it, a brief connection hiccup could end a request immediately, or users might see a frozen screen with no explanation.

#### Function details

##### `handle_retryable_response_stream_error`  (lines 22–79)

```
async fn handle_retryable_response_stream_error(
    retries: &mut u64,
    max_retries: u64,
    err: CodexErr,
    client_session: &mut ModelClientSession,
    sess: &Session,
    turn_context: &Tur
```

**Purpose**: This function is the decision point after a streamed model request fails in a way that might be temporary. It decides whether to retry, switch from WebSockets to HTTPS, notify the user interface, wait for a safe delay, or finally return the error.

**Data flow**: It receives a retry counter that it can change, a maximum retry limit, the error that occurred, the model client session, the wider session, the current turn context, and the kind of request that failed. If the retry limit has been reached, it first checks whether the model client can switch to a fallback transport; if so, it sends a warning event, resets the retry counter, and returns success so the caller can try again. If retries remain, it increments the counter, chooses a delay from the error or from the shared backoff helper, records a warning log, may notify the front end with a reconnecting message, waits for that delay, and returns success. If no retry or fallback is possible, it returns the original error unchanged.

**Call relations**: The streaming request loops for sampling and remote compaction call this function when their stream fails. This function uses the client session to attempt a transport fallback, uses the session to send warning or reconnect messages outward, calls `log_retry` to write a developer-facing warning, and uses the shared `backoff` helper to avoid retrying too aggressively. Its return value tells the caller whether to continue the request loop or stop with an error.

*Call graph*: calls 3 internal fn (try_switch_fallback_transport, log_retry, backoff); called by 2 (run_remote_compaction_request_v2, run_sampling_request); 6 external calls (cfg!, notify_stream_error, send_event, format!, Warning, sleep).


##### `log_retry`  (lines 81–105)

```
fn log_retry(
    request: ResponsesStreamRequest,
    turn_context: &TurnContext,
    err: &CodexErr,
    retries: u64,
    max_retries: u64,
    delay: Duration,
)
```

**Purpose**: This function writes a warning log entry whenever the system is about to retry a failed stream. It keeps the log message appropriate for the kind of request that failed.

**Data flow**: It receives the request kind, the current turn context, the error, the retry number, the retry limit, and the delay before the next attempt. For a normal sampling request, it logs a short message saying the stream disconnected and will be retried. For remote compaction, it logs more structured details, including the turn id and error, so that debugging can connect the retry to the right background operation. It does not return data or change state; its output is the log entry.

**Call relations**: `handle_retryable_response_stream_error` calls this after it has decided that another retry will happen and has chosen the delay. The function hands information to the tracing/logging system through the `warn!` macro so operators and developers can later understand why the request paused and retried.

*Call graph*: called by 1 (handle_retryable_response_stream_error); 1 external calls (warn!).


### `core/src/session_startup_prewarm.rs`

`orchestration` · `startup and first regular turn`

When a session starts, the first message can feel slow because the system must build the prompt, prepare tools, collect metadata, and open a websocket connection to the model service. This file creates a “prewarm” path: it does much of that work early, before the user’s first normal turn needs it. Think of it like turning on an oven before you start cooking, so it is hot when you need it.

The main object is `SessionStartupPrewarmHandle`, which owns the background task doing the prewarm. It remembers when the task started and how long it is allowed to run. Later, when the first regular turn begins, the session can try to consume this prepared model client session. If the prewarm is ready, the turn can use it. If it failed, timed out, was cancelled, or was never scheduled, the system reports that cleanly and the regular path can continue without it.

The file also records telemetry, meaning timing and status measurements used to understand startup performance. It records how long each phase took, whether the prewarm was ready or failed, and how old the prewarm was when the first turn tried to use it. This matters because startup speed is user-visible, and failures here should not break the session; they should simply fall back to the normal connection path.

#### Function details

##### `SessionStartupPrewarmHandle::new`  (lines 40–50)

```
fn new(
        task: JoinHandle<CodexResult<ModelClientSession>>,
        started_at: Instant,
        timeout: Duration,
    ) -> Self
```

**Purpose**: Creates a small owner object for a background prewarm task. It wraps the task so that dropping the handle will abort the task, which prevents stray startup work from continuing after it is no longer useful.

**Data flow**: It receives a running task, the time that task started, and the allowed timeout. It wraps the task in an abort-on-drop guard, stores the timing information, and returns a `SessionStartupPrewarmHandle` that can later be waited on, cancelled, or consumed.

**Call relations**: This is used when `Session::schedule_startup_prewarm` has just spawned the background prewarm job and needs to store it on the session. Tests also construct it directly to check behavior around interrupted or non-blocking regular turns.

*Call graph*: called by 3 (interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm, schedule_startup_prewarm); 1 external calls (new).


##### `SessionStartupPrewarmHandle::abort`  (lines 52–55)

```
async fn abort(self)
```

**Purpose**: Stops the background prewarm task on purpose. This is used when the prewarm work should not continue, for example because the session no longer needs it.

**Data flow**: It takes ownership of the handle, sends an abort signal to the task, then waits for the task to finish shutting down. It does not return a useful value; its result is that the background work is no longer running.

**Call relations**: This is a direct cleanup path for a prewarm handle. It calls the task’s abort operation and then awaits the task so cancellation is actually observed instead of leaving unfinished async work behind.

*Call graph*: 1 external calls (abort).


##### `SessionStartupPrewarmHandle::resolve`  (lines 58–154)

```
async fn resolve(
        self,
        session_telemetry: &SessionTelemetry,
        cancellation_token: &CancellationToken,
    ) -> SessionStartupPrewarmResolution
```

**Purpose**: Decides what happened to the prewarm when the first regular turn wants to use it. It returns either a ready model client session, a clean cancellation, or an explanation that the prewarm is unavailable.

**Data flow**: It receives the stored background task, session telemetry, and a cancellation token, which is a shared signal that says “stop waiting.” It checks whether the task is already done; otherwise it waits only for the remaining timeout or until cancellation. It turns the outcome into a clear resolution and records timing measurements such as how long the prewarm had been running and whether it was consumed, failed, timed out, or cancelled.

**Call relations**: This is the bridge between startup work and the first normal turn. `Session::consume_startup_prewarm_for_regular_turn` calls it when a regular turn tries to take the prewarmed session. If the task completes, it hands the raw task result to `SessionStartupPrewarmHandle::resolution_from_join_result`; if it times out or is cancelled, it aborts the task and records the appropriate telemetry.

*Call graph*: calls 2 internal fn (record_duration, record_startup_phase); 5 external calls (now, resolution_from_join_result, Ready, info!, select!).


##### `SessionStartupPrewarmHandle::resolution_from_join_result`  (lines 156–179)

```
fn resolution_from_join_result(
        result: std::result::Result<CodexResult<ModelClientSession>, tokio::task::JoinError>,
        started_at: Instant,
    ) -> SessionStartupPrewarmResolution
```

**Purpose**: Converts the low-level result of the background task into a simple prewarm outcome. It hides the difference between a model setup error and the async task itself failing to join.

**Data flow**: It receives the completed task result and the original start time. If the task produced a ready `ModelClientSession`, it boxes that session and returns `Ready`. If the prewarm code returned an error, it logs a warning and returns `Unavailable` with a failed status. If the task itself failed or was aborted unexpectedly, it logs that and returns `Unavailable` with a join-failed status and elapsed duration.

**Call relations**: This is called by `SessionStartupPrewarmHandle::resolve` after the background task finishes. It keeps `resolve` focused on waiting, timeout, and telemetry, while this helper focuses on translating task completion into a human-readable status.

*Call graph*: 4 external calls (new, elapsed, Ready, warn!).


##### `Session::schedule_startup_prewarm`  (lines 183–214)

```
async fn schedule_startup_prewarm(self: &Arc<Self>, base_instructions: String)
```

**Purpose**: Starts the startup prewarm in the background if websocket prewarming is enabled. This lets the session prepare a model connection before the first user turn needs it.

**Data flow**: It reads the session’s model-client settings and returns immediately if websocket use is disabled. Otherwise it captures telemetry, the websocket connection timeout, the current time, the session itself, and the base instructions. It spawns an async task that runs the real prewarm work, records whether that work ended ready or failed, wraps the task in a `SessionStartupPrewarmHandle`, and stores that handle on the session.

**Call relations**: This is the entry point for prewarming from the session startup flow. It creates the background task that calls `schedule_startup_prewarm_inner`, then uses `SessionStartupPrewarmHandle::new` so the task can later be consumed or aborted safely.

*Call graph*: calls 2 internal fn (new, schedule_startup_prewarm_inner); 3 external calls (clone, now, spawn).


##### `Session::consume_startup_prewarm_for_regular_turn`  (lines 216–229)

```
async fn consume_startup_prewarm_for_regular_turn(
        &self,
        cancellation_token: &CancellationToken,
    ) -> SessionStartupPrewarmResolution
```

**Purpose**: Lets the first regular turn try to use the prewarmed model client session. If no prewarm exists, it reports that fact without treating it as an error.

**Data flow**: It receives a cancellation token from the regular turn. It tries to take the stored prewarm handle from the session. If there is none, it returns an unavailable result with `not_scheduled`. If there is one, it asks the handle to resolve itself using the session telemetry and the cancellation token, then returns that resolution to the caller.

**Call relations**: This function is called when a normal turn reaches the point where a prewarmed connection could help. It hands control to `SessionStartupPrewarmHandle::resolve`, which either supplies the ready model client session or explains why the normal turn must proceed without it.


##### `schedule_startup_prewarm_inner`  (lines 232–300)

```
async fn schedule_startup_prewarm_inner(
    session: Arc<Session>,
    base_instructions: String,
) -> CodexResult<ModelClientSession>
```

**Purpose**: Performs the actual prewarm work: it builds the same kind of context, tools, prompt, metadata, and model client session that the first turn will need, then warms the websocket connection.

**Data flow**: It receives the session and the base instructions text. It creates a startup-only turn context, builds the tool router, builds a prompt with no user messages yet, gathers window and response metadata, creates a new model client session, and calls `prewarm_websocket` with the prompt, model settings, reasoning settings, service tier, telemetry, and metadata. If all of that succeeds, it returns the warmed `ModelClientSession`; if any step fails, it returns an error.

**Call relations**: `Session::schedule_startup_prewarm` runs this inside a spawned background task. This function delegates prompt construction to `build_prompt`, tool setup to `built_tools`, and websocket warming to the model client session, while recording timing for each startup-prewarm phase so the system can see where startup time was spent.

*Call graph*: calls 2 internal fn (build_prompt, built_tools); called by 1 (schedule_startup_prewarm); 3 external calls (new, now, new).


### `core/src/compact_remote_v2.rs`

`orchestration` · `during manual or automatic context compaction`

A model can only read a limited amount of conversation at once; that limit is called the context window. This file is the “moving company” for old context: it decides what must be kept, asks the remote model service to create a compacted record, and replaces the bulky history with a smaller version. It supports both automatic compaction, which happens inside a normal turn when space is needed, and manual compaction, which starts its own turn.

The flow starts by recording analytics and running pre-compaction hooks, which are project-defined checks that may allow or stop the work. It then prepares the current history: it trims oversized tool-call output, builds a prompt with visible tools and instructions, and sends a special compaction request to the Responses API. The response stream must contain exactly one compaction item; extra ordinary output items are ignored, but missing or duplicate compaction items are treated as errors.

After the compacted output returns, the file builds the replacement history. It keeps only selected user/developer/system messages, applies a retained-message token budget, counts retained images, appends the new compaction item, and installs the result into the session. It also records trace data, token usage, and hook outcomes so operators can understand whether compaction helped or failed.

#### Function details

##### `run_inline_remote_auto_compact_task`  (lines 56–74)

```
async fn run_inline_remote_auto_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    initial_context_injection: InitialContextInje
```

**Purpose**: Starts an automatic remote compaction while another turn is already in progress. It is used when the system notices the conversation is getting too large and needs to shrink history without creating a separate user-visible compaction turn.

**Data flow**: It receives the session, current turn context, an existing model-client session, instructions about whether to inject current context, and analytics labels explaining why compaction is happening. It passes all of that into the shared compaction runner with the trigger marked as automatic, then returns success or the error from that shared runner.

**Call relations**: The automatic compaction path calls this when it needs inline cleanup. This function does not do the compaction itself; it hands the work to run_remote_compact_task_inner so automatic and manual compaction share the same checks, request logic, analytics, and error handling.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run_auto_compact).


##### `run_remote_compact_task`  (lines 76–99)

```
async fn run_remote_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()>
```

**Purpose**: Starts a user-requested remote compaction as its own turn. It announces that a new turn has started, then runs the same core compaction process used by automatic compaction.

**Data flow**: It takes the session and turn context, builds a turn-started event with timing, trace, model-window, and collaboration-mode details, and sends that event to listeners. It then asks the shared compaction runner to compact without injecting extra initial context, marking the reason as user requested.

**Call relations**: The top-level run flow calls this for a standalone compact command. After sending the user-visible start event, it delegates to run_remote_compact_task_inner, which performs hooks, analytics, remote request, and history replacement.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run); 1 external calls (TurnStarted).


##### `run_remote_compact_task_inner`  (lines 101–177)

```
async fn run_remote_compact_task_inner(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: Option<&mut ModelClientSession>,
    initial_context_injection: InitialContext
```

**Purpose**: Wraps the real compaction work with safety checks, hooks, analytics, and user-facing error reporting. It is the common control shell for both automatic and manual remote compaction.

**Data flow**: It receives session state, turn state, optional model-client connection, context-injection behavior, and labels describing the compaction. It records starting token counts, begins an analytics attempt, runs pre-compaction hooks, and either stops early or calls the implementation function. Afterward it runs post-compaction hooks when appropriate, records the final status, sends an error event if compaction failed, and returns success or failure.

**Call relations**: Both public entry functions feed into this function. It calls run_remote_compact_task_inner_impl for the actual remote request and replacement-history work, while surrounding that call with run_pre_compact_hooks, run_post_compact_hooks, analytics tracking, and session error reporting.

*Call graph*: calls 6 internal fn (begin, compaction_status_from_result, run_remote_compact_task_inner_impl, run_post_compact_hooks, run_pre_compact_hooks, new); called by 2 (run_inline_remote_auto_compact_task, run_remote_compact_task); 2 external calls (default, Error).


##### `run_remote_compact_task_inner_impl`  (lines 179–321)

```
async fn run_remote_compact_task_inner_impl(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: Option<&mut ModelClientSession>,
    initial_context_injection: InitialCo
```

**Purpose**: Performs the main compaction job: prepare the conversation, ask the remote model service for a compacted item, build the new history, and install it into the session. This is where the old large history is actually turned into a smaller usable history.

**Data flow**: It starts with the current session history and turn settings. It creates a context-compaction item for UI/tracing, trims large function-call history so the request can fit, builds a prompt that includes current history, tools, instructions, and a compaction trigger, and sends it through run_remote_compaction_request_v2. When the remote compaction item returns, it records token usage, builds compacted history, optionally adds a reference to the current turn context, replaces the session history, recomputes token usage, emits completion, and returns success.

**Call relations**: run_remote_compact_task_inner calls this after hooks allow the work to continue. This function calls built_tools to describe model-visible tools, run_remote_compaction_request_v2 to talk to the model service, build_v2_compacted_history to shape the replacement history, and process_compacted_history before installing the final history into the session.

*Call graph*: calls 6 internal fn (process_compacted_history, trim_function_call_history_to_fit_context_window, build_v2_compacted_history, run_remote_compaction_request_v2, built_tools, new); called by 1 (run_remote_compact_task_inner); 6 external calls (new, new, ContextCompaction, Compaction, info!, json!).


##### `run_remote_compaction_request_v2`  (lines 328–376)

```
async fn run_remote_compaction_request_v2(
    sess: &Session,
    turn_context: &TurnContext,
    client_session: &mut ModelClientSession,
    prompt: &Prompt,
    responses_metadata: &CodexResponses
```

**Purpose**: Sends the compaction prompt to the model service and retries a small number of times if the streaming response fails in a retryable way. It protects long compaction jobs from transient network or service problems without retrying forever.

**Data flow**: It receives the session, turn context, model-client session, prompt, and request metadata. It opens a streaming model request, passes the stream to collect_compaction_output, and either returns the collected compaction output or examines the error. Non-retryable errors come back immediately; retryable errors are handed to the retry helper, which may wait, reset state, and allow another loop attempt.

**Call relations**: The implementation function calls this when the prompt is ready. This function calls the model-client stream method, then hands the stream to collect_compaction_output; on retryable failures it calls handle_retryable_response_stream_error before trying again.

*Call graph*: calls 4 internal fn (stream, collect_compaction_output, handle_retryable_response_stream_error, disabled); called by 1 (run_remote_compact_task_inner_impl).


##### `collect_compaction_output`  (lines 378–426)

```
async fn collect_compaction_output(
    mut stream: ResponseStream,
) -> CodexResult<RemoteCompactionV2Output>
```

**Purpose**: Reads the model service’s streaming response and extracts the one compaction item the rest of the system needs. It enforces the rule that a remote compaction response must finish cleanly and contain exactly one compaction result.

**Data flow**: It receives a response stream. As events arrive, it counts completed output items, remembers the first compaction item, and watches for the final completed event and its token usage. If the stream ends before completion, it returns a stream error; if there are zero or multiple compaction items, it returns a fatal error; otherwise it returns the compaction item plus any token-usage data.

**Call relations**: run_remote_compaction_request_v2 calls this after opening a stream. A test also calls it with a fake stream to prove that ordinary extra output items can appear, as long as there is exactly one compaction item and a completed event.

*Call graph*: called by 2 (run_remote_compaction_request_v2, collect_compaction_output_accepts_additional_output_items); 5 external calls (next, format!, Fatal, Stream, unreachable!).


##### `build_v2_compacted_history`  (lines 428–446)

```
fn build_v2_compacted_history(
    prompt_input: &[ResponseItem],
    compaction_output: ResponseItem,
) -> (Vec<ResponseItem>, usize)
```

**Purpose**: Creates the replacement conversation history that will be installed after remote compaction. It keeps a limited set of original messages, trims them to a token budget, counts retained images, and appends the new compacted record.

**Data flow**: It receives the prompt input used for compaction and the remote compaction output. It filters the input down to retained message types, applies additional compacted-history filtering, truncates retained messages to the configured token budget, counts input images that survived, appends the compaction output, and returns the new history plus the image count.

**Call relations**: run_remote_compact_task_inner_impl calls this after the remote model produces the compaction item. The tests call it directly to verify that it keeps the intended history shape, discards unwanted messages before truncation, and reports retained images correctly.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); called by 4 (run_remote_compact_task_inner_impl, build_v2_compacted_history_counts_retained_input_images, build_v2_compacted_history_discards_messages_before_truncating, build_v2_compacted_history_filters_to_installed_retention_shape); 1 external calls (iter).


##### `is_retained_for_remote_compaction_v2`  (lines 448–454)

```
fn is_retained_for_remote_compaction_v2(item: &ResponseItem) -> bool
```

**Purpose**: Decides whether a response item is even eligible to remain alongside the compacted summary. In this version, only user, developer, and system messages pass this first gate.

**Data flow**: It receives one response item. If the item is not a message, it returns false; if it is a message, it checks the role string and returns true only for user, developer, or system roles.

**Call relations**: This helper is used during compacted-history construction before token trimming. It acts like a first sieve, removing assistant replies, tool calls, old compaction items, and other non-message records from the retained-history candidates.

*Call graph*: 1 external calls (matches!).


##### `retained_input_image_count`  (lines 456–465)

```
fn retained_input_image_count(item: &ResponseItem) -> usize
```

**Purpose**: Counts how many input images are present in a retained message. This lets analytics record how much image context survived compaction.

**Data flow**: It receives one response item. Non-message items count as zero; message items are scanned content by content, and each input-image content item adds one to the returned count.

**Call relations**: The history-building step uses this after truncation so it counts only images that actually remain in the replacement history.


##### `truncate_retained_messages_for_remote_compaction`  (lines 467–491)

```
fn truncate_retained_messages_for_remote_compaction(
    items: Vec<ResponseItem>,
    max_tokens: usize,
) -> Vec<ResponseItem>
```

**Purpose**: Cuts retained messages down to a maximum text-token budget while favoring the newest messages. A token is a rough chunk of text the model reads; limiting tokens keeps the replacement history from becoming too large again.

**Data flow**: It receives retained response items and a maximum token count. It walks from newest to oldest, spending the remaining budget on each message, keeping whole messages when they fit, truncating one message when only part fits, and dropping older messages after the budget is gone. It reverses the kept items back into chronological order and returns them.

**Call relations**: build_v2_compacted_history calls this before appending the new compaction output. Several tests call it directly to confirm that newest messages win, images are preserved when their message is kept, image-only messages still consume a minimum budget slot, and older items are dropped after the budget is spent.

*Call graph*: calls 2 internal fn (message_text_token_count, truncate_message_text_to_token_budget); called by 5 (build_v2_compacted_history, retained_history_truncation_charges_image_only_messages, retained_history_truncation_drops_image_only_messages_after_budget_is_spent, retained_history_truncation_keeps_newest_messages_first, retained_history_truncation_preserves_images_and_truncates_later_text_parts); 1 external calls (with_capacity).


##### `message_text_token_count`  (lines 493–507)

```
fn message_text_token_count(item: &ResponseItem) -> usize
```

**Purpose**: Estimates how many text tokens a message contains. This gives the truncation code a simple way to decide whether a message fits in the retained-message budget.

**Data flow**: It receives one response item. Non-message items count as zero; for message items, it adds approximate token counts for input-text and output-text content while treating images as zero text tokens.

**Call relations**: truncate_retained_messages_for_remote_compaction calls this for each retained candidate while spending the token budget from newest to oldest.

*Call graph*: called by 1 (truncate_retained_messages_for_remote_compaction).


##### `truncate_message_text_to_token_budget`  (lines 509–559)

```
fn truncate_message_text_to_token_budget(
    item: ResponseItem,
    max_tokens: usize,
) -> Option<ResponseItem>
```

**Purpose**: Shortens the text parts of a single message so they fit within a remaining token budget, while preserving images and message metadata. It is used when a whole message is too large but part of it can still be kept.

**Data flow**: It receives a response item and a maximum token allowance. For non-message items, it returns the item unchanged; for messages, it walks through each content piece, keeps or truncates text based on the remaining budget, always keeps image content, drops empty text pieces, and returns either the rebuilt message or nothing if no content remains.

**Call relations**: truncate_retained_messages_for_remote_compaction calls this when the next newest message is larger than the remaining budget. It uses the shared text-truncation utility so the shortened text clearly marks that content was removed.

*Call graph*: called by 1 (truncate_retained_messages_for_remote_compaction); 4 external calls (with_capacity, approx_token_count, truncate_text, Tokens).


##### `tests::message`  (lines 570–580)

```
fn message(role: &str, text: &str, phase: Option<MessagePhase>) -> ResponseItem
```

**Purpose**: Creates a small test message item with a chosen role, text, and optional phase. It keeps the tests readable by hiding the repeated response-item construction.

**Data flow**: It takes a role string, text string, and optional message phase. It wraps the text as input-text content inside a response message and returns that test item.

**Call relations**: Many tests call this helper when they need simple user, developer, system, or assistant messages. It supports tests for history filtering and truncation without distracting setup code.

*Call graph*: 1 external calls (vec!).


##### `tests::response_stream`  (lines 582–594)

```
fn response_stream(events: Vec<CodexResult<ResponseEvent>>) -> ResponseStream
```

**Purpose**: Builds a fake response stream for tests. It lets a test feed predetermined stream events into collect_compaction_output without contacting a real model service.

**Data flow**: It receives a list of stream events or errors. It sends them into an in-memory channel, closes the sender, and returns a ResponseStream that will yield those events to the collector.

**Call relations**: The stream-collection test calls this helper to simulate the Responses API. That test then passes the fake stream to collect_compaction_output and checks the extracted compaction item and token usage.

*Call graph*: 2 external calls (new, channel).


##### `tests::build_v2_compacted_history_filters_to_installed_retention_shape`  (lines 597–628)

```
fn build_v2_compacted_history_filters_to_installed_retention_shape()
```

**Purpose**: Checks that compacted history keeps only the kinds of items intended for installation. It guards against accidentally preserving assistant messages, tool calls, or old compaction records.

**Data flow**: It builds mixed input containing developer, system, user, assistant, function-call, and old compaction items, plus a new compaction output. It runs build_v2_compacted_history and verifies that the final history contains only the expected retained user message and the new compaction output.

**Call relations**: This test calls build_v2_compacted_history directly. It protects the replacement-history contract used by run_remote_compact_task_inner_impl before session history is replaced.

*Call graph*: calls 1 internal fn (build_v2_compacted_history); 2 external calls (assert_eq!, vec!).


##### `tests::build_v2_compacted_history_discards_messages_before_truncating`  (lines 631–653)

```
fn build_v2_compacted_history_discards_messages_before_truncating()
```

**Purpose**: Checks that unwanted context-like messages are removed before the retained-message token budget is applied. This prevents huge discarded messages from crowding out useful newer user messages.

**Data flow**: It creates old and new user messages plus very large developer/contextual messages. After build_v2_compacted_history runs, the test verifies that the old user message, new user message, and new compaction output remain, showing that discarded material did not consume the truncation budget.

**Call relations**: This test calls build_v2_compacted_history. It confirms the order of operations that the main compaction installer relies on: filter first, then truncate.

*Call graph*: calls 1 internal fn (build_v2_compacted_history); 4 external calls (assert_eq!, message, format!, vec!).


##### `tests::build_v2_compacted_history_counts_retained_input_images`  (lines 656–684)

```
fn build_v2_compacted_history_counts_retained_input_images()
```

**Purpose**: Checks that retained images are counted correctly when building compacted history. This supports accurate analytics after compaction.

**Data flow**: It creates a retained user message containing one text item and two input images, then adds a compaction output. It runs build_v2_compacted_history and verifies that the reported retained image count is two.

**Call relations**: This test calls build_v2_compacted_history, which uses the image-counting helper internally. It validates the analytics number later stored by run_remote_compact_task_inner_impl.

*Call graph*: calls 1 internal fn (build_v2_compacted_history); 2 external calls (assert_eq!, vec!).


##### `tests::retained_history_truncation_keeps_newest_messages_first`  (lines 687–706)

```
fn retained_history_truncation_keeps_newest_messages_first()
```

**Purpose**: Checks that token-budget truncation favors recent conversation. This matters because the latest messages are usually most important for the model to answer correctly.

**Data flow**: It creates old, middle, and new user messages, then truncates with a tiny token budget. It verifies that the newest message is kept and the middle message is shortened, while the oldest message is dropped.

**Call relations**: This test calls truncate_retained_messages_for_remote_compaction directly. It protects the newest-first behavior used when build_v2_compacted_history prepares replacement history.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 3 external calls (assert_eq!, message, vec!).


##### `tests::retained_history_truncation_preserves_images_and_truncates_later_text_parts`  (lines 709–753)

```
fn retained_history_truncation_preserves_images_and_truncates_later_text_parts()
```

**Purpose**: Checks that truncating a mixed message keeps images and trims text only as needed. This prevents image context from being lost just because surrounding text is too long.

**Data flow**: It builds one message with text, an input image, and more text, then applies a small token budget. It verifies that the first text and image remain and that the later text is shortened with a visible truncation marker.

**Call relations**: This test calls truncate_retained_messages_for_remote_compaction. It indirectly exercises truncate_message_text_to_token_budget, which performs the per-content trimming.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 2 external calls (assert_eq!, vec!).


##### `tests::retained_history_truncation_charges_image_only_messages`  (lines 756–778)

```
fn retained_history_truncation_charges_image_only_messages()
```

**Purpose**: Checks that image-only messages still consume a small amount of retained-history budget. This prevents unlimited image-only messages from slipping through a text-token budget for free.

**Data flow**: It builds an older text message, an image-only message, and the newest text message, then truncates with a budget of two. It verifies that the image-only message and newest message remain while the older text message is dropped.

**Call relations**: This test calls truncate_retained_messages_for_remote_compaction. It confirms the helper’s rule that every kept message costs at least one budget unit, even if it has no text tokens.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 3 external calls (assert_eq!, message, vec!).


##### `tests::retained_history_truncation_drops_image_only_messages_after_budget_is_spent`  (lines 781–799)

```
fn retained_history_truncation_drops_image_only_messages_after_budget_is_spent()
```

**Purpose**: Checks that image-only messages are not kept once the retained-message budget has already been used up. This is the companion case to charging image-only messages.

**Data flow**: It builds an image-only message followed by the newest text message, then truncates with a budget of one. The newest message uses the budget, so the test verifies that the older image-only message is dropped.

**Call relations**: This test calls truncate_retained_messages_for_remote_compaction. It guards the budget-enforcement behavior used before compacted history is installed.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 3 external calls (assert_eq!, message, vec!).


##### `tests::collect_compaction_output_accepts_additional_output_items`  (lines 802–842)

```
async fn collect_compaction_output_accepts_additional_output_items()
```

**Purpose**: Checks that the stream collector accepts harmless extra output items as long as exactly one compaction item is present. This matches real streaming behavior where the model service may emit ordinary output around the compaction result.

**Data flow**: It creates a fake stream containing an ordinary assistant output item, one compaction item, and a completed event with token usage. It passes that stream to collect_compaction_output and verifies that the compaction item and token-usage numbers are returned.

**Call relations**: This test uses response_stream to build the fake stream and then calls collect_compaction_output. It protects the stream-reading rule used by run_remote_compaction_request_v2 during real remote compaction.

*Call graph*: calls 1 internal fn (collect_compaction_output); 3 external calls (assert_eq!, response_stream, vec!).


### `ext/image-generation/src/backend.rs`

`io_transport` · `request handling`

The image-generation extension needs a safe, consistent way to talk to the image service. This file provides that small bridge. Think of it like a front desk clerk: the rest of the extension hands it an image request, and it figures out which service desk to use, which credentials to show, and how to send the request.

The central type is `CodexImagesBackend`. It keeps a shared model provider, which is the project’s source of truth for “which API provider are we using?” and “what authentication should we use?” Authentication means the proof, such as a token, that the request is allowed.

Before every image request, the backend asks the shared provider for the current API provider and auth details. It then builds an `ImagesClient`, using a `ReqwestTransport`. `reqwest` is the HTTP library used to make web requests, so this transport is the piece that actually sends data over the network.

The public methods are simple: `generate` sends a new image creation request, and `edit` sends an image editing request. Both create a fresh client, send the request with empty extra HTTP headers, and convert any lower-level error into a plain string. Without this file, callers would need to repeat provider lookup, authentication, HTTP client setup, and error conversion every time they wanted to use the image API.

#### Function details

##### `CodexImagesBackend::new`  (lines 17–19)

```
fn new(provider: SharedModelProvider) -> Self
```

**Purpose**: Creates a new image backend tied to the shared model provider. Callers use this when they want one object that knows how to send image requests through the currently configured provider.

**Data flow**: It receives a shared provider object as input. It stores that provider inside a new `CodexImagesBackend`. The result is a backend value ready to be cloned and used for later image generation or editing calls.

**Call relations**: This is the setup step for the backend. Later, when request-handling code needs to generate or edit an image, it uses the backend created here rather than rebuilding the provider connection logic itself.


##### `CodexImagesBackend::client`  (lines 22–38)

```
async fn client(&self) -> Result<ImagesClient<ReqwestTransport>, String>
```

**Purpose**: Builds a ready-to-use image API client for the current request. It gathers the current provider and login information, then combines them with an HTTP transport so the next step can actually contact the image service.

**Data flow**: It starts with the backend’s stored shared provider. It asks that provider for the active API provider and the authentication details. If either lookup fails, the error is turned into a plain string. If both succeed, it builds a reqwest HTTP client, wraps it in a transport, and returns an `ImagesClient` configured with the provider and auth.

**Call relations**: This function is the common preparation step used by both `CodexImagesBackend::generate` and `CodexImagesBackend::edit`. Those higher-level methods call it first so they do not need to know how provider lookup, authentication, or HTTP setup works.

*Call graph*: calls 3 internal fn (new, new, build_reqwest_client); called by 2 (edit, generate); 2 external calls (api_auth, api_provider).


##### `CodexImagesBackend::generate`  (lines 41–50)

```
async fn generate(
        &self,
        request: ImageGenerationRequest,
    ) -> Result<ImageResponse, String>
```

**Purpose**: Sends a request to create a new image. It is the method other parts of the image-generation feature call when the user or system asks for an image to be generated from scratch.

**Data flow**: It receives an `ImageGenerationRequest`, which contains the details of the desired image. It first asks `CodexImagesBackend::client` for an authenticated image API client. Then it sends the request with no extra HTTP headers. The output is either an `ImageResponse` from the service or a plain string describing what went wrong.

**Call relations**: This method is called by `handle_call` when an incoming tool or extension request asks for image generation. It delegates setup to `CodexImagesBackend::client`, then hands the prepared request to the image API client’s generate operation.

*Call graph*: calls 1 internal fn (client); called by 1 (handle_call); 1 external calls (new).


##### `CodexImagesBackend::edit`  (lines 53–59)

```
async fn edit(&self, request: ImageEditRequest) -> Result<ImageResponse, String>
```

**Purpose**: Sends a request to edit an existing image. It is used when the feature needs to modify an image rather than create one entirely from scratch.

**Data flow**: It receives an `ImageEditRequest`, which describes the image-editing job. It builds an authenticated client through `CodexImagesBackend::client`, sends the edit request with no extra HTTP headers, and returns either the image service’s `ImageResponse` or a plain string error.

**Call relations**: This method is called by `handle_call` when an incoming request asks for image editing. Like generation, it relies on `CodexImagesBackend::client` for provider, authentication, and transport setup, then passes the actual edit work to the image API client.

*Call graph*: calls 1 internal fn (client); called by 1 (handle_call); 1 external calls (new).


### Realtime websocket protocol stack
These files organize the realtime websocket module, define version-specific message shapes and parsers, and provide the unified websocket transport methods.

### `codex-api/src/endpoint/realtime_websocket/mod.rs`

`orchestration` · `cross-cutting`

This module is like the reception desk for realtime WebSocket support. A WebSocket is a long-lived network connection that lets the client and server send messages back and forth without reopening a new connection each time. The actual work is split across several smaller files: some describe the wire protocol, some provide client methods, and some keep shared behavior used by multiple protocol versions.

The important job of this file is to hide that internal layout from the rest of the codebase. Other code can import clear names such as `RealtimeWebsocketClient`, `RealtimeWebsocketConnection`, `RealtimeWebsocketWriter`, `RealtimeEventParser`, and `RealtimeSessionConfig` from this module instead of knowing which versioned subfile contains them. That makes the realtime endpoint easier to use and easier to change later.

It also separates public-facing pieces from private building blocks. Version-specific modules for v1 and v2 are kept inside this folder, while only the chosen shared interface is re-exported. Without this file, callers would need to depend directly on the internal file structure, which would make future protocol changes more fragile.


### `codex-api/src/endpoint/realtime_websocket/methods_common.rs`

`orchestration` · `websocket setup and message sending`

The realtime WebSocket endpoint has two protocol shapes: V1 and Realtime V2. They are similar in purpose, but the exact messages are not always the same. This file acts like a translator at a front desk: the rest of the system says what it wants to do, and this file chooses the right wording for the protocol version being used.

Most functions take a RealtimeEventParser value, which tells the code which protocol version is active. They then call the matching V1 or V2 helper. For normal conversation text, both versions have a message creator. For function-call output, V2 has a direct message type, while V1 uses a handoff-style message and adds a special "Agent Final Message" prefix so the older protocol understands the result in the expected format.

Session setup is also normalized here. V1 only supports conversational behavior, so any requested session mode is forced to Conversational for V1. V2 keeps the requested mode and can also include output style and voice settings. One public helper turns the final session update into JSON, ready to be sent over the wire.

Without this file, callers would need repeated version checks everywhere, making the WebSocket code easier to break when protocol details change.

#### Function details

##### `normalized_session_mode`  (lines 24–32)

```
fn normalized_session_mode(
    event_parser: RealtimeEventParser,
    session_mode: RealtimeSessionMode,
) -> RealtimeSessionMode
```

**Purpose**: This function makes sure the requested realtime session mode is valid for the protocol version in use. It hides an important rule: V1 always behaves as a conversational session, while Realtime V2 can use the requested mode.

**Data flow**: It receives the active parser version and a requested session mode. If the parser is V1, it replaces the requested mode with Conversational. If the parser is Realtime V2, it leaves the mode unchanged. The result is the mode that should actually be used when building a session update.

**Call relations**: When a session update is being prepared, session_update_session calls this first so it can build a version-appropriate update. send_session_update also relies on the same normalization path before sending session settings to the WebSocket service.

*Call graph*: called by 2 (send_session_update, session_update_session).


##### `conversation_item_create_message`  (lines 34–43)

```
fn conversation_item_create_message(
    event_parser: RealtimeEventParser,
    text: String,
    role: ConversationTextRole,
) -> RealtimeOutboundMessage
```

**Purpose**: This function builds an outbound conversation text message in the correct protocol format. Callers can provide text and a speaker role without worrying about whether the WebSocket connection is V1 or Realtime V2.

**Data flow**: It receives the active protocol version, the text to send, and the role for that text, such as which side of the conversation it belongs to. It chooses the V1 message builder for V1 connections or the V2 message builder for Realtime V2 connections. It returns a RealtimeOutboundMessage ready for the sending layer.

**Call relations**: send_conversation_item_create calls this when it needs to send a new conversation item. This function then hands the work to the version-specific message creator, so the sending code stays simple and does not duplicate protocol checks.

*Call graph*: calls 2 internal fn (conversation_item_create_message, conversation_item_create_message); called by 1 (send_conversation_item_create).


##### `conversation_function_call_output_message`  (lines 45–59)

```
fn conversation_function_call_output_message(
    event_parser: RealtimeEventParser,
    call_id: String,
    output_text: String,
) -> RealtimeOutboundMessage
```

**Purpose**: This function builds a message containing the result of a function call or handoff, using the format expected by the current realtime protocol. It is especially important because V1 and V2 represent this result differently.

**Data flow**: It receives the protocol version, a call identifier, and the output text produced by the function. For V2, it sends those directly into the V2 function-call-output message builder. For V1, it wraps the output text with the special "Agent Final Message" label and sends it through the V1 handoff-append message builder. The output is a RealtimeOutboundMessage ready to send.

**Call relations**: send_conversation_function_call_output calls this after there is function-call output to report back. This function then chooses either the older V1 handoff-style path or the newer V2 direct function-output path, preserving the meaning across both protocols.

*Call graph*: calls 2 internal fn (conversation_handoff_append_message, conversation_function_call_output_message); called by 1 (send_conversation_function_call_output); 1 external calls (format!).


##### `session_update_session`  (lines 61–75)

```
fn session_update_session(
    event_parser: RealtimeEventParser,
    instructions: String,
    session_mode: RealtimeSessionMode,
    output_modality: RealtimeOutputModality,
    voice: RealtimeVoice
```

**Purpose**: This function creates a session update object with the right fields for the current realtime protocol. It centralizes the rules for instructions, session mode, output style, and voice selection.

**Data flow**: It receives instructions, a requested session mode, an output modality, and a voice, along with the protocol version. First it normalizes the session mode so V1 is always conversational. Then it builds either a V1 session update, which uses instructions and voice, or a V2 session update, which can also include session mode and output modality. It returns a SessionUpdateSession object.

**Call relations**: send_session_update uses this when it needs to send fresh session settings over the WebSocket. session_update_session_json also uses it as the first step before adding identifiers and turning the session update into JSON.

*Call graph*: calls 3 internal fn (normalized_session_mode, session_update_session, session_update_session); called by 2 (send_session_update, session_update_session_json).


##### `session_update_session_json`  (lines 77–88)

```
fn session_update_session_json(config: RealtimeSessionConfig) -> JsonResult<Value>
```

**Purpose**: This public helper turns a full realtime session configuration into JSON that can be sent or stored. It is the bridge from the project’s structured Rust data into a generic JSON value.

**Data flow**: It receives a RealtimeSessionConfig containing the parser version, instructions, mode, output modality, voice, session id, and model. It builds the protocol-specific session update, fills in the session id and model afterward, and then serializes the result into a JSON value. It returns either that JSON value or a JSON serialization error.

**Call relations**: This function calls session_update_session to reuse the same version-selection logic as normal WebSocket sending. After the structured message is complete, it hands it to serde_json’s to_value function so outside code can work with a JSON representation.

*Call graph*: calls 1 internal fn (session_update_session); 1 external calls (to_value).


##### `websocket_intent`  (lines 90–95)

```
fn websocket_intent(event_parser: RealtimeEventParser) -> Option<&'static str>
```

**Purpose**: This function returns the optional intent string that should be attached to a WebSocket URL for the active protocol version. It lets URL-building code ask one common question instead of knowing version-specific rules.

**Data flow**: It receives the active protocol version. For V1 it asks the V1 helper for the intent value, and for Realtime V2 it asks the V2 helper. It returns either a static text value or nothing, depending on what that protocol requires.

**Call relations**: websocket_url_from_api_url calls this while constructing the WebSocket URL. This function delegates the protocol detail to the matching V1 or V2 helper, so URL construction does not need to know which versions require which intent marker.

*Call graph*: calls 2 internal fn (websocket_intent, websocket_intent); called by 1 (websocket_url_from_api_url).


### `codex-api/src/endpoint/realtime_websocket/methods_v1.rs`

`io_transport` · `websocket session setup and message sending`

This file is a small adapter between the rest of the application and the realtime WebSocket protocol. A WebSocket is a long-lived network connection where both sides can send messages at any time. The rest of the code should not have to remember every nested field needed by that protocol, so this file provides focused helper functions that assemble the right shapes.

Think of it like pre-printed shipping labels. Other code supplies the important content, such as a user message or session instructions, and these helpers put that content into the exact envelope the realtime service understands.

The file covers four version-1 protocol needs. It can create a conversation message containing input text and a role, append text to a conversation handoff, build a session update that sets instructions, voice, and audio format, and declare the WebSocket intent string for this version. The session update is especially important because it fixes the audio input format to PCM audio at the shared realtime sample rate and selects the Quicksilver session type. Without these helpers, callers would need to duplicate protocol details, making mistakes more likely whenever the realtime message format changes.

#### Function details

##### `conversation_item_create_message`  (lines 18–32)

```
fn conversation_item_create_message(
    text: String,
    role: ConversationTextRole,
) -> RealtimeOutboundMessage
```

**Purpose**: Creates an outbound realtime message that adds a text message to the conversation. Callers use it when they have plain text plus a speaker role, such as user or assistant, and need to send it in the WebSocket protocol format.

**Data flow**: It receives the message text and the conversation role. It wraps them into a message item, marks the content as input text, puts that single content block into a list, and returns a `RealtimeOutboundMessage` ready to send over the realtime connection. It does not change any outside state.

**Call relations**: In the bigger flow, this is the packaging step before a text message leaves the application. The call graph shows it reached through the same-named conversation item creation path; inside, it relies on standard constructors such as the message variant and a small list builder to form the protocol object.

*Call graph*: called by 1 (conversation_item_create_message); 2 external calls (Message, vec!).


##### `conversation_handoff_append_message`  (lines 34–42)

```
fn conversation_handoff_append_message(
    handoff_id: String,
    output_text: String,
) -> RealtimeOutboundMessage
```

**Purpose**: Creates an outbound message that appends output text to an existing handoff. A handoff is a tracked transfer or continuation identified by an ID, so the receiving side knows which ongoing exchange the text belongs to.

**Data flow**: It receives a handoff ID and the text to append. It places both values into a `ConversationHandoffAppend` outbound message and returns that message unchanged otherwise. Nothing is written to storage or sent directly here; this function only builds the payload.

**Call relations**: This helper is used when `conversation_function_call_output_message` has produced text that should be attached to a handoff. It gives that caller the correctly shaped realtime message, which can then be passed onward to the WebSocket sending layer.

*Call graph*: called by 1 (conversation_function_call_output_message).


##### `session_update_session`  (lines 44–72)

```
fn session_update_session(
    instructions: String,
    voice: RealtimeVoice,
) -> SessionUpdateSession
```

**Purpose**: Builds the session settings sent to the realtime service. It sets the session instructions, chooses the voice for audio output, and describes the audio input format the service should expect.

**Data flow**: It receives instruction text and a voice choice. It returns a `SessionUpdateSession` object with the Quicksilver session type, the instructions filled in, audio input set to PCM at the shared realtime sample rate, and audio output configured with the requested voice. Optional fields such as tools, model, transcription, and turn detection are left empty.

**Call relations**: This function is part of session setup or session reconfiguration. The call graph shows it reached through the same-named session update path; its job is to centralize the version-1 defaults so callers do not each rebuild the nested session structure by hand.

*Call graph*: called by 1 (session_update_session).


##### `websocket_intent`  (lines 74–76)

```
fn websocket_intent() -> Option<&'static str>
```

**Purpose**: Returns the intent label used when opening or identifying this realtime WebSocket mode. In this version, the intent is always `quicksilver`.

**Data flow**: It takes no input and returns a fixed optional text value containing `quicksilver`. It reads no external settings and changes nothing.

**Call relations**: This is a small identification hook for the WebSocket setup flow. The call graph shows it reached through the same-named intent path, where callers need the protocol-specific intent string before or during connection setup.

*Call graph*: called by 1 (websocket_intent).


### `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`

`io_transport` · `WebSocket session setup and realtime message sending`

This file is a small message factory for the realtime WebSocket API. A WebSocket is a long-lived connection where both sides can send messages at any time, which is useful for live voice and text interaction. The rest of the system should not have to remember every field the realtime API requires, so this file gathers those details in one place.

It creates two kinds of conversation messages: a normal text message and the output from a tool call. It also builds the session update message that tells the realtime service how the session should behave. In conversational mode, the session is set up for live audio input, optional audio or text output, voice selection, transcription, turn detection, and two callable tools. One tool sends work to a background agent; the other means “stay silent” when speaking would be distracting. In transcription mode, the setup is much simpler: accept audio and transcribe it, without responses, tools, or voice output.

A useful analogy is a restaurant order pad: callers say what they want in human-sized terms, and this file fills out the exact form the kitchen requires. Without it, session setup and outbound messages would be duplicated and easy to get subtly wrong.

#### Function details

##### `conversation_item_create_message`  (lines 39–53)

```
fn conversation_item_create_message(
    text: String,
    role: ConversationTextRole,
) -> RealtimeOutboundMessage
```

**Purpose**: Creates an outbound realtime message that adds a plain text conversation item. Callers use it when they need to send user, assistant, or system-style text into the realtime conversation.

**Data flow**: It receives the text to send and the conversation role, meaning who the text is from. It wraps that text in the protocol’s message shape, marks the content as input text, and returns a `RealtimeOutboundMessage` ready to be sent over the WebSocket. It does not change any stored state.

**Call relations**: When higher-level realtime code needs to add a text item to the conversation, it calls this helper instead of constructing the nested protocol object by hand. Inside, the helper builds the message payload and uses a vector because the protocol stores message content as a list, even when there is only one text part.

*Call graph*: called by 1 (conversation_item_create_message); 2 external calls (Message, vec!).


##### `conversation_function_call_output_message`  (lines 55–66)

```
fn conversation_function_call_output_message(
    call_id: String,
    output_text: String,
) -> RealtimeOutboundMessage
```

**Purpose**: Creates an outbound realtime message that reports the result of a function/tool call back to the realtime service. This is used after local code has completed work requested by the model, such as a background-agent action.

**Data flow**: It receives a tool call identifier and the output text for that call. It packages both into a function-call-output conversation item and returns it as a `RealtimeOutboundMessage`. The call identifier lets the realtime service match this result to the original tool request.

**Call relations**: In the broader realtime flow, code that finishes a requested function call uses this helper to answer the service in the expected format. The function hands off to the protocol data types that represent a function-call output item.

*Call graph*: called by 1 (conversation_function_call_output_message); 1 external calls (FunctionCallOutput).


##### `session_update_session`  (lines 68–162)

```
fn session_update_session(
    instructions: String,
    session_mode: RealtimeSessionMode,
    output_modality: RealtimeOutputModality,
    voice: RealtimeVoice,
) -> SessionUpdateSession
```

**Purpose**: Builds the session configuration sent to the realtime service. It decides whether the connection should behave like a full conversation or like a transcription-only audio listener.

**Data flow**: It receives instructions, a session mode, the desired output style, and the voice to use if audio output is enabled. For conversational sessions, it creates a realtime session with audio input, noise reduction, speech transcription, server-side voice activity detection, optional text or audio output, and two tools: one for delegating work to the background agent and one for remaining silent. For transcription sessions, it creates a simpler session that only accepts audio and transcribes it. The result is a `SessionUpdateSession` object ready to serialize and send.

**Call relations**: This is the main setup helper in the file. Session-starting code calls it when it needs to tell the realtime service what kind of interaction to run. It uses `output_modality_value` to translate the local output choice into the exact string the version 2 protocol expects.

*Call graph*: called by 1 (session_update_session); 1 external calls (vec!).


##### `output_modality_value`  (lines 164–169)

```
fn output_modality_value(output_modality: RealtimeOutputModality) -> &'static str
```

**Purpose**: Translates the program’s output-mode choice into the exact protocol word used by the realtime API. It keeps the string values `text` and `audio` in one place so callers do not repeat them.

**Data flow**: It receives a `RealtimeOutputModality`, which is the local enum for choosing text or audio output. It matches that choice and returns the corresponding static string: `text` for text output or `audio` for audio output.

**Call relations**: This helper is used while building a conversational session update. `session_update_session` calls it so the final session object contains the protocol’s expected output modality string.


##### `websocket_intent`  (lines 171–173)

```
fn websocket_intent() -> Option<&'static str>
```

**Purpose**: Provides the optional WebSocket intent value for this version of the realtime API. For version 2, there is no special intent to send, so it returns nothing.

**Data flow**: It takes no input and always returns `None`, meaning there is no intent string to attach. It does not read or change any state.

**Call relations**: Code that prepares a realtime WebSocket connection can call this function to ask whether this protocol version needs an extra intent marker. For this version, the answer is always absent, which lets the caller skip that part cleanly.

*Call graph*: called by 1 (websocket_intent).


### `codex-api/src/endpoint/realtime_websocket/protocol_v1.rs`

`io_transport` · `realtime WebSocket message handling`

Realtime WebSocket messages arrive as plain text, usually JSON. The rest of the system does not want to inspect raw JSON strings every time it needs to react to audio, transcripts, errors, or conversation updates. This file acts like a translator at the border: it reads a v1 protocol message, checks what kind of message it is, pulls out the important fields, and returns a typed `RealtimeEvent` that other code can use safely.

The main function first asks shared parsing code to turn the text into JSON and identify the message type. Then it matches that type against the v1 event names. Some events are handed to shared helpers, such as transcript updates or error messages. Others are built directly here, such as outgoing audio frames, handoff requests, and conversation item notifications.

If a required field is missing or has the wrong shape, the parser returns nothing instead of guessing. That matters because bad audio metadata or an incomplete handoff request could cause confusing behavior later. If the event type is unknown, the file logs a debug message and ignores it. In everyday terms, this file is the receptionist for v1 realtime messages: it opens the envelope, reads the label, and forwards only well-formed messages to the right internal desk.

#### Function details

##### `parse_realtime_event_v1`  (lines 12–91)

```
fn parse_realtime_event_v1(payload: &str) -> Option<RealtimeEvent>
```

**Purpose**: This function turns one raw v1 realtime WebSocket payload into a `RealtimeEvent`, which is the project’s internal representation of things like audio output, transcript changes, errors, and conversation updates. It is used when the outer realtime parser has decided the incoming message belongs to protocol version 1.

**Data flow**: It receives a text payload. It asks the shared payload parser to read the JSON and extract the event type. Based on that type, it either delegates to shared helpers, pulls fields directly from the JSON, or builds a specific internal event such as an audio frame or handoff request. If the payload is malformed, lacks required fields, or names an unsupported event type, it returns no event; for unsupported types it also writes a debug log message.

**Call relations**: The broader realtime parser calls this function when it needs to interpret a v1 message. This function is the dispatcher for v1: it sends common event shapes to shared parsers like `parse_session_updated_event`, `parse_transcript_delta_event`, `parse_transcript_done_event`, and `parse_error_event`; it calls `parse_conversation_item_done_event` for the special conversation-item-finished shape; and it directly constructs internal events for audio, handoff requests, and item-added messages.

*Call graph*: calls 6 internal fn (parse_error_event, parse_realtime_payload, parse_session_updated_event, parse_transcript_delta_event, parse_transcript_done_event, parse_conversation_item_done_event); called by 1 (parse_realtime_event); 4 external calls (new, debug!, AudioOut, HandoffRequested).


##### `parse_conversation_item_done_event`  (lines 93–99)

```
fn parse_conversation_item_done_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: This small helper extracts the finished conversation item’s ID from a v1 JSON event and turns it into a `ConversationItemDone` event. It keeps the main parser from being cluttered with the details of this one JSON shape.

**Data flow**: It receives an already-parsed JSON value. It looks for an `item` object inside it, then looks for that item’s string `id`. If both are present, it returns an internal event containing that item ID. If the expected object or ID is missing, it returns no event.

**Call relations**: It is called only by `parse_realtime_event_v1` when the message type says a conversation item is done. It does not call other project parsers; it simply reads the needed fields from the JSON and hands the cleaned-up result back to the main v1 parsing flow.

*Call graph*: called by 1 (parse_realtime_event_v1); 1 external calls (get).


### `codex-api/src/endpoint/realtime_websocket/protocol_v2.rs`

`io_transport` · `realtime WebSocket message handling`

A realtime WebSocket sends many small JSON messages: audio chunks, transcript updates, response status changes, tool calls, and errors. This file is the version-2 interpreter for those messages. Without it, the rest of the app would receive raw JSON strings and would have to guess what each message means.

The main function first parses the incoming text as JSON and reads its event type. It then uses that type like a sorting label. Transcript messages are sent to shared transcript parsers. Audio messages become `AudioOut` events with audio data and basic format details, using safe defaults when the server does not say the sample rate or channel count. Response lifecycle messages become simple created, cancelled, or done events.

One important special case is finished conversation items. Most of them simply mean “this item is done,” but some are actually tool calls. A call to the `background_agent` tool becomes a handoff request, meaning another agent should take over work. A call to the `remain_silent` tool becomes a no-op request, meaning the assistant intentionally should not respond. The file also tries to pull a useful user transcript out of tool-call arguments, checking several possible field names because servers may package the same idea in slightly different ways.

#### Function details

##### `parse_realtime_event_v2`  (lines 24–79)

```
fn parse_realtime_event_v2(payload: &str) -> Option<RealtimeEvent>
```

**Purpose**: This is the main translator for Realtime protocol version 2 messages. It takes one raw WebSocket payload and turns it into the internal event shape the rest of the system understands, or returns nothing if the message is not useful or not supported.

**Data flow**: A JSON string comes in. The function asks the shared payload parser to decode it and find its message type. It then matches that type to the right conversion path: session updates, audio deltas, transcript changes, speech-start notices, conversation items, response status messages, or errors. The result is either a `RealtimeEvent` with the useful information copied out, or `None` if parsing fails or the event type is unknown.

**Call relations**: This function is called by the broader `parse_realtime_event` flow when a version-2 realtime message needs decoding. It delegates common message shapes to shared helpers such as the session, transcript, error, and payload parsers, and uses local helpers for version-2-specific audio, response IDs, and completed conversation items.

*Call graph*: calls 8 internal fn (parse_error_event, parse_realtime_payload, parse_session_updated_event, parse_transcript_delta_event, parse_transcript_done_event, parse_conversation_item_done_event, parse_output_audio_delta_event, parse_response_event_response_id); called by 1 (parse_realtime_event); 5 external calls (debug!, InputAudioSpeechStarted, ResponseCancelled, ResponseCreated, ResponseDone).


##### `parse_response_event_response_id`  (lines 81–94)

```
fn parse_response_event_response_id(parsed: &Value) -> Option<String>
```

**Purpose**: This helper finds the response ID inside response-related messages. It exists because the same ID can appear in more than one place depending on how the server formats the event.

**Data flow**: A parsed JSON value comes in. The function first looks for `response.id` inside a nested response object. If that is missing, it looks for a top-level `response_id`. If either value is a string, it returns that string; otherwise it returns no ID.

**Call relations**: It is used by `parse_realtime_event_v2` when building response-created, response-cancelled, and response-done events. That lets the main parser keep response event creation simple while this helper deals with the two possible JSON layouts.

*Call graph*: called by 1 (parse_realtime_event_v2); 1 external calls (get).


##### `parse_output_audio_delta_event`  (lines 96–125)

```
fn parse_output_audio_delta_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: This helper converts an outgoing audio chunk from JSON into an internal audio-frame event. It makes sure the rest of the system gets both the audio data and enough format information to play or process it.

**Data flow**: A parsed JSON object comes in. The function reads the required `delta` string, which contains the audio data. It then reads optional audio details such as sample rate, channel count, sample count, and item ID. If the sample rate or channel count is missing, it uses the file’s defaults: 24,000 samples per second and one audio channel. It returns an `AudioOut` event, or nothing if the required audio data is missing.

**Call relations**: It is called by `parse_realtime_event_v2` for version-2 audio delta message types. After this helper builds the audio frame, the main parser can hand a normal `RealtimeEvent` to the rest of the realtime pipeline.

*Call graph*: called by 1 (parse_realtime_event_v2); 2 external calls (get, AudioOut).


##### `parse_conversation_item_done_event`  (lines 127–140)

```
fn parse_conversation_item_done_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: This helper interprets a completed conversation item. It checks whether the completed item is a special tool call before treating it as an ordinary finished item.

**Data flow**: A parsed JSON event comes in. The function looks for its `item` object. It first asks whether the item requests a handoff to the background agent, then asks whether it requests silence. If neither special meaning applies, it reads the item’s ID and returns a normal conversation-item-done event. If the item object or ID is missing, it returns nothing.

**Call relations**: It is called by `parse_realtime_event_v2` when a `conversation.item.done` message arrives. It then hands off to `parse_handoff_requested_event` and `parse_noop_requested_event` so that tool-call meanings are recognized before falling back to the ordinary completion event.

*Call graph*: calls 2 internal fn (parse_handoff_requested_event, parse_noop_requested_event); called by 1 (parse_realtime_event_v2); 1 external calls (get).


##### `parse_handoff_requested_event`  (lines 142–166)

```
fn parse_handoff_requested_event(item: &JsonMap<String, Value>) -> Option<RealtimeEvent>
```

**Purpose**: This helper recognizes a completed tool call that asks work to be handed to the background agent. In plain terms, it spots the assistant saying, “another worker should take this from here.”

**Data flow**: A conversation item object comes in. The function checks that the item is a `function_call` named `background_agent`. If not, it returns nothing. If it is, it finds a call ID, chooses an item ID, reads the tool arguments, extracts a useful input transcript from those arguments, and returns a `HandoffRequested` event.

**Call relations**: It is called by `parse_conversation_item_done_event` before ordinary item completion is reported. It uses `extract_input_transcript` to turn the tool’s argument text into the user-facing input that should accompany the handoff.

*Call graph*: calls 1 internal fn (extract_input_transcript); called by 1 (parse_conversation_item_done_event); 3 external calls (get, new, HandoffRequested).


##### `parse_noop_requested_event`  (lines 168–189)

```
fn parse_noop_requested_event(item: &JsonMap<String, Value>) -> Option<RealtimeEvent>
```

**Purpose**: This helper recognizes a completed tool call that means the assistant should stay silent. It turns that tool call into an explicit no-op event so later code knows the silence was intentional.

**Data flow**: A conversation item object comes in. The function checks that the item is a `function_call` named `remain_silent`. If not, it returns nothing. If it matches, it finds a call ID, chooses an item ID, and returns a `NoopRequested` event containing those IDs.

**Call relations**: It is called by `parse_conversation_item_done_event` after the handoff check and before the ordinary done-event fallback. This ordering lets special tool calls become meaningful internal events instead of being treated as just another completed conversation item.

*Call graph*: called by 1 (parse_conversation_item_done_event); 2 external calls (get, NoopRequested).


##### `extract_input_transcript`  (lines 191–210)

```
fn extract_input_transcript(arguments: &str) -> String
```

**Purpose**: This helper pulls the most useful user text out of a tool-call argument string. It is tolerant of several possible field names, because similar input may be labeled differently by different message producers.

**Data flow**: An argument string comes in. If it is empty, the function returns an empty string. If it can be parsed as JSON, the function looks for a non-empty string under known keys such as `input_transcript`, `input`, `text`, `prompt`, or `query`, trims extra whitespace, and returns the first good value. If parsing fails or none of those fields are useful, it returns the original argument string unchanged.

**Call relations**: It is called by `parse_handoff_requested_event` when building a handoff request. That way, the handoff event carries a clean piece of input text for the background agent instead of raw, possibly messy tool-call arguments.

*Call graph*: called by 1 (parse_handoff_requested_event); 1 external calls (new).


### `codex-api/src/endpoint/realtime_websocket/methods.rs`

`io_transport` · `realtime connection setup, live message exchange, and close`

A WebSocket is a long-lived network connection where both sides can talk at any time, like a phone call instead of a letter. This file is the client-side phone operator for Codex realtime sessions. It builds the right WebSocket URL, adds headers, connects with TLS security, sends the initial session settings, and then exposes a simple connection object with a sending side and a receiving side.

The lower layer, WsStream, owns the actual socket and runs a background pump task. That task listens for outgoing commands and incoming frames at the same time, so sending audio does not get stuck just because the caller is waiting for the next server event. It also answers WebSocket pings with pongs, which keeps the connection healthy.

RealtimeWebsocketWriter turns higher-level actions, such as appending audio or sending a tool result, into JSON messages and sends them. RealtimeWebsocketEvents reads text frames, parses them into project-level RealtimeEvent values, and updates an active transcript as speech and response text arrive in pieces. When the server asks for a handoff, that transcript snapshot is attached so the next agent has context.

Without this file, realtime voice and text sessions would not have a reliable network bridge, and callers would have to know many protocol details themselves.

#### Function details

##### `WsStream::new`  (lines 67–168)

```
fn new(
        inner: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) -> (Self, async_channel::Receiver<Result<Message, WsError>>)
```

**Purpose**: Creates the internal WebSocket pump that can send outgoing messages and receive incoming messages at the same time. This protects the rest of the code from directly juggling the raw socket.

**Data flow**: It takes an already connected WebSocket stream. It creates a command channel for sends and closes, a message channel for received frames, starts a background task, and returns a WsStream plus the receiving side of the message channel.

**Call relations**: Connection setup calls this after the WebSocket handshake succeeds. From then on, writers hand send and close requests into the pump, while event readers receive frames that the pump forwards.

*Call graph*: called by 2 (connect_realtime_websocket_url, connect_websocket); 3 external calls (info!, select!, spawn).


##### `WsStream::request`  (lines 170–179)

```
async fn request(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<(), WsError>>) -> WsCommand,
    ) -> Result<(), WsError>
```

**Purpose**: Sends one command to the WebSocket pump and waits for the result. It is the shared helper that makes both sending and closing report success or failure back to the caller.

**Data flow**: It receives a small function that builds a command once a reply channel exists. It sends that command to the pump, waits on the one-time reply, and returns either the pump result or a closed-connection error.

**Call relations**: WsStream::send and WsStream::close call this so they do not duplicate the command-and-reply pattern.

*Call graph*: called by 2 (close, send); 2 external calls (send, channel).


##### `WsStream::send`  (lines 181–184)

```
async fn send(&self, message: Message) -> Result<(), WsError>
```

**Purpose**: Queues a WebSocket message to be sent on the live connection. Callers use it when they already have a WebSocket frame ready.

**Data flow**: It takes a WebSocket message, wraps it as a Send command, passes it through WsStream::request, and returns whether the pump successfully wrote it.

**Call relations**: Higher-level send code eventually reaches this through the writer path. It relies on WsStream::request to talk to the background pump.

*Call graph*: calls 1 internal fn (request); called by 1 (send_websocket_request).


##### `WsStream::close`  (lines 186–189)

```
async fn close(&self) -> Result<(), WsError>
```

**Purpose**: Asks the WebSocket pump to close the connection cleanly. This gives the remote server a proper close frame instead of just dropping the socket.

**Data flow**: It builds a Close command, sends it through WsStream::request, and returns the close result from the pump.

**Call relations**: The writer's close path uses this when the public connection is closed.

*Call graph*: calls 1 internal fn (request).


##### `WsStream::drop`  (lines 193–195)

```
fn drop(&mut self)
```

**Purpose**: Stops the background WebSocket pump if the WsStream is destroyed. This prevents a leftover task from running after nobody owns the connection anymore.

**Data flow**: It reads the stored task handle and aborts that task. It does not return a value; it changes the runtime state by stopping the task.

**Call relations**: Rust calls this automatically when WsStream is dropped. It is the final safety net behind explicit close calls.

*Call graph*: 1 external calls (abort).


##### `RealtimeWebsocketConnection::send_audio_frame`  (lines 227–229)

```
async fn send_audio_frame(&self, frame: RealtimeAudioFrame) -> Result<(), ApiError>
```

**Purpose**: Sends one chunk of input audio through the connection. It is a convenient top-level method for callers that do not want to access the writer directly.

**Data flow**: It receives an audio frame, forwards it to the connection's writer, and returns the writer's success or API error.

**Call relations**: Application code calls this on the full connection. The method hands the work to RealtimeWebsocketWriter::send_audio_frame.

*Call graph*: calls 1 internal fn (send_audio_frame).


##### `RealtimeWebsocketConnection::send_conversation_item_create`  (lines 231–237)

```
async fn send_conversation_item_create(
        &self,
        text: String,
        role: ConversationTextRole,
    ) -> Result<(), ApiError>
```

**Purpose**: Adds a text conversation item to the realtime session. This is used for sending developer or user text into the same stream as audio.

**Data flow**: It takes text and a conversation role, passes both to the writer, and returns whether the JSON message was sent.

**Call relations**: It is the connection-level wrapper around RealtimeWebsocketWriter::send_conversation_item_create.

*Call graph*: calls 1 internal fn (send_conversation_item_create).


##### `RealtimeWebsocketConnection::send_conversation_function_call_output`  (lines 239–247)

```
async fn send_conversation_function_call_output(
        &self,
        call_id: String,
        output_text: String,
    ) -> Result<(), ApiError>
```

**Purpose**: Sends the result of a function or background-agent call back to the realtime server. This lets the model continue after a tool-style request is fulfilled.

**Data flow**: It receives a call identifier and output text, forwards them to the writer, and returns the send result.

**Call relations**: It delegates to RealtimeWebsocketWriter::send_conversation_function_call_output, which formats the right protocol message.

*Call graph*: calls 1 internal fn (send_conversation_function_call_output).


##### `RealtimeWebsocketConnection::close`  (lines 249–251)

```
async fn close(&self) -> Result<(), ApiError>
```

**Purpose**: Closes the realtime connection from the public connection object. Callers use this when the session is finished.

**Data flow**: It asks the writer to close the underlying stream and returns either success or an API error.

**Call relations**: This is a simple wrapper over RealtimeWebsocketWriter::close.

*Call graph*: calls 1 internal fn (close).


##### `RealtimeWebsocketConnection::next_event`  (lines 253–255)

```
async fn next_event(&self) -> Result<Option<RealtimeEvent>, ApiError>
```

**Purpose**: Waits for the next meaningful realtime event from the server. It returns none when the stream has ended.

**Data flow**: It asks the event reader for the next parsed event and passes through the result. Incoming raw WebSocket frames are not exposed here.

**Call relations**: Callers use this on the full connection; the method delegates to RealtimeWebsocketEvents::next_event.

*Call graph*: calls 1 internal fn (next_event).


##### `RealtimeWebsocketConnection::writer`  (lines 257–259)

```
fn writer(&self) -> RealtimeWebsocketWriter
```

**Purpose**: Returns a clone of the sending half of the connection. This lets another task send messages while one task is reading events.

**Data flow**: It reads the stored writer, clones its shared references, and returns the clone.

**Call relations**: Code that needs independent sending access calls this instead of owning the whole connection.

*Call graph*: 1 external calls (clone).


##### `RealtimeWebsocketConnection::events`  (lines 261–263)

```
fn events(&self) -> RealtimeWebsocketEvents
```

**Purpose**: Returns a clone of the receiving half of the connection. This lets event-reading code hold just the part it needs.

**Data flow**: It reads the stored events object, clones its shared references, and returns the clone.

**Call relations**: Code that separates reading from writing can call this and then use RealtimeWebsocketEvents::next_event.

*Call graph*: 1 external calls (clone).


##### `RealtimeWebsocketConnection::new`  (lines 265–285)

```
fn new(
        stream: WsStream,
        rx_message: async_channel::Receiver<Result<Message, WsError>>,
        event_parser: RealtimeEventParser,
    ) -> Self
```

**Purpose**: Builds the public connection object from the low-level stream and receive channel. It splits the connection into writer and event-reader pieces that share close state.

**Data flow**: It receives a WsStream, a channel of incoming WebSocket messages, and an event parser choice. It wraps shared data in reference-counted pointers, creates transcript state, and returns a RealtimeWebsocketConnection.

**Call relations**: Connection setup calls this after WsStream::new. The resulting object is returned to the caller after the initial session update is sent.

*Call graph*: called by 1 (connect_realtime_websocket_url); 5 external calls (clone, new, new, new, default).


##### `RealtimeWebsocketWriter::send_audio_frame`  (lines 289–292)

```
async fn send_audio_frame(&self, frame: RealtimeAudioFrame) -> Result<(), ApiError>
```

**Purpose**: Turns an audio frame into the protocol message that appends input audio. This is how microphone data reaches the realtime API.

**Data flow**: It takes the frame's encoded audio data, places it in an InputAudioBufferAppend message, and sends that as JSON.

**Call relations**: The public connection wrapper and user-audio handling code call this. It hands serialization and delivery to send_json.

*Call graph*: calls 1 internal fn (send_json); called by 2 (send_audio_frame, handle_user_audio_input).


##### `RealtimeWebsocketWriter::send_conversation_item_create`  (lines 294–305)

```
async fn send_conversation_item_create(
        &self,
        text: String,
        role: ConversationTextRole,
    ) -> Result<(), ApiError>
```

**Purpose**: Sends a text message into the realtime conversation using the protocol shape required by the selected parser version. This keeps callers from needing to know version-specific JSON details.

**Data flow**: It receives text and a role, asks the common helper to build the right outbound message, then sends it as JSON.

**Call relations**: Connection wrappers and text or handoff handlers call this. It relies on conversation_item_create_message for protocol formatting and send_json for delivery.

*Call graph*: calls 2 internal fn (send_json, conversation_item_create_message); called by 3 (send_conversation_item_create, handle_handoff_output, handle_text_input).


##### `RealtimeWebsocketWriter::send_conversation_handoff_append`  (lines 307–317)

```
async fn send_conversation_handoff_append(
        &self,
        handoff_id: String,
        output_text: String,
    ) -> Result<(), ApiError>
```

**Purpose**: Appends background-agent output to an existing handoff. This is used when a delegated task reports text back into the realtime session.

**Data flow**: It receives a handoff id and output text, creates a ConversationHandoffAppend message, and sends it as JSON.

**Call relations**: Handoff output handling calls this when the server protocol expects a handoff append message.

*Call graph*: calls 1 internal fn (send_json); called by 1 (handle_handoff_output).


##### `RealtimeWebsocketWriter::send_conversation_function_call_output`  (lines 319–330)

```
async fn send_conversation_function_call_output(
        &self,
        call_id: String,
        output_text: String,
    ) -> Result<(), ApiError>
```

**Purpose**: Sends a function-call result back to the realtime server. In newer realtime flows, handoffs are represented as function calls, so this supplies their answer.

**Data flow**: It takes a call id and output text, builds the version-appropriate message with a helper, and sends the JSON payload.

**Call relations**: The connection wrapper, handoff output handling, and realtime server event handling call this. Formatting is delegated to conversation_function_call_output_message.

*Call graph*: calls 2 internal fn (send_json, conversation_function_call_output_message); called by 3 (send_conversation_function_call_output, handle_handoff_output, handle_realtime_server_event).


##### `RealtimeWebsocketWriter::send_response_create`  (lines 332–335)

```
async fn send_response_create(&self) -> Result<(), ApiError>
```

**Purpose**: Asks the realtime server to create a response now. This is useful when the client wants to trigger output explicitly.

**Data flow**: It creates a ResponseCreate outbound message and sends it as JSON.

**Call relations**: The send_create_now flow calls this. It uses send_json like the other writer methods.

*Call graph*: calls 1 internal fn (send_json); called by 1 (send_create_now).


##### `RealtimeWebsocketWriter::send_session_update`  (lines 337–354)

```
async fn send_session_update(
        &self,
        instructions: String,
        session_mode: RealtimeSessionMode,
        output_modality: RealtimeOutputModality,
        voice: RealtimeVoice,
```

**Purpose**: Sends the initial or updated session settings, such as instructions, mode, output type, and voice. This tells the server what kind of realtime session to run.

**Data flow**: It receives the desired settings, normalizes the session mode for the protocol version, builds a session object, wraps it in a SessionUpdate message, and sends it as JSON.

**Call relations**: Connection setup calls this immediately after connecting. It uses common helpers for protocol-specific session shape and send_json for delivery.

*Call graph*: calls 3 internal fn (send_json, normalized_session_mode, session_update_session).


##### `RealtimeWebsocketWriter::close`  (lines 356–368)

```
async fn close(&self) -> Result<(), ApiError>
```

**Purpose**: Closes the writer and marks the connection as closed. It is careful to make repeated close calls harmless.

**Data flow**: It checks and sets a shared closed flag. If this is the first close, it asks the stream to close and converts unexpected WebSocket errors into API errors.

**Call relations**: RealtimeWebsocketConnection::close calls this. It uses the underlying WsStream close command to reach the pump.

*Call graph*: called by 1 (close); 3 external calls (Stream, format!, matches!).


##### `RealtimeWebsocketWriter::send_json`  (lines 370–375)

```
async fn send_json(&self, message: &RealtimeOutboundMessage) -> Result<(), ApiError>
```

**Purpose**: Serializes a high-level outbound realtime message into JSON text. This is the common path for all structured messages sent to the server.

**Data flow**: It receives a RealtimeOutboundMessage, converts it to a JSON string, logs the request at debug level, and passes the string to send_payload.

**Call relations**: All typed writer send methods use this. It hands the final text to RealtimeWebsocketWriter::send_payload.

*Call graph*: calls 1 internal fn (send_payload); called by 6 (send_audio_frame, send_conversation_function_call_output, send_conversation_handoff_append, send_conversation_item_create, send_response_create, send_session_update); 2 external calls (debug!, to_string).


##### `RealtimeWebsocketWriter::send_payload`  (lines 377–390)

```
async fn send_payload(&self, payload: String) -> Result<(), ApiError>
```

**Purpose**: Sends a raw text payload over the WebSocket. This is the lowest public writer layer before the WsStream pump.

**Data flow**: It checks whether the shared closed flag is set. If open, it wraps the string as a WebSocket text message, sends it through the stream, and returns success or an API error.

**Call relations**: send_json calls this for normal protocol messages, and realtime event handling can call it when it already has a raw payload.

*Call graph*: called by 2 (send_json, handle_realtime_server_event); 3 external calls (Stream, trace!, Text).


##### `RealtimeWebsocketEvents::next_event`  (lines 394–443)

```
async fn next_event(&self) -> Result<Option<RealtimeEvent>, ApiError>
```

**Purpose**: Reads incoming WebSocket frames until it finds a supported realtime event. It hides raw WebSocket details from the rest of the application.

**Data flow**: It checks whether the connection is closed, waits for a message from the pump, parses text frames into RealtimeEvent values, updates transcript state, and returns the next event. Errors or close frames mark the connection closed.

**Call relations**: RealtimeWebsocketConnection::next_event calls this. It uses parse_realtime_event for protocol parsing and update_active_transcript to keep handoff context current.

*Call graph*: calls 3 internal fn (update_active_transcript, parse_realtime_event, recv); called by 1 (next_event); 7 external calls (Stream, debug!, error!, format!, info!, Error, trace!).


##### `RealtimeWebsocketEvents::update_active_transcript`  (lines 445–507)

```
async fn update_active_transcript(&self, event: &mut RealtimeEvent)
```

**Purpose**: Maintains a running transcript of the current conversation as input and output text arrives. This is especially important because handoff events need a clean slice of recent context.

**Data flow**: It receives a parsed event by mutable reference, locks the transcript state, and updates entries based on transcript deltas, completed transcript text, response starts, speech starts, and handoff requests. For handoff requests, it also writes the active transcript back into the event.

**Call relations**: next_event calls this after parsing each event. It uses small transcript helper functions to append, replace, and avoid duplicate handoff input.

*Call graph*: calls 3 internal fn (append_handoff_input, append_transcript_delta, apply_transcript_done); called by 1 (next_event).


##### `append_transcript_delta`  (lines 510–532)

```
fn append_transcript_delta(
    entries: &mut Vec<RealtimeTranscriptEntry>,
    role: &str,
    delta: &str,
    force_new: bool,
)
```

**Purpose**: Adds a small piece of transcript text to the running transcript. It joins the piece to the previous entry when it belongs to the same speaker.

**Data flow**: It receives the transcript entries, a role such as user or assistant, a text delta, and a force-new flag. Empty deltas are ignored; otherwise the delta is appended to the last matching role entry or starts a new entry.

**Call relations**: update_active_transcript calls this for input and output transcript delta events.

*Call graph*: called by 1 (update_active_transcript).


##### `apply_transcript_done`  (lines 534–556)

```
fn apply_transcript_done(
    entries: &mut Vec<RealtimeTranscriptEntry>,
    role: &str,
    text: &str,
    force_new: bool,
)
```

**Purpose**: Applies a finished transcript line to the running transcript. This can replace earlier partial text with the final version.

**Data flow**: It receives entries, role, final text, and a force-new flag. Empty text is ignored; otherwise it replaces the last same-role entry or appends a new entry.

**Call relations**: update_active_transcript calls this when the server reports that input or output transcription is done.

*Call graph*: called by 1 (update_active_transcript).


##### `append_handoff_input`  (lines 558–568)

```
fn append_handoff_input(entries: &mut Vec<RealtimeTranscriptEntry>, input: &str)
```

**Purpose**: Adds the handoff input text to the transcript if it is not already present. This prevents the delegated prompt from being lost or duplicated.

**Data flow**: It trims the input, checks for an existing matching user entry, and appends a new user transcript entry only when needed.

**Call relations**: update_active_transcript calls this when a handoff is requested. It uses contains_transcript_entry to detect duplicates.

*Call graph*: calls 1 internal fn (contains_transcript_entry); called by 1 (update_active_transcript).


##### `contains_transcript_entry`  (lines 570–574)

```
fn contains_transcript_entry(entries: &[RealtimeTranscriptEntry], role: &str, text: &str) -> bool
```

**Purpose**: Checks whether the transcript already contains a specific role and text. It is a small guard against duplicate transcript entries.

**Data flow**: It receives the transcript list, a role, and text. It scans the entries, comparing roles and trimmed text, and returns true if a match is found.

**Call relations**: append_handoff_input calls this before adding handoff input.

*Call graph*: called by 1 (append_handoff_input); 1 external calls (iter).


##### `RealtimeWebsocketClient::new`  (lines 581–583)

```
fn new(provider: Provider) -> Self
```

**Purpose**: Creates a realtime WebSocket client tied to a provider configuration. The provider supplies the base URL, headers, retry settings, and other connection details.

**Data flow**: It receives a Provider and stores it in a new RealtimeWebsocketClient.

**Call relations**: Production setup and many tests create clients with this method before calling connect or sideband connection methods.

*Call graph*: called by 12 (e2e_connect_and_exchange_events_against_mock_ws_server, realtime_v2_session_update_includes_background_agent_tool_and_handoff_output_item, send_does_not_block_while_next_event_waits_for_inbound_data, transcription_mode_session_update_omits_output_audio_and_instructions, v1_transcription_mode_is_treated_as_conversational, realtime_ws_connect_webrtc_sideband_retries_join_until_server_is_available, realtime_ws_e2e_disconnected_emitted_once, realtime_ws_e2e_ignores_unknown_text_events, realtime_ws_e2e_realtime_v2_parser_emits_handoff_requested, realtime_ws_e2e_send_while_next_event_waits (+2 more)).


##### `RealtimeWebsocketClient::connect`  (lines 585–600)

```
async fn connect(
        &self,
        config: RealtimeSessionConfig,
        extra_headers: HeaderMap,
        default_headers: HeaderMap,
    ) -> Result<RealtimeWebsocketConnection, ApiError>
```

**Purpose**: Starts a normal realtime WebSocket session. It builds the correct realtime URL and then opens the connection.

**Data flow**: It receives session config plus extra and default headers. It turns the provider API URL into a WebSocket URL, then calls connect_realtime_websocket_url and returns the ready connection.

**Call relations**: Application code calls this for standalone realtime sessions. URL building is handled by websocket_url_from_api_url.

*Call graph*: calls 2 internal fn (connect_realtime_websocket_url, websocket_url_from_api_url).


##### `RealtimeWebsocketClient::connect_webrtc_sideband`  (lines 602–640)

```
async fn connect_webrtc_sideband(
        &self,
        config: RealtimeSessionConfig,
        call_id: &str,
        extra_headers: HeaderMap,
        default_headers: HeaderMap,
    ) -> Result<Rea
```

**Purpose**: Joins the control WebSocket for an already existing WebRTC realtime call. It retries because the sideband socket may not be ready at the exact moment the call is created.

**Data flow**: It receives session config, a call id, and headers. It repeatedly calls connect_webrtc_sideband_once, waits with backoff after retryable failures, and returns either the connection or the final error.

**Call relations**: WebRTC sideband flows call this. Each attempt delegates the real connection work to connect_webrtc_sideband_once.

*Call graph*: calls 1 internal fn (connect_webrtc_sideband_once); 6 external calls (clone, clone, Stream, backoff, sleep, warn!).


##### `RealtimeWebsocketClient::connect_webrtc_sideband_once`  (lines 642–660)

```
async fn connect_webrtc_sideband_once(
        &self,
        config: RealtimeSessionConfig,
        call_id: &str,
        extra_headers: HeaderMap,
        default_headers: HeaderMap,
    ) -> Resul
```

**Purpose**: Makes one attempt to join a WebRTC sideband WebSocket. It does not retry by itself.

**Data flow**: It receives config, call id, and headers. It builds a WebSocket URL with the call_id query parameter and calls connect_realtime_websocket_url.

**Call relations**: connect_webrtc_sideband calls this inside its retry loop. URL construction is handled by websocket_url_from_api_url_for_call.

*Call graph*: calls 2 internal fn (connect_realtime_websocket_url, websocket_url_from_api_url_for_call); called by 1 (connect_webrtc_sideband).


##### `RealtimeWebsocketClient::connect_realtime_websocket_url`  (lines 662–718)

```
async fn connect_realtime_websocket_url(
        &self,
        ws_url: Url,
        config: RealtimeSessionConfig,
        extra_headers: HeaderMap,
        default_headers: HeaderMap,
    ) -> Resul
```

**Purpose**: Performs the actual WebSocket connection and sends the first session update. This is the central setup routine shared by normal and sideband connections.

**Data flow**: It receives a WebSocket URL, session config, and headers. It prepares TLS, builds the request, merges headers, connects, wraps the socket in WsStream and RealtimeWebsocketConnection, sends session.update, and returns the ready connection.

**Call relations**: connect and connect_webrtc_sideband_once both call this. It uses helpers for headers, WebSocket config, TLS setup, stream pumping, and session update sending.

*Call graph*: calls 5 internal fn (new, new, merge_request_headers, websocket_config, with_session_id_header); called by 2 (connect, connect_webrtc_sideband_once); 6 external calls (as_str, maybe_build_rustls_client_config_with_custom_ca, ensure_rustls_crypto_provider, debug!, info!, connect_async_tls_with_config).


##### `merge_request_headers`  (lines 721–734)

```
fn merge_request_headers(
    provider_headers: &HeaderMap,
    extra_headers: HeaderMap,
    default_headers: HeaderMap,
) -> HeaderMap
```

**Purpose**: Combines provider, extra, and default HTTP headers with clear priority. This ensures required defaults are present without overwriting more specific caller choices.

**Data flow**: It starts with provider headers, overlays extra headers, then fills in any missing default headers. The returned map is what gets attached to the WebSocket request.

**Call relations**: connect_realtime_websocket_url calls this while building the request, and a test checks the priority rules.

*Call graph*: called by 2 (connect_realtime_websocket_url, merge_request_headers_matches_http_precedence); 1 external calls (clone).


##### `with_session_id_header`  (lines 736–750)

```
fn with_session_id_header(
    mut headers: HeaderMap,
    session_id: Option<&str>,
) -> Result<HeaderMap, ApiError>
```

**Purpose**: Adds an x-session-id header when the session config includes a session id. This lets the server associate the WebSocket with a known conversation/session.

**Data flow**: It receives headers and an optional session id. If absent, it returns the headers unchanged; if present, it validates the value as an HTTP header and inserts it.

**Call relations**: connect_realtime_websocket_url calls this before merging headers.

*Call graph*: called by 1 (connect_realtime_websocket_url); 2 external calls (insert, from_str).


##### `websocket_config`  (lines 752–754)

```
fn websocket_config() -> WebSocketConfig
```

**Purpose**: Provides the WebSocket library configuration used for realtime connections. Currently it uses the library defaults.

**Data flow**: It creates and returns a default WebSocketConfig value.

**Call relations**: connect_realtime_websocket_url passes this config into the WebSocket connect call.

*Call graph*: called by 1 (connect_realtime_websocket_url); 1 external calls (default).


##### `websocket_url_from_api_url`  (lines 756–806)

```
fn websocket_url_from_api_url(
    api_url: &str,
    query_params: Option<&HashMap<String, String>>,
    model: Option<&str>,
    event_parser: RealtimeEventParser,
    _session_mode: RealtimeSession
```

**Purpose**: Converts a provider API URL into the realtime WebSocket URL the server expects. It fixes the scheme, path, and query parameters.

**Data flow**: It parses the API URL, normalizes the path to the realtime endpoint, changes http/https to ws/wss, adds intent/model/extra query parameters when needed, and returns the final URL or an API error.

**Call relations**: RealtimeWebsocketClient::connect calls this, and the sideband URL helper builds on it. Several tests cover its edge cases.

*Call graph*: calls 2 internal fn (normalize_realtime_path, websocket_intent); called by 10 (connect, websocket_url_from_http_base_defaults_to_ws_path, websocket_url_from_nested_v1_base_appends_realtime_path, websocket_url_from_v1_base_appends_realtime_path, websocket_url_from_ws_base_defaults_to_ws_path, websocket_url_omits_intent_for_realtime_v2_conversational_mode, websocket_url_omits_intent_for_realtime_v2_transcription_mode, websocket_url_preserves_existing_realtime_path_and_extra_query_params, websocket_url_v1_ignores_transcription_mode, websocket_url_from_api_url_for_call); 3 external calls (parse, Stream, format!).


##### `websocket_url_from_api_url_for_call`  (lines 808–824)

```
fn websocket_url_from_api_url_for_call(
    api_url: &str,
    query_params: Option<&HashMap<String, String>>,
    event_parser: RealtimeEventParser,
    session_mode: RealtimeSessionMode,
    call_id
```

**Purpose**: Builds a realtime WebSocket URL that joins an existing call by call id. This is for WebRTC sideband control connections.

**Data flow**: It first builds the normal realtime WebSocket URL without a model, then appends call_id as a query parameter.

**Call relations**: connect_webrtc_sideband_once calls this before opening the sideband connection, and a test verifies the resulting URL.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); called by 2 (connect_webrtc_sideband_once, websocket_url_for_call_id_joins_existing_realtime_session).


##### `normalize_realtime_path`  (lines 826–850)

```
fn normalize_realtime_path(url: &mut Url)
```

**Purpose**: Adjusts a base URL path so it points at the realtime endpoint. This lets provider configuration use either a root URL or a /v1 URL.

**Data flow**: It reads the URL path and rewrites empty, root, /v1, or /v1/ paths to include /realtime. Existing realtime paths are kept, with a trailing slash removed when needed.

**Call relations**: websocket_url_from_api_url calls this before changing schemes and adding query parameters.

*Call graph*: called by 1 (websocket_url_from_api_url); 3 external calls (path, set_path, format!).


##### `tests::parse_session_updated_event`  (lines 876–890)

```
fn parse_session_updated_event()
```

**Purpose**: Checks that a session.updated JSON payload becomes the expected SessionUpdated event. This protects the basic session-start response parsing.

**Data flow**: The test builds sample JSON, parses it with the V1 parser, and compares the parsed event to the expected id and instructions.

**Call relations**: The test runner calls this. It exercises parse_realtime_event from the protocol layer.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_audio_delta_event`  (lines 893–912)

```
fn parse_audio_delta_event()
```

**Purpose**: Checks that an audio delta event is parsed into an outgoing audio frame for playback. It verifies sample rate, channel count, and audio data.

**Data flow**: The test creates JSON with base64 audio and audio shape metadata, parses it, and compares the result to the expected AudioOut event.

**Call relations**: The test runner calls this to validate protocol parsing used later by RealtimeWebsocketEvents::next_event.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_conversation_item_added_event`  (lines 915–927)

```
fn parse_conversation_item_added_event()
```

**Purpose**: Checks that a conversation item added message is preserved as a ConversationItemAdded event. This keeps raw item details available to callers.

**Data flow**: The test supplies JSON containing an item object, parses it, and asserts that the item JSON appears in the event.

**Call relations**: The test runner calls this as part of parser coverage.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_conversation_item_done_event`  (lines 930–942)

```
fn parse_conversation_item_done_event()
```

**Purpose**: Checks that a completed conversation item reports its item id. This lets callers know which item finished.

**Data flow**: The test builds a conversation.item.done JSON payload, parses it, and verifies the resulting ConversationItemDone item_id.

**Call relations**: The test runner calls this to cover item completion parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_handoff_requested_event`  (lines 945–963)

```
fn parse_handoff_requested_event()
```

**Purpose**: Checks that a handoff request event is parsed correctly. This is important because handoffs start background-agent work.

**Data flow**: The test builds JSON with handoff id, item id, and input transcript, parses it, and expects a HandoffRequested event with an empty active transcript before event-layer enrichment.

**Call relations**: The test runner calls this. Later runtime code may add active transcript data in update_active_transcript.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_input_transcript_delta_event`  (lines 966–981)

```
fn parse_input_transcript_delta_event()
```

**Purpose**: Checks that an input transcript fragment is parsed as a user transcript delta. This supports live transcription while the user speaks.

**Data flow**: The test creates a JSON delta, parses it, and compares it to an InputTranscriptDelta event.

**Call relations**: The test runner calls this to cover V1 transcript delta parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_input_audio_transcription_delta_event`  (lines 984–1001)

```
fn parse_v1_input_audio_transcription_delta_event()
```

**Purpose**: Checks that the V1 input audio transcription delta event name is accepted. This protects compatibility with a more specific server event shape.

**Data flow**: The test supplies JSON with item metadata and a transcript delta, parses it, and expects the same InputTranscriptDelta event type.

**Call relations**: The test runner calls this as part of parser compatibility coverage.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_input_audio_transcription_completed_event`  (lines 1004–1019)

```
fn parse_v1_input_audio_transcription_completed_event()
```

**Purpose**: Checks that a completed V1 input audio transcription becomes an InputTranscriptDone event. This confirms final transcript text replaces or completes partial text.

**Data flow**: The test builds completion JSON with a transcript field, parses it, and compares the result to the expected done event.

**Call relations**: The test runner calls this to verify final input transcript parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_input_transcript_turn_marked_event`  (lines 1022–1035)

```
fn parse_v1_input_transcript_turn_marked_event()
```

**Purpose**: Checks that a V1 turn-marked transcript is treated as completed input text. This covers another server way of saying the user's turn text is finalized.

**Data flow**: The test builds a turn_marked JSON payload, parses it, and expects InputTranscriptDone with the transcript text.

**Call relations**: The test runner calls this to guard V1 event-name compatibility.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_output_transcript_delta_event`  (lines 1038–1053)

```
fn parse_output_transcript_delta_event()
```

**Purpose**: Checks that assistant transcript fragments are parsed correctly. This supports displaying or tracking the response as it streams.

**Data flow**: The test creates output transcript delta JSON, parses it, and expects OutputTranscriptDelta.

**Call relations**: The test runner calls this to cover assistant transcript parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_output_audio_transcript_delta_event`  (lines 1056–1071)

```
fn parse_v1_output_audio_transcript_delta_event()
```

**Purpose**: Checks that a V1 output audio transcript delta maps to an assistant transcript delta. This keeps audio-response captions working.

**Data flow**: The test builds response.output_audio_transcript.delta JSON, parses it, and compares the result to OutputTranscriptDelta.

**Call relations**: The test runner calls this as parser compatibility coverage.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_output_audio_transcript_done_event`  (lines 1074–1089)

```
fn parse_v1_output_audio_transcript_done_event()
```

**Purpose**: Checks that a completed V1 output audio transcript maps to final assistant text. This protects final caption handling for spoken responses.

**Data flow**: The test creates JSON with a final transcript, parses it, and expects OutputTranscriptDone.

**Call relations**: The test runner calls this to verify final output transcript parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_item_done_output_text_event`  (lines 1092–1113)

```
fn parse_v1_item_done_output_text_event()
```

**Purpose**: Checks that a completed V1 assistant message with output text is still reported as an item completion. The parser does not turn this particular payload into transcript text here.

**Data flow**: The test supplies a message item with two output_text parts, parses it, and expects ConversationItemDone with the item id.

**Call relations**: The test runner calls this to document and protect item-done behavior.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_handoff_tool_call_event`  (lines 1116–1138)

```
fn parse_realtime_v2_handoff_tool_call_event()
```

**Purpose**: Checks that a Realtime V2 background_agent function call becomes a handoff request. This is how newer realtime sessions ask Codex to delegate work.

**Data flow**: The test builds a function_call item with JSON arguments containing a prompt, parses it with the RealtimeV2 parser, and expects HandoffRequested.

**Call relations**: The test runner calls this to verify V2 tool-call parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_noop_tool_call_event`  (lines 1141–1161)

```
fn parse_realtime_v2_noop_tool_call_event()
```

**Purpose**: Checks that a Realtime V2 remain_silent function call becomes a no-op request. This lets the model explicitly choose not to speak.

**Data flow**: The test builds a remain_silent function_call item, parses it, and expects NoopRequested with the call and item ids.

**Call relations**: The test runner calls this to cover a special V2 tool call.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_input_audio_transcription_delta_event`  (lines 1164–1181)

```
fn parse_realtime_v2_input_audio_transcription_delta_event()
```

**Purpose**: Checks that V2 input transcription deltas are parsed as input transcript deltas. This keeps live user transcription working in the V2 protocol.

**Data flow**: The test supplies V2-style transcription delta JSON, parses it, and checks for InputTranscriptDelta.

**Call relations**: The test runner calls this as part of V2 parser coverage.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_output_audio_transcript_done_event`  (lines 1184–1199)

```
fn parse_realtime_v2_output_audio_transcript_done_event()
```

**Purpose**: Checks that a V2 completed output audio transcript becomes final assistant text. This protects spoken-response transcript completion.

**Data flow**: The test builds response.output_audio_transcript.done JSON, parses it with the V2 parser, and expects OutputTranscriptDone.

**Call relations**: The test runner calls this to cover V2 output transcript parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_output_text_done_event`  (lines 1202–1217)

```
fn parse_realtime_v2_output_text_done_event()
```

**Purpose**: Checks that a V2 completed output text event becomes final assistant text. This covers text-output sessions as well as audio-caption sessions.

**Data flow**: The test creates response.output_text.done JSON, parses it, and expects OutputTranscriptDone.

**Call relations**: The test runner calls this to verify V2 text completion parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_conversation_item_created_event`  (lines 1220–1233)

```
fn parse_realtime_v2_conversation_item_created_event()
```

**Purpose**: Checks that a V2 conversation.item.created payload becomes a ConversationItemAdded event. This keeps item creation notifications available.

**Data flow**: The test builds JSON with a user message item, parses it, and expects the item JSON inside ConversationItemAdded.

**Call relations**: The test runner calls this to cover V2 item creation parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_item_done_output_text_event`  (lines 1236–1257)

```
fn parse_realtime_v2_item_done_output_text_event()
```

**Purpose**: Checks that V2 item completion for an assistant message reports the item id. This matches the V1 behavior tested separately.

**Data flow**: The test builds a completed assistant message with output text parts, parses it with the V2 parser, and expects ConversationItemDone.

**Call relations**: The test runner calls this to protect V2 item-done behavior.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_output_audio_delta_defaults_audio_shape`  (lines 1260–1277)

```
fn parse_realtime_v2_output_audio_delta_defaults_audio_shape()
```

**Purpose**: Checks that a V2 audio delta without explicit audio metadata gets safe default audio settings. This prevents missing fields from breaking playback handling.

**Data flow**: The test supplies JSON with only an audio delta, parses it, and expects AudioOut with 24 kHz mono defaults.

**Call relations**: The test runner calls this to verify fallback behavior in audio parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_audio_delta_with_item_id`  (lines 1280–1298)

```
fn parse_realtime_v2_response_audio_delta_with_item_id()
```

**Purpose**: Checks that a V2 response audio delta keeps its item id. This lets callers associate audio chunks with the response item they belong to.

**Data flow**: The test builds response.audio.delta JSON with an item_id, parses it, and expects AudioOut containing that item id.

**Call relations**: The test runner calls this to cover item-linked audio parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_speech_started_event`  (lines 1301–1316)

```
fn parse_realtime_v2_speech_started_event()
```

**Purpose**: Checks that V2 speech-start events are parsed with their optional item id. This helps the transcript state know when a new user utterance begins.

**Data flow**: The test builds input_audio_buffer.speech_started JSON, parses it, and expects InputAudioSpeechStarted with the item id.

**Call relations**: The test runner calls this to verify speech-start parsing used by update_active_transcript.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_cancelled_event`  (lines 1319–1334)

```
fn parse_realtime_v2_response_cancelled_event()
```

**Purpose**: Checks that V2 response cancellation events include the response id when present. This lets callers identify which response stopped.

**Data flow**: The test creates response.cancelled JSON, parses it, and expects RealtimeResponseCancelled with the response id.

**Call relations**: The test runner calls this to cover cancellation parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_done_event`  (lines 1337–1358)

```
fn parse_realtime_v2_response_done_event()
```

**Purpose**: Checks that V2 response.done parses as a response completion event even when output contains a function call. This keeps completion signaling separate from tool-call extraction here.

**Data flow**: The test builds response.done JSON with a function_call output item, parses it, and expects ResponseDone.

**Call relations**: The test runner calls this to document response-done parsing behavior.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_created_event`  (lines 1361–1374)

```
fn parse_realtime_v2_response_created_event()
```

**Purpose**: Checks that V2 response.created events include the response id. This helps track when a new server response begins.

**Data flow**: The test creates response.created JSON, parses it, and expects ResponseCreated with the id.

**Call relations**: The test runner calls this to cover response-created parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::merge_request_headers_matches_http_precedence`  (lines 1377–1407)

```
fn merge_request_headers_matches_http_precedence()
```

**Purpose**: Checks that header merging gives extra headers priority over provider headers, and provider headers priority over defaults. This prevents accidental overwrites of important request headers.

**Data flow**: The test builds three header maps with overlapping keys, calls merge_request_headers, and asserts the final values match the intended priority.

**Call relations**: The test runner calls this to validate the helper used during WebSocket connection setup.

*Call graph*: calls 1 internal fn (merge_request_headers); 3 external calls (new, from_static, assert_eq!).


##### `tests::websocket_url_from_http_base_defaults_to_ws_path`  (lines 1410–1423)

```
fn websocket_url_from_http_base_defaults_to_ws_path()
```

**Purpose**: Checks that an http base URL becomes a ws realtime URL with the default realtime path. This supports local or non-TLS test providers.

**Data flow**: The test passes an http URL into websocket_url_from_api_url and compares the string result to the expected ws URL.

**Call relations**: The test runner calls this to protect URL-building behavior used by RealtimeWebsocketClient::connect.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_from_ws_base_defaults_to_ws_path`  (lines 1426–1439)

```
fn websocket_url_from_ws_base_defaults_to_ws_path()
```

**Purpose**: Checks that an existing wss base URL gets the realtime path and model query parameter. This supports providers that already supply a WebSocket scheme.

**Data flow**: The test builds a URL with a model value and verifies the resulting wss realtime URL.

**Call relations**: The test runner calls this to cover WebSocket-scheme inputs to websocket_url_from_api_url.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_from_v1_base_appends_realtime_path`  (lines 1442–1455)

```
fn websocket_url_from_v1_base_appends_realtime_path()
```

**Purpose**: Checks that a standard /v1 API URL becomes /v1/realtime. This lets normal OpenAI-style base URLs work without special configuration.

**Data flow**: The test passes a /v1 HTTPS URL and model, then asserts the final wss URL includes /v1/realtime and query parameters.

**Call relations**: The test runner calls this to protect path normalization.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_from_nested_v1_base_appends_realtime_path`  (lines 1458–1471)

```
fn websocket_url_from_nested_v1_base_appends_realtime_path()
```

**Purpose**: Checks that a nested path ending in /v1 also gets /realtime appended. This supports proxy or gateway URLs with prefixes.

**Data flow**: The test passes a nested /openai/v1 URL, builds the WebSocket URL, and checks the expected nested /realtime path.

**Call relations**: The test runner calls this to cover normalize_realtime_path through websocket_url_from_api_url.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_preserves_existing_realtime_path_and_extra_query_params`  (lines 1474–1490)

```
fn websocket_url_preserves_existing_realtime_path_and_extra_query_params()
```

**Purpose**: Checks that an already realtime URL keeps its path and existing query, while adding allowed extra query parameters. It also verifies duplicate intent values are skipped.

**Data flow**: The test supplies a realtime URL with an existing query and provider query params, builds the final URL, and compares the exact result.

**Call relations**: The test runner calls this to validate query merging behavior in websocket_url_from_api_url.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 2 external calls (from, assert_eq!).


##### `tests::websocket_url_v1_ignores_transcription_mode`  (lines 1493–1506)

```
fn websocket_url_v1_ignores_transcription_mode()
```

**Purpose**: Checks that the older V1 parser still uses the V1 intent even if transcription mode is requested. This documents compatibility behavior.

**Data flow**: The test builds a URL using V1 plus transcription mode and expects the same quicksilver intent URL as conversational mode.

**Call relations**: The test runner calls this to protect V1-specific URL behavior.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_omits_intent_for_realtime_v2_conversational_mode`  (lines 1509–1525)

```
fn websocket_url_omits_intent_for_realtime_v2_conversational_mode()
```

**Purpose**: Checks that Realtime V2 conversational URLs do not add the older intent query parameter. This prevents sending stale protocol hints to V2 servers.

**Data flow**: The test supplies a URL and extra query params, builds a V2 URL with a model, and verifies intent is omitted while other values remain.

**Call relations**: The test runner calls this to validate websocket_intent behavior as used by websocket_url_from_api_url.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 2 external calls (from, assert_eq!).


##### `tests::websocket_url_omits_intent_for_realtime_v2_transcription_mode`  (lines 1528–1538)

```
fn websocket_url_omits_intent_for_realtime_v2_transcription_mode()
```

**Purpose**: Checks that Realtime V2 transcription URLs can be plain realtime URLs with no intent. This matches the newer protocol shape.

**Data flow**: The test builds a V2 transcription URL from a base HTTPS URL and verifies the final wss realtime URL has no query string.

**Call relations**: The test runner calls this to guard V2 transcription URL behavior.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_for_call_id_joins_existing_realtime_session`  (lines 1541–1554)

```
fn websocket_url_for_call_id_joins_existing_realtime_session()
```

**Purpose**: Checks that sideband URL construction appends call_id. This is how the WebSocket joins an existing WebRTC session.

**Data flow**: The test calls websocket_url_from_api_url_for_call with a call id and compares the final URL to the expected call_id query URL.

**Call relations**: The test runner calls this to validate the helper used by connect_webrtc_sideband_once.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url_for_call); 1 external calls (assert_eq!).


##### `tests::e2e_connect_and_exchange_events_against_mock_ws_server`  (lines 1557–1855)

```
async fn e2e_connect_and_exchange_events_against_mock_ws_server()
```

**Purpose**: Runs a small end-to-end test against a mock WebSocket server. It proves connection setup, initial session.update, sends, receives, and handoff transcript enrichment work together.

**Data flow**: The test starts a local server, connects a client, checks outgoing JSON messages, sends server events back, reads parsed events, and verifies the final handoff event includes recent transcript entries.

**Call relations**: The test runner calls this. It exercises RealtimeWebsocketClient::new, connect, writer methods, next_event, transcript tracking, and close as one flow.

*Call graph*: calls 1 internal fn (new); 12 external calls (from_millis, from_secs, new, new, bind, assert_eq!, format!, json!, from_str, spawn (+2 more)).


##### `tests::realtime_v2_session_update_includes_background_agent_tool_and_handoff_output_item`  (lines 1858–2067)

```
async fn realtime_v2_session_update_includes_background_agent_tool_and_handoff_output_item()
```

**Purpose**: Checks that Realtime V2 session setup includes the expected audio settings and tools, and that handoff output is sent as a function-call output item. This protects the V2 tool-based handoff contract.

**Data flow**: The test runs a mock server, inspects the first session.update message, sends a session.updated event, then checks client-sent text and function-call output messages.

**Call relations**: The test runner calls this to exercise connect, send_conversation_item_create, send_conversation_function_call_output, and close in a V2 session.

*Call graph*: calls 1 internal fn (new); 12 external calls (from_millis, from_secs, new, new, bind, assert_eq!, format!, json!, from_str, spawn (+2 more)).


##### `tests::transcription_mode_session_update_omits_output_audio_and_instructions`  (lines 2070–2181)

```
async fn transcription_mode_session_update_omits_output_audio_and_instructions()
```

**Purpose**: Checks that V2 transcription mode configures input transcription only, without output audio, instructions, or tools. This prevents transcription-only sessions from behaving like full conversations.

**Data flow**: The test starts a mock server, connects with transcription mode, verifies the initial session.update fields, sends a session.updated event, and confirms audio append still works.

**Call relations**: The test runner calls this to cover connect and send_audio_frame behavior for transcription mode.

*Call graph*: calls 1 internal fn (new); 13 external calls (from_millis, from_secs, new, new, bind, assert!, assert_eq!, format!, json!, from_str (+3 more)).


##### `tests::v1_transcription_mode_is_treated_as_conversational`  (lines 2184–2274)

```
async fn v1_transcription_mode_is_treated_as_conversational()
```

**Purpose**: Checks that V1 treats requested transcription mode as the older conversational quicksilver session. This documents the compatibility fallback.

**Data flow**: The test connects to a mock server using V1 plus transcription mode, inspects the session.update message, receives session.updated, and closes.

**Call relations**: The test runner calls this to verify normalized session mode behavior through the real connection path.

*Call graph*: calls 1 internal fn (new); 13 external calls (from_millis, from_secs, new, new, bind, assert!, assert_eq!, format!, json!, from_str (+3 more)).


##### `tests::send_does_not_block_while_next_event_waits_for_inbound_data`  (lines 2277–2380)

```
async fn send_does_not_block_while_next_event_waits_for_inbound_data()
```

**Purpose**: Checks that sending can proceed while another task is waiting for incoming data. This protects the design goal of the WebSocket pump.

**Data flow**: The test connects to a mock server, starts sending audio and waiting for the next event at the same time, verifies the send completes quickly, then verifies the later incoming event is parsed.

**Call relations**: The test runner calls this to exercise WsStream::new's concurrent pump behavior through the public connection API.

*Call graph*: calls 1 internal fn (new); 13 external calls (from_millis, from_secs, new, new, bind, assert_eq!, format!, json!, from_str, join! (+3 more)).


### Realtime session runtimes
These files execute live realtime conversations by bridging the websocket/WebRTC transports into session-level runtime behavior and native WebRTC handling.

### `core/src/realtime_conversation.rs`

`orchestration` · `request handling and realtime session main loop`

This file is the control room for realtime conversations. A client may start a live session, stream microphone audio, send typed text, receive audio or transcript events back, and stop the session. Without this file, the project could still do normal request/response work, but it would not have a working live conversation path.

The main object, `RealtimeConversationManager`, keeps the current conversation state behind a mutex, which is a lock that prevents two tasks from changing the state at the same time. Starting a conversation creates bounded queues for incoming audio, text, background-agent output, and outgoing realtime events. Think of these queues like labeled inbox trays: user audio goes in one tray, typed text in another, and model events come out through another.

The file supports two transports. A plain WebSocket connection sends and receives everything directly. A WebRTC start can also create a sideband WebSocket connection, which is a helper channel used alongside the media call. A background task watches all inputs at once and forwards them to the realtime API.

A major feature here is “handoff”: when the realtime model asks the background Codex agent to do work, this file routes that request into the normal Codex session, then feeds the agent’s progress or final answer back into the realtime conversation. It also contains small safety rules, such as dropping audio if the input queue is full, adding clear prefixes to realtime text in v2 sessions, truncating long backend output, and avoiding overlapping realtime responses.

#### Function details

##### `RealtimeResponseCreateQueue::request_create`  (lines 137–148)

```
async fn request_create(
        &mut self,
        writer: &RealtimeWebsocketWriter,
        events_tx: &Sender<RealtimeEvent>,
        reason: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Asks the realtime server to start a new model response, but only if another default response is not already active. If a response is already running, it records that a new one should be sent later.

**Data flow**: It receives the websocket writer, the event output queue, and a short reason string for logging. If a response is already active, it flips a pending flag and returns. Otherwise it immediately sends the create request and reports any failure through the event queue.

**Call relations**: When handoff output or a server event means the model should answer again, `handle_handoff_output` or `handle_realtime_server_event` calls this. It hands the actual sending to `send_create_now` when it is safe to do so.

*Call graph*: calls 1 internal fn (send_create_now); called by 2 (handle_handoff_output, handle_realtime_server_event).


##### `RealtimeResponseCreateQueue::mark_started`  (lines 150–152)

```
fn mark_started(&mut self)
```

**Purpose**: Records that the realtime server has begun a response. This prevents the code from trying to start another response on top of it.

**Data flow**: It takes the queue state and changes the active-response flag to true. It does not return data; it only updates the in-memory guardrail.

**Call relations**: `handle_realtime_server_event` calls this after it sees a response-created event from the realtime server, so later response requests can be deferred instead of sent too early.

*Call graph*: called by 1 (handle_realtime_server_event).


##### `RealtimeResponseCreateQueue::mark_finished`  (lines 154–166)

```
async fn mark_finished(
        &mut self,
        writer: &RealtimeWebsocketWriter,
        events_tx: &Sender<RealtimeEvent>,
        reason: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Records that the current realtime response has ended and sends one deferred response request if one was waiting. This keeps the conversation moving without violating the server’s one-active-response rule.

**Data flow**: It receives the writer, event queue, and reason. It clears the active flag; if no request is pending, it returns. If one is pending, it clears that flag and sends the response-create message now.

**Call relations**: `handle_realtime_server_event` calls this when a response is done or cancelled. It uses `send_create_now` to release a queued response at the right moment.

*Call graph*: calls 1 internal fn (send_create_now); called by 1 (handle_realtime_server_event).


##### `RealtimeResponseCreateQueue::send_create_now`  (lines 168–189)

```
async fn send_create_now(
        &mut self,
        writer: &RealtimeWebsocketWriter,
        events_tx: &Sender<RealtimeEvent>,
        reason: &str,
    ) -> anyhow::Result<()>
```

**Purpose**: Sends the actual `response.create` message to the realtime API. It also handles the special case where the server says a response is already active, treating that as a race and deferring instead of failing hard.

**Data flow**: It sends through the websocket writer. On success, it marks a response as active. On failure, it maps the API error into the project’s error shape, may push an error event to listeners, and returns an error unless it was the known active-response race.

**Call relations**: `request_create` and `mark_finished` both call this when they decide a create request should be sent immediately.

*Call graph*: calls 1 internal fn (send_response_create); called by 2 (mark_finished, request_create); 4 external calls (send, map_api_error, Error, warn!).


##### `RealtimeHandoffState::new`  (lines 211–225)

```
fn new(
        output_tx: Sender<RealtimeOutbound>,
        codex_responses_as_items: bool,
        codex_response_item_prefix: Option<String>,
        session_kind: RealtimeSessionKind,
    ) -> Sel
```

**Purpose**: Builds the shared state used to track a realtime-to-Codex handoff. It remembers where to send background-agent output and what handoff, if any, is currently active.

**Data flow**: It takes an output queue, settings about how Codex responses should be represented, and the realtime session kind. It returns a state object with empty active-handoff and last-output slots protected by async locks.

**Call relations**: `start_inner` creates this when a new realtime conversation starts, so all later handoff input and output can share the same tracking state.

*Call graph*: called by 2 (start_inner, clears_active_handoff_explicitly); 2 external calls (new, new).


##### `RealtimeConversationManager::new`  (lines 259–263)

```
fn new() -> Self
```

**Purpose**: Creates an empty realtime conversation manager. At this point no realtime session is running.

**Data flow**: It creates a manager whose internal state is `None`, wrapped in a mutex so later async tasks can safely update it. The result is ready to be stored on a session.

**Call relations**: Session setup code calls this while building a session or test context. Later methods on the manager fill in or clear the state as conversations start and stop.

*Call graph*: called by 3 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 1 external calls (new).


##### `RealtimeConversationManager::running_state`  (lines 265–270)

```
async fn running_state(&self) -> Option<()>
```

**Purpose**: Checks whether there is currently an active realtime conversation. It is a lightweight status check used before reporting errors to clients.

**Data flow**: It reads the locked manager state and checks an atomic active flag, which is a thread-safe true/false value. It returns `Some(())` when active and `None` otherwise.

**Call relations**: Input handlers use this after an audio, text, or speech send fails to decide whether to report a bad request or simply note that the session was already ending.


##### `RealtimeConversationManager::is_running_v2`  (lines 272–280)

```
async fn is_running_v2(&self) -> bool
```

**Purpose**: Checks whether the active realtime conversation is using the newer v2 event format. This lets callers choose behavior that only makes sense for v2.

**Data flow**: It reads the current state, confirms the active flag is still true, and compares the stored session kind with v2. It returns a boolean.

**Call relations**: This is a public status helper on the manager. It does not start or stop anything; it answers a question about the current conversation.

*Call graph*: 1 external calls (matches!).


##### `RealtimeConversationManager::start`  (lines 282–292)

```
async fn start(&self, start: RealtimeStart) -> CodexResult<RealtimeStartOutput>
```

**Purpose**: Starts a new realtime conversation, stopping any previous one first. This ensures there is never more than one live realtime session owned by the manager.

**Data flow**: It removes any existing state from the manager. If there was one, it stops its tasks and queues, then calls `start_inner` to create the new connection and state.

**Call relations**: `handle_start_inner` calls this after preparing all start settings. It delegates cleanup to `stop_conversation_state` and setup to `start_inner`.

*Call graph*: calls 2 internal fn (start_inner, stop_conversation_state).


##### `RealtimeConversationManager::start_inner`  (lines 294–396)

```
async fn start_inner(&self, start: RealtimeStart) -> CodexResult<RealtimeStartOutput>
```

**Purpose**: Does the real work of opening the realtime connection and creating the background input task. It supports both direct WebSocket sessions and WebRTC sessions with a sideband channel.

**Data flow**: It receives a prepared start package containing provider, headers, session config, transport data, and model client. It creates input/output queues, builds handoff state, opens the chosen transport, spawns the input task, stores the new conversation state, and returns the event receiver plus any WebRTC SDP answer.

**Call relations**: `start` calls this after old state has been removed. It creates `RealtimeHandoffState`, then uses either `spawn_realtime_input_task` or `spawn_webrtc_sideband_input_task` depending on the transport.

*Call graph*: calls 5 internal fn (new, new, spawn_realtime_input_task, spawn_webrtc_sideband_input_task, default_headers); called by 1 (start); 3 external calls (clone, new, new).


##### `RealtimeConversationManager::register_fanout_task`  (lines 398–417)

```
async fn register_fanout_task(
        &self,
        realtime_active: &Arc<AtomicBool>,
        fanout_task: JoinHandle<()>,
    )
```

**Purpose**: Attaches the task that forwards realtime events back to the client to the current conversation. If the task belongs to an old conversation, it is aborted.

**Data flow**: It receives the active conversation marker and a spawned task. It compares the marker with the manager’s current state; on a match, it stores the task. On mismatch, it aborts and awaits the task so it does not leak.

**Call relations**: `handle_start_inner` creates the fanout task after the realtime connection starts, then calls this to tie that task to the matching conversation.

*Call graph*: 3 external calls (ptr_eq, abort, take).


##### `RealtimeConversationManager::finish_if_active`  (lines 419–431)

```
async fn finish_if_active(&self, realtime_active: &Arc<AtomicBool>)
```

**Purpose**: Finishes the current conversation only if it matches the supplied active marker. This prevents an old task from accidentally shutting down a newer conversation.

**Data flow**: It compares the given shared active flag with the one in current state. If they are the same, it removes the state and stops it while leaving the fanout task detached; otherwise it does nothing.

**Call relations**: The fanout task created in `handle_start_inner` calls this when the realtime event stream ends, so the manager clears the exact conversation that ended.

*Call graph*: calls 1 internal fn (stop_conversation_state); 1 external calls (ptr_eq).


##### `RealtimeConversationManager::audio_in`  (lines 433–455)

```
async fn audio_in(&self, frame: RealtimeAudioFrame) -> CodexResult<()>
```

**Purpose**: Accepts one captured user audio frame and queues it for sending to the realtime server. If the queue is full, it drops the frame rather than slowing everything down.

**Data flow**: It reads the current state to get the audio sender. If no conversation is running, it returns an invalid-request error. If the queue has room, the frame is queued; if full, the frame is discarded with a warning.

**Call relations**: `handle_audio` calls this when a client submits audio. The background input loop later receives the frame and sends it through `handle_user_audio_input`.

*Call graph*: 2 external calls (InvalidRequest, warn!).


##### `RealtimeConversationManager::text_in`  (lines 457–480)

```
async fn text_in(&self, mut params: ConversationTextParams) -> CodexResult<()>
```

**Purpose**: Accepts typed text for the realtime conversation and queues it for sending. For v2 user text, it adds a clear `[USER]` prefix so the realtime model can distinguish user input from backend messages.

**Data flow**: It reads the text sender and session kind from current state. It may rewrite the text with `prefix_realtime_text`, then sends the text parameters into the queue. If no conversation is running or the queue is closed, it returns an invalid-request error.

**Call relations**: `handle_text` calls this for incoming text submissions. The input loop later receives the queued text and `handle_text_input` sends it to the realtime API.

*Call graph*: calls 1 internal fn (prefix_realtime_text); 1 external calls (InvalidRequest).


##### `RealtimeConversationManager::handoff_out`  (lines 482–533)

```
async fn handoff_out(&self, output_text: String) -> CodexResult<()>
```

**Purpose**: Feeds output from the background Codex agent back into the realtime conversation. It decides whether the output belongs to an active handoff, is a standalone backend message, or should be ignored because it is empty.

**Data flow**: It reads the current handoff state. If a handoff is active, it formats and stores the latest backend output, then queues either a handoff update or a developer conversation item. If no handoff is active, it queues a standalone backend message unless the text is blank.

**Call relations**: Code that receives background-agent results uses this to return them to realtime. It uses `realtime_backend_output` and sometimes `realtime_backend_item`; `handle_handoff_output` later sends the queued `RealtimeOutbound` to the server.

*Call graph*: calls 2 internal fn (realtime_backend_item, realtime_backend_output); 1 external calls (InvalidRequest).


##### `RealtimeConversationManager::append_speech`  (lines 535–558)

```
async fn append_speech(&self, text: String) -> CodexResult<()>
```

**Purpose**: Adds speech text back into the realtime conversation as backend output. This is used when speech has already been converted into text and should be visible to the realtime model.

**Data flow**: It ignores blank text. Otherwise it gets the current handoff state, formats the text as backend output, and queues it as a standalone handoff-style message. If the conversation is gone, it returns an invalid-request error.

**Call relations**: `handle_speech` calls this when speech text arrives from the client. The queued message is later processed by `handle_handoff_output`.

*Call graph*: calls 1 internal fn (realtime_backend_output); 1 external calls (InvalidRequest).


##### `RealtimeConversationManager::handoff_complete`  (lines 560–594)

```
async fn handoff_complete(&self) -> CodexResult<()>
```

**Purpose**: Tells the realtime conversation that the current background-agent handoff has completed. This matters mainly for v2 sessions, where the realtime server may need a function-call output or acknowledgement.

**Data flow**: It reads the handoff state. If there is no active conversation, no active handoff, no last output, or the session is v1, it returns without doing anything. Otherwise it queues either a completion acknowledgement or completed handoff output.

**Call relations**: After background work finishes, callers use this to close the loop with realtime. `handle_handoff_output` later turns the queued completion into the right server message.


##### `RealtimeConversationManager::clear_active_handoff`  (lines 596–605)

```
async fn clear_active_handoff(&self)
```

**Purpose**: Forgets the currently active handoff and the last backend output. This resets handoff tracking after work is done or intentionally abandoned.

**Data flow**: It reads the current handoff state, if any, and sets both shared slots to `None`. It returns no value and sends nothing to the realtime server.

**Call relations**: This is a cleanup helper for code that needs to explicitly clear handoff state. It operates on the state created by `RealtimeHandoffState::new`.


##### `RealtimeConversationManager::shutdown`  (lines 607–617)

```
async fn shutdown(&self) -> CodexResult<()>
```

**Purpose**: Stops the current realtime conversation, if one exists. It is the manager’s normal close operation.

**Data flow**: It removes the current state from the manager. If there was a conversation, it calls `stop_conversation_state` to mark it inactive and abort its background tasks.

**Call relations**: `end_realtime_conversation` uses this when the client asks to close. `start` also uses the same stopping path when replacing an old conversation.

*Call graph*: calls 1 internal fn (stop_conversation_state).


##### `stop_conversation_state`  (lines 620–637)

```
async fn stop_conversation_state(
    mut state: ConversationState,
    fanout_task_stop: RealtimeFanoutTaskStop,
)
```

**Purpose**: Shuts down the tasks that belong to one conversation state. It is the common cleanup routine used when a conversation is replaced, closed, or finishes by itself.

**Data flow**: It marks the shared active flag false, aborts the input task, and waits for it to finish. For the fanout task, it either aborts it or leaves it detached depending on the requested stop style.

**Call relations**: `start`, `shutdown`, and `finish_if_active` all call this so conversation teardown follows one consistent path.

*Call graph*: called by 3 (finish_if_active, shutdown, start).


##### `handle_start`  (lines 639–672)

```
async fn handle_start(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationStartParams,
) -> CodexResult<()>
```

**Purpose**: Handles a client request to start a realtime conversation. It prepares configuration first, then starts the actual conversation and reports errors back as realtime error events.

**Data flow**: It receives the session, subscription id, and start parameters. It calls `prepare_realtime_start`; if preparation fails, it sends an error event to the client. If preparation succeeds, it calls `handle_start_inner` and similarly reports any start failure.

**Call relations**: The session submission loop calls this for start requests. It separates user-facing error reporting from the lower-level preparation and connection work.

*Call graph*: calls 2 internal fn (handle_start_inner, prepare_realtime_start); called by 1 (submission_loop); 3 external calls (error!, RealtimeConversationRealtime, Error).


##### `prepare_realtime_start`  (lines 687–755)

```
async fn prepare_realtime_start(
    sess: &Arc<Session>,
    params: ConversationStartParams,
) -> CodexResult<PreparedRealtimeConversationStart>
```

**Purpose**: Turns a client’s start request plus session configuration into a complete, validated start package. This includes auth headers, model settings, realtime version, transport choice, and API provider details.

**Data flow**: It reads the session provider, auth manager, and config, then combines them with request parameters. It validates architecture rules, builds the realtime session config, finds an API key when needed, creates headers, and returns a prepared start object.

**Call relations**: `handle_start` calls this before opening any network connection. It relies on `build_realtime_session_config`, `validate_realtime_architecture`, `realtime_api_key`, and `realtime_request_headers`.

*Call graph*: calls 4 internal fn (build_realtime_session_config, realtime_api_key, realtime_request_headers, validate_realtime_architecture); called by 1 (handle_start).


##### `validate_realtime_architecture`  (lines 757–782)

```
fn validate_realtime_architecture(
    architecture: RealtimeConversationArchitecture,
    version: RealtimeWsVersion,
    transport: &ConversationStartTransport,
    session_type: RealtimeWsMode,
) -
```

**Purpose**: Checks that a requested realtime architecture is allowed with the chosen version, transport, and session type. It protects users from starting combinations the backend does not support.

**Data flow**: It receives the architecture, realtime version, transport, and configured session mode. If the architecture is not AVAS, it accepts it. If it is AVAS, it requires v1, WebRTC, and conversational mode; otherwise it returns a clear invalid-request error.

**Call relations**: `prepare_realtime_start` calls this before building the final start package, so bad combinations fail early.

*Call graph*: called by 1 (prepare_realtime_start); 2 external calls (matches!, InvalidRequest).


##### `build_realtime_session_config`  (lines 784–853)

```
async fn build_realtime_session_config(
    sess: &Arc<Session>,
    params: &ConversationStartParams,
    version: RealtimeWsVersion,
) -> CodexResult<RealtimeSessionConfig>
```

**Purpose**: Builds the configuration sent to the realtime API for one session. This includes instructions, startup context, model, session id, parser version, output type, mode, and voice.

**Data flow**: It reads project config and request parameters. It prepares the backend prompt, optionally adds startup context, chooses a model and event parser, validates output modality and voice, and returns a `RealtimeSessionConfig`.

**Call relations**: `prepare_realtime_start` calls this as the central session-config builder. It uses prompt/context helpers and `validate_realtime_voice` to keep the API request valid.

*Call graph*: calls 3 internal fn (build_realtime_startup_context, validate_realtime_voice, prepare_realtime_backend_prompt); called by 1 (prepare_realtime_start); 4 external calls (new, format!, matches!, InvalidRequest).


##### `default_realtime_voice`  (lines 855–861)

```
fn default_realtime_voice(version: RealtimeWsVersion) -> RealtimeVoice
```

**Purpose**: Chooses the default voice for a realtime version. Different realtime versions can have different supported default voices.

**Data flow**: It reads the built-in voice list and returns the v1 or v2 default based on the requested version.

**Call relations**: `build_realtime_session_config` uses this when neither the request nor the config specifies a voice.

*Call graph*: calls 1 internal fn (builtin).


##### `prefix_realtime_text`  (lines 863–868)

```
fn prefix_realtime_text(text: String, prefix: &str, session_kind: RealtimeSessionKind) -> String
```

**Purpose**: Adds a label such as `[USER]` or `[BACKEND]` to v2 realtime text when needed. The prefix helps the model understand where a message came from.

**Data flow**: It receives text, a prefix, and the session kind. For non-v2 sessions, empty text, or already-prefixed text, it returns the original text. Otherwise it returns a new string with the prefix added.

**Call relations**: `text_in` uses this for user text, and `realtime_backend_output` uses it for backend output.

*Call graph*: called by 2 (text_in, realtime_backend_output); 1 external calls (format!).


##### `realtime_backend_output`  (lines 870–873)

```
fn realtime_backend_output(output_text: String, session_kind: RealtimeSessionKind) -> String
```

**Purpose**: Formats background-agent output before sending it into the realtime conversation. It adds the backend label for v2 and trims the text to a safe token budget.

**Data flow**: It receives raw backend output and the session kind. It prefixes the text if needed, truncates it to the assistant-output budget, and returns the formatted text.

**Call relations**: `handoff_out` and `append_speech` call this before queueing backend text for the realtime server.

*Call graph*: calls 2 internal fn (truncate_realtime_text_to_token_budget, prefix_realtime_text); called by 2 (append_speech, handoff_out).


##### `realtime_backend_item`  (lines 875–881)

```
fn realtime_backend_item(text: String, prefix: Option<&str>) -> String
```

**Purpose**: Formats backend output as a developer conversation item, optionally adding a caller-supplied heading. It also trims long text before it is sent.

**Data flow**: It receives text and an optional prefix. If the prefix is present and non-empty, it prepends it with spacing, then truncates the result to the configured token budget.

**Call relations**: `handoff_out` calls this when Codex responses should be inserted as conversation items instead of handoff function outputs.

*Call graph*: calls 1 internal fn (truncate_realtime_text_to_token_budget); called by 1 (handoff_out); 1 external calls (format!).


##### `validate_realtime_voice`  (lines 883–906)

```
fn validate_realtime_voice(version: RealtimeWsVersion, voice: RealtimeVoice) -> CodexResult<()>
```

**Purpose**: Checks that the requested voice is supported by the chosen realtime API version. It returns a useful error listing allowed voices when the choice is invalid.

**Data flow**: It reads the built-in voice list, selects the allowed voices for v1 or v2, and checks whether the requested voice is present. It returns success or an invalid-request error message.

**Call relations**: `build_realtime_session_config` calls this before returning the final session config.

*Call graph*: calls 1 internal fn (builtin); called by 1 (build_realtime_session_config); 2 external calls (format!, InvalidRequest).


##### `handle_start_inner`  (lines 908–1033)

```
async fn handle_start_inner(
    sess: &Arc<Session>,
    sub_id: &str,
    prepared_start: PreparedRealtimeConversationStart,
) -> CodexResult<()>
```

**Purpose**: Starts the prepared realtime conversation and begins forwarding realtime events back to the client. It also routes handoff requests into the normal Codex text flow.

**Data flow**: It receives the prepared start package, converts transport data into a `RealtimeStart`, and starts the manager. It sends a started event, sends a WebRTC SDP answer if present, spawns a fanout task that reads realtime events, forwards them to the client, and routes handoff text into the session.

**Call relations**: `handle_start` calls this after preparation succeeds. It calls `realtime_delegation_from_handoff` when realtime asks for Codex help, registers the fanout task with the manager, and later uses `send_realtime_conversation_closed` when the stream ends.

*Call graph*: calls 2 internal fn (realtime_delegation_from_handoff, send_realtime_conversation_closed); called by 1 (handle_start); 7 external calls (clone, debug!, info!, RealtimeConversationRealtime, RealtimeConversationSdp, RealtimeConversationStarted, spawn).


##### `handle_audio`  (lines 1035–1049)

```
async fn handle_audio(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationAudioParams,
)
```

**Purpose**: Handles one client audio-input message for a realtime conversation. It reports a user-facing error only when the conversation is not already shutting down.

**Data flow**: It takes the audio frame from the request and passes it to `audio_in`. On failure, it checks whether a conversation is still running; if not, it sends a bad-request error event to the client.

**Call relations**: The submission loop calls this for audio messages. It is the outer error-handling layer around `RealtimeConversationManager::audio_in`.

*Call graph*: calls 1 internal fn (send_conversation_error); called by 1 (submission_loop); 2 external calls (error!, warn!).


##### `realtime_transcript_delta_from_handoff`  (lines 1051–1059)

```
fn realtime_transcript_delta_from_handoff(handoff: &RealtimeHandoffRequested) -> Option<String>
```

**Purpose**: Builds a readable transcript snippet from the active transcript entries included in a handoff request. This gives the background agent extra context about what was just said.

**Data flow**: It reads the handoff’s active transcript entries, formats each as `role: text`, joins them with new lines, and returns the result only if it is non-empty.

**Call relations**: `realtime_delegation_from_handoff` calls this when preparing text to route from realtime into the Codex session.

*Call graph*: called by 1 (realtime_delegation_from_handoff).


##### `realtime_text_from_handoff_request`  (lines 1061–1065)

```
fn realtime_text_from_handoff_request(handoff: &RealtimeHandoffRequested) -> Option<String>
```

**Purpose**: Chooses the best text to send to the background Codex agent from a realtime handoff request. It prefers the full input transcript and falls back to the active transcript delta.

**Data flow**: It reads `input_transcript` from the handoff. If that is non-empty, it returns a copy. Otherwise it asks `realtime_transcript_delta_from_handoff` for a transcript snippet.

**Call relations**: `realtime_delegation_from_handoff` uses this as the first step in turning a handoff request into routed Codex input.

*Call graph*: called by 1 (realtime_delegation_from_handoff).


##### `realtime_delegation_from_handoff`  (lines 1067–1073)

```
fn realtime_delegation_from_handoff(handoff: &RealtimeHandoffRequested) -> Option<String>
```

**Purpose**: Converts a realtime handoff request into the special text payload sent into the background Codex agent. If there is no useful text, it returns nothing.

**Data flow**: It extracts the main input text, optionally extracts a transcript delta, wraps both in a small XML-like structure, and returns that string.

**Call relations**: The fanout task inside `handle_start_inner` calls this when it sees a `HandoffRequested` realtime event, then routes the resulting text into the session.

*Call graph*: calls 3 internal fn (realtime_text_from_handoff_request, realtime_transcript_delta_from_handoff, wrap_realtime_delegation_input); called by 1 (handle_start_inner).


##### `wrap_realtime_delegation_input`  (lines 1075–1085)

```
fn wrap_realtime_delegation_input(input: &str, transcript_delta: Option<&str>) -> String
```

**Purpose**: Packages realtime handoff input in a simple XML-like envelope. The envelope makes it clear to the background agent what is the user input and what is transcript context.

**Data flow**: It escapes special XML characters in the input and optional transcript delta, then returns a string with `<realtime_delegation>`, `<input>`, and optionally `<transcript_delta>` tags.

**Call relations**: `realtime_delegation_from_handoff` calls this after choosing the text that should be delegated.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (realtime_delegation_from_handoff); 1 external calls (format!).


##### `escape_xml_text`  (lines 1087–1092)

```
fn escape_xml_text(input: &str) -> String
```

**Purpose**: Makes text safe to place inside the XML-like handoff wrapper. It prevents characters such as `<` and `&` from being mistaken for markup.

**Data flow**: It receives a string slice and replaces ampersands, less-than signs, and greater-than signs with their escaped forms. It returns the escaped string.

**Call relations**: `wrap_realtime_delegation_input` calls this for both the main input and transcript delta.

*Call graph*: called by 1 (wrap_realtime_delegation_input).


##### `realtime_api_key`  (lines 1094–1118)

```
fn realtime_api_key(auth: Option<&CodexAuth>, provider: &ModelProviderInfo) -> CodexResult<String>
```

**Purpose**: Finds an API key or bearer token suitable for realtime WebSocket authentication. It checks several places so different login modes can still work.

**Data flow**: It first asks the model provider for an API key, then checks an experimental bearer token, then the current Codex auth object, and finally the OpenAI API key environment variable for OpenAI providers. If none is found, it returns an invalid-request error.

**Call relations**: `prepare_realtime_start` calls this when starting a WebSocket realtime session that needs an Authorization header.

*Call graph*: calls 2 internal fn (api_key, is_openai); called by 1 (prepare_realtime_start); 2 external calls (read_openai_api_key_from_env, InvalidRequest).


##### `realtime_request_headers`  (lines 1120–1145)

```
fn realtime_request_headers(
    realtime_session_id: Option<&str>,
    api_key: Option<&str>,
    version: RealtimeWsVersion,
) -> CodexResult<Option<HeaderMap>>
```

**Purpose**: Builds the HTTP headers needed to start a realtime connection. These may include version flags, a session id, and an Authorization bearer token.

**Data flow**: It creates an empty header map, adds the v1 alpha header when needed, adds `x-session-id` if the session id is valid, and adds `Authorization: Bearer ...` if an API key is provided. It returns the header map wrapped in `Some`.

**Call relations**: `prepare_realtime_start` calls this after deciding the transport and authentication needs.

*Call graph*: called by 1 (prepare_realtime_start); 4 external calls (new, from_static, from_str, format!).


##### `handle_text`  (lines 1147–1162)

```
async fn handle_text(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationTextParams,
)
```

**Purpose**: Handles one client text-input message for a realtime conversation. It logs the text path and reports a bad-request error if the conversation is not available.

**Data flow**: It passes the text parameters to `text_in`. If that fails, it checks whether the conversation is still running; if not, it sends an error event to the client.

**Call relations**: The submission loop calls this for realtime text messages. It wraps `RealtimeConversationManager::text_in` with client-facing error handling.

*Call graph*: calls 1 internal fn (send_conversation_error); called by 1 (submission_loop); 3 external calls (debug!, error!, warn!).


##### `handle_speech`  (lines 1164–1179)

```
async fn handle_speech(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationSpeechParams,
)
```

**Purpose**: Handles speech text that should be appended to the realtime conversation. This is separate from raw audio frames because the input has already become text.

**Data flow**: It sends the speech text to `append_speech`. On failure, it checks whether the realtime session is still active and sends a bad-request error only if appropriate.

**Call relations**: The submission loop calls this for speech messages. It wraps `RealtimeConversationManager::append_speech` with logging and error reporting.

*Call graph*: calls 1 internal fn (send_conversation_error); called by 1 (submission_loop); 3 external calls (debug!, error!, warn!).


##### `handle_close`  (lines 1181–1183)

```
async fn handle_close(sess: &Arc<Session>, sub_id: String)
```

**Purpose**: Handles a client request to close the realtime conversation. It marks the close reason as requested by the user.

**Data flow**: It receives the session and subscription id, then calls `end_realtime_conversation` with the requested-close reason. It returns after shutdown and close notification are scheduled by that helper.

**Call relations**: The submission loop calls this for close messages. It delegates the real shutdown and closed event to `end_realtime_conversation`.

*Call graph*: calls 1 internal fn (end_realtime_conversation); called by 1 (submission_loop).


##### `spawn_realtime_input_task`  (lines 1185–1187)

```
fn spawn_realtime_input_task(input: RealtimeInputTask) -> JoinHandle<()>
```

**Purpose**: Starts the background task that drives a direct WebSocket realtime connection. This task watches user inputs, backend outputs, and server events at the same time.

**Data flow**: It receives all inputs needed by `run_realtime_input_task`, spawns it on Tokio, which is Rust’s async task runtime, and returns the task handle.

**Call relations**: `start_inner` calls this for normal WebSocket sessions. The spawned task then runs `run_realtime_input_task`.

*Call graph*: calls 1 internal fn (run_realtime_input_task); called by 1 (start_inner); 1 external calls (spawn).


##### `spawn_webrtc_sideband_input_task`  (lines 1202–1260)

```
fn spawn_webrtc_sideband_input_task(input: RealtimeWebrtcSidebandInputTask) -> JoinHandle<()>
```

**Purpose**: Starts the background sideband WebSocket task for a WebRTC realtime session. The sideband carries control messages and events alongside the WebRTC media connection.

**Data flow**: It receives the client, call id, headers, channels, handoff state, parser settings, and active flag. The spawned task connects the sideband; if connection fails while active, it sends an error event. On success, it runs the same input loop used by direct WebSocket sessions.

**Call relations**: `start_inner` calls this when the start request includes WebRTC SDP. After connecting, it hands off to `run_realtime_input_task`.

*Call graph*: calls 2 internal fn (run_realtime_input_task, default_headers); called by 1 (start_inner); 4 external calls (map_api_error, Error, spawn, warn!).


##### `run_realtime_input_task`  (lines 1262–1324)

```
async fn run_realtime_input_task(input: RealtimeInputTask)
```

**Purpose**: Runs the main realtime input loop. It waits for whichever happens next: user text, background-agent output, a server event, or user audio.

**Data flow**: It takes the writer, server event stream, input queues, event output queue, handoff state, session kind, and parser. In a loop, it selects the next available input and calls the matching handler. If any handler returns an error, the loop stops.

**Call relations**: Both `spawn_realtime_input_task` and `spawn_webrtc_sideband_input_task` run this. It dispatches work to `handle_text_input`, `handle_handoff_output`, `handle_realtime_server_event`, and `handle_user_audio_input`.

*Call graph*: called by 2 (spawn_realtime_input_task, spawn_webrtc_sideband_input_task); 2 external calls (default, select!).


##### `handle_text_input`  (lines 1326–1345)

```
async fn handle_text_input(
    params: Result<ConversationTextParams, RecvError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
) -> anyhow::Result<()>
```

**Purpose**: Sends one queued text message into the realtime API as a conversation item. If sending fails, it reports the error through the realtime event stream.

**Data flow**: It receives a queued text result. If the queue is closed, it errors. Otherwise it sends the text and role through the websocket writer; on API failure, it maps the error, sends a realtime error event, and returns failure.

**Call relations**: `run_realtime_input_task` calls this when the text input queue produces a message.

*Call graph*: calls 1 internal fn (send_conversation_item_create); 4 external calls (send, map_api_error, Error, warn!).


##### `handle_handoff_output`  (lines 1347–1443)

```
async fn handle_handoff_output(
    handoff_output: Result<RealtimeOutbound, RecvError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
    handoff_state: &RealtimeHandof
```

**Purpose**: Sends background-agent output back to the realtime API in the right format for the realtime version. It handles standalone backend messages, progress updates, completed handoffs, conversation items, and acknowledgements.

**Data flow**: It receives a queued `RealtimeOutbound` value. It chooses the correct websocket writer method based on v1 versus v2 and the outbound kind. For some v2 messages, it also asks `RealtimeResponseCreateQueue` to start a new model response. On failure it sends a realtime error event.

**Call relations**: `run_realtime_input_task` calls this when background-agent output arrives. It may call `request_create` so the realtime model responds after new backend information is inserted.

*Call graph*: calls 4 internal fn (send_conversation_function_call_output, send_conversation_handoff_append, send_conversation_item_create, request_create); 6 external calls (send, new, map_api_error, debug!, Error, warn!).


##### `handle_realtime_server_event`  (lines 1445–1625)

```
async fn handle_realtime_server_event(
    event: Result<Option<RealtimeEvent>, ApiError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
    handoff_state: &RealtimeHand
```

**Purpose**: Processes one event received from the realtime server. It updates local bookkeeping, sends required acknowledgements, forwards the event to listeners, and stops the loop on stream-ending errors.

**Data flow**: It receives a server event result. It converts transport errors into realtime error events, updates output-audio tracking for v2, truncates playing audio when the user interrupts, tracks response lifecycle, records handoff ids, acknowledges noop or handoff calls, and finally sends the event to the output queue.

**Call relations**: `run_realtime_input_task` calls this whenever the realtime server produces an event. It uses `update_output_audio_state` for audio timing and the response-create queue methods to avoid overlapping responses.

*Call graph*: calls 6 internal fn (send_conversation_function_call_output, send_payload, mark_finished, mark_started, request_create, update_output_audio_state); 9 external calls (send, new, bail!, map_api_error, error!, info!, json!, Error, warn!).


##### `handle_user_audio_input`  (lines 1627–1643)

```
async fn handle_user_audio_input(
    frame: Result<RealtimeAudioFrame, RecvError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
) -> anyhow::Result<()>
```

**Purpose**: Sends one queued microphone audio frame to the realtime API. It turns send failures into realtime error events.

**Data flow**: It receives an audio frame from the queue. If the queue is closed, it errors. Otherwise it sends the frame through the writer; on API failure, it maps the error, emits a realtime error event, and returns failure.

**Call relations**: `run_realtime_input_task` calls this when the audio input queue produces a frame.

*Call graph*: calls 1 internal fn (send_audio_frame); 4 external calls (send, map_api_error, error!, Error).


##### `update_output_audio_state`  (lines 1645–1668)

```
fn update_output_audio_state(
    output_audio_state: &mut Option<OutputAudioState>,
    frame: &RealtimeAudioFrame,
)
```

**Purpose**: Tracks how much audio the realtime model has already produced for the current output item. This is needed so v2 sessions can truncate model audio correctly when the user interrupts.

**Data flow**: It reads the audio frame’s item id and duration. If the frame belongs to the current item, it adds to the stored duration. If it belongs to a new item, it replaces the stored state with that item and duration.

**Call relations**: `handle_realtime_server_event` calls this for v2 audio-output events before possible later interruption handling.

*Call graph*: calls 1 internal fn (audio_duration_ms); called by 1 (handle_realtime_server_event).


##### `audio_duration_ms`  (lines 1670–1679)

```
fn audio_duration_ms(frame: &RealtimeAudioFrame) -> u32
```

**Purpose**: Computes the length of an audio frame in milliseconds. It uses explicit sample metadata when available and otherwise estimates from the encoded audio data.

**Data flow**: It reads sample count or asks `decoded_samples_per_channel` to infer it, then divides by the sample rate to get milliseconds. If it cannot determine a sample count, it returns zero.

**Call relations**: `update_output_audio_state` calls this to know how far into an output item the audio has played.

*Call graph*: calls 1 internal fn (decoded_samples_per_channel); called by 1 (update_output_audio_state); 1 external calls (from).


##### `decoded_samples_per_channel`  (lines 1681–1686)

```
fn decoded_samples_per_channel(frame: &RealtimeAudioFrame) -> Option<u32>
```

**Purpose**: Infers the number of audio samples per channel from a base64-encoded audio frame. Base64 is a text form of binary data used for transport.

**Data flow**: It decodes the frame’s data string into bytes, divides by two bytes per sample and by the number of channels, then converts the result to a 32-bit number. If any step fails, it returns nothing.

**Call relations**: `audio_duration_ms` calls this when the frame does not already state its sample count.

*Call graph*: called by 1 (audio_duration_ms); 2 external calls (try_from, from).


##### `send_conversation_error`  (lines 1688–1702)

```
async fn send_conversation_error(
    sess: &Arc<Session>,
    sub_id: String,
    message: String,
    codex_error_info: CodexErrorInfo,
)
```

**Purpose**: Sends a standard error event back to the client for realtime conversation input failures. It includes optional structured error information.

**Data flow**: It receives the session, subscription id, message, and error category. It builds an `Error` event and sends it through the session’s raw event channel.

**Call relations**: `handle_audio`, `handle_text`, and `handle_speech` call this when user input fails and the conversation is not merely shutting down.

*Call graph*: called by 3 (handle_audio, handle_speech, handle_text); 1 external calls (Error).


##### `end_realtime_conversation`  (lines 1704–1711)

```
async fn end_realtime_conversation(
    sess: &Arc<Session>,
    sub_id: String,
    end: RealtimeConversationEnd,
)
```

**Purpose**: Stops the realtime conversation and then notifies the client that it closed. It is the shared close path for requested shutdowns.

**Data flow**: It calls the manager’s shutdown method and ignores its result, then sends a closed event with the supplied close reason.

**Call relations**: `handle_close` calls this when the client asks to end the realtime conversation. It delegates the final notification to `send_realtime_conversation_closed`.

*Call graph*: calls 1 internal fn (send_realtime_conversation_closed); called by 1 (handle_close).


##### `send_realtime_conversation_closed`  (lines 1713–1729)

```
async fn send_realtime_conversation_closed(
    sess: &Arc<Session>,
    sub_id: String,
    end: RealtimeConversationEnd,
)
```

**Purpose**: Sends the client a realtime-conversation-closed event with a simple reason string. This is how callers learn that the live session is no longer active.

**Data flow**: It converts the internal close reason into `requested`, `transport_closed`, or `error`, builds a closed event, and sends it through the session.

**Call relations**: `end_realtime_conversation` calls this for explicit closes, and the fanout task in `handle_start_inner` calls it when the transport ends or an error stops the conversation.

*Call graph*: called by 2 (end_realtime_conversation, handle_start_inner); 1 external calls (RealtimeConversationClosed).


### `realtime-webrtc/src/lib.rs`

`io_transport` · `session setup and live connection`

WebRTC is a way for two programs to open a live media connection, often for audio or video. This file defines the small set of things the rest of the app needs: how to start a session, how to finish the connection handshake, how to close it, and how to listen for connection events.

The important idea is that WebRTC setup happens in two halves. First, this code creates an “offer SDP”, which is a text description of what this side can do and how to reach it. That offer must be sent to the other side. The other side replies with an “answer SDP”, and `apply_answer_sdp` feeds that answer back into the session so the connection can finish opening.

The file also defines events such as connected, closed, failed, and local audio level updates. These events travel through a channel, which is like a small mailbox that one part of the program can read while another part sends updates.

A key behavior is platform support. On macOS, the work is handed to the `native` module. On every other operating system, starting or applying an answer returns an “unsupported platform” error. Without this file, callers would need to know platform details and native WebRTC setup rules themselves.

#### Function details

##### `RealtimeWebrtcSessionHandle::fmt`  (lines 40–43)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: This gives the session handle a safe debug-print form for logs or developer tools. It deliberately avoids exposing internal details, because the handle contains platform-specific pieces that are not useful or safe to print directly.

**Data flow**: It receives a formatting target from Rust’s debug-print system. It writes a short label saying this is a `RealtimeWebrtcSessionHandle`, marks the output as not showing every internal field, and returns whether formatting succeeded.

**Call relations**: When some other code tries to print the handle with debug formatting, Rust calls this function. It hands the actual text-building work to the standard debug-structure formatter.

*Call graph*: 1 external calls (debug_struct).


##### `RealtimeWebrtcSessionHandle::apply_answer_sdp`  (lines 47–57)

```
fn apply_answer_sdp(&self, answer_sdp: String) -> Result<()>
```

**Purpose**: This function completes the WebRTC handshake by accepting the other side’s answer description. A caller uses it after sending out this session’s offer and receiving the remote reply.

**Data flow**: It takes an answer SDP string, which is the remote side’s connection description. On macOS, it passes that string into the native session handle so the WebRTC connection can continue. On unsupported platforms, it discards the string and returns an unsupported-platform error.

**Call relations**: This is called after `RealtimeWebrtcSession::start` has produced an offer and the remote side has answered it. On macOS it delegates the real work to the native handle’s `apply_answer_sdp`; otherwise it stops the flow with a clear error.

*Call graph*: 1 external calls (apply_answer_sdp).


##### `RealtimeWebrtcSessionHandle::close`  (lines 59–62)

```
fn close(&self)
```

**Purpose**: This asks the live WebRTC session to shut down. It is the cleanup button for callers that are done with the realtime connection.

**Data flow**: It takes the existing session handle. On macOS, it tells the native handle to close the underlying connection. On other platforms, there is no native session to close, so it does nothing.

**Call relations**: This is used near the end of a session, for example when the user hangs up or the app is tearing down. On macOS it forwards the close request to the native implementation.

*Call graph*: 1 external calls (close).


##### `RealtimeWebrtcSessionHandle::local_audio_peak`  (lines 64–66)

```
fn local_audio_peak(&self) -> Arc<AtomicU16>
```

**Purpose**: This returns a shared number representing the current local audio peak level. Callers can use it to inspect or display how loud the local audio input is.

**Data flow**: It reads the handle’s shared audio-level storage and returns another shared pointer to the same atomic number. “Atomic” means the number can be read or changed safely by different threads without them stepping on each other.

**Call relations**: Code that wants to show or monitor local audio level calls this on the session handle. The function does not compute the level itself; it only gives access to the shared place where that value is stored.


##### `RealtimeWebrtcSession::start`  (lines 72–89)

```
fn start() -> Result<StartedRealtimeWebrtcSession>
```

**Purpose**: This starts a new realtime WebRTC session and gives the caller everything needed to continue setup. The result includes the local offer text, a handle for controlling the session, and a mailbox of events.

**Data flow**: It takes no input from the caller. On macOS, it asks the native implementation to start, then wraps the native handle in the public handle type, creates a shared audio-peak value initialized to zero, and returns the offer SDP plus the event receiver. On unsupported platforms, it returns an unsupported-platform error instead.

**Call relations**: This is the first call in the session flow. It calls the native `start` function on macOS, then builds the public objects that the rest of the app will use. After this returns successfully, the caller sends the offer SDP to the remote side, waits for an answer, and then calls `RealtimeWebrtcSessionHandle::apply_answer_sdp`.

*Call graph*: calls 1 internal fn (start); 2 external calls (new, new).


### `realtime-webrtc/src/native.rs`

`io_transport` · `session startup, connection negotiation, live audio monitoring, teardown`

This file is the bridge between the rest of the project and the native WebRTC library. WebRTC is the technology used for live audio communication. The rest of the app should not have to know all the steps needed to create a WebRTC connection, attach the microphone, exchange setup text, or poll audio statistics, so this file hides those details behind a small session API.

The main flow starts with `start`. It creates channels, which are message pipes between threads, then launches a dedicated worker thread for WebRTC work. That worker creates its own Tokio runtime, which is an engine for running asynchronous tasks. Inside that runtime it builds a peer connection, adds a send-and-receive audio track, creates a WebRTC offer, and sends the offer text back to the caller.

After startup, the caller uses `SessionHandle` like a remote control. It can apply the remote side's answer SDP, which is the text description that completes the WebRTC negotiation, or it can close the session. Once the answer is accepted, the file reports a connected event and starts a repeating task that checks WebRTC stats every 200 milliseconds. If it finds a local audio level, it converts that 0-to-1 value into a simple peak number and sends it as an event.

Without this file, the app would have no native WebRTC audio session: no offer creation, no answer application, no microphone track, and no ongoing audio-level feedback.

#### Function details

##### `SessionHandle::apply_answer_sdp`  (lines 40–48)

```
fn apply_answer_sdp(&self, answer_sdp: String) -> Result<()>
```

**Purpose**: Sends the remote WebRTC answer text to the worker thread and waits to hear whether it was accepted. This is the step that completes the connection setup after the local offer has been sent elsewhere.

**Data flow**: It receives an SDP answer string, creates a temporary reply channel, and sends an `ApplyAnswer` command to the worker. The worker later sends back success or an error through that reply channel. If the worker has stopped or cannot reply, this function turns that into a clear `realtime WebRTC worker stopped` error.

**Call relations**: Code holding a `SessionHandle` calls this after it has received the remote side's answer. The function does not apply the answer itself; it passes the work to `worker_main`, which then calls `apply_answer` inside the WebRTC runtime and sends the result back.

*Call graph*: 2 external calls (send, channel).


##### `SessionHandle::close`  (lines 50–52)

```
fn close(&self)
```

**Purpose**: Asks the WebRTC worker to close the session. It is a best-effort shutdown signal, so it does not report an error if the worker is already gone.

**Data flow**: It takes no session data from the caller beyond the handle itself. It sends a `Close` command through the command channel. The actual peer connection is closed later by the worker thread.

**Call relations**: Callers use this when they are done with the real-time audio session. `worker_main` receives the close command, closes the peer connection, sends a closed event, and exits.

*Call graph*: 1 external calls (send).


##### `start`  (lines 55–76)

```
fn start() -> Result<StartedSession>
```

**Purpose**: Starts a new native WebRTC session and returns the initial offer, a handle for later commands, and a stream of events. This is the main entry point for this file's functionality.

**Data flow**: It creates three channels: one for commands going to the worker, one for events coming back, and one for the initial offer result. It spawns a named worker thread, waits for that worker to produce either an offer SDP string or an error, and then returns a `StartedSession` containing the offer, the command handle, and the event receiver.

**Call relations**: This is called by the higher-level realtime WebRTC startup code. It hands long-running work to `worker_main` on a separate thread, then packages the returned pieces so the rest of the app can continue the negotiation and listen for connection events.

*Call graph*: called by 1 (start); 2 external calls (channel, new).


##### `worker_main`  (lines 78–134)

```
fn worker_main(
    command_rx: mpsc::Receiver<Command>,
    events_tx: mpsc::Sender<RealtimeWebrtcEvent>,
    offer_tx: mpsc::Sender<Result<String>>,
)
```

**Purpose**: Runs the WebRTC session on its own thread. It creates the asynchronous runtime, builds the peer connection, listens for commands, and sends events back to the rest of the app.

**Data flow**: It receives a command channel, an event sender, and an offer-result sender. First it builds a Tokio runtime. Then it uses that runtime to create the WebRTC peer connection and offer. After that, it loops over incoming commands: an answer command is applied to the connection, and a close command shuts everything down. It sends back events such as failed, connected, local audio level, and closed.

**Call relations**: `start` launches this function in a separate thread. During setup it calls `create_peer_connection_and_offer`. When an answer arrives, it calls `apply_answer`; on success it starts `start_local_audio_level_task` so audio-level events can be reported while the connection stays alive.

*Call graph*: calls 3 internal fn (apply_answer, create_peer_connection_and_offer, start_local_audio_level_task); 6 external calls (clone, send, format!, Message, Failed, new_multi_thread).


##### `create_peer_connection_and_offer`  (lines 136–174)

```
async fn create_peer_connection_and_offer() -> Result<(PeerConnection, String)>
```

**Purpose**: Creates the local WebRTC peer connection and produces the offer text that must be sent to the remote side. It also attaches the local microphone audio track so the session can send audio.

**Data flow**: It builds a WebRTC peer connection factory with the platform audio system, creates a peer connection with default settings, adds an audio transceiver for sending and receiving audio, creates a local microphone track, attaches that track, creates an offer, sets that offer as the local description, and returns both the peer connection and the offer SDP string.

**Call relations**: `worker_main` calls this during session startup. If any WebRTC setup step fails, this function uses `message_error` to turn the library error into the project's error type, and `worker_main` reports that failure to the caller and event stream.

*Call graph*: called by 1 (worker_main); 4 external calls (with_platform_adm, default, new, vec!).


##### `apply_answer`  (lines 176–184)

```
async fn apply_answer(peer_connection: &PeerConnection, answer_sdp: String) -> Result<()>
```

**Purpose**: Applies the remote side's WebRTC answer to the existing peer connection. This completes the offer-answer handshake, which is like both sides agreeing on how they will talk.

**Data flow**: It receives a peer connection and an SDP answer string. It parses the string as a WebRTC answer, then sets it as the remote description on the peer connection. It returns success if the connection accepts it, or a readable error if parsing or applying fails.

**Call relations**: `worker_main` calls this when it receives an `ApplyAnswer` command from `SessionHandle::apply_answer_sdp`. If this succeeds, `worker_main` announces that the session is connected and starts the local audio level reporting task.

*Call graph*: called by 1 (worker_main); 2 external calls (set_remote_description, parse).


##### `message_error`  (lines 186–188)

```
fn message_error(prefix: &str, err: impl Display) -> RealtimeWebrtcError
```

**Purpose**: Turns a lower-level error into this crate's standard WebRTC error message. It adds a short explanation of which step failed, so failures are easier to understand.

**Data flow**: It takes a prefix such as `failed to create WebRTC offer` and an error value from another library. It combines them into one human-readable string and wraps that string in `RealtimeWebrtcError::Message`.

**Call relations**: Setup and negotiation helpers use this whenever a WebRTC library call fails. It keeps error wording consistent for `create_peer_connection_and_offer` and `apply_answer`.

*Call graph*: 2 external calls (format!, Message).


##### `start_local_audio_level_task`  (lines 190–213)

```
fn start_local_audio_level_task(
    runtime: &tokio::runtime::Runtime,
    peer_connection: PeerConnection,
    events_tx: mpsc::Sender<RealtimeWebrtcEvent>,
)
```

**Purpose**: Starts a background task that periodically measures the local microphone audio level and sends it as an event. This gives the rest of the app simple feedback such as whether the user is speaking.

**Data flow**: It receives the Tokio runtime, a peer connection, and an event sender. It spawns an asynchronous loop that wakes every 200 milliseconds. Each time, it stops if the connection is closed or failed; otherwise it asks `local_audio_level` for the current level and sends a `LocalAudioLevel` event when a value is available.

**Call relations**: `worker_main` starts this task after `apply_answer` succeeds, because audio statistics are useful once the session is connected. The task repeatedly calls `local_audio_level` and forwards the converted result through the same event channel used for connection events.

*Call graph*: calls 1 internal fn (local_audio_level); called by 1 (worker_main); 6 external calls (spawn, send, matches!, LocalAudioLevel, from_millis, interval).


##### `local_audio_level`  (lines 215–223)

```
async fn local_audio_level(peer_connection: &PeerConnection) -> Option<u16>
```

**Purpose**: Reads WebRTC statistics and extracts the local audio source level if one is available. It turns a large stats report into just the one value the app needs.

**Data flow**: It asks the peer connection for its current stats. From those stats, it searches for a media source whose kind is audio. If it finds one, it takes the audio level, converts it to a peak number with `audio_level_to_peak`, and returns it. If stats cannot be read or no audio source is found, it returns nothing.

**Call relations**: `start_local_audio_level_task` calls this on every timer tick. This function does the focused stats lookup, while the caller decides when to repeat it and where to send the resulting event.

*Call graph*: called by 1 (start_local_audio_level_task); 1 external calls (get_stats).


##### `audio_level_to_peak`  (lines 225–227)

```
fn audio_level_to_peak(audio_level: f64) -> u16
```

**Purpose**: Converts WebRTC's audio level scale into a simple peak value. WebRTC gives a floating-point number from 0.0 to 1.0, while the app reports a whole-number peak value.

**Data flow**: It receives an audio level, clamps it into the safe 0.0-to-1.0 range, multiplies it by the maximum signed 16-bit audio sample value, rounds it, and returns the result as an unsigned 16-bit number.

**Call relations**: `local_audio_level` uses this after it finds an audio level in the WebRTC stats. It is the final translation step before `start_local_audio_level_task` sends a `LocalAudioLevel` event.
