# Context fragment definitions and prompt assets  `stage-12.2`

This stage provides the raw building blocks that the system later assembles into the text a model actually sees. It is shared behind-the-scenes support rather than the main work loop. Think of it as the bin of labeled parts and prewritten note cards used to build a prompt.

Some files embed fixed prompt assets directly into the program: instructions for agent coordination, using apply_patch, compact summaries, and realtime mode startup and shutdown. Other files define “context fragments,” which are small, structured pieces of text with stable markers so the system can insert facts consistently.

These fragments cover many kinds of information: extra key/value context, skill instructions and skill listings, internal hidden notes, environment details like time, permissions, and available subagents, token budget notices, saved command or network rules, AGENTS.md user instructions, shell command results, subagent status updates, interruption notices, and model-switch guidance. Realtime start and end fragments provide matching wrappers for live sessions. A few files only recognize older warning formats so saved conversations from past versions still make sense. Together, these parts give prompt assembly a reliable vocabulary and set of ready-made instructions.

## Files in this stage

### Prompt asset constants
These embedded prompt templates provide the raw static instruction text later wrapped into contextual fragments.

### `prompts/src/agents.rs`

`config` · `compile time embedding; runtime prompt selection`

This file is a single-purpose prompt asset wrapper. It defines `HIERARCHICAL_AGENTS_MESSAGE` as a `&str` populated with `include_str!("../templates/agents/hierarchical.md")`, which causes the Markdown template to be read at compile time and baked into the compiled artifact as a static string slice. There is no parsing, formatting, or runtime I/O here; the invariant is that the referenced template file must exist at build time, and consumers always receive the exact template contents verbatim. Keeping this prompt in its own module isolates the source template path and gives the crate root a clean item to re-export. That design also makes prompt changes data-only: editing the Markdown updates behavior without changing Rust control flow. The file's role is therefore to bridge repository-stored prompt text into typed program constants.


### `prompts/src/apply_patch.rs`

`config` · `compile time embedding; runtime prompt composition`

This module contains one public constant, `APPLY_PATCH_TOOL_INSTRUCTIONS`, whose value is loaded from `../templates/apply_patch_tool_instructions.md` via `include_str!`. The surrounding doc comment clarifies the intended consumer: detailed instructions for `gpt-4.1` on correct `apply_patch` usage. Because `include_str!` runs at compile time, the file performs no runtime file access and guarantees callers receive an immutable `&'static str`. The module is intentionally minimal: it does not interpret the template, split it into sections, or inject variables. Its responsibility is simply to make a specific prompt artifact available under a semantically named symbol. This separation keeps prompt content versioned as Markdown while preserving a strongly named API in Rust, and it ensures any code constructing tool-use prompts can depend on a single canonical instruction source.


### `prompts/src/compact.rs`

`config` · `compile time embedding; runtime summarization prompt assembly`

This file defines two public constants backed by Markdown templates included at compile time. `SUMMARIZATION_PROMPT` loads `../templates/compact/prompt.md`, and `SUMMARY_PREFIX` loads `../templates/compact/summary_prefix.md`. The split between a full prompt and a prefix suggests downstream code composes summarization requests in stages: one constant supplies the main instruction body, while the other supplies a reusable leading marker or framing string for generated summaries. There is no executable logic, validation, or formatting in this module; its behavior is entirely determined by the template files and Rust's `include_str!` macro. The important design choice is that prompt text lives outside Rust source but is surfaced through stable, typed names, making it easy to update wording without touching call sites. Consumers can rely on both constants being immutable, UTF-8 string slices available for the lifetime of the program.


### `prompts/src/realtime.rs`

`config` · `compile time embedding; runtime realtime session setup/teardown`

This module packages three realtime-specific prompt templates as public `&str` constants. `BACKEND_PROMPT` includes `../templates/realtime/backend_prompt.md`, `START_INSTRUCTIONS` includes `../templates/realtime/realtime_start.md`, and `END_INSTRUCTIONS` includes `../templates/realtime/realtime_end.md`. The separation reflects a lifecycle-aware prompt design: one template describes the backend's standing behavior, another is intended for session startup, and the last for session shutdown or completion. As with the other prompt modules, all content is embedded at compile time using `include_str!`, so there is no runtime disk access and no transformation of the template text. The file's value is in naming and organization: it gives callers explicit symbols for each phase of a realtime exchange, reducing the chance of mixing generic prompt text with lifecycle-specific instructions. The module therefore serves as a static prompt asset bundle for realtime flows.


### Fragment foundations and adapters
These files define the shared low-level fragment shapes and adapt external skill or internal context data into the common contextual-fragment interface.

### `context-fragments/src/additional_context.rs`

`domain_logic` · `context assembly before model request construction`

This file implements two `ContextualUserFragment` variants that carry arbitrary external context under a caller-provided key. `AdditionalContextUserFragment` renders marked user-role content using an XML-like wrapper whose opening marker prefix is fixed as `<external_` and whose closing suffix marker is `>`. Its `body()` fills in the rest of the structure as `key>value</external_key>`, so the trait-level `render()` produces a full fragment like `<external_key>... </external_key>`. Because user fragments are marked, `matches_text` is overridden with stricter parsing logic: it trims the candidate text, requires the `<external_` prefix, splits once on `>`, and then checks that the remainder ends with the exact closing tag for the extracted key.

`AdditionalContextDeveloperFragment` carries the same key/value payload but emits unmarked developer-role content. Its trait markers are both empty strings, so matching is disabled by default and rendering returns only the body. That body is a simpler `<key>value</key>` wrapper.

Both fragment bodies enforce the same token budget: `truncate_middle_with_token_budget` is applied to the value with `MAX_ADDITIONAL_CONTEXT_VALUE_TOKENS` set to 1,000, preserving the beginning and end while shortening oversized payloads. The key itself is not sanitized here, so callers are responsible for supplying tag-safe keys.

#### Function details

##### `AdditionalContextUserFragment::new`  (lines 16–18)

```
fn new(key: String, value: String) -> Self
```

**Purpose**: Constructs a user-role additional-context fragment from a key and value.

**Data flow**: Takes owned `key: String` and `value: String`, stores them directly in `AdditionalContextUserFragment`, and returns the new struct.

**Call relations**: Callers create this concrete fragment before passing it through the `ContextualUserFragment` trait’s rendering or conversion helpers.


##### `AdditionalContextUserFragment::role`  (lines 22–24)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that this fragment should be emitted as a user message.

**Data flow**: Reads no state and returns the static string `"user"`.

**Call relations**: Trait conversion helpers use this role when turning the fragment into protocol message items.


##### `AdditionalContextUserFragment::markers`  (lines 26–28)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the start and end markers used by generic fragment rendering for user additional-context fragments.

**Data flow**: Reads no instance fields and returns the tuple from `Self::type_markers()`.

**Call relations**: The trait’s `render()` method calls this to prepend `<external_` and append `>` around the body.

*Call graph*: 1 external calls (type_markers).


##### `AdditionalContextUserFragment::type_markers`  (lines 30–35)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the static marker pair that identifies user additional-context fragments.

**Data flow**: Returns the tuple `(ADDITIONAL_CONTEXT_START_MARKER_PREFIX, ADDITIONAL_CONTEXT_END_MARKER_SUFFIX)`, i.e. `("<external_", ">")`.

**Call relations**: It supports both instance-level `markers()` and any type-erased registration or matching logic that asks the type for its markers.


##### `AdditionalContextUserFragment::matches_text`  (lines 37–48)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Recognizes whether arbitrary text is a rendered user additional-context fragment with a matching closing tag.

**Data flow**: Accepts `text: &str`, trims it, strips the `<external_` prefix, splits once on `>`, interprets the left side as the key, formats the expected closing tag `</external_{key}>`, and returns true only if the remaining text ends with that exact suffix.

**Call relations**: This overrides the trait’s generic marker-based matcher because the opening marker contains a dynamic key and the closing tag must agree with that key.

*Call graph*: 1 external calls (format!).


##### `AdditionalContextUserFragment::body`  (lines 50–52)

```
fn body(&self) -> String
```

**Purpose**: Builds the inner body portion of the user additional-context fragment.

**Data flow**: Reads `self.key` and `self.value`, passes them to `additional_context_body`, and returns the resulting `String`.

**Call relations**: The trait’s `render()` method wraps this body with the markers returned by `markers()`.

*Call graph*: calls 1 internal fn (additional_context_body).


##### `AdditionalContextDeveloperFragment::new`  (lines 62–64)

```
fn new(key: String, value: String) -> Self
```

**Purpose**: Constructs a developer-role additional-context fragment from a key and value.

**Data flow**: Takes owned `key: String` and `value: String`, stores them in `AdditionalContextDeveloperFragment`, and returns the struct.

**Call relations**: Callers instantiate this when they want the same payload represented as developer-role context instead of user-role marked context.


##### `AdditionalContextDeveloperFragment::role`  (lines 68–70)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that this fragment should be emitted as a developer message.

**Data flow**: Reads no state and returns the static string `"developer"`.

**Call relations**: Trait conversion helpers use this role when serializing the fragment into protocol message items.


##### `AdditionalContextDeveloperFragment::markers`  (lines 72–74)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the marker pair for developer additional-context fragments.

**Data flow**: Reads no instance fields and returns `Self::type_markers()`.

**Call relations**: Because the type markers are empty, the trait’s `render()` path will emit only the body.

*Call graph*: 1 external calls (type_markers).


##### `AdditionalContextDeveloperFragment::type_markers`  (lines 76–78)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines developer additional-context fragments as unmarked content.

**Data flow**: Returns the tuple `("", "")`.

**Call relations**: This disables generic marker matching and causes `render()` to skip wrapper markers entirely.


##### `AdditionalContextDeveloperFragment::body`  (lines 80–82)

```
fn body(&self) -> String
```

**Purpose**: Builds the XML-like body for developer additional-context fragments.

**Data flow**: Reads `self.key` and `self.value`, passes them to `additional_context_developer_body`, and returns the resulting string.

**Call relations**: It supplies the full rendered content because developer fragments have no outer markers.

*Call graph*: calls 1 internal fn (additional_context_developer_body).


##### `additional_context_body`  (lines 85–88)

```
fn additional_context_body(key: &str, value: &str) -> String
```

**Purpose**: Formats the body of a user additional-context fragment and truncates oversized values to the configured token budget.

**Data flow**: Accepts `key: &str` and `value: &str`, truncates `value` with `truncate_middle_with_token_budget(..., 1000)` and takes the first tuple element, then formats `{key}>{value}</external_{key}` and returns it.

**Call relations**: It is called only by `AdditionalContextUserFragment::body` to keep user-fragment formatting and truncation logic centralized.

*Call graph*: called by 1 (body); 2 external calls (truncate_middle_with_token_budget, format!).


##### `additional_context_developer_body`  (lines 90–93)

```
fn additional_context_developer_body(key: &str, value: &str) -> String
```

**Purpose**: Formats the body of a developer additional-context fragment with the same truncation policy but different tag syntax.

**Data flow**: Accepts `key` and `value`, truncates the value with `truncate_middle_with_token_budget(..., 1000)`, formats `<{key}>{value}</{key}>`, and returns the resulting string.

**Call relations**: It is called only by `AdditionalContextDeveloperFragment::body`.

*Call graph*: called by 1 (body); 2 external calls (truncate_middle_with_token_budget, format!).


### `core-skills/src/skill_instructions.rs`

`io_transport` · `context assembly for injected skills`

This file defines a small value type, `SkillInstructions`, containing the three fields needed to serialize an injected skill into prompt context: `name`, `path`, and full `contents`. The struct itself is private-field and immutable after construction, emphasizing that it is a formatting payload rather than a mutable domain object.

The `From<&SkillInjection>` implementation performs a straightforward clone-based conversion from the injection layer into this prompt-fragment representation. The more important behavior comes from the `ContextualUserFragment` implementation. `role()` always returns `"user"`, so these fragments are inserted as user-context material. `markers()` delegates to `type_markers()`, which fixes the outer wrapper tags to `("<skill>", "</skill>")`. `body()` then renders the inner payload as a newline-prefixed block containing `<name>...</name>`, `<path>...</path>`, and the raw skill contents on following lines.

The design keeps the outer fragment markers and inner body structure separate: callers using the trait can ask for markers generically, while the body remains specific to skill instructions. There is no parsing or validation here; the file's sole job is deterministic serialization of already-prepared skill injections into the context-fragment protocol.

#### Function details

##### `SkillInstructions::from`  (lines 13–19)

```
fn from(skill: &SkillInjection) -> Self
```

**Purpose**: Converts a borrowed `SkillInjection` into an owned `SkillInstructions` payload by cloning its identifying fields and contents.

**Data flow**: It takes `&SkillInjection`, reads `name`, `path`, and `contents`, clones each into a new `SkillInstructions` struct, and returns it. No external state is modified.

**Call relations**: This conversion is the entry point from the injection subsystem into this file's prompt-fragment representation.


##### `SkillInstructions::role`  (lines 23–25)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that serialized skill instructions should be treated as a user-role context fragment.

**Data flow**: It ignores instance data and returns the static string `"user"`.

**Call relations**: Consumers of the `ContextualUserFragment` trait call this when assembling mixed-role context fragments.


##### `SkillInstructions::markers`  (lines 27–29)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the outer start and end markers used to wrap a skill fragment.

**Data flow**: It calls `Self::type_markers()` and returns the resulting pair of static strings.

**Call relations**: This method satisfies the trait's instance-level marker API while delegating the actual marker definition to the associated function.

*Call graph*: 1 external calls (type_markers).


##### `SkillInstructions::type_markers`  (lines 31–33)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the canonical outer markers for skill fragments as `<skill>` and `</skill>`.

**Data flow**: It returns the fixed tuple `("<skill>", "</skill>")` and reads no state.

**Call relations**: Both instance-level marker access and any type-level callers rely on this single definition to keep wrapper tags consistent.


##### `SkillInstructions::body`  (lines 35–40)

```
fn body(&self) -> String
```

**Purpose**: Formats the inner body of a skill fragment, embedding the skill name, path, and raw contents in a predictable XML-like layout.

**Data flow**: It reads `self.name`, `self.path`, and `self.contents`, interpolates them into a formatted string with leading/trailing newlines and `<name>`/`<path>` tags, and returns the resulting `String`.

**Call relations**: This is the serialization step used when the context-fragment system materializes the fragment for prompt inclusion.

*Call graph*: 1 external calls (format!).


### `core/src/context/internal_model_context.rs`

`domain_logic` · `context assembly and history parsing`

This file implements a concrete `ContextualUserFragment` used for runtime-owned, extension-supplied context that should appear to the model as a user fragment while remaining structurally identifiable in stored conversation history. The wrapper format is an XML-like tag pair using `<codex_internal_context ...>` and `</codex_internal_context>`, with a required `source="..."` attribute. To keep that wrapper safe to embed without escaping, `InternalContextSource` restricts source labels to the regex-like shape `[a-z][a-z0-9_]*`; invalid values are rejected up front via `InvalidInternalContextSource`.

`InternalModelContextFragment` stores two pieces of state: the validated `InternalContextSource` and an arbitrary body string. Its `ContextualUserFragment` implementation fixes the role to `"user"`, exposes the start/end markers, renders the body as the attribute plus newline-delimited payload, and recognizes serialized fragments by parsing the trimmed text. Detection is intentionally tolerant of legacy data: `matches_text` first accepts the older `<goal_context>...</goal_context>` envelope before attempting to parse the newer source-bearing form. The parser is simple and structural rather than fully XML-aware: it checks exact prefixes, splits once on the attribute terminator, validates the extracted source, and requires the closing marker at the end. That design keeps matching auditable and deterministic while preserving backward compatibility for old sessions and tests.

#### Function details

##### `InternalContextSource::new`  (lines 23–30)

```
fn new(source: impl Into<String>) -> Result<Self, InvalidInternalContextSource>
```

**Purpose**: Constructs a validated `InternalContextSource` from any string-like input. It enforces the restricted source-label syntax before allowing the value to be embedded into the fragment wrapper.

**Data flow**: Takes `source: impl Into<String>`, converts it into an owned `String`, then reads that string through `is_valid_source`. If validation passes it returns `Ok(InternalContextSource(source))`; otherwise it returns `Err(InvalidInternalContextSource { source })` carrying the rejected text.

**Call relations**: This is the main checked constructor used whenever a source label originates from runtime data. `InternalContextSource::from_static` delegates to it so both trusted and untrusted creation paths share the same validation logic.

*Call graph*: calls 1 internal fn (is_valid_source); 1 external calls (into).


##### `InternalContextSource::from_static`  (lines 33–36)

```
fn from_static(source: &'static str) -> Self
```

**Purpose**: Builds an `InternalContextSource` from a compile-time string and treats invalid input as a programmer error. It is the convenience path for hard-coded source labels used in tests and fixed call sites.

**Data flow**: Accepts `source: &'static str`, forwards it to `InternalContextSource::new`, and unwraps the `Result`. On success it returns the validated wrapper; on failure it panics with a message that includes the offending static string.

**Call relations**: It is invoked by callers that embed known source labels, including tests and fragment-building helpers. Rather than duplicating checks, it funnels through `new` and only changes failure handling from recoverable error to panic.

*Call graph*: called by 3 (contextual_user_fragment_is_dyn_compatible, detects_internal_model_context_fragment, goal_context_input_item); 1 external calls (new).


##### `InternalContextSource::as_str`  (lines 38–40)

```
fn as_str(&self) -> &str
```

**Purpose**: Exposes the underlying validated source label as a borrowed string slice. It avoids cloning when the source is only needed for formatting.

**Data flow**: Reads `self.0` and returns `&str` pointing at the stored `String` contents. It does not mutate state or allocate.

**Call relations**: This accessor is used by `InternalModelContextFragment::body` when serializing the fragment wrapper.

*Call graph*: called by 1 (body).


##### `InvalidInternalContextSource::fmt`  (lines 50–56)

```
fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result
```

**Purpose**: Formats the validation error with the rejected source value and the exact accepted pattern. The message is intended to make malformed labels easy to diagnose.

**Data flow**: Reads `self.source`, interpolates it into a fixed explanatory string, and writes the result into the provided `fmt::Formatter`. It returns the standard `fmt::Result` from `write!`.

**Call relations**: This method supplies the human-readable `Display` implementation for `InvalidInternalContextSource`, which is produced by `InternalContextSource::new` on validation failure.

*Call graph*: 1 external calls (write!).


##### `InternalModelContextFragment::new`  (lines 70–75)

```
fn new(source: InternalContextSource, body: impl Into<String>) -> Self
```

**Purpose**: Creates a hidden internal-context fragment from a previously validated source label and arbitrary body text. It is the concrete value later serialized through the trait implementation.

**Data flow**: Consumes `source: InternalContextSource` and `body: impl Into<String>`, converts the body into an owned `String`, and returns `InternalModelContextFragment { source, body }`.

**Call relations**: It is called by higher-level context-building code and tests that need to inject internal steering content. The constructor itself is intentionally thin because source validation has already happened in `InternalContextSource`.

*Call graph*: called by 3 (contextual_user_fragment_is_dyn_compatible, detects_internal_model_context_fragment, goal_context_input_item); 1 external calls (into).


##### `InternalModelContextFragment::role`  (lines 79–81)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that this fragment should be emitted with the `user` role. That makes hidden internal context travel through the same channel as user-context fragments.

**Data flow**: Ignores instance state and returns the static string `"user"`.

**Call relations**: This method is part of the `ContextualUserFragment` contract and is consumed by generic fragment serialization/orchestration code when assembling messages.


##### `InternalModelContextFragment::markers`  (lines 83–85)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the start and end markers used to wrap this fragment type. It centralizes marker lookup through the associated marker definition.

**Data flow**: Reads no instance fields and returns the tuple from `Self::type_markers()`.

**Call relations**: Generic fragment code calls this instance method when serializing a concrete fragment; it delegates directly to `type_markers` so the instance and type-level marker definitions stay identical.

*Call graph*: 1 external calls (type_markers).


##### `InternalModelContextFragment::type_markers`  (lines 87–89)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the canonical wrapper markers for internal model context. These constants identify the modern serialized form in history.

**Data flow**: Returns the static tuple `(CONTEXT_START_MARKER, CONTEXT_END_MARKER)` with no allocation or state access.

**Call relations**: It is used by `markers` and by any type-level logic that needs the fragment delimiters without an instance.


##### `InternalModelContextFragment::matches_text`  (lines 91–108)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Recognizes whether a text blob is either a legacy goal-context fragment or a valid modern internal-context fragment with a syntactically valid source attribute. It is the parser-like gate used when scanning stored messages.

**Data flow**: Takes `text: &str`, trims surrounding whitespace, then first checks `matches_legacy_goal_context(trimmed)`. If that fails, it strips the modern start marker, strips the exact ` source="` attribute prefix, splits once on the terminating `">`, validates the extracted source with `is_valid_source`, and finally checks that the remaining tail ends with the modern closing marker. It returns `true` only if all structural checks succeed.

**Call relations**: This method is called by generic fragment-detection code when deciding whether a message belongs to this fragment type. It delegates legacy recognition to `matches_legacy_goal_context` and source syntax enforcement to `is_valid_source`.

*Call graph*: calls 2 internal fn (is_valid_source, matches_legacy_goal_context).


##### `InternalModelContextFragment::body`  (lines 110–114)

```
fn body(&self) -> String
```

**Purpose**: Serializes the fragment payload portion that sits between the outer markers. It includes the source attribute and preserves the body on its own line block.

**Data flow**: Reads `self.source` via `as_str()` and `self.body` by reference, then formats a string of the form ` source="{source}">\n{body}\n`. It returns that newly allocated `String` without mutating the fragment.

**Call relations**: Generic fragment serialization calls this after obtaining the markers and role. It depends on `InternalContextSource::as_str` to avoid exposing the source internals directly.

*Call graph*: calls 1 internal fn (as_str); 1 external calls (format!).


##### `matches_legacy_goal_context`  (lines 117–120)

```
fn matches_legacy_goal_context(text: &str) -> bool
```

**Purpose**: Checks for the older `<goal_context>...</goal_context>` wrapper used before the current internal-context format. It exists solely for backward-compatible detection.

**Data flow**: Accepts `text: &str` and returns `true` if the string starts with `LEGACY_GOAL_CONTEXT_START_MARKER` and ends with `LEGACY_GOAL_CONTEXT_END_MARKER`; otherwise returns `false`.

**Call relations**: It is only used by `InternalModelContextFragment::matches_text`, which consults it before attempting to parse the newer source-bearing format.

*Call graph*: called by 1 (matches_text).


##### `is_valid_source`  (lines 122–129)

```
fn is_valid_source(source: &str) -> bool
```

**Purpose**: Implements the exact source-label validation rule for internal context sources. The rule requires a lowercase ASCII letter first, followed by zero or more lowercase ASCII letters, digits, or underscores.

**Data flow**: Takes `source: &str`, iterates over its characters, rejects the empty string, checks the first character with `is_ascii_lowercase`, then ensures every remaining character is lowercase ASCII, an ASCII digit, or `_`. It returns a boolean and does not allocate.

**Call relations**: This helper is shared by `InternalContextSource::new` for constructor-time validation and by `InternalModelContextFragment::matches_text` when validating parsed serialized text.

*Call graph*: called by 2 (new, matches_text).


### `ext/skills/src/fragments.rs`

`data_model` · `prompt assembly`

This file contains two small prompt-fragment implementations used by the skills extension. `AvailableSkillsInstructions` stores pre-rendered skill listing lines and implements `ContextualUserFragment` as a developer-role fragment bracketed by the protocol's `SKILLS_INSTRUCTIONS_OPEN_TAG` and `SKILLS_INSTRUCTIONS_CLOSE_TAG`. Its body delegates to `codex_core_skills::render_available_skills_body`, passing an empty first section and the stored skill lines as the visible list.

`SkillInstructions` represents one selected skill's injected main prompt. It carries the skill `name`, rendered `path`, and prompt `contents`, and implements `ContextualUserFragment` as a user-role fragment wrapped in literal `<skill>` / `</skill>` markers. Its body is assembled as a compact XML-like block containing `<name>`, `<path>`, and the raw contents on separate lines.

The design here is intentionally minimal: these types do not discover or transform skills themselves, they only define how already-selected data is labeled and serialized into prompt fragments. Marker generation is centralized through `type_markers`, which keeps `markers()` trivial and ensures callers can obtain the same delimiters without an instance. Because these fragments are inserted into prompt context, the exact role strings and marker tags are part of the extension's prompt contract.

#### Function details

##### `AvailableSkillsInstructions::from_skill_lines`  (lines 12–14)

```
fn from_skill_lines(skill_lines: Vec<String>) -> Self
```

**Purpose**: Constructs an available-skills fragment from a prepared list of rendered skill lines. It is the simple value constructor for the listing fragment type.

**Data flow**: Consumes `skill_lines: Vec<String>` and stores it directly in `AvailableSkillsInstructions { skill_lines }`; returns the new fragment value without side effects.

**Call relations**: Used by rendering code that has already converted catalog entries into display lines and now needs a `ContextualUserFragment` implementation.


##### `AvailableSkillsInstructions::role`  (lines 18–20)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that the available-skills fragment should be injected with developer role semantics. This distinguishes catalog instructions from user-provided content.

**Data flow**: Reads no mutable state and returns the static string `"developer"`.

**Call relations**: Called by the prompt assembly framework when serializing contextual fragments into the final prompt.


##### `AvailableSkillsInstructions::markers`  (lines 22–24)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing markers that wrap the available-skills fragment. It forwards to the type-level marker definition.

**Data flow**: Reads no instance data and returns the tuple from `Self::type_markers()`.

**Call relations**: Invoked by the fragment framework during prompt serialization; it delegates to `type_markers` so instance and type-level marker access stay consistent.

*Call graph*: 1 external calls (type_markers).


##### `AvailableSkillsInstructions::type_markers`  (lines 26–28)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the protocol tags used to delimit the available-skills instructions block. These tags come from shared protocol constants.

**Data flow**: Returns the static tuple `(SKILLS_INSTRUCTIONS_OPEN_TAG, SKILLS_INSTRUCTIONS_CLOSE_TAG)` with no mutation or allocation.

**Call relations**: Used by `markers` and available to any code that needs the fragment delimiters without an instance.


##### `AvailableSkillsInstructions::body`  (lines 30–32)

```
fn body(&self) -> String
```

**Purpose**: Renders the textual body of the available-skills fragment from its stored lines. It delegates the exact formatting to core skills rendering logic.

**Data flow**: Reads `self.skill_lines` and passes an empty slice plus the stored lines into `render_available_skills_body`, returning the resulting `String`.

**Call relations**: Called by the prompt framework when serializing this fragment. It relies on shared rendering code so the listing format matches core skills conventions.

*Call graph*: 1 external calls (render_available_skills_body).


##### `SkillInstructions::role`  (lines 43–45)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that an injected skill prompt fragment should use the user role. This makes selected skill contents appear as user-context material rather than developer instructions.

**Data flow**: Returns the static string `"user"`; it does not inspect or mutate instance state.

**Call relations**: Used by the prompt assembly framework when placing selected skill contents into the turn context.


##### `SkillInstructions::markers`  (lines 47–49)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the delimiters for an individual skill fragment. It simply forwards to the type-level marker definition.

**Data flow**: Reads no instance fields and returns `Self::type_markers()`.

**Call relations**: Called during fragment serialization; it keeps marker lookup consistent with `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `SkillInstructions::type_markers`  (lines 51–53)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the literal tags that wrap an injected skill prompt block. These are fixed XML-like markers specific to skill content.

**Data flow**: Returns the static tuple `("<skill>", "</skill>")` with no side effects.

**Call relations**: Used by `markers` and by any code that needs to know the fragment envelope for skill prompt blocks.


##### `SkillInstructions::body`  (lines 55–60)

```
fn body(&self) -> String
```

**Purpose**: Formats the selected skill's metadata and contents into the body text inserted between `<skill>` markers. It emits the name and path as tagged lines followed by the raw prompt contents.

**Data flow**: Reads `self.name`, `self.path`, and `self.contents`, binds them to local references, interpolates them into a formatted string containing `<name>`, `<path>`, and the contents separated by newlines, and returns the resulting `String`.

**Call relations**: Called by the prompt framework when serializing an injected skill prompt. It is the final formatting step after higher-level code has already truncated and selected the fields.

*Call graph*: 1 external calls (format!).


### Session and environment context
These fragments inject the main runtime, instruction, and operational context that frames an ongoing conversation for the model.

### `core/src/context/approved_command_prefix_saved.rs`

`data_model` · `cross-cutting`

This file contains a single lightweight data carrier, `ApprovedCommandPrefixSaved`, with one field: `prefixes: String`. Its only constructor accepts any `Into<String>`, making it easy for callers to pass either owned strings or string slices when recording an execution-policy amendment.

The type implements `ContextualUserFragment`, which means it can be rendered into the model context alongside other structured fragments. The implementation is intentionally minimal: `role()` always returns `"developer"`, `markers()` delegates to `type_markers()`, and `type_markers()` returns empty strings for both open and close markers, so this fragment is inserted as plain text rather than wrapped in protocol tags. `body()` formats a fixed heading line, `Approved command prefix saved:`, followed by the stored prefixes on the next line.

The design choice to use empty markers matters: this fragment is informational state injected into the developer context, not a tagged protocol section that downstream parsing needs to isolate. The file therefore serves as a tiny adapter from saved command-prefix state into the shared contextual-fragment rendering system.

#### Function details

##### `ApprovedCommandPrefixSaved::new`  (lines 9–13)

```
fn new(prefixes: impl Into<String>) -> Self
```

**Purpose**: Constructs the fragment from any string-like input by storing the approved prefixes as owned text. It is the only way this type is instantiated in normal code.

**Data flow**: Takes `prefixes: impl Into<String>`, converts it into a `String`, stores it in the `prefixes` field, and returns a new `ApprovedCommandPrefixSaved`.

**Call relations**: It is called by `record_execpolicy_amendment_message` when the system needs to add this informational fragment to context after saving approved command prefixes.

*Call graph*: called by 1 (record_execpolicy_amendment_message); 1 external calls (into).


##### `ApprovedCommandPrefixSaved::role`  (lines 17–19)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that this fragment should be rendered as developer-context content. The role is fixed and does not depend on instance state.

**Data flow**: Reads no fields and returns the static string `"developer"`.

**Call relations**: It is invoked through the `ContextualUserFragment` trait wherever contextual fragments are rendered into prompt messages.


##### `ApprovedCommandPrefixSaved::markers`  (lines 21–23)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the fragment's wrapper markers by delegating to the type-level marker definition. For this fragment, that means no wrappers at all.

**Data flow**: Reads no instance state, calls `Self::type_markers()`, and returns the resulting pair of static strings.

**Call relations**: It participates in generic fragment rendering via the trait implementation and centralizes marker lookup through the shared type-level method.

*Call graph*: 1 external calls (type_markers).


##### `ApprovedCommandPrefixSaved::type_markers`  (lines 25–27)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the open and close markers for this fragment type. Both are empty strings so the body is emitted untagged.

**Data flow**: Returns the tuple `("", "")` with no inputs or side effects.

**Call relations**: It is used by `markers` and indirectly by any renderer that asks the fragment for its delimiters.


##### `ApprovedCommandPrefixSaved::body`  (lines 29–31)

```
fn body(&self) -> String
```

**Purpose**: Formats the human-readable message describing the saved approved command prefixes. It embeds the stored prefix text directly after a fixed heading.

**Data flow**: Reads `self.prefixes`, interpolates it into `format!("Approved command prefix saved:\n{}", ...)`, and returns the resulting `String`.

**Call relations**: It is called through the `ContextualUserFragment` trait when this fragment is rendered into the model context.

*Call graph*: 1 external calls (format!).


### `core/src/context/environment_context.rs`

`domain_logic` · `context assembly`

This file is the implementation of the `<environment_context>` contextual fragment. Its main data model is `EnvironmentContext`, which stores selected environments (`EnvironmentContextEnvironments` as `None`, `Single`, or `Multiple`), optional date/time metadata, optional `NetworkContext`, optional `FileSystemContext`, and optional subagent text. `EnvironmentContextEnvironment` captures one environment’s `id`, absolute `cwd`, and shell name; `from_turn_environments` builds these from `TurnEnvironment` values, dropping any environment whose cwd cannot be converted to an absolute path.

Filesystem state is normalized through `FileSystemContext::from_permission_profile`, which materializes workspace-root-relative permissions, stores workspace roots as strings, and maps `PermissionProfile` into `Managed`, `Disabled`, or `External` forms. Managed restricted permissions are deduplicated before rendering. Rendering is explicit and XML-like: helper functions escape text content, serialize sandbox entries by access mode and path kind (`path`, `glob`, or `special`), and encode special paths such as `:workspace_roots` with optional subpaths.

The file also contains conversion logic from live `TurnContext` and persisted `TurnContextItem`. `from_turn_context_item` tolerates invalid persisted cwd values by resolving them against `/`, and `workspace_roots_from_turn_context_item` falls back to legacy cwd-as-workspace behavior when older items lack workspace roots. `diff_from_turn_context_item` computes an update fragment relative to a prior persisted context: for single-environment cases it only emits cwd/shell when cwd changed, but always carries current date/time and only updates network/filesystem when they differ. Finally, the `ContextualUserFragment` implementation renders either a legacy single-environment shape with top-level `<cwd>`/`<shell>` or a multi-environment `<environments>` block, then appends optional network, filesystem, and subagent sections.

#### Function details

##### `EnvironmentContextEnvironment::legacy`  (lines 36–42)

```
fn legacy(cwd: AbsolutePathBuf, shell: String) -> Self
```

**Purpose**: Constructs a single-environment record in the legacy shape used when only cwd and shell are emitted without an environment id. It intentionally sets `id` to the empty string.

**Data flow**: It takes an `AbsolutePathBuf` and a `String` shell name, builds `EnvironmentContextEnvironment { id: String::new(), cwd, shell }`, and returns it. No external state is read or written.

**Call relations**: This helper is used by `EnvironmentContext::diff_from_turn_context_item` when a single environment’s cwd changed and the update should be emitted in the older top-level `<cwd>/<shell>` form rather than as a named environment list.

*Call graph*: called by 1 (diff_from_turn_context_item); 1 external calls (new).


##### `EnvironmentContextEnvironment::from_turn_environments`  (lines 44–61)

```
fn from_turn_environments(environments: &[TurnEnvironment], shell: &Shell) -> Vec<Self>
```

**Purpose**: Converts runtime `TurnEnvironment` entries into serializable environment-context records. It preserves each environment id and chooses the environment-specific shell when present, otherwise the session shell.

**Data flow**: It accepts a slice of `TurnEnvironment` and a fallback `&Shell`, iterates over the environments, and `filter_map`s each one into `Some(EnvironmentContextEnvironment)` only if `environment.cwd().to_abs_path().ok()?` succeeds. For each retained environment it clones `environment_id`, computes `cwd`, and derives `shell` from `environment.shell` or the fallback shell. It returns a `Vec<EnvironmentContextEnvironment>`.

**Call relations**: This conversion is called by `EnvironmentContext::from_turn_context` while building the live environment fragment from session state. It encapsulates the rule that non-absolute or unconvertible foreign cwd values are omitted.

*Call graph*: called by 1 (from_turn_context); 1 external calls (iter).


##### `EnvironmentContextEnvironments::from_vec`  (lines 72–82)

```
fn from_vec(environments: Vec<EnvironmentContextEnvironment>) -> Self
```

**Purpose**: Normalizes a vector of environments into the compact enum representation used by `EnvironmentContext`. It distinguishes zero, one, and many environments without storing an unnecessary vector in the common single-environment case.

**Data flow**: It takes ownership of a `Vec<EnvironmentContextEnvironment>`, pops one element, and returns `None` if the vector was empty, `Single(environment)` if that pop consumed the only element, or pushes the popped element back and returns `Multiple(environments)` when more than one element remains. The output is an `EnvironmentContextEnvironments` enum.

**Call relations**: This normalization is used by `EnvironmentContext::new` and `EnvironmentContext::from_turn_context_item` so all constructors share the same zero/one/many encoding before later rendering or comparison.

*Call graph*: called by 2 (from_turn_context_item, new); 2 external calls (Multiple, Single).


##### `EnvironmentContextEnvironments::equals_except_shell`  (lines 84–97)

```
fn equals_except_shell(&self, other: &Self) -> bool
```

**Purpose**: Compares two environment selections while ignoring shell names. For single environments it compares only cwd; for multiple environments it compares ids and cwd pairwise in order.

**Data flow**: It reads two `EnvironmentContextEnvironments` values and pattern-matches their variants. Matching `None` values are equal; matching `Single` values are equal when `cwd` matches; matching `Multiple` values are equal when lengths match and every zipped pair has equal `id` and `cwd`. Any variant mismatch returns `false`.

**Call relations**: This helper underpins `EnvironmentContext::equals_except_shell`, which extends the comparison to the rest of the environment context fields while preserving the shell-agnostic semantics.

*Call graph*: called by 1 (equals_except_shell).


##### `FileSystemContext::from_permission_profile`  (lines 123–147)

```
fn from_permission_profile(
        permission_profile: &PermissionProfile,
        workspace_roots: &[AbsolutePathBuf],
    ) -> Self
```

**Purpose**: Builds the filesystem subsection of environment context from a `PermissionProfile` and the effective workspace roots. It materializes project-root-relative permissions before converting them into a renderable internal form.

**Data flow**: It clones the incoming `PermissionProfile`, calls `materialize_project_roots_with_workspace_roots(workspace_roots)`, converts each `AbsolutePathBuf` workspace root into a `String`, then maps the materialized profile into `FileSystemPermissionProfileContext::Managed`, `Disabled`, or `External`. Managed profiles delegate to `ManagedFileSystemContext::from(file_system)`. It returns a populated `FileSystemContext`.

**Call relations**: This constructor is used when building environment context from both live `TurnContext` and persisted `TurnContextItem`, and in tests that verify full filesystem serialization. It centralizes the workspace-root expansion logic so rendering always sees concrete paths.

*Call graph*: calls 1 internal fn (from); called by 3 (filesystem_from_turn_context_item, from_turn_context, serialize_environment_context_with_full_filesystem_profile); 3 external calls (Managed, clone, iter).


##### `FileSystemContext::render`  (lines 149–161)

```
fn render(&self) -> String
```

**Purpose**: Serializes the filesystem context into the `<filesystem>` XML-like fragment embedded inside environment context. It emits workspace roots first, then the permission profile.

**Data flow**: It starts a `String` with `<filesystem>`, optionally appends a `<workspace_roots>` block containing one `<root>` element per stored root via `push_text_element`, delegates permission-profile serialization to `self.permission_profile.render(&mut rendered)`, closes `</filesystem>`, and returns the final string.

**Call relations**: This renderer is called from `EnvironmentContext::body` when filesystem information is present. It in turn delegates profile-specific formatting to `FileSystemPermissionProfileContext::render`.

*Call graph*: calls 2 internal fn (render, push_text_element).


##### `ManagedFileSystemContext::from`  (lines 165–179)

```
fn from(file_system: ManagedFileSystemPermissions) -> Self
```

**Purpose**: Converts protocol-level managed filesystem permissions into the internal managed filesystem rendering model. It also removes duplicate sandbox entries for stable output.

**Data flow**: It takes a `ManagedFileSystemPermissions` by value. For `Restricted`, it mutably receives `entries` and `glob_scan_max_depth`, calls `dedupe_file_system_entries(&mut entries)`, converts the optional depth to `Option<usize>`, and returns `ManagedFileSystemContext::Restricted { ... }`. For `Unrestricted`, it returns `ManagedFileSystemContext::Unrestricted`.

**Call relations**: This conversion is invoked by `FileSystemContext::from_permission_profile` when the permission profile is managed. It isolates deduplication and shape conversion before rendering.

*Call graph*: calls 1 internal fn (dedupe_file_system_entries); called by 1 (from_permission_profile).


##### `FileSystemPermissionProfileContext::render`  (lines 183–201)

```
fn render(&self, rendered: &mut String)
```

**Purpose**: Renders the permission-profile wrapper around filesystem permissions, including the profile type and the nested file-system representation. It also encodes disabled and external profiles as fixed self-describing XML snippets.

**Data flow**: It takes `&self` and a mutable output `String`. For `Managed`, it appends `<permission_profile type="managed">`, delegates to the managed filesystem renderer, and closes the tag. For `Disabled` and `External`, it appends fixed literal strings describing unrestricted or external file-system behavior.

**Call relations**: This method is called by `FileSystemContext::render` after workspace roots are emitted. It chooses the correct serialization branch based on the normalized permission-profile variant.

*Call graph*: called by 1 (render).


##### `ManagedFileSystemContext::render`  (lines 205–230)

```
fn render(&self, rendered: &mut String)
```

**Purpose**: Serializes managed filesystem permissions into a `<file_system>` element. Restricted mode may include a depth attribute and repeated `<entry>` children; unrestricted mode is a self-closing tag.

**Data flow**: It writes into a mutable `String`. For `Restricted`, if both `entries` and `glob_scan_max_depth` are absent it emits `<file_system type="restricted" />` and returns early. Otherwise it opens `<file_system type="restricted"`, optionally appends `glob_scan_max_depth="..."`, emits each entry via `render_file_system_entry`, and closes the tag. For `Unrestricted`, it emits `<file_system type="unrestricted" />`.

**Call relations**: This renderer is reached through `FileSystemPermissionProfileContext::render` for managed profiles. It delegates per-entry formatting to `render_file_system_entry` so path-kind-specific logic stays separate.

*Call graph*: calls 1 internal fn (render_file_system_entry); 1 external calls (format!).


##### `render_file_system_entry`  (lines 233–254)

```
fn render_file_system_entry(rendered: &mut String, entry: &FileSystemSandboxEntry)
```

**Purpose**: Formats one sandbox entry, including access mode, deny escalation metadata, and the concrete path/glob/special-path payload. It is the leaf serializer for restricted filesystem rules.

**Data flow**: It takes a mutable output `String` and a `&FileSystemSandboxEntry`. It opens `<entry access="...">`, appending `escalatable="false` when `entry.access` is `Deny`, then matches `entry.path`: `Path` becomes a `<path>` element, `GlobPattern` a `<glob>` element, and `Special` a `<special>` element after conversion through `render_special_path`. It closes `</entry>` after writing the nested element.

**Call relations**: This helper is called from `ManagedFileSystemContext::render` for each restricted entry. It delegates XML-safe text emission to `push_text_element` and special-path string conversion to `render_special_path`.

*Call graph*: calls 2 internal fn (push_text_element, render_special_path); called by 1 (render).


##### `render_special_path`  (lines 256–269)

```
fn render_special_path(value: &FileSystemSpecialPath) -> String
```

**Purpose**: Converts a `FileSystemSpecialPath` enum into the textual token used inside `<special>` elements. It preserves known symbolic names and appends subpaths where applicable.

**Data flow**: It matches the special-path variant and returns a `String`: fixed tokens for `Root`, `Minimal`, `Tmpdir`, and `SlashTmp`; `:workspace_roots` plus optional suffix for `ProjectRoots`; and the stored unknown base path plus optional suffix for `Unknown`. Variants with subpaths delegate to `render_special_path_with_subpath`.

**Call relations**: This conversion is used only by `render_file_system_entry` when serializing special filesystem sandbox entries.

*Call graph*: calls 1 internal fn (render_special_path_with_subpath); called by 1 (render_file_system_entry).


##### `render_special_path_with_subpath`  (lines 271–276)

```
fn render_special_path_with_subpath(base: &str, subpath: &Option<PathBuf>) -> String
```

**Purpose**: Builds the textual representation of a special path base token with an optional appended filesystem subpath. It is a small formatting helper shared by multiple special-path variants.

**Data flow**: It takes a base `&str` and an `&Option<PathBuf>`. If a subpath exists, it returns `format!("{base}/{}", subpath.display())`; otherwise it returns `base.to_string()`.

**Call relations**: This helper is called by `render_special_path` for `ProjectRoots` and `Unknown` variants that may carry a nested subpath.

*Call graph*: called by 1 (render_special_path); 1 external calls (format!).


##### `dedupe_file_system_entries`  (lines 278–281)

```
fn dedupe_file_system_entries(entries: &mut Vec<FileSystemSandboxEntry>)
```

**Purpose**: Removes duplicate filesystem sandbox entries while preserving first occurrence order. This keeps rendered restricted profiles stable and avoids repeated `<entry>` elements.

**Data flow**: It takes `&mut Vec<FileSystemSandboxEntry>`, creates a `HashSet` named `seen`, and retains only entries for which `seen.insert(entry.clone())` returns `true`. The vector is modified in place and no value is returned.

**Call relations**: This in-place normalization is invoked by `ManagedFileSystemContext::from` before the internal restricted profile is stored.

*Call graph*: called by 1 (from); 1 external calls (new).


##### `push_text_element`  (lines 283–287)

```
fn push_text_element(rendered: &mut String, name: &str, value: &str)
```

**Purpose**: Appends a simple XML-like element with escaped text content to an output buffer. It centralizes tag wrapping and escaping for filesystem rendering.

**Data flow**: It takes a mutable `String`, an element name, and a raw text value. It appends `<name>`, passes the value to `push_xml_escaped_text`, then appends `</name>`. The output buffer is mutated in place.

**Call relations**: This helper is used by `FileSystemContext::render` for workspace roots and by `render_file_system_entry` for path, glob, and special payloads.

*Call graph*: calls 1 internal fn (push_xml_escaped_text); called by 2 (render, render_file_system_entry); 1 external calls (format!).


##### `push_xml_escaped_text`  (lines 289–300)

```
fn push_xml_escaped_text(rendered: &mut String, value: &str)
```

**Purpose**: Escapes XML-sensitive characters in text content before appending them to a string buffer. It handles ampersands, angle brackets, quotes, and apostrophes explicitly.

**Data flow**: It iterates over `value.chars()` and pushes either an entity (`&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;`) or the original character into the mutable output `String`. It returns no value and mutates only the provided buffer.

**Call relations**: This low-level escaping routine is called by `push_text_element`, making all filesystem text-element serialization safe for embedded special characters.

*Call graph*: called by 1 (push_text_element).


##### `NetworkContext::new`  (lines 309–314)

```
fn new(allowed_domains: Vec<String>, denied_domains: Vec<String>) -> Self
```

**Purpose**: Constructs a network-context value from explicit allowed and denied domain lists. It is a thin initializer used by both live and persisted context conversion.

**Data flow**: It takes two `Vec<String>` arguments and returns `NetworkContext { allowed_domains, denied_domains }`. No transformation beyond field assignment occurs.

**Call relations**: This constructor is called by `EnvironmentContext::network_from_turn_context`, `EnvironmentContext::network_from_turn_context_item`, and tests that verify network serialization.

*Call graph*: called by 3 (network_from_turn_context, network_from_turn_context_item, serialize_environment_context_with_network).


##### `NetworkContext::render`  (lines 316–322)

```
fn render(&self) -> String
```

**Purpose**: Serializes network permissions into a `<network enabled="true">` fragment with optional allowed and denied domain lists. Empty lists are omitted rather than rendered as empty tags.

**Data flow**: It creates a `String` starting with `<network enabled="true">`, calls `push_rendered_domain_element` for `allowed` and `denied`, appends `</network>`, and returns the completed string.

**Call relations**: This renderer is called from `EnvironmentContext::body` when network information is present. It delegates list-specific emission to `push_rendered_domain_element`.

*Call graph*: 1 external calls (push_rendered_domain_element).


##### `NetworkContext::push_rendered_domain_element`  (lines 324–332)

```
fn push_rendered_domain_element(rendered_network: &mut String, name: &str, domains: &[String])
```

**Purpose**: Appends one domain-list element to the network fragment when the list is non-empty. Domains are serialized as a comma-joined string.

**Data flow**: It takes a mutable output string, an element name such as `allowed` or `denied`, and a slice of domain strings. If the slice is empty it returns immediately; otherwise it appends `<name>`, `domains.join(",")`, and `</name>`.

**Call relations**: This helper is used only by `NetworkContext::render` to avoid duplicating the empty-list check and tag formatting for both domain categories.

*Call graph*: 1 external calls (format!).


##### `EnvironmentContext::new`  (lines 336–351)

```
fn new(
        environments: Vec<EnvironmentContextEnvironment>,
        current_date: Option<String>,
        timezone: Option<String>,
        network: Option<NetworkContext>,
        subagents: Op
```

**Purpose**: Creates an `EnvironmentContext` from a raw environment vector and optional date, timezone, network, and subagent data. It defaults `filesystem` to `None` and normalizes the environment collection shape.

**Data flow**: It takes `Vec<EnvironmentContextEnvironment>`, optional strings for date/time, an optional `NetworkContext`, and an optional subagent string. It converts the vector with `EnvironmentContextEnvironments::from_vec`, stores the other fields as given, sets `filesystem: None`, and returns the new struct.

**Call relations**: This is the main constructor used by tests and by `EnvironmentContext::from_turn_context` before filesystem data is attached. It funnels all callers through the same environment normalization logic.

*Call graph*: calls 1 internal fn (from_vec); called by 10 (equals_except_shell_compares_cwd, equals_except_shell_compares_cwd_differences, equals_except_shell_ignores_shell, serialize_environment_context_prefers_environment_shell_when_present, serialize_environment_context_with_full_filesystem_profile, serialize_environment_context_with_multiple_selected_environments, serialize_environment_context_with_network, serialize_environment_context_with_subagents, serialize_read_only_environment_context, serialize_workspace_write_environment_context).


##### `EnvironmentContext::new_with_environments`  (lines 353–369)

```
fn new_with_environments(
        environments: EnvironmentContextEnvironments,
        current_date: Option<String>,
        timezone: Option<String>,
        network: Option<NetworkContext>,
```

**Purpose**: Creates an `EnvironmentContext` when the caller already has a normalized `EnvironmentContextEnvironments` value and possibly a filesystem section. It is the lower-level constructor used by diffing and persisted-context reconstruction.

**Data flow**: It takes a prebuilt `EnvironmentContextEnvironments`, optional date/time, optional `NetworkContext`, optional `FileSystemContext`, and optional subagent text, then returns `EnvironmentContext` with those fields assigned directly.

**Call relations**: This helper is used by `diff_from_turn_context_item` and `from_turn_context_item`, where the environment shape and filesystem section are computed before construction.

*Call graph*: called by 1 (diff_from_turn_context_item).


##### `EnvironmentContext::equals_except_shell`  (lines 374–381)

```
fn equals_except_shell(&self, other: &EnvironmentContext) -> bool
```

**Purpose**: Compares two full environment contexts while ignoring shell differences inside the environment selection. All other fields must match exactly.

**Data flow**: It reads `self` and `other`, delegates environment comparison to `self.environments.equals_except_shell(&other.environments)`, and combines that with equality checks on `current_date`, `timezone`, `network`, `filesystem`, and `subagents`. It returns a boolean.

**Call relations**: This method is the public shell-agnostic comparator used by tests and likely by higher-level update logic that wants to suppress shell-only changes.

*Call graph*: calls 1 internal fn (equals_except_shell).


##### `EnvironmentContext::diff_from_turn_context_item`  (lines 383–423)

```
fn diff_from_turn_context_item(
        before: &TurnContextItem,
        after: &EnvironmentContext,
    ) -> Self
```

**Purpose**: Builds an environment-context update relative to a previously persisted `TurnContextItem`. It emits only the environment portion that changed in the single-environment legacy case while preserving current metadata and selectively updating network/filesystem sections.

**Data flow**: It takes a prior `TurnContextItem` and an `after: &EnvironmentContext`. It reconstructs `before_network` and `before_filesystem` from the item. For environments, if `after` has a single environment and its cwd differs from `before.cwd`, it emits a legacy single environment with empty id; if the cwd is unchanged it emits `None`; multiple environments are cloned wholesale; `None` stays `None`. Network and filesystem are set to `after`’s values only when they differ from the reconstructed `before` values, otherwise the reconstructed values are reused. It returns a new `EnvironmentContext` with current date/time copied from `after` and `subagents` forced to `None`.

**Call relations**: This diffing function is called by higher-level environment-update item construction. It depends on `network_from_turn_context_item`, `filesystem_from_turn_context_item`, and `EnvironmentContextEnvironment::legacy` to compare persisted state against the current context and produce a minimal update payload.

*Call graph*: calls 2 internal fn (new_with_environments, legacy); called by 1 (build_environment_update_item); 4 external calls (filesystem_from_turn_context_item, network_from_turn_context_item, Multiple, Single).


##### `EnvironmentContext::from_turn_context`  (lines 425–441)

```
fn from_turn_context(turn_context: &TurnContext, shell: &Shell) -> Self
```

**Purpose**: Constructs a full environment context from live session `TurnContext` and the session shell. It captures selected environments, date/time, network requirements, and filesystem permissions derived from the effective workspace roots.

**Data flow**: It takes `&TurnContext` and `&Shell`, converts `turn_context.environments.turn_environments` via `EnvironmentContextEnvironment::from_turn_environments`, copies `current_date` and `timezone`, derives optional network data with `network_from_turn_context`, and creates an initial context with `EnvironmentContext::new`. It then computes `FileSystemContext::from_permission_profile(&turn_context.permission_profile, &turn_context.config.effective_workspace_roots())`, stores it in `context.filesystem`, and returns the context.

**Call relations**: This constructor is used when assembling initial or updated model context from the live session. It is the main bridge from runtime turn state into the serializable fragment rendered by `ContextualUserFragment::body`.

*Call graph*: calls 2 internal fn (from_turn_environments, from_permission_profile); called by 3 (build_environment_update_item, build_initial_context, environment_context_uses_session_shell_when_environment_shell_is_absent); 2 external calls (network_from_turn_context, new).


##### `EnvironmentContext::from_turn_context_item`  (lines 443–461)

```
fn from_turn_context_item(
        turn_context_item: &TurnContextItem,
        shell: String,
    ) -> Self
```

**Purpose**: Reconstructs an environment context from a persisted `TurnContextItem` plus a shell name. It supports older persisted items and invalid cwd strings by applying fallback path resolution rules.

**Data flow**: It takes a `&TurnContextItem` and a `String` shell. It tries `AbsolutePathBuf::try_from(turn_context_item.cwd.clone())`; on failure it resolves the stored cwd against `/`. It wraps that cwd and shell in a legacy single environment, normalizes it with `EnvironmentContextEnvironments::from_vec`, copies date/time, derives network and filesystem via `network_from_turn_context_item` and `filesystem_from_turn_context_item`, and returns the result through `new_with_environments`.

**Call relations**: This reconstruction path is used by environment-update logic and tests that verify workspace-root handling for persisted items. It pairs with `workspace_roots_from_turn_context_item` to preserve compatibility with historical rollout data.

*Call graph*: calls 3 internal fn (from_vec, resolve_path_against_base, try_from); called by 2 (turn_context_item_filesystem_uses_workspace_roots_instead_of_cwd, build_environment_update_item); 4 external calls (filesystem_from_turn_context_item, network_from_turn_context_item, new_with_environments, vec!).


##### `EnvironmentContext::with_subagents`  (lines 463–468)

```
fn with_subagents(mut self, subagents: String) -> Self
```

**Purpose**: Adds subagent summary text to an existing environment context, but only when the provided string is non-empty. Empty input leaves the context unchanged.

**Data flow**: It takes ownership of `self` and a `String` subagents. If `subagents.is_empty()` is false, it sets `self.subagents = Some(subagents)`. It returns the possibly modified `EnvironmentContext`.

**Call relations**: This is a post-construction convenience method for callers that compute subagent text separately from the rest of the environment context.


##### `EnvironmentContext::network_from_turn_context`  (lines 470–490)

```
fn network_from_turn_context(turn_context: &TurnContext) -> Option<NetworkContext>
```

**Purpose**: Extracts network domain permissions from the live turn configuration and converts them into `NetworkContext`. If no network requirement is configured, it returns `None`.

**Data flow**: It reads `turn_context.config.config_layer_stack.requirements().network.as_ref()?`, then pulls allowed and denied domains from the optional TOML domain permissions using `allowed_domains` and `denied_domains`, defaulting each to an empty vector when absent. It returns `Some(NetworkContext::new(...))` or `None`.

**Call relations**: This helper is called by `EnvironmentContext::from_turn_context` so live session configuration can be embedded in the rendered environment fragment.

*Call graph*: calls 1 internal fn (new).


##### `EnvironmentContext::network_from_turn_context_item`  (lines 492–503)

```
fn network_from_turn_context_item(
        turn_context_item: &TurnContextItem,
    ) -> Option<NetworkContext>
```

**Purpose**: Extracts persisted network permissions from a `TurnContextItem` into `NetworkContext`. It returns `None` when the item has no network section.

**Data flow**: It reads `turn_context_item.network.as_ref()?`, destructures `allowed_domains` and `denied_domains`, clones both vectors, and returns `Some(NetworkContext::new(...))`.

**Call relations**: This helper is used by both `diff_from_turn_context_item` and `from_turn_context_item` to reconstruct the prior or persisted network state for comparison and rendering.

*Call graph*: calls 1 internal fn (new).


##### `EnvironmentContext::filesystem_from_turn_context_item`  (lines 505–512)

```
fn filesystem_from_turn_context_item(
        turn_context_item: &TurnContextItem,
    ) -> Option<FileSystemContext>
```

**Purpose**: Builds a filesystem context from a persisted turn-context item, using workspace roots when available and a legacy cwd fallback otherwise. It always returns `Some(FileSystemContext)` based on the item’s effective permission profile.

**Data flow**: It takes `&TurnContextItem`, obtains a permission profile via `turn_context_item.permission_profile()`, computes workspace roots with `workspace_roots_from_turn_context_item(turn_context_item)`, passes both into `FileSystemContext::from_permission_profile`, wraps the result in `Some`, and returns it.

**Call relations**: This helper is called by `diff_from_turn_context_item` and `from_turn_context_item`. It centralizes the persisted-item filesystem reconstruction logic so both paths interpret historical data the same way.

*Call graph*: calls 3 internal fn (from_permission_profile, workspace_roots_from_turn_context_item, permission_profile).


##### `workspace_roots_from_turn_context_item`  (lines 515–528)

```
fn workspace_roots_from_turn_context_item(
    turn_context_item: &TurnContextItem,
) -> Vec<AbsolutePathBuf>
```

**Purpose**: Determines which workspace roots should be used when reconstructing filesystem permissions from a persisted turn-context item. It preserves backward compatibility with older items that did not store workspace roots explicitly.

**Data flow**: It takes `&TurnContextItem`. If `workspace_roots` is present, it clones and returns that vector. Otherwise it tries to convert `turn_context_item.cwd` into an `AbsolutePathBuf`; on success it returns a single-element vector containing that cwd, and on failure it returns an empty vector.

**Call relations**: This helper is used exclusively by `EnvironmentContext::filesystem_from_turn_context_item` to ensure permission-profile materialization uses the correct roots for both current and historical persisted items.

*Call graph*: calls 1 internal fn (try_from); called by 1 (filesystem_from_turn_context_item); 2 external calls (new, vec!).


##### `EnvironmentContext::role`  (lines 531–533)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that environment context is emitted as a user-role contextual fragment. This role influences how the fragment is inserted into the conversation transcript.

**Data flow**: It reads no inputs beyond `&self` and returns the static string `"user"`.

**Call relations**: This method fulfills the `ContextualUserFragment` trait contract and is consumed by generic fragment-rendering infrastructure.


##### `EnvironmentContext::markers`  (lines 535–537)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the opening and closing markers used to wrap the environment-context body. It forwards to the type-level marker definition.

**Data flow**: It takes `&self`, calls `Self::type_markers()`, and returns the resulting `(&'static str, &'static str)` pair.

**Call relations**: This trait method is used by generic contextual-fragment rendering code and delegates marker ownership to the associated type-level function.

*Call graph*: 1 external calls (type_markers).


##### `EnvironmentContext::type_markers`  (lines 539–544)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Provides the protocol-defined opening and closing tags for environment context. These constants determine the exact wrapper recognized elsewhere in the system.

**Data flow**: It returns the pair `(ENVIRONMENT_CONTEXT_OPEN_TAG, ENVIRONMENT_CONTEXT_CLOSE_TAG)` from `codex_protocol::protocol` without inspecting any runtime state.

**Call relations**: This static marker definition is used by `markers` and by any code that needs the canonical environment-context wrapper tags.


##### `EnvironmentContext::body`  (lines 546–595)

```
fn body(&self) -> String
```

**Purpose**: Renders the inner body of the environment-context fragment, including environments, date/time, network, filesystem, and subagents. It chooses between legacy single-environment formatting and the newer multi-environment block.

**Data flow**: It builds a `Vec<String>` of indented lines. For `Single`, it emits top-level `<cwd>` and `<shell>` lines; for `Multiple`, it emits `<environments>` with nested `<environment id="...">`, `<cwd>`, and `<shell>` lines; for `None`, it emits no environment lines. It then appends optional `<current_date>`, `<timezone>`, rendered network and filesystem strings, and a multiline `<subagents>` block with each source line indented. Finally it joins the lines with newlines and wraps them with leading and trailing newline characters, returning the resulting `String`.

**Call relations**: This is the main serialization method used by the `ContextualUserFragment` trait implementation. It consumes the normalized state produced by the constructors and conversion helpers elsewhere in the file.

*Call graph*: 2 external calls (new, format!).


### `core/src/context/guardian_followup_review_reminder.rs`

`domain_logic` · `context assembly`

This file contains a single zero-sized type, `GuardianFollowupReviewReminder`, implementing `ContextualUserFragment`. Unlike XML-wrapped fragments elsewhere in the context subsystem, this one uses empty markers, so its contribution is just plain body text inserted into the prompt. The body is a hard-coded policy reminder aimed at follow-up review scenarios: prior reviews are context rather than binding precedent, the Workspace Policy still governs, and explicit user approval after disclosure of concrete risks should generally produce an `allow` outcome unless policy forbids such overrides.

Because the struct carries no state, all behavior is fixed and deterministic. `role()` returns `developer`, indicating the reminder is injected as developer guidance rather than user content. `markers()` simply forwards to `type_markers()`, which returns empty strings for both open and close markers. The design choice here is deliberate: this fragment is not meant to be parsed back from tagged transcript content, only inserted as plain instruction text at the appropriate point in the review prompt assembly pipeline.

#### Function details

##### `GuardianFollowupReviewReminder::role`  (lines 7–9)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that this reminder is emitted as developer-role prompt content. That places it alongside system/developer guidance rather than user-visible context.

**Data flow**: It takes `&self` and returns the static string `"developer"`. No state is read beyond the receiver and nothing is mutated.

**Call relations**: This method satisfies the `ContextualUserFragment` trait and is consumed by generic prompt assembly code when placing the fragment into the conversation.


##### `GuardianFollowupReviewReminder::markers`  (lines 11–13)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the fragment’s wrapper markers, which are intentionally empty. This means the reminder is inserted as raw text with no surrounding tags.

**Data flow**: It takes `&self`, calls `Self::type_markers()`, and returns the resulting empty-string pair.

**Call relations**: This trait method delegates marker definition to `type_markers`, keeping instance and type-level marker behavior aligned.

*Call graph*: 1 external calls (type_markers).


##### `GuardianFollowupReviewReminder::type_markers`  (lines 15–17)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the absence of wrapper tags for this reminder fragment. Both opening and closing markers are empty strings.

**Data flow**: It returns `("", "")` directly and reads no runtime state.

**Call relations**: This static marker definition is used by `markers` and by any generic code that needs the fragment’s canonical wrapping behavior.


##### `GuardianFollowupReviewReminder::body`  (lines 19–28)

```
fn body(&self) -> String
```

**Purpose**: Produces the fixed reminder text used in guardian follow-up review prompts. The text encodes the intended policy interpretation around prior reviews and user-approved overrides.

**Data flow**: It concatenates several string literals with `concat!`, converts the result to `String`, and returns it. There are no inputs besides `&self` and no side effects.

**Call relations**: This is the substantive content of the fragment; prompt assembly code calls it through the `ContextualUserFragment` trait when injecting the reminder.

*Call graph*: 1 external calls (concat!).


### `core/src/context/hook_additional_context.rs`

`domain_logic` · `context assembly`

This file defines `HookAdditionalContext`, a tiny stateful fragment type whose only field is a `String` named `text`. The type exists so callers can inject free-form additional context into hook-related prompts while still using the common contextual-fragment rendering pipeline. Unlike structured fragments such as environment context, it has no XML markers and no internal parsing logic; the stored text is emitted verbatim.

The implementation is intentionally simple. `new` accepts any `Into<String>` input, allowing callers to pass either `String` or string-like values without manual conversion. As a `ContextualUserFragment`, the fragment reports role `developer`, uses empty markers, and returns a clone of its stored text from `body()`. The clone in `body()` preserves ownership of the internal field so the fragment can be rendered multiple times without consuming itself. This file is therefore best understood as a typed prompt payload container rather than a parser or serializer for a structured protocol format.

#### Function details

##### `HookAdditionalContext::new`  (lines 9–11)

```
fn new(text: impl Into<String>) -> Self
```

**Purpose**: Constructs a new additional-context fragment from any string-convertible input. It stores the resulting owned text for later prompt rendering.

**Data flow**: It takes `text: impl Into<String>`, converts it with `text.into()`, stores it in `Self { text }`, and returns the new `HookAdditionalContext`.

**Call relations**: This constructor is the entry point used by callers that want to inject ad hoc hook-related developer guidance into the contextual-fragment pipeline.

*Call graph*: 1 external calls (into).


##### `HookAdditionalContext::role`  (lines 15–17)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks the fragment as developer-role content. This ensures the additional hook context is inserted as developer guidance rather than user or assistant text.

**Data flow**: It takes `&self` and returns the static string `"developer"`.

**Call relations**: This trait method is consumed by generic prompt assembly code when placing the fragment into the conversation.


##### `HookAdditionalContext::markers`  (lines 19–21)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the fragment’s wrapper markers, which are empty because the text is meant to be inserted directly. No XML-like envelope is added around the stored content.

**Data flow**: It takes `&self`, calls `Self::type_markers()`, and returns the empty-string pair.

**Call relations**: This method fulfills the `ContextualUserFragment` trait and delegates the actual marker definition to the type-level function.

*Call graph*: 1 external calls (type_markers).


##### `HookAdditionalContext::type_markers`  (lines 23–25)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that this fragment has no opening or closing markers. The body text stands alone.

**Data flow**: It returns `("", "")` directly.

**Call relations**: This static definition is used by `markers` and by any generic code that needs the fragment’s canonical wrapping behavior.


##### `HookAdditionalContext::body`  (lines 27–29)

```
fn body(&self) -> String
```

**Purpose**: Returns the stored additional-context text exactly as provided at construction time. It does not transform or annotate the content.

**Data flow**: It reads `self.text`, clones it, and returns the cloned `String`. No external state is touched.

**Call relations**: This is the fragment’s payload method, called by prompt assembly through the `ContextualUserFragment` trait.


### `core/src/context/model_switch_instructions.rs`

`domain_logic` · `context updates during model switching`

This file encapsulates model-transition guidance as a `ContextualUserFragment`. `ModelSwitchInstructions` stores a single `String`, `model_instructions`, containing the handoff text that should be shown to the replacement model. The type is small but purposeful: it gives the system a dedicated wrapper and role for instructions that are not user-authored content, yet still need to be inserted into the conversational context.

The constructor accepts any `Into<String>` input and stores an owned copy. In the trait implementation, the role is fixed to `developer`, distinguishing these instructions from user-visible messages. The fragment is wrapped with explicit `<model_switch>` and `</model_switch>` markers so downstream parsing or auditing can identify it unambiguously in serialized history. `body()` formats a multi-line explanatory preamble followed by the stored instruction text, with blank lines around the inserted content to make the handoff readable to the model. There is no custom parsing logic in this file; its responsibility is to package already-decided switch instructions into a stable fragment shape that higher-level orchestration can append when a conversation changes models midstream.

#### Function details

##### `ModelSwitchInstructions::new`  (lines 9–13)

```
fn new(model_instructions: impl Into<String>) -> Self
```

**Purpose**: Constructs a model-switch instruction fragment from arbitrary string-like input. It captures the handoff instructions as owned text for later serialization.

**Data flow**: Accepts `model_instructions: impl Into<String>`, converts it into a `String`, and returns `ModelSwitchInstructions { model_instructions }`.

**Call relations**: It is called by the code that builds a model-instructions update item when a conversation transitions to a different model. The constructor performs only ownership conversion; formatting is deferred to `body`.

*Call graph*: called by 1 (build_model_instructions_update_item); 1 external calls (into).


##### `ModelSwitchInstructions::role`  (lines 17–19)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that model-switch instructions are emitted as a `developer` fragment rather than a user fragment.

**Data flow**: Returns the static string `"developer"`.

**Call relations**: Generic fragment assembly reads this role when inserting the fragment into the message stream.


##### `ModelSwitchInstructions::markers`  (lines 21–23)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the wrapper markers used for serialized model-switch instructions.

**Data flow**: Calls and returns `Self::type_markers()`.

**Call relations**: This instance method is used by trait consumers and simply forwards to the type-level marker definition.

*Call graph*: 1 external calls (type_markers).


##### `ModelSwitchInstructions::type_markers`  (lines 25–27)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the explicit `<model_switch>` wrapper around this fragment type.

**Data flow**: Returns the tuple `("<model_switch>", "</model_switch>")`.

**Call relations**: It supplies the canonical delimiters used by `markers` and any code that needs to identify this fragment type structurally.


##### `ModelSwitchInstructions::body`  (lines 29–34)

```
fn body(&self) -> String
```

**Purpose**: Formats the explanatory handoff text shown to the new model, embedding the stored instructions after a fixed preamble.

**Data flow**: Reads `self.model_instructions` and interpolates it into a formatted multi-line string that explains the user was previously using a different model and that the conversation should continue according to the provided instructions. It returns the resulting `String`.

**Call relations**: Serialization code calls this when materializing the fragment into the conversation context after a model switch.

*Call graph*: 1 external calls (format!).


### `core/src/context/network_rule_saved.rs`

`domain_logic` · `approval/event recording into context`

This file turns a `codex_protocol::approvals::NetworkPolicyAmendment` into a contextual fragment suitable for inclusion in conversation history or model context. `NetworkRuleSaved` stores exactly the two pieces of amendment state needed for rendering: the `NetworkPolicyRuleAction` enum value and the target host string. By copying those fields out of the protocol object at construction time, the fragment becomes self-contained and independent of the original amendment's lifetime.

The trait implementation marks the fragment as `developer` role and uses empty markers, meaning the message is plain text rather than wrapped in a dedicated tag. `body()` performs the substantive transformation: it matches on `self.action` and maps `Allow` to the wording `Allowed` / `allowlist`, and `Deny` to `Denied` / `denylist`. It then formats a sentence of the form `Allowed network rule saved in execpolicy (allowlist): host` or the deny equivalent. This gives the model and any audit tooling a concise textual record of policy changes without exposing the full protocol structure. The file is narrowly focused on rendering one specific approval-side event into stable conversational text.

#### Function details

##### `NetworkRuleSaved::new`  (lines 12–17)

```
fn new(amendment: &NetworkPolicyAmendment) -> Self
```

**Purpose**: Builds a self-contained fragment from a network policy amendment by copying out the action and host fields needed for display.

**Data flow**: Takes `amendment: &NetworkPolicyAmendment`, reads `amendment.action` and clones `amendment.host`, then returns `NetworkRuleSaved { action, host }`.

**Call relations**: It is invoked when recording a network policy amendment message. The constructor isolates this fragment from the protocol object so later rendering only depends on local state.

*Call graph*: called by 1 (record_network_policy_amendment_message).


##### `NetworkRuleSaved::role`  (lines 21–23)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks the saved-rule message as a `developer` fragment.

**Data flow**: Returns the static string `"developer"`.

**Call relations**: Generic context assembly uses this role when placing the message into the conversation stream.


##### `NetworkRuleSaved::markers`  (lines 25–27)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the fragment markers, which are empty because the message is emitted as plain text.

**Data flow**: Calls `Self::type_markers()` and returns its tuple.

**Call relations**: It provides the instance-level trait hook while delegating the actual delimiter definition to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `NetworkRuleSaved::type_markers`  (lines 29–31)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that this fragment has no explicit wrapper tags.

**Data flow**: Returns `("", "")`.

**Call relations**: This marker definition is consumed through `markers` by generic fragment code.


##### `NetworkRuleSaved::body`  (lines 33–42)

```
fn body(&self) -> String
```

**Purpose**: Renders the stored amendment as a concise sentence describing whether a host was added to the allowlist or denylist in execpolicy.

**Data flow**: Reads `self.action` and `self.host`, matches the action to choose `(action, list_name)` as either `("Allowed", "allowlist")` or `("Denied", "denylist")`, then formats `"{action} network rule saved in execpolicy ({list_name}): {host}"` and returns that `String`.

**Call relations**: After `new` captures the amendment data, serialization code calls this method to produce the final textual context entry.

*Call graph*: 1 external calls (format!).


### `core/src/context/token_budget_context.rs`

`data_model` · `request handling`

This file contains two `ContextualUserFragment` implementations for token-budget reporting. `TokenBudgetContext` is the richer form: it stores a `ThreadId`, a `window_id: u64`, and `tokens_left: i64`, and emits all three pieces of information in a three-line developer-role message. `TokenBudgetRemainingContext` is the lighter form used when only the remaining token count matters; it stores `tokens_left: Option<i64>` so the system can explicitly represent both known and unknown remaining budget.

Both types use the same `<token_budget>` marker pair, including embedded newlines in the markers themselves: the opening marker ends with `\n` and the closing marker begins with `\n`. That design means the serialized fragment naturally places the body on its own lines without each caller having to manage spacing. The richer context's body copies fields into locals before formatting, then emits a sentence for thread id, current context window, and remaining tokens. The remaining-only variant branches on `Option<i64>`: `Some` produces a concrete token count sentence, while `None` emits an explicit "unknown tokens left" message rather than omitting the fragment. Together these types let upstream context builders choose between precise startup metadata and incremental budget reminders while preserving a uniform tag and developer-role framing.

#### Function details

##### `TokenBudgetContext::new`  (lines 12–18)

```
fn new(thread_id: ThreadId, window_id: u64, tokens_left: i64) -> Self
```

**Purpose**: Constructs the full token-budget fragment with thread, window, and remaining-token metadata. It simply stores the supplied values without transformation.

**Data flow**: Takes `thread_id: ThreadId`, `window_id: u64`, and `tokens_left: i64` → assigns them into a new `TokenBudgetContext` → returns the struct.

**Call relations**: It is called by `build_initial_context`, which uses this richer form when assembling the initial prompt context for a thread/window.

*Call graph*: called by 1 (build_initial_context).


##### `TokenBudgetContext::role`  (lines 22–24)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks the token-budget fragment as developer-side guidance. The role is fixed for all instances.

**Data flow**: Reads no fields → returns `"developer"`.

**Call relations**: This trait method is consumed by the context serialization layer when labeling the fragment.


##### `TokenBudgetContext::markers`  (lines 26–28)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the token-budget wrapper tags for an instance. It forwards to the static marker definition so the newline-bearing markers stay centralized.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the opening and closing token-budget markers.

**Call relations**: It is part of the `ContextualUserFragment` implementation and delegates marker definition to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `TokenBudgetContext::type_markers`  (lines 30–32)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact tags used to bracket full token-budget context. The markers include embedded newlines to control layout around the body text.

**Data flow**: Reads no dynamic state → returns `("<token_budget>\n", "\n</token_budget>")`.

**Call relations**: It is the shared marker source for `markers` and any static access to this fragment type's delimiters.


##### `TokenBudgetContext::body`  (lines 34–41)

```
fn body(&self) -> String
```

**Purpose**: Formats the full token-budget message with thread id, window id, and remaining tokens. The output is a fixed three-sentence block intended for developer guidance.

**Data flow**: Reads `self.thread_id`, `self.window_id`, and `self.tokens_left`, copies them into locals, interpolates them into a formatted string → returns the resulting `String`.

**Call relations**: This method is used after `build_initial_context` constructs the fragment; it performs no branching and only delegates to `format!`.

*Call graph*: 1 external calls (format!).


##### `TokenBudgetRemainingContext::new`  (lines 50–54)

```
fn new(tokens_left: i64) -> Self
```

**Purpose**: Constructs the simpler remaining-budget fragment when the token count is known. It wraps the provided count in `Some` to distinguish it from the unknown case.

**Data flow**: Takes `tokens_left: i64` → stores `Some(tokens_left)` in the struct → returns a new `TokenBudgetRemainingContext`.

**Call relations**: It is called by `maybe_record_token_budget_remaining_context` and by `fragment` when those paths have a concrete remaining-token value to report.

*Call graph*: called by 2 (maybe_record_token_budget_remaining_context, fragment).


##### `TokenBudgetRemainingContext::unknown`  (lines 56–58)

```
fn unknown() -> Self
```

**Purpose**: Constructs the remaining-budget fragment for cases where the token count cannot be determined. It encodes that absence explicitly with `None`.

**Data flow**: Takes no arguments → creates `TokenBudgetRemainingContext { tokens_left: None }` → returns it.

**Call relations**: It is called by `fragment` when the surrounding logic wants to emit a token-budget notice but lacks a numeric remaining-token value.

*Call graph*: called by 1 (fragment).


##### `TokenBudgetRemainingContext::role`  (lines 62–64)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that the remaining-budget notice is developer-role context. This matches the richer token-budget fragment.

**Data flow**: Reads no fields → returns `"developer"`.

**Call relations**: The context serializer invokes this through the trait when emitting the fragment.


##### `TokenBudgetRemainingContext::markers`  (lines 66–68)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the same token-budget wrapper tags used by the full token-budget fragment. It forwards to the static marker definition for consistency.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the marker tuple.

**Call relations**: This method participates in fragment serialization and delegates the actual tag literals to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `TokenBudgetRemainingContext::type_markers`  (lines 70–72)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the exact `<token_budget>` markers for the remaining-budget fragment. The markers intentionally match `TokenBudgetContext` so both variants serialize under the same semantic tag.

**Data flow**: Reads no dynamic state → returns `("<token_budget>\n", "\n</token_budget>")`.

**Call relations**: It is the canonical marker source used by `markers` and any static consumers of this fragment type.


##### `TokenBudgetRemainingContext::body`  (lines 74–81)

```
fn body(&self) -> String
```

**Purpose**: Formats either a concrete remaining-token sentence or an explicit unknown-budget sentence depending on whether `tokens_left` is present. This is the only branching logic in the file.

**Data flow**: Reads `self.tokens_left` → matches on `Some(tokens_left)` vs `None` → returns either a formatted sentence with the numeric count or the fixed fallback string converted to `String`.

**Call relations**: It is used after construction by the fragment-emission paths that call `new` or `unknown`; the branch ensures callers do not need separate formatting logic for known and unknown budgets.

*Call graph*: 1 external calls (format!).


### `core/src/context/turn_aborted.rs`

`data_model` · `request handling`

This file provides `TurnAborted`, a simple fragment type used to annotate conversation history when a prior turn was cut off. The struct stores one field, `guidance: String`, which becomes the entire body of the fragment. Two associated constants capture the standard interruption wording: `INTERRUPTED_GUIDANCE` is phrased from the user's perspective, while `INTERRUPTED_DEVELOPER_GUIDANCE` is phrased for developer-side context. Both warn that unified exec processes may still be running and that aborted tools or commands may have partially executed, which is an important operational caveat for any subsequent turn.

As a `ContextualUserFragment`, `TurnAborted` is emitted with role `user` and wrapped in `<turn_aborted>` tags. The body formatter adds leading and trailing newlines around the guidance text, but otherwise preserves the supplied message exactly. Construction accepts any string-like input via `Into<String>`, allowing callers to choose one of the canned constants or provide custom interruption guidance. There is no branching or validation here; the file's main responsibility is to standardize how interruption state is represented in prompt context so later logic can reason about incomplete side effects.

#### Function details

##### `TurnAborted::new`  (lines 12–16)

```
fn new(guidance: impl Into<String>) -> Self
```

**Purpose**: Creates a `TurnAborted` fragment from caller-supplied guidance text. It converts flexible string input into the owned `String` stored on the struct.

**Data flow**: Takes `guidance: impl Into<String>` → converts it with `into()` → stores the resulting `String` in `guidance` and returns a new `TurnAborted`.

**Call relations**: It is called by `interrupted_turn_history_marker`, which chooses the appropriate interruption wording and wraps it in this fragment type for history/context insertion.

*Call graph*: called by 1 (interrupted_turn_history_marker); 1 external calls (into).


##### `TurnAborted::role`  (lines 20–22)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks interruption notices as user-role context. This keeps the aborted-turn marker aligned with user-visible conversation history rather than developer-only steering.

**Data flow**: Reads no fields → returns `"user"`.

**Call relations**: The context serialization path invokes this trait method when labeling the fragment.


##### `TurnAborted::markers`  (lines 24–26)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the tags that wrap an aborted-turn notice. It forwards to the static marker definition to keep the literals centralized.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the `<turn_aborted>` marker pair.

**Call relations**: This method is part of the `ContextualUserFragment` implementation and delegates marker definition to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `TurnAborted::type_markers`  (lines 28–30)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the fixed delimiters used to bracket aborted-turn guidance. These tags identify the enclosed text as an interruption marker.

**Data flow**: Reads no dynamic state → returns `("<turn_aborted>", "</turn_aborted>")`.

**Call relations**: It is the canonical source for the marker pair used by `markers` and any static consumers.


##### `TurnAborted::body`  (lines 32–34)

```
fn body(&self) -> String
```

**Purpose**: Formats the stored guidance text as the fragment payload with surrounding newlines. It does not alter or interpret the guidance content.

**Data flow**: Reads `self.guidance` → interpolates it into `"\n{}\n"` with `format!` → returns the resulting `String`.

**Call relations**: This payload method is used after `interrupted_turn_history_marker` constructs the fragment; it only delegates to formatting.

*Call graph*: 1 external calls (format!).


### `core/src/context/user_instructions.rs`

`data_model` · `request handling`

This file implements `UserInstructions`, a contextual fragment that carries instruction text sourced from AGENTS.md-style guidance. The struct has two public crate-visible fields: `directory: Option<String>`, which can identify the directory the instructions apply to, and `text: String`, which holds the actual instruction content. Through `ContextualUserFragment`, the fragment is labeled as `user` content and uses an unusual marker pair: the opening marker is the literal `# AGENTS.md instructions`, while the closing marker is `</INSTRUCTIONS>`. That reflects the fact that the body itself begins the `<INSTRUCTIONS>` block rather than the marker pair fully enclosing it in XML-like symmetry.

The body method computes an optional directory suffix by borrowing `directory`, mapping it to `" for {directory}"`, and defaulting to an empty string when no directory is present. It then formats a header line containing that suffix, two newlines, an opening `<INSTRUCTIONS>` tag, and the raw instruction text followed by a trailing newline. This means the rendered fragment can appear either as a generic AGENTS.md instruction block or as one explicitly scoped to a path. The key design detail is that absence of `directory` does not suppress the fragment; it only removes the `for ...` qualifier from the header.

#### Function details

##### `UserInstructions::role`  (lines 10–12)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that AGENTS.md instructions are injected as user-role context. The role is fixed and independent of whether a directory is present.

**Data flow**: Reads no fields → returns `"user"`.

**Call relations**: This trait method is used by the context assembly layer when converting the fragment into serialized prompt content.


##### `UserInstructions::markers`  (lines 14–16)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the marker pair associated with AGENTS.md instruction fragments. It forwards to the static marker definition so the literals remain centralized.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the header marker and closing `</INSTRUCTIONS>` marker.

**Call relations**: It participates in fragment serialization and delegates marker selection to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `UserInstructions::type_markers`  (lines 18–20)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the fixed markers used for AGENTS.md instruction fragments. The opening marker is a human-readable heading rather than an XML tag.

**Data flow**: Reads no dynamic state → returns `("# AGENTS.md instructions", "</INSTRUCTIONS>")`.

**Call relations**: It is the canonical marker source for `markers` and any static consumers of this fragment type.


##### `UserInstructions::body`  (lines 22–29)

```
fn body(&self) -> String
```

**Purpose**: Builds the instruction block, optionally annotating it with a target directory and always opening an `<INSTRUCTIONS>` section before the stored text. It preserves the instruction text verbatim.

**Data flow**: Reads `self.directory` and `self.text` → maps `directory` to either `" for {directory}"` or `""` → formats `{directory}\n\n<INSTRUCTIONS>\n{self.text}\n` → returns the resulting `String`.

**Call relations**: This method is used by the prompt/context serializer to render AGENTS.md guidance; its internal `Option` handling avoids requiring callers to preformat the directory qualifier.

*Call graph*: 1 external calls (format!).


### `core/src/context/user_shell_command.rs`

`data_model` · `request handling`

This file provides `UserShellCommand`, a contextual fragment for embedding shell execution history into the conversation. The struct stores four concrete fields: `command: String`, `exit_code: i32`, `duration_seconds: f64`, and `output: String`. Its constructor accepts a `std::time::Duration` and immediately converts that to fractional seconds with `as_secs_f64`, so the fragment stores a serialization-ready numeric duration rather than the original `Duration` type.

As a `ContextualUserFragment`, the fragment is labeled `user` and wrapped in `<user_shell_command>` tags. The body method emits a nested text structure with `<command>` and `<result>` sections. Inside `<result>`, it prints the exit code, the duration formatted to four decimal places, and the command output under an `Output:` label. This layout is more structured than plain prose but still remains simple text, making it readable to both humans and models. The constructor accepts both command and output as `impl Into<String>`, allowing callers to pass borrowed or owned strings conveniently. There is no branching in formatting; the main design choice is preserving all execution metadata in one self-contained fragment so later reasoning can account for what command ran, how long it took, whether it succeeded, and what it printed.

#### Function details

##### `UserShellCommand::new`  (lines 14–26)

```
fn new(
        command: impl Into<String>,
        exit_code: i32,
        duration: Duration,
        output: impl Into<String>,
    ) -> Self
```

**Purpose**: Constructs a shell-command fragment from execution metadata and captured output. It normalizes string inputs and converts `Duration` into a floating-point seconds value for later formatting.

**Data flow**: Takes `command: impl Into<String>`, `exit_code: i32`, `duration: Duration`, and `output: impl Into<String>` → converts `command` and `output` with `into()`, converts `duration` with `as_secs_f64()` → stores all four values in a new `UserShellCommand` and returns it.

**Call relations**: It is called by `user_shell_command_fragment`, which gathers command execution results and wraps them in this fragment type for context insertion.

*Call graph*: called by 1 (user_shell_command_fragment); 2 external calls (as_secs_f64, into).


##### `UserShellCommand::role`  (lines 30–32)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks shell-command history as user-role context. This places command execution records alongside other user-originated contextual artifacts.

**Data flow**: Reads no fields → returns `"user"`.

**Call relations**: The context serialization layer invokes this trait method when labeling the fragment.


##### `UserShellCommand::markers`  (lines 34–36)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the wrapper tags for a shell-command fragment. It forwards to the static marker definition to keep the tag literals centralized.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the `<user_shell_command>` marker pair.

**Call relations**: This method is part of the `ContextualUserFragment` implementation and delegates marker definition to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `UserShellCommand::type_markers`  (lines 38–40)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the fixed delimiters used to bracket shell-command context. These tags identify the enclosed body as a command execution record.

**Data flow**: Reads no dynamic state → returns `("<user_shell_command>", "</user_shell_command>")`.

**Call relations**: It is the canonical source for the marker pair used by `markers` and any static consumers.


##### `UserShellCommand::body`  (lines 42–47)

```
fn body(&self) -> String
```

**Purpose**: Formats the stored command metadata and output into a multi-section text block. The duration is rendered with four digits after the decimal point, and the output is included verbatim.

**Data flow**: Reads `self.command`, `self.exit_code`, `self.duration_seconds`, and `self.output` → interpolates them into a formatted string containing `<command>` and `<result>` sections → returns the resulting `String`.

**Call relations**: This payload method is used after `user_shell_command_fragment` constructs the fragment; it performs no branching and only delegates to `format!`.

*Call graph*: 1 external calls (format!).


### Realtime lifecycle fragments
These files define the standardized prompt fragments that open, customize, and close realtime interaction mode.

### `core/src/context/realtime_start_instructions.rs`

`data_model` · `request handling`

This file implements a stateless contextual fragment, `RealtimeStartInstructions`, for injecting the standard realtime startup guidance into the prompt stream. The struct has no fields, which reflects that all of its behavior is constant: it always emits the same role, the same protocol markers, and the same body text. Through `ContextualUserFragment`, it identifies itself as `developer` content and uses the realtime open/close tags from `codex_protocol` so the surrounding prompt builder can wrap the startup instructions in the same tagged region used for realtime conversation metadata.

Its body is derived from the shared `START_INSTRUCTIONS` prompt constant imported from `codex_prompts`. The implementation trims that constant before formatting it between leading and trailing newlines, preventing accidental extra whitespace from the prompt asset while still ensuring the fragment is visually separated when concatenated with neighboring context blocks. Because there is no instance state and no branching, the file's main design choice is consistency: every startup fragment is byte-for-byte identical apart from any upstream serialization framing. This makes it suitable as a reusable marker fragment whenever realtime mode begins.

#### Function details

##### `RealtimeStartInstructions::role`  (lines 10–12)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that the startup instructions are developer-side guidance rather than user content. The role is fixed for all instances.

**Data flow**: Reads no state → returns the static string literal `"developer"`.

**Call relations**: It is invoked through the `ContextualUserFragment` trait when the prompt assembler converts this fragment into a message-like representation.


##### `RealtimeStartInstructions::markers`  (lines 14–16)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the delimiters used to wrap the realtime startup instruction block. It centralizes instance-level marker access by forwarding to the static marker definition.

**Data flow**: Reads no fields → calls `Self::type_markers()` → returns the realtime open and close tag tuple.

**Call relations**: This method is part of the fragment serialization path and delegates marker selection to `type_markers` to keep the constants defined in one place.

*Call graph*: 1 external calls (type_markers).


##### `RealtimeStartInstructions::type_markers`  (lines 18–23)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the protocol tags that identify the realtime conversation instruction region. These are the same tags used by the corresponding realtime end fragment.

**Data flow**: Reads imported constants `REALTIME_CONVERSATION_OPEN_TAG` and `REALTIME_CONVERSATION_CLOSE_TAG` → returns them as `(&'static str, &'static str)`.

**Call relations**: It serves as the canonical marker source for `markers` and any static access pattern that needs the fragment delimiters.


##### `RealtimeStartInstructions::body`  (lines 25–27)

```
fn body(&self) -> String
```

**Purpose**: Builds the startup instruction payload from the shared prompt constant. It trims the source text and wraps it in surrounding newlines for clean insertion into the tagged block.

**Data flow**: Reads `START_INSTRUCTIONS`, applies `trim()`, interpolates the result with `format!` into `"\n{}\n"` → returns the resulting `String`.

**Call relations**: This is the content-producing trait method used when the context system emits the realtime opening fragment; it only delegates to formatting.

*Call graph*: 1 external calls (format!).


### `core/src/context/realtime_start_with_instructions.rs`

`data_model` · `request handling`

This file provides `RealtimeStartWithInstructions`, a variant of the realtime-start fragment that carries caller-provided instruction text in an owned `String`. Like the fixed startup fragment, it implements `ContextualUserFragment` with the `developer` role and the protocol-level realtime open/close tags from `codex_protocol`. The difference is in the payload source: instead of importing a shared prompt constant, this type stores arbitrary instructions passed in by the caller and emits them verbatim inside the tagged block.

Construction is intentionally permissive through `impl Into<String>`, allowing callers to pass `String`, `&str`, or similar string-like values without extra conversion boilerplate. The body formatter simply wraps the stored instructions with leading and trailing newlines; there is no trimming or normalization, so upstream code controls exact whitespace and wording. That is a notable design distinction from the fixed `RealtimeStartInstructions` type, which trims a bundled prompt asset. The file therefore acts as a lightweight data carrier plus trait adapter for custom realtime startup content, typically selected by higher-level update-item construction logic when a session needs specialized opening instructions.

#### Function details

##### `RealtimeStartWithInstructions::new`  (lines 11–15)

```
fn new(instructions: impl Into<String>) -> Self
```

**Purpose**: Creates a custom realtime-start fragment from caller-supplied instruction text. It converts flexible string input into the owned `String` stored on the struct.

**Data flow**: Takes `instructions: impl Into<String>` → converts it with `into()` → stores the resulting `String` in `instructions` and returns a new `RealtimeStartWithInstructions`.

**Call relations**: It is called by `build_realtime_update_item` when that higher-level builder chooses the custom-instructions variant instead of the fixed startup prompt.

*Call graph*: called by 1 (build_realtime_update_item); 1 external calls (into).


##### `RealtimeStartWithInstructions::role`  (lines 19–21)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks this fragment as developer-authored context. The role is constant regardless of the instruction text carried by the instance.

**Data flow**: Reads no fields → returns `"developer"`.

**Call relations**: This method is used through the `ContextualUserFragment` trait during prompt/message serialization.


##### `RealtimeStartWithInstructions::markers`  (lines 23–25)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Supplies the realtime conversation delimiters for this fragment instance. It forwards to the static marker definition to avoid duplicating the tag tuple.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the open/close marker pair.

**Call relations**: It participates in fragment serialization and delegates the actual marker constants to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `RealtimeStartWithInstructions::type_markers`  (lines 27–32)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the protocol tags that bracket custom realtime startup instructions. These tags align this fragment with the rest of the realtime conversation framing.

**Data flow**: Reads imported `REALTIME_CONVERSATION_OPEN_TAG` and `REALTIME_CONVERSATION_CLOSE_TAG` constants → returns them as a tuple.

**Call relations**: It is the shared marker source used by `markers` and any static lookup of this fragment type's delimiters.


##### `RealtimeStartWithInstructions::body`  (lines 34–36)

```
fn body(&self) -> String
```

**Purpose**: Formats the stored custom instructions as the fragment payload. It preserves the instruction text exactly as stored, adding only surrounding newlines.

**Data flow**: Reads `self.instructions` → interpolates it into `"\n{}\n"` with `format!` → returns the resulting `String`.

**Call relations**: This method is invoked after construction by the context assembly path to obtain the actual text inserted into the realtime instruction block.

*Call graph*: 1 external calls (format!).


### `core/src/context/realtime_end_instructions.rs`

`data_model` · `request handling`

This file contributes a small, concrete fragment type used when the system needs to inject end-of-realtime guidance into the assembled conversation context. `RealtimeEndInstructions` stores a single `reason: String`, and its implementation of `ContextualUserFragment` fixes the fragment role to `developer`, meaning the text is framed as system/developer-side steering rather than user content. The fragment is wrapped with the protocol-level realtime conversation delimiters imported from `codex_protocol`, so downstream prompt assembly can recognize it as part of the special realtime instruction region.

The body text is built from the shared `END_INSTRUCTIONS` prompt constant, trimmed before insertion to avoid inheriting surrounding whitespace from the source prompt asset. The file then appends a blank line and a `Reason: ...` line carrying the specific shutdown cause supplied by the caller. That design preserves a stable instruction template while still exposing the runtime reason that triggered closure. There is no branching beyond string construction; the main invariant is that every instance emits the same open/close markers and developer role, with only the `reason` field varying. This makes the type a predictable leaf in the larger context-building pipeline that emits realtime update items.

#### Function details

##### `RealtimeEndInstructions::new`  (lines 12–16)

```
fn new(reason: impl Into<String>) -> Self
```

**Purpose**: Constructs a `RealtimeEndInstructions` value from any string-like reason. It normalizes the caller input into the owned `String` stored by the fragment.

**Data flow**: Takes `reason: impl Into<String>` → converts it with `into()` → stores the resulting `String` in the struct and returns a new `RealtimeEndInstructions`.

**Call relations**: It is used when `build_realtime_update_item` needs to emit the closing realtime instruction fragment; after construction, the fragment's trait methods provide role, markers, and body for prompt assembly.

*Call graph*: called by 1 (build_realtime_update_item); 1 external calls (into).


##### `RealtimeEndInstructions::role`  (lines 20–22)

```
fn role(&self) -> &'static str
```

**Purpose**: Reports that this fragment should be treated as developer-authored context. The returned role is fixed and does not depend on instance state.

**Data flow**: Reads no fields → returns the static string literal `"developer"`.

**Call relations**: This method is consumed through the `ContextualUserFragment` interface wherever the context builder serializes fragments into chat-style messages.


##### `RealtimeEndInstructions::markers`  (lines 24–26)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the opening and closing delimiters that surround this fragment in serialized context. It forwards to the type-level marker definition so instance and static marker access stay identical.

**Data flow**: Reads no instance data → calls `Self::type_markers()` → returns the pair of realtime conversation tag literals.

**Call relations**: It participates in fragment serialization via the trait, delegating marker selection to `type_markers` rather than duplicating the constants inline.

*Call graph*: 1 external calls (type_markers).


##### `RealtimeEndInstructions::type_markers`  (lines 28–33)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the protocol tags used to bracket realtime conversation instruction content. These markers identify the fragment as belonging to the realtime conversation region.

**Data flow**: Reads the imported `REALTIME_CONVERSATION_OPEN_TAG` and `REALTIME_CONVERSATION_CLOSE_TAG` constants → returns them as a tuple of `&'static str`.

**Call relations**: It is the shared source of truth for marker selection, reached indirectly from `markers` and potentially from any code that needs the fragment's delimiters without an instance.


##### `RealtimeEndInstructions::body`  (lines 35–37)

```
fn body(&self) -> String
```

**Purpose**: Formats the actual closing instruction text by combining the shared end-instructions template with the instance's reason string. The output includes explicit surrounding newlines for clean embedding inside the tagged block.

**Data flow**: Reads `END_INSTRUCTIONS`, trims it, and reads `self.reason` → interpolates both into a formatted string with a blank line before `Reason:` → returns the assembled `String`.

**Call relations**: This is the payload-producing step used through `ContextualUserFragment` after construction by `build_realtime_update_item`; it does not delegate beyond `format!`.

*Call graph*: 1 external calls (format!).


### Notifications and legacy compatibility
These fragments cover live subagent status signaling and recognizers for older warning messages preserved for stored-session compatibility.

### `core/src/context/subagent_notification.rs`

`data_model` · `request handling`

This file introduces `SubagentNotification`, a compact fragment type used to surface subagent lifecycle or progress information inside the prompt context. The struct stores two concrete pieces of state: `agent_reference: String`, identifying the subagent path or handle, and `status: AgentStatus`, imported from `codex_protocol::protocol`. Through `ContextualUserFragment`, the notification is labeled as `user` content and wrapped in explicit `<subagent_notification>` tags, making it easy for downstream prompt consumers or model instructions to recognize these updates as structured events rather than free-form prose.

The body is serialized as JSON using `serde_json::json!`, with keys `agent_path` and `status`. That choice is important: instead of inventing an ad hoc text format, the fragment emits machine-readable structure while still embedding it in the broader tagged text protocol. The JSON value is then surrounded with leading and trailing newlines via `format!`. Construction accepts any string-like agent reference and stores the status by value, so the fragment is self-contained once built. There is no conditional logic in this file; the main invariant is that every notification uses the same tag pair and JSON schema, which keeps subagent status messages uniform across the system.

#### Function details

##### `SubagentNotification::new`  (lines 12–17)

```
fn new(agent_reference: impl Into<String>, status: AgentStatus) -> Self
```

**Purpose**: Builds a notification fragment from an agent identifier and a concrete `AgentStatus`. It owns the agent reference string and preserves the provided status enum value.

**Data flow**: Takes `agent_reference: impl Into<String>` and `status: AgentStatus` → converts the reference with `into()` → stores both fields in a new `SubagentNotification` and returns it.

**Call relations**: It is called by `format_subagent_notification_message`, which prepares these notifications for insertion into the broader context or message stream.

*Call graph*: called by 1 (format_subagent_notification_message); 1 external calls (into).


##### `SubagentNotification::role`  (lines 21–23)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares that subagent notifications are injected as user-role content. This distinguishes them from developer-side steering fragments.

**Data flow**: Reads no fields → returns the static string `"user"`.

**Call relations**: The context serialization layer invokes this trait method when deciding how to label the fragment in the assembled conversation.


##### `SubagentNotification::markers`  (lines 25–27)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the XML-like delimiters that wrap the notification payload. It forwards to the static marker definition for consistency.

**Data flow**: Reads no instance state → calls `Self::type_markers()` → returns the notification tag pair.

**Call relations**: This method is part of the `ContextualUserFragment` contract and delegates marker selection to `type_markers`.

*Call graph*: 1 external calls (type_markers).


##### `SubagentNotification::type_markers`  (lines 29–31)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the fixed tags used to bracket subagent notification content. These tags identify the enclosed body as a structured subagent event.

**Data flow**: Reads no dynamic state → returns the literals `"<subagent_notification>"` and `"</subagent_notification>"`.

**Call relations**: It is the canonical source for the marker pair used by `markers` and any static consumers of this fragment type.


##### `SubagentNotification::body`  (lines 33–41)

```
fn body(&self) -> String
```

**Purpose**: Serializes the notification fields into a JSON object and wraps that JSON in surrounding newlines. The payload exposes the agent reference under `agent_path` and the status under `status`.

**Data flow**: Reads `self.agent_reference` and `self.status` by reference → constructs a `serde_json::Value` with `json!` → formats it into `"\n{}\n"` → returns the resulting `String`.

**Call relations**: This payload method is used after construction by the formatting path initiated from `format_subagent_notification_message`; it does not branch or call other local helpers.

*Call graph*: 1 external calls (format!).


### `core/src/context/legacy_apply_patch_exec_command_warning.rs`

`domain_logic` · `history parsing and legacy message filtering`

This file contributes a zero-state `ContextualUserFragment` implementation whose only real job is text classification for historical messages. `LegacyApplyPatchExecCommandWarning` carries no fields because the warning content is fixed and no new instances need payload data. Its trait implementation marks the fragment as a `user` role item, but both start and end markers are empty strings, signaling that this fragment is identified purely by its textual content rather than by an explicit wrapper tag.

The matching logic trims surrounding whitespace and then checks for a very specific sentence shape: the text must begin with `Warning: apply_patch was requested via ` and end with `Use the apply_patch tool instead of exec_command.`. That combination lets the parser tolerate variable middle content while still distinguishing this warning from unrelated messages. `body()` returns an empty string because the fragment is retained only as a recognizer/filter definition for old transcripts, not as something actively serialized today. The overall design is intentionally minimal: no constructors, no stored state, and no formatting logic beyond the trait methods needed to participate in the generic contextual-fragment machinery.

#### Function details

##### `LegacyApplyPatchExecCommandWarning::role`  (lines 8–10)

```
fn role(&self) -> &'static str
```

**Purpose**: Declares the legacy warning fragment as a `user`-role fragment for compatibility with the surrounding fragment system.

**Data flow**: Ignores instance state and returns the static string `"user"`.

**Call relations**: This method is consumed by generic fragment handling when legacy messages are interpreted through the `ContextualUserFragment` trait.


##### `LegacyApplyPatchExecCommandWarning::markers`  (lines 12–14)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the marker pair for this fragment type. For this legacy warning, both markers are empty because recognition is content-based.

**Data flow**: Reads no fields and returns the tuple from `Self::type_markers()`.

**Call relations**: It delegates to `type_markers` so instance-level and type-level marker definitions remain aligned for generic fragment code.

*Call graph*: 1 external calls (type_markers).


##### `LegacyApplyPatchExecCommandWarning::type_markers`  (lines 16–18)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that this fragment has no explicit wrapper delimiters. The empty strings indicate plain-text matching only.

**Data flow**: Returns `("", "")` with no allocation or state access.

**Call relations**: Used by `markers` and any type-oriented fragment logic that queries delimiters.


##### `LegacyApplyPatchExecCommandWarning::matches_text`  (lines 20–24)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Recognizes the old warning text about invoking `apply_patch` through `exec_command`. It accepts messages with variable middle wording as long as the fixed prefix and suffix are present.

**Data flow**: Takes `text: &str`, trims whitespace, then checks `starts_with("Warning: apply_patch was requested via ")` and `ends_with("Use the apply_patch tool instead of exec_command.")`. It returns `true` only when both conditions hold.

**Call relations**: This is the core behavior of the file: generic history-scanning code calls it to identify and suppress or classify old warning messages.


##### `LegacyApplyPatchExecCommandWarning::body`  (lines 26–28)

```
fn body(&self) -> String
```

**Purpose**: Produces no serialized payload because this fragment exists only to recognize historical text, not to emit new warnings.

**Data flow**: Reads no state and returns `String::new()`.

**Call relations**: If generic serialization ever touches this fragment, it yields an empty body; the meaningful behavior remains in `matches_text`.

*Call graph*: 1 external calls (new).


### `core/src/context/legacy_model_mismatch_warning.rs`

`domain_logic` · `history parsing and legacy message filtering`

This file adds another zero-data `ContextualUserFragment` implementation used exclusively for backward compatibility when reading historical conversation state. `LegacyModelMismatchWarning` does not store any payload because the system no longer constructs fresh instances with meaningful content; instead, the type serves as a classifier for already-recorded plain-text warnings.

Its trait implementation mirrors the other legacy warning fragments: the role is fixed to `user`, the marker pair is `("", "")`, and `body()` returns an empty string. The important logic is in `matches_text`, which trims the candidate text and checks whether it starts with the warning prefix `Warning: Your account was flagged for potentially high-risk cyber activity`. Unlike marker-based fragments, there is no structural envelope to parse, so the fragment system relies entirely on this prefix test to identify the message. That makes the recognizer tolerant of any trailing explanatory text while still narrowly targeting the historical warning family it was introduced for. The file is intentionally sparse because its purpose is archival compatibility rather than active message generation.

#### Function details

##### `LegacyModelMismatchWarning::role`  (lines 8–10)

```
fn role(&self) -> &'static str
```

**Purpose**: Reports that this legacy warning participates in the fragment system as a `user` message.

**Data flow**: Returns the static string `"user"` and does not inspect or mutate state.

**Call relations**: Generic fragment orchestration reads this role when treating the warning as a contextual fragment.


##### `LegacyModelMismatchWarning::markers`  (lines 12–14)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Provides the marker pair for the fragment, which is empty because the warning is recognized by text content alone.

**Data flow**: Returns the tuple from `Self::type_markers()` without using instance fields.

**Call relations**: It is the instance-facing wrapper around `type_markers` for trait consumers.

*Call graph*: 1 external calls (type_markers).


##### `LegacyModelMismatchWarning::type_markers`  (lines 16–18)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines that this legacy warning has no wrapper tags or delimiters.

**Data flow**: Returns `("", "")`.

**Call relations**: Used by `markers` and any generic code that queries fragment delimiters at the type level.


##### `LegacyModelMismatchWarning::matches_text`  (lines 20–24)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Detects the historical warning by checking for its distinctive opening sentence about high-risk cyber activity. It intentionally ignores any trailing details after that prefix.

**Data flow**: Accepts `text: &str`, trims it, and returns whether the trimmed string starts with `"Warning: Your account was flagged for potentially high-risk cyber activity"`.

**Call relations**: This method is the reason the type exists: history-processing code invokes it to identify old warning messages for filtering or classification.


##### `LegacyModelMismatchWarning::body`  (lines 26–28)

```
fn body(&self) -> String
```

**Purpose**: Returns an empty payload because the fragment is not used to generate new warning text.

**Data flow**: Creates and returns an empty `String` via `String::new()`.

**Call relations**: It satisfies the trait contract, but operationally the fragment's useful behavior is its `matches_text` implementation.

*Call graph*: 1 external calls (new).


### `core/src/context/legacy_unified_exec_process_limit_warning.rs`

`domain_logic` · `history parsing and legacy message filtering`

This file follows the same archival pattern as the other legacy warning fragments: it introduces a fieldless `LegacyUnifiedExecProcessLimitWarning` type solely so generic context parsing can identify and filter a warning that is no longer emitted. There is no constructor and no stored payload because the type is not meant to carry dynamic data in current execution.

As a `ContextualUserFragment`, it reports the `user` role, exposes empty start and end markers, and returns an empty body string. Those choices indicate that the fragment has no explicit serialized wrapper and should not contribute content when rendered. The actual recognition logic trims the candidate text and checks whether it starts with `Warning: The maximum number of unified exec processes you can keep open is`. This prefix-only match allows the historical warning to include a numeric limit or additional explanatory text after the fixed opening phrase. The implementation is deliberately narrow and lightweight: it exists to keep old transcripts parseable without preserving the original warning-generation machinery.

#### Function details

##### `LegacyUnifiedExecProcessLimitWarning::role`  (lines 8–10)

```
fn role(&self) -> &'static str
```

**Purpose**: Marks this legacy warning fragment as belonging to the `user` role.

**Data flow**: Returns `"user"` without reading or changing any state.

**Call relations**: Trait-based fragment consumers use this role when interpreting historical messages.


##### `LegacyUnifiedExecProcessLimitWarning::markers`  (lines 12–14)

```
fn markers(&self) -> (&'static str, &'static str)
```

**Purpose**: Returns the fragment's delimiters, which are empty because this warning is plain text rather than wrapped content.

**Data flow**: Calls `Self::type_markers()` and returns its tuple.

**Call relations**: It forwards to `type_markers` so generic instance-based code sees the same delimiter definition as type-based code.

*Call graph*: 1 external calls (type_markers).


##### `LegacyUnifiedExecProcessLimitWarning::type_markers`  (lines 16–18)

```
fn type_markers() -> (&'static str, &'static str)
```

**Purpose**: Defines the absence of explicit markers for this legacy warning fragment.

**Data flow**: Returns `("", "")`.

**Call relations**: This constant-like definition underlies `markers` and any other delimiter queries.


##### `LegacyUnifiedExecProcessLimitWarning::matches_text`  (lines 20–24)

```
fn matches_text(text: &str) -> bool
```

**Purpose**: Recognizes the historical unified-exec process-limit warning by its fixed opening phrase. It allows the remainder of the warning text to vary.

**Data flow**: Takes `text: &str`, trims whitespace, and returns whether the trimmed text starts with `"Warning: The maximum number of unified exec processes you can keep open is"`.

**Call relations**: History parsing code invokes this method to classify old warning messages that should be filtered or specially handled.


##### `LegacyUnifiedExecProcessLimitWarning::body`  (lines 26–28)

```
fn body(&self) -> String
```

**Purpose**: Produces no body content because the fragment is retained only for recognition of old messages.

**Data flow**: Returns a newly created empty `String`.

**Call relations**: It fulfills the trait interface, but the fragment's operational significance lies in `matches_text`.

*Call graph*: 1 external calls (new).
