# Model transport execution  `stage-13.1`

This stage is the system’s “send the request out and bring the answer back” layer. It sits in the main work of talking to model providers, with some startup help so the first request can be faster. Think of it as the shipping department: it packs requests, chooses a route, watches the trip, and unpacks replies.

At the center, core/src/client.rs runs client sessions and turns. It builds requests, picks HTTP, server-sent events (a one-way live stream), WebSocket (a two-way live connection), compact-history, memory, image, search, or realtime routes, and records telemetry. Shared request pieces live in client_common.rs, responses_metadata.rs, requests/responses.rs, and tools/src/responses_api.rs, which shape prompts, metadata, compression options, and tool descriptions into the wire format.

The endpoint files are the concrete couriers for each API. The SSE and WebSocket response files decode streamed events into internal messages. api_bridge.rs turns transport and HTTP failures into clear public errors. responses_retry.rs retries dropped streams and can fall back from WebSocket to HTTP.

For faster startup, session_startup_prewarm.rs prepares a model session early. For live conversations, the realtime websocket modules, realtime_call.rs, realtime_conversation.rs, and the WebRTC crate manage long-lived audio/text sessions across protocol versions.

## Files in this stage

### Shared request and error foundations
These files define the common request payload helpers, metadata, stream wrappers, tool serialization, and public error translation used across outbound model transports.

### `core/src/client_common.rs`

`data_model` · `cross-cutting request/stream representation`

This file holds the lightweight types that sit between higher-level turn orchestration and the lower-level API client in `client.rs`. `Prompt` is the in-memory representation of a single model turn request: conversation `input` as `Vec<ResponseItem>`, available `ToolSpec`s, whether parallel tool calls are allowed, base instructions, optional personality, optional JSON output schema, and whether that schema should be enforced strictly. Its `Default` implementation intentionally produces an empty, schema-free, tool-free prompt with strict schema validation enabled if a schema is later supplied.

The main behavior here is `Prompt::get_formatted_input_for_request`. It clones the prompt input and, when `use_responses_lite` is true, strips `detail` fields from embedded input images. The helper `strip_image_details` walks both ordinary message content (`ContentItem::InputImage`) and tool/function output payloads (`FunctionCallOutputContentItem::InputImage`) while leaving all other `ResponseItem` variants untouched. This is a targeted wire-shape normalization rather than a general transformation.

`ResponseStream` wraps a Tokio mpsc receiver of `Result<ResponseEvent>` plus a `CancellationToken`. It implements `futures::Stream` by polling the receiver directly, and its `Drop` implementation cancels the token so the background mapper task in `client.rs` can detect that the consumer stopped polling and record cancellation/partial-output trace state.

#### Function details

##### `Prompt::default`  (lines 43–53)

```
fn default() -> Self
```

**Purpose**: Creates an empty prompt with no input, no tools, no personality, and no output schema. It establishes the baseline defaults used by tests and request-building code.

**Data flow**: Constructs and returns `Prompt` with `input = Vec::new()`, `tools = Vec::new()`, `parallel_tool_calls = false`, `base_instructions = BaseInstructions::default()`, `personality = None`, `output_schema = None`, and `output_schema_strict = true`.

**Call relations**: Used widely in tests and fixture builders as the starting point for prompt construction. Production request building later consumes these fields in `ModelClient::build_responses_request`.

*Call graph*: calls 1 internal fn (default); called by 8 (responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids, send_provider_auth_request, prompt_with_input, sample, memories_startup_phase1_uses_live_thread_service_tier_and_detached_metadata); 1 external calls (new).


##### `Prompt::get_formatted_input_for_request`  (lines 57–66)

```
fn get_formatted_input_for_request(
        &self,
        use_responses_lite: bool,
    ) -> Vec<ResponseItem>
```

**Purpose**: Produces the request-ready copy of prompt input, optionally normalizing image detail fields for Responses Lite. It preserves the original prompt input unchanged.

**Data flow**: Clones `self.input` into a mutable local vector → if `use_responses_lite` is true, passes the clone to `strip_image_details` → returns the cloned/transformed `Vec<ResponseItem>`.

**Call relations**: Called by `ModelClient::build_responses_request` before constructing the wire request. Tests verify both that image details are stripped for Responses Lite and that the original prompt input remains intact.

*Call graph*: calls 1 internal fn (strip_image_details); called by 1 (build_responses_request).


##### `strip_image_details`  (lines 69–106)

```
fn strip_image_details(items: &mut [ResponseItem])
```

**Purpose**: Removes `detail` values from embedded input-image content inside response items. It only touches the specific variants that can carry image detail metadata.

**Data flow**: Mutably iterates over a slice of `ResponseItem` → for `ResponseItem::Message`, walks `content` and sets `detail = None` on each `ContentItem::InputImage`; for `FunctionCallOutput` and `CustomToolCallOutput`, obtains mutable content items from the payload and sets `detail = None` on each `FunctionCallOutputContentItem::InputImage`; all other response-item variants are ignored.

**Call relations**: Used only by `Prompt::get_formatted_input_for_request`. It is intentionally narrow so request normalization does not accidentally rewrite unrelated response-item content.

*Call graph*: called by 1 (get_formatted_input_for_request).


##### `ResponseStream::poll_next`  (lines 118–120)

```
fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>>
```

**Purpose**: Implements the `Stream` trait for `ResponseStream` by polling the underlying mpsc receiver. It exposes mapped response events to consumers one item at a time.

**Data flow**: Receives `Pin<&mut Self>` and task context → delegates to `self.rx_event.poll_recv(cx)` → returns `Poll<Option<Result<ResponseEvent>>>`.

**Call relations**: This method is exercised whenever callers iterate or `.next().await` a `ResponseStream` returned from `client.rs` streaming methods.

*Call graph*: 1 external calls (poll_recv).


##### `ResponseStream::drop`  (lines 124–126)

```
fn drop(&mut self)
```

**Purpose**: Signals that the consumer abandoned the stream before the provider emitted a terminal event. This lets the background mapper task record cancellation and stop work.

**Data flow**: On drop, calls `self.consumer_dropped.cancel()` and performs no other cleanup.

**Call relations**: The cancellation token is observed by `map_response_events` in `client.rs`. Tests specifically validate that dropping the stream causes cancellation traces to be recorded with any partial output already seen.

*Call graph*: 1 external calls (cancel).


### `core/src/responses_metadata.rs`

`data_model` · `request construction for Responses API and websocket/HTTP compatibility metadata emission`

This file is the central model-and-rendering layer for Codex request metadata sent to the Responses API. It defines constants for all owned metadata keys, a reserved-key denylist used to protect core-owned fields from caller-supplied overrides, and several small types that describe request identity. `CompactionTurnMetadata` captures dispatch-time compaction attributes such as trigger, reason, implementation, phase, and a fixed `Memento` strategy. `CodexResponsesRequestKind` distinguishes normal turns, prewarm requests, compaction requests, and memory requests; notably, memory requests are treated specially and do not carry turn identity.

The main struct, `CodexResponsesMetadata`, stores installation/session/thread/window identifiers, optional turn and parent/fork lineage, subagent labels, sandbox/workspace context, turn start time, and arbitrary extra metadata. Its methods render this snapshot in three forms: a serialized turn-metadata blob (`turn_metadata_json` / `turn_metadata_value`), a flat `HashMap<String, String>` for `client_metadata`, and direct HTTP compatibility headers. The internal `turn_metadata_payload` method is where the important shaping happens: it derives `request_kind`, conditionally includes identity fields depending on whether the request kind has turn identity, omits empty workspace maps, and flattens caller extras into the payload. The file also translates `SessionSource` values into legacy subagent header strings and richer metadata kinds, inserts HTTP headers only when values parse cleanly, and filters extra metadata so reserved Codex keys cannot be shadowed.

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

**Purpose**: Constructs the metadata payload describing a compaction request at dispatch time. It fills the caller-provided compaction dimensions and hard-codes the strategy to `CompactionStrategy::Memento`.

**Data flow**: It takes `trigger`, `reason`, `implementation`, and `phase` enums from analytics-oriented call sites and returns a `CompactionTurnMetadata` struct containing those values plus `strategy: Memento`. It does not read or mutate external state.

**Call relations**: This constructor is used by local and remote compaction execution paths such as `run_compact_task_inner` and `run_remote_compact_task_inner`, and by a test that verifies compaction-only overlay behavior. It is a leaf constructor that feeds into `CodexResponsesRequestKind::Compaction` and later serialization.

*Call graph*: called by 4 (run_compact_task_inner, run_remote_compact_task_inner, run_remote_compact_task_inner, turn_metadata_state_overlays_compaction_only_on_compaction_requests).


##### `CodexResponsesRequestKind::metadata`  (lines 104–111)

```
fn metadata(self) -> (&'static str, Option<CompactionTurnMetadata>)
```

**Purpose**: Maps a request-kind enum variant to the serialized request-kind label and optional embedded compaction metadata. It is the normalization step used before payload serialization.

**Data flow**: It consumes `self` and returns a tuple of `(&'static str, Option<CompactionTurnMetadata>)`: `"turn"`, `"prewarm"`, `"compaction"` plus metadata, or `"memory"`. No state is read or written.

**Call relations**: This helper is used inside `CodexResponsesMetadata::turn_metadata_payload` when converting the enum into wire-ready fields. It does not call further internal helpers.


##### `CodexResponsesRequestKind::has_turn_identity`  (lines 113–115)

```
fn has_turn_identity(self) -> bool
```

**Purpose**: Determines whether a request kind should carry turn/session/thread identity fields in the metadata payload. Memory requests are the only variant excluded.

**Data flow**: It consumes `self`, pattern-matches against `CodexResponsesRequestKind::Memory`, and returns `false` only for that variant and `true` otherwise. It has no side effects.

**Call relations**: This predicate is consulted by `CodexResponsesMetadata::turn_metadata_payload` to decide which identity fields to include. It is part of the file's invariant that detached memory requests omit turn identity.

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

**Purpose**: Creates a fresh metadata snapshot with the required installation, session, thread, and window identifiers populated and all optional fields empty.

**Data flow**: It takes owned `String` values for `installation_id`, `session_id`, `thread_id`, and `window_id`, and returns a `CodexResponsesMetadata` with `turn_id`, request kind, lineage, subagent fields, sandbox, and timestamp set to `None`, `workspaces` and `extra` initialized as empty `BTreeMap`s. It allocates those empty maps but writes no external state.

**Call relations**: This constructor is called by metadata-building entry points such as `responses_metadata`, `responses_metadata_template`, and `detached_memory_responses_metadata`. Those callers then enrich the returned struct before rendering it through the methods below.

*Call graph*: called by 3 (responses_metadata, responses_metadata_template, detached_memory_responses_metadata); 1 external calls (new).


##### `CodexResponsesMetadata::has_turn_metadata`  (lines 177–179)

```
fn has_turn_metadata(&self) -> bool
```

**Purpose**: Reports whether this metadata snapshot should emit the structured turn-metadata blob. The decision is based solely on whether a request kind has been assigned.

**Data flow**: It reads `self.request_kind` and returns `true` when it is `Some(_)` and `false` otherwise. It does not mutate state.

**Call relations**: Both `client_metadata` and `compatibility_headers` call this method to gate emission of `x-codex-turn-metadata`. It is a small guard that prevents empty or meaningless metadata blobs from being attached.

*Call graph*: called by 2 (client_metadata, compatibility_headers).


##### `CodexResponsesMetadata::turn_metadata_json`  (lines 181–183)

```
fn turn_metadata_json(&self) -> Option<String>
```

**Purpose**: Serializes the canonical turn metadata payload into an ASCII-safe JSON string suitable for transport in metadata fields and headers.

**Data flow**: It reads the current struct state, builds a borrowed `CodexTurnMetadataPayload` via `turn_metadata_payload`, then passes that payload to `to_ascii_json_string`. If serialization succeeds it returns `Some(String)`; on serialization failure it returns `None` rather than propagating an error.

**Call relations**: This method is called by both `client_metadata` and `compatibility_headers` when they need the canonical JSON blob. It delegates all field-shaping decisions to `turn_metadata_payload` and all string encoding to the external JSON utility.

*Call graph*: calls 1 internal fn (turn_metadata_payload); called by 2 (client_metadata, compatibility_headers); 1 external calls (to_ascii_json_string).


##### `CodexResponsesMetadata::turn_metadata_value`  (lines 185–187)

```
fn turn_metadata_value(&self) -> Option<Value>
```

**Purpose**: Serializes the canonical turn metadata payload into a `serde_json::Value` for in-process consumers that want structured JSON rather than a string.

**Data flow**: It reads the struct, constructs the borrowed payload with `turn_metadata_payload`, and converts it using `serde_json::to_value`. It returns `Some(Value)` on success or `None` if serialization fails.

**Call relations**: This is the structured counterpart to `turn_metadata_json`. It shares the same payload-building path but is intended for callers that need JSON values instead of transport strings.

*Call graph*: calls 1 internal fn (turn_metadata_payload); 1 external calls (to_value).


##### `CodexResponsesMetadata::client_metadata`  (lines 189–220)

```
fn client_metadata(&self) -> HashMap<String, String>
```

**Purpose**: Builds the flat `client_metadata` map sent with Responses requests, including compatibility projections of the canonical metadata snapshot.

**Data flow**: It starts a `HashMap<String, String>` with installation ID, session ID, thread ID, and window ID under specific header/key names. It conditionally inserts `turn_id`, `x-openai-subagent`, and parent thread ID when present, and if `has_turn_metadata()` is true and `turn_metadata_json()` succeeds, it inserts the serialized blob under `x-codex-turn-metadata`. It returns the completed map without mutating `self`.

**Call relations**: This method is used by request builders such as `build_responses_request` and websocket metadata assembly in `build_ws_client_metadata`. It depends on `has_turn_metadata` and `turn_metadata_json` to decide whether to include the canonical turn metadata projection.

*Call graph*: calls 2 internal fn (has_turn_metadata, turn_metadata_json); called by 2 (build_responses_request, build_ws_client_metadata); 1 external calls (from).


##### `CodexResponsesMetadata::compatibility_headers`  (lines 222–247)

```
fn compatibility_headers(&self) -> ApiHeaderMap
```

**Purpose**: Builds direct HTTP headers that mirror selected metadata fields for older or compatibility-oriented consumers. It intentionally treats these headers as projections of the canonical metadata object, not independent sources of truth.

**Data flow**: It creates a new `http::HeaderMap`, inserts the window ID header unconditionally, then conditionally inserts `x-codex-turn-metadata`, parent thread ID, and subagent headers when those values are present and serializable. Header insertion is delegated to `insert_header`, which silently skips invalid header values. The method returns the populated `HeaderMap`.

**Call relations**: This method is called by `build_responses_compatibility_headers` when constructing outbound HTTP requests. It mirrors the same turn-metadata gating used by `client_metadata` and delegates actual header parsing/insertion to `insert_header`.

*Call graph*: calls 3 internal fn (has_turn_metadata, turn_metadata_json, insert_header); called by 1 (build_responses_compatibility_headers); 1 external calls (new).


##### `CodexResponsesMetadata::turn_metadata_payload`  (lines 249–280)

```
fn turn_metadata_payload(&self) -> CodexTurnMetadataPayload<'_>
```

**Purpose**: Assembles the canonical borrowed payload object that all turn-metadata serialization flows use. It encodes the file's key inclusion rules, especially around request kind and identity suppression.

**Data flow**: It reads all fields from `self`, derives `(request_kind_value, compaction)` from `self.request_kind` via `CodexResponsesRequestKind::metadata`, computes `has_turn_identity` and `has_request_identity` using `CodexResponsesRequestKind::has_turn_identity`, and constructs a `CodexTurnMetadataPayload<'_>`. Identity fields such as installation ID and window ID are included only when appropriate; `turn_id` is flattened from `Option<Option<&str>>`; `workspaces` is passed through `non_empty_workspaces` so empty maps serialize as absent; and `extra` is flattened into the payload. It returns the borrowed payload object.

**Call relations**: This internal method is the shared source for both `turn_metadata_json` and `turn_metadata_value`. It delegates only the empty-workspace suppression to `non_empty_workspaces`; all other shaping logic lives here.

*Call graph*: calls 1 internal fn (non_empty_workspaces); called by 2 (turn_metadata_json, turn_metadata_value).


##### `subagent_header_value`  (lines 283–302)

```
fn subagent_header_value(session_source: &SessionSource) -> Option<String>
```

**Purpose**: Translates a `SessionSource` into the legacy string value used for the `x-openai-subagent` header. It preserves known labels for specific subagent and internal memory-consolidation sources.

**Data flow**: It pattern-matches on `&SessionSource` and returns `Some(String)` for subagent-related sources such as review, compact, memory consolidation, thread spawn, or custom `Other(label)` values; for CLI, VSCode, Exec, MCP, Custom, and Unknown sources it returns `None`. It clones or constructs the returned string as needed.

**Call relations**: This helper is used while building metadata and headers in flows such as `build_subagent_headers`, `responses_metadata`, and `detached_memory_responses_metadata`. It provides the compatibility header representation, distinct from the richer metadata kind.

*Call graph*: called by 4 (build_subagent_headers, responses_metadata, new, detached_memory_responses_metadata).


##### `subagent_metadata_kind`  (lines 304–315)

```
fn subagent_metadata_kind(session_source: &SessionSource) -> Option<String>
```

**Purpose**: Extracts the normalized subagent kind string for inclusion in structured turn metadata. Unlike the header helper, it only emits values for actual `SubAgent` session sources.

**Data flow**: It reads `&SessionSource`, returns `Some(subagent_source.kind().to_string())` for `SessionSource::SubAgent(_)`, and `None` for all other source categories including internal sessions. It allocates only the returned string.

**Call relations**: This function is called during metadata construction in `new`-style metadata assembly paths to populate `subagent_kind`. It complements `subagent_header_value` by feeding the canonical metadata blob rather than the compatibility header.

*Call graph*: called by 1 (new).


##### `insert_header`  (lines 317–321)

```
fn insert_header(headers: &mut ApiHeaderMap, name: &'static str, value: &str)
```

**Purpose**: Safely inserts a string header into an HTTP header map only when the value can be parsed as a valid `HeaderValue`. Invalid values are dropped rather than causing request construction to fail.

**Data flow**: It takes a mutable `ApiHeaderMap`, a static header name, and a string value. It attempts `HeaderValue::from_str(value)` and, on success, inserts the parsed value into the map; on failure it performs no insertion and returns `()`. The only mutation is to the provided header map.

**Call relations**: This helper is used exclusively by `CodexResponsesMetadata::compatibility_headers` to centralize header validation and insertion. It prevents malformed metadata strings from poisoning the entire header set.

*Call graph*: called by 1 (compatibility_headers); 2 external calls (insert, from_str).


##### `filter_extra_metadata`  (lines 323–328)

```
fn filter_extra_metadata(extra: HashMap<String, String>) -> BTreeMap<String, String>
```

**Purpose**: Removes caller-supplied metadata entries that would collide with Codex-owned keys or compatibility header names. It enforces the invariant that external metadata can enrich but not override core metadata.

**Data flow**: It takes an owned `HashMap<String, String>`, iterates through its entries, filters out any whose key appears in `RESERVED_METADATA_KEYS`, and collects the survivors into a `BTreeMap<String, String>`. It returns that filtered map.

**Call relations**: This function is called by `set_responsesapi_client_metadata` when extra metadata enters turn state. Its output later becomes the flattened `extra` portion of `CodexTurnMetadataPayload`.

*Call graph*: called by 1 (set_responsesapi_client_metadata).


##### `non_empty_workspaces`  (lines 330–334)

```
fn non_empty_workspaces(
    workspaces: &BTreeMap<String, TurnMetadataWorkspace>,
) -> Option<&BTreeMap<String, TurnMetadataWorkspace>>
```

**Purpose**: Converts an empty workspace map into `None` so serialization omits the field entirely. Non-empty maps are passed through by reference.

**Data flow**: It reads a borrowed `BTreeMap<String, TurnMetadataWorkspace>` and returns `Some(&map)` when the map is non-empty or `None` when it is empty. It performs no allocation or mutation.

**Call relations**: This helper is called only by `CodexResponsesMetadata::turn_metadata_payload` to implement `skip_serializing_if` behavior for workspace metadata without cloning the map.

*Call graph*: called by 1 (turn_metadata_payload).


### `codex-api/src/requests/responses.rs`

`domain_logic` · `request payload preparation`

This file is small but important for request fidelity. The `Compression` enum is the API-facing choice for request-body compression, with `None` as the default and `Zstd` as the only compressed option. Higher layers can expose this enum without leaking transport-specific details.

The main behavior is `attach_item_ids`, which mutates a JSON payload before it is sent to the Responses API. The function expects the payload to contain an `input` field that is a JSON array aligned positionally with the original `&[ResponseItem]` slice used to build the payload. If either assumption fails—missing `input`, non-array `input`, non-object array elements—it exits quietly rather than erroring.

For each zipped pair of serialized JSON value and original `ResponseItem`, it selectively copies the item's `id` into the outgoing JSON object. Only item variants that can carry stable IDs are considered: `Reasoning`, `Message` with `Some(id)`, `WebSearchCall`, `FunctionCall`, `ToolSearchCall`, `LocalShellCall`, and `CustomToolCall`, each requiring a present non-empty ID. Empty IDs are intentionally skipped. This logic is especially relevant for providers such as Azure that expect stored input items to retain explicit IDs even if the default serializer omitted them.

#### Function details

##### `attach_item_ids`  (lines 11–37)

```
fn attach_item_ids(payload_json: &mut Value, original_items: &[ResponseItem])
```

**Purpose**: Copies stable item IDs from the original typed `ResponseItem` list into the serialized JSON request payload's `input` array. It only touches item variants that meaningfully support IDs and skips empty IDs.

**Data flow**: Takes mutable access to `payload_json` and a borrowed slice of `original_items`. It looks up `payload_json["input"]`, returns early if absent or not a `Value::Array`, then iterates `items.iter_mut().zip(original_items.iter())`. For matching `ResponseItem` variants with a non-empty `id`, it mutates the corresponding JSON object by inserting an `"id"` field containing a cloned `Value::String`.

**Call relations**: This helper is used during Responses request construction when the serialized payload needs to preserve item identity from the original typed request model.

*Call graph*: 3 external calls (String, get_mut, iter).


### `tools/src/responses_api.rs`

`io_transport` · `tool spec serialization and API adaptation`

This module is the translation layer between internal tool metadata and the JSON shape expected by the Responses API. It defines several serializable structs and enums: `FreeformTool` and `FreeformToolFormat` for freeform tools, `ResponsesApiTool` for function-style tools, `LoadableToolSpec` as a tagged enum that can be either a top-level function or a namespace, `ResponsesApiNamespace` for grouped tools, and `ResponsesApiNamespaceTool` for tools nested inside a namespace. Serialization details matter here: `LoadableToolSpec` and `ResponsesApiNamespaceTool` use `#[serde(tag = "type")]`, `ResponsesApiTool.defer_loading` is omitted when `None`, and `output_schema` is skipped entirely during serialization even though it is retained in memory. The conversion functions all funnel through `tool_definition_to_responses_api_tool`, which copies name, description, input schema, and output schema from `ToolDefinition`, forces `strict` to `false`, and maps the internal boolean `defer_loading` into `Option<bool>` so only `true` serializes. `dynamic_tool_to_responses_api_tool` parses a `DynamicToolFunctionSpec`, while the MCP adapters parse an `rmcp::model::Tool`, rename it to the externally chosen `ToolName`, and optionally mark it deferred by clearing output schema and setting defer-loading. `coalesce_loadable_tool_specs` preserves order while merging namespace entries that share the same namespace name by appending child tools into the first matching namespace encountered.

#### Function details

##### `default_namespace_description`  (lines 58–60)

```
fn default_namespace_description(namespace_name: &str) -> String
```

**Purpose**: Generates the fallback human-readable description for a namespace when no custom description is supplied. The wording is fixed and derived solely from the namespace name.

**Data flow**: Accepts `namespace_name: &str`, interpolates it into the string `"Tools in the {namespace_name} namespace."`, and returns the resulting `String` without mutating any external state.

**Call relations**: This is a small helper used wherever namespace specs need a default description. It does not call into other module logic beyond string formatting.

*Call graph*: 1 external calls (format!).


##### `dynamic_tool_to_responses_api_tool`  (lines 69–75)

```
fn dynamic_tool_to_responses_api_tool(
    tool: &DynamicToolFunctionSpec,
) -> Result<ResponsesApiTool, serde_json::Error>
```

**Purpose**: Converts a dynamic tool function spec from protocol form into a `ResponsesApiTool`. It first normalizes the dynamic spec into the crate’s internal `ToolDefinition` and then maps that into the Responses API shape.

**Data flow**: Takes `&DynamicToolFunctionSpec`, passes it to `parse_dynamic_tool` to deserialize and validate its input schema into a `ToolDefinition`, then feeds the result into `tool_definition_to_responses_api_tool`. Returns `Result<ResponsesApiTool, serde_json::Error>`, propagating parse failures unchanged.

**Call relations**: This adapter is one of the public entry points into the module’s conversion pipeline. It delegates parsing to `parse_dynamic_tool` and relies on `tool_definition_to_responses_api_tool` for the final field mapping.

*Call graph*: calls 1 internal fn (tool_definition_to_responses_api_tool); 1 external calls (parse_dynamic_tool).


##### `coalesce_loadable_tool_specs`  (lines 77–105)

```
fn coalesce_loadable_tool_specs(
    specs: impl IntoIterator<Item = LoadableToolSpec>,
) -> Vec<LoadableToolSpec>
```

**Purpose**: Merges multiple `LoadableToolSpec` values into a single list where namespaces with the same name are combined. Top-level function specs are preserved as independent entries.

**Data flow**: Consumes any iterator of `LoadableToolSpec` and builds a new `Vec<LoadableToolSpec>`. For each `Function`, it pushes the spec directly. For each `Namespace`, it searches the accumulated vector for an existing namespace with the same `name`; if found, it appends the incoming namespace’s `tools` into the existing namespace’s `tools`, otherwise it pushes the namespace as a new entry. Returns the coalesced vector.

**Call relations**: This function sits after individual tool specs have already been constructed and before they are serialized or exposed. It does not parse tools itself; instead it organizes already-built `LoadableToolSpec` values into a more compact namespace layout.

*Call graph*: 3 external calls (new, Function, Namespace).


##### `mcp_tool_to_responses_api_tool`  (lines 107–114)

```
fn mcp_tool_to_responses_api_tool(
    tool_name: &ToolName,
    tool: &rmcp::model::Tool,
) -> Result<ResponsesApiTool, serde_json::Error>
```

**Purpose**: Converts an MCP tool into a non-deferred `ResponsesApiTool`, renaming it to the externally selected `ToolName`. It preserves output schema information from the parsed MCP definition.

**Data flow**: Accepts a `&ToolName` and `&rmcp::model::Tool`, parses the MCP tool with `parse_mcp_tool` into a `ToolDefinition`, replaces the definition’s name via `renamed(tool_name.name.clone())`, and converts the result with `tool_definition_to_responses_api_tool`. Returns a `Result`, forwarding any JSON/schema parse error.

**Call relations**: This is the standard MCP conversion path used when the tool should be fully described up front. It delegates schema extraction to `parse_mcp_tool`, name rewriting to `ToolDefinition::renamed`, and final API-shape mapping to `tool_definition_to_responses_api_tool`.

*Call graph*: calls 1 internal fn (tool_definition_to_responses_api_tool); 1 external calls (parse_mcp_tool).


##### `mcp_tool_to_deferred_responses_api_tool`  (lines 116–125)

```
fn mcp_tool_to_deferred_responses_api_tool(
    tool_name: &ToolName,
    tool: &rmcp::model::Tool,
) -> Result<ResponsesApiTool, serde_json::Error>
```

**Purpose**: Converts an MCP tool into a deferred-loading `ResponsesApiTool`. Compared with the non-deferred path, it explicitly strips output schema and marks the tool as deferred before serialization.

**Data flow**: Takes `&ToolName` and `&rmcp::model::Tool`, parses the MCP tool, renames it to `tool_name.name.clone()`, then calls `into_deferred()` on the `ToolDefinition` to clear `output_schema` and set `defer_loading = true`. The transformed definition is then mapped into `ResponsesApiTool` and returned as `Result<ResponsesApiTool, serde_json::Error>`.

**Call relations**: This function is the deferred counterpart to `mcp_tool_to_responses_api_tool`. It follows the same parse-and-rename pipeline but inserts the `ToolDefinition::into_deferred` transformation before the final conversion.

*Call graph*: calls 1 internal fn (tool_definition_to_responses_api_tool); 1 external calls (parse_mcp_tool).


##### `tool_definition_to_responses_api_tool`  (lines 127–136)

```
fn tool_definition_to_responses_api_tool(tool_definition: ToolDefinition) -> ResponsesApiTool
```

**Purpose**: Performs the direct field-by-field conversion from the crate’s internal `ToolDefinition` into the Responses API function-tool struct. It centralizes the mapping used by all higher-level adapters.

**Data flow**: Consumes a `ToolDefinition`, moving out its `name`, `description`, `input_schema`, and `output_schema`. It constructs and returns a `ResponsesApiTool` with `strict` hard-coded to `false`, `defer_loading` set to `Some(true)` only when `tool_definition.defer_loading` is true, and `parameters` populated from `input_schema`.

**Call relations**: This is the common sink for `dynamic_tool_to_responses_api_tool`, `mcp_tool_to_responses_api_tool`, and `mcp_tool_to_deferred_responses_api_tool`. Those callers handle parsing and optional renaming/deferment; this function only performs the final structural mapping.

*Call graph*: called by 3 (dynamic_tool_to_responses_api_tool, mcp_tool_to_deferred_responses_api_tool, mcp_tool_to_responses_api_tool).


### `codex-api/src/api_bridge.rs`

`domain_logic` · `error handling`

This file is the boundary between `codex-api`'s internal `ApiError`/`TransportError` types and the protocol-facing `CodexErr` enum consumed by callers. The main function, `map_api_error`, performs a large pattern match over semantic API errors first, then drills into HTTP transport failures by status code and sometimes by JSON body contents or response headers.

Several branches contain nuanced behavior. A 503 with JSON error code `server_is_overloaded` or `slow_down` is normalized to `CodexErr::ServerOverloaded`. A 400 body is parsed for `error.code == "cyber_policy"`; if present, it extracts a non-empty message or falls back to a fixed cybersecurity warning. Another 400 special-case recognizes the invalid-image text emitted by image endpoints. For 429 responses, the code attempts to deserialize a `UsageErrorResponse`; `usage_limit_reached` becomes `UsageLimitReachedError` enriched with plan type, reset timestamp, parsed rate-limit snapshot, promo message, and reached-type metadata from headers, while `usage_not_included` maps separately. Unrecognized 429s become `RetryLimitReachedError` with a tracking ID.

Helper functions encapsulate header lookup precedence: request IDs prefer `x-request-id` then `x-oai-request-id`, tracking IDs fall back to `cf-ray`, and `x-error-json` is base64-decoded and parsed to extract an identity error code. The result is a single place where wire-level quirks are normalized into stable protocol errors.

#### Function details

##### `map_api_error`  (lines 18–137)

```
fn map_api_error(err: ApiError) -> CodexErr
```

**Purpose**: Converts an `ApiError` into the externally exposed `CodexErr`, including status-specific HTTP decoding and header/body enrichment.

**Data flow**: Consumes an `ApiError` and pattern-matches it. Simple semantic variants map directly to corresponding `CodexErr` variants. For `ApiError::Transport`, it inspects the nested `TransportError`: HTTP errors read status, optional URL, optional headers, and optional body text; parse JSON bodies for overload, cyber-policy, and usage-limit cases; extract request IDs, Cloudflare ray IDs, authorization error headers, and base64-encoded identity error codes; and build structured `UnexpectedResponseError`, `UsageLimitReachedError`, or `RetryLimitReachedError` values. It returns a fully translated `CodexErr` and writes no shared state.

**Call relations**: This is the file's central adapter and the only consumer of the helper extraction functions. It delegates repeated header parsing to `extract_header`, `extract_request_id`, `extract_request_tracking_id`, and `extract_x_error_json_code` so the status-handling branches stay focused on mapping logic.

*Call graph*: calls 4 internal fn (extract_header, extract_request_id, extract_request_tracking_id, extract_x_error_json_code); 7 external calls (matches!, InvalidImageRequest, InvalidRequest, RetryLimit, Stream, UnexpectedStatus, UsageLimitReached).


##### `extract_request_tracking_id`  (lines 153–155)

```
fn extract_request_tracking_id(headers: Option<&HeaderMap>) -> Option<String>
```

**Purpose**: Finds the best available request-tracking identifier for retry-limit style errors.

**Data flow**: Takes optional response headers, first asks `extract_request_id` for a canonical request ID, and if absent falls back to the `cf-ray` header via `extract_header`. It returns `Option<String>` and does not mutate state.

**Call relations**: Called only from `map_api_error` when constructing `RetryLimitReachedError`, where either a request ID or Cloudflare ray ID is useful for support/debugging.

*Call graph*: calls 1 internal fn (extract_request_id); called by 1 (map_api_error).


##### `extract_request_id`  (lines 157–160)

```
fn extract_request_id(headers: Option<&HeaderMap>) -> Option<String>
```

**Purpose**: Extracts the canonical request ID from response headers using the preferred header order.

**Data flow**: Reads optional headers and tries `x-request-id` first, then `x-oai-request-id`, returning the first successfully decoded header value as an owned `String`. No state is modified.

**Call relations**: Used directly by `map_api_error` for unexpected-status errors and indirectly by `extract_request_tracking_id` to preserve the preferred request-ID precedence.

*Call graph*: calls 1 internal fn (extract_header); called by 2 (extract_request_tracking_id, map_api_error).


##### `extract_header`  (lines 162–168)

```
fn extract_header(headers: Option<&HeaderMap>, name: &str) -> Option<String>
```

**Purpose**: Safely reads a named HTTP header as UTF-8 text.

**Data flow**: Given optional `HeaderMap` and a header name, it looks up the header, attempts `to_str()`, and converts the result into an owned `String`. Invalid or missing headers yield `None` rather than an error.

**Call relations**: This is the low-level helper used by all other extraction functions and by `map_api_error` itself for fields like active limit ID, Cloudflare ray, and authorization error details.

*Call graph*: called by 3 (extract_request_id, extract_x_error_json_code, map_api_error).


##### `extract_x_error_json_code`  (lines 170–181)

```
fn extract_x_error_json_code(headers: Option<&HeaderMap>) -> Option<String>
```

**Purpose**: Decodes the `x-error-json` header and extracts the nested `error.code` field when present.

**Data flow**: Reads the `x-error-json` header via `extract_header`, base64-decodes it, parses the decoded bytes as JSON `Value`, navigates to `error.code`, and returns that string if all steps succeed. Any missing header, invalid base64, invalid JSON, or absent code produces `None`.

**Call relations**: Used by `map_api_error` when building `UnexpectedResponseError` for identity/auth failures, allowing callers to see a structured backend error code even when it is only present in encoded header metadata.

*Call graph*: calls 1 internal fn (extract_header); called by 1 (map_api_error).


### Responses and endpoint clients
These files implement the concrete HTTP, SSE, and WebSocket clients for Responses and adjacent provider endpoints that the core client can invoke.

### `codex-api/src/endpoint/responses.rs`

`io_transport` · `request handling`

This file defines `ResponsesClient<T>`, a thin endpoint-specific wrapper around `EndpointSession<T>` for the Responses API over HTTP with server-sent events. The client stores the shared session machinery plus optional SSE telemetry. `ResponsesOptions` carries per-request metadata such as `session_id`, `thread_id`, `session_source`, arbitrary extra headers, request compression, and an optional `OnceLock<String>` used to capture turn state returned by the server.

There are two public streaming entrypoints. `stream_request` accepts a typed `ResponsesApiRequest`; it conditionally rewrites the JSON body for Azure's responses endpoint when `request.store` is true by serializing to `serde_json::Value`, calling `attach_item_ids` on `request.input`, and then encoding that modified body. Otherwise it encodes the typed request directly. It then mutates headers in a specific order: starts from caller-supplied headers, mirrors `thread_id` into `x-client-request-id`, extends with `build_session_headers(session_id, thread_id)`, and optionally adds `x-openai-subagent` derived from `session_source`.

`stream` is the raw-JSON variant and simply encodes a provided `serde_json::Value`. Both paths converge in `stream_encoded`, which maps the crate's `Compression` enum to `codex_client::RequestCompression`, invokes `EndpointSession::stream_encoded_json_with` using `POST` to the fixed `responses` path, forces `Accept: text/event-stream`, and passes the resulting transport stream into `spawn_response_stream` along with provider idle timeout, optional SSE telemetry, and optional turn-state storage.

#### Function details

##### `ResponsesClient::new`  (lines 43–48)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a `ResponsesClient` bound to a transport, provider, and auth source, with SSE telemetry initially disabled. It is the standard factory for HTTP responses streaming.

**Data flow**: Consumes `transport: T`, `provider: Provider`, and `auth: SharedAuthProvider`, creates an `EndpointSession` from them, stores it in the client, and sets `sse_telemetry` to `None`. It returns the fully initialized `ResponsesClient<T>`.

**Call relations**: This constructor is used by callers and tests that need a fresh responses HTTP client. It delegates session setup to `EndpointSession::new`, after which later request methods reuse that shared session state.

*Call graph*: calls 1 internal fn (new); called by 8 (azure_default_store_attaches_ids_and_headers, responses_client_stream_request_preserves_exact_json_body, responses_client_uses_responses_path, streaming_client_adds_auth_headers, streaming_client_does_not_retry_auth_build_error, streaming_client_retries_on_transient_auth_error, streaming_client_retries_on_transport_error, responses_stream_parses_items_and_completed_end_to_end).


##### `ResponsesClient::with_telemetry`  (lines 50–59)

```
fn with_telemetry(
        self,
        request: Option<Arc<dyn RequestTelemetry>>,
        sse: Option<Arc<dyn SseTelemetry>>,
    ) -> Self
```

**Purpose**: Returns a copy of the client configured with request-level telemetry and optional SSE telemetry hooks. It is a builder-style customization step rather than a mutating setter.

**Data flow**: Consumes `self`, plus optional `Arc<dyn RequestTelemetry>` and `Arc<dyn SseTelemetry>`. It replaces the embedded session with `self.session.with_request_telemetry(request)` and stores the provided SSE telemetry handle, returning a new `ResponsesClient<T>`.

**Call relations**: This method is called after construction when the caller wants instrumentation around HTTP requests and SSE event processing. It delegates request telemetry wiring to `EndpointSession` and keeps SSE telemetry locally for later use in `stream_encoded`.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `ResponsesClient::stream_request`  (lines 71–107)

```
async fn stream_request(
        &self,
        request: ResponsesApiRequest,
        options: ResponsesOptions,
    ) -> Result<ResponseStream, ApiError>
```

**Purpose**: Builds and sends a typed Responses API request over HTTP streaming, including Azure-specific body rewriting and session/subagent headers. It is the high-level typed entrypoint most callers use.

**Data flow**: Accepts a `ResponsesApiRequest` and `ResponsesOptions`, destructures the options, then chooses how to encode the body. For Azure responses endpoints with `request.store == true`, it serializes the request to `Value`, mutates that JSON with `attach_item_ids(&mut body, &request.input)`, and encodes the modified value; otherwise it encodes the typed request directly. It then starts from `extra_headers`, optionally inserts `x-client-request-id` from `thread_id`, extends with `build_session_headers(session_id, thread_id)`, optionally inserts `x-openai-subagent` from `subagent_header(&session_source)`, and forwards the encoded body plus headers, compression, and turn-state sink to `stream_encoded`. It returns a `ResponseStream` or an `ApiError::Stream` if JSON encoding fails.

**Call relations**: This public method is the typed wrapper above `stream_encoded`. It consults `self.session.provider()` to detect Azure-specific behavior, uses header helpers to assemble request metadata, and then delegates the actual HTTP streaming setup to the shared lower-level method.

*Call graph*: calls 6 internal fn (stream_encoded, provider, build_session_headers, insert_header, subagent_header, encode); 2 external calls (attach_item_ids, to_value).


##### `ResponsesClient::path`  (lines 109–111)

```
fn path() -> &'static str
```

**Purpose**: Defines the fixed relative API path for this endpoint. It centralizes the literal so all request methods target the same route.

**Data flow**: Takes no arguments and returns the static string slice `"responses"`.

**Call relations**: This helper is used by `stream_encoded` when constructing the outbound POST request. Keeping it separate avoids repeating the endpoint path literal.


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

**Purpose**: Sends a raw JSON body to the Responses streaming endpoint without typed request preprocessing. It is the lower-friction variant for callers that already have a `serde_json::Value` payload.

**Data flow**: Accepts `body: Value`, `extra_headers`, `compression`, and optional `turn_state`. It encodes the JSON value into `EncodedJsonBody`, maps encoding failures into `ApiError::Stream`, and then forwards the encoded body and remaining parameters to `stream_encoded`. It returns the resulting `ResponseStream`.

**Call relations**: This method is a sibling to `stream_request`: both converge on `stream_encoded`, but this one skips typed request serialization, Azure item-ID attachment, and session-header assembly.

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

**Purpose**: Performs the actual HTTP streaming request setup for the Responses endpoint and wraps the transport stream as a parsed `ResponseStream`. It is the common implementation behind both typed and raw-body entrypoints.

**Data flow**: Takes an already encoded JSON body, caller-supplied headers, a `Compression` enum, and optional turn-state storage. It maps `Compression::{None,Zstd}` to `RequestCompression::{None,Zstd}`, then calls `self.session.stream_encoded_json_with(Method::POST, Self::path(), extra_headers, Some(body), |req| { ... })`. Inside the configure closure it inserts `Accept: text/event-stream` and sets `req.compression`. After awaiting the `StreamResponse`, it passes that stream, the provider's `stream_idle_timeout`, cloned SSE telemetry, and turn-state sink into `spawn_response_stream`, returning the resulting `ResponseStream`.

**Call relations**: This private method is called by both `stream_request` and `stream`. It relies on `EndpointSession` for authenticated transport setup and on `spawn_response_stream` to transform the raw SSE byte stream into higher-level response events.

*Call graph*: calls 2 internal fn (provider, stream_encoded_json_with); called by 2 (stream, stream_request); 2 external calls (path, spawn_response_stream).


### `codex-api/src/sse/responses.rs`

`io_transport` · `stream request handling`

This file turns a `codex_client::StreamResponse` byte stream into a channel-driven `ResponseStream` of typed `ResponseEvent`s. `spawn_response_stream` performs the initial HTTP-header pass before any SSE frames are read: it parses all rate-limit snapshots from headers, extracts `X-Models-Etag`, `openai-model`, `x-reasoning-included`, and `x-request-id`, optionally stores `x-codex-turn-state` into a shared `OnceLock<String>`, then spawns an async task that emits those header-derived events before entering the SSE loop.

The SSE payload side is modeled by `ResponsesStreamEvent`, a partially typed deserialization target that keeps flexible JSON fields (`headers`, `metadata`, `response`, `item`) as `serde_json::Value`. Helper methods derive higher-level metadata from those blobs: `response_model` prefers `response.headers` over top-level `headers`, `model_verifications` only reads `response.metadata` events and deduplicates recognized verification strings, and `turn_moderation_metadata` wraps a raw metadata JSON value into `TurnModerationMetadataEvent`.

`process_responses_event` is the event classifier. It maps known event kinds like `response.output_item.done`, text/tool/reasoning deltas, `response.created`, and `response.completed` into `ResponseEvent`s, while `response.failed` is converted into a typed `ApiError`. Error classification is concrete and ordered: context-window, quota, usage-not-included, cyber-policy, invalid-prompt, and overloaded-server codes become specific fatal variants; everything else becomes `ApiError::Retryable` with an optional delay parsed from human-readable rate-limit text. `process_sse` enforces an idle timeout around each poll, reports poll timing to optional `SseTelemetry`, emits model/verification/moderation metadata as soon as seen, remembers the last emitted server model to avoid duplicates, and only terminates cleanly after sending a `Completed` event. If the stream closes first, it emits either the last remembered API error or a generic `stream closed before response.completed` error.

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

**Purpose**: Creates the public `ResponseStream` wrapper around an HTTP streaming response and launches the background SSE-processing task. It emits header-derived metadata events before consuming any SSE frames.

**Data flow**: Reads `stream_response.headers` to compute rate-limit snapshots, optional models etag, optional server model, reasoning-included flag, optional upstream request id, and optional turn-state header. If a shared `OnceLock<String>` is provided and the turn-state header exists, it stores that string. It creates an `mpsc` channel, spawns a task that sends initial `ResponseEvent::ServerModel`, `RateLimits`, `ModelsEtag`, and `ServerReasoningIncluded` messages as applicable, then awaits `process_sse(stream_response.bytes, tx_event, idle_timeout, telemetry)`. It returns `ResponseStream { rx_event, upstream_request_id }`.

**Call relations**: Higher-level Responses client code calls this after obtaining a `StreamResponse` from the transport. It delegates ongoing byte-stream decoding to `process_sse` and uses `parse_all_rate_limits` to surface header metadata immediately.

*Call graph*: calls 2 internal fn (parse_all_rate_limits, process_sse); called by 2 (spawn_response_stream_emits_header_events, spawn_response_stream_ignores_model_verification_header); 5 external calls (ModelsEtag, RateLimits, ServerModel, ServerReasoningIncluded, spawn).


##### `TokenUsage::from`  (lines 120–134)

```
fn from(val: ResponseCompletedUsage) -> Self
```

**Purpose**: Converts the wire-format `ResponseCompletedUsage` struct into the protocol-level `TokenUsage` used by downstream consumers. Missing nested detail blocks default their specialized counts to zero.

**Data flow**: Consumes a `ResponseCompletedUsage`, copies `input_tokens`, `output_tokens`, and `total_tokens`, extracts `cached_tokens` from `input_tokens_details` if present or uses `0`, extracts `reasoning_tokens` from `output_tokens_details` if present or uses `0`, and returns a new `TokenUsage`.

**Call relations**: This conversion is used when `process_responses_event` successfully parses a `response.completed` payload and needs to attach token accounting to `ResponseEvent::Completed`.


##### `ResponsesStreamEvent::kind`  (lines 163–165)

```
fn kind(&self) -> &str
```

**Purpose**: Returns the event type string stored in the deserialized SSE payload. It is a tiny accessor used to keep kind checks consistent.

**Data flow**: Borrows `self.kind` and returns it as `&str` without allocation or mutation.

**Call relations**: The metadata helper methods `turn_state`, `model_verifications`, and `turn_moderation_metadata` call this first to ensure they only inspect `response.metadata` events.

*Call graph*: called by 3 (model_verifications, turn_moderation_metadata, turn_state).


##### `ResponsesStreamEvent::response_model`  (lines 172–186)

```
fn response_model(&self) -> Option<String>
```

**Purpose**: Extracts the effective server model name from event JSON, preferring nested `response.headers` over top-level `headers`. This matches the precedence documented in the method comment.

**Data flow**: Reads `self.response`, looks for a nested `headers` object, and passes it to `header_openai_model_value_from_json`. If that yields `Some(model)`, it returns it; otherwise it falls back to `self.headers` and the same helper. The result is an owned `Option<String>`.

**Call relations**: The SSE loop uses this on every parsed event to emit `ResponseEvent::ServerModel` whenever the reported model changes.


##### `ResponsesStreamEvent::turn_state`  (lines 188–196)

```
fn turn_state(&self) -> Option<String>
```

**Purpose**: Extracts the turn-state header from metadata events only. Non-metadata events are ignored even if they happen to contain a `headers` field.

**Data flow**: Checks `self.kind()` and returns `None` unless it equals `response.metadata`. For metadata events, it reads `self.headers` and passes the JSON value to `header_turn_state_value_from_json`, returning the resulting optional string.

**Call relations**: This helper encapsulates the event-kind guard for turn-state extraction; callers do not need to inspect raw JSON directly.

*Call graph*: calls 1 internal fn (kind).


##### `ResponsesStreamEvent::model_verifications`  (lines 198–207)

```
fn model_verifications(&self) -> Option<Vec<ModelVerification>>
```

**Purpose**: Parses model-verification recommendations from metadata events into a deduplicated vector of known `ModelVerification` enums. Unknown strings and non-metadata events are ignored.

**Data flow**: Returns `None` unless `self.kind()` is `response.metadata`. For metadata events, it reads `self.metadata["openai_verification_recommendation"]` and passes that JSON value to `model_verifications_from_json_value`, returning the helper's `Option<Vec<ModelVerification>>`.

**Call relations**: The SSE loop calls this before normal event processing so verification recommendations can be emitted as standalone `ResponseEvent::ModelVerifications` messages.

*Call graph*: calls 1 internal fn (kind).


##### `ResponsesStreamEvent::turn_moderation_metadata`  (lines 209–219)

```
fn turn_moderation_metadata(&self) -> Option<TurnModerationMetadataEvent>
```

**Purpose**: Extracts moderation metadata from metadata events and wraps the raw JSON in `TurnModerationMetadataEvent`. It preserves the payload verbatim rather than interpreting its schema here.

**Data flow**: Returns `None` unless `self.kind()` is `response.metadata`. For metadata events, it clones `self.metadata["openai_chatgpt_moderation_metadata"]` if present and maps it into `TurnModerationMetadataEvent { metadata }`.

**Call relations**: The SSE loop uses this to emit moderation metadata as soon as it appears, separate from the main response-item event stream.

*Call graph*: calls 1 internal fn (kind).


##### `header_openai_model_value_from_json`  (lines 222–232)

```
fn header_openai_model_value_from_json(value: &Value) -> Option<String>
```

**Purpose**: Finds an OpenAI model header inside a JSON object, accepting either `openai-model` or `x-openai-model` case-insensitively. It also tolerates header values represented as arrays.

**Data flow**: Treats the input `Value` as an object, iterates its key/value pairs, and for the first key matching the accepted header names calls `json_value_as_string` on the value. It returns the resulting `Option<String>`.

**Call relations**: This helper underpins `ResponsesStreamEvent::response_model` for both nested response headers and top-level metadata headers.

*Call graph*: 1 external calls (as_object).


##### `header_turn_state_value_from_json`  (lines 234–243)

```
fn header_turn_state_value_from_json(value: &Value) -> Option<String>
```

**Purpose**: Finds the `x-codex-turn-state` header inside a JSON object, ignoring key case. It converts the associated JSON value into a string using the same tolerant logic as model-header parsing.

**Data flow**: Treats the input `Value` as an object, scans entries for a key equal to `X_CODEX_TURN_STATE_HEADER` ignoring ASCII case, and returns `json_value_as_string(value)` for the first match.

**Call relations**: This helper is used by `ResponsesStreamEvent::turn_state` to isolate the JSON header-scanning logic.

*Call graph*: 1 external calls (as_object).


##### `model_verifications_from_json_value`  (lines 245–268)

```
fn model_verifications_from_json_value(value: &Value) -> Option<Vec<ModelVerification>>
```

**Purpose**: Converts a JSON array of verification recommendation strings into a deduplicated vector of recognized `ModelVerification` values. Empty, malformed, or entirely unknown inputs collapse to `None`.

**Data flow**: If `value` is an array, it iterates string elements, maps each through `parse_model_verification`, and pushes only values not already present into a local `Vec<ModelVerification>`. Non-array input yields an empty vector. It returns `Some(vec)` when the vector is non-empty, otherwise `None`.

**Call relations**: This helper is called by `ResponsesStreamEvent::model_verifications` after the metadata field has been located.

*Call graph*: 1 external calls (as_array).


##### `parse_model_verification`  (lines 270–275)

```
fn parse_model_verification(value: &str) -> Option<ModelVerification>
```

**Purpose**: Maps a raw verification recommendation string to a known `ModelVerification` enum variant. At present it recognizes only the trusted-access-for-cyber marker.

**Data flow**: Matches the input `&str` against `TRUSTED_ACCESS_FOR_CYBER_VERIFICATION` and returns `Some(ModelVerification::TrustedAccessForCyber)` for that exact token, otherwise `None`.

**Call relations**: This is the per-item decoder used by `model_verifications_from_json_value`.


##### `json_value_as_string`  (lines 277–283)

```
fn json_value_as_string(value: &Value) -> Option<String>
```

**Purpose**: Extracts a string from a JSON value, with special handling for arrays by recursively reading the first element. This accommodates header representations that may be scalar or list-valued.

**Data flow**: If `value` is `Value::String`, it clones and returns the string. If it is `Value::Array`, it takes the first element and recursively tries again. All other JSON types return `None`.

**Call relations**: Header-parsing helpers use this to normalize JSON header values before comparing or emitting them.

*Call graph*: 1 external calls (clone).


##### `ResponsesEventError::into_api_error`  (lines 291–295)

```
fn into_api_error(self) -> ApiError
```

**Purpose**: Unwraps the internal event-processing error wrapper into the underlying `ApiError`. The enum currently has only one variant, but this method isolates callers from that representation.

**Data flow**: Consumes `self`, pattern-matches `ResponsesEventError::Api(error)`, and returns the contained `ApiError`.

**Call relations**: The SSE loop uses this when `process_responses_event` reports an error so it can remember the last API error seen before stream termination.


##### `process_responses_event`  (lines 298–432)

```
fn process_responses_event(
    event: ResponsesStreamEvent,
) -> std::result::Result<Option<ResponseEvent>, ResponsesEventError>
```

**Purpose**: Interprets one deserialized `ResponsesStreamEvent` and converts it into either a typed `ResponseEvent`, no event, or an `ApiError`. It is the central event-kind dispatch table for Responses SSE payloads.

**Data flow**: Consumes a `ResponsesStreamEvent` and matches on `event.kind.as_str()`. For known success cases it reads fields like `item`, `delta`, `item_id`, `call_id`, `summary_index`, `content_index`, and `response`, deserializes nested JSON into `ResponseItem` or `ResponseCompleted` where needed, and returns `Ok(Some(ResponseEvent::...))`. For `response.failed`, it inspects the nested `error` object, deserializes it into the local `Error` struct, classifies codes with helpers such as `is_context_window_error`, `is_quota_exceeded_error`, `is_usage_not_included`, `is_cyber_policy_error`, `is_invalid_prompt_error`, and `is_server_overloaded_error`, optionally parses a retry delay with `try_parse_retry_after`, and returns `Err(ResponsesEventError::Api(...))`. Unknown or malformed-but-nonfatal events fall through to `Ok(None)` after optional debug/trace logging.

**Call relations**: This function is called on every parsed SSE payload by `process_sse`. It delegates specialized error classification and retry-delay extraction to the helper functions in this file so the main dispatch remains readable.

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

**Purpose**: Runs the main SSE read loop over a byte stream, enforcing idle timeouts, reporting telemetry, decoding JSON events, emitting metadata events, and forwarding typed response events onto a channel. It is responsible for deciding when the stream ends successfully versus with an error.

**Data flow**: Consumes a `ByteStream`, an `mpsc::Sender<Result<ResponseEvent, ApiError>>`, an `idle_timeout`, and optional `SseTelemetry`. It wraps the byte stream with `eventsource()`, then loops: records `Instant::now()`, awaits `timeout(idle_timeout, stream.next())`, reports the poll result and elapsed time to telemetry, and handles four poll outcomes—valid SSE event, SSE parser error, clean EOF, or timeout. Valid SSE data is deserialized into `ResponsesStreamEvent`; parse failures are logged and skipped. For each event it computes optional model verifications and moderation metadata, emits `ServerModel` only when changed from `last_server_model`, emits verification and moderation events immediately, then calls `process_responses_event`. Successful events are sent to the channel; if the event is `Completed`, the function returns immediately. Errors from `process_responses_event` are stored in `response_error` but not sent until the stream later closes, allowing the loop to prefer a terminal protocol error over a generic premature-close message.

**Call relations**: This is the worker launched by `spawn_response_stream`, and the test helpers `collect_events`, `run_sse`, and `emits_completed_without_stream_end` invoke it directly. It depends on `process_responses_event` for semantic decoding and on the telemetry trait for per-poll instrumentation.

*Call graph*: calls 1 internal fn (process_responses_event); called by 4 (spawn_response_stream, collect_events, emits_completed_without_stream_end, run_sse); 13 external calls (eventsource, next, now, send, ModelVerifications, ServerModel, TurnModerationMetadata, Stream, debug!, matches! (+3 more)).


##### `try_parse_retry_after`  (lines 531–555)

```
fn try_parse_retry_after(err: &Error) -> Option<Duration>
```

**Purpose**: Extracts a retry delay from a human-readable rate-limit error message when the error code is `rate_limit_exceeded`. It supports both fractional seconds and millisecond wording.

**Data flow**: Reads `err.code` and returns `None` unless it equals `rate_limit_exceeded`. It obtains a compiled regex from `rate_limit_regex`, applies it to `err.message`, parses the captured numeric value as `f64`, lowercases the captured unit, and returns `Duration::from_secs_f64(value)` for `s`/`second(s)` or `Duration::from_millis(value as u64)` for `ms`. Any mismatch or parse failure yields `None`.

**Call relations**: This helper is used during `response.failed` handling inside `process_responses_event` so retryable API errors can carry a server-suggested backoff.

*Call graph*: calls 1 internal fn (rate_limit_regex); called by 4 (process_responses_event, test_try_parse_retry_after, test_try_parse_retry_after_azure, test_try_parse_retry_after_no_delay); 2 external calls (from_millis, from_secs_f64).


##### `is_context_window_error`  (lines 557–559)

```
fn is_context_window_error(error: &Error) -> bool
```

**Purpose**: Checks whether an error code indicates the request exceeded the model context window. This maps directly to a fatal `ApiError::ContextWindowExceeded` classification.

**Data flow**: Reads `error.code` and returns true only when it is exactly `Some("context_length_exceeded")`.

**Call relations**: Called by `process_responses_event` early in failed-response classification.

*Call graph*: called by 1 (process_responses_event).


##### `is_quota_exceeded_error`  (lines 561–563)

```
fn is_quota_exceeded_error(error: &Error) -> bool
```

**Purpose**: Checks whether an error code indicates insufficient quota. This is treated as a fatal quota error rather than a generic retryable failure.

**Data flow**: Reads `error.code` and compares it to `Some("insufficient_quota")`, returning the boolean result.

**Call relations**: Used by `process_responses_event` when mapping `response.failed` payloads to specific `ApiError` variants.

*Call graph*: called by 1 (process_responses_event).


##### `is_usage_not_included`  (lines 565–567)

```
fn is_usage_not_included(error: &Error) -> bool
```

**Purpose**: Checks whether the server reported that usage information is unavailable or excluded. This becomes a dedicated `ApiError::UsageNotIncluded`.

**Data flow**: Reads `error.code` and returns true only for `Some("usage_not_included")`.

**Call relations**: Part of the ordered error-classification chain in `process_responses_event`.

*Call graph*: called by 1 (process_responses_event).


##### `is_invalid_prompt_error`  (lines 569–571)

```
fn is_invalid_prompt_error(error: &Error) -> bool
```

**Purpose**: Checks whether the server rejected the prompt as invalid. This drives conversion to `ApiError::InvalidRequest` with the server message preserved.

**Data flow**: Reads `error.code` and compares it to `Some("invalid_prompt")`.

**Call relations**: Used by `process_responses_event` after more specific fatal checks like context-window and quota errors.

*Call graph*: called by 1 (process_responses_event).


##### `is_cyber_policy_error`  (lines 573–575)

```
fn is_cyber_policy_error(error: &Error) -> bool
```

**Purpose**: Checks whether the failure was caused by cyber-policy enforcement. This triggers a dedicated `ApiError::CyberPolicy` path.

**Data flow**: Reads `error.code` and returns true only for `Some("cyber_policy")`.

**Call relations**: Called by `process_responses_event`, which then uses `cyber_policy_message` to ensure a non-empty user-facing message.

*Call graph*: called by 1 (process_responses_event).


##### `is_server_overloaded_error`  (lines 577–580)

```
fn is_server_overloaded_error(error: &Error) -> bool
```

**Purpose**: Checks whether the server reported overload or slowdown conditions. These are treated specially as `ApiError::ServerOverloaded`.

**Data flow**: Reads `error.code` and returns true when it is `Some("server_is_overloaded")` or `Some("slow_down")`.

**Call relations**: This helper participates in `response.failed` classification inside `process_responses_event`.

*Call graph*: called by 1 (process_responses_event).


##### `cyber_policy_fallback_message`  (lines 582–584)

```
fn cyber_policy_fallback_message() -> String
```

**Purpose**: Provides the default user-facing message for cyber-policy failures when the server did not send a meaningful message. It centralizes the fallback wording in one place.

**Data flow**: Allocates and returns the fixed string `This request has been flagged for possible cybersecurity risk.` as a `String`.

**Call relations**: Used only by `cyber_policy_message` as the fallback branch.


##### `cyber_policy_message`  (lines 586–590)

```
fn cyber_policy_message(message: Option<String>) -> String
```

**Purpose**: Normalizes an optional cyber-policy error message so callers always get a non-empty string. Blank or whitespace-only messages are replaced with the standard fallback.

**Data flow**: Consumes `message: Option<String>`, filters out strings whose trimmed content is empty, and returns the original message when present and nonblank; otherwise it calls `cyber_policy_fallback_message` and returns that string.

**Call relations**: This helper is used by `process_responses_event` when converting cyber-policy failures into `ApiError::CyberPolicy`.

*Call graph*: called by 1 (process_responses_event).


##### `rate_limit_regex`  (lines 592–598)

```
fn rate_limit_regex() -> &'static regex_lite::Regex
```

**Purpose**: Lazily initializes and returns the compiled regex used to parse retry delays from rate-limit messages. The regex is cached globally so repeated error parsing does not recompile it.

**Data flow**: Uses a static `OnceLock<regex_lite::Regex>` and `get_or_init` to compile the case-insensitive pattern `try again in <number> <unit>` once, then returns a shared reference to the compiled regex.

**Call relations**: This helper is called by `try_parse_retry_after` whenever a retryable rate-limit message needs delay extraction.

*Call graph*: called by 1 (try_parse_retry_after); 1 external calls (new).


##### `tests::collect_events`  (lines 620–642)

```
async fn collect_events(chunks: &[&[u8]]) -> Vec<Result<ResponseEvent, ApiError>>
```

**Purpose**: Test helper that feeds raw byte chunks through `process_sse` and collects every emitted channel item. It simulates a streaming transport at the byte level.

**Data flow**: Builds a mock async reader from the provided chunk slices, wraps it in `ReaderStream`, maps I/O errors into `TransportError::Network`, creates an `mpsc` channel, spawns `process_sse`, then drains the receiver into a `Vec<Result<ResponseEvent, ApiError>>` which it returns.

**Call relations**: Many async SSE tests use this helper when they want precise control over raw SSE framing and stream termination.

*Call graph*: calls 1 internal fn (process_sse); 6 external calls (pin, new, new, new, idle_timeout, spawn).


##### `tests::run_sse`  (lines 644–673)

```
async fn run_sse(events: Vec<serde_json::Value>) -> Vec<ResponseEvent>
```

**Purpose**: Test helper that converts a vector of JSON event payloads into a textual SSE stream and returns the successfully decoded `ResponseEvent`s. It is a higher-level fixture than `collect_events`.

**Data flow**: Builds an SSE body string by formatting each JSON event as `event:` plus optional `data:` lines, wraps the body in a `ReaderStream`, spawns `process_sse`, then drains the receiver and unwraps each `Ok` event into a `Vec<ResponseEvent>`.

**Call relations**: Most behavior-focused SSE tests use this helper to express fixtures as JSON values instead of raw bytes.

*Call graph*: calls 2 internal fn (process_sse, new); 7 external calls (pin, new, new, new, idle_timeout, format!, spawn).


##### `tests::idle_timeout`  (lines 675–677)

```
fn idle_timeout() -> Duration
```

**Purpose**: Provides a consistent short timeout for SSE tests. Keeping it centralized makes the tests easier to tune and read.

**Data flow**: Returns `Duration::from_millis(1000)` with no inputs or side effects.

**Call relations**: Used by the test helpers and direct `process_sse` tests whenever an idle timeout argument is required.

*Call graph*: 1 external calls (from_millis).


##### `tests::parses_items_and_completed`  (lines 680–743)

```
async fn parses_items_and_completed()
```

**Purpose**: Verifies that normal `response.output_item.done` events deserialize into `ResponseItem`s and that a trailing `response.completed` produces the expected completion event. It also checks preservation of message role and optional phase.

**Data flow**: Constructs three JSON payload strings, wraps them as SSE frames, feeds them through `collect_events`, and asserts the resulting event sequence and parsed fields.

**Call relations**: This test exercises the happy path through `process_sse` and `process_responses_event` for output items plus completion.

*Call graph*: 7 external calls (assert!, assert_eq!, assert_matches!, collect_events, format!, json!, panic!).


##### `tests::error_when_missing_completed`  (lines 746–771)

```
async fn error_when_missing_completed()
```

**Purpose**: Checks that a stream ending after output items but before `response.completed` yields a terminal stream error. This captures the invariant that completion is required for a clean end.

**Data flow**: Builds a single output-item SSE frame, runs it through `collect_events`, and asserts that the second emitted channel item is `Err(ApiError::Stream("stream closed before response.completed"))`.

**Call relations**: This test targets the EOF branch in `process_sse` when no prior terminal protocol error has been remembered.

*Call graph*: 6 external calls (assert_eq!, assert_matches!, collect_events, format!, json!, panic!).


##### `tests::parses_tool_search_call_items`  (lines 774–807)

```
async fn parses_tool_search_call_items()
```

**Purpose**: Verifies that `response.output_item.done` can deserialize a `tool_search_call` item variant with its call id, execution mode, and arguments intact. It confirms that non-message output items are supported.

**Data flow**: Builds a small event sequence with a tool-search item and a completion event, runs it through `run_sse`, and asserts the parsed `ResponseItem::ToolSearchCall` fields.

**Call relations**: This test exercises the generic `ResponseItem` deserialization path inside `process_responses_event`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, run_sse, vec!).


##### `tests::parses_tool_call_input_deltas`  (lines 810–839)

```
async fn parses_tool_call_input_deltas()
```

**Purpose**: Checks that custom tool input delta events are converted into `ResponseEvent::ToolCallInputDelta` and that unrelated delta kinds not explicitly handled are ignored. The test also confirms the stream still completes normally.

**Data flow**: Creates a sequence containing a handled `response.custom_tool_call_input.delta`, an unhandled `response.function_call_arguments.delta`, and a completion event, runs it through `run_sse`, and asserts the resulting event list.

**Call relations**: This test documents the current event-kind coverage in `process_responses_event`.

*Call graph*: 3 external calls (assert_matches!, run_sse, vec!).


##### `tests::emits_completed_without_stream_end`  (lines 842–884)

```
async fn emits_completed_without_stream_end()
```

**Purpose**: Ensures that receiving `response.completed` causes `process_sse` to stop immediately even if the underlying byte stream never closes. This prevents hanging on long-lived or stalled transports after logical completion.

**Data flow**: Builds a stream containing one completion SSE frame followed by a pending stream, spawns `process_sse`, collects channel output under a timeout, and asserts that exactly one completed event was emitted.

**Call relations**: This test targets the early-return branch in `process_sse` after sending a `Completed` event.

*Call graph*: calls 1 internal fn (process_sse); 14 external calls (pin, from_millis, new, assert!, assert_eq!, idle_timeout, format!, json!, panic!, iter (+4 more)).


##### `tests::error_when_error_event`  (lines 887–906)

```
async fn error_when_error_event()
```

**Purpose**: Verifies that a `response.failed` event with a rate-limit message becomes `ApiError::Retryable` and that the retry delay is parsed from the message text. It covers the generic retryable-error path.

**Data flow**: Feeds a raw failed-response SSE frame through `collect_events` and asserts that the sole emitted error contains the original message and a parsed `Duration::from_secs_f64(11.054)` delay.

**Call relations**: This test exercises `process_responses_event` together with `try_parse_retry_after`.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::context_window_error_is_fatal`  (lines 909–919)

```
async fn context_window_error_is_fatal()
```

**Purpose**: Checks that `context_length_exceeded` is classified as the dedicated fatal `ApiError::ContextWindowExceeded`. This distinguishes it from retryable stream failures.

**Data flow**: Builds a failed-response SSE frame with that error code, runs it through `collect_events`, and asserts the emitted error variant.

**Call relations**: This test covers the `is_context_window_error` branch in `process_responses_event`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, collect_events, format!).


##### `tests::context_window_error_with_newline_is_fatal`  (lines 922–932)

```
async fn context_window_error_with_newline_is_fatal()
```

**Purpose**: Confirms that context-window classification depends on the error code, not the exact formatting of the message text. A newline in the message must not change the fatal classification.

**Data flow**: Feeds a failed-response SSE frame whose message contains a newline through `collect_events` and asserts `ApiError::ContextWindowExceeded`.

**Call relations**: This test reinforces that `process_responses_event` uses code-based classification rather than brittle message matching.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, collect_events, format!).


##### `tests::quota_exceeded_error_is_fatal`  (lines 935–945)

```
async fn quota_exceeded_error_is_fatal()
```

**Purpose**: Verifies that `insufficient_quota` maps to `ApiError::QuotaExceeded`. This is another dedicated fatal classification path.

**Data flow**: Constructs a failed-response SSE frame with the quota error code, runs it through `collect_events`, and asserts the resulting error variant.

**Call relations**: This test covers the `is_quota_exceeded_error` branch in `process_responses_event`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, collect_events, format!).


##### `tests::cyber_policy_error_is_fatal`  (lines 948–963)

```
async fn cyber_policy_error_is_fatal()
```

**Purpose**: Checks that cyber-policy failures become `ApiError::CyberPolicy` and preserve a non-empty server-provided message. It validates the specialized policy-error path.

**Data flow**: Feeds a failed-response SSE frame with code `cyber_policy` and a message through `collect_events`, then matches the emitted error and asserts the message text.

**Call relations**: This test exercises `is_cyber_policy_error` and `cyber_policy_message` in the non-fallback case.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::cyber_policy_error_uses_fallback_for_empty_message`  (lines 966–984)

```
async fn cyber_policy_error_uses_fallback_for_empty_message()
```

**Purpose**: Ensures that blank cyber-policy messages are replaced with the standard fallback text. This avoids surfacing empty user-facing errors.

**Data flow**: Builds a failed-response SSE frame whose cyber-policy message is whitespace, runs it through `collect_events`, and asserts that the emitted `ApiError::CyberPolicy` contains the fallback string.

**Call relations**: This test specifically covers the fallback branch in `cyber_policy_message`.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::invalid_prompt_without_type_is_invalid_request`  (lines 987–1005)

```
async fn invalid_prompt_without_type_is_invalid_request()
```

**Purpose**: Verifies that `invalid_prompt` is classified as `ApiError::InvalidRequest` even when no extra error type field is present. The server message should be preserved.

**Data flow**: Feeds a failed-response SSE frame with code `invalid_prompt` through `collect_events` and asserts the resulting invalid-request message.

**Call relations**: This test covers the `is_invalid_prompt_error` branch in `process_responses_event`.

*Call graph*: 4 external calls (assert_eq!, collect_events, format!, panic!).


##### `tests::table_driven_event_kinds`  (lines 1008–1083)

```
async fn table_driven_event_kinds()
```

**Purpose**: Exercises several event kinds in a compact table-driven style, including created, output-item, and unknown events. It verifies both first-event classification and total emitted event count.

**Data flow**: Defines local test cases with JSON payloads and predicates, appends a shared completion event to each case, runs them through `run_sse`, and asserts the expected length and first-event predicate result.

**Call relations**: This test gives broad coverage of `process_responses_event` dispatch behavior, especially the `Ok(None)` path for unknown events.

*Call graph*: 5 external calls (assert!, assert_eq!, run_sse, json!, vec!).


##### `tests::spawn_response_stream_emits_header_events`  (lines 1086–1119)

```
async fn spawn_response_stream_emits_header_events()
```

**Purpose**: Checks that `spawn_response_stream` emits header-derived metadata before any SSE body events and preserves the upstream request id on the returned stream wrapper. It specifically validates server-model extraction from HTTP headers.

**Data flow**: Constructs a `StreamResponse` with `x-request-id` and `openai-model` headers and an empty byte stream, calls `spawn_response_stream`, asserts `upstream_request_id`, receives the first channel event, and checks that it is `ResponseEvent::ServerModel`.

**Call relations**: This test targets the pre-SSE setup logic in `spawn_response_stream` rather than the SSE loop itself.

*Call graph*: calls 1 internal fn (spawn_response_stream); 8 external calls (pin, new, from_static, new, assert_eq!, idle_timeout, panic!, iter).


##### `tests::spawn_response_stream_ignores_model_verification_header`  (lines 1122–1156)

```
async fn spawn_response_stream_ignores_model_verification_header()
```

**Purpose**: Verifies that model-verification recommendations are not sourced from HTTP headers at stream startup. They should only come from metadata events inside the SSE payload.

**Data flow**: Creates a `StreamResponse` with an `openai-verification-recommendation` header and a completion SSE body, runs `spawn_response_stream`, drains all emitted events, and asserts that none are `ResponseEvent::ModelVerifications`.

**Call relations**: This test documents the separation between startup header metadata and in-band event metadata.

*Call graph*: calls 1 internal fn (spawn_response_stream); 10 external calls (pin, new, from_static, new, assert!, idle_timeout, format!, json!, iter, vec!).


##### `tests::process_sse_ignores_response_model_field_in_payload`  (lines 1159–1188)

```
async fn process_sse_ignores_response_model_field_in_payload()
```

**Purpose**: Checks that `process_sse` does not treat `response.model` as the authoritative server-model source. Only header-style fields should trigger `ServerModel` events.

**Data flow**: Runs a created/completed event sequence whose `response` objects contain a `model` field but no headers, then asserts that only `Created` and `Completed` events are emitted.

**Call relations**: This test validates the narrow extraction logic in `ResponsesStreamEvent::response_model`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, run_sse, vec!).


##### `tests::process_sse_emits_server_model_from_response_headers_payload`  (lines 1191–1225)

```
async fn process_sse_emits_server_model_from_response_headers_payload()
```

**Purpose**: Verifies that a model reported inside `response.headers` is emitted as a `ServerModel` event before the semantic event that carried it. This confirms the precedence and timing of model extraction.

**Data flow**: Runs a created event whose nested `response.headers` contains `OpenAI-Model`, followed by completion, and asserts the emitted sequence `ServerModel`, `Created`, `Completed`.

**Call relations**: This test covers `ResponsesStreamEvent::response_model` together with the deduplicating model-emission logic in `process_sse`.

*Call graph*: 4 external calls (assert_eq!, assert_matches!, run_sse, vec!).


##### `tests::process_sse_emits_model_verification_field`  (lines 1228–1260)

```
async fn process_sse_emits_model_verification_field()
```

**Purpose**: Checks that metadata events carrying `openai_verification_recommendation` are converted into `ResponseEvent::ModelVerifications`. It validates the metadata side channel in the SSE loop.

**Data flow**: Runs a metadata event with the trusted-access recommendation followed by completion, then asserts that the first emitted event contains the expected `ModelVerification` vector.

**Call relations**: This test exercises `ResponsesStreamEvent::model_verifications`, `model_verifications_from_json_value`, and the metadata emission branch in `process_sse`.

*Call graph*: 3 external calls (assert_matches!, run_sse, vec!).


##### `tests::process_sse_emits_turn_moderation_metadata_field`  (lines 1263–1295)

```
async fn process_sse_emits_turn_moderation_metadata_field()
```

**Purpose**: Verifies that moderation metadata embedded in a metadata event is surfaced as `ResponseEvent::TurnModerationMetadata` with the raw JSON preserved. It confirms that this metadata is emitted independently of normal response items.

**Data flow**: Runs a metadata event containing `openai_chatgpt_moderation_metadata` followed by completion and asserts the emitted moderation metadata payload.

**Call relations**: This test covers `ResponsesStreamEvent::turn_moderation_metadata` and the corresponding send path in `process_sse`.

*Call graph*: 3 external calls (assert_matches!, run_sse, vec!).


##### `tests::responses_stream_event_response_model_reads_top_level_headers`  (lines 1298–1311)

```
fn responses_stream_event_response_model_reads_top_level_headers()
```

**Purpose**: Unit-tests that `ResponsesStreamEvent::response_model` can read the model from top-level `headers` when nested response headers are absent. This is the websocket-metadata fallback path.

**Data flow**: Deserializes a JSON value into `ResponsesStreamEvent`, calls `response_model()`, and asserts the returned string.

**Call relations**: This test isolates the accessor logic without involving the SSE loop.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_response_model_prefers_response_headers`  (lines 1314–1333)

```
fn responses_stream_event_response_model_prefers_response_headers()
```

**Purpose**: Checks that nested `response.headers` take precedence over top-level `headers` when both contain model information. This enforces the documented precedence rule.

**Data flow**: Deserializes an event containing both header locations, calls `response_model()`, and asserts that the nested response-header value wins.

**Call relations**: This test directly targets the precedence logic inside `ResponsesStreamEvent::response_model`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_model_verification_reads_metadata_field`  (lines 1336–1352)

```
fn responses_stream_event_model_verification_reads_metadata_field()
```

**Purpose**: Verifies that a metadata event with a recognized verification recommendation yields the expected enum vector. It confirms the positive path for metadata parsing.

**Data flow**: Deserializes a metadata JSON value into `ResponsesStreamEvent`, calls `model_verifications()`, and asserts the returned vector.

**Call relations**: This test isolates the accessor and parsing helpers from the rest of the SSE machinery.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_model_verification_ignores_unknown_field`  (lines 1355–1366)

```
fn responses_stream_event_model_verification_ignores_unknown_field()
```

**Purpose**: Checks that unknown verification recommendation strings are ignored rather than propagated. If nothing recognized remains, the result should be `None`.

**Data flow**: Deserializes a metadata event whose recommendation array contains only `unknown`, calls `model_verifications()`, and asserts `None`.

**Call relations**: This test covers the filtering behavior in `parse_model_verification` and `model_verifications_from_json_value`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::responses_stream_event_model_verification_ignores_non_array_field`  (lines 1369–1380)

```
fn responses_stream_event_model_verification_ignores_non_array_field()
```

**Purpose**: Ensures that malformed non-array verification metadata is ignored. The parser requires an array of strings.

**Data flow**: Deserializes a metadata event whose recommendation field is a scalar string, calls `model_verifications()`, and asserts `None`.

**Call relations**: This test covers the non-array branch in `model_verifications_from_json_value`.

*Call graph*: 3 external calls (assert_eq!, json!, from_value).


##### `tests::test_try_parse_retry_after`  (lines 1383–1394)

```
fn test_try_parse_retry_after()
```

**Purpose**: Verifies millisecond retry-delay extraction from a rate-limit message. It covers the `ms` unit branch.

**Data flow**: Constructs a local `Error` with code `rate_limit_exceeded` and a message containing `28ms`, calls `try_parse_retry_after`, and asserts the returned duration.

**Call relations**: This test directly exercises the regex-based delay parser.

*Call graph*: calls 1 internal fn (try_parse_retry_after); 1 external calls (assert_eq!).


##### `tests::test_try_parse_retry_after_no_delay`  (lines 1397–1407)

```
fn test_try_parse_retry_after_no_delay()
```

**Purpose**: Verifies fractional-second retry-delay extraction from a standard OpenAI-style rate-limit message. It covers the seconds branch with decimal values.

**Data flow**: Builds an `Error` containing `Please try again in 1.898s`, calls `try_parse_retry_after`, and asserts `Duration::from_secs_f64(1.898)`.

**Call relations**: This test complements the millisecond case for `try_parse_retry_after`.

*Call graph*: calls 1 internal fn (try_parse_retry_after); 1 external calls (assert_eq!).


##### `tests::test_try_parse_retry_after_azure`  (lines 1410–1420)

```
fn test_try_parse_retry_after_azure()
```

**Purpose**: Checks that Azure-style wording `Try again in 35 seconds` is also parsed correctly. This broadens compatibility beyond one provider's exact phrasing.

**Data flow**: Constructs an `Error` with a message containing `35 seconds`, calls `try_parse_retry_after`, and asserts `Duration::from_secs(35)`.

**Call relations**: This test documents why the regex accepts both abbreviated and full-word second units.

*Call graph*: calls 1 internal fn (try_parse_retry_after); 1 external calls (assert_eq!).


### `codex-api/src/endpoint/responses_websocket.rs`

`io_transport` · `connection setup and websocket request handling`

This file is the full websocket transport for the `responses` endpoint. At the bottom is `WsStream`, an internal wrapper around `tokio_tungstenite::WebSocketStream<MaybeTlsStream<TcpStream>>` that spawns a pump task. That task multiplexes outbound commands from an `mpsc` channel with inbound websocket frames via `tokio::select!`, automatically answers `Ping` with `Pong`, suppresses incoming `Pong`, forwards text/binary/close/frame messages to an unbounded receiver, and terminates on send/read errors or close. `Drop` aborts the pump task.

`ResponsesWebsocketClient` owns a `Provider` and auth source and can either establish a reusable `ResponsesWebsocketConnection` or perform a handshake-only probe. Connection setup builds the websocket URL from the provider, merges provider/extra/default headers with HTTP-like precedence, adds auth headers, ensures the rustls crypto provider is installed, optionally builds a custom-CA TLS connector, enables permessage-deflate, performs the upgrade, and captures response metadata such as reasoning support, models ETag, selected model, and optional turn-state header.

`ResponsesWebsocketConnection::stream_request` serializes a `ResponsesWsRequest`, emits initial synthetic `ResponseEvent`s for server metadata, then locks the shared `WsStream` for the lifetime of one response stream so requests are strictly serialized on a connection. `run_websocket_response_stream` sends the request with timeout/telemetry, then loops reading frames under an idle timeout. Text frames are first checked for wrapped websocket error payloads that can become retryable or HTTP transport errors; otherwise they are parsed as `ResponsesStreamEvent`, used to update turn state and emit rate-limit/model-verification/moderation metadata events, and finally converted through `process_responses_event`. The loop exits only on `ResponseEvent::Completed`; binary frames, premature close, parse failures in wrapped errors, or consumer drop become stream errors. The file also includes tests for serialization fidelity, websocket config, wrapped-error mapping, and header precedence.

#### Function details

##### `WsStream::new`  (lines 64–126)

```
fn new(inner: WebSocketStream<MaybeTlsStream<TcpStream>>) -> Self
```

**Purpose**: Wraps a raw tungstenite websocket stream in a background pump task that serializes outbound commands and forwards inbound frames through channels. It also implements automatic ping/pong handling.

**Data flow**: Consumes `inner: WebSocketStream<MaybeTlsStream<TcpStream>>`, creates a bounded command channel and unbounded message channel, then spawns an async loop owning `inner`. That loop selects between outbound commands and inbound websocket messages: send commands call `inner.send`, returning the result through a oneshot; incoming `Ping` frames trigger an immediate `Pong`; `Pong` is ignored; text, binary, close, and frame messages are forwarded to `rx_message`; any websocket error is forwarded as `Err`. It returns a `WsStream` containing the command sender, message receiver, and join handle.

**Call relations**: This constructor is used by `connect_websocket` after a successful upgrade. It creates the internal concurrency boundary that later methods (`send`, `next`) and higher-level response streaming rely on.

*Call graph*: 2 external calls (select!, spawn).


##### `WsStream::request`  (lines 128–137)

```
async fn request(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<(), WsError>>) -> WsCommand,
    ) -> Result<(), WsError>
```

**Purpose**: Sends one command to the pump task and waits for the command-specific completion result. It is the generic request/response primitive behind websocket writes.

**Data flow**: Takes a closure that builds a `WsCommand` from a oneshot sender, allocates that oneshot pair, sends the command over `tx_command`, and awaits the reply. If the command channel is closed or the oneshot is dropped, it returns `WsError::ConnectionClosed`; otherwise it returns the pump task's `Result<(), WsError>` for that command.

**Call relations**: This helper is called by `WsStream::send` to implement actual websocket writes. It centralizes the channel/oneshot handshake so additional command types could reuse the same pattern.

*Call graph*: called by 1 (send); 2 external calls (send, channel).


##### `WsStream::send`  (lines 139–142)

```
async fn send(&self, message: Message) -> Result<(), WsError>
```

**Purpose**: Queues a websocket message for transmission through the pump task. It provides the write-side API used by higher-level request sending.

**Data flow**: Accepts a tungstenite `Message`, wraps it in `WsCommand::Send` via `WsStream::request`, and returns the resulting `Result<(), WsError>` from the pump task.

**Call relations**: This method is called by `send_websocket_request`, which adds timeout and telemetry around the actual send. It delegates all synchronization and error propagation to `request`.

*Call graph*: calls 1 internal fn (request).


##### `WsStream::next`  (lines 144–146)

```
async fn next(&mut self) -> Option<Result<Message, WsError>>
```

**Purpose**: Receives the next forwarded inbound websocket message from the pump task. It is the read-side API exposed to the response-stream loop.

**Data flow**: Mutably borrows `self`, awaits `rx_message.recv()`, and returns `Option<Result<Message, WsError>>`, where `None` means the pump task has stopped and closed the channel.

**Call relations**: This method is used by `run_websocket_response_stream` and by the handshake probe path to consume incoming frames without touching the raw tungstenite stream directly.

*Call graph*: 1 external calls (recv).


##### `WsStream::drop`  (lines 150–152)

```
fn drop(&mut self)
```

**Purpose**: Stops the background pump task when the wrapper is dropped. This prevents orphaned websocket tasks from lingering after the stream is no longer used.

**Data flow**: On drop, it calls `abort()` on the stored `JoinHandle<()>`. It does not return a value or perform graceful shutdown.

**Call relations**: This destructor runs automatically when a `WsStream` is removed from a connection or dropped after a failed stream. It complements `WsStream::new` by cleaning up the spawned task.

*Call graph*: 1 external calls (abort).


##### `ResponsesWebsocketConnection::fmt`  (lines 173–182)

```
fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result
```

**Purpose**: Provides a redacted `Debug` representation for websocket connections. It exposes configuration and cached metadata while hiding the live stream internals and telemetry object details.

**Data flow**: Reads `idle_timeout`, `server_reasoning_included`, `models_etag`, `server_model`, and whether telemetry is present, then writes those fields into a `debug_struct`. The actual stream is rendered as the placeholder string `"<ws-stream>"`.

**Call relations**: This formatting implementation is used whenever the connection is logged or debug-printed. It avoids leaking transport internals while still surfacing useful state.

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

**Purpose**: Constructs a reusable websocket connection object from an established `WsStream` and handshake metadata. It packages the stream behind shared mutable state so one request stream can lock it at a time.

**Data flow**: Consumes a `WsStream`, idle timeout, booleans/strings captured from upgrade headers, and optional websocket telemetry. It wraps the stream in `Arc<Mutex<Option<WsStream>>>`, stores the metadata fields, and returns `ResponsesWebsocketConnection`.

**Call relations**: This constructor is called by `ResponsesWebsocketClient::connect` after `connect_websocket` succeeds. The `Option<WsStream>` wrapper is later used by `stream_request` to permanently take and drop the stream on terminal failure.

*Call graph*: called by 1 (connect); 2 external calls (new, new).


##### `ResponsesWebsocketConnection::is_closed`  (lines 204–206)

```
async fn is_closed(&self) -> bool
```

**Purpose**: Reports whether the underlying websocket stream has already been removed from the connection. It is a lightweight health check for callers managing connection reuse.

**Data flow**: Locks `self.stream` asynchronously and returns `true` if the inner `Option<WsStream>` is `None`, otherwise `false`.

**Call relations**: This method is called by external connection-management code before attempting reuse. It reads the state that `stream_request` mutates when a terminal stream error occurs.


##### `ResponsesWebsocketConnection::stream_request`  (lines 214–287)

```
async fn stream_request(
        &self,
        request: ResponsesWsRequest,
        connection_reused: bool,
        turn_state: Option<Arc<OnceLock<String>>>,
    ) -> Result<ResponseStream, ApiErro
```

**Purpose**: Starts one streamed Responses request over an existing websocket connection and returns a `ResponseStream` backed by a spawned task. It also emits initial metadata events derived from the handshake before reading response frames.

**Data flow**: Accepts a typed `ResponsesWsRequest`, a `connection_reused` flag, and optional turn-state storage. It creates an `mpsc` channel for `Result<ResponseEvent, ApiError>`, clones connection state needed by the task, serializes the request with `serialize_websocket_request`, and spawns an instrumented async task. That task first sends synthetic `ServerModel`, `ModelsEtag`, and `ServerReasoningIncluded` events when available, then locks the shared `Arc<Mutex<Option<WsStream>>>`; if the stream is absent it sends `ApiError::Stream("websocket connection is closed")`. Otherwise it calls `run_websocket_response_stream`. On terminal error it takes the `WsStream` out of the `Option`, drops it to abort the pump, and forwards the error to the consumer. The method immediately returns `ResponseStream { rx_event, upstream_request_id: None }`.

**Call relations**: This is the main per-request entrypoint on an established connection. It delegates request serialization to `serialize_websocket_request` and all frame-level protocol handling to `run_websocket_response_stream`, while owning the connection-locking and failure-teardown policy.

*Call graph*: calls 2 internal fn (run_websocket_response_stream, serialize_websocket_request); 7 external calls (clone, current, ModelsEtag, ServerModel, ServerReasoningIncluded, Stream, spawn).


##### `ResponsesWebsocketClient::new`  (lines 324–326)

```
fn new(provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a websocket client bound to a specific provider and auth source. It is the factory for both full connections and handshake probes.

**Data flow**: Consumes `provider: Provider` and `auth: SharedAuthProvider` and returns `ResponsesWebsocketClient { provider, auth }`.

**Call relations**: This constructor is used by callers that want websocket access to the Responses endpoint. Subsequent `connect` and `probe_handshake` calls reuse the stored provider and auth configuration.

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

**Purpose**: Establishes a real websocket connection to the Responses endpoint, including URL construction, header merging, authentication, TLS setup, and handshake metadata capture. It returns a reusable `ResponsesWebsocketConnection`.

**Data flow**: Accepts caller `extra_headers`, `default_headers`, optional turn-state storage, and optional websocket telemetry. It asks the provider for `websocket_url_for_path("responses")`, merges provider/extra/default headers via `merge_request_headers`, mutates the merged map with auth headers, then awaits `connect_websocket`. From the returned stream, status-independent metadata, and provider idle timeout it constructs `ResponsesWebsocketConnection::new(...)` and returns it. URL-construction failures are mapped to `ApiError::Stream`.

**Call relations**: This public method is the normal connection-establishment path. It delegates header precedence to `merge_request_headers` and the actual websocket/TLS handshake to `connect_websocket`.

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

**Purpose**: Performs a handshake-only websocket probe that validates upgrade success and optionally captures an immediate close frame for diagnostics. It uses the same URL, headers, auth, and TLS path as a real connection but does not send a request.

**Data flow**: Takes `extra_headers`, `default_headers`, and an `immediate_close_timeout`. It builds the websocket URL, merges headers, adds auth headers, and calls `connect_websocket` with no turn-state sink. After upgrade it waits up to the supplied timeout for `stream.next()`, converts any received close frame through `immediate_close_from_message`, and returns `ResponsesWebsocketProbe` containing the URL string, HTTP status, booleans indicating presence of reasoning/model headers, and optional immediate-close details. Read failures become `ApiError::Stream`.

**Call relations**: This method is a sibling to `connect`, sharing the same setup helpers but stopping after the handshake. It uses `immediate_close_from_message` to distinguish a healthy upgrade from a server that immediately closes the socket.

*Call graph*: calls 3 internal fn (connect_websocket, merge_request_headers, websocket_url_for_path); 2 external calls (add_auth_headers, timeout).


##### `immediate_close_from_message`  (lines 407–412)

```
fn immediate_close_from_message(message: Message) -> Option<ResponsesWebsocketClose>
```

**Purpose**: Extracts probe-friendly close information from a websocket message only when that message is a close frame. Non-close messages are ignored.

**Data flow**: Consumes a tungstenite `Message`; if it is `Message::Close(frame)`, it maps the optional `CloseFrame` through `close_frame_to_probe`, otherwise it returns `None`.

**Call relations**: This helper is used by `probe_handshake` after waiting briefly for a post-upgrade frame. It isolates the close-frame pattern match from the probe orchestration.


##### `close_frame_to_probe`  (lines 414–419)

```
fn close_frame_to_probe(frame: CloseFrame) -> ResponsesWebsocketClose
```

**Purpose**: Converts a tungstenite `CloseFrame` into the public diagnostic struct `ResponsesWebsocketClose`. It preserves the server's close code and reason as strings.

**Data flow**: Takes `frame: CloseFrame` and returns `ResponsesWebsocketClose { code: frame.code.to_string(), reason: frame.reason.to_string() }`.

**Call relations**: This helper is only called by `immediate_close_from_message` when the handshake probe receives a close frame.


##### `merge_request_headers`  (lines 421–434)

```
fn merge_request_headers(
    provider_headers: &HeaderMap,
    extra_headers: HeaderMap,
    default_headers: HeaderMap,
) -> HeaderMap
```

**Purpose**: Combines provider, extra, and default headers using HTTP-like precedence rules. Provider headers win over defaults, and explicit extra headers win over provider values.

**Data flow**: Clones `provider_headers` into a new `HeaderMap`, extends it with `extra_headers` so duplicates are overwritten by extra values, then iterates `default_headers` and inserts each only if that header name is currently vacant. It returns the merged `HeaderMap`.

**Call relations**: This helper is used by both `connect` and `probe_handshake` before auth headers are added. The included test verifies the intended precedence ordering.

*Call graph*: called by 3 (connect, probe_handshake, merge_request_headers_matches_http_precedence); 1 external calls (clone).


##### `connect_websocket`  (lines 436–505)

```
async fn connect_websocket(
    url: Url,
    headers: HeaderMap,
    turn_state: Option<Arc<OnceLock<String>>>,
) -> Result<(WsStream, StatusCode, bool, Option<String>, Option<String>), ApiError>
```

**Purpose**: Performs the low-level websocket upgrade, TLS/custom-CA configuration, compression setup, and extraction of handshake metadata. It is the shared transport primitive behind both real connections and probes.

**Data flow**: Accepts a `Url`, merged `HeaderMap`, and optional turn-state `OnceLock`. It ensures the rustls crypto provider is installed, builds a client request from the URL string, extends request headers, optionally creates a rustls connector from custom CA configuration, and calls `connect_async_tls_with_config` with `websocket_config()`. On success it logs response headers, reads `x-reasoning-included`, `x-models-etag`, `openai-model`, and optionally `x-codex-turn-state` from the upgrade response, storing turn state into the provided `OnceLock` if present. It returns `(WsStream::new(stream), response.status(), reasoning_included, models_etag, server_model)`. On failure it logs and maps the tungstenite error through `map_ws_error`.

**Call relations**: This function is called by both `ResponsesWebsocketClient::connect` and `probe_handshake`. It is the single place where websocket-specific TLS policy, compression configuration, and handshake-header extraction are implemented.

*Call graph*: calls 3 internal fn (new, map_ws_error, websocket_config); called by 2 (connect, probe_handshake); 6 external calls (as_str, maybe_build_rustls_client_config_with_custom_ca, ensure_rustls_crypto_provider, error!, info!, connect_async_tls_with_config).


##### `websocket_config`  (lines 507–514)

```
fn websocket_config() -> WebSocketConfig
```

**Purpose**: Builds the tungstenite websocket configuration used for Responses connections. Its only customization is enabling permessage-deflate compression.

**Data flow**: Creates default `ExtensionsConfig`, sets `permessage_deflate` to `Some(DeflateConfig::default())`, creates default `WebSocketConfig`, assigns the extensions config, and returns the resulting `WebSocketConfig`.

**Call relations**: This helper is called by `connect_websocket` for every upgrade attempt. A dedicated test asserts that permessage-deflate is enabled.

*Call graph*: called by 2 (connect_websocket, websocket_config_enables_permessage_deflate); 3 external calls (default, default, default).


##### `map_ws_error`  (lines 516–538)

```
fn map_ws_error(err: WsError, url: &Url) -> ApiError
```

**Purpose**: Translates tungstenite connection errors into the crate's `ApiError` model, preserving HTTP upgrade failures when possible. It distinguishes HTTP, closed-connection, I/O, and generic network errors.

**Data flow**: Consumes `err: WsError` and the target `url`. For `WsError::Http(response)`, it extracts status, cloned headers, and an optional UTF-8 body and returns `ApiError::Transport(TransportError::Http { ... })`. For `ConnectionClosed` or `AlreadyClosed` it returns `ApiError::Stream("websocket closed")`. For `Io(err)` and all other variants it returns `ApiError::Transport(TransportError::Network(...))` using stringified error text.

**Call relations**: This helper is only used by `connect_websocket` when the upgrade fails. It centralizes the policy for preserving as much diagnostic information as possible from tungstenite errors.

*Call graph*: called by 1 (connect_websocket); 5 external calls (to_string, to_string, Stream, Transport, Network).


##### `parse_wrapped_websocket_error_event`  (lines 558–564)

```
fn parse_wrapped_websocket_error_event(payload: &str) -> Option<WrappedWebsocketErrorEvent>
```

**Purpose**: Parses a websocket text payload into the internal wrapped-error struct only when the payload is an `error` event. It filters out normal response events early.

**Data flow**: Takes `payload: &str`, attempts `serde_json::from_str::<WrappedWebsocketErrorEvent>`, returns `None` on parse failure, then checks `event.kind == "error"`. If the kind matches it returns `Some(event)`, otherwise `None`.

**Call relations**: This helper is called from `run_websocket_response_stream` before normal response-event parsing so wrapped transport-style errors can be surfaced immediately. Several tests exercise both matching and non-matching payloads.

*Call graph*: called by 6 (run_websocket_response_stream, parse_wrapped_websocket_error_event_ignores_non_error_payloads, parse_wrapped_websocket_error_event_maps_to_transport_http, parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable, parse_wrapped_websocket_error_event_with_status_maps_invalid_request, parse_wrapped_websocket_error_event_without_status_is_not_mapped); 1 external calls (from_str).


##### `map_wrapped_websocket_error_event`  (lines 566–601)

```
fn map_wrapped_websocket_error_event(
    event: WrappedWebsocketErrorEvent,
    original_payload: String,
) -> Option<ApiError>
```

**Purpose**: Converts a parsed wrapped websocket error payload into a concrete `ApiError` when the payload represents a meaningful transport or retryable failure. It has special handling for the server's websocket connection-limit code.

**Data flow**: Consumes `WrappedWebsocketErrorEvent` plus the original payload string. If `error.code == "websocket_connection_limit_reached"`, it returns `ApiError::Retryable` with the server message or a built-in default. Otherwise it requires a numeric `status`, converts it to `StatusCode`, ignores success statuses, and returns `ApiError::Transport(TransportError::Http { status, url: None, headers: headers.map(json_headers_to_http_headers), body: Some(original_payload) })`. If required fields are absent or the status is successful, it returns `None`.

**Call relations**: This helper is called by `run_websocket_response_stream` after `parse_wrapped_websocket_error_event` succeeds. The tests in this file verify its mapping for HTTP-style errors, invalid requests, connection-limit retryability, and missing-status cases.

*Call graph*: called by 5 (run_websocket_response_stream, parse_wrapped_websocket_error_event_maps_to_transport_http, parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable, parse_wrapped_websocket_error_event_with_status_maps_invalid_request, parse_wrapped_websocket_error_event_without_status_is_not_mapped); 2 external calls (from_u16, Transport).


##### `json_headers_to_http_headers`  (lines 603–615)

```
fn json_headers_to_http_headers(headers: JsonMap<String, Value>) -> HeaderMap
```

**Purpose**: Converts a JSON object of header names and primitive values into an `http::HeaderMap`. Invalid names or unsupported values are skipped rather than failing the whole conversion.

**Data flow**: Takes `JsonMap<String, Value>`, creates an empty `HeaderMap`, iterates each `(name, value)` pair, parses the name with `HeaderName::from_bytes`, converts the value with `json_header_value`, and inserts successful pairs into the map. It returns the populated `HeaderMap`.

**Call relations**: This helper is used by `map_wrapped_websocket_error_event` when turning wrapped websocket error metadata into a transport-style HTTP error.

*Call graph*: calls 1 internal fn (json_header_value); 2 external calls (new, from_bytes).


##### `json_header_value`  (lines 617–625)

```
fn json_header_value(value: Value) -> Option<HeaderValue>
```

**Purpose**: Converts a JSON primitive into an `http::HeaderValue`. Only string, number, and boolean values are accepted.

**Data flow**: Consumes a `serde_json::Value`; strings are used directly, numbers and booleans are stringified, and all other JSON types return `None`. The resulting string is validated with `HeaderValue::from_str`, returning `Some(HeaderValue)` on success or `None` on invalid header syntax.

**Call relations**: This helper is called by `json_headers_to_http_headers` for each candidate header value. It isolates the primitive-type filtering and header-value validation.

*Call graph*: called by 1 (json_headers_to_http_headers); 2 external calls (from_str, to_string).


##### `run_websocket_response_stream`  (lines 627–755)

```
async fn run_websocket_response_stream(
    ws_stream: &mut WsStream,
    tx_event: mpsc::Sender<std::result::Result<ResponseEvent, ApiError>>,
    request_text: String,
    idle_timeout: Duration,
```

**Purpose**: Drives one full request/response exchange over an already-open websocket, enforcing idle timeouts, emitting telemetry, parsing protocol events, and stopping only when a completed response arrives. It is the core websocket streaming loop.

**Data flow**: Takes a mutable `WsStream`, an event sender, serialized `request_text`, idle timeout, optional telemetry, a `connection_reused` flag, and optional turn-state sink. It first calls `send_websocket_request`; then in a loop it times out `ws_stream.next()` by `idle_timeout`, reports poll latency to telemetry, and matches the resulting `Message`. For `Text`, it logs the payload, checks for wrapped websocket errors via `parse_wrapped_websocket_error_event` and `map_wrapped_websocket_error_event`, otherwise parses `ResponsesStreamEvent` from JSON. Parsed events may update `turn_state`, emit `RateLimits`, `ServerModel`, `ModelVerifications`, and `TurnModerationMetadata`, and are then passed to `process_responses_event`; returned `ResponseEvent`s are forwarded to `tx_event`, and the loop breaks on `ResponseEvent::Completed`. Binary frames, premature close, websocket read errors, idle timeout, or dropped consumers become `ApiError` failures. `Frame` is ignored; ping/pong should already be handled by the pump but are tolerated.

**Call relations**: This function is called exclusively by `ResponsesWebsocketConnection::stream_request` inside the spawned task that holds the websocket lock. It depends on `send_websocket_request` for the initial write and on SSE-layer helpers like `process_responses_event` and `parse_rate_limit_event` to interpret text payloads.

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

**Purpose**: Sends the serialized request frame over the websocket with an idle timeout and telemetry reporting. It converts tungstenite send failures into `ApiError::Stream`.

**Data flow**: Accepts a `WsStream`, `request_text`, idle timeout, optional telemetry reference, and `connection_reused` flag. It logs the outgoing text, records `Instant::now()`, wraps `ws_stream.send(Message::Text(...))` in `tokio::time::timeout`, maps timeout and send errors into `ApiError::Stream`, reports the elapsed duration and any error to telemetry via `on_ws_request`, and returns `Ok(())` only if the send succeeded.

**Call relations**: This helper is called at the start of `run_websocket_response_stream` before any response frames are read. It isolates outbound timing/error instrumentation from the main receive loop.

*Call graph*: calls 1 internal fn (send); called by 1 (run_websocket_response_stream); 4 external calls (now, timeout, trace!, Text).


##### `serialize_websocket_request`  (lines 790–793)

```
fn serialize_websocket_request(request: &ResponsesWsRequest) -> Result<String, ApiError>
```

**Purpose**: Serializes a typed websocket request enum into the exact JSON text sent on the wire. It preserves the request payload shape by relying on serde's normal serialization.

**Data flow**: Takes `&ResponsesWsRequest`, calls `serde_json::to_string`, and returns the resulting `String` or `ApiError::Stream` if serialization fails.

**Call relations**: This helper is used by `ResponsesWebsocketConnection::stream_request` before spawning the response task. A test verifies that its output round-trips to the same JSON value as direct serde serialization.

*Call graph*: called by 2 (stream_request, direct_serialization_preserves_websocket_request_payload); 1 external calls (to_string).


##### `tests::direct_serialization_preserves_websocket_request_payload`  (lines 806–848)

```
fn direct_serialization_preserves_websocket_request_payload()
```

**Purpose**: Verifies that `serialize_websocket_request` produces JSON equivalent to direct serde serialization of a rich `ResponsesWsRequest`. The test guards against accidental wire-format drift.

**Data flow**: Builds a `ResponsesWsRequest::ResponseCreate` containing model, instructions, previous response ID, message input, tools, include fields, service tier, prompt cache key, and client metadata. It serializes the request both with `serde_json::to_value` and with `serialize_websocket_request` followed by `serde_json::from_str::<Value>`, then asserts the two JSON values are equal.

**Call relations**: This test exercises `serialize_websocket_request` in isolation. It ensures the websocket-specific serialization helper does not mutate or omit fields compared with ordinary serde output.

*Call graph*: calls 1 internal fn (serialize_websocket_request); 5 external calls (from, assert_eq!, ResponseCreate, to_value, vec!).


##### `tests::websocket_config_enables_permessage_deflate`  (lines 851–854)

```
fn websocket_config_enables_permessage_deflate()
```

**Purpose**: Checks that websocket connections are configured to negotiate permessage-deflate compression. It protects the explicit compression setting in `websocket_config`.

**Data flow**: Calls `websocket_config()` and asserts that `config.extensions.permessage_deflate.is_some()`.

**Call relations**: This test directly validates the helper used by `connect_websocket` during upgrades.

*Call graph*: calls 1 internal fn (websocket_config); 1 external calls (assert!).


##### `tests::parse_wrapped_websocket_error_event_maps_to_transport_http`  (lines 857–906)

```
fn parse_wrapped_websocket_error_event_maps_to_transport_http()
```

**Purpose**: Confirms that a wrapped websocket `error` payload with HTTP status and JSON headers maps to `ApiError::Transport(Http)` with converted headers and preserved body text. It covers numeric header-value conversion as well.

**Data flow**: Constructs a JSON string representing an error event with status 429, nested error details, and mixed string/number headers. It parses the payload with `parse_wrapped_websocket_error_event`, maps it with `map_wrapped_websocket_error_event`, destructures the resulting `ApiError::Transport(TransportError::Http { ... })`, and asserts the status, converted headers, and body contents.

**Call relations**: This test exercises the wrapped-error parsing/mapping path used by `run_websocket_response_stream` before normal event decoding.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 4 external calls (assert!, assert_eq!, json!, panic!).


##### `tests::parse_wrapped_websocket_error_event_ignores_non_error_payloads`  (lines 909–920)

```
fn parse_wrapped_websocket_error_event_ignores_non_error_payloads()
```

**Purpose**: Verifies that non-`error` websocket payloads are not misclassified as wrapped transport errors. This keeps normal response events on the standard parsing path.

**Data flow**: Builds a JSON payload with `type: "response.created"`, passes it to `parse_wrapped_websocket_error_event`, and asserts the result is `None`.

**Call relations**: This test validates the early kind filter inside `parse_wrapped_websocket_error_event`, which `run_websocket_response_stream` relies on before attempting wrapped-error mapping.

*Call graph*: calls 1 internal fn (parse_wrapped_websocket_error_event); 2 external calls (assert!, json!).


##### `tests::parse_wrapped_websocket_error_event_with_status_maps_invalid_request`  (lines 923–945)

```
fn parse_wrapped_websocket_error_event_with_status_maps_invalid_request()
```

**Purpose**: Checks that a wrapped websocket error with status 400 becomes an HTTP transport error carrying the original payload body. It specifically covers invalid-request style failures.

**Data flow**: Creates a JSON error payload with status 400 and an `invalid_request_error` message, parses it, maps it, destructures the resulting `ApiError::Transport(TransportError::Http { status, body, .. })`, and asserts the status and body contents.

**Call relations**: This test covers another branch of `map_wrapped_websocket_error_event`, ensuring non-success statuses become transport HTTP errors.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 4 external calls (assert!, assert_eq!, json!, panic!).


##### `tests::parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable`  (lines 948–969)

```
fn parse_wrapped_websocket_error_event_with_connection_limit_maps_retryable()
```

**Purpose**: Verifies the special-case mapping for the server's websocket connection-limit error code. Instead of an HTTP transport error, the payload should become `ApiError::Retryable`.

**Data flow**: Builds a JSON error payload whose nested `error.code` is `websocket_connection_limit_reached`, parses and maps it, destructures the result as `ApiError::Retryable { message, delay }`, and asserts the expected message and `None` delay.

**Call relations**: This test exercises the highest-priority branch in `map_wrapped_websocket_error_event`, which `run_websocket_response_stream` uses to signal reconnect-worthy failures.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 3 external calls (assert_eq!, json!, panic!).


##### `tests::parse_wrapped_websocket_error_event_without_status_is_not_mapped`  (lines 972–990)

```
fn parse_wrapped_websocket_error_event_without_status_is_not_mapped()
```

**Purpose**: Ensures that wrapped websocket error payloads lacking an HTTP status are not converted into transport errors. This avoids manufacturing incomplete HTTP diagnostics.

**Data flow**: Creates a JSON `error` payload without `status`, parses it successfully, passes it to `map_wrapped_websocket_error_event`, and asserts the mapping result is `None`.

**Call relations**: This test validates the status requirement in `map_wrapped_websocket_error_event`, which affects whether `run_websocket_response_stream` treats a wrapped error as terminal.

*Call graph*: calls 2 internal fn (map_wrapped_websocket_error_event, parse_wrapped_websocket_error_event); 2 external calls (assert!, json!).


##### `tests::merge_request_headers_matches_http_precedence`  (lines 993–1023)

```
fn merge_request_headers_matches_http_precedence()
```

**Purpose**: Checks the precedence rules used when combining provider, extra, and default websocket headers. It documents that extra overrides provider, while defaults only fill gaps.

**Data flow**: Builds three `HeaderMap`s with overlapping keys, calls `merge_request_headers`, and asserts that provider values beat defaults, extra values beat provider values, and default-only keys are inserted.

**Call relations**: This test directly validates the helper used by both `connect` and `probe_handshake` before auth headers are added.

*Call graph*: calls 1 internal fn (merge_request_headers); 3 external calls (new, from_static, assert_eq!).


### `codex-api/src/endpoint/compact.rs`

`io_transport` · `request handling`

This endpoint wrapper is a thin layer over `EndpointSession<T>`. `CompactClient` stores a session configured with a transport, provider, and shared auth provider, and offers an optional `with_telemetry` builder that swaps in request telemetry on the underlying session.

The endpoint path is fixed by `path()` as `responses/compact`, and the main work happens in `compact`. That method accepts a prebuilt JSON body, extra headers, a request timeout, and an optional `OnceLock<String>` for turn state. It sends a POST request through `session.execute_with`, using the closure argument to set `req.timeout = Some(request_timeout)` before dispatch. After a successful response, it looks for the `x-codex-turn-state` header; if both the caller supplied a `OnceLock` and the header is present and valid UTF-8, it stores the header value once and ignores any failure from `set` (for example if already initialized). It then deserializes the response body into the private `CompactHistoryResponse { output: Vec<ResponseItem> }`, mapping JSON decode failures to `ApiError::Stream`.

`compact_input` is the typed convenience layer: it serializes a `CompactionInput` with `serde_json::to_value`, wraps serialization failures with a contextual message, and delegates to `compact`. The test module provides a dummy transport that should never be called and asserts the path string exactly, preserving wire compatibility.

#### Function details

##### `CompactClient::new`  (lines 24–28)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a compact-endpoint client around a freshly created `EndpointSession`.

**Data flow**: Consumes a transport, provider configuration, and shared auth provider, passes them to `EndpointSession::new`, and stores the resulting session inside `CompactClient`. It returns the new client and does not touch external state.

**Call relations**: This is the standard constructor used by higher-level API setup code before any compact requests are issued.

*Call graph*: calls 1 internal fn (new).


##### `CompactClient::with_telemetry`  (lines 30–34)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client whose underlying session includes optional request telemetry hooks.

**Data flow**: Consumes `self` and an optional `Arc<dyn RequestTelemetry>`, calls `self.session.with_request_telemetry(request)`, and wraps the updated session in a new `CompactClient`.

**Call relations**: Acts as a builder-style adapter layered on top of `CompactClient::new`, allowing callers to attach telemetry without mutating the original client in place.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `CompactClient::path`  (lines 36–38)

```
fn path() -> &'static str
```

**Purpose**: Defines the fixed relative path for the compaction endpoint.

**Data flow**: Returns the static string `responses/compact`. It is pure and side-effect free.

**Call relations**: Used internally by `compact` and validated by the test module to guard wire-path compatibility.


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

**Purpose**: Posts a raw JSON compaction request, optionally captures turn-state metadata, and decodes the compacted output items.

**Data flow**: Accepts a JSON body, extra headers, timeout duration, and optional `OnceLock<String>`. It sends a POST request via `session.execute_with`, mutating the outbound request timeout in the provided closure. On success it optionally reads `x-codex-turn-state` from response headers and stores it into the supplied `OnceLock`. It then deserializes `resp.body` into `CompactHistoryResponse` and returns `parsed.output`, or converts JSON decode failures into `ApiError::Stream`.

**Call relations**: This is the core transport method for the endpoint. `compact_input` delegates to it after typed serialization, and callers use it when they already have a raw JSON payload.

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

**Purpose**: Serializes a typed `CompactionInput` and submits it to the compact endpoint.

**Data flow**: Takes a borrowed typed input plus headers, timeout, and optional turn-state sink; serializes the input with `serde_json::to_value`; maps serialization failures to `ApiError::Stream` with contextual text; and forwards the resulting JSON body to `compact`, returning its `Vec<ResponseItem>` result.

**Call relations**: This is the typed convenience entrypoint layered directly over `compact`, used when callers want compile-time request structure rather than constructing JSON manually.

*Call graph*: calls 1 internal fn (compact); 1 external calls (to_value).


##### `tests::DummyTransport::execute`  (lines 103–105)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Test stub that fails if a non-streaming HTTP execute call is unexpectedly attempted.

**Data flow**: Ignores the incoming request and returns `Err(TransportError::Build("execute should not run"))`. It reads and writes no shared state.

**Call relations**: Used only in the path test's dummy client type parameter; its failure behavior ensures the test remains focused on static path logic rather than accidentally performing transport work.

*Call graph*: 1 external calls (Build).


##### `tests::DummyTransport::stream`  (lines 107–109)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Test stub that fails if a streaming transport call is unexpectedly attempted.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("stream should not run"))`.

**Call relations**: Completes the `HttpTransport` implementation for the dummy test transport and guards against accidental use of the streaming path in this module's tests.

*Call graph*: 1 external calls (Build).


##### `tests::path_is_responses_compact`  (lines 113–115)

```
fn path_is_responses_compact()
```

**Purpose**: Asserts that the endpoint path constant remains the expected wire-compatible value.

**Data flow**: Calls `CompactClient::<DummyTransport>::path()` and compares the returned string to `responses/compact`.

**Call relations**: This test protects the static path used by `CompactClient::compact`, catching accidental endpoint renames.

*Call graph*: 1 external calls (assert_eq!).


### `codex-api/src/endpoint/memories.rs`

`io_transport` · `request handling`

This module follows the same endpoint-client pattern as other `codex-api` transports. `MemoriesClient<T>` wraps an `EndpointSession<T>` and exposes a constructor plus `with_telemetry` builder. The endpoint path is intentionally fixed as `memories/trace_summarize`; the dedicated path test documents that this exact string is required for wire compatibility.

The transport logic is split between `summarize` and `summarize_input`. `summarize` accepts a raw JSON body and extra headers, performs a POST to the fixed path through `session.execute`, and deserializes the response body into the private `SummarizeResponse { output: Vec<MemorySummarizeOutput> }`. Decode failures are converted into `ApiError::Stream` using the serde error text directly. `summarize_input` is the typed wrapper: it serializes `MemorySummarizeInput` with `serde_json::to_value`, wraps serialization failures with the message `failed to encode memory summarize input: ...`, and delegates to `summarize`.

The test module includes both a `DummyTransport` that should never be used and a `CapturingTransport` that records the outgoing request while returning a canned successful response. Combined with a no-op `DummyAuth` and a deterministic `Provider` fixture, the main async test verifies that `summarize_input` sends a POST to `.../memories/trace_summarize`, serializes `raw_memories` under the wire key `traces`, preserves nested metadata like `source_path`, and correctly parses the returned `trace_summary`/`memory_summary` pair into `MemorySummarizeOutput` values.

#### Function details

##### `MemoriesClient::new`  (lines 20–24)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a memory-summarization client around a new endpoint session.

**Data flow**: Consumes a transport, provider, and shared auth provider, creates an `EndpointSession`, and stores it in `MemoriesClient`.

**Call relations**: Used by production setup and by the module's integration-style test before calling `summarize_input`.

*Call graph*: calls 1 internal fn (new); called by 1 (summarize_input_posts_expected_payload_and_parses_output).


##### `MemoriesClient::with_telemetry`  (lines 26–30)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a client whose underlying session has optional request telemetry attached.

**Data flow**: Consumes `self`, applies `with_request_telemetry` to the stored session, and returns a new `MemoriesClient` containing the updated session.

**Call relations**: Builder-style companion to `MemoriesClient::new`, used when callers want instrumentation on summarize requests.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `MemoriesClient::path`  (lines 32–34)

```
fn path() -> &'static str
```

**Purpose**: Defines the fixed relative path for the memory trace summarization endpoint.

**Data flow**: Returns the static string `memories/trace_summarize`.

**Call relations**: Used internally by `summarize` and guarded by a dedicated test to preserve backend compatibility.


##### `MemoriesClient::summarize`  (lines 36–48)

```
async fn summarize(
        &self,
        body: serde_json::Value,
        extra_headers: HeaderMap,
    ) -> Result<Vec<MemorySummarizeOutput>, ApiError>
```

**Purpose**: Posts a raw JSON summarize request and decodes the returned list of memory summaries.

**Data flow**: Accepts a JSON body and extra headers, sends a POST via `session.execute` to `Self::path()`, deserializes the response body into `SummarizeResponse`, and returns its `output` vector. JSON decode failures become `ApiError::Stream` containing the serde error string.

**Call relations**: This is the core transport method for the endpoint. `summarize_input` delegates to it after serializing the typed input.

*Call graph*: calls 1 internal fn (execute); called by 1 (summarize_input); 2 external calls (path, from_slice).


##### `MemoriesClient::summarize_input`  (lines 50–59)

```
async fn summarize_input(
        &self,
        input: &MemorySummarizeInput,
        extra_headers: HeaderMap,
    ) -> Result<Vec<MemorySummarizeOutput>, ApiError>
```

**Purpose**: Serializes a typed `MemorySummarizeInput` and submits it to the summarize endpoint.

**Data flow**: Takes a borrowed typed input and extra headers, serializes the input with `to_value`, maps serialization failures to `ApiError::Stream` with contextual text, and forwards the JSON body to `summarize`, returning its parsed output.

**Call relations**: Typed convenience wrapper over `summarize`, used by callers and by the module's main test.

*Call graph*: calls 1 internal fn (summarize); 1 external calls (to_value).


##### `tests::DummyTransport::execute`  (lines 92–94)

```
async fn execute(&self, _req: Request) -> Result<Response, TransportError>
```

**Purpose**: Test stub that fails if a non-streaming execute call is unexpectedly made.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("execute should not run"))`.

**Call relations**: Used only for the static path test, ensuring no real transport behavior is involved.

*Call graph*: 1 external calls (Build).


##### `tests::DummyTransport::stream`  (lines 96–98)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Test stub that fails if a streaming call is unexpectedly attempted.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("stream should not run"))`.

**Call relations**: Completes the dummy transport implementation for tests that only care about static endpoint metadata.

*Call graph*: 1 external calls (Build).


##### `tests::DummyAuth::add_auth_headers`  (lines 105–105)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: No-op auth provider used in tests.

**Data flow**: Receives a mutable header map and leaves it unchanged.

**Call relations**: Supplies the auth dependency when constructing `MemoriesClient` in tests without affecting request assertions.


##### `tests::CapturingTransport::new`  (lines 115–120)

```
fn new(response_body: Vec<u8>) -> Self
```

**Purpose**: Creates a transport that records the last request and returns a fixed response body.

**Data flow**: Initializes `last_request` as `Arc<Mutex<Option<Request>>>` set to `None`, stores the provided response bytes in an `Arc<Vec<u8>>`, and returns the configured transport.

**Call relations**: Used by the summarize-input test to inspect the exact request emitted by `MemoriesClient`.

*Call graph*: 2 external calls (new, new).


##### `tests::CapturingTransport::execute`  (lines 124–131)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Captures the outgoing request and returns a canned successful response.

**Data flow**: Stores the incoming `Request` in the mutex-protected slot, then returns `Response { status: 200 OK, headers: empty, body: cloned canned bytes }`.

**Call relations**: This is the transport path exercised by `MemoriesClient::summarize` in the async test.

*Call graph*: 1 external calls (new).


##### `tests::CapturingTransport::stream`  (lines 133–135)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Fails if the streaming transport path is used during memory endpoint tests.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("stream should not run"))`.

**Call relations**: Ensures the tested endpoint remains on the ordinary request/response path.

*Call graph*: 1 external calls (Build).


##### `tests::provider`  (lines 138–153)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Builds a deterministic provider fixture with a caller-supplied base URL.

**Data flow**: Returns a `Provider` populated with the given base URL, fixed name `test`, empty headers/query params, a one-attempt retry policy, and a one-second stream idle timeout.

**Call relations**: Used by the summarize-input test so the expected full request URL can be asserted exactly.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::path_is_memories_trace_summarize_for_wire_compatibility`  (lines 156–161)

```
fn path_is_memories_trace_summarize_for_wire_compatibility()
```

**Purpose**: Asserts that the endpoint path remains the exact backend-compatible string.

**Data flow**: Calls `MemoriesClient::<DummyTransport>::path()` and compares it to `memories/trace_summarize`.

**Call relations**: Protects the static path consumed by `MemoriesClient::summarize` from accidental renaming.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::summarize_input_posts_expected_payload_and_parses_output`  (lines 164–224)

```
async fn summarize_input_posts_expected_payload_and_parses_output()
```

**Purpose**: Verifies that `summarize_input` serializes the typed request under the expected wire keys, posts to the correct URL, and parses the returned summaries.

**Data flow**: Creates a capturing transport with a canned response containing one output item, constructs a client, builds a `MemorySummarizeInput` with one `RawMemory`, calls `summarize_input`, and asserts the parsed output length and fields. It then inspects the captured request to verify method `POST`, the full URL ending in `/memories/trace_summarize`, and JSON body fields including `model`, `traces[0].id`, and nested `metadata.source_path`.

**Call relations**: Exercises the full typed path `summarize_input` → `summarize` → transport and validates both serialization and deserialization contracts for the endpoint.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, new, assert_eq!, new, provider, json!, to_vec, vec!).


### `codex-api/src/endpoint/images.rs`

`io_transport` · `request handling`

This module wraps image-related REST endpoints behind `ImagesClient<T>`, another thin `EndpointSession`-based transport client. The constructor and `with_telemetry` mirror other endpoint clients. Public methods `generate` and `edit` differ only in endpoint path and operation label; both delegate to the private generic helper `post_image_request`.

`post_image_request` is the core implementation. It accepts any serializable request type, converts it to `serde_json::Value`, and on serialization failure returns `ApiError::Stream` with an operation-specific message such as `failed to encode image generation request`. It then performs a POST through `session.execute` and deserializes the response body into `ImageResponse`, again wrapping decode failures with operation-specific context. This keeps the public methods small while preserving precise error messages.

The test module builds realistic end-to-end fixtures. `DummyAuth` contributes no headers. `CapturingTransport` stores the last `Request` in a mutex and returns a canned JSON body, allowing tests to inspect the exact URL and JSON payload sent by `generate` and `edit`. Helper functions construct a provider, a representative successful response body, the expected typed `ImageResponse`, and the captured request. The tests verify that optional fields are omitted from request JSON when absent, that the correct endpoint paths are used (`images/generations` and `images/edits`), and that malformed responses missing required `data` fail with a decode error wrapped as `ApiError::Stream`.

#### Function details

##### `ImagesClient::new`  (lines 21–25)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs an image-endpoint client around a new `EndpointSession`.

**Data flow**: Consumes a transport, provider, and shared auth provider, creates an `EndpointSession` from them, and stores it in `ImagesClient`.

**Call relations**: Used by production setup and by the module's tests before calling `generate` or `edit`.

*Call graph*: calls 1 internal fn (new); called by 4 (edit_posts_typed_request_and_parses_image_response, generate_posts_typed_request_and_parses_image_response, image_response_requires_image_data, client).


##### `ImagesClient::with_telemetry`  (lines 27–31)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a client whose underlying session includes optional request telemetry.

**Data flow**: Consumes `self`, applies `with_request_telemetry` to the stored session, and returns a new `ImagesClient` containing the updated session.

**Call relations**: Builder-style companion to `ImagesClient::new`, allowing instrumentation to be attached before requests are sent.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `ImagesClient::generate`  (lines 33–45)

```
async fn generate(
        &self,
        request: &ImageGenerationRequest,
        extra_headers: HeaderMap,
    ) -> Result<ImageResponse, ApiError>
```

**Purpose**: Sends a typed image-generation request to the `images/generations` endpoint and decodes the typed image response.

**Data flow**: Accepts an `ImageGenerationRequest` reference and extra headers, then forwards them to `post_image_request` with the generation path and operation label `image generation`. It returns the resulting `ImageResponse` or `ApiError`.

**Call relations**: Public convenience method layered over `post_image_request`; exercised by generation tests and by higher-level callers needing image creation.

*Call graph*: calls 1 internal fn (post_image_request).


##### `ImagesClient::edit`  (lines 47–54)

```
async fn edit(
        &self,
        request: &ImageEditRequest,
        extra_headers: HeaderMap,
    ) -> Result<ImageResponse, ApiError>
```

**Purpose**: Sends a typed image-edit request to the `images/edits` endpoint and decodes the typed image response.

**Data flow**: Accepts an `ImageEditRequest` reference and extra headers, then delegates to `post_image_request` with the edit path and operation label `image edit`.

**Call relations**: Public counterpart to `generate`, sharing all transport and error-handling logic through `post_image_request`.

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

**Purpose**: Implements the shared POST/serialize/decode flow for both image generation and image editing.

**Data flow**: Takes an endpoint path, a serializable request reference, extra headers, and an operation label. It serializes the request with `to_value`, mapping failures to `ApiError::Stream` with contextual text; sends a POST via `session.execute`; then deserializes `resp.body` into `ImageResponse`, mapping decode failures to another contextual `ApiError::Stream`. It returns the typed response on success.

**Call relations**: This private helper is the common implementation invoked by both `generate` and `edit`, ensuring identical transport behavior and consistent error wording.

*Call graph*: calls 1 internal fn (execute); called by 2 (edit, generate); 2 external calls (from_slice, to_value).


##### `tests::DummyAuth::add_auth_headers`  (lines 98–98)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: No-op auth provider used in tests so request assertions are not polluted by authentication headers.

**Data flow**: Receives a mutable `HeaderMap` and intentionally leaves it unchanged.

**Call relations**: Supplies the `AuthProvider` dependency when constructing `ImagesClient` in tests.


##### `tests::CapturingTransport::new`  (lines 108–113)

```
fn new(response_body: Vec<u8>) -> Self
```

**Purpose**: Creates a test transport that records the last request and returns a fixed response body.

**Data flow**: Wraps an initially empty `Mutex<Option<Request>>` and the provided response bytes in `Arc`s, then returns the configured `CapturingTransport`.

**Call relations**: Used by all endpoint tests in this module to inspect outbound requests while controlling the inbound response payload.

*Call graph*: 2 external calls (new, new).


##### `tests::CapturingTransport::execute`  (lines 117–124)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Captures the outgoing request and returns a successful HTTP response containing the canned body.

**Data flow**: Stores the incoming `Request` into `last_request`, then returns `Response { status: 200 OK, headers: empty, body: cloned canned bytes }`.

**Call relations**: This is the transport path exercised by `ImagesClient::post_image_request` in the tests, enabling assertions on URL and JSON body.

*Call graph*: 1 external calls (new).


##### `tests::CapturingTransport::stream`  (lines 126–128)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Fails if the streaming transport path is used during image endpoint tests.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("stream should not run"))`.

**Call relations**: Completes the `HttpTransport` implementation for the capturing transport while ensuring image requests remain non-streaming.

*Call graph*: 1 external calls (Build).


##### `tests::provider`  (lines 131–146)

```
fn provider() -> Provider
```

**Purpose**: Builds a deterministic `Provider` fixture for image endpoint tests.

**Data flow**: Returns a `Provider` with fixed name `test`, base URL `https://example.com/api/codex`, empty headers/query params, a one-attempt retry policy, and a one-second stream idle timeout.

**Call relations**: Used by the request/response tests to ensure generated URLs are stable and easy to assert.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::response_body`  (lines 148–171)

```
fn response_body() -> Vec<u8>
```

**Purpose**: Constructs a representative successful image API response body as raw JSON bytes.

**Data flow**: Builds a JSON object containing creation time, background, one `b64_json` image datum, output format, quality, size, and usage details, then serializes it to `Vec<u8>`.

**Call relations**: Supplies the canned response returned by `CapturingTransport::new` in the success-path tests.

*Call graph*: 2 external calls (json!, to_vec).


##### `tests::expected_response`  (lines 173–183)

```
fn expected_response() -> ImageResponse
```

**Purpose**: Builds the typed `ImageResponse` value expected after decoding the canned success body.

**Data flow**: Returns an `ImageResponse` with the same semantic fields as `response_body`, including one `ImageData` entry and selected optional enums.

**Call relations**: Used by both success-path tests to compare the decoded response against a typed expected value.

*Call graph*: 1 external calls (vec!).


##### `tests::captured_request`  (lines 185–192)

```
fn captured_request(transport: &CapturingTransport) -> Request
```

**Purpose**: Retrieves the last request recorded by the capturing transport, failing the test if none was stored.

**Data flow**: Locks the transport's mutex, clones the stored `Request`, and unwraps the `Option`, returning the captured request.

**Call relations**: Shared helper for the success-path tests after `generate` or `edit` has run.


##### `tests::generate_posts_typed_request_and_parses_image_response`  (lines 195–231)

```
async fn generate_posts_typed_request_and_parses_image_response()
```

**Purpose**: Verifies that `generate` posts the expected JSON payload to the correct URL and decodes the response body into `ImageResponse`.

**Data flow**: Creates a capturing transport with the canned response, constructs a client, calls `generate` with a populated `ImageGenerationRequest`, asserts the returned typed response equals `expected_response`, then inspects the captured request URL and JSON body to ensure optional fields were serialized correctly.

**Call relations**: Exercises the full `ImagesClient::generate` → `post_image_request` → transport path for the generation endpoint.

*Call graph*: calls 1 internal fn (new); 7 external calls (new, new, assert_eq!, new, captured_request, provider, response_body).


##### `tests::edit_posts_typed_request_and_parses_image_response`  (lines 234–268)

```
async fn edit_posts_typed_request_and_parses_image_response()
```

**Purpose**: Verifies that `edit` posts the expected JSON payload to the edit URL and decodes the response body correctly.

**Data flow**: Builds a client over a capturing transport, calls `edit` with an `ImageEditRequest` containing one image URL and prompt, asserts the typed response matches `expected_response`, and checks the captured request URL and JSON body omit absent optional fields.

**Call relations**: Exercises the full `ImagesClient::edit` path and confirms it differs from generation only in endpoint path and request shape.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, new, assert_eq!, new, captured_request, provider, response_body, vec!).


##### `tests::image_response_requires_image_data`  (lines 271–299)

```
async fn image_response_requires_image_data()
```

**Purpose**: Checks that decoding fails when the server response omits the required `data` field.

**Data flow**: Creates a transport whose body is minimal JSON lacking `data`, calls `generate`, expects an error, destructures it as `ApiError::Stream`, and asserts the message begins with the contextual decode prefix plus serde's missing-field text.

**Call relations**: Covers the error path in `post_image_request` where response deserialization fails and must be wrapped with an operation-specific message.

*Call graph*: calls 1 internal fn (new); 8 external calls (new, new, assert!, new, provider, json!, panic!, to_vec).


### `codex-api/src/endpoint/search.rs`

`io_transport` · `request handling`

This file defines `SearchClient<T>`, a minimal endpoint client that sends `SearchRequest` values and decodes `SearchResponse` values over the shared HTTP transport/session layer. Compared with the responses clients, the implementation is intentionally small: there is no streaming path, no custom headers beyond what the caller supplies, and no endpoint-specific body rewriting.

The client stores only an `EndpointSession<T>`. Construction and telemetry wiring mirror other endpoint clients: `new` creates the session from transport, provider, and auth; `with_telemetry` returns a rebuilt client with request telemetry attached to the session. The endpoint path is fixed as `alpha/search`.

`search` is the core operation. It serializes the typed `SearchRequest` into `serde_json::Value` with `serde_json::to_value`, maps serialization failures into `ApiError::Stream`, performs a POST through `EndpointSession::execute`, and then deserializes the raw response body bytes into `SearchResponse` with `serde_json::from_slice`, again mapping decode failures into `ApiError::Stream`.

The test module supplies a `DummyAuth` that adds no headers and a `CapturingTransport` that records the outgoing `Request` while returning a canned JSON body. The end-to-end test verifies both directions: the response body is decoded into the expected `SearchResponse`, and the emitted JSON request body exactly matches the nested search schema, including multimodal input items, command lists, location/filter/image settings, allowed callers, and token limits.

#### Function details

##### `SearchClient::new`  (lines 19–23)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a search client from a transport, provider, and auth source. It initializes the shared endpoint session used for all search requests.

**Data flow**: Consumes `transport: T`, `provider: Provider`, and `auth: SharedAuthProvider`, creates `EndpointSession::new(transport, provider, auth)`, stores it in `SearchClient`, and returns the client.

**Call relations**: This constructor is used by production code and tests before any search call can be made. It delegates common HTTP/auth setup to `EndpointSession`.

*Call graph*: calls 1 internal fn (new); called by 2 (search_posts_typed_request_and_parses_output, handle_call).


##### `SearchClient::with_telemetry`  (lines 25–29)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client with request telemetry attached to its session. It is a builder-style customization step.

**Data flow**: Consumes `self` and an optional `Arc<dyn RequestTelemetry>`, replaces the embedded session with `self.session.with_request_telemetry(request)`, and returns the rebuilt `SearchClient<T>`.

**Call relations**: This method is called when callers want request instrumentation around search HTTP calls. It relies on `EndpointSession` to store and later use the telemetry hook.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `SearchClient::path`  (lines 31–33)

```
fn path() -> &'static str
```

**Purpose**: Defines the fixed relative route for the search endpoint. It avoids repeating the literal path string.

**Data flow**: Takes no arguments and returns `"alpha/search"`.

**Call relations**: This helper is used by `SearchClient::search` when issuing the POST request.


##### `SearchClient::search`  (lines 35–48)

```
async fn search(
        &self,
        request: &SearchRequest,
        extra_headers: HeaderMap,
    ) -> Result<SearchResponse, ApiError>
```

**Purpose**: Sends a typed search request as JSON and decodes the JSON response into `SearchResponse`. It is the file's main endpoint operation.

**Data flow**: Accepts `&SearchRequest` and caller-supplied `HeaderMap`. It serializes the request with `to_value`, maps serialization errors to `ApiError::Stream`, then calls `self.session.execute(Method::POST, Self::path(), extra_headers, Some(body))`. After awaiting the HTTP response, it deserializes `resp.body` with `serde_json::from_slice` into `SearchResponse`, mapping decode failures to `ApiError::Stream`, and returns the typed response.

**Call relations**: This public method is the only runtime operation in the file. It delegates transport/auth/retry behavior to `EndpointSession::execute` and keeps only endpoint-specific serialization and path selection locally.

*Call graph*: calls 1 internal fn (execute); 3 external calls (path, from_slice, to_value).


##### `tests::DummyAuth::add_auth_headers`  (lines 84–84)

```
fn add_auth_headers(&self, _headers: &mut HeaderMap)
```

**Purpose**: Implements a no-op auth provider for tests. It allows request construction without introducing authorization headers into assertions.

**Data flow**: Receives a mutable `HeaderMap` reference and intentionally leaves it unchanged.

**Call relations**: This test helper is used indirectly when `SearchClient::new` is given `Arc::new(DummyAuth)` in the end-to-end serialization test.


##### `tests::CapturingTransport::new`  (lines 94–99)

```
fn new(response_body: Vec<u8>) -> Self
```

**Purpose**: Creates a fake HTTP transport that records the last request and returns a fixed response body. It is used to inspect what `SearchClient` sends.

**Data flow**: Consumes `response_body: Vec<u8>`, wraps an initially empty `Option<Request>` in `Arc<Mutex<_>>`, wraps the response bytes in `Arc<Vec<u8>>`, and returns `CapturingTransport` holding both.

**Call relations**: This constructor is used by the search test before building `SearchClient`. The resulting transport's `execute` method captures the request emitted by `SearchClient::search`.

*Call graph*: 2 external calls (new, new).


##### `tests::CapturingTransport::execute`  (lines 103–110)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Implements the fake transport's non-streaming request path by recording the request and returning a canned successful response. It simulates the HTTP layer for the search test.

**Data flow**: Accepts a `Request`, stores it into `last_request` under a mutex, and returns `Ok(Response { status: 200 OK, headers: HeaderMap::new(), body: cloned response_body })`.

**Call relations**: This method is invoked by `EndpointSession::execute` during the search test. It provides the captured request body that the test later inspects.

*Call graph*: 1 external calls (new).


##### `tests::CapturingTransport::stream`  (lines 112–114)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Rejects streaming calls on the fake transport because the search endpoint should not use them. It makes accidental use of the wrong transport path fail loudly in tests.

**Data flow**: Ignores the incoming `Request` and returns `Err(TransportError::Build("stream should not run".to_string()))`.

**Call relations**: This method would only be reached if the search client incorrectly used the streaming transport API. Its presence enforces the intended non-streaming behavior in tests.

*Call graph*: 1 external calls (Build).


##### `tests::provider`  (lines 117–132)

```
fn provider() -> Provider
```

**Purpose**: Builds a deterministic `Provider` configuration for tests. It supplies a base URL, empty headers, and a simple retry/timeout policy.

**Data flow**: Constructs and returns a `Provider` with name `test`, base URL `https://example.com/v1`, no query params, empty headers, retry config with one attempt and short delays, and a one-second stream idle timeout.

**Call relations**: This helper is used by the search test when constructing `SearchClient`. It supplies the provider metadata consumed by `EndpointSession`.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::search_posts_typed_request_and_parses_output`  (lines 135–266)

```
async fn search_posts_typed_request_and_parses_output()
```

**Purpose**: Exercises `SearchClient::search` end to end, verifying both typed response decoding and exact JSON request serialization for a complex search payload. It serves as the contract test for this endpoint wrapper.

**Data flow**: Creates a `CapturingTransport` with a canned JSON response body, builds a `SearchClient` with the test provider and dummy auth, and calls `search` with a richly populated `SearchRequest` containing multimodal input, search/open commands, settings, and token limits. After awaiting success, it asserts the returned `SearchResponse`, retrieves the captured `Request` from the transport, extracts its JSON body, and asserts exact equality with the expected nested JSON structure.

**Call relations**: This test drives the full runtime path through `SearchClient::new`, `SearchClient::search`, `EndpointSession::execute`, and the fake transport's `execute`, then inspects the captured request to validate serialization.

*Call graph*: calls 1 internal fn (new); 10 external calls (new, default, new, assert_eq!, new, provider, Items, json!, to_vec, vec!).


### `codex-api/src/endpoint/realtime_call.rs`

`domain_logic` · `request handling`

This file defines `RealtimeCallClient<T>`, the HTTP-side companion to the realtime websocket code. It creates realtime calls by POSTing SDP offers to `realtime/calls` and decoding two pieces of response state: the returned SDP answer body and the call identifier embedded in the `Location` header. The client is built on `EndpointSession<T>`, so auth, provider headers, retries, and telemetry are inherited from the common endpoint layer.

The central complexity is in `create_with_session_architecture_and_headers`. It first converts `RealtimeSessionConfig` into JSON using the websocket session-update schema, then removes the `id` field because call creation should not send a session identifier in the embedded session payload. It supports two wire formats: providers whose base URL contains `/backend-api` receive a JSON body shaped as `{ sdp, session }`, while the public API receives a manually assembled multipart/form-data body with `sdp` and `session` parts. Architecture-specific query parameters are added for `Avas` calls (`intent=quicksilver&architecture=avas`).

Helper functions keep the parsing and URL shaping explicit: `decode_sdp_response` enforces UTF-8 SDP bodies, `decode_call_id_from_location` extracts either `rtc_...` IDs or UUIDs from the `Location` path, and `is_realtime_call_id_segment` encodes that acceptance rule. Tests cover raw SDP requests, backend forwarding quirks, multipart vs JSON body selection, AVAS query parameters, and missing or malformed `Location` headers.

#### Function details

##### `RealtimeCallClient::new`  (lines 50–54)

```
fn new(transport: T, provider: Provider, auth: SharedAuthProvider) -> Self
```

**Purpose**: Constructs a realtime call client backed by an `EndpointSession`.

**Data flow**: Consumes `transport: T`, `provider: Provider`, and `auth: SharedAuthProvider` → creates `EndpointSession::new(...)` → returns `RealtimeCallClient<T>`.

**Call relations**: Used by callers and tests before any call-creation method can run. It establishes the shared session object that all later HTTP requests use.

*Call graph*: calls 1 internal fn (new); called by 6 (errors_when_location_is_missing, extracts_call_id_from_forwarded_backend_location, sends_api_session_call_as_multipart_body, sends_avas_session_call_query_params, sends_backend_session_call_as_json_body, sends_sdp_offer_as_raw_body).


##### `RealtimeCallClient::with_telemetry`  (lines 56–60)

```
fn with_telemetry(self, request: Option<Arc<dyn RequestTelemetry>>) -> Self
```

**Purpose**: Returns a copy of the client whose underlying session emits optional request telemetry.

**Data flow**: Consumes `self` and `request: Option<Arc<dyn RequestTelemetry>>` → applies `with_request_telemetry` to the session → returns a new client.

**Call relations**: This is a configuration hook for callers that want telemetry attached to subsequent `create*` requests.

*Call graph*: calls 1 internal fn (with_request_telemetry).


##### `RealtimeCallClient::path`  (lines 62–64)

```
fn path() -> &'static str
```

**Purpose**: Supplies the relative endpoint path for realtime call creation.

**Data flow**: Returns the static string `"realtime/calls"`.

**Call relations**: Referenced by all request-building methods in this file when invoking `EndpointSession::execute_with`.


##### `RealtimeCallClient::uses_backend_request_shape`  (lines 66–68)

```
fn uses_backend_request_shape(&self) -> bool
```

**Purpose**: Detects whether the provider expects the backend JSON request format instead of the public multipart format.

**Data flow**: Reads `self.session.provider().base_url` → checks whether it contains `"/backend-api"` → returns `bool`.

**Call relations**: Called only from `RealtimeCallClient::create_with_session_architecture_and_headers` to choose between the backend `{sdp, session}` JSON body and the multipart API body.

*Call graph*: calls 1 internal fn (provider); called by 1 (create_with_session_architecture_and_headers).


##### `RealtimeCallClient::create`  (lines 79–81)

```
async fn create(&self, sdp: String) -> Result<RealtimeCallResponse, ApiError>
```

**Purpose**: Creates a realtime call from an SDP offer using default empty extra headers.

**Data flow**: Takes `sdp: String` → constructs an empty `HeaderMap` → forwards to `create_with_headers` → returns the resulting `RealtimeCallResponse` or `ApiError`.

**Call relations**: This is the simplest public entrypoint for call creation. It is a convenience wrapper over `create_with_headers`.

*Call graph*: calls 1 internal fn (create_with_headers); 1 external calls (new).


##### `RealtimeCallClient::create_with_session`  (lines 83–90)

```
async fn create_with_session(
        &self,
        sdp: String,
        session_config: RealtimeSessionConfig,
    ) -> Result<RealtimeCallResponse, ApiError>
```

**Purpose**: Creates a realtime call while embedding an initial session configuration, using no extra headers.

**Data flow**: Takes `sdp: String` and `session_config: RealtimeSessionConfig` → forwards them with an empty `HeaderMap` to `create_with_session_and_headers` → returns the response or error.

**Call relations**: Convenience wrapper for callers that want the initial session payload included but do not need custom headers.

*Call graph*: calls 1 internal fn (create_with_session_and_headers); 1 external calls (new).


##### `RealtimeCallClient::create_with_headers`  (lines 92–116)

```
async fn create_with_headers(
        &self,
        sdp: String,
        extra_headers: HeaderMap,
    ) -> Result<RealtimeCallResponse, ApiError>
```

**Purpose**: Posts a raw SDP offer as `application/sdp`, then decodes the SDP answer and call ID from the response.

**Data flow**: Reads `sdp: String` and `extra_headers: HeaderMap` → calls `session.execute_with` using `POST`, path `realtime/calls`, no JSON body, and a closure that sets `Content-Type: application/sdp` and `RequestBody::Raw(Bytes::from(sdp.clone()))` → decodes `resp.body` with `decode_sdp_response` and `resp.headers` with `decode_call_id_from_location` → returns `RealtimeCallResponse { sdp, call_id }`.

**Call relations**: Called by `RealtimeCallClient::create`. It is the non-session branch for plain call creation and delegates response parsing to the local helper functions.

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

**Purpose**: Creates a realtime call with an initial session payload using the default `RealtimeApi` architecture.

**Data flow**: Takes `sdp`, `session_config`, and `extra_headers` → forwards them plus `RealtimeConversationArchitecture::RealtimeApi` to `create_with_session_architecture_and_headers` → returns its result.

**Call relations**: Called by `create_with_session`; it exists to keep architecture selection explicit while preserving a simpler public API.

*Call graph*: calls 1 internal fn (create_with_session_architecture_and_headers); called by 1 (create_with_session).


##### `RealtimeCallClient::create_with_session_architecture_and_headers`  (lines 133–208)

```
async fn create_with_session_architecture_and_headers(
        &self,
        sdp: String,
        session_config: RealtimeSessionConfig,
        architecture: RealtimeConversationArchitecture,
```

**Purpose**: Builds and sends the full realtime call creation request with embedded session state, selecting backend JSON or public multipart encoding and optionally AVAS query parameters.

**Data flow**: Consumes `sdp: String`, `session_config: RealtimeSessionConfig`, `architecture`, and `extra_headers` → logs the outgoing SDP → converts session config with `realtime_session_json`, removes `id` from the resulting object, then branches: if `uses_backend_request_shape()` is true, wraps `{ sdp, session }` into JSON and sends it via `execute_with` while `configure_realtime_call_request` may append architecture query params; otherwise serializes the session to a JSON string, manually assembles a multipart body using the fixed boundary constants, sets multipart `Content-Type`, and sends raw bytes. In both branches it decodes the response body as UTF-8 SDP and extracts `call_id` from `Location`, returning `RealtimeCallResponse`.

**Call relations**: This is the file’s main implementation path, reached from `create_with_session_and_headers`. It delegates session JSON generation to `realtime_session_json`, request URL shaping to `configure_realtime_call_request`, transport execution to `EndpointSession::execute_with`, and response parsing to `decode_sdp_response` and `decode_call_id_from_location`.

*Call graph*: calls 5 internal fn (uses_backend_request_shape, decode_call_id_from_location, decode_sdp_response, realtime_session_json, execute_with); called by 1 (create_with_session_and_headers); 6 external calls (path, new, format!, to_string, to_value, trace!).


##### `configure_realtime_call_request`  (lines 211–222)

```
fn configure_realtime_call_request(
    request: &mut Request,
    architecture: RealtimeConversationArchitecture,
)
```

**Purpose**: Applies architecture-specific URL query parameters to an outgoing realtime call request.

**Data flow**: Takes `request: &mut Request` and `architecture` → leaves the URL unchanged for `RealtimeApi` or appends `intent=quicksilver` and `architecture=avas` for `Avas`.

**Call relations**: Used inside both request-shaping closures in `create_with_session_architecture_and_headers` so architecture-specific routing is applied consistently regardless of body format.

*Call graph*: calls 1 internal fn (append_query_pair).


##### `append_query_pair`  (lines 224–233)

```
fn append_query_pair(url: &mut String, key: &str, value: &str)
```

**Purpose**: Appends one `key=value` pair to a URL string, choosing `?` or `&` based on whether a query already exists.

**Data flow**: Mutates `url: &mut String` by inspecting for `?`, then pushing separator, key, `=`, and value.

**Call relations**: Called by `configure_realtime_call_request` to build the AVAS query string incrementally.

*Call graph*: called by 1 (configure_realtime_call_request).


##### `realtime_session_json`  (lines 235–238)

```
fn realtime_session_json(session_config: RealtimeSessionConfig) -> Result<Value, ApiError>
```

**Purpose**: Converts a `RealtimeSessionConfig` into the JSON session object used in realtime call creation and rewrites serialization failures as `ApiError::Stream`.

**Data flow**: Consumes `session_config` → calls `session_update_session_json(session_config)` → on success returns `serde_json::Value`; on failure returns `ApiError::Stream("failed to encode realtime call session: ...")`.

**Call relations**: Used by `create_with_session_architecture_and_headers` and by tests that need to compare the exact embedded session payload.

*Call graph*: called by 3 (create_with_session_architecture_and_headers, sends_api_session_call_as_multipart_body, sends_backend_session_call_as_json_body); 1 external calls (session_update_session_json).


##### `decode_sdp_response`  (lines 240–246)

```
fn decode_sdp_response(body: &[u8]) -> Result<String, ApiError>
```

**Purpose**: Interprets the HTTP response body as a UTF-8 SDP answer string.

**Data flow**: Takes `body: &[u8]` → clones to `Vec<u8>` and runs `String::from_utf8` → returns the decoded `String` or `ApiError::Stream` if the bytes are not valid UTF-8.

**Call relations**: Called after successful HTTP execution in both `create_with_headers` and `create_with_session_architecture_and_headers`.

*Call graph*: called by 2 (create_with_headers, create_with_session_architecture_and_headers); 1 external calls (from_utf8).


##### `decode_call_id_from_location`  (lines 248–268)

```
fn decode_call_id_from_location(headers: &HeaderMap) -> Result<String, ApiError>
```

**Purpose**: Extracts the realtime call identifier from the response `Location` header, accepting either `rtc_...` IDs or UUID path segments.

**Data flow**: Reads `headers: &HeaderMap` → fetches `LOCATION`, errors if missing, converts it to `&str`, strips any query string, splits path segments from the end, selects the first segment accepted by `is_realtime_call_id_segment`, and returns it as `String`; otherwise returns an `ApiError::Stream` describing the malformed location.

**Call relations**: Used by both call-creation response paths and directly by tests. It is the only place that understands forwarded backend locations like `/v1/realtime/calls/calls/rtc_backend_test`.

*Call graph*: called by 4 (create_with_headers, create_with_session_architecture_and_headers, accepts_uuid_call_id_from_location, rejects_location_without_call_id); 2 external calls (get, trace!).


##### `is_realtime_call_id_segment`  (lines 270–283)

```
fn is_realtime_call_id_segment(segment: &str) -> bool
```

**Purpose**: Recognizes valid call-id path segments by either the `rtc_` prefix convention or canonical 36-character UUID formatting.

**Data flow**: Takes `segment: &str` → returns `true` if it starts with `rtc_` and has additional characters, or if it is 36 chars long with hyphens at UUID positions and hex digits elsewhere; otherwise returns `false`.

**Call relations**: Called only by `decode_call_id_from_location` to validate candidate path segments.


##### `tests::CapturingTransport::new`  (lines 310–312)

```
fn new() -> Self
```

**Purpose**: Creates a test transport whose response includes a default `Location` header containing `rtc_test`.

**Data flow**: Delegates to `with_location("/v1/realtime/calls/rtc_test")` and returns the resulting transport.

**Call relations**: Used by most tests as the standard successful transport fixture.

*Call graph*: 1 external calls (with_location).


##### `tests::CapturingTransport::with_location`  (lines 314–321)

```
fn with_location(location: &str) -> Self
```

**Purpose**: Creates a test transport that records the last request and returns a response with a caller-specified `Location` header.

**Data flow**: Takes `location: &str` → builds a `HeaderMap` containing `LOCATION` parsed from that string, initializes `last_request` to `None`, and returns `CapturingTransport`.

**Call relations**: Used by tests that need to verify call-id extraction from different location formats, including forwarded backend paths.

*Call graph*: 4 external calls (new, new, from_str, new).


##### `tests::CapturingTransport::without_location`  (lines 323–328)

```
fn without_location() -> Self
```

**Purpose**: Creates a test transport whose response omits the `Location` header entirely.

**Data flow**: Constructs `last_request` with no captured request and an empty `response_headers` map → returns the transport.

**Call relations**: Used by the missing-header error test to force `decode_call_id_from_location` failure through the normal client path.

*Call graph*: 3 external calls (new, new, new).


##### `tests::CapturingTransport::execute`  (lines 332–339)

```
async fn execute(&self, req: Request) -> Result<Response, TransportError>
```

**Purpose**: Implements the test HTTP transport by capturing the request and returning a fixed SDP answer body plus configured headers.

**Data flow**: Stores `req` into `last_request`, clones `response_headers`, and returns `Response { status: 200 OK, headers, body: b"v=0\r\n" }`.

**Call relations**: Invoked by the session layer during all realtime call tests so assertions can inspect the exact outgoing request.

*Call graph*: 2 external calls (from_static, clone).


##### `tests::CapturingTransport::stream`  (lines 341–343)

```
async fn stream(&self, _req: Request) -> Result<StreamResponse, TransportError>
```

**Purpose**: Fails if any test accidentally tries to use streaming transport for realtime call creation.

**Data flow**: Ignores the request and returns `Err(TransportError::Build("stream should not run"))`.

**Call relations**: Acts as a negative assertion that this endpoint uses ordinary HTTP execution only.

*Call graph*: 1 external calls (Build).


##### `tests::DummyAuth::add_auth_headers`  (lines 350–355)

```
fn add_auth_headers(&self, headers: &mut HeaderMap)
```

**Purpose**: Adds a fixed bearer token to test requests so auth propagation can be asserted.

**Data flow**: Mutates the provided `HeaderMap` by inserting `Authorization: Bearer test-token`.

**Call relations**: Used by all client-construction tests; it lets request assertions confirm that auth headers from the session layer are preserved.

*Call graph*: 2 external calls (insert, from_static).


##### `tests::provider`  (lines 358–373)

```
fn provider(base_url: &str) -> Provider
```

**Purpose**: Builds a deterministic `Provider` fixture for realtime call tests.

**Data flow**: Takes `base_url` and returns a `Provider` with fixed name, empty headers, no query params, single-attempt retry config, and short timeout values.

**Call relations**: Supplies the base URL that drives backend/public request-shape branching in the client under test.

*Call graph*: 3 external calls (from_millis, from_secs, new).


##### `tests::realtime_session_config`  (lines 375–385)

```
fn realtime_session_config(session_id: &str) -> RealtimeSessionConfig
```

**Purpose**: Creates a representative `RealtimeSessionConfig` fixture with audio conversational defaults and a caller-specified session ID.

**Data flow**: Takes `session_id: &str` → fills `instructions`, `model`, `session_id`, parser `RealtimeV2`, mode `Conversational`, output modality `Audio`, and voice `Marin` → returns the config.

**Call relations**: Used by session-bearing call tests to generate consistent embedded session payloads.


##### `tests::sends_sdp_offer_as_raw_body`  (lines 388–427)

```
async fn sends_sdp_offer_as_raw_body()
```

**Purpose**: Verifies that plain call creation sends the SDP offer as a raw `application/sdp` body and decodes the response correctly.

**Data flow**: Builds a default transport and client, calls `create("v=offer\r\n")`, asserts the returned `RealtimeCallResponse`, then inspects the captured request method, URL, content type, auth header, and raw body.

**Call relations**: Exercises the `create` → `create_with_headers` path and validates the non-session request shape.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, new, provider).


##### `tests::extracts_call_id_from_forwarded_backend_location`  (lines 430–462)

```
async fn extracts_call_id_from_forwarded_backend_location()
```

**Purpose**: Checks that call IDs are extracted correctly from backend-forwarded `Location` paths containing extra `calls/` segments.

**Data flow**: Uses a transport with location `/v1/realtime/calls/calls/rtc_backend_test`, constructs a backend-base-url client, calls `create`, and asserts both the parsed response and the captured request URL/body.

**Call relations**: Covers the `decode_call_id_from_location` logic for forwarded backend paths while still using the normal client request flow.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, with_location, provider).


##### `tests::sends_api_session_call_as_multipart_body`  (lines 465–524)

```
async fn sends_api_session_call_as_multipart_body()
```

**Purpose**: Verifies that public API session-bearing call creation uses multipart/form-data with separate `sdp` and `session` parts.

**Data flow**: Creates an API-base-url client, calls `create_with_session`, asserts the response, extracts the raw request body as UTF-8, reconstructs the expected session JSON with `id` removed, and compares the full multipart payload string and content type.

**Call relations**: Exercises the non-backend branch of `create_with_session_architecture_and_headers`.

*Call graph*: calls 2 internal fn (new, realtime_session_json); 8 external calls (new, assert_eq!, new, provider, realtime_session_config, panic!, to_string, from_utf8).


##### `tests::sends_avas_session_call_query_params`  (lines 527–559)

```
async fn sends_avas_session_call_query_params()
```

**Purpose**: Checks that AVAS architecture requests append the expected query parameters to the realtime call URL.

**Data flow**: Calls `create_with_session_architecture_and_headers` with `RealtimeConversationArchitecture::Avas`, then inspects the captured request URL for `?intent=quicksilver&architecture=avas`.

**Call relations**: Targets `configure_realtime_call_request` and the architecture-specific branch inside the main session-bearing create method.

*Call graph*: calls 1 internal fn (new); 6 external calls (new, new, assert_eq!, new, provider, realtime_session_config).


##### `tests::sends_backend_session_call_as_json_body`  (lines 562–608)

```
async fn sends_backend_session_call_as_json_body()
```

**Purpose**: Verifies that backend-base-url session-bearing call creation sends a JSON body shaped as `{ sdp, session }`.

**Data flow**: Creates a backend-base-url client, calls `create_with_session`, reconstructs the expected session JSON with `id` removed, and asserts that the captured request body is `RequestBody::Json(to_value(BackendRealtimeCallRequest { ... }))`.

**Call relations**: Exercises the backend branch selected by `uses_backend_request_shape`.

*Call graph*: calls 2 internal fn (new, realtime_session_json); 5 external calls (new, assert_eq!, new, provider, realtime_session_config).


##### `tests::errors_when_location_is_missing`  (lines 611–628)

```
async fn errors_when_location_is_missing()
```

**Purpose**: Confirms that call creation fails when the response omits the `Location` header.

**Data flow**: Uses `CapturingTransport::without_location`, calls `create`, captures the error, and asserts its string form.

**Call relations**: Drives the normal client path into the missing-header error branch of `decode_call_id_from_location`.

*Call graph*: calls 1 internal fn (new); 4 external calls (new, assert_eq!, without_location, provider).


##### `tests::rejects_location_without_call_id`  (lines 631–642)

```
fn rejects_location_without_call_id()
```

**Purpose**: Checks that a `Location` path lacking any valid call-id segment is rejected.

**Data flow**: Builds a `HeaderMap` with `/v1/realtime/calls`, calls `decode_call_id_from_location`, expects an error, and asserts the message.

**Call relations**: Directly unit-tests the helper parser without going through HTTP execution.

*Call graph*: calls 1 internal fn (decode_call_id_from_location); 3 external calls (new, from_static, assert_eq!).


##### `tests::accepts_uuid_call_id_from_location`  (lines 645–655)

```
fn accepts_uuid_call_id_from_location()
```

**Purpose**: Checks that UUID-form call IDs are accepted in addition to `rtc_...` identifiers.

**Data flow**: Builds headers containing a UUID path segment, calls `decode_call_id_from_location`, and asserts the returned string.

**Call relations**: Directly covers the UUID branch in `is_realtime_call_id_segment` via the public helper parser.

*Call graph*: calls 1 internal fn (decode_call_id_from_location); 3 external calls (new, from_static, assert_eq!).


### Core transport orchestration
These files assemble session-scoped model transport behavior in core, including client setup, retries, prewarming, and the streamed remote compaction flow.

### `core/src/client.rs`

`io_transport` · `request handling / model turn execution`

This is the core transport/orchestration layer for model access. `ModelClient` owns session-stable state: thread id, provider/auth plumbing, session source, verbosity/compression/timing flags, optional attestation support, a session-wide websocket-disable switch, and a cached `WebsocketSession`. `ModelClientSession` is created per turn and carries the reusable websocket connection plus turn-local sticky routing state in `Arc<OnceLock<String>>` so `x-codex-turn-state` is replayed only within the same turn.

Request construction is explicit and concrete. `build_responses_request` derives `ResponsesApiRequest` from `Prompt`, `ModelInfo`, reasoning settings, service tier, and `CodexResponsesMetadata`; it strips metadata for non-OpenAI providers, emits tool JSON, computes `text` controls for verbosity/output schema, and sets `store` for Azure responses endpoints. HTTP streaming uses `ApiResponsesClient`; websocket streaming uses `ApiWebSocketResponsesClient` and can compress requests to incremental deltas by comparing non-input request properties and subtracting prior input plus server-returned output items. Warmup sends `generate=false` and waits for completion so later requests can reuse the same connection and `previous_response_id`.

The file also handles 401 recovery through `UnauthorizedRecovery`, emits detailed session and feedback telemetry through `ApiTelemetry`, maps provider streams into internal `ResponseStream`s while preserving partial output for tracing, and permanently falls back from websocket to HTTP when required. Auxiliary unary paths cover conversation compaction, memory summarization, and realtime WebRTC call creation with sideband auth/header reuse.

#### Function details

##### `RequestRouteTelemetry::for_endpoint`  (lines 203–205)

```
fn for_endpoint(endpoint: &'static str) -> Self
```

**Purpose**: Creates a tiny telemetry descriptor that tags requests with a fixed endpoint path. It standardizes endpoint labeling across HTTP, websocket, compact, and memory-summary calls.

**Data flow**: Accepts `endpoint: &'static str` → wraps it in `RequestRouteTelemetry { endpoint }` → returns the struct by value.

**Call relations**: Callers use this helper whenever they build request/websocket telemetry contexts, including compaction, memory summarization, websocket preconnect, HTTP streaming, and websocket streaming. It feeds endpoint names into `ApiTelemetry` so downstream metrics and feedback tags can distinguish `/responses`, `/responses/compact`, and `/memories/trace_summarize`.

*Call graph*: called by 5 (compact_conversation_history, summarize_memories, preconnect_websocket, stream_responses_api, stream_responses_websocket).


##### `responses_request_properties_match`  (lines 272–321)

```
fn responses_request_properties_match(
    previous: &ResponsesApiRequest,
    current: &ResponsesApiRequest,
) -> bool
```

**Purpose**: Compares two `ResponsesApiRequest` values for websocket incremental-reuse compatibility while intentionally ignoring `input` and `client_metadata`. It enforces that only requests with identical non-input semantics can reuse prior websocket state.

**Data flow**: Takes `previous` and `current` requests → destructures both exhaustively, excluding `input` and `client_metadata` from equality checks → compares model, instructions, tools, tool choice, parallel tool calls, reasoning, store, stream, include, service tier, prompt cache key, and text → returns `true` only if all those fields match.

**Call relations**: This helper is only used by `ModelClientSession::get_incremental_items`. Its exhaustive destructuring is a design guard: adding a new request field forces an explicit decision about whether that field affects websocket reuse.

*Call graph*: called by 1 (get_incremental_items).


##### `WebsocketSession::set_connection_reused`  (lines 324–329)

```
fn set_connection_reused(&self, connection_reused: bool)
```

**Purpose**: Stores whether the current websocket request reused an existing connection. The flag is mutex-protected because `WebsocketSession` itself is reused and queried across async request paths.

**Data flow**: Accepts `connection_reused: bool` → locks `self.connection_reused`, recovering from poison if necessary → overwrites the stored boolean.

**Call relations**: Called when preconnecting, resetting, or obtaining a websocket connection. `preconnect_websocket` and `websocket_connection` set it based on whether a fresh handshake occurred; `reset_websocket_session` clears it during transport reset.

*Call graph*: called by 3 (preconnect_websocket, reset_websocket_session, websocket_connection); 1 external calls (lock).


##### `WebsocketSession::connection_reused`  (lines 331–336)

```
fn connection_reused(&self) -> bool
```

**Purpose**: Reads the current connection-reuse flag for websocket request telemetry. It exposes whether the next websocket request should be reported as using an existing socket.

**Data flow**: Locks `self.connection_reused`, recovering from poison if necessary → copies out the stored `bool` → returns it.

**Call relations**: Used by `ModelClientSession::stream_responses_websocket` immediately before sending a websocket request so the provider client and telemetry know whether the socket was reused.

*Call graph*: called by 1 (stream_responses_websocket); 1 external calls (lock).


##### `sideband_websocket_auth_headers`  (lines 360–364)

```
fn sideband_websocket_auth_headers(api_auth: &dyn AuthProvider) -> ApiHeaderMap
```

**Purpose**: Builds auth headers for joining a realtime call over the sideband websocket using the same identity that created the call over HTTP. It preserves bearer/account-id semantics across the two transport phases.

**Data flow**: Creates an empty `ApiHeaderMap` → asks the supplied `AuthProvider` to add its auth headers into that map → returns the populated headers.

**Call relations**: Used only by `ModelClient::create_realtime_call_with_headers`. That method clones ordinary extra headers, extends them with these auth headers, and returns them to the caller for the later sideband websocket join.

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

**Purpose**: Constructs the session-scoped model client with provider/auth state, telemetry metadata, websocket fallback state, and optional attestation support. It is the root initializer for all later turn sessions.

**Data flow**: Accepts optional `AuthManager`, `ThreadId`, `ModelProviderInfo`, `SessionSource`, verbosity/compression/timing flags, beta header, and optional attestation provider → creates a shared model provider via `create_model_provider` → derives auth-environment telemetry and whether attestation is supported → allocates `ModelClientState` inside an `Arc`, initializing `disable_websockets` to `false` and `cached_websocket_session` to default → returns `ModelClient` with no prompt-cache override.

**Call relations**: This constructor is used broadly by production setup and tests. Later methods like `new_session`, `compact_conversation_history`, and `summarize_memories` all depend on the state assembled here.

*Call graph*: calls 1 internal fn (collect_auth_env_telemetry); called by 13 (model_client_with_counting_attestation, test_model_client, new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx, test_model_client_session, responses_respects_model_info_overrides_from_config, responses_stream_includes_subagent_header_on_other, responses_stream_includes_subagent_header_on_review, azure_responses_request_includes_store_and_reasoning_ids (+3 more)); 5 external calls (new, new, new, create_model_provider, default).


##### `ModelClient::with_prompt_cache_key_override`  (lines 410–416)

```
fn with_prompt_cache_key_override(
        mut self,
        prompt_cache_key_override: Option<String>,
    ) -> Self
```

**Purpose**: Returns a clone-like modified client that uses a caller-specified prompt cache key instead of the thread id. This is a narrow customization hook for request construction.

**Data flow**: Takes ownership of `self` and `prompt_cache_key_override: Option<String>` → stores the override in the struct → returns the updated `ModelClient`.

**Call relations**: This helper affects later `build_responses_request` calls indirectly through `prompt_cache_key`. It does not perform I/O or mutate shared session state.


##### `ModelClient::prompt_cache_key`  (lines 418–422)

```
fn prompt_cache_key(&self) -> String
```

**Purpose**: Computes the prompt cache key to embed in Responses API requests. It prefers an explicit override and otherwise uses the session thread id.

**Data flow**: Reads `self.prompt_cache_key_override` → if present, clones and returns it; otherwise converts `self.state.thread_id` to string and returns that.

**Call relations**: Called by `build_responses_request` so every request gets a stable cache key. The override path exists for callers that need cache grouping different from the thread id.

*Call graph*: called by 1 (build_responses_request).


##### `ModelClient::new_session`  (lines 428–434)

```
fn new_session(&self) -> ModelClientSession
```

**Purpose**: Creates a fresh turn-scoped `ModelClientSession` that can lazily open and reuse a websocket within that turn. It also transfers any cached websocket session from the parent client into the new turn object.

**Data flow**: Clones `self` into the session, calls `take_cached_websocket_session()` to move out any session-level cached websocket state, creates a new `Arc<OnceLock<String>>` for turn state, and returns `ModelClientSession`.

**Call relations**: This is the bridge from session-scoped to turn-scoped behavior. The returned session later drives `prewarm_websocket`, `stream`, and turn-state propagation; on drop it stores websocket state back into the parent client.

*Call graph*: calls 1 internal fn (take_cached_websocket_session); 2 external calls (new, new).


##### `ModelClient::auth_manager`  (lines 436–438)

```
fn auth_manager(&self) -> Option<Arc<AuthManager>>
```

**Purpose**: Exposes the underlying optional `AuthManager` from the shared provider. It is a convenience accessor for callers that need auth recovery or inspection.

**Data flow**: Reads `self.state.provider` and returns its `auth_manager()` result.

**Call relations**: This accessor is not central to transport flow in this file, but it provides external code a way to reach the provider’s auth manager without exposing the whole provider.


##### `ModelClient::take_cached_websocket_session`  (lines 440–447)

```
fn take_cached_websocket_session(&self) -> WebsocketSession
```

**Purpose**: Moves the cached websocket session state out of the shared client so a new turn can own it exclusively. This prevents concurrent reuse of the same cached transport state.

**Data flow**: Locks `self.state.cached_websocket_session`, recovering from poison if needed → `std::mem::take`s the stored `WebsocketSession`, leaving a default in its place → returns the taken session.

**Call relations**: Called only by `new_session`. It pairs with `store_cached_websocket_session`, which writes the session back when a turn ends or fallback resets state.

*Call graph*: called by 1 (new_session); 1 external calls (take).


##### `ModelClient::store_cached_websocket_session`  (lines 449–455)

```
fn store_cached_websocket_session(&self, websocket_session: WebsocketSession)
```

**Purpose**: Writes a `WebsocketSession` back into the shared client cache. This preserves reusable websocket state across turn boundaries when appropriate.

**Data flow**: Accepts a `WebsocketSession` by value → locks `self.state.cached_websocket_session` → replaces the stored session with the provided one.

**Call relations**: Used by `force_http_fallback` to clear cached websocket state and by `ModelClientSession::drop` to return turn-owned websocket state to the parent client.

*Call graph*: called by 2 (force_http_fallback, drop).


##### `ModelClient::force_http_fallback`  (lines 457–476)

```
fn force_http_fallback(
        &self,
        session_telemetry: &SessionTelemetry,
        _model_info: &ModelInfo,
    ) -> bool
```

**Purpose**: Session-scopingly disables websocket transport and clears cached websocket state, recording telemetry the first time fallback activates. It is the irreversible switch from websocket to HTTP for the remainder of the session.

**Data flow**: Checks `responses_websocket_enabled()` → atomically sets `disable_websockets` to `true` if websockets were still active → on first activation logs a warning and increments `codex.transport.fallback_to_http` telemetry → stores a default `WebsocketSession` into the cache → returns whether fallback was newly activated.

**Call relations**: Called by `ModelClientSession::try_switch_fallback_transport` after websocket upgrade failures or exhausted retry/fallback logic. It centralizes the session-wide side effects so all later turns observe HTTP-only behavior.

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

**Purpose**: Calls the unary `/responses/compact` endpoint to compact an existing conversation transcript into a smaller list of `ResponseItem`s. It builds the same auth, request, header, and telemetry context used by normal Responses requests, but repackages the payload for compaction.

**Data flow**: Inputs: `Prompt`, `ModelInfo`, optional turn-state lock, compaction settings, session telemetry, compaction trace context, and responses metadata. If `prompt.input` is empty, returns an empty vector immediately. Otherwise it resolves current auth/provider setup, builds request telemetry, constructs a full `ResponsesApiRequest`, destructures it into an `ApiCompactionInput`, assembles extra headers (installation id, beta/turn-state headers, compatibility headers, session headers, optional attestation, optional responses-lite header), computes a unary timeout from provider idle timeout, sends `compact_input`, records the trace attempt result, maps API errors, and returns the compacted `Vec<ResponseItem>`.

**Call relations**: This is a unary sibling to streaming turn execution. It depends on `current_client_setup`, `build_responses_request`, `build_responses_compatibility_headers`, `build_request_telemetry`, and `generate_attestation_header_for`; downstream it delegates the actual HTTP call to `ApiCompactClient`.

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

**Purpose**: Creates a realtime WebRTC call over HTTP and returns the SDP answer plus sideband websocket headers needed to attach control traffic to the same call. It preserves the exact auth identity used for call creation.

**Data flow**: Accepts SDP offer string, realtime session config, conversation architecture, mutable extra headers, and optional provider override → resolves current auth/provider setup → optionally inserts attestation into the outgoing headers → clones those headers and extends the clone with auth headers from `sideband_websocket_auth_headers` → creates a reqwest transport and chooses either the override provider or the resolved provider → calls `ApiRealtimeCallClient::create_with_session_architecture_and_headers` → returns `RealtimeWebrtcCallStart { sdp, call_id, sideband_headers }`.

**Call relations**: This method is the realtime-call setup path. It shares auth resolution and attestation generation with other request methods, then hands off to the realtime API client and packages the returned call id together with sideband join headers.

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

**Purpose**: Calls the unary `/memories/trace_summarize` endpoint to summarize normalized raw memories. It is a lightweight non-streaming path parallel to conversation compaction.

**Data flow**: Inputs: `raw_memories`, `ModelInfo`, optional reasoning effort, and session telemetry. If `raw_memories` is empty, returns an empty vector immediately. Otherwise it resolves current auth/provider setup, builds request telemetry for the memories endpoint, constructs `ApiMemorySummarizeInput` with model slug and optional `Reasoning`, builds subagent headers, sends `summarize_input`, maps API errors, and returns `Vec<ApiMemorySummarizeOutput>`.

**Call relations**: This method uses `current_client_setup`, `build_request_telemetry`, and `build_subagent_headers`, then delegates the actual HTTP request to `ApiMemoriesClient`. Tests specifically exercise the empty-input fast path.

*Call graph*: calls 6 internal fn (new, new, build_subagent_headers, current_client_setup, for_endpoint, build_reqwest_client); 4 external calls (new, build_request_telemetry, new, default).


##### `ModelClient::build_subagent_headers`  (lines 667–684)

```
fn build_subagent_headers(&self) -> ApiHeaderMap
```

**Purpose**: Builds extra headers that identify subagent/memory-consolidation request context for endpoints that need it. It translates session source into concrete HTTP headers.

**Data flow**: Starts with an empty `ApiHeaderMap` → if `subagent_header_value(&self.state.session_source)` returns a string that can be parsed as a header value, inserts `x-openai-subagent` → if the session source is `Internal(MemoryConsolidation)`, also inserts `x-openai-memgen-request: true` → returns the header map.

**Call relations**: Used by `summarize_memories`. It is the memory-summary-specific counterpart to `build_responses_compatibility_headers`, which applies similar session-source compatibility headers to Responses requests.

*Call graph*: calls 1 internal fn (subagent_header_value); called by 1 (summarize_memories); 4 external calls (new, from_static, from_str, matches!).


##### `ModelClient::build_responses_compatibility_headers`  (lines 686–701)

```
fn build_responses_compatibility_headers(
        &self,
        responses_metadata: &CodexResponsesMetadata,
    ) -> ApiHeaderMap
```

**Purpose**: Builds compatibility headers derived from `CodexResponsesMetadata` and session source for Responses-family requests. It augments metadata-provided headers with internal memory-consolidation signaling.

**Data flow**: Starts from `responses_metadata.compatibility_headers()` → if the session source is `Internal(MemoryConsolidation)`, inserts `x-openai-memgen-request: true` → returns the resulting `ApiHeaderMap`.

**Call relations**: Called by websocket handshake construction, compaction requests, and per-request Responses options. It keeps compatibility/header policy consistent across HTTP and websocket transports.

*Call graph*: calls 1 internal fn (compatibility_headers); called by 3 (build_websocket_headers, compact_conversation_history, build_responses_options); 2 external calls (from_static, matches!).


##### `ModelClient::build_ws_client_metadata`  (lines 703–716)

```
fn build_ws_client_metadata(
        &self,
        responses_metadata: &CodexResponsesMetadata,
        use_responses_lite: bool,
    ) -> HashMap<String, String>
```

**Purpose**: Builds websocket request `client_metadata` from `CodexResponsesMetadata`, optionally tagging the request as Responses Lite. This metadata travels inside the websocket payload rather than only in HTTP headers.

**Data flow**: Copies the metadata map from `responses_metadata.client_metadata()` → if `use_responses_lite` is true, inserts `ws_request_header_x_openai_internal_codex_responses_lite = "true"` → returns the `HashMap<String, String>`.

**Call relations**: Used by `ModelClientSession::stream_responses_websocket` before constructing `ResponseCreateWsRequest`. Tests verify that this metadata includes installation/session/thread/window lineage and turn metadata.

*Call graph*: calls 1 internal fn (client_metadata); called by 1 (stream_responses_websocket).


##### `ModelClient::generate_attestation_header_for`  (lines 718–730)

```
async fn generate_attestation_header_for(&self) -> Option<HeaderValue>
```

**Purpose**: Asynchronously asks the configured attestation provider for a request header when the current provider/session supports attestation. It suppresses attestation entirely for unsupported providers.

**Data flow**: Reads `self.state.include_attestation`; if false, returns `None` immediately. Otherwise looks up `self.state.attestation_provider`, builds `AttestationContext { thread_id }`, awaits `header_for_request`, and returns the resulting `Option<HeaderValue>`.

**Call relations**: Shared by websocket handshake construction, compaction, realtime call creation, and per-request Responses options. Tests verify both the positive ChatGPT/OpenAI path and the omission path for non-attested providers.

*Call graph*: called by 4 (build_websocket_headers, compact_conversation_history, create_realtime_call_with_headers, build_responses_options).


##### `ModelClient::build_request_telemetry`  (lines 733–747)

```
fn build_request_telemetry(
        session_telemetry: &SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_te
```

**Purpose**: Creates a request-telemetry object for unary API calls. It wraps session telemetry, auth context, endpoint labeling, and auth-environment metadata into a single `RequestTelemetry` trait object.

**Data flow**: Accepts `SessionTelemetry`, `AuthRequestTelemetryContext`, `RequestRouteTelemetry`, and `AuthEnvTelemetry` → constructs `ApiTelemetry::new(...)` inside an `Arc` → coerces it to `Arc<dyn RequestTelemetry>` and returns it.

**Call relations**: Used by unary methods like `compact_conversation_history` and `summarize_memories`. Streaming paths instead use `build_streaming_telemetry` or `build_websocket_telemetry` to obtain multiple telemetry trait views over the same `ApiTelemetry` instance.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, clone).


##### `ModelClient::build_reasoning`  (lines 749–771)

```
fn build_reasoning(
        model_info: &ModelInfo,
        effort: Option<ReasoningEffortConfig>,
        summary: ReasoningSummaryConfig,
    ) -> Option<Reasoning>
```

**Purpose**: Builds the optional `Reasoning` block for a request based on model capabilities and caller-selected effort/summary settings. It also chooses the reasoning context behavior for Responses Lite.

**Data flow**: Inputs: `ModelInfo`, optional effort, and summary config. If the model does not support reasoning summaries, returns `None`. Otherwise returns `Some(Reasoning)` with effort defaulting to the model’s default reasoning level when absent, summary omitted only when configured as `None`, and `context` set to `AllTurns` only when `use_responses_lite` is true.

**Call relations**: Called only by `build_responses_request`. Its output also controls whether the request includes `reasoning.encrypted_content` in the `include` list.


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

**Purpose**: Constructs the canonical `ResponsesApiRequest` for both HTTP and websocket turn execution. It folds together prompt content, tool definitions, model capabilities, verbosity/schema controls, service tier, prompt cache key, and metadata.

**Data flow**: Inputs: provider, `Prompt`, `ModelInfo`, optional effort, summary config, optional service tier, and `CodexResponsesMetadata`. It clones base instructions, formats input via `Prompt::get_formatted_input_for_request`, strips item metadata for non-OpenAI providers, serializes tools with `create_tools_json_for_responses_api`, computes optional reasoning via `build_reasoning`, sets `include` accordingly, resolves verbosity only if the model supports it (warning otherwise), builds `text` controls from verbosity/output schema, computes prompt cache key and service tier, sets `store` for Azure responses endpoints, and returns a fully populated streaming `ResponsesApiRequest` with `client_metadata` from `responses_metadata`.

**Call relations**: This is the shared request builder used by compaction, HTTP streaming, and websocket streaming. It is the main place where prompt/model/provider state is normalized into the wire request shape.

*Call graph*: calls 5 internal fn (is_azure_responses_endpoint, prompt_cache_key, get_formatted_input_for_request, client_metadata, service_tier_for_request); called by 3 (compact_conversation_history, stream_responses_api, stream_responses_websocket); 6 external calls (build_reasoning, new, create_text_param_for_request, create_tools_json_for_responses_api, vec!, warn!).


##### `ModelClient::responses_websocket_enabled`  (lines 836–844)

```
fn responses_websocket_enabled(&self) -> bool
```

**Purpose**: Reports whether websocket transport is currently allowed for this session. It combines provider capability with the session-wide fallback-disable flag.

**Data flow**: Reads `self.state.provider.info().supports_websockets` and `self.state.disable_websockets` → returns `false` if the provider lacks websocket support or fallback has disabled websockets; otherwise returns `true`.

**Call relations**: Queried before preconnect, prewarm, normal streaming, and fallback activation. It is the gate that prevents websocket attempts after session-wide fallback has been triggered.

*Call graph*: called by 4 (force_http_fallback, preconnect_websocket, prewarm_websocket, stream).


##### `ModelClient::current_client_setup`  (lines 850–859)

```
async fn current_client_setup(&self) -> Result<CurrentClientSetup>
```

**Purpose**: Resolves the current auth and provider configuration from the shared model provider. It keeps auth/provider lookup logic in one place so all request paths stay synchronized.

**Data flow**: Awaits `self.state.provider.auth()`, `api_provider()`, and `api_auth()` → packages them into `CurrentClientSetup { auth, api_provider, api_auth }` → returns the bundle or propagates provider-resolution errors.

**Call relations**: Used by compaction, realtime call creation, memory summarization, websocket preconnect, HTTP streaming, and websocket streaming. It is the common setup step before any actual network request.

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

**Purpose**: Performs a websocket handshake with the same headers, auth context, timeout handling, and telemetry/reporting used by normal turn execution. It is the shared connection path for prewarm and reconnect.

**Data flow**: Inputs: session telemetry, resolved provider/auth, responses metadata, auth telemetry context, and endpoint telemetry. It builds websocket headers, constructs websocket telemetry, computes the provider-specific connect timeout, attempts `ApiWebSocketResponsesClient::connect` under `tokio::time::timeout`, converts timeout expiry into `ApiError::Transport(Timeout)`, extracts debug/status info from any error, records websocket-connect telemetry and feedback tags, and returns either an `ApiWebSocketConnection` or `ApiError`.

**Call relations**: Called by `ModelClientSession::preconnect_websocket` and `ModelClientSession::websocket_connection`. It centralizes handshake behavior so startup preconnect and in-turn reconnects behave identically.

*Call graph*: calls 4 internal fn (build_websocket_headers, build_websocket_telemetry, default_headers, record_websocket_connect); called by 2 (preconnect_websocket, websocket_connection); 5 external calls (new, now, Transport, emit_feedback_request_tags_with_auth_env, timeout).


##### `ModelClient::build_websocket_headers`  (lines 949–979)

```
async fn build_websocket_headers(
        &self,
        responses_metadata: &CodexResponsesMetadata,
    ) -> ApiHeaderMap
```

**Purpose**: Builds the HTTP headers used during websocket handshake for Responses-over-WebSocket. It combines beta flags, session/thread identifiers, compatibility headers, optional attestation, websocket beta opt-in, and optional timing metrics.

**Data flow**: Starts from `build_responses_headers(beta_features, None)` → inserts `x-client-request-id` from `responses_metadata.thread_id` when valid → extends with session headers and compatibility headers → optionally inserts attestation → inserts `OpenAI-Beta: responses_websockets=2026-02-06` → optionally inserts `x-responsesapi-include-timing-metrics: true` → returns the header map.

**Call relations**: Used only by `connect_websocket`. It is the handshake-specific counterpart to `ModelClientSession::build_responses_options`, which builds per-request headers for HTTP streaming.

*Call graph*: calls 3 internal fn (build_responses_compatibility_headers, generate_attestation_header_for, build_responses_headers); called by 1 (connect_websocket); 3 external calls (from_static, from_str, build_session_headers).


##### `ModelClientSession::drop`  (lines 983–987)

```
fn drop(&mut self)
```

**Purpose**: Returns the turn-owned websocket session state to the parent `ModelClient` when the turn session is dropped. This preserves reusable connection/request state across turns when fallback has not cleared it.

**Data flow**: Takes ownership of `self.websocket_session` via `std::mem::take` → passes it to `self.client.store_cached_websocket_session(...)` → leaves the dropped session with default websocket state.

**Call relations**: This destructor closes the lifecycle loop started by `ModelClient::new_session`, which moved cached websocket state into the turn session.

*Call graph*: calls 1 internal fn (store_cached_websocket_session); 1 external calls (take).


##### `ModelClientSession::turn_state`  (lines 991–993)

```
fn turn_state(&self) -> Arc<OnceLock<String>>
```

**Purpose**: Exposes the per-turn sticky-routing token container so other subsystems can pass it into related requests such as compaction. The returned `Arc<OnceLock<String>>` is shared, not copied.

**Data flow**: Clones and returns `self.turn_state`.

**Call relations**: Used externally by code such as auto-compaction to ensure follow-up requests reuse the same `x-codex-turn-state` captured during the turn.

*Call graph*: called by 1 (run_auto_compact); 1 external calls (clone).


##### `ModelClientSession::reset_websocket_session`  (lines 995–1002)

```
fn reset_websocket_session(&mut self)
```

**Purpose**: Clears all cached websocket connection and incremental-reuse state for the current turn. It is the hard reset path after connection failure or timeout.

**Data flow**: Sets `connection`, `last_request`, and `last_response_rx` to `None`, clears `last_response_from_untraced_warmup`, and marks `connection_reused` false.

**Call relations**: Called by `websocket_connection` when a timeout during reconnect should invalidate all websocket state. It ensures later requests start from a clean websocket baseline.

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

**Purpose**: Builds the shared `ApiResponsesOptions` used by HTTP Responses requests. It consolidates session/thread ids, session source, extra headers, compression choice, and turn-state propagation.

**Data flow**: Inputs: responses metadata, compression mode, and `use_responses_lite`. It creates `ApiResponsesOptions` with session/thread ids and session source, builds extra headers from beta/turn-state headers plus compatibility headers, optional attestation, and optional responses-lite header, and stores `Some(Arc::clone(&self.turn_state))` in `turn_state`.

**Call relations**: Used by `stream_responses_api`. It keeps request-scoped header construction consistent regardless of the specific HTTP streaming call site.

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

**Purpose**: Determines whether the current request can be sent as an incremental websocket delta and, if so, computes the exact suffix of input items to send. It enforces strict reuse invariants around request shape and prior server output.

**Data flow**: Inputs: current `ResponsesApiRequest`, optional `LastResponse`, and `allow_empty_delta`. It reads `self.websocket_session.last_request`; if absent, returns `None`. It rejects reuse unless `responses_request_properties_match` succeeds. It then checks that current input is a strict extension of previous input, subtracts any server-returned output items from the baseline, optionally strips metadata from those output items for non-OpenAI providers, rejects mismatches or empty deltas when disallowed, and returns `Some(Vec<ResponseItem>)` containing only the incremental suffix.

**Call relations**: Called by `prepare_websocket_request`. It is the core logic that enables websocket request compression/reuse without accidentally changing request semantics.

*Call graph*: calls 1 internal fn (responses_request_properties_match); called by 1 (prepare_websocket_request); 1 external calls (trace!).


##### `ModelClientSession::get_last_response`  (lines 1081–1089)

```
fn get_last_response(&mut self) -> Option<LastResponse>
```

**Purpose**: Non-blockingly retrieves the cached terminal response information from the previous websocket request if it has already arrived. It consumes the stored oneshot receiver.

**Data flow**: Takes `self.websocket_session.last_response_rx`, if any → calls `try_recv()` on the receiver → returns `Some(LastResponse)` only when the terminal response has already been delivered; returns `None` on closed or empty receiver states.

**Call relations**: Used by `prepare_websocket_request` to decide whether a previous response id and output-item baseline are available for incremental websocket reuse.

*Call graph*: called by 1 (prepare_websocket_request).


##### `ModelClientSession::prepare_websocket_request`  (lines 1091–1122)

```
fn prepare_websocket_request(
        &mut self,
        payload: ResponseCreateWsRequest,
        request: &ResponsesApiRequest,
    ) -> (ResponsesWsRequest, bool)
```

**Purpose**: Transforms a full websocket payload into either a normal `response.create` request or an incremental one that references `previous_response_id`. It also reports whether that previous response id came from an untraced warmup request.

**Data flow**: Inputs: a `ResponseCreateWsRequest` payload and the corresponding full `ResponsesApiRequest`. It tries to fetch the last response via `get_last_response`; if unavailable, returns a plain `ResponsesWsRequest::ResponseCreate(payload)` and `false`. If available, it computes incremental items via `get_incremental_items`; if that fails or the previous response id is empty, it falls back to a plain request. Otherwise it returns a new `ResponseCreate` request with `previous_response_id` set and `input` replaced by the incremental suffix, plus a boolean indicating whether the reused response id came from untraced warmup.

**Call relations**: Called by `stream_responses_websocket` after building the websocket payload. It bridges prior websocket state into the next request while preserving rollout-trace correctness.

*Call graph*: calls 2 internal fn (get_incremental_items, get_last_response); called by 1 (stream_responses_websocket); 2 external calls (ResponseCreate, trace!).


##### `ModelClientSession::preconnect_websocket`  (lines 1127–1164)

```
async fn preconnect_websocket(
        &mut self,
        session_telemetry: &SessionTelemetry,
        responses_metadata: &CodexResponsesMetadata,
    ) -> std::result::Result<(), ApiError>
```

**Purpose**: Opportunistically opens a websocket connection for the current turn without sending any prompt payload. It is a pure connection warmup step.

**Data flow**: Checks `self.client.responses_websocket_enabled()` and whether a connection already exists; if either condition says no work is needed, returns `Ok(())`. Otherwise resolves current client setup, builds an auth telemetry context, calls `self.client.connect_websocket(...)`, stores the resulting connection in `self.websocket_session.connection`, marks `connection_reused` false, and returns success or the handshake error.

**Call relations**: This method is an explicit preconnect path separate from full prewarm. It delegates handshake details to `ModelClient::connect_websocket` and is used when callers want the socket ready before the first streamed request.

*Call graph*: calls 6 internal fn (new, connect_websocket, current_client_setup, responses_websocket_enabled, for_endpoint, set_connection_reused); 1 external calls (default).


##### `ModelClientSession::websocket_connection`  (lines 1178–1233)

```
async fn websocket_connection(
        &mut self,
        params: WebsocketConnectParams<'_>,
    ) -> std::result::Result<&ApiWebSocketConnection, ApiError>
```

**Purpose**: Returns a usable websocket connection for the current turn, reconnecting if the cached one is absent or closed. It also updates reuse bookkeeping and resets state on timeout failures.

**Data flow**: Inputs are bundled in `WebsocketConnectParams`. It checks whether the existing connection is missing or `is_closed().await`; if a new connection is needed, it clears last-request/last-response state, calls `self.client.connect_websocket(...)`, resets the whole websocket session on timeout errors, stores the new connection, and marks reuse false. If the existing connection is still open, it marks reuse true. Finally it returns a reference to the stored connection or an `ApiError::Stream` if unexpectedly absent.

**Call relations**: Called by `stream_responses_websocket` before each websocket request. It is the in-turn connection manager layered on top of `ModelClient::connect_websocket`.

*Call graph*: calls 3 internal fn (connect_websocket, reset_websocket_session, set_connection_reused); called by 1 (stream_responses_websocket); 2 external calls (Stream, matches!).


##### `ModelClientSession::responses_request_compression`  (lines 1235–1244)

```
fn responses_request_compression(&self, auth: Option<&CodexAuth>) -> Compression
```

**Purpose**: Chooses whether outgoing HTTP Responses requests should use zstd compression. Compression is enabled only for a narrow combination of session config, auth backend, and provider type.

**Data flow**: Reads `self.client.state.enable_request_compression`, the optional `CodexAuth`, and provider info → returns `Compression::Zstd` only when compression is enabled, auth exists and uses the Codex backend, and the provider is OpenAI; otherwise returns `Compression::None`.

**Call relations**: Used by `stream_responses_api` when building `ApiResponsesOptions`. It keeps compression policy centralized and conservative.

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

**Purpose**: Executes a streamed turn over the HTTP Responses API with SSE, including auth-recovery retry on 401 and rollout-trace recording. It is the fallback and non-websocket transport path.

**Data flow**: Inputs: prompt, model info, session telemetry, reasoning effort/summary, service tier, responses metadata, and inference trace context. It loops: resolve current client setup, build auth/request/SSE telemetry, choose compression, build `ApiResponsesOptions`, build the `ResponsesApiRequest`, start an inference trace attempt, attach trace headers, create `ApiResponsesClient`, and call `stream_request`. On success it maps the provider stream through `map_response_stream` and returns the internal `ResponseStream`. On HTTP 401 it records failure, runs `handle_unauthorized`, converts the result into `PendingUnauthorizedRetry`, and retries. On any other error it records failure and returns the mapped `CodexErr`.

**Call relations**: Called by `stream` when websocket transport is unavailable or has fallen back. It depends on `current_client_setup`, `build_responses_options`, `build_responses_request`, `responses_request_compression`, `build_streaming_telemetry`, and `handle_unauthorized`.

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

**Purpose**: Executes a streamed turn over the Responses websocket transport, including optional warmup mode, incremental request reuse, sticky turn-state propagation, auth-recovery retry, and HTTP fallback signaling. It is the preferred transport when supported and healthy.

**Data flow**: Inputs: prompt, model info, session telemetry, reasoning effort/summary, service tier, responses metadata, `warmup` flag, optional W3C trace context, and inference trace context. In a retry loop it resolves current client setup, builds auth context, constructs the full `ResponsesApiRequest`, derives websocket `client_metadata` (including turn state if already known), converts to `ResponseCreateWsRequest`, sets `generate=false` for warmup, obtains a websocket connection via `websocket_connection`, handling `426 UPGRADE_REQUIRED` as `FallbackToHttp` and `401` via `handle_unauthorized`. It then prepares an incremental or full websocket request, stamps send-start metadata, records rollout-trace start using either the logical request or websocket delta depending on warmup reuse, stores last-request bookkeeping, sends `stream_request`, maps the resulting stream through `map_response_stream`, caches the returned last-response receiver, and returns `WebsocketStreamOutcome::Stream(stream)`.

**Call relations**: Called by both `prewarm_websocket` and `stream`. It relies on `build_ws_client_metadata`, `prepare_websocket_request`, `websocket_connection`, `stamp_ws_stream_request_start_ms`, and `map_response_stream`; callers react to `FallbackToHttp` by switching the session to HTTP.

*Call graph*: calls 15 internal fn (from, new, build_responses_request, build_ws_client_metadata, current_client_setup, prepare_websocket_request, websocket_connection, from_recovery, for_endpoint, connection_reused (+5 more)); called by 2 (prewarm_websocket, stream); 6 external calls (clone, map_api_error, response_create_client_metadata, default, Stream, clone).


##### `ModelClientSession::build_streaming_telemetry`  (lines 1523–1538)

```
fn build_streaming_telemetry(
        session_telemetry: &SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_
```

**Purpose**: Creates a shared `ApiTelemetry` instance and exposes it as both `RequestTelemetry` and `SseTelemetry` for HTTP streaming. This ensures request-level and SSE-poll telemetry share the same auth and endpoint context.

**Data flow**: Accepts session telemetry, auth context, route telemetry, and auth-env telemetry → constructs `ApiTelemetry::new(...)` in an `Arc` → clones/coerces it into `(Arc<dyn RequestTelemetry>, Arc<dyn SseTelemetry>)` and returns the pair.

**Call relations**: Used by `stream_responses_api`. It is the streaming analogue of `build_request_telemetry` for unary calls.

*Call graph*: calls 1 internal fn (new); 2 external calls (new, clone).


##### `ModelClientSession::build_websocket_telemetry`  (lines 1541–1555)

```
fn build_websocket_telemetry(
        session_telemetry: &SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_
```

**Purpose**: Creates a websocket telemetry object backed by `ApiTelemetry`. It packages auth, endpoint, and auth-environment context for websocket request/event reporting.

**Data flow**: Accepts session telemetry, auth context, route telemetry, and auth-env telemetry → constructs `ApiTelemetry::new(...)` in an `Arc` → coerces it to `Arc<dyn WebsocketTelemetry>` and returns it.

**Call relations**: Used by `ModelClient::connect_websocket` during websocket handshake setup. It gives the websocket client a telemetry sink that records request and event timing.

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

**Purpose**: Performs a best-effort websocket warmup request for the current turn by sending a `generate=false` websocket `response.create` and waiting for completion. This primes connection reuse and previous-response-id reuse before the first real turn request.

**Data flow**: Checks whether websockets are enabled and whether a request has already been sent this turn; if not eligible, returns `Ok(())`. Otherwise creates a disabled inference trace context and calls `stream_responses_websocket(..., warmup=true, current_span_w3c_trace_context(), &disabled_trace)`. If that returns a stream, it consumes events until `ResponseEvent::Completed`, returning any stream error immediately. If websocket transport reports `FallbackToHttp`, it switches fallback transport and returns success. Other errors are propagated.

**Call relations**: Called by higher-level turn orchestration before the first streamed request. It delegates the actual websocket request to `stream_responses_websocket` and reacts to fallback by invoking `try_switch_fallback_transport`.

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

**Purpose**: Runs a single model request for the current turn, choosing websocket transport first when available and falling back to HTTP otherwise. It is the main turn-scoped streaming entrypoint.

**Data flow**: Inputs: prompt, model info, session telemetry, reasoning effort/summary, service tier, responses metadata, and inference trace context. It inspects the provider `wire_api`; for `WireApi::Responses`, if websockets are enabled it captures the current span trace context and calls `stream_responses_websocket`. A websocket `Stream` result is returned directly; `FallbackToHttp` triggers `try_switch_fallback_transport`. It then calls `stream_responses_api` as the fallback/remaining path and returns that stream result.

**Call relations**: This is the primary method invoked by higher-level turn runners. It orchestrates between `stream_responses_websocket`, `try_switch_fallback_transport`, and `stream_responses_api`.

*Call graph*: calls 4 internal fn (responses_websocket_enabled, stream_responses_api, stream_responses_websocket, try_switch_fallback_transport); called by 5 (drain_to_completed, run_remote_compaction_request_v2, try_run_sampling_request, stream_until_complete_with_metadata, stream_until_complete_with_model_info); 1 external calls (current_span_w3c_trace_context).


##### `ModelClientSession::try_switch_fallback_transport`  (lines 1678–1688)

```
fn try_switch_fallback_transport(
        &mut self,
        session_telemetry: &SessionTelemetry,
        model_info: &ModelInfo,
    ) -> bool
```

**Purpose**: Activates session-wide HTTP fallback and clears the current turn’s websocket state. It is the turn-local wrapper around the parent client’s irreversible fallback switch.

**Data flow**: Calls `self.client.force_http_fallback(...)` to flip the session-wide disable flag and emit telemetry if newly activated → replaces `self.websocket_session` with `WebsocketSession::default()` → returns whether fallback was newly activated.

**Call relations**: Called after websocket warmup or streaming determines HTTP fallback is necessary, and by retry/error handling elsewhere. It combines session-wide and turn-local cleanup.

*Call graph*: calls 1 internal fn (force_http_fallback); called by 3 (prewarm_websocket, stream, handle_retryable_response_stream_error); 1 external calls (default).


##### `stamp_ws_stream_request_start_ms`  (lines 1695–1704)

```
fn stamp_ws_stream_request_start_ms(request: &mut ResponsesWsRequest)
```

**Purpose**: Adds a client-side send timestamp to websocket request metadata immediately before transmission. This captures realistic transport timing for downstream analysis.

**Data flow**: Takes `&mut ResponsesWsRequest`, pattern-matches the `ResponseCreate` payload, ensures `client_metadata` exists, inserts `x-codex-ws-stream-request-start-ms` with the current Unix timestamp in milliseconds, and mutates the request in place.

**Call relations**: Called by `stream_responses_websocket` just before `stream_request`. It enriches websocket payload metadata without affecting request semantics.

*Call graph*: calls 1 internal fn (now_unix_timestamp_ms); called by 1 (stream_responses_websocket).


##### `build_responses_headers`  (lines 1712–1730)

```
fn build_responses_headers(
    beta_features_header: Option<&str>,
    turn_state: Option<&Arc<OnceLock<String>>>,
) -> ApiHeaderMap
```

**Purpose**: Builds the common Codex-specific extra headers for Responses-family requests. It currently carries beta-feature flags and the sticky turn-state token.

**Data flow**: Starts with an empty `ApiHeaderMap` → if `beta_features_header` is present, non-empty, and parses as a header value, inserts `x-codex-beta-features` → if `turn_state` is provided and already initialized, inserts `x-codex-turn-state` with that value → returns the header map.

**Call relations**: Used by websocket handshake construction, compaction requests, and HTTP Responses options. It is the shared low-level helper for Codex-specific request headers.

*Call graph*: called by 3 (build_websocket_headers, compact_conversation_history, build_responses_options); 2 external calls (new, from_str).


##### `add_responses_lite_header`  (lines 1732–1739)

```
fn add_responses_lite_header(headers: &mut ApiHeaderMap, use_responses_lite: bool)
```

**Purpose**: Adds the internal Responses Lite opt-in header when the selected model/request path requires it. It mutates an existing header map in place.

**Data flow**: Accepts `headers: &mut ApiHeaderMap` and `use_responses_lite: bool` → if true, inserts `x-openai-internal-codex-responses-lite: true`; otherwise leaves the map unchanged.

**Call relations**: Called by compaction request setup and HTTP Responses option construction. Websocket requests encode the same concept in client metadata via `build_ws_client_metadata`.

*Call graph*: called by 2 (compact_conversation_history, build_responses_options); 2 external calls (insert, from_static).


##### `map_response_stream`  (lines 1744–1763)

```
fn map_response_stream(
    api_stream: codex_api::ResponseStream,
    session_telemetry: SessionTelemetry,
    inference_trace_attempt: InferenceTraceAttempt,
) -> (ResponseStream, oneshot::Receiver<
```

**Purpose**: Adapts a provider `codex_api::ResponseStream` into the internal `ResponseStream` type while preserving the upstream request id for tracing/feedback. It strips the upstream id from the provider stream object and forwards it separately.

**Data flow**: Destructures `codex_api::ResponseStream` into `rx_event` and `upstream_request_id`, rebuilds a provider stream with `upstream_request_id: None`, and passes both pieces plus telemetry and trace attempt into `map_response_events` → returns the mapped `ResponseStream` and `oneshot::Receiver<LastResponse>`.

**Call relations**: Used by both HTTP and websocket streaming paths after a provider stream has been established. It is a thin wrapper over `map_response_events` specialized for the provider stream struct.

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

**Purpose**: Runs the background mapping task that converts provider response events into the internal stream channel, tracks partial output, emits telemetry/feedback tags, and produces the terminal `LastResponse` summary for websocket incremental reuse. It is the central stream-adaptation and trace-recording loop.

**Data flow**: Inputs: optional upstream request id, any async stream of `Result<ResponseEvent, ApiError>`, session telemetry, and an `InferenceTraceAttempt`. It creates an mpsc channel for downstream events, a oneshot channel for `LastResponse`, and a cancellation token. In a spawned task it loops over provider events or consumer cancellation: accumulates `OutputItemDone` items, forwards events downstream, records token usage and completion on `Completed`, sends `LastResponse { response_id, items_added }` once, maps provider errors into internal errors while recording failure telemetry, and records cancellation if the consumer drops early or send fails under backpressure. If the provider stream ends without `response.completed`, it records a failed trace with the partial items.

**Call relations**: Called only by `map_response_stream`, but it underpins all streamed turn execution. Tests in `client_tests.rs` specifically validate its cancellation behavior, partial-output preservation, and feedback-tag emission.

*Call graph*: calls 5 internal fn (see_event_completed_failed, sse_event_completed, record_cancelled, record_completed, record_failed); called by 1 (map_response_stream); 9 external calls (new, new, OutputItemDone, map_api_error, extract_response_debug_context_from_api_error, feedback_tags!, take, select!, spawn).


##### `PendingUnauthorizedRetry::from_recovery`  (lines 1930–1936)

```
fn from_recovery(recovery: UnauthorizedRecoveryExecution) -> Self
```

**Purpose**: Converts a successful unauthorized-recovery execution into retry metadata that will be attached to the next request’s telemetry. It marks the next attempt as a follow-up after auth recovery.

**Data flow**: Accepts `UnauthorizedRecoveryExecution { mode, phase }` → returns `PendingUnauthorizedRetry` with `retry_after_unauthorized = true` and the supplied mode/phase stored.

**Call relations**: Used by both HTTP and websocket streaming loops after `handle_unauthorized` succeeds. Tests also verify that this metadata is reflected by `AuthRequestTelemetryContext::new`.

*Call graph*: called by 3 (stream_responses_api, stream_responses_websocket, auth_request_telemetry_context_tracks_attached_auth_and_retry_phase).


##### `AuthRequestTelemetryContext::new`  (lines 1950–1970)

```
fn new(
        auth_mode: Option<AuthMode>,
        api_auth: &dyn AuthProvider,
        retry: PendingUnauthorizedRetry,
    ) -> Self
```

**Purpose**: Builds the auth-related telemetry context for a request from auth mode, attached auth headers, and pending retry metadata. It normalizes several auth modes into stable telemetry strings.

**Data flow**: Inputs: optional `AuthMode`, `&dyn AuthProvider`, and `PendingUnauthorizedRetry`. It queries `auth_header_telemetry(api_auth)` to determine whether an auth header is attached and its name, maps `AuthMode` variants into either `"ApiKey"` or `"Chatgpt"`, copies retry/recovery fields from `PendingUnauthorizedRetry`, and returns `AuthRequestTelemetryContext`.

**Call relations**: Constructed by compaction, memory summarization, websocket preconnect, HTTP streaming, and websocket streaming before telemetry objects are built. Tests verify that attached auth and retry phase are captured correctly.

*Call graph*: called by 6 (compact_conversation_history, summarize_memories, preconnect_websocket, stream_responses_api, stream_responses_websocket, auth_request_telemetry_context_tracks_attached_auth_and_retry_phase); 1 external calls (auth_header_telemetry).


##### `handle_unauthorized`  (lines 1982–2096)

```
async fn handle_unauthorized(
    transport: TransportError,
    auth_recovery: &mut Option<UnauthorizedRecovery>,
    session_telemetry: &SessionTelemetry,
) -> Result<UnauthorizedRecoveryExecution>
```

**Purpose**: Handles a 401 transport error by attempting one step of configured auth recovery, recording telemetry for success/failure/not-run cases, and returning either retry instructions or a mapped terminal error. It is the shared 401 recovery policy for HTTP and websocket requests.

**Data flow**: Inputs: the unauthorized `TransportError`, mutable optional `UnauthorizedRecovery`, and session telemetry. It extracts response debug context, checks whether a recovery step is available, and if so runs `recovery.next().await`. On success it records `recovery_succeeded` telemetry/feedback and returns `UnauthorizedRecoveryExecution { mode, phase }`. On permanent or transient refresh failure it records the corresponding failure telemetry and returns `CodexErr::RefreshTokenFailed` or `CodexErr::Io`. If no recovery can run, it records `recovery_not_run` with a reason and returns the mapped original transport error.

**Call relations**: Called by both `stream_responses_api` and `stream_responses_websocket` when they receive HTTP 401s. Its successful output is immediately converted into `PendingUnauthorizedRetry` for the next loop iteration.

*Call graph*: calls 2 internal fn (emit_feedback_auth_recovery_tags, record_auth_recovery); called by 2 (stream_responses_api, stream_responses_websocket); 5 external calls (Transport, map_api_error, extract_response_debug_context, Io, RefreshTokenFailed).


##### `api_error_http_status`  (lines 2098–2103)

```
fn api_error_http_status(error: &ApiError) -> Option<u16>
```

**Purpose**: Extracts an HTTP status code from an `ApiError` when the error is specifically an HTTP transport failure. It is a small helper for telemetry/reporting paths.

**Data flow**: Matches on `ApiError` → returns `Some(status.as_u16())` for `ApiError::Transport(TransportError::Http { status, .. })` → otherwise returns `None`.

**Call relations**: Used by websocket connect/request telemetry to populate follow-up status fields and feedback tags.


##### `ApiTelemetry::new`  (lines 2113–2125)

```
fn new(
        session_telemetry: SessionTelemetry,
        auth_context: AuthRequestTelemetryContext,
        request_route_telemetry: RequestRouteTelemetry,
        auth_env_telemetry: AuthEnvTelem
```

**Purpose**: Constructs the shared telemetry adapter used for request, SSE, and websocket telemetry traits. It stores all context needed to emit session metrics and feedback tags.

**Data flow**: Accepts `SessionTelemetry`, `AuthRequestTelemetryContext`, `RequestRouteTelemetry`, and `AuthEnvTelemetry` → stores them in `ApiTelemetry` → returns the struct.

**Call relations**: Instantiated by `build_request_telemetry`, `build_streaming_telemetry`, and `build_websocket_telemetry`, then viewed through different telemetry trait objects depending on transport.

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

**Purpose**: Records telemetry for a completed HTTP request attempt and emits corresponding feedback tags. It captures status, transport error message, duration, auth context, endpoint, and response-debug identifiers.

**Data flow**: Inputs: attempt number, optional HTTP status, optional `TransportError`, and duration. It derives a telemetry-safe error message, converts status to `u16`, extracts response debug context from the error when present, records the API request via `session_telemetry.record_api_request`, then emits `FeedbackRequestTags` enriched with auth-env telemetry and optional recovery-followup success/status fields.

**Call relations**: This is invoked by the underlying API client through the `RequestTelemetry` trait whenever unary or HTTP streaming requests complete an attempt.

*Call graph*: calls 1 internal fn (record_api_request); 1 external calls (emit_feedback_request_tags_with_auth_env).


##### `ApiTelemetry::on_sse_poll`  (lines 2187–2196)

```
fn on_sse_poll(
        &self,
        result: &std::result::Result<
            Option<std::result::Result<Event, EventStreamError<TransportError>>>,
            tokio::time::error::Elapsed,
```

**Purpose**: Records telemetry for an SSE poll iteration during HTTP streaming. It delegates the raw poll result and duration to session telemetry.

**Data flow**: Accepts the SSE poll result and elapsed duration → passes both to `self.session_telemetry.log_sse_event(...)`.

**Call relations**: Used only when `ApiTelemetry` is supplied as `SseTelemetry` in `stream_responses_api`.

*Call graph*: calls 1 internal fn (log_sse_event).


##### `ApiTelemetry::on_ws_request`  (lines 2200–2237)

```
fn on_ws_request(&self, duration: Duration, error: Option<&ApiError>, connection_reused: bool)
```

**Purpose**: Records telemetry for a websocket request send/response cycle and emits feedback tags including whether the connection was reused. It mirrors `on_request` but for websocket semantics.

**Data flow**: Inputs: duration, optional `ApiError`, and `connection_reused`. It derives an error message and optional HTTP status, extracts response debug context from the API error, records websocket-request telemetry via `session_telemetry.record_websocket_request`, and emits `FeedbackRequestTags` with auth context, reuse flag, debug ids, and optional recovery-followup fields.

**Call relations**: Invoked by the websocket client through the `WebsocketTelemetry` trait for each websocket request. It complements `connect_websocket`’s separate handshake telemetry.

*Call graph*: calls 1 internal fn (record_websocket_request); 1 external calls (emit_feedback_request_tags_with_auth_env).


##### `ApiTelemetry::on_ws_event`  (lines 2239–2246)

```
fn on_ws_event(
        &self,
        result: &std::result::Result<Option<std::result::Result<Message, Error>>, ApiError>,
        duration: Duration,
    )
```

**Purpose**: Records telemetry for individual websocket event polls. It forwards the raw websocket event result and timing to session telemetry.

**Data flow**: Accepts the websocket event poll result and duration → calls `self.session_telemetry.record_websocket_event(result, duration)`.

**Call relations**: Used by the websocket client through the `WebsocketTelemetry` trait during websocket streaming.

*Call graph*: calls 1 internal fn (record_websocket_event).


### `core/src/responses_retry.rs`

`orchestration` · `stream request error handling during sampling and remote compaction loops`

This file centralizes the policy for what to do after a retryable streaming failure from the Responses API. It defines `ResponsesStreamRequest` to distinguish ordinary sampling streams from remote compaction streams so logging can be tailored per request type. The main async function, `handle_retryable_response_stream_error`, is designed to be called from request loops after a stream error has already been classified as retryable.

Its control flow has three tiers. First, if the retry budget has been exhausted but the `ModelClientSession` can switch to a fallback transport, it flips transport mode, emits a warning event to the session explaining that the system is falling back from WebSockets to HTTPS, resets the retry counter to zero, and tells the caller to retry immediately. Second, if retries remain, it increments the counter, computes a delay either from the `CodexErr::Stream` embedded requested delay or from the shared `backoff` helper, logs the retry with `log_retry`, optionally surfaces a `notify_stream_error` message to the UI, sleeps for the delay, and returns `Ok(())` so the outer loop retries. The first websocket retry is intentionally hidden in release builds to reduce noisy transient reconnect messages; debug builds and non-websocket transports always report it. If neither fallback nor retry is available, the original error is returned unchanged.

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

**Purpose**: Applies the shared retry/fallback policy after a retryable stream failure and tells the caller whether to continue retrying or fail the request. It also emits user-facing and telemetry-oriented notifications at the right moments.

**Data flow**: It takes a mutable retry counter, a retry limit, the encountered `CodexErr`, mutable access to `ModelClientSession`, and references to `Session`, `TurnContext`, and the request kind. If retries are exhausted and `try_switch_fallback_transport` succeeds, it sends a `WarningEvent` through `sess.send_event`, resets `*retries` to `0`, and returns `Ok(())`. Otherwise, if retries remain, it increments `*retries`, derives a delay from `CodexErr::Stream`'s optional requested delay or `backoff(retry_count)`, logs via `log_retry`, conditionally calls `sess.notify_stream_error` with a reconnect message, sleeps for that delay, and returns `Ok(())`. If no retry path applies, it returns `Err(err)` unchanged.

**Call relations**: This function is called from both `run_remote_compaction_request_v2` and `run_sampling_request` inside their retry loops. It delegates transport switching to `ModelClientSession::try_switch_fallback_transport`, delay logging to `log_retry`, delay calculation to `backoff`, and user/session notifications to `Session` methods so the outer request loops can stay focused on request execution.

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

**Purpose**: Emits a request-type-specific warning log entry describing a pending retry after a stream failure. It formats sampling and remote compaction retries differently.

**Data flow**: It takes the request kind, turn context, error reference, retry counters, and computed delay. For `Sampling` it logs a generic warning including retry counts and delay; for `RemoteCompactionV2` it logs structured fields including `turn_id`, retry counts, and the compact error text. It returns `()` and only writes to the tracing log sink.

**Call relations**: This helper is called only by `handle_retryable_response_stream_error` after the retry delay has been chosen. It exists to keep request-specific logging details out of the main retry control flow.

*Call graph*: called by 1 (handle_retryable_response_stream_error); 1 external calls (warn!).


### `core/src/session_startup_prewarm.rs`

`orchestration` · `startup, before first regular turn`

This file adds an optional startup optimization layer around model-client session creation. `SessionStartupPrewarmHandle` wraps a spawned task that should eventually yield a ready `ModelClientSession`, along with the instant it started and the timeout budget. Its `resolve` method is careful about outcomes: if the task already finished it converts the join result immediately; otherwise it waits until either the caller's cancellation token fires or the remaining timeout elapses. It records startup-phase and duration telemetry for consumed, failed, timed-out, join-failed, and cancelled outcomes, and aborts the task when necessary. `resolution_from_join_result` centralizes the mapping from join/task result to `SessionStartupPrewarmResolution`.

On the session side, `schedule_startup_prewarm` checks whether response websockets are enabled, spawns the background prewarm task, records total prewarm telemetry, and stores the handle. `consume_startup_prewarm_for_regular_turn` retrieves and resolves that handle for the first ordinary turn, returning `Unavailable { status: "not_scheduled" }` when no prewarm exists.

The actual work happens in `schedule_startup_prewarm_inner`: it creates a preview turn context using `INITIAL_SUBMIT_ID`, builds tools and an empty prompt with supplied base instructions, derives `CodexResponsesMetadata` for `Prewarm`, creates a fresh `ModelClientSession`, and calls `prewarm_websocket` on it. Each phase records timing into `SessionTelemetry`, so startup latency can be broken down into turn-context creation, tool building, prompt building, and websocket warmup.

#### Function details

##### `SessionStartupPrewarmHandle::new`  (lines 40–50)

```
fn new(
        task: JoinHandle<CodexResult<ModelClientSession>>,
        started_at: Instant,
        timeout: Duration,
    ) -> Self
```

**Purpose**: Wraps a spawned prewarm task together with its start time and timeout budget. The task is stored in an `AbortOnDropHandle` so dropping the handle cancels the background work.

**Data flow**: It takes a `JoinHandle<CodexResult<ModelClientSession>>`, `started_at: Instant`, and `timeout: Duration`, wraps the join handle in `AbortOnDropHandle::new`, stores all three fields, and returns `SessionStartupPrewarmHandle`.

**Call relations**: Called by `Session::schedule_startup_prewarm` after spawning the background prewarm task, and also by tests that construct synthetic handles.

*Call graph*: called by 3 (interrupting_regular_turn_waiting_on_startup_prewarm_emits_turn_aborted, regular_turn_emits_turn_started_with_trace_id_without_waiting_for_startup_prewarm, schedule_startup_prewarm); 1 external calls (new).


##### `SessionStartupPrewarmHandle::abort`  (lines 52–55)

```
async fn abort(self)
```

**Purpose**: Cancels the background prewarm task and waits for it to finish aborting. This is the explicit teardown path for an unused prewarm handle.

**Data flow**: It takes ownership of `self`, calls `self.task.abort()`, awaits the task once to observe completion, ignores the result, and returns `()`. No telemetry is recorded here.

**Call relations**: Used by callers that want to discard a scheduled prewarm rather than resolve it for a turn.

*Call graph*: 1 external calls (abort).


##### `SessionStartupPrewarmHandle::resolve`  (lines 58–154)

```
async fn resolve(
        self,
        session_telemetry: &SessionTelemetry,
        cancellation_token: &CancellationToken,
    ) -> SessionStartupPrewarmResolution
```

**Purpose**: Waits for the startup prewarm task to become usable, time out, or be cancelled, and records detailed telemetry about the outcome. It converts the background task result into a `SessionStartupPrewarmResolution` suitable for the first regular turn.

**Data flow**: Inputs are the handle itself, `&SessionTelemetry`, and a cancellation token. It computes the prewarm age and remaining timeout, either consumes an already-finished task or waits with `tokio::select!` between cancellation and `tokio::time::timeout`. It maps successful joins through `resolution_from_join_result`, aborts on timeout or cancellation, records startup-phase and duration metrics with status labels, and returns `Cancelled`, `Ready(Box<ModelClientSession>)`, or `Unavailable { status, prewarm_duration }`.

**Call relations**: Called by `Session::consume_startup_prewarm_for_regular_turn` when the first real turn wants to use the prewarm. It delegates join-result interpretation to `resolution_from_join_result`.

*Call graph*: calls 2 internal fn (record_duration, record_startup_phase); 5 external calls (now, resolution_from_join_result, Ready, info!, select!).


##### `SessionStartupPrewarmHandle::resolution_from_join_result`  (lines 156–179)

```
fn resolution_from_join_result(
        result: std::result::Result<CodexResult<ModelClientSession>, tokio::task::JoinError>,
        started_at: Instant,
    ) -> SessionStartupPrewarmResolution
```

**Purpose**: Maps the raw join/task result from the background prewarm task into a stable resolution enum. It distinguishes successful prewarm, task-level failure, and join failure.

**Data flow**: It takes `Result<CodexResult<ModelClientSession>, tokio::task::JoinError>` plus `started_at`. `Ok(Ok(session))` becomes `Ready(Box::new(session))`; `Ok(Err(err))` logs a warning and becomes `Unavailable { status: "failed", prewarm_duration: None }`; `Err(join_err)` logs a warning and becomes `Unavailable { status: "join_failed", prewarm_duration: Some(started_at.elapsed()) }`.

**Call relations**: Used internally by `resolve` whenever the background task has produced a join result.

*Call graph*: 4 external calls (new, elapsed, Ready, warn!).


##### `Session::schedule_startup_prewarm`  (lines 183–214)

```
async fn schedule_startup_prewarm(self: &Arc<Self>, base_instructions: String)
```

**Purpose**: Starts the background startup prewarm task if websocket responses are enabled and stores a handle for later consumption by the first regular turn. It also records total prewarm telemetry once the task finishes.

**Data flow**: It takes `&Arc<Self>` and the base-instructions string. If the model client does not support response websockets it returns immediately. Otherwise it clones telemetry and session state, captures the provider's websocket connect timeout and current time, spawns an async task that runs `schedule_startup_prewarm_inner` and records total-duration metrics with status `ready` or `failed`, wraps the task in `SessionStartupPrewarmHandle::new`, and stores it via `set_session_startup_prewarm`.

**Call relations**: Called during session startup. It delegates the actual prewarm work to `schedule_startup_prewarm_inner` and later pairs with `consume_startup_prewarm_for_regular_turn`.

*Call graph*: calls 2 internal fn (new, schedule_startup_prewarm_inner); 3 external calls (clone, now, spawn).


##### `Session::consume_startup_prewarm_for_regular_turn`  (lines 216–229)

```
async fn consume_startup_prewarm_for_regular_turn(
        &self,
        cancellation_token: &CancellationToken,
    ) -> SessionStartupPrewarmResolution
```

**Purpose**: Retrieves the stored startup prewarm handle, if any, and resolves it for use by the first ordinary turn. If no prewarm was scheduled, it returns an explicit unavailable status.

**Data flow**: It takes `&self` and a cancellation token, removes any stored prewarm handle with `take_session_startup_prewarm`, and either returns `SessionStartupPrewarmResolution::Unavailable { status: "not_scheduled", prewarm_duration: None }` or awaits `startup_prewarm.resolve(...)` and returns that result.

**Call relations**: Called by regular-turn startup logic before creating a fresh model client session. It is the consumer-side counterpart to `schedule_startup_prewarm`.


##### `schedule_startup_prewarm_inner`  (lines 232–300)

```
async fn schedule_startup_prewarm_inner(
    session: Arc<Session>,
    base_instructions: String,
) -> CodexResult<ModelClientSession>
```

**Purpose**: Performs the actual startup prewarm work: build a preview turn context, construct tools and an empty prompt, derive prewarm metadata, create a model client session, and warm its websocket connection. It returns the ready `ModelClientSession` on success.

**Data flow**: Inputs are `Arc<Session>` and the base-instructions string. It creates a startup-prewarm turn context with `INITIAL_SUBMIT_ID`, records phase timings, builds tools with `built_tools`, builds an empty prompt with `build_prompt` and `BaseInstructions { text: base_instructions }`, computes `responses_metadata` for `CodexResponsesRequestKind::Prewarm`, creates `session.services.model_client.new_session()`, calls `prewarm_websocket(...)`, records the websocket-warmup phase timing, and returns `CodexResult<ModelClientSession>`.

**Call relations**: Executed inside the spawned task created by `Session::schedule_startup_prewarm`. It reuses the same prompt/tool-building helpers as real turns so the warmed session matches the first-turn environment as closely as possible.

*Call graph*: calls 2 internal fn (build_prompt, built_tools); called by 1 (schedule_startup_prewarm); 3 external calls (new, now, new).


### `core/src/compact_remote_v2.rs`

`domain_logic` · `turn compaction`

This file is a newer remote compaction implementation built on the normal Responses streaming API rather than a dedicated compact endpoint. The wrapper structure mirrors the older remote path: `run_inline_remote_auto_compact_task` and `run_remote_compact_task` feed into `run_remote_compact_task_inner`, which handles analytics, pre/post compact hooks, and error-event emission. The implementation-specific work happens in `run_remote_compact_task_inner_impl`.

That function clones and optionally rewrites history with `trim_function_call_history_to_fit_context_window`, builds model-visible tools, then appends a synthetic `ResponseItem::CompactionTrigger` to the prompt input before starting a traced streaming request. `run_remote_compaction_request_v2` owns the transport retry loop, capping retries at the smaller of provider stream retries and `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES`; retryable failures are delegated to `handle_retryable_response_stream_error`. `collect_compaction_output` then enforces the protocol contract: the stream must reach `response.completed` and must contain exactly one `ResponseItem::Compaction`, though other output items may appear and are ignored.

Once the compaction item arrives, `build_v2_compacted_history` reconstructs installed history by retaining only message items with roles `user`, `developer`, or `system`, filtering them again through `should_keep_compacted_history_item`, truncating retained text from newest to oldest under a 64k-token budget, counting retained input images, and finally appending the compaction output. The resulting history is then sanitized and context-reinjected by the shared remote helper before installation. The embedded tests lock down retention filtering, image accounting, truncation order, and stream-output validation.

#### Function details

##### `run_inline_remote_auto_compact_task`  (lines 56–74)

```
async fn run_inline_remote_auto_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    client_session: &mut ModelClientSession,
    initial_context_injection: InitialContextInje
```

**Purpose**: Runs automatic remote compaction v2 inline, optionally reusing an existing `ModelClientSession`. It is the auto-compaction entry point for the streamed Responses-based implementation.

**Data flow**: Takes shared `Session`, `TurnContext`, mutable `ModelClientSession`, injection mode, reason, and phase → forwards them to `run_remote_compact_task_inner` with `CompactionTrigger::Auto` and `Some(client_session)` → returns the inner result.

**Call relations**: Called by auto-compaction orchestration when the v2 remote compaction path is selected and a caller wants to reuse a client session.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run_auto_compact).


##### `run_remote_compact_task`  (lines 76–99)

```
async fn run_remote_compact_task(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
) -> CodexResult<()>
```

**Purpose**: Runs a manual standalone remote compaction v2 turn and emits `TurnStarted` first. It is the user-requested entry point for the streamed Responses-based implementation.

**Data flow**: Accepts shared `Session` and `TurnContext` → sends `EventMsg::TurnStarted` built from turn metadata → calls `run_remote_compact_task_inner` with no client session, `InitialContextInjection::DoNotInject`, `CompactionTrigger::Manual`, `CompactionReason::UserRequested`, and `CompactionPhase::StandaloneTurn` → returns the inner result.

**Call relations**: Called by the general run path when manual compaction uses the v2 remote implementation.

*Call graph*: calls 1 internal fn (run_remote_compact_task_inner); called by 1 (run); 1 external calls (TurnStarted).


##### `run_remote_compact_task_inner`  (lines 101–177)

```
async fn run_remote_compact_task_inner(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: Option<&mut ModelClientSession>,
    initial_context_injection: InitialContext
```

**Purpose**: Wraps remote compaction v2 execution with analytics, hook handling, and error-event emission. It is the common control shell for both manual and automatic v2 compaction.

**Data flow**: Takes session/context refs, optional mutable client session, injection mode, trigger, reason, and phase → builds `CompactionTurnMetadata` for `ResponsesCompactionV2`, seeds analytics details with current token usage, starts `CompactionAnalyticsAttempt`, runs pre-compact hooks and aborts with tracked `TurnAborted` if stopped → awaits `run_remote_compact_task_inner_impl` → computes status with `compaction_status_from_result` → optionally runs post-compact hooks and converts success to `TurnAborted` → tracks analytics → on error, records turn error, emits `EventMsg::Error` with a remote-compaction prefix, and returns the error; otherwise returns `Ok(())`.

**Call relations**: Called by both v2 entry points so analytics and hook semantics remain consistent.

*Call graph*: calls 6 internal fn (begin, compaction_status_from_result, run_remote_compact_task_inner_impl, run_post_compact_hooks, run_pre_compact_hooks, new); called by 2 (run_inline_remote_auto_compact_task, run_remote_compact_task); 2 external calls (default, Error).


##### `run_remote_compact_task_inner_impl`  (lines 179–321)

```
async fn run_remote_compact_task_inner_impl(
    sess: &Arc<Session>,
    turn_context: &Arc<TurnContext>,
    client_session: Option<&mut ModelClientSession>,
    initial_context_injection: InitialCo
```

**Purpose**: Performs the actual remote compaction v2 request, retention shaping, rollout tracing, and history installation. This is the core algorithm for the streamed Responses-based compaction path.

**Data flow**: Accepts session/context refs, optional mutable client session, injection mode, compaction metadata, and mutable analytics details → creates a `ContextCompactionItem` and compaction trace context, emits started turn item, clones history and base instructions, rewrites oversized outputs with `trim_function_call_history_to_fit_context_window`, adjusts analytics token counts, snapshots trace input history, builds prompt input and tools, appends `ResponseItem::CompactionTrigger`, computes responses metadata, starts a trace attempt, obtains or creates a `ModelClientSession`, and calls `run_remote_compaction_request_v2` → records trace result from the returned compaction output → updates analytics details from returned `TokenUsage` if present → builds retained history plus image count with `build_v2_compacted_history`, processes it with shared `process_compacted_history`, advances window ID, constructs `CompactedItem`, records installed checkpoint trace, replaces compacted history in session, recomputes token usage, emits completed turn item, and returns `Ok(())`.

**Call relations**: Called only by `run_remote_compact_task_inner`; it delegates transport/retry handling to `run_remote_compaction_request_v2` and transcript shaping to `build_v2_compacted_history` plus shared remote helpers.

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

**Purpose**: Executes the streamed Responses request for remote compaction v2 with a small retry budget. It retries only retryable transport/model errors and reuses the provided client session across attempts.

**Data flow**: Takes `&Session`, `&TurnContext`, mutable `ModelClientSession`, prompt, and responses metadata → computes `max_retries` as provider stream retries capped by `MAX_REMOTE_COMPACTION_V2_STREAM_RETRIES` → loops: starts `client_session.stream(...)` with disabled inference tracing, then either passes the stream to `collect_compaction_output` or propagates stream-start error → returns immediately on success or non-retryable error → on retryable error, calls `handle_retryable_response_stream_error(...)` to update retry state, notify session/turn context, and reset transport state as needed before retrying.

**Call relations**: Used by `run_remote_compact_task_inner_impl` as the transport layer for v2 compaction requests.

*Call graph*: calls 4 internal fn (stream, collect_compaction_output, handle_retryable_response_stream_error, disabled); called by 1 (run_remote_compact_task_inner_impl).


##### `collect_compaction_output`  (lines 378–426)

```
async fn collect_compaction_output(
    mut stream: ResponseStream,
) -> CodexResult<RemoteCompactionV2Output>
```

**Purpose**: Consumes a Responses stream and extracts exactly one compaction output item plus optional completed token usage. It enforces the protocol contract for remote compaction v2 streams.

**Data flow**: Takes mutable `ResponseStream` → iterates events with `next()` → counts all `OutputItemDone` items and separately counts `ResponseItem::Compaction`, storing the first compaction item seen → on `Completed`, records token usage and stops → ignores other events → if the stream ends before `Completed`, returns `CodexErr::Stream`; if the number of compaction items is not exactly one, returns `CodexErr::Fatal`; otherwise returns `RemoteCompactionV2Output { compaction_output, token_usage }`.

**Call relations**: Called by `run_remote_compaction_request_v2`; tests also call it directly to verify that extra non-compaction output items are tolerated.

*Call graph*: called by 2 (run_remote_compaction_request_v2, collect_compaction_output_accepts_additional_output_items); 5 external calls (next, format!, Fatal, Stream, unreachable!).


##### `build_v2_compacted_history`  (lines 428–446)

```
fn build_v2_compacted_history(
    prompt_input: &[ResponseItem],
    compaction_output: ResponseItem,
) -> (Vec<ResponseItem>, usize)
```

**Purpose**: Constructs the installed transcript shape for remote compaction v2 from the original prompt input and the returned compaction item. It retains only selected prompt messages, truncates them under a token budget, counts retained images, and appends the compaction output.

**Data flow**: Takes prompt input slice and a `ResponseItem` compaction output → filters prompt items through `is_retained_for_remote_compaction_v2` and `should_keep_compacted_history_item`, cloning survivors into a vector → truncates retained messages with `truncate_retained_messages_for_remote_compaction(..., RETAINED_MESSAGE_TOKEN_BUDGET)` → sums retained input images with `retained_input_image_count` → pushes the compaction output → returns `(history, retained_image_count)`.

**Call relations**: Used by `run_remote_compact_task_inner_impl`; multiple tests target it to lock down retention filtering and image counting.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); called by 4 (run_remote_compact_task_inner_impl, build_v2_compacted_history_counts_retained_input_images, build_v2_compacted_history_discards_messages_before_truncating, build_v2_compacted_history_filters_to_installed_retention_shape); 1 external calls (iter).


##### `is_retained_for_remote_compaction_v2`  (lines 448–454)

```
fn is_retained_for_remote_compaction_v2(item: &ResponseItem) -> bool
```

**Purpose**: Determines whether a prompt item is even eligible for retention in the v2 installed transcript before deeper filtering. It keeps only message items with roles `user`, `developer`, or `system`.

**Data flow**: Matches a `&ResponseItem` → returns `true` only for `ResponseItem::Message` whose `role` is one of `user`, `developer`, or `system`; otherwise returns `false`.

**Call relations**: Used by `build_v2_compacted_history` as the first-pass retention filter before shared remote-history sanitation.

*Call graph*: 1 external calls (matches!).


##### `retained_input_image_count`  (lines 456–465)

```
fn retained_input_image_count(item: &ResponseItem) -> usize
```

**Purpose**: Counts how many `InputImage` content parts are present in a retained message item. It is used for compaction analytics detail reporting.

**Data flow**: Takes `&ResponseItem` → if it is a `Message`, iterates `content` and counts `ContentItem::InputImage`; otherwise returns `0`.

**Call relations**: Used by `build_v2_compacted_history` after truncation to report how many images remain in the installed retained transcript.


##### `truncate_retained_messages_for_remote_compaction`  (lines 467–491)

```
fn truncate_retained_messages_for_remote_compaction(
    items: Vec<ResponseItem>,
    max_tokens: usize,
) -> Vec<ResponseItem>
```

**Purpose**: Applies the retained-message token budget for remote compaction v2, keeping newest messages first and truncating at most one older message to fit. Image-only messages still consume a minimum budget unit.

**Data flow**: Takes owned `Vec<ResponseItem>` and `max_tokens` → walks items from newest to oldest → if budget is exhausted, drops older items → computes each item’s token charge with `message_text_token_count().max(1)` → keeps whole items that fit, otherwise tries `truncate_message_text_to_token_budget(item, remaining)` and keeps the truncated result if nonempty, then sets remaining to zero → reverses back to chronological order and returns the truncated vector.

**Call relations**: Used by `build_v2_compacted_history`; several tests validate ordering, image charging, and truncation behavior.

*Call graph*: calls 2 internal fn (message_text_token_count, truncate_message_text_to_token_budget); called by 5 (build_v2_compacted_history, retained_history_truncation_charges_image_only_messages, retained_history_truncation_drops_image_only_messages_after_budget_is_spent, retained_history_truncation_keeps_newest_messages_first, retained_history_truncation_preserves_images_and_truncates_later_text_parts); 1 external calls (with_capacity).


##### `message_text_token_count`  (lines 493–507)

```
fn message_text_token_count(item: &ResponseItem) -> usize
```

**Purpose**: Estimates the text-token cost of a message item by summing token counts across text content parts. Images contribute zero here and are charged separately via the caller’s `.max(1)` rule.

**Data flow**: Takes `&ResponseItem` → if it is a `Message`, iterates `content`, sums `approx_token_count(text)` for `InputText` and `OutputText`, and ignores `InputImage`; otherwise returns `0`.

**Call relations**: Used by `truncate_retained_messages_for_remote_compaction` to decide which retained messages fit within the token budget.

*Call graph*: called by 1 (truncate_retained_messages_for_remote_compaction).


##### `truncate_message_text_to_token_budget`  (lines 509–559)

```
fn truncate_message_text_to_token_budget(
    item: ResponseItem,
    max_tokens: usize,
) -> Option<ResponseItem>
```

**Purpose**: Truncates the text portions of a single message item to fit a token budget while preserving images and message metadata. It may drop the item entirely if no content remains after truncation.

**Data flow**: Takes owned `ResponseItem` and `max_tokens` → if not a `Message`, returns it unchanged in `Some` → otherwise iterates content parts in order with a remaining-token counter: keeps images unchanged, keeps text parts that fit, truncates the first over-budget text part with `truncate_text(TruncationPolicy::Tokens(remaining))`, drops later text once budget is zero, and omits empty text parts → returns `None` if all content was removed, else reconstructs and returns a `ResponseItem::Message` with original id/role/phase/metadata and truncated content.

**Call relations**: Used by `truncate_retained_messages_for_remote_compaction` when a retained message partially fits the remaining budget.

*Call graph*: called by 1 (truncate_retained_messages_for_remote_compaction); 4 external calls (with_capacity, approx_token_count, truncate_text, Tokens).


##### `tests::message`  (lines 570–580)

```
fn message(role: &str, text: &str, phase: Option<MessagePhase>) -> ResponseItem
```

**Purpose**: Builds a minimal `ResponseItem::Message` fixture for the v2 compaction tests. It reduces boilerplate when constructing retained-history examples.

**Data flow**: Takes role, text, and optional `MessagePhase` → constructs a `ResponseItem::Message` with one `ContentItem::InputText`, no id, and no metadata → returns it.

**Call relations**: Used by multiple tests in this module to create concise message fixtures.

*Call graph*: 1 external calls (vec!).


##### `tests::response_stream`  (lines 582–594)

```
fn response_stream(events: Vec<CodexResult<ResponseEvent>>) -> ResponseStream
```

**Purpose**: Builds a synthetic `ResponseStream` from a fixed list of test events. It lets tests drive `collect_compaction_output` without a real model client.

**Data flow**: Takes `Vec<CodexResult<ResponseEvent>>` → creates an mpsc channel sized to at least one event → `try_send`s each event into the channel, drops the sender, and returns `ResponseStream { rx_event, consumer_dropped: CancellationToken::new() }`.

**Call relations**: Used by the stream-collection test to simulate a completed remote compaction v2 response.

*Call graph*: 2 external calls (new, channel).


##### `tests::build_v2_compacted_history_filters_to_installed_retention_shape`  (lines 597–628)

```
fn build_v2_compacted_history_filters_to_installed_retention_shape()
```

**Purpose**: Verifies that v2 retained history keeps only the installed transcript shape: real retained user content plus the new compaction item. It confirms assistant/tool/old-compaction items are discarded.

**Data flow**: Builds a mixed prompt input containing developer, system, user, assistant, function-call, and old compaction items plus a new compaction output → calls `build_v2_compacted_history` → asserts the resulting history is `[user_message, new_compaction]`.

**Call relations**: Exercises the combined effect of `is_retained_for_remote_compaction_v2` and `should_keep_compacted_history_item` inside `build_v2_compacted_history`.

*Call graph*: calls 1 internal fn (build_v2_compacted_history); 2 external calls (assert_eq!, vec!).


##### `tests::build_v2_compacted_history_discards_messages_before_truncating`  (lines 631–653)

```
fn build_v2_compacted_history_discards_messages_before_truncating()
```

**Purpose**: Verifies that messages filtered out by retention rules do not consume the retained-message token budget. This ensures truncation is applied only after irrelevant messages are discarded.

**Data flow**: Builds input with an old user message, a huge developer message, a huge contextual user wrapper message, and a new user message → calls `build_v2_compacted_history` → asserts the result keeps the old and new real user messages plus the compaction output, with the huge discarded messages not forcing truncation.

**Call relations**: Targets the ordering inside `build_v2_compacted_history`: filter first, then truncate.

*Call graph*: calls 1 internal fn (build_v2_compacted_history); 4 external calls (assert_eq!, message, format!, vec!).


##### `tests::build_v2_compacted_history_counts_retained_input_images`  (lines 656–684)

```
fn build_v2_compacted_history_counts_retained_input_images()
```

**Purpose**: Verifies that retained input images are counted correctly for analytics. It checks that image-bearing user messages contribute to the returned image count.

**Data flow**: Builds a single retained user message containing one text part and two `InputImage` parts plus a compaction output → calls `build_v2_compacted_history` → asserts the returned retained image count is `2`.

**Call relations**: Exercises `retained_input_image_count` through the public retained-history builder.

*Call graph*: calls 1 internal fn (build_v2_compacted_history); 2 external calls (assert_eq!, vec!).


##### `tests::retained_history_truncation_keeps_newest_messages_first`  (lines 687–706)

```
fn retained_history_truncation_keeps_newest_messages_first()
```

**Purpose**: Verifies that retained-history truncation spends budget from newest to oldest and truncates an older message rather than dropping the newest one. It locks in recency-first retention semantics.

**Data flow**: Builds three user messages ordered old/middle/new → calls `truncate_retained_messages_for_remote_compaction` with a tiny budget → asserts the result contains a truncated middle message followed by the full newest message.

**Call relations**: Directly tests the reverse-walk truncation strategy used by the v2 retained-history builder.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 3 external calls (assert_eq!, message, vec!).


##### `tests::retained_history_truncation_preserves_images_and_truncates_later_text_parts`  (lines 709–753)

```
fn retained_history_truncation_preserves_images_and_truncates_later_text_parts()
```

**Purpose**: Verifies that truncating a single retained message preserves embedded images and truncates later text content parts when budget runs out. It checks content-part-level truncation behavior.

**Data flow**: Builds one user message with input text, an image, and output text → truncates retained messages under a small budget → asserts the first text and image remain while the later text part is truncated with a marker.

**Call relations**: Exercises `truncate_message_text_to_token_budget` through the retained-history truncation helper.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 2 external calls (assert_eq!, vec!).


##### `tests::retained_history_truncation_charges_image_only_messages`  (lines 756–778)

```
fn retained_history_truncation_charges_image_only_messages()
```

**Purpose**: Verifies that image-only messages still consume retained-history budget via the minimum charge rule. This prevents unlimited retention of image-only messages.

**Data flow**: Builds retained history with an old text message, an image-only message, and a newest text message → truncates under a small budget → asserts the image-only message and newest message remain while the oldest text message is dropped.

**Call relations**: Tests the `.max(1)` charging rule inside `truncate_retained_messages_for_remote_compaction`.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 3 external calls (assert_eq!, message, vec!).


##### `tests::retained_history_truncation_drops_image_only_messages_after_budget_is_spent`  (lines 781–799)

```
fn retained_history_truncation_drops_image_only_messages_after_budget_is_spent()
```

**Purpose**: Verifies that image-only messages are dropped once the retained-history budget has already been exhausted by newer items. It complements the previous image-charging test.

**Data flow**: Builds retained history with an image-only message followed by a newest text message → truncates under a one-token budget → asserts only the newest text message remains.

**Call relations**: Confirms that image-only messages are not retained for free after newer content consumes the budget.

*Call graph*: calls 1 internal fn (truncate_retained_messages_for_remote_compaction); 3 external calls (assert_eq!, message, vec!).


##### `tests::collect_compaction_output_accepts_additional_output_items`  (lines 802–842)

```
async fn collect_compaction_output_accepts_additional_output_items()
```

**Purpose**: Verifies that stream collection tolerates extra non-compaction output items as long as exactly one compaction item appears and the stream completes. It also checks token-usage propagation.

**Data flow**: Builds a synthetic response stream containing an assistant message output, one compaction output, and a completed event with token usage → calls `collect_compaction_output` → asserts the returned compaction item and token usage match the expected values.

**Call relations**: Directly tests the protocol contract enforced by `collect_compaction_output`.

*Call graph*: calls 1 internal fn (collect_compaction_output); 3 external calls (assert_eq!, response_stream, vec!).


### `ext/image-generation/src/backend.rs`

`io_transport` · `tool request handling / outbound API calls`

This file wraps provider resolution and HTTP client construction for image requests. `CodexImagesBackend` stores a `SharedModelProvider`, which can asynchronously supply both the current API provider configuration and the corresponding authentication material. The private `client` method is the key piece: it awaits `api_provider()` and `api_auth()`, converts either failure into a plain `String`, builds a fresh reqwest client via `build_reqwest_client`, wraps it in `ReqwestTransport`, and constructs an `ImagesClient<ReqwestTransport>`. The two public async methods then use that client for specific API calls. `generate` sends an `ImageGenerationRequest` with an empty `HeaderMap`; `edit` does the same for `ImageEditRequest`. Both propagate backend errors as strings rather than richer error types, which keeps the extension/tool layer simple at the cost of typed error detail. There is no caching of the `ImagesClient`; each call resolves provider/auth anew, which ensures requests use current credentials and provider settings.

#### Function details

##### `CodexImagesBackend::new`  (lines 17–19)

```
fn new(provider: SharedModelProvider) -> Self
```

**Purpose**: Constructs an image backend bound to a shared model-provider handle. It stores the dependency needed to resolve provider and auth at request time.

**Data flow**: It takes a `SharedModelProvider`, stores it in `CodexImagesBackend`, and returns the new backend.

**Call relations**: It is called by the image-generation extension when constructing the tool executor. The resulting backend is later used by `generate` and `edit`.


##### `CodexImagesBackend::client`  (lines 22–38)

```
async fn client(&self) -> Result<ImagesClient<ReqwestTransport>, String>
```

**Purpose**: Builds a ready-to-use `ImagesClient` for the current request by resolving provider configuration and authentication from the shared provider. It centralizes all setup needed before making image API calls.

**Data flow**: It reads `self.provider`, awaits `api_provider()` and `api_auth()`, maps either error to `String`, constructs a reqwest client with `build_reqwest_client`, wraps it in `ReqwestTransport`, creates `ImagesClient::new(transport, provider, auth)`, and returns the client.

**Call relations**: It is called by both `generate` and `edit` immediately before issuing a request. Those methods rely on it so they do not duplicate provider/auth resolution logic.

*Call graph*: calls 3 internal fn (new, new, build_reqwest_client); called by 2 (edit, generate); 2 external calls (api_auth, api_provider).


##### `CodexImagesBackend::generate`  (lines 41–50)

```
async fn generate(
        &self,
        request: ImageGenerationRequest,
    ) -> Result<ImageResponse, String>
```

**Purpose**: Sends a standalone image generation request through the configured images API client. It is the backend path for prompt-to-image generation.

**Data flow**: It takes an `ImageGenerationRequest`, awaits `self.client()`, calls `.generate(&request, HeaderMap::new())` on the resulting client, awaits the API response, maps any API error to `String`, and returns `ImageResponse` on success.

**Call relations**: It is invoked by the image-generation tool's call handler when the request is a generation rather than an edit. It delegates setup to `client` and transport execution to `ImagesClient::generate`.

*Call graph*: calls 1 internal fn (client); called by 1 (handle_call); 1 external calls (new).


##### `CodexImagesBackend::edit`  (lines 53–59)

```
async fn edit(&self, request: ImageEditRequest) -> Result<ImageResponse, String>
```

**Purpose**: Sends a standalone image edit request through the configured images API client. It is the backend path for image-edit operations.

**Data flow**: It takes an `ImageEditRequest`, awaits `self.client()`, calls `.edit(&request, HeaderMap::new())`, awaits the API response, maps any API error to `String`, and returns `ImageResponse` on success.

**Call relations**: It is called by the image-generation tool's handler for edit-style requests. Like `generate`, it relies on `client` for provider/auth resolution and transport setup.

*Call graph*: calls 1 internal fn (client); called by 1 (handle_call); 1 external calls (new).


### Realtime websocket protocol stack
These files organize the realtime websocket module, define version-specific message shapes and parsers, and provide the unified websocket transport methods.

### `codex-api/src/endpoint/realtime_websocket/mod.rs`

`orchestration` · `request handling`

This file organizes the realtime websocket subsystem into two parallel families of modules: `methods*` modules for client-side websocket operations and `protocol*` modules for parsing and representing realtime events. The presence of `methods_v1`/`methods_v2` and `protocol_v1`/`protocol_v2`, alongside shared `*_common` modules, shows that the subsystem supports multiple protocol versions behind a single public interface. The top-level `methods` and `protocol` modules act as version-selecting façades, while this file re-exports the unified types that callers should use.

The exported method-side API includes `RealtimeWebsocketClient`, `RealtimeWebsocketConnection`, `RealtimeWebsocketEvents`, and `RealtimeWebsocketWriter`, covering connection establishment, event consumption, and outbound message writing. On the protocol side it exposes `RealtimeEventParser`, `RealtimeOutputModality`, `RealtimeSessionConfig`, and `RealtimeSessionMode`, plus the shared helper `session_update_session_json` for constructing session update payloads. This module contains no executable code itself; its main job is to hide version-specific implementation details and present a stable, coherent websocket API. That version-bridging role is the subtle but important design choice: consumers interact with one namespace while the crate retains freedom to evolve protocol internals per version.


### `codex-api/src/endpoint/realtime_websocket/methods_common.rs`

`domain_logic` · `request handling`

This file is the compatibility layer between the generic websocket client code and the version-specific realtime protocol builders in `methods_v1` and `methods_v2`. It exports a shared audio sample-rate constant and a small set of dispatch functions keyed by `RealtimeEventParser`.

`normalized_session_mode` encodes an important invariant: v1 does not support a distinct transcription mode, so any requested mode is coerced to `RealtimeSessionMode::Conversational`, while Realtime V2 preserves the caller’s requested mode. The message builders follow the same pattern. `conversation_item_create_message` selects the correct item-create payload shape for the active protocol version. `conversation_function_call_output_message` is more nuanced: v1 has no function-call-output item, so it maps the output into a legacy `conversation.handoff.append` message and prefixes the text with `"Agent Final Message":\n\n`; v2 emits a proper function-call-output conversation item.

`session_update_session` chooses the correct session schema builder after normalizing the mode, and `session_update_session_json` turns a full `RealtimeSessionConfig` into a serializable JSON object while injecting `session_id` and `model` into the generated session structure. Finally, `websocket_intent` exposes the version-specific websocket query intent, which is `Some("quicksilver")` for v1 and `None` for v2.

#### Function details

##### `normalized_session_mode`  (lines 24–32)

```
fn normalized_session_mode(
    event_parser: RealtimeEventParser,
    session_mode: RealtimeSessionMode,
) -> RealtimeSessionMode
```

**Purpose**: Normalizes requested session mode according to protocol-version capabilities.

**Data flow**: Takes `event_parser` and `session_mode` → returns `Conversational` for `RealtimeEventParser::V1`, otherwise returns the original `session_mode` for `RealtimeV2`.

**Call relations**: Used by session-building code in both `send_session_update` and `session_update_session` so v1 callers cannot accidentally request an unsupported transcription session shape.

*Call graph*: called by 2 (send_session_update, session_update_session).


##### `conversation_item_create_message`  (lines 34–43)

```
fn conversation_item_create_message(
    event_parser: RealtimeEventParser,
    text: String,
    role: ConversationTextRole,
) -> RealtimeOutboundMessage
```

**Purpose**: Dispatches conversation item creation to the correct version-specific message builder.

**Data flow**: Consumes `event_parser`, `text`, and `role` → calls either `methods_v1::conversation_item_create_message` or `methods_v2::conversation_item_create_message` → returns a `RealtimeOutboundMessage`.

**Call relations**: Called by `RealtimeWebsocketWriter::send_conversation_item_create` to hide protocol-version branching from the writer.

*Call graph*: calls 2 internal fn (conversation_item_create_message, conversation_item_create_message); called by 1 (send_conversation_item_create).


##### `conversation_function_call_output_message`  (lines 45–59)

```
fn conversation_function_call_output_message(
    event_parser: RealtimeEventParser,
    call_id: String,
    output_text: String,
) -> RealtimeOutboundMessage
```

**Purpose**: Builds the correct outbound representation of function-call output for the active realtime protocol version.

**Data flow**: Takes `event_parser`, `call_id`, and `output_text` → for v1, prefixes the text with `AGENT_FINAL_MESSAGE_PREFIX` and wraps it in a legacy handoff-append message; for v2, builds a function-call-output conversation item → returns `RealtimeOutboundMessage`.

**Call relations**: Used by `RealtimeWebsocketWriter::send_conversation_function_call_output`; it centralizes the biggest semantic difference between v1 and v2 outbound handoff/output handling.

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

**Purpose**: Builds the version-appropriate `SessionUpdateSession` payload from generic session inputs.

**Data flow**: Consumes `event_parser`, `instructions`, `session_mode`, `output_modality`, and `voice` → normalizes the mode → calls the v1 or v2 session builder → returns `SessionUpdateSession`.

**Call relations**: Used by `RealtimeWebsocketWriter::send_session_update` and `session_update_session_json` so both websocket bootstrap and HTTP realtime-call embedding share the same session schema logic.

*Call graph*: calls 3 internal fn (normalized_session_mode, session_update_session, session_update_session); called by 2 (send_session_update, session_update_session_json).


##### `session_update_session_json`  (lines 77–88)

```
fn session_update_session_json(config: RealtimeSessionConfig) -> JsonResult<Value>
```

**Purpose**: Converts a full `RealtimeSessionConfig` into a JSON session object suitable for embedding in HTTP realtime call creation.

**Data flow**: Consumes `config` → builds a `SessionUpdateSession` via `session_update_session`, then sets `session.id = config.session_id` and `session.model = config.model` → serializes the struct to `serde_json::Value` with `to_value`.

**Call relations**: Called by realtime call creation code when embedding session state into HTTP requests.

*Call graph*: calls 1 internal fn (session_update_session); 1 external calls (to_value).


##### `websocket_intent`  (lines 90–95)

```
fn websocket_intent(event_parser: RealtimeEventParser) -> Option<&'static str>
```

**Purpose**: Returns the protocol-version-specific websocket `intent` query parameter, if any.

**Data flow**: Takes `event_parser` → returns `Some("quicksilver")` for v1 via `methods_v1::websocket_intent` or `None` for v2 via `methods_v2::websocket_intent`.

**Call relations**: Used by `websocket_url_from_api_url` during websocket URL construction.

*Call graph*: calls 2 internal fn (websocket_intent, websocket_intent); called by 1 (websocket_url_from_api_url).


### `codex-api/src/endpoint/realtime_websocket/methods_v1.rs`

`domain_logic` · `request handling`

This file contains the v1-specific builders selected by `methods_common`. The payloads here target the older quicksilver-style realtime websocket API, which has a simpler session schema and no native function-call-output item type.

`conversation_item_create_message` constructs a `RealtimeOutboundMessage::ConversationItemCreate` whose payload is a `ConversationItemPayload::Message`. The embedded `ConversationMessageItem` is always typed as `Message`, preserves the caller’s `ConversationTextRole`, and carries a single `ConversationItemContent` entry of type `InputText` containing the provided text.

`conversation_handoff_append_message` exposes the legacy handoff output wire shape directly as `RealtimeOutboundMessage::ConversationHandoffAppend { handoff_id, output_text }`. This is what the compatibility layer uses to emulate function-call output on v1.

`session_update_session` builds the v1 `SessionUpdateSession`: `type` is `SessionType::Quicksilver`, `instructions` is always present, `model` and `id` are left unset for later injection if needed, input audio is fixed to PCM at `REALTIME_AUDIO_SAMPLE_RATE`, and output audio contains only the selected `RealtimeVoice` with no explicit output format. Noise reduction, transcription, turn detection, tools, tool choice, and output modalities are all omitted. `websocket_intent` returns the required `quicksilver` query parameter for v1 websocket URLs.

#### Function details

##### `conversation_item_create_message`  (lines 18–32)

```
fn conversation_item_create_message(
    text: String,
    role: ConversationTextRole,
) -> RealtimeOutboundMessage
```

**Purpose**: Builds the v1 conversation-item-create message for a single text input item.

**Data flow**: Consumes `text` and `role` → constructs `RealtimeOutboundMessage::ConversationItemCreate` containing `ConversationItemPayload::Message(ConversationMessageItem { type: Message, role, content: [InputText{text}] })` → returns it.

**Call relations**: Called indirectly through `methods_common::conversation_item_create_message` when the active parser/version is v1.

*Call graph*: called by 1 (conversation_item_create_message); 2 external calls (Message, vec!).


##### `conversation_handoff_append_message`  (lines 34–42)

```
fn conversation_handoff_append_message(
    handoff_id: String,
    output_text: String,
) -> RealtimeOutboundMessage
```

**Purpose**: Builds the legacy v1 handoff append message used to send delegated output back into the conversation.

**Data flow**: Takes `handoff_id` and `output_text` and returns `RealtimeOutboundMessage::ConversationHandoffAppend { handoff_id, output_text }`.

**Call relations**: Used indirectly by `methods_common::conversation_function_call_output_message` to emulate function-call output on v1.

*Call graph*: called by 1 (conversation_function_call_output_message).


##### `session_update_session`  (lines 44–72)

```
fn session_update_session(
    instructions: String,
    voice: RealtimeVoice,
) -> SessionUpdateSession
```

**Purpose**: Builds the v1 quicksilver session-update payload with fixed PCM input audio and voiced output audio.

**Data flow**: Consumes `instructions` and `voice` → returns `SessionUpdateSession` with `type: Quicksilver`, `instructions: Some(...)`, `audio.input.format` set to PCM/24kHz, `audio.output` set to `Some(SessionAudioOutput { format: None, voice })`, and all v2-only fields omitted.

**Call relations**: Called indirectly through `methods_common::session_update_session` whenever a v1 websocket or realtime-call session payload is needed.

*Call graph*: called by 1 (session_update_session).


##### `websocket_intent`  (lines 74–76)

```
fn websocket_intent() -> Option<&'static str>
```

**Purpose**: Supplies the required v1 websocket intent string.

**Data flow**: Returns `Some("quicksilver")`.

**Call relations**: Used indirectly through `methods_common::websocket_intent` during websocket URL construction for v1 sessions.

*Call graph*: called by 1 (websocket_intent).


### `codex-api/src/endpoint/realtime_websocket/methods_v2.rs`

`domain_logic` · `request handling`

This file contains the Realtime V2-specific builders used by the shared websocket layer. Compared with v1, V2 supports richer session configuration, explicit function-call-output items, and a distinct transcription-only mode.

`conversation_item_create_message` mirrors the v1 text-item shape but is selected for V2 sessions. `conversation_function_call_output_message` uses the newer `ConversationItemPayload::FunctionCallOutput` variant, producing a `conversation.item.create` message whose item type is `FunctionCallOutput` and whose payload carries `call_id` plus raw `output` text.

The main logic is `session_update_session`, which branches on `RealtimeSessionMode`. In `Conversational` mode it builds a `SessionUpdateSession` of type `Realtime` with instructions, one output modality (`"text"` or `"audio"`), PCM 24 kHz input and output audio, near-field noise reduction, input transcription using `gpt-4o-mini-transcribe`, server VAD turn detection, and two function tools: `background_agent` with a required `prompt` string parameter and `remain_silent` with an empty object schema. Tool choice is fixed to `"auto"`. In `Transcription` mode it instead emits type `Transcription`, omits instructions, output modalities, output audio, tools, and turn detection, and keeps only PCM input plus transcription.

`output_modality_value` maps the enum to the exact wire strings, and `websocket_intent` returns `None`, meaning V2 websocket URLs do not carry the legacy `intent` query parameter.

#### Function details

##### `conversation_item_create_message`  (lines 39–53)

```
fn conversation_item_create_message(
    text: String,
    role: ConversationTextRole,
) -> RealtimeOutboundMessage
```

**Purpose**: Builds the V2 conversation-item-create message for a single text input item.

**Data flow**: Consumes `text` and `role` → constructs `RealtimeOutboundMessage::ConversationItemCreate` containing a message item with one `input_text` content entry → returns it.

**Call relations**: Selected indirectly by `methods_common::conversation_item_create_message` when the active parser/version is `RealtimeV2`.

*Call graph*: called by 1 (conversation_item_create_message); 2 external calls (Message, vec!).


##### `conversation_function_call_output_message`  (lines 55–66)

```
fn conversation_function_call_output_message(
    call_id: String,
    output_text: String,
) -> RealtimeOutboundMessage
```

**Purpose**: Builds the V2 function-call-output conversation item message.

**Data flow**: Consumes `call_id` and `output_text` → constructs `RealtimeOutboundMessage::ConversationItemCreate { item: FunctionCallOutput { type: FunctionCallOutput, call_id, output } }` → returns it.

**Call relations**: Selected indirectly by `methods_common::conversation_function_call_output_message` for V2 sessions.

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

**Purpose**: Builds the V2 session-update payload for either conversational or transcription mode.

**Data flow**: Consumes `instructions`, `session_mode`, `output_modality`, and `voice` → matches on `session_mode`: conversational returns a `SessionUpdateSession` with type `Realtime`, instructions, output modalities, full audio config, background-agent and remain-silent tools, and `tool_choice: auto`; transcription returns type `Transcription` with only input PCM plus transcription and omits instructions/output/tools.

**Call relations**: Called indirectly through `methods_common::session_update_session` for websocket bootstrap and HTTP realtime-call session embedding.

*Call graph*: called by 1 (session_update_session); 1 external calls (vec!).


##### `output_modality_value`  (lines 164–169)

```
fn output_modality_value(output_modality: RealtimeOutputModality) -> &'static str
```

**Purpose**: Maps `RealtimeOutputModality` to the exact V2 wire string.

**Data flow**: Takes `output_modality` and returns either `"text"` or `"audio"`.

**Call relations**: Used internally by `session_update_session` when populating `output_modalities` in conversational mode.


##### `websocket_intent`  (lines 171–173)

```
fn websocket_intent() -> Option<&'static str>
```

**Purpose**: Indicates that Realtime V2 websocket URLs do not use a legacy intent query parameter.

**Data flow**: Returns `None`.

**Call relations**: Used indirectly through `methods_common::websocket_intent` during websocket URL construction for V2 sessions.

*Call graph*: called by 1 (websocket_intent).


### `codex-api/src/endpoint/realtime_websocket/protocol_v1.rs`

`io_transport` · `websocket event parsing`

This file is a narrow event-decoding module for the v1 realtime websocket protocol. Its main entrypoint first delegates generic JSON parsing and message-type extraction to shared helpers, then performs a stringly-typed dispatch on the protocol's `type` field. Most branches reuse common parsers from `protocol_common` for session updates, transcript deltas, transcript completion, and error events, but several v1-specific branches manually extract fields from `serde_json::Value`.

The most concrete custom decoding is for `conversation.output_audio.delta`, where the code accepts audio bytes from either `delta` or legacy `data`, requires `sample_rate` and channel count, converts them with checked `u64 -> u32/u16` casts, and emits `RealtimeEvent::AudioOut` with `item_id: None`. Transcript events intentionally support multiple synonymous v1 event names mapping onto the same internal `RealtimeEvent` variants. `conversation.item.added` forwards the raw nested `item` JSON unchanged, while `conversation.item.done` is reduced to only the item's string `id`. Handoff requests are also decoded directly from top-level fields into `RealtimeHandoffRequested`, with `active_transcript` initialized empty.

A key design choice is fail-closed parsing: any missing field, wrong JSON type, or failed numeric conversion returns `None` for that event instead of partially constructing a value. Unsupported event types are only logged with `tracing::debug!` and otherwise ignored.

#### Function details

##### `parse_realtime_event_v1`  (lines 12–91)

```
fn parse_realtime_event_v1(payload: &str) -> Option<RealtimeEvent>
```

**Purpose**: Decodes one raw websocket text payload from the v1 realtime protocol into a `RealtimeEvent`, covering session, audio, transcript, conversation-item, handoff, and error messages. It also normalizes several alternate v1 event names onto the same internal event variants.

**Data flow**: Takes `payload: &str`, parses it through `parse_realtime_payload` to obtain a `serde_json::Value` plus message type string, then matches on that type. Depending on the branch, it either delegates to shared parsers, extracts concrete fields like `delta`, `sample_rate`, `channels`, `handoff_id`, and `item_id` from the JSON object, or clones nested `item` JSON. It returns `Some(RealtimeEvent)` on successful decoding; on malformed payloads, missing required fields, failed integer narrowing, or unsupported message types it returns `None` and only emits a debug log for unsupported types.

**Call relations**: This function is invoked by the higher-level realtime parser when protocol version 1 has been selected. It is the dispatch hub for this file: common event families are handed off to shared parsing helpers, while `conversation.item.done` is delegated to `parse_conversation_item_done_event` because that branch has its own extraction logic.

*Call graph*: calls 6 internal fn (parse_error_event, parse_realtime_payload, parse_session_updated_event, parse_transcript_delta_event, parse_transcript_done_event, parse_conversation_item_done_event); called by 1 (parse_realtime_event); 4 external calls (new, debug!, AudioOut, HandoffRequested).


##### `parse_conversation_item_done_event`  (lines 93–99)

```
fn parse_conversation_item_done_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: Extracts the completed conversation item's identifier from a v1 `conversation.item.done` payload and wraps it as `RealtimeEvent::ConversationItemDone`. It ignores all other item fields.

**Data flow**: Receives the already-parsed JSON `Value`, looks up `item`, requires it to be an object, then reads `item.id` as a string and clones it into an owned `String`. It returns `Some(RealtimeEvent::ConversationItemDone { item_id })` when that path exists, otherwise `None`.

**Call relations**: This helper is only reached from `parse_realtime_event_v1` when the incoming message type is `conversation.item.done`. It exists to keep the main match arm concise and to isolate the nested `item.id` extraction path.

*Call graph*: called by 1 (parse_realtime_event_v1); 1 external calls (get).


### `codex-api/src/endpoint/realtime_websocket/protocol_v2.rs`

`io_transport` · `websocket event parsing`

This file implements the v2 realtime websocket decoder. Like the v1 parser, it starts with shared payload parsing and then dispatches on the event type string, but it understands the newer response-oriented naming scheme and several additional event families. Shared helpers still decode session updates, transcript deltas, transcript completion, and generic errors; v2-specific helpers cover response IDs, output audio defaults, and special interpretation of completed conversation items.

Audio output parsing is more permissive than v1: `response.output_audio.delta` and `response.audio.delta` require only the base64 `delta` field, while `sample_rate` and channel count fall back to `DEFAULT_AUDIO_SAMPLE_RATE` (24 kHz) and mono if absent. Response lifecycle events (`response.created`, `response.cancelled`, `response.done`) all extract an ID from either `response.id` or top-level `response_id`. `input_audio_buffer.speech_started` becomes a typed `RealtimeInputAudioSpeechStarted` with optional `item_id`.

The most protocol-specific logic is in `conversation.item.done`: if the nested item is a `function_call` named `background_agent`, it is reinterpreted as `RealtimeEvent::HandoffRequested`; if named `remain_silent`, it becomes `RealtimeEvent::NoopRequested`; otherwise it falls back to a plain `ConversationItemDone`. Handoff extraction also parses the tool-call `arguments` string as JSON when possible and searches several candidate keys (`input_transcript`, `input`, `text`, `prompt`, `query`) for a non-empty transcript, falling back to the raw arguments string. As in v1, malformed or unsupported payloads quietly return `None`, with unsupported types logged at debug level.

#### Function details

##### `parse_realtime_event_v2`  (lines 24–79)

```
fn parse_realtime_event_v2(payload: &str) -> Option<RealtimeEvent>
```

**Purpose**: Decodes one raw v2 realtime websocket payload into a `RealtimeEvent`, covering session updates, audio, transcripts, speech-start markers, conversation items, response lifecycle events, and errors. It also maps multiple synonymous v2 event names onto the same internal variants.

**Data flow**: Accepts `payload: &str`, uses `parse_realtime_payload` to obtain parsed JSON and the message type, then matches on that type. It delegates transcript and session parsing to shared helpers, routes audio messages through `parse_output_audio_delta_event`, wraps optional `item_id` into `RealtimeInputAudioSpeechStarted`, clones nested `item` JSON for item-added events, derives response IDs via `parse_response_event_response_id`, and forwards `conversation.item.done` to `parse_conversation_item_done_event`. It returns `Some(RealtimeEvent)` on success, or `None` for malformed/unsupported payloads while logging unsupported types.

**Call relations**: This function is called by the version-selecting realtime parser for protocol v2. It is the top-level dispatcher for all helpers in this file: response ID extraction, output-audio decoding, and conversation-item reinterpretation all hang off specific match arms.

*Call graph*: calls 8 internal fn (parse_error_event, parse_realtime_payload, parse_session_updated_event, parse_transcript_delta_event, parse_transcript_done_event, parse_conversation_item_done_event, parse_output_audio_delta_event, parse_response_event_response_id); called by 1 (parse_realtime_event); 5 external calls (debug!, InputAudioSpeechStarted, ResponseCancelled, ResponseCreated, ResponseDone).


##### `parse_response_event_response_id`  (lines 81–94)

```
fn parse_response_event_response_id(parsed: &Value) -> Option<String>
```

**Purpose**: Extracts a response identifier from v2 response lifecycle payloads, supporting both nested and flat layouts. It smooths over schema variation between providers or event shapes.

**Data flow**: Takes parsed JSON `Value`, first tries `response.id` by requiring `response` to be an object and `id` to be a string, then falls back to top-level `response_id`. It returns `Option<String>` with the owned identifier or `None` if neither representation is present.

**Call relations**: This helper is used by `parse_realtime_event_v2` in the `response.created`, `response.cancelled`, and `response.done` branches so those arms can construct typed events without duplicating fallback logic.

*Call graph*: called by 1 (parse_realtime_event_v2); 1 external calls (get).


##### `parse_output_audio_delta_event`  (lines 96–125)

```
fn parse_output_audio_delta_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: Builds a `RealtimeEvent::AudioOut` from a v2 output-audio delta payload, applying protocol defaults for omitted audio metadata. It preserves optional `item_id` when the server includes it.

**Data flow**: Receives parsed JSON, requires `delta` as a string, then reads `sample_rate` and `channels`/`num_channels` as unsigned integers with checked narrowing. Missing or invalid audio metadata falls back to `DEFAULT_AUDIO_SAMPLE_RATE` and `DEFAULT_AUDIO_CHANNELS`; `samples_per_channel` and `item_id` remain optional. It returns `Some(RealtimeEvent::AudioOut(RealtimeAudioFrame { ... }))` or `None` if the required `delta` field is absent.

**Call relations**: This helper is called from `parse_realtime_event_v2` for `response.output_audio.delta` and `response.audio.delta`. It isolates the v2-specific defaulting behavior so the main dispatcher stays focused on event-type routing.

*Call graph*: called by 1 (parse_realtime_event_v2); 2 external calls (get, AudioOut).


##### `parse_conversation_item_done_event`  (lines 127–140)

```
fn parse_conversation_item_done_event(parsed: &Value) -> Option<RealtimeEvent>
```

**Purpose**: Interprets a completed conversation item either as a special tool-triggered control event or as an ordinary item completion. It gives handoff and silence tool calls precedence over generic completion handling.

**Data flow**: Takes parsed JSON, requires `item` to be an object, then first passes that object to `parse_handoff_requested_event` and `parse_noop_requested_event`. If neither returns a specialized event, it reads `item.id` as a string and wraps it in `RealtimeEvent::ConversationItemDone`. Missing `item` or `id` yields `None`.

**Call relations**: This function is reached from `parse_realtime_event_v2` for `conversation.item.done`. It acts as a second-stage dispatcher for nested tool-call items, delegating to the handoff and noop parsers before falling back to the generic completion event.

*Call graph*: calls 2 internal fn (parse_handoff_requested_event, parse_noop_requested_event); called by 1 (parse_realtime_event_v2); 1 external calls (get).


##### `parse_handoff_requested_event`  (lines 142–166)

```
fn parse_handoff_requested_event(item: &JsonMap<String, Value>) -> Option<RealtimeEvent>
```

**Purpose**: Recognizes a completed `background_agent` function call and converts it into `RealtimeEvent::HandoffRequested`. It derives both the handoff identity and a best-effort input transcript from the tool-call payload.

**Data flow**: Consumes an `item` JSON object, checks that `type == "function_call"` and `name == "background_agent"`, then extracts `call_id` from `call_id` or falls back to `id`. It chooses `item_id` from `id` or the call ID, reads `arguments` as a string defaulting to empty, and passes that string to `extract_input_transcript`. It returns `Some(RealtimeEvent::HandoffRequested(RealtimeHandoffRequested { handoff_id, item_id, input_transcript, active_transcript: Vec::new() }))` or `None` if the item is not the expected tool call or lacks an identifier.

**Call relations**: This helper is called only by `parse_conversation_item_done_event` before generic item completion handling. It exists because v2 encodes handoff requests as completed tool calls rather than as a dedicated top-level event.

*Call graph*: calls 1 internal fn (extract_input_transcript); called by 1 (parse_conversation_item_done_event); 3 external calls (get, new, HandoffRequested).


##### `parse_noop_requested_event`  (lines 168–189)

```
fn parse_noop_requested_event(item: &JsonMap<String, Value>) -> Option<RealtimeEvent>
```

**Purpose**: Recognizes a completed `remain_silent` function call and converts it into `RealtimeEvent::NoopRequested`. It treats the tool invocation as a control signal rather than a normal conversation item.

**Data flow**: Accepts an `item` JSON object, verifies `type == "function_call"` and `name == "remain_silent"`, then extracts `call_id` from `call_id` or `id` and derives `item_id` from `id` or the same fallback. It returns `Some(RealtimeEvent::NoopRequested(RealtimeNoopRequested { call_id, item_id }))` when the shape matches, otherwise `None`.

**Call relations**: This helper is invoked by `parse_conversation_item_done_event` after the handoff check and before generic completion fallback. Its placement means silence requests are surfaced as explicit control events whenever the nested item matches the expected tool signature.

*Call graph*: called by 1 (parse_conversation_item_done_event); 2 external calls (get, NoopRequested).


##### `extract_input_transcript`  (lines 191–210)

```
fn extract_input_transcript(arguments: &str) -> String
```

**Purpose**: Pulls a human-meaningful transcript string out of a tool-call `arguments` blob, preferring known JSON keys but falling back to the raw argument text. It is designed to tolerate both structured and unstructured argument payloads.

**Data flow**: Takes `arguments: &str`; if empty, returns an empty `String`. Otherwise it attempts to parse the string as JSON `Value`, requires an object, then scans `TOOL_ARGUMENT_KEYS` in order for a string value whose trimmed contents are non-empty; the first such value is returned trimmed and owned. If parsing fails or no preferred key contains usable text, it returns `arguments.to_string()` unchanged.

**Call relations**: This helper is called only from `parse_handoff_requested_event` to populate `RealtimeHandoffRequested.input_transcript`. It encapsulates the heuristic extraction logic so handoff parsing can stay focused on tool-call identification.

*Call graph*: called by 1 (parse_handoff_requested_event); 1 external calls (new).


### `codex-api/src/endpoint/realtime_websocket/methods.rs`

`io_transport` · `request handling`

This file is the core websocket implementation for realtime sessions. It wraps a `tokio_tungstenite` stream in `WsStream`, which splits command submission from inbound message consumption by spawning a pump task. That task multiplexes outbound `Send`/`Close` commands with inbound websocket frames, auto-responds to pings with pongs, forwards text/close/binary/frame messages through an async channel, and terminates cleanly on errors or closure. `Drop` aborts the pump task so leaked connections do not keep background work alive.

`RealtimeWebsocketConnection` exposes a high-level API composed of a `RealtimeWebsocketWriter` and `RealtimeWebsocketEvents`. The writer serializes `RealtimeOutboundMessage` values to JSON, rejects sends after closure via an `AtomicBool`, and offers typed helpers for audio frames, conversation items, function-call outputs, response creation, and session updates. The events side reads parsed websocket messages, converts text payloads with `parse_realtime_event`, and maintains `ActiveTranscriptState` so handoff events include the transcript accumulated since the previous handoff. Transcript deltas append to the last matching-role entry unless a new turn was forced by speech start, response creation, or handoff boundaries.

`RealtimeWebsocketClient` builds websocket URLs from provider base URLs, normalizes `/v1/realtime` paths, merges provider/extra/default headers with HTTP-like precedence, optionally injects `x-session-id`, configures TLS with custom CA support, connects, then immediately sends `session.update`. It also supports retrying sideband websocket joins for existing WebRTC calls by appending `call_id` to the websocket URL.

#### Function details

##### `WsStream::new`  (lines 67–168)

```
fn new(
        inner: WebSocketStream<MaybeTlsStream<TcpStream>>,
    ) -> (Self, async_channel::Receiver<Result<Message, WsError>>)
```

**Purpose**: Creates the internal websocket pump that decouples outbound commands from inbound frame consumption.

**Data flow**: Takes `inner: WebSocketStream<MaybeTlsStream<TcpStream>>` → creates an mpsc command channel and async-channel message queue → spawns a task that `select!`s between commands and `inner.next()` frames, sending websocket writes directly and forwarding inbound messages/errors to `tx_message` → returns `(WsStream { tx_command, pump_task }, rx_message)`.

**Call relations**: Called when a websocket connection is successfully established in `RealtimeWebsocketClient::connect_realtime_websocket_url`. It is the concurrency boundary that allows `send_*` operations to proceed even while `next_event` is blocked waiting for inbound data.

*Call graph*: called by 2 (connect_realtime_websocket_url, connect_websocket); 3 external calls (info!, select!, spawn).


##### `WsStream::request`  (lines 170–179)

```
async fn request(
        &self,
        make_command: impl FnOnce(oneshot::Sender<Result<(), WsError>>) -> WsCommand,
    ) -> Result<(), WsError>
```

**Purpose**: Submits a websocket command to the pump task and waits for the per-command result.

**Data flow**: Builds a oneshot channel, uses `make_command` to create a `WsCommand`, sends it over `tx_command`, then awaits the oneshot response; if the command channel is closed or the oneshot is dropped, returns `WsError::ConnectionClosed`.

**Call relations**: Shared helper used by `WsStream::send` and `WsStream::close` so both operations follow the same command/acknowledgement path through the pump task.

*Call graph*: called by 2 (close, send); 2 external calls (send, channel).


##### `WsStream::send`  (lines 181–184)

```
async fn send(&self, message: Message) -> Result<(), WsError>
```

**Purpose**: Requests that the pump task send one websocket message.

**Data flow**: Takes `message: Message` → wraps it in `WsCommand::Send` via `request` → returns `Result<(), WsError>` from the pump task’s actual send attempt.

**Call relations**: Used by `RealtimeWebsocketWriter::send_payload` to serialize all outbound websocket traffic through the single pump task.

*Call graph*: calls 1 internal fn (request); called by 1 (send_websocket_request).


##### `WsStream::close`  (lines 186–189)

```
async fn close(&self) -> Result<(), WsError>
```

**Purpose**: Requests that the pump task send a websocket close frame and terminate.

**Data flow**: Creates a `WsCommand::Close` through `request` and returns the resulting `Result<(), WsError>`.

**Call relations**: Called by `RealtimeWebsocketWriter::close` during explicit connection shutdown.

*Call graph*: calls 1 internal fn (request).


##### `WsStream::drop`  (lines 193–195)

```
fn drop(&mut self)
```

**Purpose**: Ensures the background pump task is aborted if the wrapper is dropped unexpectedly.

**Data flow**: Mutably borrows `self` and calls `self.pump_task.abort()`; no return value.

**Call relations**: Runs automatically when the last `WsStream` owner is dropped, preventing orphaned background tasks.

*Call graph*: 1 external calls (abort).


##### `RealtimeWebsocketConnection::send_audio_frame`  (lines 227–229)

```
async fn send_audio_frame(&self, frame: RealtimeAudioFrame) -> Result<(), ApiError>
```

**Purpose**: Convenience wrapper that forwards an audio frame to the writer half.

**Data flow**: Takes `frame: RealtimeAudioFrame` and delegates to `self.writer.send_audio_frame(frame)` → returns `Result<(), ApiError>`.

**Call relations**: Used by higher-level realtime flows and tests; it keeps callers from needing to access the writer directly.

*Call graph*: calls 1 internal fn (send_audio_frame).


##### `RealtimeWebsocketConnection::send_conversation_item_create`  (lines 231–237)

```
async fn send_conversation_item_create(
        &self,
        text: String,
        role: ConversationTextRole,
    ) -> Result<(), ApiError>
```

**Purpose**: Convenience wrapper for sending a text conversation item with a specific role.

**Data flow**: Takes `text: String` and `role: ConversationTextRole` → delegates to `self.writer.send_conversation_item_create(text, role)`.

**Call relations**: Part of the public connection API, forwarding to the writer’s typed message construction.

*Call graph*: calls 1 internal fn (send_conversation_item_create).


##### `RealtimeWebsocketConnection::send_conversation_function_call_output`  (lines 239–247)

```
async fn send_conversation_function_call_output(
        &self,
        call_id: String,
        output_text: String,
    ) -> Result<(), ApiError>
```

**Purpose**: Convenience wrapper for sending function-call or handoff output back to the realtime server.

**Data flow**: Takes `call_id` and `output_text` strings → delegates to `self.writer.send_conversation_function_call_output(...)`.

**Call relations**: Used by higher-level handoff handling and tests; it hides parser-version-specific message differences behind the writer.

*Call graph*: calls 1 internal fn (send_conversation_function_call_output).


##### `RealtimeWebsocketConnection::close`  (lines 249–251)

```
async fn close(&self) -> Result<(), ApiError>
```

**Purpose**: Closes the websocket connection through the writer half.

**Data flow**: Delegates to `self.writer.close().await` and returns its `ApiError`-wrapped result.

**Call relations**: Public shutdown entrypoint for callers holding a full connection.

*Call graph*: calls 1 internal fn (close).


##### `RealtimeWebsocketConnection::next_event`  (lines 253–255)

```
async fn next_event(&self) -> Result<Option<RealtimeEvent>, ApiError>
```

**Purpose**: Retrieves the next parsed realtime event from the events half.

**Data flow**: Delegates to `self.events.next_event().await` → returns `Result<Option<RealtimeEvent>, ApiError>`.

**Call relations**: Public receive-side entrypoint used by callers and tests to consume the event stream.

*Call graph*: calls 1 internal fn (next_event).


##### `RealtimeWebsocketConnection::writer`  (lines 257–259)

```
fn writer(&self) -> RealtimeWebsocketWriter
```

**Purpose**: Returns a clone of the writer half for independent outbound use.

**Data flow**: Clones `self.writer` and returns it.

**Call relations**: Lets callers split send and receive responsibilities across tasks while sharing the same underlying websocket state.

*Call graph*: 1 external calls (clone).


##### `RealtimeWebsocketConnection::events`  (lines 261–263)

```
fn events(&self) -> RealtimeWebsocketEvents
```

**Purpose**: Returns a clone of the events half for independent inbound use.

**Data flow**: Clones `self.events` and returns it.

**Call relations**: Complements `writer()` for split-task usage patterns.

*Call graph*: 1 external calls (clone).


##### `RealtimeWebsocketConnection::new`  (lines 265–285)

```
fn new(
        stream: WsStream,
        rx_message: async_channel::Receiver<Result<Message, WsError>>,
        event_parser: RealtimeEventParser,
    ) -> Self
```

**Purpose**: Builds the paired writer/events façade around a newly created `WsStream` and inbound message receiver.

**Data flow**: Takes `stream`, `rx_message`, and `event_parser` → wraps `stream` in `Arc`, creates shared `AtomicBool` closed state and `ActiveTranscriptState` mutex, then returns `RealtimeWebsocketConnection { writer, events }` sharing those internals.

**Call relations**: Called only after a websocket handshake succeeds in `RealtimeWebsocketClient::connect_realtime_websocket_url`.

*Call graph*: called by 1 (connect_realtime_websocket_url); 5 external calls (clone, new, new, new, default).


##### `RealtimeWebsocketWriter::send_audio_frame`  (lines 289–292)

```
async fn send_audio_frame(&self, frame: RealtimeAudioFrame) -> Result<(), ApiError>
```

**Purpose**: Encodes an audio frame as `input_audio_buffer.append` and sends it.

**Data flow**: Reads `frame.data` from `RealtimeAudioFrame` → constructs `RealtimeOutboundMessage::InputAudioBufferAppend { audio }` → passes it to `send_json`.

**Call relations**: Used by the connection wrapper and higher-level audio input flows.

*Call graph*: calls 1 internal fn (send_json); called by 2 (send_audio_frame, handle_user_audio_input).


##### `RealtimeWebsocketWriter::send_conversation_item_create`  (lines 294–305)

```
async fn send_conversation_item_create(
        &self,
        text: String,
        role: ConversationTextRole,
    ) -> Result<(), ApiError>
```

**Purpose**: Builds the parser-version-appropriate conversation item creation message and sends it.

**Data flow**: Takes `text` and `role`, reads `self.event_parser`, constructs a `RealtimeOutboundMessage` via `conversation_item_create_message`, then serializes and sends it with `send_json`.

**Call relations**: Called by the connection wrapper and higher-level text/handoff flows; it delegates version-specific payload shape to `methods_common`.

*Call graph*: calls 2 internal fn (send_json, conversation_item_create_message); called by 3 (send_conversation_item_create, handle_handoff_output, handle_text_input).


##### `RealtimeWebsocketWriter::send_conversation_handoff_append`  (lines 307–317)

```
async fn send_conversation_handoff_append(
        &self,
        handoff_id: String,
        output_text: String,
    ) -> Result<(), ApiError>
```

**Purpose**: Sends a legacy `conversation.handoff.append` message with a handoff ID and output text.

**Data flow**: Takes `handoff_id` and `output_text` → wraps them in `RealtimeOutboundMessage::ConversationHandoffAppend` → sends via `send_json`.

**Call relations**: Used by higher-level handoff output handling where the legacy v1 wire shape is needed explicitly.

*Call graph*: calls 1 internal fn (send_json); called by 1 (handle_handoff_output).


##### `RealtimeWebsocketWriter::send_conversation_function_call_output`  (lines 319–330)

```
async fn send_conversation_function_call_output(
        &self,
        call_id: String,
        output_text: String,
    ) -> Result<(), ApiError>
```

**Purpose**: Sends function-call output using the correct wire shape for the active realtime protocol version.

**Data flow**: Takes `call_id` and `output_text`, reads `self.event_parser`, builds a message through `conversation_function_call_output_message`, then serializes and sends it.

**Call relations**: Used by the connection wrapper and higher-level handoff/server-event handlers; it centralizes the v1-vs-v2 output message difference.

*Call graph*: calls 2 internal fn (send_json, conversation_function_call_output_message); called by 3 (send_conversation_function_call_output, handle_handoff_output, handle_realtime_server_event).


##### `RealtimeWebsocketWriter::send_response_create`  (lines 332–335)

```
async fn send_response_create(&self) -> Result<(), ApiError>
```

**Purpose**: Sends a `response.create` command to ask the server to generate a response immediately.

**Data flow**: Constructs `RealtimeOutboundMessage::ResponseCreate` and forwards it to `send_json`.

**Call relations**: Used by higher-level orchestration when an explicit response trigger is needed.

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

**Purpose**: Builds and sends the initial or updated realtime session configuration.

**Data flow**: Takes `instructions`, `session_mode`, `output_modality`, and `voice` → normalizes session mode for parser compatibility, builds `SessionUpdateSession` via `session_update_session`, wraps it in `RealtimeOutboundMessage::SessionUpdate`, and sends it with `send_json`.

**Call relations**: Called immediately after websocket connection establishment in `RealtimeWebsocketClient::connect_realtime_websocket_url`.

*Call graph*: calls 3 internal fn (send_json, normalized_session_mode, session_update_session).


##### `RealtimeWebsocketWriter::close`  (lines 356–368)

```
async fn close(&self) -> Result<(), ApiError>
```

**Purpose**: Idempotently closes the websocket and suppresses benign already-closed conditions.

**Data flow**: Checks and sets `is_closed` with `swap(true, Ordering::SeqCst)`; if already closed returns `Ok(())`. Otherwise awaits `self.stream.close()`, converts non-benign websocket close errors into `ApiError::Stream`, and returns success for `ConnectionClosed`/`AlreadyClosed`.

**Call relations**: Invoked by `RealtimeWebsocketConnection::close`. It is the authoritative place where closed-state is latched for both send and receive halves.

*Call graph*: called by 1 (close); 3 external calls (Stream, format!, matches!).


##### `RealtimeWebsocketWriter::send_json`  (lines 370–375)

```
async fn send_json(&self, message: &RealtimeOutboundMessage) -> Result<(), ApiError>
```

**Purpose**: Serializes a typed outbound realtime message to JSON and forwards the raw payload.

**Data flow**: Takes `message: &RealtimeOutboundMessage` → serializes with `serde_json::to_string`, mapping failures to `ApiError::Stream` → logs the structured message → calls `send_payload(payload)`.

**Call relations**: Shared helper behind all typed writer methods so serialization and logging behavior stay consistent.

*Call graph*: calls 1 internal fn (send_payload); called by 6 (send_audio_frame, send_conversation_function_call_output, send_conversation_handoff_append, send_conversation_item_create, send_response_create, send_session_update); 2 external calls (debug!, to_string).


##### `RealtimeWebsocketWriter::send_payload`  (lines 377–390)

```
async fn send_payload(&self, payload: String) -> Result<(), ApiError>
```

**Purpose**: Sends a raw JSON text payload over the websocket unless the connection has already been marked closed.

**Data flow**: Takes `payload: String`, reads `is_closed`; if closed returns `ApiError::Stream("realtime websocket connection is closed")`. Otherwise logs the wire payload, sends `Message::Text(payload.into())` through `WsStream::send`, maps websocket errors into `ApiError::Stream`, and returns `Ok(())`.

**Call relations**: Called by `send_json` and by higher-level code that already has a raw payload string.

*Call graph*: called by 2 (send_json, handle_realtime_server_event); 3 external calls (Stream, trace!, Text).


##### `RealtimeWebsocketEvents::next_event`  (lines 394–443)

```
async fn next_event(&self) -> Result<Option<RealtimeEvent>, ApiError>
```

**Purpose**: Consumes inbound websocket messages until it can return one parsed realtime event, EOF, or an error.

**Data flow**: Reads shared `is_closed`; if already closed returns `Ok(None)`. Otherwise loops on `rx_message.recv()`: transport errors mark closed and become `ApiError::Stream`; channel closure marks closed and returns `Ok(None)`. For `Message::Text`, it logs the payload, parses it with `parse_realtime_event`, updates transcript state if parsing succeeds, and returns the event; unsupported text frames are ignored. `Message::Close` marks closed and returns `Ok(None)`. `Message::Binary` is converted into `RealtimeEvent::Error("unexpected binary realtime websocket event")`. Ping/pong/frame messages are ignored.

**Call relations**: Called by `RealtimeWebsocketConnection::next_event`. It is the receive-side loop that bridges raw websocket frames into typed domain events.

*Call graph*: calls 3 internal fn (update_active_transcript, parse_realtime_event, recv); called by 1 (next_event); 7 external calls (Stream, debug!, error!, format!, info!, Error, trace!).


##### `RealtimeWebsocketEvents::update_active_transcript`  (lines 445–507)

```
async fn update_active_transcript(&self, event: &mut RealtimeEvent)
```

**Purpose**: Maintains rolling transcript state so handoff events can include the active transcript slice accumulated since the previous handoff.

**Data flow**: Locks `active_transcript` and mutates its flags and `entries` based on the incoming `RealtimeEvent`: speech-start marks the next user delta as a new entry; transcript deltas append or create entries by role; transcript done events replace or create final text; handoff requests append missing user input, copy the transcript slice since `last_handoff_entry_count` into `handoff.active_transcript`, advance the handoff boundary, and force new entries for subsequent turns; response creation forces a new assistant entry. Other event variants leave transcript state unchanged.

**Call relations**: Called only from `RealtimeWebsocketEvents::next_event` after a text payload has been parsed successfully.

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

**Purpose**: Appends incremental transcript text to the last matching-role entry or starts a new entry when required.

**Data flow**: Takes mutable `entries`, `role`, `delta`, and `force_new` → ignores empty deltas; if not forced and the last entry has the same role, appends `delta` to `last_entry.text`; otherwise pushes a new `RealtimeTranscriptEntry { role, text: delta }`.

**Call relations**: Used by `update_active_transcript` for both input and output transcript delta events.

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

**Purpose**: Applies a finalized transcript string by replacing the last matching-role entry or creating a new one.

**Data flow**: Takes mutable `entries`, `role`, `text`, and `force_new` → ignores empty text; if not forced and the last entry has the same role, overwrites `last_entry.text`; otherwise pushes a new `RealtimeTranscriptEntry` with the full text.

**Call relations**: Used by `update_active_transcript` for transcript completion events.

*Call graph*: called by 1 (update_active_transcript).


##### `append_handoff_input`  (lines 558–568)

```
fn append_handoff_input(entries: &mut Vec<RealtimeTranscriptEntry>, input: &str)
```

**Purpose**: Adds the handoff input transcript as a user entry unless it is blank or already present.

**Data flow**: Trims `input`, checks emptiness and duplicate presence via `contains_transcript_entry`, and if neither condition holds pushes a new user `RealtimeTranscriptEntry`.

**Call relations**: Called from `update_active_transcript` when processing `RealtimeEvent::HandoffRequested`.

*Call graph*: calls 1 internal fn (contains_transcript_entry); called by 1 (update_active_transcript).


##### `contains_transcript_entry`  (lines 570–574)

```
fn contains_transcript_entry(entries: &[RealtimeTranscriptEntry], role: &str, text: &str) -> bool
```

**Purpose**: Checks whether the transcript already contains an entry with the same role and trimmed text.

**Data flow**: Iterates over `entries` and returns `true` if any entry’s `role` matches and `entry.text.trim() == text.trim()`.

**Call relations**: Used only by `append_handoff_input` to avoid duplicating user transcript entries around handoff boundaries.

*Call graph*: called by 1 (append_handoff_input); 1 external calls (iter).


##### `RealtimeWebsocketClient::new`  (lines 581–583)

```
fn new(provider: Provider) -> Self
```

**Purpose**: Constructs a websocket client bound to a specific provider configuration.

**Data flow**: Consumes `provider: Provider` and returns `RealtimeWebsocketClient { provider }`.

**Call relations**: Used by tests and higher-level realtime orchestration before connecting.

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

**Purpose**: Builds the standard realtime websocket URL from the provider base URL and session config, then connects and sends the initial session update.

**Data flow**: Reads `config`, `extra_headers`, and `default_headers` plus `self.provider.base_url/query_params` → computes `ws_url` with `websocket_url_from_api_url(...)` → delegates to `connect_realtime_websocket_url(ws_url, config, extra_headers, default_headers)`.

**Call relations**: Primary connection entrypoint for standalone realtime websocket sessions.

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

**Purpose**: Retries joining the websocket sideband for an already-created WebRTC call until success or retry exhaustion.

**Data flow**: Takes `config`, `call_id`, `extra_headers`, and `default_headers` → loops from attempt 0 through `provider.retry.max_attempts`, cloning inputs each time and calling `connect_webrtc_sideband_once` → on retryable failure computes delay with `backoff`, logs a warning, sleeps, and retries; on success returns the connection; after the loop returns a stream error if somehow exhausted.

**Call relations**: Used when the HTTP realtime call already exists and only the sideband control websocket needs to be joined. It delegates one-shot connection logic to `connect_webrtc_sideband_once`.

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

**Purpose**: Builds a websocket URL that joins an existing realtime call by `call_id` and performs one connection attempt.

**Data flow**: Reads provider base URL and query params plus `config.event_parser/session_mode` and `call_id` → computes `ws_url` with `websocket_url_from_api_url_for_call` → delegates to `connect_realtime_websocket_url`.

**Call relations**: Called by the retry loop in `connect_webrtc_sideband`.

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

**Purpose**: Performs the actual websocket handshake, header preparation, TLS setup, stream wrapping, and initial `session.update` send.

**Data flow**: Takes a concrete `ws_url`, `config`, `extra_headers`, and `default_headers` → ensures rustls provider is installed, converts the URL into a client request, merges provider headers with `extra_headers` plus optional `x-session-id` and `default_headers`, configures TLS connector with optional custom CA support, calls `connect_async_tls_with_config`, wraps the resulting stream with `WsStream::new`, builds a `RealtimeWebsocketConnection`, then sends `writer.send_session_update(config.instructions, config.session_mode, config.output_modality, config.voice)` before returning the connection.

**Call relations**: Shared implementation used by both `connect` and `connect_webrtc_sideband_once`. It is the point where URL construction, header precedence, TLS policy, and initial session bootstrap come together.

*Call graph*: calls 5 internal fn (new, new, merge_request_headers, websocket_config, with_session_id_header); called by 2 (connect, connect_webrtc_sideband_once); 6 external calls (as_str, maybe_build_rustls_client_config_with_custom_ca, ensure_rustls_crypto_provider, debug!, info!, connect_async_tls_with_config).


##### `merge_request_headers`  (lines 721–734)

```
fn merge_request_headers(
    provider_headers: &HeaderMap,
    extra_headers: HeaderMap,
    default_headers: HeaderMap,
) -> HeaderMap
```

**Purpose**: Combines provider, extra, and default headers using precedence that mirrors normal HTTP request layering.

**Data flow**: Clones `provider_headers` into a new map, extends it with `extra_headers` so extras override provider values, then inserts each `default_headers` entry only if that header name is still vacant → returns the merged `HeaderMap`.

**Call relations**: Used during websocket connection setup and directly unit-tested for precedence behavior.

*Call graph*: called by 2 (connect_realtime_websocket_url, merge_request_headers_matches_http_precedence); 1 external calls (clone).


##### `with_session_id_header`  (lines 736–750)

```
fn with_session_id_header(
    mut headers: HeaderMap,
    session_id: Option<&str>,
) -> Result<HeaderMap, ApiError>
```

**Purpose**: Adds `x-session-id` to a header map when a session ID is present, validating it as an HTTP header value.

**Data flow**: Takes mutable `headers` and `session_id: Option<&str>` → if absent returns headers unchanged; if present inserts `x-session-id` using `HeaderValue::from_str`, mapping invalid values to `ApiError::Stream` → returns the updated map.

**Call relations**: Called by `connect_realtime_websocket_url` before header merging so session IDs are transmitted during websocket handshake.

*Call graph*: called by 1 (connect_realtime_websocket_url); 2 external calls (insert, from_str).


##### `websocket_config`  (lines 752–754)

```
fn websocket_config() -> WebSocketConfig
```

**Purpose**: Supplies the websocket configuration used for all realtime connections.

**Data flow**: Returns `WebSocketConfig::default()`.

**Call relations**: Used only by `connect_realtime_websocket_url` when invoking `connect_async_tls_with_config`.

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

**Purpose**: Transforms a provider API base URL into the correct realtime websocket URL, normalizing scheme, path, intent, model, and extra query parameters.

**Data flow**: Parses `api_url` into `Url`, normalizes its path with `normalize_realtime_path`, rewrites `http/https` to `ws/wss`, rejects unsupported schemes, computes optional intent via `websocket_intent(event_parser)`, and appends `intent`, `model`, and provider `query_params` while skipping duplicate `intent` and duplicate `model` when an explicit model argument is present → returns the final `Url` or `ApiError::Stream`.

**Call relations**: Used by `RealtimeWebsocketClient::connect` and extensively unit-tested for path/query shaping across v1 and v2 modes.

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

**Purpose**: Builds a realtime websocket URL that joins an existing call by appending `call_id` to the standard realtime URL.

**Data flow**: Calls `websocket_url_from_api_url` with `model` forced to `None`, then appends `call_id` as a query pair and returns the resulting `Url`.

**Call relations**: Used by `connect_webrtc_sideband_once` and unit-tested for sideband join URL formation.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); called by 2 (connect_webrtc_sideband_once, websocket_url_for_call_id_joins_existing_realtime_session).


##### `normalize_realtime_path`  (lines 826–850)

```
fn normalize_realtime_path(url: &mut Url)
```

**Purpose**: Normalizes provider base paths so realtime websocket URLs consistently target `/v1/realtime` or an equivalent nested path.

**Data flow**: Reads `url.path()` and mutates the URL path according to cases: empty or `/` becomes `/v1/realtime`; paths already ending in `/realtime` are preserved; `/realtime/` loses the trailing slash; paths ending in `/v1` or `/v1/` gain `/realtime`.

**Call relations**: Called only by `websocket_url_from_api_url` as the path-normalization step before scheme and query handling.

*Call graph*: called by 1 (websocket_url_from_api_url); 3 external calls (path, set_path, format!).


##### `tests::parse_session_updated_event`  (lines 876–890)

```
fn parse_session_updated_event()
```

**Purpose**: Verifies that a `session.updated` payload is parsed into `RealtimeEvent::SessionUpdated` for v1.

**Data flow**: Builds a JSON payload string, calls `parse_realtime_event(..., RealtimeEventParser::V1)`, and asserts the exact event value.

**Call relations**: Unit-tests the receive-side parser path used by `RealtimeWebsocketEvents::next_event`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_audio_delta_event`  (lines 893–912)

```
fn parse_audio_delta_event()
```

**Purpose**: Checks parsing of v1 output audio delta events into `RealtimeAudioFrame`.

**Data flow**: Creates a JSON payload with audio metadata, parses it, and asserts the resulting `RealtimeEvent::AudioOut` fields.

**Call relations**: Covers one of the event variants consumed by `next_event`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_conversation_item_added_event`  (lines 915–927)

```
fn parse_conversation_item_added_event()
```

**Purpose**: Verifies parsing of `conversation.item.added` into `RealtimeEvent::ConversationItemAdded`.

**Data flow**: Constructs the payload, parses it with the v1 parser, and compares the resulting JSON item payload.

**Call relations**: Exercises parser support for conversation item creation notifications.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_conversation_item_done_event`  (lines 930–942)

```
fn parse_conversation_item_done_event()
```

**Purpose**: Checks parsing of `conversation.item.done` into a done event carrying the item ID.

**Data flow**: Builds a payload with an item object, parses it, and asserts `RealtimeEvent::ConversationItemDone { item_id }`.

**Call relations**: Covers one of the terminal item events that `next_event` can emit.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_handoff_requested_event`  (lines 945–963)

```
fn parse_handoff_requested_event()
```

**Purpose**: Verifies parsing of a v1 handoff request event before transcript enrichment.

**Data flow**: Creates a handoff JSON payload, parses it, and asserts the resulting `RealtimeEvent::HandoffRequested` with empty `active_transcript`.

**Call relations**: Tests the raw parser output that `update_active_transcript` later augments.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_input_transcript_delta_event`  (lines 966–981)

```
fn parse_input_transcript_delta_event()
```

**Purpose**: Checks parsing of v1 input transcript delta events.

**Data flow**: Builds a payload with `delta`, parses it, and asserts `RealtimeEvent::InputTranscriptDelta`.

**Call relations**: Covers one of the transcript events that drive active transcript accumulation.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_input_audio_transcription_delta_event`  (lines 984–1001)

```
fn parse_v1_input_audio_transcription_delta_event()
```

**Purpose**: Verifies that the alternate v1 input-audio transcription delta shape maps to the same input transcript delta event.

**Data flow**: Creates the alternate payload, parses it, and asserts the normalized event.

**Call relations**: Ensures parser compatibility with multiple server event spellings.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_input_audio_transcription_completed_event`  (lines 1004–1019)

```
fn parse_v1_input_audio_transcription_completed_event()
```

**Purpose**: Checks parsing of completed input-audio transcription into `InputTranscriptDone`.

**Data flow**: Builds the payload with `transcript`, parses it, and asserts the done event.

**Call relations**: Covers transcript-finalization behavior later consumed by transcript state updates.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_input_transcript_turn_marked_event`  (lines 1022–1035)

```
fn parse_v1_input_transcript_turn_marked_event()
```

**Purpose**: Verifies that v1 turn-marked input transcript events are normalized into `InputTranscriptDone`.

**Data flow**: Creates the payload, parses it, and asserts the normalized done event.

**Call relations**: Tests another alternate server event shape handled by the parser.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_output_transcript_delta_event`  (lines 1038–1053)

```
fn parse_output_transcript_delta_event()
```

**Purpose**: Checks parsing of v1 output transcript deltas.

**Data flow**: Builds a payload with output `delta`, parses it, and asserts `RealtimeEvent::OutputTranscriptDelta`.

**Call relations**: Covers assistant transcript accumulation input for `update_active_transcript`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_output_audio_transcript_delta_event`  (lines 1056–1071)

```
fn parse_v1_output_audio_transcript_delta_event()
```

**Purpose**: Verifies that v1 output-audio transcript delta events normalize to output transcript deltas.

**Data flow**: Creates the payload, parses it, and asserts the normalized event.

**Call relations**: Ensures parser compatibility with alternate output transcript event names.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_output_audio_transcript_done_event`  (lines 1074–1089)

```
fn parse_v1_output_audio_transcript_done_event()
```

**Purpose**: Checks parsing of v1 output-audio transcript completion events.

**Data flow**: Builds the payload with `transcript`, parses it, and asserts `OutputTranscriptDone`.

**Call relations**: Covers assistant transcript finalization.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_v1_item_done_output_text_event`  (lines 1092–1113)

```
fn parse_v1_item_done_output_text_event()
```

**Purpose**: Verifies that a v1 assistant message item completion is recognized as `ConversationItemDone`.

**Data flow**: Creates a payload whose item content contains multiple `output_text` fragments, parses it, and asserts the done event with the item ID.

**Call relations**: Tests parser handling of completed assistant message items.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_handoff_tool_call_event`  (lines 1116–1138)

```
fn parse_realtime_v2_handoff_tool_call_event()
```

**Purpose**: Checks that a v2 function-call item for `background_agent` is interpreted as a handoff request.

**Data flow**: Builds a v2 `conversation.item.done` payload with tool-call arguments, parses it with `RealtimeEventParser::RealtimeV2`, and asserts `HandoffRequested`.

**Call relations**: Covers v2-specific parser semantics used by `next_event`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_noop_tool_call_event`  (lines 1141–1161)

```
fn parse_realtime_v2_noop_tool_call_event()
```

**Purpose**: Verifies that the v2 `remain_silent` tool call becomes `RealtimeEvent::NoopRequested`.

**Data flow**: Creates the payload, parses it with the v2 parser, and asserts the noop event.

**Call relations**: Tests another v2-specific tool-call interpretation.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_input_audio_transcription_delta_event`  (lines 1164–1181)

```
fn parse_realtime_v2_input_audio_transcription_delta_event()
```

**Purpose**: Checks parsing of v2 input-audio transcription deltas.

**Data flow**: Builds the payload, parses it, and asserts `InputTranscriptDelta`.

**Call relations**: Covers transcript accumulation input for v2 sessions.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_output_audio_transcript_done_event`  (lines 1184–1199)

```
fn parse_realtime_v2_output_audio_transcript_done_event()
```

**Purpose**: Verifies parsing of v2 output-audio transcript completion events.

**Data flow**: Creates the payload, parses it, and asserts `OutputTranscriptDone`.

**Call relations**: Tests one of the v2 transcript completion variants.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_output_text_done_event`  (lines 1202–1217)

```
fn parse_realtime_v2_output_text_done_event()
```

**Purpose**: Checks that v2 `response.output_text.done` is normalized into `OutputTranscriptDone`.

**Data flow**: Builds the payload, parses it, and asserts the normalized event.

**Call relations**: Ensures the parser treats text-only completion as transcript completion.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_conversation_item_created_event`  (lines 1220–1233)

```
fn parse_realtime_v2_conversation_item_created_event()
```

**Purpose**: Verifies parsing of v2 `conversation.item.created` into `ConversationItemAdded`.

**Data flow**: Creates the payload, parses it, and asserts the resulting JSON item payload.

**Call relations**: Covers v2 item-added notifications.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_item_done_output_text_event`  (lines 1236–1257)

```
fn parse_realtime_v2_item_done_output_text_event()
```

**Purpose**: Checks that a completed v2 assistant message item is recognized as `ConversationItemDone`.

**Data flow**: Builds the payload with assistant output text content, parses it, and asserts the done event.

**Call relations**: Tests v2 item completion parsing.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_output_audio_delta_defaults_audio_shape`  (lines 1260–1277)

```
fn parse_realtime_v2_output_audio_delta_defaults_audio_shape()
```

**Purpose**: Verifies that v2 output audio deltas default missing audio shape fields to 24 kHz mono with unknown sample count.

**Data flow**: Creates a minimal payload, parses it, and asserts the defaulted `RealtimeAudioFrame` fields.

**Call relations**: Covers parser defaulting behavior for sparse v2 audio events.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_audio_delta_with_item_id`  (lines 1280–1298)

```
fn parse_realtime_v2_response_audio_delta_with_item_id()
```

**Purpose**: Checks parsing of the alternate v2 `response.audio.delta` event including `item_id`.

**Data flow**: Builds the payload, parses it, and asserts the resulting `AudioOut` frame with `item_id` populated.

**Call relations**: Tests another accepted v2 audio event spelling.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_speech_started_event`  (lines 1301–1316)

```
fn parse_realtime_v2_speech_started_event()
```

**Purpose**: Verifies parsing of v2 speech-start notifications.

**Data flow**: Creates the payload, parses it, and asserts `RealtimeEvent::InputAudioSpeechStarted`.

**Call relations**: Covers the event that flips `new_input_entry` in transcript state.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_cancelled_event`  (lines 1319–1334)

```
fn parse_realtime_v2_response_cancelled_event()
```

**Purpose**: Checks parsing of v2 response cancellation events.

**Data flow**: Builds the payload, parses it, and asserts `RealtimeEvent::ResponseCancelled`.

**Call relations**: Tests one of the non-transcript control events emitted by `next_event`.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_done_event`  (lines 1337–1358)

```
fn parse_realtime_v2_response_done_event()
```

**Purpose**: Verifies parsing of v2 response completion events.

**Data flow**: Creates a payload with response output, parses it, and asserts `RealtimeEvent::ResponseDone`.

**Call relations**: Covers another control event variant.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::parse_realtime_v2_response_created_event`  (lines 1361–1374)

```
fn parse_realtime_v2_response_created_event()
```

**Purpose**: Checks parsing of v2 response creation events.

**Data flow**: Builds the payload, parses it, and asserts `RealtimeEvent::ResponseCreated`.

**Call relations**: Tests the event that causes transcript state to force a new assistant entry.

*Call graph*: 2 external calls (assert_eq!, json!).


##### `tests::merge_request_headers_matches_http_precedence`  (lines 1377–1407)

```
fn merge_request_headers_matches_http_precedence()
```

**Purpose**: Verifies that provider headers win over defaults, extra headers win over provider headers, and defaults fill only missing names.

**Data flow**: Constructs three header maps, calls `merge_request_headers`, and asserts the resulting values for overlapping and default-only headers.

**Call relations**: Directly unit-tests the header-merging helper used during websocket connection setup.

*Call graph*: calls 1 internal fn (merge_request_headers); 3 external calls (new, from_static, assert_eq!).


##### `tests::websocket_url_from_http_base_defaults_to_ws_path`  (lines 1410–1423)

```
fn websocket_url_from_http_base_defaults_to_ws_path()
```

**Purpose**: Checks that an HTTP base URL is converted to `ws://.../v1/realtime` with the v1 intent query.

**Data flow**: Calls `websocket_url_from_api_url` with an HTTP base and asserts the resulting URL string.

**Call relations**: Tests URL normalization logic used by `RealtimeWebsocketClient::connect`.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_from_ws_base_defaults_to_ws_path`  (lines 1426–1439)

```
fn websocket_url_from_ws_base_defaults_to_ws_path()
```

**Purpose**: Verifies that an existing websocket base URL keeps its scheme and gains the realtime path plus model query.

**Data flow**: Calls `websocket_url_from_api_url` with a `wss://` base and asserts the final URL.

**Call relations**: Covers scheme-preservation behavior in URL construction.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_from_v1_base_appends_realtime_path`  (lines 1442–1455)

```
fn websocket_url_from_v1_base_appends_realtime_path()
```

**Purpose**: Checks that a `/v1` API base gets `/realtime` appended.

**Data flow**: Builds the URL from `https://api.openai.com/v1` and asserts the expected `wss://.../v1/realtime?...` string.

**Call relations**: Tests one branch of `normalize_realtime_path`.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_from_nested_v1_base_appends_realtime_path`  (lines 1458–1471)

```
fn websocket_url_from_nested_v1_base_appends_realtime_path()
```

**Purpose**: Verifies path normalization for nested `/openai/v1` style bases.

**Data flow**: Calls `websocket_url_from_api_url` with a nested path and asserts the resulting URL.

**Call relations**: Covers another `normalize_realtime_path` branch.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_preserves_existing_realtime_path_and_extra_query_params`  (lines 1474–1490)

```
fn websocket_url_preserves_existing_realtime_path_and_extra_query_params()
```

**Purpose**: Checks that an existing realtime path and existing query string are preserved while intent/model/provider query params are appended appropriately.

**Data flow**: Calls `websocket_url_from_api_url` with a URL already containing `?foo=bar` and provider query params, then asserts the final URL string.

**Call relations**: Tests query-merging behavior in URL construction.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 2 external calls (from, assert_eq!).


##### `tests::websocket_url_v1_ignores_transcription_mode`  (lines 1493–1506)

```
fn websocket_url_v1_ignores_transcription_mode()
```

**Purpose**: Verifies that v1 URL shaping ignores transcription mode and still uses the quicksilver intent.

**Data flow**: Builds a URL with parser `V1` and session mode `Transcription`, then asserts the same URL shape as conversational mode.

**Call relations**: Reflects the v1 compatibility rule encoded by `websocket_intent` and session-mode normalization.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_omits_intent_for_realtime_v2_conversational_mode`  (lines 1509–1525)

```
fn websocket_url_omits_intent_for_realtime_v2_conversational_mode()
```

**Purpose**: Checks that v2 conversational URLs omit the legacy `intent` query parameter.

**Data flow**: Calls `websocket_url_from_api_url` with parser `RealtimeV2`, existing query params, and a model, then asserts the final URL lacks `intent`.

**Call relations**: Tests the v2 branch of `websocket_intent` handling.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 2 external calls (from, assert_eq!).


##### `tests::websocket_url_omits_intent_for_realtime_v2_transcription_mode`  (lines 1528–1538)

```
fn websocket_url_omits_intent_for_realtime_v2_transcription_mode()
```

**Purpose**: Verifies that v2 transcription URLs omit both intent and model when none is supplied.

**Data flow**: Builds the URL and asserts the bare `wss://.../v1/realtime` result.

**Call relations**: Covers the minimal v2 URL case.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url); 1 external calls (assert_eq!).


##### `tests::websocket_url_for_call_id_joins_existing_realtime_session`  (lines 1541–1554)

```
fn websocket_url_for_call_id_joins_existing_realtime_session()
```

**Purpose**: Checks that sideband websocket URLs append `call_id` to join an existing realtime call.

**Data flow**: Calls `websocket_url_from_api_url_for_call` and asserts the resulting URL string.

**Call relations**: Tests the helper used by `connect_webrtc_sideband_once`.

*Call graph*: calls 1 internal fn (websocket_url_from_api_url_for_call); 1 external calls (assert_eq!).


##### `tests::e2e_connect_and_exchange_events_against_mock_ws_server`  (lines 1557–1855)

```
async fn e2e_connect_and_exchange_events_against_mock_ws_server()
```

**Purpose**: End-to-end test that validates websocket connection setup, initial `session.update`, outbound message sending, inbound event parsing, transcript accumulation, handoff transcript slicing, and clean close against a mock server.

**Data flow**: Starts a local websocket server, accepts a connection, inspects the first four client messages, sends several event payloads back, then the client connects, consumes events via `next_event`, sends audio/text/handoff output, asserts parsed events including enriched `active_transcript`, and closes.

**Call relations**: Exercises the full stack from `RealtimeWebsocketClient::connect` through `WsStream`, writer methods, parser dispatch, and transcript-state maintenance.

*Call graph*: calls 1 internal fn (new); 12 external calls (from_millis, from_secs, new, new, bind, assert_eq!, format!, json!, from_str, spawn (+2 more)).


##### `tests::realtime_v2_session_update_includes_background_agent_tool_and_handoff_output_item`  (lines 1858–2067)

```
async fn realtime_v2_session_update_includes_background_agent_tool_and_handoff_output_item()
```

**Purpose**: End-to-end test that verifies v2 session updates include the expected audio config and tool definitions, and that outbound text and function-call output use v2 message shapes.

**Data flow**: Runs a mock websocket server that inspects the initial `session.update` JSON and subsequent `conversation.item.create` messages, while the client connects with `RealtimeV2`, consumes `session.updated`, sends a text item and function-call output, then closes.

**Call relations**: Covers v2-specific behavior in `send_session_update`, `send_conversation_item_create`, and `send_conversation_function_call_output`.

*Call graph*: calls 1 internal fn (new); 12 external calls (from_millis, from_secs, new, new, bind, assert_eq!, format!, json!, from_str, spawn (+2 more)).


##### `tests::transcription_mode_session_update_omits_output_audio_and_instructions`  (lines 2070–2181)

```
async fn transcription_mode_session_update_omits_output_audio_and_instructions()
```

**Purpose**: End-to-end test that verifies v2 transcription mode sends a stripped-down session update without instructions, output audio, or tools.

**Data flow**: Mock server inspects the first client message, sends `session.updated`, then expects an audio append. The client connects in transcription mode, asserts the parsed session-updated event, sends audio, and closes.

**Call relations**: Exercises the transcription branch of v2 session construction and confirms the connection bootstrap still works.

*Call graph*: calls 1 internal fn (new); 13 external calls (from_millis, from_secs, new, new, bind, assert!, assert_eq!, format!, json!, from_str (+3 more)).


##### `tests::v1_transcription_mode_is_treated_as_conversational`  (lines 2184–2274)

```
async fn v1_transcription_mode_is_treated_as_conversational()
```

**Purpose**: End-to-end test that confirms v1 transcription mode is normalized to conversational/quicksilver session behavior.

**Data flow**: Mock server inspects the initial session update for quicksilver type, instructions, and output voice, sends `session.updated`, and the client connects, consumes the event, and closes.

**Call relations**: Validates the v1 normalization rule applied by `normalized_session_mode` and v1 session construction.

*Call graph*: calls 1 internal fn (new); 13 external calls (from_millis, from_secs, new, new, bind, assert!, assert_eq!, format!, json!, from_str (+3 more)).


##### `tests::send_does_not_block_while_next_event_waits_for_inbound_data`  (lines 2277–2380)

```
async fn send_does_not_block_while_next_event_waits_for_inbound_data()
```

**Purpose**: Regression test proving that outbound sends can complete while `next_event` is concurrently blocked waiting for inbound frames.

**Data flow**: Starts a mock server that waits for `session.update` and an audio append before sending `session.updated`. The client connects, then runs `send_audio_frame` under a timeout concurrently with `next_event` using `tokio::join!`, asserting the send completes promptly and the event is later received.

**Call relations**: Specifically validates the concurrency design of `WsStream::new` and the pump-task split between send and receive paths.

*Call graph*: calls 1 internal fn (new); 13 external calls (from_millis, from_secs, new, new, bind, assert_eq!, format!, json!, from_str, join! (+3 more)).


### Realtime session runtimes
These files execute live realtime conversations by bridging the websocket/WebRTC transports into session-level runtime behavior and native WebRTC handling.

### `core/src/realtime_conversation.rs`

`orchestration` · `startup, request handling, realtime session main loop, shutdown`

This file owns the full lifecycle of a realtime conversation inside a `Session`. The central type, `RealtimeConversationManager`, stores an optional `ConversationState` behind a `tokio::sync::Mutex`; that state contains bounded async channels for inbound microphone audio and text, a `RealtimeHandoffState` for background-agent output, task handles for the transport input loop and event fanout loop, and an `Arc<AtomicBool>` used as the session identity/liveness token. Starting a conversation first tears down any previous state, then builds a `RealtimeSessionConfig`, chooses websocket vs WebRTC sideband transport, opens the connection, and spawns the input task that multiplexes four sources with `tokio::select!`: user text, user audio, handoff output, and server events.

The file also encodes version-specific behavior. `RealtimeSessionKind::V1` and `V2` differ in allowed output modality, voice set, text prefixing, handoff semantics, and whether `response.create` must be queued through `RealtimeResponseCreateQueue` to avoid racing an already-active response. For V2, assistant/background text is prefixed with `[BACKEND] ` or `[USER] ` and truncated to token budgets before being injected back into the conversation. Incoming server events update output-audio truncation state, acknowledge noop or handoff function calls, route handoff requests back into the session as XML-wrapped delegation text, and forward all realtime events to the client subscription. Error handling is intentionally defensive: transport/API failures are mapped to protocol errors, queue overflow drops audio instead of blocking, stale handoff updates are ignored, and shutdown can either abort or detach the fanout task depending on whether closure is locally requested or transport-driven.

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

**Purpose**: Queues or immediately sends a default `response.create` request for realtime v2 sessions. It prevents overlapping default responses by deferring creation when one is already active.

**Data flow**: Reads and mutates the queue's `active_default_response` and `pending_create` flags, plus uses the provided `RealtimeWebsocketWriter`, `Sender<RealtimeEvent>`, and human-readable `reason`. If a response is active it only marks `pending_create = true`; otherwise it forwards to `send_create_now` and returns that result.

**Call relations**: Used from `handle_handoff_output` after standalone handoff completion paths and from `handle_realtime_server_event` when a handoff-steering acknowledgement should trigger a follow-up response. It is the public gate that centralizes the race-avoidance policy before delegating to `send_create_now`.

*Call graph*: calls 1 internal fn (send_create_now); called by 2 (handle_handoff_output, handle_realtime_server_event).


##### `RealtimeResponseCreateQueue::mark_started`  (lines 150–152)

```
fn mark_started(&mut self)
```

**Purpose**: Marks that the server has begun a default response so later create requests will be deferred instead of sent immediately.

**Data flow**: Takes `&mut self` and sets `active_default_response` to `true`. It returns no value and does not touch external state.

**Call relations**: Called only when `handle_realtime_server_event` observes `RealtimeEvent::ResponseCreated`, so the queue's internal state tracks the server's actual response lifecycle.

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

**Purpose**: Marks the active default response as finished and, if a create request was deferred, sends that deferred request immediately.

**Data flow**: Clears `active_default_response`; if `pending_create` is false it returns `Ok(())`. Otherwise it clears `pending_create`, uses the supplied writer/events channel/reason, and invokes `send_create_now`, propagating any error.

**Call relations**: Triggered by `handle_realtime_server_event` on `ResponseCancelled` and `ResponseDone`. It closes the loop started by `request_create`, ensuring deferred work is flushed only after the previous response ends.

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

**Purpose**: Actually emits `response.create` to the realtime transport and translates API failures into logged warnings and outbound realtime error events.

**Data flow**: Uses `RealtimeWebsocketWriter::send_response_create()`. On success it sets `active_default_response = true`. On failure it maps the API error, inspects the message for the known active-response prefix, and either converts that race into `active_default_response = true` plus `pending_create = true`, or sends `RealtimeEvent::Error(error_message)` on `events_tx` and returns an error.

**Call relations**: This is the low-level send path used by both `request_create` and `mark_finished`. Its special-case handling for the active-response error is what makes the higher-level queue resilient to transport/server races.

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

**Purpose**: Constructs the shared handoff state object used to coordinate background-agent output and active handoff tracking across tasks.

**Data flow**: Consumes the outbound sender, `codex_responses_as_items` flag, optional item prefix, and session kind; initializes `active_handoff` and `last_output_text` as fresh `Arc<Mutex<Option<String>>>` values set to `None`; returns a populated `RealtimeHandoffState`.

**Call relations**: Created during `RealtimeConversationManager::start_inner` and then cloned into the conversation state and input task. It packages the mutable handoff bookkeeping that later functions read and update.

*Call graph*: called by 2 (start_inner, clears_active_handoff_explicitly); 2 external calls (new, new).


##### `RealtimeConversationManager::new`  (lines 259–263)

```
fn new() -> Self
```

**Purpose**: Creates an empty conversation manager with no active realtime session.

**Data flow**: Initializes `state` to `Mutex::new(None)` and returns the manager.

**Call relations**: Used by session construction code to install the realtime subsystem before any conversation starts.

*Call graph*: called by 3 (new, make_session_and_context, make_session_and_context_with_auth_config_home_and_rx); 1 external calls (new).


##### `RealtimeConversationManager::running_state`  (lines 265–270)

```
async fn running_state(&self) -> Option<()>
```

**Purpose**: Reports whether a conversation state exists and is still marked active.

**Data flow**: Locks `self.state`, reads the optional `ConversationState`, checks `realtime_active.load(Ordering::Relaxed)`, and returns `Some(())` when active or `None` otherwise.

**Call relations**: Used by request handlers after send failures to distinguish 'already ending' from 'not running at all' without exposing internal state details.


##### `RealtimeConversationManager::is_running_v2`  (lines 272–280)

```
async fn is_running_v2(&self) -> bool
```

**Purpose**: Checks whether the current active conversation exists and uses realtime v2 semantics.

**Data flow**: Locks `state`, reads `realtime_active` and `session_kind`, and returns a boolean indicating active v2 state.

**Call relations**: Provides a narrow capability check for callers that need to branch on v2-only behavior.

*Call graph*: 1 external calls (matches!).


##### `RealtimeConversationManager::start`  (lines 282–292)

```
async fn start(&self, start: RealtimeStart) -> CodexResult<RealtimeStartOutput>
```

**Purpose**: Replaces any existing realtime conversation with a newly prepared one.

**Data flow**: Locks `state`, removes any previous `ConversationState`, stops it via `stop_conversation_state` with fanout abort semantics, then forwards the supplied `RealtimeStart` to `start_inner` and returns its output.

**Call relations**: This is the public start entry used by `handle_start_inner`. It enforces the invariant that only one realtime conversation may exist at a time.

*Call graph*: calls 2 internal fn (start_inner, stop_conversation_state).


##### `RealtimeConversationManager::start_inner`  (lines 294–396)

```
async fn start_inner(&self, start: RealtimeStart) -> CodexResult<RealtimeStartOutput>
```

**Purpose**: Allocates channels, chooses transport, opens the realtime connection, spawns the input task, and stores the resulting conversation state.

**Data flow**: Destructures `RealtimeStart`, derives `RealtimeSessionKind` from `session_config.event_parser`, creates bounded channels for audio/text/handoff/events, allocates `realtime_active`, builds `RealtimeHandoffState`, and either: for WebRTC, asks `ModelClient` to create a realtime call and spawns `spawn_webrtc_sideband_input_task`; or for websocket, connects `RealtimeWebsocketClient` directly and spawns `spawn_realtime_input_task`. It then writes a new `ConversationState` into `self.state` and returns `RealtimeStartOutput { realtime_active, events_rx, sdp }`.

**Call relations**: Called only by `start`. It is the assembly point where configuration, transport setup, task spawning, and manager state installation come together.

*Call graph*: calls 5 internal fn (new, new, spawn_realtime_input_task, spawn_webrtc_sideband_input_task, default_headers); called by 1 (start); 3 external calls (clone, new, new).


##### `RealtimeConversationManager::register_fanout_task`  (lines 398–417)

```
async fn register_fanout_task(
        &self,
        realtime_active: &Arc<AtomicBool>,
        fanout_task: JoinHandle<()>,
    )
```

**Purpose**: Associates the event-fanout task with the currently active conversation, aborting the task if it belongs to an outdated session.

**Data flow**: Takes the caller's `realtime_active` token and a `JoinHandle<()>`. It locks `state`; if the stored state's token is pointer-equal, it stores the handle in `fanout_task`. Otherwise it aborts and awaits the passed task outside the lock.

**Call relations**: Used by `handle_start_inner` immediately after spawning the fanout loop. The pointer-equality check prevents races where a newer conversation supersedes the one that created the task.

*Call graph*: 3 external calls (ptr_eq, abort, take).


##### `RealtimeConversationManager::finish_if_active`  (lines 419–431)

```
async fn finish_if_active(&self, realtime_active: &Arc<AtomicBool>)
```

**Purpose**: Stops and removes the current conversation only if the supplied liveness token still matches it.

**Data flow**: Locks `state`, compares the stored `realtime_active` with the provided `Arc` using pointer equality, takes the state if it matches, then stops it with `RealtimeFanoutTaskStop::Detach` so the caller-owned fanout task can finish independently.

**Call relations**: Invoked by the fanout loop in `handle_start_inner` when the transport closes or errors. It avoids tearing down a newer conversation that may have started after the fanout task was spawned.

*Call graph*: calls 1 internal fn (stop_conversation_state); 1 external calls (ptr_eq).


##### `RealtimeConversationManager::audio_in`  (lines 433–455)

```
async fn audio_in(&self, frame: RealtimeAudioFrame) -> CodexResult<()>
```

**Purpose**: Accepts one microphone audio frame for the active conversation without blocking the caller on a full queue.

**Data flow**: Locks `state` to clone `audio_tx`; if no state exists it returns `CodexErr::InvalidRequest`. It then `try_send`s the `RealtimeAudioFrame`: success returns `Ok(())`, full queue logs a warning and drops the frame, closed queue returns the same invalid-request error.

**Call relations**: Called by `handle_audio`. It is intentionally lossy under pressure so realtime capture does not stall upstream request handling.

*Call graph*: 2 external calls (InvalidRequest, warn!).


##### `RealtimeConversationManager::text_in`  (lines 457–480)

```
async fn text_in(&self, mut params: ConversationTextParams) -> CodexResult<()>
```

**Purpose**: Queues a text message into the active realtime conversation, adding the v2 user prefix when appropriate.

**Data flow**: Locks `state` to clone `text_tx` and read `session_kind`; errors if no conversation exists. If `params.role` is `ConversationTextRole::User`, it rewrites `params.text` through `prefix_realtime_text`. It then asynchronously sends the params on the channel and maps channel closure to `CodexErr::InvalidRequest`.

**Call relations**: Called by `handle_text`. The actual transport write happens later in `handle_text_input` inside the input task.

*Call graph*: calls 1 internal fn (prefix_realtime_text); 1 external calls (InvalidRequest).


##### `RealtimeConversationManager::handoff_out`  (lines 482–533)

```
async fn handoff_out(&self, output_text: String) -> CodexResult<()>
```

**Purpose**: Transforms background-agent output into the correct realtime outbound form based on active handoff state, session version, and item-vs-function-call mode.

**Data flow**: Locks manager state to clone `RealtimeHandoffState`; errors if not running. It reads `active_handoff` and, depending on whether a handoff is active and whether the text is empty, builds one of `RealtimeOutbound::HandoffUpdate`, `Completed`-style progress item, `StandaloneHandoff`, or `ConversationItem`. It prefixes/truncates text with `realtime_backend_output`, optionally wraps it with `realtime_backend_item`, updates `last_output_text` for active handoffs, and sends the outbound message on `output_tx`.

**Call relations**: Used by higher-level background-agent plumbing to feed progress/results back into realtime. The resulting `RealtimeOutbound` is consumed later by `handle_handoff_output` in the input task.

*Call graph*: calls 2 internal fn (realtime_backend_item, realtime_backend_output); 1 external calls (InvalidRequest).


##### `RealtimeConversationManager::append_speech`  (lines 535–558)

```
async fn append_speech(&self, text: String) -> CodexResult<()>
```

**Purpose**: Injects synthesized speech text into realtime as a standalone backend output when non-empty.

**Data flow**: Returns early for blank text. Otherwise it clones `RealtimeHandoffState` from manager state, errors if not running, converts the text with `realtime_backend_output`, wraps it as `RealtimeOutbound::StandaloneHandoff`, and sends it on `output_tx`.

**Call relations**: Called by `handle_speech`. It reuses the same outbound path as handoff output but without active-handoff bookkeeping.

*Call graph*: calls 1 internal fn (realtime_backend_output); 1 external calls (InvalidRequest).


##### `RealtimeConversationManager::handoff_complete`  (lines 560–594)

```
async fn handoff_complete(&self) -> CodexResult<()>
```

**Purpose**: Signals completion of the currently active handoff in realtime v2 sessions, using either an acknowledgement function output or a completed-handoff payload.

**Data flow**: Clones `RealtimeHandoffState` if present; returns early if no conversation, if session kind is v1, if there is no active handoff id, or if no `last_output_text` was recorded. It then chooses `RealtimeOutbound::HandoffCompleteAck` when `codex_responses_as_items` is enabled, otherwise `RealtimeOutbound::CompletedHandoff { handoff_id, text }`, and sends it on `output_tx`.

**Call relations**: This is the explicit completion counterpart to `handoff_out`. The emitted outbound message is later interpreted by `handle_handoff_output` to finish the function call and possibly trigger a new response.


##### `RealtimeConversationManager::clear_active_handoff`  (lines 596–605)

```
async fn clear_active_handoff(&self)
```

**Purpose**: Resets handoff tracking so future background output is treated as standalone rather than attached to an old handoff.

**Data flow**: If a conversation exists, clones its `RealtimeHandoffState` and sets both `active_handoff` and `last_output_text` mutex-protected values to `None`.

**Call relations**: Used by surrounding session logic when a handoff lifecycle ends outside this file's direct event loop.


##### `RealtimeConversationManager::shutdown`  (lines 607–617)

```
async fn shutdown(&self) -> CodexResult<()>
```

**Purpose**: Stops any active realtime conversation and clears manager state.

**Data flow**: Locks `state`, takes the current `ConversationState`, and if present passes it to `stop_conversation_state` with abort semantics. Returns `Ok(())` regardless of whether a state existed.

**Call relations**: Called by `end_realtime_conversation` and potentially other teardown paths. It is the manager's explicit stop API.

*Call graph*: calls 1 internal fn (stop_conversation_state).


##### `stop_conversation_state`  (lines 620–637)

```
async fn stop_conversation_state(
    mut state: ConversationState,
    fanout_task_stop: RealtimeFanoutTaskStop,
)
```

**Purpose**: Performs the actual task-level teardown for a stored conversation state.

**Data flow**: Sets `realtime_active` to false, aborts and awaits `input_task`, then if a `fanout_task` exists either aborts and awaits it or leaves it detached depending on `RealtimeFanoutTaskStop`.

**Call relations**: Shared by `start`, `shutdown`, and `finish_if_active`. The detach option is important when the fanout task itself is the caller and must not abort itself.

*Call graph*: called by 3 (finish_if_active, shutdown, start).


##### `handle_start`  (lines 639–672)

```
async fn handle_start(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationStartParams,
) -> CodexResult<()>
```

**Purpose**: Top-level protocol handler for a realtime conversation start request, including preparation, startup, and client-visible error reporting.

**Data flow**: Receives `Session`, subscription id, and `ConversationStartParams`. It calls `prepare_realtime_start`; on failure it logs and sends a `RealtimeConversationRealtime` event carrying `RealtimeEvent::Error`. On success it calls `handle_start_inner`; if that fails it logs and sends the same error-shaped realtime event.

**Call relations**: Invoked from the session submission loop. It separates preparation/startup failures from transport runtime failures by reporting them immediately on the subscription channel.

*Call graph*: calls 2 internal fn (handle_start_inner, prepare_realtime_start); called by 1 (submission_loop); 3 external calls (error!, RealtimeConversationRealtime, Error).


##### `prepare_realtime_start`  (lines 687–755)

```
async fn prepare_realtime_start(
    sess: &Arc<Session>,
    params: ConversationStartParams,
) -> CodexResult<PreparedRealtimeConversationStart>
```

**Purpose**: Resolves provider/auth/config/transport details into a validated `PreparedRealtimeConversationStart` structure.

**Data flow**: Reads provider info, auth manager/auth, session config, requested transport/version/architecture, and optional experimental base URLs from `Session`. It validates architecture constraints, builds `RealtimeSessionConfig`, captures the requested session id, computes extra headers via `realtime_request_headers`, and for websocket transport obtains an API key via `realtime_api_key`. It returns all derived fields needed by `handle_start_inner`.

**Call relations**: Called by `handle_start` before any connection attempt. It is the configuration-and-auth normalization phase for startup.

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

**Purpose**: Enforces the special constraints required by the AVAS realtime architecture.

**Data flow**: Examines the requested architecture, websocket version, transport, and configured session type. Non-AVAS passes through; AVAS requires v1, WebRTC transport, and conversational mode, otherwise it returns `CodexErr::InvalidRequest` with a specific message.

**Call relations**: Used during `prepare_realtime_start` to reject incompatible combinations before transport setup begins.

*Call graph*: called by 1 (prepare_realtime_start); 2 external calls (matches!, InvalidRequest).


##### `build_realtime_session_config`  (lines 784–853)

```
async fn build_realtime_session_config(
    sess: &Arc<Session>,
    params: &ConversationStartParams,
    version: RealtimeWsVersion,
) -> CodexResult<RealtimeSessionConfig>
```

**Purpose**: Builds the API-facing realtime session configuration from request parameters plus session configuration defaults.

**Data flow**: Reads config from `Session`, merges prompt text with optional startup context from either config or `build_realtime_startup_context`, chooses model from params/config/default, maps `RealtimeWsVersion` to `RealtimeEventParser`, rejects text-only output on v1, maps configured session mode to `RealtimeSessionMode`, chooses a voice from params/config/default via `default_realtime_voice`, validates it with `validate_realtime_voice`, and returns a `RealtimeSessionConfig` containing instructions, model, session id, parser, mode, output modality, and voice.

**Call relations**: Called by `prepare_realtime_start`. It encapsulates all request/config merging and version-specific validation for the realtime API session object.

*Call graph*: calls 3 internal fn (build_realtime_startup_context, validate_realtime_voice, prepare_realtime_backend_prompt); called by 1 (prepare_realtime_start); 4 external calls (new, format!, matches!, InvalidRequest).


##### `default_realtime_voice`  (lines 855–861)

```
fn default_realtime_voice(version: RealtimeWsVersion) -> RealtimeVoice
```

**Purpose**: Selects the built-in default voice appropriate for the requested realtime protocol version.

**Data flow**: Reads `RealtimeVoicesList::builtin()` and returns either `default_v1` or `default_v2` based on `RealtimeWsVersion`.

**Call relations**: Used by `build_realtime_session_config` when neither request params nor config specify a voice.

*Call graph*: calls 1 internal fn (builtin).


##### `prefix_realtime_text`  (lines 863–868)

```
fn prefix_realtime_text(text: String, prefix: &str, session_kind: RealtimeSessionKind) -> String
```

**Purpose**: Adds a textual prefix such as `[USER] ` or `[BACKEND] ` only for realtime v2 and only when the text is non-empty and not already prefixed.

**Data flow**: Consumes a `String`, prefix string, and session kind. It returns the original text unchanged unless the session is v2, the text is non-empty, and it does not already start with the prefix; in that case it returns a newly formatted string.

**Call relations**: Used by `RealtimeConversationManager::text_in` for user messages and by `realtime_backend_output` for backend-originated text.

*Call graph*: called by 2 (text_in, realtime_backend_output); 1 external calls (format!).


##### `realtime_backend_output`  (lines 870–873)

```
fn realtime_backend_output(output_text: String, session_kind: RealtimeSessionKind) -> String
```

**Purpose**: Normalizes backend output text for reinjection into realtime by applying the backend prefix and enforcing the assistant output token budget.

**Data flow**: Takes raw output text and session kind, runs `prefix_realtime_text` with `REALTIME_BACKEND_TEXT_PREFIX`, then truncates the result with `truncate_realtime_text_to_token_budget` using `REALTIME_ASSISTANT_OUTPUT_TOKEN_BUDGET`, returning the final string.

**Call relations**: Used by `handoff_out` and `append_speech` before those paths enqueue outbound background text.

*Call graph*: calls 2 internal fn (truncate_realtime_text_to_token_budget, prefix_realtime_text); called by 2 (append_speech, handoff_out).


##### `realtime_backend_item`  (lines 875–881)

```
fn realtime_backend_item(text: String, prefix: Option<&str>) -> String
```

**Purpose**: Builds a developer conversation item payload from backend text, optionally prepending a configured item prefix, then truncates it to the assistant token budget.

**Data flow**: Consumes text and an optional prefix. If the prefix exists and is non-empty it formats `"{prefix}\n\n{text}"`; otherwise it keeps the text unchanged. It then truncates the result and returns it.

**Call relations**: Used by `handoff_out` when `codex_responses_as_items` is enabled so backend output is injected as a conversation item instead of function-call output.

*Call graph*: calls 1 internal fn (truncate_realtime_text_to_token_budget); called by 1 (handoff_out); 1 external calls (format!).


##### `validate_realtime_voice`  (lines 883–906)

```
fn validate_realtime_voice(version: RealtimeWsVersion, voice: RealtimeVoice) -> CodexResult<()>
```

**Purpose**: Checks that the requested voice belongs to the built-in allowed set for the selected realtime version.

**Data flow**: Loads `RealtimeVoicesList::builtin()`, selects the allowed list for v1 or v2, and returns `Ok(())` if the voice is present. Otherwise it formats an invalid-request error listing the supported wire names.

**Call relations**: Called by `build_realtime_session_config` after voice selection to reject unsupported version/voice combinations early.

*Call graph*: calls 1 internal fn (builtin); called by 1 (build_realtime_session_config); 2 external calls (format!, InvalidRequest).


##### `handle_start_inner`  (lines 908–1033)

```
async fn handle_start_inner(
    sess: &Arc<Session>,
    sub_id: &str,
    prepared_start: PreparedRealtimeConversationStart,
) -> CodexResult<()>
```

**Purpose**: Starts the conversation manager, emits started/SDP events to the client, and spawns the fanout loop that forwards realtime events back through the session subscription.

**Data flow**: Consumes `PreparedRealtimeConversationStart`, derives optional SDP from transport, builds `RealtimeStart`, and calls `sess.conversation.start`. It sends `RealtimeConversationStarted`, optionally `RealtimeConversationSdp`, then spawns a task that reads `events_rx`, logs non-audio events, marks end reason on errors, converts `HandoffRequested` events into routed XML text via `realtime_delegation_from_handoff`, forwards every event as `RealtimeConversationRealtime`, and on termination calls `finish_if_active` plus `send_realtime_conversation_closed`.

**Call relations**: Called by `handle_start` after preparation succeeds. It is the handoff point from startup into the long-lived event fanout path, and it registers that fanout task back into the manager.

*Call graph*: calls 2 internal fn (realtime_delegation_from_handoff, send_realtime_conversation_closed); called by 1 (handle_start); 7 external calls (clone, debug!, info!, RealtimeConversationRealtime, RealtimeConversationSdp, RealtimeConversationStarted, spawn).


##### `handle_audio`  (lines 1035–1049)

```
async fn handle_audio(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationAudioParams,
)
```

**Purpose**: Protocol handler for incoming audio frames from the client side of the session.

**Data flow**: Passes `params.frame` to `sess.conversation.audio_in()`. On error it logs; if the conversation still appears active it only warns that shutdown may be in progress, otherwise it sends a protocol `ErrorEvent` with `CodexErrorInfo::BadRequest` via `send_conversation_error`.

**Call relations**: Called by the submission loop for audio append requests. It is a thin adapter around `RealtimeConversationManager::audio_in` with user-facing error shaping.

*Call graph*: calls 1 internal fn (send_conversation_error); called by 1 (submission_loop); 2 external calls (error!, warn!).


##### `realtime_transcript_delta_from_handoff`  (lines 1051–1059)

```
fn realtime_transcript_delta_from_handoff(handoff: &RealtimeHandoffRequested) -> Option<String>
```

**Purpose**: Formats the active transcript entries from a handoff request into a newline-separated `role: text` block.

**Data flow**: Reads `handoff.active_transcript`, maps each entry to `"{role}: {text}"`, joins them with newlines, and returns `Some(string)` only if the result is non-empty.

**Call relations**: Used by `realtime_delegation_from_handoff` both as a fallback input source and as optional transcript delta metadata.

*Call graph*: called by 1 (realtime_delegation_from_handoff).


##### `realtime_text_from_handoff_request`  (lines 1061–1065)

```
fn realtime_text_from_handoff_request(handoff: &RealtimeHandoffRequested) -> Option<String>
```

**Purpose**: Extracts the most useful textual input from a handoff request, preferring the explicit input transcript and falling back to the active transcript delta.

**Data flow**: Checks `handoff.input_transcript`; if non-empty returns its clone, otherwise calls `realtime_transcript_delta_from_handoff` and returns that optional string.

**Call relations**: Called by `realtime_delegation_from_handoff` to decide what text should be routed back into the session.

*Call graph*: called by 1 (realtime_delegation_from_handoff).


##### `realtime_delegation_from_handoff`  (lines 1067–1073)

```
fn realtime_delegation_from_handoff(handoff: &RealtimeHandoffRequested) -> Option<String>
```

**Purpose**: Converts a realtime handoff request into the XML-wrapped delegation text that the session routes into its normal text-input path.

**Data flow**: Calls `realtime_text_from_handoff_request`; if it yields no text, returns `None`. Otherwise it also computes an optional transcript delta and passes both to `wrap_realtime_delegation_input`, returning the wrapped string.

**Call relations**: Used by the fanout loop in `handle_start_inner` when a `RealtimeEvent::HandoffRequested` arrives, so handoff requests can be reintroduced into the broader session workflow.

*Call graph*: calls 3 internal fn (realtime_text_from_handoff_request, realtime_transcript_delta_from_handoff, wrap_realtime_delegation_input); called by 1 (handle_start_inner).


##### `wrap_realtime_delegation_input`  (lines 1075–1085)

```
fn wrap_realtime_delegation_input(input: &str, transcript_delta: Option<&str>) -> String
```

**Purpose**: Builds the exact XML envelope used for routed realtime delegation input, escaping user-visible text fields first.

**Data flow**: Escapes `input` with `escape_xml_text`. If `transcript_delta` exists and is non-empty, escapes it too and returns a `<realtime_delegation>` block containing both `<input>` and `<transcript_delta>` elements; otherwise returns a block with only `<input>`.

**Call relations**: Called only by `realtime_delegation_from_handoff`. It defines the wire format expected by downstream routing logic.

*Call graph*: calls 1 internal fn (escape_xml_text); called by 1 (realtime_delegation_from_handoff); 1 external calls (format!).


##### `escape_xml_text`  (lines 1087–1092)

```
fn escape_xml_text(input: &str) -> String
```

**Purpose**: Performs minimal XML escaping for delegation payload text.

**Data flow**: Takes `&str` and returns a new `String` with `&`, `<`, and `>` replaced by `&amp;`, `&lt;`, and `&gt;` respectively.

**Call relations**: Used by `wrap_realtime_delegation_input` to keep routed delegation XML well-formed.

*Call graph*: called by 1 (wrap_realtime_delegation_input).


##### `realtime_api_key`  (lines 1094–1118)

```
fn realtime_api_key(auth: Option<&CodexAuth>, provider: &ModelProviderInfo) -> CodexResult<String>
```

**Purpose**: Finds an API credential suitable for realtime websocket authentication, including temporary fallbacks for OpenAI sessions.

**Data flow**: Checks provider-specific API key, then provider bearer token, then authenticated `CodexAuth` API key, then for OpenAI providers falls back to `read_openai_api_key_from_env()`. If none are available it returns `CodexErr::InvalidRequest`.

**Call relations**: Called by `prepare_realtime_start` for websocket transport, where the realtime request headers must include bearer authorization.

*Call graph*: calls 2 internal fn (api_key, is_openai); called by 1 (prepare_realtime_start); 2 external calls (read_openai_api_key_from_env, InvalidRequest).


##### `realtime_request_headers`  (lines 1120–1145)

```
fn realtime_request_headers(
    realtime_session_id: Option<&str>,
    api_key: Option<&str>,
    version: RealtimeWsVersion,
) -> CodexResult<Option<HeaderMap>>
```

**Purpose**: Constructs optional HTTP headers for realtime connection setup, including version marker, session id, and authorization.

**Data flow**: Creates a `HeaderMap`, inserts `openai-alpha: quicksilver=v1` for v1, inserts `x-session-id` if the provided session id parses as a header value, and inserts `Authorization: Bearer ...` if an API key is supplied. It returns `Ok(Some(headers))` or an invalid-request error if the auth header value is malformed.

**Call relations**: Used by `prepare_realtime_start` for both websocket and WebRTC sideband startup, with API key omitted for WebRTC call creation flows.

*Call graph*: called by 1 (prepare_realtime_start); 4 external calls (new, from_static, from_str, format!).


##### `handle_text`  (lines 1147–1162)

```
async fn handle_text(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationTextParams,
)
```

**Purpose**: Protocol handler for incoming text appended to the realtime conversation.

**Data flow**: Logs the text, calls `sess.conversation.text_in(params)`, and on error either warns if shutdown is already underway or sends a `BadRequest` `ErrorEvent` through `send_conversation_error`.

**Call relations**: Invoked by the submission loop for text append requests. It is the session-facing wrapper around `RealtimeConversationManager::text_in`.

*Call graph*: calls 1 internal fn (send_conversation_error); called by 1 (submission_loop); 3 external calls (debug!, error!, warn!).


##### `handle_speech`  (lines 1164–1179)

```
async fn handle_speech(
    sess: &Arc<Session>,
    sub_id: String,
    params: ConversationSpeechParams,
)
```

**Purpose**: Protocol handler for speech text that should be appended into realtime as backend output.

**Data flow**: Logs the text, calls `sess.conversation.append_speech(params.text)`, and on failure follows the same warn-vs-error-event pattern as `handle_text` and `handle_audio`.

**Call relations**: Called by the submission loop for speech append requests. It adapts protocol input to the manager's standalone backend-output path.

*Call graph*: calls 1 internal fn (send_conversation_error); called by 1 (submission_loop); 3 external calls (debug!, error!, warn!).


##### `handle_close`  (lines 1181–1183)

```
async fn handle_close(sess: &Arc<Session>, sub_id: String)
```

**Purpose**: Protocol handler for an explicit client request to close the realtime conversation.

**Data flow**: Passes the session and subscription id to `end_realtime_conversation` with `RealtimeConversationEnd::Requested`.

**Call relations**: Invoked by the submission loop when the client closes the subscription.

*Call graph*: calls 1 internal fn (end_realtime_conversation); called by 1 (submission_loop).


##### `spawn_realtime_input_task`  (lines 1185–1187)

```
fn spawn_realtime_input_task(input: RealtimeInputTask) -> JoinHandle<()>
```

**Purpose**: Starts the websocket input loop on a Tokio task.

**Data flow**: Consumes a `RealtimeInputTask`, wraps `run_realtime_input_task(input)` in `tokio::spawn`, and returns the `JoinHandle<()>`.

**Call relations**: Used by `RealtimeConversationManager::start_inner` for direct websocket sessions.

*Call graph*: calls 1 internal fn (run_realtime_input_task); called by 1 (start_inner); 1 external calls (spawn).


##### `spawn_webrtc_sideband_input_task`  (lines 1202–1260)

```
fn spawn_webrtc_sideband_input_task(input: RealtimeWebrtcSidebandInputTask) -> JoinHandle<()>
```

**Purpose**: Starts a Tokio task that first connects the WebRTC sideband websocket and then runs the normal realtime input loop over that connection.

**Data flow**: Destructures `RealtimeWebrtcSidebandInputTask`, checks `realtime_active`, calls `RealtimeWebsocketClient::connect_webrtc_sideband` with session config, call id, sideband headers, and default headers, maps connection errors into `RealtimeEvent::Error` on `events_tx`, and on success constructs a `RealtimeInputTask` and awaits `run_realtime_input_task`.

**Call relations**: Used by `RealtimeConversationManager::start_inner` when startup includes SDP/WebRTC transport. It is the transport-specific wrapper that normalizes WebRTC sideband into the same input loop used by websocket sessions.

*Call graph*: calls 2 internal fn (run_realtime_input_task, default_headers); called by 1 (start_inner); 4 external calls (map_api_error, Error, spawn, warn!).


##### `run_realtime_input_task`  (lines 1262–1324)

```
async fn run_realtime_input_task(input: RealtimeInputTask)
```

**Purpose**: Runs the core multiplexing loop that drives realtime transport I/O for one active conversation.

**Data flow**: Owns the writer, server event stream, inbound text/audio/handoff receivers, event sender, handoff state, session kind, and parser. It initializes `output_audio_state` and a default `RealtimeResponseCreateQueue`, then repeatedly `tokio::select!`s among text input, handoff output, server events, and user audio, delegating each branch to `handle_text_input`, `handle_handoff_output`, `handle_realtime_server_event`, or `handle_user_audio_input`. Any branch error breaks the loop and ends the task.

**Call relations**: Spawned by both `spawn_realtime_input_task` and `spawn_webrtc_sideband_input_task`. It is the central runtime loop for transport-side conversation processing.

*Call graph*: called by 2 (spawn_realtime_input_task, spawn_webrtc_sideband_input_task); 2 external calls (default, select!).


##### `handle_text_input`  (lines 1326–1345)

```
async fn handle_text_input(
    params: Result<ConversationTextParams, RecvError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
) -> anyhow::Result<()>
```

**Purpose**: Consumes one queued text input item and sends it to the realtime server as a conversation item.

**Data flow**: Receives `Result<ConversationTextParams, RecvError>`, converts channel closure into an error with context, then calls `writer.send_conversation_item_create(params.text, params.role)`. On API failure it maps/logs the error, sends `RealtimeEvent::Error` on `events_tx`, and returns an error.

**Call relations**: Called from `run_realtime_input_task` when the text input channel wins the select. It is the final transport write step for `RealtimeConversationManager::text_in`.

*Call graph*: calls 1 internal fn (send_conversation_item_create); 4 external calls (send, map_api_error, Error, warn!).


##### `handle_handoff_output`  (lines 1347–1443)

```
async fn handle_handoff_output(
    handoff_output: Result<RealtimeOutbound, RecvError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
    handoff_state: &RealtimeHandof
```

**Purpose**: Translates queued background-agent output into the correct realtime API calls, with distinct behavior for v1 versus v2 and for item-based versus function-call-based codex responses.

**Data flow**: Consumes `Result<RealtimeOutbound, RecvError>`, errors on closed channel, then matches on `event_parser` and outbound variant. V1 sends standalone handoffs via `send_conversation_handoff_append`, handoff updates/completions via `send_conversation_function_call_output`, and conversation items as developer items. V2 sends standalone handoffs as user items followed by `response_create_queue.request_create`, drops stale handoff updates if `handoff_id` no longer matches `active_handoff`, acknowledges completed handoffs with either a canned completion string or empty output, and may trigger deferred response creation. Any API failure is mapped, logged, emitted as `RealtimeEvent::Error`, and returned.

**Call relations**: Called from `run_realtime_input_task` when background-agent output arrives from `RealtimeConversationManager::handoff_out`, `append_speech`, or `handoff_complete`. It is where abstract outbound intents become concrete realtime protocol writes.

*Call graph*: calls 4 internal fn (send_conversation_function_call_output, send_conversation_handoff_append, send_conversation_item_create, request_create); 6 external calls (send, new, map_api_error, debug!, Error, warn!).


##### `handle_realtime_server_event`  (lines 1445–1625)

```
async fn handle_realtime_server_event(
    event: Result<Option<RealtimeEvent>, ApiError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
    handoff_state: &RealtimeHand
```

**Purpose**: Processes one event from the realtime server, updates local conversation bookkeeping, emits follow-up API calls when needed, and forwards the event to the fanout channel.

**Data flow**: Consumes `Result<Option<RealtimeEvent>, ApiError>`, converting stream end or API error into failure and sending `RealtimeEvent::Error` when possible. For `AudioOut` it updates `output_audio_state` in v2. For `InputAudioSpeechStarted` it may send a raw `conversation.item.truncate` payload using the accumulated audio duration. `ResponseCreated`, `ResponseCancelled`, and `ResponseDone` update the `RealtimeResponseCreateQueue`. `HandoffRequested` updates `active_handoff`, or in v2 sends steering acknowledgements and requests a new response when another handoff is already active. `NoopRequested` sends empty function output in v2. `SessionUpdated` is logged. Most events are forwarded on `events_tx`; `RealtimeEvent::Error` sets `should_stop`, causing the function to bail after forwarding.

**Call relations**: Called from `run_realtime_input_task` whenever the server event stream yields an item. It is the main state machine for interpreting realtime protocol events and coordinating local side effects.

*Call graph*: calls 6 internal fn (send_conversation_function_call_output, send_payload, mark_finished, mark_started, request_create, update_output_audio_state); 9 external calls (send, new, bail!, map_api_error, error!, info!, json!, Error, warn!).


##### `handle_user_audio_input`  (lines 1627–1643)

```
async fn handle_user_audio_input(
    frame: Result<RealtimeAudioFrame, RecvError>,
    writer: &RealtimeWebsocketWriter,
    events_tx: &Sender<RealtimeEvent>,
) -> anyhow::Result<()>
```

**Purpose**: Consumes one queued microphone frame and writes it to the realtime transport.

**Data flow**: Receives `Result<RealtimeAudioFrame, RecvError>`, turns channel closure into an error with context, then calls `writer.send_audio_frame(frame)`. On failure it maps/logs the error, sends `RealtimeEvent::Error` on `events_tx`, and returns an error.

**Call relations**: Called from `run_realtime_input_task` when the audio input channel wins the select. It is the final transport write step for `RealtimeConversationManager::audio_in`.

*Call graph*: calls 1 internal fn (send_audio_frame); 4 external calls (send, map_api_error, error!, Error).


##### `update_output_audio_state`  (lines 1645–1668)

```
fn update_output_audio_state(
    output_audio_state: &mut Option<OutputAudioState>,
    frame: &RealtimeAudioFrame,
)
```

**Purpose**: Tracks the cumulative played duration for the current output audio item so speech-start interruptions can truncate it accurately.

**Data flow**: Reads `frame.item_id`; if absent it returns. It computes `audio_end_ms` via `audio_duration_ms`; if zero it returns. If `output_audio_state` already exists for the same item id it saturating-adds the duration, otherwise it replaces the state with a new `OutputAudioState { item_id, audio_end_ms }`.

**Call relations**: Used by `handle_realtime_server_event` on `AudioOut` events in v2. The stored state is later consumed when `InputAudioSpeechStarted` arrives.

*Call graph*: calls 1 internal fn (audio_duration_ms); called by 1 (handle_realtime_server_event).


##### `audio_duration_ms`  (lines 1670–1679)

```
fn audio_duration_ms(frame: &RealtimeAudioFrame) -> u32
```

**Purpose**: Computes the duration in milliseconds represented by one realtime audio frame.

**Data flow**: Reads `samples_per_channel` from the frame, falling back to `decoded_samples_per_channel(frame)` if absent. If no sample count is available it returns 0. Otherwise it divides samples by `sample_rate` (with a minimum of 1) and converts to milliseconds as `u32`.

**Call relations**: Called by `update_output_audio_state` to derive truncation timing from outgoing audio frames.

*Call graph*: calls 1 internal fn (decoded_samples_per_channel); called by 1 (update_output_audio_state); 1 external calls (from).


##### `decoded_samples_per_channel`  (lines 1681–1686)

```
fn decoded_samples_per_channel(frame: &RealtimeAudioFrame) -> Option<u32>
```

**Purpose**: Infers the sample count per channel by base64-decoding PCM audio data and dividing by sample width and channel count.

**Data flow**: Base64-decodes `frame.data`, treats samples as 16-bit (`/ 2`), divides by `num_channels.max(1)`, and converts the result to `u32`. Any decode, division, or conversion failure yields `None`.

**Call relations**: Used only by `audio_duration_ms` when the frame does not already carry `samples_per_channel`.

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

**Purpose**: Sends a protocol-level `ErrorEvent` for a realtime conversation request.

**Data flow**: Builds `Event { id: sub_id, msg: EventMsg::Error(ErrorEvent { message, codex_error_info: Some(...) }) }` and sends it through `sess.send_event_raw().await`.

**Call relations**: Used by `handle_audio`, `handle_text`, and `handle_speech` when request processing fails before or outside the realtime event stream.

*Call graph*: called by 3 (handle_audio, handle_speech, handle_text); 1 external calls (Error).


##### `end_realtime_conversation`  (lines 1704–1711)

```
async fn end_realtime_conversation(
    sess: &Arc<Session>,
    sub_id: String,
    end: RealtimeConversationEnd,
)
```

**Purpose**: Performs explicit conversation shutdown and then notifies the client that the realtime conversation closed.

**Data flow**: Calls `sess.conversation.shutdown().await`, ignores its result, then calls `send_realtime_conversation_closed(sess, sub_id, end).await`.

**Call relations**: Called by `handle_close` for user-requested shutdown. It is the explicit close path, distinct from transport-driven closure in the fanout loop.

*Call graph*: calls 1 internal fn (send_realtime_conversation_closed); called by 1 (handle_close).


##### `send_realtime_conversation_closed`  (lines 1713–1729)

```
async fn send_realtime_conversation_closed(
    sess: &Arc<Session>,
    sub_id: String,
    end: RealtimeConversationEnd,
)
```

**Purpose**: Emits the terminal `RealtimeConversationClosed` event with a normalized reason string.

**Data flow**: Maps `RealtimeConversationEnd::{Requested, TransportClosed, Error}` to `"requested"`, `"transport_closed"`, or `"error"`, wraps that in `RealtimeConversationClosedEvent`, and sends it via `sess.send_event_raw().await`.

**Call relations**: Used by both `end_realtime_conversation` and the fanout loop in `handle_start_inner` so all shutdown paths produce the same client-visible closure event.

*Call graph*: called by 2 (end_realtime_conversation, handle_start_inner); 1 external calls (RealtimeConversationClosed).


### `realtime-webrtc/src/lib.rs`

`io_transport` · `realtime conversation`

This crate is a narrow transport adapter around a native realtime WebRTC implementation. The public API consists of a startup result (`StartedRealtimeWebrtcSession`) containing the local offer SDP, a session handle, and an `mpsc::Receiver` of `RealtimeWebrtcEvent`s; a `RealtimeWebrtcSessionHandle` for applying the remote answer SDP, closing the session, and reading a shared local-audio peak meter; and a `RealtimeWebrtcSession::start()` entrypoint.

The implementation is intentionally split by platform. On macOS, the handle wraps `native::SessionHandle` and `RealtimeWebrtcSession::start()` delegates to `native::start()`, then wraps the returned native handle and event receiver while initializing `local_audio_peak` to `Arc<AtomicU16>::new(0)`. On non-macOS targets, startup and SDP application return `RealtimeWebrtcError::UnsupportedPlatform`, and `close()` becomes a no-op. This keeps the API available everywhere without pretending the feature works cross-platform.

The custom `Debug` impl for `RealtimeWebrtcSessionHandle` deliberately hides internal fields by using `finish_non_exhaustive()`, which avoids exposing native handle details in logs. The event enum is small and transport-oriented: connected, local audio level updates, closed, and failed-with-message.

#### Function details

##### `RealtimeWebrtcSessionHandle::fmt`  (lines 40–43)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the session handle for debugging without exposing internal implementation details.

**Data flow**: Takes `&self` and a formatter → creates a debug struct named `RealtimeWebrtcSessionHandle` and finishes it as non-exhaustive → returns the formatting result.

**Call relations**: Used implicitly by debug logging or test output. It intentionally does not reveal the native handle or shared audio-peak state.

*Call graph*: 1 external calls (debug_struct).


##### `RealtimeWebrtcSessionHandle::apply_answer_sdp`  (lines 47–57)

```
fn apply_answer_sdp(&self, answer_sdp: String) -> Result<()>
```

**Purpose**: Applies the remote answer SDP to an already-started WebRTC session. This is only supported on macOS.

**Data flow**: Takes `answer_sdp: String` → on macOS forwards it to `self.inner.apply_answer_sdp(answer_sdp)` and returns that `Result<()>`; on non-macOS drops the string and returns `Err(RealtimeWebrtcError::UnsupportedPlatform)`.

**Call relations**: Called after `RealtimeWebrtcSession::start()` when the remote peer returns an answer SDP. It delegates to the native session handle only on supported platforms.

*Call graph*: 1 external calls (apply_answer_sdp).


##### `RealtimeWebrtcSessionHandle::close`  (lines 59–62)

```
fn close(&self)
```

**Purpose**: Closes the underlying realtime WebRTC session if the platform supports it.

**Data flow**: Takes `&self` → on macOS calls `self.inner.close()`; on non-macOS performs no action → returns unit.

**Call relations**: Used during teardown or explicit realtime-session shutdown. It is a best-effort no-op on unsupported platforms.

*Call graph*: 1 external calls (close).


##### `RealtimeWebrtcSessionHandle::local_audio_peak`  (lines 64–66)

```
fn local_audio_peak(&self) -> Arc<AtomicU16>
```

**Purpose**: Returns a clone of the shared atomic local-audio peak meter for the session.

**Data flow**: Reads `self.local_audio_peak` → clones the `Arc<AtomicU16>` → returns the clone.

**Call relations**: Used by callers that want to observe or publish local audio level state without taking ownership of the handle.


##### `RealtimeWebrtcSession::start`  (lines 72–89)

```
fn start() -> Result<StartedRealtimeWebrtcSession>
```

**Purpose**: Starts a new realtime WebRTC session and returns the local offer SDP, a handle, and an event receiver. This is only implemented on macOS.

**Data flow**: On macOS, calls `native::start()?`, then constructs `StartedRealtimeWebrtcSession { offer_sdp: started.offer_sdp, handle: RealtimeWebrtcSessionHandle { inner: started.handle, local_audio_peak: Arc::new(AtomicU16::new(0)) }, events: started.events }` and returns `Ok(...)`; on non-macOS returns `Err(RealtimeWebrtcError::UnsupportedPlatform)`.

**Call relations**: This is the crate’s main entrypoint for realtime WebRTC transport setup. It delegates all actual session creation to the platform-native module and wraps the result in the cross-platform API surface.

*Call graph*: calls 1 internal fn (start); 2 external calls (new, new).


### `realtime-webrtc/src/native.rs`

`io_transport` · `session startup, answer application, live connection monitoring, shutdown`

This file is the native WebRTC backend for a realtime session. Its core design is a thread boundary: `start` creates three standard-library MPSC channels, spawns a named worker thread, waits synchronously for the worker to produce an SDP offer, and returns a `StartedSession` containing that offer, a `SessionHandle`, and an event receiver. `SessionHandle` is intentionally tiny; it only sends `Command` messages (`ApplyAnswer` with a reply channel, or `Close`) into the worker.

Inside `worker_main`, the worker first builds a dedicated Tokio runtime. Startup failures are reported in two places: the initial offer channel gets an error so `start` fails immediately, and the event channel gets `RealtimeWebrtcEvent::Failed` for observers. On success, the worker asynchronously creates a `PeerConnection`, adds a send/receive audio transceiver with stream id `realtime`, creates a local audio source/track named `realtime-mic`, attaches it to the sender, creates an offer, and sets that offer as the local description before returning the SDP string.

After startup, the worker processes commands serially. Applying an answer parses SDP as `SdpType::Answer`, sets the remote description, replies to the caller, and only on success emits `Connected` and starts a periodic Tokio task that polls `get_stats()` every 200 ms. That task extracts the first audio `RtcStats::MediaSource` entry, converts its normalized `audio_level` into a `u16` peak scaled to `i16::MAX`, and emits `LocalAudioLevel`. Both explicit `Close` and channel shutdown close the peer connection and emit `Closed`. Error wrapping is standardized through `message_error`, so all libwebrtc failures become `RealtimeWebrtcError::Message` with operation-specific prefixes.

#### Function details

##### `SessionHandle::apply_answer_sdp`  (lines 40–48)

```
fn apply_answer_sdp(&self, answer_sdp: String) -> Result<()>
```

**Purpose**: Synchronously asks the worker thread to apply a remote answer SDP and waits for the result. It turns worker disappearance into a user-facing `RealtimeWebrtcError::Message`.

**Data flow**: Takes `&self` and an owned `answer_sdp: String`. It creates a one-shot reply channel, sends `Command::ApplyAnswer { answer_sdp, reply }` through `command_tx`, then blocks on `reply_rx.recv()`; the returned `Result<()>` comes from the worker, while send/receive failures are converted into a "realtime WebRTC worker stopped" error.

**Call relations**: This is the caller-facing control path into `worker_main` for remote SDP completion. The worker receives the command, invokes `apply_answer`, and if that succeeds continues by emitting `Connected` and launching `start_local_audio_level_task` before replying.

*Call graph*: 2 external calls (send, channel).


##### `SessionHandle::close`  (lines 50–52)

```
fn close(&self)
```

**Purpose**: Requests orderly shutdown of the worker-owned peer connection without waiting for confirmation. It deliberately ignores send failures because a stopped worker is already effectively closed.

**Data flow**: Reads `self.command_tx` and sends `Command::Close`. It returns `()` and does not mutate local state beyond attempting the channel send.

**Call relations**: This is the explicit shutdown trigger consumed by `worker_main`. When the worker sees `Close`, it closes the `PeerConnection`, emits `RealtimeWebrtcEvent::Closed`, and exits.

*Call graph*: 1 external calls (send).


##### `start`  (lines 55–76)

```
fn start() -> Result<StartedSession>
```

**Purpose**: Bootstraps a new native WebRTC session and blocks until the worker has either produced an SDP offer or failed during initialization. It packages the resulting channels into `StartedSession`.

**Data flow**: Creates command, event, and offer channels; spawns a named OS thread running `worker_main(command_rx, events_tx, offer_tx)`; then waits on `offer_rx.recv()`. On success it returns `StartedSession { offer_sdp, handle: SessionHandle { command_tx }, events: events_rx }`; thread-spawn or startup-channel failures become `RealtimeWebrtcError::Message`.

**Call relations**: This is the file’s top-level constructor, invoked by the crate-level startup path. It delegates all real WebRTC setup to `worker_main` and only returns once that worker has completed `create_peer_connection_and_offer`.

*Call graph*: called by 1 (start); 2 external calls (channel, new).


##### `worker_main`  (lines 78–134)

```
fn worker_main(
    command_rx: mpsc::Receiver<Command>,
    events_tx: mpsc::Sender<RealtimeWebrtcEvent>,
    offer_tx: mpsc::Sender<Result<String>>,
)
```

**Purpose**: Owns the Tokio runtime and `PeerConnection`, performs startup negotiation, then serially executes commands from the control channel. It is the central coordinator for session lifecycle and event emission.

**Data flow**: Consumes `command_rx`, `events_tx`, and `offer_tx`. It builds a multi-thread Tokio runtime; on failure it sends an error to `offer_tx` and a `Failed` event. It then `block_on`s `create_peer_connection_and_offer`; on success it sends the offer SDP back, on failure it reports through both channels and returns. In the command loop, `ApplyAnswer` runs `apply_answer`; successful application emits `Connected` and starts `start_local_audio_level_task`, then replies with the result. `Close` closes the peer connection, emits `Closed`, and exits. If the command channel closes naturally, it also closes the connection and emits `Closed`.

**Call relations**: Spawned only by `start`, this function drives every other helper in the file. It delegates startup to `create_peer_connection_and_offer`, answer installation to `apply_answer`, and post-connect telemetry to `start_local_audio_level_task`.

*Call graph*: calls 3 internal fn (apply_answer, create_peer_connection_and_offer, start_local_audio_level_task); 6 external calls (clone, send, format!, Message, Failed, new_multi_thread).


##### `create_peer_connection_and_offer`  (lines 136–174)

```
async fn create_peer_connection_and_offer() -> Result<(PeerConnection, String)>
```

**Purpose**: Constructs the libwebrtc peer connection, attaches a local audio track, creates an SDP offer, and installs that offer as the local description. It returns both the live `PeerConnection` and the serialized offer SDP.

**Data flow**: Creates a `PeerConnectionFactory` via `with_platform_adm`, then a `PeerConnection` with default `RtcConfiguration`. It adds an audio transceiver configured `SendRecv` with stream id `realtime`, creates an audio source and track named `realtime-mic`, attaches the track to the transceiver sender, asynchronously creates an offer with audio receive enabled and video disabled, sets that offer as the local description, and returns `(peer_connection, offer.to_string())`. Any libwebrtc error is wrapped by `message_error` into `RealtimeWebrtcError::Message`.

**Call relations**: Called during worker startup from `worker_main`. Its successful completion is the prerequisite for `start` to return a usable session and for later `apply_answer` commands to make sense.

*Call graph*: called by 1 (worker_main); 4 external calls (with_platform_adm, default, new, vec!).


##### `apply_answer`  (lines 176–184)

```
async fn apply_answer(peer_connection: &PeerConnection, answer_sdp: String) -> Result<()>
```

**Purpose**: Parses the remote answer SDP and installs it as the peer connection’s remote description. It is the final negotiation step after the local offer has been created.

**Data flow**: Takes a borrowed `PeerConnection` and owned `answer_sdp: String`. It parses the string into a `SessionDescription` with `SdpType::Answer`, awaits `set_remote_description(answer)`, and returns `Ok(())` on success; parse or set failures are converted with `message_error`.

**Call relations**: Invoked by `worker_main` when it receives `Command::ApplyAnswer`. A successful return is what causes the worker to emit `Connected` and begin periodic local audio-level polling.

*Call graph*: called by 1 (worker_main); 2 external calls (set_remote_description, parse).


##### `message_error`  (lines 186–188)

```
fn message_error(prefix: &str, err: impl Display) -> RealtimeWebrtcError
```

**Purpose**: Normalizes lower-level errors into the crate’s message-style WebRTC error variant with an operation-specific prefix. It keeps all user-visible failures consistently formatted.

**Data flow**: Takes a `prefix: &str` and any `Display` error, formats `"{prefix}: {err}"`, and returns `RealtimeWebrtcError::Message(...)`.

**Call relations**: Used as the common error adapter by `create_peer_connection_and_offer` and `apply_answer`, so startup and negotiation failures surface with concrete context instead of raw libwebrtc errors.

*Call graph*: 2 external calls (format!, Message).


##### `start_local_audio_level_task`  (lines 190–213)

```
fn start_local_audio_level_task(
    runtime: &tokio::runtime::Runtime,
    peer_connection: PeerConnection,
    events_tx: mpsc::Sender<RealtimeWebrtcEvent>,
)
```

**Purpose**: Launches a background Tokio task that periodically samples local audio stats and emits `LocalAudioLevel` events while the connection remains alive. It stops automatically once the peer connection is closed or failed.

**Data flow**: Takes a Tokio `Runtime`, a cloned `PeerConnection`, and an event sender. It spawns an async loop with a 200 ms interval; each tick checks `peer_connection.connection_state()`, returns if the state is `Closed` or `Failed`, otherwise awaits `local_audio_level(&peer_connection)` and, when it yields `Some(peak)`, sends `RealtimeWebrtcEvent::LocalAudioLevel(peak)`.

**Call relations**: Started by `worker_main` only after `apply_answer` succeeds. It delegates stat extraction to `local_audio_level` and acts as the long-running telemetry sidecar for an established session.

*Call graph*: calls 1 internal fn (local_audio_level); called by 1 (worker_main); 6 external calls (spawn, send, matches!, LocalAudioLevel, from_millis, interval).


##### `local_audio_level`  (lines 215–223)

```
async fn local_audio_level(peer_connection: &PeerConnection) -> Option<u16>
```

**Purpose**: Extracts the current local audio level from WebRTC stats, if an audio media-source stat is available. It converts the normalized floating-point level into the integer peak format used by events.

**Data flow**: Borrows a `PeerConnection`, awaits `get_stats()`, and returns `None` if stats retrieval fails. It iterates through the resulting `RtcStats` values, finds the first `RtcStats::MediaSource` whose `source.kind` is `"audio"`, maps its `stats.audio.audio_level` through `audio_level_to_peak`, and returns `Some(u16)`; otherwise it returns `None`.

**Call relations**: Called from the loop inside `start_local_audio_level_task`. It is intentionally best-effort: missing stats or non-audio stats simply suppress an event for that tick.

*Call graph*: called by 1 (start_local_audio_level_task); 1 external calls (get_stats).


##### `audio_level_to_peak`  (lines 225–227)

```
fn audio_level_to_peak(audio_level: f64) -> u16
```

**Purpose**: Converts libwebrtc’s normalized audio level into a 16-bit peak-like integer scale suitable for UI/event consumers. It clamps out-of-range inputs before scaling.

**Data flow**: Takes `audio_level: f64`, clamps it to `[0.0, 1.0]`, multiplies by `i16::MAX as f64`, rounds, and casts to `u16`.

**Call relations**: Used only by `local_audio_level` as the final numeric transformation before `RealtimeWebrtcEvent::LocalAudioLevel` is emitted.
