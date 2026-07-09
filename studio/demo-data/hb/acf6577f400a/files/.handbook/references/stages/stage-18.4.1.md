# Code-mode protocol contract types  `stage-18.4.1`

This stage is shared behind-the-scenes support. It does not run code itself. Instead, it defines the public “contract” that other parts of the system agree to use when they talk about code mode. Think of it like the standard set of forms and labels used by everyone in an office.

The crate front door, lib.rs, gathers the important names from the internal files and re-exports them so other code can import them from one simple place. description.rs explains the available code-mode tools in human-readable text, including TypeScript-style examples, and reads small settings placed at the top of JavaScript input. response.rs defines common result content, such as text and images, and keeps their JSON shape consistent. runtime.rs defines the request and response messages exchanged with the runtime, the worker that actually executes code cells and reports progress or final results. session.rs defines the longer-lived session contract: how to start code, wait for answers, call tools, send updates, and shut everything down cleanly.

## Files in this stage

### Crate surface
The crate root establishes the public API and canonical tool names that organize the rest of the protocol contract.

### `code-mode-protocol/src/lib.rs`

`other` · `cross-cutting public API surface`

This file does not contain the detailed code-mode behavior itself. Instead, it works like the reception desk of a small office: it knows which internal room has which service, and it makes the useful services easy for outsiders to find. The crate is split into internal modules for tool descriptions, tool responses, runtime requests and outcomes, and session-related types. Without this file, users of the crate would need to know those internal module names and import items from many places, which would make the crate harder to use and easier to accidentally depend on internal layout.

The `mod` lines declare the crate’s internal parts: `description`, `response`, `runtime`, and `session`. The many `pub use` lines then re-export selected items from those parts. “Re-export” means the item is defined somewhere else, but made available here as if it lived at the crate root. For example, callers can import `CodeModeSession` or `ExecuteRequest` directly from this crate instead of digging into submodules.

At the end, it defines two public tool-name constants: `PUBLIC_TOOL_NAME` is `"exec"`, and `WAIT_TOOL_NAME` is `"wait"`. These give the rest of the system shared spellings for the code execution and waiting tools, avoiding fragile repeated string literals.


### Tool descriptions
These definitions describe the code-mode tools themselves, including human-readable metadata, nested declarations, and pragma parsing for executable source.

### `code-mode-protocol/src/description.rs`

`domain_logic` · `tool description generation and exec input parsing`

This part of the file is like the label maker and instruction writer for code mode. Code mode lets JavaScript call tools through a `tools` object, so the system needs clear descriptions such as “call this tool with these arguments and expect this result.” Without this, tools would still exist, but users or models would have to guess their names, argument shapes, and return shapes.

The file also reads an optional first-line instruction, called a pragma, from exec source text. That pragma is a small JSON object in a comment, used to set limits such as how long execution may yield and how much output may be returned.

A large part of the code translates JSON Schema, a machine-readable way to describe data, into TypeScript-looking types that are easier for JavaScript authors to understand. For example, an object schema with a required `city` string becomes something like `{ city: string; }`. It also treats MCP tool results specially, so shared result wrapper types are shown only once.

The tests at the end check the important promises: pragmas are parsed safely, tool names are made JavaScript-safe, descriptions include useful type declarations, namespace guidance is not repeated, and MCP helper types are not duplicated.

#### Function details

##### `parse_exec_source`  (lines 163–245)

```
fn parse_exec_source(input: &str) -> Result<ParsedExecSource, String>
```

**Purpose**: Reads the JavaScript source passed to the exec tool and optionally extracts settings from a special first-line comment. This lets a caller write code normally, while still asking for limits such as a yield timeout or maximum output size.

**Data flow**: It receives raw text. If the text is empty, it returns an error. It looks only at the first line for a `// @exec:` directive; if there is none, it returns the original code with no extra settings. If the directive exists, it parses the JSON after it, checks that only supported fields are present and that their numbers are safe, then returns the remaining lines as the actual JavaScript code plus the parsed settings.

**Call relations**: This is a public parser used before exec code is run. Internally it relies on JSON parsing and conversion helpers to turn the pragma text into structured values, and the tests call it to confirm both plain source and pragma-bearing source behave correctly.

*Call graph*: 3 external calls (format!, from_str, from_value).


##### `is_code_mode_nested_tool`  (lines 247–249)

```
fn is_code_mode_nested_tool(tool_name: &str) -> bool
```

**Purpose**: Decides whether a tool should be treated as a nested tool inside code mode rather than one of the public top-level code mode tools. This keeps the special exec and wait tools separate from tools that JavaScript code may call through the nested `tools` interface.

**Data flow**: It receives a tool name as text. It compares that name with the public exec tool name and the wait tool name. It returns `true` for everything else and `false` for those two reserved tools.

**Call relations**: Other code can use this small check while building or filtering the list of tools available inside code mode. It depends only on the crate’s public tool-name constants.


##### `build_exec_tool_description`  (lines 251–318)

```
fn build_exec_tool_description(
    enabled_tools: &[ToolDefinition],
    namespace_descriptions: &BTreeMap<String, ToolNamespaceDescription>,
    code_mode_only: bool,
    deferred_tools_available: b
```

**Purpose**: Builds the full description shown for the exec tool. In code-mode-only situations, it also includes a reference section that lists the nested tools JavaScript can call.

**Data flow**: It receives the enabled tool definitions, optional namespace descriptions, a flag saying whether only code mode tools should be described, and a flag saying whether deferred tools exist. It starts with the standard exec instructions, optionally adds guidance about deferred nested tools, and, when code-mode-only output is requested, adds headings and TypeScript-like call examples for each enabled nested tool. It returns one combined text block.

**Call relations**: This is the main description builder used by tests that verify nested tools, namespace grouping, timeout text, deferred-tool guidance, and shared MCP type rendering. It calls the name normalizer, tool-sample renderer, heading renderer, and MCP schema recognizer so the final text is readable and not repetitive.

*Call graph*: calls 3 internal fn (normalize_code_mode_identifier, render_code_mode_sample_for_definition, render_tool_heading); called by 6 (code_mode_only_description_groups_namespace_instructions_once, code_mode_only_description_includes_nested_tools, code_mode_only_description_omits_empty_namespace_sections, code_mode_only_description_renders_shared_mcp_types_once, exec_description_mentions_deferred_nested_tools_when_available, exec_description_mentions_timeout_helpers); 6 external calls (new, with_capacity, is_empty, iter, len, format!).


##### `build_wait_tool_description`  (lines 320–322)

```
fn build_wait_tool_description() -> &'static str
```

**Purpose**: Returns the fixed description text for the wait tool. The wait tool has static instructions, so no custom assembly is needed.

**Data flow**: It takes no input. It returns the built-in wait description template exactly as a static string.

**Call relations**: This is the simple counterpart to the exec description builder. Callers use it when registering or describing the wait tool.


##### `normalize_code_mode_identifier`  (lines 324–346)

```
fn normalize_code_mode_identifier(tool_key: &str) -> String
```

**Purpose**: Turns any tool name into something safe to use as a JavaScript identifier. For example, a name with dashes is rewritten so it can be used as `tools.some_name(...)` style code.

**Data flow**: It receives a tool key as text. It walks through each character and keeps letters, numbers in non-first positions, underscores, and dollar signs where JavaScript allows them. Invalid characters become underscores. If nothing usable remains, it returns `_`.

**Call relations**: This helper is used wherever a raw tool or property name must become code-like text: exec descriptions, enabled tool metadata, tool declarations, and JSON Schema property rendering. Tests check that invalid characters are rewritten predictably.

*Call graph*: called by 4 (build_exec_tool_description, enabled_tool_metadata, render_code_mode_tool_declaration, render_json_schema_property_name); 1 external calls (new).


##### `augment_tool_definition`  (lines 348–353)

```
fn augment_tool_definition(mut definition: ToolDefinition) -> ToolDefinition
```

**Purpose**: Adds a code-mode call example to a tool definition’s description. This makes a plain tool description more useful when shown inside code mode.

**Data flow**: It receives a tool definition. If the tool is not the public exec tool, it replaces the description with a rendered sample that includes the original description and a TypeScript-style declaration. It returns the updated tool definition.

**Call relations**: Tests call this to confirm typed declarations and property comments are added. It hands the detailed rendering work to `render_code_mode_sample_for_definition`.

*Call graph*: calls 1 internal fn (render_code_mode_sample_for_definition); called by 3 (augment_tool_definition_appends_typed_declaration, augment_tool_definition_includes_property_descriptions_as_comments, code_mode_only_description_renders_shared_mcp_types_once).


##### `enabled_tool_metadata`  (lines 355–362)

```
fn enabled_tool_metadata(definition: &ToolDefinition) -> EnabledToolMetadata
```

**Purpose**: Creates a compact metadata record for an enabled tool. This gives later code the original tool identity, a JavaScript-safe global name, its description, and its kind.

**Data flow**: It receives a full tool definition. It copies the tool name, normalizes the public name into a safe global name, copies the description, and keeps the tool kind. It returns an `EnabledToolMetadata` value.

**Call relations**: This is a small adapter between full tool definitions and whatever code only needs display or lookup metadata. It uses the same name normalization as the description renderer so names stay consistent.

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

**Purpose**: Builds the text snippet that shows how a specific tool can be called from code mode. It combines the tool’s description with a TypeScript-style declaration.

**Data flow**: It receives descriptive text, the tool name, the argument name, the rendered input type, and the rendered output type. It formats those into a `declare const tools: ...` block and returns the original description followed by that declaration.

**Call relations**: This is called by `render_code_mode_sample_for_definition` after that function has figured out the correct input and output types. It delegates the one-line function signature to `render_code_mode_tool_declaration`.

*Call graph*: called by 1 (render_code_mode_sample_for_definition); 1 external calls (format!).


##### `render_code_mode_sample_for_definition`  (lines 386–422)

```
fn render_code_mode_sample_for_definition(definition: &ToolDefinition) -> String
```

**Purpose**: Turns a full tool definition into a friendly code-mode example. It decides what the tool’s argument should be called and what TypeScript-like input and output types to show.

**Data flow**: It receives a tool definition. For function tools it uses an `args` parameter and renders the input schema; for freeform tools it uses an `input` string. For outputs, it detects MCP call-tool results and wraps their structured content in `CallToolResult` when appropriate. It returns a combined description and declaration sample.

**Call relations**: This is the main rendering helper behind both `augment_tool_definition` and `build_exec_tool_description`. It calls the JSON Schema renderer and MCP result recognizer, then hands the final pieces to `render_code_mode_sample`.

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

**Purpose**: Creates the TypeScript-style function signature for one tool. This is the compact line that says what arguments the tool accepts and what promise it returns.

**Data flow**: It receives the raw tool name, the parameter name, and already-rendered input and output type strings. It normalizes the tool name into a JavaScript-safe identifier and returns a string such as `tool(args: Type): Promise<Result>;`.

**Call relations**: This is used inside `render_code_mode_sample`. It depends on `normalize_code_mode_identifier` so generated examples do not contain invalid JavaScript names.

*Call graph*: calls 1 internal fn (normalize_code_mode_identifier); 1 external calls (format!).


##### `render_tool_heading`  (lines 434–440)

```
fn render_tool_heading(global_name: &str, raw_name: &str) -> String
```

**Purpose**: Creates a markdown heading for a nested tool in the exec description. If the JavaScript-safe name differs from the real tool name, it shows both so readers can connect them.

**Data flow**: It receives the safe global name and the raw tool name. If they match, it returns a heading with one name. If they differ, it returns a heading with the safe name followed by the raw name in parentheses.

**Call relations**: The exec description builder calls this for every nested tool section. It keeps the description clear when names were normalized.

*Call graph*: called by 1 (build_exec_tool_description); 1 external calls (format!).


##### `render_json_schema_to_typescript`  (lines 442–444)

```
fn render_json_schema_to_typescript(schema: &JsonValue) -> String
```

**Purpose**: Converts a JSON Schema value into a TypeScript-like type string. This makes machine-readable schemas understandable to people writing JavaScript tool calls.

**Data flow**: It receives a JSON value representing a schema. It passes that schema to the inner renderer and returns the rendered type text.

**Call relations**: This is the public wrapper used by tool-sample rendering. The real decision tree lives in `render_json_schema_to_typescript_inner`.

*Call graph*: calls 1 internal fn (render_json_schema_to_typescript_inner); called by 1 (render_code_mode_sample_for_definition).


##### `mcp_structured_content_schema`  (lines 446–485)

```
fn mcp_structured_content_schema(output_schema: Option<&JsonValue>) -> Option<&JsonValue>
```

**Purpose**: Recognizes the standard shape of an MCP call-tool result and extracts its `structuredContent` schema. MCP, or Model Context Protocol, wraps tool results in a common object, and this function finds the useful typed payload inside it.

**Data flow**: It receives an optional output schema. It checks for an object with `content` as an array of objects, `isError` as a boolean, and `_meta` as an object. If that shape matches, it returns the `structuredContent` schema, or a permissive schema when that field is absent. If the shape does not match, it returns nothing.

**Call relations**: The tool sample renderer uses this to decide when to show `CallToolResult<...>` instead of rendering the whole wrapper object. The exec description builder also uses the same idea to decide whether shared MCP TypeScript helper types are needed.

*Call graph*: called by 1 (render_code_mode_sample_for_definition); 1 external calls (Bool).


##### `render_json_schema_to_typescript_inner`  (lines 487–560)

```
fn render_json_schema_to_typescript_inner(schema: &JsonValue) -> String
```

**Purpose**: Does the main work of translating JSON Schema into TypeScript-like text. It understands common schema features such as constants, enums, unions, intersections, arrays, objects, and simple primitive types.

**Data flow**: It receives one schema value. Boolean `true` becomes `unknown`, boolean `false` becomes `never`, object schemas are inspected for `const`, `enum`, `anyOf`, `oneOf`, `allOf`, `type`, object-like fields, or array-like fields. It returns the best matching TypeScript-style type, falling back to `unknown` when the schema cannot be expressed simply.

**Call relations**: This is called by the public schema renderer and recursively by array, object, and property rendering helpers. It hands specific cases to literal, array, object, and type-keyword renderers.

*Call graph*: calls 4 internal fn (render_json_schema_array, render_json_schema_literal, render_json_schema_object, render_json_schema_type_keyword); called by 4 (append_additional_properties_line, render_json_schema_array, render_json_schema_object_property, render_json_schema_to_typescript).


##### `render_json_schema_type_keyword`  (lines 562–575)

```
fn render_json_schema_type_keyword(
    map: &serde_json::Map<String, JsonValue>,
    schema_type: &str,
) -> String
```

**Purpose**: Converts a JSON Schema `type` keyword into the matching TypeScript-like type. It covers the common primitive types and delegates arrays and objects to their specialized renderers.

**Data flow**: It receives the surrounding schema map and the type name as text. It maps `string`, `number`, `integer`, `boolean`, and `null` directly, calls array or object renderers for those shapes, and returns `unknown` for unrecognized types.

**Call relations**: The inner schema renderer calls this whenever it sees a `type` field. This keeps the type keyword mapping separate from the larger schema decision tree.

*Call graph*: calls 2 internal fn (render_json_schema_array, render_json_schema_object); called by 1 (render_json_schema_to_typescript_inner).


##### `render_json_schema_array`  (lines 577–594)

```
fn render_json_schema_array(map: &serde_json::Map<String, JsonValue>) -> String
```

**Purpose**: Renders a JSON Schema array as a TypeScript-like array or tuple. A tuple is a fixed-position list, like `[string, number]`.

**Data flow**: It receives an object schema map. If there is an `items` schema, it renders that as `Array<ItemType>`. If there are `prefixItems`, it renders each one and returns a tuple-like type. If neither gives enough information, it returns `unknown[]`.

**Call relations**: This is called by the inner schema renderer and by the type-keyword renderer when a schema is known to be an array. It recursively calls the inner renderer for item types.

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

**Purpose**: Adds the TypeScript-style line that describes extra object fields not explicitly named in a schema. In TypeScript this looks like `[key: string]: Type;`.

**Data flow**: It receives the lines already being built, the full object schema, the known properties, and a prefix for indentation. If `additionalProperties` is true, it adds an unknown-value index line; if it is false, it adds nothing; if it is another schema, it renders that schema as the value type. If no properties are listed and no rule is given, it allows unknown extra keys.

**Call relations**: The object renderer calls this after rendering named properties. It uses the inner schema renderer when extra properties have their own schema.

*Call graph*: calls 1 internal fn (render_json_schema_to_typescript_inner); called by 1 (render_json_schema_object); 3 external calls (get, is_empty, format!).


##### `has_property_description`  (lines 617–622)

```
fn has_property_description(value: &JsonValue) -> bool
```

**Purpose**: Checks whether a schema property has non-empty descriptive text. This matters because properties with descriptions are rendered in a multi-line style with comments.

**Data flow**: It receives one JSON schema value. It looks for a string `description` field and checks that it is not empty. It returns true or false.

**Call relations**: The object renderer uses this as a quick scan before choosing between compact one-line output and expanded commented output.

*Call graph*: 1 external calls (get).


##### `render_json_schema_object_property`  (lines 624–633)

```
fn render_json_schema_object_property(name: &str, value: &JsonValue, required: &[&str]) -> String
```

**Purpose**: Renders one named object property as a TypeScript-like field. It also marks the field optional when the schema does not list it as required.

**Data flow**: It receives the property name, the property schema, and the list of required property names. It decides whether to add `?`, renders the property name safely, renders the property type, and returns a field line such as `city: string;` or `city?: string;`.

**Call relations**: The object renderer calls this for each property. It relies on the property-name renderer and the inner schema renderer.

*Call graph*: calls 2 internal fn (render_json_schema_property_name, render_json_schema_to_typescript_inner); 1 external calls (format!).


##### `render_json_schema_object`  (lines 635–693)

```
fn render_json_schema_object(map: &serde_json::Map<String, JsonValue>) -> String
```

**Purpose**: Renders a JSON Schema object as a TypeScript-like object type. It can produce a compact one-line object or a readable multi-line object with comments from property descriptions.

**Data flow**: It receives an object schema map. It reads the required list and properties map, sorts properties by name for stable output, and checks whether any property has descriptions. If descriptions exist, it builds a multi-line block with `//` comments. Otherwise it builds a compact type. It also adds an index line for additional properties when appropriate.

**Call relations**: This is called by the inner schema renderer and by the type-keyword renderer. It calls helpers for description detection, individual property rendering, and additional-property rendering.

*Call graph*: calls 1 internal fn (append_additional_properties_line); called by 2 (render_json_schema_to_typescript_inner, render_json_schema_type_keyword); 3 external calls (get, format!, vec!).


##### `render_json_schema_property_name`  (lines 695–701)

```
fn render_json_schema_property_name(name: &str) -> String
```

**Purpose**: Formats an object property name so it is safe in TypeScript-like output. Normal identifier names are left plain; unusual names are quoted.

**Data flow**: It receives a property name. It normalizes the name and compares it with the original. If the original is already identifier-safe, it returns it unchanged. Otherwise it JSON-quotes the name, falling back to a simple escaped quote form if needed.

**Call relations**: Object property rendering calls this before writing each field. It shares normalization rules with tool-name rendering, so generated code stays consistent.

*Call graph*: calls 1 internal fn (normalize_code_mode_identifier); called by 1 (render_json_schema_object_property); 1 external calls (to_string).


##### `render_json_schema_literal`  (lines 703–705)

```
fn render_json_schema_literal(value: &JsonValue) -> String
```

**Purpose**: Renders a JSON value as a TypeScript literal type. This is used for schema `const` values and `enum` choices.

**Data flow**: It receives a JSON value. It serializes it to JSON text, such as a quoted string or number. If serialization somehow fails, it returns `unknown`.

**Call relations**: The inner schema renderer calls this when it sees `const` or `enum`. It lets literal choices appear directly in generated type strings.

*Call graph*: called by 1 (render_json_schema_to_typescript_inner); 1 external calls (to_string).


##### `tests::mcp_call_tool_result_schema`  (lines 723–740)

```
fn mcp_call_tool_result_schema(structured_content_schema: JsonValue) -> JsonValue
```

**Purpose**: Builds a test-only MCP call-tool result schema around a chosen structured content schema. It saves the tests from repeating the same wrapper object over and over.

**Data flow**: It receives a JSON schema for `structuredContent`. It inserts that schema into a standard object with `content`, `isError`, `_meta`, and `additionalProperties: false`, then returns the JSON value.

**Call relations**: Several tests call this helper before passing tool definitions to `build_exec_tool_description`. It creates schemas that exercise the MCP-specific rendering path.

*Call graph*: 1 external calls (json!).


##### `tests::parse_exec_source_without_pragma`  (lines 743–752)

```
fn parse_exec_source_without_pragma()
```

**Purpose**: Checks that ordinary exec source without a pragma is accepted unchanged. This protects the common path where the user simply provides JavaScript.

**Data flow**: It passes `text('hi')` into the parser. It expects the returned code to be the same string and both optional settings to be absent.

**Call relations**: This test calls `parse_exec_source` directly. It verifies that the parser does not require special comments.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::parse_exec_source_with_pragma`  (lines 755–764)

```
fn parse_exec_source_with_pragma()
```

**Purpose**: Checks that a first-line exec pragma is parsed and removed from the JavaScript code. This protects the feature that lets callers set exec options inline.

**Data flow**: It sends source text whose first line contains JSON with `yield_time_ms`. It expects the parser to return only the later JavaScript line as code, with `yield_time_ms` set and `max_output_tokens` absent.

**Call relations**: This test calls `parse_exec_source` directly. It confirms the parser’s pragma path works for a valid directive.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::normalize_identifier_rewrites_invalid_characters`  (lines 767–776)

```
fn normalize_identifier_rewrites_invalid_characters()
```

**Purpose**: Checks that JavaScript-safe names are preserved and unsafe characters are replaced. This protects generated examples from containing invalid function names.

**Data flow**: It passes one already-safe name and one dashed name into the normalizer. It expects the safe name to stay the same and the dashed name to use underscores.

**Call relations**: This test calls `normalize_code_mode_identifier`, which is used by description and declaration rendering.

*Call graph*: 1 external calls (assert_eq!).


##### `tests::augment_tool_definition_appends_typed_declaration`  (lines 779–805)

```
fn augment_tool_definition_appends_typed_declaration()
```

**Purpose**: Checks that augmenting a tool definition adds a usable TypeScript-style declaration. This ensures users can see the expected argument and result shape.

**Data flow**: It builds a function tool with an input schema requiring a `city` string and an output schema requiring an `ok` boolean. It augments the definition and checks that the description now contains `declare const tools` and the expected function signature.

**Call relations**: This test calls `augment_tool_definition`, which in turn relies on the sample and schema renderers.

*Call graph*: calls 2 internal fn (augment_tool_definition, plain); 2 external calls (assert!, json!).


##### `tests::augment_tool_definition_includes_property_descriptions_as_comments`  (lines 808–853)

```
fn augment_tool_definition_includes_property_descriptions_as_comments()
```

**Purpose**: Checks that schema descriptions become comments in generated TypeScript-style declarations. This makes complex tool arguments easier to understand.

**Data flow**: It builds a weather tool whose input and output properties include descriptions. After augmentation, it checks that those descriptions appear as `//` comments next to the rendered fields.

**Call relations**: This test exercises `augment_tool_definition` and, through it, the object schema rendering path that switches to multi-line commented output.

*Call graph*: calls 2 internal fn (augment_tool_definition, plain); 2 external calls (assert!, json!).


##### `tests::code_mode_only_description_includes_nested_tools`  (lines 856–875)

```
fn code_mode_only_description_includes_nested_tools()
```

**Purpose**: Checks that the exec description lists nested tools when code-mode-only descriptions are requested. This ensures available nested tools are actually visible to code-mode users.

**Data flow**: It builds a single simple tool and asks for a code-mode-only exec description. It checks that the nested tool heading and description appear, and that unrelated warning text is absent.

**Call relations**: This test calls `build_exec_tool_description`. It verifies the branch that appends nested tool reference sections.

*Call graph*: calls 2 internal fn (build_exec_tool_description, plain); 2 external calls (new, assert!).


##### `tests::exec_description_mentions_timeout_helpers`  (lines 878–887)

```
fn exec_description_mentions_timeout_helpers()
```

**Purpose**: Checks that the regular exec description mentions JavaScript timeout helper functions. This helps users know that timeout-style helpers are available.

**Data flow**: It builds an exec description with no nested tools and not in code-mode-only mode. It then checks that `setTimeout` and `clearTimeout` are mentioned.

**Call relations**: This test calls `build_exec_tool_description` and verifies text from the base exec description template.

*Call graph*: calls 1 internal fn (build_exec_tool_description); 2 external calls (new, assert!).


##### `tests::code_mode_only_description_groups_namespace_instructions_once`  (lines 890–945)

```
fn code_mode_only_description_groups_namespace_instructions_once()
```

**Purpose**: Checks that tools in the same namespace share one namespace guidance section. This prevents repeated instructions from cluttering the generated description.

**Data flow**: It creates two namespaced tools and one namespace description. It builds a code-mode-only exec description, then checks that the namespace heading appears exactly once, that its guidance text appears, and that both tools have MCP-wrapped typed declarations.

**Call relations**: This test calls `build_exec_tool_description` and uses the MCP schema helper. It exercises namespace grouping, nested tool rendering, and MCP result type rendering together.

*Call graph*: calls 2 internal fn (build_exec_tool_description, namespaced); 5 external calls (from, assert!, assert_eq!, mcp_call_tool_result_schema, json!).


##### `tests::code_mode_only_description_omits_empty_namespace_sections`  (lines 948–980)

```
fn code_mode_only_description_omits_empty_namespace_sections()
```

**Purpose**: Checks that an empty namespace description does not produce a blank namespace heading. This keeps generated documentation clean.

**Data flow**: It creates a namespaced tool and a namespace entry with an empty description. It builds the exec description and verifies that the namespace heading is missing while the tool heading is still present.

**Call relations**: This test calls `build_exec_tool_description` and uses the MCP schema helper. It focuses on the namespace-heading branch of the builder.

*Call graph*: calls 2 internal fn (build_exec_tool_description, namespaced); 5 external calls (from, new, assert!, mcp_call_tool_result_schema, json!).


##### `tests::code_mode_only_description_renders_shared_mcp_types_once`  (lines 983–1084)

```
fn code_mode_only_description_renders_shared_mcp_types_once()
```

**Purpose**: Checks that shared MCP TypeScript helper types are included only once, even when multiple tools need them. This avoids duplicate type blocks in the exec description.

**Data flow**: It builds two MCP-style tools, augments them, then asks for a code-mode-only exec description. It counts the shared `CallToolResult` type text and the `Shared MCP Types:` heading, expecting each to appear once.

**Call relations**: This test calls both `augment_tool_definition` and `build_exec_tool_description`. It protects the coordination between MCP result detection and shared preamble insertion.

*Call graph*: calls 3 internal fn (augment_tool_definition, build_exec_tool_description, namespaced); 3 external calls (new, assert_eq!, json!).


##### `tests::exec_description_mentions_deferred_nested_tools_when_available`  (lines 1087–1098)

```
fn exec_description_mentions_deferred_nested_tools_when_available()
```

**Purpose**: Checks that the exec description warns about deferred nested tools when that feature is available. Deferred tools may not all be shown immediately, so the guidance tells readers how to discover or filter them.

**Data flow**: It builds an exec description with deferred tools marked as available. It checks that the expected guidance about omitted deferred tools and filtering `ALL_TOOLS` appears, and that a specific warning about printing the full array does not appear.

**Call relations**: This test calls `build_exec_tool_description`. It verifies the optional deferred-tool guidance branch.

*Call graph*: calls 1 internal fn (build_exec_tool_description); 2 external calls (new, assert!).


### Runtime payload schemas
These data models define what code-mode tools send and receive at execution time, from content payloads to runtime request and response envelopes.

### `code-mode-protocol/src/response.rs`

`data_model` · `cross-cutting protocol serialization`

This file is part of the protocol layer: the agreed-upon language that different parts of the system use to talk to each other. Its main job is to define what a function-call output item can look like. An item can be plain text, or it can be an image URL with an optional image detail setting.

The `ImageDetail` enum gives names to the allowed image quality/detail choices: automatic, low, high, or original. The default used by this protocol is `High`, which means that if the system needs a normal choice, it prefers a detailed image rather than a low-quality one.

The `FunctionCallOutputContentItem` enum is the main content wrapper. It is tagged by a `type` field when converted to JSON, so a receiver can tell whether it is looking at text or an image. This is like putting a clear label on each package before shipping it: one label says “input_text” and another says “input_image.”

The file uses Serde, a Rust library for serialization, meaning it can automatically convert these Rust values to formats like JSON and back again. That matters because protocol data usually crosses boundaries between programs, processes, or machines. Without these shared definitions, different parts of the system could disagree about the names, fields, or allowed values for response content.


### `code-mode-protocol/src/runtime.rs`

`data_model` · `request handling`

This file is mostly a set of plain data shapes for the code execution part of the protocol. Think of it like a stack of standardized forms: one form says “please run this code,” another says “please wait for this running cell,” and others describe what came back.

The runtime can reply in a few important ways. It can say the code yielded, meaning it produced some output but is still alive. It can say the code terminated, meaning execution stopped. Or it can return a final result, possibly with an error message. These replies include a cell ID, which is the label used to keep track of one running piece of code, and content items, which are the visible outputs produced by execution.

The file also covers “pending” situations. Some code can trigger nested tool calls, so execution may pause while those tools finish. The outcome types describe whether a cell is still live, missing, completed, or waiting on pending work.

All these types can be serialized and deserialized, meaning they can be turned into data for transport, such as JSON, and then rebuilt on the other side. Without this file, the runtime and its caller would not have a reliable shared contract for what requests and responses mean.

#### Function details

##### `RuntimeResponse::from`  (lines 58–62)

```
fn from(outcome: WaitOutcome) -> Self
```

**Purpose**: This converts a wait outcome into the runtime response inside it. It is useful when later code does not care whether the response came from a live cell or a missing cell and only needs the actual runtime message.

**Data flow**: It receives a WaitOutcome, which is either a LiveCell response or a MissingCell response. It opens that wrapper, takes out the RuntimeResponse stored inside, and returns that response unchanged. It does not create new output or change any shared state.

**Call relations**: This is the standard Rust conversion path for turning WaitOutcome into RuntimeResponse, so other code can use the usual conversion style when it wants to flatten the wrapper. It does not hand work off to other functions; it simply unwraps the two possible cases in the same way.


### Session contracts
These abstractions define the longer-lived session boundary between callers and code-mode runtimes, including identifiers, wrappers, and provider/session traits.

### `code-mode-protocol/src/session.rs`

`data_model` · `cross-cutting during code-mode session creation and cell execution`

This file is like the rulebook for a shared workspace where code cells are run. A “session” is the workspace: code cells in the same session can share stored values, while different sessions must stay separate. Without this file, the parts of the system that ask for code to run and the parts that actually run it would not have a common language.

The file first defines a few reusable future types. A future is a value that represents work that will finish later, such as waiting for code execution. These aliases make every session implementation return results in the same shape: either the requested value or a plain error message.

It then defines `CellId`, a small wrapper around a string. This gives each running code cell a clear identity instead of passing raw strings everywhere.

`StartedCell` represents a cell that has been accepted for execution. It contains the cell’s id and a delayed first response from the runtime. This first response may arrive later, so it is stored as asynchronous work.

Finally, the file defines three traits, which are shared interfaces. `CodeModeSessionDelegate` describes callbacks from the runtime back to the host, such as invoking a nested tool or sending a notification. `CodeModeSession` describes what any session must be able to do: execute, wait, terminate, and shut down. `CodeModeSessionProvider` describes something that can create new sessions.

#### Function details

##### `CellId::new`  (lines 30–32)

```
fn new(value: String) -> Self
```

**Purpose**: Creates a `CellId` from a plain string. This is used when the system has received or generated a cell identifier and wants to treat it as a typed cell id instead of an ordinary piece of text.

**Data flow**: A string goes in. The function wraps that string inside a `CellId` without changing its contents. A new `CellId` comes out, ready to be passed around wherever a cell identity is needed.

**Call relations**: This is the entry point for turning raw cell-id text into the stronger `CellId` type. It is used by code that allocates ids, builds ids in tests, and handles incoming calls that refer to a cell.

*Call graph*: called by 5 (started_cell_preserves_remote_initial_response_errors, allocate_cell_id, cell_id, cell_id, handle_call).


##### `CellId::as_str`  (lines 34–36)

```
fn as_str(&self) -> &str
```

**Purpose**: Gives read-only access to the text inside a `CellId`. This is useful when something needs the actual id string, for example to compare it, log it, or send it over a protocol.

**Data flow**: A `CellId` is already present. The function borrows the inner string as `&str`, which means callers can read it without taking ownership or making a copy. The `CellId` itself is unchanged.

**Call relations**: This is the common doorway from the typed `CellId` back to plain text. The `AsRef` implementation and display formatting both use it so there is only one simple way to expose the inner string.

*Call graph*: called by 2 (as_ref, fmt).


##### `CellId::as_ref`  (lines 40–42)

```
fn as_ref(&self) -> &str
```

**Purpose**: Lets a `CellId` be used in places that expect something that can be viewed as a string. This is a Rust convenience hook that avoids callers needing to manually unwrap the id text.

**Data flow**: A borrowed `CellId` goes in. The function asks `CellId::as_str` for the inner text and returns that borrowed string slice. Nothing is copied or changed.

**Call relations**: This function is called automatically by Rust code that works with the `AsRef<str>` pattern. Internally it delegates to `CellId::as_str`, keeping all string access consistent.

*Call graph*: calls 1 internal fn (as_str).


##### `CellId::fmt`  (lines 46–48)

```
fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Controls how a `CellId` is printed as normal text. This lets logs, error messages, and formatted strings show the actual cell id rather than a debug-looking wrapper.

**Data flow**: A `CellId` and a formatter go in. The function gets the inner string through `CellId::as_str` and writes that text into the formatter. The output is the formatter’s success or failure result.

**Call relations**: This is used whenever code formats a `CellId` with normal display formatting. It relies on `CellId::as_str` for the actual text and hands that text to Rust’s formatter-writing machinery.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (write_str).


##### `StartedCell::new`  (lines 57–66)

```
fn new(cell_id: CellId, initial_response_rx: oneshot::Receiver<RuntimeResponse>) -> Self
```

**Purpose**: Builds a `StartedCell` when the first runtime response will arrive through a one-time message channel. This is for the simple case where that channel sends a successful `RuntimeResponse` value directly.

**Data flow**: A `CellId` and a one-shot receiver go in. The receiver is wrapped in an asynchronous future, like putting a note in a mailbox and promising to check it later. If the sender disappears before sending, the future turns that into the error message `exec runtime ended unexpectedly`. The result is a `StartedCell` holding the id and the delayed first response.

**Call relations**: Session implementations can use this when they have just started a cell and need to return immediately while the runtime prepares the first response. It packages the receiver so later code can call `StartedCell::initial_response` to wait for that first response.

*Call graph*: 1 external calls (pin).


##### `StartedCell::from_result_receiver`  (lines 68–80)

```
fn from_result_receiver(
        cell_id: CellId,
        initial_response_rx: oneshot::Receiver<Result<RuntimeResponse, String>>,
    ) -> Self
```

**Purpose**: Builds a `StartedCell` when the first runtime response channel may contain either a response or an error message. This preserves errors reported by a remote or background runtime instead of replacing them with a generic failure.

**Data flow**: A `CellId` and a one-shot receiver of `Result<RuntimeResponse, String>` go in. The function wraps the receiver in a future. If the channel closes early, it produces `exec runtime ended unexpectedly`; if the channel delivers an error, that original error is kept; if it delivers a response, that response comes out. The result is a `StartedCell` with delayed first-response work attached.

**Call relations**: This is used by execution paths that need to pass through richer startup failures from the runtime. After it creates the `StartedCell`, callers can return it to higher-level code, which later awaits `StartedCell::initial_response`.

*Call graph*: called by 2 (started_cell_preserves_remote_initial_response_errors, execute); 1 external calls (pin).


##### `StartedCell::initial_response`  (lines 82–84)

```
async fn initial_response(self) -> Result<RuntimeResponse, String>
```

**Purpose**: Waits for and returns the first response from a started cell. This is the point where the caller finally learns whether the runtime produced an initial response or failed before doing so.

**Data flow**: A `StartedCell` goes in and is consumed, meaning this first response can only be awaited once. The stored future is awaited until it finishes. The function returns either the `RuntimeResponse` or an error string, and the `StartedCell` is no longer available afterward.

**Call relations**: This is called after some session implementation has returned a `StartedCell` from an execute request. It completes the story started by `StartedCell::new` or `StartedCell::from_result_receiver` by actually waiting on the delayed runtime reply.
