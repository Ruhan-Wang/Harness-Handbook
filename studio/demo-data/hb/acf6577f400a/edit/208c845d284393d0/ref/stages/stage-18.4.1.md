# Code-mode protocol contract types  `stage-18.4.1`

This stage defines the “contract” for code mode: the shared shapes and names that every other part of the system agrees to use. It is behind-the-scenes support rather than startup or shutdown work. Think of it like the official forms, labels, and rules that let different components talk without confusion.

The crate root in lib.rs gathers everything into one public package and publishes the standard tool names, so callers and runtimes refer to the same tools in the same way.

description.rs explains what those tools are. It builds rich descriptions for tools like exec and wait, including nested tools, and can turn a JSON schema— a structured description of data fields—into TypeScript types for developer-facing use. It also reads an optional first-line // @exec: note from JavaScript source to pick up execution hints.

runtime.rs defines the actual request and response payloads for running code and waiting for results, including pending states and nested tool calls. response.rs defines the content pieces those messages can carry, such as text or images. session.rs defines the longer-lived relationship around execution: cell IDs, started cells, and the traits—interfaces that describe required methods—for sessions, providers, and host callbacks.

## Files in this stage

### Crate surface
The crate root establishes the public API and canonical tool names that organize the rest of the protocol contract.

### `code-mode-protocol/src/lib.rs`

`orchestration` · `cross-cutting`

This file is a pure module-and-export hub for the code-mode protocol crate. It declares four internal modules—`description`, `response`, `runtime`, and `session`—and then selectively re-exports the protocol types and helper functions that downstream crates are expected to use. The exported surface spans three distinct concerns: tool description generation (`ToolDefinition`, `ToolNamespaceDescription`, schema rendering helpers, identifier normalization, nested-tool detection), runtime request/response types for execution and waiting (`ExecuteRequest`, `WaitRequest`, `RuntimeResponse`, pending outcomes, default yield/output constants), and session abstractions (`CodeModeSession`, delegate/provider traits and futures, cell identifiers, started-cell metadata). It also re-exports response payload types for multimodal function-call content, including image detail selection.

The only concrete values defined locally are `PUBLIC_TOOL_NAME` and `WAIT_TOOL_NAME`, fixed to `"exec"` and `"wait"`. Those constants establish the stable external names for the two primary code-mode tools and act as invariants for any caller constructing or matching tool invocations. Because this file contains no executable logic, its importance is architectural: it is the crate’s compatibility boundary, controlling which internal module items become part of the supported public protocol surface and keeping consumers insulated from internal module layout.


### Tool descriptions
These definitions describe the code-mode tools themselves, including human-readable metadata, nested declarations, and pragma parsing for executable source.

### `code-mode-protocol/src/description.rs`

`domain_logic` · `request handling`

This file is the descriptive core of the code-mode protocol. It defines the public data structures used to describe tools (`CodeModeToolKind`, `ToolDefinition`, `ToolNamespaceDescription`, `EnabledToolMetadata`, `ParsedExecSource`) and a large set of string templates for `exec`, `wait`, deferred-tool guidance, and shared MCP TypeScript types. `parse_exec_source` is the input-side parser: it accepts raw JavaScript, optionally strips and validates a first-line JSON pragma after `// @exec:`, rejects empty input, unsupported keys, missing body code, and values larger than JavaScript’s safe integer range, then returns the remaining code plus parsed execution hints.

The output-side logic generates tool descriptions suitable for model consumption. `build_exec_tool_description` starts from the fixed `EXEC_DESCRIPTION_TEMPLATE`, optionally adds deferred-tool guidance, and in code-mode-only mode appends grouped nested-tool sections. Namespace descriptions are emitted once per namespace transition, tool names are normalized into JavaScript identifiers, and MCP-aware tools trigger a single shared TypeScript preamble. Individual tool descriptions are produced by `render_code_mode_sample_for_definition`, which chooses argument naming by tool kind, renders input/output schemas into TypeScript, and wraps them in a `declare const tools: { ... }` snippet.

The schema renderer is recursive and pragmatic rather than exhaustive. It supports booleans, `const`, `enum`, `anyOf`/`oneOf`, `allOf`, typed arrays, objects with required/optional properties, `additionalProperties`, tuple-like `prefixItems`, and quoted property names when identifiers are not JavaScript-safe. Property descriptions become `//` comments in multiline object renderings. The embedded tests focus on pragma parsing, identifier normalization, declaration generation, namespace grouping, MCP type preamble deduplication, and deferred-tool guidance.

#### Function details

##### `parse_exec_source`  (lines 163–245)

```
fn parse_exec_source(input: &str) -> Result<ParsedExecSource, String>
```

**Purpose**: Parses raw `exec` input, optionally extracting a first-line JSON pragma and validating its supported fields. It returns the executable JavaScript body plus parsed execution hints or a user-facing error string.

**Data flow**: Reads `input: &str`; rejects all-whitespace input; initializes `ParsedExecSource` with the original code and empty options; splits the input into first line and remainder; if the trimmed first line lacks `CODE_MODE_PRAGMA_PREFIX`, returns the default struct unchanged. Otherwise it requires non-empty remaining code, parses the directive as JSON, rejects non-object values and unknown keys, deserializes into `CodeModeExecPragma`, enforces JavaScript safe-integer bounds for `yield_time_ms` and `max_output_tokens`, then returns `ParsedExecSource { code: rest, yield_time_ms, max_output_tokens }`.

**Call relations**: This is the parser used when `exec` receives freeform source text. It performs all validation locally and does not delegate to other file-local helpers beyond serde parsing and constant checks.

*Call graph*: 3 external calls (format!, from_str, from_value).


##### `is_code_mode_nested_tool`  (lines 247–249)

```
fn is_code_mode_nested_tool(tool_name: &str) -> bool
```

**Purpose**: Determines whether a tool name should be treated as a nested tool rather than one of the public top-level code-mode tools. It excludes the public `exec` tool and the wait tool by exact name.

**Data flow**: Takes `tool_name: &str`, compares it against `crate::PUBLIC_TOOL_NAME` and `crate::WAIT_TOOL_NAME`, and returns `true` only when it matches neither.

**Call relations**: This is a simple classification helper for callers deciding which tools belong in nested-tool metadata or descriptions.


##### `build_exec_tool_description`  (lines 251–318)

```
fn build_exec_tool_description(
    enabled_tools: &[ToolDefinition],
    namespace_descriptions: &BTreeMap<String, ToolNamespaceDescription>,
    code_mode_only: bool,
    deferred_tools_available: b
```

**Purpose**: Constructs the full textual description for the `exec` tool, optionally including deferred-tool guidance, shared MCP types, namespace guidance, and per-tool nested declarations. It is the main description assembler for code mode.

**Data flow**: Consumes `enabled_tools`, `namespace_descriptions`, `code_mode_only`, and `deferred_tools_available`. It starts a `sections` vector with `EXEC_DESCRIPTION_TEMPLATE`, optionally appends deferred guidance, and returns early if `code_mode_only` is false. Otherwise it scans enabled tools in order, detects whether any output schema looks like an MCP `CallToolResult`, emits namespace headings only when the namespace changes and the namespace description is non-empty, normalizes each tool name, renders each tool’s declaration text via `render_code_mode_sample_for_definition`, optionally prepends the shared MCP TypeScript preamble once, joins nested sections with blank lines, and returns the final combined string.

**Call relations**: Used by tests and by higher-level code that needs the model-facing `exec` description. It delegates identifier normalization, per-tool sample generation, and heading formatting to dedicated helpers.

*Call graph*: calls 3 internal fn (normalize_code_mode_identifier, render_code_mode_sample_for_definition, render_tool_heading); called by 6 (code_mode_only_description_groups_namespace_instructions_once, code_mode_only_description_includes_nested_tools, code_mode_only_description_omits_empty_namespace_sections, code_mode_only_description_renders_shared_mcp_types_once, exec_description_mentions_deferred_nested_tools_when_available, exec_description_mentions_timeout_helpers); 6 external calls (new, with_capacity, is_empty, iter, len, format!).


##### `build_wait_tool_description`  (lines 320–322)

```
fn build_wait_tool_description() -> &'static str
```

**Purpose**: Returns the fixed descriptive text for the `wait` tool. There is no dynamic content or formatting logic.

**Data flow**: Takes no arguments and returns the static `WAIT_DESCRIPTION_TEMPLATE` string slice.

**Call relations**: This is the companion to `build_exec_tool_description` for the wait/resume side of code mode.


##### `normalize_code_mode_identifier`  (lines 324–346)

```
fn normalize_code_mode_identifier(tool_key: &str) -> String
```

**Purpose**: Converts an arbitrary tool key into a JavaScript-safe identifier by preserving valid identifier characters and replacing everything else with underscores. It also guarantees a non-empty result.

**Data flow**: Iterates `tool_key.chars()` with indices, allowing only `_`, `$`, and ASCII letters in the first position and `_`, `$`, and ASCII alphanumerics afterward; invalid characters become `_`. Returns the accumulated identifier or `_` if the input produced an empty string.

**Call relations**: This normalization is reused across description generation, enabled-tool metadata, tool declarations, and schema property-name rendering so JavaScript-facing names stay consistent.

*Call graph*: called by 4 (build_exec_tool_description, enabled_tool_metadata, render_code_mode_tool_declaration, render_json_schema_property_name); 1 external calls (new).


##### `augment_tool_definition`  (lines 348–353)

```
fn augment_tool_definition(mut definition: ToolDefinition) -> ToolDefinition
```

**Purpose**: Rewrites a tool definition’s description to include a code-mode declaration sample for nested tools, while leaving the public tool’s description untouched. It enriches metadata before exposure to code mode.

**Data flow**: Takes ownership of a `ToolDefinition`, checks whether `definition.name != PUBLIC_TOOL_NAME`, and if so replaces `definition.description` with `render_code_mode_sample_for_definition(&definition)`. Returns the possibly modified definition.

**Call relations**: Used by tests and likely by higher-level metadata preparation before tool definitions are surfaced to code mode. It delegates the actual sample rendering to `render_code_mode_sample_for_definition`.

*Call graph*: calls 1 internal fn (render_code_mode_sample_for_definition); called by 3 (augment_tool_definition_appends_typed_declaration, augment_tool_definition_includes_property_descriptions_as_comments, code_mode_only_description_renders_shared_mcp_types_once).


##### `enabled_tool_metadata`  (lines 355–362)

```
fn enabled_tool_metadata(definition: &ToolDefinition) -> EnabledToolMetadata
```

**Purpose**: Projects a full `ToolDefinition` into the smaller metadata shape exposed for enabled nested tools. It computes the normalized global JavaScript name alongside the original protocol name and description.

**Data flow**: Reads a `ToolDefinition`, clones its `tool_name` and `description`, copies `kind`, computes `global_name` with `normalize_code_mode_identifier(&definition.name)`, and returns an `EnabledToolMetadata` struct.

**Call relations**: Used when callers need lightweight nested-tool metadata rather than full schemas. It depends on the same identifier normalization used in generated descriptions.

*Call graph*: calls 1 internal fn (normalize_code_mode_identifier).


##### `render_code_mode_sample`  (lines 372–384)

```
fn render_code_mode_sample(
    description: &str,
    tool_name: &str,
    input_name: &str,
    input_type: String,
    output_type: String,
) -> String
```

**Purpose**: Wraps a plain tool description with a TypeScript declaration snippet showing how the tool appears on the global `tools` object. It is the generic formatter used once input and output types are already known.

**Data flow**: Takes `description`, `tool_name`, `input_name`, `input_type`, and `output_type`; builds a declaration string using `render_code_mode_tool_declaration`, then returns a formatted string containing the original description followed by an `exec tool declaration` fenced TypeScript block.

**Call relations**: Called by `render_code_mode_sample_for_definition` after that helper derives argument naming and schema-rendered types from a concrete `ToolDefinition`.

*Call graph*: called by 1 (render_code_mode_sample_for_definition); 1 external calls (format!).


##### `render_code_mode_sample_for_definition`  (lines 386–422)

```
fn render_code_mode_sample_for_definition(definition: &ToolDefinition) -> String
```

**Purpose**: Generates the full description-plus-declaration text for one tool definition, deriving argument names and TypeScript types from tool kind and JSON schemas. It also recognizes MCP-style output schemas and wraps them as `CallToolResult<T>` when possible.

**Data flow**: Reads a `ToolDefinition`; chooses `args` for `Function` tools and `input` for `Freeform`; renders function input schema to TypeScript or uses `string` for freeform input; inspects `output_schema` with `mcp_structured_content_schema`, rendering either `CallToolResult<structured>`/`CallToolResult` or a direct schema type/`unknown`; then passes the original description and derived pieces to `render_code_mode_sample`. Returns the resulting string.

**Call relations**: This helper is the per-tool worker used by both `augment_tool_definition` and `build_exec_tool_description`. It delegates schema rendering and MCP detection to specialized helpers.

*Call graph*: calls 3 internal fn (mcp_structured_content_schema, render_code_mode_sample, render_json_schema_to_typescript); called by 2 (augment_tool_definition, build_exec_tool_description); 1 external calls (format!).


##### `render_code_mode_tool_declaration`  (lines 424–432)

```
fn render_code_mode_tool_declaration(
    tool_name: &str,
    input_name: &str,
    input_type: String,
    output_type: String,
) -> String
```

**Purpose**: Formats a single TypeScript method signature for a nested tool on the global `tools` object. It normalizes the exposed method name before embedding it in the declaration.

**Data flow**: Takes `tool_name`, `input_name`, `input_type`, and `output_type`, normalizes the tool name with `normalize_code_mode_identifier`, and returns a string like `name(arg: Type): Promise<Out>;`.

**Call relations**: Used by `render_code_mode_sample` to build the declaration snippet shown in generated tool descriptions.

*Call graph*: calls 1 internal fn (normalize_code_mode_identifier); 1 external calls (format!).


##### `render_tool_heading`  (lines 434–440)

```
fn render_tool_heading(global_name: &str, raw_name: &str) -> String
```

**Purpose**: Builds the markdown heading for one nested tool section, optionally showing both the normalized JavaScript name and the raw protocol name when they differ. This makes rewritten identifiers traceable.

**Data flow**: Compares `global_name` and `raw_name`; returns either ``### `global_name``` or ``### `global_name` (`raw_name`)`` as a `String`.

**Call relations**: Called by `build_exec_tool_description` when assembling the nested-tool reference section.

*Call graph*: called by 1 (build_exec_tool_description); 1 external calls (format!).


##### `render_json_schema_to_typescript`  (lines 442–444)

```
fn render_json_schema_to_typescript(schema: &JsonValue) -> String
```

**Purpose**: Public entry point for converting a JSON Schema fragment into a TypeScript type string. It simply forwards to the recursive internal renderer.

**Data flow**: Takes `schema: &JsonValue`, calls `render_json_schema_to_typescript_inner(schema)`, and returns the resulting string.

**Call relations**: Used by tool-sample generation whenever input or output schemas need to be shown as TypeScript.

*Call graph*: calls 1 internal fn (render_json_schema_to_typescript_inner); called by 1 (render_code_mode_sample_for_definition).


##### `mcp_structured_content_schema`  (lines 446–485)

```
fn mcp_structured_content_schema(output_schema: Option<&JsonValue>) -> Option<&JsonValue>
```

**Purpose**: Detects whether an output schema matches the shape of an MCP `CallToolResult` and, if so, extracts the schema for `structuredContent`. This lets descriptions render `CallToolResult<T>` instead of a generic object.

**Data flow**: Accepts `Option<&JsonValue>`; returns `None` unless the schema is an object with `properties.content` as an array of objects, `properties.isError` as boolean, and `properties._meta` as object. When those checks pass, it returns `properties.structuredContent` if present or a synthetic `JsonValue::Bool(true)` reference to represent unknown structured content.

**Call relations**: Called by `render_code_mode_sample_for_definition` to decide whether a tool’s output should be described as an MCP call result wrapper.

*Call graph*: called by 1 (render_code_mode_sample_for_definition); 1 external calls (Bool).


##### `render_json_schema_to_typescript_inner`  (lines 487–560)

```
fn render_json_schema_to_typescript_inner(schema: &JsonValue) -> String
```

**Purpose**: Recursively converts a JSON Schema value into a TypeScript type expression, covering literals, unions, intersections, arrays, objects, and primitive keywords. It is the core schema renderer.

**Data flow**: Matches on the `JsonValue`: `true` becomes `unknown`, `false` becomes `never`, objects are inspected for `const`, `enum`, `anyOf`/`oneOf`, `allOf`, `type`, object-shape keys, and array-shape keys in that order, delegating to `render_json_schema_literal`, `render_json_schema_type_keyword`, `render_json_schema_object`, or `render_json_schema_array` as needed. Non-object non-boolean values fall back to `unknown`.

**Call relations**: This internal recursive worker underpins all schema-to-TypeScript rendering. Other helpers call it for nested item types, property types, and additional-properties types.

*Call graph*: calls 4 internal fn (render_json_schema_array, render_json_schema_literal, render_json_schema_object, render_json_schema_type_keyword); called by 4 (append_additional_properties_line, render_json_schema_array, render_json_schema_object_property, render_json_schema_to_typescript).


##### `render_json_schema_type_keyword`  (lines 562–575)

```
fn render_json_schema_type_keyword(
    map: &serde_json::Map<String, JsonValue>,
    schema_type: &str,
) -> String
```

**Purpose**: Maps a JSON Schema `type` keyword to the corresponding TypeScript representation, delegating complex container types to object/array renderers. Unknown schema types degrade to `unknown`.

**Data flow**: Takes the containing schema map and a `schema_type` string; returns primitive TypeScript keywords for `string`, `number`/`integer`, `boolean`, and `null`, or delegates to `render_json_schema_array`/`render_json_schema_object` for `array` and `object`.

**Call relations**: Used by `render_json_schema_to_typescript_inner` when a schema declares a `type` field.

*Call graph*: calls 2 internal fn (render_json_schema_array, render_json_schema_object); called by 1 (render_json_schema_to_typescript_inner).


##### `render_json_schema_array`  (lines 577–594)

```
fn render_json_schema_array(map: &serde_json::Map<String, JsonValue>) -> String
```

**Purpose**: Renders array-like schemas as either homogeneous `Array<T>` or tuple-like `[A, B, ...]` TypeScript types. It falls back to `unknown[]` when item typing is absent.

**Data flow**: Reads a schema map; if `items` exists, recursively renders that schema and returns `Array<item_type>`. Otherwise, if `prefixItems` is an array, recursively renders each entry and returns a tuple string when non-empty. If neither path yields a type, returns `unknown[]`.

**Call relations**: Called from both `render_json_schema_to_typescript_inner` and `render_json_schema_type_keyword` whenever array semantics are needed.

*Call graph*: calls 1 internal fn (render_json_schema_to_typescript_inner); called by 2 (render_json_schema_to_typescript_inner, render_json_schema_type_keyword); 2 external calls (get, format!).


##### `append_additional_properties_line`  (lines 596–615)

```
fn append_additional_properties_line(
    lines: &mut Vec<String>,
    map: &serde_json::Map<String, JsonValue>,
    properties: &serde_json::Map<String, JsonValue>,
    line_prefix: &str,
)
```

**Purpose**: Appends an index-signature line for object schemas based on `additionalProperties`, or a default unknown index signature for empty property sets. It centralizes the object-tail behavior shared by multiline and single-line object rendering.

**Data flow**: Mutates the provided `lines: &mut Vec<String>` after inspecting `map` and `properties`. If `additionalProperties` is `true`, it appends `[key: string]: unknown;`; if `false`, it appends nothing; if it is a schema value, it recursively renders that type and appends it. When `additionalProperties` is absent and `properties` is empty, it appends a default unknown index signature.

**Call relations**: Used only by `render_json_schema_object` so object rendering handles open-ended maps consistently.

*Call graph*: calls 1 internal fn (render_json_schema_to_typescript_inner); called by 1 (render_json_schema_object); 3 external calls (get, is_empty, format!).


##### `has_property_description`  (lines 617–622)

```
fn has_property_description(value: &JsonValue) -> bool
```

**Purpose**: Checks whether a property schema contains a non-empty `description` string. This determines whether object rendering should switch to multiline commented formatting.

**Data flow**: Reads `value.get("description")`, converts it to `&str`, tests for non-empty content, and returns a boolean.

**Call relations**: Called by `render_json_schema_object` before choosing between compact single-line output and multiline output with comment lines.

*Call graph*: 1 external calls (get).


##### `render_json_schema_object_property`  (lines 624–633)

```
fn render_json_schema_object_property(name: &str, value: &JsonValue, required: &[&str]) -> String
```

**Purpose**: Formats one object property declaration, including optional-marker logic and safe property-name quoting. It is the per-property renderer for object schemas.

**Data flow**: Takes a property `name`, its schema `value`, and the list of required property names; determines whether the property is optional, renders the property name via `render_json_schema_property_name`, renders the property type recursively, and returns a string like `name?: Type;` or `"bad-name": Type;`.

**Call relations**: Used by `render_json_schema_object` for both compact and multiline object layouts.

*Call graph*: calls 2 internal fn (render_json_schema_property_name, render_json_schema_to_typescript_inner); 1 external calls (format!).


##### `render_json_schema_object`  (lines 635–693)

```
fn render_json_schema_object(map: &serde_json::Map<String, JsonValue>) -> String
```

**Purpose**: Renders object schemas into TypeScript object literals, preserving required/optional fields, sorted property order, optional inline comments from property descriptions, and index signatures for additional properties. It chooses multiline formatting when any property has a description.

**Data flow**: Reads `required`, clones `properties`, sorts properties by name, and checks whether any property has a description via `has_property_description`. In multiline mode it emits `{`, optional `//` comment lines from each property description, indented property declarations from `render_json_schema_object_property`, appends any additional-properties line, and closes with `}` joined by newlines. In compact mode it collects property declarations into a vector, appends any additional-properties line, returns `{}` when empty, or joins declarations inside `{ ... }`.

**Call relations**: Called by the recursive schema renderer whenever an object schema or object-like shape is encountered. It delegates property formatting and additional-properties handling to dedicated helpers.

*Call graph*: calls 1 internal fn (append_additional_properties_line); called by 2 (render_json_schema_to_typescript_inner, render_json_schema_type_keyword); 3 external calls (get, format!, vec!).


##### `render_json_schema_property_name`  (lines 695–701)

```
fn render_json_schema_property_name(name: &str) -> String
```

**Purpose**: Produces a TypeScript-safe property name, leaving valid identifiers bare and quoting invalid ones as JSON strings. This preserves exact schema keys without generating invalid syntax.

**Data flow**: Takes `name: &str`, compares it to `normalize_code_mode_identifier(name)`, and returns either the original name or a JSON-quoted string produced by `serde_json::to_string`, with a manual escaped fallback if serialization somehow fails.

**Call relations**: Used by `render_json_schema_object_property` so object property declarations remain syntactically valid in generated TypeScript.

*Call graph*: calls 1 internal fn (normalize_code_mode_identifier); called by 1 (render_json_schema_object_property); 1 external calls (to_string).


##### `render_json_schema_literal`  (lines 703–705)

```
fn render_json_schema_literal(value: &JsonValue) -> String
```

**Purpose**: Serializes a JSON literal value into its TypeScript literal representation. It is used for `const` and `enum` members.

**Data flow**: Takes `value: &JsonValue`, serializes it with `serde_json::to_string`, and falls back to `unknown` if serialization fails. Returns the resulting string.

**Call relations**: Called by the recursive schema renderer when handling `const` and `enum` schema forms.

*Call graph*: called by 1 (render_json_schema_to_typescript_inner); 1 external calls (to_string).


##### `tests::mcp_call_tool_result_schema`  (lines 723–740)

```
fn mcp_call_tool_result_schema(structured_content_schema: JsonValue) -> JsonValue
```

**Purpose**: Builds a reusable JSON fixture representing an MCP-style `CallToolResult` schema with caller-supplied `structuredContent`. It reduces duplication across tests that need MCP output schemas.

**Data flow**: Takes `structured_content_schema: JsonValue` and returns a `json!` object containing `content`, `structuredContent`, `isError`, `_meta`, required `content`, and `additionalProperties: false`.

**Call relations**: Used by multiple tests that verify MCP-aware description rendering and namespace grouping.

*Call graph*: 1 external calls (json!).


##### `tests::parse_exec_source_without_pragma`  (lines 743–752)

```
fn parse_exec_source_without_pragma()
```

**Purpose**: Asserts that plain JavaScript input without a pragma is returned unchanged with no execution hints. It verifies the parser’s non-pragma fast path.

**Data flow**: Calls `parse_exec_source("text('hi')")`, unwraps the result, and compares it to an expected `ParsedExecSource` with `None` options using `assert_eq!`.

**Call relations**: Executed by the test harness to validate `parse_exec_source` behavior for the simplest accepted input.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_exec_source_with_pragma`  (lines 755–764)

```
fn parse_exec_source_with_pragma()
```

**Purpose**: Checks that a valid first-line pragma is parsed and stripped from the returned code body. It verifies extraction of `yield_time_ms`.

**Data flow**: Calls `parse_exec_source` with a pragma line plus body code, unwraps the result, and asserts equality with a `ParsedExecSource` containing `code: "text('hi')"` and `yield_time_ms: Some(10)`.

**Call relations**: This test exercises the pragma-aware branch of `parse_exec_source`.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_identifier_rewrites_invalid_characters`  (lines 767–776)

```
fn normalize_identifier_rewrites_invalid_characters()
```

**Purpose**: Verifies that already valid identifiers are preserved and invalid characters such as hyphens are rewritten to underscores. It anchors the normalization rules used throughout description generation.

**Data flow**: Calls `normalize_code_mode_identifier` on two sample names and compares the outputs to expected strings with `assert_eq!`.

**Call relations**: Run by the test harness to protect the identifier normalization contract used by nested tool declarations.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::augment_tool_definition_appends_typed_declaration`  (lines 779–805)

```
fn augment_tool_definition_appends_typed_declaration()
```

**Purpose**: Ensures that augmenting a function-style tool definition appends a typed `declare const tools` declaration to its description. It checks both presence and exact rendered signature shape.

**Data flow**: Constructs a `ToolDefinition` with object input/output schemas, passes it to `augment_tool_definition`, extracts the resulting description, and asserts that it contains the declaration scaffold and the expected typed method signature.

**Call relations**: This test validates the integration of `augment_tool_definition`, schema rendering, and declaration formatting.

*Call graph*: calls 2 internal fn (augment_tool_definition, plain); 2 external calls (assert!, json!).


##### `tests::augment_tool_definition_includes_property_descriptions_as_comments`  (lines 808–853)

```
fn augment_tool_definition_includes_property_descriptions_as_comments()
```

**Purpose**: Checks that property descriptions in JSON Schema become `//` comments in generated multiline TypeScript object types. It verifies the richer object-rendering path.

**Data flow**: Builds a `ToolDefinition` whose input and output schemas include property descriptions, augments it, and asserts that the resulting description contains a declaration snippet with embedded comment lines and correctly rendered nested types.

**Call relations**: Exercises `augment_tool_definition` together with multiline object rendering and comment emission in `render_json_schema_object`.

*Call graph*: calls 2 internal fn (augment_tool_definition, plain); 2 external calls (assert!, json!).


##### `tests::code_mode_only_description_includes_nested_tools`  (lines 856–875)

```
fn code_mode_only_description_includes_nested_tools()
```

**Purpose**: Verifies that code-mode-only exec descriptions include nested tool sections and do not include unrelated legacy guidance. It checks the basic nested-tool assembly path.

**Data flow**: Calls `build_exec_tool_description` with one enabled tool, an empty namespace map, `code_mode_only = true`, and no deferred tools, then asserts that the output contains the expected heading/body text and omits an unwanted phrase.

**Call relations**: This test targets the nested-tool branch of `build_exec_tool_description`.

*Call graph*: calls 2 internal fn (build_exec_tool_description, plain); 2 external calls (new, assert!).


##### `tests::exec_description_mentions_timeout_helpers`  (lines 878–887)

```
fn exec_description_mentions_timeout_helpers()
```

**Purpose**: Ensures the base exec description mentions the `setTimeout` and `clearTimeout` helpers. It protects important runtime guidance embedded in the static template.

**Data flow**: Calls `build_exec_tool_description` with no tools and `code_mode_only = false`, then asserts that the returned description contains both helper signatures.

**Call relations**: This test validates the static `EXEC_DESCRIPTION_TEMPLATE` content as surfaced by `build_exec_tool_description`.

*Call graph*: calls 1 internal fn (build_exec_tool_description); 2 external calls (new, assert!).


##### `tests::code_mode_only_description_groups_namespace_instructions_once`  (lines 890–945)

```
fn code_mode_only_description_groups_namespace_instructions_once()
```

**Purpose**: Checks that namespace guidance is emitted once per namespace even when multiple tools share it, and that MCP-aware declarations are rendered for each tool. It verifies namespace transition logic and MCP type wrapping.

**Data flow**: Builds a namespace description map and two namespaced tool definitions with MCP-style output schemas, calls `build_exec_tool_description`, then asserts that the namespace heading appears exactly once and that both tool declarations use `Promise<CallToolResult<{}>>`.

**Call relations**: This test exercises the namespace-grouping branch inside `build_exec_tool_description` and the MCP detection path in `render_code_mode_sample_for_definition`.

*Call graph*: calls 2 internal fn (build_exec_tool_description, namespaced); 5 external calls (from, assert!, assert_eq!, mcp_call_tool_result_schema, json!).


##### `tests::code_mode_only_description_omits_empty_namespace_sections`  (lines 948–980)

```
fn code_mode_only_description_omits_empty_namespace_sections()
```

**Purpose**: Verifies that namespace headings are skipped when the namespace description text is empty, even if tools belong to that namespace. It protects against noisy empty sections.

**Data flow**: Creates a namespace map with an empty description and one namespaced tool, calls `build_exec_tool_description`, and asserts that no namespace heading is present while the tool heading still is.

**Call relations**: This test targets the conditional namespace-heading emission logic in `build_exec_tool_description`.

*Call graph*: calls 2 internal fn (build_exec_tool_description, namespaced); 5 external calls (from, new, assert!, mcp_call_tool_result_schema, json!).


##### `tests::code_mode_only_description_renders_shared_mcp_types_once`  (lines 983–1084)

```
fn code_mode_only_description_renders_shared_mcp_types_once()
```

**Purpose**: Ensures that when multiple MCP-style tools are present, the shared TypeScript preamble is included exactly once. It prevents duplicated boilerplate in generated descriptions.

**Data flow**: Builds two MCP-style tool definitions, first augmenting them to reuse realistic schemas, then calls `build_exec_tool_description` and counts occurrences of the `CallToolResult` type alias and `Shared MCP Types:` heading with `assert_eq!`.

**Call relations**: This test validates the `has_mcp_tools` branch and one-time preamble insertion in `build_exec_tool_description`.

*Call graph*: calls 3 internal fn (augment_tool_definition, build_exec_tool_description, namespaced); 3 external calls (new, assert_eq!, json!).


##### `tests::exec_description_mentions_deferred_nested_tools_when_available`  (lines 1087–1098)

```
fn exec_description_mentions_deferred_nested_tools_when_available()
```

**Purpose**: Checks that deferred nested-tool guidance is appended when the corresponding flag is enabled. It also ensures unrelated wording is absent.

**Data flow**: Calls `build_exec_tool_description` with no tools, `code_mode_only = false`, and `deferred_tools_available = true`, then asserts presence of the deferred-tools guidance text and absence of an unwanted phrase.

**Call relations**: This test covers the optional deferred-guidance branch in `build_exec_tool_description`.

*Call graph*: calls 1 internal fn (build_exec_tool_description); 2 external calls (new, assert!).


### Runtime payload schemas
These data models define what code-mode tools send and receive at execution time, from content payloads to runtime request and response envelopes.

### `code-mode-protocol/src/response.rs`

`data_model` · `request handling`

This file contains the small data model used to represent multimodal content items associated with function-call output. `ImageDetail` is a serde-backed enum with lowercase wire values `auto`, `low`, `high`, and `original`; it is `Copy`, `Eq`, and `Deserialize`/`Serialize`, so it can be cheaply propagated through request/response structures and round-tripped over JSON without custom code. `DEFAULT_IMAGE_DETAIL` fixes the crate’s default image fidelity to `ImageDetail::High`, making the preferred behavior explicit rather than implicit.

The main payload type is `FunctionCallOutputContentItem`, a tagged enum serialized with a `type` discriminator in `snake_case`. It has two variants: `InputText { text: String }` for plain textual content and `InputImage { image_url: String, detail: Option<ImageDetail> }` for image references. The `detail` field is optional and omitted entirely when `None`, which preserves compact JSON and lets callers rely on server defaults unless they need to override fidelity. The design is intentionally narrow: this file does not define transport behavior or validation logic, only the exact JSON shape and Rust types that other protocol layers consume. The serde attributes are the critical implementation detail, because they lock down the external wire contract.


### `code-mode-protocol/src/runtime.rs`

`data_model` · `request handling`

This file is almost entirely declarative. It establishes the serialized protocol types exchanged with a code-mode runtime: `ExecuteRequest` carries the tool call ID, enabled nested tools, source code, and optional execution limits; `WaitRequest` and `WaitToPendingRequest` identify a running cell to resume or transition; `ExecuteToPendingOutcome`, `WaitOutcome`, and `WaitToPendingOutcome` model the different ways execution can yield, complete, remain live, or refer to a missing cell. `RuntimeResponse` is the core terminal/yielding payload, with `Yielded`, `Terminated`, and `Result` variants that all carry a `CellId` and emitted `FunctionCallOutputContentItem`s, with `Result` optionally including `error_text`.

The file also defines `CodeModeNestedToolCall`, the payload used when a running cell invokes another tool: it records the originating cell, a runtime-local tool call ID, the protocol `ToolName`, the nested tool kind, and optional JSON input. Constants provide default yield times and output-token budgets for exec/wait behavior.

Behavior is intentionally minimal: the only implementation is `From<WaitOutcome> for RuntimeResponse`, which discards whether the response came from a live or missing cell and extracts the embedded `RuntimeResponse`. That conversion is useful when callers only care about the payload shape, not the provenance.

#### Function details

##### `RuntimeResponse::from`  (lines 58–62)

```
fn from(outcome: WaitOutcome) -> Self
```

**Purpose**: Converts a `WaitOutcome` into its contained `RuntimeResponse`, ignoring whether the source cell was live or missing. It is a convenience adapter between two protocol layers.

**Data flow**: Takes ownership of a `WaitOutcome`, pattern-matches both `LiveCell(response)` and `MissingCell(response)`, and returns the inner `RuntimeResponse` unchanged.

**Call relations**: Used by callers that receive a `WaitOutcome` but want to continue processing only the common response payload without branching on cell existence.


### Session contracts
These abstractions define the longer-lived session boundary between callers and code-mode runtimes, including identifiers, wrappers, and provider/session traits.

### `code-mode-protocol/src/session.rs`

`data_model` · `request handling`

This file establishes the asynchronous interface for executing and managing code-mode cells. It begins with boxed-future type aliases that standardize return shapes for session operations, nested tool invocations, and notifications. `CellId` is a thin newtype around `String` with serde support plus convenience methods and trait impls (`AsRef<str>`, `Display`) so it can move cleanly through protocol, logging, and map-key contexts.

`StartedCell` represents a newly launched cell whose first runtime response may arrive later. Instead of exposing the raw `oneshot::Receiver`, it stores a boxed future named `initial_response`. Two constructors cover the two receiver shapes used by implementations: one where the channel carries a plain `RuntimeResponse`, and one where it carries `Result<RuntimeResponse, String>`. Both normalize channel-closure into the same user-facing error string, `"exec runtime ended unexpectedly"`. The `initial_response(self)` method then awaits and returns that normalized result.

The rest of the file is trait definitions. `CodeModeSessionDelegate` is the callback surface a runtime uses to invoke nested tools, emit notifications, and release per-cell delegate state after terminal completion. `CodeModeSession` defines liveness checks plus async `execute`, `wait`, `terminate`, and `shutdown` operations for a durable session whose cells share stored values. `CodeModeSessionProvider` creates sessions for Codex threads, potentially sharing an underlying remote host across sessions. The file is therefore the protocol-facing boundary for all session implementations.

#### Function details

##### `CellId::new`  (lines 30–32)

```
fn new(value: String) -> Self
```

**Purpose**: Constructs a new cell identifier from an owned string. It is the canonical constructor for the `CellId` newtype.

**Data flow**: Takes `value: String`, wraps it in `CellId(value)`, and returns the new struct without side effects.

**Call relations**: Used wherever a fresh cell ID is allocated or reconstructed from protocol data before being passed through session APIs.

*Call graph*: called by 5 (started_cell_preserves_remote_initial_response_errors, allocate_cell_id, cell_id, cell_id, handle_call).


##### `CellId::as_str`  (lines 34–36)

```
fn as_str(&self) -> &str
```

**Purpose**: Returns the underlying cell ID as a string slice. It provides borrowed access without exposing the inner field directly.

**Data flow**: Reads `self.0` and returns `&str` referencing the inner `String`.

**Call relations**: This is the shared accessor used by both the `AsRef<str>` and `Display` implementations.

*Call graph*: called by 2 (as_ref, fmt).


##### `CellId::as_ref`  (lines 40–42)

```
fn as_ref(&self) -> &str
```

**Purpose**: Implements `AsRef<str>` for `CellId` by forwarding to `as_str`. This lets `CellId` be passed to APIs expecting a generic string reference.

**Data flow**: Takes `&self`, calls `self.as_str()`, and returns the borrowed `&str`.

**Call relations**: Invoked implicitly by generic code using `AsRef<str>`. It delegates all logic to `CellId::as_str`.

*Call graph*: calls 1 internal fn (as_str).


##### `CellId::fmt`  (lines 46–48)

```
fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Implements `Display` for `CellId` by writing the raw identifier string. It makes cell IDs printable in logs and messages.

**Data flow**: Reads `self.as_str()` and writes it into the provided formatter with `write_str`, returning the resulting `fmt::Result`.

**Call relations**: Used implicitly whenever a `CellId` is formatted with `{}`. It delegates string access to `CellId::as_str`.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `StartedCell::new`  (lines 57–66)

```
fn new(cell_id: CellId, initial_response_rx: oneshot::Receiver<RuntimeResponse>) -> Self
```

**Purpose**: Creates a `StartedCell` from a oneshot receiver that will eventually yield a plain `RuntimeResponse`. It wraps the receiver in a boxed future and normalizes channel closure into a stable error message.

**Data flow**: Takes a `cell_id` and `oneshot::Receiver<RuntimeResponse>`, stores the ID, and builds `initial_response` as a pinned async block that awaits the receiver and maps `RecvError` to `Err("exec runtime ended unexpectedly")`. Returns the assembled `StartedCell`.

**Call relations**: Used by session implementations that can guarantee the initial response channel carries only successful runtime responses. Callers later consume the future through `StartedCell::initial_response`.

*Call graph*: 1 external calls (pin).


##### `StartedCell::from_result_receiver`  (lines 68–80)

```
fn from_result_receiver(
        cell_id: CellId,
        initial_response_rx: oneshot::Receiver<Result<RuntimeResponse, String>>,
    ) -> Self
```

**Purpose**: Creates a `StartedCell` from a oneshot receiver whose payload is already a `Result<RuntimeResponse, String>`. It preserves runtime-reported errors while still normalizing channel closure.

**Data flow**: Takes a `cell_id` and `oneshot::Receiver<Result<RuntimeResponse, String>>`, stores the ID, and builds `initial_response` as a pinned async block that awaits the receiver, maps channel closure to `"exec runtime ended unexpectedly"`, and then propagates the inner `Result`. Returns the new `StartedCell`.

**Call relations**: Used by implementations whose startup path can fail asynchronously after cell allocation. It is called by runtime/session code and covered by tests that verify remote initial-response errors are preserved.

*Call graph*: called by 2 (started_cell_preserves_remote_initial_response_errors, execute); 1 external calls (pin).


##### `StartedCell::initial_response`  (lines 82–84)

```
async fn initial_response(self) -> Result<RuntimeResponse, String>
```

**Purpose**: Awaits and returns the first runtime response for a started cell. It consumes the `StartedCell`, ensuring the one-time initial response cannot be awaited twice.

**Data flow**: Takes ownership of `self`, awaits the boxed `initial_response` future, and returns `Result<RuntimeResponse, String>`.

**Call relations**: Called by code that has just executed a cell and needs the first yielded/completed response before proceeding with later waits.
