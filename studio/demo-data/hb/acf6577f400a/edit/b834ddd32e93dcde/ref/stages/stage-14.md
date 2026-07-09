# Tool execution, approvals, and guarded side effects  `stage-14`

This stage is the system’s action center in the main work loop. It wakes up when the model stops talking and asks to do something real, like run a command, edit files, search the web, or call an outside service. Its job is to turn that request into a safe, approved action and then turn the result back into something the conversation can use.

First, the approval, guardian, and hook parts act like checkpoints. They standardize requests, apply safety rules, ask the user when needed, run extra reviews, and let external helper programs weigh in. Next, the execution backends are the engine room that actually runs shell commands, patches, and other tasks inside the right sandbox, meaning a restricted environment.

Extension and integration tools add the wider world: MCP, a standard way to talk to external tool servers, plus plugins, connectors, web, image, memory, skills, and code-mode tools. Shared support pieces build sandbox rules and inspect commands to spot safe, risky, or dangerous patterns.

The direct files provide the common language for tools: schemas describe inputs, adapters translate MCP tools, executors define how tools run and whether they are visible, handlers share parsing helpers, and error types separate ordinary tool failures from serious runtime breakdowns.

## Sub-stages

- [Approval, guardian, and hook mediation](stage-14.1.md) `stage-14.1` — 63 files
- [Execution backends and sandboxed command runtimes](stage-14.2.md) `stage-14.2` — 91 files
- [Extension and integration tools](stage-14.3.md) `stage-14.3` — 117 files
- [Sandbox policy generation and command-safety parsing helpers](stage-14.4.md) `stage-14.4` — 17 files

## Files in this stage

### Tool crate interface
These files establish the shared tools crate surface and the core execution/error contracts used by the rest of the stage.

### `tools/src/function_call_error.rs`

`data_model` · `request handling`

This file provides the `FunctionCallError` enum used by the tools subsystem when a tool invocation cannot complete successfully. The type is deliberately small and policy-oriented. `RespondToModel(String)` wraps an error message that should be surfaced back into the model conversation as the tool result or failure explanation; it represents errors that are part of normal tool semantics, such as invalid arguments or expected runtime issues that the model may recover from. `Fatal(String)` marks failures that should be treated as infrastructure or unrecoverable execution problems, with the display text prefixed by `Fatal error:` to make that distinction explicit in logs or surfaced diagnostics. The enum derives `Debug`, `thiserror::Error`, and `PartialEq`, which makes it both easy to format consistently and straightforward to assert against in tests. There is no conversion logic here; the file’s role is to encode a contract that higher-level tool executors and adapters can use to decide whether to continue the conversation with an explanatory tool response or stop the current flow due to a hard failure.


### `tools/src/tool_executor.rs`

`domain_logic` · `tool registration and invocation`

This file provides the trait and small supporting types that every executable tool runtime conforms to. `ToolExecutorFuture<'a>` standardizes asynchronous execution as a boxed, pinned, `Send` future yielding either a boxed `ToolOutput` or a `FunctionCallError`. `ToolExposure` is a four-way policy enum: `Direct` exposes a tool normally, `Deferred` registers it for later discovery and requires search metadata, `DirectModelOnly` keeps it visible to the model but out of nested code-mode surfaces, and `Hidden` keeps it dispatchable without exposing it. The `is_direct` helper collapses that policy into a simple yes/no check for initial exposure. The `ToolExecutor<Invocation>` trait ties together naming, model-visible `ToolSpec`, optional exposure overrides, optional search metadata, parallel-call capability, and the async `handle` method. Its defaults are opinionated: tools are direct by default, are assumed not to support parallel calls, and derive `ToolSearchInfo` from `self.spec()` with no source metadata. That default search path means implementors can often expose deferred tools without writing custom indexing logic, while still allowing overrides when richer metadata or different visibility is needed.

#### Function details

##### `ToolExposure::is_direct`  (lines 39–41)

```
fn is_direct(self) -> bool
```

**Purpose**: Answers whether an exposure mode should place the tool in the initial direct model-visible list. It treats both `Direct` and `DirectModelOnly` as direct exposure.

**Data flow**: It takes `self` by value, checks it with a `matches!` expression against `Self::Direct | Self::DirectModelOnly`, and returns a `bool`. No state is read beyond the enum value itself.

**Call relations**: This helper is used by orchestration code that needs a simple predicate when deciding which registered tools to surface immediately.

*Call graph*: 1 external calls (matches!).


##### `ToolExecutor::exposure`  (lines 55–57)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: Provides the default exposure policy for tool executors. Unless an implementation overrides it, tools are exposed directly.

**Data flow**: It reads no inputs other than `&self` and returns `ToolExposure::Direct`. It performs no mutation.

**Call relations**: Callers consult this default during tool registration or surface construction; implementors override it only when they need deferred, hidden, or model-only behavior.


##### `ToolExecutor::search_info`  (lines 59–62)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: Builds default search metadata for a tool from its own `ToolSpec`. This gives deferred tools a ready-made discovery entry without requiring custom indexing code.

**Data flow**: It calls `self.spec()` to obtain the model-visible specification, passes that spec and `None` source metadata into `ToolSearchInfo::from_tool_spec`, and returns the resulting `Option<ToolSearchInfo>`. It does not mutate executor state.

**Call relations**: This default implementation is used when orchestration code asks an executor for discovery metadata; it delegates to the search-text/spec transformation logic in `tool_search.rs`.

*Call graph*: calls 1 internal fn (from_tool_spec).


##### `ToolExecutor::supports_parallel_tool_calls`  (lines 64–66)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: Declares whether a tool runtime can safely process multiple calls in parallel. The default is conservative and disables parallelism.

**Data flow**: It takes `&self` and returns `false` unconditionally. No state is changed.

**Call relations**: Schedulers or dispatch layers consult this method before issuing concurrent invocations; implementations override it only when their runtime behavior is explicitly parallel-safe.


### `tools/src/lib.rs`

`orchestration` · `cross-cutting`

This crate root defines the externally visible surface of the `tools` subsystem. Internally, the crate is split into modules for code-mode adaptation, dynamic and MCP tool parsing, JSON schema handling, plugin-install request flows, response-history trimming, Responses API representations, tool-call execution context, environment/config selection, discovery/search, output formatting, and tool specification generation. This file wires those pieces together by re-exporting the concrete types and helper functions that downstream crates consume. As a result, callers can work from a single namespace to parse tool specs, convert them into Responses API forms, inspect or construct `ToolDefinition`, execute through `ToolExecutor`, classify failures with `FunctionCallError`, manage tool-call context via `ToolCall` and `ToolEnvironment`, and expose discovery/install tools such as plugin search and install request helpers. It also re-exports configuration selectors that map feature flags or model capabilities onto shell/backend choices, plus utility functions for truncating response history to token budgets. The file itself contains no runtime logic; its design choice is API curation. By flattening many specialized modules into a stable public surface, it lets the rest of the system depend on tool concepts without coupling to the crate’s internal organization.


### Schema and MCP adaptation
These files define how tool schemas are normalized and how MCP tool metadata is converted into the internal tool-definition format.

### `tools/src/json_schema.rs`

`domain_logic` · `tool schema parsing`

This file combines data model definitions with the full parsing pipeline for tool input schemas. `JsonSchemaPrimitiveType`, `JsonSchemaType`, `JsonSchema`, and `AdditionalProperties` encode the supported subset: primitive types, unions of primitive types, object properties, arrays, enums, composition keywords, refs, and root definition tables. The constructor methods (`string`, `object`, `array`, `any_of`, etc.) produce canonical internal values used throughout the crate.

The parsing path starts at `parse_tool_input_schema` or its no-compaction variant. Both clone and preprocess raw `serde_json::Value` input via `prepare_tool_input_schema`, which recursively sanitizes malformed or unsupported schema fragments, infers missing `type` values from keywords like `properties`, `items`, `enum`, `format`, or numeric constraints, rewrites `const` to single-value `enum`, fills default `properties` / `items` for object and array schemas, preserves composition keywords and `$ref`, and drops malformed definition tables. It then prunes unreachable `$defs` / `definitions` entries by collecting local refs outside and inside definitions, including cyclic and percent-encoded pointers.

The default parser additionally applies best-effort size compaction under a byte budget: strip descriptions, replace local-definition refs with `{}` and drop definition tables, collapse deep complex schema objects beyond a fixed depth, and finally prune composition nodes to `{}` if still oversized. Deserialization into `JsonSchema` is the final gate, with one explicit invariant enforced afterward: a singleton `type: "null"` schema is rejected as invalid tool input. The implementation is careful to traverse schema children consistently across `properties`, `items`, `additionalProperties`, composition arrays, and definition tables, while distinguishing root definition tables from user properties that happen to share those names.

#### Function details

##### `JsonSchema::typed`  (lines 78–84)

```
fn typed(schema_type: JsonSchemaPrimitiveType, description: Option<String>) -> Self
```

**Purpose**: Internal constructor for a schema with a single primitive `type` and optional description.

**Data flow**: Accepts a `JsonSchemaPrimitiveType` and `Option<String>` description, builds a `JsonSchema` with `schema_type` set to `Some(JsonSchemaType::Single(...))`, stores the description, and fills all other fields from `Default::default()`. It returns the new schema value.

**Call relations**: This helper underpins the public scalar constructors such as `boolean`, `string`, `number`, `integer`, and `null`. It centralizes the canonical representation for single-type schemas so those wrappers only choose the primitive type.

*Call graph*: 2 external calls (default, Single).


##### `JsonSchema::any_of`  (lines 86–92)

```
fn any_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self
```

**Purpose**: Constructs a schema whose primary constraint is an `anyOf` composition.

**Data flow**: Takes a vector of variant `JsonSchema` values and an optional description, stores them in `any_of` and `description`, leaves other fields at defaults, and returns the assembled schema.

**Call relations**: Used by callers and tests that need to represent preserved composition schemas. It is one of the explicit composition constructors that mirror the subset preserved by the sanitizer.

*Call graph*: 1 external calls (default).


##### `JsonSchema::one_of`  (lines 94–100)

```
fn one_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self
```

**Purpose**: Constructs a schema whose primary constraint is a `oneOf` composition.

**Data flow**: Consumes a vector of variant schemas plus an optional description, writes them into `one_of` and `description`, and returns a default-filled `JsonSchema` with those fields set.

**Call relations**: This is the `oneOf` counterpart to `JsonSchema::any_of`, used when callers or tests need to build expected schemas that preserve exclusive-choice composition.

*Call graph*: 1 external calls (default).


##### `JsonSchema::all_of`  (lines 102–108)

```
fn all_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self
```

**Purpose**: Constructs a schema whose primary constraint is an `allOf` composition.

**Data flow**: Accepts variant schemas and an optional description, stores them in `all_of` and `description`, and returns the resulting `JsonSchema` with all other fields defaulted.

**Call relations**: Used where schema intersections must be represented explicitly. It complements the other composition constructors and matches the sanitizer’s decision to preserve `allOf` structurally.

*Call graph*: 1 external calls (default).


##### `JsonSchema::boolean`  (lines 110–112)

```
fn boolean(description: Option<String>) -> Self
```

**Purpose**: Builds a boolean-typed schema with an optional description.

**Data flow**: Receives `Option<String>` and forwards it with `JsonSchemaPrimitiveType::Boolean` into `JsonSchema::typed`, returning the resulting schema.

**Call relations**: This public convenience constructor is used by tool-definition builders elsewhere in the crate and by tests. It delegates all actual assembly to `JsonSchema::typed`.

*Call graph*: called by 9 (create_wait_tool, create_report_agent_job_result_tool, create_send_input_tool_v1, spawn_agent_common_properties_v1, create_exec_command_tool_with_environment_id, create_shell_command_tool, network_permissions_schema, exec_command_tool_matches_expected_spec, shell_command_tool_matches_expected_spec); 1 external calls (typed).


##### `JsonSchema::string`  (lines 114–116)

```
fn string(description: Option<String>) -> Self
```

**Purpose**: Builds a string-typed schema with an optional description.

**Data flow**: Takes an optional description, passes it with `JsonSchemaPrimitiveType::String` to `JsonSchema::typed`, and returns the constructed schema.

**Call relations**: Widely used across tool builders and tests as the canonical string schema constructor. It is also the fallback target for several sanitizer coercions, such as boolean-schema lowering and missing array items.

*Call graph*: called by 38 (create_wait_tool, create_report_agent_job_result_tool, create_spawn_agents_on_csv_tool, create_list_mcp_resource_templates_tool, create_list_mcp_resources_tool, create_read_mcp_resource_tool, create_close_agent_tool_v1, create_collab_input_items_schema, create_followup_task_tool, create_interrupt_agent_tool_v2 (+15 more)); 1 external calls (typed).


##### `JsonSchema::with_encrypted`  (lines 118–121)

```
fn with_encrypted(mut self) -> Self
```

**Purpose**: Marks an existing schema as encrypted for responses-only reviewed tool parameters.

**Data flow**: Consumes `self` mutably by value, sets `self.encrypted = Some(true)`, and returns the modified schema.

**Call relations**: This is a fluent modifier used after constructing a base schema. It does not call other helpers and exists to add the optional marker without duplicating constructor variants.


##### `JsonSchema::number`  (lines 123–125)

```
fn number(description: Option<String>) -> Self
```

**Purpose**: Builds a number-typed schema with an optional description.

**Data flow**: Accepts an optional description, forwards it with `JsonSchemaPrimitiveType::Number` into `JsonSchema::typed`, and returns the result.

**Call relations**: Used by tool builders and tests, and conceptually matches sanitizer inference from numeric keywords like `minimum` and `multipleOf`.

*Call graph*: called by 14 (create_wait_tool, create_spawn_agents_on_csv_tool, wait_agent_tool_parameters_v1, wait_agent_tool_parameters_v2, create_request_user_input_tool, create_exec_command_tool_with_environment_id, create_shell_command_tool, create_write_stdin_tool, exec_command_tool_matches_expected_spec, shell_command_tool_matches_expected_spec (+4 more)); 1 external calls (typed).


##### `JsonSchema::integer`  (lines 127–129)

```
fn integer(description: Option<String>) -> Self
```

**Purpose**: Builds an integer-typed schema with an optional description.

**Data flow**: Takes an optional description, delegates to `JsonSchema::typed` with `JsonSchemaPrimitiveType::Integer`, and returns the schema.

**Call relations**: This constructor preserves integer distinctness from number. It is used where callers need exact integer semantics and in tests that verify integer types survive normalization.

*Call graph*: called by 1 (create_create_goal_tool); 1 external calls (typed).


##### `JsonSchema::null`  (lines 131–133)

```
fn null(description: Option<String>) -> Self
```

**Purpose**: Builds a null-typed schema with an optional description.

**Data flow**: Receives an optional description, passes it to `JsonSchema::typed` with `JsonSchemaPrimitiveType::Null`, and returns the resulting schema.

**Call relations**: Used in tests and internal representations of nullable unions. Although null can appear in unions, the parser later rejects a singleton null schema via `deserialize_tool_input_schema`.

*Call graph*: 1 external calls (typed).


##### `JsonSchema::string_enum`  (lines 135–142)

```
fn string_enum(values: Vec<JsonValue>, description: Option<String>) -> Self
```

**Purpose**: Constructs a string schema constrained by explicit enum values.

**Data flow**: Accepts `Vec<JsonValue>` enum literals and an optional description, sets `schema_type` to single string, stores the enum values and description, defaults all other fields, and returns the schema.

**Call relations**: Used by callers and tests to represent normalized `enum` and rewritten `const` schemas. It is the canonical internal form for string-valued enumerations.

*Call graph*: called by 4 (create_update_plan_tool, create_approval_parameters, create_view_image_tool, create_update_goal_tool); 2 external calls (default, Single).


##### `JsonSchema::array`  (lines 144–151)

```
fn array(items: JsonSchema, description: Option<String>) -> Self
```

**Purpose**: Constructs an array schema with a required item schema and optional description.

**Data flow**: Takes an item `JsonSchema` and optional description, wraps the item in `Box`, sets `schema_type` to array, stores the description, and returns the assembled schema.

**Call relations**: Used by tool builders and tests, and mirrors sanitizer behavior that inserts default string `items` when an array type lacks them.

*Call graph*: called by 6 (create_collab_input_items_schema, wait_agent_tool_parameters_v1, create_update_plan_tool, create_request_user_input_tool, create_approval_parameters, file_system_permissions_schema); 3 external calls (new, default, Single).


##### `JsonSchema::object`  (lines 153–165)

```
fn object(
        properties: BTreeMap<String, JsonSchema>,
        required: Option<Vec<String>>,
        additional_properties: Option<AdditionalProperties>,
    ) -> Self
```

**Purpose**: Constructs an object schema with explicit properties, optional required list, and optional `additionalProperties` policy.

**Data flow**: Consumes a `BTreeMap<String, JsonSchema>` plus optional `required` and `additional_properties`, sets `schema_type` to object, stores those fields, and returns a default-filled `JsonSchema`.

**Call relations**: This is the canonical object constructor used throughout the crate and tests. It matches the sanitizer’s object inference and default-property insertion behavior.

*Call graph*: called by 38 (create_wait_tool, create_report_agent_job_result_tool, create_spawn_agents_on_csv_tool, described_object, create_get_context_remaining_tool, create_list_available_plugins_to_install_tool, create_list_mcp_resource_templates_tool, create_list_mcp_resources_tool, create_read_mcp_resource_tool, create_collab_input_items_schema (+15 more)); 2 external calls (default, Single).


##### `AdditionalProperties::from`  (lines 183–185)

```
fn from(value: JsonSchema) -> Self
```

**Purpose**: Converts either a boolean or a nested schema into the untagged `AdditionalProperties` enum.

**Data flow**: For `bool`, wraps the value as `AdditionalProperties::Boolean`; for `JsonSchema`, boxes it and wraps it as `AdditionalProperties::Schema`. It returns the enum value without side effects.

**Call relations**: These `From` impls let callers write `Some(false.into())` or `Some(schema.into())` when constructing object schemas. They are used heavily in tests and schema builders for concise object assembly.

*Call graph*: 3 external calls (new, Boolean, Schema).


##### `parse_tool_input_schema`  (lines 189–193)

```
fn parse_tool_input_schema(input_schema: &JsonValue) -> Result<JsonSchema, serde_json::Error>
```

**Purpose**: Runs the full tool-input-schema normalization pipeline, including large-schema compaction, and deserializes the result into `JsonSchema`.

**Data flow**: Accepts `&JsonValue`, clones and preprocesses it via `prepare_tool_input_schema`, mutates the clone further with `compact_large_tool_schema`, then passes the final JSON into `deserialize_tool_input_schema`. It returns either a parsed `JsonSchema` or a `serde_json::Error`.

**Call relations**: This is the main entry used by tool parsers such as MCP and dynamic-tool parsing. It orchestrates sanitization, definition pruning, optional size reduction, and final validation/deserialization.

*Call graph*: calls 3 internal fn (compact_large_tool_schema, deserialize_tool_input_schema, prepare_tool_input_schema).


##### `parse_tool_input_schema_without_compaction`  (lines 196–200)

```
fn parse_tool_input_schema_without_compaction(
    input_schema: &JsonValue,
) -> Result<JsonSchema, serde_json::Error>
```

**Purpose**: Parses a trusted tool input schema using the same sanitization and pruning logic as the default path, but skips large-schema compaction.

**Data flow**: Takes `&JsonValue`, clones and normalizes it through `prepare_tool_input_schema`, then directly deserializes it with `deserialize_tool_input_schema`. It returns the parsed `JsonSchema` or an error.

**Call relations**: This alternate entrypoint is used when callers want exact normalized structure without lossy size-reduction passes. It shares the same preparation and validation stages as `parse_tool_input_schema`.

*Call graph*: calls 2 internal fn (deserialize_tool_input_schema, prepare_tool_input_schema).


##### `prepare_tool_input_schema`  (lines 202–207)

```
fn prepare_tool_input_schema(input_schema: &JsonValue) -> JsonValue
```

**Purpose**: Creates a normalized JSON value ready for deserialization by sanitizing unsupported schema shapes and pruning unreachable definitions.

**Data flow**: Clones the input `JsonValue`, mutates the clone in place with `sanitize_json_schema`, then mutates it again with `prune_unreachable_definitions`, and returns the resulting `JsonValue`.

**Call relations**: Both public parse entrypoints call this first. It encapsulates the non-lossy preprocessing stages so compaction can be layered on top only when desired.

*Call graph*: calls 2 internal fn (prune_unreachable_definitions, sanitize_json_schema); called by 2 (parse_tool_input_schema, parse_tool_input_schema_without_compaction); 1 external calls (clone).


##### `deserialize_tool_input_schema`  (lines 209–218)

```
fn deserialize_tool_input_schema(input_schema: JsonValue) -> Result<JsonSchema, serde_json::Error>
```

**Purpose**: Deserializes normalized schema JSON into `JsonSchema` and enforces the invariant that singleton null schemas are invalid tool inputs.

**Data flow**: Consumes a normalized `JsonValue`, attempts `serde_json::from_value` into `JsonSchema`, then inspects `schema.schema_type`. If it is exactly `Some(JsonSchemaType::Single(JsonSchemaPrimitiveType::Null))`, it returns `Err(singleton_null_schema_error())`; otherwise it returns `Ok(schema)`.

**Call relations**: This is the final stage called by both parse entrypoints. It relies on earlier sanitization to make deserialization succeed where possible, then adds one domain-specific rejection rule after generic serde parsing.

*Call graph*: calls 1 internal fn (singleton_null_schema_error); called by 2 (parse_tool_input_schema, parse_tool_input_schema_without_compaction); 2 external calls (matches!, from_value).


##### `compact_large_tool_schema`  (lines 229–236)

```
fn compact_large_tool_schema(value: &mut JsonValue)
```

**Purpose**: Applies a sequence of increasingly lossy compaction passes until a normalized schema fits the byte budget or all passes have run.

**Data flow**: Takes a mutable `JsonValue` and iterates over `LARGE_SCHEMA_COMPACTION_PASSES`. Before each pass it checks `compact_schema_fits_budget`; if already under budget it stops, otherwise it invokes the current pass to mutate the schema in place. It returns unit.

**Call relations**: Called only by `parse_tool_input_schema` after sanitization/pruning. It orchestrates the fallback strategy of stripping descriptions, dropping definitions, collapsing deep objects, and pruning compositions.

*Call graph*: calls 1 internal fn (compact_schema_fits_budget); called by 1 (parse_tool_input_schema).


##### `collapse_deep_schema_objects_from_root`  (lines 247–249)

```
fn collapse_deep_schema_objects_from_root(value: &mut JsonValue)
```

**Purpose**: Convenience wrapper that starts deep-object collapsing at root depth zero.

**Data flow**: Accepts a mutable schema `JsonValue` and forwards it to `collapse_deep_schema_objects(value, 0)`. It returns unit after in-place mutation.

**Call relations**: This wrapper is one of the configured compaction passes in `LARGE_SCHEMA_COMPACTION_PASSES`. It exists so the pass list can store a uniform `fn(&mut JsonValue)` signature.

*Call graph*: calls 1 internal fn (collapse_deep_schema_objects).


##### `compact_schema_fits_budget`  (lines 251–253)

```
fn compact_schema_fits_budget(value: &JsonValue) -> bool
```

**Purpose**: Checks whether the normalized serialized form of a schema is within the configured compact-schema byte budget.

**Data flow**: Takes `&JsonValue`, computes its normalized serialized length via `compact_normalized_schema_len`, compares that length to `MAX_COMPACT_TOOL_SCHEMA_BYTES`, and returns a boolean.

**Call relations**: Used by `compact_large_tool_schema` before each pass to decide whether further lossy mutation is necessary.

*Call graph*: calls 1 internal fn (compact_normalized_schema_len); called by 1 (compact_large_tool_schema).


##### `compact_normalized_schema_len`  (lines 255–260)

```
fn compact_normalized_schema_len(value: &JsonValue) -> usize
```

**Purpose**: Measures the byte length of a schema after round-tripping through `JsonSchema` serialization, using that compact normalized JSON as the budget metric.

**Data flow**: Clones the input `JsonValue`, tries to deserialize it into `JsonSchema`, then serialize that schema back to bytes with `serde_json::to_vec`, and returns the resulting byte length. If either conversion fails, it returns `0`.

**Call relations**: This helper underlies `compact_schema_fits_budget`. Its round-trip approach intentionally measures the normalized subset representation rather than raw input JSON size.

*Call graph*: called by 1 (compact_schema_fits_budget); 1 external calls (clone).


##### `for_each_schema_child`  (lines 268–304)

```
fn for_each_schema_child(
    map: &serde_json::Map<String, JsonValue>,
    definition_traversal: DefinitionTraversal,
    visitor: &mut impl FnMut(&JsonValue),
)
```

**Purpose**: Visits child schema values reachable from a schema object through recognized child-bearing keywords, optionally including definition tables.

**Data flow**: Accepts an immutable JSON object map, a `DefinitionTraversal` mode, and a mutable visitor closure. It invokes the visitor for each property schema under `properties`, each value under `items`/`anyOf`/`oneOf`/`allOf`, schema-valued `additionalProperties`, and, when traversal mode is `Include`, each definition entry under `$defs` and `definitions`.

**Call relations**: This traversal helper is used by `collect_refs_outside_definitions` to walk schema structure without descending into root definition tables unless requested. It centralizes the notion of what counts as a schema child.

*Call graph*: called by 1 (collect_refs_outside_definitions); 2 external calls (get, matches!).


##### `strip_schema_descriptions`  (lines 306–321)

```
fn strip_schema_descriptions(value: &mut JsonValue)
```

**Purpose**: Recursively removes `description` keys from schema objects while preserving similarly named user properties.

**Data flow**: Mutates a `JsonValue` in place. For arrays it recurses into each element; for objects it removes the literal `description` key from the schema object itself, then traverses recognized child schemas via `for_each_schema_child_mut` with definition traversal enabled and recurses into each child; scalars are ignored.

**Call relations**: This is the first large-schema compaction pass. It delegates child traversal to `for_each_schema_child_mut` so descriptions are stripped consistently from nested properties, items, compositions, additionalProperties, and definitions.

*Call graph*: calls 1 internal fn (for_each_schema_child_mut).


##### `for_each_schema_child_mut`  (lines 323–359)

```
fn for_each_schema_child_mut(
    map: &mut serde_json::Map<String, JsonValue>,
    definition_traversal: DefinitionTraversal,
    visitor: &mut impl FnMut(&mut JsonValue),
)
```

**Purpose**: Mutable counterpart to `for_each_schema_child` that yields mutable references to recognized child schema values.

**Data flow**: Takes a mutable JSON object map, a `DefinitionTraversal` mode, and a mutable visitor closure. It visits mutable values under `properties`, `items`/`anyOf`/`oneOf`/`allOf`, schema-valued `additionalProperties`, and optionally mutable entries in `$defs` and `definitions`.

**Call relations**: This helper is shared by all in-place recursive mutators: `strip_schema_descriptions`, `rewrite_definition_refs_to_empty_schemas`, `collapse_deep_schema_objects`, and `prune_schema_compositions`. It ensures those passes recurse over the same schema-bearing fields.

*Call graph*: called by 4 (collapse_deep_schema_objects, prune_schema_compositions, rewrite_definition_refs_to_empty_schemas, strip_schema_descriptions); 2 external calls (get_mut, matches!).


##### `drop_schema_definitions`  (lines 364–374)

```
fn drop_schema_definitions(value: &mut JsonValue)
```

**Purpose**: Removes root definition tables after first neutralizing local-definition refs so they do not dangle.

**Data flow**: Mutates a schema `JsonValue` in place by first calling `rewrite_definition_refs_to_empty_schemas`. If the root is an object, it then removes both `$defs` and `definitions` keys from the root map. Non-object roots are left unchanged after ref rewriting.

**Call relations**: This is the second compaction pass. It depends on `rewrite_definition_refs_to_empty_schemas` to preserve downstream behavior when local refs would otherwise point at removed definitions.

*Call graph*: calls 1 internal fn (rewrite_definition_refs_to_empty_schemas).


##### `rewrite_definition_refs_to_empty_schemas`  (lines 376–400)

```
fn rewrite_definition_refs_to_empty_schemas(value: &mut JsonValue)
```

**Purpose**: Recursively replaces schemas whose `$ref` points to a local definition table entry with `{}`.

**Data flow**: Walks a mutable `JsonValue`. Arrays recurse into elements. For objects, if `$ref` exists and `parse_local_definition_ref` recognizes it as a local `$defs` or `definitions` pointer, the entire current value is replaced with `json!({})` and recursion stops for that branch. Otherwise it recurses into child schemas via `for_each_schema_child_mut` with definition traversal skipped.

**Call relations**: Called by `drop_schema_definitions` before root definitions are removed. It intentionally skips traversing definition tables themselves because the goal is to neutralize references from the retained schema surface, not to rewrite the definitions being dropped.

*Call graph*: calls 1 internal fn (for_each_schema_child_mut); called by 1 (drop_schema_definitions); 1 external calls (json!).


##### `collapse_deep_schema_objects`  (lines 402–421)

```
fn collapse_deep_schema_objects(value: &mut JsonValue, depth: usize)
```

**Purpose**: Recursively collapses complex schema objects beyond a configured depth limit into empty permissive schemas.

**Data flow**: Accepts a mutable `JsonValue` and current depth. Arrays recurse at the same depth for each element. For objects, if `depth >= MAX_COMPACT_TOOL_SCHEMA_DEPTH` and `is_complex_schema_object(map)` is true, it replaces the entire object with `json!({})`; otherwise it recurses into child schemas via `for_each_schema_child_mut` with definitions skipped, incrementing depth by one.

**Call relations**: This is the deep-structure compaction worker invoked by `collapse_deep_schema_objects_from_root` and directly by tests. It relies on `is_complex_schema_object` to distinguish schemas worth collapsing from simple scalar leaves.

*Call graph*: calls 2 internal fn (for_each_schema_child_mut, is_complex_schema_object); called by 1 (collapse_deep_schema_objects_from_root); 1 external calls (json!).


##### `prune_schema_compositions`  (lines 423–442)

```
fn prune_schema_compositions(value: &mut JsonValue)
```

**Purpose**: Recursively replaces any schema object containing `anyOf`, `oneOf`, or `allOf` with an empty schema as a last-resort compaction step.

**Data flow**: Mutates a `JsonValue` in place. Arrays recurse into elements. For objects, if `has_composition_keyword(map)` is true, the whole object becomes `json!({})`; otherwise it recurses into child schemas via `for_each_schema_child_mut` with definitions skipped.

**Call relations**: This is the final compaction pass, used only if earlier passes still leave the schema over budget. It depends on `has_composition_keyword` to identify composition nodes and intentionally sacrifices structural detail for size.

*Call graph*: calls 2 internal fn (for_each_schema_child_mut, has_composition_keyword); 1 external calls (json!).


##### `is_complex_schema_object`  (lines 444–449)

```
fn is_complex_schema_object(map: &serde_json::Map<String, JsonValue>) -> bool
```

**Purpose**: Determines whether a schema object contains nested structure significant enough to be collapsed during deep compaction.

**Data flow**: Reads a JSON object map and returns true if it contains any child-bearing schema keys (`items`, `anyOf`, `oneOf`, `allOf`), `properties`, `additionalProperties`, or `$ref`; otherwise returns false.

**Call relations**: Used only by `collapse_deep_schema_objects` to decide whether an object beyond the depth threshold should be replaced with `{}`.

*Call graph*: called by 1 (collapse_deep_schema_objects); 1 external calls (contains_key).


##### `has_composition_keyword`  (lines 451–455)

```
fn has_composition_keyword(map: &serde_json::Map<String, JsonValue>) -> bool
```

**Purpose**: Checks whether a schema object contains any composition keyword that should be preserved normally or pruned during last-resort compaction.

**Data flow**: Reads a JSON object map and returns true if any of `anyOf`, `oneOf`, or `allOf` is present.

**Call relations**: This predicate is used in two distinct contexts: `sanitize_json_schema` uses it to preserve composition-only schemas without forcing a `type`, while `prune_schema_compositions` uses it to identify nodes to erase when compacting oversized schemas.

*Call graph*: called by 2 (prune_schema_compositions, sanitize_json_schema).


##### `sanitize_json_schema`  (lines 466–544)

```
fn sanitize_json_schema(value: &mut JsonValue)
```

**Purpose**: Recursively lowers arbitrary JSON Schema fragments into the crate’s supported subset by coercing unsupported forms, inferring missing types, preserving refs/compositions, and filling required child defaults.

**Data flow**: Mutates a `JsonValue` in place. Boolean schemas become `{ "type": "string" }`. Arrays recurse into elements. Objects recurse into `properties`, `items`, schema-valued `additionalProperties`, `prefixItems`, composition arrays, and definition tables via `sanitize_schema_table`; rewrite `const` into single-element `enum`; compute normalized primitive types from `type`; if no types are present but `$ref` or a composition keyword exists, leave the object structurally intact; otherwise infer object/array/string/number types from keywords, or clear the map to `{}` if no recognized hints exist. Finally it writes normalized `type` back with `write_schema_types` and inserts default empty `properties` or default string `items` via `ensure_default_children_for_schema_types`.

**Call relations**: This is the core normalization routine called by `prepare_tool_input_schema` and recursively by `sanitize_schema_table`. It depends on helper predicates and writers to keep type inference, child defaults, and definition-table handling consistent across nested schemas.

*Call graph*: calls 5 internal fn (ensure_default_children_for_schema_types, has_composition_keyword, normalized_schema_types, sanitize_schema_table, write_schema_types); called by 2 (prepare_tool_input_schema, sanitize_schema_table); 4 external calls (Array, json!, matches!, vec!).


##### `sanitize_schema_table`  (lines 552–567)

```
fn sanitize_schema_table(map: &mut serde_json::Map<String, JsonValue>, key: &str)
```

**Purpose**: Validates and recursively sanitizes a `$defs` or `definitions` table, dropping the table entirely if it is malformed.

**Data flow**: Given a mutable schema object map and a table key, it inspects `map[key]`. If the value is an object, it iterates through each definition value and calls `sanitize_json_schema` on it. If the value exists but is not an object, it removes the table from the map. Missing tables are left untouched.

**Call relations**: Called from `sanitize_json_schema` for both supported definition-table keys. It ensures invalid definition tables degrade gracefully instead of causing parse failure.

*Call graph*: calls 1 internal fn (sanitize_json_schema); called by 1 (sanitize_json_schema); 2 external calls (get_mut, remove).


##### `ensure_default_children_for_schema_types`  (lines 569–583)

```
fn ensure_default_children_for_schema_types(
    map: &mut serde_json::Map<String, JsonValue>,
    schema_types: &[JsonSchemaPrimitiveType],
)
```

**Purpose**: Adds required child schema placeholders for object and array types when those child fields are absent.

**Data flow**: Takes a mutable schema object map and a slice of normalized primitive types. If the types include `Object` and `properties` is missing, it inserts an empty object map under `properties`. If the types include `Array` and `items` is missing, it inserts `json!({ "type": "string" })` under `items`.

**Call relations**: Called by `sanitize_json_schema` after type inference/normalization. It enforces the invariant that object and array schemas deserialize into the internal representation with explicit child placeholders.

*Call graph*: called by 1 (sanitize_json_schema); 6 external calls (Object, contains_key, insert, json!, new, contains).


##### `prune_unreachable_definitions`  (lines 593–602)

```
fn prune_unreachable_definitions(value: &mut JsonValue)
```

**Purpose**: Removes root definition entries that are never referenced from the reachable schema surface.

**Data flow**: Computes a `BTreeSet<DefinitionPointer>` of reachable definitions via `collect_reachable_definitions`. If the root value is an object, it then calls `prune_schema_table` for both `$defs` and `definitions`, mutating those tables in place and removing them entirely if emptied.

**Call relations**: This pruning stage is called by `prepare_tool_input_schema` after sanitization. It reduces token usage while preserving all definitions reachable through local refs, including cyclic and nested-pointer cases.

*Call graph*: calls 2 internal fn (collect_reachable_definitions, prune_schema_table); called by 1 (prepare_tool_input_schema).


##### `prune_schema_table`  (lines 604–623)

```
fn prune_schema_table(
    map: &mut serde_json::Map<String, JsonValue>,
    table: &'static str,
    reachable: &BTreeSet<DefinitionPointer>,
)
```

**Purpose**: Filters a single root definition table down to only the entries present in the reachable-definition set.

**Data flow**: Looks up a mutable object-valued definition table under the given key. It retains only entries whose `(table, name)` pair exists in the provided `BTreeSet<DefinitionPointer>`. If the table becomes empty, it removes the table key from the root map.

**Call relations**: Used by `prune_unreachable_definitions` for both `$defs` and `definitions`. It performs the actual in-place retention/removal once reachability has been computed.

*Call graph*: called by 1 (prune_unreachable_definitions); 2 external calls (get_mut, remove).


##### `collect_reachable_definitions`  (lines 625–642)

```
fn collect_reachable_definitions(value: &JsonValue) -> BTreeSet<DefinitionPointer>
```

**Purpose**: Computes the transitive closure of local definition entries reachable from refs in the schema outside definitions and within referenced definitions.

**Data flow**: Initializes empty `BTreeSet` and pending stack, seeds the stack by calling `collect_refs_outside_definitions`, then repeatedly pops `DefinitionPointer`s. Newly seen pointers are inserted into the reachable set; for each, `definition_for_pointer` looks up the target definition in the root schema, and `collect_refs` scans that definition for further local refs to push. It returns the final reachable set.

**Call relations**: This is the reachability engine used by `prune_unreachable_definitions`. It separates initial refs from the main schema surface from recursive refs discovered inside definitions, which lets it handle cycles safely by checking the reachable set before revisiting.

*Call graph*: calls 3 internal fn (collect_refs, collect_refs_outside_definitions, definition_for_pointer); called by 1 (prune_unreachable_definitions); 2 external calls (new, new).


##### `collect_refs_outside_definitions`  (lines 644–659)

```
fn collect_refs_outside_definitions(value: &JsonValue, refs: &mut Vec<DefinitionPointer>)
```

**Purpose**: Traverses the schema surface while intentionally skipping root definition tables, collecting local definition refs that originate outside those tables.

**Data flow**: Recurses through a `JsonValue`: arrays recurse into elements; objects first inspect themselves with `collect_ref_from_map`, then traverse recognized child schemas via `for_each_schema_child` with `DefinitionTraversal::Skip`, pushing any discovered `DefinitionPointer`s into the provided vector.

**Call relations**: Called only by `collect_reachable_definitions` to seed the pending worklist. Its skip-definitions behavior prevents every definition from being treated as reachable merely because it exists at the root.

*Call graph*: calls 2 internal fn (collect_ref_from_map, for_each_schema_child); called by 1 (collect_reachable_definitions).


##### `collect_refs`  (lines 661–676)

```
fn collect_refs(value: &JsonValue, refs: &mut Vec<DefinitionPointer>)
```

**Purpose**: Recursively collects all local definition refs from an arbitrary schema subtree, including refs nested inside definitions.

**Data flow**: Walks a `JsonValue`: arrays recurse into elements; objects inspect themselves with `collect_ref_from_map` and then recurse into all map values, not just recognized schema-child keys. Any recognized local refs are appended to the provided vector.

**Call relations**: Used by `collect_reachable_definitions` after a specific definition has been marked reachable. Unlike `collect_refs_outside_definitions`, it traverses all values because once inside a definition, nested refs anywhere in that definition should count.

*Call graph*: calls 1 internal fn (collect_ref_from_map); called by 1 (collect_reachable_definitions).


##### `collect_ref_from_map`  (lines 678–687)

```
fn collect_ref_from_map(
    map: &serde_json::Map<String, JsonValue>,
    refs: &mut Vec<DefinitionPointer>,
)
```

**Purpose**: Extracts a local definition pointer from a schema object’s `$ref` field, if present and parseable.

**Data flow**: Reads `$ref` from a JSON object map. If it is a string and `parse_local_definition_ref` recognizes it as a local `$defs` or `definitions` pointer, it pushes the resulting `DefinitionPointer` into the supplied vector; otherwise it does nothing.

**Call relations**: This small helper is shared by both ref-collection traversals. It isolates the parsing rule for which refs contribute to definition reachability.

*Call graph*: calls 1 internal fn (parse_local_definition_ref); called by 2 (collect_refs, collect_refs_outside_definitions); 1 external calls (get).


##### `definition_for_pointer`  (lines 689–700)

```
fn definition_for_pointer(
    value: &'a JsonValue,
    pointer: &DefinitionPointer,
) -> Option<&'a JsonValue>
```

**Purpose**: Looks up the JSON value for a specific reachable-definition pointer in the root schema.

**Data flow**: Given the root `JsonValue` and a `DefinitionPointer`, it requires the root to be an object, then indexes into the indicated table (`$defs` or `definitions`), treats that table as an object, and returns the named definition value if present.

**Call relations**: Called by `collect_reachable_definitions` when expanding the transitive closure of reachable definitions. Missing targets simply terminate that branch without error.

*Call graph*: called by 1 (collect_reachable_definitions).


##### `parse_local_definition_ref`  (lines 702–720)

```
fn parse_local_definition_ref(schema_ref: &str) -> Option<DefinitionPointer>
```

**Purpose**: Parses a `$ref` string into a root definition-table/name pair when it points to a local `$defs` or `definitions` entry.

**Data flow**: Accepts a ref string, requires a leading `#`, percent-decodes the fragment, parses it as a JSON Pointer, extracts the first token as the table name and validates it against `$defs`/`definitions`, then extracts the next token as the definition name. It returns `Some(DefinitionPointer)` for recognized local refs, including nested pointers whose parent definition should be retained, or `None` for external/unparseable refs.

**Call relations**: Used by both reachability collection and ref-rewriting logic. Its handling of percent decoding before JSON Pointer parsing is what lets reachable-definition pruning recognize encoded names correctly.

*Call graph*: called by 1 (collect_ref_from_map); 2 external calls (parse, decode).


##### `normalized_schema_types`  (lines 722–738)

```
fn normalized_schema_types(
    map: &serde_json::Map<String, JsonValue>,
) -> Vec<JsonSchemaPrimitiveType>
```

**Purpose**: Reads a schema object’s `type` field and converts supported primitive type names into the internal enum list.

**Data flow**: Looks up `map["type"]`. If absent, returns an empty vector. If it is a string, converts it through `schema_type_from_str` and returns either a singleton vector or empty. If it is an array, filters string elements through `schema_type_from_str` and collects the recognized primitive types. Non-string/non-array forms yield an empty vector.

**Call relations**: Called by `sanitize_json_schema` before type inference. It normalizes both single and union `type` declarations into a common internal list for later rewriting and child-default insertion.

*Call graph*: calls 1 internal fn (schema_type_from_str); called by 1 (sanitize_json_schema); 2 external calls (get, new).


##### `write_schema_types`  (lines 740–768)

```
fn write_schema_types(
    map: &mut serde_json::Map<String, JsonValue>,
    schema_types: &[JsonSchemaPrimitiveType],
)
```

**Purpose**: Writes a normalized primitive-type list back into a schema object’s `type` field in canonical JSON form.

**Data flow**: Takes a mutable schema object map and a slice of primitive types. For an empty slice it removes `type`; for a single type it inserts a string type name from `schema_type_name`; for multiple types it inserts an array of those string names. It mutates the map in place and returns unit.

**Call relations**: Used by `sanitize_json_schema` after type inference and normalization. It ensures the outgoing JSON shape matches what `JsonSchemaType` expects during deserialization.

*Call graph*: calls 1 internal fn (schema_type_name); called by 1 (sanitize_json_schema); 5 external calls (Array, String, insert, remove, iter).


##### `schema_type_from_str`  (lines 770–781)

```
fn schema_type_from_str(schema_type: &str) -> Option<JsonSchemaPrimitiveType>
```

**Purpose**: Maps a JSON Schema primitive type name string to the corresponding internal enum variant.

**Data flow**: Matches the input `&str` against the supported names `string`, `number`, `boolean`, `integer`, `object`, `array`, and `null`, returning `Some(JsonSchemaPrimitiveType)` for recognized names and `None` otherwise.

**Call relations**: This parser is used by `normalized_schema_types` to discard unsupported or legacy `type` strings while preserving the supported subset.

*Call graph*: called by 1 (normalized_schema_types).


##### `schema_type_name`  (lines 783–793)

```
fn schema_type_name(schema_type: JsonSchemaPrimitiveType) -> &'static str
```

**Purpose**: Returns the canonical lowercase JSON Schema type name for an internal primitive type enum.

**Data flow**: Matches a `JsonSchemaPrimitiveType` and returns the corresponding `&'static str` such as `"string"` or `"object"`.

**Call relations**: Used by `write_schema_types` when serializing normalized primitive-type lists back into JSON.

*Call graph*: called by 1 (write_schema_types).


##### `singleton_null_schema_error`  (lines 795–800)

```
fn singleton_null_schema_error() -> serde_json::Error
```

**Purpose**: Constructs the specific serde error used when a tool input schema is exactly `type: null`.

**Data flow**: Creates an `std::io::Error` with kind `InvalidInput` and the fixed message `tool input schema must not be a singleton null type`, wraps it with `serde_json::Error::io`, and returns that error.

**Call relations**: Called only by `deserialize_tool_input_schema` when post-deserialization validation detects the forbidden singleton-null case.

*Call graph*: called by 1 (deserialize_tool_input_schema); 2 external calls (io, new).


### `tools/src/mcp_tool.rs`

`domain_logic` · `tool registration`

This file bridges `rmcp::model::Tool` values into internal tool definitions. `parse_mcp_tool` begins by cloning the MCP tool’s `input_schema` object into a mutable `serde_json::Value`. Before parsing, it applies a compatibility fix: if the top-level schema object lacks `properties` or explicitly sets it to `null`, it inserts an empty object. That mirrors Agents SDK behavior and satisfies OpenAI models that require a `properties` field on object schemas. The adjusted schema is then parsed through the shared `parse_tool_input_schema` pipeline, so all of the sanitizer, definition-pruning, and compaction logic from `json_schema.rs` applies to MCP inputs as well.

For outputs, the function does not sanitize or infer structure. Instead it clones the MCP `output_schema` if present, or uses `{}` when absent, and passes that raw JSON into `mcp_call_tool_result_output_schema`. That helper constructs a fixed envelope schema with `content` (required array of objects), `structuredContent` (the MCP-provided schema inserted verbatim), `isError` (boolean), and `_meta` (object), with `additionalProperties: false`. The resulting `ToolDefinition` always has `defer_loading: false`, uses the MCP tool’s name and optional description, and always includes an output schema wrapped in that envelope.

#### Function details

##### `parse_mcp_tool`  (lines 6–37)

```
fn parse_mcp_tool(tool: &rmcp::model::Tool) -> Result<ToolDefinition, serde_json::Error>
```

**Purpose**: Parses an MCP tool into an internal `ToolDefinition`, patching missing top-level input `properties` and wrapping the output schema in the standard MCP call-result envelope.

**Data flow**: Takes `&rmcp::model::Tool`, clones `tool.input_schema` into a mutable `serde_json::Value::Object`, inserts `properties: {}` if the top-level object lacks `properties` or has it as `null`, then parses that JSON with `parse_tool_input_schema` to produce the internal `input_schema`. It clones `tool.output_schema` into a raw `JsonValue::Object` when present or uses an empty object otherwise, wraps it with `mcp_call_tool_result_output_schema`, and returns a `ToolDefinition` populated with the tool’s name, optional description (defaulting to empty string), parsed input schema, wrapped output schema, and `defer_loading: false`.

**Call relations**: This is the main MCP conversion entrypoint used when importing tools from MCP servers. It delegates schema normalization to the shared parser for inputs and delegates output-envelope construction to `mcp_call_tool_result_output_schema`.

*Call graph*: calls 1 internal fn (mcp_call_tool_result_output_schema); 3 external calls (parse_tool_input_schema, new, Object).


##### `mcp_call_tool_result_output_schema`  (lines 39–60)

```
fn mcp_call_tool_result_output_schema(structured_content_schema: JsonValue) -> JsonValue
```

**Purpose**: Builds the fixed JSON schema for MCP call results, embedding the provided structured-content schema under `structuredContent`.

**Data flow**: Consumes a `JsonValue` representing the MCP tool’s structured output schema and returns a new JSON object literal with `type: object`, `properties.content` as an array of objects, `properties.structuredContent` set to the supplied schema, `properties.isError` as boolean, `properties._meta` as object, `required: ["content"]`, and `additionalProperties: false`.

**Call relations**: Called by `parse_mcp_tool` for every parsed MCP tool. It isolates the envelope shape so tests and callers can rely on one canonical output-schema wrapper.

*Call graph*: called by 1 (parse_mcp_tool); 1 external calls (json!).


### Handler utilities
This module provides the shared handler wiring and helper routines that concrete tool implementations rely on during guarded execution.

### `core/src/tools/handlers/mod.rs`

`util` · `cross-cutting`

This module is the hub for the `tools::handlers` subtree. At the top it declares and re-exports many concrete handler modules so the rest of the system can construct and register tools from one place. Beyond module plumbing, it contains several cross-cutting helpers that many handlers rely on.

The parsing helpers convert raw function-call JSON into typed Rust values and rewrite argument objects when hooks need to inject or replace fields. `parse_arguments` wraps `serde_json::from_str` and standardizes parse failures into `FunctionCallError::RespondToModel`. `rewrite_function_arguments` insists the decoded JSON is an object before mutating it through a caller-supplied closure, and `rewrite_function_string_argument` is a convenience wrapper for replacing one string field. `parse_arguments_with_base_path` temporarily installs an `AbsolutePathBufGuard` so relative paths deserialize against a chosen base directory. `resolve_workdir_base_path` extracts an optional `workdir` string and joins it onto the default cwd, while `resolve_tool_environment` maps an optional environment id to either the primary turn environment or a matching named environment, failing with a model-facing error if unknown.

The other major responsibility is permission handling for exec-like tools. `normalize_and_validate_additional_permissions` enforces feature flags, approval-policy constraints, and non-empty normalized permission requests. `EffectiveAdditionalPermissions` carries the merged result. `implicit_granted_permissions` exposes sticky grants only when the current request did not explicitly ask for additional permissions, and `apply_granted_turn_permissions` merges inline requests with session/turn grants, upgrades sandbox mode when needed, and marks whether the effective permissions are already preapproved using `permissions_are_preapproved`. The embedded tests focus on these permission edge cases, especially the distinction between fresh inline requests and previously granted permissions.

#### Function details

##### `parse_arguments`  (lines 80–87)

```
fn parse_arguments(arguments: &str) -> Result<T, FunctionCallError>
```

**Purpose**: Parses a raw JSON argument string into any requested deserializable type and converts parse failures into model-facing function-call errors.

**Data flow**: It takes `arguments: &str`, passes it to `serde_json::from_str`, and returns `Result<T, FunctionCallError>`. On success it yields the deserialized value; on failure it formats the serde error into `FunctionCallError::RespondToModel`.

**Call relations**: This is a widely shared helper invoked by multiple handlers, argument-rewriting utilities, and path-resolution helpers. It centralizes JSON parse error wording so callers do not each implement their own conversion.

*Call graph*: called by 12 (handle_call, parse_arguments_with_base_path, handle_call, handle_call, handle_call, resolve_workdir_base_path, rewrite_function_arguments, handle, handle_call, handle_call (+2 more)); 1 external calls (from_str).


##### `updated_hook_command`  (lines 89–98)

```
fn updated_hook_command(updated_input: &Value) -> Result<&str, FunctionCallError>
```

**Purpose**: Extracts the rewritten command string from a hook-produced JSON object and errors if the expected field is missing or not a string.

**Data flow**: It reads `updated_input["command"]`, attempts to view it as `&str`, and returns that borrowed string on success. If the field is absent or non-string, it returns `FunctionCallError::RespondToModel` with a specific diagnostic.

**Call relations**: Called from hook-update flows elsewhere in the handlers module when a hook returns modified input. It does not delegate beyond JSON field access.

*Call graph*: called by 3 (with_updated_hook_input, with_updated_hook_input, with_updated_hook_input); 1 external calls (get).


##### `rewrite_function_arguments`  (lines 100–117)

```
fn rewrite_function_arguments(
    arguments: &str,
    tool_name: &str,
    rewrite: impl FnOnce(&mut Map<String, Value>),
) -> Result<String, FunctionCallError>
```

**Purpose**: Parses a function-call argument payload as a JSON object, lets the caller mutate that object, and serializes the rewritten arguments back to a string.

**Data flow**: It accepts the original argument string, a `tool_name` for error messages, and a closure `rewrite` that mutates a `Map<String, Value>`. It parses the string via `parse_arguments`, verifies the result is a `Value::Object`, applies the closure, serializes the modified object with `serde_json::to_string`, and returns the new JSON string or a `FunctionCallError` if parsing, shape validation, or serialization fails.

**Call relations**: Used by `rewrite_function_string_argument` as the generic object-rewrite primitive. It is part of hook/input-rewriting flows where handlers need to patch arguments before execution.

*Call graph*: calls 1 internal fn (parse_arguments); called by 1 (rewrite_function_string_argument); 3 external calls (format!, to_string, RespondToModel).


##### `rewrite_function_string_argument`  (lines 119–128)

```
fn rewrite_function_string_argument(
    arguments: &str,
    tool_name: &str,
    field_name: &str,
    value: &str,
) -> Result<String, FunctionCallError>
```

**Purpose**: Convenience wrapper that rewrites one named argument field to a specific string value inside a JSON object payload.

**Data flow**: It takes the original argument JSON, tool name, target field name, and replacement string, then calls `rewrite_function_arguments` with a closure that inserts `Value::String(value.to_string())` under the given field. It returns the rewritten JSON string or the propagated error.

**Call relations**: Invoked by hook-update paths that need to replace a single string argument. It delegates all parsing, object validation, and serialization to `rewrite_function_arguments`.

*Call graph*: calls 1 internal fn (rewrite_function_arguments); called by 2 (with_updated_hook_input, with_updated_hook_input).


##### `parse_arguments_with_base_path`  (lines 130–139)

```
fn parse_arguments_with_base_path(
    arguments: &str,
    base_path: &AbsolutePathBuf,
) -> Result<T, FunctionCallError>
```

**Purpose**: Deserializes arguments while temporarily setting a base absolute path so relative-path-aware types resolve against the intended directory.

**Data flow**: It takes the raw argument string and a base `AbsolutePathBuf`, creates an `AbsolutePathBufGuard` for that base path, then calls `parse_arguments(arguments)` and returns the parsed value. The guard’s scope ensures path resolution context is active only during deserialization.

**Call relations**: Called by handlers that deserialize path-bearing arguments. It layers path-context setup around the generic `parse_arguments` helper.

*Call graph*: calls 2 internal fn (parse_arguments, new); called by 3 (handle_call, handle_call, handle_call).


##### `resolve_workdir_base_path`  (lines 141–151)

```
fn resolve_workdir_base_path(
    arguments: &str,
    default_cwd: &AbsolutePathBuf,
) -> Result<AbsolutePathBuf, FunctionCallError>
```

**Purpose**: Determines the effective working-directory base path for a tool call from its optional `workdir` argument.

**Data flow**: It parses the raw arguments into `serde_json::Value`, reads the `workdir` field if present and non-empty, and returns either `default_cwd.clone()` or `default_cwd.join(workdir)`. Parse failures become `FunctionCallError` via `parse_arguments`.

**Call relations**: Used by handlers that need to interpret relative working directories before executing commands or file operations. It depends on `parse_arguments` for JSON decoding.

*Call graph*: calls 1 internal fn (parse_arguments); called by 1 (handle_call).


##### `resolve_tool_environment`  (lines 153–172)

```
fn resolve_tool_environment(
    turn: &'a TurnContext,
    environment_id: Option<&str>,
) -> Result<Option<&'a TurnEnvironment>, FunctionCallError>
```

**Purpose**: Maps an optional environment id to the corresponding `TurnEnvironment`, defaulting to the primary environment when no id is supplied.

**Data flow**: It takes a `TurnContext` and optional `environment_id`. If the id is `None`, it returns `turn.environments.primary()`. If present, it searches `turn.environments.turn_environments` for a matching `environment_id` and returns `Some(&TurnEnvironment)` or a `FunctionCallError::RespondToModel` if no match exists.

**Call relations**: Called by several handlers that can target alternate execution environments. It is a pure lookup helper that keeps unknown-environment error handling consistent.

*Call graph*: called by 4 (handle_call, handle_call, handle_call, handle_call).


##### `normalize_and_validate_additional_permissions`  (lines 176–229)

```
fn normalize_and_validate_additional_permissions(
    additional_permissions_allowed: bool,
    approval_policy: AskForApproval,
    sandbox_permissions: SandboxPermissions,
    additional_permissions
```

**Purpose**: Validates whether inline additional-permission requests are allowed under current feature flags and approval policy, normalizes the requested profile, and rejects malformed or disallowed combinations.

**Data flow**: Inputs are booleans for feature enablement and preapproval, the current `AskForApproval` policy, requested `SandboxPermissions`, optional `AdditionalPermissionProfile`, and cwd. It first determines whether the sandbox mode implies additional permissions, then enforces that fresh requests are blocked when the feature is disabled, that `WithAdditionalPermissions` requires `AskForApproval::OnRequest` unless already preapproved, that a permission profile is present and non-empty when required, and that `additional_permissions` is absent when sandbox mode does not request them. It returns `Ok(Some(normalized_profile))`, `Ok(None)`, or a descriptive `Err(String)`.

**Call relations**: Used by permission-sensitive handlers and directly exercised by tests in this module. It delegates normalization details to `normalize_additional_permissions` but owns the policy/feature gating logic.

*Call graph*: calls 1 internal fn (normalize_additional_permissions); called by 2 (fresh_additional_permissions_still_require_exec_permission_approvals_feature, preapproved_permissions_work_when_request_permissions_tool_is_enabled_without_exec_permission_approvals_feature); 2 external calls (format!, matches!).


##### `implicit_granted_permissions`  (lines 237–252)

```
fn implicit_granted_permissions(
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<&AdditionalPermissionProfile>,
    effective_additional_permissions: &EffectiveAddition
```

**Purpose**: Determines whether previously granted additional permissions should be implicitly reused for the current tool call when the call itself did not explicitly request them.

**Data flow**: It takes the requested `sandbox_permissions`, any explicit `additional_permissions`, and the already computed `EffectiveAdditionalPermissions`. If the current request neither uses additional permissions nor requires escalation and no explicit additional profile was supplied, it clones and returns the effective additional permissions; otherwise it returns `None`.

**Call relations**: Called from exec-like flows and tested here to distinguish sticky grants from explicit inline requests. It relies on `SandboxPermissions::uses_additional_permissions` and simple branching rather than external services.

*Call graph*: calls 1 internal fn (uses_additional_permissions); called by 4 (run_exec_like, explicit_inline_permissions_do_not_use_implicit_sticky_grant_path, implicit_sticky_grants_bypass_inline_permission_validation, handle_call); 1 external calls (matches!).


##### `apply_granted_turn_permissions`  (lines 254–298)

```
async fn apply_granted_turn_permissions(
    session: &Session,
    environment_id: &str,
    cwd: &Path,
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<AdditionalPerm
```

**Purpose**: Combines inline requested permissions with session-level and turn-level granted permissions to compute the effective sandbox mode, merged permission profile, and whether the result is already preapproved.

**Data flow**: It receives a `Session`, target `environment_id`, cwd, requested `sandbox_permissions`, and optional inline `additional_permissions`. If the sandbox mode is `RequireEscalated`, it returns those values unchanged with `permissions_preapproved: false`. Otherwise it asynchronously fetches granted session and turn permissions, merges them, merges inline permissions on top, computes `permissions_preapproved` by comparing effective versus granted permissions through `permissions_are_preapproved`, upgrades `sandbox_permissions` to `WithAdditionalPermissions` when effective permissions exist but the original mode did not request them, and returns an `EffectiveAdditionalPermissions` struct.

**Call relations**: Used by exec-like handlers and extension/tool-call conversion paths before validating or requesting permissions. It delegates profile merging to `merge_permission_profiles` and preapproval checking to `permissions_are_preapproved`.

*Call graph*: calls 3 internal fn (permissions_are_preapproved, uses_additional_permissions, merge_permission_profiles); called by 4 (effective_patch_permissions, to_extension_call, run_exec_like, handle_call); 3 external calls (granted_session_permissions, granted_turn_permissions, matches!).


##### `permissions_are_preapproved`  (lines 300–312)

```
fn permissions_are_preapproved(
    effective_permissions: &AdditionalPermissionProfile,
    granted_permissions: AdditionalPermissionProfile,
    cwd: &Path,
) -> bool
```

**Purpose**: Checks whether the effective permission profile is fully covered by an already granted profile after path materialization.

**Data flow**: It takes `effective_permissions`, `granted_permissions`, and cwd, materializes the effective profile by intersecting it with itself, intersects the effective profile with the granted profile, and returns whether those two intersections are equal. This accounts for path/glob normalization effects.

**Call relations**: Called only by `apply_granted_turn_permissions` to decide whether a merged permission set should count as preapproved. Its logic is specifically tested for relative deny-glob behavior in this module’s tests.

*Call graph*: calls 1 internal fn (intersect_permission_profiles); called by 1 (apply_granted_turn_permissions); 1 external calls (clone).


##### `tests::network_permissions`  (lines 336–343)

```
fn network_permissions() -> AdditionalPermissionProfile
```

**Purpose**: Builds a minimal `AdditionalPermissionProfile` fixture that enables network access.

**Data flow**: It constructs and returns an `AdditionalPermissionProfile` with `network.enabled = Some(true)` and all other fields from `Default::default()`.

**Call relations**: Used by permission-validation tests in this module to avoid repeating fixture setup.

*Call graph*: 1 external calls (default).


##### `tests::file_system_permissions`  (lines 345–355)

```
fn file_system_permissions(path: &std::path::Path) -> AdditionalPermissionProfile
```

**Purpose**: Builds a file-system permission fixture granting read/write access rooted at the supplied path.

**Data flow**: It takes a filesystem path, converts it to `AbsolutePathBuf`, creates `FileSystemPermissions::from_read_write_roots` with that path in the write roots, and returns an `AdditionalPermissionProfile` containing that file-system profile plus default values for other fields.

**Call relations**: Shared by tests that exercise sticky grants and explicit inline permission behavior.

*Call graph*: calls 1 internal fn (from_read_write_roots); 2 external calls (default, vec!).


##### `tests::preapproved_permissions_work_when_request_permissions_tool_is_enabled_without_exec_permission_approvals_feature`  (lines 358–379)

```
fn preapproved_permissions_work_when_request_permissions_tool_is_enabled_without_exec_permission_approvals_feature()
```

**Purpose**: Verifies that already preapproved additional permissions are accepted even when fresh inline permission requests are globally disabled.

**Data flow**: It creates a temporary directory, calls `normalize_and_validate_additional_permissions` with `additional_permissions_allowed = false`, a granular approval policy, `SandboxPermissions::WithAdditionalPermissions`, a network-permission fixture, and `permissions_preapproved = true`, then asserts the normalized result equals the original network profile.

**Call relations**: Run by the test harness to cover the preapproved-permissions exception path inside `normalize_and_validate_additional_permissions`.

*Call graph*: calls 1 internal fn (normalize_and_validate_additional_permissions); 4 external calls (Granular, assert_eq!, network_permissions, tempdir).


##### `tests::fresh_additional_permissions_still_require_exec_permission_approvals_feature`  (lines 382–399)

```
fn fresh_additional_permissions_still_require_exec_permission_approvals_feature()
```

**Purpose**: Checks that a new inline additional-permission request is rejected when the exec-permission-approvals feature is disabled.

**Data flow**: It creates a temp directory, calls `normalize_and_validate_additional_permissions` with `additional_permissions_allowed = false`, `AskForApproval::OnRequest`, `SandboxPermissions::WithAdditionalPermissions`, a network-permission fixture, and `permissions_preapproved = false`, captures the error, and asserts the exact rejection message.

**Call relations**: This test exercises the feature-gating branch of `normalize_and_validate_additional_permissions`.

*Call graph*: calls 1 internal fn (normalize_and_validate_additional_permissions); 3 external calls (assert_eq!, network_permissions, tempdir).


##### `tests::implicit_sticky_grants_bypass_inline_permission_validation`  (lines 402–416)

```
fn implicit_sticky_grants_bypass_inline_permission_validation()
```

**Purpose**: Verifies that previously granted permissions can be implicitly reused when the current request does not explicitly ask for additional permissions.

**Data flow**: It creates a temp directory, builds a granted file-system permission profile, calls `implicit_granted_permissions` with `SandboxPermissions::UseDefault`, no explicit additional permissions, and an `EffectiveAdditionalPermissions` containing the granted profile, then asserts the granted profile is returned.

**Call relations**: Run by the test harness to validate the sticky-grant branch of `implicit_granted_permissions`.

*Call graph*: calls 1 internal fn (implicit_granted_permissions); 3 external calls (assert_eq!, file_system_permissions, tempdir).


##### `tests::explicit_inline_permissions_do_not_use_implicit_sticky_grant_path`  (lines 419–433)

```
fn explicit_inline_permissions_do_not_use_implicit_sticky_grant_path()
```

**Purpose**: Ensures that when a call explicitly requests additional permissions, the implicit sticky-grant shortcut is not used.

**Data flow**: It creates a temp directory, builds a requested file-system permission profile, calls `implicit_granted_permissions` with `SandboxPermissions::WithAdditionalPermissions` and `Some(&requested_permissions)`, and asserts the result is `None`.

**Call relations**: This test covers the opposite branch from the sticky-grant case, confirming explicit requests are handled separately.

*Call graph*: calls 1 internal fn (implicit_granted_permissions); 3 external calls (assert_eq!, file_system_permissions, tempdir).


##### `tests::relative_deny_glob_grants_remain_preapproved_after_materialization`  (lines 436–472)

```
fn relative_deny_glob_grants_remain_preapproved_after_materialization()
```

**Purpose**: Checks that a granted permission profile containing a relative deny glob still counts as preapproved after path materialization and merging.

**Data flow**: It creates a temp directory, constructs an `AdditionalPermissionProfile` with a project-roots write entry and a `**/*.env` deny glob, materializes a stored grant by intersecting the profile with itself, merges the requested and stored profiles, and asserts `permissions_are_preapproved` returns true for the merged effective permissions.

**Call relations**: Executed by the test runner to validate the subtle path-materialization logic inside `permissions_are_preapproved`.

*Call graph*: calls 2 internal fn (intersect_permission_profiles, merge_permission_profiles); 4 external calls (default, assert!, tempdir, vec!).

## 📊 State Registers Touched

- `reg-execution-environment-snapshot` — The reusable picture of the local or remote shell environment, machine facts, and helper tool availability.
- `reg-effective-config` — The final merged settings from defaults, managed config, user files, project files, thread overrides, and command-line flags.
- `reg-plugin-catalog-and-snapshot` — The known plugins, hooks, marketplaces, and synced plugin snapshot available to the runtime.
- `reg-mcp-server-catalog` — The current set of configured MCP servers and their runtime launch details for routing tool calls.
- `reg-connector-and-app-catalog` — The merged list of external apps and connectors the system can use.
- `reg-skill-catalog-and-cache` — The loaded skills, their metadata, and cached skill data used for prompting and tool behavior.
- `reg-permission-profiles` — The resolved named and built-in permission profiles that say what kinds of actions are allowed.
- `reg-sandbox-and-exec-policy` — The concrete file, network, workspace-root, and command-execution safety rules enforced at runtime.
- `reg-windows-sandbox-accounts` — The local Windows sandbox user accounts and readiness state needed for sandboxed execution.
- `reg-active-session-object` — The long-lived session object that carries shared services and conversation state across many turns.
- `reg-session-permission-grants` — The remembered approvals and sticky permission grants that survive across turns in a session.
- `reg-turn-context-snapshot` — The immutable per-turn snapshot of settings, environment, permissions, model info, and services used during one turn.
- `reg-current-turn-state` — The mutable state for the active turn, including waiters, per-turn permissions, review flags, and interruption handling.
- `reg-code-mode-runtime-session` — The separate embedded code-execution runtime session used when code-mode tools participate in a turn.
- `reg-approval-and-review-state` — The shared state for pending approvals, guardian decisions, hook reviews, and user confirmations before actions run.
- `reg-tool-runtime-catalog` — The active set of tools, executors, adapters, and visibility rules available for this runtime.
- `reg-tool-execution-state` — The live state of running tool calls, including serialization, parallelism limits, and cancellation handling.
- `reg-memory-store-and-pipeline` — The stored memories and background memory-processing pipeline that extract and reuse important facts.
- `reg-network-client-stack` — The shared HTTP and transport client infrastructure used for requests, retries, cookies, streams, and relays.
- `reg-proxy-and-network-routing` — The current proxy rules and network-routing safety decisions that determine where traffic may go.
- `reg-observability-pipeline` — The shared traces, logs, and metrics pipeline that records what the system is doing across its lifetime.
- `reg-analytics-facts-and-batches` — The collected analytics facts and reduced event batches about turns, tools, and outcomes waiting to be sent.
- `reg-extension-runtime-state` — The typed shared storage where extensions keep host-provided values and their own runtime data.
- `reg-unified-exec-process-registry` — The live registry of spawned host processes, their identifiers, stdin/control channels, and watched exit state for long-running command execution.
- `reg-approved-command-prefixes` — The saved set of command prefixes previously approved by the user, reused to shape future prompt context and reduce repeat approval friction.
- `reg-connection-pool-and-session-cache` — The shared pool/cache of long-lived outbound service connections and session handles, especially for MCP and related transports, reused and refreshed across requests and threads.
- `reg-helper-materialization-cache` — The cached shared-sandbox/bin materialization state for bundled helper executables, especially on Windows, so later runs can reuse prepared helpers.
- `reg-workspace-trust-state` — The remembered trust/allowance state for the current workspace that influences onboarding, plugin enablement, and action policy across the session.
- `reg-connector-session-selections` — The live per-session selection and enablement state for which connectors/apps are active for a thread or session beyond the static connector catalog.
- `reg-turn-command-result-buffer` — The accumulated recent command/tool result fragments and warnings kept as reusable context material for subsequent prompt assembly within the active session.
- `reg-guardian-review-telemetry-context` — The in-flight guardian/review timing and correlation context that survives across approval handling and analytics emission for a turn.
