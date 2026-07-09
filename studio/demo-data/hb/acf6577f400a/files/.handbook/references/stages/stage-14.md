# Tool execution, approvals, and guarded side effects  `stage-14`

This stage is the system’s guarded action layer. It runs during the main work loop whenever the model asks to do something outside plain text, such as run a command, edit a file, call a web or MCP tool, use memory, or ask the user for approval. It is like a workshop with a front desk, safety officer, tool shelves, and locked work areas.

The approval, guardian, and hook parts decide whether an action may continue, needs user permission, or must be blocked. The execution backends then do the hands-on work: shell commands, interactive programs, file patches, sleeps, and remote or sandboxed file access. The extension tools connect extra equipment, including MCP servers, plugins, web, images, skills, and code cells. The policy and parsing helpers inspect commands and build the sandbox rules that limit what a tool can touch.

The shared tool files define the common shape of tools, their input schemas, MCP conversions, and error types. The handler front door routes each requested tool to the right runner and turns the result back into protocol messages the model can understand.

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

When the system lets a model call a tool, not every failure means the same thing. Sometimes the tool cannot complete the request, but the model can be told what went wrong and may recover or try something else. Other times, something more serious has happened and the system should treat it as a fatal failure.

This file captures that distinction in one shared error type, `FunctionCallError`. Think of it like a traffic signal for tool failures: one signal says “tell the model this message,” and the other says “stop, this is a serious problem.”

The `RespondToModel` case carries a plain message that is intended to be sent back to the model as the result of the failed tool call. The `Fatal` case also carries a message, but it is labeled as a fatal error when displayed. The `thiserror` library is used here to make these error values behave like normal Rust errors and to control how their messages are printed.

Without this file, different tool implementations might report failures in inconsistent ways. By using one shared error shape, the rest of the system can reliably decide whether to continue the conversation or treat the tool call as unrecoverable.


### `tools/src/tool_executor.rs`

`domain_logic` · `cross-cutting`

This file is like the service desk rules for tools. A tool is something the model can call to do work outside plain text, such as search, read data, or run some action. Without this shared contract, each tool could describe itself and run itself in a different way, making it hard for the host system to list tools, hide tools, search for tools, or call them safely.

The file defines two main ideas. `ToolExposure` says how visible a tool should be. Some tools are shown to the model right away, some are only discoverable later, some are kept out of special code-mode surfaces, and some are registered but hidden. This matters because not every available capability should be offered in every context.

`ToolExecutor` is a trait, meaning a promise that tool implementations must keep. Each tool must say its name, provide its model-facing specification, and know how to run when given an invocation. The trait also supplies sensible defaults: tools are directly visible unless they say otherwise, searchable information can be derived from the tool specification, and tools are assumed not to support parallel calls unless they opt in. The actual run result is returned asynchronously as a future, so slow work can happen without blocking the rest of the system.

#### Function details

##### `ToolExposure::is_direct`  (lines 39–41)

```
fn is_direct(self) -> bool
```

**Purpose**: This function answers a simple visibility question: should this tool be included in the model's initial visible tool list? It treats both fully direct tools and model-only direct tools as direct.

**Data flow**: It starts with one `ToolExposure` value. It checks whether that value is `Direct` or `DirectModelOnly`. It returns `true` for those two cases and `false` for deferred or hidden tools, without changing anything else.

**Call relations**: Code that builds the model-visible tool list can call this helper instead of repeating the same visibility check. Internally it uses Rust's pattern-matching shortcut to compare the exposure value against the direct cases.

*Call graph*: 1 external calls (matches!).


##### `ToolExecutor::exposure`  (lines 55–57)

```
fn exposure(&self) -> ToolExposure
```

**Purpose**: This default method says that a tool is directly visible unless the tool implementation chooses a different rule. It gives ordinary tools a simple default so they do not need to write boilerplate.

**Data flow**: It takes the tool executor object as input, but does not read any custom state. It returns `ToolExposure::Direct`, meaning the tool should appear in the initial model-visible list by default.

**Call relations**: When the host system asks a tool where it should be exposed, this method is used unless that tool overrides it. The returned value can then be checked by logic such as `ToolExposure::is_direct` when deciding what the model can see.


##### `ToolExecutor::search_info`  (lines 59–62)

```
fn search_info(&self) -> Option<ToolSearchInfo>
```

**Purpose**: This default method builds searchable metadata for a tool from its public tool specification. That lets deferred tools be discovered later without every tool having to hand-write separate search information.

**Data flow**: It asks the tool for its `ToolSpec`, which is the structured description of what the tool is and how to call it. It passes that specification, with no extra source information, into `ToolSearchInfo::from_tool_spec`. The result is either search metadata or nothing, depending on whether metadata can be derived.

**Call relations**: When a tool is registered for later discovery, the host can call this method to get information for search. This method hands the real conversion work to `from_tool_spec`, keeping the trait default short and tied to the same specification the model sees.

*Call graph*: calls 1 internal fn (from_tool_spec).


##### `ToolExecutor::supports_parallel_tool_calls`  (lines 64–66)

```
fn supports_parallel_tool_calls(&self) -> bool
```

**Purpose**: This default method says that a tool should not be called in parallel unless it explicitly opts in. This is a safety-first default, useful for tools that might touch shared state or depend on call order.

**Data flow**: It receives the tool executor object but does not inspect it. It returns `false`, meaning the system should assume parallel calls are not supported unless the tool overrides this answer.

**Call relations**: Scheduling or orchestration code can ask this method before running multiple calls at the same time. Tool implementations that are safe to run concurrently can override it; otherwise the default protects them from accidental parallel use.


### `tools/src/lib.rs`

`other` · `cross-cutting`

This file does not contain its own algorithms. Instead, it acts like a well-organized reception desk for the `tools` crate. The real work lives in nearby files such as tool definitions, tool execution, JSON schema parsing, response history trimming, plugin installation requests, and conversions into the Responses API format. This file declares those internal modules, then carefully re-exports selected names so outside code can import them from one place.

That matters because tool support is used across the project, not only inside `codex-core`. Without this file, other parts of the system would need to know the exact internal file layout and import from many separate modules. That would make the code harder to read and easier to break when files move around.

The exports cover several broad areas: describing tools, converting them for the Responses API, parsing dynamic and MCP tools, configuring shell execution, formatting tool output, searching or discovering installable tools, and keeping conversation history within size limits. In plain terms, this file defines the public menu of tool-building blocks available to the rest of the project.


### Schema and MCP adaptation
These files define how tool schemas are normalized and how MCP tool metadata is converted into the internal tool-definition format.

### `tools/src/json_schema.rs`

`domain_logic` · `tool schema parsing and tool registration`

Tools need a clear contract for their input: what fields exist, what type each field has, and which values are allowed. This file is that contract builder and gatekeeper. It defines Rust types for the JSON Schema subset the project supports, such as strings, numbers, arrays, objects, enums, references, and composition forms like “any of these shapes.”

When a tool schema arrives as raw JSON, the file first makes it compatible with this limited internal shape. It turns unsupported or shorthand schema features into safer equivalents, adds missing child schemas for objects and arrays, converts `const` into a one-value `enum`, and removes broken definition tables. It also follows local references, like shortcuts in the back of a book, and drops definitions that nothing uses.

For unusually large schemas, it performs best-effort shrinking. It removes descriptions, drops definition tables after neutralizing references, collapses deep nested structures, and finally removes complex composition blocks if needed. This preserves the top-level tool arguments as much as possible while avoiding oversized schema payloads.

Without this file, tool registration would be fragile: harmless schema variations could fail to parse, unused definitions could waste space, and oversized schemas could exceed API limits.

#### Function details

##### `JsonSchema::typed`  (lines 78–84)

```
fn typed(schema_type: JsonSchemaPrimitiveType, description: Option<String>) -> Self
```

**Purpose**: Builds a simple schema with exactly one JSON type, such as string, number, or object. Other constructor methods use it so they do not repeat the same setup.

**Data flow**: It receives a primitive type and an optional human description → puts those into a fresh mostly-empty `JsonSchema` → returns that ready-to-use schema value.

**Call relations**: This is the private helper behind the simple public constructors. Methods like `JsonSchema::boolean`, `JsonSchema::string`, `JsonSchema::number`, `JsonSchema::integer`, and `JsonSchema::null` call it when tool-building code asks for a basic input field.

*Call graph*: 2 external calls (default, Single).


##### `JsonSchema::any_of`  (lines 86–92)

```
fn any_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self
```

**Purpose**: Creates a schema saying an input may match any one of several possible shapes. This is useful when a field can validly be represented in multiple ways.

**Data flow**: It receives a list of variant schemas and an optional description → stores the variants under `anyOf` in a fresh schema → returns the combined schema.

**Call relations**: Tool-definition code can call this when it needs flexible input. It sits alongside `JsonSchema::one_of` and `JsonSchema::all_of` as the constructors for schema composition.

*Call graph*: 1 external calls (default).


##### `JsonSchema::one_of`  (lines 94–100)

```
fn one_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self
```

**Purpose**: Creates a schema saying an input should match exactly one of several possible shapes. It is for cases where alternatives are allowed but should not overlap.

**Data flow**: It receives variant schemas and an optional description → stores them under `oneOf` → returns a new schema with no unrelated fields filled in.

**Call relations**: This is one of the composition builders used by schema authors. Later parsing and sanitizing code knows to preserve this composition keyword instead of forcing a single plain type.

*Call graph*: 1 external calls (default).


##### `JsonSchema::all_of`  (lines 102–108)

```
fn all_of(variants: Vec<JsonSchema>, description: Option<String>) -> Self
```

**Purpose**: Creates a schema saying an input must satisfy all listed schemas at once. This is like combining several rule sheets into one.

**Data flow**: It receives a list of schemas and an optional description → stores the list under `allOf` → returns the combined schema.

**Call relations**: This constructor complements `any_of` and `one_of`. Sanitizing code recognizes `allOf` as a valid composition form and keeps it when preparing incoming schemas.

*Call graph*: 1 external calls (default).


##### `JsonSchema::boolean`  (lines 110–112)

```
fn boolean(description: Option<String>) -> Self
```

**Purpose**: Builds a schema for a true-or-false value. Tool builders use it for options and flags.

**Data flow**: It receives an optional description → asks `JsonSchema::typed` to make a Boolean schema → returns that schema.

**Call relations**: Many tool constructors call this when defining boolean parameters, such as wait/report/send-input and command-related tools. It delegates the shared construction work to `JsonSchema::typed`.

*Call graph*: called by 9 (create_wait_tool, create_report_agent_job_result_tool, create_send_input_tool_v1, spawn_agent_common_properties_v1, create_exec_command_tool_with_environment_id, create_shell_command_tool, network_permissions_schema, exec_command_tool_matches_expected_spec, shell_command_tool_matches_expected_spec); 1 external calls (typed).


##### `JsonSchema::string`  (lines 114–116)

```
fn string(description: Option<String>) -> Self
```

**Purpose**: Builds a schema for text. Tool builders use it for names, paths, commands, messages, and other textual inputs.

**Data flow**: It receives an optional description → calls `JsonSchema::typed` with the string type → returns the resulting schema.

**Call relations**: This is one of the most common schema constructors and is called throughout tool-definition code. It keeps those callers focused on the meaning of their fields instead of low-level JSON Schema formatting.

*Call graph*: called by 38 (create_wait_tool, create_report_agent_job_result_tool, create_spawn_agents_on_csv_tool, create_list_mcp_resource_templates_tool, create_list_mcp_resources_tool, create_read_mcp_resource_tool, create_close_agent_tool_v1, create_collab_input_items_schema, create_followup_task_tool, create_interrupt_agent_tool_v2 (+15 more)); 1 external calls (typed).


##### `JsonSchema::with_encrypted`  (lines 118–121)

```
fn with_encrypted(mut self) -> Self
```

**Purpose**: Marks a schema field as encrypted for response-only reviewed tool parameters. In plain terms, it tags sensitive input so downstream systems know it should be treated specially.

**Data flow**: It receives an existing schema value → sets its `encrypted` flag to true → returns the modified schema.

**Call relations**: This is a chaining helper: callers first build a normal schema and then add the encryption marker. It does not call other project helpers.


##### `JsonSchema::number`  (lines 123–125)

```
fn number(description: Option<String>) -> Self
```

**Purpose**: Builds a schema for a numeric value that may include decimals. Tool builders use it for counts, limits, timeouts, and similar values.

**Data flow**: It receives an optional description → calls `JsonSchema::typed` with the number type → returns the schema.

**Call relations**: Tool constructors for waiting, command execution, shell commands, user input, and related features call this when a parameter is numeric. The shared setup is handled by `JsonSchema::typed`.

*Call graph*: called by 14 (create_wait_tool, create_spawn_agents_on_csv_tool, wait_agent_tool_parameters_v1, wait_agent_tool_parameters_v2, create_request_user_input_tool, create_exec_command_tool_with_environment_id, create_shell_command_tool, create_write_stdin_tool, exec_command_tool_matches_expected_spec, shell_command_tool_matches_expected_spec (+4 more)); 1 external calls (typed).


##### `JsonSchema::integer`  (lines 127–129)

```
fn integer(description: Option<String>) -> Self
```

**Purpose**: Builds a schema for a whole number. This is for numeric fields where fractions are not allowed.

**Data flow**: It receives an optional description → creates an integer schema through `JsonSchema::typed` → returns it.

**Call relations**: It is used by goal-creation tool setup when an input must be a whole number. Like the other scalar constructors, it relies on `JsonSchema::typed`.

*Call graph*: called by 1 (create_create_goal_tool); 1 external calls (typed).


##### `JsonSchema::null`  (lines 131–133)

```
fn null(description: Option<String>) -> Self
```

**Purpose**: Builds a schema for the JSON value `null`, meaning an explicit empty value. This constructor exists for completeness, though top-level tool input schemas are not allowed to be only null.

**Data flow**: It receives an optional description → creates a null-typed schema through `JsonSchema::typed` → returns it.

**Call relations**: It shares construction with the other primitive builders. Later, `deserialize_tool_input_schema` rejects a schema if the whole tool input is just this singleton null type.

*Call graph*: 1 external calls (typed).


##### `JsonSchema::string_enum`  (lines 135–142)

```
fn string_enum(values: Vec<JsonValue>, description: Option<String>) -> Self
```

**Purpose**: Builds a text schema whose value must be one of a fixed list. This is useful for fields like mode, action, or status where only named choices are valid.

**Data flow**: It receives allowed JSON values and an optional description → creates a string schema and stores those values as its enum list → returns it.

**Call relations**: Tool constructors such as plan updates, approval parameters, image viewing, and goal updates call this to define choice fields. It avoids each caller hand-writing the same enum structure.

*Call graph*: called by 4 (create_update_plan_tool, create_approval_parameters, create_view_image_tool, create_update_goal_tool); 2 external calls (default, Single).


##### `JsonSchema::array`  (lines 144–151)

```
fn array(items: JsonSchema, description: Option<String>) -> Self
```

**Purpose**: Builds a schema for a list. It also records the schema for each item in that list.

**Data flow**: It receives an item schema and an optional description → wraps the item schema in a box and stores it under `items` → returns an array schema.

**Call relations**: Tool definitions call this for fields that contain repeated values, such as input items, plan steps, approvals, or permission lists. It uses the same single-type schema style as the primitive constructors.

*Call graph*: called by 6 (create_collab_input_items_schema, wait_agent_tool_parameters_v1, create_update_plan_tool, create_request_user_input_tool, create_approval_parameters, file_system_permissions_schema); 3 external calls (new, default, Single).


##### `JsonSchema::object`  (lines 153–165)

```
fn object(
        properties: BTreeMap<String, JsonSchema>,
        required: Option<Vec<String>>,
        additional_properties: Option<AdditionalProperties>,
    ) -> Self
```

**Purpose**: Builds a schema for an object, meaning a JSON value with named fields. It records which fields exist, which are required, and whether extra fields are allowed.

**Data flow**: It receives a map of property names to schemas, an optional required-field list, and an optional extra-properties rule → stores them in a new object schema → returns it.

**Call relations**: Most tool constructors call this to describe their top-level argument object or nested objects. It is the main building block for structured tool input.

*Call graph*: called by 38 (create_wait_tool, create_report_agent_job_result_tool, create_spawn_agents_on_csv_tool, described_object, create_get_context_remaining_tool, create_list_available_plugins_to_install_tool, create_list_mcp_resource_templates_tool, create_list_mcp_resources_tool, create_read_mcp_resource_tool, create_collab_input_items_schema (+15 more)); 2 external calls (default, Single).


##### `AdditionalProperties::from`  (lines 183–185)

```
fn from(value: JsonSchema) -> Self
```

**Purpose**: Converts a simple value into the `additionalProperties` form used by JSON Schema. This lets callers say either “extra fields are allowed/disallowed” or “extra fields must follow this schema.”

**Data flow**: It receives either a boolean or a `JsonSchema`, depending on the conversion being used → wraps the value in the matching enum form → returns an `AdditionalProperties` value.

**Call relations**: This supports ergonomic object-schema construction. Callers can pass plain booleans or schemas and have them turned into the internal representation automatically.

*Call graph*: 3 external calls (new, Boolean, Schema).


##### `parse_tool_input_schema`  (lines 189–193)

```
fn parse_tool_input_schema(input_schema: &JsonValue) -> Result<JsonSchema, serde_json::Error>
```

**Purpose**: Turns raw JSON for a tool input schema into the project’s typed `JsonSchema`, with cleanup and size reduction. This is the safer default for untrusted or potentially large schemas.

**Data flow**: It receives raw JSON → prepares it by sanitizing and pruning definitions → compacts it if it is too large → deserializes it into `JsonSchema` or returns a JSON parsing error.

**Call relations**: This is the main entry point for tool schema parsing. It coordinates `prepare_tool_input_schema`, `compact_large_tool_schema`, and `deserialize_tool_input_schema` in that order.

*Call graph*: calls 3 internal fn (compact_large_tool_schema, deserialize_tool_input_schema, prepare_tool_input_schema).


##### `parse_tool_input_schema_without_compaction`  (lines 196–200)

```
fn parse_tool_input_schema_without_compaction(
    input_schema: &JsonValue,
) -> Result<JsonSchema, serde_json::Error>
```

**Purpose**: Parses a trusted tool input schema without applying the lossy size-shrinking steps. Use it when preserving schema detail matters more than reducing payload size.

**Data flow**: It receives raw JSON → sanitizes and prunes it through `prepare_tool_input_schema` → deserializes it into `JsonSchema` → returns the schema or an error.

**Call relations**: This follows the same preparation and deserialization path as `parse_tool_input_schema`, but intentionally skips `compact_large_tool_schema`.

*Call graph*: calls 2 internal fn (deserialize_tool_input_schema, prepare_tool_input_schema).


##### `prepare_tool_input_schema`  (lines 202–207)

```
fn prepare_tool_input_schema(input_schema: &JsonValue) -> JsonValue
```

**Purpose**: Makes a raw schema compatible before parsing. It is the shared cleanup step used by both public parse functions.

**Data flow**: It receives a borrowed JSON value → clones it so the original is not changed → sanitizes unsupported schema forms → removes unused definitions → returns the cleaned JSON.

**Call relations**: Both `parse_tool_input_schema` and `parse_tool_input_schema_without_compaction` call this first. It hands its cleaned result to deserialization, and sometimes to compaction before that.

*Call graph*: calls 2 internal fn (prune_unreachable_definitions, sanitize_json_schema); called by 2 (parse_tool_input_schema, parse_tool_input_schema_without_compaction); 1 external calls (clone).


##### `deserialize_tool_input_schema`  (lines 209–218)

```
fn deserialize_tool_input_schema(input_schema: JsonValue) -> Result<JsonSchema, serde_json::Error>
```

**Purpose**: Converts cleaned JSON into the strongly typed `JsonSchema` struct. It also blocks the special case where the whole tool input schema is only `null`.

**Data flow**: It receives prepared JSON → asks Serde, the Rust serialization library, to turn it into `JsonSchema` → checks for a singleton null type → returns the schema or an error.

**Call relations**: Both public parse functions end by calling this. If it sees an invalid top-level null schema, it asks `singleton_null_schema_error` to build the error.

*Call graph*: calls 1 internal fn (singleton_null_schema_error); called by 2 (parse_tool_input_schema, parse_tool_input_schema_without_compaction); 2 external calls (matches!, from_value).


##### `compact_large_tool_schema`  (lines 229–236)

```
fn compact_large_tool_schema(value: &mut JsonValue)
```

**Purpose**: Shrinks schemas that are larger than the project’s rough size budget. It is careful but increasingly willing to lose detail if the schema remains too large.

**Data flow**: It receives mutable JSON → checks whether the normalized schema fits the byte budget → if not, runs compaction passes one by one → leaves the JSON smaller when possible.

**Call relations**: `parse_tool_input_schema` calls this after preparation. It uses `compact_schema_fits_budget` between passes to stop as soon as enough shrinking has happened.

*Call graph*: calls 1 internal fn (compact_schema_fits_budget); called by 1 (parse_tool_input_schema).


##### `collapse_deep_schema_objects_from_root`  (lines 247–249)

```
fn collapse_deep_schema_objects_from_root(value: &mut JsonValue)
```

**Purpose**: Starts the “collapse deep nested schema parts” compaction pass from the root of the schema. Collapsing means replacing detailed nested rules with an empty, permissive schema.

**Data flow**: It receives mutable JSON → calls the recursive collapse function at depth zero → leaves deeply nested complex parts simplified if needed.

**Call relations**: This function is one of the large-schema compaction passes run by `compact_large_tool_schema`. It delegates the real tree walk to `collapse_deep_schema_objects`.

*Call graph*: calls 1 internal fn (collapse_deep_schema_objects).


##### `compact_schema_fits_budget`  (lines 251–253)

```
fn compact_schema_fits_budget(value: &JsonValue) -> bool
```

**Purpose**: Checks whether a schema is small enough for the local size budget. The budget is measured in compact JSON bytes as a cheap stand-in for model tokens.

**Data flow**: It receives JSON → computes its normalized compact length → compares that length with the maximum allowed byte count → returns true or false.

**Call relations**: `compact_large_tool_schema` calls this before each shrinking pass. It relies on `compact_normalized_schema_len` for the measurement.

*Call graph*: calls 1 internal fn (compact_normalized_schema_len); called by 1 (compact_large_tool_schema).


##### `compact_normalized_schema_len`  (lines 255–260)

```
fn compact_normalized_schema_len(value: &JsonValue) -> usize
```

**Purpose**: Measures how large a schema would be after normal parsing and compact serialization. This avoids judging size based on whitespace or odd formatting in the original JSON.

**Data flow**: It receives JSON → clones and deserializes it as `JsonSchema` → serializes it back to compact bytes → returns the byte length, or zero if normalization fails.

**Call relations**: `compact_schema_fits_budget` uses this as its measuring tape. Its result decides whether `compact_large_tool_schema` keeps shrinking.

*Call graph*: called by 1 (compact_schema_fits_budget); 1 external calls (clone).


##### `for_each_schema_child`  (lines 268–304)

```
fn for_each_schema_child(
    map: &serde_json::Map<String, JsonValue>,
    definition_traversal: DefinitionTraversal,
    visitor: &mut impl FnMut(&JsonValue),
)
```

**Purpose**: Visits the child schemas inside a JSON Schema object without changing them. It knows where schema children can live, such as properties, items, composition arrays, and extra-property schemas.

**Data flow**: It receives a JSON object map, a choice about whether to enter definition tables, and a visitor function → finds child schema values → calls the visitor for each one.

**Call relations**: `collect_refs_outside_definitions` uses this to walk the meaningful schema tree while skipping definition tables. It is the read-only partner of `for_each_schema_child_mut`.

*Call graph*: called by 1 (collect_refs_outside_definitions); 2 external calls (get, matches!).


##### `strip_schema_descriptions`  (lines 306–321)

```
fn strip_schema_descriptions(value: &mut JsonValue)
```

**Purpose**: Removes all `description` text from a schema. This is the first and least damaging way to make a large schema smaller.

**Data flow**: It receives mutable JSON → walks arrays and schema objects → deletes `description` fields wherever it finds them → leaves the validation shape otherwise intact.

**Call relations**: This function is one of the compaction passes used by `compact_large_tool_schema`. It uses `for_each_schema_child_mut` to recurse through schema children, including definitions.

*Call graph*: calls 1 internal fn (for_each_schema_child_mut).


##### `for_each_schema_child_mut`  (lines 323–359)

```
fn for_each_schema_child_mut(
    map: &mut serde_json::Map<String, JsonValue>,
    definition_traversal: DefinitionTraversal,
    visitor: &mut impl FnMut(&mut JsonValue),
)
```

**Purpose**: Visits child schemas inside a JSON Schema object and allows them to be changed. It is the shared tree-walking helper for cleanup and compaction passes.

**Data flow**: It receives a mutable JSON object map, a choice about entering definitions, and a mutable visitor function → finds child schema values → hands each one to the visitor for possible editing.

**Call relations**: Several recursive functions call this, including description stripping, reference rewriting, deep-object collapsing, and composition pruning. It keeps all those passes using the same idea of “schema child.”

*Call graph*: called by 4 (collapse_deep_schema_objects, prune_schema_compositions, rewrite_definition_refs_to_empty_schemas, strip_schema_descriptions); 2 external calls (get_mut, matches!).


##### `drop_schema_definitions`  (lines 364–374)

```
fn drop_schema_definitions(value: &mut JsonValue)
```

**Purpose**: Removes root definition tables from a large schema after first making local references safe. This prevents leaving dangling shortcuts that point to definitions no longer present.

**Data flow**: It receives mutable JSON → replaces local definition references with empty schemas → removes `$defs` and `definitions` from the root object → leaves other content alone.

**Call relations**: This is a compaction pass used when descriptions alone are not enough. It calls `rewrite_definition_refs_to_empty_schemas` before deleting the definition tables.

*Call graph*: calls 1 internal fn (rewrite_definition_refs_to_empty_schemas).


##### `rewrite_definition_refs_to_empty_schemas`  (lines 376–400)

```
fn rewrite_definition_refs_to_empty_schemas(value: &mut JsonValue)
```

**Purpose**: Replaces local references to schema definitions with `{}` before definitions are dropped. An empty schema is permissive, so it avoids broken references while keeping parsing predictable.

**Data flow**: It receives mutable JSON → walks through arrays and schema objects outside definition tables → when it sees a local `$ref`, replaces that whole schema node with an empty object → updates the JSON in place.

**Call relations**: `drop_schema_definitions` calls this as its safety step. It uses `for_each_schema_child_mut` to recurse while skipping definition tables.

*Call graph*: calls 1 internal fn (for_each_schema_child_mut); called by 1 (drop_schema_definitions); 1 external calls (json!).


##### `collapse_deep_schema_objects`  (lines 402–421)

```
fn collapse_deep_schema_objects(value: &mut JsonValue, depth: usize)
```

**Purpose**: Simplifies complex schema objects that are nested too deeply. This keeps the visible top-level argument shape while trimming far-down detail.

**Data flow**: It receives mutable JSON and the current depth → walks arrays and schema children → once the maximum depth is reached, replaces complex schema objects with `{}` → changes the JSON in place.

**Call relations**: `collapse_deep_schema_objects_from_root` starts this recursion. It uses `is_complex_schema_object` to decide whether a node has enough schema structure to collapse.

*Call graph*: calls 2 internal fn (for_each_schema_child_mut, is_complex_schema_object); called by 1 (collapse_deep_schema_objects_from_root); 1 external calls (json!).


##### `prune_schema_compositions`  (lines 423–442)

```
fn prune_schema_compositions(value: &mut JsonValue)
```

**Purpose**: Removes schema nodes that use composition keywords like `anyOf`, `oneOf`, or `allOf`. This is a more aggressive size-reduction pass because it can throw away detailed alternatives.

**Data flow**: It receives mutable JSON → walks arrays and schema children → if an object contains a composition keyword, replaces it with `{}` → leaves simpler nodes untouched.

**Call relations**: This is the final large-schema compaction pass. It uses `has_composition_keyword` to spot composition nodes and `for_each_schema_child_mut` to keep walking the tree.

*Call graph*: calls 2 internal fn (for_each_schema_child_mut, has_composition_keyword); 1 external calls (json!).


##### `is_complex_schema_object`  (lines 444–449)

```
fn is_complex_schema_object(map: &serde_json::Map<String, JsonValue>) -> bool
```

**Purpose**: Decides whether a schema object contains nested schema structure. Deep compaction uses this to avoid replacing simple type markers unnecessarily.

**Data flow**: It receives a JSON object map → checks for child-schema keys, properties, extra-property schemas, or references → returns true if the object is complex enough to collapse.

**Call relations**: `collapse_deep_schema_objects` calls this when the depth limit has been reached. Its answer controls whether that node becomes an empty schema.

*Call graph*: called by 1 (collapse_deep_schema_objects); 1 external calls (contains_key).


##### `has_composition_keyword`  (lines 451–455)

```
fn has_composition_keyword(map: &serde_json::Map<String, JsonValue>) -> bool
```

**Purpose**: Checks whether a schema object uses `anyOf`, `oneOf`, or `allOf`. These keywords mean the schema is built from alternatives or combined rules.

**Data flow**: It receives a JSON object map → looks for any recognized composition key → returns true if one is present.

**Call relations**: `prune_schema_compositions` uses this during aggressive compaction. `sanitize_json_schema` also uses it to recognize schemas that are valid even without a plain `type` field.

*Call graph*: called by 2 (prune_schema_compositions, sanitize_json_schema).


##### `sanitize_json_schema`  (lines 466–544)

```
fn sanitize_json_schema(value: &mut JsonValue)
```

**Purpose**: Converts incoming JSON Schema into the smaller subset this project supports. It smooths over common schema variations so tool registration does not fail for avoidable reasons.

**Data flow**: It receives mutable JSON → recursively sanitizes child schemas, definitions, items, and composition parts → converts `const` to `enum`, infers missing types from clues, fills default object and array children, or clears unrecognized empty schemas → leaves compatible JSON behind.

**Call relations**: `prepare_tool_input_schema` calls this before pruning definitions, and `sanitize_schema_table` calls it for each definition entry. It coordinates helpers such as `normalized_schema_types`, `write_schema_types`, `ensure_default_children_for_schema_types`, and `sanitize_schema_table`.

*Call graph*: calls 5 internal fn (ensure_default_children_for_schema_types, has_composition_keyword, normalized_schema_types, sanitize_schema_table, write_schema_types); called by 2 (prepare_tool_input_schema, sanitize_schema_table); 4 external calls (Array, json!, matches!, vec!).


##### `sanitize_schema_table`  (lines 552–567)

```
fn sanitize_schema_table(map: &mut serde_json::Map<String, JsonValue>, key: &str)
```

**Purpose**: Cleans a `$defs` or `definitions` table if it is valid, or removes it if it is malformed. This lets bad unused definitions degrade gracefully instead of breaking the whole schema.

**Data flow**: It receives a schema object map and a table name → if that table is an object, sanitizes each definition inside it → if the table exists but is not an object, removes it.

**Call relations**: `sanitize_json_schema` calls this for both supported definition-table names. It calls `sanitize_json_schema` recursively for each valid definition.

*Call graph*: calls 1 internal fn (sanitize_json_schema); called by 1 (sanitize_json_schema); 2 external calls (get_mut, remove).


##### `ensure_default_children_for_schema_types`  (lines 569–583)

```
fn ensure_default_children_for_schema_types(
    map: &mut serde_json::Map<String, JsonValue>,
    schema_types: &[JsonSchemaPrimitiveType],
)
```

**Purpose**: Adds safe default child schemas for objects and arrays that do not say what they contain. This prevents later typed parsing from seeing incomplete object or array schemas.

**Data flow**: It receives a mutable schema object and its normalized list of types → if it includes object and lacks `properties`, adds an empty properties map → if it includes array and lacks `items`, adds string items.

**Call relations**: `sanitize_json_schema` calls this after deciding the schema’s type list. It fills in the missing pieces that the internal `JsonSchema` representation expects.

*Call graph*: called by 1 (sanitize_json_schema); 6 external calls (Object, contains_key, insert, json!, new, contains).


##### `prune_unreachable_definitions`  (lines 593–602)

```
fn prune_unreachable_definitions(value: &mut JsonValue)
```

**Purpose**: Removes root schema definitions that nothing references. This cuts unused material, like deleting glossary entries that are never mentioned.

**Data flow**: It receives mutable JSON → finds all reachable definition pointers → removes any `$defs` or `definitions` entries not in that reachable set → deletes empty definition tables.

**Call relations**: `prepare_tool_input_schema` calls this after sanitization. It relies on `collect_reachable_definitions` to know what must be kept and `prune_schema_table` to remove the rest.

*Call graph*: calls 2 internal fn (collect_reachable_definitions, prune_schema_table); called by 1 (prepare_tool_input_schema).


##### `prune_schema_table`  (lines 604–623)

```
fn prune_schema_table(
    map: &mut serde_json::Map<String, JsonValue>,
    table: &'static str,
    reachable: &BTreeSet<DefinitionPointer>,
)
```

**Purpose**: Deletes unused entries from one definition table. It works on either `$defs` or `definitions`.

**Data flow**: It receives the root object map, a table name, and the reachable-definition set → keeps only entries named in that set → removes the whole table if it becomes empty.

**Call relations**: `prune_unreachable_definitions` calls this once for each supported definition-table name. It performs the actual table editing.

*Call graph*: called by 1 (prune_unreachable_definitions); 2 external calls (get_mut, remove).


##### `collect_reachable_definitions`  (lines 625–642)

```
fn collect_reachable_definitions(value: &JsonValue) -> BTreeSet<DefinitionPointer>
```

**Purpose**: Finds which root definitions are actually used, including definitions referenced by other definitions. This prevents pruning a definition that is needed indirectly.

**Data flow**: It receives the full schema JSON → collects references outside definition tables as starting points → follows each referenced definition and gathers more references from inside it → returns a set of reachable definition pointers.

**Call relations**: `prune_unreachable_definitions` calls this before deleting anything. It uses `collect_refs_outside_definitions`, `definition_for_pointer`, and `collect_refs` to follow the reference chain.

*Call graph*: calls 3 internal fn (collect_refs, collect_refs_outside_definitions, definition_for_pointer); called by 1 (prune_unreachable_definitions); 2 external calls (new, new).


##### `collect_refs_outside_definitions`  (lines 644–659)

```
fn collect_refs_outside_definitions(value: &JsonValue, refs: &mut Vec<DefinitionPointer>)
```

**Purpose**: Collects local definition references from the main schema body while ignoring the definition tables themselves. This finds what the top-level schema truly uses.

**Data flow**: It receives JSON and a growing list of references → walks arrays and schema children outside definitions → adds any local `$ref` it finds to the list.

**Call relations**: `collect_reachable_definitions` calls this to seed its work queue. It uses `collect_ref_from_map` to recognize references and `for_each_schema_child` to walk the schema body.

*Call graph*: calls 2 internal fn (collect_ref_from_map, for_each_schema_child); called by 1 (collect_reachable_definitions).


##### `collect_refs`  (lines 661–676)

```
fn collect_refs(value: &JsonValue, refs: &mut Vec<DefinitionPointer>)
```

**Purpose**: Collects local definition references anywhere inside a JSON value. This broader walk is used once the code is already inside a referenced definition.

**Data flow**: It receives JSON and a mutable reference list → recursively visits arrays and all object values → appends any local definition references it finds.

**Call relations**: `collect_reachable_definitions` calls this when following a definition that was already found reachable. It shares reference recognition with `collect_refs_outside_definitions` through `collect_ref_from_map`.

*Call graph*: calls 1 internal fn (collect_ref_from_map); called by 1 (collect_reachable_definitions).


##### `collect_ref_from_map`  (lines 678–687)

```
fn collect_ref_from_map(
    map: &serde_json::Map<String, JsonValue>,
    refs: &mut Vec<DefinitionPointer>,
)
```

**Purpose**: Looks at one JSON object and records its `$ref` if it points to a local definition. Local means it points inside the same schema document.

**Data flow**: It receives a JSON object map and a mutable list → reads the `$ref` string if present → parses it as a local definition pointer → appends the pointer when parsing succeeds.

**Call relations**: Both reference-collection walkers call this at each object. It delegates the details of reference syntax to `parse_local_definition_ref`.

*Call graph*: calls 1 internal fn (parse_local_definition_ref); called by 2 (collect_refs, collect_refs_outside_definitions); 1 external calls (get).


##### `definition_for_pointer`  (lines 689–700)

```
fn definition_for_pointer(
    value: &'a JsonValue,
    pointer: &DefinitionPointer,
) -> Option<&'a JsonValue>
```

**Purpose**: Retrieves the schema definition named by a definition pointer. It is the lookup step used while following references.

**Data flow**: It receives the full schema JSON and a pointer naming a definition table and entry → looks inside that table → returns the matching definition JSON if it exists.

**Call relations**: `collect_reachable_definitions` calls this after finding a reference. If a definition is found, the collector scans it for more references.

*Call graph*: called by 1 (collect_reachable_definitions).


##### `parse_local_definition_ref`  (lines 702–720)

```
fn parse_local_definition_ref(schema_ref: &str) -> Option<DefinitionPointer>
```

**Purpose**: Parses a `$ref` string that points to a local `$defs` or `definitions` entry. It also treats deeper references inside a definition as keeping the parent definition alive.

**Data flow**: It receives a reference string → checks that it starts with `#` → URL-decodes and parses the JSON Pointer path → accepts only supported definition tables → returns a `DefinitionPointer` with the table and definition name, or nothing if unsupported.

**Call relations**: `collect_ref_from_map` calls this when it sees a `$ref`. The resulting pointer is later used by `definition_for_pointer` and pruning logic.

*Call graph*: called by 1 (collect_ref_from_map); 2 external calls (parse, decode).


##### `normalized_schema_types`  (lines 722–738)

```
fn normalized_schema_types(
    map: &serde_json::Map<String, JsonValue>,
) -> Vec<JsonSchemaPrimitiveType>
```

**Purpose**: Reads the schema’s `type` field and converts it into the project’s known primitive type enum values. It accepts either one type name or a list of type names.

**Data flow**: It receives a JSON object map → reads `type` if present → filters out unknown or malformed type names → returns a vector of recognized primitive types.

**Call relations**: `sanitize_json_schema` calls this before deciding whether it must infer a missing type. It uses `schema_type_from_str` for each type name.

*Call graph*: calls 1 internal fn (schema_type_from_str); called by 1 (sanitize_json_schema); 2 external calls (get, new).


##### `write_schema_types`  (lines 740–768)

```
fn write_schema_types(
    map: &mut serde_json::Map<String, JsonValue>,
    schema_types: &[JsonSchemaPrimitiveType],
)
```

**Purpose**: Writes a cleaned type list back into the JSON Schema object. It preserves JSON Schema’s convention of using a string for one type and an array for multiple types.

**Data flow**: It receives a mutable object map and a list of primitive types → removes `type` if the list is empty, writes one string if there is one type, or writes an array of strings for multiple types.

**Call relations**: `sanitize_json_schema` calls this after normalizing or inferring schema types. It uses `schema_type_name` to turn enum values back into JSON Schema type names.

*Call graph*: calls 1 internal fn (schema_type_name); called by 1 (sanitize_json_schema); 5 external calls (Array, String, insert, remove, iter).


##### `schema_type_from_str`  (lines 770–781)

```
fn schema_type_from_str(schema_type: &str) -> Option<JsonSchemaPrimitiveType>
```

**Purpose**: Converts a JSON Schema type name like `string` or `array` into the matching internal enum value. Unknown names are ignored.

**Data flow**: It receives a text type name → compares it with the supported JSON Schema primitive names → returns the matching enum value or nothing.

**Call relations**: `normalized_schema_types` calls this while reading incoming `type` fields. This is the whitelist that limits schemas to the supported type subset.

*Call graph*: called by 1 (normalized_schema_types).


##### `schema_type_name`  (lines 783–793)

```
fn schema_type_name(schema_type: JsonSchemaPrimitiveType) -> &'static str
```

**Purpose**: Converts an internal primitive type enum back into its JSON Schema text name. This is the reverse of `schema_type_from_str`.

**Data flow**: It receives a `JsonSchemaPrimitiveType` → maps it to a lowercase schema type string such as `boolean` or `object` → returns that string.

**Call relations**: `write_schema_types` calls this when writing normalized type information back into JSON. Together, these two functions keep type names consistent.

*Call graph*: called by 1 (write_schema_types).


##### `singleton_null_schema_error`  (lines 795–800)

```
fn singleton_null_schema_error() -> serde_json::Error
```

**Purpose**: Builds the specific error used when a whole tool input schema is just `null`. Tool input schemas must describe callable arguments, not only the absence of a value.

**Data flow**: It creates an input-error message → wraps it in a `serde_json::Error` → returns that error to the caller.

**Call relations**: `deserialize_tool_input_schema` calls this after parsing if it detects the forbidden top-level null schema. The public parse functions then return that error to their callers.

*Call graph*: called by 1 (deserialize_tool_input_schema); 2 external calls (io, new).


### `tools/src/mcp_tool.rs`

`io_transport` · `tool discovery and setup`

MCP, or Model Context Protocol, lets outside servers advertise tools that a model can use. Those tools arrive in MCP’s own shape, but this project needs a local `ToolDefinition` with clear input and output schemas. This file is the adapter between those two worlds, like a travel plug that lets one country’s socket fit another country’s device.

The main job is to read an MCP tool’s name, description, input schema, and optional output schema, then package them into the project’s standard tool definition. There is one important compatibility fix: OpenAI-style tool schemas require a `properties` field, but some MCP servers leave it out or set it to null. Before parsing the input schema, this file adds an empty `properties` object when needed, so otherwise valid tools do not fail just because a server was sparse.

For outputs, MCP tool calls return more than just the tool’s structured result. They can include visible content, structured data, an error flag, and metadata. This file wraps the tool’s own output schema inside that larger MCP call-result shape. Without this file, MCP tools would not be reliably understood by the rest of the system, and small schema differences from servers could break tool loading.

#### Function details

##### `parse_mcp_tool`  (lines 6–37)

```
fn parse_mcp_tool(tool: &rmcp::model::Tool) -> Result<ToolDefinition, serde_json::Error>
```

**Purpose**: This function converts one MCP tool description into this project’s `ToolDefinition`. It makes the tool safe for model use by normalizing the input schema and wrapping the output schema in the standard MCP call-result format.

**Data flow**: It receives an MCP tool object. It copies the tool’s input schema, adds an empty `properties` object if that required field is missing or null, and sends the cleaned schema to `parse_tool_input_schema` for validation and conversion. It also reads the optional MCP output schema, falls back to an empty object if none is provided, wraps that using `mcp_call_tool_result_output_schema`, and returns a complete `ToolDefinition` with the tool name, description, schemas, and `defer_loading` set to false. If schema parsing fails, it returns that JSON error instead of a tool definition.

**Call relations**: This is the main entry point in the file. When the system discovers a tool from an MCP server, it calls this function to translate that server-provided description into the internal tool format. During that translation it hands the cleaned input schema to the shared `parse_tool_input_schema` helper, and it calls `mcp_call_tool_result_output_schema` to describe what a successful or failed MCP tool call result will look like.

*Call graph*: calls 1 internal fn (mcp_call_tool_result_output_schema); 3 external calls (parse_tool_input_schema, new, Object).


##### `mcp_call_tool_result_output_schema`  (lines 39–60)

```
fn mcp_call_tool_result_output_schema(structured_content_schema: JsonValue) -> JsonValue
```

**Purpose**: This function builds the JSON schema for the full result returned by an MCP tool call. It takes the tool’s own structured output shape and places it inside the larger envelope that MCP uses for call results.

**Data flow**: It receives a JSON value describing the tool-specific structured content. It creates and returns a JSON schema for an object with `content`, `structuredContent`, `isError`, and `_meta` fields. The `content` field is required, the provided structured schema is used as the shape of `structuredContent`, and extra fields are not allowed.

**Call relations**: This helper is called by `parse_mcp_tool` while building a `ToolDefinition`. Its output becomes the tool definition’s output schema, so later parts of the system know that an MCP call result is not just the raw tool data, but a wrapper containing display content, structured content, error status, and metadata.

*Call graph*: called by 1 (parse_mcp_tool); 1 external calls (json!).


### Handler utilities
This module provides the shared handler wiring and helper routines that concrete tool implementations rely on during guarded execution.

### `core/src/tools/handlers/mod.rs`

`orchestration` · `request handling and cross-cutting tool setup`

When the model asks the system to use a tool, the request arrives as structured text, usually JSON. This file helps turn that text into safe, usable Rust data, finds the right working folder or environment, and applies the project’s permission rules before anything powerful happens. It is like the reception desk for tools: it points visitors to the right room, checks their paperwork, and makes sure they are allowed through the door.

The top of the file declares and re-exports many specific tool handler modules. That lets the rest of the program import tool handlers from one central place instead of knowing each sub-file’s location.

The helper functions focus on three areas. First, they parse and sometimes rewrite tool arguments, returning clear errors that can be sent back to the model if the request is malformed. Second, they resolve context, such as which working directory or turn environment a tool should run in. Third, they calculate “additional permissions,” meaning extra network or file-system access beyond the normal sandbox. A sandbox is a safety boundary that limits what a command can touch. The permission logic checks whether extra access is enabled, whether approval is required, whether permissions were already granted, and whether stored grants fully cover the current request.

The tests at the bottom protect important edge cases, especially around preapproved permissions and sticky grants that carry across turns.

#### Function details

##### `parse_arguments`  (lines 80–87)

```
fn parse_arguments(arguments: &str) -> Result<T, FunctionCallError>
```

**Purpose**: This function turns a JSON argument string from a tool call into the Rust type that the specific tool expects. If the text is not valid JSON for that type, it creates an error message that can be shown back to the model.

**Data flow**: It receives a string containing tool arguments. It asks the JSON parser to deserialize that string into the requested type. On success, it returns the typed value; on failure, it returns a model-facing error explaining that the function arguments could not be parsed.

**Call relations**: Many tool call paths rely on this as their first step when a model invokes a tool. Other helpers, such as parse_arguments_with_base_path, resolve_workdir_base_path, and rewrite_function_arguments, call it before doing their own more specific work.

*Call graph*: called by 12 (handle_call, parse_arguments_with_base_path, handle_call, handle_call, handle_call, resolve_workdir_base_path, rewrite_function_arguments, handle, handle_call, handle_call (+2 more)); 1 external calls (from_str).


##### `updated_hook_command`  (lines 89–98)

```
fn updated_hook_command(updated_input: &Value) -> Result<&str, FunctionCallError>
```

**Purpose**: This function extracts a rewritten command string from hook output. It is used when a hook, meaning a small piece of code that can inspect or modify a tool request, returns updated input for a command.

**Data flow**: It receives a JSON value that should contain a field named command. It looks up that field and checks that it is a string. If it is present and valid, it returns the command text; otherwise it returns a clear error saying the hook output is missing the required string field.

**Call relations**: Hook-related flows call this after a hook says it has changed a tool input. The function acts as a small safety check before the changed command is accepted and passed back into the normal command execution path.

*Call graph*: called by 3 (with_updated_hook_input, with_updated_hook_input, with_updated_hook_input); 1 external calls (get).


##### `rewrite_function_arguments`  (lines 100–117)

```
fn rewrite_function_arguments(
    arguments: &str,
    tool_name: &str,
    rewrite: impl FnOnce(&mut Map<String, Value>),
) -> Result<String, FunctionCallError>
```

**Purpose**: This function edits a tool call’s JSON arguments in a controlled way and turns them back into a string. It exists so hook code can safely change one or more fields without rebuilding the whole argument object by hand.

**Data flow**: It receives the original argument string, the tool name for error messages, and a small rewriting action. It parses the arguments as JSON, confirms that the top-level value is an object, lets the rewriting action modify that object, then serializes the object back into JSON text. Bad input or serialization failure becomes a model-facing error.

**Call relations**: rewrite_function_string_argument uses this as the general-purpose editing engine. In the broader flow, hook update logic uses it indirectly when it needs to replace a particular field in a tool call before execution continues.

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

**Purpose**: This function rewrites one named string field inside a tool call’s JSON arguments. It is a convenience wrapper for the common case where only one text field, such as a command, needs to be replaced.

**Data flow**: It receives the original argument string, the tool name, the field name to change, and the new string value. It delegates to rewrite_function_arguments, inserting the new string into the JSON object. The result is a rewritten JSON argument string or an error if the original arguments were not a valid object.

**Call relations**: Hook update code calls this when a hook has produced a replacement value for a string field. It hands off the actual JSON parsing and serialization work to rewrite_function_arguments.

*Call graph*: calls 1 internal fn (rewrite_function_arguments); called by 2 (with_updated_hook_input, with_updated_hook_input).


##### `parse_arguments_with_base_path`  (lines 130–139)

```
fn parse_arguments_with_base_path(
    arguments: &str,
    base_path: &AbsolutePathBuf,
) -> Result<T, FunctionCallError>
```

**Purpose**: This function parses tool arguments while temporarily setting a base path for absolute-path handling. It is used when argument parsing may need to interpret paths relative to a known working directory.

**Data flow**: It receives the raw argument string and a base absolute path. It installs a temporary path guard, then parses the arguments using parse_arguments. The caller receives the parsed typed value, and the temporary path setting goes away when the function finishes.

**Call relations**: Several tool handlers call this when they need normal argument parsing plus correct path interpretation. It builds directly on parse_arguments and adds path context around that parsing step.

*Call graph*: calls 2 internal fn (parse_arguments, new); called by 3 (handle_call, handle_call, handle_call).


##### `resolve_workdir_base_path`  (lines 141–151)

```
fn resolve_workdir_base_path(
    arguments: &str,
    default_cwd: &AbsolutePathBuf,
) -> Result<AbsolutePathBuf, FunctionCallError>
```

**Purpose**: This function decides which folder a tool should treat as its working directory. If the tool arguments include a non-empty workdir field, it uses that relative to the default folder; otherwise it keeps the default folder.

**Data flow**: It receives the raw argument string and the default current working directory. It parses the arguments as JSON, looks for a string field named workdir, and if found joins it onto the default path. It returns the resolved absolute path or a parsing error.

**Call relations**: A tool handler calls this before running work that depends on a working directory. It uses parse_arguments to inspect the incoming JSON and then hands the resolved base path back to the caller.

*Call graph*: calls 1 internal fn (parse_arguments); called by 1 (handle_call).


##### `resolve_tool_environment`  (lines 153–172)

```
fn resolve_tool_environment(
    turn: &'a TurnContext,
    environment_id: Option<&str>,
) -> Result<Option<&'a TurnEnvironment>, FunctionCallError>
```

**Purpose**: This function chooses which turn environment a tool should run in. A turn environment is the execution context available during one model turn, such as the primary environment or another named environment.

**Data flow**: It receives the current turn context and an optional environment id. If no id is given, it returns the primary environment. If an id is given, it searches the turn’s environments for a match. It returns the matching environment, or an error if the id is unknown.

**Call relations**: Multiple tool handlers call this before doing environment-specific work. It prevents tools from silently using the wrong environment by rejecting unknown environment ids early.

*Call graph*: called by 4 (handle_call, handle_call, handle_call, handle_call).


##### `normalize_and_validate_additional_permissions`  (lines 176–229)

```
fn normalize_and_validate_additional_permissions(
    additional_permissions_allowed: bool,
    approval_policy: AskForApproval,
    sandbox_permissions: SandboxPermissions,
    additional_permissions
```

**Purpose**: This function checks whether a tool is allowed to request extra sandbox permissions and cleans those permissions into a standard form. It protects the system from commands quietly gaining network or file access when policy says they should not.

**Data flow**: It receives feature flags, the approval policy, the requested sandbox mode, optional extra permissions, whether those permissions were already approved, and the current directory. It checks that extra permissions are enabled or preapproved, that the approval policy allows fresh requests, that required permission details are present, and that the request is not empty. It returns normalized permissions, no permissions, or a human-readable error string.

**Call relations**: The production permission flow uses this kind of validation before exec-like tools run with extra access. The listed direct callers here are tests that exercise important policy combinations, such as preapproved permissions and disabled fresh permission requests.

*Call graph*: calls 1 internal fn (normalize_additional_permissions); called by 2 (fresh_additional_permissions_still_require_exec_permission_approvals_feature, preapproved_permissions_work_when_request_permissions_tool_is_enabled_without_exec_permission_approvals_feature); 2 external calls (format!, matches!).


##### `implicit_granted_permissions`  (lines 237–252)

```
fn implicit_granted_permissions(
    sandbox_permissions: SandboxPermissions,
    additional_permissions: Option<&AdditionalPermissionProfile>,
    effective_additional_permissions: &EffectiveAddition
```

**Purpose**: This function decides whether already-granted permissions can be silently reused for a tool call that did not explicitly ask for new ones. This supports “sticky” approvals, where a user-approved permission can continue to apply without forcing every later tool call to repeat the request.

**Data flow**: It receives the originally requested sandbox mode, any inline extra permissions from the current call, and the already-calculated effective permissions. If the current call did not explicitly use extra permissions, did not require escalation, and did not include its own permission profile, it returns a copy of the effective granted permissions. Otherwise it returns nothing.

**Call relations**: Exec-like flows and a handler path call this after effective permissions have been calculated. Tests also call it to confirm that implicit sticky grants are used only when appropriate, not when the model explicitly requested permissions inline.

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

**Purpose**: This function combines permissions that were already granted for the session or current turn with the permissions requested by the current tool call. It produces the final permission state that execution code should use.

**Data flow**: It receives the session, environment id, current directory, requested sandbox mode, and optional requested extra permissions. If the command requires full escalation, it leaves that alone. Otherwise it reads granted session permissions and granted turn permissions, merges them, merges those with the current request, checks whether the final permissions are fully preapproved, and may switch the sandbox mode to use additional permissions. It returns an EffectiveAdditionalPermissions record with the final sandbox mode, final permission profile, and preapproval flag.

**Call relations**: Exec-like tools, patch permission calculation, extension calls, and another handler path call this before running work that may need permission decisions. It delegates the “is this already covered?” question to permissions_are_preapproved.

*Call graph*: calls 3 internal fn (permissions_are_preapproved, uses_additional_permissions, merge_permission_profiles); called by 4 (effective_patch_permissions, to_extension_call, run_exec_like, handle_call); 3 external calls (granted_session_permissions, granted_turn_permissions, matches!).


##### `permissions_are_preapproved`  (lines 300–312)

```
fn permissions_are_preapproved(
    effective_permissions: &AdditionalPermissionProfile,
    granted_permissions: AdditionalPermissionProfile,
    cwd: &Path,
) -> bool
```

**Purpose**: This function answers a precise question: do the permissions already granted cover all the permissions the tool effectively wants? It matters because covered requests can proceed as preapproved instead of asking again.

**Data flow**: It receives the effective permission profile, a granted permission profile, and the current directory. It materializes path-based permission rules against the current directory, then intersects the effective permissions with the granted permissions. If that intersection equals the fully materialized effective permissions, it returns true; otherwise false.

**Call relations**: apply_granted_turn_permissions calls this after merging current and stored permissions. It relies on sandbox policy transformation helpers to compare permission profiles in a normalized, path-aware way.

*Call graph*: calls 1 internal fn (intersect_permission_profiles); called by 1 (apply_granted_turn_permissions); 1 external calls (clone).


##### `tests::network_permissions`  (lines 336–343)

```
fn network_permissions() -> AdditionalPermissionProfile
```

**Purpose**: This test helper builds a simple permission profile that allows network access. It keeps the permission-related tests short and focused on behavior instead of setup details.

**Data flow**: It takes no input. It creates an AdditionalPermissionProfile with network enabled and all other fields left at their defaults. It returns that profile to the test that asked for it.

**Call relations**: The permission validation tests call this whenever they need a basic extra-permission request. It supplies consistent test data for both accepted and rejected permission scenarios.

*Call graph*: 1 external calls (default).


##### `tests::file_system_permissions`  (lines 345–355)

```
fn file_system_permissions(path: &std::path::Path) -> AdditionalPermissionProfile
```

**Purpose**: This test helper builds a permission profile that allows writing under a specific file-system path. It is used to test sticky file access grants.

**Data flow**: It receives a path. It converts that path into the project’s absolute path type, builds file-system write permissions rooted at that path, leaves unrelated permission fields at default values, and returns the finished profile.

**Call relations**: The implicit-grant tests call this to create realistic file-system permission profiles. Those profiles are then passed into implicit_granted_permissions to check whether stored grants are reused correctly.

*Call graph*: calls 1 internal fn (from_read_write_roots); 2 external calls (default, vec!).


##### `tests::preapproved_permissions_work_when_request_permissions_tool_is_enabled_without_exec_permission_approvals_feature`  (lines 358–379)

```
fn preapproved_permissions_work_when_request_permissions_tool_is_enabled_without_exec_permission_approvals_feature()
```

**Purpose**: This test proves that already-approved extra permissions can still be accepted even when the feature for fresh exec permission approvals is disabled. That prevents valid stored approvals from being blocked by the wrong feature gate.

**Data flow**: It creates a temporary directory and a network permission profile. It calls normalize_and_validate_additional_permissions with extra permissions disabled but the permissions marked as preapproved. It expects the normalized result to equal the requested network permissions.

**Call relations**: This test directly exercises normalize_and_validate_additional_permissions. It guards the path where approval happened earlier, so validation should not treat the request as a new unapproved permission grab.

*Call graph*: calls 1 internal fn (normalize_and_validate_additional_permissions); 4 external calls (Granular, assert_eq!, network_permissions, tempdir).


##### `tests::fresh_additional_permissions_still_require_exec_permission_approvals_feature`  (lines 382–399)

```
fn fresh_additional_permissions_still_require_exec_permission_approvals_feature()
```

**Purpose**: This test proves that a fresh request for extra permissions is rejected when the feature that allows exec permission approvals is disabled. It protects the safety boundary from accidental bypass.

**Data flow**: It creates a temporary directory and a network permission request. It calls normalize_and_validate_additional_permissions with the request not preapproved and the feature disabled. It expects an error explaining that additional permissions are disabled and the required feature must be enabled.

**Call relations**: This test directly checks the rejection branch in normalize_and_validate_additional_permissions. It complements the preapproved-permissions test by showing that only previously approved permissions get the bypass.

*Call graph*: calls 1 internal fn (normalize_and_validate_additional_permissions); 3 external calls (assert_eq!, network_permissions, tempdir).


##### `tests::implicit_sticky_grants_bypass_inline_permission_validation`  (lines 402–416)

```
fn implicit_sticky_grants_bypass_inline_permission_validation()
```

**Purpose**: This test confirms that stored permission grants can be reused implicitly when the current tool call did not explicitly request extra permissions. It protects the intended sticky-approval behavior.

**Data flow**: It creates a temporary directory and a file-system permission profile. It builds an EffectiveAdditionalPermissions value containing that profile, then calls implicit_granted_permissions with a normal sandbox mode and no inline permissions. It expects the stored profile to be returned.

**Call relations**: This test calls implicit_granted_permissions directly. It verifies the positive path used by exec-like flows when a prior grant should carry forward into a later command.

*Call graph*: calls 1 internal fn (implicit_granted_permissions); 3 external calls (assert_eq!, file_system_permissions, tempdir).


##### `tests::explicit_inline_permissions_do_not_use_implicit_sticky_grant_path`  (lines 419–433)

```
fn explicit_inline_permissions_do_not_use_implicit_sticky_grant_path()
```

**Purpose**: This test confirms that explicit permission requests are not treated as implicit sticky grants. That distinction matters because explicit new requests must go through the normal validation and approval rules.

**Data flow**: It creates a temporary directory and a requested file-system permission profile. It calls implicit_granted_permissions with sandbox permissions set to use additional permissions and with inline permissions present. It expects no implicit permissions to be returned.

**Call relations**: This test calls implicit_granted_permissions directly. It checks the negative path so production callers do not accidentally skip validation for permissions the model explicitly asked for.

*Call graph*: calls 1 internal fn (implicit_granted_permissions); 3 external calls (assert_eq!, file_system_permissions, tempdir).


##### `tests::relative_deny_glob_grants_remain_preapproved_after_materialization`  (lines 436–472)

```
fn relative_deny_glob_grants_remain_preapproved_after_materialization()
```

**Purpose**: This test checks a subtle permission comparison case involving relative deny patterns, such as denying access to files matching **/*.env. It ensures that turning relative rules into concrete path-aware rules does not make a previously granted permission look unapproved.

**Data flow**: It creates a temporary directory and a permission profile with project-root write access plus a deny rule for matching environment files. It materializes a stored grant by intersecting the request with itself, merges the request with that stored grant, and then checks that permissions_are_preapproved still returns true.

**Call relations**: This test uses the same policy transformation helpers as the production permission flow and then exercises permissions_are_preapproved. It protects apply_granted_turn_permissions from misclassifying valid stored grants when relative glob rules are involved.

*Call graph*: calls 2 internal fn (intersect_permission_profiles, merge_permission_profiles); 4 external calls (default, assert!, tempdir, vec!).

## 📊 State Registers Touched

- `reg-effective-config` — The final set of settings Codex runs with after combining files, policies, profiles, cloud settings, thread overrides, and command-line flags.
- `reg-feature-flags` — The shared list of enabled or disabled experimental and product features that changes what the app exposes.
- `reg-shell-workspace-environment` — The current machine, shell, PATH, working directory, project root, Git state, and environment variables used to make commands behave like the user’s terminal.
- `reg-credential-store` — The saved tokens, API keys, OAuth credentials, MCP tokens, and other secrets used to authenticate later requests.
- `reg-http-network-client` — The shared network client setup, including retries, streaming, cookies, proxy settings, TLS handling, and request failure reporting.
- `reg-remote-control-relay` — The remote-control, relay, socket, WebSocket, and encrypted connection state used to connect clients and helper processes.
- `reg-network-proxy-policy` — The managed proxy and network-forwarding state that decides what network traffic is allowed, forwarded, or blocked.
- `reg-permission-sandbox-policy` — The shared rules for file access, command execution, network access, approvals, and sandbox modes.
- `reg-exec-environment` — The active command-execution setup, including local or remote executor choice, sandbox helper paths, runtime paths, and process execution capabilities.
- `reg-process-registry` — The shared record of running or tracked external processes, their identifiers, input/output streams, terminal sizes, and completion state.
- `reg-mcp-server-sessions` — The configured and connected MCP tool servers, their tools, resources, login state, approval rules, and active sessions.
- `reg-plugin-marketplace-catalog` — The installed, built-in, workspace, and marketplace plugin information that controls extra tools, hooks, connectors, and prompt additions.
- `reg-extension-host-state` — The shared extension runtime state and contributor hooks that let add-ons react to threads, turns, tools, prompts, events, and MCP setup.
- `reg-memory-store` — The saved long-term user memories and memory search results that can be loaded, updated, and inserted into future conversations.
- `reg-live-session-services` — The toolbox attached to one running session, such as model access, auth, telemetry, approvals, tools, extensions, networking, and MCP connections.
- `reg-thread-session-state` — The live state of a conversation thread, including its identity, workspace, selected model, history, permissions, listeners, and lifecycle status.
- `reg-turn-state` — The shared clipboard for one active assistant turn, tracking the current task, pending replies, granted permissions, cancellations, and bookkeeping.
- `reg-prompt-context-stack` — The assembled prompt ingredients, including project instructions, permissions text, goals, memories, skills, plugin text, IDE details, warnings, and changed context.
- `reg-tool-catalog` — The current set of tools the model may call, with schemas, names, MCP conversions, plugin additions, and execution handlers.
- `reg-hook-rules` — The configured hooks and hook schemas that let external commands inspect or affect session starts, turns, tool calls, and other lifecycle events.
- `reg-observability-telemetry` — The shared logs, traces, metrics, analytics facts, rollout tracing, debug captures, and feedback evidence used to understand what happened.
- `reg-code-mode-runtime-state` — The live code-mode execution sessions, V8 isolates, loaded modules, pending calls, timers, and shutdown state for JavaScript/code-cell execution.
- `reg-windows-sandbox-readiness` — Prepared Windows sandbox accounts, helper readiness, setup status, and client-visible sandbox availability separate from the policy rules themselves.
- `reg-process-hardening-state` — Process-wide hardening status and OS security settings applied at bootstrap, such as dump/inspection/tamper restrictions that affect the rest of the run.
- `reg-project-trust-store` — Persisted and effective trust decisions for workspaces/projects that influence onboarding, permission assembly, sandbox behavior, and session startup.
- `reg-workspace-change-set` — Live and saved workspace change information, including file diffs, patch outcomes, reviewable changes, and rollback/snapshot data used by tools, UI, and persistence.
- `reg-memory-write-safety-state` — Cached or in-flight safety decisions for whether proposed long-term memory writes should be allowed before they update the memory store.
- `reg-session-connector-selection` — Per-session selected or enabled app/ChatGPT connectors used to decide which connector context and tools are exposed to the model.
